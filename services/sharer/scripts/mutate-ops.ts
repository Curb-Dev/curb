// Mutation pass over every guard of the ops package (WP6): each mutant
// removes, inverts or weakens one check; the ops suites run (test/ops-*.test.ts,
// the simulated chain and the fake net); the mutant must be killed by one of
// the tests named for it - killed for the right reason.
//
//   node scripts/mutate-ops.ts --dry            every anchor is found exactly once
//   node scripts/mutate-ops.ts [--only id,id] [--out report.json]

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

interface Mutant {
  id: string;
  file: string;
  find: string;
  replace: string;
  kill: string[];
}
const m = (id: string, file: string, find: string, replace: string, ...kill: string[]): Mutant => ({ id, file, find, replace, kill });

const K = 'src/ops/keeper.ts';
const T = 'src/ops/tx.ts';
const P = 'src/ops/push.ts';
const PU = 'src/ops/publish.ts';
const L = 'src/ops/lease.ts';
const V = 'src/ops/verify.ts';
const A = 'src/ops/alerts.ts';
const S = 'src/ops/secrets.ts';
const LG = 'src/ops/log.ts';
const C = 'src/ops/config.ts';
const G = 'src/ops/github.ts';
const PI = 'src/ops/pinners.ts';
const F = 'src/ops/files.ts';
const CV = 'src/ops/chainview.ts';
const SV = 'src/ops/server.ts';
const CL = 'src/cli.ts';
const R = 'src/ops/runner.ts';
const E = 'src/ops/events.ts';
const AK = 'src/ops/acks.ts';
const EP = 'src/epoch.ts';
const WK = '../../.github/workflows/sharing-keeper.yml';
const WV = '../../.github/workflows/sharing-verify.yml';
const TA = '../../script/b20/test-all.sh';
const DF = 'Dockerfile';
const DC = 'docker-compose.yml';
const DI = '.dockerignore';
const LV = 'src/ops/liveness.ts';
const GR = 'src/ops/graduation.ts';
const WR = 'src/ops/wiring.ts';
const FR = 'scripts/config-from-run.ts';
const WP = 'src/ops/writeprobe.ts';

