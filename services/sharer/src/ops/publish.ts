// Publishing an epoch file (design D.2.5), before its root goes on chain:
//
//   0. refuse a file above the read-back limit (files.ts MAX_FILE_BYTES),
//      and a chunk that is not exactly the one its index names
//   1. write it to the data repo at sharing/<chain>/<distributor>/<epoch>.json
//   2. pin it on every configured pinner; at least minPinned must store it
//      under exactly the raw-block CID
//   3. re-fetch it from the SITE and from at least one IPFS GATEWAY, and
//      check the sha256 of each copy
//
// PAST ONE CHUNK OF ROWS THE CHUNKS GO FIRST. The file the chain hashes is
// then an index, and its rows are in chunk files it names by sha256
// (calc/file.ts): each chunk goes through the same three steps - in the data
// repo at sharing/<chain>/<distributor>/chunks/<sha256>.json, pinned under
// its raw-block CID, read back from the site and a gateway - before the
// index does. A root whose index names a chunk nobody can fetch could not be
// verified, and the guardian vetoes what it cannot verify.
//
// Only a file that passed all three, with every chunk, may be named in
// publishMany. Anything else is "not published": the caller drops it from
// the batch and alerts. An orphan file or chunk (written, never put on chain)
// is harmless: nothing on chain points at it, and the next run overwrites it
// or leaves it - a chunk's path is its hash, so writing it again is no change.

import { sha256Hex } from '../calc/encoding.ts';
import { chunkCid, chunkPath } from '../calc/file.ts';
import type { Address, ChunkInfo } from '../calc/types.ts';
import { chunkSources } from '../epoch-chunks.ts';
import { ipfsUri, fileCid } from './cid.ts';
import { epochPath, MAX_FILE_BYTES, type CopyCheck, type EpochFiles } from './files.ts';
import type { DataRepo } from './github.ts';
import type { Pinner, PinResult } from './pinners.ts';
import type { Logger } from './log.ts';

export interface PublishItem {
  distributor: Address;
  epoch: bigint;
  /** The index: the bytes whose sha256 goes on chain. */
  bytes: Uint8Array;
  contentHash: string;
  /** The chunk files the index names (EpochResult.chunks), in order; none
   *  when its rows are in it. Each is published before the index. */
  chunks?: { info: ChunkInfo; bytes: Uint8Array }[];
}

export interface Published {
  distributor: Address;
  epoch: bigint;
  uri: string;
  cid: string;
  contentHash: string;
  pins: PinResult[];
  copies: CopyCheck[];
}

export interface NotPublished {
  distributor: Address;
  epoch: bigint;
  reason: string;
}

