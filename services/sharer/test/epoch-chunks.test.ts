// Reading a chunked epoch file through the service's file sources
// (src/epoch-chunks.ts): each chunk from the cache, the site or a gateway,
// used only when it hashes to what its index gives.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, parseEpochFile, parseEpochIndex, chunkCid, chunkPath } from '../src/calc/index.ts';
import { chunkFetcher, isChunked, readWholeEpoch } from '../src/epoch-chunks.ts';
import { EpochFiles } from '../src/ops/files.ts';
import { Store } from '../src/ops/store.ts';
import { loadVector, readVectorChunks, readVectorFile } from './helpers.ts';

const v = loadVector('v14-chunked-file');
const x = v.epochs[1].expected;
const indexBytes = readVectorFile(x.file)!;
const chunks = readVectorChunks(x);
const index = parseEpochIndex(indexBytes);
const D = index.distributor;
const SITE = 'https://site.example';
const GW = 'https://gw.example';

/** A network that serves `routes` (url -> bytes) and 404s the rest, and counts what it is asked. */
function net(routes: Map<string, Uint8Array>) {
  const asked: string[] = [];
  const fetch = (async (u: string | URL | Request) => {
    const url = String(u);
    asked.push(url);
    const b = routes.get(url);
    return b ? new Response(new Uint8Array(b) as unknown as BodyInit, { status: 200 }) : new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, asked };
}

const site = (k: number) => `${SITE}/${chunkPath(8453n, D, index.chunks[k].sha256)}`;
const gw = (k: number) => `${GW}/ipfs/${chunkCid(index.chunks[k])}`;

test('a whole file: each chunk from the site, else a gateway, each checked by its hash, then from the cache', async () => {
  const wrong = new TextEncoder().encode('{"not":"it"}');
  const { fetch, asked } = net(
    new Map([
      [site(0), chunks[0]],
      [gw(1), chunks[1]],
      [site(2), wrong],
      [gw(2), chunks[2]],
    ]),
  );
  const files = new EpochFiles({ chainId: 8453n, store: new Store(null), siteBase: SITE, gateways: [GW], http: { fetch, tries: 1 } });
  assert.equal(isChunked(indexBytes), true);
  const got = await readWholeEpoch(files, D, indexBytes);
  assert.equal(canonicalJson(got.file), canonicalJson(parseEpochFile(indexBytes, chunks)));
  assert.equal(got.file.accounts.length, 1100);
  assert.deepEqual(asked, [site(0), site(1), gw(1), site(2), gw(2)]);
  // checked copies are kept by their hash: a second read asks nothing
  await readWholeEpoch(files, D, indexBytes);
  assert.equal(asked.length, 5);
});

test('a chunk nowhere, or only wrong copies of it: the read fails naming it; a deadline stops it', async () => {
  const { fetch } = net(new Map([[site(0), chunks[0]], [site(1), chunks[2]]]));
  const files = new EpochFiles({ chainId: 8453n, store: new Store(null), siteBase: SITE, gateways: [GW], http: { fetch, tries: 1 } });
  await assert.rejects(readWholeEpoch(files, D, indexBytes), new RegExp(`no copy of the chunk ${index.chunks[1].first} to ${index.chunks[1].last} .* hashes to ${index.chunks[1].sha256}`));
  const ctl = new AbortController();
  ctl.abort(new Error('the deadline passed'));
  await assert.rejects(chunkFetcher(files, D, ctl.signal)(index.chunks[2]), /the deadline passed/);
  // a file whose rows are in its index needs no chunk
  const one = readVectorFile(v.epochs[0].expected.file)!;
  assert.equal(isChunked(one), false);
  assert.equal((await readWholeEpoch(files, D, one)).file.accounts.length, 10);
});
