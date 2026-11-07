// The history scans keep their progress chunk by chunk (keeper.ts
// SCAN_CHUNK_BLOCKS). The guardian was down from 18 October 2026: a refusal
// part-way through its backlog threw the whole pass away, every pass started
// again from the same block, and on free providers' small getLogs windows -
// with Base's blocks every 0.2 s from 5 November - the backlog grew faster
// than one pass could read it. Here:
//   - the discovery resumes after the last chunk EVERY provider read: no
//     block left out, none read twice, a distributor one provider found in
//     a chunk the other did not finish is kept only once both have;
//   - its progress is on disk at once: a process killed mid-scan keeps it;
//   - the role-event scan resumes after the last chunk it handled, with no
//     gap and no alert twice, even when a chunk failed after its first alert;
//   - each provider's bound-distributor scan resumes where it stopped, and the
//     guardian brings it up to the safe head every pass, before any check;
//   - a pass whose scan fails still sends the vetoes it owes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { encodeAbiParameters, encodeEventTopics, keccak256, toHex } from 'viem';
import { opsWorld, HOLDERS } from './sim/world.ts';
import { tick, js, lying } from './sim/helpers.ts';
import { discover, roleEvents, boundDistributors, scanChunks, SCAN_CHUNK_BLOCKS } from '../src/ops/keeper.ts';
import { watchTick } from '../src/ops/verify.ts';
import { Store } from '../src/ops/store.ts';
import { opsDistributorAbi, opsFactoryAbi } from '../src/ops/abis.ts';
import { TOPICS } from '../src/chain/abis.ts';
import type { Rpc } from '../src/chain/rpc.ts';

type W = ReturnType<typeof opsWorld>;
const CHUNK = 4n; // chunks of [1000..1003], [1004..1007], [1008..1011], [1012..1015] (graduatorFromBlock 1000)
const THIEF = '0x00000000000000000000000000000000000bad01';

/** Every eth_getLogs a provider answered or refused, by label. */
interface Seen {
  label: string;
  address: string;
  from: bigint;
  to: bigint;
}

/** A provider that records its eth_getLogs, and refuses (answers a non-list)
 *  the ones `refuse` names while it is armed; `failBlock` refuses the
 *  header of that block while armed. */
function tapped(w: W, label: string, seen: Seen[], refuse: (s: Seen) => boolean = () => false): Rpc & { armed: boolean; failBlock: bigint | null } {
  const inner = w.sim.rpc(label);
  const r = {
    armed: true,
    failBlock: null as bigint | null,
    label,
    async request(a: { method: string; params?: unknown[] }) {
      const p = (a.params ?? []) as any[];
      if (a.method === 'eth_getLogs') {
        const s = { label, address: String(p[0].address).toLowerCase(), from: BigInt(p[0].fromBlock), to: BigInt(p[0].toBlock) };
        seen.push(s);
        if (r.armed && refuse(s)) return {};
      }
      if (a.method === 'eth_getBlockByNumber' && r.armed && r.failBlock !== null && p[0] === '0x' + r.failBlock.toString(16)) throw new Error('simulated: header refused');
      return inner.request(a);
    },
  };
  return r;
}

const mineTo = (w: W, n: bigint): void => {
  while (w.sim.latest < n) w.sim.mine();
};

/** A new sharing launch switched on in block `n` (the blocks before it mined). */
function launchAt(w: W, n: bigint, tag: string) {
  mineTo(w, n - 1n);
  const L = w.sim.addLaunch({ D: '0x' + keccak256(toHex(`distributor ${tag}`)).slice(26), token: '0x' + keccak256(toHex(`token ${tag}`)).slice(26), quote: w.quote, holders: { [HOLDERS.alice]: 10n ** 20n } });
  assert.equal(L.sharingSince, n);
  return L;
}

/** An event of `abi` logged by `address` in block `n` (the blocks before it mined). */
function eventAt(w: W, n: bigint, address: string, abi: any, name: string, args: Record<string, unknown>): string {
  mineTo(w, n - 1n);
  const item = abi.find((x: any) => x.type === 'event' && x.name === name);
  const topics = encodeEventTopics({ abi: [item], eventName: name, args: Object.fromEntries(item.inputs.filter((i: any) => i.indexed).map((i: any) => [i.name, args[i.name]])) } as any) as string[];
  const non = item.inputs.filter((i: any) => !i.indexed);
  const b = w.sim.mine();
  assert.equal(b, n);
  const txHash = keccak256(toHex(`ev:${name}:${b}`));
  w.sim.addLog({ address, topics, data: encodeAbiParameters(non, non.map((i: any) => args[i.name])), block: b, logIndex: 0n, txHash });
  return `event:${address.toLowerCase()}:${txHash}:0`;
}

