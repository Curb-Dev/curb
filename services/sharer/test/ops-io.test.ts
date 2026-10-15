// The ops service's edges: secrets (where they come from, that they never
// reach a log line or an alert), the GitHub contents client, the pinners'
// requests, the alert sinks and their cooldown, the health endpoint, the
// CLI, and the transaction sender's refusals.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { inspect } from 'node:util';
import { encodeFunctionData } from 'viem';
import { Secret, readSecret, readKey, readRpcUrls, readJsonSecret, redact, SecretError } from '../src/ops/secrets.ts';
import { jsonLogger, memoryLogger } from '../src/ops/log.ts';
import { DataRepo, Conflict } from '../src/ops/github.ts';
import { KuboPinner, PinataPinner, PsaPinner } from '../src/ops/pinners.ts';
import { Alerter, makeSinks, render } from '../src/ops/alerts.ts';
import { Store } from '../src/ops/store.ts';
import { Health, healthServer, listen } from '../src/ops/server.ts';
import { main, parseArgs } from '../src/cli.ts';
import { GasPriceAboveCap, OutOfEth, WouldRevert, revertOf } from '../src/ops/tx.ts';
import { fileCid } from '../src/ops/cid.ts';
import { FakeNet } from './sim/net.ts';
import { opsWorld, testKey } from './sim/world.ts';
import { tick, js } from './sim/helpers.ts';
import { opsDistributorAbi } from '../src/ops/abis.ts';
import { ALL_ERRORS_ABI } from '../src/ops/abis.ts';
import { encodeErrorResult } from 'viem';
import { RpcError } from '../src/chain/rpc.ts';

// ---------------------------------------------------------------- secrets

test('secrets: a Docker secret file wins over the environment; an empty one counts as unset; keys are shape-checked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'curb-secrets-'));
  try {
    writeFileSync(join(dir, 'data_repo_token'), 'from-the-file-123456\n');
    const env = { CURB_SHARER_DATA_REPO_TOKEN: 'from-the-env-123456', CURB_SHARER_PUSHER_KEY: '0x' + '11'.repeat(32) };
    assert.equal(readSecret('data_repo_token', { dir, env })!.reveal(), 'from-the-file-123456');
    writeFileSync(join(dir, 'data_repo_token'), '\n');
    assert.equal(readSecret('data_repo_token', { dir, env })!.reveal(), 'from-the-env-123456');
    assert.equal(readSecret('nothing_here', { dir, env }), null);
    assert.equal(readKey('pusher_key', { dir, env })!.reveal(), '0x' + '11'.repeat(32));
    assert.equal(readKey('pusher_key', { dir, env: { CURB_SHARER_PUSHER_KEY: '11'.repeat(32) } })!.reveal(), '0x' + '11'.repeat(32), '0x added');
    assert.throws(() => readKey('pusher_key', { dir, env: { CURB_SHARER_PUSHER_KEY: '0x1234' } }), (e: any) => e instanceof SecretError && !e.message.includes('0x1234'));
    assert.throws(() => readSecret('x', { dir, env: { CURB_SHARER_X_FILE: join(dir, 'missing') } }), /does not exist/);
    const urls = readRpcUrls('rpc_urls', { dir, env: { CURB_SHARER_RPC_URLS: 'https://a.example/v2/KEYAAAAAAAA\n# a comment\nhttps://b.example/KEYBBBBBBBB' } });
    assert.deepEqual(urls.map((u) => u.reveal()), ['https://a.example/v2/KEYAAAAAAAA', 'https://b.example/KEYBBBBBBBB']);
    assert.throws(() => readRpcUrls('rpc_urls', { dir, env: { CURB_SHARER_RPC_URLS: 'ws://x' } }), /http/);
    assert.deepEqual(readJsonSecret('pin_tokens', { dir, env: { CURB_SHARER_PIN_TOKENS: '{"pinata":"jwt-abcdefgh"}' } }), { pinata: 'jwt-abcdefgh' });
    assert.equal(redact('a request with jwt-abcdefgh failed'), 'a request with [secret] failed', 'every string of a JSON secret is scrubbed too');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a Secret never prints itself; the redactor scrubs every registered value, URL credentials, bearer tokens, a Telegram bot path', () => {
  const s = new Secret('k', '0x' + 'ab'.repeat(32));
  assert.equal(String(s), '[secret]');
  assert.equal(JSON.stringify({ s }), '{"s":"[secret]"}');
  assert.equal(inspect(s), 'Secret(k)');
  assert.equal(`${s}`, '[secret]');
  const msg = `failed with ${s.reveal()} and ${'ab'.repeat(32)} at https://u:p@h.example/x Bearer abcdefghijkl /bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ`;
  const r = redact(msg);
  assert.ok(!r.includes('ab'.repeat(32)));
  assert.ok(!r.includes('u:p@'));
  assert.ok(!r.includes('abcdefghijkl'));
  assert.ok(!r.includes('ABCDEFGHIJKLMNOP'));
});

