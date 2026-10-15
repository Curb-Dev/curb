// The keeper's config filled from the deployment's broadcast record (gap
// item 38): the addresses, the Graduator's block, the launchers, the owner
// Safe and RUNBOOK 7's exclusions, added and never removed; a live config's
// sharing block changes only with --bump.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './helpers.ts';
import { configFromRuns, RunError } from '../scripts/config-from-run.ts';
import { parseOpsConfig } from '../src/ops/config.ts';

const A = (n: number) => '0x' + n.toString(16).padStart(40, '0');
const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const C = (x: string) => x.replace(/^0x/, '0x').replace(/[a-f]/g, (c) => c.toUpperCase()); // forge prints checksummed-looking arguments
const POLICY_OWNER = A(0x5afe);
const PLATFORM = A(0x7ea5);
const PUBLISHER = A(0xb0b1);
const GUARDIAN = A(0x6a6d);
const SAFE_B = A(0x5afb);
const DEPLOYER = A(0xde91);

/** A broadcast record in forge's shape: DeployCurb's creations, in its order. */
function deployRun(quotes: string[], o: { firstStack?: number; chain?: number } = {}) {
  let n = 0x1000 + (o.firstStack ?? 0) * 0x10;
  const txs: any[] = [];
  const receipts: any[] = [];
  const create = (name: string, args: unknown[], type = 'CREATE') => {
    const address = A(++n);
    txs.push({ hash: '0x' + n.toString(16).padStart(64, '0'), transactionType: type, contractName: name, contractAddress: address, function: null, arguments: args, transaction: { from: DEPLOYER } });
    receipts.push({ transactionHash: '0x' + n.toString(16).padStart(64, '0'), blockNumber: '0x' + (30_000_000 + n).toString(16), contractAddress: type === 'CREATE' ? address : null });
    return address;
  };
  const registry = create('LaunchRegistry', [C(DEPLOYER)]);
  const catalog = create('SharingCatalog', [C(POLICY_OWNER), C(DEPLOYER)]);
  const graduator = create('Graduator', [A(1), A(2), A(3), C(registry), C(catalog)]);
  const hook = create('FeeHook', [A(1), C(PLATFORM), C(registry), C(graduator), C(POLICY_OWNER)], 'CREATE2');
  const stacks = quotes.map((q) => {
    const escrow = create('FeeEscrow', [C(q)]);
    const policy = create('FeePolicy.sol\\FeePolicy', [C(PLATFORM), C(escrow), '500']);
    const vault = create('PonsV2BuybackVault.sol\\PonsV2BuybackVault', [C(DEPLOYER), C(policy), C(escrow)]);
    const factory = create('CurbLaunchFactory', [C(registry), C(graduator), C(q), C(policy), C(escrow), C(vault), '(1000000000, 18, ...)']);
    txs.push({ transactionType: 'CALL', contractName: 'LaunchRegistry', contractAddress: registry, function: 'addLauncher(address)', arguments: [C(factory)] });
    return { escrow, policy, vault, factory };
  });
  const distributorFactory = create('HolderDistributorFactory', [C(registry), C(graduator), C(POLICY_OWNER), C(PUBLISHER), C(A(0xfee)), `[${C(GUARDIAN)}, ${C(SAFE_B)}, ${C(POLICY_OWNER)}]`]);
  const lens = create('LaunchLens', [C(registry), C(graduator)]);
  return { run: { transactions: txs, receipts, chain: o.chain ?? 8453 }, registry, catalog, graduator, hook, stacks, distributorFactory, lens };
}

const example = () => JSON.parse(readFileSync(join(ROOT, 'deploy', 'sharer.example.json'), 'utf8'));

test('the example config, filled from a DeployCurb record: every address, the block, the launchers, the owner and the exclusions', () => {
  const d = deployRun([WETH, USDC]);
  const r = configFromRuns(example(), [d.run], { keeperKeys: [A(0x9051), A(0x9052)] });
  const c = r.config;
  assert.equal(c.sharing.graduator, d.graduator);
  assert.equal(c.sharing.graduatorFromBlock, String(30_000_000 + parseInt(d.graduator, 16)), "the Graduator's creation block");
  assert.equal(c.distributorFactory, d.distributorFactory);
  assert.equal(c.catalog, d.catalog);
  assert.equal(c.registry, d.registry);
  assert.equal(c.hook, d.hook);
  assert.equal(c.lens, d.lens);
  assert.equal(c.policyOwner, POLICY_OWNER);
  assert.deepEqual(c.launchers, d.stacks.map((s) => s.factory));
  const ex = new Map(c.sharing.rules.exclusions.map((x: any) => [x.address.toLowerCase(), x.reason]));
  for (const s of d.stacks) for (const a of [s.factory, s.escrow, s.policy, s.vault]) assert.ok(ex.has(a), `${a} excluded`);
  assert.equal(ex.get(d.stacks[1].escrow), `the FeeEscrow for ${USDC}`);
  for (const [a, why] of [[d.registry, 'the LaunchRegistry'], [d.lens, 'the LaunchLens'], [POLICY_OWNER, 'the owner Safe'], [PLATFORM, 'the platform recipient']]) assert.equal(ex.get(a), why);
  assert.ok(ex.has('0x000000000022d473030f116ddee9f6b43ac78ba3'), "the example's own exclusions stay");
  assert.ok(!ex.has(GUARDIAN) && !ex.has(SAFE_B), "vetoers are a person's call");
  assert.ok(r.decide.some((x) => x.includes(SAFE_B)) && r.decide.some((x) => x.includes(GUARDIAN)), r.decide.join('\n'));
  assert.deepEqual(c.sharing.rules.keeperKeys, [PUBLISHER, A(0x9051), A(0x9052)]);
  assert.equal(c.sharing.rules.version, '1', 'a first config: no bump');
  const parsed = parseOpsConfig(c);
  assert.equal(parsed.lens, d.lens);
  assert.deepEqual(Object.keys(c).slice(0, 9), ['$comment', 'sharing', 'distributorFactory', 'catalog', 'registry', 'hook', 'lens', 'policyOwner', 'launchers']);
  // and again on its own output: nothing changes
  const again = configFromRuns(c, [d.run], { keeperKeys: [A(0x9051), A(0x9052)] });
  assert.deepEqual(again.config, c);
  assert.deepEqual(again.report, []);
});

