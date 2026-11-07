// No check and no keeper epoch reads a launch's history. The active root's
// RootPublished - where its file's URI comes from - is looked up in the
// second it was published in (indexer.ts rootPublishedIn), as the root under
// check already was: a bisection over the headers after the root's toBlock,
// then the logs of that second's blocks. Before, loadActiveState and the
// keeper's uriOf scanned the distributor's logs from sharingSince on every
// check and every new active epoch: about 430 requests a day of sharing on
// a 1,000-block window, so a launch could not be checked in time from its
// second day of sharing.
//
//   - loadActiveState on a launch that has shared for 30 days of 0.2-second
//     blocks reads one second's logs, as one that has shared for a day does;
//     a vetoed root published in the same second is another epoch's; a
//     missing or forged event is refused;
//   - on the simulated chain, after 30 days of sharing, the guardian's check
//     of an hour-long epoch reads nothing before that epoch, and a keeper
//     with an empty /data finds the active file's URI without a scan.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeEventTopics, keccak256, toHex } from 'viem';
import { ChainReader } from '../src/chain/reader.ts';
import { EVENTS, TOPICS } from '../src/chain/abis.ts';
import { prepareEpoch } from '../src/epoch.ts';
import { loadActiveState } from '../src/state.ts';
import { canonicalJson, type ActiveState, type EpochResult } from '../src/calc/index.ts';
import { watchTick } from '../src/ops/verify.ts';
import { loadVector } from './helpers.ts';
import { vectorWorld } from './world.ts';
import type { MockChain } from './mock-chain.ts';
import { opsWorld } from './sim/world.ts';
import { tick, js } from './sim/helpers.ts';

/** Base's blocks a day since 5 November 2026 (one every 0.2 s). */
const PER_DAY = 432_000n;
const HOUR = 18_000n;
const NON_INDEXED = EVENTS.RootPublished.inputs.filter((i) => !('indexed' in i && i.indexed));

/** A RootPublished log as HolderFeeDistributor.publish emits it. */
function rootPublished(D: string, r: EpochResult, uri: string, payableAt: bigint, block: bigint, contentHash = r.root.contentHash) {
  const topics = encodeEventTopics({ abi: [EVENTS.RootPublished], eventName: 'RootPublished', args: { epoch: Number(r.root.epoch) } }) as string[];
  const data = encodeAbiParameters(NON_INDEXED as any, [r.root.merkleRoot, r.root.fromBlock, r.root.toBlock, 0n, 0n, 0n, contentHash, uri, Number(payableAt)]);
  return { address: D, topics, data, block, logIndex: 0n, txHash: keccak256(toHex(`publish ${r.root.epoch} in ${block}`)) };
}

type Header = { hash: string; parentHash: string; timestamp: bigint };

/** The vector's headers, and past its last one a header for every block,
 *  five to a second, as Base makes them since 5 November 2026. */
class FiveASecond extends Map<bigint, Header> {
  chain: MockChain;
  last: bigint;
  lastTs: bigint;
  constructor(chain: MockChain, last: bigint, lastTs: bigint) {
    super();
    this.chain = chain;
    this.last = last;
    this.lastTs = lastTs;
  }
  tsOf(n: bigint): bigint {
    return this.lastTs + 1n + (n - this.last - 1n) / 5n;
  }
  override get(n: bigint): Header | undefined {
    const h = super.get(n);
    if (h || n <= this.last) return h;
    return { hash: this.chain.hashOf(n), parentHash: this.chain.hashOf(n - 1n), timestamp: this.tsOf(n) };
  }
}

const stateOf = (s: ActiveState) => ({ ...s, balancesAtEnd: s.balancesAtEnd ? [...s.balancesAtEnd] : null, cum: [...s.cum] });

/** v09 (epoch 2 vetoed, its range taken again by epoch 3) as a launch that
 *  has shared for `days` days: epochs 1 to 3 are computed; epoch 3, the
 *  active one, was published an hour before `at`, and in the same second,
 *  two blocks before it, epoch 2 (then vetoed in the block between). */
