// CURB public product-event announcer.
//
// Reads Base's safe chain, sends only to @CurbAnnouncements, and persists its
// cursor and per-launch threshold flags in the same data repository as the
// history index. With no ANNOUNCER_TELEGRAM it is a read-only dry run.

import { readFileSync } from 'node:fs';
import { decodeFunctionResult, encodeFunctionData, parseAbi, toEventSelector } from 'viem';
import {
  ANNOUNCER_SCHEMA,
  END_OF_BLOCK,
  TelegramSender,
  parseAnnouncerState,
  parseTelegramConfig,
  processEvents,
  type AnnouncerState,
  type ChainEvent,
  type LaunchRecord,
  type Position,
} from '../src/announcer.ts';
import { getLogsAdaptive, LogWindow, type RawLog } from '../src/chain/logs.ts';
import { httpRpc, type Rpc } from '../src/chain/rpc.ts';
import { loadOpsConfig, type OpsConfig } from '../src/ops/config.ts';
import { DataRepo } from '../src/ops/github.ts';
import { readRpcUrls, readSecret, registerSecret, redact } from '../src/ops/secrets.ts';

const REGISTRY_ABI = parseAbi([
  'function launchCount() view returns (uint256)',
  'function launchAt(uint256) view returns (address)',
  'function launchOf(address) view returns ((address curve,address quoteToken,address beneficiary,address refundTo,uint256 reservedZero,uint24 fee,int24 tickSpacing,address hooks,uint16 totalTaxBps,uint16 platformBps,address platformRecipient,uint64 launchedAt))',
]);
const LENS_ABI = parseAbi([
  'function launchState(address) view returns ((uint8 status,address curve,address quoteToken,address beneficiary,uint256 quoteReserve,uint256 tokenReserve,uint256 realQuoteReserve,uint256 graduationThreshold,uint256 totalSupply,(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,uint64 launchedAt,address holderDistributor))',
]);
const CURVE_ABI = parseAbi([
  'function pairToken() view returns (address)',
  'function graduationThreshold() view returns (uint256)',
]);
const ERC20_ABI = parseAbi(['function name() view returns (string)', 'function symbol() view returns (string)']);

const TOPIC = {
  registered: toEventSelector('LaunchRegistered(address,address,address)'),
  launch: toEventSelector('LaunchCreated(address,address,address,uint256,uint16)'),
  buy: toEventSelector('CurveBuy(address,address,uint256,uint256,uint256,uint256)'),
  sell: toEventSelector('CurveSell(address,address,uint256,uint256,uint256,uint256)'),
  graduated: toEventSelector('Graduated(address,address,uint256,uint160,uint128)'),
};

const STATE_PATH = (chainId: number): string => `sharing/${chainId}/announcer/state.json`;
const addr = (x: string): string => ('0x' + x.replace(/^0x/, '').slice(-40)).toLowerCase();
const word = (hex: string, i: number): string => hex.replace(/^0x/, '').slice(i * 64, (i + 1) * 64);
const uint = (hex: string, i: number): bigint => BigInt('0x' + (word(hex, i) || '0'));
const position = (l: RawLog): Position => ({ block: Number(BigInt(l.blockNumber)), logIndex: Number(BigInt(l.logIndex)) });

async function call<T extends readonly unknown[]>(rpc: Rpc, address: string, abi: any, functionName: string, args: T = [] as unknown as T, block = 'latest'): Promise<any> {
  const data = encodeFunctionData({ abi, functionName: functionName as any, args: args as any });
  const result = String(await rpc.request({ method: 'eth_call', params: [{ to: address, data }, block] }));
  return decodeFunctionResult({ abi, functionName: functionName as any, data: result as `0x${string}` });
}

async function tokenString(rpc: Rpc, token: string, functionName: 'name' | 'symbol', fallback: string): Promise<string> {
  try {
    const value = await call(rpc, token, ERC20_ABI, functionName);
    return typeof value === 'string' && value ? value : fallback;
  } catch {
    return fallback;
  }
}

export interface HideConfig {
  launches: Set<string>;
  factories: Set<string>;
}

/** The incident switches are static arrays in web/config.js. We parse only
 * address literals from those two arrays; the browser file is never executed. */
