// THE SITE'S READS, GATHERED INTO ONE.
//
// A launch's page made some two hundred eth_calls to the site's endpoint, most
// of them a handful at a time, and the free plan behind it serves a few dozen
// a second for every visitor at once: the page waited on its own reads.
// Multicall3 - the same contract at the same address on Base and on every fork
// of it - runs a list of calls in one eth_call and answers each with whether
// it succeeded and what it returned. So every eth_call a page makes at
// "latest", without a sender or a gas limit, waits a few milliseconds for
// company and goes out with it in one aggregate3; a call alone goes out as it
// is. What comes back is, call by call, what the call alone would have
// answered: its result, or that it reverted and the revert's data - each
// reader turns that into its own error, as its own transport would have.
//
// ONLY ON THE SITE'S OWN ENDPOINT (config.js rpc). A fork, a link's endpoint
// and the tests' nodes are read call by call, as before. And if the
// aggregate3 itself is refused - the endpoint, a node without Multicall3,
// a batch over its gas - every call in it is made alone instead.
//
// Display reads only: what a page sends is simulated by the wallet, and calls
// that name a sender (from) or a gas limit are never gathered.
(function () {
"use strict";

const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
const AGGREGATE3 = "0x82ad56cb"; // aggregate3((address,bool,bytes)[])
const MAX_CALLS = 60;            // per aggregate3
const WAIT_MS = 4;               // how long a read waits for company
const queues = new Map();        // url -> { items, timer }
let rpcId = 0;

function on(url) {
  const site = window.CURB_SITE || {};
  const own = typeof site.rpc === "string" ? site.rpc.trim() : "";
  return !!own && String(url || "").trim() === own;
}

const word = (n) => n.toString(16).padStart(64, "0");
const isHex = (s) => typeof s === "string" && /^0x([0-9a-fA-F]{2})*$/.test(s);

function encode(calls) {
  const tuples = calls.map((c) => {
    const d = c.data.slice(2);
    const pad = (64 - (d.length % 64)) % 64;
    return c.to.toLowerCase().slice(2).padStart(64, "0") + word(1) + word(0x60) + word(d.length / 2) + d + "0".repeat(pad);
  });
  let offsets = "";
  let at = 32 * calls.length;
  for (const t of tuples) { offsets += word(at); at += t.length / 2; }
  return AGGREGATE3 + word(0x20) + word(calls.length) + offsets + tuples.join("");
}

/// Result[] = (bool success, bytes returnData)[], read with every offset and
/// length checked against the answer's own size.
function decode(hex, n) {
  const h = hex.slice(2);
  const size = h.length / 2;
  const num = (byte) => {
    if (byte < 0 || byte + 32 > size) throw new Error("out of range");
    const v = BigInt("0x" + h.slice(byte * 2, byte * 2 + 64));
    if (v > BigInt(size)) throw new Error("bad offset");
    return Number(v);
  };
  const arr = num(0);
  if (num(arr) !== n) throw new Error("the answer has another number of results");
  const base = arr + 32;
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = base + num(base + 32 * i);
    const ok = BigInt("0x" + h.slice(t * 2, t * 2 + 64)) !== 0n;
    const b = t + num(t + 32);
    const len = num(b);
    if (b + 32 + len > size) throw new Error("out of range");
    out.push({ ok, data: "0x" + h.slice((b + 32) * 2, (b + 32 + len) * 2) });
  }
  return out;
}

async function aggregate(url, calls) {
  const res = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "eth_call", params: [{ to: MULTICALL3, data: encode(calls) }, "latest"] }),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const body = await res.json();
  if (!body || body.error || !isHex(body.result) || body.result.length < 130) throw new Error("no aggregate");
  return decode(body.result, calls.length);
}

function flush(url) {
  const q = queues.get(url);
  if (!q) return;
  queues.delete(url);
  clearTimeout(q.timer);
  for (let i = 0; i < q.items.length; i += MAX_CALLS) {
    const part = q.items.slice(i, i + MAX_CALLS);
    if (part.length === 1) { alone(part[0]); continue; }
    aggregate(url, part).then(
      (got) => part.forEach((it, j) => it.resolve(got[j])),
      () => part.forEach(alone),
    );
  }
}
/// The call made by itself, through the reader's own transport.
function alone(it) {
  it.direct().then((data) => it.resolve({ ok: true, data }), (e) => it.reject(e));
}

/// One eth_call at "latest". Resolves { ok: true, data } with its result, or
/// { ok: false, data } with the revert data when it reverted; rejects, as
/// `direct` does, when it was made alone and failed.
function call(url, to, data, direct) {
  return new Promise((resolve, reject) => {
    if (!on(url) || !/^0x[0-9a-fA-F]{40}$/.test(String(to || "")) || !isHex(data)) {
      direct().then((d) => resolve({ ok: true, data: d }), reject);
      return;
    }
    let q = queues.get(url);
    if (!q) { q = { items: [], timer: setTimeout(() => flush(url), WAIT_MS) }; queues.set(url, q); }
    q.items.push({ to, data, direct, resolve, reject });
    if (q.items.length >= MAX_CALLS) flush(url);
  });
}

window.CurbMulti = { on, call, encode, decode, MULTICALL3 };
})();