export const MUTANTS: Mutant[] = [
  // ---------------------------------------------------------------- keeper: who may act
  m('K1 standby ignores a fresh heartbeat', K, 'if (age < cfg.lease.standbyAfterSec && cleanAge < cfg.lease.standbyAfterSec) {', 'if (false) {', 'standby with a fresh primary heartbeat'),
  m('K2 standby acts without a data repo', K, "    if (!ctx.repo) {\n      rep.notes.push('standby without a data repo", "    if (false) {\n      rep.notes.push('standby without a data repo", 'standby without a data repo'),
  m('K3 writes without the lease', K, '    if (!(await o.lease.acquire())) throw new NoLease();', '    await o.lease.acquire();', 'still HOLDS the lease', 'GitHub down'),
  m('K4 writes on after losing the lease', K, '      if (!(await o.lease.keep())) throw new NoLease();', '      await o.lease.keep();', 'loses the lease in the middle'),
  m('K5 open transactions not settled first', K, "      if (!s || !s.open()) continue;", '      continue;', 're-broadcasts it', 'STUCK journaled'),
  m('K6 the out-of-ETH key keeps sending', K, "      if (e instanceof OutOfEth) {\n        disabled.add(who);", '      if (e instanceof OutOfEth) {\n', 'out of ETH'),
  m('K7 disagreeing providers do not abort', 'src/ops/chainview.ts', '    if (fp(o) !== base) {', '    if (false) {', 'RPC disagreement on the distributor state'),
  // ---------------------------------------------------------------- keeper: activate
  m('K8 activate before the hour', K, 'if (v.pending.payableAt !== 0n && latest.timestamp >= v.pending.payableAt) {', 'if (v.pending.payableAt !== 0n) {', 'one full epoch'),
  m('K9 activate tried while frozen', K, "          if (f.frozen) {\n            line.activate = 'held by the freeze';", "          if (false) {\n            line.activate = 'held by the freeze';", 'frozen: no publish'),
  m('K10 Frozen revert not handled', K, "if (e instanceof WouldRevert && e.errorName === 'Frozen') {", 'if (false) {', 'reverting Frozen'),
  m('K11 NothingPending revert not handled', K, "} else if (e instanceof WouldRevert && e.errorName === 'NothingPending') {", '} else if (false) {', 'NothingPending'),
  // ---------------------------------------------------------------- keeper: payKeeper
  m('K12 payKeeper ignores its own cost', K, 'if (money.P > 0n && owedKeeper >= k.payKeeperMinFactor * cost0) {', 'if (money.P > 0n) {', 'payKeeper waits'),
  m('K13 payKeeper never sent', K, 'if (money.P > 0n && owedKeeper >= k.payKeeperMinFactor * cost0) {', 'if (false) {', 'one full epoch'),
  // ---------------------------------------------------------------- keeper: epochs
  m('K14 publishes as a non-publisher', K, 'const canPublish = !!keys.publisher && keys.publisher.address === f.publisher && !f.frozen;', 'const canPublish = !!keys.publisher && !f.frozen;', 'not the factory publisher'),
  m('K15 epochs while frozen', K, 'const canPublish = !!keys.publisher && keys.publisher.address === f.publisher && !f.frozen;', 'const canPublish = !!keys.publisher && keys.publisher.address === f.publisher;', 'frozen: no publish', 'frozen with an epoch otherwise due'),
  m('K16 an epoch while a root is pending', K, "  if (v.pending.payableAt !== 0n) return { note: `epoch ${v.pending.epoch} is pending` };", '', 'one full epoch', "inside a root's veto hour"),
  m('K17 a veto recomputed without an ack', K, '    if (!acks.has(`${d}:${v.lastProposedEpoch}`)) {', '    if (false) {', 'veto pages an operator'),
  m('K18 no cool-down after a no-epoch', K, "  if (Math.floor(ctx.now() / 1000) < until) return { note: 'the last attempt gave no epoch, or its file could not be published; waiting' };", '', 'no-epoch result', 'publishing failure backs off'),
  m('K19 no minimum gap', K, '  if (age < k.minEpochGapSec) return', '  if (false) return', 'one full epoch'),
  m('K20 a harvest that would revert is not stopped', K, '  if (!pre.ok) {', '  if (false) {', 'would revert is paged'),
  m('K21 harvest with no income', K, '  if (I0 <= 0n && I1 <= 0n) {', '  if (false) {', 'no income at all'),
  m('K22 MIN_POT ignored', K, 'const dueByPot = money.P > 0n && potValue >= minPot;', 'const dueByPot = money.P > 0n;', 'MIN_POT'),
  m('K23 no price counts as a pot', K, 'const dueByPot = money.P > 0n && potValue >= minPot;', 'const dueByPot = potValue >= minPot;', 'missing price'),
  m('K24 no 7-day rule', K, 'const dueByAge = age >= k.maxEpochWaitSec;', 'const dueByAge = false;', 'MIN_POT', 'missing price'),
  m('K25 the launch token not valued', K, "  const potValue = (I0 > 0n ? I0 : 0n) + (tokenPrice && I1 > 0n ? (I1 * tokenPrice) / 10n ** 18n : 0n);", '  const potValue = I0 > 0n ? I0 : 0n;', 'launch-token income'),
  m('K26 any old harvest reused', K, '    if (Number(latest.timestamp - ts) > k.harvestFreshSec) h = null;', '', 'crash between harvest and publish'),
  m('K27 a harvest from the pending hour reused', K, '  const from = cleared !== null && cleared + 1n > F ? cleared + 1n : F;', '  const from = F;', 'still pending is never'),
  m('K28 a reverted harvest used', K, '    if (!sent.receipt.status) throw new Error(`harvest of ${d} reverted`);', '', 'reverts when mined'),
  m('K29 loop mode computes an unsafe T', K, '    if (!o.waitForSafe) return', '    if (false) return', 'loop mode'),
  m('K30 once mode does not wait', K, '    while (h.block > safeNow && ctx.now() - start < k.safeWaitSec * 1000) {', '    while (false) {', 'once mode'),
  m('K31 not-ready is an error', K, '    if (e instanceof EpochNotReady) return { note: `not ready: ${e.code}: ${e.message}` };', '', 'safe head falling back inside the epoch read'),
  m('K32 stuck income not alerted', K, '  if (stuck.escrow + stuck.hook + stuck.lock0 + stuck.lock1 > 0n) {', '  if (false) {', 'stuck in the core', 'owed by the hook'),
  m('K33 stuck hook income not counted', CV, "    hook: await one(() => r.read<bigint>(incomeAbi, meta.hook, 'owed', [d, meta.quoteToken], block)),", '    hook: 0n,', 'owed by the hook'),
  m('K34 stalled never alerted', K, '  if (age >= ctx.cfg.keeper.stalledAfterSec) {', '  if (false) {', 'STALLED'),
  m('K35 stalled too early', K, '  if (age >= ctx.cfg.keeper.stalledAfterSec) {', '  if (age >= 0) {', 'STALLED'),
  m('K36 no one-by-one fallback', K, '    if (e instanceof WouldRevert && ready.length > 1) {', '    if (false) {', 'one by one'),
  m('K37 a refused publish is an error', K, "    } else if (e instanceof WouldRevert) {\n      // PendingRoot", "    } else if (false) {\n      // PendingRoot", 'single publish beaten by a rival'),
  m('K38 publish failure not alerted', K, "    if ('reason' in p) {\n      rep.ok = false;", "    if ('reason' in p && false) {\n      rep.ok = false;", 'publishing failure'),
  // ---------------------------------------------------------------- keeper: pushes
  m('K39 a file not fitting the root is pushed', K, "  if (tree.root !== v.active.merkleRoot) throw new Error", '  if (false) throw new Error', 'does not fit its file'),
  m('K40 a failed paid read taken as 0', K, '    if (!res[i].success || res[i].returnData.length < 66) throw new Error(`a paid/isExcluded read of ${v.d} failed`);', "    if (!res[i].success || res[i].returnData.length < 66) return 0n;", 'paid read that fails'),
  m('K41 PushSkipped from a receipt ignored', K, "        if (ev.eventName === 'PushSkipped') {", "        if (ev.eventName === 'none') {", 'grows 10x'),
  m('K42 the held-at memory not kept', K, '    for (const a of Object.keys(f.balancesAtEnd)) cur.at[a] = t;', '', 'dust rule, wired', 'never goes back'),
  m('K43 an older file overwrites the held-at memory', K, '    if (BigInt(cur.epoch) >= f.epoch) return;', '', 'never goes back'),
  m('K44 an older refusal overwrites a newer one', K, '    if (!prev || prev.at <= at) m[account]', '    m[account]', 'keeps the newest refusal'),
  m('K45 keeper-key check off', K, '    if (!cfg.sharing.rules.keeperKeys.includes(s.address)) {', '    if (false) {', 'not in rules.keeperKeys'),
  m('K46 low ETH not alerted', K, '    if (bal < cfg.keeper.lowEthWei) {', '    if (false) {', 'out of ETH'),
  m('K47 publisher mismatch not paged', K, '  if (keys.publisher && keys.publisher.address !== f.publisher) {', '  if (false) {', 'not the factory publisher'),
  m('K48 event scan not incremental', K, "  store.set('eventsBlock', to);", '', 'incremental'),
  m('K49 heartbeat every tick', K, "  if (o.role === 'primary' ? due : rep.acted || (due && !blocked)) {", "  if (o.role === 'primary' ? true : rep.acted || (due && !blocked)) {", 'heartbeat on schedule'),
  m('K50 a standby blocked by the lease reports', K, "  if (o.role === 'primary' ? due : rep.acted || (due && !blocked)) {", "  if (o.role === 'primary' ? due : rep.acted || due) {", 'still HOLDS the lease'),
  m('K51 the bisection starts at genesis', EP, 'meta.launchedAt, lo, meta.sharingSince))', 'meta.launchedAt, 0n, meta.sharingSince))', 'one full epoch'),
  m('K52 a Harvested log via a proxy taken as T', CV, '    if (rc.status && rc.to === d.toLowerCase()) return', '    if (rc.status) return', 'not sent straight to D'),
  m('K54 the journal not handed to the epoch', K, "keeperJournal: ctx.store.get<Record<string, KeeperJournalEntry[]>>('txJournal', {})", 'keeperJournal: {}', 'reverted (so logged nothing)'),
  m('K55 the keeper rescans the distributors for every epoch', K, '    const distributors = await boundDistributors(ctx, T, safeNow).catch(() => undefined);', '    const distributors = undefined;', 'bound so far'),
  m('K56 the providers\' kept lists not compared', K, '  return lists.every((l) => l === lists[0]) ? out : undefined;', '  return out;', 'invents a bound distributor'),
  m('K57 a growing file not paged', K, '  if (bytes < k.largeFileBytes && rows < k.largeFileAccounts) return;', '  return;', 'largeFileAccounts pages'),
  m('K58 a publishing failure does not back off', K, '      const wait = cfg.keeper.minEpochGapSec;\n      ctx.store.update<Record<string, number>>(\'noEpochUntil\', {}, (m) => {\n        m[x.d] = Math.floor(ctx.now() / 1000) + wait;\n      });', '      const wait = cfg.keeper.minEpochGapSec;', 'publishing failure backs off'),
  m('K59 a large contract holder not named', K, "      if (code === '0x' || code === '0x0') continue;", '      continue;', 'contract that is not excluded'),
  m('K60 every large holder taken for a contract', K, "      if (code === '0x' || code === '0x0') continue;", '', 'contract that is not excluded'),
  m('V16 the guardian\'s recompute rescans the distributors', V, ', distributorsAt: (T) => boundDistributors({ ...ctx, readers }, T, safe) }, d, ev.p);', ' }, d, ev.p);', 'bound so far'),

  // ---------------------------------------------------------------- the sender
  m('T1 no gas-price cap', T, '    if (price > cap) throw new GasPriceAboveCap(label, price, cap);', '', 'above the gas cap'),
  m('T2 no balance check', T, '    if (have < need) throw new OutOfEth(this.role, need, have);', '', 'out of ETH', 'without the ETH'),
  m('T3 a revert is not named', T, '      if (rv.name || /revert/i.test(rv.detail)) throw new WouldRevert(label, rv.name, rv.args, rv.detail);', '', 'names the contract error', 'NothingPending'),
  m('T4 never replaced', T, '      if (this.now() - since >= this.s.stuckAfterSec * 1000) {', '      if (false) {', 'stuck transaction is replaced'),
  m('T5 replacement fees not raised', T, 'const bump = (x: bigint) => (x * 125n) / 100n + 1n;', 'const bump = (x: bigint) => x;', 'stuck transaction is replaced'),
  m('T6 journaled after the broadcast', T, "    this.save(entry); // recorded BEFORE it is broadcast\n    await this.broadcast(raw);", '    await this.broadcast(raw);\n    this.save(entry);', 're-broadcasts it'),
  m('T7 an unknown pending nonce not cleared', T, '    await this.resume();\n    await this.clearUnknown();', '    await this.resume();', 'unknown pending nonce'),
  m('T8 a used nonce retried forever', T, '      if ((await this.nonceAt(\'latest\')) > entry.nonce) {', '      if (false) {', 'ANOTHER transaction already used'),
  m('T9 replacement above the cap', T, '        if (fee > cap) throw new StuckTx(', '        if (false) throw new StuckTx(', 'never replaced above the gas-price cap'),

  // ---------------------------------------------------------------- the push planner
  m('P1 paid leaves pushed', P, '    if (!owed) {', '    if (false) {', 'what is UNPAID'),
  m('P2 excluded leaves pushed', P, '    if (l.excluded) {', '    if (false) {', 'never pushed'),
  m('P3 pushed without a price', P, '    if (e.P === 0n) {', '    if (false) {', 'never pushed'),
  m('P4 the push gas cap inclusive', P, '    if (e.gasPrice > r.pushMaxGasPriceWei) {', '    if (e.gasPrice >= r.pushMaxGasPriceWei) {', 'never pushed'),
  m('P5 no push gas cap', P, '    if (e.gasPrice > r.pushMaxGasPriceWei) {', '    if (false) {', 'never pushed'),
  m('P6 threshold without the dollar floor', P, '    const threshold = floor0 > r.pushCostFactor * cost ? floor0 : r.pushCostFactor * cost;', '    const threshold = r.pushCostFactor * cost;', 'push threshold'),
  m('P7 threshold without the cost factor', P, '    const threshold = floor0 > r.pushCostFactor * cost ? floor0 : r.pushCostFactor * cost;', '    const threshold = floor0;', 'cost factor binds'),
  m('P8 threshold strict', P, '    if (value >= threshold) {', '    if (value > threshold) {', 'push threshold'),
  m('P9 dust without the empty check', P, '    const dusty = l.emptyNow && l.lastHeldAt !== null', '    const dusty = l.lastHeldAt !== null', 'dust rule'),
  m('P10 dust a second early', P, 'nowSec - l.lastHeldAt >= r.dustZeroSec', 'nowSec - l.lastHeldAt >= r.dustZeroSec - 1', 'dust rule'),
  m('P11 dust below 2x the cost', P, '    if (dusty && value >= r.dustCostFactor * cost) {', '    if (dusty) {', 'dust rule'),
  m('P12 a skipped account retried at once', P, '      if (!ripe) {', '      if (false) {', 'claim-only'),
  m('P13 skip retried a second early', P, 'nowSec - l.skipped.at >= r.skipRetrySec', 'nowSec - l.skipped.at >= r.skipRetrySec - 1', 'claim-only'),
  m('P14 skip growth rule lost', P, ' || value >= r.skipGrowth * (l.skipped.unpaidValue0 > 0n ? l.skipped.unpaidValue0 : 1n);', ';', 'claim-only', 'grows 10x'),
  m('P15 batches above the leaf bound', P, '    if (cur.length >= r.maxLeavesPerPush || gas + g > r.maxPushGas) flush();', '    if (gas + g > r.maxPushGas) flush();', 'batches'),
  m('P16 batches above the gas bound', P, '    if (cur.length >= r.maxLeavesPerPush || gas + g > r.maxPushGas) flush();', '    if (cur.length >= r.maxLeavesPerPush) flush();', 'batches'),
  m('P17 smallest first', P, '|| (a.value === b.value ? (a.l.account < b.l.account ? -1 : 1) : a.value > b.value ? -1 : 1));', '|| (a.value === b.value ? (a.l.account < b.l.account ? -1 : 1) : a.value > b.value ? 1 : -1));', 'batches'),
  m('P18 every leaf priced as a first payout', P, '  return l.paid0 === 0n && l.paid1 === 0n ? r.gas.pushFirstLeaf : r.gas.pushRepeatLeaf;', '  return r.gas.pushFirstLeaf;', 'UNPAID'),
  m('P19 the token side not valued', P, '  return o0 + (e.tokenPrice ? (o1 * e.tokenPrice) / WAD : 0n);', '  return o0;', 'launch-token side'),

  // ---------------------------------------------------------------- publishing
  m('U1 the bytes not checked against the hash', PU, "  if (sha256Hex(bytes) !== item.contentHash.toLowerCase()) return fail('the bytes are not the computed contentHash');", '', 'refuses bytes'),
  m('U2 published with no data repo', PU, "  if (!deps.repo) return fail('no data repo", "  if (false) return fail('no data repo", 'no site or no data repo'),
  m('U3 published with no site', PU, "  if (!deps.files.siteBase) return fail(", '  if (false) return fail(', 'no site or no data repo'),
  m('U4 published with no gateway', PU, "  if (deps.files.gateways.length === 0) return fail(", '  if (false) return fail(', 'no site or no data repo'),
  m('U5 too few pins accepted', PU, '  if (counted < deps.minPinned) return `', '  if (false) return `', 'kubo is down', 'another CID'),
  m('U6 the site copy not required', PU, '    if (siteOk && gwOk) {', '    if (gwOk) {', 'site is down', 'site serves other bytes'),
  m('U7 the gateway copy not required', PU, '    if (siteOk && gwOk) {', '    if (siteOk) {', 'gateway is down', 'gateway serves other bytes'),
  m('U8 wrong bytes treated as lag', PU, '    if (wrong) return `read back', '    if (false) return `read back', 'serves other bytes'),
  m('U9 a copy accepted without its hash', F, '      if (h !== contentHash.toLowerCase()) {', '      if (false) {', 'serves other bytes', 'served copies all hash wrong', 'while a gateway matches'),
  m('U20 a gateway copy not checked against its CID', F, 'await this.checkCopy(name, u, contentHash, want, signal);', 'await this.checkCopy(name, u, contentHash, null, signal);', 'served copies all hash wrong'),
  m('U21 a CID verdict inverted', F, 'fileCid(b) === cid ?', 'fileCid(b) !== cid ?', "CID's own bytes", 'served copies all hash wrong'),
  m('U22 a file above the read-back limit written and pinned', PU, '  if (bytes.length > MAX_FILE_BYTES) return fail(', '  if (false) return fail(', 'above the read-back limit'),
  m('U10 a bad cached file used', F, '    if (b && sha256Hex(b) === contentHash.toLowerCase()) return b;', '    if (b) return b;', 'cached file'),
  m('U11 a pin under another CID counted (kubo)', PI, '      if (last.Hash !== cid) return', '      if (false) return', 'pinners'),
  m('U12 a pin under another CID counted (pinata)', PI, '      if (got !== cid) return', '      if (false) return', 'pinners', 'another CID'),
  m('U13 a PSA pin counted', PI, '  readonly counts = false;', '  readonly counts = true;', 'pinners'),

  // ---------------------------------------------------------------- the lease
  m('L1 an unexpired lease of another taken', L, '      if (doc && doc.holder !== this.o.holder && doc.expiresAt > nowS) {', '      if (false) {', 'blocks others', 'exactly one win'),
  m('L2 a lease free a second late', L, '      if (doc && doc.holder !== this.o.holder && doc.expiresAt > nowS) {', '      if (doc && doc.holder !== this.o.holder && doc.expiresAt >= nowS) {', 'blocks others'),
  m('L3 the compare-and-swap dropped', L, "        await repo.put(LEASE_PATH, enc(next), `lease: ${this.o.holder} until ${next.expiresAt}`, cur ? cur.sha : null);", "        await repo.put(LEASE_PATH, enc(next), `lease: ${this.o.holder} until ${next.expiresAt}`, null);", 'blocks others', 'keep() renews'),
  m('L4 a lost race thrown', L, "        if (!(e instanceof Conflict)) throw e;\n        this.o.log.info('lost a race", "        throw e;\n        this.o.log.info('lost a race", 'lost race inside acquire'),
  m('L5 renewed on every keep', L, '    if (this.until - nowS > this.o.ttlSec / 2) return true;', '', 'keep() renews'),
  m('L6 released lease still valid', L, "        await repo.put(LEASE_PATH, enc({ ...doc, expiresAt: 0 }),", "        await repo.put(LEASE_PATH, enc({ ...doc }),", 'blocks others'),
  m('L7 another holder released', L, '      if (!cur || !doc || doc.holder !== this.o.holder) return; // not ours any more', '      if (!cur || !doc) return;', 'never clobbers'),
  m('L8 any status counts as the primary', L, "    if (j && j.role === role && typeof j.heartbeatAt === 'number')", "    if (j && typeof j.heartbeatAt === 'number')", 'only a primary status'),

  // ---------------------------------------------------------------- verifier and guardian
  m('V1 a hash mismatch called unavailable', V, '      if (served.length) {', '      if (false) {', 'served copies all hash wrong'),
  m('V1b a hash mismatch counted against the root', V, '        out.reason = REASONS.HASH;', "        out.verdict = 'mismatch'; out.reason = REASONS.HASH;", 'served copies all hash wrong'),
  m('V1c a hash mismatch not paged at once', V, "severity: owe || hashBad || res.reason === REASONS.UNAVAILABLE || res.urgent ? 'page' : 'warn',", "severity: owe || res.reason === REASONS.UNAVAILABLE || res.urgent ? 'page' : 'warn',", 'served copies all hash wrong'),
  m('V1d a bad copy of a verified root not warned of', V, 'for (const c of res.copies) if (!c.ok) await raiseCopyBad(ctx, d, P.epoch, P.contentHash, c);', '', 'while a gateway matches'),
  m('V1e the site copy not re-hashed after verifying', V, 'if (!check.ok) await raiseCopyBad(ctx, v.d, R.epoch, R.contentHash, check);', '', 'tampered AFTER'),
  m('V1f no hint that the rules are out of step', V, "if (index.rules.version !== deps.sharing.rules.version) out.problems.push(", "if (false) out.problems.push(", 'out of step'),
  m('V2 a file not matching its root passes', V, '    if (!check.ok) {\n      out.verdict', '    if (false) {\n      out.verdict', 'FILE_INVALID'),
  m('V3 a recompute mismatch passes', V, '    if (!rc.same) {', '    if (false) {', 'forged epoch', 'public verifier'),
  m('V4 vetoes after the hour', V, 'const vetoable = still && (now.timestamp < P.payableAt || frozenNow);', 'const vetoable = still;', 'after the veto hour'),
  m('V5 no veto of a held root while frozen', V, 'const vetoable = still && (now.timestamp < P.payableAt || frozenNow);', 'const vetoable = still && now.timestamp < P.payableAt;', 'while frozen a held root'),
  m('V6 unverifiable vetoed at once', V, 'const late = left <= cfg.guardian.vetoUnverifiedBeforeSec && vetoable;', 'const late = vetoable;', 'not vetoed at once', 'vetoUnverifiedBeforeSec = 0'),
  m('V8 no freeze on a repeat', V, '  return seen.some((v) => REPEAT_REASONS.has(v.reason) && Number(head.timestamp) - v.at <= ctx.cfg.guardian.repeatWindowSec);', '  return false;', 'SECOND mismatch'),
  m('V9 no freeze on a plainly malicious root', V, '            const malicious = res.reason === REASONS.INVALID;', '            const malicious = false;', 'FILE_INVALID'),
  m('V10 an UNVERIFIED veto counts toward the repeat', V, 'new Set<string>([REASONS.RECOMPUTE, REASONS.INVALID].map(', 'new Set<string>([REASONS.RECOMPUTE, REASONS.INVALID, REASONS.UNVERIFIED].map(', 'an earlier UNVERIFIED veto does not count'),
  m('V11 a repeat window that never ends', V, ' && Number(head.timestamp) - v.at <= ctx.cfg.guardian.repeatWindowSec);', ');', 'more than 30 days after'),
  m('V12 a non-vetoer guardian not paged', V, '    if (guardian && !(await isVetoer(r0, cfg.distributorFactory, guardian.address, latest.number))) {', '    if (false) {', 'not a vetoer'),
  m('V13 every pass re-verifies', V, "        if (verified[key] === 'ok') continue;", '', 'honest epoch verifies'),
  m('V13b a mismatch judged again every pass', V, "        if (verified[key] === 'mismatch') {\n          bad.add(key);", "        if (false) {\n          bad.add(key);", 'a mismatch is checked once'),
  m('V14 the root in force never checked', V, '      if (A.epoch === 0n) continue;', '      continue;', 'superseded'),
  m('V15 verify mode signs', V, '          if (guardian && vetoable) {', '          if (vetoable) {', 'never signs'),

  // ---------------------------------------------------------------- epoch files past one chunk of rows (an index and its chunks)
  m('CH1 the chunks not published', K, 'contentHash: x.result.contentHash, chunks: x.result.chunks },', 'contentHash: x.result.contentHash },', 'more than 512 earning accounts'),
  m('CH2 the index published after a chunk failed', PU, "    if (typeof at === 'string') return fail(`chunk ${k}", "    if (false) return fail(`chunk ${k}", 'cannot place keeps its epoch off the chain'),
  m('CH3 the guardian checks the index without its chunks', V, '      prevLoaded.file,\n      { chunks },\n    );', '      prevLoaded.file,\n    );', 'more than 512 earning accounts'),
  m('CH4 a chunk served wrong called unavailable', V, 'out.reason = e.served ? REASONS.HASH : REASONS.UNAVAILABLE;', 'out.reason = REASONS.UNAVAILABLE;', 'served only wrong is HASH'),
  m('CH5 a chunk nobody serves a verdict on the root', V, '      if (!(e instanceof ChunkUnavailable)) throw e;\n      out.reason', "      if (!(e instanceof ChunkUnavailable)) throw e;\n      out.verdict = 'mismatch';\n      out.reason", 'served only wrong is HASH'),
  m('CH6 the guardian reads the previous file without its chunks', V, ', T, chunkFetcher(deps.files, d, deps.signal));', ', T);', 'more than 512 earning accounts'),
  m("CH7 the keeper's opening state read without its chunks", K, ', T, chunkFetcher(ctx.files, d))).state', ', T)).state', 'more than 512 earning accounts'),
  m('CH8 the active file read without its chunks', K, '  const f = (await readWholeEpoch(ctx.files, v.d, bytes)).file;', "  const f = (await import('../calc/file.ts')).parseEpochFile(bytes);", 'more than 512 earning accounts'),
  m('CH9 a push across two chunks', P, '    if (chunk.get(x.l.account) !== curChunk) {', '    if (false) {', 'more than 512 earning accounts'),
  m('CH10 pushes not grouped by chunk', P, 'chunk.get(a.l.account)! - chunk.get(b.l.account)! || ', '', 'more than 512 earning accounts'),
  m('CH11 a restart state from chunks not checked', 'src/state.ts', '  }, null, { chunks });', '  });', 'more than 512 earning accounts'),
  m('CH12 rebuild reads the index alone', 'src/ops/rebuild.ts', 'noteHeld(ctx, d, (await readWholeEpoch(ctx.files, d, bytes)).file);', "noteHeld(ctx, d, (await import('../calc/file.ts')).parseEpochFile(bytes));", 'more than 512 earning accounts'),
  m('CH13 a chunk not read back before the index', PU, '      copies: () => chunkCopies(deps.files, d, c.info),', "      copies: async () => [{ source: 'site', ok: true }, { source: 'gateway x', ok: true }],", 'cannot place keeps its epoch off the chain'),

  // ---------------------------------------------------------------- the guardian against a slow publisher (audit findings 3, 5, 6, 19, 21)
  m('H1 the body read without a deadline', 'src/ops/http.ts', '      const { done, value } = await unlessAborted(reader.read(), signal);', '      const { done, value } = await reader.read();', 'never finishes arriving times out'),
  m('H2 a Content-Length above the limit read anyway', 'src/ops/http.ts', '  if (max !== undefined && declared !== null && /^[0-9]+$/.test(declared.trim()) && Number(declared.trim()) > max) {', '  if (false) {', 'Content-Length above the limit'),
  m('H3 the bytes counted only far past the limit', 'src/ops/http.ts', '      if (max !== undefined && n > max) throw new TooLarge(', '      if (max !== undefined && n > max * 1000) throw new TooLarge(', 'Content-Length above the limit'),
  m("H4 the caller's deadline ignored", 'src/ops/http.ts', '    const signal = outer ? AbortSignal.any([outer, timeout.signal]) : timeout.signal;', '    const signal = timeout.signal;', "caller's signal stops the download"),
  m('G1 pending roots in discovery order', V, '    const pending = views.filter((v) => v.pending).sort(', '    const pending = views.filter((v) => v.pending); void (', 'the one whose hour ends first first'),
  m('G2 a veto waits for the end of the pass', V, '          if (guardian && vetoable && !holds) await settleOwed(ctx, guardian, rep);', '', 'the moment its root is judged'),
  m('G3 the late veto decided on the head the pass started at', V, '        const left = Number(P.payableAt - now.timestamp);', '        const left = Number(P.payableAt - latest.timestamp);', 'fresh head'),
  m('G4 a root check bounded only by the pass', V, '  const checkMs = () => Math.min(cfg.guardian.checkTimeoutSec * 1000, checksLeft());', '  const checkMs = () => checksLeft();', 'never finish arriving'),
  m('G5 the pass without a deadline', V, '        else if (checksLeft() <= 0) {', '        else if (false) {', 'never finish arriving'),
  m('G6 a pass past its deadline called clean', V, '    if (overrun) {\n      rep.ok = false;', '    if (false) {\n      rep.ok = false;', 'never finish arriving'),
  m("G7 a root's event looked up over the whole history", V, '  const { published } = await readEpochHistory(r, d, lo, to);', '  const { published } = await readEpochHistory(r, d, 0n, head);', "reads no launch's history"),
  m('G8 the roots read on one provider', V, '  const per = await Promise.all(ctx.readers.map(async (r) => ({ label: r.label, ...(await readRootsMany(', '  const per = await Promise.all(ctx.readers.slice(0, 1).map(async (r) => ({ label: r.label, ...(await readRootsMany(', 'hides a pending root'),
  m('G9 the event read on one provider', V, '  for (const r of readers) found.push(', '  for (const r of readers.slice(0, 1)) found.push(', 'leaves a RootPublished out'),
  m('G10 a root pending on one provider only ignored', V, '      pending: each[0].pending.payableAt !== 0n ? each[0].pending : (shown?.pending ?? null),', '      pending: each[0].pending.payableAt !== 0n ? each[0].pending : null,', 'hides a pending root'),
  m('G11 an owed veto not sent before the checks', V, '    // ---- 1. what the guardian already owes: vetoes and a freeze that have not landed\n    if (guardian) {', '    // ---- 1. what the guardian already owes: vetoes and a freeze that have not landed\n    if (false) {', 'owed veto goes out at the start'),
  m('G12 a reverted receipt taken for a veto', V, "    if (!sent.receipt.status) {\n      ctx.log.warn('a veto was mined and REVERTED'", "    if (false) {\n      ctx.log.warn('a veto was mined and REVERTED'", 'mined and REVERTS'),
  m('G13 no fallback to one veto per root', V, "        if (r !== 'revert') continue;", '        continue;', 'mined and REVERTS'),
  m('G14 an owed veto sent without reading its root again', V, "    if (st === 'pending') live.push([k, o]);\n    else await dropOwed(ctx, k, o, st);", '    live.push([k, o]);', 'somebody else vetoed is dropped', 'names only roots still pending'),
  m('G15 a missed veto not paged', V, "  if (st === 'vetoed') {", '  if (true) {', 'hour ran out pages'),
  m("G16 the guardian on the keeper keys' gas cap", R, "    const own = role === 'guardian' ? { ...settings, maxGasPriceWei: cfg.guardian.maxGasPriceWei } : settings;", '    const own = settings;', 'gas cap is its own'),
  m('G17 an untrusted guardian heartbeat trusted', LV, '      const trusted = guardian && !why ? guardian : null;', '      const trusted = guardian;', 'signs its heartbeat'),
  m('G18 a heartbeat signed by anybody trusted', LV, '  if (!(await isVetoer(r0, ctx.cfg.distributorFactory, signer, head))) return', '  if (false) return', 'signs its heartbeat'),
  m('G19 the guardian heartbeat not signed', V, '  if (signature) status.signature = signature;', '', 'signs its heartbeat', 'the guardian is silent'),
  m('G20 a pending root nobody serves not paged at once', V, ' || res.reason === REASONS.UNAVAILABLE || res.urgent ?', ' || res.urgent ?', 'the one whose hour ends first first'),
  m('G21 the distributors discovered on one provider', K, '  const readers = o.allProviders ? ctx.readers : [ctx.readers[0]];', '  const readers = [ctx.readers[0]];', 'leaves out of the discovery'),
  m('G22 an owed freeze forgotten when it fails', V, "  } catch (e) {\n    rep.ok = false;\n    rep.errors.push(`freeze: ", "  } catch (e) {\n    ctx.store.delete('owedFreeze');\n    rep.ok = false;\n    rep.errors.push(`freeze: ", 'owed freeze is sent'),
  m('N1a the roots read one call at a time', CV, '    if (!out.batched) {\n      alone.push(...part);', '    if (true) {\n      out.batched = false;\n      alone.push(...part);', 'one Multicall3 request per provider'),
  m('N1c the checks budget counted from the start of the pass', V, '    tChecks = performance.now();', '', 'their own budget'),
  m('N1d a root the pass had no time for vetoed unchecked', V, '          if (verified[key] !== \'unverifiable\') {\n            if (late) unseenLate++;\n            continue;\n          }', '', 'no time for is not vetoed'),
  m('N1e no freeze for unchecked roots in their last minutes', V, '        if (unseenLate && !holds && guardian) oweFreeze(', '        if (false) oweFreeze(', 'no time for is not vetoed'),
  m('N2a no freeze when many roots are bad at once', V, '      if (k === 0 || bad.size < k || holds) return;', '      return;', 'freezes first, then vetoes it', 'frozen first, then one vetoMany'),
  m('N2b unverifiable roots vetoed only late', V, '          const grace = vetoable && graceOver(key, now.timestamp);', '          const grace = false;', 'vetoed after the grace', 'still one vetoMany', 'grace runs from the first time'),
  m('N2c no grace at all', V, '      const first = (since[key] ??= Number(nowTs));', '      const first = (since[key] ??= Number(nowTs)) && 0;', 'grace runs from the first time'),
  m('N2d vetoes after the grace sent one by one', V, '          if (guardian && late && !holds) await settleOwed(ctx, guardian, rep);', '          if (guardian && owe && !holds) await settleOwed(ctx, guardian, rep);', 'still one vetoMany'),
  m('N2e the owed freeze not sent with the vetoes', V, '  await settleFreeze(ctx, guardian, rep);\n  const { store, log } = ctx;', '  const { store, log } = ctx;', 'frozen first, then one vetoMany', 'freezes first, then vetoes it'),
  m('N4a the recompute not stopped at the deadline', V, '  const readers = deps.signal ? deps.readers.map((r) => stoppable(r, deps.signal!)) : deps.readers;', '  const readers = deps.readers;', 'stops reading at its deadline'),
  m('N4b an abandoned check started again', V, "        else if (checking(ctx).has(key)) res = unverified(", "        else if (false) res = unverified(", 'is not checked again'),
  m('N4c an abandoned check of the active root started again', V, "verified[key] !== 'mismatch' && !checking(ctx).has(key)) {", "verified[key] !== 'mismatch') {", 'active root whose abandoned check'),
  // (no mutant for the signal verifyPublished hands recomputeEpochFile: its
  // readers are stoppable already, so every read after the deadline throws
  // with or without it - removing it is equivalent where a test can see)
  m('N9a a freeze owed only when not frozen', V, "            if ((malicious || repeat) && !holds) oweFreeze(", "            if ((malicious || repeat) && !frozenNow) oweFreeze(", 'which cancels the unfreeze'),
  m('N9b an owed freeze dropped while an unfreeze is announced', V, '  if (fz.frozen && fz.unfreezeAt === 0n) {\n    ctx.store.delete(\'owedFreeze\');', '  if (fz.frozen) {\n    ctx.store.delete(\'owedFreeze\');', 'which cancels the unfreeze'),
  m('LB1 a lease kept from the keeper never a failure', K, '  if (age <= ctx.cfg.lease.blockedAfterSec) return;', '  return;', 'lease another holder keeps'),
  m('LB2 a blocked streak never ends', K, "    if (!blocked) store.delete('leaseBlocked');", '', 'standby run that keeps'),
  m('LB3 a lease kept from the keeper fails at once', K, '  if (age <= ctx.cfg.lease.blockedAfterSec) return;', '  if (age < 0) return;', 'standby run that keeps', 'lease another holder keeps'),
  m('LB4 a pinned lease not named', L, '        this.other = { holder: doc.holder, role: String(doc.role), expiresAt: doc.expiresAt };', '', 'lease another holder keeps'),

  // ---------------------------------------------------------------- alerts and events
  m('A1 no cooldown', A, '    if (last !== undefined && nowS - last < cd) {', '    if (false) {', 'one per key per cooldown'),
  m('A2 a failing sink throws', A, "      log.warn('an alert sink failed', { sink: s.name, error });\n      out.push({ sink: s.name, ok: false, error });", '      throw e;', 'one per key per cooldown'),
  m('A3 a vetoer removal only a warning', E, "      return { key, severity: 'page', title: 'The REMOVAL OF A VETOER was announced'", "      return { key, severity: 'warn', title: 'The REMOVAL OF A VETOER was announced'", 'its severity', 'role and catalog changes'),
  m('A4 an unfreeze not paged', E, "      return { key, severity: 'page', title: 'An UNFREEZE was announced'", "      return { key, severity: 'info', title: 'An UNFREEZE was announced'", 'its severity'),
  m('A5 a catalog proposal not paged', E, "      return { key, severity: 'page', title: 'A new DISTRIBUTOR FACTORY was proposed", "      return { key, severity: 'warn', title: 'A new DISTRIBUTOR FACTORY was proposed", 'its severity'),
  m('A6 a removed vetoer not paged', E, ": { key, severity: 'page', title: 'A vetoer was REMOVED'", ": { key, severity: 'warn', title: 'A vetoer was REMOVED'", 'its severity'),
  m('A7 a freeze not paged', E, "      return { key, severity: 'page', title: 'Holder sharing is FROZEN'", "      return { key, severity: 'warn', title: 'Holder sharing is FROZEN'", 'its severity'),
  m('A8 a veto not paged', E, "      return { key, severity: 'page', title: 'An epoch was VETOED'", "      return { key, severity: 'warn', title: 'An epoch was VETOED'", 'its severity'),
  m('A9 the guardian not told it is the one removed', E, "${mine(a.account) ? ' That is THIS guardian.' : ''} Adding it again", ' Adding it again', 'role and catalog changes'),
  m('A10 a cancelled unfreeze not scanned', E, "'UnfreezeAnnounced', 'UnfreezeCancelled', 'Unfrozen'", "'UnfreezeAnnounced', 'Unfrozen'", 'its severity', 'freezing again'),
  m('A11 an unfreeze alert offers no vetoer freeze', E, ", call('cancel the unfreeze by freezing again (owner Safe or a vetoer)', f, 'freeze')]", ']', 'freezing again'),

  // ---------------------------------------------------------------- secrets and logs
  m('S1 registered secrets not scrubbed', S, "    if (out.includes(s)) out = out.split(s).join('[secret]');", '', 'no secret reaches a log line', 'never logs its keys'),
  m('S2 URL credentials not scrubbed', S, "  out = out.replace(/(https?:\\/\\/)[^/\\s:@]+:[^/\\s@]+@/gi, '$1[secret]@');", '', 'redactor scrubs'),
  m('S3 bearer tokens not scrubbed', S, "  out = out.replace(/(bearer\\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[secret]');", '', 'redactor scrubs'),
  m('S4 a Telegram bot path not scrubbed', S, "  out = out.replace(/\\/bot\\d+:[A-Za-z0-9_-]{20,}/g, '/bot[secret]');", '', 'redactor scrubs', 'bot token is not logged'),
  m('S5 a Secret serialises itself', S, "  toJSON(): string {\n    return '[secret]';", '  toJSON(): string {\n    return this.#value;', 'never prints itself'),
  m('S6 the env wins over the Docker secret', S, '  candidates.push(join(dir, name));\n  for (const p of candidates) {', '  for (const p of candidates) {', 'secret file wins'),
  m('S7 a key not shape-checked', S, "  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) throw new SecretError(`the secret ${name} is not a 32-byte hex private key`);", '', 'shape-checked'),
  m('S8 log lines not redacted', LG, '      write(redact(serialise(obj)));', '      write(serialise(obj));', 'no secret reaches a log line'),
  m('S9 a JSON secret\'s strings not registered', S, '      if (typeof x === \'string\') registerSecret(x);', '      if (false) registerSecret(x);', 'secret file wins'),

  // ---------------------------------------------------------------- config, CLI, wiring
  m('C1 unknown keys accepted', C, '  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new ConfigError', '  for (const k of Object.keys(o)) if (false) throw new ConfigError', 'every refusal'),
  m('C2 credentials in URLs accepted', C, "  if (/@/.test(x.split('/')[2] ?? '')) throw new ConfigError", "  if (false) throw new ConfigError", 'every refusal'),
  m('C3 minPinned above the pinners', C, "  if (minPinned > pinners.filter((p) => p.kind !== 'psa').length) throw new ConfigError", '  if (false) throw new ConfigError', 'every refusal'),
  m('C4 a push cap above the global cap', C, '  if (keeper.pushMaxGasPriceWei > keeper.maxGasPriceWei) throw new ConfigError', '  if (false) throw new ConfigError', 'every refusal'),
  m('C5 a standby taking over a live primary', C, '  if (lease.heartbeatEverySec * 2 > lease.standbyAfterSec) throw new ConfigError', '  if (false) throw new ConfigError', 'every refusal'),
  m('C6 a climbing data repo root', C, " || root.split('/').some((x) => x === '.' || x === '..')", '', 'every refusal'),
  m('C7 a CLI option nobody knows', CL, '  for (const k of a.flags.keys()) if (!keys.includes(k)) throw new ConfigError', '  for (const k of a.flags.keys()) if (false) throw new ConfigError', 'unknown option is refused'),
  m('C8 --loop and --once not exclusive', CL, "    if (['keeper', 'verify', 'guardian'].includes(mode) && isLoop === has(a, 'once')) throw new ConfigError", '    if (false) throw new ConfigError', 'exactly one of --loop and --once'),
  m('C9 one provider accepted', R, "  if (rpcs.length < 2 && !o.allowSingleProvider) throw new SetupError", '  if (false) throw new SetupError', 'build() refuses'),
  m('C10 one key for two roles', R, '  if (keys.publisher && keys.pusher && keys.publisher.address === keys.pusher.address) throw new SetupError', '  if (false) throw new SetupError', 'build() refuses'),
  m('C11 a keeper with no pusher', R, "  if (o.mode === 'keeper' && !keys.pusher) throw new SetupError", '  if (false) throw new SetupError', 'build() refuses'),
  m('C12 a guardian with no key', R, "  if (o.mode === 'guardian' && !keys.guardian) throw new SetupError", '  if (false) throw new SetupError', 'build() refuses'),
  m('C20 check passes a zero address', R, "    if (/^0x0{40}$/i.test(a)) {", '    if (false) {', 'left at zero addresses'),
  m('C21 check passes an address with no code', R, "      if (!code || code === '0x') {", '      if (false) {', 'no code, and a provider'),
  m('C22 check swallows a provider without eth_call-without-to', R, "      problems.push(`provider ${r.label} cannot run", "      lines.push(`provider ${r.label} cannot run", 'no code, and a provider'),
  m('C23 check says ok despite problems', CL, "        return 2;\n      }\n      io.out(`config ok;", "      }\n      io.out(`config ok;", 'left at zero addresses'),
  m('C24 --once prints nothing', CL, 'io.out(JSON.stringify({ mode,', 'void (JSON.stringify({ mode,', 'prints what its pass found'),
  m('C25 the status line from before the activation', K, '              line.active = v.active.epoch.toString();', '', 'AFTER the tick acted'),
  m('C26 the status line without what was published', K, '      if (line) line.pending = p.epoch.toString();', '', 'AFTER the tick acted'),
  m('C13 a GitHub sha conflict not a Conflict', G, '    if (res.status === 409 || (res.status === 422 && /sha/i.test(message))) throw new Conflict', '    if (false) throw new Conflict', 'compare-and-swap', 'exactly one win'),
  m('C14 upsert rewrites identical bytes', G, "      if (cur && Buffer.from(cur.bytes).equals(Buffer.from(bytes))) return 'same';", '', 'compare-and-swap', 'no new commit'),
  m('C15 the preview answer not checked', CV, "  if (!/^0x[0-9a-fA-F]{192}$/.test(raw)) throw new Error", '  if (false) throw new Error', 'not three words'),
  m('C16 health: stale ticks healthy', SV, '    if (this.lastOkAt !== null && t - this.lastOkAt <= 3 * this.intervalMs) return', '    if (this.lastOkAt !== null) return', 'health:'),
  m('C17 health: healthy for ever while starting', SV, '    if (this.lastOkAt === null && t - this.startedAt <= this.graceMs) return', '    if (this.lastOkAt === null) return', 'health:'),
  m('C18 acks from the data repo ignored', AK, '  if (ctx.repo) {\n    const f = await ctx.repo.get(ACKS_PATH);', '  if (false) {\n    const f = await ctx.repo!.get(ACKS_PATH);', 'veto pages an operator'),

  // ---------------------------------------------------------------- liveness (gap items 8, 9)
  m('LV1 a failing streak never pages', LV, '  if (!ok && nowS - next.failingSince! >= failingAfterSec) {', '  if (false) {', 'one provider down', 'the guardian: its failing passes', 'a verifier whose passes keep failing'),
  m('LV2 the first failed tick pages', LV, '  if (!ok && nowS - next.failingSince! >= failingAfterSec) {', '  if (!ok && nowS - next.failingSince! >= 0) {', 'one provider down', 'the guardian: its failing passes', 'a verifier whose passes keep failing'),
  m('LV3 the streak restarts every tick', LV, 'failingSince: prev.failingSince ?? nowS,', 'failingSince: nowS,', 'one provider down'),
  m('LV4 the heartbeat without lastOkAt', K, 'ok: rep.ok, lastOkAt: live.lastOkAt,', 'ok: rep.ok, lastOkAt: null,', 'one provider down', 'the ticks recover'),
  m('LV5 the standby trusts a beating primary that never finishes', K, 'if (age < cfg.lease.standbyAfterSec && cleanAge < cfg.lease.standbyAfterSec) {', 'if (age < cfg.lease.standbyAfterSec) {', 'one provider down'),
  m('LV6 a change of state waits for the schedule', K, '  const due = nowS - last >= ctx.cfg.lease.heartbeatEverySec || live.changed;', '  const due = nowS - last >= ctx.cfg.lease.heartbeatEverySec;', 'one provider down', 'the ticks recover'),
  m('LV7 a refused token not paged', G, '    if (isDenied(res.status, message) && this.onDenied) {', '    if (false) {', 'expired data-repo token', 'expired token cannot read'),
  m('LV8 a rate limit paged as a refused token', G, "  return status === 401 || (status === 403 && !/rate limit/i.test(message));", '  return status === 401 || status === 403;', 'expired data-repo token'),
  m('LV9 a guardian low on ETH not warned', V, '      if (balanceWei < cfg.guardian.lowEthWei) {', '      if (false) {', 'the guardian: its failing passes'),
  m('LV10 the guardian writes no heartbeat', V, '      if (guardian) await guardianHeartbeat(', '      if (false) await guardianHeartbeat(', 'the guardian: its failing passes', 'the guardian is silent'),
  m('LV11 a covering standby ignored', LV, '    if (Math.min(pq, sq) >= cfg.verifier.keeperSilentAfterSec) {', '    if (pq >= cfg.verifier.keeperSilentAfterSec) {', 'not while the standby covers'),
  m('LV12 no keeper at all never paged', LV, '    if (Math.min(pq, sq) >= cfg.verifier.keeperSilentAfterSec) {', '    if (false) {', 'NO keeper has finished', 'no keeper heartbeat at all'),
  m('LV13 a beat counts as a clean tick', L, "  const at = typeof beat.lastOkAt === 'number' ? beat.lastOkAt : typeof beat.failingSince === 'number' ? beat.failingSince : beat.heartbeatAt;", '  const at = beat.heartbeatAt;', 'one provider down', 'the primary beats but every tick fails'),
  m('LV14 a silent guardian never paged', LV, '      if (gq >= cfg.verifier.guardianSilentAfterSec) {', '      if (false) {', 'the guardian is silent'),
  m('LV15 a verifier pages on its own failure to read', LV, '      return undefined; // unknown', '      return null; // unknown', 'cannot read the heartbeats'),
  m('LV16 check passes a host with no sink', R, '  else problems.push("no alert sink', '  else lines.push("no alert sink', 'no alert sink is NOT OK'),
  m('LV17 alert-test hides a failed sink', CL, '      return res.every((r) => r.ok) ? 0 : 1;', '      return 0;', 'alert-test'),
  m('LV19 an idle standby keeps an old failing streak', K, "      await trackLiveness(ctx, 'standby', true, null, cfg.keeper.failingAfterSec);\n      store.flush();\n", '', 'stood idle for days'),
  m('LV18 a standby standing in never reports', K, "  if (o.role === 'primary' ? due : rep.acted || (due && !blocked)) {", "  if (o.role === 'primary' ? due : rep.acted) {", 'standby standing in'),
  // ---------------------------------------------------------------- admin events (gap item 19)
  m('AE1 an unlisted launcher not paged', E, "        : { key, severity: 'page', title: 'An UNLISTED LAUNCHER", "        : { key, severity: 'info', title: 'An UNLISTED LAUNCHER", 'every ownership move are alerted'),
  m('AE2 the hook not scanned', E, '  if (live(o.hook)) await scan(o.hook,', '  if (false) await scan(o.hook,', 'every ownership move are alerted', 'the keeper raises the same admin alerts'),
  m('AE3 the registry not scanned', E, '  if (live(o.registry)) await scan(o.registry,', '  if (false) await scan(o.registry,', 'every ownership move are alerted', 'without config.policyOwner'),
  m('AE4 ownership moves not scanned', E, "[...FACTORY_EVENTS, ...OWNERSHIP_EVENTS], 'factory'", "FACTORY_EVENTS, 'factory'", 'every ownership move are alerted'),
  m('AE5 any new owner taken for the Safe', E, '  const isSafe = (x: unknown) => !!ctx.policyOwner && lc(x) === ctx.policyOwner;', '  const isSafe = (x: unknown) => true;', 'every ownership move are alerted', 'without config.policyOwner'),
  m('AE6 a platform recipient announcement only a warning', E, "      return { key, severity: 'page', title: 'A new PLATFORM RECIPIENT was announced", "      return { key, severity: 'warn', title: 'A new PLATFORM RECIPIENT was announced", 'every ownership move are alerted', 'the keeper raises the same admin alerts'),
  m('AE7 a platform fee announcement only a warning', E, "      return { key, severity: 'page', title: 'A new PLATFORM FEE was announced", "      return { key, severity: 'warn', title: 'A new PLATFORM FEE was announced", 'every ownership move are alerted'),
  m('AE8 a contract creation pages', E, "      if (lc(a.previousOwner) === ZERO) return { key, severity: 'info', title: `${name} was created`", "      if (false) return { key, severity: 'info', title: `${name} was created`", 'every ownership move are alerted', 'without config.policyOwner'),
  // ---------------------------------------------------------------- launches stuck in Waiting (gap item 18)
  m('GR1 Waiting never seen', GR, '      if (status === STATUS.Waiting) out.push(', '      if (false) out.push(', 'stuck in Waiting is graduated', 'completeGraduations off', 'would revert is never sent'),
  m('GR2 the lens read every tick', GR, '  if (Math.floor(ctx.now() / 1000) - last < cfg.keeper.graduationScanSec) return;', '', 'graduated by the keeper, once'),
  m('GR3 completeGraduations ignored', GR, '    if (!cfg.keeper.completeGraduations || !send) {', '    if (!send) {', 'completeGraduations off'),
  m('GR4 a reverting graduate() a failed tick', GR, '      if (!(e instanceof WouldRevert)) {', '      if (true) {', 'would revert is never sent'),
  m('GR5 only the first page read', GR, '    if (tokens.length < PAGE) break;', '    break;', 'paged 50 at a time'),
  m('GR6 the cursor not kept', GR, '      if (leading && status === STATUS.Graduated) cur.from = start + i + 1;', '      if (false) cur.from = start + i + 1;', 'paged 50 at a time'),
  m('GR7 the cursor jumps a Selling launch', GR, '      else leading = false;', '', 'paged 50 at a time'),
  m('GR9 a launch graduate() cannot move never noted ready', GR, '  if (since === 0n) {', '  if (false) {', 'noteReady is, once'),
  m('GR10 noted ready on every scan', GR, '  if (since === 0n) {', '  if (true) {', 'noteReady is, once', 'noted ready by someone else'),
  m('GR11 the rescue\'s opening not told', GR, '  return { text: `It was noted ready (Graduator.noteReady) at ${iso(since)}: the rescue is open to anyone from ${iso(since + RESCUE_DELAY_SEC)}.`, error: null };', "  return { text: '', error: null };", 'noteReady is, once', 'noted ready by someone else'),
  m('GR8 the keeper never runs the watch', K, '      await graduationWatch(ctx, latest.number,', '      void (ctx, latest.number,', 'stuck in Waiting is graduated', 'completeGraduations off'),
  // ---------------------------------------------------------------- the sharing block in step (gap item 14)
  m('CS1 a clashing config published anyway', K, '    if (clash.length) {\n      rep.ok = false;', '    if (false) {\n      rep.ok = false;', 'publishes NOTHING while its sharing block differs'),
  m('CS2 the published version file not compared', K, '        clash = diffSharingConfig(raw, cfg);', '        clash = [];', 'publishes NOTHING while its sharing block differs'),
  m('CS3 check passes a clashing config', R, "        if (d.length) problems.push(`this host's sharing block differs", "        if (d.length) lines.push(`this host's sharing block differs", 'check: NOT OK when the published config'),
  m('CS4 a mismatch without the config hint', V, '      out.problems.push(...(await configHint(deps, index.rules.version)));', '', "verifier's mismatch names the part"),
  m('CS5 a feed difference not seen', C, '      if (fa[q].quoteUsd !== fb[q].quoteUsd) out.push(', '      if (false) out.push(', 'diffSharingConfig names every difference', 'publishes NOTHING while', "verifier's mismatch names the part"),
  m('CS6 an exclusion reason not compared', C, '      else if (A.get(k) !== r) out.push(', '      else if (false) out.push(', 'diffSharingConfig names every difference'),
  // ---------------------------------------------------------------- check reads the wiring back (gap item 38)
  m('W1 a catalog that does not approve the factory passes', WR, '    if (ok === false) problems.push(', '    if (false) problems.push(', 'every swapped or missing link'),
  m('W2 a swapped address passes', WR, '    if (got !== want) problems.push(', '    if (false) problems.push(', 'every swapped or missing link'),
  m('W3 an unlisted launcher passes', WR, '      if (unlisted.length) problems.push(', '      if (false) problems.push(', 'every swapped or missing link'),
  m('W4 a listed launcher never admitted passes', WR, '      if (gone.length) problems.push(', '      if (false) problems.push(', 'every swapped or missing link'),
  m('W5 a foreign owner passes', WR, '      else problems.push(`${what} is owned by ${owner}', '      else lines.push(`${what} is owned by ${owner}', 'every swapped or missing link', 'the registry right after deploy'),
  m('W6 a handover waiting for the Safe refused', WR, '      if (pending === cfg.policyOwner) lines.push(', '      if (false) lines.push(', 'the registry right after deploy'),
  m("W7 a publisher key that is not the factory's passes", WR, '    if (keys.publisher && keys.publisher !== p) problems.push(', '    if (false) problems.push(', "this host's keys against their roles"),
  m('W8 check never reads the wiring', R, '  if (addressesOk) {\n    const w = await checkWiring', '  if (false) {\n    const w = await checkWiring', 'an honestly wired deployment', 'every swapped or missing link'),
  m('W9 the generator misses a buyback vault', FR, '    exclude(s.vault ?? undefined, `the BuybackVault for ${s.quote}`);', '', 'filled from a DeployCurb record'),
  m('W10 the generator changes a live block without --bump', FR, '    if (!o.bump) throw new RunError(', '    if (false) throw new RunError(', 'only with --bump'),
  m("W11 the generator guesses the Graduator's block", FR, "  set('sharing.graduatorFromBlock', grad.block.toString());", "  set('sharing.graduatorFromBlock', '0');", 'filled from a DeployCurb record'),
  m('W12 the generator says nothing of a quote asset without a feed', FR, '    decide.push(`sharing.feeds: no Chainlink feed', '    void (`sharing.feeds: no Chainlink feed', 'a stack whose quote asset has no feed'),
  // ---------------------------------------------------------------- a 6-decimal quote's dollar (USDC, 2026-10-15)
  m('K61 a dollar of USDC counted in 18 decimals', CV, '  const perUsd = q ? (10n ** dec * 10n ** BigInt(q.decimals))', '  const perUsd = q ? (10n ** 18n * 10n ** BigInt(q.decimals))', 'a USDC launch at live'),
  m("K62 the quote's own decimals left out of its dollar", CV, '  const perUsd = q ? (10n ** dec * 10n ** BigInt(q.decimals))', '  const perUsd = q ? (10n ** BigInt(q.decimals))', 'a USDC launch at live'),
  // ---------------------------------------------------------------- check --probe (gap item 16)
  m('PR1 a refused data-repo write passes', WP, '      problems.push(`probe: the data repo refused the write:', '      lines.push(`probe: the data repo refused the write:', 'names each broken link'),
  m('PR2 a pin under another CID passes', WP, '    } else problems.push(`probe: pin ${r.pinner} failed:', '    } else lines.push(`probe: pin ${r.pinner} failed:', 'names each broken link'),
  m('PR3 a pinner without its token not named', WP, "  for (const name of configured) if (!made.has(name)) problems.push(", '  for (const name of configured) if (false) problems.push(', 'names each broken link'),
  m('PR4 too few pins pass', WP, '  if (counted < cfg.ipfs.minPinned) problems.push(', '  if (false) problems.push(', 'names each broken link'),
  m('PR5 the site read-back not required', WP, "    else if (s === 'site') problems.push(", "    else if (false) problems.push(", 'names each broken link'),
  m('PR6 no gateway read-back required', WP, '  if (gws.length && !gws.some(([s]) => ok.has(s))) problems.push(', '  if (false) problems.push(', 'names each broken link'),
  m('PR7 the probe file left in the data repo', WP, '      if (cur) await ctx.repo.remove(', '      if (false) await ctx.repo.remove(', 'check --probe on an honest setup'),
  m('PR8 a failing sink passes', WP, '    else problems.push(`probe: alert sink ${d.sink} failed', '    else lines.push(`probe: alert sink ${d.sink} failed', 'names each broken link'),
  m('PR9 --probe ignored', CL, "      if (has(a, 'probe')) {", '      if (false) {', 'check --probe on an honest setup'),
  m('K53 files written before the lease', K, '  // files are writes too: not one before this keeper holds the lease\n  await act();', '', 'only while this keeper holds the lease'),
  m('U14 kubo asked for 1 MiB chunks', PI, 'chunker=size-262144', 'chunker=size-1048576', 'pinners'),
  m('U15 the CID with 1 MiB chunks', 'src/ops/cid.ts', 'export const CHUNK = 262_144;', 'export const CHUNK = 1_048_576;', 'real Kubo'),
  m('U16 the CID with unbounded links', 'src/ops/cid.ts', 'export const MAX_LINKS = 174;', 'export const MAX_LINKS = 1000;', 'real Kubo'),
  m('U17 the dag-pb link without its name', 'src/ops/cid.ts', '...lenField(1, c.cid), ...lenField(2, []), ...intField(3, c.tsize)', '...lenField(1, c.cid), ...intField(3, c.tsize)', 'real Kubo'),
  m('U18 the blocksizes left out', 'src/ops/cid.ts', ', ...children.flatMap((c) => intField(4, c.fileSize))];', '];', 'real Kubo'),
  m('U19 a link Tsize without the nodes below', 'src/ops/cid.ts', 'tsize: block.length + children.reduce((x, c) => x + c.tsize, 0), fileSize };', 'tsize: fileSize, fileSize };', 'real Kubo'),
  // ---------------------------------------------------------------- deployment files
  m('D1 the keeper workflow runs on pull requests', WK, 'on:\n  schedule:', 'on:\n  pull_request: {}\n  schedule:', 'sharing-keeper.yml: scheduled'),
  m('D2 an action pinned by tag', WK, 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', 'actions/checkout@v7', 'sharing-keeper.yml: scheduled'),
  m('D3 runs cancel each other', WK, 'cancel-in-progress: false', 'cancel-in-progress: true', 'sharing-keeper.yml: scheduled'),
  m('D4 a write token', WK, 'permissions:\n  contents: read', 'permissions:\n  contents: write', 'sharing-keeper.yml: scheduled'),
  m('D5 not the default branch only', WK, "    if: github.event_name == 'schedule' || github.ref == format('refs/heads/{0}', github.event.repository.default_branch)\n", '', 'sharing-keeper.yml: scheduled'),
  m('D21 the branch hard-coded again', WK, "github.ref == format('refs/heads/{0}', github.event.repository.default_branch)", "github.ref == 'refs/heads/main'", 'sharing-keeper.yml: scheduled'),
  m('D22 the keeper cache saved only on success', WK, "      - name: Save the keeper's /data\n        if: always()\n", "      - name: Save the keeper's /data\n", 'sharing-keeper.yml: /data is restored first and SAVED'),
  m('D23 the verifier cache saved only on success', WV, "      - name: Save the verifier's /data\n        if: always()\n", "      - name: Save the verifier's /data\n", 'sharing-verify.yml: /data is restored first and SAVED'),
  m("D25 the keeper's suite out of the gate", TA, '(cd services/sharer && npm ci --no-audit --no-fund && npm run check)', '(cd services/sharer && npm ci --no-audit --no-fund)', "test gate runs the keeper's suite"),
  m('D24 the combined cache action again', WV, 'uses: actions/cache/restore@', 'uses: actions/cache@', 'sharing-verify.yml: /data is restored first and SAVED'),
  m('D6 secrets outside the environment', WK, '    environment: sharing-mainnet\n', '', 'sharing-mainnet environment'),
  m('D7 the standby acts as a primary', WK, 'keeper --once --standby', 'keeper --once', 'standby flag'),
  m('D8 the verify workflow holds a key', WV, '          CURB_SHARER_RPC_URLS: ${{ secrets.SHARING_VERIFY_RPC_URLS }}', '          CURB_SHARER_RPC_URLS: ${{ secrets.SHARING_VERIFY_RPC_URLS }}\n          CURB_SHARER_PUBLISHER_KEY: ${{ secrets.SHARING_PUBLISHER_KEY }}', 'no key'),
  m('D9 the verify workflow runs on pull requests', WV, 'on:\n  schedule:', 'on:\n  pull_request: {}\n  schedule:', 'sharing-verify.yml: scheduled'),
  m('D10 the checkout keeps its token', WK, 'persist-credentials: false', 'persist-credentials: true', 'sharing-keeper.yml: scheduled'),
  m('D11 the image runs as root', DF, 'USER node\n', '', 'unprivileged user'),
  m('D12 no tini', DF, 'ENTRYPOINT ["/sbin/tini", "--", "node", "/app/src/cli.ts"]', 'ENTRYPOINT ["node", "/app/src/cli.ts"]', 'unprivileged user'),
  m('D13 an unpinned base image', DF, 'node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402', 'node:22-alpine', 'unprivileged user'),
  m('D14 no healthcheck', DF, 'HEALTHCHECK --interval=30s', '# HEALTHCHECK --interval=30s', 'unprivileged user'),
  m('D15 a writable root filesystem', DC, '  read_only: true', '  read_only: false', 'compose: read-only'),
  m('D16 capabilities kept', DC, '  cap_drop:\n    - ALL', '  cap_drop: []', 'compose: read-only'),
  m('D17 the verifier gets a key', DC, '        target: rpc_urls\n      - alert_webhooks', '        target: rpc_urls\n      - alert_webhooks\n      - pusher_key', 'compose: read-only'),
  m('D18 the verifier on the keeper providers', DC, '      - source: verifier_rpc_urls\n        target: rpc_urls', '      - rpc_urls', 'compose: read-only'),
  m('D19 one data volume for two services', DC, '      - verifier-data:/data', '      - keeper-data:/data', 'compose: read-only'),
  m('D20 secrets in the build context', DI, 'secrets\n', '', 'unprivileged user'),
];

function testFiles(all: boolean): string[] {
  return readdirSync(join(ROOT, 'test'))
    .filter((f) => f.endsWith('.test.ts') && (all ? f !== 'bundle.test.ts' : f.startsWith('ops-')))
    .sort()
    .map((f) => join('test', f));
}

function apply(mu: Mutant): { path: string; original: string } {
  const path = join(ROOT, mu.file);
  const original = readFileSync(path, 'utf8');
  const n = original.split(mu.find).length - 1;
  if (n !== 1) throw new Error(`${mu.id}: anchor found ${n} times in ${mu.file}`);
  return { path, original };
}

function run(all: boolean): { failed: string[]; ok: boolean } {
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-timeout=240000', ...testFiles(all)], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 900_000 });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  const failed = [...out.matchAll(/^\s*not ok \d+ - (.*)$/gm)].map((x) => x[1].trim());
  return { failed, ok: r.status === 0 };
}

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const all = args.includes('--all');
const onlyArg = args[args.indexOf('--only') + 1];
const only = args.includes('--only') ? new Set(onlyArg.split(',')) : null;
const outPath = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
const list = MUTANTS.filter((x) => !only || only.has(x.id.split(' ')[0]));

let bad = 0;
const problems: string[] = [];
for (const mu of list) {
  try {
    apply(mu);
  } catch (e) {
    problems.push((e as Error).message);
  }
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(2);
}
if (dry) {
  console.log(`${list.length} anchors, each found once`);
  process.exit(0);
}
const base = run(all);
if (!base.ok) {
  console.error('the suite fails without any mutant:\n' + base.failed.join('\n'));
  process.exit(2);
}
const report: { id: string; killed: boolean; rightReason: boolean; by: string[] }[] = [];
for (const mu of list) {
  const { path, original } = apply(mu);
  writeFileSync(path, original.replace(mu.find, mu.replace));
  let res;
  try {
    res = run(all);
  } finally {
    writeFileSync(path, original);
  }
  const by = res.failed;
  const killed = !res.ok;
  const rightReason = by.some((t) => mu.kill.some((k) => t.includes(k)));
  if (!killed || !rightReason) bad++;
  report.push({ id: mu.id, killed, rightReason, by });
  console.log(`${killed ? (rightReason ? 'KILLED  ' : 'WRONG   ') : 'SURVIVED'} ${mu.id}  <- ${by.slice(0, 3).join(' | ')}${by.length > 3 ? ` (+${by.length - 3})` : ''}`);
  if (outPath) writeFileSync(outPath, JSON.stringify(report, null, 2));
}
console.log(`${report.filter((x) => x.killed && x.rightReason).length}/${report.length} killed for the right reason`);
process.exitCode = bad ? 1 : 0;
