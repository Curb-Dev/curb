// `check` proves the config's addresses belong together (gap item 38): each
// one read back from the contract that holds it, the launchers against
// config.launchers, the owners against config.policyOwner, and this host's
// keys against their roles. A swapped address is NOT OK, by name.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { opsWorld, testKey } from './sim/world.ts';
import { js } from './sim/helpers.ts';
import { checkSetup } from '../src/ops/runner.ts';

const OTHER = '0x00000000000000000000000000000000000bad01';
const L1 = '0x00000000000000000000000000000000000f0c01';
const L2 = '0x00000000000000000000000000000000000f0c02';

function wired(edit: (c: any) => void = () => {}) {
  const w = opsWorld({
    config: (c) => {
      c.registry = '0x00000000000000000000000000000000000a0002';
      c.hook = '0x00000000000000000000000000000000000a000b';
      c.lens = '0x00000000000000000000000000000000000a000c';
      c.policyOwner = '0x00000000000000000000000000000000000cafe0';
      c.launchers = [L1, L2];
      edit(c);
    },
  });
  w.sim.wiring.launchers.push(L1, L2);
  return w;
}

async function check(w: ReturnType<typeof opsWorld>, keys: Record<string, string> = { CURB_SHARER_PUBLISHER_KEY: testKey('publisher').reveal() }) {
  const c = await checkSetup(w.make('check').ctx, { env: keys, dir: '/nonexistent-secrets' });
  // every host here has no sink (the tests inject none); that one is not the point
  return { ...c, problems: c.problems.filter((p) => !/no alert sink/.test(p)) };
}

test('an honestly wired deployment: no problem, and each link is named', async () => {
  const w = wired();
  const c = await check(w);
  assert.deepEqual(c.problems, [], js(c));
  for (const l of [
    "the Graduator's registry: 0x00000000000000000000000000000000000a0002",
    "the distributor factory's graduator: 0x00000000000000000000000000000000000a0001",
    "the Graduator's sharing catalog: 0x00000000000000000000000000000000000a0006",
    'the SharingCatalog approves the distributor factory',
    "the lens's registry: 0x00000000000000000000000000000000000a0002",
    "the registry's required hook: 0x00000000000000000000000000000000000a000b",
    "launchers: the registry's 2 are config.launchers",
    'the distributor factory is owned by the owner Safe',
    'the LaunchRegistry is owned by the owner Safe',
    `the factory's publisher: ${w.signers.publisher.address} (this host holds its key)`,
  ]) assert.ok(c.lines.includes(l), `${l}\n${js(c.lines)}`);
});

