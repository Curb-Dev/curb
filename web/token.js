// A LAUNCH'S OWN PAGE: /token/0x…, which is app.html in its token view.
//
// The <head> of app.html sets html.tokenView when the path is /token/0x…; this
// file draws that view and does nothing on any other page.
//
// EVERYTHING A PERSON DOES HERE GOES THROUGH app.js. The swap card writes
// app.js's own fields (#curveSide, #curveAmount, #slippage, #poolSide, …) and
// presses its own buttons (#curveAct, #poolAct, #complete); the claim buttons
// are app.js's #owedBox, moved into the fees card. So a trade made here is
// pinned, checked, recorded and reported exactly as one made on the long page
// - this file adds no way of sending anything.
//
// WHAT IT ADDS is what app.js never drew: the token's name, picture and links;
// its price and market cap; a chart, the trade list and the holders, read from
// the chain's own events; and what the launch's creator has earned. There is no
// indexer behind this page, so the history is read with eth_getLogs, a window
// at a time, back to the launch's creation - quick for a launch of this month,
// and said plainly when a launch is older than what is read.
(function () {
"use strict";
if (!document.documentElement.classList.contains("tokenView")) return;
if (!window.CurbApp || !window.CurbAbi || !window.CurbKeccak) return;

const $ = (id) => document.getElementById(id);
const App = window.CurbApp;
const S = () => App.state;
const { words, wordToAddress, wordToBig, utf8Hex } = window.CurbAbi;
const { keccak256 } = window.CurbKeccak;
const Meta = window.CurbMeta || null;

const sig = (s) => keccak256("0x" + utf8Hex(s)).slice(0, 10);
const topic = (s) => keccak256("0x" + utf8Hex(s));
const pad = (a) => String(a).toLowerCase().replace(/^0x/, "").padStart(64, "0");
const same = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
const isAddr = (s) => /^0x[0-9a-fA-F]{40}$/.test(String(s || "").trim());
const short = (a) => (isAddr(a) ? a.slice(0, 6) + "…" + a.slice(-4) : String(a || ""));
const hex = (n) => "0x" + Number(n).toString(16);
const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";
const WETH = "0x4200000000000000000000000000000000000006";
// Uniswap v4 on Base - the same PoolManager app.js trades through.
const POOL_MANAGER = "0x498581ff718922c3f8e6a244956af099b2652b2b";
// THE DOLLAR FEEDS AND THEIR READING ARE web/prices.js's (window.CurbPrices),
// shared with the launches page so the two cannot quote different dollars for
// one launch. See readUsdNow.
const Prices = window.CurbPrices || null;

const SEL = {
  name: sig("name()"), symbol: sig("symbol()"), tokenURI: sig("tokenURI()"), decimals: sig("decimals()"),
  balanceOf: sig("balanceOf(address)"), feeEscrow: sig("feeEscrow()"),
  escrowBalanceOf: sig("balanceOfToken(address,address)"), hookOwed: sig("owed(address,address)"),
  creatorTaxBalance: sig("creatorTaxBalance()"), registry: sig("registry()"), launchOf: sig("launchOf(address)"),
  // WHAT A SWEEP PAYS THE CREATOR: the tax, and the part of the base fee the
  // platform does not take (none, at CURB's terms - but read, not assumed).
  quoteFeeBalance: sig("quoteFeeBalance()"), protocolFeeShareBps: sig("protocolFeeShareBps()"), deployer: sig("deployer()"),
  protocolFeeRecipient: sig("protocolFeeRecipient()"),
  sharingSince: sig("sharingSince(address)"),
};
const TOPIC = {
  launchCreated: topic("LaunchCreated(address,address,address,uint256,uint16)"),
  curveBuy: topic("CurveBuy(address,address,uint256,uint256,uint256,uint256)"),
  curveSell: topic("CurveSell(address,address,uint256,uint256,uint256,uint256)"),
  feesSwept: topic("FeesSwept(uint256,uint256,uint256)"),
  feesRescued: topic("FeesRescued(address,address,uint256,uint256)"),
  feeCharged: topic("FeeCharged(bytes32,address,uint256,uint256,uint256)"),
  swap: topic("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"),
  transfer: topic("Transfer(address,address,uint256)"),
  // THE CURB ROUTER'S SALE (ICurbRouter): seller, token and recipient indexed,
  // then registry, tokensIn, quoteOut, ethOut, paidAsWeth.
  routerSold: topic("SoldForEth(address,address,address,address,uint256,uint256,uint256,bool)"),
  // THE ONE-WAY SWITCH: from this log on, the creator's legs are the holders'.
  holderSharingEnabled: topic("HolderSharingEnabled(address,address,address,address,bool,uint64)"),
};

// How far back the history is read, and in what windows. A launchpad's pages
// are mostly about launches of the last few weeks; older ones are drawn from
// this far back and say so.
const MAX_LOOKBACK = 2_000_000;      // blocks: about 46 days at Base's 2 s
const WINDOW = 50_000;
const WINDOW_MIN = 500;
const TIMESTAMPS_MAX = 300;          // distinct blocks timed for the chart
const TRADES_SHOWN = 50;
// A REFUSED RANGE AND A REFUSED REQUEST ARE DIFFERENT THINGS (web/browse.js
// says the same of its launch-time scan). A block-range or result-size refusal
// halves the window and is learnt for the visit; a 429, a timeout or a page
// that is not JSON is asked again after a pause, with the window as it was.
// Every error used to halve the window, and the next success doubled it
// straight back: on a public endpoint a few 429s in a row ended the history,
// and a 2,000-block limit was met again on every other window.
const LOG_TRIES = 4;                 // a request refused for no stated reason is asked again this many times
const LOG_BACKOFF_MS = 500;          // ...after 0.5, 1, 2 and 4 seconds
const SIZE_REGROW = 16;              // windows served at a result-size ceiling before asking above it
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- the node
let rpcId = 0;
function endpoint() { return (S().chainCfg && S().chainCfg.rpc) || ""; }
/// One JSON-RPC request. A failure carries the HTTP status or the endpoint's
/// error code, because the log reads tell a refused range from a request
/// refused only for now by them (logKind).
/// WHERE A LOG READ GOES: web/config.js logsRpc when the endpoint is the
/// site's own (web/config.js rpc), as web/browse.js logsUrl says; any other
/// endpoint takes every read, logs included.
function logsUrl(url) {
  const c = window.CURB_SITE || {};
  const own = typeof c.rpc === "string" ? c.rpc.trim() : "";
  const logs = typeof c.logsRpc === "string" ? c.logsRpc.trim() : "";
  return logs && own && String(url || "").trim() === own ? logs : url;
}
async function rpc(method, params) {
  const res = await fetch(method === "eth_getLogs" ? logsUrl(endpoint()) : endpoint(), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  if (!res.ok) throw Object.assign(new Error("the endpoint answered HTTP " + res.status), { status: res.status });
  const j = await res.json();
  if (j.error) throw Object.assign(new Error(j.error.message || "the node refused " + method), { code: j.error.code, data: j.error.data });
  return j.result;
}
/// Several reads in one request where the endpoint takes a batch, one by one
/// where it does not. Each answer is its result, or null where it failed.
async function rpcBatch(calls) {
  if (!calls.length) return [];
  try {
    const res = await fetch(endpoint(), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(calls.map((c, i) => ({ jsonrpc: "2.0", id: i + 1, method: c.method, params: c.params }))),
    });
    const arr = await res.json();
    if (!Array.isArray(arr)) throw new Error("no batch");
    const byId = new Map(arr.map((r) => [r.id, r]));
    return calls.map((_, i) => { const r = byId.get(i + 1); return r && !r.error ? r.result : null; });
  } catch {
    const out = [];
    for (const c of calls) out.push(await rpc(c.method, c.params).catch(() => null));
    return out;
  }
}
const call = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);
const word0 = (raw) => { const w = words(raw || "0x"); return w.length ? wordToBig(w[0]) : null; };

function decodeString(raw) {
  if (Meta && Meta.decodeString) return Meta.decodeString(raw);
  return "";
}

// ---------------------------------------------------------------- numbers
const toFloat = (big, dec) => {
  if (big === null || big === undefined) return NaN;
  const b = BigInt(big);
  const neg = b < 0n;
  const a = neg ? -b : b;
  const base = 10n ** BigInt(dec);
  const whole = Number(a / base);
  const frac = Number(a % base) / Number(base);
  return (neg ? -1 : 1) * (whole + frac);
};
/// A figure for a person: 1.23K / 4.5M / 2.1B above a thousand, and
/// significant digits below one ("0.00001234"), never scientific notation.
function human(n, digits = 4) {
  if (!isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, "") + "B";
  if (a >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, "") + "M";
  if (a >= 1e4) return (n / 1e3).toFixed(2).replace(/\.?0+$/, "") + "K";
  if (a >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (a === 0) return "0";
  const places = Math.min(12, Math.max(digits, -Math.floor(Math.log10(a)) + digits - 1));
  return n.toFixed(places).replace(/\.?0+$/, "");
}
const usd = (n) => (isFinite(n) ? "$" + human(n, 3) : "—");

/// NOW, BY THE CHAIN'S CLOCK: the latest block's time when it was read, and the
/// wall clock's seconds since. On Base it is the wall clock give or take a
/// block; on a fork it is the fork's own time, which the wall clock put sixteen
/// days away - every trade "16d" old, and every short range of the chart empty.
/// READ ON EVERY DRAW (readHead), BEFORE ANYTHING IS DRAWN WITH IT. It used to
/// be the history scan's, with the wall clock until that scan landed - so the
/// first draw dated the dollar price by the wall ("21d ago") and the next by
/// the chain ("9h ago"). Null until read: an age is then not said at all.
const chainNow = () => (T.head ? T.head.ts + Math.floor((Date.now() - T.head.at) / 1000) : null);
async function readHead() {
  const b = await rpc("eth_getBlockByNumber", ["latest", false]).catch(() => null);
  if (b && b.timestamp) T.head = { ts: parseInt(b.timestamp, 16), at: Date.now() };
}
function ago(ts) {
  if (!ts) return "";
  const now = chainNow();
  if (now === null) return "";
  const s = Math.max(0, now - ts);
  if (s < 45) return "now";
  if (s < 3600) return Math.round(s / 60) + "m";
  if (s < 86400) return Math.round(s / 3600) + "h";
  return Math.round(s / 86400) + "d";
}

// ---------------------------------------------------------------- state
const T = {
  token: "",                 // the launch on this page
  info: null,                // { name, symbol, meta } once read
  chainId: null,
  usd: { key: "", perQuote: null, at: 0, src: "", updatedAt: 0 },   // dollars per whole quote unit, see readUsd
  spot: NaN,                 // the price on chain now, in whole quote units per token
  mode: "buy",               // the swap card's side
  quoteSeq: 0,
  hist: null,                // what the chain's events say; see scanHistory
  head: null,                // { ts, at }: the chain's clock, see chainNow
  share: null,               // { since, index } once a holder-sharing switch is found; see readShareCut
  scanning: false,
  scannedTo: 0,
  histErr: "",               // why the last history pass failed, until one succeeds; see scanHistory
  range: 0,                 // seconds shown on the chart; 0 is all
  tab: "trades",
  bal: { eth: null, quote: null, token: null, who: "" },
  clearAfter: null,          // the amount a trade was pressed with, until it ends; see actionDone
  clearArmed: null,          // that amount once the trade went through, until its refresh; see afterAction
  payWith: "eth",            // what a buy pays with: "eth" or "asset" (the pair's own) - see quoteChoices
  getWith: "eth",            // what a sale pays out in, where there is a choice
};

function view() {
  const st = S();
  const v = st.view;
  const f = st.viewFor;
  if (!v || !f || !same(f.token, T.token)) return null;
  return v;
}
const quoteDec = () => (S().ctx ? S().ctx.quoteDecimals : 18);
const quoteSym = () => (S().ctx ? App.displaySymbol(S().ctx.quoteSym || "") : "");
const isWethPair = () => !!(S().ctx && same(S().ctx.quote, WETH));
const tokenSym = () => (T.info && T.info.symbol) || "TOKEN";

// ---------------------------------------------------------------- the head
async function readInfo(token) {
  const [nm, sy, uri] = await Promise.all([
    call(token, SEL.name).catch(() => "0x"),
    call(token, SEL.symbol).catch(() => "0x"),
    call(token, SEL.tokenURI).catch(() => "0x"),
  ]);
  const cut = (s, n) => (Meta && Meta.cut ? Meta.cut(s, n) : String(s).slice(0, n));
  let meta = null;
  try { meta = Meta ? Meta.parseMeta(decodeString(uri)) : null; } catch { meta = null; }
  return { name: cut(decodeString(nm), 48), symbol: cut(decodeString(sy), 16), meta };
}

/// A LAUNCH THE SITE NO LONGER SHOWS SAYS SO, above everything on its page:
/// config.js hiddenLaunches, or a factory in hiddenFactories made it - decided
/// by the site bar (CurbBar.incident), exactly as the lists decide it. The page
/// itself keeps working, since nothing on chain stopped: its holders can still
/// sell and claim here. Said only once known; a read that failed is asked
/// again on the next draw.
const hiddenSeen = { key: "", asking: false };
async function drawHidden(v) {
  const inc = window.CurbBar && window.CurbBar.incident;
  if (!inc || !inc.any() || !isAddr(T.token)) return;
  const token = T.token;
  const key = endpoint() + "|" + token.toLowerCase();
  if (hiddenSeen.key === key || hiddenSeen.asking) return;
  if (!inc.launchNamed(token) && !(v && isAddr(v.curve))) return;
  hiddenSeen.asking = true;
  let status = "unknown";
  try { status = await inc.launchStatus(endpoint(), { token, curve: v ? v.curve : "" }); }
  catch { status = "unknown"; } finally { hiddenSeen.asking = false; }
  if (status === "unknown" || !same(token, T.token)) return;
  hiddenSeen.key = key;
  let note = $("tvHidden");
  if (status !== "hidden") { if (note) note.remove(); return; }
  if (!note) {
    note = document.createElement("p");
    note.id = "tvHidden";
    note.className = "cbHiddenNote";
    note.setAttribute("role", "status");
    const host = $("tokenView");
    if (!host) return;
    host.prepend(note);
  }
  note.textContent = "Curb no longer lists this launch. Its contracts still run, so selling and claiming stay open on this page.";
}

function link(text, href) {
  const a = document.createElement("a");
  a.textContent = text;
  a.href = href;
  a.target = "_blank";
  a.rel = "noreferrer noopener";
  return a;
}

function drawHead(v) {
  const info = T.info || { name: "", symbol: "", meta: null };
  $("tvName").textContent = info.name || short(T.token);
  $("tvSym").textContent = info.symbol ? "$" + info.symbol : "";
  if (quoteSym()) {
    $("tvPair").replaceChildren("Paired: ");
    chip($("tvPair"), quoteSym(), quoteLogo(), true);
  } else {
    $("tvPair").textContent = "";
  }
  const st = v ? v.status : 0;
  const status = $("tvStatus");
  status.className = "tvStatus " + (st === 1 ? "selling" : st === 2 ? "waiting" : st === 3 ? "graduated" : "");
  status.textContent = st === 1 ? "Selling" : st === 2 ? "Waiting" : st === 3 ? "Graduated" : "—";

  const m = info.meta || {};
  const img = $("tvImg");
  const src = m.image ? (Meta && Meta.displayUrl ? Meta.displayUrl(m.image) : m.image) : "";
  if (src) {
    if (img.getAttribute("src") !== src) img.src = src;
    img.hidden = false;
    $("tvImgLetter").hidden = true;
    img.onerror = () => { img.hidden = true; $("tvImgLetter").hidden = false; };
  } else {
    img.hidden = true;
    $("tvImgLetter").hidden = false;
  }
  $("tvImgLetter").textContent = (info.symbol || "?").slice(0, 1).toUpperCase();
  $("tvDesc").textContent = m.description || "The creator wrote no description.";
  document.title = (info.symbol ? "$" + info.symbol + " · " : "") + "Curb";

  const links = $("tvLinks");
  links.replaceChildren();
  const safe = (u) => (Meta && Meta.safeUrl ? Meta.safeUrl(u) : "");
  const disp = (u) => (Meta && Meta.displayUrl ? Meta.displayUrl(u) : u);
  if (safe(m.website)) links.append(link("Website", disp(m.website)));
  if (safe(m.twitter)) links.append(link("X", disp(m.twitter)));
  if (safe(m.telegram)) links.append(link("Telegram", disp(m.telegram)));
  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "Contract " + short(T.token);
  copy.title = "Copy the token's address";
  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(T.token); copy.textContent = "Copied"; }
    catch { copy.textContent = T.token; }
    setTimeout(() => { copy.textContent = "Contract " + short(T.token); }, 1500);
  });
  links.append(copy);
  // THE EXPLORER ONLY ON BASE ITSELF. A fork serves its own chain id, and its
  // launches exist nowhere an explorer could show.
  if (T.chainId === 8453) links.append(link("Basescan", "https://basescan.org/token/" + T.token));
}

