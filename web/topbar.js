// THE SITE'S ONE TOP BAR: the same links, the same Connect button and the same
// account on every page.
//
// Each page used to carry its own copy of the bar, and only the launches page
// had a Connect button in it - so the account seemed to vanish every time you
// changed page. This file draws the bar into <header id="siteBar"> and keeps the
// account across pages the only way a static site can: by ASKING the wallet on
// every load, silently. eth_accounts answers without a prompt for a site the
// wallet has already allowed, and with nothing for one it has not. Nothing here
// ever calls eth_requestAccounts except a click.
//
// Loaded synchronously, straight after the <header>, before any page script:
// app.js, launch.js, browse.js, docs.js and search.js read window.CurbBar, so it
// has to exist before they run. The bar wires its own search button and Ctrl K
// (see "search" below); no page script binds either. It is NOT loaded by
// tests.html or wallet-setup.html.
//
// web/config.js COMES FIRST on every page: it names the deployment a visit
// with no link reads (window.CURB_SITE), and the incident switches the bar
// applies for every page (see "the incident switches" below).
(function () {
"use strict";

const host = document.getElementById("siteBar");
if (!host) return;

// THE BAR'S OWN STORE, holding one thing: whether the person chose Disconnect.
// A new key - curb.app.v1 and curb.launch.* belong to the pages.
const STORE = "curb.site.v1";
const APP_STORE = "curb.app.v1";          // read only - see config below

const isAddr = (s) => /^0x[0-9a-fA-F]{40}$/.test(String(s || "").trim());
const isRpc = (s) => /^https?:\/\/[^\s"'<>]{1,200}$/i.test(String(s || "").trim());
const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
const lower = (s) => String(s || "").trim().toLowerCase();

// THE SITE'S OWN SETTINGS, from web/config.js, each checked as a stranger's
// value would be: the file is edited by hand on deploy day, and a typo must
// read as "not set", never as an endpoint or an address it is not. A page
// whose config.js did not load reads it as all unset.
const SITE = (() => {
  const s = window.CURB_SITE && typeof window.CURB_SITE === "object" ? window.CURB_SITE : {};
  const addrs = (list) => (Array.isArray(list) ? list : []).map(lower).filter(isAddr);
  const explorer = String(s.explorer || "").trim();
  return {
    chainId: Number.isSafeInteger(s.chainId) && s.chainId > 0 ? s.chainId : 8453,
    rpc: isRpc(s.rpc) ? String(s.rpc).trim() : "",
    lens: isAddr(s.lens) ? String(s.lens).trim() : "",
    registry: isAddr(s.registry) ? lower(s.registry) : "",
    factories: addrs(s.factories),
    explorer: /^https:\/\/[^\s"'<>]{1,200}$/i.test(explorer) ? explorer.replace(/\/+$/, "") : "https://basescan.org",
    featured: addrs(s.featured),
    banner: typeof s.banner === "string" ? s.banner.replace(/\s+/g, " ").trim().slice(0, 400) : "",
    hiddenFactories: addrs(s.hiddenFactories),
    hiddenLaunches: addrs(s.hiddenLaunches),
  };
})();
// THE BUILT-IN PAIR: config.js's endpoint and lens. With the endpoint unset
// (the file as committed, before deploy day) it is a local node, which is
// what the browser tests and a local session read; with the lens unset there
// is no registry, and the pages say so.
const DEFAULT_RPC = SITE.rpc || "http://127.0.0.1:8546";
const DEFAULT_LENS = SITE.lens;
/// THE ONE CHAIN A SEND MAY GO TO, ONCE config.js NAMES A DEPLOYMENT (its
/// lens): config.js's chainId, as hex. null while it names none - before deploy
/// day, a fork, a test node - when a page sends on the chain it reads.
///
/// ANY OTHER CHAIN IS REFUSED, NOT WARNED ABOUT. The CURB router is deployed
/// through the public deterministic proxy, so anyone can put the genuine code at
/// the genuine address on another chain where WETH sits at the same address -
/// and a link's endpoint for that chain, with a registry of its own behind the
/// genuine-looking factory, then takes a buyer's ETH after one network-switch
/// prompt. Holding the factory and registry to config.js happens only on the
/// chain config.js names, so every other chain is closed to sends instead.
const SEND_CHAIN = isAddr(DEFAULT_LENS) ? "0x" + SITE.chainId.toString(16) : null;
/// Two chain ids, as hex or numbers, are the same chain.
const sameChainId = (a, b) => { try { return BigInt(a) === BigInt(b); } catch { return false; } };
/// WHY NOTHING IS SENT FROM A WALLET ON `walletChain` (hex), or null. Once
/// config.js names a deployment, every chain but its own is refused (SEND_CHAIN).
function chainRefusal(walletChain) {
  if (!SEND_CHAIN || sameChainId(walletChain, SEND_CHAIN)) return null;
  let n = String(walletChain);
  try { n = BigInt(walletChain).toString(); } catch { /* said as given */ }
  return "Your wallet is on chain " + n + ", and this site's deployment is on " + chainName(SEND_CHAIN) +
    " (chain " + SITE.chainId + "). Nothing is sent on any other chain: a contract at the same address there is " +
    "not this site's, whatever a link's endpoint says.";
}
/// Whether an endpoint and a lens are exactly the built-in pair - which only a
/// config.js that names a lens has.
const isDefaultPair = (rpc, lens) =>
  isAddr(DEFAULT_LENS) && String(rpc || "").trim() === DEFAULT_RPC && lower(lens) === lower(DEFAULT_LENS);

function readJson(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || "null");
    return v && typeof v === "object" ? v : {};
  } catch { return {}; }
}
function writeSite(patch) {
  try { localStorage.setItem(STORE, JSON.stringify({ ...readJson(STORE), ...patch })); } catch { /* private mode */ }
}

// WHICH CHAIN AND WHICH REGISTRY THE SITE'S LINKS POINT AT: the link's own
// ?rpc= and ?lens= when it carries BOTH; no pair at all when it carries only
// one; else the pair saved on app.html, unless app.html marked it a link's;
// else the built-in pair from web/config.js (a local node and no registry
// until deploy day fills it in).
//
// NEVER WRITTEN FROM A LINK, HERE. A pair that arrived in a URL is carried on to
// the bar's links for this visit and forgotten after it: storing it would let
// one link a stranger sent point every later visit - and the create form's list
// of factories - at a registry of their choosing.
//
// THE SAVED PAIR IS app.html's (curb.app.v1), and app.html keeps a link's
// values out of it: saveCfg stores an endpoint or a lens only when the person
// set that field - typed into it - and a field still holding only what a link
// put there keeps the value saved before (app.js saveCfg, linkHeld; round 5,
// N13/N14). So the pair read here is one the person set on app.html. A record
// written before that rule may still carry an endpoint only a link brought,
// marked rpcFromLink; a pair so marked is NOT read here.
//
// ALWAYS AS A PAIR: app.html flags an rpc that arrives without a contract as a
// half link (app.js mixedEndpoint), so the bar never carries one alone. NOR
// DOES A HALF LINK FALL BACK TO THE SAVED PAIR: a link that names an rpc or a
// lens but not both - a URL cut at its "&" - named SOMEWHERE, and reading the
// saved registry instead would show that somewhere else without a word. The
// page gets no pair and is told it was a half link (halfLink; browse.js says
// so), and the bar's links go bare.
//
// fromLink: the pair is this URL's own, so the pages' own links carry it on
// (carryLinks); a saved pair needs no carrying - the next page reads it too.
//
// LAST, THE BUILT-IN PAIR (web/config.js). Once deploy day fills it in, a
// first visit with no link - curb.fun/, a token's page shared on X - reads the
// deployment with nothing to type.
//
// A LINK THAT ONLY RESTATES THE BUILT-IN PAIR IS NO LINK when a plain URL would
// read that same pair (nothing else saved): it is carried nowhere, so the
// site's links stay plain - no endpoint, and no key in one, copied into every
// shared URL, and nothing left pinned to an endpoint the site has since moved
// off. With another pair saved it is still a link: it names the built-in pair
// over the saved one, and the bar carries it as any link's.
const savedPair = (() => {
  const saved = readJson(APP_STORE);
  return saved.rpcFromLink !== true && isRpc(saved.rpc) && isAddr(saved.lens)
    ? { rpc: saved.rpc.trim(), lens: saved.lens.trim() } : null;
})();
/// What a URL with no ?rpc=&lens= reads on this browser: the saved pair, else the built-in one.
const barePair = savedPair || { rpc: DEFAULT_RPC, lens: DEFAULT_LENS };
const config = (() => {
  const q = new URLSearchParams(location.search);
  const rpc = (q.get("rpc") || "").trim();
  const lens = (q.get("lens") || "").trim();
  if (isRpc(rpc) && isAddr(lens)) {
    const plain = isDefaultPair(rpc, lens) && isDefaultPair(barePair.rpc, barePair.lens);
    return { rpc, lens, fromLink: !plain, halfLink: false };
  }
  if (rpc || lens) return { rpc: DEFAULT_RPC, lens: "", fromLink: false, halfLink: true };
  return { rpc: barePair.rpc, lens: barePair.lens, fromLink: false, halfLink: false };
})();

/// An internal link, with the pair appended when there is one to carry - never
/// the built-in pair where a plain URL reads it anyway (see config above).
function withConfig(href) {
  if (href.startsWith("#") || !isAddr(config.lens)) return href;
  if (isDefaultPair(config.rpc, config.lens) && isDefaultPair(barePair.rpc, barePair.lens)) return href;
  const hashAt = href.indexOf("#");
  const hash = hashAt >= 0 ? href.slice(hashAt) : "";
  const base = hashAt >= 0 ? href.slice(0, hashAt) : href;
  const qAt = base.indexOf("?");
  const path = qAt >= 0 ? base.slice(0, qAt) : base;
  const params = new URLSearchParams(qAt >= 0 ? base.slice(qAt + 1) : "");
  params.set("rpc", config.rpc);
  params.set("lens", config.lens);
  return path + "?" + params.toString() + hash;
}

// ---------------------------------------------------------------- drawing
// Built with createElement: the constant pieces (two icons) are the only
// markup written as strings, and every href is set as a property.
function el(tag, props, kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k === "html") e.innerHTML = v;          // constants only
    else if (k.startsWith("aria-") || k.startsWith("data-") || k === "role") e.setAttribute(k, v);
    else e[k] = v;
  }
  for (const kid of kids || []) e.append(kid);
  return e;
}

