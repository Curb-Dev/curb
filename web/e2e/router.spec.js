// THE CURB ROUTER, AS THE SWAP CARD USES IT (the owner's call, 2026-10-01: "too
// many confirmations - people may misread it; fewer would be better").
//
// What these tests pin, each against the chain rather than against the page:
//   - an ETH buy on a curve is ONE send on every pair: the WETH pair, NVDAc
//     (one hop from WETH), and SPCXc and GOOGLc (two hops, through USDC);
//   - the first ETH sale of a token is TWO sends - an unlimited approval to the
//     router, then sellForEth - and the next sale of it is ONE;
//   - the bounds the page signs are the slippage off fresh quotes, and none of
//     them is zero; a slippage that would make one zero is refused;
//   - what the page reports is what the router's own event says, which is what
//     reached the account - shown by moving the price while the wallet dialog
//     is open, so the quote and the result differ;
//   - and where the router cannot be used - no code at its address, other code
//     there, or an issuer that refuses it - nothing is sent to it, and the
//     flows from before it run, with a note saying why.
// Every trade is real: the wallet stub forwards to the run's own fork, where the
// harness deployed the router with script/DeployRouter.s.sol.
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

const STATE = JSON.parse(fs.readFileSync(path.join(__dirname, ".state.json"), "utf8"));
const STUB = fs.readFileSync(path.join(__dirname, "..", "wallet-stub.js"), "utf8");
const APP = STATE.app;
const OWNER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const WETH = "0x4200000000000000000000000000000000000006";
const NVDAC = "0xb20000000000000000000078ee7ce2fe4908108c";
const SPCXC = "0xb2000000000000000000007b9fcbd005511acbd5";
const GOOGLC = "0xb2000000000000000000002d0ba3164cc74f58b7";
const CBBTC = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf";
const CBXRP = "0xcb585250f852c6c6bf90434ab21a00f02833a4af";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const UNIVERSAL_ROUTER = "0x6ff5693b99212da76ad316178a184ab56d299b43";
const SWAP_ROUTER02 = "0x2626664c2603336e57b271c5c0b26f421741e481";
const QUOTER_V2 = "0x3d4e44eb1374240ce5f1b871ab261cd16335b76a";
const POLICY_REGISTRY = "0x8453000000000000000000000000000000000002";
// WRITTEN HERE, NOT READ FROM app.js: the first test holds the page's copy
// against these and against the chain.
const ROUTER = "0xea20c3266229a01cd0f45d9c7921a45d5b359561";
const CODEHASH = "0x25814dde01efddddcc582ba476471c80ce6de85154d1ee6a357f28cb67b37c5e";
const MAX = (1n << 256n) - 1n;
const SHOTS = process.env.CURB_SHOTS || "";

test.describe.configure({ mode: "serial" });

let browserRef;
test.beforeAll(async ({ browser }) => { browserRef = browser; });

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
/// The first block after the latest one: where a search for what the next
/// transaction did starts, so the last one's logs are not counted with it.
const nextBlock = async () => "0x" + (BigInt(await rpc("eth_blockNumber", [])) + 1n).toString(16);
const ethOf = async (who) => BigInt(await rpc("eth_getBalance", [who, "latest"]));
const BOUGHT = keccak("BoughtWithEth(address,address,address,address,uint256,uint256,uint256,uint256,uint256)");
const CURVE_BUY = keccak("CurveBuy(address,address,uint256,uint256,uint256,uint256)");
const TRANSFER = keccak("Transfer(address,address,uint256)");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/// A TRANSACTION THE NODE SIGNS, WAITED FOR TO ITS RECEIPT AND REFUSED UNLESS IT
/// SUCCEEDED. eth_sendTransaction's hash alone is not the state it changes: two
/// tests read that state straight after and, about one run in twenty, still saw
/// the old one (review, round 2).
async function sendMined(tx) {
  const hash = await rpc("eth_sendTransaction", [tx]);
  for (let i = 0; i < 200; i++) {
    const r = await rpc("eth_getTransactionReceipt", [hash]);
    if (r) { expect(r.status, "this transaction reverted: " + hash).toBe("0x1"); return r; }
    await wait(100);
  }
  throw new Error("never mined: " + hash);
}
/// THE NODE STILL MINES, quickly: a plain transfer, given ten seconds. A quote
/// that keeps the node simulating holds its state, and nothing mines meanwhile.
async function nodeStillMines(what) {
  const t0 = Date.now();
  const done = await Promise.race([
    sendMined({ from: OWNER, to: OWNER, value: "0x0" }).then(() => true),
    wait(10_000).then(() => false),
  ]);
  expect(done, "after " + what + ", a plain transfer did not mine within 10 s: the node is held").toBe(true);
  return Date.now() - t0;
}
/// The block a log was mined in, and that block's own clock.
const blockTime = async (blockNumber) => BigInt((await rpc("eth_getBlockByNumber", [blockNumber, false])).timestamp);

/// AN ENDPOINT OF ITS OWN NAME FOR THE RUN'S NODE, served through Playwright:
/// every request goes on to the node except those `answer` takes over, which
/// returns { result } or { error } for a JSON-RPC answer, { http } for an HTTP
/// failure, or undefined to pass the request on.
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
const isGetCodeOfRouter = (b) => b.method === "eth_getCode" && String(b.params[0]).toLowerCase() === ROUTER;
const isCallToRouter = (b) => b.method === "eth_call" && String((b.params[0] || {}).to || "").toLowerCase() === ROUTER;
const SOLD = keccak("SoldForEth(address,address,address,address,uint256,uint256,uint256,bool)");

/// A FRESH ACCOUNT OF ITS OWN: no code (the well-known keys carry EIP-7702
/// delegations on Base), the node signing for it, and plenty of ether.
async function freshAccount(label) {
  const a = "0x" + keccak("curb router.spec " + label).slice(-40);
  expect(await rpc("eth_getCode", [a, "latest"]), "the account has code on this chain").toBe("0x");
  await rpc("anvil_impersonateAccount", [a]);
  await rpc("anvil_setBalance", [a, "0x" + (100n * 10n ** 18n).toString(16)]);
  return a;
}

/// What the transaction that emitted `log` cost its sender in ether: gas, and
/// the L1 fee where the node charges one.
async function costOf(hash) {
  const r = await rpc("eth_getTransactionReceipt", [hash]);
  return BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice) + (r.l1Fee ? BigInt(r.l1Fee) : 0n);
}

