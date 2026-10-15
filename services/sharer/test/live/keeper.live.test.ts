// One full epoch on a REAL node: the CURB stack deployed on an anvil fork of
// Base (script/b20/demo-app.sh), a WETH launch with holder sharing on from
// the start, real trades, then the keeper exactly as `keeper --once` runs it
// - harvest, wait for safe, compute on two readers, publish (the data repo,
// the pins and the read-back are the in-process fake net: nothing leaves the
// machine), publishMany, the veto hour, activate, push, payKeeper - and the
// verifier and the guardian against the real contracts, a forged root
// vetoed with vetoMany.
//
//   SHARER_LIVE_RPC=http://127.0.0.1:<port> SHARER_LIVE_STACK=<stack.json> npm run test:live
//
// stack.json: {"graduator", "distributorFactory", "catalog", "wethFactory",
// "fromBlock"} from demo-app.sh's output. The node must be one this run
// started (it mines and moves time). The keys are anvil's well-known test
// accounts: 0 creates the launch, 1-3 trade, 5 is the factory's publisher
// (demo-app.sh), 7 its vetoer, 8 the pusher.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWalletClient, createPublicClient, http, parseAbi, keccak256, toHex, decodeEventLog, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { httpRpc } from '../../src/chain/rpc.ts';
import { parseOpsConfig } from '../../src/ops/config.ts';
import { build } from '../../src/ops/runner.ts';
import { keeperTick } from '../../src/ops/keeper.ts';
import { watchTick, REASONS } from '../../src/ops/verify.ts';
import { keySigner } from '../../src/ops/tx.ts';
import { Secret } from '../../src/ops/secrets.ts';
import { memoryLogger } from '../../src/ops/log.ts';
import { previewHarvest } from '../../src/ops/chainview.ts';
import { parseEpochFile } from '../../src/calc/file.ts';
import { ChainReader } from '../../src/chain/reader.ts';
import { FakeNet } from '../sim/net.ts';
import { lying, js } from '../sim/helpers.ts';
import { TOPICS } from '../../src/chain/abis.ts';

const RPC = process.env.SHARER_LIVE_RPC;
const STACK = process.env.SHARER_LIVE_STACK;
const skip = !RPC || !STACK ? 'SHARER_LIVE_RPC and SHARER_LIVE_STACK are not set' : false;

const KEYS = {
  creator: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  t1: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  t2: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  t3: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  publisher: '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
  vetoer: '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356',
  pusher: '0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97',
} as const;
const WETH = '0x4200000000000000000000000000000000000006';
const ETH_USD = '0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70';

const factoryAbi = parseAbi([
  'struct LaunchConfig { string name; string symbol; string tokenUri; bytes32 salt; address quoteRefundTo; uint16 totalTaxBps; uint256 devBuy; address creatorWallet; uint16 expectedPlatformBps; address expectedPlatformRecipient; address holderShareFactory; }',
  'function launch(LaunchConfig cfg) payable returns (address token, address curve)',
  'function currentPlatformPolicy() view returns (uint16 bps, address to)',
  'function launchFee() view returns (uint256)',
  'function minTotalTaxBps() view returns (uint16)',
  'event LaunchCreated(address indexed launchToken, address indexed curve, address indexed creator, uint256 supply, uint16 totalTaxBps)',
]);
const curveAbi = parseAbi(['function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256)', 'function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256)']);
const erc20 = parseAbi(['function approve(address, uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function deposit() payable', 'function transfer(address, uint256) returns (bool)']);
const gradAbi = parseAbi(['function holderDistributorOf(address) view returns (address)']);
const distAbi = parseAbi(['function paid0(address) view returns (uint256)', 'function keeperPaid0() view returns (uint256)', 'function received0() view returns (uint256)', 'function active() view returns (bytes32, bytes32, uint128, uint128, uint128, uint64, uint64, uint32, uint40)', 'function pending() view returns (bytes32, bytes32, uint128, uint128, uint128, uint64, uint64, uint32, uint40)']);

