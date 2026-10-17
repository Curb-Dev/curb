// The history index the site reads before the chain (scripts/index-history.ts):
// the same logs the endpoint returns, kept once each and in order, read from
// a launch's start and then only after the last block written, and a file
// that is not this launch's is read again from the start rather than trusted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexAll, merge, parseFile, parseChecked, parseStats, slim, SCHEMA, CHECKED_SCHEMA, STATS_SCHEMA, TOPIC, CURB_ROUTER, POOL_MANAGER, REWRITE_AFTER, type HistoryFile, type IndexLog } from '../scripts/index-history.ts';
import type { Rpc } from '../src/chain/rpc.ts';

const REGISTRY = '0x86e9a01f3959a96469051ae1a73d5c09b0bac110';
const LENS = '0xe6f85a3e97dd2f1a58acba7a68a663e1f66c52c8';
const TOKEN = '0xf8bdcd06f7a5939c8b2340e27419facdf16a407e';
const CURVE = '0x65cff633da0f81924242467d0c1404c6e0fea7e4';
const w = (x: bigint | string): string => (typeof x === 'bigint' ? x.toString(16) : x.toLowerCase().replace(/^0x/, '')).padStart(64, '0');
const hex = (n: number | bigint): string => '0x' + BigInt(n).toString(16);

function log(address: string, topic0: string, block: number, index: number, extra: string[] = []): IndexLog {
  return { address, topics: [topic0, ...extra], data: '0x' + w(1n), blockNumber: hex(block), logIndex: hex(index), transactionHash: '0x' + w(BigInt(block * 1000 + index)) };
}

/** The quote asset every launch here is paired with: 6 decimals. */
const QUOTE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const DECIMALS = '0x313ce567';
/** The lens's launchState: status, curve, quote asset; words 9-13 the pool key. */
const state = (status: number, curve = CURVE, pool: string[] = Array(5).fill(w(0n))): string =>
  '0x' + [w(BigInt(status)), w(curve), w(QUOTE), ...Array(6).fill(w(0n)), ...pool, w(0n), w(0n)].join('');

/** A chain with one launch (or the ones given): launchedAt at block 1,000
 *  (2 s blocks from t=0), the safe head where the test puts it, and the logs
 *  it is given. */
function chain(o: { safe: number; logs: IndexLog[]; launches?: { token: string; curve: string; state?: string }[] }) {
  const launches = o.launches ?? [{ token: TOKEN, curve: CURVE }];
  const calls: { method: string; params: any[] }[] = [];
  const rpc: Rpc = {
    label: 'a',
    async request({ method, params = [] }) {
      calls.push({ method, params: params as any[] });
      if (method === 'eth_getBlockByNumber') return { number: hex(o.safe), timestamp: hex(o.safe * 2) };
      if (method === 'eth_call') {
        const { to, data } = (params as any[])[0];
        if (to === REGISTRY && data.startsWith('0x27cca59f')) return '0x' + w(BigInt(launches.length)); // launchCount
        if (to === REGISTRY && data.startsWith('0x7f5780c4')) return '0x' + w(launches[Number(BigInt('0x' + data.slice(10)))].token); // launchAt(i)
        const of = launches.find((l) => data.endsWith(w(l.token)));
        if (to === REGISTRY) return '0x' + [w(of!.curve), w('0x01'), w('0x02'), w('0x03'), w(0n), w(0n), w(0n), w('0x04'), w(100n), w(50n), w('0x05'), w(2000n)].join(''); // launchOf: launchedAt t=2000 -> block 1000
        if (to === LENS) return of!.state ?? state(1, of!.curve); // Selling
        if (to === QUOTE && data === DECIMALS) return '0x' + w(6n);
        throw new Error('unexpected call ' + to + ' ' + data.slice(0, 10));
      }
      if (method === 'eth_getLogs') {
        const f = (params as any[])[0];
        const from = Number(BigInt(f.fromBlock)), to = Number(BigInt(f.toBlock));
        const t0 = Array.isArray(f.topics[0]) ? f.topics[0] : [f.topics[0]];
        return o.logs.filter((l) => l.address === f.address && t0.includes(l.topics[0]) && Number(BigInt(l.blockNumber)) >= from && Number(BigInt(l.blockNumber)) <= to &&
          (f.topics[2] == null || l.topics[2] === f.topics[2]));
      }
      throw new Error('unexpected method ' + method);
    },
  };
  return { rpc, calls };
}

