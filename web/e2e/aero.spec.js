// THE AERODROME ROUTE, AS THE SWAP CARD USES IT (the owner's call, 18 October
// 2026: the best ETH entry for a curve buy - Aerodrome first, then the curve).
//
// What these tests pin, each against the chain rather than against the page:
//   - the router, quoter and factory the page pins are the ones on the chain,
//     with the code hashes it pins, and the path table is frozen and exists;
//   - the rule (preferAerodrome) and the encodings, as pure functions;
//   - which route a buy takes, made DETERMINISTIC by rewriting the quoters'
//     answers on an endpoint of the test's own (routedToken) - the fork's real
//     gaps are a few basis points and drift as the suite trades - while every
//     amount is asserted from the chain's own logs, never from the rewritten
//     numbers;
//   - the press against the quote on screen, the router's code read again
//     before step 1, refusals in words, the issuer asked before step 1;
//   - and what a swap leaves held: across a reload, a replacement and a lagging
//     endpoint, with Buy with it, Sell it back, Revoke and Dismiss.
// Every trade is real: the wallet stub forwards to the run's own fork.
// THE NVDAc/USDC AERODROME POOL IS THE SETUP'S WHALE (demo-app.sh), so no
// Aerodrome send here touches NVDAc: SPCXc is the asset, cbBTC the non-row one.
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

const STATE = JSON.parse(fs.readFileSync(path.join(__dirname, ".state.json"), "utf8"));
const STUB = fs.readFileSync(path.join(__dirname, "..", "wallet-stub.js"), "utf8");
const APP = STATE.app;
const OWNER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const SPCXC = "0xb2000000000000000000007b9fcbd005511acbd5";
const CBBTC = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf";
const UNIVERSAL_ROUTER = "0x6ff5693b99212da76ad316178a184ab56d299b43";
const QUOTER_V2 = "0x3d4e44eb1374240ce5f1b871ab261cd16335b76a";
const POLICY_REGISTRY = "0x8453000000000000000000000000000000000002";
const CURB_ROUTER = "0xea20c3266229a01cd0f45d9c7921a45d5b359561";
const ETH_FEED = "0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70";
// WRITTEN HERE, NOT READ FROM app.js: A1 holds the page's copy against these
// and against the chain.
const AERO_ROUTER = "0x698cb2b6dd822994581fea6ea4fc755d1363a92f";
const AERO_QUOTER = "0x514c8b5f54112481e28028f1166bd78501089259";
const AERO_FACTORY = "0xf8f2eb4940cfe7d13603dddd87f123820fc061ef";
const ROUTER_HASH = "0xfedc4e21e1097b0ec1b4f1aa901cf645c22f9e5d297727b0f37275ee1d083df4";
const QUOTER_HASH = "0x4c4c43e0024343e65597f0f0a1b829aaf69e5a6c0a0148fb63d28ff5730be551";
const FACTORY_HASH = "0x4961963494e47f363617ab9a0f3999a28b33c519e51392952db06350cce700bd";
const NINE = {
  cbXRP: "0xcb585250f852c6c6bf90434ab21a00f02833a4af", cbZEC: "0xb2000000000000000000008501b13360000cb2ec",
  GOOGLc: "0xb2000000000000000000002d0ba3164cc74f58b7", NVDAc: "0xb20000000000000000000078ee7ce2fe4908108c",
  SPCXc: SPCXC, AMZNc: "0xb200000000000000000000d9192b6b456483c2e8", MSFTc: "0xb200000000000000000000ab99cfa739e253872b",
  AAPLc: "0xb200000000000000000000c2e324d24d7eecd1fb", METAc: "0xb2000000000000000000008bc8786b856e61707c",
};
const MIN_SQRT = 4295128739n;
const HOST = "http://aero-quotes.test:8702";

test.describe.configure({ mode: "serial" });

let browserRef;
// THE FILE LEAVES THE CHAIN AS IT FOUND IT: its launches and swaps are reverted
// once it is done, so the suites after it (browse.spec.js counts launches on its
// first page) see the stack global-setup made, not this file's extra launches.
let fileSnap = null;
test.beforeAll(async ({ browser }) => { browserRef = browser; fileSnap = await rpc("evm_snapshot", []); });
test.afterAll(async () => {
  if (fileSnap !== null) expect(await rpc("evm_revert", [fileSnap]), "aero.spec.js's snapshot was not reverted").toBe(true);
});

// ------------------------------------------------------------------ the chain, from node
async function rpc(method, params) {
  const res = await fetch(STATE.rpc, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(method + ": " + JSON.stringify(j.error));
  return j.result;
}
const ethCall = (to, data, block = "latest") => rpc("eth_call", [{ to, data }, block]);
global.window = global.window || global;
require("../keccak.js"); require("../abi.js");
const { encode, T } = window.CurbAbi;
const keccakHex = (hex) => window.CurbKeccak.keccak256(hex);
const keccak = (s) => keccakHex("0x" + window.CurbAbi.utf8Hex(s));
const sel = (s) => keccak(s).slice(0, 10);
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
const pad = (a) => String(a).toLowerCase().replace(/^0x/, "").padStart(64, "0");
const addrOf = (raw) => "0x" + String(raw).replace(/^0x/, "").slice(24, 64);
const wordAt = (raw, i) => BigInt("0x" + String(raw).replace(/^0x/, "").slice(i * 64, i * 64 + 64));
const slip = (x, bps) => (x * (10000n - BigInt(bps))) / 10000n;
const balanceOf = async (token, who, block) => BigInt(await ethCall(token, sel("balanceOf(address)") + pad(who), block));
const allowanceOf = async (token, owner, spender) =>
  BigInt(await ethCall(token, sel("allowance(address,address)") + pad(owner) + pad(spender)));
const nextBlock = async () => "0x" + (BigInt(await rpc("eth_blockNumber", [])) + 1n).toString(16);
const ethOf = async (who) => BigInt(await rpc("eth_getBalance", [who, "latest"]));
const TRANSFER = keccak("Transfer(address,address,uint256)");
const CURVE_BUY = keccak("CurveBuy(address,address,uint256,uint256,uint256,uint256)");
const CURVE_REFUND = keccak("CurveBuyRefunded(address,uint256)");
const WITHDRAWAL = keccak("Withdrawal(address,uint256)");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendMined(tx) {
  const hash = await rpc("eth_sendTransaction", [tx]);
  for (let i = 0; i < 200; i++) {
    const r = await rpc("eth_getTransactionReceipt", [hash]);
    if (r) { expect(r.status, "this transaction reverted: " + hash).toBe("0x1"); return r; }
    await wait(100);
  }
  throw new Error("never mined: " + hash);
}
async function costOf(hash) {
  const r = await rpc("eth_getTransactionReceipt", [hash]);
  return BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice) + (r.l1Fee ? BigInt(r.l1Fee) : 0n);
}
const blockTime = async (blockNumber) => BigInt((await rpc("eth_getBlockByNumber", [blockNumber, false])).timestamp);
async function inSnapshot(fn) {
  const snap = await rpc("evm_snapshot", []);
  try { return await fn(); } finally {
    expect(await rpc("evm_revert", [snap]), "the snapshot was not reverted").toBe(true);
  }
}
/// AERODROME'S QUOTER WITH NO CODE: its hash then mismatches, so the route is
/// off (not unread). Put back in a finally.
async function withoutAerodrome(fn) {
  const code = await rpc("eth_getCode", [AERO_QUOTER, "latest"]);
  await rpc("anvil_setCode", [AERO_QUOTER, "0x"]);
  try { return await fn(); } finally { await rpc("anvil_setCode", [AERO_QUOTER, code]); }
}
async function withoutCurbRouter(fn) {
  const code = await rpc("eth_getCode", [CURB_ROUTER, "latest"]);
  await rpc("anvil_setCode", [CURB_ROUTER, "0x"]);
  try { return await fn(); } finally { if (code !== "0x") await rpc("anvil_setCode", [CURB_ROUTER, code]); }
}
async function freshAccount(label) {
  const a = "0x" + keccak("curb aero.spec " + label).slice(-40);
  expect(await rpc("eth_getCode", [a, "latest"]), "the account has code on this chain").toBe("0x");
  await rpc("anvil_impersonateAccount", [a]);
  await rpc("anvil_setBalance", [a, "0x" + (100n * 10n ** 18n).toString(16)]);
  return a;
}
async function factoryFor(quote) {
  const registry = addrOf(await ethCall(APP.lens, sel("registry()")));
  const n = Number(BigInt(await ethCall(registry, sel("launcherCount()"))));
  for (let i = 0; i < n; i++) {
    const f = addrOf(await ethCall(registry, sel("launcherAt(uint256)") + word(i)));
    if (addrOf(await ethCall(f, sel("quoteToken()"))) === quote.toLowerCase()) return f;
  }
  return null;
}
/// THE ISSUER'S OWN BLOCKLIST, as test/fork/B20Restrictions.t.sol uses it: the
/// policy's admin adds an address. `scope` names which of the asset's policies.
async function issuerAdmin(asset, scope = "TRANSFER_RECEIVER_POLICY()") {
  const s = await ethCall(asset, sel(scope));
  const policy = BigInt(await ethCall(asset, sel("policyId(bytes32)") + s.slice(2)));
  expect(policy > 0n, asset + " names no policy").toBe(true);
  const admin = addrOf(await ethCall(POLICY_REGISTRY, sel("policyAdmin(uint64)") + word(policy)));
  await rpc("anvil_impersonateAccount", [admin]);
  await rpc("anvil_setBalance", [admin, "0x" + (10n ** 18n).toString(16)]);
  const authorized = async (who) =>
    BigInt(await ethCall(POLICY_REGISTRY, sel("isAuthorized(uint64,address)") + word(policy) + pad(who))) === 1n;
  return {
    policy, authorized,
    block: (who) => sendMined({ from: admin, to: POLICY_REGISTRY,
      data: sel("updateBlocklist(uint64,bool,address[])") + encode([T.uint(64), T.bool, T.array(T.address)], [policy, true, [who]]).slice(2) }),
  };
}

// ------------------------------------------------------------------ calldata
const argWords = (data) => { const h = data.replace(/^0x/, "").slice(8); const w = []; for (let i = 0; i < h.length; i += 64) w.push(h.slice(i, i + 64)); return w; };
/// The elements of an ABI `bytes[]` whose offset word is at word `i` of `hex`.
function bytesArray(hex, i) {
  const h = hex.replace(/^0x/, "");
  const at = Number(BigInt("0x" + h.slice(i * 64, i * 64 + 64))) * 2;
  const n = Number(BigInt("0x" + h.slice(at, at + 64)));
  const out = [];
  for (let k = 0; k < n; k++) {
    const off = at + 64 + Number(BigInt("0x" + h.slice(at + 64 + k * 64, at + 128 + k * 64))) * 2;
    const len = Number(BigInt("0x" + h.slice(off, off + 64))) * 2;
    out.push("0x" + h.slice(off + 64, off + 64 + len));
  }
  return out;
}
/// Aerodrome's exactInput((bytes,address,uint256,uint256,uint256)), decoded.
function exactInputOf(call) {
  expect(call.slice(0, 10)).toBe(sel("exactInput((bytes,address,uint256,uint256,uint256))"));
  const h = call.slice(10);
  const t = h.slice(64);      // the tuple, after its own offset word
  const w = (i) => BigInt("0x" + t.slice(i * 64, i * 64 + 64));
  const pathAt = Number(w(0)) * 2;
  const len = Number(BigInt("0x" + t.slice(pathAt, pathAt + 64))) * 2;
  return { path: "0x" + t.slice(pathAt + 64, pathAt + 64 + len), recipient: "0x" + t.slice(64 + 24, 128),
    deadline: w(2), amountIn: w(3), minOut: w(4) };
}
const aeroPath = (hops) => "0x" + [hops[0][0], ...hops.flatMap(([, ts, to]) => [word(ts).slice(-6), to.replace(/^0x/, "")])]
  .map((x) => x.replace(/^0x/, "")).join("").toLowerCase();
const SPCXC_ROWS = [aeroPath([[WETH, 50, USDC], [USDC, 10, SPCXC]]), aeroPath([[WETH, 1, USDC], [USDC, 10, SPCXC]])];
const aeroQuoteAt = async (pathHex, amountIn, block) =>
  wordAt(await rpc("eth_call", [{ to: AERO_QUOTER, data: sel("quoteExactInput(bytes,uint256)") +
    encode([T.bytes, T.uint(256)], [pathHex, amountIn]).slice(2), gas: "0x2dc6c0" }, block]), 0);

