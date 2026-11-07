// The launches file for agents (scripts/index-launches.ts): every launch the
// lens pages through, at one safe block, joined with what never changes (read
// once, kept from the last file), its asset and stats.json - written only when
// something changed or the file is six hours old by the chain's clock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionResult, toFunctionSelector, decodeFunctionData } from 'viem';
import {
  indexLaunches, parseLaunches, cleanText, progressBps, hiddenFromConfig, LENS_ABI, LAUNCHES_SCHEMA, REFRESH_AFTER_S, PAGE,
  type LaunchesFile,
} from '../scripts/index-launches.ts';
import { STATS_SCHEMA } from '../scripts/index-history.ts';
import type { Rpc } from '../src/chain/rpc.ts';

const REGISTRY = '0x86e9a01f3959a96469051ae1a73d5c09b0bac110';
const LENS = '0xe6f85a3e97dd2f1a58acba7a68a663e1f66c52c8';
const SITE = 'https://curbfun.xyz';
const WETH = '0x4200000000000000000000000000000000000006';
const NVDAC = '0xb20000000000000000000078ee7ce2fe4908108c';
const HIDDEN_FACTORY = '0x' + 'fa'.repeat(20);
const ZERO = '0x0000000000000000000000000000000000000000';
const w = (x: bigint | string): string => (typeof x === 'bigint' ? x.toString(16) : x.toLowerCase().replace(/^0x/, '')).padStart(64, '0');
const hex = (n: number | bigint): string => '0x' + BigInt(n).toString(16);
const addr = (i: number) => '0x' + i.toString(16).padStart(40, '0');
/** An ABI string return. */
const str = (s: string) => {
  const b = Buffer.from(s, 'utf8');
  return '0x' + w(32n) + w(BigInt(b.length)) + b.toString('hex').padEnd(Math.ceil(b.length / 32) * 64, '0');
};
const SEL = {
  name: toFunctionSelector('name()'), symbol: toFunctionSelector('symbol()'), decimals: toFunctionSelector('decimals()'),
  launchOf: toFunctionSelector('launchOf(address)'), quoteToken: toFunctionSelector('quoteToken()'),
  launchPage: toFunctionSelector('launchPage(uint256,uint256)'),
};

interface L {
  token: string; curve: string; quote: string; status: number; raised: bigint; threshold: bigint;
  launchedAt: number; distributor?: string; name: string; symbol: string; tax: number;
}
const launch = (i: number, over: Partial<L> = {}): L => ({
  token: addr(0x1000 + i), curve: addr(0x2000 + i), quote: WETH, status: 1, raised: 1_386_000_000_000_008n, threshold: 4_470_000_000_000_000_000n,
  launchedAt: 1_792_114_865 + i, name: 'Launch ' + i, symbol: 'L' + i, tax: 100 + i, ...over,
});

/** A chain whose lens pages through `launches` at the safe block `safe`
 *  (stamped `ts`), and that counts every call by kind. */