export interface PublisherDeps {
  chainId: bigint;
  repo: DataRepo | null;
  pinners: Pinner[];
  minPinned: number;
  files: EpochFiles;
  log: Logger;
  /** How often to look for the copies before giving up (CDN and gateway lag). */
  refetchTries?: number;
  refetchDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export async function publishFile(item: PublishItem, deps: PublisherDeps): Promise<Published | NotPublished> {
  const { distributor: d, epoch, bytes } = item;
  const log = deps.log.child({ distributor: d, epoch });
  const fail = (reason: string): NotPublished => {
    log.warn('epoch file not published', { reason });
    return { distributor: d, epoch, reason };
  };
  // Nothing every reader would refuse is written or pinned: the verifiers,
  // the guardian, the site and the keeper itself read a file back only up to
  // MAX_FILE_BYTES, so a root naming a larger one could never be checked.
  if (bytes.length > MAX_FILE_BYTES) return fail(`the file is ${bytes.length} bytes, above the ${MAX_FILE_BYTES}-byte read-back limit (files.ts MAX_FILE_BYTES): nobody could read it back`);
  if (sha256Hex(bytes) !== item.contentHash.toLowerCase()) return fail('the bytes are not the computed contentHash');
  const cid = fileCid(bytes);
  if (!deps.repo) return fail('no data repo is configured, so the site cannot serve the file');
  if (!deps.files.siteBase) return fail('no site is configured to re-fetch the file from');
  if (deps.files.gateways.length === 0) return fail('no IPFS gateway is configured to re-fetch the file from');
  // Every chunk is the one the index names, and one IPFS block: its readers
  // find it on a gateway by the CID its sha256 makes (chunkCid), with nothing
  // but the index in hand.
  const chunks = item.chunks ?? [];
  for (const [k, c] of chunks.entries()) {
    if (sha256Hex(c.bytes) !== c.info.sha256 || BigInt(c.bytes.length) !== c.info.size) return fail(`chunk ${k} is not the one the index names (its sha256 or its length)`);
    if (chunkCid(c.info) !== fileCid(c.bytes)) return fail(`chunk ${k} is ${c.bytes.length} bytes, more than one IPFS block: no gateway could serve it by the CID its index gives`);
  }

  // The chunks first, each in the data repo, pinned and read back.
  for (const [k, c] of chunks.entries()) {
    const at = await place(deps, log, {
      what: `chunk ${k} of epoch ${epoch} of ${d} (sha256 ${c.info.sha256})`,
      path: chunkPath(deps.chainId, d, c.info.sha256),
      bytes: c.bytes,
      cid: fileCid(c.bytes),
      name: `curb-${deps.chainId}-${d}-${epoch}-chunk-${k}.json`,
      copies: () => chunkCopies(deps.files, d, c.info),
    });
    if (typeof at === 'string') return fail(`chunk ${k} (${c.info.first} to ${c.info.last}): ${at}`);
  }

  // Then the index, which the chain will name.
  const uri = ipfsUri(cid);
  const at = await place(deps, log, {
    what: `epoch ${epoch} of ${d} (sha256 ${item.contentHash})`,
    path: epochPath(deps.chainId, d, epoch),
    bytes,
    cid,
    name: `curb-${deps.chainId}-${d}-${epoch}.json`,
    copies: async () => (await deps.files.checkAll(d, epoch, item.contentHash, uri)).checks,
  });
  if (typeof at === 'string') return fail(at);
  log.info('epoch file published and read back', { uri, chunks: chunks.length, pins: at.pins.filter((p) => p.ok).map((p) => p.pinner), copies: at.copies.filter((c) => c.ok).map((c) => c.source) });
  return { distributor: d, epoch, uri, cid, contentHash: item.contentHash.toLowerCase(), pins: at.pins, copies: at.copies };
}

/** One file - the index or a chunk - through steps 1 to 3: the data repo, the
 *  pins, and the copies read back from the site and a gateway. Its pins and
 *  copies, or why it is not published. */
async function place(
  deps: PublisherDeps,
  log: Logger,
  x: { what: string; path: string; bytes: Uint8Array; cid: string; name: string; copies: () => Promise<CopyCheck[]> },
): Promise<{ pins: PinResult[]; copies: CopyCheck[] } | string> {
  // 1. the data repo (served by the site)
  try {
    const w = await deps.repo!.upsert(x.path, x.bytes, x.what);
    log.info('epoch file in the data repo', { path: x.path, write: w });
  } catch (e) {
    return `data repo: ${(e as Error).message}`;
  }

  // 2. the pins
  const pins: PinResult[] = [];
  for (const p of deps.pinners) pins.push(await p.pin(x.bytes, x.cid, x.name));
  const counted = pins.filter((p) => p.ok && p.counts).length;
  for (const p of pins) if (!p.ok) log.warn('a pin failed', { pinner: p.pinner, error: p.error });
  if (counted < deps.minPinned) return `${counted} of the ${deps.minPinned} pins needed stored the file under ${x.cid}`;

  // 3. read it back: the site and at least one gateway must serve these bytes
  const tries = deps.refetchTries ?? 6;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let copies: CopyCheck[] = [];
  for (let i = 0; i < tries; i++) {
    const checks = await x.copies();
    copies = checks;
    const siteOk = checks.some((c) => c.source === 'site' && c.ok);
    const gwOk = checks.some((c) => c.source.startsWith('gateway') && c.ok);
    if (siteOk && gwOk) {
      return { pins, copies: checks };
    }
    // A copy that is THERE but hashes wrong is not lag: stop at once.
    const wrong = checks.find((c) => c.sha256 && !c.ok);
    if (wrong) return `read back: ${wrong.source} serves other bytes (sha256 ${wrong.sha256})`;
    if (i + 1 < tries) await sleep((deps.refetchDelayMs ?? 5000) * (i + 1));
  }
  return `read back: ${copies.map((c) => `${c.source} ${c.ok ? 'ok' : c.error}`).join('; ')}`;
}

/** A chunk's copies, where its readers fetch it (epoch-chunks.ts
 *  chunkSources): the site, then each gateway at its raw-block CID, each
 *  checked against its sha256. A good one is kept in the cache by its hash. */
async function chunkCopies(files: EpochFiles, d: Address, c: ChunkInfo): Promise<CopyCheck[]> {
  const checks: CopyCheck[] = [];
  let good: Uint8Array | null = null;
  for (const s of chunkSources(files, d, c)) {
    const { check, bytes } = await files.checkCopy(s.source, s.url, c.sha256, s.cid);
    checks.push(check);
    if (bytes && !good) good = bytes;
  }
  if (good) files.remember(good);
  return checks;
}

/** After the root is on chain: a non-authoritative pointer for the site. */
export async function writeLatest(repo: DataRepo | null, chainId: bigint, p: { distributor: Address; epoch: bigint; uri: string; contentHash: string; txHash: string }, log: Logger): Promise<void> {
  if (!repo) return;
  const body = JSON.stringify({
    schema: 'curb.sharing.latest/1',
    note: 'not authoritative: trust only the contentHash on chain',
    distributor: p.distributor,
    epoch: p.epoch.toString(),
    uri: p.uri,
    path: epochPath(chainId, p.distributor, p.epoch),
    contentHash: p.contentHash,
    publishTx: p.txHash,
  });
  try {
    await repo.upsert(`sharing/${chainId}/${p.distributor}/latest.json`, new TextEncoder().encode(body + '\n'), `latest epoch of ${p.distributor}: ${p.epoch}`);
  } catch (e) {
    log.warn('latest.json not written', { error: (e as Error).message });
  }
}
