// Liveness: a keeper, guardian or verifier whose ticks keep failing pages;
// the standby takes over from a primary that beats but never finishes; a
// refused data-repo token pages at once; the guardian watches its balance and
// writes a heartbeat; a verifier pages when no keeper, or no guardian, has
// finished a clean tick for too long; `check` refuses a host with no alert
// sink, and `alert-test` proves each sink.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { opsWorld } from './sim/world.ts';
import { tick, js, lying, alertKeys } from './sim/helpers.ts';
import { watchTick } from '../src/ops/verify.ts';
import { STATUS_PATH, STANDBY_STATUS_PATH, GUARDIAN_STATUS_PATH } from '../src/ops/lease.ts';
import { main } from '../src/cli.ts';

type W = ReturnType<typeof opsWorld>;
const beat = (w: W, path: string) => JSON.parse(w.net.text(path)!);
const raisedOf = (k: { ctx: { alerts: { raised: { key: string }[] } } }, key: string) => k.ctx.alerts.raised.filter((a) => a.key === key) as any[];
const nowS = (w: W) => Math.floor(w.clock.t / 1000);

/** Provider b of a keeper, which can be taken down (out of quota, a revoked key). */
function downable(w: W) {
  const s = { down: false };
  const rpc = lying(w.sim.rpc('b'), 'b', (_m, _p, r) => {
    if (s.down) throw new Error('provider b answered HTTP 429: monthly quota exceeded');
    return r;
  });
  return Object.assign(s, { rpc });
}

test('one provider down: every keeper tick fails, the heartbeat says so at once, a page after failingAfterSec, and the standby takes over', async () => {
  const w = opsWorld();
  const b = downable(w);
  const k = w.make('keeper', { holder: 'vps', rpcs: [w.sim.rpc('a'), b.rpc] });
  const t0 = nowS(w);
  const r0 = await tick(w, k);
  assert.equal(r0.ok, true, js(r0));
  assert.equal(beat(w, STATUS_PATH).lastOkAt, t0, 'a clean tick is recorded in the heartbeat');
  assert.equal(beat(w, STATUS_PATH).failingSince, null);

  b.down = true;
  const beats = () => w.net.commits.filter((c) => c.path === STATUS_PATH).length;
  const before = beats();
  w.pass(300);
  const r1 = await tick(w, k);
  assert.equal(r1.ok, false);
  assert.match(r1.errors.join(' '), /provider b answered HTTP 429/);
  assert.equal(beats(), before + 1, 'the heartbeat is written at once when the ticks start failing, not 15 minutes later');
  const hb = beat(w, STATUS_PATH);
  assert.equal(hb.lastOkAt, t0, 'lastOkAt stays at the last clean tick');
  assert.equal(hb.failingSince, t0 + 300, 'the streak starts at the first failed tick');
  assert.ok(hb.heartbeatAt > hb.lastOkAt);

  // failing for 25 minutes (< 30): no page yet
  for (let i = 0; i < 5; i++) {
    w.pass(300);
    await tick(w, k);
  }
  assert.deepEqual(raisedOf(k, 'failing:keeper'), [], 'no page before failingAfterSec');

  // a standby looking now: the primary beats, and its last clean tick is 30 minutes old - idle
  const standby = w.make('keeper', { holder: 'gha', role: 'standby' });
  const s1 = await tick(w, standby);
  assert.match(s1.notes.join(' '), /standby stays idle/, js(s1));

  w.pass(300);
  await tick(w, k);
  const page = raisedOf(k, 'failing:keeper');
  assert.equal(page.length, 1, js(alertKeys(k)));
  assert.equal(page[0].severity, 'page');
  assert.match(page[0].title, /The keeper has had NO CLEAN TICK for 3[0-9] min/);
  assert.match(page[0].text, /provider b answered HTTP 429/, 'the page names the error');
  w.pass(300);
  await tick(w, k);
  assert.equal(raisedOf(k, 'failing:keeper').length, 1, 'once per reminder period, not every tick');

  // 45 minutes after the last clean tick the primary still beats, but the
  // standby counts it as silent - and with its own providers it publishes
  while (nowS(w) < t0 + 3650) {
    w.pass(300);
    await tick(w, k);
  }
  assert.ok(nowS(w) - beat(w, STATUS_PATH).heartbeatAt < 2700, 'the primary heartbeat itself is fresh');
  const s2 = await tick(w, standby);
  assert.match(s2.notes.join(' '), /beats but has had no clean tick for \d+s \(.*provider b answered HTTP 429.*\); standby acts/, js(s2.notes));
  assert.equal(s2.published.length, 1, js(s2));
  assert.ok(alertKeys(standby).includes('standby-acting'));
});

