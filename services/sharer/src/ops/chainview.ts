// What the keeper reads to decide (design D.2.6 step 1): each distributor's
// roots and totals, the factory's roles, the harvest that can end an epoch,
// what a harvest would bring in now, prices and the L1 fee. Decisions are
// re-derived from the chain on every tick; nothing here is cached across
// ticks except the launch metadata, which never changes.

import { decodeFunctionResult, encodeFunctionData, type Abi } from 'viem';
import type { Address } from '../calc/types.ts';
import { canonicalJson } from '../calc/encoding.ts';
import { priceValue, WAD } from '../calc/share.ts';
import { distributorAbi, TOPICS } from '../chain/abis.ts';
import type { ChainReader } from '../chain/reader.ts';
import type { Rpc } from '../chain/rpc.ts';
import { readLaunchMeta, readPrice, readDecimals, type LaunchMeta, type RootView, type FeedPair } from '../chain/indexer.ts';
import { ProviderDisagreement } from '../epoch.ts';
import { feedAbi } from '../chain/abis.ts';
import { GAS_ORACLE, gasOracleAbi, incomeAbi, opsDistributorAbi, opsFactoryAbi, lensPriceAbi, MULTICALL3, multicall3Abi } from './abis.ts';
import { keccak256, toHex } from 'viem';

export interface DistView {
  d: Address;
  block: bigint;
  active: RootView;
  pending: RootView;
  lastProposedEpoch: bigint;
  received0: bigint;
  received1: bigint;
  totalPaid0: bigint;
  totalPaid1: bigint;
  keeperPaid0: bigint;
}

export interface FactoryView {
  block: bigint;
  owner: Address;
  publisher: Address;
  keeperPayee: Address;
  frozen: boolean;
  pendingPublisher: Address;
  pendingPublisherAt: bigint;
  pendingKeeperPayee: Address;
  pendingKeeperPayeeAt: bigint;
  pendingUnfreezeAt: bigint;
  vetoableUntil: bigint;
}

const lc = (x: unknown): Address => String(x).toLowerCase();

function rootOf(x: readonly unknown[]): RootView {
  const [merkleRoot, contentHash, cumHolders0, cumHolders1, cumKeeper0, fromBlock, toBlock, epoch, payableAt] = x as any[];
  return { merkleRoot: lc(merkleRoot), contentHash: lc(contentHash), cumHolders0: BigInt(cumHolders0), cumHolders1: BigInt(cumHolders1), cumKeeper0: BigInt(cumKeeper0), fromBlock: BigInt(fromBlock), toBlock: BigInt(toBlock), epoch: BigInt(epoch), payableAt: BigInt(payableAt) };
}

export async function readDist(r: ChainReader, d: Address, block: bigint): Promise<DistView> {
  const rd = <T>(abi: Abi, fn: string, args: readonly unknown[] = []) => r.read<T>(abi, d, fn, args, block);
  return {
    d: d.toLowerCase(),
    block,
    active: rootOf(await rd<readonly unknown[]>(distributorAbi, 'active')),
    pending: rootOf(await rd<readonly unknown[]>(distributorAbi, 'pending')),
    lastProposedEpoch: BigInt(await rd<number>(distributorAbi, 'lastProposedEpoch')),
    received0: BigInt(await rd<bigint>(distributorAbi, 'received0')),
    received1: BigInt(await rd<bigint>(distributorAbi, 'received1')),
    totalPaid0: BigInt(await rd<bigint>(opsDistributorAbi, 'totalPaid0')),
    totalPaid1: BigInt(await rd<bigint>(opsDistributorAbi, 'totalPaid1')),
    keeperPaid0: BigInt(await rd<bigint>(opsDistributorAbi, 'keeperPaid0')),
  };
}

/** Only a distributor's active and pending roots (the guardian's work list). */
export async function readRoots(r: ChainReader, d: Address, block: bigint): Promise<{ active: RootView; pending: RootView }> {
  return {
    active: rootOf(await r.read<readonly unknown[]>(distributorAbi, d, 'active', [], block)),
    pending: rootOf(await r.read<readonly unknown[]>(distributorAbi, d, 'pending', [], block)),
  };
}

