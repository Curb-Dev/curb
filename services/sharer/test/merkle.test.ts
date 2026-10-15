// Proofs for claim and push, rebuilt from an epoch file's leaves, and the
// publish call's encoding.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData } from 'viem';
import {
  buildTree,
  chunkCid,
  chunkPath,
  leafHash,
  multiProofFor,
  parseEpochFile,
  parseEpochIndex,
  proofOf,
  runVector,
  SimpleMerkleTree,
  StandardMerkleTree,
  verifyMultiProof,
  verifyProof,
  LEAF_TYPES,
  type EpochResult,
  type Leaf,
} from '../src/calc/index.ts';
import { factoryAbi } from '../src/chain/abis.ts';
import { namesOf } from '../src/chain/indexer.ts';
import { publishArgs } from '../src/state.ts';
import { loadVector, readVectorFile } from './helpers.ts';

const v07 = loadVector('v07-keeper-fee-cap');
const file = parseEpochFile(readVectorFile(v07.epochs[3].expected.file)!);
const { tree } = buildTree(file.merkle.leaves);

test('every claim proof verifies against the file root, by hand and with the library', () => {
  assert.equal(tree.root, file.merkle.root);
  for (const l of file.merkle.leaves) {
    const p = proofOf(tree, l[1].toUpperCase().replace('0X', '0x'))!;
    assert.equal(p.cum0, BigInt(l[2]));
    assert.equal(p.cum1, BigInt(l[3]));
    assert.ok(verifyProof(file.merkle.root, leafHash(file.distributor, l[1], l[2], l[3]), p.proof));
    assert.ok(StandardMerkleTree.verify(file.merkle.root, LEAF_TYPES, l, p.proof));
  }
  assert.equal(proofOf(tree, '0x' + '7'.repeat(40)), null);
});

test('a proof is bound to its distributor, its amounts and its path', () => {
  const l = file.merkle.leaves[0];
  const p = proofOf(tree, l[1])!;
  assert.ok(!verifyProof(file.merkle.root, leafHash('0x' + 'd'.repeat(40), l[1], l[2], l[3]), p.proof), 'another distributor');
  assert.ok(!verifyProof(file.merkle.root, leafHash(l[0], l[1], BigInt(l[2]) + 1n, l[3]), p.proof), 'another amount');
  if (p.proof.length) {
    const bad = [...p.proof];
    bad[0] = '0x' + '0'.repeat(64);
    assert.ok(!verifyProof(file.merkle.root, leafHash(l[0], l[1], l[2], l[3]), bad), 'another path');
  }
});

test('a push multiproof for any subset verifies, in the order the contract consumes it', () => {
  const accounts = file.merkle.leaves.map((l) => l[1]);
  for (const subset of [accounts, accounts.slice(0, 1), accounts.filter((_, i) => i % 2 === 1)]) {
    const mp = multiProofFor(tree, subset);
    assert.equal(mp.leaves.length, subset.length);
    assert.deepEqual(new Set(mp.leaves.map((x) => x.account)), new Set(subset));
    const values = mp.leaves.map((x) => [file.distributor, x.account, x.cum0.toString(), x.cum1.toString()]);
    assert.ok(StandardMerkleTree.verifyMultiProof(file.merkle.root, LEAF_TYPES, { leaves: values, proof: mp.proof, proofFlags: mp.flags }));
  }
  assert.throws(() => multiProofFor(tree, ['0x' + '7'.repeat(40)]), /no leaf/);
});

// ------------------------------------------------ the tree is the library's

/** `n` leaves of distributor D with amounts that vary, in a scrambled order. */
function leavesOf(n: number, seed = 1): Leaf[] {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648);
  const out: Leaf[] = [];
  for (let i = 0; i < n; i++) out.push([D, '0x' + (0x5000000 + rnd()).toString(16).padStart(40, '0'), String(rnd() % 1000000), String(i % 3 === 0 ? 0 : rnd())]);
  const uniq = [...new Map(out.map((l) => [l[1], l])).values()];
  return uniq.sort(() => (rnd() % 2 ? 1 : -1));
}
const D = '0xd157000000000000000000000000000000000001';

test('within one chunk the tree is OpenZeppelin\'s StandardMerkleTree: the root, every proof, every multiproof', () => {
  for (const n of [1, 2, 3, 5, 8, 33, 100, 512]) {
    const ls = leavesOf(n, n);
    const lib = StandardMerkleTree.of(ls, LEAF_TYPES);
    const { tree } = buildTree(ls);
    assert.equal(tree.root, lib.root, `${n} leaves`);
    assert.equal(tree.chunks.length, 1);
    for (const [i, l] of lib.entries()) assert.deepEqual(proofOf(tree, l[1])!.proof, lib.getProof(i), `${n} leaves, proof ${i}`);
    for (const pick of [(i: number) => i % 2 === 0, (i: number) => i % 7 === 3, () => true]) {
      const idx = ls.map((_, i) => i).filter(pick);
      if (!idx.length) continue;
      const want = lib.getMultiProof(idx);
      const got = multiProofFor(tree, idx.map((i) => ls[i][1]));
      assert.deepEqual(got.proof, want.proof, `${n} leaves, multiproof`);
      assert.deepEqual(got.flags, want.proofFlags);
      assert.deepEqual(got.leaves.map((x) => x.account), want.leaves.map((v) => v[1]));
    }
  }
});

