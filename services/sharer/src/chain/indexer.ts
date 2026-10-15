// The indexer (core v2 design D.2.2): which launches share, what each one is
// made of, the launch token's Transfer history, the block times, the pool
// answers, the keeper's transactions, the price and the distributor's state.
// Every read names its block; nothing reads `latest`.

import { decodeEventLog, decodeFunctionData, encodeFunctionData, decodeFunctionResult, toFunctionSelector } from 'viem';
import type { Address, KeeperTx, PoolAnswers, PriceInput, TransferLog } from '../calc/types.ts';
import { curveAbi, distributorAbi, erc20Abi, factoryAbi, feedAbi, graduatorAbi, poolAbi, TOPICS, EVENTS } from './abis.ts';
import type { ChainReader } from './reader.ts';

const ZERO = '0x0000000000000000000000000000000000000000';
const lc = (a: string): Address => a.toLowerCase();
const isAddr = (x: unknown): x is string => typeof x === 'string' && /^0x[0-9a-fA-F]{40}$/.test(x);

export class IndexerError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'IndexerError';
  }
}

// ------------------------------------------------------------- discovery

export interface SharingSwitch {
  token: Address;
  distributor: Address;
  factory: Address;
  by: Address;
  graduated: boolean;
  sinceBlock: bigint;
  block: bigint;
  txHash: string;
}

/** Every HolderSharingEnabled the Graduator emitted in [fromBlock, toBlock].
 *  The switch is write-once, so a token or a distributor seen twice means the
 *  logs are not the Graduator's - refused. */
export async function discoverSharing(r: ChainReader, graduator: Address, fromBlock: bigint, toBlock: bigint): Promise<SharingSwitch[]> {
  const logs = await r.logs({ address: graduator, topics: [TOPICS.HolderSharingEnabled] }, fromBlock, toBlock);
  const out: SharingSwitch[] = [];
  const tokens = new Set<string>();
  const ds = new Set<string>();
  for (const l of logs) {
    const ev = decodeEventLog({ abi: [EVENTS.HolderSharingEnabled], topics: l.topics as any, data: l.data as `0x${string}`, strict: true });
    const a = ev.args as any;
    const s: SharingSwitch = {
      token: lc(a.token),
      distributor: lc(a.distributor),
      factory: lc(a.factory),
      by: lc(a.by),
      graduated: a.graduated,
      sinceBlock: BigInt(a.sinceBlock),
      block: BigInt(l.blockNumber),
      txHash: l.transactionHash.toLowerCase(),
    };
    if (s.sinceBlock !== s.block) throw new IndexerError(`HolderSharingEnabled for ${s.token} says block ${s.sinceBlock} but is in block ${s.block}`);
    if (tokens.has(s.token)) throw new IndexerError(`sharing was switched on twice for ${s.token}`);
    if (ds.has(s.distributor)) throw new IndexerError(`distributor ${s.distributor} was bound twice`);
    tokens.add(s.token);
    ds.add(s.distributor);
    out.push(s);
  }
  return out;
}

// ------------------------------------------------------------- metadata

export interface LaunchRecord {
  curve: Address;
  quoteToken: Address;
  beneficiary: Address;
  refundTo: Address;
  hooks: Address;
  platformRecipient: Address;
  /** The registry's clock at register(); null for a registry without it. */
  launchedAt: bigint | null;
}

const LAUNCH_OF = toFunctionSelector('launchOf(address)');

/** registry.launchOf(token), decoded by word so that the record may grow at
 *  its end (the registry's header rule) - a 12th word is launchedAt. */
export async function readLaunchRecord(r: ChainReader, registry: Address, token: Address, block: bigint): Promise<LaunchRecord> {
  const data = LAUNCH_OF + token.slice(2).toLowerCase().padStart(64, '0');
  const raw = await r.rawCall(registry, data, block);
  const words = (raw.length - 2) / 64;
  if (words < 11) throw new IndexerError(`launchOf(${token}) answered ${words} words, expected at least 11`);
  const w = (i: number): bigint => BigInt('0x' + raw.slice(2 + 64 * i, 2 + 64 * (i + 1)));
  const a = (i: number): Address => {
    const v = w(i);
    if (v >> 160n) throw new IndexerError(`launchOf word ${i} is not an address`);
    return '0x' + v.toString(16).padStart(40, '0');
  };
  let launchedAt: bigint | null = null;
  if (words >= 12) {
    launchedAt = w(11);
    if (launchedAt >> 64n) throw new IndexerError('launchOf word 11 is not a uint64');
  }
  return { curve: a(0), quoteToken: a(1), beneficiary: a(2), refundTo: a(3), hooks: a(7), platformRecipient: a(10), launchedAt };
}

