// An in-memory chain that answers the JSON-RPC methods the sharer uses, with
// contracts written as small handlers and faults that can be injected (log
// range and result-size refusals, rate limits, a provider that lies).

import { decodeFunctionData, encodeFunctionResult, keccak256, toHex, type Abi } from 'viem';
import { PROBE_CALL_GAS, PROBE_INITCODE, PROBE_RETURN_CAP } from '../src/chain/probe.ts';
import { RpcError, type Rpc } from '../src/chain/rpc.ts';

export interface MockLog {
  address: string;
  topics: string[];
  data: string;
  block: bigint;
  logIndex: bigint;
  txHash: string;
}

export interface MockTx {
  hash: string;
  from: string;
  to: string | null;
  input: string;
  block: bigint;
  status?: boolean;
  gasUsed?: bigint;
  effectiveGasPrice?: bigint;
  l1Fee?: bigint | null;
  /** A receipt that names another block hash (a reorged receipt). */
  receiptBlockHash?: string;
}

/** A contract: answers raw calldata at a block, or throws to revert. */
export type Handler = (data: string, block: bigint) => string;

export class Revert extends Error {}

/** A call that used up all the gas it was given. */
export class OutOfGas extends Error {}

/** Builds a Handler from an ABI and functions returning decoded values. */
export function abiContract(abi: Abi, impl: Record<string, (args: readonly any[], block: bigint) => unknown>): Handler {
  return (data, block) => {
    let d;
    try {
      d = decodeFunctionData({ abi, data: data as `0x${string}` });
    } catch {
      throw new Revert('unknown selector');
    }
    const f = impl[d.functionName];
    if (!f) throw new Revert('not implemented: ' + d.functionName);
    const v = f(d.args ?? [], block);
    return encodeFunctionResult({ abi, functionName: d.functionName, result: v } as any);
  };
}

const hex = (n: bigint): string => '0x' + n.toString(16);

export interface Faults {
  /** eth_getLogs refuses a window wider than this, with this error. */
  rangeLimit?: { max: bigint; message: string; code?: number };
  /** eth_getLogs refuses an answer longer than this, with this error. */
  sizeLimit?: { max: number; message: string; code?: number };
  /** eth_getLogs calls allowed before the chain refuses every one (a test budget: a reader that loops forever fails its test instead of hanging it). */
  maxLogCalls?: number;
  /** Called before every request; may throw to fail it. */
  before?: (method: string, params: any[]) => void;
}

export class MockChain {
  chainId = 8453n;
  readonly headers = new Map<bigint, { hash: string; parentHash: string; timestamp: bigint }>();
  logs: MockLog[] = [];
  readonly txs = new Map<string, MockTx>();
  readonly contracts = new Map<string, Handler>();
  safe = 0n;
  latest = 0n;
  /** Put blockTimestamp on logs, as some nodes do. */
  logTimestamps = false;
  faults: Faults = {};
  /** Addresses whose code uses up whatever gas it is given, as precompile 0x08
   *  does for a token0() call or a contract whose code is 0xfe. On its own
   *  such a call fails with OutOfGas; inside the probe it fails and costs the
   *  request its whole PROBE_CALL_GAS. */
  readonly eaters = new Set<string>();
  readonly calls: { method: string; params: any[] }[] = [];
  salt = 'curb';

  hashOf(n: bigint): string {
    return keccak256(toHex(`${this.salt}:block:${n}`));
  }

  setBlock(n: bigint, timestamp: bigint): void {
    this.headers.set(n, { hash: this.hashOf(n), parentHash: this.hashOf(n - 1n), timestamp });
    if (n > this.latest) this.latest = n;
  }

  addLog(l: MockLog): void {
    this.logs.push({ ...l, address: l.address.toLowerCase() });
  }

  setContract(addr: string, h: Handler): void {
    this.contracts.set(addr.toLowerCase(), h);
  }

