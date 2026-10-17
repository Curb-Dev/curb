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
//
// AND eth_chainId of the same endpoint is asked once a visit (chainId below).
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

/// THE HEADERS OF A JSON-RPC POST TO `url`. To the site's own endpoints over
/// https (config.js rpc and logsRpc) the body goes as text/plain: both read
/// it as JSON whatever it is called, and so called it is sent without the
/// CORS preflight a browser makes first for application/json - a round trip
/// before a page's first read of each, and before Tenderly's every five
/// seconds, since it states no max-age. Any other endpoint gets
/// application/json: a node may refuse anything else (geth answers 415).
function headers(url) {
  const site = window.CURB_SITE || {};
  const u = String(url || "").trim();
  const mine = /^https:\/\//i.test(u) &&
    [site.rpc, site.logsRpc].some((x) => typeof x === "string" && x.trim() !== "" && x.trim() === u);
  return { "content-type": mine ? "text/plain;charset=UTF-8" : "application/json" };
}

/// THE CONNECTIONS TO THE SITE'S OWN ENDPOINTS, OPENED WHILE THE PAGE LOADS:
/// its scripts take a second to arrive, and the first read of each endpoint
/// then waited half a second more for a connection (17 October 2026).
/// Anonymous, as a page's fetch to them is.
(function preconnect() {
  const site = window.CURB_SITE || {};
  for (const u of [site.rpc, site.logsRpc]) {
    try {
      const o = new URL(String(u || "")).origin;
      if (!/^https:/.test(o) || document.querySelector('link[rel="preconnect"][href="' + o + '"]')) continue;
      const l = document.createElement("link");
      l.rel = "preconnect";
      l.href = o;
      l.crossOrigin = "anonymous";
      document.head.appendChild(l);
    } catch { /* no such endpoint: nothing to open */ }
  }
})();

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
    method: "POST", headers: headers(url),
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

/// THE CHAIN THE SITE'S OWN ENDPOINT SERVES, asked once a visit: a page asked
/// it five times, two of them in the way of the launch's status, and the
/// answer of an endpoint config.js names for one network does not change while
/// a page is open. `ask` makes the request; a failed ask is not kept, and any
/// other endpoint is asked every time, as before.
const chainIds = new Map();
function chainId(url, ask) {
  if (!on(url)) return ask();
  const key = String(url).trim();
  if (!chainIds.has(key)) {
    chainIds.set(key, Promise.resolve().then(ask).catch((e) => { chainIds.delete(key); throw e; }));
  }
  return chainIds.get(key);
}

// ---------------------------------------------------------------- warming
// THE READS A PAGE IS ABOUT TO MAKE, ASKED WHILE ITS SCRIPTS ARE ON THEIR WAY.
// A token's page made some twenty rounds of reads one after another, each
// waiting for an answer before it, and none could start before the page's
// 280 KB of scripts had arrived. This file loads first; so it asks at once,
// in a few gathered rounds, what the page is going to ask: the reads this
// browser noted on its last visit to the same page (up to NOTES_DAYS ago),
// and on a token's page those config.js and the address in the path already
// say (planToken).
//
// AN ANSWER IS ONLY EVER THE CHAIN'S, and stands in for a read for WARM_MS
// after it was asked: a display read that finds one takes it as that read
// made a moment earlier, which is all a read at "latest" ever was. Answers
// asked together are of one block, so they agree with each other at least as
// well as reads made one after another did. DISPLAY READS ONLY - app.js's and
// token.js's `call`, browse.js's callAt ask `warmed` first; an action's
// pinned reads go through callAt and never do, and nothing is warm any more
// once an action begins (forget). A read that finds nothing, or a warm read
// that failed, is made as before.
const WARM_MS = 6000;
const WARM_CALLS = 15;           // per warming aggregate3 (see warmUp)
const NOTE_MS = 15000;           // how long after it opens a page's reads are noted
const NOTES_KEY = "curb.warm.v1";
const NOTES_PAGES = 20, NOTES_CALLS = 240, NOTES_DAYS = 7;
const warm = new Map();          // "url|to|data", lower case -> { at, read }
const noted = new Set();         // "to|data" this page has read, while noting
const opened = Date.now();
const page = (location.pathname + location.search).toLowerCase();
const warmKey = (url, to, data) => (String(url).trim() + "|" + to + "|" + data).toLowerCase();
const isAddr = (s) => /^0x[0-9a-fA-F]{40}$/.test(String(s || ""));

