// THE $CURB PAGE'S LIVE FIGURES, AND ITS LIST OF BURNS.
//
// WHAT IS READ, AND FROM WHERE. The endpoint and lens the site bar carries
// (CurbBar.config(), topbar.js) - a link's pair, else the pair saved on
// app.html, else none - and nothing else. From the lens: its registry; from the
// registry: the launch count, the hook (requiredHook) and every admitted
// factory; from the hook: the platform share launches are frozen with now, its
// cap, the announced change if any, and the recipient; from each factory: its
// paired asset, its fee escrow and the recipient it was deployed with. Then
// what the escrows and the hook still hold for the platform.
//
// WHAT IS NOT READ: the curves. The platform's share of a curve's fees sits in
// the curve until that launch's creator sweeps it or the launch graduates, and
// adding it up means one read per launch. The page says so under the figure
// rather than pretending it is the whole.
//
// NO WALLET IS ASKED ANYTHING, EVER. Reads go straight to the endpoint with
// fetch; a visitor with no wallet sees the same page, and the bar's own tests
// hold that nothing here calls eth_accounts after a Disconnect.
//
// EVERY FIGURE FAILS QUIETLY, on its own. Each starts as a dash and stays one
// when it cannot be read: an older hook without the announce fields, a factory
// that will not answer, an endpoint that is down. One missing read never takes
// the rest with it, and nothing here throws out of a promise - the site's
// tests fail a page on any uncaught error.
(function () {
"use strict";

// ================================================================ OWNER PLACEHOLDERS
// Both are filled in by hand; nothing on chain says what they are.
//
// TREASURY: the address the burns are bought from. OWNER PLACEHOLDER - leave ""
// until it is published; the page then says "not published yet".
const TREASURY = "";
//
// BURNS: one entry per burn, newest first, added after each one:
//   { date: "2026-10-31", spent: "1.25 ETH", burned: "12,345,678 $CURB",
//     swapTx: "0x…64 hex…", burnTx: "0x…64 hex…" }
// spent and burned are written as they should read. The links go to Basescan,
// because the burns happen on Base mainnet whatever chain this visit reads.
const BURNS = [];
// ================================================================

const $ = (id) => document.getElementById(id);
const isAddr = (s) => /^0x[0-9a-fA-F]{40}$/.test(String(s || "").trim());
const isRpc = (s) => /^https?:\/\/[^\s"'<>]{1,200}$/i.test(String(s || "").trim());
const isTx = (s) => /^0x[0-9a-fA-F]{64}$/.test(String(s || ""));
const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
const same = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
const WETH = "0x4200000000000000000000000000000000000006";
const BASESCAN = "https://basescan.org";

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function set(id, text, title) {
  const e = $(id);
  if (!e) return;
  e.textContent = text;
  if (title != null) e.title = title;
}

// ---------------------------------------------------------------- burns
// Drawn before any read, and with no endpoint at all: this list is the
// owner's, not the chain's.
function drawBurns() {
  const list = $("burnList");
  const count = $("burnCount");
  const rows = BURNS.filter((b) => b && typeof b === "object");
  if (count) count.textContent = String(rows.length);
  if (list && rows.length) {
    list.textContent = "";
    const box = el("div", "rows");
    for (const b of rows) {
      const row = el("div", "row burnRow");
      const what = el("div", "asset", String(b.burned || "").slice(0, 60) || "Burn");
      what.append(el("small", null, [b.date, b.spent ? "bought with " + b.spent : ""].filter(Boolean).join(" · ").slice(0, 80)));
      const links = el("div", "links");
      for (const [label, tx] of [["Swap", b.swapTx], ["Burn", b.burnTx]]) {
        if (!isTx(tx)) continue;
        const a = el("a", null, label + " transaction");
        a.href = BASESCAN + "/tx/" + tx;
        a.target = "_blank";
        a.rel = "noreferrer noopener";
        links.append(a);
      }
      row.append(what, links);
      box.append(row);
    }
    list.append(box);
  }
  const line = $("treasuryLine");
  if (line && isAddr(TREASURY)) {
    line.textContent = "Treasury address: ";
    const a = el("a");
    a.href = BASESCAN + "/address/" + TREASURY;
    a.target = "_blank";
    a.rel = "noreferrer noopener";
    a.append(el("code", null, TREASURY));
    line.append(a);
  }
}

// ---------------------------------------------------------------- transport
const TIMEOUT_MS = 12_000;
// A FEW AT A TIME. Eleven factories came to about a hundred reads (fourteen
// are listed since 2026-10-15), and a burst of that size is what gets a public
// endpoint to refuse.
const MAX_IN_FLIGHT = 6;
// The registry's own list only grows; a count past this is a registry this
// page will not walk (app.js quoteChoices holds the same line).
const MAX_LAUNCHERS = 256;
const MAX_RECIPIENTS = 4;

let rpcId = 0;
let inFlight = 0;
const queue = [];
function slot() {
  if (inFlight < MAX_IN_FLIGHT) { inFlight++; return Promise.resolve(); }
  return new Promise((resolve) => queue.push(resolve));
}
function release() {
  const next = queue.shift();
  if (next) next(); else inFlight--;
}

async function rpc(url, method, params) {
  await slot();
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : 0;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
      signal: ctl ? ctl.signal : undefined,
    });
    const body = await res.json();
    if (body.error) throw new Error(body.error.message || "the endpoint refused the read");
    return body.result;
  } finally {
    clearTimeout(timer);
    release();
  }
}

