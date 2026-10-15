// Liveness: does each service still finish its ticks, and does anybody hear
// when it does not?
//
// A TICK THAT FAILS USED TO BE A LOG LINE AND NOTHING ELSE. One RPC provider
// down, out of quota or with a revoked key makes every keeper tick throw
// before it reaches any alert, while the heartbeat it still writes kept the
// standby idle: holder payouts stopped with no page and no time limit. The
// guardian and the verifiers were the same. So each of them remembers, in
// /data (it survives restarts and the --once runs on GitHub Actions), when its
// last clean tick was and since when every tick has failed, and pages once a
// failing streak is older than its failingAfterSec. The keeper's heartbeat
// carries the same two numbers, so the standby treats a primary that beats
// but never finishes as silent (keeper.ts), and the guardian writes its own
// heartbeat when it holds a data repo token.
//
// A VERIFIER WATCHES THE OTHERS. It reads the three heartbeats from the
// public data repo (no token: PublicRepo) and pages when no keeper has
// finished a clean tick for keeperSilentAfterSec - the primary AND the
// standby, so a healthy standby covering for a dead VPS stays a warning - or
// when the guardian has not for guardianSilentAfterSec. A verifier on GitHub
// Actions keeps watching when the VPS, its keeper and its verifier are all
// down at once.
//
// THE GUARDIAN'S HEARTBEAT IS SIGNED WITH ITS VETOER KEY, AND A VERIFIER
// TRUSTS IT ONLY WHEN THE SIGNER IS A VETOER ON CHAIN. The data repo cannot
// tell writers apart: the keeper's token (a fine-grained token cannot be held
// to one path) and anyone who steals it can write ops/status-guardian.json.
// The case the guardian exists for is exactly that keeper host in the wrong
// hands: a forged "ok" heartbeat would keep "guardian silent" quiet while the
// real guardian hung or crashed. Watching the guardian's on-chain activity
// instead does not work, since a healthy guardian sends nothing while every
// root verifies. A signature does: without the vetoer key nobody can write a
// heartbeat a verifier accepts, a replayed old one carries its old lastOkAt
// and goes stale, and a deleted or altered one pages as untrusted.

import { recoverMessageAddress } from 'viem';
import type { OpsContext } from './keeper.ts';
import { isVetoer } from './chainview.ts';
import { cleanAgeOf, parseBeat, GUARDIAN_STATUS_PATH, STANDBY_STATUS_PATH, STATUS_PATH, type Heartbeat } from './lease.ts';
import { errorText } from './log.ts';

/** JSON with sorted keys and no spaces (numbers allowed, undefined left
 *  out): the same text before and after a JSON round trip. */
function stable(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + stable(o[k])).join(',') + '}';
}

/** The text the guardian signs (EIP-191) for its heartbeat: a fixed first
 *  line, then the heartbeat without its signature, keys sorted. */
export function beatMessage(status: Record<string, unknown>): string {
  const rest = { ...status };
  delete rest.signature;
  return `curb.sharing.status/1 guardian heartbeat\n${stable(rest)}`;
}

/** Why a guardian heartbeat cannot be trusted, or null when it can: it must
 *  be for this chain and factory, signed by the guardian address it names,
 *  and that address must be a vetoer of the factory now. Throws when the
 *  chain cannot be read (unknown is not a page). */
export async function beatProblem(ctx: OpsContext, beat: Record<string, unknown>): Promise<string | null> {
  const sig = beat.signature;
  if (typeof sig !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(sig)) return 'it carries no signature';
  if (String(beat.chainId) !== ctx.cfg.sharing.chainId.toString() || String(beat.distributorFactory).toLowerCase() !== ctx.cfg.distributorFactory) return 'it names another chain or factory';
  let signer: string;
  try {
    signer = (await recoverMessageAddress({ message: beatMessage(beat), signature: sig as `0x${string}` })).toLowerCase();
  } catch {
    return 'its signature does not decode';
  }
  if (signer !== String(beat.guardian).toLowerCase()) return `it is signed by ${signer}, not by the guardian it names (${String(beat.guardian)})`;
  const r0 = ctx.readers[0];
  const head = (await r0.head('latest')).number;
  if (!(await isVetoer(r0, ctx.cfg.distributorFactory, signer, head))) return `its signer ${signer} is not a vetoer of ${ctx.cfg.distributorFactory}`;
  return null;
}

