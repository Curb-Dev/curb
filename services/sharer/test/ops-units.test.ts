// Unit tests of the ops pieces that need no chain: the push planner (every
// threshold, the dust rule, PushSkipped, batching, the caps), the config
// checks, the CID, the harvest preview's bytecode, and the ABIs against the
// Solidity sources.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toFunctionSelector } from 'viem';
import { planPushes, unpaidValue0, leafCost0, type LeafState, type PushRules, type PushEconomics } from '../src/ops/push.ts';
import { buildTree } from '../src/calc/merkle.ts';
import type { Leaf } from '../src/calc/types.ts';
import { parseOpsConfig, ConfigError, publicSharingConfig, sharingConfigFrom } from '../src/ops/config.ts';
import { fileCid, digestOfRawCid, cidOfUri, base32, CHUNK } from '../src/ops/cid.ts';
import { sha256Hex } from '../src/calc/encoding.ts';
import { PREVIEW_CODE } from '../src/ops/chainview.ts';
import { DIST_ERRORS, FACTORY_ERRORS, GRADUATOR_ERRORS, opsDistributorAbi, opsFactoryAbi, catalogAbi, ownableAbi, feeHookAbi, registryAbi, wiringAbi } from '../src/ops/abis.ts';
import { ROOT } from './helpers.ts';

const D = '0x00000000000000000000000000000000000000d1';
const acct = (i: number) => '0x' + (0x1000 + i).toString(16).padStart(40, '0');
const rules: PushRules = {
  pushUsdFloorMicros: 50_000n,
  pushCostFactor: 25n,
  dustCostFactor: 2n,
  dustZeroSec: 30 * 86400,
  skipRetrySec: 30 * 86400,
  skipGrowth: 10n,
  maxLeavesPerPush: 200,
  maxPushGas: 8_000_000n,
  pushMaxGasPriceWei: 100_000_000n,
  gas: { pushBase: 60_000n, pushFirstLeaf: 45_000n, pushRepeatLeaf: 20_000n },
};
// 1 gwei-ish world: gas price 1e7 wei, L1 1e9 per leaf, WETH quote (P = 1e18), $3000/ETH
const econ: PushEconomics = { P: 10n ** 18n, perUsd: 10n ** 18n / 3000n, tokenPrice: null, gasPrice: 10_000_000n, l1PerLeaf: 1_000_000_000n };
const NOW = 2_000_000_000;

function setup(rows: Partial<LeafState>[]) {
  const states: LeafState[] = rows.map((r, i) => ({ account: acct(i), cum0: 0n, cum1: 0n, paid0: 0n, paid1: 0n, excluded: false, emptyNow: false, lastHeldAt: NOW, skipped: null, ...r }));
  const leaves: Leaf[] = states.map((s) => [D, s.account, s.cum0.toString(), s.cum1.toString()]);
  return { tree: buildTree(leaves).tree, states };
}

test('push threshold: max($0.05, 25 x the marginal leaf cost incl. L1); a leaf at it is pushed, one wei below waits', () => {
  const first = { paid0: 0n, paid1: 0n } as LeafState;
  const cost = leafCost0({ ...first, account: acct(0), cum0: 0n, cum1: 0n, excluded: false, emptyNow: false, lastHeldAt: null, skipped: null }, econ, rules);
  assert.equal(cost, 45_000n * 10_000_000n + 1_000_000_000n);
  const floor = (50_000n * econ.perUsd) / 1_000_000n;
  const T = floor > 25n * cost ? floor : 25n * cost;
  const { tree, states } = setup([{ cum0: T }, { cum0: T - 1n }]);
  const plan = planPushes(tree, states, econ, rules, NOW);
  assert.equal(plan.batches.length, 1);
  assert.deepEqual(plan.batches[0].leaves.map((l) => l.account), [acct(0)]);
  assert.equal(plan.waiting['below-threshold'], 1);
  // the dollar floor binds when gas is cheap
  const cheap = { ...econ, gasPrice: 1n, l1PerLeaf: 0n };
  const p2 = planPushes(setup([{ cum0: floor - 1n }]).tree, setup([{ cum0: floor - 1n }]).states, cheap, rules, NOW);
  assert.equal(p2.batches.length, 0, 'below $0.05 waits however cheap gas is');
  const p3 = planPushes(setup([{ cum0: floor }]).tree, setup([{ cum0: floor }]).states, cheap, rules, NOW);
  assert.equal(p3.batches.length, 1);
});

