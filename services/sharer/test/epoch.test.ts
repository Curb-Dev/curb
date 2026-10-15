// The epoch pipeline's refusals: two providers that disagree on anything the
// epoch reads, a harvest that is not safe yet or not a harvest, a pending
// root, a stale previous state; and the paths around the golden ones (the
// launch block found by bisection, discovery, the distributor's own
// exclusions, the verifier's recompute, a stateless restart).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, toHex } from 'viem';
import { ChainReader } from '../src/chain/reader.ts';
import { TOPICS } from '../src/chain/abis.ts';
import { prepareEpoch, recomputeEpochFile, ProviderDisagreement, EpochNotReady, ONCHAIN_EXCLUDED_REASON, StateCache } from '../src/epoch.ts';
import { loadActiveState } from '../src/state.ts';
import { bytesEqual, canonicalJson, parseEpochFile, stateFromEpochFile, vectorFilePath, type ActiveState, type EpochResult } from '../src/calc/index.ts';
import { loadVector, readVectorFile } from './helpers.ts';
import { vectorWorld, type World } from './world.ts';
import type { MockChain } from './mock-chain.ts';

const reader = (c: MockChain, label: string) => new ChainReader(c.rpc(label), { tries: 0 });

function req(w: World, i: number, prev: ActiveState | null = null) {
  const a = w.attempts[i];
  return { distributor: w.D, harvestTx: a.harvestTx, uri: a.uri, prev, opening: prev ? undefined : w.opening, distributors: [w.D] };
}

/** Two worlds from one vector; the second one is tampered with. */
async function disagreement(name: string, attempt: number, tamper: (w: World) => void, prevOf?: (w: World) => Promise<ActiveState | null>) {
  const v = loadVector(name);
  const a = vectorWorld(v);
  const b = vectorWorld(v);
  const prev = prevOf ? await prevOf(a) : null;
  if (prevOf) await prevOf(b);
  tamper(b);
  try {
    await prepareEpoch([reader(a.chain, 'a'), reader(b.chain, 'b')], a.config, req(a, attempt, prev));
  } catch (e) {
    if (e instanceof ProviderDisagreement) return e.parts;
    throw e;
  }
  return [];
}

// ------------------------------------------------------------- disagreement

test('two providers: a missing Transfer log aborts (count and digest)', async () => {
  const parts = await disagreement('v01-mid-epoch-transfers', 0, (w) => {
    w.chain.logs = w.chain.logs.filter((l) => !(l.address === w.token && l.block === 103n));
  });
  assert.ok(parts.includes('transfers.count') && parts.includes('transfers.digest'), parts.join());
});

test('two providers: a Transfer log with another value aborts on the digest alone', async () => {
  const parts = await disagreement('v01-mid-epoch-transfers', 0, (w) => {
    const l = w.chain.logs.find((x) => x.address === w.token)!;
    l.data = '0x' + (BigInt(l.data) + 1n).toString(16).padStart(64, '0');
  });
  assert.deepEqual(parts.filter((p) => p.startsWith('transfers')), ['transfers.digest']);
});

test('two providers: another block hash at T aborts', async () => {
  const parts = await disagreement('v01-mid-epoch-transfers', 0, (w) => {
    w.chain.salt = 'other-fork';
    for (const [n, h] of [...w.chain.headers]) w.chain.setBlock(n, h.timestamp);
  });
  assert.deepEqual(parts, ['blockHashAtT']);
});

test('two providers: another timestamp of a block the weights read aborts', async () => {
  const parts = await disagreement('v01-mid-epoch-transfers', 0, (w) => {
    const h = w.chain.headers.get(105n)!;
    w.chain.headers.set(105n, { ...h, timestamp: h.timestamp + 1n });
  });
  assert.deepEqual(parts, ['timestamps']);
});

test('two providers: another income reading aborts', async () => {
  const parts = await disagreement('v01-mid-epoch-transfers', 0, (w) => {
    const D = w.D;
    const orig = w.chain.contracts.get(D)!;
    w.chain.setContract(D, (data, block) => (data.startsWith('0x') && data.slice(0, 10) === '0x' + keccak256(toHex('received0()')).slice(2, 10) ? '0x' + 1n.toString(16).padStart(64, '0') : orig(data, block)));
  });
  assert.ok(parts.includes('income') && parts.includes('distributor'), parts.join());
});

