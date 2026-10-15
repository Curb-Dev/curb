// A simulated Base for the ops tests: the CURB holder-sharing contracts with
// their real rules (publish, veto, freeze, activate, push with a multiproof,
// claim with a proof, payKeeper, harvest), the Graduator's graduate() and
// noteReady(), Multicall3's aggregate3 (a predeploy on Base, as the
// guardian reads every root through it), signed EIP-1559 transactions with
// nonces, a mempool
// where a transaction can sit until it is replaced at the same nonce, a
// `safe` head that lags, block times, balances that pay for gas, and state
// readable at any past block (every read of the epoch pipeline names T).
//
// It extends the core's MockChain, so logs, receipts, headers, the probe and
// eth_getLogs behave exactly as the core's own tests expect.

import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionResult,
  keccak256,
  parseAbi,
  parseTransaction,
  recoverTransactionAddress,
  toHex,
  type Abi,
} from 'viem';
import { MockChain, Revert } from '../mock-chain.ts';
import { RpcError } from '../../src/chain/rpc.ts';
import { distributorAbi, graduatorAbi, erc20Abi, curveAbi, feedAbi, poolAbi } from '../../src/chain/abis.ts';
import { opsDistributorAbi, opsFactoryAbi, ALL_ERRORS_ABI, gasOracleAbi, GAS_ORACLE, incomeAbi, MULTICALL3, multicall3Abi } from '../../src/ops/abis.ts';
import { PREVIEW_CODE } from '../../src/ops/chainview.ts';
import { lensAbi } from '../../src/ops/graduation.ts';
import { leafHash, keccakHex } from '../../src/calc/encoding.ts';

export const ZERO = '0x0000000000000000000000000000000000000000';
export const DEAD = '0x000000000000000000000000000000000000dead';
export const WETH = '0x4200000000000000000000000000000000000006';
const lc = (a: unknown): string => String(a).toLowerCase();
const hex = (n: bigint | number): string => '0x' + BigInt(n).toString(16);

export interface Root {
  merkleRoot: string;
  contentHash: string;
  cumHolders0: bigint;
  cumHolders1: bigint;
  cumKeeper0: bigint;
  fromBlock: bigint;
  toBlock: bigint;
  epoch: number;
  payableAt: bigint;
}
const ZERO_ROOT = (): Root => ({ merkleRoot: '0x' + '0'.repeat(64), contentHash: '0x' + '0'.repeat(64), cumHolders0: 0n, cumHolders1: 0n, cumKeeper0: 0n, fromBlock: 0n, toBlock: 0n, epoch: 0, payableAt: 0n });

export interface Launch {
  D: string;
  token: string;
  quote: string;
  curve: string;
  hook: string;
  escrow: string;
  sharingSince: bigint;
  /** D's quote balance (ETH + WETH counted together on a WETH launch). */
  held0: bigint;
  /** Income waiting for harvest() in the curve/escrow/hook/lock. */
  pending0: bigint;
  pending1: bigint;
  /** Income a harvest cannot collect: credited in the escrow, owed by the hook. */
  stuck0: bigint;
  stuckHook0: bigint;
  active: Root;
  pending: Root;
  lastProposed: number;
  paid0: Map<string, bigint>;
  paid1: Map<string, bigint>;
  totalPaid0: bigint;
  totalPaid1: bigint;
  keeperPaid0: bigint;
  /** Accounts a quote transfer to fails for (an issuer block): PushSkipped. */
  blocked: Set<string>;
  reserves: [bigint, bigint];
}

export interface State {
  ts: bigint;
  eth: Map<string, bigint>;
  nonces: Map<string, number>;
  /** Launch-token balances, per token. */
  tok: Map<string, Map<string, bigint>>;
  /** Quote-token balances of everybody but the distributors. */
  quote: Map<string, Map<string, bigint>>;
  launches: Map<string, Launch>;
  factory: { owner: string; publisher: string; keeperPayee: string; frozen: boolean; vetoers: Set<string>; vetoableUntil: bigint; pendingUnfreezeAt: bigint };
  /** Every launch the LaunchLens describes, in registry order, with its
   *  LaunchStatus (1 Selling, 2 Waiting, 3 Graduated); graduate() moves 2 to
   *  3; readySince is the Graduator's (noteReady: written once, while 2). */
  lens: { token: string; curve: string; quote: string; status: number; readySince: bigint }[];
}

interface Exec {
  ok: boolean;
  revert?: string;
  gasUsed: bigint;
  logs: { address: string; topics: string[]; data: string }[];
}

interface PoolTx {
  hash: string;
  from: string;
  nonce: number;
  to: string;
  data: string;
  gas: bigint;
  maxFee: bigint;
  tip: bigint;
  raw: string;
}

class Fail extends Error {
  readonly data: string;
  constructor(errorName: string, args: unknown[] = []) {
    super(errorName);
    this.data = encodeErrorResult({ abi: ALL_ERRORS_ABI, errorName: errorName as any, args: args as any });
  }
}

function event(abi: Abi, name: string, args: Record<string, unknown>): { topics: string[]; data: string } {
  const item = (abi as any[]).find((x) => x.type === 'event' && x.name === name);
  const topics = encodeEventTopics({ abi: [item], eventName: name, args: Object.fromEntries(item.inputs.filter((i: any) => i.indexed).map((i: any) => [i.name, args[i.name]])) } as any) as string[];
  const non = item.inputs.filter((i: any) => !i.indexed);
  const data = encodeAbiParameters(non, non.map((i: any) => args[i.name]));
  return { topics, data };
}

const TRANSFER_ABI = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);
const GRAD_EVENTS = parseAbi(['event HolderSharingEnabled(address indexed token, address indexed distributor, address indexed factory, address by, bool graduated, uint64 sinceBlock)']);
const REG_EVENTS = parseAbi(['event LaunchRegistered(address indexed launchToken, address indexed curve, address indexed beneficiary)']);
const reservesAbi = parseAbi(['function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)', 'function feeEscrow() view returns (address)']);
const GRADUATE_ABI = parseAbi(['function graduate(address launchToken)', 'function noteReady(address launchToken) returns (uint256 since)', 'event ReadyNoted(address indexed launchToken, uint256 at)']);
/** HolderFeeDistributor.claim: the caller's own leaf, to itself or to `to`. */
export const claimAbi = parseAbi(['function claim(uint256 cum0, uint256 cum1, bytes32[] proof, address to)']);
const CLAIM_SELECTOR = keccak256(toHex('claim(uint256,uint256,bytes32[],address)')).slice(0, 10);
const SIM_ADMIN_ABI = parseAbi([
  'function launcherCount() view returns (uint256)',
  'function launcherAt(uint256 index) view returns (address)',
  'function requiredHook() view returns (address)',
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
  'function isApproved(address factory) view returns (bool)',
  'function registry() view returns (address)',
]);

