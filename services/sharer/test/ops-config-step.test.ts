// The whole sharing block moves in step (gap item 14): a feed, the graduator
// or WETH change the epoch bytes as an exclusion does. The keeper publishes
// nothing while its block differs from the published config of the same
// rules version; `check` compares this host's block with the published one
// and names each difference; a verifier's mismatch says which part of its
// own copy differs from the configuration the file was computed with.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { opsWorld } from './sim/world.ts';
import { tick, js, alertKeys } from './sim/helpers.ts';
import { parseOpsConfig, publicSharingConfig, diffSharingConfig } from '../src/ops/config.ts';
import { checkSetup } from '../src/ops/runner.ts';
import { watchTick } from '../src/ops/verify.ts';

type W = ReturnType<typeof opsWorld>;
const raised = (k: { ctx: { alerts: { raised: { key: string }[] } } }, key: string) => k.ctx.alerts.raised.filter((a) => a.key === key) as any[];

/** The world's config with `edit` applied, parsed. */
function edited(w: W, edit: (raw: any) => void) {
  const raw = structuredClone(w.raw);
  edit(raw);
  return parseOpsConfig(raw);
}

test('diffSharingConfig names every difference of the sharing block, and none for the same set in another order', () => {
  const w = opsWorld();
  const base = w.cfg;
  const pub = publicSharingConfig(base);
  assert.deepEqual(diffSharingConfig(pub, base), []);
  const usdc = w.sim.addr.usdc;
  const changed = edited(w, (c) => {
    c.sharing.feeds[usdc].quoteUsd = w.sim.addr.ethUsd;
    c.sharing.rules.exclusions = [{ address: '0x00000000000000000000000000000000000e0001', reason: 'a new launcher' }];
    c.sharing.rules.keeperKeys = [c.sharing.rules.keeperKeys[0]];
    c.sharing.weth = '0x00000000000000000000000000000000000e0002';
  });
  const d = diffSharingConfig(pub, changed);
  assert.ok(d.some((x) => x === `sharing.feeds[${usdc}].quoteUsd: published ${w.sim.addr.usdcUsd}, here ${w.sim.addr.ethUsd}`), js(d));
  assert.ok(d.some((x) => /sharing\.rules\.exclusions: here has 0x0+e0001 \(a new launcher\), published does not/.test(x)), js(d));
  assert.ok(d.some((x) => /sharing\.rules\.keeperKeys: published has 0x[0-9a-f]{40}, here does not/.test(x)), js(d));
  assert.ok(d.some((x) => /^sharing\.weth: published 0x4200/.test(x)), js(d));
  assert.equal(d.length, 4, js(d));
  // a reason is part of an exclusion; an order is not
  const two = [{ address: '0x00000000000000000000000000000000000e0001', reason: 'a' }, { address: '0x00000000000000000000000000000000000e0003', reason: 'b' }];
  const x1 = edited(w, (c) => (c.sharing.rules.exclusions = two));
  const x2 = edited(w, (c) => (c.sharing.rules.exclusions = [two[1], two[0]]));
  const x3 = edited(w, (c) => (c.sharing.rules.exclusions = [two[0], { ...two[1], reason: 'c' }]));
  assert.deepEqual(diffSharingConfig(publicSharingConfig(x1), x2), []);
  assert.deepEqual(diffSharingConfig(publicSharingConfig(x1), x3), ['sharing.rules.exclusions: 0x00000000000000000000000000000000000e0003 is "b" published, "c" here']);
  assert.match(diffSharingConfig({ nope: 1 }, base)[0], /not a sharing config/);
});

