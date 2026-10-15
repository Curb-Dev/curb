// CURB-SHARE v1: one epoch attempt (spec README section 1, file section 2).
//
// Exact BigInt arithmetic; `/` is floor division. This must reproduce every
// golden vector in spec/vectors byte for byte; the step numbers are the
// design's (core v2, D.2.3) and the spec's.

import { balancesDigest, transfersDigest } from './encoding.ts';
import { encodeEpoch } from './file.ts';
import { LEAF_ENCODING } from './merkle.ts';
import { BPS, DEAD_ADDRESS, MAX_KEEPER_FEE_BPS, MAX_KEEPER_TXS, SCHEMA, WAD, WEIGHT_FLOOR_DIVISOR, ZERO_ADDRESS } from './constants.ts';
import type {
  AccountRow,
  ActiveState,
  Address,
  AttemptResult,
  EpochContext,
  EpochFile,
  EpochHeader,
  PoolAnswers,
  PriceInput,
  PriceRecord,
  Row,
  Setup,
  StateCommitment,
  TransferLog,
} from './types.ts';
import { addr, fail, uint } from './validate.ts';

export { SPEC_VERSION, SCHEMA, CHUNK_SCHEMA, MAX_KEEPER_FEE_BPS, BPS, WAD, WEIGHT_FLOOR_DIVISOR, MAX_KEEPER_TXS, ZERO_ADDRESS, DEAD_ADDRESS } from './constants.ts';

const cmp = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

/** Asset-0 base units per 10^18 wei (spec 1.5). */
export function priceValue(price: PriceInput | null, quoteIsWeth: boolean, quoteDecimals: bigint): PriceRecord {
  if (quoteIsWeth) return { source: 'weth', feed: '', round: '', value: WAD };
  const e = price?.ethUsd;
  const q = price?.quoteUsd;
  if (!e || !q) return { source: 'none', feed: '', round: '', value: 0n };
  const aE = uint(e.answer, 'price.ethUsd.answer');
  const aQ = uint(q.answer, 'price.quoteUsd.answer');
  const dE = uint(e.decimals, 'price.ethUsd.decimals');
  const dQ = uint(q.decimals, 'price.quoteUsd.decimals');
  if (aE === 0n || aQ === 0n) return { source: 'none', feed: '', round: '', value: 0n };
  const value = (10n ** quoteDecimals * aE * 10n ** dQ) / (aQ * 10n ** dE);
  return {
    source: 'chainlink',
    feed: addr(e.feed, 'price.ethUsd.feed') + ',' + addr(q.feed, 'price.quoteUsd.feed'),
    round: uint(e.round, 'price.ethUsd.round').toString() + ',' + uint(q.round, 'price.quoteUsd.round').toString(),
    value,
  };
}

/** The window of the next attempt: F, the opening block and balances. An
 *  active state must carry its complete balances: one read back from a file
 *  has only the file's commitment to them, and the indexer rebuilds them
 *  from the chain first (epoch.ts). */
export function windowOf(setup: Setup, state: ActiveState | null): { F: bigint; openingBlock: bigint; openingBalances: Map<Address, bigint> } {
  const F = state ? state.toBlock + 1n : setup.sharingSince;
  const openingBlock = state ? state.toBlock : setup.opening.block;
  if (state && !state.balancesAtEnd) fail(`the complete balances after block ${state.toBlock} are needed, not only the file's commitment to them`);
  const openingBalances = state ? state.balancesAtEnd! : setup.opening.balances;
  return { F, openingBlock, openingBalances };
}

/** The block timestamps an attempt reads: ts(F - 1), ts(T) and ts(b - 1) for
 *  every block b in [F, T] with a replayed log (spec 1.2). */
export function timestampsNeeded(F: bigint, T: bigint, transfers: readonly TransferLog[]): bigint[] {
  const out = new Set<bigint>([F - 1n, T]);
  for (const t of transfers) if (t.block >= F && t.block <= T) out.add(t.block - 1n);
  return [...out].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
}

