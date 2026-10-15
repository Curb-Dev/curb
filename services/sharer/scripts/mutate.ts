// Mutation pass over every guard in the sharer core: each mutant removes,
// inverts or weakens one check, the whole suite runs (except the bundle
// freshness test, which any source edit fails), and the mutant must be killed
// by one of the tests named for it - killed for the right reason.
//
//   node scripts/mutate.ts --dry            check every anchor is found exactly once
//   node scripts/mutate.ts [--only id,id]   run (about 10 s a mutant)
//   node scripts/mutate.ts --out report.json

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
  /** Substrings of test names; one of them failing is the right reason. */
  kill: string[];
}

const m = (id: string, file: string, find: string, replace: string, ...kill: string[]): Mutant => ({ id, file, find, replace, kill });
const S = 'src/calc/share.ts';
const V = 'src/calc/validate.ts';
const E = 'src/calc/encoding.ts';
const M = 'src/calc/merkle.ts';
const F = 'src/calc/file.ts';
const L = 'src/chain/logs.ts';
const R = 'src/chain/reader.ts';
const Q = 'src/chain/probe.ts';
const I = 'src/chain/indexer.ts';
const P = 'src/epoch.ts';
const ST = 'src/state.ts';
const SS = 'src/state-store.ts';
const off = (cond: string) => [cond, 'if (false)'] as const;

