// The verifier and the guardian (design D.2.7). For every root that is
// pending, or active and not yet checked:
//
//   1. fetch the file by its URI (IPFS gateways) and by the site URL, and
//      check each copy's sha256 against the contentHash on chain; past one
//      chunk of rows that file is an index, and every chunk it names is
//      fetched too (the site, then the gateways), each used only if it
//      hashes to the sha256 the index gives;
//   2. check the file against its own root (verifyEpochFile: the tree, the
//      sums, the cap, the continuity with the previous epoch, the chunks
//      against their index);
//   3. recompute the epoch independently, on this host's own two providers,
//      and compare the bytes (which covers the root, the totals, the keeper
//      fee against the cap and the receipts, and the exclusions).
//
// `verify` never signs: it alerts with the Safe's veto and freeze calldata
// ready to sign. `guardian` holds a vetoer key: a mismatch inside the veto
// hour is vetoed at once; a repeat (an earlier RECOMPUTE or INVALID veto of
// the same launch within the repeat window), or a file whose bytes match the
// on-chain hash and still do not match its own root, is frozen too. A root
// nobody could verify (file unavailable, every served copy hashing wrong,
// providers disagreeing, a check that ran out of time) is vetoed once it has
// been unverifiable for guardian.vetoUnverifiedAfterSec, or at once in the
// last guardian.vetoUnverifiedBeforeSec of its hour - a wrong veto costs a
// delay, a missed one could cost the holders - and on its own never frozen:
// copies that do not match the hash are evidence against whoever serves
// them (the site, a CDN, a gateway), not against the root - and so is a
// chunk of the file nobody serves, or serves only wrong. A copy that fails
// while another matches raises a warning, and the site copy of the active
// and pending epochs is re-hashed on every pass, since users' verify panel
// and Claim read it.
//
// MANY ROOTS AT ONCE ARE FROZEN FIRST. When guardian.freezeAtBadRoots or
// more pending roots are to be vetoed at once (mismatches, and unverifiable
// roots past their grace or late), the guardian freezes before it vetoes
// the rest: a publisher holding a stolen key who queues roots that are slow
// or many to check, with the theft last, would otherwise outrun the vetoes.
// A freeze holds every pending root (none becomes payable while frozen, and
// each stays vetoable), so after it the vetoes are not racing anything and
// go out together, one vetoMany per reason. Before it, a veto goes out the
// moment its root is judged.
//
// THE WORK COMES FROM THE CHAIN'S STATE, NOT ITS HISTORY. Each pass reads
// every distributor's active() and pending() on EVERY provider - in a few
// Multicall3 requests per provider, however many launches there are
// (chainview.ts readRootsMany) - and pages when they disagree; a root's
// RootPublished (for its URI) is looked up in the one block its payableAt
// names, on every provider, and a pending root whose event is missing or
// differs pages too. Nothing scans a launch's history, so a pass does not
// grow with the chain, and one provider that leaves a root out cannot hide
// it. The recompute's list of every distributor bound so far (each epoch
// excludes the others) comes from each provider's own scan of the
// Graduator, kept in /data and advanced over new blocks only (keeper.ts
// boundDistributors).
//
// A PASS IS BOUNDED IN TIME, AND A VETO DOES NOT WAIT FOR IT. The URI is
// chosen by whoever holds the publisher key, so a copy may trickle forever
// or be gigabytes (http.ts bounds each download). Pending roots are checked
// first - those never judged before the ones found unverifiable before, and
// among each the one whose hour ends first first; each check has a deadline
// (guardian.checkTimeoutSec), stops its every download and read when it
// runs out, and is not started again while an abandoned one still runs; the
// checks of a pass have a budget of their own (guardian.passTimeoutSec),
// counted from the first, so reading the roots and sending what was owed do
// not use it up. A check that runs out is "unverifiable"; a root the pass
// had no time for is NOT - no time is no evidence against a root, so none is
// vetoed for it: when one never judged is in its last minutes, the guardian
// freezes instead, once. Each veto is decided on a fresh head. A pass that
// runs past its budget is not clean, so a guardian that cannot keep up
// pages (liveness.ts).
//
// A VETO OR A FREEZE THE GUARDIAN DECIDED IS OWED UNTIL IT LANDS. It is kept
// in /data and tried again at the start of every pass until the root is no
// longer pending (vetoed, by anyone) or its hour is over while the factory
// is not frozen; a freeze until it holds - frozen, with no unfreeze
// announced, since one announced ripens on time and every root still
// pending then becomes payable (a freeze() cancels it) - for a day at most.
// The freeze goes first. Each root's state is re-read on every provider
// just before sending, in batches, so a vetoMany names only roots still
// pending; one that would revert, or was mined and reverted, falls back to
// one veto() per root; a reverted receipt is never a success. The guardian
// key has its own gas-price cap (guardian.maxGasPriceWei).
//
// Each pass also records whether it finished cleanly (liveness.ts): a
// guardian or verifier whose passes keep failing pages. The guardian warns
// when its key runs low on ETH and, given a data repo token, writes its own
// heartbeat (ops/status-guardian.json), signed with its vetoer key; a
// verifier reads that one and the keepers' and pages when they go stale or
// the guardian's is not signed by a vetoer.

import { decodeEventLog, encodeFunctionData, stringToHex, hexToString } from 'viem';
import type { Address, EpochIndex } from '../calc/types.ts';
import { canonicalJson } from '../calc/encoding.ts';
import { parseEpochIndex, verifyEpochFile } from '../calc/file.ts';
import { ChunkUnavailable, chunkFetcher, fetchChunks } from '../epoch-chunks.ts';
import { readEpochHistory, type PublishedRoot, type RootView } from '../chain/indexer.ts';
import type { ChainReader } from '../chain/reader.ts';
import { recomputeEpochFile, ProviderDisagreement, EpochNotReady, type SharerConfig } from '../epoch.ts';
import { loadActiveState } from '../state.ts';
import { distributorAbi, EVENTS, TOPICS } from '../chain/abis.ts';
import { diffSharingConfig } from './config.ts';
import { opsFactoryAbi } from './abis.ts';
import type { CopyCheck, EpochFiles } from './files.ts';
import type { OpsContext, VetoSeen } from './keeper.ts';
import { boundDistributors, discover, roleEvents } from './keeper.ts';
import { commonHead, readFactory, readRoots, readRootsMany, isVetoer, stoppable } from './chainview.ts';
import type { ReadyCall } from './alerts.ts';
import { errorText } from './log.ts';
import { WouldRevert, type TxSender } from './tx.ts';
import { beatMessage, trackLiveness, watchHeartbeats, type Liveness } from './liveness.ts';
import { writeHeartbeat, GUARDIAN_STATUS_PATH } from './lease.ts';

export const REASONS = {
  RECOMPUTE: 'CURB:RECOMPUTE_MISMATCH',
  HASH: 'CURB:HASH_MISMATCH',
  INVALID: 'CURB:FILE_INVALID',
  UNAVAILABLE: 'CURB:FILE_UNAVAILABLE',
  UNVERIFIED: 'CURB:UNVERIFIED',
} as const;
export type Reason = (typeof REASONS)[keyof typeof REASONS];

export const reasonWord = (r: Reason): `0x${string}` => stringToHex(r, { size: 32 });
export function reasonOf(word: string): string {
  try {
    return hexToString(word as `0x${string}`, { size: 32 }).replace(/\0+$/, '');
  } catch {
    return word;
  }
}

/** ONLY A VERDICT ON THE ROOT ITSELF COUNTS TOWARD THE REPEAT RULE: a
 *  recompute mismatch, or a file that fails its own root. An UNVERIFIED veto
 *  says the copies could not be checked (an outage, a slow gateway), which is
 *  never a reason to freeze; counting it would let one later mismatch -
 *  perhaps this host's own config out of step - freeze every launch. */
const REPEAT_REASONS = new Set<string>([REASONS.RECOMPUTE, REASONS.INVALID].map((r) => reasonWord(r).toLowerCase()));

