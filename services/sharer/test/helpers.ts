import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const VECTORS_DIR = join(ROOT, 'spec', 'vectors');

export function vectorNames(): string[] {
  return readdirSync(VECTORS_DIR)
    .filter((f) => /^v\d+.*\.json$/.test(f))
    .sort()
    .map((f) => f.replace(/\.json$/, ''));
}

export function loadVector(name: string): any {
  return JSON.parse(readFileSync(join(VECTORS_DIR, name + '.json'), 'utf8'));
}

export function readVectorFile(rel: string): Uint8Array | null {
  const p = join(VECTORS_DIR, rel);
  return existsSync(p) ? new Uint8Array(readFileSync(p)) : null;
}

/** The recorded chunk files of an attempt's epoch file, in order (none when
 *  its rows are in its index). */
export function readVectorChunks(expected: { chunkFiles?: string[] }): Uint8Array[] {
  return (expected.chunkFiles ?? []).map((rel) => {
    const b = readVectorFile(rel);
    if (!b) throw new Error(`recorded chunk ${rel} is missing`);
    return b;
  });
}