/** Distributors whose roots one Multicall3 request reads (two calls each). */
export const ROOTS_PER_REQUEST = 100;
/** Single reads in flight at once, where a batch could not answer. */
const SINGLE_READS_AT_ONCE = 8;

const ACTIVE_CALL = encodeFunctionData({ abi: distributorAbi, functionName: 'active' });
const PENDING_CALL = encodeFunctionData({ abi: distributorAbi, functionName: 'pending' });

export interface RootsMany {
  roots: Map<Address, { active: RootView; pending: RootView }>;
  /** Distributors this provider could not answer for, and why. */
  errors: Map<Address, string>;
  /** False when Multicall3 did not answer here and every root was read on its own. */
  batched: boolean;
}

/** EVERY DISTRIBUTOR'S ROOTS IN A FEW REQUESTS. The guardian reads the roots
 *  of every launch with sharing on, on every provider, on every pass, and
 *  launches cost only gas: read one call at a time, a few hundred of them
 *  used up a pass before a single root was checked. Here they go through
 *  Multicall3's aggregate3, ROOTS_PER_REQUEST distributors per request, and
 *  every answer must be a whole root; a distributor whose answer is not
 *  (a failed call, an address with other code) is read on its own, and a
 *  provider where Multicall3 does not answer at all is read one root at a
 *  time, a few at once (`batched` false: the caller says so). The
 *  distributors are the factory's own, so no call can starve the others of
 *  gas (the reason outsider-named calls go through the probe instead). */
export async function readRootsMany(r: ChainReader, ds: Address[], block: bigint, perRequest = ROOTS_PER_REQUEST): Promise<RootsMany> {
  const out: RootsMany = { roots: new Map(), errors: new Map(), batched: true };
  const alone: Address[] = [];
  for (let i = 0; i < ds.length; i += perRequest) {
    const part = ds.slice(i, i + perRequest);
    if (!out.batched) {
      alone.push(...part);
      continue;
    }
    let res: readonly { success: boolean; returnData: string }[];
    try {
      res = await r.read<readonly { success: boolean; returnData: string }[]>(multicall3Abi, MULTICALL3, 'aggregate3', [part.flatMap((d) => [{ target: d, allowFailure: true, callData: ACTIVE_CALL }, { target: d, allowFailure: true, callData: PENDING_CALL }])], block);
      if (res.length !== part.length * 2) throw new Error(`Multicall3 answered ${res.length} results for ${part.length * 2} calls`);
    } catch {
      out.batched = false;
      alone.push(...part);
      continue;
    }
    part.forEach((d, j) => {
      try {
        const [a, p] = [res[2 * j], res[2 * j + 1]];
        if (!a.success || !p.success) throw new Error('a call failed');
        out.roots.set(d, {
          active: rootOf(decodeFunctionResult({ abi: distributorAbi, functionName: 'active', data: a.returnData as `0x${string}` }) as readonly unknown[]),
          pending: rootOf(decodeFunctionResult({ abi: distributorAbi, functionName: 'pending', data: p.returnData as `0x${string}` }) as readonly unknown[]),
        });
      } catch {
        alone.push(d);
      }
    });
  }
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < alone.length) {
      const d = alone[next++];
      try {
        out.roots.set(d, await readRoots(r, d, block));
      } catch (e) {
        out.errors.set(d, (e as Error)?.message ?? String(e));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SINGLE_READS_AT_ONCE, alone.length) }, worker));
  return out;
}

/** `r`, stopped by `signal`: once it aborts, a request in flight is
 *  abandoned and every later one throws at once, so a check abandoned at its
 *  deadline (the guardian's recompute, its event lookups) ends at its next
 *  read instead of running on in the background. Caches stay shared. */
export function stoppable(r: ChainReader, signal: AbortSignal): ChainReader {
  const inner = r.rpc;
  const rpc: Rpc = {
    label: inner.label,
    request: (a) => {
      if (signal.aborted) return Promise.reject(signal.reason ?? new Error('stopped'));
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason ?? new Error('stopped'));
        signal.addEventListener('abort', onAbort, { once: true });
        inner.request(a).then(
          (v) => {
            signal.removeEventListener('abort', onAbort);
            resolve(v);
          },
          (e) => {
            signal.removeEventListener('abort', onAbort);
            reject(e);
          },
        );
      });
    },
  };
  const w = Object.create(r) as ChainReader;
  Object.defineProperty(w, 'rpc', { value: rpc });
  return w;
}

