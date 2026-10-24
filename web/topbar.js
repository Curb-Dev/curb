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

// THE BAR'S OWN STORE, holding two things: whether the person chose Disconnect
// (`hidden`), and which wallet they connected with (`wallet`: "6963:<rdns>",
// "legacy" or "walletconnect" - see "the wallets" below). A new key -
// curb.app.v1 and curb.launch.* belong to the pages.
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
    // The Reown project id: 32 hex characters, or "" (WalletConnect off).
    walletConnect: /^[0-9a-f]{32}$/i.test(String(s.walletConnectProjectId || "").trim())
      ? String(s.walletConnectProjectId).trim().toLowerCase() : "",
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
const TG_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.9 4.3 18.6 19.8c-.2 1.1-.9 1.4-1.8.9l-5-3.7-2.4 2.3c-.3.3-.5.5-1 .5l.4-5.1 9.2-8.3c.4-.4-.1-.6-.6-.2L5.9 13.3 1 11.8c-1.1-.3-1.1-1.1.2-1.6l19.2-7.4c.9-.3 1.7.2 1.5 1.5Z"/></svg>';
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
  // the docs. EACH BY ITS NAME, without .html (vercel.json, _redirects): the
  // address a person sees and shares.
  ["curb", "/curb", "$CURB"],
  ["browse", "/launches", "Launches"],
  ["sharing", "/sharing", "Holder fees"],
  ["docs", "/docs", "Docs"],
];