function commutative(a: string, b: string): string {
  return a.toLowerCase() < b.toLowerCase() ? keccakHex(a.slice(2) + b.slice(2)) : keccakHex(b.slice(2) + a.slice(2));
}

/** OpenZeppelin MerkleProof.processProof, ported. */
export function processProof(proof: readonly string[], leaf: string): string {
  let h = leaf;
  for (const p of proof) h = commutative(h, p);
  return h;
}

/** OpenZeppelin MerkleProof.processMultiProof, ported. */
export function processMultiProof(proof: string[], flags: boolean[], leaves: string[]): string | null {
  if (leaves.length + proof.length !== flags.length + 1) return null;
  const hashes: string[] = [];
  let lp = 0;
  let hp = 0;
  let pp = 0;
  for (let i = 0; i < flags.length; i++) {
    const a = lp < leaves.length ? leaves[lp++] : hashes[hp++];
    let b: string;
    if (flags[i]) b = lp < leaves.length ? leaves[lp++] : hashes[hp++];
    else {
      if (pp >= proof.length) return null;
      b = proof[pp++];
    }
    if (a === undefined || b === undefined) return null;
    hashes.push(commutative(a, b));
  }
  if (flags.length > 0) return pp === proof.length ? hashes[flags.length - 1] : null;
  if (leaves.length > 0) return leaves[0];
  return proof[0] ?? null;
}

export interface SimOptions {
  chainId?: bigint;
  start?: { block: bigint; ts: bigint };
}

export class SimChain extends MockChain {
  state: State;
  readonly snaps = new Map<bigint, State>();
  readonly mempool: PoolTx[] = [];
  autoMine = true;
  /** A transaction this returns true for stays in the mempool when blocks are mined. */
  stuck: (tx: PoolTx) => boolean = () => false;
  baseFee = 5_000_000n;
  tip = 1_000_000n;
  l1Fee = 3_000_000_000n;
  blockTime = 2n;
  safeLag = 0n;
  private warpBy = 0n;
  /** Addresses of the shared contracts. */
  readonly addr = {
    graduator: '0x00000000000000000000000000000000000a0001',
    registry: '0x00000000000000000000000000000000000a0002',
    factory: '0x00000000000000000000000000000000000a0003',
    poolManager: '0x00000000000000000000000000000000000a0004',
    positionManager: '0x00000000000000000000000000000000000a0005',
    catalog: '0x00000000000000000000000000000000000a0006',
    ethUsd: '0x00000000000000000000000000000000000a0007',
    usdc: '0x00000000000000000000000000000000000a0008',
    usdcUsd: '0x00000000000000000000000000000000000a0009',
    lens: '0x00000000000000000000000000000000000a000c',
    hook: '0x00000000000000000000000000000000000a000b',
  };
  ethUsdAnswer: bigint | null = 3000n * 10n ** 8n;
  usdcUsdAnswer: bigint | null = 10n ** 8n;
  /** harvest() reverts (an issuer refusing every leg would not; a broken distributor might). */
  harvestReverts = false;
  /** A transaction that simulates fine and then fails when mined (state moved in between). */
  failOnChain: ((to: string, data: string) => boolean) | null = null;
  /** paid0/paid1 of D revert (a broken view). */
  paidReverts = false;
  /** Graduator.graduate() reverts (an issuer blocking the launch's escrow, say). */
  graduateReverts = false;
  /** How the deployment's contracts point at each other, as `check` reads it
   *  back (a test swaps one to see it refused). Owners not named here are
   *  the factory owner. */
  readonly wiring = {
    graduatorCatalog: '0x00000000000000000000000000000000000a0006',
    catalogApproves: true,
    factoryGraduator: '0x00000000000000000000000000000000000a0001',
    factoryRegistry: '0x00000000000000000000000000000000000a0002',
    lensRegistry: '0x00000000000000000000000000000000000a0002',
    lensGraduator: '0x00000000000000000000000000000000000a0001',
    hookRegistry: '0x00000000000000000000000000000000000a0002',
    requiredHook: '0x00000000000000000000000000000000000a000b',
    launchers: [] as string[],
    owners: {} as Record<string, string>,
    pendingOwners: {} as Record<string, string>,
  };
  /** Calls made to eth_sendRawTransaction, accepted or not. */
  readonly sent: string[] = [];
  /** The registry's launchedAt per token. */
  readonly launchedAt = new Map<string, bigint>();
  readonly startBlock: bigint;

  constructor(o: SimOptions = {}) {
    super();
    this.chainId = o.chainId ?? 8453n;
    const start = o.start ?? { block: 1000n, ts: 1_800_000_000n };
    this.startBlock = start.block;
    this.state = {
      ts: start.ts,
      eth: new Map(),
      nonces: new Map(),
      tok: new Map(),
      quote: new Map([[WETH, new Map()], [this.addr.usdc, new Map()]]),
      launches: new Map(),
      lens: [],
      factory: { owner: '0x00000000000000000000000000000000000cafe0', publisher: ZERO, keeperPayee: ZERO, frozen: false, vetoers: new Set(), vetoableUntil: 0n, pendingUnfreezeAt: 0n },
    };
    this.setBlock(start.block, start.ts);
    this.snaps.set(start.block, structuredClone(this.state));
    this.safe = start.block;
    this.installViews();
  }

  // ------------------------------------------------------------ state

  at(block: bigint): State {
    if (block >= this.latest) return this.snaps.get(this.latest)!;
    let b = block;
    while (b >= 0n && !this.snaps.has(b)) b--;
    const s = this.snaps.get(b);
    if (!s) throw new Revert(`no state at block ${block}`);
    return s;
  }

  launch(d: string, s: State = this.state): Launch {
    const l = s.launches.get(lc(d));
    if (!l) throw new Error(`no launch ${d}`);
    return l;
  }

  warp(sec: bigint | number): void {
    this.warpBy += BigInt(sec);
  }

  fund(a: string, wei: bigint): void {
    this.state.eth.set(lc(a), (this.state.eth.get(lc(a)) ?? 0n) + wei);
    this.snaps.set(this.latest, structuredClone(this.state));
  }

  setSafeLag(n: bigint): void {
    this.safeLag = n;
    this.safe = this.latest - n > 0n ? this.latest - n : 0n;
  }

