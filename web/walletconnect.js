// A WALLET ON A PHONE, THROUGH WALLETCONNECT: the site bar's adapter round
// Reown's UniversalProvider. topbar.js fetches this file only when the person
// picks "Phone wallet" in the wallet picker, or when a session they connected
// before is taken up at load - and offers neither unless web/config.js names a
// WalletConnect project id, a deployment and the site's own endpoint.
//
// WHAT IT IS. The UniversalProvider (web/vendor/walletconnect/, the npm
// release byte for byte, its sha384 checked by the browser as it loads - see
// web/vendor/README.txt) pairs with the phone over Reown's relay. This file
// wraps it as the EIP-1193 provider the pages already speak, and holds it to
// the rules the site holds an extension to:
//   - ONE CHAIN, config.js's, named inside every request (eip155:<id>); a
//     switch to any other is refused;
//   - eth_chainId AS HEX. The SDK answers a number, and every === "0x2105" in
//     app.js, launch.js and tx-core.js would then refuse every send;
//   - A SEND ONLY FROM THE SESSION'S OWN ACCOUNT, refused here otherwise;
//   - EVERY READ TO config.js's rpc, never over the relay (the pages read
//     receipts, nonces and calls "through the wallet");
//   - NOTHING THE WALLET SAYS ABOUT ITSELF IS USED but its name, as text: not
//     its url, its icons or its redirect. Every link built starts with one of
//     this file's own constants (APPS).
//
// ONE TAB AT A TIME, by a Web Lock held for the tab's life: tabs share the
// SDK's keys and its client id, so an answer meant for one tab could be taken
// by another, leaving the sender to time out on a transaction it did send.
// Another tab waits, and says why.
//
// Loaded as a classic script; the QR code library is an ES module, imported
// only to draw a code.
(function () {
"use strict";

const UMD = "vendor/walletconnect/universal-provider-2.25.0.umd.js";
/// The vendored file's sha384 (web/vendor/README.txt): the browser refuses any other.
const UMD_SRI = "sha384-XFSULDkJ0sKFAAvDdHzYguloXXQhcfBhJ/CKFLVUJVGE4TLNDlrJyh4C55oGVp3Z";
/// Relative to this file, as import() resolves it.
const QR = "./vendor/lean-qr-2.7.4/index.mjs";
/// THE RELAY, NAMED: the one WebSocket host the site's policy allows (connect-src).
const RELAY = "wss://relay.walletconnect.org";
const LOCK = "curb.walletconnect";
/// A pairing URI as the SDK makes one: wc:<64-hex topic>@2?<parameters>.
const PAIRING = /^wc:[0-9a-f]{64}@2\?[\w.%=&-]+$/;
/// A pairing code lives five minutes.
const CODE_MS = 5 * 60 * 1000;
/// PHONE WALLETS' OWN LINKS - each one's "universal link" as WalletGuide lists
/// it - opened with the pairing URI: root + "/wc?uri=" + the URI. The URI
/// carries the pairing's key, so a link here must be the wallet's own: each is
/// checked on a real phone before WalletConnect is switched on
/// (REAL_WALLET_TEST.txt). A wallet's own word about where it lives is never used.
const APPS = [
  ["MetaMask", "https://metamask.app.link"],
  ["Trust", "https://link.trustwallet.com"],
  ["Rainbow", "https://rnbwapp.com"],
  ["Coinbase Wallet", "https://go.cb-w.com"],
];
/// What the pages read through a wallet - answered by config.js's rpc.
const READS = new Set(["eth_blockNumber", "eth_call", "eth_getBalance", "eth_getBlockByNumber", "eth_getCode",
  "eth_getLogs", "eth_getTransactionByHash", "eth_getTransactionCount", "eth_getTransactionReceipt"]);
const IN_OTHER_TAB = "WalletConnect is open in another tab of this site. It runs in one tab at a time: " +
  "close it there, or use that tab.";

let hooks = null;          // topbar.js: site(), say(), unsay(), ended()
let site = null;           // { chainId, rpc, projectId }
let up = null;             // the UniversalProvider
let upLoading = null;
let lockHeld = false;
let locking = null;
let topic = null;          // the session this tab adopted
let account = null;        // its account on config.js's chain, lowercased
let peer = "";             // the wallet's name, as text
let viaApp = null;         // the APPS entry the person opened their wallet with
let onSent = null;         // a send waiting: told the request's id once it is out
let abortNow = null;       // ends the wait in the panel
const listeners = new Map();
/// Sessions that ended in this tab: the SDK can keep an expired one as its
/// `session`, and one ended is never taken up again.
const endedTopics = new Set();

const rpcError = (code, message) => Object.assign(new Error(message), { code });
const chainHex = () => "0x" + site.chainId.toString(16);
const caip = () => "eip155:" + site.chainId;
const isAddr = (s) => /^0x[0-9a-fA-F]{40}$/.test(String(s || ""));
const sameChain = (v) => { try { return BigInt(v) === BigInt(site.chainId); } catch { return false; } };
/// A wallet's name as text: one line, no control or direction characters, 40 at most.
const nameOf = (s) => typeof s !== "string" ? "" : Array.from(s.replace(/\s+/g, " ")
  .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "").trim()).slice(0, 40).join("").trim();
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function emit(ev, arg) {
  for (const fn of listeners.get(ev) || []) { try { fn(arg); } catch (e) { console.error(e); } }
}

// ---------------------------------------------------------------- the session
/// The account a session holds on config.js's chain ("eip155:<id>:0x…"), or null.
function sessionAccount(namespaces) {
  const ns = namespaces && namespaces.eip155;
  const list = ns && Array.isArray(ns.accounts) ? ns.accounts : [];
  for (const a of list) {
    const m = /^eip155:(\d+):(0x[0-9a-fA-F]{40})$/.exec(String(a));
    if (m && sameChain(m[1])) return m[2].toLowerCase();
  }
  return null;
}
/// TAKEN UP only with an account on config.js's chain and leave to send there.
function adopt(session) {
  const ns = session && session.namespaces && session.namespaces.eip155;
  const a = sessionAccount(session && session.namespaces);
  if (!a || !ns || !Array.isArray(ns.methods) || !ns.methods.includes("eth_sendTransaction")) return false;
  if (endedTopics.has(session.topic)) return false;
  topic = session.topic || null;
  account = a;
  peer = nameOf(session.peer && session.peer.metadata && session.peer.metadata.name);
  return true;
}
function setAccount(next) {
  next = isAddr(next) ? next.toLowerCase() : null;
  if (next === account) return;
  account = next;
  emit("accountsChanged", account ? [account] : []);
}
/// THE SESSION IS OVER (the phone ended it, it expired, or Disconnect): no
/// account, and the bar lets go of this wallet.
function ended() {
  if (!topic) return;
  endedTopics.add(topic);
  topic = null;
  account = null;
  emit("accountsChanged", []);
  emit("disconnect", rpcError(4900, "The WalletConnect session ended."));
  if (hooks) hooks.ended(adapter);
}
/// NO ACCOUNT ON config.js's CHAIN LEFT IN THE SESSION (an update, or an
/// accountsChanged, without one): nothing can be sent through it, and a bar
/// that kept it chosen answered every Connect with no account and never paired
/// again. It is ended, on the phone too, as Disconnect ends one.
function noAccount() { disconnect().catch(() => {}); }

// ---------------------------------------------------------------- the lock and the SDK
/// THIS TAB HOLDS THE LOCK for as long as it is open. Waiting for it, `onWait` says why.
function holdLock(onWait) {
  if (lockHeld) return Promise.resolve();
  if (!locking) {
    locking = new Promise((resolve) => {
      if (!navigator.locks || !navigator.locks.request) { lockHeld = true; resolve(); return; }
      const hold = () => { lockHeld = true; resolve(); return new Promise(() => {}); };
      navigator.locks.request(LOCK, { ifAvailable: true }, (lock) => {
        if (lock) return hold();
        holdLock.waiting = true;
        for (const f of holdLock.waiters) f();
        navigator.locks.request(LOCK, hold);
        return undefined;
      });
    });
  }
  if (onWait) {
    if (holdLock.waiting) onWait(); else holdLock.waiters.push(onWait);
  }
  return locking;
}
holdLock.waiting = false;
holdLock.waiters = [];

function loadUmd() {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = UMD;
    s.integrity = UMD_SRI;
    s.onload = resolve;
    s.onerror = () => reject(new Error("WalletConnect's code could not be loaded (" + UMD + ")."));
    document.head.append(s);
  });
}
const sdk = () => {
  const m = globalThis["@walletconnect/universal-provider"];
  return m && typeof m.UniversalProvider === "function" ? m.UniversalProvider : null;
};

