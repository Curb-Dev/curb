// THE LAUNCHES' HISTORY, INDEXED FOR THE SITE.
//
// A launch's page draws its chart, its trades and its holders from the logs of
// its curve, its token, the CURB router and - once it graduated - its pool. On
// the site's endpoints those are read 1,000 blocks a request, one window after
// another: a launch a day old was some eighty requests and twenty seconds
// before its chart (17 October 2026), and every day added three more windows
// per log. This writes, for every launch the registry lists, those same logs
// as the endpoint returned them - nothing computed, nothing left out - to the
// data repo at sharing/<chain>/history/<token>.json, which the site serves
// under /sharing/<chain>/history/ (web/vercel.json). The page reads the file,
// checks every log in it against the launch it is drawing (web/token.js
// historyIndex), and reads the chain itself only after the file's last block.
// A file that is missing, stale or wrong costs the page nothing but the time
// it used to take.
//
// INCREMENTAL. Each file carries the block it was read to (`to`, a safe
// block); the next run reads from the block after it. A file is rewritten
// when there are new logs, or when its `to` is REWRITE_AFTER blocks behind, so
// a quiet launch costs a commit about twice a day and not every run.
//
// AND HOW FAR EACH FILE IS KNOWN COMPLETE, in one file every run
// (sharing/<chain>/history/checked.json, CHECKED_SCHEMA): a launch whose
// run found nothing new is complete up to this run's block though its own
// file still says the last run that wrote it. Without it a quiet launch's
// page read up to REWRITE_AFTER blocks of the chain after the file, twenty
// windows before its chart; with it, what came since this run.
//
// AND WHAT THE FILES ADD UP TO, in one more file (sharing/<chain>/stats.json,
// STATS_SCHEMA), for screeners and indexers and for the owner's own weekly
// figures: each launch's trades, traders, volumes and holders, and the totals
// per quote asset. Counted from the history files this run holds - the old
// logs and the new - and from nothing off chain; amounts in the quote asset's
// own units, never in dollars. Written after the files it counts, and only
// when its numbers change.
//
//   node scripts/index-history.ts            read and write
//   node scripts/index-history.ts --dry DIR  read, and write the files under DIR
//                                            instead of the data repo
//
// Reads CURB_SHARER_CONFIG (deploy/sharer.json: registry, lens, dataRepo,
// sharing.chainId) and the secrets rpc_urls (the first URL is used) and
// data_repo_token, as every other command does (src/ops/secrets.ts).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeAbiParameters, keccak256, toEventSelector, toFunctionSelector } from 'viem';
import { getLogsAdaptive, LogWindow, type RawLog } from '../src/chain/logs.ts';
import { httpRpc, type Rpc } from '../src/chain/rpc.ts';
import { loadOpsConfig } from '../src/ops/config.ts';
import { DataRepo } from '../src/ops/github.ts';
import { readRpcUrls, readSecret } from '../src/ops/secrets.ts';

export const SCHEMA = 'curb.history/1';
export const CHECKED_SCHEMA = 'curb.history-checked/1';
/** A file whose `to` is this far behind is rewritten even with nothing new:
 *  about eleven hours of Base, so a page never reads more than ~20 windows. */
export const REWRITE_AFTER = 20_000n;
/** The CURB router (script/DeployRouter.s.sol; web/app.js CURB_ROUTER): the
 *  same address on every chain it is deployed to. */
export const CURB_ROUTER = '0xea20c3266229a01cd0f45d9c7921a45d5b359561';
/** Uniswap v4's PoolManager on Base (web/token.js POOL_MANAGER). */
export const POOL_MANAGER = '0x498581ff718922c3f8e6a244956af099b2652b2b';