test('the threshold is on what is UNPAID, and a repeat leaf is cheaper than a first one', () => {
  const cRepeat = leafCost0({ account: acct(0), cum0: 0n, cum1: 0n, paid0: 1n, paid1: 0n, excluded: false, emptyNow: false, lastHeldAt: null, skipped: null }, econ, rules);
  assert.equal(cRepeat, 20_000n * 10_000_000n + 1_000_000_000n);
  const T = 25n * cRepeat > (50_000n * econ.perUsd) / 1_000_000n ? 25n * cRepeat : (50_000n * econ.perUsd) / 1_000_000n;
  const { tree, states } = setup([{ cum0: 10n ** 18n, paid0: 10n ** 18n - T }, { cum0: 10n ** 18n, paid0: 10n ** 18n - T + 1n }, { cum0: 5n, paid0: 5n }]);
  const plan = planPushes(tree, states, econ, rules, NOW);
  assert.deepEqual(plan.batches.flatMap((b) => b.leaves.map((l) => l.account)), [acct(0)]);
  assert.equal(plan.waiting.paid, 1);
});

test('the dust rule: empty for 30 days AND unpaid >= 2 x the cost; not one second sooner, not one wei less', () => {
  const cost = 45_000n * 10_000_000n + 1_000_000_000n;
  const day30 = 30 * 86400;
  const cases: [Partial<LeafState>, boolean][] = [
    [{ cum0: 2n * cost, emptyNow: true, lastHeldAt: NOW - day30 }, true],
    [{ cum0: 2n * cost - 1n, emptyNow: true, lastHeldAt: NOW - day30 }, false],
    [{ cum0: 2n * cost, emptyNow: true, lastHeldAt: NOW - day30 + 1 }, false],
    [{ cum0: 2n * cost, emptyNow: false, lastHeldAt: NOW - day30 }, false],
    [{ cum0: 2n * cost, emptyNow: true, lastHeldAt: null }, false],
  ];
  for (const [row, pushed] of cases) {
    const { tree, states } = setup([row]);
    const plan = planPushes(tree, states, econ, rules, NOW);
    assert.equal(plan.batches.length === 1, pushed, js(row));
    if (pushed) assert.equal(plan.batches[0].why[acct(0)], 'dust');
  }
});

test('PushSkipped: claim-only for 30 days unless the unpaid value grew 10x', () => {
  const big = 10n ** 17n;
  const at = NOW - 10 * 86400;
  const cases: [Partial<LeafState>, boolean][] = [
    [{ cum0: big, skipped: { at, unpaidValue0: big } }, false],
    [{ cum0: 10n * big, skipped: { at, unpaidValue0: big } }, true],
    [{ cum0: 10n * big - 1n, skipped: { at, unpaidValue0: big } }, false],
    [{ cum0: big, skipped: { at: NOW - 30 * 86400, unpaidValue0: big } }, true],
    [{ cum0: big, skipped: { at: NOW - 30 * 86400 + 1, unpaidValue0: big } }, false],
  ];
  for (const [row, pushed] of cases) {
    const { tree, states } = setup([row]);
    const plan = planPushes(tree, states, econ, rules, NOW);
    assert.equal(plan.batches.length === 1, pushed, js(row));
    if (pushed) assert.equal(plan.batches[0].why[acct(0)], 'retry');
    else assert.equal(plan.waiting['claim-only'], 1);
  }
});

test('never pushed: excluded accounts, a quote without a price, a gas price above the push cap', () => {
  const big = 10n ** 18n;
  assert.equal(planPushes(setup([{ cum0: big, excluded: true }]).tree, setup([{ cum0: big, excluded: true }]).states, econ, rules, NOW).waiting.excluded, 1);
  const np = planPushes(setup([{ cum0: big }]).tree, setup([{ cum0: big }]).states, { ...econ, P: 0n }, rules, NOW);
  assert.equal(np.batches.length, 0);
  assert.equal(np.waiting['no-price'], 1);
  const gp = planPushes(setup([{ cum0: big }]).tree, setup([{ cum0: big }]).states, { ...econ, gasPrice: rules.pushMaxGasPriceWei + 1n }, rules, NOW);
  assert.equal(gp.batches.length, 0);
  assert.equal(gp.waiting['gas-price'], 1);
  const atCap = planPushes(setup([{ cum0: big }]).tree, setup([{ cum0: big }]).states, { ...econ, gasPrice: rules.pushMaxGasPriceWei }, rules, NOW);
  assert.equal(atCap.batches.length, 1, 'at the cap exactly is allowed');
});