export const MUTANTS: Mutant[] = [
  // ---------------------------------------------------------------- the calculator
  m('S1 toBlock before fromBlock', S, 'if (T < F) fail(', 'if (false) fail(', 'malformed inputs'),
  m('S2 negative balance', S, 'if (nb < 0n) fail(', 'if (false) fail(', 'malformed inputs'),
  m('S3 negative income', S, "if (I0 < 0n || I1 < 0n) fail('received", "if (false) fail('received", 'malformed inputs'),
  m('S4 no-weight', S, "if (W === 0n) return { result: 'none'", "if (false) return { result: 'none'", 'v05', 'v10'),
  m('S5 no-income', S, "if (I0 === 0n && I1 === 0n) return { result: 'none'", "if (false) return { result: 'none'", 'v05'),
  m('S6 nothing-allocated', S, 'if (dH0 === 0n && dH1 === 0n && K === 0n) {', 'if (false) {', 'v05'),
  m('S7 keeper key filter', S, 'if (!keeperKeys.has(tx.from)) continue;', '', 'v07'),
  m('S8 keeper window floor', S, 'if (tx.block < F || tx.block > T) continue;', 'if (tx.block > T) continue;', 'v07', 'v09'),
  m('S9 keeper window ceiling', S, 'if (tx.block < F || tx.block > T) continue;', 'if (tx.block < F) continue;', 'v07', 'v09'),
  m('S10 factory call must name D', S, 'tx.names.includes(D)', 'true', 'v07'),
  m('S11 split among named', S, 'cost / BigInt(tx.names.length)', 'cost', 'v07'),
  m('S12 2% cap', S, 'let K = C < cap ? C : cap;', 'let K = C;', 'v07', 'random launch'),
  m('S13 re-cap', S, 'if (K * BPS > (dH0 + K) * MAX_KEEPER_FEE_BPS) {\n    K =', 'if (false) {\n    K =', 'v07', 'v11'),
  m('S14 re-cap denominator', S, '(BPS - MAX_KEEPER_FEE_BPS)', 'BPS', 'v11', 'v07'),
  m('S15 a pool on any factory is excluded', S, 'if (!E.has(a)) E.set(a, poolReason(setup, c));', 'if (c.factory !== null && setup.rules.ammFactories.has(c.factory) && !E.has(a)) E.set(a, poolReason(setup, c));', 'v04', 'v13'),
  m('S16 pool holds the token', S, 'if (c.token0 !== setup.launchToken && c.token1 !== setup.launchToken) continue;', '', 'v04'),
  m('S17 first reason wins for pools', S, 'if (!E.has(a)) E.set(a, poolReason(setup, c));', 'E.set(a, poolReason(setup, c));', 'v04', 'v13'),
  m('S18 excluded weight leaves W', S, 'if (E.has(a)) w.set(a, 0n);\n    else W += x;', 'W += x;', 'v04'),
  m('S19 a balance accrues from ts(b-1)', S, 'const at = tsOf(t.block - 1n);', 'const at = tsOf(t.block);', 'v01', 'v02'),
  m('S20 history before F earns nothing', S, 'if (t.block >= F) {', 'if (true) {', 'v03'),
  m('S21 earlier accounts stay listed', S, 'const listed = new Set<Address>(prevCum.keys());', 'const listed = new Set<Address>();', 'v06'),
  m('S22 one file however many rows', M, 'export const CHUNK_ACCOUNTS = 512;', 'export const CHUNK_ACCOUNTS = 1_000_000;', 'rotating', 'golden vector v14'),
  m('S23 a row without its balance', S, 'b: bal.get(a) ?? 0n });', 'b: 0n });', 'golden vector', 'stateAtEnd commits'),
  m('S24 supersedes', S, 'const supersedes = [...ctx.vetoedSinceActive];', 'const supersedes: bigint[] = [];', 'v09'),
  m('S25 prev link', S, 'prev: state ? { epoch: state.epoch', 'prev: null as any ? { epoch: state!.epoch', 'v06', 'v09'),
  m('S26 capped flag', S, 'capped: K !== C', 'capped: false', 'v07'),
  m('S27 the factory is excluded', S, "exclude(setup.factory, 'the distributor factory');", '', 'golden vector'),
  m('S28 zero price answer', S, "if (aE === 0n || aQ === 0n) return { source: 'none'", "if (false) return { source: 'none'", 'random launch'),
  m('S29 one missing feed', S, 'if (!e || !q) return', 'if (!e && !q) return', 'v08'),
  // the weight floor, listed accounts and the state commitment (CURB-SHARE v1 amended)
  m('S30 no weight floor', S, '  for (const [a, x] of w) if (x < floor) w.set(a, 0n);\n', '', 'golden vector v12', '1-wei spray'),
  m('S31 a row for every weight again', S, '  for (const [a, x] of s0) if (x > 0n || (s1.get(a) ?? 0n) > 0n) listed.add(a);', '  for (const [a, x] of w) if (x > 0n) listed.add(a);', 'golden vector v11', '1-wei spray'),
  m('S32 rows in the index past one chunk', F, '  if (rows.length > CHUNK_ACCOUNTS) {', '  if (false) {', 'rotating', 'golden vector v14'),
  m('S33 dust probed again', S, '  return [...r.w].filter(([, x]) => x > 0n).map(([a]) => a).sort(cmp);', '  return [...r.bal.keys(), ...r.w.keys()].filter((a, i, xs) => xs.indexOf(a) === i).sort(cmp);', 'spray costs no probe', 'golden vector v13'),

  // ---------------------------------------------------------------- input validation
  m('V1 sharingSince 0', V, "if (s.sharingSince === 0n) fail(", 'if (false) fail(', 'refused setups'),
  m('V2 opening before sharingSince', V, 'if (s.opening.block >= s.sharingSince) fail(', 'if (false) fail(', 'malformed inputs'),
  m('V3 timestamps backwards', V, 'if (t < lastT) fail(', 'if (false) fail(', 'malformed inputs'),
  m('V4 repeated (block, logIndex)', V, "      fail('two transfers share a (block, logIndex)');", '      void 0;', 'malformed inputs'),
  m('V5 transfer at or before opening', V, 'if (t.block <= s.opening.block) fail(', 'if (false) fail(', 'malformed inputs'),
  m('V6 canonical decimal', V, "!/^(0|[1-9][0-9]*)$/.test(x)", 'false', 'refused setups'),
  m('V7 address format', V, "!/^0x[0-9a-fA-F]{40}$/.test(x)) fail(`${what}: not an address", 'false) fail(`${what}: not an address', 'malformed inputs'),
  m('V8 quoteIsWeth boolean', V, "if (typeof s.quoteIsWeth !== 'boolean') fail(", 'if (false) fail(', 'refused setups'),
  m('V9 32-byte hash', V, "!/^0x[0-9a-fA-F]{64}$/.test(x)) fail(`${what}: not a 32-byte", 'false) fail(`${what}: not a 32-byte', 'refused setups'),
  m('V10 distinct names', V, 'names: [...new Set(((t.names', 'names: [...(((t.names', 'naming D twice'),

  // ---------------------------------------------------------------- encodings and tree
  m('E1 numbers refused', E, 'throw new Error(`canonical JSON: value of type', "return 'null'; throw new Error(`canonical JSON: value of type", 'canonicalJson refuses', 'encodings', 'the shape'),
  m('E2 keys sorted', E, 'const keys = Object.keys(o).sort();', 'const keys = Object.keys(o);', 'golden vector'),
  m('E3 uint256 range', E, 'if (n < 0n || n > MAX_UINT256) throw', 'if (false) throw', 'encodings'),
  m('E4 strict UTF-8', E, "new TextDecoder('utf-8', { fatal: true })", "new TextDecoder('utf-8')", 'the bytes'),
  m('M1 sorted pair', M, '(a <= b ? keccakHex(a.slice(2) + b.slice(2)) : keccakHex(b.slice(2) + a.slice(2)))', 'keccakHex(a.slice(2) + b.slice(2))', 'claim proof', 'within one chunk'),
  m('M2 account case', M, '  const want = account.toLowerCase();\n  const k = tree.chunkOf(want);', '  const want = account;\n  const k = tree.chunkOf(want);', 'claim proof'),
  m('M3 multiproof unknown account', M, 'if (missing) throw new Error(`no leaf for', 'if (false) throw new Error(`no leaf for', 'multiproof'),
  m('M4 a multiproof across chunks', M, 'if (ks.size > 1) throw new Error(', 'if (false) throw new Error(', 'past one chunk'),
  m('M5 a claim proof without the top', M, 'proof: [...t.proof(want), ...tree.topProof(k)] };', 'proof: [...t.proof(want)] };', 'past one chunk', "site's part"),
  m('M6 multiproof order', M, '    indices.sort((a, b) => b - a);', '    indices.sort((a, b) => a - b);', 'within one chunk'),
  m('M7 chunks of the index rebuilt', M, '      if (tree.root !== c.root) throw new Error(`chunk ${c.first}..${c.last} rebuilds to', '      if (false) throw new Error(`chunk ${c.first}..${c.last} rebuilds to', 'a chunk is the one', "site's part"),

  // ---------------------------------------------------------------- the epoch file check
  m('F1 on-chain contentHash', F, 'if (chain.contentHash !== undefined && contentHash !== chain.contentHash.toLowerCase())', 'if (false)', 'the bytes'),
  m('F2 canonical form', F, 'if (canonicalJson(j) !== text) fail(`${what} is not in canonical form`);', '', 'the bytes'),
  m('F3 schema', F, 'if (j.schema !== SCHEMA) fail(', 'if (false) fail(', 'the shape'),
  m('F4 exact keys', F, 'if (canonicalJson(got) !== canonicalJson(want)) fail(', 'if (false) fail(', 'the shape'),
  m('F5 lowercase', F, 'if (a !== x) fail(`${what}: not lowercase`);', '', 'the shape'),
  m('F6 distributor', F, ...off('if (chain.distributor !== undefined && D !== chain.distributor.toLowerCase())'), 'the chain'),
  m('F7 epoch', F, ...off('if (chain.epoch !== undefined && x.epoch !== chain.epoch)'), 'the chain'),
  m('F8 fromBlock', F, ...off('if (chain.fromBlock !== undefined && x.window.fromBlock !== chain.fromBlock)'), 'the chain'),
  m('F9 toBlock', F, ...off('if (chain.toBlock !== undefined && x.window.toBlock !== chain.toBlock)'), 'the chain'),
  m('F10 window order', F, 'if (x.window.fromBlock > x.window.toBlock) problems.push', 'if (false) problems.push', 'the chain'),
  m('F11 leafEncoding', F, ...off('if (x.merkle.leafEncoding !== LEAF_ENCODING)'), 'the shape'),
  m('F12 prev before epoch', F, 'if (x.prev && x.prev.epoch >= x.epoch) problems.push', 'if (false) problems.push', 'epoch numbering'),
  m('F13 supersedes', F, 'else if (canonicalJson(x.supersedes.map(String)) !== canonicalJson(wantSupersedes)) {', 'else if (false) {', 'epoch numbering'),
  m('F14 accounts sorted', F, ...off('if (!chunked && !ascending(rows.map((r) => r.a)))'), 'sorted lists'),
  m('F15 exclusions sorted', F, ...off('if (!ascending(x.rules.exclusions.map((e) => e.address)))'), 'sorted lists'),
  m('F16 keeperKeys sorted', F, ...off('if (!ascending(x.rules.keeperKeys))'), 'sorted lists'),
  m('F17 txs sorted', F, ...off('if (!ascending(x.keeper.txs.map((t) => t.hash)))'), 'sorted lists'),
  m('F18 the rows hold more than the state', F, 'if (balCount > st.count || balSum > st.supply) problems.push', 'if (false) problems.push', 'the state after T'),
  m('F19 negative income', F, 'if (I0 < 0n || I1 < 0n) problems.push', 'if (false) problems.push', 'income'),
  m('F20 share above cost', F, 'if (t.share > cost) problems.push', 'if (false) problems.push', 'keeper fee'),
  m('F21 weth price', F, ...off("if (x.keeper.price.source === 'weth' && x.keeper.price.value !== WAD)"), 'keeper fee'),
  m('F22 missing price', F, ...off("if (x.keeper.price.source === 'none' && x.keeper.price.value !== 0n)"), 'keeper fee'),
  m('F23 keeper cost', F, 'if (Cost !== x.keeper.cost) problems.push', 'if (false) problems.push', 'keeper fee'),
  m('F24 listed with nothing', F, 'if (r.cum0 === 0n && r.cum1 === 0n) problems.push(`account ${r.a} is listed with no cumulative value`);', '', 'listed accounts'),
  m('F25 excluded with weight', F, 'if (r.w !== 0n || r.s0 !== 0n || r.s1 !== 0n) problems.push(`excluded account', 'if (false) problems.push(`excluded account', 'listed accounts'),
  m('F26 s0 re-derived', F, 'if (r.s0 !== e0) problems.push', 'if (false) problems.push', 'shares are re-derived', 'verifier'),
  m('F27 s1 re-derived', F, 'if (r.s1 !== e1) problems.push', 'if (false) problems.push', 'shares are re-derived'),
  m('F28 re-cap re-derived', F, 'if (K * BPS > (dH0 + K) * MAX_KEEPER_FEE_BPS) K = (dH0', 'if (false) K = (dH0', 'passes verifyEpochFile', 'golden files pass'),
  m('F29 fee re-derived', F, 'if (x.keeper.fee !== K) problems.push', 'if (false) problems.push', 'keeper fee'),
  m('F30 capped re-derived', F, ...off('if (x.keeper.capped !== (x.keeper.fee !== x.keeper.cost))'), 'keeper fee'),
  m('F31 fee cap', F, 'if (x.keeper.fee * BPS > (dH0 + x.keeper.fee) * MAX_KEEPER_FEE_BPS) problems.push', 'if (false) problems.push', 'keeper fee'),
  m('F32 cum = previous + share', F, 'if (r.cum0 !== p[0] + r.s0 || r.cum1 !== p[1] + r.s1) problems.push', 'if (false) problems.push', 'predecessor'),
  m('F33 cum not below share', F, '} else if (!prev && (r.cum0 < r.s0 || r.cum1 < r.s1)) {', '} else if (false) {', 'leaves are the rows'),
  m('F34 no dropped leaf', F, 'for (const a of prevCumOf.keys()) if (covers(f, a) && !listed.has(a)) problems.push', 'for (const a of prevCumOf.keys()) if (false) problems.push', 'predecessor'),
  m('F35 a chunk sums to its index', F, '      if (s0 !== c.sum0 || s1 !== c.sum1) problems.push(', '      if (false) problems.push(', 'a chunk is the one'),
  m('F36 a chunk rebuilds to its root', F, '        if (t.root !== c.root) problems.push(', '        if (false) problems.push(', 'a chunk is the one'),
  m('F37 rebuilt root', F, 'if (root !== x.merkle.root) problems.push', 'if (false) problems.push', 'leaves are the rows'),
  m('F38 on-chain root', F, ...off('if (chain.merkleRoot !== undefined && x.merkle.root !== chain.merkleRoot.toLowerCase())'), 'the chain'),
  m('F39 sum asset 0', F, 'if (sum0 !== prevCum.h0 + dH0) problems.push', 'if (false) problems.push', 'leaves are the rows'),
  m('F40 sum asset 1', F, 'if (sum1 !== prevCum.h1 + dH1) problems.push', 'if (false) problems.push', 'leaves are the rows'),
  m('F41 allocates more than received', F, "if (totals.cumHolders0 + totals.cumKeeper0 > x.inputs.received0 || totals.cumHolders1 > x.inputs.received1) problems.push('allocates", "if (false) problems.push('allocates", 'income'),
  m('F42 on-chain h0', F, ...off('if (chain.cumHolders0 !== undefined && chain.cumHolders0 !== totals.cumHolders0)'), 'the chain'),
  m('F43 on-chain h1', F, ...off('if (chain.cumHolders1 !== undefined && chain.cumHolders1 !== totals.cumHolders1)'), 'the chain'),
  m('F44 on-chain k0', F, ...off('if (chain.cumKeeper0 !== undefined && chain.cumKeeper0 !== totals.cumKeeper0)'), 'the chain'),
  m('F45 prev names predecessor', F, ...off('if (x.prev === null || x.prev.epoch !== prev.epoch)'), 'predecessor'),
  m('F46 range continues', F, ...off('if (x.window.fromBlock !== prev.window.toBlock + 1n)'), 'predecessor'),
  m('F47 prevCum is predecessor totals', F, ...off('if (pt.h0 !== prevCum.h0 || pt.h1 !== prevCum.h1 || pt.k0 !== prevCum.k0)'), 'predecessor'),
  m('F48 the floor not re-derived', F, '  if (x.weights.floor !== floor) problems.push(', '  if (false) problems.push(', 'the weights'),
  m('F49 the root over the chunks', F, '    if (top !== x.merkle.root) problems.push(', '    if (false) problems.push(', 'a chunk is the one'),
  m('F50 a listed weight below the floor', F, '      if (r.w !== 0n && r.w < x.weights.floor) problems.push(', '      if (false) problems.push(', 'the weights'),
  m('F51 listed without a share', F, 'if (r.s0 === 0n && r.s1 === 0n && prevKnows(r.a) && !prevCumOf.has(r.a)) problems.push', 'if (false) problems.push', 'listed accounts'),
  // the chunked file (CURB-SHARE v1 amended: a bounded file however many accounts ever earned)
  m('F52 a missing chunk not listed', F, 'if (!parts.partial) problems.push(`chunk ${k} (', 'if (false) problems.push(`chunk ${k} (', 'checks with every chunk'),
  m('F53 chunk counts', F, '      if (lastOne ? c.count < 1n || c.count > C : c.count !== C) problems.push(', '      if (false) problems.push(', 'the layout'),
  m('F54 rows in the index past a chunk', F, '  } else if (BigInt(x.rows.length) > C) problems.push(', '  } else if (false) problems.push(', 'the layout'),
  m('F55 a chunk is the one its index hashes', F, '  if (h !== c.sha256) fail(', '  if (false) fail(', 'reading a chunked file', "site's part"),
  m('F56 a chunk of another epoch', F, 'if (uint(j.epoch, `chunk ${k}.epoch`) !== index.epoch) fail(', 'if (false) fail(', 'a chunk is the one'),
  m('F57 a chunked file read without its chunks', F, '  if (missing.length) throw new ChunksNeeded(index, missing);', '  if (missing.length) return fileOf(index, []);', 'reading a chunked file'),
  m('F58 more keeper txs than an epoch attributes', F, 'if (x.keeper.txs.length > MAX_KEEPER_TXS) problems.push(', 'if (false) problems.push(', 'more keeper transactions'),
  m('F59 chunks in address order', F, '      if (k > 0 && !(x.chunks[k - 1].last < c.first)) problems.push(', '      if (false) problems.push(', 'the layout'),
  m('F60 a part never resumes an epoch', F, "  if (f.parts) throw new InputError('the state an epoch leaves needs", "  if (false) throw new InputError('the state an epoch leaves needs", "site's part"),

  // ---------------------------------------------------------------- log windows
  m('L1 busy before size', L, "if (statuses.includes(429) || codes.includes(429) || /rate|too many requests|timeout|timed out/i.test(text)) return 'busy';", '', 'busy - rate limits'),
  m('L2 size refusals', L, 'codes.includes(-32005) ||', 'false &&', 'result-size refusals', 'viem-wrapped'),
  m('L3 size asked before range', L, '  if (codes.includes(-32005)', "  if (/range|too many blocks|limit exceeded/i.test(text)) return 'range';\n  if (codes.includes(-32005)", 'result-size refusals', 'grows back'),
  m('L4 range refusals', L, "if (/range|too many blocks|limit exceeded/i.test(text)) return 'range';", '', 'block-range refusals'),
  m('L5 busy gives up after tries', L, 'if (busy > o.tries) throw', 'if (busy > o.tries + 1) throw', 'busy refusal'),
  m('L6 backoff doubles', L, 'await o.sleep(o.backoffMs * 2 ** (busy - 1));', 'await o.sleep(o.backoffMs);', 'busy refusal'),
  m('L7 window halves', L, 'win.window = Math.max(o.min, Math.floor(span / 2));', 'win.window = Math.max(o.min, span - 1);', 'range ceiling holds'),
  m('L8 ceiling remembered', L, '      win.cap = win.window;\n', '', 'range ceiling holds'),
  m('L9 size ceiling flagged', L, "win.capIsSize = kind === 'size';", 'win.capIsSize = false;', 'grows back'),
  m('L10 only a size ceiling regrows', L, '} else if (win.capIsSize && ++win.served >= o.sizeRegrow && win.cap < o.max) {', '} else if (++win.served >= o.sizeRegrow && win.cap < o.max) {', 'range ceiling holds'),
  m('L11 window grows to the cap', L, 'win.window = Math.min(win.cap, win.window * 2);', 'win.window = win.window;', 'grows from its first size'),
  m('L12 smallest window is final', L, 'if (span <= o.min) throw', 'if (span < o.min) throw', 'smallest window'),
  m('L13 log inside window', L, 'if (b < cursor || b > end) throw', 'if (false) throw', 'answers are checked'),
  m('L14 log address asked for', L, "if (!addresses.has(String(l.address).toLowerCase())) throw", 'if (false) throw', 'answers are checked'),
  m('L15 removed log', L, 'if (l.removed === true) throw', 'if (false) throw', 'answers are checked'),
  m('L16 repeated log', L, 'if (BigInt(out[i].blockNumber) === BigInt(out[i - 1].blockNumber) && BigInt(out[i].logIndex) === BigInt(out[i - 1].logIndex)) {', 'if (false) {', 'answers are checked'),
  m('L17 answer is a list', L, "if (!Array.isArray(logs)) throw new Error('eth_getLogs answered something that is not a list');", '', 'answers are checked'),

  // ---------------------------------------------------------------- reader
  m('R1 429 and 5xx are transient', R, "if (cur.status === 429 || (typeof cur.status === 'number' && cur.status >= 500) || cur.code === 429) return true;", '', 'reader:'),
  m('R2 a revert is never transient', R, 'if (/revert/i.test(t)) return false;', '', 'reader:'),
  m('R3 transient retried', R, 'if (!isTransient(e) || attempt >= this.opts.tries) throw e;', 'throw e;', 'reader:'),
  m('R4 block number checked', R, 'if (h.number !== n) throw', 'if (false) throw', 'reader:'),
  m('R5 header hash required', R, 'if (!isHash(raw.hash) || !isHash(raw.parentHash)) throw', 'if (false) throw', 'reader refuses'),
  m('R6 tx hash checked', R, "if (lower(t.hash) !== hash.toLowerCase()) throw", 'if (false) throw', 'reader:'),
  m('R7 tx in a block', R, 'if (t.blockNumber == null) throw', 'if (false) throw', 'reader:'),
  m('R8 receipt hash checked', R, 'if (lower(r.transactionHash) !== hash.toLowerCase()) throw', 'if (false) throw', 'reader:'),
  m('R9 log timestamps agree', R, 'if (had !== undefined && had !== t) throw', 'if (false) throw', 'log timestamps'),
  m('R10 the probe answers at most what was asked', Q, 'if (n > BigInt(asked)) throw', 'if (false) throw', 'reader refuses'),
  m('R12 eth_call answer format', R, "if (typeof r !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(r)) throw", 'if (false) throw', 'reader:'),
  m('R13 the probe is sent from the zero address', R, '[{ from: PROBE_FROM, data: req.data, gas: hexOf(PROBE_REQUEST_GAS) }', '[{ data: req.data, gas: hexOf(PROBE_REQUEST_GAS) }', 'pinned gas'),
  m('R14 the probe is sent with its pinned gas', R, '[{ from: PROBE_FROM, data: req.data, gas: hexOf(PROBE_REQUEST_GAS) }', '[{ from: PROBE_FROM, data: req.data }', 'pinned gas'),
  m('R15 a request continues where the last one stopped', R, 'const req = probeRequest(calls, out.length);', 'const req = probeRequest(calls, 0);', 'continued from the first call'),
  m('R16 a request that answers nothing is an error', R, 'if (got.length === 0) throw', 'if (false) throw', 'reader refuses'),
  m('R17 the probe carries every call', R, 'while (out.length < calls.length) {', 'while (out.length < Math.min(calls.length, 1)) {', 'stops early is continued', 'thousand reverting', 'probe answers every call'),
  m('Q1 a call target is an address', Q, "if (typeof c.to !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(c.to)) throw", 'if (false) throw', 'cannot carry'),
  m('Q2 call data is hex bytes', Q, "if (typeof c.data !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(c.data)) throw", 'if (false) throw', 'cannot carry'),
  m('Q3 a call that cannot fit is refused', Q, 'if (22 + n > MAX_PACKED) throw', 'if (false) throw', 'cannot carry'),
  m('Q4 a request stays within EIP-3860', Q, 'if ((packed.length + one.length) / 2 > MAX_PACKED) break;', '', 'up to the initcode limit'),
  m('Q5 the length word is the packed length', Q, 'const len = (packed.length / 2).toString(16)', 'const len = (count).toString(16)', 'up to the initcode limit', 'pinned gas'),
  m('Q6 an answer is whole words', Q, "!/^0x([0-9a-fA-F]{64})+$/.test(raw)) throw", 'false) throw', 'reader refuses'),
  m('Q7 a header inside the answer', Q, 'if (at + 32 > total) throw', 'if (false) throw', 'reader refuses'),
  m('Q8 data inside the answer', Q, 'if (at + padded > total) throw', 'if (false) throw', 'reader refuses'),
  m('Q9 zero padding', Q, 'if (/[^0]/.test(hex.slice((at + c) * 2', 'if (false && /[^0]/.test(hex.slice((at + c) * 2', 'reader refuses'),
  m('Q10 nothing after the last answer', Q, 'if (at !== total) throw', 'if (false) throw', 'reader refuses'),
  m('Q11 an answer is at most 160 bytes', Q, 'const c = size > BigInt(PROBE_RETURN_CAP) ? PROBE_RETURN_CAP : Number(size);', 'const c = Number(size);', 'reads back'),
  m('Q12 the success bit', Q, 'const success = h >> 255n === 1n;', 'const success = h !== 0n;', 'reads back'),
  m('R18 an unmined transaction is none', R, 'if (!t || t.blockNumber == null) return null;', 'if (!t) return null;', 'not mined is not counted'),
  m('R19 an unknown transaction is none', R, 'if (!t || t.blockNumber == null) return null;', 'if (t.blockNumber == null) return null;', 'never landed'),

  // ---------------------------------------------------------------- indexer
  m('I1 switch block', I, 'if (s.sinceBlock !== s.block) throw', 'if (false) throw', 'discoverSharing'),
  m('I2 token switched twice', I, 'if (tokens.has(s.token)) throw', 'if (false) throw', 'discoverSharing'),
  m('I3 distributor bound twice', I, 'if (ds.has(s.distributor)) throw', 'if (false) throw', 'discoverSharing'),
  m('I4 record length', I, 'if (words < 11) throw', 'if (false) throw', 'readLaunchRecord'),
  m('I5 record address words', I, 'if (v >> 160n) throw new IndexerError(`launchOf word', 'if (false) throw new IndexerError(`launchOf word', 'readLaunchRecord'),
  m('I6 launchedAt uint64', I, 'if (launchedAt >> 64n) throw', 'if (false) throw', 'uint64'),
  m('I7 distributor names the graduator', I, 'if (dGrad !== G) throw', 'if (false) throw', 'readLaunchMeta refuses'),
  m('I8 switch points at D', I, 'if (bound !== D) throw', 'if (false) throw', 'switch that does not point'),
  m('I9 sharingSince non-zero', I, 'if (since === 0n) throw', 'if (false) throw', 'readLaunchMeta refuses'),
  m('I10 token registered', I, 'if (rec.curve === ZERO) throw', 'if (false) throw', 'readLaunchMeta refuses'),
  m('I11 quote agrees', I, 'if (rec.quoteToken !== quote) throw', 'if (false) throw', 'readLaunchMeta refuses'),
  m('I12 no lock is null', I, 'lock: lock === ZERO ? null : lock,', 'lock: lock,', 'readLaunchMeta refuses'),
  m('I13 lock only once graduated', I, 'if (m.lock) out.push', 'out.push', 'launchExclusions'),
  m('I14 not this distributor', I, 'if (d !== m.distributor) out.push', 'out.push', 'launchExclusions'),
  m('I15 launchedAt reachable', I, 'if ((await r.block(hi)).timestamp < launchedAt) throw', 'if (false) throw', 'findLaunchBlock'),
  m('I16 first block at or after', I, 'if ((await r.block(mid)).timestamp >= launchedAt) b = mid;', 'if ((await r.block(mid)).timestamp > launchedAt) b = mid;', 'findLaunchBlock', 'bisection'),
  m('I17 registry log confirms', I, 'if (logs.length !== 1) throw', 'if (false) throw', 'findLaunchBlock', 'bisection'),
  m('I18 ERC-20 shaped', I, "if (l.topics.length !== 3 || !/^0x[0-9a-fA-F]{64}$/.test(l.data)) throw", 'if (false) throw', 'ERC-20 shaped'),
  m('I19 an answer is a word', I, 'if (!ok || data.length < 66) return null;', 'if (!ok) return null;', 'probeAccounts'),
  m('I20 an answer is an address', I, '  if (v >> 160n) return null;\n', '', 'probeAccounts'),
  m('I21 one token answer is enough', I, 'if (token0 || token1) contracts.set', 'if (token0 && token1 && factory) contracts.set', 'probeAccounts'),
  m('I22 isExcluded must answer', I, 'if (!x.success) throw', 'if (false) throw', 'probeAccounts'),
  m('I23 names distinct', I, "if (d.functionName === 'publishMany') return [...new Set((d.args[0] as string[]).map(lc))];", "if (d.functionName === 'publishMany') return (d.args[0] as string[]).map(lc);", 'namesOf'),
  m('I24 publish names one', I, "if (d.functionName === 'publish') return [lc(d.args[0] as string)];", '', 'namesOf'),
  m('I25 answer must be positive', I, 'if (answer <= 0n) return null;', 'if (answer < 0n) return null;', 'readPrice'),
  m('I26 a failed feed is missing', I, 'if (!rd.success || !dec.success || rd.returnData.length < 2 + 64 * 5 || dec.returnData.length < 66) return null;', '', 'readPrice'),
  m('I27 tx and receipt in one block', I, 'if (rc.blockNumber !== tx.blockNumber) throw', 'if (false) throw', 'reader refuses'),
  m('I28 a creation is no keeper tx', I, '    if (tx.to === null) continue;\n', '', 'contract creation'),
  m('I29 a named hash may be unknown', I, 'const tx = logged.has(h) ? await r.tx(h) : await r.minedTx(h);', 'const tx = await r.tx(h);', 'never landed', 'not mined is not counted'),
  m('I30 a named hash after T is not counted', I, 'if (tx === null || tx.blockNumber > T) continue;', 'if (tx === null) continue;', 'never landed'),
  m('I31 a logged hash must be known', I, 'const tx = logged.has(h) ? await r.tx(h) : await r.minedTx(h);', 'const tx = await r.minedTx(h);', 'logged from the distributor in the window must be known'),
  m('I32 a send before F asked for and kept', I, '    if (tx.blockNumber < F) continue;\n', '', 'mined before F'),

  // ---------------------------------------------------------------- the epoch pipeline
  m('P1 chain id', P, 'if (chainId !== config.chainId) throw', 'if (false) throw', 'wrong chain'),
  m('P2 harvest succeeded', P, "if (!rc.status) throw new EpochNotReady('bad-harvest'", "if (false) throw new EpochNotReady('bad-harvest'", 'not a harvest'),
  m('P3 harvest sent to D', P, "if (rc.to !== D) throw new EpochNotReady('bad-harvest'", "if (false) throw new EpochNotReady('bad-harvest'", 'not a harvest'),
  m('P4 T at or below safe', P, "if (T > safe.number) throw new EpochNotReady('not-safe'", "if (false) throw new EpochNotReady('not-safe'", 'safe head'),
  m('P5 receipt on the canonical block', P, 'if (hT.hash !== rc.blockHash) throw', 'if (false) throw', 'another fork'),
  m('P6 no pending root', P, "if (st.pending.payableAt !== 0n) throw", 'if (false) throw', 'pending'),
  m('P7 no prev before the first epoch', P, "if (prev) throw new EpochNotReady('stale-prev', `a previous state", "if (false) throw new EpochNotReady('stale-prev', `a previous state", 'previous state must be'),
  m('P8 prev needed after it', P, "if (!prev) throw new EpochNotReady('stale-prev', `${D} has active", "if (false) throw new EpochNotReady('stale-prev', `${D} has active", 'previous state must be'),
  m('P9 prev is the active root', P, 'if (prev.epoch !== a.epoch || prev.contentHash !== a.contentHash || prev.toBlock !== a.toBlock) {', 'if (prev.epoch !== a.epoch) {', 'previous state must be'),
  m('P10 prev totals', P, 'if (prev.totals.h0 !== a.cumHolders0 || prev.totals.h1 !== a.cumHolders1 || prev.totals.k0 !== a.cumKeeper0) {', 'if (false) {', 'previous state must be'),
  m('P11 vetoed numbers', P, 'n <= st.lastProposedEpoch; n++', 'n < st.lastProposedEpoch; n++', 'v09'),
  m('P12 launchedAt required', P, 'if (meta.launchedAt === null) throw', 'if (false) throw', 'bisection'),
  m('P13 opening is the block before', P, 'return { block: launchBlock - 1n,', 'return { block: launchBlock,', 'bisection'),
  m('P14 quote is WETH', P, 'const quoteIsWeth = meta.quoteToken === config.weth.toLowerCase();', 'const quoteIsWeth = true;', 'v03', 'v08'),
  m('P15 first window starts at sharingSince', P, 'const F = prev ? prev.toBlock + 1n : meta.sharingSince;', 'const F = prev ? prev.toBlock + 1n : meta.sharingSince - 1n;', 'v01', 'pipeline'),
  m('P16 isExcluded hits excluded', P, 'exclusionsAdded: probed.excludedOnChain.map(', 'exclusionsAdded: [].map(', "isExcluded names"),
  m('P17 two providers required', P, 'if (readers.length < 2 && !opts.allowSingleProvider) throw', 'if (false) throw', 'one provider'),
  m('P18 disagreement aborts', P, 'if (parts.length) throw new ProviderDisagreement', 'if (false) throw new ProviderDisagreement', 'two providers'),
  m('P19 compare hash at T', P, '    blockHashAtT: g.blockHashAtT,\n', '', 'block hash at T'),
  m('P20 compare transfer digest', P, "    'transfers.digest': transfersDigest(s.transfers),\n", '', 'digest alone'),
  m('P21 compare timestamps', P, '    timestamps: canonicalJson(m(s.timestamps)),\n', '', 'another timestamp'),
  m('P22 compare pools', P, '    pools: canonicalJson(', '    _pools: (', 'pool answer'),
  m('P23 compare isExcluded', P, '    excludedOnChain: canonicalJson(g.input.exclusionsAdded),\n', '', 'distributor exclusions'),
  m('P24 compare keeper txs', P, '    keeperTxs: canonicalJson(s.keeperTxs.map((t) => ({ ...t }))),\n', '', 'keeper receipt'),
  m('P25 compare price', P, '    price: canonicalJson(g.input.price),\n', '', 'price answer'),
  m('P26 recompute compares bytes', P, "if (!bytesEqual(r.fileBytes, fileBytes)) problems.push", 'if (false) problems.push', 'verifier recomputes'),
  m('P27 recompute uses the listed keeper txs', P, 'extraKeeperTxs: f.keeper.txs.map((t) => t.hash),', 'extraKeeperTxs: [],', 'logged nothing'),
  m('P28 the epoch reads the checked config', P, 'const config = checkConfig(given);', 'const config = given;', 'refused before anything is read'),
  m('P29 feed keys in any case', P, 'if (k.toLowerCase() !== q) continue;', 'if (k !== q) continue;', 'checksummed quote address', 'named twice'),
  m('P30 a quote named twice', P, 'if (hit) throw new InputError(', 'if (false) throw new InputError(', 'named twice'),
  m('P31 feeds checked at load', P, 'feeds[q] = { ethUsd: addr(v?.ethUsd, `feeds[${q}].ethUsd`), quoteUsd: addr(v?.quoteUsd, `feeds[${q}].quoteUsd`) };', 'feeds[q] = { ethUsd: v.ethUsd, quoteUsd: v.quoteUsd };', 'refused before anything is read'),
  m('P32 feed keys checked at load', P, "const q = addr(k, 'feeds key');", 'const q = k.toLowerCase();', 'refused before anything is read'),
  m('P33 a quote named twice at load', P, 'if (Object.hasOwn(feeds, q)) throw new InputError(', 'if (false) throw new InputError(', 'refused before anything is read'),
  m('P34 the checked config is lowercase', P, '    return x.toLowerCase();\n  };', '    return x;\n  };', 'refused before anything is read'),
  m('P35 the Graduator checked at load', P, "graduator: addr(config.graduator, 'graduator'),", 'graduator: config.graduator,', 'refused before anything is read'),
  m('P36 the keeper keys checked at load', P, 'keeperKeys: r.keeperKeys.map((k, i) => addr(k, `rules.keeperKeys[${i}]`)),', 'keeperKeys: r.keeperKeys,', 'refused before anything is read'),
  m('P37 the AMM factories checked at load', P, 'ammFactories: r.ammFactories.map((x, i) => ({ address: addr(x.address, `rules.ammFactories[${i}]`), reason: x.reason })),', 'ammFactories: r.ammFactories,', 'refused before anything is read'),
  m('P38 a rebuilt state not checked against the file', P, '  if (c.digest !== w.digest || c.count !== w.count || c.supply !== w.supply) {', '  if (false) {', 'rebuilt state that is not'),
  m('P39 the state cache ignores the commitment', SS, '    if (e && same(e.commitment, want)) {', '    if (e) {', 'state cache'),
  m('P40 a rebuilt state not cached', P, '  cache?.put(chainId, token, prev.toBlock, balances, c);\n', '', 'state cache'),
  m('P41 the journal not filtered by F', P, "      if (e.done?.hash && typeof b === 'string' && /^(0|[1-9][0-9]*)$/.test(b) && BigInt(b) < F) continue;\n", '', 'can lie in the window', 'given as the journal'),
  m('P42 the journal ignored by the request', P, '...(req.keeperJournal ? keeperJournalHashes(req.keeperJournal, D, F) : [])', '', 'given as the journal', 'reverted (so logged nothing)'),
  // complete states on disk, one rebuild at a time, a check given up on stops (N3, N4)
  m('P43 a state read back from disk not checked', SS, '    if (!got || !same(commitState(got.balances).commitment, want)) {', '    if (!got) {', 'not exactly the committed'),
  m('P44 no state written to disk', SS, '    if (!p) return;\n    try {', '    if (!p || true) return;\n    try {', 'read back from disk'),
  m('P45 one cap over every launch', SS, '      if (this.entries.size <= 1 || this.held <= this.maxBalances) break;', '      if (this.entries.size <= 1 || (this.held <= this.maxBalances && this.entries.size <= 64)) break;', 'kept per launch'),
  m('P46 a rebuild per caller', P, '  return cache ? cache.once(chainId, token, prev.toBlock, prev.stateAtEnd, rebuild) : rebuild();', '  return rebuild();', 'one rebuild at a time'),
  m('P47 the replay ignores the signal', P, '      const logs = await replayTransfers(r, token, a, b);\n      signal?.throwIfAborted();', '      const logs = await replayTransfers(r, token, a, b);', 'aborted signal'),
  m('P48 the signal not passed on', P, 'gatherEpoch(r, config, req, cache, { signal: opts.signal, rebuildStepBlocks: opts.rebuildStepBlocks })', 'gatherEpoch(r, config, req, cache, { rebuildStepBlocks: opts.rebuildStepBlocks })', 'aborted signal'),
  m('P49 the recompute looks up any number of keeper txs', P, '  if (f.keeper.txs.length > MAX_KEEPER_TXS) throw new InputError(', '  if (false) throw new InputError(', 'more keeper transactions'),
  m('S34 any number of keeper txs attributed', S, '  if (txs.length > MAX_KEEPER_TXS) txs.length = MAX_KEEPER_TXS;', '', 'at most 512 keeper'),

  // ---------------------------------------------------------------- restart
  m('ST1 no active epoch, no state', ST, "if (st.active.epoch === 0n) return", 'if (false) return', 'no state to load'),
  m('ST2 one publish event', ST, 'if (ev.length !== 1) throw', 'if (false) throw', 'stateless restart'),
  m('ST3 event is the active root', ST, 'if (p.contentHash !== st.active.contentHash || p.merkleRoot !== st.active.merkleRoot) throw', 'if (false) throw', 'stateless restart'),
  m('ST4 the file must check', ST, 'if (!check.ok || !check.file) throw', 'if (!check.file) throw', 'stateless restart'),
];

