// Which leaves of the active root to push, and in which batches (design
// D.2.6 step 3). Pure: everything it needs is passed in, so every rule here
// is tested on its own.
//
//   push when the unpaid value  >= T_push = max($0.05, 25 x the marginal
//                                  cost of one more leaf, L1 fee included)
//   dust: an account that has held nothing for 30 days is pushed once its
//         unpaid value is >= 2 x that marginal cost (so it does not wait for
//         ever on a share that will never grow)
//   an account whose last push was refused (PushSkipped) is claim-only: it is
//         tried again after 30 days, or once its unpaid value is 10x what it
//         was at the refusal
//   batches of at most 200 leaves and at most 8M estimated gas, each with its
//         own multiproof (multiProofFor orders the leaves for it), and each
//         of the accounts of ONE chunk of the tree: past CHUNK_ACCOUNTS
//         leaves the tree is cut in chunks (merkle.ts), and a multiproof
//         proves the leaves of one
//   nothing at all above the push gas-price cap
//
// Value: asset 0 counts as itself; asset 1 (the launch token) at the curve's
// price before graduation, and at zero otherwise - it is split by the same
// weights as asset 0, so it rides along with the quote side.

import type { Address } from '../calc/types.ts';
import { WAD } from '../calc/share.ts';
import { multiProofFor, type PushBatch, type ShareTree } from '../calc/merkle.ts';

export interface LeafState {
  account: Address;
  cum0: bigint;
  cum1: bigint;
  paid0: bigint;
  paid1: bigint;
  excluded: boolean;
  /** Holds no token at the end of the active epoch. */
  emptyNow: boolean;
  /** Chain time (s) the account last held a balance; null if unknown. */
  lastHeldAt: number | null;
  /** The account's last PushSkipped: when, and its unpaid value then. */
  skipped: { at: number; unpaidValue0: bigint } | null;
}

export interface PushEconomics {
  /** Asset-0 units per 10^18 wei; 0 when unknown. */
  P: bigint;
  /** Asset-0 units per dollar; 0 when unknown. */
  perUsd: bigint;
  /** Asset-0 units per 10^18 launch-token units, or null. */
  tokenPrice: bigint | null;
  /** base fee + tip, wei per gas. */
  gasPrice: bigint;
  /** The L1 data fee one more leaf adds, wei. */
  l1PerLeaf: bigint;
}

export interface PushRules {
  pushUsdFloorMicros: bigint;
  pushCostFactor: bigint;
  dustCostFactor: bigint;
  dustZeroSec: number;
  skipRetrySec: number;
  skipGrowth: bigint;
  maxLeavesPerPush: number;
  maxPushGas: bigint;
  pushMaxGasPriceWei: bigint;
  gas: { pushBase: bigint; pushFirstLeaf: bigint; pushRepeatLeaf: bigint };
}

export type Why = 'threshold' | 'dust' | 'retry';

export interface PushPlan {
  batches: (PushBatch & { estGas: bigint; why: Record<string, Why> })[];
  /** Why the others wait. */
  waiting: Record<'excluded' | 'paid' | 'below-threshold' | 'claim-only' | 'no-price' | 'gas-price', number>;
  thresholdPerLeaf0: bigint;
}

export function unpaidValue0(l: LeafState, e: Pick<PushEconomics, 'tokenPrice'>): bigint {
  const o0 = l.cum0 > l.paid0 ? l.cum0 - l.paid0 : 0n;
  const o1 = l.cum1 > l.paid1 ? l.cum1 - l.paid1 : 0n;
  return o0 + (e.tokenPrice ? (o1 * e.tokenPrice) / WAD : 0n);
}

export function leafGas(l: LeafState, r: PushRules): bigint {
  return l.paid0 === 0n && l.paid1 === 0n ? r.gas.pushFirstLeaf : r.gas.pushRepeatLeaf;
}

