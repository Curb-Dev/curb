// A fake internet for the ops tests: GitHub's contents API (with its sha
// compare-and-swap: 409 on a moved sha, 422 on a create over a file), the
// site serving the data repo, IPFS pinners (Kubo RPC `add`, Pinata v3) and
// gateways, and alert webhooks - each with faults a test can switch on. All
// hosts end in .test; nothing leaves the process.

import { createHash } from 'node:crypto';
import { fileCid } from '../../src/ops/cid.ts';

export interface RepoEntry {
  bytes: Uint8Array;
  sha: string;
}

function blobSha(b: Uint8Array): string {
  return createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
}

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export class FakeNet {
  readonly repo = new Map<string, RepoEntry>();
  readonly blocks = new Map<string, Uint8Array>();
  readonly alerts: { url: string; body: any }[] = [];
  readonly log: { method: string; url: string; status: number }[] = [];
  readonly commits: { path: string; message: string }[] = [];
  readonly authSeen: string[] = [];
  owner = 'curb';
  name = 'curb-sharing-data';

  // faults
  githubDown = false;
  /** Every API request is refused with this status (401: an expired or
   *  revoked token; 403: one without contents:write; or a rate limit, with
   *  deniedMessage saying so). */
  githubDenies: 401 | 403 | null = null;
  deniedMessage = 'Bad credentials';
  /** The raw file host (the verifiers' tokenless read of the data repo) is down. */
  rawDown = false;
  /** PUTs to matching paths are refused with 403 (a token without write on them). */
  refuseWrites: RegExp | null = null;
  /** Runs inside a PUT after the sha check and before the write: a test races here. */
  beforeCommit: ((path: string) => void) | null = null;
  kuboDown = false;
  pinataDown = false;
  /** The pinner answers this CID instead of the real one (it stored it chunked, say). */
  pinataWrongCid = false;
  siteDown = false;
  /** The site serves these bytes instead of the file. */
  siteTamper: ((path: string, b: Uint8Array) => Uint8Array) | null = null;
  gatewayDown = false;
  gatewayTamper = false;
  /** Copies appear only after this many reads (CDN lag). */
  siteLag = 0;
  private siteReads = new Map<string, number>();

  put(path: string, bytes: Uint8Array): void {
    this.repo.set(path, { bytes, sha: blobSha(bytes) });
  }

  text(path: string): string | null {
    const e = this.repo.get(path);
    return e ? new TextDecoder().decode(e.bytes) : null;
  }

  readonly fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const res = await this.route(url, init);
    this.log.push({ method: init.method ?? 'GET', url, status: res.status });
    return res;
  };

  private async route(url: string, init: RequestInit): Promise<Response> {
    const u = new URL(url);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers as any);
    if (headers.get('authorization')) this.authSeen.push(headers.get('authorization')!);

    // ---- GitHub contents API
    if (u.host === 'api.github.test') {
      if (this.githubDown) return json(503, { message: 'down' });
      const m = /^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/.exec(u.pathname);
      if (!m || m[1] !== this.owner || m[2] !== this.name) return json(404, { message: 'Not Found' });
      if (!/^Bearer .+/.test(headers.get('authorization') ?? '')) return json(401, { message: 'Bad credentials' });
      if (this.githubDenies) return json(this.githubDenies, { message: this.deniedMessage });
      const path = decodeURIComponent(m[3]);
      const cur = this.repo.get(path);
      if (method === 'GET') {
        if (!cur) return json(404, { message: 'Not Found' });
        if (headers.get('accept') === 'application/vnd.github.raw+json') return new Response(cur.bytes as BodyInit, { status: 200 });
        return json(200, { type: 'file', sha: cur.sha, encoding: 'base64', content: Buffer.from(cur.bytes).toString('base64') });
      }
      if (method === 'PUT') {
        if (this.refuseWrites && this.refuseWrites.test(path)) return json(403, { message: 'Resource not accessible by personal access token' });
        const body = JSON.parse(String(init.body));
        if (cur && !body.sha) return json(422, { message: '"sha" wasn\'t supplied.' });
        if (cur && body.sha !== cur.sha) return json(409, { message: `${path} does not match ${body.sha}` });
        if (!cur && body.sha) return json(409, { message: `${path} does not exist` });
        this.beforeCommit?.(path);
        const now = this.repo.get(path);
        if ((now?.sha ?? null) !== (cur?.sha ?? null)) return json(409, { message: 'is at a different sha' });
        const bytes = new Uint8Array(Buffer.from(body.content, 'base64'));
        this.put(path, bytes);
        this.commits.push({ path, message: body.message });
        return json(cur ? 200 : 201, { content: { sha: this.repo.get(path)!.sha, path } });
      }
      if (method === 'DELETE') {
        if (this.refuseWrites && this.refuseWrites.test(path)) return json(403, { message: 'Resource not accessible by personal access token' });
        const body = JSON.parse(String(init.body));
        if (!cur) return json(404, { message: 'Not Found' });
        if (body.sha !== cur.sha) return json(409, { message: `${path} does not match ${body.sha}` });
        this.repo.delete(path);
        this.commits.push({ path, message: body.message });
        return json(200, { content: null });
      }
      return json(405, { message: 'method' });
    }

    // ---- the raw file host: the data repo read without a token
    if (u.host === 'raw.github.test') {
      if (this.rawDown) return new Response('down', { status: 503 });
      const m = /^\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(u.pathname);
      if (!m || m[1] !== this.owner || m[2] !== this.name) return new Response('404: Not Found', { status: 404 });
      const e = this.repo.get(decodeURIComponent(m[4]));
      if (!e) return new Response('404: Not Found', { status: 404 });
      return new Response(e.bytes as BodyInit, { status: 200 });
    }

    // ---- the site: a rewrite of the data repo
    if (u.host === 'site.test') {
      if (this.siteDown) return new Response('down', { status: 503 });
      const path = u.pathname.replace(/^\//, '');
      const reads = (this.siteReads.get(path) ?? 0) + 1;
      this.siteReads.set(path, reads);
      const e = this.repo.get(path);
      if (!e || reads <= this.siteLag) return new Response('not found', { status: 404 });
      return new Response((this.siteTamper ? this.siteTamper(path, e.bytes) : e.bytes) as BodyInit, { status: 200 });
    }

    // ---- IPFS: pinners and gateways
    if (u.host === 'kubo.test' && u.pathname === '/api/v0/add') {
      if (this.kuboDown) return new Response('kubo down', { status: 502 });
      if (u.searchParams.get('cid-version') !== '1' || u.searchParams.get('raw-leaves') !== 'true' || u.searchParams.get('chunker') !== 'size-262144') return new Response('{"Hash":"QmOtherParameters"}', { status: 200 });
      const b = await fileOf(init.body);
      const cid = fileCid(b);
      this.blocks.set(cid, b);
      return new Response(JSON.stringify({ Name: 'f', Hash: cid, Size: String(b.length) }) + '\n', { status: 200 });
    }
    if (u.host === 'pinata.test' && u.pathname === '/v3/files') {
      if (this.pinataDown) return json(500, { error: 'down' });
      const b = await fileOf(init.body);
      const cid = fileCid(b);
      if (!this.pinataWrongCid) this.blocks.set(cid, b);
      return json(200, { data: { id: 'x', cid: this.pinataWrongCid ? 'bafybeiwrongwrongwrong' : cid } });
    }
    if (u.host === 'gw.test') {
      if (this.gatewayDown) return new Response('down', { status: 504 });
      const cid = u.pathname.replace(/^\/ipfs\//, '');
      const b = this.blocks.get(cid);
      if (!b) return new Response('not found', { status: 404 });
      return new Response((this.gatewayTamper ? new TextEncoder().encode('{"tampered":true}') : b) as BodyInit, { status: 200 });
    }

    // ---- alerts
    if (u.host === 'hooks.test' || u.host === 'api.telegram.org') {
      this.alerts.push({ url, body: JSON.parse(String(init.body)) });
      return json(200, { ok: true });
    }
    return new Response('no such host in the fake net: ' + u.host, { status: 599 });
  }
}

async function fileOf(body: unknown): Promise<Uint8Array> {
  if (body instanceof FormData) {
    const f = body.get('file');
    if (f instanceof Blob) return new Uint8Array(await f.arrayBuffer());
  }
  throw new Error('fake net: no file in the form');
}
