// WHICH WALLET THE SITE TALKS TO: the site bar's wallet picker (EIP-6963) and
// WalletConnect's phone wallets (topbar.js "the wallets", walletconnect.js).
//
// A browser with two wallets used to be connected through whichever wrote
// window.ethereum last. These tests announce several stub wallets the way
// extensions announce themselves (fake-wallets.js) and read, wallet by wallet,
// what each page asked of each: a wallet the person did not pick must be asked
// NOTHING - not even the silent eth_accounts - and a send must reach only the
// one they picked. Every other suite runs the single-wallet path (window.ethereum
// and no announcement), which is how site.spec.js and the rest prove that path
// is unchanged.
//
// WalletConnect is tested against a stand-in for its SDK served at the
// vendored file's path, so nothing here reaches Reown's network.
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { testConfig } = require("./serve.js");
const {
  walletsScript, uuid, logs, clearLogs, WC_URI, PROJECT_ID, wcSession, useFakeWalletConnect, isWalletConnect,
} = require("./fake-wallets.js");

const STATE = JSON.parse(fs.readFileSync(path.join(__dirname, ".state.json"), "utf8"));
const WEB = path.join(__dirname, "..");
const APP = STATE.app;
// anvil's second, third and fourth accounts: the node signs for each.
const TRADER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const OTHER = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
const THIRD = "0x90f79bf6eb2c4f870365e785982e1f101e93b906";
const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);

// Both already allowed this site, so either would answer eth_accounts with an
// account if it were asked - which is what makes "asked nothing" mean something.
const A = { id: "A", uuid: uuid("1"), rdns: "com.alpha.wallet", name: "Alpha Wallet", account: THIRD, connected: true };
const B = { id: "B", uuid: uuid("2"), rdns: "com.beta.wallet", name: "Beta Wallet", account: OTHER, connected: true };
const LEGACY = { id: "eth", account: TRADER, connected: true };
const appUrl = "/app.html?" + new URLSearchParams({ rpc: STATE.rpc, factory: APP.factory, lens: APP.lens }).toString();

async function barReady(page) {
  await page.waitForSelector("#siteBar .cbInner", { timeout: 10_000 });
}
/// Long enough for the load to settle (DOMContentLoaded + 150 ms, a second at most).
const settle = (page) => page.waitForTimeout(1300);
const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("curb.site.v1") || "{}"));
const picker = (page) => page.locator("#siteBar .cbPick");
const rows = (page) => page.locator("#siteBar .cbPick .cbPickRow");

/// web/config.js naming a deployment - this run's waiting stack and node - with
/// `over` on top; the WalletConnect id unless `over` says otherwise.
async function useSite(page, over = {}) {
  const site = { chainId: 8453, rpc: STATE.rpc, logsRpc: "", logsBlocks: 0, lens: STATE.lens, registry: "", factories: [],
    explorer: "https://basescan.org", featured: [], banner: "", hiddenFactories: [], hiddenLaunches: [],
    walletConnectProjectId: PROJECT_ID, ...over };
  const body = "window.CURB_SITE = " + JSON.stringify(site) + ";";
  await page.route(/\/config\.js(\?.*)?$/, (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body }));
}
/// Every request the page makes that is WalletConnect's, from now on.
function wcRequests(page) {
  const seen = [];
  page.on("request", (r) => { if (isWalletConnect(r.url())) seen.push(r.url()); });
  return seen;
}

