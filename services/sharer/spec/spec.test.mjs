// Checks of the CURB-SHARE v1 golden vectors that do not trust reference.mjs:
// figures derived by hand from the README rules, a naive block-by-block
// weight sum, an independent rebuild of the OpenZeppelin tree layout, the
// on-chain leaf encoding, and the epoch file bytes and hashes.
//
//   node --test spec.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { keccak256 } from 'ethereum-cryptography/keccak.js';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { runVector, vectorFiles, VECTORS_DIR, canonicalJson } from './reference.mjs';

const load = (name) => JSON.parse(readFileSync(join(VECTORS_DIR, name + '.json'), 'utf8'));
// Recomputed by the reference (never read from the fixtures), with the
// recomputed epoch file attached as plain JSON.
const results = (name) =>
  runVector(load(name)).map((r) => ({
    ...r.expected,
    epochFile: r.file ? JSON.parse(canonicalJson(r.file)) : undefined,
    chunkFiles: (r.chunkFiles ?? []).map((bytes) => ({ bytes, value: JSON.parse(bytes.toString('utf8')) })),
  }));
const byAccount = (x) => Object.fromEntries(x.accounts.map((a) => [a.a, a]));

const alice = '0xa100000000000000000000000000000000000001';
const bob = '0xb000000000000000000000000000000000000002';
const carol = '0xca00000000000000000000000000000000000003';
const dave = '0xda00000000000000000000000000000000000004';
const erin = '0xe100000000000000000000000000000000000005';
const frank = '0xf100000000000000000000000000000000000006';
const mallory = '0xaa00000000000000000000000000000000000007';
const ZEROADDR = '0x' + '0'.repeat(40);

const kHex = (hex) => '0x' + Buffer.from(keccak256(Buffer.from(hex.replace(/^0x/, ''), 'hex'))).toString('hex');
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const aword = (a) => a.slice(2).padStart(64, '0');

/** A recorded epoch file as written: its index, its chunk files (bytes and
 *  values) and every row, from the index or from the chunks in order. */
function recorded(x) {
  const index = JSON.parse(readFileSync(join(VECTORS_DIR, x.file), 'utf8'));
  const chunks = (x.chunkFiles ?? []).map((f) => {
    const bytes = readFileSync(join(VECTORS_DIR, f));
    return { bytes, value: JSON.parse(bytes.toString('utf8')) };
  });
  const rows = chunks.length ? chunks.flatMap((c) => c.value.accounts) : index.accounts;
  return { index, chunks, rows };
}

// --------------------------------------------------- hand-derived figures

test('v01: weights are balance x seconds after each block, with the 18 s gap', () => {
  const [x] = results('v01-mid-epoch-transfers');
  const a = byAccount(x);
  // dt(100..105) = 2, dt(106) = 18, dt(107..110) = 2.
  // alice: 1000 x 12 (blocks 100-105) + 600 x 26 (106-110)
  assert.equal(a[alice].w, String(1000 * 12 + 600 * 26));
  assert.equal(a[bob].w, String(500 * (6 + 18 + 8))); // from block 103
  assert.equal(a[carol].w, String(400 * 26)); // from block 106
  assert.equal(a[dave].w, String(300 * 2)); // bought in toBlock: one block
  assert.equal(a[erin], undefined); // bought after toBlock
  assert.equal(x.W, '54600');
  // income 546000 = 10 x W and 5460 = W / 10: exact shares.
  assert.equal(a[alice].s0, '276000');
  assert.equal(a[alice].s1, '2760');
  assert.equal(a[dave].s0, '6000');
  assert.equal(x.dH0, '546000');
  assert.equal(x.unallocated0, '0');
  assert.equal(x.K, '0');
});

test('v02: a same-block round trip weighs nothing and is not listed', () => {
  const [x] = results('v02-same-block-zero-weight');
  const a = byAccount(x);
  assert.equal(a[mallory], undefined);
  assert.equal(a[bob], undefined); // received and passed on in block 203
  assert.equal(a[alice].w, String(100 * 12));
  assert.equal(a[carol].w, String(50 * 6));
  assert.equal(a[dave].w, String(10 * 2));
  assert.equal(x.W, '1520');
  assert.equal(a[alice].s0, String(1200 * 7));
});

test('v03: history before sharingSince builds balances but earns nothing', () => {
  const [x] = results('v03-mid-life-enable-first-epoch');
  const a = byAccount(x);
  assert.equal(x.fromBlock, '300');
  assert.equal(a[alice].w, String(2000 * 12)); // sold 1000 in block 299 (F-1)
  assert.equal(a[carol].w, String(1000 * 10)); // sold in toBlock: blocks 300-304
  assert.equal(a[bob].w, String(1500 * 12)); // sold 500 in block 300 (F)
  assert.equal(a[dave].w, String(500 * 12));
  assert.equal(a[erin].w, String(1000 * 2));
  assert.equal(a[frank], undefined);
  // floor(600001 * w / 60000): 1 wei of quote dust; I1 = 3 gives alice 1.
  assert.equal(x.dH0, '600000');
  assert.equal(x.unallocated0, '1');
  assert.equal(a[alice].s1, '1');
  assert.equal(x.dH1, '1');
  assert.equal(x.unallocated1, '2');
  // 3000 USD / 150 USD = 20 NVDAc per ETH, 18 decimals.
  assert.equal(x.priceValue, String(20n * 10n ** 18n));
});