// ------------------------------------------------------------------ the page
async function newPage(account, wallet = {}, before, context) {
  const p = context ? await context.newPage() : await browserRef.newPage();
  if (before) await before(p);
  p.on("pageerror", (e) => console.log("PAGE ERROR: " + (e.stack || e.message)));
  const cfg = { forward: true, chainId: "0x2105", account, ...wallet };
  await p.addInitScript({ content: [
    STUB, ";(function () {",
    "  window.ethereum = window.makeWallet(" + JSON.stringify(STATE.rpc) + ", " + JSON.stringify(cfg) + ");",
    "})();",
  ].join("\n") });
  return p;
}
async function createOn(factory, name, symbol) {
  const p = await newPage(OWNER);
  await p.goto("/app.html?" + new URLSearchParams({ rpc: STATE.rpc, factory, lens: APP.lens }).toString());
  await p.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
  await p.evaluate(() => window.CurbApp.connect());
  await expect.poll(() => p.evaluate(() => (window.CurbApp.state.ctx && window.CurbApp.state.ctx.quote || "").length > 0),
    { timeout: 30_000, message: "the form never read the factory" }).toBe(true);
  await p.fill("#nName", name);
  await p.fill("#nSymbol", symbol);
  await p.click("#create");
  await expect(p.locator("#msg")).toContainText("Launched", { timeout: 60_000 });
  const token = await p.evaluate(() => window.CurbApp.state.chainCfg.token);
  await p.close();
  return token;
}
/// AN ENDPOINT OF THE TEST'S OWN NAME FOR THE RUN'S NODE (router.spec.js's):
/// every request goes on to the node except those `answer` takes over.
async function routeEndpoint(p, url, answer) {
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST, OPTIONS" };
  await p.route(new RegExp("^" + url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(/.*)?$"), async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    let body = null;
    try { body = JSON.parse(req.postData() || "null"); } catch { body = null; }
    const own = body && !Array.isArray(body) ? await answer(body) : undefined;
    if (own && own.http) return route.fulfill({ status: own.http, headers: cors, contentType: "application/json", body: "{}" });
    if (own) {
      return route.fulfill({ status: 200, headers: cors, contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id: body.id, ...own }) });
    }
    const res = await fetch(STATE.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: req.postData() });
    return route.fulfill({ status: res.status, headers: cors, contentType: "application/json", body: await res.text() });
  });
}
async function forward(body) {
  const res = await fetch(STATE.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await res.json();
  return j.error ? { error: j.error } : { result: j.result };
}
// ---- THE REWRITERS, each taking the node's answer to a quoter call.
/// Word 0 (amountOut) times num / den.
const scaleOut = (num, den = 100) => (a) => (a.result
  ? { result: "0x" + word((wordAt(a.result, 0) * BigInt(num)) / BigInt(den)) + a.result.slice(66) } : a);
/// The last sqrtPriceX96AfterList entry at MIN_SQRT_RATIO + 1: a partial fill.
const boundAfter = () => (a) => {
  if (!a.result) return a;
  const h = a.result.replace(/^0x/, "");
  const off = Number(wordAt(a.result, 1) / 32n);
  const n = Number(wordAt(a.result, off));
  const i = off + n;
  return { result: "0x" + h.slice(0, i * 64) + word(MIN_SQRT + 1n) + h.slice(i * 64 + 64) };
};
const errorString = (s) => {
  const hex = Buffer.from(s, "utf8").toString("hex");
  return "0x08c379a0" + word(32) + word(hex.length / 2) + hex.padEnd(Math.max(64, Math.ceil(hex.length / 64) * 64), "0");
};
const revertWith = (s) => () => ({ error: { code: 3, message: "execution reverted: " + s, data: errorString(s) } });
const revertEmpty = () => () => ({ error: { code: 3, message: "execution reverted", data: "0x" } });
const http = (status) => () => ({ http: status });

/// THE ROUTE'S STATE, swapped while the page is open: `uni` and `aero` rewrite
/// the two quoters' answers, `getCode(addr, nth)` may answer eth_getCode itself
/// (nth counts that address's reads), `other(body)` anything else.
const routed = () => ({ uni: null, aero: null, getCode: null, other: null, codeReads: {} });
async function routedToken(token, account, R, opts = {}) {
  const p = await newPage(account, opts.wallet || {}, async (q) => {
    await routeEndpoint(q, HOST, async (body) => {
      if (R.other) { const own = await R.other(body); if (own !== undefined) return own; }
      if (body.method === "eth_getCode") {
        const a = String(body.params[0]).toLowerCase();
        R.codeReads[a] = (R.codeReads[a] || 0) + 1;
        if (R.getCode) return R.getCode(a, R.codeReads[a]);
        return undefined;
      }
      if (body.method === "eth_call") {
        const to = String((body.params[0] || {}).to || "").toLowerCase();
        const rw = to === QUOTER_V2 ? R.uni : to === AERO_QUOTER ? R.aero : null;
        if (rw) return rw(await forward(body), body);
      }
      return undefined;
    });
    if (opts.before) await opts.before(q);
  }, opts.context);
  await p.goto("/token/" + token + "?" + new URLSearchParams({ rpc: HOST, lens: APP.lens }).toString());
  await expect(p.locator("#tokenView")).toBeVisible({ timeout: 15_000 });
  await expect(p.locator("#tvStatus")).not.toHaveText("—", { timeout: 30_000 });
  await p.evaluate(() => window.CurbApp.connect());
  await expect.poll(() => p.evaluate(() => ((window.CurbApp.state.viewFor || {}).token || "").toLowerCase()),
    { timeout: 30_000 }).toBe(token.toLowerCase());
  return p;
}
async function cardSide(p, side) {
  const sym = (await p.locator("#tvSym").textContent()).trim().replace(/^\$/, "");
  const tokenPays = (await p.locator("#tvPayAsset").textContent()).trim() === sym;
  if ((side === "sell") !== tokenPays) await p.click("#tvFlip");
}
async function payWith(p, which) {
  const pick = p.locator(".tvAsset.tvPick");
  if (await pick.count() === 0) return;
  const isEth = (await pick.textContent()).trim() === "ETH";
  if (isEth === (which === "eth")) return;
  await pick.click();
  await p.locator(`#tvMenu button[data-choice="${which}"]`).click();
  await expect(p.locator("#tvMenu")).toHaveCount(0);
}
/// An ETH buy on the card, priced: the quote line `line` waited for.
async function ethBuy(p, amount, line, opts = {}) {
  await cardSide(p, "buy");
  await payWith(p, "eth");
  if (opts.slip !== undefined) await p.fill("#tvSlip", String(opts.slip));
  await p.fill("#tvPay", amount);
  if (line) await expect(p.locator("#tvQuote")).toContainText(line, { timeout: 30_000 });
  // A ROUTE'S LINE CAN BE THE LAST AMOUNT'S, STILL ON SCREEN: the quote drawn
  // for THIS amount is waited for too (the press compares against it).
  if ([AERO_LINE, ROUTER_LINE, "Swapped first through Uniswap"].includes(line)) await drawnFor(p, amount);
}
/// The card's quote for `amount`, drawn as the press will compare it.
const drawnFor = (p, amount) => expect.poll(() => p.evaluate((a) => {
  const d = window.CurbApp.drawn;
  return !!d && d.key.split("|")[1] === String(a).toLowerCase();
}, amount), { timeout: 30_000, message: "the quote for " + amount + " was never drawn" }).toBe(true);
const AERO_LINE = "Up to 3 confirmations: Aerodrome swaps your ETH";
const ROUTER_LINE = "1 confirmation: the CURB router";
/// THE QUOTE ON SCREEN, LEFT TO SETTLE: a refresh after the last action can
/// still be drawing it again, and a rewriter armed before that lands would be
/// drawn too. `line` is still there after.
async function settled(p, line) {
  await expect(p.locator("#tvQuote")).toContainText(line, { timeout: 30_000 });
  await drawnFor(p, (await p.locator("#tvPay").inputValue()).trim());
  await expect.poll(() => p.evaluate(() => window.CurbApp.state.busy), { timeout: 30_000 }).toBe(false);
  await wait(1500);
  await expect(p.locator("#tvQuote")).toContainText(line);
}
const clearMsg = (p) => p.evaluate(() => { document.getElementById("msg").textContent = ""; });
/// THE QUOTE ON SCREEN, as the press will compare it.
const drawnNow = (p) => p.evaluate(() => {
  const d = window.CurbApp.drawn;
  return d ? { key: d.key, via: d.via, midMin: String(d.midMin), min: String(d.min) } : null;
});
/// ARMED, THEN PRESSED IN THE SAME TICK OF THE PAGE AS A LOOK AT THE QUOTE ON
/// SCREEN. The card draws again on its own - its heartbeat, a dollar rate
/// landing - and a quote it draws after the market was moved is the new one on
/// screen, rightly the one compared: then nothing is pressed.
/// @return whether it was pressed (and `done` said)
async function armAndPress(p, arm, done) {
  const shown = await drawnNow(p);
  arm();
  await expect(p.locator("#tvAct")).toBeEnabled({ timeout: 30_000 });
  await rpc("evm_mine", []);
  const out = await p.evaluate((s) => {
    const d = window.CurbApp.drawn;
    if (!s || !d || d.key !== s.key || String(d.midMin) !== s.midMin || String(d.min) !== s.min) return "redrawn";
    document.getElementById("msg").textContent = "";
    document.getElementById("tvAct").click();
    return "pressed";
  }, shown);
  if (out !== "pressed") return false;
  await expect(p.locator("#msg")).toContainText(done, { timeout: 120_000 });
  return true;
}
/// A CASE SET UP AGAINST THE QUOTE ON SCREEN, tried again - drawn afresh, for
/// another amount - when the card drew a new one before its press.
async function untilPressed(attempt) {
  for (let i = 0; i < 3; i++) if (await attempt(i)) return;
  throw new Error("the card drew a new quote before every press");
}
const ROUTE_CHANGED = "The price or route changed since the quote was shown. Nothing was sent.";
async function press(p, done = /Done/) {
  await expect(p.locator("#tvAct")).toBeEnabled({ timeout: 30_000 });
  await rpc("evm_mine", []);
  await clearMsg(p);
  await p.click("#tvAct");
  await expect(p.locator("#msg")).toContainText(done, { timeout: 120_000 });
}
const sentCount = (p) => p.evaluate(() => window.ethereum.sent.length);
const sentSince = async (p, n) =>
  (await p.evaluate(() => window.ethereum.sent.map((t) => ({ to: String(t.to || "").toLowerCase(), data: String(t.data || ""), value: t.value || "0x0" }))))
    .slice(n);
async function exactOf(p) {
  const t = await p.locator("#msg").textContent();
  const m = t.match(/exact, in the smallest unit:\s*([\s\S]*)$/);
  expect(m, "the report carries no exact figures").not.toBeNull();
  const out = {};
  for (const part of m[1].split("·")) {
    const mm = part.trim().match(/^(.*?)\s+(\d+)/);
    if (mm) out[mm[1]] = BigInt(mm[2]);
  }
  return out;
}
const whyNow = (p) => p.evaluate(async () => { const r = await window.CurbApp.computeCurveQuote(); return r.error ? "error: " + r.error : r.why; });
const swapRecords = (p) => p.evaluate(() => window.CurbTx.loadPendingAll().filter((t) => t.kind === "eth-swap"));
async function interfereDuringNextSend(p, interfere) {
  await p.evaluate(() => { window.ethereum.cfg.sendDelayMs = 3000; });
  return async () => {
    await expect.poll(() => p.evaluate(() => window.ethereum.inflight), { timeout: 60_000, message: "the page never asked the wallet" }).toBeGreaterThan(0);
    await interfere();
    await p.evaluate(() => { window.ethereum.cfg.sendDelayMs = 0; });
  };
}
/// THE n-TH SEND FROM NOW DECLINED IN THE WALLET (EIP-1193 4001), once.
const declineSend = (p, nth) => p.evaluate((nth) => {
  let n = 0;
  window.ethereum.cfg.onSend = (tx, w) => {
    n += 1;
    w.cfg.sendError = n === nth ? Object.assign(new Error("User rejected the request."), { code: 4001 }) : null;
    if (n > nth) w.cfg.onSend = null;
  };
}, nth);
const unarm = (p) => p.evaluate(() => { window.ethereum.cfg.onSend = null; window.ethereum.cfg.sendError = null; });
/// THE n-TH SEND FROM NOW FAILS IN THE WALLET, not as a decline: it may or may
/// not have gone out (the page cannot tell).
const failSend = (p, nth) => p.evaluate((nth) => {
  let n = 0;
  window.ethereum.cfg.onSend = (tx, w) => {
    n += 1;
    w.cfg.sendError = n === nth ? new Error("the connection to the wallet dropped") : null;
    if (n > nth) w.cfg.onSend = null;
  };
}, nth);
/// THE n-TH SEND FROM NOW GOES OUT AND IS MINED, and the wallet is on another
/// network by the time the page asks for its receipt (its chain read once more
/// as this one, then 0x1): the page's wait ends without one.
const switchAfterSend = (p, nth) => p.evaluate((nth) => {
  let n = 0;
  window.ethereum.cfg.onSend = (tx, w) => {
    n += 1;
    if (n !== nth) return;
    w.cfg.chainIdSequence = [w.cfg.chainId];
    w.cfg.chainId = "0x1";
    w.cfg.onSend = null;
  };
}, nth);
const switchBack = (p) => p.evaluate(() => {
  window.ethereum.cfg.chainId = "0x2105";
  window.ethereum.cfg.chainIdSequence = null;
  window.ethereum.cfg.onSend = null;
});
/// An 8-decimal amount as the card's field takes it.
const dec8 = (x) => { const s = BigInt(x).toString().padStart(9, "0"); return (s.slice(0, -8) + "." + s.slice(-8)).replace(/\.?0+$/, ""); };
/// What the step-1 swap delivered to `who`: SPCXc's Transfers to it since `fromBlock`, by transaction.
async function deliveredTo(asset, who, fromBlock) {
  const logs = await rpc("eth_getLogs", [{ address: asset, topics: [TRANSFER, null, "0x" + pad(who)], fromBlock, toBlock: "latest" }]);
  return logs.map((l) => ({ hash: l.transactionHash, block: l.blockNumber, amount: BigInt(l.data) }));
}

// ------------------------------------------------------------------ the launches
const L = {};
async function spaceLaunch() { if (!L.space) L.space = await createOn(await factoryFor(SPCXC), "Aero Space", "ASP"); return L.space; }
async function btcLaunch() { if (!L.btc) L.btc = await createOn(await factoryFor(CBBTC), "Aero Btc", "ABT"); return L.btc; }
const curveOf = (p) => p.evaluate(() => window.CurbApp.state.view.curve.toLowerCase());

/// SPCXc OF THE BUYER'S OWN, FROM ELSEWHERE: bought on Aerodrome directly,
/// beside the page. What a swap leaves held is then only part of the balance.
/// @return the buyer's SPCXc after
async function spcxcFromElsewhere(p, who, eth) {
  const now = BigInt((await rpc("eth_getBlockByNumber", ["latest", false])).timestamp);
  const data = await p.evaluate(([path, to, d, v]) => window.CurbApp.aeroBuyData(path, to, BigInt(d), BigInt(v), 1n),
    [SPCXC_ROWS[0], who, (now + 600n).toString(), eth.toString()]);
  await sendMined({ from: who, to: AERO_ROUTER, data, value: "0x" + eth.toString(16), gas: "0x" + (3_000_000).toString(16) });
  return balanceOf(SPCXC, who);
}

/// A SWAP LEFT HELD: an Aerodrome buy whose approval is declined in the wallet.
/// @return R, what the swap delivered
async function heldBySwap(p, buyer, amount = "0.1") {
  await ethBuy(p, amount, AERO_LINE);
  const fromBlock = await nextBlock();
  await declineSend(p, 2);
  await press(p, "The swap went through: you hold");
  await unarm(p);
  const got = await deliveredTo(SPCXC, buyer, fromBlock);
  expect(got.length, "the swap delivered nothing").toBe(1);
  await expect(p.locator("#tvHeld")).toBeVisible({ timeout: 30_000 });
  return got[0].amount;
}

// ================================================================== A1 the pins
test("A1 the router, quoter and factory are on the fork with the hashes the page pins, and the path table is frozen and exists", async () => {
  test.setTimeout(120_000);
  const [router, quoter, factory] = await Promise.all([AERO_ROUTER, AERO_QUOTER, AERO_FACTORY].map((a) => rpc("eth_getCode", [a, "latest"])));
  expect(keccakHex(router).toLowerCase(), "the router's code is not the pinned one").toBe(ROUTER_HASH);
  expect(keccakHex(quoter).toLowerCase(), "the quoter's code is not the pinned one").toBe(QUOTER_HASH);
  expect(keccakHex(factory).toLowerCase(), "the factory's code is not the one the router trusts").toBe(FACTORY_HASH);
  // THE IMMUTABLES THE HASHES PIN.
  expect(addrOf(await ethCall(AERO_ROUTER, sel("factory()")))).toBe(AERO_FACTORY);
  expect(addrOf(await ethCall(AERO_ROUTER, sel("WETH9()")))).toBe(WETH);
  expect(addrOf(await ethCall(AERO_QUOTER, sel("factory()")))).toBe(AERO_FACTORY);
  // THE FACTORY CANNOT BE UPGRADED, and the router and the quoter ask it for pools.
  expect(BigInt(await rpc("eth_getStorageAt", [AERO_FACTORY, "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc", "latest"]))).toBe(0n);
  expect(factory.toLowerCase()).not.toContain("63d6f74898");
  expect(factory.toLowerCase()).not.toContain("633659cfe6");
  expect(router.toLowerCase()).toContain("63cefa7799");
  expect(quoter.toLowerCase()).toContain("63cefa7799");

  const p = await newPage(OWNER);
  await p.goto("/app.html?" + new URLSearchParams({ rpc: STATE.rpc, factory: APP.factory, lens: APP.lens }).toString());
  await p.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
  const pins = await p.evaluate(() => {
    const A = window.CurbApp.AERODROME;
    const P = window.CurbApp.AERO_PATHS;
    const frozen = Object.isFrozen(A) && Object.isFrozen(A.router) && Object.isFrozen(A.quoter) && Object.isFrozen(P) &&
      Object.values(P).every((rows) => Object.isFrozen(rows) && rows.every((hops) => Object.isFrozen(hops) && hops.every((h) => Object.isFrozen(h))));
    return { router: A.router, quoter: A.quoter, factory: A.factory, frozen, paths: JSON.parse(JSON.stringify(P)) };
  });
  expect(pins.router.address.toLowerCase()).toBe(AERO_ROUTER);
  expect(pins.router.codehash.toLowerCase()).toBe(ROUTER_HASH);
  expect(pins.quoter.address.toLowerCase()).toBe(AERO_QUOTER);
  expect(pins.quoter.codehash.toLowerCase()).toBe(QUOTER_HASH);
  expect(pins.factory.toLowerCase()).toBe(AERO_FACTORY);
  expect(pins.frozen, "AERO_PATHS is not frozen at every level").toBe(true);
  // THE KEYS ARE EXACTLY THE NINE, each the quoteToken() of a factory here.
  expect(Object.keys(pins.paths).sort()).toEqual(Object.values(NINE).sort());
  for (const asset of Object.values(NINE)) expect(await factoryFor(asset), "no factory prices in " + asset).not.toBeNull();
  // EVERY HOP'S POOL EXISTS, and every path starts at WETH and ends at its key.
  for (const [asset, rows] of Object.entries(pins.paths)) {
    for (const hops of rows) {
      expect(hops[0].from).toBe(WETH);
      expect(hops[hops.length - 1].to).toBe(asset);
      for (const h of hops) {
        const pool = addrOf(await ethCall(AERO_FACTORY, sel("getPool(address,address,int24)") +
          encode([T.address, T.address, T.uint(24)], [h.from, h.to, BigInt(h.ts)]).slice(2)));
        expect(pool, `no pool ${h.from} -${h.ts}-> ${h.to}`).not.toBe("0x" + "0".repeat(40));
      }
    }
  }
  await p.close();
});

// ================================================================== A2 pure functions
test("A2 the rule, the encodings, the quote decode and the step-2 floor, as pure functions", async () => {
  const p = await newPage(OWNER);
  await p.goto("/app.html?" + new URLSearchParams({ rpc: STATE.rpc, factory: APP.factory, lens: APP.lens }).toString());
  await p.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
  const r = await p.evaluate(() => {
    const A = window.CurbApp;
    const E = 10n ** 18n;
    const pick = (amountIn, uni, aero, oneSend) => A.preferAerodrome({ amountIn, uni, aero, oneSend }).why;
    const o = (out, extra = {}) => ({ out, ...extra });
    return {
      // THE MARGIN: 49 bps is not enough, 50 is (1 ETH, so the floor passes).
      margin49: pick(E, o(10000n), o(10049n), true), margin50: pick(E, o(10000n), o(10050n), true),
      // THE FLOOR: a gain worth 0.000499 ETH is not enough, 0.0005 is.
      floorBelow: pick(499n * 10n ** 12n * 100n, o(9900n), o(10000n), true),
      floorAt: pick(5n * 10n ** 14n * 100n, o(9900n), o(10000n), true),
      uniPartial: pick(E, o(5000n, { partial: true }), o(100n), true),
      uniUnreadOne: pick(E, { unread: true }, o(100n), true), uniUnreadNone: pick(E, { unread: true }, o(100n), false),
      noOneSendEqual: pick(E, o(100n), o(100n), false), noOneSendWorse: pick(E, o(101n), o(100n), false),
      aeroPartial: pick(E, o(1n), o(100n, { partial: true }), true), aeroNull: pick(E, o(1n), null, false),
      fwd: A.aeroPathBytes([{ from: "0x" + "11".repeat(20), ts: 50, to: "0x" + "22".repeat(20) },
        { from: "0x" + "22".repeat(20), ts: 10, to: "0x" + "33".repeat(20) }], true),
      back: A.aeroPathBytes([{ from: "0x" + "11".repeat(20), ts: 50, to: "0x" + "22".repeat(20) },
        { from: "0x" + "22".repeat(20), ts: 10, to: "0x" + "33".repeat(20) }], false),
      two: A.aeroBuyData(A.aeroPathBytes(A.AERO_PATHS["0xb2000000000000000000007b9fcbd005511acbd5"][0], true),
        "0x" + "ab".repeat(20), 1234n, 5n * 10n ** 17n, 777n),
      one: A.aeroBuyData(A.aeroPathBytes(A.AERO_PATHS["0xcb585250f852c6c6bf90434ab21a00f02833a4af"][0], true),
        "0x" + "ab".repeat(20), 1234n, 5n * 10n ** 17n, 777n),
      floors: [
        // UNCLAMPED CARD, the curve's own floor lower: the card's amount.
        A.stepTwoFloor({ minIsPrice: false, min: 1000n, minBasis: 50n }, 60n, { out: 900n, offered: 60n, spent: 60n, clamped: false }, 100),
        // UNCLAMPED, the curve's own floor higher: its own.
        A.stepTwoFloor({ minIsPrice: false, min: 1000n, minBasis: 50n }, 60n, { out: 2000n, offered: 60n, spent: 60n, clamped: false }, 100),
        // CLAMPED CARD: its price, scaled to what arrived, rounded up.
        A.stepTwoFloor({ minIsPrice: true, min: 1000n, minBasis: 30n }, 60n, { out: 10n, offered: 60n, spent: 60n, clamped: false }, 100),
      ].map(String),
      // NEVER BELOW THE MINIMUMS SHOWN, on the route shown: each the higher of
      // the two; a price held as a price per unit offered; another route as it is.
      shownFloors: [
        A.floorAtDrawn({ via: "aero", midMin: 90n, min: 900n, minBasis: 90n }, { via: "aero", midMin: 100n, min: 1000n, minBasis: 100n }),
        A.floorAtDrawn({ via: "router", midMin: 110n, min: 1100n, minBasis: 110n }, { via: "router", midMin: 100n, min: 1000n, minBasis: 100n }),
        A.floorAtDrawn({ via: "aero", midMin: 50n, min: 400n, minBasis: 50n, minIsPrice: true }, { via: "aero", midMin: 30n, min: 300n, minBasis: 30n, minIsPrice: true }),
        A.floorAtDrawn({ via: "router", midMin: 90n, min: 900n, minBasis: 90n }, { via: "aero", midMin: 100n, min: 1000n, minBasis: 100n }),
      ].map((x) => [x.midMin, x.min].map(String)),
    };
  });
  expect(r.margin49).toBe("margin");
  expect(r.margin50).toBe("better");
  expect(r.floorBelow).toBe("floor");
  expect(r.floorAt).toBe("better");
  expect(r.uniPartial).toBe("one-step-cannot-fill");
  expect(r.uniUnreadOne).toBe("uni-unread");
  expect(r.uniUnreadNone).toBe("only-route");
  expect(r.noOneSendEqual).toBe("no-one-send");
  expect(r.noOneSendWorse).toBe("uniswap-better");
  expect(r.aeroPartial).toBe("no-aero");
  expect(r.aeroNull).toBe("no-aero");
  expect(r.fwd).toBe("0x" + "11".repeat(20) + "000032" + "22".repeat(20) + "00000a" + "33".repeat(20));
  expect(r.back).toBe("0x" + "33".repeat(20) + "00000a" + "22".repeat(20) + "000032" + "11".repeat(20));
  // THE STEP-1 CALLDATA: its length, and its fields back out of it.
  expect((r.two.length - 2) / 2, "a two-hop step 1 is not 580 bytes").toBe(580);
  expect((r.one.length - 2) / 2, "a one-hop step 1 is not 548 bytes").toBe(548);
  expect(r.two.slice(0, 10)).toBe(sel("multicall(bytes[])"));
  const calls = bytesArray("0x" + r.two.slice(10), 0);
  expect(calls.length).toBe(2);
  expect(calls[1]).toBe(sel("refundETH()"));
  const x = exactInputOf(calls[0]);
  expect(x.path).toBe(SPCXC_ROWS[0]);
  expect(x.recipient).toBe("0x" + "ab".repeat(20));
  expect([x.deadline, x.amountIn, x.minOut]).toEqual([1234n, 5n * 10n ** 17n, 777n]);
  // THE QUOTE DECODE, on crafted answers: a mid price, and a price at the bound.
  const answer = (out, after) => "0x" + word(out) + word(0x80) + word(0xc0) + word(99) + word(1) + word(after) + word(1) + word(3);
  const dec = await p.evaluate(([a, b, c]) => [a, b, c].map((raw) => {
    const d = window.CurbApp.decodeQuote(raw, 1);
    return d ? { out: d.out.toString(), partial: d.partial } : null;
  }), [answer(5, 2n ** 96n), answer(5, MIN_SQRT + 1n), answer(5, 2n ** 96n).slice(0, -192)]);
  expect(dec[0]).toEqual({ out: "5", partial: false });
  expect(dec[1]).toEqual({ out: "5", partial: true });
  expect(dec[2], "an answer cut short was read").toBeNull();
  expect(r.floors).toEqual(["1000", String(slip(2000n, 100)), String((1000n * 60n + 29n) / 30n)]);
  expect(r.shownFloors).toEqual([["100", "1000"], ["110", "1100"], ["50", "500"], ["90", "900"]]);
  await p.close();
});

// ================================================================== A3 a small buy stays one step
test("A3 a small buy stays one confirmation through the CURB router: the gain is under the floor; a price that moved since the quote is sent at the quote's minimums", async () => {
  test.setTimeout(240_000);
  const token = await spaceLaunch();
  const buyer = await freshAccount("small buy");
  const R = routed();
  R.uni = scaleOut(99);
  const p = await routedToken(token, buyer, R);
  await ethBuy(p, "0.01", ROUTER_LINE);
  expect(await whyNow(p)).toBe("floor");
  // UNISWAP 2% WORSE AT THE PRESS, the route the same: the fresh minimums are
  // lower than the ones the card printed, and the card's are what is sent.
  let drawn;
  let before;
  await untilPressed(async (i) => {
    R.uni = scaleOut(99);
    if (i) await ethBuy(p, "0.01" + i, ROUTER_LINE);
    await settled(p, ROUTER_LINE);
    drawn = await drawnNow(p);
    before = await sentCount(p);
    return armAndPress(p, () => { R.uni = scaleOut(97); }, "Done, in one transaction through the CURB router");
  });
  const sent = await sentSince(p, before);
  expect(sent.map((t) => t.to)).toEqual([CURB_ROUTER]);
  const w = argWords(sent[0].data);
  expect(BigInt("0x" + w[3]), "the swap's floor is below the one the card showed").toBe(BigInt(drawn.midMin));
  expect(BigInt("0x" + w[4]), "the curve's floor is below the one the card showed").toBe(BigInt(drawn.min));
  await p.close();
});

// ================================================================== A4 Aerodrome end to end
test("A4 Aerodrome chosen, end to end on the card: swap to the buyer, exact approval, buy with what arrived", async () => {
  test.setTimeout(300_000);
  const token = await spaceLaunch();
  const buyer = await freshAccount("aero end to end");
  const R = routed();
  R.uni = scaleOut(95);
  const p = await routedToken(token, buyer, R);
  await ethBuy(p, "0.5", AERO_LINE);
  await expect(p.locator("#tvActNote")).toHaveText("");
  expect(await whyNow(p)).toBe("better");
  const drawnMin = BigInt(await p.evaluate(() => window.CurbApp.drawn.min.toString()));
  const curve = await curveOf(p);
  const routerUsdc = await balanceOf(USDC, AERO_ROUTER);
  const before = await sentCount(p);
  const fromBlock = await nextBlock();
  await press(p, "Done. You paid");
  await expect(p.locator("#msg")).toContainText("on Aerodrome the route (ETH → WETH → USDC → SPCXc)");
  const sent = await sentSince(p, before);
  expect(sent.length, "the Aerodrome route is not three sends here").toBe(3);
  // [0] STEP 1: ETH as value to the router, multicall(exactInput, refundETH).
  expect(sent[0].to).toBe(AERO_ROUTER);
  expect(BigInt(sent[0].value)).toBe(5n * 10n ** 17n);
  expect(sent[0].data.slice(0, 10)).toBe(sel("multicall(bytes[])"));
  const calls = bytesArray("0x" + sent[0].data.slice(10), 0);
  expect(calls[1]).toBe(sel("refundETH()"));
  const x = exactInputOf(calls[0]);
  expect(SPCXC_ROWS, "the path is not a row of the table").toContain(x.path);
  expect(x.recipient).toBe(buyer.toLowerCase());
  expect(x.amountIn).toBe(5n * 10n ** 17n);
  const got = await deliveredTo(SPCXC, buyer, fromBlock);
  expect(got.length).toBe(1);
  const received = got[0].amount;
  const late = x.deadline - await blockTime(got[0].block);
  expect(late > 480n && late <= 600n, `the deadline is ${late} s past step 1's block`).toBe(true);
  // THE SWAP'S FLOOR IS THE SLIPPAGE OFF THE NODE'S OWN QUOTE at the block before.
  const prior = "0x" + (BigInt(got[0].block) - 1n).toString(16);
  expect(x.minOut).toBe(slip(await aeroQuoteAt(x.path, x.amountIn, prior), 100));
  // [1] AN EXACT APPROVAL FOR WHAT ARRIVED; [2] THE BUY WITH IT.
  expect(sent[1].to).toBe(SPCXC);
  expect(sent[1].data).toBe(sel("approve(address,uint256)") + pad(curve) + word(received));
  expect(sent[2].to).toBe(curve);
  const w = argWords(sent[2].data);
  expect(sent[2].data.slice(0, 10)).toBe(sel("buy(uint256,uint256,address)"));
  expect(BigInt("0x" + w[0])).toBe(received);
  expect(BigInt("0x" + w[1]) >= drawnMin, "step 2's floor is below the card's minimum").toBe(true);
  expect(addrOf(w[2])).toBe(buyer.toLowerCase());
  // THE CHAIN.
  const cb = await rpc("eth_getLogs", [{ address: curve, topics: [CURVE_BUY], fromBlock, toBlock: "latest" }]);
  expect(cb.length).toBe(1);
  expect(wordAt(cb[0].data, 0)).toBe(received);
  expect(await balanceOf(token, buyer)).toBe(wordAt(cb[0].data, 1));
  expect(await balanceOf(SPCXC, buyer), "SPCXc was left with the buyer").toBe(0n);
  expect(await ethOf(AERO_ROUTER), "ETH was left on Aerodrome's router").toBe(0n);
  expect(await balanceOf(USDC, AERO_ROUTER), "USDC was left on Aerodrome's router").toBe(routerUsdc);
  expect(await swapRecords(p), "the swap's record outlived the buy").toEqual([]);
  const ex = await exactOf(p);
  expect(ex.paid).toBe(5n * 10n ** 17n);
  expect(ex.swapped).toBe(received);
  expect(ex.in).toBe(wordAt(cb[0].data, 0));
  expect(ex.out).toBe(wordAt(cb[0].data, 1));
  expect(ex.fee).toBe(wordAt(cb[0].data, 2));
  expect(ex.tax).toBe(wordAt(cb[0].data, 3));
  await p.close();
});

// ================================================================== A5 cannot fill, cannot read
test("A5 a Uniswap leg that cannot fill takes Aerodrome; one that cannot be read refuses, with nothing sent", async () => {
  test.setTimeout(300_000);
  const token = await spaceLaunch();
  const buyer = await freshAccount("cannot fill");
  const R = routed();
  R.uni = boundAfter();
  const p = await routedToken(token, buyer, R);
  await ethBuy(p, "0.05", AERO_LINE);
  expect(await whyNow(p)).toBe("one-step-cannot-fill");
  let before = await sentCount(p);
  await press(p, "Done. You paid");
  let sent = await sentSince(p, before);
  expect(sent[0].to).toBe(AERO_ROUTER);
  // UNREAD: the CURB router is usable, so no three confirmations on a failed read.
  R.uni = http(503);
  await p.fill("#tvPay", "0.051");
  await expect(p.locator("#tvQuote")).toContainText("The ETH route could not be priced just now. Try again in a moment, or pay with SPCXc.", { timeout: 30_000 });
  await expect(p.locator("#tvQuote")).not.toContainText("Up to 3 confirmations");
  await expect(p.locator("#tvAct")).toBeDisabled();
  before = await sentCount(p);
  expect(await sentCount(p)).toBe(before);
  await p.close();
});

// ================================================================== A6 Aerodrome not usable
test("A6 with Aerodrome not usable - a partial answer, the quoter's code gone, other code at the router - the buy is one send through the CURB router", async () => {
  test.setTimeout(400_000);
  const token = await spaceLaunch();
  const one = async (label, prepare) => {
    const buyer = await freshAccount("not usable " + label);
    const R = routed();
    R.uni = scaleOut(95);
    if (prepare) await prepare(R);
    const p = await routedToken(token, buyer, R);
    await ethBuy(p, "0.1", ROUTER_LINE, { slip: 7 });
    expect(await whyNow(p), label).toBe("no-aero");
    const before = await sentCount(p);
    await press(p, "Done, in one transaction through the CURB router");
    expect((await sentSince(p, before)).map((t) => t.to), label).toEqual([CURB_ROUTER]);
    await p.close();
  };
  await one("partial", async (R) => { R.aero = boundAfter(); });
  await inSnapshot(async () => {
    await rpc("anvil_setCode", [AERO_QUOTER, "0x"]);
    await one("no quoter");
  });
  await inSnapshot(async () => {
    await rpc("anvil_setCode", [AERO_ROUTER, "0x00"]);
    await one("other router code");
  });
});

// ================================================================== A7 the press against the drawn quote
test("A7 the press sends another route than the one shown only when it needs no more confirmations and has no lower minimum", async () => {
  test.setTimeout(480_000);
  const token = await spaceLaunch();
  const buyer = await freshAccount("drawn quote");
  const R = routed();
  // (a) DRAWN AS THE ROUTER; Aerodrome wins at the press with a HIGHER
  // minimum: only its confirmations refuse it.
  const p = await routedToken(token, buyer, R);
  let before;
  await untilPressed(async (i) => {
    R.uni = scaleOut(120);
    R.aero = null;
    await ethBuy(p, "0.10" + i, ROUTER_LINE, { slip: 5 });
    await settled(p, ROUTER_LINE);
    before = await sentCount(p);
    return armAndPress(p, () => { R.aero = scaleOut(150); }, ROUTE_CHANGED);
  });
  expect(await sentCount(p)).toBe(before);
  // AND ONCE AERODROME IS THE QUOTE ON SCREEN, it is sent.
  R.aero = null;
  R.uni = scaleOut(50);
  await ethBuy(p, "0.104", AERO_LINE, { slip: 5 });
  await settled(p, AERO_LINE);
  await press(p, "Done. You paid");
  expect((await sentSince(p, before)).map((t) => t.to)).toEqual([AERO_ROUTER, SPCXC, await curveOf(p)]);
  // (b) DRAWN AS AERODROME at 15%; the router wins at the press with a higher
  // minimum and fewer confirmations: one send.
  await untilPressed(async (i) => {
    R.uni = scaleOut(95);
    await p.fill("#tvSlip", "15");
    await p.fill("#tvPay", "0.11" + i);
    await settled(p, AERO_LINE);
    before = await sentCount(p);
    return armAndPress(p, () => { R.uni = scaleOut(110); }, "Done, in one transaction through the CURB router");
  });
  expect((await sentSince(p, before)).map((t) => t.to)).toEqual([CURB_ROUTER]);
  // (c) DRAWN AS AERODROME; the router wins at the press with a LOWER minimum.
  await untilPressed(async (i) => {
    R.uni = scaleOut(95);
    R.aero = scaleOut(110);
    await p.fill("#tvSlip", "1");
    await p.fill("#tvPay", "0.12" + i);
    await settled(p, AERO_LINE);
    before = await sentCount(p);
    return armAndPress(p, () => { R.uni = scaleOut(100); R.aero = scaleOut(50); }, ROUTE_CHANGED);
  });
  expect(await sentCount(p)).toBe(before);
  // (d) DRAWN AS AERODROME; Aerodrome cannot be read at the press, and the
  // router's fresh minimum is HIGHER: only the unread Aerodrome refuses it.
  await untilPressed(async (i) => {
    R.uni = scaleOut(95);
    R.aero = null;
    await p.fill("#tvPay", "0.13" + i);
    await settled(p, AERO_LINE);
    return armAndPress(p, () => { R.aero = http(503); R.uni = scaleOut(110); }, ROUTE_CHANGED);
  });
  expect(await sentCount(p)).toBe(before);
  // (e) NO QUOTE ON SCREEN for these fields, and the press would take Aerodrome.
  R.aero = null;
  R.uni = scaleOut(95);
  await p.fill("#tvPay", "0.14");
  await settled(p, AERO_LINE);
  await p.evaluate(() => window.CurbApp.noteDrawn(null));
  await press(p, ROUTE_CHANGED);
  expect(await sentCount(p)).toBe(before);
  // (f) THE ROUTE SHOWN, AT A WORSE PRICE: Aerodrome's pool 3% worse at the
  // press. Still Aerodrome (Uniswap is 5% worse), and sent - at the minimums
  // the card printed, not 1% off the fresh quote.
  let drawn;
  await untilPressed(async (i) => {
    R.aero = null;
    await p.fill("#tvPay", "0.15" + i);
    await settled(p, AERO_LINE);
    drawn = await drawnNow(p);
    return armAndPress(p, () => { R.aero = scaleOut(97); }, "Done. You paid");
  });
  const sent = await sentSince(p, before);
  expect(sent.map((t) => t.to)).toEqual([AERO_ROUTER, SPCXC, await curveOf(p)]);
  const x = exactInputOf(bytesArray("0x" + sent[0].data.slice(10), 0)[0]);
  expect(x.minOut, "step 1's floor is below the \"at least\" the card showed").toBe(BigInt(drawn.midMin));
  expect(BigInt("0x" + argWords(sent[2].data)[1]) >= BigInt(drawn.min), "step 2's floor is below the card's minimum").toBe(true);
  // (g) THE CARD'S QUOTE IS THE ONE COMPARED. The card draws the router; then
  // the page's hidden long-page quote is priced again (as every refresh does)
  // while Uniswap is halved, and finds Aerodrome. A press while the card still
  // says the router is refused - not sent through Aerodrome under it.
  let outcome = "redrawn";
  for (let attempt = 0; attempt < 3 && outcome === "redrawn"; attempt++) {
    R.aero = null;
    R.uni = scaleOut(120);
    await p.fill("#tvSlip", "5");
    await p.fill("#tvPay", "0.16" + attempt);
    await settled(p, ROUTER_LINE);
    before = await sentCount(p);
    R.uni = scaleOut(50);
    await rpc("evm_mine", []);
    // PRICED AND PRESSED IN ONE TICK OF THE PAGE, while the card still shows
    // the router: its own heartbeat may redraw it meanwhile, and then it is
    // tried again.
    outcome = await p.evaluate(async () => {
      await window.CurbApp.renderCurveQuote();
      if (!document.getElementById("tvQuote").textContent.includes("1 confirmation: the CURB router")) return "redrawn";
      document.getElementById("msg").textContent = "";
      document.getElementById("tvAct").click();
      return "pressed";
    });
  }
  expect(outcome, "the card was redrawn under every attempt").toBe("pressed");
  await expect(p.locator("#msg")).toContainText("The price or route changed since the quote was shown. Nothing was sent.", { timeout: 120_000 });
  expect(await sentCount(p)).toBe(before);
  await p.close();
});

// ================================================================== A8 the router's code, again
test("A8 the router's code is read again right before step 1: gone, and nothing is sent", async () => {
  test.setTimeout(240_000);
  const token = await spaceLaunch();
  const buyer = await freshAccount("router gone");
  const R = routed();
  R.uni = scaleOut(95);
  const p = await routedToken(token, buyer, R);
  await ethBuy(p, "0.1", AERO_LINE);
  await settled(p, AERO_LINE);
  const base = R.codeReads[AERO_ROUTER] || 0;
  R.getCode = (a, n) => (a === AERO_ROUTER && n === base + 2 ? { result: "0x" } : undefined);
  const eth = await ethOf(buyer);
  const before = await sentCount(p);
  await press(p, "This swap was not sent: Aerodrome's swap router is not deployed on this network. Nothing was sent.");
  expect(R.codeReads[AERO_ROUTER], "the router's code was not read twice after the press").toBe(base + 2);
  expect(await sentCount(p)).toBe(before);
  expect(await ethOf(buyer)).toBe(eth);
  await p.close();
});

// ================================================================== A9 refusals in words
test("A9 Aerodrome's refusals, met in the simulation, are said in words and the wallet is never asked", async () => {
  test.setTimeout(300_000);
  const token = await spaceLaunch();
  const buyer = await freshAccount("refusals");
  const R = routed();
  R.uni = scaleOut(95);
  const p = await routedToken(token, buyer, R);
  const before = await sentCount(p);
  const cases = [
    [revertWith("Too little received"), "Aerodrome would refuse this swap: it would deliver less than your slippage allows. Nothing was sent."],
    [revertEmpty(), "Aerodrome would refuse this swap: it gave no reason (a passed deadline gives none). Nothing was sent."],
    [revertWith("TF"), "Aerodrome would refuse this swap: a pool on the route could not pay out"],
  ];
  let amount = 100;
  for (const [answer, words] of cases) {
    R.other = null;
    await ethBuy(p, "0." + amount++, AERO_LINE);
    await settled(p, AERO_LINE);
    R.other = (b) => (b.method === "eth_call" && String((b.params[0] || {}).to || "").toLowerCase() === AERO_ROUTER ? answer() : undefined);
    await press(p, words);
    expect(await sentCount(p), "the wallet was asked").toBe(before);
  }
  await p.close();
});

// ================================================================== A10 the buyer, before step 1
test("A10 without the CURB router, a buyer the issuer restricts is refused before any step, with nothing sent", async () => {
  test.setTimeout(300_000);
  const token = await spaceLaunch();
  await inSnapshot(async () => {
    await rpc("anvil_setCode", [CURB_ROUTER, "0x"]);
    const buyer = await freshAccount("restricted buyer");
    const admin = await issuerAdmin(SPCXC);
    await admin.block(buyer);
    expect(await admin.authorized(buyer)).toBe(false);
    const R = routed();
    R.uni = scaleOut(95);
    const p = await routedToken(token, buyer, R);
    const before = await sentCount(p);
    await ethBuy(p, "0.5", "has restricted this account");
    await expect(p.locator("#tvAct")).toBeDisabled();
    expect(await sentCount(p)).toBe(before);
    await p.close();
  });
});

// ================================================================== A11 the executor gate
test("A11 when the issuer does not let Aerodrome's router pull the asset, the route is not offered: the CURB router, one send", async () => {
  test.setTimeout(300_000);
  const token = await spaceLaunch();
  await inSnapshot(async () => {
    const admin = await issuerAdmin(SPCXC, "TRANSFER_EXECUTOR_POLICY()");
    await admin.block(AERO_ROUTER);
    expect(await admin.authorized(AERO_ROUTER)).toBe(false);
    const buyer = await freshAccount("executor gate");
    const R = routed();
    R.uni = scaleOut(95);
    const p = await routedToken(token, buyer, R);
    await ethBuy(p, "0.1", ROUTER_LINE, { slip: 7 });
    expect(await whyNow(p)).toBe("no-aero");
    const before = await sentCount(p);
    await press(p, "Done, in one transaction through the CURB router");
    expect((await sentSince(p, before)).map((t) => t.to)).toEqual([CURB_ROUTER]);
    await p.close();
  });
});

// ================================================================== A12 without the CURB router
test("A12 without the CURB router, Aerodrome is taken when it is not worse, and the UniversalRouter two-step otherwise", async () => {
  test.setTimeout(400_000);
  const token = await spaceLaunch();
  await withoutCurbRouter(async () => {
    const buyer = await freshAccount("no router aero");
    const R = routed();
    R.uni = scaleOut(99);
    const p = await routedToken(token, buyer, R);
    await ethBuy(p, "0.01", AERO_LINE);
    await expect(p.locator("#tvQuote")).toContainText("Not through the CURB router");
    expect(await whyNow(p)).toBe("no-one-send");
    let before = await sentCount(p);
    await press(p, "Done. You paid");
    expect((await sentSince(p, before)).map((t) => t.to)).toEqual([AERO_ROUTER, SPCXC, await curveOf(p)]);
    // UNISWAP BETTER: the UniversalRouter two-step, its deadline on the chain's clock.
    R.uni = scaleOut(105);
    await ethBuy(p, "0.011", "Swapped first through Uniswap", { slip: 10 });
    expect(await whyNow(p)).toBe("uniswap-better");
    before = await sentCount(p);
    const fromBlock = await nextBlock();
    await press(p, "Done. You paid");
    const sent = await sentSince(p, before);
    expect(sent[0].to).toBe(UNIVERSAL_ROUTER);
    const got = await deliveredTo(SPCXC, buyer, fromBlock);
    const late = BigInt("0x" + argWords(sent[0].data)[2]) - await blockTime(got[0].block);
    expect(late > 480n && late <= 600n, `the UniversalRouter deadline is ${late} s past its block`).toBe(true);
    await p.close();
  });
});

// ================================================================== A13 partial Uniswap legs
test("A13 a Uniswap leg that cannot fill is refused at the quote, with the CURB router and without it", async () => {
  test.setTimeout(300_000);
  const token = await spaceLaunch();
  await withoutAerodrome(async () => {
    const buyer = await freshAccount("partial uniswap");
    const R = routed();
    R.uni = boundAfter();
    const partial = "Uniswap cannot swap this much ETH into SPCXc in full. Nothing is sent - pay with SPCXc instead, or use a smaller amount.";
    let p = await routedToken(token, buyer, R);
    await ethBuy(p, "0.05", partial);
    await expect(p.locator("#tvAct")).toBeDisabled();
    expect(await sentCount(p)).toBe(0);
    await p.close();
    await withoutCurbRouter(async () => {
      p = await routedToken(token, buyer, R);
      await ethBuy(p, "0.05", partial);
      await expect(p.locator("#tvAct")).toBeDisabled();
      expect(await sentCount(p)).toBe(0);
      await p.close();
    });
  });
});

// ================================================================== A14 held -> Buy with it
test("A14 step 2 declined: the asset is held, said, recorded and shown, and Buy with it spends it", async () => {
  test.setTimeout(480_000);
  const token = await spaceLaunch();
  // (a) AERODROME.
  const buyer = await freshAccount("held buy with it");
  const R = routed();
  R.uni = scaleOut(95);
  const p = await routedToken(token, buyer, R);
  const held = await heldBySwap(p, buyer);
  const msg = await p.locator("#msg").textContent();
  expect(msg).not.toContain("Nothing was sent");
  expect(msg).not.toContain("was expected");
  const recs = await swapRecords(p);
  expect(recs.length).toBe(1);
  expect(BigInt(recs[0].held)).toBe(held);
  expect(recs[0].venue).toBe("aerodrome");
  await expect(p.locator("#tvHeld")).toContainText("Sell it back");
  await p.locator("#tvHeld button[data-held-buy]").click();
  await expect(p.locator("#tvPayAsset")).toHaveText("SPCXc");
  expect(BigInt(Math.round(Number(await p.locator("#tvPay").inputValue()) * 1e8))).toBe(held);
  const before = await sentCount(p);
  await press(p, "Done. The curve gave you");
  expect((await sentSince(p, before)).length).toBeLessThanOrEqual(2);
  await expect.poll(() => swapRecords(p), { timeout: 30_000 }).toEqual([]);
  expect(await balanceOf(SPCXC, buyer)).toBe(0n);
  await expect(p.locator("#tvHeld")).toBeHidden({ timeout: 30_000 });
  await p.close();

  // (b) THE UNIVERSALROUTER TWO-STEP on cbBTC, not a row: Buy with it, no Sell it back.
  const btc = await btcLaunch();
  await withoutCurbRouter(async () => {
    const b2 = await freshAccount("held cbbtc");
    const q = await routedToken(btc, b2, routed());
    await cardSide(q, "buy");
    await payWith(q, "eth");
    await q.fill("#tvPay", "0.01");
    await expect(q.locator("#tvQuote")).toContainText("Swapped first through Uniswap", { timeout: 30_000 });
    await declineSend(q, 2);
    await press(q, "The swap went through: you hold");
    await unarm(q);
    const r2 = await swapRecords(q);
    expect(r2.length).toBe(1);
    expect(r2[0].venue).toBe("uniswap");
    await expect(q.locator("#tvHeld")).toContainText("Buy with it", { timeout: 30_000 });
    await expect(q.locator("#tvHeld")).not.toContainText("Sell it back");
    await q.close();
  });

  // (c) NOTHING STORED: the message's own Buy with it still carries R.
  const b3 = await freshAccount("held unstored");
  const s = await routedToken(token, b3, R);
  await s.evaluate(() => {
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (String(k).startsWith("curb.launch.pending.v3:")) throw new Error("QuotaExceededError");
      return real.call(this, k, v);
    };
  });
  await ethBuy(s, "0.1", AERO_LINE);
  const fromBlock = await nextBlock();
  await declineSend(s, 2);
  await press(s, "The swap went through: you hold");
  await unarm(s);
  expect(await swapRecords(s)).toEqual([]);
  const r3 = (await deliveredTo(SPCXC, b3, fromBlock))[0].amount;
  await s.locator("#msg button[data-held-buy]").click();
  await expect(s.locator("#tvPayAsset")).toHaveText("SPCXc");
  expect(BigInt(Math.round(Number(await s.locator("#tvPay").inputValue()) * 1e8))).toBe(r3);
  await s.close();
});