/// The router's event of one kind since `fromBlock`, decoded.
async function routerEvents(topic0, fromBlock) {
  const logs = await rpc("eth_getLogs", [{ address: ROUTER, topics: [topic0], fromBlock, toBlock: "latest" }]);
  return logs.map((l) => ({ log: l, who: addrOf(l.topics[1]), token: addrOf(l.topics[2]), data: l.data }));
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

// ------------------------------------------------------------------ the page
async function newPage(account, wallet = {}, before) {
  const p = await browserRef.newPage();
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
async function openToken(token, account, opts = {}) {
  const p = await newPage(account, {}, opts.before);
  await p.goto("/token/" + token + "?" + new URLSearchParams({ rpc: opts.rpc || STATE.rpc, lens: APP.lens }).toString());
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
/// The quote side in ETH or in the pair's asset, chosen on its chip.
async function payWith(p, which) {
  const pick = p.locator(".tvAsset.tvPick");
  if (await pick.count() === 0) return;
  const isEth = (await pick.textContent()).trim() === "ETH";
  if (isEth === (which === "eth")) return;
  await pick.click();
  await p.locator(`#tvMenu button[data-choice="${which}"]`).click();
  await expect(p.locator("#tvMenu")).toHaveCount(0);
}
/// The card set for a trade and priced, the button not pressed yet.
async function setUp(p, side, amount, opts = {}) {
  await cardSide(p, side);
  await payWith(p, opts.with || "eth");
  if (opts.slip !== undefined) await p.fill("#tvSlip", String(opts.slip));
  if (/%$/.test(amount)) {
    await expect.poll(async () => (await p.locator("#tvPayAvail").textContent()).trim().length, { timeout: 30_000 }).toBeGreaterThan(0);
    await p.click(`#tvPcts [data-pct="${parseInt(amount, 10)}"]`);
  } else await p.fill("#tvPay", amount);
  await expect(p.locator("#tvAct")).toHaveText(new RegExp("^" + (side === "buy" ? "Buy" : "Sell") + " \\$"), { timeout: 20_000 });
}
/// THE LAST RESULT IS CLEARED FIRST, so the one waited for is this trade's.
const clearMsg = (p) => p.evaluate(() => { document.getElementById("msg").textContent = ""; });
async function press(p, done = /Done/) {
  await expect(p.locator("#tvAct")).toBeEnabled({ timeout: 30_000 });
  // AN EMPTY BLOCK FIRST. The wallet stub lets the node estimate the gas, and
  // anvil estimates at the latest block's timestamp: when the last swap through
  // a v3 pool was in that very block, the estimate leaves out the oracle write
  // the next block's first swap makes, and the swap runs out of gas on chain.
  // A real wallet adds a margin; this keeps the estimate's block a fresh one.
  await rpc("evm_mine", []);
  await clearMsg(p);
  await p.click("#tvAct");
  await expect(p.locator("#msg")).toContainText(done, { timeout: 120_000 });
}
const sentCount = (p) => p.evaluate(() => window.ethereum.sent.length);
const sentSince = async (p, n) =>
  (await p.evaluate(() => window.ethereum.sent.map((t) => ({ to: String(t.to || "").toLowerCase(), data: String(t.data || ""), value: t.value || "0x0" }))))
    .slice(n);
/// The exact figures the page's report carries, by label.
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
/// The words of a sent call after its selector.
const argWords = (data) => { const h = data.replace(/^0x/, "").slice(8); const w = []; for (let i = 0; i < h.length; i += 64) w.push(h.slice(i, i + 64)); return w; };
/// A dynamic `bytes` argument at word `i` of a call's arguments.
function bytesArg(data, i) {
  const h = data.replace(/^0x/, "").slice(8);
  const off = Number(BigInt("0x" + h.slice(i * 64, i * 64 + 64))) * 2;
  const len = Number(BigInt("0x" + h.slice(off, off + 64))) * 2;
  return "0x" + h.slice(off + 64, off + 64 + len);
}

/// THE CURVE'S OWN PRICING AT A BLOCK, through the page's quoteBuy/quoteSell -
/// the same arithmetic, the chain's numbers at the block before the trade.
async function curveAt(p, curve, block) {
  const [res, fee, tax, sellable] = await Promise.all([
    ethCall(curve, sel("getReserves()"), block), ethCall(curve, sel("feeBps()"), block),
    ethCall(curve, sel("creatorTaxBps()"), block), ethCall(curve, sel("sellableTokens()"), block),
  ]);
  return { quote: wordAt(res, 0).toString(), token: wordAt(res, 1).toString(), fee: BigInt(fee).toString(),
    tax: BigInt(tax).toString(), sellable: BigInt(sellable).toString() };
}
const pageQuoteBuy = (p, c, offered) => p.evaluate(([c, offered]) => window.CurbApp.quoteBuy(BigInt(offered),
  { quote: BigInt(c.quote), token: BigInt(c.token) }, { fee: BigInt(c.fee), tax: BigInt(c.tax) }, BigInt(c.sellable)).out.toString(),
  [c, offered.toString()]).then(BigInt);
const pageQuoteSell = (p, c, tokens) => p.evaluate(([c, tokens]) => window.CurbApp.quoteSell(BigInt(tokens),
  { quote: BigInt(c.quote), token: BigInt(c.token) }, { fee: BigInt(c.fee), tax: BigInt(c.tax) }).out.toString(),
  [c, tokens.toString()]).then(BigInt);
const quoterAt = async (pathHex, amountIn, block) =>
  wordAt(await ethCall(QUOTER_V2, sel("quoteExactInput(bytes,uint256)") + encode([T.bytes, T.uint(256)], [pathHex, amountIn]).slice(2), block), 0);

// ------------------------------------------------------------------ the launches
const L = {};
async function wethLaunch() { if (!L.weth) L.weth = await createOn(await factoryFor(WETH), "Router Weth", "RWE"); return L.weth; }
async function nvdaLaunch() { if (!L.nvda) L.nvda = await createOn(APP.factory, "Router Nvda", "RNV"); return L.nvda; }
async function spaceLaunch() { if (!L.space) L.space = await createOn(await factoryFor(SPCXC), "Router Space", "RSP"); return L.space; }
async function googlLaunch() { if (!L.googl) L.googl = await createOn(await factoryFor(GOOGLC), "Router Googl", "RGO"); return L.googl; }
async function btcLaunch() { if (!L.btc) L.btc = await createOn(await factoryFor(CBBTC), "Router Btc", "RBT"); return L.btc; }
const curveOf = (p) => p.evaluate(() => window.CurbApp.state.view.curve);
const registryOf = async (factory) => addrOf(await ethCall(factory, sel("registry()")));

/// A TRADE OF SOMEBODY ELSE'S, MINED WHILE THIS PAGE'S WALLET DIALOG IS OPEN:
/// the price moves between the page's last quote and its transaction, so a
/// report taken from the quote and one taken from the chain differ.
async function interfereDuringNextSend(p, interfere) {
  await p.evaluate(() => { window.ethereum.cfg.sendDelayMs = 3000; });
  return async () => {
    await expect.poll(() => p.evaluate(() => window.ethereum.inflight), { timeout: 60_000, message: "the page never asked the wallet" }).toBeGreaterThan(0);
    await interfere();
    await p.evaluate(() => { window.ethereum.cfg.sendDelayMs = 0; });
  };
}

// ================================================================== the router is there
test("the run's fork carries the CURB router at the address the page pins, with the code hash it pins", async () => {
  const code = await rpc("eth_getCode", [ROUTER, "latest"]);
  expect(code, "no code at the router's address: the harness did not deploy it").not.toBe("0x");
  expect(keccakHex(code).toLowerCase(), "the router on the fork is not the reviewed one").toBe(CODEHASH);
  const p = await newPage(OWNER);
  await p.goto("/app.html?" + new URLSearchParams({ rpc: STATE.rpc, factory: APP.factory, lens: APP.lens }).toString());
  await p.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
  const pinned = await p.evaluate(() => window.CurbApp.CURB_ROUTER);
  expect(pinned.address.toLowerCase()).toBe(ROUTER);
  expect(pinned.codehash.toLowerCase()).toBe(CODEHASH);
  await p.close();
});

// ================================================================== one confirmation to buy
test("an ETH buy on the WETH pair is one send to the router, and the report is the router's event, not the quote", async () => {
  test.setTimeout(240_000);
  const token = await wethLaunch();
  const buyer = await freshAccount("weth buyer");
  const p = await openToken(token, buyer);
  await expect(p.locator("#tvStatus")).toHaveText("Selling");
  await setUp(p, "buy", "0.01", { slip: 5 });
  await expect(p.locator("#tvQuote")).toContainText("1 confirmation: the CURB router wraps your ETH", { timeout: 30_000 });
  const quoted = await p.evaluate(async () => (await window.CurbApp.computeCurveQuote()).q.out.toString()).then(BigInt);

  // ANOTHER BUY OF THE SAME CURVE, mined while the wallet asks: through the
  // router too, from the deployer's key.
  const registry = await registryOf(await factoryFor(WETH));
  const now = Number(BigInt((await rpc("eth_getBlockByNumber", ["latest", false])).timestamp));
  const other = sel("buyWithEth(address,address,bytes,uint256,uint256,address,uint256)") + encode(
    [T.address, T.address, T.bytes, T.uint(256), T.uint(256), T.address, T.uint(256)],
    [registry, token, "0x", 0n, 1n, OWNER, BigInt(now + 3600)]).slice(2);
  const meddle = await interfereDuringNextSend(p, () =>
    sendMined({ from: OWNER, to: ROUTER, data: other, value: "0x" + (2n * 10n ** 15n).toString(16) }));

  const before = await sentCount(p);
  const fromBlock = await nextBlock();
  const held = await balanceOf(token, buyer);
  await clearMsg(p);
  await p.click("#tvAct");
  await meddle();
  await expect(p.locator("#msg")).toContainText("Done, in one transaction through the CURB router", { timeout: 120_000 });

  const sent = await sentSince(p, before);
  expect(sent.length, "an ETH buy on the WETH pair is not one confirmation").toBe(1);
  expect(sent[0].to).toBe(ROUTER);
  expect(sent[0].data.slice(0, 10)).toBe(sel("buyWithEth(address,address,bytes,uint256,uint256,address,uint256)"));
  expect(BigInt(sent[0].value)).toBe(10n ** 16n);
  const ev = (await routerEvents(BOUGHT, fromBlock)).filter((e) => e.who === buyer.toLowerCase());
  expect(ev.length).toBe(1);
  const tokensOut = wordAt(ev[0].data, 3);
  expect(await balanceOf(token, buyer) - held, "the tokens the event names did not arrive").toBe(tokensOut);
  expect(tokensOut === quoted, "the other buy did not move the price, so this proves nothing about the report").toBe(false);
  const x = await exactOf(p);
  expect(x.paid).toBe(wordAt(ev[0].data, 1));
  expect(x.out, "the report's tokens are not the event's").toBe(tokensOut);
  await expect(p.locator("#msg"), "an ordinary router buy was reported in WETH").not.toContainText("as WETH");
  await p.close();
});

test("an ETH buy on NVDAc is one send, and its bounds are the slippage off fresh quotes of the path and of the curve", async () => {
  test.setTimeout(240_000);
  const token = await nvdaLaunch();
  const buyer = await freshAccount("nvda buyer");
  const p = await openToken(token, buyer);
  await setUp(p, "buy", "0.01", { slip: 2 });
  await expect(p.locator("#tvQuote")).toContainText(/1 confirmation: the CURB router swaps your ETH into about [\d.,]+ NVDAc \(at least [\d.,]+\)/, { timeout: 30_000 });
  const before = await sentCount(p);
  const fromBlock = await nextBlock();
  await press(p, "Done, in one transaction through the CURB router");
  const sent = await sentSince(p, before);
  expect(sent.length, "an ETH buy on NVDAc is not one confirmation").toBe(1);
  expect(sent[0].to).toBe(ROUTER);

  // THE BOUNDS, against the chain at the block before the trade.
  const w = argWords(sent[0].data);
  const pathHex = bytesArg(sent[0].data, 2);
  expect((pathHex.length - 2) / 2, "NVDAc is one hop from WETH").toBe(43);
  expect(pathHex.slice(0, 42).toLowerCase()).toBe(WETH);
  expect(("0x" + pathHex.slice(-40)).toLowerCase()).toBe(NVDAC);
  const minQuoteOut = BigInt("0x" + w[3]);
  const minTokensOut = BigInt("0x" + w[4]);
  const ev = (await routerEvents(BOUGHT, fromBlock)).filter((e) => e.who === buyer.toLowerCase())[0];
  const block = "0x" + (BigInt(ev.log.blockNumber) - 1n).toString(16);
  const fresh = await quoterAt(pathHex, 10n ** 16n, block);
  expect(minQuoteOut > 0n, "the swap was sent with no floor").toBe(true);
  expect(minQuoteOut, "minQuoteOut is not 2% off the quoter's answer for the path").toBe(slip(fresh, 200));
  const c = await curveAt(p, await curveOf(p), block);
  expect(minTokensOut, "minTokensOut is not 2% off what minQuoteOut buys on the curve")
    .toBe(slip(await pageQuoteBuy(p, c, minQuoteOut), 200));
  // AND THE EVENT IS WHAT HAPPENED.
  expect(wordAt(ev.data, 1)).toBe(10n ** 16n);
  expect(wordAt(ev.data, 2) >= minQuoteOut).toBe(true);
  expect(await balanceOf(token, buyer)).toBe(wordAt(ev.data, 3));
  expect(await balanceOf(NVDAC, buyer), "NVDAc was left with the buyer").toBe(0n);
  // THE DEADLINE IS TEN MINUTES ON THE CHAIN'S OWN CLOCK, which is what the
  // router compares it with. This fork's clock is weeks behind the wall's, so a
  // deadline from Date.now() is weeks long here, and one already past passes.
  const late = BigInt("0x" + w[6]) - await blockTime(ev.log.blockNumber);
  expect(late > 480n && late <= 600n, `the deadline is ${late} s past the block it mined in, not about 600`).toBe(true);
  // AND THE FEE AND THE TAX ARE THE CURVE'S OWN EVENT'S.
  const cb = (await rpc("eth_getLogs", [{ address: await curveOf(p), topics: [CURVE_BUY], fromBlock, toBlock: "latest" }]))
    .filter((l) => l.transactionHash === ev.log.transactionHash);
  expect(cb.length).toBe(1);
  const x = await exactOf(p);
  expect(x.fee, "the report's fee is not CurveBuy's").toBe(wordAt(cb[0].data, 2));
  expect(x.tax, "the report's tax is not CurveBuy's").toBe(wordAt(cb[0].data, 3));
  await p.close();
});

test("an ETH buy on SPCXc, two hops through USDC, is one send", async () => {
  test.setTimeout(240_000);
  const token = await spaceLaunch();
  const buyer = await freshAccount("space buyer");
  const p = await openToken(token, buyer);
  await setUp(p, "buy", "0.01");
  await expect(p.locator("#tvQuote")).toContainText("1 confirmation", { timeout: 30_000 });
  const before = await sentCount(p);
  const fromBlock = await nextBlock();
  await press(p, "Done, in one transaction through the CURB router");
  const sent = await sentSince(p, before);
  expect(sent.length, "an ETH buy on SPCXc is not one confirmation").toBe(1);
  expect(sent[0].to).toBe(ROUTER);
  const pathHex = bytesArg(sent[0].data, 2).toLowerCase();
  expect((pathHex.length - 2) / 2, "SPCXc is not two hops").toBe(66);
  expect(pathHex).toContain(USDC.slice(2));
  const ev = (await routerEvents(BOUGHT, fromBlock)).filter((e) => e.who === buyer.toLowerCase())[0];
  expect(await balanceOf(token, buyer)).toBe(wordAt(ev.data, 3));
  expect((await exactOf(p)).out).toBe(wordAt(ev.data, 3));
  await p.close();
});

/// GOOGLc, ON THE PROPOSED LIST, END TO END. Its ETH route had run in no test
/// at all. Like SPCXc's it is two hops through USDC - no WETH pool holds as
/// much GOOGLc as the deepest USDC pool, the rule B20Router.t.sol checks on
/// chain - so the buy is one send to the router, and the first ETH sale is the
/// router's unlimited approval and then sellForEth, the ETH paying the seller.
test("GOOGLc through the router: an ETH buy, two hops through USDC, is one send, and its first ETH sale is the approval and the sale", async () => {
  test.setTimeout(300_000);
  expect(await factoryFor(GOOGLC), "the harness deployed no GOOGLc factory").not.toBeNull();
  const token = await googlLaunch();
  const trader = await freshAccount("googl trader");
  const p = await openToken(token, trader);

  // ---- THE BUY: one send, WETH -> USDC -> GOOGLc.
  await setUp(p, "buy", "0.01");
  await expect(p.locator("#tvQuote")).toContainText("1 confirmation", { timeout: 30_000 });
  let before = await sentCount(p);
  let fromBlock = await nextBlock();
  await press(p, "Done, in one transaction through the CURB router");
  let sent = await sentSince(p, before);
  expect(sent.length, "an ETH buy on GOOGLc is not one confirmation").toBe(1);
  expect(sent[0].to).toBe(ROUTER);
  expect(sent[0].data.slice(0, 10)).toBe(sel("buyWithEth(address,address,bytes,uint256,uint256,address,uint256)"));
  const buyPath = bytesArg(sent[0].data, 2).toLowerCase();
  expect((buyPath.length - 2) / 2, "GOOGLc's buy is not two hops").toBe(66);
  expect(buyPath.slice(0, 42)).toBe(WETH);
  expect(buyPath).toContain(USDC.slice(2));
  expect("0x" + buyPath.slice(-40)).toBe(GOOGLC);
  const bought = (await routerEvents(BOUGHT, fromBlock)).filter((e) => e.who === trader.toLowerCase());
  expect(bought.length).toBe(1);
  const tokensOut = wordAt(bought[0].data, 3);
  expect(await balanceOf(token, trader), "the tokens the event names did not arrive").toBe(tokensOut);
  expect((await exactOf(p)).out, "the report's tokens are not the event's").toBe(tokensOut);
  expect(await balanceOf(GOOGLC, trader), "GOOGLc was left with the buyer").toBe(0n);

  // ---- THE FIRST ETH SALE: the approval, then the sale, GOOGLc -> USDC -> WETH.
  await expect(p.locator("#tvPay")).toHaveValue("", { timeout: 30_000 });
  await setUp(p, "sell", "50%", { with: "eth" });
  await expect(p.locator("#tvGetAsset"), "a GOOGLc sale for ETH is not named as paying ether").toHaveText("ETH");
  await expect(p.locator("#tvQuote")).toContainText("2 confirmations (first sale of this token)", { timeout: 30_000 });
  before = await sentCount(p);
  fromBlock = await nextBlock();
  const eth0 = await ethOf(trader);
  await press(p, "Done, in one transaction through the CURB router");
  sent = await sentSince(p, before);
  expect(sent.length, "the first ETH sale on GOOGLc is not two confirmations").toBe(2);
  expect(sent[0].to).toBe(token.toLowerCase());
  expect(sent[0].data.slice(0, 10)).toBe(sel("approve(address,uint256)"));
  expect(addrOf("0x" + argWords(sent[0].data)[0])).toBe(ROUTER);
  expect(BigInt("0x" + argWords(sent[0].data)[1]), "the router's approval is not unlimited").toBe(MAX);
  expect(sent[1].to).toBe(ROUTER);
  expect(sent[1].data.slice(0, 10)).toBe(sel("sellForEth(address,address,uint256,uint256,bytes,uint256,address,uint256)"));
  const salePath = bytesArg(sent[1].data, 4).toLowerCase();
  expect((salePath.length - 2) / 2, "GOOGLc's sale is not two hops").toBe(66);
  expect(salePath.slice(0, 42)).toBe(GOOGLC);
  expect(salePath).toContain(USDC.slice(2));
  expect("0x" + salePath.slice(-40)).toBe(WETH);
  const sold = (await routerEvents(SOLD, fromBlock)).filter((e) => e.who === trader.toLowerCase());
  expect(sold.length).toBe(1);
  const ethOut = wordAt(sold[0].data, 3);
  expect(ethOut > 0n, "the sale paid no ETH").toBe(true);
  expect(wordAt(sold[0].data, 4), "the sale was paid as WETH").toBe(0n);
  // THE ETH THAT ARRIVED IS THE EVENT'S, to the wei, after both sends' gas.
  const hashes = [...new Set((await rpc("eth_getLogs", [{ fromBlock, toBlock: "latest", address: token }]))
    .concat(sold.map((e) => e.log)).map((l) => l.transactionHash))];
  let gas = 0n;
  for (const h of hashes) {
    const tx = await rpc("eth_getTransactionByHash", [h]);
    if (tx.from.toLowerCase() === trader.toLowerCase()) gas += await costOf(h);
  }
  expect(await ethOf(trader) - eth0 + gas, "the ETH received is not the event's ethOut").toBe(ethOut);
  expect((await exactOf(p)).received, "the report's ETH is not the event's").toBe(ethOut);
  await expect(p.locator("#msg"), "the sale was not reported as paid in ETH").toContainText(/You received [\d.,]+ ETH\./);
  await p.close();
});

// ================================================================== one confirmation to sell, after the first
test("the first ETH sale of a token is two sends - an unlimited approval, then the sale - and the next is one", async () => {
  test.setTimeout(300_000);
  const token = await wethLaunch();
  const seller = await freshAccount("weth seller");
  const p = await openToken(token, seller);
  await setUp(p, "buy", "0.02");
  await press(p, "Done, in one transaction through the CURB router");
  await expect(p.locator("#tvPay")).toHaveValue("", { timeout: 30_000 });

  // ---- THE FIRST SALE: said as two, and two.
  await setUp(p, "sell", "50%");
  await expect(p.locator("#tvGetAsset"), "a WETH pair's sale is not named as paying ether").toHaveText("ETH");
  await expect(p.locator("#tvQuote")).toContainText("2 confirmations (first sale of this token)", { timeout: 30_000 });
  await expect(p.locator("#tvActNote")).toContainText("once, with no limit");
  let before = await sentCount(p);
  let fromBlock = await nextBlock();
  let eth0 = await ethOf(seller);
  await press(p, "Done, in one transaction through the CURB router");
  let sent = await sentSince(p, before);
  expect(sent.length, "the first ETH sale is not two confirmations").toBe(2);
  expect(sent[0].to).toBe(token.toLowerCase());
  expect(sent[0].data.slice(0, 10)).toBe(sel("approve(address,uint256)"));
  expect(addrOf("0x" + argWords(sent[0].data)[0])).toBe(ROUTER);
  expect(BigInt("0x" + argWords(sent[0].data)[1]), "the router's approval is not unlimited").toBe(MAX);
  expect(sent[1].to).toBe(ROUTER);
  expect(sent[1].data.slice(0, 10)).toBe(sel("sellForEth(address,address,uint256,uint256,bytes,uint256,address,uint256)"));
  let ev = (await routerEvents(SOLD, fromBlock)).filter((e) => e.who === seller.toLowerCase());
  expect(ev.length).toBe(1);
  let ethOut = wordAt(ev[0].data, 3);
  expect(wordAt(ev[0].data, 4), "the sale was paid as WETH").toBe(0n);
  // THE ETH THAT ARRIVED IS THE EVENT'S, to the wei, after both sends' gas.
  const hashes = [...new Set((await rpc("eth_getLogs", [{ fromBlock, toBlock: "latest", address: token }]))
    .concat(ev.map((e) => e.log)).map((l) => l.transactionHash))];
  let gas = 0n;
  for (const h of hashes) {
    const tx = await rpc("eth_getTransactionByHash", [h]);
    if (tx.from.toLowerCase() === seller.toLowerCase()) gas += await costOf(h);
  }
  expect(await ethOf(seller) - eth0 + gas, "the ETH received is not the event's ethOut").toBe(ethOut);
  expect((await exactOf(p)).received, "the report's ETH is not the event's").toBe(ethOut);
  await expect(p.locator("#msg"), "an ordinary router sale was reported in WETH").toContainText(/You received [\d.,]+ ETH\./);
  expect(BigInt(await ethCall(token, sel("allowance(address,address)") + pad(seller) + pad(ROUTER))),
    "the router's allowance did not stay unlimited after the sale").toBe(MAX);

  // ---- THE SECOND SALE OF THE SAME TOKEN: one.
  await expect(p.locator("#tvPay")).toHaveValue("", { timeout: 30_000 });
  await setUp(p, "sell", "50%");
  await expect(p.locator("#tvQuote")).toContainText("1 confirmation: the CURB router sells", { timeout: 30_000 });
  await expect(p.locator("#tvQuote")).not.toContainText("2 confirmations");
  before = await sentCount(p);
  fromBlock = await nextBlock();
  eth0 = await ethOf(seller);
  await press(p, "Done, in one transaction through the CURB router");
  sent = await sentSince(p, before);
  expect(sent.length, "a second ETH sale of the same token is not one confirmation").toBe(1);
  expect(sent[0].to).toBe(ROUTER);
  ev = (await routerEvents(SOLD, fromBlock)).filter((e) => e.who === seller.toLowerCase());
  ethOut = wordAt(ev[0].data, 3);
  expect(await ethOf(seller) - eth0 + await costOf(ev[0].log.transactionHash)).toBe(ethOut);
  await p.close();
});

test("an ETH sale on NVDAc pays ETH, its floor is the slippage off the curve's and the path's fresh quotes, and the report is the event's", async () => {
  test.setTimeout(300_000);
  const token = await nvdaLaunch();
  const seller = await freshAccount("nvda seller");
  const p = await openToken(token, seller);
  await setUp(p, "buy", "0.02");
  await press(p, "Done, in one transaction through the CURB router");
  await expect(p.locator("#tvPay")).toHaveValue("", { timeout: 30_000 });
  // THE FIRST SALE, ETH CHOSEN ON THE CHIP.
  await setUp(p, "sell", "50%", { with: "eth", slip: 3 });
  await expect(p.locator("#tvGetAsset")).toHaveText("ETH");
  await expect(p.locator("#tvQuote")).toContainText("2 confirmations (first sale of this token)", { timeout: 30_000 });
  // WHAT THE CARD SHOWS IS THE ETH: what the route pays, and its floor - not
  // the curve's NVDAc figures under an ETH label.
  const shown = await p.evaluate(async () => {
    const v = await window.CurbApp.computeCurveQuote();
    return { out: window.CurbApp.fmt(v.ethOut, 18, 6), min: window.CurbApp.fmt(v.ethMin, 18, 6),
      curveOut: window.CurbApp.fmt(v.q.out, window.CurbApp.state.ctx.quoteDecimals, 6) };
  });
  expect(shown.out === shown.curveOut, "the ETH and the NVDAc figures are the same, so this proves nothing").toBe(false);
  await expect(p.locator("#tvGet"), "the card does not show the ETH the sale pays").toHaveText(shown.out);
  await expect(p.locator("#tvQuote"), "the card's floor is not the ETH floor").toContainText("Minimum received: " + shown.min + " ETH");
  let before = await sentCount(p);
  let fromBlock = await nextBlock();
  await press(p, "Done, in one transaction through the CURB router");
  let sent = await sentSince(p, before);
  expect(sent.length, "the first ETH sale on NVDAc is not two confirmations").toBe(2);
  await expect(p.locator("#msg"), "the sale was not reported as paid in ETH").toContainText(/You received [\d.,]+ ETH\./);
  expect(BigInt("0x" + argWords(sent[0].data)[1])).toBe(MAX);

  // THE FLOOR, against the chain at the block before the sale.
  const w = argWords(sent[1].data);
  const tokensIn = BigInt("0x" + w[2]);
  const minQuoteOut = BigInt("0x" + w[3]);
  const pathHex = bytesArg(sent[1].data, 4);
  const minEthOut = BigInt("0x" + w[5]);
  let ev = (await routerEvents(SOLD, fromBlock)).filter((e) => e.who === seller.toLowerCase())[0];
  const block = "0x" + (BigInt(ev.log.blockNumber) - 1n).toString(16);
  const c = await curveAt(p, await curveOf(p), block);
  expect(minQuoteOut, "the curve's bound is not 3% off its quote").toBe(slip(await pageQuoteSell(p, c, tokensIn), 300));
  expect(pathHex.slice(0, 42).toLowerCase()).toBe(NVDAC);
  expect(("0x" + pathHex.slice(-40)).toLowerCase()).toBe(WETH);
  expect(minEthOut > 0n, "the sale was sent with no ETH floor").toBe(true);
  expect(minEthOut, "minEthOut is not 3% off what the path pays for the curve's floor")
    .toBe(slip(await quoterAt(pathHex, minQuoteOut, block), 300));
  expect(wordAt(ev.data, 3) >= minEthOut).toBe(true);
  const late = BigInt("0x" + w[7]) - await blockTime(ev.log.blockNumber);
  expect(late > 480n && late <= 600n, `the sale's deadline is ${late} s past the block it mined in, not about 600`).toBe(true);

  // ---- THE SECOND SALE, ONE SEND - with the price moved while the wallet asks.
  await expect(p.locator("#tvPay")).toHaveValue("", { timeout: 30_000 });
  await setUp(p, "sell", "50%", { with: "eth", slip: 5 });
  await expect(p.locator("#tvQuote")).toContainText("1 confirmation: the CURB router sells", { timeout: 30_000 });
  const quoted = await p.evaluate(async () => (await window.CurbApp.computeCurveQuote()).ethOut.toString()).then(BigInt);
  const curve = await curveOf(p);
  const buyIn = 2n * 10n ** 6n;   // 0.02 NVDAc, from the deployer, onto the same curve
  await sendMined({ from: OWNER, to: NVDAC, data: sel("approve(address,uint256)") + pad(curve) + word(buyIn) });
  const meddle = await interfereDuringNextSend(p, () => sendMined({ from: OWNER, to: curve,
    data: sel("buy(uint256,uint256,address)") + word(buyIn) + word(0) + pad(OWNER) }));
  before = await sentCount(p);
  fromBlock = await nextBlock();
  const eth0 = await ethOf(seller);
  await clearMsg(p);
  await p.click("#tvAct");
  await meddle();
  await expect(p.locator("#msg")).toContainText("Done, in one transaction through the CURB router", { timeout: 120_000 });
  sent = await sentSince(p, before);
  expect(sent.length, "a second ETH sale on NVDAc is not one confirmation").toBe(1);
  ev = (await routerEvents(SOLD, fromBlock)).filter((e) => e.who === seller.toLowerCase())[0];
  const ethOut = wordAt(ev.data, 3);
  expect(ethOut === quoted, "the other buy did not move the price, so this proves nothing about the report").toBe(false);
  expect(await ethOf(seller) - eth0 + await costOf(ev.log.transactionHash), "the ETH received is not the event's").toBe(ethOut);
  const x = await exactOf(p);
  expect(x.received, "the report's ETH is not the event's").toBe(ethOut);
  expect(x["curve paid"]).toBe(wordAt(ev.data, 2));
  await p.close();
});

test("a buy past the threshold refunds what the router's event says, in the same transaction", async () => {
  test.setTimeout(300_000);
  const token = await createOn(await factoryFor(WETH), "Router Fill", "RFL");
  const buyer = await freshAccount("weth filler");
  const p = await openToken(token, buyer);
  const thr = BigInt(await p.evaluate(() => window.CurbApp.state.view.graduationThreshold.toString()));
  const offer = (thr * 3n) / 2n;
  await setUp(p, "buy", (Number(offer) / 1e18).toString(), { slip: 10 });
  await expect(p.locator("#tvQuote")).toContainText("ETH, in the same transaction", { timeout: 30_000 });
  const quotedRefund = await p.evaluate(async () => (await window.CurbApp.computeCurveQuote()).q.refund.toString()).then(BigInt);
  // A SMALL BUY OF SOMEBODY ELSE'S FIRST, mined while the wallet asks: the
  // curve has less left to sell, and the refund grows past what was quoted.
  const registry = await registryOf(await factoryFor(WETH));
  const now = Number(BigInt((await rpc("eth_getBlockByNumber", ["latest", false])).timestamp));
  const other = sel("buyWithEth(address,address,bytes,uint256,uint256,address,uint256)") + encode(
    [T.address, T.address, T.bytes, T.uint(256), T.uint(256), T.address, T.uint(256)],
    [registry, token, "0x", 0n, 1n, OWNER, BigInt(now + 3600)]).slice(2);
  const meddle = await interfereDuringNextSend(p, () =>
    sendMined({ from: OWNER, to: ROUTER, data: other, value: "0x" + (5n * 10n ** 16n).toString(16) }));
  const before = await sentCount(p);
  const fromBlock = await nextBlock();
  const eth0 = await ethOf(buyer);
  await clearMsg(p);
  await p.click("#tvAct");
  await meddle();
  await expect(p.locator("#msg")).toContainText("Done, in one transaction through the CURB router", { timeout: 120_000 });
  const sent = await sentSince(p, before);
  expect(sent.length, "a buy past the threshold is not one confirmation").toBe(1);
  const ev = (await routerEvents(BOUGHT, fromBlock)).filter((e) => e.who === buyer.toLowerCase())[0];
  const ethIn = wordAt(ev.data, 1);
  const ethRefund = wordAt(ev.data, 5);
  expect(ethRefund > 0n, "the buy was not refunded, so this proves nothing").toBe(true);
  expect(ethRefund === quotedRefund, "the other buy did not change the refund, so this proves nothing about the report").toBe(false);
  expect(eth0 - await ethOf(buyer) - await costOf(ev.log.transactionHash), "the refund that arrived is not the event's")
    .toBe(ethIn - ethRefund);
  expect((await exactOf(p))["ETH refund"], "the report's refund is not the event's").toBe(ethRefund);
  await expect(p.locator("#msg")).toContainText("came back to you in the same transaction");
  await p.close();
});

// ================================================================== bounds that are not zero
test("a slippage that would leave a router trade with no floor is refused before anything is sent", async () => {
  test.setTimeout(180_000);
  const token = await nvdaLaunch();
  const buyer = await freshAccount("nvda unbounded");
  const p = await openToken(token, buyer);
  const before = await sentCount(p);
  await cardSide(p, "buy");
  await payWith(p, "eth");
  await p.fill("#tvSlip", "100");
  await p.fill("#tvPay", "0.01");
  await expect(p.locator("#tvQuote")).toContainText("would have no floor at all", { timeout: 30_000 });
  await expect(p.locator("#tvAct")).toBeDisabled();
  expect(await sentCount(p)).toBe(before);
  // AND A SALE: the curve's floor and the ETH floor are each refused at zero.
  await p.fill("#tvSlip", "5");
  await p.fill("#tvPay", "0.02");
  await press(p, "Done, in one transaction through the CURB router");
  await expect(p.locator("#tvPay")).toHaveValue("", { timeout: 30_000 });
  const held = await sentCount(p);
  await cardSide(p, "sell");
  await payWith(p, "eth");
  await p.fill("#tvSlip", "100");
  await expect.poll(async () => (await p.locator("#tvPayAvail").textContent()).trim().length, { timeout: 30_000 }).toBeGreaterThan(0);
  await p.click('#tvPcts [data-pct="50"]');
  await expect(p.locator("#tvQuote")).toContainText("would have no floor at all", { timeout: 30_000 });
  await expect(p.locator("#tvAct")).toBeDisabled();
  expect(await sentCount(p), "something was sent for a sale with no floor").toBe(held);
  await p.close();
});

// ================================================================== the swap against the market
test("the swap between ETH and the pair's asset is checked against Chainlink: past 15% it is warned strongly, past 50% nothing is sent", async () => {
  test.setTimeout(180_000);
  const token = await nvdaLaunch();
  const buyer = await freshAccount("nvda conversion");
  const p = await openToken(token, buyer);
  const before = await sentCount(p);
  await cardSide(p, "buy");
  await payWith(p, "eth");
  // A SMALL BUY: the pool pays close to the market, and only the figure is said.
  await p.fill("#tvPay", "0.01");
  await expect(p.locator("#tvQuote .tvConv")).toHaveText(/^Conversion: \d+\.\d\d% below market$/, { timeout: 30_000 });
  await expect(p.locator("#tvQuote .tvConv")).not.toHaveClass(/warn|strong/);
  await expect(p.locator("#tvQuote")).not.toContainText("VERY COSTLY CONVERSION");
  // TWENTY ETH takes every NVDAc this pool holds at this block: about a third
  // below the market.
  await p.fill("#tvPay", "20");
  await expect(p.locator("#tvQuote")).toContainText("VERY COSTLY CONVERSION", { timeout: 30_000 });
  await expect(p.locator("#tvQuote .tvConv")).toHaveClass(/strong/);
  // FORTY: more than half of it lost - refused, and the button with it.
  await p.fill("#tvPay", "40");
  await expect(p.locator("#tvQuote")).toContainText("less than the market price (Chainlink)", { timeout: 30_000 });
  await expect(p.locator("#tvQuote")).toContainText("pay with NVDAc instead");
  await expect(p.locator("#tvAct")).toBeDisabled();
  expect(await sentCount(p), "something was sent for a conversion past half").toBe(before);
  await p.close();
});

// THE SAME CHECK ON EVERY OTHER ETH ROUTE: a router sale, the two-step buy the
// page takes without the router, and a graduated launch's pool - each warned at
// 5% and 15% and refused past 50%, on the swap card and on the long page - and
// skipped, saying nothing, where the asset's feed does not name itself.
//
// A SALE'S LOSS IS SHOWN BY CHAINLINK'S PRICE, NOT THE POOL'S: the pool here is
// deep enough for the NVDAc a small sale produces, so the NVDA feed's answer is
// served scaled up instead - NVDAc then worth more than the pool pays in ETH
// for it, which is what a thin or pushed pool does to a sale.
const NVDA_FEED = "0x04689a41629776563e6822f76f2e57d148d28513";
const ETH_FEED = "0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70";
const LATEST_ROUND = sel("latestRoundData()");
const FEED_DESCRIPTION = sel("description()");
/// A string as a contract returns it.
const abiString = (s) => {
  const h = Buffer.from(s, "utf8").toString("hex");
  return "0x" + word(32) + word(h.length / 2) + h.padEnd(Math.ceil(h.length / 64) * 64 || 64, "0");
};
/// The feed call a route intercepted, or null.
function feedCall(route, feed, selector) {
  const req = route.request();
  let m = null;
  try { m = req.method() === "POST" ? JSON.parse(req.postData() || "") : null; } catch { m = null; }
  const c = m && !Array.isArray(m) && m.method === "eth_call" && m.params && m.params[0];
  return c && String(c.to || "").toLowerCase() === feed && String(c.data || "").toLowerCase().startsWith(selector) ? m : null;
}
/// THE NVDA FEED'S ANSWER, SERVED TIMES num / den to this page - set before the
/// page loads: the page keeps a feed's answer for a minute.
async function nvdaFeedTimes(p, num, den) {
  await p.route("**/*", async (route) => {
    if (!feedCall(route, NVDA_FEED, LATEST_ROUND)) return route.fallback();
    const res = await route.fetch();
    const body = await res.json();
    const h = String(body.result).replace(/^0x/, "");
    body.result = "0x" + h.slice(0, 64) + word((BigInt("0x" + h.slice(64, 128)) * BigInt(num)) / BigInt(den)) + h.slice(128);
    return route.fulfill({ response: res, body: JSON.stringify(body) });
  });
}
/// Dollars per whole unit by a feed, read here from the chain, times num / den.
async function feedUsdTimes(feed, num = 1, den = 1) {
  const dec = Number(BigInt(await ethCall(feed, sel("decimals()"))));
  const answer = wordAt(await ethCall(feed, LATEST_ROUND), 1);
  return (Number(answer) / 10 ** dec) * (num / den);
}
/// The card's conversion line, as a number of basis points, and its level.
async function convOnCard(p) {
  const line = p.locator("#tvQuote .tvConv");
  await expect(line).toHaveText(/^Conversion: \d+\.\d\d% below market$/, { timeout: 30_000 });
  const t = await line.textContent();
  const cls = (await line.getAttribute("class")) || "";
  return { bps: Math.round(Number(t.match(/([\d.]+)%/)[1]) * 100), level: /strong/.test(cls) ? "strong" : /warn/.test(cls) ? "warn" : "" };
}
/// A launch on NVDAc taken past its threshold and into its pool, from the
/// deployer's NVDAc: its token. Made inside a snapshot by the caller.
async function graduatedNvdaLaunch(name, symbol) {
  const token = await createOn(APP.factory, name, symbol);
  const curve = addrOf("0x" + (await ethCall(APP.lens, sel("launchState(address)") + pad(token))).slice(2 + 64, 2 + 128));
  const amount = 70n * 10n ** 8n;   // past the NVDAc factory's threshold
  await sendMined({ from: OWNER, to: NVDAC, data: sel("approve(address,uint256)") + pad(curve) + word(amount) });
  await sendMined({ from: OWNER, to: curve, data: sel("buy(uint256,uint256,address)") + word(amount) + word(0) + pad(OWNER),
    gas: "0x" + (12_000_000).toString(16) });
  const status = () => ethCall(APP.lens, sel("launchState(address)") + pad(token)).then((r) => Number(wordAt(r, 0)));
  if (await status() === 2) {
    await sendMined({ from: OWNER, to: APP.graduator, data: sel("graduate(address)") + pad(token), gas: "0x" + (12_000_000).toString(16) });
  }
  expect(await status(), "the launch did not reach its pool").toBe(3);
  return token;
}

test("an NVDAc router sale is checked against Chainlink as a buy is: warned past 5% and 15%, refused past 50%, with the sale's own figure", async () => {
  test.setTimeout(300_000);
  const token = await nvdaLaunch();
  const seller = await freshAccount("nvda conversion seller");
  let p = await openToken(token, seller);
  await setUp(p, "buy", "0.02");
  await press(p, "Done, in one transaction through the CURB router");
  await p.close();
  /// The card set for an ETH sale of half the tokens, the feed served times k.
  const saleWith = async (num, den) => {
    const page = await openToken(token, seller, { before: (q) => nvdaFeedTimes(q, num, den) });
    await cardSide(page, "sell");
    await payWith(page, "eth");
    await expect.poll(async () => (await page.locator("#tvPayAvail").textContent()).trim().length, { timeout: 30_000 }).toBeGreaterThan(0);
    await page.click('#tvPcts [data-pct="50"]');
    return page;
  };
  // AT CHAINLINK'S OWN PRICE: the pool pays close to it - the figure, no warning.
  p = await saleWith(1, 1);
  let c = await convOnCard(p);
  expect(c.level, "a sale paid close to the market was warned").toBe("");
  // THE FIGURE IS WHAT THE SALE PAYS IN ETH AGAINST THE NVDAc IT SELLS, both at Chainlink's prices.
  const v = await p.evaluate(async () => {
    const r = await window.CurbApp.computeCurveQuote();
    return { via: r.via, ethOut: r.ethOut.toString(), qOut: r.q.out.toString(), bps: r.conv ? r.conv.bps : null };
  });
  expect(v.via, "the sale was not priced through the router").toBe("router");
  const want = Math.round((1 - (Number(v.ethOut) / 1e18) * (await feedUsdTimes(ETH_FEED)) /
    ((Number(v.qOut) / 1e8) * (await feedUsdTimes(NVDA_FEED)))) * 10000);
  expect(Math.abs(v.bps - Math.max(0, want)), `the sale's conversion is ${v.bps} bps, the feeds say ${want}`).toBeLessThanOrEqual(1);
  await p.close();
  // NVDAc WORTH 10% MORE THAN THE POOL PAYS FOR IT: warned.
  p = await saleWith(110, 100);
  c = await convOnCard(p);
  expect(c.level, `a sale paying ${c.bps / 100}% below the market was not warned`).toBe("warn");
  await expect(p.locator("#tvQuote")).toContainText("The swap of NVDAc into ETH pays");
  await p.close();
  // 40% MORE: warned strongly, the way out said.
  p = await saleWith(140, 100);
  c = await convOnCard(p);
  expect(c.level, `a sale paying ${c.bps / 100}% below the market was not warned strongly`).toBe("strong");
  await expect(p.locator("#tvQuote")).toContainText("VERY COSTLY CONVERSION: the swap of NVDAc into ETH");
  await p.close();
  // THREE TIMES: two thirds lost - refused, the button with it, and nothing sent.
  p = await saleWith(3, 1);
  await expect(p.locator("#tvQuote")).toContainText("The swap from NVDAc into ETH would pay", { timeout: 30_000 });
  await expect(p.locator("#tvQuote")).toContainText("receive NVDAc instead");
  await expect(p.locator("#tvAct")).toBeDisabled();
  expect(await sentCount(p), "something was sent for a sale losing more than half in its swap").toBe(0);
  await p.close();
});

test("WITHOUT THE ROUTER the two-step ETH buy is checked against Chainlink the same: strongly warned at 20 ETH, refused at 40, on the card and on the long page", async () => {
  test.setTimeout(240_000);
  const token = await nvdaLaunch();
  await inSnapshot(async () => {
    await rpc("anvil_setCode", [ROUTER, "0x"]);
    const buyer = await freshAccount("no router conversion");
    const p = await openToken(token, buyer);
    await cardSide(p, "buy");
    await payWith(p, "eth");
    await p.fill("#tvPay", "0.01");
    await expect(p.locator("#tvQuote")).toContainText("Swapped first through Uniswap", { timeout: 30_000 });
    expect((await convOnCard(p)).level, "a small two-step buy was warned").toBe("");
    // TWENTY ETH takes every NVDAc the pool holds: about a third below the market.
    await p.fill("#tvPay", "20");
    await expect(p.locator("#tvQuote")).toContainText("VERY COSTLY CONVERSION: the swap of ETH into NVDAc", { timeout: 30_000 });
    expect((await convOnCard(p)).level).toBe("strong");
    // FORTY: refused, before either of the two sends.
    await p.fill("#tvPay", "40");
    await expect(p.locator("#tvQuote")).toContainText("The swap from ETH into NVDAc would pay", { timeout: 30_000 });
    await expect(p.locator("#tvQuote")).toContainText("pay with NVDAc instead");
    await expect(p.locator("#tvAct")).toBeDisabled();
    expect(await sentCount(p), "something was sent for a two-step buy losing more than half in its swap").toBe(0);
    await p.close();
    // THE LONG PAGE: the conversion row, warned strongly, and the refusal.
    const lp = await newPage(buyer);
    await lp.goto("/app.html?" + new URLSearchParams({ rpc: STATE.rpc, factory: APP.factory, lens: APP.lens, token }).toString());
    await lp.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
    await lp.evaluate(() => window.CurbApp.connect());
    await lp.selectOption("#curveSide", "buy");
    await lp.selectOption("#curveVia", "eth");
    await lp.fill("#curveAmount", "20");
    await lp.evaluate(() => window.CurbApp.refresh(true));
    // THE ROW NAMED "conversion" - other rows mention the conversion in their words.
    const row = lp.locator("#curveQuote .row", { hasText: /^conversion\s*\d+\.\d\d%/ });
    await expect(row).toContainText("below the market price (Chainlink)", { timeout: 30_000 });
    await expect(row.locator(".impact.strong")).toHaveText(/^\d+\.\d\d%$/);
    await expect(lp.locator("#curveQuote")).toContainText("VERY COSTLY CONVERSION");
    await lp.fill("#curveAmount", "40");
    await lp.evaluate(() => window.CurbApp.refresh(true));
    await expect(lp.locator("#curveQuote")).toContainText("The swap from ETH into NVDAc would pay", { timeout: 30_000 });
    await lp.close();
  });
});

test("a graduated NVDAc launch's pool ETH route is checked against Chainlink: a 40 ETH buy and a sale past half are refused, on the card and on the long page", async () => {
  test.setTimeout(360_000);
  await inSnapshot(async () => {
    const token = await graduatedNvdaLaunch("Conversion Pool", "CVP");
    const trader = await freshAccount("pool conversion");
    let p = await openToken(token, trader);
    await expect(p.locator("#tvStatus")).toHaveText("Graduated");
    await cardSide(p, "buy");
    await payWith(p, "eth");
    // FORTY ETH INTO THE POOL: the ETH -> NVDAc leg pays far below the market.
    await p.fill("#tvPay", "40");
    await expect(p.locator("#tvQuote")).toContainText("The swap from ETH into NVDAc would pay", { timeout: 30_000 });
    await expect(p.locator("#tvQuote")).toContainText("pay with NVDAc instead");
    await expect(p.locator("#tvAct")).toBeDisabled();
    // A SMALL BUY GOES THROUGH: tokens for the sales below.
    await p.fill("#tvPay", "0.01");
    expect((await convOnCard(p)).level, "a small pool buy was warned").toBe("");
    await press(p, "Swapped");
    expect(await sentCount(p), "the small pool buy was not sent").toBeGreaterThan(0);
    await p.close();
    /// The card set for an ETH sale of all the tokens, the feed served times k.
    const saleWith = async (num, den) => {
      const page = await openToken(token, trader, { before: (q) => nvdaFeedTimes(q, num, den) });
      await cardSide(page, "sell");
      await payWith(page, "eth");
      await expect.poll(async () => (await page.locator("#tvPayAvail").textContent()).trim().length, { timeout: 30_000 }).toBeGreaterThan(0);
      await page.click('#tvPcts [data-pct="100"]');
      return page;
    };
    p = await saleWith(140, 100);
    const c = await convOnCard(p);
    expect(c.level, `a pool sale paying ${c.bps / 100}% below the market was not warned strongly`).toBe("strong");
    await expect(p.locator("#tvQuote")).toContainText("VERY COSTLY CONVERSION: the swap of NVDAc into ETH");
    await p.close();
    p = await saleWith(3, 1);
    await expect(p.locator("#tvQuote")).toContainText("The swap from NVDAc into ETH would pay", { timeout: 30_000 });
    await expect(p.locator("#tvQuote")).toContainText("receive NVDAc instead");
    await expect(p.locator("#tvAct")).toBeDisabled();
    expect(await sentCount(p), "something was sent for a pool sale losing more than half in its swap").toBe(0);
    await p.close();
    // THE LONG PAGE'S POOL BOX: the conversion row, and the refusal.
    const lp = await newPage(trader);
    await lp.goto("/app.html?" + new URLSearchParams({ rpc: STATE.rpc, factory: APP.factory, lens: APP.lens, token }).toString());
    await lp.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
    await lp.evaluate(() => window.CurbApp.connect());
    await lp.selectOption("#poolVia", "eth");
    await lp.selectOption("#poolSide", "buy");
    await lp.fill("#poolAmount", "20");
    await lp.evaluate(() => window.CurbApp.refresh(true));
    const row = lp.locator("#poolQuote .row", { hasText: /^conversion\s*\d+\.\d\d%/ });
    await expect(row).toContainText("below the market price (Chainlink)", { timeout: 30_000 });
    await expect(row.locator(".impact.strong")).toHaveText(/^\d+\.\d\d%$/);
    await lp.fill("#poolAmount", "40");
    await lp.evaluate(() => window.CurbApp.refresh(true));
    await expect(lp.locator("#poolQuote")).toContainText("The swap from ETH into NVDAc would pay", { timeout: 30_000 });
    await lp.close();
  });
});

// FAIL CLOSED (audit, item 10). The check used to be skipped, saying nothing,
// whenever a price could not be had - a feed that does not name itself, or a
// read refused under load - so the one control over a thin or pushed pool went
// missing exactly when reads failed. Now the card says the swap is not
// checked, and the press sends nothing through it.
test("an asset whose feed does not name itself gets no conversion figure: the swap is said to be unchecked, and nothing is sent through it", async () => {
  test.setTimeout(180_000);
  const token = await nvdaLaunch();
  const buyer = await freshAccount("nvda conversion no feed");
  // THE NVDA FEED CALLS ITSELF SOMETHING ELSE: the page has no dollar price
  // for NVDAc to check the swap against.
  const p = await openToken(token, buyer, { before: (q) => q.route("**/*", async (route) => {
    const m = feedCall(route, NVDA_FEED, FEED_DESCRIPTION);
    if (!m) return route.fallback();
    return route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: m.id, result: abiString("Coinbase NVDX") }) });
  }) });
  await cardSide(p, "buy");
  await payWith(p, "eth");
  await p.fill("#tvPay", "0.01");
  await expect(p.locator("#tvQuote")).toContainText("Minimum received", { timeout: 30_000 });
  await expect(p.locator("#tvQuote .tvConv"), "a conversion figure was drawn with no feed to draw it from").toHaveCount(0);
  await expect(p.locator("#tvQuote .tvConvUnchecked")).toHaveText("Conversion: not checked against Chainlink");
  await expect(p.locator("#tvQuote")).toContainText("NVDAc has no Chainlink price this page can check it against");
  const before = await sentCount(p);
  await press(p, "could not be checked against Chainlink's price (NVDAc has no Chainlink price this page can check it against)");
  await expect(p.locator("#msg")).toContainText("Pay with NVDAc instead");
  expect(await sentCount(p), "a buy was sent through a swap nobody could check").toBe(before);
  await p.close();
});

