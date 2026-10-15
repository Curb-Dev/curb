// The guardian against being outrun (re-review N1, N2, N4 and the leftover
// of finding 9):
//   - every distributor's roots are read in a few Multicall3 requests per
//     provider, not two calls per distributor;
//   - the checks of a pass have a budget of their own, and a root the pass
//     had no time for is never vetoed for that: in its last minutes the
//     guardian freezes instead;
//   - k or more pending roots to veto at once freeze first; unverifiable
//     roots are vetoed after a short grace, together, in one vetoMany named
//     from a fresh read;
//   - an abandoned check stops at its next read, and is not started again
//     while it still runs;
//   - frozen with an unfreeze announced is no freeze that holds: a freeze
//     the guardian owes cancels the unfreeze.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, encodeFunctionData, keccak256, toHex } from 'viem';
import { opsWorld } from './sim/world.ts';
import { tick, js, lying, alertKeys, crashing } from './sim/helpers.ts';
import { watchTick, REASONS } from '../src/ops/verify.ts';
import { readRootsMany } from '../src/ops/chainview.ts';
import { MULTICALL3, opsDistributorAbi, opsFactoryAbi } from '../src/ops/abis.ts';
import { TOPICS } from '../src/chain/abis.ts';
import { ChainReader } from '../src/chain/reader.ts';
import { fileCid } from '../src/ops/cid.ts';
import { sha256Hex } from '../src/calc/encoding.ts';
import { WETH } from './sim/chain.ts';

type W = ReturnType<typeof opsWorld>;
const THIEF = '0x00000000000000000000000000000000000bad01';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A keeper whose two providers both invent a mint to THIEF in EVERY launch:
 *  each file is self-consistent and hashes right, and every root is wrong. */
function forger(w: W) {
  const forged = (r: unknown, p: any[]) => {
    if (!Array.isArray(r) || p[0].topics?.[0] !== TOPICS.Transfer) return r;
    const L = w.launches.find((l) => l.token === String(p[0].address).toLowerCase());
    if (!L) return r;
    const b = L.sharingSince + 1n;
    if (b < BigInt(p[0].fromBlock) || b > BigInt(p[0].toBlock)) return r;
    return [...r, { address: L.token, topics: [TOPICS.Transfer, '0x' + '0'.repeat(64), '0x' + THIEF.slice(2).padStart(64, '0')], data: '0x' + (10n ** 30n).toString(16).padStart(64, '0'), blockNumber: '0x' + b.toString(16), blockHash: w.sim.hashOf(b), transactionHash: keccak256(toHex(`forged ${L.token}`)), logIndex: '0x3e7', removed: false }].sort((x: any, y: any) => (BigInt(x.blockNumber) === BigInt(y.blockNumber) ? Number(BigInt(x.logIndex) - BigInt(y.logIndex)) : BigInt(x.blockNumber) < BigInt(y.blockNumber) ? -1 : 1));
  };
  const liar = (label: string) => lying(w.sim.rpc(label), label, (m, p, r) => (m === 'eth_getLogs' ? forged(r, p) : r));
  return w.make('keeper', { holder: 'forger', rpcs: [liar('a'), liar('b')] });
}

/** A root published straight from the publisher key (a stolen one) whose
 *  file nobody serves. */
function craft(w: W, L: W['launches'][number], tag: string): { site: string } {
  assert.ok(w.sim.userTx(THIEF, L.D, encodeFunctionData({ abi: opsDistributorAbi, functionName: 'harvest' })).ok, 'harvest');
  const s = w.sim.launch(L.D);
  const uri = `ipfs://${fileCid(new TextEncoder().encode(`no such file: ${tag}`))}`;
  const root = { merkleRoot: keccak256(toHex(`root ${tag}`)), contentHash: keccak256(toHex(`content ${tag}`)), cumHolders0: s.active.cumHolders0 + 1n, cumHolders1: s.active.cumHolders1, cumKeeper0: s.active.cumKeeper0, fromBlock: s.active.epoch === 0 ? L.sharingSince : s.active.toBlock + 1n, toBlock: w.sim.latest, epoch: s.lastProposed + 1, payableAt: 0 };
  assert.ok(w.sim.userTx(w.signers.publisher.address, w.sim.addr.factory, encodeFunctionData({ abi: opsFactoryAbi, functionName: 'publishMany', args: [[L.D as `0x${string}`], [root as any], [uri]] as any })).ok, `publish ${tag}`);
  return { site: `https://site.test/sharing/8453/${L.D}/${root.epoch}.json` };
}