// ---------------------------------------------------------------- prices
/// THE PRICE OF ONE WHOLE TOKEN IN WHOLE UNITS OF THE QUOTE ASSET, as a
/// float: the curve's own reserve ratio while it sells, the pool's price after.
/// A float and not an integer ratio on purpose: a fresh launch paired with an
/// 8-decimal asset costs 0.0000000082 of it per token, and integer division in
/// the asset's smallest unit made that 0 - so did the market cap.
function poolPrice(sqrtPriceX96, tokenIsC0) {
  const r = Number(sqrtPriceX96) / 2 ** 96;
  const raw = r * r;                         // currency1 raw per currency0 raw
  if (!(raw > 0)) return NaN;
  const scale = 10 ** (18 - quoteDec());
  return tokenIsC0 ? raw * scale : scale / raw;
}
async function spotPrice(v) {
  if (!v) return null;
  if (v.status === 1 || v.status === 2) {
    if (!v.tokenReserve) return null;
    return toFloat(v.quoteReserve, quoteDec()) / toFloat(v.tokenReserve, 18);
  }
  if (v.status === 3 && v.poolKey) {
    try {
      const p = await App.poolState(v.poolKey);
      if (!p.sqrtPriceX96) return null;
      const price = poolPrice(p.sqrtPriceX96, same(v.poolKey.currency0, T.token));
      return isFinite(price) ? price : null;
    } catch { return null; }
  }
  return null;
}

/// DOLLARS PER WHOLE UNIT OF THIS LAUNCH'S QUOTE ASSET, for every pair (the
/// owner's request: a market cap of "$100K", not "100 NVDAc" - and for every
/// stock, not only NVDAc). The asset's own Chainlink feed first (prices.js USD_FEEDS).
/// Where it has none, or its feed does not name itself, the asset is priced in
/// WETH through its own Uniswap v3 market (App.quoteAssetInEth - the legs the
/// ETH route trades through) and that in dollars by ETH / USD. Kept five
/// minutes. When nothing answers, the view shows the asset's own units rather
/// than a guess.
const USD_TTL_MS = 5 * 60 * 1000;
let usdLoading = null;
/// Resolves true when a new rate was read (the caller redraws), false when the
/// kept one still stands. One read at a time.
function readUsd() {
  const ctx = S().ctx;
  if (!ctx) return Promise.resolve(false);
  const key = ctx.quote.toLowerCase();
  if (T.usd.key === key && Date.now() - T.usd.at < USD_TTL_MS) return Promise.resolve(false);
  if (!usdLoading) usdLoading = readUsdNow(ctx, key).finally(() => { usdLoading = null; });
  return usdLoading;
}
/// THE READING ITSELF IS prices.js usdPerQuote: the asset's own feed, checked by
/// its description(), else WETH through App.quoteAssetInEth and ETH / USD - the
/// same order and the same source lines this function used to hold, on any
/// chain that answers for the feed.
async function readUsdNow(ctx, key) {
  let r = { per: null, src: "", updatedAt: 0 };
  if (Prices) {
    r = await Prices.usdPerQuote({ call, quote: ctx.quote, decimals: ctx.quoteDecimals, inEth: App.quoteAssetInEth })
      .catch(() => r);
  }
  T.usd = { key, perQuote: r.per, at: Date.now(), src: r.src, updatedAt: r.updatedAt };
  return true;
}
const usdPer = () => (T.usd.perQuote && isFinite(T.usd.perQuote) && T.usd.perQuote > 0 ? T.usd.perQuote : null);
/// Where the dollar figure came from, for the market cap's tooltip.
function usdSource() {
  if (!usdPer() || !T.usd.src) return "";
  const a = T.usd.updatedAt ? ago(T.usd.updatedAt) : "";
  const when = !a ? "" : a === "now" ? ", just updated" : ", its price as of " + a + " ago";
  return "1 " + quoteSym() + " = " + usd(T.usd.perQuote) + " by " + T.usd.src + when;
}

