// The launch page's search for a launch's creation block (web/token.js
// firstBlockAt, creationNear, historyStart), run on their own - the functions
// as the file has them, not copies - against a chain shaped like Base: a block
// every 2 s until 5 November 2026 (block 53,556,127), five to each second
// since. (The page around them is covered by web/e2e/token.spec.js.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { ROOT } from './helpers.ts';

const SRC = readFileSync(join(ROOT, '..', '..', 'web', 'token.js'), 'utf8');

/** One top-level function of token.js, by name, as its text. */
function fnText(name: string): string {
  const at = SRC.search(new RegExp(`^(async )?function ${name}\\(`, 'm'));
  assert.ok(at >= 0, `token.js has a function ${name}`);
  const end = SRC.indexOf('\n}\n', at);
  return SRC.slice(at, end + 2);
}

const FACTORY = '0x' + 'fa'.repeat(20);
const TOKEN = '0x' + '70'.repeat(20);
const LAUNCH_CREATED = '0x' + 'lc'.padStart(64, '0');

/** The first fast block, and each block's stamp: 2 s apart before it, five to a second from it. */
const SWITCH = 53_556_127;
const GENESIS = 1_686_789_347;
const baseTs = (n: number) => (n < SWITCH ? GENESIS + 2 * n : GENESIS + 2 * (SWITCH - 1) + 2 + Math.floor((n - SWITCH) / 5));

/** token.js's functions in a sandbox, over a chain whose stamps `ts` gives,
 *  whose factory logged this token's LaunchCreated in `launch`, and whose
 *  endpoint takes at most `cap` blocks of logs at once and refuses a header
 *  below `archiveBelow`, as publicnode refuses Base's old blocks. */
function page(o: { ts: (n: number) => number; launch: number; cap?: number; knownCap?: number; archiveBelow?: number }) {
  const asked = { headers: 0, logs: 0 };
  const box: any = {
    T: { token: TOKEN },
    TOPIC: { launchCreated: LAUNCH_CREATED },
    LOG_TRIES: 4,
    LOG_BACKOFF_MS: 0,
    sleep: async () => {},
    hex: (n: number) => '0x' + BigInt(n).toString(16),
    pad: (a: string) => String(a).toLowerCase().replace(/^0x/, '').padStart(64, '0'),
    logKind: (e: any) => (e && e.busy ? 'busy' : 'range'),
    withinCap: (most: number) => (o.knownCap ? Math.min(most, o.knownCap) : most),
    rpc: async (method: string, params: any[]) => {
      if (method === 'eth_getBlockByNumber') {
        asked.headers++;
        const n = Number(BigInt(params[0]));
        if (n < (o.archiveBelow ?? 0)) throw new Error('Archive requests require a personal token');
        return { number: params[0], timestamp: '0x' + o.ts(n).toString(16) };
      }
      if (method === 'eth_getLogs') {
        asked.logs++;
        const f = params[0];
        const from = Number(BigInt(f.fromBlock)), to = Number(BigInt(f.toBlock));
        if (to - from + 1 > (o.cap ?? 1000)) throw new Error(`maximum ${o.cap ?? 1000} blocks`);
        const hit = f.address === FACTORY && f.topics[0] === LAUNCH_CREATED && f.topics[1] === '0x' + box.pad(TOKEN) && o.launch >= from && o.launch <= to;
        return hit ? [{ blockNumber: '0x' + o.launch.toString(16) }] : [];
      }
      throw new Error('unexpected ' + method);
    },
  };
  vm.createContext(box);
  for (const f of ['firstBlockAt', 'creationNear', 'historyStart']) vm.runInContext(fnText(f), box, { filename: 'token.js#' + f });
  return { box, asked };
}