// ================================================================== EIP-6963
test("with several wallets and none remembered nothing is asked until the person picks, and then only the one picked", async ({ page }) => {
  await page.addInitScript({ content: walletsScript({ rpc: STATE.rpc, list: [A, B], legacy: LEGACY }) });
  await page.goto("/curb.html");
  await barReady(page);
  await settle(page);
  await expect(page.locator("#barConnect")).toHaveText("Connect wallet");
  expect(await logs(page), "a wallet was asked something before the person picked one").toEqual({});

  await page.click("#barConnect");
  await expect(picker(page)).toBeVisible();
  await expect(picker(page)).toHaveAttribute("aria-label", "Choose a wallet");
  // ONE ROW PER WALLET THAT ANNOUNCED - window.ethereum is one of them, not a third.
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).nth(0).locator(".cbPickName")).toHaveText("Alpha Wallet");
  await expect(rows(page).nth(0).locator(".cbPickId")).toHaveText("com.alpha.wallet");
  await expect(rows(page).nth(1).locator(".cbPickName")).toHaveText("Beta Wallet");
  await expect(rows(page).nth(1).locator(".cbPickId")).toHaveText("com.beta.wallet");
  await expect(rows(page).nth(0)).toBeFocused();
  // ESCAPE AND A PRESS OUTSIDE CLOSE IT, choosing nothing.
  await page.keyboard.press("Escape");
  await expect(picker(page)).toBeHidden();
  await page.click("#barConnect");
  await expect(picker(page)).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(picker(page)).toBeHidden();
  expect(await logs(page)).toEqual({});

  await page.click("#barConnect");
  await rows(page).nth(1).click();
  await expect(picker(page)).toBeHidden();
  await expect(page.locator("#barConnect")).toContainText(short(OTHER));
  let asked = await logs(page);
  expect(asked.B, "the picked wallet was not asked to connect").toContain("eth_requestAccounts");
  expect(asked.A, "a wallet nobody picked was asked").toBeUndefined();
  expect(asked.eth, "window.ethereum was asked").toBeUndefined();
  expect((await stored(page)).wallet).toBe("6963:com.beta.wallet");

  // THE NEXT PAGE ASKS THE SAME WALLET, SILENTLY, AND NO OTHER.
  await clearLogs(page);
  await page.goto("/docs.html");
  await barReady(page);
  await expect(page.locator("#barConnect")).toContainText(short(OTHER), { timeout: 10_000 });
  asked = await logs(page);
  expect(asked.B).toContain("eth_accounts");
  expect(asked.B).not.toContain("eth_requestAccounts");
  expect(asked.A).toBeUndefined();
  expect(asked.eth).toBeUndefined();
});

test("an announced name and icon are drawn inertly: the name as text, only a data:image icon, nothing fetched", async ({ page }) => {
  let evil = 0;
  await page.route(/^https?:\/\/evil\.example\//, (route) => { evil += 1; return route.fulfill({ status: 404, body: "" }); });
  const svg = "data:image/svg+xml;base64," + Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#0a0"/></svg>').toString("base64");
  const list = [
    { id: "X1", uuid: uuid("3"), rdns: "com.x1.wallet", name: "<img src=x onerror=window.__pwned=1>", icon: "https://evil.example/x.png", account: THIRD },
    { id: "X2", uuid: uuid("4"), rdns: "com.x2.wallet", name: "Gam\u202ema\u0007  \n wallet", icon: "javascript:alert(1)", account: THIRD },
    { id: "X3", uuid: uuid("5"), rdns: "com.x3.wallet", name: "Delta", icon: "data:text/html,<script>window.__pwned=1</script>", account: THIRD },
    { id: "X4", uuid: uuid("6"), rdns: "com.x4.wallet", name: "Svg Wallet", icon: svg, account: THIRD },
    // THE SAME uuid AGAIN: the first one keeps it.
    { id: "X5", uuid: uuid("6"), rdns: "com.copycat.wallet", name: "Copycat", icon: svg, account: THIRD },
  ];
  // ANNOUNCEMENTS NO WALLET SHOULD MAKE, each answering every request.
  const malformed = function () {
    var good = { request: function () { return Promise.resolve(null); }, on: function () {}, removeListener: function () {} };
    var all = [
      { info: { uuid: "77777777-7777-4777-8777-777777777777", name: "No request", rdns: "com.norequest.wallet" }, provider: {} },
      { info: "not an object", provider: good },
      { info: { uuid: "not-a-uuid", name: "Bad uuid", rdns: "com.baduuid.wallet" }, provider: good },
      { info: { uuid: "88888888-8888-4888-8888-888888888888", name: "Bad rdns", rdns: "evil" }, provider: good },
      { info: { uuid: "99999999-9999-4999-8999-999999999999", name: " \u202e\u0000 ", rdns: "com.noname.wallet" }, provider: good },
      { info: { uuid: "66666666-6666-4666-8666-666666666666", name: "Node", rdns: "com.node.wallet" }, provider: document },
      null,
      "a string",
    ];
    window.addEventListener("eip6963:requestProvider", function () {
      all.forEach(function (d) { window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: d })); });
    });
  };
  await page.addInitScript({ content: walletsScript({ rpc: STATE.rpc, list }, malformed) });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/docs.html");
  await barReady(page);
  await page.click("#barConnect");
  await expect(picker(page)).toBeVisible();
  await expect(rows(page)).toHaveCount(4);
  expect(await rows(page).locator(".cbPickName").allTextContents()).toEqual(
    ["<img src=x onerror=window.__pwned=1>", "Gamma wallet", "Delta", "Svg Wallet"]);
  // THE NAME IS TEXT: nothing in its line is an element.
  expect(await page.locator("#siteBar .cbPickName").evaluateAll((ns) => ns.reduce((n, x) => n + x.children.length, 0))).toBe(0);
  // ONE PICTURE, THE ONE data:image ICON; the rest drawn as letters.
  const imgs = picker(page).locator("img");
  await expect(imgs).toHaveCount(1);
  expect(await imgs.first().getAttribute("src")).toMatch(/^data:image\/svg\+xml;base64,/);
  expect(await picker(page).evaluate((p) => p.querySelectorAll("script, iframe, object, embed, a").length)).toBe(0);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__pwned), "an announced name or icon ran").toBeUndefined();
  expect(evil, "an announced icon was fetched").toBe(0);
  expect(errors).toEqual([]);
});

