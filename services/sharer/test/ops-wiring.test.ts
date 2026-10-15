// The keeper's wiring of the rules to the chain: payKeeper's own threshold,
// the keeper-key check, a file that does not fit the active root, a failed
// paid read, PushSkipped through a receipt and the 10x rule, the held-at
// memory feeding the dust rule, harvests that must not happen, races the
// chain wins, launch-token income valued by the curve, and every role and
// catalog event's alert.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, toHex } from 'viem';
import { opsWorld, HOLDERS } from './sim/world.ts';
import { tick, js, alertKeys, lying, crashing } from './sim/helpers.ts';
import { opsFactoryAbi, catalogAbi, opsDistributorAbi } from '../src/ops/abis.ts';
import { recordSkip, noteHeld } from '../src/ops/keeper.ts';
import { readAcks, writeAck } from '../src/ops/acks.ts';
import { Store } from '../src/ops/store.ts';
import { watchTick } from '../src/ops/verify.ts';
import { sha256Hex } from '../src/calc/encoding.ts';
import { fileCid } from '../src/ops/cid.ts';

const harvests = (w: ReturnType<typeof opsWorld>, d: string) => [...w.sim.txs.values()].filter((t) => t.to === d && t.input === '0x4641257d');
const sentLabels = (k: any): string[] => Object.values(k.ctx.store.get('txJournal', {}) as Record<string, any[]>).flat().map((e: any) => e.label);

test('payKeeper waits while what it owes is below payKeeperMinFactor x its own cost', async () => {
  const w = opsWorld({ config: (c) => (c.keeper.payKeeperMinFactor = '1000000000') });
  const k = w.make('keeper');
  w.pass(3601);
  await tick(w, k);
  w.pass(3700);
  const r = await tick(w, k);
  assert.ok(!r.actions.some((a) => a.startsWith('payKeeper')), js(r.actions));
  assert.match(String((r.status.launches as any[])[0].payKeeper), /waits/);
  assert.equal(w.sim.launch(w.launches[0].D).keeperPaid0, 0n);
});

test('a key that is not in rules.keeperKeys is alerted (its gas would never be counted)', async () => {
  const w = opsWorld({ config: (c) => (c.sharing.rules.keeperKeys = [c.sharing.rules.keeperKeys[0]]) });
  const k = w.make('keeper');
  await tick(w, k);
  assert.ok(alertKeys(k).includes('not-a-keeper-key:pusher'), js(alertKeys(k)));
  assert.ok(!alertKeys(k).includes('not-a-keeper-key:publisher'));
});

/** Publishes the honest file with a root that does not fit it (wrong merkleRoot). */
async function misfit(w: ReturnType<typeof opsWorld>) {
  const L = w.launches[0];
  const k = w.make('keeper', { signers: { publisher: crashing(w.signers.publisher, (tx) => tx.to === w.sim.addr.factory), pusher: w.signers.pusher } });
  w.pass(3601);
  await tick(w, k);
  const bytes = w.net.repo.get(`sharing/8453/${L.D}/1.json`)!.bytes;
  const f = JSON.parse(new TextDecoder().decode(bytes));
  const root = { merkleRoot: '0x' + '66'.repeat(32), contentHash: sha256Hex(bytes), cumHolders0: f.accounts.reduce((x: bigint, a: any) => x + BigInt(a.cum0), 0n), cumHolders1: 0n, cumKeeper0: BigInt(f.keeper.fee), fromBlock: BigInt(f.window.fromBlock), toBlock: BigInt(f.window.toBlock), epoch: 1, payableAt: 0 };
  assert.ok(w.sim.userTx(w.signers.publisher.address, w.sim.addr.factory, encodeFunctionData({ abi: opsFactoryAbi, functionName: 'publishMany', args: [[L.D as `0x${string}`], [root as any], [`ipfs://${fileCid(bytes)}`]] as any })).ok);
}

