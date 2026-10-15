// One epoch, from the chain to the file: everything the CURB-SHARE v1
// calculator needs is read at the harvest block T (which must be at or below
// the `safe` head) from every provider given, the providers are compared,
// and only if they agree is the epoch computed. Nothing here writes anything:
// a disagreement throws, and the caller (the keeper, WP6) publishes nothing.

import { canonicalJson } from './calc/encoding.ts';
import { accountsToProbe, baseExclusions, commitState, computeEpoch, timestampsNeeded, ZERO_ADDRESS } from './calc/share.ts';
import { parseEpochIndex } from './calc/file.ts';
import { bytesEqual } from './calc/vector.ts';
import type { ActiveState, Address, AttemptResult, EpochInput, Setup } from './calc/types.ts';
import { checkSetup, InputError } from './calc/validate.ts';
import {
  collectKeeperTxs,
  discoverSharing,
  findLaunchBlock,
  IndexerError,
  launchExclusions,
  probeAccounts,
  readDecimals,
  readDistributorState,
  readLaunchMeta,
  readPrice,
  replayTransfers,
  type DistributorState,
  type FeedPair,
  type LaunchMeta,
} from './chain/indexer.ts';
import type { ChainReader } from './chain/reader.ts';
import { transfersDigest } from './calc/encoding.ts';
import { MAX_KEEPER_TXS } from './calc/share.ts';
import { StateCache, defaultStateCache } from './state-store.ts';

export interface SharerConfig {
  chainId: bigint;
  graduator: Address;
  /** Where HolderSharingEnabled discovery starts (the Graduator's deploy block). */
  graduatorFromBlock: bigint;
  weth: Address;
  rules: {
    version: bigint;
    /** The config list (spec 1.3 step 2), after the launch's own contracts. */
    exclusions: { address: Address; reason: string }[];
    keeperKeys: Address[];
    ammFactories: { address: Address; reason: string }[];
  };
  /** Chainlink feeds per non-WETH quote token, keyed by the quote token's
   *  address in any letter case (see feedsFor). */
  feeds: Record<Address, FeedPair>;
}

/** The config as the indexer uses it: every address in it - the Graduator,
 *  WETH, each rules entry, each feed key and both feeds of each quote token -
 *  checked to be an address and written in lowercase, so a config may write
 *  them in any letter case and gives the same file as one in lowercase. A
 *  value that is not an address, or one quote token named twice in `feeds`,
 *  is refused here, before anything is read from the chain. */
export function checkConfig(config: SharerConfig): SharerConfig {
  const addr = (x: unknown, what: string): Address => {
    if (typeof x !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(x)) throw new InputError(`config.${what} is not an address: ${String(x)}`);
    return x.toLowerCase();
  };
  const feeds: Record<Address, FeedPair> = {};
  for (const [k, v] of Object.entries(config.feeds ?? {})) {
    const q = addr(k, 'feeds key');
    if (Object.hasOwn(feeds, q)) throw new InputError(`config.feeds names the quote token ${q} twice`);
    feeds[q] = { ethUsd: addr(v?.ethUsd, `feeds[${q}].ethUsd`), quoteUsd: addr(v?.quoteUsd, `feeds[${q}].quoteUsd`) };
  }
  const r = config.rules;
  return {
    ...config,
    graduator: addr(config.graduator, 'graduator'),
    weth: addr(config.weth, 'weth'),
    rules: {
      version: r.version,
      exclusions: r.exclusions.map((x, i) => ({ address: addr(x.address, `rules.exclusions[${i}]`), reason: x.reason })),
      keeperKeys: r.keeperKeys.map((k, i) => addr(k, `rules.keeperKeys[${i}]`)),
      ammFactories: r.ammFactories.map((x, i) => ({ address: addr(x.address, `rules.ammFactories[${i}]`), reason: x.reason })),
    },
    feeds,
  };
}

/** The feeds configured for a quote token. The keys are matched whatever
 *  their letter case, as every other address of the config is, so a config
 *  written with a checksummed address prices the keeper's gas the same as
 *  one written in lowercase; one quote token named twice is refused. */