export interface LaunchMeta {
  token: Address;
  distributor: Address;
  /** The distributor's factory (its `factory()`). */
  factory: Address;
  graduator: Address;
  registry: Address;
  curve: Address;
  quoteToken: Address;
  hook: Address;
  escrow: Address;
  /** The launch's PositionLock, or null before graduation. */
  lock: Address | null;
  poolManager: Address;
  positionManager: Address;
  sharingSince: bigint;
  launchedAt: bigint | null;
  beneficiary: Address;
}

/** What a distributor is bound to, read at `block` and cross-checked: the
 *  Graduator's switch must point at this distributor and the distributor's
 *  identity must agree with the registry's record. */
export async function readLaunchMeta(r: ChainReader, graduator: Address, distributor: Address, block: bigint): Promise<LaunchMeta> {
  const D = lc(distributor);
  const G = lc(graduator);
  const token = lc(await r.read<string>(distributorAbi, D, 'launchToken', [], block));
  const quote = lc(await r.read<string>(distributorAbi, D, 'quoteToken', [], block));
  const dGrad = lc(await r.read<string>(distributorAbi, D, 'graduator', [], block));
  const factory = lc(await r.read<string>(distributorAbi, D, 'factory', [], block));
  if (dGrad !== G) throw new IndexerError(`distributor ${D} names graduator ${dGrad}, not ${G}`);
  const bound = lc(await r.read<string>(graduatorAbi, G, 'holderDistributorOf', [token], block));
  if (bound !== D) throw new IndexerError(`the Graduator's switch for ${token} points at ${bound}, not ${D}`);
  const since = BigInt(await r.read<bigint>(graduatorAbi, G, 'sharingSince', [token], block));
  if (since === 0n) throw new IndexerError(`sharingSince(${token}) is 0`);
  const registry = lc(await r.read<string>(graduatorAbi, G, 'registry', [], block));
  const rec = await readLaunchRecord(r, registry, token, block);
  if (rec.curve === ZERO) throw new IndexerError(`${token} is not registered`);
  if (rec.quoteToken !== quote) throw new IndexerError(`distributor quote ${quote} is not the launch's ${rec.quoteToken}`);
  const escrow = lc(await r.read<string>(curveAbi, rec.curve, 'feeEscrow', [], block));
  const lock = lc(await r.read<string>(graduatorAbi, G, 'lockOf', [token], block));
  const poolManager = lc(await r.read<string>(graduatorAbi, G, 'poolManager', [], block));
  const positionManager = lc(await r.read<string>(graduatorAbi, G, 'positionManager', [], block));
  return {
    token,
    distributor: D,
    factory,
    graduator: G,
    registry,
    curve: rec.curve,
    quoteToken: quote,
    hook: rec.hooks,
    escrow,
    lock: lock === ZERO ? null : lock,
    poolManager,
    positionManager,
    sharingSince: since,
    launchedAt: rec.launchedAt,
    beneficiary: rec.beneficiary,
  };
}

/** The exclusions a launch's own contracts get, with fixed reasons (spec 1.3
 *  step 2 - the on-chain isExcluded set), in this order. */
export function launchExclusions(m: LaunchMeta, otherDistributors: Address[]): { address: Address; reason: string }[] {
  const out = [
    { address: m.curve, reason: 'the launch curve' },
    { address: m.hook, reason: 'the launch hook' },
    { address: m.escrow, reason: 'the launcher FeeEscrow' },
    { address: m.graduator, reason: 'the Graduator' },
    { address: m.poolManager, reason: 'the v4 PoolManager' },
    { address: m.positionManager, reason: 'the v4 PositionManager' },
    { address: m.registry, reason: 'the LaunchRegistry' },
  ];
  if (m.lock) out.push({ address: m.lock, reason: 'the launch PositionLock' });
  for (const d of [...new Set(otherDistributors.map(lc))].sort()) if (d !== m.distributor) out.push({ address: d, reason: 'a holder distributor' });
  return out.filter((x) => x.address !== ZERO);
}

// ------------------------------------------------------------- the launch block

/** The block the launch was registered in: the first block whose timestamp
 *  is at or after `launchedAt` (the registry stamps block.timestamp), found by
 *  bisection in [lo, hi] and confirmed by the registry's LaunchRegistered log
 *  for this token in that block. */