function store() {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    read: async (p: string) => files.get(p) ?? null,
    write: async (p: string, b: Uint8Array) => void files.set(p, b),
    file: (p: string) => JSON.parse(Buffer.from(files.get(p)!).toString('utf8')) as HistoryFile,
  };
}
const PATH = `sharing/8453/history/${TOKEN}.json`;

test('merge keeps each log once, in block and log order', () => {
  const a = [log(CURVE, TOPIC.curveBuy, 5, 1), log(CURVE, TOPIC.curveBuy, 3, 0)];
  const b = [log(CURVE, TOPIC.curveSell, 5, 1), log(CURVE, TOPIC.curveSell, 4, 2), log(CURVE, TOPIC.curveBuy, 5, 0)];
  const m = merge(a, b);
  assert.deepEqual(m.map((l) => [Number(BigInt(l.blockNumber)), Number(BigInt(l.logIndex))]), [[3, 0], [4, 2], [5, 0], [5, 1]]);
  assert.equal(m.find((l) => l.blockNumber === hex(5) && l.logIndex === hex(1))!.topics[0], TOPIC.curveBuy, 'the first seen is kept');
});

test('slim keeps exactly the fields the site reads, lower-cased', () => {
  const s = slim({ address: CURVE.toUpperCase().replace('0X', '0x'), topics: [TOPIC.curveBuy.toUpperCase().replace('0X', '0x')], data: '0x01', blockNumber: '0x5', logIndex: '0x0', transactionHash: '0x' + 'AB'.repeat(32), removed: false } as any);
  assert.deepEqual(Object.keys(s).sort(), ['address', 'blockNumber', 'data', 'logIndex', 'topics', 'transactionHash']);
  assert.equal(s.address, CURVE);
  assert.equal(s.topics[0], TOPIC.curveBuy);
});

test("a file that is not this launch's, or not this schema, is not read back", () => {
  const good: HistoryFile = { schema: SCHEMA, chainId: 8453, token: TOKEN, curve: CURVE, from: 1, to: 9, curveLogs: [], transfers: [], routerSold: [], swaps: [], fees: [] };
  const b = (o: object) => new Uint8Array(Buffer.from(JSON.stringify({ ...good, ...o })));
  assert.ok(parseFile(b({}), 8453, TOKEN, CURVE));
  assert.equal(parseFile(b({ schema: 'curb.history/0' }), 8453, TOKEN, CURVE), null);
  assert.equal(parseFile(b({}), 1, TOKEN, CURVE), null, 'another chain');
  assert.equal(parseFile(b({ token: CURVE }), 8453, TOKEN, CURVE), null, 'another token');
  assert.equal(parseFile(b({ curve: TOKEN }), 8453, TOKEN, CURVE), null, 'another curve');
  assert.equal(parseFile(b({ transfers: null }), 8453, TOKEN, CURVE), null, 'a list missing');
  assert.equal(parseFile(new Uint8Array(Buffer.from('{not json')), 8453, TOKEN, CURVE), null);
  assert.equal(parseFile(null, 8453, TOKEN, CURVE), null);
});

