// A SMALL ABI CODER, BECAUSE THE ALTERNATIVES WERE BOTH WORSE.
//
// Two calls this demo has to make are not hand-writable hex. The factory's
// launch() takes a fifteen-field struct with three strings in it, and
// UniversalRouter's execute() takes bytes[] of abi-encoded actions with a
// nested dynamic tuple. Getting an offset wrong there does not produce an
// error a person can read - it produces a revert deep inside someone else's
// contract, which is exactly how the router layout problem in ROUTER_ACCESS.txt
// took a day to find.
//
// The alternative was a library from a CDN, which a page served from a local
// fork should not need an internet connection to run.
//
// WHAT IT COVERS, and nothing more: address, bool, uintN, intN, bytesN, bytes,
// string, tuple, and dynamic arrays. No fixed-size arrays, no function types.
// Every encoding here is checked against `cast abi-encode` in
// script/b20/selftest-abi.sh, because "it looked right" is not a test.
(function () {

const WORD = 64; // hex characters, not bytes

const strip = (h) => (h || "").replace(/^0x/, "");
const isHex = (s) => /^0x[0-9a-fA-F]*$/.test(s || "");

function padLeft(hex) {
  const h = strip(hex);
  if (h.length > WORD) throw new Error("value does not fit in one word: 0x" + h);
  return h.padStart(WORD, "0");
}
function padRight(hex) {
  const h = strip(hex);
  if (h.length > WORD) throw new Error("value does not fit in one word: 0x" + h);
  return h.padEnd(WORD, "0");
}

/// Two's complement over 256 bits, so a negative tickSpacing encodes the way
/// the EVM reads it.
function uintWord(v) {
  let n = BigInt(v);
  if (n < 0n) n += 1n << 256n;
  if (n < 0n || n >= 1n << 256n) throw new Error("integer out of range: " + v);
  return n.toString(16).padStart(WORD, "0");
}

// ---------------------------------------------------------------- the types
const T = {
  address: { kind: "address" },
  bool: { kind: "bool" },
  bytes: { kind: "bytes" },
  string: { kind: "string" },
  uint: (bits = 256) => ({ kind: "uint", bits }),
  int: (bits = 256) => ({ kind: "int", bits }),
  bytesN: (n) => ({ kind: "bytesN", n }),
  tuple: (types) => ({ kind: "tuple", types }),
  array: (type) => ({ kind: "array", type }),
};

function isDynamic(t) {
  if (t.kind === "bytes" || t.kind === "string" || t.kind === "array") return true;
  if (t.kind === "tuple") return t.types.some(isDynamic);
  return false;
}

function encodeBytesLike(hex) {
  const h = strip(hex);
  if (h.length % 2) throw new Error("odd-length bytes: 0x" + h);
  const len = h.length / 2;
  const body = len === 0 ? "" : h.padEnd(Math.ceil(len / 32) * WORD, "0");
  return uintWord(len) + body;
}

function utf8Hex(s) {
  return Array.from(new TextEncoder().encode(s))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/// @return the hex body of one value, without a leading 0x. For a dynamic type
///         this is the TAIL; the caller writes the offset into the head.
function encodeValue(t, v) {
  switch (t.kind) {
    case "address": {
      if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error("not an address: " + v);
      return padLeft(v.toLowerCase());
    }
    case "bool":
      return uintWord(v ? 1 : 0);
    case "uint": {
      const n = BigInt(v);
      if (n < 0n) throw new Error("negative value for uint: " + v);
      if (t.bits < 256 && n >= 1n << BigInt(t.bits)) throw new Error("uint" + t.bits + " overflow: " + v);
      return uintWord(n);
    }
    case "int": {
      const n = BigInt(v);
      const limit = 1n << BigInt(t.bits - 1);
      if (n >= limit || n < -limit) throw new Error("int" + t.bits + " out of range: " + v);
      return uintWord(n);
    }
    case "bytesN": {
      if (!isHex(v)) throw new Error("not hex: " + v);
      if (strip(v).length !== t.n * 2) throw new Error("expected bytes" + t.n + ": " + v);
      return padRight(v);
    }
    case "bytes":
      return encodeBytesLike(v);
    case "string":
      return encodeBytesLike("0x" + utf8Hex(v));
    case "tuple":
      return encodeParts(t.types, v);
    case "array": {
      const items = v.map(() => t.type);
      return uintWord(v.length) + encodeParts(items, v);
    }
    default:
      throw new Error("unsupported type " + t.kind);
  }
}

/// The head/tail split, which is the whole of ABI encoding and the whole of
/// what goes wrong when it is written by hand.
function encodeParts(types, values) {
  if (types.length !== values.length) {
    throw new Error("encode: " + types.length + " types for " + values.length + " values");
  }
  const bodies = types.map((t, i) => encodeValue(t, values[i]));

  // A dynamic member takes ONE head word holding an offset; a static one sits
  // in the head whole, however many words it is. So the head's length has to be
  // known before any offset can be written.
  let headLen = 0;
  types.forEach((t, i) => { headLen += isDynamic(t) ? WORD : bodies[i].length; });

  let head = "";
  let tail = "";
  types.forEach((t, i) => {
    if (isDynamic(t)) {
      head += uintWord((headLen + tail.length) / 2);
      tail += bodies[i];
    } else {
      head += bodies[i];
    }
  });
  return head + tail;
}

function encode(types, values) {
  return "0x" + encodeParts(types, values);
}

// ---------------------------------------------------------------- decoding
// Only what is read back here: flat words out of a static return.
const words = (hex) => {
  const h = strip(hex);
  const out = [];
  for (let i = 0; i + WORD <= h.length; i += WORD) out.push(h.slice(i, i + WORD));
  return out;
};
const wordToAddress = (w) => "0x" + w.slice(24);
const wordToBig = (w) => BigInt("0x" + w);
/// Two's complement, for the signed fields (tickSpacing).
const wordToInt = (w, bits) => {
  const n = BigInt("0x" + w);
  const limit = 1n << BigInt(bits - 1);
  return n >= limit ? n - (1n << BigInt(bits)) : n;
};

// Both the page and a Node self-test load this file, so the export cannot
// assume a window.
const root = typeof window !== "undefined" ? window : globalThis;
root.CurbAbi = { T, encode, encodeParts, words, wordToAddress, wordToBig, wordToInt, utf8Hex };

})();