test('two providers: another pool answer aborts', async () => {
  const parts = await disagreement('v04-exclusions-and-pools', 0, (w) => {
    w.chain.contracts.delete('0x9a12000000000000000000000000000000000001');
  });
  assert.deepEqual(parts, ['pools']);
});

test('two providers: another keeper receipt aborts', async () => {
  const parts = await disagreement('v07-keeper-fee-cap', 0, (w) => {
    const t = [...w.chain.txs.values()].find((x) => x.to === w.D && (x.gasUsed ?? 0n) > 21000n)!;
    t.gasUsed = t.gasUsed! + 1n;
  });
  assert.deepEqual(parts, ['keeperTxs']);
});

test('two providers: another price answer aborts', async () => {
  const parts = await disagreement('v03-mid-life-enable-first-epoch', 0, (w) => {
    const feed = Object.values(w.config.feeds)[0].quoteUsd;
    w.chain.setContract(feed, () => {
      throw new Error('unreachable');
    });
    w.chain.contracts.delete(feed);
  });
  assert.deepEqual(parts, ['price']);
});

test('two providers: another view of the distributor exclusions aborts', async () => {
  const parts = await disagreement('v01-mid-epoch-transfers', 0, (w) => {
    w.knobs.excludedOnChain.add('0xa100000000000000000000000000000000000001');
  });
  assert.deepEqual(parts, ['excludedOnChain']);
});

test('one provider is refused unless asked for', async () => {
  const w = vectorWorld(loadVector('v01-mid-epoch-transfers'));
  await assert.rejects(prepareEpoch([reader(w.chain, 'a')], w.config, req(w, 0)), /two providers/);
  const { result } = await prepareEpoch([reader(w.chain, 'a')], w.config, req(w, 0), { allowSingleProvider: true });
  assert.equal(result.result, 'epoch');
});

// ------------------------------------------------------------- not ready

test('a harvest above the safe head is not computed', async () => {
  const w = vectorWorld(loadVector('v01-mid-epoch-transfers'));
  w.chain.safe = w.attempts[0].toBlock - 1n;
  await assert.rejects(prepareEpoch([reader(w.chain, 'a')], w.config, req(w, 0), { allowSingleProvider: true }), (e: any) => e instanceof EpochNotReady && e.code === 'not-safe');
  w.chain.safe = w.attempts[0].toBlock;
  const { result } = await prepareEpoch([reader(w.chain, 'a')], w.config, req(w, 0), { allowSingleProvider: true });
  assert.equal(result.result, 'epoch');
});

test('a reverted harvest, or a transaction to another address, is not a harvest', async () => {
  const w = vectorWorld(loadVector('v01-mid-epoch-transfers'));
  const tx = w.chain.txs.get(w.attempts[0].harvestTx)!;
  tx.status = false;
  await assert.rejects(prepareEpoch([reader(w.chain, 'a')], w.config, req(w, 0), { allowSingleProvider: true }), (e: any) => e instanceof EpochNotReady && e.code === 'bad-harvest' && /reverted/.test(e.message));
  tx.status = true;
  tx.to = '0x00000000000000000000000000000000000000aa';
  await assert.rejects(prepareEpoch([reader(w.chain, 'a')], w.config, req(w, 0), { allowSingleProvider: true }), (e: any) => e instanceof EpochNotReady && e.code === 'bad-harvest' && /not the distributor/.test(e.message));
});

test('a harvest receipt from another fork (its block hash is not the block at T) is refused', async () => {
  const w = vectorWorld(loadVector('v01-mid-epoch-transfers'));
  w.chain.txs.get(w.attempts[0].harvestTx)!.receiptBlockHash = '0x' + 'e'.repeat(64);
  await assert.rejects(prepareEpoch([reader(w.chain, 'a')], w.config, req(w, 0), { allowSingleProvider: true }), /the harvest receipt names block hash/);
});

test('no epoch is computed while a root is pending', async () => {
  const w = vectorWorld(loadVector('v01-mid-epoch-transfers'));
  w.knobs.pending = ['0x' + '1'.repeat(64), '0x' + '2'.repeat(64), 0n, 0n, 0n, 100n, 109n, 1, 999];
  await assert.rejects(prepareEpoch([reader(w.chain, 'a')], w.config, req(w, 0), { allowSingleProvider: true }), (e: any) => e instanceof EpochNotReady && e.code === 'pending-root');
  // A vetoed root clears only payableAt: computable again.
  w.knobs.pending = ['0x' + '1'.repeat(64), '0x' + '2'.repeat(64), 0n, 0n, 0n, 100n, 109n, 1, 0];
  const { result } = await prepareEpoch([reader(w.chain, 'a')], w.config, req(w, 0), { allowSingleProvider: true });
  assert.equal(result.result, 'epoch');
});

