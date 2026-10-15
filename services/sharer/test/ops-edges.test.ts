// Edges the first mutation pass found unpinned: a frozen factory with an
// epoch otherwise due (no harvest at all), no pinning inside a root's veto
// hour, a provider's safe head falling back inside the epoch read, a single
// publish beaten by a rival, and the example deployment config.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeFunctionData, parseTransaction } from 'viem';
import { opsWorld } from './sim/world.ts';
import { tick, js, lying } from './sim/helpers.ts';
import { opsFactoryAbi } from '../src/ops/abis.ts';
import { parseOpsConfig } from '../src/ops/config.ts';
import { ROOT } from './helpers.ts';

const harvests = (w: ReturnType<typeof opsWorld>, d: string) => [...w.sim.txs.values()].filter((t) => t.to === d && t.input === '0x4641257d');

test('frozen with an epoch otherwise due: nothing is harvested (no epoch could be published)', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  const k = w.make('keeper');
  w.pass(3601);
  await tick(w, k);
  w.pass(3700);
  await tick(w, k); // epoch 1 active, pushed, nothing pending
  w.sim.income(L.D, 10n ** 18n);
  assert.ok(w.sim.userTx(w.sim.state.factory.owner, w.sim.addr.factory, encodeFunctionData({ abi: opsFactoryAbi, functionName: 'freeze' })).ok);
  w.pass(3700);
  const before = harvests(w, L.D).length;
  const r = await tick(w, k);
  assert.equal(harvests(w, L.D).length, before, js(r.actions));
  assert.equal((r.status.launches as any[])[0].epoch, 'frozen');
});

test("inside a root's veto hour nothing is pinned or written again", async () => {
  const w = opsWorld();
  const k = w.make('keeper');
  w.pass(3601);
  await tick(w, k);
  w.pass(600);
  const n = w.net.log.length;
  await tick(w, k);
  const touched = w.net.log.slice(n).filter((x) => /kubo\.test|pinata\.test/.test(x.url) || x.method === 'PUT');
  assert.deepEqual(touched.filter((x) => !x.url.includes('/ops/')), [], js(touched));
  // and a pending root is not mistaken for a vetoed one (lastProposed > active while it waits)
  assert.ok(!k.ctx.alerts.raised.some((a) => a.key.startsWith('veto-ack')), js(k.ctx.alerts.raised.map((a) => a.key)));
});

test("a provider's safe head falling back inside the epoch read: not ready, a note, no error", async () => {
  const w = opsWorld();
  let safeCalls = 0;
  const b = lying(w.sim.rpc('b'), 'b', (m, p, r: any) => {
    if (m === 'eth_getBlockByNumber' && p[0] === 'safe' && r) {
      safeCalls++;
      if (safeCalls === 3) return { ...r, number: '0x' + (BigInt(r.number) - 50n).toString(16) };
    }
    return r;
  });
  const k = w.make('keeper', { rpcs: [w.sim.rpc('a'), b] });
  w.pass(3601);
  const r1 = await tick(w, k, { waitForSafe: false }); // harvests; its block is not yet in the tick's safe head
  assert.match(String((r1.status.launches as any[])[0].epoch), /waits to be safe/);
  w.sim.mineMany(3);
  const r2 = await tick(w, k, { waitForSafe: false }); // b's safe head falls back inside gatherEpoch
  assert.deepEqual(r2.errors, []);
  assert.equal(r2.published.length, 0);
  assert.match(String((r2.status.launches as any[])[0].epoch), /not ready: not-safe/);
  const r3 = await tick(w, k, { waitForSafe: false });
  assert.equal(r3.published.length, 1, js(r3));
});

test('a single publish beaten by a rival is a note, not an error (idempotency)', async () => {
  const w = opsWorld();
  const A = w.launches[0];
  const k = w.make('keeper');
  w.pass(3601);
  let done = false;
  w.net.beforeCommit = (path) => {
    if (done || !path.includes(A.D)) return;
    done = true;
    const root = { merkleRoot: '0x' + '11'.repeat(32), contentHash: '0x' + '22'.repeat(32), cumHolders0: 0n, cumHolders1: 0n, cumKeeper0: 0n, fromBlock: A.sharingSince, toBlock: A.sharingSince, epoch: 1, payableAt: 0 };
    assert.ok(w.sim.userTx(w.signers.publisher.address, w.sim.addr.factory, encodeFunctionData({ abi: opsFactoryAbi, functionName: 'publishMany', args: [[A.D as `0x${string}`], [root as any], ['ipfs://rival']] as any })).ok);
  };
  const r = await tick(w, k);
  assert.deepEqual(r.errors, []);
  assert.equal(r.published.length, 0);
  assert.ok(r.notes.some((n) => /PendingRoot/.test(n)), js(r.notes));
});