test('a later asset stack on a live config changes its sharing block only with --bump', () => {
  const d = deployRun([WETH]);
  const live = configFromRuns(example(), [d.run]).config;
  // DeployAssetStack: one more stack against the same graduator and registry
  const later = deployRun([USDC], { firstStack: 9 }).run;
  later.transactions = later.transactions.filter((t: any) => ['FeeEscrow', 'FeePolicy.sol\\FeePolicy', 'PonsV2BuybackVault.sol\\PonsV2BuybackVault', 'CurbLaunchFactory'].includes(t.contractName));
  assert.throws(() => configFromRuns(live, [d.run, later]), (e: any) => e instanceof RunError && /pass --bump to raise sharing\.rules\.version/.test(e.message));
  const r = configFromRuns(live, [d.run, later], { bump: true });
  assert.equal(r.config.sharing.rules.version, '2');
  assert.equal(r.config.launchers.length, 2);
  const factory = later.transactions.find((t: any) => t.contractName === 'CurbLaunchFactory').contractAddress;
  assert.ok(r.config.sharing.rules.exclusions.some((x: any) => x.address === factory));
  assert.ok(live.sharing.rules.exclusions.every((x: any) => r.config.sharing.rules.exclusions.some((y: any) => y.address === x.address)), 'nothing is removed');
});

test("a stack whose quote asset has no feed is a DECIDE line, and only that one: the example prices the list's assets", () => {
  // the 2026-10-15 list: WETH by ethUsdFeed, USDC, VIRTUAL and AERO among the
  // example's feeds - nothing to decide
  const VIRTUAL = '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b';
  const AERO = '0x940181a94a35a4569e4529a3cdfb74e38fd98631';
  const d = deployRun([WETH, USDC, VIRTUAL, AERO]);
  const first = configFromRuns(example(), [d.run]);
  assert.ok(!first.decide.some((x) => /sharing\.feeds/.test(x)), first.decide.join('\n'));
  // TSLAc, left off the list for want of a pool, admitted later: its stack
  // comes with no feed, and the operator is told to add one (RUNBOOK 7.2 step 3)
  const TSLAC = '0xb2000000000000000000001e800a7f5189430cd0';
  const later = deployRun([TSLAC], { firstStack: 9 }).run;
  later.transactions = later.transactions.filter((t: any) => ['FeeEscrow', 'FeePolicy.sol\\FeePolicy', 'PonsV2BuybackVault.sol\\PonsV2BuybackVault', 'CurbLaunchFactory'].includes(t.contractName));
  const r = configFromRuns(first.config, [d.run, later], { bump: true });
  const factory = later.transactions.find((t: any) => t.contractName === 'CurbLaunchFactory').contractAddress;
  const lines = r.decide.filter((x) => /sharing\.feeds/.test(x));
  assert.equal(lines.length, 1, r.decide.join('\n'));
  assert.match(lines[0], new RegExp(`no Chainlink feed for the quote asset ${TSLAC} \\(the CurbLaunchFactory ${factory}\\).*RUNBOOK part 7\\.2 step 3`));
  // once the feed is in, the same runs decide nothing about feeds
  r.config.sharing.feeds[TSLAC] = { ethUsd: r.config.ethUsdFeed, quoteUsd: '0xfaf869185383a24f8cb00e27bda6b63b9905dcb4' };
  const again = configFromRuns(r.config, [d.run, later]);
  assert.ok(!again.decide.some((x) => /sharing\.feeds/.test(x)), again.decide.join('\n'));
});

test('refused: a run for another chain, two deployments at once, no Graduator', () => {
  assert.throws(() => configFromRuns(example(), [deployRun([WETH], { chain: 84532 }).run]), /a run is for chain 84532, the config for chain 8453/);
  assert.throws(() => configFromRuns(example(), [deployRun([WETH]).run, deployRun([WETH], { firstStack: 50 }).run]), /two (LaunchRegistry|Graduator) contracts in the runs given/);
  assert.throws(() => configFromRuns(example(), [{ transactions: [], receipts: [] }]), /no Graduator was created/);
});

test('the CLI writes the file and says what it set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'curb-from-run-'));
  try {
    const d = deployRun([WETH]);
    writeFileSync(join(dir, 'run.json'), JSON.stringify(d.run));
    const out = join(dir, 'sharer.json');
    const r = spawnSync(process.execPath, ['scripts/config-from-run.ts', '--run', join(dir, 'run.json'), '--out', out, '--keeper-key', A(0x9051)], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`sharing\\.graduator: 0x0{40} -> ${d.graduator}`));
    assert.match(r.stdout, /DECIDE: vetoer/);
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).distributorFactory, d.distributorFactory);
    const bad = spawnSync(process.execPath, ['scripts/config-from-run.ts', '--run', join(dir, 'run.json'), '--from', out, '--keeper-key', 'nope'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /NOT DONE: --keeper-key nope is not an address/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