// SELECTORS FROM THEIR SIGNATURES, never pasted (search.js does the same).
const utf8Hex = (s) => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, "0")).join("");
let SEL = null;
function selectors() {
  const sig = (s) => window.CurbKeccak.keccak256("0x" + utf8Hex(s)).slice(0, 10);
  return {
    registry: sig("registry()"),
    requiredHook: sig("requiredHook()"),
    launchCount: sig("launchCount()"),
    launcherCount: sig("launcherCount()"),
    launcherAt: sig("launcherAt(uint256)"),
    platformFeeBps: sig("platformFeeBps()"),
    maxPlatformFeeBps: sig("maxPlatformFeeBps()"),
    pendingFeeBps: sig("pendingFeeBps()"),
    pendingFeeReadyAt: sig("pendingFeeReadyAt()"),
    platformRecipient: sig("platformRecipient()"),
    pendingRecipient: sig("pendingRecipient()"),
    pendingRecipientReadyAt: sig("pendingRecipientReadyAt()"),
    changeWindow: sig("POLICY_CHANGE_WINDOW()"),
    quoteToken: sig("quoteToken()"),
    feeEscrow: sig("feeEscrow()"),
    protocolFeeRecipient: sig("protocolFeeRecipient()"),
    balanceOfToken: sig("balanceOfToken(address,address)"),
    owed: sig("owed(address,address)"),
    symbol: sig("symbol()"),
    decimals: sig("decimals()"),
  };
}

// ---------------------------------------------------------------- decoding
// A CALL TO AN ADDRESS WITH NO CODE ANSWERS "0x", NOT AN ERROR - and a
// function the contract does not have answers the same. Both are "not read".
function firstWord(raw) {
  const h = String(raw || "").replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}/.test(h)) throw new Error("no answer");
  return h.slice(0, 64);
}
const num = (raw) => BigInt("0x" + firstWord(raw));
function addr(raw) {
  const w = firstWord(raw);
  if (!/^0{24}/.test(w)) throw new Error("not an address");
  const a = "0x" + w.slice(24);
  if (/^0x0{40}$/.test(a)) throw new Error("the zero address");
  return a;
}
const pad = (v) => BigInt(v).toString(16).padStart(64, "0");
const padAddr = (a) => a.replace(/^0x/, "").toLowerCase().padStart(64, "0");

const pct = (bps) => (Number(bps) / 100).toFixed(2) + "%";

/// An amount in a token's own units, readable: four decimals, or three
/// significant digits when that needs more - so a small balance never shows as
/// a bare zero.
function units(v, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return v.toString() + " raw units";
  const s = v.toString().padStart(decimals + 1, "0");
  const whole = BigInt(s.slice(0, s.length - decimals));
  const frac = decimals ? s.slice(s.length - decimals) : "";
  let keep;
  if (whole > 0n) keep = frac.slice(0, 4);
  else {
    const lead = frac.search(/[1-9]/);
    keep = lead < 0 ? "" : frac.slice(0, Math.max(4, lead + 3));
  }
  keep = keep.replace(/0+$/, "");
  const w = whole.toLocaleString("en-US");
  return keep ? w + "." + keep : w;
}

/// A chain timestamp as the visitor's own clock would read it.
function when(sec) {
  try {
    return new Date(Number(sec) * 1000).toLocaleString("en-GB", {
      day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
    });
  } catch { return "timestamp " + String(sec); }
}