const MARK = '<svg viewBox="0 0 400 400" width="36" height="36" aria-hidden="true">' +
  '<g fill="none" stroke-linecap="butt" stroke-linejoin="miter" stroke-width="52">' +
  '<path d="M 90 260 H 200 V 148 H 300" stroke="currentColor"/>' +
  '<path d="M 174 148 H 300" stroke="#F5A524"/></g></svg>';
const X_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.9 2H22l-7.1 8.1L23.2 22h-6.6l-5.2-6.8L5.5 22H2.4l7.6-8.7L1.2 2h6.8l4.7 6.2L18.9 2Zm-1.1 18h1.7L7.3 3.8H5.5L17.8 20Z"/></svg>';
const SEARCH_ICON = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';

const PAGE = host.dataset.page || "";
// EVERY ENTRY CARRIES THE PAIR. $CURB and Docs used to go bare, so on those
// pages the bar fell back to the saved pair: browse (pair A) -> Docs ->
// Launches landed on whatever registry app.html had saved, with no notice, and
// search on Docs searched that one too (round 5, N45).
const NAV = [
  // [page, href, label] - the token first, then the launches (the owner's
  // order), then where holder sharing is seen - every distributor and what it
  // paid (sharing.html; the owner looked for it and found no way there) - then
  // the docs.
  ["curb", "curb.html", "$CURB"],
  ["browse", "browse.html", "Launches"],
  ["sharing", "sharing.html", "Holder fees"],
  ["docs", "docs.html", "Docs"],
];