test('v04: excluded and detected accounts earn nothing and leave W', () => {
  const [x] = results('v04-exclusions-and-pools');
  const a = byAccount(x);
  const pm = '0x0b4a000000000000000000000000000000000001';
  const hook = '0x400c000000000000000000000000000000000001';
  const pair = '0x9a12000000000000000000000000000000000001';
  const v3pool = '0x9a12000000000000000000000000000000000004';
  const pair2 = '0x9a12000000000000000000000000000000000005';
  const unlisted = '0x9a12000000000000000000000000000000000003';
  for (const e of [pm, hook, pair, pair2, v3pool, unlisted]) {
    assert.equal(a[e], undefined, e);
    assert.ok(x.excluded.includes(e), e);
  }
  assert.equal(a['0x5afe000000000000000000000000000000000001'].w, String(700 * 10));
  assert.equal(a['0x9a12000000000000000000000000000000000002'].w, String(300 * 10));
  assert.equal(a[alice].w, String(1000 * 4 + 500 * 6));
  // 7000 + 3000 + 7000: the unlisted factory's pool (1000 x 10) left W too
  assert.equal(x.W, '17000');
  const file = x.epochFile;
  const reasons = Object.fromEntries(file.rules.exclusions.map((e) => [e.address, e.reason]));
  assert.equal(reasons[pair], 'detected pool (factory 0xa33f000000000000000000000000000000000002: listed v2-style factory)'); // the token is its token1
  assert.match(reasons[pair2], /^detected pool/); // the token is its token0
  assert.equal(reasons[unlisted], "detected pool (factory 0xbad0000000000000000000000000000000000001, not in the rules' list)");
  assert.equal(reasons[v3pool], 'listed by hand before detection');
});

test('v05 and v10: the no-epoch rules, in order, and an unconsumed range', () => {
  const x = results('v05-no-epoch-cases');
  assert.deepEqual(
    x.map((e) => e.result + ':' + (e.reason ?? e.epoch)),
    ['none:no-weight', 'none:no-income', 'none:nothing-allocated', 'epoch:1'],
  );
  assert.equal(x[3].fromBlock, '10');
  assert.equal(x[3].accounts[0].w, String(10 * 40));
  const [y] = results('v10-zero-weight-with-income');
  assert.equal(y.result, 'none');
  assert.equal(y.reason, 'no-weight');
  assert.equal(y.I0, '500');
});

test('v06: dust joins the next epoch; a seller keeps its leaf', () => {
  const [e1, e2, e3] = results('v06-dust-carry-and-history');
  assert.equal(e1.dH0, '99');
  assert.equal(e2.I0, '51'); // 150 received - 99 allocated
  assert.equal(e2.dH0, '51');
  const a2 = byAccount(e2);
  assert.equal(a2[carol].w, '0');
  assert.equal(a2[carol].cum0, '33');
  assert.ok(e2.leaves.some((l) => l[1] === carol && l[2] === '33'));
  assert.equal(a2[dave].cum0, '17');
  assert.equal(e2.dH1, '6');
  assert.equal(e3.I0, '0');
  assert.equal(e3.I1, '4'); // 10 - 6
  assert.equal(e3.dH1, '3');
  assert.equal(byAccount(e3)[alice].cum1, '3');
  assert.equal(e3.leaves.length, 4);
});

test('v07: keeper attribution, the 2% boundary, and the re-cap', () => {
  const [e1, e2, e3] = results('v07-keeper-fee-cap');
  // 1000*5 + 3000 direct, plus floor((2000*5 + 1) / 3) through publishMany.
  assert.equal(e1.keeperCostWei, String(8000 + 3333));
  assert.equal(e1.K, '11333');
  assert.equal(e1.recapped, false);
  // floor(5001 * 200 / 10000) = 100; 100 * 10000 == (4900 + 100) * 200.
  assert.equal(e2.I0, '5001');
  assert.equal(e2.K, '100');
  assert.equal(e2.dH0, '4900');
  assert.equal(BigInt(e2.K) * 10000n, (BigInt(e2.dH0) + BigInt(e2.K)) * 200n);
  assert.equal(e2.recapped, false);
  // K = 1, shares 12 + 36 = 48, 10000 > 9800: K = floor(48 * 200 / 9800) = 0.
  assert.equal(e3.I0, '50');
  assert.equal(e3.dH0, '48');
  assert.equal(e3.recapped, true);
  assert.equal(e3.K, '0');
  assert.equal(e3.C, '500000'); // half of the publishMany naming two distributors
  assert.equal(e3.unallocated0, '2');
  assert.equal(e1.epochFile.keeper.capped, false); // K = C
  assert.equal(e2.epochFile.keeper.capped, true);
  assert.equal(e3.epochFile.keeper.capped, true);
});

