// The keeper tick (design D.2.6). Idempotent: every decision is re-derived
// from the chain, so running it twice, on two machines, or after a crash at
// any point does no harm - the chain refuses what was already done.
//
//   1. discover the distributors; read every distributor's roots and totals
//      and the factory's roles on BOTH providers at one block, abort with no
//      writes if they differ
//   2. activate a ripe root (never while frozen: activate() reverts Frozen)
//   3. push the active roots' leaves that are due (push.ts)
//   4. payKeeper()
//   5. an epoch, when one is due: harvest -> wait until its block is safe ->
//      compute on both providers -> publish the file (site + pins + read
//      back) -> publishMany, batched across the distributors that are due
//   6. status, heartbeat and alerts, and whether the tick finished cleanly
//      (liveness.ts: a keeper whose ticks keep failing pages, and its
//      heartbeat tells the standby so)
//   7. launches stuck in Waiting, read through the lens: alerted, and
//      graduated with the permissionless graduate() (graduation.ts)
//
// Writes happen only while this keeper holds the lease (lease.ts).

import type { Address, EpochFile, EpochResult } from '../calc/types.ts';
import { treeOf } from '../calc/file.ts';
import { CHUNK_ACCOUNTS } from '../calc/merkle.ts';
import { chunkFetcher, readWholeEpoch } from '../epoch-chunks.ts';
import { encodeFunctionData, decodeEventLog, keccak256, toHex } from 'viem';
import { discoverSharing, readEpochHistory, type LaunchMeta } from '../chain/indexer.ts';
import type { ChainReader } from '../chain/reader.ts';
import { prepareEpoch, ProviderDisagreement, EpochNotReady, type KeeperJournalEntry } from '../epoch.ts';
import { loadActiveState, publishArgs } from '../state.ts';
import type { OpsConfig } from './config.ts';
import { publicSharingConfig, diffSharingConfig } from './config.ts';
import { opsDistributorAbi, opsFactoryAbi } from './abis.ts';
import { crossChecked, commonHead, latestHarvest, previewHarvest, moneyOf, tokenPriceOf, stuckIncome, l1FeeOf, gasPrice, MetaCache, type DistView, type FactoryView } from './chainview.ts';
import type { Alerter } from './alerts.ts';
import type { EpochFiles } from './files.ts';
import type { DataRepo, PublicRepo } from './github.ts';
import { ago, trackLiveness, type Liveness } from './liveness.ts';
import { graduationWatch } from './graduation.ts';
import type { Pinner } from './pinners.ts';
import type { Logger } from './log.ts';
import { errorText } from './log.ts';
import type { Store } from './store.ts';
import { OutOfEth, StuckTx, WouldRevert, type TxSender } from './tx.ts';
import { publishFile, writeLatest, type Published } from './publish.ts';
import { planPushes, unpaidValue0, type LeafState } from './push.ts';
import { scanEvents, alertFor } from './events.ts';
import type { Lease } from './lease.ts';
import { primaryHeartbeatAge, writeHeartbeat, LEASE_PATH, STATUS_PATH, STANDBY_STATUS_PATH } from './lease.ts';
import { fileCid, ipfsUri } from './cid.ts';
import { readAcks } from './acks.ts';

export interface OpsContext {
  cfg: OpsConfig;
  readers: ChainReader[];
  store: Store;
  files: EpochFiles;
  repo: DataRepo | null;
  /** The data repo read without a token (the verifiers' heartbeat watch). */
  publicRepo?: PublicRepo | null;
  /** Who this process is in heartbeats and the lease. */
  holder?: string;
  pinners: Pinner[];
  alerts: Alerter;
  log: Logger;
  meta: MetaCache;
  /** Wall clock, ms. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Run on one provider (a local rehearsal only). */
  allowSingleProvider?: boolean;
  /** Read-back retry pacing for publishing (tests make it instant). */
  refetch?: { tries: number; delayMs: number };
}

export interface KeeperKeys {
  publisher: TxSender | null;
  pusher: TxSender | null;
}

export interface TickOptions {
  lease: Lease;
  role: 'primary' | 'standby';
  /** Wait (up to safeWaitSec) for a fresh harvest to become safe in this tick. */
  waitForSafe: boolean;
  holder: string;
}

export interface TickReport {
  ok: boolean;
  acted: boolean;
  actions: string[];
  notes: string[];
  errors: string[];
  published: { distributor: Address; epoch: bigint; uri: string; contentHash: string }[];
  status: Record<string, unknown>;
}

class NoLease extends Error {
  constructor() {
    super('another keeper holds the lease; no writes this tick');
    this.name = 'NoLease';
  }
}

class Abort extends Error {}

const HARVEST_DATA = encodeFunctionData({ abi: opsDistributorAbi, functionName: 'harvest' });
const ACTIVATE_DATA = encodeFunctionData({ abi: opsDistributorAbi, functionName: 'activate' });
const PAY_KEEPER_DATA = encodeFunctionData({ abi: opsDistributorAbi, functionName: 'payKeeper' });
const ROOT_ACTIVATED = keccak256(toHex('RootActivated(uint32,bytes32)'));
const ROOT_VETOED = keccak256(toHex('RootVetoed(uint32,bytes32)'));
/** How often a standby with no primary at all says it is acting (below). */
export const STANDBY_ALONE_COOLDOWN_SEC = 7 * 86400;

interface Due {
  d: Address;
  meta: LaunchMeta;
  result: EpochResult;
  uri: string;
  T: bigint;
}