const brand = el("a", { class: "cbBrand", href: withConfig("/"), "aria-label": "Curb, all launches", html: MARK });
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
// THE COMMUNITY CHAT, beside X: listing sites check a project's socials from
// its own site, and $CURB's metadata was the only place it was named.
actions.append(el("a", { class: "cbIcon", href: "https://t.me/CurbCommunity", target: "_blank", rel: "noreferrer noopener", "aria-label": "Curb on Telegram", html: TG_ICON }));
// ON app.html THE FORM IS ON THIS PAGE: an in-page jump, not a reload that
// would drop the link's factory and token. NOT ON A TOKEN'S PAGE (/token/0x…,
// the same file in its token view): the form is not shown there, and the
// page's base URL is the site's root, so "#create-launch" would leave for "/".
// Anywhere else it is /launchpad, which opens app.html at the form.
const TOKEN_VIEW = /\/token\/0x[0-9a-fA-F]{40}\/?$/.test(location.pathname);
const cta = el("a", { class: "cbCta", href: PAGE === "app" && !TOKEN_VIEW ? "#create-launch" : withConfig("/launchpad") }, [
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
// THE WALLET PICKER, where the menu sits (see "the picker" below).
const pickBox = el("div", { class: "cbPick", role: "dialog", "aria-label": "Choose a wallet", hidden: true });
actions.append(el("div", { class: "cbWallet" }, [btn, menu, pickBox, note]));

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
/// A PAGE OF THIS SITE: by its file (docs.html), or by its name (/docs, and /
/// for the launches), with an anchor or not.
const PAGE_LINK = /^(?:[a-z0-9-]+\.html|\/(?:launchpad|launches|curb|docs|migrate|terms|sharing)?)(#[\w-]*)?$/i;
function carryLinks() {
  if (!config.fromLink) return;
  for (const a of document.querySelectorAll("a[data-carry]")) {
    const href = a.getAttribute("href") || "";
    if (PAGE_LINK.test(href)) a.setAttribute("href", withConfig(href));
  }
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", carryLinks);
else carryLinks();

// ---------------------------------------------------------------- the wallets
// WHICH WALLET THE SITE TALKS TO.
//
// window.ethereum is whichever extension wrote it last, so a person with two
// wallets was connected through one they never chose. Wallets announce
// themselves now (EIP-6963): each answers "eip6963:requestProvider" with its
// own provider, a name, an icon and a reverse-DNS id. The bar keeps the ones
// it LISTS (below), the person picks one, and from then on THAT provider is the
// only one asked - by the bar, and by every page through CurbBar.wallet()
// (app.js, launch.js and sharing-page.js send through nothing else). A browser
// whose wallet announces nothing still has window.ethereum, as the one choice
// "Browser wallet" - which is every browser test that announces nothing.
// INSIDE COINBASE WALLET'S OWN BROWSER its wallet is "Coinbase Wallet" whatever
// it announces, or with nothing, and no phone wallet is offered (IN_APP below).
//
// EVERY ANNOUNCEMENT IS A STRANGER'S. Any extension can announce, under any
// name, id and picture. Only a LISTED id is drawn, and under the name LISTED
// gives it - never the name announced - so a stranger passes only for the
// wallet whose id it copies; two wallets with one id are both drawn, the
// picker says so, and a remembered id that two announce is chosen for neither.
// The icon is drawn only as an <img> from a data:image URI, so drawing it
// fetches nothing.
//
// REMEMBERED BY ID, NEVER BY NAME OR uuid (a uuid changes on every load):
// `wallet` in the bar's store, written when the person connects and erased by
// Disconnect. At load, prompting nothing:
//   - after a Disconnect, no wallet is chosen;
//   - a remembered id announced exactly once is chosen - late too, once it
//     arrives; announced twice, neither is, and the picker says why;
//   - a remembered WalletConnect session is restored (walletconnect.js);
//   - with nothing remembered and exactly one wallet in all (one injected
//     wallet, WalletConnect off), that one - as before there was a choice;
//   - otherwise none, until the person picks.
const MAX_WALLETS = 16;
const ICON_MAX = 128 * 1024;
const ICON_URI = /^data:image\/(svg\+xml|png|jpeg|gif|webp)[;,]/i;
const UUID = /^[0-9a-f-]{36}$/i;
const RDNS = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
/// THE BROWSER WALLETS LISTED, by the id each announces, with the name drawn for
/// it: wallets made for Ethereum's chains first, that work on Base (the ids as
/// WalletConnect's wallet registry gives them). A wallet made for another chain
/// first - Solana's, Cosmos's, Tron's - is not listed even where it can reach
/// Base, and window.ethereum is not offered in its place; one on a phone still
/// connects through WalletConnect.
const LISTED = new Map([
  ["io.metamask", "MetaMask"],
  ["io.rabby", "Rabby Wallet"],
  ["com.coinbase.wallet", "Coinbase Wallet"],
  ["com.trustwallet.app", "Trust Wallet"],
  ["com.okex.wallet", "OKX Wallet"],
  ["me.rainbow", "Rainbow"],
  ["io.zerion.wallet", "Zerion"],
  ["com.brave.wallet", "Brave Wallet"],
]);
/// COINBASE WALLET'S OWN BROWSER (the "Base App" until September 2026): the
/// site opened inside the app - go.base.app/app?url= - where the app's wallet,
/// an ERC-4337 smart wallet, is window.ethereum, and since April 2026 has
/// already allowed the site. Coinbase's own SDKs know it by two signs
/// (coinbase-wallet-sdk isCoinbaseWalletHost and getInjectedProvider,
/// base/account-sdk getInjectedProvider): the app's browser puts
/// "CoinbaseWalletRN/" in its user agent, and its provider carries
/// isCoinbaseBrowser: true. Whether it announces itself (EIP-6963), and under
/// which id, neither SDK nor Coinbase's docs say.
///
/// BOTH SIGNS, AND THE USER AGENT ABOVE ALL. Inside the app its wallet is drawn
/// as Coinbase Wallet whatever id it announces, or with none - so a desktop
/// extension that could pass for it would be drawn under that name. A flag on
/// a provider is what any extension can set (wallets copy each other's flags to
/// pass compatibility checks), and the SDK itself calls these signs "routing
/// hints", not a trust boundary. The user agent is the app's browser's own:
/// sent with every request, set by no wallet, and an extension rewriting it in
/// the page would be doing far more than setting a flag. A desktop browser with
/// the flag alone is read as it always was. An older build of the app, which
/// sends no such user agent, is too: its wallet is still offered when it
/// announces Coinbase Wallet's id, or announces nothing ("Browser wallet").
const IN_APP = /CoinbaseWalletRN\//.test(String((typeof navigator !== "undefined" && navigator.userAgent) || ""));
/// The id the app's wallet is filed under: Coinbase Wallet's, as LISTED names it.
const HOST_ID = "com.coinbase.wallet";
/// WALLETCONNECT IS OFFERED ONLY WITH A PROJECT ID, A DEPLOYMENT AND THE SITE'S
/// OWN ENDPOINT: its session's one chain is config.js's, and every read it
/// answers goes to config.js's rpc (walletconnect.js). AND NEVER INSIDE
/// COINBASE WALLET'S OWN BROWSER (IN_APP): the wallet is right there, and a
/// phone wallet would be another app on the same phone.
const WC_ON = !!(SITE.walletConnect && SEND_CHAIN && SITE.rpc) && !IN_APP;

/// A provider worth keeping: an object with a request function, and never a
/// DOM node - an element with id "ethereum" IS window.ethereum on a browser
/// with no wallet (docs.js keeps its headings off that id for this reason).
const isProvider = (p) => !!p && typeof p === "object" && typeof p.request === "function" &&
  !(typeof Node === "function" && p instanceof Node);
/// WHETHER A PROVIDER IS THE APP'S OWN WALLET: inside Coinbase Wallet's browser
/// (IN_APP), where no extension runs, the one that says so. Never anywhere else.
function isHost(p) {
  if (!IN_APP || !isProvider(p)) return false;
  try { return p.isCoinbaseBrowser === true; } catch { return false; }
}
/// A stored choice, checked as a stranger's value would be: "" for anything else.
function walletKey(v) {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (s === "legacy" || s === "walletconnect") return s;
  return s.startsWith("6963:") && LISTED.has(s.slice(5)) ? s : "";
}

const announced = [];          // { kind, key, uuid, rdns, name, icon, provider }, in order of arrival
let unlisted = false;          // a wallet announced that LISTED does not name
let legacy = null;             // window.ethereum, as the choice "Browser wallet"
let chosen = null;             // the wallet every page asks, or null
let clash = "";                // a remembered id that two wallets announced
let remembered = walletKey(readJson(STORE).wallet);
let settledYet = false;
let settleNow = () => {};
/// THE LOAD'S CHOICE IS MADE ONCE DISCOVERY HAS SETTLED: as soon as the
/// remembered wallet announces, or a moment after the page is parsed, and never
/// later than a second in (see the startup at the end).
const settled = new Promise((resolve) => {
  settleNow = () => {
    if (settledYet) return;
    settledYet = true;
    const first = autoChoice();
    if (first) choose(first, false);
    resolve();
  };
});

/// window.ethereum as a choice, while no wallet announces itself.
function legacyChoice() {
  const eth = window.ethereum;
  if (!isProvider(eth)) return null;
  if (!legacy || legacy.provider !== eth) {
    legacy = { kind: "legacy", key: "legacy", uuid: "", rdns: "", name: "Browser wallet", icon: "", provider: eth };
  }
  return legacy;
}
/// The wallets there are to pick from: the announced ones, else window.ethereum.
/// The "Browser wallet" leaves the list once any wallet announces, listed or
/// not - it is one of them: listed, it must not be listed twice, and unlisted,
/// not at all - unless it is already this page's choice.
function choices() {
  const list = announced.length || unlisted ? announced.slice() : [legacyChoice()].filter(Boolean);
  if (chosen && chosen.kind === "legacy" && !list.includes(chosen)) list.unshift(chosen);
  return list;
}

function onAnnounce(e) {
  try {
    const d = e && e.detail;
    if (!d || typeof d !== "object") return;
    const info = d.info;
    const provider = d.provider;
    if (!info || typeof info !== "object" || !isProvider(provider)) return;
    // EACH FIELD READ ONCE: a getter may answer differently the second time.
    const uuid = info.uuid, rdns = info.rdns, icon = info.icon;
    if (typeof uuid !== "string" || !UUID.test(uuid)) return;
    if (typeof rdns !== "string" || rdns.length > 100 || !RDNS.test(rdns)) return;
    // THE APP'S OWN WALLET, inside its browser: Coinbase Wallet, whatever id it
    // announced, once - and never "unlisted" (see IN_APP). An announcement of
    // Coinbase Wallet's own id there is the app's too, whatever object it hands
    // over: no extension runs in the app's browser, and taken as a wallet of
    // its own it would be the app's wallet's twin.
    if (isHost(provider) || (rdns.toLowerCase() === HOST_ID && isHost(window.ethereum))) {
      adoptHost(provider, uuid.toLowerCase(), icon);
      return;
    }
    const id = rdns.toLowerCase(), name = LISTED.get(id);
    if (!name) { unlisted = true; return; }
    if (announced.length >= MAX_WALLETS) return;
    // THE FIRST WITH A uuid WINS: a repeat is the same wallet answering again, or an impostor.
    if (announced.some((w) => w.uuid === uuid.toLowerCase())) return;
    const entry = {
      kind: "injected", key: "6963:" + id, uuid: uuid.toLowerCase(), rdns: id, name,
      icon: typeof icon === "string" && icon.length <= ICON_MAX && ICON_URI.test(icon) ? icon : "",
      provider,
    };
    announced.push(entry);
    // window.ethereum, CHOSEN AS "Browser wallet", ANNOUNCING ITSELF: the same
    // provider with a name now, so its handlers stay where they are.
    if (chosen && chosen.kind === "legacy" && chosen.provider === provider) chosen = entry;
    arrived(entry);
  } catch { /* a malformed announcement is no wallet */ }
}

/// THE APP'S WALLET, INSIDE COINBASE WALLET'S BROWSER, IS ONE CHOICE: Coinbase
/// Wallet, under the id LISTED gives it, whether it announced itself - under
/// any id - or not (window.ethereum, looked at once the wallets were asked).
/// The first to arrive is it; a second announcement, or the look after it,
/// adds nothing. Its announcement's uuid and icon are kept when it made one.
/// @param provider  the announced provider - window.ethereum is asked instead
///                  when this one does not say it is the app's, or none was
function adoptHost(provider, uuid, icon) {
  const host = isHost(provider) ? provider : window.ethereum;
  if (!isHost(host) || announced.some((w) => w.host)) return;
  const entry = {
    kind: "injected", key: "6963:" + HOST_ID, uuid: uuid || "", rdns: HOST_ID, name: LISTED.get(HOST_ID),
    icon: typeof icon === "string" && icon.length <= ICON_MAX && ICON_URI.test(icon) ? icon : "",
    provider: host, host: true,
  };
  announced.push(entry);
  // window.ethereum, CHOSEN AS "Browser wallet" before it was seen to be the
  // app's: the same provider with its name now, so its handlers stay put.
  if (chosen && chosen.kind === "legacy" && chosen.provider === host) chosen = entry;
  arrived(entry);
}

/// A WALLET ARRIVED. The remembered one settles the load straight away - after
/// any other answer to the same request, so a twin is seen. Arriving after
/// the load settled, it is chosen then, as quietly as it would have been.
function arrived(entry) {
  if (entry.key === remembered) {
    if (!settledYet) setTimeout(settleNow, 0);
    else if (!chosen && !hidden && !pickerDone) {
      const same = announced.filter((w) => w.key === entry.key);
      if (same.length === 1) choose(entry, true);
      else clash = entry.rdns;
    }
  }
  paint();
  if (pickerDone && !wcRunning) drawPicker();
}

/// NOTHING THE GRACE CAN CHANGE: the load's choice is already what it will be.
/// The pages wait on `ready` before their first drawing (app.js, launch.js,
/// sharing-page.js), so a wait that cannot help is one every visitor pays: none
/// is chosen after a Disconnect; none with WalletConnect offered, or with two
/// wallets already here - the person picks then, whatever else announces; none
/// with no wallet at all, a phone opening a shared link - and one injected
/// later is taken up as it arrives (ethereum#initialized, see the startup).
/// Only a remembered wallet not yet announced, or a lone one a second may still
/// join, is worth the wait.
function nothingToWaitFor() {
  if (hidden) return true;
  if (remembered.startsWith("6963:")) return false;
  return WC_ON || choices().length !== 1;
}

/// The wallet chosen at load, prompting nothing (see above).
function autoChoice() {
  clash = "";
  if (hidden) return null;
  if (remembered.startsWith("6963:")) {
    const same = announced.filter((w) => w.key === remembered);
    if (same.length > 1) clash = same[0].rdns;
    return same.length === 1 ? same[0] : null;
  }
  if (remembered === "walletconnect" && WC_ON) {
    restoreWalletConnect();
    return null;
  }
  const list = choices();
  return list.length === 1 && !WC_ON ? list[0] : null;
}

function requestWallets() {
  try { window.dispatchEvent(new Event("eip6963:requestProvider")); } catch { /* nothing to ask */ }
}

// ---- the chosen wallet's events
// THE PAGES SUBSCRIBE HERE, NOT ON A PROVIDER (CurbBar.walletOn): one handler
// per event sits on the chosen provider and passes the event on, and it moves
// when the choice does. A change of wallet after load - a pick, a WalletConnect
// session restored late or ended - is said as "accountsChanged" with the new
// wallet's accounts (or none), so app.js and launch.js follow it through the
// handlers they already have.
const WALLET_EVENTS = ["accountsChanged", "chainChanged"];
const walletSubs = new Map(WALLET_EVENTS.map((ev) => [ev, new Set()]));
const forwarders = new Map(WALLET_EVENTS.map((ev) => [ev, (arg) => tellWallet(ev, arg)]));
function tellWallet(ev, arg) {
  for (const fn of walletSubs.get(ev) || []) { try { fn(arg); } catch (e) { console.error(e); } }
}
function walletOn(ev, fn) { if (walletSubs.has(ev) && typeof fn === "function") walletSubs.get(ev).add(fn); }
function walletOff(ev, fn) { if (walletSubs.has(ev)) walletSubs.get(ev).delete(fn); }

/// THE CHOICE, MOVED: the handlers leave the old provider and sit on the new.
/// @param tell  say it to the pages - a change after load
async function choose(entry, tell) {
  if (entry === chosen) return;
  const before = chosen;
  for (const [ev, fn] of forwarders) {
    try { if (before) before.provider.removeListener?.(ev, fn); } catch { /* no events */ }
    try { if (entry) entry.provider.on?.(ev, fn); } catch { /* no events */ }
  }
  chosen = entry;
  paint();
  if (!tell) return;
  let a = [];
  if (entry && !hidden) {
    try { a = await entry.provider.request({ method: "eth_accounts" }); } catch { a = []; }
  }
  if (chosen !== entry) return;
  a = Array.isArray(a) ? a : [];
  if (before || a.length) tellWallet("accountsChanged", a);
}

// ---------------------------------------------------------------- the account
let account = null;
let hidden = readJson(STORE).hidden === true;
const subs = new Set();

function paint() {
  const any = !!chosen || choices().length > 0 || WC_ON;
  btn.classList.toggle("on", !!account);
  btn.classList.toggle("nowallet", !account && !any);
  btn.textContent = "";
  if (account) {
    btn.append(el("span", { class: "cbDot" }), el("span", { text: short(account) }));
    btn.title = account;
    btn.setAttribute("aria-label", "Wallet " + account + " - open menu");
    who.textContent = account;
  } else {
    btn.textContent = "Connect wallet";
    btn.title = any ? "" : "No browser wallet found";
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

/// CONNECTED: a Disconnect is lifted, and the wallet it was made with is the
/// one the next visit chooses. Written once, together, so another tab hears
/// one change.
function connected() {
  const key = chosen ? chosen.key : "";
  if (!hidden && (!key || key === remembered)) return;
  hidden = false;
  if (key) remembered = key;
  writeSite(key ? { hidden: false, wallet: key } : { hidden: false });
}

// ASKED, NEVER REQUESTED. eth_accounts is silent: it answers with the account
// only if this site was already allowed. After a Disconnect the bar does not
// ask at all until the person connects again - and it asks the chosen wallet
// only, never one the person did not pick.
async function detect() {
  // WITH PHONE WALLETS ON, A LONE WALLET IS NOT CHOSEN AT LOAD (autoChoice), so
  // a Connect offers the phone wallet beside it - but one that already allowed
  // this site is asked silently here and taken, as it is with phone wallets
  // off: a returning visitor is not made to pick again, and the bar's network
  // switch has a wallet to ask. One that was not allowed stays unchosen.
  // (Nothing remembered, or this very wallet: a remembered one missing this
  // visit still means no wallet is asked anything.)
  if (!chosen && WC_ON && !hidden && !clash && remembered !== "walletconnect") {
    const list = choices();
    if (list.length === 1 && (!remembered || remembered === list[0].key)) {
      const lone = list[0];
      let a = [];
      try { a = await lone.provider.request({ method: "eth_accounts" }); } catch { a = []; }
      if (!hidden && !chosen && Array.isArray(a) && isAddr(a[0])) {
        await choose(lone, false);
        if (chosen === lone) setAccount(a[0]);
      }
      return;
    }
  }
  const w = chosen;
  if (!w || hidden) return;
  try {
    const a = await w.provider.request({ method: "eth_accounts" });
    if (!hidden && chosen === w) setAccount(a && a[0]);
  } catch { /* a wallet that will not say is a wallet not connected */ }
}

// A REAL WALLET ANNOUNCES ITS OWN CHANGES - a switched account, or none after
// it disconnected the site - through the chosen wallet's handler. After a
// Disconnect here they are ignored until the person connects again.
walletOn("accountsChanged", (a) => { if (!hidden) setAccount(a && a[0]); });

// A PAGE'S OWN CONNECT TELLS THE BAR. app.js and launch.js dispatch this after
// their #connect succeeds; a wallet is not obliged to emit accountsChanged for
// it, and the test wallet never does.
document.addEventListener("curb:page-account", (e) => {
  if (isAddr(e.detail)) connected();
  setAccount(e.detail);
});

/// app.html's and launch.html's own Connect button, or null on every other page.
function ownConnect() { return document.querySelector("main #connect"); }

/// A line under the Connect button. It fades after 7 s unless `keep`; `link`
/// ({ href, text }) is a link after it - only ever built on one of this site's
/// own constants (walletconnect.js's wallets), never on anything a wallet said.
function showNote(text, opts) {
  note.textContent = text;
  if (opts && opts.link) {
    // A NEW TAB, NEVER THIS ONE. The link is said while a page waits on the
    // wallet ("Confirm in <wallet>"), and a phone that does not hand it to the
    // app - an in-app browser, a universal link that does not cover the path -
    // would load the wallet's website here: the page waiting on the send is
    // gone, and with it the hash of a transaction the wallet can still sign.
    // The SDK's own opener does the same for an https link.
    note.append(" ", el("a", { href: opts.link.href, text: opts.link.text, target: "_blank", rel: "noreferrer noopener" }));
  }
  note.hidden = false;
  clearTimeout(showNote.t);
  if (!(opts && opts.keep)) showNote.t = setTimeout(() => { note.hidden = true; }, 7000);
}

/// THE WALLET TO CONNECT WITH: the chosen one; else the only one there is,
/// chosen now; else the person's pick in the picker - null when they close it,
/// or when there is no wallet at all (said under the button).
async function pick() {
  await settled;
  if (chosen) return chosen.provider;
  const list = choices();
  if (!list.length && !WC_ON) {
    showNote((unlisted ? "This browser's wallets are not ones the site lists." : "No browser wallet found.") +
      " Install one - Coinbase Wallet, MetaMask or Rabby - and reload this page.");
    return null;
  }
  if (list.length === 1 && !WC_ON && !clash) {
    await choose(list[0], true);
    return list[0].provider;
  }
  return openPicker(!list.length);
}

async function connect() {
  if (account) return account;
  // THE PAGE'S OWN CONNECT, WHERE IT HAS ONE. app.html's runs through its
  // guard (which refuses while an action runs - nothing is queued) and
  // refreshes the page; launch.html's switches its reads to the wallet. Doing it
  // here as well would leave the page not knowing it was connected. A disabled
  // button means an action is running - both pages disable their #connect for
  // the length of one - and the click is simply not taken: SO NO WALLET IS
  // PICKED OR SWAPPED UNDER AN ACTION WAITING ON ONE. Both pages ask which
  // wallet through CurbBar.pick, so the picker opens from there.
  const own = ownConnect();
  if (own) {
    if (!own.disabled) own.click();
    return null;
  }
  await settled;
  const eth = await pick();
  if (!eth) return null;
  try {
    const a = await eth.request({ method: "eth_requestAccounts" });
    // STILL THE WALLET CHOSEN: one chosen since - another wallet connected in
    // another tab - is not the one that answered, and the account it gave is
    // neither shown nor remembered as that wallet's.
    if (!chosen || chosen.provider !== eth) return null;
    if (a && a[0]) connected();
    setAccount(a && a[0]);
    return account;
  } catch (e) {
    declined(eth);
    if (!(e && e.code === 4001)) showNote("The wallet did not connect: " + ((e && e.message) || e));
    return null;
  }
}

/// A WALLET THAT DID NOT CONNECT IS LET GO OF where there is another to pick -
/// a second wallet, or WalletConnect - and is not remembered: the next Connect
/// opens the picker. Kept, it was where every later Connect went, and a
/// remembered wallet that is locked, or no longer allows this site, stood
/// between the person and every other one: the picker opens only while none is
/// chosen, and Disconnect only while one is connected. The only wallet there is
/// stays chosen - it is the one the next Connect would ask anyway.
/// app.html and launch.html call this too (CurbBar.declined), from their own Connect.
/// @param eth  the provider pick() gave, which did not connect
function declined(eth) {
  if (!chosen || chosen.provider !== eth) return;
  if (choices().length < 2 && !WC_ON) return;
  if (chosen.key === remembered) { remembered = ""; writeSite({ wallet: undefined }); }
  choose(null, false);
}

// DISCONNECT, AS FAR AS A WEBSITE CAN. There is no standard call that makes a
// wallet forget a site; wallets that support wallet_revokePermissions are asked
// to (a WalletConnect session is ended), and the choice is remembered here so no
// page shows the account again until the person connects. The wallet chosen is
// forgotten too: the next Connect asks which. app.html and launch.html hold
// their own copy of the account, so those two are reloaded - their silent
// detection honours the choice.
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
  remembered = "";
  writeSite({ hidden: true, wallet: undefined });
  const w = chosen;
  try {
    if (w) await w.provider.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] });
  } catch { /* not supported: the local choice is what holds */ }
  setAccount(null);
  choose(null, false);
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
//
// ANOTHER WALLET CONNECTED IN ANOTHER TAB holds here as a Disconnect would:
// the account goes, app.html and launch.html are reloaded once idle (a send
// already pinned keeps the provider it was pinned to - app.js beginAction),
// and a page whose only account is the bar's takes up the new wallet.
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
  const saved = readJson(STORE);
  const nowHidden = saved.hidden === true;
  const nowWallet = walletKey(saved.wallet);
  const swapped = !nowHidden && !!nowWallet && !!chosen && nowWallet !== chosen.key;
  remembered = nowWallet;
  if (nowHidden === hidden && !swapped) return;
  hidden = nowHidden;
  if (hidden || swapped) {
    setAccount(null);
    if (swapped) choose(null, false);
    if (ownConnect()) { reloadPageWhenIdle(); return; }
  }
  if (!hidden && !ownConnect()) {
    if (!chosen) { const c = autoChoice(); if (c) choose(c, false); }
    detect();
  }
});

function openMenu() { menu.hidden = false; btn.setAttribute("aria-expanded", "true"); }
function closeMenu() { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); }