export function readHideConfig(path: string): HideConfig {
  const source = readFileSync(path, 'utf8');
  const list = (key: string): Set<string> => {
    const hit = source.match(new RegExp(`${key}\\s*:\\s*\\[([\\s\\S]*?)\\]`));
    if (!hit) throw new Error(`web config has no ${key} array`);
    return new Set((hit[1].match(/0x[0-9a-fA-F]{40}/g) ?? []).map((x) => x.toLowerCase()));
  };
  return { launches: list('hiddenLaunches'), factories: list('hiddenFactories') };
}

function hidden(h: HideConfig, token: string, factory: string): boolean {
  return h.launches.has(token.toLowerCase()) || (!!factory && h.factories.has(factory.toLowerCase()));
}

interface FactoryLaunch {
  token: string;
  curve: string;
  factory: string;
  totalTaxBps: number;
}

function factoryLaunch(l: RawLog): FactoryLaunch {
  return {
    token: addr(l.topics[1]),
    curve: addr(l.topics[2]),
    factory: l.address.toLowerCase(),
    totalTaxBps: Number(uint(l.data, 1)),
  };
}

export async function readRecord(
  rpc: Rpc,
  cfg: OpsConfig,
  hides: HideConfig,
  token: string,
  known?: Partial<FactoryLaunch>,
  baseline?: { curve: string; quote: string; reserve: bigint; threshold: bigint; graduated: boolean; totalTaxBps?: number },
): Promise<LaunchRecord> {
  token = token.toLowerCase();
  let curve = known?.curve?.toLowerCase() ?? baseline?.curve.toLowerCase() ?? '';
  let quote = baseline?.quote.toLowerCase() ?? '';
  let threshold = baseline?.threshold;
  let totalTaxBps = known?.totalTaxBps ?? baseline?.totalTaxBps;
  if (!curve || !quote || threshold === undefined || totalTaxBps === undefined) {
    const rec = await call(rpc, cfg.registry!, REGISTRY_ABI, 'launchOf', [token]) as {
      curve: string;
      quoteToken: string;
      totalTaxBps: number;
    };
    curve ||= String(rec.curve).toLowerCase();
    quote ||= String(rec.quoteToken).toLowerCase();
    totalTaxBps ??= Number(rec.totalTaxBps);
  }
  if (threshold === undefined) threshold = BigInt(await call(rpc, curve, CURVE_ABI, 'graduationThreshold'));
  if (!quote) quote = String(await call(rpc, curve, CURVE_ABI, 'pairToken')).toLowerCase();
  const factory = known?.factory?.toLowerCase() ?? '';
  const name = await tokenString(rpc, token, 'name', 'Unnamed launch');
  const symbol = await tokenString(rpc, token, 'symbol', token.slice(2, 8).toUpperCase());
  const quoteSymbol = quote === cfg.sharing.weth.toLowerCase() ? 'ETH' : await tokenString(rpc, quote, 'symbol', quote.slice(2, 8).toUpperCase());
  const reserve = baseline?.reserve ?? 0n;
  const graduated = baseline?.graduated ?? false;
  return {
    token,
    curve,
    factory,
    name: Array.from(name).slice(0, 40).join(''),
    symbol: Array.from(symbol).slice(0, 20).join(''),
    quoteSymbol: Array.from(quoteSymbol).slice(0, 20).join(''),
    totalTaxBps: totalTaxBps ?? 0,
    threshold: threshold.toString(),
    reserve: reserve.toString(),
    crossed50: threshold > 0n && reserve * 100n >= threshold * 50n,
    crossed90: threshold > 0n && reserve * 100n >= threshold * 90n,
    graduated,
    hidden: hidden(hides, token, factory),
  };
}

async function factoryHistory(rpc: Rpc, cfg: OpsConfig, to: bigint): Promise<Map<string, FactoryLaunch>> {
  const out = new Map<string, FactoryLaunch>();
  if (!cfg.launchers.length || cfg.eventsFromBlock > to) return out;
  const logs = await getLogsAdaptive(rpc, { address: cfg.launchers, topics: [TOPIC.launch] }, cfg.eventsFromBlock, to, new LogWindow());
  for (const l of logs) {
    const f = factoryLaunch(l);
    out.set(f.token, f);
  }
  return out;
}