test("a remembered id announced twice is chosen for neither: nothing is asked, and the picker says why", async ({ page }) => {
  const twin = { ...B, id: "B2", uuid: uuid("7"), account: THIRD };
  await page.addInitScript({ content: walletsScript({ rpc: STATE.rpc, list: [A, B, twin], store: { wallet: "6963:com.beta.wallet" } }) });
  await page.goto("/curb.html");
  await barReady(page);
  await settle(page);
  await expect(page.locator("#barConnect")).toHaveText("Connect wallet");
  expect(await logs(page), "a wallet was asked something with its id announced twice").toEqual({});
  await page.click("#barConnect");
  await expect(picker(page)).toBeVisible();
  await expect(picker(page).locator(".cbPickWarn")).toContainText("com.beta.wallet");
  await expect(rows(page)).toHaveCount(3);
});

test("the remembered wallet announcing late is connected silently once it arrives", async ({ page }) => {
  await page.addInitScript({ content: walletsScript({ rpc: STATE.rpc, list: [A, { ...B, late: 400 }],
    store: { wallet: "6963:com.beta.wallet" } }) });
  await page.goto("/curb.html");
  await barReady(page);
  await expect(page.locator("#barConnect")).toContainText(short(OTHER), { timeout: 10_000 });
  const asked = await logs(page);
  expect(asked.B).toContain("eth_accounts");
  expect(asked.B).not.toContain("eth_requestAccounts");
  expect(asked.A, "the wallet not remembered was asked").toBeUndefined();
});

test("a remembered wallet missing this visit means no wallet is asked anything, and Connect opens the picker", async ({ page }) => {
  await page.addInitScript({ content: walletsScript({ rpc: STATE.rpc, list: [A, B], store: { wallet: "6963:com.gone.wallet" } }) });
  await page.goto("/curb.html");
  await barReady(page);
  await settle(page);
  await expect(page.locator("#barConnect")).toHaveText("Connect wallet");
  expect(await logs(page)).toEqual({});
  await page.click("#barConnect");
  await expect(rows(page)).toHaveCount(2);
  expect(await logs(page)).toEqual({});
});