test('the previous state must be the active root: missing, extra, or another epoch', async () => {
  const w = vectorWorld(loadVector('v06-dust-carry-and-history'));
  const one = reader(w.chain, 'a');
  const r1 = (await prepareEpoch([one], w.config, req(w, 0), { allowSingleProvider: true })).result as EpochResult;
  // Before epoch 1 is active, a previous state is refused.
  await assert.rejects(prepareEpoch([one], w.config, req(w, 1, r1.next), { allowSingleProvider: true }), (e: any) => e.code === 'stale-prev');
  w.applyResult(0, r1);
  await assert.rejects(prepareEpoch([one], w.config, req(w, 1, null), { allowSingleProvider: true }), (e: any) => e.code === 'stale-prev' && /file's state is needed/.test(e.message));
  await assert.rejects(prepareEpoch([one], w.config, req(w, 1, { ...r1.next, contentHash: '0x' + 'f'.repeat(64) }), { allowSingleProvider: true }), (e: any) => e.code === 'stale-prev');
  await assert.rejects(prepareEpoch([one], w.config, req(w, 1, { ...r1.next, toBlock: r1.next.toBlock - 1n }), { allowSingleProvider: true }), (e: any) => e.code === 'stale-prev');
  await assert.rejects(prepareEpoch([one], w.config, req(w, 1, { ...r1.next, totals: { ...r1.next.totals, h0: r1.next.totals.h0 + 1n } }), { allowSingleProvider: true }), (e: any) => e.code === 'stale-prev' && /totals/.test(e.message));
  const ok = await prepareEpoch([one], w.config, req(w, 1, r1.next), { allowSingleProvider: true });
  assert.equal(ok.result.result, 'epoch');
});

test('the wrong chain, or a switch that does not point at the distributor, is refused', async () => {
  const w = vectorWorld(loadVector('v01-mid-epoch-transfers'));
  await assert.rejects(prepareEpoch([reader(w.chain, 'a')], { ...w.config, chainId: 1n }, req(w, 0), { allowSingleProvider: true }), /chain 8453, expected 1/);
  w.knobs.boundDistributor = '0x00000000000000000000000000000000000000d2';
  await assert.rejects(prepareEpoch([reader(w.chain, 'a')], w.config, req(w, 0), { allowSingleProvider: true }), /switch for .* points at/);
});

// ------------------------------------------------------------- other paths

test('without an opening state, the launch block is found by bisection and the result is the same', async () => {
  const v = loadVector('v01-mid-epoch-transfers');
  const w = vectorWorld(v);
  const ts99 = w.chain.headers.get(99n)!.timestamp;
  for (let b = 0n; b < 99n; b++) w.chain.setBlock(b, ts99 - 2n * (99n - b));
  // The registry stamps the launch block's time; its LaunchRegistered log is there.
  w.chain.addLog({ address: w.roles.registry, topics: [TOPICS.LaunchRegistered, '0x' + w.token.slice(2).padStart(64, '0'), '0x' + w.roles.curve.slice(2).padStart(64, '0'), '0x' + '0'.repeat(64)], data: '0x', block: 100n, logIndex: 99n, txHash: '0x' + 'ab'.repeat(32) });
  const r = (await prepareEpoch([reader(w.chain, 'a')], w.config, { ...req(w, 0), opening: undefined }, { allowSingleProvider: true })).result as EpochResult;
  assert.ok(bytesEqual(r.fileBytes, readVectorFile(vectorFilePath('v01-mid-epoch-transfers', 1n))!));
  assert.ok(w.chain.count('eth_getBlockByNumber') >= 6, 'bisected');

  // No LaunchRegistered log in the found block: refused, not guessed.
  const w2 = vectorWorld(v);
  for (let b = 0n; b < 99n; b++) w2.chain.setBlock(b, ts99 - 2n * (99n - b));
  await assert.rejects(prepareEpoch([reader(w2.chain, 'a')], w2.config, { ...req(w2, 0), opening: undefined }, { allowSingleProvider: true }), /0 LaunchRegistered logs/);

  // A registry record without launchedAt needs the opening state given.
  const w3 = vectorWorld(v);
  w3.knobs.recordWords = 11;
  await assert.rejects(prepareEpoch([reader(w3.chain, 'a')], w3.config, { ...req(w3, 0), opening: undefined }, { allowSingleProvider: true }), /no launchedAt/);
  const ok = await prepareEpoch([reader(w3.chain, 'a')], w3.config, req(w3, 0), { allowSingleProvider: true });
  assert.ok(bytesEqual((ok.result as EpochResult).fileBytes, readVectorFile(vectorFilePath('v01-mid-epoch-transfers', 1n))!));
});

test('other distributors are discovered from the Graduator and excluded', async () => {
  const w = vectorWorld(loadVector('v01-mid-epoch-transfers'));
  const D2 = '0xa100000000000000000000000000000000000001'; // alice, as if she were a distributor
  const ev = (token: string, d: string, block: bigint, i: bigint) =>
    w.chain.addLog({
      address: w.roles.graduator,
      topics: [TOPICS.HolderSharingEnabled, '0x' + token.slice(2).padStart(64, '0'), '0x' + d.slice(2).padStart(64, '0'), '0x' + '0'.repeat(24) + 'fac7000000000000000000000000000000000001'],
      data: '0x' + '0'.repeat(64) + '0'.repeat(64) + block.toString(16).padStart(64, '0'),
      block,
      logIndex: i,
      txHash: keccak256(toHex(`enable:${d}`)),
    });
  ev(w.token, w.D, 100n, 50n);
  ev('0x70ce000000000000000000000000000000000002', D2, 104n, 51n);
  const r = (await prepareEpoch([reader(w.chain, 'a')], w.config, { ...req(w, 0), distributors: undefined }, { allowSingleProvider: true })).result as EpochResult;
  const reasons = Object.fromEntries(r.file.rules.exclusions.map((x) => [x.address, x.reason]));
  assert.equal(reasons[D2], 'a holder distributor');
  assert.ok(!r.file.accounts.some((a) => a.a === D2 && a.w > 0n));
});

test("an account the distributor's isExcluded names is excluded off chain too", async () => {
  const w = vectorWorld(loadVector('v01-mid-epoch-transfers'));
  const alice = '0xa100000000000000000000000000000000000001';
  w.knobs.excludedOnChain.add(alice);
  const r = (await prepareEpoch([reader(w.chain, 'a'), reader(w.chain, 'b')], w.config, req(w, 0))).result as EpochResult;
  assert.equal(r.file.rules.exclusions.find((x) => x.address === alice)?.reason, ONCHAIN_EXCLUDED_REASON);
  assert.ok(!r.file.merkle.leaves.some((l) => l[1] === alice));
});

test('the verifier recomputes a published file to the same bytes, and flags a tampered one', async () => {
  const v = loadVector('v07-keeper-fee-cap');
  const w = vectorWorld(v);
  const bytes = readVectorFile(vectorFilePath('v07-keeper-fee-cap', 1n))!;
  const ok = await recomputeEpochFile([reader(w.chain, 'a'), reader(w.chain, 'b')], w.config, bytes, { prev: null, uri: w.attempts[0].uri, opening: w.opening, distributors: [w.D] });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.same, true);

  // A file claiming a different share for one account, re-rooted and re-hashed.
  const f = JSON.parse(new TextDecoder().decode(bytes));
  f.accounts[0].s0 = String(BigInt(f.accounts[0].s0) + 1n);
  const tampered = new TextEncoder().encode(canonicalJson(f));
  const bad = await recomputeEpochFile([reader(w.chain, 'a'), reader(w.chain, 'b')], w.config, tampered, { prev: null, uri: w.attempts[0].uri, opening: w.opening, distributors: [w.D] });
  assert.equal(bad.same, false);
  assert.ok(bad.problems.some((p) => /bytes differ/.test(p)));

  // A keeper tx the file lists that is not attributable changes nothing it may claim.
  const f2 = JSON.parse(new TextDecoder().decode(bytes));
  f2.keeper.txs.push({ hash: '0x' + 'a8'.repeat(32), gasUsed: '1', price: '1', l1Fee: '0', share: '1' });
  f2.keeper.txs.sort((x: any, y: any) => (x.hash < y.hash ? -1 : 1));
  const listed = new TextEncoder().encode(canonicalJson(f2));
  const w2 = vectorWorld(v);
  const stranger = [...w2.chain.txs.values()].find((t) => t.to !== w2.D && t.to !== w2.config.graduator)!;
  w2.chain.txs.set('0x' + 'a8'.repeat(32), { ...stranger, hash: '0x' + 'a8'.repeat(32) });
  const bad2 = await recomputeEpochFile([reader(w2.chain, 'a')], w2.config, listed, { prev: null, uri: w2.attempts[0].uri, opening: w2.opening, distributors: [w2.D] }, { allowSingleProvider: true });
  assert.equal(bad2.same, false);
});

