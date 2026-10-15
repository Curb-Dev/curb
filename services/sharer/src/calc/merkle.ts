// The distributor's Merkle tree, in two levels (spec 1.7):
//
//   - the leaves, [distributor, account, cum0, cum1] in account order, go in
//     chunks of CHUNK_ACCOUNTS consecutive accounts (the last chunk may hold
//     fewer); each chunk is an OpenZeppelin StandardMerkleTree with the
//     default options (leaves sorted by hash, sorted-pair hashing);
//   - the root is that chunk's root when there is one chunk - so a launch
//     with at most CHUNK_ACCOUNTS accounts has exactly the StandardMerkleTree
//     of all its leaves - and otherwise the root of an OpenZeppelin
//     SimpleMerkleTree over the chunk roots (sorted, sorted-pair hashing).
//
// Every node is a sorted-pair keccak256, so a proof is the chunk's proof
// followed by the chunk root's, and the distributor's MerkleProof.verify
// takes it as it is. A multiproof is made within one chunk, its root carried
// up by the top's proof; push() takes it as it is too. A reader that holds
// the index (every chunk root) and one chunk proves any leaf of that chunk
// without the others.
//
// THE LAYOUT IS OPENZEPPELIN'S, BUILT HERE. The library's StandardMerkleTree
// takes about 0.35 ms a leaf (it ABI-encodes every value through a generic
// coder); a launch with a quarter of a million accounts would take 85 s a
// tree, and a guardian check builds two. OzTree is core.js's makeMerkleTree,
// getProof and getMultiProof over the leaf hashes encoding.ts computes, node
// for node; the tests hold it to the library on every vector and on random
// sets, and the reference builds its trees with the library itself.
//
// Proofs are rebuilt from the epoch file's rows; the file carries no tree dump.

