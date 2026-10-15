// `check` proves the config's addresses belong together (gap item 38).
//
// THE CONFIG IS TRANSCRIBED, so a swapped address used to pass `check` - it
// only asked whether each one had code - and fail at the first epoch, or
// never: a missed launcher or a wrong owner Safe only shows when an alert
// that should page does not. Each address is read back from the contracts
// that hold it: the catalog the Graduator enables through and whether it
// approves this distributor factory; the factory's graduator and registry;
// the lens's and the hook's registry and graduator; the registry's required
// hook and its launchers against config.launchers; the owners against
// config.policyOwner; and the keys this host holds against their roles.
// Every difference is a problem: `check` exits 2 and the host does not start.

import type { Abi } from 'viem';
import type { Address } from '../calc/types.ts';
import type { OpsContext } from './keeper.ts';
import { catalogAbi, opsFactoryAbi, ownableAbi, registryAbi, wiringAbi } from './abis.ts';
import { lensAbi } from './graduation.ts';
import { errorText } from './log.ts';

const ZERO = '0x0000000000000000000000000000000000000000';
const set = (a: Address | null | undefined): a is Address => !!a && a !== ZERO;

export async function checkWiring(ctx: OpsContext, head: bigint, keys: Record<string, string>): Promise<{ lines: string[]; problems: string[] }> {
  const { cfg } = ctx;
  const r0 = ctx.readers[0];
  const lines: string[] = [];
  const problems: string[] = [];
  const read = async <T>(abi: Abi, to: Address, fn: string, args: readonly unknown[] = []): Promise<T | undefined> => {
    try {
      return await r0.read<T>(abi, to, fn, args, head);
    } catch (e) {
      problems.push(`${fn}() of ${to} cannot be read: ${errorText(e)}`);
      return undefined;
    }
  };
  const addr = async (abi: Abi, to: Address, fn: string): Promise<Address | undefined> => {
    const x = await read<string>(abi, to, fn);
    return x === undefined ? undefined : String(x).toLowerCase();
  };
  const same = (what: string, got: Address | undefined, want: Address) => {
    if (got === undefined) return;
    if (got !== want) problems.push(`${what} is ${got}, the config says ${want}`);
    else lines.push(`${what}: ${got}`);
  };

  const grad = cfg.sharing.graduator;
  const factory = cfg.distributorFactory;
  // the registry every other contract must name: the Graduator's own
  const registry = await addr(wiringAbi, grad, 'registry');
  if (registry !== undefined && set(cfg.registry)) same("the Graduator's registry", registry, cfg.registry);

  // the distributor factory, under this Graduator and its catalog
  same("the distributor factory's graduator", await addr(wiringAbi, factory, 'graduator'), grad);
  if (registry !== undefined) same("the distributor factory's registry", await addr(wiringAbi, factory, 'registry'), registry);
  if (set(cfg.catalog)) {
    same("the Graduator's sharing catalog", await addr(wiringAbi, grad, 'sharingCatalog'), cfg.catalog);
    const ok = await read<boolean>(catalogAbi, cfg.catalog, 'isApproved', [factory]);
    if (ok === false) problems.push(`the SharingCatalog ${cfg.catalog} does not approve the distributor factory ${factory}: no launch can enable sharing through it`);
    else if (ok) lines.push('the SharingCatalog approves the distributor factory');
  }

  // the lens and the hook read the same registry
  if (set(cfg.lens)) {
    if (registry !== undefined) same("the lens's registry", await addr(lensAbi, cfg.lens, 'registry'), registry);
    same("the lens's graduator", await addr(lensAbi, cfg.lens, 'graduator'), grad);
  }
  if (set(cfg.hook) && registry !== undefined) {
    same("the hook's registry", await addr(wiringAbi, cfg.hook, 'registry'), registry);
    same("the registry's required hook", await addr(registryAbi, registry, 'requiredHook'), cfg.hook);
  }

  // the launchers: exactly the config's (an unlisted one pages when it is admitted)
  if (registry !== undefined && set(cfg.registry)) {
    const n = await read<bigint>(registryAbi, registry, 'launcherCount');
    if (n !== undefined) {
      const onChain: Address[] = [];
      for (let i = 0n; i < BigInt(n); i++) {
        const l = await read<string>(registryAbi, registry, 'launcherAt', [i]);
        if (l !== undefined) onChain.push(String(l).toLowerCase());
      }
      const unlisted = onChain.filter((l) => !cfg.launchers.includes(l));
      const gone = cfg.launchers.filter((l) => !onChain.includes(l));
      if (unlisted.length) problems.push(`the registry admits launchers config.launchers does not list: ${unlisted.join(', ')}`);
      if (gone.length) problems.push(`config.launchers lists addresses the registry never admitted: ${gone.join(', ')}`);
      if (!unlisted.length && !gone.length) lines.push(`launchers: the registry's ${onChain.length} are config.launchers`);
    }
  }

  // the owners: the owner Safe, or (the registry, right after deploy) about to be
  if (set(cfg.policyOwner)) {
    const owned: [string, Address | null][] = [['the distributor factory', factory], ['the SharingCatalog', set(cfg.catalog) ? cfg.catalog : null], ['the FeeHook', set(cfg.hook) ? cfg.hook : null], ['the LaunchRegistry', registry !== undefined && set(cfg.registry) ? registry : null]];
    for (const [what, at] of owned) {
      if (!at) continue;
      const owner = await addr(ownableAbi, at, 'owner');
      if (owner === undefined) continue;
      if (owner === cfg.policyOwner) {
        lines.push(`${what} is owned by the owner Safe`);
        continue;
      }
      const pending = await addr(ownableAbi, at, 'pendingOwner');
      if (pending === cfg.policyOwner) lines.push(`${what} is owned by ${owner}, handed over to the owner Safe and waiting for its acceptOwnership()`);
      else problems.push(`${what} is owned by ${owner}, not config.policyOwner ${cfg.policyOwner}${pending && pending !== ZERO ? ` (pending: ${pending})` : ''}`);
    }
  }

  // the keys this host holds, against their roles
  const fx = async (fn: string, args: readonly unknown[] = []) => read<unknown>(opsFactoryAbi, factory, fn, args);
  const publisher = await fx('publisher');
  if (publisher !== undefined) {
    const p = String(publisher).toLowerCase();
    if (keys.publisher && keys.publisher !== p) problems.push(`publisher_key signs as ${keys.publisher}, the factory's publisher is ${p}: this host would publish nothing`);
    else lines.push(`the factory's publisher: ${p}${keys.publisher ? ' (this host holds its key)' : ''}`);
  }
  if (keys.guardian) {
    const v = await fx('isVetoer', [keys.guardian]);
    if (v === false) problems.push(`guardian_key ${keys.guardian} is not a vetoer on the factory: it could only alert`);
    else if (v) lines.push('guardian_key is a vetoer');
  }
  for (const who of ['publisher', 'pusher']) {
    if (keys[who] && !cfg.sharing.rules.keeperKeys.includes(keys[who])) lines.push(`WARNING: ${who}_key ${keys[who]} is not in sharing.rules.keeperKeys: its gas never counts in the keeper fee (a new rules version adds it, RUNBOOK 7.1)`);
  }
  return { lines, problems };
}
