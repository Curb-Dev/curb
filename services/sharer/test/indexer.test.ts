// The indexer's reads and the checks each answer gets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, keccak256, toHex } from 'viem';
import { ChainReader, isTransient } from '../src/chain/reader.ts';
import { factoryAbi, feedAbi, poolAbi, distributorAbi, TOPICS } from '../src/chain/abis.ts';
import {
  collectKeeperTxs,
  discoverSharing,
  findLaunchBlock,
  launchExclusions,
  namesOf,
  probeAccounts,
  readLaunchRecord,
  readPrice,
  replayTransfers,
  type LaunchMeta,
} from '../src/chain/indexer.ts';
import { RpcError } from '../src/chain/rpc.ts';
import { abiContract, MockChain, Revert } from './mock-chain.ts';

const A = (n: number) => '0x' + n.toString(16).padStart(40, '0');
const topic = (a: string) => '0x' + a.slice(2).padStart(64, '0');
const w = (n: bigint) => n.toString(16).padStart(64, '0');
const G = A(0x96ad);
const T0 = A(0x70ce);
const D1 = A(0xd157);

function enableLog(c: MockChain, token: string, d: string, block: bigint, since = block, i = 0n) {
  c.addLog({
    address: G,
    topics: [TOPICS.HolderSharingEnabled, topic(token), topic(d), topic(A(0xfac7))],
    data: '0x' + w(BigInt(A(0xbeef))) + w(1n) + w(since),
    block,
    logIndex: i,
    txHash: keccak256(toHex(`${token}${d}${i}`)),
  });
}

test('discoverSharing decodes every switch and refuses a token or distributor bound twice', async () => {
  const c = new MockChain();
  enableLog(c, T0, D1, 10n);
  enableLog(c, A(0x70cf), A(0xd158), 20n);
  const r = new ChainReader(c.rpc());
  const got = await discoverSharing(r, G, 0n, 100n);
  assert.deepEqual(
    got.map((s) => [s.token, s.distributor, s.factory, s.by, s.graduated, s.sinceBlock]),
    [
      [T0, D1, A(0xfac7), A(0xbeef), true, 10n],
      [A(0x70cf), A(0xd158), A(0xfac7), A(0xbeef), true, 20n],
    ],
  );
  const c2 = new MockChain();
  enableLog(c2, T0, D1, 10n);
  enableLog(c2, T0, A(0xd158), 11n);
  await assert.rejects(discoverSharing(new ChainReader(c2.rpc()), G, 0n, 100n), /switched on twice/);
  const c3 = new MockChain();
  enableLog(c3, T0, D1, 10n);
  enableLog(c3, A(0x70cf), D1, 11n);
  await assert.rejects(discoverSharing(new ChainReader(c3.rpc()), G, 0n, 100n), /bound twice/);
  const c4 = new MockChain();
  enableLog(c4, T0, D1, 10n, 9n);
  await assert.rejects(discoverSharing(new ChainReader(c4.rpc()), G, 0n, 100n), /says block 9/);
});

test('readLaunchRecord reads 11 or more words; word 11 is launchedAt', async () => {
  const c = new MockChain();
  const R = A(0x7e91);
  let words = [A(0xc0be), A(0x4200), A(0xbe), A(0xbf)].map((a) => a.slice(2).padStart(64, '0')).concat([w(1n), w(2n), w(3n), A(0x400c).slice(2).padStart(64, '0'), w(4n), w(5n), A(0xfee).slice(2).padStart(64, '0'), w(1234n)]);
  c.setContract(R, () => '0x' + words.join(''));
  const r = new ChainReader(c.rpc());
  const rec = await readLaunchRecord(r, R, T0, 1n);
  assert.equal(rec.curve, A(0xc0be));
  assert.equal(rec.quoteToken, A(0x4200));
  assert.equal(rec.hooks, A(0x400c));
  assert.equal(rec.platformRecipient, A(0xfee));
  assert.equal(rec.launchedAt, 1234n);
  words = words.slice(0, 11);
  assert.equal((await readLaunchRecord(r, R, T0, 1n)).launchedAt, null);
  words = words.slice(0, 10);
  await assert.rejects(readLaunchRecord(r, R, T0, 1n), /10 words/);
  words = ['f'.repeat(64)].concat(words.slice(1)).concat([w(0n)]);
  await assert.rejects(readLaunchRecord(r, R, T0, 1n), /not an address/);
});

