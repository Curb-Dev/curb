// The sharer's calculator behind reference.mjs's API, so the spec's own
// independent checks (spec/spec.test.mjs) run against this implementation
// unchanged (see spec-port.test.ts).

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runVector as run, canonicalJson } from '../src/calc/index.ts';
import { VECTORS_DIR } from './helpers.ts';

export { canonicalJson, VECTORS_DIR };

/** Lets spec-port.test.ts prove the redirect happened. */
(globalThis as any).__curbReferenceShimLoaded = true;

/** As reference.mjs gives them: `file` is the index as written (its JSON
 *  value), `chunkFiles` the chunk files' bytes. */
export function runVector(vector: any) {
  return run(vector).map((r) => ({
    expected: r.expected,
    file: r.result === 'epoch' ? JSON.parse(Buffer.from(r.fileBytes).toString('utf8')) : undefined,
    fileBytes: r.result === 'epoch' ? Buffer.from(r.fileBytes) : undefined,
    chunkFiles: r.result === 'epoch' ? r.chunks.map((c) => Buffer.from(c.bytes)) : [],
  }));
}

export function vectorFiles(): string[] {
  return readdirSync(VECTORS_DIR)
    .filter((f) => /^v\d+.*\.json$/.test(f))
    .sort()
    .map((f) => join(VECTORS_DIR, f));
}
