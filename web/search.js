// THE SITE'S SEARCH: one sheet, on every page, opened from the bar's search box
// or with Ctrl K (Cmd K on a Mac).
//
// It used to live on the launches page only, and searched only the cards that
// page had loaded. It is the bar's now, so it cannot lean on any page's state:
// it reads the registry itself, through the lens the bar's links carry - the
// newest launches, their symbols and names - and searches those. There is no
// server to ask, so the sheet says how many it searched rather than letting an
// empty result read as an empty registry. A full address is always offered,
// loaded or not.
//
// LOADED ONLY WHEN FIRST USED. topbar.js fetches this file (and keccak.js and
// token-meta.js if the page has not) on the first click or Ctrl K, so a page
// that never searches makes no request for it and no read of the chain.
(function () {
"use strict";

const LIMIT = 200;          // the newest launches read and searched
const PAGE = 50;            // LaunchLens.MAX_PAGE
const LABEL_CONCURRENCY = 8;
const CACHE_MS = 60_000;    // one read serves every page for a minute

const isAddr = (s) => /^0x[0-9a-fA-F]{40}$/.test(String(s || "").trim());
const bar = () => window.CurbBar;
const { keccak256 } = window.CurbKeccak;
const { decodeString, cut, parseMeta, displayUrl } = window.CurbMeta;

// SELECTORS FROM THEIR SIGNATURES, never pasted.
const utf8Hex = (s) => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, "0")).join("");
const sig = (s) => keccak256("0x" + utf8Hex(s)).slice(0, 10);
const SIGS = {
  registry: sig("registry()"),
  launchCount: sig("launchCount()"),
  launchPage: sig("launchPage(uint256,uint256)"),
  symbol: sig("symbol()"),
  name: sig("name()"),
  // tokenURI, not tokenUri: the selector is the whole signature (browse.js).
  tokenUri: sig("tokenURI()"),
};

let rpcId = 0;
/// The headers of a JSON-RPC POST to `url` (multicall.js headers): text/plain to
/// the site's own endpoints, so no CORS preflight is made first.
const rpcHeaders = (url) => (window.CurbMulti && window.CurbMulti.headers ? window.CurbMulti.headers(url)
  : { "content-type": "application/json" });
async function call(rpc, to, data) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: rpcHeaders(rpc),
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "eth_call", params: [{ to, data }, "latest"] }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || JSON.stringify(body.error));
  return body.result;
}

// ---------------------------------------------------------------- the index
// The same flat decoding as browse.js: LaunchView is fully static, so a page
// is two offsets, two lengths and fixed-size records - whose size is READ OFF
// THE ANSWER (browse.js viewStride): 14 words from a lens before core v2, 16
// from the current one, more from a later one that appends.
const WORD = 64;
const wordAt = (hex, i) => hex.slice(i * WORD, (i + 1) * WORD);
const numAt = (hex, i) => BigInt("0x" + wordAt(hex, i));
const addrAt = (hex, i) => "0x" + wordAt(hex, i).slice(24);
const MIN_VIEW_WORDS = 14;
const pad = (v) => BigInt(v).toString(16).padStart(WORD, "0");

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
  if (n !== Number(numAt(hex, viewsAt))) throw new Error("the lens returned a page whose two halves disagree");
  const stride = viewStride(hex, viewsAt, n);
  const out = [];
  for (let i = 0; i < n; i++) {
    const base = viewsAt + 1 + i * stride;
    out.push({
      token: addrAt(hex, tokensAt + 1 + i),
      status: Number(numAt(hex, base)),
      // THE CURVE says which factory made the launch, for the incident
      // switches (unhidden).
      curve: addrAt(hex, base + 1),
      realQuoteReserve: numAt(hex, base + 6).toString(),
      graduationThreshold: numAt(hex, base + 7).toString(),
    });
  }
  return out;
}

/// THE PROGRESS THE CURVE GRADUATES ON: real quote taken in, against the
/// threshold - as browse.js draws it.
function progressOf(v) {
  const th = BigInt(v.graduationThreshold);
  if (th === 0n) return 0;
  return Math.min(Number((BigInt(v.realQuoteReserve) * 10000n) / th) / 100, 100);
}