function priceFigures(price, v) {
  const supply = v ? toFloat(v.totalSupply, 18) : NaN;
  const mcap = price * supply;
  const per = usdPer();
  return { price, mcap, withUsd: per !== null, priceUsd: per !== null ? price * per : NaN, mcapUsd: per !== null ? mcap * per : NaN };
}

async function drawStats(v) {
  const price = await spotPrice(v);
  if (price === null) {
    $("tvPrice").textContent = "—";
    $("tvMcap").textContent = "—";
    $("tvBigMcap").textContent = "—";
    return;
  }
  T.spot = price;
  const f = priceFigures(price, v);
  const sym = quoteSym();
  $("tvPrice").textContent = f.withUsd ? usd(f.priceUsd) : human(f.price) + " " + sym;
  $("tvPrice").title = human(f.price, 6) + " " + sym;
  $("tvMcap").textContent = f.withUsd ? usd(f.mcapUsd) : human(f.mcap) + " " + sym;
  $("tvBigMcap").textContent = f.withUsd ? usd(f.mcapUsd) : human(f.mcap) + " " + sym;
  // IN DOLLARS, AND ONLY DOLLARS ON SCREEN (the owner's call); the figure in the
  // pair's own asset and where the dollars come from are on the tooltip.
  const inPair = human(f.mcap) + " " + sym;
  $("tvMcap").title = $("tvBigMcap").title = f.withUsd ? inPair + " - " + usdSource() : "";
  $("tvBigNote").textContent = "market cap";

  const wrap = $("tvProgressWrap");
  if (v.status === 1 || v.status === 2) {
    const thr = v.graduationThreshold;
    const pct = thr > 0n ? Number((v.realQuoteReserve * 10000n) / thr) / 100 : 0;
    $("tvThirdLabel").textContent = "To graduation";
    $("tvThird").textContent = Math.min(100, pct).toFixed(1) + "%";
    wrap.hidden = false;
    $("tvBar").style.width = Math.min(100, pct) + "%";
    $("tvProgressText").textContent = App.fmt(v.realQuoteReserve, quoteDec(), 4) + " of " +
      App.fmt(thr, quoteDec(), 4) + " " + sym + (v.status === 2 ? " · full, waiting for the move into the pool" : "");
  } else {
    $("tvThirdLabel").textContent = "Status";
    $("tvThird").textContent = v.status === 3 ? "In its pool" : "—";
    wrap.hidden = true;
  }
}

// ---------------------------------------------------------------- balances
async function readBalances(v) {
  const who = S().account;
  if (!who || !v) { T.bal = { eth: null, quote: null, token: null, who: "" }; return; }
  const ctx = S().ctx;
  const [eth, q, t] = await Promise.all([
    rpc("eth_getBalance", [who, "latest"]).then((h) => BigInt(h)).catch(() => null),
    ctx ? call(ctx.quote, SEL.balanceOf + pad(who)).then(word0).catch(() => null) : Promise.resolve(null),
    call(T.token, SEL.balanceOf + pad(who)).then(word0).catch(() => null),
  ]);
  T.bal = { eth, quote: q, token: t, who };
}

/// What the "Sell" side can spend, in its own units. On a WETH pair a buy may
/// be paid from ETH too - app.js wraps what WETH is short - so both count,
/// less a little ETH kept back for gas.
const GAS_KEEP = 300000000000000n;   // 0.0003 ETH
const spareEth = () => (T.bal.eth === null ? null : T.bal.eth > GAS_KEEP ? T.bal.eth - GAS_KEEP : 0n);
function payAvailable() {
  if (T.mode === "sell") return T.bal.token;
  if (ethSide()) {
    // ONLY THE WETH PAIR'S CURVE WITHOUT THE ROUTER SPENDS WETH FIRST: app.js
    // wraps what a curve buy is short (ensureQuoteHeld), so both count there.
    // Through the CURB router the buy is paid in ETH alone.
    if (isWethPair() && !inPool() && App.routerUsable() === false && T.bal.quote !== null && T.bal.eth !== null) {
      return T.bal.quote + spareEth();
    }
    return spareEth();
  }
  return T.bal.quote;
}

// ---------------------------------------------------------------- the swap card
// WHAT THE QUOTE SIDE OF THE CARD IS - ETH, OR THE PAIR'S OWN ASSET - chosen on
// its chip (the owner's call: everyone holds ether, so every pair takes it, and
// ETH is where the card starts). What each choice does, by path:
//   curve buy, any pair        ETH: one transaction through the CURB router,
//                              which swaps (or wraps) and buys - or the asset
//   curve sale, any pair       ETH: one transaction through the CURB router,
//                              after one unlimited approval per token - or the
//                              asset
//   pool, any pair             ETH routed in one transaction, or the asset direct
//   WETH pair, WETH chosen     WETH straight to and from the curve
// WHERE THE ROUTER CANNOT BE USED (app.js routerRoute), the flows from before it:
// a buy on a pair that is not WETH swaps first and buys after; on the WETH pair
// what WETH is short is wrapped first and what the curve pays is unwrapped
// after; and a curve sale on any other pair pays the pair's asset only.
const inPool = () => { const v = view(); return !!(v && v.status === 3); };
/// The choices the quote side offers here: "eth", "asset", in that order.
function quoteChoices() {
  // WETH BESIDE ETH ON A WETH PAIR'S CURVE TOO: ETH goes through the CURB
  // router, and an account holding WETH would otherwise have no way to spend it
  // here (review, round 2). WETH spends and pays WETH, nothing wrapped or
  // unwrapped (app.js computeCurveQuote's wethOnly).
  if (isWethPair()) return ["eth", "asset"];
  if (inPool()) return ["eth", "asset"];
  if (T.mode === "buy") return ["eth", "asset"];
  // A CURVE SALE PAYS ETH ONLY THROUGH THE CURB ROUTER: offered unless the page
  // knows the router is not here.
  return App.routerUsable() === false ? ["asset"] : ["eth", "asset"];
}
/// The choice in force: the one made for this side, if this launch offers it.
function quoteChoice() {
  const c = quoteChoices();
  const made = T.mode === "buy" ? T.payWith : T.getWith;
  return c.includes(made) ? made : c[0];
}
const ethSide = () => quoteChoice() === "eth";
/// Ether routed through the pool (one transaction), in the pool only.
const viaEth = () => inPool() && ethSide();
/// Ether on a WETH pair's curve: wrapped for a buy, unwrapped after a sale.
const curveEth = () => isWethPair() && !inPool();
/// Ether on either side of a curve trade, on any pair (app.js decides whether
/// it goes through the CURB router or the longer way).
const curveSwapEth = () => !inPool() && ethSide();
function quoteLabel() {
  if (ethSide()) return "ETH";
  if (isWethPair()) return "WETH";
  return quoteSym() || "—";
}
function payLabel() { return T.mode === "buy" ? quoteLabel() : tokenSym(); }
function getLabel() { return T.mode === "buy" ? tokenSym() : quoteLabel(); }
function payDec() { return T.mode === "buy" ? (ethSide() ? 18 : quoteDec()) : 18; }
function getDec() { return T.mode === "buy" ? 18 : (ethSide() ? 18 : quoteDec()); }

/// WHAT MOVES, WITH ITS PICTURE (the owner's call: a stock and a coin are told
/// apart at a glance). `label` into `el` after its logo; `append` keeps what is
/// already there. A logo that fails to load removes itself.
function chip(el, label, src, append) {
  if (!append) el.replaceChildren();
  if (src) {
    const img = document.createElement("img");
    img.alt = "";
    img.addEventListener("error", () => img.remove());
    img.src = src;
    el.append(img);
  }
  el.append(document.createTextNode(label));
}
/// The pair's logo, by the TRUE symbol (weth.svg for the pair shown as ETH).
const quoteLogo = () => (S().ctx && App.assetLogo ? App.assetLogo(S().ctx.quoteSym || "") : "");
/// The launch's own picture, when its creator gave one.
function tokenLogo() {
  const m = (T.info && T.info.meta) || {};
  return m.image ? (Meta && Meta.displayUrl ? Meta.displayUrl(m.image) : m.image) : "";
}

function drawSwapLabels(v) {
  const buy = T.mode === "buy";
  $("tvPayLabel").textContent = "Sell";
  // THE QUOTE SIDE'S PICTURE FOLLOWS ITS NAME: ether routed into an NVDAc pool
  // is paid in ETH, and shows ETH's.
  const quoteSide = (label) => (label === "ETH" || label === "WETH") && App.assetLogo ? App.assetLogo("WETH") : quoteLogo();
  chip($("tvPayAsset"), payLabel(), buy ? quoteSide(payLabel()) : tokenLogo());
  chip($("tvGetAsset"), getLabel(), buy ? tokenLogo() : quoteSide(getLabel()));
  const avail = payAvailable();
  $("tvPayAvail").textContent = avail === null ? "" : App.fmt(avail, payDec(), 6) + " available";
  const other = buy ? T.bal.token : ethSide() ? T.bal.eth : T.bal.quote;
  $("tvGetAvail").textContent = other === null || other === undefined ? "" : App.fmt(other, getDec(), 6) + " held";
  // THE QUOTE SIDE'S CHIP OPENS A CHOICE when there is one (ETH, or the pair's
  // asset); the other chip is the launch's own token and offers nothing.
  const pick = quoteChoices().length > 1;
  $("tvPayAsset").classList.toggle("tvPick", buy && pick);
  $("tvGetAsset").classList.toggle("tvPick", !buy && pick);
  $("tvViaRow").hidden = true;
}

