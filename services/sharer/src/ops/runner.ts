// Wiring: the config file plus the secrets become an OpsContext, and the
// modes run as one tick (--once) or a loop (--loop) that stops cleanly on
// SIGTERM/SIGINT after the tick in progress.

import { hostname } from 'node:os';
import { join } from 'node:path';
import { encodeFunctionData } from 'viem';
import { defaultStateCache } from '../state-store.ts';
import { opsFactoryAbi } from './abis.ts';
import { ChainReader } from '../chain/reader.ts';
import { httpRpc, type Rpc } from '../chain/rpc.ts';
import { diffSharingConfig, type OpsConfig } from './config.ts';
import { checkWiring } from './wiring.ts';
import { Alerter, makeSinks, type AlertSink } from './alerts.ts';
import { EpochFiles } from './files.ts';
import { DataRepo, PublicRepo, type Denied } from './github.ts';
import type { Fetch } from './http.ts';
import { Lease } from './lease.ts';
import { jsonLogger, errorText, type Logger } from './log.ts';
import { makePinners, type Pinner } from './pinners.ts';
import { readJsonSecret, readKey, readRpcUrls, readSecret, Secret, type SecretSource } from './secrets.ts';
import { Store } from './store.ts';
import { keySigner, TxSender, type Signer } from './tx.ts';
import { MetaCache } from './chainview.ts';
import type { OpsContext, KeeperKeys } from './keeper.ts';

export type Mode = 'keeper' | 'verify' | 'guardian' | 'rebuild' | 'ack' | 'check';

export interface BuildOptions {
  cfg: OpsConfig;
  mode: Mode;
  dataDir: string | null;
  secrets?: SecretSource;
  /** Overrides for tests and for the public CLI (no secrets there). */
  rpcs?: Rpc[];
  fetch?: Fetch;
  log?: Logger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signers?: Partial<Record<'publisher' | 'pusher' | 'guardian', Signer>>;
  sinks?: AlertSink[];
  pinners?: Pinner[];
  allowSingleProvider?: boolean;
  holder?: string;
  role?: 'primary' | 'standby';
  refetch?: { tries: number; delayMs: number };
}

export interface Built {
  ctx: OpsContext;
  keys: KeeperKeys & { guardian: TxSender | null };
  lease: Lease;
  holder: string;
  role: 'primary' | 'standby';
}

export class SetupError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'SetupError';
  }
}