export const TOPIC = {
  curveBuy: toEventSelector('CurveBuy(address,address,uint256,uint256,uint256,uint256)'),
  curveSell: toEventSelector('CurveSell(address,address,uint256,uint256,uint256,uint256)'),
  feesSwept: toEventSelector('FeesSwept(uint256,uint256,uint256)'),
  feesRescued: toEventSelector('FeesRescued(address,address,uint256,uint256)'),
  transfer: toEventSelector('Transfer(address,address,uint256)'),
  swap: toEventSelector('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)'),
  feeCharged: toEventSelector('FeeCharged(bytes32,address,uint256,uint256,uint256)'),
  routerSold: toEventSelector('SoldForEth(address,address,address,address,uint256,uint256,uint256,bool)'),
};
const SEL = {
  launchCount: toFunctionSelector('launchCount()'),
  launchAt: toFunctionSelector('launchAt(uint256)'),
  launchOf: toFunctionSelector('launchOf(address)'),
  launchState: toFunctionSelector('launchState(address)'),
  decimals: toFunctionSelector('decimals()'),
};

/** One log as the site reads it: the fields web/token.js uses, nothing else. */
export interface IndexLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  logIndex: string;
  transactionHash: string;
}
export interface HistoryFile {
  schema: string;
  chainId: number;
  token: string;
  curve: string;
  /** No log of this launch is older than this block (its creation, or a
   *  little before it). */
  from: number;
  /** Every log up to and including this block is here. */
  to: number;
  curveLogs: IndexLog[];
  transfers: IndexLog[];
  routerSold: IndexLog[];
  swaps: IndexLog[];
  fees: IndexLog[];
}

const pad = (a: string): string => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const word = (hex: string, i: number): string => hex.replace(/^0x/, '').slice(64 * i, 64 * (i + 1));
const addrAt = (hex: string, i: number): string => '0x' + word(hex, i).slice(24);
const numAt = (hex: string, i: number): bigint => BigInt('0x' + (word(hex, i) || '0'));

export function slim(l: RawLog): IndexLog {
  return { address: l.address.toLowerCase(), topics: l.topics.map((t) => t.toLowerCase()), data: l.data, blockNumber: l.blockNumber, logIndex: l.logIndex, transactionHash: l.transactionHash.toLowerCase() };
}

/** Old and new logs together, each once, in (block, logIndex) order. */
export function merge(a: IndexLog[], b: IndexLog[]): IndexLog[] {
  const seen = new Set<string>();
  const out: IndexLog[] = [];
  for (const l of [...a, ...b]) {
    const k = BigInt(l.blockNumber) + ':' + BigInt(l.logIndex);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l);
  }
  return out.sort((x, y) => {
    const bx = BigInt(x.blockNumber), by = BigInt(y.blockNumber);
    if (bx !== by) return bx < by ? -1 : 1;
    const ix = BigInt(x.logIndex), iy = BigInt(y.logIndex);
    return ix < iy ? -1 : ix > iy ? 1 : 0;
  });
}

/** WHAT checked.json SAYS: for each launch, its curve, the version of its
 *  file the entry speaks for (that file's own `to`), and the block that
 *  file holds every log up to - its own `to` or later, never earlier. The
 *  two files are fetched apart and cached apart (raw.githubusercontent, five
 *  minutes), so a page can hold an older file beside a newer checked.json:
 *  it takes the entry only for the file it names (web/token.js). */
export interface CheckedFile {
  schema: string;
  chainId: number;
  launches: Record<string, { curve: string; file: number; to: number }>;
}
export const checkedPath = (chainId: number): string => `sharing/${chainId}/history/checked.json`;

/** checked.json read back: the entries that are well formed, or none. */
export function parseChecked(bytes: Uint8Array | null, chainId: number): CheckedFile['launches'] {
  const out: CheckedFile['launches'] = {};
  if (!bytes) return out;
  try {
    const j = JSON.parse(Buffer.from(bytes).toString('utf8')) as CheckedFile;
    if (!j || j.schema !== CHECKED_SCHEMA || j.chainId !== chainId || !j.launches || typeof j.launches !== 'object') return out;
    for (const [token, e] of Object.entries(j.launches)) {
      if (/^0x[0-9a-f]{40}$/.test(token) && e && /^0x[0-9a-f]{40}$/.test(e.curve) && Number.isInteger(e.file) && Number.isInteger(e.to) &&
        e.file >= 0 && e.to >= e.file) out[token] = { curve: e.curve, file: e.file, to: e.to };
    }
  } catch { /* none */ }
  return out;
}