/// THE CHOICE ITSELF: a small list under the chip, each entry with its picture,
/// as PONS draws it. Chosen per side, kept until changed.
function openChoice(anchor) {
  closeChoice();
  const menu = document.createElement("div");
  menu.className = "tvMenu";
  menu.id = "tvMenu";
  const logoOf = (c) => (c === "eth" ? (App.assetLogo ? App.assetLogo("WETH") : "") : quoteLogo());
  const nameOf = (c) => (c === "eth" ? "ETH" : isWethPair() ? "WETH" : quoteSym());
  for (const c of quoteChoices()) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.choice = c;
    b.className = c === quoteChoice() ? "on" : "";
    chip(b, nameOf(c), logoOf(c));
    b.addEventListener("click", () => {
      if (T.mode === "buy") T.payWith = c; else T.getWith = c;
      closeChoice();
      $("tvPay").value = "";
      drawSwapLabels(view());
      requote();
    });
    menu.append(b);
  }
  const r = anchor.getBoundingClientRect();
  menu.style.left = Math.round(r.left + window.scrollX) + "px";
  menu.style.top = Math.round(r.bottom + window.scrollY + 6) + "px";
  document.body.append(menu);
  setTimeout(() => document.addEventListener("click", closeOnOutside, { once: true }), 0);
}
function closeOnOutside(e) { const m = $("tvMenu"); if (m && !m.contains(e.target)) closeChoice(); }
function closeChoice() { const m = $("tvMenu"); if (m) m.remove(); }

/// Writes the swap card into app.js's own fields for the phase the launch is
/// in. The fields ARE what app.js reads when its button is pressed, so what
/// is quoted here and what is sent are the same inputs.
function writeFields(v) {
  const amount = ($("tvPay").value || "").trim();
  const slip = ($("tvSlip").value || "").trim();
  if (v && v.status === 3) {
    $("poolSide").value = T.mode;
    $("poolAmount").value = amount;
    $("poolSlippage").value = slip;
    $("poolVia").value = ethSide() ? "eth" : "nvdac";
  } else {
    $("curveSide").value = T.mode;
    $("curveAmount").value = amount;
    $("slippage").value = slip;
    if ($("curveVia")) $("curveVia").value = curveSwapEth() ? "eth" : "quote";
  }
}

async function requote() {
  const v = view();
  const seq = ++T.quoteSeq;
  const q = $("tvQuote");
  const text = ($("tvPay").value || "").trim();
  drawAction(v);
  if (!v || !text || v.status === 2) {
    $("tvGet").textContent = "0";
    q.textContent = v && v.status === 2
      ? "The curve is full. Once the move into the pool is completed, trading opens there."
      : "";
    return;
  }
  writeFields(v);
  let r;
  try {
    r = v.status === 3 ? await App.computePoolQuote() : await App.computeCurveQuote();
  } catch (e) {
    r = { error: (e && e.message) || String(e) };
  }
  if (seq !== T.quoteSeq) return;
  q.replaceChildren();
  if (!r || r.error) {
    $("tvGet").textContent = "0";
    const bad = document.createElement("span");
    bad.className = "bad";
    bad.textContent = r && r.error ? r.error : "This trade could not be priced.";
    q.append(bad);
    drawAction(v, true);
    return;
  }
  // THROUGH THE ROUTER A SALE PAYS ETH, so what it shows is the ETH and its floor.
  const routed = v.status !== 3 && r.via === "router";
  const ethSale = routed && T.mode === "sell";
  const out = v.status === 3 ? r.out : ethSale ? r.ethOut : r.q.out;
  const outDec = v.status === 3 ? r.outDec : getDec();
  $("tvGet").textContent = App.fmt(out, outDec, 6);
  const lines = [];
  // A BUY THE THRESHOLD CLAMPS HAS NO FIXED MINIMUM: the curve holds it to a
  // PRICE (App.buyMin) - what is left when it lands, at no worse than this.
  const clamped = v.status !== 3 && T.mode === "buy" && r.q && r.q.clamped;
  if (clamped && r.minBasis > 0n) {
    lines.push("Minimum received: no fixed amount - what is left on the curve, at no worse than " +
      App.fmt((r.min * 10n ** BigInt(quoteDec())) / r.minBasis, 18, 6) + " " + tokenSym() + " per " + quoteSym() + " spent");
  } else {
    lines.push("Minimum received: " + App.fmt(ethSale ? r.ethMin : r.min, outDec, 6) + " " + getLabel());
  }
  // THE TRADE'S OWN PRICE IMPACT - slippage is only the tolerance on top of it
  // (the owner's note: a 999 ETH buy "at 1% slippage" moved the price 100x).
  const imp = v.status === 3 ? (App.poolImpact && App.poolImpact(r)) : (App.curveImpact && App.curveImpact(r));
  if (imp && imp.bps !== null) {
    const lvl = App.impactLevel(imp.bps);
    lines.push({ text: "Price impact: " + App.impactText(imp.bps), cls: "tvImpact" + (lvl ? " " + lvl : "") });
    const warn = App.impactWarning(imp, T.mode);
    if (warn) lines.push({ text: warn, cls: "tvImpactWarn " + lvl });
  }
  // THE SWAP BETWEEN ETH AND THE PAIR'S ASSET, against Chainlink's prices
  // (App.withConversion): past 50% the quote is refused above, so this is the
  // figure and, past 5%, the warning.
  if (r.conv && App.conversionWords) {
    const lvl = App.impactLevel(r.conv.bps);
    lines.push({ text: "Conversion: " + App.impactText(r.conv.bps) + " below market", cls: "tvImpact tvConv" + (lvl ? " " + lvl : "") });
    const warn = App.conversionWords(r, quoteSym());
    if (warn) lines.push({ text: warn, cls: "tvImpactWarn " + lvl });
  }
  // AND WHEN EITHER PRICE COULD NOT BE HAD, SAID: the press sends nothing
  // through an unchecked swap (App.withConversion fails closed).
  if (r.convUnchecked && App.uncheckedWords) {
    lines.push({ text: "Conversion: not checked against Chainlink", cls: "tvImpact tvConvUnchecked warn" });
    lines.push({ text: App.uncheckedWords(r, quoteSym()), cls: "tvImpactWarn warn" });
  }
  if (v.status !== 3 && r.q) {
    // NEVER "0" FOR A FEE THAT IS NOT: cbBTC's 8 decimals put a real fee past
    // the sixth place (App.fmtSmall).
    // IN THE TRADE'S OWN UNIT ON A WETH PAIR: "WETH" when WETH is what moves,
    // as the minimum above says - it said ETH under a WETH minimum.
    // AND WHOSE THE TAX IS: the holders', once this launch shares its fees.
    lines.push((sharingOn() ? "Fee, and tax for holders, taken from this trade: " : "Fee and tax, taken from this trade: ") +
      (App.fmtSmall || App.fmt)(r.q.fee + r.q.tax, quoteDec(), 6) + " " + (isWethPair() ? quoteLabel() : quoteSym()));
    if (T.mode === "buy" && r.q.refund > 0n) {
      // HOW MUCH OF THE OFFER IS USED, said before what comes back.
      lines.push({ text: "Only " + App.fmt(r.q.spent, quoteDec(), 6) + " of the " + App.fmt(r.q.offered, quoteDec(), 6) + " " +
        (isWethPair() ? quoteLabel() : quoteSym()) + " offered will be used: this buy reaches the graduation threshold.",
        cls: "tvClamp" });
      lines.push("Refunded (past the threshold): " + App.fmt(r.q.refund, quoteDec(), 6) + " " +
        (routed ? (isWethPair() ? "ETH" : quoteSym()) + ", in the same transaction"
          : curveEth() && ethSide() ? "ETH - paid as WETH and unwrapped straight after, a second confirmation"
          : isWethPair() ? "WETH" : quoteSym()));
    }
  }
  if (!routed && T.mode === "buy" && ethSide() && isWethPair() && v.status !== 3 && T.bal.quote !== null && r.amount > T.bal.quote) {
    lines.push("Your WETH is short, so the ETH to cover it is wrapped first - one extra confirmation.");
  }
  if (!routed && T.mode === "sell" && curveEth() && ethSide()) {
    lines.push("The curve pays WETH, and it is unwrapped into ETH straight after - your wallet asks twice.");
  }
  // WETH HELD, AND AN ETH BUY THAT DOES NOT SPEND IT: said, with the way to.
  if (routed && T.mode === "buy" && isWethPair() && T.bal.quote !== null && T.bal.quote > 0n &&
      spareEth() !== null && r.amount > spareEth()) {
    lines.push("This account holds " + App.fmt(T.bal.quote, 18, 6) + " WETH, which an ETH buy does not spend: " +
      "choose WETH on the chip to spend it.");
  }
  if (routed && T.mode === "buy") {
    lines.push(isWethPair()
      ? "1 confirmation: the CURB router wraps your ETH and buys on the curve in one transaction."
      // WHAT THE SWAP IS EXPECTED TO DELIVER, AND ITS FLOOR - both, as the line
      // from before the router said them and the long page's "routed" row does.
      : "1 confirmation: the CURB router swaps your ETH into about " + App.fmt(r.mid, quoteDec(), 6) + " " +
        quoteSym() + " (at least " + App.fmt(r.midMin, quoteDec(), 6) + ") and buys on the curve in one transaction.");
  }
  if (ethSale) {
    lines.push(App.confirmationsWords(r) + ": the CURB router sells to the curve and pays you ETH in one transaction" +
      (r.steps === 1 ? "." : " - before the first sale of this token, your wallet asks once to let the router move it, with no limit."));
  }
  if (r.routerNote) lines.push(r.routerNote);
  if (v.status !== 3 && r.via === "eth") {
    // ETHER INTO A PAIR THAT IS NOT WETH, ON THE CURVE: the swap first, said with
    // its bound. (A pool quote says "eth" too, for its one-transaction route.)
    lines.push("Swapped first through Uniswap: about " + App.fmt(r.mid, quoteDec(), 6) + " " + quoteSym() +
      " (at least " + App.fmt(r.midMin, quoteDec(), 6) + "), then the curve.");
    lines.push("Two confirmations: the swap, then the buy - with an approval between them when needed.");
  }
  for (const l of lines) {
    const d = document.createElement("div");
    if (typeof l === "string") d.textContent = l;
    else { d.textContent = l.text; d.className = l.cls; }
    q.append(d);
  }
  drawAction(v, false, r);
}

