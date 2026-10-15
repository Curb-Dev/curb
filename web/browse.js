// DISCOVERY - the list a launchpad has to have.  (B3 / ROADMAP)
//
// Everything here is a READ. There is no wallet on this page and nothing is
// signed: the one action offered - graduating a launch that is waiting - hands
// off to the launch's own page, which already owns the sending path, its chain
// checks and its receipt handling. A second place that sends transactions is a
// second place to get that wrong.
//
// WHY THIS READS A LIST OFF THE CHAIN RATHER THAN OFF LOGS. The registry keeps
// an array precisely so this page can exist: the alternative is eth_getLogs
// over LaunchRegistered, and the upstream this project targets answers
// "eth_getLogs is limited to a 2,000 range" - about 67 minutes of Base. One
// page would cost hundreds of requests a month after launch and thousands a
// year after. launchPage() is one request for the whole page, state included.
// (Logs ARE read for one thing, the launch TIMES - see readTimes - and only
// after the cards are drawn, bounded, and never for the list itself.)
//
// THE LOOK IS AN EXPLORE GRID, after PONS (the owner's call): a square picture
// per launch with its paired asset's badge on it, the name, the $SYMBOL, the
// market cap in dollars, a thin bar to graduation and a footer with the short
// address and how long ago it launched. Sorted and filtered here, over what has
// been read - there is no indexer to ask.
(function () {

const { keccak256 } = window.CurbKeccak;
const $ = (id) => document.getElementById(id);

/// The creator's links on a card, as logos (the owner's call). Fixed markup,
/// never anything a creator wrote.
const SOCIAL_ICON = {
  web: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="8" cy="8" r="6.3" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M1.9 8h12.2M8 1.7c-1.9 2-2.8 4.1-2.8 6.3s.9 4.3 2.8 6.3M8 1.7c1.9 2 2.8 4.1 2.8 6.3s-.9 4.3-2.8 6.3" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  x: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M12.2 1.5h2.2L9.6 7l5.6 7.5h-4.4L7.4 10l-3.9 4.5H1.3l5.1-5.9L1 1.5h4.5l3.1 4.1 3.6-4.1zm-.8 11.7h1.2L4.7 2.7H3.4l8 10.5z"/></svg>',
  tg: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M14.6 2.2 1.9 7.1c-.9.4-.9.9-.2 1.1l3.3 1 1.2 3.8c.2.5.1.7.6.7.4 0 .6-.2.8-.4l1.6-1.6 3.4 2.5c.6.3 1.1.2 1.2-.6l2.2-10.4c.2-.9-.3-1.3-1.1-1zM5.6 9.4l6.6-4.2c.3-.2.6-.1.4.1l-5.4 4.9-.2 2.3-1.4-3.1z"/></svg>',
};

const utf8Hex = (s) =>
  Array.from(new TextEncoder().encode(s)).map((b) => b.toString(16).padStart(2, "0")).join("");
const sig = (s) => keccak256("0x" + utf8Hex(s)).slice(0, 10);

const SIGS = {
  registry: sig("registry()"),
  launchCount: sig("launchCount()"),
  launchPage: sig("launchPage(uint256,uint256)"),
  symbol: sig("symbol()"),
  decimals: sig("decimals()"),
  name: sig("name()"),
  // tokenURI, not tokenUri. The selector is the whole signature, so the
  // capitalisation is load-bearing - the wrong one returns nothing and every
  // launch silently loses its image.
  tokenUri: sig("tokenURI()"),
  launcherCount: sig("launcherCount()"),
  launcherAt: sig("launcherAt(uint256)"),
  quoteToken: sig("quoteToken()"),
  // Asked of a factory and of a launch's curve: the escrow a curve pays into is
  // what says which factory made it.
  feeEscrow: sig("feeEscrow()"),
  // A graduated launch's pool price, from Uniswap v4's StateView (app.js
  // poolStateWith reads the same).
  getSlot0: sig("getSlot0(bytes32)"),
  // One launch's record, read at a past block for the hero's 24-hour change.
  launchState: sig("launchState(address)"),
};
/// UNISWAP V4'S StateView ON BASE - app.js STATE_VIEW. It reads a pool's slot0
/// out of the PoolManager by the pool's id.
const STATE_VIEW = "0xa3c0c9b65bad0b08107aa264b0f3db444b867a71";
/// THE REGISTRY'S OWN RECORD OF EACH LAUNCH (LaunchRegistry.sol), the one event
/// read here: its block is when the launch was made.
const TOPIC_REGISTERED = keccak256("0x" + utf8Hex("LaunchRegistered(address,address,address)"));
/// A CURVE'S BUY (PonsV2BondingCurve.CurveBuy), read for "Just bought" - see
/// readBuys. Every launch curve emits it from its own address.
const TOPIC_CURVE_BUY = keccak256("0x" + utf8Hex("CurveBuy(address,address,uint256,uint256,uint256,uint256)"));

// ---------------------------------------------------------------- where to read
//
// THESE TWO USED TO BE A FORM ON THE PAGE - an endpoint box and a lens address
// box a visitor had to fill in before anything appeared. That is configuration,
// not the product.
//
// THE SITE BAR'S PAIR, AND NOTHING ELSE (CurbBar.config(), topbar.js): the
// link's ?rpc= and ?lens= when it carries both, else - for a URL naming
// neither - the pair app.html saved (unless app.html marked its endpoint as
// only a link's), else no registry. A URL naming only one of them is a half
// link and gets no registry, said as such (boot). This page used to parse the
// query itself - taking a lens with no rpc, which the bar would not - and fall
// back to a curb.demo.v1 key that nothing writes, so the list on screen and
// the bar's links and search could be reading two different registries
// (round 5, N45). One source means the page, its links and its search always
// name the same deployment.
const cfg = { rpc: "", lens: "" };

// ---------------------------------------------------------------- transport

let rpcId = 0;
/// One JSON-RPC request. A failure carries what kind it was - the HTTP status
/// and the endpoint's error code - because the launch-time scan treats a range
/// it was refused differently from a request that was merely refused NOW (a
/// 429, a timeout, a page that is not JSON). See logError.
async function rpcAt(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  let body;
  try { body = await res.json(); } catch {
    const e = new Error(`the endpoint answered HTTP ${res.status} with no JSON`);
    e.status = res.status;
    throw e;
  }
  if (body.error) {
    const e = new Error(body.error.message || JSON.stringify(body.error));
    e.code = body.error.code;
    e.status = res.status;
    throw e;
  }
  return body.result;
}
const callAt = (url, to, data, block) => rpcAt(url, "eth_call", [{ to, data }, block || "latest"]);

/// SEVERAL READS IN ONE REQUEST where the endpoint takes a batch, one by one
/// where it does not (token.js rpcBatch). Each answer is its result (null when
/// the endpoint answered null), or undefined when the read itself failed - the
/// two are not the same thing to the caller (timeBlocks).
/// Used for block times only; every eth_call stays a request of its own.
async function rpcBatchAt(url, calls) {
  if (!calls.length) return [];
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(calls.map((c, i) => ({ jsonrpc: "2.0", id: i + 1, method: c.method, params: c.params }))),
    });
    const arr = await res.json();
    if (!Array.isArray(arr)) throw new Error("no batch");
    const byId = new Map(arr.map((r) => [r.id, r]));
    return calls.map((_, i) => { const r = byId.get(i + 1); return r && !r.error ? r.result : undefined; });
  } catch {
    const out = [];
    for (const c of calls) out.push(await rpcAt(url, c.method, c.params).catch(() => undefined));
    return out;
  }
}

// ------------------------------------------------------------------ decoding
//
// Hand-written, because web/abi.js encodes and does not decode. It is short
// enough to be read because LaunchView is entirely STATIC - nine words of
// value plus a five-word PoolKey - so the array of them is a length followed
// by fixed-size records, with no inner offsets to follow.

const WORD = 64;
const wordAt = (hex, i) => hex.slice(i * WORD, (i + 1) * WORD);
const numAt = (hex, i) => BigInt("0x" + wordAt(hex, i));
const addrAt = (hex, i) => "0x" + wordAt(hex, i).slice(24);

// THE RECORD'S LENGTH IS READ OFF THE ANSWER, NOT ASSUMED. LaunchView grows at
// its end: a lens from before core v2 answers 14 words a record, the current
// one 16 (w14 launchedAt, w15 holderDistributor), and a later one may append
// more. The views array is the answer's last part, so its records take up
// everything after its length word: (total - viewsAt - 1) / n words each,
// which must come out whole and at least the 14 every field below needs.
const MIN_VIEW_WORDS = 14; // status, curve, quote, beneficiary, 5 numbers, poolKey(5)

/// The words per LaunchView in a launchPage answer, or a throw that says why
/// the answer is not one.
function viewStride(hex, viewsAt, n) {
  if (n === 0) return MIN_VIEW_WORDS;
  if (hex.length % WORD !== 0) throw new Error("the page's answer is not a whole number of words");
  const rest = hex.length / WORD - viewsAt - 1;
  if (rest % n !== 0) throw new Error(`the page's ${n} records do not divide its ${rest} words evenly`);
  const stride = rest / n;
  if (stride < MIN_VIEW_WORDS) throw new Error(`the page's records are ${stride} words, fewer than ${MIN_VIEW_WORDS}`);
  return stride;
}

function decodeLaunchPage(raw) {
  const hex = (raw || "0x").replace(/^0x/, "");
  if (hex.length < WORD * 2) return [];

  const tokensAt = Number(numAt(hex, 0)) * 2 / WORD;
  const viewsAt = Number(numAt(hex, 1)) * 2 / WORD;

  const n = Number(numAt(hex, tokensAt));
  const m = Number(numAt(hex, viewsAt));
  // A page whose two halves disagree is not a page to draw half of.
  if (n !== m) throw new Error(`the page returned ${n} tokens and ${m} states`);
  const stride = viewStride(hex, viewsAt, n);

  const out = [];
  for (let i = 0; i < n; i++) out.push(recordAt(hex, viewsAt + 1 + i * stride, stride, addrAt(hex, tokensAt + 1 + i)));
  return out;
}

/// ONE LAUNCH'S RECORD, starting at word `base` - inside a page, or alone as
/// launchState returns it (base 0, every word of it the record).
function recordAt(hex, base, stride, token) {
  // ONLY WHAT IS USED. The record has fourteen words - status, curve,
  // quoteToken, beneficiary, the two tradeable reserves, the real reserve,
  // the threshold and the supply, then a five-word poolKey - and this page
  // reads all but the beneficiary: seven it draws (the market cap is the
  // tradeable reserves' ratio times the supply, as token.js spotPrice has
  // it), the curve, which says which factory made the launch
  // (factoryOfLaunch), and the poolKey, whose hash is the id of the pool a
  // graduated launch trades in (readPools) and whose first currency says
  // which way round that pool's price is.
  // Decoding the rest and never reading it is how the first version of this
  // file carried a poolFee field nothing looked at: a wrong offset in an
  // unread field is a mistake no test can see. The stride counts every word,
  // read or not, because that is what says where the NEXT record starts.
  return {
    token,
    status: Number(numAt(hex, base + 0)),
    curve: addrAt(hex, base + 1),
    // THE QUOTE ASSET IS DRAWN, as the badge on the picture and the unit of
    // every figure. Launches no longer all price against the same token, and
    // a card that names one asset beside another asset's number is worse
    // than a card with no name.
    quoteToken: addrAt(hex, base + 2),
    quoteReserve: numAt(hex, base + 4),
    tokenReserve: numAt(hex, base + 5),
    realQuoteReserve: numAt(hex, base + 6),
    graduationThreshold: numAt(hex, base + 7),
    totalSupply: numAt(hex, base + 8),
    // THE POOL'S ID IS keccak256(abi.encode(poolKey)) - and the five words
    // as the lens returns them ARE that encoding (every field is static), so
    // they are hashed as they stand (app.js poolId encodes the same five).
    poolId: keccak256("0x" + hex.slice((base + 9) * WORD, (base + 14) * WORD)),
    currency0: addrAt(hex, base + 9),
    // WORD 14, WHEN THE LENS HAS IT: the registry's own clock at
    // registration, which is what the card's age is. null on a 14-word lens,
    // which falls back to the log scan below (readTimes).
    launchedAt: stride >= 15 ? Number(numAt(hex, base + 14)) : null,
    // WORD 15: the distributor this launch's creator income goes to once its
    // holder sharing is on - the "Holders earn" mark. Zero while it is off;
    // null on a lens that cannot say.
    holderDistributor: stride >= 16 ? addrAt(hex, base + 15) : null,
  };
}

const pad = (v) => BigInt(v).toString(16).padStart(WORD, "0");
const hexNum = (n) => "0x" + Number(n).toString(16);

// -------------------------------------------------------------------- figures

/// THE PROGRESS SHOWN IS THE ONE THE CURVE GRADUATES ON: real quote taken in,
/// against the threshold. NOT the tradeable reserve, which includes the phantom
/// and would read as most of the way there on an empty launch.
function progressOf(v) {
  if (v.graduationThreshold === 0n) return 0;
  const pct = Number((v.realQuoteReserve * 10000n) / v.graduationThreshold) / 100;
  return Math.min(pct, 100);
}

/// THE DECIMALS COME FROM THE ASSET. Every B20 equity measured carries 8, but
/// writing 8 in here would make that a property of this file rather than of
/// the token, and the first asset that differs would be silently wrong by
/// orders of magnitude.
///
/// AND NEVER ROUNDED AWAY. Two fixed places put a cbBTC launch's 0.0021835 at
/// "0.00 of 0.15 cbBTC" beside a bar at 1.4%: under one whole unit this keeps
/// three significant digits; from one up, at most two places ("51.48 of 60").
function fmtQuote(x, decimals) {
  // UNKNOWN SCALE, RAW UNITS, SAID AS SUCH - never a guessed 8.
  if (!Number.isInteger(decimals)) return BigInt(x).toString() + " raw units";
  const n = Number(x) / 10 ** decimals;
  if (n === 0) return "0";
  return n >= 1
    ? n.toLocaleString("en-US", { maximumFractionDigits: 2 })
    : n.toLocaleString("en-US", { maximumSignificantDigits: 3 });
}

/// A FIGURE FOR A CARD: 11.8K, 4.2M, 1.05B above a thousand, two places below,
/// three significant digits under one - never scientific notation. The exact
/// figure goes on the element's title.
function compact(n) {
  if (!isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  let a = Math.abs(n);
  const trim = (s) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);
  if (a >= 1000) {
    const units = ["K", "M", "B", "T"];
    let i = -1;
    while (a >= 1000 && i < units.length - 1) { a /= 1000; i++; }
    let s = a.toFixed(i === 0 ? 1 : 2);
    // 999,960 is 1M, not "1000K".
    if (Number(s) >= 1000 && i < units.length - 1) { a /= 1000; i++; s = a.toFixed(2); }
    return sign + trim(s) + units[i];
  }
  if (a >= 1) return sign + trim(a.toFixed(2));
  if (a === 0) return "0";
  const places = Math.min(12, Math.max(2, -Math.floor(Math.log10(a)) + 2));
  return sign + trim(a.toFixed(places));
}

