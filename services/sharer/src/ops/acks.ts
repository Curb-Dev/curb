// An operator's acknowledgement of a veto (design D.2.8: after a veto the
// next epoch recomputes the reopened range, but only after an operator has
// looked). Kept in the data repo (ops/acks.json) so the VPS keeper and the
// GitHub Actions standby see the same answer, and in /data for a keeper with
// no data repo. Written by `curb-sharer ack-veto --distributor D --epoch N`.

import type { Address } from '../calc/types.ts';
import type { DataRepo } from './github.ts';
import { Conflict } from './github.ts';
import type { Store } from './store.ts';

export const ACKS_PATH = 'ops/acks.json';

export interface Ack {
  distributor: Address;
  epoch: string;
  by: string;
  at: string;
  note?: string;
}

function parse(b: Uint8Array | null): Ack[] {
  if (!b) return [];
  try {
    const j = JSON.parse(new TextDecoder().decode(b));
    return Array.isArray(j?.acks) ? j.acks.filter((a: any) => typeof a?.distributor === 'string' && typeof a?.epoch === 'string') : [];
  } catch {
    return [];
  }
}

/** Every acknowledged (distributor:epoch), lowercase. */
export async function readAcks(ctx: { repo: DataRepo | null; store: Store }): Promise<Set<string>> {
  const out = new Set<string>();
  for (const a of parse(ctx.store.readFile('acks.json'))) out.add(`${a.distributor.toLowerCase()}:${a.epoch}`);
  if (ctx.repo) {
    const f = await ctx.repo.get(ACKS_PATH);
    for (const a of parse(f ? f.bytes : null)) out.add(`${a.distributor.toLowerCase()}:${a.epoch}`);
  }
  return out;
}

export async function writeAck(ctx: { repo: DataRepo | null; store: Store }, ack: Ack): Promise<void> {
  const enc = (list: Ack[]) => new TextEncoder().encode(JSON.stringify({ schema: 'curb.sharing.acks/1', acks: list }, null, 1) + '\n');
  const local = parse(ctx.store.readFile('acks.json'));
  local.push(ack);
  ctx.store.writeFile('acks.json', enc(local));
  if (!ctx.repo) return;
  for (let i = 0; i < 4; i++) {
    const cur = await ctx.repo.get(ACKS_PATH);
    const list = parse(cur ? cur.bytes : null);
    if (list.some((a) => a.distributor.toLowerCase() === ack.distributor.toLowerCase() && a.epoch === ack.epoch)) return;
    list.push(ack);
    try {
      await ctx.repo.put(ACKS_PATH, enc(list), `ack veto of epoch ${ack.epoch} of ${ack.distributor} by ${ack.by}`, cur ? cur.sha : null);
      return;
    } catch (e) {
      if (!(e instanceof Conflict)) throw e;
    }
  }
  throw new Conflict('ack not written: lost the race four times');
}
