// EVERY LAUNCH, IN ONE FILE, FOR AI AGENTS AND SCREENERS.
//
// sharing/<chain>/launches.json (LAUNCHES_SCHEMA) in the data repo, which the
// site serves at https://curbfun.xyz/sharing/<chain>/launches.json (web/vercel.json
// rewrites /sharing/<chain>/* to the repo). One GET answers "which launches are
// there, on which asset, how far along their curve, with what tax, and what have
// they paid their holders" - without an endpoint, a key or a POST, so an agent
// that can only read a URL can use it (web/agents/curb.md says how).
//
// READ AT ONE BLOCK: the safe block's lens.launchPage, 50 launches a call, until
// a short page. The name, the symbol and the tax of each launch never change, so
// they are read once and kept from the last file while the launch's curve is
// the same; each quote asset's symbol and decimals likewise. The activity and
// the holder payouts come from stats.json, which scripts/index-history.ts writes
// in the run before this one.
//
// WRITTEN ONLY WHEN SOMETHING CHANGED, or when the file's asOf is six hours old
// by the chain's own clock (REFRESH_AFTER_S): so while the job runs every 15
// minutes, asOf is never much more than six hours old. Base makes a block every
// 0.2 s since 5 November 2026, so block counts are no measure of time here.
//
// NOTHING HERE IS A PRICE. Amounts are decimal strings of raw units, placed by
// the decimals given beside them. No dollar figure is written: an agent that
// wants one reads the asset's Chainlink feed itself (web/agents/deployment.json).
// Left out on purpose: the creator wallet, and the token's description, links
// and image. Names and symbols are strangers' text: control, bidi and
// zero-width characters are taken out and they are cut short (cleanText), and
// textCleaned says so.
//
//   node scripts/index-launches.ts            read and write
//   node scripts/index-launches.ts --dry DIR  read, and write the file under DIR
//
// Reads CURB_SHARER_CONFIG (deploy/sharer.json: registry, lens, site.base,
// dataRepo, sharing.chainId), the secret rpc_urls (the first URL is used) and
// data_repo_token, as index-history.ts does, and the hidden lists from
// ../../web/config.js.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { decodeFunctionResult, encodeFunctionData, parseAbi, toFunctionSelector } from 'viem';
import { httpRpc, type Rpc } from '../src/chain/rpc.ts';
import { loadOpsConfig } from '../src/ops/config.ts';
import { DataRepo } from '../src/ops/github.ts';
import { readRpcUrls, readSecret } from '../src/ops/secrets.ts';
import { parseStats, statsPath, STATUS, type AssetTotals, type LaunchStats } from './index-history.ts';

export const LAUNCHES_SCHEMA = 'curb.launches/1';
export const launchesPath = (chainId: number): string => `sharing/${chainId}/launches.json`;
/** The file is written at least this often, by the safe block's timestamp. */
export const REFRESH_AFTER_S = 21_600;
/** The lens's own page size (LaunchLens.MAX_PAGE). */
export const PAGE = 50;
const MAX_LAUNCHES = 100_000;
const ZERO = '0x0000000000000000000000000000000000000000';

export const LENS_ABI = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct LaunchView { uint8 status; address curve; address quoteToken; address beneficiary; uint256 quoteReserve; uint256 tokenReserve; uint256 realQuoteReserve; uint256 graduationThreshold; uint256 totalSupply; PoolKey poolKey; uint64 launchedAt; address holderDistributor; }',
  'function launchPage(uint256 start, uint256 count) view returns (address[] tokens, LaunchView[] views)',
]);
const SEL = {
  name: toFunctionSelector('name()'),
  symbol: toFunctionSelector('symbol()'),
  decimals: toFunctionSelector('decimals()'),
  launchOf: toFunctionSelector('launchOf(address)'),
  quoteToken: toFunctionSelector('quoteToken()'),
};

