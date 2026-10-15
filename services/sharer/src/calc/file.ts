// The epoch file curb.sharing.epoch/1: encoding it, reading it, checking it
// and resuming from it (spec README section 2).
//
// A FILE IS AN INDEX AND, PAST ONE CHUNK OF ROWS, ITS CHUNKS. The index is
// the file the chain names - its sha256 is the on-chain contentHash - and it
// holds everything but the account rows; the rows too when there are at
// most CHUNK_ACCOUNTS of them. Past that the rows go in chunk files of
// CHUNK_ACCOUNTS consecutive rows in address order (the last may hold
// fewer), and the index lists each chunk's range, row count, byte length,
// sha256, tree root and sums: a chunk is trusted only through the sha256 its
// index gives, as the index is only through the chain. So no file grows past
// a bound however many accounts a launch has ever paid - an account that
// earns once is in every later file, for good - and each reader takes the
// chunks it needs: the site one account's, a verifier every one.
//
// verifyEpochFile re-derives everything a file can prove about itself
// without the chain: the root from the rows, every share from the weights
// and W, the weight floor from the supply and the window, the totals and the
// keeper cap, the chunks against their index. Who is missing from the rows,
// and the complete balances behind stateAtEnd, only a recompute from the
// chain can tell (epoch.ts).

import { canonicalBytes, canonicalJson, sha256Hex, utf8Decode } from './encoding.ts';
import { buildTree, CHUNK_ACCOUNTS, LEAF_ENCODING, ShareTree } from './merkle.ts';
import { BPS, CHUNK_SCHEMA, MAX_KEEPER_FEE_BPS, MAX_KEEPER_TXS, SCHEMA, WAD, WEIGHT_FLOOR_DIVISOR } from './constants.ts';
import type { AccountRow, ActiveState, Address, ChunkInfo, EpochFile, EpochHeader, EpochIndex, Leaf, Row } from './types.ts';
import { addr, fail, hash32, InputError, uint } from './validate.ts';

type Json = Record<string, any>;

const isObj = (x: unknown): x is Json => typeof x === 'object' && x !== null && !Array.isArray(x);
const arr = (x: unknown, what: string): unknown[] => (Array.isArray(x) ? x : fail(`${what}: not an array`));
const obj = (x: unknown, what: string): Json => (isObj(x) ? x : fail(`${what}: not an object`));
const str = (x: unknown, what: string): string => (typeof x === 'string' ? x : fail(`${what}: not a string`));
const bool = (x: unknown, what: string): boolean => (typeof x === 'boolean' ? x : fail(`${what}: not a boolean`));
const lower = (x: unknown, what: string): Address => {
  const a = addr(x, what);
  if (a !== x) fail(`${what}: not lowercase`);
  return a;
};

function exactKeys(o: Json, keys: string[], what: string): void {
  const got = Object.keys(o).sort();
  const want = [...keys].sort();
  if (canonicalJson(got) !== canonicalJson(want)) fail(`${what}: keys are ${got.join(',')}, expected ${want.join(',')}`);
}

const INDEX_KEYS = ['schema', 'chainId', 'distributor', 'launchToken', 'quoteToken', 'epoch', 'supersedes', 'window', 'rules', 'inputs', 'keeper', 'weights', 'accounts', 'chunks', 'stateAtEnd', 'merkle', 'prev'];
const CHUNK_KEYS = ['schema', 'distributor', 'epoch', 'accounts'];
const DESCRIPTOR_KEYS = ['first', 'last', 'count', 'size', 'sha256', 'root', 'sum0', 'sum1'];

// ---------------------------------------------------------------- encoding

/** A row as the files write it: the account row and its balance after T, `b`. */
const rowJson = (r: Row): Json => ({ a: r.a, w: r.w, s0: r.s0, s1: r.s1, cum0: r.cum0, cum1: r.cum1, b: r.b });

const chunkJson = (c: ChunkInfo): Json => ({ first: c.first, last: c.last, count: c.count, size: c.size, sha256: c.sha256, root: c.root, sum0: c.sum0, sum1: c.sum1 });

/** The index as JSON: every field named, so nothing else can slip in. */
function indexJson(x: EpochIndex): Json {
  return {
    schema: x.schema,
    chainId: x.chainId,
    distributor: x.distributor,
    launchToken: x.launchToken,
    quoteToken: x.quoteToken,
    epoch: x.epoch,
    supersedes: x.supersedes,
    window: { fromBlock: x.window.fromBlock, toBlock: x.window.toBlock, fromTime: x.window.fromTime, toTime: x.window.toTime, harvestTx: x.window.harvestTx },
    rules: { version: x.rules.version, exclusions: x.rules.exclusions.map((e) => ({ address: e.address, reason: e.reason })), keeperKeys: x.rules.keeperKeys },
    inputs: {
      received0: x.inputs.received0,
      received1: x.inputs.received1,
      prevCum: { h0: x.inputs.prevCum.h0, h1: x.inputs.prevCum.h1, k0: x.inputs.prevCum.k0 },
      transfers: { count: x.inputs.transfers.count, digest: x.inputs.transfers.digest },
    },
    keeper: {
      cost: x.keeper.cost,
      txs: x.keeper.txs.map((t) => ({ hash: t.hash, gasUsed: t.gasUsed, price: t.price, l1Fee: t.l1Fee, share: t.share })),
      price: { source: x.keeper.price.source, feed: x.keeper.price.feed, round: x.keeper.price.round, value: x.keeper.price.value },
      fee: x.keeper.fee,
      capped: x.keeper.capped,
    },
    weights: { W: x.weights.W, floor: x.weights.floor },
    accounts: x.rows.map(rowJson),
    chunks: x.chunks.map(chunkJson),
    stateAtEnd: { count: x.stateAtEnd.count, digest: x.stateAtEnd.digest, supply: x.stateAtEnd.supply },
    merkle: { root: x.merkle.root, leafEncoding: x.merkle.leafEncoding },
    prev: x.prev ? { epoch: x.prev.epoch, contentHash: x.prev.contentHash, uri: x.prev.uri } : null,
  };
}