test('an active root that does not fit its file: the keeper stops before any push', async () => {
  const w = opsWorld();
  await misfit(w);
  w.pass(3700);
  const k = w.make('keeper', { holder: 'k2' });
  const r = await tick(w, k);
  assert.ok(r.errors.some((e) => /is not the chain's/.test(e)), js(r.errors));
  assert.ok(!sentLabels(k).some((l) => l.startsWith('push')), 'no push was even simulated into a send');
});

test('a paid read that fails stops the pushes of that launch', async () => {
  const w = opsWorld();
  const k = w.make('keeper');
  w.pass(3601);
  await tick(w, k);
  w.pass(3700);
  w.sim.paidReverts = true;
  const r = await tick(w, k);
  assert.ok(r.errors.some((e) => /paid\/isExcluded read/.test(e)), js(r.errors));
  assert.ok(!sentLabels(k).some((l) => l.startsWith('push')));
});

test('PushSkipped from a receipt makes the account claim-only until its unpaid value grows 10x', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  const k = w.make('keeper');
  w.sim.launch(L.D).blocked.add(HOLDERS.bob);
  w.pass(3601);
  await tick(w, k);
  w.pass(3700);
  await tick(w, k); // bob's push is skipped
  const sk = k.ctx.store.get<any>('skips')[L.D][HOLDERS.bob];
  assert.ok(sk && sk.unpaidValue0 > 0n, 'recorded with its unpaid value at the refusal');
  w.sim.launch(L.D).blocked.delete(HOLDERS.bob);
  // a little more income: bob's unpaid grows, but not 10x
  w.sim.income(L.D, 10n ** 17n);
  w.pass(3700);
  await tick(w, k);
  w.pass(3700);
  await tick(w, k);
  assert.equal(w.sim.launch(L.D).paid0.get(HOLDERS.bob) ?? 0n, 0n, 'still claim-only');
  // ten times as much: pushed again
  w.sim.income(L.D, 12n * 10n ** 18n);
  w.pass(3700);
  await tick(w, k);
  w.pass(3700);
  await tick(w, k);
  assert.ok((w.sim.launch(L.D).paid0.get(HOLDERS.bob) ?? 0n) > 0n, 'retried after 10x');
});

test('recordSkip keeps the newest refusal; noteHeld never goes back to an older file', () => {
  const ctx: any = { store: new Store(null) };
  recordSkip(ctx, '0xd', '0xa', 200, 5n);
  recordSkip(ctx, '0xd', '0xa', 100, 9n);
  assert.deepEqual(ctx.store.get('skips')['0xd']['0xa'], { at: 200, unpaidValue0: 5n });
  recordSkip(ctx, '0xd', '0xa', 300, null);
  assert.deepEqual(ctx.store.get('skips')['0xd']['0xa'], { at: 300, unpaidValue0: 5n });
  const file = (epoch: bigint, toTime: bigint, holders: string[]): any => ({ epoch, window: { fromTime: toTime - 10n, toTime }, balancesAtEnd: Object.fromEntries(holders.map((h) => [h, 1n])), accounts: [] });
  noteHeld(ctx, '0xd', file(2n, 2000n, ['0xa']));
  noteHeld(ctx, '0xd', file(1n, 1000n, ['0xa', '0xb']));
  assert.deepEqual(ctx.store.get('lastHeld')['0xd'], { epoch: '2', at: { '0xa': 2000 } });
});

test('the dust rule, wired: a small holder that sold out is pushed once 30 days pass', async () => {
  const small = '0x0000000000000000000000000000000000005a11';
  const w = opsWorld({ holders: { [HOLDERS.alice]: 600n * 10n ** 18n, [HOLDERS.bob]: 400n * 10n ** 18n, [small]: 5n * 10n ** 15n } });
  const L = w.launches[0];
  const k = w.make('keeper');
  w.pass(3601);
  await tick(w, k);
  w.pass(3700);
  await tick(w, k);
  assert.equal(w.sim.launch(L.D).paid0.get(small) ?? 0n, 0n, 'below the threshold');
  w.sim.transfer(L.token, small, HOLDERS.alice, 5n * 10n ** 15n); // sells out
  w.sim.income(L.D, 10n ** 17n);
  w.pass(3700);
  await tick(w, k);
  w.pass(3700);
  await tick(w, k); // epoch 2 active: small holds nothing at its end
  assert.equal(w.sim.launch(L.D).paid0.get(small) ?? 0n, 0n, 'not yet: it held something within the last 30 days');
  w.pass(31 * 86400);
  await tick(w, k);
  assert.ok((w.sim.launch(L.D).paid0.get(small) ?? 0n) > 0n, 'pushed as dust');
});

test('no income at all: no harvest, even after 7 days', async () => {
  const w = opsWorld({ income0: 0n });
  const k = w.make('keeper');
  w.pass(8 * 86400);
  const r = await tick(w, k);
  assert.match(String((r.status.launches as any[])[0].epoch), /no income/);
  assert.equal(harvests(w, w.launches[0].D).length, 0);
});

test('a harvest that would revert is paged and never sent', async () => {
  const w = opsWorld();
  w.sim.harvestReverts = true;
  const k = w.make('keeper');
  w.pass(3601);
  const r = await tick(w, k);
  assert.equal(r.published.length, 0);
  assert.ok(alertKeys(k).includes(`harvest-reverts:${w.launches[0].D}`), js(alertKeys(k)));
  assert.equal(w.sim.sent.length, 0);
});

test('a harvest that simulates fine but reverts when mined is an error, never an epoch', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  w.sim.failOnChain = (to, data) => to === L.D && data === '0x4641257d';
  const k = w.make('keeper');
  w.pass(3601);
  const r = await tick(w, k);
  assert.equal(r.published.length, 0);
  assert.ok(r.errors.some((e) => /harvest of .* reverted/.test(e)), js(r.errors));
});

