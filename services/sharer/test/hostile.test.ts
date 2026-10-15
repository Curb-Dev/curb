// What an outsider can put in front of the indexer, and a config written by
// hand: an address that burns all the gas it is given (anybody can send
// tokens to one, and every address that weighs is probed), many contracts
// that revert, 1-wei dust sprayed to thousands of fresh addresses, a keeper
// journal holding a hash that never landed or months-old sends, and a feed
// written in any letter case. None of them may stop an epoch, make the probe
// cost a request per such address, grow the epoch file, or make two
// providers, or a keeper and a verifier, disagree.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, getAddress } from 'viem';
import { ChainReader } from '../src/chain/reader.ts';
import { PROBE_CALL_GAS, PROBE_FROM, PROBE_INITCODE, PROBE_REQUEST_GAS, ProbeError } from '../src/chain/probe.ts';
import { distributorAbi, poolAbi, TOPICS } from '../src/chain/abis.ts';
import { collectKeeperTxs, probeAccounts } from '../src/chain/indexer.ts';
import { checkConfig, feedsFor, gatherEpoch, keeperJournalHashes, prepareEpoch } from '../src/epoch.ts';
import { InputError } from '../src/calc/validate.ts';
import {
  chunkIndexOf,
  epochPart,
  leafHash,
  parseEpochFile,
  parseEpochIndex,
  proofOf,
  runVector,
  stateFromEpochFile,
  treeOf,
  verifyProof,
  type ActiveState,
  type EpochResult,
} from '../src/calc/index.ts';
import { abiContract, MockChain, Revert } from './mock-chain.ts';
import { loadVector } from './helpers.ts';
import { vectorWorld, type World } from './world.ts';

const A = (n: number) => '0x' + n.toString(16).padStart(40, '0');
const EATER = A(8); // precompile 0x08: a token0() call burns every bit of gas it gets
const T0 = A(0x70ce);
const sel = (f: 'token0' | 'token1' | 'factory') => encodeFunctionData({ abi: poolAbi, functionName: f });
const isEx = (a: string) => encodeFunctionData({ abi: distributorAbi, functionName: 'isExcluded', args: [a as `0x${string}`] });

function chainWithAPool() {
  const c = new MockChain();
  const D = A(0xd157);
  const pool = A(0x9a12);
  c.setContract(D, abiContract(distributorAbi, { isExcluded: () => false }));
  c.setContract(pool, abiContract(poolAbi, { token0: () => T0, token1: () => A(0x4200), factory: () => A(0xf) }));
  c.eaters.add(EATER);
  return { c, D, pool };
}

const ethCalls = (c: MockChain) => c.calls.filter((x) => x.method === 'eth_call').map((x) => x.params[0]);
const probeCalls = (c: MockChain) => ethCalls(c).filter((x) => x.to == null);

/** The targets a probe request carries, in order. */
function targetsOf(data: string): string[] {
  const hex = data.slice(PROBE_INITCODE.length, -64);
  const out: string[] = [];
  for (let p = 0; p < hex.length; ) {
    out.push('0x' + hex.slice(p, p + 40));
    p += 44 + parseInt(hex.slice(p + 40, p + 44), 16) * 2;
  }
  return out;
}

test('reader: one probe request answers every call, whatever burns its gas, as a deployless eth_call with the pinned gas', async () => {
  const { c, D, pool } = chainWithAPool();
  const calls = [
    { to: EATER, data: sel('token0') },
    { to: EATER, data: sel('token1') },
    { to: EATER, data: sel('factory') },
    { to: pool, data: sel('token0') },
    { to: D, data: isEx(pool) },
  ];
  const got = await new ChainReader(c.rpc(), { tries: 0 }).callMany(calls, 9n);
  assert.deepEqual(got.map((r) => r.success), [false, false, false, true, true]);
  assert.equal(BigInt(got[3].returnData), BigInt(T0));
  const asked = ethCalls(c);
  assert.equal(asked.length, 1, 'one request, nothing asked again');
  const [q] = asked;
  assert.equal(q.to, undefined, 'no `to`: the creation code runs');
  assert.equal(q.from, PROBE_FROM);
  assert.equal(q.gas, '0x' + PROBE_REQUEST_GAS.toString(16));
  assert.ok(q.data.startsWith(PROBE_INITCODE), 'the pinned SharerProbe code');
  assert.deepEqual(targetsOf(q.data), calls.map((x) => x.to));
  assert.equal(BigInt('0x' + q.data.slice(-64)) * 2n, BigInt(q.data.length - PROBE_INITCODE.length - 64), 'the length word');
  assert.equal(PROBE_CALL_GAS, 100_000n);
});