/** The factory's SHARING_VETO_WINDOW: a root's RootPublished is in the block
 *  whose timestamp is its payableAt minus this. */
export const VETO_WINDOW_SEC = 3600n;

/** A failed veto pages again this often while its root is still pending. */
const VETO_RETRY_PAGE_SEC = 300;

/** An owed freeze is tried for a day; after a day of pages it is a person's call. */
const OWED_FREEZE_SEC = 86400;

/** Roots one vetoMany stops at most: some 20,000 gas each keeps a batch far
 *  under a transaction's gas cap (EIP-7825). */
export const VETO_BATCH = 200;

export interface VerifyResult {
  distributor: Address;
  epoch: bigint;
  contentHash: string;
  uri: string;
  publishedAt: bigint;
  verdict: 'ok' | 'mismatch' | 'unverifiable';
  reason: Reason | null;
  problems: string[];
  copies: CopyCheck[];
  /** Unverifiable for a reason that pages at once (not checked in time, its event missing). */
  urgent?: boolean;
}

export interface VerifyDeps {
  readers: ChainReader[];
  sharing: SharerConfig;
  files: EpochFiles;
  allowSingleProvider?: boolean;
  /** The guardian's deadline for this one check: every download and every
   *  read (the recompute's included) stops when it aborts. */
  signal?: AbortSignal;
  /** Every distributor bound up to a block, from the caller's cached scans
   *  (keeper.ts boundDistributors); undefined lets the recompute scan for them. */
  distributorsAt?: (T: bigint) => Promise<Address[] | undefined>;
}

/** Checks one published root. Never throws: a failure to check is a verdict. */
export async function verifyPublished(deps: VerifyDeps, d: Address, p: PublishedRoot): Promise<VerifyResult> {
  const out: VerifyResult = { distributor: d, epoch: p.epoch, contentHash: p.contentHash, uri: p.uri, publishedAt: p.block, verdict: 'unverifiable', reason: REASONS.UNVERIFIED, problems: [], copies: [] };
  // an abandoned check ends at its next read, not after the whole recompute
  const readers = deps.signal ? deps.readers.map((r) => stoppable(r, deps.signal!)) : deps.readers;
  const r0 = readers[0];
  try {
    // 1. the copies
    const { checks, bytes } = await deps.files.checkAll(d, p.epoch, p.contentHash, p.uri, deps.signal);
    out.copies = checks;
    for (const c of checks) if (!c.ok) out.problems.push(`${c.source}: ${c.error}`);
    if (!bytes) {
      const served = checks.filter((c) => c.sha256);
      if (served.length) {
        // NOT a verdict on the root: whoever serves the copies can cause this.
        out.reason = REASONS.HASH;
        out.problems.push(`the served copies (${served.map((c) => c.source).join(', ')}) do not match the on-chain hash ${p.contentHash}`);
      } else {
        out.reason = REASONS.UNAVAILABLE;
        out.problems.push('no copy of the file could be fetched');
      }
      return out;
    }

    // 2. the file against its own root (the root as published: pending() right after)
    let index: EpochIndex;
    try {
      index = parseEpochIndex(bytes);
    } catch (e) {
      out.verdict = 'mismatch';
      out.reason = REASONS.INVALID;
      out.problems.push(`not a canonical epoch file: ${(e as Error).message}`);
      return out;
    }
    // Every chunk the index names, each only as the bytes its sha256 gives. A
    // chunk nobody serves is UNAVAILABLE and one served only wrong is HASH -
    // whoever serves the copies can cause either, so neither is a verdict on
    // the root; what a chunk that hashes right says is verifyEpochFile's.
    let chunks: Map<string, Uint8Array>;
    try {
      chunks = await fetchChunks(deps.files, d, index, deps.signal);
    } catch (e) {
      if (!(e instanceof ChunkUnavailable)) throw e;
      out.reason = e.served ? REASONS.HASH : REASONS.UNAVAILABLE;
      out.problems.push(...e.checks.filter((c) => !c.ok).map((c) => `chunk ${c.source}: ${c.error}`), e.served ? `the served copies of a chunk (${e.chunk.first} to ${e.chunk.last}) do not match the sha256 ${e.chunk.sha256} its index gives` : `no copy of a chunk (${e.chunk.first} to ${e.chunk.last}, sha256 ${e.chunk.sha256}) could be fetched`);
      return out;
    }
    const at = await r0.read<readonly unknown[]>(distributorAbi, d, 'pending', [], p.block);
    const [merkleRoot, contentHash, cumHolders0, cumHolders1, cumKeeper0, fromBlock, toBlock, epoch] = at as any[];
    const T = index.window.toBlock;
    const activeAtT = BigInt(((await r0.read<readonly unknown[]>(distributorAbi, d, 'active', [], T)) as any[])[7]);
    const prevLoaded = await loadActiveState(r0, deps.sharing.graduator, d, deps.files.fetcher(d, activeAtT, deps.signal), T, chunkFetcher(deps.files, d, deps.signal));
    const check = verifyEpochFile(
      bytes,
      { distributor: d, epoch: BigInt(epoch), contentHash: String(contentHash).toLowerCase(), merkleRoot: String(merkleRoot).toLowerCase(), cumHolders0: BigInt(cumHolders0), cumHolders1: BigInt(cumHolders1), cumKeeper0: BigInt(cumKeeper0), fromBlock: BigInt(fromBlock), toBlock: BigInt(toBlock) },
      prevLoaded.file,
      { chunks },
    );
    if (BigInt(epoch) !== p.epoch || String(merkleRoot).toLowerCase() !== p.merkleRoot) out.problems.push('the root read back is not the one the event names');
    if (!check.ok) {
      out.verdict = 'mismatch';
      out.reason = REASONS.INVALID;
      out.problems.push(...check.problems);
      return out;
    }

    // 3. the independent recompute
    let rc;
    try {
      const distributors = deps.distributorsAt ? await deps.distributorsAt(T).catch(() => undefined) : undefined;
      rc = await recomputeEpochFile(readers, deps.sharing, bytes, { prev: prevLoaded.state, uri: '', distributors }, { allowSingleProvider: deps.allowSingleProvider, signal: deps.signal });
    } catch (e) {
      out.reason = REASONS.UNVERIFIED;
      out.problems.push(e instanceof ProviderDisagreement ? `this host's providers disagree: ${e.message}` : e instanceof EpochNotReady ? `not recomputable yet: ${e.code}: ${e.message}` : `recompute failed: ${errorText(e)}`);
      return out;
    }
    if (!rc.same) {
      out.verdict = 'mismatch';
      out.reason = REASONS.RECOMPUTE;
      if (index.rules.version !== deps.sharing.rules.version) out.problems.push(`the file names rules version ${index.rules.version}, this host's config has ${deps.sharing.rules.version}: if the rules were just changed, this host's copy may be the one out of step (RUNBOOK part 7.1)`);
      out.problems.push(...(await configHint(deps, index.rules.version)));
      out.problems.push(...rc.problems);
      return out;
    }
    out.verdict = 'ok';
    out.reason = null;
    return out;
  } catch (e) {
    out.problems.push(`check failed: ${errorText(e)}`);
    return out;
  }
}

/** A mismatch says WHICH part of the sharing block differs between this host
 *  and the configuration the file names (sharing/<chain>/config-v<N>.json on
 *  the site) - a feed, an exclusion, a keeper key - not only the version: the
 *  operator must know whether the root or this host's copy is wrong before
 *  anyone vetoes. Empty when it cannot be read or nothing differs. */
async function configHint(deps: VerifyDeps, version: bigint): Promise<string[]> {
  try {
    const b = await deps.files.siteFile(`sharing/${deps.sharing.chainId}/config-v${version}.json`, deps.signal);
    if (!b) return [];
    const d = diffSharingConfig(JSON.parse(new TextDecoder().decode(b)), { sharing: deps.sharing });
    return d.length ? [`this host's sharing config differs from the published config-v${version}.json the file was computed with: ${d.slice(0, 6).join('; ')} - this host's copy may be the one out of step (RUNBOOK part 7.1)`] : [];
  } catch {
    return []; // a hint only
  }
}