test('a provider whose safe head falls back between the check and the read: not ready, no error', async () => {
  const w = opsWorld();
  let safeCalls = 0;
  const b = lying(w.sim.rpc('b'), 'b', (m, p, r: any) => {
    if (m === 'eth_getBlockByNumber' && p[0] === 'safe' && ++safeCalls > 1 && r) return { ...r, number: '0x' + (BigInt(r.number) - 50n).toString(16) };
    return r;
  });
  const k = w.make('keeper', { rpcs: [w.sim.rpc('a'), b] });
  w.pass(3601);
  const r = await tick(w, k, { waitForSafe: false });
  assert.deepEqual(r.errors, []);
  assert.equal(r.published.length, 0);
  assert.match(String((r.status.launches as any[])[0].epoch), /not ready: not-safe|waits to be safe/);
});

test('activate() reverting NothingPending (somebody activated first) is not an error', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  const k0 = w.make('keeper');
  w.pass(3601);
  await tick(w, k0);
  w.pass(3700);
  // somebody activates in the meantime; this keeper's providers still show the pending root
  const pendSel = encodeFunctionData({ abi: [{ type: 'function', name: 'pending', inputs: [], outputs: [], stateMutability: 'view' }] as any, functionName: 'pending' });
  const snapshot = await w.sim.request('eth_call', [{ to: L.D, data: pendSel }, 'latest']);
  assert.ok(w.sim.userTx(HOLDERS.carol, L.D, '0x0f15f4c0').ok);
  const stale = (label: string) => lying(w.sim.rpc(label), label, (m, p, r) => (m === 'eth_call' && p[0].to?.toLowerCase() === L.D && p[0].data === pendSel ? snapshot : r));
  const k = w.make('keeper', { holder: 'k2', rpcs: [stale('a'), stale('b')] });
  const r = await tick(w, k);
  assert.ok(!r.errors.some((e) => /NothingPending/.test(e)), js(r.errors));
  assert.equal((r.status.launches as any[])[0].activate, 'already activated');
});

test('launch-token income counts at the curve price: an epoch is due on it alone', async () => {
  const w = opsWorld({ income0: 0n });
  const L = w.launches[0];
  w.sim.income(L.D, 0n, 10n ** 24n); // worth 1e24 x 1e12 / 1e18 = 1e18 of quote at the curve price
  const k = w.make('keeper');
  w.pass(3601);
  const r = await tick(w, k);
  assert.equal(r.published.length, 1, js(r.status));
  const f = JSON.parse(w.net.text(`sharing/8453/${L.D}/1.json`)!);
  assert.equal(f.inputs.received1, (10n ** 24n).toString());
});