export async function keeperTick(ctx: OpsContext, keys: KeeperKeys, o: TickOptions): Promise<TickReport> {
  const rep: TickReport = { ok: true, acted: false, actions: [], notes: [], errors: [], published: [], status: {} };
  const { cfg, store, log } = ctx;
  const r0 = ctx.readers[0];
  const k = cfg.keeper;
  const nowS = () => Math.floor(ctx.now() / 1000);
  const disabled = new Set<string>(); // keys that cannot send this tick

  // ---- standby: only when the primary is silent - no recent heartbeat, or
  // a heartbeat whose last CLEAN tick is as old (a primary that beats while
  // every tick fails pays nobody)
  if (o.role === 'standby') {
    if (!ctx.repo) {
      rep.notes.push('standby without a data repo cannot see the primary heartbeat; not acting');
      return rep;
    }
    let hb: Awaited<ReturnType<typeof primaryHeartbeatAge>>;
    try {
      hb = await primaryHeartbeatAge(ctx.repo, ctx.now);
    } catch (e) {
      // unreadable: the lease is in the same repo, so it could not act anyway
      // (a refused token has already paged, through the repo's onDenied)
      rep.ok = false;
      rep.errors.push(`the primary heartbeat could not be read: ${errorText(e)}`);
      return rep;
    }
    const { age, cleanAge, beat } = hb;
    if (age < cfg.lease.standbyAfterSec && cleanAge < cfg.lease.standbyAfterSec) {
      rep.notes.push(`the primary (${beat?.holder}) beat ${age}s ago; standby stays idle`);
      // an idle run did its job: a failing streak from an earlier stand-in
      // must not page at the first failure of the next one
      await trackLiveness(ctx, 'standby', true, null, cfg.keeper.failingAfterSec);
      store.flush();
      return rep;
    }
    rep.notes.push(
      age === Infinity
        ? 'no primary heartbeat at all; standby acts'
        : age >= cfg.lease.standbyAfterSec
          ? `the primary is silent for ${age}s; standby acts`
          : `the primary (${beat?.holder}) beats but has had no clean tick for ${cleanAge}s (${beat?.errors?.[0] ?? 'no error given'}); standby acts`,
    );
    // NO PRIMARY HEARTBEAT AT ALL is the deployment where the standby IS the
    // keeper: the owner's decision of 16 October 2026, no keeper host, the
    // GitHub standby running alone (RUNBOOK part 9). Acting is then its normal
    // state, not news, and at the usual hourly cooldown it filled the alert
    // chat with 24 warnings a day. It is said once a week instead. A primary
    // that beat and went silent, or beats with no clean tick, is news: that
    // still warns at the usual cooldown.
    await ctx.alerts.raise(
      { key: 'standby-acting', severity: 'warn', title: 'The standby keeper is acting', text: rep.notes[rep.notes.length - 1] },
      age === Infinity ? { cooldownSec: STANDBY_ALONE_COOLDOWN_SEC } : {},
    );
  }
  /** Another keeper held the lease: this one wrote nothing, so it reports nothing. */
  let blocked = false;

  // Every write first makes sure this keeper still holds the lease: taken on
  // the first write, renewed past half its TTL, and the tick's writes stop
  // the moment it is lost (NoLease ends the tick).
  const act = async (): Promise<void> => {
    if (o.lease.valid()) {
      if (!(await o.lease.keep())) throw new NoLease();
      return;
    }
    if (!(await o.lease.acquire())) throw new NoLease();
  };

  const send = async (who: 'publisher' | 'pusher', req: { to: string; data: string; label: string; distributors: string[]; maxGasPriceWei?: bigint }) => {
    const s = keys[who];
    if (!s) throw new Error(`no ${who} key is configured`);
    if (disabled.has(who)) throw new Error(`the ${who} key is stopped for this tick`);
    await act();
    try {
      const sent = await s.send(req);
      rep.acted = true;
      rep.actions.push(`${req.label} ${sent.hash}${sent.receipt.status ? '' : ' REVERTED'}`);
      return sent;
    } catch (e) {
      if (e instanceof OutOfEth) {
        disabled.add(who);
        await ctx.alerts.raise({ key: `out-of-eth:${who}`, severity: 'page', title: `The ${who} key is OUT OF ETH`, text: `${e.message}. It stops sending; income waits in the distributors until it is funded (${s.address}).` });
      } else if (e instanceof StuckTx) {
        disabled.add(who);
        await ctx.alerts.raise({ key: `stuck:${who}`, severity: 'page', title: `A ${who} transaction is stuck`, text: e.message });
      }
      throw e;
    }
  };

  try {
    // ---- 0. a transaction the last run left open (crashed, or stuck past its
    // replacements) is settled FIRST, at its own nonce, so every decision
    // below sees its effect instead of sending it a second time.
    for (const who of ['pusher', 'publisher'] as const) {
      const s = keys[who];
      if (!s || !s.open()) continue;
      await act();
      try {
        const done = await s.resume();
        if (done) {
          rep.acted = true;
          rep.actions.push(`resumed ${done.hash}`);
        }
      } catch (e) {
        if (!(e instanceof StuckTx)) throw e;
        disabled.add(who);
        await ctx.alerts.raise({ key: `stuck:${who}`, severity: 'page', title: `A ${who} transaction is stuck`, text: e.message });
      }
    }

    // ---- 1. where the chain is, which launches share, what they hold
    const latest = await commonHead(ctx.readers, 'latest');
    const safe = await commonHead(ctx.readers, 'safe');
    const ds = await discover(ctx, safe.number);

    let view: { factory: FactoryView; dists: DistView[] };
    try {
      view = await crossChecked(ctx.readers, cfg.distributorFactory, ds, latest.number);
    } catch (e) {
      if (e instanceof ProviderDisagreement) {
        await ctx.alerts.raise({ key: 'rpc-disagreement', severity: 'page', title: 'The RPC providers DISAGREE', text: `${e.message}. The keeper wrote nothing.` });
        rep.ok = false;
        rep.errors.push(e.message);
        return rep;
      }
      throw e;
    }
    const f = view.factory;
    rep.status = { latest: latest.number.toString(), safe: safe.number.toString(), frozen: f.frozen, distributors: ds.length };

    await keyChecks(ctx, keys, f, rep);
    await roleEvents(ctx, ds, safe.number, keys);
    if (f.frozen) await ctx.alerts.raise({ key: 'frozen', severity: 'page', title: 'Holder sharing is frozen', text: 'No root is published or activated; active roots keep paying.' }, { cooldownSec: cfg.alerts.reminderSec });
    const canPublish = !!keys.publisher && keys.publisher.address === f.publisher && !f.frozen;

    const launches: Record<string, unknown>[] = [];
    const due: Due[] = [];
    for (const v0 of view.dists) {
      let v = v0;
      const d = v.d;
      const line: Record<string, unknown> = { distributor: d, active: v.active.epoch.toString(), pending: v.pending.payableAt ? v.pending.epoch.toString() : null, lastProposed: v.lastProposedEpoch.toString() };
      launches.push(line);
      try {
        const meta = await ctx.meta.get(r0, cfg.sharing.graduator, d, latest.number);
        line.token = meta.token;

        // ---- 2. activate a ripe root
        if (v.pending.payableAt !== 0n && latest.timestamp >= v.pending.payableAt) {
          if (f.frozen) {
            line.activate = 'held by the freeze';
          } else if (keys.pusher && !disabled.has('pusher')) {
            try {
              await send('pusher', { to: d, data: ACTIVATE_DATA, label: `activate epoch ${v.pending.epoch} of ${d}`, distributors: [d] });
              v = (await crossChecked(ctx.readers, cfg.distributorFactory, [d], (await commonHead(ctx.readers, 'latest')).number)).dists[0];
              // the line says where the launch is AFTER this tick's actions
              line.active = v.active.epoch.toString();
              line.pending = v.pending.payableAt ? v.pending.epoch.toString() : null;
            } catch (e) {
              if (e instanceof WouldRevert && e.errorName === 'Frozen') {
                line.activate = 'refused: Frozen';
                await ctx.alerts.raise({ key: 'activate-frozen', severity: 'warn', title: 'activate() reverted Frozen', text: `Epoch ${v.pending.epoch} of ${d} is held by the freeze.`, distributor: d });
              } else if (e instanceof WouldRevert && e.errorName === 'NothingPending') {
                line.activate = 'already activated';
              } else throw e;
            }
          }
        }

        // ---- 3. push
        if (v.active.epoch > 0n && keys.pusher && !disabled.has('pusher')) {
          line.push = await pushActive(ctx, send, v, meta, latest, rep);
        }

        // ---- 4. payKeeper
        const owedKeeper = v.active.cumKeeper0 - v.keeperPaid0;
        if (owedKeeper > 0n && keys.pusher && !disabled.has('pusher')) {
          const money = await moneyOf(r0, { quote: meta.quoteToken, quoteIsWeth: meta.quoteToken === cfg.sharing.weth, feeds: cfg.sharing.feeds[meta.quoteToken] ?? null, ethUsd: cfg.ethUsdFeed }, latest.number);
          const cost0 = ((k.gas.payKeeper * (await gasPrice(r0)) + (await l1FeeOf(r0, 120))) * money.P) / 10n ** 18n;
          if (money.P > 0n && owedKeeper >= k.payKeeperMinFactor * cost0) {
            await send('pusher', { to: d, data: PAY_KEEPER_DATA, label: `payKeeper of ${d} (${owedKeeper})`, distributors: [d] });
          } else line.payKeeper = `waits (${owedKeeper} owed)`;
        }

        // ---- 5. is an epoch due?
        if (!canPublish) {
          line.epoch = f.frozen ? 'frozen' : 'this key is not the publisher';
          continue;
        }
        const d5 = await epochDue(ctx, v, meta, latest, safe, o, send, rep);
        line.epoch = d5.note;
        if (d5.due) due.push(d5.due);
      } catch (e) {
        if (e instanceof NoLease || e instanceof Abort) throw e;
        if (e instanceof ProviderDisagreement) {
          await ctx.alerts.raise({ key: 'rpc-disagreement', severity: 'page', title: 'The RPC providers DISAGREE', text: `${e.message}. The keeper wrote nothing more.`, distributor: d });
          throw new Abort(e.message);
        }
        rep.ok = false;
        rep.errors.push(`${d}: ${errorText(e)}`);
        line.error = errorText(e);
        log.error('distributor step failed', { distributor: d, error: errorText(e) });
      }
    }

    // ---- 5b. publish what is due, in one publishMany
    if (due.length) await publishDue(ctx, act, send, due, rep);
    for (const p of rep.published) {
      const line = launches.find((l) => l.distributor === p.distributor);
      if (line) line.pending = p.epoch.toString();
    }
    rep.status.launches = launches;

    // ---- 7. launches stuck in Waiting (graduation.ts): not holder sharing,
    // but a launch nobody can trade until somebody sends graduate()
    try {
      await graduationWatch(ctx, latest.number, keys.pusher && !disabled.has('pusher') ? (who, req) => send(who, req) : null, rep);
    } catch (e) {
      if (e instanceof NoLease || e instanceof Abort) throw e;
      rep.ok = false;
      rep.errors.push(`the Waiting watch: ${errorText(e)}`);
    }
  } catch (e) {
    if (e instanceof NoLease) {
      blocked = true;
      rep.notes.push(e.message);
      try {
        await leaseBlocked(ctx, o.lease, rep);
      } catch (e2) {
        log.warn('the blocked lease not recorded', { error: errorText(e2) });
      }
    } else if (e instanceof Abort) {
      rep.ok = false;
      rep.errors.push(e.message);
    } else {
      rep.ok = false;
      rep.errors.push(errorText(e));
      log.error('keeper tick failed', { error: errorText(e) });
    }
  } finally {
    // a tick the lease did not stop ends any streak of blocked ones
    if (!blocked) store.delete('leaseBlocked');
    let live: Liveness & { changed: boolean } = { lastOkAt: null, failingSince: null, lastError: null, changed: false };
    try {
      live = await trackLiveness(ctx, o.role === 'primary' ? 'keeper' : 'standby', rep.ok, rep.errors[0] ?? null, cfg.keeper.failingAfterSec);
    } catch (e) {
      log.warn('liveness not recorded', { error: errorText(e) });
    }
    try {
      await writeStatus(ctx, o, rep, live, blocked);
    } catch (e) {
      log.warn('status not written', { error: errorText(e) });
    }
    if (o.lease.held) {
      try {
        await o.lease.release();
      } catch (e) {
        log.warn('lease not released (it expires by itself)', { error: errorText(e) });
      }
    }
    store.flush();
  }
  return rep;
}