test('the verifier counts keeper transactions the file lists that logged nothing (a reverted push)', async () => {
  const v = loadVector('v07-keeper-fee-cap');
  const w = vectorWorld(v);
  const h = '0x' + '7e'.repeat(32);
  w.chain.txs.set(h, { hash: h, from: v.setup.rules.keeperKeys[0].toLowerCase(), to: w.D, input: '0x', block: 105n, status: false, gasUsed: 30000n, effectiveGasPrice: 3n, l1Fee: 11n });
  const both = [reader(w.chain, 'a'), reader(w.chain, 'b')];
  const r = (await prepareEpoch(both, w.config, { ...req(w, 0), extraKeeperTxs: [h] })).result as EpochResult;
  assert.ok(r.file.keeper.txs.some((t) => t.hash === h), 'the reverted push is counted');
  const again = await recomputeEpochFile(both, w.config, r.fileBytes, { prev: null, uri: w.attempts[0].uri, opening: w.opening, distributors: [w.D] });
  assert.deepEqual(again.problems, []);
});

test('the verifier recomputes a chunked file from its index alone: the index names every chunk by its sha256', async () => {
  const v = loadVector('v14-chunked-file');
  const w = vectorWorld(v);
  const both = [reader(w.chain, 'a'), reader(w.chain, 'b')];
  const r1 = (await prepareEpoch(both, w.config, req(w, 0), { stateCache: null })).result as EpochResult;
  w.applyResult(0, r1);
  const r2 = (await prepareEpoch(both, w.config, { ...req(w, 1, r1.next), opening: w.opening }, { stateCache: null })).result as EpochResult;
  assert.equal(r2.chunks.length, 3);
  assert.ok(bytesEqual(r2.fileBytes, readVectorFile(vectorFilePath('v14-chunked-file', 2n))!));
  const fromFile = stateFromEpochFile(parseEpochFile(r1.fileBytes), r1.contentHash, w.attempts[0].uri);
  const ok = await recomputeEpochFile(both, w.config, r2.fileBytes, { prev: fromFile, uri: w.attempts[1].uri, opening: w.opening, distributors: [w.D] }, { stateCache: null });
  assert.deepEqual(ok.problems, []);
  // an index naming another chunk (one share more in it) is not the recomputed one
  const j = JSON.parse(new TextDecoder().decode(r2.fileBytes));
  const c = JSON.parse(new TextDecoder().decode(r2.chunks[1].bytes));
  c.accounts[0].s0 = String(BigInt(c.accounts[0].s0) + 1n);
  const forged = new TextEncoder().encode(canonicalJson(c));
  j.chunks[1].sha256 = '0x' + Buffer.from(await crypto.subtle.digest('SHA-256', forged)).toString('hex');
  j.chunks[1].size = String(forged.length);
  const bad = await recomputeEpochFile(both, w.config, new TextEncoder().encode(canonicalJson(j)), { prev: fromFile, uri: w.attempts[1].uri, opening: w.opening, distributors: [w.D] }, { stateCache: null });
  assert.equal(bad.same, false);
  assert.ok(bad.problems.some((p) => /bytes differ/.test(p)));
});