function chain(o: { launches: L[]; safe?: number; ts?: number; fail?: (to: string, sel: string) => boolean }) {
  const asked: Record<string, number> = {};
  const pages: [number, number][] = [];
  const at: string[] = [];
  const safe = o.safe ?? 54_265_508;
  const rpc: Rpc = {
    label: 'a',
    async request({ method, params = [] }) {
      if (method === 'eth_getBlockByNumber') return { number: hex(safe), timestamp: hex(o.ts ?? 1_794_043_477) };
      if (method !== 'eth_call') throw new Error('unexpected ' + method);
      const [{ to, data }, tag] = params as any[];
      at.push(tag);
      const s = data.slice(0, 10);
      const key = s === SEL.launchPage ? 'launchPage' : Object.entries(SEL).find(([, v]) => v === s)?.[0] ?? s;
      asked[key] = (asked[key] ?? 0) + 1;
      if (o.fail && o.fail(to, s)) throw new Error('execution reverted');
      if (to === LENS && s === SEL.launchPage) {
        const { args } = decodeFunctionData({ abi: LENS_ABI, data });
        const [start, count] = (args as readonly bigint[]).map(Number);
        pages.push([start, count]);
        const slice = o.launches.slice(start, start + Math.min(count, PAGE));
        return encodeFunctionResult({
          abi: LENS_ABI, functionName: 'launchPage',
          result: [slice.map((l) => l.token as `0x${string}`), slice.map((l) => ({
            status: l.status, curve: l.curve as `0x${string}`, quoteToken: l.quote as `0x${string}`, beneficiary: addr(0xbeef) as `0x${string}`,
            quoteReserve: 0n, tokenReserve: 0n, realQuoteReserve: l.raised, graduationThreshold: l.threshold, totalSupply: 10n ** 27n,
            poolKey: { currency0: ZERO as `0x${string}`, currency1: ZERO as `0x${string}`, fee: 500, tickSpacing: 10, hooks: ZERO as `0x${string}` },
            launchedAt: BigInt(l.launchedAt), holderDistributor: (l.distributor ?? ZERO) as `0x${string}`,
          }))],
        });
      }
      const l = o.launches.find((x) => x.token === to || data.endsWith(w(x.token)));
      if (to === REGISTRY && s === SEL.launchOf) {
        return '0x' + [w(l!.curve), w(l!.quote), w(addr(0xbeef)), w(addr(0xbeef)), w(0n), w(500n), w(10n), w(ZERO), w(BigInt(l!.tax)), w(50n), w('0x05'), w(BigInt(l!.launchedAt))].join('');
      }
      if (l && to === l.token && s === SEL.name) return str(l.name);
      if (l && to === l.token && s === SEL.symbol) return str(l.symbol);
      if (to === WETH && s === SEL.symbol) return str('WETH');
      if (to === WETH && s === SEL.decimals) return '0x' + w(18n);
      if (to === NVDAC && s === SEL.symbol) return str('NVDAc');
      if (to === NVDAC && s === SEL.decimals) return '0x' + w(8n);
      if (to === HIDDEN_FACTORY && s === SEL.quoteToken) return '0x' + w(NVDAC);
      throw new Error('unexpected call ' + to + ' ' + s);
    },
  };
  return { rpc, asked, pages, at };
}

/** A data repo in memory: the files, and what was written. */
function store(files: Record<string, unknown> = {}) {
  const bytes: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) bytes[k] = new Uint8Array(Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)));
  const writes: string[] = [];
  return {
    writes,
    file: (p: string): any => JSON.parse(Buffer.from(bytes[p]).toString('utf8')),
    read: async (p: string) => bytes[p] ?? null,
    write: async (p: string, b: Uint8Array) => { writes.push(p); bytes[p] = b; },
  };
}
const PATH = 'sharing/8453/launches.json';
const STATS = 'sharing/8453/stats.json';
const run = (c: ReturnType<typeof chain>, s: ReturnType<typeof store>, over: Partial<{ hiddenLaunches: string[]; hiddenFactories: string[] }> = {}) =>
  indexLaunches({ rpc: c.rpc, chainId: 8453, registry: REGISTRY, lens: LENS, siteBase: SITE, hiddenLaunches: [], hiddenFactories: [], ...over,
    read: s.read, write: s.write, log: () => {} });

const statsFile = (launches: Record<string, any>, totals: Record<string, any> = {}) => ({
  schema: STATS_SCHEMA, chainId: 8453, generatedAt: { block: 1, timestamp: 1 }, launches, totals,
});
const statsEntry = (curve: string, over: Record<string, unknown> = {}) => ({
  curve, quote: WETH, quoteDecimals: 18, status: 'selling', firstTradeBlock: 52_700_000, lastTradeBlock: 52_700_226,
  curveBuys: 2, curveSells: 1, buyers: 1, traders: 1, curveVolume: '4071574999999992', poolVolume: '0', poolSwaps: 0, holders: 2, ...over,
});

