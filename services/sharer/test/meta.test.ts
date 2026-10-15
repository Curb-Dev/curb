// readLaunchMeta's cross-checks and the reader's answer checks that the
// pipeline tests do not reach.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, toFunctionSelector, toHex } from 'viem';
import { ChainReader } from '../src/chain/reader.ts';
import { collectKeeperTxs, readLaunchMeta, readLaunchRecord } from '../src/chain/indexer.ts';
import { loadVector } from './helpers.ts';
import { vectorWorld, ZERO } from './world.ts';
import { MockChain } from './mock-chain.ts';

const w32 = (a: string) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');

/** Answers `sig` on `addr` with `result`, everything else as before. */
function override(c: MockChain, addr: string, sig: string, result: string) {
  const orig = c.contracts.get(addr.toLowerCase())!;
  const sel = toFunctionSelector(sig);
  c.setContract(addr, (data, block) => (data.slice(0, 10) === sel ? result : orig(data, block)));
}

const world = () => vectorWorld(loadVector('v01-mid-epoch-transfers'));

test('readLaunchMeta: a consistent launch reads through', async () => {
  const w = world();
  const m = await readLaunchMeta(new ChainReader(w.chain.rpc()), w.config.graduator, w.D, 110n);
  assert.equal(m.token, w.token);
  assert.equal(m.curve, w.roles.curve);
  assert.equal(m.escrow, w.roles.escrow);
  assert.equal(m.lock, w.roles.lock);
  assert.equal(m.sharingSince, 100n);
});

test('readLaunchMeta refuses: another graduator, sharingSince 0, an unregistered token, another quote', async () => {
  const run = (w: ReturnType<typeof world>) => readLaunchMeta(new ChainReader(w.chain.rpc()), w.config.graduator, w.D, 110n);
  const a = world();
  override(a.chain, a.D, 'graduator()', w32('0x' + '9'.repeat(40)));
  await assert.rejects(run(a), /names graduator/);
  const b = world();
  override(b.chain, b.roles.graduator, 'sharingSince(address)', '0x' + '0'.repeat(64));
  await assert.rejects(run(b), /sharingSince.* is 0/);
  const c = world();
  c.chain.setContract(c.roles.registry, () => '0x' + '0'.repeat(64 * 12));
  await assert.rejects(run(c), /is not registered/);
  const d = world();
  override(d.chain, d.D, 'quoteToken()', w32('0x' + '8'.repeat(40)));
  await assert.rejects(run(d), /distributor quote .* is not the launch's/);
  const e = world();
  override(e.chain, e.roles.graduator, 'lockOf(address)', '0x' + '0'.repeat(64));
  assert.equal((await run(e)).lock, null);
});

test('readLaunchRecord refuses a launchedAt wider than uint64', async () => {
  const c = new MockChain();
  const R = '0x' + '7'.repeat(40);
  c.setContract(R, () => '0x' + '0'.repeat(64 * 11) + (1n << 64n).toString(16).padStart(64, '0'));
  await assert.rejects(readLaunchRecord(new ChainReader(c.rpc()), R, '0x' + '1'.repeat(40), 1n), /not a uint64/);
});

test('reader refuses: a header with no hash, a probe answer of any other shape, a receipt in another block', async () => {
  const noHash = new ChainReader({ request: async () => ({ number: '0x1', hash: null, parentHash: '0x' + '1'.repeat(64), timestamp: '0x1' }) });
  await assert.rejects(noHash.block(1n), /has no hash/);
  const word = (n: bigint) => n.toString(16).padStart(64, '0');
  const OK = 1n << 255n;
  const answering = (raw: string) => new ChainReader({ request: async () => raw }, { tries: 0 });
  const two = [{ to: ZERO, data: '0x' }, { to: ZERO, data: '0x' }];
  // more answers than calls asked
  await assert.rejects(answering('0x' + word(3n) + word(0n) + word(0n) + word(0n)).callMany(two, 1n), /answered 3 calls of 2/);
  // a count the records do not fill
  await assert.rejects(answering('0x' + word(2n) + word(0n)).callMany(two, 1n), /ends inside call 1/);
  // a success announcing 32 bytes that are not there
  await assert.rejects(answering('0x' + word(1n) + word(OK | 32n)).callMany(two.slice(0, 1), 1n), /ends inside call 0/);
  // bytes after the last record
  await assert.rejects(answering('0x' + word(1n) + word(0n) + word(0n)).callMany(two.slice(0, 1), 1n), /after its last call/);
  // a 33-byte answer padded with anything but zeroes
  await assert.rejects(answering('0x' + word(1n) + word(OK | 33n) + 'ff'.repeat(33) + '01' + '00'.repeat(30)).callMany(two.slice(0, 1), 1n), /padding/);
  // not whole words, not hex
  await assert.rejects(answering('0x' + word(0n) + '00').callMany(two, 1n), /not whole words/);
  await assert.rejects(answering('0x').callMany(two, 1n), /not whole words/);
  // no call answered at all: an error, never a loop (a second request would
  // be the start of one, so the provider refuses it)
  let asked = 0;
  const once = new ChainReader({ request: async () => (++asked > 1 ? Promise.reject(new Error('asked again')) : '0x' + word(0n)) }, { tries: 0 });
  await assert.rejects(once.callMany(two, 1n), /answered none of 2 calls/);
  assert.equal(asked, 1);
  // and the well-formed answer of the same shapes reads back
  const good = '0x' + word(2n) + word(OK | 33n) + 'ff'.repeat(33) + '00'.repeat(31) + word(64n);
  assert.deepEqual(await answering(good).callMany(two, 1n), [{ success: true, returnData: '0x' + 'ff'.repeat(33) }, { success: false, returnData: '0x' }]);
  const h = '0x' + '5'.repeat(64);
  const D = '0x' + 'd'.repeat(40);
  const split = new ChainReader({
    request: async ({ method }) => {
      if (method === 'eth_getLogs') return [{ address: D, topics: [], data: '0x', blockNumber: '0x2', blockHash: '0x' + '1'.repeat(64), transactionHash: h, logIndex: '0x0' }];
      if (method === 'eth_getTransactionByHash') return { hash: h, from: D, to: D, input: '0x', blockNumber: '0x2' };
      return { transactionHash: h, from: D, to: D, blockNumber: '0x3', blockHash: '0x' + '1'.repeat(64), status: '0x1', gasUsed: '0x1', effectiveGasPrice: '0x1', logs: [] };
    },
  });
  await assert.rejects(collectKeeperTxs(split, D, ZERO, 1n, 5n), /name different blocks/);
});

test('collectKeeperTxs skips a contract creation', async () => {
  const c = new MockChain();
  const D = '0x' + 'd'.repeat(40);
  const h = keccak256(toHex('create'));
  c.txs.set(h, { hash: h, from: '0x' + 'c'.repeat(40), to: null, input: '0x', block: 2n });
  c.addLog({ address: D, topics: [], data: '0x', block: 2n, logIndex: 0n, txHash: h });
  assert.deepEqual(await collectKeeperTxs(new ChainReader(c.rpc()), D, ZERO, 1n, 5n), []);
});
