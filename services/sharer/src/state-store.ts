// Complete balance states between epochs: in memory, and on disk under /data.
//
// An epoch file commits to the complete state after its T (stateAtEnd: the
// count, the sha256 digest and the sum of every non-zero balance) but lists
// only its own accounts' balances, so the next epoch needs that state from
// somewhere else: the keeper's own last computation, or a replay of the
// token's whole Transfer history from its launch. A replay of a few weeks of
// a busy token takes longer than a guardian check may run, so the states are
// kept here:
//
//   - IN MEMORY, the least recently used first out, bounded by the balances
//     held in all (maxBalances) and per launch token (perToken states each),
//     so many active launches never push each other's states out;
//   - ON DISK (persistTo), one file per (chainId, token, block) under the
//     service's data directory - which the GitHub runs restore and save
//     between runs - so a restart, the standby and the scheduled verifier
//     start warm. perToken files per token are kept; the one used longest ago
//     goes first.
//
// A STATE IS USED ONLY WHEN IT IS EXACTLY THE ONE THE ACTIVE FILE COMMITS TO.
// A file read back from disk is decoded and its count, digest and sum are
// computed again and compared with the commitment asked for: a torn, stale,
// foreign or edited file is a miss, never a wrong answer (one that does not
// even match its own header is removed).
//
// ONE REBUILD AT A TIME PER STATE: `once` runs the first caller's rebuild and
// hands its outcome to every caller that asks for the same state (the same
// block and the same commitment) meanwhile; a rebuild that fails is not
// shared, and the next caller tries its own.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commitState } from './calc/share.ts';
import type { Address, StateCommitment } from './calc/types.ts';

const MAGIC = 'CURBST01';
const HEADER = 8 + 32 + 8 + 32;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

type Entry = { balances: Map<Address, bigint>; commitment: StateCommitment; token: string };

export interface StateCacheOptions {
  /** Balances held in memory over every state (the newest state is kept even when it alone is larger). */
  maxBalances?: number;
  /** States kept per (chainId, token), in memory and on disk. */
  perToken?: number;
  /** Where states are written, or null to keep them in memory only. */
  dir?: string | null;
}

const same = (a: StateCommitment, b: StateCommitment): boolean => a.digest === b.digest && a.count === b.count && a.supply === b.supply;

/** `n` big-endian in exactly `len` bytes. */
function fixed(n: bigint, len: number): Uint8Array {
  if (n < 0n || n >= 1n << BigInt(8 * len)) throw new Error(`${n} does not fit in ${len} bytes`);
  const out = new Uint8Array(len);
  let x = n;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/** `n` big-endian in as few bytes as it takes (one at least). */
function minimal(n: bigint): Uint8Array {
  let len = 1;
  while (n >= 1n << BigInt(8 * len)) len++;
  return fixed(n, len);
}

const hexOf = (b: Uint8Array, from: number, to: number): string => {
  let s = '';
  for (let i = from; i < to; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
};

/** The bytes of a state on disk: the magic, the commitment (digest, count,
 *  supply), then every non-zero balance as (20-byte address, 1-byte length,
 *  big-endian value) in address order. */
export function encodeState(balances: Map<Address, bigint>, commitment: StateCommitment): Uint8Array {
  const entries = [...balances].filter(([, b]) => b > 0n).sort((p, q) => (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : 0));
  const values = entries.map(([, b]) => minimal(b));
  if (values.some((v) => v.length > 32)) throw new Error('a balance above 2^256');
  const out = new Uint8Array(HEADER + values.reduce((s, v) => s + 21 + v.length, 0));
  out.set(new TextEncoder().encode(MAGIC), 0);
  out.set(fixed(BigInt(commitment.digest), 32), 8);
  out.set(fixed(commitment.count, 8), 40);
  out.set(fixed(commitment.supply, 32), 48);
  let at = HEADER;
  entries.forEach(([a], i) => {
    for (let j = 0; j < 20; j++) out[at + j] = parseInt(a.slice(2 + 2 * j, 4 + 2 * j), 16);
    at += 20;
    out[at++] = values[i].length;
    out.set(values[i], at);
    at += values[i].length;
  });
  return out;
}

/** The commitment a state file carries in its header, or null. */
export function stateHeader(bytes: Uint8Array): StateCommitment | null {
  if (bytes.length < HEADER || new TextDecoder().decode(bytes.subarray(0, 8)) !== MAGIC) return null;
  return { digest: '0x' + hexOf(bytes, 8, 40), count: BigInt('0x' + hexOf(bytes, 40, 48)), supply: BigInt('0x' + hexOf(bytes, 48, 80)) };
}

/** The state in `bytes`, or null when they are not one encodeState wrote. */
export function decodeState(bytes: Uint8Array): { balances: Map<Address, bigint>; commitment: StateCommitment } | null {
  const commitment = stateHeader(bytes);
  if (!commitment) return null;
  const balances = new Map<Address, bigint>();
  let at = HEADER;
  while (at < bytes.length) {
    if (at + 21 > bytes.length) return null;
    const a = '0x' + hexOf(bytes, at, at + 20);
    const n = bytes[at + 20];
    at += 21;
    if (n === 0 || n > 32 || at + n > bytes.length) return null;
    balances.set(a, BigInt('0x' + hexOf(bytes, at, at + n)));
    at += n;
  }
  return { balances, commitment };
}

/** renameSync over an existing file, tried again a few times when the
 *  target is held open for a moment (a scanner on Windows answers EPERM or
 *  EBUSY); a temporary file left behind is removed. */
function renameOver(tmp: string, p: string): void {
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, p);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= 4 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        rmSync(tmp, { force: true });
        throw e;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (i + 1));
    }
  }
}

