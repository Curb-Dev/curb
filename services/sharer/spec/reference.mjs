#!/usr/bin/env node
// CURB-SHARE v1 reference calculator.
//
// This file is the executable form of the spec in README.md. It favours
// being obviously correct over being fast: every value is an exact BigInt,
// every rule is one visible step, and every input is validated. Any second
// implementation (the sharer service, the web verifier) must produce the same
// outputs, byte for byte, on every vector in ./vectors.
//
//   node reference.mjs --check [vector.json ...]   recompute and compare
//   node reference.mjs --write [vector.json ...]   recompute and rewrite the
//                                                  expected outputs and files
//
// Library use: import { runVector, computeEpoch, canonicalJson, ... }.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256 } from 'ethereum-cryptography/keccak.js';
import { SimpleMerkleTree, StandardMerkleTree } from '@openzeppelin/merkle-tree';

export const SPEC_VERSION = 'CURB-SHARE/1';
export const SCHEMA = 'curb.sharing.epoch/1';
export const CHUNK_SCHEMA = 'curb.sharing.chunk/1';
export const CHUNK_ACCOUNTS = 512;
export const LEAF_TYPES = ['address', 'address', 'uint256', 'uint256'];
export const LEAF_ENCODING = LEAF_TYPES.join(',');
export const MAX_KEEPER_FEE_BPS = 200n;
export const BPS = 10000n;
export const WAD = 10n ** 18n;
export const WEIGHT_FLOOR_DIVISOR = 10n ** 6n;
export const MAX_KEEPER_TXS = 512;
export const ZERO_ADDRESS = '0x' + '0'.repeat(40);
export const DEAD_ADDRESS = '0x000000000000000000000000000000000000dead';

// ---------------------------------------------------------------- validation

function fail(msg) {
  throw new Error('CURB-SHARE input error: ' + msg);
}

export function addr(x, what) {
  if (typeof x !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(x)) fail(`${what}: not an address: ${x}`);
  return x.toLowerCase();
}

export function uint(x, what) {
  if (typeof x !== 'string' || !/^(0|[1-9][0-9]*)$/.test(x)) fail(`${what}: not a decimal integer string: ${x}`);
  return BigInt(x);
}

function hash32(x, what) {
  if (typeof x !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(x)) fail(`${what}: not a 32-byte hex value: ${x}`);
  return x.toLowerCase();
}

// ------------------------------------------------------------------ encoding

/** RFC 8785 canonical JSON for the values this spec uses. Integers are BigInts
 *  and are written as decimal strings; plain JS numbers are refused so that no
 *  number formatting question can ever arise. Keys sort by UTF-16 code units,
 *  which is what Array.prototype.sort does for strings. */
export function canonicalJson(v) {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'bigint') return JSON.stringify(v.toString());
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  if (typeof v === 'object') {
    const keys = Object.keys(v).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
  }
  throw new Error(`canonical JSON: value of type ${typeof v} is not allowed: ${String(v)}`);
}

function wordOf(n) {
  if (n < 0n || n >= 1n << 256n) throw new Error('uint256 out of range: ' + n);
  return n.toString(16).padStart(64, '0');
}

function addrWord(a) {
  return a.slice(2).padStart(64, '0');
}

export function keccakHex(hexNo0x) {
  return '0x' + Buffer.from(keccak256(Buffer.from(hexNo0x, 'hex'))).toString('hex');
}

export function sha256Hex(bytes) {
  return '0x' + createHash('sha256').update(bytes).digest('hex');
}

/** The leaf hash the distributor computes on chain:
 *  keccak256(bytes.concat(keccak256(abi.encode(distributor, account, cum0, cum1)))) */
export function leafHash(distributor, account, cum0, cum1) {
  const enc = addrWord(distributor) + addrWord(account) + wordOf(BigInt(cum0)) + wordOf(BigInt(cum1));
  return keccakHex(keccakHex(enc).slice(2));
}

/** keccak256 of abi.encode(block, logIndex, from, to, value) for every
 *  replayed Transfer log, concatenated in (block, logIndex) order. */
