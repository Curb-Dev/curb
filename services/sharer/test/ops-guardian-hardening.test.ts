// The guardian against a publisher who makes checking slow, and against its
// own bad luck (audit findings 3, 5, 6, 19, 21):
//   - pending roots are checked first, the one whose hour ends first first,
//     and each veto goes out the moment its verdict is known, decided on a
//     fresh head;
//   - one root's check and one pass have deadlines: copies that never
//     finish arriving make a root unverifiable, never a hung guardian
//     (ops-guardian-scale.test.ts: what happens to a root the pass had no
//     time for);
//   - the work comes from the chain's state on every provider; nothing scans
//     a launch's history; a provider that hides a root or its event pages;
//   - a veto that does not land (gas above the cap, a batch that reverts) is
//     owed and sent again; one somebody else already sent is dropped;
//   - only RECOMPUTE and INVALID vetoes count toward the freeze on a repeat.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, encodeFunctionData, encodeFunctionResult, keccak256, toHex } from 'viem';
import { opsWorld } from './sim/world.ts';
import { tick, js, lying, lyingCall, alertKeys } from './sim/helpers.ts';
import { watchTick, REASONS } from '../src/ops/verify.ts';
import { opsDistributorAbi, opsFactoryAbi } from '../src/ops/abis.ts';
import { distributorAbi, TOPICS } from '../src/chain/abis.ts';
import { fileCid } from '../src/ops/cid.ts';
import { writeAck } from '../src/ops/acks.ts';

type W = ReturnType<typeof opsWorld>;
const THIEF = '0x00000000000000000000000000000000000bad01';

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
 *  file nobody serves: its URI names bytes that exist nowhere. */
function craft(w: W, L: W['launches'][number], tag: string): { uri: string; site: string } {
  // the income it allocates must be in the distributor: anybody may harvest
  assert.ok(w.sim.userTx(THIEF, L.D, encodeFunctionData({ abi: opsDistributorAbi, functionName: 'harvest' })).ok, 'harvest');
  const s = w.sim.launch(L.D);
  const uri = `ipfs://${fileCid(new TextEncoder().encode(`no such file: ${tag}`))}`;
  const root = { merkleRoot: keccak256(toHex(`root ${tag}`)), contentHash: keccak256(toHex(`content ${tag}`)), cumHolders0: s.active.cumHolders0 + 1n, cumHolders1: s.active.cumHolders1, cumKeeper0: s.active.cumKeeper0, fromBlock: s.active.epoch === 0 ? L.sharingSince : s.active.toBlock + 1n, toBlock: w.sim.latest, epoch: s.lastProposed + 1, payableAt: 0 };
  const data = encodeFunctionData({ abi: opsFactoryAbi, functionName: 'publishMany', args: [[L.D as `0x${string}`], [root as any], [uri]] as any });
  assert.ok(w.sim.userTx(w.signers.publisher.address, w.sim.addr.factory, data).ok, `publish ${tag}`);
  return { uri, site: `https://site.test/sharing/8453/${L.D}/${root.epoch}.json` };
}

/** Builds a guardian whose network goes through `wrap` (the keepers made
 *  before keep the plain one). */
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

const fnOf = (w: W, tx: string) => decodeFunctionData({ abi: opsFactoryAbi, data: w.sim.txs.get(tx)!.input as `0x${string}` }).functionName;

// ---------------------------------------------------------------- order, timing

test('pending roots are checked first, the one whose hour ends first first', async () => {
  const w = opsWorld({ launches: 2 });
  const [A, B] = w.launches;
  w.pass(60);
  craft(w, B, 'b'); // B's hour ends first
  w.pass(100);
  craft(w, A, 'a');
  const g = w.make('guardian');
  const rep = await watchTick(g.ctx, g.keys.guardian);
  assert.deepEqual(rep.results.map((r) => r.distributor), [B.D, A.D], js(rep.results.map((r) => [r.distributor, r.verdict])));
  assert.ok(rep.results.every((r) => r.reason === REASONS.UNAVAILABLE));
  // nothing served at all: a person hears of it at once, not only late in the hour
  assert.equal(g.ctx.alerts.raised.find((a) => a.key === `unverified:${B.D}:1`)?.severity, 'page');
});

