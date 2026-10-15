// The browser bundle (browser/curb-share.mjs): current with the source, free
// of Node built-ins, and passing every golden vector when run where only the
// browser's globals exist.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';
import { BUNDLE, bundleText } from '../scripts/bundle.ts';
import { loadVector, readVectorChunks, readVectorFile, vectorNames } from './helpers.ts';

test('the committed bundle is what the source builds to', async () => {
  assert.ok(readFileSync(BUNDLE, 'utf8') === (await bundleText()), 'browser/curb-share.mjs is stale: run npm run bundle');
});

test('the bundle imports nothing and names no Node built-in', () => {
  const text = readFileSync(BUNDLE, 'utf8');
  assert.ok(!/\bfrom\s*["']/.test(text) && !/\bimport\s*\(/.test(text), 'no imports');
  assert.ok(!/["']node:/.test(text), 'no node: modules');
  assert.ok(!/require\(["'](fs|path|crypto|buffer|url|os|util)["']\)/.test(text), 'no Node requires');
});

test('every golden vector passes through the bundle as an ES module', async () => {
  const m = await import(pathToFileURL(BUNDLE).href);
  for (const name of vectorNames()) {
    const v = loadVector(name);
    assert.deepEqual(m.compareVector(name, v, m.runVector(v), readVectorFile), [], name);
  }
});

test('every golden vector passes through the bundle with only browser globals (no Buffer, process, require)', async () => {
  const iife = await build({ entryPoints: [BUNDLE], bundle: true, format: 'iife', globalName: 'CurbShare', write: false, platform: 'browser', logLevel: 'silent' });
  const code = new TextDecoder().decode(iife.outputFiles[0].contents);
  const sandbox: any = { TextEncoder, TextDecoder, console, globalThis: undefined };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code + '\n;globalThis.CurbShare = CurbShare;', sandbox);
  assert.equal(vm.runInContext('typeof Buffer + typeof process + typeof require', sandbox), 'undefinedundefinedundefined');
  const S = sandbox.CurbShare;
  let files = 0;
  for (const name of vectorNames()) {
    const v = loadVector(name);
    const results = S.runVector(JSON.parse(JSON.stringify(v)));
    results.forEach((r: any, i: number) => {
      const want = v.epochs[i].expected;
      assert.equal(r.result, want.result, `${name} ${i}`);
      if (r.result !== 'epoch') return;
      const rec = readVectorFile(want.file)!;
      assert.equal(Buffer.from(r.fileBytes).toString('hex'), Buffer.from(rec).toString('hex'), `${name} ${i}`);
      assert.equal(r.contentHash, want.contentHash);
      const chunks = readVectorChunks(want);
      assert.equal(r.chunks.length, chunks.length);
      r.chunks.forEach((c: any, k: number) => assert.equal(Buffer.from(c.bytes).toString('hex'), Buffer.from(chunks[k]).toString('hex'), `${name} ${i} chunk ${k}`));
      const check = S.verifyEpochFile(new Uint8Array(rec), { contentHash: want.contentHash, merkleRoot: want.merkleRoot }, null, { chunks: chunks.map((c) => new Uint8Array(c)) });
      assert.deepEqual(Array.from(check.problems), []);
      files++;
    });
  }
  assert.equal(files, 26);
});