// ================================================================== A15 a reload across step 1
test("A15 a reload while step 1 is unmined: a second press is refused, the mined swap is held after the reload, launch.html leaves it", async () => {
  test.setTimeout(480_000);
  const token = await spaceLaunch();
  const buyer = await freshAccount("reload");
  const R = routed();
  R.uni = scaleOut(95);
  const context = await browserRef.newContext();
  try {
    let p = await routedToken(token, buyer, R, { context });
    await ethBuy(p, "0.1", AERO_LINE);
    const fromBlock = await nextBlock();
    const n = await sentCount(p);
    await rpc("evm_setAutomine", [false]);
    try {
      await clearMsg(p);
      await p.click("#tvAct");
      await expect.poll(() => sentCount(p), { timeout: 60_000 }).toBeGreaterThan(n);
      await p.close();
      // A SECOND PAGE'S PRESS: the swap is not accounted for yet.
      const q = await routedToken(token, buyer, R, { context });
      await ethBuy(q, "0.1", AERO_LINE);
      await clearMsg(q);
      await q.click("#tvAct");
      await expect(q.locator("#msg")).toContainText("There is already a transaction for this", { timeout: 60_000 });
      expect(await sentCount(q)).toBe(0);
      await q.close();
    } finally {
      await rpc("evm_mine", []);
      await rpc("evm_setAutomine", [true]);
    }
    const got = await deliveredTo(SPCXC, buyer, fromBlock);
    expect(got.length).toBe(1);
    p = await routedToken(token, buyer, R, { context });
    await expect(p.locator("#tvHeld")).toContainText("You hold", { timeout: 30_000 });
    const recs = await swapRecords(p);
    expect(recs.length).toBe(1);
    expect(BigInt(recs[0].held)).toBe(got[0].amount);
    await p.close();
    // LAUNCH.HTML ON THE SAME LAUNCH LEAVES THE RECORD.
    const l = await newPage(buyer, {}, null, context);
    await l.addInitScript({ content: "localStorage.setItem('curb.launch.addrs', " +
      JSON.stringify(JSON.stringify({ rpc: STATE.rpc, lens: APP.lens, token })) + ");" });
    await l.goto("/launch.html");
    await l.waitForFunction(() => !!window.CurbLaunch, null, { timeout: 8_000 });
    await wait(5000);
    expect((await swapRecords(l)).length, "launch.html settled the swap's record away").toBe(1);
    await l.close();
    // AND BUY WITH IT IS NOT REFUSED. The tab closed mid-send left its claim to
    // be preparing this launch, which stands for three minutes (tx-core.js
    // PREPARE_TTL_MS) - the closed-tab rule, not this one - so it is taken as
    // having run out.
    p = await routedToken(token, buyer, R, { context });
    await p.evaluate(() => localStorage.removeItem("curb.launch.preparing"));
    await expect(p.locator("#tvHeld")).toBeVisible({ timeout: 30_000 });
    await p.locator("#tvHeld button[data-held-buy]").click();
    await expect(p.locator("#tvPayAsset")).toHaveText("SPCXc");
    await press(p, "Done. The curve gave you");
    await expect.poll(() => swapRecords(p), { timeout: 30_000 }).toEqual([]);
    await p.close();
  } finally {
    await context.close();
  }
});

