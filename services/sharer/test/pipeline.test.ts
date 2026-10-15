// The whole pipeline - indexer, two-provider comparison, calculator, epoch
// file - against a mock chain built from each golden vector. Every attempt
// must reproduce the vector's recorded outputs and file bytes, both when the
// next epoch starts from the in-memory state and when it starts from the
// re-read file (a stateless restart: its complete state rebuilt from the
// token's logs, with no cache, and checked against the file's stateAtEnd).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, parseEpochFile, stateFromEpochFile, vectorChunkPath, vectorFilePath, bytesEqual, type ActiveState } from '../src/calc/index.ts';
import { ChainReader } from '../src/chain/reader.ts';
import { prepareEpoch } from '../src/epoch.ts';
import { loadVector, readVectorFile, vectorNames } from './helpers.ts';
import { vectorWorld } from './world.ts';

export async function runWorld(name: string, mode: 'incremental' | 'stateless') {
  const v = loadVector(name);
  const w = vectorWorld(v);
  const readers = [new ChainReader(w.chain.rpc('primary')), new ChainReader(w.chain.rpc('secondary'))];
  let prev: ActiveState | null = null;
  const out: { expected: any; bytes: Uint8Array | null; chunks: Uint8Array[] }[] = [];
  for (let i = 0; i < w.attempts.length; i++) {
    const a = w.attempts[i];
    const { result } = await prepareEpoch(readers, w.config, { distributor: w.D, harvestTx: a.harvestTx, uri: a.uri, prev, opening: w.opening, distributors: [w.D] }, { stateCache: null });
    out.push({ expected: result.expected, bytes: result.result === 'epoch' ? result.fileBytes : null, chunks: result.result === 'epoch' ? result.chunks.map((c) => c.bytes) : [] });
    w.applyResult(i, result);
    if (result.result === 'epoch' && !a.vetoed) {
      // a stateless restart reads the index and every chunk it names
      prev = mode === 'incremental' ? result.next : stateFromEpochFile(parseEpochFile(result.fileBytes, result.chunks.map((c) => c.bytes)), result.contentHash, a.uri);
    }
  }
  return { v, out, chain: w.chain };
}

for (const name of vectorNames()) {
  for (const mode of ['incremental', 'stateless'] as const) {
    test(`pipeline on a mock chain reproduces ${name} byte for byte (${mode})`, async () => {
      const { v, out } = await runWorld(name, mode);
      out.forEach((o, i) => {
        const want = { ...v.epochs[i].expected };
        delete want.file;
        delete want.chunkFiles;
        assert.equal(canonicalJson(o.expected), canonicalJson(want), `${name} attempt ${i + 1}`);
        if (!o.bytes) return;
        const epoch = BigInt(v.epochs[i].expected.epoch);
        assert.ok(bytesEqual(o.bytes, readVectorFile(vectorFilePath(name, epoch))!), `${name} attempt ${i + 1} file bytes`);
        assert.equal(o.chunks.length, v.epochs[i].expected.chunkFiles.length);
        o.chunks.forEach((c, k) => assert.ok(bytesEqual(c, readVectorFile(vectorChunkPath(name, epoch, k))!), `${name} attempt ${i + 1} chunk ${k}`));
      });
    });
  }
}
