// A LAUNCH'S OWN PAGE (/token/0x…), THE NOTICES AT THE TOP, AND ETH BY DEFAULT.
//
// The owner's list of 2026-09-27: the create form starts on ETH; a create says
// so in a notice with a way to the launch's page; that page has the swap card,
// the price, the chart, the trades and the creator's fees; results and
// refusals appear at the top of the screen wherever it is scrolled, and fade.
// And of 2026-09-28: the market cap in dollars on every pair, the chart's short
// ranges, long notices shortened, and ether - not WETH - back from a sale.
//
// Every trade in these tests is real - the wallet stub forwards to the run's
// own fork - and every figure is checked against what the chain says, read
// here, not against what the page says elsewhere.
//
// EACH TEST STANDS ON ITS OWN. The ones that need a launch make it when an
// earlier test has not (ensureCreated, ensureWethLaunch), so any one of them
// can be run alone - which is how a mutation run runs them.
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

const STATE = JSON.parse(fs.readFileSync(path.join(__dirname, ".state.json"), "utf8"));
const STUB = fs.readFileSync(path.join(__dirname, "..", "wallet-stub.js"), "utf8");
const APP = STATE.app;
const OWNER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const TRADER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const WETH = "0x4200000000000000000000000000000000000006";
const AAPLC = "0xb200000000000000000000c2e324d24d7eecd1fb";
const CBZEC = "0xb2000000000000000000008501b13360000cb2ec";
const SPCXC = "0xb2000000000000000000007b9fcbd005511acbd5";
const ROUTER_ADDR = "0x6ff5693b99212da76ad316178a184ab56d299b43";   // UniversalRouter on Base
// CHAINLINK'S DOLLAR FEEDS FOR THE ASSETS THESE TESTS TRADE, taken from
// Chainlink's directory for Base - not from token.js - and each used only after
// it names itself on chain as the feed written here. ZEC / USD answers in 18
// decimals where the rest answer in 8.
const FEEDS = {
  [WETH]: ["0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70", "ETH / USD"],
  "0xb20000000000000000000078ee7ce2fe4908108c": ["0x04689a41629776563e6822f76f2e57d148d28513", "Coinbase NVDA"],
  [AAPLC]: ["0x787f13dea48db0897cbcdd985de77809d837f988", "Coinbase AAPL"],
  [CBZEC]: ["0x69e5bc4988a9af30ec827c5609c0d41028446ec0", "ZEC / USD"],
};

test.describe.configure({ mode: "serial" });

let browserRef;
test.beforeAll(async ({ browser }) => { browserRef = browser; });