/** A file read back, or null when it is not one this script wrote for this
 *  launch: then the launch is read again from its start. */
export function parseFile(bytes: Uint8Array | null, chainId: number, token: string, curve: string): HistoryFile | null {
  if (!bytes) return null;
  try {
    const j = JSON.parse(Buffer.from(bytes).toString('utf8')) as HistoryFile;
    if (j.schema !== SCHEMA || j.chainId !== chainId) return null;
    if (j.token !== token.toLowerCase() || j.curve !== curve.toLowerCase()) return null;
    if (!Number.isInteger(j.from) || !Number.isInteger(j.to) || j.to < j.from - 1) return null;
    for (const k of ['curveLogs', 'transfers', 'routerSold', 'swaps', 'fees'] as const) if (!Array.isArray(j[k])) return null;
    return j;
  } catch {
    return null;
  }
}

export const STATS_SCHEMA = 'curb.stats/1';
export const statsPath = (chainId: number): string => `sharing/${chainId}/stats.json`;
/** The lens's LaunchStatus (src/curb/LaunchLens.sol), by name. */
export const STATUS = ['notFound', 'selling', 'waiting', 'graduated'] as const;
const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = '0x000000000000000000000000000000000000dead';

/** WHAT stats.json SAYS OF ONE LAUNCH, counted from its history file as
 *  web/token.js scanHistory decodes the same logs. Amounts are decimal
 *  strings of the quote asset's raw units; `quoteDecimals` places the point. */
export interface LaunchStats {
  curve: string;
  /** The quote asset, and its decimals() as the run that counted this read it. */
  quote: string;
  quoteDecimals: number;
  /** The lens's status at that run, by name (STATUS). */
  status: string;
  /** The first and the last block with a trade, on the curve or in the pool;
   *  null before the first. */
  firstTradeBlock: number | null;
  lastTradeBlock: number | null;
  curveBuys: number;
  curveSells: number;
  /** Distinct addresses. Buyers: the recipients of the curve's buys, as the
   *  site names a buyer. Traders: those and the curve's sellers as the site
   *  names them - a sale the curve paid to the CURB router by the seller the
   *  router's SoldForEth names in the same transaction, for the same tokens. */
  buyers: number;
  traders: number;
  /** Buys' quoteIn and sells' quoteOut + fee + tax: what crossed the curve
   *  before its fee and tax were taken. */
  curveVolume: string;
  /** Once graduated: the pool's swaps, and the quote side of each, either way. */
  poolSwaps: number;
  poolVolume: string;
  /** Addresses the transfers leave a balance above zero, but the zero address
   *  and 0x...dEaD: burned is not held (the site's holder list). */
  holders: number;
}
/** The launches of one quote asset, added up. */
export interface AssetTotals {
  decimals: number;
  launches: number;
  graduated: number;
  curveBuys: number;
  curveSells: number;
  curveVolume: string;
  poolSwaps: number;
  poolVolume: string;
}
export interface StatsFile {
  schema: string;
  chainId: number;
  /** The run that wrote the file: its safe block and that block's time. A
   *  later run whose numbers are the same leaves the file as it is. */
  generatedAt: { block: number; timestamp: number };
  launches: Record<string, LaunchStats>;
  totals: Record<string, AssetTotals>;
}

const words = (hex: string): number => Math.floor(hex.replace(/^0x/, '').length / 64);
const topicAddr = (t: string): string => ('0x' + t.slice(-40)).toLowerCase();
const blockOf = (l: IndexLog): number => Number(BigInt(l.blockNumber));