interface Replay {
  F: bigint;
  T: bigint;
  replay: TransferLog[];
  bal: Map<Address, bigint>;
  w: Map<Address, bigint>;
  start: bigint;
  end: bigint;
  supply: bigint;
  floor: bigint;
}

/** Spec 1.1-1.2: the opening state, the replayed logs and the weights. */
function replayAndWeigh(setup: Setup, state: ActiveState | null, T: bigint): Replay {
  const { F, openingBlock, openingBalances } = windowOf(setup, state);
  if (T < F) fail(`toBlock ${T} is before fromBlock ${F}`);
  // openingBlock <= F - 1 always: an active state's toBlock is F - 1, and
  // checkSetup refuses an opening block at or after sharingSince.
  const replay = setup.transfers.filter((t) => t.block > openingBlock && t.block <= T);
  const tsOf = (b: bigint): bigint => {
    const v = setup.timestamps.get(b);
    if (v === undefined) fail(`timestamp of block ${b} is needed`);
    return v;
  };
  const bal = new Map(openingBalances);
  const w = new Map<Address, bigint>();
  const since = new Map<Address, bigint>();
  const start = tsOf(F - 1n);
  const settle = (a: Address, upTo: bigint): void => {
    const b = bal.get(a) ?? 0n;
    const s = since.get(a) ?? start;
    if (b > 0n) w.set(a, (w.get(a) ?? 0n) + b * (upTo - s));
    since.set(a, upTo);
  };
  for (const t of replay) {
    if (t.block >= F) {
      // A balance set in block b is held for dt(b) = ts(b) - ts(b - 1): it
      // accrues from ts(b - 1). One overwritten in the same block accrues
      // over ts(b - 1) - ts(b - 1) = 0.
      const at = tsOf(t.block - 1n);
      if (t.from !== ZERO_ADDRESS) settle(t.from, at);
      if (t.to !== ZERO_ADDRESS) settle(t.to, at);
    }
    if (t.from !== ZERO_ADDRESS) {
      const nb = (bal.get(t.from) ?? 0n) - t.value;
      if (nb < 0n) fail(`balance of ${t.from} goes below zero at block ${t.block} log ${t.logIndex}`);
      bal.set(t.from, nb);
    }
    if (t.to !== ZERO_ADDRESS) bal.set(t.to, (bal.get(t.to) ?? 0n) + t.value);
  }
  const end = tsOf(T);
  for (const a of new Set([...bal.keys(), ...since.keys()])) settle(a, end);
  // The weight floor: a millionth of the supply after T (every balance,
  // summed: all minted less all burned) held from ts(F - 1) to ts(T). A
  // weight below it is set to 0 here, before exclusions and W.
  let supply = 0n;
  for (const b of bal.values()) supply += b;
  const floor = (supply / WEIGHT_FLOOR_DIVISOR) * (end - start);
  for (const [a, x] of w) if (x < floor) w.set(a, 0n);
  return { F, T, replay, bal, w, start, end, supply, floor };
}

/** Every address pool detection probes for an attempt ending at T (spec 1.3
 *  step 4): those with a weight before exclusions, sorted. Only they can
 *  take a share, so a weight below the floor is never asked about. The
 *  indexer answers token0/token1/factory for these at T before the attempt
 *  is computed. */
export function accountsToProbe(setup: Setup, state: ActiveState | null, T: bigint): Address[] {
  const r = replayAndWeigh(setup, state, T);
  return [...r.w].filter(([, x]) => x > 0n).map(([a]) => a).sort(cmp);
}

/** Every non-zero balance of a state, in address order, and the epoch file's
 *  commitment to them (spec 2, `stateAtEnd`). */
export function commitState(balances: Iterable<[Address, bigint]>): { complete: [Address, bigint][]; commitment: StateCommitment } {
  const complete = [...balances].filter(([, b]) => b > 0n).sort((p, q) => cmp(p[0], q[0]));
  let supply = 0n;
  for (const [, b] of complete) supply += b;
  return { complete, commitment: { count: BigInt(complete.length), digest: balancesDigest(complete), supply } };
}