  /** Mines one block holding the mempool's eligible transactions (and any given). */
  mine(extra: { from: string; to: string; data: string; hash?: string }[] = []): bigint {
    const n = this.latest + 1n;
    this.state.ts = this.state.ts + this.blockTime + this.warpBy;
    this.warpBy = 0n;
    this.setBlock(n, this.state.ts);
    let idx = 0n;
    // mempool, in nonce order per sender, skipping held ones
    const take = this.mempool.filter((t) => !this.stuck(t) && t.maxFee >= this.baseFee).sort((a, b) => (a.from === b.from ? a.nonce - b.nonce : a.from < b.from ? -1 : 1));
    for (const t of take) {
      const want = this.state.nonces.get(t.from) ?? 0;
      if (t.nonce !== want) continue;
      this.mempool.splice(this.mempool.indexOf(t), 1);
      idx = this.include(n, t.hash, t.from, t.to, t.data, t.gas, t.maxFee, t.tip, idx);
    }
    for (const x of extra) idx = this.include(n, x.hash ?? keccak256(toHex(`user:${n}:${idx}:${x.from}:${x.data}`)), lc(x.from), lc(x.to), x.data, 10_000_000n, this.baseFee + this.tip, this.tip, idx, true);
    this.snaps.set(n, structuredClone(this.state));
    this.safe = n - this.safeLag > 0n ? n - this.safeLag : 0n;
    return n;
  }

  mineMany(k: number): void {
    for (let i = 0; i < k; i++) this.mine();
  }

  private include(n: bigint, hash: string, from: string, to: string, data: string, gas: bigint, maxFee: bigint, tip: bigint, idx: bigint, free = false): bigint {
    const s = this.state;
    if (!free) s.nonces.set(from, (s.nonces.get(from) ?? 0) + 1);
    const work = structuredClone(s);
    const res = this.failOnChain?.(to, data) ? ({ ok: false, gasUsed: 30_000n, logs: [] } as Exec) : this.exec(work, from, to, data, n);
    if (res.ok) this.state = work;
    const st = this.state;
    const price = this.baseFee + (tip < maxFee - this.baseFee ? tip : maxFee - this.baseFee);
    const used = res.ok ? res.gasUsed : 30_000n;
    if (!free) st.eth.set(from, (st.eth.get(from) ?? 0n) - used * price - this.l1Fee);
    this.txs.set(hash, { hash, from, to, input: data, block: n, status: res.ok, gasUsed: used, effectiveGasPrice: price, l1Fee: free ? 0n : this.l1Fee });
    for (const l of res.ok ? res.logs : []) this.addLog({ address: l.address, topics: l.topics, data: l.data, block: n, logIndex: idx++, txHash: hash });
    void gas;
    return idx;
  }

  /** A mined transaction with whatever logs a test wants (a contract that
   *  called D on the sender's behalf, say). */
  rawTx(from: string, to: string, logs: { address: string; topics: string[]; data: string }[]): string {
    const b = this.mine();
    const hash = keccak256(toHex(`raw:${b}:${from}:${to}`));
    this.txs.set(hash, { hash, from: lc(from), to: lc(to), input: '0x', block: b, status: true, gasUsed: 50_000n, effectiveGasPrice: this.baseFee, l1Fee: 0n });
    logs.forEach((l, i) => this.addLog({ ...l, block: b, logIndex: 100n + BigInt(i), txHash: hash }));
    return hash;
  }

  /** The Harvested log D would emit now. */
  harvestedLog(d: string): { address: string; topics: string[]; data: string } {
    const l = this.launch(d);
    return { address: l.D, ...event(opsDistributorAbi, 'Harvested', { received0: this.received0(l), received1: this.received1(this.state, l) }) };
  }

  /** A transaction from anybody (a holder, a test actor), mined at once. */
  userTx(from: string, to: string, data: string): { hash: string; block: bigint; ok: boolean } {
    const hash = keccak256(toHex(`user:${this.latest + 1n}:${from}:${data}:${Math.random()}`));
    const b = this.mine([{ from, to, data, hash }]);
    return { hash, block: b, ok: this.txs.get(hash)!.status !== false };
  }

  // ------------------------------------------------------------ launches

  addLaunch(o: { D: string; token: string; quote: string; holders: Record<string, bigint>; beneficiary?: string; reserves?: [bigint, bigint] }): Launch {
    const D = lc(o.D);
    const token = lc(o.token);
    const curve = lc('0x' + keccakHex(toHex(`curve:${token}`).slice(2)).slice(26));
    const hook = lc('0x' + keccakHex(toHex(`hook:${token}`).slice(2)).slice(26));
    const escrow = lc('0x' + keccakHex(toHex(`escrow:${token}`).slice(2)).slice(26));
    // the launch block: registered, tokens bought from the curve
    const bal = new Map<string, bigint>();
    this.state.tok.set(token, bal);
    const nL = this.mine();
    this.addLog({ address: this.addr.registry, ...event(REG_EVENTS, 'LaunchRegistered', { launchToken: token, curve, beneficiary: lc(o.beneficiary ?? '0x00000000000000000000000000000000000c0de1') }), block: nL, logIndex: 0n, txHash: keccak256(toHex(`launch:${token}`)) });
    const launchedAt = this.state.ts;
    let li = 1n;
    // The token is minted to the curve, which sells it. The curve keeps 1,000
    // tokens, so the holders a test names hold far more than the weight
    // floor (a millionth of the supply on average over the window).
    const supply = Object.values(o.holders).reduce((x, y) => x + y, 0n) + 10n ** 21n;
    bal.set(curve, supply - Object.values(o.holders).reduce((x, y) => x + y, 0n));
    this.addLog({ address: token, ...event(TRANSFER_ABI, 'Transfer', { from: ZERO, to: curve, value: supply }), block: nL, logIndex: li++, txHash: keccak256(toHex(`mint:${token}`)) });
    for (const [a, v] of Object.entries(o.holders)) {
      bal.set(lc(a), v);
      this.addLog({ address: token, ...event(TRANSFER_ABI, 'Transfer', { from: curve, to: lc(a), value: v }), block: nL, logIndex: li++, txHash: keccak256(toHex(`buy:${token}:${a}`)) });
    }
    const l: Launch = { D, token, quote: lc(o.quote), curve, hook, escrow, sharingSince: nL, held0: 0n, pending0: 0n, pending1: 0n, stuck0: 0n, stuckHook0: 0n, active: ZERO_ROOT(), pending: ZERO_ROOT(), lastProposed: 0, paid0: new Map(), paid1: new Map(), totalPaid0: 0n, totalPaid1: 0n, keeperPaid0: 0n, blocked: new Set(), reserves: o.reserves ?? [10n ** 18n, 10n ** 24n] };
    this.state.launches.set(D, l);
    this.launchedAt.set(token, launchedAt);
    this.addLog({ address: this.addr.graduator, ...event(GRAD_EVENTS, 'HolderSharingEnabled', { token, distributor: D, factory: this.addr.factory, by: lc(o.beneficiary ?? '0x00000000000000000000000000000000000c0de1'), graduated: false, sinceBlock: nL }), block: nL, logIndex: li++, txHash: keccak256(toHex(`enable:${token}`)) });
    this.snaps.set(nL, structuredClone(this.state));
    this.installLaunch(l);
    return l;
  }

