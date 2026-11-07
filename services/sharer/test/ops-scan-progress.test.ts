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
// And since the review of 7 November 2026 (a 10,000-block chunk was still
// more requests than keyless dRPC answers between two refusal spells):
//   - a chunk is counted in requests, on the windows a provider has
//     ANSWERED, starting slow: on a free tier that takes 5 blocks a request
//     and 30 requests a pass, every pass moves on, the first included;
//   - a refusal spell of up to 63.5 s is waited out (7 tries);
//   - the vetoes owed go out first in a pass, before any scan; the scans of
//     a pass stop at guardian.passTimeoutSec, and the pass still checks;
//   - a veto any provider takes is sent;
//   - a check past its deadline stops at its next read, not after a backoff.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { encodeAbiParameters, encodeEventTopics, keccak256, toHex } from 'viem';
import { opsWorld, HOLDERS } from './sim/world.ts';
import { tick, js, lying } from './sim/helpers.ts';
import { discover, discoveredThrough, roleEvents, boundDistributors, chunkSize, SCAN_CHUNK_BLOCKS, SCAN_CHUNK_REQUESTS } from '../src/ops/keeper.ts';
import { scannedAddresses } from '../src/ops/events.ts';
import { watchTick } from '../src/ops/verify.ts';
import { stoppable } from '../src/ops/chainview.ts';
import { ChainReader } from '../src/chain/reader.ts';
import { RequestStopped } from '../src/chain/logs.ts';
import { RpcError } from '../src/chain/rpc.ts';
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