/** The reason a detected pool is excluded with (spec 1.3 step 4): the
 *  factory's label when the rules list it, else what factory() answered. */
export function poolReason(setup: Setup, c: PoolAnswers): string {
  const f = c.factory === null ? undefined : setup.rules.ammFactories.get(c.factory);
  if (f !== undefined) return `detected pool (factory ${c.factory}: ${f})`;
  if (c.factory !== null) return `detected pool (factory ${c.factory}, not in the rules' list)`;
  return 'detected pool (no factory())';
}

/** The fixed exclusions, then the rules' list, then the epoch's additions
 *  (spec 1.3 steps 1-3); an address keeps the first reason it gets. */
export function baseExclusions(setup: Setup, added: { address: Address; reason: string }[]): Map<Address, string> {
  const E = new Map<Address, string>();
  const exclude = (a: Address, reason: string): void => {
    if (!E.has(a)) E.set(a, reason);
  };
  exclude(DEAD_ADDRESS, 'burn address');
  exclude(setup.distributor, 'this distributor');
  exclude(setup.launchToken, 'the launch token');
  exclude(setup.quoteToken, 'the quote token');
  exclude(setup.factory, 'the distributor factory');
  for (const x of setup.rules.exclusions) exclude(x.address, x.reason);
  for (const x of added) exclude(x.address, x.reason);
  return E;
}