test('a file naming more keeper transactions than an epoch attributes is refused before any is looked up', async () => {
  const v = loadVector('v07-keeper-fee-cap');
  const w = vectorWorld(v);
  const f = JSON.parse(new TextDecoder().decode(readVectorFile(vectorFilePath('v07-keeper-fee-cap', 1n))!));
  for (let i = 0; f.keeper.txs.length < 513; i++) f.keeper.txs.push({ hash: '0xff' + i.toString(16).padStart(62, '0'), gasUsed: '1', price: '1', l1Fee: '0', share: '0' });
  const padded = new TextEncoder().encode(canonicalJson(f));
  const mark = w.chain.calls.length;
  await assert.rejects(
    recomputeEpochFile([reader(w.chain, 'a'), reader(w.chain, 'b')], w.config, padded, { prev: null, uri: w.attempts[0].uri, opening: w.opening, distributors: [w.D] }),
    /names 513 keeper transactions, more than the 512/,
  );
  assert.equal(w.chain.calls.length, mark, 'nothing was asked of the providers');
});

test('before any epoch is active, a restart has no state to load', async () => {
  const w = vectorWorld(loadVector('v06-dust-carry-and-history'));
  const loaded = await loadActiveState(reader(w.chain, 'a'), w.config.graduator, w.D, async () => { throw new Error('nothing to fetch'); }, w.attempts[0].toBlock);
  assert.equal(loaded.state, null);
  assert.equal(loaded.file, null);
});

