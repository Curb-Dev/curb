// The ops configuration: one JSON file with no secrets in it (secrets.ts reads
// those), checked strictly - an unknown key is refused, so a typo cannot
// silently fall back to a default. Every address is checked and lowercased;
// wei amounts are decimal strings; durations are seconds.
//
// The `sharing` block is the CURB-SHARE v1 configuration (SharerConfig) the
// keeper, the verifier and the guardian must share byte for byte: it decides
// the exclusions, the keeper keys, the AMM factories and the feeds. It is the
// part `publicSharingConfig()` writes to the data repo for outside verifiers.

import { readFileSync } from 'node:fs';
import type { SharerConfig } from '../epoch.ts';
import { checkConfig } from '../epoch.ts';
import type { Address } from '../calc/types.ts';

export class ConfigError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ConfigError';
  }
}

export type PinnerConfig =
  | { kind: 'kubo'; name: string; url: string; token: string | null }
  | { kind: 'pinata'; name: string; url: string; token: string }
  | { kind: 'psa'; name: string; url: string; token: string };

export interface KeeperSettings {
  intervalSec: number;
  minEpochGapSec: number;
  maxEpochWaitSec: number;
  minPotFactor: bigint;
  /** $0.05 as micro-dollars. */
  pushUsdFloorMicros: bigint;
  pushCostFactor: bigint;
  dustCostFactor: bigint;
  dustZeroSec: number;
  skipRetrySec: number;
  skipGrowth: bigint;
  maxLeavesPerPush: number;
  maxPushGas: bigint;
  maxGasPriceWei: bigint;
  pushMaxGasPriceWei: bigint;
  stuckAfterSec: number;
  maxReplacements: number;
  receiptPollMs: number;
  safeWaitSec: number;
  harvestFreshSec: number;
  lowEthWei: bigint;
  stalledAfterSec: number;
  /** Page when no tick has finished cleanly for this long (liveness.ts). */
  failingAfterSec: number;
  /** Launches stuck in Waiting (graduation.ts): how often the lens is read,
   *  and whether the keeper sends the permissionless graduate() itself. */
  graduationScanSec: number;
  completeGraduations: boolean;
  payKeeperMinFactor: bigint;
  /** Page when an epoch file reaches this many bytes, or this many accounts
   *  or leaves: long before the read-back limit (files.ts MAX_FILE_BYTES),
   *  past which nobody can read the file and the launch's payouts stop. */
  largeFileBytes: number;
  largeFileAccounts: number;
  /** Estimates for thresholds and MIN_POT only (every send is sized by
   *  eth_estimateGas). Defaults from the live fork run: harvest 266k, the
   *  first publish of a root 244k, activate 156k, push 241k for 3 first
   *  payouts (ETH), payKeeper 102k. */
  gas: { publishPerRoot: bigint; activate: bigint; pushBase: bigint; pushFirstLeaf: bigint; pushRepeatLeaf: bigint; payKeeper: bigint; harvest: bigint };
}