  /** Income arriving for D, to be collected by harvest(). Launch-token
   *  income sits in the hook (the LP fee side) until then. */
  income(d: string, amount0: bigint, amount1 = 0n): void {
    const l = this.launch(d);
    l.pending0 += amount0;
    if (amount1 > 0n) {
      const bal = this.state.tok.get(l.token)!;
      bal.set(l.hook, (bal.get(l.hook) ?? 0n) + amount1);
      l.pending1 += amount1;
      const n = this.mine();
      this.addLog({ address: l.token, ...event(TRANSFER_ABI, 'Transfer', { from: ZERO, to: l.hook, value: amount1 }), block: n, logIndex: 0n, txHash: keccak256(toHex(`fees:${n}:${l.token}`)) });
    }
    this.snaps.set(this.latest, structuredClone(this.state));
  }

  /** A holder-to-holder transfer of the launch token, mined now. */
  transfer(token: string, from: string, to: string, value: bigint): void {
    const t = lc(token);
    const bal = this.state.tok.get(t)!;
    const f = bal.get(lc(from)) ?? 0n;
    if (f < value) throw new Error('sim: transfer above balance');
    bal.set(lc(from), f - value);
    bal.set(lc(to), (bal.get(lc(to)) ?? 0n) + value);
    const n = this.mine();
    this.addLog({ address: t, ...event(TRANSFER_ABI, 'Transfer', { from: lc(from), to: lc(to), value }), block: n, logIndex: 0n, txHash: keccak256(toHex(`xfer:${n}:${from}:${to}`)) });
    this.snaps.set(n, structuredClone(this.state));
  }

  // ------------------------------------------------------------ execution

  private isExcluded(s: State, l: Launch, a: string): boolean {
    const x = lc(a);
    return [ZERO, DEAD, l.D, l.token, l.quote, l.curve, l.hook, l.escrow, this.addr.graduator, this.addr.poolManager, this.addr.positionManager, this.addr.registry, this.addr.factory].includes(x) || s.launches.has(x);
  }

  private received0(l: Launch): bigint {
    return l.held0 + l.totalPaid0 + l.keeperPaid0;
  }

  private received1(s: State, l: Launch): bigint {
    return (s.tok.get(l.token)!.get(l.D) ?? 0n) + l.totalPaid1;
  }

  private promote(s: State, l: Launch, logs: Exec['logs']): void {
    if (l.pending.payableAt === 0n || s.ts < l.pending.payableAt || s.factory.frozen) return;
    l.active = { ...l.pending };
    l.pending.payableAt = 0n;
    logs.push({ address: l.D, ...event(opsDistributorAbi, 'RootActivated', { epoch: l.active.epoch, root: l.active.merkleRoot }) });
  }

  exec(s: State, from: string, to: string, data: string, block: bigint): Exec {
    const logs: Exec['logs'] = [];
    try {
      const gasUsed = this.run(s, lc(from), lc(to), data, block, logs);
      return { ok: true, gasUsed, logs };
    } catch (e) {
      if (e instanceof Fail) return { ok: false, revert: e.data, gasUsed: 30_000n, logs: [] };
      if (e instanceof Revert) return { ok: false, revert: '0x', gasUsed: 30_000n, logs: [] };
      throw e;
    }
  }