test('the example deployment config is a valid config', () => {
  const raw = JSON.parse(readFileSync(join(ROOT, 'deploy', 'sharer.example.json'), 'utf8'));
  const c = parseOpsConfig(raw);
  assert.equal(c.sharing.chainId, 8453n);
  // the fourteen quote assets of 2026-10-15 less WETH, which ethUsdFeed
  // prices: USDC, cbBTC, VIRTUAL, AERO, cbXRP, cbZEC and the seven stocks
  assert.equal(Object.keys(c.sharing.feeds).length, 13);
  for (const [q, f] of Object.entries(c.sharing.feeds)) assert.equal(f.ethUsd, c.ethUsdFeed, `${q}: its ETH/USD leg is the one WETH is priced by`);
  assert.equal(c.ipfs.minPinned, 2);
});

test('resume: a journaled nonce that ANOTHER transaction already used is settled, not replaced for ever', async () => {
  const w = opsWorld();
  const k = w.make('keeper');
  const s = k.keys.pusher!;
  // the key's nonce 0 is used by a transaction this journal never saw
  const raw = await w.signers.pusher.sign({ chainId: 8453, nonce: 0, to: w.signers.pusher.address, data: '0x', gas: 21_000n, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 10n ** 6n });
  await w.sim.request('eth_sendRawTransaction', [raw]);
  // ...while the journal holds an open entry for nonce 0 that never landed
  k.ctx.store.set('txJournal', { [s.address]: [{ key: 'pusher', nonce: 0, to: w.launches[0].D, data: '0x4641257d', gas: '300000', label: 'harvest (lost)', distributors: [], sends: [{ hash: '0x' + 'ab'.repeat(32), raw: '0x02', maxFeePerGas: '1', maxPriorityFeePerGas: '1', at: 0 }] }] });
  assert.equal(await s.resume(), null);
  const j = k.ctx.store.get<Record<string, any[]>>('txJournal', {})[s.address];
  assert.deepEqual(j[0].done, { hash: null, block: null, status: null }, 'settled as used by another transaction');
  assert.equal(j[0].sends.length, 1, 'no replacement was signed');
});

test('a stuck transaction is never replaced above the gas-price cap', async () => {
  const cap = 12_000_000n; // base 5e6 + tip 1e6: the first send pays 11e6, a 25% bump would be 13.75e6
  const w = opsWorld({ config: (c) => Object.assign(c.keeper, { maxGasPriceWei: cap.toString(), pushMaxGasPriceWei: cap.toString() }) });
  const L = w.launches[0];
  const firstTip = w.sim.tip;
  w.sim.stuck = (t) => t.to === L.D && t.tip <= firstTip * 2n;
  const k = w.make('keeper');
  w.pass(3601);
  const r = await tick(w, k);
  assert.ok(r.errors.some((e) => /above the cap/.test(e)), js(r.errors));
  for (const raw of w.sim.sent) assert.ok(BigInt(parseTransaction(raw as `0x${string}`).maxFeePerGas ?? 0n) <= cap, 'nothing was ever signed above the cap');
});

test('epoch files are written only while this keeper holds the lease, even when no transaction came first', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  w.pass(3601);
  // a fresh harvest by somebody else: the keeper's first write would be the file, not a transaction
  assert.ok(w.sim.userTx('0x00000000000000000000000000000000000000ab', L.D, '0x4641257d').ok);
  const { Lease, LEASE_PATH } = await import('../src/ops/lease.ts');
  const { DataRepo } = await import('../src/ops/github.ts');
  const { Secret } = await import('../src/ops/secrets.ts');
  const { memoryLogger } = await import('../src/ops/log.ts');
  const other = new Lease({ repo: new DataRepo({ owner: 'curb', repo: 'curb-sharing-data', branch: 'main', apiBase: 'https://api.github.test', token: new Secret('t', 'ghp-test-token-0123456789'), fetch: w.net.fetch as any }), holder: 'other', role: 'standby', ttlSec: 600, log: memoryLogger(), now: w.clock.now });
  assert.equal(await other.acquire(), true);
  const k = w.make('keeper');
  const r = await tick(w, k);
  assert.equal(r.published.length, 0);
  assert.ok(![...w.net.repo.keys()].some((p) => p.startsWith(`sharing/8453/${L.D}/`)), 'no epoch file written without the lease');
  assert.match(r.notes.join(' '), /another keeper holds the lease/);
  void LEASE_PATH;
});