function chainName(id) {
  if (id === 8453) return "Base";
  if (id === 84532) return "Base Sepolia";
  return "chain " + id;
}

// THE ASSET'S BADGE, as the token page draws it (app.js assetLogo): the file
// named by its symbol, for the symbols there is a file for. A symbol is a
// stranger's string, so it is only ever matched against this list and put into
// textContent.
const LOGOS = { weth: "weth.svg", cbbtc: "cbbtc.svg", cbxrp: "cbxrp.svg", cbzec: "cbzec.svg",
  cbhype: "cbhype.png", cbmega: "cbmega.png", nvdac: "nvdac.svg", googlc: "googlc.svg", spcxc: "spcxc.svg",
  amznc: "amznc.svg", msftc: "msftc.svg", aaplc: "aaplc.svg", metac: "metac.svg" };
const ASSET_VERSION = "4";   // app.js ASSET_VERSION: the same files, the same cache key

// ---------------------------------------------------------------- the reads
// SAID IN THE VISITOR'S WORDS. "Lens", "endpoint" and "rpc" are this site's
// own names for where it reads; the lens address, when there is one worth
// having, goes in the tooltip. Every call sets the tooltip, so a later message
// never keeps an earlier one's.
function quiet(text, title) { set("liveSource", text, title || ""); }

async function readLive(cfg) {
  const url = cfg.rpc.trim();
  const lens = cfg.lens.trim();
  quiet("Reading…");

  // ONE BLOCK FOR EVERY READ, so the figures describe the same moment - and
  // its timestamp is the chain's "now" for the announced change, which on a
  // fork need not be the visitor's.
  const blockHex = await rpc(url, "eth_blockNumber", []);
  if (typeof blockHex !== "string" || !/^0x[0-9a-fA-F]+$/.test(blockHex)) throw new Error("no block number");
  const call = (to, data) => rpc(url, "eth_call", [{ to, data }, blockHex]);
  const [chainHex, block] = await Promise.all([
    rpc(url, "eth_chainId", []).catch(() => null),
    rpc(url, "eth_getBlockByNumber", [blockHex, false]).catch(() => null),
  ]);
  const now = block && block.timestamp ? Number(BigInt(block.timestamp)) : Math.floor(Date.now() / 1000);
  const chain = chainHex ? chainName(Number(BigInt(chainHex))) : "the chain";

  let registry;
  try { registry = addr(await call(lens, SEL.registry)); }
  catch { quiet("Nothing could be read from this deployment.", "No lens answered at " + lens); return; }
  quiet("Read from " + chain + " at block " + BigInt(blockHex).toLocaleString("en-US") + ".",
    "Read through the lens at " + lens);

  // THE LAUNCH COUNT, on its own - it needs nothing else.
  call(registry, SEL.launchCount)
    .then((r) => set("liveCount", num(r).toLocaleString("en-US")))
    .catch(() => {});

  let hook;
  try { hook = addr(await call(registry, SEL.requiredHook)); }
  catch { set("livePendingNote", "The registry names no fee hook yet."); return; }

  const opt = (p) => p.catch(() => null);
  const [share, cap, pBps, pAt, recip, pRecip, pRecipAt, windowRaw] = await Promise.all([
    opt(call(hook, SEL.platformFeeBps)), opt(call(hook, SEL.maxPlatformFeeBps)),
    opt(call(hook, SEL.pendingFeeBps)), opt(call(hook, SEL.pendingFeeReadyAt)),
    opt(call(hook, SEL.platformRecipient)), opt(call(hook, SEL.pendingRecipient)),
    opt(call(hook, SEL.pendingRecipientReadyAt)), opt(call(hook, SEL.changeWindow)),
  ]);
  const tryNum = (raw) => { try { return raw == null ? null : num(raw); } catch { return null; } };
  const tryAddr = (raw) => { try { return raw == null ? null : addr(raw); } catch { return null; } };

  const shareBps = tryNum(share);
  if (shareBps != null && shareBps <= 10_000n) set("liveShare", pct(shareBps), shareBps + " bps");
  const capBps = tryNum(cap);
  if (capBps != null && capBps <= 10_000n) set("liveCap", "Most it can be set to: " + pct(capBps), capBps + " bps, fixed in the contract");

  const win = tryNum(windowRaw);
  drawPending(tryNum(pBps), tryNum(pAt), win, now);

  const recipient = tryAddr(recip);
  if (recipient) set("liveRecipient", short(recipient), recipient);
  drawPendingRecipient(tryAddr(pRecip), tryNum(pRecipAt), win, now);

  await readWaiting(call, registry, hook, recipient);
}

