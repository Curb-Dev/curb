// The admin powers outside holder sharing are watched too (gap item 19): the
// FeeHook's platform recipient and fee announcements, a launcher admitted to
// the LaunchRegistry, and ownership moves on the factory, the catalog, the
// hook and the registry - each alerted once, at its severity, with the
// Safe's answer ready to sign.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, keccak256, parseAbi, toHex } from 'viem';
import { opsWorld, HOLDERS } from './sim/world.ts';
import { js } from './sim/helpers.ts';
import { watchTick } from '../src/ops/verify.ts';
import { feeHookAbi, ownableAbi, registryAbi } from '../src/ops/abis.ts';

const HOOK = '0x00000000000000000000000000000000000a000b';
const LISTED = '0x00000000000000000000000000000000000f0c01';
const ZERO = '0x0000000000000000000000000000000000000000';

function emit(w: ReturnType<typeof opsWorld>, address: string, abi: any, name: string, args: Record<string, unknown>) {
  const item = abi.find((x: any) => x.type === 'event' && x.name === name);
  const topics = encodeEventTopics({ abi: [item], eventName: name, args: Object.fromEntries(item.inputs.filter((i: any) => i.indexed).map((i: any) => [i.name, args[i.name]])) } as any) as string[];
  const non = item.inputs.filter((i: any) => !i.indexed);
  const n = w.sim.mine();
  w.sim.addLog({ address, topics, data: encodeAbiParameters(non, non.map((i: any) => args[i.name])), block: n, logIndex: 0n, txHash: keccak256(toHex(`ev:${address}:${name}:${n}`)) });
}

const fnOf = (data: string) => decodeFunctionData({ abi: parseAbi(['function cancelPlatformRecipient()', 'function cancelPlatformFeeBps()', 'function transferOwnership(address newOwner)', 'function acceptOwnership()']), data: data as `0x${string}` });

function world(policyOwner: string | null) {
  return opsWorld({
    config: (c) => {
      c.hook = HOOK;
      c.registry = '0x00000000000000000000000000000000000a0002';
      c.policyOwner = policyOwner;
      c.launchers = [LISTED];
    },
  });
}