test('the ticks recover: the failing streak ends and the heartbeat says so at once', async () => {
  const w = opsWorld();
  const b = downable(w);
  const k = w.make('keeper', { holder: 'vps', rpcs: [w.sim.rpc('a'), b.rpc] });
  b.down = true;
  await tick(w, k);
  assert.notEqual(beat(w, STATUS_PATH).failingSince, null);
  b.down = false;
  w.pass(120);
  const r = await tick(w, k);
  assert.equal(r.ok, true, js(r));
  const hb = beat(w, STATUS_PATH);
  assert.equal(hb.failingSince, null, 'written at once, though the schedule is 15 minutes');
  assert.equal(hb.lastOkAt, nowS(w));
});

test('a keeper with an expired data-repo token pages AT ONCE; a rate limit does not', async () => {
  for (const [status, message, pages] of [
    [401, 'Bad credentials', true],
    [403, 'Resource not accessible by personal access token', true],
    [403, 'API rate limit exceeded for user ID 1.', false],
  ] as const) {
    const w = opsWorld();
    w.net.githubDenies = status;
    w.net.deniedMessage = message;
    const k = w.make('keeper');
    await tick(w, k);
    const a = raisedOf(k, 'data-repo-denied');
    if (!pages) {
      assert.deepEqual(a, [], `${status} ${message}`);
      continue;
    }
    assert.equal(a.length, 1, `${status} ${message}: ${js(alertKeys(k))}`);
    assert.equal(a[0].severity, 'page');
    assert.match(a[0].text, new RegExp(`GitHub answered ${status}`));
    assert.match(a[0].text, /curb\/curb-sharing-data/);
  }
});

test('a standby with an expired token cannot read the primary: it pages and says why, and acts on nothing', async () => {
  const w = opsWorld();
  w.net.githubDenies = 401;
  const standby = w.make('keeper', { holder: 'gha', role: 'standby' });
  w.pass(3601);
  const before = w.sim.sent.length;
  const r = await tick(w, standby);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /the primary heartbeat could not be read: .*401/);
  assert.equal(w.sim.sent.length, before);
  assert.ok(alertKeys(standby).includes('data-repo-denied'), js(alertKeys(standby)));
});

test('a standby standing in for a silent primary reports on schedule even with nothing to send', async () => {
  const w = opsWorld();
  const standby = w.make('keeper', { holder: 'gha', role: 'standby' });
  const r = await tick(w, standby); // no primary at all; nothing due yet
  assert.match(r.notes.join(' '), /no primary heartbeat at all; standby acts/);
  assert.equal(r.acted, false);
  assert.ok(w.net.repo.has(STANDBY_STATUS_PATH), 'it reports while it stands in');
  const s = beat(w, STANDBY_STATUS_PATH);
  assert.equal(s.role, 'standby');
  assert.equal(s.lastOkAt, nowS(w));
  const n = w.net.commits.filter((c) => c.path === STANDBY_STATUS_PATH).length;
  w.pass(300);
  await tick(w, standby);
  assert.equal(w.net.commits.filter((c) => c.path === STANDBY_STATUS_PATH).length, n, 'on the heartbeat schedule, not every run');
});