/// THE UniversalProvider, made once - after the lock, since it opens the relay
/// and the storage every tab shares.
function provider(onWait) {
  if (up) return Promise.resolve(up);
  const waiting = holdLock(onWait);
  if (!upLoading) {
    upLoading = (async () => {
      await waiting;
      if (!sdk()) await loadUmd();
      const UP = sdk();
      if (!UP) throw new Error("WalletConnect's code did not start.");
      const p = await UP.init({
        projectId: site.projectId,
        relayUrl: RELAY,
        // NO TELEMETRY: the SDK's own event reports (pulse) stay off.
        telemetryEnabled: false,
        logger: "error",
        // WHAT THE WALLET IS TOLD THIS SITE IS. url is checked by Reown's Verify
        // against the page's own origin; no redirect is given.
        metadata: {
          name: "Curb",
          description: "Launch coins paired with ETH, stocks and more, and trade them from the first block.",
          url: location.origin,
          icons: [location.origin + "/curb-icon.png"],
        },
      });
      p.on("session_event", (e) => {
        const ev = e && e.params && e.params.event;
        if (!e || e.topic !== topic || !ev || ev.name !== "accountsChanged" || !Array.isArray(ev.data)) return;
        // AN EVENT ABOUT ANOTHER CHAIN says nothing of this one's account.
        const on = /^eip155:(\d+)$/.exec(String(e.params.chainId || ""));
        if (on && !sameChain(on[1])) return;
        // A CAIP-10 ACCOUNT ON THIS CHAIN, or a plain address; any other chain's is not this session's.
        const next = ev.data.map((a) => {
          const m = /^eip155:(\d+):(0x[0-9a-fA-F]{40})$/.exec(String(a));
          return m ? (sameChain(m[1]) ? m[2] : null) : (isAddr(a) ? String(a) : null);
        }).find(Boolean);
        if (next) setAccount(next); else noAccount();
      });
      p.on("session_update", (e) => {
        if (!e || e.topic !== topic) return;
        const next = sessionAccount(e.params && e.params.namespaces);
        if (next) setAccount(next); else noAccount();
      });
      p.on("session_delete", (e) => { if (!e || !e.topic || e.topic === topic) ended(); });
      if (p.client && typeof p.client.on === "function") {
        p.client.on("session_expire", (e) => { if (e && e.topic === topic) ended(); });
        // THE REQUEST'S OWN ID, once it has gone out: the "Open <wallet>" link
        // under the bar then names it (see send).
        p.client.on("session_request_sent", (e) => {
          if (!e || e.topic !== topic || !e.request || e.request.method !== "eth_sendTransaction") return;
          if (onSent && /^\d{1,20}$/.test(String(e.id))) onSent(String(e.id));
        });
      }
      up = p;
      return p;
    })();
    upLoading.catch(() => { upLoading = null; });
  }
  return upLoading;
}

