// WALLETS THAT ANNOUNCE THEMSELVES (EIP-6963), AND A STAND-IN FOR WALLETCONNECT'S
// SDK, for the browser tests: wallets.spec.js and prod.spec.js share them.
//
// Each wallet is web/wallet-stub.js's makeWallet - the same stub every other
// suite uses as window.ethereum - announced the way an extension announces
// itself: once at once, and again on every "eip6963:requestProvider". Every
// method a page asks of it is written down, per wallet, in sessionStorage
// (which survives navigation in the same tab), so "nothing asked B" is a fact
// to read rather than an absence to hope for. Each wallet keeps its own grant
// in localStorage, as a wallet keeps it per site.
//
// THE SDK STAND-IN is served at the vendored file's path (useFakeWalletConnect),
// and walletconnect.js is served with that stand-in's sha384 in place of the
// real file's - the browser checks the integrity either way, so the real
// adapter runs, unchanged but for that one constant, against a fake relay that
// never reaches the network. window.__wc records what it was asked and lets a
// test approve, restore or end a session.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const WEB = path.join(__dirname, "..");
const STUB = fs.readFileSync(path.join(WEB, "wallet-stub.js"), "utf8");

/// Runs in the page, before any of its scripts: the wallets of `spec` made,
/// logged and announced; spec.legacy, if any, as window.ethereum too.
function installWallets(spec) {
  var LOG = "wallets.log";
  var all = (spec.list || []).concat(spec.legacy ? [spec.legacy] : []);
  if (!sessionStorage.getItem("wallets.init")) {
    sessionStorage.setItem("wallets.init", "1");
    all.forEach(function (w) { localStorage.setItem("grant." + w.id, w.connected ? "1" : "0"); });
    if (spec.store) localStorage.setItem("curb.site.v1", JSON.stringify(spec.store));
  }
  function log(id, m) {
    try {
      var l = JSON.parse(sessionStorage.getItem(LOG) || "{}");
      (l[id] = l[id] || []).push(m);
      sessionStorage.setItem(LOG, JSON.stringify(l));
    } catch (e) { /* the log is the test's, not the page's */ }
  }
  function make(w) {
    var x = window.makeWallet(spec.rpc, Object.assign({ forward: true, chainId: "0x2105" }, w.cfg || {},
      { account: w.account, connected: localStorage.getItem("grant." + w.id) === "1" }));
    // w.flags: what the provider says of itself - isCoinbaseBrowser, the flag
    // Coinbase Wallet's own browser puts on its wallet, and the like.
    if (w.flags) Object.assign(x, w.flags);
    var inner = x.request.bind(x);
    // w.slow: { method: ms } - a wallet slow to answer that method (an
    // extension waking its service worker, a person reading the prompt).
    x.request = function (a) {
      log(w.id, a.method);
      var ms = w.slow && w.slow[a.method];
      return ms ? new Promise(function (r) { setTimeout(r, ms); }).then(function () { return answer(a); }) : answer(a);
    };
    function answer(a) {
      if (a.method === "eth_requestAccounts") {
        if (w.decline) return Promise.reject(Object.assign(new Error("User rejected the request."), { code: 4001 }));
        localStorage.setItem("grant." + w.id, "1");
      }
      if (a.method === "wallet_revokePermissions") {
        localStorage.setItem("grant." + w.id, "0");
        x.cfg.connected = false;
        return Promise.resolve(null);
      }
      return inner(a);
    }
    return x;
  }
  window.__wallets = {};
  (spec.list || []).forEach(function (w) {
    var p = make(w);
    window.__wallets[w.id] = p;
    var detail = Object.freeze({ info: Object.freeze({ uuid: w.uuid, name: w.name, icon: w.icon, rdns: w.rdns }), provider: p });
    var announce = function () { window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: detail })); };
    var start = function () { window.addEventListener("eip6963:requestProvider", announce); announce(); };
    if (w.late) setTimeout(start, w.late); else start();
  });
  if (spec.legacy) {
    window.ethereum = make(spec.legacy);
    window.__wallets[spec.legacy.id] = window.ethereum;
  }
}

/// The init script: the stub, the wallets, then `extra` (a function run in
/// the page after them, for announcements no well-formed wallet makes).
function walletsScript(spec, extra) {
  return STUB + "\n;(" + installWallets.toString() + ")(" + JSON.stringify(spec) + ");\n" +
    (extra ? "(" + extra.toString() + ")();\n" : "");
}

/// A wallet's announced uuid, from a digit: 36 characters, as EIP-6963 has them.
const uuid = (d) => `${d}${d}${d}${d}${d}${d}${d}${d}-${d}${d}${d}${d}-4${d}${d}${d}-8${d}${d}${d}-${d.repeat(12)}`;

