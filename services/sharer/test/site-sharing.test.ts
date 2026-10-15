// The site's reading of epoch files (web/sharing.js), run where only a
// browser's globals exist, against the browser bundle and a fake site: a
// file of at most 512 accounts read whole, a chunked one read one holder's
// chunk at a time, the verify panel's check of each, and the chunk the site
// serves wrong. (The pages around it are covered by web/e2e/sharing.spec.js.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { BUNDLE } from '../scripts/bundle.ts';
import { loadVector, readVectorChunks, readVectorFile, ROOT } from './helpers.ts';

const WEB = join(ROOT, '..', '..', 'web');
const S = await import(pathToFileURL(BUNDLE).href);
const v = loadVector('v14-chunked-file');
const [x1, x2] = [v.epochs[0].expected, v.epochs[1].expected];
const i1 = readVectorFile(x1.file)!;
const i2 = readVectorFile(x2.file)!;
const chunks = readVectorChunks(x2);
const D: string = v.setup.distributor.toLowerCase();
const holder = (n: number) => '0xc0' + n.toString(16).padStart(38, '0');
const index2 = S.parseEpochIndex(i2);
/** A value made in the sandbox, as this realm's own (for deepEqual). */
const own = <X>(x: X): X => structuredClone(x);

/** web/sharing.js loaded in a sandbox with a site that serves `routes`. */
function site(routes: Map<string, Uint8Array>) {
  const asked: string[] = [];
  const sandbox: any = {
    console,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    Blob,
    Response,
    URLSearchParams,
    crypto: globalThis.crypto,
    DecompressionStream: (globalThis as any).DecompressionStream,
    document: { getElementById: () => null },
    location: { origin: 'http://site.test' },
    fetch: async (u: unknown) => {
      asked.push(String(u));
      const b = routes.get(String(u));
      return b ? new Response(new Uint8Array(b) as unknown as BodyInit) : new Response('not found', { status: 404 });
    },
    __bundle: () => Promise.resolve(S),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ['abi.js', 'keccak.js']) vm.runInContext(readFileSync(join(WEB, f), 'utf8'), sandbox, { filename: f });
  const src = readFileSync(join(WEB, 'sharing.js'), 'utf8');
  assert.equal(src.split('import(BUNDLE)').length, 2, 'the bundle is imported in one place');
  vm.runInContext(src.replace('import(BUNDLE)', '__bundle()'), sandbox, { filename: 'sharing.js' });
  return { Sh: sandbox.CurbSharing, asked };
}

const filePath = (n: number) => `/sharing/8453/${D}/${n}.json`;
const chunkUrl = (k: number) => '/' + S.chunkPath(8453n, D, index2.chunks[k].sha256);
const served = () =>
  new Map<string, Uint8Array>([
    [filePath(1), i1],
    [filePath(2), i2],
    ...chunks.map((b, k) => [chunkUrl(k), b] as [string, Uint8Array]),
  ]);
const rootOf = (x: any) => ({ epoch: Number(x.epoch), contentHash: x.contentHash, merkleRoot: x.merkleRoot, cumHolders0: BigInt(x.cumHolders0), cumHolders1: BigInt(x.cumHolders1), cumKeeper0: BigInt(x.cumKeeper0), fromBlock: BigInt(x.fromBlock), toBlock: BigInt(x.toBlock) });