test('v07 epoch 4: the cap is exactly 2% and a publishMany must name D', () => {
  const [, , , e4] = results('v07-keeper-fee-cap');
  assert.equal(e4.I0, '1000002'); // 1000000 new + 2 dust from epoch 3
  assert.equal(e4.K, String((1000002n * 200n) / 10000n));
  assert.equal(e4.K, '20000');
  // only the 1e9 direct tx in 131-140; the a8 publishMany (block 109) named D2 and D3 only
  assert.equal(e4.keeperCostWei, '1000000000');
  const [e1] = results('v07-keeper-fee-cap');
  assert.ok(!e1.epochFile.keeper.txs.some((x) => x.hash.endsWith('a8')));
  assert.equal(e1.epochFile.keeper.txs.length, 2);
});

test('at most 512 keeper transactions are attributed: the lowest hashes', () => {
  // v07's first epoch with 520 direct keeper transactions, listed highest
  // hash first; transaction i costs 1 * 1 + i wei.
  const v = load('v07-keeper-fee-cap');
  v.epochs = v.epochs.slice(0, 1);
  const [key] = v.setup.rules.keeperKeys;
  v.setup.keeperTxs = Array.from({ length: 520 }, (_, j) => 520 - j).map((i) => ({
    hash: '0x' + word(i), from: key, to: v.setup.distributor, block: '105', gasUsed: '1', effectiveGasPrice: '1', l1Fee: String(i),
  }));
  const [e1] = runVector(v).map((r) => ({ ...r.expected, epochFile: JSON.parse(canonicalJson(r.file)) }));
  // the 512 lowest hashes are i = 1..512: sum of (1 + i)
  assert.equal(e1.keeperCostWei, String(512 + (512 * 513) / 2));
  assert.equal(e1.epochFile.keeper.txs.length, 512);
  assert.equal(e1.epochFile.keeper.txs[511].hash, '0x' + word(512));
});

test('v08: cbXRP keeper cost uses mixed-decimal feeds; a missing feed is free', () => {
  const [e1, e2] = results('v08-cbxrp-decimals-and-price');
  const value = (10n ** 6n * 350012345678n * 10n ** 18n) / (523456780000000000n * 10n ** 8n);
  assert.equal(e1.priceValue, value.toString());
  const cost = 210000n * 2000000n + 123456789n;
  assert.equal(e1.keeperCostWei, cost.toString());
  assert.equal(e1.C, ((cost * value) / 10n ** 18n).toString());
  assert.equal(e1.K, e1.C);
  assert.equal(e2.keeperCostWei, cost.toString());
  assert.equal(e2.priceValue, '0');
  assert.equal(e2.K, '0');
});

test('v15: USDC prices near $1 in six decimals, and its keeper fee never passes 2%', () => {
  const [e1, e2] = results('v15-usdc-stable-quote');
  // live Base, 2026-10-15: ETH/USD 2,426.06248936 and USDC/USD 0.99986720,
  // both 8 decimals - so P is USDC base units per ETH, about 2,426.38 USDC
  const P = (10n ** 6n * 242606248936n * 10n ** 8n) / (99986720n * 10n ** 8n);
  assert.equal(P, 2426384713n);
  assert.equal(e1.priceValue, P.toString());
  assert.equal(e1.epochFile.keeper.price.feed, '0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70,0x7e860098f58bbfc8648a4311b374b1d669a2bc6b');
  // a harvest and a publish at 0.006 gwei, each with that day's L1 fee
  const cost = (150000n + 120000n) * 6000000n + 2n * 2958565537n;
  assert.equal(e1.keeperCostWei, cost.toString());
  const C = (cost * P) / 10n ** 18n; // about $0.004
  assert.equal(e1.C, C.toString());
  assert.equal(C, 3945n);
  // epoch 1: a $0.15 pot. 2% of it is 3,000 units, below C: K is capped...
  assert.equal(e1.I0, '150000');
  assert.ok(C > (150000n * 200n) / 10000n);
  // ...and H = 147,000 rounds down to 146,999 across the holders, so 3,000
  // would be above 2% of what was allocated: re-capped to 146,999 x 200 / 9,800
  assert.equal(e1.H, '147000');
  assert.equal(e1.dH0, '146999');
  assert.equal(e1.recapped, true);
  assert.equal(e1.K, String((146999n * 200n) / 9800n));
  assert.equal(e1.K, '2999');
  assert.ok(BigInt(e1.K) * 10000n <= (BigInt(e1.dH0) + BigInt(e1.K)) * 200n, 'at most 2% of what the root allocates');
  // epoch 2: a $25 pot; the same cost is far under its cap, K = C
  assert.equal(e2.I0, String(25150000n - 146999n - 2999n));
  assert.equal(e2.K, C.toString());
  assert.equal(e2.recapped, false);
  assert.equal(e2.cumKeeper0, String(2999n + C));
});