/// Asks `list` ({ to, data }) in gathered rounds of MAX_CALLS, but none that
/// is warm already or asked twice.
function warmUp(url, list) {
  const now = Date.now();
  const fresh = [];
  const seen = new Set();
  for (const c of list) {
    if (!c || !isAddr(c.to) || !isHex(c.data)) continue;
    const k = warmKey(url, c.to, c.data);
    const e = warm.get(k);
    if (seen.has(k) || (e && now - e.at < WARM_MS)) continue;
    seen.add(k);
    fresh.push({ to: c.to, data: c.data });
  }
  // IN ROUNDS OF WARM_CALLS, NOT MAX_CALLS: these go out before the page has a
  // connection to the endpoint, and one aggregate of 53 calls (24 KB) as the
  // first thing on a new connection to Alchemy was cut off - the connection
  // reset after about 1.5 s, four first visits in five, and every read waited
  // for it (curbfun.xyz, 18 October 2026). Rounds of 15 went through every time.
  for (let i = 0; i < fresh.length; i += WARM_CALLS) {
    const part = fresh.slice(i, i + WARM_CALLS);
    const got = aggregate(url, part);
    got.catch(() => {});
    part.forEach((c, j) => {
      const read = got.then((r) => r[j]);
      read.catch(() => {});
      warm.set(warmKey(url, c.to, c.data), { at: now, read });
    });
  }
}

/// THE WARM ANSWER TO A DISPLAY READ, as `call` resolves one ({ ok, data }),
/// or null where there is none to take. Noted for the next visit either way.
function warmed(url, to, data) {
  if (!on(url)) return null;
  if (Date.now() - opened < NOTE_MS && noted.size < NOTES_CALLS && isAddr(to) && isHex(data)) {
    noted.add((to + "|" + data).toLowerCase());
  }
  const e = warm.get(warmKey(url, to, data));
  if (!e || !(Date.now() - e.at < WARM_MS)) return null;
  served += 1;
  return e.read;
}
/// Nothing warm stands in for a read from here on: an action has begun, or a
/// transaction of this page's was found mined. A planToken still under way
/// asks nothing more (its generation is over). Returns how many warm answers
/// this page has taken since it opened - not since the last forget(): an
/// action's forget() clears what is warm, not what was drawn from it, and a
/// resume that settles a record during that action must still know.
let generation = 0;
let served = 0;
function forget() {
  generation += 1;
  warm.clear();
  return served;
}