// ---------------------------------------------------------------- pieces

/** HolderSharingEnabled up to the safe head, cached incrementally.
 *
 *  The guardian asks with `allProviders` and `head`: every provider is
 *  scanned and their answers joined, so one provider that leaves a
 *  distributor out cannot hide it, and the blocks past the safe head up to
 *  `head` are scanned too (not cached: they may still be reorganised), so a
 *  launch that switched sharing on minutes ago is watched at once. */
export async function discover(ctx: OpsContext, safe: bigint, o: { allProviders?: boolean; head?: bigint } = {}): Promise<Address[]> {
  const readers = o.allProviders ? ctx.readers : [ctx.readers[0]];
  const st = ctx.store.get<{ block: bigint; ds: Address[] }>('discovery', { block: ctx.cfg.sharing.graduatorFromBlock - 1n, ds: [] });
  if (safe > st.block) {
    for (const r of readers) {
      const found = await discoverSharing(r, ctx.cfg.sharing.graduator, st.block + 1n, safe);
      for (const s of found) if (!st.ds.includes(s.distributor)) st.ds.push(s.distributor);
    }
    st.block = safe;
    ctx.store.set('discovery', st);
  }
  const ds = [...st.ds];
  if (o.head !== undefined && o.head > st.block) {
    for (const r of readers) for (const s of await discoverSharing(r, ctx.cfg.sharing.graduator, st.block + 1n, o.head)) if (!ds.includes(s.distributor)) ds.push(s.distributor);
  }
  return ds;
}

/** Every distributor bound up to block T, for an epoch's exclusions (the
 *  other launches' distributors), from each provider's own scan of the
 *  Graduator's HolderSharingEnabled logs. Each scan is kept in /data and
 *  advanced over new blocks only, so a keeper, verifier or guardian does not
 *  rescan from graduatorFromBlock for every epoch it computes or checks.
 *  Undefined - and gatherEpoch then scans on each provider itself, as before
 *  - when T is above `safe` (the common safe head the caller read), when the
 *  providers' lists up to T differ, or when a scan names a distributor or a
 *  token twice: a provider that leaves a distributor out or invents one
 *  still stops the epoch as a disagreement, never a silent change of its
 *  exclusions. */
export async function boundDistributors(ctx: OpsContext, T: bigint, safe: bigint): Promise<Address[] | undefined> {
  const { cfg } = ctx;
  if (T > safe) return undefined;
  // a copy: a check abandoned at its deadline may still be running this
  const all = structuredClone(ctx.store.get<Record<string, { block: bigint; bound: [Address, Address, bigint][] }>>('boundDistributors', {}));
  const lists: string[] = [];
  let out: Address[] = [];
  for (const [i, r] of ctx.readers.entries()) {
    const key = `${i}:${r.label}`;
    const st = all[key] ?? { block: cfg.sharing.graduatorFromBlock - 1n, bound: [] };
    if (T > st.block) {
      for (const s of await discoverSharing(r, cfg.sharing.graduator, st.block + 1n, T)) {
        if (st.bound.some(([d, t]) => d === s.distributor || t === s.token)) return undefined;
        st.bound.push([s.distributor, s.token, s.block]);
      }
      st.block = T;
      all[key] = st;
    }
    const ds = st.bound.filter(([, , b]) => b <= T).map(([d]) => d);
    lists.push(ds.join(','));
    if (i === 0) out = ds;
  }
  ctx.store.set('boundDistributors', all);
  return lists.every((l) => l === lists[0]) ? out : undefined;
}