test('v09: a veto burns the number and reopens the range', () => {
  const [e1, e2, e3, e4] = results('v09-veto-recompute');
  assert.equal(e2.epoch, '2');
  assert.equal(e3.epoch, '3');
  assert.equal(e3.fromBlock, '21');
  assert.deepEqual(e3.supersedes, ['2']);
  assert.equal(e3.I0, String(300000 - 99900 - 100));
  assert.equal(e3.keeperCostWei, String(300 + 100 + 300 + 100));
  const f3 = e3.epochFile;
  assert.equal(f3.prev.epoch, '1');
  assert.equal(f3.prev.contentHash, e1.contentHash);
  assert.equal(f3.prev.uri, 'ipfs://v09-epoch-1');
  assert.equal(e4.fromBlock, '41');
  assert.deepEqual(e4.supersedes, []);
  const f4 = e4.epochFile;
  assert.equal(f4.prev.contentHash, e3.contentHash);
});

test('v11: a re-cap keeps the shares and can leave a non-zero fee', () => {
  const [x] = results('v11-recap-nonzero');
  const a = byAccount(x);
  // H = 5000 - 100 = 4900; W = 10001 * 4 s.
  assert.equal(a[alice].s0, String((4900n * 40n) / 40004n));
  assert.equal(a[bob].s0, String((4900n * 39960n) / 40004n));
  assert.equal(a[bob].s0, '4894'); // recomputing from H = 4901 would give 4895
  // carol weighs 1 x 4 s, counts in W, gets no share: not listed, no leaf
  assert.equal(x.W, String(10001n * 4n));
  assert.equal(a[carol], undefined);
  assert.ok(!x.leaves.some((l) => l[1] === carol), 'no leaf for a zero cumulative value');
  assert.equal(x.recapped, true);
  assert.equal(x.K, String((4898n * 200n) / 9800n));
  assert.equal(x.K, '99');
  assert.equal(x.unallocated0, '3');
});

// ----------------------------------------------------- refused inputs

test('malformed inputs are refused, not computed', () => {
  const base = () => load('v01-mid-epoch-transfers');
  const refuse = (mutate, pattern) => {
    const v = base();
    mutate(v);
    assert.throws(() => runVector(v), pattern);
  };
  // a balance below zero
  refuse((v) => v.setup.transfers.push({ block: '104', logIndex: '0', from: bob, to: alice, value: '501' }), /below zero/);
  // received below what earlier roots allocated
  refuse((v) => {
    const e = v.epochs[0];
    v.epochs.push({ input: { ...e.input, toBlock: '111', received0: '1' } });
  }, /below what earlier roots allocated/);
  // toBlock before fromBlock
  refuse((v) => (v.epochs[0].input.toBlock = '99'), /before fromBlock/);
  // two logs at one (block, logIndex)
  refuse((v) => v.setup.transfers.push({ block: '103', logIndex: '0', from: alice, to: bob, value: '1' }), /share a \(block, logIndex\)/);
  // timestamps that go backwards
  refuse((v) => (v.setup.timestamps['104'] = '1001'), /backwards/);
  // a timestamp the weights need but the input lacks
  refuse((v) => delete v.setup.timestamps['105'], /timestamp of block 105/);
  // a transfer at or before the opening block
  refuse((v) => v.setup.transfers.push({ block: '99', logIndex: '0', from: ZEROADDR, to: alice, value: '1' }), /at or before the opening block/);
  // an opening block not before sharingSince
  refuse((v) => (v.setup.opening.block = '100'), /opening.block must be before sharingSince/);
  // numbers where strings are required
  refuse((v) => (v.epochs[0].input.received0 = 546000), /decimal integer string/);
  refuse((v) => (v.setup.distributor = '0x1234'), /not an address/);
});

// ------------------------------------------------- independent recomputation

// The naive definition, block by block from the vector's opening state:
// raw_a = sum over b in [F, T] of bal_a(b) * (ts(b) - ts(b-1));
// supply = every balance after T, summed; floor = supply / 10^6 * (ts(T) - ts(F-1));
// w_a = raw_a when raw_a >= floor, else 0. Also returns every balance after T.
function naiveWeights(vector, x) {
  const s = vector.setup;
  const F = BigInt(x.fromBlock);
  const T = BigInt(x.toBlock);
  const transfers = (s.transfers ?? []).map((t) => ({ ...t, block: BigInt(t.block), logIndex: BigInt(t.logIndex), value: BigInt(t.value), from: t.from.toLowerCase(), to: t.to.toLowerCase() }));
  transfers.sort((p, q) => (p.block === q.block ? Number(p.logIndex - q.logIndex) : Number(p.block - q.block)));
  const zero = '0x' + '0'.repeat(40);
  const replay = (onBlock) => {
    const bal = new Map(Object.entries(s.opening.balances ?? {}).map(([a, v]) => [a.toLowerCase(), BigInt(v)]));
    let i = 0;
    for (let b = BigInt(s.opening.block) + 1n; b <= T; b++) {
      for (; i < transfers.length && transfers[i].block === b; i++) {
        const t = transfers[i];
        if (t.from !== zero) bal.set(t.from, (bal.get(t.from) ?? 0n) - t.value);
        if (t.to !== zero) bal.set(t.to, (bal.get(t.to) ?? 0n) + t.value);
      }
      onBlock(b, bal);
    }
    return bal;
  };
  const w = new Map();
  const after = replay((b, bal) => {
    if (b < F) return;
    const dt = BigInt(s.timestamps[String(b)]) - BigInt(s.timestamps[String(b - 1n)]);
    for (const [a, v] of bal) if (v > 0n) w.set(a, (w.get(a) ?? 0n) + v * dt);
  });
  let supply = 0n;
  for (const v of after.values()) supply += v;
  const floor = (supply / 1000000n) * (BigInt(s.timestamps[String(T)]) - BigInt(s.timestamps[String(F - 1n)]));
  for (const [a, v] of w) if (v < floor) w.set(a, 0n);
  return { w, after, supply, floor };
}