test('reader: a thousand reverting contracts cost exactly the requests a thousand accounts without code do', async () => {
  const count = async (setup: (c: MockChain, a: string) => void) => {
    const { c, D } = chainWithAPool();
    const accounts = Array.from({ length: 1000 }, (_, i) => A(0x100000 + i));
    for (const a of accounts) setup(c, a);
    const res = await probeAccounts(new ChainReader(c.rpc(), { tries: 0 }), D, accounts, 9n);
    assert.equal(res.contracts.size, 0);
    return probeCalls(c).length;
  };
  const eoas = await count(() => {});
  const reverting = await count((c, a) =>
    c.setContract(a, () => {
      throw new Revert('no');
    }),
  );
  assert.equal(reverting, eoas, 'a revert costs no request of its own');
  // 4,000 calls: a few requests, where asking every failed call again took 3,000 more
  assert.ok(eoas <= 8, `${eoas} requests for 4,000 calls`);
});

test('reader: a request that stops early is continued from the first call it did not answer, and no call is asked twice', async () => {
  const { c, D, pool } = chainWithAPool();
  const eaters = Array.from({ length: 300 }, (_, i) => A(0x200000 + i));
  for (const e of eaters) c.eaters.add(e);
  const accounts = [...eaters.slice(0, 150), pool, ...eaters.slice(150)];
  const res = await probeAccounts(new ChainReader(c.rpc(), { tries: 0 }), D, accounts, 9n);
  assert.deepEqual([...res.contracts.keys()], [pool], 'the pool behind 450 burnt calls is found');
  const asked = probeCalls(c);
  assert.ok(asked.length > 3, `the burners made requests stop early (${asked.length} requests)`);
  assert.equal(c.probeRequests.length, asked.length);
  assert.equal(c.probeRequests.reduce((x, y) => x + y, 0), 4 * accounts.length, 'every call answered exactly once');
  // each request starts at the first call the one before it did not answer
  const all = accounts.flatMap((a) => [a, a, a, D]);
  let at = 0;
  asked.forEach((q, k) => {
    const t = targetsOf(q.data);
    assert.deepEqual(t.slice(0, c.probeRequests[k]), all.slice(at, at + c.probeRequests[k]), `request ${k}`);
    at += c.probeRequests[k];
  });
});

test('reader: a call the probe cannot carry is refused before anything is asked', async () => {
  const { c } = chainWithAPool();
  const r = new ChainReader(c.rpc(), { tries: 0 });
  await assert.rejects(r.callMany([{ to: '0x123', data: '0x' }], 9n), ProbeError);
  await assert.rejects(r.callMany([{ to: A(1), data: '0xabc' }], 9n), ProbeError);
  await assert.rejects(r.callMany([{ to: A(1), data: '0x' + '00'.repeat(49_000) }], 9n), /does not fit/);
  assert.equal(c.calls.length, 0);
  // an address in any letter case is the same call
  const mixed = '0x' + 'aB'.repeat(20);
  c.setContract(mixed, () => '0x' + '0'.repeat(63) + '1');
  const got = await r.callMany([{ to: mixed, data: '0x' }, { to: mixed.toLowerCase(), data: '0x' }], 9n);
  assert.deepEqual(got[0], got[1]);
  assert.equal(got[0].success, true);
});

test('probeAccounts: an address that burns its gas does not stop the pool and the exclusions being read', async () => {
  const { c, D, pool } = chainWithAPool();
  const r = new ChainReader(c.rpc(), { tries: 0 });
  const res = await probeAccounts(r, D, [EATER, A(0xe0), pool], 9n);
  assert.deepEqual([...res.contracts.keys()], [pool]);
  assert.deepEqual(res.excludedOnChain, []);
});

// ------------------------------------------------------------- the pipeline

function req(w: World, i: number, prev: ActiveState | null) {
  const a = w.attempts[i];
  return { distributor: w.D, harvestTx: a.harvestTx, uri: a.uri, prev, opening: prev ? undefined : w.opening, distributors: [w.D] };
}

