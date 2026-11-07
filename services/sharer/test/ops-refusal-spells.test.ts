// A refusal spell (a 429, "rate limit") is waited out on EVERY read of the
// hosts, as on eth_getLogs: a header, an eth_call, a receipt are asked again
// after 0.5 s, then doubling, 7 tries and 63.5 s in all (runner.ts). Before,
// they gave up after 7.5 s, and a check reads headers 16 at once against a
// free endpoint's ~10 a second, so one spell made an honest root
// unverifiable. A check past its deadline still stops at its next read: the
// request after the pause is withdrawn (RequestStopped), never asked again.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData } from 'viem';
import { ChainReader, stoppable } from '../src/chain/reader.ts';
import { RequestStopped } from '../src/chain/logs.ts';
import { RpcError, type Rpc } from '../src/chain/rpc.ts';
import { TOPICS } from '../src/chain/abis.ts';
import { opsDistributorAbi, opsFactoryAbi } from '../src/ops/abis.ts';
import { watchTick } from '../src/ops/verify.ts';
import { opsWorld } from './sim/world.ts';
import { tick, js } from './sim/helpers.ts';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const refusal = () => new RpcError('You reached Public endpoint rate limit, please upgrade to paid plan', { status: 429, code: 15 });

test('every read waits out a refusal spell - a header, an eth_call, a receipt: 7 tries, 63.5 s; a longer one fails; --getlogs-tries sets it', async () => {
  const w = opsWorld();
  const L = w.launches[0];
  const harvest = w.sim.userTx('0x00000000000000000000000000000000000beef9', L.D, encodeFunctionData({ abi: opsDistributorAbi, functionName: 'harvest' }));
  assert.ok(harvest.ok);
  const spell = { left: 0 };
  const b: Rpc = {
    label: 'b',
    request: async (a) => {
      if (a.method !== 'eth_chainId' && spell.left > 0) {
        spell.left--;
        throw refusal();
      }
      return w.sim.rpc('b').request(a);
    },
  };
  const g = w.make('guardian', { rpcs: [w.sim.rpc('a'), b] });
  const r = g.ctx.readers[1];
  assert.equal(r.opts.tries, 7, "the reader's own tries, as eth_getLogs has");
  const slept: number[] = [];
  r.opts.sleep = async (ms) => void slept.push(ms);
  const reads: [string, () => Promise<unknown>][] = [
    ['a header', () => r.block(w.sim.latest - 1n)],
    ['an eth_call', () => r.read(opsFactoryAbi, w.sim.addr.factory, 'frozen', [], w.sim.latest)],
    ['a receipt', () => r.receipt(harvest.hash)],
  ];
  for (const [what, read] of reads) {
    slept.length = 0;
    spell.left = 6;
    await read();
    assert.deepEqual(slept, [500, 1000, 2000, 4000, 8000, 16000], `${what}: six refusals in a row, 31.5 s, waited out`);
  }
  slept.length = 0;
  spell.left = 8;
  await assert.rejects(r.block(w.sim.latest - 2n), /rate limit/);
  assert.equal(slept.length, 7, 'eight refusals: the read fails after its seventh pause (63.5 s)');
  assert.equal(w.make('guardian', { logTries: 9 }).ctx.readers[0].opts.tries, 9, '--getlogs-tries sets every read');
});

