// The verifier and the guardian: an honest epoch verifies; a forged one (a
// stolen publisher key, providers that lie to it) is vetoed inside its hour
// the moment it is judged; a file that does not hash is vetoed and frozen; a repeat is
// frozen; a root nobody can verify is vetoed only after a grace, or when its
// hour is nearly over; `verify` (no key) alerts with ready-to-sign calldata; the public CLI
// gives an exit code; role and catalog events become alerts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, parseAbi, toHex } from 'viem';
import { opsWorld, HOLDERS } from './sim/world.ts';
import { tick, js, lying, alertKeys } from './sim/helpers.ts';
import { watchTick, REASONS, reasonWord, reasonOf } from '../src/ops/verify.ts';
import { verifyOne } from '../src/ops/rebuild.ts';
import { opsFactoryAbi, catalogAbi } from '../src/ops/abis.ts';
import { TOPICS } from '../src/chain/abis.ts';

const THIEF = '0x00000000000000000000000000000000000bad01';

/** A keeper whose two providers both invent a mint to THIEF: its file is
 *  self-consistent and its sha256 matches, but the chain says otherwise. */
function forger(w: ReturnType<typeof opsWorld>) {
  const L = w.launches[0];
  const mint = (r: unknown, p: any[]) => {
    if (!Array.isArray(r) || String(p[0].address).toLowerCase() !== L.token || p[0].topics?.[0] !== TOPICS.Transfer) return r;
    const from = BigInt(p[0].fromBlock);
    const to = BigInt(p[0].toBlock);
    const b = L.sharingSince + 1n;
    if (b < from || b > to) return r;
    return [...r, { address: L.token, topics: [TOPICS.Transfer, '0x' + '0'.repeat(64), '0x' + THIEF.slice(2).padStart(64, '0')], data: '0x' + (10n ** 30n).toString(16).padStart(64, '0'), blockNumber: '0x' + b.toString(16), blockHash: w.sim.hashOf(b), transactionHash: keccak256(toHex('forged')), logIndex: '0x3e7', removed: false }].sort((x: any, y: any) => (BigInt(x.blockNumber) === BigInt(y.blockNumber) ? Number(BigInt(x.logIndex) - BigInt(y.logIndex)) : BigInt(x.blockNumber) < BigInt(y.blockNumber) ? -1 : 1));
  };
  const liar = (label: string) => lying(w.sim.rpc(label), label, (m, p, r) => (m === 'eth_getLogs' ? mint(r, p) : r));
  return w.make('keeper', { holder: 'forger', rpcs: [liar('a'), liar('b')] });
}

test('an honest epoch verifies; the guardian sends nothing', async () => {
  const w = opsWorld();
  const k = w.make('keeper');
  w.pass(3601);
  await tick(w, k);
  const g = w.make('guardian');
  const before = w.sim.sent.length;
  const rep = await watchTick(g.ctx, g.keys.guardian);
  assert.deepEqual(rep.errors, []);
  assert.equal(rep.results.length, 1);
  assert.equal(rep.results[0].verdict, 'ok', js(rep.results[0]));
  assert.equal(w.sim.sent.length, before);
  // checked once: the next pass does not recompute it again
  const rep2 = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(rep2.results.length, 0);
});

test('a forged epoch (stolen publisher key, lying providers) is vetoed in its hour, the moment it is judged', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  const f = forger(w);
  w.pass(3601);
  const r = await tick(w, f);
  assert.equal(r.published.length, 1, js(r));
  assert.equal(w.sim.launch(L.D).pending.epoch, 1);

  const g = w.make('guardian');
  w.pass(120);
  const rep = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(rep.results[0].verdict, 'mismatch', js(rep.results));
  assert.equal(rep.results[0].reason, REASONS.RECOMPUTE);
  assert.equal(rep.vetoed.length, 1);
  const s = w.sim.launch(L.D);
  assert.equal(s.pending.payableAt, 0n, 'vetoed on chain');
  const vetoTx = w.sim.txs.get(rep.vetoed[0].tx)!;
  assert.equal(decodeFunctionData({ abi: opsFactoryAbi, data: vetoTx.input as `0x${string}` }).functionName, 'veto', 'one root, one veto, sent as soon as it was judged');
  assert.equal(vetoTx.status, true);
  const ev = w.sim.logs.find((l) => l.txHash === rep.vetoed[0].tx && l.address === L.D)!;
  assert.equal(reasonOf('0x' + ev.data.slice(2, 66)), REASONS.RECOMPUTE);
  assert.equal(rep.froze, null, 'a first recompute mismatch is vetoed, not frozen');
  const a = g.ctx.alerts.raised.find((x) => x.key === `mismatch:${L.D}:1`)!;
  assert.equal(a.severity, 'page');
  assert.ok(a.calls!.some((c) => decodeFunctionData({ abi: opsFactoryAbi, data: c.data as `0x${string}` }).functionName === 'freeze'));
  // the thief got nothing: nothing became payable
  w.pass(3700);
  assert.equal(w.sim.launch(L.D).active.epoch, 0);
});