/** Every attempt of a world, on the readers given. */
async function runAll(w: World, readers: ChainReader[]) {
  let prev: ActiveState | null = null;
  const out: EpochResult[] = [];
  for (let i = 0; i < w.attempts.length; i++) {
    const { result } = await prepareEpoch(readers, w.config, req(w, i, prev));
    w.applyResult(i, result);
    if (result.result === 'epoch') {
      out.push(result);
      if (!w.attempts[i].vetoed) prev = result.next;
    }
  }
  return out;
}

test('pipeline: an address that burns its gas stops no epoch and costs no request, named by a zero-value transfer or holding tokens', async () => {
  const v = loadVector('v06-dust-carry-and-history');
  const run = async (burner: 'none' | 'named' | 'holding') => {
    const w = vectorWorld(v);
    const first = v.setup.transfers[0];
    if (burner !== 'none') {
      // anybody can send anything, nothing included, to anybody: a
      // CurbLaunchToken accepts it
      const from = burner === 'named' ? A(0xbad) : first.to;
      w.chain.addLog({
        address: w.token,
        topics: [TOPICS.Transfer, '0x' + from.slice(2).padStart(64, '0'), '0x' + EATER.slice(2).padStart(64, '0')],
        data: '0x' + (burner === 'named' ? 0n : 10n).toString(16).padStart(64, '0'),
        block: BigInt(first.block),
        logIndex: 777n,
        txHash: '0x' + '0b'.repeat(32),
      });
      w.chain.eaters.add(EATER);
    }
    const out = await runAll(w, [new ChainReader(w.chain.rpc('p0'), { tries: 0 }), new ChainReader(w.chain.rpc('p1'), { tries: 0 })]);
    const targets = probeCalls(w.chain).flatMap((c) => targetsOf(c.data));
    return { out, probes: probeCalls(w.chain).length, targets };
  };
  const plain = await run('none');
  const named = await run('named');
  const holding = await run('holding');
  const want = v.epochs.filter((e: any) => e.expected.result === 'epoch');
  assert.equal(named.out.length, want.length, 'every epoch is computed');
  named.out.forEach((r, i) => assert.equal(r.root.cumHolders0.toString(), want[i].expected.cumHolders0, `epoch ${i + 1} allocates as without the transfer`));
  assert.ok(!named.targets.includes(EATER), 'named with nothing it weighs nothing, and is not even probed');
  assert.equal(named.probes, plain.probes);
  // Holding tokens, it weighs, is probed - and its calls, which fail, ride
  // in the requests there were anyway. Not a pool, it is a holder.
  assert.equal(holding.out.length, want.length, 'every epoch is computed');
  assert.ok(holding.targets.includes(EATER));
  assert.equal(holding.probes, plain.probes, 'the burner rides in the requests there were anyway');
  assert.ok(holding.out[0].file.accounts.some((x) => x.a === EATER && x.s0 > 0n));
});

/** v12 with `n` fresh addresses given 1 wei each in block 104, from the
 *  curve (excluded; it holds the n wei before sharing began, which leaves the
 *  floor where it was). */
function sprayed(n: number) {
  const v = loadVector('v12-weight-floor-and-dust');
  const curve = '0xc0be000000000000000000000000000000000001';
  v.setup.opening.balances[curve] = String(n);
  for (let i = 0; i < n; i++) v.setup.transfers.push({ block: '104', logIndex: String(100 + i), from: curve, to: '0x5e' + (i + 1).toString(16).padStart(38, '0'), value: '1' });
  return v;
}

test('a 1-wei spray to 20,000 fresh addresses adds nothing to the epoch file but the digits of its counts, in its epoch and the next', () => {
  const plain = runVector(loadVector('v12-weight-floor-and-dust')) as EpochResult[];
  const dust = runVector(sprayed(20_000)) as EpochResult[];
  const digits = (x: bigint) => String(x).length;
  for (const i of [0, 1]) {
    const [p, d] = [plain[i], dust[i]];
    assert.deepEqual(d.file.accounts, p.file.accounts, `epoch ${i + 1}: no row for the dust, no share changed`);
    assert.deepEqual(d.file.balancesAtEnd, p.file.balancesAtEnd, `epoch ${i + 1}: no balance listed for the dust`);
    assert.deepEqual(d.file.rules.exclusions, p.file.rules.exclusions, 'no dust address probed or excluded');
    assert.deepEqual(d.file.merkle.leaves, p.file.merkle.leaves);
    assert.equal(d.file.stateAtEnd.count, p.file.stateAtEnd.count + 20_000n, 'the state carries every dust balance');
    const grown =
      digits(d.file.inputs.transfers.count) - digits(p.file.inputs.transfers.count) +
      digits(d.file.stateAtEnd.count) - digits(p.file.stateAtEnd.count) +
      digits(d.file.stateAtEnd.supply) - digits(p.file.stateAtEnd.supply);
    assert.ok(grown > 0);
    assert.equal(d.fileBytes.length - p.fileBytes.length, grown, `epoch ${i + 1}: ${p.fileBytes.length} -> ${d.fileBytes.length} bytes`);
  }
});