import { SimpleMerkleTree, StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { keccakHex, leafHash } from './encoding.ts';
import type { Address, ChunkInfo, Leaf } from './types.ts';

export const LEAF_TYPES = ['address', 'address', 'uint256', 'uint256'];
export const LEAF_ENCODING = LEAF_TYPES.join(',');
/** The accounts one chunk holds (spec 2): an epoch file whose rows fit in
 *  one chunk carries them itself; past that, each chunk is a file of its
 *  own, of about 120 KiB with the amounts a launch has (at most 256 KiB, one
 *  IPFS block, unless its amounts are far beyond any supply). */
export const CHUNK_ACCOUNTS = 512;

/** OpenZeppelin's standardNodeHash: keccak256 of the two children, the
 *  smaller first. Hashes are lowercase 0x hex of 32 bytes, so comparing the
 *  strings compares the bytes. */
const nodeHash = (a: string, b: string): string => (a <= b ? keccakHex(a.slice(2) + b.slice(2)) : keccakHex(b.slice(2) + a.slice(2)));

/**
 * OpenZeppelin's tree over values whose hashes are given (core.js): the
 * hashes sorted, placed at the end of a 2n-1 array in reverse, each parent
 * the node hash of its two children. With the leaf hashes of
 * [D, account, cum0, cum1] it is the StandardMerkleTree of those leaves;
 * with the values themselves as hashes, the SimpleMerkleTree of them.
 */
class OzTree<V> {
  readonly nodes: string[];
  readonly root: string;
  /** The values with their tree positions. */
  private readonly at = new Map<string, { value: V; i: number }>();

  /** `key` names each value uniquely (an account, a chunk root). */
  constructor(items: { value: V; hash: string; key: string }[]) {
    if (!items.length) throw new Error('a tree of no leaves');
    const sorted = [...items].sort((x, y) => (x.hash < y.hash ? -1 : x.hash > y.hash ? 1 : 0));
    const n = sorted.length;
    this.nodes = new Array<string>(2 * n - 1);
    sorted.forEach((x, i) => {
      const pos = this.nodes.length - 1 - i;
      this.nodes[pos] = x.hash;
      if (this.at.has(x.key)) throw new Error(`two leaves for ${x.key}`);
      this.at.set(x.key, { value: x.value, i: pos });
    });
    for (let i = this.nodes.length - 1 - n; i >= 0; i--) this.nodes[i] = nodeHash(this.nodes[2 * i + 1], this.nodes[2 * i + 2]);
    this.root = this.nodes[0];
  }

  has(key: string): boolean {
    return this.at.has(key);
  }

  value(key: string): V | undefined {
    return this.at.get(key)?.value;
  }

  /** core.js getProof: the siblings from the leaf up. */
  proof(key: string): string[] {
    const e = this.at.get(key);
    if (!e) throw new Error(`no leaf for ${key}`);
    const out: string[] = [];
    for (let i = e.i; i > 0; i = Math.floor((i - 1) / 2)) out.push(this.nodes[i % 2 === 1 ? i + 1 : i - 1]);
    return out;
  }

  /** core.js getMultiProof: the values in the order the proof consumes them
   *  (tree positions descending), the proof, and the flags. */
  multiProof(keys: string[]): { values: V[]; proof: string[]; flags: boolean[] } {
    const indices = keys.map((k) => {
      const e = this.at.get(k);
      if (!e) throw new Error(`no leaf for ${k}`);
      return e.i;
    });
    indices.sort((a, b) => b - a);
    for (let p = 1; p < indices.length; p++) if (indices[p] === indices[p - 1]) throw new Error('cannot prove a leaf twice');
    const stack = [...indices];
    const proof: string[] = [];
    const flags: boolean[] = [];
    while (stack.length > 0 && stack[0] > 0) {
      const j = stack.shift()!;
      const s = j % 2 === 1 ? j + 1 : j - 1;
      const p = Math.floor((j - 1) / 2);
      if (s === stack[0]) {
        flags.push(true);
        stack.shift();
      } else {
        flags.push(false);
        proof.push(this.nodes[s]);
      }
      stack.push(p);
    }
    if (indices.length === 0) proof.push(this.nodes[0]);
    const byPos = new Map<number, V>();
    for (const e of this.at.values()) byPos.set(e.i, e.value);
    return { values: indices.map((i) => byPos.get(i)!), proof, flags };
  }
}

interface Chunk {
  first: Address;
  last: Address;
  root: string;
  /** Null when this tree was built from an index and that chunk's leaves were not given. */
  tree: OzTree<Leaf> | null;
}

/** The tree of one epoch: its chunks and, past one chunk, the top over their roots. */
export class ShareTree {
  readonly root: string;
  readonly chunks: readonly Chunk[];
  private readonly top: OzTree<string> | null;

  constructor(chunks: Chunk[]) {
    this.chunks = chunks;
    this.top = chunks.length > 1 ? new OzTree(chunks.map((c) => ({ value: c.root, hash: c.root, key: c.root }))) : null;
    this.root = this.top ? this.top.root : chunks.length ? chunks[0].root : '';
  }

  /** The position of the chunk whose range holds `account` (it may still have
   *  no leaf for it), or -1. */
  chunkOf(account: string): number {
    const a = account.toLowerCase();
    return this.chunks.findIndex((c) => c.first <= a && a <= c.last);
  }

  /** The proof that carries chunk k's root to the root. */
  topProof(k: number): string[] {
    return this.top ? this.top.proof(this.chunks[k].root) : [];
  }

  /** Whether a claim proof of `leaf` proves against this root. */
  verify(leaf: Leaf, proof: readonly string[]): boolean {
    return verifyProof(this.root, leafHash(leaf[0], leaf[1], leaf[2], leaf[3]), proof);
  }

  /** Whether a push multiproof proves against this root (as
   *  StandardMerkleTree's own verifyMultiProof, on the two-level tree). */
  verifyMultiProof(mp: { leaves: Leaf[]; proof: readonly string[]; proofFlags: readonly boolean[] }): boolean {
    return verifyMultiProof(this.root, mp.leaves.map((l) => leafHash(l[0], l[1], l[2], l[3])), mp.proof, mp.proofFlags);
  }
}

const byAccount = (x: Leaf, y: Leaf): number => (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0);

/** One chunk's tree; each leaf hash is the on-chain encoding (encoding.ts). */
function chunkTree(leaves: Leaf[]): { tree: OzTree<Leaf>; hashes: Map<Leaf, string> } {
  const hashes = new Map<Leaf, string>();
  const items = leaves.map((l) => {
    const h = leafHash(l[0], l[1], l[2], l[3]);
    hashes.set(l, h);
    return { value: l, hash: h, key: l[1].toLowerCase() };
  });
  return { tree: new OzTree(items), hashes };
}

/**
 * Builds the tree of an epoch from its leaves. Without `chunks` the leaves
 * are all of them, and the chunks are cut from their account order. With
 * `chunks` (an index's descriptors) the top is built from the roots the
 * index gives, and the leaves may be those of some chunks only: each chunk
 * that has any must have all of them, and their root must be the one the
 * index gives. `leafHashes` follow the order of `leaves`.
 */
export function buildTree(leaves: Leaf[], chunks?: readonly ChunkInfo[]): { tree: ShareTree; leafHashes: string[] } {
  const sorted = [...leaves].sort(byAccount);
  for (let i = 1; i < sorted.length; i++) if (sorted[i][1] === sorted[i - 1][1]) throw new Error(`two leaves for ${sorted[i][1]}`);
  const hashOf = new Map<Leaf, string>();
  const built: Chunk[] = [];
  if (!chunks || chunks.length === 0) {
    for (let i = 0; i < sorted.length; i += CHUNK_ACCOUNTS) {
      const part = sorted.slice(i, i + CHUNK_ACCOUNTS);
      const { tree, hashes } = chunkTree(part);
      for (const [l, h] of hashes) hashOf.set(l, h);
      built.push({ first: part[0][1], last: part[part.length - 1][1], root: tree.root, tree });
    }
    if (chunks && chunks.length === 0 && built.length > 1) throw new Error(`${sorted.length} leaves do not fit in one chunk, and the index names none`);
  } else {
    let i = 0;
    for (const c of chunks) {
      const part: Leaf[] = [];
      if (i < sorted.length && sorted[i][1] < c.first) throw new Error(`leaf ${sorted[i][1]} is in no chunk of the index`);
      while (i < sorted.length && sorted[i][1] <= c.last) part.push(sorted[i++]);
      if (!part.length) {
        built.push({ first: c.first, last: c.last, root: c.root, tree: null });
        continue;
      }
      if (BigInt(part.length) !== c.count) throw new Error(`chunk ${c.first}..${c.last} has ${part.length} leaves here, the index counts ${c.count}`);
      const { tree, hashes } = chunkTree(part);
      if (tree.root !== c.root) throw new Error(`chunk ${c.first}..${c.last} rebuilds to ${tree.root}, the index says ${c.root}`);
      for (const [l, h] of hashes) hashOf.set(l, h);
      built.push({ first: c.first, last: c.last, root: c.root, tree });
    }
    if (i < sorted.length) throw new Error(`leaf ${sorted[i][1]} is in no chunk of the index`);
  }
  return { tree: new ShareTree(built), leafHashes: leaves.map((l) => hashOf.get(l)!) };
}

export interface ClaimProof {
  account: Address;
  cum0: bigint;
  cum1: bigint;
  proof: string[];
}

/** The proof `claim(cum0, cum1, proof, to)` takes for one account, or null
 *  when the account has no leaf. Throws when the account's chunk was not
 *  given (a tree built from an index and other chunks). */
export function proofOf(tree: ShareTree, account: string): ClaimProof | null {
  const want = account.toLowerCase();
  const k = tree.chunkOf(want);
  if (k < 0) return null;
  const t = tree.chunks[k].tree;
  if (!t) throw new Error(`the chunk that would hold ${want} was not given`);
  const v = t.value(want);
  if (!v) return null;
  return { account: want, cum0: BigInt(v[2]), cum1: BigInt(v[3]), proof: [...t.proof(want), ...tree.topProof(k)] };
}

export interface PushBatch {
  /** In the order MerkleProof.multiProofVerify consumes them. */
  leaves: { account: Address; cum0: bigint; cum1: bigint }[];
  proof: string[];
  flags: boolean[];
}

/** The multiproof `push(leaves, proof, flags)` takes for a set of accounts,
 *  all of one chunk (ShareTree.chunkOf): the chunk's multiproof, then the
 *  steps that carry its root up to the root (each with a proof element).
 *  Accounts without a leaf, or in two chunks, are refused. */
export function multiProofFor(tree: ShareTree, accounts: string[]): PushBatch {
  const ks = new Set(accounts.map((a) => tree.chunkOf(a)));
  const missing = accounts.find((a) => {
    const k = tree.chunkOf(a);
    return k < 0 || (tree.chunks[k].tree !== null && !tree.chunks[k].tree!.has(a.toLowerCase()));
  });
  if (missing) throw new Error(`no leaf for ${missing}`);
  if (ks.size > 1) throw new Error(`the accounts are in ${ks.size} chunks of the tree: one push proves the accounts of one chunk (group them by chunkOf)`);
  const [k] = ks;
  const t = tree.chunks[k]?.tree;
  if (!t) throw new Error('the chunk of these accounts was not given');
  const mp = t.multiProof(accounts.map((a) => a.toLowerCase()));
  const up = tree.topProof(k);
  return {
    leaves: mp.values.map((v) => ({ account: v[1].toLowerCase(), cum0: BigInt(v[2]), cum1: BigInt(v[3]) })),
    proof: [...mp.proof, ...up],
    flags: [...mp.flags, ...up.map(() => false)],
  };
}

/** Checks a claim proof against a root without the library (sorted-pair
 *  keccak), as MerkleProof.verify does on chain. */
export function verifyProof(root: string, leaf: string, proof: readonly string[]): boolean {
  let h = leaf.toLowerCase();
  for (const p of proof) h = nodeHash(h, p.toLowerCase());
  return h === root.toLowerCase();
}

/** Checks a push multiproof against a root without the library, as
 *  MerkleProof.multiProofVerify does on chain (the queue of leaves, then of
 *  hashes; a proof element where a flag is false). */
export function verifyMultiProof(root: string, leafHashes: readonly string[], proof: readonly string[], flags: readonly boolean[]): boolean {
  if (leafHashes.length + proof.length !== flags.length + 1) return false;
  const hashes: string[] = [];
  let li = 0;
  let hi = 0;
  let pi = 0;
  const next = (): string | undefined => (li < leafHashes.length ? leafHashes[li++].toLowerCase() : hashes[hi++]);
  for (const f of flags) {
    const a = next();
    const b = f ? next() : proof[pi++]?.toLowerCase();
    if (a === undefined || b === undefined) return false;
    hashes.push(nodeHash(a, b));
  }
  if (pi !== proof.length) return false;
  const got = flags.length ? hashes[flags.length - 1] : leafHashes.length ? leafHashes[0].toLowerCase() : proof[0]?.toLowerCase();
  return got === root.toLowerCase();
}

export { StandardMerkleTree, SimpleMerkleTree };