async function rpc(method, params) {
  const res = await fetch(STATE.rpc, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(method + ": " + JSON.stringify(j.error));
  return j.result;
}
const ethCall = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
const addrOf = (raw) => "0x" + String(raw).replace(/^0x/, "").slice(24, 64);
const wordAt = (raw, i) => BigInt("0x" + String(raw).replace(/^0x/, "").slice(i * 64, i * 64 + 64));
function stringOf(raw) {
  const hex = String(raw).replace(/^0x/, "");
  const len = Number(BigInt("0x" + hex.slice(64, 128)));
  return Buffer.from(hex.slice(128, 128 + len * 2), "hex").toString();
}

/// A page with the wallet stub, as app.spec's openApp does. `wallet` overrides
/// the stub's settings - another network, for one.
async function newPage(account, wallet = {}, after = "") {
  const p = await browserRef.newPage();
  p.on("pageerror", (e) => console.log("PAGE ERROR: " + (e.stack || e.message)));
  const cfg = { forward: true, chainId: "0x2105", account, ...wallet };
  // ONE INIT SCRIPT: the order several run in is not defined. `after` runs last.
  await p.addInitScript({ content: [
    STUB, ";(function () {",
    "  window.ethereum = window.makeWallet(" + JSON.stringify(STATE.rpc) + ", " + JSON.stringify(cfg) + ");",
    "})();", after,
  ].join("\n") });
  return p;
}
function keccak(s) {
  // keccak from the page's own file, run in node: selectors and topics are derived, not pasted.
  global.window = global.window || global;
  require("../keccak.js"); require("../abi.js");
  return window.CurbKeccak.keccak256("0x" + window.CurbAbi.utf8Hex(s));
}
async function sel(sig) { return keccak(sig).slice(0, 10); }
const WITHDRAW = keccak("withdraw(uint256)").slice(0, 10);
const SELL_TOPIC = keccak("CurveSell(address,address,uint256,uint256,uint256,uint256)");

const wethOf = async (who) => BigInt(await ethCall(WETH, (await sel("balanceOf(address)")) + word(BigInt(who))));

/// One Chainlink feed's dollar answer, after it has named itself.
async function feedUsd(quote) {
  const f = FEEDS[String(quote).toLowerCase()];
  if (!f) return null;
  expect(stringOf(await ethCall(f[0], await sel("description()"))), "the feed is not the one written here").toBe(f[1]);
  const dec = Number(BigInt(await ethCall(f[0], await sel("decimals()"))));
  const answer = wordAt(await ethCall(f[0], await sel("latestRoundData()")), 1);
  return Number(answer) / 10 ** dec;
}
/// A figure as the page prints it - "$4.51K", "12.3M NVDAc" - back into a number.
function shownNumber(s) {
  const m = String(s).replace(/,/g, "").match(/([0-9.]+)\s*([KMB])?/);
  if (!m) return NaN;
  return Number(m[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[m[2]] || 1);
}
/// The market cap the chain implies: the curve's reserve ratio, times the supply, times dollars per unit.
async function curveMcapUsd(p) {
  const v = await p.evaluate(() => ({ curve: window.CurbApp.state.view.curve, qd: window.CurbApp.state.ctx.quoteDecimals,
    quote: window.CurbApp.state.ctx.quote, token: window.CurbApp.state.chainCfg.token }));
  const r = await ethCall(v.curve, await sel("getReserves()"));
  const price = (Number(wordAt(r, 0)) / 10 ** v.qd) / (Number(wordAt(r, 1)) / 1e18);
  const supply = Number(BigInt(await ethCall(v.token, await sel("totalSupply()")))) / 1e18;
  const per = await feedUsd(v.quote);
  return { price, supply, per, usd: per === null ? NaN : price * supply * per };
}

// ------------------------------------------------------------------ launches these tests stand on
/// The factory of `quote`, from the registry the lens names - or null.
async function factoryFor(quote) {
  const registry = addrOf(await ethCall(APP.lens, await sel("registry()")));
  const n = Number(BigInt(await ethCall(registry, await sel("launcherCount()"))));
  for (let i = 0; i < n; i++) {
    const f = addrOf(await ethCall(registry, (await sel("launcherAt(uint256)")) + word(i)));
    if (addrOf(await ethCall(f, await sel("quoteToken()"))) === quote.toLowerCase()) return f;
  }
  return null;
}
/// A launch made through the form, on `factory`; returns its token.
async function createOn(factory, name, symbol, account = OWNER) {
  const p = await newPage(account);
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

let created = null;   // { token } - the launch these tests make and trade
async function ensureCreated() {
  if (!created) created = { token: await createOn(APP.factory, "Token Page", "TPG") };
  return created;
}
/// A LAUNCH OF THEIR OWN FOR THE HISTORY TESTS. They buy on its curve straight
/// from the deployer; the shared launch above has been traded to its threshold
/// by the time a full run reaches them, and a buy there reverts.
let historyToken = null;
async function ensureHistoryLaunch() {
  if (!historyToken) historyToken = { token: await createOn(APP.factory, "History Probe", "HIS") };
  return historyToken;
}
let wethToken = null; // a launch on the WETH pair, made through the form's own default
async function ensureWethLaunch() {
  if (!wethToken) wethToken = await createOn(await factoryFor(WETH), "Weth Pair", "WPR");
  return wethToken;
}
/// AN ACCOUNT FOR THE WETH SALES, OF ITS OWN: a fresh address with no code, the
/// node signing for it (impersonated) and ten ether to spend. Not one of the
/// well-known keys - on Base those carry EIP-7702 delegations and WETH other
/// specs count on, and these tests unwrap every WETH the seller holds.
async function wethSeller() {
  const a = "0x" + keccak("curb token.spec weth seller").slice(-40);
  expect(await rpc("eth_getCode", [a, "latest"]), "the seller's address has code on this chain").toBe("0x");
  await rpc("anvil_impersonateAccount", [a]);
  if (BigInt(await rpc("eth_getBalance", [a, "latest"])) < 10n ** 18n) {
    await rpc("anvil_setBalance", [a, "0x" + (10n ** 19n).toString(16)]);
  }
  return a;
}

/// THE FLOWS FROM BEFORE THE CURB ROUTER, which the page still uses wherever
/// the router cannot be (app.js routerReady): these tests pin them, so they run
/// with no code at the router's address - put back afterwards, byte for byte.
/// A page opened inside reads the router as absent; one opened outside, as
/// there. router.spec.js pins the router's own flows.
const CURB_ROUTER = "0xea20c3266229a01cd0f45d9c7921a45d5b359561";
async function withoutRouter(fn) {
  const code = await rpc("eth_getCode", [CURB_ROUTER, "latest"]);
  await rpc("anvil_setCode", [CURB_ROUTER, "0x"]);
  try { return await fn(); } finally {
    if (code !== "0x") await rpc("anvil_setCode", [CURB_ROUTER, code]);
  }
}
/// AERODROME'S QUOTER WITH NO CODE, so its route is off: without the CURB
/// router it would be taken wherever it is not worse (aero.spec.js), and SPCXc's
/// pools there pay more at this block. Put back in a finally.
const AERO_QUOTER = "0x514c8b5f54112481e28028f1166bd78501089259";
async function withoutAerodrome(fn) {
  const code = await rpc("eth_getCode", [AERO_QUOTER, "latest"]);
  await rpc("anvil_setCode", [AERO_QUOTER, "0x"]);
  try { return await fn(); } finally { await rpc("anvil_setCode", [AERO_QUOTER, code]); }
}

/// The launch's page, connected, with app.js's drawing of it in place.
async function openToken(token, account = OWNER) {
  const p = await newPage(account);
  await p.goto("/token/" + token + "?" + new URLSearchParams({ rpc: STATE.rpc, lens: APP.lens }).toString());
  await expect(p.locator("#tokenView")).toBeVisible({ timeout: 15_000 });
  await expect(p.locator("#tvStatus")).not.toHaveText("—", { timeout: 30_000 });
  await p.evaluate(() => window.CurbApp.connect());
  await expect.poll(() => p.evaluate(() => ((window.CurbApp.state.viewFor || {}).token || "").toLowerCase()),
    { timeout: 30_000 }).toBe(token.toLowerCase());
  return p;
}
/// The card on `side`, flipped if it is on the other one.
async function cardSide(p, side) {
  const sym = (await p.locator("#tvSym").textContent()).trim().replace(/^\$/, "");
  const tokenPays = (await p.locator("#tvPayAsset").textContent()).trim() === sym;
  if ((side === "sell") !== tokenPays) await p.click("#tvFlip");
}
/// Until the card has read what there is to pay with: a percentage pressed
/// before that is a percentage of nothing (the balances are read again after
/// every action, a moment after its "Done").
async function availableRead(p) {
  await expect.poll(async () => shownNumber(await p.locator("#tvPayAvail").textContent()),
    { timeout: 30_000, message: "the card never read what there is to pay with" }).toBeGreaterThan(0);
}
/// What the card's quote side pays or receives in: "eth", or "asset" - the
/// pair's own (WETH on a WETH pair) - chosen on its chip's list, as a person
/// does. A launch offering no choice there is left as it is.
async function payWith(p, which) {
  const pick = p.locator(".tvAsset.tvPick");
  if (await pick.count() === 0) return;
  const isEth = (await pick.textContent()).trim() === "ETH";
  if (isEth === (which === "eth")) return;
  await pick.click();
  await p.locator(`#tvMenu button[data-choice="${which}"]`).click();
  await expect(p.locator("#tvMenu")).toHaveCount(0);
}
/// A trade through the card, to the page's "Done" - paid in the pair's own
/// asset unless `opts.with` says "eth".
async function tradeOnCard(p, side, amount, opts = {}) {
  await cardSide(p, side);
  await payWith(p, opts.with || "asset");
  if (/%$/.test(amount)) {
    await availableRead(p);
    await p.click(`#tvPcts [data-pct="${parseInt(amount, 10)}"]`);
  } else await p.fill("#tvPay", amount);
  await expect(p.locator("#tvAct")).toHaveText(new RegExp("^" + (side === "buy" ? "Buy" : "Sell") + " \\$"), { timeout: 20_000 });
  await expect(p.locator("#tvAct")).toBeEnabled({ timeout: 20_000 });
  await p.click("#tvAct");
  // A CURVE TRADE REPORTS "Done", A POOL TRADE "Swapped through" - the card trades in either.
  await expect(p.locator("#msg")).toContainText(/Done|Swapped through/, { timeout: 90_000 });
}

// ------------------------------------------------------------------ the bar
test("the bar's menu reads $CURB, then Launches, then Holder fees, then Docs", async () => {
  const p = await newPage(OWNER);
  await p.goto("/docs.html?" + new URLSearchParams({ rpc: STATE.rpc, lens: APP.lens }).toString());
  await expect(p.locator("#siteBar .cbNav a")).toHaveText(["$CURB", "Launches", "Holder fees", "Docs"], { timeout: 10_000 });
  await p.close();
});

// ------------------------------------------------------------------ ETH by default
test("a chosen image shows in the picker, as the token will carry it", async () => {
  const p = await newPage(OWNER);
  await p.goto("/app.html?" + new URLSearchParams({ rpc: STATE.rpc, lens: APP.lens, factory: APP.factory }).toString() + "#create-launch");
  await p.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
  await expect(p.locator(".filePick")).not.toHaveClass(/hasImage/);
  await expect(p.locator("#nImagePreview")).toBeHidden();
  // A 1x1 PNG.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
  await p.setInputFiles("#nImageFile", { name: "dot.png", mimeType: "image/png", buffer: png });
  await expect(p.locator(".filePick")).toHaveClass(/hasImage/, { timeout: 10_000 });
  await expect(p.locator("#nImagePreview")).toBeVisible();
  await expect(p.locator("#nImagePreview")).toHaveAttribute("src", /^data:image\//);
  // THE SAME BYTES THE SUMMARY SHOWS, which are the ones the token gets.
  expect(await p.locator("#nImagePreview").getAttribute("src"))
    .toBe(await p.locator("#sumAvatar img").getAttribute("src"));
  // CLEARED, IT GOES.
  await p.setInputFiles("#nImageFile", []);
  await expect(p.locator(".filePick")).not.toHaveClass(/hasImage/);
  await p.close();
});

test("with no factory named or chosen, the create form starts on the WETH pair", async () => {
  // THE EXPECTED FACTORY, FROM THE REGISTRY: the launcher whose quoteToken() is WETH.
  const registry = addrOf(await ethCall(APP.lens, await sel("registry()")));
  const n = Number(BigInt(await ethCall(registry, await sel("launcherCount()"))));
  const weth = [];
  for (let i = 0; i < n; i++) {
    const f = addrOf(await ethCall(registry, (await sel("launcherAt(uint256)")) + word(i)));
    if (addrOf(await ethCall(f, await sel("quoteToken()"))) === WETH) weth.push(f);
  }
  test.skip(weth.length !== 1, "this deployment does not list exactly one WETH factory");

  const p = await newPage(OWNER);
  await p.goto("/app.html?" + new URLSearchParams({ rpc: STATE.rpc, lens: APP.lens }).toString() + "#create-launch");
  await expect.poll(() => p.evaluate(() => (window.CurbApp.state.chainCfg.factory || "").toLowerCase()),
    { timeout: 30_000, message: "the form did not start on the WETH factory" }).toBe(weth[0]);
  // THE CONTROL: a link that names a factory keeps it.
  await p.goto("/app.html?" + new URLSearchParams({ rpc: STATE.rpc, lens: APP.lens, factory: APP.factory }).toString());
  await p.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
  await p.waitForTimeout(3000);
  expect(await p.evaluate(() => window.CurbApp.state.chainCfg.factory.toLowerCase()),
    "a factory the link named was replaced by the WETH one").toBe(APP.factory.toLowerCase());
  await p.close();
});

// ------------------------------------------------------------------ create, and the notice
test("a create takes the creator to the token's page, trade card in view, under a one-line notice", async () => {
  test.setTimeout(120_000);
  // THE STUB KEEPS EVERY OTHER SUITE ON THE FORM (wallet-stub.js); this page moves.
  const p = await newPage(OWNER, {}, "delete window.CURB_STAY_AFTER_CREATE;");
  await p.goto("/app.html?" + new URLSearchParams({ rpc: STATE.rpc, factory: APP.factory, lens: APP.lens }).toString());
  await p.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
  await p.evaluate(() => window.CurbApp.connect());
  await p.fill("#nName", "Token Page");
  await p.fill("#nSymbol", "TPG");
  await p.locator("#create").scrollIntoViewIfNeeded();
  await p.click("#create");

  // STRAIGHT TO /token/<address>, the pair still named, the trade card in view.
  await p.waitForURL(/\/token\/0x[0-9a-fA-F]{40}\?.*#trade$/, { timeout: 60_000 });
  const token = /\/token\/(0x[0-9a-fA-F]{40})/.exec(p.url())[1];
  const q = new URL(p.url()).searchParams;
  expect(q.get("rpc"), "the move dropped the endpoint").toBe(STATE.rpc);
  expect((q.get("lens") || "").toLowerCase(), "the move dropped the lens").toBe(APP.lens.toLowerCase());
  await expect(p.locator("#tokenView")).toBeVisible({ timeout: 15_000 });
  await expect(p.locator(".tvSwap")).toBeInViewport();
  await expect(p.locator("#tvPay")).toBeFocused();
  // AND IT IS THE LAUNCH THIS CREATE MADE: the registry knows it.
  const registry = addrOf(await ethCall(APP.lens, await sel("registry()")));
  expect(BigInt(await ethCall(registry, (await sel("isRegistered(address)")) + word(BigInt(token)))), "not a registered launch").toBe(1n);
  created = { token: token.toLowerCase() };

  // ONE COMPACT LINE: "Launched", the name and $SYMBOL, the short address with
  // its copy button - and no "View" on the token's own page.
  const line = p.locator("#msg .toastLaunch");
  await expect(line).toBeVisible({ timeout: 15_000 });
  await expect(line.locator("strong")).toHaveText("Launched");
  await expect(line.locator(".toastWho")).toHaveText("Token Page · $TPG");
  await expect(line.locator("code")).toHaveText(token.slice(0, 6) + "…" + token.slice(-4), { ignoreCase: true });
  await expect(line.locator("a.toastCta"), "the token's own page links to itself").toHaveCount(0);
  const copy = line.locator("button.cbCopy");
  await expect(copy, "the address has no copy button").toHaveCount(1);
  await expect(copy).toHaveAttribute("data-copy", new RegExp("^" + token + "$", "i"));
  expect((await p.locator("#msg").textContent()).trim(), "the notice is long again")
    .toBe("LaunchedToken Page · $TPG" + (await line.locator("code").textContent()));
  // SMALL ON A WIDE SCREEN AND ON A PHONE: one line, sized to what it says.
  for (const [w, maxW, maxH] of [[1280, 520, 48], [390, 358, 80]]) {
    await p.setViewportSize({ width: w, height: 844 });
    const box = await p.locator("#cbToast #msg").boundingBox();
    expect(box.width, `the notice is ${box.width}px wide at ${w}`).toBeLessThanOrEqual(maxW);
    expect(box.height, `the notice is ${box.height}px tall at ${w}`).toBeLessThanOrEqual(maxH);
    expect(box.x, "the notice leaves the screen").toBeGreaterThanOrEqual(0);
  }
  await p.setViewportSize({ width: 1280, height: 720 });
  // THE COPY BUTTON COPIES THE WHOLE ADDRESS, and leaves the notice where it is.
  await p.evaluate(() => { window.__copied = []; navigator.clipboard.writeText = async (t) => { window.__copied.push(t); }; });
  await copy.click();
  expect((await p.evaluate(() => window.__copied)).map((x) => x.toLowerCase())).toEqual([token.toLowerCase()]);
  await expect(copy).toHaveAttribute("data-copied", "yes");
  // IT LINGERS PAST A PLAIN RESULT'S 5 s, THEN FADES BY ITSELF.
  await p.mouse.move(5, 700);
  const left = Date.now();
  await p.waitForTimeout(5600);
  await expect(p.locator("#cbToast"), "the notice faded as soon as a plain one").not.toHaveClass(/cbToastOut/);
  await expect(p.locator("#cbToast"), "the notice never faded").toHaveClass(/cbToastOut/, { timeout: 8_000 });
  expect(Date.now() - left).toBeGreaterThan(6500);
  // SHOWN ONCE: a reload of the page does not say it again.
  await p.reload();
  await expect(p.locator("#tokenView")).toBeVisible({ timeout: 15_000 });
  await p.waitForTimeout(1500);
  await expect(p.locator("#msg .toastLaunch")).toHaveCount(0);
  await p.close();
});

test("a create that stays on the form says it in one line with a small View to the token's page", async () => {
  test.setTimeout(120_000);
  const p = await newPage(OWNER);
  await p.goto("/app.html?" + new URLSearchParams({ rpc: STATE.rpc, factory: APP.factory, lens: APP.lens }).toString());
  await p.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
  await p.evaluate(() => window.CurbApp.connect());
  await p.fill("#nName", "Stays Here");
  await p.fill("#nSymbol", "STY");
  await p.locator("#create").scrollIntoViewIfNeeded();
  await p.click("#create");
  await expect(p.locator("#msg")).toContainText("Launched", { timeout: 60_000 });
  const token = await p.evaluate(() => window.CurbApp.state.chainCfg.token);
  // AT THE TOP OF THE SCREEN, whatever the scroll.
  const box = await p.locator("#cbToast").boundingBox();
  expect(box && box.y, "the notice is not at the top of the screen").toBeLessThan(200);
  expect(await p.evaluate(() => window.scrollY), "the page was not scrolled, so this proves nothing").toBeGreaterThan(200);
  const view = p.locator("#msg .toastLaunch a.toastCta");
  await expect(view).toHaveText("View");
  expect(await view.getAttribute("href")).toContain("token/" + token);
  await expect(p.locator("#msg .toastLaunch code")).toHaveAttribute("data-copy", new RegExp("^" + token + "$", "i"));
  expect((await p.locator("#msg").textContent()).trim())
    .toBe("LaunchedStays Here · $STY" + (await p.locator("#msg .toastLaunch code").textContent()) + "View");
  await expect(p.locator("#cbToast")).not.toHaveClass(/cbToastClamp/);
  await view.click();
  await p.waitForURL(new RegExp("/token/" + token), { timeout: 15_000 });
  await expect(p.locator("#tokenView")).toBeVisible({ timeout: 15_000 });
  await p.close();
});

test("choosing another paired asset starts the dev buy again from nothing", async () => {
  const p = await newPage(OWNER);
  await p.goto("/app.html?" + new URLSearchParams({ rpc: STATE.rpc, lens: APP.lens }).toString() + "#create-launch");
  await p.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
  await p.evaluate(() => window.CurbApp.connect());
  await expect.poll(() => p.evaluate(() => (window.CurbApp.state.ctx && window.CurbApp.state.ctx.quote || "").toLowerCase()),
    { timeout: 30_000, message: "the form never read the WETH factory" }).toBe(WETH);
  await p.fill("#nDevBuy", "1");
  await expect(p.locator("#devBuyOut"), "the dev buy was not taken, so this proves nothing").not.toHaveText(/No dev buy/, { timeout: 20_000 });
  // ANOTHER ASSET, through its card - as a creator picks it.
  await p.locator("#quoteGrid .qcard", { hasText: "cbBTC" }).click();
  await expect.poll(() => p.evaluate(() => (window.CurbApp.state.ctx && window.CurbApp.state.ctx.quoteSym) || ""),
    { timeout: 30_000 }).toBe("cbBTC");
  await expect(p.locator("#nDevBuy"), "1 ETH stayed in the field as 1 cbBTC").toHaveValue("");
  await expect(p.locator("#devBuyOut")).toHaveText(/No dev buy/);
  await p.close();
});

test("a result fades in about 5 s and a refusal in about 8 s, the mouse holds either, and the close button ends it", async () => {
  test.setTimeout(90_000);
  const p = await newPage(OWNER);
  await p.goto("/app.html?" + new URLSearchParams({ rpc: STATE.rpc, factory: APP.factory, lens: APP.lens }).toString());
  await p.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
  await p.mouse.move(5, 700);
  // WRITTEN THE WAY app.js WRITES ONE, and timed from the write.
  const write = (cls, text) => p.evaluate(([c, t]) => {
    const m = document.getElementById("msg"); m.hidden = false; m.className = c; m.textContent = t;
    return Date.now();
  }, [cls, text]);
  const fadedAfter = async (since, max) => {
    await expect(p.locator("#cbToast")).toHaveClass(/cbToastOut/, { timeout: max });
    return Date.now() - since;
  };
  // A RESULT: about 5 s (it was 8).
  let t = await write("ok", "Done.");
  let took = await fadedAfter(t, 9_000);
  expect(took, "a result faded too soon").toBeGreaterThan(4_000);
  expect(took, "a result stayed as long as it used to").toBeLessThan(7_000);
  // A REFUSAL: about 8 s (it was 15).
  t = await write("err", "That was refused.");
  took = await fadedAfter(t, 12_000);
  expect(took, "a refusal faded as soon as a result").toBeGreaterThan(6_500);
  expect(took, "a refusal stayed as long as it used to").toBeLessThan(10_500);
  // THE MOUSE ON IT HOLDS IT - on its text, not only on a button.
  await write("ok", "Held while read.");
  await p.locator("#cbToast #msg").hover();
  await p.waitForTimeout(7_000);
  await expect(p.locator("#cbToast"), "the notice faded under the mouse").not.toHaveClass(/cbToastOut/);
  // AND THE CLOSE BUTTON ENDS IT.
  await p.click("#cbToastX");
  await expect(p.locator("#cbToast")).toHaveClass(/cbToastOut/);
  await p.close();
});

/// THE NOTICE'S TEXT CAN BE SELECTED AND COPIED (the owner could not): the line
/// takes the pointer, a drag selects in it, a click in it closes nothing, and
/// every address and transaction hash carries a copy button - which does not
/// keep the notice up the way a button to act with does.
test("a notice's text can be selected without closing it, and its address and hash each have a copy button", async () => {
  const p = await newPage(OWNER);
  await p.goto("/app.html?" + new URLSearchParams({ rpc: STATE.rpc, factory: APP.factory, lens: APP.lens }).toString());
  await p.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
  const addr = "0x" + "ab12".repeat(10);
  const hash = "0x" + "cd34".repeat(16);
  await p.evaluate(([a, h]) => {
    window.__copied = [];
    navigator.clipboard.writeText = async (t) => { window.__copied.push(t); };
    const m = document.getElementById("msg"); m.hidden = false; m.className = "err";
    m.innerHTML = `Refused: the account <code>${a}</code> sent <code>${h}</code> already, and <code>0x12</code> is not an address.`;
  }, [addr, hash]);
  const copies = p.locator("#cbToast #msg button.cbCopy");
  await expect(copies, "the address and the hash do not each have a copy button").toHaveCount(2);
  expect(await copies.evaluateAll((b) => b.map((x) => x.dataset.copy))).toEqual([addr, hash]);
  // A COPY BUTTON IS NOT A BUTTON TO ACT WITH: the refusal still fades.
  expect(await p.evaluate(() => document.querySelector("#msg").textContent), "the copy buttons wrote words into the line")
    .toBe(`Refused: the account ${addr} sent ${hash} already, and 0x12 is not an address.`);
  await copies.nth(1).click();
  expect(await p.evaluate(() => window.__copied)).toEqual([hash]);
  // SELECTED BY A DRAG, and still there.
  const box = await p.locator("#cbToast #msg").boundingBox();
  // ALONG ITS FIRST LINE: 12px of padding, then a 21px line.
  await p.mouse.move(box.x + 16, box.y + 22);
  await p.mouse.down();
  await p.mouse.move(box.x + 130, box.y + 22, { steps: 6 });
  await p.mouse.up();
  const picked = await p.evaluate(() => String(window.getSelection()));
  expect(picked.length, "a drag over the notice selected nothing").toBeGreaterThan(3);
  expect(`Refused: the account ${addr}`.includes(picked.trim()), "the selection is not the notice's text: " + picked).toBe(true);
  await p.locator("#cbToast #msg").click({ position: { x: 30, y: 10 } });
  await expect(p.locator("#cbToast"), "a click in the notice closed it").not.toHaveClass(/cbToastOut/);
  expect(await p.evaluate(() => getComputedStyle(document.querySelector("#cbToast #msg")).userSelect)).not.toBe("none");
  // AND IT STILL FADES BY ITSELF once the mouse has gone.
  await p.mouse.move(5, 700);
  await expect(p.locator("#cbToast")).toHaveClass(/cbToastOut/, { timeout: 12_000 });
  await p.close();
});

test("a long result shows three lines and Details, reading it holds it, and the close button is drawn", async () => {
  const p = await newPage(OWNER);
  await p.goto("/app.html?" + new URLSearchParams({ rpc: STATE.rpc, factory: APP.factory, lens: APP.lens }).toString());
  await p.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
  // A SWAP'S REPORT IS THIS LONG, written the way app.js writes one.
  await p.evaluate(() => {
    const m = document.getElementById("msg"); m.hidden = false; m.className = "ok";
    m.innerHTML = "Done. The pool delivered <strong>1,234.5</strong> tokens. " + "The tax and the fee were taken on the quote side. ".repeat(24);
  });
  await expect(p.locator("#cbToast")).toHaveClass(/cbToastClamp/);
  await expect(p.locator("#cbToast")).toHaveClass(/cbToastCut/);
  await expect(p.locator("#cbToastMore")).toBeVisible();
  const shut = await p.locator("#cbToast #msg").boundingBox();
  // THREE LINES OF 13px AT 1.6, the padding and the room for the button: about 110px.
  expect(shut.height, "the long result was not shortened").toBeLessThan(140);
  expect(shut.height, "the shortened result shows less than its three lines").toBeGreaterThan(90);
  // WHAT RUNS ON UNDER THE THIRD LINE IS FADED OUT, not left behind the button.
  expect(await p.evaluate(() => getComputedStyle(document.getElementById("msg"), "::after").content),
    "nothing covers the lines under the third").not.toBe("none");
  // THE BUTTON IS INSIDE THE NOTICE, shut and open - not floating on the page under it.
  const inside = async () => {
    const b = await p.locator("#cbToastMore").boundingBox();
    const m = await p.locator("#cbToast #msg").boundingBox();
    return b.y >= m.y && b.y + b.height <= m.y + m.height + 1;
  };
  expect(await inside(), "Details sits outside the notice").toBe(true);
  await p.click("#cbToastMore");
  await expect(p.locator("#cbToast")).toHaveClass(/cbToastOpen/);
  const open = await p.locator("#cbToast #msg").boundingBox();
  expect(open.height, "Details did not open the whole result").toBeGreaterThan(shut.height + 40);
  expect(await inside(), "Less sits outside the notice").toBe(true);
  // READING IT HOLDS IT: an opened result does not fade on its clock.
  await p.waitForTimeout(9000);
  await expect(p.locator("#cbToast"), "an opened result faded while it was being read").not.toHaveClass(/cbToastOut/);
  // THE CLOSE BUTTON IS AN ICON, not a letter in a box - and it closes.
  expect(await p.locator("#cbToastX svg").count()).toBe(1);
  expect((await p.locator("#cbToastX").textContent()).trim()).toBe("");
  await p.click("#cbToastX");
  await expect(p.locator("#cbToast")).toHaveClass(/cbToastOut/);
  // A SHORT RESULT HAS NO Details.
  await p.evaluate(() => { const m = document.getElementById("msg"); m.className = "ok"; m.textContent = "Done."; });
  await expect(p.locator("#cbToastMore")).toBeHidden();
  await expect(p.locator("#cbToast")).not.toHaveClass(/cbToastCut/);
  await p.close();
});

// ------------------------------------------------------------------ the token's own page
test("a launch's own page shows its view and not the create form, and draws its price from the chain", async () => {
  const c = await ensureCreated();
  const p = await newPage(OWNER);
  await p.goto("/token/" + c.token + "?" + new URLSearchParams({ rpc: STATE.rpc, lens: APP.lens }).toString());
  await expect(p.locator("#tokenView")).toBeVisible({ timeout: 15_000 });
  await expect(p.locator("#create-launch")).toBeHidden();
  await expect(p.locator("#tvName")).toHaveText("Token Page", { timeout: 30_000 });
  await expect(p.locator("#tvSym")).toHaveText("$TPG");
  // THE STATUS COMES WITH app.js's FIRST READ OF THE LAUNCH, which follows some
  // 170 other reads (the registry's launchers - eleven when this was measured,
  // fourteen since 2026-10-15 - and the pool routes): 2.7 s
  // after the page opened when this file runs alone, 4.7 s after browse.spec on
  // the same fork - the same requests, each slower. The name is drawn before
  // it, so the 5 s default timed out on load, not on a wrong status.
  await expect(p.locator("#tvStatus")).toHaveText("Selling", { timeout: 30_000 });
  // IN DOLLARS (the owner's request): the curve's reserve ratio, read here from
  // the curve itself, times the supply, times the quote asset's own feed.
  await expect(p.locator("#tvMcap")).toContainText("$", { timeout: 30_000 });
  const want = await curveMcapUsd(p);
  expect(want.per, "no feed is written here for this fixture's quote asset").not.toBeNull();
  const shown = await p.locator("#tvMcap").textContent();
  expect(Math.abs(shownNumber(shown) - want.usd) / want.usd,
    `the market cap is not the curve's price times the supply in dollars: ${shown}, want $${want.usd.toFixed(2)}`).toBeLessThan(0.02);
  // ONLY DOLLARS ON SCREEN (the owner's call); what that is in the pair's own
  // asset, and where the dollars come from, on the tooltip.
  await expect(p.locator("#tvBigNote"), "the pair's units are still on screen").toHaveText("market cap");
  const sym = await p.evaluate(() => window.CurbApp.displaySymbol(window.CurbApp.state.ctx.quoteSym));
  const title = await p.locator("#tvMcap").getAttribute("title");
  const inQuote = shownNumber(title.split(" " + sym)[0]);
  expect(Math.abs(inQuote - want.price * want.supply) / (want.price * want.supply),
    "the market cap in the pair's asset is not the curve's price times the supply: " + title).toBeLessThan(0.02);
  expect(title, "the figure does not say where its dollars come from").toContain("Chainlink");
  await p.close();
});

test("launches paired with assets no pool prices (AAPLc, cbZEC) show their market cap in dollars, by each asset's own feed", async () => {
  test.setTimeout(180_000);
  // NOT ONLY NVDAc (the owner's words): neither has a Uniswap market with money
  // in it on Base, so the one route that priced NVDAc cannot price them.
  for (const [quote, sym, feedName, name, ticker] of [
    [AAPLC, "AAPLc", "Coinbase AAPL", "Apple Pair", "APR"],
    [CBZEC, "cbZEC", "ZEC / USD", "Zcash Pair", "ZPR"],
  ]) {
    const f = await factoryFor(quote);
    expect(f, "this deployment lists no " + sym + " factory").not.toBeNull();
    const token = await createOn(f, name, ticker);
    const p = await openToken(token);
    await expect(p.locator("#tvPair")).toHaveText("Paired: " + sym);
    await expect(p.locator("#tvMcap")).toContainText("$", { timeout: 30_000 });
    const want = await curveMcapUsd(p);
    const shown = await p.locator("#tvMcap").textContent();
    expect(Math.abs(shownNumber(shown) - want.usd) / want.usd,
      `${sym}: the market cap is not in dollars by its feed: ${shown}, want $${want.usd.toFixed(2)}`).toBeLessThan(0.02);
    expect(await p.locator("#tvMcap").getAttribute("title")).toContain(feedName);
    await p.close();
  }
});

test("WITHOUT THE ROUTER: a stock pair's curve is bought with ETH: swapped into the stock first, then the curve, from a wallet holding none of it", async () => withoutRouter(() => withoutAerodrome(async () => {
  test.setTimeout(240_000);
  // THE OWNER'S EXAMPLE: a launch paired with SPCXc, bought with ether.
  const f = await factoryFor(SPCXC);
  expect(f, "this deployment lists no SPCXc factory").not.toBeNull();
  const token = await createOn(f, "Space Pair", "SPR");
  const buyer = "0x" + keccak("curb token.spec eth buyer").slice(-40);
  expect(await rpc("eth_getCode", [buyer, "latest"])).toBe("0x");
  await rpc("anvil_impersonateAccount", [buyer]);
  await rpc("anvil_setBalance", [buyer, "0x" + (10n ** 19n).toString(16)]);
  const stock = async () => BigInt(await ethCall(SPCXC, (await sel("balanceOf(address)")) + word(BigInt(buyer))));
  expect(await stock(), "the buyer holds SPCXc already, so this proves nothing").toBe(0n);

  const p = await openToken(token, buyer);
  await expect(p.locator("#tvStatus")).toHaveText("Selling");
  await expect(p.locator("#tvPayAsset"), "the card does not start on ETH").toHaveText("ETH");
  const sentBefore = await p.evaluate(() => window.ethereum.sent.length);
  await p.fill("#tvPay", "0.01");
  await expect(p.locator("#tvQuote")).toContainText("Swapped first through Uniswap", { timeout: 30_000 });
  await expect(p.locator("#tvAct")).toBeEnabled({ timeout: 20_000 });
  await p.click("#tvAct");
  await expect(p.locator("#msg")).toContainText("Done. You paid", { timeout: 120_000 });

  // THE SENDS: the router, carrying the ETH as value; then the curve's buy.
  const sent = (await p.evaluate(() => window.ethereum.sent.map((t) => ({ to: t.to, data: t.data, value: t.value || "0x0" }))))
    .slice(sentBefore);
  expect(sent[0].to.toLowerCase(), "the swap did not go through UniversalRouter").toBe(ROUTER_ADDR);
  expect(BigInt(sent[0].value), "the swap did not carry the ETH typed").toBe(10n ** 16n);
  const curve = await p.evaluate(() => window.CurbApp.state.view.curve);
  const last = sent[sent.length - 1];
  expect(last.to.toLowerCase()).toBe(curve.toLowerCase());
  expect(last.data.slice(0, 10), "the last send is not the curve's buy").toBe(await sel("buy(uint256,uint256,address)"));
  // THE CHAIN: tokens arrived, and what the swap delivered was spent on them.
  const held = BigInt(await ethCall(token, (await sel("balanceOf(address)")) + word(BigInt(buyer))));
  expect(held > 0n, "no tokens arrived").toBe(true);
  expect(await stock(), "the SPCXc the swap delivered was not spent on the curve").toBe(0n);
  await p.close();
})));

test("the market cap is in dollars on a fork that serves another chain id, as the owner's does", async () => {
  // THE OWNER'S FORK SERVES 84531, and the dollars were only asked for on 8453
  // and one other id. The endpoint is made to answer that id here.
  const c = await ensureCreated();
  const p = await newPage(OWNER);
  const node = new RegExp(STATE.rpc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  await p.route(node, async (route) => {
    let body = null;
    try { body = JSON.parse(route.request().postData() || "null"); } catch { body = null; }
    if (body && !Array.isArray(body) && body.method === "eth_chainId") {
      return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x14a33" }) });
    }
    return route.continue().catch(() => {});
  });
  await p.goto("/token/" + c.token + "?" + new URLSearchParams({ rpc: STATE.rpc, lens: APP.lens }).toString());
  await expect(p.locator("#tvStatus")).not.toHaveText("—", { timeout: 30_000 });
  // THE PAGE WAS TOLD 84531: asked the way it asks.
  expect(await p.evaluate(async (url) => (await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) })).json()).result, STATE.rpc),
    "the endpoint was not made to answer 84531, so this proves nothing").toBe("0x14a33");
  await expect(p.locator("#tvMcap"), "a fork serving chain 84531 shows the pair's units").toContainText("$", { timeout: 30_000 });
  await expect(p.locator("#tvPrice")).toContainText("$");
  await p.unrouteAll({ behavior: "ignoreErrors" });
  await p.close();
});

test("the swap card starts on ETH on every pair, offers the pair's asset beside it, and shows each one's picture", async () => {
  const c = await ensureCreated();
  const p = await openToken(c.token);
  await expect(p.locator("#tvStatus")).toHaveText("Selling");
  // ETH FIRST, ON A PAIR THAT IS NOT ETH (the owner's call: everyone holds ether).
  await expect(p.locator("#tvPayAsset"), "a stock pair's card does not start on ETH").toHaveText("ETH");
  await expect(p.locator("#tvPayAsset img")).toHaveAttribute("src", /assets\/weth\.svg/);
  await expect(p.locator("#tvPayAsset")).toHaveClass(/tvPick/);
  // THE PAIR'S OWN ASSET IS ON THE LIST, with its logo - and beside "Paired:".
  const sym = await p.evaluate(() => window.CurbApp.state.ctx.quoteSym);
  const slug = sym.toLowerCase().replace(/[^a-z0-9]/g, "");
  await p.click("#tvPayAsset");
  await expect(p.locator("#tvMenu button")).toHaveText(["ETH", sym]);
  await p.click('#tvMenu button[data-choice="asset"]');
  await expect(p.locator("#tvPayAsset")).toHaveText(sym);
  await expect(p.locator("#tvPayAsset img")).toHaveAttribute("src", new RegExp("assets/" + slug + "\\.svg"));
  await expect(p.locator("#tvPair img")).toHaveAttribute("src", new RegExp("assets/" + slug + "\\.svg"));
  expect(await p.locator("#tvPayAsset img").evaluate((i) => i.complete && i.naturalWidth > 0), "the pair's logo did not load").toBe(true);
  // A CURVE SALE PAYS ETH TOO, through the CURB router - ETH first, the pair's
  // asset beside it. (Before the router it paid the asset only; router.spec.js
  // pins that this is still so where the router is not.)
  await p.click("#tvFlip");
  await expect(p.locator("#tvGetAsset")).toHaveText("ETH");
  await expect(p.locator("#tvGetAsset")).toHaveClass(/tvPick/);
  await p.click("#tvGetAsset");
  await expect(p.locator("#tvMenu button")).toHaveText(["ETH", sym]);
  await p.click('#tvMenu button[data-choice="asset"]');
  await expect(p.locator("#tvGetAsset")).toHaveText(sym);
  await p.close();
  // AND ETH'S ON A WETH PAIR, whose label is ETH - with WETH beside it on the
  // curve too, so WETH an account holds can still be spent there.
  const w = await openToken(await ensureWethLaunch());
  await expect(w.locator("#tvPayAsset")).toHaveText("ETH");
  await expect(w.locator("#tvPayAsset img")).toHaveAttribute("src", /assets\/weth\.svg/);
  await expect(w.locator("#tvPayAsset")).toHaveClass(/tvPick/);
  await w.click("#tvPayAsset");
  await expect(w.locator("#tvMenu button")).toHaveText(["ETH", "WETH"]);
  await w.close();
});

test("the swap card buys through app.js's own button, and the trade appears in the list and the chart", async () => {
  const c = await ensureCreated();
  const p = await newPage(OWNER);
  await p.goto("/token/" + c.token + "?" + new URLSearchParams({ rpc: STATE.rpc, lens: APP.lens }).toString());
  await expect(p.locator("#tvStatus")).toHaveText("Selling", { timeout: 30_000 });
  await p.evaluate(() => window.CurbApp.connect());
  await expect(p.locator("#tvTradeCount")).toHaveText("0", { timeout: 30_000 });
  await expect.poll(() => p.evaluate(() => ((window.CurbApp.state.viewFor || {}).token || "").toLowerCase()),
    { timeout: 30_000 }).toBe(c.token.toLowerCase());

  await payWith(p, "asset");
  await p.fill("#tvPay", "2");
  // THE QUOTE IS app.js's, from the fields the card wrote.
  await expect(p.locator("#tvGet")).not.toHaveText("0", { timeout: 20_000 });
  expect(await p.evaluate(() => [document.getElementById("curveSide").value, document.getElementById("curveAmount").value]))
    .toEqual(["buy", "2"]);
  await expect(p.locator("#tvAct")).toHaveText("Buy $TPG");
  const before = await p.evaluate(() => window.ethereum.sent.length);
  await p.click("#tvAct");
  await expect(p.locator("#msg")).toContainText("Done", { timeout: 60_000 });
  expect(await p.evaluate(() => window.ethereum.sent.length), "nothing was sent").toBeGreaterThan(before);
  // THE NOTICE (the owner's call): a tick, "Swapped", and what went and what
  // came written out - "2 NVDAc → 123,456 TPG", never "123.5K" - with the full
  // account kept out of sight.
  await expect(p.locator("#msg .toastTitle")).toHaveText("Swapped");
  await expect(p.locator("#msg .toastLine")).toHaveText(/^2 \S+ → \d{1,3}(,\d{3})*(\.\d+)? TPG$/);
  await expect(p.locator("#msg .toastLong")).toBeHidden();
  // THE LIST AND THE CHART FROM THE CHAIN'S OWN EVENT.
  await expect(p.locator("#tvTradeCount")).toHaveText("1", { timeout: 30_000 });
  await expect(p.locator("#tvList .tvLine").first()).toContainText("$TPG");
  // THE AMOUNT IS CLEARED ONCE IT WENT THROUGH - left, it was quoted again at
  // the price the trade had moved, and read as what the trade gave.
  await expect(p.locator("#tvPay"), "the amount stayed in the field after the trade").toHaveValue("");
  await p.close();
});

test("an amount typed while the last trade's refresh is still out is kept for the next trade", async () => {
  const c = await ensureCreated();
  const p = await openToken(c.token);
  await expect(p.locator("#tvStatus")).toHaveText("Selling");
  await cardSide(p, "buy");
  await payWith(p, "asset");
  await p.fill("#tvPay", "1");
  await expect(p.locator("#tvAct")).toBeEnabled({ timeout: 20_000 });
  // THE END OF THE REFRESH HELD BACK: the page's "refreshed" news is kept until
  // the next amount has been typed, so it is certainly typed while the refresh
  // that ends this trade is still out - whatever the node's speed.
  await p.evaluate(() => {
    const send = document.dispatchEvent.bind(document);
    window.__held = [];
    window.__hold = true;
    document.dispatchEvent = (ev) => {
      if (window.__hold && ev.type === "curb:refreshed") { window.__held.push(ev); return true; }
      return send(ev);
    };
    window.__release = () => { window.__hold = false; for (const ev of window.__held.splice(0)) send(ev); };
  });
  await p.click("#tvAct");
  await expect(p.locator("#msg")).toContainText("Done", { timeout: 60_000 });
  // THE SAME FIGURE TYPED AGAIN: the hardest case, since an amount that merely
  // matched what was pressed used to be taken for the one that went through.
  await p.fill("#tvPay", "");
  await p.fill("#tvPay", "1");
  await expect.poll(() => p.evaluate(() => window.__held.length), { timeout: 30_000, message: "the trade's refresh never ended" })
    .toBeGreaterThan(0);
  await p.evaluate(() => window.__release());
  await p.waitForTimeout(500);
  await expect(p.locator("#tvPay"), "an amount typed after the trade was wiped by its refresh").toHaveValue("1");
  // THE CONTROL: an amount left as it was pressed IS cleared once it went through.
  await p.click("#tvAct");
  await expect(p.locator("#msg")).toContainText("Done", { timeout: 60_000 });
  await expect(p.locator("#tvPay"), "the amount that went through stayed in the field").toHaveValue("", { timeout: 30_000 });
  await p.close();
});

test("the chart's short ranges draw the launch's price, on the chain's own clock", async () => {
  const c = await ensureCreated();
  const p = await openToken(c.token);
  await expect(p.locator("#tvTradeCount")).not.toHaveText("—", { timeout: 30_000 });
  if ((await p.locator("#tvTradeCount").textContent()).trim() === "0") {
    await tradeOnCard(p, "buy", "1");
    await expect(p.locator("#tvTradeCount")).not.toHaveText("0", { timeout: 30_000 });
  }
  // EVERY RANGE DRAWS: they used to keep only the trades inside them, timed by
  // this computer's clock - on a fork, days from the chain's - and drew nothing.
  for (const r of ["3600", "21600", "86400", "0"]) {
    await p.click(`#tvRanges [data-r="${r}"]`);
    await expect(p.locator(`#tvRanges [data-r="${r}"]`)).toHaveClass(/on/);
    await expect(p.locator("#tvChart svg path"), "range " + r + " drew no line").toHaveCount(2);
    await expect(p.locator("#tvChart .tvEmpty")).toHaveCount(0);
  }
  // AND THE HOUR ENDS AT THE CHAIN'S NOW: the right-hand time under it is the
  // latest block's, not this computer's.
  const ts = Number(BigInt((await rpc("eth_getBlockByNumber", ["latest", false])).timestamp));
  const gap = Math.abs(Date.now() / 1000 - ts);
  await p.click('#tvRanges [data-r="3600"]');
  const want = await p.evaluate((t) => new Date(t * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }), ts);
  const labels = await p.locator("#tvChart svg text").allTextContents();
  if (gap > 120) {
    expect(labels[labels.length - 1], "the hour does not end at the chain's time").toBe(want);
  } else {
    console.log("the chain's clock is this computer's to within two minutes; the clock check proves nothing here");
  }
  await p.close();
});

test("WITHOUT THE ROUTER: on a WETH pair a curve sale pays ether: the card says ETH both ways, and the WETH the curve paid is unwrapped straight after", async () => withoutRouter(async () => {
  test.setTimeout(240_000);
  const token = await ensureWethLaunch();
  const seller = await wethSeller();
  const p = await openToken(token, seller);
  await expect(p.locator("#tvStatus")).toHaveText("Selling");
  await expect(p.locator("#tvPair")).toHaveText("Paired: ETH");
  await expect(p.locator("#tvPayAsset")).toHaveText("ETH");
  // DOLLARS ON THE ETH PAIR TOO, by ETH / USD.
  await expect(p.locator("#tvMcap")).toContainText("$", { timeout: 30_000 });
  const want = await curveMcapUsd(p);
  expect(Math.abs(shownNumber(await p.locator("#tvMcap").textContent()) - want.usd) / want.usd).toBeLessThan(0.02);

  await tradeOnCard(p, "buy", "0.01", { with: "eth" });
  // WETH HELD FROM BEFORE, which the unwrap must leave alone: only what the sale paid.
  await rpc("eth_sendTransaction", [{ from: seller, to: WETH, data: await sel("deposit()"), value: "0x" + (5n * 10n ** 15n).toString(16) }]);
  await cardSide(p, "sell");
  await payWith(p, "eth");
  await expect(p.locator("#tvPayAsset")).toHaveText("WPR");
  await expect(p.locator("#tvGetAsset"), "a curve sale on the WETH pair is not named as paying ether").toHaveText("ETH");

  const wethBefore = await wethOf(seller);
  const sentBefore = await p.evaluate(() => window.ethereum.sent.length);
  const fromBlock = await rpc("eth_blockNumber", []);
  await availableRead(p);
  await p.click('#tvPcts [data-pct="50"]');
  await expect(p.locator("#tvQuote"), "the seller was not told the wallet asks twice")
    .toContainText("unwrapped into ETH straight after", { timeout: 20_000 });
  await expect(p.locator("#tvAct")).toBeEnabled({ timeout: 20_000 });
  await p.click("#tvAct");
  await expect(p.locator("#msg")).toContainText("unwrapped straight after", { timeout: 90_000 });

  // THE CHAIN: what the curve paid, and what was unwrapped - the same number.
  const curve = await p.evaluate(() => window.CurbApp.state.view.curve);
  const sells = await rpc("eth_getLogs", [{ address: curve, topics: [SELL_TOPIC], fromBlock, toBlock: "latest" }]);
  expect(sells.length, "expected this one sale").toBe(1);
  const paid = wordAt(sells[0].data, 1);
  const sent = (await p.evaluate(() => window.ethereum.sent.map((t) => ({ to: t.to, data: t.data })))).slice(sentBefore);
  const unwraps = sent.filter((t) => t.to.toLowerCase() === WETH && t.data.toLowerCase().startsWith(WITHDRAW));
  expect(unwraps.length, "no unwrap was sent after the sale").toBe(1);
  expect(BigInt("0x" + unwraps[0].data.slice(10)), "the unwrap is not exactly what the sale paid").toBe(paid);
  expect(await wethOf(seller), "the sale's WETH stayed in the wallet").toBe(wethBefore);
  const exact = (await p.locator("#msg").textContent()).match(/unwrapped\s+(\d+)/);
  expect(exact && BigInt(exact[1]), "the report's unwrapped figure is not what the chain unwrapped").toBe(paid);
  await p.close();
}));

test("WITHOUT THE ROUTER: an unwrap declined in the wallet leaves the WETH, says so, and Unwrap to ETH turns it into ether later", async () => withoutRouter(async () => {
  test.setTimeout(240_000);
  const token = await ensureWethLaunch();
  const seller = await wethSeller();
  const p = await openToken(token, seller);
  await expect(p.locator("#tvStatus")).toHaveText("Selling");
  const held = BigInt(await ethCall(token, (await sel("balanceOf(address)")) + word(BigInt(seller))));
  if (held === 0n) await tradeOnCard(p, "buy", "0.01", { with: "eth" });
  // THE WALLET DECLINES THE UNWRAP - and only the unwrap.
  await p.evaluate((withdraw) => {
    window.ethereum.cfg.onSend = (tx, w) => {
      const unwrap = String(tx.to || "").toLowerCase() === "0x4200000000000000000000000000000000000006" &&
        String(tx.data || "").toLowerCase().startsWith(withdraw);
      w.cfg.sendError = unwrap ? Object.assign(new Error("User rejected the request."), { code: 4001 }) : null;
    };
  }, WITHDRAW);
  const wethBefore = await wethOf(seller);
  await tradeOnCard(p, "sell", "100%", { with: "eth" });
  // THE SALE IS DONE AND SAID SO; THE WETH IS SAID TO BE THERE STILL.
  await expect(p.locator("#msg")).toContainText("Done. The curve gave you");
  await expect(p.locator("#msg")).toContainText("still WETH in your wallet");
  await expect(p.locator("#msg")).toContainText("you declined the unwrap");
  await expect(p.locator("#msg")).toContainText("Unwrap to ETH");
  const left = await wethOf(seller);
  expect(left > wethBefore, "the sale paid no WETH, so this proves nothing").toBe(true);

  // AND IT IS OFFERED AS ETHER, in the swap card.
  await p.evaluate(() => { window.ethereum.cfg.onSend = null; window.ethereum.cfg.sendError = null; });
  await expect(p.locator("#tvUnwrapSlot #unwrapBox")).toBeVisible({ timeout: 30_000 });
  await expect(p.locator("#unwrapText")).toContainText("WETH");
  await p.click("#unwrap");
  await expect(p.locator("#msg")).toContainText("Unwrapped", { timeout: 60_000 });
  expect(await wethOf(seller), "WETH is still in the wallet after Unwrap").toBe(0n);
  const exact = (await p.locator("#msg").textContent()).match(/unwrapped\s+(\d+)/);
  expect(exact && BigInt(exact[1]), "the report's figure is not the WETH the account held").toBe(left);
  await expect(p.locator("#unwrapBox")).toBeHidden({ timeout: 30_000 });
  await p.close();
}));

test("WITHOUT THE ROUTER: a wallet that cannot take ether from WETH is told so after a sale, and is never asked to sign the unwrap", async () => withoutRouter(async () => {
  test.setTimeout(240_000);
  const token = await ensureWethLaunch();
  // A WALLET THAT IS A CONTRACT, spending more than WETH's 2,300 gas to receive
  // ether: its code writes storage on every call (PUSH1 1 PUSH1 0 SSTORE STOP).
  const wallet = "0x" + keccak("curb token.spec contract wallet").slice(-40);
  await rpc("anvil_setCode", [wallet, "0x600160005500"]);
  await rpc("anvil_impersonateAccount", [wallet]);
  await rpc("anvil_setBalance", [wallet, "0x" + (10n ** 19n).toString(16)]);
  const p = await openToken(token, wallet);
  await expect(p.locator("#tvStatus")).toHaveText("Selling");
  await tradeOnCard(p, "buy", "0.01", { with: "eth" });
  const before = await p.evaluate(() => window.ethereum.sent.length);
  const wethBefore = await wethOf(wallet);
  await tradeOnCard(p, "sell", "100%", { with: "eth" });
  await expect(p.locator("#msg")).toContainText("Done. The curve gave you");
  await expect(p.locator("#msg")).toContainText("cannot take ether from WETH");
  // AND IS NOT SENT TO A BUTTON THAT WOULD FAIL THE SAME WAY.
  await expect(p.locator("#msg")).not.toContainText("Unwrap to ETH");
  const sent = (await p.evaluate(() => window.ethereum.sent.map((t) => ({ to: t.to, data: t.data })))).slice(before);
  expect(sent.some((t) => t.to.toLowerCase() === WETH && t.data.toLowerCase().startsWith(WITHDRAW)),
    "the wallet was asked to sign an unwrap that reverts").toBe(false);
  expect(await wethOf(wallet) > wethBefore, "the sale's WETH is not in the wallet").toBe(true);
  await p.close();
}));

test("WITHOUT THE ROUTER: a buy past the threshold on the WETH pair gets its refund back as ether, and the pool it opens trades in ether", async () => withoutRouter(async () => {
  test.setTimeout(300_000);
  // A LAUNCH OF ITS OWN: this one is filled and moved into its pool.
  const token = await createOn(await factoryFor(WETH), "Weth Refund", "WRF");
  const buyer = await wethSeller();
  const p = await openToken(token, buyer);
  await expect(p.locator("#tvStatus")).toHaveText("Selling");
  const thr = await p.evaluate(() => window.CurbApp.state.view.graduationThreshold.toString());
  const offer = (BigInt(thr) * 3n) / 2n;              // half again the threshold: the curve refunds the rest
  const wethBefore = await wethOf(buyer);
  const fromBlock = await rpc("eth_blockNumber", []);
  await tradeOnCard(p, "buy", (Number(offer) / 1e18).toString(), { with: "eth" });
  await expect(p.locator("#msg")).toContainText("refunded");
  await expect(p.locator("#msg")).toContainText("unwrapped straight after");
  // THE CHAIN: the curve's refund, and the same WETH unwrapped - none left behind.
  const curve = await p.evaluate(() => window.CurbApp.state.view.curve);
  const refunds = await rpc("eth_getLogs", [{ address: curve, topics: [keccak("CurveBuyRefunded(address,uint256)")], fromBlock, toBlock: "latest" }]);
  expect(refunds.length, "the buy was not refunded, so this proves nothing").toBe(1);
  const refunded = wordAt(refunds[0].data, 0);
  const exact = (await p.locator("#msg").textContent()).match(/unwrapped\s+(\d+)/);
  expect(exact && BigInt(exact[1]), "the refund was not unwrapped whole").toBe(refunded);
  expect(await wethOf(buyer), "the refund stayed in the wallet as WETH").toBe(wethBefore);

  // THE MOVE, and the pool: ETH by default on the long page as on this one.
  await p.evaluate(() => window.CurbApp.refresh(true));
  if ((await p.locator("#tvStatus").textContent()).trim() !== "Graduated") {
    await expect(p.locator("#tvAct")).toHaveText("Complete the move", { timeout: 30_000 });
    await p.click("#tvAct");
    await expect(p.locator("#msg")).toContainText("graduated in", { timeout: 60_000 });
  }
  await p.close();
  const q = await newPage(buyer);
  await q.goto("/app.html?" + new URLSearchParams({ rpc: STATE.rpc, factory: await factoryFor(WETH), lens: APP.lens, token }).toString());
  await expect(q.locator("#status")).toHaveText("Graduated", { timeout: 30_000 });
  await expect(q.locator("#poolBox")).toBeVisible();
  expect(await q.locator("#poolVia").inputValue(), "a WETH pool on the long page does not start on ETH").toBe("eth");
  await q.close();
}));

test("the creator's fees are two figures and one Claim, which sweeps the curve and claims the rest", async () => {
  test.setTimeout(150_000);
  const c = await ensureCreated();
  const p = await openToken(c.token);
  await expect(p.locator("#tvStatus")).toHaveText("Selling");
  // SOMETHING ON THE CURVE: a buy leaves the creator's tax there.
  await tradeOnCard(p, "buy", "1");
  await expect(p.locator("#tvUnswept"), "nothing waits on the curve, so this proves nothing").toBeVisible({ timeout: 30_000 });
  await expect(p.locator("#tvFees .tvFeeBox")).toHaveCount(2);
  await expect(p.locator("#tvClaimAct")).toBeVisible();
  await expect(p.locator("#tvClaimAct")).toBeEnabled({ timeout: 20_000 });
  const quote = await p.evaluate(() => window.CurbApp.state.ctx.quote);
  const escrow = addrOf(await ethCall(APP.factory, await sel("feeEscrow()")));
  const held = async () => BigInt(await ethCall(quote, (await sel("balanceOf(address)")) + word(BigInt(OWNER))));
  // "CLAIMABLE NOW" IS WHAT CLAIM PAYS: the escrow, the hook and what the sweep
  // will credit this address - the creator's tax, and, since the deployment's
  // creator here is the platform's recipient too, the platform's part. It used
  // to leave the curve's part out, and Claim paid more than it said.
  const curveAddr = await p.evaluate(() => window.CurbApp.state.view.curve);
  const hook = await p.evaluate(() => window.CurbApp.state.ctx.hook);
  const owedTo = async () => {
    const [e, h, tax, fee] = await Promise.all([
      ethCall(escrow, (await sel("balanceOfToken(address,address)")) + word(BigInt(OWNER)) + word(BigInt(quote))),
      ethCall(hook, (await sel("owed(address,address)")) + word(BigInt(OWNER)) + word(BigInt(quote))),
      ethCall(curveAddr, await sel("creatorTaxBalance()")), ethCall(curveAddr, await sel("quoteFeeBalance()")),
    ]);
    expect(addrOf(await ethCall(curveAddr, await sel("protocolFeeRecipient()"))), "the fixture's creator is not the platform's recipient")
      .toBe(OWNER);
    return BigInt(e) + BigInt(h) + BigInt(tax) + BigInt(fee);
  };
  const due = await owedTo();
  expect(BigInt(await ethCall(curveAddr, await sel("creatorTaxBalance()"))), "nothing waits on the curve").toBeGreaterThan(0n);
  const dueText = await p.evaluate(([x]) => window.CurbApp.fmt(BigInt(x), window.CurbApp.state.ctx.quoteDecimals, 6), [String(due)]);
  await expect(p.locator("#tvClaimable"), "the card's figure is not what Claim pays").toHaveText(dueText + " NVDAc", { timeout: 30_000 });
  const before = await held();
  await p.click("#tvClaimAct");
  await expect(p.locator("#msg")).toContainText("Claimed", { timeout: 90_000 });
  await expect(p.locator("#msg")).toContainText("swept in first");
  expect(await held() - before, "Claim did not pay what the card said").toBe(due);
  // THE CHAIN: nothing left on the curve or in the escrow, and the asset arrived.
  const curve = await p.evaluate(() => window.CurbApp.state.view.curve);
  expect(BigInt(await ethCall(curve, await sel("creatorTaxBalance()"))), "the curve still holds the creator's tax").toBe(0n);
  expect(BigInt(await ethCall(escrow, (await sel("balanceOfToken(address,address)")) + word(BigInt(OWNER)) + word(BigInt(quote)))),
    "the escrow still holds something for the creator").toBe(0n);
  expect(await held() > before, "nothing reached the creator's wallet").toBe(true);
  await expect(p.locator("#tvUnswept")).toBeHidden({ timeout: 30_000 });
  await p.close();
  // SOMEONE ELSE SEES THE FIGURES, NOT THE BUTTON.
  const q = await openToken(c.token, TRADER);
  await expect(q.locator("#tvFeeWho")).toHaveText("Paid to " + OWNER.slice(0, 6) + "…" + OWNER.slice(-4), { ignoreCase: true, timeout: 30_000 });
  await expect(q.locator("#tvClaimAct")).toBeHidden();
  await q.close();
});

// ------------------------------------------------------------------ the clock and the unit, put right
/// THE DOLLAR PRICE'S AGE IS BY THE CHAIN'S CLOCK FROM THE FIRST DRAW. It used to
/// be dated by this computer's clock until the trade history had been read -
/// on this fork, three weeks from the chain's, so the tooltip said "21d ago"
/// and twenty seconds later "9h ago". Every log read is held back here, so the
/// history never lands and only the first draw's clock can be what is seen.
test("the dollar price's age on a launch's page is the chain's from the first draw, with the trade history not yet read", async () => {
  const c = await ensureCreated();
  const p = await newPage(OWNER);
  const parked = [];
  await p.route("**/*", async (route) => {
    let msg = null;
    try { msg = JSON.parse(route.request().postData() || ""); } catch { msg = null; }
    if (msg && !Array.isArray(msg) && msg.method === "eth_getLogs") { parked.push(route); return; }
    return route.fallback();
  });
  await p.goto("/token/" + c.token + "?" + new URLSearchParams({ rpc: STATE.rpc, lens: APP.lens }).toString());
  // THE HISTORY'S FIRST LOG READ IS HELD - so it cannot land - before the
  // tooltip is read.
  await expect.poll(() => parked.length, { timeout: 30_000, message: "no log read was held, so the history could have landed" })
    .toBeGreaterThan(0);
  await expect(p.locator("#tvMcap")).toHaveAttribute("title", /Chainlink\), (its price as of \d+[mhd] ago|just updated)$/, { timeout: 30_000 });
  const feed = FEEDS["0xb20000000000000000000078ee7ce2fe4908108c"][0];
  const round = (await ethCall(feed, await sel("latestRoundData()"))).replace(/^0x/, "");
  const updatedAt = Number(BigInt("0x" + round.slice(3 * 64, 4 * 64)));
  const head = Number(BigInt((await rpc("eth_getBlockByNumber", ["latest", false])).timestamp));
  const wall = Math.floor(Date.now() / 1000);
  test.skip(Math.abs(wall - head) < 3 * 3600, "this chain's clock is the wall clock's, so the two cannot be told apart");
  const s = Math.max(0, head - updatedAt);
  const title = await p.locator("#tvMcap").getAttribute("title");
  if (s < 45) {
    expect(title, "the age is not the chain's: " + title).toContain("just updated");
  } else {
    const m = title.match(/its price as of (\d+)([mhd]) ago$/);
    const unit = s < 3600 ? "m" : s < 86400 ? "h" : "d";
    const n = unit === "m" ? s / 60 : unit === "h" ? s / 3600 : s / 86400;
    expect(m && m[2], "the age is not in the chain's unit: " + title).toBe(unit);
    expect(Math.abs(Number(m[1]) - Math.round(n)), "the age is not the chain's: " + title).toBeLessThanOrEqual(1);
  }
  for (const r of parked) r.abort().catch(() => {});
  await p.close();
});