btn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (account) { menu.hidden ? openMenu() : closeMenu(); return; }
  if (pickerDone) { closePicker(null); return; }
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
// THE PICKER CLOSES ON A PRESS OUTSIDE IT - a press, not a click: the click
// that opened it (main #connect's, on app.html) is still on its way up to the
// document when the picker appears.
document.addEventListener("pointerdown", (e) => {
  if (pickerDone && !pickBox.contains(e.target) && !btn.contains(e.target)) closePicker(null);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeMenu(); closePicker(null); note.hidden = true; }
});

// ---------------------------------------------------------------- the picker
// WHICH WALLET, ASKED ONCE, where the menu sits: each wallet a button with its
// icon, its name and its id, and WalletConnect's phone wallets last when it is
// on (config.js walletConnectProjectId). A pick is chosen and then the connect
// carries on as it did before there was a choice; it is remembered once the
// wallet has connected (connected() above) - a declined one is not.
// NEVER UNDER AN ACTION WAITING ON THE WALLET: the bar's Connect does not reach
// it then (connect() above), as Disconnect is refused.
let pickerDone = null;     // resolves the open picker's promise
let pickerOpen = null;     // that promise
let wcRunning = false;     // the WalletConnect panel is in the picker
const PHONE_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="6.5" y="2.5" width="11" height="19" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10.5 18.2h3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