/// @param r  the quote drawn, when there is one: a sale through the CURB router
///           says what its allowance is.
function drawAction(v, unpriced, r) {
  const b = $("tvAct");
  const note = $("tvActNote");
  const st = S();
  note.textContent = "";
  if (!v) { b.disabled = true; b.textContent = "Reading this launch…"; return; }
  if (st.busy) { b.disabled = true; b.textContent = "Working…"; return; }
  if (!st.account) { b.disabled = false; b.textContent = "Connect wallet"; b.dataset.act = "connect"; return; }
  if (v.status === 2) {
    b.disabled = false; b.textContent = "Complete the move"; b.dataset.act = "complete";
    return;
  }
  const text = ($("tvPay").value || "").trim();
  if (!text) { b.disabled = true; b.textContent = "Enter an amount"; delete b.dataset.act; return; }
  if (unpriced) { b.disabled = true; b.textContent = "Cannot trade this"; delete b.dataset.act; return; }
  b.disabled = false;
  b.textContent = (T.mode === "buy" ? "Buy $" : "Sell $") + tokenSym();
  b.dataset.act = "trade";
  // AN ETH BUY THROUGH THE ROUTER ASKS FOR NO ALLOWANCE AT ALL: the ether is
  // sent with the call. Only the other ways of trading approve anything.
  // ONLY THE ONE ALLOWANCE THAT IS NOT FOR EXACTLY THE TRADE IS SAID (docs.md).
  note.textContent = r && r.via === "router" && T.mode === "sell" && v.status !== 3
    ? "Approves the CURB router for this token once, with no limit." : "";
}

function wireSwap() {
  $("tvPay").addEventListener("input", () => {
    // A NUMBER OR NOTHING: the same filter the create form's amounts use.
    try { App.numericOnly($("tvPay"), payDec()); } catch { /* filter unavailable: app.js still refuses */ }
    keepTyped();
    requote();
  });
  $("tvSlip").addEventListener("input", requote);
  // THE QUOTE SIDE'S CHIP: ETH or the pair's asset, where there is a choice.
  for (const id of ["tvPayAsset", "tvGetAsset"]) {
    $(id).addEventListener("click", (e) => {
      if (!$(id).classList.contains("tvPick")) return;
      e.stopPropagation();
      if ($("tvMenu")) closeChoice(); else openChoice($(id));
    });
  }
  $("tvFlip").addEventListener("click", () => {
    T.mode = T.mode === "buy" ? "sell" : "buy";
    $("tvPay").value = "";
    drawSwapLabels(view());
    requote();
  });
  for (const b of document.querySelectorAll("#tvPcts [data-pct]")) {
    b.addEventListener("click", () => {
      const avail = payAvailable();
      if (avail === null) return;
      const part = (avail * BigInt(b.dataset.pct)) / 100n;
      $("tvPay").value = App.fmt(part, payDec(), Math.min(8, payDec())).replace(/,/g, "");
      keepTyped();
      requote();
    });
  }
  $("tvAct").addEventListener("click", () => {
    const v = view();
    const act = $("tvAct").dataset.act;
    if (act === "connect") {
      if (window.CurbBar) window.CurbBar.connect(); else $("connect").click();
      return;
    }
    if (act === "complete") { $("complete").click(); return; }
    if (act !== "trade" || !v) return;
    writeFields(v);
    // CLEARED ONCE IT WENT THROUGH: left in the field, the same figure was
    // quoted again at the price the trade had just moved, and read as what
    // the trade had given. Not while another action holds the page: this press
    // starts nothing, and the other action's outcome is not this one's.
    const startsOne = !S().busy;
    T.clearAfter = startsOne ? $("tvPay").value : null;
    T.clearArmed = null;
    (v.status === 3 ? $("poolAct") : $("curveAct")).click();
  });
}

// ---------------------------------------------------------------- the fees card
async function drawFees(v) {
  const ctx = S().ctx;
  if (!v || !ctx) return;
  const creator = v.beneficiary;
  const who = S().account;
  const sym = quoteSym();
  const qd = quoteDec();
  const you = who && same(who, creator);
  $("tvFeeWho").textContent = "Paid to " + short(creator) + (you ? " (you)" : "");
  $("tvFeeWho").title = creator;
  // ON THE CURVE, NOT YET SWEPT: the creator's part the curve still holds -
  // what a sweep credits its creator: the tax, and the share of the base fee
  // the platform does not take. ONLY WHILE THE CURVE STILL PAYS THE CREATOR:
  // once holder sharing is on, its recipient is the distributor and what it
  // holds is the holders'. Claim sweeps it in first, so it counts in "claimable
  // now" - Claim paid more than the card said.
  let unswept = null;
  if (v.status === 1 || v.status === 2) {
    try {
      const [dep, plat, tax, fee, bps] = await Promise.all([
        call(v.curve, SEL.deployer).then((r) => wordToAddress(words(r)[0])),
        call(v.curve, SEL.protocolFeeRecipient).then((r) => wordToAddress(words(r)[0])),
        call(v.curve, SEL.creatorTaxBalance).then(word0),
        call(v.curve, SEL.quoteFeeBalance).then(word0),
        call(v.curve, SEL.protocolFeeShareBps).then(word0).catch(() => 10000n),
      ]);
      // THE SWEEP CREDITS THE PLATFORM'S PART TO ITS RECIPIENT, and Claim then
      // takes that too when the creator IS that recipient - so it counts then.
      const protocol = (fee * bps) / 10000n;
      unswept = tax === null || fee === null ? null
        : (same(dep, creator) ? tax + (fee - protocol) : 0n) + (same(dep, creator) && same(plat, creator) ? protocol : 0n);
    } catch { unswept = null; }
  }
  $("tvUnswept").hidden = !(unswept !== null && unswept > 0n);
  $("tvUnswept").textContent = unswept !== null && unswept > 0n
    ? "incl. " + App.fmt(unswept, qd, 6) + " " + sym + " on the curve"
    : "";
  // CLAIMABLE NOW, across every launch that pays this address in this asset:
  // the factory's escrow, plus what the hook holds when a pool fee could not be
  // paid straight out.
  let claimable = null;
  try {
    const escrow = wordToAddress(words(await call(S().chainCfg.factory, SEL.feeEscrow))[0]);
    const [a, b] = await Promise.all([
      call(escrow, SEL.escrowBalanceOf + pad(creator) + pad(ctx.quote)).then(word0).catch(() => null),
      call(ctx.hook, SEL.hookOwed + pad(creator) + pad(ctx.quote)).then(word0).catch(() => null),
    ]);
    if (a === null && b === null) throw new Error("unread");
    claimable = (a || 0n) + (b || 0n) + (unswept || 0n);
    $("tvClaimable").textContent = App.fmt(claimable, qd, 6) + " " + sym;
    $("tvClaimableNote").textContent = "claimable";
  } catch {
    $("tvClaimable").textContent = "could not be read";
  }
  // ONE CLAIM, FOR THE ADDRESS IT PAYS: shown to that wallet, pressable when
  // there is anything to take (claimed, or swept then claimed).
  const act = $("tvClaimAct");
  act.hidden = !you;
  act.disabled = S().busy || !(claimable !== null && claimable > 0n);
  drawEarned();
}

/// WHETHER THIS LAUNCH SHARES ITS FEES WITH ITS HOLDERS: LaunchView w15 set.
function sharingOn() {
  const v = view();
  return !!(v && v.holderDistributor && !same(v.holderDistributor, ZERO));
}

/// WHERE THE CREATOR'S EARNINGS END: the switch's own log, found once. Every fee
/// line after it - in its block, after it; in a later block - paid the holders.
/// A read that fails leaves the cut unknown, and the history says so.
async function readShareCut() {
  if (!sharingOn()) { T.share = null; return; }
  if (T.share && same(T.share.token, T.token)) return;
  const g = S().graduatorAddr;
  if (!isAddr(g)) return;
  try {
    const since = Number(word0(await call(g, SEL.sharingSince + pad(T.token))));
    const logs = await rpc("eth_getLogs", [{ address: g, topics: [TOPIC.holderSharingEnabled, "0x" + pad(T.token)],
      fromBlock: hex(since), toBlock: hex(since) }]);
    const index = logs && logs.length ? parseInt(logs[0].logIndex, 16) : 0;
    T.share = { token: T.token, since, index };
  } catch { T.share = null; }
}
/// Whether a fee line at (block, logIndex) was the creator's, not the holders'.
function creatorsLine(block, index) {
  if (!sharingOn()) return true;
  if (!T.share) return true;
  return block < T.share.since || (block === T.share.since && index < T.share.index);
}

function drawEarned() {
  const h = T.hist;
  if (!h) { $("tvEarned").textContent = "…"; return; }
  const total = h.creatorEarned;
  $("tvEarned").textContent = App.fmt(total, quoteDec(), 6) + " " + quoteSym();
  // WHAT THIS FIGURE COUNTS, SAID: the curve's sweeps and the pool's fee lines.
  // On a launch still on its curve the creator's tax waits there until it is
  // swept, so "0 ETH earned" read as nothing earned beside a curve holding it.
  const v = view();
  const onCurve = !!v && (v.status === 1 || v.status === 2);
  $("tvEarnedNote").textContent = (sharingOn() ? "earned before holder sharing" : onCurve ? "swept so far" : "earned") +
    (h.partial ? " since " + (h.fromDate || "the oldest block read") : "");
}

// ---------------------------------------------------------------- the history
/// WHAT KIND OF REFUSAL: "range", "size" or "busy", sorted by web/sharing.js's
/// logError - the sorting web/browse.js uses too, so the pages read one
/// endpoint's refusals alike. Without it (sharing.js not loaded) every refusal
/// is read as a range refusal, as every error was before.
function logKind(e) {
  const Sh = window.CurbSharing;
  return Sh && typeof Sh.logError === "function" ? Sh.logError(e) : "range";
}