export function transfersDigest(transfers) {
  let enc = '';
  for (const t of transfers) {
    enc += wordOf(t.block) + wordOf(t.logIndex) + addrWord(t.from) + addrWord(t.to) + wordOf(t.value);
  }
  return keccakHex(enc);
}

/** sha256 of abi.encode(address, balance) for every non-zero balance,
 *  concatenated in address order: the epoch file's stateAtEnd.digest. */
export function balancesDigest(balances) {
  let enc = '';
  for (const a of [...balances.keys()].sort()) {
    if (balances.get(a) > 0n) enc += addrWord(a) + wordOf(balances.get(a));
  }
  return sha256Hex(Buffer.from(enc, 'hex'));
}

// ------------------------------------------------------------------- pricing

/** Asset-0 base units per 10^18 wei (step 5). */
export function priceValue(price, quoteIsWeth, quoteDecimals) {
  if (quoteIsWeth) return { source: 'weth', feed: '', round: '', value: WAD };
  const e = price && price.ethUsd;
  const q = price && price.quoteUsd;
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

// --------------------------------------------------------------- the epoch

/**
 * Compute one epoch attempt.
 *
 * ctx = {
 *   setup:     normalised vector setup (see normaliseSetup),
 *   state:     the active state (null before the first active epoch) - see runVector,
 *   lastProposed: the highest epoch number ever proposed (vetoed ones included),
 *   vetoedSinceActive: epoch numbers vetoed after the active one,
 *   input:     normalised epoch input,
 * }
 * Returns { expected, file?, fileBytes?, next? }.
 */
export function computeEpoch(ctx) {
  const { setup, state, input } = ctx;
  const N = BigInt(ctx.lastProposed) + 1n;
  const D = setup.distributor;
  const T = input.toBlock;

  // Step 1: the window.
  const F = state ? state.toBlock + 1n : setup.sharingSince;
  if (T < F) fail(`toBlock ${T} is before fromBlock ${F}`);
  const openingBlock = state ? state.toBlock : setup.opening.block;
  if (state && !state.balancesAtEnd) fail('the complete balances after the active epoch are needed');
  const openingBalances = state ? state.balancesAtEnd : setup.opening.balances;
  if (openingBlock > F - 1n) fail('opening block must be at most fromBlock - 1');

  // Step 2: balances and weights. The replayed logs are those after the
  // opening block and no later than T.
  const replay = setup.transfers.filter((t) => t.block > openingBlock && t.block <= T);
  const ts = setup.timestamps;
  const tsOf = (b) => {
    const v = ts.get(b);
    if (v === undefined) fail(`timestamp of block ${b} is needed`);
    return v;
  };
  const apply = (m, t) => {
    if (t.from !== ZERO_ADDRESS) {
      const nb = (m.get(t.from) ?? 0n) - t.value;
      if (nb < 0n) fail(`balance of ${t.from} goes below zero at block ${t.block} log ${t.logIndex}`);
      m.set(t.from, nb);
    }
    if (t.to !== ZERO_ADDRESS) m.set(t.to, (m.get(t.to) ?? 0n) + t.value);
  };
  const bal = new Map(openingBalances);
  const w = new Map();
  const since = new Map();
  const start = tsOf(F - 1n);
  const settle = (a, upTo) => {
    const b = bal.get(a) ?? 0n;
    const s = since.get(a) ?? start;
    if (b > 0n) w.set(a, (w.get(a) ?? 0n) + b * (upTo - s));
    since.set(a, upTo);
  };
  for (const t of replay) {
    if (t.block >= F) {
      // A balance set in block b is held for dt(b) = ts(b) - ts(b-1): it
      // accrues from ts(b-1). A balance overwritten in the same block accrues
      // over ts(b-1) - ts(b-1) = 0.
      const at = tsOf(t.block - 1n);
      if (t.from !== ZERO_ADDRESS) settle(t.from, at);
      if (t.to !== ZERO_ADDRESS) settle(t.to, at);
    }
    apply(bal, t);
  }
  const end = tsOf(T);
  for (const a of new Set([...bal.keys(), ...since.keys()])) settle(a, end);
  // The weight floor: the supply (every balance after T, summed) over 10^6,
  // held for the whole window. A weight below it is no weight.
  let supply = 0n;
  for (const v of bal.values()) supply += v;
  const floor = (supply / WEIGHT_FLOOR_DIVISOR) * (end - start);
  for (const [a, x] of w) if (x < floor) w.set(a, 0n);

  // Step 3: exclusions - the fixed ones, the rules' list, then detected pools.
  const E = new Map();
  const exclude = (a, reason) => {
    if (!E.has(a)) E.set(a, reason);
  };
  exclude(DEAD_ADDRESS, 'burn address');
  exclude(D, 'this distributor');
  exclude(setup.launchToken, 'the launch token');
  exclude(setup.quoteToken, 'the quote token');
  exclude(setup.factory, 'the distributor factory');
  for (const x of setup.rules.exclusions) exclude(x.address, x.reason);
  for (const x of input.exclusionsAdded) exclude(x.address, x.reason);
  const prevCum = state ? state.cum : new Map();
  // Probed, and so detected, are the addresses with a weight: any of them
  // whose token0() or token1() is the launch token is a pool, whatever its
  // factory; the factory only names the reason.
  const weighed = [...w].filter(([, x]) => x > 0n).map(([a]) => a);
  for (const a of weighed.sort()) {
    const c = setup.contracts.get(a);
    if (!c) continue;
    if (c.token0 !== setup.launchToken && c.token1 !== setup.launchToken) continue;
    const f = c.factory === null ? undefined : setup.rules.ammFactories.get(c.factory);
    if (f !== undefined) exclude(a, `detected pool (factory ${c.factory}: ${f})`);
    else if (c.factory !== null) exclude(a, `detected pool (factory ${c.factory}, not in the rules' list)`);
    else exclude(a, 'detected pool (no factory())');
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
  // Step 8 (checked in this order).
  if (W === 0n) return { expected: { result: 'none', reason: 'no-weight', ...base } };
  if (I0 === 0n && I1 === 0n) return { expected: { result: 'none', reason: 'no-income', ...base } };

  // Step 5: keeper fee.
  const txs = [];
  for (const tx of setup.keeperTxs) {
    if (!setup.rules.keeperKeys.includes(tx.from)) continue;
    if (tx.block < F || tx.block > T) continue;
    const cost = tx.gasUsed * tx.effectiveGasPrice + tx.l1Fee;
    let share;
    if (tx.to === D) share = cost;
    else if (tx.to === setup.factory && tx.names.includes(D)) share = cost / BigInt(tx.names.length);
    else continue;
    txs.push({ hash: tx.hash, gasUsed: tx.gasUsed, price: tx.effectiveGasPrice, l1Fee: tx.l1Fee, share });
  }
  txs.sort((x, y) => (x.hash < y.hash ? -1 : x.hash > y.hash ? 1 : 0));
  // At most MAX_KEEPER_TXS are attributed: the lowest hashes.
  txs.splice(MAX_KEEPER_TXS);
  const costWei = txs.reduce((s, t) => s + t.share, 0n);
  const price = priceValue(input.price, setup.quoteIsWeth, setup.quoteDecimals);
  const C = (costWei * price.value) / WAD;
  const cap = (I0 * MAX_KEEPER_FEE_BPS) / BPS;
  let K = C < cap ? C : cap;
  const H = I0 - K;

  // Step 6: shares.
  const s0 = new Map();
  const s1 = new Map();
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
  if (dH0 === 0n && dH1 === 0n && K === 0n) return { expected: { result: 'none', reason: 'nothing-allocated', ...base } };

  // Step 7: cumulative values and the tree. Listed: an account with a share
  // this epoch, or with an earlier cumulative value - so every listed
  // account has a cumulative value, and a leaf.
  const withShare = [...s0.keys()].filter((a) => s0.get(a) > 0n || s1.get(a) > 0n);
  const accountsSet = new Set([...withShare, ...prevCum.keys()]);
  const accounts = [];
  const cum = new Map();
  for (const a of [...accountsSet].sort()) {
    const p = prevCum.get(a) ?? [0n, 0n];
    const c0 = p[0] + (s0.get(a) ?? 0n);
    const c1 = p[1] + (s1.get(a) ?? 0n);
    if (c0 === 0n && c1 === 0n) throw new Error('a listed account with no cumulative value');
    accounts.push({ a, w: w.get(a) ?? 0n, s0: s0.get(a) ?? 0n, s1: s1.get(a) ?? 0n, cum0: c0, cum1: c1 });
    cum.set(a, [c0, c1]);
  }
  const leaves = accounts.map((x) => [D, x.a, x.cum0.toString(), x.cum1.toString()]);
  // The tree in chunks of CHUNK_ACCOUNTS consecutive accounts: a
  // StandardMerkleTree each; the root is the one chunk's, or a
  // SimpleMerkleTree's over the chunk roots.
  const chunkLeaves = [];
  for (let i = 0; i < leaves.length; i += CHUNK_ACCOUNTS) chunkLeaves.push(leaves.slice(i, i + CHUNK_ACCOUNTS));
  const chunkTrees = chunkLeaves.map((ls) => StandardMerkleTree.of(ls, LEAF_TYPES));
  const root = chunkTrees.length === 1 ? chunkTrees[0].root : SimpleMerkleTree.of(chunkTrees.map((t) => t.root)).root;
  const leafHashes = chunkTrees.flatMap((t, k) =>
    chunkLeaves[k].map((l) => {
      const h = t.leafHash(l);
      if (h !== leafHash(l[0], l[1], l[2], l[3])) throw new Error('leaf hash disagrees with the on-chain encoding');
      return h;
    }),
  );

  const totals = { h0: prevTotals.h0 + dH0, h1: prevTotals.h1 + dH1, k0: prevTotals.k0 + K };
  // Invariants the on-chain publish() enforces; a violation is a bug here.
  let sum0 = 0n;
  let sum1 = 0n;
  for (const [, [c0, c1]] of cum) {
    sum0 += c0;
    sum1 += c1;
  }
  if (sum0 !== totals.h0 || sum1 !== totals.h1) throw new Error('leaves do not sum to the totals');
  if (totals.h0 + totals.k0 > input.received0 || totals.h1 > input.received1) throw new Error('allocates more than received');
  if (K * BPS > (dH0 + K) * MAX_KEEPER_FEE_BPS) throw new Error('keeper fee above the on-chain cap');

  // The file lists the balances of its own accounts and commits to all of
  // them; the complete state goes on to the next epoch.
  const complete = new Map([...bal].filter(([, v]) => v > 0n));
  const stateAtEnd = { count: BigInt(complete.size), digest: balancesDigest(complete), supply };

  // Its rows - each account row with its balance after T, `b` - in the
  // index up to one chunk's worth, in chunk files past that, each named in
  // the index by its range, count, size, sha256, root and sums.
  const rowOf = (x) => ({ ...x, b: bal.get(x.a) ?? 0n });
  const chunked = accounts.length > CHUNK_ACCOUNTS;
  const chunkFiles = [];
  const chunks = [];
  if (chunked) {
    chunkLeaves.forEach((_, k) => {
      const part = accounts.slice(k * CHUNK_ACCOUNTS, (k + 1) * CHUNK_ACCOUNTS);
      const bytes = Buffer.from(canonicalJson({ schema: CHUNK_SCHEMA, distributor: D, epoch: N, accounts: part.map(rowOf) }), 'utf8');
      chunkFiles.push(bytes);
      chunks.push({
        first: part[0].a,
        last: part[part.length - 1].a,
        count: BigInt(part.length),
        size: BigInt(bytes.length),
        sha256: sha256Hex(bytes),
        root: chunkTrees[k].root,
        sum0: part.reduce((s, x) => s + x.cum0, 0n),
        sum1: part.reduce((s, x) => s + x.cum1, 0n),
      });
    });
  }

  const supersedes = ctx.vetoedSinceActive.map((n) => BigInt(n));
  const file = {
    schema: SCHEMA,
    chainId: setup.chainId,
    distributor: D,
    launchToken: setup.launchToken,
    quoteToken: setup.quoteToken,
    epoch: N,
    supersedes,
    window: { fromBlock: F, toBlock: T, fromTime: start, toTime: end, harvestTx: input.harvestTx },
    rules: {
      version: setup.rules.version,
      exclusions: [...E].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([address, reason]) => ({ address, reason })),
      keeperKeys: [...setup.rules.keeperKeys].sort(),
    },
    inputs: {
      received0: input.received0,
      received1: input.received1,
      prevCum: { h0: prevTotals.h0, h1: prevTotals.h1, k0: prevTotals.k0 },
      transfers: { count: BigInt(replay.length), digest: transfersDigest(replay) },
    },
    keeper: {
      cost: C,
      txs,
      price: { source: price.source, feed: price.feed, round: price.round, value: price.value },
      fee: K,
      capped: K !== C,
    },
    weights: { W, floor },
    accounts: chunked ? [] : accounts.map(rowOf),
    chunks,
    stateAtEnd,
    merkle: { root, leafEncoding: LEAF_ENCODING },
    prev: state ? { epoch: state.epoch, contentHash: state.contentHash, uri: state.uri } : null,
  };
  const fileBytes = Buffer.from(canonicalJson(file), 'utf8');
  const contentHash = sha256Hex(fileBytes);

  const str = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]));
  const expected = {
    result: 'epoch',
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
    excluded: file.rules.exclusions.map((x) => x.address),
    accounts: accounts.map(str),
    leaves,
    leafHashes,
    merkleRoot: root,
    contentHash,
    chunks: chunks.map(str),
  };
  const next = { epoch: N, toBlock: T, balancesAtEnd: complete, stateAtEnd, cum, totals, contentHash, uri: input.uri };
  return { expected, file, fileBytes, chunkFiles, next };
}