// ---------------------------------------------------------------- the adapter
let readId = 0;
/// A READ, from config.js's own endpoint - never over the relay.
async function read(method, params) {
  const url = site.rpc;
  const headers = window.CurbMulti && window.CurbMulti.headers ? window.CurbMulti.headers(url)
    : { "content-type": "application/json" };
  const res = await fetch(url, { method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: ++readId, method, params }) });
  if (!res.ok) throw new Error("The site's endpoint answered HTTP " + res.status);
  const body = await res.json();
  if (body && body.error) throw Object.assign(new Error(body.error.message || "RPC error"), { code: body.error.code });
  return body ? body.result : null;
}

async function send(tx) {
  if (!up || !topic || !account) throw rpcError(4100, "No WalletConnect session is connected.");
  if (!tx || typeof tx !== "object" || String(tx.from || "").toLowerCase() !== account) {
    throw rpcError(4100, "This transaction is not from the connected account, so it was not sent.");
  }
  // ON A PHONE THE WALLET IS ANOTHER APP: the bar says where to confirm, with
  // the wallet's own link when the person opened it from here - a tap is what
  // iOS needs to switch apps. Once the request is out the link names it, as
  // the SDK's own opener does (root/wc?requestId=…&sessionTopic=…), so the
  // wallet opens on it; the bar opens it in a new tab, never in this page,
  // which is waiting on the answer (topbar.js showNote).
  const phone = matchMedia("(pointer: coarse)").matches && !!hooks;
  const app = viaApp;
  const say = (href) => hooks.say("Confirm in " + (peer || "your wallet") + ".", app ? { href, text: "Open " + app[0] } : null);
  const mine = phone && app
    ? (id) => say(app[1] + "/wc?requestId=" + id + "&sessionTopic=" + encodeURIComponent(topic || ""))
    : null;
  if (phone) say(app && app[1]);
  onSent = mine;
  try {
    return await up.request({ method: "eth_sendTransaction", params: [tx] }, caip());
  } catch (e) {
    // A WALLET THAT DECLINES OVER WALLETCONNECT may say so with the SDK's
    // USER_REJECTED, 5000, rather than EIP-1193's 4001. Exactly 5000 is read as
    // 4001 - the wallet's word that nothing was sent, taken as the pages take
    // 4001 from an extension (the owner's call). Anything else goes on as it
    // came, and the pages say it is not certain nothing was broadcast.
    if (e && e.code === 5000) throw rpcError(4001, (e && e.message) || "Declined in the wallet.");
    throw e;
  } finally {
    if (onSent === mine) onSent = null;
    if (phone) hooks.unsay();
  }
}