export function feedsFor(feeds: Record<string, FeedPair>, quote: Address): FeedPair | null {
  const q = quote.toLowerCase();
  let hit: FeedPair | null = null;
  for (const [k, v] of Object.entries(feeds)) {
    if (k.toLowerCase() !== q) continue;
    if (hit) throw new InputError(`config.feeds names the quote token ${q} twice`);
    hit = v;
  }
  return hit;
}

/** One entry of the keeper's transaction journal, as ops/tx.ts records it:
 *  the distributors it was for, every hash signed for it (replacements at
 *  the same nonce included), and the one that was mined, once known. */
export interface KeeperJournalEntry {
  distributors: string[];
  sends: { hash: string }[];
  done?: { hash: string | null; block: string | null } | null;
}

/** The journal's hashes for distributor D that can lie in a window starting
 *  at F (EpochRequest.keeperJournal). An entry whose mined transaction the
 *  journal saw in a block before F is left out whole: its other sends were
 *  replaced at the same nonce and can never be mined. Everything else for D
 *  is kept - an entry not settled yet may still land in the window - and
 *  collectKeeperTxs drops what is outside [F, T] after asking. So the months
 *  of sends a quiet deployment's journal holds are never asked for, and a
 *  provider that pruned them cannot stall the epoch. */
export function keeperJournalHashes(journal: Record<string, KeeperJournalEntry[]>, distributor: Address, F: bigint): string[] {
  const d = distributor.toLowerCase();
  const out: string[] = [];
  for (const list of Object.values(journal)) {
    for (const e of list) {
      if (!e.distributors.map((x) => x.toLowerCase()).includes(d)) continue;
      const b = e.done?.block;
      if (e.done?.hash && typeof b === 'string' && /^(0|[1-9][0-9]*)$/.test(b) && BigInt(b) < F) continue;
      for (const s of e.sends) out.push(s.hash.toLowerCase());
    }
  }
  return [...new Set(out)].sort();
}

/**
 * Complete balances after a block, kept between epochs (state-store.ts): an
 * epoch file commits to the complete state after its T (stateAtEnd) but lists
 * only its own accounts' balances, so the next epoch takes that state from
 * the store when it holds exactly the committed one - in memory, or on disk
 * under /data after a restart - and otherwise rebuilds it from the token's
 * Transfer logs since its launch, once, and keeps it.
 */
export { StateCache, defaultStateCache };

/** How many blocks of the token's history one step of a rebuild replays: the
 *  rebuild holds one step's logs at a time, and stops between two steps when
 *  its caller gives up (PrepareOptions.signal). */
export const REBUILD_STEP_BLOCKS = 250_000n;

export interface EpochRequest {
  distributor: Address;
  /** The harvest() transaction whose block is this epoch's T. */
  harvestTx: string;
  /** Where this epoch's file will be published; the next epoch's `prev.uri`. */
  uri: string;
  /** The active epoch's state: from its checked file (stateFromEpochFile),
   *  whose complete balances are then rebuilt from the chain and checked
   *  against the file's stateAtEnd, or this process's own result.next; null
   *  before the first active epoch. */
  prev: ActiveState | null;
  /** The balances after `block` (< sharingSince) instead of replaying the
   *  token from its launch block: the first epoch's opening state, and where
   *  the rebuild of a later one starts. */
  opening?: { block: bigint; balances: Map<Address, bigint> };
  /** Keeper transactions to consider besides those that emitted a log from
   *  the distributor (reverted ones emit nothing): hashes taken as given. */
  extraKeeperTxs?: string[];
  /** The keeper's transaction journal (ops/tx.ts `txJournal`): its sends for
   *  this distributor that can lie in the window are considered too
   *  (keeperJournalHashes); the rest are never asked for. */
  keeperJournal?: Record<string, KeeperJournalEntry[]>;
  /** Every distributor bound so far; discovered from the Graduator's logs up
   *  to T when not given. */
  distributors?: Address[];
}

export class ProviderDisagreement extends Error {
  readonly parts: string[];
  constructor(parts: string[], labels: string[]) {
    super(`providers ${labels.join(' and ')} disagree on: ${parts.join(', ')} - nothing computed, nothing written`);
    this.name = 'ProviderDisagreement';
    this.parts = parts;
  }
}

export class EpochNotReady extends Error {
  readonly code: string;
  constructor(code: 'pending-root' | 'not-safe' | 'stale-prev' | 'bad-harvest', msg: string) {
    super(msg);
    this.name = 'EpochNotReady';
    this.code = code;
  }
}