test('each veto goes out the moment its root is judged, before the next root is checked', async () => {
  const w = opsWorld({ launches: 2 });
  const [A, B] = w.launches;
  const f = forger(w);
  w.pass(3601);
  const r = await tick(w, f);
  assert.equal(r.published.length, 2, js(r));
  let aVetoedWhenBChecked: boolean | null = null;
  const g = guardianWith(w, (inner) => (async (u: any, init: any) => {
    if (String(u).includes(`/${B.D}/`) && aVetoedWhenBChecked === null) aVetoedWhenBChecked = w.sim.launch(A.D).pending.payableAt === 0n;
    return inner(u, init);
  }) as typeof fetch);
  w.pass(60);
  const rep = await watchTick(g.ctx, g.keys.guardian);
  assert.deepEqual(rep.results.map((x) => x.verdict), ['mismatch', 'mismatch'], js(rep.results));
  assert.equal(aVetoedWhenBChecked, true, "A's veto was on chain before B's copies were fetched");
  assert.equal(rep.vetoed.length, 2);
  assert.deepEqual(rep.vetoed.map((v) => fnOf(w, v.tx)), ['veto', 'veto']);
});

test('the late veto is decided on a fresh head: a check that took minutes counts them', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  const { site } = craft(w, L, 'slow');
  w.pass(3600 - 1000); // 1000 s left as the pass starts: not yet late (900)
  let moved = false;
  const g = guardianWith(w, (inner) => (async (u: any, init: any) => {
    if (String(u) === site && !moved) {
      moved = true;
      w.chainPass(200); // the copies take 200 s to fail
    }
    return inner(u, init);
  }) as typeof fetch);
  const rep = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(rep.results[0].verdict, 'unverifiable');
  assert.equal(rep.vetoed.length, 1, `800 s were left when it was judged: ${js(rep)}`);
  assert.equal(rep.vetoed[0].reason, REASONS.UNVERIFIED);
  assert.equal(w.sim.launch(L.D).pending.payableAt, 0n);
});

// ---------------------------------------------------------------- the work, from the chain

test("a pass reads no launch's history: the RootPublished of a root is looked up in its own block", async () => {
  const w = opsWorld();
  const L = w.launches[0];
  const k = w.make('keeper');
  w.sim.mineMany(300); // a long history before the epoch
  w.pass(3601);
  await tick(w, k);
  const g = w.make('guardian');
  const n = w.sim.calls.length;
  const rep = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(rep.results[0]?.verdict, 'ok', js(rep.results));
  const scans = w.sim.calls.slice(n).filter((c) => c.method === 'eth_getLogs' && String(c.params[0].address).toLowerCase() === L.D && [c.params[0].topics?.[0]].flat().includes(TOPICS.RootPublished));
  assert.ok(scans.length > 0);
  for (const s of scans) assert.ok(BigInt(s.params[0].toBlock) - BigInt(s.params[0].fromBlock) < 10n, `a scan of ${BigInt(s.params[0].toBlock) - BigInt(s.params[0].fromBlock) + 1n} blocks`);
});

test('a provider that leaves a RootPublished out pages, and the root is vetoed late as unverifiable', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  const k = w.make('keeper');
  w.pass(3601);
  await tick(w, k);
  const hide = lying(w.sim.rpc('a'), 'a', (m, _p, r) => (m === 'eth_getLogs' && Array.isArray(r) ? r.filter((l: any) => l.topics?.[0] !== TOPICS.RootPublished) : r));
  const g = w.make('guardian', { rpcs: [hide, w.sim.rpc('b')] });
  const r1 = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(r1.results[0]?.verdict, 'unverifiable', js(r1.results));
  const a = g.ctx.alerts.raised.find((x) => x.key === `event-unseen:${L.D}:1`);
  assert.ok(a, js(alertKeys(g)));
  assert.equal(a!.severity, 'page');
  assert.match(a!.text, /disagree on the RootPublished of epoch 1 \(a: no event; b: block/);
  assert.equal(r1.vetoed.length, 0, 'not with most of the hour left');
  w.pass(3600 - 800);
  const r2 = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(r2.vetoed.length, 1, js(r2));
  assert.equal(r2.vetoed[0].reason, REASONS.UNVERIFIED);
});