// read: how many launches were read, those the site no longer shows included,
// so the sheet's count is of what was searched. hidden: the tokens left out.
const index = { key: "", total: 0, read: 0, rows: [], hidden: new Set(), state: "idle", error: "" };

/// THE INCIDENT SWITCHES (config.js hiddenLaunches and hiddenFactories, read
/// through the site bar - CurbBar.incident - so the search leaves out what the
/// Launches grid and its hero leave out).
const incident = () => (bar() && bar().incident) || null;
/// Which of these launches the site no longer shows. With nothing hidden it reads nothing.
async function hiddenOf(cfg, rows) {
  const inc = incident();
  if (!inc || !inc.any()) return rows.map(() => false);
  return Promise.all(rows.map((v) => inc.launchHidden(cfg.rpc, v)));
}
/// A NEW HIDE LIST IS A NEW INDEX: the cache is keyed by it too, so a launch
/// hidden on deploy is not served for another minute from a tab's cache.
const hiddenKey = () => {
  const s = bar() && bar().site ? bar().site() : null;
  return s ? (s.hiddenFactories || []).concat(["|"], s.hiddenLaunches || []).join(",") : "";
};
const cacheKey = (cfg) => "curb.search.v1:" + cfg.rpc + "|" + cfg.lens.toLowerCase() + "|" + hiddenKey();

function fromCache(cfg) {
  try {
    const c = JSON.parse(sessionStorage.getItem(cacheKey(cfg)) || "null");
    if (c && Date.now() - c.at < CACHE_MS && Array.isArray(c.rows)) return c;
  } catch { /* private mode, or a damaged entry */ }
  return null;
}
function toCache(cfg) {
  const put = (rows) => sessionStorage.setItem(cacheKey(cfg), JSON.stringify({ at: Date.now(), total: index.total,
    read: index.read, hidden: [...index.hidden], rows }));
  try { put(index.rows); } catch {
    // A PICTURE STORED AS BYTES IS UP TO 64 KB, and two hundred of them do
    // not fit in a tab's storage: kept without the pictures, then, rather
    // than not at all - the letter tile stands in until the next read.
    try { put(index.rows.map((r) => ({ ...r, image: "" }))); } catch { /* full, or private mode */ }
  }
}

async function load() {
  const cfg = bar() ? bar().config() : { rpc: "", lens: "" };
  if (!isAddr(cfg.lens)) { index.state = "noregistry"; render(); return; }
  const key = cacheKey(cfg);
  if (index.key === key && (index.state === "ready" || index.state === "loading")) return;
  index.key = key;
  const cached = fromCache(cfg);
  if (cached) {
    index.total = cached.total; index.rows = cached.rows; index.state = "ready";
    index.read = Number.isSafeInteger(cached.read) ? cached.read : cached.rows.length;
    index.hidden = new Set(Array.isArray(cached.hidden) ? cached.hidden : []);
    render();
    return;
  }
  index.state = "loading"; index.rows = []; index.total = 0; index.read = 0; index.hidden = new Set(); render();
  try {
    const regRaw = await call(cfg.rpc, cfg.lens, SIGS.registry);
    // A CALL TO AN ADDRESS WITH NO CODE ANSWERS "0x", NOT AN ERROR.
    if (!regRaw || regRaw === "0x") throw new Error("the lens at " + cfg.lens + " did not answer registry()");
    const registry = "0x" + regRaw.slice(-40);
    const countRaw = await call(cfg.rpc, registry, SIGS.launchCount);
    if (!countRaw || countRaw === "0x") throw new Error("the registry did not answer launchCount()");
    const total = Number(BigInt(countRaw));
    const rows = [];
    // NEWEST FIRST, a page at a time, up to LIMIT. A short page is an error:
    // the registry only ever appends, so a page that comes back short is a lens
    // or an endpoint not telling the whole truth.
    let end = total;
    while (end > 0 && rows.length < LIMIT) {
      const count = Math.min(PAGE, end, LIMIT - rows.length);
      const start = end - count;
      const page = decodeLaunchPage(await call(cfg.rpc, cfg.lens, SIGS.launchPage + pad(start) + pad(count)));
      if (page.length !== count) throw new Error(`the lens returned ${page.length} launches for a page of ${count}`);
      rows.push(...page.reverse());
      end = start;
      if (index.key !== key) return;                    // the page moved on
    }
    // WHAT THE SITE NO LONGER SHOWS IS LEFT OUT before any name is read for it.
    const off = await hiddenOf(cfg, rows);
    if (index.key !== key) return;
    index.total = total;
    index.read = rows.length;
    index.hidden = new Set(rows.filter((_, i) => off[i]).map((v) => v.token.toLowerCase()));
    index.rows = rows.filter((_, i) => !off[i]).map((v) => ({ ...v, sym: "", name: "", image: "", labelled: false }));
    index.state = "ready";
    render();
    await labelAll(cfg, key);
    if (index.key === key) toCache(cfg);
  } catch (e) {
    if (index.key !== key) return;
    index.state = "error";
    index.error = (e && e.message) || String(e);
    render();
  }
}

