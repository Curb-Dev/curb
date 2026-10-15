// The keeper's remaining rules, each pinned on its own: when an epoch is due
// (MIN_POT, the 7-day rule, a missing price, the cool-down after a no-epoch),
// which harvest may end it, waiting for `safe` in both run modes, the alerts
// for stuck income and a stalled distributor, the one-by-one fallback of
// publishMany, a keeper that is not the publisher, a config that cannot
// publish, the journal before the broadcast, and the refusals of build().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, parseAbi, parseAbiParameters, toHex } from 'viem';
import { opsWorld, HOLDERS, testKey } from './sim/world.ts';
import { tick, js, alertKeys, lying } from './sim/helpers.ts';
import { abiContract } from './mock-chain.ts';
import { EVENTS, TOPICS } from '../src/chain/abis.ts';
import { opsFactoryAbi } from '../src/ops/abis.ts';
import { publishFile } from '../src/ops/publish.ts';
import { memoryLogger } from '../src/ops/log.ts';
import { build, SetupError } from '../src/ops/runner.ts';
import { keySigner, TxSender } from '../src/ops/tx.ts';
import { Store } from '../src/ops/store.ts';
import { EpochFiles, MAX_FILE_BYTES } from '../src/ops/files.ts';
import { previewHarvest } from '../src/ops/chainview.ts';
import { ChainReader } from '../src/chain/reader.ts';
import { RpcError } from '../src/chain/rpc.ts';
import { main } from '../src/cli.ts';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const harvests = (w: ReturnType<typeof opsWorld>, d: string) => [...w.sim.txs.values()].filter((t) => t.to === d && t.input === '0x4641257d');

test('MIN_POT: a pot below 50 x the estimated epoch cost waits; after 7 days it goes anyway', async () => {
  const w = opsWorld({ income0: 10n ** 12n }); // a millionth of an ETH
  const L = w.launches[0];
  const k = w.make('keeper');
  w.pass(3601);
  const r1 = await tick(w, k);
  assert.equal(r1.published.length, 0);
  assert.match(String((r1.status.launches as any[])[0].epoch), /below MIN_POT/);
  assert.equal(harvests(w, L.D).length, 0, 'not even harvested');
  w.pass(7 * 86400);
  const r2 = await tick(w, k);
  assert.equal(r2.published.length, 1, js(r2));
});

test('a missing price: the 7-day rule only, and an alert', async () => {
  const w = opsWorld({ quote: 'usdc' });
  w.sim.usdcUsdAnswer = null; // the quote's feed is down
  const k = w.make('keeper');
  w.pass(3601);
  const r1 = await tick(w, k);
  assert.equal(r1.published.length, 0);
  assert.ok(alertKeys(k).includes(`missing-price:${w.launches[0].D}`));
  w.pass(7 * 86400);
  const r2 = await tick(w, k);
  assert.equal(r2.published.length, 1, js(r2));
});

test('a priced non-WETH launch publishes on its pot, and the keeper fee is converted by the feeds', async () => {
  const w = opsWorld({ quote: 'usdc' });
  const k = w.make('keeper');
  w.pass(3601);
  const r = await tick(w, k);
  assert.equal(r.published.length, 1, js(r));
  const f = JSON.parse(w.net.text(`sharing/8453/${w.launches[0].D}/1.json`)!);
  assert.equal(f.keeper.price.source, 'chainlink');
  assert.ok(BigInt(f.keeper.fee) > 0n);
});

