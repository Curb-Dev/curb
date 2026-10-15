// The on-chain changes that need a human (design D.2.7): every role change
// announced or made on the distributor factory, every catalog proposal, every
// freeze and veto - and the admin powers outside holder sharing: the FeeHook's
// platform recipient and fee (announced 24 h ahead), a launcher admitted to
// the LaunchRegistry (no delay, and never removable), and an ownership move
// on any of the four Ownable2Step contracts (the factory, the catalog, the
// hook, the registry). Each one becomes an alert, once per log (the key is
// the log's position), with the Safe's answer ready to sign where there is
// one. A stolen Safe signer or deployer key shows up here first.
//
// Scanned incrementally from the last block seen (kept in /data); a cold
// start scans from config.eventsFromBlock.

import { decodeEventLog, encodeFunctionData, type Abi } from 'viem';
import type { Address } from '../calc/types.ts';
import type { ChainReader } from '../chain/reader.ts';
import type { RawLog } from '../chain/logs.ts';
import { catalogAbi, feeHookAbi, opsDistributorAbi, opsFactoryAbi, ownableAbi, registryAbi } from './abis.ts';
import type { Alert, ReadyCall } from './alerts.ts';
import { parseAbi, toEventSelector } from 'viem';

export interface ChainEvent {
  source: 'factory' | 'catalog' | 'distributor' | 'hook' | 'registry';
  address: Address;
  name: string;
  args: Record<string, unknown>;
  block: bigint;
  logIndex: bigint;
  txHash: string;
}

const FACTORY_EVENTS = ['PublisherAnnounced', 'PublisherUpdated', 'PublisherRevoked', 'KeeperPayeeAnnounced', 'KeeperPayeeUpdated', 'PendingCancelled', 'VetoerSet', 'VetoerRemovalAnnounced', 'Frozen', 'UnfreezeAnnounced', 'UnfreezeCancelled', 'Unfrozen'];
const CATALOG_EVENTS = ['FactoryAdmitted', 'FactoryProposed', 'FactoryCancelled', 'FactoryRetired', 'RecommendedSet'];
const DIST_EVENTS = ['RootVetoed', 'PushSkipped'];
const HOOK_EVENTS = ['PlatformRecipientAnnounced', 'PlatformFeeBpsAnnounced', 'PlatformRecipientCancelled', 'PlatformFeeBpsCancelled', 'PlatformRecipientUpdated', 'PlatformFeeBpsUpdated'];
const REGISTRY_EVENTS = ['LauncherSet'];
const OWNERSHIP_EVENTS = ['OwnershipTransferStarted', 'OwnershipTransferred'];

function topicsOf(abi: Abi, names: string[]): string[] {
  return names.map((n) => {
    const item = (abi as any[]).find((x) => x.type === 'event' && x.name === n);
    if (!item) throw new Error(`no event ${n}`);
    return toEventSelector(item);
  });
}

function decode(abi: Abi, source: ChainEvent['source'], l: RawLog): ChainEvent | null {
  try {
    const ev = decodeEventLog({ abi, topics: l.topics as any, data: l.data as `0x${string}`, strict: true });
    return { source, address: l.address.toLowerCase(), name: String(ev.eventName), args: ((ev as any).args ?? {}) as Record<string, unknown>, block: BigInt(l.blockNumber), logIndex: BigInt(l.logIndex), txHash: l.transactionHash.toLowerCase() };
  } catch {
    return null;
  }
}

export interface Watched {
  factory: Address;
  catalog: Address | null;
  distributors: Address[];
  hook?: Address | null;
  registry?: Address | null;
}

const ZERO = '0x0000000000000000000000000000000000000000';
const live = (a: Address | null | undefined): a is Address => !!a && a !== ZERO;