/// THE LOG RANGE THIS ENDPOINT IS KNOWN TO TAKE, learnt from its refusals and
/// kept for the visit, for every read here: blocks is 0 while none was
/// refused. A block-range ceiling holds; a result-size one depends on how busy
/// the blocks were, so it is tried above again once SIZE_REGROW windows went
/// through under it (web/browse.js times.cap does the same).
const logCap = { rpc: "", blocks: 0, isSize: false, served: 0 };
function capNow() {
  const url = endpoint();
  if (logCap.rpc !== url) Object.assign(logCap, { rpc: url, blocks: 0, isSize: false, served: 0 });
  return logCap;
}
/// The window to ask for: `most`, or the ceiling learnt where it is lower.
function withinCap(most) {
  const c = capNow();
  return c.blocks ? Math.min(most, c.blocks) : most;
}
/// A window of `span` blocks refused for its range or its result size: the
/// next window to ask for, learnt as the ceiling - or 0 at the floor.
function refusedSpan(span, kind) {
  if (span <= WINDOW_MIN) return 0;
  const next = Math.max(WINDOW_MIN, Math.floor(span / 2));
  const c = capNow();
  Object.assign(c, { blocks: c.blocks ? Math.min(c.blocks, next) : next, isSize: kind === "size", served: 0 });
  return next;
}
/// A window of `span` blocks answered: one at a result-size ceiling counts
/// towards lifting it.
function servedSpan(span) {
  const c = capNow();
  if (!c.blocks || !c.isSize || span < c.blocks) return;
  if (++c.served < SIZE_REGROW) return;
  c.blocks *= 2;
  c.served = 0;
  if (c.blocks >= WINDOW * 4) c.blocks = 0;
}

/// eth_getLogs over [from, to], in the windows the endpoint takes. A refused
/// range is asked again at half and learnt; a busy endpoint is asked again
/// after a pause, LOG_TRIES times, and then the error is the caller's - the
/// history is read again on the page's next pass.
async function getLogs(filter, from, to) {
  const out = [];
  let busy = 0;
  let start = from;
  while (start <= to) {
    const end = Math.min(to, start + withinCap(WINDOW) - 1);
    let logs;
    try {
      logs = await rpc("eth_getLogs", [{ ...filter, fromBlock: hex(start), toBlock: hex(end) }]);
    } catch (e) {
      const kind = logKind(e);
      if (kind === "busy") {
        // REFUSED NOW, NOT REFUSED THIS RANGE: the same window after a pause.
        if (++busy > LOG_TRIES) throw e;
        await sleep(LOG_BACKOFF_MS * 2 ** (busy - 1));
        continue;
      }
      // A RANGE OR RESULT LIMIT: ask for less, down to a floor, and keep the
      // ceiling so no later window asks for too much again.
      if (!refusedSpan(end - start + 1, kind)) throw e;
      continue;
    }
    busy = 0;
    servedSpan(end - start + 1);
    out.push(...(Array.isArray(logs) ? logs : []));
    start = end + 1;
  }
  return out;
}

/// THE LOWEST BLOCK WORTH ASKING ABOUT. On a local fork (anvil says so, and
/// where it forked) nothing of this deployment exists before the fork block,
/// and every log below it is fetched from the fork's own upstream - a public
/// endpoint that throttles, which left this page "reading" for good. On a real
/// network the method does not exist and nothing changes.
let forkFloorRead = null;
async function forkFloor() {
  if (forkFloorRead === null) {
    forkFloorRead = rpc("anvil_metadata", [])
      .then((m) => (m && m.forkedNetwork && Number(m.forkedNetwork.forkBlockNumber) >= 0 ? Number(m.forkedNetwork.forkBlockNumber) + 1 : 0))
      .catch(() => 0);
  }
  return forkFloorRead;
}

/// The block the launch was created in, searched backwards from now in
/// windows that grow - a launch of today is found in the first - and null when
/// it is older than MAX_LOOKBACK. The windows grow no wider than the endpoint
/// was seen to take, and its refusals are sorted as getLogs sorts them.
async function creationBlock(latest) {
  const factory = S().chainCfg.factory;
  if (!isAddr(factory)) return null;
  const floor = Math.max(0, latest - MAX_LOOKBACK, await forkFloor());
  let end = latest;
  let size = withinCap(2000);
  let busy = 0;
  while (end >= floor) {
    const start = Math.max(floor, end - size + 1);
    let logs;
    try {
      logs = await rpc("eth_getLogs", [{ address: factory, topics: [TOPIC.launchCreated, "0x" + pad(T.token)],
        fromBlock: hex(start), toBlock: hex(end) }]);
    } catch (e) {
      const kind = logKind(e);
      if (kind === "busy") {
        if (++busy > LOG_TRIES) throw e;
        await sleep(LOG_BACKOFF_MS * 2 ** (busy - 1));
        continue;
      }
      size = refusedSpan(end - start + 1, kind);
      if (!size) throw e;
      continue;
    }
    busy = 0;
    servedSpan(end - start + 1);
    if (Array.isArray(logs) && logs.length) return parseInt(logs[0].blockNumber, 16);
    end = start - 1;
    size = withinCap(Math.min(WINDOW * 4, size * 2));
  }
  return null;
}

const sgn128 = (w) => { const x = BigInt("0x" + w); return x >= (1n << 127n) ? x - (1n << 128n) : x; };

/// Reads what happened to this launch since it was created (or since the last
/// read): its trades on the curve and in the pool, the creator's earnings, and
/// every transfer of the token for the holder list.
async function scanHistory() {
  const v = view();
  if (!v || T.scanning) return;
  T.scanning = true;
  try {
    const latest = parseInt(await rpc("eth_blockNumber", []), 16);
    if (!T.hist) {
      const born = await creationBlock(latest);
      const from = born !== null ? born : Math.max(0, latest - MAX_LOOKBACK, await forkFloor());
      T.hist = { from, partial: born === null, fromDate: "", trades: [], transfers: [], creatorEarned: 0n,
        sweeps: 0, poolFees: 0, times: new Map(), poolId: "" };
      T.scannedTo = from - 1;
    }
    const h = T.hist;
    // THE CHAIN'S CLOCK, read every scan (see chainNow), and the launch's birth once.
    const head = await rpc("eth_getBlockByNumber", [hex(latest), false]).catch(() => null);
    if (head) T.head = { ts: parseInt(head.timestamp, 16), at: Date.now() };
    if (!h.bornTs && !h.partial) {
      const b = await rpc("eth_getBlockByNumber", [hex(h.from), false]).catch(() => null);
      if (b) h.bornTs = parseInt(b.timestamp, 16);
    }
    const from = T.scannedTo + 1;
    if (from > latest) return;
    const qd = quoteDec();

    // EVERY LOG OF THE PASS IS READ BEFORE ANY IS COUNTED. A read that fails
    // part-way leaves the pass to be made again from the same block; counted
    // as they came, the curve's trades and the creator's earnings read before
    // the failure were counted a second time on the next pass.
    const curveLogs = await getLogs({ address: v.curve,
      topics: [[TOPIC.curveBuy, TOPIC.curveSell, TOPIC.feesSwept, TOPIC.feesRescued]] }, from, latest);
    const inPool = v.status === 3 && !!v.poolKey;
    if (inPool) h.poolId = h.poolId || App.poolId(v.poolKey);
    const [swaps, fees] = inPool ? await Promise.all([
      getLogs({ address: POOL_MANAGER, topics: [TOPIC.swap, h.poolId] }, from, latest),
      getLogs({ address: v.poolKey.hooks, topics: [TOPIC.feeCharged, h.poolId] }, from, latest),
    ]) : [[], []];
    const transfers = await getLogs({ address: T.token, topics: [TOPIC.transfer] }, from, latest);

    // A SALE THROUGH THE CURB ROUTER: the curve pays the router, so its
    // CurveSell names the router as the recipient - for every such sale. The
    // seller is the router's own SoldForEth in the same transaction, for this
    // token and the same tokens in (a buy through it already names the buyer).
    const routerAddr = App.CURB_ROUTER ? App.CURB_ROUTER.address : "";
    const viaRouter = (who) => !!routerAddr && same(who, routerAddr);
    const routed = [];
    for (const l of curveLogs) {
      const w = words(l.data);
      const t0 = l.topics[0];
      const base = { block: parseInt(l.blockNumber, 16), index: parseInt(l.logIndex, 16), tx: l.transactionHash };
      if (t0 === TOPIC.curveBuy && w.length >= 4) {
        const quoteIn = wordToBig(w[0]), tokens = wordToBig(w[1]), fee = wordToBig(w[2]), tax = wordToBig(w[3]);
        const net = quoteIn - fee - tax;
        h.trades.push({ ...base, side: "buy", who: "0x" + l.topics[2].slice(26), tokens, quote: quoteIn,
          price: tokens > 0n ? toFloat(net, qd) / toFloat(tokens, 18) : NaN });
      } else if (t0 === TOPIC.curveSell && w.length >= 4) {
        const tokens = wordToBig(w[0]), quoteOut = wordToBig(w[1]), fee = wordToBig(w[2]), tax = wordToBig(w[3]);
        const gross = quoteOut + fee + tax;
        h.trades.push({ ...base, side: "sell", who: "0x" + l.topics[2].slice(26), tokens, quote: quoteOut,
          price: tokens > 0n ? toFloat(gross, qd) / toFloat(tokens, 18) : NaN });
        if (viaRouter(h.trades[h.trades.length - 1].who)) routed.push(h.trades[h.trades.length - 1]);
      } else if (t0 === TOPIC.feesSwept && w.length >= 3) {
        // AFTER THE SWITCH THE SWEEP PAYS THE DISTRIBUTOR: not the creator's.
        if (creatorsLine(base.block, base.index)) { h.creatorEarned += wordToBig(w[2]); h.sweeps += 1; }
      } else if (t0 === TOPIC.feesRescued && w.length >= 2) {
        if (creatorsLine(base.block, base.index)) { h.creatorEarned += wordToBig(w[1]); h.sweeps += 1; }
      }
    }
    if (routed.length) await namedByRouter(routed, routerAddr, from, latest);

    // IN THE POOL: the PoolManager's swaps and the hook's fee lines for it.
    if (inPool) {
      const tokenIsC0 = same(v.poolKey.currency0, T.token);
      for (const l of swaps) {
        const d = l.data.replace(/^0x/, "");
        const a0 = sgn128(d.slice(32, 64)), a1 = sgn128(d.slice(96, 128));
        const sqrtP = BigInt("0x" + d.slice(128, 192));
        const tokDelta = tokenIsC0 ? a0 : a1;
        const qDelta = tokenIsC0 ? a1 : a0;
        h.trades.push({ block: parseInt(l.blockNumber, 16), index: parseInt(l.logIndex, 16), tx: l.transactionHash,
          side: tokDelta > 0n ? "buy" : "sell", who: "", tokens: tokDelta < 0n ? -tokDelta : tokDelta,
          quote: qDelta < 0n ? -qDelta : qDelta, price: poolPrice(sqrtP, tokenIsC0), pool: true });
      }
      for (const l of fees) {
        const w = words(l.data);
        if (w.length >= 3 && creatorsLine(parseInt(l.blockNumber, 16), parseInt(l.logIndex, 16))) {
          h.creatorEarned += wordToBig(w[2]); h.poolFees += 1;
        }
      }
    }

    for (const l of transfers) {
      const tr = { from: "0x" + l.topics[1].slice(26), to: "0x" + l.topics[2].slice(26), amount: wordToBig(words(l.data)[0]) };
      h.transfers.push(tr);
      if (same(tr.to, ZERO) || same(tr.to, DEAD)) h.burned = (h.burned || 0n) + tr.amount;
    }

    h.trades.sort((a, b) => a.block - b.block || a.index - b.index);
    T.scannedTo = latest;
    await timeTrades();
    if (h.partial && !h.fromDate) {
      const b = await rpc("eth_getBlockByNumber", [hex(h.from), false]).catch(() => null);
      if (b) h.fromDate = new Date(parseInt(b.timestamp, 16) * 1000).toLocaleDateString();
    }
    T.histErr = "";
  } catch (e) {
    // THE FAILURE STAYS SAID UNTIL A PASS SUCCEEDS. drawHistory below wrote
    // over it at once, so it showed for an instant until the next pass.
    T.histErr = "The trade history could not be read from this endpoint just now (" +
      ((e && e.message) || e) + "). Prices above are read directly and are current.";
    $("tvHistNote").textContent = T.histErr;
  } finally {
    T.scanning = false;
  }
  drawHistory();
}