test('L1: launches.json from the lens pages: status, quote, progress in raw units and bps, launchedAt, tax, holder sharing and stats.json\'s counts', async () => {
  const a = launch(1);
  const b = launch(2, { quote: NVDAC, status: 3, raised: 0n, threshold: 5_000_000_000n, distributor: addr(0xd15), name: 'Stock Cat', symbol: 'SCAT', tax: 250 });
  const c = chain({ launches: [a, b] });
  const totals = { [WETH]: { decimals: 18, launches: 1, graduated: 0, curveBuys: 2, curveSells: 1, curveVolume: '4071574999999992', poolSwaps: 0, poolVolume: '0' } };
  const s = store({ [STATS]: statsFile({
    [a.token]: statsEntry(a.curve),
    [b.token]: statsEntry(b.curve, { quote: NVDAC, quoteDecimals: 8, status: 'graduated', holderSharing: { distributor: addr(0xd15), paidQuote: '123', paidToken: '456' } }),
  }, totals) });
  const r = await run(c, s);
  assert.deepEqual(r, { launches: 2, written: true, failed: 0 });
  const f: LaunchesFile = s.file(PATH);
  assert.equal(f.schema, LAUNCHES_SCHEMA);
  assert.equal(f.chainId, 8453);
  assert.deepEqual(f.asOf, { block: 54_265_508, timestamp: 1_794_043_477 });
  assert.equal(f.lens, LENS);
  assert.equal(f.count, 2);
  assert.deepEqual(f.launches[0], {
    token: a.token, curve: a.curve, name: 'Launch 1', symbol: 'L1', textCleaned: false, page: SITE + '/token/' + a.token, hidden: false,
    status: 'selling', launchedAt: a.launchedAt, taxBps: 101, quote: { token: WETH, symbol: 'WETH', decimals: 18 },
    progress: { raised: '1386000000000008', threshold: '4470000000000000000', bps: 3 },
    holderSharing: null,
    activity: { curveBuys: 2, curveSells: 1, traders: 1, holders: 2, poolSwaps: 0, curveVolume: '4071574999999992', poolVolume: '0', lastTradeBlock: 52_700_226 },
  });
  assert.equal(f.launches[1].status, 'graduated');
  assert.deepEqual(f.launches[1].quote, { token: NVDAC, symbol: 'NVDAc', decimals: 8 });
  assert.deepEqual(f.launches[1].progress, { raised: '0', threshold: '5000000000', bps: 10_000 });
  assert.equal(f.launches[1].taxBps, 250);
  assert.deepEqual(f.launches[1].holderSharing, { distributor: addr(0xd15), paidQuote: '123', paidToken: '456' });
  assert.deepEqual(f.platform, { launches: 2, graduated: 1, sharing: 1, byQuote: totals });
  // EVERY READ AT THE ONE SAFE BLOCK.
  assert.ok(c.at.every((t) => t === hex(54_265_508)), 'a read not at the safe block');
  // NOTHING OF THE CREATOR WALLET.
  assert.ok(!JSON.stringify(f).includes(w(addr(0xbeef)).slice(24)), 'the beneficiary is in the file');
  // A DISTRIBUTOR stats.json HAS NOT COUNTED YET: null amounts.
  const s2 = store({ [STATS]: statsFile({}) });
  await run(chain({ launches: [b] }), s2);
  assert.deepEqual(s2.file(PATH).launches[0].holderSharing, { distributor: addr(0xd15), paidQuote: null, paidToken: null });
  assert.equal(s2.file(PATH).launches[0].activity, null);
});

test('L2: name, symbol, tax and the asset\'s symbol and decimals are read once and kept while the curve is the same; a new curve reads them again', async () => {
  const a = launch(1);
  const s = store();
  const c1 = chain({ launches: [a] });
  await run(c1, s);
  assert.equal(c1.asked.name, 1);
  assert.equal(c1.asked.symbol, 2); // the token's and the asset's
  assert.equal(c1.asked.launchOf, 1);
  assert.equal(c1.asked.decimals, 1);
  // THE CHAIN NOW SAYS SOMETHING ELSE FOR THEM: the file keeps what it read.
  const c2 = chain({ launches: [{ ...a, name: 'Changed', symbol: 'CHG', tax: 499 }], ts: 1_794_043_477 + REFRESH_AFTER_S });
  await run(c2, s);
  assert.equal(c2.asked.name ?? 0, 0);
  assert.equal(c2.asked.symbol ?? 0, 0);
  assert.equal(c2.asked.launchOf ?? 0, 0);
  assert.equal(c2.asked.decimals ?? 0, 0);
  assert.equal(s.file(PATH).launches[0].name, 'Launch 1');
  assert.equal(s.file(PATH).launches[0].taxBps, 101);
  // ANOTHER CURVE FOR THE SAME TOKEN: read again.
  const c3 = chain({ launches: [{ ...a, curve: addr(0x3001), name: 'Changed', symbol: 'CHG', tax: 499 }] });
  await run(c3, s);
  assert.equal(c3.asked.name, 1);
  assert.equal(s.file(PATH).launches[0].name, 'Changed');
  assert.equal(s.file(PATH).launches[0].taxBps, 499);
});