function guardianWith(w: W, wrap: (inner: typeof fetch) => typeof fetch, x: Parameters<W['make']>[1] = {}) {
  const net = w.net as any;
  const plain = net.fetch;
  net.fetch = wrap(plain);
  try {
    return w.make('guardian', x);
  } finally {
    net.fetch = plain;
  }
}

const stalled = () => new Response(new ReadableStream({ pull: () => new Promise<void>(() => {}) }) as BodyInit, { status: 200 });
const fnOf = (w: W, tx: string) => decodeFunctionData({ abi: opsFactoryAbi, data: w.sim.txs.get(tx)!.input as `0x${string}` }).functionName;
/** The guardian's transactions to the factory since `from`, in the order mined. */
const factoryTxs = (w: W, from: number) => [...w.sim.txs.values()].slice(from).filter((t) => t.to === w.sim.addr.factory && t.from === w.signers.guardian.address);

// ---------------------------------------------------------------- N1: reading the roots

test('every root is read in one Multicall3 request per provider, not two calls per distributor', async () => {
  const w = opsWorld({ launches: 12 });
  // the sim has Multicall3 (sim/chain.ts aggregate3), as Base does
  const k = w.make('keeper');
  w.pass(3601);
  assert.equal((await tick(w, k)).published.length, 12);
  const g = w.make('guardian');
  const r1 = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(r1.results.length, 12, js(r1.results.map((x) => x.verdict)));
  assert.ok(r1.results.every((x) => x.verdict === 'ok'), 'every root read whole from the batch: all verify');
  const n = w.sim.calls.length;
  const r2 = await watchTick(g.ctx, g.keys.guardian);
  assert.deepEqual(r2.errors, []);
  const calls = w.sim.calls.slice(n).filter((c) => c.method === 'eth_call');
  const ds = new Set(w.launches.map((L) => L.D));
  assert.deepEqual(calls.filter((c) => ds.has(String(c.params[0].to).toLowerCase())).map((c) => c.params[0].data.slice(0, 10)), [], 'no root read on its own');
  assert.equal(calls.filter((c) => String(c.params[0].to).toLowerCase() === MULTICALL3).length, 2, 'one request per provider for all 12');
  assert.ok(!alertKeys(g).some((x) => x.startsWith('multicall-missing')), js(alertKeys(g)));
});

test('readRootsMany: whole roots from the batch, anything else read on its own, and every root without Multicall3', async () => {
  const w = opsWorld({ launches: 5 });
  const k = w.make('keeper');
  w.pass(3601);
  await tick(w, k);
  const r = new ChainReader(w.sim.rpc('x'));
  const ds = w.launches.map((L) => L.D);
  const odd = [WETH, '0x00000000000000000000000000000000000c0de9']; // other code; no code
  w.sim.withoutMulticall3();
  const plain = await readRootsMany(r, [...ds, ...odd], w.sim.latest);
  assert.equal(plain.batched, false, 'no Multicall3: every root read on its own');
  w.sim.withMulticall3();
  const n = w.sim.calls.length;
  const many = await readRootsMany(r, [...ds, ...odd], w.sim.latest, 2);
  assert.equal(many.batched, true);
  const calls = w.sim.calls.slice(n).filter((c) => c.method === 'eth_call');
  assert.equal(calls.filter((c) => String(c.params[0].to).toLowerCase() === MULTICALL3).length, 4, '7 distributors, 2 per request');
  assert.deepEqual(calls.filter((c) => ds.includes(String(c.params[0].to).toLowerCase())), [], 'whole roots are not read again');
  for (const d of ds) {
    assert.deepEqual(js(many.roots.get(d)), js(plain.roots.get(d)));
    assert.equal(many.roots.get(d)!.pending.epoch, 1n);
    assert.notEqual(many.roots.get(d)!.pending.payableAt, 0n);
  }
  for (const x of odd) {
    assert.ok(!many.roots.has(x) && many.errors.has(x), `${x}: not a root, read on its own and failed`);
    assert.ok(calls.some((c) => String(c.params[0].to).toLowerCase() === x), `${x} was read on its own`);
  }
});

