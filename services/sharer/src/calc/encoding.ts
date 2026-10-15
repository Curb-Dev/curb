// Encodings the CURB-SHARE v1 file and tree depend on: RFC 8785 canonical
// JSON, sha256, keccak256, the on-chain leaf, the transfers digest and the
// balances digest.
//
// Browser-safe: no Node built-ins, no Buffer. The web verify panel loads this
// file through the ESM bundle (browser/curb-share.mjs).

import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import type { Hex, TransferLog } from './types.ts';

/** RFC 8785 canonical JSON for the values this spec uses. Integers are
 *  BigInts and are written as decimal strings; plain JS numbers (and
 *  undefined, functions, symbols) are refused, so no number formatting
 *  question can arise. Keys sort by UTF-16 code units, which is what
 *  Array.prototype.sort does for strings. Strings are escaped as
 *  JSON.stringify does, which is the RFC 8785 escaping. */
export function canonicalJson(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'bigint') return JSON.stringify(v.toString());
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k])).join(',') + '}';
  }
  throw new Error(`canonical JSON: value of type ${typeof v} is not allowed: ${String(v)}`);
}

export function canonicalBytes(v: unknown): Uint8Array {
  return utf8ToBytes(canonicalJson(v));
}

export function utf8(s: string): Uint8Array {
  return utf8ToBytes(s);
}

export function utf8Decode(b: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(b);
}

export function sha256Hex(bytes: Uint8Array): Hex {
  return ('0x' + bytesToHex(sha256(bytes))) as Hex;
}

/** keccak256 of the bytes written as hex (with or without 0x). */
export function keccakHex(hex: string): Hex {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  return ('0x' + bytesToHex(keccak_256(hexToBytes(h)))) as Hex;
}

const MAX_UINT256 = (1n << 256n) - 1n;

export function word(n: bigint): string {
  if (n < 0n || n > MAX_UINT256) throw new Error('uint256 out of range: ' + n);
  return n.toString(16).padStart(64, '0');
}

export function addressWord(a: string): string {
  return a.slice(2).toLowerCase().padStart(64, '0');
}

/** The leaf the distributor computes on chain:
 *  keccak256(bytes.concat(keccak256(abi.encode(distributor, account, cum0, cum1)))) */
export function leafHash(distributor: string, account: string, cum0: bigint | string, cum1: bigint | string): Hex {
  const enc = addressWord(distributor) + addressWord(account) + word(BigInt(cum0)) + word(BigInt(cum1));
  return keccakHex(keccakHex(enc));
}

const NIBBLE = new Int8Array(128).fill(-1);
for (let i = 0; i < 16; i++) {
  NIBBLE['0123456789abcdef'.charCodeAt(i)] = i;
  NIBBLE['0123456789ABCDEF'.charCodeAt(i)] = i;
}

/**
 * A hash over 32-byte words written as hex, record by record, fed in
 * chunks: the digests below cover hundreds of thousands of records on a
 * sprayed launch, so they are never built as one string. The bytes hashed
 * are exactly the concatenation of the words.
 */
class WordHasher {
  private readonly h: ReturnType<typeof keccak_256.create> | ReturnType<typeof sha256.create>;
  private readonly buf = new Uint8Array(1 << 20);
  private n = 0;

  constructor(hash: 'keccak256' | 'sha256') {
    this.h = hash === 'keccak256' ? keccak_256.create() : sha256.create();
  }

  /** One 64-character hex word. */
  word(hex: string): void {
    if (hex.length !== 64) throw new Error('not a 32-byte word: ' + hex);
    if (this.n + 32 > this.buf.length) this.flush();
    for (let i = 0; i < 64; i += 2) {
      const hi = NIBBLE[hex.charCodeAt(i)];
      const lo = NIBBLE[hex.charCodeAt(i + 1)];
      if (hi === undefined || lo === undefined || hi < 0 || lo < 0) throw new Error('not hex: ' + hex);
      this.buf[this.n++] = (hi << 4) | lo;
    }
  }

  private flush(): void {
    this.h.update(this.buf.subarray(0, this.n));
    this.n = 0;
  }

  digest(): Hex {
    this.flush();
    return ('0x' + bytesToHex(this.h.digest())) as Hex;
  }
}

/** sha256 of abi.encode(address, balance) for every entry, concatenated in
 *  the order given - the epoch file's `stateAtEnd.digest` over every
 *  non-zero balance after T, in address order (spec 2). sha256, as for the
 *  file itself: nothing checks it on chain, and it hashes a sprayed state
 *  of hundreds of thousands of balances many times faster than keccak256. */
export function balancesDigest(entries: Iterable<readonly [string, bigint]>): Hex {
  const h = new WordHasher('sha256');
  for (const [a, b] of entries) {
    h.word(addressWord(a));
    h.word(word(b));
  }
  return h.digest();
}

/** keccak256 of abi.encode(block, logIndex, from, to, value) for every
 *  replayed Transfer log, concatenated in (block, logIndex) order. */
export function transfersDigest(transfers: readonly TransferLog[]): Hex {
  const h = new WordHasher('keccak256');
  for (const t of transfers) {
    h.word(word(t.block));
    h.word(word(t.logIndex));
    h.word(addressWord(t.from));
    h.word(addressWord(t.to));
    h.word(word(t.value));
  }
  return h.digest();
}