test('L3: control, bidi and zero-width characters are taken out of names and symbols, which are cut at 64 and 16 code points, and the file says so', async () => {
  assert.deepEqual(cleanText('Moon Cat', 64), { text: 'Moon Cat', cleaned: false });
  assert.deepEqual(cleanText('Güzel 🐱 Kedi', 64), { text: 'Güzel 🐱 Kedi', cleaned: false });
  for (const bad of ['\u0000', '\u0007', '\n', '\u001b', '\u007f', '\u0085', '\u009f', '\u{200b}', '\u{200e}', '\u{200f}', '\u{202a}', '\u{202e}', '\u{2066}', '\u{2069}', '\u{2028}', '\u{feff}']) {
    assert.deepEqual(cleanText('Moon' + bad + 'Cat', 64), { text: 'MoonCat', cleaned: true }, JSON.stringify(bad));
  }
  assert.deepEqual(cleanText('🐱'.repeat(20), 16), { text: '🐱'.repeat(16), cleaned: true });
  const a = launch(1, { name: 'Evil\u{202e}gnp.exe ' + 'x'.repeat(80), symbol: 'SYM\u{200b}BOL' });
  const s = store();
  await run(chain({ launches: [a] }), s);
  const e = s.file(PATH).launches[0];
  assert.equal(e.textCleaned, true);
  assert.equal([...e.name].length, 64);
  assert.ok(!/[\u{202e}]/u.test(e.name));
  assert.equal(e.symbol, 'SYMBOL');
});

test('L4: written only on a change, or when asOf is six hours old by the safe block\'s timestamp - not by a count of blocks', async () => {
  const a = launch(1);
  const s = store();
  const T = 1_794_043_477;
  await run(chain({ launches: [a], safe: 100, ts: T }), s);
  assert.equal(s.writes.length, 1);
  // A MILLION BLOCKS LATER (55 hours at 0.2 s, a few minutes by this clock): nothing new, nothing written.
  let r = await run(chain({ launches: [a], safe: 1_000_100, ts: T + 600 }), s);
  assert.equal(r.written, false);
  assert.equal(s.writes.length, 1);
  // JUST UNDER SIX HOURS: not yet.
  r = await run(chain({ launches: [a], safe: 1_000_200, ts: T + REFRESH_AFTER_S - 1 }), s);
  assert.equal(r.written, false);
  // SIX HOURS BY THE CHAIN'S CLOCK, a block later: written, with the new asOf.
  r = await run(chain({ launches: [a], safe: 1_000_201, ts: T + REFRESH_AFTER_S }), s);
  assert.equal(r.written, true);
  assert.deepEqual(s.file(PATH).asOf, { block: 1_000_201, timestamp: T + REFRESH_AFTER_S });
  // A TRADE (more raised): written at once.
  r = await run(chain({ launches: [{ ...a, raised: a.raised + 1n }], safe: 1_000_202, ts: T + REFRESH_AFTER_S + 1 }), s);
  assert.equal(r.written, true);
  assert.equal(s.writes.length, 3);
});

test('L5: the lens is paged 50 at a time and the run stops at a short page', async () => {
  const many = Array.from({ length: 120 }, (_, i) => launch(i));
  const c = chain({ launches: many });
  const s = store();
  const r = await run(c, s);
  assert.deepEqual(c.pages, [[0, 50], [50, 50], [100, 50]]);
  assert.equal(r.launches, 120);
  assert.deepEqual(s.file(PATH).launches.map((e: any) => e.token), many.map((l) => l.token));
  // EXACTLY 100: one more page, empty, ends it.
  const c2 = chain({ launches: many.slice(0, 100) });
  await run(c2, store());
  assert.deepEqual(c2.pages, [[0, 50], [50, 50], [100, 50]]);
});