/// COINBASE WALLET'S OWN BROWSER, as a context's user agent: a phone's, with
/// "CoinbaseWalletRN/" in it - the one part the site reads (topbar.js IN_APP),
/// as Coinbase's SDK does (isCoinbaseWalletHost).
const IN_APP_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) " +
  "Mobile/15E148 CoinbaseWalletRN/29.10.0";
/// The flags the app's wallet carries: isCoinbaseBrowser is the one its SDKs read.
const IN_APP_FLAGS = { isCoinbaseBrowser: true, isCoinbaseWallet: true };

/// What a page asked each wallet, by id.
const logs = (page) => page.evaluate(() => JSON.parse(sessionStorage.getItem("wallets.log") || "{}"));
const clearLogs = (page) => page.evaluate(() => sessionStorage.setItem("wallets.log", "{}"));

// ---------------------------------------------------------------- WalletConnect
/// A PAIRING URI as the SDK makes one (walletconnect.js PAIRING).
const WC_URI = "wc:" + "ab".repeat(32) + "@2?relay-protocol=irn&symKey=" + "cd".repeat(32) + "&expiryTimestamp=1792000000";
/// A Reown project id: 32 hex characters.
const PROJECT_ID = "0123456789abcdef0123456789abcdef";
/// An approved session on chain 8453 for `account`.
const wcSession = (account, topic = "topic-1") => ({
  topic,
  namespaces: { eip155: { accounts: ["eip155:8453:" + account], methods: ["eth_sendTransaction", "wallet_switchEthereumChain"],
    events: ["accountsChanged", "chainChanged"] } },
  peer: { metadata: { name: "Fake Phone Wallet", url: "https://evil.example", icons: ["https://evil.example/i.png"] } },
});

/// THE STAND-IN for @walletconnect/universal-provider's UMD build: the same
/// global, the same calls walletconnect.js makes, and nothing on the network.
/// window.__wc may be set before it loads (a session to restore).
const FAKE_UP = `(function () {
  var W = window.__wc = window.__wc || {};
  W.inits = W.inits || []; W.connects = W.connects || []; W.requests = W.requests || []; W.disconnects = W.disconnects || 0;
  W.uri = W.uri || ${JSON.stringify(WC_URI)};
  function Fake(opts) {
    var self = this;
    this.opts = opts; this.ev = {}; this.session = undefined;
    this.client = { on: function (e, f) { self.on("client:" + e, f); } };
  }
  Fake.init = function (opts) {
    W.inits.push(JSON.parse(JSON.stringify(opts)));
    var p = new Fake(opts);
    W.up = p;
    if (W.restore) p.session = W.restore;
    return Promise.resolve(p);
  };
  Fake.prototype.on = function (e, f) { (this.ev[e] = this.ev[e] || []).push(f); };
  Fake.prototype.removeListener = function (e, f) { this.ev[e] = (this.ev[e] || []).filter(function (g) { return g !== f; }); };
  Fake.prototype.emit = function (e, a) { (this.ev[e] || []).slice().forEach(function (f) { f(a); }); };
  Fake.prototype.connect = function (params) {
    var self = this;
    W.connects.push(JSON.parse(JSON.stringify(params)));
    return new Promise(function (resolve, reject) {
      W.approve = function (session) { self.session = session; resolve(session); };
      W.refuse = function (e) { reject(e); };
      setTimeout(function () { self.emit("display_uri", W.uri); }, 0);
    });
  };
  Fake.prototype.request = function (args, chain) {
    var self = this;
    W.requests.push({ method: args.method, chain: chain });
    if (args.method === "eth_chainId") return Promise.resolve(8453);
    // SENT OVER THE RELAY: the client says so with the request's id, as the SDK does.
    if (args.method === "eth_sendTransaction") {
      var id = W.nextId = (W.nextId || 1000) + 1;
      setTimeout(function () {
        self.emit("client:session_request_sent", { topic: self.session && self.session.topic, request: args, chainId: chain, id: id });
      }, 0);
    }
    if (W.answer) return W.answer(args);
    return Promise.reject({ code: -32000, message: "nothing answers this in the test" });
  };
  Fake.prototype.disconnect = function () { W.disconnects += 1; this.session = undefined; return Promise.resolve(); };
  globalThis["@walletconnect/universal-provider"] = { UniversalProvider: Fake, default: Fake };
})();
`;
const UMD_PATH = /\/vendor\/walletconnect\/universal-provider-[\d.]+\.umd\.js(\?.*)?$/;
const sri = (body) => "sha384-" + crypto.createHash("sha384").update(body, "utf8").digest("base64");

/// The stand-in served at the vendored file's path, and walletconnect.js with
/// the stand-in's hash for the real file's.
async function useFakeWalletConnect(page) {
  const adapter = fs.readFileSync(path.join(WEB, "walletconnect.js"), "utf8");
  const m = /const UMD_SRI = "([^"]+)";/.exec(adapter);
  if (!m) throw new Error("walletconnect.js has no UMD_SRI constant");
  const body = adapter.replace(m[0], `const UMD_SRI = "${sri(FAKE_UP)}";`);
  await page.route(/\/walletconnect\.js(\?.*)?$/, (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body }));
  await page.route(UMD_PATH, (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: FAKE_UP }));
}