/** The audit's attack on the file's size: a holder of 2.4% of the supply
 *  rotates it through 12,000 fresh addresses each epoch, each holding twice
 *  the weight floor for the whole window. Every one earns, and an account
 *  that earned once has a leaf for good: 12,000 rows more each epoch. */
function rotating(epochs: number, n: number) {
  const v = loadVector('v01-mid-epoch-transfers');
  const whale = '0x3a1e000000000000000000000000000000000001';
  const S = 10n ** 27n;
  const each = (2n * S) / 1_000_000n;
  const addr = (e: number, i: number) => '0x' + (0xa0 + e).toString(16) + i.toString(16).padStart(38, '0');
  const transfers: any[] = [];
  const timestamps: Record<string, string> = {};
  for (let b = 999; b <= 1000 + 10 * epochs; b++) timestamps[String(b)] = String(1_700_000_000 + 2 * (b - 999));
  for (let e = 0; e < epochs; e++) {
    const F = 1000 + 10 * e;
    for (let i = 0; i < n; i++) transfers.push({ block: String(F), logIndex: String(i), from: e === 0 ? whale : addr(e - 1, i), to: addr(e, i), value: String(each) });
  }
  v.setup = { ...v.setup, sharingSince: '1000', opening: { block: '999', balances: { [whale]: String(S) } }, timestamps, transfers, keeperTxs: [], contracts: {} };
  v.epochs = Array.from({ length: epochs }, (_, e) => ({
    input: { toBlock: String(1009 + 10 * e), harvestTx: '0x' + (0x1000 + e).toString(16).padStart(64, '0'), uri: `ipfs://rot-${e + 1}`, received0: String(10n ** 18n * BigInt(e + 1)), received1: '0', price: null },
  }));
  return { v, addr };
}

test('rotating 2.4% of the supply through 12,000 fresh addresses an epoch adds rows for good, and no file past one chunk', () => {
  const n = 12_000;
  const { v, addr } = rotating(2, n);
  const [e1, e2] = runVector(v) as EpochResult[];
  assert.equal(e1.file.accounts.length, n + 1, 'the whale and every fresh address earn');
  assert.equal(e2.file.accounts.length, 2 * n + 1, "last epoch's addresses keep their leaves");
  const KiB = 1024;
  for (const r of [e1, e2]) {
    // every file bounded: the index ~1 KiB per 512 accounts, each chunk one IPFS block
    const sizes = r.chunks.map((c) => c.bytes.length);
    assert.ok(Math.max(...sizes) <= 256 * KiB, `largest chunk ${Math.max(...sizes)} bytes`);
    assert.ok(r.fileBytes.length <= 64 + (r.file.accounts.length / 512) * KiB, `index ${r.fileBytes.length} bytes for ${r.file.accounts.length} accounts`);
    assert.equal(r.chunks.length, Math.ceil(r.file.accounts.length / 512));
  }
  // What one file would have weighed: every row, written once.
  const total = e2.fileBytes.length + e2.chunks.reduce((s, c) => s + c.bytes.length, 0);
  assert.ok(total > 2 * 1024 * KiB, `the rows of epoch 2 weigh ${total} bytes in all`);
  assert.ok(e2.fileBytes.length * 100 < total, 'the index is under 1% of them');
  // An address of the first rotation, sold out, still proves its leaf from
  // the index and its one chunk.
  const a = addr(0, 4321);
  const index = parseEpochIndex(e2.fileBytes);
  const k = chunkIndexOf(index, a);
  const part = epochPart(e2.fileBytes, k, e2.chunks[k].bytes);
  const p = proofOf(treeOf(part), a)!;
  assert.ok(p.cum0 > 0n);
  assert.ok(verifyProof(e2.root.merkleRoot, leafHash(e2.file.distributor, a, p.cum0, p.cum1), p.proof));
});