/** Another holder refused this keeper the lease. A streak of such ticks
 *  longer than an honest holder ever keeps it (one standby run plus the
 *  TTL: lease.blockedAfterSec) is a failure, not a note: whoever can write
 *  the data repo can pin ops/lease.json, and every keeper write stops while
 *  each tick still ended "ok" and the heartbeat kept the standby and the
 *  verifiers quiet. From then on the tick is not ok (lastOkAt goes stale),
 *  the error names the holder and when its lease ends, and it pages. */
async function leaseBlocked(ctx: OpsContext, lease: Lease, rep: TickReport): Promise<void> {
  const nowS = Math.floor(ctx.now() / 1000);
  const other = lease.other;
  const st = ctx.store.update<{ since?: number; holder?: string | null; expiresAt?: number | null }>('leaseBlocked', {}, (s) => {
    s.since ??= nowS;
    s.holder = other?.holder ?? null;
    s.expiresAt = other?.expiresAt ?? null;
  });
  rep.status.leaseBlocked = { since: st.since, holder: st.holder, expiresAt: st.expiresAt };
  const age = nowS - st.since!;
  if (age <= ctx.cfg.lease.blockedAfterSec) return;
  const who = st.holder ? `"${st.holder}"` : 'another holder';
  const msg = `${who} has kept the data repo lease (${LEASE_PATH}) from this keeper for ${ago(age)}, longer than any keeper of yours holds it (lease.blockedAfterSec ${ctx.cfg.lease.blockedAfterSec} s); its lease runs until ${st.expiresAt ? new Date(st.expiresAt * 1000).toISOString() : 'an unknown time'}`;
  rep.ok = false;
  rep.errors.push(msg);
  await ctx.alerts.raise(
    {
      key: 'lease-blocked',
      severity: 'page',
      title: 'Another holder KEEPS THE KEEPER LEASE',
      text: `${msg}. No keeper write lands while it lasts: no epoch, activation or push (nothing is lost; the income waits in the distributors). If no keeper of yours runs as ${who}, a data repo token is in the wrong hands: revoke it (RUNBOOK part 12), then delete ${LEASE_PATH} in the data repo.`,
    },
    { cooldownSec: ctx.cfg.alerts.reminderSec },
  );
}

async function keyChecks(ctx: OpsContext, keys: KeeperKeys, f: FactoryView, rep: TickReport): Promise<void> {
  const { cfg } = ctx;
  for (const [who, s] of Object.entries(keys) as [string, TxSender | null][]) {
    if (!s) continue;
    const bal = await s.balance();
    (rep.status.keys ??= {} as any)[who] = { address: s.address, balanceWei: bal.toString() };
    if (bal < cfg.keeper.lowEthWei) {
      await ctx.alerts.raise({ key: `low-eth:${who}`, severity: 'warn', title: `The ${who} key is LOW ON ETH`, text: `${s.address} holds ${bal} wei (alert below ${cfg.keeper.lowEthWei}). Fund it before it runs out; payouts wait while it is empty.` }, { cooldownSec: cfg.alerts.reminderSec });
    }
    if (!cfg.sharing.rules.keeperKeys.includes(s.address)) {
      await ctx.alerts.raise({ key: `not-a-keeper-key:${who}`, severity: 'warn', title: `The ${who} key is not in rules.keeperKeys`, text: `${s.address} pays gas the keeper fee will never count. Add it to the rules (a new rules version).` }, { cooldownSec: cfg.alerts.reminderSec });
    }
  }
  if (keys.publisher && keys.publisher.address !== f.publisher) {
    await ctx.alerts.raise({ key: 'publisher-mismatch', severity: 'page', title: 'This keeper is NOT the factory publisher', text: `The factory's publisher is ${f.publisher}; this keeper signs as ${keys.publisher.address}. It pushes and pays but publishes nothing.` }, { cooldownSec: cfg.alerts.reminderSec });
  }
}

/** Role and catalog events since the last scan -> alerts. */
export async function roleEvents(ctx: OpsContext, ds: Address[], to: bigint, keys: { publisher?: TxSender | null; pusher?: TxSender | null; guardian?: TxSender | null }): Promise<void> {
  const { cfg, store } = ctx;
  const from = store.get<bigint>('eventsBlock', cfg.eventsFromBlock - 1n) + 1n;
  if (to < from) return;
  const evs = await scanEvents(ctx.readers[0], { factory: cfg.distributorFactory, catalog: cfg.catalog, distributors: ds, hook: cfg.hook, registry: cfg.registry }, from, to);
  const ours = Object.values(keys).filter(Boolean).map((s) => s!.address);
  for (const e of evs) {
    if (e.name === 'PushSkipped') {
      recordSkip(ctx, e.address, String(e.args.account).toLowerCase(), Number((await ctx.readers[0].block(e.block)).timestamp), null);
      continue;
    }
    if (e.name === 'RootVetoed') recordVeto(ctx, e.address, { epoch: String(e.args.epoch), reason: String(e.args.reason).toLowerCase(), block: e.block.toString(), at: Number((await ctx.readers[0].block(e.block)).timestamp) });
    const a = alertFor(e, { factory: cfg.distributorFactory, catalog: cfg.catalog, ours, hook: cfg.hook, registry: cfg.registry, policyOwner: cfg.policyOwner, launchers: cfg.launchers });
    if (a) await ctx.alerts.raise(a, { cooldownSec: 365 * 86400 });
  }
  store.set('eventsBlock', to);
}

export interface VetoSeen {
  epoch: string;
  /** The reason word, lowercased. */
  reason: string;
  block: string;
  /** Its block's timestamp. */
  at: number;
}

/** Remembers each RootVetoed the event scan meets, per distributor (the
 *  guardian's repeat rule reads them instead of the whole history). */
export function recordVeto(ctx: OpsContext, d: Address, v: VetoSeen): void {
  ctx.store.update<Record<string, VetoSeen[]>>('vetoLog', {}, (m) => {
    const list = (m[d] ??= []);
    if (list.some((x) => x.block === v.block && x.epoch === v.epoch)) return;
    list.push(v);
    if (list.length > 50) list.splice(0, list.length - 50);
  });
}

export function recordSkip(ctx: OpsContext, d: Address, account: Address, at: number, unpaidValue0: bigint | null): void {
  ctx.store.update<Record<string, Record<string, { at: number; unpaidValue0: bigint | null }>>>('skips', {}, (s) => {
    const m = (s[d] ??= {});
    const prev = m[account];
    if (!prev || prev.at <= at) m[account] = { at, unpaidValue0: unpaidValue0 ?? prev?.unpaidValue0 ?? null };
  });
}