test("a provider that hides a pending root: the guardian reads both, pages, and still vetoes it late", async () => {
  const w = opsWorld();
  const L = w.launches[0];
  const k = w.make('keeper');
  w.pass(3601);
  await tick(w, k);
  const sel = encodeFunctionData({ abi: distributorAbi, functionName: 'pending' });
  const none = encodeFunctionResult({ abi: distributorAbi, functionName: 'pending', result: ['0x' + '00'.repeat(32), '0x' + '00'.repeat(32), 0n, 0n, 0n, 0n, 0n, 0, 0] as any });
  // in its Multicall3 batches too, where the guardian reads every root
  const hide = lyingCall(w.sim.rpc('a'), 'a', L.D, sel, none);
  const g = w.make('guardian', { rpcs: [hide, w.sim.rpc('b')] });
  const r1 = await watchTick(g.ctx, g.keys.guardian);
  assert.ok(alertKeys(g).includes(`roots-disagree:${L.D}`), js(alertKeys(g)));
  assert.equal(r1.results[0]?.verdict, 'unverifiable', js(r1.results));
  w.pass(3600 - 800);
  const r2 = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(r2.vetoed.length, 1, js(r2));
  assert.equal(w.sim.launch(L.D).pending.payableAt, 0n);
});

test('a distributor one provider leaves out of the discovery is still watched', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  const k = w.make('keeper');
  w.pass(3601);
  await tick(w, k);
  const hide = lying(w.sim.rpc('a'), 'a', (m, _p, r) => (m === 'eth_getLogs' && Array.isArray(r) ? r.filter((l: any) => l.topics?.[0] !== TOPICS.HolderSharingEnabled) : r));
  const g = w.make('guardian', { rpcs: [hide, w.sim.rpc('b')] });
  const rep = await watchTick(g.ctx, g.keys.guardian);
  assert.ok(rep.results.some((r) => r.distributor === L.D && r.epoch === 1n), js(rep.results));
});

// ---------------------------------------------------------------- owed vetoes

test('a veto refused by the gas cap is owed, and the next pass sends it', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  const f = forger(w);
  w.pass(3601);
  await tick(w, f);
  const g = w.make('guardian');
  w.sim.baseFee = 200_000_000_000n; // 200 gwei: above the guardian's own cap
  const r1 = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(r1.results[0].verdict, 'mismatch');
  assert.equal(r1.vetoed.length, 0);
  assert.equal(r1.ok, false);
  assert.ok(alertKeys(g).some((x) => x.startsWith('veto-failed:')), js(alertKeys(g)));
  assert.notEqual(w.sim.launch(L.D).pending.payableAt, 0n);
  w.sim.baseFee = 5_000_000n;
  w.pass(60);
  const r2 = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(r2.results.length, 0, 'judged once');
  assert.equal(r2.vetoed.length, 1, js(r2));
  assert.equal(w.sim.launch(L.D).pending.payableAt, 0n, 'vetoed on chain');
  assert.equal(r2.ok, true, js(r2.errors));
});

test("the guardian's gas cap is its own: a veto lands at a gas price the keeper keys refuse", async () => {
  const w = opsWorld();
  const L = w.launches[0];
  const f = forger(w);
  w.pass(3601);
  await tick(w, f);
  const g = w.make('guardian');
  w.sim.baseFee = 2_000_000_000n; // 2 gwei: above keeper.maxGasPriceWei (1 gwei)
  const rep = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(rep.vetoed.length, 1, js(rep));
  assert.equal(w.sim.launch(L.D).pending.payableAt, 0n);
});

test('a vetoMany that is mined and REVERTS is no success: one veto per root follows', async () => {
  const w = opsWorld({ launches: 2 });
  const [A, B] = w.launches;
  const f = forger(w);
  w.pass(3601);
  await tick(w, f);
  const g = w.make('guardian');
  w.sim.baseFee = 200_000_000_000n;
  const r1 = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(r1.vetoed.length, 0);
  const many = encodeFunctionData({ abi: opsFactoryAbi, functionName: 'vetoMany', args: [[], [], `0x${'00'.repeat(32)}`] }).slice(0, 10);
  w.sim.failOnChain = (_to, data) => data.startsWith(many);
  w.sim.baseFee = 5_000_000n;
  w.pass(60);
  const before = w.sim.txs.size;
  const r2 = await watchTick(g.ctx, g.keys.guardian);
  const mined = [...w.sim.txs.values()].slice(before);
  const batch = mined.find((t) => t.input.startsWith(many));
  assert.ok(batch, 'the owed vetoes went out together first');
  assert.equal(batch!.status, false, 'and that batch reverted on chain');
  assert.ok(!r2.vetoed.some((v) => v.tx === batch!.hash), 'a reverted receipt is never recorded as a veto');
  assert.equal(r2.vetoed.length, 2, js(r2));
  assert.deepEqual(r2.vetoed.map((v) => fnOf(w, v.tx)), ['veto', 'veto']);
  for (const L of [A, B]) assert.equal(w.sim.launch(L.D).pending.payableAt, 0n);
});