/// ON A WETH PAIR, WITH WETH CHOSEN, THE FEE IS SAID IN WETH, as the minimum
/// above it is. It said "Minimum received: 0.000552 WETH" over "Fee and tax,
/// taken from this trade: 0.000011 ETH". With ETH chosen both say ETH.
test("on a WETH pair a sale with WETH chosen says its fee in WETH, as its minimum; with ETH chosen, both in ETH", async () => {
  test.setTimeout(150_000);
  const token = await ensureWethLaunch();
  const seller = await wethSeller();
  const p = await openToken(token, seller);
  await expect(p.locator("#tvStatus")).toHaveText("Selling");
  await tradeOnCard(p, "buy", "0.01", { with: "eth" });
  await expect(p.locator("#tvPay")).toHaveValue("", { timeout: 30_000 });
  await cardSide(p, "sell");
  await payWith(p, "asset");
  await expect(p.locator("#tvGetAsset")).toHaveText("WETH");
  await availableRead(p);
  await p.click('#tvPcts [data-pct="50"]');
  await expect(p.locator("#tvQuote")).toContainText("Minimum received:", { timeout: 30_000 });
  const lines = async () => (await p.locator("#tvQuote div").allTextContents());
  let all = await lines();
  expect(all.find((l) => l.startsWith("Minimum received:")), "the minimum is not in WETH").toMatch(/ WETH$/);
  expect(all.find((l) => l.startsWith("Fee and tax")), "the fee is not in WETH: " + all.join(" | ")).toMatch(/ WETH$/);
  // THE CONTROL: with ETH chosen, both are ETH.
  await payWith(p, "eth");
  await availableRead(p);
  await p.click('#tvPcts [data-pct="50"]');
  await expect(p.locator("#tvQuote")).toContainText("Minimum received:", { timeout: 30_000 });
  all = await lines();
  expect(all.find((l) => l.startsWith("Minimum received:"))).toMatch(/ ETH$/);
  expect(all.find((l) => l.startsWith("Fee and tax")), "the fee is not in ETH: " + all.join(" | ")).toMatch(/ ETH$/);
  await p.close();
});