const brand = el("a", { class: "cbBrand", href: withConfig("browse.html"), "aria-label": "Curb, all launches", html: MARK });
brand.append(el("span", { text: "Curb" }));

const nav = el("nav", { class: "cbNav", "aria-label": "Site" });
for (const [key, href, label] of NAV) {
  const a = el("a", { href: withConfig(href), text: label, "data-k": key });
  if (key === "curb") a.className = "cbTicker";
  if (key === PAGE) a.setAttribute("aria-current", "page");
  nav.append(a);
}

const actions = el("div", { class: "cbActions" });
// SEARCH ON EVERY PAGE. It was the launches page's own and searched only the
// cards that page had loaded; it is the bar's now (search.js), with its own read
// of the registry, so it works wherever the bar is.
const searchBtn = el("button", { class: "cbSearch", id: "barSearch", type: "button", "aria-label": "Search launches", html: SEARCH_ICON });
searchBtn.append(el("span", { class: "what", text: "Search" }), el("kbd", { text: "Ctrl K" }));
actions.append(searchBtn);
actions.append(el("a", { class: "cbIcon", href: "https://x.com/curbfun", target: "_blank", rel: "noreferrer noopener", "aria-label": "Curb on X", html: X_ICON }));
// ON app.html THE FORM IS ON THIS PAGE: an in-page jump, not a reload that
// would drop the link's factory and token. NOT ON A TOKEN'S PAGE (/token/0x…,
// the same file in its token view): the form is not shown there, and the
// page's base URL is the site's root, so "#create-launch" would leave for "/".
const TOKEN_VIEW = /\/token\/0x[0-9a-fA-F]{40}\/?$/.test(location.pathname);
const cta = el("a", { class: "cbCta", href: PAGE === "app" && !TOKEN_VIEW ? "#create-launch" : withConfig("app.html#create-launch") }, [
  el("span", { class: "cbLong", text: "+ Launch token" }),
  el("span", { class: "cbShort", text: "+ Launch" }),
]);
actions.append(cta);

// THE CONNECT BUTTON IS #barConnect, NEVER #connect. app.html and launch.html
// keep their own #connect inside <main> (their scripts bind it, and the tests
// click "#connect", which takes the FIRST match in the document - a bar button
// with that id would silently take every one of those clicks).
const btn = el("button", { id: "barConnect", type: "button", "aria-haspopup": "menu", "aria-expanded": "false", text: "Connect wallet" });
const who = el("div", { class: "cbWho" });
const copyBtn = el("button", { type: "button", role: "menuitem", text: "Copy address" });
const outBtn = el("button", { type: "button", role: "menuitem", class: "cbOut", text: "Disconnect" });
const menu = el("div", { class: "cbMenu", role: "menu", hidden: true }, [who, copyBtn, outBtn]);
const note = el("div", { class: "cbNote", role: "status", hidden: true });
actions.append(el("div", { class: "cbWallet" }, [btn, menu, note]));

host.textContent = "";
host.append(el("div", { class: "cbInner" }, [brand, nav, actions]));

// THE INCIDENT NOTICE (config.js banner): one line under the bar on every
// page, as text - it is typed into a file on the day something went wrong, and
// nothing in it is ever markup.
if (SITE.banner) host.append(el("div", { class: "cbBanner", id: "cbBanner", role: "status", text: SITE.banner }));

// THE ENDPOINT A PAGE READS, SAID WHENEVER IT IS NOT THE SITE'S OWN (config.js
// rpc). A link's ?rpc=, or a pair the person saved, decides every number a page
// shows, and an endpoint can answer anything it likes while the address bar
// still names this domain - so once config.js names the deployment, a page read
// through any other endpoint says so on one line under the bar, on every page,
// a token's own included (its settings panel is hidden). Nothing is said while
// config.js names no deployment: a local node is all there is then.
// app.js calls this again with the endpoint its form holds, which a half link
// can make differ from the bar's.
//
// AND SUCH A PAGE SENDS NOTHING (endpointRefusal; app.js beginAction, the
// Holder fees claim). What a send is built from - its minimum, its route, the
// contract it goes to - would be that endpoint's word, and checking each fact
// against the wallet's own network left the ones nobody listed (a quoter's
// fee tier, a price feed, a curve's reserves) to the endpoint. Reading stays
// open; a person who wants to send opens the page through the site's own.
const endpointLine = el("div", { class: "cbBanner", id: "cbEndpoint", role: "status", hidden: true });
host.append(endpointLine);
/// An endpoint as a person reads it: its host, without the path a key sits in.
function endpointHost(r) {
  try { return (new URL(r).host || r).slice(0, 80); } catch { return String(r).slice(0, 80); }
}
function endpointNotice(rpc) {
  const r = String(rpc || "").trim();
  const shown = !!(SITE.rpc && SITE.lens && r && r !== SITE.rpc);
  endpointLine.hidden = !shown;
  endpointLine.textContent = shown
    ? "This page reads the chain through " + endpointHost(r) + ", not through this site's own endpoint, so " +
      "everything it shows comes from there, and nothing is sent from it. Check where this link came from; to " +
      "send, open the page without the link's endpoint."
    : "";
}
/// WHY NOTHING IS SENT FROM A PAGE READ THROUGH `rpc`, or null. Once config.js
/// names a deployment (a lens), only its own endpoint: config.js's rpc, which
/// must be set (an empty one sends nothing at all).
function endpointRefusal(rpc) {
  if (!SEND_CHAIN) return null;
  const r = String(rpc || "").trim();
  if (SITE.rpc && r === SITE.rpc) return null;
  return "This page reads the chain through " + endpointHost(r) + ", not through this site's own endpoint, so " +
    "nothing is sent from it: the minimum, the route and the contract a send goes to would all be that " +
    "endpoint's word. Open the page without the link's endpoint (this site's own address alone) to send.";
}
endpointNotice(config.rpc);

