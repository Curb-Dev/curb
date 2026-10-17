// The history index the site reads before the chain (scripts/index-history.ts):
// the same logs the endpoint returns, kept once each and in order, read from
// a launch's start and then only after the last block written, and a file
// that is not this launch's is read again from the start rather than trusted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexAll, merge, parseFile, parseChecked, slim, SCHEMA, CHECKED_SCHEMA, TOPIC, CURB_ROUTER, REWRITE_AFTER, type HistoryFile, type IndexLog } from '../scripts/index-history.ts';
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

/** A chain with one launch: launchedAt at block 1,000 (2 s blocks from t=0),
 *  the safe head where the test puts it, and the logs it is given. */
function chain(o: { safe: number; logs: IndexLog[] }) {
  const calls: { method: string; params: any[] }[] = [];
  const rpc: Rpc = {
    label: 'a',
    async request({ method, params = [] }) {
      calls.push({ method, params: params as any[] });
      if (method === 'eth_getBlockByNumber') return { number: hex(o.safe), timestamp: hex(o.safe * 2) };
      if (method === 'eth_call') {
        const { to, data } = (params as any[])[0];
        if (to === REGISTRY && data.startsWith('0x27cca59f')) return '0x' + w(1n); // launchCount
        if (to === REGISTRY && data.startsWith('0x7f5780c4')) return '0x' + w(TOKEN); // launchAt(0)
        if (to === REGISTRY) return '0x' + [w(CURVE), w('0x01'), w('0x02'), w('0x03'), w(0n), w(0n), w(0n), w('0x04'), w(100n), w(50n), w('0x05'), w(2000n)].join(''); // launchOf: launchedAt t=2000 -> block 1000
        if (to === LENS) return '0x' + [w(1n), ...Array(15).fill(w(0n))].join(''); // Selling
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
