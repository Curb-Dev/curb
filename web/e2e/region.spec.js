// TRADING AND LAUNCHING ARE NOT OFFERED TO VISITORS IN THE UNITED STATES.
//
// web/region.js asks /region, which the host answers by the visitor's country
// (vercel.json, _redirects; serve.js here, from the request's
// x-vercel-ip-country, which each test sets on that one request as Vercel
// would). Every action the gate holds is pressed here as a visitor in the
// United States and nothing may reach the wallet; the same press from
// elsewhere must reach it, or the first half proves nothing.
//
// THE WALLET DECLINES EVERY SEND in these tests (EIP-1193 4001) and keeps every
// method it was asked, so a gate that lets one through is seen - and changes
// nothing on the shared fork, the waiting launch included. Only the launches
// made here, and the buys that set them up, are real.
//
// A PRESS THE PAGE DOES NOT OFFER is made by enabling the held buttons and
// clicking in one tick, before the hold disables them again: what a visitor
// editing the page could do. What is tested is then the action's own refusal.
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const { REGION_US, testConfig } = require("./serve.js");

const STATE = JSON.parse(fs.readFileSync(path.join(__dirname, ".state.json"), "utf8"));
const WEB = path.join(__dirname, "..");
const STUB = fs.readFileSync(path.join(WEB, "wallet-stub.js"), "utf8");
const APP = STATE.app;
const OWNER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const WETH = "0x4200000000000000000000000000000000000006";
const WORDS = "Trading and launching aren't available in the United States.";
const REFUSED = WORDS + " Nothing was sent.";
const UNREAD = "This page couldn't check where you're visiting from, so nothing was sent. Try again in a moment.";
const US = ["US", "PR", "GU", "VI", "AS", "MP", "UM"];

test.describe.configure({ mode: "serial" });