/// SYMBOL AND DECIMALS PER QUOTE ASSET, asked once each. A page of 25 launches
/// on seven assets is seven pairs of calls, not fifty.
const quoteMeta = new Map();
/// One read per asset IN FLIGHT, too: a page of 25 launches on one asset used
/// to fire 25 pairs of calls at once, since the cache was written only after
/// they returned - the very burst that gets a public endpoint to refuse.
const quoteMetaInFlight = new Map();
function quoteMetaFor(rpc, asset) {
  const key = asset.toLowerCase();
  if (quoteMeta.has(key)) return Promise.resolve(quoteMeta.get(key));
  if (quoteMetaInFlight.has(key)) return quoteMetaInFlight.get(key);
  const p = readQuoteMeta(rpc, asset).finally(() => quoteMetaInFlight.delete(key));
  quoteMetaInFlight.set(key, p);
  return p;
}

async function readQuoteMeta(rpc, asset) {
  const key = asset.toLowerCase();
  // DECIMALS UNKNOWN IS null, NOT 8, AND A FAILURE IS NOT CACHED. A rate-limited
  // decimals() used to leave 8 in the cache for the session, so every WETH card
  // read 10^10 too large and every cbXRP one 100 too small - with a percentage
  // that stayed right and made the figures look plausible. Each read stands on
  // its own, and only a complete answer is kept.
  const meta = { sym: asset.slice(0, 6) + "…", decimals: null, named: false };
  let complete = true;
  const [symRaw, decRaw] = await Promise.all([
    callAt(rpc, asset, SIGS.symbol).catch(() => { complete = false; return null; }),
    callAt(rpc, asset, SIGS.decimals).catch(() => { complete = false; return null; }),
  ]);
  try { const sym = symRaw ? decodeString(symRaw) : ""; if (sym) { meta.sym = cut(sym, 16); meta.named = true; } } catch { complete = false; }
  if (decRaw && decRaw !== "0x") meta.decimals = Number(BigInt(decRaw));
  else complete = false;
  if (complete) quoteMeta.set(key, meta);
  return meta;
}

// ------------------------------------------------------------- dollars (prices.js)
//
// THE SAME FEEDS AND THE SAME CHECKS AS A LAUNCH'S OWN PAGE: window.CurbPrices
// (web/prices.js) holds the map and the reading for both, so this page and
// token.js cannot quote two dollar figures for one launch. The one leg this
// page does not take is token.js's fallback through a v3 market in WETH - that
// is a quoter simulation per asset, app.js's, which this page does not load -
// so an asset with no feed of its own shows its market cap in its own units.
const USD_TTL_MS = 5 * 60 * 1000;
/// A READ THAT FAILED IS ASKED AGAIN AFTER THIS, not after the five minutes an
/// answer is kept. It used to be kept as "no dollars" for those five minutes -
/// and, since nothing asked again after them either, for the visit: one
/// rate-limited feed call in the first page's burst left every card on that
/// asset in its own units, and out of the Market cap order.
const USD_RETRY_MS = 15 * 1000;
const usdRates = new Map();          // asset -> { per, src, updatedAt, failed, at }
const usdInFlight = new Map();
/// Whether this asset's rate should be (re)read now: never read, kept past its
/// time, or failed and due again.
function usdDue(key) {
  const kept = usdRates.get(key);
  if (!kept) return true;
  return Date.now() - kept.at >= (kept.failed ? USD_RETRY_MS : USD_TTL_MS);
}
function usdRateFor(asset) {
  const key = asset.toLowerCase();
  if (!usdDue(key)) return Promise.resolve(usdRates.get(key));
  if (usdInFlight.has(key)) return usdInFlight.get(key);
  const Prices = window.CurbPrices;
  const rpc = state.rpc;
  const p = (Prices
    ? Prices.usdPerQuote({ call: (to, data) => callAt(rpc, to, data), quote: asset })
    : Promise.resolve({ per: null, src: "", updatedAt: 0, failed: false }))
    .catch(() => ({ per: null, src: "", updatedAt: 0, failed: true }))
    .then((r) => {
      // A FAILED READ IS KEPT ONLY AS "ask again in USD_RETRY_MS" - and over a
      // rate that was read before, it is not kept at all: the last answer stands.
      const old = usdRates.get(key);
      const e = r.failed && old && old.per ? { ...old, at: Date.now() - USD_TTL_MS + USD_RETRY_MS }
        : { ...r, at: Date.now() };
      usdRates.set(key, e);
      return e;
    })
    .finally(() => usdInFlight.delete(key));
  usdInFlight.set(key, p);
  return p;
}
/// EVERY ASSET ON SCREEN WHOSE RATE IS DUE, read and drawn when it lands. Asked
/// after a page is drawn and on every tick of the clock (boot), so a failed read
/// is asked again and a kept one is refreshed after its five minutes.
function ensureRates() {
  const gen = state.gen;
  const assets = new Set(rowsAndHero().map((v) => v.quoteToken.toLowerCase()));
  for (const asset of assets) {
    if (!usdDue(asset) || usdInFlight.has(asset)) continue;
    usdRateFor(asset).then((e) => {
      if (gen !== state.gen) return;
      refreshCards();
      // A FAILED READ IS ASKED AGAIN WHEN IT IS DUE, not at the next tick after.
      if (e && e.failed) setTimeout(ensureRates, USD_RETRY_MS + 50);
    });
  }
}
/// Dollars per whole unit of this launch's asset, or null: unread, or read and
/// nothing answered.
function usdPerOf(v) {
  const r = usdRates.get((v.quoteToken || "").toLowerCase());
  return r && r.per && isFinite(r.per) && r.per > 0 ? r : null;
}

/// WHAT A WETH PAIR IS CALLED HERE: ETH, as the picker and the swap card call it
/// (app.js displaySymbol). The badge's picture still comes from the TRUE symbol.
const displaySymbol = (sym) => (sym === "WETH" ? "ETH" : sym);

// ------------------------------------------------- a graduated launch's pool
//
// A GRADUATED LAUNCH TRADES IN ITS UNISWAP V4 POOL, so its price is the pool's
// - not its curve's last one, which the pool has traded on from. One read per
// graduated card, StateView.getSlot0(poolId), started after the cards are
// drawn and never holding the grid up; a few at a time, so a page of graduated
// launches is not a burst a public endpoint refuses. A price is kept for
// POOL_TTL_MS (it moves with every swap), and a read that failed is asked
// again after POOL_RETRY_MS rather than never.
const POOL_TTL_MS = 2 * 60 * 1000;
const POOL_RETRY_MS = 15 * 1000;
const POOL_PARALLEL = 4;
const pools = new Map();             // poolId -> { sqrt: BigInt, at } | { failed, at }
const poolsInFlight = new Set();
const Q192 = 1n << 192n;

function poolDue(id) {
  const kept = pools.get(id);
  if (!kept) return true;
  return Date.now() - kept.at >= (kept.failed ? POOL_RETRY_MS : POOL_TTL_MS);
}
function readPools() {
  const gen = state.gen;
  const rpc = state.rpc;
  const want = [];
  for (const v of rowsAndHero()) {
    if (v.status !== 3 || !v.poolId || want.includes(v.poolId)) continue;
    if (poolsInFlight.has(v.poolId) || !poolDue(v.poolId)) continue;
    want.push(v.poolId);
  }
  if (!want.length) return Promise.resolve();
  for (const id of want) poolsInFlight.add(id);
  let next = 0;
  const worker = async () => {
    while (next < want.length) {
      const id = want[next++];
      try {
        const raw = await callAt(rpc, STATE_VIEW, SIGS.getSlot0 + id.replace(/^0x/, ""));
        const h = (raw || "0x").replace(/^0x/, "");
        // A pool that does not exist reads as zero; so does an address with
        // no code. Both are "no price", not a failure to ask again about.
        pools.set(id, { sqrt: h.length >= WORD ? BigInt("0x" + h.slice(0, WORD)) : 0n, at: Date.now() });
      } catch {
        pools.set(id, { failed: true, at: Date.now() });
      } finally {
        poolsInFlight.delete(id);
      }
      if (gen === state.gen) refreshCards();
    }
  };
  return Promise.all(Array.from({ length: Math.min(POOL_PARALLEL, want.length) }, worker));
}

/// THE MARKET CAP IN THE ASSET'S SMALLEST UNITS, out of a pool's sqrtPriceX96 -
/// exactly, in integers. (sqrtPriceX96 / 2^96)^2 is currency1's smallest units
/// per currency0's; the market cap is the token's supply at that price, so
/// supply * sqrt^2 / 2^192 when the token is currency0, and supply * 2^192 /
/// sqrt^2 when it is currency1. The token's own decimals cancel, as on the
/// curve. (token.js poolPrice is the same price, as a float per whole token.)
function poolCapRaw(v, sqrt) {
  const sq = sqrt * sqrt;
  if (sq === 0n) return null;
  const tokenIsC0 = v.currency0.toLowerCase() === v.token.toLowerCase();
  return tokenIsC0 ? (v.totalSupply * sq) / Q192 : (v.totalSupply * Q192) / sq;
}

/// THE MARKET CAP ON A CARD: { text, title, usd } - usd is the dollar figure
/// the Market cap sort ranks by, NaN where there is none.
///
/// ON THE CURVE it is the curve's tradeable reserves' ratio times the supply
/// (token.js spotPrice and priceFigures): quoteReserve / tokenReserve per whole
/// token, times totalSupply - which in the asset's smallest units is
/// quoteReserve * totalSupply / tokenReserve, the token's own decimals
/// cancelling.
///
/// GRADUATED, IT IS THE POOL'S PRICE times the supply (poolCapRaw), read after
/// the card is drawn (readPools) - "…" until then, and "—" where the pool gave
/// no price. The curve's last price is never a stand-in.
///
/// Either way: in dollars by the asset's feed; in the asset's units where no
/// dollar price could be read; in RAW units, said as such, where even the
/// asset's decimals could not be read - never a guessed scale.
function marketCap(v) {
  const none = (title, text = "—") => ({ text, title, usd: NaN });
  let raw;
  let where;
  if (v.status === 3) {
    const p = v.poolId ? pools.get(v.poolId) : null;
    if (!p) return none("Reading its pool's price…", "…");
    if (p.failed) return none("Its pool's price could not be read from this endpoint just now - it is asked again shortly.");
    raw = poolCapRaw(v, p.sqrt);
    if (raw === null) return none("Its Uniswap v4 pool gave no price.");
    where = "at its Uniswap v4 pool's price";
  } else if (v.status === 1 || v.status === 2) {
    if (!v.tokenReserve || v.tokenReserve === 0n) return none("The curve holds no tokens to price against.");
    raw = (v.quoteReserve * v.totalSupply) / v.tokenReserve;
    where = "at the curve's price";
  } else {
    return none("");
  }
  const sym = displaySymbol(v.quoteSym || "");
  const qd = v.quoteDecimals;
  if (!Number.isInteger(qd)) {
    return {
      text: `${compact(Number(raw))} raw units ${sym}`.trim(),
      title: `${raw} of ${sym || "the asset"}'s smallest units ${where} - its decimals could not be read, so no scale is guessed`,
      usd: NaN,
    };
  }
  const whole = window.CurbPrices ? window.CurbPrices.toFloat(raw, qd) : Number(raw) / 10 ** qd;
  const inPair = `${compact(whole)} ${sym}`.trim();
  const rate = usdPerOf(v);
  if (rate) {
    const usd = whole * rate.per;
    return {
      text: "$" + compact(usd),
      // THE FIGURE IN THE PAIR'S OWN ASSET, AND WHERE THE DOLLARS COME FROM, on
      // the tooltip - as the launch's own page puts them.
      title: `${inPair} ${where} - 1 ${sym} = $${compact(rate.per)} by ${rate.src}${priceAge(rate.updatedAt)}`,
      usd,
    };
  }
  // WHY THERE ARE NO DOLLARS, said as it is: not read yet, refused just now
  // (asked again shortly - usdRateFor), or no feed that names itself.
  const kept = usdRates.get((v.quoteToken || "").toLowerCase());
  const why = !kept ? "Its dollar price is being read."
    : kept.failed ? `The dollar price of ${sym || "this asset"} could not be read just now - it is asked again shortly.`
    : `No dollar price is known for ${sym || "this asset"} (no Chainlink feed that names itself), so this is in its own units.`;
  return { text: inPair, title: `${inPair} ${where}. ${why}`, usd: NaN };
}

/// HOW OLD THE DOLLAR PRICE IS, as the launch's own page says it (token.js
/// usdSource): an equity feed stops outside market hours, and a frozen price
/// should not read as a current one here when it does not there. By the
/// CHAIN'S clock, as the page's ages are - a fork's runs weeks from the wall's -
/// so nothing is said until the chain's time has been read (refreshCards
/// redraws the tooltip then).
function priceAge(updatedAt) {
  const now = chainNow();
  if (!updatedAt || now === null) return "";
  const s = Math.max(0, now - Number(updatedAt));
  if (s < 45) return ", just updated";
  const a = s < 3600 ? Math.round(s / 60) + "m" : s < 86400 ? Math.round(s / 3600) + "h" : Math.round(s / 86400) + "d";
  return ", its price as of " + a + " ago";
}

