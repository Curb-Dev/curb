// Only one keeper writes at a time: the lease (compare-and-swap on the data
// repo's blob sha) under contention, its expiry and release, and the standby
// rule (act only when the primary's heartbeat is older than 45 minutes AND
// the lease can be taken).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { opsWorld } from './sim/world.ts';
import { tick, js } from './sim/helpers.ts';
import { Lease, LEASE_PATH, STATUS_PATH, primaryHeartbeatAge } from '../src/ops/lease.ts';
import { DataRepo } from '../src/ops/github.ts';
import { Secret } from '../src/ops/secrets.ts';
import { memoryLogger } from '../src/ops/log.ts';

function repoOf(w: ReturnType<typeof opsWorld>): DataRepo {
  return new DataRepo({ owner: 'curb', repo: 'curb-sharing-data', branch: 'main', apiBase: 'https://api.github.test', token: new Secret('t', 'ghp-test-token-0123456789'), fetch: w.net.fetch as any, sleep: async () => {} });
}

function lease(w: ReturnType<typeof opsWorld>, holder: string, role: 'primary' | 'standby' = 'primary', ttlSec = 600): Lease {
  return new Lease({ repo: repoOf(w), holder, role, ttlSec, log: memoryLogger(), now: w.clock.now });
}

test('two keepers racing for a free lease: the compare-and-swap lets exactly one win', async () => {
  const w = opsWorld();
  const a = lease(w, 'vps');
  const b = lease(w, 'gha');
  // a reads the lease as free; b takes it before a writes
  const aRead = await repoOf(w).get(LEASE_PATH);
  assert.equal(aRead, null);
  assert.equal(await b.acquire(), true);
  // a now writes as if the lease were still absent: GitHub refuses (a create over a file)
  await assert.rejects(() => repoOf(w).put(LEASE_PATH, new Uint8Array([1]), 'x', null), /422|sha/);
  // and a's own acquire, reading again, sees b's unexpired lease
  assert.equal(await a.acquire(), false);
  assert.equal(JSON.parse(w.net.text(LEASE_PATH)!).holder, 'gha');
});

test('a lost race inside acquire (409 on the sha) re-reads and yields to the winner', async () => {
  const w = opsWorld();
  const a = lease(w, 'vps');
  const b = lease(w, 'gha');
  assert.equal(await a.acquire(), true);
  await a.release();
  // a renews... while b takes it in the middle of a's write
  let once = true;
  w.net.beforeCommit = (path) => {
    if (path !== LEASE_PATH || !once) return;
    once = false;
    // b's write goes in first, through the same fake GitHub
    const doc = { schema: 'curb.sharing.lease/1', holder: 'gha', role: 'standby', takenAt: Math.floor(w.clock.t / 1000), expiresAt: Math.floor(w.clock.t / 1000) + 600 };
    w.net.put(LEASE_PATH, new TextEncoder().encode(JSON.stringify(doc)));
  };
  assert.equal(await a.acquire(), false, 'a yields');
  assert.equal(JSON.parse(w.net.text(LEASE_PATH)!).holder, 'gha');
  assert.equal(await b.acquire(), true, 'b renews its own');
});

test('a held lease blocks others until it expires or is released', async () => {
  const w = opsWorld();
  const a = lease(w, 'vps', 'primary', 600);
  const b = lease(w, 'gha', 'standby', 600);
  assert.equal(await a.acquire(), true);
  assert.equal(await b.acquire(), false);
  w.clock.t += 599_000;
  assert.equal(await b.acquire(), false, 'still valid one second before expiry');
  w.clock.t += 1_000;
  assert.equal(await b.acquire(), true, 'free at the second it expires');
  await b.release();
  assert.equal(JSON.parse(w.net.text(LEASE_PATH)!).expiresAt, 0);
  assert.equal(await a.acquire(), true, 'released');
});

test('a keeper releasing a lease it lost never clobbers the new holder', async () => {
  const w = opsWorld();
  const a = lease(w, 'vps', 'primary', 600);
  const b = lease(w, 'gha', 'standby', 600);
  assert.equal(await a.acquire(), true);
  w.clock.t += 601_000; // a's lease expired while it worked
  assert.equal(await b.acquire(), true);
  await a.release(); // a still thinks it holds it
  const doc = JSON.parse(w.net.text(LEASE_PATH)!);
  assert.equal(doc.holder, 'gha');
  assert.ok(doc.expiresAt > Math.floor(w.clock.t / 1000), "b's lease is untouched");
});

test('only a primary status counts as the primary heartbeat', async () => {
  const w = opsWorld();
  w.net.put(STATUS_PATH, new TextEncoder().encode(JSON.stringify({ role: 'standby', holder: 'x', heartbeatAt: Math.floor(w.clock.t / 1000) })));
  assert.equal((await primaryHeartbeatAge(repoOf(w), w.clock.now)).age, Infinity);
  w.net.put(STATUS_PATH, new TextEncoder().encode(JSON.stringify({ role: 'primary', holder: 'x', heartbeatAt: Math.floor(w.clock.t / 1000) - 10 })));
  assert.equal((await primaryHeartbeatAge(repoOf(w), w.clock.now)).age, 10);
});

