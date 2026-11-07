// A PREFILLED LAUNCH LINK (web/prefill.js, app.js applyPrefill): what an AI
// agent, or anyone, hands a person to open the create form with a name, a
// symbol, a creator tax, who earns it and the paired asset chosen - and nothing
// else. The person checks every field and presses Create the launch, exactly
// as with a form they filled in by hand.
//
// IN PRODUCTION ONLY, so every test here serves a stand-in config.js naming
// this run's full-flow stack (demo-app.sh), as prod.spec.js does, and opens
// plain URLs in a fresh browser context: nothing saved, nothing named but what
// the link names. The wallet keeps every method it is asked (window.__asked),
// so "nothing was sent" is counted, not assumed.
//
// THE FILE LEAVES THE CHAIN AS IT FOUND IT: its launches are reverted at the end.
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

const STATE = JSON.parse(fs.readFileSync(path.join(__dirname, ".state.json"), "utf8"));
const WEB = path.join(__dirname, "..");
const STUB = fs.readFileSync(path.join(WEB, "wallet-stub.js"), "utf8");
const WETH = "0x4200000000000000000000000000000000000006";
const NVDAC = "0xb20000000000000000000078ee7ce2fe4908108c";
const DEAD = "0x000000000000000000000000000000000000dEaD";
/// The full-flow stack's deployer, which owns its sharing catalog (sharing.spec.js OWNER).
const CATALOG_OWNER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const WORDS = "Trading and launching aren't available in the United States.";
const REFUSED = WORDS + " Nothing was sent.";
const UNREAD = "This page couldn't check where you're visiting from, so nothing was sent. Try again in a moment.";
const UNPLACED = "This site couldn't tell which country you're visiting from, so nothing was sent.";
const FILLED = "Filled in from a link";
const CHECK = "Check every field before you create";
const HALF = "only half of where to look";
const NOT_OURS = "THIS IS NOT THE DEPLOYMENT THIS PRODUCT PUBLISHES";
const NOT_OFFERED = "This link names a factory this site does not offer, so nothing from it was filled in.";
const TWO_FACTORIES = "This link names more than one factory, so nothing from it was filled in.";
const HOLDERS_LINE = "This link chose Holders: if you keep that, your creator share is 0% for good and goes to whoever " +
  "holds the token. Choose You to keep it.";
const OTHER_ENDPOINT = "http://other-endpoint.test:8701";

test.describe.configure({ mode: "serial" });

let browserRef;
let fileSnap = null;
test.beforeAll(async ({ browser }) => { browserRef = browser; fileSnap = await rpc("evm_snapshot", []); });
test.afterAll(async () => {
  if (fileSnap !== null) expect(await rpc("evm_revert", [fileSnap]), "prefill.spec.js's snapshot was not reverted").toBe(true);
});

// ------------------------------------------------------------------ the chain
async function rpc(method, params) {
  const res = await fetch(STATE.rpc, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(method + ": " + JSON.stringify(j.error));
  return j.result;
}
global.window = global.window || global;
require("../keccak.js"); require("../abi.js");
const sel = (s) => window.CurbKeccak.keccak256("0x" + window.CurbAbi.utf8Hex(s)).slice(0, 10);
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
const addrOf = (raw) => ("0x" + String(raw).replace(/^0x/, "").slice(24, 64)).toLowerCase();
const ethCall = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);
const words = (hex) => String(hex).replace(/^0x/, "").match(/.{64}/g) || [];
/// An ABI string return, decoded.
const abiString = (hex) => {
  const h = String(hex).replace(/^0x/, "");
  const len = Number(BigInt("0x" + h.slice(64, 128)));
  return Buffer.from(h.slice(128, 128 + 2 * len), "hex").toString("utf8");
};