/** One more leaf's cost in asset-0 units. */
export function leafCost0(l: LeafState, e: PushEconomics, r: PushRules): bigint {
  return ((leafGas(l, r) * e.gasPrice + e.l1PerLeaf) * e.P) / WAD;
}

export function planPushes(tree: ShareTree, leaves: LeafState[], e: PushEconomics, r: PushRules, nowSec: number): PushPlan {
  const waiting: PushPlan['waiting'] = { excluded: 0, paid: 0, 'below-threshold': 0, 'claim-only': 0, 'no-price': 0, 'gas-price': 0 };
  const floor0 = (r.pushUsdFloorMicros * e.perUsd) / 1_000_000n;
  const picked: { l: LeafState; value: bigint; why: Why }[] = [];
  for (const l of leaves) {
    const owed = l.cum0 > l.paid0 || l.cum1 > l.paid1;
    if (!owed) {
      waiting.paid++;
      continue;
    }
    if (l.excluded) {
      waiting.excluded++;
      continue;
    }
    if (e.P === 0n) {
      // the cost of a push cannot be put in asset-0 terms: wait for a price
      waiting['no-price']++;
      continue;
    }
    if (e.gasPrice > r.pushMaxGasPriceWei) {
      waiting['gas-price']++;
      continue;
    }
    const value = unpaidValue0(l, e);
    const cost = leafCost0(l, e, r);
    const threshold = floor0 > r.pushCostFactor * cost ? floor0 : r.pushCostFactor * cost;
    if (l.skipped) {
      const ripe = nowSec - l.skipped.at >= r.skipRetrySec || value >= r.skipGrowth * (l.skipped.unpaidValue0 > 0n ? l.skipped.unpaidValue0 : 1n);
      if (!ripe) {
        waiting['claim-only']++;
        continue;
      }
      if (value >= cost) {
        picked.push({ l, value, why: 'retry' });
        continue;
      }
    }
    if (value >= threshold) {
      picked.push({ l, value, why: 'threshold' });
      continue;
    }
    const dusty = l.emptyNow && l.lastHeldAt !== null && nowSec - l.lastHeldAt >= r.dustZeroSec;
    if (dusty && value >= r.dustCostFactor * cost) {
      picked.push({ l, value, why: 'dust' });
      continue;
    }
    waiting['below-threshold']++;
  }
  // chunk by chunk - one push proves the leaves of one chunk of the tree -
  // and within a chunk largest first, so a capped run pays the most per gas
  const chunk = new Map(picked.map((x) => [x.l.account, tree.chunkOf(x.l.account)]));
  picked.sort((a, b) => chunk.get(a.l.account)! - chunk.get(b.l.account)! || (a.value === b.value ? (a.l.account < b.l.account ? -1 : 1) : a.value > b.value ? -1 : 1));
  const batches: PushPlan['batches'] = [];
  let cur: typeof picked = [];
  let curChunk = -1;
  let gas = r.gas.pushBase;
  const flush = () => {
    if (!cur.length) return;
    const mp = multiProofFor(tree, cur.map((x) => x.l.account));
    const why: Record<string, Why> = {};
    for (const x of cur) why[x.l.account] = x.why;
    batches.push({ ...mp, estGas: gas, why });
    cur = [];
    gas = r.gas.pushBase;
  };
  for (const x of picked) {
    const g = leafGas(x.l, r);
    if (chunk.get(x.l.account) !== curChunk) {
      flush();
      curChunk = chunk.get(x.l.account)!;
    }
    if (cur.length >= r.maxLeavesPerPush || gas + g > r.maxPushGas) flush();
    cur.push(x);
    gas += g;
  }
  flush();
  const anyCost = leaves.length ? leafCost0(leaves[0], e, r) : 0n;
  return { batches, waiting, thresholdPerLeaf0: floor0 > r.pushCostFactor * anyCost ? floor0 : r.pushCostFactor * anyCost };
}
