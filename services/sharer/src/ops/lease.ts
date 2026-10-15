// Only one keeper writes at a time (design D.2.9).
//
// THE LEASE is ops/lease.json in the data repo: {holder, role, takenAt,
// expiresAt}. It is taken and renewed by compare-and-swap on the blob sha
// the contents API returns - a write against a sha that moved on is refused
// with 409 - so two keepers racing for it cannot both win. A keeper holds it
// only while it acts (sends transactions or writes files), with a TTL
// (default 10 minutes) it renews between steps, and releases it after.
//
// ANOTHER HOLDER CAN ONLY KEEP IT FOR SO LONG. Whoever can write the data
// repo can also write a lease that never expires, or keep renewing one, and
// every keeper write then stops. So a keeper refused by another holder for
// longer than one standby run plus the TTL (lease.blockedAfterSec) counts its
// ticks as failing, names that holder and pages (keeper.ts).
//
// THE HEARTBEAT is ops/status.json, written by the primary (the VPS) every
// heartbeatEverySec, and at once when its ticks start or stop failing. It
// carries lastOkAt, the last tick that finished cleanly. The standby (GitHub
// Actions) acts only when the heartbeat OR that last clean tick is older than
// standbyAfterSec (45 minutes) AND it can take the lease: a primary that
// beats while every tick fails (one RPC provider down, say) pays nobody, so
// it counts as silent. On-chain idempotency is the backstop if both ever
// act: a second publish of the same epoch reverts (PendingRoot / WrongEpoch),
// a second push of a paid leaf pays nothing.
//
// ops/status-standby.json is the standby's report while it acts, and
// ops/status-guardian.json the guardian's heartbeat (when it holds a data
// repo token), signed with its vetoer key (liveness.ts); the verifiers read
// all three and page when they go stale.

import type { DataRepo } from './github.ts';
import { Conflict } from './github.ts';
import type { Logger } from './log.ts';

export const LEASE_PATH = 'ops/lease.json';
export const STATUS_PATH = 'ops/status.json';
export const STANDBY_STATUS_PATH = 'ops/status-standby.json';
export const GUARDIAN_STATUS_PATH = 'ops/status-guardian.json';

export interface LeaseDoc {
  schema: 'curb.sharing.lease/1';
  holder: string;
  role: 'primary' | 'standby';
  takenAt: number;
  expiresAt: number;
}

const enc = (x: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(x, null, 1) + '\n');

function parseLease(b: Uint8Array): LeaseDoc | null {
  try {
    const j = JSON.parse(new TextDecoder().decode(b));
    if (j && j.schema === 'curb.sharing.lease/1' && typeof j.holder === 'string' && typeof j.expiresAt === 'number') return j as LeaseDoc;
  } catch {
    // unreadable: treated as free, and replaced through the same CAS
  }
  return null;
}

export interface LeaseOptions {
  repo: DataRepo | null;
  holder: string;
  role: 'primary' | 'standby';
  ttlSec: number;
  log: Logger;
  /** Wall clock in milliseconds. */
  now?: () => number;
}

export class Lease {
  private readonly o: LeaseOptions;
  private readonly now: () => number;
  held = false;
  /** Seconds (wall clock) until which the held lease is valid. */
  until = 0;
  /** The other holder whose unexpired lease refused this one last, as the
   *  file named it (the keeper reports who keeps it out, and since when). */
  other: { holder: string; role: string; expiresAt: number } | null = null;

  constructor(o: LeaseOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
  }

  get shared(): boolean {
    return this.o.repo !== null;
  }

