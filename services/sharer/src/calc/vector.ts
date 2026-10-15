// Runs a golden vector (spec README section 3): every attempt in order, each
// against the state the earlier attempts left.

import { canonicalJson } from './encoding.ts';
import { computeEpoch } from './share.ts';
import type { ActiveState, AttemptResult } from './types.ts';
import { normaliseInput, normaliseSetup } from './validate.ts';

/** An attempt that yields no epoch leaves the state alone; a vetoed epoch
 *  burns its number and leaves the active state alone; any other epoch
 *  becomes the active state. */
export function runVector(vector: { setup: Record<string, unknown>; epochs: { input: Record<string, unknown> }[] }): AttemptResult[] {
  const setup = normaliseSetup(vector.setup);
  let state: ActiveState | null = null;
  let lastProposed = 0n;
  let vetoedSinceActive: bigint[] = [];
  const results: AttemptResult[] = [];
  vector.epochs.forEach((raw, i) => {
    const input = normaliseInput(raw.input, i);
    const r = computeEpoch({ setup, state, lastProposed, vetoedSinceActive, input });
    results.push(r);
    if (r.result !== 'epoch') return;
    lastProposed = r.root.epoch;
    if (input.vetoed) {
      vetoedSinceActive = [...vetoedSinceActive, lastProposed];
    } else {
      state = r.next;
      vetoedSinceActive = [];
    }
  });
  return results;
}

/** The path of an attempt's epoch file (its index), relative to the vectors directory. */
export function vectorFilePath(vectorName: string, epoch: bigint | string): string {
  return `files/${vectorName}/${epoch}.json`;
}

/** The path of chunk k of an attempt's epoch file, relative to the vectors directory. */
export function vectorChunkPath(vectorName: string, epoch: bigint | string, k: number): string {
  return `files/${vectorName}/${epoch}.chunk${k}.json`;
}

export interface VectorMismatch {
  attempt: number;
  what: string;
}

/** Compares a vector's recorded outputs with the results, field by field and
 *  file by file. `files` maps a relative file path to its recorded bytes. */
export function compareVector(
  vectorName: string,
  vector: { epochs: { expected?: Record<string, unknown> }[] },
  results: AttemptResult[],
  files: (relPath: string) => Uint8Array | null,
): VectorMismatch[] {
  const bad: VectorMismatch[] = [];
  if (results.length !== vector.epochs.length) bad.push({ attempt: 0, what: `attempt count ${results.length} != ${vector.epochs.length}` });
  results.forEach((r, i) => {
    const want = vector.epochs[i]?.expected;
    if (!want) {
      bad.push({ attempt: i + 1, what: 'no expected output recorded' });
      return;
    }
    const got: Record<string, unknown> = { ...r.expected };
    if (r.result === 'epoch') {
      got.file = vectorFilePath(vectorName, r.root.epoch);
      got.chunkFiles = r.chunks.map((_, k) => vectorChunkPath(vectorName, r.root.epoch, k));
    }
    for (const k of new Set([...Object.keys(want), ...Object.keys(got)])) {
      if (canonicalJson(want[k] ?? null) !== canonicalJson(got[k] ?? null)) bad.push({ attempt: i + 1, what: `field ${k} differs` });
    }
    if (r.result === 'epoch') {
      const rec = files(vectorFilePath(vectorName, r.root.epoch));
      if (!rec) bad.push({ attempt: i + 1, what: 'recorded epoch file missing' });
      else if (!bytesEqual(rec, r.fileBytes)) bad.push({ attempt: i + 1, what: 'epoch file bytes differ' });
      r.chunks.forEach((c, k) => {
        const got = files(vectorChunkPath(vectorName, r.root.epoch, k));
        if (!got) bad.push({ attempt: i + 1, what: `recorded chunk ${k} missing` });
        else if (!bytesEqual(got, c.bytes)) bad.push({ attempt: i + 1, what: `chunk ${k} bytes differ` });
      });
    }
  });
  return bad;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