export class StateCache {
  private readonly entries = new Map<string, Entry>();
  private readonly running = new Map<string, Promise<unknown>>();
  private held = 0;
  readonly maxBalances: number;
  readonly perToken: number;
  private dir: string | null;
  /** How many states were read back from disk. */
  diskHits = 0;

  /** `new StateCache(maxBalances, perToken)` or `new StateCache({ ... })`. */
  constructor(o: StateCacheOptions | number = {}, perToken?: number) {
    const opts: StateCacheOptions = typeof o === 'number' ? { maxBalances: o, perToken } : o;
    this.maxBalances = opts.maxBalances ?? 2_000_000;
    this.perToken = opts.perToken ?? 3;
    if (!Number.isInteger(this.perToken) || this.perToken < 1) throw new Error('perToken must be a whole number, at least 1');
    this.dir = opts.dir ?? null;
  }

  /** Writes every state from now on under `dir` too, and reads them back from
   *  there (null: memory only). The service calls this once, with its data
   *  directory, before the first epoch (ops/runner.ts). */
  persistTo(dir: string | null): void {
    this.dir = dir;
  }

  get directory(): string | null {
    return this.dir;
  }

  private tokenKey(chainId: bigint, token: Address): string {
    return `${chainId}:${token.toLowerCase()}`;
  }

  private key(chainId: bigint, token: Address, block: bigint): string {
    return `${this.tokenKey(chainId, token)}:${block}`;
  }

  /** The file of a state, or null when there is no directory (or the token is not an address). */
  pathOf(chainId: bigint, token: Address, block: bigint): string | null {
    if (!this.dir || !ADDRESS_RE.test(token.toLowerCase())) return null;
    return join(this.dir, chainId.toString(), token.toLowerCase(), `${block}.state`);
  }