async function baselineState(rpc: Rpc, cfg: OpsConfig, hides: HideConfig, safe: number): Promise<AnnouncerState> {
  const factories = await factoryHistory(rpc, cfg, BigInt(safe));
  const block = `0x${safe.toString(16)}`;
  const count = Number(await call(rpc, cfg.registry!, REGISTRY_ABI, 'launchCount', [], block));
  if (!Number.isSafeInteger(count) || count < 0 || count > 100_000) throw new Error(`registry reports ${count} launches`);
  const launches: Record<string, LaunchRecord> = {};
  for (let i = 0; i < count; i++) {
    const token = String(await call(rpc, cfg.registry!, REGISTRY_ABI, 'launchAt', [BigInt(i)], block)).toLowerCase();
    const v = await call(rpc, cfg.lens!, LENS_ABI, 'launchState', [token], block) as readonly [number, string, string, string, bigint, bigint, bigint, bigint];
    launches[token] = await readRecord(rpc, cfg, hides, token, factories.get(token), {
      curve: String(v[1]), quote: String(v[2]), reserve: BigInt(v[6]), threshold: BigInt(v[7]), graduated: Number(v[0]) === 3,
    });
  }
  return { schema: ANNOUNCER_SCHEMA, chainId: Number(cfg.sharing.chainId), cursor: { block: safe, logIndex: END_OF_BLOCK }, launches };
}

function unique<T>(xs: T[]): T[] { return [...new Set(xs)]; }

async function scanEvents(rpc: Rpc, cfg: OpsConfig, hides: HideConfig, state: AnnouncerState, safe: number): Promise<ChainEvent[]> {
  const from = state.cursor.logIndex === END_OF_BLOCK ? BigInt(state.cursor.block + 1) : BigInt(state.cursor.block);
  const to = BigInt(safe);
  if (from > to) return [];
  const [registered, created, graduated] = await Promise.all([
    getLogsAdaptive(rpc, { address: cfg.registry!, topics: [TOPIC.registered] }, from, to, new LogWindow()),
    cfg.launchers.length ? getLogsAdaptive(rpc, { address: cfg.launchers, topics: [TOPIC.launch] }, from, to, new LogWindow()) : Promise.resolve([]),
    getLogsAdaptive(rpc, { address: cfg.sharing.graduator, topics: [TOPIC.graduated] }, from, to, new LogWindow()),
  ]);
  const found = new Map<string, FactoryLaunch>();
  for (const l of created) {
    const f = factoryLaunch(l);
    found.set(f.token, f);
  }
  const curveToToken = new Map<string, string>();
  for (const l of Object.values(state.launches)) curveToToken.set(l.curve, l.token);
  for (const l of registered) curveToToken.set(addr(l.topics[2]), addr(l.topics[1]));
  for (const f of found.values()) curveToToken.set(f.curve, f.token);
  const curves = unique([...curveToToken.keys()]);
  const trades = curves.length
    ? await getLogsAdaptive(rpc, { address: curves, topics: [[TOPIC.buy, TOPIC.sell]] }, from, to, new LogWindow())
    : [];

  const records = new Map<string, LaunchRecord>();
  const record = async (token: string, curve?: string): Promise<LaunchRecord> => {
    token = token.toLowerCase();
    const cached = records.get(token);
    if (cached) return cached;
    const old = state.launches[token];
    const known = found.get(token) ?? (old ? { token, curve: old.curve, factory: old.factory, totalTaxBps: old.totalTaxBps } : curve ? { token, curve, factory: '' } : undefined);
    const value = await readRecord(rpc, cfg, hides, token, known);
    records.set(token, value);
    return value;
  };

  const events: ChainEvent[] = [];
  for (const l of registered) {
    const token = addr(l.topics[1]), curve = addr(l.topics[2]);
    events.push({ kind: 'registered', position: position(l), transactionHash: l.transactionHash.toLowerCase(), launch: await record(token, curve) });
  }
  for (const l of created) {
    const f = factoryLaunch(l);
    events.push({ kind: 'launch', position: position(l), transactionHash: l.transactionHash.toLowerCase(), launch: await record(f.token, f.curve) });
  }
  for (const l of trades) {
    const token = curveToToken.get(l.address.toLowerCase());
    if (!token) throw new Error(`no launch for curve ${l.address}`);
    if (l.topics[0].toLowerCase() === TOPIC.buy.toLowerCase()) {
      events.push({ kind: 'buy', position: position(l), transactionHash: l.transactionHash.toLowerCase(), token, quoteIn: uint(l.data, 0).toString(), fee: uint(l.data, 2).toString(), tax: uint(l.data, 3).toString() });
    } else {
      events.push({ kind: 'sell', position: position(l), transactionHash: l.transactionHash.toLowerCase(), token, quoteOut: uint(l.data, 1).toString(), fee: uint(l.data, 2).toString(), tax: uint(l.data, 3).toString() });
    }
  }
  for (const l of graduated) events.push({ kind: 'graduated', position: position(l), transactionHash: l.transactionHash.toLowerCase(), token: addr(l.topics[1]) });
  return events.sort((a, b) => a.position.block - b.position.block || a.position.logIndex - b.position.logIndex);
}