/// @param phone  open on the WalletConnect panel: it is the only way there is
function openPicker(phone) {
  if (pickerOpen) return pickerOpen;
  closeMenu();
  note.hidden = true;
  pickerOpen = new Promise((resolve) => { pickerDone = resolve; });
  requestWallets();
  pickBox.hidden = false;
  btn.setAttribute("aria-expanded", "true");
  if (phone) startWalletConnect(); else drawPicker();
  const first = pickBox.querySelector("button");
  if (first) first.focus();
  return pickerOpen;
}
function closePicker(provider) {
  if (!pickerDone) return;
  const done = pickerDone;
  pickerDone = null;
  pickerOpen = null;
  if (wcRunning && window.CurbWalletConnect) window.CurbWalletConnect.abort();
  wcRunning = false;
  pickBox.hidden = true;
  pickBox.textContent = "";
  btn.setAttribute("aria-expanded", "false");
  done(provider || null);
}

/// A wallet's picture: its own data: icon (checked in onAnnounce), else its
/// first letter on a plain tile.
function walletIcon(w) {
  const tile = el("span", { class: "cbPickTile", "aria-hidden": "true", text: (Array.from(w.name)[0] || "?").toUpperCase() });
  if (!w.icon) return tile;
  const img = el("img", { width: 28, height: 28, alt: "", decoding: "async" });
  img.addEventListener("error", () => img.replaceWith(tile), { once: true });
  img.src = w.icon;
  return img;
}
function pickRow(icon, name, onPick) {
  const b = el("button", { type: "button", class: "cbPickRow" }, [icon, el("span", { class: "cbPickName", text: name })]);
  b.addEventListener("click", onPick);
  return b;
}
function drawPicker() {
  pickBox.textContent = "";
  pickBox.append(el("div", { class: "cbPickHead", text: "Choose a wallet" }));
  const list = choices();
  // TWO WALLETS WITH ONE ID ARE TWO ROWS WITH ONE NAME (names come from LISTED): said here.
  const twin = list.find((w, i) => list.findIndex((x) => x.key === w.key) !== i);
  if (twin) {
    pickBox.append(el("p", { class: "cbPickWarn", text: "Two wallets in this browser both say they are " + twin.name +
      ": one of them is not what it says, so neither is chosen for you. Pick the one you mean, or remove the " +
      "extension you do not know." }));
  }
  for (const w of list) pickBox.append(pickRow(walletIcon(w), w.name, () => picked(w)));
  if (WC_ON) {
    pickBox.append(pickRow(el("span", { class: "cbPickTile cbPickWc", html: PHONE_ICON }), "Phone wallet - WalletConnect",
      () => startWalletConnect()));
  }
}
async function picked(w) {
  if (!pickerDone) return;
  await choose(w, true);
  // A LATER PICK WON: another row was pressed while this wallet was still
  // answering (an extension waking can take a second), and the picker closes
  // with that one - the wallet the bar now names - not with this.
  if (chosen !== w) return;
  closePicker(w.provider);
}

