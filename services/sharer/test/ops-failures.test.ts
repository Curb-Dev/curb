// Failure injection for the keeper (design D.2.8): RPC disagreement, pin and
// site failures, a stuck transaction replaced at the same nonce, a crash
// between harvest and publish, a partial push resumed, a veto that waits for
// an operator, a frozen factory (activate() reverting Frozen), and a key out
// of ETH. Each test asserts what the CHAIN and the DATA REPO show afterwards,
// not only what the keeper says.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, encodeFunctionResult, parseAbi, parseTransaction, stringToHex } from 'viem';
import { opsWorld, HOLDERS, testKey } from './sim/world.ts';
import { tick, js, lying, crashing, alertKeys } from './sim/helpers.ts';
import { parseEpochFile } from '../src/calc/file.ts';
import { sha256Hex } from '../src/calc/encoding.ts';
import { writeAck } from '../src/ops/acks.ts';
import { Store } from '../src/ops/store.ts';
import { opsFactoryAbi } from '../src/ops/abis.ts';
import { keySigner } from '../src/ops/tx.ts';

const sentTo = (w: ReturnType<typeof opsWorld>, to: string) => [...w.sim.txs.values()].filter((t) => t.to === to.toLowerCase());

test('RPC disagreement on the epoch inputs: nothing is written, nothing is published, an operator is paged', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  // provider b drops the token's last Transfer log
  const b = lying(w.sim.rpc('b'), 'b', (m, p, r) => {
    if (m === 'eth_getLogs' && String(p[0].address).toLowerCase() === L.token && Array.isArray(r) && r.length) return r.slice(0, -1);
    return r;
  });
  const k = w.make('keeper', { rpcs: [w.sim.rpc('a'), b] });
  w.pass(3601);
  const r = await tick(w, k);
  assert.equal(r.published.length, 0);
  assert.ok(!r.ok);
  assert.ok(alertKeys(k).includes('rpc-disagreement'), js(alertKeys(k)));
  assert.equal(w.sim.launch(L.D).pending.epoch, 0, 'nothing on chain');
  assert.ok(![...w.net.repo.keys()].some((p) => p.endsWith('/1.json')), 'no epoch file written');
  assert.equal(sentTo(w, w.sim.addr.factory).length, 0, 'no publishMany sent');
});

test('RPC disagreement on the distributor state: the tick aborts before ANY transaction', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  const sel = encodeFunctionData({ abi: parseAbi(['function received0() view returns (uint256)']), functionName: 'received0' });
  const b = lying(w.sim.rpc('b'), 'b', (m, p, r) => (m === 'eth_call' && p[0].to?.toLowerCase() === L.D && p[0].data === sel ? encodeFunctionResult({ abi: parseAbi(['function received0() view returns (uint256)']), functionName: 'received0', result: 1n }) : r));
  const k = w.make('keeper', { rpcs: [w.sim.rpc('a'), b] });
  w.pass(3601);
  const before = w.sim.sent.length;
  const r = await tick(w, k);
  assert.ok(!r.ok);
  assert.ok(alertKeys(k).includes('rpc-disagreement'));
  assert.equal(w.sim.sent.length, before, 'not even a harvest was sent');
});

for (const [name, fault, why] of [
  ['kubo is down (one pin of the two needed)', (w: ReturnType<typeof opsWorld>) => (w.net.kuboDown = true), /1 of the 2 pins/],
  ['pinata stores it under another CID', (w: ReturnType<typeof opsWorld>) => (w.net.pinataWrongCid = true), /1 of the 2 pins/],
  ['the site is down', (w: ReturnType<typeof opsWorld>) => (w.net.siteDown = true), /read back/],
  ['the site serves other bytes', (w: ReturnType<typeof opsWorld>) => (w.net.siteTamper = (_p, b) => new Uint8Array([...b, 32])), /site serves other bytes/],
  ['every gateway serves other bytes', (w: ReturnType<typeof opsWorld>) => (w.net.gatewayTamper = true), /gateway .* serves other bytes/],
  ['the gateway is down', (w: ReturnType<typeof opsWorld>) => (w.net.gatewayDown = true), /read back/],
  ['the data repo refuses the epoch file', (w: ReturnType<typeof opsWorld>) => (w.net.refuseWrites = /^sharing\/8453\/0x/), /data repo/],
] as const) {
  test(`publishing failure - ${name}: publishMany is never sent`, async () => {
    const w = opsWorld();
    const k = w.make('keeper');
    w.pass(3601);
    fault(w);
    const r = await tick(w, k);
    assert.equal(r.published.length, 0);
    assert.equal(sentTo(w, w.sim.addr.factory).length, 0, 'no publishMany');
    assert.equal(w.sim.launch(w.launches[0].D).pending.epoch, 0);
    assert.ok(r.errors.some((e) => why.test(e)), js(r.errors));
    assert.ok(alertKeys(k).some((x) => x.startsWith('publish-failed:')));
  });
}

