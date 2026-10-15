// The probe: many read calls at one block in one eth_call, each given exactly
// the same gas (CURB-SHARE v1, spec 1.3 step 4 and 4.10).
//
// The calls go to addresses anybody can put in front of the sharer: every
// account a replayed Transfer names is probed, and a zero-value transfer can
// name any address, including one that burns all the gas a call gives it.
// Through Multicall3 each call got 63/64 of what was left, so a few such
// addresses starved every call after them; asking the starved calls again on
// their own gave them other gas than the batch had, and turned every reverting
// contract into three extra requests per reader per epoch.
//
// SharerProbe (src/curb/sharing/SharerProbe.sol) is run instead as a
// deployless eth_call - its creation code in `data`, no `to` - with the calls
// appended. Its constructor STATICCALLs each target with exactly
// PROBE_CALL_GAS, stops before a call it could not give that much (or whose
// answer would not fit), and returns the answers as the code it would deploy.
// The reader sends the calls it did not get to in the next request, from
// where it stopped. Nothing is asked twice, every call sees the same gas on
// every provider and in every position, and request boundaries are a function
// of the calls and the chain alone, so every reader built from this file
// draws them in the same places.

/** SharerProbe's creation code (out/SharerProbe.sol/SharerProbe.json
 *  `bytecode`, compiled without the metadata hash). */
export const PROBE_INITCODE =
  '0x6080604052346101045738601f19016020815f395f51908111610104576040519080601f19813803018339810190601f19601f8301169161600083019260208101905f935b828482101561010857601482015160f01c60168184010192868411610104578860c08701116100f55760c08587030160c802620194b0015a106100e4575f91816016849301905160601c620186a0fa9360203d91828760ff1b17815201946100b4575b5050600190940193610044565b90816001939560a060209492116100db575b5f82913e601f01601f1916010192905f6100a7565b60a091506100c6565b505050509350905082915b82520390f35b505050509350905082916100ef565b5f80fd5b50509350905082916100ef56fe';

/** keccak256(PROBE_INITCODE): the number the spec (4.10) and
 *  test/sharing/SharerProbe.t.sol pin (test/probe.test.ts checks all three). */
export const PROBE_CODE_HASH = '0xb6280b759f2832de05a3812c4335bc2ac47927b4ae5c63533efe8b286d8a6ac0';

/** Gas each probed call is given, exactly (SharerProbe CALL_GAS). */
export const PROBE_CALL_GAS = 100_000n;
/** Bytes of a successful answer the probe returns (SharerProbe RETURN_CAP). */
export const PROBE_RETURN_CAP = 160;
/** Gas of each probe request: under EIP-7825's per-transaction cap. */
export const PROBE_REQUEST_GAS = 15_000_000n;
/** EIP-3860: the most initcode a creation may carry. */
export const PROBE_MAX_INITCODE = 49_152;
/** The sender of every probe request, so the probe runs at the same address
 *  (and probed code sees the same msg.sender) on every provider. */
export const PROBE_FROM = '0x0000000000000000000000000000000000000000';

const INIT_BYTES = (PROBE_INITCODE.length - 2) / 2;
/** Room for the packed calls in one request. */
const MAX_PACKED = PROBE_MAX_INITCODE - INIT_BYTES - 32;
const SIZE_MASK = (1n << 255n) - 1n;

export interface ProbeCall {
  to: string;
  data: string;
}

export interface ProbeAnswer {
  success: boolean;
  returnData: string;
}

export class ProbeError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ProbeError';
  }
}

/** One call as the probe reads it: target (20 bytes), length (2), calldata. */
function packOne(c: ProbeCall): string {
  if (typeof c.to !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(c.to)) throw new ProbeError(`a probe call's target is not an address: ${String(c.to)}`);
  if (typeof c.data !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(c.data)) throw new ProbeError(`a probe call's data is not hex bytes: ${String(c.data)}`);
  const n = (c.data.length - 2) / 2;
  if (22 + n > MAX_PACKED) throw new ProbeError(`a probe call of ${n} bytes does not fit in one request`);
  return c.to.slice(2).toLowerCase() + n.toString(16).padStart(4, '0') + c.data.slice(2).toLowerCase();
}

/** The request for the calls from `start` on: as many as fit in EIP-3860's
 *  initcode limit, in order. */
export function probeRequest(calls: ProbeCall[], start: number): { data: string; count: number } {
  let packed = '';
  let count = 0;
  for (let i = start; i < calls.length; i++) {
    const one = packOne(calls[i]);
    if ((packed.length + one.length) / 2 > MAX_PACKED) break;
    packed += one;
    count++;
  }
  const len = (packed.length / 2).toString(16).padStart(64, '0');
  return { data: PROBE_INITCODE + packed + len, count };
}

/** The probe's answer to a request of `asked` calls: the answers of the first
 *  n of them, n <= asked. Anything not of exactly the probe's shape is an
 *  error. */
export function decodeProbeAnswer(raw: string, asked: number): ProbeAnswer[] {
  if (typeof raw !== 'string' || !/^0x([0-9a-fA-F]{64})+$/.test(raw)) throw new ProbeError(`the probe answered something that is not whole words: ${String(raw).slice(0, 80)}`);
  const hex = raw.slice(2).toLowerCase();
  const word = (at: number): bigint => BigInt('0x' + hex.slice(at * 2, at * 2 + 64));
  const n = word(0);
  if (n > BigInt(asked)) throw new ProbeError(`the probe answered ${n} calls of ${asked}`);
  const out: ProbeAnswer[] = [];
  let at = 32;
  const total = hex.length / 2;
  for (let i = 0n; i < n; i++) {
    if (at + 32 > total) throw new ProbeError(`the probe's answer ends inside call ${i}`);
    const h = word(at);
    at += 32;
    const success = h >> 255n === 1n;
    const size = h & SIZE_MASK;
    if (!success) {
      out.push({ success: false, returnData: '0x' });
      continue;
    }
    const c = size > BigInt(PROBE_RETURN_CAP) ? PROBE_RETURN_CAP : Number(size);
    const padded = Math.ceil(c / 32) * 32;
    if (at + padded > total) throw new ProbeError(`the probe's answer ends inside call ${i}`);
    if (/[^0]/.test(hex.slice((at + c) * 2, (at + padded) * 2))) throw new ProbeError(`the padding of call ${i}'s answer is not zero`);
    out.push({ success: true, returnData: '0x' + hex.slice(at * 2, (at + c) * 2) });
    at += padded;
  }
  if (at !== total) throw new ProbeError(`the probe's answer has ${total - at} bytes after its last call`);
  return out;
}