/// EVERY CALL TO THE NVDA FEED REFUSED, while `on()` says so - as an endpoint
/// under load refuses with a rate limit.
async function nvdaFeedRefused(p, on) {
  await p.route("**/*", async (route) => {
    const req = route.request();
    let m = null;
    try { m = req.method() === "POST" ? JSON.parse(req.postData() || "") : null; } catch { m = null; }
    const c = m && !Array.isArray(m) && m.method === "eth_call" && m.params && m.params[0];
    if (!on() || !c || String(c.to || "").toLowerCase() !== NVDA_FEED) return route.fallback();
    return route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32005, message: "over rate limit" } }) });
  });
}

test("a feed read that fails leaves the swap unchecked and nothing is sent through it, while a price read in the last 15 minutes stands in", async () => {
  test.setTimeout(180_000);
  const token = await nvdaLaunch();
  const buyer = await freshAccount("nvda feed refused");
  let refused = false;
  const p = await openToken(token, buyer, { before: async (q) => { await q.clock.install(); await nvdaFeedRefused(q, () => refused); } });
  /// What a quote of the card's trade says about its conversion, asked now.
  const convNow = () => p.evaluate(async () => {
    const r = await window.CurbApp.computeCurveQuote();
    return { figure: !!r.conv, unchecked: r.convUnchecked ? r.convUnchecked.why : null, error: r.error || null };
  });
  await cardSide(p, "buy");
  await payWith(p, "eth");
  await p.fill("#tvPay", "0.01");
  await convOnCard(p);
  // REFUSED FROM NOW ON. Two minutes later the price kept for a minute is due
  // again, its read fails, and the one read two minutes ago stands in.
  refused = true;
  await p.clock.fastForward("02:00");
  expect(await convNow(), "a price two minutes old did not stand in for a read that failed")
    .toEqual({ figure: true, unchecked: null, error: null });
  // SIXTEEN MINUTES ON, it is too old to: the swap is not checked, and not sent.
  await p.clock.fastForward("16:00");
  expect(await convNow()).toEqual({ figure: false, unchecked: "the Chainlink price of NVDAc could not be read just now", error: null });
  await p.fill("#tvPay", "0.012");
  await expect(p.locator("#tvQuote .tvConvUnchecked")).toHaveText("Conversion: not checked against Chainlink", { timeout: 30_000 });
  await expect(p.locator("#tvQuote .tvConv")).toHaveCount(0);
  await expect(p.locator("#tvQuote")).toContainText("the Chainlink price of NVDAc could not be read just now");
  const before = await sentCount(p);
  await press(p, "could not be checked against Chainlink's price (the Chainlink price of NVDAc could not be read just now)");
  expect(await sentCount(p), "a buy was sent while the feed could not be read").toBe(before);
  // AND READ AGAIN, it is checked again.
  refused = false;
  expect(await convNow()).toEqual({ figure: true, unchecked: null, error: null });
  await p.close();
});