export function build(o: BuildOptions): Built {
  const cfg = o.cfg;
  const log = o.log ?? jsonLogger({ base: { svc: 'curb-sharer', mode: o.mode } });
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const src = o.secrets ?? {};
  const http = { fetch: o.fetch, sleep };

  // ---- providers: two (or more), labelled a, b, ... - never by URL
  let rpcs = o.rpcs;
  if (!rpcs) {
    const urls = readRpcUrls('rpc_urls', src);
    rpcs = urls.map((u, i) => httpRpc(u.reveal(), { label: String.fromCharCode(97 + i), fetch: o.fetch }));
  }
  if (rpcs.length === 0) throw new SetupError('no RPC provider: set the rpc_urls secret (two URLs from two different providers)');
  if (rpcs.length < 2 && !o.allowSingleProvider) throw new SetupError('one RPC provider given; two independent ones are required (every epoch is read from both and compared)');
  const readers = rpcs.map((r) => new ChainReader(r));

  const store = new Store(o.dataDir);
  // complete balance states between epochs, kept under /data too (state-store.ts)
  defaultStateCache.persistTo(o.dataDir ? join(o.dataDir, 'states') : null);
  const files = new EpochFiles({ chainId: cfg.sharing.chainId, store, siteBase: cfg.site?.base ?? null, gateways: cfg.ipfs.gateways, http });

  // ---- alerts. A host with no sink keeps every page in its own log: said at
  // start, and `check` refuses it.
  const sinks = o.sinks ?? makeSinks(readJsonSecret('alert_webhooks', src), http);
  const alerts = new Alerter({ sinks, store, log, cooldownSec: cfg.alerts.cooldownSec, now });
  if (!sinks.length && o.mode !== 'check') log.warn('no alert sink is configured: every alert stays in this log (set the alert_webhooks secret)');

  // ---- the data repo (publishing, lease, heartbeat, acks). The keeper needs
  // it; the guardian writes only its own heartbeat there, when given a token;
  // `check` uses it for the write probe. The verifier never writes it: it
  // reads the files through the site and the heartbeats through PublicRepo.
  let repo: DataRepo | null = null;
  if (cfg.dataRepo && ['keeper', 'ack', 'guardian', 'check'].includes(o.mode)) {
    const tok = readSecret('data_repo_token', src);
    if (!tok && (o.mode === 'keeper' || o.mode === 'ack')) throw new SetupError('config.dataRepo is set but the data_repo_token secret is not');
    const dr = cfg.dataRepo;
    // A refused token pages AT ONCE: nothing the keeper writes can land until
    // a person replaces it, and the standby cannot see the primary either.
    const onDenied = (d: Denied) =>
      alerts.raise(
        {
          key: 'data-repo-denied',
          severity: 'page',
          title: 'GitHub REFUSED the data repo token',
          text: `GitHub answered ${d.status} to ${d.what}: ${d.message || 'no message'}. The token has expired, was revoked, or lost contents:write on ${dr.owner}/${dr.repo}. Until it is replaced (a new fine-grained token in the data_repo_token secret of every host that holds it) nothing is published${o.mode === 'keeper' ? ', no heartbeat or lease is written, and the standby cannot see the primary' : ''}.`,
        },
        { cooldownSec: cfg.alerts.reminderSec },
      );
    if (tok) repo = new DataRepo({ ...dr, token: tok, fetch: o.fetch, sleep, onDenied });
  }
  const publicRepo = cfg.dataRepo && o.mode === 'verify' ? new PublicRepo({ ...cfg.dataRepo, fetch: o.fetch, sleep }) : null;

  // ---- pins (the keeper's, and `check --probe`'s: there each pinner whose
  // token is present, the others reported by the probe)
  let pinners: Pinner[] = o.pinners ?? [];
  if (!o.pinners && (o.mode === 'keeper' || o.mode === 'check') && cfg.ipfs.pinners.length) {
    let toks: Record<string, string> = {};
    try {
      toks = readJsonSecret<Record<string, string>>('pin_tokens', src) ?? {};
    } catch (e) {
      if (o.mode === 'keeper') throw e; // check reports a malformed secret itself
    }
    const boxed: Record<string, Secret> = {};
    for (const [k, v] of Object.entries(toks)) if (typeof v === 'string') boxed[k] = new Secret(`pin_tokens.${k}`, v);
    pinners = o.mode === 'keeper' ? makePinners(cfg.ipfs.pinners, boxed, http) : cfg.ipfs.pinners.flatMap((p) => (!p.token || boxed[p.token] ? makePinners([p], boxed, http) : []));
  }

  // ---- keys
  const settings = { chainId: cfg.sharing.chainId, maxGasPriceWei: cfg.keeper.maxGasPriceWei, stuckAfterSec: cfg.keeper.stuckAfterSec, maxReplacements: cfg.keeper.maxReplacements, receiptPollMs: cfg.keeper.receiptPollMs };
  const signerFor = (role: 'publisher' | 'pusher' | 'guardian'): Signer | null => {
    if (o.signers?.[role]) return o.signers[role]!;
    const k = readKey(`${role}_key`, src);
    return k ? keySigner(k) : null;
  };
  // The guardian key has its own gas-price cap: a veto must land inside its
  // hour even when somebody chose that hour for a gas spike, and it sends
  // nothing else (the keeper keys keep keeper.maxGasPriceWei).
  const sender = (role: 'publisher' | 'pusher' | 'guardian'): TxSender | null => {
    const s = signerFor(role);
    const own = role === 'guardian' ? { ...settings, maxGasPriceWei: cfg.guardian.maxGasPriceWei } : settings;
    return s ? new TxSender({ role, signer: s, readers, store, log, settings: own, sleep, now }) : null;
  };
  const keys = {
    publisher: o.mode === 'keeper' ? sender('publisher') : null,
    pusher: o.mode === 'keeper' ? sender('pusher') : null,
    guardian: o.mode === 'guardian' ? sender('guardian') : null,
  };
  if (o.mode === 'keeper' && !keys.pusher) throw new SetupError('keeper mode needs at least the pusher_key secret (and publisher_key to publish)');
  if (o.mode === 'guardian' && !keys.guardian) throw new SetupError('guardian mode needs the guardian_key secret (a vetoer key held apart from the keeper)');
  if (keys.publisher && keys.pusher && keys.publisher.address === keys.pusher.address) throw new SetupError('the publisher and the pusher must be different keys (one transaction in flight per key)');

  const role = o.role ?? 'primary';
  const holder = o.holder ?? (process.env.GITHUB_RUN_ID ? `gha-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}` : `${hostname()}-${process.pid}`);
  const lease = new Lease({ repo, holder, role, ttlSec: cfg.lease.ttlSec, log, now });
  const ctx: OpsContext = { cfg, readers, store, files, repo, publicRepo, holder, pinners, alerts, log, meta: new MetaCache(), now, sleep, allowSingleProvider: o.allowSingleProvider, refetch: o.refetch };
  return { ctx, keys, lease, holder, role };
}