// ---------------------------------------------------------- when each launched
//
// THE CHAIN KEEPS NO LAUNCH TIME, so it is the block of the registry's own
// LaunchRegistered event, and that block's timestamp. Read AFTER the cards are
// drawn, so nothing waits on it, walking back from the newest block a window at
// a time - every launch in a window, not only the ones on screen, so a later
// "Show older" finds its launches already placed.
//
// WHAT IT COSTS, AND WHAT KEEPS THAT DOWN. A public endpoint limits a log range
// to 2,000 blocks - about 67 minutes of Base - so eight days is up to 173
// windows, a request each. (A launch time kept on chain - in the registry's
// record, returned by the lens - would make all of this one read. That is a
// contract change, and the owner's call.) Until then:
//  - it stops as soon as every launch on screen is placed (the registry only
//    appends, so the oldest one on screen is the last one found);
//  - never below the block this chain was forked at, where nothing of this
//    deployment can be, and never more than LOOKBACK_DAYS back - "8d+ ago";
//  - ONE READ SAYS WHICH LAUNCHES ARE OLDER THAN THAT: launchCount() asked AT
//    the block eight days back. Every index below that count was registered
//    before it, so those cards read "8d+ ago" with no window scanned - which is
//    what Oldest, and a registry adding a few launches a day, used to pay the
//    whole walk for. An endpoint that keeps no state that old refuses the read,
//    and the walk decides instead;
//  - WHAT WAS FOUND IS KEPT in this browser, per endpoint and registry (a
//    launch's block never changes), with the range already scanned, so a later
//    visit scans only the blocks made since - once it has checked that the
//    block it stopped at is still the same block (a fork rebuilt at the same
//    addresses is not).
//
// A REFUSED RANGE AND A REFUSED REQUEST ARE DIFFERENT THINGS. Only a range or
// result-size refusal halves the window; a 429, a timeout or a page that is not
// JSON is asked again after a pause, with the window as it was. Every error
// used to halve it for the visit, and four in a row ended launch times for the
// visit. A scan that does fail is tried again later - after TIMES_RETRY_MS,
// doubling, and whenever a new page is read.
const BASE_BLOCK_S = 2;
const LOOKBACK_DAYS = 8;
const LOOKBACK_BLOCKS = (LOOKBACK_DAYS * 86400) / BASE_BLOCK_S;
const LOG_WINDOW = 2000;             // the public endpoint's own limit, to start
const LOG_WINDOW_MAX = 100000;
const LOG_WINDOW_MIN = 250;
const LOG_TRIES = 4;                 // a request refused for no stated reason is asked again this many times
const LOG_BACKOFF_MS = 500;          // ...after 0.5, 1, 2 and 4 seconds
const SIZE_REGROW = 16;              // windows served at a result-size ceiling before asking above it
const TIMES_RETRY_MS = 20 * 1000;    // a failed scan is tried again after this, doubling...
const TIMES_RETRY_MAX_MS = 5 * 60 * 1000;   // ...up to this
const FRESH_S = 3600;                // "5s ago" is green under an hour
const TIMES_KEY = "curb.browse.times.v1";
const TIMES_KEEP = 2000;             // launches kept per registry, at most
const TIMES_KEEP_REGISTRIES = 6;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// WHAT KIND OF REFUSAL. "range": the window was too wide, said in so many
/// words ("eth_getLogs is limited to a 2,000 range") - a ceiling that holds.
/// "size": too many results, or a response too large (-32005, "more than N
/// results", "response size") - a ceiling that depends on how busy the blocks
/// were, so it is tried above again later. Anything else - a 429, "rate
/// limit", a timeout, a page that is not JSON - is "busy": the same window
/// again, after a pause.
///
/// SIZE IS ASKED BEFORE RANGE. The real result-size refusals name a block
/// range as well - Infura's "query returned more than 10000 results. Try with
/// this block range [..]", Alchemy's "Log response size exceeded. You can make
/// eth_getLogs requests with up to a 2K block range ..." - and asked the other
/// way round they were filed as fixed ceilings that never grow back.
function logError(e) {
  const msg = String((e && e.message) || "");
  if ((e && (e.status === 429 || e.code === 429)) || /rate|too many requests|timeout|timed out/i.test(msg)) return "busy";
  if ((e && e.code === -32005) ||
      /more than [\d,]+ (results|logs)|query returned|too many (results|logs)|response size|size exceed/i.test(msg)) {
    return "size";
  }
  if (/range|too many blocks|limit exceeded/i.test(msg)) return "range";
  return "busy";
}

const times = {
  registry: "",
  rpc: "",
  head: null,            // { block, ts, at, hash }: the chain's clock when read
  floor: null,           // the lowest block worth asking about
  floorIsLookback: false,
  olderBelow: 0,         // launches with an index below this were made before the lookback
  bottom: null,          // the lowest block scanned so far, contiguously from the head
  kept: null,            // { top, bottom }: scanned on an earlier visit, and checked
  window: LOG_WINDOW,
  cap: LOG_WINDOW_MAX,   // the largest range to ask for
  capIsSize: false,      // whether that ceiling came from a result-size refusal
  served: 0,             // windows served in a row at a result-size ceiling
  blockOf: new Map(),    // token (lower case) -> block of its LaunchRegistered
  tsOf: new Map(),       // block -> timestamp
  tsTried: new Set(),    // blocks whose time was asked for, answered or not
  failed: "",
  failedAt: 0,
  retryMs: 0,
  retryTimer: null,
  running: null,
};

/// THE CHAIN'S "NOW", in seconds: the newest block's time when it was read, and
/// the wall clock's seconds since. On Base the block time is the wall clock
/// give or take a block; on a fork it is the fork's own, which the wall clock
/// can put weeks away (token.js chainNow says the same).
function chainNow() {
  if (!times.head) return null;
  return times.head.ts + Math.floor((Date.now() - times.head.at) / 1000);
}

/// Whether the registry said this launch already existed LOOKBACK_DAYS ago.
const olderThanLookback = (v) => Number.isInteger(v.index) && v.index < times.olderBelow;

/// WHEN THIS LAUNCH WAS MADE, AS FAR AS IS KNOWN: { ts } once read, { older }
/// past the lookback, { unknown } where the chain could not say, { pending }
/// while it is still being read.
function timeOf(v) {
  // THE CHAIN'S OWN RECORD FIRST (LaunchView w14). Zero is a record that says
  // nothing, never a launch at the epoch.
  if (v.launchedAt !== null && v.launchedAt !== undefined) return v.launchedAt > 0 ? { ts: v.launchedAt } : { unknown: true };
  const key = v.token.toLowerCase();
  if (times.blockOf.has(key)) {
    const b = times.blockOf.get(key);
    const ts = times.tsOf.get(b);
    if (ts !== undefined) return { ts };
    return times.tsTried.has(b) || times.failed ? { unknown: true } : { pending: true };
  }
  if (olderThanLookback(v)) return { older: true };
  if (times.bottom !== null && times.floor !== null && times.bottom <= times.floor) {
    return times.floorIsLookback ? { older: true } : { unknown: true };
  }
  return times.failed ? { unknown: true } : { pending: true };
}

