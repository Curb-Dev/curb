// THE SITE AS IT SHIPS: what a visitor gets with no link at all, the domain's
// root and its 404, the hosts' rules, the response headers, and the switches
// the site is halted with.
//
// EVERY OTHER SUITE OPENS PAGES WITH ?rpc=&lens=, so none of them ever saw
// what a first visit reads - which is how a site that read nothing without a
// link passed every test. Here the deployment comes from web/config.js, as it
// will on deploy day: each test serves a stand-in config.js naming this run's
// waiting stack (the launch demo-waiting.sh made), and opens plain URLs in a
// fresh browser context, so nothing is saved either.
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { siteHeaders, fileFor } = require("./serve.js");
const { walletsScript, uuid, PROJECT_ID, useFakeWalletConnect } = require("./fake-wallets.js");

const STATE = JSON.parse(fs.readFileSync(path.join(__dirname, ".state.json"), "utf8"));
const WEB = path.join(__dirname, "..");
const STUB = fs.readFileSync(path.join(WEB, "wallet-stub.js"), "utf8");
const TRADER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

// THE DEPLOYMENT THE STAND-IN NAMES: the waiting stack - a registry with a
// launch in it - and the factory that made that launch.
const LENS = STATE.lens;
const TOKEN = STATE.token.toLowerCase();
const MAKER = STATE.other.factory.toLowerCase();

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

/// The registry a lens reads.
const registryOf = async (lens) => addrOf(await ethCall(lens, sel("registry()")));
/// Every factory a lens's registry admits, as config.js lists them on deploy day.
const factoriesRead = new Map();
async function factoriesOf(lens) {
  if (!factoriesRead.has(lens)) {
    const registry = await registryOf(lens);
    const n = Number(BigInt(await ethCall(registry, sel("launcherCount()"))));
    const out = [];
    for (let i = 0; i < n; i++) out.push(addrOf(await ethCall(registry, sel("launcherAt(uint256)") + word(i))));
    factoriesRead.set(lens, out);
  }
  return factoriesRead.get(lens);
}
const factories = () => factoriesOf(LENS);

// ------------------------------------------------------------------ the stand-in
/// web/config.js as deploy day writes it, for this run's node and stack, with
/// `over` laid on top.
async function standIn(over = {}) {
  const site = {
    chainId: 8453, rpc: STATE.rpc, lens: LENS, registry: await registryOf(LENS), factories: await factories(),
    explorer: "https://basescan.org", featured: [], banner: "", hiddenFactories: [], hiddenLaunches: [], ...over,
  };
  return "window.CURB_SITE = " + JSON.stringify(site) + ";";
}
/// THE FULL-FLOW STACK AS config.js WOULD NAME IT (demo-app.sh's: a registry
/// with no launch of its own, where a test can create one and trade it).
async function appSite(over = {}) {
  return { lens: STATE.app.lens, registry: await registryOf(STATE.app.lens), factories: await factoriesOf(STATE.app.lens), ...over };
}
/// Every page this page opens reads `over`'s config.js instead of the file.
async function useConfig(page, over) {
  const body = await standIn(over);
  await page.route(/\/config\.js(\?.*)?$/, (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body }));
}
/// A wallet the site may already see, on `chainId`. `through` is the node the
/// wallet itself reads the chain through - the run's own, unless a test gives
/// it an endpoint of its own name (routeEndpoint).
async function useWallet(page, cfg = {}, through = STATE.rpc) {
  await page.addInitScript({ content: [
    STUB, ";(function () {",
    "  window.ethereum = window.makeWallet(" + JSON.stringify(through) + ", " +
      JSON.stringify({ forward: true, chainId: "0x2105", account: TRADER, connected: true, ...cfg }) + ");",
    "})();",
  ].join("\n") });
}
/// AN ENDPOINT OF ITS OWN NAME FOR THE RUN'S NODE, served through Playwright:
/// every request goes on to the node except those `answer` takes over - it is
/// handed the request and the node's own answer, and returns the result to
/// give instead, or undefined to give the node's.
async function routeEndpoint(page, url, answer) {
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST, OPTIONS" };
  await page.route(new RegExp("^" + url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(/.*)?$"), async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const res = await fetch(STATE.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: req.postData() });
    const text = await res.text();
    let body = null, theirs = null;
    try { body = JSON.parse(req.postData() || "null"); theirs = JSON.parse(text); } catch { body = null; }
    const own = body && !Array.isArray(body) && theirs && "result" in theirs ? await answer(body, theirs.result) : undefined;
    return route.fulfill({ status: res.status, headers: cors, contentType: "application/json",
      body: own === undefined ? text : JSON.stringify({ ...theirs, result: own }) });
  });
}
/// An eth_call to `to` whose data starts with `selector`.
const callTo = (b, to, selector) => b.method === "eth_call" && b.params && b.params[0] &&
  String(b.params[0].to || "").toLowerCase() === String(to).toLowerCase() &&
  String(b.params[0].data || "").toLowerCase().startsWith(selector);
/// A FRESH ACCOUNT OF ITS OWN: no code (the well-known keys carry EIP-7702
/// delegations on Base), the node signing for it, and plenty of ether.
async function freshAccount(label) {
  const a = "0x" + window.CurbKeccak.keccak256("0x" + window.CurbAbi.utf8Hex("curb prod.spec " + label)).slice(-40);
  expect(await rpc("eth_getCode", [a, "latest"]), "the account has code on this chain").toBe("0x");
  await rpc("anvil_impersonateAccount", [a]);
  await rpc("anvil_setBalance", [a, "0x" + (100n * 10n ** 18n).toString(16)]);
  return a;
}
const sentCount = (page) => page.evaluate(() => window.ethereum.sent.length);

// ------------------------------------------------------------------ the pages
/// The launch's card on the Launches grid, found by the whole address on its
/// title (lowercase, as the lens returns it).
const cardFor = (page, token) => page.locator(`.launch .addr[title="${token.toLowerCase()}"]`);
/// The Launches page has read every launch the registry holds.
async function allLoaded(page) {
  await expect(page.locator("#loaded")).toHaveText(/^(\d+) of \1 launches loaded\.$/, { timeout: 30_000 });
}
const hrefsIn = (page, css) => page.locator(css).evaluateAll((as) => as.map((a) => a.getAttribute("href") || ""));
const panelOpen = (page) => page.locator("#wherePanel").evaluate((d) => d.open);