export function readyCalls(factory: Address, items: { d: Address; epoch: bigint }[], reason: Reason, withFreeze: boolean): ReadyCall[] {
  const calls: ReadyCall[] = [];
  if (items.length === 1) calls.push({ what: `veto epoch ${items[0].epoch} of ${items[0].d} (a vetoer)`, to: factory, data: encodeFunctionData({ abi: opsFactoryAbi, functionName: 'veto', args: [items[0].d as `0x${string}`, Number(items[0].epoch), reasonWord(reason)] }) });
  if (items.length > 1 || items.length === 1) calls.push({ what: `veto all ${items.length} in one transaction (a vetoer)`, to: factory, data: encodeFunctionData({ abi: opsFactoryAbi, functionName: 'vetoMany', args: [items.map((i) => i.d as `0x${string}`), items.map((i) => Number(i.epoch)), reasonWord(reason)] }) });
  if (withFreeze) calls.push({ what: 'freeze publishing (the owner Safe or a vetoer)', to: factory, data: encodeFunctionData({ abi: opsFactoryAbi, functionName: 'freeze' }) });
  return calls;
}

// ---------------------------------------------------------------- the event of a root

/** The RootPublished of `root` on one provider, or null when that provider
 *  has none. publish() refuses a toBlock at or past its own block, and the
 *  event carries payableAt = its block's timestamp + the veto window, so the
 *  block is found by its timestamp (a bisection over the headers after
 *  toBlock) and only that block is asked for logs: a root published a year
 *  ago costs as little as one published a minute ago. */
export async function publishedEvent(r: ChainReader, d: Address, root: RootView, head: bigint): Promise<PublishedRoot | null> {
  const at = root.payableAt - VETO_WINDOW_SEC;
  let lo = root.toBlock + 1n;
  let hi = head;
  if (root.payableAt === 0n || lo > hi || (await r.block(hi)).timestamp < at) return null;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if ((await r.block(mid)).timestamp < at) lo = mid + 1n;
    else hi = mid;
  }
  // the first block at that timestamp, and any after it sharing it
  if ((await r.block(lo)).timestamp !== at) return null;
  let to = lo;
  while (to < head && (await r.block(to + 1n)).timestamp === at) to++;
  const { published } = await readEpochHistory(r, d, lo, to);
  return published.find((p) => p.epoch === root.epoch && p.payableAt === root.payableAt && p.merkleRoot === root.merkleRoot && p.contentHash === root.contentHash) ?? null;
}

/** The event of `root` as EVERY provider (`readers`, this host's) reports
 *  it, or why it cannot be trusted: missing on one of them, or different
 *  between them. Agreed events are cached by (distributor, epoch). */
async function eventEverywhere(ctx: OpsContext, readers: ChainReader[], d: Address, root: RootView, head: bigint): Promise<{ p: PublishedRoot | null; problem: string | null }> {
  const key = `${d}:${root.epoch}`;
  const cache = ctx.store.get<Record<string, PublishedRoot>>('publishedEvents', {});
  const hit = cache[key];
  if (hit && hit.payableAt === root.payableAt && hit.merkleRoot === root.merkleRoot && hit.contentHash === root.contentHash) return { p: hit, problem: null };
  const found: (PublishedRoot | null)[] = [];
  for (const r of readers) found.push(await publishedEvent(r, d, root, head));
  const id = (p: PublishedRoot | null) => (p ? `${p.block}:${p.txHash}:${p.uri}` : 'none');
  const say = () => readers.map((r, i) => `${r.label}: ${found[i] ? `block ${found[i]!.block}, ${found[i]!.uri}` : 'no event'}`).join('; ');
  if (found.some((p) => id(p) !== id(found[0]))) return { p: null, problem: `this host's providers disagree on the RootPublished of epoch ${root.epoch} (${say()})` };
  if (!found[0]) return { p: null, problem: `no RootPublished matches epoch ${root.epoch} (payableAt ${root.payableAt}) on any of this host's providers` };
  cache[key] = found[0];
  ctx.store.set('publishedEvents', cache);
  return { p: found[0], problem: null };
}

/** An unverifiable verdict for a root that was not (fully) checked. */
function unverified(d: Address, root: RootView, problem: string, p: PublishedRoot | null = null): VerifyResult {
  return { distributor: d, epoch: root.epoch, contentHash: root.contentHash, uri: p?.uri ?? '', publishedAt: p?.block ?? 0n, verdict: 'unverifiable', reason: REASONS.UNVERIFIED, problems: [problem], copies: [], urgent: true };
}

/** `work`, or `late()` once `ms` has passed: the work is then told to stop
 *  (its downloads end at once) and is not waited for. */