test("a USDC launch at live Base's prices: valued in six decimals, paid in full, its $0.05 floor in USDC units, its fee within 2%", async () => {
  // USDC is on the list from 2026-10-15. Its feeds' answers as live Base gave
  // them that day; a holder whose share is about $0.04 - above 25 x a leaf's
  // cost at these gas prices (about $0.03), below the $0.05 floor - shows the
  // floor is counted in USDC's own units: 10^6 x 10^8 / answer per dollar
  const dust = HOLDERS.dust;
  const w = opsWorld({ quote: 'usdc', holders: { [HOLDERS.alice]: 600n * 10n ** 18n, [HOLDERS.bob]: 300n * 10n ** 18n, [HOLDERS.carol]: 100n * 10n ** 18n, [dust]: 2n * 10n ** 16n } });
  w.sim.ethUsdAnswer = 242606248936n;
  w.sim.usdcUsdAnswer = 99986720n;
  const L = w.launches[0];
  const k = w.make('keeper');
  w.pass(3601);
  const r1 = await tick(w, k);
  assert.equal(r1.published.length, 1, js(r1));
  const f = JSON.parse(w.net.text(`sharing/8453/${L.D}/1.json`)!);
  assert.equal(f.keeper.price.source, 'chainlink');
  assert.equal(f.keeper.price.value, String((10n ** 6n * 242606248936n * 10n ** 8n) / (99986720n * 10n ** 8n)), 'USDC base units per ETH');
  const row = (a: string) => f.accounts.find((x: any) => x.a === a);
  const perUsd = (10n ** 6n * 10n ** 8n) / 99986720n;
  const floor = (50_000n * perUsd) / 1_000_000n;
  assert.equal(floor, 50006n);
  assert.ok(BigInt(row(dust).s0) > 0n && BigInt(row(dust).s0) < floor, `the dust holder's share ${row(dust).s0} is under the floor`);
  assert.ok(BigInt(row(dust).s0) > 25n * ((75_000n * 6_000_000n * 2426384713n) / 10n ** 18n), 'and above 25 x the cost of its leaf');
  w.pass(3600 + 600);
  const r2 = await tick(w, k);
  assert.deepEqual(r2.errors, []);
  const s = w.sim.launch(L.D);
  assert.equal(s.active.epoch, 1);
  for (const a of [HOLDERS.alice, HOLDERS.bob, HOLDERS.carol]) assert.equal(s.paid0.get(a), BigInt(row(a).cum0), `${a} paid its whole cum0 in USDC units`);
  assert.equal(s.paid0.get(dust) ?? 0n, 0n, 'the dust holder waits for the dollar floor');
  const fee = BigInt(f.keeper.fee);
  const held = f.accounts.reduce((x: bigint, r: any) => x + BigInt(r.s0), 0n);
  assert.ok(fee > 0n && fee * 10_000n <= (held + fee) * 200n, `the fee ${fee} is within 2%`);
  assert.equal(s.keeperPaid0, fee);
});

test('after a no-epoch result the keeper waits a full gap before trying (and harvesting) again', async () => {
  // every holder is excluded on chain: the pot is there but W = 0
  const w = opsWorld({ holders: { '0x000000000000000000000000000000000000dead': 10n ** 21n } });
  const L = w.launches[0];
  const k = w.make('keeper');
  w.pass(3601);
  const r1 = await tick(w, k);
  assert.match(String((r1.status.launches as any[])[0].epoch), /no epoch: no-weight/);
  assert.equal(harvests(w, L.D).length, 1);
  w.pass(2000); // the harvest is no longer fresh; without the cool-down it would harvest again
  const r2 = await tick(w, k);
  assert.match(String((r2.status.launches as any[])[0].epoch), /gave no epoch, or its file could not be published; waiting/);
  assert.equal(harvests(w, L.D).length, 1, 'no second harvest');
});

test('a publishing failure backs off: the launch is not computed (or harvested) again for a full gap', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  const k = w.make('keeper');
  w.pass(3601);
  w.net.siteDown = true;
  const r1 = await tick(w, k);
  assert.equal(r1.published.length, 0);
  assert.equal(harvests(w, L.D).length, 1);
  const page = k.ctx.alerts.raised.find((a) => a.key.startsWith('publish-failed:'))!;
  assert.match(page.text, /tries this launch again in 60 min/);
  w.net.siteDown = false;
  w.pass(2000); // the harvest is no longer fresh; without the back-off it would harvest and publish now
  const r2 = await tick(w, k);
  assert.equal(r2.published.length, 0);
  assert.match(String((r2.status.launches as any[])[0].epoch), /could not be published; waiting/);
  assert.equal(harvests(w, L.D).length, 1, 'no second harvest');
  w.pass(1700);
  const r3 = await tick(w, k);
  assert.equal(r3.published.length, 1, js(r3));
});