test('no secret reaches a log line, even inside an error message or a field', () => {
  const key = new Secret('publisher_key', '0x' + 'cd'.repeat(32));
  const url = readRpcUrls('rpc_urls', { dir: '/nonexistent', env: { CURB_SHARER_RPC_URLS: 'https://rpc.example/v2/SECRETAPIKEY123' } })[0];
  const lines: string[] = [];
  const log = jsonLogger({ write: (x) => lines.push(x) });
  log.error('boom', { error: new Error(`could not reach ${url.reveal()} with ${key.reveal()}`), key, url, nested: { u: url.reveal() } });
  const all = lines.join('\n');
  assert.ok(!all.includes('SECRETAPIKEY123'), all);
  assert.ok(!all.includes('cd'.repeat(32)));
  assert.match(all, /\[secret\]/);
});

test('the keeper run never logs its keys, its token or its RPC URLs', async () => {
  const w = opsWorld();
  const k = w.make('keeper');
  w.pass(3601);
  await tick(w, k);
  const all = k.log.lines.join('\n');
  assert.ok(all.length > 1000, 'the run logged');
  for (const v of [w.env.CURB_SHARER_DATA_REPO_TOKEN, 'pinata-test-jwt-0123456789', testKey('publisher').reveal(), testKey('pusher').reveal(), testKey('publisher').reveal().slice(2)]) assert.ok(!all.includes(v), 'a secret in the log');
  // the alerts the fake webhook got carry none either
  assert.ok(!JSON.stringify(w.net.alerts).includes(w.env.CURB_SHARER_DATA_REPO_TOKEN));
});

// ---------------------------------------------------------------- GitHub

test('the data repo client: bearer token, branch, base64 content, sha compare-and-swap (409 and 422 are Conflict)', async () => {
  const net = new FakeNet();
  const repo = new DataRepo({ owner: 'curb', repo: 'curb-sharing-data', branch: 'main', apiBase: 'https://api.github.test', token: new Secret('t', 'ghp-abcdefghijk'), fetch: net.fetch as any, sleep: async () => {} });
  const b = new TextEncoder().encode('{"a":1}');
  const sha = await repo.put('sharing/x.json', b, 'm', null);
  assert.equal(net.authSeen.at(-1), 'Bearer ghp-abcdefghijk');
  const got = await repo.get('sharing/x.json');
  assert.deepEqual(got!.bytes, b);
  assert.equal(got!.sha, sha);
  await assert.rejects(() => repo.put('sharing/x.json', b, 'm', null), Conflict, 'a create over a file');
  await assert.rejects(() => repo.put('sharing/x.json', b, 'm', 'deadbeef'), Conflict, 'a moved sha');
  assert.equal(await repo.upsert('sharing/x.json', b, 'm'), 'same');
  const n = net.commits.length;
  assert.equal(await repo.upsert('sharing/x.json', new TextEncoder().encode('{"a":2}'), 'm'), 'written');
  assert.equal(net.commits.length, n + 1);
  assert.equal(await repo.get('sharing/nothing.json'), null);
  assert.throws(() => (repo as any).url('../etc'), /bad data repo path/);
});

// ---------------------------------------------------------------- pinners