// ================================================================== item 3
test("a first visit with no link and nothing saved reads the deployment config.js names: /, a token's page, app.html and /sharing", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await useConfig(page, {});

  // THE DOMAIN'S ROOT: the launches, read.
  await page.goto("/");
  await expect(page).toHaveTitle(/^Explore · Curb/);
  await allLoaded(page);
  await expect(cardFor(page, TOKEN)).toHaveCount(1);

  // A TOKEN'S OWN PAGE, as it is shared on X: its launch read, nothing to type.
  await page.goto("/token/" + STATE.token);
  await expect(page.locator("#tokenView")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#tvStatus")).not.toHaveText("—", { timeout: 30_000 });
  await expect(page.locator("#tvSym")).not.toHaveText("—", { timeout: 30_000 });
  await expect(page.locator("body")).not.toContainText("Enter a LaunchLens address");
  // AND NOTHING SAID ABOUT THE LINK: the deployment is the one config.js
  // publishes (app.js CANONICAL), and it named no half of anything - nor about
  // the endpoint, which is the site's own (topbar.js endpointNotice).
  await expect(page.locator("#linkWarn")).toBeHidden();
  await expect(page.locator("#cbEndpoint")).toBeHidden();

  // THE CREATE FORM: the registry's assets offered, the WETH pair chosen.
  await page.goto("/app.html");
  await expect.poll(() => page.locator("#quotePick option").evaluateAll((os) => os.filter((o) => o.value).length),
    { timeout: 30_000, message: "the create form offered no asset" }).toBeGreaterThan(0);
  await expect(page.locator("#lens")).toHaveValue(LENS);
  expect(await panelOpen(page), "the settings panel opened for a plain visit").toBe(false);

  // HOLDER FEES: past "no lens", to asking for a wallet.
  await page.goto("/sharing");
  await expect(page.locator("#shConnect")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#msg")).not.toContainText("No lens is set");
  expect(errors).toEqual([]);
});

test("without a lens in config.js (the file as committed) the pages say there is no registry, so the stand-in is what read", async ({ page }) => {
  await page.goto("/sharing");
  await expect(page.locator("#msg")).toHaveText("No lens is set.", { timeout: 15_000 });
  await page.goto("/");
  await expect(page.locator("#msg")).toContainText("No registry is configured", { timeout: 15_000 });
});

// ================================================================== item 27
test("the built-in pair stays out of every link: plain links, a closed panel, and nothing of it saved", async ({ page }) => {
  await useConfig(page, {});
  await page.goto("/");
  await allLoaded(page);
  for (const h of await hrefsIn(page, "#siteBar a, #heroLaunch, .launch a.open")) {
    expect(h, "a link on the page carries the built-in pair").not.toMatch(/[?&](rpc|lens|factory)=/);
  }

  // A LINK THAT ONLY RESTATES THE PAIR is no link: no panel, no warning, plain links.
  await page.goto("/app.html?" + new URLSearchParams({ rpc: STATE.rpc, lens: LENS }).toString());
  await expect.poll(() => page.locator("#quotePick option").evaluateAll((os) => os.filter((o) => o.value).length),
    { timeout: 30_000 }).toBeGreaterThan(0);
  expect(await panelOpen(page)).toBe(false);
  await expect(page.locator("#linkWarn")).toBeHidden();
  for (const h of await hrefsIn(page, "#siteBar a")) expect(h).not.toMatch(/[?&](rpc|lens)=/);

  // A PICK IS SAVED WITHOUT THE PAIR, so the site can move its endpoint later.
  const card = page.locator("#quoteGrid .qcard").last();
  await card.click();
  const picked = await page.locator("#factory").inputValue();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("curb.app.v1") || "{}"));
  expect(saved.factory && saved.factory.toLowerCase()).toBe(picked.toLowerCase());
  expect(saved.rpc, "the built-in endpoint was saved").toBeUndefined();
  expect(saved.lens, "the built-in lens was saved").toBeUndefined();
  await page.goto("/app.html");
  await expect(page.locator("#factory")).toHaveValue(picked, { timeout: 15_000 });
  await expect(page.locator("#rpc")).toHaveValue(STATE.rpc);
});

test("a link naming the built-in pair over another saved pair is still carried, and a link to another deployment is warned about", async ({ page }) => {
  await useConfig(page, {});
  await page.goto("/terms.html");
  await page.evaluate(([rpc, lens]) => localStorage.setItem("curb.app.v1", JSON.stringify({ rpc, lens })), [STATE.rpc, STATE.app.lens]);
  await page.goto("/browse.html?" + new URLSearchParams({ rpc: STATE.rpc, lens: LENS }).toString());
  const nav = await hrefsIn(page, "#siteBar .cbNav a");
  for (const h of nav) expect(h, "the link's pair was dropped while another one is saved").toContain("lens=" + LENS);

  await page.evaluate(() => localStorage.clear());
  await page.goto("/app.html?" + new URLSearchParams({ rpc: STATE.rpc, factory: STATE.app.factory, lens: STATE.app.lens }).toString());
  await expect(page.locator("#linkWarn")).toContainText("THIS IS NOT THE DEPLOYMENT THIS PRODUCT PUBLISHES", { timeout: 20_000 });
});

// ================================================================== a link's endpoint (audit, item 2)
// ON THE CHAIN config.js NAMES, A SEND GOES ONLY TO ITS OWN CONTRACTS, AND ONLY
// FROM A PAGE READ THROUGH ITS OWN ENDPOINT. A link's ?rpc= answers every read a
// page makes, the registry a factory reports included, so a warning was not
// enough: a factory config.js does not list is not offered and nothing is sent
// to it, a factory whose registry is not config.js's is refused, and through
// any endpoint but the site's own nothing is sent at all - checking the facts
// a send is built from against the wallet's network left the ones nobody had
// listed to the endpoint (re-review item 2b). On any chain but config.js's,
// nothing is sent and the wallet is offered config.js's chain only (item 2a).
// Every page says which endpoint it reads when it is not the site's own.
const LIAR = "http://registry-liar.test:8701";
const OTHER_ENDPOINT = "http://other-endpoint.test:8701";
const OTHER_CHAIN = "http://other-chain.test:8701";
/// The values the create form's asset picker offers.
const offered = (page) => page.locator("#quotePick option").evaluateAll((os) => os.map((o) => o.value.toLowerCase()).filter(Boolean));

test("a factory config.js does not list is not offered, is warned about the moment it is typed, and gets nothing sent to it", async ({ page }) => {
  test.setTimeout(120_000);
  const site = await appSite();
  const unlisted = STATE.app.factory.toLowerCase();
  expect(site.factories, "the full-flow registry does not admit the full-flow factory").toContain(unlisted);
  const listed = site.factories.filter((f) => f !== unlisted);
  expect(listed.length, "the full-flow registry admits only one factory, so nothing is left to list").toBeGreaterThan(0);
  await useConfig(page, { ...site, factories: listed });
  const who = await freshAccount("unlisted factory");
  await useWallet(page, { account: who });
  await page.goto("/app.html");
  // THE PICKER: what config.js lists, read through the site's own endpoint.
  await expect.poll(() => offered(page), { timeout: 30_000 }).toHaveLength(listed.length);
  expect(await offered(page), "a factory config.js does not list was offered").not.toContain(unlisted);
  await expect(page.locator("#linkWarn")).toBeHidden();
  // TYPED BY HAND: the warning follows the factory, not only the first load.
  await page.evaluate((f) => { const e = document.getElementById("factory"); e.value = f; e.dispatchEvent(new Event("change")); }, STATE.app.factory);
  await expect(page.locator("#linkWarn")).toContainText("THIS IS NOT THE DEPLOYMENT THIS PRODUCT PUBLISHES", { timeout: 20_000 });
  // AND A CREATE ON IT IS REFUSED, before the wallet is asked anything.
  await page.evaluate(() => window.CurbApp.connect());
  await expect.poll(() => page.evaluate(() => ((window.CurbApp.state.ctx || {}).factory || "")), { timeout: 30_000 }).toBe(unlisted);
  await page.fill("#nName", "Unlisted Factory");
  await page.fill("#nSymbol", "UNL");
  await page.click("#create");
  await expect(page.locator("#msg")).toContainText("is not one this site publishes for this chain, so nothing is sent", { timeout: 30_000 });
  expect(await sentCount(page), "something was sent to a factory config.js does not list").toBe(0);
});