function ageText(t) {
  if (t.older) return `${LOOKBACK_DAYS}d+ ago`;
  if (t.unknown) return "—";
  if (t.ts === undefined) return "";
  const now = chainNow();
  if (now === null) return "";
  const s = Math.max(0, now - t.ts);
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

let forkFloorRead = null;
/// THE LOWEST BLOCK WORTH ASKING ABOUT on a local fork: anvil says where it
/// forked, and nothing of this deployment exists below that (token.js
/// forkFloor). On a real network the method does not exist and this is 0.
function forkFloor(rpc) {
  if (forkFloorRead === null) {
    forkFloorRead = rpcAt(rpc, "anvil_metadata", [])
      .then((m) => (m && m.forkedNetwork && Number(m.forkedNetwork.forkBlockNumber) >= 0
        ? Number(m.forkedNetwork.forkBlockNumber) + 1 : 0))
      .catch(() => 0);
  }
  return forkFloorRead;
}

/// WHETHER A LAUNCH'S TIME COMES FROM THE LOGS AT ALL: only on a lens that does
/// not return it (14 words a record). Everything below is that fallback; with
/// the current lens no log is read for a launch time.
const scanned = (v) => v.launchedAt === null || v.launchedAt === undefined;

/// Whether a launch on screen still has no block, with blocks left to look in.
/// A launch the registry said is older than the lookback is not looked for.
function timesWanted() {
  if (times.failed) return false;
  if (times.bottom !== null && times.floor !== null && times.bottom <= times.floor) return false;
  return state.rows.some((v) => scanned(v) && !times.blockOf.has(v.token.toLowerCase()) && !olderThanLookback(v));
}
/// Whether a launch on screen has its block but its block's time was never
/// asked for.
function blockTimesWanted() {
  return state.rows.some((v) => {
    if (!scanned(v)) return false;
    const b = times.blockOf.get(v.token.toLowerCase());
    return b !== undefined && !times.tsTried.has(b);
  });
}

/// Reads what is missing, one pass at a time. A pass already running picks up
/// rows added while it runs, since it asks timesWanted after every window; rows
/// added after its last window get a pass of their own when it ends. Each pass
/// ends - the walk stops at its floor, and a block's time is asked for once - so
/// this never loops. A FAILED PASS IS NOT THE END OF THE VISIT: it is tried
/// again when its pause is over, by its timer or by the next call here.
function readTimes() {
  if (times.failed && Date.now() - times.failedAt >= times.retryMs) times.failed = "";
  if (!times.running && !times.failed) {
    times.running = scanTimes().then(() => { times.retryMs = 0; })
      .catch((e) => {
        times.failed = (e && e.message) || String(e);
        times.failedAt = Date.now();
        times.retryMs = Math.min(TIMES_RETRY_MAX_MS, times.retryMs ? times.retryMs * 2 : TIMES_RETRY_MS);
        clearTimeout(times.retryTimer);
        times.retryTimer = setTimeout(readTimes, times.retryMs);
      })
      .finally(() => {
        times.running = null;
        refreshCards();
        if (!times.failed && (timesWanted() || blockTimesWanted())) readTimes();
      });
  }
  return times.running || Promise.resolve();
}

// ---- what an earlier visit found, kept in this browser
//
// PER VIEWER AND NEVER RELIED ON: storage that is blocked, full or cleared
// gives an empty start, and the scan reads what it needs from the chain.
const keptKey = (rpc, registry) => rpc + "|" + registry.toLowerCase();
function loadKeptStore() {
  try { const s = JSON.parse(localStorage.getItem(TIMES_KEY) || "{}"); return s && typeof s === "object" ? s : {}; }
  catch { return {}; }
}
/// The range an earlier visit scanned, with what it found filed into `times` -
/// or null when there is none, or the block it stopped at is not the same block
/// any more.
async function keptRange(rpc, registry) {
  const store = loadKeptStore();
  const e = store[keptKey(rpc, registry)];
  if (!e || !Number.isInteger(e.top) || !Number.isInteger(e.bottom) || typeof e.topHash !== "string") return null;
  let same = false;
  try {
    const b = await rpcAt(rpc, "eth_getBlockByNumber", [hexNum(e.top), false]);
    same = !!b && b.hash === e.topHash;
  } catch { same = false; }
  if (!same) {
    delete store[keptKey(rpc, registry)];
    try { localStorage.setItem(TIMES_KEY, JSON.stringify(store)); } catch { /* not kept */ }
    return null;
  }
  for (const [token, block] of Object.entries(e.blocks || {})) {
    if (/^0x[0-9a-f]{40}$/.test(token) && Number.isInteger(block)) times.blockOf.set(token, block);
  }
  for (const [block, ts] of Object.entries(e.ts || {})) {
    if (Number.isInteger(ts)) { times.tsOf.set(Number(block), ts); times.tsTried.add(Number(block)); }
  }
  return { top: e.top, bottom: e.bottom };
}
/// Files what is known now: every block found and its time, and the range
/// scanned without a gap from the newest block down.
function keepTimes() {
  if (!times.head || !times.head.hash) return;
  try {
    const store = loadKeptStore();
    const blocks = {};
    const ts = {};
    for (const [token, block] of [...times.blockOf].slice(-TIMES_KEEP)) {
      blocks[token] = block;
      if (times.tsOf.has(block)) ts[block] = times.tsOf.get(block);
    }
    store[keptKey(times.rpc, times.registry)] =
      { top: times.head.block, topHash: times.head.hash, bottom: times.bottom, blocks, ts, at: Date.now() };
    const keys = Object.keys(store).sort((a, b) => (store[b].at || 0) - (store[a].at || 0));
    for (const k of keys.slice(TIMES_KEEP_REGISTRIES)) delete store[k];
    localStorage.setItem(TIMES_KEY, JSON.stringify(store));
  } catch { /* storage refused: nothing is kept, and nothing depends on it */ }
}

async function scanTimes() {
  const rpc = state.rpc;
  const registry = state.registry;
  if (!rpc || !registry) return;
  if (times.registry !== registry || times.rpc !== rpc) {
    Object.assign(times, { registry, rpc, head: null, floor: null, floorIsLookback: false, olderBelow: 0,
      bottom: null, kept: null, window: LOG_WINDOW, cap: LOG_WINDOW_MAX, capIsSize: false, served: 0,
      failed: "", retryMs: 0 });
    times.blockOf.clear();
    times.tsOf.clear();
    times.tsTried.clear();
  }
  if (!times.head) {
    const block = parseInt(await rpcAt(rpc, "eth_blockNumber", []), 16);
    const head = await rpcAt(rpc, "eth_getBlockByNumber", [hexNum(block), false]);
    if (!head) throw new Error("the endpoint did not describe its newest block");
    const byLookback = block - LOOKBACK_BLOCKS;
    const fork = await forkFloor(rpc);
    const floorIsLookback = byLookback > 0 && byLookback >= fork;
    // ONE READ FOR EVERY LAUNCH OLDER THAN THE LOOKBACK (see above). Refused -
    // no state kept that far back - it stays 0, and the walk decides.
    let olderBelow = 0;
    if (floorIsLookback) {
      try {
        const raw = await callAt(rpc, registry, SIGS.launchCount, hexNum(byLookback));
        if (raw && raw !== "0x") olderBelow = Number(BigInt(raw));
      } catch { olderBelow = 0; }
    }
    const kept = await keptRange(rpc, registry);
    Object.assign(times, {
      head: { block, ts: parseInt(head.timestamp, 16), at: Date.now(), hash: head.hash || "" },
      floor: Math.max(0, byLookback, fork), floorIsLookback, olderBelow, bottom: block + 1, kept,
    });
  }
  let busy = 0;
  while (timesWanted()) {
    if (state.registry !== registry) return;
    const top = times.bottom - 1;
    // SCANNED ON AN EARLIER VISIT: stepped over, not asked again.
    const k = times.kept;
    if (k && top <= k.top && top >= k.bottom) {
      times.bottom = Math.max(k.bottom, times.floor);
      keepTimes();
      continue;
    }
    const from = Math.max(times.floor, top - times.window + 1, k && top > k.top ? k.top + 1 : 0);
    let logs;
    try {
      logs = await rpcAt(rpc, "eth_getLogs", [{ address: registry, topics: [TOPIC_REGISTERED],
        fromBlock: hexNum(from), toBlock: hexNum(top) }]);
    } catch (e) {
      const kind = logError(e);
      if (kind === "busy") {
        // REFUSED NOW, NOT REFUSED THIS RANGE: the same window after a pause.
        busy += 1;
        if (busy > LOG_TRIES) throw e;
        await sleep(LOG_BACKOFF_MS * 2 ** (busy - 1));
        continue;
      }
      // A RANGE OR RESULT LIMIT: ask for less, down to a floor, and remember
      // the ceiling so the next window does not ask for too much again.
      if (times.window <= LOG_WINDOW_MIN) throw e;
      times.window = Math.max(LOG_WINDOW_MIN, Math.floor(times.window / 2));
      times.cap = times.window;
      times.capIsSize = kind === "size";
      times.served = 0;
      continue;
    }
    busy = 0;
    for (const l of logs || []) {
      if (!l.topics || l.topics.length < 2) continue;
      times.blockOf.set(("0x" + l.topics[1].slice(26)).toLowerCase(), parseInt(l.blockNumber, 16));
    }
    times.bottom = from;
    if (times.window < times.cap) {
      times.window = Math.min(times.cap, times.window * 2);
    } else if (times.capIsSize && ++times.served >= SIZE_REGROW && times.cap < LOG_WINDOW_MAX) {
      // A RESULT-SIZE CEILING WAS ABOUT THOSE BLOCKS, not every block: tried
      // above again once enough windows have gone through under it.
      times.cap = Math.min(LOG_WINDOW_MAX, times.cap * 2);
      times.served = 0;
    }
    await timeBlocks(rpc);
    keepTimes();
    refreshCards();
  }
  await timeBlocks(rpc);
  keepTimes();
}

/// THE TIMESTAMP OF EVERY BLOCK A LAUNCH ON SCREEN WAS MADE IN, in batches. A
/// block the endpoint answered for is asked once; one whose read FAILED is left
/// unasked and fails the pass, so it is asked again with the rest when the pass
/// is retried (readTimes) - not left at "—" for the visit.
async function timeBlocks(rpc) {
  const want = [];
  for (const v of state.rows) {
    if (!scanned(v)) continue;
    const b = times.blockOf.get(v.token.toLowerCase());
    if (b !== undefined && !times.tsTried.has(b) && !want.includes(b)) want.push(b);
  }
  let failed = 0;
  for (let i = 0; i < want.length; i += 50) {
    const part = want.slice(i, i + 50);
    const blocks = await rpcBatchAt(rpc, part.map((b) => ({ method: "eth_getBlockByNumber", params: [hexNum(b), false] })));
    part.forEach((b, j) => {
      if (blocks[j] === undefined) { failed += 1; return; }
      times.tsTried.add(b);
      if (blocks[j] && blocks[j].timestamp) times.tsOf.set(b, parseInt(blocks[j].timestamp, 16));
    });
  }
  if (failed) throw new Error(`the time of ${failed} launch block(s) could not be read`);
}

// ------------------------------------------------------------ "Just bought"
//
// THE LAUNCHES SOMEBODY IS BUYING, newest buy first (the owner's call; not
// PONS's "Recent buys"). There is no indexer, so the last buy of each curve is
// read from the curves' own CurveBuy events: ONE eth_getLogs over the newest
// blocks, by topic0 alone - every launch curve emits it from its own address,
// and a request naming hundreds of addresses is one many endpoints refuse -
// and only the curves of the launches loaded here are kept from the answer -
// and of their buys, only those worth about $5 or more (buyCounts).
//
// THE WINDOW IS THE PUBLIC ENDPOINT'S OWN LIMIT, 2,000 blocks (about 67
// minutes of Base), learnt down the way the launch-time scan learns it
// (logError): a refused range is asked again at half, down to LOG_WINDOW_MIN;
// a busy endpoint is asked again after a pause. What was found is kept for
// the visit, so a launch bought an hour ago keeps its place after its buy has
// left the window. A launch with no buy seen goes after those with one, by
// launch time. Read again every ~15 s while the order is on screen.
const buys = {
  rpc: "",
  at: new Map(),         // curve (lower case) -> { block, idx } of its newest buy seen
  window: LOG_WINDOW,
  running: null,
  failed: "",
};

function readBuys() {
  if (buys.running) return buys.running;
  buys.running = scanBuys()
    .then(() => { buys.failed = ""; })
    .catch((e) => { buys.failed = (e && e.message) || String(e); })
    .finally(() => { buys.running = null; });
  return buys.running;
}

async function scanBuys() {
  const rpc = state.rpc;
  if (!rpc || !state.rows.length) return;
  if (buys.rpc !== rpc) { buys.rpc = rpc; buys.at.clear(); buys.window = Math.min(LOG_WINDOW, times.cap); }
  const head = parseInt(await rpcAt(rpc, "eth_blockNumber", []), 16);
  if (!Number.isFinite(head)) throw new Error("the endpoint did not say which block it is at");
  const floor = await forkFloor(rpc);
  let busy = 0;
  for (;;) {
    const from = Math.max(0, floor, head - buys.window + 1);
    let logs;
    try {
      logs = await rpcAt(rpc, "eth_getLogs", [{ topics: [TOPIC_CURVE_BUY], fromBlock: hexNum(from), toBlock: hexNum(head) }]);
    } catch (e) {
      const kind = logError(e);
      if (kind === "busy") {
        busy += 1;
        if (busy > LOG_TRIES) throw e;
        await sleep(LOG_BACKOFF_MS * 2 ** (busy - 1));
        continue;
      }
      if (buys.window <= LOG_WINDOW_MIN) throw e;
      buys.window = Math.max(LOG_WINDOW_MIN, Math.floor(buys.window / 2));
      continue;
    }
    if (state.rpc !== rpc) return;
    // THE CURVES ON SCREEN ONLY: anybody's PONS-style curve on the chain emits
    // the same event.
    const rowOf = new Map(state.rows.map((v) => [String(v.curve || "").toLowerCase(), v]));
    const known = new Set(rowOf.keys());
    const moved = new Set();
    const list = (Array.isArray(logs) ? logs : []).filter((l) => known.has(String((l && l.address) || "").toLowerCase()));
    // THE DOLLAR RATE OF EVERY ASSET BOUGHT IN, before the buys are weighed
    // (buyCounts): kept for five minutes, so this is a read only now and then.
    const assets = new Set(list.map((l) => String(rowOf.get(String(l.address).toLowerCase()).quoteToken || "").toLowerCase()));
    await Promise.all([...assets].filter(isAddress).map((a) => usdRateFor(a).catch(() => null)));
    if (state.rpc !== rpc) return;
    for (const l of list) {
      const c = String((l && l.address) || "").toLowerCase();
      if (!buyCounts(rowOf.get(c), l.data)) continue;
      const block = parseInt(l.blockNumber, 16);
      const idx = parseInt(l.logIndex, 16) || 0;
      if (!Number.isFinite(block)) continue;
      const was = buys.at.get(c);
      if (!was || block > was.block || (block === was.block && idx > was.idx)) {
        buys.at.set(c, { block, idx, ts: was && was.block === block ? was.ts : undefined });
        // NEWER THAN WHAT WAS SEEN, OR THAN THE RECORD THE CARD WAS DRAWN FROM.
        if (was || block >= (rowOf.get(c).readAt || 0)) moved.add(c);
      }
    }
    await timeBuys(rpc);
    // A LAUNCH BOUGHT SINCE IS READ AGAIN: its card showed the reserves it had
    // when the page loaded, so it jumped to the top still saying "0%" (the
    // owner's "Just bought does not work"). And one that reached its threshold
    // leaves the list, which is bonding launches only.
    if (moved.size) await rereadRows(rpc, state.rows.filter((v) => moved.has(String(v.curve || "").toLowerCase())), head);
    return;
  }
}

/// ONLY A BUY WORTH ABOUT $5 OR MORE MOVES A LAUNCH UP "Just bought". The curve
/// takes a buy of any size and emits CurveBuy for it, so a 1-wei buy every
/// block kept a launch first for the gas alone. The spend is the event's
/// quoteIn, valued at the asset's own feed (usdPerOf) where it has a price;
/// where it has none, at least a thousandth of a whole unit counts. A buy whose
/// asset's decimals are unread cannot be weighed, and does not count.
const JUST_BOUGHT_MIN_USD = 5;
const JUST_BOUGHT_FLOOR_PER_UNIT = 1000n;
function buyCounts(v, data) {
  const h = String(data || "").replace(/^0x/, "");
  if (!v || h.length < WORD) return false;
  const quoteIn = BigInt("0x" + h.slice(0, WORD));
  const qd = v.quoteDecimals;
  if (!Number.isInteger(qd)) return false;
  const rate = usdPerOf(v);
  if (rate) {
    const whole = window.CurbPrices ? window.CurbPrices.toFloat(quoteIn, qd) : Number(quoteIn) / 10 ** qd;
    return whole * rate.per >= JUST_BOUGHT_MIN_USD;
  }
  return quoteIn * JUST_BOUGHT_FLOOR_PER_UNIT >= 10n ** BigInt(qd);
}

/// WHEN EACH BUY WAS, from its block, so a card in "Just bought" says how long
/// ago it was bought rather than when it was launched.
async function timeBuys(rpc) {
  const want = [...new Set([...buys.at.values()].filter((b) => b.ts === undefined).map((b) => b.block))];
  if (!want.length) return;
  const got = await rpcBatchAt(rpc, want.map((b) => ({ method: "eth_getBlockByNumber", params: [hexNum(b), false] })));
  const tsOf = new Map();
  want.forEach((b, i) => { if (got[i] && got[i].timestamp) tsOf.set(b, parseInt(got[i].timestamp, 16)); });
  for (const b of buys.at.values()) if (b.ts === undefined && tsOf.has(b.block)) b.ts = tsOf.get(b.block);
}

/// THE RECORDS OF THESE LAUNCHES, read again (one launchPage of one each), and
/// their cards drawn again from them.
async function rereadRows(rpc, rows, head) {
  await Promise.all(rows.map(async (v) => {
    try {
      const [fresh] = decodeLaunchPage(await callAt(rpc, state.lens, SIGS.launchPage + pad(v.index) + pad(1)));
      if (!fresh || fresh.token.toLowerCase() !== v.token.toLowerCase() || state.rpc !== rpc) return;
      for (const k of ["status", "quoteReserve", "tokenReserve", "realQuoteReserve", "graduationThreshold", "totalSupply",
        "holderDistributor"]) v[k] = fresh[k];
      v.readAt = head;
      v.ui = null;
    } catch { /* the card keeps what it had; the next read tries again */ }
  }));
}

/// The newest buy seen on this launch's curve, or null.
const lastBuy = (v) => buys.at.get(String(v.curve || "").toLowerCase()) || null;

// -------------------------------------------------------------------- the card

/// A QUOTE ASSET'S LOGO FILE, by its TRUE symbol - the same rule and the same
/// files as app.js assetLogo (weth.svg for the pair shown as ETH). ASSET_VERSION
/// is app.js's too, and is bumped with it whenever a file in web/assets changes:
/// a browser holding an old file draws the old mark, with no error.
const ASSET_VERSION = "4";
const ASSET_FILE = { cbhype: "cbhype.png", cbmega: "cbmega.png" };
function assetLogo(sym) {
  const slug = (sym || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return slug ? "assets/" + (ASSET_FILE[slug] || slug + ".svg") + "?v=" + ASSET_VERSION : "";
}

/// A COLOUR FROM AN ADDRESS, so a tile is recognisable and two launches are
/// rarely the same one (app.js markColour). Deterministic: no state, no fetch.
function hueOf(address) {
  let h = 0;
  for (let i = 2; i < address.length; i++) h = (h * 31 + address.charCodeAt(i)) >>> 0;
  return h % 360;
}

const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
const firstLetter = (s) => (Array.from(String(s || "").trim())[0] || "?").toUpperCase();

/// ONE CARD PER LAUNCH, built once and kept on the row (v.ui); a sort, a filter
/// or a figure arriving later moves or updates it rather than drawing it again,
/// so a picture is never decoded twice and a card being clicked is never
/// swapped out from under the click.
///
/// THE SELECTORS THE BROWSER TESTS HOLD ON TO: .launch, with its registry index
/// as data-index; .open, the card's own link; .addr, the short address with the
/// whole of it on its title; .progress with the raw figures on its title and
/// .pct in it; .mc .mcVal; .pairBadge; .age with the block time as data-ts;
/// .tag.waiting with the .act link beside it, and .tag.graduated.
///
/// THE WHOLE CARD OPENS THE LAUNCH, and its details still show their titles.
/// The link's ::after covers the card, so a click on the picture or a blank
/// part of the card is a click on the link. The parts that carry a title - the
/// badge, the market cap, the bar, the address, the age - sit above that cover,
/// or no pointer could ever reach their titles; a click on one of them is
/// handed to the same opening here (onCardClick), a Ctrl, Shift, Cmd or middle
/// click opening the card's link in a new tab as the link itself would.
///
/// Built as elements with textContent - never markup - because the name, the
/// symbol and every link come from whoever made the launch (AUDIT A-1).
function cardOf(v) {
  if (v.ui) return v.ui.el;
  const el = document.createElement("div");
  el.className = "launch";
  el.dataset.status = String(v.status);
  el.dataset.index = String(v.index);

  // ---- the picture, edge to edge, with the letter tile under it
  const pic = document.createElement("div");
  pic.className = "pic";
  const hue = hueOf(v.token);
  const tile = document.createElement("span");
  tile.className = "tile";
  tile.style.background = `linear-gradient(135deg, hsl(${hue} 58% 44%), hsl(${(hue + 48) % 360} 62% 26%))`;
  tile.textContent = firstLetter(v.sym || v.name);
  tile.setAttribute("aria-hidden", "true");
  pic.appendChild(tile);
  const img = v.meta && v.meta.image;
  if (img) {
    const im = document.createElement("img");
    im.className = "picImg";
    im.alt = "";
    im.loading = "lazy";
    im.decoding = "async";
    // THE LETTER IS UNDERNEATH, so a 404 or a blocked host reveals it instead
    // of leaving a hole.
    im.addEventListener("error", () => im.remove());
    im.src = displayUrl(img);
    pic.appendChild(im);
  }

  // ---- the paired asset's round badge and its symbol, on the picture's corner
  // where PONS puts its "V2", so a stock pair and a coin pair are told apart at
  // a glance. The disc's letters are under the logo, and stay if the file is
  // missing or will not load.
  const qs = v.quoteSym || "";
  const badge = document.createElement("span");
  badge.className = "pairBadge";
  badge.title = "Paired with " + (displaySymbol(qs) || v.quoteToken);
  const disc = document.createElement("span");
  disc.className = "disc";
  disc.style.background = `hsl(${hueOf(v.quoteToken || "0x")} 58% 42%)`;
  const letters = document.createElement("i");
  letters.textContent = (displaySymbol(qs).replace(/[^A-Za-z0-9]/g, "") || "?").slice(0, 1).toUpperCase();
  disc.appendChild(letters);
  const logo = v.quoteNamed ? assetLogo(qs) : "";
  if (logo) {
    const li = document.createElement("img");
    li.alt = "";
    li.addEventListener("error", () => li.remove());
    li.src = logo;
    disc.appendChild(li);
  }
  badge.appendChild(disc);
  if (v.quoteNamed) {
    const name = document.createElement("b");
    name.textContent = displaySymbol(qs);
    badge.appendChild(name);
  }
  pic.appendChild(badge);
  el.appendChild(pic);

  // ---- the words
  const info = document.createElement("div");
  info.className = "info";

  // THE WHOLE CARD IS THIS LINK: its ::after covers the card, so a click
  // anywhere opens the launch, and a middle click or Ctrl click opens it in a
  // new tab the way any link does. A plain click is taken over by openLaunch,
  // which first names the launch's factory when it can.
  const open = document.createElement("a");
  open.className = "open";
  open.href = linkFor(cfgNow(), v, null);
  open.textContent = v.name || v.sym || short(v.token);
  if (v.name) open.title = v.name;
  open.addEventListener("click", (e) => openLaunch(v, e));
  info.appendChild(open);

  const symRow = document.createElement("div");
  symRow.className = "symRow";
  const sym = document.createElement("span");
  sym.className = "sym";
  sym.textContent = v.sym ? "$" + v.sym : "";
  symRow.appendChild(sym);
  // THE CREATOR'S LINKS, IF THEY GAVE ANY, with a validated href (token-meta.js
  // safeUrl has already refused anything else).
  // AS LOGOS, NOT WORDS (the owner's call): a globe for the website, X's
  // mark, Telegram's plane.
  const links = [
    ["Website", v.meta && v.meta.website, SOCIAL_ICON.web],
    ["X", v.meta && v.meta.twitter, SOCIAL_ICON.x],
    ["Telegram", v.meta && v.meta.telegram, SOCIAL_ICON.tg],
  ].filter(([, u]) => u);
  if (links.length) {
    const row = document.createElement("span");
    row.className = "socials";
    for (const [label, url, icon] of links) {
      const a = document.createElement("a");
      a.innerHTML = icon;
      a.setAttribute("aria-label", label);
      a.href = displayUrl(url);
      a.target = "_blank";
      // noopener because the destination is a stranger's; noreferrer so the
      // launch a reader was looking at is not leaked to it.
      a.rel = "noopener noreferrer nofollow";
      a.title = url;
      row.appendChild(a);
    }
    symRow.appendChild(row);
  }
  info.appendChild(symRow);

  const mc = document.createElement("div");
  mc.className = "mc";
  const mcVal = document.createElement("span");
  mcVal.className = "mcVal";
  const mcTag = document.createElement("span");
  mcTag.className = "mcTag";
  mcTag.textContent = "MC";
  mc.append(mcVal, mcTag);
  info.appendChild(mc);

  // HOLDERS EARN THIS LAUNCH'S FEES: its creator switched its income to its
  // holder distributor (LaunchView w15), once and for good.
  if (v.holderDistributor && !/^0x0{40}$/.test(v.holderDistributor)) {
    const share = document.createElement("span");
    share.className = "holdersEarn";
    share.textContent = "Holders earn";
    share.title = "This launch's creator fees go to its holders, through " + v.holderDistributor;
    info.appendChild(share);
  }

  if (v.status === 1 || v.status === 2) {
    const pct = progressOf(v);
    const line = document.createElement("div");
    line.className = "progress";
    const bar = document.createElement("div");
    bar.className = "bar";
    const grown = document.createElement("i");
    grown.style.width = pct.toFixed(1) + "%";
    bar.appendChild(grown);
    line.appendChild(bar);
    const big = document.createElement("span");
    big.className = "pct";
    big.textContent = pct.toFixed(1) + "%";
    line.appendChild(big);
    // THE EXACT FIGURES STAY ON title. The rendered text is rounded and cannot
    // be checked against a chain read; the browser test reads these - the raw
    // pair first, then the same in the asset's own units for a reader.
    const qd = v.quoteDecimals;
    const raisedText = `${fmtQuote(v.realQuoteReserve, qd)} of ${fmtQuote(v.graduationThreshold, qd)} ${displaySymbol(qs)}`.trim();
    line.title = `${v.realQuoteReserve} of ${v.graduationThreshold}, in the quote asset's smallest units - ` +
      `${raisedText} to graduate`;
    info.appendChild(line);
    // HOW MUCH OF THE PAIRED ASSET IS IN, AGAINST THE THRESHOLD, AS TEXT: the
    // one figure per launch in real units, which the list before the grid
    // printed beside the percentage. A title alone cannot be read on a phone.
    const raised = document.createElement("div");
    raised.className = "raised";
    raised.textContent = raisedText;
    info.appendChild(raised);
  } else if (v.status === 3) {
    const row = document.createElement("div");
    row.className = "gradRow";
    const tag = document.createElement("span");
    tag.className = "tag graduated";
    tag.textContent = "Graduated";
    row.appendChild(tag);
    info.appendChild(row);
  }

  if (v.status === 2) {
    // WAITING IS THE ONE STATE WITH SOMETHING TO DO. Both sides of the curve are
    // shut and the pool does not exist; graduation is permissionless, so the
    // card says so and carries the way to go and do it. A LINK, not a button:
    // a Ctrl or middle click on a button did nothing at all.
    const row = document.createElement("div");
    row.className = "waitRow";
    const tag = document.createElement("span");
    tag.className = "tag waiting";
    tag.textContent = "Waiting";
    const act = document.createElement("a");
    act.className = "act";
    act.href = linkFor(cfgNow(), v, null);
    act.textContent = "Graduate it";
    act.addEventListener("click", (e) => openLaunch(v, e));
    row.append(tag, act);
    info.appendChild(row);
  }

  const foot = document.createElement("div");
  foot.className = "foot";
  // THE WHOLE ADDRESS, FOR A PHONE TOO: hover does not exist there, so the
  // short address is a button that copies the whole of it.
  const addr = document.createElement("button");
  addr.type = "button";
  addr.className = "addr";
  addr.textContent = short(v.token);
  addr.title = v.token;
  addr.setAttribute("aria-label", "Copy the token address " + v.token);
  addr.addEventListener("click", (e) => { e.preventDefault(); copyAddress(addr, v.token); });
  const age = document.createElement("span");
  age.className = "age";
  foot.append(addr, age);
  info.appendChild(foot);

  el.appendChild(info);
  el.addEventListener("click", (e) => onCardClick(v, open, e));
  el.addEventListener("auxclick", (e) => onCardClick(v, open, e));
  // A MIDDLE PRESS OUTSIDE A LINK STARTS THE BROWSER'S AUTOSCROLL on Windows,
  // and then no auxclick follows - so the press is kept for the card.
  el.addEventListener("mousedown", (e) => { if (e.button === 1 && !e.target.closest("a, button")) e.preventDefault(); });
  v.ui = { el, mc, mcVal, age };
  updateCard(v);
  return el;
}

/// A CLICK ON A PART OF THE CARD THAT SITS ABOVE THE LINK'S COVER (see cardOf).
/// A link or a button inside the card handles its own clicks.
function onCardClick(v, open, e) {
  if (e.target.closest("a, button")) return;
  if (e.type === "auxclick" && e.button !== 1) return;
  if (e.button === 1 || e.metaKey || e.ctrlKey || e.shiftKey) {
    e.preventDefault();
    window.open(open.href, "_blank", "noopener");
    return;
  }
  if (e.button === 0) openLaunch(v, e);
}

function copyAddress(btn, address) {
  const said = (text) => {
    btn.textContent = text;
    clearTimeout(btn._t);
    btn._t = setTimeout(() => { btn.textContent = short(address); }, 1400);
  };
  try {
    navigator.clipboard.writeText(address).then(() => said("Copied"), () => said("Copy failed"));
  } catch { said("Copy failed"); }
}

/// The parts of a card that arrive after it is drawn: its dollars and its age.
function updateCard(v) {
  if (!v.ui) return;
  const m = marketCap(v);
  if (v.ui.mcVal.textContent !== m.text) v.ui.mcVal.textContent = m.text;
  v.ui.mc.title = m.title;
  v.ui.mc.classList.toggle("unknown", m.text === "—" || m.text === "…");
  const t = timeOf(v);
  const bought = state.sort === "bought" ? lastBuy(v) : null;
  const boughtAge = bought && bought.ts !== undefined ? ageText({ ts: bought.ts }) : "";
  const text = boughtAge ? "bought " + boughtAge : ageText(t);
  if (v.ui.age.textContent !== text) v.ui.age.textContent = text;
  if (bought && bought.ts !== undefined) v.ui.age.dataset.bought = String(bought.ts); else delete v.ui.age.dataset.bought;
  const now = chainNow();
  v.ui.age.classList.toggle("fresh", t.ts !== undefined && now !== null && now - t.ts < FRESH_S);
  // THE BLOCK TIME ITSELF, which the text rounds and the browser test reads.
  if (t.ts !== undefined) v.ui.age.dataset.ts = String(t.ts); else delete v.ui.age.dataset.ts;
  v.ui.age.title = t.ts !== undefined ? "Launched " + new Date(t.ts * 1000).toLocaleString() + " by the chain's clock"
    : t.older ? `Launched more than ${LOOKBACK_DAYS} days ago`
    : t.unknown ? "The launch time could not be read from this endpoint" : "";
}

/// Updates every card's late parts, and redraws when the order or the filter
/// depends on them.
function refreshCards() {
  for (const v of state.rows) updateCard(v);
  drawHero();
  if (state.rows.length && (state.sort === "mc" || state.range)) render();
}

// ---------------------------------------------------------------------- load

const state = {
  rpc: "", lens: "", registry: "", total: 0, shown: 0, rows: [], page: 25,
  // THE ORDER ON SCREEN (new, old, mc, progress) and THE WINDOW BY LAUNCH TIME
  // in seconds (0 is all). Newest and Oldest are also which END of the registry
  // is read first - see dir.
  sort: "new", range: 0,
  // WHICH LAUNCHES (all, bonding - still selling on their curve - or
  // graduated), the status pills beside the sort and time ones.
  status: "all",
  // desc reads the registry from its end backwards (newest first), asc from
  // its start. Oldest with not everything loaded reads from the start, since
  // the oldest of the newest 25 is not what "Oldest" means.
  dir: "desc",
  // BUMPED WHENEVER THE LIST STARTS AGAIN (a new direction). A read that
  // finishes for an older generation is dropped rather than drawn.
  gen: 0,
  factories: {},
  // THE FACTORY MAP AS A PROMISE, so a card can be drawn before it arrives and
  // a click can still wait for it. See loadFactories.
  factoriesReady: Promise.resolve({}),
  // A SECOND READ OF THE MAP IN FLIGHT, shared by every click that found a gap.
  refill: null,
  // A PAGE BEING READ. loadPage takes its window from `shown` before its awaits
  // and adds to it only at the end, so two at once read the same window: it
  // was drawn twice, counted twice, and the next one could never be loaded
  // (round 5, N24). "Show older" does nothing while this is set.
  loadingMore: false,
};
const cfgNow = () => ({ rpc: state.rpc, lens: state.lens });

/// THE LAUNCHES THE SITE STILL SHOWS, of those given: the halt PRE_MAINNET D4
/// names (config.js hiddenLaunches, and every launch a factory in
/// hiddenFactories made) is decided by the site bar (CurbBar.incident), so the
/// grid, the hero and the search leave out the same ones. With nothing hidden
/// it reads nothing.
async function unhidden(rows) {
  const inc = window.CurbBar && window.CurbBar.incident;
  if (!inc || !inc.any()) return rows;
  const off = await Promise.all(rows.map((v) => inc.launchHidden(state.rpc, v)));
  return rows.filter((_, i) => !off[i]);
}

/// MORE LAUNCHERS THAN THIS IS NOT A LIST TO FAN OUT OVER. The registry is the
/// lens's, and the lens comes from the link; a count read from a contract of
/// somebody's choosing must not decide how many requests this page fires. Past
/// it the links go without a factory, as they do when the read fails.
const MAX_LAUNCHERS = 256;
const isAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(a);

/// THE REGISTRY'S LAUNCHERS, BY QUOTE ASSET, each with the escrow it pays fees
/// into - read once per registry. A link to a launch's page carries the
/// launch's factory when this page can name it, which spares app.html
/// resolving it.
///
/// A LIST PER ASSET, NOT ONE FACTORY. The registry admits several factories on
/// one asset - a second one is the only way to change an asset's immutable
/// terms - so the asset does not say which made a launch. This map used to keep
/// the later launcher per asset, and every card made by the older factory
/// linked to the newer one (round 5, N25). factoryOfLaunch picks from the list
/// by the launch's own curve.
///
/// OFF THE PATH TO THE FIRST CARD, AND IN PARALLEL. This used to be awaited
/// before the launch count, one launcher after another - 1 + 2N round trips on
/// a public endpoint before anything was drawn, 23 with the eleven assets
/// deployed - and one failed entry dropped every entry after it (round 4,
/// S26). init starts it now and does not wait; each launcher is read on its
/// own, and one that fails costs only its own asset's links.
///
/// A LAUNCH THIS PAGE CANNOT PLACE IS LINKED WITHOUT A FACTORY, and app.html
/// then resolves it itself: for a link that names a lens and a token and no
/// factory it takes nothing from storage, and finds the launcher whose escrow
/// the launch's curve pays into (app.js loadCfg and refresh, launchFactoryOf) -
/// no stored factory stands in and no earlier pick is held against the launch.
/// Carrying the factory only saves that scan; a click that finds no match asks
/// the registry once more (refillFactories), since a gap is usually a read that
/// failed, and then goes without.
async function loadFactories(rpc, registry) {
  const out = {};
  try {
    const n = Number(BigInt(await callAt(rpc, registry, SIGS.launcherCount)));
    if (!Number.isSafeInteger(n) || n < 0 || n > MAX_LAUNCHERS) return out;
    const entries = await Promise.all(Array.from({ length: n }, async (_, i) => {
      try {
        const f = "0x" + (await callAt(rpc, registry, SIGS.launcherAt + pad(i))).replace(/^0x/, "").slice(24);
        if (!isAddress(f)) return null;
        const [qRaw, eRaw] = await Promise.all([callAt(rpc, f, SIGS.quoteToken), callAt(rpc, f, SIGS.feeEscrow)]);
        const q = "0x" + (qRaw || "").replace(/^0x/, "").slice(24);
        const escrow = "0x" + (eRaw || "").replace(/^0x/, "").slice(24);
        return isAddress(q) && isAddress(escrow) ? { quote: q.toLowerCase(), factory: f, escrow } : null;
      } catch { return null; }
    }));
    for (const e of entries) if (e) addLauncher(out, e);
  } catch { /* no count, no map: every link goes without a factory - see above */ }
  return out;
}
/// Files one launcher under its asset, once: the same factory read twice (a
/// refill, a repeated index) is one entry.
function addLauncher(map, e) {
  const list = map[e.quote] || (map[e.quote] = []);
  if (!list.some((x) => x.factory.toLowerCase() === e.factory.toLowerCase())) list.push(e);
}
/// ONE MORE READ OF THE MAP. What the first read found is kept, and this one
/// only adds what it lacked; it never rejects, because loadFactories does not.
function refillFactories() {
  if (!state.refill) {
    const reg = state.registry;
    state.refill = loadFactories(state.rpc, reg).then((m) => {
      if (state.registry !== reg) return;
      for (const list of Object.values(m)) for (const e of list) addLauncher(state.factories, e);
    }).finally(() => { state.refill = null; });
  }
  return state.refill;
}
/// THE FACTORY THAT MADE THIS LAUNCH, as app.html decides it: of the launchers
/// listed for its asset, the one whose escrow the launch's curve pays into.
/// Two launchers sharing one escrow are the same answer for everything app.html
/// does with it (the owed panel, claims, sweeps), and the first is taken. Null
/// when the curve's escrow cannot be read or nothing listed matches.
async function factoryOfLaunch(v) {
  const rpc = state.rpc;
  const [, eRaw] = await Promise.all([state.factoriesReady, callAt(rpc, v.curve, SIGS.feeEscrow)]);
  const escrow = "0x" + (eRaw || "").replace(/^0x/, "").slice(24);
  if (!isAddress(escrow) || /^0x0{40}$/.test(escrow)) return null;
  const match = () => (state.factories[(v.quoteToken || "").toLowerCase()] || [])
    .find((e) => e.escrow.toLowerCase() === escrow.toLowerCase());
  let hit = match();
  if (!hit) { await refillFactories(); hit = match(); }
  return hit ? hit.factory : null;
}
/// A LAUNCH'S OWN PAGE, token/0x… (app.html in its token view), with the
/// endpoint and lens it was listed from, and its factory when this page knows it.
///
/// EXCEPT FROM THE SITE'S OWN DEPLOYMENT (web/config.js), WHICH GOES PLAIN:
/// where the bar's links carry nothing (CurbBar.withConfig), a launch's link
/// carries nothing either - not the pair, which a plain URL reads anyway, and
/// not the factory, which without its endpoint would be half a link (app.js
/// mixedEndpoint). app.html finds the factory itself, as it does for a token's
/// page shared anywhere else.
const linkFor = (base, v, factory) => {
  const bar = window.CurbBar;
  const path = "token/" + v.token;
  if (bar && bar.withConfig(path) === path && base.rpc === bar.config().rpc &&
      base.lens.toLowerCase() === String(bar.config().lens || "").toLowerCase()) return path;
  const q = new URLSearchParams({ rpc: base.rpc, lens: base.lens });
  if (factory) q.set("factory", factory);
  return "token/" + v.token + "?" + q.toString();
};
/// HOW LONG A CLICK WAITS TO NAME THE FACTORY before it hands off without one.
/// Not a chain figure: a bound on a shortcut, since app.html finds the factory
/// itself when the link names none. Long enough for a slow public endpoint's
/// few reads, short enough that a hung one does not strand the card.
const CLICK_WAIT_MS = 5000;

/// OPENING A LAUNCH. A plain click waits - boundedly - for the launch's own
/// factory, so the link can carry it (factoryOfLaunch). THE LAUNCH'S OWN
/// FACTORY IS LOOKED UP HERE, on the click, not before the list. It is a
/// shortcut, not a requirement: a link with a lens and a token and no factory
/// is resolved by app.html itself, from the same registry and the same escrow
/// test. So the wait is bounded - a read that hangs instead of failing sends the
/// link without a factory after CLICK_WAIT_MS rather than leaving the card
/// saying "Finding…" for as long as the browser keeps the request open (round 4
/// S26, round 5). A click with a modifier, or the middle button, is the
/// browser's: the card's own href opens in a new tab, factory or not.
async function openLaunch(v, e) {
  if (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
  }
  let settled = false;
  const found = factoryOfLaunch(v).catch(() => null).then((f) => { settled = true; return f; });
  await Promise.resolve();
  if (!settled) say("Finding this launch's factory…");
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), CLICK_WAIT_MS); });
  const factory = await Promise.race([found, late]);
  clearTimeout(timer);
  location.href = linkFor(cfgNow(), v, factory);
}

