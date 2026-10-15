// Where an epoch file lives and how a copy is trusted. A copy is used only if
// its sha256 is the contentHash the chain holds for that epoch, wherever it
// came from: the local cache, the site (the data repo behind a rewrite) or an
// IPFS gateway. Checked copies are cached under /data by their hash.
//
// Every fetch takes the caller's optional AbortSignal (the guardian's
// deadline for one root): the URI is the publisher's choice, so a copy that
// never finishes arriving must not hold anything up past that deadline.

import { sha256Hex } from '../calc/encoding.ts';
import type { Address } from '../calc/types.ts';
import { cidOfUri, fileCid } from './cid.ts';
import { getBytes, hostOf, HttpError, type HttpOptions } from './http.ts';
import type { Store } from './store.ts';

/** The largest epoch file accepted from the network (the format is ~100 B per holder). */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;

export function epochPath(chainId: bigint, distributor: Address, epoch: bigint | number): string {
  return `sharing/${chainId}/${distributor.toLowerCase()}/${epoch}.json`;
}

export function latestPath(chainId: bigint, distributor: Address): string {
  return `sharing/${chainId}/${distributor.toLowerCase()}/latest.json`;
}

export interface CopyCheck {
  source: string;
  ok: boolean;
  /** sha256 of what came back, when something did. */
  sha256?: string;
  error?: string;
}

export interface FilesOptions {
  chainId: bigint;
  store: Store;
  siteBase: string | null;
  gateways: string[];
  http?: HttpOptions;
}

export class EpochFiles {
  readonly chainId: bigint;
  private readonly store: Store;
  readonly siteBase: string | null;
  readonly gateways: string[];
  private readonly http: HttpOptions;

  constructor(o: FilesOptions) {
    this.chainId = o.chainId;
    this.store = o.store;
    this.siteBase = o.siteBase;
    this.gateways = o.gateways;
    this.http = o.http ?? {};
  }

  siteUrl(d: Address, epoch: bigint | number): string | null {
    return this.siteBase ? `${this.siteBase}/${epochPath(this.chainId, d, epoch)}` : null;
  }

  /** Any file the site serves from the data repo (sharing/<chain>/...), or
   *  null when it answers 404 or there is no site. Other failures throw. */
  async siteFile(rel: string, signal?: AbortSignal): Promise<Uint8Array | null> {
    if (!this.siteBase) return null;
    try {
      return await getBytes(`${this.siteBase}/${rel}`, { ...this.http, maxBytes: MAX_FILE_BYTES, signal });
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return null;
      throw e;
    }
  }

  gatewayUrls(uri: string): string[] {
    const cid = cidOfUri(uri);
    return cid ? this.gateways.map((g) => `${g}/ipfs/${cid}`) : [];
  }

  private cacheKey(contentHash: string): string {
    return `files/${this.chainId}/${contentHash.toLowerCase()}.json`;
  }

  cached(contentHash: string): Uint8Array | null {
    const b = this.store.readFile(this.cacheKey(contentHash));
    if (b && sha256Hex(b) === contentHash.toLowerCase()) return b;
    return null;
  }

  remember(bytes: Uint8Array): string {
    const h = sha256Hex(bytes);
    this.store.writeFile(this.cacheKey(h), bytes);
    return h;
  }

  /** One copy against the chain's contentHash. `cid`, for a gateway copy,
   *  is the CID it was asked for: a wrong copy then also says whether the
   *  gateway served other bytes than that CID (the gateway's fault) or that
   *  CID's own bytes (the URI names a file the hash does not). */
  async checkCopy(source: string, u: string, contentHash: string, cid?: string | null, signal?: AbortSignal): Promise<{ check: CopyCheck; bytes: Uint8Array | null }> {
    try {
      const b = await getBytes(u, { ...this.http, maxBytes: MAX_FILE_BYTES, signal });
      const h = sha256Hex(b);
      if (h !== contentHash.toLowerCase()) {
        let why = '';
        if (cid) why = fileCid(b) === cid ? ` - the bytes of ${cid} itself: the URI names a file that is not the one hashed on chain` : ` - not the bytes of ${cid}: the gateway serves wrong content for that CID`;
        return { check: { source, ok: false, sha256: h, error: `${hostOf(u)} served bytes whose sha256 is ${h}${why}` }, bytes: null };
      }
      return { check: { source, ok: true, sha256: h }, bytes: b };
    } catch (e) {
      return { check: { source, ok: false, error: (e as Error).message }, bytes: null };
    }
  }

  /** The first copy that hashes to contentHash: cache, then the site, then
   *  each gateway. Throws (listing what each source did) when none does. */
  async fetchVerified(d: Address, epoch: bigint, contentHash: string, uri: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; source: string }> {
    const hit = this.cached(contentHash);
    if (hit) return { bytes: hit, source: 'cache' };
    const tried: string[] = [];
    const site = this.siteUrl(d, epoch);
    const sources: [string, string][] = [...(site ? [['site', site] as [string, string]] : []), ...this.gatewayUrls(uri).map((u) => [`gateway ${hostOf(u)}`, u] as [string, string])];
    for (const [name, u] of sources) {
      const { check, bytes } = await this.checkCopy(name, u, contentHash, null, signal);
      if (bytes) {
        this.remember(bytes);
        return { bytes, source: name };
      }
      tried.push(`${name}: ${check.error}`);
    }
    throw new Error(`no copy of epoch ${epoch} of ${d} hashes to ${contentHash} (${tried.join('; ') || 'no source configured'})`);
  }

  /** Every source, each checked on its own (the verifier reports them all). */
  async checkAll(d: Address, epoch: bigint, contentHash: string, uri: string, signal?: AbortSignal): Promise<{ checks: CopyCheck[]; bytes: Uint8Array | null }> {
    const checks: CopyCheck[] = [];
    let good: Uint8Array | null = null;
    const site = this.siteUrl(d, epoch);
    const cid = cidOfUri(uri);
    const sources: [string, string, string | null][] = [...(site ? [['site', site, null] as [string, string, null]] : []), ...this.gatewayUrls(uri).map((u) => [`gateway ${hostOf(u)}`, u, cid] as [string, string, string | null])];
    for (const [name, u, want] of sources) {
      const { check, bytes } = await this.checkCopy(name, u, contentHash, want, signal);
      checks.push(check);
      if (bytes && !good) good = bytes;
    }
    if (good) this.remember(good);
    return { checks, bytes: good };
  }

  /** A FetchFile for loadActiveState, bound to the distributor and epoch the
   *  caller read at the same block. */
  fetcher(d: Address, epoch: bigint, signal?: AbortSignal): (uri: string, contentHash: string) => Promise<Uint8Array> {
    return async (uri, contentHash) => (await this.fetchVerified(d, epoch, contentHash, uri, signal)).bytes;
  }
}
