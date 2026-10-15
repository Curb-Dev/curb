// THE COINS OF 2026-10-15: USDC, VIRTUAL AND AERO, AS QUOTE ASSETS.
//
// The owner's list of fourteen adds three coins the site had never priced a
// launch against, and each breaks an assumption the other eleven let stand:
//   - USDC is the middle of every two-hop route, and here it is the END: the
//     ETH route is WETH -> USDC in one hop, and nothing may ask for a USDC/USDC
//     pool or price a USDC -> USDC leg (app.js routesThroughUsdc). It is six
//     decimals, and a FiatToken with a blacklist, like cbXRP.
//   - VIRTUAL and AERO are plain 18-decimal ERC-20s: no B20 policy and no
//     blacklist, so both questions revert - which must read as "nothing to
//     refuse", the way WETH's empty answer does, never as a refusal.
// What these tests pin, each against the chain: the picker offers the three as
// coins; the create form's depth line for USDC is priced through the one hop;
// an ETH buy (and, on USDC, an ETH sale) is one send to the CURB router along
// the right path, its conversion checked against the asset's OWN Chainlink feed
// (prices.js USD_FEEDS) to the basis point; the token page writes the asset's
// amounts at its own decimals and its dollars by its own feed; and the issuer
// row says a plain ERC-20 has no policy rather than that it could not be read.
//
// THE STACKS are the list's own: demo-app.sh builds a factory for every entry
// of DeployCurb.quoteAssets(), which names all three, on the full-flow
// registry, and factoryFor() finds each by its quoteToken().
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

const STATE = JSON.parse(fs.readFileSync(path.join(__dirname, ".state.json"), "utf8"));
const STUB = fs.readFileSync(path.join(__dirname, "..", "wallet-stub.js"), "utf8");
const APP = STATE.app;
const OWNER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const VIRTUAL = "0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b";
const AERO = "0x940181a94a35a4569e4529a3cdfb74e38fd98631";
// CHAINLINK'S FEEDS, WRITTEN HERE AND NOT READ FROM prices.js: the test holds
// the page to the feed each asset must be priced by.
const FEED = {
  [WETH]: "0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70",
  [USDC]: "0x7e860098f58bbfc8648a4311b374b1d669a2bc6b",
  [VIRTUAL]: "0xeaf310161c9ef7c813a14f8fef6fb271434019f7",
  [AERO]: "0x4ec5970fc728c5f65ba413992cd5ff6fd70fcff0",
};
const ROUTER = "0xea20c3266229a01cd0f45d9c7921a45d5b359561";
const QUOTER_V2 = "0x3d4e44eb1374240ce5f1b871ab261cd16335b76a";
const V3_FACTORY = "0x33128a8fc17869897dce68ed026d694621f6fdfd";
const MAX = (1n << 256n) - 1n;

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
const keccak = (s) => window.CurbKeccak.keccak256("0x" + window.CurbAbi.utf8Hex(s));
const sel = (s) => keccak(s).slice(0, 10);
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
const pad = (a) => String(a).toLowerCase().replace(/^0x/, "").padStart(64, "0");
const addrOf = (raw) => "0x" + String(raw).replace(/^0x/, "").slice(24, 64);
const wordAt = (raw, i) => BigInt("0x" + String(raw).replace(/^0x/, "").slice(i * 64, i * 64 + 64));
const slip = (x, bps) => (x * (10000n - BigInt(bps))) / 10000n;
const balanceOf = async (token, who, block) => BigInt(await ethCall(token, sel("balanceOf(address)") + pad(who), block));
const nextBlock = async () => "0x" + (BigInt(await rpc("eth_blockNumber", [])) + 1n).toString(16);
const BOUGHT = keccak("BoughtWithEth(address,address,address,address,uint256,uint256,uint256,uint256,uint256)");
const SOLD = keccak("SoldForEth(address,address,address,address,uint256,uint256,uint256,bool)");

/// AN AMOUNT AT A GIVEN SCALE, as the page prints one (app.js fmt) - written
/// out here so the scale is the test's, not the page's.
function fmtAt(value, decimals, places) {
  const base = 10n ** BigInt(decimals);
  const whole = (BigInt(value) / base).toLocaleString("en-US");
  const frac = (BigInt(value) % base).toString().padStart(decimals, "0").slice(0, places).replace(/0+$/, "");
  return whole + (frac ? "." + frac : "");
}
/// A Chainlink feed's answer in dollars, at a block.
async function feedUsd(feed, block = "latest") {
  const raw = await ethCall(feed, sel("latestRoundData()"), block);
  const dec = Number(BigInt(await ethCall(feed, sel("decimals()"), block)));
  return Number(wordAt(raw, 1)) / 10 ** dec;
}