  private run(s: State, from: string, to: string, data: string, block: bigint, logs: Exec['logs']): bigint {
    if (data === '0x' || data === '') return 21_000n; // a plain transfer (a cancel)
    const fa = this.addr.factory;
    if (to === this.addr.graduator) {
      const d = decodeFunctionData({ abi: GRADUATE_ABI, data: data as `0x${string}` });
      const x = s.lens.find((l) => l.token === lc(d.args[0]));
      if (d.functionName === 'noteReady') {
        // written once; only for a launch whose curve is full and ungraduated
        if (x && x.readySince !== 0n) return 30_000n;
        if (!x) throw new Revert('sim graduator: NotRegistered');
        if (x.status === 3) throw new Revert('sim graduator: AlreadyGraduated');
        if (x.status !== 2) throw new Revert('sim graduator: CurveNotReady');
        x.readySince = s.ts;
        logs.push({ address: this.addr.graduator, ...event(GRADUATE_ABI, 'ReadyNoted', { launchToken: x.token, at: s.ts }) });
        return 50_000n;
      }
      if (!x) throw new Revert('sim graduator: NotRegistered');
      if (x.status === 3) throw new Revert('sim graduator: AlreadyGraduated');
      if (x.status !== 2) throw new Revert('sim graduator: CurveNotReady');
      if (this.graduateReverts) throw new Revert('sim graduator: the escrow sweep reverts');
      x.status = 3;
      return 1_500_000n;
    }
    if (to === fa) {
      const d = decodeFunctionData({ abi: opsFactoryAbi, data: data as `0x${string}` });
      const F = s.factory;
      switch (d.functionName) {
        case 'publishMany': {
          if (from !== F.publisher) throw new Fail('NotThePublisher', [from]);
          if (F.frozen) throw new Fail('PublishingFrozen');
          F.vetoableUntil = s.ts + 3600n;
          const [ds, rs, uris] = d.args as any;
          if (rs.length !== ds.length || uris.length !== ds.length) throw new Fail('LengthMismatch');
          ds.forEach((x: string, i: number) => this.publish(s, lc(x), rs[i], uris[i], block, logs));
          return 60_000n + 100_000n * BigInt(ds.length);
        }
        case 'veto':
        case 'vetoMany': {
          if (!F.vetoers.has(from)) throw new Fail('NotAVetoer', [from]);
          const [dsA, epA, reason] = d.functionName === 'veto' ? [[d.args![0]], [d.args![1]], d.args![2]] : (d.args as any);
          if (epA.length !== dsA.length) throw new Fail('LengthMismatch');
          dsA.forEach((x: string, i: number) => {
            const l = s.launches.get(lc(x));
            if (!l) throw new Fail('UnknownDistributor', [x]);
            const at = l.pending.payableAt;
            if (at === 0n || l.pending.epoch !== Number(epA[i])) throw new Fail('NoSuchPending', [Number(epA[i])]);
            if (s.ts >= at && !F.frozen) throw new Fail('VetoWindowOver', [at]);
            l.pending.payableAt = 0n;
            logs.push({ address: l.D, ...event(opsDistributorAbi, 'RootVetoed', { epoch: Number(epA[i]), reason }) });
          });
          return 40_000n + 30_000n * BigInt(dsA.length);
        }
        case 'freeze': {
          if (from !== F.owner && !F.vetoers.has(from)) throw new Fail('NotAVetoer', [from]);
          F.frozen = true;
          logs.push({ address: fa, ...event(opsFactoryAbi, 'Frozen', { by: from }) });
          // a freeze cancels an unfreeze already announced (HolderDistributorFactory.freeze)
          if (F.pendingUnfreezeAt !== 0n) {
            F.pendingUnfreezeAt = 0n;
            logs.push({ address: fa, ...event(opsFactoryAbi, 'UnfreezeCancelled', { by: from }) });
          }
          return 30_000n;
        }
        default:
          throw new Revert('sim factory: ' + d.functionName);
      }
    }
    const l = s.launches.get(to);
    if (l && data.startsWith(CLAIM_SELECTOR)) {
      const d = decodeFunctionData({ abi: claimAbi, data: data as `0x${string}` });
      this.promote(s, l, logs);
      if (l.active.epoch === 0) throw new Fail('NoActiveRoot');
      const [cum0, cum1, proof, to0] = d.args;
      const a = from;
      if (processProof(proof, leafHash(l.D, a, cum0, cum1)).toLowerCase() !== l.active.merkleRoot.toLowerCase()) throw new Fail('BadProof');
      const dest = lc(to0) === ZERO ? a : lc(to0);
      if (this.isExcluded(s, l, a)) throw new Fail('Excluded', [a]);
      if (this.isExcluded(s, l, dest)) throw new Fail('Excluded', [dest]);
      // a claim's refused transfer reverts (a push's is skipped)
      if (l.blocked.has(dest) && cum0 > (l.paid0.get(a) ?? 0n)) throw new Fail('TransferRefused', [l.quote, dest]);
      const [s0, s1] = this.settle(s, l, a, dest, cum0, cum1, logs);
      if (s0 === 0n && s1 === 0n) throw new Fail('NothingToClaim', [a]);
      logs.push({ address: l.D, ...event(opsDistributorAbi, 'Paid', { account: a, to: dest, amount0: s0, amount1: s1, pushed: false }) });
      return 90_000n;
    }
    if (l) {
      const d = decodeFunctionData({ abi: opsDistributorAbi, data: data as `0x${string}` });
      switch (d.functionName) {
        case 'harvest': {
          if (this.harvestReverts) throw new Revert('sim: harvest reverts');
          const stuck = l.stuck0 + l.stuckHook0;
          const take0 = l.pending0 - stuck;
          l.held0 += take0;
          l.pending0 = stuck;
          if (l.pending1 > 0n) {
            const bal = s.tok.get(l.token)!;
            bal.set(l.hook, (bal.get(l.hook) ?? 0n) - l.pending1);
            bal.set(l.D, (bal.get(l.D) ?? 0n) + l.pending1);
            logs.push({ address: l.token, ...event(TRANSFER_ABI, 'Transfer', { from: l.hook, to: l.D, value: l.pending1 }) });
            l.pending1 = 0n;
          }
          logs.push({ address: l.D, ...event(opsDistributorAbi, 'Harvested', { received0: this.received0(l), received1: this.received1(s, l) }) });
          return 220_000n;
        }
        case 'activate': {
          const at = l.pending.payableAt;
          if (at === 0n) throw new Fail('NothingPending');
          if (s.ts < at) throw new Fail('NotYetPayable', [at]);
          if (s.factory.frozen) throw new Fail('Frozen');
          this.promote(s, l, logs);
          return 35_000n;
        }
        case 'push': {
          this.promote(s, l, logs);
          if (l.active.epoch === 0) throw new Fail('NoActiveRoot');
          const [leaves, proof, flags] = d.args as any;
          const hashes = leaves.map((x: any) => leafHash(l.D, lc(x.account), BigInt(x.cum0), BigInt(x.cum1)));
          const root = processMultiProof(proof, flags, hashes);
          if (!root || root.toLowerCase() !== l.active.merkleRoot.toLowerCase()) throw new Fail('BadProof');
          let gas = 50_000n;
          for (const x of leaves) {
            const a = lc(x.account);
            if (this.isExcluded(s, l, a)) {
              logs.push({ address: l.D, ...event(opsDistributorAbi, 'ExcludedLeaf', { account: a }) });
              continue;
            }
            const p0 = l.paid0.get(a) ?? 0n;
            const p1 = l.paid1.get(a) ?? 0n;
            gas += p0 === 0n && p1 === 0n ? 38_000n : 15_000n;
            if (BigInt(x.cum0) > p0 && l.blocked.has(a)) logs.push({ address: l.D, ...event(opsDistributorAbi, 'PushSkipped', { account: a, asset: 0 }) });
            const [s0, s1] = this.settle(s, l, a, a, BigInt(x.cum0), BigInt(x.cum1), logs, l.blocked.has(a));
            if (s0 !== 0n || s1 !== 0n) logs.push({ address: l.D, ...event(opsDistributorAbi, 'Paid', { account: a, to: a, amount0: s0, amount1: s1, pushed: true }) });
          }
          return gas;
        }
        case 'payKeeper': {
          this.promote(s, l, logs);
          const due = l.active.cumKeeper0 - l.keeperPaid0;
          if (due === 0n) return 30_000n;
          l.keeperPaid0 += due;
          l.held0 -= due;
          const q = s.quote.get(l.quote)!;
          q.set(s.factory.keeperPayee, (q.get(s.factory.keeperPayee) ?? 0n) + due);
          logs.push({ address: l.D, ...event(opsDistributorAbi, 'KeeperPaid', { payee: s.factory.keeperPayee, amount: due }) });
          return 60_000n;
        }
        default:
          throw new Revert('sim distributor: ' + d.functionName);
      }
    }
    throw new Revert('sim: no code at ' + to);
  }

  /** HolderFeeDistributor._settle: books and pays one account's unpaid share
   *  of each asset to `to`. `skip0` leaves asset 0 unpaid (a refused push). */
  private settle(s: State, l: Launch, a: string, to: string, cum0: bigint, cum1: bigint, logs: Exec['logs'], skip0 = false): [bigint, bigint] {
    const p0 = l.paid0.get(a) ?? 0n;
    const p1 = l.paid1.get(a) ?? 0n;
    let s0 = 0n;
    let s1 = 0n;
    if (cum0 > p0) {
      const o = cum0 - p0;
      if (l.totalPaid0 + o > l.active.cumHolders0) throw new Fail('LeavesExceedRoot', [0]);
      if (!skip0) {
        l.paid0.set(a, cum0);
        l.totalPaid0 += o;
        l.held0 -= o;
        const q = s.quote.get(l.quote)!;
        q.set(to, (q.get(to) ?? 0n) + o);
        s0 = o;
      }
    }
    if (cum1 > p1) {
      const o = cum1 - p1;
      if (l.totalPaid1 + o > l.active.cumHolders1) throw new Fail('LeavesExceedRoot', [1]);
      const bal = s.tok.get(l.token)!;
      l.paid1.set(a, cum1);
      l.totalPaid1 += o;
      bal.set(l.D, (bal.get(l.D) ?? 0n) - o);
      bal.set(to, (bal.get(to) ?? 0n) + o);
      logs.push({ address: l.token, ...event(TRANSFER_ABI, 'Transfer', { from: l.D, to, value: o }) });
      s1 = o;
    }
    return [s0, s1];
  }