test('a stateless restart loads the active epoch from its published file, checked against the chain', async () => {
  const v = loadVector('v06-dust-carry-and-history');
  const w = vectorWorld(v);
  const one = reader(w.chain, 'a');
  const r1 = (await prepareEpoch([one], w.config, req(w, 0), { allowSingleProvider: true })).result as EpochResult;
  w.applyResult(0, r1);
  // The publish of epoch 1, as the distributor logs it.
  const T1 = w.attempts[0].toBlock;
  const uri = w.attempts[0].uri;
  const enc = (n: bigint) => n.toString(16).padStart(64, '0');
  const uriHex = Buffer.from(uri, 'utf8').toString('hex');
  const data =
    '0x' +
    r1.root.merkleRoot.slice(2) +
    enc(r1.root.fromBlock) +
    enc(r1.root.toBlock) +
    enc(r1.root.cumHolders0) +
    enc(r1.root.cumHolders1) +
    enc(r1.root.cumKeeper0) +
    r1.root.contentHash.slice(2) +
    enc(9n * 32n) +
    enc(T1 + 100n) +
    enc(BigInt(uri.length)) +
    uriHex.padEnd(Math.ceil(uriHex.length / 64) * 64, '0');
  w.chain.addLog({ address: w.D, topics: [TOPICS.RootPublished, '0x' + enc(1n)], data, block: T1 + 1n, logIndex: 0n, txHash: '0x' + 'cd'.repeat(32) });
  w.chain.txs.set('0x' + 'cd'.repeat(32), { hash: '0x' + 'cd'.repeat(32), from: '0x00000000000000000000000000000000000beef1', to: '0xfac7000000000000000000000000000000000001', input: '0x', block: T1 + 1n });
  const files = new Map([[uri, r1.fileBytes]]);
  const fetchFile = async (u: string) => files.get(u)!;
  const at = w.attempts[1].toBlock;
  const loaded = await loadActiveState(one, w.config.graduator, w.D, fetchFile, at);
  // the file commits to the complete state; it does not list it
  assert.equal(loaded.state!.balancesAtEnd, null);
  assert.equal(canonicalJson(stateOf(loaded.state!)), canonicalJson(stateOf({ ...r1.next, balancesAtEnd: null })));
  // And the next epoch from it - its state rebuilt from the launch block,
  // found by bisection as in production, with no cache to lean on - is the
  // golden one.
  const ts9 = w.chain.headers.get(9n)!.timestamp;
  for (let b = 0n; b < 9n; b++) w.chain.setBlock(b, ts9 - 2n * (9n - b));
  w.chain.addLog({ address: w.roles.registry, topics: [TOPICS.LaunchRegistered, '0x' + w.token.slice(2).padStart(64, '0'), '0x' + w.roles.curve.slice(2).padStart(64, '0'), '0x' + '0'.repeat(64)], data: '0x', block: 10n, logIndex: 99n, txHash: '0x' + 'ab'.repeat(32) });
  const r2 = (await prepareEpoch([one], w.config, req(w, 1, loaded.state), { allowSingleProvider: true, stateCache: null })).result as EpochResult;
  assert.ok(bytesEqual(r2.fileBytes, readVectorFile(vectorFilePath('v06-dust-carry-and-history', 2n))!));

  // A file that does not hash to the active root is refused.
  files.set(uri, readVectorFile(vectorFilePath('v06-dust-carry-and-history', 2n))!);
  await assert.rejects(loadActiveState(one, w.config.graduator, w.D, fetchFile, at), /does not check/);
  files.set(uri, r1.fileBytes);

  // The event must match the active root, and be the only one for that epoch.
  const log = w.chain.logs.find((l) => l.topics[0] === TOPICS.RootPublished)!;
  const good = log.data;
  log.data = good.slice(0, 2 + 64 * 6) + 'f'.repeat(64) + good.slice(2 + 64 * 7);
  await assert.rejects(loadActiveState(reader(w.chain, 'c'), w.config.graduator, w.D, fetchFile, at), /does not match the active root/);
  log.data = good;
  w.chain.addLog({ ...log, logIndex: 1n });
  await assert.rejects(loadActiveState(reader(w.chain, 'd'), w.config.graduator, w.D, fetchFile, at), /2 RootPublished events/);
});