async function disconnect() {
  try { if (up && up.session) await up.disconnect(); } catch { /* gone already */ }
  ended();
}

async function request(args) {
  const method = args && args.method;
  const params = args && Array.isArray(args.params) ? args.params : [];
  if (method === "eth_chainId") return chainHex();
  if (method === "eth_accounts") return account ? [account] : [];
  // NO ACCOUNT IS AN ERROR HERE, as EIP-1193 has it, not [] - which a page
  // wrote as "Connected: undefined".
  if (method === "eth_requestAccounts") {
    if (!account) throw rpcError(4100, "No WalletConnect session is connected: connect again to pair your phone's wallet.");
    return [account];
  }
  if (method === "eth_sendTransaction") return send(params[0]);
  if (method === "wallet_switchEthereumChain") {
    if (sameChain(params[0] && params[0].chainId)) return null;
    throw rpcError(4901, "This WalletConnect session is on chain " + site.chainId + " only.");
  }
  if (method === "wallet_addEthereumChain") throw rpcError(4200, "A WalletConnect session is not asked to add a network.");
  if (method === "wallet_revokePermissions") { await disconnect(); return null; }
  if (READS.has(method)) return read(method, params);
  throw rpcError(4200, "This site does not ask a WalletConnect wallet for " + String(method).slice(0, 60) + ".");
}

const adapter = Object.freeze({
  isWalletConnect: true,
  request,
  on(ev, fn) {
    if (typeof fn !== "function") return;
    if (!listeners.has(ev)) listeners.set(ev, new Set());
    listeners.get(ev).add(fn);
  },
  removeListener(ev, fn) { if (listeners.has(ev)) listeners.get(ev).delete(fn); },
});