  /** The complete balances after `block`, when held here and exactly the
   *  state `want` commits to; null otherwise. */
  get(chainId: bigint, token: Address, block: bigint, want: StateCommitment): Map<Address, bigint> | null {
    const k = this.key(chainId, token, block);
    const e = this.entries.get(k);
    if (e && same(e.commitment, want)) {
      this.entries.delete(k);
      this.entries.set(k, e);
      return e.balances;
    }
    const p = this.pathOf(chainId, token, block);
    if (!p || !existsSync(p)) return null;
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(readFileSync(p));
    } catch {
      return null;
    }
    // The header first: a state another file commits to is a miss without
    // decoding the rest. Then the balances themselves must BE that state.
    const head = stateHeader(bytes);
    if (head && !same(head, want)) return null;
    const got = head ? decodeState(bytes) : null;
    if (!got || !same(commitState(got.balances).commitment, want)) {
      rmSync(p, { force: true });
      return null;
    }
    this.remember(k, this.tokenKey(chainId, token), got.balances, want);
    try {
      const now = new Date();
      utimesSync(p, now, now);
    } catch {
      // the order of eviction only
    }
    this.diskHits++;
    return got.balances;
  }

  /** `commitment` must be commitState's of `balances`: callers are epoch.ts,
   *  with a state it computed or rebuilt itself. */
  put(chainId: bigint, token: Address, block: bigint, balances: Map<Address, bigint>, commitment: StateCommitment): void {
    this.remember(this.key(chainId, token, block), this.tokenKey(chainId, token), balances, commitment);
    const p = this.pathOf(chainId, token, block);
    if (!p) return;
    try {
      const d = join(p, '..');
      mkdirSync(d, { recursive: true });
      const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
      writeFileSync(tmp, encodeState(balances, commitment));
      renameOver(tmp, p);
      this.prune(d);
    } catch {
      // A state not written costs a replay later, nothing else.
    }
  }

  /** Keeps the perToken states of one token used last, by their files' time
   *  (the higher block first between two of the same time). */
  private prune(d: string): void {
    const files = readdirSync(d)
      .filter((f) => /^\d+\.state$/.test(f))
      .map((f) => ({ f, t: statSync(join(d, f)).mtimeMs, b: BigInt(f.slice(0, -6)) }))
      .sort((x, y) => (y.t !== x.t ? y.t - x.t : y.b > x.b ? 1 : y.b < x.b ? -1 : 0));
    for (const x of files.slice(this.perToken)) rmSync(join(d, x.f), { force: true });
  }

  private remember(k: string, token: string, balances: Map<Address, bigint>, commitment: StateCommitment): void {
    const old = this.entries.get(k);
    if (old) {
      this.held -= old.balances.size;
      this.entries.delete(k);
    }
    this.entries.set(k, { balances, commitment: { ...commitment }, token });
    this.held += balances.size;
    // Per token: its least recently used states beyond perToken.
    const mine = [...this.entries].filter(([, x]) => x.token === token);
    for (const [key, x] of mine.slice(0, Math.max(0, mine.length - this.perToken))) {
      this.entries.delete(key);
      this.held -= x.balances.size;
    }
    // Over all: the least recently used, until the balances fit (the newest stays).
    for (const [key, x] of this.entries) {
      if (this.entries.size <= 1 || this.held <= this.maxBalances) break;
      this.entries.delete(key);
      this.held -= x.balances.size;
    }
  }

  /** Runs `rebuild` for the state `want` at (chainId, token, block) unless
   *  one is running already, in which case its outcome is shared. A rebuild
   *  that fails is not shared: the caller after it tries its own. */
  async once<T>(chainId: bigint, token: Address, block: bigint, want: StateCommitment, rebuild: () => Promise<T>): Promise<T> {
    const k = `${this.key(chainId, token, block)}:${want.digest}:${want.count}:${want.supply}`;
    for (;;) {
      const cur = this.running.get(k);
      if (!cur) break;
      try {
        return (await cur) as T;
      } catch {
        // that caller's rebuild failed (its provider, its deadline): ours next
        if (this.running.get(k) === cur) this.running.delete(k);
      }
    }
    const p = rebuild();
    this.running.set(k, p);
    try {
      return await p;
    } finally {
      if (this.running.get(k) === p) this.running.delete(k);
    }
  }

  /** Rebuilds running now. */
  get rebuilding(): number {
    return this.running.size;
  }

  /** States held in memory. */
  get size(): number {
    return this.entries.size;
  }
}

/** The cache prepareEpoch uses unless it is given another one (or null). The
 *  service points it at its data directory (ops/runner.ts). */
export const defaultStateCache = new StateCache();