test("a link whose endpoint names another registry for the site's own factory gets nothing sent, and the endpoint is said under the bar", async ({ page }) => {
  test.setTimeout(120_000);
  const site = await appSite();
  // THE LIE: every factory's registry() answers the OTHER stack's registry - a
  // real one, so every read the page makes still works.
  const otherRegistry = await registryOf(LENS);
  expect(otherRegistry).not.toBe(site.registry);
  const asksFactoryRegistry = (b) => site.factories.some((f) => callTo(b, f, sel("registry()")));
  await routeEndpoint(page, LIAR, (b) => (asksFactoryRegistry(b) ? "0x" + word(BigInt(otherRegistry)) : undefined));
  await useConfig(page, site);
  const who = await freshAccount("registry liar");
  await useWallet(page, { account: who });
  await page.goto("/app.html?" + new URLSearchParams({ rpc: LIAR, lens: STATE.app.lens }).toString());
  await expect(page.locator("#cbEndpoint")).toContainText("This page reads the chain through registry-liar.test:8701, not through " +
    "this site's own endpoint");
  await page.evaluate(() => window.CurbApp.connect());
  await expect.poll(() => page.evaluate(() => ((window.CurbApp.state.ctx || {}).registry || "").toLowerCase()), { timeout: 30_000 })
    .toBe(otherRegistry);
  await page.fill("#nName", "Lying Registry");
  await page.fill("#nSymbol", "LYR");
  await page.click("#create");
  await expect(page.locator("#msg")).toContainText("which is not the registry this site publishes (" + site.registry + ")", { timeout: 30_000 });
  expect(await sentCount(page), "something was sent under a registry config.js does not name").toBe(0);
});

test("through an endpoint that is not the site's own nothing is sent, however honest it is; through the site's own the same buy goes out", async ({ browser }) => {
  test.setTimeout(300_000);
  const site = await appSite();
  const who = await freshAccount("endpoint refused");
  const open = async () => {
    const p = await browser.newPage();
    await useConfig(p, site);
    await useWallet(p, { account: who });
    return p;
  };
  // A LAUNCH, MADE THROUGH THE SITE'S OWN ENDPOINT: it goes out.
  const maker = await open();
  await maker.goto("/app.html");
  await maker.evaluate(() => window.CurbApp.connect());
  await expect.poll(() => maker.evaluate(() => !!(window.CurbApp.state.ctx && window.CurbApp.state.ctx.quote)), { timeout: 30_000 }).toBe(true);
  await maker.fill("#nName", "Endpoint Refused");
  await maker.fill("#nSymbol", "EPR");
  await maker.click("#create");
  await expect(maker.locator("#msg")).toContainText("Launched", { timeout: 60_000 });
  const token = await maker.evaluate(() => window.CurbApp.state.chainCfg.token);
  await maker.close();

  /// THE CARD ON BUY, PAID IN ETH (router.spec.js cardSide and payWith), and a
  /// press of it that ends in `done`.
  const buyOn = async (p, done) => {
    await expect(p.locator("#tvStatus")).toHaveText("Selling", { timeout: 30_000 });
    await p.evaluate(() => window.CurbApp.connect());
    await expect.poll(() => p.evaluate(() => ((window.CurbApp.state.viewFor || {}).token || "").toLowerCase()), { timeout: 30_000 })
      .toBe(token.toLowerCase());
    const sym = (await p.locator("#tvSym").textContent()).trim().replace(/^\$/, "");
    if ((await p.locator("#tvPayAsset").textContent()).trim() === sym) await p.click("#tvFlip");
    const pick = p.locator(".tvAsset.tvPick");
    if (await pick.count() && (await pick.textContent()).trim() !== "ETH") {
      await pick.click();
      await p.locator('#tvMenu button[data-choice="eth"]').click();
    }
    await p.fill("#tvPay", "0.01");
    await expect(p.locator("#tvAct")).toHaveText(/^Buy \$/, { timeout: 30_000 });
    await expect(p.locator("#tvAct")).toBeEnabled({ timeout: 30_000 });
    await rpc("evm_mine", []);
    await p.evaluate(() => { document.getElementById("msg").textContent = ""; });
    await p.click("#tvAct");
    await expect(p.locator("#msg")).toContainText(done, { timeout: 120_000 });
  };

  // ITS PAGE THROUGH ANOTHER ENDPOINT - AN HONEST ONE, forwarding every read to
  // the same node: the page reads and quotes, and sends nothing, because what
  // a send would be built from is that endpoint's word whether or not it lies.
  const p = await open();
  await routeEndpoint(p, OTHER_ENDPOINT, () => undefined);
  await p.goto("/token/" + token + "?" + new URLSearchParams({ rpc: OTHER_ENDPOINT, lens: STATE.app.lens }).toString());
  await expect(p.locator("#cbEndpoint"), "a token's page read through another endpoint does not say so")
    .toContainText("This page reads the chain through other-endpoint.test:8701");
  await expect(p.locator("#cbEndpoint")).toContainText("nothing is sent from it");
  await buyOn(p, "not through this site's own endpoint, so nothing is sent from it");
  expect(await sentCount(p), "a buy was sent from a page read through another endpoint").toBe(0);
  await p.close();

  // THE SAME BUY THROUGH THE SITE'S OWN ENDPOINT (no link at all): it goes out,
  // through the router, in one send - so the refusal above is the endpoint's.
  const q = await open();
  await q.goto("/token/" + token);
  await expect(q.locator("#cbEndpoint")).toBeHidden();
  await buyOn(q, "Done, in one transaction through the CURB router");
  expect(await sentCount(q), "the buy through the site's own endpoint was not sent").toBe(1);
  await q.close();
});

