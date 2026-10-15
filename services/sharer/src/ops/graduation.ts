// Launches stuck in Waiting (gap item 18).
//
// WAITING IS A LAUNCH NOBODY CAN TRADE. The curve's sellable allocation is
// bought out, so buying is closed and sell() refuses, and the pool does not
// exist until graduate() runs. The crossing buy normally graduates in the
// same transaction, but a buyer who starves that call of gas (the 63/64 rule)
// or an issuer blocking a leg leaves it in Waiting, announced only by an
// AutoGraduationFailed event that nothing read.
//
// So the keeper reads every launch's state through LaunchLens.launchPage (the
// lens derives Waiting from the curve and the graduator, events or not) every
// graduationScanSec, alerts on each launch in Waiting with Graduator.graduate
// ready to send - it is permissionless - and, with completeGraduations (the
// default), sends it itself from the pusher key. A graduate() that would
// revert is never sent: the page says why, for a person (an escrow blocked by
// an issuer needs rescueCurveFees first). The scan resumes past the leading
// launches already Graduated, which never change again.
//
// THE RESCUE'S HOUR STARTS WITHOUT A PERSON. Graduator.rescueCurveFees is
// open at once to the curve's creator-fee recipient and the record's
// platform recipient, and to anyone else only RESCUE_DELAY (an hour) after
// Graduator.noteReady(token) has noted the launch full and ungraduated. So
// when graduate() would revert for a launch in Waiting, the keeper sends
// noteReady itself (once: readySince is written once, and read first), and
// the page says when the rescue opens to anyone.

import { encodeFunctionData, parseAbi } from 'viem';
import type { Address } from '../calc/types.ts';
import type { OpsContext } from './keeper.ts';
import type { ReadyCall } from './alerts.ts';
import { errorText } from './log.ts';
import { WouldRevert } from './tx.ts';
import { GRADUATOR_ERRORS } from './abis.ts';

export const lensAbi = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct LaunchView { uint8 status; address curve; address quoteToken; address beneficiary; uint256 quoteReserve; uint256 tokenReserve; uint256 realQuoteReserve; uint256 graduationThreshold; uint256 totalSupply; PoolKey poolKey; uint64 launchedAt; address holderDistributor; }',
  'function launchPage(uint256 start, uint256 count) view returns (address[] tokens, LaunchView[] views)',
  'function registry() view returns (address)',
  'function graduator() view returns (address)',
]);

export const graduateAbi = parseAbi(['function graduate(address launchToken)']);

/** The Graduator's fee rescue around a blocked escrow (src/curb/Graduator.sol). */
export const rescueAbi = parseAbi([
  'function noteReady(address launchToken) returns (uint256 since)',
  'function readySince(address launchToken) view returns (uint256)',
  'function rescueCurveFees(address launchToken) returns (uint256 protocolAmount, uint256 creatorAmount)',
  ...GRADUATOR_ERRORS,
]);
/** Graduator.RESCUE_DELAY: from noteReady until the rescue is open to anyone. */
export const RESCUE_DELAY_SEC = 3600n;

const iso = (sec: bigint): string => new Date(Number(sec) * 1000).toISOString();

/** LaunchLens.LaunchStatus. */
export const STATUS = { NotFound: 0, Selling: 1, Waiting: 2, Graduated: 3 } as const;
/** LaunchLens.MAX_PAGE: a page longer than this is cut to it. */
const PAGE = 50;

export interface Waiting {
  token: Address;
  curve: Address;
  quote: Address;
  index: number;
}

/** Every launch in Waiting, read through the lens at `block`. Moves the
 *  stored cursor past the leading launches that are Graduated. */
export async function scanWaiting(ctx: OpsContext, lens: Address, block: bigint): Promise<Waiting[]> {
  const r0 = ctx.readers[0];
  const cur = ctx.store.get<{ at: number; from: number }>('graduation', { at: 0, from: 0 });
  const out: Waiting[] = [];
  let start = cur.from;
  let leading = true;
  for (;;) {
    const [tokens, views] = (await r0.read<readonly [readonly string[], readonly any[]]>(lensAbi, lens, 'launchPage', [BigInt(start), BigInt(PAGE)], block)) as readonly [readonly string[], readonly any[]];
    for (let i = 0; i < tokens.length; i++) {
      const status = Number(views[i].status);
      if (leading && status === STATUS.Graduated) cur.from = start + i + 1;
      else leading = false;
      if (status === STATUS.Waiting) out.push({ token: tokens[i].toLowerCase(), curve: String(views[i].curve).toLowerCase(), quote: String(views[i].quoteToken).toLowerCase(), index: start + i });
    }
    if (tokens.length < PAGE) break;
    start += tokens.length;
  }
  cur.at = Math.floor(ctx.now() / 1000);
  ctx.store.set('graduation', cur);
  return out;
}

type Send = (who: 'pusher', req: { to: string; data: string; label: string; distributors: string[] }) => Promise<{ hash: string; receipt: { status: boolean; blockNumber: bigint } }>;

/** When the fee rescue of a launch stuck in Waiting opens to anyone: read
 *  from readySince, after sending noteReady when nobody has noted it yet.
 *  What happened, for the page; `error` is one the tick must see (no lease, a
 *  stuck or unfunded key). */