test('a holder of a chunked file: the page reads the index and that holder\'s chunk, and nothing else', async () => {
  const { Sh, asked } = site(served());
  const got = await Sh.loadFile({ chainId: 8453, d: D, epoch: 2, contentHash: x2.contentHash, uri: '' });
  assert.equal(got.ok, true);
  const f = await Sh.parsedFile(got.bytes, { account: holder(1040) });
  assert.deepEqual(f.parts, [2]);
  assert.deepEqual(asked, [filePath(2), chunkUrl(2)], 'the index and the one chunk');
  const leaf = Sh.leafOf(f, holder(1040));
  const row = Sh.rowOf(f, holder(1040));
  assert.ok(leaf.cum0 > 0n && row.cum0 === leaf.cum0);
  // its proof proves against the on-chain root
  const p = S.proofOf(S.treeOf(f), holder(1040));
  assert.ok(S.verifyProof(x2.merkleRoot, S.leafHash(D, holder(1040), p.cum0, p.cum1), p.proof));
  // no account: the index alone, no rows
  const none = await Sh.parsedFile(got.bytes);
  assert.deepEqual(none.parts, []);
  assert.equal(none.merkle.leaves.length, 0);
  // an account in no chunk's range has no leaf
  const out = await Sh.parsedFile(got.bytes, { account: '0x' + 'f'.repeat(40) });
  assert.deepEqual(own(Sh.leafOf(out, '0x' + 'f'.repeat(40))), { cum0: 0n, cum1: 0n });
  assert.equal(asked.length, 2, 'still nothing more fetched');
  // a file of at most 512 accounts is read whole
  const one = await Sh.parsedFile((await Sh.loadFile({ chainId: 8453, d: D, epoch: 1, contentHash: x1.contentHash, uri: '' })).bytes, { account: holder(50) });
  assert.equal(one.parts, undefined);
  assert.equal(one.accounts.length, 10);
});

test('the verify panel on a chunked file checks the index and the holder\'s chunk, and says so', async () => {
  const { Sh } = site(served());
  const res = await Sh.checkEpoch({ chainId: 8453 }, { d: D }, rootOf(x2), '', holder(700));
  assert.deepEqual(own(res.problems), [], JSON.stringify(res.problems));
  assert.equal(res.ok, true);
  const steps = Object.fromEntries(res.steps.map((s: any) => [s.key, s]));
  assert.deepEqual(Object.keys(steps), ['fetch', 'hash', 'chunk', 'root', 'totals', 'leaf', 'prev']);
  for (const s of res.steps) assert.ok(s.ok, `${s.key}: ${s.text}`);
  assert.match(steps.chunk.text, /chunk 2 of 3/);
  assert.match(steps.totals.text, /chunks' sums add up to the on-chain totals/);
  assert.match(steps.prev.text, /Checked against epoch 1's file/);
  assert.equal(res.mine.verified, true);
  // without an account, the first chunk
  const anon = await Sh.checkEpoch({ chainId: 8453 }, { d: D }, rootOf(x2), '', null);
  assert.equal(anon.ok, true, JSON.stringify(anon.problems));
  assert.match(anon.steps.find((s: any) => s.key === 'chunk').text, /chunk 1 of 3/);
  // the site serves another chunk's bytes at that chunk's path: not taken
  const wrong = served();
  wrong.set(chunkUrl(1), chunks[0]);
  const bad = await site(wrong).Sh.checkEpoch({ chainId: 8453 }, { d: D }, rootOf(x2), '', holder(700));
  assert.equal(bad.ok, false);
  assert.equal(bad.steps.find((s: any) => s.key === 'chunk').ok, false);
  assert.ok(bad.problems.some((p: string) => /chunk 2 could not be fetched/.test(p)));
});

test('the verify panel on a file of at most 512 accounts is the check it always was', async () => {
  const { Sh } = site(served());
  const res = await Sh.checkEpoch({ chainId: 8453 }, { d: D }, rootOf(x1), '', holder(50));
  assert.equal(res.ok, true, JSON.stringify(res.problems));
  assert.deepEqual(own(res.steps.map((s: any) => s.key)), ['fetch', 'hash', 'root', 'totals', 'leaf', 'prev']);
  assert.match(res.steps.find((s: any) => s.key === 'totals').text, /^The leaves sum to the on-chain totals/);
  // a changed share is a problem, and the hash no longer matches
  const text = new TextDecoder().decode(i1).replace(/"s0":"100000"/, '"s0":"100001"');
  const tampered = served();
  tampered.set(filePath(1), new TextEncoder().encode(text));
  const bad = await site(tampered).Sh.checkEpoch({ chainId: 8453 }, { d: D }, rootOf(x1), '', holder(50));
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((p: string) => /s0 100001 is not/.test(p)));
});