test("on a chain config.js does not name nothing is sent, and the wallet is offered config.js's chain only, added with Base's own endpoint", async ({ page }) => {
  test.setTimeout(180_000);
  const site = await appSite();
  // THE ATTACK'S SHAPE: a link's endpoint for another chain (10, OP Mainnet)
  // and a wallet on that chain, so the two agree - which was all a send asked
  // of a chain config.js names nothing on. Its reads are this run's node.
  await routeEndpoint(page, OTHER_CHAIN, (b) => (b.method === "eth_chainId" ? "0xa" : undefined));
  await useConfig(page, site);
  const who = await freshAccount("other chain");
  await useWallet(page, { account: who, chainId: "0xa", knownChains: ["0xa"] });
  await page.goto("/app.html?" + new URLSearchParams({ rpc: OTHER_CHAIN, lens: STATE.app.lens, factory: STATE.app.factory }).toString());
  await page.evaluate(() => window.CurbApp.connect());
  // SAID AT CONNECT, with the one way out: Base, not the endpoint's chain.
  await expect(page.locator("#msg")).toContainText("Nothing is sent on any other chain", { timeout: 30_000 });
  await expect(page.locator('#msg button[data-switch-chain]')).toHaveAttribute("data-switch-chain", "0x2105");
  await expect.poll(() => page.evaluate(() => !!(window.CurbApp.state.ctx && window.CurbApp.state.ctx.quote)), { timeout: 30_000 }).toBe(true);
  // A CREATE IS REFUSED, before the wallet is asked anything.
  await page.fill("#nName", "Other Chain");
  await page.fill("#nSymbol", "OTHC");
  await page.evaluate(() => { const m = document.getElementById("msg"); m.innerHTML = ""; m.hidden = true; });
  await page.click("#create");
  await expect(page.locator("#msg")).toContainText("this site's deployment is on Base (chain 8453). Nothing is sent on any other chain",
    { timeout: 30_000 });
  await expect(page.locator('#msg button[data-switch-chain]')).toHaveAttribute("data-switch-chain", "0x2105");
  expect(await sentCount(page), "a create was sent on a chain config.js does not name").toBe(0);
  // THE BAR WILL NOT MOVE THE WALLET TO THE ENDPOINT'S CHAIN, whoever asks.
  const refusedSwitch = await page.evaluate(() => window.CurbBar.switchChain("0xa", "http://other-chain.test:8701")
    .then(() => "switched", (e) => e.message));
  expect(refusedSwitch).toContain("This site sends only on Base");
  // AND THE ONE IT OFFERS, PRESSED: Base, added with Base's public endpoint -
  // never the link's.
  await page.locator('#msg button[data-switch-chain="0x2105"]').click();
  await expect.poll(() => page.evaluate(() => window.ethereum.cfg.chainId), { timeout: 10_000 }).toBe("0x2105");
  const w = await page.evaluate(() => ({ switches: window.ethereum.switches, added: window.ethereum.added }));
  expect(w.switches, "the wallet was asked to move to the endpoint's chain").not.toContain("0xa");
  expect(w.added.map((n) => n.chainId)).toEqual(["0x2105"]);
  expect(w.added[0].rpcUrls).toEqual(["https://mainnet.base.org"]);
  // THE HOLDER FEES CLAIM AND launch.html HOLD TO THE SAME CHAIN (the bar's
  // chainRefusal): asked here of the bar the way both pages ask it.
  expect(await page.evaluate(() => window.CurbBar.chainRefusal("0xa"))).toContain("Nothing is sent on any other chain");
  expect(await page.evaluate(() => window.CurbBar.chainRefusal("0x2105"))).toBeNull();
});

// ================================================================== item 4
test("the domain's root is the launches page, and an address that is no page gets the site's 404 with its bar", async ({ page, request, baseURL }) => {
  const root = await request.get("/");
  expect(root.status()).toBe(200);
  expect(await root.text()).toContain("<title>Explore · Curb");
  const miss = await request.get("/no/such/page");
  expect(miss.status()).toBe(404);
  expect(await miss.text()).toContain("This page does not exist");

  await page.goto("/no/such/page");
  await expect(page.locator("#siteBar .cbInner")).toBeVisible();
  // FROM THE ROOT, at any depth: the bar's links and the page's own.
  expect(await page.locator('#siteBar .cbNav a[data-k="browse"]').evaluate((a) => a.href)).toBe(baseURL + "/browse.html");
  await page.locator("main a.main").click();
  await expect(page).toHaveURL(baseURL + "/browse.html");

  // THE HOSTS SAY THE SAME, and so does the test server.
  const vercel = JSON.parse(fs.readFileSync(path.join(WEB, "vercel.json"), "utf8"));
  expect(vercel.rewrites).toContainEqual({ source: "/", destination: "/browse.html" });
  expect(fs.readFileSync(path.join(WEB, "_redirects"), "utf8")).toMatch(/^\/\s+\/browse\.html\s+200\s*$/m);
  expect(fileFor("/")).toBe("browse.html");
});

// ================================================================== item 5
test("wallet-setup.html writes what an endpoint answers as text, never as markup", async ({ page }) => {
  // AN ENDPOINT OF SOMEBODY'S CHOOSING, answering with markup in its error.
  await page.route(/\/evil-rpc$/, (route) => route.fulfill({ status: 200, contentType: "application/json",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: '<img src=x onerror="window.__pwned=1">' } }) }));
  await page.goto("/wallet-setup.html?" + new URLSearchParams({ rpc: "/evil-rpc", scratch: "/evil-rpc" }).toString());
  await expect(page.locator("#forkChain")).toContainText('<img src=x onerror="window.__pwned=1">', { timeout: 10_000 });
  expect(await page.locator("#forkChain img, #scratchChain img").count()).toBe(0);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
});

test("the test pages stay out of the publish set: Vercel ignores them and Netlify answers them with the 404", async () => {
  const ignored = fs.readFileSync(path.join(WEB, ".vercelignore"), "utf8").split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  const redirects = fs.readFileSync(path.join(WEB, "_redirects"), "utf8");
  for (const f of ["tests.html", "wallet-setup.html", "wallet-stub.js", "REAL_WALLET_TEST.txt", "vendor/README.txt", "e2e", "test-results"]) {
    expect(ignored, f + " is not in .vercelignore").toContain("/" + f);
    const want = /\./.test(f) ? "/" + f : "/" + f + "/*";
    expect(redirects.split(/\r?\n/).some((l) => l.trim().split(/\s+/).join(" ") === want + " /404.html 404!"),
      f + " is not answered with the 404 in _redirects").toBe(true);
  }
});

// ================================================================== item 29
const POLICY = (() => {
  const n = siteHeaders(fs.readFileSync(path.join(WEB, "_headers"), "utf8"));
  return Object.fromEntries(n.map(([k, v]) => [k.toLowerCase(), v]));
})();