/** What the file says of one launch. */
export interface LaunchEntry {
  token: string;
  curve: string;
  name: string;
  symbol: string;
  /** Whether control, bidi or zero-width characters were taken out of the
   *  name or the symbol, or either was cut short. */
  textCleaned: boolean;
  page: string;
  /** config.js hides it, or every launch on its asset (hiddenFactories). */
  hidden: boolean;
  status: 'selling' | 'waiting' | 'graduated';
  launchedAt: number;
  /** The launch's one tax, buy and sell, in basis points of the quote asset. */
  taxBps: number;
  quote: { token: string; symbol: string; decimals: number };
  /** In the quote asset's raw units: what the curve has raised, and what it
   *  must raise to graduate. bps = raised / threshold, capped at 10000;
   *  10000 once graduated; null when the threshold is 0. */
  progress: { raised: string; threshold: string; bps: number | null };
  /** Null while the launch keeps its creator income. Once it shares it with
   *  its holders: its distributor, and what it has paid them as stats.json
   *  last counted (null amounts before it has). */
  holderSharing: { distributor: string; paidQuote: string | null; paidToken: string | null } | null;
  /** stats.json's counts for the launch, or null when it has none. */
  activity: {
    curveBuys: number; curveSells: number; traders: number; holders: number; poolSwaps: number;
    curveVolume: string; poolVolume: string; lastTradeBlock: number | null;
  } | null;
}
export interface LaunchesFile {
  schema: string;
  chainId: number;
  /** The safe block every chain read was made at, and its timestamp. */
  asOf: { block: number; timestamp: number };
  lens: string;
  count: number;
  launches: LaunchEntry[];
  platform: { launches: number; graduated: number; sharing: number; byQuote: Record<string, AssetTotals> };
}

/** Strangers' text, made safe to show: C0 and C1 controls, zero-width and
 *  bidi controls, line and paragraph separators and the BOM taken out, then
 *  cut at `max` code points. `cleaned` says whether anything changed. */
export function cleanText(s: string, max: number): { text: string; cleaned: boolean } {
  const stripped = String(s).replace(/[\u0000-\u001f\u007f-\u009f\u{200b}-\u{200f}\u{2028}\u{2029}\u{202a}-\u{202e}\u{2066}-\u{2069}\u{feff}]/gu, '');
  const cps = [...stripped];
  const text = cps.slice(0, max).join('');
  return { text, cleaned: text !== s };
}

/** An ABI string return (or a bytes32 one, as some old tokens answer), or null. */
export function decodeText(raw: string): string | null {
  const h = String(raw || '').replace(/^0x/, '');
  if (!/^[0-9a-fA-F]*$/.test(h)) return null;
  if (h.length === 64) return Buffer.from(h, 'hex').toString('utf8').replace(/\0+$/, '');
  if (h.length < 128) return null;
  const off = Number(BigInt('0x' + h.slice(0, 64)));
  if (off !== 32) return null;
  const len = Number(BigInt('0x' + h.slice(64, 128)));
  if (!Number.isSafeInteger(len) || len > 4096 || h.length < 128 + 2 * len) return null;
  return Buffer.from(h.slice(128, 128 + 2 * len), 'hex').toString('utf8');
}

/** launches.json read back: the file, when it is one this script wrote for
 *  this chain, or null. */
export function parseLaunches(bytes: Uint8Array | null, chainId: number): LaunchesFile | null {
  if (!bytes) return null;
  try {
    const j = JSON.parse(Buffer.from(bytes).toString('utf8')) as LaunchesFile;
    if (!j || j.schema !== LAUNCHES_SCHEMA || j.chainId !== chainId || !Array.isArray(j.launches)) return null;
    if (!j.asOf || !Number.isSafeInteger(j.asOf.block) || !Number.isSafeInteger(j.asOf.timestamp)) return null;
    const ok = j.launches.every((e) => e && /^0x[0-9a-f]{40}$/.test(e.token) && /^0x[0-9a-f]{40}$/.test(e.curve) &&
      typeof e.name === 'string' && typeof e.symbol === 'string' && Number.isSafeInteger(e.taxBps) &&
      e.quote && /^0x[0-9a-f]{40}$/.test(e.quote.token) && typeof e.quote.symbol === 'string' && Number.isSafeInteger(e.quote.decimals));
    return ok ? j : null;
  } catch {
    return null;
  }
}

/** One launch as the lens's page gives it. */
export interface LensView {
  token: string;
  status: number;
  curve: string;
  quote: string;
  realQuoteReserve: bigint;
  graduationThreshold: bigint;
  launchedAt: number;
  holderDistributor: string;
}
/** What never changes for a launch, read once (or kept from the last file). */
export interface Fixed { name: string; symbol: string; textCleaned: boolean; taxBps: number }

/** progress.bps: raised over threshold in basis points, capped at 10000;
 *  10000 once graduated; null when the threshold is 0. */
export function progressBps(status: number, raised: bigint, threshold: bigint): number | null {
  if (status === 3) return 10_000;
  if (threshold === 0n) return null;
  const b = (raised * 10_000n) / threshold;
  return Number(b > 10_000n ? 10_000n : b);
}