test('the launch-token side counts at the curve price; without a price only the quote side counts', () => {
  const r = { account: acct(0), cum0: 0n, cum1: 4n * 10n ** 18n, paid0: 0n, paid1: 0n, excluded: false, emptyNow: false, lastHeldAt: null, skipped: null };
  assert.equal(unpaidValue0(r, { tokenPrice: null }), 0n);
  assert.equal(unpaidValue0(r, { tokenPrice: 10n ** 15n }), 4n * 10n ** 15n);
  const { tree, states } = setup([{ cum1: 4n * 10n ** 18n }]);
  assert.equal(planPushes(tree, states, econ, rules, NOW).batches.length, 0);
  assert.equal(planPushes(tree, states, { ...econ, tokenPrice: 10n ** 15n }, rules, NOW).batches.length, 1);
});

test('batches: at most maxLeavesPerPush leaves and maxPushGas estimated gas each, largest first, each with its own multiproof', () => {
  const rows = Array.from({ length: 450 }, (_, i) => ({ cum0: 10n ** 16n + BigInt(i) }));
  const { tree, states } = setup(rows);
  const plan = planPushes(tree, states, econ, rules, NOW);
  // 60k + 176 x 45k = 7.98M fits, 177 would not: the gas bound binds before 200 leaves
  assert.deepEqual(plan.batches.map((b) => b.leaves.length), [176, 176, 98]);
  for (const b of plan.batches) assert.ok(b.estGas <= rules.maxPushGas);
  const small = planPushes(tree, states, econ, { ...rules, maxLeavesPerPush: 200, maxPushGas: 100_000_000n }, NOW);
  assert.deepEqual(small.batches.map((b) => b.leaves.length), [200, 200, 50]);
  // largest first: the first batch holds the 200 largest
  const firstSet = new Set(small.batches[0].leaves.map((l) => l.account));
  assert.ok(firstSet.has(acct(449)) && !firstSet.has(acct(0)));
  // every batch's multiproof verifies against the tree
  for (const b of small.batches) {
    const ok = tree.verifyMultiProof({ leaves: b.leaves.map((l) => [D, l.account, l.cum0.toString(), l.cum1.toString()] as Leaf), proof: b.proof, proofFlags: b.flags });
    assert.ok(ok);
  }
});

const js = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

// ---------------------------------------------------------------- config

const BASE = () => ({
  sharing: { chainId: '8453', graduator: '0x' + 'aB'.repeat(20), graduatorFromBlock: '5', rules: { version: '1', exclusions: [], keeperKeys: ['0x' + '11'.repeat(20)], ammFactories: [] }, feeds: {} },
  distributorFactory: '0x' + '22'.repeat(20),
});

test('config: defaults, lowercased addresses, and every refusal', () => {
  const c = parseOpsConfig(BASE());
  assert.equal(c.sharing.graduator, '0x' + 'ab'.repeat(20));
  assert.equal(c.keeper.intervalSec, 300);
  assert.equal(c.keeper.minEpochGapSec, 3600);
  assert.equal(c.keeper.maxEpochWaitSec, 7 * 86400);
  assert.equal(c.keeper.minPotFactor, 50n);
  assert.equal(c.keeper.pushUsdFloorMicros, 50_000n);
  assert.equal(c.keeper.maxLeavesPerPush, 200);
  assert.equal(c.keeper.maxPushGas, 8_000_000n);
  assert.equal(c.keeper.dustZeroSec, 30 * 86400);
  assert.equal(c.lease.ttlSec, 600);
  assert.equal(c.lease.standbyAfterSec, 2700);
  assert.equal(c.guardian.intervalSec, 60);
  assert.equal(c.eventsFromBlock, 5n);
  const bad: [string, (x: any) => void, RegExp][] = [
    ['an unknown key', (x) => (x.keeperr = {}), /unknown key "keeperr"/],
    ['an unknown keeper key', (x) => (x.keeper = { intervall: 5 }), /unknown key "intervall"/],
    ['a bad address', (x) => (x.distributorFactory = '0x12'), /not an address/],
    ['credentials in a URL', (x) => (x.site = { base: 'https://user:pw@site.example' }), /credentials/],
    ['minPinned above the pinners', (x) => (x.ipfs = { gateways: [], pinners: [{ kind: 'kubo', url: 'https://k.example' }], minPinned: 2 }), /minPinned/],
    ['a pinata pinner with no token', (x) => (x.ipfs = { pinners: [{ kind: 'pinata' }] }), /token/],
    ['a push cap above the global cap', (x) => (x.keeper = { pushMaxGasPriceWei: '10', maxGasPriceWei: '9' }), /pushMaxGasPriceWei/],
    ['a standby that would take over a live primary', (x) => (x.lease = { standbyAfterSec: 900, heartbeatEverySec: 900 }), /twice/],
    ['a dollar amount that is not one', (x) => (x.keeper = { pushUsdFloor: '5c' }), /dollar/],
    ['a negative interval', (x) => (x.keeper = { intervalSec: -1 }), /integer/],
    ['a feed key twice', (x) => (x.sharing.feeds = { ['0x' + 'Cc'.repeat(20)]: { ethUsd: '0x' + '01'.repeat(20), quoteUsd: '0x' + '02'.repeat(20) }, ['0x' + 'cc'.repeat(20)]: { ethUsd: '0x' + '01'.repeat(20), quoteUsd: '0x' + '02'.repeat(20) } }), /twice/],
    ['a data repo root that climbs', (x) => (x.dataRepo = { owner: 'o', repo: 'r', root: '../x/' }), /root/],
  ];
  for (const [what, edit, re] of bad) {
    const x: any = BASE();
    edit(x);
    assert.throws(() => parseOpsConfig(x), (e: any) => e instanceof ConfigError && re.test(e.message), what);
  }
});

