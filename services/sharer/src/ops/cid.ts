// The IPFS address of an epoch file, computed before anything is uploaded:
// exactly the CID Kubo's `ipfs add --cid-version=1 --raw-leaves
// --chunker=size-262144` gives the bytes (the defaults of a CIDv1 add, which
// hosted pinning services use too). A file of one chunk (<= 256 KiB) is a
// single raw block, so its CID's digest IS the sha256 the chain holds; a
// larger one is a UnixFS file: raw leaves of 256 KiB under dag-pb nodes of at
// most 174 links, balanced. Pinners are asked to store it that way and their
// answer must be exactly this CID (pinners.ts); every copy fetched back is
// checked by its sha256 against the chain anyway (files.ts).
//
// test/ops-units.test.ts pins this against CIDs a real Kubo (v0.43.0)
// computed for files from 1 byte to 46 MB (two levels of nodes).

import { sha256 } from '@noble/hashes/sha2';

export const CHUNK = 262_144;
export const MAX_LINKS = 174;
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
const RAW = 0x55;
const DAG_PB = 0x70;

export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function sha256Bytes(bytes: Uint8Array): Uint8Array {
  return sha256(bytes);
}

export function hexOf(b: Uint8Array): string {
  return '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function varint(n: number): number[] {
  const out: number[] = [];
  let x = n;
  do {
    let b = x % 128;
    x = Math.floor(x / 128);
    if (x > 0) b |= 0x80;
    out.push(b);
  } while (x > 0);
  return out;
}

const key = (no: number, wire: number): number[] => varint(no * 8 + wire);
const lenField = (no: number, b: ArrayLike<number>): number[] => [...key(no, 2), ...varint(b.length), ...Array.from(b)];
const intField = (no: number, n: number): number[] => [...key(no, 0), ...varint(n)];

/** CIDv1 bytes: version, codec, sha2-256 multihash. */
function cidBytes(codec: number, digest: Uint8Array): Uint8Array {
  return Uint8Array.from([0x01, ...varint(codec), 0x12, 0x20, ...digest]);
}

interface Node {
  cid: Uint8Array;
  /** Bytes of this block and everything under it (a link's Tsize). */
  tsize: number;
  /** File bytes under it. */
  fileSize: number;
}

function leaf(b: Uint8Array): Node {
  return { cid: cidBytes(RAW, sha256(b)), tsize: b.length, fileSize: b.length };
}

/** A dag-pb node over `children`: links first (field 2: Hash, Name "",
 *  Tsize), then the UnixFS Data (field 1: Type File, filesize, blocksizes). */
function parent(children: Node[]): Node {
  const fileSize = children.reduce((x, c) => x + c.fileSize, 0);
  const data = [...intField(1, 2), ...intField(3, fileSize), ...children.flatMap((c) => intField(4, c.fileSize))];
  const links = children.flatMap((c) => lenField(2, [...lenField(1, c.cid), ...lenField(2, []), ...intField(3, c.tsize)]));
  const block = Uint8Array.from([...links, ...lenField(1, data)]);
  return { cid: cidBytes(DAG_PB, sha256(block)), tsize: block.length + children.reduce((x, c) => x + c.tsize, 0), fileSize };
}

/** The CID Kubo adds `bytes` under (CIDv1, raw leaves, 256 KiB chunks, balanced). */
export function fileCid(bytes: Uint8Array): string {
  if (bytes.length <= CHUNK) return 'b' + base32(leaf(bytes).cid);
  let level: Node[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) level.push(leaf(bytes.subarray(i, i + CHUNK)));
  while (level.length > 1) {
    const next: Node[] = [];
    for (let i = 0; i < level.length; i += MAX_LINKS) next.push(parent(level.slice(i, i + MAX_LINKS)));
    level = next;
  }
  return 'b' + base32(level[0].cid);
}

/** CIDv1 of a raw block with this sha256 digest. */
export function cidOfDigest(digest: Uint8Array): string {
  if (digest.length !== 32) throw new Error('a sha2-256 digest is 32 bytes');
  return 'b' + base32(cidBytes(RAW, digest));
}

/** The sha256 a raw-block CID commits to, or null for any other CID. */
export function digestOfRawCid(cid: string): string | null {
  if (!/^b[a-z2-7]+$/.test(cid)) return null;
  const s = cid.slice(1);
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s) {
    const v = B32.indexOf(ch);
    if (v < 0) return null;
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (out.length !== 36 || out[0] !== 1 || out[1] !== RAW || out[2] !== 0x12 || out[3] !== 0x20) return null;
  return hexOf(new Uint8Array(out.slice(4)));
}

export function ipfsUri(cid: string): string {
  return `ipfs://${cid}`;
}

export function cidOfUri(uri: string): string | null {
  const m = /^ipfs:\/\/([a-zA-Z0-9]+)$/.exec(uri);
  return m ? m[1] : null;
}