/** The URI the chain recorded for epoch N of D (from its RootPublished). */
async function uriOf(ctx: OpsContext, d: Address, epoch: bigint, sinceBlock: bigint, toBlock: bigint): Promise<string> {
  const key = `${d}:${epoch}`;
  const cache = ctx.store.get<Record<string, string>>('uris', {});
  if (cache[key]) return cache[key];
  const { published } = await readEpochHistory(ctx.readers[0], d, sinceBlock, toBlock);
  for (const p of published) cache[`${d}:${p.epoch}`] = p.uri;
  ctx.store.set('uris', cache);
  if (!cache[key]) throw new Error(`no RootPublished for epoch ${epoch} of ${d}`);
  return cache[key];
}

/** The active epoch's file, checked against the chain's contentHash: the
 *  whole of it, every chunk its index names too (each checked against the
 *  sha256 the index gives). */
async function activeFile(ctx: OpsContext, v: DistView, meta: LaunchMeta, latest: bigint): Promise<EpochFile> {
  const uri = await uriOf(ctx, v.d, v.active.epoch, meta.sharingSince, latest);
  const { bytes } = await ctx.files.fetchVerified(v.d, v.active.epoch, v.active.contentHash, uri);
  const f = (await readWholeEpoch(ctx.files, v.d, bytes)).file;
  noteHeld(ctx, v.d, f);
  return f;
}

/** Remembers, per account, the last time (chain clock) it held the token. */
export function noteHeld(ctx: OpsContext, d: Address, f: EpochFile): void {
  ctx.store.update<Record<string, { epoch: string; at: Record<string, number> }>>('lastHeld', {}, (all) => {
    const cur = (all[d] ??= { epoch: '0', at: {} });
    if (BigInt(cur.epoch) >= f.epoch) return;
    const t = Number(f.window.toTime);
    for (const a of Object.keys(f.balancesAtEnd)) cur.at[a] = t;
    for (const row of f.accounts) if (row.w > 0n && (cur.at[row.a] ?? 0) < Number(f.window.fromTime)) cur.at[row.a] = Number(f.window.fromTime);
    cur.epoch = f.epoch.toString();
  });
}

type SendFn = (who: 'publisher' | 'pusher', req: { to: string; data: string; label: string; distributors: string[]; maxGasPriceWei?: bigint }) => Promise<{ hash: string; receipt: { status: boolean; blockNumber: bigint; logs: any[] } }>;

async function pushActive(ctx: OpsContext, send: SendFn, v: DistView, meta: LaunchMeta, latest: { number: bigint; timestamp: bigint }, rep: TickReport): Promise<string> {
  const { cfg } = ctx;
  const r0 = ctx.readers[0];
  const file = await activeFile(ctx, v, meta, latest.number);
  const leaves = file.merkle.leaves;
  if (!leaves.length) return 'no leaves';
  // cut in the chunks the index names, each rebuilt to the root it gives
  const tree = treeOf(file);
  if (tree.root !== v.active.merkleRoot) throw new Error(`the active file's tree root ${tree.root} is not the chain's ${v.active.merkleRoot}`);
  const calls = leaves.flatMap((l) => [
    { to: v.d, data: encodeFunctionData({ abi: opsDistributorAbi, functionName: 'paid0', args: [l[1] as `0x${string}`] }) },
    { to: v.d, data: encodeFunctionData({ abi: opsDistributorAbi, functionName: 'paid1', args: [l[1] as `0x${string}`] }) },
    { to: v.d, data: encodeFunctionData({ abi: opsDistributorAbi, functionName: 'isExcluded', args: [l[1] as `0x${string}`] }) },
  ]);
  const res = await r0.callMany(calls, latest.number);
  const word = (i: number): bigint => {
    if (!res[i].success || res[i].returnData.length < 66) throw new Error(`a paid/isExcluded read of ${v.d} failed`);
    return BigInt(res[i].returnData.slice(0, 66));
  };
  const held = ctx.store.get<Record<string, { at: Record<string, number> }>>('lastHeld', {})[v.d]?.at ?? {};
  const skips = ctx.store.get<Record<string, Record<string, { at: number; unpaidValue0: bigint | null }>>>('skips', {})[v.d] ?? {};
  const money = await moneyOf(r0, { quote: meta.quoteToken, quoteIsWeth: meta.quoteToken === cfg.sharing.weth, feeds: cfg.sharing.feeds[meta.quoteToken] ?? null, ethUsd: cfg.ethUsdFeed }, latest.number);
  const tokenPrice = await tokenPriceOf(r0, meta, latest.number);
  const econ = { P: money.P, perUsd: money.perUsd, tokenPrice, gasPrice: await gasPrice(r0), l1PerLeaf: ((await l1FeeOf(r0, 200 + 160 * 10)) - (await l1FeeOf(r0, 200))) / 10n };
  const states: LeafState[] = leaves.map((l, i) => {
    const a = l[1];
    const sk = skips[a];
    const st: LeafState = { account: a, cum0: BigInt(l[2]), cum1: BigInt(l[3]), paid0: word(3 * i), paid1: word(3 * i + 1), excluded: word(3 * i + 2) !== 0n, emptyNow: !file.balancesAtEnd[a], lastHeldAt: held[a] ?? null, skipped: null };
    if (sk) st.skipped = { at: sk.at, unpaidValue0: sk.unpaidValue0 ?? unpaidValue0(st, econ) };
    return st;
  });
  const plan = planPushes(tree, states, econ, { ...cfg.keeper, gas: cfg.keeper.gas }, Number(latest.timestamp));
  if (plan.waiting['gas-price']) rep.notes.push(`${v.d}: pushes wait, gas price ${econ.gasPrice} is above the push cap`);
  let pushed = 0;
  for (const b of plan.batches) {
    const data = encodeFunctionData({ abi: opsDistributorAbi, functionName: 'push', args: [b.leaves.map((l) => ({ account: l.account as `0x${string}`, cum0: l.cum0, cum1: l.cum1 })), b.proof as `0x${string}`[], b.flags] });
    const sent = await send('pusher', { to: v.d, data, label: `push ${b.leaves.length} leaves of epoch ${v.active.epoch} of ${v.d}`, distributors: [v.d], maxGasPriceWei: cfg.keeper.pushMaxGasPriceWei });
    pushed += b.leaves.length;
    const ts = Number(latest.timestamp);
    for (const l of sent.receipt.logs) {
      if (String(l.address).toLowerCase() !== v.d) continue;
      try {
        const ev = decodeEventLog({ abi: opsDistributorAbi, topics: l.topics, data: l.data, strict: true });
        if (ev.eventName === 'PushSkipped') {
          const acct = String((ev.args as any).account).toLowerCase();
          const st = states.find((s) => s.account === acct);
          recordSkip(ctx, v.d, acct, ts, st ? unpaidValue0(st, econ) : null);
        }
      } catch {
        // another event
      }
    }
  }
  const w = plan.waiting;
  return `${pushed} pushed in ${plan.batches.length} batches; waiting: ${w['below-threshold']} below threshold, ${w['claim-only']} claim-only, ${w.excluded} excluded${w['no-price'] ? `, ${w['no-price']} without a price` : ''}${w['gas-price'] ? `, ${w['gas-price']} above the gas cap` : ''}`;
}

async function lastClearBlock(r: ChainReader, d: Address, from: bigint, to: bigint): Promise<bigint | null> {
  if (to < from) return null;
  const logs = await r.logs({ address: d, topics: [[ROOT_ACTIVATED, ROOT_VETOED]] }, from, to);
  return logs.length ? BigInt(logs[logs.length - 1].blockNumber) : null;
}