  private publish(s: State, D: string, r: any, uri: string, block: bigint, logs: Exec['logs']): void {
    const l = s.launches.get(D);
    if (!l) throw new Fail('UnknownDistributor', [D]);
    this.promote(s, l, logs);
    if (l.pending.payableAt !== 0n) throw new Fail('PendingRoot', [l.pending.epoch]);
    const want = l.lastProposed + 1;
    if (Number(r.epoch) !== want) throw new Fail('WrongEpoch', [want, Number(r.epoch)]);
    const a = l.active;
    const from = a.epoch === 0 ? l.sharingSince : a.toBlock + 1n;
    if (BigInt(r.fromBlock) !== from || BigInt(r.toBlock) < BigInt(r.fromBlock) || BigInt(r.toBlock) >= block) throw new Fail('BadRange', [from, BigInt(r.fromBlock), BigInt(r.toBlock)]);
    if (BigInt(r.cumHolders0) < a.cumHolders0 || BigInt(r.cumHolders1) < a.cumHolders1 || BigInt(r.cumKeeper0) < a.cumKeeper0) throw new Fail('RootShrinks');
    const dH0 = BigInt(r.cumHolders0) - a.cumHolders0;
    const dK = BigInt(r.cumKeeper0) - a.cumKeeper0;
    if (dK * 10_000n > (dH0 + dK) * 200n) throw new Fail('KeeperFeeAboveCap', [dK, dH0 + dK]);
    const in0 = this.received0(l);
    if (BigInt(r.cumHolders0) + BigInt(r.cumKeeper0) > in0) throw new Fail('AllocatesMoreThanReceived', [0, BigInt(r.cumHolders0) + BigInt(r.cumKeeper0), in0]);
    const in1 = this.received1(s, l);
    if (BigInt(r.cumHolders1) > in1) throw new Fail('AllocatesMoreThanReceived', [1, BigInt(r.cumHolders1), in1]);
    const at = s.ts + 3600n;
    l.pending = { merkleRoot: lc(r.merkleRoot), contentHash: lc(r.contentHash), cumHolders0: BigInt(r.cumHolders0), cumHolders1: BigInt(r.cumHolders1), cumKeeper0: BigInt(r.cumKeeper0), fromBlock: BigInt(r.fromBlock), toBlock: BigInt(r.toBlock), epoch: Number(r.epoch), payableAt: at };
    l.lastProposed = Number(r.epoch);
    logs.push({ address: D, ...event(distributorAbi as Abi, 'RootPublished', { epoch: Number(r.epoch), merkleRoot: r.merkleRoot, fromBlock: BigInt(r.fromBlock), toBlock: BigInt(r.toBlock), dH0, dH1: BigInt(r.cumHolders1) - a.cumHolders1, dK, contentHash: r.contentHash, uri, payableAt: at }) });
  }

  // ------------------------------------------------------------ views

  private view(abi: Abi, impl: Record<string, (args: readonly any[], s: State, block: bigint) => unknown>) {
    return (data: string, block: bigint): string => {
      let d;
      try {
        d = decodeFunctionData({ abi, data: data as `0x${string}` });
      } catch {
        throw new Revert('unknown selector');
      }
      const f = impl[d.functionName];
      if (!f) throw new Revert('not implemented: ' + d.functionName);
      return encodeFunctionResult({ abi, functionName: d.functionName, result: f(d.args ?? [], this.at(block), block) } as any);
    };
  }

