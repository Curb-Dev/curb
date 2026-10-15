// `check --probe`: the publishing path, exercised end to end before the first
// real epoch needs it (gap item 16).
//
// `check` alone reads; nothing proved that this host can WRITE. The first
// epoch used to be the first time the data repo token wrote, the pinners
// stored a file and answered its CID, the site's rewrite served the data
// repo, a gateway found the pin and an alert reached a person - and any one
// failing stopped publishing exactly then. The probe does each of them with a
// small file of its own:
//
//   1. writes sharing/<chain>/probe/<host>-<time>.json to the data repo and
//      reads it back through the API;
//   2. pins its bytes on every configured pinner, each of which must answer
//      exactly the CID computed here (cid.ts, Kubo's own);
//   3. reads it back through the site (the rewrite) and through the IPFS
//      gateways (at least one must serve it), each copy checked by sha256;
//   4. deletes it from the data repo again;
//   5. sends a test alert through every sink.
//
// The pins stay (a few hundred bytes, named curb-probe-...); everything else
// is left as it was. Each failure is a problem `check` prints as NOT OK.

import { sha256Hex } from '../calc/encoding.ts';
import type { OpsContext } from './keeper.ts';
import { testAlert } from './alerts.ts';
import { fileCid } from './cid.ts';
import { errorText } from './log.ts';

export async function writeProbe(ctx: OpsContext, o: { host: string }): Promise<{ lines: string[]; problems: string[] }> {
  const { cfg } = ctx;
  const lines: string[] = [];
  const problems: string[] = [];
  const at = new Date(ctx.now());
  const tag = `${o.host.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 40)}-${at.getTime()}`;
  const path = `sharing/${cfg.sharing.chainId}/probe/${tag}.json`;
  const bytes = new TextEncoder().encode(JSON.stringify({ schema: 'curb.sharing.probe/1', host: o.host, at: at.toISOString(), note: 'written and deleted by curb-sharer check --probe; safe to delete' }) + '\n');
  const hash = sha256Hex(bytes);
  const cid = fileCid(bytes);
  lines.push(`probe file ${path}: sha256 ${hash}, CID ${cid}`);

  // 1. the data repo
  let written = false;
  if (!ctx.repo) problems.push('probe: no data repo to write to (config.dataRepo and the data_repo_token secret are needed)');
  else {
    try {
      await ctx.repo.put(path, bytes, `write probe from ${o.host}`, null);
      const back = await ctx.repo.get(path);
      if (!back || sha256Hex(back.bytes) !== hash) problems.push(`probe: the data repo did not give the probe file back as written`);
      else {
        written = true;
        lines.push(`probe: data repo write: ok (${ctx.repo.owner}/${ctx.repo.repo}@${ctx.repo.branch})`);
      }
    } catch (e) {
      problems.push(`probe: the data repo refused the write: ${errorText(e)}`);
    }
  }

  // 2. the pins, each answering this CID
  const configured = cfg.ipfs.pinners.map((p) => p.name);
  const made = new Set(ctx.pinners.map((p) => p.name));
  for (const name of configured) if (!made.has(name)) problems.push(`probe: pinner ${name} cannot run here (its pin_tokens entry is not set)`);
  let counted = 0;
  for (const p of ctx.pinners) {
    const r = await p.pin(bytes, cid, `curb-probe-${tag}.json`);
    if (r.ok) {
      if (r.counts) counted++;
      lines.push(`probe: pin ${r.pinner}: stored under ${cid}${r.counts ? '' : ' (asked to fetch it; does not count)'}`);
    } else problems.push(`probe: pin ${r.pinner} failed: ${r.error}${r.cid && r.cid !== cid ? ' - this pinner would never count for an epoch: use a Kubo-compatible service (RUNBOOK part 5)' : ''}`);
  }
  if (counted < cfg.ipfs.minPinned) problems.push(`probe: ${counted} pinner(s) stored it under ${cid}; an epoch needs ${cfg.ipfs.minPinned} (config.ipfs.minPinned)`);

  // 3. read back: the site's rewrite, and the gateways
  const tries = ctx.refetch?.tries ?? 6;
  const delayMs = ctx.refetch?.delayMs ?? 5000;
  const site = ctx.files.siteBase;
  const sources: [string, string, string | null][] = [];
  if (!site) problems.push('probe: no site is configured to read the file back from (config.site)');
  else if (written) sources.push(['site', `${site}/${path}`, null]);
  if (!ctx.files.gateways.length) problems.push('probe: no IPFS gateway is configured (config.ipfs.gateways)');
  else if (counted > 0) for (const g of ctx.files.gateways) sources.push([`gateway ${g}`, `${g}/ipfs/${cid}`, cid]);
  const gws = sources.filter(([s]) => s.startsWith('gateway'));
  const ok = new Set<string>();
  const pending = new Set(sources.map(([s]) => s));
  const lastError = new Map<string, string>();
  // CDN and gateway lag: asked again, with growing pauses, like a publish
  for (let i = 0; i < tries && pending.size; i++) {
    if (i > 0) await ctx.sleep(delayMs * i);
    for (const [s, u, want] of sources) {
      if (!pending.has(s)) continue;
      const { check } = await ctx.files.checkCopy(s, u, hash, want);
      if (check.ok) {
        ok.add(s);
        pending.delete(s);
      } else {
        lastError.set(s, check.error ?? 'no copy');
        if (check.sha256) pending.delete(s); // there, with other bytes: not lag
      }
    }
    // enough: the site and one gateway
    if ((!sources.some(([s]) => s === 'site') || ok.has('site')) && (!gws.length || gws.some(([s]) => ok.has(s)))) break;
  }
  for (const [s] of sources) {
    if (ok.has(s)) lines.push(`probe: read back through ${s}: ok`);
    else if (s === 'site') problems.push(`probe: the site does not serve the data repo's file (${lastError.get(s)}): check the /sharing/<chain>/ rewrite (RUNBOOK part 4)`);
    else lines.push(`probe: read back through ${s}: not served (${lastError.get(s)})`);
  }
  if (gws.length && !gws.some(([s]) => ok.has(s))) problems.push('probe: no IPFS gateway serves the pinned file: an epoch could not be read back from IPFS');

  // 4. clean up
  if (written && ctx.repo) {
    try {
      const cur = await ctx.repo.get(path);
      if (cur) await ctx.repo.remove(path, `write probe from ${o.host}: removed`, cur.sha);
      lines.push('probe: data repo delete: ok');
    } catch (e) {
      problems.push(`probe: the probe file could not be deleted (${path}; remove it by hand): ${errorText(e)}`);
    }
  }

  // 5. a person hears it
  const sent = await ctx.alerts.test(testAlert(o.host, 'check --probe', at, `the write probe of ${cfg.sharing.chainId}`));
  for (const d of sent) {
    if (d.ok) lines.push(`probe: alert sink ${d.sink}: delivered`);
    else problems.push(`probe: alert sink ${d.sink} failed: ${d.error}`);
  }
  return { lines, problems };
}
