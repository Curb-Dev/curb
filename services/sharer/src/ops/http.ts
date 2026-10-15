// Outbound HTTP for publishing, fetching files and alerts. One injectable
// fetch (the tests give a fake network), a timeout on every request, and a
// short retry on what is worth retrying (a 429, a 5xx, a dropped
// connection). Errors carry the method, the host and the status - never a
// header, a query string or a body that might hold a token.
//
// A DOWNLOAD IS BOUNDED IN TIME AND SIZE, BODY INCLUDED (getBytes). The URI
// of an epoch file is chosen by whoever holds the publisher key, so the
// server behind it may answer its headers at once and then trickle the body,
// or send gigabytes: one deadline covers each attempt's headers AND body, a
// Content-Length above the limit is refused before a byte is read, and the
// bytes are counted as they stream in, so nothing past the limit is ever
// held in memory. A caller's own signal (the guardian's deadline for one
// root) stops the download and every retry at once.

export type Fetch = typeof fetch;

export class HttpError extends Error {
  readonly status: number | null;
  constructor(msg: string, status: number | null) {
    super(msg);
    this.name = 'HttpError';
    this.status = status;
  }
}

export interface HttpOptions {
  fetch?: Fetch;
  timeoutMs?: number;
  tries?: number;
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** The caller's own deadline: once aborted, no request is made or waited for. */
  signal?: AbortSignal;
}

/** The host of a URL, for messages (no path, no query, no credentials). */
export function hostOf(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return '<bad url>';
  }
}

export async function request(u: string, init: RequestInit, o: HttpOptions = {}): Promise<Response> {
  const f = o.fetch ?? fetch;
  const tries = o.tries ?? 3;
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let last: unknown;
  for (let attempt = 0; attempt < tries; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 30_000);
    try {
      const res = await f(u, { ...init, signal: ctl.signal });
      if (res.status === 429 || res.status >= 500) {
        last = new HttpError(`${init.method ?? 'GET'} ${hostOf(u)}: HTTP ${res.status}`, res.status);
        try {
          await res.arrayBuffer();
        } catch {
          // drained
        }
      } else return res;
    } catch (e) {
      last = new HttpError(`${init.method ?? 'GET'} ${hostOf(u)}: ${ctl.signal.aborted ? 'timed out' : (e as Error).message}`, null);
    } finally {
      clearTimeout(timer);
    }
    if (attempt + 1 < tries) await sleep((o.backoffMs ?? 500) * 2 ** attempt);
  }
  throw last;
}

/** Waits for `p`, or rejects the moment `signal` aborts. */
function unlessAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

class TooLarge extends HttpError {}

/** The body of `res`, at most `max` bytes, read before `signal` aborts. */
async function readBody(res: Response, u: string, max: number | undefined, signal: AbortSignal): Promise<Uint8Array> {
  const declared = res.headers.get('content-length');
  if (max !== undefined && declared !== null && /^[0-9]+$/.test(declared.trim()) && Number(declared.trim()) > max) {
    try {
      await res.body?.cancel();
    } catch {
      // nothing read, nothing kept
    }
    throw new TooLarge(`GET ${hostOf(u)}: Content-Length ${declared.trim()} is more than ${max} bytes`, res.status);
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await unlessAborted(reader.read(), signal);
      if (done) break;
      n += value.length;
      if (max !== undefined && n > max) throw new TooLarge(`GET ${hostOf(u)}: more than ${max} bytes`, res.status);
      chunks.push(value);
    }
  } catch (e) {
    reader.cancel().catch(() => {});
    throw e;
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** A GET whose every attempt - headers and body together - ends within
 *  timeoutMs, whose body is never more than maxBytes, and which stops at
 *  once when the caller's signal aborts. A 429, a 5xx, a dropped connection
 *  and a timeout are tried again; a body that is too large is not. */
export async function getBytes(u: string, o: HttpOptions & { headers?: Record<string, string>; maxBytes?: number } = {}): Promise<Uint8Array> {
  const f = o.fetch ?? fetch;
  const tries = o.tries ?? 3;
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const outer = o.signal;
  let last: unknown;
  for (let attempt = 0; attempt < tries; attempt++) {
    if (outer?.aborted) throw new HttpError(`GET ${hostOf(u)}: stopped (the caller's deadline)`, null);
    // A plain timer, not AbortSignal.timeout(): that one does not keep the
    // process alive, and a --once run waiting on a stalled body would end
    // in the middle of its pass instead of timing the download out.
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error('timed out')), o.timeoutMs ?? 30_000);
    const signal = outer ? AbortSignal.any([outer, timeout.signal]) : timeout.signal;
    try {
      const res = await unlessAborted(f(u, { method: 'GET', headers: o.headers, signal }), signal);
      if (res.status === 429 || res.status >= 500) {
        res.body?.cancel().catch(() => {});
        last = new HttpError(`GET ${hostOf(u)}: HTTP ${res.status}`, res.status);
      } else if (!res.ok) {
        res.body?.cancel().catch(() => {});
        throw new HttpError(`GET ${hostOf(u)}: HTTP ${res.status}`, res.status);
      } else {
        return await readBody(res, u, o.maxBytes, signal);
      }
    } catch (e) {
      if (e instanceof HttpError && e.status !== null && !(e.status === 429 || e.status >= 500)) throw e; // a 4xx, or too large: asking again changes nothing
      if (outer?.aborted) throw new HttpError(`GET ${hostOf(u)}: stopped (the caller's deadline)`, null);
      last = timeout.signal.aborted ? new HttpError(`GET ${hostOf(u)}: timed out (headers and body within ${o.timeoutMs ?? 30_000} ms)`, null) : e instanceof HttpError ? e : new HttpError(`GET ${hostOf(u)}: ${(e as Error).message}`, null);
    } finally {
      clearTimeout(timer);
    }
    if (attempt + 1 < tries) {
      // the pause before asking again ends with the caller's deadline too
      const pause = sleep((o.backoffMs ?? 500) * 2 ** attempt);
      await (outer ? unlessAborted(pause, outer).catch(() => {}) : pause);
    }
  }
  throw last;
}