test('every weight, W, the floor and the supply equal the naive block-by-block sums (every epoch)', () => {
  let checked = 0;
  for (const path of vectorFiles()) {
    const vector = JSON.parse(readFileSync(path, 'utf8'));
    for (const x of vector.epochs.map((e) => e.expected).filter((e) => e.result === 'epoch')) {
      const { w: naive, supply, floor } = naiveWeights(vector, x);
      assert.equal(x.supply, String(supply), path);
      assert.equal(x.floor, String(floor), path);
      let W = 0n;
      for (const [a, v] of naive) if (!x.excluded.includes(a)) W += v;
      assert.equal(x.W, String(W), `${path} epoch ${x.epoch}: W`);
      for (const acc of x.accounts) {
        if (x.excluded.includes(acc.a)) continue;
        assert.equal(acc.w, String(naive.get(acc.a) ?? 0n), `${path} ${acc.a}`);
        checked++;
      }
      // Listed: every holder whose weight earns a share in either asset.
      const H = BigInt(x.H);
      const I1 = BigInt(x.I1);
      for (const [a, v] of naive) {
        if (x.excluded.includes(a) || v === 0n) continue;
        if ((H * v) / W > 0n || (I1 * v) / W > 0n) assert.ok(x.accounts.some((acc) => acc.a === a), `${path}: ${a} has a share but is not listed`);
      }
    }
  }
  assert.ok(checked >= 40, `only ${checked} weights checked`);
});

test('stateAtEnd commits to every balance after T; a row carries only its own account balance', () => {
  let files = 0;
  for (const path of vectorFiles()) {
    const vector = JSON.parse(readFileSync(path, 'utf8'));
    for (const x of vector.epochs.map((e) => e.expected).filter((e) => e.result === 'epoch')) {
      const { index: file, rows } = recorded(x);
      const { after, supply } = naiveWeights(vector, x);
      const held = [...after].filter(([, v]) => v > 0n).sort((p, q) => (p[0] < q[0] ? -1 : 1));
      assert.equal(file.stateAtEnd.count, String(held.length), `${path} epoch ${x.epoch}`);
      assert.equal(file.stateAtEnd.supply, String(supply));
      const enc = Buffer.from(held.map(([a, v]) => aword(a) + word(v)).join(''), 'hex');
      assert.equal(file.stateAtEnd.digest, '0x' + createHash('sha256').update(enc).digest('hex'));
      assert.equal(file.weights.W, x.W);
      assert.equal(file.weights.floor, x.floor);
      // every listed account's balance after T, 0 when it holds none
      for (const r of rows) assert.equal(r.b, String(after.get(r.a) ?? 0n), `${path} epoch ${x.epoch} ${r.a}`);
      assert.deepEqual(rows.map((r) => r.a), x.accounts.map((a) => a.a));
      files++;
    }
  }
  assert.equal(files, 26);
});

test('v12: the weight floor, weight without a share, and dust that only the complete state carries', () => {
  const [e1, e2] = results('v12-weight-floor-and-dust');
  const erin = '0xe100000000000000000000000000000000000005';
  const frank = '0xf100000000000000000000000000000000000006';
  const gina = '0x9100000000000000000000000000000000000008';
  const hank = '0x4a00000000000000000000000000000000000009';
  const ivan = '0x1a00000000000000000000000000000000000010';
  const relay = (i) => '0x4e1a' + i.toString(16).padStart(36, '0');
  const dust1 = '0xd057000000000000000000000000000000000001';
  // ts(b) = 1000 + 2 (b - 99): 22 s; supply 10,000,000; floor 10 x 22.
  assert.equal(e1.floor, '220');
  // alice 6,000,000 for blocks 100-104, then 5,999,990; bob 3,999,839 then
  // 3,999,829 from 103; carol 11 x 22; erin 5 x 6 + 15 x 16; ivan 100 x 8;
  // the last relay 100 x 6. Below the floor, so no weight: each of the four
  // relays (100 x 2 = 200), frank (10 x 4 + 9 x 8 = 112), gina, the dust.
  const w1 = 6000000n * 10n + 5999990n * 12n + (3999839n * 6n + 3999829n * 16n) + 11n * 22n + (5n * 6n + 15n * 16n) + 100n * 8n + 100n * 6n;
  assert.equal(e1.W, String(w1));
  assert.deepEqual(e1.accounts.map((x) => x.a), [alice, bob], 'only the holders with a share are listed');
  assert.deepEqual(e1.epochFile.accounts.map((r) => [r.a, r.b !== '0']), [[alice, true], [bob, true]]);
  assert.equal(e1.epochFile.stateAtEnd.count, '16', 'the 14 opening holders, less ivan, plus frank, gina and the last relay');
  // Epoch 2 (20 s): dust1 sends the 5 the file never listed; alice burns
  // 1,000,000, so the floor is 9 x 20 = 180.
  assert.equal(e2.supply, '9000000');
  assert.equal(e2.floor, '180');
  const a2 = byAccount(e2);
  assert.equal(a2[frank].w, String(9n * 20n), 'frank 9 for the whole window is exactly the floor');
  assert.equal(a2[hank].w, String(15n * 12n), 'hank, from block 115, exactly the floor');
  assert.equal(a2[carol].w, String(11n * 20n));
  assert.equal(a2[relay(5)].w, String(100n * 20n));
  for (const nobody of [erin, gina, dave, dust1, ivan, relay(1)]) assert.equal(a2[nobody], undefined, nobody);
  assert.equal(a2[alice].w, String(5999990n * 14n + 4999990n * 6n), 'the burn in block 118 counts from ts(117)');
});