  private installViews(): void {
    const A = this.addr;
    this.setContract(A.graduator, this.view([...graduatorAbi, ...parseAbi(['function sharingCatalog() view returns (address)', 'function readySince(address launchToken) view returns (uint256)'])] as Abi, {
      holderDistributorOf: ([t], s) => [...s.launches.values()].find((l) => l.token === lc(t))?.D ?? ZERO,
      sharingSince: ([t], s) => [...s.launches.values()].find((l) => l.token === lc(t))?.sharingSince ?? 0n,
      lockOf: () => ZERO,
      hasGraduated: () => false,
      registry: () => A.registry,
      poolManager: () => A.poolManager,
      positionManager: () => A.positionManager,
      sharingCatalog: () => this.wiring.graduatorCatalog,
      readySince: ([t], s) => s.lens.find((l) => l.token === lc(t))?.readySince ?? 0n,
    }));
    // Multicall3 (a predeploy on Base): every test reads the roots the way
    // the guardian does on Base; withoutMulticall3() for its fallback
    this.setContract(MULTICALL3, (data, block) => this.aggregate3(data, block));
    const W = this.wiring;
    const ownerOf = (a: string, s: State) => W.owners[a] ?? s.factory.owner;
    const ownable = (a: string) => ({ owner: (_x: readonly any[], s: State) => ownerOf(a, s), pendingOwner: () => W.pendingOwners[a] ?? ZERO });
    const registryViews = this.view(SIM_ADMIN_ABI, {
      launcherCount: () => BigInt(W.launchers.length),
      launcherAt: ([i]) => {
        if (Number(i) >= W.launchers.length) throw new Revert('IndexOutOfRange');
        return W.launchers[Number(i)];
      },
      requiredHook: () => W.requiredHook,
      ...ownable(A.registry),
    });
    this.setContract(A.catalog, this.view(SIM_ADMIN_ABI, { isApproved: ([f]) => W.catalogApproves && lc(f) === A.factory, ...ownable(A.catalog) }));
    this.setContract(A.hook, this.view(SIM_ADMIN_ABI, { registry: () => W.hookRegistry, ...ownable(A.hook) }));
    this.setContract(A.registry, (data, block) => {
      if (!data.startsWith('0x029282d7')) return registryViews(data, block);
      const who = lc('0x' + data.slice(34, 74));
      const l = [...this.at(block).launches.values()].find((x) => x.token === who);
      const w = (n: bigint) => n.toString(16).padStart(64, '0');
      const a = (x: string) => x.slice(2).padStart(64, '0');
      if (!l) return '0x' + w(0n).repeat(12);
      const at = this.launchedAt.get(who)!;
      return '0x' + [a(l.curve), a(l.quote), a('0x00000000000000000000000000000000000c0de1'), a('0x00000000000000000000000000000000000c0de1'), w(15552000n), w(10000n), w(200n), a(l.hook), w(100n), w(2000n), a('0x00000000000000000000000000000000000fee01'), w(at)].join('');
    });
    const opsF = parseAbi([
      'function owner() view returns (address)',
      'function publisher() view returns (address)',
      'function keeperPayee() view returns (address)',
      'function frozen() view returns (bool)',
      'function isVetoer(address account) view returns (bool)',
      'function isDistributor(address d) view returns (bool)',
      'function pendingPublisher() view returns (address)',
      'function pendingPublisherAt() view returns (uint64)',
      'function pendingKeeperPayee() view returns (address)',
      'function pendingKeeperPayeeAt() view returns (uint64)',
      'function pendingUnfreezeAt() view returns (uint256)',
      'function vetoableUntil() view returns (uint256)',
      'function graduator() view returns (address)',
      'function registry() view returns (address)',
      'function pendingOwner() view returns (address)',
    ]);
    this.setContract(A.factory, this.view(opsF, {
      owner: (_a, s) => s.factory.owner,
      publisher: (_a, s) => s.factory.publisher,
      keeperPayee: (_a, s) => s.factory.keeperPayee,
      frozen: (_a, s) => s.factory.frozen,
      isVetoer: ([x], s) => s.factory.vetoers.has(lc(x)),
      isDistributor: ([x], s) => s.launches.has(lc(x)),
      pendingPublisher: () => ZERO,
      pendingPublisherAt: () => 0n,
      pendingKeeperPayee: () => ZERO,
      pendingKeeperPayeeAt: () => 0n,
      pendingUnfreezeAt: (_a, s) => s.factory.pendingUnfreezeAt,
      vetoableUntil: (_a, s) => s.factory.vetoableUntil,
      graduator: () => this.wiring.factoryGraduator,
      registry: () => this.wiring.factoryRegistry,
      pendingOwner: () => this.wiring.pendingOwners[A.factory] ?? ZERO,
    }));
    const feed = (answer: () => bigint | null, dec: number) =>
      this.view(feedAbi, {
        latestRoundData: () => {
          const a = answer();
          if (a === null) throw new Revert('feed down');
          return [77n, a, 0n, 0n, 77n];
        },
        decimals: () => dec,
      });
    this.setContract(A.ethUsd, feed(() => this.ethUsdAnswer, 8));
    this.setContract(A.usdcUsd, feed(() => this.usdcUsdAnswer, 8));
    this.setContract(WETH, this.view(erc20Abi, { decimals: () => 18 }));
    this.setContract(A.usdc, this.view(erc20Abi, { decimals: () => 6 }));
    this.setContract(GAS_ORACLE, this.view(gasOracleAbi, { getL1FeeUpperBound: ([size]) => 1_000_000n * BigInt(size) }));
    // the lens: one page of launches (at most 50) with their state
    this.setContract(A.lens, this.view(lensAbi, {
      registry: () => this.wiring.lensRegistry,
      graduator: () => this.wiring.lensGraduator,
      launchPage: ([start, count], s) => {
        const page = s.lens.slice(Number(start), Number(start) + Math.min(Number(count), 50));
        return [
          page.map((l) => l.token),
          page.map((l) => ({ status: l.status, curve: l.curve, quoteToken: l.quote, beneficiary: ZERO, quoteReserve: 1n, tokenReserve: l.status === 3 ? 0n : 1n, realQuoteReserve: 0n, graduationThreshold: 1n, totalSupply: 1n, poolKey: { currency0: ZERO, currency1: ZERO, fee: 0, tickSpacing: 0, hooks: ZERO }, launchedAt: 0n, holderDistributor: ZERO })),
        ];
      },
    }));
  }