/// THE ANNOUNCED CHANGE, SAID AS THE CONTRACT HAS IT. Announcing starts a
/// 24-hour wait; after it the owner MAY apply the change, within the window,
/// and nothing applies it by itself. Past the window it has lapsed and can only
/// be announced again. Applied, it reaches launches created afterwards only.
function drawPending(bps, readyAt, win, now) {
  if (readyAt == null) return;                         // an older hook, or not read
  if (readyAt === 0n) { set("livePending", "None"); set("livePendingNote", "Nothing is announced. A change is announced 24 hours before it can apply."); return; }
  const shown = bps != null && bps <= 10_000n ? pct(bps) : "a new share";
  const until = win != null ? readyAt + win : null;
  if (until != null && BigInt(now) > until) {
    set("livePending", "None");
    set("livePendingNote", "A change to " + shown + " was announced and lapsed on " + when(until) + " without being applied.");
    return;
  }
  set("livePending", shown, bps != null ? bps + " bps" : null);
  const from = BigInt(now) >= readyAt ? "Can be applied now" : "Can be applied from " + when(readyAt);
  set("livePendingNote", from + (until != null ? ", until " + when(until) : "") +
    ". It would reach only launches created after it applies.");
}

function drawPendingRecipient(next, readyAt, win, now) {
  if (!next || readyAt == null || readyAt === 0n) return;
  const until = win != null ? readyAt + win : null;
  if (until != null && BigInt(now) > until) return;    // lapsed: nothing is coming
  const note = $("liveRecipientNote");
  if (!note) return;
  const s = el("span", "sub warnTxt",
    "Change announced to " + short(next) + ": " +
    (BigInt(now) >= readyAt ? "can be applied now" : "can be applied from " + when(readyAt)) +
    (until != null ? ", until " + when(until) : "") + ".");
  s.title = next;
  note.after(s);
}

/// WHAT THE ESCROWS AND THE HOOK HOLD FOR THE PLATFORM, per paired asset.
///
/// FOR WHICH RECIPIENTS: the hook's current one and each factory's deployment
/// one. A launch pays the recipient frozen into it, so after a rotation the
/// older launches still owe the old address; the deployment's is the one a
/// rotation would have left behind. A recipient in between two rotations is not
/// found this way. The note under the figure keeps to what a visitor needs -
/// fees in the contracts and not yet claimed, curve fees left out -
/// and the disclaimer says that figures read from the chain may be incomplete.
async function readWaiting(call, registry, hook, current) {
  const box = $("liveWaiting");
  const say = (text) => {
    if (!box) return;
    box.textContent = "";
    box.append(el("div", "row empty", text));
  };
  say("Reading…");

  let count;
  try { count = num(await call(registry, SEL.launcherCount)); }
  catch { say("Could not be read."); return; }
  if (count > BigInt(MAX_LAUNCHERS)) { say("Not read: the registry reports more factories than this page reads."); return; }

  // Every factory: its asset, its escrow, its deployment recipient.
  const factories = await Promise.all(Array.from({ length: Number(count) }, async (_, i) => {
    try {
      const f = addr(await call(registry, SEL.launcherAt + pad(i)));
      const [q, e, r] = await Promise.all([
        call(f, SEL.quoteToken).then(addr),
        call(f, SEL.feeEscrow).then(addr),
        call(f, SEL.protocolFeeRecipient).then(addr).catch(() => null),
      ]);
      return { quote: q, escrow: e, deployedTo: r };
    } catch { return null; }
  }));
  const unreadFactories = factories.filter((f) => !f).length;
  const ok = factories.filter(Boolean);

  const recipients = [];
  for (const r of [current, ...ok.map((f) => f.deployedTo)]) {
    if (r && !recipients.some((x) => same(x, r)) && recipients.length < MAX_RECIPIENTS) recipients.push(r);
  }
  if (!recipients.length) { say("Could not be read: no platform recipient answered."); return; }

  // One entry per asset, in the registry's order.
  const assets = [];
  for (const f of ok) {
    let a = assets.find((x) => same(x.quote, f.quote));
    if (!a) { a = { quote: f.quote, escrows: [], sym: "", decimals: null, escrow: 0n, hook: 0n, unread: false }; assets.push(a); }
    if (!a.escrows.some((e) => same(e, f.escrow))) a.escrows.push(f.escrow);
  }

  await Promise.all(assets.map(async (a) => {
    const [symRaw, decRaw] = await Promise.all([
      call(a.quote, SEL.symbol).catch(() => null),
      call(a.quote, SEL.decimals).catch(() => null),
    ]);
    try { a.sym = window.CurbMeta.cut(window.CurbMeta.decodeString(symRaw), 12); } catch { a.sym = ""; }
    try { const d = Number(num(decRaw)); if (d <= 36) a.decimals = d; } catch { /* unknown scale, said as raw units */ }
    const reads = [];
    for (const r of recipients) {
      for (const e of a.escrows) {
        reads.push(call(e, SEL.balanceOfToken + padAddr(r) + padAddr(a.quote))
          .then((raw) => { a.escrow += num(raw); }).catch(() => { a.unread = true; }));
      }
      reads.push(call(hook, SEL.owed + padAddr(r) + padAddr(a.quote))
        .then((raw) => { a.hook += num(raw); }).catch(() => { a.unread = true; }));
    }
    await Promise.all(reads);
  }));

  if (!box) return;
  box.textContent = "";
  const shownRows = assets.filter((a) => a.escrow + a.hook > 0n);
  for (const a of shownRows) box.append(assetRow(a));
  const unread = assets.filter((a) => a.unread && a.escrow + a.hook === 0n).length + unreadFactories;
  if (!shownRows.length) {
    box.append(el("div", "row empty", unread ? "Nothing waiting where it could be read." : "Nothing waiting to be claimed."));
  }
  if (unread) box.append(el("div", "row empty", unread === 1 ? "One paired asset could not be read." : unread + " paired assets could not be read."));
}