test('an epoch file past keeper.largeFileBytes or keeper.largeFileAccounts pages, and is still published', async () => {
  for (const [cut, page] of [
    [(c: any) => (c.keeper.largeFileAccounts = 3), true], // alice, bob and carol
    [(c: any) => (c.keeper.largeFileBytes = 1000), true],
    [(_c: any) => {}, false], // 8 MiB and 50,000 accounts
  ] as const) {
    const w = opsWorld({ config: cut });
    const k = w.make('keeper');
    w.pass(3601);
    const r = await tick(w, k);
    assert.equal(r.published.length, 1, js(r));
    const a = k.ctx.alerts.raised.find((x) => x.key === `large-file:${w.launches[0].D}`);
    assert.equal(!!a, page, js(alertKeys(k)));
    if (a) {
      assert.equal(a.severity, 'page');
      assert.match(a.text, /a chunk file per 512 accounts/);
    }
  }
});

test('a contract that is not excluded and carries a large share of the weight is named once (a warning)', async () => {
  const w = opsWorld();
  const D = w.launches[0].D;
  w.sim.setContract(HOLDERS.bob, abiContract(parseAbi(['function owner() view returns (address)']), { owner: () => HOLDERS.bob }));
  const k = w.make('keeper');
  w.pass(3601);
  const r = await tick(w, k);
  assert.equal(r.published.length, 1, js(r));
  const got = k.ctx.alerts.raised.filter((a) => a.key.startsWith(`contract-holder:${D}:`));
  assert.deepEqual(got.map((a) => a.key), [`contract-holder:${D}:${HOLDERS.bob.toLowerCase()}`], 'bob only: alice and carol have no code');
  assert.equal(got[0].severity, 'warn');
  assert.match(got[0].text, /rules version/);
});

test('publishFile refuses a file above the read-back limit before it writes or pins anything', async () => {
  const w = opsWorld();
  const files = new EpochFiles({ chainId: 8453n, store: new Store(null), siteBase: 'https://site.test', gateways: ['https://gw.test'] });
  let touched = 0;
  const repo = { upsert: async () => (touched++, 'written') } as any;
  const pinner = { pin: async () => (touched++, { pinner: 'p', ok: true, counts: true }) } as any;
  const res = await publishFile({ distributor: w.launches[0].D, epoch: 1n, bytes: new Uint8Array(MAX_FILE_BYTES + 1), contentHash: '0x' + '00'.repeat(32) }, { chainId: 8453n, repo, pinners: [pinner], minPinned: 1, files, log: memoryLogger() });
  assert.ok('reason' in res && /read-back limit/.test(res.reason), js(res));
  assert.equal(touched, 0, 'nothing written, nothing pinned');
});

test('the distributors bound so far come from scans kept in /data: a later epoch and its check never rescan from graduatorFromBlock', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  const k = w.make('keeper');
  const g = w.make('guardian');
  const grad = k.ctx.cfg.sharing.graduator;
  const from = k.ctx.cfg.sharing.graduatorFromBlock;
  const fullScans = (n: number) => w.sim.calls.slice(n).filter((c) => c.method === 'eth_getLogs' && String(c.params[0].address).toLowerCase() === grad && c.params[0].topics?.[0] === TOPICS.HolderSharingEnabled && BigInt(c.params[0].fromBlock) === from);
  const { watchTick } = await import('../src/ops/verify.ts');
  w.pass(3601);
  await tick(w, k); // epoch 1 pending
  assert.ok((await watchTick(g.ctx, g.keys.guardian)).results.some((x) => x.epoch === 1n && x.verdict === 'ok'));
  w.pass(3700);
  await tick(w, k); // epoch 1 active
  w.sim.income(L.D, 10n ** 17n);
  w.pass(3700);
  const n = w.sim.calls.length;
  const r = await tick(w, k); // epoch 2
  assert.equal(r.published.length, 1, js(r));
  w.pass(60);
  const rep = await watchTick(g.ctx, g.keys.guardian);
  assert.ok(rep.results.some((x) => x.epoch === 2n && x.verdict === 'ok'), js(rep.results.map((x) => [x.epoch, x.verdict, x.problems])));
  assert.deepEqual(fullScans(n).map((c) => c.params[0].toBlock), [], 'no scan from graduatorFromBlock');
  // each provider's scan, kept in /data, lists every launch's distributor
  const kept = k.ctx.store.get<Record<string, { bound: [string, string, bigint][] }>>('boundDistributors', {});
  assert.deepEqual(Object.keys(kept).sort(), ['0:a', '1:b']);
  for (const st of Object.values(kept)) assert.deepEqual(st.bound.map((x) => x[0]).sort(), w.launches.map((x) => x.D).sort());
});

