// eth_getLogs over a block range of any size, in windows that adapt to what
// the endpoint refuses - the same rules as the app's launch-time scan
// (web/browse.js logError, commit 22cb55bf):
//
// A REFUSED RANGE AND A REFUSED REQUEST ARE DIFFERENT THINGS. Only a range or
// result-size refusal halves the window; a 429, a timeout or a page that is
// not JSON is asked again after a pause, with the window as it was.
//
// A RANGE CEILING HOLDS ("eth_getLogs is limited to a 2,000 range"); a
// RESULT-SIZE CEILING was about those blocks, not every block, so after
// enough windows served under it the window is tried above it again.
//
// SIZE IS ASKED BEFORE RANGE: the real result-size refusals name a block
// range too (Infura's "query returned more than 10000 results. Try with this
// block range [..]", Alchemy's "Log response size exceeded. You can make
// eth_getLogs requests with up to a 2K block range ..."); asked the other way
// round they would be filed as fixed ceilings that never grow back.

import type { Rpc } from './rpc.ts';

export type LogRefusal = 'busy' | 'size' | 'range';

/** Everything an error (and the errors it wraps, as viem does) says about
 *  itself: HTTP statuses, JSON-RPC codes and message text. */
function describe(e: unknown): { statuses: number[]; codes: number[]; text: string } {
  const statuses: number[] = [];
  const codes: number[] = [];
  const texts: string[] = [];
  let cur: any = e;
  for (let depth = 0; cur && depth < 8; depth++) {
    if (typeof cur.status === 'number') statuses.push(cur.status);
    if (typeof cur.code === 'number') codes.push(cur.code);
    for (const k of ['message', 'shortMessage', 'details']) if (typeof cur[k] === 'string') texts.push(cur[k]);
    cur = cur.cause;
  }
  return { statuses, codes, text: texts.join(' | ') };
}

/** WHAT KIND OF REFUSAL. "size": too many results or too large a response
 *  (-32005, "more than N results", "response size"). "range": the window was
 *  too wide, said in so many words. Anything else - a 429, "rate limit", a
 *  timeout, a page that is not JSON, an unknown error - is "busy". */
export function classifyLogError(e: unknown): LogRefusal {
  const { statuses, codes, text } = describe(e);
  if (statuses.includes(429) || codes.includes(429) || /rate|too many requests|timeout|timed out/i.test(text)) return 'busy';
  if (codes.includes(-32005) || /more than [\d,]+ (results|logs)|query returned|too many (results|logs)|response size|size exceed/i.test(text)) {
    return 'size';
  }
  if (/range|too many blocks|limit exceeded/i.test(text)) return 'range';
  return 'busy';
}

export interface LogWindowOptions {
  /** The first window asked for (blocks). */
  initial: number;
  /** Never ask for more than this. */
  max: number;
  /** A refusal at this window size is final. */
  min: number;
  /** A request refused for no stated reason is asked again this many times... */
  tries: number;
  /** ...after backoffMs, then doubling. */
  backoffMs: number;
  /** Windows served at a result-size ceiling before asking above it. */
  sizeRegrow: number;
  sleep: (ms: number) => Promise<void>;
}

export const DEFAULT_LOG_WINDOW: LogWindowOptions = {
  initial: 2000,
  max: 100_000,
  min: 1,
  tries: 4,
  backoffMs: 500,
  sizeRegrow: 16,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** What one endpoint has taught the reader about its log limits. Kept per
 *  endpoint across calls, so a ceiling found once is not asked above again
 *  (unless it was a result-size ceiling). */
export class LogWindow {
  window: number;
  cap: number;
  capIsSize = false;
  served = 0;
  readonly opts: LogWindowOptions;
  constructor(opts: Partial<LogWindowOptions> = {}) {
    this.opts = { ...DEFAULT_LOG_WINDOW, ...opts };
    this.window = this.opts.initial;
    this.cap = this.opts.max;
  }
}

export class LogWindowError extends Error {
  readonly kind: LogRefusal;
  constructor(message: string, kind: LogRefusal, cause: unknown) {
    super(message, { cause });
    this.name = 'LogWindowError';
    this.kind = kind;
  }
}

export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  transactionIndex?: string;
  logIndex: string;
  removed?: boolean;
  blockTimestamp?: string;
}