test('a standby that failed while standing in, then stood idle for days, does not page at the first failure of its next stand-in', async () => {
  const w = opsWorld();
  const b = downable(w);
  b.down = true;
  const standby = w.make('keeper', { holder: 'gha', role: 'standby', rpcs: [w.sim.rpc('a'), b.rpc] });
  const r1 = await tick(w, standby); // no primary: it stands in, and fails
  assert.equal(r1.ok, false, js(r1));
  const primary = w.make('keeper', { holder: 'vps' });
  w.pass(60);
  await tick(w, primary); // the primary is back
  w.pass(60);
  const r2 = await tick(w, standby);
  assert.match(r2.notes.join(' '), /standby stays idle/);
  // two days later the primary is gone again; the standby's first failure is a fresh streak
  w.clock.t += 2 * 86400_000;
  w.pass(60);
  const r3 = await tick(w, standby);
  assert.equal(r3.ok, false);
  assert.deepEqual(raisedOf(standby, 'failing:standby'), [], js(alertKeys(standby)));
});

test('the guardian: its failing passes page after 10 minutes, a low balance warns, and it writes its heartbeat', async () => {
  const w = opsWorld();
  const b = downable(w);
  w.sim.state.eth.set(w.signers.guardian.address, 10n ** 15n); // 0.001 ETH
  w.sim.snaps.set(w.sim.latest, structuredClone(w.sim.state));
  const g = w.make('guardian', { holder: 'guardian-box', rpcs: [w.sim.rpc('a'), b.rpc] });
  const r0 = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(r0.ok, true, js(r0));
  const low = raisedOf(g, 'low-eth:guardian');
  assert.equal(low.length, 1, js(alertKeys(g)));
  assert.equal(low[0].severity, 'warn');
  assert.match(low[0].text, new RegExp(w.signers.guardian.address));
  const hb = beat(w, GUARDIAN_STATUS_PATH);
  assert.equal(hb.role, 'guardian');
  assert.equal(hb.holder, 'guardian-box');
  assert.equal(hb.guardian, w.signers.guardian.address);
  assert.equal(hb.balanceWei, (10n ** 15n).toString());
  assert.equal(hb.lastOkAt, nowS(w));

  b.down = true;
  w.pass(60);
  await watchTick(g.ctx, g.keys.guardian);
  assert.notEqual(beat(w, GUARDIAN_STATUS_PATH).failingSince, null, 'written at once when its passes start failing');
  for (let i = 0; i < 9; i++) {
    w.pass(60);
    await watchTick(g.ctx, g.keys.guardian);
  }
  assert.deepEqual(raisedOf(g, 'failing:guardian'), [], 'not before 10 minutes (9 failed minutes)');
  w.pass(60);
  await watchTick(g.ctx, g.keys.guardian);
  const page = raisedOf(g, 'failing:guardian');
  assert.equal(page.length, 1, js(alertKeys(g)));
  assert.equal(page[0].severity, 'page');
  assert.match(page[0].text, /provider b answered HTTP 429/);
  assert.match(page[0].text, /only the Safe signers could veto/);
});

test('a guardian without a data-repo token runs, and writes no heartbeat', async () => {
  const w = opsWorld();
  delete w.env.CURB_SHARER_DATA_REPO_TOKEN;
  const g = w.make('guardian');
  const r = await watchTick(g.ctx, g.keys.guardian);
  assert.equal(r.ok, true, js(r));
  assert.equal(g.ctx.repo, null);
  assert.ok(!w.net.repo.has(GUARDIAN_STATUS_PATH));
});