export async function scanEvents(r: ChainReader, o: Watched, from: bigint, to: bigint): Promise<ChainEvent[]> {
  if (to < from) return [];
  const out: ChainEvent[] = [];
  const scan = async (address: Address, abi: Abi, names: string[], source: ChainEvent['source']) => {
    for (const l of await r.logs({ address, topics: [topicsOf(abi, names)] }, from, to)) {
      const e = decode(abi, source, l);
      if (e) out.push(e);
    }
  };
  // every Ownable2Step contract is also scanned for its ownership moves
  await scan(o.factory, [...opsFactoryAbi, ...ownableAbi] as Abi, [...FACTORY_EVENTS, ...OWNERSHIP_EVENTS], 'factory');
  if (live(o.catalog)) await scan(o.catalog, [...catalogAbi, ...ownableAbi] as Abi, [...CATALOG_EVENTS, ...OWNERSHIP_EVENTS], 'catalog');
  if (live(o.hook)) await scan(o.hook, [...feeHookAbi, ...ownableAbi] as Abi, [...HOOK_EVENTS, ...OWNERSHIP_EVENTS], 'hook');
  if (live(o.registry)) await scan(o.registry, [...registryAbi, ...ownableAbi] as Abi, [...REGISTRY_EVENTS, ...OWNERSHIP_EVENTS], 'registry');
  for (const d of o.distributors) await scan(d, opsDistributorAbi, DIST_EVENTS, 'distributor');
  return out.sort((a, b) => (a.block === b.block ? Number(a.logIndex - b.logIndex) : a.block < b.block ? -1 : 1));
}

const ownerAbi = parseAbi([
  'function cancelPending()',
  'function addVetoer(address account)',
  'function cancel(address factory)',
  'function freeze()',
  'function cancelPlatformRecipient()',
  'function cancelPlatformFeeBps()',
  'function transferOwnership(address newOwner)',
  'function acceptOwnership()',
]);

const call = (what: string, to: string, fn: string, args: readonly unknown[] = []): ReadyCall => ({ what, to, data: encodeFunctionData({ abi: ownerAbi, functionName: fn as any, args: args as any }) });

const when = (at: unknown): string => {
  const t = Number(at);
  return Number.isFinite(t) && t > 0 ? new Date(t * 1000).toISOString() : String(at);
};

export interface AlertContext {
  factory: Address;
  catalog: Address | null;
  ours: Address[];
  hook?: Address | null;
  registry?: Address | null;
  /** The owner Safe (config.policyOwner); null when the config does not say. */
  policyOwner?: Address | null;
  /** The launchers the deployment admitted (config.launchers). */
  launchers?: Address[];
}