/** ONE LAUNCH'S ENTRY, from the lens, its fixed fields, its asset and stats.json. */
export function entryOf(v: LensView, fixed: Fixed, quote: { symbol: string; decimals: number }, stats: LaunchStats | undefined,
  o: { siteBase: string; hidden: boolean }): LaunchEntry {
  const token = v.token.toLowerCase();
  const curve = v.curve.toLowerCase();
  // ONLY stats.json's ENTRY FOR THIS LAUNCH ON THIS CURVE speaks for it.
  const s = stats && stats.curve === curve ? stats : undefined;
  const dist = v.holderDistributor.toLowerCase();
  return {
    token,
    curve,
    name: fixed.name,
    symbol: fixed.symbol,
    textCleaned: fixed.textCleaned,
    page: o.siteBase.replace(/\/+$/, '') + '/token/' + token,
    hidden: o.hidden,
    status: STATUS[v.status] as LaunchEntry['status'],
    launchedAt: v.launchedAt,
    taxBps: fixed.taxBps,
    quote: { token: v.quote.toLowerCase(), symbol: quote.symbol, decimals: quote.decimals },
    progress: {
      raised: v.realQuoteReserve.toString(),
      threshold: v.graduationThreshold.toString(),
      bps: progressBps(v.status, v.realQuoteReserve, v.graduationThreshold),
    },
    holderSharing: dist === ZERO ? null : {
      distributor: dist,
      paidQuote: s && s.holderSharing && s.holderSharing.distributor === dist ? s.holderSharing.paidQuote : null,
      paidToken: s && s.holderSharing && s.holderSharing.distributor === dist ? s.holderSharing.paidToken : null,
    },
    activity: s ? {
      curveBuys: s.curveBuys, curveSells: s.curveSells, traders: s.traders, holders: s.holders, poolSwaps: s.poolSwaps,
      curveVolume: s.curveVolume, poolVolume: s.poolVolume, lastTradeBlock: s.lastTradeBlock,
    } : null,
  };
}

/** THE FILE, from its entries (in the registry's order) and stats.json's totals. */
export function buildLaunches(o: { chainId: number; lens: string; asOf: { block: number; timestamp: number }; entries: LaunchEntry[]; totals: Record<string, AssetTotals> }): LaunchesFile {
  return {
    schema: LAUNCHES_SCHEMA,
    chainId: o.chainId,
    asOf: o.asOf,
    lens: o.lens.toLowerCase(),
    count: o.entries.length,
    launches: o.entries,
    platform: {
      launches: o.entries.length,
      graduated: o.entries.filter((e) => e.status === 'graduated').length,
      sharing: o.entries.filter((e) => e.holderSharing !== null).length,
      byQuote: o.totals,
    },
  };
}

/** Whether `next` must be written over `last`: something but asOf changed, or
 *  the last file is REFRESH_AFTER_S old by the chain's clock. */
export function shouldWrite(last: LaunchesFile | null, next: LaunchesFile): boolean {
  if (!last) return true;
  const body = (f: LaunchesFile) => JSON.stringify({ ...f, asOf: null });
  if (body(last) !== body(next)) return true;
  return next.asOf.timestamp - last.asOf.timestamp >= REFRESH_AFTER_S;
}

/** stats.json's totals read back as they are (only well-formed entries). */
function parseTotals(bytes: Uint8Array | null, chainId: number): Record<string, AssetTotals> {
  if (!bytes) return {};
  try {
    const j = JSON.parse(Buffer.from(bytes).toString('utf8'));
    if (!j || j.schema !== 'curb.stats/1' || j.chainId !== chainId || !j.totals || typeof j.totals !== 'object') return {};
    const out: Record<string, AssetTotals> = {};
    for (const [k, t] of Object.entries(j.totals as Record<string, AssetTotals>)) {
      if (/^0x[0-9a-f]{40}$/.test(k) && t && typeof t === 'object' && Number.isSafeInteger(t.decimals) && Number.isSafeInteger(t.launches)) out[k] = t;
    }
    return out;
  } catch {
    return {};
  }
}

export interface LaunchesDeps {
  rpc: Rpc;
  chainId: number;
  registry: string;
  lens: string;
  siteBase: string;
  hiddenLaunches: string[];
  hiddenFactories: string[];
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, bytes: Uint8Array, message: string): Promise<void>;
  log(line: string): void;
}

const pad = (a: string): string => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const wordAt = (hex: string, i: number): string => hex.replace(/^0x/, '').slice(64 * i, 64 * (i + 1));

