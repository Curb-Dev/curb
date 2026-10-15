// Runs the spec's own independent checks (spec/spec.test.mjs: hand-derived
// figures, the naive block-by-block weight sum, refused inputs, the
// OpenZeppelin tree rebuilt by hand, canonical bytes, the pinned ABI
// document) against this implementation instead of reference.mjs: the
// import of ./reference.mjs from that file is redirected to the shim.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { ROOT } from './helpers.ts';

const SPEC_TEST = pathToFileURL(join(ROOT, 'spec', 'spec.test.mjs')).href;
const SHIM = pathToFileURL(join(ROOT, 'test', 'reference-shim.ts')).href;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === './reference.mjs' && context.parentURL === SPEC_TEST) return { url: SHIM, shortCircuit: true };
    return next(specifier, context);
  },
});

await import(SPEC_TEST);

test('the spec checks above ran against this implementation, not reference.mjs', () => {
  assert.equal((globalThis as any).__curbReferenceShimLoaded, true);
});