/** The chain the providers serve must be the configured one. */
export async function checkChain(ctx: OpsContext): Promise<void> {
  for (const r of ctx.readers) {
    const id = await r.chainId();
    if (id !== ctx.cfg.sharing.chainId) throw new SetupError(`provider ${r.label} serves chain ${id}, the config says ${ctx.cfg.sharing.chainId}`);
  }
}

/** What `check` checks, before a keeper, verifier or guardian is started:
 *  the chain each provider serves; that the graduator, the distributor
 *  factory, the catalog, the registry, the hook and the lens are non-zero
 *  addresses with code on every provider, and that they are wired to each
 *  other, the owners and the launchers as the config says (wiring.ts);
 *  that the published sharing config of this rules version is this host's;
 *  that every provider runs an eth_call without `to` (the batch
 *  probe every epoch is read with); and which secrets this host holds - each
 *  key by its address, the data-repo token and every pin token the config
 *  names. A missing secret is reported, not refused: each host runs only some
 *  roles. A missing alert sink IS refused: every host pages. `problems` empty
 *  means the setup can start. */
export async function checkSetup(ctx: OpsContext, src: SecretSource = {}): Promise<{ lines: string[]; problems: string[]; head: bigint }> {
  const { cfg } = ctx;
  const lines: string[] = [];
  const problems: string[] = [];
  await checkChain(ctx);
  const head = (await ctx.readers[0].head('latest')).number;
  const addrs: [string, string | null, string][] = [
    ['sharing.graduator', cfg.sharing.graduator, ''],
    ['distributorFactory', cfg.distributorFactory, ''],
    ['catalog', cfg.catalog, ''],
    ['registry', cfg.registry, ' (its launchers and owner are not watched)'],
    ['hook', cfg.hook, " (the platform's recipient and fee are not watched)"],
    ['lens', cfg.lens, ' (launches stuck in Waiting are not watched)'],
  ];
  let addressesOk = true;
  for (const [name, a, unwatched] of addrs) {
    if (a === null) {
      lines.push(`${name}: not set${unwatched}`);
      continue;
    }
    if (/^0x0{40}$/i.test(a)) {
      problems.push(`${name} is the zero address`);
      addressesOk = false;
      continue;
    }
    for (const r of ctx.readers) {
      const code = await r.code(a, head);
      if (!code || code === '0x') {
        problems.push(`${name} ${a} has no code on provider ${r.label}`);
        addressesOk = false;
      }
    }
  }
  if (cfg.registry && !cfg.policyOwner) lines.push('policyOwner: not set (every ownership move pages, the planned handover too)');
  if (cfg.policyOwner && /^0x0{40}$/i.test(cfg.policyOwner)) problems.push('policyOwner is the zero address');
  for (const r of ctx.readers) {
    try {
      await r.callMany([{ to: cfg.distributorFactory, data: encodeFunctionData({ abi: opsFactoryAbi, functionName: 'frozen' }) }], head);
      lines.push(`provider ${r.label}: eth_call without "to" works`);
    } catch (e) {
      problems.push(`provider ${r.label} cannot run an eth_call without "to" (every epoch is read with one): ${errorText(e)}`);
    }
  }
  const keyAddr: Record<string, string> = {};
  for (const role of ['publisher', 'pusher', 'guardian']) {
    try {
      const k = readKey(`${role}_key`, src);
      if (k) keyAddr[role] = keySigner(k).address;
      lines.push(`${role}_key: ${keyAddr[role] ?? 'not set'}`);
    } catch (e) {
      problems.push(errorText(e));
    }
  }
  if (keyAddr.publisher && keyAddr.publisher === keyAddr.pusher) problems.push('the publisher and the pusher must be different keys');
  // the addresses belong together, and the keys to their roles (wiring.ts)
  if (addressesOk) {
    const w = await checkWiring(ctx, head, keyAddr);
    lines.push(...w.lines);
    problems.push(...w.problems);
  }
  if (cfg.dataRepo) lines.push(`data_repo_token: ${readSecret('data_repo_token', src) ? 'set' : 'not set (the keeper needs it)'}`);
  if (cfg.ipfs.pinners.some((p) => p.token)) {
    let toks: Record<string, unknown> = {};
    try {
      toks = readJsonSecret<Record<string, unknown>>('pin_tokens', src) ?? {};
    } catch (e) {
      problems.push(errorText(e));
    }
    for (const p of cfg.ipfs.pinners) if (p.token) lines.push(`pin_tokens.${p.token} (pinner ${p.name}): ${typeof toks[p.token] === 'string' && toks[p.token] ? 'set' : 'not set (the keeper needs it)'}`);
  }
  // THE SAME SHARING BLOCK AS EVERYONE ELSE. The published config of this
  // host's rules version must be this host's, every part of it (a feed
  // changes the epoch bytes as an exclusion does): a host out of step calls
  // honest roots wrong. The current config.json may lag a rules change
  // until the keeper's next epoch, so a difference there is only reported.
  const v = cfg.sharing.rules.version;
  const base = `sharing/${cfg.sharing.chainId}`;
  if (ctx.files.siteBase) {
    const read = async (rel: string): Promise<{ raw: unknown } | null> => {
      const b = await ctx.files.siteFile(rel);
      if (!b) return null;
      try {
        return { raw: JSON.parse(new TextDecoder().decode(b)) };
      } catch {
        return { raw: null };
      }
    };
    try {
      const pv = await read(`${base}/config-v${v}.json`);
      if (!pv) lines.push(`published ${base}/config-v${v}.json: none yet (the keeper writes it with the first epoch under rules version ${v})`);
      else {
        const d = diffSharingConfig(pv.raw, cfg);
        if (d.length) problems.push(`this host's sharing block differs from the published ${base}/config-v${v}.json under the same rules version ${v}: ${d.join('; ')}. Every host must hold the same one; a change needs a new rules version, made everywhere at once (RUNBOOK part 7.1)`);
        else lines.push(`published ${base}/config-v${v}.json: the same as this host's`);
      }
      const pc = await read(`${base}/config.json`);
      if (pc) {
        const d = diffSharingConfig(pc.raw, cfg);
        lines.push(d.length ? `the published ${base}/config.json differs from this host's: ${d.join('; ')} (just after a rules change that is expected until the keeper's next epoch)` : `published ${base}/config.json: the same as this host's`);
      }
    } catch (e) {
      lines.push(`the published sharing config could not be read from the site: ${errorText(e)}`);
    }
  }

  // EVERY HOST NEEDS SOMEWHERE TO PAGE: without a sink each alert is only a
  // line in this host's own log. `alert-test` proves the sinks deliver.
  const sinks = ctx.alerts.sinkNames;
  if (sinks.length) lines.push(`alert sinks: ${sinks.join(', ')} (prove them with alert-test)`);
  else problems.push("no alert sink: set the alert_webhooks secret (RUNBOOK part 13); without one every PAGE stays in this host's log");
  return { lines, problems, head };
}

/** Runs `tick` every intervalSec until stopped. A tick that throws is logged
 *  and the loop goes on; the interval counts from the start of each tick. */
export async function loop(o: { intervalSec: number; tick: () => Promise<void>; signal: AbortSignal; log: Logger; now?: () => number; sleep?: (ms: number, signal: AbortSignal) => Promise<void> }): Promise<void> {
  const now = o.now ?? Date.now;
  const sleep =
    o.sleep ??
    ((ms: number, signal: AbortSignal) =>
      new Promise<void>((r) => {
        const t = setTimeout(r, ms);
        signal.addEventListener('abort', () => {
          clearTimeout(t);
          r();
        }, { once: true });
      }));
  while (!o.signal.aborted) {
    const start = now();
    try {
      await o.tick();
    } catch (e) {
      o.log.error('tick threw', { error: errorText(e) });
    }
    const wait = o.intervalSec * 1000 - (now() - start);
    if (wait > 0 && !o.signal.aborted) await sleep(wait, o.signal);
  }
  o.log.info('stopped');
}