test('the first run reads from before the launch to the safe block; the next only after it, and writes the logs once each', async () => {
  const s = store();
  const logs = [
    log(CURVE, TOPIC.curveBuy, 1001, 0), log(TOKEN, TOPIC.transfer, 1001, 1),
    log(CURVE, TOPIC.curveSell, 1500, 0), log(CURB_ROUTER, TOPIC.routerSold, 1500, 2, ['0x' + w('0x09'), '0x' + w(TOKEN)]),
    log(CURB_ROUTER, TOPIC.routerSold, 1500, 3, ['0x' + w('0x09'), '0x' + w('0x0b')]), // another token's sale
  ];
  const c = chain({ safe: 2000, logs });
  const r1 = await indexAll({ rpc: c.rpc, chainId: 8453, registry: REGISTRY, lens: LENS, read: s.read, write: s.write, log: () => {} });
  assert.deepEqual(r1, { launches: 1, written: 1, failed: 0 });
  const f1 = s.file(PATH);
  assert.equal(f1.to, 2000);
  assert.ok(f1.from <= 1000, 'from no later than the launch');
  assert.equal(f1.curveLogs.length, 2);
  assert.equal(f1.transfers.length, 1);
  assert.equal(f1.routerSold.length, 1, "only this token's router sales");
  const asked = c.calls.filter((x) => x.method === 'eth_getLogs').map((x) => Number(BigInt(x.params[0].fromBlock)));
  assert.equal(Math.min(...asked), f1.from, "the reads start at the file's from");

  // NEW BLOCKS, ONE NEW TRADE: read from the block after the file, appended.
  logs.push(log(CURVE, TOPIC.curveBuy, 2100, 0));
  const c2 = chain({ safe: 2200, logs });
  const r2 = await indexAll({ rpc: c2.rpc, chainId: 8453, registry: REGISTRY, lens: LENS, read: s.read, write: s.write, log: () => {} });
  assert.equal(r2.written, 1);
  const f2 = s.file(PATH);
  assert.equal(f2.to, 2200);
  assert.equal(f2.from, f1.from, 'the start is kept');
  assert.equal(f2.curveLogs.length, 3);
  const asked2 = c2.calls.filter((x) => x.method === 'eth_getLogs').map((x) => Number(BigInt(x.params[0].fromBlock)));
  assert.equal(Math.min(...asked2), 2001, 'the second run reads only after the first');

  // NOTHING NEW, NOT FAR BEHIND: nothing is written.
  const c3 = chain({ safe: 2300, logs });
  const r3 = await indexAll({ rpc: c3.rpc, chainId: 8453, registry: REGISTRY, lens: LENS, read: s.read, write: s.write, log: () => {} });
  assert.equal(r3.written, 0);
  assert.equal(s.file(PATH).to, 2200);

  // NOTHING NEW, BUT REWRITE_AFTER BEHIND: rewritten so a page reads little.
  const far = 2200 + Number(REWRITE_AFTER);
  const r4 = await indexAll({ rpc: chain({ safe: far, logs }).rpc, chainId: 8453, registry: REGISTRY, lens: LENS, read: s.read, write: s.write, log: () => {} });
  assert.equal(r4.written, 1);
  assert.equal(s.file(PATH).to, far);
  assert.equal(s.file(PATH).curveLogs.length, 3);
});

test("a file of another launch at the path is read again from the launch's start", async () => {
  const s = store();
  s.files.set(PATH, new Uint8Array(Buffer.from(JSON.stringify({ schema: SCHEMA, chainId: 8453, token: TOKEN, curve: '0x' + 'ee'.repeat(20), from: 1, to: 1900, curveLogs: [], transfers: [], routerSold: [], swaps: [], fees: [] }))));
  const c = chain({ safe: 2000, logs: [log(CURVE, TOPIC.curveBuy, 1001, 0)] });
  await indexAll({ rpc: c.rpc, chainId: 8453, registry: REGISTRY, lens: LENS, read: s.read, write: s.write, log: () => {} });
  const f = s.file(PATH);
  assert.equal(f.curve, CURVE);
  assert.equal(f.curveLogs.length, 1, 'the trade at 1001, below the other file\'s to, is there');
});

const CHECKED = 'sharing/8453/history/checked.json';
const checkedOf = (s: ReturnType<typeof store>) => JSON.parse(Buffer.from(s.files.get(CHECKED)!).toString('utf8'));
const run = (s: ReturnType<typeof store>, safe: number, logs: IndexLog[], rpc?: Rpc) =>
  indexAll({ rpc: rpc ?? chain({ safe, logs }).rpc, chainId: 8453, registry: REGISTRY, lens: LENS, read: s.read, write: s.write, log: () => {} });

test("checked.json says how far each file is complete: a quiet run moves it on though the file is not rewritten", async () => {
  const s = store();
  const logs = [log(CURVE, TOPIC.curveBuy, 1001, 0)];
  await run(s, 2000, logs);
  assert.deepEqual(checkedOf(s), { schema: CHECKED_SCHEMA, chainId: 8453, launches: { [TOKEN]: { curve: CURVE, file: 2000, to: 2000 } } });
  // NOTHING NEW: the file stays at 2000, and it is known complete to 2300.
  const r = await run(s, 2300, logs);
  assert.equal(r.written, 0);
  assert.equal(s.file(PATH).to, 2000);
  assert.deepEqual(checkedOf(s).launches[TOKEN], { curve: CURVE, file: 2000, to: 2300 }, 'for the file at 2000, complete to 2300');
  // A NEW TRADE: the file is rewritten to the run's block, and so is its entry.
  logs.push(log(CURVE, TOPIC.curveSell, 2400, 0));
  await run(s, 2500, logs);
  assert.equal(s.file(PATH).to, 2500);
  assert.deepEqual(checkedOf(s).launches[TOKEN], { curve: CURVE, file: 2500, to: 2500 });
});