export interface Gathered {
  provider: string;
  T: bigint;
  blockHashAtT: string;
  safeHead: bigint;
  meta: LaunchMeta;
  distributorState: DistributorState;
  setup: Setup;
  /** The active state with its complete balances (req.prev's, or rebuilt). */
  state: ActiveState | null;
  input: EpochInput;
  lastProposed: bigint;
  vetoedSinceActive: bigint[];
}

export const ONCHAIN_EXCLUDED_REASON = "excluded by the distributor's isExcluded";

/** The complete balances after the active epoch's toBlock: from the store
 *  when it holds exactly the state the active file commits to, otherwise
 *  rebuilt by replaying the token from `start` (the state before sharing
 *  began) and checked against that commitment - one rebuild at a time per
 *  state, whoever asks. A rebuilt state that is not the committed one is an
 *  error: the active file and the chain disagree. */
async function completeState(
  r: ChainReader,
  chainId: bigint,
  token: Address,
  prev: ActiveState,
  start: () => Promise<{ block: bigint; balances: Map<Address, bigint> }>,
  cache: StateCache | null,
  run: RunOptions,
): Promise<Map<Address, bigint>> {
  const hit = cache?.get(chainId, token, prev.toBlock, prev.stateAtEnd);
  if (hit) return hit;
  const { signal } = run;
  const step = run.rebuildStepBlocks ?? REBUILD_STEP_BLOCKS;
  if (step < 1n) throw new Error('rebuildStepBlocks must be at least 1');
  const rebuild = async (): Promise<Map<Address, bigint>> => {
    const from = await start();
    signal?.throwIfAborted();
    if (from.block >= prev.toBlock) throw new IndexerError(`the replay would start at block ${from.block}, at or after the active epoch's toBlock ${prev.toBlock}`);
    const bal = new Map(from.balances);
    // Step by step, so one step's logs are held at a time and a caller that
    // gave up (a guardian check past its deadline) stops the replay.
    for (let a = from.block + 1n; a <= prev.toBlock; a += step) {
      const b = a + step - 1n < prev.toBlock ? a + step - 1n : prev.toBlock;
      const logs = await replayTransfers(r, token, a, b);
      signal?.throwIfAborted();
      for (const t of logs) {
        if (t.from !== ZERO_ADDRESS) {
          const nb = (bal.get(t.from) ?? 0n) - t.value;
          if (nb < 0n) throw new IndexerError(`${r.label}: the balance of ${t.from} goes below zero at block ${t.block} log ${t.logIndex} in the rebuild`);
          bal.set(t.from, nb);
        }
        if (t.to !== ZERO_ADDRESS) bal.set(t.to, (bal.get(t.to) ?? 0n) + t.value);
      }
    }
    const { complete, commitment: c } = commitState(bal);
    const w = prev.stateAtEnd;
    if (c.digest !== w.digest || c.count !== w.count || c.supply !== w.supply) {
      throw new IndexerError(
        `${r.label}: the balances after block ${prev.toBlock} rebuilt from the chain (${c.count} balances, supply ${c.supply}, digest ${c.digest}) are not the ones epoch ${prev.epoch}'s file commits to (${w.count}, ${w.supply}, ${w.digest})`,
      );
    }
    const balances = new Map(complete);
    cache?.put(chainId, token, prev.toBlock, balances, c);
    return balances;
  };
  return cache ? cache.once(chainId, token, prev.toBlock, prev.stateAtEnd, rebuild) : rebuild();
}

/** How one gathering runs (PrepareOptions passes them on). */
export interface RunOptions {
  /** Stops the work between two reads once aborted, throwing the abort's reason. */
  signal?: AbortSignal;
  /** The blocks one rebuild step replays (REBUILD_STEP_BLOCKS when left out). */
  rebuildStepBlocks?: bigint;
}

/** Reads everything one epoch needs from one provider, at T. With
 *  `run.signal`, it stops between two reads once the signal is aborted (the
 *  abort's reason is thrown), so a check its caller gave up on does not go on
 *  reading. */