test('keep() fails once somebody else holds the lease', async () => {
  const w = opsWorld();
  const a = lease(w, 'vps', 'primary', 600);
  assert.equal(await a.acquire(), true);
  w.net.put(LEASE_PATH, new TextEncoder().encode(JSON.stringify({ schema: 'curb.sharing.lease/1', holder: 'rival', role: 'standby', takenAt: 0, expiresAt: Math.floor(w.clock.t / 1000) + 600 })));
  w.clock.t += 400_000;
  assert.equal(await a.keep(), false);
});

test('a keeper that loses the lease in the middle of a tick sends nothing more', async () => {
  const w = opsWorld({ launches: 2, config: (c) => Object.assign(c.lease, { ttlSec: 60, heartbeatEverySec: 20, standbyAfterSec: 60 }) });
  const [A, B] = w.launches;
  const k = w.make('keeper');
  w.pass(3601);
  // A's harvest sits in the mempool for a while; meanwhile a rival takes the (soon stale) lease
  const firstTip = w.sim.tip;
  let rivalled = false;
  w.sim.stuck = (t) => {
    if (!rivalled && t.to === A.D) {
      rivalled = true;
      w.net.put(LEASE_PATH, new TextEncoder().encode(JSON.stringify({ schema: 'curb.sharing.lease/1', holder: 'rival', role: 'standby', takenAt: 0, expiresAt: Math.floor(w.clock.t / 1000) + 3600 })));
    }
    return t.to === A.D && t.tip <= firstTip;
  };
  const r = await tick(w, k);
  assert.ok(rivalled);
  const harvested = (d: string) => [...w.sim.txs.values()].some((t) => t.to === d && t.input === '0x4641257d');
  assert.ok(harvested(A.D), "A's harvest (already sent) landed");
  assert.ok(!harvested(B.D), 'nothing was sent after the lease was lost');
  assert.match(r.notes.join(' '), /another keeper holds the lease/);
});

test('keep() renews only past half the TTL', async () => {
  const w = opsWorld();
  const a = lease(w, 'vps', 'primary', 600);
  assert.equal(await a.acquire(), true);
  const commits = w.net.commits.length;
  w.clock.t += 200_000;
  assert.equal(await a.keep(), true);
  assert.equal(w.net.commits.length, commits, 'no write while more than half is left');
  w.clock.t += 200_000;
  assert.equal(await a.keep(), true);
  assert.equal(w.net.commits.length, commits + 1, 'renewed');
});

test('standby with a fresh primary heartbeat: does nothing at all', async () => {
  const w = opsWorld();
  const primary = w.make('keeper', { holder: 'vps' });
  const standby = w.make('keeper', { holder: 'gha', role: 'standby' });
  w.pass(60);
  await tick(w, primary); // writes the heartbeat
  assert.ok(w.net.repo.has(STATUS_PATH));
  w.chainPass(3601); // an epoch is due on chain...
  w.clock.t += 5 * 60_000; // ...and the primary beat five minutes ago
  const before = w.sim.sent.length;
  const commits = w.net.commits.length;
  const r = await tick(w, standby);
  assert.equal(w.sim.sent.length, before, 'no transaction');
  assert.equal(w.net.commits.length, commits, 'no write, not even the lease');
  assert.match(r.notes.join(' '), /standby stays idle/);
});

test('standby with a heartbeat older than 45 minutes takes the lease and acts', async () => {
  const w = opsWorld();
  const primary = w.make('keeper', { holder: 'vps' });
  const standby = w.make('keeper', { holder: 'gha', role: 'standby' });
  w.pass(60);
  await tick(w, primary);
  // the VPS dies; 46 minutes pass (wall clock), the chain moves on
  w.clock.t += 46 * 60_000;
  w.pass(3601);
  const r = await tick(w, standby);
  assert.equal(r.published.length, 1, js(r));
  assert.match(r.notes.join(' '), /silent for/);
  assert.ok(w.net.commits.some((c) => c.path === LEASE_PATH && /gha/.test(c.message)), 'it took the lease');
  assert.ok(w.net.repo.has('ops/status-standby.json'));
  assert.equal(JSON.parse(w.net.text(LEASE_PATH)!).expiresAt, 0, 'released after');
  const age = await primaryHeartbeatAge(repoOf(w), w.clock.now);
  assert.ok(age.age > 2700);
});

test('standby with a silent primary that still HOLDS the lease (mid-tick): does not act', async () => {
  const w = opsWorld();
  const standby = w.make('keeper', { holder: 'gha', role: 'standby' });
  const vpsLease = lease(w, 'vps', 'primary', 600);
  assert.equal(await vpsLease.acquire(), true);
  w.chainPass(3601);
  w.clock.t += 60_000;
  const before = w.sim.sent.length;
  const r = await tick(w, standby);
  assert.equal(w.sim.sent.length, before);
  assert.equal(r.published.length, 0);
  assert.match(r.notes.join(' '), /lease/);
  assert.ok(!w.net.repo.has('ops/status-standby.json'), 'a standby that did nothing reports nothing');
  const leaseReads = w.net.log.filter((x) => x.method === 'GET' && x.url.includes('/contents/ops/lease.json')).length;
  assert.equal(leaseReads, 2, "two reads: this test's own acquire and the standby's single refused one, not one per attempted write");
});

