// An epoch past one chunk of rows, end to end on the simulated chain: more
// than CHUNK_ACCOUNTS (512) holders earn, so the file the chain hashes is an
// index and its rows are in chunk files (calc/file.ts). The keeper writes,
// pins and reads back every chunk before the index and before publishMany;
// the verifier and the guardian fetch every chunk from the site and judge
// the epoch ok; a holder claims with the proof the site's view gives (the
// index and the one chunk holding it); the keeper pushes the rest, one chunk
// to a batch; a keeper that lost /data rebuilds from the whole file; and the
// next epoch, which opens from the chunked active file (loadActiveState), is
// published, verified and paid the same way. A chunk the keeper cannot place
// keeps the whole epoch off the chain, and one the guardian cannot fetch is
// UNAVAILABLE or HASH - like a file's copies, never a verdict on the root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeEventLog, decodeFunctionData, encodeFunctionData, keccak256, toHex } from 'viem';
import { opsWorld } from './sim/world.ts';
import { tick, js, alertKeys } from './sim/helpers.ts';
import { claimAbi } from './sim/chain.ts';
import { watchTick, REASONS } from '../src/ops/verify.ts';
import { rebuild } from '../src/ops/rebuild.ts';
import { opsDistributorAbi, opsFactoryAbi } from '../src/ops/abis.ts';
import { CHUNK_ACCOUNTS, chunkCid, chunkIndexOf, chunkPath, epochPart, parseEpochFile, parseEpochIndex, proofOf, sha256Hex, treeOf } from '../src/calc/index.ts';

const N = 600; // two chunks: 512 rows and 88
const holders: Record<string, bigint> = {};
for (let i = 0; i < N; i++) holders['0x' + keccak256(toHex(`chunked holder ${i}`)).slice(26)] = BigInt((i % 40) + 1) * 10n ** 18n;

/** The rows of the index and its chunks as the data repo holds them. */
function published(w: ReturnType<typeof opsWorld>, D: string, epoch: number) {
  const bytes = w.net.repo.get(`sharing/8453/${D}/${epoch}.json`)!.bytes;
  const index = parseEpochIndex(bytes);
  const chunk = (k: number) => w.net.repo.get(chunkPath(8453n, D, index.chunks[k].sha256))?.bytes ?? null;
  return { bytes, index, chunk };
}

/** The accounts each push of `D` mined since tx `from` carried. */
function pushes(w: ReturnType<typeof opsWorld>, D: string, from: number): string[][] {
  return [...w.sim.txs.values()]
    .slice(from)
    .filter((t) => t.to === D && t.status && t.input.startsWith(encodeFunctionData({ abi: opsDistributorAbi, functionName: 'push', args: [[], [], []] }).slice(0, 10)))
    .map((t) => (decodeFunctionData({ abi: opsDistributorAbi, data: t.input as `0x${string}` }).args![0] as readonly { account: string }[]).map((l) => l.account.toLowerCase()));
}

