// verifyEpochFile: every way a file can be wrong is listed, and a golden file
// passes. Each tamper below changes one thing, re-encodes canonically, and
// expects the problem that names it. The chunked file (v14 epoch 2) is
// checked with its chunks, without them, and with each part of a chunk and
// of its index's description of it changed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTree,
  canonicalJson,
  chunkIndexOf,
  ChunksNeeded,
  epochPart,
  leafHash,
  parseEpochFile,
  parseEpochIndex,
  proofOf,
  readEpochFile,
  sha256Hex,
  stateFromEpochFile,
  treeOf,
  verifyEpochFile,
  verifyProof,
  type EpochFile,
  type Leaf,
} from '../src/calc/index.ts';
import { loadVector, readVectorChunks, readVectorFile } from './helpers.ts';

const enc = (j: unknown) => new TextEncoder().encode(canonicalJson(j));
const dec = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b));
const golden = (name: string, i: number) => {
  const v = loadVector(name);
  const x = v.epochs[i].expected;
  return { x, bytes: readVectorFile(x.file)!, json: () => dec(readVectorFile(x.file)!), chunks: readVectorChunks(x) };
};
/** The root of an index whose rows are in it, from those rows. */
const reroot = (j: any) => {
  j.merkle.root = buildTree(j.accounts.map((a: any): Leaf => [j.distributor, a.a, a.cum0, a.cum1])).tree.root;
  return j;
};

// v07 epoch 1: keeper txs, no prev. v09 epoch 3: prev = epoch 1, supersedes [2].
const k = golden('v07-keeper-fee-cap', 0);
const p1 = golden('v09-veto-recompute', 0);
const p3 = golden('v09-veto-recompute', 2);
const prev1: EpochFile = parseEpochFile(p1.bytes);
// v14: epoch 1 in its index, epoch 2 in three chunks.
const c1 = golden('v14-chunked-file', 0);
const c2 = golden('v14-chunked-file', 1);
const cPrev: EpochFile = parseEpochFile(c1.bytes);

function problems(j: any, chain = {}, prev: EpochFile | null = null): string[] {
  return verifyEpochFile(enc(j), chain, prev).problems;
}

function expectProblem(name: string, j: any, re: RegExp, chain = {}, prev: EpochFile | null = null) {
  const ps = problems(j, chain, prev);
  assert.ok(ps.some((p) => re.test(p)), `${name}: expected ${re}, got ${JSON.stringify(ps)}`);
}

test('golden files pass, alone and with their predecessor', () => {
  assert.deepEqual(problems(k.json()), []);
  assert.deepEqual(problems(p3.json(), {}, prev1), []);
});

test('the bytes: the on-chain hash, canonical form, UTF-8, JSON', () => {
  assert.ok(verifyEpochFile(k.bytes, { contentHash: '0x' + '0'.repeat(64) }).problems.some((p) => /on-chain contentHash/.test(p)));
  assert.deepEqual(verifyEpochFile(k.bytes, { contentHash: k.x.contentHash.toUpperCase().replace('0X', '0x') }).problems, []);
  const spaced = new TextEncoder().encode(JSON.stringify(k.json(), null, 1));
  assert.ok(verifyEpochFile(spaced).problems.some((p) => /canonical form/.test(p)));
  assert.ok(verifyEpochFile(new Uint8Array([0xff, 0xfe])).problems.some((p) => /UTF-8/.test(p)));
  assert.ok(verifyEpochFile(new TextEncoder().encode('{')).problems.some((p) => /not JSON/.test(p)));
});

test('the shape: schema, keys, lowercase addresses, integers as strings, rows of exactly their fields', () => {
  expectProblem('schema', { ...k.json(), schema: 'curb.sharing.epoch/2' }, /schema/);
  expectProblem('extra key', { ...k.json(), extra: '1' }, /keys are/);
  const j = k.json();
  j.distributor = j.distributor.toUpperCase().replace('0X', '0x');
  expectProblem('uppercase', j, /not lowercase/);
  const j2 = k.json();
  j2.epoch = 1;
  assert.throws(() => enc(j2), /not allowed/);
  expectProblem('leafEncoding', { ...k.json(), merkle: { ...k.json().merkle, leafEncoding: 'address,uint256,uint256' } }, /leafEncoding/);
  const j3 = k.json();
  delete j3.accounts[0].b;
  expectProblem('a row without its balance', j3, /accounts\[0\]: keys are/);
  const j4 = k.json();
  j4.merkle.leaves = [];
  expectProblem('leaves are not written: the rows are', j4, /merkle: keys are/);
});

