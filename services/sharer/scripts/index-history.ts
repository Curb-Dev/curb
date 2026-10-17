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
      // NOTHING NEW SINCE THE FILE: it is complete up to this run's block.
      if (old && fresh === 0 && to - BigInt(old.to) < REWRITE_AFTER) {
        checked[token.toLowerCase()] = { curve: curve.toLowerCase(), file: old.to, to: Number(to) };
        continue;
      }
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
