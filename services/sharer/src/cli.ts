#!/usr/bin/env node
// curb-sharer: one entry point for every mode (design D.2.1).
//
//   keeper   --loop [--interval=300] | --once [--standby]   publisher + pusher keys
//   verify   --loop | --once                                 signs nothing
//   verify   --distributor 0x.. --epoch N --rpc URL [--rpc URL2]
//            [--config FILE|URL] [--gateway URL]... [--site URL]   the public CLI
//   guardian --loop [--interval=60]                          the vetoer key
//   rebuild                                                  signs nothing
//   ack-veto --distributor 0x.. --epoch N [--by NAME] [--note TEXT]
//   check [--probe]                                          config, secrets, chain, wiring;
//                                                            --probe: write, pin, read back, alert
//   alert-test [--note TEXT]                                 one alert through every sink
//
//   --config FILE   (or CURB_SHARER_CONFIG)  the ops config (no secrets in it)
//   --data DIR      (or CURB_SHARER_DATA, default /data)
//   --health-port N (or CURB_SHARER_HEALTH_PORT, default 8080) for the loops;
//                   CURB_SHARER_HEALTH_GRACE_SEC: how long a starting loop
//                   counts as healthy before its first clean tick
//
// Exit codes: 0 done (or verified), 1 a failure or a mismatch, 2 bad usage or
// an epoch that could not be verified. alert-test: 0 every sink took the
// alert, 1 a sink failed, 2 no sink is configured.

import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { loadOpsConfig, parseOpsConfig, publicSharingConfig, sharingConfigFrom, ConfigError, type OpsConfig } from './ops/config.ts';
import { build, checkChain, checkSetup, loop, SetupError, type Mode } from './ops/runner.ts';
import { keeperTick } from './ops/keeper.ts';
import { watchTick } from './ops/verify.ts';
import { rebuild, verifyOne } from './ops/rebuild.ts';
import { writeAck } from './ops/acks.ts';
import { Health, healthServer, listen } from './ops/server.ts';
import { jsonLogger, errorText } from './ops/log.ts';
import { redact, readJsonSecret } from './ops/secrets.ts';
import { deliver, makeSinks, testAlert } from './ops/alerts.ts';
import { writeProbe } from './ops/writeprobe.ts';
import { ChainReader } from './chain/reader.ts';
import { httpRpc } from './chain/rpc.ts';
import { EpochFiles } from './ops/files.ts';
import { Store } from './ops/store.ts';
import { getBytes } from './ops/http.ts';

export interface Args {
  mode: string;
  flags: Map<string, string[]>;
}

export function parseArgs(argv: string[]): Args {
  const [mode = 'help', ...rest] = argv;
  const flags = new Map<string, string[]>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) throw new ConfigError(`unexpected argument ${a}`);
    const eq = a.indexOf('=');
    let k: string;
    let v: string;
    if (eq > 0) {
      k = a.slice(2, eq);
      v = a.slice(eq + 1);
    } else {
      k = a.slice(2);
      const nx = rest[i + 1];
      v = nx !== undefined && !nx.startsWith('--') ? (i++, nx) : 'true';
    }
    flags.set(k, [...(flags.get(k) ?? []), v]);
  }
  return { mode, flags };
}

const one = (a: Args, k: string): string | undefined => a.flags.get(k)?.at(-1);
const has = (a: Args, k: string): boolean => a.flags.has(k);

function allowed(a: Args, keys: string[]): void {
  for (const k of a.flags.keys()) if (!keys.includes(k)) throw new ConfigError(`${a.mode}: unknown option --${k}`);
}

const USAGE = `usage: curb-sharer <keeper|verify|guardian|rebuild|ack-veto|check|alert-test> [options]
  keeper   --loop [--interval=300] | --once [--standby]
  verify   --loop | --once
  verify   --distributor 0x.. --epoch N --rpc URL [--rpc URL] --config FILE|URL [--gateway URL] [--site URL]
  guardian --loop [--interval=60]
  rebuild
  ack-veto --distributor 0x.. --epoch N [--by NAME] [--note TEXT]
  check [--probe]
  alert-test [--note TEXT]
common: --config FILE  --data DIR  --health-port N  --single-provider (local rehearsal only)`;

async function loadConfigArg(a: Args): Promise<OpsConfig> {
  const p = one(a, 'config') ?? process.env.CURB_SHARER_CONFIG;
  if (!p) throw new ConfigError('no config: pass --config FILE or set CURB_SHARER_CONFIG');
  return loadOpsConfig(p);
}

