// Recomputes every golden vector in spec/vectors with this implementation and
// compares the outputs and the epoch file bytes (the spec's `npm run check`,
// for the sharer).
//
//   node scripts/vectors.ts

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVector, runVector } from '../src/calc/index.ts';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'spec', 'vectors');
let bad = 0;
for (const f of readdirSync(DIR).filter((x) => /^v\d+.*\.json$/.test(x)).sort()) {
  const name = f.replace(/\.json$/, '');
  const v = JSON.parse(readFileSync(join(DIR, f), 'utf8'));
  const results = runVector(v);
  const mism = compareVector(name, v, results, (rel) => (existsSync(join(DIR, rel)) ? new Uint8Array(readFileSync(join(DIR, rel))) : null));
  results.forEach((r, i) => {
    const m = mism.filter((x) => x.attempt === i + 1);
    if (m.length) {
      bad += m.length;
      for (const x of m) console.error(`FAIL ${name} attempt ${i + 1}: ${x.what}`);
    } else {
      console.log(`ok   ${name} attempt ${i + 1}: ${r.result === 'epoch' ? `epoch ${r.root.epoch} root ${r.root.merkleRoot}` : `no epoch (${r.reason})`}`);
    }
  });
  for (const x of mism.filter((y) => y.attempt === 0)) {
    bad++;
    console.error(`FAIL ${name}: ${x.what}`);
  }
}
if (bad) console.error(`${bad} mismatch(es)`);
process.exitCode = bad ? 1 : 0;
