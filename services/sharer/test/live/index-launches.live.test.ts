// Against Base itself, read-only: the launches file for agents
// (scripts/index-launches.ts) decodes the real lens's launchPage, reads the real
// registry's tax word and the real tokens' names, and finds $CURB as it is,
// with the counts of the live stats.json (one GET through the site's rewrite)
// and the block they were counted at. A few eth_calls on a public endpoint;
// nothing is written but to memory.
//
//   SHARER_LIVE_RPC=https://mainnet.base.org node --test test/live/index-launches.live.test.ts
//
// Skipped when SHARER_LIVE_RPC is not set.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { httpRpc } from '../../src/chain/rpc.ts';
import { indexLaunches, launchesPath, LAUNCHES_SCHEMA, type LaunchesFile } from '../../scripts/index-launches.ts';
import { statsPath } from '../../scripts/index-history.ts';
import { ROOT } from '../helpers.ts';

const RPC = process.env.SHARER_LIVE_RPC;
const CURB = '0xf8bdcd06f7a5939c8b2340e27419facdf16a407e';
const WETH = '0x4200000000000000000000000000000000000006';

test('live: $CURB is in launches.json as the chain has it - selling or later, on WETH, threshold 4.47, tax 1%, Curb / CURB', { skip: !RPC && 'SHARER_LIVE_RPC is not set' }, async () => {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'deploy', 'sharer.json'), 'utf8'));
  const files: Record<string, Uint8Array> = {};
  const statsRes = await fetch(cfg.site.base.replace(/\/+$/, '') + '/' + statsPath(8453));
  assert.equal(statsRes.status, 200, 'the live stats.json');
  const statsBytes = new Uint8Array(await statsRes.arrayBuffer());
  const r = await indexLaunches({
    rpc: httpRpc(RPC!, { label: 'live' }), chainId: 8453, registry: cfg.registry, lens: cfg.lens, siteBase: cfg.site.base,
    hiddenLaunches: [], hiddenFactories: [],
    read: async (p) => (p === statsPath(8453) ? statsBytes : null), write: async (p, b) => { files[p] = b; }, log: (l) => console.log(l),
  });
  assert.equal(r.failed, 0);
  assert.equal(r.written, true);
  const f: LaunchesFile = JSON.parse(Buffer.from(files[launchesPath(8453)]).toString('utf8'));
  assert.equal(f.schema, LAUNCHES_SCHEMA);
  assert.ok(f.count >= 1);
  const e = f.launches.find((x) => x.token === CURB);
  assert.ok(e, '$CURB is not in the file');
  assert.ok(['selling', 'waiting', 'graduated'].includes(e!.status));
  assert.equal(e!.quote.token, WETH);
  assert.equal(e!.quote.symbol, 'WETH');
  assert.equal(e!.quote.decimals, 18);
  assert.equal(e!.progress.threshold, '4470000000000000000');
  assert.equal(e!.taxBps, 100);
  assert.equal(e!.name, 'Curb');
  assert.equal(e!.symbol, 'CURB');
  assert.equal(e!.textCleaned, false);
  assert.equal(e!.page, 'https://curbfun.xyz/token/' + CURB);
  // THE COUNTS, AND THEIR OWN BLOCK: stats.json's, at or before the lens's.
  const stats = JSON.parse(Buffer.from(statsBytes).toString('utf8'));
  assert.deepEqual(f.statsAsOf, stats.generatedAt);
  assert.ok(f.statsAsOf!.block <= f.asOf.block, 'the counts are from a later block than the lens fields');
  assert.ok(e!.activity, '$CURB has no activity');
  assert.equal(e!.activity!.curveBuys, stats.launches[CURB].curveBuys);
  console.log(JSON.stringify({ asOf: f.asOf, statsAsOf: f.statsAsOf }), JSON.stringify(e));
});
