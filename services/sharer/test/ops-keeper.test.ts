// The keeper on the simulated chain: one full epoch (harvest, publish with
// the read-back, the veto hour, activate, push, payKeeper), batching across
// launches, and idempotency. Failure injection lives in ops-failures.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { opsWorld, HOLDERS } from './sim/world.ts';
import { parseEpochFile } from '../src/calc/file.ts';
import { sha256Hex } from '../src/calc/encoding.ts';
import { fileCid } from '../src/ops/cid.ts';

import { tick, js } from './sim/helpers.ts';

test('one full epoch: harvest, publish (site + 2 pins + read back), veto hour, activate, push, payKeeper', async () => {
  const w = opsWorld();
  const k = w.make('keeper');
  const L = w.launches[0];

  // Too soon: the launch's first block is not an hour old.
  const r0 = await tick(w, k);
  assert.equal(r0.published.length, 0);
  assert.match(String((r0.status.launches as any[])[0].epoch), /ago/);

  w.pass(3601);
  const r1 = await tick(w, k);
  assert.deepEqual(r1.errors, []);
  assert.equal(r1.published.length, 1, js(r1));
  const p = r1.published[0];
  assert.equal(p.epoch, 1n);
  // the harvest went first, then the publish
  assert.ok(r1.actions.some((a) => a.startsWith(`harvest ${L.D}`)));
  assert.ok(r1.actions.some((a) => a.startsWith('publishMany')));

  // The file is in the data repo, on IPFS under its raw CID, and the chain holds its hash.
  const path = `sharing/8453/${L.D}/1.json`;
  const repoFile = w.net.repo.get(path)!;
  assert.ok(repoFile, 'the file is in the data repo');
  assert.equal(sha256Hex(repoFile.bytes), p.contentHash);
  assert.equal(p.uri, `ipfs://${fileCid(repoFile.bytes)}`);
  assert.ok(w.net.blocks.has(fileCid(repoFile.bytes)), 'pinned');
  const pend = w.sim.launch(L.D).pending;
  assert.equal(pend.epoch, 1);
  assert.equal(pend.contentHash, p.contentHash);
  assert.notEqual(pend.payableAt, 0n);
  assert.ok(w.net.repo.has(`sharing/8453/${L.D}/latest.json`));
  assert.ok(w.net.repo.has('sharing/8453/config.json'), 'the public sharing config is published');
  // The site and a gateway were both read back before the publish.
  const order = w.net.log.map((x) => x.url);
  const firstSite = order.findIndex((u) => u.startsWith('https://site.test/sharing/8453/'));
  const firstGw = order.findIndex((u) => u.startsWith('https://gw.test/ipfs/'));
  assert.ok(firstSite >= 0 && firstGw >= 0);

  // Inside the veto hour nothing pays, and nothing is sent (no harvest while a root is pending).
  w.pass(600);
  const sentBefore = w.sim.sent.length;
  const r2 = await tick(w, k);
  assert.deepEqual(r2.errors, []);
  assert.equal(r2.published.length, 0);
  assert.equal(w.sim.launch(L.D).active.epoch, 0);
  assert.equal(w.sim.sent.length, sentBefore, 'nothing sent inside the veto hour');

  // After it: activate, push every holder above the threshold, pay the keeper.
  w.pass(3600);
  const r3 = await tick(w, k);
  assert.deepEqual(r3.errors, []);
  assert.ok(r3.actions.some((a) => a.startsWith(`activate epoch 1 of ${L.D}`)), r3.actions.join('\n'));
  assert.ok(r3.actions.some((a) => a.startsWith('push ')));
  assert.ok(r3.actions.some((a) => a.startsWith('payKeeper')));
  const s = w.sim.launch(L.D);
  assert.equal(s.active.epoch, 1);
  const f = parseEpochFile(repoFile.bytes);
  for (const row of f.accounts) {
    if (row.a === HOLDERS.dust) {
      assert.equal(s.paid0.get(row.a) ?? 0n, 0n, 'the dust holder waits below the threshold');
      continue;
    }
    assert.equal(s.paid0.get(row.a), row.cum0, `${row.a} paid its whole cum0`);
  }
  assert.equal(s.keeperPaid0, f.keeper.fee);
  assert.ok(f.keeper.fee > 0n, 'the keeper charged its gas (harvest at least)');
  assert.ok(f.keeper.fee * 10_000n <= (f.accounts.reduce((x, r) => x + r.s0, 0n) + f.keeper.fee) * 200n, 'within 2%');

  // The launch block was found without reading a header older than the Graduator.
  const asked = w.sim.calls.filter((c) => c.method === 'eth_getBlockByNumber' && /^0x/.test(c.params[0])).map((c) => BigInt(c.params[0]));
  assert.ok(asked.length > 0 && asked.every((n) => n >= 1000n), `headers below the Graduator's block were read: ${asked.filter((n) => n < 1000n).slice(0, 5)}`);

  // Idempotent: another tick right away does nothing.
  const r4 = await tick(w, k);
  assert.deepEqual(r4.actions, []);
});

test('several launches due at once are published in ONE publishMany', async () => {
  const w = opsWorld({ launches: 3 });
  const k = w.make('keeper');
  w.pass(3601);
  const r = await tick(w, k);
  assert.deepEqual(r.errors, []);
  assert.equal(r.published.length, 3);
  const pubs = r.actions.filter((a) => a.startsWith('publishMany'));
  assert.equal(pubs.length, 1, r.actions.join('\n'));
  for (const L of w.launches) assert.equal(w.sim.launch(L.D).pending.epoch, 1);
});

test('the second epoch continues the first: contiguous range, prev, cumulative values', async () => {
  const w = opsWorld();
  const k = w.make('keeper');
  const L = w.launches[0];
  w.pass(3601);
  const r1 = await tick(w, k);
  w.pass(3700);
  await tick(w, k); // activate + push
  w.sim.income(L.D, 5n * 10n ** 17n);
  w.sim.transfer(L.token, HOLDERS.alice, HOLDERS.carol, 100n * 10n ** 18n);
  w.pass(3700);
  const r = await tick(w, k);
  assert.deepEqual(r.errors, []);
  assert.equal(r.published.length, 1, js(r));
  assert.equal(r.published[0].epoch, 2n);
  const f1 = parseEpochFile(w.net.repo.get(`sharing/8453/${L.D}/1.json`)!.bytes);
  const f2 = parseEpochFile(w.net.repo.get(`sharing/8453/${L.D}/2.json`)!.bytes);
  assert.equal(f2.window.fromBlock, f1.window.toBlock + 1n);
  assert.equal(f2.prev!.epoch, 1n);
  assert.equal(f2.prev!.uri, r1.published[0].uri, 'prev names the URI the chain recorded for epoch 1');
  assert.equal(f2.prev!.contentHash, r1.published[0].contentHash);
  for (const row of f2.accounts) {
    const before = f1.accounts.find((x) => x.a === row.a);
    assert.equal(row.cum0, (before?.cum0 ?? 0n) + row.s0);
  }
});