// ---- WalletConnect (walletconnect.js, fetched on the pick)
// NOTHING OF IT IS FETCHED until the person picks "Phone wallet", or a session
// they connected is restored; without a project id it is never offered at all.
let wcLoading = null;
const wcHooks = {
  site: () => ({ chainId: SITE.chainId, rpc: SITE.rpc, projectId: SITE.walletConnect }),
  /// A line under the button: "open in another tab", "Confirm in <wallet>".
  say: (text, link) => showNote(text, { keep: true, link }),
  unsay: () => { clearTimeout(showNote.t); note.hidden = true; },
  /// The session ended (the phone disconnected it, or it expired): the
  /// accounts are already gone (accountsChanged []); the choice goes too.
  ended: (adapter) => {
    if (chosen && chosen.provider === adapter) choose(null, false);
    if (remembered === "walletconnect") { remembered = ""; writeSite({ wallet: undefined }); }
  },
};
function withWalletConnect() {
  if (window.CurbWalletConnect) return Promise.resolve(window.CurbWalletConnect);
  if (!wcLoading) {
    wcLoading = loadScript("walletconnect.js").then(() => {
      if (!window.CurbWalletConnect) throw new Error("walletconnect.js did not load");
      window.CurbWalletConnect.init(wcHooks);
      return window.CurbWalletConnect;
    });
    wcLoading.catch(() => { wcLoading = null; });
  }
  return wcLoading;
}
const wcEntry = (adapter) => ({ kind: "walletconnect", key: "walletconnect", uuid: "", rdns: "", name: "Phone wallet", icon: "", provider: adapter });
async function startWalletConnect() {
  if (!pickerDone || wcRunning) return;
  wcRunning = true;
  pickBox.textContent = "";
  const panel = el("div", { class: "cbWc" }, [el("p", { class: "cbWcStatus", role: "status", text: "Loading WalletConnect…" })]);
  pickBox.append(el("div", { class: "cbPickHead", text: "Phone wallet" }), panel);
  let adapter = null;
  try {
    const wc = await withWalletConnect();
    if (!wcRunning) return;
    adapter = await wc.connect(panel, {
      back: () => { if (!wcRunning) return; wcRunning = false; drawPicker(); const b = pickBox.querySelector("button"); if (b) b.focus(); },
      cancel: () => closePicker(null),
    });
  } catch (e) {
    if (!wcRunning) return;
    panel.textContent = "";
    panel.append(el("p", { class: "cbWcStatus", role: "status", text: "WalletConnect could not be opened: " + ((e && e.message) || e) }));
    const back = el("button", { type: "button", class: "cbWcBtn", text: "Back" });
    back.addEventListener("click", () => { wcRunning = false; drawPicker(); });
    panel.append(back);
    return;
  }
  if (!wcRunning || !adapter) return;
  wcRunning = false;
  await choose(wcEntry(adapter), true);
  closePicker(adapter);
}
/// A SESSION THE PERSON CONNECTED BEFORE, TAKEN UP AT LOAD (curb.site.v1 says
/// "walletconnect"). Once it is back the pages hear "accountsChanged", as for
/// any wallet chosen after load; none left to restore, the choice is forgotten.
async function restoreWalletConnect() {
  try {
    const wc = await withWalletConnect();
    const adapter = await wc.restore();
    if (hidden || remembered !== "walletconnect") return;
    if (!adapter) { remembered = ""; writeSite({ wallet: undefined }); paint(); return; }
    if (!chosen) await choose(wcEntry(adapter), true);
  } catch (e) { console.error(e); }
}

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
/// The headers of a JSON-RPC POST to `url` (multicall.js headers): text/plain to
/// the site's own endpoints, so no CORS preflight is made first.
const rpcHeaders = (url) => (window.CurbMulti && window.CurbMulti.headers ? window.CurbMulti.headers(url)
  : { "content-type": "application/json" });
