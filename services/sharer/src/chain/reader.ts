// Typed chain reads over an Rpc, with the checks every answer gets before the
// indexer uses it. One ChainReader per provider; the epoch pipeline compares
// two of them (epoch.ts).

import { decodeFunctionResult, encodeFunctionData, type Abi } from 'viem';
import { decodeProbeAnswer, PROBE_FROM, PROBE_REQUEST_GAS, probeRequest } from './probe.ts';
import { getLogsAdaptive, LogWindow, RequestStopped, type LogFilter, type LogWindowOptions, type RawLog } from './logs.ts';
import type { Rpc } from './rpc.ts';

export interface BlockHeader {
  number: bigint;
  hash: string;
  parentHash: string;
  timestamp: bigint;
}

export interface TxInfo {
  hash: string;
  from: string;
  to: string | null;
  input: string;
  blockNumber: bigint;
}

export interface ReceiptInfo {
  hash: string;
  from: string;
  to: string | null;
  blockNumber: bigint;
  blockHash: string;
  status: boolean;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  /** OP-stack L1 data fee; 0 when the receipt carries none. */
  l1Fee: bigint;
  logs: RawLog[];
}

export interface CallResult {
  success: boolean;
  returnData: string;
}

export interface ReaderOptions {
  logWindow?: Partial<LogWindowOptions>;
  /** Retries of a request that failed for a transient reason. */
  tries?: number;
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const hexOf = (n: bigint): string => '0x' + n.toString(16);
const lower = (a: string | null | undefined): string | null => (typeof a === 'string' ? a.toLowerCase() : null);

function big(x: unknown, what: string): bigint {
  if (typeof x !== 'string' || !/^0x[0-9a-fA-F]+$/.test(x)) throw new Error(`${what}: not a hex quantity: ${String(x)}`);
  return BigInt(x);
}

function isHash(x: unknown): x is string {
  return typeof x === 'string' && /^0x[0-9a-fA-F]{64}$/.test(x);
}

/** A transport failure worth asking again: a 429 or 5xx, a timeout, a dropped
 *  connection, a page that is not JSON. A revert or a refused method is not,
 *  nor a request its caller withdrew (RequestStopped). */
export function isTransient(e: unknown): boolean {
  if (e instanceof RequestStopped) return false;
  let cur: any = e;
  for (let d = 0; cur && d < 8; d++) {
    if (cur.status === 429 || (typeof cur.status === 'number' && cur.status >= 500) || cur.code === 429) return true;
    const t = [cur.message, cur.shortMessage, cur.details].filter((x) => typeof x === 'string').join(' ');
    if (/revert/i.test(t)) return false;
    if (/rate limit|too many requests|timeout|timed out|ECONNRESET|ECONNREFUSED|socket hang up|fetch failed|with no JSON/i.test(t)) return true;
    cur = cur.cause;
  }
  return false;
}

export class ChainReader {
  readonly rpc: Rpc;
  readonly label: string;
  readonly logWindow: LogWindow;
  /** How a request refused for a transient reason is asked again. */
  readonly opts: Required<Omit<ReaderOptions, 'logWindow'>>;
  private readonly blocks = new Map<bigint, BlockHeader>();
  private readonly logTimes = new Map<bigint, bigint>();

  constructor(rpc: Rpc, opts: ReaderOptions = {}) {
    this.rpc = rpc;
    this.label = rpc.label ?? 'rpc';
    this.logWindow = new LogWindow(opts.logWindow);
    this.opts = {
      tries: opts.tries ?? 4,
      backoffMs: opts.backoffMs ?? 500,
      sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    };
  }