test("Disconnect forgets the wallet chosen, and a pick the wallet declines is not remembered", async ({ page }) => {
  await page.addInitScript({ content: walletsScript({ rpc: STATE.rpc, list: [{ ...A, decline: true }, B],
    store: { wallet: "6963:com.beta.wallet" } }) });
  await page.goto("/curb.html");
  await barReady(page);
  await expect(page.locator("#barConnect")).toContainText(short(OTHER), { timeout: 10_000 });
  await page.click("#barConnect");
  await page.click("#siteBar .cbOut");
  await expect(page.locator("#barConnect")).toHaveText("Connect wallet");
  expect((await logs(page)).B).toContain("wallet_revokePermissions");
  let saved = await stored(page);
  expect(saved.wallet, "Disconnect kept the wallet's id").toBeUndefined();
  expect(saved.hidden).toBe(true);

  // THE NEXT CONNECT ASKS WHICH WALLET.
  await page.click("#barConnect");
  await expect(rows(page)).toHaveCount(2);
  // DECLINED: nothing remembered, nothing shown, and the next Connect asks again.
  await rows(page).nth(0).click();
  await expect(picker(page)).toBeHidden();
  await page.waitForTimeout(300);
  await expect(page.locator("#barConnect")).toHaveText("Connect wallet");
  expect((await logs(page)).A).toContain("eth_requestAccounts");
  saved = await stored(page);
  expect(saved.wallet, "a declined pick was remembered").toBeUndefined();
  expect(saved.hidden).toBe(true);
  await page.click("#barConnect");
  await expect(rows(page), "a declined pick stayed chosen").toHaveCount(2);
  await page.keyboard.press("Escape");

  // AND LOADED AGAIN, NOTHING IS ASKED.
  await clearLogs(page);
  await page.reload();
  await barReady(page);
  await settle(page);
  expect(await logs(page)).toEqual({});
});

test("on app.html only the wallet picked sends, and the picker is not opened while an action waits on the wallet", async ({ page }) => {
  // B signs as anvil's second account through the node; window.ethereum is the
  // same account, so a send that went to the wrong wallet would still succeed -
  // only the wallets' own records can tell.
  const list = [{ ...A, connected: false }, { ...B, account: TRADER, connected: false }];
  await page.addInitScript({ content: walletsScript({ rpc: STATE.rpc, list, legacy: LEGACY }) });
  await page.goto(appUrl);
  await page.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
  await settle(page);
  expect(await logs(page), "app.html asked a wallet nobody picked").toEqual({});

  // NOT WHILE THE PAGE'S OWN CONNECT IS DISABLED - an action is running then.
  await page.evaluate(() => { document.querySelector("main #connect").disabled = true; });
  await page.click("#barConnect");
  await page.waitForTimeout(400);
  await expect(picker(page), "the picker opened while an action waited on the wallet").toBeHidden();
  await page.evaluate(() => { document.querySelector("main #connect").disabled = false; });

  await page.click("main #connect");
  await expect(picker(page)).toBeVisible();
  await rows(page).nth(1).click();
  await expect(page.locator("#wallet")).toContainText(TRADER, { ignoreCase: true, timeout: 20_000 });
  await expect(page.locator("#barConnect")).toContainText(short(TRADER));
  await expect(page.locator("main #connect")).toBeEnabled({ timeout: 30_000 });

  const status = await page.evaluate(async (to) => {
    const app = window.CurbApp;
    const pin = await app.beginAction("claim");
    const receipt = await app.withSendLock(pin, () => app.send(pin, { to, value: "0x1" }, "a test transfer", "action"));
    return receipt && receipt.status;
  }, OTHER);
  expect(status).toBe("0x1");
  const sent = await page.evaluate(() => ({
    A: window.__wallets.A.sent.length, B: window.__wallets.B.sent.length, eth: window.ethereum.sent.length,
  }));
  expect(sent, "the send did not go to the picked wallet alone").toEqual({ A: 0, B: 1, eth: 0 });
  const asked = await logs(page);
  expect(asked.A).toBeUndefined();
  expect(asked.eth).toBeUndefined();
});