/** Compute one epoch attempt. */
export function computeEpoch(ctx: EpochContext): AttemptResult {
  const { setup, state, input } = ctx;
  const N = ctx.lastProposed + 1n;
  const D = setup.distributor;
  const T = input.toBlock;

  // Steps 1-2: window, balances, weights.
  const { F, replay, bal, w, start, end, supply, floor } = replayAndWeigh(setup, state, T);

  // Step 3: exclusions - fixed, rules, added, then detected pools: any
  // weighed address whose token0() or token1() is the launch token, whatever
  // its factory. Excluding a contract only hands its weight to the holders.
  const E = baseExclusions(setup, input.exclusionsAdded);
  const prevCum = state ? state.cum : new Map<Address, [bigint, bigint]>();
  for (const [a, x] of [...w].sort((p, q) => cmp(p[0], q[0]))) {
    if (x === 0n) continue;
    const c = setup.contracts.get(a);
    if (!c) continue;
    if (c.token0 !== setup.launchToken && c.token1 !== setup.launchToken) continue;
    if (!E.has(a)) E.set(a, poolReason(setup, c));
  }
  let W = 0n;
  for (const [a, x] of w) {
    if (E.has(a)) w.set(a, 0n);
    else W += x;
  }

  // Step 4: income.
  const prevTotals = state ? state.totals : { h0: 0n, h1: 0n, k0: 0n };
  const I0 = input.received0 - prevTotals.h0 - prevTotals.k0;
  const I1 = input.received1 - prevTotals.h1;
  if (I0 < 0n || I1 < 0n) fail('received is below what earlier roots allocated');

  const base = {
    epoch: N.toString(),
    fromBlock: F.toString(),
    toBlock: T.toString(),
    supply: supply.toString(),
    floor: floor.toString(),
    W: W.toString(),
    I0: I0.toString(),
    I1: I1.toString(),
  };
  // Step 8, checked in this order.
  if (W === 0n) return { result: 'none', reason: 'no-weight', expected: { result: 'none', reason: 'no-weight', ...base } };
  if (I0 === 0n && I1 === 0n) return { result: 'none', reason: 'no-income', expected: { result: 'none', reason: 'no-income', ...base } };

  // Step 5: keeper fee.
  const keeperKeys = new Set(setup.rules.keeperKeys);
  const txs: EpochFile['keeper']['txs'] = [];
  for (const tx of setup.keeperTxs) {
    if (!keeperKeys.has(tx.from)) continue;
    if (tx.block < F || tx.block > T) continue;
    const cost = tx.gasUsed * tx.effectiveGasPrice + tx.l1Fee;
    let share: bigint;
    if (tx.to === D) share = cost;
    else if (tx.to === setup.factory && tx.names.includes(D)) share = cost / BigInt(tx.names.length);
    else continue;
    txs.push({ hash: tx.hash, gasUsed: tx.gasUsed, price: tx.effectiveGasPrice, l1Fee: tx.l1Fee, share });
  }
  txs.sort((x, y) => cmp(x.hash, y.hash));
  if (txs.length > MAX_KEEPER_TXS) txs.length = MAX_KEEPER_TXS;
  const costWei = txs.reduce((s, t) => s + t.share, 0n);
  const price = priceValue(input.price, setup.quoteIsWeth, setup.quoteDecimals);
  const C = (costWei * price.value) / WAD;
  const cap = (I0 * MAX_KEEPER_FEE_BPS) / BPS;
  let K = C < cap ? C : cap;
  const H = I0 - K;

  // Step 6: shares.
  const s0 = new Map<Address, bigint>();
  const s1 = new Map<Address, bigint>();
  let dH0 = 0n;
  let dH1 = 0n;
  for (const [a, x] of w) {
    if (x === 0n) continue;
    const a0 = (H * x) / W;
    const a1 = (I1 * x) / W;
    s0.set(a, a0);
    s1.set(a, a1);
    dH0 += a0;
    dH1 += a1;
  }
  let recapped = false;
  if (K * BPS > (dH0 + K) * MAX_KEEPER_FEE_BPS) {
    K = (dH0 * MAX_KEEPER_FEE_BPS) / (BPS - MAX_KEEPER_FEE_BPS);
    recapped = true;
  }
  if (dH0 === 0n && dH1 === 0n && K === 0n) {
    return { result: 'none', reason: 'nothing-allocated', expected: { result: 'none', reason: 'nothing-allocated', ...base } };
  }

  // Step 7: cumulative values. Listed: every account with a share this
  // epoch, and every account with an earlier cumulative value - so every
  // listed account has a cumulative value, and a leaf. A weight that rounds
  // to no share is not listed; W carries it.
  const listed = new Set<Address>(prevCum.keys());
  for (const [a, x] of s0) if (x > 0n || (s1.get(a) ?? 0n) > 0n) listed.add(a);
  const rows: Row[] = [];
  const cum = new Map<Address, [bigint, bigint]>();
  for (const a of [...listed].sort(cmp)) {
    const p = prevCum.get(a) ?? [0n, 0n];
    const c0 = p[0] + (s0.get(a) ?? 0n);
    const c1 = p[1] + (s1.get(a) ?? 0n);
    rows.push({ a, w: w.get(a) ?? 0n, s0: s0.get(a) ?? 0n, s1: s1.get(a) ?? 0n, cum0: c0, cum1: c1, b: bal.get(a) ?? 0n });
    if (c0 > 0n || c1 > 0n) cum.set(a, [c0, c1]);
  }

  const totals = { h0: prevTotals.h0 + dH0, h1: prevTotals.h1 + dH1, k0: prevTotals.k0 + K };
  // What the distributor's publish() enforces on chain; a violation here is a bug.
  let sum0 = 0n;
  let sum1 = 0n;
  for (const [c0, c1] of cum.values()) {
    sum0 += c0;
    sum1 += c1;
  }
  if (sum0 !== totals.h0 || sum1 !== totals.h1) throw new Error('leaves do not sum to the totals');
  if (totals.h0 + totals.k0 > input.received0 || totals.h1 > input.received1) throw new Error('allocates more than received');
  if (K * BPS > (dH0 + K) * MAX_KEEPER_FEE_BPS) throw new Error('keeper fee above the on-chain cap');

  // The complete state after T stays complete - a dust balance dropped here
  // would send the next replay below zero when its holder sends it - but the
  // file carries only a commitment to it, and the balances of the accounts
  // it lists. So a million dust balances cost the file nothing.
  const { complete, commitment: stateAtEnd } = commitState(bal);
  if (stateAtEnd.supply !== supply) throw new Error('internal: the state after T does not sum to the supply');

  // The file (spec 2): its index, and past CHUNK_ACCOUNTS rows its chunks;
  // the tree in chunks of the same rows (1.7).
  const supersedes = [...ctx.vetoedSinceActive];
  const exclusions = [...E].sort((x, y) => cmp(x[0], y[0])).map(([address, reason]) => ({ address, reason }));
  const header: Omit<EpochHeader, 'chunks'> = {
    schema: SCHEMA,
    chainId: setup.chainId,
    distributor: D,
    launchToken: setup.launchToken,
    quoteToken: setup.quoteToken,
    epoch: N,
    supersedes,
    window: { fromBlock: F, toBlock: T, fromTime: start, toTime: end, harvestTx: input.harvestTx },
    rules: { version: setup.rules.version, exclusions, keeperKeys: [...setup.rules.keeperKeys].sort(cmp) },
    inputs: {
      received0: input.received0,
      received1: input.received1,
      prevCum: { h0: prevTotals.h0, h1: prevTotals.h1, k0: prevTotals.k0 },
      transfers: { count: BigInt(replay.length), digest: transfersDigest(replay) },
    },
    keeper: { cost: C, txs, price, fee: K, capped: K !== C },
    weights: { W, floor },
    stateAtEnd,
    prev: state ? { epoch: state.epoch, contentHash: state.contentHash, uri: state.uri } : null,
  };
  const enc = encodeEpoch(header, rows);
  const { tree, leaves, leafHashes, contentHash } = enc;
  const fileBytes = enc.bytes;
  const accounts: AccountRow[] = rows.map((r) => ({ a: r.a, w: r.w, s0: r.s0, s1: r.s1, cum0: r.cum0, cum1: r.cum1 }));
  const balancesAtEnd: Record<Address, bigint> = {};
  for (const r of rows) if (r.b > 0n) balancesAtEnd[r.a] = r.b;
  const file: EpochFile = { ...header, chunks: enc.index.chunks, accounts, balancesAtEnd, merkle: { root: tree.root, leafEncoding: LEAF_ENCODING, leaves } };

  const str = (o: AccountRow): Record<string, string> => ({
    a: o.a,
    w: o.w.toString(),
    s0: o.s0.toString(),
    s1: o.s1.toString(),
    cum0: o.cum0.toString(),
    cum1: o.cum1.toString(),
  });
  const expected = {
    result: 'epoch' as const,
    ...base,
    supersedes: supersedes.map(String),
    keeperCostWei: costWei.toString(),
    priceValue: price.value.toString(),
    C: C.toString(),
    K: K.toString(),
    recapped,
    H: H.toString(),
    dH0: dH0.toString(),
    dH1: dH1.toString(),
    unallocated0: (I0 - K - dH0).toString(),
    unallocated1: (I1 - dH1).toString(),
    cumHolders0: totals.h0.toString(),
    cumHolders1: totals.h1.toString(),
    cumKeeper0: totals.k0.toString(),
    excluded: exclusions.map((x) => x.address),
    accounts: accounts.map(str),
    leaves,
    leafHashes,
    merkleRoot: tree.root,
    contentHash,
    chunks: enc.index.chunks.map((c) => ({
      first: c.first,
      last: c.last,
      count: c.count.toString(),
      size: c.size.toString(),
      sha256: c.sha256,
      root: c.root,
      sum0: c.sum0.toString(),
      sum1: c.sum1.toString(),
    })),
  };
  const next: ActiveState = {
    epoch: N,
    toBlock: T,
    balancesAtEnd: new Map(complete),
    stateAtEnd,
    cum,
    totals,
    contentHash,
    uri: input.uri,
  };
  return {
    result: 'epoch',
    expected,
    file,
    fileBytes,
    contentHash,
    chunks: enc.chunks,
    root: { merkleRoot: tree.root, contentHash, cumHolders0: totals.h0, cumHolders1: totals.h1, cumKeeper0: totals.k0, fromBlock: F, toBlock: T, epoch: N },
    next,
  };
}
