// curb-sharer core: the module API the ops package (keeper, verifier,
// guardian, publishing) calls.
//
//   Calculator (browser-safe, also in browser/curb-share.mjs):
//     computeEpoch, runVector, canonicalJson, sha256Hex, leafHash,
//     buildTree, proofOf, multiProofFor, verifyProof,
//     parseEpochFile, verifyEpochFile, stateFromEpochFile
//   Chain:
//     httpRpc / fromEip1193 -> ChainReader (adaptive eth_getLogs windows)
//     discoverSharing, readLaunchMeta, readDistributorState, readEpochHistory
//   One epoch:
//     prepareEpoch(readers, config, request)   two providers, abort on any
//                                              disagreement, then compute
//     recomputeEpochFile(...)                  the verifier's byte check
//     loadActiveState(...)                     a stateless restart from the
//                                              active epoch's file
//   Files past one chunk of rows (an index and its chunks):
//     readWholeEpoch, chunkFetcher, fetchChunks through the service's file
//     sources, each chunk checked against the sha256 its index gives
//   Complete balance states between epochs:
//     StateCache, defaultStateCache

export * from './calc/index.ts';
export { httpRpc, fromEip1193, RpcError } from './chain/rpc.ts';
export type { Rpc, HttpRpcOptions } from './chain/rpc.ts';
export { classifyLogError, getLogsAdaptive, LogWindow, LogWindowError, DEFAULT_LOG_WINDOW } from './chain/logs.ts';
export type { LogRefusal, LogWindowOptions, RawLog, LogFilter } from './chain/logs.ts';
export { ChainReader, isTransient } from './chain/reader.ts';
export {
  PROBE_INITCODE,
  PROBE_CODE_HASH,
  PROBE_CALL_GAS,
  PROBE_RETURN_CAP,
  PROBE_REQUEST_GAS,
  PROBE_MAX_INITCODE,
  PROBE_FROM,
  ProbeError,
  probeRequest,
  decodeProbeAnswer,
} from './chain/probe.ts';
export type { ProbeCall, ProbeAnswer } from './chain/probe.ts';
export type { BlockHeader, TxInfo, ReceiptInfo, CallResult, ReaderOptions } from './chain/reader.ts';
export {
  IndexerError,
  discoverSharing,
  readLaunchRecord,
  readLaunchMeta,
  launchExclusions,
  findLaunchBlock,
  replayTransfers,
  probeAccounts,
  collectKeeperTxs,
  namesOf,
  readPrice,
  readDistributorState,
  readDecimals,
  readEpochHistory,
} from './chain/indexer.ts';
export type { SharingSwitch, LaunchRecord, LaunchMeta, ProbeResult, FeedPair, RootView, DistributorState, PublishedRoot } from './chain/indexer.ts';
export * as abis from './chain/abis.ts';
export {
  gatherEpoch,
  prepareEpoch,
  recomputeEpochFile,
  fingerprint,
  feedsFor,
  checkConfig,
  ProviderDisagreement,
  EpochNotReady,
  ONCHAIN_EXCLUDED_REASON,
} from './epoch.ts';
export type { SharerConfig, EpochRequest, Gathered, PreparedEpoch, Recomputed } from './epoch.ts';
export { loadActiveState, publishArgs } from './state.ts';
export type { LoadedState, FetchFile, FetchChunk } from './state.ts';
export { readWholeEpoch, chunkFetcher, chunkSources, fetchChunks, isChunked, ChunkUnavailable } from './epoch-chunks.ts';
export { StateCache, defaultStateCache } from './state-store.ts';