/// SYMBOLS AND NAMES, A FEW AT A TIME, drawn as they arrive: an address is
/// searchable from the first moment, a symbol as soon as it is read. A token
/// that will not answer is still listed, by its address.
///
/// DRAWN WITHOUT MOVING ANYTHING. A flush runs at most every 250 ms, and it
/// redraws through render(LABELS): rows already on screen keep their places and
/// a row that newly matches is added below them, and nothing is redrawn at all
/// while the pointer is over the list - the flush waits for it to leave. A
/// label arriving used to insert its row above the one under the pointer, so a
/// click could open a launch other than the one aimed at (round 5, N47).
async function labelAll(cfg, key) {
  let next = 0;
  let dirty = false;
  const flush = () => { if (dirty && index.key === key) { dirty = false; render(LABELS); } };
  const tick = setInterval(flush, 250);
  async function worker() {
    while (next < index.rows.length) {
      const row = index.rows[next++];
      try {
        const [s, n, u] = await Promise.all([
          call(cfg.rpc, row.token, SIGS.symbol).catch(() => ""),
          call(cfg.rpc, row.token, SIGS.name).catch(() => ""),
          // THE TOKEN'S PICTURE (the owner's call), read by token-meta.js's
          // rules - the ones the launches page uses: a stranger's string,
          // kept only as an https, ipfs or raster data image.
          call(cfg.rpc, row.token, SIGS.tokenUri).catch(() => ""),
        ]);
        if (index.key !== key) return;
        row.sym = cut(safeDecode(s), 16);
        row.name = cut(safeDecode(n), 48);
        let meta;
        try { meta = parseMeta(safeDecode(u)); } catch { meta = { image: "" }; }
        row.image = meta.image ? displayUrl(meta.image) : "";
      } catch { /* listed by its address */ }
      row.labelled = true;
      dirty = true;
    }
  }
  try {
    await Promise.all(Array.from({ length: LABEL_CONCURRENCY }, worker));
  } finally {
    clearInterval(tick);
    dirty = true;
    flush();
  }
}
function safeDecode(raw) { try { return decodeString(raw); } catch { return ""; } }

// ---------------------------------------------------------------- the sheet
let overlay, input, results, scope;
// order: the tokens on screen, in the order drawn, for the query in `q`.
// heldLabels: a label redraw is waiting for the pointer to leave the list.
const view = { open: false, sel: 0, hits: [], q: null, order: [], heldLabels: false };
/// render()'s argument when the redraw is only labels arriving - see labelAll.
const LABELS = "labels";

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function build() {
  overlay = el("div", "cbOverlay");
  overlay.id = "cbSearch";
  overlay.hidden = true;
  const sheet = el("div", "cbSheet");
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.setAttribute("aria-label", "Search launches");
  const sbar = el("div", "cbSbar");
  // A constant icon - the only markup written as a string.
  const ico = el("span", "cbSico");
  ico.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
  input = el("input");
  input.id = "cbSq";
  input.spellcheck = false;
  input.autocomplete = "off";
  input.placeholder = "Search by symbol, name or address";
  input.setAttribute("aria-label", "Search launches");
  const esc = el("button", "cbEsc", "Esc");
  esc.type = "button";
  esc.onclick = close;
  sbar.append(ico, input, esc);
  results = el("div", "cbSresults");
  results.id = "cbSresults";
  const foot = el("div", "cbSfoot");
  const k1 = el("span");
  k1.append(el("kbd", "", "Up"), el("kbd", "", "Down"), document.createTextNode("move"));
  const k2 = el("span");
  k2.append(el("kbd", "", "Enter"), document.createTextNode("open"));
  scope = el("span", "cbScope");
  scope.id = "cbSscope";
  foot.append(k1, k2, scope);
  sheet.append(sbar, results, foot);
  overlay.append(sheet);
  // Only the backdrop closes on a click; the sheet swallows its own.
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  input.addEventListener("input", () => { view.sel = 0; render(); });
  // A LABEL REDRAW HELD WHILE THE POINTER WAS OVER THE LIST happens as it leaves.
  results.addEventListener("mouseleave", () => { if (view.heldLabels) render(LABELS); });
  document.body.append(overlay);
}