const registryOf = async (lens) => addrOf(await ethCall(lens, sel("registry()")));
let appFactories = null;
async function factoriesOfApp() {
  if (!appFactories) {
    const registry = await registryOf(STATE.app.lens);
    const n = Number(BigInt(await ethCall(registry, sel("launcherCount()"))));
    const out = [];
    for (let i = 0; i < n; i++) {
      const f = addrOf(await ethCall(registry, sel("launcherAt(uint256)") + word(i)));
      out.push({ factory: f, quote: addrOf(await ethCall(f, sel("quoteToken()"))) });
    }
    appFactories = out;
  }
  return appFactories;
}
/// The full-flow stack's factory for `quote` (the first, if there are several).
const factoryFor = async (quote) => (await factoriesOfApp()).find((x) => x.quote === quote.toLowerCase()).factory;
/// A FRESH ACCOUNT OF ITS OWN: no code, the node signing for it, plenty of ether.
async function freshAccount(label) {
  const a = "0x" + window.CurbKeccak.keccak256("0x" + window.CurbAbi.utf8Hex("curb prefill.spec " + label)).slice(-40);
  expect(await rpc("eth_getCode", [a, "latest"]), "the account has code on this chain").toBe("0x");
  await rpc("anvil_impersonateAccount", [a]);
  await rpc("anvil_setBalance", [a, "0x" + (100n * 10n ** 18n).toString(16)]);
  return a;
}

// ------------------------------------------------------------------ the stand-in
/// web/config.js as deploy day writes it, naming the full-flow stack, with `over` on top.
async function standIn(over = {}) {
  const site = {
    chainId: 8453, rpc: STATE.rpc, lens: STATE.app.lens, registry: await registryOf(STATE.app.lens),
    factories: (await factoriesOfApp()).map((x) => x.factory),
    explorer: "https://basescan.org", featured: [], banner: "", hiddenFactories: [], hiddenLaunches: [], ...over,
  };
  return "window.CURB_SITE = " + JSON.stringify(site) + ";";
}

/// A FRESH PAGE IN A FRESH CONTEXT: the stand-in config.js, the visitor's
/// country (none: placed nowhere), and the stub wallet, connected, keeping every
/// method it is asked. `decline` turns every send down in the wallet.
async function newPage({ account, country = "DE", decline = true, config = {}, before = null } = {}) {
  const ctx = await browserRef.newContext();
  const p = await ctx.newPage();
  p.on("pageerror", (e) => { p.__errors = (p.__errors || []).concat(e.message); });
  p.on("dialog", (d) => { p.__dialogs = (p.__dialogs || 0) + 1; d.dismiss().catch(() => {}); });
  const body = await standIn(config);
  await p.route(/\/config\.js(\?.*)?$/, (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body }));
  if (country) {
    await p.route(/\/region(\?.*)?$/, (route) =>
      route.continue({ headers: { ...route.request().headers(), "x-vercel-ip-country": country } }));
  }
  if (before) await before(p);
  await p.addInitScript({ content: [
    STUB, ";(function () {",
    "  var w = window.makeWallet(" + JSON.stringify(STATE.rpc) + ", " +
      JSON.stringify({ forward: true, chainId: "0x2105", account: account || "0x70997970c51812dc3a010c7d01b50e0d17dc79c8", connected: true }) + ");",
    "  window.__asked = [];",
    "  var inner = w.request.bind(w);",
    "  w.request = function (a) { window.__asked.push(a.method); return inner(a); };",
    decline ? "  w.cfg.sendError = Object.assign(new Error('User rejected the request.'), { code: 4001 });" : "",
    "  window.ethereum = w;",
    "})();",
  ].join("\n") });
  return p;
}
const close = (p) => p.context().close();
const sendsAsked = (p) => p.evaluate(() =>
  window.__asked.filter((m) => m === "eth_sendTransaction" || m === "wallet_sendCalls").length);
const idle = (p) => expect.poll(() => p.evaluate(() => window.CurbApp.state.busy), { timeout: 60_000 }).toBe(false);
/// The launch form, opened at `query`, with app.js's init past the link.
async function openForm(p, query) {
  await p.goto("/launchpad" + (query ? "?" + new URLSearchParams(query).toString() : ""));
  await p.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
}
/// The form has read the factory it is on.
async function factoryRead(p) {
  await expect.poll(() => p.evaluate(() => ((window.CurbApp.state.ctx || {}).quote || "").length > 0),
    { timeout: 30_000, message: "the form never read the factory" }).toBe(true);
}
const ctxOf = (p) => p.evaluate(() => {
  const s = window.CurbApp.state;
  return { factory: (s.chainCfg.factory || "").toLowerCase(), quote: ((s.ctx || {}).quote || "").toLowerCase(),
    quoteSym: (s.ctx || {}).quoteSym || "" };
});
const noteText = (p) => p.locator("#prefillNote").evaluate((e) => (e.hidden ? "" : e.textContent));
const values = (p, ids) => p.evaluate((ids) => Object.fromEntries(ids.map((id) => [id, document.getElementById(id).value])), ids);