export async function gatherEpoch(r: ChainReader, given: SharerConfig, req: EpochRequest, cache: StateCache | null = defaultStateCache, run: RunOptions = {}): Promise<Gathered> {
  const { signal } = run;
  const at = async <T>(p: Promise<T>): Promise<T> => {
    const v = await p;
    signal?.throwIfAborted();
    return v;
  };
  signal?.throwIfAborted();
  const config = checkConfig(given);
  const D = req.distributor.toLowerCase();
  const chainId = await at(r.chainId());
  if (chainId !== config.chainId) throw new Error(`${r.label}: chain ${chainId}, expected ${config.chainId}`);

  // The window's end: the harvest transaction's block, which must be safe.
  const rc = await at(r.receipt(req.harvestTx));
  if (!rc.status) throw new EpochNotReady('bad-harvest', `harvest tx ${req.harvestTx} reverted`);
  if (rc.to !== D) throw new EpochNotReady('bad-harvest', `harvest tx ${req.harvestTx} was sent to ${rc.to}, not the distributor ${D}`);
  const T = rc.blockNumber;
  const safe = await at(r.head('safe'));
  if (T > safe.number) throw new EpochNotReady('not-safe', `harvest block ${T} is above the safe head ${safe.number} on ${r.label}`);
  const hT = await at(r.block(T));
  if (hT.hash !== rc.blockHash) throw new Error(`${r.label}: the harvest receipt names block hash ${rc.blockHash}, block ${T} is ${hT.hash}`);

  const meta = await at(readLaunchMeta(r, config.graduator, D, T));
  const st = await at(readDistributorState(r, D, T));
  if (st.pending.payableAt !== 0n) throw new EpochNotReady('pending-root', `epoch ${st.pending.epoch} is pending on ${D}; no epoch is computed while a root is pending`);
  const prev = req.prev;
  if (st.active.epoch === 0n) {
    if (prev) throw new EpochNotReady('stale-prev', `a previous state for epoch ${prev.epoch} was given, but ${D} has no active epoch`);
  } else {
    const a = st.active;
    if (!prev) throw new EpochNotReady('stale-prev', `${D} has active epoch ${a.epoch}; its file's state is needed`);
    if (prev.epoch !== a.epoch || prev.contentHash !== a.contentHash || prev.toBlock !== a.toBlock) {
      throw new EpochNotReady('stale-prev', `the previous state is epoch ${prev.epoch} (${prev.contentHash}), the active root is epoch ${a.epoch} (${a.contentHash})`);
    }
    if (prev.totals.h0 !== a.cumHolders0 || prev.totals.h1 !== a.cumHolders1 || prev.totals.k0 !== a.cumKeeper0) {
      throw new EpochNotReady('stale-prev', `the previous state's totals are not the active root's`);
    }
  }
  const vetoedSinceActive: bigint[] = [];
  for (let n = st.active.epoch + 1n; n <= st.lastProposedEpoch; n++) vetoedSinceActive.push(n);

  const distributors = req.distributors ?? (await at(discoverSharing(r, config.graduator, config.graduatorFromBlock, T))).map((s) => s.distributor);

  // The opening state and the replayed logs (spec 1.1). The state before
  // sharing began opens the first epoch; a later epoch opens at the active
  // epoch's complete state, which is rebuilt from there when only its file's
  // commitment is at hand.
  const preSharing = async (): Promise<{ block: bigint; balances: Map<Address, bigint> }> => {
    if (req.opening) return req.opening;
    if (meta.launchedAt === null) throw new Error(`the registry record of ${meta.token} has no launchedAt; give the opening state`);
    // No launch is older than the Graduator it graduates into (DeployCurb
    // deploys the Graduator before any launch factory), so the bisection
    // starts there rather than at genesis: a few header reads, not ~26
    // reaching into an archive. A wrong graduatorFromBlock fails loudly
    // (no LaunchRegistered in the block found), never silently.
    const lo = config.graduatorFromBlock < meta.sharingSince ? config.graduatorFromBlock : 0n;
    const launchBlock = await at(findLaunchBlock(r, meta.registry, meta.token, meta.launchedAt, lo, meta.sharingSince));
    return { block: launchBlock - 1n, balances: new Map() };
  };
  let opening = { block: meta.sharingSince - 1n, balances: new Map<Address, bigint>() };
  let state: ActiveState | null = prev;
  if (!prev) opening = await preSharing();
  else if (!prev.balancesAtEnd) state = { ...prev, balancesAtEnd: await at(completeState(r, chainId, meta.token, prev, preSharing, cache, run)) };
  const F = prev ? prev.toBlock + 1n : meta.sharingSince;
  const openingBlock = prev ? prev.toBlock : opening.block;
  const transfers = await at(replayTransfers(r, meta.token, openingBlock + 1n, T));
  const timestamps = await at(r.timestamps(timestampsNeeded(F, T, transfers)));

  const quoteIsWeth = meta.quoteToken === config.weth.toLowerCase();
  const setup: Setup = checkSetup({
    chainId,
    distributor: D,
    factory: meta.factory,
    launchToken: meta.token,
    quoteToken: meta.quoteToken,
    quoteIsWeth,
    quoteDecimals: await at(readDecimals(r, meta.quoteToken, T)),
    sharingSince: meta.sharingSince,
    rules: {
      version: config.rules.version,
      exclusions: [...launchExclusions(meta, distributors), ...config.rules.exclusions.map((x) => ({ address: x.address.toLowerCase(), reason: x.reason }))],
      keeperKeys: config.rules.keeperKeys.map((k) => k.toLowerCase()),
      ammFactories: new Map(config.rules.ammFactories.map((x) => [x.address.toLowerCase(), x.reason])),
    },
    contracts: new Map(),
    opening,
    timestamps,
    transfers,
    keeperTxs: [],
  });

  // Pool detection and the distributor's own exclusions, for every address
  // the attempt weighs (spec 1.3 step 4).
  const E0 = baseExclusions(setup, []);
  const probe = accountsToProbe(setup, state, T).filter((a) => !E0.has(a));
  const probed = await at(probeAccounts(r, D, probe, T));
  setup.contracts = probed.contracts;

  const named = [...(req.extraKeeperTxs ?? []), ...(req.keeperJournal ? keeperJournalHashes(req.keeperJournal, D, F) : [])];
  setup.keeperTxs = await at(collectKeeperTxs(r, D, meta.factory, F, T, named));
  // the checked config's feeds are keyed in lowercase, as meta.quoteToken is
  const price = quoteIsWeth ? null : await at(readPrice(r, Object.hasOwn(config.feeds, meta.quoteToken) ? config.feeds[meta.quoteToken] : null, T));

  const input: EpochInput = {
    toBlock: T,
    harvestTx: req.harvestTx.toLowerCase(),
    uri: req.uri,
    vetoed: false,
    received0: st.received0,
    received1: st.received1,
    price,
    exclusionsAdded: probed.excludedOnChain.map((address) => ({ address, reason: ONCHAIN_EXCLUDED_REASON })),
  };
  return { provider: r.label, T, blockHashAtT: hT.hash, safeHead: safe.number, meta, distributorState: st, setup, state, input, lastProposed: st.lastProposedEpoch, vetoedSinceActive };
}

