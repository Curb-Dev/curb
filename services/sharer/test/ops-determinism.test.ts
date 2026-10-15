// Determinism of the ops path: two cold keepers on the same chain produce the
// same bytes and the same root; a keeper restarted from nothing (rebuild)
// reaches exactly the state of one that ran all along, and computes the next
// epoch's file byte for byte the same.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { opsWorld, HOLDERS } from './sim/world.ts';
import { tick, js, crashing } from './sim/helpers.ts';
import { rebuild } from '../src/ops/rebuild.ts';
import { sha256Hex } from '../src/calc/encoding.ts';

function epochOnce(seedIncome: bigint) {
  const w = opsWorld({ income0: seedIncome });
  return (async () => {
    const k = w.make('keeper');
    w.pass(3601);
    const r = await tick(w, k);
    const b = w.net.repo.get(`sharing/8453/${w.launches[0].D}/1.json`)!.bytes;
    return { r, b, root: w.sim.launch(w.launches[0].D).pending.merkleRoot };
  })();
}

test('two cold runs on the same chain: identical file bytes, sha256 and on-chain root', async () => {
  const a = await epochOnce(10n ** 18n);
  const b = await epochOnce(10n ** 18n);
  assert.equal(a.r.published.length, 1);
  assert.equal(sha256Hex(a.b), sha256Hex(b.b));
  assert.deepEqual(a.b, b.b);
  assert.equal(a.root, b.root);
  // and the input matters: other income, other bytes
  const c = await epochOnce(10n ** 18n + 1n);
  assert.notEqual(sha256Hex(c.b), sha256Hex(a.b));
});

test('a cold keeper after rebuild equals the warm one: same memory, same next file', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  const dir = mkdtempSync(join(tmpdir(), 'curb-sharer-warm-'));
  try {
    const warm = w.make('keeper', { dataDir: dir, holder: 'warm' });
    w.pass(3601);
    await tick(w, warm);
    w.pass(3700);
    await tick(w, warm); // epoch 1 active and pushed
    w.sim.income(L.D, 3n * 10n ** 17n);
    w.sim.transfer(L.token, HOLDERS.bob, HOLDERS.carol, 300n * 10n ** 18n); // bob sells out
    w.pass(3700);
    await tick(w, warm); // epoch 2 published
    w.pass(3700);
    await tick(w, warm); // epoch 2 active, pushed

    // a cold keeper with an empty volume, rebuilt
    const cold = w.make('keeper', { holder: 'cold' });
    const rb = await rebuild(cold.ctx);
    assert.equal(rb.distributors, 1);
    assert.ok(rb.files.every((f) => f.ok), js(rb.files));
    for (const key of ['uris', 'lastHeld']) assert.deepEqual(js(cold.ctx.store.get(key)), js(warm.ctx.store.get(key)), key);
    assert.deepEqual(cold.ctx.store.get<any>('discovery').ds, warm.ctx.store.get<any>('discovery').ds);
    assert.ok(Object.keys(warm.ctx.store.get<any>('lastHeld')[L.D].at).includes(HOLDERS.bob), 'the memory is not empty');

    // the next epoch, computed by each from the same harvest: the same bytes
    w.sim.income(L.D, 2n * 10n ** 17n);
    w.pass(3700);
    const noPublish = (k: typeof warm) => w.make('keeper', { holder: k.holder, dataDir: k.ctx.store.dir, signers: { publisher: crashing(w.signers.publisher, (tx) => tx.to === w.sim.addr.factory), pusher: w.signers.pusher } });
    const warm2 = noPublish(warm);
    await tick(w, warm2);
    const p = `sharing/8453/${L.D}/3.json`;
    const fromWarm = w.net.repo.get(p)!;
    assert.ok(fromWarm, 'the warm keeper wrote epoch 3 (and crashed before publishing it)');
    const commits = w.net.commits.filter((c) => c.path === p).length;
    const cold2 = w.make('keeper', { holder: 'cold', signers: { publisher: crashing(w.signers.publisher, (tx) => tx.to === w.sim.addr.factory), pusher: w.signers.pusher } });
    await rebuild(cold2.ctx);
    await tick(w, cold2);
    assert.equal(w.net.commits.filter((c) => c.path === p).length, commits, 'the cold keeper found exactly the same bytes there (no new commit)');
    assert.equal(sha256Hex(w.net.repo.get(p)!.bytes), sha256Hex(fromWarm.bytes));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