test('an owed veto whose root somebody else vetoed is dropped: nothing is sent', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  const f = forger(w);
  w.pass(3601);
  await tick(w, f);
  const g = w.make('guardian');
  w.sim.baseFee = 200_000_000_000n;
  await watchTick(g.ctx, g.keys.guardian); // owed
  w.sim.baseFee = 5_000_000n;
  const veto = encodeFunctionData({ abi: opsFactoryAbi, functionName: 'veto', args: [L.D as `0x${string}`, 1, `0x${'11'.repeat(32)}`] });
  assert.ok(w.sim.userTx(w.sim.state.factory.owner, w.sim.addr.factory, veto).ok, 'a Safe vetoes it');
  w.pass(60);
  const n = w.sim.calls.length;
  const r2 = await watchTick(g.ctx, g.keys.guardian);
  assert.deepEqual(w.sim.calls.slice(n).filter((c) => c.method === 'eth_estimateGas'), [], 're-read before sending: not even simulated');
  assert.deepEqual(r2.errors, []);
  assert.deepEqual(Object.keys(g.ctx.store.get<Record<string, unknown>>('owedVetoes', {})), []);
});

test('an owed veto whose hour ran out pages that it did not land', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  const f = forger(w);
  w.pass(3601);
  await tick(w, f);
  const g = w.make('guardian');
  w.sim.baseFee = 200_000_000_000n;
  await watchTick(g.ctx, g.keys.guardian);
  w.pass(3700); // the hour is over, the root still pending (nobody activated it)
  w.sim.baseFee = 5_000_000n;
  await watchTick(g.ctx, g.keys.guardian);
  const a = g.ctx.alerts.raised.find((x) => x.key === `veto-missed:${L.D}:1`);
  assert.ok(a, js(alertKeys(g)));
  assert.equal(a!.severity, 'page');
  assert.deepEqual(Object.keys(g.ctx.store.get<Record<string, unknown>>('owedVetoes', {})), []);
});

test('an owed freeze is sent on the next pass', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  const f = forger(w);
  const g = w.make('guardian');
  w.pass(3601);
  await tick(w, f);
  await watchTick(g.ctx, g.keys.guardian); // veto #1
  await writeAck(f.ctx, { distributor: L.D, epoch: '1', by: 'thief', at: 'now' });
  w.pass(3700);
  assert.equal((await tick(w, f)).published.length, 1);
  w.pass(60);
  w.sim.baseFee = 200_000_000_000n;
  const r1 = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(r1.froze, null);
  assert.ok(alertKeys(g).includes('freeze-failed'), js(alertKeys(g)));
  assert.equal(w.sim.state.factory.frozen, false);
  w.sim.baseFee = 5_000_000n;
  w.pass(60);
  const r2 = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(r2.vetoed.length, 1, 'the owed veto');
  assert.ok(r2.froze, 'and the owed freeze');
  assert.equal(w.sim.state.factory.frozen, true);
});

// ---------------------------------------------------------------- the repeat rule

test('an earlier UNVERIFIED veto does not count toward the repeat: a later mismatch is vetoed, not frozen', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  const k = w.make('keeper');
  const g = w.make('guardian');
  w.pass(3601);
  await tick(w, k); // epoch 1 pending, honest
  w.net.siteDown = true;
  w.net.gatewayDown = true;
  w.pass(3600 - 800);
  const r1 = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(r1.vetoed[0]?.reason, REASONS.UNVERIFIED, js(r1));
  w.net.siteDown = false;
  w.net.gatewayDown = false;
  const f = forger(w);
  await writeAck(f.ctx, { distributor: L.D, epoch: '1', by: 'op', at: 'now' });
  w.pass(3700);
  const r2 = await tick(w, f);
  assert.equal(r2.published.length, 1, js(r2));
  w.pass(60);
  const rep = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(rep.vetoed.length, 1, js(rep));
  assert.equal(rep.vetoed[0].reason, REASONS.RECOMPUTE);
  assert.equal(rep.froze, null, 'an availability veto is not a repeat');
  assert.equal(w.sim.state.factory.frozen, false);
});
