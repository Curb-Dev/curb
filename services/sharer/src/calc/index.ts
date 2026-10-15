// The CURB-SHARE v1 calculator: browser-safe, no Node built-ins. This is the
// entry of the ESM bundle the web verify panel loads (browser/curb-share.mjs).

export * from './types.ts';
export { canonicalJson, canonicalBytes, sha256Hex, keccakHex, leafHash, transfersDigest, balancesDigest, utf8, utf8Decode } from './encoding.ts';
export { InputError, normaliseSetup, normaliseInput, checkSetup, byBlockAndIndex } from './validate.ts';
export {
  SPEC_VERSION,
  SCHEMA,
  MAX_KEEPER_FEE_BPS,
  BPS,
  WAD,
  WEIGHT_FLOOR_DIVISOR,
  MAX_KEEPER_TXS,
  CHUNK_SCHEMA,
  ZERO_ADDRESS,
  DEAD_ADDRESS,
  priceValue,
  windowOf,
  timestampsNeeded,
  accountsToProbe,
  poolReason,
  commitState,
  baseExclusions,
  computeEpoch,
} from './share.ts';
export { LEAF_TYPES, LEAF_ENCODING, CHUNK_ACCOUNTS, ShareTree, buildTree, proofOf, multiProofFor, verifyProof, verifyMultiProof, StandardMerkleTree, SimpleMerkleTree } from './merkle.ts';
export type { ClaimProof, PushBatch } from './merkle.ts';
export {
  encodeEpoch,
  parseEpochIndex,
  parseEpochChunk,
  parseEpochFile,
  assembleEpochFile,
  readEpochFile,
  epochPart,
  chunkIndexOf,
  chunkPath,
  chunkCid,
  treeOf,
  ChunksNeeded,
  verifyEpochFile,
  stateFromEpochFile,
} from './file.ts';
export type { EncodedEpoch, ChunkSource, OnChainRoot, FileCheck, VerifyParts } from './file.ts';
export { runVector, compareVector, vectorFilePath, vectorChunkPath, bytesEqual } from './vector.ts';
export type { VectorMismatch } from './vector.ts';