test('pinners: kubo adds CIDv1 raw leaves in 256 KiB chunks and must answer the computed CID; pinata v3 public; psa never counts', async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const net = new FakeNet();
  const f = (async (u: string, init: RequestInit) => {
    seen.push({ url: u, init });
    return net.fetch(u, init);
  }) as any;
  const b = new TextEncoder().encode('{"epoch":"1"}');
  const cid = fileCid(b);
  const kubo = new KuboPinner('kubo', 'https://kubo.test', new Secret('t', 'filebase-key-123'), { fetch: f });
  const r = await kubo.pin(b, cid, 'f.json');
  assert.ok(r.ok && r.counts && r.cid === cid);
  const q = new URL(seen.at(-1)!.url).searchParams;
  assert.equal(q.get('cid-version'), '1');
  assert.equal(q.get('raw-leaves'), 'true');
  assert.equal(q.get('chunker'), 'size-262144');
  assert.equal(q.get('pin'), 'true');
  assert.equal(new Headers(seen.at(-1)!.init.headers as any).get('authorization'), 'Bearer filebase-key-123');
  const wrong = await kubo.pin(b, 'bafkreiwrong', 'f.json');
  assert.ok(!wrong.ok, 'another CID does not count');
  const pin = new PinataPinner('pinata', 'https://pinata.test', new Secret('p', 'jwt-0123456789'), { fetch: f });
  assert.ok((await pin.pin(b, cid, 'f.json')).ok);
  const fd = seen.at(-1)!.init.body as FormData;
  assert.equal(fd.get('network'), 'public');
  net.pinataWrongCid = true;
  assert.ok(!(await pin.pin(b, cid, 'f.json')).ok);
  const psa = new PsaPinner('psa', 'https://hooks.test/psa', new Secret('q', 'psa-0123456789'), { fetch: f });
  const pr = await psa.pin(b, cid, 'f.json');
  assert.equal(pr.counts, false);
});

// ---------------------------------------------------------------- alerts