/// WHO SOLD, FOR SALES THE CURVE PAID TO THE CURB ROUTER: the seller its
/// SoldForEth names, matched by transaction and by the tokens sold. A sale with
/// no such event keeps the address the curve gave (the router's), and a read
/// that fails leaves every one of them as it was.
async function namedByRouter(routed, routerAddr, from, to) {
  let logs;
  try {
    logs = await getLogs({ address: routerAddr, topics: [TOPIC.routerSold, null, "0x" + pad(T.token)] }, from, to);
  } catch { return; }
  for (const t of routed) {
    const ev = logs.find((l) => l.transactionHash === t.tx && l.topics.length > 2 &&
      words(l.data).length >= 2 && wordToBig(words(l.data)[1]) === t.tokens);
    if (ev) t.who = "0x" + ev.topics[1].slice(26);
  }
}

async function timeTrades() {
  const h = T.hist;
  const want = [];
  for (let i = h.trades.length - 1; i >= 0 && want.length < TIMESTAMPS_MAX; i--) {
    const b = h.trades[i].block;
    if (!h.times.has(b) && !want.includes(b)) want.push(b);
  }
  for (let i = 0; i < want.length; i += 50) {
    const part = want.slice(i, i + 50);
    const blocks = await rpcBatch(part.map((b) => ({ method: "eth_getBlockByNumber", params: [hex(b), false] })));
    part.forEach((b, j) => { if (blocks[j]) h.times.set(b, parseInt(blocks[j].timestamp, 16)); });
  }
}

// ---------------------------------------------------------------- the chart
function drawChart() {
  const box = $("tvChart");
  const h = T.hist;
  const v = view();
  if (!h || !v) return;
  // THE MARKET CAP AT THE TIME: the remainder burned at graduation was still
  // part of the supply while the curve sold.
  const supplyNow = toFloat(v.totalSupply, 18);
  const burned = h.burned ? toFloat(h.burned, 18) : 0;
  const per = usdPer();
  const val = (price, supply) => price * supply * (per || 1);
  const pts = h.trades.filter((t) => h.times.has(t.block) && isFinite(t.price) && t.price > 0)
    .map((t) => ({ t: h.times.get(t.block), y: val(t.price, t.pool ? supplyNow : supplyNow + burned) }));
  // NOW, BY THE CHAIN'S CLOCK, at the price on chain now: the line reaches the
  // right edge instead of stopping at the last trade.
  const lastT = pts.length ? pts[pts.length - 1].t : 0;
  const now = chainNow() === null ? lastT : chainNow();
  if (isFinite(T.spot) && T.spot > 0) pts.push({ t: Math.max(now, lastT), y: val(T.spot, supplyNow) });
  const fmtY = (y) => (per ? usd(y) : human(y) + " " + quoteSym());
  box.replaceChildren();
  if (!pts.length) {
    const p = document.createElement("p");
    p.className = "tvEmpty";
    p.textContent = "No price yet.";
    box.append(p);
    return;
  }
  // A WINDOW SHOWS WHAT THE PRICE WAS THROUGH IT. It used to keep only the
  // trades inside it, so a quiet hour drew nothing; the last price before the
  // window is carried in at its start, and a flat line is the honest picture.
  const start = T.range ? now - T.range : Math.min(h.bornTs || pts[0].t, pts[0].t);
  const before = pts.filter((p) => p.t < start);
  const shown = pts.filter((p) => p.t >= start);
  if (before.length) shown.unshift({ t: start, y: before[before.length - 1].y });
  if (shown.length === 1) shown.unshift({ t: Math.min(start, shown[0].t - 60), y: shown[0].y });
  const W = Math.max(320, box.clientWidth || 640), H = Math.max(200, box.clientHeight || 300);
  const padL = 12, padR = 76, padT = 16, padB = 28;
  const t0 = shown[0].t, t1 = Math.max(shown[shown.length - 1].t, t0 + 1);
  let y0 = Math.min(...shown.map((p) => p.y)), y1 = Math.max(...shown.map((p) => p.y));
  if (y1 === y0) { y1 = y0 * 1.05 + 1e-18; y0 = y0 * 0.95; }
  const span = y1 - y0;
  y0 -= span * 0.08; y1 += span * 0.08;
  const X = (t) => padL + ((t - t0) / (t1 - t0)) * (W - padL - padR);
  const Y = (y) => padT + (1 - (y - y0) / (y1 - y0)) * (H - padT - padB);
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "none");
  const defs = document.createElementNS(NS, "defs");
  const grad = document.createElementNS(NS, "linearGradient");
  grad.id = "tvFill"; grad.setAttribute("x1", "0"); grad.setAttribute("y1", "0"); grad.setAttribute("x2", "0"); grad.setAttribute("y2", "1");
  for (const [off, op] of [["0", "0.35"], ["1", "0"]]) {
    const s = document.createElementNS(NS, "stop");
    s.setAttribute("offset", off); s.setAttribute("stop-color", "#2a6dff"); s.setAttribute("stop-opacity", op);
    grad.append(s);
  }
  defs.append(grad);
  svg.append(defs);
  // GRID AND THE VALUE LABELS ON THE RIGHT, three of them.
  for (let i = 0; i <= 2; i++) {
    const yv = y0 + ((y1 - y0) * (i + 0.5)) / 3;
    const line = document.createElementNS(NS, "line");
    line.setAttribute("x1", padL); line.setAttribute("x2", W - padR); line.setAttribute("y1", Y(yv)); line.setAttribute("y2", Y(yv));
    line.setAttribute("stroke", "#1d2633"); line.setAttribute("stroke-dasharray", "3 4");
    svg.append(line);
    const lab = document.createElementNS(NS, "text");
    lab.setAttribute("x", W - padR + 8); lab.setAttribute("y", Y(yv) + 4);
    lab.setAttribute("fill", "#94a0b0"); lab.setAttribute("font-size", "11");
    lab.textContent = fmtY(yv);
    svg.append(lab);
  }
  // TIME LABELS UNDER IT, four of them.
  for (let i = 0; i <= 3; i++) {
    const tv = t0 + ((t1 - t0) * i) / 3;
    const lab = document.createElementNS(NS, "text");
    lab.setAttribute("x", X(tv)); lab.setAttribute("y", H - 8);
    lab.setAttribute("fill", "#5f6b7c"); lab.setAttribute("font-size", "11");
    lab.setAttribute("text-anchor", i === 0 ? "start" : i === 3 ? "end" : "middle");
    const d = new Date(tv * 1000);
    lab.textContent = (t1 - t0) > 86400 * 2 ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
      : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    svg.append(lab);
  }
  const path = shown.map((p, i) => (i ? "L" : "M") + X(p.t).toFixed(1) + " " + Y(p.y).toFixed(1)).join(" ");
  const area = document.createElementNS(NS, "path");
  area.setAttribute("d", path + ` L${X(shown[shown.length - 1].t).toFixed(1)} ${H - padB} L${X(shown[0].t).toFixed(1)} ${H - padB} Z`);
  area.setAttribute("fill", "url(#tvFill)");
  svg.append(area);
  const line = document.createElementNS(NS, "path");
  line.setAttribute("d", path);
  line.setAttribute("fill", "none"); line.setAttribute("stroke", "#2a6dff"); line.setAttribute("stroke-width", "2");
  line.setAttribute("vector-effect", "non-scaling-stroke");
  svg.append(line);
  const last = shown[shown.length - 1];
  const dot = document.createElementNS(NS, "circle");
  dot.setAttribute("cx", X(last.t)); dot.setAttribute("cy", Y(last.y)); dot.setAttribute("r", "4"); dot.setAttribute("fill", "#2a6dff");
  svg.append(dot);
  box.append(svg);
}

// ---------------------------------------------------------------- trades and holders
function drawHistory() {
  const h = T.hist;
  if (!h) return;
  $("tvTradeCount").textContent = String(h.trades.length);
  $("tvHistNote").textContent = T.histErr || (h.partial
    ? "This launch is older than the history this page reads; trades and earnings are shown since " +
      (h.fromDate || "the oldest block read") + "."
    : "");
  drawEarned();
  drawChart();
  drawList();
}