test('pipeline: the spray costs no probe, and a file read back from the chain resumes with every dust balance', async () => {
  const run = async (v: any) => {
    const w = vectorWorld(v);
    const readers = [new ChainReader(w.chain.rpc('p0'), { tries: 0 }), new ChainReader(w.chain.rpc('p1'), { tries: 0 })];
    const r1 = (await prepareEpoch(readers, w.config, req(w, 0, null), { stateCache: null })).result as EpochResult;
    w.applyResult(0, r1);
    const probes = probeCalls(w.chain);
    const fromFile = stateFromEpochFile(parseEpochFile(r1.fileBytes), r1.contentHash, w.attempts[0].uri);
    const r2 = (await prepareEpoch(readers, w.config, { ...req(w, 1, fromFile), opening: w.opening }, { stateCache: null })).result as EpochResult;
    return { r1, r2, probes: probes.length, targets: probes.flatMap((c) => targetsOf(c.data)) };
  };
  const plain = await run(loadVector('v12-weight-floor-and-dust'));
  const dust = await run(sprayed(2_000));
  assert.equal(dust.probes, plain.probes, 'no probe request more');
  assert.deepEqual(dust.targets, plain.targets, 'no dust address asked anything');
  assert.deepEqual(dust.r1.file.accounts, plain.r1.file.accounts);
  assert.equal(dust.r2.file.stateAtEnd.count, plain.r2.file.stateAtEnd.count + 2_000n);
  assert.deepEqual(dust.r2.file.accounts, plain.r2.file.accounts);
});

test('keeper journal: a hash that never landed, or landed after T, is not counted and stops nothing', async () => {
  const v = loadVector('v07-keeper-fee-cap');
  const base = vectorWorld(v);
  const plain = (await prepareEpoch([new ChainReader(base.chain.rpc('a'), { tries: 0 }), new ChainReader(base.chain.rpc('b'), { tries: 0 })], base.config, req(base, 0, null))).result as EpochResult;
  assert.equal(plain.result, 'epoch');

  const keeper = v.setup.rules.keeperKeys[0].toLowerCase();
  const never = '0x' + 'ee'.repeat(32); // replaced at its nonce: no provider knows it
  const late = '0x' + 'ef'.repeat(32); // mined after T: one provider knows it, the other not yet
  const a = vectorWorld(v);
  const b = vectorWorld(v);
  const T = a.attempts[0].toBlock;
  a.chain.txs.set(late, { hash: late, from: keeper, to: a.D, input: '0x', block: T + 1n, gasUsed: 30000n, effectiveGasPrice: 3n, l1Fee: 11n });
  const readers = [new ChainReader(a.chain.rpc('a'), { tries: 0 }), new ChainReader(b.chain.rpc('b'), { tries: 0 })];
  const r = (await prepareEpoch(readers, a.config, { ...req(a, 0, null), extraKeeperTxs: [never, late] })).result as EpochResult;
  assert.equal(r.result, 'epoch');
  assert.ok(Buffer.from(r.fileBytes).equals(Buffer.from(plain.fileBytes)), 'the same file as with no journal');
  assert.ok(!r.file.keeper.txs.some((t) => t.hash === never || t.hash === late));
});

test('keeper journal: a send mined before F, which one provider pruned from its index, is not asked for its receipt and stops nothing', async () => {
  const v = loadVector('v07-keeper-fee-cap');
  const base = vectorWorld(v);
  const plain = (await prepareEpoch([new ChainReader(base.chain.rpc('a'), { tries: 0 }), new ChainReader(base.chain.rpc('b'), { tries: 0 })], base.config, req(base, 0, null))).result as EpochResult;
  assert.equal(plain.result, 'epoch');

  // Months ago, before this window: an archive node still knows it, a node
  // that keeps geth's default transaction index does not any more.
  const keeper = v.setup.rules.keeperKeys[0].toLowerCase();
  const old = '0x' + '0d'.repeat(32);
  const archive = vectorWorld(v);
  const pruned = vectorWorld(v);
  const F = BigInt(v.setup.sharingSince);
  archive.chain.txs.set(old, { hash: old, from: keeper, to: archive.D, input: '0x', block: F - 1n, gasUsed: 40000n, effectiveGasPrice: 5n, l1Fee: 13n });
  const readers = [new ChainReader(archive.chain.rpc('archive'), { tries: 0 }), new ChainReader(pruned.chain.rpc('pruned'), { tries: 0 })];
  const r = (await prepareEpoch(readers, archive.config, { ...req(archive, 0, null), extraKeeperTxs: [old] })).result as EpochResult;
  assert.equal(r.result, 'epoch');
  assert.ok(Buffer.from(r.fileBytes).equals(Buffer.from(plain.fileBytes)), 'the same file as with no journal');
  assert.ok(!archive.chain.calls.some((c) => c.method === 'eth_getTransactionReceipt' && String(c.params[0]).toLowerCase() === old), 'its receipt was not asked for');
});

