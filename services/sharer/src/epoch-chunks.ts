// Reading a chunked epoch file through the service's file sources (ops/files.ts
// EpochFiles): the index as before, by the contentHash the chain holds, and
// every chunk it names by the sha256 the index gives - from the cache under
// /data, the site (sharing/<chain>/<distributor>/chunks/<sha256>.json), then
// each IPFS gateway at the chunk's raw-block CID. A copy is used only if it
// hashes to what the index says, wherever it came from, and a checked copy is
// cached by its hash like the files themselves.
//
// The keeper (its active file, before pushing), the guardian and verifier
// (the file checked and the active one before it), `rebuild` and a stateless
// restart each read a whole file; the site reads one chunk of it.

import { chunkCid, chunkPath, parseEpochIndex, readEpochFile } from './calc/file.ts';
import type { Address, ChunkInfo, EpochFile, EpochIndex } from './calc/types.ts';
import type { CopyCheck, EpochFiles } from './ops/files.ts';

const hostOf = (u: string): string => {
  try {
    return new URL(u).host;
  } catch {
    return '<bad url>';
  }
};

/** Where a chunk is served: the site, by its sha256 under the distributor's
 *  directory, then each gateway at its raw-block CID (none past one block). */
export function chunkSources(files: Pick<EpochFiles, 'siteBase' | 'gateways' | 'chainId'>, d: Address, c: Pick<ChunkInfo, 'sha256' | 'size'>): { source: string; url: string; cid: string | null }[] {
  const out: { source: string; url: string; cid: string | null }[] = [];
  if (files.siteBase) out.push({ source: 'site', url: `${files.siteBase}/${chunkPath(files.chainId, d, c.sha256)}`, cid: null });
  const cid = chunkCid(c);
  if (cid) for (const g of files.gateways) out.push({ source: `gateway ${hostOf(g)}`, url: `${g}/ipfs/${cid}`, cid });
  return out;
}

/** No copy of a chunk hashes to the sha256 its index gives. `checks` says
 *  what each source did; one that served other bytes has a sha256. */
export class ChunkUnavailable extends Error {
  readonly chunk: ChunkInfo;
  readonly checks: CopyCheck[];
  constructor(d: Address, c: ChunkInfo, checks: CopyCheck[]) {
    super(`no copy of the chunk ${c.first} to ${c.last} of ${d} hashes to ${c.sha256} (${checks.map((x) => `${x.source}: ${x.error}`).join('; ') || 'no source configured'})`);
    this.name = 'ChunkUnavailable';
    this.chunk = c;
    this.checks = checks;
  }

  /** Some source served bytes, and none of them were the chunk: whoever
   *  serves the copies can cause that, as with a file's (HASH, not INVALID). */
  get served(): boolean {
    return this.checks.some((x) => !!x.sha256);
  }
}

/** A chunk fetcher for readEpochFile over `files`, for distributor `d`. Each
 *  download stops when `signal` aborts (a guardian's deadline); a chunk no
 *  source serves is a ChunkUnavailable. */
export function chunkFetcher(files: EpochFiles, d: Address, signal?: AbortSignal): (c: ChunkInfo) => Promise<Uint8Array> {
  return async (c) => {
    const hit = files.cached(c.sha256);
    if (hit) return hit;
    const tried: CopyCheck[] = [];
    for (const s of chunkSources(files, d, c)) {
      signal?.throwIfAborted();
      const { check, bytes } = await files.checkCopy(s.source, s.url, c.sha256, s.cid, signal);
      if (bytes) {
        files.remember(bytes);
        return bytes;
      }
      tried.push(check);
    }
    throw new ChunkUnavailable(d, c, tried);
  };
}

/** Every chunk an index names, as bytes that hash to what it gives (each
 *  through chunkFetcher), by sha256 - not parsed: what they say is for
 *  verifyEpochFile to judge. */
export async function fetchChunks(files: EpochFiles, d: Address, index: Pick<EpochIndex, 'chunks'>, signal?: AbortSignal): Promise<Map<string, Uint8Array>> {
  const fetch = chunkFetcher(files, d, signal);
  const out = new Map<string, Uint8Array>();
  for (const c of index.chunks) out.set(c.sha256, await fetch(c));
  return out;
}

/** A whole epoch file of `d` from its index's bytes (already checked against
 *  the chain's contentHash), its chunks fetched through `files`. */
export async function readWholeEpoch(
  files: EpochFiles,
  d: Address,
  indexBytes: Uint8Array,
  signal?: AbortSignal,
): Promise<{ file: EpochFile; index: EpochIndex; chunks: Map<string, Uint8Array> }> {
  return readEpochFile(indexBytes, chunkFetcher(files, d, signal));
}

/** Whether an index keeps its rows in chunks (its readers need readWholeEpoch). */
export function isChunked(indexBytes: Uint8Array): boolean {
  return parseEpochIndex(indexBytes).chunks.length > 0;
}