// ------------------------------------------------------------- vector files

export function normaliseSetup(s) {
  const out = {};
  out.chainId = uint(s.chainId, 'chainId');
  out.distributor = addr(s.distributor, 'distributor');
  out.factory = addr(s.factory, 'factory');
  out.launchToken = addr(s.launchToken, 'launchToken');
  out.quoteToken = addr(s.quoteToken, 'quoteToken');
  if (typeof s.quoteIsWeth !== 'boolean') fail('quoteIsWeth must be a boolean');
  out.quoteIsWeth = s.quoteIsWeth;
  out.quoteDecimals = uint(s.quoteDecimals, 'quoteDecimals');
  out.sharingSince = uint(s.sharingSince, 'sharingSince');
  if (out.sharingSince === 0n) fail('sharingSince must be non-zero');
  const r = s.rules;
  out.rules = {
    version: uint(r.version, 'rules.version'),
    exclusions: (r.exclusions ?? []).map((x, i) => ({ address: addr(x.address, `exclusions[${i}]`), reason: String(x.reason) })),
    keeperKeys: (r.keeperKeys ?? []).map((k, i) => addr(k, `keeperKeys[${i}]`)),
    ammFactories: new Map((r.ammFactories ?? []).map((x, i) => [addr(x.address, `ammFactories[${i}]`), String(x.reason)])),
  };
  // A call that did not answer with an address is null, or left out.
  const answer = (x, what) => (x === null || x === undefined ? null : addr(x, what));
  out.contracts = new Map(
    Object.entries(s.contracts ?? {}).map(([a, c]) => [
      addr(a, 'contracts key'),
      { token0: answer(c.token0, `contracts.${a}.token0`), token1: answer(c.token1, `contracts.${a}.token1`), factory: answer(c.factory, `contracts.${a}.factory`) },
    ]),
  );
  out.opening = {
    block: uint(s.opening.block, 'opening.block'),
    balances: new Map(Object.entries(s.opening.balances ?? {}).map(([a, v]) => [addr(a, 'opening balance'), uint(v, `opening.${a}`)])),
  };
  if (out.opening.block >= out.sharingSince) fail('opening.block must be before sharingSince');
  const ts = new Map();
  let lastB = -1n;
  let lastT = -1n;
  for (const [b, t] of Object.entries(s.timestamps).map(([b, t]) => [uint(b, 'timestamp block'), uint(t, `timestamp of ${b}`)]).sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    if (b === lastB) fail('duplicate timestamp');
    if (t < lastT) fail(`timestamps go backwards at block ${b}`);
    ts.set(b, t);
    lastB = b;
    lastT = t;
  }
  out.timestamps = ts;
  const transfers = (s.transfers ?? []).map((t, i) => ({
    block: uint(t.block, `transfers[${i}].block`),
    logIndex: uint(t.logIndex, `transfers[${i}].logIndex`),
    from: addr(t.from, `transfers[${i}].from`),
    to: addr(t.to, `transfers[${i}].to`),
    value: uint(t.value, `transfers[${i}].value`),
  }));
  transfers.sort((x, y) => (x.block !== y.block ? (x.block < y.block ? -1 : 1) : x.logIndex < y.logIndex ? -1 : x.logIndex > y.logIndex ? 1 : 0));
  for (let i = 1; i < transfers.length; i++) {
    if (transfers[i].block === transfers[i - 1].block && transfers[i].logIndex === transfers[i - 1].logIndex) fail('two transfers share a (block, logIndex)');
  }
  for (const t of transfers) if (t.block <= out.opening.block) fail('a transfer is at or before the opening block');
  out.transfers = transfers;
  out.keeperTxs = (s.keeperTxs ?? []).map((t, i) => ({
    hash: hash32(t.hash, `keeperTxs[${i}].hash`),
    from: addr(t.from, `keeperTxs[${i}].from`),
    to: addr(t.to, `keeperTxs[${i}].to`),
    block: uint(t.block, `keeperTxs[${i}].block`),
    gasUsed: uint(t.gasUsed, `keeperTxs[${i}].gasUsed`),
    effectiveGasPrice: uint(t.effectiveGasPrice, `keeperTxs[${i}].effectiveGasPrice`),
    l1Fee: uint(t.l1Fee, `keeperTxs[${i}].l1Fee`),
    names: [...new Set((t.names ?? []).map((n, j) => addr(n, `keeperTxs[${i}].names[${j}]`)))],
  }));
  return out;
}