function drawList() {
  const h = T.hist;
  const list = $("tvList");
  list.replaceChildren();
  if (!h) return;
  const qd = quoteDec();
  if (T.tab === "trades") {
    const rows = h.trades.slice(-TRADES_SHOWN).reverse();
    $("tvListCount").textContent = String(Math.min(TRADES_SHOWN, h.trades.length));
    if (!rows.length) {
      const e = document.createElement("div"); e.className = "tvEmptyList"; e.textContent = "No trades yet.";
      list.append(e);
      return;
    }
    for (const t of rows) {
      const row = document.createElement("div"); row.className = "tvLine";
      const arrow = document.createElement("span"); arrow.className = "tvArrow " + t.side;
      arrow.textContent = t.side === "buy" ? "↗" : "↘";
      const main = document.createElement("div"); main.className = "tvMain";
      const b = document.createElement("b"); b.textContent = human(toFloat(t.tokens, 18)) + " $" + tokenSym();
      const who = document.createElement("span");
      who.textContent = t.pool ? "in the pool" : short(t.who);
      main.append(b, who);
      const right = document.createElement("div"); right.className = "tvRight";
      const amt = document.createElement("b"); amt.textContent = human(toFloat(t.quote, qd)) + " " + quoteSym();
      right.append(amt);
      if (usdPer() !== null) {
        const u = document.createElement("span"); u.textContent = usd(toFloat(t.quote, qd) * usdPer()); right.append(u);
      }
      const when = document.createElement("span"); when.className = "tvAgo"; when.textContent = ago(h.times.get(t.block));
      row.append(arrow, main, right, when);
      list.append(row);
    }
    return;
  }
  // HOLDERS: every transfer of the token, summed. Labelled where the holder is
  // part of the launch itself rather than a person.
  const v = view();
  const bal = new Map();
  for (const tr of h.transfers) {
    if (!same(tr.from, ZERO)) bal.set(tr.from.toLowerCase(), (bal.get(tr.from.toLowerCase()) || 0n) - tr.amount);
    bal.set(tr.to.toLowerCase(), (bal.get(tr.to.toLowerCase()) || 0n) + tr.amount);
  }
  const supply = v ? v.totalSupply : 0n;
  const label = (a) => (v && same(a, v.curve) ? "bonding curve"
    : same(a, POOL_MANAGER) ? "Uniswap v4 pool"
    : same(a, DEAD) || same(a, ZERO) ? "burned"
    : v && same(a, v.beneficiary) ? "creator" : "");
  // BURNED IS NOT HELD. Transfers to the zero address (the remainder burned at
  // graduation) and to 0x…dEaD were listed as a holder, against a supply that
  // no longer counts them - the shares summed to more than 100%. They are said
  // once under the list instead.
  let burned = 0n;
  for (const a of [ZERO, DEAD]) { const b = bal.get(a); if (b && b > 0n) burned += b; bal.delete(a); }
  const rows = [...bal.entries()].filter(([, b]) => b > 0n).sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0));
  $("tvListCount").textContent = String(rows.length);
  if (!rows.length) {
    const e = document.createElement("div"); e.className = "tvEmptyList"; e.textContent = h.partial
      ? "The holder list needs the launch's whole history, which is older than this page reads."
      : "No holders yet.";
    list.append(e);
    return;
  }
  rows.slice(0, 50).forEach(([addr, b], i) => {
    const row = document.createElement("div"); row.className = "tvLine holder";
    const n = document.createElement("span"); n.className = "tvAgo"; n.textContent = "#" + (i + 1);
    const main = document.createElement("div"); main.className = "tvMain";
    const who = document.createElement("b"); who.textContent = short(addr);
    who.title = addr;
    const tag = document.createElement("span"); tag.textContent = label(addr) || (same(addr, S().account) ? "you" : "");
    main.append(who, tag);
    const right = document.createElement("div"); right.className = "tvRight";
    const amt = document.createElement("b"); amt.textContent = human(toFloat(b, 18));
    right.append(amt);
    const pct = document.createElement("span"); pct.className = "tvAgo";
    pct.textContent = supply > 0n ? (Number((b * 10000n) / supply) / 100).toFixed(2) + "%" : "";
    row.append(n, main, right, pct);
    list.append(row);
  });
  if (T.histErr) $("tvHistNote").textContent = T.histErr;
  else if (h.partial) $("tvHistNote").textContent = "Partial: from the transfers read.";
  else if (burned > 0n) $("tvHistNote").textContent = human(toFloat(burned, 18)) + " burned.";
}

function wireTabs() {
  $("tvTabTrades").addEventListener("click", () => { T.tab = "trades"; $("tvTabTrades").className = "on"; $("tvTabHolders").className = ""; drawList(); });
  $("tvTabHolders").addEventListener("click", () => { T.tab = "holders"; $("tvTabHolders").className = "on"; $("tvTabTrades").className = ""; drawList(); });
  for (const b of document.querySelectorAll("#tvRanges [data-r]")) {
    b.addEventListener("click", () => {
      T.range = Number(b.dataset.r);
      for (const o of document.querySelectorAll("#tvRanges [data-r]")) o.classList.toggle("on", o === b);
      drawChart();
    });
  }
  window.addEventListener("resize", () => { clearTimeout(wireTabs.t); wireTabs.t = setTimeout(drawChart, 150); });
}

// ---------------------------------------------------------------- drawing it all
let drawing = null;
async function drawAll() {
  const st = S();
  const tok = st.chainCfg && st.chainCfg.token;
  if (!isAddr(tok)) return;
  if (!same(tok, T.token)) {
    // ANOTHER LAUNCH: nothing of the last one's is kept.
    T.token = tok;
    T.info = null;
    T.hist = null;
    T.share = null;
    T.scannedTo = 0;
    T.histErr = "";
  }
  const v = view();
  if (T.chainId === null) {
    try { T.chainId = parseInt(await rpc("eth_chainId", []), 16); } catch { T.chainId = null; }
  }
  if (!T.info) { try { T.info = await readInfo(T.token); } catch { T.info = { name: "", symbol: "", meta: null }; } }
  // THE DOLLAR RATE WITHOUT HOLDING UP THE PAGE: its v3 quote takes seconds,
  // so the figures are drawn in the asset's units first and redrawn in
  // dollars when it lands.
  readUsd().then((fresh) => { if (fresh) redraw(); }).catch(() => {});
  drawHead(v);
  drawHidden(v);
  if (!v) { drawAction(null); return; }
  // THE CHAIN'S CLOCK BEFORE ANYTHING IS DATED WITH IT, and where the
  // creator's earnings end if the launch shares its fees.
  await Promise.all([readHead(), readShareCut()]);
  await readBalances(v);
  drawSwapLabels(v);
  await Promise.all([drawStats(v), drawFees(v)]);
  requote();
  scanHistory();
}
function redraw() {
  if (drawing) { redraw.again = true; return; }
  drawing = drawAll().catch((e) => console.error(e)).finally(() => {
    drawing = null;
    if (redraw.again) { redraw.again = false; redraw(); }
  });
}

/// After a trade pressed here: clear the amount when app.js reported success,
/// keep it (to be corrected) when it reported a refusal.
///
/// DECIDED WHEN THE TRADE ENDS, from app.js's own word on it (curb:actionDone).
/// It used to be read off the message line when the refresh landed, and that
/// refresh can land after the next action has written there: a trade refused
/// for the wrong network, then the switch pressed straight away, left "ok" on
/// the line - and the refused trade's amount, or the same figure typed again,
/// was wiped as if it had gone through.
function actionDone(e) {
  if (T.clearAfter === null) return;
  const pressed = T.clearAfter;
  T.clearAfter = null;
  T.clearArmed = e && e.detail && e.detail.ok ? pressed : null;
}

/// ONLY THE AMOUNT THAT WENT THROUGH, AND ONLY UNTIL SOMETHING NEW IS ENTERED:
/// the refresh that ends an action lands a moment after its "Done", and an
/// amount typed in that moment is the next trade's - even the same figure.
function afterAction() {
  if (T.clearArmed === null || S().busy) return;
  const pressed = T.clearArmed;
  T.clearArmed = null;
  if ($("tvPay").value === pressed) { $("tvPay").value = ""; $("tvGet").textContent = "0"; }
}

/// An amount entered by hand, or by a percentage button, is the next trade's.
function keepTyped() {
  T.clearAfter = null;
  T.clearArmed = null;
}

function start() {
  // THE CLAIM BUTTONS ARE app.js's, MOVED HERE: #owedBox lived in the settings
  // panel this view hides. The element is the same one, so app.js keeps
  // drawing and wiring it as before.
  const owed = $("owedBox");
  if (owed) $("tvOwedSlot").append(owed);
  // "UNWRAP TO ETH" TOO, into the swap card: app.js draws and wires it.
  const unwrap = $("unwrapBox");
  if (unwrap) $("tvUnwrapSlot").append(unwrap);
  // THE CARD'S ONE CLAIM PRESSES app.js's #claimAll: sweep, escrow, hook.
  $("tvClaimAct").addEventListener("click", () => { const b = $("claimAll"); if (b) b.click(); });
  const back = $("tvBack");
  if (back && window.CurbBar) back.href = window.CurbBar.withConfig("browse.html");
  wireSwap();
  wireTabs();
  document.addEventListener("curb:drawn", redraw);
  document.addEventListener("curb:actionDone", actionDone);
  document.addEventListener("curb:refreshed", () => { afterAction(); redraw(); });
  if (window.CurbBar) window.CurbBar.onAccount(() => redraw());
  // A LIGHT HEARTBEAT: the price and the trade list move while the page is
  // open, and nothing else would redraw them.
  setInterval(() => { if (!document.hidden && !S().busy) redraw(); }, 20000);
  redraw();
  openFromHash();
}

/// #trade (after a create): the swap card in view, its amount ready to type
/// into on a wide screen. #claim (from Holder fees): the holder sharing card,
/// once it is drawn.
function openFromHash() {
  const h = location.hash;
  if (h === "#trade") {
    const card = document.querySelector(".tvSwap");
    if (!card) return;
    card.scrollIntoView({ block: "center" });
    if (window.matchMedia("(min-width: 900px)").matches) $("tvPay").focus({ preventScroll: true });
  } else if (h === "#claim") {
    const go = () => { const c = $("tvShare"); if (c && !c.hidden) c.scrollIntoView({ block: "start" }); };
    document.addEventListener("curb:sharingDrawn", go, { once: true });
  }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
else start();
})();