// ------------------------------------------------------------------ the header and the creator's card, put right
test("the Paired badge keeps to one line beside a long name, inside its column", async () => {
  test.setTimeout(150_000);
  const token = await createOn(APP.factory, "Graduated Nvda Wide Name", "WIDENAME");
  const p = await openToken(token);
  await expect(p.locator("#tvPair")).toContainText("Paired:", { timeout: 30_000 });
  await expect(p.locator("#tvPair")).toContainText("NVDAc");
  const box = await p.evaluate(() => {
    const b = document.getElementById("tvPair").getBoundingClientRect();
    const c = document.querySelector(".tvWho").getBoundingClientRect();
    const st = document.getElementById("tvStatus").getBoundingClientRect();
    const lh = parseFloat(getComputedStyle(document.getElementById("tvPair")).fontSize) * 1.25;
    return { h: b.height, right: b.right, whoRight: c.right, statusLeft: st.left, lh };
  });
  // ONE LINE OF 10.5px TEXT, its padding and its border: under two lines' height.
  expect(box.h, `the Paired badge broke over more than one line (${box.h}px tall)`).toBeLessThan(box.lh * 2);
  // AND IT STAYS IN ITS COLUMN: not over the status tag beside it.
  expect(box.right, "the Paired badge runs out of the name's column").toBeLessThanOrEqual(box.whoRight + 0.5);
  expect(box.right, "the Paired badge runs under the status tag").toBeLessThanOrEqual(box.statusLeft);
  await p.close();
});

