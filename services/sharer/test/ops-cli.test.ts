// The CLI as an operator runs it by hand: `check` checks what the runbook
// says it checks (contract addresses, the eth_call capability, the secrets),
// and a `--once` run prints what its tick did.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { opsWorld, testKey } from './sim/world.ts';
import { tick, js, lying } from './sim/helpers.ts';
import { main } from '../src/cli.ts';
import { checkSetup } from '../src/ops/runner.ts';
import { keeperTick } from '../src/ops/keeper.ts';

/** Runs main() against the simulated chain and network: the two rpc_urls
 *  are answered by the simulator, everything else by the simulated net. */
async function runCli(w: ReturnType<typeof opsWorld>, args: string[], raw: unknown = w.raw, extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'curb-cli-'));
  const saved = { fetch: globalThis.fetch, env: { ...process.env } };
  const out: string[] = [];
  const err: string[] = [];
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify(raw));
    writeFileSync(join(dir, 'rpc_urls'), JSON.stringify(['http://rpc-a.test', 'http://rpc-b.test']));
    process.env.CURB_SHARER_SECRETS_DIR = dir;
    process.env.CURB_SHARER_LOG_LEVEL = 'error';
    Object.assign(process.env, extraEnv);
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

test('check: a deployment config left at zero addresses is refused, not "config ok"', async () => {
  const w = opsWorld();
  const raw = structuredClone(w.raw);
  raw.distributorFactory = '0x' + '0'.repeat(40);
  raw.catalog = '0x' + '0'.repeat(40);
  const r = await runCli(w, ['check'], raw);
  assert.equal(r.code, 2, js(r));
  assert.ok(!r.out.some((l) => /config ok/.test(l)), js(r.out));
  assert.ok(r.err.some((l) => /distributorFactory is the zero address/.test(l)), js(r.err));
  assert.ok(r.err.some((l) => /catalog is the zero address/.test(l)), js(r.err));
});

test('check: an address with no code, and a provider without eth_call-without-to, are refused', async () => {
  const w = opsWorld();
  const b = w.make('check', { rpcs: [w.sim.rpc('a'), lying(w.sim.rpc('b'), 'b', (m, p, res) => { if (m === 'eth_call' && !p[0].to) throw new Error('to is required'); return res; })] });
  const c = await checkSetup(b.ctx, { env: {}, dir: '/nonexistent-secrets' });
  assert.ok(c.problems.some((p) => /provider b cannot run an eth_call without "to"/.test(p)), js(c));
  assert.ok(c.lines.some((l) => /provider a: eth_call without "to" works/.test(l)), js(c));

  const w2 = opsWorld({ config: (x) => (x.catalog = '0x00000000000000000000000000000000000c0de0') });
  const c2 = await checkSetup(w2.make('check').ctx, { env: {}, dir: '/nonexistent-secrets' });
  assert.ok(c2.problems.some((p) => /catalog 0x0+c0de0 has no code on provider a/.test(p)), js(c2));
});

test('check: an honest setup is ok and names each secret it holds', async () => {
  const w = opsWorld();
  // the simulator has no catalog contract; the config may leave it unset
  const r = await runCli(w, ['check'], { ...w.raw, catalog: null }, { CURB_SHARER_PUSHER_KEY: testKey('pusher').reveal(), CURB_SHARER_DATA_REPO_TOKEN: 'ghp-test-token-0123456789', CURB_SHARER_ALERT_WEBHOOKS: '{"webhook":"https://hooks.test/curb"}' });
  assert.equal(r.code, 0, js(r));
  assert.ok(r.out.some((l) => /^alert sinks: webhook/.test(l)), js(r.out));
  assert.ok(r.out.some((l) => /^config ok; 2 providers on chain 8453/.test(l)), js(r.out));
  assert.ok(r.out.includes(`pusher_key: ${w.signers.pusher.address}`), js(r.out));
  assert.ok(r.out.includes('publisher_key: not set'), js(r.out));
  assert.ok(r.out.includes('data_repo_token: set'), js(r.out));
  assert.ok(r.out.includes('catalog: not set'), js(r.out));
  assert.ok(r.out.some((l) => /^pin_tokens\.pinata \(pinner pinata\): not set/.test(l)), js(r.out));
  assert.ok(r.out.some((l) => /^provider b: eth_call without "to" works/.test(l)), js(r.out));
});

test('verify --once prints what its pass found as one JSON line', async () => {
  const w = opsWorld();
  const k = w.make('keeper');
  w.pass(3601);
  await tick(w, k);
  // (no guardian runs here: its heartbeat watch is off, so no page is logged)
  const r = await runCli(w, ['verify', '--once'], { ...w.raw, verifier: { guardianSilentAfterSec: 0 } });
  assert.equal(r.code, 0, js(r));
  const line = r.out.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((x) => x && x.mode === 'verify');
  assert.ok(line, js(r.out));
  assert.equal(line.ok, true);
  assert.equal(line.checked, 1);
  assert.equal(line.results[0].verdict, 'ok', js(line));
  assert.equal(line.results[0].epoch, '1');
});

test('the keeper status line says where each launch is AFTER the tick acted', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  const k = w.make('keeper');
  w.pass(3601);
  const r1 = await tick(w, k);
  assert.equal(r1.published.length, 1, js(r1));
  const l1 = (r1.status.launches as any[]).find((x) => x.distributor === L.D);
  assert.equal(l1.pending, '1', 'the epoch this tick published is pending');
  w.pass(3700);
  const r2 = await keeperTick(k.ctx, k.keys, { lease: k.lease, role: 'primary', waitForSafe: true, holder: k.holder });
  assert.equal(w.sim.launch(L.D).active.epoch, 1, 'activated');
  const l2 = (r2.status.launches as any[]).find((x) => x.distributor === L.D);
  assert.equal(l2.active, '1', js(l2));
  assert.notEqual(l2.pending, '1', js(l2));
});
