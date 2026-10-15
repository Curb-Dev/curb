// Stateless restarts and publishing arguments.
//
// The authoritative restart point is the active epoch's file: its URI comes
// from the distributor's RootPublished event, its bytes are trusted only if
// their sha256 is the active root's contentHash, and its leaves and its
// stateAtEnd commitment are the next epoch's opening state. Past one chunk
// of rows the file is an index and its chunks, each trusted only through the
// sha256 the index gives, and every one of them is read. The file does not
// list the complete balances: prepareEpoch rebuilds them from the chain (or
// keeps them from its own last computation) and checks them against that
// commitment.

import { encodeFunctionData } from 'viem';
import { parseEpochIndex, verifyEpochFile, stateFromEpochFile } from './calc/file.ts';
import type { ActiveState, Address, ChunkInfo, EpochFile, EpochIndex, EpochResult } from './calc/types.ts';
import { factoryAbi } from './chain/abis.ts';
import { readDistributorState, readEpochHistory, readLaunchMeta, type DistributorState } from './chain/indexer.ts';
import type { ChainReader } from './chain/reader.ts';

/** Fetches an epoch file's bytes by URI (site, IPFS gateway, local cache). */
export type FetchFile = (uri: string, contentHash: string) => Promise<Uint8Array>;

/** Fetches the bytes of chunk `k` an index names (epoch-chunks.ts
 *  chunkFetcher: the cache, the site, the gateways). */
export type FetchChunk = (c: ChunkInfo, k: number) => Promise<Uint8Array>;

const noChunks: FetchChunk = async (c) => {
  throw new Error(`the file keeps its rows in chunks and no chunk fetcher was given (chunk ${c.first} to ${c.last})`);
};

export interface LoadedState {
  state: ActiveState | null;
  file: EpochFile | null;
  distributorState: DistributorState;
}

/** The active epoch's state at `block`, rebuilt from its published file
 *  (its index, and every chunk through `fetchChunk` when it has any). */
export async function loadActiveState(r: ChainReader, graduator: Address, distributor: Address, fetchFile: FetchFile, block: bigint, fetchChunk: FetchChunk = noChunks): Promise<LoadedState> {
  const D = distributor.toLowerCase();
  const st = await readDistributorState(r, D, block);
  if (st.active.epoch === 0n) return { state: null, file: null, distributorState: st };
  const meta = await readLaunchMeta(r, graduator, D, block);
  const { published } = await readEpochHistory(r, D, meta.sharingSince, block);
  const ev = published.filter((p) => p.epoch === st.active.epoch);
  if (ev.length !== 1) throw new Error(`${ev.length} RootPublished events for active epoch ${st.active.epoch} of ${D}`);
  const p = ev[0];
  if (p.contentHash !== st.active.contentHash || p.merkleRoot !== st.active.merkleRoot) throw new Error(`the RootPublished event of epoch ${p.epoch} does not match the active root`);
  const bytes = await fetchFile(p.uri, p.contentHash);
  // every chunk the index names (fetchChunk refuses one that does not hash
  // to what the index gives); what they hold is verifyEpochFile's to judge
  const chunks = new Map<string, Uint8Array>();
  let index: EpochIndex | null = null;
  try {
    index = parseEpochIndex(bytes);
  } catch {
    // verifyEpochFile names what is wrong with it
  }
  for (const [k, c] of (index?.chunks ?? []).entries()) chunks.set(c.sha256, await fetchChunk(c, k));
  const a = st.active;
  const check = verifyEpochFile(bytes, {
    distributor: D,
    epoch: a.epoch,
    contentHash: a.contentHash,
    merkleRoot: a.merkleRoot,
    cumHolders0: a.cumHolders0,
    cumHolders1: a.cumHolders1,
    cumKeeper0: a.cumKeeper0,
    fromBlock: a.fromBlock,
    toBlock: a.toBlock,
  }, null, { chunks });
  if (!check.ok || !check.file) throw new Error(`the active epoch's file does not check: ${check.problems.join('; ')}`);
  return { state: stateFromEpochFile(check.file, check.contentHash, p.uri), file: check.file, distributorState: st };
}

/** The factory call that proposes these epochs (payableAt is set on chain). */
export function publishArgs(items: { distributor: Address; result: EpochResult; uri: string }[]): {
  ds: Address[];
  rs: { merkleRoot: string; contentHash: string; cumHolders0: bigint; cumHolders1: bigint; cumKeeper0: bigint; fromBlock: bigint; toBlock: bigint; epoch: number; payableAt: number }[];
  uris: string[];
  data: string;
} {
  const ds = items.map((i) => i.distributor.toLowerCase());
  const rs = items.map(({ result: { root } }) => ({
    merkleRoot: root.merkleRoot,
    contentHash: root.contentHash,
    cumHolders0: root.cumHolders0,
    cumHolders1: root.cumHolders1,
    cumKeeper0: root.cumKeeper0,
    fromBlock: root.fromBlock,
    toBlock: root.toBlock,
    epoch: Number(root.epoch),
    payableAt: 0,
  }));
  const uris = items.map((i) => i.uri);
  const data = encodeFunctionData({ abi: factoryAbi, functionName: 'publishMany', args: [ds as `0x${string}`[], rs as any, uris] });
  return { ds, rs, uris, data };
}
