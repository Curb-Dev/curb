// The complete balance states kept between epochs (src/state-store.ts): on
// disk under /data so a restart, the standby and a GitHub run start warm;
// never used unless they are exactly the committed state; sized per launch so
// many launches do not push each other out; one rebuild at a time per state;
// and a check its caller gave up on stops (PrepareOptions.signal). The last
// test measures a realistic history replay against a warm start.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChainReader } from '../src/chain/reader.ts';
import type { Rpc } from '../src/chain/rpc.ts';
import { prepareEpoch } from '../src/epoch.ts';
import { StateCache, encodeState, decodeState } from '../src/state-store.ts';
import { bytesEqual, commitState, parseEpochFile, stateFromEpochFile, vectorFilePath, type ActiveState, type EpochResult } from '../src/calc/index.ts';
import { loadVector, readVectorFile } from './helpers.ts';
import { vectorWorld, type World } from './world.ts';
import type { MockChain } from './mock-chain.ts';

const reader = (c: MockChain, label: string) => new ChainReader(c.rpc(label), { tries: 0 });

function req(w: World, i: number, prev: ActiveState | null = null) {
  const a = w.attempts[i];
  return { distributor: w.D, harvestTx: a.harvestTx, uri: a.uri, prev, opening: w.opening, distributors: [w.D] };
}

const tmp = () => mkdtempSync(join(tmpdir(), 'curb-states-'));

/** v12's first epoch on its world, and the state its file leaves (no balances). */
async function v12() {
  const w = vectorWorld(loadVector('v12-weight-floor-and-dust'));
  const r1 = (await prepareEpoch([reader(w.chain, 'a')], w.config, req(w, 0), { allowSingleProvider: true, stateCache: null })).result as EpochResult;
  w.applyResult(0, r1);
  const fromFile = stateFromEpochFile(parseEpochFile(r1.fileBytes), r1.contentHash, w.attempts[0].uri);
  const golden2 = readVectorFile(vectorFilePath('v12-weight-floor-and-dust', 2n))!;
  return { w, r1, fromFile, golden2 };
}

/** The token's Transfer log requests made since `from`, by their first block. */
const historyAsks = (w: World, from: number) =>
  w.chain.calls.slice(from).filter((x) => x.method === 'eth_getLogs' && String(x.params[0].address).toLowerCase() === w.token).map((x) => BigInt(x.params[0].fromBlock));