export interface LogFilter {
  address: string | string[];
  topics?: (string | string[] | null)[];
}

const hex = (n: bigint): string => '0x' + n.toString(16);

/** Every log matching `filter` with fromBlock <= block <= toBlock, in
 *  (block, logIndex) order. Each answer is checked: inside the window asked
 *  for, from an address asked for, not removed, no (block, logIndex) twice. */
export async function getLogsAdaptive(rpc: Rpc, filter: LogFilter, fromBlock: bigint, toBlock: bigint, win: LogWindow = new LogWindow()): Promise<RawLog[]> {
  const o = win.opts;
  const out: RawLog[] = [];
  const addresses = new Set((Array.isArray(filter.address) ? filter.address : [filter.address]).map((a) => a.toLowerCase()));
  let cursor = fromBlock;
  let busy = 0;
  while (cursor <= toBlock) {
    const end = toBlock < cursor + BigInt(win.window) - 1n ? toBlock : cursor + BigInt(win.window) - 1n;
    let logs: unknown;
    try {
      logs = await rpc.request({ method: 'eth_getLogs', params: [{ ...filter, fromBlock: hex(cursor), toBlock: hex(end) }] });
    } catch (e) {
      const kind = classifyLogError(e);
      if (kind === 'busy') {
        // REFUSED NOW, NOT REFUSED THIS RANGE: the same window after a pause.
        busy += 1;
        if (busy > o.tries) throw new LogWindowError(`eth_getLogs refused ${busy} times in a row: ${(e as Error).message}`, kind, e);
        await o.sleep(o.backoffMs * 2 ** (busy - 1));
        continue;
      }
      // A RANGE OR RESULT LIMIT: ask for less, down to a floor, and remember
      // the ceiling so the next window does not ask for too much again.
      const span = Number(end - cursor + 1n);
      if (span <= o.min) throw new LogWindowError(`eth_getLogs refused a ${span}-block window (${kind}): ${(e as Error).message}`, kind, e);
      win.window = Math.max(o.min, Math.floor(span / 2));
      win.cap = win.window;
      win.capIsSize = kind === 'size';
      win.served = 0;
      continue;
    }
    busy = 0;
    if (!Array.isArray(logs)) throw new Error('eth_getLogs answered something that is not a list');
    for (const l of logs as RawLog[]) {
      const b = BigInt(l.blockNumber);
      if (b < cursor || b > end) throw new Error(`eth_getLogs answered a log of block ${b} for the window ${cursor}..${end}`);
      if (!addresses.has(String(l.address).toLowerCase())) throw new Error(`eth_getLogs answered a log of ${l.address}, which was not asked for`);
      if (l.removed === true) throw new Error('eth_getLogs answered a removed log');
      out.push(l);
    }
    cursor = end + 1n;
    if (win.window < win.cap) {
      win.window = Math.min(win.cap, win.window * 2);
    } else if (win.capIsSize && ++win.served >= o.sizeRegrow && win.cap < o.max) {
      // A RESULT-SIZE CEILING WAS ABOUT THOSE BLOCKS, not every block.
      win.cap = Math.min(o.max, win.cap * 2);
      win.served = 0;
    }
  }
  out.sort((x, y) => {
    const bx = BigInt(x.blockNumber);
    const by = BigInt(y.blockNumber);
    if (bx !== by) return bx < by ? -1 : 1;
    const ix = BigInt(x.logIndex);
    const iy = BigInt(y.logIndex);
    return ix < iy ? -1 : ix > iy ? 1 : 0;
  });
  for (let i = 1; i < out.length; i++) {
    if (BigInt(out[i].blockNumber) === BigInt(out[i - 1].blockNumber) && BigInt(out[i].logIndex) === BigInt(out[i - 1].logIndex)) {
      throw new Error(`eth_getLogs answered two logs at block ${BigInt(out[i].blockNumber)} index ${BigInt(out[i].logIndex)}`);
    }
  }
  return out;
}