test('checked.json is not written again when it would say the same, and parseChecked keeps only well-formed entries', async () => {
  const s = store();
  const writes: string[] = [];
  const counted = { ...s, write: async (p: string, b: Uint8Array) => { writes.push(p); await s.write(p, b); } };
  const logs = [log(CURVE, TOPIC.curveBuy, 1001, 0)];
  await indexAll({ rpc: chain({ safe: 2000, logs }).rpc, chainId: 8453, registry: REGISTRY, lens: LENS, read: counted.read, write: counted.write, log: () => {} });
  writes.length = 0;
  await indexAll({ rpc: chain({ safe: 2000, logs }).rpc, chainId: 8453, registry: REGISTRY, lens: LENS, read: counted.read, write: counted.write, log: () => {} });
  assert.deepEqual(writes, [], 'the same block again writes nothing');
  const bytes = (j: unknown) => new Uint8Array(Buffer.from(JSON.stringify(j)));
  assert.deepEqual(parseChecked(bytes({ schema: 'other', chainId: 8453, launches: { [TOKEN]: { curve: CURVE, file: 5, to: 5 } } }), 8453), {});
  assert.deepEqual(parseChecked(bytes({ schema: CHECKED_SCHEMA, chainId: 1, launches: { [TOKEN]: { curve: CURVE, file: 5, to: 5 } } }), 8453), {});
  assert.deepEqual(parseChecked(bytes({ schema: CHECKED_SCHEMA, chainId: 8453, launches: {
    [TOKEN]: { curve: CURVE, file: 4, to: 5 }, ['0x' + 'AB'.repeat(20)]: { curve: CURVE, file: 5, to: 5 }, ['0x' + 'cd'.repeat(20)]: { curve: CURVE, file: 5, to: 1.5 },
    ['0x' + 'ef'.repeat(20)]: { curve: CURVE, to: 5 }, ['0x' + '12'.repeat(20)]: { curve: CURVE, file: 6, to: 5 },
  } }), 8453), { [TOKEN]: { curve: CURVE, file: 4, to: 5 } }, 'no file, or a file past its to, is not an entry');
  assert.deepEqual(parseChecked(new Uint8Array(Buffer.from('not json')), 8453), {});
});

test("a launch the run cannot read keeps the entry it had, and an entry naming another curve is dropped", async () => {
  const s = store();
  const logs = [log(CURVE, TOPIC.curveBuy, 1001, 0)];
  await run(s, 2000, logs);
  // THE LAUNCH CANNOT BE READ THIS RUN (its lens refuses): it fails, and its entry stands.
  const broken = chain({ safe: 2600, logs });
  const failing: Rpc = { label: 'a', request: (a) => (a.method === 'eth_call' && (a.params as any[])[0].to === LENS ? Promise.reject(new Error('down')) : broken.rpc.request(a)) };
  const r = await run(s, 2600, logs, failing);
  assert.equal(r.failed, 1);
  assert.deepEqual(checkedOf(s).launches[TOKEN], { curve: CURVE, file: 2000, to: 2000 });
  // AN ENTRY FOR ANOTHER CURVE AT THIS TOKEN says nothing of this file: gone, and replaced once read.
  s.files.set(CHECKED, new Uint8Array(Buffer.from(JSON.stringify({ schema: CHECKED_SCHEMA, chainId: 8453, launches: { [TOKEN]: { curve: '0x' + 'ee'.repeat(20), file: 9999, to: 9999 } } }))));
  await run(s, 2600, logs, failing);
  assert.equal(checkedOf(s).launches[TOKEN], undefined);
  await run(s, 2700, logs);
  assert.deepEqual(checkedOf(s).launches[TOKEN], { curve: CURVE, file: 2000, to: 2700 }, 'the file at 2000, unchanged, complete to 2700');
});