test('token page: firstBlockAt finds the first block stamped a time or later, against every block, in a bounded number of reads', async () => {
  const { box } = page({ ts: baseTs, launch: 0 });
  // CHAINS OF A THOUSAND BLOCKS: steady, five to a second, a pace that
  // changes, long runs of one stamp, and a pace that changes by a thousand
  // times at the last block, where a steady pace is the wrong guess every time.
  const N = 1000;
  const chains: [string, (n: number) => number][] = [
    ['2 s', (n) => 100 + 2 * n],
    ['five a second', (n) => 100 + Math.floor(n / 5)],
    ['2 s then five a second', (n) => (n < 600 ? 100 + 2 * n : 1300 + Math.floor((n - 600) / 5))],
    ['runs of fifty', (n) => 100 + Math.floor(n / 50)],
    ['a leap at the end', (n) => (n < N - 1 ? n : 1_000_000)],
  ];
  const bound = 2 * Math.ceil(Math.log2(N)) + 2;
  for (const [name, ts] of chains) {
    const times = new Set<number>([ts(N - 1), ts(N - 1) + 1]);
    for (let n = 0; n < N; n += 7) for (const d of [-1, 0, 1]) times.add(ts(n) + d);
    for (const at of times) {
      let reads = 0;
      const tsOf = async (n: number) => { reads++; return ts(n); };
      const got = await box.firstBlockAt(at, 0, ts(0), N - 1, ts(N - 1), tsOf);
      let want: number | null = null;
      for (let n = 0; n < N; n++) if (ts(n) >= at) { want = n; break; }
      assert.equal(got, want, `${name}: the first block at ${at}`);
      assert.ok(reads <= bound, `${name}: ${reads} reads for ${at}, more than ${bound}`);
    }
  }
});

test("token page: a launch in the fourth block of its second is found in one window of logs, however old, by an endpoint that keeps no old headers", async () => {
  // A LAUNCH AFTER THE SWITCH, TWO DAYS OLD; AND ONE FROM BEFORE IT, OLDER
  // THAN MAX_LOOKBACK'S TWO MILLION BLOCKS ($CURB's own block). The endpoint
  // refuses every header more than twice as far back as the launch.
  for (const [launch, latest] of [[SWITCH + 5 * 100_000 + 3, SWITCH + 5 * 100_000 + 3 + 5 * 86_400 * 2], [52_660_759, 55_000_000]]) {
    const { box, asked } = page({ ts: baseTs, launch, archiveBelow: launch - (latest - launch) - 10 });
    const head = Promise.resolve({ timestamp: '0x' + baseTs(latest).toString(16) });
    const got = await box.creationNear(latest, 0, FACTORY, { launchedAt: baseTs(launch) }, head);
    assert.equal(got, launch, `the launch in block ${launch}`);
    assert.equal(asked.logs, 1, 'one window of logs');
    assert.ok(asked.headers <= 25, `${asked.headers} headers to find block ${launch}`);
  }
});

test('token page: an endpoint that takes ten blocks of logs at most still finds the launch', async () => {
  const launch = SWITCH + 5 * 7_000 + 4;
  const latest = launch + 50_000;
  const { box } = page({ ts: baseTs, launch, cap: 10 });
  const head = Promise.resolve({ timestamp: '0x' + baseTs(latest).toString(16) });
  assert.equal(await box.creationNear(latest, 0, FACTORY, { launchedAt: baseTs(launch) }, head), launch);
});

test('token page: historyStart reads from the creation where it is recent or the index starts there, and from the floor otherwise', () => {
  const { box } = page({ ts: baseTs, launch: 0 });
  const floor = 1_000_000;
  const plain = (x: any) => ({ from: x.from, partial: x.partial });
  assert.deepEqual(plain(box.historyStart(1_200_000, floor, null)), { from: 1_200_000, partial: false }, 'recent, no file');
  assert.deepEqual(plain(box.historyStart(900_000, floor, { from: 899_000 })), { from: 900_000, partial: false }, 'old, the file starts before it');
  assert.deepEqual(plain(box.historyStart(900_000, floor, { from: 950_000 })), { from: floor, partial: true }, 'old, the file starts after it');
  assert.deepEqual(plain(box.historyStart(900_000, floor, null)), { from: floor, partial: true }, 'old, no file');
  assert.deepEqual(plain(box.historyStart(null, floor, { from: 0 })), { from: floor, partial: true }, 'no creation found');
});