test('every swapped or missing link is NOT OK, by name', async () => {
  const cases: [string, (w: ReturnType<typeof opsWorld>) => void, RegExp, ((c: any) => void)?][] = [
    ['the catalog the Graduator enables through', (w) => (w.sim.wiring.graduatorCatalog = OTHER), /the Graduator's sharing catalog is 0x0+bad01, the config says 0x0+a0006/],
    ['a catalog that does not approve the factory', (w) => (w.sim.wiring.catalogApproves = false), /does not approve the distributor factory/],
    ["the factory's graduator", (w) => (w.sim.wiring.factoryGraduator = OTHER), /the distributor factory's graduator is 0x0+bad01/],
    ["the factory's registry", (w) => (w.sim.wiring.factoryRegistry = OTHER), /the distributor factory's registry is 0x0+bad01/],
    ["the lens's registry", (w) => (w.sim.wiring.lensRegistry = OTHER), /the lens's registry is 0x0+bad01/],
    ["the lens's graduator", (w) => (w.sim.wiring.lensGraduator = OTHER), /the lens's graduator is 0x0+bad01/],
    ["the hook's registry", (w) => (w.sim.wiring.hookRegistry = OTHER), /the hook's registry is 0x0+bad01/],
    ["the registry's hook", (w) => (w.sim.wiring.requiredHook = OTHER), /the registry's required hook is 0x0+bad01/],
    ['an unlisted launcher', (w) => w.sim.wiring.launchers.push(OTHER), /admits launchers config\.launchers does not list: 0x0+bad01/],
    ['a listed launcher never admitted', (w) => w.sim.wiring.launchers.pop(), /lists addresses the registry never admitted: 0x0+f0c02/],
    ['a catalog owned by another', (w) => (w.sim.wiring.owners[w.sim.addr.catalog] = OTHER), /the SharingCatalog is owned by 0x0+bad01, not config\.policyOwner/],
    ['a hook owned by another, with another pending', (w) => { w.sim.wiring.owners[w.sim.addr.hook] = OTHER; w.sim.wiring.pendingOwners[w.sim.addr.hook] = L1; }, /the FeeHook is owned by 0x0+bad01, not config\.policyOwner .*\(pending: 0x0+f0c01\)/],
    ['a config registry the Graduator does not use', () => {}, /the Graduator's registry is 0x0+a0002, the config says 0x0+bad01/, (c) => (c.registry = OTHER)],
  ];
  for (const [name, swap, want, edit] of cases) {
    const w = wired(edit);
    if (edit) w.sim.setContract(OTHER, () => '0x'); // code at the configured address, so wiring is reached
    swap(w);
    const c = await check(w);
    assert.ok(c.problems.some((p) => want.test(p)), `${name}: ${js(c.problems)}`);
  }
});

test('the registry right after deploy: owned by the deployer and handed over to the Safe is fine; not handed over is not', async () => {
  const w = wired();
  w.sim.wiring.owners[w.sim.addr.registry] = OTHER;
  w.sim.wiring.pendingOwners[w.sim.addr.registry] = '0x00000000000000000000000000000000000cafe0';
  const c = await check(w);
  assert.deepEqual(c.problems, [], js(c.problems));
  assert.ok(c.lines.some((l) => /the LaunchRegistry is owned by 0x0+bad01, handed over to the owner Safe and waiting for its acceptOwnership\(\)/.test(l)), js(c.lines));
  delete w.sim.wiring.pendingOwners[w.sim.addr.registry];
  const c2 = await check(w);
  assert.ok(c2.problems.some((p) => /the LaunchRegistry is owned by 0x0+bad01, not config\.policyOwner/.test(p)), js(c2.problems));
});

test("this host's keys against their roles: a publisher that is not the factory's, a guardian that is no vetoer, a pusher not counted", async () => {
  const w = wired();
  const c = await check(w, { CURB_SHARER_PUBLISHER_KEY: testKey('thief').reveal(), CURB_SHARER_GUARDIAN_KEY: testKey('pusher').reveal(), CURB_SHARER_PUSHER_KEY: testKey('nobody').reveal() });
  assert.ok(c.problems.some((p) => p.startsWith(`publisher_key signs as ${w.signers.thief.address}, the factory's publisher is ${w.signers.publisher.address}`)), js(c.problems));
  assert.ok(c.problems.some((p) => p.startsWith(`guardian_key ${w.signers.pusher.address} is not a vetoer`)), js(c.problems));
  assert.ok(c.lines.some((l) => /^WARNING: pusher_key 0x[0-9a-f]{40} is not in sharing\.rules\.keeperKeys/.test(l)), js(c.lines));
  const ok = await check(w, { CURB_SHARER_GUARDIAN_KEY: testKey('guardian').reveal() });
  assert.ok(ok.lines.includes('guardian_key is a vetoer'), js(ok.lines));
});

test('a zero registry, hook or lens is NOT OK and the wiring is not read through it', async () => {
  const w = wired((c) => (c.lens = '0x' + '0'.repeat(40)));
  const c = await check(w);
  assert.ok(c.problems.includes('lens is the zero address'), js(c.problems));
  assert.ok(!c.problems.some((p) => /cannot be read/.test(p)), js(c.problems));
  const w2 = opsWorld();
  const c2 = await check(w2);
  assert.ok(c2.lines.includes('lens: not set (launches stuck in Waiting are not watched)'), js(c2.lines));
  assert.ok(c2.lines.includes("registry: not set (its launchers and owner are not watched)"), js(c2.lines));
});