test('a provider that invents a bound distributor still stops the epoch: the kept lists differ, so each provider scans for itself', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  const grad = w.sim.addr.graduator.toLowerCase();
  const at = L.sharingSince;
  const fake = (): any => ({
    address: grad,
    topics: encodeEventTopics({ abi: [EVENTS.HolderSharingEnabled], eventName: 'HolderSharingEnabled', args: { token: '0x00000000000000000000000000000000000fa4e1', distributor: '0x00000000000000000000000000000000000fa4e0', factory: '0x00000000000000000000000000000000000fa4e2' } }),
    data: encodeAbiParameters(parseAbiParameters('address by, bool graduated, uint64 sinceBlock'), ['0x00000000000000000000000000000000000fa4e3', true, at]),
    blockNumber: '0x' + at.toString(16),
    blockHash: w.sim.hashOf(at),
    transactionHash: keccak256(toHex('invented')),
    logIndex: '0x3e7',
    removed: false,
  });
  const b = lying(w.sim.rpc('b'), 'b', (m, p, r) => {
    if (m !== 'eth_getLogs' || !Array.isArray(r) || String(p[0].address).toLowerCase() !== grad || p[0].topics?.[0] !== TOPICS.HolderSharingEnabled) return r;
    if (at < BigInt(p[0].fromBlock) || at > BigInt(p[0].toBlock)) return r;
    return [...r, fake()].sort((x: any, y: any) => (BigInt(x.blockNumber) === BigInt(y.blockNumber) ? Number(BigInt(x.logIndex) - BigInt(y.logIndex)) : BigInt(x.blockNumber) < BigInt(y.blockNumber) ? -1 : 1));
  });
  const k = w.make('keeper', { rpcs: [w.sim.rpc('a'), b] });
  w.pass(3601);
  const r = await tick(w, k);
  assert.equal(r.published.length, 0, js(r));
  assert.ok(alertKeys(k).includes('rpc-disagreement'), js(alertKeys(k)));
});

test("a harvest made while the previous root was still pending is never this epoch's T", async () => {
  const w = opsWorld({ config: (c) => (c.keeper.harvestFreshSec = 7200) });
  const L = w.launches[0];
  const k = w.make('keeper');
  w.pass(3601);
  await tick(w, k); // epoch 1 pending
  w.pass(600);
  w.sim.income(L.D, 10n ** 17n);
  w.sim.userTx(HOLDERS.alice, L.D, '0x4641257d'); // anybody may harvest, inside the hour
  w.pass(3100);
  await tick(w, k); // activate + push (epoch 2 is not due yet: T1 + 1h not reached? it is - see below)
  w.pass(3700);
  const r = await tick(w, k);
  assert.equal(r.published.length, 1, js(r));
  const f2 = JSON.parse(w.net.text(`sharing/8453/${L.D}/2.json`)!);
  const alices = [...w.sim.txs.values()].find((t) => t.from === HOLDERS.alice && t.to === L.D)!;
  assert.notEqual(f2.window.harvestTx, alices.hash, "alice's harvest, made while epoch 1 was pending, is not T");
});

test('a Harvested log from a transaction not sent straight to D is never T; the keeper harvests itself', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  const k = w.make('keeper');
  w.pass(3601);
  const viaProxy = w.sim.rawTx(HOLDERS.bob, '0x00000000000000000000000000000000000c0ffe', [w.sim.harvestedLog(L.D)]);
  const r = await tick(w, k);
  assert.equal(r.published.length, 1, js(r));
  const f = JSON.parse(w.net.text(`sharing/8453/${L.D}/1.json`)!);
  assert.notEqual(f.window.harvestTx, viaProxy);
  assert.equal(harvests(w, L.D).length, 1);
});

test('loop mode: a harvest above the safe head waits for the next tick, which uses the SAME harvest', async () => {
  const w = opsWorld({ safeLag: 10n });
  const L = w.launches[0];
  const k = w.make('keeper');
  w.pass(3601);
  w.sim.mineMany(12); // the launch's switch-on is safe
  const r1 = await tick(w, k, { waitForSafe: false });
  assert.equal(r1.published.length, 0);
  assert.match(String((r1.status.launches as any[])[0].epoch), /waits to be safe/);
  w.sim.mineMany(11);
  const r2 = await tick(w, k, { waitForSafe: false });
  assert.equal(r2.published.length, 1, js(r2));
  assert.equal(harvests(w, L.D).length, 1, 'one harvest across the two ticks');
});