test("on launch.html the wallet picked is the only one complete() asks", async ({ page }) => {
  // B DECLINES THE SEND: nothing moves the waiting launch the other suites need.
  const list = [{ ...A, connected: false },
    { ...B, account: TRADER, connected: false, cfg: { sendError: { code: 4001, message: "declined in the test" } } }];
  await page.addInitScript({ content: walletsScript({ rpc: STATE.rpc, list, legacy: LEGACY }) });
  await page.goto("/launch.html");
  await page.waitForFunction(() => !!window.CurbLaunch, null, { timeout: 8_000 });
  await settle(page);
  expect(await logs(page)).toEqual({});
  await page.click("main #connect");
  await rows(page).nth(1).click();
  await expect(page.locator("#wallet")).toContainText("Connected:", { timeout: 20_000 });
  await page.evaluate(({ lens, token }) => {
    document.getElementById("lens").value = lens;
    document.getElementById("token").value = token;
    return window.CurbLaunch.complete();
  }, { lens: STATE.lens, token: STATE.token });
  await expect(page.locator("#msg")).toBeVisible({ timeout: 30_000 });
  const asked = await logs(page);
  expect(asked.B).toContain("eth_chainId");
  expect(asked.A).toBeUndefined();
  expect(asked.eth).toBeUndefined();
  expect(await page.evaluate(() => window.__wallets.B.sent.length + window.__wallets.A.sent.length + window.ethereum.sent.length)).toBe(0);
});

// ================================================================== WalletConnect
test("without a project id, or without a deployment, WalletConnect is not offered and nothing of it is fetched", async ({ browser }) => {
  // A DEPLOYMENT AND NO ID (config.js as committed).
  let page = await browser.newPage();
  let seen = wcRequests(page);
  await useSite(page, { walletConnectProjectId: "" });
  await page.addInitScript({ content: walletsScript({ rpc: STATE.rpc, list: [A, B] }) });
  for (const url of ["/curb.html", "/docs.html", "/app.html"]) {
    await page.goto(url);
    await barReady(page);
    await page.click("#barConnect");
    await expect(rows(page), url).toHaveCount(2);
    await expect(picker(page), url).not.toContainText("Phone wallet");
    await page.keyboard.press("Escape");
  }
  expect(seen, "something of WalletConnect's was requested").toEqual([]);
  await page.close();

  // AN ID AND NO DEPLOYMENT (no lens, no endpoint: the tests' own config.js).
  page = await browser.newPage();
  seen = wcRequests(page);
  const body = testConfig() + "\nwindow.CURB_SITE.walletConnectProjectId = " + JSON.stringify(PROJECT_ID) + ";\n";
  await page.route(/\/config\.js(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body }));
  await page.addInitScript({ content: walletsScript({ rpc: STATE.rpc, list: [A, B] }) });
  await page.goto("/curb.html");
  await barReady(page);
  await page.click("#barConnect");
  await expect(rows(page)).toHaveCount(2);
  await expect(picker(page)).not.toContainText("Phone wallet");
  expect(seen).toEqual([]);
  await page.close();
});