test('a state computed before a restart is read back from disk: the next epoch replays only its window', async () => {
  const dir = tmp();
  try {
    const { w, r1, fromFile, golden2 } = await v12();
    const one = reader(w.chain, 'a');
    // The keeper computes epoch 1 with its store under /data...
    await prepareEpoch([one], w.config, req(w, 0), { allowSingleProvider: true, stateCache: new StateCache({ dir }) });
    const file = join(dir, '8453', w.token, `${r1.root.toBlock}.state`);
    assert.ok(existsSync(file), 'the state after T is on disk');
    // ...and restarts: a new process, an empty memory, the same directory.
    const after = new StateCache({ dir });
    const mark = w.chain.calls.length;
    const r2 = (await prepareEpoch([one, reader(w.chain, 'b')], w.config, req(w, 1, fromFile), { stateCache: after })).result as EpochResult;
    assert.ok(bytesEqual(r2.fileBytes, golden2), 'the golden epoch 2');
    assert.equal(after.diskHits, 1);
    assert.ok(historyAsks(w, mark).every((b) => b > r1.root.toBlock), `only the window was read: ${historyAsks(w, mark)}`);
    // Without the directory the same restart replays the history.
    const cold = w.chain.calls.length;
    await prepareEpoch([one], w.config, req(w, 1, fromFile), { allowSingleProvider: true, stateCache: new StateCache() });
    assert.ok(historyAsks(w, cold).some((b) => b <= 100n), 'a cold start replays from before sharingSince');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a state on disk that is not exactly the committed one is never used', async () => {
  const dir = tmp();
  try {
    const { w, r1, fromFile, golden2 } = await v12();
    const one = reader(w.chain, 'a');
    await prepareEpoch([one], w.config, req(w, 0), { allowSingleProvider: true, stateCache: new StateCache({ dir }) });
    const file = join(dir, '8453', w.token, `${r1.root.toBlock}.state`);
    const good = new Uint8Array(readFileSync(file));
    assert.equal(commitState(decodeState(good)!.balances).commitment.digest, fromFile.stateAtEnd.digest);

    // One balance edited, its header left alone: the recomputed digest differs.
    const edited = good.slice();
    edited[edited.length - 1] ^= 1;
    writeFileSync(file, edited);
    let s = new StateCache({ dir });
    let mark = w.chain.calls.length;
    let r2 = (await prepareEpoch([one], w.config, req(w, 1, fromFile), { allowSingleProvider: true, stateCache: s })).result as EpochResult;
    assert.ok(bytesEqual(r2.fileBytes, golden2));
    assert.equal(s.diskHits, 0);
    assert.ok(historyAsks(w, mark).some((b) => b <= 100n), 'rebuilt from the chain');

    // A torn file (cut short) is a miss the same way.
    writeFileSync(file, good.slice(0, good.length - 7));
    s = new StateCache({ dir });
    r2 = (await prepareEpoch([one], w.config, req(w, 1, fromFile), { allowSingleProvider: true, stateCache: s })).result as EpochResult;
    assert.ok(bytesEqual(r2.fileBytes, golden2));
    assert.equal(s.diskHits, 0);

    // A whole, consistent state that is not the one this file commits to
    // (one more wei somewhere, its own header matching it) is not taken
    // either - and it is left in place: it is somebody's state.
    const other = new Map(decodeState(good)!.balances);
    const [a0] = [...other.keys()];
    other.set(a0, other.get(a0)! + 1n);
    const foreign = encodeState(other, commitState(other).commitment);
    writeFileSync(file, foreign);
    s = new StateCache({ dir });
    assert.equal(s.get(8453n, w.token, r1.root.toBlock, fromFile.stateAtEnd), null);
    assert.ok(bytesEqual(new Uint8Array(readFileSync(file)), foreign), 'kept: it is not torn');
    mark = w.chain.calls.length;
    r2 = (await prepareEpoch([one], w.config, req(w, 1, fromFile), { allowSingleProvider: true, stateCache: s })).result as EpochResult;
    assert.ok(bytesEqual(r2.fileBytes, golden2));
    assert.equal(s.diskHits, 0);
    assert.ok(historyAsks(w, mark).some((b) => b <= 100n), 'rebuilt from the chain');
    // the rebuilt state took its place
    assert.equal(commitState(decodeState(new Uint8Array(readFileSync(file)))!.balances).commitment.digest, fromFile.stateAtEnd.digest);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('states are kept per launch: many launches never push each other out, in memory or on disk', () => {
  const dir = tmp();
  try {
    const s = new StateCache({ maxBalances: 1_000_000, perToken: 2, dir });
    const token = (i: number) => '0x' + i.toString(16).padStart(40, '0');
    const state = (i: number, b: number) => {
      const m = new Map([[token(1000 + b), BigInt(i * 100 + b + 1)]]);
      return { m, c: commitState(m).commitment };
    };
    // 100 launches, two states each: far past the old 64-entry cap.
    for (let i = 1; i <= 100; i++) for (const b of [10, 20]) s.put(8453n, token(i), BigInt(b), state(i, b).m, state(i, b).c);
    for (let i = 1; i <= 100; i++) for (const b of [10, 20]) assert.ok(s.get(8453n, token(i), BigInt(b), state(i, b).c), `launch ${i} block ${b}`);
    assert.equal(s.size, 200);
    // A third state of one launch pushes out that launch's least recently used only.
    assert.ok(s.get(8453n, token(7), 10n, state(7, 10).c));
    s.put(8453n, token(7), 30n, state(7, 30).m, state(7, 30).c);
    assert.equal(s.size, 200);
    const mem = new StateCache({ perToken: 2 });
    for (const b of [10, 20, 30]) mem.put(8453n, token(7), BigInt(b), state(7, b).m, state(7, b).c);
    assert.equal(mem.get(8453n, token(7), 10n, state(7, 10).c), null);
    assert.ok(mem.get(8453n, token(7), 30n, state(7, 30).c));
    // On disk: two files for that launch, two for every other.
    assert.equal(readdirSync(join(dir, '8453', token(7))).length, 2);
    assert.equal(readdirSync(join(dir, '8453', token(8))).length, 2);
    // and a fresh process finds them
    const again = new StateCache({ dir, perToken: 2 });
    assert.ok(again.get(8453n, token(8), 20n, state(8, 20).c));
    assert.equal(again.diskHits, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('one rebuild at a time per state: checks asking for the same state at once replay the history once', async () => {
  const { w, fromFile, golden2 } = await v12();
  const s = new StateCache();
  const mark = w.chain.calls.length;
  const runs = await Promise.all(
    [0, 1, 2].map((i) => prepareEpoch([reader(w.chain, `p${i}`)], w.config, req(w, 1, fromFile), { allowSingleProvider: true, stateCache: s })),
  );
  for (const r of runs) assert.ok(bytesEqual((r.result as EpochResult).fileBytes, golden2));
  assert.equal(historyAsks(w, mark).filter((b) => b <= 100n).length, 1, 'one replay of the history for the three');
  assert.equal(s.rebuilding, 0);
  // A rebuild that fails is not handed on: the next asker tries its own.
  let calls = 0;
  const fail = s.once(1n, '0x' + '1'.repeat(40), 5n, fromFile.stateAtEnd, async () => {
    calls++;
    throw new Error('provider down');
  });
  const next = s.once(1n, '0x' + '1'.repeat(40), 5n, fromFile.stateAtEnd, async () => {
    calls++;
    return 'rebuilt';
  });
  await assert.rejects(fail, /provider down/);
  assert.equal(await next, 'rebuilt');
  assert.equal(calls, 2);
});

test('an aborted signal stops the work between two reads, the history replay included', async () => {
  const { w, r1, fromFile } = await v12();
  // Aborted before it starts: nothing is asked.
  const gone = new AbortController();
  gone.abort(new Error('the deadline passed'));
  let mark = w.chain.calls.length;
  await assert.rejects(prepareEpoch([reader(w.chain, 'a')], w.config, req(w, 1, fromFile), { allowSingleProvider: true, stateCache: null, signal: gone.signal }), /the deadline passed/);
  assert.equal(w.chain.calls.length, mark);
  // Aborted during the replay of the history, step by step (3 blocks a
  // step): the step in flight is the last one read.
  const ctl = new AbortController();
  w.chain.faults.before = (method, params) => {
    if (method === 'eth_getLogs' && String(params[0].address).toLowerCase() === w.token && BigInt(params[0].fromBlock) <= 100n) ctl.abort(new Error('given up'));
  };
  mark = w.chain.calls.length;
  await assert.rejects(
    prepareEpoch([reader(w.chain, 'a')], w.config, req(w, 1, fromFile), { allowSingleProvider: true, stateCache: null, signal: ctl.signal, rebuildStepBlocks: 3n }),
    /given up/,
  );
  w.chain.faults.before = undefined;
  assert.equal(historyAsks(w, mark).length, 1, `one step read, then stopped: ${historyAsks(w, mark)}`);
  // The same replay, not aborted, goes through every step and gives the golden epoch.
  mark = w.chain.calls.length;
  const r2 = (await prepareEpoch([reader(w.chain, 'a')], w.config, req(w, 1, fromFile), { allowSingleProvider: true, stateCache: null, rebuildStepBlocks: 3n })).result as EpochResult;
  assert.ok(bytesEqual(r2.fileBytes, readVectorFile(vectorFilePath('v12-weight-floor-and-dust', 2n))!));
  const steps = historyAsks(w, mark).filter((b) => b <= r1.root.toBlock);
  assert.ok(steps.length > 2, `several steps: ${steps}`);
});

// ------------------------------------------------------------- measured

/** A launch two weeks old (604,800 blocks of 2 s) whose token moved 40,000
 *  times among 20,000 holders before sharing began - a hundred large ones,
 *  the rest small - behind a provider that serves 10,000 blocks of logs a
 *  request, each request taking 40 ms. */
function busyLaunch(): World {
  const v = loadVector('v01-mid-epoch-transfers');
  const s = v.setup;
  const holders = Array.from({ length: 20_000 }, (_, i) => '0x' + (0x3000000 + i).toString(16).padStart(40, '0'));
  const F = 605_000;
  const transfers: any[] = [];
  const first = 200;
  // the launch: everyone buys from the curve, then they trade among themselves
  holders.forEach((h, i) => transfers.push({ block: String(first + i), logIndex: '0', from: '0x' + '0'.repeat(40), to: h, value: i < 100 ? '100000000000000000000000' : '1000000000000000' }));
  for (let i = 0; transfers.length < 40_000; i++) {
    const b = first + 20_000 + Math.floor((i * (F - 30_000)) / 20_000);
    transfers.push({ block: String(b), logIndex: String(i % 7), from: holders[(i * 7919) % holders.length], to: holders[(i * 104729 + 1) % holders.length], value: String(1 + (i % 1000)) });
  }
  transfers.sort((a, b) => Number(a.block) - Number(b.block) || Number(a.logIndex) - Number(b.logIndex));
  const uniq = transfers.filter((t, i) => i === 0 || t.block !== transfers[i - 1].block || t.logIndex !== transfers[i - 1].logIndex);
  // the window: alice and bob keep trading
  const alice = '0xa100000000000000000000000000000000000001';
  uniq.push({ block: String(F + 2), logIndex: '0', from: holders[0], to: alice, value: '5000' }, { block: String(F + 12), logIndex: '0', from: holders[1], to: alice, value: '7000' });
  const ts: Record<string, string> = { [String(first - 1)]: String(1_700_000_000) };
  for (let b = F - 1; b <= F + 21; b++) ts[String(b)] = String(1_700_000_000 + 2 * (b - first + 1));
  v.setup = { ...s, sharingSince: String(F), opening: { block: String(first - 1), balances: {} }, timestamps: ts, transfers: uniq, keeperTxs: [] };
  v.epochs = [
    { input: { ...v.epochs[0].input, toBlock: String(F + 9), harvestTx: '0x' + '1'.repeat(64), received0: '1000000', received1: '0', uri: 'ipfs://one' } },
    { input: { ...v.epochs[0].input, toBlock: String(F + 19), harvestTx: '0x' + '2'.repeat(64), received0: '2000000', received1: '0', uri: 'ipfs://two' } },
  ];
  const w = vectorWorld(v);
  w.chain.faults.rangeLimit = { max: 10_000n, message: 'eth_getLogs is limited to a 10,000 block range' };
  return w;
}

/** The provider with a round trip of `ms` per request. */
const slow = (c: MockChain, label: string, ms: number): Rpc => {
  const inner = c.rpc(label);
  return { label, request: async (a) => (await new Promise((r) => setTimeout(r, ms)), inner.request(a)) };
};

test('measured: a restart that reads the state from disk against one that replays two weeks of a busy token', async (t) => {
  const dir = tmp();
  try {
    const w = busyLaunch();
    const fast = new ChainReader(w.chain.rpc('setup'), { tries: 0, logWindow: { initial: 10_000 } });
    const r1 = (await prepareEpoch([fast], w.config, req(w, 0), { allowSingleProvider: true, stateCache: new StateCache({ dir }) })).result as EpochResult;
    assert.equal(r1.result, 'epoch');
    w.applyResult(0, r1);
    const fromFile = stateFromEpochFile(parseEpochFile(r1.fileBytes), r1.contentHash, 'ipfs://one');
    assert.ok(fromFile.stateAtEnd.count >= 20_000n);

    const run = async (cache: StateCache) => {
      const mark = w.chain.calls.length;
      const r = new ChainReader(slow(w.chain, 'b', 40), { tries: 0, logWindow: { initial: 10_000 } });
      const t0 = performance.now();
      const out = (await prepareEpoch([r], w.config, req(w, 1, fromFile), { allowSingleProvider: true, stateCache: cache })).result as EpochResult;
      return { ms: performance.now() - t0, out, asks: historyAsks(w, mark), requests: w.chain.calls.length - mark };
    };
    const cold = await run(new StateCache());
    const warm = await run(new StateCache({ dir }));
    t.diagnostic(`replay of the history: ${Math.round(cold.ms)} ms, ${cold.requests} requests (${cold.asks.length} for logs); from disk: ${Math.round(warm.ms)} ms, ${warm.requests} requests`);
    assert.ok(bytesEqual(cold.out.fileBytes, warm.out.fileBytes), 'the same epoch either way');
    assert.ok(cold.asks.length >= 60, `the replay walked the history: ${cold.asks.length} log requests`);
    assert.ok(warm.asks.every((b) => b > r1.root.toBlock), 'the warm start read only its window');
    // each request waits 40 ms at least, so the replay's 60 more cost 2.4 s at
    // least, whatever else the machine is doing; the warm start's own work is
    // the disk read and the digest of 20,000 balances
    assert.ok(cold.requests - warm.requests >= 60, 'every request the replay made, the warm start did not');
    assert.ok(warm.ms < cold.ms, `from disk (${Math.round(warm.ms)} ms) is quicker than the replay (${Math.round(cold.ms)} ms)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