test('once mode: it waits (up to safeWaitSec) for the harvest to be safe and publishes in the same run', async () => {
  const w = opsWorld({ safeLag: 10n });
  const k = w.make('keeper');
  w.pass(3601);
  w.sim.mineMany(12);
  const r = await tick(w, k, { waitForSafe: true });
  assert.equal(r.published.length, 1, js(r));
});

test('income stuck in the core after a harvest is alerted (it waits, it is not lost)', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  w.sim.launch(L.D).stuck0 = 5n * 10n ** 16n;
  w.sim.income(L.D, 5n * 10n ** 16n);
  const k = w.make('keeper');
  w.pass(3601);
  await tick(w, k);
  assert.ok(alertKeys(k).includes(`income-waiting:${L.D}`), js(alertKeys(k)));
});

test('a distributor due for more than 24 h with nothing published is STALLED', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  const k = w.make('keeper');
  w.net.kuboDown = true; // every publish fails
  w.pass(3601);
  await tick(w, k);
  assert.ok(!alertKeys(k).includes(`stalled:${L.D}`));
  w.pass(23 * 3600);
  await tick(w, k);
  assert.ok(!alertKeys(k).includes(`stalled:${L.D}`), 'not before 24 h');
  w.pass(3700);
  await tick(w, k);
  assert.ok(alertKeys(k).includes(`stalled:${L.D}`), js(alertKeys(k)));
});

test('when publishMany would revert (one launch published by someone else meanwhile) the rest go one by one', async () => {
  const w = opsWorld({ launches: 2 });
  const [A, B] = w.launches;
  const k = w.make('keeper');
  w.pass(3601);
  // as the keeper writes A's file, a rival with the publisher key gets a root for A on chain first
  let done = false;
  w.net.beforeCommit = (path) => {
    if (done || !path.includes(A.D)) return;
    done = true;
    const root = { merkleRoot: '0x' + '11'.repeat(32), contentHash: '0x' + '22'.repeat(32), cumHolders0: 0n, cumHolders1: 0n, cumKeeper0: 0n, fromBlock: A.sharingSince, toBlock: A.sharingSince, epoch: 1, payableAt: 0 };
    assert.ok(w.sim.userTx(w.signers.publisher.address, w.sim.addr.factory, encodeFunctionData({ abi: opsFactoryAbi, functionName: 'publishMany', args: [[A.D as `0x${string}`], [root as any], ['ipfs://rival']] as any })).ok);
  };
  const r = await tick(w, k);
  assert.deepEqual(r.published.map((p) => p.distributor), [B.D], js(r));
  assert.ok(r.notes.some((n) => /PendingRoot/.test(n)), js(r.notes));
});

test('a keeper whose key is not the factory publisher pushes and pays but never publishes, and pages', async () => {
  const w = opsWorld();
  const k = w.make('keeper', { signers: { publisher: keySigner(testKey('impostor')), pusher: w.signers.pusher } });
  w.sim.fund(keySigner(testKey('impostor')).address, 10n ** 18n);
  w.pass(3601);
  const r = await tick(w, k);
  assert.equal(r.published.length, 0);
  assert.ok(alertKeys(k).includes('publisher-mismatch'));
  assert.equal(harvests(w, w.launches[0].D).length, 0, 'no harvest for an epoch it cannot publish');
});

test('a config with no site or no data repo cannot publish', async () => {
  for (const cut of [(c: any) => delete c.site, (c: any) => delete c.dataRepo, (c: any) => (c.ipfs.gateways = [])]) {
    const w = opsWorld({ config: cut });
    const k = w.make('keeper');
    w.pass(3601);
    const r = await tick(w, k);
    assert.equal(r.published.length, 0);
    assert.ok(r.errors.some((e) => /no data repo|no site|no IPFS gateway/.test(e)), js(r.errors));
  }
});