/// HOW MANY PER PAGE. Overridable from the query string because a default of
/// 25 means the "show older" path never runs until a registry has 26 launches
/// in it - so nothing exercised it, and a first version of this file shipped
/// with it untested. A reader who wants smaller pages gets them too.
/// THE MOST ONE LENS CALL WILL DESCRIBE - LaunchLens.MAX_PAGE. Asked for more,
/// the lens answers with the first MAX_PAGE of the window, which from the end
/// of the array backwards is the OLDEST part of it. This page accepted up to
/// 200 and counted all of them as shown, so the newest 150 were skipped and
/// could never be loaded.
const LENS_MAX_PAGE = 50;

function pageSize() {
  const n = Number(new URLSearchParams(location.search).get("pageSize"));
  return Number.isInteger(n) && n > 0 ? Math.min(n, LENS_MAX_PAGE) : 25;
}

function say(text) { $("msg").textContent = text; }

// THE TOKEN'S OWN WORDS ARE READ BY token-meta.js - the same rules the site's
// search uses, kept in one place so the two cannot drift. See there for why
// each one exists.
const { decodeString, cut, displayUrl, parseMeta } = window.CurbMeta;

async function labelFor(rpc, token) {
  // A symbol is what a person recognises; the name sits beside it and the
  // address under that. A launch whose token will not answer symbol() is still
  // drawn - the list is the registry's, not the token's.
  try {
    const [sym, nm, uri] = await Promise.all([
      callAt(rpc, token, SIGS.symbol),
      callAt(rpc, token, SIGS.name),
      // A token that does not answer tokenUri() is still a launch. The catch
      // below covers symbol() and name(); this one must not take them down
      // with it, so it fails on its own.
      callAt(rpc, token, SIGS.tokenUri).catch(() => ""),
    ]);
    // BOUNDED, BECAUSE ANYONE MAY LAUNCH AND BOTH OF THESE ARE THEIR CHOICE.
    // They go to textContent, so the risk is not injection - it is one card
    // with a hundred-kilobyte name pushing every other launch off a list this
    // page shares between strangers.
    let meta;
    try { meta = parseMeta(decodeString(uri)); } catch { meta = parseMeta(""); }
    return { sym: cut(decodeString(sym), 16), name: cut(decodeString(nm), 48), meta };
  } catch { return { sym: "", name: "", meta: parseMeta("") }; }
}