// ================================================================== A16 step 1 replaced
test("A16 a sped-up step 1 is held by what the replacement delivered; a cancelled one is cleared", async () => {
  test.setTimeout(480_000);
  const token = await spaceLaunch();
  const R = routed();
  R.uni = scaleOut(95);
  /// Presses, lets the page go with step 1 unmined, and replaces it at its nonce.
  const replaced = async (label, replacement) => {
    const buyer = await freshAccount("replaced " + label);
    const context = await browserRef.newContext();
    try {
      let p = await routedToken(token, buyer, R, { context });
      await ethBuy(p, "0.1", AERO_LINE);
      const n = await sentCount(p);
      const fromBlock = await nextBlock();
      await rpc("evm_setAutomine", [false]);
      let rec;
      try {
        await clearMsg(p);
        await p.click("#tvAct");
        await expect.poll(() => sentCount(p), { timeout: 60_000 }).toBeGreaterThan(n);
        await expect.poll(async () => { const r = await swapRecords(p); return r.length === 1 && !!r[0].sentNonce; },
          { timeout: 30_000, message: "the swap's record never carried its nonce" }).toBe(true);
        rec = (await swapRecords(p))[0];
        await p.close();
        const orig = await rpc("eth_getTransactionByHash", [rec.hash]);
        await rpc("anvil_dropTransaction", [rec.hash]);
        await rpc("eth_sendTransaction", [replacement(buyer, orig)]);
      } finally {
        await rpc("evm_mine", []);
        await rpc("evm_setAutomine", [true]);
      }
      expect(await rpc("eth_getTransactionReceipt", [rec.hash]), "the original was mined").toBeNull();
      p = await routedToken(token, buyer, R, { context });
      return { p, buyer, rec, fromBlock, context };
    } catch (e) { await context.close(); throw e; }
  };
  // SPED UP: the same calldata at the same nonce, a higher fee.
  let r = await replaced("speed up", (buyer, o) => ({ from: buyer, to: o.to, data: o.input, value: o.value, nonce: o.nonce,
    gas: o.gas, gasPrice: "0x" + (BigInt(o.gasPrice || o.maxFeePerGas) * 2n).toString(16) }));
  try {
    const got = await deliveredTo(SPCXC, r.buyer, r.fromBlock);
    expect(got.length).toBe(1);
    await expect(r.p.locator("#tvHeld")).toContainText("You hold", { timeout: 30_000 });
    const recs = await swapRecords(r.p);
    expect(recs.length).toBe(1);
    expect(BigInt(recs[0].held)).toBe(got[0].amount);
    expect(recs[0].replacedBy).toBe(got[0].hash);
  } finally { await r.context.close(); }
  // CANCELLED: a 0-value send to itself at that nonce.
  r = await replaced("cancel", (buyer, o) => ({ from: buyer, to: buyer, value: "0x0", nonce: o.nonce,
    gasPrice: "0x" + (BigInt(o.gasPrice || o.maxFeePerGas) * 2n).toString(16) }));
  try {
    await expect.poll(() => swapRecords(r.p), { timeout: 30_000 }).toEqual([]);
    await expect(r.p.locator("#tvHeld")).toBeHidden();
  } finally { await r.context.close(); }
});

