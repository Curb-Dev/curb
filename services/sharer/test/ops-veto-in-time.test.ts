// A veto the guardian owes must land inside its root's hour:
//
//   - a pending root's check ends guardian.vetoLandingSec before the root
//     can become payable, at the latest. With guardian.checkTimeoutSec 300,
//     a root sent with a stolen key and first met late in its hour (a
//     guardian that restarted) could hold its check past the hour with
//     copies that never finish arriving: decided too late to veto, and
//     never "unreached", so not frozen either. Cut short, it is vetoed by
//     the late rule. A root past its hour is still checked in full;
//   - a root whose RootPublished cannot be read (a provider fails on it) is
//     unverifiable, never left with no verdict: the late rule and the
//     grace apply to it;
//   - a signed veto goes to every provider at once, each asked at most
//     twice: a provider that refuses it never holds it back from another.
//
// The first test runs on a scaled clock (about 1:40): the chain's clock
// moves one second a second while the pass runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, keccak256, toHex } from 'viem';
import { TOPICS } from '../src/chain/abis.ts';
import { RpcError, type Rpc } from '../src/chain/rpc.ts';
import { opsDistributorAbi, opsFactoryAbi } from '../src/ops/abis.ts';
import { fileCid } from '../src/ops/cid.ts';
import { watchTick } from '../src/ops/verify.ts';
import { opsWorld } from './sim/world.ts';
import { alertKeys, js, tick } from './sim/helpers.ts';

type W = ReturnType<typeof opsWorld>;
const THIEF = '0x00000000000000000000000000000000000bad01';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const refusal = () => new RpcError('You reached Public endpoint rate limit, please upgrade to paid plan', { status: 429, code: 15 });
/** A body that starts and never finishes arriving. */
const stalled = () => new Response(new ReadableStream({ pull: () => new Promise<void>(() => {}) }) as BodyInit, { status: 200 });
const head = (w: W): bigint => (w.sim as any).headers.get(w.sim.latest)!.timestamp as bigint;

/** A root published with the publisher key (a stolen one) whose file exists nowhere. */
function stolen(w: W, tag: string): { L: W['launches'][number]; site: string } {
  const L = w.launches[0];
  assert.ok(w.sim.userTx(THIEF, L.D, encodeFunctionData({ abi: opsDistributorAbi, functionName: 'harvest' })).ok, 'harvest');
  const s = w.sim.launch(L.D);
  const uri = `ipfs://${fileCid(new TextEncoder().encode(`no such file: ${tag}`))}`;
  const root = { merkleRoot: keccak256(toHex(`root ${tag}`)), contentHash: keccak256(toHex(`content ${tag}`)), cumHolders0: s.active.cumHolders0 + 1n, cumHolders1: s.active.cumHolders1, cumKeeper0: s.active.cumKeeper0, fromBlock: s.active.epoch === 0 ? L.sharingSince : s.active.toBlock + 1n, toBlock: w.sim.latest, epoch: s.lastProposed + 1, payableAt: 0 };
  assert.ok(w.sim.userTx(w.signers.publisher.address, w.sim.addr.factory, encodeFunctionData({ abi: opsFactoryAbi, functionName: 'publishMany', args: [[L.D as `0x${string}`], [root as any], [uri]] as any })).ok, 'publish');
  return { L, site: `https://site.test/sharing/8453/${L.D}/${root.epoch}.json` };
}