test('keeper journal: only the sends that can lie in the window are named, settled ones before F left out whole', () => {
  const D = A(0xd157);
  const h = (n: number) => '0x' + n.toString(16).padStart(64, '0');
  const journal = {
    [A(0xcee9)]: [
      // mined before F: both of its sends (one replaced at the nonce) are left out
      { distributors: [D], sends: [{ hash: h(1) }, { hash: h(2) }], done: { hash: h(2), block: '99' } },
      // mined at F, and one whose outcome is not known yet: every send kept
      { distributors: [D, A(0xd158)], sends: [{ hash: h(3) }], done: { hash: h(3), block: '100' } },
      { distributors: [D], sends: [{ hash: h(4) }, { hash: h(5) }] },
      // settled by another transaction: nothing is known about a block, so kept
      { distributors: [D], sends: [{ hash: h(6) }], done: { hash: null, block: null } },
      // another distributor's
      { distributors: [A(0xd158)], sends: [{ hash: h(7) }], done: { hash: h(7), block: '150' } },
    ],
    [A(0xcee8)]: [{ distributors: [D.toUpperCase().replace('0X', '0x')], sends: [{ hash: h(8).toUpperCase().replace('0X', '0x') }, { hash: h(4) }] }],
  };
  assert.deepEqual(keeperJournalHashes(journal, D, 100n), [h(3), h(4), h(5), h(6), h(8)]);
  assert.deepEqual(keeperJournalHashes(journal, D, 99n), [h(1), h(2), h(3), h(4), h(5), h(6), h(8)]);
  assert.deepEqual(keeperJournalHashes(journal, D, 101n), [h(4), h(5), h(6), h(8)]);
  assert.deepEqual(keeperJournalHashes({}, D, 1n), []);
});

test('keeper journal: given as the journal, a send settled before F is never asked for, one in the window still counts', async () => {
  const v = loadVector('v07-keeper-fee-cap');
  const keeper = v.setup.rules.keeperKeys[0].toLowerCase();
  const F = BigInt(v.setup.sharingSince);
  const old = '0x' + '0d'.repeat(32); // mined before F: the archive knows it, the pruned node not
  const replaced = '0x' + '0e'.repeat(32); // its replacement at the same nonce, never mined
  const reverted = '0x' + '7e'.repeat(32); // a push that reverted in the window: no log, only the journal names it
  const archive = vectorWorld(v);
  const pruned = vectorWorld(v);
  archive.chain.txs.set(old, { hash: old, from: keeper, to: archive.D, input: '0x', block: F - 1n, gasUsed: 40000n, effectiveGasPrice: 5n, l1Fee: 13n });
  for (const w of [archive, pruned]) w.chain.txs.set(reverted, { hash: reverted, from: keeper, to: w.D, input: '0x', block: F + 2n, status: false, gasUsed: 30000n, effectiveGasPrice: 3n, l1Fee: 11n });
  const journal = {
    [keeper]: [
      { distributors: [archive.D], sends: [{ hash: replaced }, { hash: old }], done: { hash: old, block: String(F - 1n) } },
      { distributors: [archive.D], sends: [{ hash: reverted }], done: { hash: reverted, block: String(F + 2n) } },
    ],
  };
  const readers = [new ChainReader(archive.chain.rpc('archive'), { tries: 0 }), new ChainReader(pruned.chain.rpc('pruned'), { tries: 0 })];
  const r = (await prepareEpoch(readers, archive.config, { ...req(archive, 0, null), keeperJournal: journal })).result as EpochResult;
  assert.equal(r.result, 'epoch');
  assert.ok(r.file.keeper.txs.some((t) => t.hash === reverted), 'the reverted push in the window is counted');
  const asked = [...archive.chain.calls, ...pruned.chain.calls].filter((c) => /^eth_getTransaction/.test(c.method)).map((c) => String(c.params[0]).toLowerCase());
  assert.ok(!asked.includes(old) && !asked.includes(replaced), 'the sends settled before F were never asked for');
  assert.ok(asked.includes(reverted));
});

