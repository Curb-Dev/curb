// Calculator input checks and encodings not covered by the spec's own checks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, keccakHex, leafHash, normaliseSetup, normaliseInput, runVector, sha256Hex, transfersDigest, utf8 } from '../src/calc/index.ts';
import { word } from '../src/calc/encoding.ts';
import { loadVector } from './helpers.ts';

test('refused setups: sharingSince 0, a timestamp block that is not canonical decimal, quoteIsWeth not a boolean, a bad tx hash', () => {
  const refuse = (mutate: (s: any) => void, re: RegExp) => {
    const v = loadVector('v07-keeper-fee-cap');
    mutate(v.setup);
    assert.throws(() => normaliseSetup(v.setup), re);
  };
  refuse((s) => {
    s.sharingSince = '0';
    s.opening.block = '0';
  }, /sharingSince must be non-zero/);
  refuse((s) => (s.timestamps['0100'] = s.timestamps['100']), /timestamp block: not a decimal integer string/);
  refuse((s) => (s.quoteIsWeth = 'yes'), /quoteIsWeth must be a boolean/);
  refuse((s) => (s.keeperTxs[0].hash = '0x1234'), /32-byte hex/);
  assert.throws(() => normaliseInput({ toBlock: '1', harvestTx: '0xzz', received0: '0', received1: '0' }, 0), /32-byte hex/);
});

test('a keeper tx naming D twice in publishMany counts the distinct distributors only', () => {
  const v = loadVector('v07-keeper-fee-cap');
  const f = v.setup.keeperTxs.find((t: any) => t.names && t.names.length === 3);
  const once = runVector(v)[0].expected.keeperCostWei;
  f.names = [...f.names, f.names[0]];
  assert.equal(runVector(v)[0].expected.keeperCostWei, once);
});

test('encodings: keccak, sha256, the uint256 word range, the leaf and the digest', () => {
  assert.equal(keccakHex(''), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(sha256Hex(utf8('abc')), '0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(word((1n << 256n) - 1n), 'f'.repeat(64));
  assert.throws(() => word(1n << 256n), /out of range/);
  assert.throws(() => word(-1n), /out of range/);
  assert.equal(leafHash('0x' + '1'.repeat(40), '0x' + '2'.repeat(40), 3n, 4n), leafHash('0x' + '1'.repeat(40), '0x' + '2'.repeat(40).toUpperCase().replace('0X', '0x'), '3', '4'));
  assert.equal(transfersDigest([]), keccakHex(''));
  assert.throws(() => canonicalJson({ a: undefined }), /not allowed/);
  assert.equal(canonicalJson({ é: '1', e: 'x"y' }), '{"e":"x\\"y","é":"1"}');
});