export function normaliseInput(e, i) {
  return {
    toBlock: uint(e.toBlock, `epochs[${i}].toBlock`),
    harvestTx: hash32(e.harvestTx, `epochs[${i}].harvestTx`),
    uri: String(e.uri ?? ''),
    vetoed: e.vetoed === true,
    received0: uint(e.received0, `epochs[${i}].received0`),
    received1: uint(e.received1, `epochs[${i}].received1`),
    price: e.price ?? null,
    exclusionsAdded: (e.exclusionsAdded ?? []).map((x, j) => ({ address: addr(x.address, `epochs[${i}].exclusionsAdded[${j}]`), reason: String(x.reason) })),
  };
}

/** Run every epoch attempt of a vector in order. An attempt that yields no
 *  epoch leaves the state alone; a vetoed epoch burns its number and leaves
 *  the active state alone; any other epoch becomes the active state. */
export function runVector(vector) {
  const setup = normaliseSetup(vector.setup);
  let state = null;
  let lastProposed = 0n;
  let vetoedSinceActive = [];
  const results = [];
  vector.epochs.forEach((raw, i) => {
    const input = normaliseInput(raw.input, i);
    const r = computeEpoch({ setup, state, lastProposed, vetoedSinceActive, input });
    results.push(r);
    if (r.expected.result !== 'epoch') return;
    lastProposed = BigInt(r.expected.epoch);
    if (input.vetoed) {
      vetoedSinceActive = [...vetoedSinceActive, lastProposed];
    } else {
      state = r.next;
      vetoedSinceActive = [];
    }
  });
  return results;
}