test('publishFile refuses bytes that are not the computed contentHash', async () => {
  const w = opsWorld();
  const files = new EpochFiles({ chainId: 8453n, store: new Store(null), siteBase: 'https://site.test', gateways: ['https://gw.test'] });
  const res = await publishFile({ distributor: w.launches[0].D, epoch: 1n, bytes: new Uint8Array([1, 2]), contentHash: '0x' + '00'.repeat(32) }, { chainId: 8453n, repo: null, pinners: [], minPinned: 0, files, log: memoryLogger() });
  assert.ok('reason' in res && /not the computed contentHash/.test(res.reason));
});

test('the journal records a transaction BEFORE it is broadcast; a restart re-broadcasts it', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  // the first broadcast fails on both providers (not a retryable error): the tx exists nowhere
  let refuse = 2;
  const refusing = (label: string) => ({ label, request: async (x: any) => {
    if (refuse > 0 && x.method === 'eth_sendRawTransaction') {
      refuse--;
      throw new RpcError('internal error', { code: -32603 });
    }
    return w.sim.rpc(label).request(x);
  } });
  const k1 = w.make('keeper', { rpcs: [refusing('a'), refusing('b')] });
  w.pass(3601);
  const r1 = await tick(w, k1);
  assert.ok(r1.errors.some((e) => /internal error/.test(e)), js(r1.errors));
  const j1 = k1.ctx.store.get<Record<string, any[]>>('txJournal', {})[w.signers.pusher.address];
  assert.ok(j1 && j1.length === 1 && j1[0].sends.length === 1 && !j1[0].done, 'recorded, open, although no provider took it');
  assert.equal(harvests(w, L.D).length, 0);
  const k2 = w.make('keeper', { holder: 'restarted' });
  k2.ctx.store.set('txJournal', k1.ctx.store.get('txJournal'));
  const r2 = await tick(w, k2);
  assert.equal(r2.published.length, 1, js(r2));
  const h = harvests(w, L.D);
  assert.equal(h.length, 1, js({ a1: r1.actions, a2: r2.actions, h: h.map((x) => [x.hash, x.block]), j: k2.ctx.store.get('txJournal') }));
  assert.equal(h[0].hash, j1[0].sends[0].hash, 'the journaled transaction itself landed');
});

test('a restart resumes a STUCK journaled transaction at its nonce: replaced, not cancelled, not stacked', async () => {
  const w = opsWorld({ config: (c) => (c.keeper.maxReplacements = 0) });
  const L = w.launches[0];
  const firstTip = w.sim.tip;
  w.sim.stuck = (t) => t.to === L.D && t.tip <= firstTip;
  const k1 = w.make('keeper');
  w.pass(3601);
  const r1 = await tick(w, k1);
  assert.ok(r1.errors.some((e) => /not mined after 0 replacements/.test(e)), js(r1.errors));
  assert.ok(alertKeys(k1).includes('stuck:pusher'));
  const raw = { ...w.raw, keeper: { ...w.raw.keeper, maxReplacements: 3 } };
  const { parseOpsConfig } = await import('../src/ops/config.ts');
  const k2 = w.make('keeper', { holder: 'restarted', cfg: parseOpsConfig(raw) });
  k2.ctx.store.set('txJournal', k1.ctx.store.get('txJournal'));
  const r2 = await tick(w, k2);
  assert.equal(r2.published.length, 1, js(r2));
  const j = k2.ctx.store.get<Record<string, any[]>>('txJournal', {})[w.signers.pusher.address];
  assert.ok(!j.some((e: any) => /cancel/.test(e.label)), 'nothing cancelled');
  const hv = j.filter((e: any) => e.label.startsWith('harvest'));
  assert.equal(hv.length, 1, 'one journal entry for the harvest');
  assert.ok(hv[0].sends.length >= 2 && hv[0].done.status, 'replaced at its nonce and mined');
  assert.equal(harvests(w, L.D).length, 1);
});

test('resume: a journaled nonce that another transaction used is settled, not retried forever', async () => {
  const w = opsWorld();
  const k = w.make('keeper');
  const s = k.keys.pusher!;
  // a journal entry for nonce 0 that never landed...
  k.ctx.store.set('txJournal', { [s.address]: [{ key: 'pusher', nonce: 0, to: w.launches[0].D, data: '0x4641257d', gas: '300000', label: 'harvest (lost)', distributors: [], sends: [{ hash: '0x' + 'ab'.repeat(32), raw: '0x02', maxFeePerGas: '1', maxPriorityFeePerGas: '1', at: 0 }] }] });
  // ...while the chain used nonce 0 for something else
  await s.send({ to: s.address, data: '0x', label: 'other', distributors: [] }).catch(() => {});
  const j = k.ctx.store.get<Record<string, any[]>>('txJournal', {})[s.address];
  assert.ok(j[0].done, 'the lost entry is settled');
  assert.equal(await s.resume(), null);
});