export async function readFactory(r: ChainReader, f: Address, block: bigint): Promise<FactoryView> {
  const rd = async <T>(fn: string): Promise<T> => r.read<T>(opsFactoryAbi, f, fn, [], block);
  return {
    block,
    owner: lc(await rd<string>('owner')),
    publisher: lc(await rd<string>('publisher')),
    keeperPayee: lc(await rd<string>('keeperPayee')),
    frozen: await rd<boolean>('frozen'),
    pendingPublisher: lc(await rd<string>('pendingPublisher')),
    pendingPublisherAt: BigInt(await rd<bigint>('pendingPublisherAt')),
    pendingKeeperPayee: lc(await rd<string>('pendingKeeperPayee')),
    pendingKeeperPayeeAt: BigInt(await rd<bigint>('pendingKeeperPayeeAt')),
    pendingUnfreezeAt: BigInt(await rd<bigint>('pendingUnfreezeAt')),
    vetoableUntil: BigInt(await rd<bigint>('vetoableUntil')),
  };
}

export async function isVetoer(r: ChainReader, f: Address, who: Address, block: bigint): Promise<boolean> {
  return r.read<boolean>(opsFactoryAbi, f, 'isVetoer', [who], block);
}

/** The views of every distributor and the factory, at one block, on every
 *  provider - and an abort (no writes) if any two disagree. Returns the
 *  first provider's answer. */
export async function crossChecked(readers: ChainReader[], factory: Address, ds: Address[], block: bigint): Promise<{ factory: FactoryView; dists: DistView[] }> {
  const all: { factory: FactoryView; dists: DistView[]; label: string }[] = [];
  for (const r of readers) {
    const fv = await readFactory(r, factory, block);
    const dv: DistView[] = [];
    for (const d of ds) dv.push(await readDist(r, d, block));
    all.push({ factory: fv, dists: dv, label: r.label });
  }
  const fp = (x: { factory: FactoryView; dists: DistView[] }) => canonicalJson({ f: { ...x.factory }, d: x.dists.map((v) => ({ ...v, active: { ...v.active }, pending: { ...v.pending } })) });
  const base = fp(all[0]);
  for (const o of all.slice(1)) {
    if (fp(o) !== base) {
      const parts: string[] = [];
      if (canonicalJson({ ...o.factory }) !== canonicalJson({ ...all[0].factory })) parts.push('factory roles');
      o.dists.forEach((v, i) => {
        if (canonicalJson({ ...v, active: { ...v.active }, pending: { ...v.pending } }) !== canonicalJson({ ...all[0].dists[i], active: { ...all[0].dists[i].active }, pending: { ...all[0].dists[i].pending } })) parts.push(`distributor ${v.d}`);
      });
      throw new ProviderDisagreement(parts, [all[0].label, o.label]);
    }
  }
  return { factory: all[0].factory, dists: all[0].dists };
}

/** The highest block every provider has: latest on each, the lowest wins. */
export async function commonHead(readers: ChainReader[], tag: 'latest' | 'safe'): Promise<{ number: bigint; timestamp: bigint }> {
  let best: { number: bigint; timestamp: bigint } | null = null;
  for (const r of readers) {
    const h = await r.head(tag);
    if (!best || h.number < best.number) best = { number: h.number, timestamp: h.timestamp };
  }
  return best!;
}

// ------------------------------------------------------------- the harvest

export interface HarvestSeen {
  hash: string;
  block: bigint;
  from: Address;
}

const HARVESTED = keccak256(toHex('Harvested(uint256,uint256)'));

/** The latest harvest() of D in [from, to] sent straight to D (the only kind
 *  an epoch can end at) and not reverted. */