test('a stuck transaction is replaced at the SAME nonce; the replaced hash never counts in the keeper fee', async () => {
  const w = opsWorld();
  const k = w.make('keeper');
  const L = w.launches[0];
  w.pass(3601);
  // the first harvest sits in the mempool: its tip is the market's, which this block builder ignores
  const firstTip = w.sim.tip;
  w.sim.stuck = (t) => t.to === L.D && t.tip <= firstTip;
  const r = await tick(w, k);
  assert.deepEqual(r.errors, []);
  assert.equal(r.published.length, 1);
  const j = k.ctx.store.get<Record<string, any[]>>('txJournal', {})[w.signers.pusher.address];
  const h = j.find((e: any) => e.label.startsWith('harvest'));
  assert.ok(h.sends.length >= 2, 'replaced at least once');
  const nonces = new Set(h.sends.map((s: any) => s.raw).map((raw: string) => Number(parseTransaction(raw as `0x${string}`).nonce)));
  assert.deepEqual([...nonces], [h.nonce], 'every send used the same nonce');
  const mined = h.sends.filter((s: any) => w.sim.txs.has(s.hash));
  assert.equal(mined.length, 1, 'exactly one of the sends landed');
  assert.equal(mined[0].hash, h.done.hash);
  assert.ok(BigInt(h.sends[1].maxPriorityFeePerGas) * 100n >= BigInt(h.sends[0].maxPriorityFeePerGas) * 125n, 'fees raised 25%');
  // the next epoch's file lists the mined harvest only
  w.sim.stuck = () => false;
  w.pass(3700);
  await tick(w, k); // activate + push
  w.sim.income(L.D, 10n ** 17n);
  w.pass(3700);
  const r2 = await tick(w, k);
  assert.equal(r2.published.length, 1, js(r2));
  const f1 = parseEpochFile(w.net.repo.get(`sharing/8453/${L.D}/1.json`)!.bytes);
  const listed = f1.keeper.txs.map((t) => t.hash);
  assert.ok(listed.includes(h.done.hash), 'the mined harvest is counted');
  for (const s of h.sends) if (s.hash !== h.done.hash) assert.ok(!listed.includes(s.hash), 'the replaced one is not');
});

test('a keeper transaction that reverted (so logged nothing) counts in the keeper fee: the keeper hands its journal to the epoch', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  let fail = true;
  w.sim.failOnChain = (to, data) => fail && to === L.D && data === '0x4641257d';
  const k = w.make('keeper');
  w.pass(3601);
  const r1 = await tick(w, k);
  assert.equal(r1.published.length, 0);
  const j = k.ctx.store.get<Record<string, any[]>>('txJournal', {})[w.signers.pusher.address];
  const reverted = j.find((e: any) => e.label.startsWith('harvest'))!.done.hash;
  assert.ok(reverted && w.sim.txs.has(reverted), 'the reverted harvest was mined');
  fail = false;
  const r2 = await tick(w, k);
  assert.equal(r2.published.length, 1, js(r2));
  const f1 = parseEpochFile(w.net.repo.get(`sharing/8453/${L.D}/1.json`)!.bytes);
  assert.ok(f1.keeper.txs.some((t) => t.hash === reverted), js(f1.keeper.txs));
});