  /** One request, asked again after a pause when it failed transiently. */
  async request(method: string, params: unknown[]): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.rpc.request({ method, params });
      } catch (e) {
        if (!isTransient(e) || attempt >= this.opts.tries) throw e;
        await this.opts.sleep(this.opts.backoffMs * 2 ** attempt);
      }
    }
  }

  async chainId(): Promise<bigint> {
    return big(await this.request('eth_chainId', []), 'eth_chainId');
  }

  private header(raw: any, what: string): BlockHeader {
    if (!raw || typeof raw !== 'object') throw new Error(`${this.label}: no block for ${what}`);
    if (!isHash(raw.hash) || !isHash(raw.parentHash)) throw new Error(`${this.label}: block ${what} has no hash`);
    return { number: big(raw.number, 'block.number'), hash: raw.hash.toLowerCase(), parentHash: raw.parentHash.toLowerCase(), timestamp: big(raw.timestamp, 'block.timestamp') };
  }

  /** The `safe` (or another tagged) head. */
  async head(tag: 'safe' | 'finalized' | 'latest' = 'safe'): Promise<BlockHeader> {
    const h = this.header(await this.request('eth_getBlockByNumber', [tag, false]), tag);
    return h;
  }

  async block(n: bigint): Promise<BlockHeader> {
    const hit = this.blocks.get(n);
    if (hit) return hit;
    const h = this.header(await this.request('eth_getBlockByNumber', [hexOf(n), false]), `#${n}`);
    if (h.number !== n) throw new Error(`${this.label}: asked for block ${n}, got ${h.number}`);
    this.blocks.set(n, h);
    return h;
  }

  /** Several block headers, asked concurrently (a few at a time). */
  async blocksOf(ns: bigint[], concurrency = 16): Promise<Map<bigint, BlockHeader>> {
    const out = new Map<bigint, BlockHeader>();
    const todo = [...new Set(ns)];
    let i = 0;
    const worker = async (): Promise<void> => {
      while (i < todo.length) {
        const n = todo[i++];
        out.set(n, await this.block(n));
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
    return out;
  }

  /** Keeps the block timestamps logs carried (`blockTimestamp`, where the node
   *  provides it), so those headers need not be asked for. */
  noteLogTimestamps(logs: RawLog[]): void {
    for (const l of logs) {
      if (typeof l.blockTimestamp !== 'string') continue;
      const b = big(l.blockNumber, 'log.blockNumber');
      const t = big(l.blockTimestamp, 'log.blockTimestamp');
      const had = this.logTimes.get(b);
      if (had !== undefined && had !== t) throw new Error(`${this.label}: two logs of block ${b} carry different timestamps`);
      this.logTimes.set(b, t);
    }
  }

  /** The timestamp of each block: from a log that carried it, else its header. */
  async timestamps(ns: bigint[]): Promise<Map<bigint, bigint>> {
    const out = new Map<bigint, bigint>();
    const ask: bigint[] = [];
    for (const n of new Set(ns)) {
      const t = this.logTimes.get(n);
      if (t !== undefined) out.set(n, t);
      else ask.push(n);
    }
    for (const [n, h] of await this.blocksOf(ask)) out.set(n, h.timestamp);
    return out;
  }

  /** One eth_call at `block`, for the launch's own contracts (the
   *  distributor, the Graduator, the registry, the curve). Calls to addresses
   *  an outsider can name go through callMany. */
  async rawCall(to: string, data: string, block: bigint): Promise<string> {
    const r = await this.request('eth_call', [{ to, data }, hexOf(block)]);
    if (typeof r !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(r)) throw new Error(`${this.label}: eth_call answered ${String(r)}`);
    return r.toLowerCase();
  }

  async read<T = unknown>(abi: Abi, to: string, functionName: string, args: readonly unknown[], block: bigint): Promise<T> {
    const data = encodeFunctionData({ abi, functionName, args } as any);
    const raw = await this.rawCall(to, data, block);
    return decodeFunctionResult({ abi, functionName, data: raw as `0x${string}` } as any) as T;
  }

  /** Many read calls at one block, each allowed to fail, through the probe
   *  (probe.ts): every call gets exactly PROBE_CALL_GAS, wherever it stands,
   *  on every provider. Each request answers the calls from where the last
   *  one stopped; nothing is asked twice. A request that fails, or answers in
   *  any other shape, is an error - never a list of failed calls. */
  async callMany(calls: { to: string; data: string }[], block: bigint): Promise<CallResult[]> {
    const out: CallResult[] = [];
    while (out.length < calls.length) {
      const req = probeRequest(calls, out.length);
      const raw = await this.request('eth_call', [{ from: PROBE_FROM, data: req.data, gas: hexOf(PROBE_REQUEST_GAS) }, hexOf(block)]);
      const got = decodeProbeAnswer(raw, req.count);
      if (got.length === 0) throw new Error(`${this.label}: the probe answered none of ${req.count} calls`);
      out.push(...got);
    }
    return out;
  }

  async code(addr: string, block: bigint): Promise<string> {
    const r = await this.request('eth_getCode', [addr, hexOf(block)]);
    if (typeof r !== 'string') throw new Error(`${this.label}: eth_getCode answered ${String(r)}`);
    return r.toLowerCase();
  }

  async tx(hash: string): Promise<TxInfo> {
    const t = await this.request('eth_getTransactionByHash', [hash]);
    if (!t) throw new Error(`${this.label}: no transaction ${hash}`);
    if (t.blockNumber == null) throw new Error(`${this.label}: transaction ${hash} is not in a block`);
    return this.txInfo(hash, t);
  }

  /** A transaction that is in a block; null when the provider does not know
   *  it, or it is not mined (yet, or ever: one replaced at its nonce). */
  async minedTx(hash: string): Promise<TxInfo | null> {
    const t = await this.request('eth_getTransactionByHash', [hash]);
    if (!t || t.blockNumber == null) return null;
    return this.txInfo(hash, t);
  }

  private txInfo(hash: string, t: any): TxInfo {
    if (lower(t.hash) !== hash.toLowerCase()) throw new Error(`${this.label}: asked for tx ${hash}, got ${t.hash}`);
    return { hash: hash.toLowerCase(), from: lower(t.from)!, to: lower(t.to), input: String(t.input ?? t.data ?? '0x').toLowerCase(), blockNumber: big(t.blockNumber, 'tx.blockNumber') };
  }

  async receipt(hash: string): Promise<ReceiptInfo> {
    const r = await this.request('eth_getTransactionReceipt', [hash]);
    if (!r) throw new Error(`${this.label}: no receipt for ${hash}`);
    if (lower(r.transactionHash) !== hash.toLowerCase()) throw new Error(`${this.label}: asked for the receipt of ${hash}, got ${r.transactionHash}`);
    return {
      hash: hash.toLowerCase(),
      from: lower(r.from)!,
      to: lower(r.to),
      blockNumber: big(r.blockNumber, 'receipt.blockNumber'),
      blockHash: String(r.blockHash).toLowerCase(),
      status: big(r.status, 'receipt.status') === 1n,
      gasUsed: big(r.gasUsed, 'receipt.gasUsed'),
      effectiveGasPrice: big(r.effectiveGasPrice, 'receipt.effectiveGasPrice'),
      l1Fee: r.l1Fee == null ? 0n : big(r.l1Fee, 'receipt.l1Fee'),
      logs: Array.isArray(r.logs) ? r.logs : [],
    };
  }

  /** Every matching log in [from, to], in adaptive windows (logs.ts). */
  logs(filter: LogFilter, from: bigint, to: bigint): Promise<RawLog[]> {
    return getLogsAdaptive(this.rpc, filter, from, to, this.logWindow);
  }
}

/** `r`, stopped by `signal`: once it aborts, a request in flight is
 *  abandoned and every later one throws at once, so a check abandoned at its
 *  deadline (the guardian's recompute, its event lookups) ends at its next
 *  read instead of running on in the background. Caches stay shared. What
 *  it throws is a RequestStopped, which no reader asks again (logs.ts): an
 *  eth_getLogs refused "busy" would otherwise wait out its whole backoff. */
export function stoppable(r: ChainReader, signal: AbortSignal): ChainReader {
  const inner = r.rpc;
  const rpc: Rpc = {
    label: inner.label,
    request: (a) => {
      if (signal.aborted) return Promise.reject(new RequestStopped(signal.reason));
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(new RequestStopped(signal.reason));
        signal.addEventListener('abort', onAbort, { once: true });
        inner.request(a).then(
          (v) => {
            signal.removeEventListener('abort', onAbort);
            resolve(v);
          },
          (e) => {
            signal.removeEventListener('abort', onAbort);
            reject(e);
          },
        );
      });
    },
  };
  const w = Object.create(r) as ChainReader;
  Object.defineProperty(w, 'rpc', { value: rpc });
  return w;
}