export async function main(argv: string[], io: { out: (s: string) => void; err: (s: string) => void } = { out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') }): Promise<number> {
  let a: Args;
  try {
    a = parseArgs(argv);
  } catch (e) {
    io.err(errorText(e));
    io.err(USAGE);
    return 2;
  }
  const common = ['config', 'data', 'health-port', 'single-provider'];
  try {
    if (a.mode === 'help' || a.mode === '--help') {
      io.out(USAGE);
      return 0;
    }

    // ---- the public verifier: no secrets, no data dir needed
    if (a.mode === 'verify' && has(a, 'distributor')) {
      allowed(a, ['distributor', 'epoch', 'rpc', 'config', 'gateway', 'site', 'single-provider']);
      const d = one(a, 'distributor')!;
      const ep = one(a, 'epoch');
      const rpcs = a.flags.get('rpc') ?? [];
      if (!/^0x[0-9a-fA-F]{40}$/.test(d) || !ep || !/^[0-9]+$/.test(ep) || rpcs.length === 0) throw new ConfigError('verify needs --distributor 0x.. --epoch N --rpc URL');
      if (rpcs.length < 2 && !has(a, 'single-provider')) io.err('note: one --rpc given; the recompute trusts that one provider (give a second --rpc to compare two)');
      const src = one(a, 'config');
      let raw: unknown;
      if (!src) throw new ConfigError('verify needs --config: the published sharing config (sharing/<chain>/config.json on the site) or a file');
      if (/^https?:\/\//.test(src)) raw = JSON.parse(new TextDecoder().decode(await getBytes(src)));
      else raw = JSON.parse(readFileSync(src, 'utf8'));
      const { sharing } = sharingConfigFrom(raw);
      const readers = rpcs.map((u, i) => new ChainReader(httpRpc(u, { label: String.fromCharCode(97 + i) })));
      const files = new EpochFiles({ chainId: sharing.chainId, store: new Store(null), siteBase: one(a, 'site')?.replace(/\/+$/, '') ?? null, gateways: (a.flags.get('gateway') ?? ['https://ipfs.io', 'https://dweb.link']).map((g) => g.replace(/\/+$/, '')) });
      const res = await verifyOne({ readers, sharing, files, allowSingleProvider: rpcs.length < 2 }, d, BigInt(ep));
      io.out(res.text);
      return res.code;
    }

    // ---- one alert through every sink of this host: needs no config, no
    // chain and no key, only the alert_webhooks secret. Run on every host.
    if (a.mode === 'alert-test') {
      allowed(a, [...common, 'note']);
      const log = jsonLogger({ base: { svc: 'curb-sharer', mode: 'alert-test' } });
      const sinks = makeSinks(readJsonSecret('alert_webhooks'));
      if (!sinks.length) {
        io.err('NOT OK: no alert sink: set the alert_webhooks secret (RUNBOOK part 13)');
        return 2;
      }
      const res = await deliver(sinks, testAlert(hostname(), 'alert-test', new Date(), one(a, 'note')), log);
      for (const r of res) (r.ok ? io.out : io.err)(r.ok ? `${r.sink}: delivered` : `NOT OK: ${r.sink}: ${r.error}`);
      return res.every((r) => r.ok) ? 0 : 1;
    }

    const mode: Mode | null = a.mode === 'keeper' ? 'keeper' : a.mode === 'verify' ? 'verify' : a.mode === 'guardian' ? 'guardian' : a.mode === 'rebuild' ? 'rebuild' : a.mode === 'ack-veto' ? 'ack' : a.mode === 'check' ? 'check' : null;
    if (!mode) throw new ConfigError(`unknown mode ${a.mode}`);
    const extra: Record<Mode, string[]> = { keeper: ['loop', 'once', 'standby', 'interval'], verify: ['loop', 'once', 'interval'], guardian: ['loop', 'once', 'interval'], rebuild: [], ack: ['distributor', 'epoch', 'by', 'note'], check: ['print-public-config', 'probe'] };
    allowed(a, [...common, ...extra[mode]]);
    const isLoop = has(a, 'loop');
    if (['keeper', 'verify', 'guardian'].includes(mode) && isLoop === has(a, 'once')) throw new ConfigError(`${a.mode} needs exactly one of --loop and --once`);
    const cfg = await loadConfigArg(a);
    const dataDir = one(a, 'data') ?? process.env.CURB_SHARER_DATA ?? '/data';
    const standby = has(a, 'standby');
    const b = build({ cfg, mode, dataDir, allowSingleProvider: has(a, 'single-provider'), role: standby ? 'standby' : 'primary' });
    const { ctx, keys, lease } = b;
    const log = ctx.log;

    if (mode === 'check') {
      const c = await checkSetup(ctx);
      // --probe: the publishing path itself, with a file of its own (writeprobe.ts)
      if (has(a, 'probe')) {
        const p = await writeProbe(ctx, { host: b.holder });
        c.lines.push(...p.lines);
        c.problems.push(...p.problems);
      }
      for (const l of c.lines) io.out(l);
      if (c.problems.length) {
        for (const p of c.problems) io.err(`NOT OK: ${p}`);
        return 2;
      }
      io.out(`config ok; ${ctx.readers.length} providers on chain ${cfg.sharing.chainId}, head ${c.head}${has(a, 'probe') ? '; the write probe passed' : ''}`);
      if (has(a, 'print-public-config')) io.out(JSON.stringify(publicSharingConfig(cfg), null, 1));
      return 0;
    }
    await checkChain(ctx);

    if (mode === 'ack') {
      const d = one(a, 'distributor');
      const ep = one(a, 'epoch');
      if (!d || !/^0x[0-9a-fA-F]{40}$/.test(d) || !ep || !/^[0-9]+$/.test(ep)) throw new ConfigError('ack-veto needs --distributor 0x.. --epoch N');
      await writeAck(ctx, { distributor: d.toLowerCase(), epoch: ep, by: one(a, 'by') ?? 'operator', at: new Date().toISOString(), note: one(a, 'note') });
      io.out(`acknowledged the veto of epoch ${ep} of ${d.toLowerCase()}; the keeper may now recompute the reopened range`);
      return 0;
    }

    if (mode === 'rebuild') {
      const r = await rebuild(ctx);
      io.out(`rebuilt: ${r.distributors} distributors, ${r.files.filter((f) => f.ok).length}/${r.files.length} files checked, ${r.skips} refused pushes`);
      return r.files.every((f) => f.ok) ? 0 : 1;
    }

    const interval = Number(one(a, 'interval') ?? (mode === 'keeper' ? cfg.keeper.intervalSec : mode === 'guardian' ? cfg.guardian.intervalSec : cfg.verifier.intervalSec));
    if (!Number.isSafeInteger(interval) || interval < 5) throw new ConfigError('--interval must be at least 5 seconds');

    const runTick = async (): Promise<{ ok: boolean; error: string | null; status: Record<string, unknown> }> => {
      if (mode === 'keeper') {
        const rep = await keeperTick(ctx, keys, { lease, role: b.role, waitForSafe: !isLoop, holder: b.holder });
        return { ok: rep.ok, error: rep.errors[0] ?? null, status: { ...rep.status, actions: rep.actions, notes: rep.notes, errors: rep.errors } };
      }
      const rep = await watchTick(ctx, mode === 'guardian' ? keys.guardian : null);
      const bad = rep.results.filter((r) => r.verdict !== 'ok');
      return { ok: rep.ok && !rep.results.some((r) => r.verdict === 'mismatch'), error: rep.errors[0] ?? (bad[0] ? `${bad[0].distributor}#${bad[0].epoch} ${bad[0].verdict}` : null), status: { checked: rep.results.length, mismatches: bad.length, vetoed: rep.vetoed, froze: rep.froze, results: rep.results.map((x) => ({ distributor: x.distributor, epoch: x.epoch, verdict: x.verdict, reason: x.reason, problems: x.problems })), errors: rep.errors } };
    };

    if (!isLoop) {
      // A run by hand sees what the tick did, not only its alerts and exit code.
      const r = await runTick();
      io.out(JSON.stringify({ mode, ok: r.ok, error: r.error, ...r.status }, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
      return r.ok ? 0 : 1;
    }

    const grace = Number(process.env.CURB_SHARER_HEALTH_GRACE_SEC ?? '');
    const health = new Health({ intervalSec: interval, graceSec: Number.isFinite(grace) && grace > 0 ? grace : undefined });
    const srv = healthServer(health);
    const sock = process.env.CURB_SHARER_HEALTH_SOCKET;
    await listen(srv, sock ? { socket: sock } : { port: Number(one(a, 'health-port') ?? process.env.CURB_SHARER_HEALTH_PORT ?? 8080) });
    const ctl = new AbortController();
    const stop = () => {
      log.info('stopping after the current tick');
      ctl.abort();
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    log.info('started', { mode, interval, providers: ctx.readers.length, keys: Object.fromEntries(Object.entries(keys).filter(([, s]) => s).map(([k, s]) => [k, s!.address])) });
    await loop({
      intervalSec: interval,
      signal: ctl.signal,
      log,
      tick: async () => {
        try {
          const r = await runTick();
          health.tick(r.ok, r.error, r.status);
        } catch (e) {
          health.tick(false, errorText(e), {});
          throw e;
        }
      },
    });
    await new Promise<void>((r) => srv.close(() => r()));
    return 0;
  } catch (e) {
    if (e instanceof ConfigError || e instanceof SetupError) {
      io.err(redact(errorText(e)));
      return 2;
    }
    io.err(redact(errorText(e)));
    return 1;
  }
}

const isMain = (() => {
  try {
    return import.meta.url === new URL(`file://${process.argv[1]?.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1:')}`).href || process.argv[1]?.endsWith('cli.ts');
  } catch {
    return false;
  }
})();

if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(redact(errorText(e)) + '\n');
      process.exit(1);
    },
  );
}

export { parseOpsConfig, jsonLogger };