  count(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }

  private header(n: bigint): any {
    const h = this.headers.get(n);
    if (!h) return null;
    return { number: hex(n), hash: h.hash, parentHash: h.parentHash, timestamp: hex(h.timestamp) };
  }

  /** SharerProbe's constructor, run as a deployless eth_call: the same stop
   *  rule (a call is made only with gas for its whole PROBE_CALL_GAS and the
   *  deposit of the largest answer it could add; the output stays within
   *  EIP-170), the same answer format, and a simple cost model - an eater
   *  costs its whole PROBE_CALL_GAS, a contract 3,000, no code nothing, and
   *  each call 2,600 for its first access and 100 after. */
  private probe(data: string, gas: bigint, block: bigint): string {
    if (!data.toLowerCase().startsWith(PROBE_INITCODE)) throw new Revert('mock: a creation that is not SharerProbe');
    const hex = data.slice(PROBE_INITCODE.length).toLowerCase();
    const len = Number(BigInt('0x' + hex.slice(-64)));
    const packed = hex.slice(0, -64);
    if (packed.length !== len * 2) throw new Revert('mock: the probe length word is not the calls length');
    const bytes = (data.length - 2) / 2;
    let left = gas - 53_000n - 16n * BigInt(bytes);
    const NEED = PROBE_CALL_GAS + 2_600n + 1_000n;
    const seen = new Set<string>();
    let out = '';
    let outLen = 32;
    let n = 0;
    for (let p = 0; p < packed.length; ) {
      const to = '0x' + packed.slice(p, p + 40);
      const dlen = parseInt(packed.slice(p + 40, p + 44), 16);
      const cd = '0x' + packed.slice(p + 44, p + 44 + dlen * 2);
      if (p + 44 + dlen * 2 > packed.length) throw new Revert('mock: a probe record runs past the end');
      if (outLen + 192 > 24_576) break;
      if (left < NEED + 200n * BigInt(outLen + 192)) break;
      left -= seen.has(to) ? 100n : 2_600n;
      seen.add(to);
      let ok = true;
      let ret = '0x';
      if (this.eaters.has(to)) {
        ok = false;
        left -= PROBE_CALL_GAS;
      } else {
        const h = this.contracts.get(to);
        if (h) {
          left -= 3_000n;
          try {
            ret = h(cd, block);
          } catch (e) {
            if (!(e instanceof Revert)) throw e;
            ok = false;
          }
        }
      }
      const size = (ret.length - 2) / 2;
      out += ((ok ? 1n << 255n : 0n) | BigInt(ok ? size : 0)).toString(16).padStart(64, '0');
      outLen += 32;
      if (ok) {
        const c = Math.min(size, PROBE_RETURN_CAP);
        const padded = Math.ceil(c / 32) * 32;
        out += ret.slice(2, 2 + c * 2).padEnd(padded * 2, '0');
        outLen += padded;
      }
      p += 44 + dlen * 2;
      n++;
    }
    left -= 200n * BigInt(outLen);
    if (left < 0n) throw new OutOfGas();
    this.probeRequests.push(n);
    return '0x' + n.toString(16).padStart(64, '0') + out;
  }

  /** How many calls each probe request answered, in order. */
  readonly probeRequests: number[] = [];

  private call(to: string, data: string, block: bigint): string {
    const t = to.toLowerCase();
    if (this.eaters.has(t)) throw new OutOfGas();
    const h = this.contracts.get(t);
    if (!h) return '0x'; // no code: an empty success, as for an EOA
    return h(data, block);
  }

  private blockParam(p: string): bigint {
    if (p === 'latest') return this.latest;
    if (p === 'safe' || p === 'finalized') return this.safe;
    return BigInt(p);
  }

  readonly rpc = (label = 'mock'): Rpc => ({ label, request: (a) => this.request(a.method, (a.params ?? []) as any[]) });