/// What this page read, kept for its next visit: the NOTES_PAGES pages last
/// opened, NOTES_CALLS reads each. Storage refused keeps nothing.
function saveNotes() {
  if (!noted.size) return;
  try {
    const site = window.CURB_SITE || {};
    const all = JSON.parse(localStorage.getItem(NOTES_KEY) || "{}") || {};
    all[page] = { at: Date.now(), url: String(site.rpc || "").trim(), calls: [...noted] };
    const kept = Object.entries(all).filter(([, v]) => v && Array.isArray(v.calls))
      .sort((a, b) => b[1].at - a[1].at).slice(0, NOTES_PAGES);
    localStorage.setItem(NOTES_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch { /* nothing kept: the next visit warms only what config.js says */ }
}
function replayNotes(url) {
  try {
    const e = (JSON.parse(localStorage.getItem(NOTES_KEY) || "{}") || {})[page];
    if (!e || e.url !== url || !Array.isArray(e.calls) || !(Date.now() - e.at < NOTES_DAYS * 86400000)) return;
    warmUp(url, e.calls.slice(0, NOTES_CALLS).map((s) => { const [to, data] = String(s).split("|"); return { to, data }; }));
  } catch { /* nothing kept */ }
}

/// THE SELECTORS planToken ASKS, as app.js and token.js build them (sig()).
const SEL = {
  registry: "0x7b103999", graduator: "0x0245a483", launchState: "0x3cb24365", name: "0x06fdde03",
  symbol: "0x95d89b41", tokenURI: "0x3c130d90", totalSupply: "0x18160ddd", decimals: "0x313ce567",
  launcherCount: "0xd48a4846", isRegistered: "0xc3c5a547", launchOf: "0x029282d7", launcherAt: "0xfea7ee7a",
  requiredHook: "0xd6d08a09", quoteToken: "0x217a4b70", feeEscrow: "0xc4b7de97", graduated: "0xe7c2b772",
  readyToGraduate: "0xc68360a5", realQuoteReserve: "0x4f1f58fd", graduationThreshold: "0x8b0bc501",
  getReserves: "0x0902f1ac", feeBps: "0x24a9d853", creatorTaxBps: "0xc1bb8901", sellableTokens: "0x808bcddc",
  deployer: "0xd5f39488", protocolFeeRecipient: "0x64df049e", creatorTaxBalance: "0xdb2bd533",
  quoteFeeBalance: "0xed479c47", protocolFeeShareBps: "0x9040f866", supply: "0x047fc9aa",
  MAX_DEV_BUY_BPS: "0x52b5aefa", phantomQuote: "0xc57eadfc", currentPlatformPolicy: "0xecde20cf", WETH: "0xad5c4648",
  sharingCatalog: "0x1b5460fc", hasGraduated: "0xfa1653bd", holderDistributorOf: "0xbaf188c2",
  recommended: "0xd798b1ac", isApproved: "0x673448dd", VERSION: "0xffa1ad74", balanceOfToken: "0xf59e38b7",
  owed: "0x28079e4a",
};
const pad = (a) => String(a).toLowerCase().replace(/^0x/, "").padStart(64, "0");
const wordAddr = (hex, i) => (isHex(hex) && hex.length >= 2 + 64 * (i + 1) ? "0x" + hex.slice(2 + 64 * i + 24, 2 + 64 * (i + 1)) : null);

/// A TOKEN'S PAGE, ON A FIRST VISIT: what app.js's refresh and token.js read
/// for it, from what config.js names (the lens, the registry, the factories)
/// and the token in the path, and then from the answers - the record's
/// curve, asset and beneficiary, the factories on that asset, their
/// Graduator, its sharing catalog - in five gathered rounds. A read named
/// here that the page does not make costs nothing but its place in a round;
/// one the page makes that is not named here is made as before.
async function planToken(url, token, site) {
  const L = isAddr(site.lens) ? site.lens.toLowerCase() : "";
  const R = isAddr(site.registry) ? site.registry.toLowerCase() : "";
  const F = (Array.isArray(site.factories) ? site.factories : []).filter(isAddr).map((f) => f.toLowerCase());
  if (!L || !R) return;
  const T = pad(token);
  // NOTHING MORE ONCE forget() HAS RUN: a round asked after an action began
  // would be an answer from before it, taken by the refresh after it.
  const born = generation;
  const ask = (rows) => { if (born === generation) warmUp(url, rows.map(([to, data]) => ({ to, data }))); };
  const got = (to, data) => {
    const e = warm.get(warmKey(url, to, data));
    return e ? e.read.then((r) => (r && r.ok ? r.data : null), () => null) : Promise.resolve(null);
  };
  ask([
    [L, SEL.registry], [L, SEL.graduator], [L, SEL.launchState + T],
    [token, SEL.name], [token, SEL.symbol], [token, SEL.tokenURI], [token, SEL.totalSupply],
    [R, SEL.launcherCount], [R, SEL.isRegistered + T], [R, SEL.launchOf + T], [R, SEL.requiredHook],
    ...F.map((_, i) => [R, SEL.launcherAt + i.toString(16).padStart(64, "0")]),
    ...F.flatMap((f) => [[f, SEL.quoteToken], [f, SEL.feeEscrow]]),
  ]);
  const [rec, hookW, lensGradW, ...quoteW] = await Promise.all([got(R, SEL.launchOf + T), got(R, SEL.requiredHook),
    got(L, SEL.graduator), ...F.map((f) => got(f, SEL.quoteToken))]);
  const curve = wordAddr(rec, 0), quote = wordAddr(rec, 1), who = wordAddr(rec, 2), hook = wordAddr(hookW, 0);
  // THE GRADUATOR THE LENS NAMES, read a round before the factory names its own:
  // they are one contract, and where they are not the factory's is read below.
  const lensGrad = wordAddr(lensGradW, 0);
  const ofGraduator = (g) => [[g, SEL.sharingCatalog], [g, SEL.hasGraduated + T], [g, SEL.holderDistributorOf + T]];
  if (!curve || !quote) return;
  const quotes = quoteW.map((q) => wordAddr(q, 0));
  const mine = F.filter((f, i) => quotes[i] === quote);
  const escrows = (await Promise.all(mine.map((f) => got(f, SEL.feeEscrow)))).map((e) => wordAddr(e, 0)).filter(Boolean);
  ask([
    ...["feeEscrow", "graduated", "readyToGraduate", "realQuoteReserve", "graduationThreshold", "getReserves", "feeBps",
      "creatorTaxBps", "sellableTokens", "deployer", "protocolFeeRecipient", "creatorTaxBalance", "quoteFeeBalance",
      "protocolFeeShareBps"].map((n) => [curve, SEL[n]]),
    ...quotes.filter(Boolean).flatMap((q) => [[q, SEL.name], [q, SEL.symbol]]),
    [quote, SEL.decimals],
    ...mine.flatMap((f) => ["registry", "quoteToken", "graduator", "supply", "graduationThreshold", "MAX_DEV_BUY_BPS",
      "phantomQuote", "currentPlatformPolicy"].map((n) => [f, SEL[n]])),
    ...(hook ? [[hook, SEL.WETH]] : []),
    ...(who ? escrows.map((e) => [e, SEL.balanceOfToken + pad(who) + pad(quote)]) : []),
    ...(who && hook ? [[hook, SEL.owed + pad(who) + pad(quote)]] : []),
    ...(lensGrad ? ofGraduator(lensGrad) : []),
  ]);
  const grads = [...new Set([lensGrad, ...(await Promise.all(mine.map((f) => got(f, SEL.graduator)))).map((g) => wordAddr(g, 0))].filter(Boolean))];
  ask(grads.flatMap(ofGraduator));
  const cats = [...new Set((await Promise.all(grads.map((g) => got(g, SEL.sharingCatalog)))).map((c) => wordAddr(c, 0)).filter(Boolean))];
  ask(cats.map((c) => [c, SEL.recommended]));
  for (const c of cats) {
    const r = wordAddr(await got(c, SEL.recommended), 0);
    if (r) ask([[c, SEL.isApproved + pad(r)], [r, SEL.VERSION]]);
  }
}

/// AT ONCE, on the site's own endpoint only: a link naming another reads that
/// one, and nothing is warmed for it.
(function begin() {
  const site = window.CURB_SITE || {};
  const url = typeof site.rpc === "string" ? site.rpc.trim() : "";
  if (!url) return;
  try {
    const linked = new URLSearchParams(location.search).get("rpc");
    if (linked && linked.trim() !== url) return;
  } catch { return; }
  // NOR WHEN THE PERSON SAVED ANOTHER ENDPOINT ON app.html (curb.app.v1): the
  // pages read that one, and this one is not to be asked anything for them.
  // app.html (a token's page, the create form) reads the saved rpc whatever
  // marks it (app.js loadCfg); the other pages only one not marked as a
  // link's (topbar.js savedPair). Either way, a page whose link names an
  // endpoint reads the link's, and that was decided above.
  try {
    const saved = JSON.parse(localStorage.getItem("curb.app.v1") || "{}") || {};
    const appPage = /^\/(token\/|app(\.html)?$)/.test(location.pathname);
    const linkedRpc = new URLSearchParams(location.search).get("rpc");
    if (!linkedRpc && (appPage || saved.rpcFromLink !== true) && typeof saved.rpc === "string" &&
      saved.rpc.trim() && saved.rpc.trim() !== url) return;
  } catch { /* nothing saved, or storage refused: the site's endpoint is the page's */ }
  setTimeout(saveNotes, NOTE_MS);
  addEventListener("pagehide", saveNotes);
  // THE CHAIN IT SERVES, asked now for the page (chainId).
  chainId(url, () => fetch(url, { method: "POST", headers: headers(url),
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "eth_chainId", params: [] }) })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error("HTTP " + res.status))))
    .then((b) => (b && !b.error && typeof b.result === "string" ? b.result : Promise.reject(new Error("no chain id")))))
    .catch(() => {});
  // THE LOG ENDPOINT'S CONNECTION, opened by a first small request on a page
  // that reads logs: the preconnect above was not used (a page's first log
  // read still spent 0.3 s on DNS, TCP and TLS of its own, 17 October 2026).
  const logs = typeof site.logsRpc === "string" ? site.logsRpc.trim() : "";
  if (/^https:\/\//i.test(logs) && /^\/($|token\/|sharing|browse)/.test(location.pathname)) {
    fetch(logs, { method: "POST", headers: headers(logs),
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "eth_chainId", params: [] }) }).catch(() => {});
  }
  replayNotes(url);
  const m = /^\/token\/(0x[0-9a-fA-F]{40})\/?$/.exec(location.pathname);
  if (m) planToken(url, m[1].toLowerCase(), site).catch(() => {});
})();

window.CurbMulti = { on, call, chainId, warmed, forget, taken: () => served, headers, encode, decode, MULTICALL3 };
})();