test('v13: pools on any factory are detected; look-alikes and unweighed pools are not', () => {
  const [x] = results('v13-pools-on-any-factory');
  const p = (n) => '0x9a13' + n.toString(16).padStart(36, '0');
  const reasons = Object.fromEntries(x.epochFile.rules.exclusions.map((e) => [e.address, e.reason]));
  assert.equal(reasons[p(1)], 'detected pool (factory 0xa33f000000000000000000000000000000000002: listed v2-style factory)');
  assert.equal(reasons[p(2)], "detected pool (factory 0xbad0000000000000000000000000000000000001, not in the rules' list)");
  assert.equal(reasons[p(3)], 'detected pool (no factory())');
  assert.equal(reasons[p(7)], 'listed by hand before detection');
  assert.equal(reasons[p(6)], undefined, 'a pool weighing less than the floor (1 x 12 < 2 x 12) is never probed');
  const a = byAccount(x);
  assert.equal(a[p(4)].w, String(50000n * 12n), 'a pair without this token is a holder');
  assert.equal(a[p(5)].w, String(49999n * 12n), 'a contract where only factory() answers is a holder');
  for (const n of [1, 2, 3, 6, 7]) assert.equal(a[p(n)], undefined);
});

// OpenZeppelin StandardMerkleTree layout, rebuilt by hand: leaves sorted by
// hash, placed at the end of a 2n-1 array in reverse, each parent the keccak of
// its two children in sorted order.
function ozRoot(leafHashes) {
  const sorted = [...leafHashes].sort((p, q) => Buffer.compare(Buffer.from(p.slice(2), 'hex'), Buffer.from(q.slice(2), 'hex')));
  const n = sorted.length;
  const tree = new Array(2 * n - 1);
  sorted.forEach((h, i) => (tree[tree.length - 1 - i] = h));
  for (let i = tree.length - 1 - n; i >= 0; i--) {
    const [l, r] = [tree[2 * i + 1], tree[2 * i + 2]].sort((p, q) => Buffer.compare(Buffer.from(p.slice(2), 'hex'), Buffer.from(q.slice(2), 'hex')));
    tree[i] = kHex(l.slice(2) + r.slice(2));
  }
  return tree[0];
}

test('leaves, leaf hashes, roots and proofs match the on-chain encoding', () => {
  let epochs = 0;
  for (const path of vectorFiles()) {
    const vector = JSON.parse(readFileSync(path, 'utf8'));
    for (const x of vector.epochs.map((e) => e.expected).filter((e) => e.result === 'epoch')) {
      const D = vector.setup.distributor.toLowerCase();
      assert.equal(x.leaves.length, x.leafHashes.length);
      let sum0 = 0n;
      let sum1 = 0n;
      x.leaves.forEach((l, i) => {
        assert.equal(l[0], D, 'leaf bound to the distributor');
        assert.ok(l[2] !== '0' || l[3] !== '0', 'no all-zero leaf');
        const h = kHex(kHex(aword(l[0]) + aword(l[1]) + word(l[2]) + word(l[3])).slice(2));
        assert.equal(x.leafHashes[i], h);
        sum0 += BigInt(l[2]);
        sum1 += BigInt(l[3]);
      });
      assert.equal(sum0.toString(), x.cumHolders0);
      assert.equal(sum1.toString(), x.cumHolders1);
      // The tree in chunks of 512 leaves in account order; past one chunk,
      // the same layout over the chunk roots (SimpleMerkleTree: the values
      // themselves, sorted).
      const chunkHashes = [];
      for (let i = 0; i < x.leafHashes.length; i += 512) chunkHashes.push(x.leafHashes.slice(i, i + 512));
      const chunkRoots = chunkHashes.map(ozRoot);
      assert.equal(chunkRoots.length === 1 ? chunkRoots[0] : ozRoot(chunkRoots), x.merkleRoot);
      assert.deepEqual(x.chunks.map((c) => c.root), chunkRoots.length === 1 ? [] : chunkRoots);
      // Every leaf proves against the root as MerkleProof.verify folds a
      // proof: its chunk's proof, then its chunk root's.
      const fold = (leaf, proof) => proof.reduce((h, p) => (Buffer.compare(Buffer.from(h.slice(2), 'hex'), Buffer.from(p.slice(2), 'hex')) < 0 ? kHex(h.slice(2) + p.slice(2)) : kHex(p.slice(2) + h.slice(2))), leaf);
      const top = chunkRoots.length > 1 ? StandardMerkleTree.of(chunkRoots.map((r) => [r]), ['bytes32']) : null;
      for (let k = 0; k < chunkHashes.length; k++) {
        const ls = x.leaves.slice(k * 512, (k + 1) * 512);
        const tree = StandardMerkleTree.of(ls, ['address', 'address', 'uint256', 'uint256']);
        // the top's proof of this chunk's root, by hand: the sibling path in the OZ layout
        const up = top ? simpleProof(chunkRoots, chunkRoots[k]) : [];
        for (const [i, l] of tree.entries()) assert.ok(fold(tree.leafHash(l), [...tree.getProof(i), ...up]) === x.merkleRoot);
      }
      epochs++;
    }
  }
  assert.ok(epochs >= 15, `only ${epochs} epochs`);
});