const matches = (v, q) => !q || v.sym.toLowerCase().includes(q) || v.name.toLowerCase().includes(q) ||
  v.token.toLowerCase().includes(q);

/// Where a hit goes: the launch's own page, token/0x…, with the bar's rpc/lens
/// pair. app.html (in its token view) finds the launch's factory from the lens's
/// registry when a link names none.
const hrefFor = (token) => (bar() ? bar().withConfig("token/" + token) : "token/" + token);

function hitRow(v, i) {
  const a = el("a", i === view.sel ? "cbHit sel" : "cbHit");
  a.href = hrefFor(v.token);
  a.dataset.token = v.token;
  const av = el("div", "cbAv", (v.sym || v.token.slice(2, 4)).slice(0, 2).toUpperCase());
  // THE PICTURE OVER THE LETTERS, which it uncovers if it fails to load.
  if (v.image) {
    const img = document.createElement("img");
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    img.addEventListener("error", () => img.remove());
    img.src = v.image;
    av.append(img);
  }
  const names = el("div", "cbNames");
  names.append(el("div", "cbSym", v.sym || (v.labelled ? v.token.slice(0, 10) + "…" : "…")));
  if (v.name) names.append(el("div", "cbWho", v.name));
  const addr = el("div", "cbAddr", v.token.slice(0, 10) + "…" + v.token.slice(-8));
  addr.title = v.token;
  names.append(addr);
  const right = el("div", "cbRight");
  if (v.status === 1 || v.status === 2) right.append(el("div", "cbPct", progressOf(v).toFixed(1) + "%"));
  const tag = el("span", v.status === 2 ? "cbTag waiting" : v.status === 3 ? "cbTag graduated" : "cbTag",
    v.status === 2 ? "waiting" : v.status === 3 ? "graduated" : "selling");
  right.append(tag);
  a.append(av, names, right);
  a.addEventListener("mouseenter", () => { view.sel = i; markSel(); });
  return a;
}

function note(text) { return el("div", "cbSempty", text); }