/** One pass: read every launch at the safe block, and write the file if it changed. */
export async function indexLaunches(d: LaunchesDeps): Promise<{ launches: number; written: boolean; failed: number }> {
  const safe = (await d.rpc.request({ method: 'eth_getBlockByNumber', params: ['safe', false] })) as { number: string; timestamp: string } | null;
  if (!safe) throw new Error('the endpoint has no safe block');
  const asOf = { block: Number(BigInt(safe.number)), timestamp: Number(BigInt(safe.timestamp)) };
  const at = '0x' + BigInt(asOf.block).toString(16);
  const call = async (to: string, data: string): Promise<string> =>
    String(await d.rpc.request({ method: 'eth_call', params: [{ to, data }, at] }));
  let failed = 0;

  const last = parseLaunches(await d.read(launchesPath(d.chainId)), d.chainId);
  const lastBy = new Map((last ? last.launches : []).map((e) => [e.token, e]));
  // stats.json, which index-history.ts wrote just before: activity and totals.
  let statsBytes: Uint8Array | null = null;
  try {
    statsBytes = await d.read(statsPath(d.chainId));
  } catch (e) {
    failed++;
    d.log(`stats.json: ${(e as Error).message}`);
  }
  const stats = parseStats(statsBytes, d.chainId);
  const totals = parseTotals(statsBytes, d.chainId);

  // THE HIDDEN ASSETS: each hidden factory's quote asset, read once a run.
  const hiddenQuotes = new Set<string>();
  for (const f of d.hiddenFactories) {
    try {
      hiddenQuotes.add(('0x' + wordAt(await call(f, SEL.quoteToken), 0).slice(24)).toLowerCase());
    } catch (e) {
      failed++;
      d.log(`hidden factory ${f}: ${(e as Error).message}`);
    }
  }
  const hiddenLaunches = new Set(d.hiddenLaunches.map((a) => a.toLowerCase()));

  // EVERY LAUNCH, 50 A PAGE, AT THE SAFE BLOCK. A page that cannot be read
  // fails the run: a file without those launches would say they are gone.
  const views: LensView[] = [];
  for (let start = 0; start < MAX_LAUNCHES; start += PAGE) {
    const raw = await call(d.lens, encodeFunctionData({ abi: LENS_ABI, functionName: 'launchPage', args: [BigInt(start), BigInt(PAGE)] }));
    const [tokens, vs] = decodeFunctionResult({ abi: LENS_ABI, functionName: 'launchPage', data: raw as `0x${string}` }) as readonly [readonly string[], readonly any[]];
    if (tokens.length !== vs.length) throw new Error(`the lens gave ${tokens.length} tokens and ${vs.length} views`);
    tokens.forEach((t, i) => {
      const v = vs[i];
      views.push({
        token: t.toLowerCase(), status: Number(v.status), curve: String(v.curve).toLowerCase(), quote: String(v.quoteToken).toLowerCase(),
        realQuoteReserve: BigInt(v.realQuoteReserve), graduationThreshold: BigInt(v.graduationThreshold),
        launchedAt: Number(v.launchedAt), holderDistributor: String(v.holderDistributor).toLowerCase(),
      });
    });
    if (tokens.length < PAGE) break;
  }

  // EACH QUOTE ASSET'S SYMBOL AND DECIMALS, kept from the last file, read once otherwise.
  const quotes = new Map<string, { symbol: string; decimals: number }>();
  for (const e of last ? last.launches : []) quotes.set(e.quote.token, { symbol: e.quote.symbol, decimals: e.quote.decimals });
  const quoteOf = async (q: string) => {
    const known = quotes.get(q);
    if (known) return known;
    const sym = decodeText(await call(q, SEL.symbol));
    const decRaw = await call(q, SEL.decimals);
    const dec = /^0x[0-9a-fA-F]{64,}$/.test(decRaw) ? BigInt('0x' + wordAt(decRaw, 0)) : -1n;
    if (sym === null || dec < 0n || dec > 255n) throw new Error(`the quote asset ${q} answers no symbol() or decimals()`);
    const one = { symbol: cleanText(sym, 16).text, decimals: Number(dec) };
    quotes.set(q, one);
    return one;
  };

  const entries: LaunchEntry[] = [];
  for (const v of views) {
    if (v.status === 0 || !STATUS[v.status]) continue; // notFound: no launch
    const was = lastBy.get(v.token);
    try {
      // THE FIXED FIELDS, kept while the curve is the same.
      let fixed: Fixed;
      if (was && was.curve === v.curve) {
        fixed = { name: was.name, symbol: was.symbol, textCleaned: was.textCleaned, taxBps: was.taxBps };
      } else {
        const [nameRaw, symRaw, rec] = await Promise.all([call(v.token, SEL.name), call(v.token, SEL.symbol), call(d.registry, SEL.launchOf + pad(v.token))]);
        const name = decodeText(nameRaw), symbol = decodeText(symRaw);
        if (name === null || symbol === null) throw new Error('the token answers no name() or symbol()');
        if (('0x' + wordAt(rec, 0).slice(24)).toLowerCase() !== v.curve) throw new Error("the registry's record is not the lens's curve");
        const taxBps = Number(BigInt('0x' + (wordAt(rec, 8) || '0')));
        if (!Number.isSafeInteger(taxBps) || taxBps <= 0 || taxBps > 10_000) throw new Error(`the registry records a tax of ${taxBps}`);
        const n = cleanText(name, 64), s = cleanText(symbol, 16);
        fixed = { name: n.text, symbol: s.text, textCleaned: n.cleaned || s.cleaned, taxBps };
      }
      const quote = await quoteOf(v.quote);
      const hidden = hiddenLaunches.has(v.token) || hiddenQuotes.has(v.quote);
      entries.push(entryOf(v, fixed, quote, stats[v.token], { siteBase: d.siteBase, hidden }));
    } catch (e) {
      failed++;
      d.log(`launch ${v.token}: ${(e as Error).message}`);
      // ITS LAST ENTRY STANDS, as it was; a launch never written is left out.
      if (was) entries.push(was);
    }
  }

  const file = buildLaunches({ chainId: d.chainId, lens: d.lens, asOf, entries, totals });
  const written = shouldWrite(last, file);
  if (written) {
    await d.write(launchesPath(d.chainId), new Uint8Array(Buffer.from(JSON.stringify(file))), `launches at ${asOf.block}`);
    d.log(`launches.json: ${entries.length} launches at block ${asOf.block}`);
  }
  return { launches: entries.length, written, failed };
}