  /** Takes the lease, or renews it when this holder has it. False when
   *  somebody else holds an unexpired lease, or won the race for it. */
  async acquire(): Promise<boolean> {
    const repo = this.o.repo;
    if (!repo) {
      // No data repo: nothing to share a lease through (a local run).
      this.held = true;
      this.until = Math.floor(this.now() / 1000) + this.o.ttlSec;
      return true;
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      const cur = await repo.get(LEASE_PATH);
      const doc = cur ? parseLease(cur.bytes) : null;
      const nowS = Math.floor(this.now() / 1000);
      if (doc && doc.holder !== this.o.holder && doc.expiresAt > nowS) {
        this.o.log.info('the lease is held by another keeper', { holder: doc.holder, role: doc.role, expiresIn: doc.expiresAt - nowS });
        this.held = false;
        this.other = { holder: doc.holder, role: String(doc.role), expiresAt: doc.expiresAt };
        return false;
      }
      const next: LeaseDoc = {
        schema: 'curb.sharing.lease/1',
        holder: this.o.holder,
        role: this.o.role,
        takenAt: doc && doc.holder === this.o.holder ? doc.takenAt : nowS,
        expiresAt: nowS + this.o.ttlSec,
      };
      try {
        await repo.put(LEASE_PATH, enc(next), `lease: ${this.o.holder} until ${next.expiresAt}`, cur ? cur.sha : null);
        this.held = true;
        this.until = next.expiresAt;
        return true;
      } catch (e) {
        if (!(e instanceof Conflict)) throw e;
        this.o.log.info('lost a race for the lease; reading it again');
      }
    }
    this.held = false;
    return false;
  }

  /** Renews a held lease when less than half its TTL is left. */
  async keep(): Promise<boolean> {
    if (!this.held) return false;
    const nowS = Math.floor(this.now() / 1000);
    if (this.until - nowS > this.o.ttlSec / 2) return true;
    return this.acquire();
  }

  /** True while the held lease is still valid by the clock. */
  valid(): boolean {
    return this.held && Math.floor(this.now() / 1000) < this.until;
  }

  async release(): Promise<void> {
    const repo = this.o.repo;
    if (!this.held) return;
    this.held = false;
    if (!repo) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      const cur = await repo.get(LEASE_PATH);
      const doc = cur ? parseLease(cur.bytes) : null;
      if (!cur || !doc || doc.holder !== this.o.holder) return; // not ours any more
      try {
        await repo.put(LEASE_PATH, enc({ ...doc, expiresAt: 0 }), `lease: ${this.o.holder} released`, cur.sha);
        return;
      } catch (e) {
        if (!(e instanceof Conflict)) throw e;
      }
    }
  }
}

export interface Heartbeat {
  role: string;
  holder: string;
  heartbeatAt: number;
  /** The last tick that finished cleanly; null when none has yet. */
  lastOkAt?: number | null;
  /** Since when every tick has failed; null while they finish cleanly. */
  failingSince?: number | null;
  errors?: string[];
}

/** A heartbeat document of `role`, or null when it is absent or unreadable. */
export function parseBeat(b: Uint8Array | null, role: string): Heartbeat | null {
  if (!b) return null;
  try {
    const j = JSON.parse(new TextDecoder().decode(b));
    if (j && j.role === role && typeof j.heartbeatAt === 'number') return j as Heartbeat;
  } catch {
    // unreadable
  }
  return null;
}

/** Seconds since the beat's last CLEAN tick: lastOkAt, or the start of a
 *  failing streak that never had one, or - a beat from before lastOkAt
 *  existed - the beat itself. Infinity when there is no beat. */
export function cleanAgeOf(beat: Heartbeat | null, nowS: number): number {
  if (!beat) return Infinity;
  const at = typeof beat.lastOkAt === 'number' ? beat.lastOkAt : typeof beat.failingSince === 'number' ? beat.failingSince : beat.heartbeatAt;
  return nowS - at;
}

/** The primary's heartbeat age and the age of its last clean tick, in
 *  seconds; Infinity when there is no heartbeat. */
export async function primaryHeartbeatAge(repo: DataRepo, now: () => number = Date.now): Promise<{ age: number; cleanAge: number; beat: Heartbeat | null }> {
  const cur = await repo.get(STATUS_PATH);
  const beat = parseBeat(cur ? cur.bytes : null, 'primary');
  const nowS = Math.floor(now() / 1000);
  if (!beat) return { age: Infinity, cleanAge: Infinity, beat: null };
  return { age: nowS - beat.heartbeatAt, cleanAge: cleanAgeOf(beat, nowS), beat };
}

export async function writeHeartbeat(repo: DataRepo, path: string, status: Record<string, unknown>): Promise<void> {
  await repo.upsert(path, enc(status), `heartbeat ${String(status.holder)} ${String(status.heartbeatAt)}`);
}