async function within<T>(ms: number, work: (signal: AbortSignal) => Promise<T>, late: () => T): Promise<T> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      ctl.abort(new Error('the deadline passed'));
      resolve(late());
    }, Math.max(0, ms));
  });
  try {
    return await Promise.race([work(ctl.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- one pass

export interface WatchReport {
  ok: boolean;
  results: VerifyResult[];
  vetoed: { d: Address; epoch: bigint; reason: Reason; tx: string }[];
  froze: string | null;
  errors: string[];
  /** Roots this pass did not reach before its deadline. */
  unchecked: number;
  /** How long the pass took, ms. */
  passMs: number;
}

/** A veto the guardian decided and has not seen land. */
interface Owed {
  d: Address;
  epoch: bigint;
  reason: Reason;
  payableAt: bigint;
  /** Wall clock seconds when it was decided. */
  since: number;
}

/** One distributor's roots as this host's providers report them. */
interface Roots {
  d: Address;
  /** The first provider's active root. */
  active: RootView;
  /** The pending root some provider shows (the first provider's when they agree), or null. */
  pending: RootView | null;
  /** What the providers disagree on, or null. */
  disagree: string | null;
}

const lc = (x: unknown): string => String(x).toLowerCase();

/** Every distributor's roots on every provider, at one block, in a few
 *  requests per provider (chainview.ts readRootsMany), the providers read
 *  at once. A distributor some provider could not answer for is left out,
 *  with why; `unbatched` names the providers where Multicall3 did not answer. */
async function rootsEverywhere(ctx: OpsContext, ds: Address[], block: bigint): Promise<{ views: Roots[]; failed: [Address, string][]; unbatched: string[] }> {
  const per = await Promise.all(ctx.readers.map(async (r) => ({ label: r.label, ...(await readRootsMany(r, ds, block)) })));
  const fp = (x: { active: RootView; pending: RootView }) => canonicalJson({ a: { ...x.active }, p: { ...x.pending } });
  const views: Roots[] = [];
  const failed: [Address, string][] = [];
  for (const d of ds) {
    const missing = per.find((x) => !x.roots.has(d));
    if (missing) {
      failed.push([d, `${missing.label}: ${missing.errors.get(d) ?? 'no answer'}`]);
      continue;
    }
    const each = per.map((x) => ({ label: x.label, ...x.roots.get(d)! }));
    const differ = each.some((x) => fp(x) !== fp(each[0]));
    const shown = each.find((x) => x.pending.payableAt !== 0n);
    views.push({
      d,
      active: each[0].active,
      pending: each[0].pending.payableAt !== 0n ? each[0].pending : (shown?.pending ?? null),
      disagree: differ ? each.map((x) => `${x.label}: active ${x.active.epoch}, ${x.pending.payableAt !== 0n ? `pending ${x.pending.epoch} (payableAt ${x.pending.payableAt}, root ${x.pending.merkleRoot})` : 'nothing pending'}`).join('; ') : null,
    });
  }
  return { views, failed, unbatched: per.filter((x) => !x.batched).map((x) => x.label) };
}

/** Is epoch `epoch` of `d` still pending on any of this host's providers? */
async function pendingAnywhere(ctx: OpsContext, d: Address, epoch: bigint, block: bigint): Promise<{ pending: RootView | null; active: RootView }> {
  let found: RootView | null = null;
  let active: RootView | null = null;
  for (const r of ctx.readers) {
    const x = await readRoots(r, d, block);
    active ??= x.active;
    if (!found && x.pending.payableAt !== 0n && x.pending.epoch === epoch) found = x.pending;
  }
  return { pending: found, active: active! };
}

const isFrozen = (ctx: OpsContext, block: bigint): Promise<boolean> => ctx.readers[0].read<boolean>(opsFactoryAbi, ctx.cfg.distributorFactory, 'frozen', [], block);

/** Whether a freeze HOLDS: frozen, with no unfreeze announced. One that is
 *  announced ripens on time, and every root still pending then becomes
 *  payable, so whatever owes a freeze owes one then too: a freeze() cancels
 *  the announcement (HolderDistributorFactory.freeze). */
async function freezeHolds(ctx: OpsContext, block: bigint): Promise<{ frozen: boolean; unfreezeAt: bigint; holds: boolean }> {
  const frozen = await isFrozen(ctx, block);
  const unfreezeAt = BigInt(await ctx.readers[0].read<bigint>(opsFactoryAbi, ctx.cfg.distributorFactory, 'pendingUnfreezeAt', [], block));
  return { frozen, unfreezeAt, holds: frozen && unfreezeAt === 0n };
}

/** The checks still running, per context: one abandoned at its deadline ends
 *  at its next read (chainview.ts stoppable), and until it has, its root is
 *  not checked again - a second check would only pile more reads on
 *  whatever made the first one slow. */
const RUNNING = new WeakMap<OpsContext, Set<string>>();
function checking(ctx: OpsContext): Set<string> {
  let s = RUNNING.get(ctx);
  if (!s) RUNNING.set(ctx, (s = new Set()));
  return s;
}

/** One pass of `verify` (guardian = null) or `guardian` (its vetoer key). */
export async function watchTick(ctx: OpsContext, guardian: TxSender | null): Promise<WatchReport> {
  const rep: WatchReport = { ok: true, results: [], vetoed: [], froze: null, errors: [], unchecked: 0, passMs: 0 };
  const { cfg, store, log } = ctx;
  const r0 = ctx.readers[0];
  const t0 = performance.now();
  // the checks' own budget, counted from the first check (step 3)
  let tChecks = t0;
  const checksLeft = () => cfg.guardian.passTimeoutSec * 1000 - (performance.now() - tChecks);
  const checkMs = () => Math.min(cfg.guardian.checkTimeoutSec * 1000, checksLeft());
  let overrun = false;
  let balanceWei: bigint | null = null;
  try {
    // the keepers and the guardian, from their heartbeats - first, so that a
    // chain this host cannot read does not also blind it to them
    if (!guardian) {
      const hbErrors = await watchHeartbeats(ctx);
      if (hbErrors.length) {
        rep.ok = false;
        rep.errors.push(...hbErrors);
      }
    }
    const latest = await commonHead(ctx.readers, 'latest');
    const safe = await commonHead(ctx.readers, 'safe');
    const ds = await discover(ctx, safe.number, { allProviders: true, head: latest.number });
    await roleEvents(ctx, ds, safe.number, { guardian });
    const f = await readFactory(r0, cfg.distributorFactory, latest.number);
    if (guardian && !(await isVetoer(r0, cfg.distributorFactory, guardian.address, latest.number))) {
      await ctx.alerts.raise({ key: 'guardian-not-vetoer', severity: 'page', title: 'The guardian key is NOT a vetoer', text: `${guardian.address} cannot veto on ${cfg.distributorFactory}: it only alerts until the Safe adds it.` }, { cooldownSec: cfg.alerts.reminderSec });
    }
    if (guardian) {
      // a veto it cannot pay for is found when it is needed, inside the hour
      balanceWei = await guardian.balance();
      if (balanceWei < cfg.guardian.lowEthWei) {
        await ctx.alerts.raise({ key: 'low-eth:guardian', severity: 'warn', title: 'The guardian key is LOW ON ETH', text: `${guardian.address} holds ${balanceWei} wei (alert below ${cfg.guardian.lowEthWei}). Fund it: a veto it cannot pay for leaves only the Safe signers to veto inside the hour.` }, { cooldownSec: cfg.alerts.reminderSec });
      }
    }

    // ---- 1. what the guardian already owes: vetoes and a freeze that have not landed
    if (guardian) {
      try {
        await settleOwed(ctx, guardian, rep);
      } catch (e) {
        rep.ok = false;
        rep.errors.push(`owed vetoes: ${errorText(e)}`);
        log.error('owed vetoes not settled', { error: errorText(e) });
      }
    }

    const verified = store.get<Record<string, string>>('verified', {});
    const reasons = store.get<Record<string, Reason>>('verdictReasons', {});
    const checkedNow = new Set<string>();
    const keep = (key: string, res: VerifyResult): void => {
      verified[key] = res.verdict;
      if (res.reason) reasons[key] = res.reason;
      checkedNow.add(key);
      store.set('verified', verified);
      store.set('verdictReasons', reasons);
    };

    // ---- 2. the work, from on-chain state, on every provider, in a few requests each
    const read = await rootsEverywhere(ctx, ds, latest.number);
    const views = read.views;
    for (const [d, why] of read.failed) {
      rep.ok = false;
      rep.errors.push(`${d}: ${why}`);
      log.error('verify step failed', { distributor: d, error: why });
    }
    if (read.unbatched.length) {
      await ctx.alerts.raise({ key: `multicall-missing:${read.unbatched.join(',')}`, severity: 'warn', title: 'Multicall3 did not answer: every root was read on its own', text: `On ${read.unbatched.join(', ')}, aggregate3 at the Multicall3 address failed, so each distributor's active() and pending() were read one call at a time. A pass then takes longer the more launches have sharing on. Check that provider (an eth_call to Multicall3 at a recent block); replace it if it persists.` }, { cooldownSec: cfg.alerts.reminderSec });
    }
    for (const v of views) {
      if (v.disagree) await ctx.alerts.raise({ key: `roots-disagree:${v.d}`, severity: 'page', title: "This host's providers DISAGREE on a distributor's roots", text: `${v.disagree}. A pending root either one shows is treated as unverifiable (vetoed after the grace, or late in its hour). One provider is behind or wrong: check it.`, distributor: v.d });
    }
    // the cached events of roots no longer pending or in force are not needed again
    const inForce = new Set(views.flatMap((v) => [`${v.d}:${v.active.epoch}`, ...(v.pending ? [`${v.d}:${v.pending.epoch}`] : [])]));
    store.update<Record<string, PublishedRoot>>('publishedEvents', {}, (m) => {
      for (const k of Object.keys(m)) if (!inForce.has(k)) delete m[k];
    });

    // ---- 3. the pending roots: those never judged first, then those found
    // unverifiable before, and among each the one whose hour ends first
    // first. Their checks have a budget of their own, counted from here.
    tChecks = performance.now();
    const byHour = (a: Roots, b: Roots) => (a.pending!.payableAt < b.pending!.payableAt ? -1 : a.pending!.payableAt > b.pending!.payableAt ? 1 : 0);
    const judgedBefore = (v: Roots): number => (verified[`${v.d}:${v.pending!.epoch}`] === undefined ? 0 : 1);
    const pending = views.filter((v) => v.pending).sort((a, b) => judgedBefore(a) - judgedBefore(b) || byHour(a, b));
    // when each pending root was first found unverifiable (chain time): its grace runs from there
    const since = store.get<Record<string, number>>('unverifiedSince', {});
    const graceOver = (key: string, nowTs: bigint): boolean => {
      const first = (since[key] ??= Number(nowTs));
      return cfg.guardian.vetoUnverifiedAfterSec > 0 && Number(nowTs) - first >= cfg.guardian.vetoUnverifiedAfterSec;
    };
    // the pending roots this pass has to veto (or, frozen, holds): mismatches,
    // and unverifiable roots past their grace or late
    const bad = new Set<string>();
    let holds = f.frozen && f.pendingUnfreezeAt === 0n;
    const k = cfg.guardian.freezeAtBadRoots;
    // k or more at once: freeze first, once, then send every veto owed
    const tooMany = async (): Promise<void> => {
      if (k === 0 || bad.size < k || holds) return;
      const why = `${bad.size} pending roots to veto at once (guardian.freezeAtBadRoots is ${k})`;
      await ctx.alerts.raise({ key: 'many-bad', severity: 'page', title: `${bad.size} pending roots do NOT verify or cannot be verified - ${guardian ? 'the guardian freezes' : 'freeze'}`, text: `${why}: a publisher holding a stolen key who queues many roots, the theft last, outruns vetoes sent one by one. A freeze holds every pending root (vetoable any time while frozen) until each is checked. If this is an outage (the site and the gateways down, a provider failing), unfreeze once it is over (announceUnfreeze, then unfreeze 48 h later).`, calls: readyCalls(cfg.distributorFactory, [], REASONS.UNVERIFIED, true) });
      if (!guardian) return;
      oweFreeze(ctx, why);
      await settleOwed(ctx, guardian, rep);
      holds = !store.get<{ why: string; since: number } | null>('owedFreeze', null);
    };
    const unreached: Roots[] = [];
    for (const v of pending) {
      const d = v.d;
      const P = v.pending!;
      const key = `${d}:${P.epoch}`;
      try {
        if (verified[key] === 'ok') continue;
        if (verified[key] === 'mismatch') {
          bad.add(key);
          // judged before: a veto that has become possible again (a freeze
          // holds the root past its hour) is owed now
          if (guardian && !store.get<Record<string, Owed>>('owedVetoes', {})[key] && f.frozen) {
            oweVeto(ctx, { d, epoch: P.epoch, reason: reasons[key] ?? REASONS.RECOMPUTE, payableAt: P.payableAt, since: Math.floor(ctx.now() / 1000) });
            if (!holds) await settleOwed(ctx, guardian, rep);
          }
          await tooMany();
          continue;
        }
        let res: VerifyResult;
        if (v.disagree) res = unverified(d, P, `this host's providers disagree on the roots of ${d}: ${v.disagree}`);
        else if (checking(ctx).has(key)) res = unverified(d, P, 'its check from an earlier pass, abandoned at guardian.checkTimeoutSec, is still running (it stops at its next read): not started again');
        else if (checksLeft() <= 0) {
          // NOT a verdict: no time is no evidence against the root (below)
          overrun = true;
          rep.unchecked++;
          unreached.push(v);
          continue;
        } else res = await checkRoot(ctx, d, P, latest.number, safe.number, checkMs());
        rep.results.push(res);
        log.info('epoch checked', { distributor: d, epoch: P.epoch, verdict: res.verdict, reason: res.reason, problems: res.problems.slice(0, 5) });
        keep(key, res);

        // decided on a fresh head: the check may have taken minutes
        const now = await commonHead(ctx.readers, 'latest');
        const fz = await freezeHolds(ctx, now.number);
        const frozenNow = fz.frozen;
        holds = fz.holds;
        const at = await pendingAnywhere(ctx, d, P.epoch, now.number);
        const still = at.pending !== null;
        if (!still && at.active.epoch !== P.epoch) {
          log.info('the root was vetoed while it was being checked', { distributor: d, epoch: P.epoch, verdict: res.verdict });
          continue;
        }
        const vetoable = still && (now.timestamp < P.payableAt || frozenNow);
        const left = Number(P.payableAt - now.timestamp);
        if (res.verdict === 'ok') {
          delete since[key];
          for (const c of res.copies) if (!c.ok) await raiseCopyBad(ctx, d, P.epoch, P.contentHash, c);
        } else if (res.verdict === 'mismatch') {
          if (still) bad.add(key);
          await ctx.alerts.raise({
            key: `mismatch:${d}:${P.epoch}`,
            severity: 'page',
            title: vetoable ? `Epoch ${P.epoch} does NOT verify - veto it` : `Epoch ${P.epoch} does NOT verify and is no longer vetoable`,
            text: `${res.reason}: ${res.problems.slice(0, 6).join('; ')}${vetoable ? `. ${left > 0 ? `${left}s` : 'no time'} left in its veto hour${frozenNow ? ' (frozen: vetoable any time)' : ''}.` : '. Freeze, then work out what the active root pays.'}`,
            distributor: d,
            calls: readyCalls(cfg.distributorFactory, vetoable ? [{ d, epoch: P.epoch }] : [], res.reason!, true),
          });
          if (guardian && vetoable) {
            oweVeto(ctx, { d, epoch: P.epoch, reason: res.reason!, payableAt: P.payableAt, since: Math.floor(ctx.now() / 1000) });
            // freeze on a repeat, or on anything plainly malicious: only
            // bytes that match the on-chain hash and still fail their own
            // root. Frozen with an unfreeze announced is no freeze that holds.
            const malicious = res.reason === REASONS.INVALID;
            const repeat = cfg.guardian.freezeOnRepeat && (await hadEarlierRepeatVeto(ctx, d, latest, safe.number));
            if ((malicious || repeat) && !holds) oweFreeze(ctx, malicious ? 'a file with the on-chain hash that does not match its own root' : 'a repeated mismatch');
          }
          await tooMany();
          // the veto goes out the moment its root is judged, with any others
          // owed - unless a freeze holds every pending root: then together,
          // after the loop
          if (guardian && vetoable && !holds) await settleOwed(ctx, guardian, rep);
        } else {
          const late = left <= cfg.guardian.vetoUnverifiedBeforeSec && vetoable;
          const grace = vetoable && graceOver(key, now.timestamp);
          const owe = late || grace;
          if (owe) bad.add(key);
          const hashBad = res.reason === REASONS.HASH;
          await ctx.alerts.raise({
            key: `unverified:${d}:${P.epoch}${hashBad ? ':hash' : ''}${late ? ':late' : grace ? ':grace' : ''}`,
            // nothing served, or nothing checked in time: an honest keeper
            // reads its copies back before it publishes, so a person looks now
            severity: owe || hashBad || res.reason === REASONS.UNAVAILABLE || res.urgent ? 'page' : 'warn',
            title: hashBad
              ? `Epoch ${P.epoch}: the served copies do not match the on-chain hash${late ? ' and its veto hour is nearly over' : grace ? ` for ${Number(now.timestamp) - since[key]} s` : ''} - fix the site/pins`
              : `Epoch ${P.epoch} could not be verified${late ? ' and its veto hour is nearly over' : grace ? ` for ${Number(now.timestamp) - since[key]} s` : ''}`,
            text: `${res.problems.slice(0, 6).join('; ')}. ${left}s left.${owe ? ` ${guardian ? 'The guardian vetoes it' : 'Veto it'} (unverifiable ${late ? 'in the last minutes of its hour' : `for guardian.vetoUnverifiedAfterSec, ${cfg.guardian.vetoUnverifiedAfterSec} s`}).` : ''}`,
            distributor: d,
            calls: readyCalls(cfg.distributorFactory, [{ d, epoch: P.epoch }], REASONS.UNVERIFIED, false),
          });
          if (guardian && owe) oweVeto(ctx, { d, epoch: P.epoch, reason: REASONS.UNVERIFIED, payableAt: P.payableAt, since: Math.floor(ctx.now() / 1000) });
          await tooMany();
          // late: now; after the grace: with the others, after the loop
          if (guardian && late && !holds) await settleOwed(ctx, guardian, rep);
        }
      } catch (e) {
        rep.ok = false;
        rep.errors.push(`${d}: ${errorText(e)}`);
        log.error('verify step failed', { distributor: d, error: errorText(e) });
      }
    }

    // ---- the pending roots this pass had no time for. No time is no
    // evidence against a root, so none is vetoed for it: one found
    // unverifiable before keeps that verdict (vetoed after its grace, or
    // late, as above), and when one never judged is in its last minutes the
    // guardian freezes instead - once - which holds every pending root until
    // it has checked them.
    if (unreached.length) {
      try {
        const now = await commonHead(ctx.readers, 'latest');
        const fz = await freezeHolds(ctx, now.number);
        holds = fz.holds;
        let unseenLate = 0;
        for (const v of unreached) {
          const P = v.pending!;
          const key = `${v.d}:${P.epoch}`;
          const vetoable = now.timestamp < P.payableAt || fz.frozen;
          const late = vetoable && Number(P.payableAt - now.timestamp) <= cfg.guardian.vetoUnverifiedBeforeSec;
          if (verified[key] !== 'unverifiable') {
            if (late) unseenLate++;
            continue;
          }
          if (late || (vetoable && graceOver(key, now.timestamp))) {
            bad.add(key);
            if (guardian) oweVeto(ctx, { d: v.d, epoch: P.epoch, reason: REASONS.UNVERIFIED, payableAt: P.payableAt, since: Math.floor(ctx.now() / 1000) });
          }
        }
        await ctx.alerts.raise(
          {
            key: unseenLate ? 'guardian-behind:late' : 'guardian-behind',
            severity: unseenLate ? 'page' : 'warn',
            title: `The guardian had no time to check ${unreached.length} pending root(s)${unseenLate ? ` - ${unseenLate} in the last minutes of their hour` : ''}`,
            text: `Its checks ran past guardian.passTimeoutSec (${cfg.guardian.passTimeoutSec} s). A root it has not checked is never vetoed for that; ${unseenLate ? `${unseenLate} of them ${unseenLate === 1 ? 'is' : 'are'} in the last ${cfg.guardian.vetoUnverifiedBeforeSec} s of the hour, so ${guardian ? 'it freezes' : 'freeze'}: that holds every pending root until each is checked.` : 'it checks them on the next passes.'} Too many roots at once, or checks that are too slow: look at its log.`,
            calls: unseenLate ? readyCalls(cfg.distributorFactory, [], REASONS.UNVERIFIED, true) : undefined,
          },
          { cooldownSec: VETO_RETRY_PAGE_SEC },
        );
        if (unseenLate && !holds && guardian) oweFreeze(ctx, `${unseenLate} pending root(s) in the last minutes of their hour that it had no time to check`);
        await tooMany();
      } catch (e) {
        rep.ok = false;
        rep.errors.push(`unchecked roots: ${errorText(e)}`);
        log.error('unchecked roots not handled', { error: errorText(e) });
      }
    }
    const pendingKeys = new Set(pending.map((v) => `${v.d}:${v.pending!.epoch}`));
    store.set('unverifiedSince', Object.fromEntries(Object.entries(since).filter(([key]) => pendingKeys.has(key) && verified[key] !== 'ok')));

    // ---- what this pass decided and has not sent yet: the freeze first,
    // then the vetoes, one vetoMany per reason
    if (guardian) {
      try {
        await settleOwed(ctx, guardian, rep);
      } catch (e) {
        rep.ok = false;
        rep.errors.push(`owed vetoes: ${errorText(e)}`);
        log.error('owed vetoes not settled', { error: errorText(e) });
      }
    }

    // ---- 4. active roots not yet verified (a guardian that started late, a
    // root it could not check while it was pending)
    for (const v of views) {
      const d = v.d;
      const A = v.active;
      if (A.epoch === 0n) continue;
      const key = `${d}:${A.epoch}`;
      try {
        // one whose abandoned check still runs keeps its stored verdict (as a pending root does)
        if (verified[key] !== 'ok' && verified[key] !== 'mismatch' && !checking(ctx).has(key)) {
          if (checksLeft() <= 0) {
            overrun = true;
            rep.unchecked++;
            continue;
          }
          const res = await checkRoot(ctx, d, A, latest.number, safe.number, checkMs());
          rep.results.push(res);
          log.info('epoch checked', { distributor: d, epoch: A.epoch, verdict: res.verdict, reason: res.reason, problems: res.problems.slice(0, 5) });
          keep(key, res);
          if (res.verdict === 'ok') {
            for (const c of res.copies) if (!c.ok) await raiseCopyBad(ctx, d, A.epoch, A.contentHash, c);
          } else if (res.verdict === 'mismatch') {
            await ctx.alerts.raise({ key: `mismatch:${d}:${A.epoch}`, severity: 'page', title: `Epoch ${A.epoch} does NOT verify and is no longer vetoable`, text: `${res.reason}: ${res.problems.slice(0, 6).join('; ')}. Freeze, then work out what the active root pays.`, distributor: d, calls: readyCalls(cfg.distributorFactory, [], res.reason!, true) });
          } else if (res.reason === REASONS.HASH) {
            await ctx.alerts.raise({ key: `unverified:${d}:${A.epoch}:hash`, severity: 'page', title: `Epoch ${A.epoch}: the served copies do not match the on-chain hash - fix the site/pins`, text: `${res.problems.slice(0, 6).join('; ')}.`, distributor: d });
          }
        }
        if (verified[key] === 'mismatch') {
          await ctx.alerts.raise({ key: `active-mismatch:${d}:${A.epoch}`, severity: 'page', title: 'An ACTIVE root does not verify', text: `Epoch ${A.epoch} of ${d} pays and does not verify. Freeze now (no new roots), then decide.`, distributor: d, calls: readyCalls(cfg.distributorFactory, [], REASONS.RECOMPUTE, true) });
        }
      } catch (e) {
        rep.ok = false;
        rep.errors.push(`${d}: ${errorText(e)}`);
        log.error('verify step failed', { distributor: d, error: errorText(e) });
      }
    }

    // ---- 5. the site copy users read, of every verified root in force or pending
    for (const v of views) {
      for (const R of [v.pending, v.active]) {
        // a root checked in this pass had every copy checked just now
        if (!R || R.epoch === 0n || verified[`${v.d}:${R.epoch}`] !== 'ok' || checkedNow.has(`${v.d}:${R.epoch}`)) continue;
        const site = ctx.files.siteUrl(v.d, R.epoch);
        if (!site) continue;
        if (checksLeft() <= 0) {
          overrun = true;
          continue;
        }
        const { check } = await ctx.files.checkCopy('site', site, R.contentHash, null, AbortSignal.timeout(Math.max(1, checkMs())));
        if (!check.ok) await raiseCopyBad(ctx, v.d, R.epoch, R.contentHash, check);
      }
    }

    if (overrun) {
      rep.ok = false;
      rep.errors.push(`this pass ran past its ${cfg.guardian.passTimeoutSec} s deadline (guardian.passTimeoutSec): ${rep.unchecked} root(s) not checked`);
    }
  } catch (e) {
    rep.ok = false;
    rep.errors.push(errorText(e));
    log.error('watch tick failed', { error: errorText(e) });
  } finally {
    rep.passMs = Math.round(performance.now() - t0);
    try {
      const live = await trackLiveness(ctx, guardian ? 'guardian' : 'verify', rep.ok, rep.errors[0] ?? null, guardian ? cfg.guardian.failingAfterSec : cfg.verifier.failingAfterSec);
      if (guardian) await guardianHeartbeat(ctx, guardian, rep, live, balanceWei);
    } catch (e) {
      log.warn('liveness or heartbeat not recorded', { error: errorText(e) });
    }
    ctx.store.flush();
  }
  return rep;
}

/** One root: its event on every provider, then verifyPublished, all within
 *  `ms`. A check that runs out is unverifiable, never a wait: it is told to
 *  stop (its downloads end at once, its reads at the next one), and until it
 *  has, its root is not checked again (`checking`). */
async function checkRoot(ctx: OpsContext, d: Address, root: RootView, head: bigint, safe: bigint, ms: number): Promise<VerifyResult> {
  const sec = Math.max(1, Math.round(ms / 1000));
  const key = `${d}:${root.epoch}`;
  const running = checking(ctx);
  return within(
    ms,
    async (signal) => {
      running.add(key);
      try {
        const readers = ctx.readers.map((r) => stoppable(r, signal));
        const ev = await eventEverywhere(ctx, readers, d, root, head);
        if (!ev.p) {
          await ctx.alerts.raise({ key: `event-unseen:${d}:${root.epoch}`, severity: 'page', title: `Epoch ${root.epoch} is on chain, and its RootPublished cannot be trusted`, text: `${ev.problem}. The root is treated as unverifiable (vetoed after the grace, or late in its hour). A provider of this host leaves events out or invents them: check both.`, distributor: d });
          return unverified(d, root, ev.problem!);
        }
        return await verifyPublished({ readers: ctx.readers, sharing: ctx.cfg.sharing, files: ctx.files, allowSingleProvider: ctx.allowSingleProvider, signal, distributorsAt: (T) => boundDistributors({ ...ctx, readers }, T, safe) }, d, ev.p);
      } finally {
        running.delete(key);
      }
    },
    () => unverified(d, root, `not checked within ${sec} s (guardian.checkTimeoutSec): a copy or a read did not finish in time`),
  );
}

// ---------------------------------------------------------------- what the guardian owes

function oweVeto(ctx: OpsContext, o: Owed): void {
  ctx.store.update<Record<string, Owed>>('owedVetoes', {}, (m) => {
    m[`${o.d}:${o.epoch}`] ??= o;
  });
  ctx.store.flush(); // owed before it is sent: a crash mid-send leaves it owed
}

function oweFreeze(ctx: OpsContext, why: string): void {
  if (!ctx.store.get<{ why: string; since: number } | null>('owedFreeze', null)) ctx.store.set('owedFreeze', { why, since: Math.floor(ctx.now() / 1000) });
  ctx.store.flush();
}

/** Sends what is owed. The freeze first: it holds every pending root, so
 *  the vetoes after it cannot run out of hour. Then every owed veto, each
 *  root read again on every provider at a fresh head just before (in
 *  batches): one no longer pending (vetoed by anyone) is done, one whose
 *  hour is over while the factory is not frozen is missed and pages; the
 *  rest go out in vetoMany transactions of up to VETO_BATCH roots, one per
 *  reason - a vetoMany reverts whole if one of its roots is no longer
 *  pending, which is why the list is read again right before - and a batch
 *  that would revert or was mined reverted is sent again one root per
 *  transaction. */
async function settleOwed(ctx: OpsContext, guardian: TxSender, rep: WatchReport): Promise<void> {
  await settleFreeze(ctx, guardian, rep);
  const { store, log } = ctx;
  const owed = store.get<Record<string, Owed>>('owedVetoes', {});
  const keys = Object.keys(owed);
  if (!keys.length) return;
  const head = await commonHead(ctx.readers, 'latest');
  const frozen = await isFrozen(ctx, head.number);
  const states = await owedStates(ctx, keys.map((k) => owed[k]), head, frozen);
  const live: [string, Owed][] = [];
  for (const [i, k] of keys.entries()) {
    const o = owed[k];
    const st = states[i];
    if (st === 'pending') live.push([k, o]);
    else await dropOwed(ctx, k, o, st);
  }
  const byReason = new Map<Reason, [string, Owed][]>();
  for (const x of live) byReason.set(x[1].reason, [...(byReason.get(x[1].reason) ?? []), x]);
  for (const [reason, all] of byReason) {
    for (let b = 0; b < all.length; b += VETO_BATCH) {
      const items = all.slice(b, b + VETO_BATCH);
      if (items.length > 1) {
        const r = await sendVeto(ctx, guardian, rep, items, reason);
        if (r !== 'revert') continue;
        log.warn('vetoMany would revert or reverted; one veto per root', { items: items.map((x) => x[0]) });
      }
      for (const it of items) {
        const r = await sendVeto(ctx, guardian, rep, [it], reason);
        if (r === 'revert') {
          // the root moved on between the read and the send: look again now
          const h = await commonHead(ctx.readers, 'latest');
          const st = await owedState(ctx, it[1], h, await isFrozen(ctx, h.number));
          if (st !== 'pending') await dropOwed(ctx, it[0], it[1], st);
          else await vetoFailed(ctx, rep, [it], reason, 'the veto would revert while the root is still pending');
        }
      }
    }
  }
}

type OwedState = 'pending' | 'vetoed' | 'activated' | 'over';

async function owedState(ctx: OpsContext, o: Owed, head: { number: bigint; timestamp: bigint }, frozen: boolean): Promise<OwedState> {
  const { pending, active } = await pendingAnywhere(ctx, o.d, o.epoch, head.number);
  if (pending) return head.timestamp < pending.payableAt || frozen ? 'pending' : 'over';
  return active.epoch === o.epoch ? 'activated' : 'vetoed';
}

/** owedState of many, their roots read in a few requests per provider. A
 *  root some provider could not answer for counts as pending: the send's
 *  own simulation then decides. */
async function owedStates(ctx: OpsContext, items: Owed[], head: { number: bigint; timestamp: bigint }, frozen: boolean): Promise<OwedState[]> {
  const ds = [...new Set(items.map((o) => o.d))];
  const per = await Promise.all(ctx.readers.map((r) => readRootsMany(r, ds, head.number)));
  return items.map((o) => {
    if (per.some((x) => !x.roots.has(o.d))) return 'pending';
    const pending = per.map((x) => x.roots.get(o.d)!.pending).find((p) => p.payableAt !== 0n && p.epoch === o.epoch);
    if (pending) return head.timestamp < pending.payableAt || frozen ? 'pending' : 'over';
    return per[0].roots.get(o.d)!.active.epoch === o.epoch ? 'activated' : 'vetoed';
  });
}

async function dropOwed(ctx: OpsContext, key: string, o: Owed, st: OwedState): Promise<void> {
  ctx.store.update<Record<string, Owed>>('owedVetoes', {}, (m) => {
    delete m[key];
  });
  ctx.store.flush();
  if (st === 'vetoed') {
    ctx.log.info('an owed veto is done: the root is no longer pending', { distributor: o.d, epoch: o.epoch });
    return;
  }
  await ctx.alerts.raise({
    key: `veto-missed:${o.d}:${o.epoch}`,
    severity: 'page',
    title: `The guardian's veto of epoch ${o.epoch} did NOT land in time`,
    text: `It decided to veto epoch ${o.epoch} of ${o.d} (${o.reason}) and could not before its hour ended${st === 'activated' ? '; the root is now ACTIVE' : ''}. Freeze, then work out what the root pays (RUNBOOK part 14, "A wrong root became payable").`,
    distributor: o.d,
    calls: readyCalls(ctx.cfg.distributorFactory, [], o.reason, true),
  });
}

/** One veto transaction (vetoMany for several roots). 'ok' once a receipt
 *  with status 1 is in; 'revert' when it would revert or was mined reverted
 *  (the caller sends one root per transaction, or looks again); 'failed'
 *  otherwise (gas above the cap, no ETH, a stuck key, a provider down), which
 *  pages and stays owed for the next pass. */
async function sendVeto(ctx: OpsContext, guardian: TxSender, rep: WatchReport, items: [string, Owed][], reason: Reason): Promise<'ok' | 'revert' | 'failed'> {
  const { cfg } = ctx;
  const many = items.length > 1;
  const data = many
    ? encodeFunctionData({ abi: opsFactoryAbi, functionName: 'vetoMany', args: [items.map((x) => x[1].d as `0x${string}`), items.map((x) => Number(x[1].epoch)), reasonWord(reason)] })
    : encodeFunctionData({ abi: opsFactoryAbi, functionName: 'veto', args: [items[0][1].d as `0x${string}`, Number(items[0][1].epoch), reasonWord(reason)] });
  const label = `${many ? 'vetoMany' : 'veto'} ${items.map((x) => `${x[1].d}#${x[1].epoch}`).join(', ')} (${reason})`;
  try {
    const sent = await guardian.send({ to: cfg.distributorFactory, data, label, distributors: items.map((x) => x[1].d) });
    if (!sent.receipt.status) {
      ctx.log.warn('a veto was mined and REVERTED', { label, hash: sent.hash });
      return 'revert';
    }
    ctx.store.update<Record<string, Owed>>('owedVetoes', {}, (m) => {
      for (const [k] of items) delete m[k];
    });
    ctx.store.flush();
    for (const [, o] of items) rep.vetoed.push({ d: o.d, epoch: o.epoch, reason, tx: sent.hash });
    return 'ok';
  } catch (e) {
    if (e instanceof WouldRevert) return 'revert';
    await vetoFailed(ctx, rep, items, reason, errorText(e));
    return 'failed';
  }
}

async function vetoFailed(ctx: OpsContext, rep: WatchReport, items: [string, Owed][], reason: Reason, why: string): Promise<void> {
  rep.ok = false;
  rep.errors.push(`veto: ${why}`);
  await ctx.alerts.raise(
    { key: `veto-failed:${items.map((x) => `${x[1].d}#${x[1].epoch}`).join(',')}`, severity: 'page', title: 'The guardian could NOT veto', text: `${why}. It tries again every pass while the root is pending; sign the veto from a Safe now.`, calls: readyCalls(ctx.cfg.distributorFactory, items.map((x) => ({ d: x[1].d, epoch: x[1].epoch })), reason, true) },
    { cooldownSec: VETO_RETRY_PAGE_SEC },
  );
}

async function settleFreeze(ctx: OpsContext, guardian: TxSender, rep: WatchReport): Promise<void> {
  const of = ctx.store.get<{ why: string; since: number } | null>('owedFreeze', null);
  if (!of) return;
  if (Math.floor(ctx.now() / 1000) - of.since > OWED_FREEZE_SEC) {
    ctx.store.delete('owedFreeze');
    ctx.store.flush();
    await ctx.alerts.raise({ key: 'freeze-given-up', severity: 'page', title: 'The guardian GAVE UP freezing', text: `It decided to freeze (${of.why}) a day ago and could not. Freezing is now a person's call: sign the freeze from a Safe if it is still needed.`, calls: readyCalls(ctx.cfg.distributorFactory, [], REASONS.RECOMPUTE, true) });
    return;
  }
  // done only once it HOLDS: frozen with an unfreeze announced is not
  // enough, and a freeze() then cancels the announcement
  const fz = await freezeHolds(ctx, (await commonHead(ctx.readers, 'latest')).number);
  if (fz.frozen && fz.unfreezeAt === 0n) {
    ctx.store.delete('owedFreeze');
    ctx.store.flush();
    return;
  }
  try {
    const sent = await guardian.send({ to: ctx.cfg.distributorFactory, data: encodeFunctionData({ abi: opsFactoryAbi, functionName: 'freeze' }), label: `freeze (${of.why})`, distributors: [] });
    if (!sent.receipt.status) throw new Error(`the freeze was mined and REVERTED (${sent.hash})`);
    ctx.store.delete('owedFreeze');
    ctx.store.flush();
    rep.froze = sent.hash;
    await ctx.alerts.raise({ key: `froze:${sent.hash}`, severity: 'page', title: 'The guardian FROZE holder sharing', text: `Why: ${of.why === 'a repeated mismatch' ? 'a second mismatching root within the repeat window' : of.why}.${fz.frozen ? ' The factory was frozen already, with an unfreeze announced: this freeze cancelled that unfreeze.' : ''} Active roots keep paying; every pending root is held and nothing new is published until the Safe announces an unfreeze (48 h).` });
  } catch (e) {
    rep.ok = false;
    rep.errors.push(`freeze: ${errorText(e)}`);
    await ctx.alerts.raise({ key: 'freeze-failed', severity: 'page', title: 'The guardian could NOT freeze', text: `${errorText(e)}. It tries again every pass (for a day); sign the freeze from a Safe now.`, calls: readyCalls(ctx.cfg.distributorFactory, [], REASONS.RECOMPUTE, true) }, { cooldownSec: VETO_RETRY_PAGE_SEC });
  }
}

/** Did a RECOMPUTE or INVALID veto stop a root of `d` before this pass,
 *  within the repeat window? The event scan has recorded every RootVetoed up
 *  to the safe head (keeper.ts roleEvents); the blocks after it, up to the
 *  pass's head, are read here. The vetoes this pass sends are not in either. */
async function hadEarlierRepeatVeto(ctx: OpsContext, d: Address, head: { number: bigint; timestamp: bigint }, safe: bigint): Promise<boolean> {
  const seen: VetoSeen[] = [...(ctx.store.get<Record<string, VetoSeen[]>>('vetoLog', {})[d] ?? [])];
  const r0 = ctx.readers[0];
  const from = safe + 1n > ctx.cfg.eventsFromBlock ? safe + 1n : ctx.cfg.eventsFromBlock;
  if (head.number >= from) {
    for (const l of await r0.logs({ address: d, topics: [TOPICS.RootVetoed] }, from, head.number)) {
      const a = decodeEventLog({ abi: [EVENTS.RootVetoed], topics: l.topics as any, data: l.data as `0x${string}`, strict: true }).args as any;
      seen.push({ epoch: String(a.epoch), reason: lc(a.reason), block: BigInt(l.blockNumber).toString(), at: Number((await r0.block(BigInt(l.blockNumber))).timestamp) });
    }
  }
  return seen.some((v) => REPEAT_REASONS.has(v.reason) && Number(head.timestamp) - v.at <= ctx.cfg.guardian.repeatWindowSec);
}

// ---------------------------------------------------------------- reports

/** The guardian's heartbeat in the data repo, for the verifiers to watch:
 *  on schedule, and at once when its passes start or stop failing. Only a
 *  guardian given a data repo token writes one. It is signed with the
 *  guardian's vetoer key (liveness.ts says why): a verifier trusts it only
 *  when the signer is a vetoer of this factory on chain. */
async function guardianHeartbeat(ctx: OpsContext, guardian: TxSender, rep: WatchReport, live: Liveness & { changed: boolean }, balanceWei: bigint | null): Promise<void> {
  if (!ctx.repo) return;
  const nowS = Math.floor(ctx.now() / 1000);
  const last = ctx.store.get<number>('heartbeatWrittenAt', 0);
  if (nowS - last < ctx.cfg.lease.heartbeatEverySec && !live.changed) return;
  const status: Record<string, unknown> = {
    schema: 'curb.sharing.status/1',
    role: 'guardian',
    holder: ctx.holder ?? 'guardian',
    heartbeatAt: nowS,
    ok: rep.ok,
    lastOkAt: live.lastOkAt,
    failingSince: live.failingSince,
    guardian: guardian.address,
    chainId: ctx.cfg.sharing.chainId.toString(),
    distributorFactory: ctx.cfg.distributorFactory,
    balanceWei: balanceWei === null ? null : balanceWei.toString(),
    checked: rep.results.length,
    vetoed: rep.vetoed.length,
    owed: Object.keys(ctx.store.get<Record<string, Owed>>('owedVetoes', {})).length,
    passMs: rep.passMs,
    errors: rep.errors,
  };
  const signature = await guardian.signMessage(beatMessage(status));
  if (signature) status.signature = signature;
  await writeHeartbeat(ctx.repo, GUARDIAN_STATUS_PATH, status);
  ctx.store.set('heartbeatWrittenAt', nowS);
}

/** A copy of a verified epoch that does not hash to it: users reading that
 *  copy (the site's verify panel and Claim read the site's) are told the file
 *  does not check out, so the operator hears of it too. */
async function raiseCopyBad(ctx: OpsContext, d: Address, epoch: bigint, contentHash: string, c: CopyCheck): Promise<void> {
  await ctx.alerts.raise({
    key: `copy-bad:${d}:${epoch}:${c.source}`,
    severity: 'warn',
    title: `Epoch ${epoch}: the ${c.source} copy does not match the on-chain hash`,
    text: `${c.source} ${c.sha256 ? `serves bytes whose sha256 is ${c.sha256}, not ${contentHash}` : `could not be read: ${c.error}`}. The root verified from another copy; republish this one (users who read it are told the file does NOT check out).`,
    distributor: d,
  });
}
