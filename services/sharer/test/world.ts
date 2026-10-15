// A mock chain built from a golden vector: the launch's contracts, the token's
// Transfer logs, the block times, the keeper's and the harvest transactions,
// the pool answers, the Chainlink feeds and the distributor's state over time.
// Running the whole pipeline (indexer -> calculator -> file) against it must
// reproduce the vector's files byte for byte.

import { encodeFunctionData, keccak256, toHex } from 'viem';
import { distributorAbi, erc20Abi, factoryAbi, feedAbi, graduatorAbi, poolAbi, curveAbi, TOPICS } from '../src/chain/abis.ts';
import type { AttemptResult } from '../src/calc/types.ts';
import type { SharerConfig } from '../src/epoch.ts';
import { abiContract, MockChain, Revert } from './mock-chain.ts';

export const ZERO = '0x0000000000000000000000000000000000000000';
const BASE_WETH = '0x4200000000000000000000000000000000000006';
export const HARVESTER = '0x00000000000000000000000000000000000beef0';

const ROLE_BY_REASON: Record<string, string> = {
  'the launch curve': 'curve',
  'the launch hook': 'hook',
  'the launcher FeeEscrow': 'escrow',
  'the Graduator': 'graduator',
  'the v4 PoolManager': 'poolManager',
  'the v4 PositionManager': 'positionManager',
  'the LaunchRegistry': 'registry',
  'the launch PositionLock': 'lock',
};

const word = (n: bigint): string => n.toString(16).padStart(64, '0');
const aword = (a: string): string => a.slice(2).toLowerCase().padStart(64, '0');
const topicOf = (a: string): string => '0x' + aword(a);

export type RootTuple = readonly [string, string, bigint, bigint, bigint, bigint, bigint, number, number];
const ZERO_ROOT: RootTuple = ['0x' + '0'.repeat(64), '0x' + '0'.repeat(64), 0n, 0n, 0n, 0n, 0n, 0, 0];

export interface World {
  chain: MockChain;
  config: SharerConfig;
  D: string;
  token: string;
  roles: Record<string, string>;
  opening: { block: bigint; balances: Map<string, bigint> };
  attempts: { harvestTx: string; uri: string; toBlock: bigint; vetoed: boolean }[];
  /** What a test may change on chain. */
  knobs: { pending: RootTuple; excludedOnChain: Set<string>; boundDistributor: string; recordWords: number };
  /** Records an attempt's outcome on chain, from the block after its T. */
  applyResult(i: number, r: AttemptResult): void;
}