test(`an epoch of more than ${CHUNK_ACCOUNTS} earning accounts: published chunks first, verified, claimed, pushed one chunk to a batch, and the next epoch too`, { timeout: 240_000 }, async () => {
  const w = opsWorld({ holders });
  const L = w.launches[0];
  const D = L.D;
  // what the data repo held at each commit, and how many roots were on chain then
  const commits: { path: string; published: number }[] = [];
  w.net.beforeCommit = (path) => commits.push({ path, published: w.sim.launch(D).lastProposed });

  // ---- epoch 1: the keeper publishes the chunks, then the index, then the root
  const k = w.make('keeper');
  w.pass(3601);
  const r1 = await tick(w, k);
  assert.deepEqual(r1.errors, [], js(r1.errors));
  assert.equal(r1.published.length, 1, js(r1.status));
  const e1 = published(w, D, 1);
  assert.equal(e1.index.rows.length, 0, 'the rows are not in the index');
  assert.equal(e1.index.chunks.length, 2, js(e1.index.chunks.map((c) => c.count)));
  assert.deepEqual(e1.index.chunks.map((c) => Number(c.count)), [CHUNK_ACCOUNTS, N - CHUNK_ACCOUNTS], 'every holder earns');
  const indexAt = commits.findIndex((c) => c.path === `sharing/8453/${D}/1.json`);
  for (const [i, c] of e1.index.chunks.entries()) {
    const at = commits.findIndex((x) => x.path === chunkPath(8453n, D, c.sha256));
    assert.ok(at >= 0 && at < indexAt, `chunk ${i} is in the data repo before the index`);
    assert.equal(commits[at].published, 0, `chunk ${i} is written before publishMany`);
    assert.ok(w.net.blocks.has(chunkCid(c)!), `chunk ${i} is pinned under the CID its index gives`);
  }
  assert.equal(w.sim.launch(D).pending.contentHash, sha256Hex(e1.bytes), 'the chain holds the hash of the index');

  // ---- the verifier and the guardian fetch every chunk and find it ok
  const g = w.make('guardian');
  const heard = w.net.log.length;
  const gr = await watchTick(g.ctx, g.keys.guardian);
  assert.deepEqual(gr.errors, [], js(gr.errors));
  assert.deepEqual(gr.results.map((x) => [x.epoch, x.verdict, x.problems]), [[1n, 'ok', []]]);
  assert.deepEqual(gr.vetoed, []);
  assert.equal(gr.froze, null);
  const v = w.make('verify');
  const vr = await watchTick(v.ctx, null);
  assert.deepEqual(vr.results.map((x) => [x.epoch, x.verdict, x.problems]), [[1n, 'ok', []]]);
  for (const c of e1.index.chunks) assert.equal(w.net.log.slice(heard).filter((x) => x.url === `https://site.test/${chunkPath(8453n, D, c.sha256)}` && x.status === 200).length, 2, 'the guardian and the verifier each read each chunk from the site');
  assert.ok(!alertKeys(g).some((x) => /^(mismatch|unverified|many-bad|frozen)/.test(x)), js(alertKeys(g)));

  // ---- the hour passes: a holder of the second chunk claims, with the
  // proof the site's view gives (the index and that one chunk)
  w.pass(3601);
  const who = e1.index.chunks[1].first;
  const kc = chunkIndexOf(e1.index, who);
  assert.equal(kc, 1);
  const part = epochPart(e1.bytes, kc, e1.chunk(kc));
  const proof = proofOf(treeOf(part), who)!;
  assert.ok(proof && proof.cum0 > 0n, 'the account has a leaf');
  const claimed = w.sim.userTx(who, D, encodeFunctionData({ abi: claimAbi, functionName: 'claim', args: [proof.cum0, proof.cum1, proof.proof as `0x${string}`[], '0x0000000000000000000000000000000000000000'] }));
  assert.ok(claimed.ok, 'the claim is paid');
  assert.equal(w.sim.launch(D).active.epoch, 1, 'the claim activated the root');
  assert.equal(w.sim.launch(D).paid0.get(who), proof.cum0);
  const paid = w.sim.logs.filter((l) => l.txHash === claimed.hash && l.address === D).map((l) => decodeEventLog({ abi: opsDistributorAbi, topics: l.topics as any, data: l.data as `0x${string}` })).find((e) => e.eventName === 'Paid')!;
  assert.equal((paid.args as any).pushed, false, 'a claim, not a push');

  // ---- the keeper pushes everybody else, each batch within one chunk
  const n0 = w.sim.txs.size;
  const r2 = await tick(w, k);
  assert.deepEqual(r2.errors, [], js(r2.errors));
  const batches = pushes(w, D, n0);
  const tree1 = treeOf(parseEpochFile(e1.bytes, [e1.chunk(0)!, e1.chunk(1)!]));
  // as few as the caps allow: chunk 0's 512 leaves, then chunk 1's 87 left after the claim
  const kk = k.ctx.cfg.keeper;
  const cap = Math.min(kk.maxLeavesPerPush, Number((kk.maxPushGas - kk.gas.pushBase) / kk.gas.pushFirstLeaf));
  assert.equal(batches.length, Math.ceil(CHUNK_ACCOUNTS / cap) + Math.ceil((N - CHUNK_ACCOUNTS - 1) / cap), js(batches.map((b) => b.length)));
  for (const b of batches) assert.equal(new Set(b.map((a) => tree1.chunkOf(a))).size, 1, 'one chunk to a push');
  assert.deepEqual(new Set(batches.flatMap((b) => b.map((a) => tree1.chunkOf(a)))), new Set([0, 1]), 'both chunks pushed');
  assert.ok(!batches.flat().includes(who), 'the claimed leaf is not pushed again');
  const L1 = w.sim.launch(D);
  for (const a of Object.keys(holders)) assert.ok((L1.paid0.get(a) ?? 0n) > 0n, `${a} is paid`);
  assert.equal(L1.totalPaid0, L1.active.cumHolders0, 'every holder paid in full');

  // ---- a keeper that lost its /data rebuilds from the chain and the whole files
  const kr = w.make('keeper', { holder: 'rebuilt' });
  const rb = await rebuild(kr.ctx);
  assert.deepEqual(rb.files.map((f) => [f.epoch, f.ok, f.error ?? '']), [[1n, true, '']]);
  assert.equal(Object.keys(kr.ctx.store.get<Record<string, { at: Record<string, number> }>>('lastHeld', {})[D]?.at ?? {}).length, N, 'the held-at memory of every holder, from every chunk');

  // ---- epoch 2 opens from the chunked active file, and goes the same way
  w.sim.income(D, 10n ** 18n);
  w.pass(3601);
  const r3 = await tick(w, k);
  assert.deepEqual(r3.errors, [], js(r3.errors));
  assert.equal(r3.published.length, 1, js(r3.status));
  const e2 = published(w, D, 2);
  assert.equal(e2.index.chunks.length, 2);
  assert.equal(e2.index.prev?.epoch, 1n);
  const gr2 = await watchTick(g.ctx, g.keys.guardian);
  assert.deepEqual(gr2.results.map((x) => [x.epoch, x.verdict, x.problems]), [[2n, 'ok', []]]);
  const g2 = w.make('guardian', { holder: 'a fresh guardian' });
  const gr3 = await watchTick(g2.ctx, g2.keys.guardian);
  assert.deepEqual(gr3.results.map((x) => [x.epoch, x.verdict, x.problems]).sort(), [[1n, 'ok', []], [2n, 'ok', []]].sort(), 'a guardian with an empty cache reads both whole');
  w.pass(3601);
  const r4 = await tick(w, k);
  assert.deepEqual(r4.errors, [], js(r4.errors));
  const L2 = w.sim.launch(D);
  assert.equal(L2.active.epoch, 2);
  assert.equal(L2.totalPaid0, L2.active.cumHolders0, 'epoch 2 paid in full too');
  assert.equal([...w.sim.txs.values()].filter((t) => t.to === w.sim.addr.factory && t.input.startsWith(encodeFunctionData({ abi: opsFactoryAbi, functionName: 'freeze' }))).length, 0, 'nothing froze');
});

