// AbortSignal.timeout() throws ERR_OUT_OF_RANGE when its delay is not a
// whole number. Every call in src/ must get a whole-number literal or a value
// passed through Math.floor (budgets counted from performance.now() are
// fractional).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dirname, '..', 'src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

test('AbortSignal.timeout throws on a fractional delay, and not on a floored one', () => {
  assert.throws(() => AbortSignal.timeout(1.5), { code: 'ERR_OUT_OF_RANGE' });
  assert.doesNotThrow(() => AbortSignal.timeout(Math.max(1, Math.floor(1.5))));
  assert.doesNotThrow(() => AbortSignal.timeout(Math.max(1, Math.floor(0.4))));
});

test('every AbortSignal.timeout in src/ gets a whole-number literal or a floored value', () => {
  const calls: string[] = [];
  for (const f of files(SRC)) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/AbortSignal\.timeout\(([^\n;]*)/g)) {
      const arg = m[1];
      // the comment that explains the rule is not a call
      if (/^\)\s*throws|^\): that one/.test(arg)) continue;
      calls.push(`${f}: ${arg}`);
      assert.ok(/^\d[\d_]*\)/.test(arg) || arg.includes('Math.floor('), `fractional delay possible: ${f}: AbortSignal.timeout(${arg}`);
    }
  }
  assert.ok(calls.length >= 2, `expected the calls in src/ to be found, got ${calls.length}`);
});