test("WalletConnect is fetched only on the pick, pairs through a code, and its adapter holds the session to the site's chain and endpoint", async ({ page }) => {
  const seen = wcRequests(page);
  await useSite(page);
  await useFakeWalletConnect(page);
  await page.addInitScript({ content: walletsScript({ rpc: STATE.rpc, list: [{ ...A, connected: false }] }) });
  const reads = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().startsWith(STATE.rpc)) reads.push(r.postData() || "");
  });
  await page.goto("/curb.html");
  await barReady(page);
  await settle(page);
  // ONE EXTENSION AND WALLETCONNECT ARE TWO CHOICES: none is made for the person.
  await expect(page.locator("#barConnect")).toHaveText("Connect wallet");
  await page.click("#barConnect");
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).nth(1)).toContainText("Phone wallet - WalletConnect");
  expect(seen, "WalletConnect was fetched before it was picked").toEqual([]);

  await rows(page).nth(1).click();
  const qr = page.locator("#siteBar canvas.cbWcQr");
  await expect(qr).toHaveCount(1, { timeout: 15_000 });
  await expect.poll(() => qr.evaluate((c) => c.width), { timeout: 10_000 }).toBeGreaterThan(20);
  expect(seen.some((u) => /\/walletconnect\.js$/.test(u))).toBe(true);
  expect(seen.some((u) => /universal-provider-[\d.]+\.umd\.js$/.test(u))).toBe(true);
  expect(seen.some((u) => /lean-qr-[\d.]+\/index\.mjs$/.test(u))).toBe(true);
  const wc = await page.evaluate(() => ({ inits: window.__wc.inits, connects: window.__wc.connects }));
  expect(wc.inits).toHaveLength(1);
  expect(wc.inits[0]).toMatchObject({ projectId: PROJECT_ID, relayUrl: "wss://relay.walletconnect.org", telemetryEnabled: false });
  expect(wc.inits[0].metadata.url).toBe(new URL(page.url()).origin);
  expect(wc.inits[0].metadata.redirect).toBeUndefined();
  expect(wc.connects[0].optionalNamespaces).toEqual({ eip155: {
    chains: ["eip155:8453"], methods: ["eth_sendTransaction", "wallet_switchEthereumChain"],
    events: ["accountsChanged", "chainChanged"], rpcMap: { 8453: STATE.rpc } } });

  // THE PHONE WALLETS' LINKS, from walletconnect.js's own list and nothing else.
  const src = fs.readFileSync(path.join(WEB, "walletconnect.js"), "utf8");
  const apps = [...src.matchAll(/\["([^"]+)", "(https:\/\/[^"]+)"\]/g)].map((m) => m[2]);
  expect(apps.length).toBeGreaterThan(0);
  const hrefs = await page.locator("#siteBar .cbWcApps a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  expect(hrefs).toEqual([...apps.map((root) => root + "/wc?uri=" + encodeURIComponent(WC_URI)), WC_URI]);
  // COPY LINK copies the URI.
  await page.evaluate(() => { navigator.clipboard.writeText = (t) => { window.__copied = t; return Promise.resolve(); }; });
  await page.locator("#siteBar .cbWc button", { hasText: "Copy link" }).click();
  expect(await page.evaluate(() => window.__copied)).toBe(WC_URI);

  // APPROVED: the bar shows the account, and the choice is remembered.
  await page.evaluate((s) => window.__wc.approve(s), wcSession(TRADER));
  await expect(picker(page)).toBeHidden();
  await expect(page.locator("#barConnect")).toContainText(short(TRADER));
  expect((await stored(page)).wallet).toBe("walletconnect");
  const r = await page.evaluate(async ({ other, me }) => {
    const w = window.CurbBar.wallet();
    const out = { kind: window.CurbBar.walletKind(), chain: await w.request({ method: "eth_chainId" }) };
    out.receipt = await w.request({ method: "eth_getTransactionReceipt", params: ["0x" + "11".repeat(32)] });
    out.code = await w.request({ method: "eth_getCode", params: [me, "latest"] });
    try { await w.request({ method: "eth_sendTransaction", params: [{ from: other, to: me, value: "0x1" }] }); out.foreign = "sent"; }
    catch (e) { out.foreign = e.code; }
    try { await w.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x1" }] }); out.switch = "moved"; }
    catch (e) { out.switch = e.code; }
    out.same = await w.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x2105" }] });
    out.asked = window.__wc.requests.map((q) => q.method);
    return out;
  }, { other: OTHER, me: TRADER });
  // A STRING, though the SDK answers the number 8453.
  expect(r.kind).toBe("walletconnect");
  expect(r.chain).toBe("0x2105");
  expect(r.receipt).toBeNull();
  expect(r.foreign, "a send from another account was not refused").toBe(4100);
  expect(r.switch).toBe(4901);
  expect(r.same).toBeNull();
  expect(r.asked, "the adapter went to the relay for a read or a refused send").toEqual([]);
  expect(reads.some((b) => b.includes("eth_getTransactionReceipt")), "the receipt was not read from config.js's rpc").toBe(true);
  expect(reads.some((b) => b.includes("eth_getCode"))).toBe(true);

  // DISCONNECT ENDS THE SESSION.
  await page.click("#barConnect");
  await page.click("#siteBar .cbOut");
  await expect(page.locator("#barConnect")).toHaveText("Connect wallet");
  expect(await page.evaluate(() => window.__wc.disconnects)).toBe(1);
  expect((await stored(page)).wallet).toBeUndefined();
});