// ================================================================== P1
test("P1: a prefilled link to a listed factory fills the name, the symbol, the tax and who earns it, says so, and is not called half a link", async () => {
  const WETHF = await factoryFor(WETH);
  for (const restate of [false, true]) {
    const p = await newPage();
    const link = { factory: WETHF, name: "Moon Cat", symbol: "MCAT", tax: "2.5", earn: "you" };
    // THE BUILT-IN PAIR RESTATED is the same link: siteQuery drops it.
    await openForm(p, restate ? { rpc: STATE.rpc, lens: STATE.app.lens, ...link } : link);
    await expect(p.locator("#nName")).toHaveValue("Moon Cat");
    await expect(p.locator("#nSymbol")).toHaveValue("MCAT");
    await expect(p.locator("#nTax")).toHaveValue("2.5");
    await expect(p.locator("#earnYouPick")).toBeChecked();
    await expect(p.locator("#sumName")).toHaveText("Moon Cat");
    await expect(p.locator("#sumTicker")).toHaveText("$MCAT");
    await expect(p.locator("#sumFee")).toHaveText("2.50%");
    await expect(p.locator("#prefillNote")).toBeVisible();
    await expect(p.locator("#prefillNote")).toContainText(FILLED + ": the paired asset, the name, the symbol, the creator tax and who earns it.");
    await expect(p.locator("#prefillNote")).toContainText(CHECK);
    await factoryRead(p);
    const c = await ctxOf(p);
    expect(c.factory).toBe(WETHF);
    expect(c.quote).toBe(WETH);
    // NOT HALF A LINK, AND NOT SOMEBODY ELSE'S: no warning, no endpoint line.
    await p.waitForTimeout(500);
    await expect(p.locator("#linkWarn")).toBeHidden();
    await expect(p.locator("#cbEndpoint")).toBeHidden();
    // THE MONEY FIELDS UNTOUCHED.
    await expect(p.locator("#nCreator")).toHaveValue("");
    await expect(p.locator("#nDevBuy")).toHaveValue("");
    expect(p.__errors || []).toEqual([]);
    await close(p);
  }
});

// ================================================================== P2
test("P2: a prefilled link to a stock factory starts the form on that stock, not on ETH", async () => {
  const STOCKF = await factoryFor(NVDAC);
  const p = await newPage();
  await openForm(p, { factory: STOCKF, name: "Stock Cat", symbol: "SCAT" });
  await factoryRead(p);
  // AFTER THE PICKER HAS DRAWN, which is when the ETH default would move it.
  await expect.poll(() => p.locator("#quotePick option").evaluateAll((os) => os.filter((o) => o.value).length),
    { timeout: 30_000 }).toBeGreaterThan(1);
  await p.waitForTimeout(1000);
  const c = await ctxOf(p);
  expect(c.factory).toBe(STOCKF);
  expect(c.quote).toBe(NVDAC);
  await expect(p.locator("#sumPaired")).toHaveText(c.quoteSym);
  expect(c.quoteSym).toMatch(/NVDA/);
  await expect(p.locator("#nName")).toHaveValue("Stock Cat");
  await expect(p.locator("#linkWarn")).toBeHidden();
  await close(p);
});