async function main(): Promise<void> {
  const cfg = loadOpsConfig(process.env.CURB_SHARER_CONFIG || 'deploy/sharer.json');
  if (!cfg.registry || !cfg.lens || !cfg.site || !cfg.dataRepo) throw new Error('announcer needs registry, lens, site and dataRepo in the sharer config');
  const urls = readRpcUrls('rpc_urls');
  if (!urls.length) throw new Error('no RPC: set CURB_SHARER_RPC_URLS');
  const repoToken = readSecret('data_repo_token');
  if (!repoToken) throw new Error('no data repo token: set CURB_SHARER_DATA_REPO_TOKEN');
  const telegram = parseTelegramConfig(process.env.ANNOUNCER_TELEGRAM);
  if (telegram) registerSecret(telegram.token);
  const dryRun = telegram === null;
  const rpc = httpRpc(urls[0].reveal(), { label: 'a' });
  const repo = new DataRepo({
    owner: cfg.dataRepo.owner,
    repo: cfg.dataRepo.repo,
    branch: cfg.dataRepo.branch,
    root: cfg.dataRepo.root,
    apiBase: cfg.dataRepo.apiBase,
    token: repoToken,
  });
  const chainId = Number(cfg.sharing.chainId);
  const path = STATE_PATH(chainId);
  const current = await repo.get(path);
  let state = parseAnnouncerState(current?.bytes ?? null, chainId);
  if (current && !state) throw new Error(`refusing malformed announcer state at ${path}`);
  const safeAnswer = await rpc.request({ method: 'eth_getBlockByNumber', params: ['safe', false] }) as { number?: string } | null;
  if (!safeAnswer?.number) throw new Error('the endpoint has no safe block');
  const safe = Number(BigInt(safeAnswer.number));
  const webConfig = process.env.CURB_WEB_CONFIG || '../../web/config.js';
  const hides = readHideConfig(webConfig);
  const persist = async (next: AnnouncerState): Promise<void> => {
    await repo.upsert(path, new Uint8Array(Buffer.from(JSON.stringify(next))), `announcer to ${next.cursor.block}:${next.cursor.logIndex}`);
  };

  if (!state) {
    state = await baselineState(rpc, cfg, hides, safe);
    if (dryRun) console.log(`DRY RUN: would initialize announcer at safe block ${safe}; no historical event will be sent`);
    else await persist(state);
    console.log(JSON.stringify({ mode: 'announcer', dryRun, initialized: true, block: safe, launches: Object.keys(state.launches).length }));
    return;
  }

  // Incident switches apply on every run, including launches discovered before
  // a factory or token was hidden.
  for (const l of Object.values(state.launches)) l.hidden = hidden(hides, l.token, l.factory);
  const events = await scanEvents(rpc, cfg, hides, state, safe);
  const sender = telegram ? new TelegramSender(telegram) : null;
  state = await processEvents(state, events, { block: safe, logIndex: END_OF_BLOCK }, {
    dryRun,
    siteBase: cfg.site.base,
    log: (line) => console.log(line),
    send: async (message) => sender!.send(message),
    persist,
  });
  console.log(JSON.stringify({ mode: 'announcer', dryRun, block: safe, events: events.length, launches: Object.keys(state.launches).length }));
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('announce.ts')) {
  main().catch((e) => {
    console.error(redact(e instanceof Error ? e.message : String(e)));
    process.exit(1);
  });
}