/// THE REGISTRY AND ITS COUNT, once per visit. The count is the one read when
/// the page opened; launches registered since are not in it - reloading the
/// page picks them up. Paging stays correct either way: register() only ever
/// appends, so an index already fetched keeps pointing at the same launch.
async function init() {
  const rpc = cfg.rpc.trim();
  const lens = cfg.lens.trim();
  // NO FORM TO SEND ANYONE BACK TO ANY MORE, so an unset address is said
  // plainly along with the one way there is to set it - both halves, since the
  // bar takes a pair or nothing.
  if (!rpc || !lens) {
    say("No registry is configured in this build. Add ?rpc=…&lens=0x… to the address to point this " +
      "page at one.");
    showSkeleton(false);
    return false;
  }
  state.rpc = rpc; state.lens = lens; state.rows = []; state.shown = 0;
  state.page = pageSize();
  say("Reading…");

  // A CALL TO AN ADDRESS WITH NO CODE RETURNS "0x", NOT AN ERROR. Decoding
  // that would raise "Cannot convert 0x to a BigInt", which is what this page
  // used to show the reader - a JavaScript message about a wrong address.
  const regRaw = await callAt(rpc, lens, SIGS.registry);
  if (!regRaw || regRaw === "0x") {
    throw new Error(`no lens answered at ${lens} on this endpoint. Check the address and the network.`);
  }
  state.registry = "0x" + regRaw.replace(/^0x/, "").slice(24);
  // STARTED, NOT AWAITED: the first card does not wait on the factory map.
  // Filed only if this is still the registry on screen when it lands.
  const reg = state.registry;
  state.factories = {};
  state.factoriesReady = loadFactories(rpc, reg).then((m) => {
    if (state.registry === reg) state.factories = m;
    return m;
  });
  const countRaw = await callAt(rpc, state.registry, SIGS.launchCount);
  if (!countRaw || countRaw === "0x") {
    throw new Error(`the lens named ${state.registry} as its registry, but nothing answered there.`);
  }
  state.total = Number(BigInt(countRaw));
  return true;
}

/// ONE PAGE OF LAUNCHES, from whichever end `dir` reads, appended to what is
/// loaded. Dropped unread if the list started again while it was out.
async function loadPage(gen) {
  if (state.total === 0) {
    say("This registry holds no launches yet.");
    showSkeleton(false);
    $("grid").replaceChildren();
    $("more").disabled = true;
    return;
  }

  // NEWEST FIRST reads the page from the END of the array backwards; OLDEST
  // FIRST from its start forwards.
  let start, count;
  if (state.dir === "asc") {
    start = state.shown;
    count = Math.min(state.page, state.total - state.shown, LENS_MAX_PAGE);
  } else {
    const end = state.total - state.shown;
    count = Math.min(state.page, end, LENS_MAX_PAGE);
    start = end - count;
  }
  if (count <= 0) return;
  // THE BLOCK THE RECORDS ARE AT LEAST AS NEW AS, read first: a buy from this
  // block on may not be in them, and "Just bought" reads such a launch again.
  const readAt = parseInt(await rpcAt(state.rpc, "eth_blockNumber", []).catch(() => "0x0"), 16) || 0;
  const raw = await callAt(state.rpc, state.lens, SIGS.launchPage + pad(start) + pad(count));
  if (gen !== state.gen) return;
  let page = decodeLaunchPage(raw);
  // A SHORT PAGE IS A GAP, NOT A TAIL. The window is [start, start + count); a
  // lens that returns fewer has returned its beginning, and counting the rest as
  // shown would skip the newest of them for good.
  if (page.length !== count) {
    throw new Error(
      `the lens returned ${page.length} launches for a page of ${count}. ` +
      `Nothing was skipped silently - reload with a smaller ?pageSize.`
    );
  }
  // ITS PLACE IN THE REGISTRY, which is also its place in time: register()
  // only appends, so a higher index is a later launch.
  page.forEach((v, i) => { v.index = start + i; v.readAt = readAt; });
  if (state.dir !== "asc") page.reverse();
  // WHAT THE SITE NO LONGER SHOWS IS DROPPED HERE (unhidden), before anything
  // more is read for it. The window still counts as read whole, so the next
  // page starts where it should.
  page = await unhidden(page);
  if (gen !== state.gen) return;

  const labels = await Promise.all(page.map((v) => labelFor(state.rpc, v.token)));
  if (gen !== state.gen) return;
  // NAMED FIELD BY FIELD, so a new one added to labelFor and not added here is
  // silently dropped - which is exactly what happened to `meta` the first time,
  // and the row rendered without an image while the chain had one.
  page.forEach((v, i) => { v.sym = labels[i].sym; v.name = labels[i].name; v.meta = labels[i].meta; });
  // The quote asset each one prices against, for the badge and the figures.
  const quotes = await Promise.all(page.map((v) => quoteMetaFor(state.rpc, v.quoteToken)));
  if (gen !== state.gen) return;
  page.forEach((v, i) => {
    v.quoteSym = quotes[i].sym; v.quoteDecimals = quotes[i].decimals; v.quoteNamed = quotes[i].named;
  });

  state.rows = state.rows.concat(page);
  state.shown += count;
  showSkeleton(false);
  render();

  // WHAT ARRIVES AFTER THE CARDS: each asset's dollars, each graduated
  // launch's pool price, and when each launch was made. None holds up the
  // list, and each updates the cards it reaches.
  ensureRates();
  readPools();
  readTimes();
  if (state.sort === "bought") readBuys().then(() => { if (state.sort === "bought") render(); });
}

/// ONE PAGE READ AT A TIME, for "Show older" and for a new direction alike -
/// see state.loadingMore. The flag is what holds: a handler called twice in one
/// tick runs twice whatever the button's state.
function runLoad() {
  const gen = state.gen;
  state.loadingMore = true;
  $("more").disabled = true;
  return loadPage(gen)
    .catch((e) => { if (gen === state.gen) { showSkeleton(false); say("Could not read: " + e.message); } })
    .finally(() => {
      if (gen !== state.gen) return;
      state.loadingMore = false;
      $("more").disabled = state.total - state.shown <= 0;
    });
}

/// WHICH END OF THE REGISTRY TO READ FROM. Oldest reads from its start and
/// Newest from its end - but a TIME WINDOW is always read from the end: the
/// last 24 hours or 7 days are the newest launches, and the oldest 25 are no
/// place to look for them (after Oldest, 24h said none was made that day while
/// the registry's newest launch was minutes old). Market cap and Progress sort
/// whatever end is loaded.
function wantDir() {
  if (state.range) return "desc";
  if (state.sort === "old") return "asc";
  if (state.sort === "new") return "desc";
  return state.dir;
}

/// THE LIST FROM THE OTHER END: Oldest with not everything loaded reads the
/// registry from its start, and Newest again from its end.
function restart(dir) {
  state.gen += 1;
  state.dir = dir;
  state.rows = [];
  state.shown = 0;
  $("grid").replaceChildren();
  showSkeleton(true);
  say("Reading…");
  runLoad();
}

// -------------------------------------------------------------------- drawing

function sortRows(rows) {
  const byIndexDesc = (a, b) => b.index - a.index;
  const out = rows.slice();
  if (state.sort === "old") return out.sort((a, b) => a.index - b.index);
  if (state.sort === "bought") {
    // THE NEWEST BUY FIRST; a launch with none seen after, by launch time.
    // (Only launches still selling on their curve reach here - see shownRows.)
    return out.sort((a, b) => {
      const x = lastBuy(a), y = lastBuy(b);
      if (x && y) return y.block - x.block || y.idx - x.idx || byIndexDesc(a, b);
      if (!!x !== !!y) return x ? -1 : 1;
      return byIndexDesc(a, b);
    });
  }
  if (state.sort === "mc") {
    // IN DOLLARS, WHICH ARE COMPARABLE ACROSS PAIRS - a graduated launch by
    // its pool's price, once read (readPools). A launch without a dollar
    // figure (no feed, or its price not read yet) comes after, newest first -
    // 4 NVDAc and 4 ETH are not an order.
    return out.sort((a, b) => {
      const x = marketCap(a).usd, y = marketCap(b).usd;
      const hx = isFinite(x), hy = isFinite(y);
      if (hx && hy) return y - x;
      if (hx !== hy) return hx ? -1 : 1;
      return byIndexDesc(a, b);
    });
  }
  if (state.sort === "progress") {
    // CLOSEST TO GRADUATING FIRST - a waiting launch is at 100% - and the ones
    // already graduated after them, since they have no way left to go.
    const onCurve = (v) => v.status === 1 || v.status === 2;
    return out.sort((a, b) => {
      if (onCurve(a) !== onCurve(b)) return onCurve(a) ? -1 : 1;
      if (onCurve(a)) return progressOf(b) - progressOf(a) || byIndexDesc(a, b);
      return byIndexDesc(a, b);
    });
  }
  return out.sort(byIndexDesc);
}

/// THE TIME WINDOW, by launch time. A launch whose time is still being read,
/// or could not be read, is not guessed into or out of it: it is left out, and
/// the line under the heading says how many.
function inRange(rows) {
  if (!state.range) return { rows, pending: 0, unknown: 0 };
  const now = chainNow();
  let pending = 0, unknown = 0;
  const kept = rows.filter((v) => {
    const t = timeOf(v);
    if (t.older) return false;
    if (t.unknown) { unknown += 1; return false; }
    if (t.ts === undefined || now === null) { pending += 1; return false; }
    return now - t.ts <= state.range;
  });
  return { rows: kept, pending, unknown };
}

const RANGE_WORDS = { 86400: "the last 24 hours", 604800: "the last 7 days" };