test('a chunk is SCAN_CHUNK_REQUESTS requests of the narrowest window a provider has ANSWERED, at most SCAN_CHUNK_BLOCKS', () => {
  assert.equal(SCAN_CHUNK_BLOCKS, 10_000n);
  assert.equal(SCAN_CHUNK_REQUESTS, 10n);
  const g = opsWorld().make('guardian');
  const [a, b] = g.ctx.readers;
  assert.equal(a.logWindow.window, 2000, 'what the reader asks first');
  assert.equal(chunkSize(g.ctx, [a, b]), 10n, 'nothing answered yet: one-block windows - a slow start, not 10 x 2,000');
  a.logWindow.widest = 10;
  b.logWindow.widest = 10;
  assert.equal(chunkSize(g.ctx, [a, b]), 100n, '10 times the widest answered, not the window asked next');
  a.logWindow.widest = a.logWindow.window = 1000;
  b.logWindow.widest = b.logWindow.window = 100;
  assert.equal(chunkSize(g.ctx, [a, b]), 1000n, 'the narrowest provider counts: keyless dRPC, 100-block windows, 10 requests');
  assert.equal(chunkSize(g.ctx, [a]), 10_000n, 'only the providers it reads; Tenderly, 1,000-block windows: the block cap');
  b.logWindow.window = 50; // refused since (a result-size ceiling): what it asks now
  assert.equal(chunkSize(g.ctx, [b]), 500n);
  assert.equal(chunkSize(g.ctx, [a], 5), 2000n, 'five addresses read a window: 2 windows a chunk');
  assert.equal(chunkSize(g.ctx, [a], 40), 1000n, 'more addresses than requests: one window');
  g.ctx.scanChunkBlocks = 4n;
  assert.equal(chunkSize(g.ctx, [a, b]), 4n);
  const D = ['0x' + '1'.repeat(40), '0x' + '2'.repeat(40)];
  const zero = '0x' + '0'.repeat(40);
  assert.equal(scannedAddresses({ factory: D[0], catalog: D[1], hook: zero, registry: null, distributors: D }), 4, 'the factory, the catalog, two distributors');
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
  // windows known (2,000 blocks): the chunks are CHUNK blocks however many addresses it reads
  for (const r of g.ctx.readers) r.logWindow.widest = r.logWindow.window;
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

/** A guardian world whose keeper's two providers invent a mint to THIEF:
 *  its root (epoch 1, pending) does not verify. */
function wrongRoot(): W {
  const w = opsWorld();
  const L = w.launches[0];
  const mint = (r: unknown, p: any[]) => {
    if (!Array.isArray(r) || String(p[0].address).toLowerCase() !== L.token || p[0].topics?.[0] !== TOPICS.Transfer) return r;
    const blk = L.sharingSince + 1n;
    if (blk < BigInt(p[0].fromBlock) || blk > BigInt(p[0].toBlock)) return r;
    return [...r, { address: L.token, topics: [TOPICS.Transfer, '0x' + '0'.repeat(64), '0x' + THIEF.slice(2).padStart(64, '0')], data: '0x' + (10n ** 30n).toString(16).padStart(64, '0'), blockNumber: '0x' + blk.toString(16), blockHash: w.sim.hashOf(blk), transactionHash: keccak256(toHex('forged')), logIndex: '0x3e7', removed: false }].sort((x: any, y: any) => (BigInt(x.blockNumber) === BigInt(y.blockNumber) ? Number(BigInt(x.logIndex) - BigInt(y.logIndex)) : BigInt(x.blockNumber) < BigInt(y.blockNumber) ? -1 : 1));
  };
  const liar = (label: string) => lying(w.sim.rpc(label), label, (m, p, r) => (m === 'eth_getLogs' ? mint(r, p) : r));
  return Object.assign(w, { forger: w.make('keeper', { holder: 'forger', rpcs: [liar('a'), liar('b')] }) });
}

/** A free tier: eth_getLogs over at most `ceiling` blocks (a wider range is
 *  refused as dRPC refuses it), and `perPass` requests between two refusal
 *  spells - past them every eth_getLogs is refused "rate limit" until the
 *  next pass, a spell longer than any backoff. */
function freeTier(w: W, label: string, o: { ceiling: bigint; perPass: number }) {
  const inner = w.sim.rpc(label);
  const r = {
    label,
    used: 0,
    async request(a: { method: string; params?: unknown[] }) {
      if (a.method === 'eth_getLogs') {
        if (++r.used > o.perPass) throw new RpcError('You reached Public endpoint rate limit, please upgrade to paid plan', { status: 429, code: 15 });
        const p = (a.params as any[])[0];
        if (BigInt(p.toBlock) - BigInt(p.fromBlock) + 1n > o.ceiling) throw new RpcError('ranges over 10000 blocks are not supported on free plan', { code: 35 });
      }
      return inner.request(a);
    },
  };
  return r;
}

test('ADVERSARIAL: a free tier of 5 blocks a request and 30 requests a pass - every scan moves on every pass, the first included, until the guardian is clean', async () => {
  const w = opsWorld();
  mineTo(w, 1400n); // 400 blocks behind: 80 requests at 5 blocks, more than two passes allow
  const b = freeTier(w, 'b', { ceiling: 5n, perPass: 30 });
  const g = w.make('guardian', { rpcs: [w.sim.rpc('a'), b] }); // SCAN_CHUNK_BLOCKS: 10,000
  let waited = 0;
  for (const r of g.ctx.readers) r.logWindow.opts.sleep = async (ms) => void (waited += ms);
  const at = () => ({ discovery: discoveredThrough(g.ctx), bound: g.ctx.store.get<Record<string, { block: bigint }>>('boundDistributors', {})['1:b']?.block ?? 999n });
  const safe = w.sim.safe;
  const seen: string[] = [];
  let clean = false;
  for (let pass = 1; pass <= 20 && !clean; pass++) {
    b.used = 0;
    const before = at();
    const r = await watchTick(g.ctx, g.keys.guardian);
    const after = at();
    seen.push(`pass ${pass}: discovery ${after.discovery}, bound on b ${after.bound}, ok ${r.ok}, ${r.errors[0] ?? ''}`.slice(0, 220));
    if (r.ok) {
      clean = true;
      assert.deepEqual(r.errors, []);
      break;
    }
    if (pass === 1) assert.ok(after.discovery > 999n, `the first pass of a fresh process keeps a chunk too (${seen.join(' | ')})`);
    if (before.discovery < safe) assert.ok(after.discovery > before.discovery, `the discovery moved on in every pass (${seen.join(' | ')})`);
    else assert.ok(after.bound > before.bound, `then the bound distributors on b moved on in every pass (${seen.join(' | ')})`);
    assert.ok(r.errors.some((e) => /provider b: eth_getLogs refused 8 times in a row .*rate limit/.test(e)), js(r.errors));
  }
  assert.ok(clean, `caught up, and a pass is clean (${seen.join(' | ')})`);
  assert.equal(discoveredThrough(g.ctx), safe);
  assert.equal(g.ctx.readers[1].logWindow.cap, 5, 'the ceiling found');
  assert.ok(waited > 0, 'the spells were waited for before each pass gave up');
});

test('a refusal spell is waited out - 7 tries, 63.5 s - before a scan gives up; --getlogs-tries changes it', async () => {
  const w = opsWorld();
  mineTo(w, 1015n);
  let n = 0;
  let spell = 6;
  const b = { label: 'b', request: async (a: { method: string; params?: unknown[] }) => {
    if (a.method === 'eth_getLogs' && ++n >= 2 && n < 2 + spell) throw new RpcError('You reached Public endpoint rate limit, please upgrade to paid plan', { status: 429, code: 15 });
    return w.sim.rpc('b').request(a);
  } };
  const g = w.make('guardian', { rpcs: [w.sim.rpc('a'), b] });
  const slept: number[] = [];
  for (const r of g.ctx.readers) r.logWindow.opts.sleep = async (ms) => void slept.push(ms);
  assert.equal(g.ctx.readers[1].logWindow.opts.tries, 7);
  await discover(g.ctx, w.sim.safe, { allProviders: true });
  assert.deepEqual(slept, [500, 1000, 2000, 4000, 8000, 16000], 'six refusals in a row, 31.5 s: waited out');
  assert.equal(discoveredThrough(g.ctx), w.sim.safe);

  const g2 = w.make('guardian', { rpcs: [w.sim.rpc('a'), b] });
  for (const r of g2.ctx.readers) r.logWindow.opts.sleep = async () => {};
  n = 0;
  spell = 8;
  await assert.rejects(discover(g2.ctx, w.sim.safe, { allProviders: true }), /^LogWindowError: provider b: eth_getLogs refused 8 times in a row|provider b: eth_getLogs refused 8 times in a row/);
  assert.equal(w.make('guardian', { logTries: 9 }).ctx.readers[0].logWindow.opts.tries, 9, '--getlogs-tries reaches every reader');
});

test('the vetoes owed go out FIRST in a pass, before any scan reads a block', async () => {
  const w = wrongRoot();
  const L = w.launches[0];
  w.pass(3601);
  assert.equal((await tick(w, (w as any).forger)).published.length, 1);
  const calls: string[] = [];
  const rec = (label: string) => {
    const inner = w.sim.rpc(label);
    return { label, request: async (a: { method: string; params?: unknown[] }) => {
      calls.push(`${label} ${a.method} ${a.method === 'eth_getLogs' ? String((a.params as any[])[0].address).toLowerCase() : ''}`);
      return inner.request(a);
    } };
  };
  const g = w.make('guardian', { rpcs: [rec('a'), rec('b')] });
  w.sim.baseFee = 200_000_000_000n; // above the guardian's cap: the veto is owed
  const r1 = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(r1.results[0]?.verdict, 'mismatch', js(r1.results));
  assert.equal(r1.vetoed.length, 0);
  w.sim.baseFee = 5_000_000n;
  w.pass(60);
  calls.length = 0;
  const r2 = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(r2.vetoed.length, 1, js(r2));
  assert.equal(w.sim.launch(L.D).pending.payableAt, 0n);
  const sent = calls.findIndex((c) => / eth_sendRawTransaction /.test(c));
  const scan = calls.findIndex((c) => c.endsWith(` ${w.sim.addr.graduator}`) || c.endsWith(` ${w.sim.addr.factory}`));
  assert.ok(sent >= 0 && scan > sent, `sent at call ${sent}, the first scan at ${scan}: ${js(calls.slice(0, 12))}`);
});

test('a backlog is read across passes: each stops its scans at guardian.passTimeoutSec, still checks, says how far behind, and reads no role event or head block past the discovery', async () => {
  const w = opsWorld({ safeLag: 3n });
  const k = w.make('keeper');
  w.pass(3601);
  assert.equal((await tick(w, k)).published.length, 1);
  mineTo(w, 1030n);
  const G = w.sim.addr.graduator;
  const F = w.sim.addr.factory;
  const seen: Seen[] = [];
  // every Graduator read on provider a takes 100 s of the pass
  const slow = tapped(w, 'a', seen);
  const inner = slow.request;
  slow.request = async (x: any) => {
    if (x.method === 'eth_getLogs' && String(x.params[0].address).toLowerCase() === G) w.clock.t += 100_000;
    return inner(x);
  };
  const g = w.make('guardian', { rpcs: [slow, tapped(w, 'b', seen)] });
  g.ctx.scanChunkBlocks = CHUNK;
  for (const r of g.ctx.readers) r.logWindow.widest = r.logWindow.window;
  assert.equal(w.cfg.guardian.passTimeoutSec, 300);
  const safe = w.sim.safe;
  const r1 = await watchTick(g.ctx, g.keys.guardian);
  const found = discoveredThrough(g.ctx);
  assert.equal(found, 1011n, 'three chunks of the discovery, 300 s: then the scans stop');
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.some((e) => new RegExp(`history scans behind the safe head ${safe}: the discovery through 1011`).test(e)), js(r1.errors));
  assert.equal(r1.results[0]?.verdict, 'ok', `the pass still checked the pending root: ${js(r1.results)}`);
  assert.ok(g.ctx.store.get<bigint>('eventsBlock') <= found, 'the role events never past the discovery');
  assert.ok(seen.filter((s) => s.address === F).every((s) => s.to <= found), 'no role event read past the discovery');
  assert.ok(seen.filter((s) => s.address === G).every((s) => s.to <= safe), 'nothing above the safe head read while the discovery is behind');

  let passes = 1;
  let last = found;
  for (;;) {
    const r = await watchTick(g.ctx, g.keys.guardian);
    passes++;
    if (r.ok) break;
    assert.ok(passes < 15, js(r.errors));
    assert.ok(discoveredThrough(g.ctx) > last || discoveredThrough(g.ctx) >= w.sim.safe, `every pass moves on: ${js(r.errors)}`);
    last = discoveredThrough(g.ctx);
  }
  assert.equal(discoveredThrough(g.ctx), w.sim.safe);
  assert.equal(g.ctx.store.get<bigint>('eventsBlock'), w.sim.safe);
});

test('a veto goes out when ANY provider takes it: provider a refusing the transaction is logged, not "could NOT veto"', async () => {
  for (const both of [false, true]) {
    const w = wrongRoot();
    const L = w.launches[0];
    w.pass(3601);
    assert.equal((await tick(w, (w as any).forger)).published.length, 1);
    const noSend = (label: string) => {
      const inner = w.sim.rpc(label);
      return { label, request: async (a: { method: string; params?: unknown[] }) => {
        if (a.method === 'eth_sendRawTransaction') throw new RpcError('Internal server error', { code: -32603 });
        return inner.request(a);
      } };
    };
    const g = w.make('guardian', { rpcs: [noSend('a'), both ? noSend('b') : w.sim.rpc('b')] });
    const r = await watchTick(g.ctx, g.keys.guardian);
    assert.equal(r.results[0]?.verdict, 'mismatch', js(r.results));
    if (!both) {
      assert.equal(r.vetoed.length, 1, js(r));
      assert.equal(w.sim.launch(L.D).pending.payableAt, 0n, 'vetoed on chain, through provider b');
      assert.ok(!r.errors.some((e) => /Internal server error|could NOT veto/i.test(e)), js(r.errors));
      const warn = g.log.records().find((x) => x.msg === 'a provider refused the transaction another took');
      assert.ok(warn && /^provider a: Internal server error/.test(String(warn.refused?.[0])), js(warn));
    } else {
      assert.equal(r.vetoed.length, 0, 'taken by none: not sent');
      assert.notEqual(w.sim.launch(L.D).pending.payableAt, 0n);
      assert.ok(r.errors.some((e) => /Internal server error/.test(e)), `provider a's refusal is the error: ${js(r.errors)}`);
    }
  }
});

test('a check past its deadline stops at its next read: an eth_getLogs refused "busy" is not waited out', async () => {
  const w = opsWorld();
  const ctl = new AbortController();
  const slept: number[] = [];
  const busy = { label: 'a', request: async (a: { method: string; params?: unknown[] }) => {
    if (a.method === 'eth_getLogs') throw new RpcError('rate limit exceeded', { status: 429 });
    return w.sim.rpc('a').request(a);
  } };
  const r = new ChainReader(busy, { logWindow: { tries: 7, sleep: async (ms) => {
    slept.push(ms);
    if (slept.length === 2) ctl.abort(new Error('the deadline passed'));
  } } });
  await assert.rejects(stoppable(r, ctl.signal).logs({ address: w.sim.addr.graduator }, 1000n, 1010n), (e: any) => e instanceof RequestStopped && /the deadline passed/.test(e.message));
  assert.deepEqual(slept, [500, 1000], 'stopped at its next read, not after the 63.5 s backoff');
  // a request withdrawn for a reason that reads like a timeout is not asked again either
  const ctl2 = new AbortController();
  ctl2.abort(new Error('timed out'));
  const r2 = new ChainReader(w.sim.rpc('a'), { sleep: async () => { throw new Error('asked again'); } });
  await assert.rejects(stoppable(r2, ctl2.signal).request('eth_chainId', []), (e: any) => e instanceof RequestStopped && /timed out/.test(e.message));
});

test('a bound-distributor scan stopped short by the pass budget answers nothing, not a part of the list', async () => {
  const w = opsWorld();
  const L2 = launchAt(w, 1008n, 'second');
  mineTo(w, 1015n);
  const g = w.make('guardian');
  g.ctx.scanChunkBlocks = CHUNK;
  for (const r of g.ctx.readers) r.logWindow.widest = r.logWindow.window;
  const T = w.sim.safe;
  assert.equal(await boundDistributors(g.ctx, T, T, g.ctx.now()), undefined, 'one chunk each, then the budget is over');
  const kept = g.ctx.store.get<Record<string, { block: bigint }>>('boundDistributors', {});
  assert.deepEqual([kept['0:a']?.block, kept['1:b']?.block], [1003n, 1003n], 'the chunk each read is kept');
  assert.deepEqual(await boundDistributors(g.ctx, T, T), [w.launches[0].D, L2.D]);
});

test('the role events count a chunk in requests too: one eth_getLogs a window for each address they read', async () => {
  const w = opsWorld();
  mineTo(w, 1100n);
  const L = w.launches[0];
  const seen: Seen[] = [];
  const g = w.make('guardian', { rpcs: [tapped(w, 'a', seen), w.sim.rpc('b')] });
  const a = g.ctx.readers[0];
  a.logWindow.widest = a.logWindow.window = a.logWindow.cap = 10; // a provider of 10-block windows
  const k = scannedAddresses({ factory: w.cfg.distributorFactory, catalog: w.cfg.catalog, hook: w.cfg.hook, registry: w.cfg.registry, distributors: [L.D] });
  assert.ok(k >= 3 && k <= 5, `the factory, the catalog, the distributor and what else is set: ${k}`);
  await roleEvents(g.ctx, [L.D], w.sim.safe, {});
  const chunk = 10n * (SCAN_CHUNK_REQUESTS / BigInt(k));
  const through = g.log.records().filter((r) => r.msg === 'history scan' && r.scan === 'role events').map((r) => BigInt(r.through));
  assert.equal(through[0], w.cfg.eventsFromBlock + chunk - 1n, `chunks of ${chunk} blocks: ${k} addresses a window`);
  let start = w.cfg.eventsFromBlock;
  for (const z of through) {
    const n = seen.filter((s) => s.label === 'a' && s.from >= start && s.to <= z).length;
    assert.ok(n <= Number(SCAN_CHUNK_REQUESTS), `at most ${SCAN_CHUNK_REQUESTS} requests a chunk: ${n} for ${start}..${z}`);
    start = z + 1n;
  }
  assert.equal(g.ctx.store.get<bigint>('eventsBlock'), w.sim.safe);
});