test('a verifier pages when NO keeper has finished a clean tick for keeperSilentAfterSec - not while the standby covers', async () => {
  const w = opsWorld();
  const k = w.make('keeper', { holder: 'vps' });
  await tick(w, k); // a clean primary tick: its heartbeat
  const v1 = w.make('verify');
  await watchTick(v1.ctx, null);
  assert.deepEqual(raisedOf(v1, 'keepers-silent'), [], 'a fresh primary');

  // the VPS dies; the standby takes over and keeps reporting
  w.clock.t += 46 * 60_000;
  w.pass(60);
  const standby = w.make('keeper', { holder: 'gha', role: 'standby' });
  w.clock.t += 50 * 60_000;
  await tick(w, standby);
  const v2 = w.make('verify');
  await watchTick(v2.ctx, null);
  assert.ok(nowS(w) - beat(w, STATUS_PATH).heartbeatAt > 5400, 'the primary is silent past the threshold');
  assert.deepEqual(raisedOf(v2, 'keepers-silent'), [], 'the standby covers: a warning case, not a page');

  // and then the standby stops too
  w.clock.t += 91 * 60_000;
  w.pass(60);
  const v3 = w.make('verify');
  const r = await watchTick(v3.ctx, null);
  const page = raisedOf(v3, 'keepers-silent');
  assert.equal(page.length, 1, js(alertKeys(v3)));
  assert.equal(page[0].severity, 'page');
  assert.match(page[0].text, /The primary \(vps\): last clean tick/);
  assert.match(page[0].text, /The standby: last clean tick/);
  assert.deepEqual(r.errors, []);
});

test('a verifier pages when there is no keeper heartbeat at all, and when the primary beats but every tick fails', async () => {
  const w = opsWorld();
  const v = w.make('verify');
  await watchTick(v.ctx, null);
  assert.match(raisedOf(v, 'keepers-silent')[0]?.text ?? '', /no heartbeat in the data repo.*it has never reported/, js(alertKeys(v)));

  const w2 = opsWorld();
  const b = downable(w2);
  const k = w2.make('keeper', { holder: 'vps', rpcs: [w2.sim.rpc('a'), b.rpc] });
  b.down = true;
  for (let i = 0; i < 20; i++) {
    await tick(w2, k);
    w2.pass(300);
  }
  await tick(w2, k);
  assert.ok(nowS(w2) - beat(w2, STATUS_PATH).heartbeatAt < 900, 'it beats');
  const v2 = w2.make('verify');
  await watchTick(v2.ctx, null);
  const p = raisedOf(v2, 'keepers-silent');
  assert.equal(p.length, 1, js(alertKeys(v2)));
  assert.match(p[0].text, /provider b answered HTTP 429/, "the primary's own last error");
});

test('a verifier pages when the guardian is silent or has never written a heartbeat; 0 turns that off', async () => {
  const w = opsWorld();
  const g = w.make('guardian', { holder: 'guardian-box' });
  await watchTick(g.ctx, g.keys.guardian);
  const v1 = w.make('verify');
  await watchTick(v1.ctx, null);
  assert.deepEqual(raisedOf(v1, 'guardian-silent'), [], 'a fresh guardian');
  w.clock.t += 31 * 60_000;
  w.pass(60);
  const v2 = w.make('verify');
  await watchTick(v2.ctx, null);
  const p = raisedOf(v2, 'guardian-silent');
  assert.equal(p.length, 1, js(alertKeys(v2)));
  assert.equal(p[0].severity, 'page');
  assert.match(p[0].title, /GUARDIAN has not finished a clean tick for 3[0-9] min/);

  const w2 = opsWorld();
  const v3 = w2.make('verify');
  await watchTick(v3.ctx, null);
  assert.match(raisedOf(v3, 'guardian-silent')[0]?.title ?? '', /never written a heartbeat/);
  const w3 = opsWorld({ config: (c) => (c.verifier = { guardianSilentAfterSec: 0 }) });
  const v4 = w3.make('verify');
  await watchTick(v4.ctx, null);
  assert.deepEqual(raisedOf(v4, 'guardian-silent'), []);
});

