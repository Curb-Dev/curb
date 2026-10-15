// The public data repo (curb-sharing-data) through the GitHub contents API,
// with a fine-grained token that has contents:write on that repo only.
//
//   get(path)            -> { sha, bytes } or null
//   put(path, bytes, sha) creates (sha null) or replaces the blob whose sha
//                         was read - GitHub refuses with 409 if the file moved
//                         on since, and with 422 if a create finds a file.
//                         That is the compare-and-swap the lease rests on.
//
// The token goes in the Authorization header and nowhere else; errors name
// the status and GitHub's message, never the request.

import type { Secret } from './secrets.ts';
import { HttpError, request, type HttpOptions } from './http.ts';

export interface RepoFile {
  sha: string;
  bytes: Uint8Array;
}

export class Conflict extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'Conflict';
  }
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** GitHub refused the token itself (not a race, not a rate limit). */
export interface Denied {
  status: number;
  what: string;
  message: string;
}

/** 401 is a token that is expired, revoked or wrong; 403 is one without
 *  contents:write on the repo - unless GitHub says it is a rate limit, which
 *  passes by itself. */
export function isDenied(status: number, message: string): boolean {
  return status === 401 || (status === 403 && !/rate limit/i.test(message));
}

export interface DataRepoOptions extends HttpOptions {
  owner: string;
  repo: string;
  branch: string;
  token: Secret;
  apiBase?: string;
  /** A directory inside the repo every path is relative to ('' or 'x/'). */
  root?: string;
  committer?: { name: string; email: string };
  /** Called (and awaited, never thrown from) when GitHub refuses the token:
   *  the runner pages at once, since nothing the keeper writes - files,
   *  heartbeat, lease - can land until a person replaces the token. */
  onDenied?: (d: Denied) => unknown;
}

export class DataRepo {
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
  private readonly token: Secret;
  private readonly api: string;
  private readonly root: string;
  private readonly http: HttpOptions;
  private readonly committer: { name: string; email: string };
  private readonly onDenied: DataRepoOptions['onDenied'];