/** One launch's numbers, from the file this run holds for it and what the lens
 *  said of it this run. */
export function launchStats(f: HistoryFile, lens: { status: number; quote: string; quoteDecimals: number; currency0: string }): LaunchStats {
  let first: number | null = null, last: number | null = null;
  const traded = (b: number) => {
    if (first === null || b < first) first = b;
    if (last === null || b > last) last = b;
  };
  let curveBuys = 0, curveSells = 0, curveVolume = 0n;
  const buyers = new Set<string>(), traders = new Set<string>();
  for (const l of f.curveLogs) {
    const t0 = l.topics[0];
    if ((t0 !== TOPIC.curveBuy && t0 !== TOPIC.curveSell) || l.topics.length < 3 || words(l.data) < 4) continue;
    traded(blockOf(l));
    let who = topicAddr(l.topics[2]);
    if (t0 === TOPIC.curveBuy) {
      curveBuys++;
      curveVolume += numAt(l.data, 0);
      buyers.add(who);
    } else {
      curveSells++;
      const tokensIn = numAt(l.data, 0);
      curveVolume += numAt(l.data, 1) + numAt(l.data, 2) + numAt(l.data, 3);
      // A SALE THROUGH THE CURB ROUTER is paid to the router: its seller is the
      // one the router's SoldForEth names, as web/token.js namedByRouter finds it.
      if (who === CURB_ROUTER) {
        const ev = f.routerSold.find((r) => r.transactionHash === l.transactionHash && r.topics.length > 2 && words(r.data) >= 2 && numAt(r.data, 1) === tokensIn);
        if (ev) who = topicAddr(ev.topics[1]);
      }
    }
    traders.add(who);
  }
  // IN THE POOL, once graduated: the quote side of each swap is amount1 when
  // the token is currency0, else amount0 (int128, signed by direction).
  let poolSwaps = 0, poolVolume = 0n;
  if (lens.status === 3) {
    const tokenIsC0 = lens.currency0.toLowerCase() === f.token;
    for (const l of f.swaps) {
      if (words(l.data) < 2) continue;
      const q = BigInt.asIntN(128, numAt(l.data, tokenIsC0 ? 1 : 0));
      poolSwaps++;
      poolVolume += q < 0n ? -q : q;
      traded(blockOf(l));
    }
  }
  // HOLDERS, summed from every transfer as the site's holder list sums them.
  const bal = new Map<string, bigint>();
  for (const t of f.transfers) {
    if (t.topics.length < 3 || words(t.data) < 1) continue;
    const from = topicAddr(t.topics[1]), to = topicAddr(t.topics[2]), amount = numAt(t.data, 0);
    if (from !== ZERO) bal.set(from, (bal.get(from) ?? 0n) - amount);
    bal.set(to, (bal.get(to) ?? 0n) + amount);
  }
  bal.delete(ZERO);
  bal.delete(DEAD);
  let holders = 0;
  for (const b of bal.values()) if (b > 0n) holders++;
  return {
    curve: f.curve,
    quote: lens.quote.toLowerCase(),
    quoteDecimals: lens.quoteDecimals,
    status: STATUS[lens.status] ?? 'unknown',
    firstTradeBlock: first,
    lastTradeBlock: last,
    curveBuys,
    curveSells,
    buyers: buyers.size,
    traders: traders.size,
    curveVolume: curveVolume.toString(),
    poolSwaps,
    poolVolume: poolVolume.toString(),
    holders,
  };
}