/** The parts of a gathering two providers must agree on. */
export function fingerprint(g: Gathered): Record<string, string> {
  const m = <K, V>(x: Map<K, V>): [string, unknown][] => [...x].map(([k, v]) => [String(k), v] as [string, unknown]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const s = g.setup;
  return {
    toBlock: g.T.toString(),
    blockHashAtT: g.blockHashAtT,
    'transfers.count': String(s.transfers.length),
    'transfers.digest': transfersDigest(s.transfers),
    timestamps: canonicalJson(m(s.timestamps)),
    launch: canonicalJson({ ...g.meta }),
    distributor: canonicalJson({ ...g.distributorState, active: { ...g.distributorState.active }, pending: { ...g.distributorState.pending } }),
    quote: canonicalJson([s.quoteToken, s.quoteDecimals, s.quoteIsWeth]),
    exclusions: canonicalJson(s.rules.exclusions),
    pools: canonicalJson(m(s.contracts).map(([a, c]) => [a, { ...(c as object) }])),
    excludedOnChain: canonicalJson(g.input.exclusionsAdded),
    keeperTxs: canonicalJson(s.keeperTxs.map((t) => ({ ...t }))),
    price: canonicalJson(g.input.price),
    income: canonicalJson([g.input.received0, g.input.received1]),
  };
}

export interface PreparedEpoch {
  result: AttemptResult;
  gathered: Gathered;
}

export interface PrepareOptions extends RunOptions {
  allowSingleProvider?: boolean;
  /** Where complete states are kept between epochs (defaultStateCache when
   *  left out; null keeps none, so every later epoch replays from launch). */
  stateCache?: StateCache | null;
  /** Stops the work between two reads once aborted, throwing the abort's
   *  reason: the guardian's deadline for one check. A check given up on must
   *  not go on replaying and reading in the background. */
  signal?: AbortSignal;
}

/** Gathers from every provider, aborts on any disagreement, and computes. */
export async function prepareEpoch(readers: ChainReader[], config: SharerConfig, req: EpochRequest, opts: PrepareOptions = {}): Promise<PreparedEpoch> {
  if (readers.length === 0) throw new Error('no provider');
  if (readers.length < 2 && !opts.allowSingleProvider) throw new Error('two providers are needed (allowSingleProvider to run on one)');
  const cache = opts.stateCache === undefined ? defaultStateCache : opts.stateCache;
  const all: Gathered[] = [];
  for (const r of readers) all.push(await gatherEpoch(r, config, req, cache, { signal: opts.signal, rebuildStepBlocks: opts.rebuildStepBlocks }));
  opts.signal?.throwIfAborted();
  const base = fingerprint(all[0]);
  for (const g of all.slice(1)) {
    const fp = fingerprint(g);
    const parts = Object.keys(base).filter((k) => base[k] !== fp[k]);
    if (parts.length) throw new ProviderDisagreement(parts, [all[0].provider, g.provider]);
  }
  const g = all[0];
  const result = computeEpoch({ setup: g.setup, state: g.state, lastProposed: g.lastProposed, vetoedSinceActive: g.vetoedSinceActive, input: g.input });
  // The state after T, for the epoch after this one, when it becomes active.
  if (result.result === 'epoch' && result.next.balancesAtEnd) cache?.put(g.setup.chainId, g.setup.launchToken, result.next.toBlock, result.next.balancesAtEnd, result.next.stateAtEnd);
  return { result, gathered: g };
}

export interface Recomputed {
  same: boolean;
  problems: string[];
  prepared: PreparedEpoch;
}

/** The verifier's check of a published file: recompute the epoch from the
 *  chain (on the verifier's own providers) with the file's harvest tx and
 *  keeper transactions, and compare the bytes. A file naming more keeper
 *  transactions than any epoch attributes (MAX_KEEPER_TXS) is refused before
 *  a single one is looked up: each would cost a request on every provider.
 *  `opts.signal` stops the recompute when its caller gives up on it. */
export async function recomputeEpochFile(
  readers: ChainReader[],
  config: SharerConfig,
  fileBytes: Uint8Array,
  ctx: { prev: ActiveState | null; uri: string; distributors?: Address[]; opening?: EpochRequest['opening'] },
  opts: PrepareOptions = {},
): Promise<Recomputed> {
  // the index alone: the recompute gives an index naming every chunk by its sha256
  const f = parseEpochIndex(fileBytes);
  if (f.keeper.txs.length > MAX_KEEPER_TXS) throw new InputError(`the file names ${f.keeper.txs.length} keeper transactions, more than the ${MAX_KEEPER_TXS} an epoch attributes: nothing is looked up`);
  const prepared = await prepareEpoch(
    readers,
    config,
    {
      distributor: f.distributor,
      harvestTx: f.window.harvestTx,
      uri: ctx.uri,
      prev: ctx.prev,
      opening: ctx.opening,
      extraKeeperTxs: f.keeper.txs.map((t) => t.hash),
      distributors: ctx.distributors,
    },
    opts,
  );
  const problems: string[] = [];
  const r = prepared.result;
  if (r.result !== 'epoch') problems.push(`the chain gives no epoch (${r.reason})`);
  else {
    if (r.root.epoch !== f.epoch) problems.push(`recomputed epoch number ${r.root.epoch}, the file says ${f.epoch}`);
    if (r.root.merkleRoot !== f.merkle.root) problems.push(`recomputed root ${r.root.merkleRoot}, the file says ${f.merkle.root}`);
    if (!bytesEqual(r.fileBytes, fileBytes)) problems.push('the recomputed file bytes differ');
  }
  return { same: problems.length === 0, problems, prepared };
}