test("the two hosts send the same headers, and the policy names every inline script a published page carries", async () => {
  const vercel = JSON.parse(fs.readFileSync(path.join(WEB, "vercel.json"), "utf8"));
  const all = vercel.headers.find((h) => h.source === "/(.*)");
  const v = Object.fromEntries(all.headers.map((h) => [h.key.toLowerCase(), h.value]));
  expect(v).toEqual(POLICY);
  expect(POLICY["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(POLICY["x-content-type-options"]).toBe("nosniff");
  expect(POLICY["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  const ignored = new Set(["tests.html", "wallet-setup.html"]);
  let inline = 0;
  for (const f of fs.readdirSync(WEB).filter((x) => x.endsWith(".html") && !ignored.has(x))) {
    const html = fs.readFileSync(path.join(WEB, f), "utf8");
    for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
      inline += 1;
      const h = "'sha256-" + crypto.createHash("sha256").update(m[1], "utf8").digest("base64") + "'";
      expect(POLICY["content-security-policy"], f + "'s inline script is not named by the policy").toContain(h);
    }
  }
  expect(inline, "app.html's <base> script was not found").toBeGreaterThan(0);
});

/// WALLETCONNECT WIDENS THE POLICY BY TWO NAMED HOSTS AND NO MORE: its relay,
/// a WebSocket that https: does not cover, and the hidden Verify frame its SDK
/// opens. Both are read from the vendored SDK itself, so a version that moves
/// either fails here before it fails for a visitor.
test("the policy names WalletConnect's relay and its Verify frame and nothing more, and covers every one the vendored SDK uses", async () => {
  const csp = POLICY["content-security-policy"];
  const dir = (name) => (csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(name + " ")) || "").split(/\s+/).slice(1);
  expect(dir("connect-src")).toEqual(["'self'", "https:", "wss://relay.walletconnect.org"]);
  expect(dir("frame-src")).toEqual(["https://verify.walletconnect.org"]);
  expect(dir("script-src")).toHaveLength(2);
  expect(dir("script-src")[0]).toBe("'self'");
  expect(csp).not.toMatch(/unsafe-eval|wasm-unsafe-eval/);
  const adapter = fs.readFileSync(path.join(WEB, "walletconnect.js"), "utf8");
  const umd = fs.readFileSync(path.join(WEB, /const UMD = "([^"]+)";/.exec(adapter)[1]), "utf8");
  const sockets = new Set([...umd.matchAll(/wss?:\/\/[a-z0-9.-]+/gi)].map((m) => m[0]));
  sockets.add(/const RELAY = "([^"]+)";/.exec(adapter)[1]);
  for (const s of sockets) expect(dir("connect-src"), s + " is not in connect-src").toContain(s);
  // THE FRAME'S HOST: the SDK's Verify URL, which its iframe's src is built from.
  expect(umd.match(/createElement\("iframe"\)/g), "the SDK makes a frame somewhere new").toHaveLength(1);
  const verify = /\w+="(https:\/\/[^"/]+)",(\w+)=\w+,\w+=`\$\{\2\}\/v3`/.exec(umd);
  expect(verify, "the Verify frame's host could not be found in the SDK: check it against frame-src by hand").not.toBeNull();
  expect(dir("frame-src")).toContain(verify[1]);
});

/// Every violation the page meets, recorded from its first script on.
async function recordViolations(page) {
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + e.blockedURI));
  });
}
const violations = (page) => page.evaluate(() => window.__csp || []);

// A SECOND SERVER OF THIS FILE'S OWN, sending the site's headers (serve.js,
// CURB_E2E_HEADERS=1), on a port the system picks. Not the run's server - its
// headers are the run's choice - and not headers added by intercepting the
// page (serve.js says why that fails for a reason the site never meets).
test.describe("under the site's response headers", () => {
  let server = null;
  let base = "";
  test.beforeAll(async () => {
    const { spawn } = require("node:child_process");
    server = spawn(process.execPath, [path.join(__dirname, "serve.js")], {
      env: { ...process.env, CURB_E2E_PORT: "0", CURB_E2E_HEADERS: "1" }, stdio: ["ignore", "pipe", "inherit"],
    });
    base = await new Promise((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => reject(new Error("the headers server never said its port")), 10_000);
      server.stdout.on("data", (d) => {
        out += d;
        const m = /on (\d+) with the site's headers/.exec(out);
        if (m) { clearTimeout(timer); resolve("http://127.0.0.1:" + m[1]); }
      });
      server.on("exit", (code) => reject(new Error("the headers server stopped: " + code)));
    });
  });
  test.afterAll(() => { if (server) server.kill(); });

test("every page works under the site's policy: no violation, and the data still read", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (/Content Security Policy/i.test(m.text())) errors.push(m.text()); });
  await useWallet(page);
  await useConfig(page, {});
  await recordViolations(page);

  const first = await page.goto(base + "/");
  expect(first.headers()["content-security-policy"], "the page was not served under the policy").toContain("frame-ancestors 'none'");
  await allLoaded(page);
  await expect(cardFor(page, TOKEN)).toHaveCount(1);
  // THE SEARCH, fetched on first use (keccak.js, token-meta.js, search.js).
  await page.click("#barSearch");
  await expect(page.locator("#cbSscope")).toContainText("Searches all", { timeout: 20_000 });
  await page.keyboard.press("Escape");
  expect(await violations(page), "a violation on the launches page").toEqual([]);

  await page.goto(base + "/token/" + STATE.token);
  await expect(page.locator("#tvStatus")).not.toHaveText("—", { timeout: 30_000 });
  // THE <base> SCRIPT RAN (by its hash): the page's files came from the root.
  expect(await page.evaluate(() => document.documentElement.classList.contains("tokenView"))).toBe(true);
  expect(await violations(page), "a violation on a token's page").toEqual([]);

  // THE CREATE FORM, its asset list read.
  await page.goto(base + "/app.html");
  await expect.poll(() => page.locator("#quotePick option").evaluateAll((os) => os.filter((o) => o.value).length),
    { timeout: 30_000 }).toBeGreaterThan(0);
  expect(await violations(page), "a violation on app.html").toEqual([]);

  for (const p of ["/sharing", "/docs.html", "/curb.html", "/terms.html", "/launch.html", "/migrate.html", "/no/such/page"]) {
    await page.goto(base + p);
    await expect(page.locator("#siteBar .cbInner")).toBeVisible({ timeout: 15_000 });
    // MOVING A COMMUNITY reads the factories' terms through the stand-in's lens.
    if (p === "/migrate.html") await expect(page.locator("#mCostTable tbody tr").first()).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(1500);
    expect(await violations(page), "a violation on " + p).toEqual([]);
  }
  await expect(page.locator("main")).toContainText("This page does not exist");
  expect(errors).toEqual([]);
});

test("the policy is live: an inline script nobody hashed is refused", async ({ page }) => {
  await recordViolations(page);
  await page.goto(base + "/terms.html");
  await expect(page.locator("#siteBar .cbInner")).toBeVisible();
  await page.evaluate(() => {
    const s = document.createElement("script");
    s.textContent = "window.__inline = 1";
    document.head.append(s);
  });
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__inline)).toBeUndefined();
  expect((await violations(page)).some((v) => v.startsWith("script-src"))).toBe(true);
});

