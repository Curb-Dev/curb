// Types of the CURB-SHARE v1 calculator. Addresses are lowercase 0x hex
// strings everywhere inside the calculator; every amount is a bigint.

export type Hex = `0x${string}`;
/** A lowercase 0x-prefixed 20-byte address. */
export type Address = string;

export interface TransferLog {
  block: bigint;
  logIndex: bigint;
  from: Address;
  to: Address;
  value: bigint;
}

export interface KeeperTx {
  hash: string;
  from: Address;
  to: Address;
  block: bigint;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  l1Fee: bigint;
  /** The distinct distributors a factory call names (empty for a direct call). */
  names: Address[];
}

/** What a probed address answered to token0(), token1() and factory(); null
 *  for a call that did not answer with an address (spec 1.3 step 4). */
export interface PoolAnswers {
  token0: Address | null;
  token1: Address | null;
  factory: Address | null;
}

export interface Rules {
  version: bigint;
  exclusions: { address: Address; reason: string }[];
  keeperKeys: Address[];
  /** AMM factory address -> reason. A label for a detected pool's reason
   *  only: a pool is detected by its tokens, whatever its factory. */
  ammFactories: Map<Address, string>;
}

/** What an epoch file commits to about the complete balances after its T
 *  (spec 2, `stateAtEnd`): how many are non-zero, their keccak digest and
 *  their sum, the token's supply. */
export interface StateCommitment {
  count: bigint;
  digest: string;
  supply: bigint;
}

/** Everything about a launch that does not change from epoch to epoch,
 *  plus the chain data an epoch reads (the token's transfers, the block
 *  times, the keeper transactions, the pool answers). */
export interface Setup {
  chainId: bigint;
  distributor: Address;
  factory: Address;
  launchToken: Address;
  quoteToken: Address;
  quoteIsWeth: boolean;
  quoteDecimals: bigint;
  sharingSince: bigint;
  rules: Rules;
  /** eth_call answers for pool detection, per probed address. */
  contracts: Map<Address, PoolAnswers>;
  /** The state before the first epoch. */
  opening: { block: bigint; balances: Map<Address, bigint> };
  timestamps: Map<bigint, bigint>;
  /** Sorted by (block, logIndex), no duplicates, all after opening.block. */
  transfers: TransferLog[];
  keeperTxs: KeeperTx[];
}

export interface FeedAnswer {
  feed: string;
  round: string;
  answer: string;
  decimals: string;
}

export interface PriceInput {
  ethUsd?: FeedAnswer | null;
  quoteUsd?: FeedAnswer | null;
}

export interface EpochInput {
  toBlock: bigint;
  harvestTx: string;
  uri: string;
  vetoed: boolean;
  received0: bigint;
  received1: bigint;
  price: PriceInput | null;
  exclusionsAdded: { address: Address; reason: string }[];
}

/** The active epoch, as the next epoch needs it. */
export interface ActiveState {
  epoch: bigint;
  toBlock: bigint;
  /** Every non-zero balance after toBlock: the next epoch's opening state,
   *  complete. Null for a state read back from a file: the file lists only
   *  its own accounts' balances and commits to the rest (stateAtEnd), and
   *  the indexer rebuilds them from the chain and checks them against it. */
  balancesAtEnd: Map<Address, bigint> | null;
  stateAtEnd: StateCommitment;
  /** Accounts with a non-zero cumulative value: [cum0, cum1]. */
  cum: Map<Address, [bigint, bigint]>;
  totals: { h0: bigint; h1: bigint; k0: bigint };
  contentHash: string;
  uri: string;
}

export interface EpochContext {
  setup: Setup;
  state: ActiveState | null;
  /** The highest epoch number ever proposed, vetoed ones included. */
  lastProposed: bigint;
  /** Epoch numbers vetoed after the active one, ascending. */
  vetoedSinceActive: bigint[];
  input: EpochInput;
}

export interface AccountRow {
  a: Address;
  w: bigint;
  s0: bigint;
  s1: bigint;
  cum0: bigint;
  cum1: bigint;
}

export type Leaf = [Address, Address, string, string];

export interface PriceRecord {
  source: 'weth' | 'chainlink' | 'none';
  feed: string;
  round: string;
  value: bigint;
}