async function aged(days: bigint) {
  const w = vectorWorld(loadVector('v09-veto-recompute'));
  const last = w.chain.latest;
  const headers = new FiveASecond(w.chain, last, w.chain.headers.get(last)!.timestamp);
  for (const [n, h] of w.chain.headers) headers.set(n, h);
  (w.chain as any).headers = headers;
  const since = BigInt(loadVector('v09-veto-recompute').setup.sharingSince);
  const at = since + days * PER_DAY;
  const first = last + 1n + ((at - HOUR - last - 1n) / 5n) * 5n; // the first block of a second
  const [P2, V2, P3] = [first, first + 1n, first + 2n];
  const payableAt3 = headers.tsOf(first) + 3600n;
  const payableAt1 = headers.get(21n)!.timestamp + 3600n;

  const one = new ChainReader(w.chain.rpc('setup'), { tries: 0 });
  const results: EpochResult[] = [];
  let prev: ActiveState | null = null;
  for (let i = 0; i < 3; i++) {
    const a = w.attempts[i];
    const { result } = await prepareEpoch([one], w.config, { distributor: w.D, harvestTx: a.harvestTx, uri: a.uri, prev, opening: w.opening, distributors: [w.D] }, { allowSingleProvider: true, stateCache: null });
    const r = result as EpochResult;
    assert.equal(r.result, 'epoch');
    results.push(r);
    w.applyResult(i, r, Number(i === 0 ? payableAt1 : payableAt3));
    if (!a.vetoed) prev = r.next;
  }
  const [r1, r2, r3] = results;
  w.chain.addLog(rootPublished(w.D, r1, w.attempts[0].uri, payableAt1, 21n));
  w.chain.addLog(rootPublished(w.D, r2, w.attempts[1].uri, payableAt3, P2));
  const vetoTopics = encodeEventTopics({ abi: [EVENTS.RootVetoed], eventName: 'RootVetoed', args: { epoch: 2 } }) as string[];
  w.chain.addLog({ address: w.D, topics: vetoTopics, data: keccak256(toHex('CURB:RECOMPUTE_MISMATCH')), block: V2, logIndex: 0n, txHash: keccak256(toHex('veto 2')) });
  w.chain.addLog(rootPublished(w.D, r3, w.attempts[2].uri, payableAt3, P3));
  // the distributor's state at the far blocks is its state after epoch 3
  // (the vector records income only at its own blocks)
  const D = w.chain.contracts.get(w.D)!;
  w.chain.setContract(w.D, (data, b) => D(data, b > last ? w.attempts[3].toBlock : b));
  // a provider that answers 1,000 blocks a request, as Tenderly's keyless
  // gateway does; a reader that scans the history runs out of its budget
  w.chain.faults.rangeLimit = { max: 1000n, message: 'Block range too large for public access: maximum 1000 blocks' };
  w.chain.faults.maxLogCalls = w.chain.count('eth_getLogs') + 50;
  const files = new Map([[w.attempts[2].uri, r3.fileBytes]]);
  const fetchFile = async (u: string) => {
    const b = files.get(u);
    if (!b) throw new Error(`no file at ${u}`);
    return b;
  };
  const load = async () => {
    const mark = w.chain.calls.length;
    const reader = new ChainReader(w.chain.rpc('a'), { tries: 0, logWindow: { tries: 0 } });
    const loaded = await loadActiveState(reader, w.config.graduator, w.D, fetchFile, at);
    const calls = w.chain.calls.slice(mark);
    return { loaded, logs: calls.filter((c) => c.method === 'eth_getLogs'), headers: calls.filter((c) => c.method === 'eth_getBlockByNumber').length };
  };
  return { w, at, r3, P2, P3, payableAt3, load };
}

test('a launch that has shared for 30 days: the active root is loaded from one second of logs, as after one day', async () => {
  const seen: { days: bigint; logs: number; headers: number }[] = [];
  for (const days of [1n, 30n]) {
    const x = await aged(days);
    assert.equal(x.w.chain.logs.filter((l) => l.topics[0] === TOPICS.RootPublished && l.block >= x.P2 && l.block <= x.P3).length, 2, 'two roots were published in that second');
    const { loaded, logs, headers } = await x.load();
    // the right root: epoch 3's file, by the URI of its own event
    assert.equal(loaded.state!.epoch, 3n);
    assert.equal(loaded.state!.contentHash, x.r3.root.contentHash);
    assert.equal(loaded.state!.uri, x.w.attempts[2].uri);
    assert.equal(canonicalJson(stateOf(loaded.state!)), canonicalJson(stateOf({ ...x.r3.next, balancesAtEnd: null })));
    // one second's logs, after the epoch's end: nothing of the launch's history
    assert.equal(logs.length, 1, `${days} days: ${js(logs.map((c) => [c.params[0].fromBlock, c.params[0].toBlock]))}`);
    const [from, to] = [BigInt(logs[0].params[0].fromBlock), BigInt(logs[0].params[0].toBlock)];
    assert.ok(from >= x.P2 && from <= x.P3 && to - from <= 4n, `blocks ${from}..${to}`);
    seen.push({ days, logs: logs.length, headers });
  }
  // a bisection over the headers grows with the log of the age, not the age
  assert.ok(seen.every((s) => s.headers <= 40), js(seen));
  assert.ok(seen[1].headers - seen[0].headers <= 6, js(seen));
});