/// @param why  LABELS when the only news is labels arriving (labelAll's flush);
///             anything else - a keystroke, opening, a new index - redraws in
///             the index's own order.
function render(why) {
  if (!overlay || !view.open) return;
  // NOT UNDER THE POINTER: a label redraw waits until it leaves the list.
  if (why === LABELS && results.matches(":hover")) { view.heldLabels = true; return; }
  view.heldLabels = false;
  const q = (input.value || "").trim().toLowerCase();
  results.replaceChildren();
  view.hits = [];
  if (index.state === "noregistry") {
    results.append(note("No registry is configured on this page, so there is nothing to search yet. Open it " +
      "from the Launches page, or from any link that carries ?rpc= and ?lens=."));
    scope.textContent = "";
    view.q = null; view.order = [];
    return;
  }
  if (index.state === "error") {
    results.append(note("The launches could not be read: " + index.error + ". Close this and try again."));
    scope.textContent = "";
    view.q = null; view.order = [];
    return;
  }
  let rows = index.rows.filter((v) => matches(v, q));
  // THE SAME QUERY WITH MORE LABELS KEEPS ITS ROWS WHERE THEY WERE, and a row
  // a new label made match goes below them. (A label only ever adds a match:
  // a row matched by its address still matches once its symbol is read.)
  if (why === LABELS && view.q === q) {
    const drawn = new Set(view.order);
    const byToken = new Map(rows.map((v) => [v.token, v]));
    rows = view.order.filter((t) => byToken.has(t)).map((t) => byToken.get(t))
      .concat(rows.filter((v) => !drawn.has(v.token)));
  }
  view.q = q;
  view.order = rows.map((v) => v.token);
  // A FULL ADDRESS IS ALWAYS OFFERED, loaded or not: the index holds only the
  // newest launches, and an address is how a token is usually passed around -
  // EXCEPT ONE THE SITE NO LONGER SHOWS (the incident switches): left out of
  // the index, it is not offered back by its address either.
  const inc = incident();
  const typed = q && isAddr(q) && !rows.some((v) => v.token.toLowerCase() === q) &&
    !index.hidden.has(q) && !(inc && inc.launchNamed(q)) ? q : null;
  view.hits = rows.map((v) => hrefFor(v.token));
  if (typed) {
    const a = el("a", view.sel === rows.length ? "cbHit sel" : "cbHit");
    a.href = hrefFor(typed);
    a.dataset.token = typed;
    const names = el("div", "cbNames");
    names.append(el("div", "cbSym", "Open this address"), el("div", "cbAddr", typed));
    a.append(el("div", "cbAv", "0x"), names);
    view.hits.push(a.href);
    rows.forEach((v, i) => results.append(hitRow(v, i)));
    results.append(a);
  } else {
    rows.forEach((v, i) => results.append(hitRow(v, i)));
  }
  if (view.sel >= view.hits.length) view.sel = 0;
  if (!view.hits.length) {
    // "NO MATCH" ONLY ONCE EVERY NAME HAS BEEN READ. Until then a symbol typed
    // in the first seconds may belong to a row whose name is still on its way,
    // and saying no launch matches it would be saying something not yet known.
    const unread = index.rows.filter((v) => !v.labelled).length;
    results.append(note(index.state === "loading"
      ? "Reading the launches…"
      : !index.rows.length
        ? "There are no launches yet."
        : unread
          ? `Still reading names (${index.rows.length - unread} of ${index.rows.length} read), and none read so ` +
            `far matches “${q}”.`
          : `No launch matches “${q}”.`));
  }
  const searched = Math.max(index.read, index.rows.length);
  scope.textContent = index.state === "loading" && !searched
    ? "Reading…"
    : searched < index.total
      ? `Searches the newest ${searched} of ${index.total}`
      : `Searches all ${index.total}`;
}

/// Moving the highlight repaints two class attributes, not the whole list -
/// rebuilding it under the pointer is how a click lands on the wrong row.
function markSel() {
  const kids = results.querySelectorAll(".cbHit");
  kids.forEach((k, i) => k.classList.toggle("sel", i === view.sel));
  const on = kids[view.sel];
  if (on && on.scrollIntoView) on.scrollIntoView({ block: "nearest" });
}

function onKey(e) {
  if (!view.open) return;
  if (e.key === "Escape") { e.preventDefault(); close(); return; }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!view.hits.length) return;
    view.sel = (view.sel + (e.key === "ArrowDown" ? 1 : -1) + view.hits.length) % view.hits.length;
    markSel();
    return;
  }
  if (e.key === "Enter" && view.hits.length) {
    e.preventDefault();
    location.href = view.hits[view.sel];
  }
}

function open() {
  if (!overlay) { build(); document.addEventListener("keydown", onKey); }
  view.open = true;
  view.sel = 0;
  overlay.hidden = false;
  render();
  input.focus();
  input.select();
  load();
}
function close() {
  view.open = false;
  if (overlay) overlay.hidden = true;
}
function toggle() { view.open ? close() : open(); }

window.CurbSearch = {
  open, close, toggle,
  // So a test can hand the decoder pages of every record length.
  decodeLaunchPage,
  get state() {
    return {
      open: view.open,
      index: { ...index, rows: index.rows.length, labelled: index.rows.filter((v) => v.labelled).length },
    };
  },
};

})();