const stateOf = (s: ActiveState) => ({ ...s, balancesAtEnd: s.balancesAtEnd ? [...s.balancesAtEnd] : null, cum: [...s.cum] });

/** v12's first epoch, computed on its world, and the state its file leaves. */
async function v12FromFile() {
  const v = loadVector('v12-weight-floor-and-dust');
  const w = vectorWorld(v);
  const r1 = (await prepareEpoch([reader(w.chain, 'a')], w.config, req(w, 0), { allowSingleProvider: true, stateCache: null })).result as EpochResult;
  w.applyResult(0, r1);
  const fromFile = stateFromEpochFile(parseEpochFile(r1.fileBytes), r1.contentHash, w.attempts[0].uri);
  return { v, w, r1, fromFile };
}

test('a later epoch rebuilds the complete state from the token logs and checks it against the file: dust it never listed included', async () => {
  const { w, r1, fromFile } = await v12FromFile();
  // the file lists two balances and commits to sixteen
  assert.equal(Object.keys(r1.file.balancesAtEnd).length, 2);
  assert.equal(fromFile.stateAtEnd.count, 16n);
  const c = w.chain;
  const before = c.calls.length;
  const r2 = (await prepareEpoch([reader(c, 'a'), reader(c, 'b')], w.config, { ...req(w, 1, fromFile), opening: w.opening }, { stateCache: null })).result as EpochResult;
  assert.ok(bytesEqual(r2.fileBytes, readVectorFile(vectorFilePath('v12-weight-floor-and-dust', 2n))!), 'the golden epoch 2');
  const replays = c.calls.slice(before).filter((x) => x.method === 'eth_getLogs' && String(x.params[0].address).toLowerCase() === w.token);
  assert.ok(replays.some((x) => BigInt(x.params[0].fromBlock) <= 100n), 'the state was rebuilt from before sharingSince');
  // With only the listed balances as the opening state, the dust holder's
  // send in block 112 would go below zero: the complete state is needed.
  const listedOnly = { ...fromFile, balancesAtEnd: new Map(Object.entries(r1.file.balancesAtEnd)) };
  await assert.rejects(prepareEpoch([reader(c, 'a')], w.config, req(w, 1, listedOnly), { allowSingleProvider: true, stateCache: null }), /goes below zero/);
});

test('a rebuilt state that is not the one the active file commits to is refused, whatever part differs', async () => {
  const { w, r1, fromFile } = await v12FromFile();
  for (const bad of [
    { ...fromFile.stateAtEnd, digest: '0x' + '1'.repeat(64) },
    { ...fromFile.stateAtEnd, count: fromFile.stateAtEnd.count + 1n },
    { ...fromFile.stateAtEnd, supply: fromFile.stateAtEnd.supply - 1n },
  ]) {
    await assert.rejects(
      prepareEpoch([reader(w.chain, 'a')], w.config, { ...req(w, 1, { ...fromFile, stateAtEnd: bad }), opening: w.opening }, { allowSingleProvider: true, stateCache: null }),
      /rebuilt from the chain .* are not the ones epoch 1's file commits to/,
    );
  }
  // A chain whose history before the window is not what the file committed
  // to (frank sent gina 2, not 1, in block 107) is refused the same way.
  const moved = vectorWorld(loadVector('v12-weight-floor-and-dust'));
  const l = moved.chain.logs.find((x) => x.address === moved.token && x.block === 107n && x.logIndex === 1n)!;
  l.data = '0x' + (2n).toString(16).padStart(64, '0');
  moved.applyResult(0, r1);
  await assert.rejects(
    prepareEpoch([reader(moved.chain, 'm')], moved.config, { ...req(moved, 1, fromFile), opening: moved.opening }, { allowSingleProvider: true, stateCache: null }),
    /are not the ones epoch 1's file commits to/,
  );
});