// ================================================================== A17 held-row safety
test("A17 the held row: a lagging endpoint keeps the record and still refuses an ETH buy, the asset gone clears it, an ETH buy is refused while holding, Dismiss clears it", async () => {
  test.setTimeout(480_000);
  const token = await spaceLaunch();
  const buyer = await freshAccount("held safety");
  const R = routed();
  R.uni = scaleOut(95);
  const p = await routedToken(token, buyer, R);
  const held = await heldBySwap(p, buyer);
  // (c) AN ETH BUY WHILE HOLDING: refused, nothing sent.
  await ethBuy(p, "0.12", AERO_LINE);
  const before = await sentCount(p);
  await press(p, "from an earlier swap for this launch. Nothing was sent. Press Buy with it to use it, or Dismiss it to pay with ETH again.");
  expect(await sentCount(p)).toBe(before);
  // (a) THE ASSET MOVED AWAY, BUT THE ENDPOINT IS BEHIND THE SWAP'S BLOCK: kept.
  const recs = await swapRecords(p);
  const heldBlock = BigInt(recs[0].heldBlock);
  const sink = await freshAccount("held safety sink");
  await sendMined({ from: buyer, to: SPCXC, data: sel("transfer(address,uint256)") + pad(sink) + word(held) });
  R.other = (b) => (b.method === "eth_blockNumber" ? { result: "0x" + (heldBlock - 1n).toString(16) } : undefined);
  await p.evaluate(() => window.CurbApp.renderHeld());
  await expect(p.locator("#tvHeld")).toContainText("You hold", { timeout: 30_000 });
  expect((await swapRecords(p)).length, "a lagging endpoint cleared the record").toBe(1);
  // (a2) AND THE PRESS ASKS AT SUCH A BLOCK TOO: behind the swap, the balance
  // it would read is the one from before it, 0 - and an ETH buy went out on
  // that, a second step 1 while the first one's asset was held.
  await ethBuy(p, "0.121", AERO_LINE);
  const lagged = await sentCount(p);
  await press(p, "from an earlier swap for this launch. Nothing was sent.");
  expect(await sentCount(p), "a lagging endpoint let a second swap through").toBe(lagged);
  // (b) CAUGHT UP: the balance is 0 at a block past the swap's - hidden, cleared.
  R.other = null;
  await p.evaluate(() => window.CurbApp.renderHeld());
  await expect(p.locator("#tvHeld")).toBeHidden({ timeout: 30_000 });
  expect(await swapRecords(p)).toEqual([]);
  // (d) DISMISS.
  await heldBySwap(p, buyer, "0.13");
  await p.locator("#tvHeld button[data-held-dismiss]").click();
  await expect(p.locator("#tvHeld")).toBeHidden({ timeout: 30_000 });
  expect(await swapRecords(p)).toEqual([]);
  expect(await balanceOf(SPCXC, buyer) > 0n, "Dismiss moved the asset").toBe(true);
  await p.close();
});