test('keeper journal: a transaction that logged from the distributor in the window must be known', async () => {
  const c = new MockChain();
  const D = A(0xd157);
  const h = '0x' + 'eb'.repeat(32);
  c.addLog({ address: D, topics: ['0x' + '0'.repeat(64)], data: '0x', block: 5n, logIndex: 0n, txHash: h });
  await assert.rejects(collectKeeperTxs(new ChainReader(c.rpc(), { tries: 0 }), D, A(0xfac7), 1n, 10n), /no transaction/);
});

test('keeper journal: a pending transaction the provider knows but has not mined is not counted', async () => {
  const v = loadVector('v07-keeper-fee-cap');
  const w = vectorWorld(v);
  const h = '0x' + 'ec'.repeat(32);
  const orig = w.chain.request.bind(w.chain);
  w.chain.request = async (method: string, params: any[]) => {
    if (method === 'eth_getTransactionByHash' && String(params[0]).toLowerCase() === h) return { hash: h, from: v.setup.rules.keeperKeys[0], to: w.D, input: '0x', blockNumber: null };
    return orig(method, params);
  };
  const readers = [new ChainReader(w.chain.rpc('a'), { tries: 0 }), new ChainReader(w.chain.rpc('b'), { tries: 0 })];
  const r = (await prepareEpoch(readers, w.config, { ...req(w, 0, null), extraKeeperTxs: [h] })).result as EpochResult;
  assert.equal(r.result, 'epoch');
  assert.ok(!r.file.keeper.txs.some((t) => t.hash === h));
});

test('feeds: a feed keyed by the checksummed quote address prices the keeper gas exactly as a lowercase key', async () => {
  const v = structuredClone(loadVector('v08-cbxrp-decimals-and-price'));
  // the vector's quote has no letters, so its checksum is itself: move it to
  // cbXRP's real address, whose checksum differs from its lowercase form
  const cbxrp = '0xcb585250f852c6c6bf90434ab21a00f02833a4af';
  const old = v.setup.quoteToken.toLowerCase();
  const swap = (x: any): any => (typeof x === 'string' ? (x.toLowerCase() === old ? cbxrp : x) : Array.isArray(x) ? x.map(swap) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k.toLowerCase() === old ? cbxrp : k, swap(y)])) : x);
  v.setup = swap(v.setup);
  const run = async (key: string) => {
    const w = vectorWorld(v);
    const feeds = w.config.feeds[cbxrp];
    assert.ok(feeds, 'the world has feeds for the quote');
    w.config.feeds = { [key]: feeds };
    const readers = [new ChainReader(w.chain.rpc('a'), { tries: 0 }), new ChainReader(w.chain.rpc('b'), { tries: 0 })];
    return (await prepareEpoch(readers, w.config, req(w, 0, null))).result as EpochResult;
  };
  const lower = await run(cbxrp);
  const checksummed = await run(getAddress(cbxrp));
  assert.notEqual(getAddress(cbxrp), cbxrp);
  assert.equal(lower.file.keeper.price.source, 'chainlink');
  assert.equal(checksummed.file.keeper.price.source, 'chainlink');
  assert.equal(checksummed.contentHash, lower.contentHash, 'the same file, byte for byte');
});