/** The alert for an event, or null for one that needs nobody. */
export function alertFor(e: ChainEvent, ctx: AlertContext): Alert | null {
  const key = `event:${e.address}:${e.txHash}:${e.logIndex}`;
  const a = e.args as Record<string, any>;
  const f = ctx.factory;
  const mine = (x: unknown) => ctx.ours.includes(String(x).toLowerCase());
  const lc = (x: unknown) => String(x).toLowerCase();
  const name = ({ factory: 'the HolderDistributorFactory', catalog: 'the SharingCatalog', hook: 'the FeeHook', registry: 'the LaunchRegistry', distributor: 'a distributor' } as const)[e.source];
  const isSafe = (x: unknown) => !!ctx.policyOwner && lc(x) === ctx.policyOwner;
  switch (e.name) {
    case 'PublisherAnnounced':
      return { key, severity: 'page', title: 'A new holder-sharing PUBLISHER was announced', text: `${a.next} can become the publisher from ${when(a.at)} (48 h). If the Safe did not mean this, cancel it before then.`, calls: [call('cancel every pending role change (owner Safe)', f, 'cancelPending'), call('freeze publishing (owner Safe or a vetoer)', f, 'freeze')] };
    case 'KeeperPayeeAnnounced':
      return { key, severity: 'page', title: 'A new KEEPER PAYEE was announced', text: `${a.next} can become the keeper payee from ${when(a.at)} (48 h).`, calls: [call('cancel every pending role change (owner Safe)', f, 'cancelPending')] };
    case 'VetoerRemovalAnnounced':
      return { key, severity: 'page', title: 'The REMOVAL OF A VETOER was announced', text: `${a.account} can be removed as a vetoer from ${when(a.at)} (48 h).${mine(a.account) ? ' That is THIS guardian.' : ''} Adding it again cancels the removal.`, calls: [call(`keep ${a.account} as a vetoer (owner Safe)`, f, 'addVetoer', [a.account])] };
    case 'UnfreezeAnnounced':
      return { key, severity: 'page', title: 'An UNFREEZE was announced', text: `Publishing can resume from ${when(a.at)} (48 h). Every root still pending then becomes payable unless vetoed first. If the Safe did not mean this, cancel it: the Safe with cancelPending, or any vetoer by freezing again (a freeze cancels an announced unfreeze, and the owner must announce again and wait 48 h).`, calls: [call('cancel the unfreeze (owner Safe)', f, 'cancelPending'), call('cancel the unfreeze by freezing again (owner Safe or a vetoer)', f, 'freeze')] };
    case 'UnfreezeCancelled':
      return { key, severity: 'warn', title: 'An announced unfreeze was CANCELLED by a freeze', text: `${a.by} froze again, which cancelled the unfreeze that was announced. Publishing stays frozen until the owner announces an unfreeze again and waits 48 h.${mine(a.by) ? ' That was THIS guardian.' : ''} If no vetoer or Safe signer meant this, a vetoer key may be in the wrong hands.` };
    case 'VetoerSet':
      return a.isVetoer
        ? { key, severity: 'warn', title: 'A vetoer was ADDED', text: `${a.account} is now a vetoer.` }
        : { key, severity: 'page', title: 'A vetoer was REMOVED', text: `${a.account} is no longer a vetoer.${mine(a.account) ? ' That is THIS guardian.' : ''}` };
    case 'Frozen':
      return { key, severity: 'page', title: 'Holder sharing is FROZEN', text: `Frozen by ${a.by}. No root is published or becomes payable; active roots keep paying.` };
    case 'Unfrozen':
      return { key, severity: 'warn', title: 'Holder sharing was unfrozen', text: 'Publishing resumes; pending roots that were not vetoed are payable now.' };
    case 'PublisherRevoked':
      return { key, severity: 'page', title: 'The publisher was REVOKED', text: `${a.previous} can no longer publish.` };
    case 'PublisherUpdated':
      return { key, severity: 'warn', title: 'The publisher changed', text: `${a.previous} -> ${a.next}` };
    case 'KeeperPayeeUpdated':
      return { key, severity: 'warn', title: 'The keeper payee changed', text: `${a.previous} -> ${a.next}` };
    case 'PendingCancelled':
      return { key, severity: 'info', title: 'Pending role changes were cancelled', text: 'The owner cancelled the announced publisher, keeper payee and unfreeze.' };
    case 'FactoryProposed':
      return { key, severity: 'page', title: 'A new DISTRIBUTOR FACTORY was proposed in the SharingCatalog', text: `${a.factory} is admitted from ${when(a.at)} (7 days) unless cancelled. Read its source before then.`, calls: ctx.catalog ? [call('cancel the proposal (owner Safe)', ctx.catalog, 'cancel', [a.factory])] : [] };
    case 'FactoryAdmitted':
      return { key, severity: 'warn', title: 'A distributor factory was admitted', text: `${a.factory} is approved for new enables.` };
    case 'FactoryRetired':
      return { key, severity: 'warn', title: 'A distributor factory was retired', text: `${a.factory} serves no new enables.` };
    case 'RecommendedSet':
      return { key, severity: 'info', title: 'The recommended distributor factory changed', text: `${a.factory}` };
    case 'FactoryCancelled':
      return { key, severity: 'info', title: 'A catalog proposal was cancelled', text: `${a.factory}` };
    case 'RootVetoed':
      return { key, severity: 'page', title: 'An epoch was VETOED', text: `Epoch ${a.epoch} of ${e.address} was vetoed (reason ${String(a.reason)}). The keeper recomputes the reopened range but publishes it only after an operator acknowledges this (curb-sharer ack-veto).`, distributor: e.address };

    // ---- the FeeHook: what every launch created afterwards pays the platform
    case 'PlatformRecipientAnnounced':
      return { key, severity: 'page', title: 'A new PLATFORM RECIPIENT was announced on the FeeHook', text: `${a.next} replaces ${a.previous} from ${when(a.readyAt)} (24 h): every launch created after the owner executes it pays the platform's share there. If the Safe did not mean this, cancel it before then.`, calls: [call('cancel the announced recipient (owner Safe)', e.address, 'cancelPlatformRecipient')] };
    case 'PlatformFeeBpsAnnounced':
      return { key, severity: 'page', title: 'A new PLATFORM FEE was announced on the FeeHook', text: `The platform's share of a launch's tax goes from ${a.previous} to ${a.next} bps from ${when(a.readyAt)} (24 h), for every launch created after the owner executes it. If the Safe did not mean this, cancel it before then.`, calls: [call('cancel the announced fee (owner Safe)', e.address, 'cancelPlatformFeeBps')] };
    case 'PlatformRecipientUpdated':
      return { key, severity: 'warn', title: 'The platform recipient changed', text: `${a.previous} -> ${a.next}, for launches created from now on.` };
    case 'PlatformFeeBpsUpdated':
      return { key, severity: 'warn', title: 'The platform fee changed', text: `${a.previous} -> ${a.next} bps, for launches created from now on.` };
    case 'PlatformRecipientCancelled':
      return { key, severity: 'info', title: 'An announced platform recipient was cancelled', text: `${a.pending}` };
    case 'PlatformFeeBpsCancelled':
      return { key, severity: 'info', title: 'An announced platform fee was cancelled', text: `${a.pending} bps` };

    // ---- the LaunchRegistry: a launcher is admitted at once and never removed.
    // What it can reach is what register() lets it record: only a NEW launch
    // whose curve is its own token's, on its own quote asset, graduating
    // through its own Graduator, and used by no launch before. An existing
    // launch's record, curve and balances are out of its reach; the launches
    // it creates run its code, not Curb's.
    case 'LauncherSet': {
      const listed = (ctx.launchers ?? []).includes(lc(a.launcher));
      return listed
        ? { key, severity: 'info', title: 'A listed launcher was admitted to the LaunchRegistry', text: `${a.launcher} (in config.launchers).` }
        : { key, severity: 'page', title: 'An UNLISTED LAUNCHER was admitted to the LaunchRegistry', text: `${a.launcher} can register NEW launches from now on, and the create form offers it at once; nothing can remove it (the registry is add-only). It cannot touch an existing launch: the registry records only a curve whose token, quote asset and Graduator are the new launch's own and that no launch used before. The launches it creates run its code, not Curb's. If the registry owner did not mean this, its key is compromised: hide the factory on the site (web/config.js hiddenFactories), warn users not to buy launches it creates, and treat the owner's key as stolen (RUNBOOK part 14). If it was meant, add it to config.launchers.` };
    }

    // ---- ownership of the four Ownable2Step contracts
    case 'OwnershipTransferStarted': {
      if (lc(a.newOwner) === ZERO) return { key, severity: 'info', title: `A pending ownership transfer of ${name} was cancelled`, text: `${e.address}` };
      if (isSafe(a.newOwner)) return { key, severity: 'warn', title: `The handover of ${name} to the owner Safe was started`, text: `${e.address} becomes the Safe's (${a.newOwner}) when it calls acceptOwnership(); until then ${a.previousOwner} still owns it.`, calls: [call(`accept ownership of ${name} (the owner Safe)`, e.address, 'acceptOwnership')] };
      return { key, severity: 'page', title: `An OWNERSHIP TRANSFER of ${name} was started`, text: `${a.previousOwner} offered ${e.address} to ${a.newOwner}${ctx.policyOwner ? `, which is not the owner Safe (${ctx.policyOwner})` : ''}. The moment ${a.newOwner} accepts, it holds every owner power of ${name}. If the owner did not mean this, cancel it now.`, calls: [call(`cancel the pending transfer (the current owner, ${a.previousOwner})`, e.address, 'transferOwnership', [ZERO])] };
    }
    case 'OwnershipTransferred': {
      if (lc(a.previousOwner) === ZERO) return { key, severity: 'info', title: `${name} was created`, text: `${e.address}, owned by ${a.newOwner}.` };
      if (isSafe(a.newOwner)) return { key, severity: 'warn', title: `${name} is now owned by the owner Safe`, text: `${e.address}: ${a.previousOwner} -> ${a.newOwner}.` };
      return { key, severity: 'page', title: `${name} has a NEW OWNER`, text: `${e.address}: ${a.previousOwner} -> ${a.newOwner}${ctx.policyOwner ? `, not the owner Safe (${ctx.policyOwner})` : ''}. Every owner power of ${name} is now that address's. If nobody meant this, treat it as a stolen key (RUNBOOK part 14).` };
    }
    default:
      return null;
  }
}
