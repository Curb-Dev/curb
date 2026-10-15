// Sending transactions: one TxSender per key (publisher, pusher, guardian),
// one transaction in flight per key at a time.
//
//   - every send is simulated first (eth_estimateGas); a revert is reported
//     with the contract's own error name and nothing is sent;
//   - EIP-1559 fees from the chain, refused above a gas-price cap;
//   - refused when the key cannot pay for it (out of ETH: stop, alert, funds wait);
//   - a transaction not mined within stuckAfterSec is REPLACED AT THE SAME
//     NONCE with the same calldata and fees raised 25%, up to maxReplacements;
//   - the journal in /data records every signed transaction before it is
//     broadcast, so a restart resumes it (re-broadcast, wait, replace) instead
//     of stacking a second one, and the keeper fee can count a transaction
//     that reverted (it emitted no log for the indexer to find);
//   - a nonce held by a transaction the journal does not know (a standby
//     taking over a dead primary's stuck key) is cleared with a zero-value
//     self-transfer at that nonce.
//
// The private key never leaves the Signer; the journal holds signed
// transactions, which are public the moment they are broadcast.

import { decodeErrorResult, keccak256, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { ChainReader, ReceiptInfo } from '../chain/reader.ts';
import { ALL_ERRORS_ABI } from './abis.ts';
import type { Logger } from './log.ts';
import type { Secret } from './secrets.ts';
import type { Store } from './store.ts';

export interface Signer {
  readonly address: string;
  sign(tx: { chainId: number; nonce: number; to: string; data: string; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; value?: bigint }): Promise<string>;
  /** An EIP-191 signature of a text (the guardian's heartbeat). */
  signMessage?(message: string): Promise<string>;
}

export function keySigner(key: Secret): Signer {
  const acct = privateKeyToAccount(key.reveal() as Hex);
  return {
    address: acct.address.toLowerCase(),
    signMessage: (message) => acct.signMessage({ message }),
    sign: (tx) =>
      acct.signTransaction({
        type: 'eip1559',
        chainId: tx.chainId,
        nonce: tx.nonce,
        to: tx.to as Hex,
        data: tx.data as Hex,
        gas: tx.gas,
        maxFeePerGas: tx.maxFeePerGas,
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
        value: tx.value ?? 0n,
      }),
  };
}

export class WouldRevert extends Error {
  readonly errorName: string | null;
  readonly args: readonly unknown[];
  constructor(label: string, errorName: string | null, args: readonly unknown[], detail: string) {
    super(`${label} would revert: ${errorName ? `${errorName}(${args.map(String).join(', ')})` : detail}`);
    this.name = 'WouldRevert';
    this.errorName = errorName;
    this.args = args;
  }
}

export class GasPriceAboveCap extends Error {
  readonly price: bigint;
  readonly cap: bigint;
  constructor(label: string, price: bigint, cap: bigint) {
    super(`${label}: gas price ${price} wei is above the cap ${cap} wei; not sent`);
    this.name = 'GasPriceAboveCap';
    this.price = price;
    this.cap = cap;
  }
}

export class OutOfEth extends Error {
  readonly key: string;
  readonly need: bigint;
  readonly have: bigint;
  constructor(key: string, need: bigint, have: bigint) {
    super(`the ${key} key holds ${have} wei, a transaction needs up to ${need}; not sent`);
    this.name = 'OutOfEth';
    this.key = key;
    this.need = need;
    this.have = have;
  }
}

export class StuckTx extends Error {
  readonly hashes: string[];
  constructor(msg: string, hashes: string[]) {
    super(msg);
    this.name = 'StuckTx';
    this.hashes = hashes;
  }
}

/** The custom error inside an RPC failure, decoded with the sharing ABIs. */
export function revertOf(e: unknown): { name: string | null; args: readonly unknown[]; detail: string } {
  const found: string[] = [];
  const walk = (x: any, d: number): void => {
    if (!x || d > 6) return;
    if (typeof x === 'string') {
      const m = x.match(/0x[0-9a-fA-F]{8,}/g);
      if (m) found.push(...m);
      return;
    }
    if (typeof x !== 'object') return;
    for (const k of ['data', 'message', 'details', 'shortMessage', 'cause']) if (k in x) walk(x[k], d + 1);
  };
  walk(e, 0);
  for (const h of found) {
    try {
      const r = decodeErrorResult({ abi: ALL_ERRORS_ABI, data: h as Hex });
      return { name: r.errorName, args: (r.args ?? []) as readonly unknown[], detail: '' };
    } catch {
      // not one of ours
    }
  }
  return { name: null, args: [], detail: (e as Error)?.message ?? String(e) };
}

interface SendRecord {
  hash: string;
  raw: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  at: number;
}

export interface JournalEntry {
  key: string;
  nonce: number;
  to: string;
  data: string;
  gas: string;
  label: string;
  /** Distributors the transaction is for (the keeper fee's attribution). */
  distributors: string[];
  sends: SendRecord[];
  done?: { hash: string | null; block: string | null; status: boolean | null };
}

export interface SenderSettings {
  chainId: bigint;
  maxGasPriceWei: bigint;
  stuckAfterSec: number;
  maxReplacements: number;
  receiptPollMs: number;
}

export interface SendRequest {
  to: string;
  data: string;
  label: string;
  distributors: string[];
  /** A lower cap for this send (pushes). */
  maxGasPriceWei?: bigint;
}

export interface Sent {
  hash: string;
  receipt: ReceiptInfo;
  replaced: string[];
}


export class TxSender {
  readonly role: string;
  readonly signer: Signer;
  private readonly readers: ChainReader[];
  private readonly store: Store;
  private readonly log: Logger;
  private readonly s: SenderSettings;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(o: { role: string; signer: Signer; readers: ChainReader[]; store: Store; log: Logger; settings: SenderSettings; sleep?: (ms: number) => Promise<void>; now?: () => number }) {
    this.role = o.role;
    this.signer = o.signer;
    this.readers = o.readers;
    this.store = o.store;
    this.log = o.log.child({ key: o.role, address: o.signer.address });
    this.s = o.settings;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = o.now ?? Date.now;
  }

  get address(): string {
    return this.signer.address;
  }

  /** This key's EIP-191 signature of `message`; null for a signer that cannot sign texts. */
  async signMessage(message: string): Promise<string | null> {
    return this.signer.signMessage ? this.signer.signMessage(message) : null;
  }

  private get r(): ChainReader {
    return this.readers[0];
  }

  private journal(): Record<string, JournalEntry[]> {
    return this.store.get<Record<string, JournalEntry[]>>('txJournal', {});
  }

  private save(entry: JournalEntry): void {
    const j = this.journal();
    const list = (j[this.signer.address] ??= []);
    const i = list.findIndex((e) => e.nonce === entry.nonce && e.sends[0]?.hash === entry.sends[0]?.hash);
    if (i >= 0) list[i] = entry;
    else list.push(entry);
    // bounded: the last 500 sends per key are plenty for one keeper window
    if (list.length > 500) list.splice(0, list.length - 500);
    this.store.set('txJournal', j);
    this.store.flush();
  }

  /** Every hash this key signed for `distributor` (replaced ones included). */
  hashesFor(distributor: string): string[] {
    const d = distributor.toLowerCase();
    return (this.journal()[this.signer.address] ?? []).filter((e) => e.distributors.includes(d)).flatMap((e) => e.sends.map((s) => s.hash));
  }

  open(): JournalEntry | null {
    return (this.journal()[this.signer.address] ?? []).find((e) => !e.done) ?? null;
  }

  async balance(): Promise<bigint> {
    return BigInt(await this.r.request('eth_getBalance', [this.signer.address, 'latest']));
  }

  private async nonceAt(tag: 'latest' | 'pending'): Promise<number> {
    return Number(BigInt(await this.r.request('eth_getTransactionCount', [this.signer.address, tag])));
  }

  private async receiptOf(hash: string): Promise<ReceiptInfo | null> {
    const raw = await this.r.request('eth_getTransactionReceipt', [hash]);
    if (!raw) return null;
    return this.r.receipt(hash);
  }

  async fees(cap: bigint, label: string): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; price: bigint }> {
    const head = await this.r.request('eth_getBlockByNumber', ['latest', false]);
    const base = head && head.baseFeePerGas ? BigInt(head.baseFeePerGas) : 0n;
    let prio = 1_000_000n;
    try {
      prio = BigInt(await this.r.request('eth_maxPriorityFeePerGas', []));
    } catch {
      // not every node answers it; 0.001 gwei is Base's usual tip
    }
    const price = base + prio;
    if (price > cap) throw new GasPriceAboveCap(label, price, cap);
    const want = base * 2n + prio;
    return { maxFeePerGas: want < cap ? want : cap, maxPriorityFeePerGas: prio, price };
  }

  /** eth_estimateGas, with a revert turned into WouldRevert. */
  async estimate(to: string, data: string, label: string): Promise<bigint> {
    try {
      return BigInt(await this.r.request('eth_estimateGas', [{ from: this.signer.address, to, data }]));
    } catch (e) {
      const rv = revertOf(e);
      if (rv.name || /revert/i.test(rv.detail)) throw new WouldRevert(label, rv.name, rv.args, rv.detail);
      throw e;
    }
  }

  private async broadcast(raw: string): Promise<void> {
    let first: unknown = null;
    for (const [i, r] of this.readers.entries()) {
      try {
        await r.request('eth_sendRawTransaction', [raw]);
      } catch (e) {
        const m = String((e as Error)?.message ?? e);
        if (/already known|known transaction|nonce too low|already imported/i.test(m)) continue;
        if (i === 0) first = e;
      }
    }
    if (first) throw first;
  }

  private async signAndRecord(entry: JournalEntry, fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }): Promise<string> {
    const raw = await this.signer.sign({ chainId: Number(this.s.chainId), nonce: entry.nonce, to: entry.to, data: entry.data, gas: BigInt(entry.gas), ...fees });
    const hash = keccak256(raw as Hex).toLowerCase();
    entry.sends.push({ hash, raw, maxFeePerGas: fees.maxFeePerGas.toString(), maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(), at: Math.floor(this.now() / 1000) });
    this.save(entry); // recorded BEFORE it is broadcast
    await this.broadcast(raw);
    return hash;
  }

  /** Waits for any of the entry's sends to be mined, replacing at the same
   *  nonce when it takes too long. */
  private async settle(entry: JournalEntry, cap: bigint): Promise<Sent> {
    let replacements = 0;
    let since = this.now();
    for (;;) {
      for (const s of entry.sends) {
        const rc = await this.receiptOf(s.hash);
        if (rc) {
          entry.done = { hash: s.hash, block: rc.blockNumber.toString(), status: rc.status };
          this.save(entry);
          const replaced = entry.sends.map((x) => x.hash).filter((h) => h !== s.hash);
          (rc.status ? this.log.info : this.log.warn)(rc.status ? 'transaction mined' : 'transaction mined and REVERTED', { label: entry.label, hash: s.hash, block: rc.blockNumber, replaced });
          return { hash: s.hash, receipt: rc, replaced };
        }
      }
      // mined by a transaction we do not know of (the nonce moved on)?
      if ((await this.nonceAt('latest')) > entry.nonce) {
        // one more look: the receipt may have landed between the two reads
        let mined = false;
        for (const s of entry.sends) if (await this.receiptOf(s.hash)) mined = true;
        if (mined) continue;
        entry.done = { hash: null, block: null, status: null };
        this.save(entry);
        throw new StuckTx(`${entry.label}: nonce ${entry.nonce} was used by another transaction`, entry.sends.map((s) => s.hash));
      }
      if (this.now() - since >= this.s.stuckAfterSec * 1000) {
        if (replacements >= this.s.maxReplacements) throw new StuckTx(`${entry.label}: not mined after ${replacements} replacements; left in the journal`, entry.sends.map((s) => s.hash));
        const last = entry.sends[entry.sends.length - 1];
        const bump = (x: bigint) => (x * 125n) / 100n + 1n;
        let next: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
        try {
          const f = await this.fees(cap, entry.label);
          next = { maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas };
        } catch (e) {
          if (!(e instanceof GasPriceAboveCap)) throw e;
          throw new StuckTx(`${entry.label}: stuck, and the market is above the cap (${e.price} > ${cap}); left in the journal`, entry.sends.map((s) => s.hash));
        }
        const fee = bump(BigInt(last.maxFeePerGas)) > next.maxFeePerGas ? bump(BigInt(last.maxFeePerGas)) : next.maxFeePerGas;
        const tip = bump(BigInt(last.maxPriorityFeePerGas)) > next.maxPriorityFeePerGas ? bump(BigInt(last.maxPriorityFeePerGas)) : next.maxPriorityFeePerGas;
        if (fee > cap) throw new StuckTx(`${entry.label}: stuck, and a replacement would pay ${fee} wei/gas, above the cap ${cap}; left in the journal`, entry.sends.map((s) => s.hash));
        const h = await this.signAndRecord(entry, { maxFeePerGas: fee, maxPriorityFeePerGas: tip < fee ? tip : fee });
        replacements++;
        since = this.now();
        this.log.warn('transaction stuck; replaced at the same nonce', { label: entry.label, nonce: entry.nonce, hash: h, maxFeePerGas: fee });
        continue;
      }
      await this.sleep(this.s.receiptPollMs);
    }
  }

  /** Settles a transaction a previous run left open: re-broadcast, wait,
   *  replace. Throws StuckTx if it still cannot be settled. */
  async resume(cap = this.s.maxGasPriceWei): Promise<Sent | null> {
    const e = this.open();
    if (!e) return null;
    this.log.info('resuming a transaction the last run left open', { label: e.label, nonce: e.nonce });
    for (const s of e.sends) {
      try {
        await this.broadcast(s.raw);
      } catch {
        // replaced or dropped; settle() decides
      }
    }
    try {
      return await this.settle(e, cap);
    } catch (err) {
      if (err instanceof StuckTx && e.done) return null; // settled by another transaction
      throw err;
    }
  }

  /** A nonce taken by a transaction this journal does not know: wait for it,
   *  then cancel it with a zero-value transfer to self at that nonce. */
  async clearUnknown(): Promise<void> {
    let latest = await this.nonceAt('latest');
    let pending = await this.nonceAt('pending');
    if (pending <= latest) return;
    const start = this.now();
    while (pending > latest && this.now() - start < this.s.stuckAfterSec * 1000) {
      await this.sleep(this.s.receiptPollMs);
      latest = await this.nonceAt('latest');
      pending = await this.nonceAt('pending');
    }
    for (let n = latest; n < pending; n++) {
      const cap = this.s.maxGasPriceWei;
      const entry: JournalEntry = { key: this.role, nonce: n, to: this.signer.address, data: '0x', gas: '21000', label: `cancel unknown nonce ${n}`, distributors: [], sends: [] };
      this.log.warn('cancelling a pending transaction this journal does not know', { nonce: n });
      await this.signAndRecord(entry, { maxFeePerGas: cap, maxPriorityFeePerGas: cap });
      try {
        await this.settle(entry, cap);
      } catch (e) {
        if (!(e instanceof StuckTx)) throw e;
      }
    }
  }

  /** Simulates, prices, checks the balance, signs, records, broadcasts and
   *  waits. Throws WouldRevert, GasPriceAboveCap, OutOfEth or StuckTx. */
  async send(req: SendRequest): Promise<Sent> {
    await this.resume();
    await this.clearUnknown();
    const cap = req.maxGasPriceWei ?? this.s.maxGasPriceWei;
    const est = await this.estimate(req.to, req.data, req.label);
    const gas = (est * 125n) / 100n + 20_000n;
    const f = await this.fees(cap, req.label);
    const need = gas * f.maxFeePerGas;
    const have = await this.balance();
    if (have < need) throw new OutOfEth(this.role, need, have);
    const nonce = await this.nonceAt('pending');
    const entry: JournalEntry = { key: this.role, nonce, to: req.to.toLowerCase(), data: req.data, gas: gas.toString(), label: req.label, distributors: req.distributors.map((d) => d.toLowerCase()), sends: [] };
    const h = await this.signAndRecord(entry, f);
    this.log.info('transaction sent', { label: req.label, hash: h, nonce, gas, maxFeePerGas: f.maxFeePerGas });
    return this.settle(entry, cap);
  }
}

/** For tests and docs: the hash a signed transaction will have. */
export function txHashOf(raw: string): string {
  return keccak256(raw as Hex).toLowerCase();
}
