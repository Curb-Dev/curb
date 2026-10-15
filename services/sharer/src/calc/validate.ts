// Input validation and the vector format (spec README section 3). Every
// value entering the calculator is checked here or by the indexer; nothing is
// coerced silently.

import type { Address, EpochInput, KeeperTx, PoolAnswers, Setup, TransferLog } from './types.ts';

export class InputError extends Error {
  constructor(msg: string) {
    super('CURB-SHARE input error: ' + msg);
    this.name = 'InputError';
  }
}

export function fail(msg: string): never {
  throw new InputError(msg);
}

export function addr(x: unknown, what: string): Address {
  if (typeof x !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(x)) fail(`${what}: not an address: ${String(x)}`);
  return x.toLowerCase();
}

export function uint(x: unknown, what: string): bigint {
  if (typeof x !== 'string' || !/^(0|[1-9][0-9]*)$/.test(x)) fail(`${what}: not a decimal integer string: ${String(x)}`);
  return BigInt(x);
}

export function hash32(x: unknown, what: string): string {
  if (typeof x !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(x)) fail(`${what}: not a 32-byte hex value: ${String(x)}`);
  return x.toLowerCase();
}

export const byBlockAndIndex = (x: TransferLog, y: TransferLog): number =>
  x.block !== y.block ? (x.block < y.block ? -1 : 1) : x.logIndex < y.logIndex ? -1 : x.logIndex > y.logIndex ? 1 : 0;

/** Checks the invariants the calculator relies on for chain data: transfers
 *  sorted with no repeated (block, logIndex) and all after the opening block;
 *  timestamps that never go backwards. Used for vectors and for indexed data. */
export function checkSetup(s: Setup): Setup {
  if (s.sharingSince === 0n) fail('sharingSince must be non-zero');
  if (s.opening.block >= s.sharingSince) fail('opening.block must be before sharingSince');
  let lastT = -1n;
  for (const [b, t] of [...s.timestamps].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))) {
    if (t < lastT) fail(`timestamps go backwards at block ${b}`);
    lastT = t;
  }
  s.transfers.sort(byBlockAndIndex);
  for (let i = 1; i < s.transfers.length; i++) {
    if (s.transfers[i].block === s.transfers[i - 1].block && s.transfers[i].logIndex === s.transfers[i - 1].logIndex) {
      fail('two transfers share a (block, logIndex)');
    }
  }
  for (const t of s.transfers) if (t.block <= s.opening.block) fail('a transfer is at or before the opening block');
  return s;
}

type Json = Record<string, any>;

/** A vector's `setup`, validated and normalised. */
export function normaliseSetup(s: Json): Setup {
  if (typeof s.quoteIsWeth !== 'boolean') fail('quoteIsWeth must be a boolean');
  const r = s.rules ?? {};
  const ts = new Map<bigint, bigint>();
  for (const [b, t] of Object.entries(s.timestamps ?? {})) {
    const bb = uint(b, 'timestamp block');
    ts.set(bb, uint(t, `timestamp of ${b}`));
  }
  // A call that did not answer with an address is null (or left out).
  const answer = (x: unknown, what: string): Address | null => (x === null || x === undefined ? null : addr(x, what));
  const contracts = new Map<Address, PoolAnswers>();
  for (const [a, c] of Object.entries((s.contracts ?? {}) as Record<string, Json>)) {
    contracts.set(addr(a, 'contracts key'), {
      token0: answer(c.token0, `contracts.${a}.token0`),
      token1: answer(c.token1, `contracts.${a}.token1`),
      factory: answer(c.factory, `contracts.${a}.factory`),
    });
  }
  const opening = s.opening ?? {};
  const setup: Setup = {
    chainId: uint(s.chainId, 'chainId'),
    distributor: addr(s.distributor, 'distributor'),
    factory: addr(s.factory, 'factory'),
    launchToken: addr(s.launchToken, 'launchToken'),
    quoteToken: addr(s.quoteToken, 'quoteToken'),
    quoteIsWeth: s.quoteIsWeth,
    quoteDecimals: uint(s.quoteDecimals, 'quoteDecimals'),
    sharingSince: uint(s.sharingSince, 'sharingSince'),
    rules: {
      version: uint(r.version, 'rules.version'),
      exclusions: ((r.exclusions ?? []) as Json[]).map((x, i) => ({ address: addr(x.address, `exclusions[${i}]`), reason: String(x.reason) })),
      keeperKeys: ((r.keeperKeys ?? []) as unknown[]).map((k, i) => addr(k, `keeperKeys[${i}]`)),
      ammFactories: new Map(((r.ammFactories ?? []) as Json[]).map((x, i) => [addr(x.address, `ammFactories[${i}]`), String(x.reason)])),
    },
    contracts,
    opening: {
      block: uint(opening.block, 'opening.block'),
      balances: new Map(Object.entries((opening.balances ?? {}) as Record<string, unknown>).map(([a, v]) => [addr(a, 'opening balance'), uint(v, `opening.${a}`)])),
    },
    timestamps: ts,
    transfers: ((s.transfers ?? []) as Json[]).map((t, i) => ({
      block: uint(t.block, `transfers[${i}].block`),
      logIndex: uint(t.logIndex, `transfers[${i}].logIndex`),
      from: addr(t.from, `transfers[${i}].from`),
      to: addr(t.to, `transfers[${i}].to`),
      value: uint(t.value, `transfers[${i}].value`),
    })),
    keeperTxs: ((s.keeperTxs ?? []) as Json[]).map(
      (t, i): KeeperTx => ({
        hash: hash32(t.hash, `keeperTxs[${i}].hash`),
        from: addr(t.from, `keeperTxs[${i}].from`),
        to: addr(t.to, `keeperTxs[${i}].to`),
        block: uint(t.block, `keeperTxs[${i}].block`),
        gasUsed: uint(t.gasUsed, `keeperTxs[${i}].gasUsed`),
        effectiveGasPrice: uint(t.effectiveGasPrice, `keeperTxs[${i}].effectiveGasPrice`),
        l1Fee: uint(t.l1Fee, `keeperTxs[${i}].l1Fee`),
        names: [...new Set(((t.names ?? []) as unknown[]).map((n, j) => addr(n, `keeperTxs[${i}].names[${j}]`)))],
      }),
    ),
  };
  return checkSetup(setup);
}

/** One attempt's `input` from a vector, validated and normalised. */
export function normaliseInput(e: Json, i: number): EpochInput {
  return {
    toBlock: uint(e.toBlock, `epochs[${i}].toBlock`),
    harvestTx: hash32(e.harvestTx, `epochs[${i}].harvestTx`),
    uri: String(e.uri ?? ''),
    vetoed: e.vetoed === true,
    received0: uint(e.received0, `epochs[${i}].received0`),
    received1: uint(e.received1, `epochs[${i}].received1`),
    price: e.price ?? null,
    exclusionsAdded: ((e.exclusionsAdded ?? []) as Json[]).map((x, j) => ({
      address: addr(x.address, `epochs[${i}].exclusionsAdded[${j}]`),
      reason: String(x.reason),
    })),
  };
}