async function ethCall(rpc, to, data) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: rpcHeaders(rpc),
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
  // THE LOAD'S CHOICE FIRST: a press in the page's first second would find no
  // wallet while a lone one is still being asked whether it allowed the site.
  await ready;
  const eth = chosen && chosen.provider;
  if (!eth) throw new Error("No wallet is connected.");
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
// THE WALLETS ARE ASKED NOW, before any page script runs: every wallet already
// injected answers at once, and one that injects later announces itself.
window.addEventListener("eip6963:announceProvider", onAnnounce);
requestWallets();
// INSIDE COINBASE WALLET'S BROWSER, its wallet whether it announced or not -
// looked at after the request, so an announcement it made comes first.
adoptHost();
// SETTLED AT ONCE where waiting cannot change the choice (nothingToWaitFor);
// else as soon as the remembered wallet announces, or a moment after the page
// is parsed, and never later than a second in.
if (nothingToWaitFor()) settleNow();
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => { requestWallets(); adoptHost(); setTimeout(settleNow, 150); }, { once: true });
} else {
  setTimeout(settleNow, 150);
}
setTimeout(settleNow, 1000);
const ready = settled.then(detect);
// SOME WALLETS INJECT LATE, after the page's scripts have run, and announce it.
if (!window.ethereum) {
  window.addEventListener("ethereum#initialized", () => {
    adoptHost();
    if (settledYet && !chosen && !hidden) {
      const c = autoChoice();
      if (c) choose(c, true);
      else detect();
    }
    paint();
  }, { once: true });
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
  /// Settles once the wallets have been found and the load-time check has
  /// answered, so a page can wait for it instead of drawing "not connected" for
  /// a moment first.
  ready,
  /// THE WALLET THE PERSON CHOSE (see "the wallets"): the one provider every
  /// page reads the wallet through and sends through, or null while none is.
  wallet: () => (chosen ? chosen.provider : null),
  /// The wallet to connect with: the chosen one, else the person's pick in the
  /// picker - null when they close it, or when there is none (see pick).
  pick,
  /// The wallet pick() gave did not connect: let go of it where another could
  /// be picked (see declined).
  declined,
  /// The chosen wallet's events (accountsChanged, chainChanged), on whichever
  /// wallet is chosen now - and "accountsChanged" when the choice changes.
  walletOn,
  walletOff,
  /// "injected", "walletconnect", or null while no wallet is chosen.
  walletKind: () => (chosen ? (chosen.kind === "walletconnect" ? "walletconnect" : "injected") : null),
};

})();