export async function latestHarvest(r: ChainReader, d: Address, from: bigint, to: bigint): Promise<HarvestSeen | null> {
  if (to < from) return null;
  const logs = await r.logs({ address: d, topics: [HARVESTED] }, from, to);
  for (let i = logs.length - 1; i >= 0; i--) {
    const h = logs[i].transactionHash.toLowerCase();
    const rc = await r.receipt(h);
    if (rc.status && rc.to === d.toLowerCase()) return { hash: h, block: rc.blockNumber, from: rc.from };
  }
  return null;
}

/** What D would hold right after a harvest(), now: a deployless eth_call
 *  whose constructor calls D.harvest() and then reads received0() and
 *  received1() in the same simulated transaction. Nothing is sent.
 *
 *  Hand-assembled (92 bytes), followed by D as one 32-byte word:
 *    CODECOPY the last word (D) to mem[0]; MLOAD it
 *    mem[0x80] = harvest() selector; CALL(gas, D, 0, 0x80, 4, 0, 0); mem[0x00] = ok
 *    mem[0x80] = received0(); STATICCALL(gas, D, 0x80, 4, 0x20, 0x20) or revert
 *    mem[0x80] = received1(); STATICCALL(gas, D, 0x80, 4, 0x40, 0x20) or revert
 *    RETURN mem[0x00..0x60] = (ok, received0, received1)                        */
export const PREVIEW_CODE =
  '0x' +
  '6020803803' + '5f39' + '5f51' +
  '634641257d' + '60e01b' + '608052' +
  '5f5f' + '6004' + '6080' + '5f' + '85' + '5a' + 'f1' + '5f52' +
  '63762cf465' + '60e01b' + '608052' +
  '6020' + '6020' + '6004' + '6080' + '84' + '5a' + 'fa' + '15' + '6058' + '57' +
  '638f67ecda' + '60e01b' + '608052' +
  '6020' + '6040' + '6004' + '6080' + '84' + '5a' + 'fa' + '15' + '6058' + '57' +
  '6060' + '5f' + 'f3' +
  '5b' + '5f5f' + 'fd';

export async function previewHarvest(r: ChainReader, d: Address, block: bigint | 'latest'): Promise<{ ok: boolean; received0: bigint; received1: bigint }> {
  const data = PREVIEW_CODE + d.slice(2).toLowerCase().padStart(64, '0');
  const tag = block === 'latest' ? 'latest' : '0x' + block.toString(16);
  const raw = String(await r.request('eth_call', [{ from: '0x0000000000000000000000000000000000000000', data, gas: '0x' + (8_000_000).toString(16) }, tag]));
  if (!/^0x[0-9a-fA-F]{192}$/.test(raw)) throw new Error(`the harvest preview answered ${raw.length} hex chars, expected 3 words`);
  const w = (i: number) => BigInt('0x' + raw.slice(2 + 64 * i, 66 + 64 * i));
  return { ok: w(0) === 1n, received0: w(1), received1: w(2) };
}

// ------------------------------------------------------------- money

/** The OP-stack L1 data fee upper bound of a transaction of `size` bytes;
 *  0 where the chain has no such oracle. */
export async function l1FeeOf(r: ChainReader, size: number): Promise<bigint> {
  try {
    return BigInt(await r.read<bigint>(gasOracleAbi, GAS_ORACLE, 'getL1FeeUpperBound', [BigInt(size)], (await r.head('latest')).number));
  } catch {
    return 0n;
  }
}

export async function gasPrice(r: ChainReader): Promise<bigint> {
  const head = await r.request('eth_getBlockByNumber', ['latest', false]);
  const base = head && head.baseFeePerGas ? BigInt(head.baseFeePerGas) : 0n;
  let prio = 1_000_000n;
  try {
    prio = BigInt(await r.request('eth_maxPriorityFeePerGas', []));
  } catch {
    // default tip
  }
  return base + prio;
}

export interface Money {
  /** Asset-0 base units per 10^18 wei (spec 1.5); 0 when unknown. */
  P: bigint;
  /** Asset-0 base units per US dollar; 0 when unknown. */
  perUsd: bigint;
  source: 'weth' | 'chainlink' | 'none';
}