// ================================================================== A18 sell it back
test("A18 Sell it back: an exact approval, then the swap back and the unwrap; a refused sale leaves the approval, and Revoke takes it back", async () => {
  test.setTimeout(480_000);
  const token = await spaceLaunch();
  const buyer = await freshAccount("sell back");
  const R = routed();
  R.uni = scaleOut(95);
  const p = await routedToken(token, buyer, R);
  const held = await heldBySwap(p, buyer);
  // (b) THE SALE'S SIMULATION REFUSES: the approval stands, and Revoke is offered.
  R.other = (b) => (b.method === "eth_call" && String((b.params[0] || {}).to || "").toLowerCase() === AERO_ROUTER
    ? revertWith("IW")() : undefined);
  let before = await sentCount(p);
  await clearMsg(p);
  await p.locator("#tvHeld button[data-held-sell]").click();
  await expect(p.locator("#msg")).toContainText("Aerodrome's router may now move exactly", { timeout: 120_000 });
  await expect(p.locator("#msg")).toContainText("it would pay less ETH than your slippage allows");
  await expect(p.locator("#msg")).toContainText("Nothing else was sent.");
  R.other = null;
  let sent = await sentSince(p, before);
  expect(sent.map((t) => t.data)).toEqual([sel("approve(address,uint256)") + pad(AERO_ROUTER) + word(held)]);
  expect(await allowanceOf(SPCXC, buyer, AERO_ROUTER)).toBe(held);
  await p.locator("#msg button[data-held-revoke]").click();
  await expect(p.locator("#msg")).toContainText("Revoked: Aerodrome's router may no longer move your SPCXc.", { timeout: 120_000 });
  expect(await allowanceOf(SPCXC, buyer, AERO_ROUTER)).toBe(0n);
  // (a) SOLD BACK.
  await expect(p.locator("#tvHeld")).toBeVisible({ timeout: 30_000 });
  before = await sentCount(p);
  const fromBlock = await nextBlock();
  const eth0 = await ethOf(buyer);
  await clearMsg(p);
  await p.locator("#tvHeld button[data-held-sell]").click();
  await expect(p.locator("#msg")).toContainText("on Aerodrome.", { timeout: 120_000 });
  sent = await sentSince(p, before);
  expect(sent.length).toBe(2);
  expect(sent[0].data).toBe(sel("approve(address,uint256)") + pad(AERO_ROUTER) + word(held));
  expect(sent[1].to).toBe(AERO_ROUTER);
  const calls = bytesArray("0x" + sent[1].data.slice(10), 0);
  const x = exactInputOf(calls[0]);
  expect(x.path).toContain(SPCXC.slice(2));
  expect(x.path.slice(-40)).toBe(WETH.slice(2));
  expect(x.recipient).toBe(AERO_ROUTER);
  expect(x.amountIn).toBe(held);
  expect(calls[1].slice(0, 10)).toBe(sel("unwrapWETH9(uint256,address)"));
  expect(addrOf(calls[1].slice(10 + 64, 10 + 128))).toBe(buyer.toLowerCase());
  const wd = (await rpc("eth_getLogs", [{ address: WETH, topics: [WITHDRAWAL, "0x" + pad(AERO_ROUTER)], fromBlock, toBlock: "latest" }]));
  expect(wd.length).toBe(1);
  const paid = BigInt(wd[0].data);
  const approveLog = await rpc("eth_getLogs", [{ address: SPCXC, fromBlock, toBlock: "latest" }]);
  const hashes = [...new Set([...approveLog.map((l) => l.transactionHash), wd[0].transactionHash])];
  let gas = 0n;
  for (const h of hashes) gas += await costOf(h);
  expect(await ethOf(buyer) - eth0 + gas, "the ETH received is not the Withdrawal's").toBe(paid);
  expect(await balanceOf(SPCXC, buyer)).toBe(0n);
  expect(await allowanceOf(SPCXC, buyer, AERO_ROUTER)).toBe(0n);
  await expect.poll(() => swapRecords(p), { timeout: 30_000 }).toEqual([]);
  const ex = await exactOf(p);
  expect(ex.sold).toBe(held);
  expect(ex.received).toBe(paid);
  await p.close();
});