test('findLaunchBlock bisects to the first block at or after launchedAt and needs the registry log there', async () => {
  const c = new MockChain();
  const R = A(0x7e91);
  for (let b = 0n; b <= 1000n; b++) c.setBlock(b, 5000n + 2n * b);
  c.addLog({ address: R, topics: [TOPICS.LaunchRegistered, topic(T0), topic(A(1)), topic(A(2))], data: '0x', block: 537n, logIndex: 3n, txHash: '0x' + '1'.repeat(64) });
  const r = new ChainReader(c.rpc());
  assert.equal(await findLaunchBlock(r, R, T0, 5000n + 2n * 537n, 0n, 1000n), 537n);
  const asked = c.count('eth_getBlockByNumber');
  assert.ok(asked <= 12, `${asked} headers for a bisection of 1001 blocks`);
  // Odd launchedAt (between blocks) still lands on 537.
  assert.equal(await findLaunchBlock(r, R, T0, 5000n + 2n * 536n + 1n, 0n, 1000n), 537n);
  await assert.rejects(findLaunchBlock(r, R, T0, 5000n + 2n * 538n, 0n, 1000n), /0 LaunchRegistered/);
  await assert.rejects(findLaunchBlock(r, R, T0, 999999n, 0n, 1000n), /no block up to 1000/);
});

test('replayTransfers refuses a Transfer-topic log that is not ERC-20 shaped', async () => {
  const c = new MockChain();
  c.addLog({ address: T0, topics: [TOPICS.Transfer, topic(A(0)), topic(A(1))], data: '0x' + w(5n), block: 2n, logIndex: 0n, txHash: '0x' + '1'.repeat(64) });
  const r = new ChainReader(c.rpc());
  assert.deepEqual(await replayTransfers(r, T0, 1n, 5n), [{ block: 2n, logIndex: 0n, from: A(0), to: A(1), value: 5n }]);
  assert.deepEqual(await replayTransfers(r, T0, 6n, 5n), []);
  c.addLog({ address: T0, topics: [TOPICS.Transfer, topic(A(0)), topic(A(1)), topic(A(7))], data: '0x', block: 3n, logIndex: 0n, txHash: '0x' + '2'.repeat(64) });
  await assert.rejects(replayTransfers(new ChainReader(c.rpc()), T0, 1n, 5n), /not ERC-20 shaped/);
});

test('log timestamps are used instead of headers, and two different ones for a block are refused', async () => {
  const c = new MockChain();
  c.logTimestamps = true;
  for (let b = 1n; b <= 5n; b++) c.setBlock(b, 100n + b);
  c.addLog({ address: T0, topics: [TOPICS.Transfer, topic(A(0)), topic(A(1))], data: '0x' + w(5n), block: 3n, logIndex: 0n, txHash: '0x' + '1'.repeat(64) });
  const r = new ChainReader(c.rpc());
  await replayTransfers(r, T0, 1n, 5n);
  const before = c.count('eth_getBlockByNumber');
  const ts = await r.timestamps([3n, 2n]);
  assert.equal(ts.get(3n), 103n);
  assert.equal(ts.get(2n), 102n);
  assert.equal(c.count('eth_getBlockByNumber') - before, 1, 'only block 2 was asked for');
  assert.throws(() => r.noteLogTimestamps([{ blockNumber: '0x3', blockTimestamp: '0x1' } as any]), /different timestamps/);
});

test('probeAccounts: an address where token0() or token1() answers is kept, a call that does not answer as null; an EOA, a revert or factory() alone is not', async () => {
  {
    const c = new MockChain();
    const D = A(0xd157);
    const pool = A(0x9a12);
    const partial = A(0x9a13);
    const reverts = A(0x9a14);
    const wide = A(0x9a15);
    c.setContract(D, abiContract(distributorAbi, { isExcluded: (a) => String(a[0]).toLowerCase() === A(0xe1) }));
    c.setContract(pool, abiContract(poolAbi, { token0: () => T0, token1: () => A(0x4200), factory: () => A(0xf) }));
    c.setContract(partial, abiContract(poolAbi, { token0: () => T0, token1: () => A(0x4200), factory: () => { throw new Revert('no'); } }));
    c.setContract(reverts, () => { throw new Revert('nope'); });
    c.setContract(wide, (data) => (data === encodeFunctionData({ abi: poolAbi, functionName: 'factory' }) ? '0x' + 'f'.repeat(64) : '0x' + w(BigInt(T0))));
    const r = new ChainReader(c.rpc());
    const only1 = A(0x9a16);
    const onlyFactory = A(0x9a17);
    c.setContract(only1, abiContract(poolAbi, { token0: () => { throw new Revert('no'); }, token1: () => T0, factory: () => { throw new Revert('no'); } }));
    c.setContract(onlyFactory, abiContract(poolAbi, { token0: () => { throw new Revert('no'); }, token1: () => { throw new Revert('no'); }, factory: () => A(0xf) }));
    const res = await probeAccounts(r, D, [pool, partial, reverts, wide, only1, onlyFactory, A(0xe0), A(0xe1)], 9n);
    assert.deepEqual([...res.contracts.keys()], [pool, partial, wide, only1]);
    assert.deepEqual(res.contracts.get(pool), { token0: T0, token1: A(0x4200), factory: A(0xf) });
    assert.deepEqual(res.contracts.get(partial), { token0: T0, token1: A(0x4200), factory: null }, 'a factory() that reverts');
    assert.deepEqual(res.contracts.get(wide), { token0: T0, token1: T0, factory: null }, 'a factory() whose word is not an address');
    assert.deepEqual(res.contracts.get(only1), { token0: null, token1: T0, factory: null });
    assert.deepEqual(res.excludedOnChain, [A(0xe1)]);
    c.setContract(D, () => { throw new Revert('x'); });
    await assert.rejects(probeAccounts(r, D, [A(0xe0)], 9n), /isExcluded\(.*\) reverted on/);
  }
});

