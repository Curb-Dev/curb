// Determinism and a second opinion:
//  - two cold runs give identical bytes and sha256, for every golden vector
//    and for seeded random launches, through the calculator and through the
//    whole pipeline on a mock chain;
//  - the order in which inputs arrive changes nothing;
//  - a restart from the files gives the same bytes as the incremental state;
//  - on random launches this implementation agrees byte for byte with the
//    spec's reference.mjs (an independent implementation of the same rules).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bytesEqual, canonicalJson, parseEpochFile, runVector, sha256Hex, stateFromEpochFile, type ActiveState, type AttemptResult } from '../src/calc/index.ts';
import { ChainReader } from '../src/chain/reader.ts';
import { prepareEpoch } from '../src/epoch.ts';
import { loadVector, ROOT, vectorNames } from './helpers.ts';
import { randomVector } from './random-vector.ts';
import { vectorWorld } from './world.ts';

const reference = await import(pathToFileURL(join(ROOT, 'spec', 'reference.mjs')).href);
const SEEDS = Array.from({ length: 12 }, (_, i) => i + 1);

const bytesOf = (rs: AttemptResult[]) => rs.map((r) => (r.result === 'epoch' ? [r.fileBytes, ...r.chunks.map((c) => c.bytes)].map((b) => sha256Hex(b) + ':' + b.length).join('+') : 'none:' + r.reason));

async function pipeline(vector: any, opts: { mode: 'incremental' | 'stateless'; shuffle?: number }) {
  const w = vectorWorld(vector);
  if (opts.shuffle) {
    // The node returns the same logs; the order they are stored in is noise.
    let s = opts.shuffle;
    const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
    w.chain.logs.sort(() => rnd() - 0.5);
  }
  const readers = [new ChainReader(w.chain.rpc('a')), new ChainReader(w.chain.rpc('b'))];
  let prev: ActiveState | null = null;
  const out: AttemptResult[] = [];
  for (let i = 0; i < w.attempts.length; i++) {
    const a = w.attempts[i];
    const { result } = await prepareEpoch(readers, w.config, { distributor: w.D, harvestTx: a.harvestTx, uri: a.uri, prev, opening: w.opening, distributors: [w.D] }, { stateCache: null });
    out.push(result);
    w.applyResult(i, result);
    if (result.result === 'epoch' && !a.vetoed) prev = opts.mode === 'incremental' ? result.next : stateFromEpochFile(parseEpochFile(result.fileBytes, result.chunks.map((c) => c.bytes)), result.contentHash, a.uri);
  }
  return out;
}

test('golden vectors: two cold runs of the calculator are identical', () => {
  for (const name of vectorNames()) assert.deepEqual(bytesOf(runVector(loadVector(name))), bytesOf(runVector(loadVector(name))), name);
});

test('the order of the input lists changes nothing', () => {
  for (const name of vectorNames()) {
    const v = loadVector(name);
    const w = loadVector(name);
    w.setup.transfers?.reverse();
    w.setup.keeperTxs?.reverse();
    w.setup.rules.keeperKeys?.reverse();
    w.setup.rules.ammFactories?.reverse();
    w.setup.timestamps = Object.fromEntries(Object.entries(w.setup.timestamps).reverse());
    w.setup.contracts = Object.fromEntries(Object.entries(w.setup.contracts ?? {}).reverse());
    w.setup.opening.balances = Object.fromEntries(Object.entries(w.setup.opening.balances ?? {}).reverse());
    assert.deepEqual(bytesOf(runVector(w)), bytesOf(runVector(v)), name);
  }
});

for (const seed of SEEDS) {
  test(`random launch ${seed}: agrees with reference.mjs byte for byte, and the pipeline agrees with both`, async () => {
    const v = randomVector(seed);
    const mine = runVector(v);
    const ref = reference.runVector(randomVector(seed));
    assert.equal(mine.length, ref.length);
    let epochs = 0;
    mine.forEach((r, i) => {
      assert.equal(canonicalJson(r.expected), canonicalJson(ref[i].expected), `seed ${seed} attempt ${i + 1}`);
      if (r.result === 'epoch') {
        epochs++;
        assert.ok(bytesEqual(r.fileBytes, new Uint8Array(ref[i].fileBytes)), `seed ${seed} attempt ${i + 1} bytes`);
      }
    });
    assert.ok(epochs >= 1, `seed ${seed} produced no epoch`);
    const viaChain = await pipeline(randomVector(seed), { mode: 'incremental' });
    assert.deepEqual(bytesOf(viaChain), bytesOf(mine));
  });
}