/** The proof of `value` among `values` in the OpenZeppelin layout (values
 *  sorted, placed at the end of a 2n-1 array in reverse), by hand. */
function simpleProof(values, value) {
  const sorted = [...values].sort((p, q) => Buffer.compare(Buffer.from(p.slice(2), 'hex'), Buffer.from(q.slice(2), 'hex')));
  const n = sorted.length;
  const tree = new Array(2 * n - 1);
  sorted.forEach((h, i) => (tree[tree.length - 1 - i] = h));
  for (let i = tree.length - 1 - n; i >= 0; i--) {
    const [l, r] = [tree[2 * i + 1], tree[2 * i + 2]].sort((p, q) => Buffer.compare(Buffer.from(p.slice(2), 'hex'), Buffer.from(q.slice(2), 'hex')));
    tree[i] = kHex(l.slice(2) + r.slice(2));
  }
  const proof = [];
  for (let i = tree.indexOf(value); i > 0; i = Math.floor((i - 1) / 2)) proof.push(tree[i % 2 === 1 ? i + 1 : i - 1]);
  return proof;
}

test('v14: past 512 accounts the rows go in chunk files of 512, the tree in chunks under the root over their roots', () => {
  const [e1, e2] = results('v14-chunked-file');
  const holder = (n) => '0xc0' + n.toString(16).padStart(38, '0');
  // epoch 1: the ten holders from before sharing, 100,000 each, in the index
  assert.equal(e1.epochFile.accounts.length, 10);
  assert.deepEqual(e1.epochFile.chunks, []);
  assert.ok(e1.epochFile.accounts.every((r) => r.s0 === '100000' && r.cum0 === '100000' && r.b === '1000000'));
  // epoch 2: 1,099 holders weigh (the seller 490 does not) and the seller keeps its leaf: 1,100 rows
  assert.equal(e2.accounts.length, 1100);
  assert.deepEqual(e2.epochFile.accounts, [], 'a chunked index lists no rows');
  const c = e2.epochFile.chunks;
  assert.deepEqual(c.map((x) => [x.first, x.last, x.count]), [
    [holder(1), holder(512), '512'],
    [holder(513), holder(1024), '512'],
    [holder(1025), holder(1100), '76'],
  ]);
  const chunks = e2.chunkFiles;
  const rows = chunks.flatMap((ch) => ch.value.accounts);
  chunks.forEach((ch, k) => {
    assert.equal(ch.value.schema, 'curb.sharing.chunk/1');
    assert.equal(ch.value.epoch, '2');
    assert.equal(c[k].size, String(ch.bytes.length));
    assert.equal(c[k].sha256, '0x' + createHash('sha256').update(ch.bytes).digest('hex'));
    assert.equal(c[k].sum0, String(ch.value.accounts.reduce((s, r) => s + BigInt(r.cum0), 0n)));
    assert.equal(c[k].sum1, String(ch.value.accounts.reduce((s, r) => s + BigInt(r.cum1), 0n)));
  });
  const row = Object.fromEntries(rows.map((r) => [r.a, r]));
  // the seller: no weight, no share, its epoch 1 value carried, no balance
  assert.deepEqual([row[holder(490)].w, row[holder(490)].s0, row[holder(490)].cum0, row[holder(490)].b], ['0', '0', '100000', '0']);
  // an old holder in the last chunk: its epoch 1 value plus this share
  assert.equal(BigInt(row[holder(1040)].cum0), 100000n + BigInt(row[holder(1040)].s0));
  // the chunk sums add to the root's totals
  assert.equal(c.reduce((s, x) => s + BigInt(x.sum0), 0n).toString(), e2.cumHolders0);
});

