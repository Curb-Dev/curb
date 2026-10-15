// One simulated deployment for the ops tests: the chain (sim/chain.ts) with
// one or more sharing launches, holders and income; the fake net
// (sim/net.ts); test keys; an ops config pointing at all of it; a clock the
// tests move; and build() to make the keeper / verifier / guardian context
// exactly as the CLI does, with the network and the signers injected.

import { keccak256, toHex } from 'viem';
import { SimChain, WETH } from './chain.ts';
import { FakeNet } from './net.ts';
import { parseOpsConfig, type OpsConfig } from '../../src/ops/config.ts';
import { build, type Built, type Mode } from '../../src/ops/runner.ts';
import { keySigner, type Signer } from '../../src/ops/tx.ts';
import { Secret } from '../../src/ops/secrets.ts';
import { memoryLogger } from '../../src/ops/log.ts';

export const testKey = (name: string): Secret => new Secret(`test:${name}`, keccak256(toHex(`curb-sharer test key: ${name}`)));

export interface WorldOptions {
  launches?: number;
  quote?: 'weth' | 'usdc';
  holders?: Record<string, bigint>;
  income0?: bigint;
  config?: (raw: any) => void;
  safeLag?: bigint;
}

export const HOLDERS = {
  alice: '0x00000000000000000000000000000000000a11ce',
  bob: '0x0000000000000000000000000000000000000b0b',
  carol: '0x00000000000000000000000000000000000ca401',
  dust: '0x000000000000000000000000000000000000d057',
};

export class Clock {
  t = 1_800_000_000_000;
  now = (): number => this.t;
}

export function opsWorld(o: WorldOptions = {}) {
  const sim = new SimChain();
  sim.setSafeLag(o.safeLag ?? 0n);
  const net = new FakeNet();
  const clock = new Clock();
  const signers: Record<'publisher' | 'pusher' | 'guardian' | 'thief', Signer> = {
    publisher: keySigner(testKey('publisher')),
    pusher: keySigner(testKey('pusher')),
    guardian: keySigner(testKey('guardian')),
    thief: keySigner(testKey('thief')),
  };
  const payee = '0x00000000000000000000000000000000000fee55';
  sim.state.factory.publisher = signers.publisher.address;
  sim.state.factory.keeperPayee = payee;
  sim.state.factory.vetoers.add(signers.guardian.address);
  sim.state.factory.vetoers.add(sim.state.factory.owner);
  for (const s of Object.values(signers)) sim.fund(s.address, 10n ** 18n);

  const quote = o.quote === 'usdc' ? sim.addr.usdc : WETH;
  const holders = o.holders ?? { [HOLDERS.alice]: 600n * 10n ** 18n, [HOLDERS.bob]: 300n * 10n ** 18n, [HOLDERS.carol]: 100n * 10n ** 18n, [HOLDERS.dust]: 10n ** 9n };
  const launches = [];
  for (let i = 0; i < (o.launches ?? 1); i++) {
    const D = '0x' + keccak256(toHex(`distributor ${i}`)).slice(26);
    const token = '0x' + keccak256(toHex(`token ${i}`)).slice(26);
    launches.push(sim.addLaunch({ D, token, quote, holders }));
  }
  sim.mine();
  for (const l of launches) sim.income(l.D, o.income0 ?? (quote === WETH ? 10n ** 18n : 2_000n * 10n ** 6n));
  sim.mine();

  const raw: any = {
    sharing: {
      chainId: '8453',
      graduator: sim.addr.graduator,
      graduatorFromBlock: '1000',
      weth: WETH,
      rules: { version: '1', exclusions: [], keeperKeys: [signers.publisher.address, signers.pusher.address], ammFactories: [] },
      feeds: { [sim.addr.usdc]: { ethUsd: sim.addr.ethUsd, quoteUsd: sim.addr.usdcUsd } },
    },
    distributorFactory: sim.addr.factory,
    catalog: sim.addr.catalog,
    ethUsdFeed: sim.addr.ethUsd,
    site: { base: 'https://site.test' },
    dataRepo: { owner: 'curb', repo: 'curb-sharing-data', branch: 'main', apiBase: 'https://api.github.test', rawBase: 'https://raw.github.test' },
    ipfs: { gateways: ['https://gw.test'], pinners: [{ kind: 'kubo', name: 'kubo', url: 'https://kubo.test' }, { kind: 'pinata', name: 'pinata', url: 'https://pinata.test', token: 'pinata' }], minPinned: 2 },
    keeper: { minEpochGapSec: 3600, stuckAfterSec: 30, receiptPollMs: 2000, safeWaitSec: 120, harvestFreshSec: 1800 },
    lease: { ttlSec: 600, standbyAfterSec: 2700, heartbeatEverySec: 900 },
    guardian: { vetoUnverifiedBeforeSec: 900 },
  };
  o.config?.(raw);
  const cfg: OpsConfig = parseOpsConfig(raw);

  const env = { CURB_SHARER_DATA_REPO_TOKEN: 'ghp-test-token-0123456789', CURB_SHARER_PIN_TOKENS: '{"pinata":"pinata-test-jwt-0123456789"}' } as Record<string, string>;

  /** A sleep that is time passing: the clock moves and the chain mines. A
   *  budget turns a loop that never ends into a failing test, not a hang. */
  let slept = 0;
  const sleep = async (ms: number): Promise<void> => {
    if (++slept > 3000) throw new Error('test budget: slept 3000 times - a wait that never ends');
    clock.t += ms;
    const blocks = Math.max(1, Math.floor(ms / 2000));
    for (let i = 0; i < blocks; i++) sim.mine();
  };

  const make = (mode: Mode, x: { role?: 'primary' | 'standby'; holder?: string; dataDir?: string | null; rpcs?: any[]; signers?: Partial<Record<'publisher' | 'pusher' | 'guardian', Signer>>; cfg?: OpsConfig } = {}): Built & { log: ReturnType<typeof memoryLogger> } => {
    const log = memoryLogger();
    const b = build({
      cfg: x.cfg ?? cfg,
      mode,
      dataDir: x.dataDir ?? null,
      secrets: { env, dir: '/nonexistent-secrets' },
      rpcs: x.rpcs ?? [sim.rpc('a'), sim.rpc('b')],
      fetch: net.fetch as any,
      log,
      now: clock.now,
      sleep,
      signers: x.signers ?? (mode === 'keeper' ? { publisher: signers.publisher, pusher: signers.pusher } : mode === 'guardian' ? { guardian: signers.guardian } : {}),
      sinks: [],
      role: x.role,
      holder: x.holder ?? `${mode}-${x.role ?? 'primary'}`,
      refetch: { tries: 2, delayMs: 1 },
    });
    return Object.assign(b, { log });
  };

  /** Moves both clocks: wall time and chain time (one block). */
  const pass = (sec: number): void => {
    clock.t += sec * 1000;
    sim.warp(sec);
    sim.mine();
  };

  /** Moves only the chain's clock (one block), not the wall clock. */
  const chainPass = (sec: number): void => {
    sim.warp(sec);
    sim.mine();
  };

  return { sim, net, clock, signers, payee, launches, holders, cfg, raw, env, make, sleep, pass, chainPass, quote };
}

export type OpsWorld = ReturnType<typeof opsWorld>;