export interface EncodedEpoch {
  index: EpochIndex;
  /** The index's bytes: what the chain's contentHash is the sha256 of. */
  bytes: Uint8Array;
  contentHash: string;
  /** Past CHUNK_ACCOUNTS rows, the chunk files, in order; none otherwise. */
  chunks: { info: ChunkInfo; bytes: Uint8Array }[];
  tree: ShareTree;
  leaves: Leaf[];
  leafHashes: string[];
}

/** The canonical files of one epoch (spec 2): the index and, past
 *  CHUNK_ACCOUNTS rows, the chunks. `rows` in address order, each with a
 *  non-zero cumulative value (every listed account has one). */
export function encodeEpoch(header: Omit<EpochHeader, 'chunks'>, rows: Row[]): EncodedEpoch {
  for (let i = 1; i < rows.length; i++) if (!(rows[i - 1].a < rows[i].a)) throw new Error('internal: rows are not in address order');
  const D = header.distributor;
  for (const r of rows) if (r.cum0 === 0n && r.cum1 === 0n) throw new Error(`internal: a row with no cumulative value (${r.a})`);
  const leaves: Leaf[] = rows.map((r) => [D, r.a, r.cum0.toString(), r.cum1.toString()]);
  const { tree, leafHashes } = buildTree(leaves);
  const chunks: { info: ChunkInfo; bytes: Uint8Array }[] = [];
  if (rows.length > CHUNK_ACCOUNTS) {
    tree.chunks.forEach((c, k) => {
      const part = rows.slice(k * CHUNK_ACCOUNTS, (k + 1) * CHUNK_ACCOUNTS);
      const bytes = canonicalBytes({ schema: CHUNK_SCHEMA, distributor: D, epoch: header.epoch, accounts: part.map(rowJson) });
      let sum0 = 0n;
      let sum1 = 0n;
      for (const r of part) {
        sum0 += r.cum0;
        sum1 += r.cum1;
      }
      if (part[0].a !== c.first || part[part.length - 1].a !== c.last) throw new Error('internal: a chunk is not its tree chunk');
      chunks.push({ info: { first: c.first, last: c.last, count: BigInt(part.length), size: BigInt(bytes.length), sha256: sha256Hex(bytes), root: c.root, sum0, sum1 }, bytes });
    });
  }
  const index: EpochIndex = { ...header, chunks: chunks.map((c) => c.info), merkle: { root: tree.root, leafEncoding: LEAF_ENCODING }, rows: chunks.length ? [] : rows };
  const bytes = canonicalBytes(indexJson(index));
  return { index, bytes, contentHash: sha256Hex(bytes), chunks, tree, leaves, leafHashes };
}

/** Where the site serves a chunk, under its data repo's sharing/ tree: by
 *  its sha256, so a chunk is found from the index alone. */