test('the guardian signs its heartbeat with its vetoer key; a verifier pages on one forged with only a data-repo token', async () => {
  const { beatMessage } = await import('../src/ops/liveness.ts');
  const { keySigner } = await import('../src/ops/tx.ts');
  const { testKey } = await import('./sim/world.ts');
  const { recoverMessageAddress } = await import('viem');
  const w = opsWorld();
  const g = w.make('guardian', { holder: 'guardian-box' });
  await watchTick(g.ctx, g.keys.guardian);
  const hb = beat(w, GUARDIAN_STATUS_PATH);
  assert.equal(hb.chainId, '8453');
  assert.equal(hb.distributorFactory, w.sim.addr.factory);
  assert.equal(typeof hb.passMs, 'number');
  assert.equal((await recoverMessageAddress({ message: beatMessage(hb), signature: hb.signature })).toLowerCase(), w.signers.guardian.address, 'signed by the guardian key');

  // the keeper host in the wrong hands: its token writes a fresh "ok" guardian heartbeat
  // while the real guardian is dead
  w.clock.t += 31 * 60_000;
  w.pass(60);
  const forge = (extra: Record<string, unknown>) => {
    const fake: Record<string, unknown> = { ...hb, heartbeatAt: nowS(w), lastOkAt: nowS(w), ok: true, errors: [], ...extra };
    delete fake.signature;
    return fake;
  };
  const cases: [string, () => Promise<Record<string, unknown>>, RegExp][] = [
    ['unsigned', async () => forge({}), /it carries no signature/],
    ['the old signature', async () => ({ ...forge({}), signature: hb.signature }), /not by the guardian it names/],
    ['signed by a key that is not a vetoer', async () => {
      const thief = keySigner(testKey('thief'));
      const f = forge({ guardian: thief.address });
      return { ...f, signature: await thief.signMessage!(beatMessage(f)) };
    }, /is not a vetoer of/],
  ];
  for (const [name, make, why] of cases) {
    w.net.put(GUARDIAN_STATUS_PATH, new TextEncoder().encode(JSON.stringify(await make(), null, 1)));
    const v = w.make('verify');
    await watchTick(v.ctx, null);
    const p = raisedOf(v, 'guardian-silent');
    assert.equal(p.length, 1, `${name}: ${js(alertKeys(v))}`);
    assert.equal(p[0].severity, 'page');
    assert.match(p[0].title, /GUARDIAN heartbeat is NOT SIGNED by a vetoer/, name);
    assert.match(p[0].text, why, name);
  }

  // the real guardian, back: its signed heartbeat is trusted again
  await watchTick(g.ctx, g.keys.guardian);
  w.pass(60);
  const v2 = w.make('verify');
  await watchTick(v2.ctx, null);
  assert.deepEqual(raisedOf(v2, 'guardian-silent'), []);
});

test("a verifier that cannot read the heartbeats does not page on its own failure: its tick is not clean", async () => {
  const w = opsWorld();
  w.net.rawDown = true;
  const v = w.make('verify');
  const r = await watchTick(v.ctx, null);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /heartbeat ops\/status\.json: .*503/);
  assert.ok(!alertKeys(v).some((x) => x === 'keepers-silent' || x === 'guardian-silent'), js(alertKeys(v)));
});

test('a verifier whose passes keep failing pages after its failingAfterSec', async () => {
  const w = opsWorld();
  const b = downable(w);
  b.down = true;
  const v = w.make('verify', { rpcs: [w.sim.rpc('a'), b.rpc] });
  await watchTick(v.ctx, null);
  w.pass(1700);
  await watchTick(v.ctx, null);
  assert.deepEqual(raisedOf(v, 'failing:verify'), []);
  w.pass(120);
  await watchTick(v.ctx, null);
  assert.equal(raisedOf(v, 'failing:verify').length, 1, js(alertKeys(v)));
});

test('config: the verifier may not call a primary silent before the standby would replace it', async () => {
  assert.throws(() => opsWorld({ config: (c) => (c.verifier = { keeperSilentAfterSec: 2700 }) }), /keeperSilentAfterSec must be more than config\.lease\.standbyAfterSec/);
});