test('a SECOND mismatch within the repeat window is vetoed AND frozen', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  const f = forger(w);
  const g = w.make('guardian');
  w.pass(3601);
  await tick(w, f);
  await watchTick(g.ctx, g.keys.guardian); // veto #1
  // the forger acknowledges its own veto and tries again
  const { writeAck } = await import('../src/ops/acks.ts');
  await writeAck(f.ctx, { distributor: L.D, epoch: '1', by: 'thief', at: 'now' });
  w.pass(3700);
  const r2 = await tick(w, f);
  assert.equal(r2.published.length, 1, js(r2));
  w.pass(60);
  const rep = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(rep.vetoed.length, 1);
  assert.ok(rep.froze, 'frozen on the repeat');
  assert.equal(w.sim.state.factory.frozen, true);
  assert.ok(alertKeys(g).some((k) => k.startsWith('froze:')));
});

test('a root whose served copies all hash wrong is paged at once, vetoed only later, and NEVER frozen', async () => {
  // Whoever controls the site and the gateways can cause this; it says
  // nothing against the root, so it must not stop payouts platform-wide.
  const w = opsWorld();
  const L = w.launches[0];
  const k = w.make('keeper');
  w.pass(3601);
  await tick(w, k);
  w.net.siteTamper = (_p, b) => new Uint8Array([...b, 10]);
  w.net.gatewayTamper = true;
  const g = w.make('guardian');
  const rep = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(rep.results[0].reason, REASONS.HASH, js(rep.results));
  assert.equal(rep.results[0].verdict, 'unverifiable');
  assert.equal(rep.vetoed.length, 0, 'not vetoed with most of the hour left');
  assert.equal(rep.froze, null);
  const a = g.ctx.alerts.raised.find((x) => x.key === `unverified:${L.D}:1:hash`)!;
  assert.ok(a, js(alertKeys(g)));
  assert.equal(a.severity, 'page', 'paged at once');
  assert.match(a.title, /served copies do not match the on-chain hash/);
  assert.match(a.text, /the gateway serves wrong content for that CID/, 'the gateway copy is checked against its CID');
  w.pass(3600 - 800);
  const rep2 = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(rep2.vetoed.length, 1, js(rep2));
  assert.equal(rep2.vetoed[0].reason, REASONS.UNVERIFIED);
  assert.equal(rep2.froze, null, 'copies that do not hash are never a reason to freeze');
  assert.equal(w.sim.state.factory.frozen, false);
  assert.ok(!alertKeys(g).some((x) => x.startsWith('froze:')));
});

test('a gateway copy that is its CID\'s own bytes is reported as the URI naming the wrong file', async () => {
  const { EpochFiles } = await import('../src/ops/files.ts');
  const { fileCid } = await import('../src/ops/cid.ts');
  const bytes = new TextEncoder().encode('{"other":"file"}');
  const files = new EpochFiles({ chainId: 8453n, store: { readFile: () => null, writeFile: () => {} } as any, siteBase: null, gateways: ['https://gw.example'], http: { fetch: (async () => new Response(bytes as BodyInit, { status: 200 })) as any } as any });
  const { check } = await files.checkCopy('gateway', 'https://gw.example/ipfs/x', '0x' + '00'.repeat(32), fileCid(bytes));
  assert.equal(check.ok, false);
  assert.match(check.error!, /the URI names a file that is not the one hashed on chain/, js(check));
});