test('the public sharing config round-trips into the verifier config', () => {
  const c = parseOpsConfig(BASE());
  const pub = publicSharingConfig(c);
  const back = sharingConfigFrom(JSON.parse(JSON.stringify(pub)));
  assert.deepEqual(back.sharing, c.sharing);
  assert.equal(back.distributorFactory, c.distributorFactory);
  assert.ok(!JSON.stringify(pub).includes('dataRepo'), 'nothing operational in it');
});

// ---------------------------------------------------------------- CID

test('the file CID is the one a real Kubo gives (CIDv1, raw leaves, 256 KiB chunks, balanced), 1 B to 46 MB', () => {
  const hello = new TextEncoder().encode('hello world');
  assert.equal(fileCid(hello), 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e');
  assert.equal(digestOfRawCid(fileCid(hello)), sha256Hex(hello), 'one chunk: a raw block whose digest is the sha256');
  // ipfs add -Q --only-hash --cid-version=1 --raw-leaves --chunker=size-262144, ipfs/kubo v0.43.0
  const kubo: [number, string][] = [
    [1, 'bafkreigkgwdvr5wspzwpiutssn4xpj2i7wedshnwphhnu7ohx4pqaxxipe'],
    [1000, 'bafkreicqs7t5lbzvf5ijobrk4z47g662labnt6dvvoquzdfu2gqyrlnbpe'],
    [262144, 'bafkreigtb2zed6k6pq34amzfdj4ovylbble3alojsysuiikydagtlammdm'],
    [262145, 'bafybeif4z4ikxldcsjhv2l4sxmk57abnwjkwpa57gopqjvdhkyxddhmzf4'],
    [600000, 'bafybeidudknqwx4o547irvvb4yjeyfa5ndfno3g7ikcsr25a6k4tytdeqm'],
    [1048576, 'bafybeiauqn2tgwkyydo5v62clfl5vtokgwet2o3qpoaaxihbnh3ehac3am'],
    [3000000, 'bafybeifdoqtp273bl4zct64bwpjwjheoey25vin5hwynruxa6qsc5mpt7e'],
    [45613056, 'bafybeicd42f2zcidotwsoitc7yom627eeycmsnncaydllcognowm7ok5yu'],
    [46000000, 'bafybeihuo2nurnwqbretdmikvjwholxmchgm4pkgyq5cxap6ivzw4u57iy'],
  ];
  for (const [n, want] of kubo) {
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) & 0xff;
    assert.equal(fileCid(b), want, `${n} bytes`);
  }
  assert.equal(CHUNK, 262144);
  assert.equal(digestOfRawCid('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'), null, 'a dag-pb CID is not a raw block');
  assert.equal(base32(new Uint8Array([0xff])), '74');
  assert.equal(cidOfUri('ipfs://bafkreiabc'), 'bafkreiabc');
  assert.equal(cidOfUri('https://x/ipfs/bafkreiabc'), null);
});

// ---------------------------------------------------------------- preview