// ---------------------------------------------------------------------- CLI

const HERE = dirname(fileURLToPath(import.meta.url));
export const VECTORS_DIR = join(HERE, 'vectors');

export function vectorFiles() {
  return readdirSync(VECTORS_DIR)
    .filter((f) => /^v\d+.*\.json$/.test(f))
    .sort()
    .map((f) => join(VECTORS_DIR, f));
}

export function epochFilePath(vectorPath, epochNumber) {
  return join(VECTORS_DIR, 'files', basename(vectorPath, '.json'), `${epochNumber}.json`);
}

export function chunkFilePath(vectorPath, epochNumber, k) {
  return join(VECTORS_DIR, 'files', basename(vectorPath, '.json'), `${epochNumber}.chunk${k}.json`);
}

const rel = (p) => relative(VECTORS_DIR, p).split('\\').join('/');

function main(argv) {
  const mode = argv[0];
  if (mode !== '--check' && mode !== '--write') {
    console.error('usage: node reference.mjs --check|--write [vector.json ...]');
    return 2;
  }
  const files = argv.length > 1 ? argv.slice(1).map((f) => resolve(f)) : vectorFiles();
  let bad = 0;
  for (const path of files) {
    const vector = JSON.parse(readFileSync(path, 'utf8'));
    const results = runVector(vector);
    const name = relative(HERE, path);
    results.forEach((r, i) => {
      const where = `${name} attempt ${i + 1}`;
      if (mode === '--write') {
        vector.epochs[i].expected = r.expected;
        if (r.fileBytes) {
          const fp = epochFilePath(path, r.expected.epoch);
          mkdirSync(dirname(fp), { recursive: true });
          writeFileSync(fp, r.fileBytes);
          vector.epochs[i].expected.file = rel(fp);
          vector.epochs[i].expected.chunkFiles = r.chunkFiles.map((b, k) => {
            const cp = chunkFilePath(path, r.expected.epoch, k);
            writeFileSync(cp, b);
            return rel(cp);
          });
        }
        return;
      }
      const want = vector.epochs[i].expected;
      const got = { ...r.expected };
      if (r.fileBytes) {
        got.file = rel(epochFilePath(path, r.expected.epoch));
        got.chunkFiles = r.chunkFiles.map((_, k) => rel(chunkFilePath(path, r.expected.epoch, k)));
      }
      if (want === undefined) {
        console.error(`FAIL ${where}: no expected output recorded`);
        bad++;
        return;
      }
      if (canonicalJson(want) !== canonicalJson(got)) {
        bad++;
        console.error(`FAIL ${where}: outputs differ`);
        for (const k of new Set([...Object.keys(want), ...Object.keys(got)])) {
          if (canonicalJson(want[k] ?? null) !== canonicalJson(got[k] ?? null)) {
            console.error(`  ${k}: expected ${canonicalJson(want[k] ?? null).slice(0, 300)}`);
            console.error(`  ${' '.repeat(k.length)}  got      ${canonicalJson(got[k] ?? null).slice(0, 300)}`);
          }
        }
        return;
      }
      if (r.fileBytes) {
        const fp = epochFilePath(path, r.expected.epoch);
        if (!existsSync(fp) || !readFileSync(fp).equals(r.fileBytes)) {
          bad++;
          console.error(`FAIL ${where}: epoch file bytes differ from ${relative(HERE, fp)}`);
          return;
        }
        if (sha256Hex(readFileSync(fp)) !== want.contentHash) {
          bad++;
          console.error(`FAIL ${where}: sha256 of ${relative(HERE, fp)} is not the recorded contentHash`);
          return;
        }
        for (const [k, b] of r.chunkFiles.entries()) {
          const cp = chunkFilePath(path, r.expected.epoch, k);
          if (!existsSync(cp) || !readFileSync(cp).equals(b)) {
            bad++;
            console.error(`FAIL ${where}: chunk ${k} bytes differ from ${relative(HERE, cp)}`);
            return;
          }
        }
      }
      console.log(`ok   ${where}: ${r.expected.result === 'epoch' ? `epoch ${r.expected.epoch} root ${r.expected.merkleRoot}` : `no epoch (${r.expected.reason})`}`);
    });
    if (mode === '--write') {
      writeFileSync(path, JSON.stringify(vector, null, 2) + '\n');
      console.log(`wrote ${name}`);
    }
  }
  if (bad) console.error(`${bad} mismatch(es)`);
  return bad ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
