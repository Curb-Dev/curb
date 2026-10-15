// The service's own state under /data: a speed-up and a memory, never the
// source of truth. Everything a decision rests on is re-read from the chain
// and the published files; what lives here is what the chain cannot say -
// the keeper's journal of the transactions it sent (reverted ones log
// nothing), alert de-duplication, the last block scanned for events, the
// epoch files already checked against their on-chain hash. Losing it costs
// time and the gas of reverted transactions in one keeper fee, nothing else.
//
// One JSON document (state.json) written atomically (temporary file, then
// rename), plus a file cache. A Store with no directory keeps everything in
// memory (a GitHub Actions run with a cold cache, the tests).

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, normalize, isAbsolute } from 'node:path';

const BIG = '__big';

export function toJson(v: unknown, space?: number): string {
  return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? { [BIG]: x.toString() } : x instanceof Map ? Object.fromEntries(x) : x), space);
}

export function fromJson<T = unknown>(s: string): T {
  return JSON.parse(s, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length === 1 && typeof x[BIG] === 'string' ? BigInt(x[BIG]) : x)) as T;
}

export class Store {
  readonly dir: string | null;
  private doc: Record<string, unknown>;
  private readonly mem = new Map<string, Uint8Array>();

  constructor(dir: string | null) {
    this.dir = dir;
    this.doc = {};
    if (dir) {
      mkdirSync(dir, { recursive: true });
      const p = join(dir, 'state.json');
      if (existsSync(p)) {
        try {
          this.doc = fromJson<Record<string, unknown>>(readFileSync(p, 'utf8'));
        } catch {
          // A torn or foreign file: start empty (the state is a cache), keep the bad one aside.
          renameSync(p, p + '.bad-' + Date.now());
          this.doc = {};
        }
      }
    }
  }

  get<T>(key: string, dflt?: T): T {
    const v = Object.hasOwn(this.doc, key) ? this.doc[key] : undefined;
    return (v === undefined ? dflt : v) as T;
  }

  delete(key: string): void {
    delete this.doc[key];
  }

  set(key: string, value: unknown): void {
    this.doc[key] = value;
  }

  /** Updates a keyed object in place and returns it. */
  update<T extends object>(key: string, dflt: T, f: (v: T) => void): T {
    const v = this.get<T>(key, dflt);
    f(v);
    this.doc[key] = v;
    return v;
  }

  flush(): void {
    if (!this.dir) return;
    const p = join(this.dir, 'state.json');
    writeAtomic(p, toJson(this.doc, 1));
  }

  private path(rel: string): string {
    const n = normalize(rel).replace(/\\/g, '/');
    if (isAbsolute(n) || n.startsWith('..') || n.includes('/../')) throw new Error(`bad store path ${rel}`);
    return join(this.dir!, n);
  }

  readFile(rel: string): Uint8Array | null {
    if (!this.dir) return this.mem.get(rel) ?? null;
    const p = this.path(rel);
    return existsSync(p) ? new Uint8Array(readFileSync(p)) : null;
  }

  writeFile(rel: string, bytes: Uint8Array | string): void {
    const b = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
    if (!this.dir) {
      this.mem.set(rel, b);
      return;
    }
    writeAtomic(this.path(rel), b);
  }

  removeFile(rel: string): void {
    if (!this.dir) {
      this.mem.delete(rel);
      return;
    }
    rmSync(this.path(rel), { force: true });
  }
}

export function writeAtomic(p: string, data: string | Uint8Array): void {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, data);
  renameSync(tmp, p);
}