/// THE WALLET PICKER - a wallet's data: icon drawn - AND WALLETCONNECT'S PANEL
/// - the adapter, its QR library and an SDK stand-in loaded by their hash -
/// under the site's policy, with no violation.
test("the wallet picker and WalletConnect's panel work under the site's policy", async ({ page }) => {
  await useConfig(page, { walletConnectProjectId: PROJECT_ID });
  await useFakeWalletConnect(page);
  const icon = "data:image/svg+xml;base64," + Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#0a0"/></svg>').toString("base64");
  await page.addInitScript({ content: walletsScript({ rpc: STATE.rpc,
    list: [{ id: "A", uuid: uuid("1"), rdns: "io.metamask", name: "MetaMask", icon, account: TRADER }] }) });
  await recordViolations(page);
  await page.goto(base + "/curb.html");
  await expect(page.locator("#siteBar .cbInner")).toBeVisible({ timeout: 15_000 });
  await page.click("#barConnect");
  await expect(page.locator("#siteBar .cbPick img")).toHaveCount(1);
  await page.locator("#siteBar .cbPickRow", { hasText: "Phone wallet" }).click();
  await expect.poll(() => page.locator("#siteBar canvas.cbWcQr").evaluate((c) => c.width).catch(() => 0),
    { timeout: 15_000 }).toBeGreaterThan(20);
  expect(await violations(page)).toEqual([]);
});

/// THE REAL VENDORED SDK loads under the policy by the hash walletconnect.js
/// names - no eval, nothing the policy refuses - and under any other hash the
/// browser refuses it.
test("the vendored WalletConnect SDK runs under the site's policy by its hash, and not under another", async ({ page }) => {
  const adapter = fs.readFileSync(path.join(WEB, "walletconnect.js"), "utf8");
  const umd = /const UMD = "([^"]+)";/.exec(adapter)[1];
  const sri = /const UMD_SRI = "([^"]+)";/.exec(adapter)[1];
  await recordViolations(page);
  await page.goto(base + "/terms.html");
  await expect(page.locator("#siteBar .cbInner")).toBeVisible();
  const load = (src, integrity) => page.evaluate(({ src: s, integrity: i }) => new Promise((resolve) => {
    const el = document.createElement("script");
    el.src = s;
    el.integrity = i;
    el.onload = () => resolve("loaded");
    el.onerror = () => resolve("refused");
    document.head.append(el);
  }), { src, integrity });
  expect(await load("/" + umd, sri.replace(/.$/, sri.endsWith("A") ? "B" : "A"))).toBe("refused");
  expect(await page.evaluate(() => typeof globalThis["@walletconnect/universal-provider"])).toBe("undefined");
  expect(await load("/" + umd, sri)).toBe("loaded");
  expect(await page.evaluate(() => typeof globalThis["@walletconnect/universal-provider"].UniversalProvider)).toBe("function");
  expect(await violations(page)).toEqual([]);
});
});

// ================================================================== item 20
const BANNER = 'Trading in <b>XYZ</b> is paused while we look into it.';

test("the incident switches: a banner on every page, and a hidden launch left out of the grid, the hero and the search, its page saying so", async ({ page }) => {
  await useConfig(page, { banner: BANNER, hiddenLaunches: [STATE.token] });

  await page.goto("/");
  await expect(page.locator("#cbBanner")).toHaveText(BANNER);
  expect(await page.locator("#cbBanner b").count(), "the banner became markup").toBe(0);
  await allLoaded(page);
  await expect(cardFor(page, TOKEN)).toHaveCount(0);
  // THE HERO FEATURES NOTHING IN ITS PLACE (with nothing hidden it features
  // this launch within seconds - the last test below).
  await page.waitForTimeout(4000);
  await expect(page.locator("#heroCard")).toBeHidden();

  // THE SEARCH: not listed, and not offered back by its address.
  await page.click("#barSearch");
  await expect(page.locator("#cbSscope")).toContainText("Searches all", { timeout: 20_000 });
  await page.fill("#cbSq", TOKEN);
  await expect(page.locator(`#cbSresults .cbHit[data-token="${TOKEN}" i]`)).toHaveCount(0);
  await expect(page.locator("#cbSresults")).not.toContainText("Open this address");
  await page.keyboard.press("Escape");

  // ITS OWN PAGE STILL OPENS, AND SAYS SO.
  await page.goto("/token/" + STATE.token);
  await expect(page.locator("#tvHidden")).toContainText("Curb no longer lists this launch", { timeout: 30_000 });
  await expect(page.locator("#cbBanner")).toHaveText(BANNER);
  await expect(page.locator("#tvStatus")).not.toHaveText("—", { timeout: 30_000 });

  for (const p of ["/sharing", "/docs.html", "/no/such/page"]) {
    await page.goto(p);
    await expect(page.locator("#cbBanner")).toHaveText(BANNER);
  }
});

test("a hidden factory leaves the create form's choices, and its launches the grid, the hero and the search", async ({ page }) => {
  const all = await factories();
  expect(all, "the stand-in's registry does not list the launch's factory").toContain(MAKER);
  await useConfig(page, { hiddenFactories: [STATE.other.factory] });

  await page.goto("/app.html");
  await expect.poll(() => page.locator("#quotePick option").evaluateAll((os) => os.filter((o) => o.value).length),
    { timeout: 30_000 }).toBe(all.length - 1);
  const offered = await page.locator("#quotePick option").evaluateAll((os) => os.map((o) => o.value.toLowerCase()));
  expect(offered).not.toContain(MAKER);

  await page.goto("/");
  await allLoaded(page);
  await expect(cardFor(page, TOKEN)).toHaveCount(0);
  await page.waitForTimeout(4000);
  await expect(page.locator("#heroCard")).toBeHidden();
  await page.click("#barSearch");
  await expect(page.locator("#cbSscope")).toContainText("Searches all", { timeout: 20_000 });
  await page.fill("#cbSq", TOKEN.slice(0, 10));
  await expect(page.locator(`#cbSresults .cbHit[data-token="${TOKEN}" i]`)).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.goto("/token/" + STATE.token);
  await expect(page.locator("#tvHidden")).toContainText("Curb no longer lists this launch", { timeout: 30_000 });
});

test("with nothing hidden, the same launch is on the grid, in the hero and in the search, and its page says nothing", async ({ page }) => {
  await useConfig(page, {});
  await page.goto("/");
  await allLoaded(page);
  await expect(cardFor(page, TOKEN)).toHaveCount(1);
  await expect(page.locator("#heroCard")).toHaveAttribute("data-token", TOKEN, { timeout: 20_000 });
  await expect(page.locator("#cbBanner")).toHaveCount(0);
  await page.click("#barSearch");
  await expect(page.locator("#cbSscope")).toContainText("Searches all", { timeout: 20_000 });
  await page.fill("#cbSq", TOKEN.slice(0, 10));
  await expect(page.locator(`#cbSresults .cbHit[data-token="${TOKEN}" i]`)).toHaveCount(1);
  await page.keyboard.press("Escape");
  await page.goto("/token/" + STATE.token);
  await expect(page.locator("#tvStatus")).not.toHaveText("—", { timeout: 30_000 });
  await page.waitForTimeout(1000);
  await expect(page.locator("#tvHidden")).toHaveCount(0);
});