test('namesOf: publishMany names its distinct distributors, publish one, anything else none', () => {
  const root = { merkleRoot: '0x' + '0'.repeat(64), contentHash: '0x' + '0'.repeat(64), cumHolders0: 0n, cumHolders1: 0n, cumKeeper0: 0n, fromBlock: 0n, toBlock: 0n, epoch: 0, payableAt: 0 } as any;
  const many = encodeFunctionData({ abi: factoryAbi, functionName: 'publishMany', args: [[A(1), A(2), A(1)] as any, [root, root, root], ['', '', '']] });
  assert.deepEqual(namesOf(many), [A(1), A(2)]);
  const one = encodeFunctionData({ abi: factoryAbi, functionName: 'publish', args: [A(3) as any, root, ''] });
  assert.deepEqual(namesOf(one), [A(3)]);
  assert.deepEqual(namesOf('0x12345678'), []);
  assert.deepEqual(namesOf(encodeFunctionData({ abi: factoryAbi, functionName: 'VERSION' })), []);
});

test('readPrice: a reverting feed, a zero or negative answer is missing; a good one is recorded', async () => {
  const c = new MockChain();
  const E = A(0xe7);
  const Q = A(0xe8);
  let answer = 15000000000n;
  c.setContract(E, abiContract(feedAbi, { latestRoundData: () => [7n, 300000000000n, 0n, 0n, 7n], decimals: () => 8 }));
  c.setContract(Q, abiContract(feedAbi, { latestRoundData: () => [9n, answer, 0n, 0n, 9n], decimals: () => 8 }));
  const r = new ChainReader(c.rpc());
  assert.deepEqual(await readPrice(r, { ethUsd: E, quoteUsd: Q }, 1n), {
    ethUsd: { feed: E, round: '7', answer: '300000000000', decimals: '8' },
    quoteUsd: { feed: Q, round: '9', answer: '15000000000', decimals: '8' },
  });
  answer = 0n;
  assert.equal((await readPrice(r, { ethUsd: E, quoteUsd: Q }, 1n))!.quoteUsd, null);
  answer = -1n;
  assert.equal((await readPrice(r, { ethUsd: E, quoteUsd: Q }, 1n))!.quoteUsd, null);
  c.setContract(E, () => { throw new Revert('down'); });
  assert.equal((await readPrice(r, { ethUsd: E, quoteUsd: Q }, 1n))!.ethUsd, null);
  assert.equal(await readPrice(r, null, 1n), null);
});

test('collectKeeperTxs: transactions that logged from D in the window, plus named ones (a revert logs nothing)', async () => {
  const c = new MockChain();
  const D = A(0xd157);
  const F = A(0xfac7);
  const h = (i: number) => '0x' + i.toString(16).padStart(64, '0');
  c.txs.set(h(1), { hash: h(1), from: A(0xcee9), to: D, input: '0x', block: 5n, gasUsed: 100n, effectiveGasPrice: 2n, l1Fee: 7n });
  c.addLog({ address: D, topics: ['0x' + '0'.repeat(64)], data: '0x', block: 5n, logIndex: 0n, txHash: h(1) });
  c.txs.set(h(2), { hash: h(2), from: A(0xcee9), to: D, input: '0x', block: 6n, status: false, gasUsed: 50n, effectiveGasPrice: 2n, l1Fee: null });
  c.txs.set(h(3), { hash: h(3), from: A(0xcee9), to: D, input: '0x', block: 50n });
  c.addLog({ address: D, topics: ['0x' + '0'.repeat(64)], data: '0x', block: 50n, logIndex: 0n, txHash: h(3) });
  const r = new ChainReader(c.rpc());
  const txs = await collectKeeperTxs(r, D, F, 1n, 10n, [h(2)]);
  assert.deepEqual(
    txs.map((t) => [t.hash, t.gasUsed, t.effectiveGasPrice, t.l1Fee]),
    [
      [h(1), 100n, 2n, 7n],
      [h(2), 50n, 2n, 0n],
    ],
  );
});