/** The launches added up per quote asset, in the order their launches come. */
export function totalsOf(launches: Record<string, LaunchStats>): Record<string, AssetTotals> {
  const out: Record<string, AssetTotals> = {};
  for (const e of Object.values(launches)) {
    const t = out[e.quote] ?? (out[e.quote] = { decimals: e.quoteDecimals, launches: 0, graduated: 0, curveBuys: 0, curveSells: 0, curveVolume: '0', poolSwaps: 0, poolVolume: '0' });
    t.launches++;
    if (e.status === 'graduated') t.graduated++;
    t.curveBuys += e.curveBuys;
    t.curveSells += e.curveSells;
    t.curveVolume = (BigInt(t.curveVolume) + BigInt(e.curveVolume)).toString();
    t.poolSwaps += e.poolSwaps;
    t.poolVolume = (BigInt(t.poolVolume) + BigInt(e.poolVolume)).toString();
  }
  return out;
}

/** stats.json's launches read back: the entries that are well formed, each in
 *  the shape launchStats makes, or none. */
export function parseStats(bytes: Uint8Array | null, chainId: number): StatsFile['launches'] {
  const out: StatsFile['launches'] = {};
  if (!bytes) return out;
  const addr = (s: unknown): s is string => typeof s === 'string' && /^0x[0-9a-f]{40}$/.test(s);
  const count = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
  const amount = (s: unknown): s is string => typeof s === 'string' && /^(0|[1-9][0-9]*)$/.test(s);
  const block = (n: unknown): n is number | null => n === null || count(n);
  try {
    const j = JSON.parse(Buffer.from(bytes).toString('utf8')) as StatsFile;
    if (!j || j.schema !== STATS_SCHEMA || j.chainId !== chainId || !j.launches || typeof j.launches !== 'object') return out;
    for (const [token, e] of Object.entries(j.launches)) {
      if (!addr(token) || !e || !addr(e.curve) || !addr(e.quote) || !count(e.quoteDecimals) || e.quoteDecimals > 255 || typeof e.status !== 'string' ||
        !block(e.firstTradeBlock) || !block(e.lastTradeBlock) || !count(e.curveBuys) || !count(e.curveSells) || !count(e.buyers) || !count(e.traders) ||
        !amount(e.curveVolume) || !count(e.poolSwaps) || !amount(e.poolVolume) || !count(e.holders)) continue;
      out[token] = {
        curve: e.curve, quote: e.quote, quoteDecimals: e.quoteDecimals, status: e.status, firstTradeBlock: e.firstTradeBlock, lastTradeBlock: e.lastTradeBlock,
        curveBuys: e.curveBuys, curveSells: e.curveSells, buyers: e.buyers, traders: e.traders, curveVolume: e.curveVolume,
        poolSwaps: e.poolSwaps, poolVolume: e.poolVolume, holders: e.holders,
      };
    }
  } catch { /* none */ }
  return out;
}

async function call(rpc: Rpc, to: string, data: string): Promise<string> {
  return String(await rpc.request({ method: 'eth_call', params: [{ to, data }, 'latest'] }));
}

export interface IndexDeps {
  rpc: Rpc;
  chainId: number;
  registry: string;
  lens: string;
  /** Reads the file now at `path`, or null. */
  read(path: string): Promise<Uint8Array | null>;
  /** Writes `bytes` at `path`. */
  write(path: string, bytes: Uint8Array, message: string): Promise<void>;
  log(line: string): void;
}