test("the checks have their own budget: a slow start of the pass does not use it up", { timeout: 60_000 }, async () => {
  const w = opsWorld({ config: (c) => Object.assign(c.guardian, { checkTimeoutSec: 1, passTimeoutSec: 2 }) });
  const L = w.launches[0];
  const f = forger(w);
  w.pass(3601);
  await tick(w, f);
  let slowed = false;
  const slow = (label: string) => ({
    label,
    async request(a: { method: string; params?: unknown[] }) {
      const p = (a.params ?? []) as any[];
      if (!slowed && a.method === 'eth_getLogs' && String(p[0]?.address).toLowerCase() === w.sim.addr.graduator) {
        slowed = true;
        await wait(2200); // the discovery takes longer than the whole check budget
      }
      return w.sim.rpc(label).request(a);
    },
  });
  const g = w.make('guardian', { rpcs: [slow('a'), w.sim.rpc('b')] });
  const rep = await watchTick(g.ctx, g.keys.guardian);
  assert.ok(slowed);
  assert.equal(rep.unchecked, 0, js(rep));
  assert.equal(rep.results[0]?.verdict, 'mismatch', js(rep.results));
  assert.equal(rep.vetoed.length, 1);
  assert.equal(w.sim.launch(L.D).pending.payableAt, 0n);
});

test('copies that never finish arriving: each check ends at its deadline, and a root the pass had no time for is not vetoed - in its last minutes the guardian freezes instead', { timeout: 60_000 }, async () => {
  const w = opsWorld({ launches: 3, config: (c) => Object.assign(c.guardian, { checkTimeoutSec: 1, passTimeoutSec: 2 }) });
  const sites = w.launches.map((L, i) => craft(w, L, `stalled ${i}`).site);
  w.pass(3600 - 800);
  const g = guardianWith(w, (inner) => (async (u: any, init: any) => (sites.includes(String(u)) || String(u).startsWith('https://gw.test/') ? stalled() : inner(u, init))) as typeof fetch);
  const t0 = Date.now();
  const rep = await watchTick(g.ctx, g.keys.guardian);
  assert.ok(Date.now() - t0 < 15_000, 'the pass ended at its deadline');
  assert.equal(rep.results.length, 2, js(rep.results));
  assert.ok(rep.results.every((r) => r.verdict === 'unverifiable'));
  assert.match(rep.results[0].problems[0], /not checked within 1 s \(guardian\.checkTimeoutSec\)/);
  assert.equal(rep.unchecked, 1);
  const [A, B, C] = w.launches;
  assert.deepEqual(rep.vetoed.map((v) => v.d).sort(), [A.D, B.D].sort(), 'the two roots checked (and unverifiable, late) are vetoed');
  assert.notEqual(w.sim.launch(C.D).pending.payableAt, 0n, 'the root it had no time for is NOT vetoed');
  assert.ok(rep.froze, js(rep));
  assert.equal(w.sim.state.factory.frozen, true, 'it froze instead: the root is held until it is checked');
  const a = g.ctx.alerts.raised.find((x) => x.key === 'guardian-behind:late');
  assert.ok(a, js(alertKeys(g)));
  assert.equal(a!.severity, 'page');
  assert.equal(rep.ok, false, 'a pass past its deadline is not clean');
  assert.match(rep.errors.join(' '), /ran past its 2 s deadline .*1 root\(s\) not checked/);
});

test('a root the pass had no time for, with most of its hour left: neither vetoed nor frozen', { timeout: 60_000 }, async () => {
  const w = opsWorld({ launches: 3, config: (c) => Object.assign(c.guardian, { checkTimeoutSec: 1, passTimeoutSec: 2 }) });
  const sites = w.launches.map((L, i) => craft(w, L, `stalled ${i}`).site);
  const g = guardianWith(w, (inner) => (async (u: any, init: any) => (sites.includes(String(u)) || String(u).startsWith('https://gw.test/') ? stalled() : inner(u, init))) as typeof fetch);
  const rep = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(rep.unchecked, 1, js(rep));
  assert.equal(rep.vetoed.length, 0);
  assert.equal(rep.froze, null);
  assert.equal(g.ctx.alerts.raised.find((x) => x.key === 'guardian-behind')?.severity, 'warn', js(alertKeys(g)));
});