for (const [seed, crowd] of [
  [101, 700],
  [102, 1300],
] as const) {
  test(`a random launch of ${crowd} more holders: its chunked files agree with reference.mjs byte for byte, chunk by chunk`, () => {
    const mine = runVector(randomVector(seed, crowd));
    const ref = reference.runVector(randomVector(seed, crowd));
    let chunked = 0;
    mine.forEach((r, i) => {
      assert.equal(canonicalJson(r.expected), canonicalJson(ref[i].expected), `seed ${seed} attempt ${i + 1}`);
      if (r.result !== 'epoch') return;
      assert.ok(bytesEqual(r.fileBytes, new Uint8Array(ref[i].fileBytes)), `seed ${seed} attempt ${i + 1} index`);
      assert.equal(r.chunks.length, ref[i].chunkFiles.length);
      r.chunks.forEach((c, k) => assert.ok(bytesEqual(c.bytes, new Uint8Array(ref[i].chunkFiles[k])), `seed ${seed} attempt ${i + 1} chunk ${k}`));
      if (r.chunks.length) chunked++;
      assert.equal(r.chunks.length, r.file.accounts.length > 512 ? Math.ceil(r.file.accounts.length / 512) : 0);
    });
    assert.ok(chunked >= 1, `seed ${seed}: no chunked epoch`);
  });
}

test('a chunked random launch: the pipeline, and a restart from its files (index and chunks), give the same bytes', async () => {
  const a = await pipeline(randomVector(102, 1300), { mode: 'incremental' });
  const b = await pipeline(randomVector(102, 1300), { mode: 'stateless', shuffle: 5 });
  assert.deepEqual(bytesOf(b), bytesOf(a));
  assert.ok(a.some((r) => r.result === 'epoch' && r.chunks.length >= 3), 'three chunks at least');
  assert.deepEqual(bytesOf(a), bytesOf(runVector(randomVector(102, 1300))));
});

test('random launches: two cold pipeline runs, shuffled storage and a restart from files are all identical', async () => {
  let compared = 0;
  for (const seed of SEEDS.slice(0, 6)) {
    const a = bytesOf(await pipeline(randomVector(seed), { mode: 'incremental' }));
    const b = bytesOf(await pipeline(randomVector(seed), { mode: 'incremental' }));
    const c = bytesOf(await pipeline(randomVector(seed), { mode: 'stateless', shuffle: seed * 7 + 1 }));
    assert.deepEqual(b, a, `seed ${seed} second cold run`);
    assert.deepEqual(c, a, `seed ${seed} stateless, shuffled`);
    compared += a.filter((x) => !x.startsWith('none')).length;
  }
  assert.ok(compared >= 10, `only ${compared} epochs compared`);
});

test('random launches exercise what they claim to', () => {
  let recapped = 0;
  let capped = 0;
  let pools = 0;
  let superseded = 0;
  let chainlink = 0;
  let none = 0;
  for (const seed of SEEDS) {
    for (const r of runVector(randomVector(seed))) {
      if (r.result !== 'epoch') {
        none++;
        continue;
      }
      if (r.expected.recapped) recapped++;
      if (r.file.keeper.capped) capped++;
      if (r.file.rules.exclusions.some((x) => x.reason.startsWith('detected pool'))) pools++;
      if (r.file.supersedes.length) superseded++;
      if (r.file.keeper.price.source === 'chainlink') chainlink++;
    }
  }
  assert.ok(pools > 0 && superseded > 0 && chainlink > 0 && capped > 0, JSON.stringify({ recapped, capped, pools, superseded, chainlink, none }));
});