export interface OpsConfig {
  sharing: SharerConfig;
  distributorFactory: Address;
  catalog: Address | null;
  /** The LaunchRegistry and the FeeHook: their admin events are watched
   *  (events.ts) and their wiring checked (`check`). */
  registry: Address | null;
  hook: Address | null;
  /** The LaunchLens: every launch's state, for the Waiting watch. */
  lens: Address | null;
  /** The owner Safe (DeployCurb's CURB_POLICY_OWNER): an ownership move to it
   *  is the planned handover, to anyone else a page. */
  policyOwner: Address | null;
  /** Every launcher factory the deployment admitted (the site's CANONICAL):
   *  a LauncherSet for any other address pages. */
  launchers: Address[];
  /** ETH/USD for the push floor on WETH launches (and the alert of a missing price). */
  ethUsdFeed: Address | null;
  site: { base: string } | null;
  /** `rawBase` serves the public repo's files without a token: the verifiers
   *  read the heartbeats through it (liveness.ts). */
  dataRepo: { owner: string; repo: string; branch: string; root: string; apiBase: string; rawBase: string } | null;
  ipfs: { gateways: string[]; pinners: PinnerConfig[]; minPinned: number };
  keeper: KeeperSettings;
  /** blockedAfterSec: how long another holder may keep the lease from this
   *  keeper before its ticks count as failing (keeper.ts). */
  lease: { ttlSec: number; standbyAfterSec: number; heartbeatEverySec: number; blockedAfterSec: number };
  /** checkTimeoutSec bounds one root's check and passTimeoutSec the checks
   *  of one pass (verify.ts); an unverifiable root is vetoed
   *  vetoUnverifiedAfterSec after it was first found so, or in the last
   *  vetoUnverifiedBeforeSec of its hour; freezeAtBadRoots pending roots to
   *  veto at once freeze first (0: off for each of the three);
   *  maxGasPriceWei is the guardian key's own cap, for vetoes and freezes
   *  only. */
  guardian: { intervalSec: number; vetoUnverifiedBeforeSec: number; vetoUnverifiedAfterSec: number; freezeAtBadRoots: number; freezeOnRepeat: boolean; repeatWindowSec: number; failingAfterSec: number; lowEthWei: bigint; checkTimeoutSec: number; passTimeoutSec: number; maxGasPriceWei: bigint };
  /** keeperSilentAfterSec: page when neither keeper has had a clean tick for
   *  this long; guardianSilentAfterSec: the same for the guardian (0: off). */
  verifier: { intervalSec: number; failingAfterSec: number; keeperSilentAfterSec: number; guardianSilentAfterSec: number };
  alerts: { cooldownSec: number; reminderSec: number };
  /** Where event scans start when the cache has no position (default: the Graduator's block). */
  eventsFromBlock: bigint;
}

type J = Record<string, unknown>;

const isObj = (x: unknown): x is J => !!x && typeof x === 'object' && !Array.isArray(x);

function only(o: J, keys: string[], where: string): void {
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new ConfigError(`${where}: unknown key "${k}"`);
}

function addr(x: unknown, where: string): Address {
  if (typeof x !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(x)) throw new ConfigError(`${where} is not an address: ${String(x)}`);
  return x.toLowerCase();
}

function big(x: unknown, where: string, dflt?: bigint): bigint {
  if (x === undefined && dflt !== undefined) return dflt;
  if (typeof x === 'string' && /^[0-9]+$/.test(x)) return BigInt(x);
  if (typeof x === 'number' && Number.isSafeInteger(x) && x >= 0) return BigInt(x);
  throw new ConfigError(`${where} must be a non-negative integer (a decimal string for large values): ${String(x)}`);
}

function int(x: unknown, where: string, dflt: number, min = 0): number {
  if (x === undefined) return dflt;
  if (typeof x !== 'number' || !Number.isSafeInteger(x) || x < min) throw new ConfigError(`${where} must be an integer >= ${min}: ${String(x)}`);
  return x;
}

function bool(x: unknown, where: string, dflt: boolean): boolean {
  if (x === undefined) return dflt;
  if (typeof x !== 'boolean') throw new ConfigError(`${where} must be true or false`);
  return x;
}

function url(x: unknown, where: string): string {
  if (typeof x !== 'string' || !/^https?:\/\/[^\s]+$/.test(x)) throw new ConfigError(`${where} must be an http(s) URL`);
  if (/@/.test(x.split('/')[2] ?? '')) throw new ConfigError(`${where} carries credentials; put them in a secret instead`);
  return x.replace(/\/+$/, '');
}

function usd(x: unknown, where: string, dflt: string): bigint {
  const s = x === undefined ? dflt : x;
  if (typeof s !== 'string' || !/^[0-9]+(\.[0-9]{1,6})?$/.test(s)) throw new ConfigError(`${where} must be a dollar amount like "0.05"`);
  const [i, f = ''] = s.split('.');
  return BigInt(i) * 1_000_000n + BigInt((f + '000000').slice(0, 6));
}

function name(x: unknown, where: string): string {
  if (typeof x !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(x)) throw new ConfigError(`${where} must be a short lowercase name`);
  return x;
}