async function epochDue(
  ctx: OpsContext,
  v: DistView,
  meta: LaunchMeta,
  latest: { number: bigint; timestamp: bigint },
  safe: { number: bigint; timestamp: bigint },
  o: TickOptions,
  send: SendFn,
  rep: TickReport,
): Promise<{ note: string; due?: Due }> {
  const { cfg, store } = ctx;
  const k = cfg.keeper;
  const r0 = ctx.readers[0];
  const d = v.d;
  if (v.pending.payableAt !== 0n) return { note: `epoch ${v.pending.epoch} is pending` };

  // A veto reopens the range; the recompute waits for an operator (D.2.8).
  if (v.lastProposedEpoch > v.active.epoch) {
    const acks = await readAcks(ctx);
    if (!acks.has(`${d}:${v.lastProposedEpoch}`)) {
      await ctx.alerts.raise({ key: `veto-ack:${d}:${v.lastProposedEpoch}`, severity: 'page', title: 'A VETOED epoch waits for an operator', text: `Epoch ${v.lastProposedEpoch} of ${d} was vetoed. Find out why (the guardian's reason, the verifier's report) before letting the keeper recompute the reopened range. When it is safe: curb-sharer ack-veto --distributor ${d} --epoch ${v.lastProposedEpoch}`, distributor: d }, { cooldownSec: cfg.alerts.reminderSec });
      return { note: `waiting for an operator to acknowledge the veto of epoch ${v.lastProposedEpoch}` };
    }
  }

  const prevT = v.active.epoch > 0n ? v.active.toBlock : meta.sharingSince;
  const F = v.active.epoch > 0n ? v.active.toBlock + 1n : meta.sharingSince;
  const prevTs = (await r0.block(prevT)).timestamp;
  const age = Number(latest.timestamp - prevTs);
  const until = store.get<Record<string, number>>('noEpochUntil', {})[d] ?? 0;
  if (Math.floor(ctx.now() / 1000) < until) return { note: 'the last attempt gave no epoch, or its file could not be published; waiting' };
  if (age < k.minEpochGapSec) return { note: `last epoch ended ${age}s ago (< ${k.minEpochGapSec})` };

  // The pot: what a harvest would bring in now, against what is allocated.
  const pre = await previewHarvest(r0, d, 'latest');
  if (!pre.ok) {
    await ctx.alerts.raise({ key: `harvest-reverts:${d}`, severity: 'page', title: 'harvest() would REVERT', text: `A simulated harvest() of ${d} reverts: no epoch can end until it does not. Income waits in the core.`, distributor: d }, { cooldownSec: cfg.alerts.reminderSec });
    return { note: 'harvest() would revert' };
  }
  const I0 = pre.received0 - v.active.cumHolders0 - v.active.cumKeeper0;
  const I1 = pre.received1 - v.active.cumHolders1;
  const money = await moneyOf(r0, { quote: meta.quoteToken, quoteIsWeth: meta.quoteToken === cfg.sharing.weth, feeds: cfg.sharing.feeds[meta.quoteToken] ?? null, ethUsd: cfg.ethUsdFeed }, latest.number);
  if (money.P === 0n) {
    await ctx.alerts.raise({ key: `missing-price:${d}`, severity: 'warn', title: 'A price is missing', text: `The quote ${meta.quoteToken} of ${d} has no readable Chainlink price: the keeper fee counts as 0 and an epoch waits for the 7-day rule.`, distributor: d }, { cooldownSec: cfg.alerts.reminderSec });
  }
  if (I0 <= 0n && I1 <= 0n) {
    clearDue(ctx, d);
    return { note: 'no income' };
  }
  const tokenPrice = await tokenPriceOf(r0, meta, latest.number);
  const potValue = (I0 > 0n ? I0 : 0n) + (tokenPrice && I1 > 0n ? (I1 * tokenPrice) / 10n ** 18n : 0n);
  const gp = await gasPrice(r0);
  const holders = BigInt(Math.max(10, store.get<Record<string, number>>('leafCount', {})[d] ?? 10));
  const gasAll = k.gas.harvest + k.gas.publishPerRoot + k.gas.activate + k.gas.payKeeper + k.gas.pushBase + holders * k.gas.pushFirstLeaf;
  const l1 = (await l1FeeOf(r0, 600)) * 4n + ((await l1FeeOf(r0, 200 + 160 * Number(holders))) - (await l1FeeOf(r0, 200)));
  const costWei = gasAll * gp + l1;
  const minPot = (k.minPotFactor * costWei * money.P) / 10n ** 18n;
  const dueByPot = money.P > 0n && potValue >= minPot;
  const dueByAge = age >= k.maxEpochWaitSec;
  if (!dueByPot && !dueByAge) return { note: `pot ${potValue} below MIN_POT ${minPot}${money.P === 0n ? ' (no price)' : ''}` };
  markDue(ctx, d, Math.floor(ctx.now() / 1000));
  await stalledCheck(ctx, d);

  // The harvest that ends the epoch: a recent one after the last root was
  // settled, or a new one.
  const cleared = await lastClearBlock(r0, d, F, latest.number);
  const from = cleared !== null && cleared + 1n > F ? cleared + 1n : F;
  let h = await latestHarvest(r0, d, from, latest.number);
  if (h) {
    const ts = (await r0.block(h.block)).timestamp;
    if (Number(latest.timestamp - ts) > k.harvestFreshSec) h = null;
  }
  if (!h) {
    const sent = await send('pusher', { to: d, data: HARVEST_DATA, label: `harvest ${d}`, distributors: [d] });
    if (!sent.receipt.status) throw new Error(`harvest of ${d} reverted`);
    h = { hash: sent.hash, block: sent.receipt.blockNumber, from: '' };
  }
  let safeNow = safe.number;
  if (h.block > safeNow) {
    if (!o.waitForSafe) return { note: `harvest ${h.hash} at block ${h.block} waits to be safe (safe ${safeNow})` };
    const start = ctx.now();
    while (h.block > safeNow && ctx.now() - start < k.safeWaitSec * 1000) {
      await ctx.sleep(k.receiptPollMs);
      safeNow = (await commonHead(ctx.readers, 'safe')).number;
    }
    if (h.block > safeNow) return { note: `harvest ${h.hash} at block ${h.block} not safe within ${k.safeWaitSec}s` };
  }

  // Compute, on every provider, at T.
  const T = h.block;
  const prev = v.active.epoch > 0n ? (await loadActiveState(r0, cfg.sharing.graduator, d, ctx.files.fetcher(d, v.active.epoch), T, chunkFetcher(ctx.files, d))).state : null;
  let prepared;
  try {
    // the whole journal: prepareEpoch asks only for the sends that can lie in
    // the window (keeperJournalHashes), so one settled before F is never queried
    const distributors = await boundDistributors(ctx, T, safeNow).catch(() => undefined);
    prepared = await prepareEpoch(ctx.readers, cfg.sharing, { distributor: d, harvestTx: h.hash, uri: '', prev, keeperJournal: ctx.store.get<Record<string, KeeperJournalEntry[]>>('txJournal', {}), distributors }, { allowSingleProvider: ctx.allowSingleProvider });
  } catch (e) {
    if (e instanceof EpochNotReady) return { note: `not ready: ${e.code}: ${e.message}` };
    throw e;
  }
  const stuck = await stuckIncome(r0, meta, T);
  if (stuck.escrow + stuck.hook + stuck.lock0 + stuck.lock1 > 0n) {
    await ctx.alerts.raise({ key: `income-waiting:${d}`, severity: 'warn', title: 'Income is waiting in the core', text: `After the harvest at block ${T}, ${d} still has escrow ${stuck.escrow}, hook ${stuck.hook}, lock ${stuck.lock0}/${stuck.lock1} it could not collect (an issuer may be blocking the distributor). It is not lost; it waits.`, distributor: d }, { cooldownSec: cfg.alerts.reminderSec });
  }
  const r = prepared.result;
  if (r.result !== 'epoch') {
    store.update<Record<string, number>>('noEpochUntil', {}, (m) => {
      m[d] = Math.floor(ctx.now() / 1000) + k.minEpochGapSec;
    });
    return { note: `no epoch: ${r.reason}` };
  }
  const uri = ipfsUri(fileCid(r.fileBytes));
  r.next.uri = uri;
  return { note: `epoch ${r.root.epoch} computed at T=${T}`, due: { d, meta, result: r, uri, T } };
}