test('L6: progress is capped at 10000 bps, a graduated launch reads 10000, and a zero threshold reads null', () => {
  assert.equal(progressBps(1, 0n, 100n), 0);
  assert.equal(progressBps(1, 1n, 3n), 3333);
  assert.equal(progressBps(1, 99n, 100n), 9900);
  assert.equal(progressBps(2, 150n, 100n), 10_000);
  assert.equal(progressBps(1, 10n ** 30n, 1n), 10_000);
  assert.equal(progressBps(3, 0n, 100n), 10_000);
  assert.equal(progressBps(3, 0n, 0n), 10_000);
  assert.equal(progressBps(1, 5n, 0n), null);
});

test('L7: hidden marks a launch config.js hides, and every launch on a hidden factory\'s asset', async () => {
  const a = launch(1), b = launch(2, { quote: NVDAC }), c = launch(3);
  const s = store();
  const r = await run(chain({ launches: [a, b, c] }), s, { hiddenLaunches: [c.token.toUpperCase().replace('0X', '0x')], hiddenFactories: [HIDDEN_FACTORY] });
  assert.equal(r.failed, 0);
  assert.deepEqual(s.file(PATH).launches.map((e: any) => e.hidden), [false, true, true]);
  // AND THE LISTS AS web/config.js WRITES THEM.
  assert.deepEqual(hiddenFromConfig('window.CURB_SITE = { hiddenFactories: ["0xFAFA' + 'fa'.repeat(18) + '", "nonsense"], hiddenLaunches: [] };'),
    { hiddenFactories: [HIDDEN_FACTORY], hiddenLaunches: [] });
});

test('L8: a failed read keeps the last entry, adds nothing new and counts as failed; a stats.json that cannot be read gives null activity, not no file', async () => {
  const a = launch(1), b = launch(2);
  const s = store({ [STATS]: statsFile({ [a.token]: statsEntry(a.curve) }) });
  await run(chain({ launches: [a] }), s);
  const before = s.file(PATH).launches[0];
  // A NEW CURVE FOR a (so its fixed fields are read again) and a new launch b: both reads fail.
  const c = chain({ launches: [{ ...a, curve: addr(0x3001), raised: 5n }, b], fail: (to, sel) => sel === SEL.name });
  const r = await run(c, s);
  assert.equal(r.failed, 2);
  const f = s.file(PATH);
  assert.deepEqual(f.launches, [before], 'a kept as it was, b left out');
  // stats.json UNREADABLE: the file is still written, with null activity.
  const broken = store();
  const r2 = await indexLaunches({ rpc: chain({ launches: [a] }).rpc, chainId: 8453, registry: REGISTRY, lens: LENS, siteBase: SITE, hiddenLaunches: [], hiddenFactories: [],
    read: async (p) => { if (p === STATS) throw new Error('GitHub is down'); return null; }, write: broken.write, log: () => {} });
  assert.equal(r2.written, true);
  assert.equal(r2.failed, 1);
  assert.equal(broken.file(PATH).launches[0].activity, null);
  // A PAGE THAT CANNOT BE READ FAILS THE RUN, and nothing is written.
  const pageFails = store();
  await assert.rejects(run(chain({ launches: [a], fail: (to, sel) => sel === SEL.launchPage }), pageFails));
  assert.deepEqual(pageFails.writes, []);
});

test('L9: parseLaunches refuses another schema or another chain, and keeps nothing from it', async () => {
  const a = launch(1);
  const s = store();
  await run(chain({ launches: [a] }), s);
  const good = s.file(PATH);
  const b = (x: unknown) => new Uint8Array(Buffer.from(JSON.stringify(x)));
  assert.ok(parseLaunches(b(good), 8453));
  assert.equal(parseLaunches(b({ ...good, schema: 'curb.launches/2' }), 8453), null);
  assert.equal(parseLaunches(b(good), 1), null);
  assert.equal(parseLaunches(b({ ...good, launches: [{ ...good.launches[0], token: 'nope' }] }), 8453), null);
  assert.equal(parseLaunches(new Uint8Array(Buffer.from('not json')), 8453), null);
  assert.equal(parseLaunches(null, 8453), null);
  // A FILE OF ANOTHER SCHEMA LEFT IN PLACE: its names are not reused, they are read again.
  const other = store({ [PATH]: { ...good, schema: 'curb.launches/0', launches: [{ ...good.launches[0], name: 'Planted' }] } });
  const c = chain({ launches: [a] });
  await run(c, other);
  assert.equal(c.asked.name, 1);
  assert.equal(other.file(PATH).launches[0].name, 'Launch 1');
});