export function chunkPath(chainId: bigint | number | string, distributor: Address, sha256: string): string {
  return `sharing/${chainId}/${distributor.toLowerCase()}/chunks/${sha256.toLowerCase().replace(/^0x/, '')}.json`;
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** The IPFS CID of a chunk of at most 262,144 bytes - one raw block, as a
 *  CIDv1 add with raw leaves stores it (ops/cid.ts) - from its sha256 alone;
 *  null for a larger one (its CID is a UnixFS root, which needs the bytes). */
export function chunkCid(c: Pick<ChunkInfo, 'sha256' | 'size'>): string | null {
  if (c.size > 262_144n) return null;
  const h = c.sha256.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(h)) return null;
  const bytes = [0x01, 0x55, 0x12, 0x20, ...(h.match(/../g) ?? []).map((x) => parseInt(x, 16))];
  let bits = 0;
  let value = 0;
  let out = 'b';
  for (const b of bytes) {
    value = ((value << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

// ---------------------------------------------------------------- reading

function canonicalValue(bytes: Uint8Array, what: string): Json {
  let text: string;
  try {
    text = utf8Decode(bytes);
  } catch {
    fail(`${what} is not UTF-8`);
  }
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    fail(`${what} is not JSON`);
  }
  if (canonicalJson(j) !== text) fail(`${what} is not in canonical form`);
  return obj(j, what);
}

function decodeRow(x: unknown, what: string): Row {
  const r = obj(x, what);
  exactKeys(r, ['a', 'w', 's0', 's1', 'cum0', 'cum1', 'b'], what);
  return { a: lower(r.a, `${what}.a`), w: uint(r.w, `${what}.w`), s0: uint(r.s0, `${what}.s0`), s1: uint(r.s1, `${what}.s1`), cum0: uint(r.cum0, `${what}.cum0`), cum1: uint(r.cum1, `${what}.cum1`), b: uint(r.b, `${what}.b`) };
}

/** Parses the bytes of an epoch file's index. Refuses anything that is not
 *  exactly the canonical encoding of a curb.sharing.epoch/1 index. */
export function parseEpochIndex(bytes: Uint8Array): EpochIndex {
  const j = canonicalValue(bytes, 'epoch file');
  exactKeys(j, INDEX_KEYS, 'epoch file');
  if (j.schema !== SCHEMA) fail(`schema is ${String(j.schema)}, expected ${SCHEMA}`);
  const w = obj(j.window, 'window');
  exactKeys(w, ['fromBlock', 'toBlock', 'fromTime', 'toTime', 'harvestTx'], 'window');
  const r = obj(j.rules, 'rules');
  exactKeys(r, ['version', 'exclusions', 'keeperKeys'], 'rules');
  const inp = obj(j.inputs, 'inputs');
  exactKeys(inp, ['received0', 'received1', 'prevCum', 'transfers'], 'inputs');
  const pc = obj(inp.prevCum, 'inputs.prevCum');
  exactKeys(pc, ['h0', 'h1', 'k0'], 'inputs.prevCum');
  const tr = obj(inp.transfers, 'inputs.transfers');
  exactKeys(tr, ['count', 'digest'], 'inputs.transfers');
  const k = obj(j.keeper, 'keeper');
  exactKeys(k, ['cost', 'txs', 'price', 'fee', 'capped'], 'keeper');
  const p = obj(k.price, 'keeper.price');
  exactKeys(p, ['source', 'feed', 'round', 'value'], 'keeper.price');
  if (p.source !== 'weth' && p.source !== 'chainlink' && p.source !== 'none') fail('keeper.price.source is not weth, chainlink or none');
  const wt = obj(j.weights, 'weights');
  exactKeys(wt, ['W', 'floor'], 'weights');
  const se = obj(j.stateAtEnd, 'stateAtEnd');
  exactKeys(se, ['count', 'digest', 'supply'], 'stateAtEnd');
  const m = obj(j.merkle, 'merkle');
  exactKeys(m, ['root', 'leafEncoding'], 'merkle');
  let prev: EpochIndex['prev'] = null;
  if (j.prev !== null) {
    const pv = obj(j.prev, 'prev');
    exactKeys(pv, ['epoch', 'contentHash', 'uri'], 'prev');
    prev = { epoch: uint(pv.epoch, 'prev.epoch'), contentHash: hash32(pv.contentHash, 'prev.contentHash'), uri: str(pv.uri, 'prev.uri') };
  }
  return {
    schema: SCHEMA,
    chainId: uint(j.chainId, 'chainId'),
    distributor: lower(j.distributor, 'distributor'),
    launchToken: lower(j.launchToken, 'launchToken'),
    quoteToken: lower(j.quoteToken, 'quoteToken'),
    epoch: uint(j.epoch, 'epoch'),
    supersedes: arr(j.supersedes, 'supersedes').map((x, i) => uint(x, `supersedes[${i}]`)),
    window: {
      fromBlock: uint(w.fromBlock, 'window.fromBlock'),
      toBlock: uint(w.toBlock, 'window.toBlock'),
      fromTime: uint(w.fromTime, 'window.fromTime'),
      toTime: uint(w.toTime, 'window.toTime'),
      harvestTx: hash32(w.harvestTx, 'window.harvestTx'),
    },
    rules: {
      version: uint(r.version, 'rules.version'),
      exclusions: arr(r.exclusions, 'rules.exclusions').map((x, i) => {
        const e = obj(x, `rules.exclusions[${i}]`);
        exactKeys(e, ['address', 'reason'], `rules.exclusions[${i}]`);
        return { address: lower(e.address, `rules.exclusions[${i}].address`), reason: str(e.reason, `rules.exclusions[${i}].reason`) };
      }),
      keeperKeys: arr(r.keeperKeys, 'rules.keeperKeys').map((x, i) => lower(x, `rules.keeperKeys[${i}]`)),
    },
    inputs: {
      received0: uint(inp.received0, 'inputs.received0'),
      received1: uint(inp.received1, 'inputs.received1'),
      prevCum: { h0: uint(pc.h0, 'prevCum.h0'), h1: uint(pc.h1, 'prevCum.h1'), k0: uint(pc.k0, 'prevCum.k0') },
      transfers: { count: uint(tr.count, 'transfers.count'), digest: hash32(tr.digest, 'transfers.digest') },
    },
    keeper: {
      cost: uint(k.cost, 'keeper.cost'),
      txs: arr(k.txs, 'keeper.txs').map((x, i) => {
        const t = obj(x, `keeper.txs[${i}]`);
        exactKeys(t, ['hash', 'gasUsed', 'price', 'l1Fee', 'share'], `keeper.txs[${i}]`);
        return {
          hash: hash32(t.hash, `keeper.txs[${i}].hash`),
          gasUsed: uint(t.gasUsed, `keeper.txs[${i}].gasUsed`),
          price: uint(t.price, `keeper.txs[${i}].price`),
          l1Fee: uint(t.l1Fee, `keeper.txs[${i}].l1Fee`),
          share: uint(t.share, `keeper.txs[${i}].share`),
        };
      }),
      price: { source: p.source, feed: str(p.feed, 'price.feed'), round: str(p.round, 'price.round'), value: uint(p.value, 'price.value') },
      fee: uint(k.fee, 'keeper.fee'),
      capped: bool(k.capped, 'keeper.capped'),
    },
    weights: { W: uint(wt.W, 'weights.W'), floor: uint(wt.floor, 'weights.floor') },
    stateAtEnd: { count: uint(se.count, 'stateAtEnd.count'), digest: hash32(se.digest, 'stateAtEnd.digest'), supply: uint(se.supply, 'stateAtEnd.supply') },
    prev,
    chunks: arr(j.chunks, 'chunks').map((x, i) => {
      const c = obj(x, `chunks[${i}]`);
      exactKeys(c, DESCRIPTOR_KEYS, `chunks[${i}]`);
      return {
        first: lower(c.first, `chunks[${i}].first`),
        last: lower(c.last, `chunks[${i}].last`),
        count: uint(c.count, `chunks[${i}].count`),
        size: uint(c.size, `chunks[${i}].size`),
        sha256: hash32(c.sha256, `chunks[${i}].sha256`),
        root: hash32(c.root, `chunks[${i}].root`),
        sum0: uint(c.sum0, `chunks[${i}].sum0`),
        sum1: uint(c.sum1, `chunks[${i}].sum1`),
      };
    }),
    merkle: { root: hash32(m.root, 'merkle.root'), leafEncoding: str(m.leafEncoding, 'merkle.leafEncoding') },
    rows: arr(j.accounts, 'accounts').map((x, i) => decodeRow(x, `accounts[${i}]`)),
  };
}

/**
 * The rows of chunk `k` of `index`, from that chunk file's bytes: refused
 * unless their sha256 and length are the ones the index gives, they are the
 * canonical encoding of a curb.sharing.chunk/1 of this distributor and
 * epoch, and they hold exactly the rows the index counts, in address order,
 * from its first to its last.
 */
export function parseEpochChunk(bytes: Uint8Array, index: EpochIndex, k: number): Row[] {
  const c = index.chunks[k];
  if (!c) fail(`the index has no chunk ${k}`);
  const h = sha256Hex(bytes);
  if (h !== c.sha256) fail(`chunk ${k}: sha256 ${h} is not the ${c.sha256} its index gives`);
  if (BigInt(bytes.length) !== c.size) fail(`chunk ${k}: ${bytes.length} bytes, its index says ${c.size}`);
  const j = canonicalValue(bytes, `chunk ${k}`);
  exactKeys(j, CHUNK_KEYS, `chunk ${k}`);
  if (j.schema !== CHUNK_SCHEMA) fail(`chunk ${k}: schema is ${String(j.schema)}, expected ${CHUNK_SCHEMA}`);
  if (lower(j.distributor, `chunk ${k}.distributor`) !== index.distributor) fail(`chunk ${k} is for distributor ${j.distributor}, not ${index.distributor}`);
  if (uint(j.epoch, `chunk ${k}.epoch`) !== index.epoch) fail(`chunk ${k} is of epoch ${j.epoch}, not ${index.epoch}`);
  const rows = arr(j.accounts, `chunk ${k}.accounts`).map((x, i) => decodeRow(x, `chunk ${k}.accounts[${i}]`));
  if (BigInt(rows.length) !== c.count) fail(`chunk ${k} holds ${rows.length} rows, its index counts ${c.count}`);
  if (!rows.length || rows[0].a !== c.first || rows[rows.length - 1].a !== c.last) fail(`chunk ${k} does not run from ${c.first} to ${c.last}`);
  for (let i = 1; i < rows.length; i++) if (!(rows[i - 1].a < rows[i].a)) fail(`chunk ${k}: rows are not sorted by address, or repeat`);
  return rows;
}

/** The file a set of rows makes with its index: the accounts, the non-zero
 *  balances and the leaves are the rows'. `parts` names the chunks the rows
 *  come from when they are not all of them. */
function fileOf(index: EpochIndex, rows: Row[], parts?: number[]): EpochFile {
  const D = index.distributor;
  const accounts: AccountRow[] = rows.map((r) => ({ a: r.a, w: r.w, s0: r.s0, s1: r.s1, cum0: r.cum0, cum1: r.cum1 }));
  const balancesAtEnd: Record<Address, bigint> = {};
  for (const r of rows) if (r.b > 0n) balancesAtEnd[r.a] = r.b;
  const leaves: Leaf[] = rows.filter((r) => r.cum0 > 0n || r.cum1 > 0n).map((r) => [D, r.a, r.cum0.toString(), r.cum1.toString()]);
  const { rows: _rows, merkle, ...header } = index;
  const f: EpochFile = { ...header, accounts, balancesAtEnd, merkle: { root: merkle.root, leafEncoding: merkle.leafEncoding, leaves } };
  if (parts) f.parts = parts;
  return f;
}

/** The whole file from its index and the rows of every chunk (in order). */
export function assembleEpochFile(index: EpochIndex, chunkRows: Row[][] = []): EpochFile {
  if (!index.chunks.length) return fileOf(index, index.rows);
  if (chunkRows.length !== index.chunks.length) fail(`${chunkRows.length} chunks given, the index has ${index.chunks.length}`);
  return fileOf(index, chunkRows.flat());
}

/** Chunk bytes, by their sha256 or as a list. */
export type ChunkSource = ReadonlyMap<string, Uint8Array> | readonly Uint8Array[];

function chunksBySha(src: ChunkSource | null | undefined): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  if (!src) return out;
  if (Array.isArray(src)) for (const b of src as readonly Uint8Array[]) out.set(sha256Hex(b), b);
  else for (const [h, b] of src as ReadonlyMap<string, Uint8Array>) out.set(h.toLowerCase(), b);
  return out;
}

/** A chunked file read without (all of) its chunks. */
export class ChunksNeeded extends InputError {
  readonly index: EpochIndex;
  readonly missing: ChunkInfo[];
  constructor(index: EpochIndex, missing: ChunkInfo[]) {
    super(`epoch ${index.epoch} of ${index.distributor} keeps its rows in ${index.chunks.length} chunks; ${missing.length} of them were not given (readEpochFile fetches them)`);
    this.name = 'ChunksNeeded';
    this.index = index;
    this.missing = missing;
  }
}

/** Parses an epoch file into its complete value: from its index alone, or
 *  with `chunks` holding every chunk its index names (ChunksNeeded when any
 *  is missing - a chunked file never reads as one without its rows). */
export function parseEpochFile(bytes: Uint8Array, chunks?: ChunkSource): EpochFile {
  const index = parseEpochIndex(bytes);
  if (!index.chunks.length) return fileOf(index, index.rows);
  const by = chunksBySha(chunks);
  const missing = index.chunks.filter((c) => !by.has(c.sha256));
  if (missing.length) throw new ChunksNeeded(index, missing);
  return assembleEpochFile(
    index,
    index.chunks.map((c, k) => parseEpochChunk(by.get(c.sha256)!, index, k)),
  );
}

/** Reads a whole epoch file: its index from `bytes`, and every chunk it names
 *  through `fetchChunk` (each refused unless it is the one the index hashes). */
export async function readEpochFile(
  bytes: Uint8Array,
  fetchChunk: (c: ChunkInfo, k: number) => Promise<Uint8Array>,
): Promise<{ file: EpochFile; index: EpochIndex; chunks: Map<string, Uint8Array> }> {
  const index = parseEpochIndex(bytes);
  const chunks = new Map<string, Uint8Array>();
  const rows: Row[][] = [];
  for (const [k, c] of index.chunks.entries()) {
    const b = await fetchChunk(c, k);
    rows.push(parseEpochChunk(b, index, k));
    chunks.set(c.sha256, b);
  }
  return { file: assembleEpochFile(index, rows), index, chunks };
}

/** The position of the chunk whose range holds `account`, or -1 (and -1 for
 *  a file whose rows are in its index). */
export function chunkIndexOf(index: Pick<EpochHeader, 'chunks'>, account: string): number {
  const a = account.toLowerCase();
  return index.chunks.findIndex((c) => c.first <= a && a <= c.last);
}

/** The site's view of one account: the index and the one chunk whose range
 *  holds it (k = chunkIndexOf). Its rows, leaves and balances are that
 *  chunk's alone (`parts` [k]); with k < 0 (an account in no chunk's range,
 *  or none) there are none (`parts` []); for a file whose rows are in its
 *  index, the whole file. */
export function epochPart(bytes: Uint8Array, k: number, chunkBytes: Uint8Array | null): EpochFile {
  const index = parseEpochIndex(bytes);
  if (!index.chunks.length) return fileOf(index, index.rows);
  if (k < 0) return fileOf(index, [], []);
  if (!chunkBytes) fail(`chunk ${k} is needed`);
  return fileOf(index, parseEpochChunk(chunkBytes, index, k), [k]);
}

/** The tree of a file, whole or the site's part of it (built from its
 *  chunks' roots then): proofOf and multiProofFor on it prove against the
 *  file's root. */
export function treeOf(f: EpochFile): ShareTree {
  return buildTree(f.merkle.leaves, f.chunks).tree;
}

// ---------------------------------------------------------------- checking

/** What the chain says about an epoch, for verifyEpochFile. Every field is
 *  optional; the ones given are compared. */
export interface OnChainRoot {
  distributor?: string;
  epoch?: bigint;
  contentHash?: string;
  merkleRoot?: string;
  cumHolders0?: bigint;
  cumHolders1?: bigint;
  cumKeeper0?: bigint;
  fromBlock?: bigint;
  toBlock?: bigint;
}

export interface FileCheck {
  ok: boolean;
  problems: string[];
  /** The file with the rows checked: all of them, or (partial) those of the
   *  chunks given (`parts`). Null when the index does not parse. */
  file: EpochFile | null;
  contentHash: string;
  totals: { cumHolders0: bigint; cumHolders1: bigint; cumKeeper0: bigint } | null;
  /** The chunks whose rows were checked (every one for a whole check), or
   *  [] for a file whose rows are in its index. */
  checked: number[];
}

export interface VerifyParts {
  /** The chunks of a chunked file: every one, unless `partial`. */
  chunks?: ChunkSource | null;
  /** Check what the chunks given allow and leave the others: a chunk not
   *  given is then no problem (the site's check of one account's chunk). */
  partial?: boolean;
}

const ascending = (xs: string[]): boolean => xs.every((x, i) => i === 0 || xs[i - 1] < x);

/** The cumulative totals a file's leaves sum to: from its rows when they are
 *  in its index, from its chunks' sums otherwise. */
function leafTotals(f: Pick<EpochFile, 'chunks' | 'merkle'>): { h0: bigint; h1: bigint } {
  if (f.chunks.length) return { h0: f.chunks.reduce((s, c) => s + c.sum0, 0n), h1: f.chunks.reduce((s, c) => s + c.sum1, 0n) };
  return { h0: f.merkle.leaves.reduce((s, l) => s + BigInt(l[2]), 0n), h1: f.merkle.leaves.reduce((s, l) => s + BigInt(l[3]), 0n) };
}

/** Whether `account` is one a file's rows say something about: every
 *  account for a whole file, the accounts in its chunks' ranges for a part. */
function covers(f: Pick<EpochFile, 'chunks' | 'parts'>, account: string): boolean {
  if (!f.parts) return true;
  return f.parts.some((k) => f.chunks[k] && f.chunks[k].first <= account && account <= f.chunks[k].last);
}

/**
 * Checks an epoch file's bytes - its index - against the chain's root and
 * against itself, with its chunks when it has any. Never throws for a bad
 * file; every problem is listed. With `prev` (the previous active epoch's
 * file, already checked; a part of it on the site) it also checks that every
 * cumulative value is the previous one plus this epoch's share. A chunk
 * missing from `parts.chunks` is a problem unless `parts.partial`.
 */
export function verifyEpochFile(bytes: Uint8Array, chain: OnChainRoot = {}, prev: EpochFile | null = null, parts: VerifyParts = {}): FileCheck {
  const problems: string[] = [];
  const contentHash = sha256Hex(bytes);
  if (chain.contentHash !== undefined && contentHash !== chain.contentHash.toLowerCase()) {
    problems.push(`sha256 ${contentHash} is not the on-chain contentHash ${chain.contentHash}`);
  }
  let x: EpochIndex;
  try {
    x = parseEpochIndex(bytes);
  } catch (e) {
    problems.push((e as Error).message);
    return { ok: false, problems, file: null, contentHash, totals: null, checked: [] };
  }
  const D = x.distributor;
  if (chain.distributor !== undefined && D !== chain.distributor.toLowerCase()) problems.push(`file is for distributor ${D}, not ${chain.distributor}`);
  if (chain.epoch !== undefined && x.epoch !== chain.epoch) problems.push(`file is epoch ${x.epoch}, not ${chain.epoch}`);
  if (chain.fromBlock !== undefined && x.window.fromBlock !== chain.fromBlock) problems.push(`fromBlock ${x.window.fromBlock} is not the on-chain ${chain.fromBlock}`);
  if (chain.toBlock !== undefined && x.window.toBlock !== chain.toBlock) problems.push(`toBlock ${x.window.toBlock} is not the on-chain ${chain.toBlock}`);
  if (x.window.fromBlock > x.window.toBlock) problems.push('fromBlock is after toBlock');
  if (x.merkle.leafEncoding !== LEAF_ENCODING) problems.push(`leafEncoding is ${x.merkle.leafEncoding}`);
  // Every number between the active epoch and this one was vetoed (spec 1.8).
  const firstAfterActive = (x.prev ? x.prev.epoch : 0n) + 1n;
  const wantSupersedes: string[] = [];
  for (let n = firstAfterActive; n < x.epoch; n++) wantSupersedes.push(n.toString());
  if (x.prev && x.prev.epoch >= x.epoch) problems.push(`prev names epoch ${x.prev.epoch}, not before ${x.epoch}`);
  else if (canonicalJson(x.supersedes.map(String)) !== canonicalJson(wantSupersedes)) {
    problems.push(`supersedes is [${x.supersedes.join(',')}], expected [${wantSupersedes.join(',')}]`);
  }

  // Sorted, unique lists; at most MAX_KEEPER_TXS keeper transactions.
  if (!ascending(x.rules.exclusions.map((e) => e.address))) problems.push('exclusions are not sorted by address, or repeat');
  if (!ascending(x.rules.keeperKeys)) problems.push('keeperKeys are not sorted, or repeat');
  if (!ascending(x.keeper.txs.map((t) => t.hash))) problems.push('keeper txs are not sorted by hash, or repeat');
  if (x.keeper.txs.length > MAX_KEEPER_TXS) problems.push(`keeper txs name ${x.keeper.txs.length} transactions, more than the ${MAX_KEEPER_TXS} an epoch attributes`);

  // The layout: rows in the index up to one chunk's worth, in chunks of
  // exactly CHUNK_ACCOUNTS past that (the last may hold fewer), the chunks in
  // address order, the root over their roots.
  const C = BigInt(CHUNK_ACCOUNTS);
  const chunked = x.chunks.length > 0;
  if (chunked) {
    if (x.rows.length) problems.push('the index lists rows and chunks both');
    if (x.chunks.length < 2) problems.push('a file of one chunk keeps its rows in its index');
    x.chunks.forEach((c, k) => {
      const lastOne = k === x.chunks.length - 1;
      if (lastOne ? c.count < 1n || c.count > C : c.count !== C) problems.push(`chunk ${k} counts ${c.count} rows, not ${lastOne ? `1 to ${C}` : C}`);
      if (c.first > c.last || (c.count === 1n) !== (c.first === c.last)) problems.push(`chunk ${k} runs from ${c.first} to ${c.last} with ${c.count} rows`);
      if (k > 0 && !(x.chunks[k - 1].last < c.first)) problems.push(`chunk ${k} does not start after chunk ${k - 1} ends`);
    });
    const top = new ShareTree(x.chunks.map((c) => ({ first: c.first, last: c.last, root: c.root, tree: null }))).root;
    if (top !== x.merkle.root) problems.push(`the root over the chunks' roots is ${top}, not the file's root ${x.merkle.root}`);
  } else if (BigInt(x.rows.length) > C) problems.push(`the index lists ${x.rows.length} rows, more than one chunk's ${C}: they belong in chunks`);

  // The rows: the index's, or the chunks' given.
  const given = chunksBySha(parts.chunks);
  const checked: number[] = [];
  let rows: Row[] = x.rows;
  if (chunked) {
    rows = [];
    x.chunks.forEach((c, k) => {
      const b = given.get(c.sha256);
      if (!b) {
        if (!parts.partial) problems.push(`chunk ${k} (${c.first} to ${c.last}, sha256 ${c.sha256}) was not given`);
        return;
      }
      let r: Row[];
      try {
        r = parseEpochChunk(b, x, k);
      } catch (e) {
        problems.push((e as Error).message);
        return;
      }
      // its sums and its root are what the index says
      let s0 = 0n;
      let s1 = 0n;
      for (const row of r) {
        s0 += row.cum0;
        s1 += row.cum1;
      }
      if (s0 !== c.sum0 || s1 !== c.sum1) problems.push(`chunk ${k}'s rows sum to ${s0} and ${s1}, its index says ${c.sum0} and ${c.sum1}`);
      try {
        const t = buildTree(r.filter((row) => row.cum0 > 0n || row.cum1 > 0n).map((row): Leaf => [D, row.a, row.cum0.toString(), row.cum1.toString()])).tree;
        if (t.root !== c.root) problems.push(`chunk ${k}'s rows rebuild to the root ${t.root}, its index says ${c.root}`);
      } catch (e) {
        problems.push(`chunk ${k}: tree: ${(e as Error).message}`);
      }
      checked.push(k);
      rows.push(...r);
    });
  }
  const whole = !chunked || checked.length === x.chunks.length;
  const f = fileOf(x, rows, whole ? undefined : checked);

  // The state after T: the weight floor is a millionth of its supply held
  // for the whole window; the balances the rows give are part of the state
  // the commitment counts and sums.
  const st = x.stateAtEnd;
  const seconds = x.window.toTime >= x.window.fromTime ? x.window.toTime - x.window.fromTime : 0n;
  if (x.window.toTime < x.window.fromTime) problems.push('toTime is before fromTime');
  const floor = (st.supply / WEIGHT_FLOOR_DIVISOR) * seconds;
  if (x.weights.floor !== floor) problems.push(`weight floor ${x.weights.floor} is not supply / ${WEIGHT_FLOOR_DIVISOR} x ${seconds} s = ${floor}`);
  if ((st.count === 0n) !== (st.supply === 0n)) problems.push(`stateAtEnd counts ${st.count} balances summing to ${st.supply}`);
  let balSum = 0n;
  let balCount = 0n;
  for (const r of rows) {
    if (r.b === 0n) continue;
    balSum += r.b;
    balCount++;
  }
  if (balCount > st.count || balSum > st.supply) problems.push(`the rows' balances (${balCount}, summing to ${balSum}) are more than the state they are part of (${st.count}, ${st.supply})`);

  // Income, keeper fee and shares, re-derived from the file's own figures.
  const { prevCum } = x.inputs;
  const I0 = x.inputs.received0 - prevCum.h0 - prevCum.k0;
  const I1 = x.inputs.received1 - prevCum.h1;
  if (I0 < 0n || I1 < 0n) problems.push('received is below what earlier roots allocated');
  const shareSum = x.keeper.txs.reduce((s, t) => s + t.share, 0n);
  for (const t of x.keeper.txs) {
    const cost = t.gasUsed * t.price + t.l1Fee;
    if (t.share > cost) problems.push(`keeper tx ${t.hash} share is above its cost`);
  }
  if (x.keeper.price.source === 'weth' && x.keeper.price.value !== WAD) problems.push('a weth price must be 10^18');
  if (x.keeper.price.source === 'none' && x.keeper.price.value !== 0n) problems.push('a missing price must be 0');
  const Cost = (shareSum * x.keeper.price.value) / WAD;
  if (Cost !== x.keeper.cost) problems.push(`keeper cost ${x.keeper.cost} is not ${Cost} (shares x price)`);
  const cap = I0 > 0n ? (I0 * MAX_KEEPER_FEE_BPS) / BPS : 0n;
  const K0 = Cost < cap ? Cost : cap;
  const H = I0 - K0;
  const excluded = new Set(x.rules.exclusions.map((e) => e.address));
  // W covers every weighed holder, listed or not: one whose weight rounds to
  // no share is left out of the rows, its weight still in W.
  const W = x.weights.W;
  if (W === 0n) problems.push('W is 0, which is no epoch');
  let listedW = 0n;
  for (const r of rows) if (!excluded.has(r.a)) listedW += r.w;
  if (listedW > W) problems.push(`the listed weights sum to ${listedW}, more than W ${W}`);
  if (!chunked && !ascending(rows.map((r) => r.a))) problems.push('accounts are not sorted by address, or repeat');

  // The previous epoch's leaves, where `prev` (whole, or a part) knows them.
  const prevCumOf = new Map<string, [bigint, bigint]>();
  if (prev) for (const l of prev.merkle.leaves) prevCumOf.set(l[1], [BigInt(l[2]), BigInt(l[3])]);
  const prevKnows = (a: string): boolean => !!prev && covers(prev, a);
  let dH0 = 0n;
  let dH1 = 0n;
  let sum0 = 0n;
  let sum1 = 0n;
  for (const r of rows) {
    // Listed: every account with a share, and every account with an earlier
    // cumulative value; so every row has a cumulative value, and a leaf.
    if (r.cum0 === 0n && r.cum1 === 0n) problems.push(`account ${r.a} is listed with no cumulative value`);
    if (r.s0 === 0n && r.s1 === 0n && prevKnows(r.a) && !prevCumOf.has(r.a)) problems.push(`account ${r.a} is listed with no share and no earlier cumulative value`);
    if (excluded.has(r.a)) {
      if (r.w !== 0n || r.s0 !== 0n || r.s1 !== 0n) problems.push(`excluded account ${r.a} has a weight or a share`);
    } else {
      if (r.w !== 0n && r.w < x.weights.floor) problems.push(`account ${r.a} weight ${r.w} is below the floor ${x.weights.floor}`);
      const e0 = W > 0n ? (H * r.w) / W : 0n;
      const e1 = W > 0n ? (I1 * r.w) / W : 0n;
      if (r.s0 !== e0) problems.push(`account ${r.a} s0 ${r.s0} is not ${e0}`);
      if (r.s1 !== e1) problems.push(`account ${r.a} s1 ${r.s1} is not ${e1}`);
    }
    dH0 += r.s0;
    dH1 += r.s1;
    if (prevKnows(r.a)) {
      const p = prevCumOf.get(r.a) ?? [0n, 0n];
      if (r.cum0 !== p[0] + r.s0 || r.cum1 !== p[1] + r.s1) problems.push(`account ${r.a} cumulative is not the previous one plus this share`);
    } else if (!prev && (r.cum0 < r.s0 || r.cum1 < r.s1)) {
      problems.push(`account ${r.a} cumulative is below its share`);
    }
    sum0 += r.cum0;
    sum1 += r.cum1;
  }
  const listed = new Set(rows.map((r) => r.a));
  for (const a of prevCumOf.keys()) if (covers(f, a) && !listed.has(a)) problems.push(`account ${a} had a leaf and was dropped`);

  // The leaves sum to the totals; a part of the file leaves the rest to its
  // index's sums (each chunk given was checked against its own).
  const lt = leafTotals(f);
  if (whole) {
    if (sum0 !== prevCum.h0 + dH0) problems.push(`leaves sum to ${sum0} in asset 0, not ${prevCum.h0 + dH0}`);
    if (sum1 !== prevCum.h1 + dH1) problems.push(`leaves sum to ${sum1} in asset 1, not ${prevCum.h1 + dH1}`);
  } else {
    dH0 = lt.h0 - prevCum.h0;
    dH1 = lt.h1 - prevCum.h1;
  }
  let K = K0;
  if (K * BPS > (dH0 + K) * MAX_KEEPER_FEE_BPS) K = (dH0 * MAX_KEEPER_FEE_BPS) / (BPS - MAX_KEEPER_FEE_BPS);
  if (x.keeper.fee !== K) problems.push(`keeper fee ${x.keeper.fee} is not ${K}`);
  if (x.keeper.capped !== (x.keeper.fee !== x.keeper.cost)) problems.push('keeper.capped does not say whether the fee differs from the cost');
  if (x.keeper.fee * BPS > (dH0 + x.keeper.fee) * MAX_KEEPER_FEE_BPS) problems.push('keeper fee is above the on-chain 2% cap');

  // The root: from the rows when they are in the index (each chunk's was
  // checked above, and the root over them).
  if (!chunked) {
    let root = '';
    try {
      root = f.merkle.leaves.length ? buildTree(f.merkle.leaves).tree.root : '';
    } catch (e) {
      problems.push('tree: ' + (e as Error).message);
    }
    if (root !== x.merkle.root) problems.push(`rebuilt root ${root || '(none)'} is not the file's root ${x.merkle.root}`);
  }
  if (chain.merkleRoot !== undefined && x.merkle.root !== chain.merkleRoot.toLowerCase()) problems.push(`file root ${x.merkle.root} is not the on-chain root ${chain.merkleRoot}`);

  const totals = { cumHolders0: lt.h0, cumHolders1: lt.h1, cumKeeper0: prevCum.k0 + x.keeper.fee };
  if (totals.cumHolders0 + totals.cumKeeper0 > x.inputs.received0 || totals.cumHolders1 > x.inputs.received1) problems.push('allocates more than received');
  if (chain.cumHolders0 !== undefined && chain.cumHolders0 !== totals.cumHolders0) problems.push(`cumHolders0 ${totals.cumHolders0} is not the on-chain ${chain.cumHolders0}`);
  if (chain.cumHolders1 !== undefined && chain.cumHolders1 !== totals.cumHolders1) problems.push(`cumHolders1 ${totals.cumHolders1} is not the on-chain ${chain.cumHolders1}`);
  if (chain.cumKeeper0 !== undefined && chain.cumKeeper0 !== totals.cumKeeper0) problems.push(`cumKeeper0 ${totals.cumKeeper0} is not the on-chain ${chain.cumKeeper0}`);

  if (prev) {
    if (x.prev === null || x.prev.epoch !== prev.epoch) problems.push('prev does not name the previous active epoch');
    if (x.window.fromBlock !== prev.window.toBlock + 1n) problems.push('the range does not continue the previous epoch');
    const pt = { ...leafTotals(prev), k0: prev.inputs.prevCum.k0 + prev.keeper.fee };
    if (pt.h0 !== prevCum.h0 || pt.h1 !== prevCum.h1 || pt.k0 !== prevCum.k0) problems.push("prevCum is not the previous epoch's totals");
  }
  return { ok: problems.length === 0, problems, file: f, contentHash, totals, checked };
}

/** The active state a checked whole file leaves, for the next epoch (a
 *  stateless restart). `uri` is the one the chain recorded for this epoch. */
export function stateFromEpochFile(f: EpochFile, contentHash: string, uri: string): ActiveState {
  if (f.parts) throw new InputError('the state an epoch leaves needs its whole file, not a part of it');
  const cum = new Map<Address, [bigint, bigint]>();
  let h0 = 0n;
  let h1 = 0n;
  for (const l of f.merkle.leaves) {
    const c0 = BigInt(l[2]);
    const c1 = BigInt(l[3]);
    cum.set(l[1], [c0, c1]);
    h0 += c0;
    h1 += c1;
  }
  return {
    epoch: f.epoch,
    toBlock: f.window.toBlock,
    // the file lists only its own accounts' balances: the indexer rebuilds
    // the rest and checks them against stateAtEnd
    balancesAtEnd: null,
    stateAtEnd: { ...f.stateAtEnd },
    cum,
    totals: { h0, h1, k0: f.inputs.prevCum.k0 + f.keeper.fee },
    contentHash: contentHash.toLowerCase(),
    uri,
  };
}