// ================================================================== P3
test("P3: fields a link can never set are never filled, and the page warns that the link tried", async () => {
  const WETHF = await factoryFor(WETH);
  const p = await newPage();
  const plain = await newPage();
  await openForm(plain, null);
  const defaults = await values(plain, ["slippage", "poolSlippage"]);
  await close(plain);
  const q = new URLSearchParams({ factory: WETHF, name: "Moon Cat", symbol: "MCAT" });
  for (const [k, v] of [["creatorWallet", DEAD], ["creator_wallet", DEAD], ["nCreator", DEAD], ["Creator-Wallet", DEAD],
    ["devBuy", "1"], ["DEV_BUY", "1"], ["devPct", "20"], ["slippage", "50"], ["poolSlippage", "50"], ["recipient", DEAD],
    ["desc", "Qzxdescription"], ["site", "https://evil.example"], ["x", "https://x.com/evilqzx"], ["tg", "https://t.me/evilqzx"],
    ["image", "https://evil.example/qzx.png"]]) q.append(k, v);
  await p.goto("/launchpad?" + q.toString());
  await p.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
  await expect(p.locator("#nName")).toHaveValue("Moon Cat");
  await expect(p.locator("#nSymbol")).toHaveValue("MCAT");
  await factoryRead(p);
  for (const id of ["nCreator", "nDevBuy", "nDevPct", "nDesc", "nSite", "nX", "nTg"]) {
    await expect(p.locator("#" + id), "#" + id + " was filled from the link").toHaveValue("");
  }
  await expect(p.locator("#nDevSlider")).toHaveValue("0");
  expect(await values(p, ["slippage", "poolSlippage"])).toEqual(defaults);
  await expect(p.locator("#sumDevBuy")).toHaveText("None");
  const note = await noteText(p);
  expect(note).toContain("This link also tried to set the creator wallet, the dev buy and slippage. A link can never set " +
    "those, so they were ignored. Be careful with whoever sent it.");
  expect(note).toContain("A link does not fill the description, the links or the image.");
  // NO VALUE OF THE LINK'S IS ON THE PAGE.
  const text = await p.evaluate(() => document.body.innerText + " " +
    [...document.querySelectorAll("input, textarea")].map((e) => e.value).join(" "));
  for (const v of [DEAD, DEAD.toLowerCase(), "Qzxdescription", "evil.example", "evilqzx"]) expect(text, v).not.toContain(v);
  await close(p);
});

// ================================================================== P4
test("P4: invalid values are refused one by one, never half used, and the form says which", async () => {
  const WETHF = await factoryFor(WETH);
  const loads = [
    // ALL INVALID (twice: one name can be in a link at a time).
    [{ factory: WETHF, name: "x".repeat(33), symbol: "M CAT", tax: "6", earn: "Holders" }, ["name", "symbol", "tax", "earn"]],
    [{ factory: WETHF, name: "<img src=x onerror=alert(1)>", symbol: "$CAT", tax: "1.555", earn: "Owner" }, ["name", "symbol", "tax", "earn"]],
  ];
  for (const [link, bad] of loads) {
    const p = await newPage();
    await openForm(p, link);
    await factoryRead(p);
    // PRODUCTION'S BLANK FORM, AS IF THERE WAS NO LINK.
    await expect(p.locator("#nName")).toHaveValue("");
    await expect(p.locator("#nSymbol")).toHaveValue("");
    await expect(p.locator("#nTax")).toHaveValue("1");
    await expect(p.locator("#earnYouPick")).toBeChecked();
    const note = await noteText(p);
    expect(note).toContain(FILLED + ": the paired asset.");
    expect(note).toContain("The link's name was not used: it must be 1 to 32 letters, digits, spaces or");
    expect(note).toContain("The link's symbol was not used: it must be 1 to 10 letters or digits.");
    expect(note).toContain("The link's creator tax was not used: it must be a percent from 1 to 5, with at most 2 decimals.");
    expect(note).toContain("The link's choice of who earns the tax was not used: it must be you or holders.");
    expect(note.split("\n")).toHaveLength(1 + bad.length);
    // PLAIN TEXT: no element, no script, no dialog.
    expect(await p.locator("#prefillNote").evaluate((e) => e.childElementCount)).toBe(0);
    expect(await p.locator("img[src=x]").count()).toBe(0);
    expect(p.__dialogs || 0).toBe(0);
    for (const v of ["x".repeat(33), "onerror", "M CAT", "Holders", "Owner", "1.555"]) expect(note).not.toContain(v);
    await close(p);
  }
  // MIXED: the valid name is filled, the invalid tax is not.
  const p = await newPage();
  await openForm(p, { factory: WETHF, name: "Half Good", tax: "9" });
  await expect(p.locator("#nName")).toHaveValue("Half Good");
  await expect(p.locator("#nTax")).toHaveValue("1");
  expect(await noteText(p)).toContain("The link's creator tax was not used");
  await close(p);
  // GIVEN TWICE: not used.
  const d = await newPage();
  await d.goto("/launchpad?factory=" + WETHF + "&name=First&name=Second&symbol=AB");
  await d.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
  await expect(d.locator("#nName")).toHaveValue("");
  await expect(d.locator("#nSymbol")).toHaveValue("AB");
  expect(await noteText(d)).toContain("The link gave the name more than once, so it was not used.");
  await close(d);
});