// ---------------------------------------------------------------- stats.json
const STATS = 'sharing/8453/stats.json';
const statsOf = (s: ReturnType<typeof store>) => JSON.parse(Buffer.from(s.files.get(STATS)!).toString('utf8'));
const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20), C = '0x' + 'c3'.repeat(20);
const ZERO = '0x' + '00'.repeat(20), DEAD = '0x' + '00'.repeat(18) + 'dead';
const TOKEN2 = '0x' + '77'.repeat(20), CURVE2 = '0x' + '88'.repeat(20), HOOK = '0x' + '44'.repeat(20);
const at = (a: string): string => '0x' + w(a);
/** A signed amount as the word that carries it. */
const signed = (n: bigint): bigint => BigInt.asUintN(256, n);
function ev(address: string, topics: string[], data: (bigint | string)[], block: number, index: number, tx = block * 1000 + index): IndexLog {
  return { address, topics, data: '0x' + data.map((x) => w(x)).join(''), blockNumber: hex(block), logIndex: hex(index), transactionHash: '0x' + w(BigInt(tx)) };
}
const buy = (curve: string, who: string, block: number, index: number, q: bigint[]) => ev(curve, [TOPIC.curveBuy, at(who), at(who)], q, block, index);
const xfer = (token: string, from: string, to: string, amount: bigint, block: number, index: number, tx?: number) => ev(token, [TOPIC.transfer, at(from), at(to)], [amount], block, index, tx);
/** Writes as they come, beside the store's. */
function counting(s: ReturnType<typeof store>) {
  const writes: string[] = [];
  return { writes, read: s.read, write: async (p: string, b: Uint8Array) => { writes.push(p); await s.write(p, b); } };
}
const launches2 = (token1State?: string, token2State?: string) =>
  [{ token: TOKEN, curve: CURVE, state: token1State }, { token: TOKEN2, curve: CURVE2, state: token2State }];

test("stats.json counts each launch's trades, traders, volumes and holders from the files the run holds, and adds them up per quote asset", async () => {
  const s = store();
  const c = counting(s);
  const SALE = 1_500_999; // the router sale's transaction: the curve's CurveSell and the router's SoldForEth
  const logs = [
    xfer(TOKEN, ZERO, CURVE, 1_000_000n, 1000, 0),
    buy(CURVE, A, 1001, 0, [1000n, 500n, 10n, 5n]), xfer(TOKEN, CURVE, A, 500n, 1001, 1),
    buy(CURVE, B, 1100, 0, [2000n, 900n, 20n, 10n]), xfer(TOKEN, CURVE, B, 900n, 1100, 1),
    buy(CURVE, A, 1200, 0, [500n, 400n, 5n, 2n]), xfer(TOKEN, CURVE, A, 400n, 1200, 1),
    xfer(TOKEN, A, C, 60n, 1300, 0),
    // A SALE THROUGH THE CURB ROUTER: the curve pays the router; the router names A.
    xfer(TOKEN, A, CURB_ROUTER, 100n, 1500, 0, SALE), xfer(TOKEN, CURB_ROUTER, CURVE, 100n, 1500, 1, SALE),
    ev(CURVE, [TOPIC.curveSell, at(CURB_ROUTER), at(CURB_ROUTER)], [100n, 300n, 3n, 2n], 1500, 2, SALE),
    ev(CURB_ROUTER, [TOPIC.routerSold, at(A), at(TOKEN), at(A)], [REGISTRY, 100n, 300n, 299n, 0n], 1500, 3, SALE),
    ev(CURVE, [TOPIC.curveSell, at(C), at(C)], [50n, 150n, 2n, 1n], 1600, 0), xfer(TOKEN, C, CURVE, 50n, 1600, 1),
    // BURNED IS NOT HELD: to 0x...dEaD and to the zero address.
    xfer(TOKEN, B, DEAD, 100n, 1700, 0), xfer(TOKEN, B, ZERO, 100n, 1800, 0),
    // THE SECOND LAUNCH, on the same quote asset.
    xfer(TOKEN2, ZERO, CURVE2, 1000n, 1000, 5),
    buy(CURVE2, B, 1050, 0, [400n, 100n, 4n, 2n]), xfer(TOKEN2, CURVE2, B, 100n, 1050, 1),
  ];
  const c1 = chain({ safe: 2000, logs, launches: launches2() });
  const r1 = await indexAll({ rpc: c1.rpc, chainId: 8453, registry: REGISTRY, lens: LENS, read: c.read, write: c.write, log: () => {} });
  assert.deepEqual(r1, { launches: 2, written: 2, failed: 0 });
  assert.equal(c.writes.at(-1), STATS, 'after the files it counts');
  assert.equal(c.writes.filter((p) => p === STATS).length, 1, 'once a run');
  assert.equal(c1.calls.filter((x) => x.method === 'eth_call' && x.params[0].to === QUOTE).length, 1, "the quote asset's decimals, read once for both launches");
  const one = {
    curve: CURVE, quote: QUOTE, quoteDecimals: 6, status: 'selling', firstTradeBlock: 1001, lastTradeBlock: 1600,
    curveBuys: 3, curveSells: 2,
    buyers: 2, // A and B
    traders: 3, // A, B, and C; the router's sale is A's
    curveVolume: String(1000 + 2000 + 500 + (300 + 3 + 2) + (150 + 2 + 1)), // buys' quoteIn, sells' quoteOut + fee + tax
    poolSwaps: 0, poolVolume: '0',
    holders: 4, // the curve, A (740), B (700), C (10); not the router (0), 0x...dEaD or the zero address
  };
  const two = {
    curve: CURVE2, quote: QUOTE, quoteDecimals: 6, status: 'selling', firstTradeBlock: 1050, lastTradeBlock: 1050,
    curveBuys: 1, curveSells: 0, buyers: 1, traders: 1, curveVolume: '400', poolSwaps: 0, poolVolume: '0', holders: 2,
  };
  assert.deepEqual(statsOf(s), {
    schema: STATS_SCHEMA, chainId: 8453, generatedAt: { block: 2000, timestamp: 4000 },
    launches: { [TOKEN]: one, [TOKEN2]: two },
    totals: { [QUOTE]: { decimals: 6, launches: 2, graduated: 0, curveBuys: 4, curveSells: 2, curveVolume: '4358', poolSwaps: 0, poolVolume: '0' } },
  });

  // GRADUATED, TWO SWAPS IN ITS POOL: the quote is currency0 here, so its side
  // is amount0, either way. The second launch has nothing new: counted from
  // the file it already has.
  const pool = [w(QUOTE), w(TOKEN), w(0x800000n), w(60n), w(HOOK)];
  logs.push(
    ev(POOL_MANAGER, [TOPIC.swap, '0x' + w(7n), at(A)], [signed(-700n), 3000n, 1n << 96n, 10n ** 18n, 0n, 3000n], 2100, 0),
    ev(POOL_MANAGER, [TOPIC.swap, '0x' + w(7n), at(B)], [250n, signed(-1000n), 1n << 96n, 10n ** 18n, 0n, 3000n], 2200, 0),
  );
  const r2 = await indexAll({ rpc: chain({ safe: 2400, logs, launches: launches2(state(3, CURVE, pool)) }).rpc, chainId: 8453, registry: REGISTRY, lens: LENS, read: c.read, write: c.write, log: () => {} });
  assert.deepEqual(r2, { launches: 2, written: 1, failed: 0 });
  const after = statsOf(s);
  assert.deepEqual(after.generatedAt, { block: 2400, timestamp: 4800 });
  assert.deepEqual(after.launches[TOKEN], { ...one, status: 'graduated', lastTradeBlock: 2200, poolSwaps: 2, poolVolume: '950' });
  assert.deepEqual(after.launches[TOKEN2], two);
  assert.deepEqual(after.totals[QUOTE], { decimals: 6, launches: 2, graduated: 1, curveBuys: 4, curveSells: 2, curveVolume: '4358', poolSwaps: 2, poolVolume: '950' });
});