  async request(method: string, params: any[]): Promise<unknown> {
    this.calls.push({ method, params });
    this.faults.before?.(method, params);
    switch (method) {
      case 'eth_chainId':
        return hex(this.chainId);
      case 'eth_blockNumber':
        return hex(this.latest);
      case 'eth_getBlockByNumber':
        return this.header(this.blockParam(params[0]));
      case 'eth_call': {
        try {
          if (params[0].to == null) return this.probe(params[0].data ?? params[0].input, BigInt(params[0].gas ?? '0x1c9c380'), this.blockParam(params[1]));
          return this.call(params[0].to, params[0].data ?? params[0].input, this.blockParam(params[1]));
        } catch (e) {
          if (e instanceof Revert) throw new RpcError('execution reverted: ' + e.message, { code: 3 });
          if (e instanceof OutOfGas) throw new RpcError('EVM error OutOfGas', { code: -32603 });
          throw e;
        }
      }
      case 'eth_getCode':
        return this.contracts.has(String(params[0]).toLowerCase()) ? '0x6001' : '0x';
      case 'eth_getLogs': {
        if (this.faults.maxLogCalls !== undefined && this.count('eth_getLogs') > this.faults.maxLogCalls) throw new Error('test budget: too many eth_getLogs calls');
        const f = params[0];
        const from = BigInt(f.fromBlock);
        const to = BigInt(f.toBlock);
        const rl = this.faults.rangeLimit;
        if (rl && to - from + 1n > rl.max) throw new RpcError(rl.message, { code: rl.code ?? -32600 });
        const addrs = new Set((Array.isArray(f.address) ? f.address : [f.address]).map((a: string) => a.toLowerCase()));
        const topics: (string | string[] | null)[] = f.topics ?? [];
        const out = this.logs
          .filter((l) => l.block >= from && l.block <= to && addrs.has(l.address))
          .filter((l) =>
            topics.every((t, i) => t === null || t === undefined || (Array.isArray(t) ? t.map((x) => x.toLowerCase()).includes(l.topics[i]?.toLowerCase()) : l.topics[i]?.toLowerCase() === t.toLowerCase())),
          )
          .map((l) => ({
            address: l.address,
            topics: l.topics,
            data: l.data,
            blockNumber: hex(l.block),
            blockHash: this.hashOf(l.block),
            transactionHash: l.txHash,
            logIndex: hex(l.logIndex),
            removed: false,
            ...(this.logTimestamps && this.headers.get(l.block) ? { blockTimestamp: hex(this.headers.get(l.block)!.timestamp) } : {}),
          }));
        const sl = this.faults.sizeLimit;
        if (sl && out.length > sl.max) throw new RpcError(sl.message, { code: sl.code ?? -32602 });
        return out;
      }
      case 'eth_getTransactionByHash': {
        const t = this.txs.get(String(params[0]).toLowerCase());
        if (!t) return null;
        return { hash: t.hash, from: t.from, to: t.to, input: t.input, blockNumber: hex(t.block), blockHash: this.hashOf(t.block) };
      }
      case 'eth_getTransactionReceipt': {
        const t = this.txs.get(String(params[0]).toLowerCase());
        if (!t) return null;
        const r: any = {
          transactionHash: t.hash,
          from: t.from,
          to: t.to,
          blockNumber: hex(t.block),
          blockHash: t.receiptBlockHash ?? this.hashOf(t.block),
          status: t.status === false ? '0x0' : '0x1',
          gasUsed: hex(t.gasUsed ?? 21000n),
          effectiveGasPrice: hex(t.effectiveGasPrice ?? 1n),
          logs: this.logs.filter((l) => l.txHash === t.hash),
        };
        if (t.l1Fee !== null) r.l1Fee = hex(t.l1Fee ?? 0n);
        return r;
      }
      default:
        throw new RpcError(`the method ${method} does not exist/is not available`, { code: -32601 });
    }
  }
}