test('a site copy that hashes wrong while a gateway matches: verified ok, and the operator is warned', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  const k = w.make('keeper');
  w.pass(3601);
  await tick(w, k);
  w.net.siteTamper = (_p, b) => new Uint8Array([...b, 10]);
  const g = w.make('guardian');
  const rep = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(rep.results[0].verdict, 'ok', js(rep.results));
  assert.equal(rep.vetoed.length, 0);
  const a = g.ctx.alerts.raised.find((x) => x.key === `copy-bad:${L.D}:1:site`)!;
  assert.ok(a, js(alertKeys(g)));
  assert.equal(a.severity, 'warn');
  assert.match(a.text, /sha256 is 0x[0-9a-f]{64}/);
});

test('a site copy tampered AFTER its epoch verified is still noticed on a later pass', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  const k = w.make('keeper');
  w.pass(3601);
  await tick(w, k);
  const g = w.make('guardian');
  const rep1 = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(rep1.results[0].verdict, 'ok');
  assert.ok(!alertKeys(g).some((x) => x.startsWith('copy-bad:')));
  w.net.siteTamper = (_p, b) => new Uint8Array([...b, 10]);
  const rep2 = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(rep2.results.length, 0, 'not recomputed again');
  assert.ok(alertKeys(g).includes(`copy-bad:${L.D}:1:site`), js(alertKeys(g)));
  assert.equal(rep2.vetoed.length, 0);
});

test('a root nobody can verify is not vetoed at once: after the grace, or in the last minutes of its hour', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  const k = w.make('keeper');
  w.pass(3601);
  await tick(w, k);
  w.net.siteDown = true;
  w.net.gatewayDown = true;
  const g = w.make('guardian');
  const rep1 = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(rep1.results[0].verdict, 'unverifiable');
  assert.equal(rep1.vetoed.length, 0, 'not vetoed with most of the hour left');
  assert.ok(alertKeys(g).includes(`unverified:${L.D}:1`));
  w.pass(3600 - 800); // 800 s left < 900
  const rep2 = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(rep2.vetoed.length, 1, js(rep2));
  assert.equal(rep2.vetoed[0].reason, REASONS.UNVERIFIED);
  assert.equal(rep2.froze, null, 'an unverifiable root is never a reason to freeze');
});

test('verify mode never signs: it pages with ready-to-sign vetoMany and freeze calldata', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  const f = forger(w);
  w.pass(3601);
  await tick(w, f);
  const v = w.make('verify');
  const before = w.sim.sent.length;
  const rep = await watchTick(v.ctx, null);
  assert.equal(rep.results[0].verdict, 'mismatch');
  assert.equal(w.sim.sent.length, before, 'no transaction');
  assert.deepEqual(rep.errors, [], 'it never even tried to sign');
  assert.deepEqual(v.ctx.store.get('owedVetoes', {}), {}, 'nor does it owe a veto it cannot send');
  assert.ok(!alertKeys(v).some((x) => x.startsWith('veto-failed') || x === 'freeze-failed'));
  const a = v.ctx.alerts.raised.find((x) => x.key === `mismatch:${L.D}:1`)!;
  const fns = a.calls!.map((c) => decodeFunctionData({ abi: opsFactoryAbi, data: c.data as `0x${string}` }));
  assert.deepEqual(fns.map((x) => x.functionName), ['veto', 'vetoMany', 'freeze']);
  const [ds, eps, why] = fns[1].args as [string[], number[], string];
  assert.deepEqual(ds.map((x) => x.toLowerCase()), [L.D]);
  assert.deepEqual(eps, [1]);
  assert.equal(why, reasonWord(REASONS.RECOMPUTE));
  for (const c of a.calls!) assert.equal(c.to, w.sim.addr.factory);
});

test('the public verifier: exit 0 for an honest epoch, 1 for a forged one', async () => {
  const w = opsWorld();
  const k = w.make('keeper');
  w.pass(3601);
  await tick(w, k);
  const v = w.make('verify');
  const ok = await verifyOne({ readers: v.ctx.readers, sharing: v.ctx.cfg.sharing, files: v.ctx.files }, w.launches[0].D, 1n);
  assert.equal(ok.code, 0, ok.text);
  assert.match(ok.text, /verdict {6}OK/);

  const w2 = opsWorld();
  const f = forger(w2);
  w2.pass(3601);
  await tick(w2, f);
  const v2 = w2.make('verify');
  const bad = await verifyOne({ readers: v2.ctx.readers, sharing: v2.ctx.cfg.sharing, files: v2.ctx.files }, w2.launches[0].D, 1n);
  assert.equal(bad.code, 1, bad.text);
  assert.match(bad.text, /MISMATCH/);
  const none = await verifyOne({ readers: v2.ctx.readers, sharing: v2.ctx.cfg.sharing, files: v2.ctx.files }, w2.launches[0].D, 9n);
  assert.equal(none.code, 2);
});