export function vectorWorld(v: any, opts: { salt?: string } = {}): World {
  const s = v.setup;
  const chain = new MockChain();
  if (opts.salt) chain.salt = opts.salt;
  chain.chainId = BigInt(s.chainId);
  const D = s.distributor.toLowerCase();
  const token = s.launchToken.toLowerCase();
  const quote = s.quoteToken.toLowerCase();
  const factory = s.factory.toLowerCase();

  // Which excluded addresses are the launch's own contracts.
  const roles: Record<string, string> = {};
  const configExclusions: { address: string; reason: string }[] = [];
  for (const x of s.rules.exclusions) {
    const role = ROLE_BY_REASON[x.reason];
    if (role && !roles[role]) roles[role] = x.address.toLowerCase();
    else configExclusions.push({ address: x.address.toLowerCase(), reason: x.reason });
  }
  for (const r of ['curve', 'hook', 'escrow', 'graduator', 'poolManager', 'positionManager', 'registry']) {
    if (!roles[r]) throw new Error(`vector ${v.name} has no ${r} exclusion`);
  }
  const lock = roles.lock ?? ZERO;

  // Blocks.
  let maxBlock = 0n;
  let maxTs = 0n;
  for (const [b, t] of Object.entries(s.timestamps as Record<string, string>)) {
    chain.setBlock(BigInt(b), BigInt(t));
    if (BigInt(b) > maxBlock) {
      maxBlock = BigInt(b);
      maxTs = BigInt(t);
    }
  }
  chain.setBlock(maxBlock + 1n, maxTs + 2n);
  chain.safe = maxBlock + 1n;

  // The token's transfers.
  (s.transfers ?? []).forEach((t: any, i: number) => {
    chain.addLog({
      address: token,
      topics: [TOPICS.Transfer, topicOf(t.from), topicOf(t.to)],
      data: '0x' + word(BigInt(t.value)),
      block: BigInt(t.block),
      logIndex: BigInt(t.logIndex),
      txHash: keccak256(toHex(`transfer:${i}`)),
    });
  });

  // Keeper transactions, and the harvests.
  const keeperByHash = new Map<string, any>();
  (s.keeperTxs ?? []).forEach((t: any, i: number) => {
    const to = t.to.toLowerCase();
    const names: string[] = (t.names ?? []).map((n: string) => n.toLowerCase());
    let input = '0x5c975abb';
    if (to === factory) {
      input = encodeFunctionData({
        abi: factoryAbi,
        functionName: 'publishMany',
        args: [names as `0x${string}`[], names.map(() => ({ merkleRoot: ZERO_ROOT[0], contentHash: ZERO_ROOT[1], cumHolders0: 0n, cumHolders1: 0n, cumKeeper0: 0n, fromBlock: 0n, toBlock: 0n, epoch: 0, payableAt: 0 })) as any, names.map(() => '')],
      });
    }
    const hash = t.hash.toLowerCase();
    keeperByHash.set(hash, t);
    chain.txs.set(hash, { hash, from: t.from.toLowerCase(), to, input, block: BigInt(t.block), gasUsed: BigInt(t.gasUsed), effectiveGasPrice: BigInt(t.effectiveGasPrice), l1Fee: BigInt(t.l1Fee) });
    if (to === D || (to === factory && names.includes(D))) {
      chain.addLog({ address: D, topics: [keccak256(toHex('KeeperTouched()'))], data: '0x', block: BigInt(t.block), logIndex: 5000n + BigInt(i), txHash: hash });
    }
  });
  const attempts = v.epochs.map((e: any, i: number) => {
    const T = BigInt(e.input.toBlock);
    const hash = e.input.harvestTx.toLowerCase();
    if (!keeperByHash.has(hash)) chain.txs.set(hash, { hash, from: HARVESTER, to: D, input: '0x4641257d', block: T });
    else if (keeperByHash.get(hash).to.toLowerCase() !== D || BigInt(keeperByHash.get(hash).block) !== T) throw new Error('a harvest tx that is a keeper tx must be to D at T');
    chain.addLog({ address: D, topics: [keccak256(toHex('Harvested(uint256,uint256)'))], data: '0x' + word(0n) + word(0n), block: T, logIndex: 9000n + BigInt(i), txHash: hash });
    return { harvestTx: hash, uri: String(e.input.uri ?? ''), toBlock: T, vetoed: e.input.vetoed === true };
  });

  // Income and prices per harvest block.
  const income = new Map<bigint, [bigint, bigint]>();
  const prices = new Map<bigint, any>();
  for (const e of v.epochs) {
    const T = BigInt(e.input.toBlock);
    if (income.has(T)) throw new Error('two attempts share a toBlock');
    income.set(T, [BigInt(e.input.received0), BigInt(e.input.received1)]);
    prices.set(T, e.input.price ?? null);
  }

  // The distributor's state over time.
  const timeline: { from: bigint; active: RootTuple; lastProposed: number }[] = [{ from: 0n, active: ZERO_ROOT, lastProposed: 0 }];
  const stateAt = (b: bigint) => {
    let cur = timeline[0];
    for (const t of timeline) if (t.from <= b) cur = t;
    return cur;
  };

  const knobs = { pending: ZERO_ROOT as RootTuple, excludedOnChain: new Set<string>(), boundDistributor: D, recordWords: 12 };
  const fixedExcluded = new Set([D, token, quote, factory, '0x000000000000000000000000000000000000dead', ...Object.values(roles)]);
  chain.setContract(
    D,
    abiContract(distributorAbi, {
      launchToken: () => token,
      quoteToken: () => quote,
      graduator: () => roles.graduator,
      factory: () => factory,
      received0: (_a, b) => {
        const x = income.get(b);
        if (!x) throw new Revert(`no income recorded at block ${b}`);
        return x[0];
      },
      received1: (_a, b) => {
        const x = income.get(b);
        if (!x) throw new Revert(`no income recorded at block ${b}`);
        return x[1];
      },
      active: (_a, b) => stateAt(b).active,
      pending: () => knobs.pending,
      lastProposedEpoch: (_a, b) => stateAt(b).lastProposed,
      isExcluded: (a) => fixedExcluded.has(String(a[0]).toLowerCase()) || knobs.excludedOnChain.has(String(a[0]).toLowerCase()),
    }),
  );
  chain.setContract(
    roles.graduator,
    abiContract(graduatorAbi, {
      holderDistributorOf: (a) => (String(a[0]).toLowerCase() === token ? knobs.boundDistributor : ZERO),
      sharingSince: (a) => (String(a[0]).toLowerCase() === token ? BigInt(s.sharingSince) : 0n),
      lockOf: (a) => (String(a[0]).toLowerCase() === token ? lock : ZERO),
      hasGraduated: () => lock !== ZERO,
      registry: () => roles.registry,
      poolManager: () => roles.poolManager,
      positionManager: () => roles.positionManager,
    }),
  );
  chain.setContract(roles.registry, (data) => {
    if (!data.startsWith('0x029282d7')) throw new Revert('registry: unknown selector');
    const who = '0x' + data.slice(34, 74);
    if (who.toLowerCase() !== token) return '0x' + word(0n).repeat(12);
    const since = BigInt(s.sharingSince);
    const launchedAt = chain.headers.get(since)?.timestamp ?? 0n;
    const words = [aword(roles.curve), aword(quote), aword('0x00000000000000000000000000000000000c0de1'), aword('0x00000000000000000000000000000000000c0de1'), word(15552000n), word(10000n), word(200n), aword(roles.hook), word(100n), word(2000n), aword('0x00000000000000000000000000000000000fee01'), word(launchedAt)];
    return '0x' + words.slice(0, knobs.recordWords).join('');
  });
  chain.setContract(roles.curve, abiContract(curveAbi, { feeEscrow: () => roles.escrow }));
  chain.setContract(quote, abiContract(erc20Abi, { decimals: () => Number(s.quoteDecimals) }));
  for (const [a, c] of Object.entries((s.contracts ?? {}) as Record<string, any>)) {
    // a null answer is a call that reverts
    const or = (x: string | null | undefined) => () => {
      if (x === null || x === undefined) throw new Revert('no answer');
      return x;
    };
    chain.setContract(a, abiContract(poolAbi, { token0: or(c.token0), token1: or(c.token1), factory: or(c.factory) }));
  }

  // Chainlink feeds: one address per role across the vector.
  let feeds: { ethUsd: string; quoteUsd: string } | null = null;
  for (const p of prices.values()) {
    if (p?.ethUsd && p?.quoteUsd) {
      feeds = { ethUsd: p.ethUsd.feed.toLowerCase(), quoteUsd: p.quoteUsd.feed.toLowerCase() };
      break;
    }
  }
  if (feeds) {
    for (const role of ['ethUsd', 'quoteUsd'] as const) {
      chain.setContract(
        feeds[role],
        abiContract(feedAbi, {
          latestRoundData: (_a, b) => {
            const p = prices.get(b)?.[role];
            if (!p) throw new Revert('feed down');
            if (p.feed.toLowerCase() !== feeds![role]) throw new Error('the vector moves a feed');
            return [BigInt(p.round), BigInt(p.answer), 0n, 0n, BigInt(p.round)];
          },
          decimals: (_a, b) => {
            const p = prices.get(b)?.[role];
            if (!p) throw new Revert('feed down');
            return Number(p.decimals);
          },
        }),
      );
    }
  }

  const config: SharerConfig = {
    chainId: BigInt(s.chainId),
    graduator: roles.graduator,
    graduatorFromBlock: 0n,
    weth: s.quoteIsWeth ? quote : BASE_WETH,
    rules: {
      version: BigInt(s.rules.version),
      exclusions: configExclusions,
      keeperKeys: s.rules.keeperKeys ?? [],
      ammFactories: s.rules.ammFactories ?? [],
    },
    feeds: feeds ? { [quote]: feeds } : {},
  };

  return {
    chain,
    config,
    D,
    token,
    roles,
    opening: {
      block: BigInt(s.opening.block),
      balances: new Map(Object.entries((s.opening.balances ?? {}) as Record<string, string>).map(([a, b]) => [a.toLowerCase(), BigInt(b)])),
    },
    attempts,
    knobs,
    applyResult(i, r) {
      if (r.result !== 'epoch') return;
      const at = attempts[i].toBlock + 1n;
      const prev = stateAt(at);
      const N = Number(r.root.epoch);
      const active: RootTuple = attempts[i].vetoed
        ? prev.active
        : [r.root.merkleRoot, r.root.contentHash, r.root.cumHolders0, r.root.cumHolders1, r.root.cumKeeper0, r.root.fromBlock, r.root.toBlock, N, Number(attempts[i].toBlock) + 100];
      timeline.push({ from: at, active, lastProposed: N });
    },
  };
}