test("on a launch still on its curve, the creator's earned figure says it counts what was swept", async () => {
  const c = await ensureCreated();
  const p = await openToken(c.token);
  await expect(p.locator("#tvStatus")).toHaveText("Selling");
  await expect(p.locator("#tvEarnedNote"), "the figure reads as everything earned while the curve holds more")
    .toContainText("swept so far", { timeout: 30_000 });
  await expect(p.locator("#tvEarnedNote")).not.toContainText("earned");
  await p.close();
});

test("the holders tab sums the token's transfers, and the curve is named as such", async () => {
  const c = await ensureCreated();
  const p = await openToken(c.token);
  // A HOLDER TO LIST: the buyer, when no test before this one bought.
  const held = BigInt(await ethCall(c.token, (await sel("balanceOf(address)")) + word(BigInt(OWNER))));
  if (held === 0n) await tradeOnCard(p, "buy", "1");
  await expect(p.locator("#tvTradeCount")).not.toHaveText(/^(—|0)$/, { timeout: 30_000 });
  await p.click("#tvTabHolders");
  await expect(p.locator("#tvList")).toContainText("bonding curve", { timeout: 20_000 });
  // THE BUYER'S LINE MATCHES ITS BALANCE ON CHAIN.
  const bal = BigInt(await ethCall(c.token, (await sel("balanceOf(address)")) + word(BigInt(OWNER))));
  expect(bal > 0n, "the buyer holds nothing, so the list proves nothing").toBe(true);
  await expect.poll(async () => (await p.locator("#tvList .tvLine").allInnerTexts())
    .some((r) => r.toLowerCase().includes(OWNER.slice(0, 6))), { timeout: 20_000 }).toBe(true);
  await p.close();
});