function emit(w: ReturnType<typeof opsWorld>, address: string, abi: any, name: string, args: Record<string, unknown>) {
  const item = abi.find((x: any) => x.type === 'event' && x.name === name);
  const topics = encodeEventTopics({ abi: [item], eventName: name, args: Object.fromEntries(item.inputs.filter((i: any) => i.indexed).map((i: any) => [i.name, args[i.name]])) } as any) as string[];
  const non = item.inputs.filter((i: any) => !i.indexed);
  const data = encodeAbiParameters(non, non.map((i: any) => args[i.name]));
  const n = w.sim.mine();
  w.sim.addLog({ address, topics, data, block: n, logIndex: 0n, txHash: keccak256(toHex(`ev:${name}:${n}`)) });
}

test('role and catalog changes are alerted once each, with the Safe answer ready to sign', async () => {
  const w = opsWorld();
  const F = w.sim.addr.factory;
  const g = w.make('guardian');
  await watchTick(g.ctx, g.keys.guardian); // baseline scan
  const at = BigInt(Math.floor(w.clock.t / 1000) + 48 * 3600);
  emit(w, F, opsFactoryAbi, 'VetoerRemovalAnnounced', { account: w.signers.guardian.address, at });
  emit(w, F, opsFactoryAbi, 'UnfreezeAnnounced', { at });
  emit(w, F, opsFactoryAbi, 'PublisherAnnounced', { next: HOLDERS.bob, at });
  emit(w, F, opsFactoryAbi, 'KeeperPayeeAnnounced', { next: HOLDERS.bob, at });
  emit(w, F, opsFactoryAbi, 'VetoerSet', { account: HOLDERS.carol, isVetoer: true });
  emit(w, w.sim.addr.catalog, catalogAbi, 'FactoryProposed', { factory: HOLDERS.alice, at });
  await watchTick(g.ctx, g.keys.guardian);
  const got = g.ctx.alerts.raised.filter((a) => a.key.startsWith('event:'));
  const titles = got.map((a) => a.title);
  for (const t of [/REMOVAL OF A VETOER/, /UNFREEZE/, /PUBLISHER/, /KEEPER PAYEE/, /vetoer was ADDED/, /DISTRIBUTOR FACTORY was proposed/]) assert.ok(titles.some((x) => t.test(x)), `${t} in ${js(titles)}`);
  const removal = got.find((a) => /REMOVAL/.test(a.title))!;
  assert.match(removal.text, /THIS guardian/);
  assert.equal(decodeFunctionData({ abi: parseAbi(['function addVetoer(address account)']), data: removal.calls![0].data as `0x${string}` }).functionName, 'addVetoer');
  const proposed = got.find((a) => /FACTORY was proposed/.test(a.title))!;
  assert.equal(proposed.calls![0].to, w.sim.addr.catalog);
  assert.equal(got.filter((a) => a.severity === 'page').length, 5);
  // once each: a second pass raises nothing new
  const n = g.ctx.alerts.raised.length;
  await watchTick(g.ctx, g.keys.guardian);
  assert.equal(g.ctx.alerts.raised.length, n);
});

test('a vetoer can cancel an announced unfreeze by freezing again; the cancel is alerted', async () => {
  const w = opsWorld();
  const F = w.sim.addr.factory;
  const g = w.make('guardian');
  await watchTick(g.ctx, g.keys.guardian); // baseline scan
  const at = BigInt(Math.floor(w.clock.t / 1000) + 48 * 3600);
  w.sim.state.factory.frozen = true;
  w.sim.state.factory.pendingUnfreezeAt = at;
  emit(w, F, opsFactoryAbi, 'UnfreezeAnnounced', { at });
  assert.ok(w.sim.userTx(w.signers.guardian.address, F, encodeFunctionData({ abi: opsFactoryAbi, functionName: 'freeze' })).ok);
  assert.equal(w.sim.state.factory.pendingUnfreezeAt, 0n, 'the sim cancels it as the factory does');
  await watchTick(g.ctx, g.keys.guardian);
  const got = g.ctx.alerts.raised.filter((a) => a.key.startsWith('event:'));
  const announced = got.find((a) => /UNFREEZE was announced/.test(a.title))!;
  const fns = announced.calls!.map((c) => decodeFunctionData({ abi: parseAbi(['function cancelPending()', 'function freeze()']), data: c.data as `0x${string}` }).functionName);
  assert.deepEqual(fns, ['cancelPending', 'freeze'], 'the Safe cancels it, or a vetoer freezes again');
  const cancelled = got.find((a) => /unfreeze was CANCELLED/.test(a.title));
  assert.ok(cancelled, js(got.map((a) => a.title)));
  assert.equal(cancelled!.severity, 'warn');
  assert.match(cancelled!.text, /THIS guardian/);
});