  /** Multicall3's aggregate3: each call answered by the contract at its
   *  target, as the real one does - no code is an empty success, a failure
   *  is one unless the call allows it. */
  private aggregate3(data: string, block: bigint): string {
    const { args } = decodeFunctionData({ abi: multicall3Abi, data: data as `0x${string}` });
    const res = (args![0] as readonly { target: string; allowFailure: boolean; callData: `0x${string}` }[]).map((c) => {
      const t = c.target.toLowerCase();
      const h = this.contracts.get(t);
      if (!h && !this.eaters.has(t)) return { success: true, returnData: '0x' as `0x${string}` };
      try {
        if (this.eaters.has(t)) throw new Revert('out of gas');
        return { success: true, returnData: h!(c.callData, block) as `0x${string}` };
      } catch (e) {
        if (!c.allowFailure) throw e;
        return { success: false, returnData: '0x' as `0x${string}` };
      }
    });
    return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: res });
  }

  /** Takes Multicall3 away (a provider or chain without it). */
  withoutMulticall3(): void {
    this.contracts.delete(MULTICALL3);
  }

  /** Puts it back (it is there from the start). */
  withMulticall3(): void {
    this.setContract(MULTICALL3, (data, block) => this.aggregate3(data, block));
  }

  /** A launch the lens lists (no holder sharing needed), in registry order. */
  addLensLaunch(status: 1 | 2 | 3, seed = String(this.state.lens.length)): string {
    const token = lc('0x' + keccakHex(toHex(`lens token:${seed}`).slice(2)).slice(26));
    this.state.lens.push({ token, curve: lc('0x' + keccakHex(toHex(`lens curve:${seed}`).slice(2)).slice(26)), quote: WETH, status, readySince: 0n });
    this.snaps.set(this.latest, structuredClone(this.state));
    return token;
  }

  private installLaunch(L: Launch): void {
    const D = L.D;
    const root = (x: Root) => [x.merkleRoot, x.contentHash, x.cumHolders0, x.cumHolders1, x.cumKeeper0, x.fromBlock, x.toBlock, x.epoch, Number(x.payableAt)];
    const views = parseAbi([
      'function launchToken() view returns (address)',
      'function quoteToken() view returns (address)',
      'function graduator() view returns (address)',
      'function factory() view returns (address)',
      'function received0() view returns (uint256)',
      'function received1() view returns (uint256)',
      'function active() view returns (bytes32, bytes32, uint128, uint128, uint128, uint64, uint64, uint32, uint40)',
      'function pending() view returns (bytes32, bytes32, uint128, uint128, uint128, uint64, uint64, uint32, uint40)',
      'function lastProposedEpoch() view returns (uint32)',
      'function isExcluded(address account) view returns (bool)',
      'function paid0(address account) view returns (uint256)',
      'function paid1(address account) view returns (uint256)',
      'function totalPaid0() view returns (uint256)',
      'function totalPaid1() view returns (uint256)',
      'function keeperPaid0() view returns (uint256)',
    ]);
    this.setContract(D, this.view(views, {
      launchToken: () => L.token,
      quoteToken: () => L.quote,
      graduator: () => this.addr.graduator,
      factory: () => this.addr.factory,
      received0: (_a, s) => this.received0(this.launch(D, s)),
      received1: (_a, s) => this.received1(s, this.launch(D, s)),
      active: (_a, s) => root(this.launch(D, s).active),
      pending: (_a, s) => root(this.launch(D, s).pending),
      lastProposedEpoch: (_a, s) => this.launch(D, s).lastProposed,
      isExcluded: ([x], s) => this.isExcluded(s, this.launch(D, s), String(x)),
      paid0: ([x], s) => {
        if (this.paidReverts) throw new Revert('sim: paid0 reverts');
        return this.launch(D, s).paid0.get(lc(x)) ?? 0n;
      },
      paid1: ([x], s) => this.launch(D, s).paid1.get(lc(x)) ?? 0n,
      totalPaid0: (_a, s) => this.launch(D, s).totalPaid0,
      totalPaid1: (_a, s) => this.launch(D, s).totalPaid1,
      keeperPaid0: (_a, s) => this.launch(D, s).keeperPaid0,
    }));
    this.setContract(L.curve, this.view(reservesAbi, { feeEscrow: () => L.escrow, getReserves: (_a, s) => this.launch(D, s).reserves }));
    this.setContract(L.escrow, this.view(incomeAbi, { balanceOfToken: ([who], s) => (lc(who) === D ? this.launch(D, s).stuck0 : 0n), owed: () => 0n, held: () => 0n }));
    this.setContract(L.hook, this.view(incomeAbi, { balanceOfToken: () => 0n, owed: ([who], s) => (lc(who) === D ? this.launch(D, s).stuckHook0 : 0n), held: () => 0n }));
    this.setContract(L.token, this.view(erc20Abi, { decimals: () => 18 }));
  }

  // ------------------------------------------------------------ RPC

  private tag(p: string): bigint {
    if (p === 'latest' || p === 'pending' || p === undefined) return this.latest;
    if (p === 'safe' || p === 'finalized') return this.safe;
    return BigInt(p);
  }

  override async request(method: string, params: any[]): Promise<unknown> {
    switch (method) {
      case 'eth_getBlockByNumber': {
        // blocks before the simulation started exist too, two seconds apart
        if (/^0x/.test(params[0])) {
          const n = BigInt(params[0]);
          if (n < this.startBlock && n >= 0n && !this.headers.has(n)) {
            const h = this.headers.get(this.startBlock)!;
            this.headers.set(n, { hash: this.hashOf(n), parentHash: this.hashOf(n - 1n), timestamp: h.timestamp - (this.startBlock - n) * 2n });
          }
        }
        const r = (await super.request(method, params)) as any;
        if (r) r.baseFeePerGas = hex(this.baseFee);
        return r;
      }
      case 'eth_maxPriorityFeePerGas':
        this.calls.push({ method, params });
        return hex(this.tip);
      case 'eth_getBalance':
        this.calls.push({ method, params });
        return hex(this.at(this.tag(params[1])).eth.get(lc(params[0])) ?? 0n);
      case 'eth_getTransactionCount': {
        this.calls.push({ method, params });
        const a = lc(params[0]);
        const n = this.state.nonces.get(a) ?? 0;
        if (params[1] !== 'pending') return hex(n);
        let k = n;
        while (this.mempool.some((t) => t.from === a && t.nonce === k)) k++;
        return hex(k);
      }
      case 'eth_estimateGas': {
        this.calls.push({ method, params });
        const p = params[0];
        const work = structuredClone(this.state);
        work.ts = this.state.ts + this.blockTime;
        const res = this.exec(work, lc(p.from), lc(p.to), p.data ?? p.input ?? '0x', this.latest + 1n);
        if (!res.ok) throw new RpcError('execution reverted', { code: 3, data: res.revert });
        return hex(res.gasUsed);
      }
      case 'eth_call': {
        const p = params[0];
        if ((p.to === undefined || p.to === null) && String(p.data ?? p.input).toLowerCase().startsWith(PREVIEW_CODE)) {
          this.calls.push({ method, params });
          const data = String(p.data ?? p.input).toLowerCase();
          const D = lc('0x' + data.slice(-40));
          const block = this.tag(params[1]);
          const work = structuredClone(this.at(block));
          const l = work.launches.get(D);
          if (!l) return '0x' + '0'.repeat(192);
          const res = this.exec(work, '0x000000000000000000000000000000000000beef', D, '0x4641257d', block + 1n);
          const w = (n: bigint) => n.toString(16).padStart(64, '0');
          return '0x' + w(res.ok ? 1n : 0n) + w(this.received0(l)) + w(this.received1(work, l));
        }
        return super.request(method, params);
      }
      case 'eth_sendRawTransaction': {
        this.calls.push({ method, params });
        const raw = String(params[0]);
        this.sent.push(raw);
        const tx = parseTransaction(raw as `0x${string}`);
        const from = lc(await recoverTransactionAddress({ serializedTransaction: raw as any }));
        if (BigInt(tx.chainId ?? 0) !== this.chainId) throw new RpcError('invalid chain id', { code: -32000 });
        const hash = keccak256(raw as `0x${string}`).toLowerCase();
        if (this.txs.has(hash) || this.mempool.some((t) => t.hash === hash)) throw new RpcError('already known', { code: -32000 });
        const nonce = Number(tx.nonce);
        const want = this.state.nonces.get(from) ?? 0;
        if (nonce < want) throw new RpcError('nonce too low', { code: -32000 });
        const maxFee = BigInt(tx.maxFeePerGas ?? 0n);
        const tip = BigInt(tx.maxPriorityFeePerGas ?? 0n);
        const gas = BigInt(tx.gas ?? 0n);
        if ((this.state.eth.get(from) ?? 0n) < gas * maxFee) throw new RpcError('insufficient funds for gas * price + value', { code: -32000 });
        const old = this.mempool.find((t) => t.from === from && t.nonce === nonce);
        if (old) {
          if (maxFee * 10n < old.maxFee * 11n || tip * 10n < old.tip * 11n) throw new RpcError('replacement transaction underpriced', { code: -32000 });
          this.mempool.splice(this.mempool.indexOf(old), 1);
        }
        this.mempool.push({ hash, from, nonce, to: lc(tx.to), data: String(tx.data ?? '0x'), gas, maxFee, tip, raw });
        if (this.autoMine) this.mine();
        return hash;
      }
      case 'eth_getTransactionByHash': {
        const h = lc(params[0]);
        const m = this.mempool.find((t) => t.hash === h);
        if (m) {
          this.calls.push({ method, params });
          return { hash: m.hash, from: m.from, to: m.to, input: m.data, blockNumber: null, blockHash: null };
        }
        return super.request(method, params);
      }
      default:
        return super.request(method, params);
    }
  }
}

export { poolAbi, curveAbi };