test('the keeper publishes NOTHING while its sharing block differs from the published config of the same rules version', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  const k = w.make('keeper');
  w.pass(3601);
  const r1 = await tick(w, k);
  assert.equal(r1.published.length, 1, js(r1));
  assert.ok(w.net.repo.has('sharing/8453/config-v1.json'));
  w.pass(3700);
  await tick(w, k); // activate, push
  w.sim.income(L.D, 10n ** 17n);
  w.pass(3700);

  // the same rules version, another feed: a keeper started with it
  const usdc = w.sim.addr.usdc;
  const drifted = edited(w, (c) => (c.sharing.feeds[usdc].quoteUsd = w.sim.addr.ethUsd));
  const k2 = w.make('keeper', { cfg: drifted });
  const before = w.net.text('sharing/8453/config-v1.json');
  const r2 = await tick(w, k2);
  assert.equal(r2.published.length, 0, js(r2));
  assert.ok(!r2.actions.some((a) => a.startsWith('publishMany')), js(r2.actions));
  assert.equal(r2.ok, false);
  assert.match(r2.errors.join(' '), /config-v1\.json already holds another configuration under rules version 1: nothing published/);
  assert.equal(w.net.text('sharing/8453/config-v1.json'), before, 'the published version file is never rewritten');
  const p = raised(k2, 'config-clash:v1');
  assert.equal(p.length, 1, js(alertKeys(k2)));
  assert.equal(p[0].severity, 'page');
  assert.match(p[0].text, new RegExp(`sharing\\.feeds\\[${usdc}\\]\\.quoteUsd: published ${w.sim.addr.usdcUsd}, here ${w.sim.addr.ethUsd}`));
  assert.ok(!w.net.repo.has(`sharing/8453/${L.D}/2.json`), 'not even the file');

  // raised to version 2 (RUNBOOK 7.1): published, and the new version recorded
  const bumped = edited(w, (c) => {
    c.sharing.feeds[usdc].quoteUsd = w.sim.addr.ethUsd;
    c.sharing.rules.version = '2';
  });
  const k3 = w.make('keeper', { cfg: bumped });
  const r3 = await tick(w, k3);
  assert.equal(r3.published.length, 1, js(r3));
  assert.ok(w.net.repo.has('sharing/8453/config-v2.json'));
  assert.equal(JSON.parse(w.net.text('sharing/8453/config.json')!).sharing.rules.version, '2', 'the current one follows');
  assert.equal(w.net.text('sharing/8453/config-v1.json'), before, 'version 1 stays what it was');
});

test('check: NOT OK when the published config of this rules version differs; reported when none is published yet', async () => {
  const w = opsWorld();
  const src = { env: {}, dir: '/nonexistent-secrets' };
  const c0 = await checkSetup(w.make('check').ctx, src);
  assert.ok(c0.lines.some((l) => /published sharing\/8453\/config-v1\.json: none yet/.test(l)), js(c0.lines));

  const k = w.make('keeper');
  w.pass(3601);
  await tick(w, k); // publishes config-v1.json and config.json
  const c1 = await checkSetup(w.make('check').ctx, src);
  assert.ok(c1.lines.includes('published sharing/8453/config-v1.json: the same as this host\'s'), js(c1.lines));
  assert.ok(!c1.problems.some((p) => /sharing block differs/.test(p)), js(c1.problems));

  const usdc = w.sim.addr.usdc;
  const drifted = edited(w, (c) => (c.sharing.feeds[usdc].ethUsd = w.sim.addr.usdcUsd));
  const c2 = await checkSetup(w.make('check', { cfg: drifted }).ctx, src);
  const p = c2.problems.find((x) => /sharing block differs from the published sharing\/8453\/config-v1\.json/.test(x));
  assert.ok(p, js(c2.problems));
  assert.match(p!, new RegExp(`sharing\\.feeds\\[${usdc}\\]\\.ethUsd`));

  // a new rules version not published yet: only a line, and the current config.json differs (expected)
  const next = edited(w, (c) => {
    c.sharing.feeds[usdc].ethUsd = w.sim.addr.usdcUsd;
    c.sharing.rules.version = '2';
  });
  const c3 = await checkSetup(w.make('check', { cfg: next }).ctx, src);
  assert.ok(!c3.problems.some((x) => /sharing block differs/.test(x)), js(c3.problems));
  assert.ok(c3.lines.some((l) => /config-v2\.json: none yet/.test(l)), js(c3.lines));
  assert.ok(c3.lines.some((l) => /the published sharing\/8453\/config\.json differs from this host's: .*rules\.version: published 1, here 2/.test(l)), js(c3.lines));
});

test("a verifier's mismatch names the part of its own sharing block that differs from the file's configuration", async () => {
  const w = opsWorld({ quote: 'usdc' });
  const k = w.make('keeper');
  w.pass(3601);
  const r = await tick(w, k);
  assert.equal(r.published.length, 1, js(r));
  // a verifier whose copy prices USDC with another feed: an honest root looks wrong to it
  const usdc = w.sim.addr.usdc;
  const drifted = edited(w, (c) => (c.sharing.feeds[usdc].quoteUsd = w.sim.addr.ethUsd));
  const v = w.make('verify', { cfg: drifted });
  const rep = await watchTick(v.ctx, null);
  assert.equal(rep.results[0]?.verdict, 'mismatch', js(rep.results));
  const hint = rep.results[0].problems.find((x) => /this host's sharing config differs from the published config-v1\.json/.test(x));
  assert.ok(hint, js(rep.results[0].problems));
  assert.match(hint!, new RegExp(`sharing\\.feeds\\[${usdc}\\]\\.quoteUsd: published ${w.sim.addr.usdcUsd}, here ${w.sim.addr.ethUsd}`));
  const page = v.ctx.alerts.raised.find((a) => a.key.startsWith('mismatch:'))!;
  assert.match(page.text, /this host's sharing config differs/, 'the page carries the hint');
});