/** One pass over every launch. Returns how many files were written. */
export async function indexAll(d: IndexDeps): Promise<{ launches: number; written: number; failed: number }> {
  const safeBlock = (await d.rpc.request({ method: 'eth_getBlockByNumber', params: ['safe', false] })) as { number: string; timestamp: string } | null;
  if (!safeBlock) throw new Error('the endpoint has no safe block');
  const to = BigInt(safeBlock.number);
  const toTs = BigInt(safeBlock.timestamp);
  const count = Number(numAt(await call(d.rpc, d.registry, SEL.launchCount), 0));
  if (!Number.isInteger(count) || count < 0 || count > 100_000) throw new Error(`the registry reports ${count} launches`);
  const win = new LogWindow();
  let written = 0, failed = 0;
  // A LAUNCH THIS RUN COULD NOT READ KEEPS WHAT WAS CHECKED BEFORE: that is
  // still true of its file, which nothing here changed.
  const before = parseChecked(await d.read(checkedPath(d.chainId)), d.chainId);
  const checked: CheckedFile['launches'] = { ...before };
  // AND ITS NUMBERS IN stats.json, which nothing this run counted changes.
  const statsBefore = parseStats(await d.read(statsPath(d.chainId)), d.chainId);
  const stats: StatsFile['launches'] = { ...statsBefore };
  // EACH QUOTE ASSET'S decimals(), read once a run, by the first launch that wants it.
  const decimals = new Map<string, number>();
  const decimalsOf = async (asset: string): Promise<number> => {
    const known = decimals.get(asset);
    if (known !== undefined) return known;
    const r = await call(d.rpc, asset, SEL.decimals);
    const n = /^0x[0-9a-fA-F]{64,}$/.test(r) ? numAt(r, 0) : -1n;
    if (n < 0n || n > 255n) throw new Error(`the quote asset ${asset} answers no decimals()`);
    decimals.set(asset, Number(n));
    return Number(n);
  };
  for (let i = 0; i < count; i++) {
    let token = '';
    try {
      token = addrAt(await call(d.rpc, d.registry, SEL.launchAt + pad('0x' + i.toString(16))), 0);
      const rec = await call(d.rpc, d.registry, SEL.launchOf + pad(token));
      const curve = addrAt(rec, 0);
      const launchedAt = numAt(rec, 11);
      const path = `sharing/${d.chainId}/history/${token}.json`;
      const old = parseFile(await d.read(path), d.chainId, token, curve);
      // FROM THE BLOCK AFTER THE FILE, or from a little before the launch:
      // Base makes a block every 2 seconds, so its creation is about
      // (now - launchedAt) / 2 below the safe block; nothing of a launch is
      // older than its creation, so starting early costs nothing but a window.
      const born = to - (toTs > launchedAt ? (toTs - launchedAt) / 2n : 0n) - 2_000n;
      const from = old ? BigInt(old.to) + 1n : born < 0n ? 0n : born;
      // ONLY ONE THIS LAUNCH'S FILE IS AT: another curve's entry says nothing of it.
      const was = checked[token.toLowerCase()];
      if (was && was.curve !== curve.toLowerCase()) delete checked[token.toLowerCase()];
      const counted = stats[token.toLowerCase()];
      if (counted && counted.curve !== curve.toLowerCase()) delete stats[token.toLowerCase()];
      if (from > to) continue;
      const st = await call(d.rpc, d.lens, SEL.launchState + pad(token));
      const status = Number(numAt(st, 0));
      const graduated = status === 3;
      const poolId = graduated
        ? keccak256(encodeAbiParameters(
          [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
          [addrAt(st, 9) as `0x${string}`, addrAt(st, 10) as `0x${string}`, Number(numAt(st, 11)), Number(BigInt.asIntN(24, numAt(st, 12))), addrAt(st, 13) as `0x${string}`],
        ))
        : '';
      const hook = addrAt(st, 13);
      const get = (address: string, topics: (string | string[] | null)[]) => getLogsAdaptive(d.rpc, { address, topics }, from, to, win);
      const [curveLogs, transfers, routerSold, swaps, fees] = await Promise.all([
        get(curve, [[TOPIC.curveBuy, TOPIC.curveSell, TOPIC.feesSwept, TOPIC.feesRescued]]),
        get(token, [TOPIC.transfer]),
        get(CURB_ROUTER, [TOPIC.routerSold, null, '0x' + pad(token)]),
        graduated ? get(POOL_MANAGER, [TOPIC.swap, poolId]) : Promise.resolve([] as RawLog[]),
        graduated ? get(hook, [TOPIC.feeCharged, poolId]) : Promise.resolve([] as RawLog[]),
      ]);
      const fresh = curveLogs.length + transfers.length + routerSold.length + swaps.length + fees.length;
      // THE FILE THIS RUN HOLDS FOR THE LAUNCH: the old one where nothing is new.
      let held: HistoryFile;
      // NOTHING NEW SINCE THE FILE: it is complete up to this run's block.
      if (old && fresh === 0 && to - BigInt(old.to) < REWRITE_AFTER) {
        checked[token.toLowerCase()] = { curve: curve.toLowerCase(), file: old.to, to: Number(to) };
        held = old;
      } else {
        const file: HistoryFile = {
          schema: SCHEMA,
          chainId: d.chainId,
          token: token.toLowerCase(),
          curve: curve.toLowerCase(),
          from: old ? old.from : Number(from),
          to: Number(to),
          curveLogs: merge(old ? old.curveLogs : [], curveLogs.map(slim)),
          transfers: merge(old ? old.transfers : [], transfers.map(slim)),
          routerSold: merge(old ? old.routerSold : [], routerSold.map(slim)),
          swaps: merge(old ? old.swaps : [], swaps.map(slim)),
          fees: merge(old ? old.fees : [], fees.map(slim)),
        };
        await d.write(path, new Uint8Array(Buffer.from(JSON.stringify(file))), `history ${token} to ${to}`);
        checked[token.toLowerCase()] = { curve: curve.toLowerCase(), file: Number(to), to: Number(to) };
        written++;
        d.log(`${token}: ${old ? 'from ' + old.to : 'new'} to ${to}, ${fresh} new logs`);
        held = file;
      }
      // ITS NUMBERS, LAST: a quote asset that answers no decimals() fails the
      // launch's numbers - its entry stays as it was - and not its file.
      const quote = addrAt(st, 2);
      stats[token.toLowerCase()] = launchStats(held, { status, quote, quoteDecimals: await decimalsOf(quote), currency0: addrAt(st, 9) });
    } catch (e) {
      failed++;
      d.log(`launch ${i} ${token}: ${(e as Error).message}`);
    }
  }
  // WRITTEN AFTER THE FILES IT SPEAKS FOR, and only when it says something new.
  if (JSON.stringify(checked) !== JSON.stringify(before)) {
    const body: CheckedFile = { schema: CHECKED_SCHEMA, chainId: d.chainId, launches: checked };
    await d.write(checkedPath(d.chainId), new Uint8Array(Buffer.from(JSON.stringify(body))), `history checked to ${to}`);
  }
  // AND THE NUMBERS, LAST, and only when they changed: the run's block alone
  // is no change, or every run would be a commit.
  if (JSON.stringify(stats) !== JSON.stringify(statsBefore)) {
    const body: StatsFile = {
      schema: STATS_SCHEMA,
      chainId: d.chainId,
      generatedAt: { block: Number(to), timestamp: Number(toTs) },
      launches: stats,
      totals: totalsOf(stats),
    };
    await d.write(statsPath(d.chainId), new Uint8Array(Buffer.from(JSON.stringify(body))), `stats to ${to}`);
  }
  return { launches: count, written, failed };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dry = argv[0] === '--dry' ? argv[1] : '';
  const cfg = loadOpsConfig(process.env.CURB_SHARER_CONFIG || 'deploy/sharer.json');
  const urls = readRpcUrls('rpc_urls');
  if (!urls.length) throw new Error('no RPC: set the rpc_urls secret');
  const rpc = httpRpc(urls[0].reveal(), { label: 'a' });
  const chainId = Number(cfg.sharing.chainId);
  const registry = cfg.registry;
  const lens = cfg.lens;
  if (!registry || !lens) throw new Error('the config names no registry or no lens');
  let read: IndexDeps['read'];
  let write: IndexDeps['write'];
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
  const r = await indexAll({ rpc, chainId, registry, lens, read, write, log: (l) => console.log(l) });
  console.log(JSON.stringify({ mode: 'history', ...r }));
  if (r.failed) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('index-history.ts')) {
  main().catch((e) => {
    console.error((e as Error).message);
    process.exit(1);
  });
}