function testFiles(): string[] {
  return readdirSync(join(ROOT, 'test'))
    .filter((f) => f.endsWith('.test.ts') && f !== 'bundle.test.ts')
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

function run(): { failed: string[]; ok: boolean; out: string } {
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-timeout=300000', ...testFiles()], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  const failed = [...out.matchAll(/^not ok \d+ - (.*)$/gm)].map((x) => x[1].trim());
  return { failed, ok: r.status === 0, out };
}

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const onlyArg = args[args.indexOf('--only') + 1];
const only = args.includes('--only') ? new Set(onlyArg.split(',')) : null;
const outPath = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
const list = MUTANTS.filter((x) => !only || only.has(x.id.split(' ')[0]));

let bad = 0;
const lost: string[] = [];
for (const mu of list) {
  try {
    apply(mu);
  } catch (e) {
    lost.push((e as Error).message);
  }
}
if (lost.length) {
  console.error(lost.join('\n'));
  process.exit(2);
}
if (dry) {
  console.log(`${list.length} anchors, each found once`);
  process.exit(0);
}
const base = run();
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
    res = run();
  } finally {
    writeFileSync(path, original);
  }
  const by = res.failed;
  const killed = !res.ok;
  const rightReason = by.some((t) => mu.kill.some((k) => t.includes(k)));
  if (!killed || !rightReason) bad++;
  report.push({ id: mu.id, killed, rightReason, by });
  console.log(`${killed ? (rightReason ? 'KILLED  ' : 'WRONG   ') : 'SURVIVED'} ${mu.id}  <- ${by.slice(0, 3).join(' | ')}${by.length > 3 ? ` (+${by.length - 3})` : ''}`);
}
console.log(`${report.filter((x) => x.killed && x.rightReason).length}/${report.length} killed for the right reason`);
if (outPath) writeFileSync(outPath, JSON.stringify(report, null, 2));
process.exitCode = bad ? 1 : 0;