// THE PAGES' OWN LINKS TO EACH OTHER CARRY THE PAIR TOO, where the page marks
// them with data-carry (curb.html's "See the launches", browse.html's launch
// button, terms.html's way back). Unmarked links are left as written: app.html's
// tests hold its terms link by its exact href. Rewritten once the body has been
// parsed, since this runs straight after the <header>.
//
// ONLY A PAIR THIS URL CARRIED. A saved pair is read by the next page anyway,
// and written onto a link to app.html it turns a plain visit into a link that
// "names a lens but no factory" - app.html then warns about the site's own
// link and drops the person's chosen factory (round 5, N51 describes it for
// the bar's + Launch token). So without a link's pair these stay as written.
function carryLinks() {
  if (!config.fromLink) return;
  for (const a of document.querySelectorAll("a[data-carry]")) {
    const href = a.getAttribute("href") || "";
    if (/^[a-z0-9-]+\.html(#[\w-]*)?$/i.test(href)) a.setAttribute("href", withConfig(href));
  }
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", carryLinks);
else carryLinks();

// ---------------------------------------------------------------- the account
let account = null;
let hidden = readJson(STORE).hidden === true;
const subs = new Set();

function paint() {
  btn.classList.toggle("on", !!account);
  btn.classList.toggle("nowallet", !account && !window.ethereum);
  btn.textContent = "";
  if (account) {
    btn.append(el("span", { class: "cbDot" }), el("span", { text: short(account) }));
    btn.title = account;
    btn.setAttribute("aria-label", "Wallet " + account + " - open menu");
    who.textContent = account;
  } else {
    btn.textContent = "Connect wallet";
    btn.title = window.ethereum ? "" : "No browser wallet found";
    btn.setAttribute("aria-label", "Connect wallet");
    closeMenu();
  }
}

function setAccount(next) {
  next = isAddr(next) ? String(next).toLowerCase() : null;
  const changed = next !== account;
  account = next;
  paint();
  if (!changed) return;
  for (const fn of subs) { try { fn(account); } catch (e) { console.error(e); } }
  document.dispatchEvent(new CustomEvent("curb:account", { detail: account }));
}

function unhide() {
  if (!hidden) return;
  hidden = false;
  writeSite({ hidden: false });
}

// ASKED, NEVER REQUESTED. eth_accounts is silent: it answers with the account
// only if this site was already allowed. After a Disconnect the bar does not
// ask at all until the person connects again.
async function detect() {
  const eth = window.ethereum;
  if (!eth || hidden) return;
  try {
    const a = await eth.request({ method: "eth_accounts" });
    if (!hidden) setAccount(a && a[0]);
  } catch { /* a wallet that will not say is a wallet not connected */ }
}

let listening = false;
function listen() {
  const eth = window.ethereum;
  if (!eth || listening) return;
  listening = true;
  // A REAL WALLET ANNOUNCES ITS OWN CHANGES - a switched account, or none after
  // it disconnected the site. After a Disconnect here they are ignored until
  // the person connects again.
  try { eth.on?.("accountsChanged", (a) => { if (!hidden) setAccount(a && a[0]); }); } catch { /* no events */ }
}

// A PAGE'S OWN CONNECT TELLS THE BAR. app.js and launch.js dispatch this after
// their #connect succeeds; a wallet is not obliged to emit accountsChanged for
// it, and the test wallet never does.
document.addEventListener("curb:page-account", (e) => {
  if (isAddr(e.detail)) unhide();
  setAccount(e.detail);
});

/// app.html's and launch.html's own Connect button, or null on every other page.
function ownConnect() { return document.querySelector("main #connect"); }

function showNote(text) {
  note.textContent = text;
  note.hidden = false;
  clearTimeout(showNote.t);
  showNote.t = setTimeout(() => { note.hidden = true; }, 7000);
}

async function connect() {
  if (account) return account;
  const eth = window.ethereum;
  if (!eth) {
    showNote("No browser wallet found. Install one - Coinbase Wallet, MetaMask or Rabby - and reload this page.");
    return null;
  }
  // THE PAGE'S OWN CONNECT, WHERE IT HAS ONE. app.html's runs through its
  // guard (which refuses while an action runs - nothing is queued) and
  // refreshes the page; launch.html's switches its reads to the wallet. Doing it
  // here as well would leave the page not knowing it was connected. A disabled
  // button means an action is running - both pages disable their #connect for
  // the length of one - and the click is simply not taken.
  const own = ownConnect();
  if (own) {
    if (!own.disabled) own.click();
    return null;
  }
  try {
    const a = await eth.request({ method: "eth_requestAccounts" });
    if (a && a[0]) unhide();
    setAccount(a && a[0]);
    return account;
  } catch (e) {
    if (!(e && e.code === 4001)) showNote("The wallet did not connect: " + ((e && e.message) || e));
    return null;
  }
}

// DISCONNECT, AS FAR AS A WEBSITE CAN. There is no standard call that makes a
// wallet forget a site; wallets that support wallet_revokePermissions are asked
// to, and the choice is remembered here so no page shows the account again until
// the person connects. app.html and launch.html hold their own copy of the
// account, so those two are reloaded - their silent detection honours the choice.
//
// NOT WHILE AN ACTION IS WAITING ON THE WALLET. A reload then cuts the page off
// between the wallet's dialog and the record of what it sent: a transaction
// confirmed after it has no pending record holding its hash, and the
// preparation claim it left makes the reloaded page say another tab is sending
// (round 5, N44). The page's own #connect is disabled for exactly that length
// (app.html's guard disables every button, the bar's included; launch.html
// disables its #connect while busy), so this refuses, as connect() does, and
// says so - nothing is changed and the person can disconnect once it is done.
async function disconnect() {
  const own = ownConnect();
  if (own && own.disabled) {
    showNote("An action on this page is waiting on the wallet. Disconnect once it has finished.");
    return;
  }
  hidden = true;
  writeSite({ hidden: true });
  try {
    await window.ethereum?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] });
  } catch { /* not supported: the local choice is what holds */ }
  setAccount(null);
  if (own) location.reload();
}