export function parseOpsConfig(raw: unknown): OpsConfig {
  if (!isObj(raw)) throw new ConfigError('the config must be a JSON object');
  only(raw, ['sharing', 'distributorFactory', 'catalog', 'registry', 'hook', 'lens', 'policyOwner', 'launchers', 'ethUsdFeed', 'site', 'dataRepo', 'ipfs', 'keeper', 'lease', 'guardian', 'verifier', 'alerts', 'eventsFromBlock', '$comment'], 'config');

  // ---- the CURB-SHARE v1 part
  const s = raw.sharing;
  if (!isObj(s)) throw new ConfigError('config.sharing is missing');
  only(s, ['chainId', 'graduator', 'graduatorFromBlock', 'weth', 'rules', 'feeds'], 'config.sharing');
  const r = s.rules;
  if (!isObj(r)) throw new ConfigError('config.sharing.rules is missing');
  only(r, ['version', 'exclusions', 'keeperKeys', 'ammFactories'], 'config.sharing.rules');
  const list = (x: unknown, where: string): unknown[] => {
    if (!Array.isArray(x)) throw new ConfigError(`${where} must be a list`);
    return x;
  };
  const reasoned = (x: unknown, where: string) =>
    list(x, where).map((e, i) => {
      if (!isObj(e)) throw new ConfigError(`${where}[${i}] must be {address, reason}`);
      only(e, ['address', 'reason'], `${where}[${i}]`);
      if (typeof e.reason !== 'string' || !e.reason) throw new ConfigError(`${where}[${i}].reason is missing`);
      return { address: addr(e.address, `${where}[${i}].address`), reason: e.reason };
    });
  const feedsRaw = s.feeds ?? {};
  if (!isObj(feedsRaw)) throw new ConfigError('config.sharing.feeds must be an object');
  const feeds: SharerConfig['feeds'] = {};
  for (const [k, v] of Object.entries(feedsRaw)) {
    if (!isObj(v)) throw new ConfigError(`config.sharing.feeds[${k}] must be {ethUsd, quoteUsd}`);
    only(v, ['ethUsd', 'quoteUsd'], `config.sharing.feeds[${k}]`);
    feeds[k] = { ethUsd: v.ethUsd as string, quoteUsd: v.quoteUsd as string };
  }
  let sharing: SharerConfig = {
    chainId: big(s.chainId, 'config.sharing.chainId'),
    graduator: s.graduator as string,
    graduatorFromBlock: big(s.graduatorFromBlock, 'config.sharing.graduatorFromBlock'),
    weth: (s.weth ?? '0x4200000000000000000000000000000000000006') as string,
    rules: {
      version: big(r.version, 'config.sharing.rules.version'),
      exclusions: reasoned(r.exclusions ?? [], 'config.sharing.rules.exclusions'),
      keeperKeys: list(r.keeperKeys ?? [], 'config.sharing.rules.keeperKeys').map((k, i) => addr(k, `config.sharing.rules.keeperKeys[${i}]`)),
      ammFactories: reasoned(r.ammFactories ?? [], 'config.sharing.rules.ammFactories'),
    },
    feeds,
  };
  try {
    sharing = checkConfig(sharing);
  } catch (e) {
    throw new ConfigError((e as Error).message);
  }

  // ---- where things are
  const site = raw.site === undefined || raw.site === null ? null : (() => {
    if (!isObj(raw.site)) throw new ConfigError('config.site must be {base}');
    only(raw.site, ['base'], 'config.site');
    return { base: url(raw.site.base, 'config.site.base') };
  })();
  const dataRepo = raw.dataRepo === undefined || raw.dataRepo === null ? null : (() => {
    const d = raw.dataRepo;
    if (!isObj(d)) throw new ConfigError('config.dataRepo must be {owner, repo, branch}');
    only(d, ['owner', 'repo', 'branch', 'root', 'apiBase', 'rawBase'], 'config.dataRepo');
    const seg = (x: unknown, w: string) => {
      if (typeof x !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(x)) throw new ConfigError(`${w} is not a GitHub name`);
      return x;
    };
    const root = d.root === undefined ? '' : String(d.root);
    if (root && (!/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*\/$/.test(root) || root.split('/').some((x) => x === '.' || x === '..'))) throw new ConfigError('config.dataRepo.root must be a relative directory ending in /');
    return {
      owner: seg(d.owner, 'config.dataRepo.owner'),
      repo: seg(d.repo, 'config.dataRepo.repo'),
      branch: seg(d.branch ?? 'main', 'config.dataRepo.branch'),
      root,
      apiBase: d.apiBase === undefined ? 'https://api.github.com' : url(d.apiBase, 'config.dataRepo.apiBase'),
      rawBase: d.rawBase === undefined ? 'https://raw.githubusercontent.com' : url(d.rawBase, 'config.dataRepo.rawBase'),
    };
  })();

  const ip = raw.ipfs ?? {};
  if (!isObj(ip)) throw new ConfigError('config.ipfs must be an object');
  only(ip, ['gateways', 'pinners', 'minPinned'], 'config.ipfs');
  const gateways = list(ip.gateways ?? [], 'config.ipfs.gateways').map((g, i) => url(g, `config.ipfs.gateways[${i}]`));
  const pinners: PinnerConfig[] = list(ip.pinners ?? [], 'config.ipfs.pinners').map((p, i) => {
    const w = `config.ipfs.pinners[${i}]`;
    if (!isObj(p)) throw new ConfigError(`${w} must be an object`);
    only(p, ['kind', 'name', 'url', 'token'], w);
    const nm = name(p.name ?? p.kind, `${w}.name`);
    const tok = p.token === undefined || p.token === null ? null : name(p.token, `${w}.token`);
    if (p.kind === 'kubo') return { kind: 'kubo', name: nm, url: url(p.url, `${w}.url`), token: tok };
    if (p.kind === 'pinata') {
      if (!tok) throw new ConfigError(`${w}.token must name the pin_tokens entry holding the Pinata JWT`);
      return { kind: 'pinata', name: nm, url: p.url === undefined ? 'https://uploads.pinata.cloud' : url(p.url, `${w}.url`), token: tok };
    }
    if (p.kind === 'psa') {
      if (!tok) throw new ConfigError(`${w}.token must name the pin_tokens entry`);
      return { kind: 'psa', name: nm, url: url(p.url, `${w}.url`), token: tok };
    }
    throw new ConfigError(`${w}.kind must be kubo, pinata or psa`);
  });
  if (new Set(pinners.map((p) => p.name)).size !== pinners.length) throw new ConfigError('config.ipfs.pinners names must differ');
  const minPinned = int(ip.minPinned, 'config.ipfs.minPinned', Math.min(2, pinners.filter((p) => p.kind !== 'psa').length), 0);
  if (minPinned > pinners.filter((p) => p.kind !== 'psa').length) throw new ConfigError('config.ipfs.minPinned is more than the uploading pinners configured');

  // ---- the keeper
  const k = raw.keeper ?? {};
  if (!isObj(k)) throw new ConfigError('config.keeper must be an object');
  const KK = ['intervalSec', 'minEpochGapSec', 'maxEpochWaitSec', 'minPotFactor', 'pushUsdFloor', 'pushCostFactor', 'dustCostFactor', 'dustZeroDays', 'skipRetryDays', 'skipGrowth', 'maxLeavesPerPush', 'maxPushGas', 'maxGasPriceWei', 'pushMaxGasPriceWei', 'stuckAfterSec', 'maxReplacements', 'receiptPollMs', 'safeWaitSec', 'harvestFreshSec', 'lowEthWei', 'stalledAfterSec', 'failingAfterSec', 'graduationScanSec', 'completeGraduations', 'payKeeperMinFactor', 'largeFileBytes', 'largeFileAccounts', 'gas'];
  only(k, KK, 'config.keeper');
  const g = k.gas ?? {};
  if (!isObj(g)) throw new ConfigError('config.keeper.gas must be an object');
  only(g, ['publishPerRoot', 'activate', 'pushBase', 'pushFirstLeaf', 'pushRepeatLeaf', 'payKeeper', 'harvest'], 'config.keeper.gas');
  const keeper: KeeperSettings = {
    intervalSec: int(k.intervalSec, 'config.keeper.intervalSec', 300, 10),
    minEpochGapSec: int(k.minEpochGapSec, 'config.keeper.minEpochGapSec', 3600, 0),
    maxEpochWaitSec: int(k.maxEpochWaitSec, 'config.keeper.maxEpochWaitSec', 7 * 86400, 0),
    minPotFactor: big(k.minPotFactor, 'config.keeper.minPotFactor', 50n),
    pushUsdFloorMicros: usd(k.pushUsdFloor, 'config.keeper.pushUsdFloor', '0.05'),
    pushCostFactor: big(k.pushCostFactor, 'config.keeper.pushCostFactor', 25n),
    dustCostFactor: big(k.dustCostFactor, 'config.keeper.dustCostFactor', 2n),
    dustZeroSec: int(k.dustZeroDays, 'config.keeper.dustZeroDays', 30) * 86400,
    skipRetrySec: int(k.skipRetryDays, 'config.keeper.skipRetryDays', 30) * 86400,
    skipGrowth: big(k.skipGrowth, 'config.keeper.skipGrowth', 10n),
    maxLeavesPerPush: int(k.maxLeavesPerPush, 'config.keeper.maxLeavesPerPush', 200, 1),
    maxPushGas: big(k.maxPushGas, 'config.keeper.maxPushGas', 8_000_000n),
    maxGasPriceWei: big(k.maxGasPriceWei, 'config.keeper.maxGasPriceWei', 1_000_000_000n),
    pushMaxGasPriceWei: big(k.pushMaxGasPriceWei, 'config.keeper.pushMaxGasPriceWei', 100_000_000n),
    stuckAfterSec: int(k.stuckAfterSec, 'config.keeper.stuckAfterSec', 120, 1),
    maxReplacements: int(k.maxReplacements, 'config.keeper.maxReplacements', 5, 0),
    receiptPollMs: int(k.receiptPollMs, 'config.keeper.receiptPollMs', 2000, 1),
    safeWaitSec: int(k.safeWaitSec, 'config.keeper.safeWaitSec', 900, 0),
    harvestFreshSec: int(k.harvestFreshSec, 'config.keeper.harvestFreshSec', 1800, 0),
    lowEthWei: big(k.lowEthWei, 'config.keeper.lowEthWei', 5_000_000_000_000_000n),
    stalledAfterSec: int(k.stalledAfterSec, 'config.keeper.stalledAfterSec', 86400, 0),
    // 30 minutes: six failed ticks at the default interval, and before the
    // standby takes over (45 minutes), so the operator hears it first
    failingAfterSec: int(k.failingAfterSec, 'config.keeper.failingAfterSec', 1800, 0),
    // every 10 minutes: one lens read per 50 launches; a launch in Waiting
    // can be neither bought nor sold, so it should not wait long
    graduationScanSec: int(k.graduationScanSec, 'config.keeper.graduationScanSec', 600, 60),
    // graduate() is permissionless and costs the pusher one transaction's gas
    completeGraduations: bool(k.completeGraduations, 'config.keeper.completeGraduations', true),
    payKeeperMinFactor: big(k.payKeeperMinFactor, 'config.keeper.payKeeperMinFactor', 2n),
    // 8 MiB or 50,000 accounts: an eighth of the 64 MiB read-back limit, so a
    // file grown by a dust spray pages while there is time to act
    largeFileBytes: int(k.largeFileBytes, 'config.keeper.largeFileBytes', 8 * 1024 * 1024, 1),
    largeFileAccounts: int(k.largeFileAccounts, 'config.keeper.largeFileAccounts', 50_000, 1),
    gas: {
      publishPerRoot: big(g.publishPerRoot, 'config.keeper.gas.publishPerRoot', 250_000n),
      activate: big(g.activate, 'config.keeper.gas.activate', 160_000n),
      pushBase: big(g.pushBase, 'config.keeper.gas.pushBase', 60_000n),
      pushFirstLeaf: big(g.pushFirstLeaf, 'config.keeper.gas.pushFirstLeaf', 75_000n),
      pushRepeatLeaf: big(g.pushRepeatLeaf, 'config.keeper.gas.pushRepeatLeaf', 25_000n),
      payKeeper: big(g.payKeeper, 'config.keeper.gas.payKeeper', 110_000n),
      harvest: big(g.harvest, 'config.keeper.gas.harvest', 300_000n),
    },
  };
  if (keeper.pushMaxGasPriceWei > keeper.maxGasPriceWei) throw new ConfigError('config.keeper.pushMaxGasPriceWei is above maxGasPriceWei');

  const l = raw.lease ?? {};
  if (!isObj(l)) throw new ConfigError('config.lease must be an object');
  only(l, ['ttlSec', 'standbyAfterSec', 'heartbeatEverySec', 'blockedAfterSec'], 'config.lease');
  const ttlSec = int(l.ttlSec, 'config.lease.ttlSec', 600, 30);
  const lease = {
    ttlSec,
    standbyAfterSec: int(l.standbyAfterSec, 'config.lease.standbyAfterSec', 2700, 60),
    heartbeatEverySec: int(l.heartbeatEverySec, 'config.lease.heartbeatEverySec', 900, 10),
    // one standby run (the workflow's 20-minute timeout) plus the TTL: an
    // honest holder never keeps the lease from the primary longer than that
    blockedAfterSec: int(l.blockedAfterSec, 'config.lease.blockedAfterSec', 1200 + ttlSec, 0),
  };
  if (lease.heartbeatEverySec * 2 > lease.standbyAfterSec) throw new ConfigError('config.lease.standbyAfterSec must be at least twice heartbeatEverySec, or the standby takes over from a live primary');
  if (lease.blockedAfterSec < lease.ttlSec) throw new ConfigError('config.lease.blockedAfterSec must be at least config.lease.ttlSec, or one honest lease counts as a blocked keeper');

  const gu = raw.guardian ?? {};
  if (!isObj(gu)) throw new ConfigError('config.guardian must be an object');
  only(gu, ['intervalSec', 'vetoUnverifiedBeforeSec', 'vetoUnverifiedAfterSec', 'freezeAtBadRoots', 'freezeOnRepeat', 'repeatWindowDays', 'failingAfterSec', 'lowEthWei', 'checkTimeoutSec', 'passTimeoutSec', 'maxGasPriceWei'], 'config.guardian');
  const guardian = {
    intervalSec: int(gu.intervalSec, 'config.guardian.intervalSec', 60, 5),
    vetoUnverifiedBeforeSec: int(gu.vetoUnverifiedBeforeSec, 'config.guardian.vetoUnverifiedBeforeSec', 900, 0),
    // ten minutes: an honest keeper reads its copies back before it
    // publishes, so a root unverifiable for that long is not a passing
    // hiccup, and its veto is not left to the hour's last minutes, when a
    // publisher holding a stolen key may have queued many more behind it
    vetoUnverifiedAfterSec: int(gu.vetoUnverifiedAfterSec, 'config.guardian.vetoUnverifiedAfterSec', 600, 0),
    // three: one or two wrong roots are vetoed one by one at once; more at
    // once is either an attack meant to outrun the guardian or a failure
    // of its own, and a freeze holds every pending root while it catches up
    freezeAtBadRoots: int(gu.freezeAtBadRoots, 'config.guardian.freezeAtBadRoots', 3, 0),
    freezeOnRepeat: bool(gu.freezeOnRepeat, 'config.guardian.freezeOnRepeat', true),
    repeatWindowSec: int(gu.repeatWindowDays, 'config.guardian.repeatWindowDays', 30) * 86400,
    // 10 minutes: a blind guardian is found well inside a root's veto hour
    failingAfterSec: int(gu.failingAfterSec, 'config.guardian.failingAfterSec', 600, 0),
    // 0.005 ETH, the keeper keys' threshold (RUNBOOK 3.3): many vetoes' gas
    lowEthWei: big(gu.lowEthWei, 'config.guardian.lowEthWei', 5_000_000_000_000_000n),
    // two minutes for one root (its copies, its file, the recompute); five
    // for the checks of a pass, counted from the first one (reading the
    // roots and sending what is owed come before, outside it): the URI is
    // the publisher's choice, so a copy that never finishes arriving must
    // not hold back the next root's veto
    checkTimeoutSec: int(gu.checkTimeoutSec, 'config.guardian.checkTimeoutSec', 120, 1),
    passTimeoutSec: int(gu.passTimeoutSec, 'config.guardian.passTimeoutSec', 300, 1),
    // 100 gwei: a veto is ~100k gas, and the hour it must land in may be
    // the one somebody chose for a gas spike; the keeper keys keep their cap
    maxGasPriceWei: big(gu.maxGasPriceWei, 'config.guardian.maxGasPriceWei', 100_000_000_000n),
  };
  if (guardian.checkTimeoutSec > guardian.passTimeoutSec) throw new ConfigError('config.guardian.checkTimeoutSec must not be more than config.guardian.passTimeoutSec');
  // A late veto must land inside the window: a pass that starts in it, and
  // the next one, both end in it.
  if (guardian.vetoUnverifiedBeforeSec > 0 && 2 * guardian.passTimeoutSec > guardian.vetoUnverifiedBeforeSec) throw new ConfigError('config.guardian.passTimeoutSec must be at most half of config.guardian.vetoUnverifiedBeforeSec, or a late veto may not land in time');
  const ve = raw.verifier ?? {};
  if (!isObj(ve)) throw new ConfigError('config.verifier must be an object');
  only(ve, ['intervalSec', 'failingAfterSec', 'keeperSilentAfterSec', 'guardianSilentAfterSec'], 'config.verifier');
  const verifier = {
    intervalSec: int(ve.intervalSec, 'config.verifier.intervalSec', 300, 5),
    failingAfterSec: int(ve.failingAfterSec, 'config.verifier.failingAfterSec', 1800, 0),
    // twice the standby's takeover age: the primary silent AND a standby that
    // has not taken over (or fails too) by then is no keeper at all
    keeperSilentAfterSec: int(ve.keeperSilentAfterSec, 'config.verifier.keeperSilentAfterSec', 2 * lease.standbyAfterSec, 60),
    guardianSilentAfterSec: int(ve.guardianSilentAfterSec, 'config.verifier.guardianSilentAfterSec', 1800, 0),
  };
  if (verifier.keeperSilentAfterSec <= lease.standbyAfterSec) throw new ConfigError('config.verifier.keeperSilentAfterSec must be more than config.lease.standbyAfterSec, or a primary the standby is about to replace pages as if no keeper ran');
  const al = raw.alerts ?? {};
  if (!isObj(al)) throw new ConfigError('config.alerts must be an object');
  only(al, ['cooldownSec', 'reminderSec'], 'config.alerts');

  const optAddr = (x: unknown, where: string): Address | null => (x === undefined || x === null ? null : addr(x, where));
  const launchers = (raw.launchers === undefined ? [] : (() => {
    if (!Array.isArray(raw.launchers)) throw new ConfigError('config.launchers must be a list of addresses');
    return raw.launchers.map((x, i) => addr(x, `config.launchers[${i}]`));
  })()) as Address[];
  if (new Set(launchers).size !== launchers.length) throw new ConfigError('config.launchers lists an address twice');

  return {
    sharing,
    distributorFactory: addr(raw.distributorFactory, 'config.distributorFactory'),
    catalog: optAddr(raw.catalog, 'config.catalog'),
    registry: optAddr(raw.registry, 'config.registry'),
    hook: optAddr(raw.hook, 'config.hook'),
    lens: optAddr(raw.lens, 'config.lens'),
    policyOwner: optAddr(raw.policyOwner, 'config.policyOwner'),
    launchers,
    ethUsdFeed: raw.ethUsdFeed === undefined || raw.ethUsdFeed === null ? null : addr(raw.ethUsdFeed, 'config.ethUsdFeed'),
    site,
    dataRepo,
    ipfs: { gateways, pinners, minPinned },
    keeper,
    lease,
    guardian,
    verifier,
    alerts: { cooldownSec: int(al.cooldownSec, 'config.alerts.cooldownSec', 3600), reminderSec: int(al.reminderSec, 'config.alerts.reminderSec', 12 * 3600) },
    eventsFromBlock: big(raw.eventsFromBlock, 'config.eventsFromBlock', sharing.graduatorFromBlock),
  };
}