// ================================================================== item 43
test("Holder fees moves the wallet to the page's network on a press, through the bar's one switch", async ({ page }) => {
  // A WALLET ON ANOTHER NETWORK, which does not know Base yet.
  await useWallet(page, { chainId: "0x1", knownChains: ["0x1"] });
  await useConfig(page, {});
  await page.goto("/sharing");
  await expect(page.locator("#siteBar .cbInner")).toBeVisible({ timeout: 15_000 });
  expect(await page.evaluate(() => typeof window.CurbBar.switchChain)).toBe("function");
  // The claim's own refusal writes this button into the notice; the press is what is tested.
  await page.evaluate(() => {
    const m = document.getElementById("msg");
    m.hidden = false;
    m.innerHTML = '<button type="button" data-switch-chain="0x2105">Switch the wallet to Base</button>';
  });
  await page.locator('#msg button[data-switch-chain="0x2105"]').click();
  await expect(page.locator("#msg")).toContainText("The wallet is on Base now", { timeout: 10_000 });
  const w = await page.evaluate(() => ({ chain: window.ethereum.cfg.chainId, switches: window.ethereum.switches, added: window.ethereum.added }));
  expect(w.chain).toBe("0x2105");
  expect(w.switches).toContain("0x2105");
  expect(w.added.map((n) => n.chainId)).toEqual(["0x2105"]);
  expect(w.added[0].rpcUrls).toEqual(["https://mainnet.base.org"]);
  expect(w.added[0].blockExplorerUrls).toEqual(["https://basescan.org"]);
});

// ================================================================== the settings panel in production
// ONCE config.js NAMES A LENS, NOBODY SEES OR EDITS THE ENDPOINT AND THE
// CONTRACTS on app.html, a link naming others included: the panel is "Your
// fees", shown only to a wallet owed something, and the create form starts
// empty. Without a lens - a fork, every other suite - both are as they were.
const WETH = "0x4200000000000000000000000000000000000006";
/// The panel's parts that are config.js's and the bar's, never "Your fees".
const SETUP = ["rpc", "factory", "lens", "token", "connect", "refresh", "wallet", "quoteAddr", "quoteBal", "policyRow"];
/// THE OWED RENDER HAS LANDED for the connected wallet: the box drawn, zeros
/// included, and no render still out - so the panel is showing its answer.
async function owedDrawn(page) {
  await expect.poll(() => page.evaluate(() => {
    const s = window.CurbApp.state;
    return !!s.account && s.owedPending === 0 && !document.getElementById("owedBox").hidden;
  }), { timeout: 30_000, message: "the owed box was never drawn" }).toBe(true);
}

test("in production the create form's name and symbol start empty, on their placeholders", async ({ page }) => {
  await useConfig(page, {});
  await page.goto("/app.html");
  await page.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
  await expect(page.locator("#nName")).toHaveValue("");
  await expect(page.locator("#nSymbol")).toHaveValue("");
  await expect(page.locator("#nName")).toHaveAttribute("placeholder", "e.g. Na'vidia");
  await expect(page.locator("#nSymbol")).toHaveAttribute("placeholder", "e.g. NAVIDIA");
  await expect(page.locator("#sumName")).toHaveText("Your token");
});

test("in production a wallet owed nothing gets no settings panel, and a link naming another deployment does not bring it back", async ({ page }) => {
  test.setTimeout(120_000);
  await useConfig(page, await appSite());
  await routeEndpoint(page, OTHER_ENDPOINT, () => undefined);
  const who = await freshAccount("owed nothing");
  await useWallet(page, { account: who });
  await page.goto("/app.html");
  await page.evaluate(() => window.CurbApp.connect());
  await owedDrawn(page);
  await expect(page.locator("#wherePanel")).toBeHidden();
  // ANOTHER ENDPOINT AND ANOTHER LENS: read as before, and still no panel.
  await page.goto("/app.html?" + new URLSearchParams({ rpc: OTHER_ENDPOINT, lens: STATE.lens, factory: STATE.other.factory }).toString());
  await expect(page.locator("#cbEndpoint")).toContainText("other-endpoint.test:8701");
  await page.evaluate(() => window.CurbApp.connect());
  await owedDrawn(page);
  await expect(page.locator("#wherePanel")).toBeHidden();
  for (const id of SETUP) await expect(page.locator("#" + id), "#" + id + " is shown in production").toBeHidden();
});