/** One chunk of a chunked epoch file, as its index describes it (spec 2):
 *  CHUNK_ACCOUNTS consecutive rows in address order (the last chunk may hold
 *  fewer), from `first` to `last`; the byte length and sha256 of its file;
 *  the root of its own tree; the sums of its cumulative values. */
export interface ChunkInfo {
  first: Address;
  last: Address;
  count: bigint;
  size: bigint;
  sha256: string;
  root: string;
  sum0: bigint;
  sum1: bigint;
}

/** Everything an epoch file says outside its account rows. */
export interface EpochHeader {
  schema: string;
  chainId: bigint;
  distributor: Address;
  launchToken: Address;
  quoteToken: Address;
  epoch: bigint;
  supersedes: bigint[];
  window: { fromBlock: bigint; toBlock: bigint; fromTime: bigint; toTime: bigint; harvestTx: string };
  rules: { version: bigint; exclusions: { address: Address; reason: string }[]; keeperKeys: Address[] };
  inputs: {
    received0: bigint;
    received1: bigint;
    prevCum: { h0: bigint; h1: bigint; k0: bigint };
    transfers: { count: bigint; digest: string };
  };
  keeper: {
    cost: bigint;
    txs: { hash: string; gasUsed: bigint; price: bigint; l1Fee: bigint; share: bigint }[];
    price: PriceRecord;
    fee: bigint;
    capped: boolean;
  };
  /** W and the weight floor (spec 1.2). */
  weights: { W: bigint; floor: bigint };
  /** The commitment to every non-zero balance after T. */
  stateAtEnd: StateCommitment;
  prev: { epoch: bigint; contentHash: string; uri: string } | null;
  /** The chunks, in address order; empty when the rows are in the index itself. */
  chunks: ChunkInfo[];
}

/** An account row with its balance after T: the unit an epoch file lists. */
export interface Row extends AccountRow {
  /** The balance after T (0 when none). */
  b: bigint;
}

/** The index of an epoch file (the bytes whose sha256 is the on-chain
 *  contentHash): the header, the root, and the rows themselves when there
 *  are at most CHUNK_ACCOUNTS of them (`chunks` empty), none otherwise. */
export interface EpochIndex extends EpochHeader {
  merkle: { root: string; leafEncoding: string };
  rows: Row[];
}

/**
 * The epoch file curb.sharing.epoch/1 as values (bigints for integers), its
 * rows complete: from the index alone when they are in it, or the index and
 * every chunk (readEpochFile, assembleEpochFile). `parts` is set only when
 * the rows are those of some chunks (the site's view of one account,
 * epochPart; a partial check): its rows, leaves and balances are then those
 * chunks' alone.
 */
export interface EpochFile extends EpochHeader {
  /** Every listed account, in address order. */
  accounts: AccountRow[];
  /** The non-zero balance after T of every listed account only. */
  balancesAtEnd: Record<Address, bigint>;
  /** The leaves are the accounts' cumulative values, bound to the distributor. */
  merkle: { root: string; leafEncoding: string; leaves: Leaf[] };
  /** Set when the rows here are only those of these chunks (their positions). */
  parts?: number[];
}

/** The figures a vector records for an attempt (all strings, as in the JSON). */
export type Expected = Record<string, unknown> & { result: 'epoch' | 'none' };

export interface NoEpoch {
  result: 'none';
  reason: 'no-weight' | 'no-income' | 'nothing-allocated';
  expected: Expected;
}

export interface EpochResult {
  result: 'epoch';
  expected: Expected;
  file: EpochFile;
  /** The index: the bytes whose sha256 goes on chain. */
  fileBytes: Uint8Array;
  contentHash: string;
  /** The chunk files to publish beside the index (none when the rows are in it). */
  chunks: { info: ChunkInfo; bytes: Uint8Array }[];
  /** The on-chain Root fields this epoch publishes (payableAt is set by the chain). */
  root: {
    merkleRoot: string;
    contentHash: string;
    cumHolders0: bigint;
    cumHolders1: bigint;
    cumKeeper0: bigint;
    fromBlock: bigint;
    toBlock: bigint;
    epoch: bigint;
  };
  next: ActiveState;
}

export type AttemptResult = NoEpoch | EpochResult;
