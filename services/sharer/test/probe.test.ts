// The probe's pinned configuration (CURB-SHARE v1, spec 4.10) and its request
// packing. The code, the gas and the limits are part of the rules: every
// reader - the keeper's two, the verifier's, the guardian's - must probe the
// same way, so they are constants here, named in the spec, and pinned against
// the Solidity source's build (test/sharing/SharerProbe.t.sol).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { keccak256 } from 'viem';
import {
  decodeProbeAnswer,
  PROBE_CALL_GAS,
  PROBE_CODE_HASH,
  PROBE_FROM,
  PROBE_INITCODE,
  PROBE_MAX_INITCODE,
  PROBE_REQUEST_GAS,
  PROBE_RETURN_CAP,
  probeRequest,
} from '../src/chain/probe.ts';
import { ROOT } from './helpers.ts';

const REPO = join(ROOT, '..', '..');
const A = (n: number) => '0x' + n.toString(16).padStart(40, '0');

test('probe: the code is the pinned SharerProbe build, and the spec and the Solidity test name the same numbers', (t) => {
  assert.equal(keccak256(PROBE_INITCODE as `0x${string}`), PROBE_CODE_HASH);
  const spec = readFileSync(join(ROOT, 'spec', 'README.md'), 'utf8');
  for (const s of [PROBE_CODE_HASH, '100,000', '15,000,000', '160 bytes', '49,152', '103,600 + 200 * (out + 192)', 'out + 192 <= 24,576', 'STATICCALL', 'no `to`', 'zero address']) assert.ok(spec.includes(s), `the spec names ${s}`);
  assert.equal(PROBE_CALL_GAS, 100_000n);
  assert.equal(PROBE_REQUEST_GAS, 15_000_000n);
  assert.ok(PROBE_REQUEST_GAS <= 1n << 24n, "under EIP-7825's per-transaction gas cap");
  assert.equal(PROBE_RETURN_CAP, 160);
  assert.equal(PROBE_MAX_INITCODE, 49_152);
  assert.equal(PROBE_FROM, '0x0000000000000000000000000000000000000000');
  const sol = readFileSync(join(REPO, 'test', 'sharing', 'SharerProbe.t.sol'), 'utf8');
  assert.ok(sol.includes(`bytes32 constant PROBE_CODE_HASH = ${PROBE_CODE_HASH};`), 'test/sharing/SharerProbe.t.sol pins the same hash');
  const src = readFileSync(join(REPO, 'src', 'curb', 'sharing', 'SharerProbe.sol'), 'utf8');
  assert.ok(src.includes('CALL_GAS = 100_000;') && src.includes('RETURN_CAP = 160;'), 'the Solidity source has the same constants');
  const artifact = join(REPO, 'out', 'SharerProbe.sol', 'SharerProbe.json');
  if (!existsSync(artifact)) return t.skip('out/SharerProbe.sol/SharerProbe.json is not built');
  assert.equal(JSON.parse(readFileSync(artifact, 'utf8')).bytecode.object, PROBE_INITCODE, 'the build is the code the reader sends');
});

test('probe: a request packs the calls from its start, in order, up to the initcode limit, with the length word last', () => {
  const calls = Array.from({ length: 3000 }, (_, i) => ({ to: A(i + 1), data: '0x0dfe1681' }));
  const first = probeRequest(calls, 0);
  const initBytes = (PROBE_INITCODE.length - 2) / 2;
  // 26 bytes a call: as many as fit beside the code and the length word
  assert.equal(first.count, Math.floor((PROBE_MAX_INITCODE - initBytes - 32) / 26));
  assert.ok((first.data.length - 2) / 2 <= PROBE_MAX_INITCODE);
  assert.ok((first.data.length - 2) / 2 + 26 > PROBE_MAX_INITCODE, 'one more call would not fit');
  assert.ok(first.data.startsWith(PROBE_INITCODE));
  assert.equal(BigInt('0x' + first.data.slice(-64)), BigInt(first.count * 26));
  assert.equal(first.data.slice(PROBE_INITCODE.length, PROBE_INITCODE.length + 52), A(1).slice(2) + '0004' + '0dfe1681');
  const next = probeRequest(calls, first.count);
  assert.equal(next.data.slice(PROBE_INITCODE.length, PROBE_INITCODE.length + 40), A(first.count + 1).slice(2), 'the next request starts where the first stopped');
  const tail = probeRequest(calls, 2990);
  assert.equal(tail.count, 10);
  assert.equal(probeRequest(calls, 3000).count, 0);
  // data of any length up to what one request can carry
  assert.equal(probeRequest([{ to: A(1), data: '0x' }], 0).data, PROBE_INITCODE + A(1).slice(2) + '0000' + (22).toString(16).padStart(64, '0'));
});

test('probe: an answer reads back as success and data, a failure as no data', () => {
  const word = (n: bigint) => n.toString(16).padStart(64, '0');
  const OK = 1n << 255n;
  const raw = '0x' + word(3n) + word(OK | 300n) + 'ab'.repeat(160) + word(64n) + word(OK);
  assert.deepEqual(decodeProbeAnswer(raw, 3), [
    { success: true, returnData: '0x' + 'ab'.repeat(160) },
    { success: false, returnData: '0x' },
    { success: true, returnData: '0x' },
  ]);
  // fewer answered than asked is a partial answer, not an error
  assert.equal(decodeProbeAnswer('0x' + word(1n) + word(0n), 5).length, 1);
});