test("a sale through the CURB router is the seller's that the router's SoldForEth names, in the same transaction, for the same tokens", async () => {
  const s = store();
  const S1 = '0x' + '51'.repeat(20), S2 = '0x' + '52'.repeat(20), S3 = '0x' + '53'.repeat(20), S4 = '0x' + '54'.repeat(20);
  /** Where each sale's ether goes: not its seller. */
  const PAID = '0x' + 'e1'.repeat(20);
  const sale = (block: number, index: number, tokensIn: bigint) =>
    ev(CURVE, [TOPIC.curveSell, at(CURB_ROUTER), at(CURB_ROUTER)], [tokensIn, 300n, 3n, 2n], block, index, block);
  /** SoldForEth: seller, token and recipient in the topics; registry, tokensIn, quoteOut, ethOut, paidAsWeth. */
  const sold = (seller: string, block: number, index: number, tokensIn: bigint) =>
    ev(CURB_ROUTER, [TOPIC.routerSold, at(seller), at(TOKEN), at(PAID)], [REGISTRY, tokensIn, 300n, 299n, 0n], block, index, block);
  const logs = [
    buy(CURVE, A, 1001, 0, [1000n, 500n, 10n, 5n]),
    // THE SAME TOKENS IN TWO TRANSACTIONS: each sale is its own transaction's seller's.
    sale(1500, 0, 100n), sold(S1, 1500, 1, 100n),
    sale(1600, 0, 100n), sold(S2, 1600, 1, 100n),
    // TWO SALES IN ONE TRANSACTION: each is the seller's of its own tokens.
    sale(1700, 0, 70n), sold(S3, 1700, 1, 70n),
    sale(1700, 2, 30n), sold(S4, 1700, 3, 30n),
  ];
  await run(s, 2000, logs);
  const e = statsOf(s).launches[TOKEN];
  assert.equal(e.curveSells, 4);
  assert.equal(e.buyers, 1);
  assert.equal(e.traders, 5, 'A and the four sellers: not the router, not where the ether went, and no seller twice');
});