test('alerts: one per key per cooldown, a failing sink never throws, calldata rendered ready to sign', async () => {
  const net = new FakeNet();
  const sinks = makeSinks({ discord: 'https://hooks.test/discord', webhook: { url: 'https://hooks.test/hook', bearer: 'hook-bearer-123456' }, telegram: { token: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ', chatId: 42 } }, { fetch: net.fetch as any, sleep: async () => {} });
  const broken = { name: 'broken', send: async () => { throw new Error('sink down'); } };
  let t = 1_000_000;
  const log = memoryLogger();
  const al = new Alerter({ sinks: [broken, ...sinks], store: new Store(null), log, cooldownSec: 3600, now: () => t });
  const a = { key: 'x', severity: 'page' as const, title: 'T', text: 'body', calls: [{ what: 'veto', to: '0x' + '11'.repeat(20), data: '0xabcdef' }] };
  assert.equal(await al.raise(a), true);
  assert.equal(net.alerts.length, 3, 'discord, webhook, telegram');
  assert.equal(await al.raise(a), false, 'cooldown');
  t += 3_601_000;
  assert.equal(await al.raise(a), true);
  assert.match(render(a), /Ready to sign - veto\n {2}to: {4}0x1{40}\n {2}value: 0\n {2}data: {2}0xabcdef/);
  assert.ok(log.lines.some((l) => /an alert sink failed/.test(l) && /sink down/.test(l)));
  assert.ok(!log.lines.join('').includes('ABCDEFGHIJKLMNOP'), 'the bot token is not logged');
  assert.throws(() => makeSinks({ slack: 'x' }), /unknown sink/);
  assert.throws(() => makeSinks({ email: { key: 'k' } }), /email needs/);
});

// ---------------------------------------------------------------- health

test('health: starting, healthy after a clean tick, unhealthy when ticks stop or keep failing', async () => {
  let t = 0;
  const h = new Health({ intervalSec: 60, graceSec: 300, now: () => t });
  assert.equal(h.check().ok, true, 'starting');
  t = 301_000;
  assert.equal(h.check().ok, false, 'no clean tick within the grace');
  h.tick(true, null, { x: 1 });
  assert.equal(h.check().ok, true);
  t += 180_000;
  assert.equal(h.check().ok, true, 'exactly 3 intervals');
  t += 1;
  assert.equal(h.check().ok, false, 'stale');
  h.tick(false, 'rpc down', {});
  assert.equal(h.check().ok, false, 'a failed tick does not make it healthy');
  // over HTTP, on a named pipe / unix socket (no TCP port)
  const sock = process.platform === 'win32' ? `\\\\.\\pipe\\curb-health-${process.pid}` : join(tmpdir(), `curb-health-${process.pid}.sock`);
  const srv = healthServer(h);
  await listen(srv, { socket: sock });
  const get = (path: string) => new Promise<{ code: number; body: string }>((res, rej) => {
    const r = httpRequest({ socketPath: sock, path, method: 'GET' }, (m) => {
      let b = '';
      m.on('data', (c) => (b += c));
      m.on('end', () => res({ code: m.statusCode!, body: b }));
    });
    r.on('error', rej);
    r.end();
  });
  try {
    assert.equal((await get('/healthz')).code, 503);
    h.tick(true, null, { launches: 2 });
    assert.equal((await get('/healthz')).code, 200);
    assert.deepEqual(JSON.parse((await get('/status')).body), { launches: 2 });
    assert.equal((await get('/nope')).code, 404);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

// ---------------------------------------------------------------- CLI

test('the CLI: arguments, usage errors exit 2, an unknown option is refused', async () => {
  const a = parseArgs(['keeper', '--once', '--standby', '--interval=60', '--config', 'x.json']);
  assert.equal(a.mode, 'keeper');
  assert.deepEqual(a.flags.get('interval'), ['60']);
  assert.deepEqual(a.flags.get('config'), ['x.json']);
  assert.deepEqual(a.flags.get('standby'), ['true']);
  const out: string[] = [];
  const err: string[] = [];
  const io = { out: (s: string) => out.push(s), err: (s: string) => err.push(s) };
  assert.equal(await main(['help'], io), 0);
  assert.match(out.join('\n'), /usage: curb-sharer/);
  assert.equal(await main(['verify', '--distributor', '0x12'], io), 2);
  assert.equal(await main(['keeper', '--once', '--colour', 'red'], io), 2);
  assert.match(err.join('\n'), /unknown option --colour/);
  assert.equal(await main(['nonsense'], io), 2);
  assert.equal(await main(['keeper', '--once', '--config', join(tmpdir(), 'no-such-config.json')], io), 2);
  assert.match(err.join('\n'), /cannot read the config/);
});

// ---------------------------------------------------------------- the sender's refusals

test('the sender refuses above the gas cap and without the ETH, and names the contract error of a revert', async () => {
  const w = opsWorld({ config: (c) => Object.assign(c.keeper, { maxGasPriceWei: '5000000', pushMaxGasPriceWei: '5000000' }) }); // base 5e6 + tip 1e6 > 5e6
  const k = w.make('keeper');
  const s = k.keys.pusher!;
  await assert.rejects(() => s.send({ to: w.launches[0].D, data: '0x4641257d', label: 'harvest', distributors: [w.launches[0].D] }), GasPriceAboveCap);
  const w2 = opsWorld();
  const k2 = w2.make('keeper');
  w2.sim.state.eth.set(w2.signers.pusher.address, 1n);
  w2.sim.snaps.set(w2.sim.latest, structuredClone(w2.sim.state));
  await assert.rejects(() => k2.keys.pusher!.send({ to: w2.launches[0].D, data: '0x4641257d', label: 'harvest', distributors: [] }), OutOfEth);
  const data = encodeFunctionData({ abi: opsDistributorAbi, functionName: 'activate' });
  await assert.rejects(() => k2.keys.publisher!.send({ to: w2.launches[0].D, data, label: 'activate', distributors: [] }), (e: any) => e instanceof WouldRevert && e.errorName === 'NothingPending');
  assert.equal(w2.sim.sent.length, 0, 'nothing broadcast');
  const rv = revertOf(new RpcError('execution reverted', { data: encodeErrorResult({ abi: ALL_ERRORS_ABI, errorName: 'WrongEpoch', args: [3, 2] }) }));
  assert.equal(rv.name, 'WrongEpoch');
  assert.deepEqual(rv.args, [3, 2]);
  // the Graduator's: the rescue's refusal says when it opens to anyone
  const rn = revertOf(new RpcError('execution reverted', { data: encodeErrorResult({ abi: ALL_ERRORS_ABI, errorName: 'RescueNotOpenYet', args: ['0x00000000000000000000000000000000000a11ce', 1_800_003_600n] }) }));
  assert.equal(rn.name, 'RescueNotOpenYet');
  assert.deepEqual([String(rn.args[0]).toLowerCase(), rn.args[1]], ['0x00000000000000000000000000000000000a11ce', 1_800_003_600n]);
});

// ---------------------------------------------------------------- downloads bounded in time and size (audit finding 3)

/** A body that answers its headers at once and then sends `chunk` bytes
 *  every pull, for ever (or nothing at all, with `hang`). Counts the bytes
 *  handed out, and whether the reader cancelled it. */
function endless(o: { chunk?: number; hang?: boolean; headers?: Record<string, string> } = {}) {
  const st = { pulled: 0, cancelled: false };
  const body = () =>
    new ReadableStream<Uint8Array>({
      pull(c) {
        if (o.hang) return new Promise<void>(() => {});
        st.pulled += o.chunk ?? 1000;
        c.enqueue(new Uint8Array(o.chunk ?? 1000));
        return undefined;
      },
      cancel() {
        st.cancelled = true;
      },
    });
  return { st, res: () => new Response(body() as BodyInit, { status: 200, headers: o.headers }) };
}

test('getBytes: a body that never finishes arriving times out - one deadline covers the headers AND the body', { timeout: 20_000 }, async () => {
  const { getBytes } = await import('../src/ops/http.ts');
  const e = endless({ hang: true });
  const t0 = Date.now();
  await assert.rejects(() => getBytes('https://slow.test/f', { fetch: (async () => e.res()) as any, timeoutMs: 150, tries: 2, sleep: async () => {} }), /timed out \(headers and body within 150 ms\)/);
  assert.ok(Date.now() - t0 < 5000, 'within the two attempts, not whenever the server stops');
});

test('getBytes: a Content-Length above the limit is refused before a byte is read; an endless body stops at the limit', { timeout: 20_000 }, async () => {
  const { getBytes } = await import('../src/ops/http.ts');
  const declared = endless({ headers: { 'content-length': String(64 * 1024 * 1024 * 4) } });
  await assert.rejects(() => getBytes('https://big.test/f', { fetch: (async () => declared.res()) as any, maxBytes: 10_000, sleep: async () => {} }), /Content-Length 268435456 is more than 10000 bytes/);
  assert.equal(declared.st.cancelled, true, 'the body is cancelled, not read');
  assert.ok(declared.st.pulled <= 1000, js(declared.st));

  const flood = endless({ chunk: 1000 });
  let asked = 0;
  await assert.rejects(() => getBytes('https://big.test/f', { fetch: (async () => (asked++, flood.res())) as any, maxBytes: 10_000, sleep: async () => {} }), /more than 10000 bytes/);
  assert.equal(asked, 1, 'too large is not asked again');
  assert.ok(flood.st.pulled <= 12_000, `counted while streaming: ${flood.st.pulled} bytes handed out`);
  assert.equal(flood.st.cancelled, true);
});

test("getBytes: the caller's signal stops the download and every retry at once", { timeout: 20_000 }, async () => {
  const { getBytes } = await import('../src/ops/http.ts');
  const e = endless({ hang: true });
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(new Error('the deadline')), 100);
  const t0 = Date.now();
  await assert.rejects(() => getBytes('https://slow.test/f', { fetch: (async () => e.res()) as any, timeoutMs: 60_000, tries: 3, signal: ctl.signal }), /stopped \(the caller's deadline\)/);
  assert.ok(Date.now() - t0 < 5000);
  await assert.rejects(() => getBytes('https://slow.test/f', { fetch: (async () => assert.fail('asked after the deadline')) as any, signal: ctl.signal }), /stopped/);
});

test('getBytes: a 5xx is asked again, a 404 is not, and a good body comes back whole', async () => {
  const { getBytes, HttpError } = await import('../src/ops/http.ts');
  let n = 0;
  const b = await getBytes('https://ok.test/f', { fetch: (async () => (++n < 2 ? new Response('busy', { status: 503 }) : new Response(new Uint8Array([1, 2, 3]) as BodyInit, { status: 200 }))) as any, sleep: async () => {}, maxBytes: 3 });
  assert.deepEqual([...b], [1, 2, 3]);
  assert.equal(n, 2);
  let m = 0;
  await assert.rejects(() => getBytes('https://ok.test/f', { fetch: (async () => (m++, new Response('no', { status: 404 }))) as any, sleep: async () => {} }), (e: any) => e instanceof HttpError && e.status === 404);
  assert.equal(m, 1);
});
