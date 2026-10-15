// `rebuild`: refills /data from the chain and the published files, and
// checks every one of them on the way (design D.2.1). It signs nothing.
// The keeper never needs it - it rebuilds what it needs lazily - but after a
// lost volume it puts every file in the cache at once, so the next tick does
// not stall fetching history, and it reports any published file that no
// longer hashes to its root.
//
// The `verify` path of the public CLI (`curb-sharer verify --distributor X
// --epoch N --rpc URL`) lives here too: one epoch, a report, an exit code.

import type { Address } from '../calc/types.ts';
import { readWholeEpoch } from '../epoch-chunks.ts';
import { readEpochHistory } from '../chain/indexer.ts';
import { decodeEventLog, keccak256, toHex } from 'viem';
import type { OpsContext } from './keeper.ts';
import { discover, noteHeld, recordSkip } from './keeper.ts';
import { commonHead, readDist } from './chainview.ts';
import { opsDistributorAbi } from './abis.ts';
import { verifyPublished, type VerifyDeps, type VerifyResult } from './verify.ts';
import { errorText } from './log.ts';

const PUSH_SKIPPED = keccak256(toHex('PushSkipped(address,uint8)'));

export interface RebuildReport {
  distributors: number;
  files: { distributor: Address; epoch: bigint; ok: boolean; source?: string; error?: string }[];
  skips: number;
}

export async function rebuild(ctx: OpsContext): Promise<RebuildReport> {
  const r0 = ctx.readers[0];
  const out: RebuildReport = { distributors: 0, files: [], skips: 0 };
  const safe = await commonHead(ctx.readers, 'safe');
  ctx.store.delete('discovery');
  const ds = await discover(ctx, safe.number);
  out.distributors = ds.length;
  const uris: Record<string, string> = {};
  for (const d of ds) {
    const meta = await ctx.meta.get(r0, ctx.cfg.sharing.graduator, d, safe.number);
    const v = await readDist(r0, d, safe.number);
    const { published, vetoed } = await readEpochHistory(r0, d, meta.sharingSince, safe.number);
    const vetoedSet = new Set(vetoed.map((x) => x.epoch.toString()));
    for (const p of published) {
      uris[`${d}:${p.epoch}`] = p.uri;
      try {
        const { bytes, source } = await ctx.files.fetchVerified(d, p.epoch, p.contentHash, p.uri);
        // the held-at memory follows the active lineage only, from whole
        // files: every chunk the index names, each checked and cached
        if (!vetoedSet.has(p.epoch.toString()) && p.epoch <= v.active.epoch) noteHeld(ctx, d, (await readWholeEpoch(ctx.files, d, bytes)).file);
        out.files.push({ distributor: d, epoch: p.epoch, ok: true, source });
      } catch (e) {
        out.files.push({ distributor: d, epoch: p.epoch, ok: false, error: errorText(e) });
        await ctx.alerts.raise({ key: `rebuild-missing:${d}:${p.epoch}`, severity: 'warn', title: 'A published epoch file cannot be found', text: `${errorText(e)}`, distributor: d });
      }
    }
    for (const l of await r0.logs({ address: d, topics: [PUSH_SKIPPED] }, meta.sharingSince, safe.number)) {
      const ev = decodeEventLog({ abi: opsDistributorAbi, topics: l.topics as any, data: l.data as `0x${string}`, strict: true });
      recordSkip(ctx, d, String((ev.args as any).account).toLowerCase(), Number((await r0.block(BigInt(l.blockNumber))).timestamp), null);
      out.skips++;
    }
  }
  ctx.store.set('uris', uris);
  ctx.store.flush();
  return out;
}

/** The public verifier: one epoch of one distributor. */
export async function verifyOne(deps: VerifyDeps, d: Address, epoch: bigint): Promise<{ code: number; result: VerifyResult | null; text: string }> {
  const r0 = deps.readers[0];
  const D = d.toLowerCase();
  const latest = await commonHead(deps.readers, 'latest');
  const { published, vetoed } = await readEpochHistory(r0, D, deps.sharing.graduatorFromBlock, latest.number);
  const p = published.find((x) => x.epoch === epoch);
  if (!p) return { code: 2, result: null, text: `no RootPublished for epoch ${epoch} of ${D}` };
  const v = await readDist(r0, D, latest.number);
  const state = vetoed.some((x) => x.epoch === epoch) ? 'vetoed' : v.active.epoch === epoch ? 'active' : v.pending.payableAt !== 0n && v.pending.epoch === epoch ? `pending, payable at ${v.pending.payableAt}` : epoch < v.active.epoch ? 'superseded by a later epoch' : 'unknown';
  const res = await verifyPublished(deps, D, p);
  const lines = [
    `distributor  ${D}`,
    `epoch        ${epoch} (${state})`,
    `contentHash  ${p.contentHash}`,
    `uri          ${p.uri}`,
    ...res.copies.map((c) => `copy         ${c.source}: ${c.ok ? 'sha256 ok' : c.error}`),
    `verdict      ${res.verdict.toUpperCase()}${res.reason ? ` (${res.reason})` : ''}`,
    ...res.problems.map((x) => `  - ${x}`),
  ];
  return { code: res.verdict === 'ok' ? 0 : res.verdict === 'mismatch' ? 1 : 2, result: res, text: lines.join('\n') };
}