// ================================================================== A19 graduation blocked between the steps
test("A19 the issuer blocks the Graduator between the steps: step 2 is refused with the graduation words, the asset is held, and Sell it back works", async () => {
  test.setTimeout(480_000);
  const token = await spaceLaunch();
  await inSnapshot(async () => {
    const graduator = addrOf(await ethCall(await factoryFor(SPCXC), sel("graduator()")));
    const admin = await issuerAdmin(SPCXC);
    const buyer = await freshAccount("graduation between");
    const R = routed();
    R.uni = scaleOut(95);
    const p = await routedToken(token, buyer, R);
    await ethBuy(p, "0.1", AERO_LINE);
    const meddle = await interfereDuringNextSend(p, () => admin.block(graduator));
    await rpc("evm_mine", []);
    await clearMsg(p);
    await p.click("#tvAct");
    await meddle();
    await expect(p.locator("#msg")).toContainText("The swap went through: you hold", { timeout: 120_000 });
    await expect(p.locator("#msg")).toContainText("This launch could not graduate");
    expect((await swapRecords(p)).length).toBe(1);
    await expect(p.locator("#tvHeld")).toBeVisible({ timeout: 30_000 });
    await clearMsg(p);
    await p.locator("#tvHeld button[data-held-sell]").click();
    await expect(p.locator("#msg")).toContainText("on Aerodrome.", { timeout: 120_000 });
    expect(await balanceOf(SPCXC, buyer)).toBe(0n);
    await p.close();
  });
});

// ================================================================== A20 a threshold refund is held
test("A20 a buy the threshold clamps: not sent on another route at the press; the curve's refund is held, on the long page too; and step 2's floor is the card's price scaled to what arrived", async () => {
  test.setTimeout(600_000);
  await inSnapshot(async () => {
    const factory = await factoryFor(SPCXC);
    const token = await createOn(factory, "Aero Full", "AFL");
    const curve = addrOf("0x" + (await ethCall(APP.lens, sel("launchState(address)") + pad(token))).slice(2 + 64, 2 + 128));
    const buyer = await freshAccount("clamped buyer");
    const filler = await freshAccount("clamped filler");
    const R = routed();
    R.uni = scaleOut(95);
    // ONE CONTEXT, so the long page at the end reads the same records.
    const context = await browserRef.newContext();
    const p = await routedToken(token, buyer, R, { context });
    // WHAT THE BUYER'S 0.5 ETH WOULD DELIVER, and the curve filled to about half of it.
    const half = (await aeroQuoteAt(SPCXC_ROWS[0], 5n * 10n ** 17n, "latest")) / 2n;
    const fill = async () => {
      const [res, fee, tax, sellable] = await Promise.all([
        ethCall(curve, sel("getReserves()")), ethCall(curve, sel("feeBps()")), ethCall(curve, sel("creatorTaxBps()")),
        ethCall(curve, sel("sellableTokens()"))]);
      return BigInt(await p.evaluate(([q, t, f, x, s]) => window.CurbApp.quoteBuy(10n ** 40n, { quote: BigInt(q), token: BigInt(t) },
        { fee: BigInt(f), tax: BigInt(x) }, BigInt(s)).spent.toString(),
      [wordAt(res, 0).toString(), wordAt(res, 1).toString(), BigInt(fee).toString(), BigInt(tax).toString(), BigInt(sellable).toString()]));
    };
    const whole = await fill();
    const F = whole - half;
    // THE FILLER'S SPCXc, BOUGHT ON AERODROME, then spent on the curve.
    const now = BigInt((await rpc("eth_getBlockByNumber", ["latest", false])).timestamp);
    const perEth = await aeroQuoteAt(SPCXC_ROWS[0], 10n ** 18n, "latest");
    const ethIn = (F * 10n ** 18n * 12n) / (perEth * 10n);
    expect(ethIn < 90n * 10n ** 18n, "filling this curve takes more ETH than the filler has").toBe(true);
    const data = await p.evaluate(([path, to, d, v]) => window.CurbApp.aeroBuyData(path, to, BigInt(d), BigInt(v), 1n),
      [SPCXC_ROWS[0], filler, (now + 600n).toString(), ethIn.toString()]);
    await sendMined({ from: filler, to: AERO_ROUTER, data, value: "0x" + ethIn.toString(16), gas: "0x" + (3_000_000).toString(16) });
    expect(await balanceOf(SPCXC, filler) >= F, "the filler's ETH did not buy enough SPCXc to fill the curve").toBe(true);
    await sendMined({ from: filler, to: SPCXC, data: sel("approve(address,uint256)") + pad(curve) + word(F) });
    await sendMined({ from: filler, to: curve, data: sel("buy(uint256,uint256,address)") + word(F) + word(1) + pad(filler),
      gas: "0x" + (12_000_000).toString(16) });
    await p.evaluate(() => window.CurbApp.refresh(true));
    // A CLAMPED QUOTE IS NOT TAKEN ON ANOTHER ROUTE: the CURB router wins at the
    // press with fewer confirmations and a higher minimum, and is refused only
    // because the threshold clamps the buy - its minimum is a price.
    let n0;
    await untilPressed(async (i) => {
      R.uni = scaleOut(95);
      await ethBuy(p, "0.5" + "0".repeat(i), AERO_LINE);
      expect(await p.evaluate(() => window.CurbApp.drawn.clamped), "the card's quote is not a clamped one").toBe(true);
      await settled(p, AERO_LINE);
      n0 = await sentCount(p);
      return armAndPress(p, () => { R.uni = scaleOut(200); }, ROUTE_CHANGED);
    });
    expect(await sentCount(p)).toBe(n0);
    R.uni = scaleOut(95);
    await ethBuy(p, "0.5000", AERO_LINE);
    await settled(p, AERO_LINE);
    await expect(p.locator("#tvQuote")).toContainText("Refunded (past the threshold):");
    await expect(p.locator("#tvQuote")).not.toContainText("in the same transaction");
    const drawn = await p.evaluate(() => ({ min: window.CurbApp.drawn.min.toString(), clamped: window.CurbApp.drawn.clamped }));
    expect(drawn.clamped, "the card's quote is not a clamped one").toBe(true);
    const before = await sentCount(p);
    const fromBlock = await nextBlock();
    await press(p, "The curve refunded");
    const sent = await sentSince(p, before);
    expect(sent.length).toBe(3);
    const x = exactInputOf(bytesArray("0x" + sent[0].data.slice(10), 0)[0]);
    const received = (await deliveredTo(SPCXC, buyer, fromBlock))[0].amount;
    const refund = await rpc("eth_getLogs", [{ address: curve, topics: [CURVE_REFUND], fromBlock, toBlock: "latest" }]);
    expect(refund.length).toBe(1);
    const R2 = BigInt(refund[0].data);
    expect(R2 > 0n).toBe(true);
    const recs = await swapRecords(p);
    expect(recs.length).toBe(1);
    expect(BigInt(recs[0].held)).toBe(R2);
    await expect(p.locator("#tvHeld")).toContainText("You hold", { timeout: 30_000 });
    await expect(p.locator("#tvHeld")).toContainText("Sell it back");
    // STEP 2'S FLOOR: the card's price (its minimum per minimum offered), scaled up to what arrived.
    const min2 = BigInt("0x" + argWords(sent[2].data)[1]);
    const card = (BigInt(drawn.min) * received + x.minOut - 1n) / x.minOut;
    expect(min2 >= card, `step 2's floor ${min2} is under the card's price ${card}`).toBe(true);
    // AND ON THE LONG PAGE, where the curve has closed: the held row is not
    // inside the curve's box, which is hidden past the threshold.
    const lp = await newPage(buyer, {}, (q) => routeEndpoint(q, HOST, async () => undefined), context);
    await lp.goto("/app.html?" + new URLSearchParams({ rpc: HOST, factory, lens: APP.lens, token }).toString());
    await lp.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
    await lp.evaluate(() => window.CurbApp.connect());
    await expect.poll(() => lp.evaluate(() => (window.CurbApp.state.view || {}).status), { timeout: 30_000 }).toBeGreaterThan(1);
    await expect(lp.locator("#heldRow")).toBeVisible({ timeout: 30_000 });
    await expect(lp.locator("#heldRow")).toContainText("You hold");
    await expect(lp.locator("#heldRow")).toContainText("Sell it back");
    await context.close();
  });
});

