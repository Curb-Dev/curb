// KECCAK-256, because two things this page needs cannot be got any other way.
//
//   the pool id      keccak256(abi.encode(PoolKey)) - without it there is no
//                    reading the pool's price, so no quote and no honest
//                    minimum-output bound for a swap
//   event topics     topic0 of Graduated / RemainderBurned, to find the LP
//                    lock and the amount actually burned
//
// This is keccak-f[1600] with the Ethereum padding (0x01), not SHA3-256 (0x06).
// Getting that byte wrong produces a hash that looks perfectly plausible and is
// of the wrong function, so script/b20/selftest-abi.sh checks every result
// against `cast keccak`.
//
// Implemented over 32-bit halves rather than BigInt: BigInt would be shorter to
// write and slow enough to notice on every keystroke in the quote box.
(function () {

const ROUNDS = 24;

// Round constants, as (low, high) 32-bit halves.
const RC = [
  [0x00000001, 0x00000000], [0x00008082, 0x00000000], [0x0000808a, 0x80000000],
  [0x80008000, 0x80000000], [0x0000808b, 0x00000000], [0x80000001, 0x00000000],
  [0x80008081, 0x80000000], [0x00008009, 0x80000000], [0x0000008a, 0x00000000],
  [0x00000088, 0x00000000], [0x80008009, 0x00000000], [0x8000000a, 0x00000000],
  [0x8000808b, 0x00000000], [0x0000008b, 0x80000000], [0x00008089, 0x80000000],
  [0x00008003, 0x80000000], [0x00008002, 0x80000000], [0x00000080, 0x80000000],
  [0x0000800a, 0x00000000], [0x8000000a, 0x80000000], [0x80008081, 0x80000000],
  [0x00008080, 0x80000000], [0x80000001, 0x00000000], [0x80008008, 0x80000000],
];

// Rotation offsets in lane order, lane i = x + 5y.
const R = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
];

/// One lane, rotated left by n bits, over its two 32-bit halves.
function rotl(lo, hi, n) {
  if (n === 0) return [lo, hi];
  if (n < 32) {
    return [((lo << n) | (hi >>> (32 - n))) >>> 0, ((hi << n) | (lo >>> (32 - n))) >>> 0];
  }
  const m = n - 32;
  if (m === 0) return [hi, lo];
  return [((hi << m) | (lo >>> (32 - m))) >>> 0, ((lo << m) | (hi >>> (32 - m))) >>> 0];
}

function keccakF(lo, hi) {
  const cLo = new Int32Array(5), cHi = new Int32Array(5);
  const bLo = new Int32Array(25), bHi = new Int32Array(25);

  for (let round = 0; round < ROUNDS; round++) {
    // theta
    for (let x = 0; x < 5; x++) {
      cLo[x] = lo[x] ^ lo[x + 5] ^ lo[x + 10] ^ lo[x + 15] ^ lo[x + 20];
      cHi[x] = hi[x] ^ hi[x + 5] ^ hi[x + 10] ^ hi[x + 15] ^ hi[x + 20];
    }
    for (let x = 0; x < 5; x++) {
      const [rLo, rHi] = rotl(cLo[(x + 1) % 5] >>> 0, cHi[(x + 1) % 5] >>> 0, 1);
      const dLo = (cLo[(x + 4) % 5] ^ rLo) >>> 0;
      const dHi = (cHi[(x + 4) % 5] ^ rHi) >>> 0;
      for (let y = 0; y < 25; y += 5) {
        lo[x + y] = (lo[x + y] ^ dLo) >>> 0;
        hi[x + y] = (hi[x + y] ^ dHi) >>> 0;
      }
    }

    // rho (rotate each lane) and pi (move it), in one pass into b
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const i = x + 5 * y;
        const dest = y + 5 * ((2 * x + 3 * y) % 5);
        const [rLo, rHi] = rotl(lo[i] >>> 0, hi[i] >>> 0, R[i]);
        bLo[dest] = rLo;
        bHi[dest] = rHi;
      }
    }

    // chi, row by row
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        lo[y + x] = (bLo[y + x] ^ (~bLo[y + ((x + 1) % 5)] & bLo[y + ((x + 2) % 5)])) >>> 0;
        hi[y + x] = (bHi[y + x] ^ (~bHi[y + ((x + 1) % 5)] & bHi[y + ((x + 2) % 5)])) >>> 0;
      }
    }

    // iota
    lo[0] = (lo[0] ^ RC[round][0]) >>> 0;
    hi[0] = (hi[0] ^ RC[round][1]) >>> 0;
  }
}

function bytesOf(hexOrBytes) {
  if (hexOrBytes instanceof Uint8Array) return hexOrBytes;
  const h = String(hexOrBytes).replace(/^0x/, "");
  if (h.length % 2) throw new Error("odd-length hex: " + hexOrBytes);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/// @param input 0x-hex or Uint8Array
/// @return 0x-prefixed 32-byte hash
function keccak256(input) {
  const data = bytesOf(input);
  const rate = 136; // 1088 bits, the rate for keccak-256

  const padded = new Uint8Array(Math.ceil((data.length + 1) / rate) * rate);
  padded.set(data);
  padded[data.length] ^= 0x01;               // Ethereum's keccak padding, NOT 0x06
  padded[padded.length - 1] ^= 0x80;

  const lo = new Int32Array(25);
  const hi = new Int32Array(25);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      const b = off + i * 8;
      const l = (padded[b] | (padded[b + 1] << 8) | (padded[b + 2] << 16) | (padded[b + 3] << 24)) >>> 0;
      const h = (padded[b + 4] | (padded[b + 5] << 8) | (padded[b + 6] << 16) | (padded[b + 7] << 24)) >>> 0;
      lo[i] = (lo[i] ^ l) >>> 0;
      hi[i] = (hi[i] ^ h) >>> 0;
    }
    keccakF(lo, hi);
  }

  let out = "0x";
  const hex = (n) => (n >>> 0).toString(16).padStart(8, "0");
  const swap = (s) => s.slice(6, 8) + s.slice(4, 6) + s.slice(2, 4) + s.slice(0, 2);
  for (let i = 0; i < 4; i++) out += swap(hex(lo[i])) + swap(hex(hi[i]));
  return out;
}

const root = typeof window !== "undefined" ? window : globalThis;
root.CurbKeccak = { keccak256 };

})();