// A DISCONNECT OR A CONNECT IN ANOTHER TAB HOLDS HERE TOO. `hidden` was read
// once at load, so a tab already open kept showing - and app.html there kept
// sending from - the account the person had just disconnected in another tab,
// and a later connect here silently lifted that choice (round 5, N46). The
// storage event fires in every OTHER tab of this site when curb.site.v1
// changes (or when storage is cleared, key null).
//
// THIS TAB DID NOT CHOOSE IT, SO IT CANNOT REFUSE IT: a page whose action is
// waiting on the wallet is reloaded only once that action has settled - when
// its #connect is enabled again - never in the middle of it.
//
// A CONNECT ELSEWHERE IS ASKED ABOUT HERE ONLY WHERE THE BAR IS THE PAGE'S
// ONLY ACCOUNT. On app.html and launch.html the page holds its own copy, and a
// bar that picked the account up by itself would show one the page does not
// know it has - every action there saying "Connect a wallet first" under a
// bar that says connected. So on those two the bar stays as the page is,
// disconnected, until the person connects there (which no longer finds the
// choice standing) or the page loads again and detects both. No reload for
// it: a connect in another tab is no reason to throw away a form being filled.
function reloadPageWhenIdle() {
  const own = ownConnect();
  if (!own) return;
  if (!own.disabled) { location.reload(); return; }
  const watch = new MutationObserver(() => {
    if (own.disabled) return;
    watch.disconnect();
    location.reload();
  });
  watch.observe(own, { attributes: true, attributeFilter: ["disabled"] });
}
window.addEventListener("storage", (e) => {
  if (e.key !== STORE && e.key !== null) return;
  const now = readJson(STORE).hidden === true;
  if (now === hidden) return;
  hidden = now;
  if (hidden) {
    setAccount(null);
    reloadPageWhenIdle();
  } else if (!ownConnect()) {
    detect();
  }
});

function openMenu() { menu.hidden = false; btn.setAttribute("aria-expanded", "true"); }
function closeMenu() { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); }

btn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (account) { menu.hidden ? openMenu() : closeMenu(); return; }
  connect();
});
copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(account || "");
    copyBtn.textContent = "Copied";
  } catch { copyBtn.textContent = "Could not copy"; }
  setTimeout(() => { copyBtn.textContent = "Copy address"; }, 1400);
});
outBtn.addEventListener("click", () => { closeMenu(); disconnect(); });
document.addEventListener("click", (e) => {
  if (!menu.hidden && !menu.contains(e.target)) closeMenu();
  // A click in the menu is what showed the note (Disconnect refused), so it
  // must not be the click that hides it again on its way up to the document.
  if (!note.hidden && !note.contains(e.target) && e.target !== btn && !menu.contains(e.target)) note.hidden = true;
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeMenu(); note.hidden = true; } });

// ---------------------------------------------------------------- search
// FETCHED ON FIRST USE, with what it needs that the page has not loaded: a page
// that never searches makes no request for it and no read of the chain.
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("could not load " + src));
    document.head.append(s);
  });
}
let searchLoading = null;
function withSearch() {
  if (window.CurbSearch) return Promise.resolve(window.CurbSearch);
  if (!searchLoading) {
    searchLoading = (async () => {
      if (!window.CurbKeccak) await loadScript("keccak.js");
      if (!window.CurbMeta) await loadScript("token-meta.js");
      await loadScript("search.js");
      return window.CurbSearch;
    })();
    searchLoading.catch(() => { searchLoading = null; });
  }
  return searchLoading;
}
function openSearch(toggle) {
  withSearch().then((s) => (toggle ? s.toggle() : s.open()))
    .catch((e) => showNote("Search could not be opened: " + ((e && e.message) || e)));
}
searchBtn.addEventListener("click", () => openSearch(false));
// Ctrl K on Windows and Linux, Cmd K on a Mac - the bar's badge promises it.
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
    e.preventDefault();
    openSearch(true);
  }
});