test('shares are re-derived from the weights', () => {
  const j = k.json();
  j.accounts[0].s0 = String(BigInt(j.accounts[0].s0) + 1n);
  expectProblem('s0', j, /s0 \d+ is not/);
  const j2 = k.json();
  j2.accounts[1].s1 = String(BigInt(j2.accounts[1].s1) + 1n);
  expectProblem('s1', j2, /s1 \d+ is not/);
  const j3 = k.json();
  j3.accounts[0].w = String(BigInt(j3.accounts[0].w) * 2n);
  expectProblem('weight', j3, /s0 \d+ is not/);
});

test('the leaves are the rows, and the root is theirs', () => {
  const j = k.json();
  j.accounts[0].cum0 = String(BigInt(j.accounts[0].cum0) + 1n);
  expectProblem('a cumulative value, root kept', j, /rebuilt root/);
  expectProblem('sum', reroot(j), /leaves sum to \d+ in asset 0/);
  const j2 = k.json();
  j2.merkle.root = '0x' + '1'.repeat(64);
  expectProblem('root', j2, /rebuilt root/);
  const j5 = k.json();
  j5.accounts[0].cum1 = String(BigInt(j5.accounts[0].cum1) + 1n);
  expectProblem('sum 1', reroot(j5), /leaves sum to \d+ in asset 1/);
  const j6 = k.json();
  j6.accounts[0].cum0 = String(BigInt(j6.accounts[0].s0) - 1n);
  expectProblem('cum below share', reroot(j6), /cumulative is below its share/);
  // Each leaf is the on-chain encoding of [this distributor, the row's account, cum0, cum1].
  const f = parseEpochFile(k.bytes);
  const t = treeOf(f);
  for (const l of f.merkle.leaves) {
    assert.equal(l[0], f.distributor);
    assert.ok(verifyProof(f.merkle.root, leafHash(f.distributor, l[1], l[2], l[3]), proofOf(t, l[1])!.proof));
  }
});

test('the keeper fee: cost from shares x price, the cap, the re-cap, capped, per-tx shares', () => {
  const j = k.json();
  j.keeper.fee = String(BigInt(j.keeper.fee) * 100n);
  expectProblem('fee', j, /keeper fee \d+ is not/);
  expectProblem('fee cap', j, /above the on-chain 2% cap/);
  const j2 = k.json();
  j2.keeper.capped = !j2.keeper.capped;
  expectProblem('capped', j2, /capped/);
  const j3 = k.json();
  j3.keeper.cost = String(BigInt(j3.keeper.cost) + 1n);
  expectProblem('cost', j3, /keeper cost/);
  const j4 = k.json();
  j4.keeper.txs[0].share = String(BigInt(j4.keeper.txs[0].gasUsed) * BigInt(j4.keeper.txs[0].price) + BigInt(j4.keeper.txs[0].l1Fee) + 1n);
  expectProblem('share above cost', j4, /above its cost/);
  const j5 = k.json();
  j5.keeper.price.value = '1';
  expectProblem('weth price', j5, /weth price/);
  const j6 = k.json();
  j6.keeper.price = { source: 'none', feed: '', round: '', value: '5' };
  expectProblem('none price', j6, /missing price must be 0/);
});

test('a file naming more keeper transactions than an epoch attributes is refused', () => {
  // 513 transactions, sorted, each sharing nothing: every other figure holds.
  const j = k.json();
  const extra = Array.from({ length: 513 - j.keeper.txs.length }, (_, i) => ({ hash: '0xff' + i.toString(16).padStart(62, '0'), gasUsed: '1', price: '1', l1Fee: '0', share: '0' }));
  j.keeper.txs = [...j.keeper.txs, ...extra];
  assert.equal(j.keeper.txs.length, 513);
  assert.deepEqual(
    problems(j).filter((p) => !/more than the 512/.test(p)),
    [],
  );
  expectProblem('513 txs', j, /keeper txs name 513 transactions, more than the 512/);
  j.keeper.txs = j.keeper.txs.slice(0, 512);
  assert.deepEqual(problems(j), []);
});