// ================================================================== P5
test("P5: a prefilled create from outside the United States reaches the wallet once and makes exactly the launch a hand-filled form makes", async () => {
  test.setTimeout(240_000);
  const WETHF = await factoryFor(WETH);
  const who = await freshAccount("prefilled create");
  const registry = await registryOf(STATE.app.lens);
  /// One create, pressed on `p`: the methods asked from the press on, and the send.
  const press = async (p) => {
    await p.evaluate(() => window.CurbApp.connect());
    await factoryRead(p);
    await expect.poll(() => p.evaluate(() => window.CurbApp.state.ctx.platformKnown), { timeout: 30_000 }).toBe(true);
    const from = await p.evaluate(() => window.__asked.length);
    await p.click("#create");
    await expect(p.locator("#msg")).toContainText("Launched", { timeout: 90_000 });
    await idle(p);
    const r = await p.evaluate((from) => ({ asked: window.__asked.slice(from), sent: window.ethereum.sent.slice(),
      token: window.CurbApp.state.chainCfg.token }), from);
    expect(r.asked.filter((m) => m === "eth_sendTransaction" || m === "wallet_sendCalls"), "the wallet was not asked exactly once").toHaveLength(1);
    expect(r.sent).toHaveLength(1);
    return r;
  };

  // 1. THE LINK, with a creator wallet and a dev buy it can never set.
  const a = await newPage({ account: who, decline: false });
  await openForm(a, { factory: WETHF, name: "Link Fill", symbol: "LFIL", tax: "2.5", earn: "you", creatorWallet: DEAD, devBuy: "1" });
  await expect(a.locator("#nName")).toHaveValue("Link Fill");
  const viaLink = await press(a);
  await close(a);

  // 2. ON CHAIN: what the link named, and nothing it could not.
  const token = viaLink.token;
  expect(abiString(await ethCall(token, sel("name()")))).toBe("Link Fill");
  expect(abiString(await ethCall(token, sel("symbol()")))).toBe("LFIL");
  const rec = words(await ethCall(registry, sel("launchOf(address)") + word(BigInt(token))));
  expect(addrOf(rec[2]), "the beneficiary is not the connected account").toBe(who.toLowerCase());
  expect(BigInt("0x" + rec[8]), "the tax is not the link's").toBe(250n);
  const st = words(await ethCall(STATE.app.lens, sel("launchState(address)") + word(BigInt(token))));
  expect(BigInt("0x" + st[15]), "holder sharing is on").toBe(0n);
  expect(BigInt(await ethCall(token, sel("balanceOf(address)") + word(BigInt(who)))), "a dev buy was made").toBe(0n);

  // 3. THE SAME FIELDS TYPED BY HAND on a plain form, by the same account.
  const b = await newPage({ account: who, decline: false });
  await openForm(b, null);
  await factoryRead(b);
  await expect.poll(async () => (await ctxOf(b)).factory, { timeout: 30_000 }).toBe(WETHF);
  await b.fill("#nName", "Link Fill");
  await b.fill("#nSymbol", "LFIL");
  await b.fill("#nTax", "2.5");
  await b.check("#earnYouPick");
  const byHand = await press(b);
  await close(b);
  expect(byHand.asked, "the wallet was asked other things in another order").toEqual(viaLink.asked);
  const [x, y] = [viaLink.sent[0], byHand.sent[0]];
  expect(y.to.toLowerCase()).toBe(x.to.toLowerCase());
  expect(BigInt(y.value || 0)).toBe(BigInt(x.value || 0));
  const wx = x.data.slice(10).match(/.{1,64}/g), wy = y.data.slice(10).match(/.{1,64}/g);
  expect(x.data.slice(0, 10)).toBe(y.data.slice(0, 10));
  expect(wy.length).toBe(wx.length);
  expect(wy[4], "the salt is the same in both").not.toBe(wx[4]);
  for (let i = 0; i < wx.length; i++) if (i !== 4) expect(wy[i], "word " + i + " differs").toBe(wx[i]);

  // 4. A TOKEN LINK CARRIES NOTHING INTO THE TRADE CARD.
  const c = await newPage({ account: who });
  await c.goto("/token/" + token + "?amount=1&side=buy&slippage=50");
  await expect(c.locator("#tokenView")).toBeVisible({ timeout: 15_000 });
  await expect(c.locator("#tvStatus")).not.toHaveText("—", { timeout: 30_000 });
  await expect(c.locator("#tvPay")).toHaveValue("");
  await expect(c.locator("#tvSlip")).toHaveValue("1");
  await expect(c.locator("#prefillNote")).toBeHidden();
  await close(c);
});