test("in a pool whose currency0 is the token, the quote side of each swap is amount1", async () => {
  const s = store();
  // TOKEN2 (0x77...) sorts below the quote asset (0x83...): the token is currency0.
  const pool = [w(TOKEN2), w(QUOTE), w(0x800000n), w(60n), w(HOOK)];
  const logs = [
    buy(CURVE2, B, 1050, 0, [400n, 100n, 4n, 2n]),
    // A BUY IN THE POOL (900 tokens out for 300 of the quote in) and a sale (400 in for 120 out).
    ev(POOL_MANAGER, [TOPIC.swap, '0x' + w(7n), at(B)], [900n, signed(-300n), 1n << 96n, 10n ** 18n, 0n, 3000n], 2100, 0),
    ev(POOL_MANAGER, [TOPIC.swap, '0x' + w(7n), at(B)], [signed(-400n), 120n, 1n << 96n, 10n ** 18n, 0n, 3000n], 2200, 0),
  ];
  const c = chain({ safe: 2400, logs, launches: [{ token: TOKEN2, curve: CURVE2, state: state(3, CURVE2, pool) }] });
  await indexAll({ rpc: c.rpc, chainId: 8453, registry: REGISTRY, lens: LENS, read: s.read, write: s.write, log: () => {} });
  assert.deepEqual(statsOf(s).launches[TOKEN2], {
    curve: CURVE2, quote: QUOTE, quoteDecimals: 6, status: 'graduated', firstTradeBlock: 1050, lastTradeBlock: 2200,
    curveBuys: 1, curveSells: 0, buyers: 1, traders: 1, curveVolume: '400',
    poolSwaps: 2, poolVolume: '420', // the quote's 300 and 120, not the token's 900 and 400
    holders: 0,
  });
  assert.equal(statsOf(s).totals[QUOTE].poolVolume, '420');
});

test('a launch the run cannot count keeps the numbers it had; an entry naming another curve is dropped', async () => {
  const s = store();
  const logs = [buy(CURVE, A, 1001, 0, [1000n, 500n, 0n, 0n]), buy(CURVE2, B, 1050, 0, [400n, 100n, 0n, 0n])];
  await indexAll({ rpc: chain({ safe: 2000, logs, launches: launches2() }).rpc, chainId: 8453, registry: REGISTRY, lens: LENS, read: s.read, write: s.write, log: () => {} });
  const was = statsOf(s).launches[TOKEN2];
  assert.equal(was.curveBuys, 1);
  // THE SECOND LAUNCH'S LENS REFUSES THIS RUN: the first is counted on, the
  // second keeps its entry, and the totals still count it.
  logs.push(buy(CURVE, A, 2500, 0, [700n, 300n, 0n, 0n]), buy(CURVE2, B, 2550, 0, [900n, 100n, 0n, 0n]));
  const broken = chain({ safe: 2600, logs, launches: launches2() });
  const lensDown: Rpc = { label: 'a', request: (a) => (a.method === 'eth_call' && (a.params as any[])[0].to === LENS && (a.params as any[])[0].data.endsWith(w(TOKEN2)) ? Promise.reject(new Error('down')) : broken.rpc.request(a)) };
  const r = await run(s, 2600, logs, lensDown);
  assert.equal(r.failed, 1);
  assert.equal(statsOf(s).launches[TOKEN].curveBuys, 2);
  assert.deepEqual(statsOf(s).launches[TOKEN2], was);
  assert.equal(statsOf(s).totals[QUOTE].curveBuys, 3, 'the kept entry is counted in the totals');
  // ITS QUOTE ASSET ANSWERS NO decimals(): its file and checked.json move on,
  // and its numbers stay as they were.
  const quiet = chain({ safe: 2700, logs, launches: launches2() });
  const noDecimals: Rpc = { label: 'a', request: (a) => (a.method === 'eth_call' && (a.params as any[])[0].to === QUOTE ? Promise.resolve('0x') : quiet.rpc.request(a)) };
  const r2 = await run(s, 2700, logs, noDecimals);
  assert.equal(r2.failed, 2, "neither launch's numbers could be counted");
  assert.equal(s.file(`sharing/8453/history/${TOKEN2}.json`).to, 2700, 'the file is still written');
  assert.equal(s.file(`sharing/8453/history/${TOKEN2}.json`).curveLogs.length, 2);
  assert.deepEqual(checkedOf(s).launches[TOKEN2], { curve: CURVE2, file: 2700, to: 2700 });
  assert.deepEqual(statsOf(s).launches[TOKEN2], was);
  // AN ENTRY FOR ANOTHER CURVE AT THIS TOKEN says nothing of this launch: gone,
  // though the launch cannot be counted this run.
  const j = statsOf(s);
  j.launches[TOKEN] = { ...j.launches[TOKEN], curve: '0x' + 'ee'.repeat(20) };
  s.files.set(STATS, new Uint8Array(Buffer.from(JSON.stringify(j))));
  const later = chain({ safe: 2800, logs, launches: launches2() });
  const lensDown1: Rpc = { label: 'a', request: (a) => (a.method === 'eth_call' && (a.params as any[])[0].to === LENS && (a.params as any[])[0].data.endsWith(w(TOKEN)) ? Promise.reject(new Error('down')) : later.rpc.request(a)) };
  await run(s, 2800, logs, lensDown1);
  assert.equal(statsOf(s).launches[TOKEN], undefined);
  assert.equal(statsOf(s).launches[TOKEN2].curveBuys, 2, 'the second launch, counted again');
});