async function noteReady(ctx: OpsContext, w: Waiting, block: bigint, send: Send, rep: { notes: string[] }): Promise<{ text: string; error: unknown }> {
  const g = ctx.cfg.sharing.graduator;
  const r0 = ctx.readers[0];
  let since: bigint;
  try {
    since = BigInt(await r0.read<bigint>(rescueAbi, g, 'readySince', [w.token as `0x${string}`], block));
  } catch (e) {
    return { text: `Its readySince could not be read (${errorText(e)}), so the keeper did not note it ready: send Graduator.noteReady(${w.token}) to start the rescue's hour.`, error: null };
  }
  if (since === 0n) {
    try {
      const sent = await send('pusher', { to: g, data: encodeFunctionData({ abi: rescueAbi, functionName: 'noteReady', args: [w.token as `0x${string}`] }), label: `noteReady ${w.token}`, distributors: [] });
      if (!sent.receipt.status) throw new Error(`noteReady(${w.token}) reverted on chain (${sent.hash})`);
      since = BigInt(await r0.read<bigint>(rescueAbi, g, 'readySince', [w.token as `0x${string}`], sent.receipt.blockNumber));
      rep.notes.push(`${w.token}: graduate() would revert; noted ready in ${sent.hash}, its fee rescue opens to anyone at ${iso(since + RESCUE_DELAY_SEC)}`);
    } catch (e) {
      if (!(e instanceof WouldRevert)) return { text: `The keeper could not note it ready: ${errorText(e)}. Send Graduator.noteReady(${w.token}) to start the rescue's hour.`, error: e };
      return { text: `Graduator.noteReady(${w.token}) would revert too (${e.errorName ?? e.message}), so the rescue stays its two payees' until the launch can be noted ready.`, error: null };
    }
  }
  return { text: `It was noted ready (Graduator.noteReady) at ${iso(since)}: the rescue is open to anyone from ${iso(since + RESCUE_DELAY_SEC)}.`, error: null };
}

/** The keeper's step: scan when due, alert, and complete what it may. */
export async function graduationWatch(ctx: OpsContext, block: bigint, send: Send | null, rep: { actions: string[]; notes: string[] }): Promise<void> {
  const { cfg } = ctx;
  const lens = cfg.lens;
  if (!lens || /^0x0{40}$/.test(lens)) return;
  const last = ctx.store.get<{ at: number; from: number }>('graduation', { at: 0, from: 0 }).at;
  if (Math.floor(ctx.now() / 1000) - last < cfg.keeper.graduationScanSec) return;
  const stuck = await scanWaiting(ctx, lens, block);
  for (const w of stuck) {
    const data = encodeFunctionData({ abi: graduateAbi, functionName: 'graduate', args: [w.token as `0x${string}`] });
    const calls: ReadyCall[] = [{ what: `complete the graduation of ${w.token} (anyone may send it)`, to: cfg.sharing.graduator, data }];
    const where = `Launch ${w.token} (number ${w.index + 1} in the registry, curve ${w.curve})`;
    const why = 'buying and selling are both closed until graduate() runs. It is permissionless: anyone can send it (the site offers "Complete the move")';
    if (!cfg.keeper.completeGraduations || !send) {
      await ctx.alerts.raise({ key: `waiting:${w.token}`, severity: 'page', title: 'A launch is STUCK in Waiting: its graduation failed', text: `${where} is ready to graduate and has not: ${why}.${cfg.keeper.completeGraduations ? ' This keeper has no pusher key to send it with.' : ' config.keeper.completeGraduations is off, so the keeper does not send it.'}`, calls }, { cooldownSec: cfg.alerts.reminderSec });
      continue;
    }
    try {
      const sent = await send('pusher', { to: cfg.sharing.graduator, data, label: `graduate ${w.token}`, distributors: [] });
      if (!sent.receipt.status) throw new Error(`graduate(${w.token}) reverted on chain (${sent.hash})`);
      rep.notes.push(`${w.token} was stuck in Waiting; graduated in ${sent.hash}`);
      await ctx.alerts.raise({ key: `graduated:${w.token}`, severity: 'warn', title: 'A launch stuck in Waiting was graduated by the keeper', text: `${where} sat ready but ungraduated (an automatic graduation failed); the keeper completed it in ${sent.hash}.` });
    } catch (e) {
      if (!(e instanceof WouldRevert)) {
        // NoLease, a stuck or unfunded key: the tick deals with those; the page still goes out
        await ctx.alerts.raise({ key: `waiting:${w.token}`, severity: 'page', title: 'A launch is STUCK in Waiting: its graduation failed', text: `${where} is ready to graduate and has not: ${why}. The keeper could not send it: ${errorText(e)}.`, calls }, { cooldownSec: cfg.alerts.reminderSec });
        throw e;
      }
      // the hour after which anyone may rescue the curve's fees starts now,
      // not when a person reads this page
      const note = await noteReady(ctx, w, block, send, rep);
      const rescue: ReadyCall = { what: `pay the curve's fees around a blocked escrow (the curve's creator-fee recipient or the platform recipient at once; anyone else an hour after noteReady)`, to: cfg.sharing.graduator, data: encodeFunctionData({ abi: rescueAbi, functionName: 'rescueCurveFees', args: [w.token as `0x${string}`] }) };
      await ctx.alerts.raise({ key: `waiting:${w.token}`, severity: 'page', title: 'A launch is STUCK in Waiting and graduate() would REVERT', text: `${where} is ready to graduate and has not: ${why}. But graduate() would revert (${e.errorName ?? e.message}), so the keeper sent nothing: a person must find out why. An issuer blocking the launch's fee escrow needs Graduator.rescueCurveFees(token) first, which pays the curve's fees around it: the curve's creator-fee recipient and the platform recipient may send it at once, anyone else an hour after Graduator.noteReady(token). ${note.text}`, calls: [...calls, rescue] }, { cooldownSec: cfg.alerts.reminderSec });
      if (note.error) throw note.error;
    }
  }
}