test('a standby without a data repo cannot see the primary, so it never acts', async () => {
  const w = opsWorld({ config: (c) => delete c.dataRepo });
  const standby = w.make('keeper', { holder: 'gha', role: 'standby' });
  w.pass(3601);
  const before = w.sim.sent.length;
  const r = await tick(w, standby);
  assert.equal(w.sim.sent.length, before);
  assert.match(r.notes.join(' '), /cannot see the primary/);
});

test('the primary writes its heartbeat on schedule, not every tick', async () => {
  const w = opsWorld();
  const p = w.make('keeper', { holder: 'vps' });
  await tick(w, p);
  const beats = () => w.net.commits.filter((c) => c.path === STATUS_PATH).length;
  assert.equal(beats(), 1);
  w.pass(300);
  await tick(w, p);
  assert.equal(beats(), 1, 'five minutes later: no new heartbeat');
  w.pass(900);
  await tick(w, p);
  assert.equal(beats(), 2, 'fifteen minutes later: a heartbeat');
});

// ---------------------------------------------------------------- a lease kept from the keeper (audit finding 7)

/** Somebody with a data repo token pins ops/lease.json for `holder`. */
function pin(w: ReturnType<typeof opsWorld>, holder: string, forSec: number): void {
  const now = Math.floor(w.clock.t / 1000);
  w.net.put(LEASE_PATH, new TextEncoder().encode(JSON.stringify({ schema: 'curb.sharing.lease/1', holder, role: 'standby', takenAt: now, expiresAt: now + forSec })));
}

test('a lease another holder keeps past one standby run plus the TTL: the ticks fail, it pages naming the holder, and lastOkAt goes stale', async () => {
  const w = opsWorld();
  const k = w.make('keeper', { holder: 'vps' });
  pin(w, 'standby-x', 10 * 365 * 86400);
  w.pass(3601); // an epoch is due: every tick needs a write
  const t0 = Math.floor(w.clock.t / 1000);
  const r0 = await tick(w, k);
  assert.match(r0.notes.join(' '), /another keeper holds the lease/);
  assert.equal(r0.ok, true, 'one refused tick is what a standby run looks like');
  let r = r0;
  while (r.ok && Math.floor(w.clock.t / 1000) - t0 < 3 * 3600) {
    w.pass(300);
    r = await tick(w, k);
  }
  const blockedFor = Math.floor(w.clock.t / 1000) - t0;
  assert.equal(r.ok, false, js(r));
  assert.ok(blockedFor > 1800 && blockedFor <= 2100, `not before 20 minutes plus the 10-minute TTL: ${blockedFor}s`);
  assert.match(r.errors[0], /"standby-x" has kept the data repo lease \(ops\/lease\.json\) from this keeper for 3[0-9] min/);
  assert.match(r.errors[0], /its lease runs until 2[0-9]{3}-/);
  const page = k.ctx.alerts.raised.filter((a) => a.key === 'lease-blocked');
  assert.equal(page.length, 1, js(k.ctx.alerts.raised.map((a) => a.key)));
  assert.equal(page[0].severity, 'page');
  const hb = JSON.parse(w.net.text(STATUS_PATH)!);
  assert.equal(hb.ok, false);
  assert.ok(hb.lastOkAt <= t0 + 1800, 'the heartbeat stops calling it clean');
  assert.equal(hb.leaseBlocked.holder, 'standby-x');
});

test('a standby run that keeps the lease for a while is no failure, and a free lease ends the streak', async () => {
  const w = opsWorld();
  const k = w.make('keeper', { holder: 'vps' });
  w.pass(3601);
  pin(w, 'gha-1', 1500); // an honest standby run, renewed for 25 minutes
  for (let i = 0; i < 5; i++) {
    const r = await tick(w, k);
    assert.equal(r.ok, true, js(r));
    assert.match(r.notes.join(' '), /another keeper holds the lease/);
    w.pass(300);
  }
  w.net.put(LEASE_PATH, new TextEncoder().encode(JSON.stringify({ schema: 'curb.sharing.lease/1', holder: 'gha-1', role: 'standby', takenAt: 0, expiresAt: 0 })));
  const free = await tick(w, k);
  assert.ok(!free.notes.join(' ').includes('another keeper holds the lease'), js(free));
  // a second run an hour later: a new streak, not the old one continued
  w.pass(3600);
  w.sim.income(w.launches[0].D, 10n ** 17n);
  w.pass(3700);
  pin(w, 'gha-2', 1500);
  for (let i = 0; i < 4; i++) {
    const r = await tick(w, k);
    assert.equal(r.ok, true, `${i}: ${js(r.errors)}`);
    assert.match(r.notes.join(' '), /another keeper holds the lease/, 'the second run keeps it too');
    w.pass(300);
  }
  assert.ok(!k.ctx.alerts.raised.some((a) => a.key === 'lease-blocked'));
});