test('a publish replaced by ANOTHER keeper meanwhile reverts at simulation and is not sent (idempotency)', async () => {
  const w = opsWorld();
  const a = w.make('keeper', { holder: 'a' });
  const b = w.make('keeper', { holder: 'b' });
  w.pass(3601);
  const ra = await tick(w, a);
  assert.equal(ra.published.length, 1);
  // b computes the same epoch from a stale view: its publishMany would revert PendingRoot
  const rb = await tick(w, b);
  assert.equal(rb.published.length, 0);
  assert.equal(sentTo(w, w.sim.addr.factory).length, 1, 'one publishMany on chain');
});

test('a crash between harvest and publish: the restart publishes, an orphan file is never referenced', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  const pub = crashing(w.signers.publisher, (tx) => tx.to === w.sim.addr.factory);
  const k1 = w.make('keeper', { signers: { publisher: pub, pusher: w.signers.pusher } });
  w.pass(3601);
  const r1 = await tick(w, k1);
  assert.equal(r1.published.length, 0);
  assert.ok(r1.errors.some((e) => /CRASH/.test(e)), js(r1.errors));
  const orphan = w.net.repo.get(`sharing/8453/${L.D}/1.json`)!;
  assert.ok(orphan, 'the file was written before the crash');
  assert.equal(w.sim.launch(L.D).pending.epoch, 0, 'nothing on chain');

  // later, a harvest that is no longer fresh: a cold restart harvests again (a later T)
  w.pass(2000);
  const k2 = w.make('keeper', { holder: 'restarted' });
  const r2 = await tick(w, k2);
  assert.deepEqual(r2.errors, []);
  assert.equal(r2.published.length, 1);
  const now = w.net.repo.get(`sharing/8453/${L.D}/1.json`)!;
  assert.notEqual(sha256Hex(now.bytes), sha256Hex(orphan.bytes), 'the orphan was replaced (a later T)');
  assert.equal(w.sim.launch(L.D).pending.contentHash, sha256Hex(now.bytes), 'the chain names the file that is there');
  const harvests = [...w.sim.txs.values()].filter((t) => t.to === L.D && t.input === '0x4641257d');
  assert.equal(harvests.length, 2, 'harvested again');
});

test('a crash right after the harvest: the restart reuses the fresh harvest (same T, same bytes)', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  const pub = crashing(w.signers.publisher, (tx) => tx.to === w.sim.addr.factory);
  const k1 = w.make('keeper', { signers: { publisher: pub, pusher: w.signers.pusher } });
  w.pass(3601);
  await tick(w, k1);
  const orphan = w.net.repo.get(`sharing/8453/${L.D}/1.json`)!;
  const k2 = w.make('keeper', { holder: 'restarted' });
  const r2 = await tick(w, k2);
  assert.equal(r2.published.length, 1);
  assert.equal(sha256Hex(w.net.repo.get(`sharing/8453/${L.D}/1.json`)!.bytes), sha256Hex(orphan.bytes), 'identical bytes');
  assert.equal([...w.sim.txs.values()].filter((t) => t.to === L.D && t.input === '0x4641257d').length, 1, 'one harvest');
});

test('a partial push resumes: what was paid stays paid, the rest is pushed, nobody twice', async () => {
  const w = opsWorld({ config: (c) => (c.keeper.maxLeavesPerPush = 1) });
  const L = w.launches[0];
  let pushes = 0;
  const push = crashing(w.signers.pusher, (tx) => tx.to === L.D && tx.data.startsWith('0x') && tx.data.length > 600 && ++pushes === 2);
  const k1 = w.make('keeper', { signers: { publisher: w.signers.publisher, pusher: push } });
  w.pass(3601);
  await tick(w, k1);
  w.pass(3700);
  const r = await tick(w, k1);
  assert.ok(r.errors.some((e) => /CRASH/.test(e)), js(r));
  const paidAfterCrash = [...w.sim.launch(L.D).paid0.entries()].filter(([, v]) => v > 0n).length;
  assert.equal(paidAfterCrash, 1, 'one batch landed before the crash');
  const k2 = w.make('keeper', { holder: 'restarted' });
  const r2 = await tick(w, k2);
  assert.deepEqual(r2.errors, []);
  const f = parseEpochFile(w.net.repo.get(`sharing/8453/${L.D}/1.json`)!.bytes);
  const s = w.sim.launch(L.D);
  for (const row of f.accounts) if (row.a !== HOLDERS.dust) assert.equal(s.paid0.get(row.a), row.cum0);
  assert.equal(s.totalPaid0, f.accounts.filter((x) => x.a !== HOLDERS.dust).reduce((x, y) => x + y.cum0, 0n), 'nobody paid twice');
});