test("a WalletConnect session is restored at load, app.html follows it, a decline reads as nothing sent, and an ended session disconnects", async ({ page }) => {
  await useSite(page);
  await useFakeWalletConnect(page);
  await page.addInitScript({ content: walletsScript({ rpc: STATE.rpc, list: [], store: { wallet: "walletconnect" } },
    new Function("window.__wc = { restore: " + JSON.stringify(wcSession(TRADER)) + " };")) });
  await page.goto("/app.html");
  await barReady(page);
  await expect(page.locator("#barConnect")).toContainText(short(TRADER), { timeout: 15_000 });
  await expect(page.locator("#wallet"), "app.html did not follow the restored session").toContainText(TRADER, { ignoreCase: true, timeout: 15_000 });

  // A DECLINE OVER WALLETCONNECT (the SDK's 5000) IS A DECLINE; ANY OTHER ERROR IS UNCERTAIN.
  const said = await page.evaluate(async () => {
    const app = window.CurbApp;
    const cfg = app.state.chainCfg;
    const eth = window.CurbBar.wallet();
    const pin = { eth, scope: "claim", from: app.state.account, chainId: "0x2105", rpc: cfg.rpc, lens: cfg.lens,
      token: cfg.token, factory: cfg.factory, read: (m, p) => eth.request({ method: m, params: p }) };
    const out = {};
    for (const [k, err] of [["declined", { code: 5000, message: "User rejected." }], ["failed", { code: -32000, message: "relay gone" }]]) {
      window.__wc.answer = () => Promise.reject(err);
      try { await app.send(pin, { to: pin.from, value: "0x1" }, "a test transfer", "action"); out[k] = "sent"; }
      catch (e) { out[k] = e.message; }
    }
    return out;
  });
  expect(said.declined).toContain("Nothing was sent: you declined");
  expect(said.failed).toContain("IT IS NOT CERTAIN NOTHING WAS BROADCAST");
  expect(await page.evaluate(() => window.__wc.requests.filter((q) => q.method === "eth_sendTransaction").map((q) => q.chain)))
    .toEqual(["eip155:8453", "eip155:8453"]);

  // THE PHONE ENDS THE SESSION: the bar and the page let go of the account.
  await page.evaluate(() => window.__wc.up.emit("session_delete", { topic: "topic-1" }));
  await expect(page.locator("#barConnect")).toHaveText("Connect wallet");
  await expect(page.locator("#wallet")).not.toContainText("Connected:");
  expect((await stored(page)).wallet).toBeUndefined();
  expect(await page.evaluate(() => window.CurbBar.wallet())).toBeNull();
  // NOR IS IT TAKEN UP AGAIN, though the SDK still holds it: Connect pairs anew.
  await page.click("#barConnect");
  await expect(page.locator("#siteBar canvas.cbWcQr")).toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator("#barConnect")).toHaveText("Connect wallet");
});

test("WalletConnect runs in one tab at a time: a second tab waits, says so, and starts nothing", async ({ context }) => {
  const setup = async (p) => {
    await useSite(p);
    await useFakeWalletConnect(p);
    await p.addInitScript({ content: walletsScript({ rpc: STATE.rpc, list: [], store: { wallet: "walletconnect" } },
      new Function("window.__wc = { restore: " + JSON.stringify(wcSession(TRADER)) + " };")) });
  };
  const first = await context.newPage();
  await setup(first);
  await first.goto("/docs.html");
  await expect(first.locator("#barConnect")).toContainText(short(TRADER), { timeout: 15_000 });

  const second = await context.newPage();
  await setup(second);
  const seen = wcRequests(second);
  await second.goto("/docs.html");
  await barReady(second);
  await expect(second.locator("#siteBar .cbNote")).toContainText("WalletConnect is open in another tab of this site", { timeout: 15_000 });
  expect(await second.evaluate(() => window.__wc.inits || [])).toEqual([]);
  expect(seen.some((u) => /universal-provider/.test(u)), "the second tab fetched the SDK").toBe(false);
  await expect(second.locator("#barConnect")).toHaveText("Connect wallet");

  // THE FIRST TAB CLOSED, THE SECOND TAKES OVER.
  await first.close();
  await expect(second.locator("#barConnect")).toContainText(short(TRADER), { timeout: 15_000 });
});