test('a refusal spell inside a check is waited out: the probe and the receipts refused six times each, and the root is ok', async () => {
  const w = opsWorld();
  const k = w.make('keeper');
  w.pass(3601);
  assert.equal((await tick(w, k)).published.length, 1);
  // provider b refuses in a spell from the recompute's replay on: each kind
  // of read six times in a row
  const left = new Map<string, number>();
  const refused: string[] = [];
  const b: Rpc = {
    label: 'b',
    request: async (a) => {
      const p = (a.params ?? []) as any[];
      if (a.method === 'eth_getLogs' && [p[0]?.topics?.[0]].flat().includes(TOPICS.Transfer)) for (const x of ['header', 'probe', 'receipt']) left.set(x, 6);
      const kind = a.method === 'eth_getBlockByNumber' && /^0x/.test(String(p[0])) ? 'header' : a.method === 'eth_call' && p[0]?.to == null ? 'probe' : a.method === 'eth_getTransactionReceipt' ? 'receipt' : null;
      if (kind && (left.get(kind) ?? 0) > 0) {
        left.set(kind, left.get(kind)! - 1);
        refused.push(kind);
        throw refusal();
      }
      return w.sim.rpc('b').request(a);
    },
  };
  const g = w.make('guardian', { rpcs: [w.sim.rpc('a'), b] });
  for (const r of g.ctx.readers) {
    r.opts.sleep = async () => {};
    r.logWindow.opts.sleep = async () => {};
  }
  const rep = await watchTick(g.ctx, g.keys.guardian);
  assert.deepEqual(rep.results.map((r) => [r.verdict, r.problems]), [['ok', []]], js(rep.results));
  assert.equal(refused.filter((x) => x === 'probe').length, 6, js(refused));
  assert.equal(refused.filter((x) => x === 'receipt').length, 6, js(refused));
});

test('a read past its deadline stops at its next request: a header or an eth_call refused "busy" is not waited out', async () => {
  for (const [what, read] of [
    ['a header', (r: ChainReader) => r.block(5n)],
    ['an eth_call', (r: ChainReader) => r.rawCall('0x00000000000000000000000000000000000a0003', '0x', 5n)],
  ] as const) {
    const ctl = new AbortController();
    const slept: number[] = [];
    const busy: Rpc = { label: 'b', request: async () => { throw refusal(); } };
    const r = new ChainReader(busy, {
      tries: 7,
      sleep: async (ms) => {
        slept.push(ms);
        if (slept.length === 2) ctl.abort(new Error('the deadline passed'));
      },
    });
    await assert.rejects(read(stoppable(r, ctl.signal)), (e: any) => e instanceof RequestStopped && /the deadline passed/.test(e.message), what);
    assert.deepEqual(slept, [500, 1000], `${what}: stopped at its next request, not after the 63.5 s backoff`);
  }
});

test('a check in a refusal spell past its deadline stops instead of waiting the spell out, and is checked again on the next pass', { timeout: 60_000 }, async () => {
  const w = opsWorld({ config: (c) => Object.assign(c.guardian, { checkTimeoutSec: 1, passTimeoutSec: 2 }) });
  const k = w.make('keeper');
  w.pass(3601);
  assert.equal((await tick(w, k)).published.length, 1);
  // from the recompute's replay on, provider b refuses every probe
  let armed = false;
  let over = false;
  let refused = 0;
  let afterTheDeadline = 0;
  const b: Rpc = {
    label: 'b',
    request: async (a) => {
      const p = (a.params ?? []) as any[];
      if (a.method === 'eth_getLogs' && [p[0]?.topics?.[0]].flat().includes(TOPICS.Transfer)) armed = true;
      if (armed && a.method === 'eth_call' && p[0]?.to == null) {
        refused++;
        if (over) afterTheDeadline++;
        throw refusal();
      }
      return w.sim.rpc('b').request(a);
    },
  };
  // the readers keep their real pauses: 0.5 s, 1 s, 2 s, ...
  const g = w.make('guardian', { rpcs: [w.sim.rpc('a'), b] });
  const r1 = await watchTick(g.ctx, g.keys.guardian);
  over = true;
  assert.equal(r1.results[0]?.verdict, 'unverifiable', js(r1.results));
  assert.match(r1.results[0].problems[0], /not checked within 1 s/);
  assert.ok(refused >= 1, 'the spell met the check');
  await wait(2500);
  assert.equal(afterTheDeadline, 0, 'the pause ended after the deadline and its request was withdrawn, not sent');
  const r2 = await watchTick(g.ctx, g.keys.guardian);
  assert.doesNotMatch(r2.results[0]?.problems[0] ?? '', /still running/, `the abandoned check had ended: ${js(r2.results)}`);
});