test('a veto pages an operator; the reopened range is recomputed only after an ack, with supersedes', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  const k = w.make('keeper');
  w.pass(3601);
  const r1 = await tick(w, k);
  assert.equal(r1.published.length, 1);
  // the guardian vetoes epoch 1
  const veto = encodeFunctionData({ abi: opsFactoryAbi, functionName: 'veto', args: [L.D as `0x${string}`, 1, stringToHex('CURB:RECOMPUTE_MISMATCH', { size: 32 })] });
  assert.ok(w.sim.userTx(w.signers.guardian.address, w.sim.addr.factory, veto).ok);
  w.pass(3700);
  const r2 = await tick(w, k);
  assert.equal(r2.published.length, 0, 'not re-proposed automatically');
  assert.ok(alertKeys(k).includes(`veto-ack:${L.D}:1`), js(alertKeys(k)));
  assert.ok(k.ctx.alerts.raised.find((a) => a.key === `veto-ack:${L.D}:1`)!.severity === 'page');
  assert.ok(alertKeys(k).some((x) => x.startsWith('event:') ), 'the RootVetoed event is alerted too');
  // an operator acknowledges it, from another machine: only the data repo has it
  await writeAck({ repo: k.ctx.repo, store: new Store(null) }, { distributor: L.D, epoch: '1', by: 'test', at: 'now' });
  assert.ok(w.net.repo.has('ops/acks.json'), 'the ack is in the data repo for the standby too');
  const r3 = await tick(w, k);
  assert.equal(r3.published.length, 1, js(r3));
  assert.equal(r3.published[0].epoch, 2n);
  const f2 = parseEpochFile(w.net.repo.get(`sharing/8453/${L.D}/2.json`)!.bytes);
  assert.deepEqual(f2.supersedes, [1n]);
  assert.equal(f2.window.fromBlock, w.sim.launch(L.D).sharingSince, 'the vetoed range is offered again');
});

test('frozen: no publish, the ripe root is held (no activate sent), the ACTIVE root keeps being pushed', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  const k = w.make('keeper');
  w.pass(3601);
  await tick(w, k);
  w.pass(3700);
  w.sim.launch(L.D).blocked.add(HOLDERS.bob); // bob's push will be skipped, to leave something to push later
  await tick(w, k); // epoch 1 active, pushed
  assert.equal(w.sim.launch(L.D).active.epoch, 1);
  w.sim.income(L.D, 10n ** 17n);
  w.pass(3700);
  await tick(w, k); // epoch 2 published, pending
  assert.equal(w.sim.launch(L.D).pending.epoch, 2);
  // freeze, then the hour passes
  assert.ok(w.sim.userTx(w.signers.guardian.address, w.sim.addr.factory, encodeFunctionData({ abi: opsFactoryAbi, functionName: 'freeze' })).ok);
  w.sim.launch(L.D).blocked.delete(HOLDERS.bob);
  w.pass(3700);
  const before = w.sim.sent.length;
  const r = await tick(w, k);
  assert.equal(r.published.length, 0);
  assert.equal(w.sim.launch(L.D).active.epoch, 1, 'the ripe root is held');
  assert.ok(!r.actions.some((a) => a.startsWith('activate')), 'no activate sent');
  assert.ok(alertKeys(k).includes('frozen'));
  assert.ok(!alertKeys(k).includes('activate-frozen'), 'it knew it was frozen: it did not even try');
  assert.ok(!r.actions.some((a) => a.startsWith('harvest')), 'no harvest while frozen (no epoch can be published)');
  // bob's skipped share is retried only after 30 days (claim-only) - jump there
  w.pass(31 * 86400);
  const r2 = await tick(w, k);
  assert.ok(r2.actions.some((a) => a.startsWith('push ')), 'the active root keeps paying: ' + js(r2));
  assert.ok((w.sim.launch(L.D).paid0.get(HOLDERS.bob) ?? 0n) > 0n);
  assert.ok(w.sim.sent.length > before);
});