test('feeds: feed addresses written in capitals or checksummed give the file a lowercase config gives', async () => {
  const v = loadVector('v08-cbxrp-decimals-and-price');
  const run = async (shape: (a: string) => string) => {
    const w = vectorWorld(v);
    w.config.feeds = Object.fromEntries(Object.entries(w.config.feeds).map(([k, f]) => [k, { ethUsd: shape(f.ethUsd), quoteUsd: shape(f.quoteUsd) }]));
    const readers = [new ChainReader(w.chain.rpc('a'), { tries: 0 }), new ChainReader(w.chain.rpc('b'), { tries: 0 })];
    return (await prepareEpoch(readers, w.config, req(w, 0, null))).result as EpochResult;
  };
  const lower = await run((a) => a.toLowerCase());
  assert.equal(lower.file.keeper.price.source, 'chainlink');
  const upper = await run((a) => '0x' + a.slice(2).toUpperCase());
  const checksummed = await run((a) => getAddress(a));
  assert.equal(upper.contentHash, lower.contentHash, 'capitals: the same file, byte for byte');
  assert.equal(checksummed.contentHash, lower.contentHash, 'checksummed: the same file');
  assert.equal(upper.file.keeper.price.feed, lower.file.keeper.price.feed);
});

test('config: a feed, rule or contract address that is not an address is refused before anything is read', async () => {
  for (const vec of ['v08-cbxrp-decimals-and-price', 'v01-mid-epoch-transfers']) {
    // the second is a WETH launch: its feeds are never used, and still checked
    const v = loadVector(vec);
    const w = vectorWorld(v);
    const q = '0x' + 'c'.repeat(40);
    for (const bad of [
      { ...w.config, feeds: { ...w.config.feeds, [q]: { ethUsd: '0x123', quoteUsd: A(2) } } },
      { ...w.config, feeds: { ...w.config.feeds, [q]: { ethUsd: A(1), quoteUsd: 'cbXRP/USD' } } },
      { ...w.config, feeds: { ...w.config.feeds, ['0x12']: { ethUsd: A(1), quoteUsd: A(2) } } },
      { ...w.config, feeds: { [q]: { ethUsd: A(1), quoteUsd: A(2) }, [getAddress(q)]: { ethUsd: A(1), quoteUsd: A(3) } } },
      { ...w.config, graduator: '0xnot' },
      { ...w.config, weth: '' },
      { ...w.config, rules: { ...w.config.rules, keeperKeys: ['0x' + '1'.repeat(39)] } },
      { ...w.config, rules: { ...w.config.rules, exclusions: [{ address: 'nobody', reason: 'x' }] } },
      { ...w.config, rules: { ...w.config.rules, ammFactories: [{ address: '0x' + 'g'.repeat(40), reason: 'x' }] } },
    ]) {
      const before = w.chain.calls.length;
      const readers = [new ChainReader(w.chain.rpc('a'), { tries: 0 }), new ChainReader(w.chain.rpc('b'), { tries: 0 })];
      await assert.rejects(prepareEpoch(readers, bad as any, req(w, 0, null)), InputError, vec);
      assert.equal(w.chain.calls.length, before, 'nothing was asked');
    }
  }
  // gatherEpoch, which the ops package may call on its own, checks it too
  const g = vectorWorld(loadVector('v01-mid-epoch-transfers'));
  await assert.rejects(gatherEpoch(new ChainReader(g.chain.rpc('a'), { tries: 0 }), { ...g.config, feeds: { [A(5)]: { ethUsd: '0x5', quoteUsd: A(6) } } }, req(g, 0, null)), InputError);
  assert.equal(g.chain.calls.length, 0, 'nothing was asked');
  // and what it keeps is lowercase
  const w = vectorWorld(loadVector('v08-cbxrp-decimals-and-price'));
  const k = Object.keys(w.config.feeds)[0];
  const f = w.config.feeds[k];
  const checked = checkConfig({ ...w.config, graduator: getAddress(w.config.graduator), feeds: { [getAddress(k)]: { ethUsd: getAddress(f.ethUsd), quoteUsd: getAddress(f.quoteUsd) } } });
  assert.deepEqual(checked.feeds, { [k.toLowerCase()]: { ethUsd: f.ethUsd.toLowerCase(), quoteUsd: f.quoteUsd.toLowerCase() } });
  assert.equal(checked.graduator, w.config.graduator.toLowerCase());
});

test('feeds: one quote token named twice, in two letter cases, is refused', () => {
  const q = '0xcb585250f852c6c6bf90434ab21a00f02833a4af';
  const f = { ethUsd: A(1), quoteUsd: A(2) };
  assert.deepEqual(feedsFor({ [getAddress(q)]: f }, q), f);
  assert.equal(feedsFor({ [A(3)]: f }, q), null);
  assert.throws(() => feedsFor({ [q]: f, [getAddress(q)]: { ethUsd: A(1), quoteUsd: A(4) } }, q), InputError);
});