test('scanChunks cuts a range in order, without a gap or an overlap', () => {
  assert.deepEqual(scanChunks(1000n, 1009n, 4n), [[1000n, 1003n], [1004n, 1007n], [1008n, 1009n]]);
  assert.deepEqual(scanChunks(5n, 5n, 4n), [[5n, 5n]]);
  assert.deepEqual(scanChunks(6n, 5n, 4n), []);
  assert.throws(() => scanChunks(1n, 2n, 0n));
  assert.equal(SCAN_CHUNK_BLOCKS, 10_000n);
});

test('discovery resumes after the last chunk EVERY provider read: no gap, nothing read twice, one provider failing after the other succeeded', async () => {
  const w = opsWorld(); // its launch in block 1001
  const L2 = launchAt(w, 1008n, 'second'); // the first block of the third chunk
  const L3 = launchAt(w, 1012n, 'third'); // the first block of the fourth
  mineTo(w, 1015n);
  const G = w.sim.addr.graduator;
  const seen: Seen[] = [];
  const a = tapped(w, 'a', seen);
  const b = tapped(w, 'b', seen, (s) => s.address === G && s.from <= 1012n && s.to >= 1012n);
  const g = w.make('guardian', { rpcs: [a, b] });
  g.ctx.scanChunkBlocks = CHUNK;

  await assert.rejects(discover(g.ctx, w.sim.safe, { allProviders: true }), (e: any) => /^provider b: /.test(e.message), 'the refusal names its provider');
  assert.ok(seen.some((s) => s.label === 'a' && s.address === G && s.from === 1012n), 'provider a read the fourth chunk before b refused it');
  const st = g.ctx.store.get<{ block: bigint; ds: string[] }>('discovery');
  assert.equal(st.block, 1011n, 'the last chunk both providers read');
  assert.deepEqual(st.ds, [w.launches[0].D, L2.D], 'what provider a alone found in the fourth chunk is not kept yet');
  const said = g.log.records().filter((r) => r.msg === 'history scan' && r.scan === 'discovery').map((r) => r.through);
  assert.deepEqual(said, ['1003', '1007', '1011'], 'a backlog says how far it got, chunk by chunk');

  b.armed = false;
  const n = seen.length;
  const ds = await discover(g.ctx, w.sim.safe, { allProviders: true });
  const again = seen.slice(n).filter((s) => s.address === G);
  assert.deepEqual([...new Set(again.map((s) => s.label))].sort(), ['a', 'b'], js(again));
  for (const lb of ['a', 'b']) assert.equal(again.filter((s) => s.label === lb)[0].from, 1012n, `provider ${lb} resumes at the first block not read (${js(again)})`);
  assert.ok(again.every((s) => s.from >= 1012n), 'nothing read twice');
  assert.deepEqual(ds, [w.launches[0].D, L2.D, L3.D]);
  assert.equal(g.ctx.store.get<{ block: bigint }>('discovery').block, w.sim.safe);
});