  constructor(o: DataRepoOptions) {
    this.owner = o.owner;
    this.repo = o.repo;
    this.branch = o.branch;
    this.token = o.token;
    this.api = (o.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
    this.root = o.root ?? '';
    this.http = { fetch: o.fetch, timeoutMs: o.timeoutMs ?? 30_000, tries: o.tries ?? 3, backoffMs: o.backoffMs, sleep: o.sleep };
    this.committer = o.committer ?? { name: 'curb-sharer', email: 'curb-sharer@users.noreply.github.com' };
    this.onDenied = o.onDenied;
  }

  private url(path: string): string {
    if (!/^[A-Za-z0-9_.\/-]+$/.test(path) || path.includes('..') || path.startsWith('/')) throw new Error(`bad data repo path ${path}`);
    return `${this.api}/repos/${this.owner}/${this.repo}/contents/${this.root}${path}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${this.token.reveal()}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'curb-sharer',
      ...extra,
    };
  }

  private async fail(res: Response, what: string): Promise<never> {
    let message = '';
    try {
      const j = (await res.json()) as { message?: string };
      message = typeof j.message === 'string' ? j.message.slice(0, 200) : '';
    } catch {
      // no body
    }
    if (res.status === 409 || (res.status === 422 && /sha/i.test(message))) throw new Conflict(`${what}: ${res.status} ${message}`);
    if (isDenied(res.status, message) && this.onDenied) {
      try {
        await this.onDenied({ status: res.status, what, message });
      } catch {
        // an alert can never stop the caller from seeing the refusal
      }
    }
    throw new HttpError(`${what}: GitHub answered ${res.status} ${message}`, res.status);
  }

  async get(path: string): Promise<RepoFile | null> {
    const u = `${this.url(path)}?ref=${encodeURIComponent(this.branch)}`;
    const res = await request(u, { method: 'GET', headers: this.headers() }, this.http);
    if (res.status === 404) return null;
    if (!res.ok) return this.fail(res, `get ${path}`);
    const j = (await res.json()) as { type?: string; sha?: string; content?: string; encoding?: string };
    if (j.type !== 'file' || typeof j.sha !== 'string') throw new Error(`get ${path}: not a file`);
    if (j.encoding === 'base64' && typeof j.content === 'string') return { sha: j.sha, bytes: new Uint8Array(Buffer.from(j.content.replace(/\n/g, ''), 'base64')) };
    // above 1 MB the JSON carries no content: ask for the raw bytes
    const raw = await request(u, { method: 'GET', headers: this.headers({ accept: 'application/vnd.github.raw+json' }) }, this.http);
    if (!raw.ok) return this.fail(raw, `get ${path} (raw)`);
    return { sha: j.sha, bytes: new Uint8Array(await raw.arrayBuffer()) };
  }

  /** Writes `bytes` at `path`. `sha` null creates; otherwise it must be the
   *  sha read last (compare-and-swap). Returns the new blob sha. */
  async put(path: string, bytes: Uint8Array, message: string, sha: string | null): Promise<string> {
    const body: Record<string, unknown> = { message, content: b64(bytes), branch: this.branch, committer: this.committer };
    if (sha) body.sha = sha;
    // Not retried on a 5xx blindly: a write that landed and then failed to
    // answer would be retried into a 409. request() retries only 429/5xx,
    // and a retried PUT that finds its own content is accepted by the caller.
    const res = await request(this.url(path), { method: 'PUT', headers: this.headers({ 'content-type': 'application/json' }), body: JSON.stringify(body) }, this.http);
    if (!res.ok) return this.fail(res, `put ${path}`);
    const j = (await res.json()) as { content?: { sha?: string } };
    if (!j.content || typeof j.content.sha !== 'string') throw new Error(`put ${path}: GitHub's answer has no content sha`);
    return j.content.sha;
  }

  /** Deletes the blob whose sha was read (compare-and-swap, like put). */
  async remove(path: string, message: string, sha: string): Promise<void> {
    const body = { message, sha, branch: this.branch, committer: this.committer };
    const res = await request(this.url(path), { method: 'DELETE', headers: this.headers({ 'content-type': 'application/json' }), body: JSON.stringify(body) }, this.http);
    if (!res.ok) return this.fail(res, `delete ${path}`);
  }

  /** Puts `bytes` unless the file already holds exactly them; replaces
   *  whatever else is there. Retries a lost race a few times. */
  async upsert(path: string, bytes: Uint8Array, message: string): Promise<'same' | 'written'> {
    for (let i = 0; i < 4; i++) {
      const cur = await this.get(path);
      if (cur && Buffer.from(cur.bytes).equals(Buffer.from(bytes))) return 'same';
      try {
        await this.put(path, bytes, message, cur ? cur.sha : null);
        return 'written';
      } catch (e) {
        if (!(e instanceof Conflict)) throw e;
      }
    }
    throw new Conflict(`put ${path}: lost the race four times`);
  }
}

/** The public data repo read WITHOUT a token, through GitHub's raw file host:
 *  what the verifiers use to watch the heartbeats (they hold no token, and
 *  the site serves only sharing/). Not rate-limited like the unauthenticated
 *  API; its CDN may answer up to five minutes stale, far inside any
 *  staleness a watcher pages on. */
export class PublicRepo {
  private readonly base: string;
  private readonly http: HttpOptions;

  constructor(o: { owner: string; repo: string; branch: string; root?: string; rawBase?: string } & HttpOptions) {
    const raw = (o.rawBase ?? 'https://raw.githubusercontent.com').replace(/\/+$/, '');
    this.base = `${raw}/${o.owner}/${o.repo}/${o.branch}/${o.root ?? ''}`;
    this.http = { fetch: o.fetch, timeoutMs: o.timeoutMs ?? 20_000, tries: o.tries ?? 2, backoffMs: o.backoffMs, sleep: o.sleep };
  }

  /** The file's bytes, or null when there is no such file. */
  async get(path: string): Promise<Uint8Array | null> {
    if (!/^[A-Za-z0-9_.\/-]+$/.test(path) || path.includes('..') || path.startsWith('/')) throw new Error(`bad data repo path ${path}`);
    const res = await request(this.base + path, { method: 'GET' }, this.http);
    if (res.status === 404) return null;
    if (!res.ok) throw new HttpError(`GET ${path} from the public data repo: HTTP ${res.status}`, res.status);
    return new Uint8Array(await res.arrayBuffer());
  }
}