test("in production a creator who is owed gets the panel as \"Your fees\", open with nothing else in it, and claims through it", async ({ page }) => {
  test.setTimeout(240_000);
  await useConfig(page, await appSite());
  const who = await freshAccount("owed fees");
  await useWallet(page, { account: who });
  await page.goto("/app.html");
  await page.evaluate(() => window.CurbApp.connect());
  await expect.poll(() => page.evaluate(() => ((window.CurbApp.state.ctx || {}).quote || "").toLowerCase()), { timeout: 30_000 })
    .toBe(WETH);
  // A LAUNCH WITH A DEV BUY: the creator tax it pays waits on the curve, the creator's to sweep.
  await page.fill("#nName", "Owed Fees");
  await page.fill("#nSymbol", "OWED");
  await page.fill("#nDevBuy", "0.01");
  await page.click("#create");
  await expect(page.locator("#msg")).toContainText("Launched", { timeout: 90_000 });
  const { token, factory } = await page.evaluate(() => window.CurbApp.state.chainCfg);
  const curve = addrOf(await ethCall(await registryOf(STATE.app.lens), sel("launchOf(address)") + word(BigInt(token))));
  const onCurve = async () => BigInt(await ethCall(curve, sel("creatorTaxBalance()")));
  expect(await onCurve(), "the dev buy left no creator fee on the curve").toBeGreaterThan(0n);

  const panel = page.locator("#wherePanel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel.locator("summary")).toHaveText("Your fees");
  expect(await panelOpen(page), "the fees panel showed closed").toBe(true);
  for (const id of SETUP) await expect(page.locator("#" + id), "#" + id + " is shown in production").toBeHidden();
  await expect(page.locator("#owedCurveRow")).toBeVisible();

  // CLAIM EVERYTHING: swept from the curve, then paid out of the escrow.
  const escrow = addrOf(await ethCall(factory, sel("feeEscrow()")));
  const inEscrow = async () =>
    BigInt(await ethCall(escrow, sel("balanceOfToken(address,address)") + word(BigInt(who)) + word(BigInt(WETH))));
  const sent = await sentCount(page);
  await page.click("#claimAll");
  await expect(page.locator("#msg")).toContainText("with this launch's curve fees swept in first", { timeout: 90_000 });
  expect(await sentCount(page), "the claim sent nothing").toBeGreaterThan(sent);
  expect(await onCurve(), "the curve still holds the creator's fee").toBe(0n);
  expect(await inEscrow(), "the escrow still holds the creator's fee").toBe(0n);
  // OWED NOTHING NOW, SO NO PANEL.
  await expect(panel).toBeHidden({ timeout: 30_000 });
});

test("with no lens in config.js (a fork, the other suites) the settings panel and the create form are as they were", async ({ page }) => {
  const who = await freshAccount("fork panel");
  await useWallet(page, { account: who });
  await page.goto("/app.html?" + new URLSearchParams({ rpc: STATE.rpc, lens: STATE.app.lens, factory: STATE.app.factory }).toString());
  await page.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
  await expect(page.locator("#nName")).toHaveValue("Curb Demo");
  await expect(page.locator("#nSymbol")).toHaveValue("DEMO");
  await expect(page.locator("#wherePanel > summary")).toHaveText(/^Network and contracts\s*advanced$/);
  await page.evaluate(() => window.CurbApp.connect());
  await owedDrawn(page);
  // OWED NOTHING, AND THE WHOLE PANEL STILL THERE, open for the link.
  for (const id of [...SETUP, "owedBox"]) await expect(page.locator("#" + id), "#" + id + " is hidden on a fork").toBeVisible();
});

// ================================================================== warming
/// A TOKEN'S PAGE SHOWS THE SAME WITH ITS READS WARMED AS WITHOUT (multicall.js):
/// on a first visit, where planToken asks what config.js and the path say
/// before the page's scripts run, and on the next, where the reads the first
/// visit noted are asked again - against the same page with multicall.js
/// served empty, which warms nothing and gathers nothing. The other suites
/// never see a warm answer: a link names their endpoint, and their config.js
/// names none (serve.js testConfig).
test("a token's page shows the same with its reads warmed as without, on a first visit and on the next", async ({ browser }) => {
  test.setTimeout(240_000);
  const config = await standIn();
  const wallet = [STUB, ";(function () {",
    "  window.ethereum = window.makeWallet(" + JSON.stringify(STATE.rpc) + ", " +
      JSON.stringify({ forward: true, chainId: "0x2105", account: TRADER, connected: true }) + ");",
    "})();"].join("\n");
  const context = async (warm) => {
    const ctx = await browser.newContext();
    await ctx.route(/\/config\.js(\?.*)?$/, (route) =>
      route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: config }));
    if (!warm) await ctx.route(/\/multicall\.js(\?.*)?$/, (route) =>
      route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: "/* nothing warmed or gathered */" }));
    await ctx.addInitScript({ content: wallet });
    return ctx;
  };
  // WHAT THE PAGE SHOWS once its history is in, the clock's words taken out.
  const visit = async (ctx, after = 0) => {
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const asked = [];
    page.on("request", (r) => { if (r.method() === "POST" && r.url().startsWith(STATE.rpc)) asked.push(r.postData() || ""); });
    await page.goto("/token/" + TOKEN);
    await expect(page.locator("#tvStatus")).not.toHaveText("—", { timeout: 30_000 });
    await expect(page.locator("#tvTradeCount")).toHaveText(/^\d+$/, { timeout: 60_000 });
    await page.waitForTimeout(4000);
    const text = (css) => page.locator(css).first().innerText().then((t) => t.replace(/\s+/g, " ").trim()).catch(() => null);
    const shown = {};
    for (const css of ["#tvStatus", "#tvPrice", "#tvMcap", "#tvTradeCount", "#tvEarned", "#tvHistNote", ".tvSwap", "#tvFees", ".tvAbout", "#tvList"]) {
      shown[css] = await text(css);
    }
    await page.click("#tvTabHolders");
    await page.waitForTimeout(800);
    shown.holders = await text("#tvList");
    await page.waitForTimeout(after);
    const notes = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem("curb.warm.v1") || "{}"); } catch { return {}; } });
    // HOW MANY WARM ANSWERS THE PAGE TOOK (multicall.js taken; none without it).
    const served = await page.evaluate(() => (window.CurbMulti && window.CurbMulti.taken ? window.CurbMulti.taken() : 0));
    await page.close();
    const clean = JSON.parse(JSON.stringify(shown).replace(/\b\d+(\.\d+)?[smhd]\b|\bnow\b/g, ""));
    return { shown: clean, errors, asked, notes, served };
  };
  // THE CALLS INSIDE THE FIRST aggregate3 A VISIT SENT, as "to|data": multicall.js
  // sends its warming round before the page's scripts can gather anything.
  const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
  const firstRound = (asked) => {
    for (const raw of asked) {
      let body;
      try { body = JSON.parse(raw); } catch { continue; }
      for (const m of [].concat(body)) {
        const p = m && m.method === "eth_call" && m.params && m.params[0];
        if (!p || String(p.to).toLowerCase() !== MULTICALL3) continue;
        const h = String(p.data).slice(10);
        const at = (b) => parseInt(h.slice(b * 2, b * 2 + 64), 16);
        const arr = at(0), n = at(arr), base = arr + 32, out = [];
        for (let i = 0; i < n; i++) {
          const t = base + at(base + 32 * i);
          const to = "0x" + h.slice(t * 2 + 24, t * 2 + 64);
          const b = t + at(t + 64);
          out.push((to + "|0x" + h.slice((b + 32) * 2, (b + 32 + at(b)) * 2)).toLowerCase());
        }
        return out;
      }
    }
    return [];
  };

  const off = await context(false);
  const cold = await visit(off);
  await off.close();
  expect(cold.errors, "the page threw without multicall.js").toEqual([]);
  expect(cold.served, "a page without multicall.js took a warm answer").toBe(0);

  const on = await context(true);
  // PAST NOTE_MS (15 s), so the first visit's reads are kept for the next.
  const first = await visit(on, 16_000);
  expect(first.errors, "the page threw with its reads warmed").toEqual([]);
  // THE WARMING WAS ASKED: the first round named the registry's record of this
  // launch (planToken) - and the page TOOK warm answers, so what it showed was
  // drawn from them.
  const launchOf = (sel("launchOf(address)") + word(BigInt(TOKEN))).toLowerCase();
  const planned = firstRound(first.asked);
  expect(planned.some((c) => c.endsWith("|" + launchOf)), "the first round did not name the launch's record").toBe(true);
  expect(first.served, "the first visit took no warm answer, so this proves nothing").toBeGreaterThan(0);
  expect(first.shown, "a first visit, warmed, shows something else").toEqual(cold.shown);
  const noted = first.notes["/token/" + TOKEN];
  expect(noted && Array.isArray(noted.calls) && noted.calls.length > 0, "the first visit's reads were not kept for the next").toBe(true);

  const second = await visit(on);
  expect(second.errors, "the next visit threw").toEqual([]);
  // THE NOTED READS WERE ASKED AGAIN, FIRST: the next visit's first round holds
  // a read the first visit noted that the plan alone does not ask.
  const replayed = firstRound(second.asked);
  expect(replayed.some((c) => !planned.includes(c) && noted.calls.includes(c)),
    "the next visit's first round asked none of the reads the first visit noted beyond the plan").toBe(true);
  expect(second.served, "the next visit took no warm answer").toBeGreaterThan(0);
  expect(second.shown, "the next visit, its noted reads warmed, shows something else").toEqual(cold.shown);
  await on.close();
});