// ---------------------------------------------------------------- notices
// WHAT AN ACTION SAID, AT THE TOP OF THE SCREEN, WHEREVER THE PAGE IS SCROLLED.
// app.html and launch.html write every result and refusal into their #msg,
// which sat at the top of the PAGE: press a button half-way down and the answer
// appeared out of sight. The line is lifted into a notice pinned under the bar
// (the owner's request), which fades on its own:
//   - a result ("ok") after 5 s, a refusal or failure ("err") after 8 s - they
//     stayed 8 s and 15 s, which the owner found too long;
//   - a "wait" line (a transaction still out, a record not yet settled) and
//     any line carrying a button or a [data-keep] link stay until closed or
//     replaced - they are something to act on, not news. A COPY BUTTON IS NOT
//     ONE OF THOSE: it is added to every address and hash (see below);
//   - a line with a [data-linger] link (somewhere to go) after 8 s.
// The mouse on a notice holds it, and the close button ends it.
// FADED, NEVER HIDDEN: the pages read #msg's `hidden` and class to tell what an
// action did (app.js guard()), so this only changes how it looks.
// ITS TEXT CAN BE SELECTED AND COPIED (the owner could not): the line takes the
// pointer, so a drag selects in it and a click in it closes nothing. Only the
// strip around it lets clicks through to the page under it.
const TOAST_MS = { ok: 5000, err: 8000 };
// A NOTICE WITH SOMEWHERE TO GO ([data-linger], "View token") stays a little
// longer, then fades too, and waits while the mouse is on it.
const LINGER_MS = 8000;
/// What makes a notice stay until closed: a button to act with, or a link
/// marked [data-keep] - never a copy button.
const KEEP_SEL = "button:not(.cbCopy), [data-keep]";
/// AN ADDRESS OR A TRANSACTION HASH, written as <code> in a notice, gets a copy
/// button after it (the owner's call). Whole <code> only: a hash cut short in
/// prose is not something to paste anywhere.
const COPYABLE = /^0x(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;
const COPY_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><rect x="5" y="5" width="8.5" height="8.5" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 3.2V2.8A1.3 1.3 0 0 0 9.2 1.5H3.3A1.3 1.3 0 0 0 2 2.8v5.9A1.3 1.3 0 0 0 3.3 10h.4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
function addCopyButtons(msg) {
  for (const code of msg.querySelectorAll("code")) {
    // A SHORTENED ADDRESS carries the whole one in data-copy (the launch notice).
    const text = (code.dataset.copy || code.textContent).trim();
    if (!COPYABLE.test(text)) continue;
    const next = code.nextElementSibling;
    if (next && next.classList.contains("cbCopy") && next.dataset.copy === text) continue;
    const b = el("button", { type: "button", class: "cbCopy", "data-copy": text, html: COPY_ICON,
      "aria-label": "Copy " + (text.length === 42 ? "address " : "transaction hash ") + text, title: "Copy" });
    code.after(b);
  }
}
/// The copy itself. The button's look changes by an attribute, never its text:
/// a page reads the notice's text, and a write to it restarts the clock.
async function copyFrom(b) {
  let ok = false;
  try { await navigator.clipboard.writeText(b.dataset.copy || ""); ok = true; } catch { ok = false; }
  b.setAttribute("data-copied", ok ? "yes" : "no");
  b.title = ok ? "Copied" : "Could not copy - select the text instead";
  clearTimeout(b._t);
  b._t = setTimeout(() => { b.removeAttribute("data-copied"); b.title = "Copy"; }, 1600);
}
const X_MARK = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
function toastify(msg) {
  const wrap = el("div", { id: "cbToast", class: "cbToast", role: "region", "aria-label": "Notices" });
  const x = el("button", { id: "cbToastX", type: "button", "aria-label": "Close the notice", html: X_MARK });
  // A LONG RESULT, SHORTENED. A swap's report runs to a dozen lines - what the
  // pool delivered, the tax, the fee, the exact figures - and filled the top of
  // the screen (the owner's complaint). A line with nothing to act on shows
  // three lines and keeps the rest one press away; a line with a button or a
  // link to follow is never shortened, so nothing to press is ever hidden.
  const more = el("button", { id: "cbToastMore", class: "cbToastMore", type: "button", text: "Details", hidden: true });
  msg.replaceWith(wrap);
  wrap.append(msg, x, more);
  let timer = null;
  let dismissed = false;
  const fade = () => { wrap.classList.add("cbToastOut"); };
  const clock = () => {
    clearTimeout(timer);
    const keep = msg.querySelector(KEEP_SEL);
    const linger = msg.querySelector("[data-linger]");
    const ms = keep ? 0 : linger ? LINGER_MS : TOAST_MS[msg.className.split(/\s+/).find((c) => c in TOAST_MS)] || 0;
    if (ms) timer = setTimeout(fade, ms);
  };
  const sync = () => {
    clearTimeout(timer);
    const shown = !msg.hidden && msg.textContent.trim() !== "";
    wrap.classList.toggle("cbToastEmpty", !shown);
    if (!shown) return;
    wrap.classList.remove("cbToastOut", "cbToastOpen");
    dismissed = false;
    addCopyButtons(msg);
    const keep = !!msg.querySelector(KEEP_SEL + ", [data-linger]");
    wrap.classList.toggle("cbToastClamp", !keep);
    more.textContent = "Details";
    // Measured once it is laid out: only a line that is actually cut gets the button.
    requestAnimationFrame(() => {
      const cut = wrap.classList.contains("cbToastClamp") && msg.scrollHeight > msg.clientHeight + 4;
      wrap.classList.toggle("cbToastCut", cut);
      more.hidden = !cut;
    });
    clock();
  };
  more.addEventListener("click", () => {
    const open = wrap.classList.toggle("cbToastOpen");
    more.textContent = open ? "Less" : "Details";
    // READING IS NOT IGNORING IT: open, it stays; closed again, it fades later.
    if (open) clearTimeout(timer); else clock();
  });
  new MutationObserver((records) => {
    // A WRITE TO THE LINE, not a button inside it being disabled while an
    // action runs - that would restart the clock on every action.
    if (records.some((r) => r.type !== "attributes" || r.target === msg)) sync();
  }).observe(msg, { childList: true, subtree: true, characterData: true, attributes: true });
  x.addEventListener("click", () => { dismissed = true; clearTimeout(timer); fade(); });
  msg.addEventListener("click", (e) => {
    const b = e.target && e.target.closest && e.target.closest("button.cbCopy");
    if (b && msg.contains(b)) { e.preventDefault(); copyFrom(b); }
  });
  // THE MOUSE ON IT HOLDS IT - reading it, selecting in it, or on something to
  // press; leaving starts the clock again.
  wrap.addEventListener("mouseenter", () => { if (!wrap.classList.contains("cbToastOut")) clearTimeout(timer); });
  wrap.addEventListener("mouseleave", () => {
    if (!dismissed && !wrap.classList.contains("cbToastOut") && !wrap.classList.contains("cbToastOpen")) clock();
  });
  sync();
  return { wrap, isDismissed: () => dismissed };
}
// AFTER THE PAGE IS PARSED: this script runs right after the bar's <header>,
// before <main> exists.
function setupNotices() {
  const pageMsg = (PAGE === "app" || PAGE === "launch") ? document.querySelector("main #msg") : null;
  if (pageMsg) toastify(pageMsg);
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setupNotices, { once: true });
else setupNotices();

// ---------------------------------------------------------------- the incident switches
// WHAT THE SITE NO LONGER SHOWS (config.js hiddenFactories, hiddenLaunches).
// Nothing on chain can stop a factory or a launch - launching is
// permissionless and a graduated pool is anybody's - so the halt PRE_MAINNET
// D4 names is the front end's: leave it out of every list, and say so on its
// own page. Every page asks here, so no two lists can disagree:
//   app.js     the create form's asset choices (factoryHidden)
//   browse.js  the grid and the hero (launchHidden)
//   search.js  the search (launchHidden)
//   token.js   the notice on a hidden launch's own page (launchHidden)
const hiddenFactories = new Set(SITE.hiddenFactories);
const hiddenLaunches = new Set(SITE.hiddenLaunches);

let callSeq = 0;
/// One eth_call. A NODE'S ERROR (a revert, no such function) is an answer and
/// comes back as "0x"; an endpoint that did not answer throws.
async function ethCall(rpc, to, data) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++callSeq, method: "eth_call", params: [{ to, data }, "latest"] }),
  });
  if (!res.ok) throw new Error("the endpoint answered HTTP " + res.status);
  const body = await res.json();
  if (body && body.error) return "0x";
  if (!body || typeof body.result !== "string") throw new Error("the endpoint answered with no result");
  return body.result;
}
/// feeEscrow()'s selector, from its signature (keccak.js - loaded by every
/// page that asks, and fetched here if not).
let escrowSel = null;
async function feeEscrowSel() {
  if (!escrowSel) {
    if (!window.CurbKeccak) await loadScript("keccak.js");
    const hex = Array.from(new TextEncoder().encode("feeEscrow()"), (b) => b.toString(16).padStart(2, "0")).join("");
    escrowSel = window.CurbKeccak.keccak256("0x" + hex).slice(0, 10);
  }
  return escrowSel;
}
/// The fee escrow a contract names, lowercased; "" for one that names none.
async function escrowOf(rpc, address) {
  const raw = String(await ethCall(rpc, address, await feeEscrowSel())).replace(/^0x/, "");
  if (raw.length < 64) return "";
  const a = "0x" + raw.slice(24, 64).toLowerCase();
  return /^0x0{40}$/.test(a) ? "" : a;
}
/// KEPT ONCE ANSWERED, never once failed: the next read asks again.
const escrowMemo = new Map();
function escrowMemoised(rpc, address) {
  const key = rpc + "|" + lower(address);
  let p = escrowMemo.get(key);
  if (!p) {
    p = escrowOf(rpc, address);
    escrowMemo.set(key, p);
    p.catch(() => escrowMemo.delete(key));
  }
  return p;
}