async function feedAnswer(r: ChainReader, feed: Address, block: bigint): Promise<{ answer: bigint; decimals: bigint } | null> {
  try {
    const [rd, dec] = await r.callMany(
      [
        { to: feed, data: encodeFunctionData({ abi: feedAbi, functionName: 'latestRoundData' }) },
        { to: feed, data: encodeFunctionData({ abi: feedAbi, functionName: 'decimals' }) },
      ],
      block,
    );
    if (!rd.success || !dec.success) return null;
    const [, answer] = decodeFunctionResult({ abi: feedAbi, functionName: 'latestRoundData', data: rd.returnData as `0x${string}` }) as readonly bigint[];
    const decimals = decodeFunctionResult({ abi: feedAbi, functionName: 'decimals', data: dec.returnData as `0x${string}` }) as number;
    if (answer <= 0n) return null;
    return { answer, decimals: BigInt(decimals) };
  } catch {
    return null;
  }
}

/** The keeper's price of asset 0 (the spec's P, the same reads the epoch
 *  makes) and how many asset-0 units make a dollar. */
export async function moneyOf(r: ChainReader, o: { quote: Address; quoteIsWeth: boolean; feeds: FeedPair | null; ethUsd: Address | null }, block: bigint): Promise<Money> {
  if (o.quoteIsWeth) {
    const e = o.ethUsd ? await feedAnswer(r, o.ethUsd, block) : null;
    return { P: WAD, perUsd: e ? (WAD * 10n ** e.decimals) / e.answer : 0n, source: 'weth' };
  }
  const dec = await readDecimals(r, o.quote, block);
  const pr = await readPrice(r, o.feeds, block);
  const rec = priceValue(pr, false, dec);
  const q = pr?.quoteUsd;
  const perUsd = q ? (10n ** dec * 10n ** BigInt(q.decimals)) / BigInt(q.answer) : 0n;
  return { P: rec.value, perUsd, source: rec.source };
}

/** The launch token's price in asset-0 units per 10^18 token units, from the
 *  curve's reserves before graduation; null when it cannot be read (after
 *  graduation the token side is valued at zero for push thresholds: it rides
 *  with the quote side, which the same weights split). */
export async function tokenPriceOf(r: ChainReader, meta: LaunchMeta, block: bigint): Promise<bigint | null> {
  if (meta.lock) return null;
  try {
    const [q, t] = (await r.read<readonly bigint[]>(lensPriceAbi, meta.curve, 'getReserves', [], block)) as readonly bigint[];
    if (t === 0n) return null;
    return (q * WAD) / t;
  } catch {
    return null;
  }
}

/** Income the last harvest could not collect: still credited in the escrow,
 *  owed by the hook, or held by the lock for D. Non-zero after a harvest
 *  means a leg refused (an issuer blocking the distributor, say). */
export async function stuckIncome(r: ChainReader, meta: LaunchMeta, block: bigint): Promise<{ escrow: bigint; hook: bigint; lock0: bigint; lock1: bigint }> {
  const d = meta.distributor;
  const one = async (fn: () => Promise<bigint>): Promise<bigint> => {
    try {
      return BigInt(await fn());
    } catch {
      return 0n;
    }
  };
  return {
    escrow: await one(() => r.read<bigint>(incomeAbi, meta.escrow, 'balanceOfToken', [d, meta.quoteToken], block)),
    hook: await one(() => r.read<bigint>(incomeAbi, meta.hook, 'owed', [d, meta.quoteToken], block)),
    lock0: meta.lock ? await one(() => r.read<bigint>(incomeAbi, meta.lock!, 'held', [d, 0n], block)) : 0n,
    lock1: meta.lock ? await one(() => r.read<bigint>(incomeAbi, meta.lock!, 'held', [d, 1n], block)) : 0n,
  };
}

/** Launch metadata, read once per distributor (it never changes, except the
 *  lock appearing at graduation, which is re-read while it is null). */
export class MetaCache {
  private readonly m = new Map<string, LaunchMeta>();
  async get(r: ChainReader, graduator: Address, d: Address, block: bigint): Promise<LaunchMeta> {
    const hit = this.m.get(d);
    if (hit && hit.lock) return hit;
    const meta = await readLaunchMeta(r, graduator, d, block);
    this.m.set(d, meta);
    return meta;
  }
}

export { TOPICS };