test("a graduated launch's pool ETH route with a feed that cannot be read sends nothing", async () => {
  test.setTimeout(360_000);
  await inSnapshot(async () => {
    const token = await graduatedNvdaLaunch("Unchecked Pool", "UCP");
    const trader = await freshAccount("pool feed refused");
    const p = await openToken(token, trader, { before: (q) => nvdaFeedRefused(q, () => true) });
    await expect(p.locator("#tvStatus")).toHaveText("Graduated");
    await cardSide(p, "buy");
    await payWith(p, "eth");
    await p.fill("#tvPay", "0.01");
    await expect(p.locator("#tvQuote .tvConvUnchecked")).toHaveText("Conversion: not checked against Chainlink", { timeout: 30_000 });
    const before = await sentCount(p);
    await press(p, "could not be checked against Chainlink's price");
    expect(await sentCount(p), "a pool buy was sent through a swap nobody could check").toBe(before);
    await p.close();
  });
});

// ================================================================== where the router cannot be used
/// Runs `fn` on a copy of the chain that is thrown away after it.
async function inSnapshot(fn) {
  const snap = await rpc("evm_snapshot", []);
  try { return await fn(); } finally {
    expect(await rpc("evm_revert", [snap]), "the snapshot was not reverted").toBe(true);
  }
}

