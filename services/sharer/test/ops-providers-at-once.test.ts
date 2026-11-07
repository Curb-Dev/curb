// A check reads its two providers AT ONCE (chain/reader.ts onEveryProvider):
// it takes the slower provider's time, not the sum of both. Read one after
// the other, a busy launch's hour-long epoch took about 70 s of the free
// pair's 120-s check, and a day's epoch could never fit. The answers are
// still compared in reader order, a disagreement still aborts, and:
//
//   - provider b is read while provider a waits for it (one after the
//     other, this deadlocks);
//   - a check whose providers take 0.9 and 1.3 s finishes within a 2-s
//     deadline (one after the other it is 2.2 s, and unverifiable);
//   - a provider that fails stops the other at its next request, and the
//     error thrown is the failing provider's own, never the other's being
//     stopped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChainReader } from '../src/chain/reader.ts';
import { TOPICS } from '../src/chain/abis.ts';
import type { Rpc } from '../src/chain/rpc.ts';
import { prepareEpoch } from '../src/epoch.ts';
import { bytesEqual, vectorFilePath, type EpochResult } from '../src/calc/index.ts';
import { watchTick } from '../src/ops/verify.ts';
import { loadVector, readVectorFile } from './helpers.ts';
import { vectorWorld, type World } from './world.ts';
import { opsWorld } from './sim/world.ts';
import { tick, js } from './sim/helpers.ts';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const reader = (rpc: Rpc) => new ChainReader(rpc, { tries: 0, logWindow: { tries: 0 } });
const req = (w: World) => ({ distributor: w.D, harvestTx: w.attempts[0].harvestTx, uri: w.attempts[0].uri, prev: null, opening: w.opening, distributors: [w.D] });

test('the providers are read at once: provider b is read while provider a waits for it', async () => {
  const w = vectorWorld(loadVector('v01-mid-epoch-transfers'));
  let bRead!: () => void;
  const seen = new Promise<void>((r) => (bRead = r));
  const a: Rpc = { label: 'a', request: async (x) => (await seen, w.chain.rpc('a').request(x)) };
  const b: Rpc = { label: 'b', request: async (x) => (bRead(), w.chain.rpc('b').request(x)) };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stuck = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('provider b was not read while provider a waited: one after the other')), 5000)));
  try {
    const { result } = await Promise.race([prepareEpoch([reader(a), reader(b)], w.config, req(w), { stateCache: null }), stuck]);
    assert.equal(result.result, 'epoch');
    // the same epoch as ever: the golden file
    assert.ok(bytesEqual((result as EpochResult).fileBytes, readVectorFile(vectorFilePath('v01-mid-epoch-transfers', 1n))!));
  } finally {
    clearTimeout(timer);
  }
});

test('a provider that fails stops the other at its next request, and its own error is the one thrown', async () => {
  const w = vectorWorld(loadVector('v01-mid-epoch-transfers'));
  const events: string[] = [];
  const failing = (label: string): Rpc => ({
    label,
    request: async (x) => {
      events.push(`${label} ${x.method}`);
      if (x.method === 'eth_getLogs') {
        events.push(`${label} FAILED`);
        throw new Error(`provider ${label}: broken`);
      }
      return w.chain.rpc(label).request(x);
    },
  });
  const slow = (label: string): Rpc => ({
    label,
    request: async (x) => {
      events.push(`${label} ${x.method}`);
      await wait(5);
      return w.chain.rpc(label).request(x);
    },
  });
  const askedAfter = (failed: string, other: string) => events.slice(events.indexOf(`${failed} FAILED`) + 1).filter((e) => e.startsWith(`${other} `));

  // provider a fails: b, still reading, is stopped
  await assert.rejects(prepareEpoch([reader(failing('a')), reader(slow('b'))], w.config, req(w), { stateCache: null }), /provider a: broken$/);
  assert.ok(events.includes('a FAILED'));
  assert.deepEqual(askedAfter('a', 'b'), [], `provider b asked nothing more once a had failed: ${js(events)}`);

  // provider b fails while a is still reading: b's error, not a's being stopped
  events.length = 0;
  await assert.rejects(prepareEpoch([reader(slow('a')), reader(failing('b'))], w.config, req(w), { stateCache: null }), (e: any) => {
    assert.match(String(e?.message), /^provider b: .*provider b: broken$/, `the error thrown: ${String(e)}`);
    return true;
  });
  assert.deepEqual(askedAfter('b', 'a'), [], `provider a asked nothing more once b had failed: ${js(events)}`);
});

test('a check whose providers take 0.9 and 1.3 s finishes within a 2-s deadline: they are read at once', { timeout: 60_000 }, async () => {
  const w = opsWorld({ config: (c) => Object.assign(c.guardian, { checkTimeoutSec: 2, passTimeoutSec: 2 }) });
  const k = w.make('keeper');
  w.pass(3601);
  assert.equal((await tick(w, k)).published.length, 1);
  // the recompute's replay of the token's transfers is the slow read
  const slow = (label: string, ms: number): Rpc => ({
    label,
    async request(a) {
      const p = (a.params ?? []) as any[];
      if (a.method === 'eth_getLogs' && [p[0]?.topics?.[0]].flat().includes(TOPICS.Transfer)) await wait(ms);
      return w.sim.rpc(label).request(a);
    },
  });
  const g = w.make('guardian', { rpcs: [slow('a', 900), slow('b', 1300)] });
  const t0 = performance.now();
  const rep = await watchTick(g.ctx, g.keys.guardian);
  assert.deepEqual(rep.results.map((r) => [r.verdict, r.problems]), [['ok', []]], `${Math.round(performance.now() - t0)} ms: ${js(rep.results)}`);
});