// ================================================================== P6
test("P6: from the United States a prefilled link still cannot launch: the form is filled, the button is held, a forced press is refused, and nothing is sent", async () => {
  const WETHF = await factoryFor(WETH);
  const p = await newPage({ country: "US" });
  await openForm(p, { factory: WETHF, name: "Moon Cat", symbol: "MCAT", tax: "2", earn: "you" });
  await expect(p.locator("#nName")).toHaveValue("Moon Cat");
  await expect(p.locator("#prefillNote")).toContainText(FILLED);
  await p.evaluate(() => window.CurbApp.connect());
  await factoryRead(p);
  await expect(p.locator("#cbRegion")).toBeVisible();
  await expect(p.locator("#cbRegion")).toHaveText(WORDS);
  await expect(p.locator("#create-launch .launchHead + p.regionNote")).toHaveText(WORDS);
  await expect(p.locator("#create + p.regionNote")).toHaveText(WORDS);
  await expect(p.locator("#create")).toBeDisabled();
  // A REFRESH GIVES EVERY BUTTON BACK - but not this one (production hides #refresh).
  await p.evaluate(() => document.getElementById("refresh").click());
  await idle(p);
  await expect(p.locator("#create")).toBeDisabled();
  await p.evaluate(() => { const b = document.getElementById("create"); b.disabled = false; b.click(); });
  await expect(p.locator("#msg")).toContainText(REFUSED, { timeout: 30_000 });
  await idle(p);
  expect(await sendsAsked(p), "a prefilled create was sent from the United States").toBe(0);
  await close(p);
});

// ================================================================== P7
test("P7: on the site's own host, a visitor placed nowhere, or whose answer cannot be read, gets a filled form that sends nothing", async () => {
  const WETHF = await factoryFor(WETH);
  const config = { regionHosts: ["127.0.0.1"] };
  for (const [what, opts, said] of [
    ["placed nowhere", { country: null }, UNPLACED],
    ["unread", { country: null, before: (p) => p.route(/\/region(\?.*)?$/, (r) => r.abort()) }, UNREAD],
  ]) {
    const p = await newPage({ ...opts, config });
    await openForm(p, { factory: WETHF, name: "Moon Cat", symbol: "MCAT" });
    await expect(p.locator("#nName"), what).toHaveValue("Moon Cat");
    await p.evaluate(() => window.CurbApp.connect());
    await factoryRead(p);
    await p.evaluate(() => { const b = document.getElementById("create"); b.disabled = false; b.click(); });
    await expect(p.locator("#msg"), what).toContainText(said, { timeout: 30_000 });
    await idle(p);
    expect(await sendsAsked(p), what + ": a send was asked").toBe(0);
    await close(p);
  }
});

// ================================================================== P8
test("P8: the half-link fix is for listed factories only: an unlisted factory link still warns, fills nothing and sends nothing", async () => {
  const STOCKF = await factoryFor(NVDAC);
  const listed = (await factoriesOfApp()).map((x) => x.factory).filter((f) => f !== STOCKF);
  const p = await newPage({ config: { factories: listed } });
  await openForm(p, { factory: STOCKF, name: "Unlisted", symbol: "UNL" });
  await expect(p.locator("#linkWarn")).toContainText(HALF, { timeout: 20_000 });
  await expect(p.locator("#linkWarn")).toContainText(NOT_OURS, { timeout: 20_000 });
  await expect(p.locator("#nName")).toHaveValue("");
  expect(await noteText(p)).toContain(NOT_OFFERED);
  // TYPED BY HAND, AND PRESSED: refused, as before.
  await p.evaluate(() => window.CurbApp.connect());
  await factoryRead(p);
  await p.fill("#nName", "Unlisted");
  await p.fill("#nSymbol", "UNL");
  await p.click("#create");
  await expect(p.locator("#msg")).toContainText("is not one this site publishes", { timeout: 30_000 });
  await idle(p);
  expect(await sendsAsked(p)).toBe(0);
  await close(p);
});