test("with no code at the router's address, nothing is sent there: the buy swaps then buys, as before, and says why", async () => {
  test.setTimeout(240_000);
  const token = await nvdaLaunch();
  await inSnapshot(async () => {
    await rpc("anvil_setCode", [ROUTER, "0x"]);
    const buyer = await freshAccount("no router buyer");
    const p = await openToken(token, buyer);
    await setUp(p, "buy", "0.01");
    await expect(p.locator("#tvQuote")).toContainText("Not through the CURB router: the CURB router is not deployed on this network", { timeout: 30_000 });
    await expect(p.locator("#tvQuote")).toContainText("Two confirmations");
    const before = await sentCount(p);
    await press(p, "Done. You paid");
    const sent = await sentSince(p, before);
    expect(sent.some((t) => t.to === ROUTER), "something was sent to an address with no code").toBe(false);
    expect(sent[0].to, "the old flow's swap did not go through UniversalRouter").toBe(UNIVERSAL_ROUTER);
    expect(sent[sent.length - 1].data.slice(0, 10)).toBe(sel("buy(uint256,uint256,address)"));
    // AND A SALE HERE PAYS THE PAIR'S ASSET ONLY, as it did before the router.
    await p.fill("#tvPay", "");
    await cardSide(p, "sell");
    await expect(p.locator("#tvGetAsset")).toHaveText("NVDAc");
    await expect(p.locator("#tvGetAsset")).not.toHaveClass(/tvPick/);
    await p.close();
  });
});

test("with other code at the router's address, nothing is sent there: the WETH pair wraps, approves and buys, as before", async () => {
  test.setTimeout(240_000);
  const token = await wethLaunch();
  await inSnapshot(async () => {
    // CODE THAT ACCEPTS ANYTHING AND RETURNS: a buy sent to it would succeed
    // and the ETH would be gone.
    await rpc("anvil_setCode", [ROUTER, "0x00"]);
    expect(keccakHex(await rpc("eth_getCode", [ROUTER, "latest"]))).not.toBe(CODEHASH);
    const buyer = await freshAccount("other code buyer");
    const p = await openToken(token, buyer);
    await setUp(p, "buy", "0.01");
    await expect(p.locator("#tvQuote")).toContainText("is not the router this page knows", { timeout: 30_000 });
    const before = await sentCount(p);
    await press(p, "Done. The curve gave you");
    const sent = await sentSince(p, before);
    expect(sent.some((t) => t.to === ROUTER), "something was sent to code that is not the router").toBe(false);
    expect(sent.map((t) => t.data.slice(0, 10)), "the old flow is not wrap, approve, buy")
      .toEqual([sel("deposit()"), sel("approve(address,uint256)"), sel("buy(uint256,uint256,address)")]);
    await p.close();
  });
});

test("when NVDAc's issuer refuses the router, the buy takes the old way and says so; a refused account is refused outright", async () => {
  test.setTimeout(300_000);
  const token = await nvdaLaunch();
  await inSnapshot(async () => {
    // THE REAL MECHANISM, as test/fork/B20Restrictions.t.sol uses it: the
    // policy's own admin adds the router to its blocklist.
    const scope = await ethCall(NVDAC, sel("TRANSFER_RECEIVER_POLICY()"));
    const policy = BigInt(await ethCall(NVDAC, sel("policyId(bytes32)") + scope.slice(2)));
    expect(policy > 0n, "NVDAc names no policy").toBe(true);
    const admin = addrOf(await ethCall(POLICY_REGISTRY, sel("policyAdmin(uint64)") + word(policy)));
    await rpc("anvil_impersonateAccount", [admin]);
    await rpc("anvil_setBalance", [admin, "0x" + (10n ** 18n).toString(16)]);
    const block = (who) => sendMined({ from: admin, to: POLICY_REGISTRY,
      data: sel("updateBlocklist(uint64,bool,address[])") + encode([T.uint(64), T.bool, T.array(T.address)], [policy, true, [who]]).slice(2) });
    const authorized = async (who) => BigInt(await ethCall(POLICY_REGISTRY, sel("isAuthorized(uint64,address)") + word(policy) + pad(who))) === 1n;
    expect(await authorized(ROUTER), "the router was refused already").toBe(true);
    await block(ROUTER);
    expect(await authorized(ROUTER), "the blocklist update did not take").toBe(false);

    const buyer = await freshAccount("issuer refuses router");
    const p = await openToken(token, buyer);
    await setUp(p, "buy", "0.01");
    await expect(p.locator("#tvQuote")).toContainText("does not let the CURB router hold it", { timeout: 30_000 });
    const before = await sentCount(p);
    await press(p, "Done. You paid");
    const sent = await sentSince(p, before);
    expect(sent.some((t) => t.to === ROUTER), "the router was used although the issuer refuses it").toBe(false);
    expect(sent[0].to).toBe(UNIVERSAL_ROUTER);
    // A SALE FOR ETH HAS NO OTHER WAY, and says so.
    await expect(p.locator("#tvPay")).toHaveValue("", { timeout: 30_000 });
    await setUp(p, "sell", "50%", { with: "eth" }).catch(() => {});
    await expect(p.locator("#tvQuote")).toContainText("pays ETH only through the CURB router", { timeout: 30_000 });

    // ---- THE ACCOUNT ITSELF REFUSED: no route works, and the policy row's words say so.
    await block(buyer);
    const q = await openToken(token, buyer);
    const n = await sentCount(q);
    await cardSide(q, "buy");
    await payWith(q, "eth");
    await q.fill("#tvPay", "0.01");
    await expect(q.locator("#tvQuote")).toContainText("has restricted this account", { timeout: 30_000 });
    await expect(q.locator("#tvAct")).toBeDisabled();
    expect(await sentCount(q)).toBe(n);
    await q.close();
    await p.close();
  });
});

/// A LAUNCH THE ISSUER WOULD STOP GRADUATING TAKES NO BUY (audit, item 11). A
/// full curve whose reserve cannot move - the curve pays the Graduator, the
/// Graduator pays Uniswap's PoolManager through Permit2 - stops selling and can
/// never graduate, so its holders are frozen. One blocklist entry on the
/// Graduator, which every launch shares, did that to every full curve on the
/// asset while the page kept taking buys. Now a buy is refused, paid in ETH or
/// in the asset, while a sale stays open.
test("a launch NVDAc's issuer would stop graduating takes no buy, however it is paid, and its holders can still sell", async () => {
  test.setTimeout(300_000);
  const token = await nvdaLaunch();
  await inSnapshot(async () => {
    const buyer = await freshAccount("graduation blocked");
    // THE CONTROL: a buy goes out, and leaves tokens to sell below.
    let p = await openToken(token, buyer);
    await setUp(p, "buy", "0.01");
    await press(p, "Done, in one transaction through the CURB router");
    await p.close();
    const scope = await ethCall(NVDAC, sel("TRANSFER_RECEIVER_POLICY()"));
    const policy = BigInt(await ethCall(NVDAC, sel("policyId(bytes32)") + scope.slice(2)));
    const admin = addrOf(await ethCall(POLICY_REGISTRY, sel("policyAdmin(uint64)") + word(policy)));
    await rpc("anvil_impersonateAccount", [admin]);
    await rpc("anvil_setBalance", [admin, "0x" + (10n ** 18n).toString(16)]);
    const blocklist = (who, on) => sendMined({ from: admin, to: POLICY_REGISTRY,
      data: sel("updateBlocklist(uint64,bool,address[])") + encode([T.uint(64), T.bool, T.array(T.address)], [policy, on, [who]]).slice(2) });
    /// The card's buy, paid as `how`, refused with `says`; then its sale, priced.
    const refused = async (says) => {
      const q = await openToken(token, buyer);
      const n = await sentCount(q);
      for (const how of ["eth", "asset"]) {
        await cardSide(q, "buy");
        await payWith(q, how);
        await q.fill("#tvPay", how === "eth" ? "0.01" : "0.001");
        await expect(q.locator("#tvQuote"), "a buy paid in " + how + " was not refused").toContainText(says, { timeout: 30_000 });
        await expect(q.locator("#tvAct")).toBeDisabled();
      }
      expect(await sentCount(q), "a buy was sent into a launch that could not graduate").toBe(n);
      await cardSide(q, "sell");
      await payWith(q, "asset");
      await q.fill("#tvPay", "1");
      await expect(q.locator("#tvQuote")).toContainText("Minimum received", { timeout: 30_000 });
      await expect(q.locator("#tvQuote")).not.toContainText("could not graduate");
      await q.close();
    };
    // THE GRADUATOR REFUSED: it could not receive the curve's reserve.
    await blocklist(APP.graduator, true);
    await refused("This launch could not graduate: the issuer of NVDAc does not let the Graduator receive it (policy " + policy + ")");
    // PERMIT2 REFUSED INSTEAD: the reserve could not be moved into the pool.
    await blocklist(APP.graduator, false);
    await blocklist("0x000000000022d473030f116ddee9f6b43ac78ba3", true);
    await refused("This launch could not graduate: the issuer of NVDAc does not let Permit2 move it (policy " + policy + ")");
  });
});