test('activate() reverting Frozen (frozen between the read and the send) is caught at simulation and alerted', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  // both providers still say "not frozen" (a stale read), the chain is frozen
  const frozenSel = encodeFunctionData({ abi: opsFactoryAbi, functionName: 'frozen' });
  const stale = (label: string) => lying(w.sim.rpc(label), label, (m, p, r) => (m === 'eth_call' && p[0].to?.toLowerCase() === w.sim.addr.factory && p[0].data === frozenSel ? '0x' + '0'.repeat(64) : r));
  const k = w.make('keeper', { rpcs: [stale('a'), stale('b')] });
  w.pass(3601);
  await tick(w, k);
  assert.ok(w.sim.userTx(w.signers.guardian.address, w.sim.addr.factory, encodeFunctionData({ abi: opsFactoryAbi, functionName: 'freeze' })).ok);
  w.pass(3700);
  const sentBefore = [...w.sim.txs.values()].filter((t) => t.to === L.D && t.input === '0x0f15f4c0').length;
  const r = await tick(w, k);
  assert.ok(alertKeys(k).includes('activate-frozen'), js(alertKeys(k)));
  assert.equal([...w.sim.txs.values()].filter((t) => t.to === L.D && t.input === '0x0f15f4c0').length, sentBefore, 'no activate went on chain');
  assert.equal(w.sim.launch(L.D).active.epoch, 0);
  void r;
});

test('out of ETH: the key stops, an operator is paged, the income waits', async () => {
  const w = opsWorld({ launches: 2 });
  const L = w.launches[0];
  const k = w.make('keeper');
  w.sim.state.eth.set(w.signers.pusher.address, 1000n);
  w.sim.snaps.set(w.sim.latest, structuredClone(w.sim.state));
  w.pass(3601);
  const r = await tick(w, k);
  assert.equal(r.published.length, 0);
  assert.ok(alertKeys(k).includes('out-of-eth:pusher'), js(alertKeys(k)));
  assert.ok(alertKeys(k).includes('low-eth:pusher'));
  assert.equal([...w.sim.txs.values()].filter((t) => t.from === w.signers.pusher.address).length, 0, 'nothing sent');
  assert.ok(w.sim.launch(L.D).pending0 > 0n, 'the income waits where it is');
  const tries = w.sim.calls.filter((c) => c.method === 'eth_estimateGas' && c.params[0].from === w.signers.pusher.address).length;
  assert.equal(tries, 1, 'the key stopped after the first refusal: the second launch was not tried');
});

test('an unknown pending nonce left by a dead keeper is cancelled before sending', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  // a transaction from the pusher key the journal does not know, stuck in the mempool
  const ghost = await keySigner(testKey('pusher')).sign({ chainId: 8453, nonce: 0, to: L.D, data: '0x4641257d', gas: 300_000n, maxFeePerGas: w.sim.baseFee * 2n, maxPriorityFeePerGas: 1n });
  w.sim.autoMine = false;
  await w.sim.request('eth_sendRawTransaction', [ghost]);
  w.sim.stuck = (t) => t.tip === 1n;
  w.sim.autoMine = true;
  const k = w.make('keeper');
  w.pass(3601);
  const r = await tick(w, k);
  assert.deepEqual(r.errors, []);
  const j = k.ctx.store.get<Record<string, any[]>>('txJournal', {})[w.signers.pusher.address];
  assert.ok(j.some((e: any) => e.label === 'cancel unknown nonce 0'), js(j.map((e: any) => e.label)));
  assert.equal(r.published.length, 1);
});

test('GitHub down: the lease cannot be taken, so NOTHING is sent (not even a harvest)', async () => {
  const w = opsWorld();
  const k = w.make('keeper');
  w.pass(3601);
  w.net.githubDown = true;
  const before = w.sim.sent.length;
  const r = await tick(w, k);
  assert.equal(r.published.length, 0);
  assert.equal(w.sim.sent.length, before);
  assert.ok(!r.ok);
});
