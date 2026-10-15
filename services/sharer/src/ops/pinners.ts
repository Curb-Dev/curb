// IPFS pinning. Each pinner stores the file's bytes and answers the CID it
// stored them under; that answer must be exactly the CID computed locally
// (cid.ts, Kubo's own), or the pin does not count.
//
//   kubo    the Kubo RPC API, `add` with CIDv1, raw leaves and 256 KiB chunks
//           (cid.ts computes the same CID): a kubo node next to the
//           keeper, or a hosted Kubo-compatible RPC (Filebase's IPFS RPC).
//   pinata  Pinata's upload API (v3 files, public network).
//   psa     the IPFS Pinning Service API: pin by CID, fetched by the service
//           from the network. Asynchronous, so it never counts towards the
//           pins a publish needs; it is an extra copy.

import type { PinnerConfig } from './config.ts';
import type { Secret } from './secrets.ts';
import { HttpError, hostOf, request, type HttpOptions } from './http.ts';

export interface PinResult {
  pinner: string;
  ok: boolean;
  /** Counts towards config.ipfs.minPinned. */
  counts: boolean;
  cid?: string;
  error?: string;
}

export interface Pinner {
  readonly name: string;
  readonly counts: boolean;
  pin(bytes: Uint8Array, cid: string, fileName: string): Promise<PinResult>;
}

function form(bytes: Uint8Array, fileName: string, fields: Record<string, string> = {}): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append('file', new Blob([bytes as BlobPart], { type: 'application/json' }), fileName);
  return fd;
}

async function errorOf(res: Response): Promise<string> {
  let t = '';
  try {
    t = (await res.text()).slice(0, 160);
  } catch {
    // none
  }
  return `HTTP ${res.status} ${t}`.trim();
}

export class KuboPinner implements Pinner {
  readonly name: string;
  readonly counts = true;
  private readonly url: string;
  private readonly token: Secret | null;
  private readonly http: HttpOptions;
  constructor(name: string, url: string, token: Secret | null, http: HttpOptions = {}) {
    this.name = name;
    this.url = url.replace(/\/+$/, '');
    this.token = token;
    this.http = http;
  }
  async pin(bytes: Uint8Array, cid: string, fileName: string): Promise<PinResult> {
    const q = 'cid-version=1&raw-leaves=true&chunker=size-262144&pin=true&hash=sha2-256';
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token.reveal()}`;
    try {
      const res = await request(`${this.url}/api/v0/add?${q}`, { method: 'POST', headers, body: form(bytes, fileName) }, this.http);
      if (!res.ok) return { pinner: this.name, ok: false, counts: this.counts, error: `${hostOf(this.url)}: ${await errorOf(res)}` };
      // kubo streams one JSON object per added entry; the file's is the last
      const lines = (await res.text()).trim().split('\n').filter(Boolean);
      const last = JSON.parse(lines[lines.length - 1]) as { Hash?: string };
      if (last.Hash !== cid) return { pinner: this.name, ok: false, counts: this.counts, cid: last.Hash, error: `stored under ${last.Hash}, not ${cid}` };
      return { pinner: this.name, ok: true, counts: this.counts, cid };
    } catch (e) {
      return { pinner: this.name, ok: false, counts: this.counts, error: e instanceof HttpError ? e.message : `${hostOf(this.url)}: ${(e as Error).message}` };
    }
  }
}

export class PinataPinner implements Pinner {
  readonly name: string;
  readonly counts = true;
  private readonly url: string;
  private readonly token: Secret;
  private readonly http: HttpOptions;
  constructor(name: string, url: string, token: Secret, http: HttpOptions = {}) {
    this.name = name;
    this.url = url.replace(/\/+$/, '');
    this.token = token;
    this.http = http;
  }
  async pin(bytes: Uint8Array, cid: string, fileName: string): Promise<PinResult> {
    try {
      const res = await request(
        `${this.url}/v3/files`,
        { method: 'POST', headers: { authorization: `Bearer ${this.token.reveal()}` }, body: form(bytes, fileName, { network: 'public', name: fileName }) },
        this.http,
      );
      if (!res.ok) return { pinner: this.name, ok: false, counts: this.counts, error: `${hostOf(this.url)}: ${await errorOf(res)}` };
      const j = (await res.json()) as { data?: { cid?: string } };
      const got = j.data?.cid;
      if (got !== cid) return { pinner: this.name, ok: false, counts: this.counts, cid: got, error: `stored under ${got}, not ${cid}` };
      return { pinner: this.name, ok: true, counts: this.counts, cid };
    } catch (e) {
      return { pinner: this.name, ok: false, counts: this.counts, error: e instanceof HttpError ? e.message : `${hostOf(this.url)}: ${(e as Error).message}` };
    }
  }
}

export class PsaPinner implements Pinner {
  readonly name: string;
  readonly counts = false;
  private readonly url: string;
  private readonly token: Secret;
  private readonly http: HttpOptions;
  constructor(name: string, url: string, token: Secret, http: HttpOptions = {}) {
    this.name = name;
    this.url = url.replace(/\/+$/, '');
    this.token = token;
    this.http = http;
  }
  async pin(_bytes: Uint8Array, cid: string, fileName: string): Promise<PinResult> {
    try {
      const res = await request(
        `${this.url}/pins`,
        { method: 'POST', headers: { authorization: `Bearer ${this.token.reveal()}`, 'content-type': 'application/json' }, body: JSON.stringify({ cid, name: fileName }) },
        this.http,
      );
      if (!res.ok) return { pinner: this.name, ok: false, counts: this.counts, error: `${hostOf(this.url)}: ${await errorOf(res)}` };
      const j = (await res.json()) as { status?: string; pin?: { cid?: string } };
      if (j.pin?.cid && j.pin.cid !== cid) return { pinner: this.name, ok: false, counts: this.counts, error: `asked to pin ${j.pin.cid}` };
      return { pinner: this.name, ok: true, counts: this.counts, cid };
    } catch (e) {
      return { pinner: this.name, ok: false, counts: this.counts, error: (e as Error).message };
    }
  }
}

export function makePinners(cfg: PinnerConfig[], tokens: Record<string, Secret>, http: HttpOptions = {}): Pinner[] {
  return cfg.map((p) => {
    const tok = p.token ? tokens[p.token] : null;
    if (p.token && !tok) throw new Error(`pinner ${p.name} needs the pin_tokens entry "${p.token}", which is not set`);
    if (p.kind === 'kubo') return new KuboPinner(p.name, p.url, tok, http);
    if (p.kind === 'pinata') return new PinataPinner(p.name, p.url, tok!, http);
    return new PsaPinner(p.name, p.url, tok!, http);
  });
}