test('the state cache: a computed state is reused for the next epoch, a rebuilt one for the next attempt, a foreign one never', async () => {
  const { w, r1, fromFile } = await v12FromFile();
  const c = w.chain;
  const tokenLogsFrom = (from: number) => c.calls.slice(from).filter((x) => x.method === 'eth_getLogs' && String(x.params[0].address).toLowerCase() === w.token).map((x) => BigInt(x.params[0].fromBlock));
  // The state epoch 1 computed (its T, its commitment) goes into the cache...
  const cache = new StateCache();
  const one = reader(c, 'a');
  await prepareEpoch([one], w.config, req(w, 0), { allowSingleProvider: true, stateCache: cache });
  assert.equal(cache.size, 1);
  // ...so the next epoch, from the file alone, reads only its own window.
  let mark = c.calls.length;
  const r2 = (await prepareEpoch([one, reader(c, 'b')], w.config, req(w, 1, fromFile), { stateCache: cache })).result as EpochResult;
  assert.ok(bytesEqual(r2.fileBytes, readVectorFile(vectorFilePath('v12-weight-floor-and-dust', 2n))!));
  assert.ok(tokenLogsFrom(mark).every((b) => b > r1.root.toBlock), `only the logs of the window: ${tokenLogsFrom(mark)}`);
  // A rebuilt state is kept too: the second attempt on the same active
  // epoch does not replay the history again.
  const fresh = new StateCache();
  mark = c.calls.length;
  await prepareEpoch([one], w.config, { ...req(w, 1, fromFile), opening: w.opening }, { allowSingleProvider: true, stateCache: fresh });
  assert.ok(tokenLogsFrom(mark).some((b) => b <= 100n), 'the first attempt rebuilt the state');
  mark = c.calls.length;
  await prepareEpoch([one], w.config, { ...req(w, 1, fromFile), opening: w.opening }, { allowSingleProvider: true, stateCache: fresh });
  assert.ok(tokenLogsFrom(mark).every((b) => b > r1.root.toBlock), 'the second did not');
  // An entry at the same block that is not the committed state is a miss.
  const wrong = new StateCache();
  wrong.put(8453n, w.token, r1.root.toBlock, new Map([[w.token, 1n]]), { ...fromFile.stateAtEnd, digest: '0x' + '2'.repeat(64) });
  mark = c.calls.length;
  const r2b = (await prepareEpoch([one], w.config, { ...req(w, 1, fromFile), opening: w.opening }, { allowSingleProvider: true, stateCache: wrong })).result as EpochResult;
  assert.ok(bytesEqual(r2b.fileBytes, r2.fileBytes));
  assert.ok(tokenLogsFrom(mark).some((b) => b <= 100n), 'rebuilt, not taken from the wrong entry');
});

test('the state cache keeps the newest states within its bounds', () => {
  const cache = new StateCache(5, 3);
  const m = (n: number) => new Map(Array.from({ length: n }, (_, i) => [String(i), 1n] as [string, bigint]));
  const c = { count: 1n, digest: '0x' + '0'.repeat(64), supply: 1n };
  cache.put(1n, '0xt', 1n, m(2), c);
  cache.put(1n, '0xt', 2n, m(2), c);
  assert.ok(cache.get(1n, '0xt', 1n, c), 'within both bounds');
  cache.put(1n, '0xt', 3n, m(2), c); // 6 balances > 5: the least recently used (block 2) goes
  assert.equal(cache.get(1n, '0xt', 2n, c), null);
  assert.ok(cache.get(1n, '0xt', 1n, c) && cache.get(1n, '0xt', 3n, c));
  cache.put(1n, '0xt', 4n, m(9), c); // larger than the bound alone: it is kept, the rest go
  assert.equal(cache.size, 1);
  assert.ok(cache.get(1n, '0xT', 4n, c), 'the token in any letter case');
});

test('stateFromEpochFile on a golden file equals the in-memory state', () => {
  const v = loadVector('v09-veto-recompute');
  const bytes = readVectorFile(v.epochs[2].expected.file)!;
  const s = stateFromEpochFile(parseEpochFile(bytes), v.epochs[2].expected.contentHash, 'ipfs://x');
  assert.equal(s.epoch, 3n);
  assert.equal(s.totals.h0.toString(), v.epochs[2].expected.cumHolders0);
  assert.equal(s.totals.k0.toString(), v.epochs[2].expected.cumKeeper0);
});
