// Launches stuck in Waiting (gap item 18): the keeper reads every launch's
// state through the lens, pages on each one in Waiting with graduate() ready
// to send, and sends it itself unless told not to - never one that would
// revert; for that one it sends Graduator.noteReady, once, so the hour after
// which anyone may rescue the curve's fees starts without a person. Paged
// through the lens 50 at a time, past the leading Graduated.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, encodeFunctionData } from 'viem';
import { opsWorld, HOLDERS } from './sim/world.ts';
import { tick, js, alertKeys } from './sim/helpers.ts';
import { lensAbi, graduateAbi, rescueAbi } from '../src/ops/graduation.ts';

type W = ReturnType<typeof opsWorld>;
const withLens = (extra: (c: any) => void = () => {}) => opsWorld({ config: (c) => { c.lens = '0x00000000000000000000000000000000000a000c'; extra(c); } });
/** The lens pages the keeper asked for, by their start index. */
const lensReads = (w: W) => w.sim.calls.filter((c) => c.method === 'eth_call' && String(c.params[0]?.to).toLowerCase() === w.sim.addr.lens).map((c) => Number(decodeFunctionData({ abi: lensAbi, data: c.params[0].data }).args![0]));
const statusOf = (w: W, token: string) => w.sim.state.lens.find((l) => l.token === token)!.status;

test('a launch stuck in Waiting is graduated by the keeper, once, and it says so', async () => {
  const w = withLens();
  w.sim.addLensLaunch(3);
  w.sim.addLensLaunch(1);
  const a = w.sim.addLensLaunch(2);
  w.sim.addLensLaunch(1);
  const b = w.sim.addLensLaunch(2);
  const k = w.make('keeper');
  const r = await tick(w, k);
  assert.deepEqual(r.errors, [], js(r));
  assert.equal(statusOf(w, a), 3, 'graduated');
  assert.equal(statusOf(w, b), 3, 'graduated');
  assert.ok(r.actions.some((x) => x.startsWith(`graduate ${a} `)), js(r.actions));
  assert.ok(r.actions.some((x) => x.startsWith(`graduate ${b} `)));
  const sent = [...w.sim.txs.values()].filter((t) => t.to === w.sim.addr.graduator);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].from, w.signers.pusher.address, 'from the pusher key');
  assert.equal(decodeFunctionData({ abi: graduateAbi, data: sent[0].input as `0x${string}` }).args[0].toLowerCase(), a);
  const told = k.ctx.alerts.raised.filter((x) => x.key.startsWith('graduated:'));
  assert.equal(told.length, 2);
  assert.equal(told[0].severity, 'warn', 'fixed already: nobody needs waking');
  assert.ok(!alertKeys(k).some((x) => x.startsWith('waiting:')), 'no page for what the keeper fixed');

  // the next tick inside graduationScanSec does not read the lens again
  const n = lensReads(w).length;
  w.pass(300);
  await tick(w, k);
  assert.equal(lensReads(w).length, n, 'scanned every 10 minutes, not every tick');
  w.pass(301);
  await tick(w, k);
  assert.ok(lensReads(w).length > n, 'and scanned again after them');
  assert.equal([...w.sim.txs.values()].filter((t) => t.to === w.sim.addr.graduator).length, 2, 'nothing sent twice');
});

test('with completeGraduations off it pages with graduate() ready to sign, and sends nothing', async () => {
  const w = withLens((c) => (c.keeper.completeGraduations = false));
  const a = w.sim.addLensLaunch(2);
  const k = w.make('keeper');
  await tick(w, k);
  assert.equal(statusOf(w, a), 2, 'still waiting');
  const p = k.ctx.alerts.raised.find((x) => x.key === `waiting:${a}`)!;
  assert.ok(p, js(alertKeys(k)));
  assert.equal(p.severity, 'page');
  assert.match(p.text, /completeGraduations is off/);
  assert.equal(p.calls![0].to, w.sim.addr.graduator);
  assert.equal(decodeFunctionData({ abi: graduateAbi, data: p.calls![0].data as `0x${string}` }).args[0].toLowerCase(), a);
});

/** What the keeper sent the graduator, by function. */
const toGraduator = (w: W) => [...w.sim.txs.values()].filter((t) => t.to === w.sim.addr.graduator).map((t) => decodeFunctionData({ abi: [...graduateAbi, ...rescueAbi], data: t.input as `0x${string}` }).functionName);