test("after the move into the pool, burned tokens are no holder and the shares add up", async () => {
  const c = await ensureCreated();
  const p = await openToken(c.token);
  await expect(p.locator("#tvStatus")).toHaveText("Selling", { timeout: 30_000 });
  // PAST THE THRESHOLD through the card, then the move through the card.
  await payWith(p, "asset");
  await p.fill("#tvPay", "70");
  await expect(p.locator("#tvGet")).not.toHaveText("0", { timeout: 20_000 });
  await p.click("#tvAct");
  await expect(p.locator("#msg")).toContainText("Done", { timeout: 60_000 });
  await p.evaluate(() => window.CurbApp.refresh(true));
  const status = (await p.locator("#tvStatus").textContent()).trim();
  if (status !== "Graduated") {
    await expect(p.locator("#tvAct")).toHaveText("Complete the move", { timeout: 30_000 });
    await p.click("#tvAct");
    await expect(p.locator("#msg")).toContainText("graduated in", { timeout: 60_000 });
  }
  await p.evaluate(() => window.CurbApp.refresh(true));
  await expect(p.locator("#tvStatus")).toHaveText("Graduated", { timeout: 30_000 });
  // THE CHOICE MADE ON THE CURVE IS KEPT IN THE POOL (the pair's asset here)...
  await expect(p.locator("#tvPayAsset")).toHaveText("NVDAc", { timeout: 20_000 });
  // ...AND A FRESH VISIT TO A GRADUATED LAUNCH STARTS ON ETH, routed in one
  // transaction through the pool.
  const fresh = await openToken(c.token);
  await expect(fresh.locator("#tvStatus")).toHaveText("Graduated");
  await expect(fresh.locator("#tvPayAsset"), "a graduated stock pair's card does not start on ETH").toHaveText("ETH");
  await fresh.fill("#tvPay", "0.01");
  await expect(fresh.locator("#tvQuote")).toContainText("Minimum received", { timeout: 30_000 });
  expect(await fresh.evaluate(() => document.getElementById("poolVia").value), "the pool was not asked for the ETH route").toBe("eth");
  await fresh.close();
  // THE BURN IS ON CHAIN: the Graduator's own record of it.
  const graduator = addrOf(await ethCall(APP.factory, await sel("graduator()")));
  const burned = BigInt(await ethCall(graduator, (await sel("burnedOf(address)")) + word(BigInt(c.token))));
  expect(burned > 0n, "nothing was burned, so this proves nothing").toBe(true);

  await p.click("#tvTabHolders");
  await expect(p.locator("#tvList")).toContainText("Uniswap v4 pool", { timeout: 30_000 });
  const rows = await p.locator("#tvList .tvLine").allInnerTexts();
  expect(rows.some((r) => /burned/i.test(r)), "the burned remainder was listed as a holder").toBe(false);
  expect(rows.some((r) => r.includes("0x0000")), "the zero address was listed as a holder").toBe(false);
  const shares = rows.map((r) => Number((r.match(/([0-9.]+)%/) || [])[1] || 0)).reduce((a, b) => a + b, 0);
  expect(shares, "the shares do not add up to the supply that remains").toBeLessThanOrEqual(100.5);
  await expect(p.locator("#tvHistNote")).toContainText("burned");
  await p.close();
});


test("a wallet on another network is offered a switch to the page's network, and the trade goes through after it", async () => {
  test.setTimeout(120_000);
  const c = await ensureCreated();
  // A WALLET ON ETHEREUM THAT HAS NEVER HEARD OF THE PAGE'S NETWORK.
  const p = await newPage(OWNER, { chainId: "0x1", knownChains: ["0x1"] });
  await p.goto("/token/" + c.token + "?" + new URLSearchParams({ rpc: STATE.rpc, lens: APP.lens }).toString());
  await expect(p.locator("#tvStatus")).not.toHaveText("—", { timeout: 30_000 });
  await p.evaluate(() => window.CurbApp.connect());
  // SAID AT CONNECT, with the way out.
  await expect(p.locator("#msg")).toContainText("Your wallet is on chain 1", { timeout: 30_000 });
  const node = await rpc("eth_chainId", []);
  await expect(p.locator("#msg button[data-switch-chain]")).toHaveAttribute("data-switch-chain", node);
  // AND WHEN A TRADE IS REFUSED FOR IT: the notice from connect is cleared
  // first, so the button below is the refusal's own.
  await p.evaluate(() => { const m = document.getElementById("msg"); m.textContent = ""; m.hidden = true; });
  await expect.poll(() => p.evaluate(() => ((window.CurbApp.state.viewFor || {}).token || "").toLowerCase()),
    { timeout: 30_000 }).toBe(c.token.toLowerCase());
  await payWith(p, "asset");
  await p.fill("#tvPay", "1");
  await expect(p.locator("#tvAct")).toBeEnabled({ timeout: 20_000 });
  await p.click("#tvAct");
  await expect(p.locator("#msg")).toContainText("nothing is sent until they are the same network", { timeout: 30_000 });
  await expect(p.locator("#msg button[data-switch-chain]"), "the refusal offers no way out").toHaveAttribute("data-switch-chain", node);
  expect(await p.evaluate(() => window.ethereum.sent.length), "something was sent from the wrong network").toBe(0);
  await p.click("#msg button[data-switch-chain]");
  await expect(p.locator("#msg"), "the switch did not say it was done").toContainText("now, the network this page reads", { timeout: 20_000 });
  const w = await p.evaluate(() => ({ chain: window.ethereum.cfg.chainId, switches: window.ethereum.switches, added: window.ethereum.added }));
  // ASKED TO SWITCH, TOLD 4902, ASKED TO ADD - the network this page reads.
  expect(w.switches[0]).toBe(node);
  expect(w.added.length, "the unknown network was not offered to the wallet to add").toBe(1);
  expect(w.added[0].chainId).toBe(node);
  expect(w.chain).toBe(node);
  // BASE IS ADDED WITH ITS OWN PUBLIC ENDPOINT AND ITS EXPLORER, never this
  // run's local one: a wallet keeps what it is given here for every later
  // visit, long after this page is closed.
  expect(node, "this run's node does not serve Base's chain id, so the entry checked is not Base's").toBe("0x2105");
  expect(w.added[0].rpcUrls, "the added network's endpoint is not Base's public one").toEqual(["https://mainnet.base.org"]);
  expect(w.added[0].blockExplorerUrls, "the added network carries no Basescan").toEqual(["https://basescan.org"]);
  expect(w.added[0].nativeCurrency).toEqual({ name: "Ether", symbol: "ETH", decimals: 18 });
  // AND NOW A TRADE IS SENT.
  await expect.poll(() => p.evaluate(() => ((window.CurbApp.state.viewFor || {}).token || "").toLowerCase()),
    { timeout: 30_000 }).toBe(c.token.toLowerCase());
  await tradeOnCard(p, "buy", "1");
  // ON BASE THE RESULT LINKS TO ITS TRANSACTION ON BASESCAN - this trade's own
  // transaction, mined, from this wallet - and the launch's links to its token.
  const href = await p.locator("#msg a.toastChain").getAttribute("href");
  const m = String(href).match(/^https:\/\/basescan\.org\/tx\/(0x[0-9a-f]{64})$/i);
  expect(m, "the result's link is not a Basescan transaction: " + href).not.toBeNull();
  const rc = await rpc("eth_getTransactionReceipt", [m[1]]);
  expect(rc && rc.status, "the result links to a transaction that was not mined: " + m[1]).toBe("0x1");
  expect(rc.from.toLowerCase(), "the result links to somebody else's transaction").toBe(OWNER);
  await expect(p.locator("#msg a.toastChain")).toHaveAttribute("target", "_blank");
  await expect(p.locator("#tvLinks a", { hasText: "Basescan" }))
    .toHaveAttribute("href", new RegExp("^https://basescan\\.org/token/" + c.token + "$", "i"));
  await p.close();
});