/// WHETHER A LAUNCH IS OFF THE SITE'S LISTS: its token is in hiddenLaunches,
/// or a factory in hiddenFactories made it. A launch's record names no factory
/// (its curve's factory() is the graduator), so the second is read from the
/// chain: the fee escrow the launch's curve pays into, against the escrows of
/// the hidden factories - every factory has an escrow of its own, which is how
/// app.js launchFactoryOf tells a launch's factory too. Read only while a
/// factory is hidden.
///
/// A LAUNCH WHOSE MAKER CANNOT BE TOLD WHILE A FACTORY IS HIDDEN IS LEFT OUT.
/// The switch is pulled during an incident, and a read that failed is no
/// reason to show what it was pulled for; nothing failed is kept, so the next
/// load asks again. A hidden "factory" that names no escrow (a mistyped
/// address) hides nothing.
/// @param launch  { token, curve }
/// @return "hidden", "shown", or "unknown" when the read failed
async function launchStatus(rpc, launch) {
  if (!launch || hiddenLaunches.has(lower(launch.token))) return "hidden";
  if (!hiddenFactories.size) return "shown";
  if (!isRpc(rpc) || !isAddr(launch.curve)) return "unknown";
  try {
    const [hidden, mine] = await Promise.all([
      Promise.all([...hiddenFactories].map((f) => escrowMemoised(rpc, f))),
      escrowMemoised(rpc, launch.curve),
    ]);
    return mine !== "" && hidden.includes(mine) ? "hidden" : "shown";
  } catch { return "unknown"; }
}
/// For a list: anything but "shown" is left out (see above).
const launchHidden = async (rpc, launch) => (await launchStatus(rpc, launch)) !== "shown";
const incident = Object.freeze({
  banner: SITE.banner,
  /// Whether anything at all is hidden - so a page with nothing hidden reads nothing more.
  any: () => hiddenFactories.size > 0 || hiddenLaunches.size > 0,
  factoryHidden: (factory) => hiddenFactories.has(lower(factory)),
  /// Named in hiddenLaunches: the part that needs no read.
  launchNamed: (token) => hiddenLaunches.has(lower(token)),
  launchHidden,
  /// For a launch's own page, which says it is hidden only once that is known.
  launchStatus,
});