export type Who = 'keeper' | 'standby' | 'guardian' | 'verify';

export interface Liveness {
  /** Wall clock seconds of the last tick that finished cleanly. */
  lastOkAt: number | null;
  /** Wall clock seconds of the first failed tick of the current streak. */
  failingSince: number | null;
  lastError: string | null;
}

const NONE: Liveness = { lastOkAt: null, failingSince: null, lastError: null };

/** `30 min`, `3.5 h`, `2 d`; `never` for Infinity. */
export function ago(sec: number): string {
  if (!Number.isFinite(sec)) return 'never';
  if (sec < 5400) return `${Math.max(0, Math.round(sec / 60))} min`;
  if (sec < 172800) return `${Math.round(sec / 360) / 10} h`;
  return `${Math.round(sec / 8640) / 10} d`;
}

const WHAT: Record<Who, { name: string; stake: string }> = {
  keeper: { name: 'The keeper', stake: 'No epoch is published, no root activated and no payout pushed while this lasts; the income waits in the distributors (nothing is lost). The standby takes over once the last clean tick is older than its takeover age.' },
  standby: { name: 'The STANDBY keeper', stake: 'It is acting because the primary is silent, and it fails too: no keeper is paying holders. The income waits in the distributors (nothing is lost).' },
  guardian: { name: 'The guardian', stake: 'A wrong root is not vetoed by it while this lasts: inside the veto hour only the Safe signers could veto.' },
  verify: { name: 'A verifier', stake: 'Published epochs are not re-checked by it while this lasts.' },
};

/** Records how this tick ended and pages once every tick has failed for
 *  `failingAfterSec`. `changed` says whether the tick flipped the state
 *  (clean -> failing or back): the heartbeat is then written at once. */
export async function trackLiveness(ctx: OpsContext, who: Who, ok: boolean, error: string | null, failingAfterSec: number): Promise<Liveness & { changed: boolean }> {
  const nowS = Math.floor(ctx.now() / 1000);
  const prev = { ...NONE, ...ctx.store.get<Liveness>('liveness', NONE) };
  const next: Liveness = ok ? { lastOkAt: nowS, failingSince: null, lastError: null } : { lastOkAt: prev.lastOkAt, failingSince: prev.failingSince ?? nowS, lastError: error ?? 'a tick failed' };
  ctx.store.set('liveness', next);
  const changed = (prev.failingSince === null) !== (next.failingSince === null);
  if (!ok && nowS - next.failingSince! >= failingAfterSec) {
    const w = WHAT[who];
    await ctx.alerts.raise(
      {
        key: `failing:${who}`,
        severity: 'page',
        title: `${w.name} has had NO CLEAN TICK for ${ago(nowS - next.failingSince!)}`,
        text: `Every tick since ${new Date(next.failingSince! * 1000).toISOString()} failed (last clean tick: ${next.lastOkAt === null ? 'none recorded' : new Date(next.lastOkAt * 1000).toISOString()}). The last error: ${next.lastError}. ${w.stake}`,
      },
      { cooldownSec: ctx.cfg.alerts.reminderSec },
    );
  }
  return { ...next, changed };
}

/** The verifier's watch over the keepers' and the guardian's heartbeats.
 *  Returns the errors met reading them (the tick counts them as failures). */