test('launchExclusions: the launch contracts with fixed reasons, the lock only once graduated, other distributors once', () => {
  const m = { curve: A(1), hook: A(2), escrow: A(3), graduator: A(4), poolManager: A(5), positionManager: A(6), registry: A(7), lock: null, distributor: A(9) } as LaunchMeta;
  assert.deepEqual(
    launchExclusions(m, [A(11), A(9), A(10), A(11)]).map((x) => x.reason),
    ['the launch curve', 'the launch hook', 'the launcher FeeEscrow', 'the Graduator', 'the v4 PoolManager', 'the v4 PositionManager', 'the LaunchRegistry', 'a holder distributor', 'a holder distributor'],
  );
  assert.deepEqual(launchExclusions({ ...m, lock: A(8) }, []).map((x) => x.address).at(-1), A(8));
});

test('reader: transient failures are asked again, reverts and refusals are not; answers are checked', async () => {
  assert.equal(isTransient(new RpcError('x', { status: 429 })), true);
  assert.equal(isTransient(new RpcError('x', { status: 503 })), true);
  assert.equal(isTransient(new RpcError('fetch failed')), true);
  assert.equal(isTransient(new RpcError('execution reverted', { code: 3 })), false);
  assert.equal(isTransient(new RpcError('method not found', { code: -32601 })), false);
  assert.equal(isTransient(new RpcError('execution reverted: request timed out', { code: 3 })), false);
  const c = new MockChain();
  c.setBlock(1n, 10n);
  let fail = 2;
  c.faults.before = () => {
    if (fail-- > 0) throw new RpcError('busy', { status: 429 });
  };
  const pauses: number[] = [];
  const r = new ChainReader(c.rpc(), { sleep: async (ms) => void pauses.push(ms), backoffMs: 10 });
  assert.equal((await r.block(1n)).timestamp, 10n);
  assert.deepEqual(pauses, [10, 20]);
  // A node answering another block than asked is refused.
  const liar = new ChainReader({ request: async () => ({ number: '0x2', hash: '0x' + '1'.repeat(64), parentHash: '0x' + '2'.repeat(64), timestamp: '0x1' }) });
  await assert.rejects(liar.block(1n), /asked for block 1, got 2/);
  const liar2 = new ChainReader({ request: async () => ({ transactionHash: '0x' + '3'.repeat(64) }) });
  await assert.rejects(liar2.receipt('0x' + '4'.repeat(64)), /got 0x3333/);
  const liar3 = new ChainReader({ request: async () => ({ hash: '0x' + '3'.repeat(64), from: A(1), to: A(2), input: '0x', blockNumber: '0x1' }) });
  await assert.rejects(liar3.tx('0x' + '4'.repeat(64)), /asked for tx/);
  const pendingTx = new ChainReader({ request: async () => ({ hash: '0x' + '4'.repeat(64), from: A(1), to: A(2), input: '0x', blockNumber: null }) });
  await assert.rejects(pendingTx.tx('0x' + '4'.repeat(64)), /not in a block/);
  const garbled = new ChainReader({ request: async () => '0xzz' });
  await assert.rejects(garbled.rawCall(A(1), '0x', 1n), /eth_call answered/);
  // A probe request that fails is an error, never a list of failed calls:
  // a transient failure (asked again, then thrown) and a revert alike.
  const busy = new ChainReader({ request: async () => { throw new RpcError('busy', { status: 429 }); } }, { tries: 0 });
  await assert.rejects(busy.callMany([{ to: A(1), data: '0x' }], 1n), /busy/);
  const reverting = new ChainReader({ request: async () => { throw new RpcError('execution reverted', { code: 3 }); } }, { tries: 0 });
  await assert.rejects(reverting.callMany([{ to: A(1), data: '0x' }], 1n), /execution reverted/);
});