export function loadOpsConfig(path: string): OpsConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new ConfigError(`cannot read the config file ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`the config file ${path} is not valid JSON: ${(e as Error).message}`);
  }
  return parseOpsConfig(raw);
}

/** The CURB-SHARE v1 configuration as an outside verifier needs it - the
 *  same bytes for the same configuration (sorted keys, decimal strings). */
export function publicSharingConfig(c: OpsConfig): Record<string, unknown> {
  const s = c.sharing;
  return {
    schema: 'curb.sharing.config/1',
    sharing: {
      chainId: s.chainId.toString(),
      graduator: s.graduator,
      graduatorFromBlock: s.graduatorFromBlock.toString(),
      weth: s.weth,
      rules: {
        version: s.rules.version.toString(),
        exclusions: s.rules.exclusions,
        keeperKeys: s.rules.keeperKeys,
        ammFactories: s.rules.ammFactories,
      },
      feeds: s.feeds,
    },
    distributorFactory: c.distributorFactory,
  };
}

/** The verifier's config from a published public config (or a full one). */
export function sharingConfigFrom(raw: unknown): { sharing: SharerConfig; distributorFactory: Address } {
  if (!isObj(raw)) throw new ConfigError('the sharing config must be an object');
  // a published public config, or a full ops config: only these two parts are read
  const full = parseOpsConfig({ sharing: raw.sharing, distributorFactory: raw.distributorFactory });
  return { sharing: full.sharing, distributorFactory: full.distributorFactory };
}

/** EVERY DIFFERENCE between a published sharing config and this host's,
 *  named - not only the rules version. The keeper, the guardian and every
 *  verifier compute each epoch from their own copy of the WHOLE sharing
 *  block: an exclusion, a keeper key, an AMM factory, and also a price feed
 *  (the file records keeper.price), the graduator or WETH change the bytes. A
 *  copy out of step makes an honest root a mismatch, and the guardian vetoes
 *  it. Lists compare as sets (the file sorts them); a reason is part of an
 *  exclusion (the file carries it). Empty means the same configuration. */
export function diffSharingConfig(published: unknown, here: { sharing: SharerConfig; distributorFactory?: Address | null }): string[] {
  let p: { sharing: SharerConfig; distributorFactory: Address };
  try {
    p = sharingConfigFrom(published);
  } catch (e) {
    return [`the published config is not a sharing config: ${(e as Error).message}`];
  }
  const a = p.sharing;
  const b = here.sharing;
  const out: string[] = [];
  const scalar = (name: string, x: unknown, y: unknown) => {
    if (String(x) !== String(y)) out.push(`${name}: published ${String(x)}, here ${String(y)}`);
  };
  scalar('sharing.chainId', a.chainId, b.chainId);
  scalar('sharing.graduator', a.graduator, b.graduator);
  scalar('sharing.graduatorFromBlock', a.graduatorFromBlock, b.graduatorFromBlock);
  scalar('sharing.weth', a.weth, b.weth);
  scalar('sharing.rules.version', a.rules.version, b.rules.version);
  if (here.distributorFactory) scalar('distributorFactory', p.distributorFactory, here.distributorFactory);
  const listed = (name: string, xs: { address: string; reason: string }[], ys: { address: string; reason: string }[]) => {
    const A = new Map(xs.map((x) => [x.address, x.reason]));
    const B = new Map(ys.map((y) => [y.address, y.reason]));
    for (const [k, r] of B) {
      if (!A.has(k)) out.push(`${name}: here has ${k} (${r}), published does not`);
      else if (A.get(k) !== r) out.push(`${name}: ${k} is "${A.get(k)}" published, "${r}" here`);
    }
    for (const [k, r] of A) if (!B.has(k)) out.push(`${name}: published has ${k} (${r}), here does not`);
  };
  listed('sharing.rules.exclusions', a.rules.exclusions, b.rules.exclusions);
  listed('sharing.rules.ammFactories', a.rules.ammFactories, b.rules.ammFactories);
  const ka = new Set(a.rules.keeperKeys);
  const kb = new Set(b.rules.keeperKeys);
  for (const k of kb) if (!ka.has(k)) out.push(`sharing.rules.keeperKeys: here has ${k}, published does not`);
  for (const k of ka) if (!kb.has(k)) out.push(`sharing.rules.keeperKeys: published has ${k}, here does not`);
  const fa = a.feeds;
  const fb = b.feeds;
  for (const q of new Set([...Object.keys(fa), ...Object.keys(fb)])) {
    if (!fa[q]) out.push(`sharing.feeds: here prices ${q} (ethUsd ${fb[q].ethUsd}, quoteUsd ${fb[q].quoteUsd}), published does not`);
    else if (!fb[q]) out.push(`sharing.feeds: published prices ${q} (ethUsd ${fa[q].ethUsd}, quoteUsd ${fa[q].quoteUsd}), here does not`);
    else {
      if (fa[q].ethUsd !== fb[q].ethUsd) out.push(`sharing.feeds[${q}].ethUsd: published ${fa[q].ethUsd}, here ${fb[q].ethUsd}`);
      if (fa[q].quoteUsd !== fb[q].quoteUsd) out.push(`sharing.feeds[${q}].quoteUsd: published ${fa[q].quoteUsd}, here ${fb[q].quoteUsd}`);
    }
  }
  return out;
}