/// A REFUSED TRADE'S AMOUNT SURVIVES THE SWITCH PRESSED RIGHT AFTER IT. The
/// refusal's refresh can land after the switch has written "ok" on the line;
/// read off the line then, the refused amount was wiped as if it had gone
/// through. The refresh is held here until the switch is done, so the late
/// landing is certain rather than a matter of the node's speed.
test("a trade refused for the wrong network keeps its amount when the switch is pressed before the refusal's refresh lands", async () => {
  test.setTimeout(120_000);
  const c = await ensureCreated();
  const p = await newPage(OWNER, { chainId: "0x1", knownChains: ["0x1"] });
  await p.goto("/token/" + c.token + "?" + new URLSearchParams({ rpc: STATE.rpc, lens: APP.lens }).toString());
  await expect(p.locator("#tvStatus")).not.toHaveText("—", { timeout: 30_000 });
  await p.evaluate(() => window.CurbApp.connect());
  await expect(p.locator("#msg")).toContainText("Your wallet is on chain 1", { timeout: 30_000 });
  await expect.poll(() => p.evaluate(() => ((window.CurbApp.state.viewFor || {}).token || "").toLowerCase()),
    { timeout: 30_000 }).toBe(c.token.toLowerCase());
  await payWith(p, "asset");
  await p.fill("#tvPay", "1");
  await expect(p.locator("#tvAct")).toBeEnabled({ timeout: 20_000 });
  await p.evaluate(() => {
    const send = document.dispatchEvent.bind(document);
    window.__held = [];
    window.__hold = true;
    document.dispatchEvent = (ev) => {
      if (window.__hold && ev.type === "curb:refreshed") { window.__held.push(ev); return true; }
      return send(ev);
    };
    window.__release = () => { window.__hold = false; for (const ev of window.__held.splice(0)) send(ev); };
  });
  await p.click("#tvAct");
  await expect(p.locator("#msg")).toContainText("nothing is sent until they are the same network", { timeout: 30_000 });
  await expect.poll(() => p.evaluate(() => window.__held.length), { timeout: 30_000, message: "the refusal's refresh never ended" })
    .toBeGreaterThan(0);
  await p.click("#msg button[data-switch-chain]");
  await expect(p.locator("#msg")).toContainText("now, the network this page reads", { timeout: 20_000 });
  expect(await p.locator("#msg").getAttribute("class")).toBe("ok");
  await p.evaluate(() => window.__release());
  await p.waitForTimeout(500);
  await expect(p.locator("#tvPay"), "the refused trade's amount was wiped by its late refresh").toHaveValue("1");
  expect(await p.evaluate(() => window.ethereum.sent.length), "something was sent").toBe(0);
  await p.close();
});

test("the network and contracts panel starts closed for someone launching, open for a link that names it, and stays as its reader left it", async () => {
  const p = await newPage(OWNER);
  // NO LINK: what someone arriving to launch a token sees.
  await p.goto("/app.html#create-launch");
  await p.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
  expect(await p.evaluate(() => document.getElementById("wherePanel").open), "the panel is open for someone who only came to launch").toBe(false);
  await expect(p.locator("#rpc")).toBeHidden();
  // A LINK THAT NAMES THE ENDPOINT AND CONTRACTS: a fork, a test, a check.
  await p.goto("/app.html?" + new URLSearchParams({ rpc: STATE.rpc, lens: APP.lens, factory: APP.factory }).toString());
  await p.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
  await expect(p.locator("#rpc")).toBeVisible();
  // CLOSED BY ITS READER: it stays closed, link or not.
  await p.click("#wherePanel > summary");
  await expect(p.locator("#rpc")).toBeHidden();
  await p.reload();
  await p.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
  expect(await p.evaluate(() => document.getElementById("wherePanel").open), "the reader's choice was not kept").toBe(false);
  await p.evaluate(() => localStorage.removeItem("curb.whereOpen"));
  await p.close();
});

test("a ghost button stays readable under the mouse", async () => {
  const p = await newPage(OWNER);
  await p.goto("/app.html?" + new URLSearchParams({ rpc: STATE.rpc, lens: APP.lens, factory: APP.factory }).toString());
  await p.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
  await expect(p.locator("#refresh")).toBeVisible();
  await p.hover("#refresh");
  // THE CONTRAST OF ITS TEXT AGAINST WHAT IS BEHIND IT, the button's own tint over the panel.
  const ratio = await p.evaluate(() => {
    const rgba = (s) => { const m = s.match(/[\d.]+/g).map(Number); return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 }; };
    const b = document.getElementById("refresh");
    const fg = rgba(getComputedStyle(b).color);
    const bg = rgba(getComputedStyle(b).backgroundColor);
    const under = rgba(getComputedStyle(document.getElementById("wherePanel")).backgroundColor);
    const mix = (k) => bg[k] * bg.a + under[k] * (1 - bg.a);
    const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    const L1 = lum(fg), L2 = lum({ r: mix("r"), g: mix("g"), b: mix("b") });
    return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
  });
  expect(ratio, "a hovered ghost button's text is unreadable against its background").toBeGreaterThan(4.5);
  await p.close();
});

test("a launch waiting for its move offers the move, not a trade", async () => {
  // STATE.token is the fixture's waiting launch. Nothing is pressed: the other
  // specs need it waiting.
  const p = await newPage(OWNER);
  await p.goto("/token/" + STATE.token + "?" + new URLSearchParams({ rpc: STATE.rpc, lens: STATE.lens }).toString());
  await expect(p.locator("#tvStatus")).toHaveText("Waiting", { timeout: 30_000 });
  await p.evaluate(() => window.CurbApp.connect());
  await expect(p.locator("#tvAct")).toHaveText("Complete the move", { timeout: 20_000 });
  await expect(p.locator("#tvPcts")).toBeVisible();
  await p.close();
});

// ------------------------------------------------------------------ price impact and the clamp
/// A transaction from the test's side, mined, insisting it succeeded.
async function minedFrom(tx, what) {
  const hash = await rpc("eth_sendTransaction", [tx]);
  let rc = null;
  for (let i = 0; i < 80 && !rc; i++) {
    rc = await rpc("eth_getTransactionReceipt", [hash]);
    if (!rc) await new Promise((r) => setTimeout(r, 250));
  }
  expect(rc && rc.status, what + " did not go through").toBe("0x1");
  return rc;
}

/// THE OWNER'S NOTE: "a 999 ETH buy shows slippage 1% but the token goes 100x".
///
/// Slippage is the tolerance on the quote; the quote itself already holds the
/// trade's own price impact, which the card never showed. It shows it now, and
/// warns above 5% and strongly above 15%; and a buy the threshold clamps says
/// how much of the offer is used and that the rest comes back in the same
/// transaction - on the swap card and on the long page.
///
/// AND THE REAL DEFECT: the curve bounds a buy by its PRICE (spent * min <=
/// received * out), and a clamped buy's minimum was the slippage off the
/// clamped amount - so 999 ETH offered for a fill costing a fraction of one
/// accepted a price hundreds of times worse than quoted. A buyer landing first
/// took most of what was left and this buy still went through, for a sliver.
/// Here one does land first, mined while the wallet sends: the buy must be
/// refused by the curve, not filled at the worse price.
test("a 999 ETH buy shows its price impact and what the threshold lets it spend, and a buyer landing first cannot fill it at a worse price", async () => {
  test.setTimeout(240_000);
  const token = await createOn(await factoryFor(WETH), "Impact Probe", "IMPX");
  const p = await openToken(token);
  const thr = BigInt(await p.evaluate(() => window.CurbApp.state.view.graduationThreshold.toString()));
  // MOST OF THE WAY TO THE THRESHOLD FIRST, so what is left is a sliver.
  await tradeOnCard(p, "buy", (Number((thr * 85n) / 100n) / 1e18).toFixed(6), { with: "eth" });

  await cardSide(p, "buy");
  await payWith(p, "eth");
  await p.fill("#tvSlip", "1");
  await p.fill("#tvPay", "999");
  const quote = p.locator("#tvQuote");
  // THE QUOTE FOR 999, not one still drawn for the amount before it.
  await expect(quote.locator(".tvClamp")).toContainText("of the 999", { timeout: 30_000 });
  await expect(quote).toContainText("Price impact:");
  const impact = Number((await quote.locator(".tvImpact").textContent()).match(/([\d.]+)%/)[1]);
  const v = await p.evaluate(async () => {
    const r = await window.CurbApp.computeCurveQuote();
    const s = (x) => x.toString();
    return { clamped: r.q.clamped, spent: s(r.q.spent), offered: s(r.q.offered), refund: s(r.q.refund), net: s(r.q.net),
      out: s(r.q.out), min: s(r.min), rq: s(r.reserves.quote), rt: s(r.reserves.token) };
  });
  expect(v.clamped, "999 ETH did not reach the threshold, so this proves nothing").toBe(true);
  // THE IMPACT IS THE CURVE'S OWN MOVEMENT: what reaches it at the price now, against what it pays.
  const atMid = (BigInt(v.net) * BigInt(v.rt)) / BigInt(v.rq);
  const want = Number(((atMid - BigInt(v.out)) * 10000n) / atMid) / 100;
  expect(Math.abs(impact - want), `the card's impact ${impact}% is not the curve's ${want}%`).toBeLessThan(0.02);
  // WARNED, and strongly above 15%.
  if (want > 15) await expect(quote.locator(".tvImpactWarn.strong")).toContainText("VERY HIGH PRICE IMPACT");
  else if (want > 5) await expect(quote.locator(".tvImpactWarn")).toContainText("High price impact");
  // WHAT IS USED, AND THAT THE REST COMES BACK IN THE SAME TRANSACTION.
  const fmt6 = (x) => p.evaluate((a) => window.CurbApp.fmt(BigInt(a), 18, 6), x);
  await expect(quote.locator(".tvClamp")).toContainText("Only " + (await fmt6(v.spent)) + " of the 999 ETH offered will be used");
  await expect(quote).toContainText("ETH, in the same transaction");
  await expect(quote, "a clamped buy still claims a fixed minimum").toContainText("Minimum received: no fixed amount");

  // THE LONG PAGE SAYS THE SAME.
  const lp = await newPage(OWNER);
  await lp.goto("/app.html?" + new URLSearchParams({ rpc: STATE.rpc, factory: await factoryFor(WETH), lens: APP.lens, token }).toString());
  await lp.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
  await lp.evaluate(() => window.CurbApp.connect());
  await lp.selectOption("#curveSide", "buy");
  await lp.fill("#curveAmount", "999");
  await lp.fill("#slippage", "1");
  await lp.evaluate(() => window.CurbApp.refresh(true));
  await expect(lp.locator("#curveQuote .row", { hasText: "price impact" })).toContainText(impact.toFixed(2) + "%", { timeout: 30_000 });
  await expect(lp.locator("#curveQuote .clampNote")).toContainText("It comes back to you as ETH, in the same transaction.");
  await expect(lp.locator("#curveQuote .clampNote")).toContainText("of the 999");
  await lp.close();

  // A BUYER LANDS FIRST, mined while the wallet sends, taking most of what is left.
  const curve = await p.evaluate(() => window.CurbApp.state.view.curve);
  const router = (await p.evaluate(() => window.CurbApp.CURB_ROUTER.address)).toLowerCase();
  const fr = "0x" + keccak("curb token.spec front runner").slice(-40);
  await rpc("anvil_impersonateAccount", [fr]);
  await rpc("anvil_setBalance", [fr, "0x" + (10n ** 21n).toString(16)]);
  const first = (thr * 11n) / 100n;
  await minedFrom({ from: fr, to: WETH, value: "0x" + first.toString(16), data: await sel("deposit()") }, "the wrap");
  await minedFrom({ from: fr, to: WETH, data: (await sel("approve(address,uint256)")) + word(BigInt(curve)) + word(first) }, "the approval");
  let landed = false;
  await p.route("**/*", async (route) => {
    const req = route.request();
    let m = null;
    try { m = req.method() === "POST" ? JSON.parse(req.postData() || "") : null; } catch { m = null; }
    if (m && m.method === "eth_sendTransaction" && String(m.params[0].to).toLowerCase() === router && !landed) {
      landed = true;
      await minedFrom({ from: fr, to: curve, data: (await sel("buy(uint256,uint256,address)")) + word(first) + word(1) + word(BigInt(fr)) },
        "the buy that lands first");
    }
    return route.continue();
  });
  const held = BigInt(await ethCall(token, (await sel("balanceOf(address)")) + word(BigInt(OWNER))));
  await expect(p.locator("#tvAct")).toBeEnabled({ timeout: 20_000 });
  // THE LINE STILL HOLDS THE FIRST BUY'S "Done": cleared, so the answer read is this one's.
  await p.evaluate(() => { const m = document.getElementById("msg"); m.textContent = ""; m.className = ""; });
  await p.click("#tvAct");
  await expect(p.locator("#msg")).toContainText(/reverted|Done/, { timeout: 90_000 });
  expect(landed, "no buy landed first, so this proves nothing").toBe(true);
  await expect(p.locator("#msg"), "the clamped buy filled at a price worse than its bound").toContainText("reverted");
  expect(BigInt(await ethCall(token, (await sel("balanceOf(address)")) + word(BigInt(OWNER)))),
    "tokens arrived from a buy that should have been refused").toBe(held);
  await p.unroute("**/*");
  await p.close();
});

