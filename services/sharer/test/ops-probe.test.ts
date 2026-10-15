// `check --probe` (gap item 16): the publishing path exercised before the
// first epoch needs it - a data-repo write and delete, a pin on each pinner
// answering this host's CID, the file read back through the site and a
// gateway, and a test alert through every sink. Without --probe, check
// writes nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { opsWorld } from './sim/world.ts';
import { js } from './sim/helpers.ts';
import { main } from '../src/cli.ts';
import { build } from '../src/ops/runner.ts';
import { writeProbe } from '../src/ops/writeprobe.ts';
import { memoryLogger } from '../src/ops/log.ts';

type W = ReturnType<typeof opsWorld>;
const SECRETS = { CURB_SHARER_DATA_REPO_TOKEN: 'ghp-test-token-0123456789', CURB_SHARER_PIN_TOKENS: '{"pinata":"pinata-test-jwt-0123456789"}', CURB_SHARER_ALERT_WEBHOOKS: '{"webhook":"https://hooks.test/probe"}' };

async function cli(w: W, args: string[], env: Record<string, string> = SECRETS) {
  const dir = mkdtempSync(join(tmpdir(), 'curb-probe-'));
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

/** The world, with read-back as fast as the fake net allows. */
const world = () => opsWorld();

test('check --probe on an honest setup: written, pinned under this CID on both pinners, read back, deleted, alerted', async () => {
  const w = world();
  const r = await cli(w, ['check', '--probe']);
  assert.equal(r.code, 0, js(r));
  const probe = r.out.find((l) => l.startsWith('probe file '))!;
  const [, path, cid] = /^probe file (\S+): sha256 0x[0-9a-f]{64}, CID (\S+)$/.exec(probe)!;
  assert.match(path, /^sharing\/8453\/probe\/.+\.json$/);
  for (const l of ['probe: data repo write: ok (curb/curb-sharing-data@main)', `probe: pin kubo: stored under ${cid}`, `probe: pin pinata: stored under ${cid}`, 'probe: read back through site: ok', 'probe: read back through gateway https://gw.test: ok', 'probe: data repo delete: ok', 'probe: alert sink webhook: delivered']) assert.ok(r.out.includes(l), `${l}\n${js(r.out)}`);
  assert.ok(r.out.some((l) => /^config ok; .*; the write probe passed$/.test(l)), js(r.out));
  assert.ok(!w.net.repo.has(path), 'the probe file is gone again');
  assert.deepEqual(w.net.commits.filter((c) => c.path === path).map((c) => /removed/.test(c.message)), [false, true], 'one write, one delete');
  assert.ok(w.net.blocks.has(cid), 'pinned');
  assert.ok(w.net.log.some((x) => x.url.startsWith('https://site.test/' + path) && x.status === 200), 'read through the site');
  const alert = w.net.alerts.find((a) => a.url === 'https://hooks.test/probe');
  assert.ok(alert && /^Test alert from /.test(alert.body.title), js(w.net.alerts));
});

test('check without --probe writes nothing, pins nothing and sends no alert', async () => {
  const w = world();
  const r = await cli(w, ['check']);
  assert.equal(r.code, 0, js(r));
  assert.deepEqual(w.net.commits, []);
  assert.equal(w.net.blocks.size, 0);
  assert.deepEqual(w.net.alerts, []);
});

/** The probe through build() as the CLI wires it, with the read-back paced
 *  for a test (the CLI waits up to a minute and a quarter for a CDN). */
async function probe(w: W, env: Record<string, string> = SECRETS) {
  const b = build({ cfg: w.cfg, mode: 'check', dataDir: null, secrets: { env, dir: '/nonexistent-secrets' }, rpcs: [w.sim.rpc('a'), w.sim.rpc('b')], fetch: w.net.fetch as any, log: memoryLogger(), now: w.clock.now, sleep: async () => {}, holder: 'probe-host', refetch: { tries: 2, delayMs: 1 } });
  return writeProbe(b.ctx, { host: 'probe-host' });
}

test('the probe passes on the simulated setup with the same build the CLI uses', async () => {
  const w = world();
  const p = await probe(w);
  assert.deepEqual(p.problems, [], js(p));
});

test('check --probe names each broken link of the publishing path', async () => {
  const cases: [string, (w: W) => void, RegExp, Record<string, string>?][] = [
    ['a token without write access', (w) => (w.net.refuseWrites = /probe/), /^probe: the data repo refused the write: .*403/],
    ['a pinner that stores the file under another CID', (w) => (w.net.pinataWrongCid = true), /^probe: pin pinata failed: stored under bafybeiwrongwrongwrong, not \S+ - this pinner would never count/],
    ['a pinner whose token is missing', () => {}, /^probe: pinner pinata cannot run here \(its pin_tokens entry is not set\)/, { ...SECRETS, CURB_SHARER_PIN_TOKENS: '{}' }],
    ['too few pins for an epoch', (w) => (w.net.kuboDown = true), /^probe: 1 pinner\(s\) stored it under \S+; an epoch needs 2/],
    ['a site without the rewrite', (w) => (w.net.siteDown = true), /^probe: the site does not serve the data repo's file .*rewrite/],
    ['a site serving other bytes', (w) => (w.net.siteTamper = (_p, b) => new Uint8Array([...b, 32])), /^probe: the site does not serve the data repo's file .*served bytes whose sha256/],
    ['no gateway serving the pin', (w) => (w.net.gatewayDown = true), /^probe: no IPFS gateway serves the pinned file/],
    ['a sink that fails', () => {}, /^probe: alert sink discord failed: /, { ...SECRETS, CURB_SHARER_ALERT_WEBHOOKS: '{"webhook":"https://hooks.test/probe","discord":"https://nowhere.test/x"}' }],
    ['no data repo token', () => {}, /^probe: no data repo to write to/, { CURB_SHARER_PIN_TOKENS: SECRETS.CURB_SHARER_PIN_TOKENS }],
  ];
  for (const [name, broken, want, env] of cases) {
    const w = world();
    broken(w);
    const p = await probe(w, env);
    assert.ok(p.problems.some((l) => want.test(l)), `${name}: ${js(p.problems)}`);
  }
});

test('a probe that could not delete its file says where it is', async () => {
  const w = world();
  w.net.beforeCommit = null;
  const realFetch = w.net.fetch;
  const p = await probe(Object.assign(w, { net: Object.assign(w.net, { fetch: (async (u: any, init: any = {}) => ((init.method ?? 'GET') === 'DELETE' ? new Response('{"message":"nope"}', { status: 403 }) : realFetch(u, init))) as any }) }));
  assert.ok(p.problems.some((l) => /^probe: the probe file could not be deleted \(sharing\/8453\/probe\/probe-host-\d+\.json; remove it by hand\)/.test(l)), js(p.problems));
});