test('past one chunk: chunks of 512 in account order under the SimpleMerkleTree of their roots, and every proof verifies with the library', () => {
  const ls = leavesOf(1300, 7);
  assert.equal(ls.length, 1300);
  const { tree } = buildTree(ls);
  const byAcct = [...ls].sort((x, y) => (x[1] < y[1] ? -1 : 1));
  const roots = [0, 512, 1024].map((i) => StandardMerkleTree.of(byAcct.slice(i, i + 512), LEAF_TYPES).root);
  assert.deepEqual(tree.chunks.map((c) => [c.first, c.last, c.root]), [0, 512, 1024].map((i, k) => [byAcct[i][1], byAcct[Math.min(i + 511, 1299)][1], roots[k]]));
  assert.equal(tree.root, SimpleMerkleTree.of(roots).root);
  for (const l of ls.filter((_, i) => i % 13 === 0)) {
    const p = proofOf(tree, l[1])!;
    assert.ok(StandardMerkleTree.verify(tree.root, LEAF_TYPES, l, p.proof), 'the library verifies the chunk proof followed by the top proof');
    assert.ok(verifyProof(tree.root, leafHash(D, l[1], l[2], l[3]), p.proof));
  }
  // A push proves the accounts of one chunk, carried up to the root; the
  // library's generic multiproof check (the contract's algorithm) takes it.
  for (const k of [0, 1, 2]) {
    const accts = byAcct.slice(512 * k, 512 * k + 512).filter((_, i) => i % 5 === 1).map((l) => l[1]);
    const mp = multiProofFor(tree, accts);
    const values = mp.leaves.map((x): Leaf => [D, x.account, x.cum0.toString(), x.cum1.toString()]);
    assert.ok(StandardMerkleTree.verifyMultiProof(tree.root, LEAF_TYPES, { leaves: values, proof: mp.proof, proofFlags: mp.flags }), `chunk ${k}`);
    assert.ok(tree.verifyMultiProof({ leaves: values, proof: mp.proof, proofFlags: mp.flags }));
    assert.ok(verifyMultiProof(tree.root, values.map((v) => leafHash(v[0], v[1], v[2], v[3])), mp.proof, mp.flags));
    // and one changed amount fails it
    const bad = values.map((v, i): Leaf => (i === 0 ? [v[0], v[1], String(BigInt(v[2]) + 1n), v[3]] : v));
    assert.ok(!tree.verifyMultiProof({ leaves: bad, proof: mp.proof, proofFlags: mp.flags }));
  }
  assert.throws(() => multiProofFor(tree, [byAcct[0][1], byAcct[1299][1]]), /in 2 chunks of the tree/);
  assert.equal(tree.chunkOf(byAcct[600][1]), 1);
  assert.equal(proofOf(tree, '0x' + '7'.repeat(40)), null);
});

test('a chunk CID is the raw-block CID ops pins it under, from its sha256 alone', async () => {
  const { fileCid } = await import('../src/ops/cid.ts');
  const v = loadVector('v14-chunked-file');
  const x = v.epochs[1].expected;
  const index = parseEpochIndex(readVectorFile(x.file)!);
  for (const [k, rel] of x.chunkFiles.entries()) {
    const b = readVectorFile(rel)!;
    assert.equal(chunkCid(index.chunks[k]), fileCid(b), `chunk ${k}`);
    assert.equal(chunkPath(8453n, index.distributor, index.chunks[k].sha256), `sharing/8453/${index.distributor}/chunks/${index.chunks[k].sha256.slice(2)}.json`);
  }
  assert.equal(chunkCid({ sha256: index.chunks[0].sha256, size: 262_145n }), null, 'a chunk past one block has a UnixFS CID');
});

test('publishArgs encodes one publishMany whose Root fields are the epoch results', () => {
  const results = runVector(v07).filter((r): r is EpochResult => r.result === 'epoch');
  const D = v07.setup.distributor.toLowerCase();
  const args = publishArgs([
    { distributor: D, result: results[0], uri: 'ipfs://one' },
    { distributor: '0x' + 'd2'.repeat(20), result: results[1], uri: 'ipfs://two' },
  ]);
  const d = decodeFunctionData({ abi: factoryAbi, data: args.data as `0x${string}` });
  assert.equal(d.functionName, 'publishMany');
  const [ds, rs, uris] = d.args as any;
  assert.deepEqual(ds.map((x: string) => x.toLowerCase()), [D, '0x' + 'd2'.repeat(20)]);
  assert.deepEqual(uris, ['ipfs://one', 'ipfs://two']);
  assert.equal(rs[0].merkleRoot, results[0].root.merkleRoot);
  assert.equal(rs[0].contentHash, results[0].contentHash);
  assert.equal(rs[1].cumKeeper0, results[1].root.cumKeeper0);
  assert.equal(rs[1].epoch, 2);
  assert.equal(rs[1].fromBlock, results[1].root.fromBlock);
  assert.equal(rs[1].payableAt, 0);
  assert.deepEqual(namesOf(args.data), [D, '0x' + 'd2'.repeat(20)]);
});