export async function findLaunchBlock(r: ChainReader, registry: Address, token: Address, launchedAt: bigint, lo: bigint, hi: bigint): Promise<bigint> {
  if ((await r.block(hi)).timestamp < launchedAt) throw new IndexerError(`no block up to ${hi} is as late as launchedAt ${launchedAt}`);
  let a = lo;
  let b = hi;
  while (a < b) {
    const mid = (a + b) / 2n;
    if ((await r.block(mid)).timestamp >= launchedAt) b = mid;
    else a = mid + 1n;
  }
  const topic = '0x' + token.slice(2).toLowerCase().padStart(64, '0');
  const logs = await r.logs({ address: registry, topics: [TOPICS.LaunchRegistered, topic] }, a, a);
  if (logs.length !== 1) throw new IndexerError(`block ${a} (launchedAt ${launchedAt}) has ${logs.length} LaunchRegistered logs for ${token}`);
  return a;
}

// ------------------------------------------------------------- transfers

/** Every Transfer of the launch token in [fromBlock, toBlock], in (block,
 *  logIndex) order. A log that is not a standard ERC-20 Transfer is refused. */
export async function replayTransfers(r: ChainReader, token: Address, fromBlock: bigint, toBlock: bigint): Promise<TransferLog[]> {
  if (toBlock < fromBlock) return [];
  const logs = await r.logs({ address: token, topics: [TOPICS.Transfer] }, fromBlock, toBlock);
  r.noteLogTimestamps(logs);
  return logs.map((l) => {
    if (l.topics.length !== 3 || !/^0x[0-9a-fA-F]{64}$/.test(l.data)) throw new IndexerError(`a Transfer log of ${token} at block ${BigInt(l.blockNumber)} is not ERC-20 shaped`);
    const ev = decodeEventLog({ abi: [EVENTS.Transfer], topics: l.topics as any, data: l.data as `0x${string}`, strict: true });
    const a = ev.args as any;
    return { block: BigInt(l.blockNumber), logIndex: BigInt(l.logIndex), from: lc(a.from), to: lc(a.to), value: BigInt(a.value) };
  });
}

// ------------------------------------------------------------- probes

export interface ProbeResult {
  /** token0/token1/factory answers, for the addresses where token0() or
   *  token1() answered; a call that did not answer is null. */
  contracts: Map<Address, PoolAnswers>;
  /** Addresses the distributor's own isExcluded says are excluded. */
  excludedOnChain: Address[];
}

const SEL = {
  token0: encodeFunctionData({ abi: poolAbi, functionName: 'token0' }),
  token1: encodeFunctionData({ abi: poolAbi, functionName: 'token1' }),
  factory: encodeFunctionData({ abi: poolAbi, functionName: 'factory' }),
};

/** An address answer: at least one word, the first an address. */
function answerAddress(ok: boolean, data: string): Address | null {
  if (!ok || data.length < 66) return null;
  const v = BigInt('0x' + data.slice(2, 66));
  if (v >> 160n) return null;
  return '0x' + v.toString(16).padStart(40, '0');
}

/** Asks every address (spec 1.3 step 4) for token0(), token1() and factory()
 *  at `block`, and asks the distributor whether it excludes it. An address
 *  is a pool when token0() or token1() names the launch token, whatever its
 *  factory, so the answers are kept whenever one of the two answered. */
export async function probeAccounts(r: ChainReader, distributor: Address, accounts: Address[], block: bigint): Promise<ProbeResult> {
  const calls: { to: string; data: string }[] = [];
  for (const a of accounts) {
    calls.push({ to: a, data: SEL.token0 }, { to: a, data: SEL.token1 }, { to: a, data: SEL.factory });
    calls.push({ to: distributor, data: encodeFunctionData({ abi: distributorAbi, functionName: 'isExcluded', args: [a as `0x${string}`] }) });
  }
  const res = await r.callMany(calls, block);
  const contracts = new Map<Address, PoolAnswers>();
  const excludedOnChain: Address[] = [];
  accounts.forEach((a, i) => {
    const [t0, t1, f, x] = res.slice(4 * i, 4 * i + 4);
    const token0 = answerAddress(t0.success, t0.returnData);
    const token1 = answerAddress(t1.success, t1.returnData);
    const factory = answerAddress(f.success, f.returnData);
    if (token0 || token1) contracts.set(a, { token0, token1, factory });
    if (!x.success) throw new IndexerError(`isExcluded(${a}) reverted on ${distributor}`);
    const ex = decodeFunctionResult({ abi: distributorAbi, functionName: 'isExcluded', data: x.returnData as `0x${string}` });
    if (ex) excludedOnChain.push(a);
  });
  return { contracts, excludedOnChain };
}