test('income owed by the hook that the harvest could not take is alerted', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  w.sim.launch(L.D).stuckHook0 = 3n * 10n ** 16n;
  w.sim.income(L.D, 3n * 10n ** 16n);
  const k = w.make('keeper');
  w.pass(3601);
  await tick(w, k);
  const a = k.ctx.alerts.raised.find((x) => x.key === `income-waiting:${L.D}`);
  assert.ok(a && /hook 30000000000000000/.test(a.text), js(k.ctx.alerts.raised));
});

function emit(w: ReturnType<typeof opsWorld>, address: string, abi: any, name: string, args: Record<string, unknown>) {
  const item = abi.find((x: any) => x.type === 'event' && x.name === name);
  const topics = encodeEventTopics({ abi: [item], eventName: name, args: Object.fromEntries(item.inputs.filter((i: any) => i.indexed).map((i: any) => [i.name, args[i.name]])) } as any) as string[];
  const non = item.inputs.filter((i: any) => !i.indexed);
  const n = w.sim.mine();
  w.sim.addLog({ address, topics, data: encodeAbiParameters(non, non.map((i: any) => args[i.name])), block: n, logIndex: 0n, txHash: keccak256(toHex(`ev:${name}:${n}`)) });
}

test('every role and catalog event has its alert and its severity', async () => {
  const w = opsWorld();
  const F = w.sim.addr.factory;
  const C = w.sim.addr.catalog;
  const g = w.make('verify');
  await watchTick(g.ctx, null);
  const x = HOLDERS.bob;
  const cases: [string, any, string, Record<string, unknown>, 'page' | 'warn' | 'info'][] = [
    [F, opsFactoryAbi, 'PublisherAnnounced', { next: x, at: 1n }, 'page'],
    [F, opsFactoryAbi, 'KeeperPayeeAnnounced', { next: x, at: 1n }, 'page'],
    [F, opsFactoryAbi, 'VetoerRemovalAnnounced', { account: x, at: 1n }, 'page'],
    [F, opsFactoryAbi, 'UnfreezeAnnounced', { at: 1n }, 'page'],
    [F, opsFactoryAbi, 'UnfreezeCancelled', { by: x }, 'warn'],
    [F, opsFactoryAbi, 'VetoerSet', { account: x, isVetoer: false }, 'page'],
    [F, opsFactoryAbi, 'VetoerSet', { account: x, isVetoer: true }, 'warn'],
    [F, opsFactoryAbi, 'Frozen', { by: x }, 'page'],
    [F, opsFactoryAbi, 'Unfrozen', {}, 'warn'],
    [F, opsFactoryAbi, 'PublisherRevoked', { previous: x }, 'page'],
    [F, opsFactoryAbi, 'PublisherUpdated', { previous: x, next: x }, 'warn'],
    [F, opsFactoryAbi, 'KeeperPayeeUpdated', { previous: x, next: x }, 'warn'],
    [F, opsFactoryAbi, 'PendingCancelled', {}, 'info'],
    [C, catalogAbi, 'FactoryProposed', { factory: x, at: 1n }, 'page'],
    [C, catalogAbi, 'FactoryAdmitted', { factory: x, at: 1n }, 'warn'],
    [C, catalogAbi, 'FactoryRetired', { factory: x }, 'warn'],
    [C, catalogAbi, 'RecommendedSet', { factory: x }, 'info'],
    [C, catalogAbi, 'FactoryCancelled', { factory: x }, 'info'],
    [w.launches[0].D, opsDistributorAbi, 'RootVetoed', { epoch: 3, reason: '0x' + '00'.repeat(32) }, 'page'],
  ];
  for (const [addr, abi, name, args] of cases) emit(w, addr, abi, name, args);
  await watchTick(g.ctx, null);
  const got = g.ctx.alerts.raised.filter((a) => a.key.startsWith('event:'));
  assert.deepEqual(got.map((a) => a.severity), cases.map((c) => c[4]), js(got.map((a) => [a.title, a.severity])));
});

test('acks without a data repo live in /data and are read back', async () => {
  const ctx = { repo: null, store: new Store(null) };
  assert.equal((await readAcks(ctx)).size, 0);
  await writeAck(ctx, { distributor: '0xABC', epoch: '4', by: 'op', at: 'now' });
  assert.ok((await readAcks(ctx)).has('0xabc:4'));
});