/** web/config.js's hidden lists, read as the site reads them (no code of it runs
 *  but the assignment to window.CURB_SITE, in a sandbox). */
export function hiddenFromConfig(src: string): { hiddenLaunches: string[]; hiddenFactories: string[] } {
  const box: { window: { CURB_SITE?: { hiddenLaunches?: unknown; hiddenFactories?: unknown } } } = { window: {} };
  vm.runInNewContext(src, box, { timeout: 1000 });
  const s = box.window.CURB_SITE || {};
  // COPIED INTO THIS REALM: the sandbox's arrays are not this one's.
  const addrs = (l: unknown): string[] => [...(Array.isArray(l) ? l : [])].map((a) => String(a).trim().toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a));
  return { hiddenLaunches: addrs(s.hiddenLaunches), hiddenFactories: addrs(s.hiddenFactories) };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dry = argv[0] === '--dry' ? argv[1] : '';
  const cfg = loadOpsConfig(process.env.CURB_SHARER_CONFIG || 'deploy/sharer.json');
  const urls = readRpcUrls('rpc_urls');
  if (!urls.length) throw new Error('no RPC: set the rpc_urls secret');
  const rpc = httpRpc(urls[0].reveal(), { label: 'a' });
  const chainId = Number(cfg.sharing.chainId);
  if (!cfg.registry || !cfg.lens) throw new Error('the config names no registry or no lens');
  if (!cfg.site) throw new Error('the config names no site.base');
  const here = dirname(fileURLToPath(import.meta.url));
  const hidden = hiddenFromConfig(readFileSync(join(here, '..', '..', '..', 'web', 'config.js'), 'utf8'));
  let read: LaunchesDeps['read'];
  let write: LaunchesDeps['write'];
  if (dry) {
    read = async () => null;
    write = async (path, bytes) => {
      const p = join(dry, path);
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, bytes);
    };
  } else {
    const token = readSecret('data_repo_token');
    if (!token || !cfg.dataRepo) throw new Error('no data repo: set config.dataRepo and the data_repo_token secret');
    const repo = new DataRepo({ owner: cfg.dataRepo.owner, repo: cfg.dataRepo.repo, branch: cfg.dataRepo.branch, token });
    read = async (path) => {
      const f = await repo.get(path);
      return f ? f.bytes : null;
    };
    write = async (path, bytes, message) => {
      await repo.upsert(path, bytes, message);
    };
  }
  const r = await indexLaunches({
    rpc, chainId, registry: cfg.registry, lens: cfg.lens, siteBase: cfg.site.base, ...hidden, read, write,
    log: (l) => console.log(l),
  });
  console.log(JSON.stringify({ mode: 'launches', ...r }));
  if (r.failed) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('index-launches.ts')) {
  main().catch((e) => {
    console.error((e as Error).message);
    process.exit(1);
  });
}