test('sorted lists, listed accounts', () => {
  const j = k.json();
  j.rules.exclusions.reverse();
  expectProblem('exclusions order', j, /exclusions are not sorted/);
  const j2 = k.json();
  j2.accounts.reverse();
  expectProblem('accounts order', j2, /accounts are not sorted/);
  const j3 = k.json();
  j3.keeper.txs.reverse();
  expectProblem('txs order', j3, /keeper txs are not sorted/);
  const j4 = k.json();
  j4.rules.keeperKeys.reverse();
  expectProblem('keys order', j4, /keeperKeys are not sorted/);
  const j6 = k.json();
  const excl = j6.rules.exclusions[0].address;
  j6.accounts.push({ a: excl, w: '5', s0: '0', s1: '0', cum0: '1', cum1: '0', b: '0' });
  j6.accounts.sort((x: any, y: any) => (x.a < y.a ? -1 : 1));
  expectProblem('excluded with weight', reroot(j6), /excluded account .* has a weight/);
  const j7 = k.json();
  j7.accounts.push({ a: '0x' + 'f'.repeat(40), w: '0', s0: '0', s1: '0', cum0: '0', cum1: '0', b: '0' });
  expectProblem('listed with nothing', j7, /listed with no cumulative value/);
  // A weight that takes no share is in W only: listing it is refused too.
  const j8 = k.json();
  j8.accounts.push({ a: '0x' + 'f'.repeat(40), w: '1', s0: '0', s1: '0', cum0: '0', cum1: '0', b: '5' });
  expectProblem('listed with a weight but no share', j8, /listed with no cumulative value/);
  // with its predecessor: no share and no earlier leaf is no row
  const j9 = p3.json();
  j9.accounts.push({ a: '0x' + 'f'.repeat(40), w: '0', s0: '0', s1: '0', cum0: '1', cum1: '0', b: '0' });
  expectProblem('listed with no share and no earlier leaf', reroot(j9), /listed with no share and no earlier cumulative/, {}, prev1);
});

test('the weights: W as the file gives it, the floor a millionth of the supply over the window, no listed weight below it', () => {
  const j = k.json();
  j.weights.W = String(BigInt(j.weights.W) + 1n);
  expectProblem('W', j, /s0 \d+ is not/);
  const j2 = k.json();
  j2.weights.W = String(j2.accounts.reduce((x: bigint, a: any) => x + BigInt(a.w), 0n) - 1n);
  expectProblem('W below the listed weights', j2, /listed weights sum to \d+, more than W/);
  const j3 = k.json();
  j3.weights.W = '0';
  expectProblem('W zero', j3, /W is 0/);
  const j4 = k.json();
  j4.weights.floor = String(BigInt(j4.weights.floor) + 1n);
  expectProblem('floor', j4, /weight floor \d+ is not supply/);
  const f = golden('v12-weight-floor-and-dust', 1);
  assert.deepEqual(problems(f.json(), {}, parseEpochFile(golden('v12-weight-floor-and-dust', 0).bytes)), []);
  const j5 = f.json();
  j5.stateAtEnd.supply = String(BigInt(j5.stateAtEnd.supply) * 2n);
  expectProblem('floor from the supply', j5, /weight floor 180 is not supply \/ 1000000 x 20 s = 360/);
  const j6 = f.json();
  const small = j6.accounts.find((a: any) => a.w === '180');
  small.w = '179';
  expectProblem('below the floor', j6, /weight 179 is below the floor 180/);
});