// ---------------------------------------------------------------- the CLI

async function cli(w: W, args: string[], env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'curb-live-'));
  const saved = { fetch: globalThis.fetch, env: { ...process.env } };
  const out: string[] = [];
  const err: string[] = [];
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify(w.raw));
    writeFileSync(join(dir, 'rpc_urls'), JSON.stringify(['http://rpc-a.test', 'http://rpc-b.test']));
    process.env.CURB_SHARER_SECRETS_DIR = dir;
    process.env.CURB_SHARER_LOG_LEVEL = 'error';
    Object.assign(process.env, env);
    globalThis.fetch = (async (u: any, init?: any) => {
      const url = String(u);
      if (url.startsWith('http://rpc-')) {
        const body = JSON.parse(init.body);
        try {
          const result = await w.sim.rpc(url).request({ method: body.method, params: body.params });
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }, (_k, x) => (typeof x === 'bigint' ? '0x' + x.toString(16) : x)), { status: 200 });
        } catch (e: any) {
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: e.code ?? -32000, message: e.message, data: e.data } }), { status: 200 });
        }
      }
      return (w.net.fetch as any)(u, init);
    }) as typeof fetch;
    const code = await main([...args, '--config', join(dir, 'config.json'), '--data', join(dir, 'data')], { out: (s: string) => out.push(s), err: (s: string) => err.push(s) });
    return { code, out, err };
  } finally {
    globalThis.fetch = saved.fetch;
    for (const k of Object.keys(process.env)) if (!(k in saved.env)) delete process.env[k];
    Object.assign(process.env, saved.env);
    rmSync(dir, { recursive: true, force: true });
  }
}

test('check: a host with no alert sink is NOT OK', async () => {
  const w = opsWorld();
  const r = await cli(w, ['check'], {});
  assert.equal(r.code, 2, js(r));
  assert.ok(r.err.some((l) => /^NOT OK: no alert sink: set the alert_webhooks secret/.test(l)), js(r.err));
  assert.ok(!r.out.some((l) => /config ok/.test(l)));
});

test('alert-test: one alert through every sink, naming the host; exit 0, 1 for a failed sink, 2 with none', async () => {
  const w = opsWorld();
  const ok = await cli(w, ['alert-test', '--note', 'from the runbook'], { CURB_SHARER_ALERT_WEBHOOKS: JSON.stringify({ webhook: 'https://hooks.test/a', telegram: { token: '123456:abcdefghijklmnopqrstuvwxyz', chatId: '42' } }) });
  assert.equal(ok.code, 0, js(ok));
  assert.deepEqual(ok.out.sort(), ['telegram: delivered', 'webhook: delivered']);
  assert.equal(w.net.alerts.length, 2);
  const hook = w.net.alerts.find((a) => a.url === 'https://hooks.test/a')!;
  assert.equal(hook.body.severity, 'info');
  assert.match(hook.body.title, /^Test alert from /);
  assert.match(hook.body.text, /from the runbook/);
  // twice in a row: never held back by a cooldown
  const again = await cli(w, ['alert-test'], { CURB_SHARER_ALERT_WEBHOOKS: JSON.stringify({ webhook: 'https://hooks.test/a' }) });
  assert.equal(again.code, 0);
  assert.equal(w.net.alerts.length, 3);

  const bad = await cli(w, ['alert-test'], { CURB_SHARER_ALERT_WEBHOOKS: JSON.stringify({ webhook: 'https://hooks.test/a', discord: 'https://nowhere.test/hook' }) });
  assert.equal(bad.code, 1, js(bad));
  assert.ok(bad.out.includes('webhook: delivered'));
  assert.ok(bad.err.some((l) => /^NOT OK: discord: .*599/.test(l)), js(bad.err));

  const none = await cli(w, ['alert-test'], {});
  assert.equal(none.code, 2);
  assert.ok(none.err.some((l) => /no alert sink/.test(l)));
});