// ------------------------------------------------------------- keeper

/** The transactions the keeper fee may count for distributor D in [F, T]:
 *  every transaction that emitted a log from D in the window, plus any hashes
 *  the caller names (the keeper's own journal, which also holds transactions
 *  that reverted and so emitted nothing). The calculator keeps only those
 *  sent by a keeper key to D, or to the factory naming D (spec 1.5).
 *
 *  A named hash that is not in a block in [F, T] is left out, and its
 *  receipt is never asked for: it cannot be in the window, and keeping it
 *  would make two honest providers disagree. The journal holds such hashes:
 *  a publish replaced at the same nonce never lands; one mined after T may
 *  be known to one provider and not yet to another; one mined before F may
 *  be known to an archive node and already pruned from another's
 *  transaction index (geth keeps about 54 days of it on Base), and the
 *  journal keeps 500 sends per key, months of them on a quiet deployment.
 *  A hash that logged from D in the window must be there. */
export async function collectKeeperTxs(r: ChainReader, D: Address, factory: Address, F: bigint, T: bigint, extraHashes: string[] = []): Promise<KeeperTx[]> {
  const logs = await r.logs({ address: D }, F, T);
  const logged = new Set<string>(logs.map((l) => l.transactionHash.toLowerCase()));
  const hashes = new Set<string>(logged);
  for (const h of extraHashes) hashes.add(h.toLowerCase());
  const out: KeeperTx[] = [];
  for (const h of [...hashes].sort()) {
    const tx = logged.has(h) ? await r.tx(h) : await r.minedTx(h);
    if (tx === null || tx.blockNumber > T) continue;
    if (tx.blockNumber < F) continue;
    const rc = await r.receipt(h);
    if (rc.blockNumber !== tx.blockNumber) throw new IndexerError(`tx ${h} and its receipt name different blocks`);
    if (tx.to === null) continue;
    let names: Address[] = [];
    if (tx.to === lc(factory)) names = namesOf(tx.input);
    out.push({ hash: h, from: tx.from, to: tx.to, block: tx.blockNumber, gasUsed: rc.gasUsed, effectiveGasPrice: rc.effectiveGasPrice, l1Fee: rc.l1Fee, names });
  }
  return out;
}

/** The distinct distributors a factory call names: publishMany's list or
 *  publish's one; none for any other call. */
export function namesOf(input: string): Address[] {
  try {
    const d = decodeFunctionData({ abi: factoryAbi, data: input as `0x${string}` });
    if (d.functionName === 'publishMany') return [...new Set((d.args[0] as string[]).map(lc))];
    if (d.functionName === 'publish') return [lc(d.args[0] as string)];
  } catch {
    // not a call the keeper fee splits
  }
  return [];
}

// ------------------------------------------------------------- price

export interface FeedPair {
  ethUsd: Address;
  quoteUsd: Address;
}

/** The two Chainlink answers at `block`. A feed whose call reverts, or whose
 *  answer is not positive, is missing (P = 0, spec 1.5). */
export async function readPrice(r: ChainReader, feeds: FeedPair | null, block: bigint): Promise<PriceInput | null> {
  if (!feeds) return null;
  const one = async (feed: Address) => {
    const [rd, dec] = await r.callMany(
      [
        { to: feed, data: encodeFunctionData({ abi: feedAbi, functionName: 'latestRoundData' }) },
        { to: feed, data: encodeFunctionData({ abi: feedAbi, functionName: 'decimals' }) },
      ],
      block,
    );
    if (!rd.success || !dec.success || rd.returnData.length < 2 + 64 * 5 || dec.returnData.length < 66) return null;
    const [roundId, answer] = decodeFunctionResult({ abi: feedAbi, functionName: 'latestRoundData', data: rd.returnData as `0x${string}` }) as readonly bigint[];
    const decimals = decodeFunctionResult({ abi: feedAbi, functionName: 'decimals', data: dec.returnData as `0x${string}` }) as number;
    if (answer <= 0n) return null;
    return { feed: lc(feed), round: roundId.toString(), answer: answer.toString(), decimals: String(decimals) };
  };
  const ethUsd = await one(feeds.ethUsd);
  const quoteUsd = await one(feeds.quoteUsd);
  return { ethUsd, quoteUsd };
}