test('build() refuses: one provider, the same key twice, a keeper with no pusher, a guardian with no key', () => {
  const w = opsWorld();
  const base = { cfg: w.cfg, dataDir: null, secrets: { env: w.env, dir: '/nonexistent' }, fetch: w.net.fetch as any, log: memoryLogger(), sinks: [] };
  assert.throws(() => build({ ...base, mode: 'keeper', rpcs: [w.sim.rpc('a')], signers: { publisher: w.signers.publisher, pusher: w.signers.pusher } }), (e: any) => e instanceof SetupError && /two independent/.test(e.message));
  assert.doesNotThrow(() => build({ ...base, mode: 'keeper', rpcs: [w.sim.rpc('a')], allowSingleProvider: true, signers: { publisher: w.signers.publisher, pusher: w.signers.pusher } }));
  assert.throws(() => build({ ...base, mode: 'keeper', rpcs: [w.sim.rpc('a'), w.sim.rpc('b')], signers: { publisher: w.signers.pusher, pusher: w.signers.pusher } }), /different keys/);
  assert.throws(() => build({ ...base, mode: 'keeper', rpcs: [w.sim.rpc('a'), w.sim.rpc('b')], signers: { publisher: w.signers.publisher } }), /pusher_key/);
  assert.throws(() => build({ ...base, mode: 'guardian', rpcs: [w.sim.rpc('a'), w.sim.rpc('b')], signers: {} }), /guardian_key/);
});

test('the harvest preview refuses an answer that is not three words', async () => {
  const w = opsWorld();
  const r = new ChainReader(lying(w.sim.rpc('a'), 'a', (m, p, res) => (m === 'eth_call' && !p[0].to ? '0x1234' : res)));
  await assert.rejects(() => previewHarvest(r, w.launches[0].D, 'latest'), /3 words/);
  const ok = await previewHarvest(new ChainReader(w.sim.rpc('a')), w.launches[0].D, 'latest');
  assert.equal(ok.received0, 10n ** 18n);
});

test('a cached file whose bytes no longer hash is never used', async () => {
  const store = new Store(null);
  const files = new EpochFiles({ chainId: 8453n, store, siteBase: null, gateways: [] });
  const good = new TextEncoder().encode('{"x":1}');
  const h = files.remember(good);
  assert.deepEqual(files.cached(h), good);
  store.writeFile(`files/8453/${h}.json`, new TextEncoder().encode('{"x":2}'));
  assert.equal(files.cached(h), null);
});

test('the CLI asks for exactly one of --loop and --once before reading anything', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'curb-cli-'));
  try {
    const cfg = join(dir, 'c.json');
    writeFileSync(cfg, '{}');
    const err: string[] = [];
    const io = { out: () => {}, err: (s: string) => err.push(s) };
    assert.equal(await main(['keeper', '--config', cfg], io), 2);
    assert.equal(await main(['keeper', '--loop', '--once', '--config', cfg], io), 2);
    assert.ok(err.every((e) => /exactly one of --loop and --once/.test(e)), js(err));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the role-event scan is incremental: the next pass starts after the last block seen', async () => {
  const w = opsWorld();
  const g = w.make('verify');
  const { watchTick } = await import('../src/ops/verify.ts');
  await watchTick(g.ctx, null);
  const first = g.ctx.store.get<bigint>('eventsBlock');
  w.sim.mineMany(3);
  const n = w.sim.calls.length;
  await watchTick(g.ctx, null);
  const scans = w.sim.calls.slice(n).filter((c) => c.method === 'eth_getLogs' && String(c.params[0].address).toLowerCase() === w.sim.addr.factory);
  assert.ok(scans.length > 0 && scans.every((c) => BigInt(c.params[0].fromBlock) === first + 1n), js(scans.map((c) => c.params[0].fromBlock)));
});

void TxSender;