/// cbBTC KEEPS COINBASE'S BLACKLIST, NOT B20 POLICIES, and the router asks it
/// the same way (CurbRouter._notBlacklisted). Clean, an ETH buy is one send to
/// the router; with the router blacklisted - by the coin's own blacklister, as
/// Coinbase would - the buy takes the old way and says why; with the account
/// itself blacklisted no route works, and nothing is sent.
test("on cbBTC an ETH buy is one send; with the router blacklisted it takes the old way and says so; a blacklisted account is refused", async () => {
  test.setTimeout(360_000);
  const token = await btcLaunch();
  const clean = await freshAccount("cbbtc clean buyer");
  const p0 = await openToken(token, clean);
  await setUp(p0, "buy", "0.01");
  await expect(p0.locator("#tvQuote")).toContainText("1 confirmation", { timeout: 30_000 });
  const b0 = await sentCount(p0);
  await press(p0);
  const s0 = await sentSince(p0, b0);
  expect(s0.map((t) => t.to), "a clean cbBTC buy with ETH is not one send to the router").toEqual([ROUTER]);
  await p0.close();

  await inSnapshot(async () => {
    const blacklister = addrOf(await ethCall(CBBTC, sel("blacklister()")));
    await rpc("anvil_impersonateAccount", [blacklister]);
    await rpc("anvil_setBalance", [blacklister, "0x" + (10n ** 18n).toString(16)]);
    const blacklist = (who) => sendMined({ from: blacklister, to: CBBTC, data: sel("blacklist(address)") + pad(who) });
    const listed = async (who) => BigInt(await ethCall(CBBTC, sel("isBlacklisted(address)") + pad(who))) === 1n;
    expect(await listed(ROUTER), "the router was blacklisted already").toBe(false);
    await blacklist(ROUTER);
    expect(await listed(ROUTER), "the blacklist entry did not take").toBe(true);

    const buyer = await freshAccount("cbbtc router blacklisted");
    const p = await openToken(token, buyer);
    await setUp(p, "buy", "0.01");
    await expect(p.locator("#tvQuote")).toContainText("has blacklisted the CURB router", { timeout: 30_000 });
    const before = await sentCount(p);
    await press(p, "Done. You paid");
    const sent = await sentSince(p, before);
    expect(sent.some((t) => t.to === ROUTER), "the router was used although the coin blacklists it").toBe(false);
    expect(sent[0].to, "the old flow's swap did not go through UniversalRouter").toBe(UNIVERSAL_ROUTER);
    await p.close();

    // ---- THE ACCOUNT ITSELF BLACKLISTED: refused with the coin's own reason.
    await blacklist(buyer);
    const q = await openToken(token, buyer);
    const n = await sentCount(q);
    await cardSide(q, "buy");
    await payWith(q, "eth");
    await q.fill("#tvPay", "0.01");
    await expect(q.locator("#tvQuote")).toContainText("has blacklisted this account", { timeout: 30_000 });
    await expect(q.locator("#tvAct")).toBeDisabled();
    expect(await sentCount(q)).toBe(n);
    await q.close();
  });
});

// ================================================================== round 2 of the review
/// THE LONG PAGE (app.html) on one launch, connected, its curve drawn.
async function openLong(token, account, rpcUrl, factory, before) {
  const p = await newPage(account, {}, before);
  await p.goto("/app.html?" + new URLSearchParams({ rpc: rpcUrl, factory, lens: APP.lens, token }).toString());
  await p.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
  await p.evaluate(() => window.CurbApp.connect());
  await expect(p.locator("#status")).toHaveText("Selling", { timeout: 30_000 });
  await expect.poll(() => p.evaluate(() => ((window.CurbApp.state.viewFor || {}).token || "").toLowerCase()),
    { timeout: 30_000 }).toBe(token.toLowerCase());
  return p;
}
/// The long page's curve form set, which prices it (each field fires `input`).
async function longQuote(p, side, via, amount) {
  await p.selectOption("#curveSide", side);
  await p.selectOption("#curveVia", via);
  await p.fill("#curveAmount", "");
  await p.fill("#curveAmount", amount);
}

test("the router's code is read again right before each send to it: gone after the card was drawn, nothing is sent there", async () => {
  test.setTimeout(300_000);
  const token = await nvdaLaunch();
  // ---- A BUY, drawn as one confirmation; the code goes; then the press.
  await inSnapshot(async () => {
    const buyer = await freshAccount("router gone before the buy");
    const p = await openToken(token, buyer);
    await setUp(p, "buy", "0.011");
    await expect(p.locator("#tvQuote")).toContainText("1 confirmation: the CURB router", { timeout: 30_000 });
    await rpc("anvil_setCode", [ROUTER, "0x"]);
    const eth0 = await ethOf(buyer);
    const before = await sentCount(p);
    await press(p, "was not sent: the CURB router is not deployed on this network");
    expect(await sentSince(p, before), "something was sent after the router's code went").toEqual([]);
    expect(await ethOf(buyer), "the buyer's ETH moved").toBe(eth0);
    // AND THE NEXT QUOTE TAKES THE LONGER WAY, and says why.
    await p.fill("#tvPay", "0.01");
    await expect(p.locator("#tvQuote")).toContainText("Not through the CURB router: the CURB router is not deployed", { timeout: 30_000 });
    await p.close();
  });
  // ---- A SALE: the code changes while the approval's dialog is open. The
  // approval (a call to the token) mines; the sale is not sent.
  await inSnapshot(async () => {
    const seller = await freshAccount("router changed between approval and sale");
    const p = await openToken(token, seller);
    await setUp(p, "buy", "0.02");
    await press(p, "Done, in one transaction through the CURB router");
    await expect(p.locator("#tvPay")).toHaveValue("", { timeout: 30_000 });
    await setUp(p, "sell", "50%", { with: "eth" });
    await expect(p.locator("#tvQuote")).toContainText("2 confirmations (first sale of this token)", { timeout: 30_000 });
    const meddle = await interfereDuringNextSend(p, () => rpc("anvil_setCode", [ROUTER, "0x00"]));
    const before = await sentCount(p);
    await clearMsg(p);
    await p.click("#tvAct");
    await meddle();
    await expect(p.locator("#msg")).toContainText("The sale itself was not made", { timeout: 120_000 });
    await expect(p.locator("#msg")).toContainText("is not the router this page knows");
    await expect(p.locator("#msg")).toContainText("revoke it by setting it to 0");
    await expect(p.locator("#msg"), "a sale with no router to take it was offered again")
      .not.toContainText("pressing Sell again asks only for the sale");
    // THE WHOLE SENTENCE, so a reason with words cut out of it shows.
    await expect(p.locator("#msg")).toContainText("The sale itself was not made: the code at the CURB router's address " +
      "is not the router this page knows. Nothing else was sent; the quote now takes the way the page used before the router.");
    const sent = await sentSince(p, before);
    expect(sent.map((t) => t.to), "anything but the approval was sent").toEqual([token.toLowerCase()]);
    await p.close();
  });
});

test("a sale declined after the router's approval mined says the allowance stands and how to revoke it, and the next press asks only for the sale", async () => {
  test.setTimeout(300_000);
  const token = await nvdaLaunch();
  const seller = await freshAccount("declines the sale");
  const p = await openToken(token, seller);
  await setUp(p, "buy", "0.02");
  await press(p, "Done, in one transaction through the CURB router");
  await expect(p.locator("#tvPay")).toHaveValue("", { timeout: 30_000 });
  await setUp(p, "sell", "50%", { with: "eth" });
  await expect(p.locator("#tvQuote")).toContainText("2 confirmations (first sale of this token)", { timeout: 30_000 });
  // THE WALLET DECLINES THE SALE - and only the sale.
  await p.evaluate((router) => {
    window.ethereum.cfg.onSend = (tx, w) => {
      w.cfg.sendError = String(tx.to || "").toLowerCase() === router
        ? Object.assign(new Error("User rejected the request."), { code: 4001 }) : null;
    };
  }, ROUTER);
  let before = await sentCount(p);
  await press(p, "The CURB router may now sell this token for you");
  const msg = await p.locator("#msg").textContent();
  expect(msg).toContain("revoke it by setting it to 0");
  expect(msg).toContain("you declined");
  expect(msg, "a standing approval was called nothing sent").not.toContain("Nothing was sent");
  expect(msg).toContain("pressing Sell again asks only for the sale");
  let sent = await sentSince(p, before);
  expect(sent.map((t) => t.data.slice(0, 10)), "the approval was not what was sent").toEqual([sel("approve(address,uint256)")]);
  expect(BigInt(await ethCall(token, sel("allowance(address,address)") + pad(seller) + pad(ROUTER)))).toBe(MAX);
  // ---- PRESSED AGAIN: the sale alone.
  await p.evaluate(() => { window.ethereum.cfg.onSend = null; window.ethereum.cfg.sendError = null; });
  await p.fill("#tvPay", "");
  await setUp(p, "sell", "50%", { with: "eth" });
  await expect(p.locator("#tvQuote")).toContainText("1 confirmation: the CURB router sells", { timeout: 30_000 });
  before = await sentCount(p);
  await press(p, "Done, in one transaction through the CURB router");
  sent = await sentSince(p, before);
  expect(sent.map((t) => t.to), "the sale after a standing approval is not one send to the router").toEqual([ROUTER]);
  await p.close();
});

test("an allowance to the router smaller than the sale is replaced by an unlimited one: said as two confirmations, and two", async () => {
  test.setTimeout(300_000);
  const token = await nvdaLaunch();
  const seller = await freshAccount("one wei allowance");
  const p = await openToken(token, seller);
  await setUp(p, "buy", "0.02");
  await press(p, "Done, in one transaction through the CURB router");
  await expect(p.locator("#tvPay")).toHaveValue("", { timeout: 30_000 });
  await sendMined({ from: seller, to: token, data: sel("approve(address,uint256)") + pad(ROUTER) + word(1) });
  await setUp(p, "sell", "50%", { with: "eth" });
  await expect(p.locator("#tvQuote")).toContainText("2 confirmations (first sale of this token)", { timeout: 30_000 });
  const before = await sentCount(p);
  await press(p, "Done, in one transaction through the CURB router");
  const sent = await sentSince(p, before);
  expect(sent.length, "a 1-wei allowance did not cost an approval").toBe(2);
  expect(sent[0].data.slice(0, 10)).toBe(sel("approve(address,uint256)"));
  expect(BigInt("0x" + argWords(sent[0].data)[1]), "the new approval is not unlimited").toBe(MAX);
  expect(sent[1].to).toBe(ROUTER);
  await p.close();
});

test("an account that refuses ether is paid WETH by the router, and told so: a sale's proceeds and a buy's refund past the threshold", async () => {
  test.setTimeout(400_000);
  const token = await createOn(await factoryFor(WETH), "Router No Ether", "RNE");
  // A WALLET THAT IS A CONTRACT REFUSING EVERY CALL, ether included
  // (PUSH1 0 PUSH1 0 REVERT). The node signs for it.
  const wallet = "0x" + keccak("curb router.spec ether-refusing wallet").slice(-40);
  await rpc("anvil_setCode", [wallet, "0x60006000fd"]);
  await rpc("anvil_impersonateAccount", [wallet]);
  await rpc("anvil_setBalance", [wallet, "0x" + (100n * 10n ** 18n).toString(16)]);
  const p = await openToken(token, wallet);
  await setUp(p, "buy", "0.02");
  await press(p, "Done, in one transaction through the CURB router");
  await expect(p.locator("#tvPay")).toHaveValue("", { timeout: 30_000 });

  // ---- THE SALE: paid as WETH, said as WETH, to the wei of the event.
  await setUp(p, "sell", "50%", { with: "eth" });
  let w0 = await balanceOf(WETH, wallet);
  let fromBlock = await nextBlock();
  await press(p, "Done, in one transaction through the CURB router");
  const sold = (await routerEvents(SOLD, fromBlock)).filter((e) => e.who === wallet)[0];
  expect(wordAt(sold.data, 4), "the router did not pay this sale as WETH, so this proves nothing").toBe(1n);
  const ethOut = wordAt(sold.data, 3);
  expect(await balanceOf(WETH, wallet) - w0, "the WETH that arrived is not the event's").toBe(ethOut);
  await expect(p.locator("#msg")).toContainText("as WETH, because this account would not take ether");
  expect((await exactOf(p)).received).toBe(ethOut);
  await expect(p.locator("#tvPay")).toHaveValue("", { timeout: 30_000 });

  // ---- THE REFUND PAST THE THRESHOLD: WETH too, and said so.
  const thr = BigInt(await p.evaluate(() => window.CurbApp.state.view.graduationThreshold.toString()));
  await setUp(p, "buy", (Number((thr * 3n) / 2n) / 1e18).toString(), { slip: 10 });
  w0 = await balanceOf(WETH, wallet);
  fromBlock = await nextBlock();
  await press(p, "Done, in one transaction through the CURB router");
  const bought = (await routerEvents(BOUGHT, fromBlock)).filter((e) => e.who === wallet)[0];
  const ethRefund = wordAt(bought.data, 5);
  expect(ethRefund > 0n, "the buy was not refunded, so this proves nothing").toBe(true);
  expect(await balanceOf(WETH, wallet) - w0, "the refund did not arrive as WETH").toBe(ethRefund);
  await expect(p.locator("#msg"), "a refund paid as WETH was reported as ETH")
    .toContainText("came back to you in the same transaction - as WETH, because this account would not take ether");
  expect((await exactOf(p))["WETH refund"], "the report's WETH refund is not the event's").toBe(ethRefund);
  await p.close();
});