// ================================================================== P9
test("P9: a hidden factory link is not a launch choice: it still warns and fills nothing", async () => {
  const STOCKF = await factoryFor(NVDAC);
  const p = await newPage({ config: { hiddenFactories: [STOCKF] } });
  await openForm(p, { factory: STOCKF, name: "Hidden", symbol: "HID" });
  await expect(p.locator("#linkWarn")).toContainText(HALF, { timeout: 20_000 });
  await expect(p.locator("#nName")).toHaveValue("");
  await expect(p.locator("#nSymbol")).toHaveValue("");
  expect(await noteText(p)).toContain(NOT_OFFERED);
  await close(p);
});

// ================================================================== P10
test("P10: a link that also names an endpoint, a lens or a launch fills nothing", async () => {
  const WETHF = await factoryFor(WETH);
  // ANOTHER ENDPOINT: the run's node under another name, so the page reads.
  const p = await newPage({ before: (pg) => routeEndpoint(pg, OTHER_ENDPOINT) });
  await openForm(p, { rpc: OTHER_ENDPOINT, lens: STATE.app.lens, factory: WETHF, name: "Moon Cat", symbol: "MCAT" });
  await expect(p.locator("#nName")).toHaveValue("");
  expect(await noteText(p)).toContain("This link names where to read the chain, so nothing from it was filled in.");
  await expect(p.locator("#cbEndpoint")).toContainText("other-endpoint.test:8701");
  await close(p);
  // A LAUNCH NAMED IN THE LINK: whichever it is, the link fills nothing.
  const q = await newPage();
  await openForm(q, { token: STATE.token, name: "Moon Cat", symbol: "MCAT" });
  await expect(q.locator("#nName")).toHaveValue("");
  expect(await noteText(q)).toContain("This link names a launch, so nothing from it was filled in.");
  await close(q);
});
/// AN ENDPOINT OF ITS OWN NAME FOR THE RUN'S NODE, served through Playwright.
async function routeEndpoint(page, url) {
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST, OPTIONS" };
  await page.route(new RegExp("^" + url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(/.*)?$"), async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const res = await fetch(STATE.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: req.postData() });
    return route.fulfill({ status: res.status, headers: cors, contentType: "application/json", body: await res.text() });
  });
}

// ================================================================== P11
test("P11: with another pair saved in this browser, the same factory link is still half a link and fills nothing", async () => {
  const WETHF = await factoryFor(WETH);
  const p = await newPage({ before: (pg) => routeEndpoint(pg, OTHER_ENDPOINT) });
  await p.goto("/terms.html");
  await p.evaluate(([rpc, lens]) => localStorage.setItem("curb.app.v1", JSON.stringify({ rpc, lens })), [OTHER_ENDPOINT, STATE.app.lens]);
  await openForm(p, { factory: WETHF, name: "Moon Cat", symbol: "MCAT" });
  await expect(p.locator("#linkWarn")).toContainText(HALF, { timeout: 20_000 });
  await expect(p.locator("#nName")).toHaveValue("");
  expect(await noteText(p)).toContain("This page reads another endpoint or lens saved in this browser, so nothing from the link was filled in.");
  await close(p);
});

// ================================================================== P12
test("P12: without prefill.js the page fills nothing, and a factory link warns as before", async () => {
  const WETHF = await factoryFor(WETH);
  const p = await newPage({ before: (pg) => pg.route(/\/prefill\.js(\?.*)?$/, (r) => r.fulfill({ status: 404, body: "missing" })) });
  await openForm(p, { factory: WETHF, name: "Moon Cat", symbol: "MCAT" });
  await expect(p.locator("#linkWarn")).toContainText(HALF, { timeout: 20_000 });
  await expect(p.locator("#nName")).toHaveValue("");
  await expect(p.locator("#prefillNote")).toBeHidden();
  expect(await p.evaluate(() => window.CurbApp.prefill())).toBe(null);
  await close(p);
});