test('a stolen-key root first met late in its hour, with copies that never finish, is vetoed: its check ends guardian.vetoLandingSec before the hour does', { timeout: 60_000 }, async () => {
  // scaled: checkTimeoutSec 300 -> 8 s, vetoLandingSec 90 -> 3 s, the late
  // window 900 -> 20 s; the root has 7 s (about 280 s) left when the pass starts
  const w = opsWorld({ config: (c) => Object.assign(c.guardian, { checkTimeoutSec: 8, passTimeoutSec: 8, vetoUnverifiedBeforeSec: 20, vetoUnverifiedAfterSec: 15, vetoLandingSec: 3 }) });
  const { L, site } = stolen(w, 'late');
  const P = w.sim.launch(L.D).pending;
  w.sim.blockTime = 1n;
  w.chainPass(Number(BigInt(P.payableAt) - head(w)) - 8);
  const net = w.net as any;
  const plain = net.fetch;
  net.fetch = (async (u: any, init: any) => (String(u) === site || String(u).startsWith('https://gw.test/') ? stalled() : plain(u, init))) as typeof fetch;
  const g = w.make('guardian');
  net.fetch = plain;
  const left0 = Number(BigInt(P.payableAt) - head(w));
  assert.ok(left0 >= 6 && left0 <= 8, `${left0} s left at the start`);
  // the chain's clock runs one second a second while the pass runs
  const clock = setInterval(() => w.sim.mine(), 1000);
  let rep;
  try {
    rep = await watchTick(g.ctx, g.keys.guardian);
  } finally {
    clearInterval(clock);
  }
  const said = { left0, results: rep.results.map((r) => [r.verdict, r.problems[0]]), vetoed: rep.vetoed.length, froze: rep.froze, alerts: alertKeys(g) };
  assert.equal(rep.vetoed.length, 1, `vetoed in time: ${js(said)}`);
  assert.equal(w.sim.launch(L.D).pending.payableAt, 0n, 'no longer pending');
  assert.equal(w.sim.launch(L.D).active.epoch, 0, 'and never active');
  assert.equal(rep.results.length, 1, js(said));
  assert.equal(rep.results[0].verdict, 'unverifiable', js(said));
  assert.match(rep.results[0].problems[0], /not checked within \d+ s \(guardian\.vetoLandingSec before its hour ends/, js(said));
  assert.ok(alertKeys(g).includes(`unverified:${L.D}:${P.epoch}:late`), js(said));
});

test('a pending root past its hour is checked in full, not cut short: an honest one still verifies', { timeout: 60_000 }, async () => {
  const w = opsWorld({ config: (c) => Object.assign(c.guardian, { checkTimeoutSec: 5, passTimeoutSec: 5 }) });
  const k = w.make('keeper');
  w.pass(3601);
  assert.equal((await tick(w, k)).published.length, 1);
  const L = w.launches[0];
  const P = w.sim.launch(L.D).pending;
  w.chainPass(3601); // payable, and nobody has activated it
  assert.ok(head(w) > BigInt(P.payableAt));
  assert.notEqual(w.sim.launch(L.D).pending.payableAt, 0n, 'still pending');
  // a recompute that takes 1.5 s: more than the 1 s a cut-short check gets
  const slow = (label: string): Rpc => ({
    label,
    async request(a) {
      const p = (a.params ?? []) as any[];
      if (a.method === 'eth_getLogs' && [p[0]?.topics?.[0]].flat().includes(TOPICS.Transfer)) await wait(1500);
      return w.sim.rpc(label).request(a);
    },
  });
  const g = w.make('guardian', { rpcs: [slow('a'), slow('b')] });
  const rep = await watchTick(g.ctx, g.keys.guardian);
  assert.deepEqual(rep.results.map((r) => [r.verdict, r.problems]), [['ok', []]], js(rep.results));
  assert.equal(rep.vetoed.length, 0);
});

test('a root whose RootPublished cannot be read on one provider is unverifiable, never left with no verdict: late in its hour it is vetoed', async () => {
  const w = opsWorld();
  const { L } = stolen(w, 'event');
  const P = w.sim.launch(L.D).pending;
  w.pass(3600 - 600); // 600 s left: in the late window
  const b: Rpc = {
    label: 'b',
    request: async (a) => {
      const p = (a.params ?? []) as any[];
      if (a.method === 'eth_getLogs' && String(p[0]?.address).toLowerCase() === L.D && [p[0]?.topics?.[0]].flat().includes(TOPICS.RootPublished)) throw new RpcError('backend returned an unexpected answer', { status: 400, code: -32000 });
      return w.sim.rpc('b').request(a);
    },
  };
  const g = w.make('guardian', { rpcs: [w.sim.rpc('a'), b], logTries: 0 });
  const rep = await watchTick(g.ctx, g.keys.guardian);
  const said = js({ results: rep.results, vetoed: rep.vetoed, errors: rep.errors, alerts: alertKeys(g) });
  assert.equal(rep.results.length, 1, said);
  assert.equal(rep.results[0].verdict, 'unverifiable', said);
  assert.match(rep.results[0].problems[0], /its RootPublished could not be read on this host's providers: .*backend returned an unexpected answer/, said);
  assert.ok(alertKeys(g).includes(`event-unseen:${L.D}:${P.epoch}`), said);
  assert.equal(rep.vetoed.length, 1, said);
  assert.equal(w.sim.launch(L.D).pending.payableAt, 0n, 'vetoed');
});

test('a check abandoned at its deadline during its event lookup raises no alert about the event', { timeout: 60_000 }, async () => {
  const w = opsWorld({ config: (c) => Object.assign(c.guardian, { checkTimeoutSec: 1, passTimeoutSec: 2 }) });
  const { L } = stolen(w, 'stuck');
  w.pass(60);
  // provider b's RootPublished lookup hangs until it is withdrawn
  const b: Rpc = {
    label: 'b',
    request: async (a) => {
      const p = (a.params ?? []) as any[];
      if (a.method === 'eth_getLogs' && String(p[0]?.address).toLowerCase() === L.D && [p[0]?.topics?.[0]].flat().includes(TOPICS.RootPublished)) await new Promise(() => {});
      return w.sim.rpc('b').request(a);
    },
  };
  const g = w.make('guardian', { rpcs: [w.sim.rpc('a'), b], logTries: 0 });
  const rep = await watchTick(g.ctx, g.keys.guardian);
  assert.match(rep.results[0]?.problems[0] ?? '', /not checked within 1 s \(guardian\.checkTimeoutSec\)/, js(rep.results));
  await wait(200); // the abandoned check has stopped by now
  assert.deepEqual(alertKeys(g).filter((k) => k.startsWith('event-unseen:')), [], js(g.ctx.alerts.raised.map((a) => a.text)));
});

test('a veto goes to every provider at once: provider a refusing it holds nothing back from b, and is asked at most twice', async () => {
  const w = opsWorld();
  const k = w.make('keeper');
  w.pass(3601);
  assert.equal((await tick(w, k)).published.length, 1);
  const L = w.launches[0];
  const P = w.sim.launch(L.D).pending;
  // the readers' pauses move this clock: when each provider was asked, in ms
  let clock = 0;
  const seen: string[] = [];
  const a: Rpc = {
    label: 'a',
    request: async (x) => {
      if (x.method === 'eth_sendRawTransaction') {
        seen.push(`a refused it at ${clock}`);
        throw refusal();
      }
      return w.sim.rpc('a').request(x);
    },
  };
  const b: Rpc = {
    label: 'b',
    request: async (x) => {
      if (x.method === 'eth_sendRawTransaction') seen.push(`b was given it at ${clock}`);
      return w.sim.rpc('b').request(x);
    },
  };
  const g = w.make('guardian', { rpcs: [a, b] });
  assert.equal(g.ctx.readers[0].opts.tries, 7, 'the reads still wait out a spell');
  for (const r of g.ctx.readers) r.opts.sleep = async (ms) => void (clock += ms);
  const data = encodeFunctionData({ abi: opsFactoryAbi, functionName: 'veto', args: [L.D as `0x${string}`, Number(P.epoch), `0x${'00'.repeat(32)}`] });
  const sent = await g.keys.guardian!.send({ to: w.sim.addr.factory, data, label: 'veto', distributors: [L.D] });
  assert.ok(sent.receipt.status);
  assert.equal(w.sim.launch(L.D).pending.payableAt, 0n, 'vetoed');
  // one after the other, with the reads' 7 tries, b was given it after 63.5 s
  assert.deepEqual(seen, ['a refused it at 0', 'b was given it at 0', 'a refused it at 500']);
});