test('a graduate() that would revert is never sent: noteReady is, once, and a page says why and when the rescue opens', async () => {
  const w = withLens();
  const a = w.sim.addLensLaunch(2);
  w.sim.graduateReverts = true;
  const k = w.make('keeper');
  const r = await tick(w, k);
  assert.deepEqual(toGraduator(w), ['noteReady'], 'no graduate() broadcast; the launch noted ready');
  assert.equal(statusOf(w, a), 2, 'still waiting');
  const since = w.sim.state.lens.find((l) => l.token === a)!.readySince;
  assert.ok(since > 0n, 'readySince written on chain');
  assert.ok(r.actions.some((x) => x.startsWith(`noteReady ${a} `)), js(r.actions));
  assert.deepEqual(r.errors, [], 'not a failed tick: a launch a person must look at');
  const opens = new Date(Number(since + 3600n) * 1000).toISOString();
  const p = k.ctx.alerts.raised.find((x) => x.key === `waiting:${a}`)!;
  assert.ok(p, js(alertKeys(k)));
  assert.equal(p.severity, 'page');
  assert.match(p.title, /would REVERT/);
  assert.match(p.text, /rescueCurveFees/);
  assert.match(p.text, /platform recipient may send it at once, anyone else an hour after Graduator.noteReady/);
  assert.ok(p.text.includes(`open to anyone from ${opens}`), p.text);
  assert.equal(decodeFunctionData({ abi: rescueAbi, data: p.calls![1].data as `0x${string}` }).functionName, 'rescueCurveFees', 'the rescue is ready to sign');

  // the next scan reads readySince and sends nothing more: the hour is not moved
  w.pass(601);
  const r2 = await tick(w, k);
  assert.deepEqual(toGraduator(w), ['noteReady'], js(r2.actions));
  assert.equal(w.sim.state.lens.find((l) => l.token === a)!.readySince, since);
  const p2 = k.ctx.alerts.raised.filter((x) => x.key === `waiting:${a}`).at(-1)!;
  assert.ok(p2.text.includes(`open to anyone from ${opens}`), p2.text);
});

test('a launch noted ready by someone else is not noted again; with completeGraduations off nothing is sent at all', async () => {
  const w = withLens();
  const a = w.sim.addLensLaunch(2);
  w.sim.graduateReverts = true;
  assert.ok(w.sim.userTx(HOLDERS.carol, w.sim.addr.graduator, encodeFunctionData({ abi: rescueAbi, functionName: 'noteReady', args: [a as `0x${string}`] })).ok);
  const since = w.sim.state.lens.find((l) => l.token === a)!.readySince;
  const n = toGraduator(w).length;
  const k = w.make('keeper');
  await tick(w, k);
  assert.equal(toGraduator(w).length, n, 'already noted: nothing sent');
  const p = k.ctx.alerts.raised.find((x) => x.key === `waiting:${a}`)!;
  assert.ok(p.text.includes(`noted ready (Graduator.noteReady) at ${new Date(Number(since) * 1000).toISOString()}`), p.text);

  const off = withLens((c) => (c.keeper.completeGraduations = false));
  off.sim.addLensLaunch(2);
  off.sim.graduateReverts = true;
  await tick(off, off.make('keeper'));
  assert.deepEqual(toGraduator(off), [], 'told not to send: no graduate(), no noteReady');
});

test('the lens is paged 50 at a time, and later scans start past the leading Graduated launches', async () => {
  const w = withLens();
  for (let i = 0; i < 60; i++) w.sim.addLensLaunch(3);
  for (let i = 0; i < 49; i++) w.sim.addLensLaunch(1);
  const late = w.sim.addLensLaunch(2); // index 109
  for (let i = 0; i < 10; i++) w.sim.addLensLaunch(1);
  const k = w.make('keeper');
  const r = await tick(w, k);
  assert.deepEqual(lensReads(w), [0, 50, 100], 'three pages for 120 launches');
  assert.equal(statusOf(w, late), 3, 'found on the third page');
  assert.ok(r.actions.some((x) => x.startsWith(`graduate ${late} `)));
  w.pass(601);
  await tick(w, k);
  assert.deepEqual(lensReads(w).slice(3), [60, 110], 'the next scan starts at the first launch that is not Graduated');
  // launch 109 is Graduated now, but launches 60-108 are not: the start stays
  w.pass(601);
  await tick(w, k);
  assert.deepEqual(lensReads(w).slice(5), [60, 110], 'a Graduated launch behind a Selling one moves nothing');
});

test('no lens configured: nothing is read', async () => {
  const w = opsWorld();
  w.sim.addLensLaunch(2);
  const k = w.make('keeper');
  await tick(w, k);
  assert.deepEqual(lensReads(w), []);
});

test('a keeper without a usable pusher only pages', async () => {
  const w = withLens();
  const a = w.sim.addLensLaunch(2);
  w.sim.state.eth.set(w.signers.pusher.address, 0n);
  w.sim.snaps.set(w.sim.latest, structuredClone(w.sim.state));
  const k = w.make('keeper');
  await tick(w, k);
  assert.equal(statusOf(w, a), 2);
  const p = k.ctx.alerts.raised.find((x) => x.key === `waiting:${a}`);
  assert.ok(p && p.severity === 'page', js(alertKeys(k)));
});