/// THE DEPTH QUESTION, ASKED FROM HERE FIRST AND WAITED OUT - A FORK'S COST,
/// NOT THE PAGE'S. The create form asks QuoterV2 what one threshold costs along
/// every WETH tier (app.js quoteLiquidityNote), capped at 3,000,000 gas and
/// abandoned after four seconds. A tier with no liquidity - AERO/WETH at 0.05%
/// held 18 wei of AERO at the pinned block, VIRTUAL/WETH at 0.01% about 2 - is
/// walked tick word by tick word until that gas runs out, and on a fork each
/// word is a storage read fetched from the upstream endpoint through the one
/// queue every request to the node waits in. Measured 2026-10-15: the first
/// AERO create sat at "waiting for it to be mined" for over a minute behind the
/// abandoned walks, its transaction long mined. On a real node those reads are
/// local. Walked here once, with the page's own cap, the same question in the
/// same direction - so the buy's quotes, which walk the same words, find them.
async function walkWethTiers(quote, amountOut) {
  for (const fee of [100, 500, 3000, 10000]) {
    const pool = addrOf(await ethCall(V3_FACTORY, sel("getPool(address,address,uint24)") +
      encode([T.address, T.address, T.uint(24)], [WETH, quote, fee]).slice(2)));
    if (/^0x0{40}$/.test(pool)) continue;
    const path = "0x" + quote.slice(2) + fee.toString(16).padStart(6, "0") + WETH.slice(2);   // out first
    await rpc("eth_call", [{ to: QUOTER_V2, gas: "0x2dc6c0",
      data: sel("quoteExactOutput(bytes,uint256)") + encode([T.bytes, T.uint(256)], [path, amountOut]).slice(2) }, "latest"])
      .catch(() => null);   // a tier that cannot supply it reverts: that is an answer too
  }
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

/// A FRESH ACCOUNT OF ITS OWN: no code, the node signing for it, plenty of ether.
async function freshAccount(label) {
  const a = "0x" + keccak("curb assets.spec " + label + " " + Date.now()).slice(-40);
  expect(await rpc("eth_getCode", [a, "latest"]), "the account has code on this chain").toBe("0x");
  await rpc("anvil_impersonateAccount", [a]);
  await rpc("anvil_setBalance", [a, "0x" + (100n * 10n ** 18n).toString(16)]);
  return a;
}

// ------------------------------------------------------------------ the page
/// A page with the wallet stub, whose every request to the run's node is kept
/// (`p.bodies`, lowercased): what the page ASKED is part of what is tested.
async function newPage(account) {
  const p = await browserRef.newPage();
  p.on("pageerror", (e) => console.log("PAGE ERROR: " + (e.stack || e.message)));
  p.bodies = [];
  p.on("request", (r) => { if (r.url().startsWith(STATE.rpc)) p.bodies.push(String(r.postData() || "").toLowerCase()); });
  const cfg = { forward: true, chainId: "0x2105", account };
  await p.addInitScript({ content: [
    STUB, ";(function () {",
    "  window.ethereum = window.makeWallet(" + JSON.stringify(STATE.rpc) + ", " + JSON.stringify(cfg) + ");",
    "})();",
  ].join("\n") });
  return p;
}
/// THE ASK THAT MUST NEVER BE MADE: Uniswap v3's getPool for USDC against itself.
const usdcAgainstItself = "1698ee82" + pad(USDC) + pad(USDC);
const askedUsdcUsdc = (p) => p.bodies.filter((b) => b.includes(usdcAgainstItself)).length;
/// Whether the page read a feed's latestRoundData.
const readFeed = (p, feed) => p.bodies.some((b) => b.includes(feed) && b.includes(sel("latestRoundData()").slice(2)));

async function openApp(factory, account) {
  const p = await newPage(account);
  await p.goto("/app.html?" + new URLSearchParams({ rpc: STATE.rpc, factory, lens: APP.lens }).toString());
  await p.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
  await p.evaluate(() => window.CurbApp.connect());
  await expect.poll(() => p.evaluate(() => ((window.CurbApp.state.ctx || {}).quote || "").toLowerCase()),
    { timeout: 30_000, message: "the form never read the factory" }).not.toBe("");
  return p;
}
/// A launch made through the create form, and the issuer row the form showed
/// for its asset before it.
async function createOn(factory, name, symbol) {
  const p = await openApp(factory, OWNER);
  await expect(p.locator("#policyRow")).not.toHaveText(/connect a wallet|^—$/, { timeout: 30_000 });
  const policyRow = (await p.locator("#policyRow").textContent()).trim();
  await p.fill("#nName", name);
  await p.fill("#nSymbol", symbol);
  await p.click("#create");
  await expect(p.locator("#msg")).toContainText("Launched", { timeout: 60_000 });
  const token = await p.evaluate(() => window.CurbApp.state.chainCfg.token);
  await p.close();
  return { token, policyRow };
}
async function openToken(token, account) {
  const p = await newPage(account);
  await p.goto("/token/" + token + "?" + new URLSearchParams({ rpc: STATE.rpc, lens: APP.lens }).toString());
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
async function payWithEth(p) {
  const pick = p.locator(".tvAsset.tvPick");
  if (await pick.count() === 0) return;
  if ((await pick.textContent()).trim() === "ETH") return;
  await pick.click();
  await p.locator('#tvMenu button[data-choice="eth"]').click();
  await expect(p.locator("#tvMenu")).toHaveCount(0);
}
async function setUp(p, side, amount, slipPct) {
  await cardSide(p, side);
  await payWithEth(p);
  await p.fill("#tvSlip", String(slipPct));
  if (/%$/.test(amount)) {
    await expect.poll(async () => (await p.locator("#tvPayAvail").textContent()).trim().length, { timeout: 30_000 }).toBeGreaterThan(0);
    await p.click(`#tvPcts [data-pct="${parseInt(amount, 10)}"]`);
  } else await p.fill("#tvPay", amount);
  await expect(p.locator("#tvAct")).toHaveText(new RegExp("^" + (side === "buy" ? "Buy" : "Sell") + " \\$"), { timeout: 20_000 });
}
async function press(p) {
  await expect(p.locator("#tvAct")).toBeEnabled({ timeout: 30_000 });
  // A FRESH BLOCK FIRST, as router.spec.js does: the stub lets the node estimate
  // gas at the latest block, which can leave out a v3 oracle write.
  await rpc("evm_mine", []);
  await p.evaluate(() => { document.getElementById("msg").textContent = ""; });
  await p.click("#tvAct");
  await expect(p.locator("#msg")).toContainText("Done, in one transaction through the CURB router", { timeout: 120_000 });
}
const sentCount = (p) => p.evaluate(() => window.ethereum.sent.length);
const sentSince = async (p, n) =>
  (await p.evaluate(() => window.ethereum.sent.map((t) => ({ to: String(t.to || "").toLowerCase(), data: String(t.data || ""), value: t.value || "0x0" }))))
    .slice(n);
const argWords = (data) => { const h = data.replace(/^0x/, "").slice(8); const w = []; for (let i = 0; i < h.length; i += 64) w.push(h.slice(i, i + 64)); return w; };
function bytesArg(data, i) {
  const h = data.replace(/^0x/, "").slice(8);
  const off = Number(BigInt("0x" + h.slice(i * 64, i * 64 + 64))) * 2;
  const len = Number(BigInt("0x" + h.slice(off, off + 64))) * 2;
  return "0x" + h.slice(off + 64, off + 64 + len);
}
const quoterAt = async (pathHex, amountIn, block) =>
  wordAt(await ethCall(QUOTER_V2, sel("quoteExactInput(bytes,uint256)") + encode([T.bytes, T.uint(256)], [pathHex, amountIn]).slice(2), block), 0);
async function routerEvents(topic0, fromBlock) {
  const logs = await rpc("eth_getLogs", [{ address: ROUTER, topics: [topic0], fromBlock, toBlock: "latest" }]);
  return logs.map((l) => ({ log: l, who: addrOf(l.topics[1]), data: l.data }));
}

/// THE CONVERSION CHECK, WORKED OUT HERE FROM THE FEEDS THE ASSET MUST BE PRICED
/// BY: what the ETH leg pays below Chainlink's market, in basis points, for the
/// amounts the page itself quoted. A page that priced the asset by any other
/// feed - or by none - lands somewhere else.
async function conversionAt(quote, decimals, ethWei, quoteUnits, buy) {
  const eth = Number(ethWei) / 1e18 * await feedUsd(FEED[WETH]);
  const asset = Number(quoteUnits) / 10 ** decimals * await feedUsd(FEED[quote]);
  const [given, got] = buy ? [eth, asset] : [asset, eth];
  return got >= given ? 0 : Math.round((1 - got / given) * 10000);
}
/// The curve quote the card drew, read back as the page computed it.
const pageQuote = (p) => p.evaluate(async () => {
  const v = await window.CurbApp.computeCurveQuote();
  return { error: v.error || null, via: v.via || null, conv: v.conv ? v.conv.bps : null, unchecked: !!v.convUnchecked,
    amount: v.amount !== undefined ? String(v.amount) : null, mid: v.mid !== undefined ? String(v.mid) : null,
    qOut: v.q && v.q.out !== undefined ? String(v.q.out) : null, ethOut: v.ethOut !== undefined ? String(v.ethOut) : null };
});

/// THE TOKEN PAGE'S FIGURES IN THE PAIR'S UNITS AND IN DOLLARS: the progress
/// line at the asset's own decimals, from the curve's own reserve and the
/// factory's own threshold, and the market cap in dollars by the asset's feed.
async function holdsDecimalsAndFeed(p, factory, sym, decimals, feedName) {
  const curve = await p.evaluate(() => window.CurbApp.state.view.curve);
  const raised = BigInt(await ethCall(curve, sel("realQuoteReserve()")));
  const threshold = BigInt(await ethCall(factory, sel("graduationThreshold()")));
  expect(raised > 0n, "nothing was raised, so the scale of the line proves nothing").toBe(true);
  await expect(p.locator("#tvProgressText"), sym + "'s progress is not written at " + decimals + " decimals")
    .toHaveText(fmtAt(raised, decimals, 4) + " of " + fmtAt(threshold, decimals, 4) + " " + sym, { timeout: 30_000 });
  await expect(p.locator("#tvMcap"), "the market cap is not in dollars").toHaveText(/^\$/, { timeout: 30_000 });
  expect(await p.locator("#tvMcap").getAttribute("title"), "the dollars are not by " + feedName)
    .toContain("by " + feedName + " (Chainlink)");
}

// ================================================================== the picker
test("the picker offers USDC, VIRTUAL and AERO with the coins, and prices USDC's depth through its one hop", async () => {
  test.setTimeout(120_000);
  const want = { [USDC]: "USDC", [VIRTUAL]: "VIRTUAL", [AERO]: "AERO" };
  const factories = {};
  for (const q of Object.keys(want)) {
    factories[q] = await factoryFor(q);
    expect(factories[q], "demo-app.sh built no " + want[q] + " factory from DeployCurb.quoteAssets()").not.toBeNull();
  }
  const p = await openApp(APP.factory, OWNER);
  await expect.poll(() => p.evaluate(() => Array.from(document.querySelectorAll("#quotePick option")).filter((o) => o.value).length),
    { timeout: 30_000, message: "the quote picker never filled" }).toBeGreaterThan(3);
  const groups = await p.evaluate(() => Array.from(document.querySelectorAll("#quotePick optgroup")).map((g) => ({
    label: g.label, options: Array.from(g.querySelectorAll("option")).map((o) => ({ value: o.value.toLowerCase(), text: o.textContent })),
  })));
  const coins = (groups.find((g) => g.label === "Coins") || { options: [] }).options;
  const stocks = (groups.find((g) => g.label === "Stocks") || { options: [] }).options;
  for (const [q, sym] of Object.entries(want)) {
    const o = coins.find((x) => x.value === factories[q]);
    expect(o, sym + " is not offered with the coins").toBeTruthy();
    expect(o.text, sym + "'s option is not labelled with its symbol").toBe(sym);
    expect(stocks.some((x) => x.value === factories[q]), sym + " is offered as a stock").toBe(false);
  }
  // AND A CARD FOR EACH, under the Coins tab.
  for (const sym of Object.values(want)) {
    await expect(p.locator("#quoteGrid .qcard .qsym", { hasText: new RegExp("^" + sym + "$") }), "no " + sym + " card").toHaveCount(1);
  }

  // ---- USDC'S DEPTH: the threshold at six decimals, priced by the quoter
  // through WETH -> USDC alone, and no USDC/USDC pool asked for on the way.
  p.bodies.length = 0;
  await p.locator("#quoteGrid .qcard", { has: p.locator(".qsym", { hasText: /^USDC$/ }) }).click();
  await expect.poll(() => p.evaluate(() => ((window.CurbApp.state.ctx || {}).quote || "").toLowerCase()), { timeout: 30_000 }).toBe(USDC);
  const threshold = BigInt(await ethCall(factories[USDC], sel("graduationThreshold()")));
  await expect(p.locator("#quoteLiquidity")).toContainText(
    "A launch needs " + fmtAt(threshold, 6, 2) + " USDC to graduate", { timeout: 30_000 });
  await expect(p.locator("#quoteLiquidity")).toContainText("so the market can supply it");
  expect(askedUsdcUsdc(p), "the page asked Uniswap for a USDC/USDC pool").toBe(0);
  await p.close();
});

// ================================================================== USDC
test("a USDC launch: an ETH buy is one send along WETH -> USDC, one hop, checked against USDC / USD; the page writes six decimals", async () => {
  test.setTimeout(300_000);
  const factory = await factoryFor(USDC);
  const { token } = await createOn(factory, "Assets Usdc", "AUS");
  const buyer = await freshAccount("usdc buyer");
  const p = await openToken(token, buyer);
  await expect(p.locator("#tvStatus")).toHaveText("Selling");
  p.bodies.length = 0;
  await setUp(p, "buy", "0.01", 2);
  await expect(p.locator("#tvQuote")).toContainText(/1 confirmation: the CURB router swaps your ETH into about [\d.,]+ USDC/, { timeout: 30_000 });
  // THE CONVERSION IS CHECKED, AND BY USDC'S OWN FEED: the figure on the card is
  // the one the two feeds give for the amounts the page quoted.
  await expect(p.locator("#tvQuote")).toContainText(/Conversion: [\d.]+% below market/);
  await expect(p.locator("#tvQuote")).not.toContainText("not checked");
  const q = await pageQuote(p);
  expect(q.error, "the page could not quote the buy").toBeNull();
  expect(q.via).toBe("router");
  expect(q.unchecked, "the swap into USDC went unchecked").toBe(false);
  const want = await conversionAt(USDC, 6, BigInt(q.amount), BigInt(q.mid), true);
  expect(Math.abs(q.conv - want), `the conversion reads ${q.conv} bps where ETH / USD and USDC / USD give ${want}`).toBeLessThanOrEqual(1);
  expect(readFeed(p, FEED[USDC]), "the page never read USDC / USD").toBe(true);
  expect(askedUsdcUsdc(p), "the page asked Uniswap for a USDC/USDC pool").toBe(0);

  const before = await sentCount(p);
  const fromBlock = await nextBlock();
  await press(p);
  const sent = await sentSince(p, before);
  expect(sent.length, "an ETH buy on USDC is not one confirmation").toBe(1);
  expect(sent[0].to).toBe(ROUTER);
  expect(sent[0].data.slice(0, 10)).toBe(sel("buyWithEth(address,address,bytes,uint256,uint256,address,uint256)"));
  const pathHex = bytesArg(sent[0].data, 2).toLowerCase();
  expect((pathHex.length - 2) / 2, "USDC is not one hop from WETH").toBe(43);
  expect(pathHex.slice(0, 42)).toBe(WETH);
  expect("0x" + pathHex.slice(-40)).toBe(USDC);
  // THE FLOORS ARE THE SLIPPAGE OFF THE QUOTER'S ANSWER FOR THAT HOP, at the
  // block before the trade, in USDC's own six decimals.
  const ev = (await routerEvents(BOUGHT, fromBlock)).filter((e) => e.who === buyer.toLowerCase());
  expect(ev.length).toBe(1);
  const block = "0x" + (BigInt(ev[0].log.blockNumber) - 1n).toString(16);
  const minQuoteOut = BigInt("0x" + argWords(sent[0].data)[3]);
  expect(minQuoteOut, "minQuoteOut is not 2% off the quoter's answer for WETH -> USDC")
    .toBe(slip(await quoterAt(pathHex, 10n ** 16n, block), 200));
  expect(wordAt(ev[0].data, 2) >= minQuoteOut, "the swap delivered less USDC than its floor").toBe(true);
  expect(await balanceOf(token, buyer), "the tokens the event names did not arrive").toBe(wordAt(ev[0].data, 3));
  expect(await balanceOf(USDC, buyer), "USDC was left with the buyer").toBe(0n);

  // ---- THE TOKEN PAGE, AT SIX DECIMALS AND IN DOLLARS BY USDC / USD.
  await holdsDecimalsAndFeed(p, factory, "USDC", 6, "USDC / USD");

  // ---- AND BACK: the first ETH sale is the router's approval and sellForEth,
  // along USDC -> WETH, its ETH floor the slippage off the quoter for the
  // curve's own minimum.
  await expect(p.locator("#tvPay")).toHaveValue("", { timeout: 30_000 });
  p.bodies.length = 0;
  await setUp(p, "sell", "50%", 2);
  await expect(p.locator("#tvGetAsset")).toHaveText("ETH");
  await expect(p.locator("#tvQuote")).toContainText(/Conversion: [\d.]+% below market/, { timeout: 30_000 });
  const s = await pageQuote(p);
  const wantSale = await conversionAt(USDC, 6, BigInt(s.ethOut), BigInt(s.qOut), false);
  expect(Math.abs(s.conv - wantSale), `the sale's conversion reads ${s.conv} bps where the feeds give ${wantSale}`).toBeLessThanOrEqual(1);
  const n = await sentCount(p);
  const saleFrom = await nextBlock();
  await press(p);
  const sold = await sentSince(p, n);
  expect(sold.length, "the first ETH sale on USDC is not two confirmations").toBe(2);
  expect(BigInt("0x" + argWords(sold[0].data)[1]), "the router's approval is not unlimited").toBe(MAX);
  expect(sold[1].to).toBe(ROUTER);
  const salePath = bytesArg(sold[1].data, 4).toLowerCase();
  expect((salePath.length - 2) / 2, "the sale is not one hop").toBe(43);
  expect(salePath.slice(0, 42)).toBe(USDC);
  expect("0x" + salePath.slice(-40)).toBe(WETH);
  const sev = (await routerEvents(SOLD, saleFrom)).filter((e) => e.who === buyer.toLowerCase());
  expect(sev.length).toBe(1);
  const minEthOut = BigInt("0x" + argWords(sold[1].data)[5]);
  const minQuote = BigInt("0x" + argWords(sold[1].data)[3]);
  const sblock = "0x" + (BigInt(sev[0].log.blockNumber) - 1n).toString(16);
  expect(minEthOut, "minEthOut is not 2% off what the hop pays for the curve's minimum")
    .toBe(slip(await quoterAt(salePath, minQuote, sblock), 200));
  expect(wordAt(sev[0].data, 3) >= minEthOut, "the sale paid less ETH than its floor").toBe(true);
  expect(askedUsdcUsdc(p), "the sale asked Uniswap for a USDC/USDC pool").toBe(0);
  expect(await balanceOf(USDC, buyer), "USDC was left with the seller").toBe(0n);
  await p.close();
});

// ================================================================== AERO
test("an AERO launch: the issuer row says no policy, and an ETH buy is one send along a WETH route, checked against AERO / USD", async () => {
  test.setTimeout(480_000);
  const factory = await factoryFor(AERO);
  await walkWethTiers(AERO, BigInt(await ethCall(factory, sel("graduationThreshold()"))));
  const { token, policyRow } = await createOn(factory, "Assets Aero", "AAE");
  // A PLAIN ERC-20 HAS NO POLICY AND NO BLACKLIST. Both questions revert, which
  // is an answer: "nothing to refuse" - not "could not be read".
  expect.soft(policyRow, "the issuer row did not read AERO's missing policy as none").toBe("no issuer policy; not blacklisted");
  const buyer = await freshAccount("aero buyer");
  const p = await openToken(token, buyer);
  await expect(p.locator("#tvStatus")).toHaveText("Selling");
  p.bodies.length = 0;
  await setUp(p, "buy", "0.01", 2);
  await expect(p.locator("#tvQuote")).toContainText(/1 confirmation: the CURB router swaps your ETH into about [\d.,]+ AERO/, { timeout: 30_000 });
  await expect(p.locator("#tvQuote")).toContainText(/Conversion: [\d.]+% below market/);
  await expect(p.locator("#tvQuote")).not.toContainText("not checked");
  const q = await pageQuote(p);
  expect(q.via).toBe("router");
  const want = await conversionAt(AERO, 18, BigInt(q.amount), BigInt(q.mid), true);
  expect(Math.abs(q.conv - want), `the conversion reads ${q.conv} bps where ETH / USD and AERO / USD give ${want}`).toBeLessThanOrEqual(1);
  expect(readFeed(p, FEED[AERO]), "the page never read AERO / USD").toBe(true);

  const before = await sentCount(p);
  const fromBlock = await nextBlock();
  await press(p);
  const sent = await sentSince(p, before);
  expect(sent.length, "an ETH buy on AERO is not one confirmation").toBe(1);
  expect(sent[0].to).toBe(ROUTER);
  const pathHex = bytesArg(sent[0].data, 2).toLowerCase();
  // ONE HOP THROUGH AERO/WETH, OR TWO THROUGH USDC - whichever the quoter paid
  // more for - and nothing else.
  const hops = ((pathHex.length - 2) / 2 - 20) / 23;
  expect([1, 2], "the path is neither one hop nor two").toContain(hops);
  expect(pathHex.slice(0, 42)).toBe(WETH);
  expect("0x" + pathHex.slice(-40)).toBe(AERO);
  if (hops === 2) expect(pathHex.slice(48, 88), "a two-hop AERO path does not pass through USDC").toBe(USDC.slice(2));
  const ev = (await routerEvents(BOUGHT, fromBlock)).filter((e) => e.who === buyer.toLowerCase());
  expect(ev.length).toBe(1);
  const block = "0x" + (BigInt(ev[0].log.blockNumber) - 1n).toString(16);
  expect(BigInt("0x" + argWords(sent[0].data)[3]), "minQuoteOut is not 2% off the quoter's answer for the path")
    .toBe(slip(await quoterAt(pathHex, 10n ** 16n, block), 200));
  expect(await balanceOf(token, buyer), "the tokens the event names did not arrive").toBe(wordAt(ev[0].data, 3));
  expect(await balanceOf(AERO, buyer), "AERO was left with the buyer").toBe(0n);

  await holdsDecimalsAndFeed(p, factory, "AERO", 18, "AERO / USD");
  await p.close();
});

// ================================================================== VIRTUAL
test("a VIRTUAL launch: an ETH buy quotes through the router, checked against VIRTUAL / USD", async () => {
  test.setTimeout(420_000);
  const factory = await factoryFor(VIRTUAL);
  await walkWethTiers(VIRTUAL, BigInt(await ethCall(factory, sel("graduationThreshold()"))));
  const { token, policyRow } = await createOn(factory, "Assets Virtual", "AVI");
  expect(policyRow, "the issuer row did not read VIRTUAL's missing policy as none").toBe("no issuer policy; not blacklisted");
  const buyer = await freshAccount("virtual buyer");
  const p = await openToken(token, buyer);
  p.bodies.length = 0;
  await setUp(p, "buy", "0.01", 2);
  await expect(p.locator("#tvQuote")).toContainText(/1 confirmation: the CURB router swaps your ETH into about [\d.,]+ VIRTUAL/, { timeout: 30_000 });
  await expect(p.locator("#tvQuote")).toContainText(/Conversion: [\d.]+% below market/);
  const q = await pageQuote(p);
  const want = await conversionAt(VIRTUAL, 18, BigInt(q.amount), BigInt(q.mid), true);
  expect(Math.abs(q.conv - want), `the conversion reads ${q.conv} bps where ETH / USD and VIRTUAL / USD give ${want}`).toBeLessThanOrEqual(1);
  expect(readFeed(p, FEED[VIRTUAL]), "the page never read VIRTUAL / USD").toBe(true);
  // AND ITS DOLLARS BY ITS OWN FEED, before anything was bought.
  await expect(p.locator("#tvMcap")).toHaveText(/^\$/, { timeout: 30_000 });
  expect(await p.locator("#tvMcap").getAttribute("title")).toContain("by VIRTUAL / USD (Chainlink)");
  await p.close();
});