test('discovery progress is on disk chunk by chunk: a process killed mid-scan keeps it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'curb-scan-'));
  try {
    const w = opsWorld();
    launchAt(w, 1008n, 'second');
    mineTo(w, 1015n);
    const G = w.sim.addr.graduator;
    const seen: Seen[] = [];
    const g = w.make('guardian', { dataDir: dir, rpcs: [tapped(w, 'a', seen), tapped(w, 'b', seen, (s) => s.address === G && s.from >= 1012n)] });
    g.ctx.scanChunkBlocks = CHUNK;
    await assert.rejects(discover(g.ctx, w.sim.safe, { allProviders: true }));
    // no flush at the end of a pass: a new process reads what the scan wrote
    const st = new Store(dir).get<{ block: bigint; ds: string[] }>('discovery');
    assert.equal(st?.block, 1011n, js(st));
    assert.equal(st.ds.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the event scan resumes after the last chunk it handled: no gap, no alert twice, even after a chunk failed past its first alert', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  const F = w.sim.addr.factory;
  const at = BigInt(Math.floor(w.clock.t / 1000) + 48 * 3600);
  const k2 = eventAt(w, 1004n, F, opsFactoryAbi, 'PublisherAnnounced', { next: HOLDERS.bob, at }); // the second chunk
  const k3 = eventAt(w, 1008n, F, opsFactoryAbi, 'KeeperPayeeAnnounced', { next: HOLDERS.bob, at }); // the third, first block
  eventAt(w, 1009n, L.D, opsDistributorAbi, 'PushSkipped', { account: HOLDERS.carol, asset: 0 }); // the third: its block's time is read
  const k4 = eventAt(w, 1012n, F, opsFactoryAbi, 'PublisherAnnounced', { next: HOLDERS.carol, at }); // the fourth, first block
  mineTo(w, 1015n);
  const seen: Seen[] = [];
  const a = tapped(w, 'a', seen);
  a.failBlock = 1009n;
  const g = w.make('guardian', { rpcs: [a, w.sim.rpc('b')] });
  g.ctx.scanChunkBlocks = CHUNK;
  const events = () => g.ctx.alerts.raised.filter((x) => x.key.startsWith('event:')).map((x) => x.key);

  await assert.rejects(roleEvents(g.ctx, [L.D], w.sim.safe, {}), /header refused/);
  assert.equal(g.ctx.store.get<bigint>('eventsBlock'), 1007n, 'the third chunk failed part-way: not counted');
  assert.deepEqual(events(), [k2, k3], 'the third chunk had raised its first alert before it failed');
  assert.equal(g.ctx.store.get<Record<string, unknown>>('skips', {})[L.D], undefined);

  a.failBlock = null;
  const n = seen.length;
  await roleEvents(g.ctx, [L.D], w.sim.safe, {});
  const factoryScans = seen.slice(n).filter((s) => s.address === F);
  assert.equal(factoryScans[0]?.from, 1008n, `resumes at the first block not handled (${js(factoryScans)})`);
  assert.deepEqual(events(), [k2, k3, k4], 'every event alerted once: none twice, none missed');
  assert.ok(g.ctx.store.get<Record<string, Record<string, unknown>>>('skips', {})[L.D]?.[HOLDERS.carol], 'the refused push is remembered');
  assert.equal(g.ctx.store.get<bigint>('eventsBlock'), w.sim.safe);
});

test('a bound-distributor scan cut short resumes where it stopped, provider by provider', async () => {
  const w = opsWorld();
  const L2 = launchAt(w, 1008n, 'second');
  const L3 = launchAt(w, 1012n, 'third');
  mineTo(w, 1015n);
  const G = w.sim.addr.graduator;
  const seen: Seen[] = [];
  const b = tapped(w, 'b', seen, (s) => s.address === G && s.from <= 1012n && s.to >= 1012n);
  const g = w.make('guardian', { rpcs: [tapped(w, 'a', seen), b] });
  g.ctx.scanChunkBlocks = CHUNK;
  const T = w.sim.safe;
  await assert.rejects(boundDistributors(g.ctx, T, T), /provider b: /);
  const kept = () => g.ctx.store.get<Record<string, { block: bigint; bound: unknown[] }>>('boundDistributors', {});
  assert.equal(kept()['0:a']?.block, T, js(kept()));
  assert.equal(kept()['1:b']?.block, 1011n, js(kept()));
  b.armed = false;
  const n = seen.length;
  assert.deepEqual(await boundDistributors(g.ctx, T, T), [w.launches[0].D, L2.D, L3.D]);
  const again = seen.slice(n).filter((s) => s.address === G);
  assert.ok(again.length > 0 && again.every((s) => s.label === 'b' && s.from >= 1012n), `only b's unread blocks are read (${js(again)})`);
  assert.equal(kept()['1:b'].block, T);
});

test('a bound-distributor scan never puts back one kept further meanwhile (an abandoned check still running)', async () => {
  const w = opsWorld();
  mineTo(w, 1015n);
  const G = w.sim.addr.graduator;
  const seen: Seen[] = [];
  const g = w.make('guardian', { rpcs: [tapped(w, 'a', seen), tapped(w, 'b', seen)] });
  g.ctx.scanChunkBlocks = CHUNK;
  const further = { block: 1020n, bound: [[w.launches[0].D, w.launches[0].token, w.launches[0].sharingSince]] };
  const orig = g.ctx.readers[1].rpc.request.bind(g.ctx.readers[1].rpc);
  // while this scan reads its second chunk, another run keeps one further
  (g.ctx.readers[1].rpc as any).request = async (x: any) => {
    const r = await orig(x);
    if (x.method === 'eth_getLogs' && String(x.params[0].address).toLowerCase() === G && BigInt(x.params[0].fromBlock) === 1004n) {
      g.ctx.store.update<Record<string, unknown>>('boundDistributors', {}, (all) => {
        all['1:b'] = structuredClone(further);
      });
    }
    return r;
  };
  assert.deepEqual(await boundDistributors(g.ctx, w.sim.safe, w.sim.safe), [w.launches[0].D]);
  assert.equal(g.ctx.store.get<Record<string, { block: bigint }>>('boundDistributors', {})['1:b'].block, 1020n);
});

test('the guardian brings every bound-distributor scan up to the safe head on every pass, so a check reads no history', async () => {
  const w = opsWorld();
  const seen: Seen[] = [];
  const g = w.make('guardian', { rpcs: [tapped(w, 'a', seen), tapped(w, 'b', seen)] });
  const r1 = await watchTick(g.ctx, g.keys.guardian);
  assert.deepEqual(r1.errors, []);
  const safe1 = w.sim.safe;
  const kept = g.ctx.store.get<Record<string, { block: bigint }>>('boundDistributors', {});
  assert.deepEqual(Object.keys(kept).sort(), ['0:a', '1:b'], 'no root to check yet, and still kept');
  for (const k of Object.keys(kept)) assert.equal(kept[k].block, safe1);

  const k = w.make('keeper');
  w.pass(3601);
  assert.equal((await tick(w, k)).published.length, 1);
  const n = seen.length;
  const r2 = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(r2.results[0]?.verdict, 'ok', js(r2.results));
  const G = w.sim.addr.graduator;
  const old = seen.slice(n).filter((s) => s.address === G && s.from <= safe1);
  assert.deepEqual(old, [], 'the Graduator was read over new blocks only: the check found its list in /data');
});

test('a pass whose scan fails still sends the vetoes it owes', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  // a keeper whose two providers invent a mint to THIEF: its root is wrong
  const mint = (r: unknown, p: any[]) => {
    if (!Array.isArray(r) || String(p[0].address).toLowerCase() !== L.token || p[0].topics?.[0] !== TOPICS.Transfer) return r;
    const blk = L.sharingSince + 1n;
    if (blk < BigInt(p[0].fromBlock) || blk > BigInt(p[0].toBlock)) return r;
    return [...r, { address: L.token, topics: [TOPICS.Transfer, '0x' + '0'.repeat(64), '0x' + THIEF.slice(2).padStart(64, '0')], data: '0x' + (10n ** 30n).toString(16).padStart(64, '0'), blockNumber: '0x' + blk.toString(16), blockHash: w.sim.hashOf(blk), transactionHash: keccak256(toHex('forged')), logIndex: '0x3e7', removed: false }].sort((x: any, y: any) => (BigInt(x.blockNumber) === BigInt(y.blockNumber) ? Number(BigInt(x.logIndex) - BigInt(y.logIndex)) : BigInt(x.blockNumber) < BigInt(y.blockNumber) ? -1 : 1));
  };
  const liar = (label: string) => lying(w.sim.rpc(label), label, (m, p, r) => (m === 'eth_getLogs' ? mint(r, p) : r));
  const f = w.make('keeper', { holder: 'forger', rpcs: [liar('a'), liar('b')] });
  w.pass(3601);
  assert.equal((await tick(w, f)).published.length, 1);

  const seen: Seen[] = [];
  const b = tapped(w, 'b', seen, () => true);
  b.armed = false;
  const g = w.make('guardian', { rpcs: [w.sim.rpc('a'), b] });
  w.sim.baseFee = 200_000_000_000n; // above the guardian's cap: the veto is owed
  const r1 = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(r1.results[0]?.verdict, 'mismatch', js(r1.results));
  assert.equal(r1.vetoed.length, 0);
  assert.notEqual(w.sim.launch(L.D).pending.payableAt, 0n);

  b.armed = true; // every eth_getLogs of provider b refused from now on
  w.sim.baseFee = 5_000_000n;
  w.pass(60);
  const r2 = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(r2.ok, false);
  assert.match(r2.errors[0], /provider b: eth_getLogs/, js(r2.errors));
  assert.equal(r2.vetoed.length, 1, js(r2));
  assert.equal(w.sim.launch(L.D).pending.payableAt, 0n, 'vetoed on chain although the scan failed');
});