test('the harvest preview bytecode: 92 bytes, its jump lands on a JUMPDEST, it calls exactly harvest, received0, received1', () => {
  const code = PREVIEW_CODE.slice(2);
  assert.equal(code.length / 2, 92);
  // walk the opcodes
  const ops: { at: number; op: number; arg?: string }[] = [];
  for (let i = 0; i < code.length / 2; ) {
    const op = parseInt(code.slice(i * 2, i * 2 + 2), 16);
    if (op >= 0x60 && op <= 0x7f) {
      const n = op - 0x5f;
      ops.push({ at: i, op, arg: code.slice(i * 2 + 2, i * 2 + 2 + n * 2) });
      i += 1 + n;
    } else {
      ops.push({ at: i, op });
      i += 1;
    }
  }
  const jumps = ops.filter((o, k) => o.op === 0x60 && ops[k + 1]?.op === 0x57).map((o) => parseInt(o.arg!, 16));
  assert.deepEqual(jumps, [0x58, 0x58]);
  assert.equal(ops.find((o) => o.at === 0x58)!.op, 0x5b, 'JUMPDEST');
  const sels = ops.filter((o) => o.op === 0x63).map((o) => '0x' + o.arg);
  assert.deepEqual(sels, [toFunctionSelector('harvest()'), toFunctionSelector('received0()'), toFunctionSelector('received1()')]);
  assert.deepEqual(ops.filter((o) => [0xf1, 0xfa, 0xf3, 0xfd].includes(o.op)).map((o) => o.op), [0xf1, 0xfa, 0xfa, 0xf3, 0xfd], 'one CALL, two STATICCALLs, RETURN, REVERT');
});

// ---------------------------------------------------------------- ABIs against the sources

test('every ops ABI line is declared in the contracts', () => {
  const repo = join(ROOT, '..', '..');
  const src = [
    'src/curb/sharing/HolderFeeDistributor.sol',
    'src/curb/sharing/HolderDistributorFactory.sol',
    'src/curb/SharingCatalog.sol',
    'src/curb/FeeEscrow.sol',
    'src/curb/FeeHook.sol',
    'src/curb/PositionLock.sol',
    // the admin events and the wiring reads (gap items 19, 38)
    'src/curb/LaunchRegistry.sol',
    'src/curb/Graduator.sol',
    'src/curb/LaunchLens.sol',
    'lib/openzeppelin-contracts/contracts/access/Ownable.sol',
    'lib/openzeppelin-contracts/contracts/access/Ownable2Step.sol',
  ].map((p) => readFileSync(join(repo, p), 'utf8')).join('\n').replace(/\s+/g, ' ');
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  for (const e of [...DIST_ERRORS, ...FACTORY_ERRORS, ...GRADUATOR_ERRORS]) assert.ok(src.includes(norm(e) + ';'), e);
  for (const item of [...opsDistributorAbi, ...opsFactoryAbi, ...catalogAbi, ...ownableAbi, ...feeHookAbi, ...registryAbi, ...wiringAbi] as any[]) {
    if (item.type === 'event') {
      const sig = `event ${item.name}(${item.inputs.map((i: any) => `${i.type}${i.indexed ? ' indexed' : ''} ${i.name}`).join(', ')})`;
      assert.ok(src.includes(sig), sig);
    } else if (item.type === 'function') {
      const ok = new RegExp(`function ${item.name}\\(|(public|external)[^;]* ${item.name}[;(]|public ${item.name};|${item.name}\\)? public`).test(src) || src.includes(` public ${item.name}`) || new RegExp(`\\) public ${item.name}`).test(src);
      assert.ok(ok, `function ${item.name}`);
    }
  }
});

test('when gas is dear the 25x cost factor binds, not the dollar floor', () => {
  const dear = { ...econ, gasPrice: 100_000_000n }; // 0.1 gwei
  const cost = 45_000n * 100_000_000n + 1_000_000_000n;
  const floor = (50_000n * econ.perUsd) / 1_000_000n;
  assert.ok(25n * cost > floor, 'the cost factor is the larger here');
  const below = setup([{ cum0: 25n * cost - 1n }]);
  assert.equal(planPushes(below.tree, below.states, dear, rules, NOW).batches.length, 0, 'above the floor, below 25 x the cost: waits');
  const at = setup([{ cum0: 25n * cost }]);
  assert.equal(planPushes(at.tree, at.states, dear, rules, NOW).batches.length, 1);
});