// ------------------------------------------------------------- distributor

export interface RootView {
  merkleRoot: string;
  contentHash: string;
  cumHolders0: bigint;
  cumHolders1: bigint;
  cumKeeper0: bigint;
  fromBlock: bigint;
  toBlock: bigint;
  epoch: bigint;
  payableAt: bigint;
}

export interface DistributorState {
  received0: bigint;
  received1: bigint;
  active: RootView;
  pending: RootView;
  lastProposedEpoch: bigint;
}

function rootOf(x: readonly unknown[]): RootView {
  const [merkleRoot, contentHash, cumHolders0, cumHolders1, cumKeeper0, fromBlock, toBlock, epoch, payableAt] = x as any[];
  return {
    merkleRoot: String(merkleRoot).toLowerCase(),
    contentHash: String(contentHash).toLowerCase(),
    cumHolders0: BigInt(cumHolders0),
    cumHolders1: BigInt(cumHolders1),
    cumKeeper0: BigInt(cumKeeper0),
    fromBlock: BigInt(fromBlock),
    toBlock: BigInt(toBlock),
    epoch: BigInt(epoch),
    payableAt: BigInt(payableAt),
  };
}

export async function readDistributorState(r: ChainReader, D: Address, block: bigint): Promise<DistributorState> {
  return {
    received0: BigInt(await r.read<bigint>(distributorAbi, D, 'received0', [], block)),
    received1: BigInt(await r.read<bigint>(distributorAbi, D, 'received1', [], block)),
    active: rootOf(await r.read<readonly unknown[]>(distributorAbi, D, 'active', [], block)),
    pending: rootOf(await r.read<readonly unknown[]>(distributorAbi, D, 'pending', [], block)),
    lastProposedEpoch: BigInt(await r.read<number>(distributorAbi, D, 'lastProposedEpoch', [], block)),
  };
}

export async function readDecimals(r: ChainReader, token: Address, block: bigint): Promise<bigint> {
  return BigInt(await r.read<number>(erc20Abi, token, 'decimals', [], block));
}

// ------------------------------------------------------------- history

export interface PublishedRoot {
  epoch: bigint;
  merkleRoot: string;
  fromBlock: bigint;
  toBlock: bigint;
  dH0: bigint;
  dH1: bigint;
  dK: bigint;
  contentHash: string;
  uri: string;
  payableAt: bigint;
  block: bigint;
  txHash: string;
}

/** Every RootPublished and RootVetoed of D in [fromBlock, toBlock]. The URI
 *  of the active epoch's file comes from here. */
export async function readEpochHistory(r: ChainReader, D: Address, fromBlock: bigint, toBlock: bigint): Promise<{ published: PublishedRoot[]; vetoed: { epoch: bigint; reason: string; block: bigint }[] }> {
  const logs = await r.logs({ address: D, topics: [[TOPICS.RootPublished, TOPICS.RootVetoed]] }, fromBlock, toBlock);
  const published: PublishedRoot[] = [];
  const vetoed: { epoch: bigint; reason: string; block: bigint }[] = [];
  for (const l of logs) {
    if (l.topics[0].toLowerCase() === TOPICS.RootPublished) {
      const a = decodeEventLog({ abi: [EVENTS.RootPublished], topics: l.topics as any, data: l.data as `0x${string}`, strict: true }).args as any;
      published.push({
        epoch: BigInt(a.epoch),
        merkleRoot: String(a.merkleRoot).toLowerCase(),
        fromBlock: BigInt(a.fromBlock),
        toBlock: BigInt(a.toBlock),
        dH0: BigInt(a.dH0),
        dH1: BigInt(a.dH1),
        dK: BigInt(a.dK),
        contentHash: String(a.contentHash).toLowerCase(),
        uri: String(a.uri),
        payableAt: BigInt(a.payableAt),
        block: BigInt(l.blockNumber),
        txHash: l.transactionHash.toLowerCase(),
      });
    } else {
      const a = decodeEventLog({ abi: [EVENTS.RootVetoed], topics: l.topics as any, data: l.data as `0x${string}`, strict: true }).args as any;
      vetoed.push({ epoch: BigInt(a.epoch), reason: String(a.reason), block: BigInt(l.blockNumber) });
    }
  }
  return { published, vetoed };
}

export { isAddr };