// ---------------------------------------------------------------- the wallet's network
/// What a network is called when the wallet is asked to add it.
const chainName = (hex) => (hex === "0x2105" ? "Base" : "CURB fork " + parseInt(hex, 16));
/// THE WALLET, MOVED TO A NETWORK - when the person presses for it, never by
/// itself: app.html's switch button (app.js switchWalletTo) and the Holder
/// fees page's. A network the wallet does not know (EIP-3085 error 4902) is
/// offered to it to add: Base with its public endpoint and the site's explorer,
/// anything else (a local fork) with the endpoint the page reads. The wallet
/// shows the person both requests; nothing here decides for them.
///
/// ONCE config.js NAMES A DEPLOYMENT, ONLY TO ITS CHAIN (SEND_CHAIN), and a
/// chain the wallet does not know is added with config.js's own endpoint or
/// Base's public one - never with a link's: a link could otherwise have the
/// wallet itself read the chain through the endpoint that link chose.
/// @param hex        the chain id, as 0x-prefixed hex
/// @param rpcForAdd  the endpoint a network other than Base is added with
///                   while config.js names no deployment (default: the one the
///                   bar's links point at)
async function switchChain(hex, rpcForAdd) {
  const eth = window.ethereum;
  if (!eth) throw new Error("No injected wallet.");
  hex = String(hex || "").toLowerCase();
  if (!/^0x[0-9a-f]{1,16}$/.test(hex)) throw new Error("Not a chain id: " + hex);
  if (SEND_CHAIN && !sameChainId(hex, SEND_CHAIN)) {
    throw new Error("This site sends only on " + chainName(SEND_CHAIN) + " (chain " + SITE.chainId + "), so it does " +
      "not move your wallet to chain " + parseInt(hex, 16) + ".");
  }
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e) {
    const unknown = e && (e.code === 4902 || (e.data && e.data.originalError && e.data.originalError.code === 4902));
    if (!unknown) throw e;
    const base = hex === "0x2105";
    const addWith = base ? "https://mainnet.base.org" : SEND_CHAIN ? SITE.rpc : (rpcForAdd || config.rpc);
    if (!addWith) throw new Error("Your wallet does not know chain " + parseInt(hex, 16) + ", and this site names no endpoint to add it with. Add it in the wallet itself.");
    await eth.request({ method: "wallet_addEthereumChain", params: [{
      chainId: hex,
      chainName: chainName(hex),
      rpcUrls: [addWith],
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      ...(base ? { blockExplorerUrls: [SITE.explorer] } : {}),
    }] });
  }
}

paint();
listen();
const ready = detect();
// SOME WALLETS INJECT LATE, after the page's scripts have run, and announce it.
if (!window.ethereum) {
  window.addEventListener("ethereum#initialized", () => { paint(); listen(); detect(); }, { once: true });
}

window.CurbBar = {
  account: () => account,
  onAccount(fn) {
    subs.add(fn);
    try { fn(account); } catch (e) { console.error(e); }
    return () => subs.delete(fn);
  },
  connect,
  /// The pair the site's links point at, and whether this URL was a half link
  /// (see config above) - which is why there is no pair, for a page to say.
  config: () => ({ rpc: config.rpc, lens: config.lens, halfLink: config.halfLink }),
  withConfig,
  /// web/config.js as read (see SITE above), with the built-in pair a visit
  /// with no link and nothing saved reads.
  site: () => ({ ...SITE, factories: SITE.factories.slice(), hiddenFactories: SITE.hiddenFactories.slice(),
    hiddenLaunches: SITE.hiddenLaunches.slice(), featured: SITE.featured.slice(),
    defaultRpc: DEFAULT_RPC, defaultLens: DEFAULT_LENS }),
  /// The line under the bar about the endpoint a page reads (see endpointNotice).
  endpointNotice,
  /// What the site no longer shows (see "the incident switches" above).
  incident,
  /// The wallet, moved to a network on the person's press (see switchChain above).
  switchChain,
  /// The one chain a send may go to once config.js names a deployment, as hex,
  /// or null (SEND_CHAIN); and why a wallet on a given chain sends nothing.
  sendChain: () => SEND_CHAIN,
  chainRefusal,
  /// WHY NOTHING IS SENT FROM A PAGE READ THROUGH `rpc`, or null: once
  /// config.js names a deployment, only a page read through its own endpoint
  /// sends (see endpointNotice).
  endpointRefusal: (rpc) => endpointRefusal(rpc),
  isHidden: () => hidden,
  /// Settles once the load-time check has answered, so a page can wait for it
  /// instead of drawing "not connected" for a moment first.
  ready,
};

})();