test("at a phone's width the picker and the WalletConnect panel stay inside the screen, the wallets' links first", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 800 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await useSite(page);
  await useFakeWalletConnect(page);
  await page.addInitScript({ content: walletsScript({ rpc: STATE.rpc, list: [A, B] }) });
  await page.goto("/curb.html");
  await barReady(page);
  const over = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await page.click("#barConnect");
  await expect(rows(page)).toHaveCount(3);
  expect(await over(), "the picker takes the page sideways").toBeLessThanOrEqual(0);
  const box = await picker(page).boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(375);
  await rows(page).nth(2).click();
  await expect(page.locator("#siteBar .cbWcApps a").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#siteBar .cbWcApps a").last()).toHaveText("Other wallet");
  expect(await over(), "the WalletConnect panel takes the page sideways").toBeLessThanOrEqual(0);
  // THE LINKS COME BEFORE THE CODE on a touch screen.
  const order = await page.evaluate(() => {
    const apps = document.querySelector("#siteBar .cbWcApps"), qr = document.querySelector("#siteBar .cbWcQr");
    return apps.compareDocumentPosition(qr) & Node.DOCUMENT_POSITION_FOLLOWING ? "links first" : "code first";
  });
  expect(order).toBe("links first");
  await context.close();
});

// ================================================================== the vendored files
test("every vendored file is the one its README records, and the adapter loads the UniversalProvider by its hash", async () => {
  const vendor = path.join(WEB, "vendor");
  const readme = fs.readFileSync(path.join(vendor, "README.txt"), "utf8");
  const recorded = new Map([...readme.matchAll(/^ {2}([0-9a-f]{64}) {2}(\S+)\r?$/gm)].map((m) => [m[2], m[1]]));
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else files.push(path.relative(vendor, p).split(path.sep).join("/"));
    }
  };
  walk(vendor);
  const shipped = files.filter((f) => f !== "README.txt").sort();
  expect(shipped, "a file in web/vendor/ that README.txt does not record, or one it records that is gone")
    .toEqual([...recorded.keys()].sort());
  for (const f of shipped) {
    const h = crypto.createHash("sha256").update(fs.readFileSync(path.join(vendor, f))).digest("hex");
    expect(h, f + " is not the file README.txt records").toBe(recorded.get(f));
  }
  const adapter = fs.readFileSync(path.join(WEB, "walletconnect.js"), "utf8");
  const umd = /const UMD = "([^"]+)";/.exec(adapter)[1];
  const sri = /const UMD_SRI = "([^"]+)";/.exec(adapter)[1];
  expect(shipped).toContain(umd.replace(/^vendor\//, ""));
  expect(sri).toBe("sha384-" + crypto.createHash("sha384").update(fs.readFileSync(path.join(WEB, umd))).digest("base64"));
  expect(readme).toContain(sri.replace(/^sha384-/, ""));
  // THE LICENCE IS PUBLISHED (it must ship with the code); the README is not.
  const ignored = fs.readFileSync(path.join(WEB, ".vercelignore"), "utf8").split(/\r?\n/).map((l) => l.trim());
  expect(ignored).toContain("/vendor/README.txt");
  expect(ignored.some((l) => l.startsWith("/vendor/") && l !== "/vendor/README.txt")).toBe(false);
  expect(fs.existsSync(path.join(vendor, "walletconnect", "LICENSE.md"))).toBe(true);
  expect(fs.readFileSync(path.join(WEB, "terms.html"), "utf8")).toContain("Portions © 2025 Reown, Inc. All Rights Reserved.");
});