test("the router's refusals are found before the wallet is asked, and said in words", async () => {
  test.setTimeout(240_000);
  const token = await nvdaLaunch();
  const buyer = await freshAccount("refused by the router");
  // THE RPC ANSWERS THE SIMULATION WITH THE ROUTER'S OWN ERRORS, as it would
  // for a router that refuses; everything else is the run's node.
  const HOST = "http://router-refuses.test:8701";
  let refusal = null;
  const p = await openToken(token, buyer, { rpc: HOST, before: (pg) => routeEndpoint(pg, HOST, (b) =>
    (refusal && isCallToRouter(b) ? { error: { code: 3, message: "execution reverted", data: refusal } } : undefined)) });
  await setUp(p, "buy", "0.01");
  await expect(p.locator("#tvQuote")).toContainText("1 confirmation: the CURB router", { timeout: 30_000 });
  const before = await sentCount(p);
  const cases = [
    [sel("IssuerForbids(address,bytes32,uint64)") + pad(buyer) + keccak("TRANSFER_SENDER_POLICY").slice(2) + word(7),
      new RegExp("does not let " + buyer + " send or receive it \\(policy 7\\)\\. Nothing was sent\\.", "i")],
    [sel("Expired(uint256,uint256)") + word(1) + word(2), /its deadline passed before it could be mined\. Nothing was sent\./],
    [sel("BlacklistedBy(address,address)") + pad(NVDAC) + pad(ROUTER), /has blacklisted the CURB router\. Nothing was sent\./],
  ];
  for (const [data, says] of cases) {
    refusal = data;
    await press(p, says);
    await expect(p.locator("#msg")).toContainText("The CURB router would refuse this buy");
  }
  expect(await sentCount(p), "the wallet was asked to sign a transaction the router refuses").toBe(before);
  await p.close();
});

test("a router transaction that carries no router event is reported as an error, not as done", async () => {
  test.setTimeout(240_000);
  const token = await nvdaLaunch();
  const code = await rpc("eth_getCode", [ROUTER, "latest"]);
  await inSnapshot(async () => {
    // AN ENDPOINT THAT CLAIMS THE ROUTER IS THERE while the chain holds code
    // that takes the ETH and does nothing (STOP).
    const HOST = "http://router-lies.test:8701";
    const buyer = await freshAccount("no router event");
    await rpc("anvil_setCode", [ROUTER, "0x00"]);
    const p = await openToken(token, buyer, { rpc: HOST, before: (pg) => routeEndpoint(pg, HOST, (b) =>
      (isGetCodeOfRouter(b) ? { result: code } : undefined)) });
    await setUp(p, "buy", "0.01");
    await expect(p.locator("#tvQuote")).toContainText("1 confirmation: the CURB router", { timeout: 30_000 });
    await press(p, "carries no BoughtWithEth event from the CURB router");
    await expect(p.locator("#msg"), "a router call with no router event was reported as a success").toHaveClass(/err/);
    await expect(p.locator("#msg")).not.toContainText("Done");
    await p.close();
  });
});

test("the router's verdict: a failed read is asked again, and a verdict belongs to one endpoint on one chain", async () => {
  test.setTimeout(240_000);
  const token = await nvdaLaunch();
  const A = "http://router-cache-a.test:8701";
  const B = "http://router-cache-b.test:8701";
  let modeA = "fail";
  const p = await openLong(token, OWNER, A, APP.factory, async (pg) => {
    await routeEndpoint(pg, A, (b) => {
      if (modeA === "fail" && isGetCodeOfRouter(b)) return { http: 503 };
      if (modeA === "other chain" && b.method === "eth_chainId") return { result: "0x1" };
      if (modeA === "other chain" && isGetCodeOfRouter(b)) return { result: "0x" };
      return undefined;
    });
    await routeEndpoint(pg, B, (b) => (isGetCodeOfRouter(b) ? { result: "0x00" } : undefined));
  });
  const q = p.locator("#curveQuote");
  await longQuote(p, "buy", "eth", "0.01");
  await expect(q).toContainText("the CURB router's code could not be read just now", { timeout: 30_000 });
  modeA = "real";
  await longQuote(p, "buy", "eth", "0.011");
  await expect(q, "a failed read was kept as the verdict").toContainText("1 confirmation: the CURB router", { timeout: 30_000 });
  modeA = "other chain";
  await longQuote(p, "buy", "eth", "0.012");
  await expect(q, "a verdict on chain 8453 was used for another chain").toContainText("the CURB router is not deployed on this network", { timeout: 30_000 });
  modeA = "real";
  // ANOTHER ENDPOINT, serving other code at the router's address.
  await p.evaluate((u) => { const e = document.getElementById("rpc"); e.value = u; e.dispatchEvent(new Event("change")); }, B);
  await expect.poll(() => p.evaluate(() => window.CurbApp.state.chainCfg.rpc), { timeout: 30_000 }).toBe(B);
  await expect(p.locator("#status")).toHaveText("Selling", { timeout: 30_000 });
  await longQuote(p, "buy", "eth", "0.013");
  await expect(q, "one endpoint's verdict was used for another").toContainText("is not the router this page knows", { timeout: 30_000 });
  await p.close();
});

test("on a WETH pair the card offers WETH beside ETH, and WETH chosen is spent and paid as WETH, nothing wrapped or unwrapped", async () => {
  test.setTimeout(300_000);
  const token = await wethLaunch();
  const who = await freshAccount("holds weth");
  await sendMined({ from: who, to: WETH, data: sel("deposit()"), value: "0x" + (5n * 10n ** 17n).toString(16) });
  await rpc("anvil_setBalance", [who, "0x" + (2n * 10n ** 16n).toString(16)]);   // 0.02 ETH, for gas
  const p = await openToken(token, who);
  await cardSide(p, "buy");
  await expect(p.locator("#tvPayAsset")).toHaveText("ETH");
  // ETH CHOSEN, THROUGH THE ROUTER: the ETH alone is what it can spend.
  await expect(p.locator("#tvPayAvail"), "an ETH buy through the router counts the WETH held")
    .toHaveText("0.0197 available", { timeout: 30_000 });
  await p.fill("#tvPay", "0.1");
  await expect(p.locator("#tvQuote"), "the WETH held was not pointed to")
    .toContainText("holds 0.5 WETH, which an ETH buy does not spend: choose WETH on the chip to spend it", { timeout: 30_000 });
  await p.fill("#tvPay", "");
  // ---- WETH CHOSEN: counted, spent, nothing wrapped.
  await payWith(p, "asset");
  await expect(p.locator("#tvPayAsset")).toHaveText("WETH");
  await expect(p.locator("#tvPayAvail"), "the WETH held is not what is available").toHaveText("0.5 available", { timeout: 30_000 });
  await p.fill("#tvPay", "0.1");
  await expect(p.locator("#tvAct")).toHaveText(/^Buy \$/, { timeout: 30_000 });
  let w0 = await balanceOf(WETH, who);
  let before = await sentCount(p);
  await press(p, "Done. The curve gave you");
  let sent = await sentSince(p, before);
  expect(sent.map((t) => t.data.slice(0, 10)), "a WETH buy is not approve then buy, with nothing wrapped")
    .toEqual([sel("approve(address,uint256)"), sel("buy(uint256,uint256,address)")]);
  expect(w0 - await balanceOf(WETH, who), "the buy did not spend the WETH held").toBe(10n ** 17n);
  await expect(p.locator("#tvPay")).toHaveValue("", { timeout: 30_000 });
  // ---- A SALE FOR WETH: paid WETH, nothing unwrapped.
  await setUp(p, "sell", "50%", { with: "asset" });
  await expect(p.locator("#tvGetAsset")).toHaveText("WETH");
  w0 = await balanceOf(WETH, who);
  const fromBlock = await nextBlock();
  before = await sentCount(p);
  await press(p, "Done. The curve gave you");
  sent = await sentSince(p, before);
  expect(sent.some((t) => t.to === WETH), "something was wrapped or unwrapped on a WETH sale").toBe(false);
  expect(sent[sent.length - 1].data.slice(0, 10)).toBe(sel("sell(uint256,uint256,address)"));
  const curve = await curveOf(p);
  const sells = await rpc("eth_getLogs", [{ address: curve, topics: [keccak("CurveSell(address,address,uint256,uint256,uint256,uint256)")], fromBlock, toBlock: "latest" }]);
  expect(await balanceOf(WETH, who) - w0, "the sale's WETH is not in the wallet").toBe(wordAt(sells[0].data, 1));
  await expect(p.locator("#msg")).not.toContainText("unwrapped");
  await p.close();
});

test("the long page starts a WETH pair's curve on ETH - one send, to the router - and its other choice is WETH", async () => {
  test.setTimeout(240_000);
  const token = await wethLaunch();
  const buyer = await freshAccount("long page weth buyer");
  const p = await openLong(token, buyer, STATE.rpc, await factoryFor(WETH));
  expect(await p.locator("#curveVia").inputValue(), "a WETH pair's curve does not start on ETH").toBe("eth");
  await expect(p.locator('#curveVia option[value="quote"]')).toHaveText("WETH");
  await p.fill("#curveAmount", "0.01");
  await expect(p.locator("#curveQuote")).toContainText("1 confirmation: the CURB router wraps your ETH", { timeout: 30_000 });
  const before = await sentCount(p);
  await clearMsg(p);
  await p.click("#curveAct");
  await expect(p.locator("#msg")).toContainText("Done, in one transaction through the CURB router", { timeout: 120_000 });
  expect((await sentSince(p, before)).map((t) => t.to), "the long page's ETH buy on a WETH pair is not one send to the router").toEqual([ROUTER]);
  await p.close();
});

test("an ETH sale on cbBTC and on cbXRP is two sends and then one, and the node keeps mining while it is priced", async () => {
  test.setTimeout(480_000);
  for (const [label, asset, sym] of [["cbBTC", CBBTC, "RBT"], ["cbXRP", CBXRP, "RXR"]]) {
    const token = asset === CBBTC ? await btcLaunch() : await createOn(await factoryFor(asset), "Router Xrp", sym);
    const seller = await freshAccount(label + " seller");
    // EVERY QuoterV2 CALL THE PAGE MAKES, as sent. Without a gas cap the node
    // simulates the thin cbBTC/WETH 0.01% tier for about 34M gas: on a warm
    // fork that is half a second, on a fresh one every slot is fetched from
    // upstream and the node is held for longer than 20 s (review, round 2).
    const quoterCalls = [];
    const p = await openToken(token, seller, { before: (pg) => pg.on("request", (r) => {
      try {
        const b = JSON.parse(r.postData() || "null");
        if (b && b.method === "eth_call" && String((b.params[0] || {}).to || "").toLowerCase() === QUOTER_V2) quoterCalls.push(b.params[0]);
      } catch { /* not JSON-RPC */ }
    }) });
    await setUp(p, "buy", "0.02");
    await press(p, "Done, in one transaction through the CURB router");
    await expect(p.locator("#tvPay")).toHaveValue("", { timeout: 30_000 });
    quoterCalls.length = 0;
    await setUp(p, "sell", "50%", { with: "eth" });
    await expect(p.locator("#tvQuote")).toContainText("2 confirmations (first sale of this token)", { timeout: 30_000 });
    // THE SALE'S QUOTE ASKED EVERY TIER INTO WETH - for cbBTC the thin 0.01%
    // one too - AND NONE OF THEM WITHOUT A CAP.
    expect(quoterCalls.length, "the sale was priced without QuoterV2, so this proves nothing").toBeGreaterThan(0);
    if (asset === CBBTC) {
      expect(quoterCalls.some((c) => c.data.toLowerCase().includes(CBBTC.slice(2) + "000064" + WETH.slice(2))),
        "the thin cbBTC/WETH 0.01% tier was never quoted, so this proves nothing").toBe(true);
    }
    for (const c of quoterCalls) {
      expect(c.gas !== undefined && BigInt(c.gas) <= 3_000_000n, "a QuoterV2 quote was sent with no gas cap: " + JSON.stringify(c.gas)).toBe(true);
    }
    await nodeStillMines("pricing an ETH sale on " + label);
    let before = await sentCount(p);
    let fromBlock = await nextBlock();
    await press(p, "Done, in one transaction through the CURB router");
    let sent = await sentSince(p, before);
    expect(sent.length, "the first ETH sale on " + label + " is not two sends").toBe(2);
    const ev = (await routerEvents(SOLD, fromBlock)).filter((e) => e.who === seller.toLowerCase());
    expect(ev.length).toBe(1);
    expect((await exactOf(p)).received).toBe(wordAt(ev[0].data, 3));
    await expect(p.locator("#tvPay")).toHaveValue("", { timeout: 30_000 });
    await setUp(p, "sell", "50%", { with: "eth" });
    await expect(p.locator("#tvQuote")).toContainText("1 confirmation: the CURB router sells", { timeout: 30_000 });
    await nodeStillMines("pricing a second ETH sale on " + label);
    before = await sentCount(p);
    await press(p, "Done, in one transaction through the CURB router");
    sent = await sentSince(p, before);
    expect(sent.map((t) => t.to), "the second ETH sale on " + label + " is not one send to the router").toEqual([ROUTER]);
    await p.close();
  }
});

// ================================================================== the create form
test("the create form refuses the router, WETH and SwapRouter02 as the creator wallet", async () => {
  const p = await newPage(OWNER);
  await p.goto("/app.html?" + new URLSearchParams({ rpc: STATE.rpc, factory: APP.factory, lens: APP.lens }).toString());
  await p.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
  await p.evaluate(() => window.CurbApp.connect());
  await expect(p.locator("#sumGrad")).not.toHaveText("—", { timeout: 30_000 });
  const advanced = p.locator("#advanced");
  if (!(await advanced.evaluate((d) => d.open))) await advanced.locator("summary").click();
  await p.fill("#nName", "Router Payee");
  await p.fill("#nSymbol", "RPY");
  for (const [addr, words] of [[ROUTER, "the CURB router's address"], [WETH, "WETH's address"], [SWAP_ROUTER02, "Uniswap's SwapRouter02"]]) {
    const before = await sentCount(p);
    await p.fill("#nCreator", addr);
    await p.click("#create");
    await expect(p.locator("#msg"), addr + " was not refused").toContainText("The creator wallet is " + words, { timeout: 30_000 });
    expect(await sentCount(p), "something was sent for a launch paying " + addr).toBe(before);
  }
  await p.close();
});

