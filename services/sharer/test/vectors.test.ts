// Every golden vector in spec/vectors, byte for byte: the recorded outputs,
// the epoch file bytes and their sha256.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVector, runVector, sha256Hex, verifyEpochFile, parseEpochFile } from '../src/calc/index.ts';
import { loadVector, readVectorChunks, readVectorFile, vectorNames } from './helpers.ts';

const names = vectorNames();

test('the vector set is the one pinned in spec/README.md', () => {
  assert.deepEqual(names, [
    'v01-mid-epoch-transfers',
    'v02-same-block-zero-weight',
    'v03-mid-life-enable-first-epoch',
    'v04-exclusions-and-pools',
    'v05-no-epoch-cases',
    'v06-dust-carry-and-history',
    'v07-keeper-fee-cap',
    'v08-cbxrp-decimals-and-price',
    'v09-veto-recompute',
    'v10-zero-weight-with-income',
    'v11-recap-nonzero',
    'v12-weight-floor-and-dust',
    'v13-pools-on-any-factory',
    'v14-chunked-file',
    'v15-usdc-stable-quote',
  ]);
});

for (const name of names) {
  test(`golden vector ${name}: outputs and epoch file bytes`, () => {
    const v = loadVector(name);
    const results = runVector(v);
    assert.deepEqual(compareVector(name, v, results, readVectorFile), []);
    results.forEach((r, i) => {
      const want = v.epochs[i].expected;
      assert.equal(r.result, want.result);
      if (r.result !== 'epoch') return;
      const bytes = readVectorFile(want.file)!;
      assert.ok(bytes, 'recorded file exists');
      assert.equal(sha256Hex(bytes), want.contentHash);
      assert.equal(r.contentHash, want.contentHash);
      assert.equal(r.root.merkleRoot, want.merkleRoot);
      assert.equal(r.root.cumHolders0.toString(), want.cumHolders0);
      assert.equal(r.root.cumHolders1.toString(), want.cumHolders1);
      assert.equal(r.root.cumKeeper0.toString(), want.cumKeeper0);
    });
  });
}

test('every recorded epoch file passes verifyEpochFile against its recorded root, with its predecessor', () => {
  let checked = 0;
  for (const name of names) {
    const v = loadVector(name);
    let prevFile = null;
    for (const e of v.epochs) {
      const x = e.expected;
      if (x.result !== 'epoch') continue;
      const bytes = readVectorFile(x.file)!;
      const c = verifyEpochFile(
        bytes,
        {
          contentHash: x.contentHash,
          merkleRoot: x.merkleRoot,
          cumHolders0: BigInt(x.cumHolders0),
          cumHolders1: BigInt(x.cumHolders1),
          cumKeeper0: BigInt(x.cumKeeper0),
          epoch: BigInt(x.epoch),
          fromBlock: BigInt(x.fromBlock),
          toBlock: BigInt(x.toBlock),
        },
        prevFile,
        { chunks: readVectorChunks(x) },
      );
      assert.deepEqual(c.problems, [], `${name} epoch ${x.epoch}`);
      assert.equal(c.checked.length, x.chunkFiles.length, 'every chunk checked');
      checked++;
      if (!e.input.vetoed) prevFile = parseEpochFile(bytes, readVectorChunks(x));
    }
  }
  assert.equal(checked, 26);
});