test('a chunk the keeper cannot place keeps its epoch off the chain: refused by the data repo, or served wrong by the site', { timeout: 240_000 }, async () => {
  for (const [what, fault, why] of [
    ['the data repo refuses the chunks', (w: ReturnType<typeof opsWorld>) => (w.net.refuseWrites = /\/chunks\//), /chunk 0 \(.*\): data repo/],
    ['the site serves other bytes for a chunk', (w: ReturnType<typeof opsWorld>) => (w.net.siteTamper = (path, b) => (path.includes('/chunks/') ? new TextEncoder().encode('{"not":"it"}') : b)), /chunk 0 \(.*\): read back: site serves other bytes/],
  ] as const) {
    const w = opsWorld({ holders });
    const D = w.launches[0].D;
    fault(w);
    const k = w.make('keeper');
    w.pass(3601);
    const r = await tick(w, k);
    assert.equal(r.published.length, 0, what);
    assert.match(r.errors.join('; '), why, `${what}: ${js(r.errors)}`);
    assert.equal(w.sim.launch(D).lastProposed, 0, `${what}: no root on chain`);
    assert.ok(!w.net.repo.has(`sharing/8453/${D}/1.json`), `${what}: nor the index in the data repo`);
    assert.ok(alertKeys(k).includes(`publish-failed:${D}:1`), js(alertKeys(k)));
  }
});

test('a chunk served only wrong is HASH and one nobody serves is UNAVAILABLE: never INVALID, no veto at once, no freeze', { timeout: 240_000 }, async () => {
  const w = opsWorld({ holders });
  const D = w.launches[0].D;
  const k = w.make('keeper');
  w.pass(3601);
  assert.equal((await tick(w, k)).published.length, 1);
  const { index } = published(w, D, 1);
  const c1 = chunkPath(8453n, D, index.chunks[1].sha256);
  w.net.gatewayDown = true;
  w.net.siteTamper = (path, b) => (path === c1 ? new TextEncoder().encode('{"not":"it"}') : b);
  const g = w.make('guardian');
  const r = await watchTick(g.ctx, g.keys.guardian);
  assert.deepEqual(r.results.map((x) => [x.verdict, x.reason]), [['unverifiable', REASONS.HASH]], js(r.results));
  assert.match(r.results[0].problems.join('; '), /chunk .* do not match the sha256/);
  w.net.siteTamper = null;
  w.net.repo.delete(c1);
  const g2 = w.make('guardian', { holder: 'another guardian' });
  const r2 = await watchTick(g2.ctx, g2.keys.guardian);
  assert.deepEqual(r2.results.map((x) => [x.verdict, x.reason]), [['unverifiable', REASONS.UNAVAILABLE]], js(r2.results));
  for (const x of [r, r2]) {
    assert.deepEqual(x.vetoed, [], 'unverifiable: vetoed only after its grace, or late');
    assert.equal(x.froze, null);
  }
  assert.ok(w.sim.launch(D).pending.payableAt > 0n, 'still pending');
  assert.equal(w.sim.state.factory.frozen, false);
});