test('a guardian key that is not a vetoer only alerts', async () => {
  const w = opsWorld();
  w.sim.state.factory.vetoers.delete(w.signers.guardian.address);
  w.sim.snaps.set(w.sim.latest, structuredClone(w.sim.state));
  const g = w.make('guardian');
  await watchTick(g.ctx, g.keys.guardian);
  assert.ok(alertKeys(g).includes('guardian-not-vetoer'));
});

test('a root that does not match its own (hashing) file is FILE_INVALID: vetoed and frozen at once', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  const { crashing } = await import('./sim/helpers.ts');
  const { encodeFunctionData } = await import('viem');
  const k = w.make('keeper', { signers: { publisher: crashing(w.signers.publisher, (tx) => tx.to === w.sim.addr.factory), pusher: w.signers.pusher } });
  w.pass(3601);
  await tick(w, k); // the file is published (site + IPFS), the root is not
  const bytes = w.net.repo.get(`sharing/8453/${L.D}/1.json`)!.bytes;
  const f = JSON.parse(new TextDecoder().decode(bytes));
  const { sha256Hex } = await import('../src/calc/encoding.ts');
  const { fileCid } = await import('../src/ops/cid.ts');
  const root = { merkleRoot: '0x' + '66'.repeat(32), contentHash: sha256Hex(bytes), cumHolders0: BigInt(f.accounts.reduce((x: bigint, a: any) => x + BigInt(a.cum0), 0n)), cumHolders1: 0n, cumKeeper0: BigInt(f.keeper.fee), fromBlock: BigInt(f.window.fromBlock), toBlock: BigInt(f.window.toBlock), epoch: 1, payableAt: 0 };
  assert.ok(w.sim.userTx(w.signers.publisher.address, w.sim.addr.factory, encodeFunctionData({ abi: opsFactoryAbi, functionName: 'publishMany', args: [[L.D as `0x${string}`], [root as any], [`ipfs://${fileCid(bytes)}`]] as any })).ok);
  const g = w.make('guardian');
  const rep = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(rep.results[0].reason, REASONS.INVALID, js(rep.results));
  assert.equal(rep.vetoed.length, 1);
  assert.ok(rep.froze, 'a file that does not match its own root is plainly malicious');
});

test('a mismatch found after the veto hour: no veto is attempted, an operator is paged to freeze', async () => {
  const w = opsWorld();
  const f = forger(w);
  w.pass(3601);
  await tick(w, f);
  w.pass(3700); // ripe, not yet activated by anyone
  const g = w.make('guardian');
  const before = w.sim.sent.length;
  const rep = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(rep.results[0].verdict, 'mismatch');
  assert.equal(rep.vetoed.length, 0);
  assert.equal(w.sim.sent.length, before, 'no transaction');
  assert.ok(g.ctx.alerts.raised.some((a) => /no longer vetoable/.test(a.title)));
});

test('while frozen a held root can be vetoed after its hour', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  const f = forger(w);
  w.pass(3601);
  await tick(w, f);
  const { encodeFunctionData } = await import('viem');
  assert.ok(w.sim.userTx(w.sim.state.factory.owner, w.sim.addr.factory, encodeFunctionData({ abi: opsFactoryAbi, functionName: 'freeze' })).ok);
  w.pass(3700);
  const g = w.make('guardian');
  const rep = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(rep.vetoed.length, 1, js(rep));
  assert.equal(w.sim.launch(L.D).pending.payableAt, 0n);
});

test('vetoUnverifiedBeforeSec = 0 and vetoUnverifiedAfterSec = 0 never veto a root for being unverifiable while its hour lasts', async () => {
  const w = opsWorld({ config: (c) => Object.assign(c.guardian, { vetoUnverifiedBeforeSec: 0, vetoUnverifiedAfterSec: 0 }) });
  const k = w.make('keeper');
  w.pass(3601);
  await tick(w, k);
  w.net.siteDown = true;
  w.net.gatewayDown = true;
  w.pass(3500);
  const g = w.make('guardian');
  const rep = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(rep.results[0].verdict, 'unverifiable');
  assert.equal(rep.vetoed.length, 0);
});