/// THE STATUS PILLS: Bonding is a launch still selling on its curve (1);
/// Graduated one trading in its pool (3), its card's market cap by the pool's
/// price. A launch waiting at its threshold (2) is in All, and named above the
/// grid. "Just bought" shows only launches still selling on their curve,
/// whatever the pill (the owner's call: no graduated, no waiting).
function byStatus(rows) {
  const want = state.sort === "bought" ? "bonding" : state.status;
  if (want === "bonding") return rows.filter((v) => v.status === 1);
  if (want === "graduated") return rows.filter((v) => v.status === 3);
  return rows;
}
const STATUS_WORDS = { bonding: "still bonding on its curve", graduated: "graduated" };

function render() {
  const all = state.rows;
  const { rows: inWindow, pending, unknown } = inRange(all);
  const rows = sortRows(byStatus(inWindow));
  const grid = $("grid");
  const els = rows.map(cardOf);
  // The age line depends on the order ("bought …" in Just bought).
  for (const v of rows) updateCard(v);
  if (!els.length && all.length) {
    const none = document.createElement("div");
    none.className = "none";
    const which = state.sort === "bought" ? "bonding" : state.status;
    const further = state.shown >= state.total ? ""
      : state.dir === "asc" ? " Show newer ones below to look at later launches."
      : " Show older ones below to look further back.";
    none.textContent = pending && inWindow.length === 0
      ? "Reading when these launched…"
      : inWindow.length === 0
        ? `No launch among the ${all.length} loaded was made in ${RANGE_WORDS[state.range] || "this window"}.` + further
        : `No launch among the ${all.length} loaded is ${STATUS_WORDS[which] || "here"}.` + further;
    els.push(none);
  }
  grid.replaceChildren(...els);

  const waiting = all.filter((v) => v.status === 2);
  drawWaiting(waiting);

  // THE HEADING SAYS ONE THING: how many tokens have been created - the
  // registry's own count (the owner's call). The waiting and graduated counts
  // beside it are gone, and so is the line that broke the loaded ones down by
  // status: the waiting strip and the status pills say what they said.
  $("statTotal").textContent = state.total.toLocaleString("en-US");
  $("statWord").textContent = state.total === 1 ? "token created" : "tokens created";

  const left = state.total - state.shown;
  const word = state.dir === "asc" ? "newer" : "older";
  $("more").disabled = left <= 0 || state.loadingMore;
  $("more").textContent = left > 0 ? `Show ${word} (${left} more)` : `Nothing ${word}`;
  // HOW MUCH IS LOADED, for the browser tests and for a screen reader; the
  // button under the grid says it to the eye.
  $("loaded").textContent = `${state.shown} of ${state.total} launches loaded.`;

  // ONLY WHAT AN ORDER OR A WINDOW NEEDS SAID, over what is loaded: the filters
  // have no index to ask, so they say so.
  const parts = [];
  if (state.range) {
    let line = `${rows.length}${left > 0 ? ` of the ${state.shown} loaded` : ""} made in ` +
      (RANGE_WORDS[state.range] || "this window");
    if (pending) line += `, ${pending} still being timed`;
    if (unknown) line += `, ${unknown} whose launch time could not be read`;
    parts.push(line + ".");
  }
  if ((state.sort === "mc" || state.sort === "progress" || state.sort === "bought") && left > 0) {
    parts.push(`Sorted among the ${state.shown} loaded.`);
  }
  if (state.sort === "bought" && buys.failed) {
    parts.push("The latest buys could not be read just now: " + buys.failed + ". They are asked again shortly.");
  }
  say(parts.join(" "));
}

/// WAITING LAUNCHES, ABOVE THE GRID, IN EVERY ORDER. Graduating one is the one
/// action this page offers, and anybody may take it; the list before the grid
/// put them first, with a full-width "Graduate it". The grid sorts by age, so a
/// waiting launch could sit anywhere in it - or past the first page. This line
/// names the loaded ones and carries the way to each, and leaves the order
/// alone. Built with textContent, as the cards are: the names are the creators'.
const WAITING_NAMED = 3;
function drawWaiting(waiting) {
  const bar = $("waitingBar");
  if (!bar) return;
  if (!waiting.length) { bar.hidden = true; bar.replaceChildren(); return; }
  const lead = document.createElement("span");
  lead.className = "waitLead";
  const n = document.createElement("b");
  n.textContent = String(waiting.length);
  lead.append(n, waiting.length === 1 ? " launch is waiting to graduate." : " launches are waiting to graduate.");
  const acts = document.createElement("span");
  acts.className = "waitActs";
  for (const v of waiting.slice(0, WAITING_NAMED)) {
    const a = document.createElement("a");
    a.className = "btn";
    a.href = linkFor(cfgNow(), v, null);
    a.textContent = "Graduate " + (v.sym ? "$" + v.sym : v.name || short(v.token));
    a.title = (v.name || v.sym || "") + " - " + v.token;
    a.addEventListener("click", (e) => openLaunch(v, e));
    acts.appendChild(a);
  }
  if (waiting.length > WAITING_NAMED) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "ghost";
    more.textContent = `+${waiting.length - WAITING_NAMED} more - by progress`;
    more.addEventListener("click", () => { const c = $("sortProgress"); if (c) c.click(); });
    acts.appendChild(more);
  }
  bar.replaceChildren(lead, acts);
  bar.hidden = false;
}

/// PLACEHOLDERS WHILE THE FIRST PAGE IS READ - not .launch, so nothing counts
/// them as launches.
function showSkeleton(on) {
  const grid = $("grid");
  if (!on) { for (const s of grid.querySelectorAll(".skel")) s.remove(); return; }
  if (grid.querySelector(".skel")) return;
  for (let i = 0; i < 10; i++) {
    const s = document.createElement("div");
    s.className = "skel";
    s.setAttribute("aria-hidden", "true");
    s.innerHTML = '<div class="pic"></div><div class="info"><i></i><i></i><i></i></div>';
    grid.appendChild(s);
  }
}

// ------------------------------------------------------------------ wire-up

/// THE WALLET IS THE SITE BAR'S (topbar.js): the same Connect button and the
/// same account on every page. This page still never asks for a signature -
/// there is nothing here to sign, and the launch pages own every transaction.

function setOn(selector, on) {
  for (const c of document.querySelectorAll(selector)) {
    const pressed = c === on;
    c.classList.toggle("on", pressed);
    c.setAttribute("aria-pressed", pressed ? "true" : "false");
  }
}

function boot() {
  const pair = window.CurbBar ? window.CurbBar.config() : { rpc: "", lens: "" };
  cfg.rpc = pair.rpc || "";
  cfg.lens = pair.lens || "";

  $("more").onclick = () => {
    if (state.loadingMore) return;
    runLoad();
  };

  // SEARCH IS THE SITE BAR'S (search.js, opened from the bar or Ctrl K on every
  // page). It reads the registry itself, so it needs nothing from here.

  // SORTING REDRAWS WHAT IS ALREADY HERE - no request goes out - except where
  // the order, or the time window, is a question about the other end of the
  // registry (wantDir): then the list starts again from that end.
  const everything = () => state.total > 0 && state.shown >= state.total;
  const startOver = () => {
    const d = wantDir();
    if (state.registry && state.total > 0 && !everything() && d !== state.dir) { restart(d); return true; }
    return false;
  };
  for (const chip of document.querySelectorAll(".chip[data-sort]")) {
    chip.onclick = () => {
      state.sort = chip.dataset.sort;
      setOn(".chip[data-sort]", chip);
      if (startOver()) return;
      if (state.rows.length) render();
      // JUST BOUGHT ASKS FOR THE LATEST BUYS AT ONCE, and draws when they land.
      if (state.sort === "bought") readBuys().then(() => { if (state.sort === "bought") render(); });
    };
  }
  // ALL, BONDING OR GRADUATED: a filter over what is loaded, like the window.
  for (const chip of document.querySelectorAll(".chip[data-status]")) {
    chip.onclick = () => {
      state.status = chip.dataset.status;
      setOn(".chip[data-status]", chip);
      if (state.rows.length) render();
    };
  }
  for (const chip of document.querySelectorAll(".chip[data-range]")) {
    chip.onclick = () => {
      state.range = Number(chip.dataset.range) || 0;
      setOn(".chip[data-range]", chip);
      if (startOver()) return;
      if (state.rows.length) render();
      // A launch-time scan that failed is tried again on the spot, if its
      // pause is over, since the window now depends on it.
      if (state.range) readTimes();
    };
  }
  // THE AGES MOVE WHILE THE PAGE IS OPEN, and what arrives late is asked again
  // here when it is due: a dollar rate that failed or is past its time, a
  // graduated launch's pool price likewise.
  setInterval(() => {
    if (document.hidden || !state.rows.length) return;
    ensureRates();
    readPools();
    // "JUST BOUGHT" RE-ORDERS AS PEOPLE BUY: a launch bought since jumps up.
    if (state.sort === "bought") readBuys().then(() => { if (state.sort === "bought") render(); });
    if (!times.head) return;
    for (const v of state.rows) updateCard(v);
    if (state.range) render();
  }, 15000);

  // A HALF LINK IS SAID, NOT FILLED IN. A URL cut at its "&" names an rpc or a
  // lens and not the other; reading the saved registry in its place showed a
  // list the link never named, with nothing on screen to say so.
  if (pair.halfLink) {
    say("This link names only half of where to read - an rpc and a lens go together - so nothing is read " +
      "rather than some other registry. Open it with both ?rpc=… and ?lens=0x…, or from the Launches link.");
    return;
  }

  // The page opens on the launches. Whether an address was configured is
  // init's to answer, because it is the one that knows what it needs.
  showSkeleton(true);
  init()
    .then((ok) => {
      if (!ok) return;
      // A SORT PRESSED WHILE THE REGISTRY WAS BEING FOUND still decides the end
      // the first page is read from.
      state.dir = wantDir();
      // THE HERO'S CARD BESIDE THE LIST, never holding it up.
      if (heroWanted()) {
        loadHero().catch(() => {});
        setInterval(() => { if (!document.hidden && hero.v) scanHero(hero.reg); }, HERO_RESCAN_MS);
      } else if ($("hero")) {
        $("hero").hidden = true;
      }
      return runLoad();
    })
    .catch((e) => { showSkeleton(false); say("Could not read: " + e.message); });
}

// ---------------------------------------------------------------------- the hero
//
// THE PANEL ABOVE EXPLORE (the owner's call): one line on what this is, the
// Launch button, and the deployment's first launch - $CURB, made first at
// deploy - as a card with its market cap, its change over 24 hours and its
// price line drawn behind it, all from the chain. No counts.
const TOPIC_CURVE_SELL = keccak256("0x" + utf8Hex("CurveSell(address,address,uint256,uint256,uint256,uint256)"));
const TOPIC_SWAP = keccak256("0x" + utf8Hex("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"));
/// Uniswap v4's PoolManager on Base (token.js POOL_MANAGER): every pool's Swap.
const POOL_MANAGER = "0x498581ff718922c3f8e6a244956af099b2652b2b";
/// WETH on Base: the pair the front page features.
const HERO_WETH = "0x4200000000000000000000000000000000000006";
const DAY_S = 86400;
/// Block times read for the line, the latest trades first; older ones are left out.
const HERO_TIMES_MAX = 150;
const HERO_RESCAN_MS = 2 * 60 * 1000;
const hero = { v: null, pts: null, ref: null, flat: false, reg: "", scanning: false,
  trades: [], times: new Map(), scannedTo: -1 };
/// A LINK MAY LEAVE THE HERO OUT (?hero=0): the list alone, and only the list's
/// own reads - which is how the tests that count those reads open this page.
const heroWanted = () => new URLSearchParams(location.search).get("hero") !== "0";

/// Launches the readers below look at: the list's, and the featured one.
const rowsAndHero = () => (hero.v && !state.rows.includes(hero.v) ? state.rows.concat([hero.v]) : state.rows);

/// A price per whole token in whole units of its asset, as a float (token.js
/// spotPrice and poolPrice): the curve's reserve ratio, or the pool's price.
const qScale = (v) => 10 ** (18 - v.quoteDecimals);
const curveSpot = (v, qr, tr) => (tr > 0n ? (Number(qr) / Number(tr)) * qScale(v) : NaN);
function poolSpot(v, sqrt) {
  const r = Number(sqrt) / 2 ** 96;
  const raw = r * r;
  if (!(raw > 0)) return NaN;
  return v.currency0.toLowerCase() === v.token.toLowerCase() ? raw * qScale(v) : qScale(v) / raw;
}
/// The featured launch's price now: the curve's, or its pool's once read.
function spotNow(v) {
  if (v.status === 1 || v.status === 2) return curveSpot(v, v.quoteReserve, v.tokenReserve);
  const p = v.status === 3 && v.poolId ? pools.get(v.poolId) : null;
  return p && !p.failed ? poolSpot(v, p.sqrt) : NaN;
}

/// THE HERO'S LOG WINDOW, learnt for the visit as "Just bought"'s is: it starts
/// at the public endpoint's 2,000 blocks, or the ceiling the launch-time scan
/// already learnt, and a range or result-size refusal halves it for every
/// later read of the endpoint.
const heroWin = { rpc: "", size: LOG_WINDOW };
/// Logs over a block range, in windows the endpoint accepts. REFUSED NOW IS NOT
/// REFUSED THIS RANGE (logError): a 429, a timeout or a page that is not JSON
/// is asked again after a pause, LOG_TRIES times, with the window as it was.
/// Every error used to halve the window, so four 429s in a row left the card
/// with no line until the next rescan.
async function heroLogs(rpc, filter, from, to) {
  if (heroWin.rpc !== rpc) { heroWin.rpc = rpc; heroWin.size = Math.min(LOG_WINDOW, times.cap); }
  const out = [];
  let busy = 0;
  let start = from;
  while (start <= to) {
    const end = Math.min(to, start + heroWin.size - 1);
    let logs;
    try {
      logs = await rpcAt(rpc, "eth_getLogs", [{ ...filter, fromBlock: hexNum(start), toBlock: hexNum(end) }]);
    } catch (e) {
      if (logError(e) === "busy") {
        busy += 1;
        if (busy > LOG_TRIES) throw e;
        await sleep(LOG_BACKOFF_MS * 2 ** (busy - 1));
        continue;
      }
      if (heroWin.size <= LOG_WINDOW_MIN) throw e;
      heroWin.size = Math.max(LOG_WINDOW_MIN, Math.floor(heroWin.size / 2));
      continue;
    }
    busy = 0;
    out.push(...(Array.isArray(logs) ? logs : []));
    start = end + 1;
  }
  return out;
}
const sgn128 = (w) => { const x = BigInt("0x" + w); return x >= (1n << 127n) ? x - (1n << 128n) : x; };

/// THE PRICE 24 HOURS AGO, read at that block (the curve's reserves, or the
/// pool's slot0): null where the endpoint keeps no state that old, and the
/// first trade of the day stands in.
async function priceAt(rpc, v, block) {
  try {
    const raw = (await callAt(rpc, state.lens, SIGS.launchState + pad(v.token), hexNum(block)) || "0x").replace(/^0x/, "");
    if (raw.length < WORD * 14) return null;
    const status = Number(numAt(raw, 0));
    if (status === 1 || status === 2) return curveSpot(v, numAt(raw, 4), numAt(raw, 5));
    if (status === 3) {
      const s = (await callAt(rpc, STATE_VIEW, SIGS.getSlot0 + v.poolId.replace(/^0x/, ""), hexNum(block)) || "0x").replace(/^0x/, "");
      return s.length >= WORD ? poolSpot(v, BigInt("0x" + s.slice(0, WORD))) : null;
    }
    return null;
  } catch { return null; }
}

