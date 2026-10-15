// /healthz and /status for the loop modes (the Docker HEALTHCHECK calls
// /healthz). Healthy means: a tick finished without errors within
// 3 x the interval, or the process is still inside its start-up grace.
// /status serves the last status document (it never holds a secret).

import { createServer, type Server } from 'node:http';

export class Health {
  private readonly intervalMs: number;
  private readonly startedAt: number;
  private readonly graceMs: number;
  private readonly now: () => number;
  lastOkAt: number | null = null;
  lastTickAt: number | null = null;
  lastError: string | null = null;
  status: Record<string, unknown> = {};

  constructor(o: { intervalSec: number; graceSec?: number; now?: () => number }) {
    this.now = o.now ?? Date.now;
    this.intervalMs = o.intervalSec * 1000;
    this.graceMs = (o.graceSec ?? Math.max(600, o.intervalSec * 3)) * 1000;
    this.startedAt = this.now();
  }

  tick(ok: boolean, error: string | null, status: Record<string, unknown>): void {
    this.lastTickAt = this.now();
    if (ok) this.lastOkAt = this.lastTickAt;
    this.lastError = error;
    this.status = status;
  }

  check(): { ok: boolean; reason: string } {
    const t = this.now();
    if (this.lastOkAt !== null && t - this.lastOkAt <= 3 * this.intervalMs) return { ok: true, reason: 'a tick finished cleanly in time' };
    if (this.lastOkAt === null && t - this.startedAt <= this.graceMs) return { ok: true, reason: 'starting' };
    return { ok: false, reason: this.lastOkAt === null ? `no clean tick since start (${this.lastError ?? 'none finished'})` : `last clean tick ${Math.round((t - this.lastOkAt) / 1000)}s ago (${this.lastError ?? ''})` };
  }
}

export interface Listen {
  port?: number;
  host?: string;
  /** A unix socket or Windows named pipe instead of a TCP port. */
  socket?: string;
}

export function healthServer(h: Health): Server {
  return createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
    };
    if (req.method !== 'GET') return send(405, { error: 'GET only' });
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/healthz') {
      const c = h.check();
      return send(c.ok ? 200 : 503, c);
    }
    if (path === '/status') return send(200, h.status);
    return send(404, { error: 'not found' });
  });
}

export function listen(s: Server, l: Listen): Promise<void> {
  return new Promise((resolve, reject) => {
    s.once('error', reject);
    const done = () => {
      s.off('error', reject);
      resolve();
    };
    if (l.socket) s.listen(l.socket, done);
    else s.listen(l.port ?? 8080, l.host ?? '0.0.0.0', done);
  });
}