function assetRow(a) {
  const row = el("div", "row");
  const isWeth = same(a.quote, WETH);
  // WETH IS ETH TO THE PERSON READING (app.js displaySymbol), and both the
  // escrow and the hook pay it out as ETH when it is claimed.
  const label = isWeth ? "ETH" : (a.sym || short(a.quote));
  const badge = el("span", "badge");
  const file = LOGOS[(isWeth ? "weth" : a.sym).toLowerCase().replace(/[^a-z0-9]/g, "")];
  if (file) {
    const img = el("img");
    img.alt = "";
    img.src = "assets/" + file + "?v=" + ASSET_VERSION;
    img.onerror = () => { img.remove(); badge.textContent = label.slice(0, 2).toUpperCase(); };
    badge.append(img);
  } else {
    badge.textContent = label.slice(0, 2).toUpperCase();
  }
  const name = el("span", "asset", label);
  name.title = (a.sym || "") + " " + a.quote;
  const parts = [];
  if (a.escrow > 0n) parts.push(units(a.escrow, a.decimals) + " in the fee escrow");
  if (a.hook > 0n) parts.push(units(a.hook, a.decimals) + " in the fee hook");
  if (a.unread) parts.push("partly unread");
  name.append(el("small", null, parts.join(" · ")));
  const amt = el("span", "amt", units(a.escrow + a.hook, a.decimals) + " " + label);
  row.append(badge, name, amt);
  return row;
}

// ---------------------------------------------------------------- boot
function boot() {
  drawBurns();
  const cfg = window.CurbBar ? window.CurbBar.config() : { rpc: "", lens: "", halfLink: false };
  // A HALF LINK IS SAID, NOT FILLED IN (browse.js does the same): a URL cut at
  // its "&" named somewhere, and reading the saved deployment instead would
  // show that somewhere else without a word.
  if (cfg.halfLink) {
    quiet("This link is incomplete, so nothing is read.");
    return;
  }
  if (!isAddr(cfg.lens) || !isRpc(cfg.rpc)) {
    quiet("Not read: this visit is not pointed at a deployment. The figures appear when the site is.");
    return;
  }
  if (!window.CurbKeccak || !window.CurbMeta) { quiet("Not read: a script this page needs did not load."); return; }
  try { SEL = selectors(); } catch { quiet("Not read."); return; }
  readLive(cfg).catch(() => {
    quiet("Could not be read just now.");
    const box = $("liveWaiting");
    if (box && /Reading/.test(box.textContent)) { box.textContent = ""; box.append(el("div", "row empty", "—")); }
  });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();

})();