// ---------------------------------------------------------------- N2: many at once

test('a third wrong root at once: the guardian freezes first, then vetoes it', async () => {
  const w = opsWorld({ launches: 3 });
  const f = forger(w);
  w.pass(3601);
  assert.equal((await tick(w, f)).published.length, 3);
  const g = w.make('guardian');
  w.pass(60);
  const from = w.sim.txs.size;
  const rep = await watchTick(g.ctx, g.keys.guardian);
  assert.deepEqual(rep.results.map((x) => x.verdict), ['mismatch', 'mismatch', 'mismatch'], js(rep.results));
  assert.equal(rep.vetoed.length, 3, js(rep));
  assert.ok(rep.froze, 'frozen at the third');
  assert.deepEqual(factoryTxs(w, from).map((t) => fnOf(w, t.hash)), ['veto', 'veto', 'freeze', 'veto'], 'one by one, then the freeze before the third veto');
  assert.ok(alertKeys(g).includes('many-bad'), js(alertKeys(g)));
  assert.match(g.ctx.alerts.raised.find((a) => a.key.startsWith('froze:'))!.text, /3 pending roots to veto at once/);
  for (const L of w.launches) assert.equal(w.sim.launch(L.D).pending.payableAt, 0n);
});

test('unverifiable roots are vetoed after the grace, long before the last minutes, and together in one vetoMany', async () => {
  const w = opsWorld({ launches: 3 });
  const k = w.make('keeper');
  w.pass(3601);
  assert.equal((await tick(w, k)).published.length, 3);
  w.net.siteDown = true;
  w.net.gatewayDown = true;
  const g = w.make('guardian');
  const r1 = await watchTick(g.ctx, g.keys.guardian);
  assert.ok(r1.results.length === 3 && r1.results.every((x) => x.verdict === 'unverifiable'), js(r1.results));
  assert.equal(r1.vetoed.length, 0, 'not inside the grace');
  w.pass(500);
  const r2 = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(r2.vetoed.length, 0, 'still inside the grace (600 s from the first verdict)');
  w.pass(200);
  const from = w.sim.txs.size;
  const r3 = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(r3.vetoed.length, 3, js(r3));
  const txs = factoryTxs(w, from);
  assert.deepEqual(txs.map((t) => fnOf(w, t.hash)), ['freeze', 'vetoMany'], 'three to veto at once: frozen first, then one vetoMany');
  assert.ok(r3.vetoed.every((v) => v.tx === txs[1].hash && v.reason === REASONS.UNVERIFIED));
  for (const L of w.launches) assert.ok(w.sim.launch(L.D).pending.payableAt === 0n);
  assert.ok(3600 - 700 > 900, 'vetoed with far more than the last 15 minutes left');
});

test('after the grace, without the freeze rule: still one vetoMany, not one veto per root', async () => {
  const w = opsWorld({ launches: 3, config: (c) => (c.guardian.freezeAtBadRoots = 0) });
  const k = w.make('keeper');
  w.pass(3601);
  await tick(w, k);
  w.net.siteDown = true;
  w.net.gatewayDown = true;
  const g = w.make('guardian');
  await watchTick(g.ctx, g.keys.guardian);
  w.pass(700);
  const from = w.sim.txs.size;
  const rep = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(rep.vetoed.length, 3, js(rep));
  assert.deepEqual(factoryTxs(w, from).map((t) => fnOf(w, t.hash)), ['vetoMany']);
  assert.equal(rep.froze, null);
});

test('the grace runs from the first time the guardian found the root unverifiable', async () => {
  const w = opsWorld();
  const k = w.make('keeper');
  w.pass(3601);
  await tick(w, k);
  w.net.siteDown = true;
  w.net.gatewayDown = true;
  w.pass(700); // the root is 700 s old when this guardian first looks
  const g = w.make('guardian');
  const r1 = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(r1.results[0].verdict, 'unverifiable');
  assert.equal(r1.vetoed.length, 0, 'its own first verdict starts the grace');
  w.pass(610);
  const r2 = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(r2.vetoed.length, 1, js(r2));
});