test('the active root whose event is missing, or names another file, is refused', async () => {
  const x = await aged(30n);
  const mine = x.w.chain.logs.find((l) => l.topics[0] === TOPICS.RootPublished && l.block === x.P3)!;
  x.w.chain.logs = x.w.chain.logs.filter((l) => l !== mine);
  await assert.rejects(x.load(), /0 RootPublished events for active epoch 3/);
  // the same epoch in the same second, naming other bytes
  x.w.chain.addLog(rootPublished(x.w.D, x.r3, x.w.attempts[2].uri, x.payableAt3, x.P3, keccak256(toHex('another file'))));
  await assert.rejects(x.load(), /does not match the active root/);
});

/** Every eth_getLogs of `D`'s RootPublished in `calls`, as [from, to]. */
const rootScans = (calls: { method: string; params: any[] }[], D: string): [bigint, bigint][] =>
  calls
    .filter((c) => c.method === 'eth_getLogs' && String(c.params[0].address).toLowerCase() === D && [c.params[0].topics?.[0]].flat().includes(TOPICS.RootPublished))
    .map((c) => [BigInt(c.params[0].fromBlock), BigInt(c.params[0].toBlock)]);

test('after 30 days of sharing, a check reads its epoch and a keeper with an empty /data its active root, not the history', { timeout: 120_000 }, async () => {
  const w = opsWorld();
  const L = w.launches[0];
  // a 20-block window: a scan of these 30 days would be 100 requests
  w.sim.faults.rangeLimit = { max: 20n, message: 'Block range too large for public access: maximum 20 blocks' };
  // 30 days of sharing (2,000 blocks of 1,296 s), then the first epoch
  w.sim.blockTime = 1296n;
  w.sim.mineMany(2000);
  w.sim.blockTime = 2n;
  w.clock.t += 2000 * 1296 * 1000;
  w.pass(60);
  const k = w.make('keeper');
  const t1 = await tick(w, k);
  assert.equal(t1.published.length, 1, js(t1));
  const g = w.make('guardian');
  const p1 = await watchTick(g.ctx, g.keys.guardian);
  assert.deepEqual(p1.results.map((r) => [r.epoch, r.verdict]), [[1n, 'ok']], js(p1.results));
  const T1 = w.sim.launch(L.D).pending.toBlock;
  assert.ok(T1 - L.sharingSince >= 2000n);

  // the hour passes; a keeper with an empty /data activates epoch 1 and
  // pushes it - the active file's URI from its event's own second - then
  // computes epoch 2 an hour later, opening from that file
  w.pass(3601);
  const k2 = w.make('keeper', { holder: 'empty data' });
  let mark = w.sim.calls.length;
  const t2 = await tick(w, k2);
  assert.deepEqual(t2.errors, [], js(t2.errors));
  assert.equal(w.sim.launch(L.D).active.epoch, 1);
  assert.ok(w.sim.launch(L.D).totalPaid0 > 0n, 'epoch 1 was pushed, from its file');
  w.sim.income(L.D, 10n ** 18n);
  w.pass(3601);
  const t3 = await tick(w, k2);
  assert.equal(t3.published.length, 1, js(t3));
  const keeperScans = rootScans(w.sim.calls.slice(mark), L.D);
  assert.ok(keeperScans.length >= 2, 'the URI was looked up, and epoch 2 opened from the active file');
  for (const [a, z] of keeperScans) assert.ok(z - a < 10n && a > T1, `the keeper scanned ${a}..${z} for a RootPublished`);

  // the guardian's check of epoch 2: nothing before epoch 1's end is read
  mark = w.sim.calls.length;
  const p2 = await watchTick(g.ctx, g.keys.guardian);
  assert.deepEqual(p2.results.map((r) => [r.epoch, r.verdict]), [[2n, 'ok']], js(p2.results));
  const logs = w.sim.calls.slice(mark).filter((c) => c.method === 'eth_getLogs');
  for (const c of logs) {
    const a = String(c.params[0].address).toLowerCase();
    if (a === L.D || a === L.token) assert.ok(BigInt(c.params[0].fromBlock) > T1, `the check read ${a} from block ${BigInt(c.params[0].fromBlock)}, before epoch 1 ended at ${T1}`);
  }
  assert.ok(logs.length < 60, `${logs.length} eth_getLogs in the pass`);
});