test('a late UNVERIFIED veto never freezes, even after an earlier mismatch veto', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  const f = forger(w);
  const g = w.make('guardian');
  w.pass(3601);
  await tick(w, f);
  const r1 = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(r1.vetoed.length, 1);
  const { writeAck } = await import('../src/ops/acks.ts');
  const honest = w.make('keeper', { holder: 'honest' });
  await writeAck(honest.ctx, { distributor: L.D, epoch: '1', by: 'op', at: 'now' });
  w.pass(3700);
  const r = await tick(w, honest);
  assert.equal(r.published.length, 1, js(r));
  w.net.siteDown = true;
  w.net.gatewayDown = true;
  w.pass(3600 - 800);
  const r2 = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(r2.vetoed.length, 1, js(r2));
  assert.equal(r2.vetoed[0].reason, REASONS.UNVERIFIED);
  assert.equal(r2.froze, null);
  assert.equal(w.sim.state.factory.frozen, false);
});

test('an unverifiable epoch is not re-checked once a later epoch has superseded it', async () => {
  const w = opsWorld({ config: (c) => (c.guardian.vetoUnverifiedBeforeSec = 0) });
  const L = w.launches[0];
  const k = w.make('keeper');
  const g = w.make('verify');
  w.pass(3601);
  await tick(w, k); // epoch 1 pending
  w.net.siteDown = true;
  w.net.gatewayDown = true;
  const a = await watchTick(g.ctx, null);
  assert.equal(a.results[0].verdict, 'unverifiable');
  w.net.siteDown = false;
  w.net.gatewayDown = false;
  w.pass(3700);
  await tick(w, k); // epoch 1 active
  w.sim.income(L.D, 10n ** 17n);
  w.pass(3700);
  await tick(w, k); // epoch 2 pending
  w.pass(3700);
  await tick(w, k); // epoch 2 active: epoch 1 is superseded
  const b = await watchTick(g.ctx, null);
  assert.ok(!b.results.some((x) => x.epoch === 1n), js(b.results.map((x) => [x.epoch, x.verdict])));
  assert.ok(b.results.some((x) => x.epoch === 2n && x.verdict === 'ok'), 'the root in force is checked');
});

test('a mismatch more than 30 days after the last guardian veto is vetoed, not frozen', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  const f = forger(w);
  const g = w.make('guardian');
  w.pass(3601);
  await tick(w, f);
  const r1 = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(r1.vetoed.length, 1);
  const { writeAck } = await import('../src/ops/acks.ts');
  await writeAck(f.ctx, { distributor: L.D, epoch: '1', by: 'thief', at: 'now' });
  w.pass(31 * 86400);
  const r2 = await tick(w, f);
  assert.equal(r2.published.length, 1, js(r2));
  w.pass(60);
  const rep = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(rep.vetoed.length, 1);
  assert.equal(rep.froze, null, 'outside the repeat window: a first mismatch again');
});

test('a verifier whose rules are out of step with the file says so in its verdict', async () => {
  const w = opsWorld();
  const k = w.make('keeper');
  w.pass(3601);
  await tick(w, k);
  const r = w.cfg.sharing.rules;
  const cfg = { ...w.cfg, sharing: { ...w.cfg.sharing, rules: { ...r, version: r.version + 1n, keeperKeys: [...r.keeperKeys, THIEF] } } };
  const v = w.make('verify', { cfg: cfg as any });
  const rep = await watchTick(v.ctx, null);
  assert.equal(rep.results[0].verdict, 'mismatch', js(rep.results));
  assert.ok(rep.results[0].problems.some((p) => /the file names rules version 1, this host's config has 2/.test(p)), js(rep.results[0].problems));
});

test('a mismatch is checked once: the next pass does not recompute it again', async () => {
  const w = opsWorld();
  const f = forger(w);
  w.pass(3601);
  await tick(w, f);
  const v = w.make('verify');
  const rep1 = await watchTick(v.ctx, null);
  assert.equal(rep1.results[0].verdict, 'mismatch', js(rep1.results));
  const rep2 = await watchTick(v.ctx, null);
  assert.equal(rep2.results.length, 0, js(rep2.results));
});