let browserRef;
// THE FILE LEAVES THE CHAIN AS IT FOUND IT (as aero.spec.js does): its
// launches and the buys behind them are reverted once it is done.
let fileSnap = null;
test.beforeAll(async ({ browser }) => { browserRef = browser; fileSnap = await rpc("evm_snapshot", []); });
test.afterAll(async () => {
  if (fileSnap !== null) expect(await rpc("evm_revert", [fileSnap]), "region.spec.js's snapshot was not reverted").toBe(true);
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
const addrOf = (raw) => "0x" + String(raw).replace(/^0x/, "").slice(24, 64);
const ethCall = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);
async function mined(tx, what) {
  const hash = await rpc("eth_sendTransaction", [tx]);
  let rc = null;
  for (let i = 0; i < 200 && !rc; i++) {
    rc = await rpc("eth_getTransactionReceipt", [hash]);
    if (!rc) await new Promise((r) => setTimeout(r, 100));
  }
  expect(rc && rc.status, what + " did not go through").toBe("0x1");
  return rc;
}
/// The factory of `quote`, from the registry the full-flow lens names.
async function factoryFor(quote) {
  const registry = addrOf(await ethCall(APP.lens, sel("registry()")));
  const n = Number(BigInt(await ethCall(registry, sel("launcherCount()"))));
  for (let i = 0; i < n; i++) {
    const f = addrOf(await ethCall(registry, sel("launcherAt(uint256)") + word(i)));
    if (addrOf(await ethCall(f, sel("quoteToken()"))) === quote.toLowerCase()) return f;
  }
  throw new Error("no factory for " + quote);
}

// ------------------------------------------------------------------ the pages
/// THE VISITOR'S COUNTRY, on the one request that asks it - as Vercel adds
/// x-vercel-ip-country - so the test server's own rule decides the answer.
async function fromCountry(p, code) {
  await p.route(/\/region(\?.*)?$/, (route) =>
    route.continue({ headers: { ...route.request().headers(), "x-vercel-ip-country": code } }));
}
/// A page with the stub wallet, connected, that keeps every method it is asked
/// in window.__asked. `decline` turns every send down in the wallet; `country`
/// is the visitor's, none for a visitor the host places nowhere.
async function newPage(account, { country = null, decline = true, before = null } = {}) {
  const p = await browserRef.newPage();
  p.on("pageerror", (e) => console.log("PAGE ERROR: " + (e.stack || e.message)));
  if (country) await fromCountry(p, country);
  if (before) await before(p);
  await p.addInitScript({ content: [
    STUB, ";(function () {",
    "  var w = window.makeWallet(" + JSON.stringify(STATE.rpc) + ", " +
      JSON.stringify({ forward: true, chainId: "0x2105", account, connected: true }) + ");",
    "  window.__asked = [];",
    "  var inner = w.request.bind(w);",
    "  w.request = function (a) { window.__asked.push(a.method); return inner(a); };",
    decline ? "  w.cfg.sendError = Object.assign(new Error('User rejected the request.'), { code: 4001 });" : "",
    "  window.ethereum = w;",
    "})();",
  ].join("\n") });
  return p;
}
/// How many sends the wallet was asked for: a transaction, or a smart wallet's calls.
const sendsAsked = (p) => p.evaluate(() =>
  window.__asked.filter((m) => m === "eth_sendTransaction" || m === "wallet_sendCalls").length);
const regionState = (p) => p.evaluate(() => (!window.CurbRegion ? "none"
  : window.CurbRegion.closed() ? "closed" : "other"));
/// app.js done with the last action, its buttons given back.
const idle = (p) => expect.poll(() => p.evaluate(() => window.CurbApp.state.busy), { timeout: 60_000 }).toBe(false);

async function openForm(p, factory) {
  await p.goto("/app.html?" + new URLSearchParams({ rpc: STATE.rpc, factory, lens: APP.lens }).toString());
  await p.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
  await p.evaluate(() => window.CurbApp.connect());
  await expect.poll(() => p.evaluate(() => (window.CurbApp.state.ctx && window.CurbApp.state.ctx.quote || "").length > 0),
    { timeout: 30_000, message: "the form never read the factory" }).toBe(true);
}
async function openToken(p, token, lens = APP.lens) {
  await p.goto("/token/" + token + "?" + new URLSearchParams({ rpc: STATE.rpc, lens }).toString());
  await expect(p.locator("#tokenView")).toBeVisible({ timeout: 15_000 });
  await expect(p.locator("#tvStatus")).not.toHaveText("—", { timeout: 30_000 });
  await p.evaluate(() => window.CurbApp.connect());
  await expect.poll(() => p.evaluate(() => ((window.CurbApp.state.viewFor || {}).token || "").toLowerCase()),
    { timeout: 30_000 }).toBe(token.toLowerCase());
}
/// A launch made through the form by a visitor the host places nowhere, sent for real.
async function createOn(factory, name, symbol) {
  const p = await newPage(OWNER, { decline: false });
  await openForm(p, factory);
  await p.fill("#nName", name);
  await p.fill("#nSymbol", symbol);
  await p.click("#create");
  await expect(p.locator("#msg")).toContainText("Launched", { timeout: 60_000 });
  const token = await p.evaluate(() => window.CurbApp.state.chainCfg.token);
  await p.close();
  return token;
}
/// THE CARD ON `side`, flipped if it is on the other one, paying `amount`, its
/// quote drawn as the press will compare it.
async function quoted(p, side, amount) {
  const sym = (await p.locator("#tvSym").textContent()).trim().replace(/^\$/, "");
  const tokenPays = (await p.locator("#tvPayAsset").textContent()).trim() === sym;
  if ((side === "sell") !== tokenPays) await p.click("#tvFlip");
  if (/%$/.test(amount)) {
    await expect.poll(async () => Number(((await p.locator("#tvPayAvail").textContent()) || "").replace(/[^0-9.]/g, "") || 0),
      { timeout: 30_000, message: "the card never read what there is to pay with" }).toBeGreaterThan(0);
    await p.click(`#tvPcts [data-pct="${parseInt(amount, 10)}"]`);
  } else await p.fill("#tvPay", amount);
  await expect(p.locator("#tvGet")).not.toHaveText("0", { timeout: 30_000 });
  // ON THE CURVE, THE QUOTE THE PRESS COMPARES (app.js noteDrawn) is this amount's.
  if ((await p.locator("#tvStatus").textContent()).trim() === "Selling") {
    const typed = (await p.locator("#tvPay").inputValue()).trim().toLowerCase();
    await expect.poll(() => p.evaluate((a) => { const d = window.CurbApp.drawn; return !!d && d.key.split("|")[1] === a; }, typed),
      { timeout: 30_000, message: "the quote for " + typed + " was never drawn" }).toBe(true);
  }
  await expect(p.locator("#tvAct")).toHaveText(new RegExp("^" + (side === "buy" ? "Buy" : "Sell") + " \\$"), { timeout: 20_000 });
}
/// THE CARD'S BUTTON, PRESSED AS A PAGE THAT OFFERS IT WOULD: enabled, and the
/// one on the long page it presses too, in the same tick (see the top).
const forceCard = (p) => p.evaluate(() => {
  const b = document.getElementById("tvAct");
  b.dataset.act = /^Complete/.test(b.textContent) ? "complete" : "trade";
  for (const id of ["tvAct", "curveAct", "poolAct", "complete"]) document.getElementById(id).disabled = false;
  document.getElementById("msg").textContent = "";
  b.click();
});
/// The card held for a visitor in the United States: its button disabled, the reason beside it.
async function cardHeld(p) {
  await expect(p.locator("#tvActNote")).toHaveText(WORDS, { timeout: 20_000 });
  await expect(p.locator("#tvAct")).toBeDisabled();
}
/// A press of the held card refused in the gate's words, with nothing asked of the wallet.
async function refusedOnCard(p) {
  await forceCard(p);
  await expect(p.locator("#msg")).toContainText(REFUSED, { timeout: 30_000 });
  await idle(p);
  expect(await sendsAsked(p), "the wallet was asked to send").toBe(0);
}

// ================================================================== the hosts
test("the hosts answer /region by the visitor's country, never cached, and vercel.json, _redirects and the test server agree", async ({ request }) => {
  // THE TEST SERVER, AS A HOST: every code the gate holds, and others, and none.
  for (const country of [null, ...US, "DE", "GB", "CA", "MX", "TR", "JP"]) {
    const res = await request.get("/region", country ? { headers: { "x-vercel-ip-country": country } } : {});
    expect(res.status(), "/region did not answer for " + country).toBe(200);
    expect(res.headers()["cache-control"], "/region may be cached").toContain("no-store");
    expect(await res.json(), "the answer for " + country).toEqual({ trading: !US.includes(country) });
  }
  const read = (f) => fs.readFileSync(path.join(WEB, f), "utf8");
  expect(JSON.parse(read("region.json"))).toEqual({ trading: true });
  expect(JSON.parse(read("region-us.json"))).toEqual({ trading: false });
  // NO FILE AT /region: Vercel serves a file before it applies a rewrite.
  expect(fs.existsSync(path.join(WEB, "region")), "a file at /region would be served to everyone").toBe(false);
  expect(REGION_US, "the test server holds other codes").toEqual(US);
  // THE HOSTS WHERE AN ANSWER IS EXPECTED, and so where none refuses: the site's own.
  const site = new Function("window", read("config.js") + "\nreturn window.CURB_SITE;")({});
  expect(site.regionHosts, "config.js does not name the site's own hosts").toEqual(["curbfun.xyz", "www.curbfun.xyz"]);

  // VERCEL: one rule for the codes, its exact opposite for everyone else.
  const vercel = JSON.parse(read("vercel.json"));
  const cond = { type: "header", key: "x-vercel-ip-country", value: { inc: US } };
  expect(vercel.rewrites.filter((r) => r.source === "/region")).toEqual([
    { source: "/region", has: [cond], destination: "/region-us.json" },
    { source: "/region", missing: [cond], destination: "/region.json" },
  ]);
  // NETLIFY: the codes first, the default after; the first match is served.
  const lines = read("_redirects").split(/\r?\n/).map((l) => l.trim().split(/\s+/).join(" "))
    .filter((l) => l && !l.startsWith("#"));
  expect(lines.filter((l) => l.startsWith("/region "))).toEqual([
    "/region /region-us.json 200 Country=" + US.map((c) => c.toLowerCase()).join(","),
    "/region /region.json 200",
  ]);
  // NO-STORE ON THE PATH ASKED AND ON THE TWO FILES, in both hosts' headers.
  const blocks = {};
  let at = null;
  for (const raw of read("_headers").split(/\r?\n/)) {
    if (/^\s*#/.test(raw) || !raw.trim()) continue;
    if (!/^\s/.test(raw)) { at = raw.trim(); blocks[at] = []; continue; }
    const c = raw.indexOf(":");
    blocks[at].push([raw.slice(0, c).trim(), raw.slice(c + 1).trim()]);
  }
  for (const p of ["/region", "/region.json", "/region-us.json"]) {
    expect(vercel.headers, "vercel.json lets " + p + " be cached")
      .toContainEqual({ source: p, headers: [{ key: "Cache-Control", value: "no-store" }] });
    expect(blocks[p], "_headers lets " + p + " be cached").toEqual([["Cache-Control", "no-store"]]);
  }

  // EVERY PAGE THAT SENDS WHAT THE GATE HOLDS LOADS IT, after config.js (its
  // regionHosts) and before its own script; tests.html, which runs launch.js, too.
  for (const [html, script] of [["app.html", "app.js"], ["launch.html", "launch.js"]]) {
    const src = read(html);
    const at = (name) => src.search(new RegExp('<script src="/?' + name.replace(".", "\\.") + '"></script>'));
    expect(at("region.js"), html + " does not load region.js").toBeGreaterThan(at("config.js"));
    expect(at("config.js"), html + " does not load config.js").toBeGreaterThan(-1);
    expect(at("region.js"), html + " loads region.js after " + script).toBeLessThan(at(script));
  }
  expect(read("tests.html")).toContain('<script src="region.js"></script>');
});

// ================================================================== launching
test("from the United States the launch form says so and a create sends nothing; from elsewhere the same press reaches the wallet", async () => {
  const factory = await factoryFor(WETH);
  for (const country of ["US", "PR", "DE"]) {
    const held = country !== "DE";
    const p = await newPage(OWNER, { country });
    await openForm(p, factory);
    await expect.poll(() => regionState(p)).toBe(held ? "closed" : "other");
    await p.fill("#nName", "Region " + country);
    await p.fill("#nSymbol", "RG" + country);
    if (held) {
      await expect(p.locator("#create + p.regionNote")).toHaveText(WORDS);
      await expect(p.locator("#create")).toBeDisabled();
      // AND IT STAYS SO, whatever enables it: the end of every action gives
      // every button back (app.js guard).
      await p.click("#refresh");
      await idle(p);
      await expect(p.locator("#create")).toBeDisabled();
      await p.evaluate(() => { const b = document.getElementById("create"); b.disabled = false; b.click(); });
      await expect(p.locator("#msg")).toContainText(REFUSED, { timeout: 30_000 });
      await idle(p);
      expect(await sendsAsked(p), "a create was sent from " + country).toBe(0);
    } else {
      await expect(p.locator(".regionNote")).toHaveCount(0);
      await expect(p.locator("#create")).toBeEnabled();
      await p.click("#create");
      await expect(p.locator("#msg")).toContainText("you declined", { timeout: 30_000 });
      expect(await sendsAsked(p), "a create from " + country + " never reached the wallet").toBe(1);
    }
    await p.close();
  }
});

// ================================================================== the curve, and claims
test("from the United States a curve buy and a curve sale send nothing, the card says why, and the creator can still claim; elsewhere each reaches the wallet", async () => {
  test.setTimeout(240_000);
  const token = await createOn(await factoryFor(WETH), "Region Curve", "RCV");
  // A REAL BUY FROM ELSEWHERE: tokens to sell, and fees for the creator to claim.
  const there = await newPage(OWNER, { decline: false });
  await openToken(there, token);
  await expect(there.locator("#tvActNote")).not.toHaveText(WORDS);
  await quoted(there, "buy", "0.01");
  await expect(there.locator("#tvAct")).toBeEnabled({ timeout: 20_000 });
  await there.click("#tvAct");
  await expect(there.locator("#msg")).toContainText("Done", { timeout: 90_000 });
  await there.close();

  const p = await newPage(OWNER, { country: "US" });
  await openToken(p, token);
  await expect(p.locator("#tvStatus")).toHaveText("Selling");
  await cardHeld(p);
  // (a) A BUY.
  await quoted(p, "buy", "0.01");
  await cardHeld(p);
  await refusedOnCard(p);
  // (b) A SALE.
  await quoted(p, "sell", "50%");
  await cardHeld(p);
  await refusedOnCard(p);
  // (c) THE CREATOR'S CLAIM IS NOT HELD: it reaches the wallet (and is declined there).
  await expect(p.locator("#tvClaimAct")).toBeEnabled({ timeout: 30_000 });
  await p.click("#tvClaimAct");
  await expect(p.locator("#msg")).toContainText("you declined", { timeout: 60_000 });
  await idle(p);
  expect(await sendsAsked(p), "the claim never reached the wallet").toBe(1);
  await p.close();

  // (d) THE SAME SALE FROM ELSEWHERE reaches the wallet.
  const q = await newPage(OWNER, { country: "DE" });
  await openToken(q, token);
  await quoted(q, "sell", "50%");
  await expect(q.locator("#tvAct")).toBeEnabled({ timeout: 20_000 });
  await q.click("#tvAct");
  await expect(q.locator("#msg")).toContainText("you declined", { timeout: 60_000 });
  expect(await sendsAsked(q), "a sale from elsewhere never reached the wallet").toBe(1);
  await q.close();
});

// ================================================================== the pool
test("from the United States a pool swap sends nothing; elsewhere it reaches the wallet", async () => {
  test.setTimeout(240_000);
  const factory = await factoryFor(WETH);
  const token = await createOn(factory, "Region Pool", "RPL");
  // FILLED AND MOVED INTO ITS POOL from the test's side.
  const s = await newPage(OWNER);
  await openToken(s, token);
  const { curve, threshold } = await s.evaluate(() => ({ curve: window.CurbApp.state.view.curve,
    threshold: window.CurbApp.state.view.graduationThreshold.toString() }));
  await s.close();
  const pay = (BigInt(threshold) * 3n) / 2n;
  await mined({ from: OWNER, to: WETH, data: sel("deposit()"), value: "0x" + pay.toString(16) }, "the wrap");
  await mined({ from: OWNER, to: WETH, data: sel("approve(address,uint256)") + word(BigInt(curve)) + word(pay) }, "the approval");
  await mined({ from: OWNER, to: curve, data: sel("buy(uint256,uint256,address)") + word(pay) + word(0) + word(BigInt(OWNER)),
    gas: "0x" + (8_000_000).toString(16) }, "the filling buy");
  const graduator = addrOf(await ethCall(factory, sel("graduator()")));
  const graduated = async () => BigInt(await ethCall(graduator, sel("hasGraduated(address)") + word(BigInt(token)))) === 1n;
  if (!(await graduated())) {
    await mined({ from: OWNER, to: graduator, data: sel("graduate(address)") + word(BigInt(token)), gas: "0x" + (8_000_000).toString(16) }, "the move");
  }

  for (const country of ["US", "DE"]) {
    const p = await newPage(OWNER, { country });
    await openToken(p, token);
    await expect(p.locator("#tvStatus")).toHaveText("Graduated", { timeout: 30_000 });
    await quoted(p, "buy", "0.001");
    if (country === "US") {
      await cardHeld(p);
      await refusedOnCard(p);
      // THE LONG PAGE'S PANEL SAYS IT TOO.
      await expect(p.locator("#poolAct + p.regionNote")).toHaveText(WORDS);
    } else {
      await expect(p.locator("#tvAct")).toBeEnabled({ timeout: 20_000 });
      await p.click("#tvAct");
      await expect(p.locator("#msg")).toContainText("you declined", { timeout: 60_000 });
      expect(await sendsAsked(p), "a pool swap from elsewhere never reached the wallet").toBe(1);
    }
    await p.close();
  }
});

// ================================================================== the move
test("from the United States completing a waiting launch's move sends nothing, on its page and on launch.html; elsewhere it reaches the wallet", async () => {
  // THE FIXTURE'S WAITING LAUNCH: every send is declined, so it stays waiting.
  for (const country of ["US", "DE"]) {
    const held = country === "US";
    // ITS OWN PAGE.
    const p = await newPage(OWNER, { country });
    await openToken(p, STATE.token, STATE.lens);
    await expect(p.locator("#tvStatus")).toHaveText("Waiting", { timeout: 30_000 });
    await expect(p.locator("#tvAct")).toHaveText("Complete the move", { timeout: 20_000 });
    if (held) {
      await cardHeld(p);
      await refusedOnCard(p);
    } else {
      await expect(p.locator("#tvActNote")).not.toHaveText(WORDS);
      await p.click("#tvAct");
      await expect(p.locator("#msg")).toContainText("you declined", { timeout: 60_000 });
      expect(await sendsAsked(p), "the move from elsewhere never reached the wallet").toBe(1);
    }
    await p.close();

    // launch.html.
    const l = await newPage(OWNER, { country, before: (q) => q.addInitScript({ content:
      "localStorage.setItem('curb.launch.addrs', " + JSON.stringify(JSON.stringify({ lens: STATE.lens, token: STATE.token, rpc: STATE.rpc })) + ");" }) });
    await l.goto("/launch.html");
    await l.waitForFunction(() => !!window.CurbLaunch, null, { timeout: 8_000 });
    await expect(l.locator("#statusText")).toHaveText("Waiting", { timeout: 20_000 });
    await expect(l.locator("#wallet")).toContainText("Connected:", { timeout: 20_000 });
    if (held) {
      await expect(l.locator("#complete + p.regionNote")).toHaveText(WORDS);
      await expect(l.locator("#complete")).toBeDisabled();
      await l.evaluate(() => { const b = document.getElementById("complete"); b.disabled = false; b.click(); });
      await expect(l.locator("#msg")).toContainText(REFUSED, { timeout: 30_000 });
      expect(await sendsAsked(l), "launch.html sent the move from the United States").toBe(0);
    } else {
      await expect(l.locator(".regionNote")).toHaveCount(0);
      await expect(l.locator("#complete")).toBeEnabled();
      await l.click("#complete");
      await expect(l.locator("#msg")).toContainText(/declined|rejected/i, { timeout: 60_000 });
      expect(await sendsAsked(l), "launch.html never asked the wallet from elsewhere").toBe(1);
    }
    await l.close();
  }
});

// ================================================================== failing closed
test("on the site's own host an answer that cannot be read refuses with a try-again and sends nothing, and the next press asks again; elsewhere it holds nothing", async () => {
  const factory = await factoryFor(WETH);
  const listing = (hosts) => (q) => q.route(/\/config\.js(\?.*)?$/, (route) => route.fulfill({
    status: 200, contentType: "text/javascript; charset=utf-8",
    body: testConfig() + "\nwindow.CURB_SITE.regionHosts = " + JSON.stringify(hosts) + ";\n" }));
  const unanswered = (q) => q.route(/\/region(\?.*)?$/, (route) => route.abort());

  // (a) THE SITE'S OWN HOST: refused, nothing sent - and once /region answers, the press goes on.
  const p = await newPage(OWNER, { before: async (q) => { await listing(["127.0.0.1"])(q); await unanswered(q); } });
  await openForm(p, factory);
  await p.fill("#nName", "Region Unread");
  await p.fill("#nSymbol", "RUN");
  await expect(p.locator("#create")).toBeEnabled();
  await p.click("#create");
  await expect(p.locator("#msg")).toContainText(UNREAD, { timeout: 30_000 });
  await idle(p);
  expect(await sendsAsked(p), "a create went out with no answer").toBe(0);
  await p.unroute(/\/region(\?.*)?$/);
  await p.click("#create");
  await expect(p.locator("#msg")).toContainText("you declined", { timeout: 30_000 });
  expect(await sendsAsked(p), "the press after the answer came never reached the wallet").toBe(1);
  await p.close();

  // (b) ANOTHER HOST - an IPFS gateway, a local server - holds nothing on no answer.
  const o = await newPage(OWNER, { before: async (q) => { await listing([])(q); await unanswered(q); } });
  await openForm(o, factory);
  await o.fill("#nName", "Region Elsewhere");
  await o.fill("#nSymbol", "REL");
  await o.click("#create");
  await expect(o.locator("#msg")).toContainText("you declined", { timeout: 30_000 });
  expect(await sendsAsked(o)).toBe(1);
  await o.close();

  // (c) A PAGE WITHOUT region.js sends nothing the gate holds, on any host.
  const n = await newPage(OWNER, { before: (q) => q.route(/\/region\.js(\?.*)?$/, (route) => route.fulfill({ status: 404, body: "" })) });
  await openForm(n, factory);
  expect(await regionState(n)).toBe("none");
  await n.fill("#nName", "Region None");
  await n.fill("#nSymbol", "RNO");
  await n.click("#create");
  await expect(n.locator("#msg")).toContainText(UNREAD, { timeout: 30_000 });
  await idle(n);
  expect(await sendsAsked(n)).toBe(0);
  await n.close();
});