/// Whether a request is anything of WalletConnect's: the adapter, a vendored
/// file, or a Reown host.
const isWalletConnect = (url) => /\/walletconnect\.js(\?|$)|\/vendor\/|walletconnect\.(org|com)/.test(url);

// ---------------------------------------------------------------- a smart wallet's bundle
// AN ERC-4337 SMART WALLET, AS ITS RECEIPTS LOOK: what the person signed goes on
// chain as a user operation inside a bundler's transaction to the EntryPoint,
// and the hash the wallet hands back can be that bundle's - status 0x1 though
// the operation reverted, the EntryPoint saying so in UserOperationEvent.
// wallet-stub.js's `userOps` makes the bundle; the contract below, put at an
// EntryPoint's address for the length of a test, is what it calls.
/// v0.6, the EntryPoint Coinbase Wallet's smart wallet was first built on.
const ENTRY_POINT = "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789";
global.window = global.window || global;
require("../keccak.js");
/// UserOperationEvent's topic, worked out here from its signature.
const USER_OP_EVENT = window.CurbKeccak.keccak256("0x" +
  Buffer.from("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)", "utf8").toString("hex"));
/// AN ENTRYPOINT THAT ONLY REPORTS: called with (opHash, sender, success) as
/// three words, it emits UserOperationEvent(opHash, sender, paymaster 0) with
/// nonce 0, `success` and no gas. Given a fourth word, an address, it first
/// calls that address with the rest of its data, whatever the call does: a
/// call to itself is another account's operation before this one, in the same
/// bundle, with that operation's own logs before its event.
///   PUSH1 0x60 CALLDATALOAD DUP1 ISZERO PUSH1 0x21 JUMPI      no fourth word: to the event
///   PUSH1 0x80 CALLDATASIZE SUB DUP1 PUSH1 0x80 PUSH2 0x100 CALLDATACOPY
///                                                            memory[0x100..] = data[0x80..]
///   PUSH1 0 PUSH1 0 DUP3 PUSH2 0x100 PUSH1 0 DUP7 GAS CALL POP  the call
///   JUMPDEST
///   PUSH1 0x40 CALLDATALOAD PUSH1 0x20 MSTORE        memory[32] = success
///   PUSH1 0 PUSH1 0x20 CALLDATALOAD PUSH1 0 CALLDATALOAD PUSH32 topic
///   PUSH1 0x80 PUSH1 0 LOG4 STOP                    topics: event, opHash, sender, 0
const REPORTING_ENTRY_POINT = "0x" + "606035801560215760803603806080610100376000600082610100600086" + "5af1505b" +
  "604035602052" + "6000602035600035" + "7f" + USER_OP_EVENT.slice(2) + "60806000a400";
/// `fn` run with the reporting contract at `address`, its own code put back after.
/// @param rpc  (method, params) => result, on the run's node
async function withReportingEntryPoint(rpc, fn, address = ENTRY_POINT) {
  const code = await rpc("eth_getCode", [address, "latest"]);
  await rpc("anvil_setCode", [address, REPORTING_ENTRY_POINT]);
  try { return await fn(); } finally { await rpc("anvil_setCode", [address, code]); }
}
/// wallet-stub.js's `userOps`: the sends whose data starts with one of `only`
/// (every send, without it) made as `bundler`'s bundle, the operation
/// `success`, the EntryPoint making `call` ({ to, data }) first.
const bundled = (bundler, success, only, call) => ({ entryPoint: ENTRY_POINT, bundler, success, only, call });
const word32 = (x) => BigInt(x).toString(16).padStart(64, "0");
/// ANOTHER ACCOUNT'S OPERATION, for `bundled`'s `call`: `sender`'s, `success`,
/// its own logs those of `call` ({ to, data }) when one is given - made by the
/// EntryPoint, as the operation's account would.
const otherOp = (sender, success, call) => ({ to: ENTRY_POINT, data: "0x" + word32("0x" + "0d".repeat(32)) +
  word32(sender) + word32(success ? 1 : 0) + (call ? word32(call.to) + String(call.data).replace(/^0x/, "") : "") });

module.exports = {
  walletsScript, uuid, logs, clearLogs, IN_APP_UA, IN_APP_FLAGS,
  WC_URI, PROJECT_ID, wcSession, FAKE_UP, UMD_PATH, useFakeWalletConnect, isWalletConnect, sri,
  ENTRY_POINT, USER_OP_EVENT, REPORTING_ENTRY_POINT, withReportingEntryPoint, bundled, otherOp,
};