test('epoch files are canonical JSON whose sha256 is the contentHash', () => {
  for (const path of vectorFiles()) {
    const vector = JSON.parse(readFileSync(path, 'utf8'));
    for (const x of vector.epochs.map((e) => e.expected).filter((e) => e.result === 'epoch')) {
      const bytes = readFileSync(join(VECTORS_DIR, x.file));
      assert.equal('0x' + createHash('sha256').update(bytes).digest('hex'), x.contentHash);
      const text = bytes.toString('utf8');
      const parsed = JSON.parse(text);
      // Canonical: re-serialising with sorted keys and no whitespace is the identity.
      const canon = (v) => (Array.isArray(v) ? '[' + v.map(canon).join(',') + ']' : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}' : JSON.stringify(v));
      assert.equal(canon(parsed), text);
      assert.ok(!/[\s]/.test(text.replace(/"(?:[^"\\]|\\.)*"/g, '')), 'no whitespace outside strings');
      assert.ok(!/:\s*-?\d/.test(text.replace(/"(?:[^"\\]|\\.)*"/g, '""')), 'no bare numbers');
      assert.equal(parsed.schema, 'curb.sharing.epoch/1');
      assert.equal(parsed.merkle.leafEncoding, 'address,address,uint256,uint256');
      assert.equal(parsed.merkle.root, x.merkleRoot);
      assert.equal(parsed.epoch, x.epoch);
      assert.equal(parsed.window.fromBlock, x.fromBlock);
      assert.equal(parsed.keeper.fee, x.K);
      // The rows: in the index up to 512, in chunk files (canonical too) past that.
      const { chunks, rows } = recorded(x);
      assert.deepEqual(parsed.chunks, x.chunks);
      if (rows.length <= 512) assert.equal(chunks.length, 0);
      else {
        assert.deepEqual(parsed.accounts, []);
        assert.equal(chunks.length, Math.ceil(rows.length / 512));
        chunks.forEach((c, k) => {
          assert.equal(canon(c.value), c.bytes.toString('utf8'));
          assert.equal(c.value.accounts.length, k < chunks.length - 1 ? 512 : rows.length - 512 * k);
          assert.equal(parsed.chunks[k].sha256, '0x' + createHash('sha256').update(c.bytes).digest('hex'));
        });
      }
      assert.deepEqual(rows.map((r) => [parsed.distributor, r.a, r.cum0, r.cum1]), x.leaves);
      // The transfer digest is keccak of abi.encode(block, logIndex, from, to, value) per replayed log.
      assert.match(parsed.inputs.transfers.digest, /^0x[0-9a-f]{64}$/);
    }
  }
});

test('the transfer digest of v01 is the keccak of the five replayed logs', () => {
  const [x] = results('v01-mid-epoch-transfers');
  const file = x.epochFile;
  const v = load('v01-mid-epoch-transfers');
  const replayed = v.setup.transfers.filter((t) => BigInt(t.block) <= 110n);
  assert.equal(file.inputs.transfers.count, String(replayed.length));
  const enc = replayed.map((t) => word(t.block) + word(t.logIndex) + aword(t.from.toLowerCase()) + aword(t.to.toLowerCase()) + word(t.value)).join('');
  assert.equal(file.inputs.transfers.digest, kHex(enc));
});

test('canonicalJson refuses plain numbers and sorts keys', () => {
  assert.throws(() => canonicalJson({ a: 1 }));
  assert.equal(canonicalJson({ b: 1n, a: [true, null, 'x'] }), '{"a":[true,null,"x"],"b":"1"}');
});

test('two cold runs produce identical bytes', () => {
  for (const path of vectorFiles()) {
    const vector = JSON.parse(readFileSync(path, 'utf8'));
    const a = runVector(vector).map((r) => r.fileBytes?.toString('hex') ?? '');
    const b = runVector(JSON.parse(readFileSync(path, 'utf8'))).map((r) => r.fileBytes?.toString('hex') ?? '');
    assert.deepEqual(a, b);
  }
});

// ------------------------------------------------ the pinned ABI document

test('docs/sharing/INTERFACES.md: every listed topic0 and selector is right', () => {
  const doc = readFileSync(join(VECTORS_DIR, '..', '..', '..', '..', 'docs', 'sharing', 'INTERFACES.md'), 'utf8');
  const sig = (s) => Buffer.from(keccak256(Buffer.from(s))).toString('hex');
  let events = 0;
  for (const m of doc.matchAll(/^\| `(\w+)\(([^)]*)\)` \| [^|]+ \| `(0x[0-9a-f]{64})` \|$/gm)) {
    const types = m[2].split(',').map((p) => p.trim().split(/\s+/)[0]).join(',');
    assert.equal('0x' + sig(`${m[1]}(${types})`), m[3], m[1]);
    events++;
  }
  assert.equal(events, 8);
  let fns = 0;
  for (const m of doc.matchAll(/`(\w+\([\w,]*\))` `(0x[0-9a-f]{8})`/g)) {
    assert.equal('0x' + sig(m[1]).slice(0, 8), m[2], m[1]);
    fns++;
  }
  assert.ok(fns >= 20, `only ${fns} selectors`);
});