test('stats.json is written only when its numbers change: a later block with nothing new is no change', async () => {
  const s = store();
  const c = counting(s);
  const logs = [buy(CURVE, A, 1001, 0, [1000n, 500n, 0n, 0n])];
  const go = (safe: number) => indexAll({ rpc: chain({ safe, logs }).rpc, chainId: 8453, registry: REGISTRY, lens: LENS, read: c.read, write: c.write, log: () => {} });
  await go(2000);
  assert.deepEqual(c.writes, [PATH, CHECKED, STATS]);
  // NOTHING NEW: checked.json moves on, the numbers do not.
  c.writes.length = 0;
  await go(2300);
  assert.deepEqual(c.writes, [CHECKED]);
  assert.deepEqual(statsOf(s).generatedAt, { block: 2000, timestamp: 4000 }, 'the run that wrote it');
  // THE FILE REWRITTEN FOR ITS AGE, the same logs in it: still no change.
  c.writes.length = 0;
  await go(2000 + Number(REWRITE_AFTER));
  assert.deepEqual(c.writes, [PATH, CHECKED]);
  // A NEW TRADE: written, at the run's block.
  c.writes.length = 0;
  logs.push(buy(CURVE, B, 30000, 0, [10n, 5n, 0n, 0n]));
  await go(30100);
  assert.deepEqual(c.writes, [PATH, CHECKED, STATS]);
  assert.deepEqual(statsOf(s).generatedAt, { block: 30100, timestamp: 60200 });
  assert.equal(statsOf(s).launches[TOKEN].curveBuys, 2);
  // AND WHAT IS READ BACK: only well-formed entries, in the shape they are written.
  const good = statsOf(s).launches[TOKEN];
  const bytes = (j: unknown) => new Uint8Array(Buffer.from(JSON.stringify(j)));
  assert.deepEqual(parseStats(s.files.get(STATS)!, 8453), { [TOKEN]: good });
  assert.deepEqual(parseStats(s.files.get(STATS)!, 1), {}, 'another chain');
  assert.deepEqual(parseStats(bytes({ schema: 'curb.stats/0', chainId: 8453, launches: { [TOKEN]: good } }), 8453), {});
  assert.deepEqual(parseStats(bytes({ schema: STATS_SCHEMA, chainId: 8453, launches: {
    [TOKEN]: good, [TOKEN2]: { ...good, curveVolume: '1.5' }, [A]: { ...good, holders: -1 }, [B]: { ...good, quote: undefined }, ['0x' + 'AB'.repeat(20)]: good,
  } }), 8453), { [TOKEN]: good }, 'an amount that is not whole units, a count below zero, no quote, a token not lower-case');
  assert.deepEqual(parseStats(new Uint8Array(Buffer.from('not json')), 8453), {});
});
