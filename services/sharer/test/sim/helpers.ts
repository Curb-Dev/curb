// Shared by the ops tests.

import { decodeFunctionData, decodeFunctionResult, encodeFunctionResult } from 'viem';
import { keeperTick } from '../../src/ops/keeper.ts';
import { MULTICALL3, multicall3Abi } from '../../src/ops/abis.ts';
import type { Rpc } from '../../src/chain/rpc.ts';
import type { Signer } from '../../src/ops/tx.ts';
import type { OpsWorld } from './world.ts';

export const js = (x: unknown): string => JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 1);

export async function tick(_w: OpsWorld, k: ReturnType<OpsWorld['make']>, o: { waitForSafe?: boolean; role?: 'primary' | 'standby' } = {}) {
  return keeperTick(k.ctx, k.keys, { lease: k.lease, role: o.role ?? k.role, waitForSafe: o.waitForSafe ?? true, holder: k.holder });
}

/** A provider that answers like `inner` except where `edit` changes it. */
export function lying(inner: Rpc, label: string, edit: (method: string, params: any[], result: unknown) => unknown): Rpc {
  return {
    label,
    async request(a) {
      const r = await inner.request(a);
      return edit(a.method, (a.params ?? []) as any[], r);
    },
  };
}

/** A provider whose answer to one call - to `target`, its data starting
 *  with `selector` - is `answer`, whether the call is made on its own or
 *  inside a Multicall3 aggregate3 batch (as the guardian reads the roots). */
export function lyingCall(inner: Rpc, label: string, target: string, selector: string, answer: string): Rpc {
  const t = target.toLowerCase();
  return lying(inner, label, (m, p, r) => {
    if (m !== 'eth_call') return r;
    const to = String(p[0]?.to).toLowerCase();
    const data = String(p[0]?.data ?? p[0]?.input) as `0x${string}`;
    if (to === t && data.startsWith(selector)) return answer;
    if (to !== MULTICALL3) return r;
    const calls = decodeFunctionData({ abi: multicall3Abi, data }).args![0] as readonly { target: string; callData: string }[];
    const res = decodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', data: r as `0x${string}` }) as readonly { success: boolean; returnData: `0x${string}` }[];
    return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: res.map((x, i) => (calls[i].target.toLowerCase() === t && calls[i].callData.startsWith(selector) ? { success: true, returnData: answer as `0x${string}` } : x)) });
  });
}

/** A signer that fails like a crash when `when` says so. */
export function crashing(s: Signer, when: (tx: { to: string; data: string }) => boolean): Signer & { armed: boolean } {
  const c = {
    armed: true,
    address: s.address,
    sign: async (tx: any) => {
      if (c.armed && when(tx)) throw new Error('CRASH (simulated)');
      return s.sign(tx);
    },
  };
  return c;
}

export const alertKeys = (k: { ctx: { alerts: { raised: { key: string }[] } } }): string[] => k.ctx.alerts.raised.map((a) => a.key);