export async function watchHeartbeats(ctx: OpsContext): Promise<string[]> {
  const pr = ctx.publicRepo;
  if (!pr) return [];
  const { cfg } = ctx;
  const nowS = Math.floor(ctx.now() / 1000);
  const errors: string[] = [];
  const read = async (path: string, role: string): Promise<Heartbeat | null | undefined> => {
    try {
      return parseBeat(await pr.get(path), role);
    } catch (e) {
      errors.push(`heartbeat ${path}: ${errorText(e)}`);
      return undefined; // unknown: never a page on this host's own failure to read
    }
  };
  const primary = await read(STATUS_PATH, 'primary');
  const standby = await read(STANDBY_STATUS_PATH, 'standby');
  if (primary !== undefined && standby !== undefined) {
    const pq = cleanAgeOf(primary, nowS);
    const sq = cleanAgeOf(standby, nowS);
    if (Math.min(pq, sq) >= cfg.verifier.keeperSilentAfterSec) {
      const err = (b: Heartbeat | null) => (b?.errors?.length ? `; its last error: ${b.errors[0]}` : '');
      await ctx.alerts.raise(
        {
          key: 'keepers-silent',
          severity: 'page',
          title: `NO KEEPER has finished a clean tick for ${ago(Math.min(pq, sq))}`,
          text: `The primary${primary ? ` (${primary.holder})` : ''}: ${primary ? `last clean tick ${ago(pq)} ago, last heartbeat ${ago(nowS - primary.heartbeatAt)} ago${err(primary)}` : 'no heartbeat in the data repo'}. The standby: ${standby ? `last clean tick ${ago(sq)} ago${err(standby)}` : 'it has never reported'}. No epoch is published, no root activated and no payout pushed until one runs (nothing is lost: the income waits in the distributors). Fix the keeper host (RUNBOOK part 8), and check that the sharing-keeper workflow is enabled and its runs succeed.`,
        },
        { cooldownSec: cfg.alerts.reminderSec },
      );
    }
  }
  if (cfg.verifier.guardianSilentAfterSec > 0) {
    const guardian = await read(GUARDIAN_STATUS_PATH, 'guardian');
    let why: string | null = null;
    let known = guardian !== undefined;
    if (guardian) {
      try {
        why = await beatProblem(ctx, guardian as unknown as Record<string, unknown>);
      } catch (e) {
        errors.push(`heartbeat ${GUARDIAN_STATUS_PATH}: its signer could not be checked on chain: ${errorText(e)}`);
        known = false;
      }
    }
    if (known) {
      // an untrusted heartbeat says nothing: the guardian counts as silent
      const trusted = guardian && !why ? guardian : null;
      const gq = cleanAgeOf(trusted, nowS);
      if (gq >= cfg.verifier.guardianSilentAfterSec) {
        await ctx.alerts.raise(
          {
            key: 'guardian-silent',
            severity: 'page',
            title: why ? 'The GUARDIAN heartbeat is NOT SIGNED by a vetoer' : trusted ? `The GUARDIAN has not finished a clean tick for ${ago(gq)}` : 'The GUARDIAN has never written a heartbeat',
            text: `${why ? `${GUARDIAN_STATUS_PATH} cannot be trusted: ${why}. Anyone who can write the data repo can write that file, so what it says (ok, a recent clean tick) counts for nothing; treat the guardian as down until it writes one signed with its vetoer key.` : trusted ? `Its heartbeat (${GUARDIAN_STATUS_PATH}, ${trusted.holder}) was written ${ago(nowS - trusted.heartbeatAt)} ago; its last clean tick ${ago(gq)} ago${trusted.errors?.length ? `; its last error: ${trusted.errors[0]}` : ''}.` : `There is no ${GUARDIAN_STATUS_PATH} in the data repo: the guardian has no data_repo_token, or has never run.`} While it is down a wrong root is not vetoed by it inside its hour - only the Safe signers could. Ask the guardian operator to check their container.`,
          },
          { cooldownSec: cfg.alerts.reminderSec },
        );
      }
    }
  }
  return errors;
}