// ================================================================== what the router wiring had dropped, put back
//
// THE SITE BEFORE THE ROUTER (ad391631) SAID THESE, and the router commits
// lost them without anybody asking: the fee and the creator tax on a sale for
// ETH, the warning when the balance moved by another number, the seller in the
// trade list, the expected amount of an ETH buy's swap, and an accurate word
// under the Buy button. Each is held against the chain, not against the page.
const CURVE_SELL = keccak("CurveSell(address,address,uint256,uint256,uint256,uint256)");
/// The curve's own CurveSell in one transaction: tokensIn, quoteOut, fee, tax.
async function curveSellIn(curve, hash, fromBlock) {
  const logs = (await rpc("eth_getLogs", [{ address: curve, topics: [CURVE_SELL], fromBlock, toBlock: "latest" }]))
    .filter((l) => l.transactionHash === hash);
  expect(logs.length, "the sale's transaction carries no CurveSell of this curve").toBe(1);
  return { tokensIn: wordAt(logs[0].data, 0), quoteOut: wordAt(logs[0].data, 1), fee: wordAt(logs[0].data, 2),
    tax: wordAt(logs[0].data, 3), seller: addrOf(logs[0].topics[1]), recipient: addrOf(logs[0].topics[2]) };
}
const shortAddr = (a) => a.slice(0, 6) + "…" + a.slice(-4);

test("a sale for ETH through the router says the fee and the creator tax CurveSell charged, on the WETH pair and on NVDAc, and the trade list names the seller", async () => {
  test.setTimeout(480_000);
  for (const [label, launch, sym] of [["WETH", wethLaunch, "WETH"], ["NVDAc", nvdaLaunch, "NVDAc"]]) {
    const token = await launch();
    const seller = await freshAccount("restore fee and tax " + label);
    const p = await openToken(token, seller);
    await setUp(p, "buy", "0.02");
    await press(p, "Done, in one transaction through the CURB router");
    await expect(p.locator("#tvPay")).toHaveValue("", { timeout: 30_000 });
    await setUp(p, "sell", "50%", { with: "eth" });
    await expect(p.locator("#tvQuote")).toContainText("2 confirmations (first sale of this token)", { timeout: 30_000 });
    const fromBlock = await nextBlock();
    await press(p, "Done, in one transaction through the CURB router");
    const ev = (await routerEvents(SOLD, fromBlock)).filter((e) => e.who === seller.toLowerCase());
    expect(ev.length).toBe(1);
    const cs = await curveSellIn(await curveOf(p), ev[0].log.transactionHash, fromBlock);
    // THE PRECONDITION: the curve was paid to the router, which is why the
    // router's event alone could not say the fee, and why the list showed it.
    expect(cs.recipient, "the curve did not pay the router, so this proves nothing").toBe(ROUTER);
    expect(cs.fee > 0n && cs.tax >= 0n, "this sale charged no fee, so this proves nothing").toBe(true);
    const x = await exactOf(p);
    expect(x.fee, label + ": the report's fee is not CurveSell's").toBe(cs.fee);
    expect(x.tax, label + ": the report's tax is not CurveSell's").toBe(cs.tax);
    expect(x["curve paid"]).toBe(cs.quoteOut);
    expect(x.sold).toBe(cs.tokensIn);
    expect(x.received).toBe(wordAt(ev[0].data, 3));
    // IN WORDS TOO, in the pair's asset - and on the WETH pair what the curve
    // paid is said again, not only in the exact line.
    const fmtQ = (v) => p.evaluate(([v, d]) => window.CurbApp.fmtSmall(BigInt(v), d, 6),
      [v.toString(), sym === "WETH" ? 18 : 8]);
    await expect(p.locator("#msg")).toContainText(`the curve paid ${await fmtQ(cs.quoteOut)} ${sym}`);
    await expect(p.locator("#msg")).toContainText(`charging ${await fmtQ(cs.fee)} ${sym} fee and ${await fmtQ(cs.tax)} ${sym} creator tax`);
    // NOTHING ELSE MOVED THIS TOKEN, so the report says nothing about it.
    await expect(p.locator("#msg")).not.toContainText("something else moved this token");
    // THE TRADE LIST: the seller, as SoldForEth names them - never the router.
    const first = p.locator("#tvList .tvLine").first();
    await expect(first, label + ": the sale is not the newest line").toContainText("↘", { timeout: 30_000 });
    await expect(first, label + ": the trade list does not name the seller").toContainText(shortAddr(seller), { timeout: 30_000 });
    await expect(p.locator("#tvList"), label + ": a sale is listed under the router's address").not.toContainText(shortAddr(ROUTER));
    await p.close();
  }
});

test("a router trade whose token balance moved by another number while it was in flight says so, as the trades before the router did", async () => {
  test.setTimeout(400_000);
  const token = await nvdaLaunch();
  const who = await freshAccount("restore drift");
  const p = await openToken(token, who);
  const curve = await curveOf(p);
  // SOMEBODY ELSE'S BUY, PAID TO THIS ACCOUNT, mined while the wallet asks:
  // the account's balance of the token moves by more than its own trade.
  const gift = 10n ** 6n;   // 0.01 NVDAc of the deployer's
  await sendMined({ from: OWNER, to: NVDAC, data: sel("approve(address,uint256)") + pad(curve) + word(4n * gift) });
  const giftBuy = () => sendMined({ from: OWNER, to: curve, data: sel("buy(uint256,uint256,address)") + word(gift) + word(0) + pad(who) });
  // ---- A BUY
  await setUp(p, "buy", "0.02");
  let meddle = await interfereDuringNextSend(p, giftBuy);
  await clearMsg(p);
  await p.click("#tvAct");
  await meddle();
  await expect(p.locator("#msg")).toContainText("Done, in one transaction through the CURB router", { timeout: 120_000 });
  await expect(p.locator("#msg"), "a buy whose balance moved by more was reported without a word")
    .toContainText("Your balance of this token moved by", { timeout: 10_000 });
  await expect(p.locator("#msg")).toContainText("something else moved this token too");
  await expect(p.locator("#tvPay")).toHaveValue("", { timeout: 30_000 });
  // ---- A SALE, the router's allowance given first so the sale is the one send.
  await sendMined({ from: who, to: token, data: sel("approve(address,uint256)") + pad(ROUTER) + "f".repeat(64) });
  await setUp(p, "sell", "50%", { with: "eth" });
  await expect(p.locator("#tvQuote")).toContainText("1 confirmation: the CURB router sells", { timeout: 30_000 });
  meddle = await interfereDuringNextSend(p, giftBuy);
  const before = await sentCount(p);
  await clearMsg(p);
  await p.click("#tvAct");
  await meddle();
  await expect(p.locator("#msg")).toContainText("Done, in one transaction through the CURB router", { timeout: 120_000 });
  expect((await sentSince(p, before)).length, "the sale was not one send").toBe(1);
  await expect(p.locator("#msg"), "a sale whose balance moved by another number was reported without a word")
    .toContainText("Your balance of this token moved by", { timeout: 10_000 });
  await p.close();
});

test("an ETH buy on a stock pair says what its swap is expected to deliver beside its floor, and that it asks for no approval", async () => {
  test.setTimeout(240_000);
  const token = await nvdaLaunch();
  const buyer = await freshAccount("restore about");
  const p = await openToken(token, buyer);
  await setUp(p, "buy", "0.01");
  await expect(p.locator("#tvQuote")).toContainText("1 confirmation: the CURB router swaps your ETH into", { timeout: 30_000 });
  const r = await p.evaluate(async () => {
    const v = await window.CurbApp.computeCurveQuote();
    const d = window.CurbApp.state.ctx.quoteDecimals;
    return { via: v.via, mid: window.CurbApp.fmt(v.mid, d, 6), min: window.CurbApp.fmt(v.midMin, d, 6) };
  });
  expect(r.via).toBe("router");
  expect(r.mid === r.min, "the expected and the floor are the same figure, so this proves nothing").toBe(false);
  await expect(p.locator("#tvQuote"), "the expected amount of the swap is gone")
    .toContainText(`swaps your ETH into about ${r.mid} NVDAc (at least ${r.min}) and buys on the curve`);
  await expect(p.locator("#tvActNote"), "an ETH buy through the router speaks of an allowance").toHaveText("");
  // AND THE SALE'S NOTE IS STILL THE ROUTER'S ALLOWANCE, said once.
  await press(p, "Done, in one transaction through the CURB router");
  await expect(p.locator("#tvPay")).toHaveValue("", { timeout: 30_000 });
  await setUp(p, "sell", "50%", { with: "eth" });
  await expect(p.locator("#tvActNote")).toContainText("once, with no limit", { timeout: 30_000 });
  // AND A BUY PAID IN THE ASSET STILL SAYS ITS ALLOWANCE.
  await p.fill("#tvPay", "");
  await setUp(p, "buy", "0.01", { with: "asset" });
  await expect(p.locator("#tvActNote"), "a buy paid in the asset speaks of the router's allowance").toHaveText("", { timeout: 30_000 });
  await p.close();
});

test("on cbBTC the card's fee and tax line never rounds a fee that is not zero down to 0", async () => {
  test.setTimeout(240_000);
  const token = await btcLaunch();
  const who = await freshAccount("restore tiny btc fee");
  const p = await openToken(token, who);
  await setUp(p, "buy", "0.00001", { with: "asset" });
  await expect(p.locator("#tvQuote")).toContainText("Fee and tax, taken from this trade", { timeout: 30_000 });
  const f = await p.evaluate(async () => {
    const v = await window.CurbApp.computeCurveQuote();
    const x = v.q.fee + v.q.tax;
    return { raw: x.toString(), six: window.CurbApp.fmt(x, 8, 6), shown: window.CurbApp.fmtSmall(x, 8, 6) };
  });
  expect(BigInt(f.raw) > 0n, "this trade charges nothing, so this proves nothing").toBe(true);
  expect(f.six, "six places already show this fee, so this proves nothing").toBe("0");
  expect(f.shown).not.toBe("0");
  await expect(p.locator("#tvQuote")).toContainText(`Fee and tax, taken from this trade: ${f.shown} cbBTC`);
  await p.close();
});

test("the long page names an ETH payment on a WETH pair in ETH, and the router's first-sale approval only while it is still to come", async () => {
  test.setTimeout(400_000);
  const factory = await factoryFor(WETH);
  const token = await createOn(factory, "Restore Long Weth", "RLW");
  const who = await freshAccount("restore long page");
  const p = await openLong(token, who, STATE.rpc, factory);
  const q = p.locator("#curveQuote");
  // THE SIDE SAYS WHAT IT DOES; WHAT IS PAID IS THE "Pay with" CHOICE BESIDE IT.
  await expect(p.locator('#curveSide option[value="buy"]')).toHaveText("Buy tokens");
  await expect(p.locator('#curveSide option[value="sell"]')).toHaveText("Sell tokens");
  expect(await p.locator("#curveVia").inputValue()).toBe("eth");
  await longQuote(p, "buy", "eth", "0.01");
  await expect(q).toContainText("1 confirmation: the CURB router wraps your ETH", { timeout: 30_000 });
  await expect(q.locator(".row", { hasText: "you pay" }), "an ETH payment on a WETH pair is not said in ETH")
    .toContainText("0.01 ETH, wrapped one for one into WETH for the curve");
  // PAST THE THRESHOLD: what comes back is ETH, and the row says so.
  const thr = BigInt(await p.evaluate(() => window.CurbApp.state.view.graduationThreshold.toString()));
  await longQuote(p, "buy", "eth", (Number((thr * 3n) / 2n) / 1e18).toString());
  await expect(q).toContainText("It comes back to you as ETH, in the same transaction.", { timeout: 30_000 });
  await expect(q.locator(".row", { hasText: "refunded to you" }), "the refund of an ETH buy is labelled WETH").toContainText(/[\d.,]+ ETH$/);
  // ---- THE SALE'S NOTE: the approval said while it is to come, and not after.
  await longQuote(p, "buy", "eth", "0.02");
  await expect(q).toContainText("1 confirmation", { timeout: 30_000 });
  await clearMsg(p);
  await p.click("#curveAct");
  await expect(p.locator("#msg")).toContainText("Done, in one transaction through the CURB router", { timeout: 120_000 });
  await longQuote(p, "sell", "eth", "1000");
  await expect(q).toContainText("2 confirmations (first sale of this token)", { timeout: 30_000 });
  await expect(q).toContainText("Your wallet first asks to let the router move this token - once, with no limit.");
  await sendMined({ from: who, to: token, data: sel("approve(address,uint256)") + pad(ROUTER) + "f".repeat(64) });
  await longQuote(p, "sell", "eth", "1001");
  await expect(q).toContainText("1 confirmation: the CURB router sells to the curve and pays you ETH in one transaction.", { timeout: 30_000 });
  await expect(q, "the first-sale approval is still announced after it was given").not.toContainText("first asks");
  await p.close();
});

test("the create form says an ETH pair is bought with ETH through the router in one transaction", async () => {
  const p = await newPage(OWNER);
  await p.goto("/app.html?" + new URLSearchParams({ rpc: STATE.rpc, factory: await factoryFor(WETH), lens: APP.lens }).toString());
  await p.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
  const note = p.locator("#quoteLiquidity");
  await expect(note).toContainText("priced in WETH", { timeout: 30_000 });
  await expect(note).toContainText("A buyer pays ETH, and the CURB router wraps it and buys in the same transaction");
  await expect(note, "the note still says every ETH buy wraps first, as its own transaction")
    .toContainText("only where the router is not available does this page wrap ETH into WETH first");
  await p.close();
});

// ================================================================== screenshots, on request
test("the swap card, for the record: an ETH buy on a stock pair and an ETH sale, at 1280 and 390 wide", async () => {
  test.skip(!SHOTS, "set CURB_SHOTS to a directory to take them");
  test.setTimeout(240_000);
  fs.mkdirSync(SHOTS, { recursive: true });
  const token = await nvdaLaunch();
  const who = await freshAccount("screens");
  const p = await openToken(token, who);
  await setUp(p, "buy", "0.02");
  await press(p, "Done, in one transaction through the CURB router");
  await expect(p.locator("#tvPay")).toHaveValue("", { timeout: 30_000 });
  // THE LAST TRADE'S NOTICE IS CLOSED, so it does not sit over the card.
  await p.evaluate(() => { document.getElementById("msg").hidden = true; });
  for (const width of [1280, 390]) {
    await p.setViewportSize({ width, height: 1000 });
    await setUp(p, "buy", "0.01");
    await expect(p.locator("#tvQuote")).toContainText("1 confirmation", { timeout: 30_000 });
    await p.locator(".tvSwap").screenshot({ path: path.join(SHOTS, `eth-buy-stock-${width}.png`) });
    await p.fill("#tvPay", "");
    await setUp(p, "sell", "50%", { with: "eth" });
    await expect(p.locator("#tvQuote")).toContainText("confirmation", { timeout: 30_000 });
    await p.locator(".tvSwap").screenshot({ path: path.join(SHOTS, `eth-sale-stock-${width}.png`) });
    await p.fill("#tvPay", "");
  }
  await p.close();
});