test('live: one full epoch, then a forged root vetoed by the guardian', { skip, timeout: 900_000 }, async () => {
  const stack = JSON.parse(readFileSync(STACK!, 'utf8'));
  const chain = { id: 8453, name: 'base-fork', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC!] } } } as const;
  const pub = createPublicClient({ chain, transport: http(RPC!) });
  const wallet = (k: string) => createWalletClient({ chain, transport: http(RPC!), account: privateKeyToAccount(k as Hex) });
  const rpc = async (method: string, params: unknown[] = []) => (pub as any).request({ method, params });
  const mine = async (n = 1) => rpc('anvil_mine', ['0x' + n.toString(16)]);
  const warp = async (sec: number) => {
    await rpc('evm_increaseTime', ['0x' + sec.toString(16)]);
    await mine(1);
  };
  const wait = async (h: Hex) => {
    const r = await pub.waitForTransactionReceipt({ hash: h });
    assert.equal(r.status, 'success', `tx ${h} reverted`);
    return r;
  };

  // Every run leaves the node as it found it (the stack just deployed), so a
  // rerun sees no launch whose files only an earlier run's fake net held.
  const snap = await rpc('evm_snapshot');
  try {
    await body();
  } finally {
    await rpc('evm_revert', [snap]);
  }

  async function body(): Promise<void> {
  // ---- a WETH launch with sharing on from the start
  const creator = wallet(KEYS.creator);
  const [bps, to] = (await pub.readContract({ address: stack.wethFactory, abi: factoryAbi, functionName: 'currentPlatformPolicy' })) as [number, string];
  const fee = (await pub.readContract({ address: stack.wethFactory, abi: factoryAbi, functionName: 'launchFee' })) as bigint;
  const minTax = (await pub.readContract({ address: stack.wethFactory, abi: factoryAbi, functionName: 'minTotalTaxBps' })) as number;
  const tax = Math.max(minTax, 300);
  const cfg = { name: 'Keeper Live', symbol: 'KLIVE', tokenUri: '', salt: keccak256(toHex(`wp6-live-${Date.now()}`)), quoteRefundTo: creator.account.address, totalTaxBps: tax, devBuy: 0n, creatorWallet: '0x0000000000000000000000000000000000000000', expectedPlatformBps: bps, expectedPlatformRecipient: to, holderShareFactory: stack.distributorFactory } as const;
  const lr = await wait(await creator.writeContract({ address: stack.wethFactory, abi: factoryAbi, functionName: 'launch', args: [cfg as any], value: fee }));
  const created = lr.logs.map((l) => { try { return decodeEventLog({ abi: factoryAbi, data: l.data, topics: l.topics }); } catch { return null; } }).find((e) => e?.eventName === 'LaunchCreated')!;
  const token = String((created.args as any).launchToken).toLowerCase();
  const curve = String((created.args as any).curve).toLowerCase();
  const D = String(await pub.readContract({ address: stack.graduator, abi: gradAbi, functionName: 'holderDistributorOf', args: [token as Hex] })).toLowerCase();
  assert.notEqual(D, '0x0000000000000000000000000000000000000000', 'sharing is on at launch');

  // ---- real trades: three holders, one partly sells
  const amounts = { t1: 3n * 10n ** 17n, t2: 2n * 10n ** 17n, t3: 10n ** 17n };
  for (const [who, amt] of Object.entries(amounts)) {
    const w = wallet((KEYS as any)[who]);
    await wait(await w.writeContract({ address: WETH, abi: erc20, functionName: 'deposit', value: amt }));
    await wait(await w.writeContract({ address: WETH, abi: erc20, functionName: 'approve', args: [curve as Hex, amt] }));
    await wait(await w.writeContract({ address: curve as Hex, abi: curveAbi, functionName: 'buy', args: [amt, 0n, w.account.address] }));
  }
  const t2 = wallet(KEYS.t2);
  const bal2 = (await pub.readContract({ address: token as Hex, abi: erc20, functionName: 'balanceOf', args: [t2.account.address] })) as bigint;
  await wait(await t2.writeContract({ address: token as Hex, abi: erc20, functionName: 'approve', args: [curve as Hex, bal2 / 3n] }));
  await wait(await t2.writeContract({ address: curve as Hex, abi: curveAbi, functionName: 'sell', args: [bal2 / 3n, 0n, t2.account.address] }));

  // ---- the keeper, as `keeper --once` builds it (fake net for the data repo and IPFS)
  const net = new FakeNet();
  const publisher = keySigner(new Secret('publisher_key', KEYS.publisher));
  const pusher = keySigner(new Secret('pusher_key', KEYS.pusher));
  const raw = {
    sharing: { chainId: '8453', graduator: stack.graduator, graduatorFromBlock: String(stack.fromBlock), weth: WETH, rules: { version: '1', exclusions: [], keeperKeys: [publisher.address, pusher.address], ammFactories: [] }, feeds: {} },
    distributorFactory: stack.distributorFactory,
    catalog: stack.catalog,
    ethUsdFeed: ETH_USD,
    site: { base: 'https://site.test' },
    dataRepo: { owner: 'curb', repo: 'curb-sharing-data', branch: 'main', apiBase: 'https://api.github.test' },
    ipfs: { gateways: ['https://gw.test'], pinners: [{ kind: 'kubo', name: 'kubo', url: 'https://kubo.test' }, { kind: 'pinata', name: 'pinata', url: 'https://pinata.test', token: 'pinata' }], minPinned: 2 },
    // anvil answers eth_maxPriorityFeePerGas with 1 gwei (Base: ~0.001), so the
    // rehearsal raises the caps and lowers MIN_POT's factor to match
    keeper: { minEpochGapSec: 3600, receiptPollMs: 300, stuckAfterSec: 60, safeWaitSec: 300, minPotFactor: '1', maxGasPriceWei: '5000000000', pushMaxGasPriceWei: '5000000000' },
  };
  const opsCfg = parseOpsConfig(raw);
  const env = { CURB_SHARER_DATA_REPO_TOKEN: 'ghp-live-test-token-000', CURB_SHARER_PIN_TOKENS: '{"pinata":"pinata-live-test-jwt"}' };
  // time passing on the node: a short real wait and a few blocks (anvil's safe head is latest - 32)
  const sleep = async (ms: number) => {
    await new Promise((r) => setTimeout(r, Math.min(ms, 200)));
    await mine(8);
  };
  const make = (mode: 'keeper' | 'guardian' | 'verify', rpcs = [httpRpc(RPC!, { label: 'a' }), httpRpc(RPC!, { label: 'b' })], signers: any = mode === 'keeper' ? { publisher, pusher } : mode === 'guardian' ? { guardian: keySigner(new Secret('guardian_key', KEYS.vetoer)) } : {}) => {
    const log = memoryLogger();
    const b = build({ cfg: opsCfg, mode, dataDir: null, secrets: { env, dir: '/nonexistent' }, rpcs, fetch: net.fetch as any, log, sleep, signers, sinks: [], holder: `live-${mode}`, refetch: { tries: 2, delayMs: 10 } });
    return Object.assign(b, { log });
  };
  const k = make('keeper');
  const tickOnce = () => keeperTick(k.ctx, k.keys, { lease: k.lease, role: 'primary', waitForSafe: true, holder: k.holder });

  // the harvest preview against the real distributor, before the keeper harvests
  const reader = new ChainReader(httpRpc(RPC!));
  await warp(3601);
  await mine(40); // the switch-on is discovered once it is safe (anvil: latest - 32)
  const pre = await previewHarvest(reader, D, 'latest');
  assert.equal(pre.ok, true);
  assert.ok(pre.received0 > 0n, 'the curve tax is there to harvest');

  const r1 = await tickOnce();
  assert.deepEqual(r1.errors, [], JSON.stringify(r1, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  const mineP = r1.published.find((p) => p.distributor === D);
  assert.ok(mineP, js({ D, published: r1.published, errors: r1.errors, notes: r1.notes, launches: r1.status.launches, actions: r1.actions }));
  assert.equal(r1.actions.filter((a) => a.startsWith('publishMany')).length, 1, 'every launch due went in one publishMany');
  const got0 = (await pub.readContract({ address: D as Hex, abi: distAbi, functionName: 'received0' })) as bigint;
  assert.equal(got0, pre.received0, 'the preview predicted exactly what the harvest brought in');
  const pending = (await pub.readContract({ address: D as Hex, abi: distAbi, functionName: 'pending' })) as readonly unknown[];
  assert.equal(Number(pending[7]), 1);
  assert.equal(String(pending[1]).toLowerCase(), mineP!.contentHash);
  const file = parseEpochFile(net.repo.get(`sharing/8453/${D}/1.json`)!.bytes);
  assert.ok(file.keeper.fee > 0n, 'the harvest gas was charged');
  assert.equal(file.keeper.txs.length, 1, 'the harvest is the one keeper tx in the window');

  // the verifier recomputes it from the real chain: OK
  const v = make('verify');
  const vr = await watchTick(v.ctx, null);
  assert.equal(vr.results.find((x) => x.distributor === D)?.verdict, 'ok', JSON.stringify(vr.results.map((x) => [x.verdict, x.problems]), null, 1));

  // ---- the veto hour, then activate, push, payKeeper
  await warp(3601);
  const r2 = await tickOnce();
  assert.deepEqual(r2.errors, []);
  assert.ok(r2.actions.some((a) => a.startsWith('activate epoch 1')), r2.actions.join('\n'));
  assert.ok(r2.actions.some((a) => a.startsWith('push ')));
  assert.ok(r2.actions.some((a) => a.startsWith('payKeeper')));
  for (const row of file.accounts) {
    const paid = (await pub.readContract({ address: D as Hex, abi: distAbi, functionName: 'paid0', args: [row.a as Hex] })) as bigint;
    assert.equal(paid, row.cum0, `${row.a} was pushed its whole share`);
  }
  assert.equal((await pub.readContract({ address: D as Hex, abi: distAbi, functionName: 'keeperPaid0' })) as bigint, file.keeper.fee);
  const payeeWeth = (await pub.readContract({ address: WETH, abi: erc20, functionName: 'balanceOf', args: ['0x976EA74026E726554dB657fA54763abd0C3a0aa9'] })) as bigint;
  assert.ok(payeeWeth >= file.keeper.fee, 'the keeper payee holds its fee in WETH');

  // what each keeper transaction cost on the real contracts (the report quotes these)
  const journal = k.ctx.store.get<Record<string, any[]>>('txJournal', {});
  const gasOf: string[] = [];
  for (const list of Object.values(journal)) for (const e of list) if (e.done?.hash) gasOf.push(`${e.label.split(' ').slice(0, 2).join(' ')}: ${(await pub.getTransactionReceipt({ hash: e.done.hash })).gasUsed}`);
  console.log('live gas used:', gasOf.join('; '), `| leaves ${file.merkle.leaves.length} | fee ${file.keeper.fee} wei of ${file.inputs.received0} received`);

  // ---- epoch 2, forged by a stolen publisher key whose providers lie; the guardian vetoes it
  const t3 = wallet(KEYS.t3);
  await wait(await t3.writeContract({ address: WETH, abi: erc20, functionName: 'deposit', value: 10n ** 17n }));
  await wait(await t3.writeContract({ address: WETH, abi: erc20, functionName: 'approve', args: [curve as Hex, 10n ** 17n] }));
  await wait(await t3.writeContract({ address: curve as Hex, abi: curveAbi, functionName: 'buy', args: [10n ** 17n, 0n, t3.account.address] }));
  await warp(3601);
  const THIEF = '0x00000000000000000000000000000000000bad01';
  const F2 = BigInt(file.window.toBlock) + 1n;
  const forge = (label: string) =>
    lying(httpRpc(RPC!, { label }), label, (m, p, res) => {
      if (m !== 'eth_getLogs' || !Array.isArray(res) || String(p[0].address).toLowerCase() !== token || p[0].topics?.[0] !== TOPICS.Transfer) return res;
      if (BigInt(p[0].fromBlock) > F2 || BigInt(p[0].toBlock) < F2) return res;
      return [...res, { address: token, topics: [TOPICS.Transfer, '0x' + '0'.repeat(64), '0x' + THIEF.slice(2).padStart(64, '0')], data: '0x' + (10n ** 27n).toString(16).padStart(64, '0'), blockNumber: '0x' + F2.toString(16), blockHash: '0x' + '1'.repeat(64), transactionHash: keccak256(toHex('forged')), logIndex: '0x3e7', removed: false }].sort((x: any, y: any) => (BigInt(x.blockNumber) === BigInt(y.blockNumber) ? Number(BigInt(x.logIndex) - BigInt(y.logIndex)) : BigInt(x.blockNumber) < BigInt(y.blockNumber) ? -1 : 1));
    });
  const thief = make('keeper', [forge('a'), forge('b')]);
  const r3 = await keeperTick(thief.ctx, thief.keys, { lease: thief.lease, role: 'primary', waitForSafe: true, holder: 'thief' });
  assert.ok(r3.published.some((p) => p.distributor === D), js(r3));
  const forged = parseEpochFile(net.repo.get(`sharing/8453/${D}/2.json`)!.bytes);
  assert.ok(forged.accounts.some((a) => a.a === THIEF && a.s0 > 0n), 'the forged root pays the thief');

  const g = make('guardian');
  const gr = await watchTick(g.ctx, g.keys.guardian);
  const mine2 = gr.results.find((x) => x.distributor === D && x.epoch === 2n)!;
  assert.equal(mine2.verdict, 'mismatch');
  assert.equal(mine2.reason, REASONS.RECOMPUTE);
  assert.ok(gr.vetoed.some((x) => x.d === D && x.epoch === 2n), js(gr));
  const after = (await pub.readContract({ address: D as Hex, abi: distAbi, functionName: 'pending' })) as readonly unknown[];
  assert.equal(Number(after[8]), 0, 'the forged root is vetoed on chain');
  await warp(3700);
  const active = (await pub.readContract({ address: D as Hex, abi: distAbi, functionName: 'active' })) as readonly unknown[];
  assert.equal(Number(active[7]), 1, 'the thief never got an active root');
  }
});