/// THE LAST 24 HOURS OF THE FEATURED LAUNCH'S TRADES, as points {t, p}, and
/// the price at the start of them.
async function scanHero(reg) {
  const v = hero.v;
  if (!v || hero.scanning) return;
  hero.scanning = true;
  const rpc = state.rpc;
  try {
    const head = await rpcAt(rpc, "eth_getBlockByNumber", ["latest", false]);
    const latest = parseInt(head.number, 16);
    const now = parseInt(head.timestamp, 16);
    const from = Math.max(0, latest - Math.ceil(DAY_S / BASE_BLOCK_S), await forkFloor(rpc));
    // ITS RECORD NOW, so the price and the market cap keep up with the trades.
    const rec = (await callAt(rpc, state.lens, SIGS.launchState + pad(v.token)).catch(() => "0x") || "0x").replace(/^0x/, "");
    const words = rec.length / WORD;
    if (words >= MIN_VIEW_WORDS && Number.isInteger(words)) {
      const r = recordAt(rec, 0, words, v.token);
      if (r.status !== 0) Object.assign(v, { status: r.status, quoteReserve: r.quoteReserve, tokenReserve: r.tokenReserve,
        realQuoteReserve: r.realQuoteReserve, totalSupply: r.totalSupply });
    }
    // ONLY THE BLOCKS NOT YET READ: the whole day on the first scan, what is
    // new on every scan after it.
    const scanFrom = hero.scannedTo >= from ? hero.scannedTo + 1 : from;
    const [curveLogs, swaps] = scanFrom > latest ? [[], []] : await Promise.all([
      heroLogs(rpc, { address: v.curve, topics: [[TOPIC_CURVE_BUY, TOPIC_CURVE_SELL]] }, scanFrom, latest),
      v.status === 3 && v.poolId
        ? heroLogs(rpc, { address: POOL_MANAGER, topics: [TOPIC_SWAP, v.poolId] }, scanFrom, latest) : Promise.resolve([]),
    ]);
    if (reg !== state.registry || hero.v !== v) return;
    for (const l of curveLogs) {
      const d = (l.data || "0x").replace(/^0x/, "");
      if (d.length < WORD * 4) continue;
      const a = numAt(d, 0), b = numAt(d, 1), fee = numAt(d, 2), tax = numAt(d, 3);
      // A BUY: quote in less fee and tax, for tokens out. A SALE: tokens in,
      // for the quote out plus fee and tax (token.js scanHistory).
      const buy = l.topics[0] === TOPIC_CURVE_BUY;
      const tokens = buy ? b : a;
      const quote = buy ? a - fee - tax : b + fee + tax;
      if (tokens > 0n) hero.trades.push({ block: parseInt(l.blockNumber, 16), index: parseInt(l.logIndex, 16),
        p: (Number(quote) / Number(tokens)) * qScale(v) });
    }
    for (const l of swaps) {
      const d = (l.data || "0x").replace(/^0x/, "");
      if (d.length < WORD * 3) continue;
      hero.trades.push({ block: parseInt(l.blockNumber, 16), index: parseInt(l.logIndex, 16),
        p: poolSpot(v, BigInt("0x" + d.slice(128, 192))) });
    }
    hero.scannedTo = latest;
    hero.trades = hero.trades.filter((x) => x.block >= from).sort((x, y) => x.block - y.block || x.index - y.index);
    // THEIR TIMES, the latest trades first, each block asked once.
    const want = [...new Set(hero.trades.map((x) => x.block))].filter((b) => !hero.times.has(b)).slice(-HERO_TIMES_MAX);
    const got = await rpcBatchAt(rpc, want.map((b) => ({ method: "eth_getBlockByNumber", params: [hexNum(b), false] })));
    want.forEach((b, i) => { if (got[i] && got[i].timestamp) hero.times.set(b, parseInt(got[i].timestamp, 16)); });
    const start = now - DAY_S;
    const pts = hero.trades.filter((x) => hero.times.has(x.block) && hero.times.get(x.block) >= start && isFinite(x.p) && x.p > 0)
      .map((x) => ({ t: hero.times.get(x.block), p: x.p }));
    // THE REFERENCE: the price at the window's start where the chain still has
    // it; else the first trade in the window; a launch younger than a day
    // starts its line at its first trade. NO TRADE IN THE WINDOW, NO MOVE: a
    // curve's price and a pool's change only by trading, so the price now is
    // the price a day ago.
    const younger = Number.isInteger(v.launchedAt) && v.launchedAt > start;
    const at = younger ? null : await priceAt(rpc, v, from);
    if (reg !== state.registry || hero.v !== v) return;
    const known = at && isFinite(at) && at > 0;
    hero.ref = known ? at : pts.length ? pts[0].p : null;
    hero.flat = !known && !pts.length;
    if (known) pts.unshift({ t: start, p: at });
    hero.pts = { list: pts, start: younger ? (pts.length ? pts[0].t : now) : start, now };
    if (v.status === 3) readPools();
  } catch {
    // NO LINE IS DRAWN rather than a wrong one; the card keeps its market cap.
    if (reg === state.registry) { hero.pts = null; hero.ref = null; hero.flat = false; }
  } finally {
    hero.scanning = false;
  }
  if (reg === state.registry) drawHero();
}

/// THE FEATURED LAUNCH: the registry's first launch paired with ETH - $CURB,
/// made first at deploy on the WETH factory (the owner's call: an ETH pair on
/// the front page) - or the launch a link names with ?featured=0x…, when
/// config.js lists it (featuredAllowed). The first page of the registry is
/// searched; with no ETH pair in it, its first launch. Hidden while the
/// registry is empty.
async function loadHero() {
  const reg = state.registry;
  hero.reg = reg;
  hero.v = null; hero.pts = null; hero.ref = null; hero.flat = false;
  hero.trades = []; hero.times = new Map(); hero.scannedTo = -1;
  drawHero();
  if (state.total === 0) return;
  let v = null;
  const named = (new URLSearchParams(location.search).get("featured") || "").trim();
  if (isAddress(named) && featuredAllowed(named)) {
    const raw = (await callAt(state.rpc, state.lens, SIGS.launchState + pad(named)).catch(() => "0x") || "0x").replace(/^0x/, "");
    const words = raw.length / WORD;
    if (words >= MIN_VIEW_WORDS && Number.isInteger(words)) {
      const r = recordAt(raw, 0, words, named.toLowerCase());
      if (r.status !== 0) v = r;
    }
  }
  if (!v) {
    const page = decodeLaunchPage(await callAt(state.rpc, state.lens,
      SIGS.launchPage + pad(0) + pad(Math.min(state.total, LENS_MAX_PAGE))));
    v = page.find((x) => x.quoteToken.toLowerCase() === HERO_WETH) || page[0] || null;
  }
  if (!v || reg !== state.registry) return;
  // A LAUNCH THE SITE NO LONGER SHOWS IS NOT FEATURED (unhidden), and nothing
  // is featured in its place: the next ETH pair is not one anybody chose for
  // the front page. The card stays hidden.
  if (!(await unhidden([v])).length || reg !== state.registry) return;
  const [label, quote] = await Promise.all([labelFor(state.rpc, v.token), quoteMetaFor(state.rpc, v.quoteToken)]);
  if (reg !== state.registry) return;
  v.sym = label.sym; v.name = label.name; v.meta = label.meta;
  v.quoteSym = quote.sym; v.quoteDecimals = quote.decimals; v.quoteNamed = quote.named;
  hero.v = v;
  drawHero();
  ensureRates();
  readPools();
  if (Number.isInteger(v.quoteDecimals)) scanHero(reg);
}

/// A ?featured= LINK IS HONOURED ONLY FOR A LAUNCH config.js LISTS (its
/// featured list, as the site bar read it). The card is the front page's one
/// featured slot, on the genuine domain: any registered launch named in a link
/// stood there, and a stranger's token could be shown, and screenshotted, as
/// featured by Curb. Anything else named is ignored, and the card features
/// what it would with no link.
function featuredAllowed(token) {
  const site = window.CurbBar && window.CurbBar.site ? window.CurbBar.site() : null;
  const listed = site && Array.isArray(site.featured) ? site.featured : [];
  return listed.includes(String(token).trim().toLowerCase());
}

function drawHero() {
  const card = $("heroCard");
  const line = $("heroLine");
  if (!card || !line) return;
  const v = hero.v;
  card.hidden = !v;
  if (!v) { line.replaceChildren(); return; }
  if (!card.dataset.token || card.dataset.token !== v.token.toLowerCase()) buildHeroCard(card, v);
  const m = marketCap(v);
  $("heroMc").textContent = m.text;
  $("heroMc").title = m.title;
  // THE CHANGE OVER THE DAY, in the asset's own terms: now against the reference.
  const chg = $("heroChg");
  const now = spotNow(v);
  const ref = hero.flat ? now : hero.ref;
  if (ref && isFinite(now) && now > 0) {
    const pct = (now / ref - 1) * 100;
    chg.hidden = false;
    // ONE DECIMAL UNDER 1,000%, whole and grouped above it: a launch's first
    // day can multiply its price many thousand times.
    const a = Math.abs(pct);
    chg.textContent = (pct >= 0 ? "+" : "−") +
      (a >= 1000 ? Math.round(a).toLocaleString("en-US") : a.toFixed(1)) + "%";
    chg.classList.toggle("down", pct < 0);
    chg.title = "Over the last 24 hours, in " + (displaySymbol(v.quoteSym || "") || "its asset");
  } else {
    chg.hidden = true;
  }
  drawHeroLine(line, v, now);
}

function buildHeroCard(card, v) {
  card.dataset.token = v.token.toLowerCase();
  card.href = linkFor(cfgNow(), v, null);
  card.onclick = (e) => openLaunch(v, e);
  const pic = $("heroPic");
  pic.replaceChildren();
  const hue = hueOf(v.token);
  const tile = document.createElement("span");
  tile.className = "tile";
  tile.style.background = `linear-gradient(135deg, hsl(${hue} 58% 44%), hsl(${(hue + 48) % 360} 62% 26%))`;
  tile.textContent = firstLetter(v.sym || v.name);
  pic.appendChild(tile);
  if (v.meta && v.meta.image) {
    const im = document.createElement("img");
    im.alt = "";
    im.addEventListener("error", () => im.remove());
    im.src = displayUrl(v.meta.image);
    pic.appendChild(im);
  }
  $("heroSym").textContent = v.sym ? "$" + v.sym : short(v.token);
  $("heroName").textContent = v.name && v.name !== v.sym ? v.name : "";
  const qs = displaySymbol(v.quoteSym || "");
  const disc = $("heroDisc");
  disc.replaceChildren();
  disc.style.background = `hsl(${hueOf(v.quoteToken || "0x")} 58% 42%)`;
  const letters = document.createElement("i");
  letters.textContent = (qs.replace(/[^A-Za-z0-9]/g, "") || "?").slice(0, 1).toUpperCase();
  disc.appendChild(letters);
  const logo = v.quoteNamed ? assetLogo(v.quoteSym) : "";
  if (logo) {
    const li = document.createElement("img");
    li.alt = "";
    li.addEventListener("error", () => li.remove());
    li.src = logo;
    disc.appendChild(li);
  }
  $("heroPairSym").textContent = qs || short(v.quoteToken);
}

/// THE PRICE LINE BEHIND THE CARD: the day's trades and the price now, dashed,
/// over a soft fill, ending in a dot. Flat where nothing traded.
function drawHeroLine(svg, v, now) {
  const NS = "http://www.w3.org/2000/svg";
  svg.replaceChildren();
  const h = hero.pts;
  if (!h) return;
  const pts = h.list.slice();
  if (isFinite(now) && now > 0) pts.push({ t: Math.max(h.now, pts.length ? pts[pts.length - 1].t : h.now), p: now });
  if (!pts.length) return;
  if (pts.length === 1) pts.unshift({ t: h.start, p: pts[0].p });
  const W = 600, H = 220, top = 24, bottom = 40;
  const t0 = Math.min(h.start, pts[0].t), t1 = Math.max(pts[pts.length - 1].t, t0 + 1);
  let y0 = Math.min(...pts.map((x) => x.p)), y1 = Math.max(...pts.map((x) => x.p));
  if (y1 === y0) { y1 = y0 * 1.1; y0 = y0 * 0.9; }
  const X = (t) => ((t - t0) / (t1 - t0)) * W;
  const Y = (p) => top + (1 - (p - y0) / (y1 - y0)) * (H - top - bottom);
  // A STEP AT EACH TRADE: the price holds until the next one moves it.
  let d = "M" + X(pts[0].t).toFixed(1) + " " + Y(pts[0].p).toFixed(1);
  for (let i = 1; i < pts.length; i++) {
    d += " L" + X(pts[i].t).toFixed(1) + " " + Y(pts[i - 1].p).toFixed(1) + " L" + X(pts[i].t).toFixed(1) + " " + Y(pts[i].p).toFixed(1);
  }
  const defs = document.createElementNS(NS, "defs");
  defs.innerHTML = '<linearGradient id="heroFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9cc3ff" stop-opacity="0.16"/><stop offset="1" stop-color="#9cc3ff" stop-opacity="0"/></linearGradient>';
  const area = document.createElementNS(NS, "path");
  area.setAttribute("d", d + ` L${W} ${Y(pts[pts.length - 1].p).toFixed(1)} L${W} ${H} L${X(pts[0].t).toFixed(1)} ${H} Z`);
  area.setAttribute("fill", "url(#heroFill)");
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", d + ` L${W} ${Y(pts[pts.length - 1].p).toFixed(1)}`);
  path.setAttribute("class", "heroPath");
  const last = pts[pts.length - 1];
  // A ROUND CAP ON A ZERO-LENGTH STROKE: a dot that stays round however the
  // drawing is stretched to the panel.
  const dot = document.createElementNS(NS, "path");
  dot.setAttribute("d", "M" + Math.min(X(last.t), W - 4).toFixed(1) + " " + Y(last.p).toFixed(1) + " l0.01 0");
  dot.setAttribute("class", "heroDot");
  svg.append(defs, area, path, dot);
  svg.dataset.points = String(pts.length);
}

// FOR THE BROWSER TESTS: the quote-metadata reader, so a test can ask what a
// second read returns after a failed one. The page only shows that when a
// later card on the same asset happens to exist, which a fixture cannot
// promise.
window.CurbBrowse = { quoteMetaFor, logError, decodeLaunchPage, get rpc() { return state.rpc; }, get lens() { return state.lens; },
  // "Just bought"'s window as learnt, for the test of its refused range.
  get buyWindow() { return buys.window; } };

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();

})();