// ================================================================== A21 Chainlink on the route
test("A21 the Aerodrome route is checked against Chainlink: refused past half, strongly warned past 15%, and unchecked sends nothing", async () => {
  test.setTimeout(300_000);
  const token = await spaceLaunch();
  const buyer = await freshAccount("chainlink");
  const R = routed();
  R.uni = scaleOut(30);
  R.aero = scaleOut(40);
  let p = await routedToken(token, buyer, R);
  await ethBuy(p, "0.1", "less than the market price (Chainlink)");
  await expect(p.locator("#tvAct")).toBeDisabled();
  R.aero = scaleOut(75);
  await p.fill("#tvPay", "0.101");
  await expect(p.locator("#tvQuote")).toContainText(AERO_LINE, { timeout: 30_000 });
  await expect(p.locator("#tvQuote")).toContainText("VERY COSTLY CONVERSION");
  await p.close();
  // THE FEED REFUSED FROM THE START: nothing kept to stand in, so unchecked.
  R.uni = scaleOut(95);
  R.aero = null;
  R.other = (b) => (b.method === "eth_call" && String((b.params[0] || {}).to || "").toLowerCase() === ETH_FEED
    ? { error: { code: -32005, message: "over rate limit" } } : undefined);
  p = await routedToken(token, buyer, R);
  await ethBuy(p, "0.1", AERO_LINE);
  await expect(p.locator("#tvQuote .tvConvUnchecked")).toHaveText("Conversion: not checked against Chainlink", { timeout: 30_000 });
  const before = await sentCount(p);
  await press(p, "could not be checked against Chainlink's price");
  expect(await sentCount(p)).toBe(before);
  await p.close();
});

// ================================================================== A22 the create form
test("A22 the create form refuses Aerodrome's router as the creator wallet", async () => {
  const p = await newPage(OWNER);
  await p.goto("/app.html?" + new URLSearchParams({ rpc: STATE.rpc, factory: APP.factory, lens: APP.lens }).toString());
  await p.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
  await p.evaluate(() => window.CurbApp.connect());
  await expect(p.locator("#sumGrad")).not.toHaveText("—", { timeout: 30_000 });
  const advanced = p.locator("#advanced");
  if (!(await advanced.evaluate((d) => d.open))) await advanced.locator("summary").click();
  await p.fill("#nName", "Aero Payee");
  await p.fill("#nSymbol", "APY");
  const before = await sentCount(p);
  await p.fill("#nCreator", "0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F");
  await p.click("#create");
  await expect(p.locator("#msg")).toContainText("The creator wallet is Aerodrome's swap router", { timeout: 30_000 });
  expect(await sentCount(p)).toBe(before);
  await p.close();
});

// ================================================================== A23 the long page
test("A23 the long page: the routed-on-Aerodrome row and its note, the same three sends, and the clamp's words", async () => {
  test.setTimeout(300_000);
  const token = await spaceLaunch();
  const buyer = await freshAccount("long page");
  const R = routed();
  R.uni = scaleOut(95);
  const lp = await newPage(buyer, {}, (q) => routeEndpoint(q, HOST, async (body) => {
    if (body.method === "eth_call" && String((body.params[0] || {}).to || "").toLowerCase() === QUOTER_V2) {
      return R.uni(await forward(body), body);
    }
    return undefined;
  }));
  await lp.goto("/app.html?" + new URLSearchParams({ rpc: HOST, factory: await factoryFor(SPCXC), lens: APP.lens, token }).toString());
  await lp.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
  await lp.evaluate(() => window.CurbApp.connect());
  await lp.selectOption("#curveSide", "buy");
  await lp.selectOption("#curveVia", "eth");
  await lp.fill("#curveAmount", "0.1");
  await lp.evaluate(() => window.CurbApp.refresh(true));
  await expect(lp.locator("#curveQuote .row", { hasText: "routed on Aerodrome: ETH → WETH → USDC → SPCXc" })).toHaveCount(1, { timeout: 30_000 });
  await expect(lp.locator("#curveQuote")).toContainText("Up to 3 confirmations: the swap on Aerodrome, then the curve buy.");
  const before = await sentCount(lp);
  await rpc("evm_mine", []);
  await lp.evaluate(() => { document.getElementById("msg").textContent = ""; });
  await lp.click("#curveAct");
  await expect(lp.locator("#msg")).toContainText("Done. You paid", { timeout: 120_000 });
  const curve = (await lp.evaluate(() => window.CurbApp.state.view.curve)).toLowerCase();
  expect((await sentSince(lp, before)).map((t) => t.to)).toEqual([AERO_ROUTER, SPCXC, curve]);
  // A CLAMPED AERODROME QUOTE COMES BACK WITH THE CURVE BUY, not "in the same transaction".
  const words = await lp.evaluate(() => window.CurbApp.clampWords({ via: "aero", q: { spent: 5n, offered: 9n, refund: 4n } },
    { quoteDecimals: 8, quoteSym: "SPCXc", quote: "0xb2000000000000000000007b9fcbd005511acbd5" }, "SPCXc"));
  expect(words).toContain("It comes back to you as SPCXc with the curve buy.");
  expect(words).not.toContain("same transaction");
  await lp.close();
});

// ================================================================== A24 beside other units of the asset
test("A24 a buyer who holds other SPCXc: what a swap left is spent exactly - by Buy with it, Sell it back, and a step 2 or a sale whose wait ended without a receipt - and a swap the page has not yet seen held refuses nothing", async () => {
  test.setTimeout(900_000);
  const token = await spaceLaunch();
  const buyer = await freshAccount("other units");
  const R = routed();
  R.uni = scaleOut(95);
  const p = await routedToken(token, buyer, R);
  // THE BUYER'S OWN SPCXc, from elsewhere: the balance never reads 0 below,
  // so nothing but the records' own bookkeeping can clear them.
  const own = await spcxcFromElsewhere(p, buyer, 2n * 10n ** 16n);
  expect(own > 0n).toBe(true);
  const settledHeld = async (label) => {
    await expect.poll(() => p.evaluate(() => window.CurbTx.loadPendingAll().filter((t) => t.kind === "eth-swap" || t.spendsHeld).length),
      { timeout: 60_000, message: label + ": a record of what the swap left outlived its spending" }).toBe(0);
    await expect(p.locator("#tvHeld"), label).toBeHidden({ timeout: 30_000 });
    expect(await balanceOf(SPCXC, buyer), label + ": the buyer's own SPCXc moved").toBe(own);
  };

  // (a) A SWAP MINED BUT NOT YET SEEN HELD - step 1's wait ended, and the
  // chain mined it since - is judged held at the next press, which goes on.
  // Made so once the resume after the swap has run, which would otherwise
  // judge it first.
  const runs = await p.evaluate(() => window.CurbApp.state.resumeRuns);
  const r1 = await heldBySwap(p, buyer);
  await expect.poll(() => p.evaluate(() => window.CurbApp.state.resumeRuns), { timeout: 60_000 }).toBeGreaterThan(runs);
  await p.evaluate(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith("curb.launch.pending.v3:")) continue;
      const t = JSON.parse(localStorage.getItem(k));
      if (t.kind !== "eth-swap") continue;
      delete t.held; delete t.heldAt; delete t.heldBlock;
      localStorage.setItem(k, JSON.stringify(t));
    }
  });
  expect((await swapRecords(p)).map((t) => t.held)).toEqual([undefined]);
  await payWith(p, "asset");
  await p.fill("#tvPay", dec8(r1));
  await expect(p.locator("#tvQuote")).toContainText("Minimum received", { timeout: 30_000 });
  await press(p, "Done. The curve gave you");
  await settledHeld("Buy with it");

  // (b) SOLD BACK: exactly what the swap left.
  await heldBySwap(p, buyer, "0.13");
  await clearMsg(p);
  await p.locator("#tvHeld button[data-held-sell]").click();
  await expect(p.locator("#msg")).toContainText("on Aerodrome.", { timeout: 120_000 });
  await settledHeld("Sell it back");

  // (c) STEP 2 SENT, ITS WAIT ENDED WITHOUT A RECEIPT (the wallet on another
  // network meanwhile), and mined: not "not made", no buttons for what it is
  // spending - and its record takes what it spent off the swap's.
  await ethBuy(p, "0.14", AERO_LINE);
  await switchAfterSend(p, 3);
  await press(p, "The curve buy with it was sent but is not mined yet");
  await switchBack(p);
  await expect(p.locator("#msg")).not.toContainText("was not made");
  await expect(p.locator("#msg button[data-held-buy], #msg button[data-held-sell]")).toHaveCount(0);
  await settledHeld("step 2 mined after its wait");

  // (d) THE SAME FOR A SALE BACK, after its approval.
  await heldBySwap(p, buyer, "0.15");
  await switchAfterSend(p, 2);
  await clearMsg(p);
  await p.locator("#tvHeld button[data-held-sell]").click();
  await expect(p.locator("#msg")).toContainText("was sent but is not mined yet", { timeout: 120_000 });
  await switchBack(p);
  await expect(p.locator("#msg")).not.toContainText("The sale was not made");
  await expect(p.locator("#msg button[data-held-revoke]")).toHaveCount(0);
  await settledHeld("a sale mined after its wait");

  // (e) STEP 2 MAYBE SENT: the wallet failed, not declined. Said as the
  // wallet's uncertainty, with no buttons to spend it again.
  await ethBuy(p, "0.16", AERO_LINE);
  await failSend(p, 3);
  await press(p, "IT IS NOT CERTAIN NOTHING WAS BROADCAST");
  await unarm(p);
  await expect(p.locator("#msg")).toContainText("The swap went through: you hold");
  await expect(p.locator("#msg")).not.toContainText("was not made");
  await expect(p.locator("#msg button[data-held-buy], #msg button[data-held-sell]")).toHaveCount(0);
  await p.close();
});

// ================================================================== A25 ETH for the later steps
test("A25 a two-step ETH buy keeps ETH back for its later steps: an account with the amount and not the gas after it is refused before step 1, on Aerodrome and on the UniversalRouter", async () => {
  test.setTimeout(400_000);
  const token = await spaceLaunch();
  const buyer = await freshAccount("gas for later");
  const R = routed();
  R.uni = scaleOut(95);
  /// The buy priced, then the account left with the amount and 0.0001 ETH -
  /// under the 0.0003 ETH kept back - and pressed.
  const short = async (p, amount, line, opts) => {
    await ethBuy(p, amount, line, opts);
    const left = BigInt(Math.round(Number(amount) * 1e6)) * 10n ** 12n + 10n ** 14n;
    await rpc("anvil_setBalance", [buyer, "0x" + left.toString(16)]);
    const before = await sentCount(p);
    await press(p, "and its later steps need gas; this account holds");
    expect(await sentCount(p), "a send went out").toBe(before);
    expect(await ethOf(buyer), "ETH moved").toBe(left);
    await rpc("anvil_setBalance", [buyer, "0x" + (100n * 10n ** 18n).toString(16)]);
  };
  let p = await routedToken(token, buyer, R);
  await short(p, "0.1", AERO_LINE);
  await p.close();
  await withoutCurbRouter(async () => {
    R.uni = scaleOut(105);
    p = await routedToken(token, buyer, R);
    await short(p, "0.011", "Swapped first through Uniswap", { slip: 10 });
    await p.close();
  });
});

// ================================================================== A26 Buy with it, to the last unit
test("A26 Buy with it fills what is held to the last unit, on an 18-decimal asset too", async () => {
  const p = await newPage(OWNER);
  await p.goto("/app.html?" + new URLSearchParams({ rpc: STATE.rpc, factory: await factoryFor(WETH), lens: APP.lens }).toString());
  await p.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
  await p.evaluate(() => window.CurbApp.connect());
  await expect.poll(() => p.evaluate(() => ((window.CurbApp.state.ctx || {}).quote || "").toLowerCase()), { timeout: 30_000 }).toBe(WETH);
  // THE BUTTON A HELD MESSAGE CARRIES, for an amount of an 18-decimal asset
  // past eight places: filled to the wei.
  await p.evaluate((weth) => {
    const b = document.createElement("button");
    b.type = "button";
    b.id = "heldProbe";
    b.setAttribute("data-held-buy", "1234567890123456789");
    b.setAttribute("data-held-asset", weth);
    document.body.append(b);
    b.click();
  }, WETH);
  await expect(p.locator("#curveAmount")).toHaveValue("1.234567890123456789");
  await p.close();
});