// ------------------------------------------------------------------ the history on a public endpoint
/// The launch's curve, as the lens names it (LaunchView word 1).
async function curveOfLaunch(token) {
  return addrOf("0x" + (await ethCall(APP.lens, (await sel("launchState(address)")) + word(BigInt(token)))).slice(2 + 64, 2 + 128));
}
/// A buy on an NVDAc curve from the deployer, mined: a trade for the history to find.
async function buyOnCurve(curve, quoteIn) {
  const nvdac = "0xb20000000000000000000078ee7ce2fe4908108c";
  await minedFrom({ from: OWNER, to: nvdac, data: (await sel("approve(address,uint256)")) + word(BigInt(curve)) + word(quoteIn) }, "the approval");
  await minedFrom({ from: OWNER, to: curve, data: (await sel("buy(uint256,uint256,address)")) + word(quoteIn) + word(0) + word(BigInt(OWNER)) },
    "the buy");
}
/// The curve's trades on chain - every CurveBuy and CurveSell since this fork began.
async function tradesOnChain(curve) {
  const meta = await rpc("anvil_metadata", []);
  const fromBlock = "0x" + (Number(meta.forkedNetwork.forkBlockNumber) + 1).toString(16);
  const topics = [[keccak("CurveBuy(address,address,uint256,uint256,uint256,uint256)"), SELL_TOPIC]];
  return (await rpc("eth_getLogs", [{ address: curve, topics, fromBlock, toBlock: "latest" }])).length;
}
/// THE PAGE'S ENDPOINT AS A PUBLIC ONE SEES IT, and the launch `gap` blocks
/// older than it is. eth_blockNumber answers `gap` blocks past the real head,
/// and the blocks above the real head answer no logs - what a chain that moved
/// on without trading this launch looks like, without mining the blocks (this
/// fork mines about a hundred a second). `opts.limit` refuses a wider range in
/// the words of Base's own endpoint; `opts.busy(n, from, to, filter)` answers
/// HTTP 429 where it returns true, n counting the log reads asked so far.
async function asPublicEndpoint(p, gap, opts = {}) {
  const real = Number(BigInt(await rpc("eth_blockNumber", [])));
  const head = real + gap;
  const seen = { asked: [], served: [], refused: 0, busy: 0 };
  await p.route("**/*", async (route) => {
    const req = route.request();
    let msg = null;
    try { msg = req.method() === "POST" ? JSON.parse(req.postData() || "") : null; } catch { msg = null; }
    if (!msg || Array.isArray(msg)) return route.fallback();
    const answer = (body) => route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...body }) });
    if (msg.method === "eth_blockNumber") return answer({ result: "0x" + head.toString(16) });
    if (msg.method !== "eth_getLogs") return route.fallback();
    const f = msg.params[0];
    // THE HISTORY'S OWN READS NAME ONE ADDRESS; holder sharing's name a list,
    // and are left alone so the counts below are the history's.
    if (typeof f.address !== "string") return route.fallback();
    const from = parseInt(f.fromBlock, 16), to = parseInt(f.toBlock, 16);
    seen.asked.push([from, to]);
    if (opts.limit && to - from + 1 > opts.limit) {
      seen.refused += 1;
      return answer({ error: { code: -32600, message: "eth_getLogs is limited to a " + opts.limit.toLocaleString("en-US") + " range" } });
    }
    if (opts.busy && opts.busy(seen.asked.length, from, to, f)) {
      seen.busy += 1;
      return route.fulfill({ status: 429, contentType: "text/plain", body: "Too Many Requests" });
    }
    seen.served.push([from, to]);
    if (from > real) return answer({ result: [] });
    if (to > real) {
      f.toBlock = "0x" + real.toString(16);
      return route.fallback({ postData: JSON.stringify(msg) });
    }
    return route.fallback();
  });
  return { real, head, seen };
}
/// Every text #tvHistNote is given, kept in window.__notes from the first draw -
/// from the mutation records, so a text replaced in the same turn is kept too.
const WATCH_NOTE = "document.addEventListener('DOMContentLoaded', function () {" +
  " var n = document.getElementById('tvHistNote'); window.__notes = [];" +
  " if (n) new MutationObserver(function (records) { records.forEach(function (r) {" +
  " r.addedNodes.forEach(function (a) { window.__notes.push(a.textContent); });" +
  " if (r.type === 'characterData') window.__notes.push(r.target.data); }); })" +
  ".observe(n, { childList: true, characterData: true, subtree: true }); });";
const notesSaid = (p) => p.evaluate(() => window.__notes || []);

/// A LAUNCH SOME WEEKS OLD, ON AN ENDPOINT THAT LIMITS A LOG RANGE TO 2,000
/// BLOCKS, AS BASE'S PUBLIC ONE DOES. Every refusal used to halve the window and
/// the next success double it straight back, so the limit was met again on
/// every other window (and from 50,000 down, five times before the first), and
/// a 429 halved it as if it were the range. Now the range is refused once and
/// learnt for every read after it, and a rate-limited read is asked again as it
/// was - the whole history arrives, in windows of 2,000.
test("the history is read through an endpoint that limits a log range to 2,000 blocks: the limit is learnt once, and a rate-limited read is asked again as it was", async () => {
  test.setTimeout(150_000);
  const c = await ensureHistoryLaunch();
  const curve = await curveOfLaunch(c.token);
  await buyOnCurve(curve, 10n ** 8n);
  const trades = await tradesOnChain(curve);
  expect(trades, "the launch has no trade, so its history proves nothing").toBeGreaterThan(0);
  const meta = await rpc("anvil_metadata", []);
  const floor = Number(meta.forkedNetwork.forkBlockNumber) + 1;

  const p = await newPage(OWNER, {}, WATCH_NOTE);
  let limited = null;
  const chain = await asPublicEndpoint(p, 6000, { limit: 2000, busy: (n, from, to) => {
    // THE THIRD READ THE RANGE ALLOWS, refused once for being busy.
    if (limited || chain.seen.served.length !== 2) return false;
    limited = [from, to];
    return true;
  } });
  await p.goto("/token/" + c.token + "?" + new URLSearchParams({ rpc: STATE.rpc, lens: APP.lens }).toString());
  await expect(p.locator("#tvTradeCount"), "the history did not arrive whole").toHaveText(String(trades), { timeout: 60_000 });
  expect(limited, "no read was rate-limited, so this proves nothing about it").not.toBeNull();
  expect(chain.seen.served.some(([a, b]) => a === limited[0] && b === limited[1]),
    "the rate-limited window was not asked again as it was").toBe(true);
  expect(chain.seen.refused, "the 2,000-block limit was met more than once: it was not learnt").toBe(1);
  // EVERY WINDOW IS THE WHOLE 2,000, but where it meets the head or the fork's
  // floor: a window narrower than that is a limit learnt wrong, or a 429 read
  // as one.
  const narrow = chain.seen.served.filter(([a, b]) => b !== chain.head && a !== floor && b - a + 1 !== 2000);
  expect(narrow, "windows narrower than the endpoint's limit were asked for").toEqual([]);
  // AND THE LAUNCH WAS READ FROM ITS CREATION, gap and all.
  const low = Math.min(...chain.seen.served.map(([a]) => a));
  expect(chain.head - low, "the history did not reach back past the blocks the chain moved on by").toBeGreaterThan(6000);
  expect((await notesSaid(p)).filter((t) => /could not be read/.test(t)), "the history said it could not be read").toEqual([]);
  await p.close();
});

/// FOUR RATE-LIMITED LOG READS IN A ROW ARE RIDDEN OUT IN THE SAME PASS: asked
/// again after 0.5, 1, 2 and 4 seconds, with the same window. Every error used
/// to halve the window, and three 429s in a row ended the pass at its floor.
test("four rate-limited log reads in a row are asked again after a pause, with the same window, and the history arrives in the same pass", async () => {
  test.setTimeout(120_000);
  const c = await ensureHistoryLaunch();
  const curve = await curveOfLaunch(c.token);
  if (await tradesOnChain(curve) === 0) await buyOnCurve(curve, 10n ** 8n);
  const trades = await tradesOnChain(curve);
  const p = await newPage(OWNER, {}, WATCH_NOTE);
  const chain = await asPublicEndpoint(p, 0, { busy: (n) => n <= 4 });
  await p.goto("/token/" + c.token + "?" + new URLSearchParams({ rpc: STATE.rpc, lens: APP.lens }).toString());
  await expect(p.locator("#tvTradeCount"), "the history did not arrive").toHaveText(String(trades), { timeout: 60_000 });
  expect(chain.seen.busy, "the reads were not refused four times, so this proves nothing").toBe(4);
  expect(chain.seen.asked.slice(0, 5).map(([a, b]) => a + "-" + b), "a rate-limited read was not asked again as it was")
    .toEqual(new Array(5).fill(chain.seen.asked[0][0] + "-" + chain.seen.asked[0][1]));
  expect((await notesSaid(p)).filter((t) => /could not be read/.test(t)), "four 429s ended the pass").toEqual([]);
  await p.close();
});

/// A FIFTH ENDS THE PASS, SAYS SO, AND THE NEXT PASS READS IT: the page's own
/// heartbeat asks again about 20 seconds later, rather than retrying for good.
test("five rate-limited log reads in a row end the pass with a note, and the next pass reads the history", async () => {
  test.setTimeout(120_000);
  const c = await ensureHistoryLaunch();
  const curve = await curveOfLaunch(c.token);
  if (await tradesOnChain(curve) === 0) await buyOnCurve(curve, 10n ** 8n);
  const trades = await tradesOnChain(curve);
  const p = await newPage(OWNER, {}, WATCH_NOTE);
  const chain = await asPublicEndpoint(p, 0, { busy: (n) => n <= 5 });
  await p.goto("/token/" + c.token + "?" + new URLSearchParams({ rpc: STATE.rpc, lens: APP.lens }).toString());
  await expect(p.locator("#tvHistNote")).toContainText("could not be read from this endpoint just now", { timeout: 30_000 });
  expect(chain.seen.asked.length, "the pass went on asking after the fifth refusal").toBe(5);
  await expect(p.locator("#tvTradeCount"), "the next pass did not read the history").toHaveText(String(trades), { timeout: 60_000 });
  await expect(p.locator("#tvHistNote")).not.toContainText("could not be read");
  await p.close();
});

/// A PASS THAT FAILS PART-WAY COUNTS NOTHING TWICE. The curve's trades used to
/// be counted as soon as they were read: when the token's transfers then could
/// not be read, the pass was made again from the same block and every trade -
/// and the creator's earnings with them - was counted a second time.
test("a history pass that fails after the curve's trades were read counts none of them twice on the next pass", async () => {
  test.setTimeout(120_000);
  const c = await ensureHistoryLaunch();
  const curve = await curveOfLaunch(c.token);
  if (await tradesOnChain(curve) === 0) await buyOnCurve(curve, 10n ** 8n);
  const trades = await tradesOnChain(curve);
  const p = await newPage(OWNER, {}, WATCH_NOTE);
  let refusedTransfers = 0;
  let servedTransfers = 0;
  const chain = await asPublicEndpoint(p, 0, { busy: (n, from, to, f) => {
    // THE TOKEN'S TRANSFERS, the last read of a pass: refused five times, once
    // the curve's trades of the same pass were already read.
    if (String(f.address).toLowerCase() !== c.token.toLowerCase()) return false;
    if (refusedTransfers >= 5) { servedTransfers += 1; return false; }
    refusedTransfers += 1;
    return true;
  } });
  await p.goto("/token/" + c.token + "?" + new URLSearchParams({ rpc: STATE.rpc, lens: APP.lens }).toString());
  // THE FAILED PASS SAYS SO (a moment only: the history drawn after it clears the line).
  await expect.poll(async () => (await notesSaid(p)).some((t) => /could not be read from this endpoint just now/.test(t)),
    { timeout: 30_000, message: "the pass did not fail on the transfers" }).toBe(true);
  expect(chain.seen.served.length, "the curve's trades were not read before the failure, so this proves nothing").toBeGreaterThan(0);
  // THE NEXT PASS - the page's heartbeat - reads the transfers, and ends.
  await expect.poll(() => servedTransfers, { timeout: 60_000, message: "the next pass never read the transfers" }).toBeGreaterThan(0);
  await p.waitForTimeout(3000);
  await expect(p.locator("#tvTradeCount"), "a trade read by the failed pass was counted again").toHaveText(String(trades));
  await p.close();
});