function markDue(ctx: OpsContext, d: Address, now: number): void {
  ctx.store.update<Record<string, number>>('dueSince', {}, (m) => {
    if (!m[d]) m[d] = now;
  });
}

function clearDue(ctx: OpsContext, d: Address): void {
  ctx.store.update<Record<string, number>>('dueSince', {}, (m) => {
    delete m[d];
  });
}

async function stalledCheck(ctx: OpsContext, d: Address): Promise<void> {
  const since = ctx.store.get<Record<string, number>>('dueSince', {})[d];
  if (!since) return;
  const age = Math.floor(ctx.now() / 1000) - since;
  if (age >= ctx.cfg.keeper.stalledAfterSec) {
    await ctx.alerts.raise({ key: `stalled:${d}`, severity: 'page', title: 'A distributor is STALLED', text: `${d} has had an epoch due for ${Math.floor(age / 3600)} h and none was published.`, distributor: d }, { cooldownSec: ctx.cfg.alerts.reminderSec });
  }
}

async function publishDue(ctx: OpsContext, act: () => Promise<void>, send: SendFn, due: Due[], rep: TickReport): Promise<void> {
  const { cfg, log } = ctx;
  // files are writes too: not one before this keeper holds the lease
  await act();
  const ready: (Due & { pub: Published })[] = [];
  // The configuration these epochs were computed with, for outside
  // verifiers: one file per rules version, and the current one.
  //
  // ONE RULES VERSION IS ONE CONFIGURATION, FOR GOOD. A config-v<N>.json
  // already published with OTHER contents means this keeper's sharing block
  // changed (a feed, an exclusion...) without a new rules version: the
  // guardian and the verifiers, holding the published one, would call every
  // epoch from here wrong and veto it - two vetoes in 30 days freeze sharing
  // for everyone. So nothing is published until the version is raised
  // (RUNBOOK part 7.1), and the page names what differs.
  if (ctx.repo) {
    const v = cfg.sharing.rules.version;
    const vPath = `sharing/${cfg.sharing.chainId}/config-v${v}.json`;
    const body = new TextEncoder().encode(JSON.stringify(publicSharingConfig(cfg), null, 1) + '\n');
    let clash: string[] = [];
    try {
      const cur = await ctx.repo.get(vPath);
      if (cur) {
        let raw: unknown = null;
        try {
          raw = JSON.parse(new TextDecoder().decode(cur.bytes));
        } catch {
          // diffSharingConfig names an unreadable file
        }
        clash = diffSharingConfig(raw, cfg);
      }
      if (!clash.length) {
        if (!cur) await ctx.repo.put(vPath, body, `sharing config, rules version ${v}`, null);
        await ctx.repo.upsert(`sharing/${cfg.sharing.chainId}/config.json`, body, `current sharing config (rules version ${v})`);
      }
    } catch (e) {
      log.warn('the public sharing config was not written', { error: errorText(e) });
    }
    if (clash.length) {
      rep.ok = false;
      rep.errors.push(`${vPath} already holds another configuration under rules version ${v}: nothing published`);
      await ctx.alerts.raise({ key: `config-clash:v${v}`, severity: 'page', title: `The sharing config changed WITHOUT a new rules version (${v})`, text: `The published ${vPath} differs from this keeper's sharing block: ${clash.slice(0, 8).join('; ')}. Nothing is published until sharing.rules.version is raised everywhere at once (RUNBOOK part 7.1) - or this keeper's copy is put back. Epochs computed from two configurations under one version would be vetoed by the guardian.` }, { cooldownSec: cfg.alerts.reminderSec });
      return;
    }
  }
  for (const x of due) {
    await largeFileCheck(ctx, x);
    await contractHolderCheck(ctx, x);
    // the chunks (past CHUNK_ACCOUNTS rows) go first, then the index
    const p = await publishFile(
      { distributor: x.d, epoch: x.result.root.epoch, bytes: x.result.fileBytes, contentHash: x.result.contentHash, chunks: x.result.chunks },
      { chainId: cfg.sharing.chainId, repo: ctx.repo, pinners: ctx.pinners, minPinned: cfg.ipfs.minPinned, files: ctx.files, log, refetchTries: ctx.refetch?.tries, refetchDelayMs: ctx.refetch?.delayMs, sleep: ctx.sleep },
    );
    if ('reason' in p) {
      rep.ok = false;
      rep.errors.push(`${x.d} epoch ${x.result.root.epoch} not published: ${p.reason}`);
      // Back off before computing this launch again: every attempt replays
      // its window and may write and pin the file, and a cause that lasts (a
      // file too large, a pinning plan out of space) would repeat that every
      // tick. The stalled page still comes after stalledAfterSec.
      const wait = cfg.keeper.minEpochGapSec;
      ctx.store.update<Record<string, number>>('noEpochUntil', {}, (m) => {
        m[x.d] = Math.floor(ctx.now() / 1000) + wait;
      });
      await ctx.alerts.raise({ key: `publish-failed:${x.d}:${x.result.root.epoch}`, severity: 'page', title: 'An epoch file could NOT be published', text: `${p.reason}. Nothing went on chain; the keeper tries this launch again ${wait > 0 ? `in ${ago(wait)} (keeper.minEpochGapSec)` : 'on the next tick'}.`, distributor: x.d });
      continue;
    }
    if (p.uri !== x.uri) throw new Error('internal: the published URI is not the computed one');
    ready.push({ ...x, pub: p });
  }
  if (!ready.length) return;
  const attempt = async (items: typeof ready): Promise<void> => {
    const args = publishArgs(items.map((i) => ({ distributor: i.d, result: i.result, uri: i.uri })));
    const sent = await send('publisher', { to: cfg.distributorFactory, data: args.data, label: `publishMany ${items.map((i) => `${i.d}#${i.result.root.epoch}`).join(', ')}`, distributors: items.map((i) => i.d) });
    if (!sent.receipt.status) throw new Error('publishMany reverted on chain');
    for (const i of items) {
      rep.published.push({ distributor: i.d, epoch: i.result.root.epoch, uri: i.uri, contentHash: i.result.contentHash });
      ctx.store.update<Record<string, string>>('uris', {}, (m) => {
        m[`${i.d}:${i.result.root.epoch}`] = i.uri;
      });
      ctx.store.update<Record<string, number>>('leafCount', {}, (m) => {
        m[i.d] = i.result.file.merkle.leaves.length;
      });
      clearDue(ctx, i.d);
      await writeLatest(ctx.repo, cfg.sharing.chainId, { distributor: i.d, epoch: i.result.root.epoch, uri: i.uri, contentHash: i.result.contentHash, txHash: sent.hash }, log);
    }
  };
  try {
    await attempt(ready);
  } catch (e) {
    if (e instanceof WouldRevert && ready.length > 1) {
      log.warn('publishMany would revert; publishing one by one', { error: e.message });
      for (const i of ready) {
        try {
          await attempt([i]);
        } catch (e2) {
          if (!(e2 instanceof WouldRevert)) throw e2;
          rep.notes.push(`${i.d}: ${e2.message}`);
        }
      }
    } else if (e instanceof WouldRevert) {
      // PendingRoot / WrongEpoch / BadRange: somebody published first - idempotency
      rep.notes.push(e.message);
    } else throw e;
  }
}

/** Pages while a launch's accounts grow large. Its leaves are cumulative and
 *  an account costs only a millionth of the supply held for an epoch, so a
 *  dust spray to fresh addresses grows every later file for good. No file
 *  outgrows the read-back limit - past CHUNK_ACCOUNTS rows they go in chunk
 *  files of about 130 KiB at most, and the index grows by some 350 bytes a
 *  chunk - but each epoch writes, pins and reads back every one of its
 *  ceil(N / CHUNK_ACCOUNTS) chunk files, and every verifier and the guardian
 *  reads them all within its check deadline. `bytes` counts the index and
 *  its chunks. */
async function largeFileCheck(ctx: OpsContext, x: Due): Promise<void> {
  const k = ctx.cfg.keeper;
  const bytes = x.result.fileBytes.length + x.result.chunks.reduce((n, c) => n + c.bytes.length, 0);
  const rows = Math.max(x.result.file.accounts.length, x.result.file.merkle.leaves.length);
  if (bytes < k.largeFileBytes && rows < k.largeFileAccounts) return;
  const size = (n: number) => (n >= 1048576 ? `${Math.round((n / 1048576) * 10) / 10} MiB` : `${Math.ceil(n / 1024)} KiB`);
  const n = x.result.chunks.length;
  await ctx.alerts.raise(
    {
      key: `large-file:${x.d}`,
      severity: 'page',
      title: 'An epoch file is GROWING large',
      text: `Epoch ${x.result.root.epoch} of ${x.d} is ${size(bytes)} (${n ? `its index and ${n} chunk files` : 'one file'}) with ${x.result.file.accounts.length} accounts and ${x.result.file.merkle.leaves.length} leaves (this pages from ${size(k.largeFileBytes)} or ${k.largeFileAccounts} accounts: keeper.largeFileBytes, keeper.largeFileAccounts). Every epoch of this launch writes, pins and reads back a chunk file per ${CHUNK_ACCOUNTS} accounts, and every verifier and the guardian reads them all within guardian.checkTimeoutSec: the pinning plans fill and the checks slow down as it grows. Find out who is adding accounts (a spray of dust to fresh addresses) and tell the developers now.`,
      distributor: x.d,
    },
    { cooldownSec: ctx.cfg.alerts.reminderSec },
  );
}

/** A contract that carries this much of an epoch's weight (basis points of W)
 *  is named once: a warning, not a page. */
export const CONTRACT_HOLDER_BPS = 500n;

/** Warns, once per launch and address, when a contract that is not excluded
 *  holds a large share of an epoch's weight. Pools are excluded by their
 *  token0()/token1() whatever their factory, but a vault, a lending market, a
 *  bridge or a pool of another shape takes a holder's share it may never
 *  use, or lets anyone skim it. Whether it should be excluded is a person's
 *  call (a new rules version, RUNBOOK part 7.1); a Safe or a smart wallet is
 *  a holder like any other. */
async function contractHolderCheck(ctx: OpsContext, x: Due): Promise<void> {
  const f = x.result.file;
  if (f.weights.W === 0n) return;
  const big = f.accounts.filter((row) => row.w * 10_000n >= f.weights.W * CONTRACT_HOLDER_BPS);
  for (const row of big) {
    try {
      const code = await ctx.readers[0].code(row.a, x.T);
      if (code === '0x' || code === '0x0') continue;
      const pct = Number((row.w * 10_000n) / f.weights.W) / 100;
      await ctx.alerts.raise(
        {
          key: `contract-holder:${x.d}:${row.a}`,
          severity: 'warn',
          title: 'A CONTRACT holds a large share of a launch\'s holder weight',
          text: `${row.a} has code and carries ${pct}% of the weight of epoch ${x.result.root.epoch} of ${x.d}, and no rule excludes it. If it is a pool, a vault, a lending market, a bridge or anything else that cannot pass its share to people (or lets anyone take it), add it to sharing.rules.exclusions under a new rules version (RUNBOOK part 7.1). A Safe or a smart wallet is a holder like any other: nothing to do.`,
          distributor: x.d,
        },
        { cooldownSec: 365 * 86400 },
      );
    } catch (e) {
      ctx.log.warn('a large holder was not checked for code', { distributor: x.d, account: row.a, error: errorText(e) });
    }
  }
}

async function writeStatus(ctx: OpsContext, o: TickOptions, rep: TickReport, live: Liveness & { changed: boolean }, blocked: boolean): Promise<void> {
  const nowS = Math.floor(ctx.now() / 1000);
  const status = { schema: 'curb.sharing.status/1', role: o.role, holder: o.holder, heartbeatAt: nowS, ok: rep.ok, lastOkAt: live.lastOkAt, failingSince: live.failingSince, actions: rep.actions, notes: rep.notes, errors: rep.errors, ...rep.status };
  ctx.store.writeFile('status.json', JSON.stringify(status, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 1));
  if (!ctx.repo) return;
  const last = ctx.store.get<number>('heartbeatWrittenAt', 0);
  // On schedule, and at once when the ticks start or stop failing (the
  // standby reads lastOkAt from this). The standby reports when it acted, or
  // on the same schedule while it stands in for a silent primary (the
  // verifiers' "no keeper at all" watch reads that) - never when another
  // keeper held the lease and it did nothing.
  const due = nowS - last >= ctx.cfg.lease.heartbeatEverySec || live.changed;
  if (o.role === 'primary' ? due : rep.acted || (due && !blocked)) {
    await writeHeartbeat(ctx.repo, o.role === 'primary' ? STATUS_PATH : STANDBY_STATUS_PATH, status);
    ctx.store.set('heartbeatWrittenAt', nowS);
  }
}

export { opsFactoryAbi };