test('a vetoMany names only roots still pending: one somebody vetoed just before is left out', async () => {
  const w = opsWorld({ launches: 3, config: (c) => (c.guardian.freezeAtBadRoots = 0) });
  const [A, B, C] = w.launches;
  const f = forger(w);
  w.pass(3601);
  await tick(w, f);
  const g = w.make('guardian');
  w.sim.baseFee = 200_000_000_000n; // the guardian's cap: all three owed
  const r1 = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(r1.vetoed.length, 0);
  assert.equal(Object.keys(g.ctx.store.get<Record<string, unknown>>('owedVetoes', {})).length, 3);
  w.sim.baseFee = 5_000_000n;
  const veto = encodeFunctionData({ abi: opsFactoryAbi, functionName: 'veto', args: [B.D as `0x${string}`, 1, `0x${'11'.repeat(32)}`] });
  assert.ok(w.sim.userTx(w.sim.state.factory.owner, w.sim.addr.factory, veto).ok, 'a Safe vetoes B');
  w.pass(60);
  const from = w.sim.txs.size;
  const r2 = await watchTick(g.ctx, g.keys.guardian);
  const txs = factoryTxs(w, from);
  assert.deepEqual(txs.map((t) => [fnOf(w, t.hash), t.status]), [['vetoMany', true]], 'one batch, not reverted, no single vetoes after it');
  assert.deepEqual(r2.vetoed.map((v) => v.d).sort(), [A.D, C.D].sort());
});

test('an owed veto goes out at the start of the next pass, before any root is checked', async () => {
  const w = opsWorld({ launches: 2 });
  const [A, B] = w.launches;
  let site = '';
  let aVetoedWhenBChecked: boolean | null = null;
  const g = guardianWith(w, (inner) => (async (u: any, init: any) => {
    if (site && String(u) === site && aVetoedWhenBChecked === null) aVetoedWhenBChecked = w.sim.launch(A.D).pending.payableAt === 0n;
    return inner(u, init);
  }) as typeof fetch);
  craft(w, A, 'a');
  w.pass(3600 - 800); // A late: owed as unverifiable
  w.sim.baseFee = 200_000_000_000n;
  const r1 = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(r1.vetoed.length, 0);
  assert.equal(Object.keys(g.ctx.store.get<Record<string, unknown>>('owedVetoes', {})).length, 1);
  w.sim.baseFee = 5_000_000n;
  site = craft(w, B, 'b').site;
  w.pass(60);
  const r2 = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(aVetoedWhenBChecked, true, "A's owed veto was on chain before B's copies were fetched");
  assert.ok(r2.vetoed.some((v) => v.d === A.D), js(r2));
});

// ---------------------------------------------------------------- N4: abandoned checks

test('an abandoned check stops reading at its deadline', { timeout: 60_000 }, async () => {
  const w = opsWorld({ config: (c) => Object.assign(c.guardian, { checkTimeoutSec: 1, passTimeoutSec: 2 }) });
  const k = w.make('keeper');
  w.pass(3601);
  await tick(w, k);
  let done = false;
  let after = 0;
  const slow = (label: string) => ({
    label,
    async request(a: { method: string; params?: unknown[] }) {
      if (done) after++;
      const p = (a.params ?? []) as any[];
      if (a.method === 'eth_getLogs' && [p[0]?.topics?.[0]].flat().includes(TOPICS.Transfer)) await wait(1500); // the recompute's replay, past the deadline
      return w.sim.rpc(label).request(a);
    },
  });
  const g = w.make('guardian', { rpcs: [slow('a'), slow('b')] });
  const rep = await watchTick(g.ctx, g.keys.guardian);
  done = true;
  assert.equal(rep.results[0]?.verdict, 'unverifiable', js(rep.results));
  assert.match(rep.results[0].problems[0], /not checked within 1 s/);
  await wait(2500);
  assert.equal(after, 0, 'nothing was read after the pass ended: the abandoned recompute stopped at its next read');
});