/** What a provider is stopped with when another provider has failed: no
 *  failure of its own. */
class AnotherProviderFailed extends Error {
  constructor() {
    super('stopped: another provider failed first');
    this.name = 'AnotherProviderFailed';
  }
}

/** `work` on every provider AT ONCE, the answers in reader order. A check
 *  takes the slower provider's time, not the sum of both: read one after
 *  the other, a busy launch's hour-long epoch took about 70 s of a check's
 *  120 on the free pair, and both providers' reads are needed anyway.
 *
 *  Nothing is compared here; the caller compares the answers as before. When
 *  one provider fails, the others are of no use any more and are stopped at
 *  their next request (each works through a stoppable reader). What is thrown
 *  is the first failure, in reader order, that is a provider's own - never a
 *  provider's being stopped because another failed - so the error is the one
 *  a provider gave, whichever finished first. `signal` stops them all, and
 *  then its reason is thrown. */
export async function onEveryProvider<T>(readers: ChainReader[], work: (r: ChainReader, signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T[]> {
  const ctl = new AbortController();
  const failedFirst = new AnotherProviderFailed();
  const outer = () => ctl.abort(signal!.reason);
  if (signal?.aborted) ctl.abort(signal.reason);
  else signal?.addEventListener('abort', outer, { once: true });
  const one = async (r: ChainReader): Promise<T> => {
    try {
      return await work(stoppable(r, ctl.signal), ctl.signal);
    } catch (e) {
      if (!ctl.signal.aborted) ctl.abort(failedFirst);
      throw e;
    }
  };
  try {
    const settled = await Promise.allSettled(readers.map(one));
    signal?.throwIfAborted();
    const failed = settled.flatMap((x) => (x.status === 'rejected' ? [x.reason] : []));
    const stopped = (e: unknown) => e === failedFirst || (e instanceof RequestStopped && e.cause === failedFirst);
    if (failed.length) throw failed.find((e) => !stopped(e)) ?? failed[0];
    return settled.map((x) => (x as PromiseFulfilledResult<T>).value);
  } finally {
    signal?.removeEventListener('abort', outer);
  }
}