test('the FeeHook, the registry and every ownership move are alerted once each, at their severity, with the answer ready to sign', async () => {
  const w = world('0x00000000000000000000000000000000000cafe0');
  const SAFE = '0x00000000000000000000000000000000000cafe0';
  const DEPLOYER = '0x00000000000000000000000000000000000de901';
  const THIEF = HOLDERS.bob;
  const R = w.sim.addr.registry;
  const F = w.sim.addr.factory;
  const C = w.sim.addr.catalog;
  const v = w.make('verify');
  await watchTick(v.ctx, null); // baseline scan
  const at = BigInt(Math.floor(w.clock.t / 1000) + 24 * 3600);
  const cases: [string, any, string, Record<string, unknown>, 'page' | 'warn' | 'info', RegExp][] = [
    [HOOK, feeHookAbi, 'PlatformRecipientAnnounced', { previous: SAFE, next: THIEF, readyAt: at }, 'page', /PLATFORM RECIPIENT was announced/],
    [HOOK, feeHookAbi, 'PlatformFeeBpsAnnounced', { previous: 2000, next: 8000, readyAt: at }, 'page', /PLATFORM FEE was announced/],
    [HOOK, feeHookAbi, 'PlatformRecipientUpdated', { previous: SAFE, next: THIEF }, 'warn', /platform recipient changed/],
    [HOOK, feeHookAbi, 'PlatformFeeBpsUpdated', { previous: 2000, next: 8000 }, 'warn', /platform fee changed/],
    [HOOK, feeHookAbi, 'PlatformRecipientCancelled', { pending: THIEF }, 'info', /recipient was cancelled/],
    [HOOK, feeHookAbi, 'PlatformFeeBpsCancelled', { pending: 8000 }, 'info', /fee was cancelled/],
    [R, registryAbi, 'LauncherSet', { launcher: LISTED }, 'info', /listed launcher was admitted/],
    [R, registryAbi, 'LauncherSet', { launcher: THIEF }, 'page', /UNLISTED LAUNCHER/],
    [R, ownableAbi, 'OwnershipTransferred', { previousOwner: ZERO, newOwner: DEPLOYER }, 'info', /LaunchRegistry was created/],
    [R, ownableAbi, 'OwnershipTransferStarted', { previousOwner: DEPLOYER, newOwner: SAFE }, 'warn', /handover of the LaunchRegistry to the owner Safe/],
    [R, ownableAbi, 'OwnershipTransferred', { previousOwner: DEPLOYER, newOwner: SAFE }, 'warn', /LaunchRegistry is now owned by the owner Safe/],
    [F, ownableAbi, 'OwnershipTransferStarted', { previousOwner: SAFE, newOwner: THIEF }, 'page', /OWNERSHIP TRANSFER of the HolderDistributorFactory/],
    [C, ownableAbi, 'OwnershipTransferred', { previousOwner: SAFE, newOwner: THIEF }, 'page', /SharingCatalog has a NEW OWNER/],
    [HOOK, ownableAbi, 'OwnershipTransferStarted', { previousOwner: SAFE, newOwner: ZERO }, 'info', /pending ownership transfer of the FeeHook was cancelled/],
  ];
  for (const [addr, abi, name, args] of cases) emit(w, addr, abi, name, args);
  await watchTick(v.ctx, null);
  const got = v.ctx.alerts.raised.filter((a) => a.key.startsWith('event:'));
  assert.deepEqual(got.map((a) => a.severity), cases.map((c) => c[4]), js(got.map((a) => [a.title, a.severity])));
  got.forEach((a, i) => assert.match(a.title, cases[i][5], `${i}: ${a.title}`));

  // the answers, ready to sign
  const [recipient, fee] = got;
  assert.equal(recipient.calls![0].to, HOOK);
  assert.equal(fnOf(recipient.calls![0].data).functionName, 'cancelPlatformRecipient');
  assert.match(recipient.text, new RegExp(THIEF, 'i'));
  assert.equal(fnOf(fee.calls![0].data).functionName, 'cancelPlatformFeeBps');
  assert.match(fee.text, /from 2000 to 8000 bps/);
  const handover = got[9];
  assert.equal(handover.calls![0].to, R);
  assert.equal(fnOf(handover.calls![0].data).functionName, 'acceptOwnership');
  const hostile = got[11];
  assert.equal(hostile.calls![0].to, F);
  const t = fnOf(hostile.calls![0].data);
  assert.equal(t.functionName, 'transferOwnership');
  assert.equal(String(t.args![0]).toLowerCase(), ZERO, 'cancelling is offering it to nobody');
  assert.match(hostile.text, /not the owner Safe/);
  assert.match(got[7].text, /hiddenFactories/);
  // what an unlisted launcher can reach, as the registry's curve check makes it
  assert.match(got[7].text, /register NEW launches/);
  assert.match(got[7].text, /cannot touch an existing launch/);
  assert.match(got[7].text, /treat the owner's key as stolen/);

  // once each: a second pass raises nothing new
  const n = v.ctx.alerts.raised.length;
  await watchTick(v.ctx, null);
  assert.equal(v.ctx.alerts.raised.filter((a) => a.key.startsWith('event:')).length, got.length);
  assert.ok(v.ctx.alerts.raised.length >= n);
});

test('without config.policyOwner every ownership move but a creation pages; without config.hook/registry they are not scanned', async () => {
  const w = world(null);
  const R = w.sim.addr.registry;
  const v = w.make('verify');
  await watchTick(v.ctx, null);
  emit(w, R, ownableAbi, 'OwnershipTransferStarted', { previousOwner: HOLDERS.alice, newOwner: '0x00000000000000000000000000000000000cafe0' });
  emit(w, R, ownableAbi, 'OwnershipTransferred', { previousOwner: ZERO, newOwner: HOLDERS.alice });
  await watchTick(v.ctx, null);
  const got = v.ctx.alerts.raised.filter((a) => a.key.startsWith('event:'));
  assert.deepEqual(got.map((a) => a.severity), ['page', 'info'], js(got.map((a) => a.title)));

  const w2 = opsWorld();
  const v2 = w2.make('verify');
  await watchTick(v2.ctx, null);
  emit(w2, HOOK, feeHookAbi, 'PlatformRecipientAnnounced', { previous: HOLDERS.alice, next: HOLDERS.bob, readyAt: 1n });
  emit(w2, w2.sim.addr.registry, registryAbi, 'LauncherSet', { launcher: HOLDERS.bob });
  await watchTick(v2.ctx, null);
  assert.deepEqual(v2.ctx.alerts.raised.filter((a) => a.key.startsWith('event:')).map((a) => a.title), [], 'nothing configured, nothing scanned');
});

test('the keeper raises the same admin alerts from its own scan', async () => {
  const w = world('0x00000000000000000000000000000000000cafe0');
  const k = w.make('keeper');
  const { keeperTick } = await import('../src/ops/keeper.ts');
  const run = () => keeperTick(k.ctx, k.keys, { lease: k.lease, role: 'primary', waitForSafe: true, holder: k.holder });
  await run();
  emit(w, HOOK, feeHookAbi, 'PlatformRecipientAnnounced', { previous: HOLDERS.alice, next: HOLDERS.bob, readyAt: 1n });
  w.pass(60);
  await run();
  assert.ok(k.ctx.alerts.raised.some((a) => /PLATFORM RECIPIENT was announced/.test(a.title) && a.severity === 'page'), js(k.ctx.alerts.raised.map((a) => a.title)));
});

test('config: launchers are addresses, each once', () => {
  assert.throws(() => opsWorld({ config: (c) => (c.launchers = ['0xnope']) }), /config\.launchers\[0\] is not an address/);
  assert.throws(() => opsWorld({ config: (c) => (c.launchers = [LISTED, LISTED.toUpperCase().replace('0X', '0x')]) }), /lists an address twice/);
  assert.throws(() => opsWorld({ config: (c) => (c.launchers = LISTED) }), /must be a list/);
});