// ---------------------------------------------------------------- the panel
/// THE PAIRING, IN THE PICKER'S PANEL: the code to scan, the phone wallets'
/// links (shown on a touch screen - topbar.css), Copy link, and the way back.
/// @param panel  the element to draw in (topbar.js startWalletConnect)
/// @param nav    { back(), cancel() } - what the picker does after either
/// @return the adapter once a session on config.js's chain is approved, or
///         null when the person went back or cancelled
function connect(panel, nav) {
  site = hooks.site();
  return new Promise((resolve) => {
    let over = false;
    let expiry = null;
    let p = null;
    const onUri = (u) => { if (!over) drawCode(u); };
    const finish = (v) => {
      if (over) return;
      over = true;
      abortNow = null;
      clearTimeout(expiry);
      if (p) p.removeListener("display_uri", onUri);
      resolve(v);
    };
    abortNow = () => finish(null);

    const status = el("p", "cbWcStatus", "Starting WalletConnect…");
    status.setAttribute("role", "status");
    const code = el("div", "cbWcCode");
    const back = el("button", "cbWcBtn", "Back");
    const cancel = el("button", "cbWcBtn", "Cancel");
    back.type = cancel.type = "button";
    back.addEventListener("click", () => { finish(null); nav.back(); });
    cancel.addEventListener("click", () => { finish(null); nav.cancel(); });
    const row = el("div", "cbWcRow");
    row.append(back, cancel);
    panel.replaceChildren(status, code, row);

    function drawCode(uri) {
      if (typeof uri !== "string" || !PAIRING.test(uri)) {
        status.textContent = "WalletConnect gave a code this site does not read, so none is shown.";
        return;
      }
      code.replaceChildren();
      const apps = el("div", "cbWcApps");
      for (const [name, root] of APPS) {
        const a = el("a", "", name);
        a.href = root + "/wc?uri=" + encodeURIComponent(uri);
        a.rel = "noreferrer noopener";
        a.addEventListener("click", () => { viaApp = [name, root]; });
        apps.append(a);
      }
      // ANY OTHER WALLET: the bare URI - Android offers the apps that open it.
      const other = el("a", "", "Other wallet");
      other.href = uri;
      apps.append(other);
      const canvas = el("canvas", "cbWcQr");
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", "WalletConnect code: scan it with your phone's wallet");
      const copy = el("button", "cbWcBtn", "Copy link");
      copy.type = "button";
      copy.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(uri); copy.textContent = "Copied"; }
        catch { copy.textContent = "Could not copy"; }
        setTimeout(() => { copy.textContent = "Copy link"; }, 1400);
      });
      code.append(apps, canvas, copy);
      status.textContent = "Scan the code with your phone's wallet, or open the wallet from here on a phone.";
      import(QR).then((qr) => {
        qr.generate(uri).toCanvas(canvas, { on: [0, 0, 0, 255], off: [255, 255, 255, 255], pad: 2 });
      }).catch(() => { status.textContent = "The code could not be drawn: copy the link into your wallet instead."; });
    }

    function expired() {
      if (over) return;
      code.replaceChildren();
      status.textContent = "This code expired.";
      const again = el("button", "cbWcBtn", "New code");
      again.type = "button";
      again.addEventListener("click", () => { code.replaceChildren(); status.textContent = "Making a new code…"; pairing(); });
      code.append(again);
    }

    function pairing() {
      clearTimeout(expiry);
      expiry = setTimeout(expired, CODE_MS);
      p.connect({
        optionalNamespaces: {
          eip155: {
            chains: [caip()],
            // THE SITE NEVER SIGNS A MESSAGE: sends and a switch to its own chain, nothing more.
            methods: ["eth_sendTransaction", "wallet_switchEthereumChain"],
            events: ["accountsChanged", "chainChanged"],
            rpcMap: { [site.chainId]: site.rpc },
          },
        },
      }).then((session) => {
        // APPROVED AFTER THE PERSON LEFT: not wanted, so not kept.
        if (over) { p.disconnect().catch(() => {}); return; }
        if (!adopt(session || p.session)) {
          p.disconnect().catch(() => {});
          clearTimeout(expiry);
          code.replaceChildren();
          status.textContent = "The wallet did not allow sending on chain " + site.chainId +
            ", so nothing was connected. Choose that network in the wallet and try again.";
          return;
        }
        finish(adapter);
      }, (e) => {
        if (over) return;
        clearTimeout(expiry);
        code.replaceChildren();
        status.textContent = "The wallet did not connect: " + ((e && e.message) || e);
      });
    }

    provider(() => { if (!over) status.textContent = IN_OTHER_TAB; }).then((made) => {
      if (over) return;
      p = made;
      if (p.session && adopt(p.session)) { finish(adapter); return; }
      status.textContent = "Making a code…";
      p.on("display_uri", onUri);
      pairing();
    }, (e) => {
      if (!over) status.textContent = "WalletConnect could not be opened: " + ((e && e.message) || e);
    });
  });
}

/// A SESSION CONNECTED BEFORE, taken up at load: the adapter, or null when
/// there is none. Waits for the lock, and the bar says why meanwhile.
async function restore() {
  site = hooks.site();
  let said = false;
  const p = await provider(() => { said = true; hooks.say(IN_OTHER_TAB); });
  if (said) hooks.unsay();
  return p.session && adopt(p.session) ? adapter : null;
}

window.CurbWalletConnect = Object.freeze({
  init(h) { hooks = h; },
  connect,
  restore,
  /// The picker closed: whatever the panel waits for is no longer wanted.
  abort() { if (abortNow) abortNow(); },
});

})();