test('a root whose abandoned check is still running is not checked again', { timeout: 60_000 }, async () => {
  const w = opsWorld({ config: (c) => Object.assign(c.guardian, { checkTimeoutSec: 1, passTimeoutSec: 2 }) });
  const k = w.make('keeper');
  w.pass(3601);
  await tick(w, k);
  const g = w.make('guardian');
  const files = g.ctx.files as any;
  const plain = files.checkAll.bind(files);
  let calls = 0;
  // a check that does not stop when told to (a read in no reader's hands)
  files.checkAll = (d: string, e: bigint, h: string, u: string) => {
    calls++;
    return wait(2500).then(() => plain(d, e, h, u));
  };
  const r1 = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(r1.results[0].verdict, 'unverifiable', js(r1.results));
  const r2 = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(calls, 1, 'not started again while the first still runs');
  assert.match(r2.results[0]?.problems[0] ?? '', /still running/, js(r2.results));
  await wait(3000);
  files.checkAll = plain;
  const r3 = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(r3.results[0]?.verdict, 'ok', 'checked again once it ended');
});

test('an active root whose abandoned check is still running is not checked again either', { timeout: 60_000 }, async () => {
  const w = opsWorld({ config: (c) => Object.assign(c.guardian, { checkTimeoutSec: 1, passTimeoutSec: 2 }) });
  const k = w.make('keeper');
  w.pass(3601);
  await tick(w, k);
  w.pass(3601);
  await tick(w, k); // activated: the guardian first meets it as the root in force
  assert.equal(w.sim.launch(w.launches[0].D).active.epoch, 1);
  const g = w.make('guardian');
  const files = g.ctx.files as any;
  const plain = files.checkAll.bind(files);
  let calls = 0;
  files.checkAll = (d: string, e: bigint, h: string, u: string) => {
    calls++;
    return wait(2500).then(() => plain(d, e, h, u));
  };
  const r1 = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(r1.results[0]?.verdict, 'unverifiable', js(r1.results));
  const r2 = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(calls, 1, 'not started again while the first still runs');
  assert.deepEqual(r2.results, [], 'its stored verdict stands');
  await wait(3000);
  files.checkAll = plain;
  const r3 = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(r3.results[0]?.verdict, 'ok', 'checked again once it ended');
});

// ---------------------------------------------------------------- finding 9: an announced unfreeze

test('frozen with an unfreeze announced: a malicious root is vetoed AND frozen again, which cancels the unfreeze', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  const k = w.make('keeper', { signers: { publisher: crashing(w.signers.publisher, (tx) => tx.to === w.sim.addr.factory), pusher: w.signers.pusher } });
  w.pass(3601);
  await tick(w, k); // the file is published (site + IPFS), the root is not
  const bytes = w.net.repo.get(`sharing/8453/${L.D}/1.json`)!.bytes;
  const f = JSON.parse(new TextDecoder().decode(bytes));
  const root = { merkleRoot: '0x' + '66'.repeat(32), contentHash: sha256Hex(bytes), cumHolders0: BigInt(f.accounts.reduce((x: bigint, a: any) => x + BigInt(a.cum0), 0n)), cumHolders1: 0n, cumKeeper0: BigInt(f.keeper.fee), fromBlock: BigInt(f.window.fromBlock), toBlock: BigInt(f.window.toBlock), epoch: 1, payableAt: 0 };
  assert.ok(w.sim.userTx(w.signers.publisher.address, w.sim.addr.factory, encodeFunctionData({ abi: opsFactoryAbi, functionName: 'publishMany', args: [[L.D as `0x${string}`], [root as any], [`ipfs://${fileCid(bytes)}`]] as any })).ok);
  assert.ok(w.sim.userTx(w.sim.state.factory.owner, w.sim.addr.factory, encodeFunctionData({ abi: opsFactoryAbi, functionName: 'freeze' })).ok);
  w.sim.state.factory.pendingUnfreezeAt = w.sim.state.ts + 48n * 3600n; // the owner announced an unfreeze
  w.sim.snaps.set(w.sim.latest, structuredClone(w.sim.state));
  const g = w.make('guardian');
  const rep = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(rep.results[0].reason, REASONS.INVALID, js(rep.results));
  assert.equal(rep.vetoed.length, 1);
  assert.ok(rep.froze, 'frozen already is not enough while an unfreeze is announced');
  assert.equal(w.sim.state.factory.pendingUnfreezeAt, 0n, 'the unfreeze is cancelled');
  assert.equal(w.sim.state.factory.frozen, true);
  assert.match(g.ctx.alerts.raised.find((a) => a.key.startsWith('froze:'))!.text, /cancelled that unfreeze/);
});