// ================================================================== P13
/// The share card, as the page draws it.
const shareCard = (p) => p.evaluate(() => ({
  holders: document.getElementById("nShare").checked, you: document.getElementById("earnYouPick").checked,
  disabled: document.getElementById("nShare").disabled, terms: !document.getElementById("shareTerms").hidden,
  unavailable: document.getElementById("shareUnavailable").hidden ? "" : document.getElementById("shareUnavailable").textContent,
}));
test("P13: earn=holders, still a choice a link may make, picks Holders: the five statements show and the note says what Holders gives away; with no version approved it goes back to You and says why", async () => {
  test.setTimeout(120_000);
  const WETHF = await factoryFor(WETH);
  const link = { factory: WETHF, name: "Share Cat", symbol: "SHCT", tax: "2", earn: "holders" };
  // 1. THE CATALOG APPROVES A VERSION (the full-flow stack's): Holders stays chosen.
  expect(/^0x0{40}$/.test(addrOf(await ethCall(STATE.app.catalog, sel("recommended()")))),
    "the stack's catalog recommends no version, so this proves nothing").toBe(false);
  const p = await newPage();
  await openForm(p, link);
  await expect(p.locator("#nName")).toHaveValue("Share Cat");
  await factoryRead(p);
  await expect.poll(() => p.evaluate(() => !!(window.CurbApp.state.ctx.sharing || {}).known), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => shareCard(p), { timeout: 30_000 }).toEqual({ holders: true, you: false, disabled: false, terms: true, unavailable: "" });
  await expect(p.locator("#sumYours")).toContainText("to holders");
  const note = await noteText(p);
  expect(note).toContain(FILLED + ": the paired asset, the name, the symbol, the creator tax and who earns it.");
  expect(note.split("\n")[1], "the Holders line is not right under what was filled").toBe(HOLDERS_LINE);
  await close(p);
  // AND earn=you DOES NOT SAY IT.
  const y = await newPage();
  await openForm(y, { ...link, earn: "you" });
  await expect(y.locator("#earnYouPick")).toBeChecked();
  expect(await noteText(y)).not.toContain("This link chose Holders");
  await close(y);

  // 2. THE CATALOG APPROVES NONE (its owner retired the version, in a snapshot
  // of its own): the link's Holders goes back to You, and the card says why.
  const recommended = addrOf(await ethCall(STATE.app.catalog, sel("recommended()")));
  const snap = await rpc("evm_snapshot", []);
  try {
    const hash = await rpc("eth_sendTransaction", [{ from: CATALOG_OWNER, to: STATE.app.catalog,
      data: sel("retire(address)") + word(BigInt(recommended)) }]);
    await expect.poll(async () => ((await rpc("eth_getTransactionReceipt", [hash])) || {}).status, { timeout: 20_000 }).toBe("0x1");
    expect(BigInt(await ethCall(STATE.app.catalog, sel("isApproved(address)") + word(BigInt(recommended)))),
      "the version is still approved, so this proves nothing").toBe(0n);
    const q = await newPage();
    await openForm(q, link);
    await expect(q.locator("#nName")).toHaveValue("Share Cat");
    await factoryRead(q);
    await expect.poll(() => shareCard(q), { timeout: 30_000 }).toEqual({
      holders: false, you: true, disabled: true, terms: false,
      unavailable: "Holder sharing is not available yet: no distributor version is approved.",
    });
    await expect(q.locator("#sumYours")).not.toContainText("to holders");
    await close(q);
  } finally {
    expect(await rpc("evm_revert", [snap]), "P13's snapshot was not reverted").toBe(true);
  }
});

// ================================================================== P14
test("P14: a factory written other than as the page reads it, or named twice, is half a link and fills nothing - the note and the warning agree", async () => {
  const WETHF = await factoryFor(WETH);
  const STOCKF = await factoryFor(NVDAC);
  for (const [what, query, said] of [
    ["an upper-case 0X", "factory=0X" + WETHF.slice(2).toUpperCase() + "&name=Moon&symbol=MOON", NOT_OFFERED],
    ["spaces around it", "factory=%20" + WETHF + "%20&name=Moon&symbol=MOON", NOT_OFFERED],
    ["two listed factories", "factory=" + WETHF + "&factory=" + STOCKF + "&name=Moon&symbol=MOON", TWO_FACTORIES],
  ]) {
    const p = await newPage();
    await p.goto("/launchpad?" + query);
    await p.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
    await expect(p.locator("#linkWarn"), what).toContainText(HALF, { timeout: 20_000 });
    await expect(p.locator("#nName"), what).toHaveValue("");
    await expect(p.locator("#nSymbol"), what).toHaveValue("");
    const note = await noteText(p);
    expect(note, what).toContain(said);
    expect(note, what).not.toContain(FILLED);
    await close(p);
  }
});