test('the state after T: the rows balances are within the committed state', () => {
  const j2 = k.json();
  j2.stateAtEnd.count = '1';
  expectProblem('count', j2, /the rows' balances \(\d+, summing to \d+\) are more than the state/);
  const j3 = k.json();
  j3.stateAtEnd.supply = '0';
  expectProblem('empty state with balances', j3, /stateAtEnd counts \d+ balances summing to 0/);
  const j4 = k.json();
  delete j4.stateAtEnd;
  expectProblem('no commitment', j4, /keys are/);
  const j5 = k.json();
  j5.stateAtEnd.digest = '0x12';
  expectProblem('digest shape', j5, /stateAtEnd.digest: not a 32-byte hex value/);
  // the balances read back are the rows' non-zero ones
  const f = parseEpochFile(k.bytes);
  assert.deepEqual(Object.keys(f.balancesAtEnd), k.json().accounts.filter((a: any) => a.b !== '0').map((a: any) => a.a));
});

test('income: never allocate more than received', () => {
  const j = k.json();
  j.inputs.received0 = String(BigInt(k.x.cumHolders0) + BigInt(k.x.cumKeeper0) - 1n);
  expectProblem('over-allocation', j, /allocates more than received/);
  const j2 = k.json();
  j2.inputs.received0 = '0';
  j2.inputs.prevCum.h0 = '1';
  expectProblem('negative income', j2, /below what earlier roots allocated/);
});

test('epoch numbering: supersedes is every number since the active epoch; prev comes before', () => {
  const j = p3.json();
  j.supersedes = [];
  expectProblem('supersedes', j, /supersedes is \[\], expected \[2\]/);
  const j2 = p3.json();
  j2.prev.epoch = '3';
  expectProblem('prev', j2, /prev names epoch 3/);
  const j3 = k.json();
  j3.supersedes = ['1'];
  expectProblem('first epoch with supersedes', j3, /supersedes is \[1\], expected \[\]/);
});

test('with the predecessor: continued range, prevCum, no dropped leaf, cum = previous + share', () => {
  const j = p3.json();
  j.window.fromBlock = String(BigInt(j.window.fromBlock) + 1n);
  expectProblem('range', j, /does not continue/, {}, prev1);
  const j2 = p3.json();
  j2.inputs.prevCum.k0 = String(BigInt(j2.inputs.prevCum.k0) + 1n);
  expectProblem('prevCum', j2, /prevCum is not/, {}, prev1);
  const j3 = p3.json();
  const gone = prev1.merkle.leaves[0][1];
  j3.accounts = j3.accounts.filter((a: any) => a.a !== gone);
  expectProblem('dropped', reroot(j3), /had a leaf and was dropped/, {}, prev1);
  const j4 = p3.json();
  j4.accounts[0].cum0 = String(BigInt(j4.accounts[0].cum0) + 1n);
  expectProblem('cum', reroot(j4), /previous one plus this share/, {}, prev1);
  const j5 = p3.json();
  j5.prev.epoch = '0';
  expectProblem('prev epoch', j5, /prev does not name the previous active epoch/, {}, prev1);
});

test('the chain: root, totals, epoch, range and distributor are compared when given', () => {
  const j = k.json();
  const x = k.x;
  const ok = { merkleRoot: x.merkleRoot, cumHolders0: BigInt(x.cumHolders0), cumHolders1: BigInt(x.cumHolders1), cumKeeper0: BigInt(x.cumKeeper0), epoch: 1n, fromBlock: BigInt(x.fromBlock), toBlock: BigInt(x.toBlock), distributor: j.distributor };
  assert.deepEqual(problems(j, ok), []);
  expectProblem('root', j, /on-chain root/, { ...ok, merkleRoot: '0x' + '1'.repeat(64) });
  expectProblem('h0', j, /cumHolders0 .* on-chain/, { ...ok, cumHolders0: 1n });
  expectProblem('h1', j, /cumHolders1 .* on-chain/, { ...ok, cumHolders1: 1n });
  expectProblem('k0', j, /cumKeeper0 .* on-chain/, { ...ok, cumKeeper0: 1n });
  expectProblem('epoch', j, /not 2/, { ...ok, epoch: 2n });
  expectProblem('from', j, /fromBlock .* on-chain/, { ...ok, fromBlock: 1n });
  expectProblem('to', j, /toBlock .* on-chain/, { ...ok, toBlock: 1n });
  expectProblem('distributor', j, /for distributor/, { ...ok, distributor: '0x' + '2'.repeat(40) });
  const j2 = k.json();
  j2.window.fromBlock = String(BigInt(j2.window.toBlock) + 1n);
  expectProblem('window', j2, /fromBlock is after toBlock/);
});

// ---------------------------------------------------------------- chunks

const chainOf = (x: any) => ({
  contentHash: x.contentHash,
  merkleRoot: x.merkleRoot,
  cumHolders0: BigInt(x.cumHolders0),
  cumHolders1: BigInt(x.cumHolders1),
  cumKeeper0: BigInt(x.cumKeeper0),
  epoch: BigInt(x.epoch),
  fromBlock: BigInt(x.fromBlock),
  toBlock: BigInt(x.toBlock),
});

/** v14 epoch 2 with chunk k's value changed by `edit`; `fix` says which of
 *  the index's figures follow the change: its sha256 and size, its sums,
 *  its root, and the root over the chunk roots. */
function chunkTamper(k: number, edit: (c: any) => void, fix: { hash?: boolean; sums?: boolean; root?: boolean; top?: boolean }) {
  const index = c2.json();
  const chunks = c2.chunks.map(dec);
  edit(chunks[k]);
  const bytes = chunks.map((c: any) => enc(c));
  const d = index.chunks[k];
  if (fix.hash) {
    d.sha256 = sha256Hex(bytes[k]);
    d.size = String(bytes[k].length);
  }
  if (fix.sums) {
    d.sum0 = String(chunks[k].accounts.reduce((s: bigint, r: any) => s + BigInt(r.cum0), 0n));
    d.sum1 = String(chunks[k].accounts.reduce((s: bigint, r: any) => s + BigInt(r.cum1), 0n));
  }
  if (fix.root) d.root = buildTree(chunks[k].accounts.map((r: any): Leaf => [index.distributor, r.a, r.cum0, r.cum1])).tree.root;
  if (fix.top) index.merkle.root = buildTree(chunks.flatMap((c: any) => c.accounts).map((r: any): Leaf => [index.distributor, r.a, r.cum0, r.cum1])).tree.root;
  return { index: enc(index), chunks: bytes };
}

const chunkProblems = (t: { index: Uint8Array; chunks: Uint8Array[] }, prev: EpochFile | null = cPrev) => verifyEpochFile(t.index, {}, prev, { chunks: t.chunks }).problems;

function expectChunkProblem(name: string, t: { index: Uint8Array; chunks: Uint8Array[] }, re: RegExp) {
  const ps = chunkProblems(t);
  assert.ok(ps.some((p) => re.test(p)), `${name}: expected ${re}, got ${JSON.stringify(ps.slice(0, 6))}`);
}

test('a chunked file checks with every chunk, lists each one missing, and a partial check takes the chunks given', () => {
  assert.equal(c2.chunks.length, 3);
  const all = verifyEpochFile(c2.bytes, chainOf(c2.x), cPrev, { chunks: c2.chunks });
  assert.deepEqual(all.problems, []);
  assert.deepEqual(all.checked, [0, 1, 2]);
  assert.equal(all.file!.accounts.length, 1100);
  assert.equal(all.file!.parts, undefined);
  // by sha256 too, and in any order
  assert.deepEqual(verifyEpochFile(c2.bytes, chainOf(c2.x), cPrev, { chunks: new Map(c2.chunks.map((b) => [sha256Hex(b), b])) }).problems, []);
  assert.deepEqual(verifyEpochFile(c2.bytes, chainOf(c2.x), cPrev, { chunks: [...c2.chunks].reverse() }).problems, []);
  const none = verifyEpochFile(c2.bytes, chainOf(c2.x), cPrev).problems;
  assert.equal(none.filter((p) => /chunk \d .* was not given/.test(p)).length, 3, JSON.stringify(none));
  // The site's check of one chunk: no problem, that chunk's rows checked, the
  // totals from the index's sums.
  for (const kk of [0, 1, 2]) {
    const part = verifyEpochFile(c2.bytes, chainOf(c2.x), cPrev, { chunks: [c2.chunks[kk]], partial: true });
    assert.deepEqual(part.problems, [], `chunk ${kk}`);
    assert.deepEqual(part.checked, [kk]);
    assert.deepEqual(part.file!.parts, [kk]);
    assert.equal(part.totals!.cumHolders0, BigInt(c2.x.cumHolders0));
  }
  // A partial check still finds what is wrong in the chunk it has.
  const bad = chunkTamper(1, (c) => (c.accounts[3].s0 = String(BigInt(c.accounts[3].s0) + 1n)), { hash: true });
  const pb = verifyEpochFile(bad.index, {}, cPrev, { chunks: [bad.chunks[1]], partial: true }).problems;
  assert.ok(pb.some((p) => /s0 \d+ is not/.test(p)), JSON.stringify(pb));
});

test('a chunk is the one its index hashes, of its distributor and epoch, and holds the rows its index describes', () => {
  // one byte of a chunk, its index unchanged
  const raw = c2.chunks.map((b) => b.slice());
  raw[0][raw[0].length - 3] ^= 1;
  assert.ok(chunkProblems({ index: c2.bytes, chunks: raw }).some((p) => /chunk 0 .* was not given/.test(p)), 'a chunk that hashes to nothing the index names is no chunk of it');
  expectChunkProblem('a share', chunkTamper(1, (c) => (c.accounts[3].s0 = String(BigInt(c.accounts[3].s0) + 1n)), { hash: true }), /s0 \d+ is not/);
  expectChunkProblem('a sum', chunkTamper(0, (c) => (c.accounts[0].cum0 = String(BigInt(c.accounts[0].cum0) + 1n)), { hash: true }), /chunk 0's rows sum to/);
  expectChunkProblem('a chunk root', chunkTamper(0, (c) => (c.accounts[0].cum0 = String(BigInt(c.accounts[0].cum0) + 1n)), { hash: true, sums: true }), /chunk 0's rows rebuild to the root/);
  expectChunkProblem('the root over the chunks', chunkTamper(0, (c) => (c.accounts[0].cum0 = String(BigInt(c.accounts[0].cum0) + 1n)), { hash: true, sums: true, root: true }), /root over the chunks' roots/);
  expectChunkProblem('all of it, the totals still', chunkTamper(0, (c) => (c.accounts[0].cum0 = String(BigInt(c.accounts[0].cum0) + 1n)), { hash: true, sums: true, root: true, top: true }), /previous one plus this share|leaves sum to/);
  expectChunkProblem('another epoch', chunkTamper(2, (c) => (c.epoch = '3'), { hash: true }), /chunk 2 is of epoch 3, not 2/);
  expectChunkProblem('another distributor', chunkTamper(2, (c) => (c.distributor = '0x' + 'd'.repeat(40)), { hash: true }), /chunk 2 is for distributor/);
  expectChunkProblem('another schema', chunkTamper(2, (c) => (c.schema = 'curb.sharing.chunk/2'), { hash: true }), /chunk 2: schema/);
  expectChunkProblem('a row missing', chunkTamper(2, (c) => c.accounts.pop(), { hash: true }), /chunk 2 holds 75 rows, its index counts 76/);
  expectChunkProblem('rows out of order', chunkTamper(1, (c) => c.accounts.splice(5, 2, c.accounts[6], c.accounts[5]), { hash: true }), /chunk 1: rows are not sorted/);
});

test('the layout: the rows in the index up to one chunk, chunks of exactly 512 past it, in address order', () => {
  const layout = (edit: (j: any) => void) => {
    const j = c2.json();
    edit(j);
    return verifyEpochFile(enc(j), {}, cPrev, { chunks: c2.chunks }).problems;
  };
  assert.ok(layout((j) => (j.chunks[0].count = '511')).some((p) => /chunk 0 counts 511 rows, not 512/.test(p)));
  assert.ok(layout((j) => j.chunks.reverse()).some((p) => /does not start after chunk/.test(p)));
  assert.ok(layout((j) => (j.chunks = j.chunks.slice(0, 1))).some((p) => /a file of one chunk keeps its rows in its index/.test(p)));
  assert.ok(layout((j) => (j.accounts = [c1.json().accounts[0]])).some((p) => /lists rows and chunks both/.test(p)));
  // 1,100 rows written in the index: more than one chunk's worth.
  const whole = c2.json();
  whole.accounts = c2.chunks.flatMap((b) => dec(b).accounts);
  whole.chunks = [];
  assert.ok(verifyEpochFile(enc(whole), {}, cPrev).problems.some((p) => /the index lists 1100 rows, more than one chunk's 512/.test(p)));
});

test('reading a chunked file: never without its chunks, each one checked by the hash its index gives', async () => {
  assert.throws(() => parseEpochFile(c2.bytes), (e: unknown) => e instanceof ChunksNeeded && e.missing.length === 3);
  assert.throws(() => parseEpochFile(c2.bytes, c2.chunks.slice(0, 2)), (e: unknown) => e instanceof ChunksNeeded && e.missing.length === 1);
  const whole = parseEpochFile(c2.bytes, c2.chunks);
  assert.equal(whole.accounts.length, 1100);
  assert.equal(whole.merkle.leaves.length, 1100);
  assert.equal(treeOf(whole).root, c2.x.merkleRoot);
  const asked: number[] = [];
  const read = await readEpochFile(c2.bytes, async (c, kk) => {
    asked.push(kk);
    assert.equal(c.sha256, parseEpochIndex(c2.bytes).chunks[kk].sha256);
    return c2.chunks[kk];
  });
  assert.deepEqual(asked, [0, 1, 2]);
  assert.equal(canonicalJson(read.file), canonicalJson(whole));
  await assert.rejects(readEpochFile(c2.bytes, async (_c, kk) => c2.chunks[(kk + 1) % 3]), /chunk 0: sha256 .* is not the .* its index gives/);
  // a file whose rows are in its index needs nothing more
  assert.equal(parseEpochFile(c1.bytes).accounts.length, 10);
  assert.deepEqual((await readEpochFile(c1.bytes, async () => assert.fail('no chunk to fetch'))).file.accounts.length, 10);
});

test("the site's part: the index and one chunk prove that chunk's accounts against the root", () => {
  const index = parseEpochIndex(c2.bytes);
  const holder = (n: number) => '0xc0' + n.toString(16).padStart(38, '0');
  assert.equal(chunkIndexOf(index, holder(1)), 0);
  assert.equal(chunkIndexOf(index, holder(513).toUpperCase().replace('0X', '0x')), 1);
  assert.equal(chunkIndexOf(index, holder(1100)), 2);
  assert.equal(chunkIndexOf(index, holder(1101)), -1);
  assert.equal(chunkIndexOf(index, '0x' + '0'.repeat(40)), -1);
  for (const [n, kk] of [[490, 0], [700, 1], [1040, 2]] as const) {
    const part = epochPart(c2.bytes, kk, c2.chunks[kk]);
    assert.deepEqual(part.parts, [kk]);
    const t = treeOf(part);
    assert.equal(t.root, c2.x.merkleRoot);
    const p = proofOf(t, holder(n))!;
    assert.ok(verifyProof(c2.x.merkleRoot, leafHash(index.distributor, holder(n), p.cum0, p.cum1), p.proof), `holder ${n}`);
    // another chunk's account: the chunk was not given
    assert.throws(() => proofOf(t, holder(n === 490 ? 700 : 490)), /was not given/);
  }
  // the wrong chunk for a position is refused
  assert.throws(() => epochPart(c2.bytes, 0, c2.chunks[1]), /sha256 .* is not the/);
  // and a tree built on the index takes no leaves that are not its chunk's
  const leaves = epochPart(c2.bytes, 1, c2.chunks[1]).merkle.leaves.map((l) => [...l] as Leaf);
  leaves[7][2] = String(BigInt(leaves[7][2]) + 1n);
  assert.throws(() => buildTree(leaves, index.chunks), /rebuilds to .*, the index says/);
  assert.throws(() => buildTree(leaves.slice(1), index.chunks), /has 511 leaves here, the index counts 512/);
  // and a part never resumes an epoch
  assert.throws(() => stateFromEpochFile(epochPart(c2.bytes, 0, c2.chunks[0]), c2.x.contentHash, 'ipfs://x'), /needs its whole file/);
});
