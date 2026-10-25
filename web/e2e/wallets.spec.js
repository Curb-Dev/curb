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
  IN_APP_UA, IN_APP_FLAGS,
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
const A = { id: "A", uuid: uuid("1"), rdns: "io.metamask", name: "MetaMask", account: THIRD, connected: true };
const B = { id: "B", uuid: uuid("2"), rdns: "io.rabby", name: "Rabby Wallet", account: OTHER, connected: true };
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
  await expect(rows(page).nth(0).locator(".cbPickName")).toHaveText("MetaMask");
  await expect(rows(page).nth(1).locator(".cbPickName")).toHaveText("Rabby Wallet");
  // A ROW IS ITS PICTURE AND ITS NAME, nothing under it.
  expect(await rows(page).evaluateAll((rs) => rs.map((r) => r.children.length))).toEqual([2, 2]);
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
  expect((await stored(page)).wallet).toBe("6963:io.rabby");

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

test("an announced name and icon are drawn inertly: the site's own name for the id, only a data:image icon, nothing fetched", async ({ page }) => {
  let evil = 0;
  await page.route(/^https?:\/\/evil\.example\//, (route) => { evil += 1; return route.fulfill({ status: 404, body: "" }); });
  const svg = "data:image/svg+xml;base64," + Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#0a0"/></svg>').toString("base64");
  const list = [
    { id: "X1", uuid: uuid("3"), rdns: "io.metamask", name: "<img src=x onerror=window.__pwned=1>", icon: "https://evil.example/x.png", account: THIRD },
    { id: "X2", uuid: uuid("4"), rdns: "IO.Rabby", name: "Gam\u202ema\u0007  \n wallet", icon: "javascript:alert(1)", account: THIRD },
    { id: "X3", uuid: uuid("5"), rdns: "com.coinbase.wallet", name: "MetaMask", icon: "data:text/html,<script>window.__pwned=1</script>", account: THIRD },
    { id: "X4", uuid: uuid("6"), rdns: "me.rainbow", name: "Svg Wallet", icon: svg, account: THIRD },
    // THE SAME uuid AGAIN: the first one keeps it.
    { id: "X5", uuid: uuid("6"), rdns: "com.trustwallet.app", name: "Copycat", icon: svg, account: THIRD },
  ];
  // ANNOUNCEMENTS NO WALLET SHOULD MAKE, each answering every request - under
  // listed ids, so it is the announcement that is refused, not the wallet.
  const malformed = function () {
    var good = { request: function () { return Promise.resolve(null); }, on: function () {}, removeListener: function () {} };
    var all = [
      { info: { uuid: "77777777-7777-4777-8777-777777777777", name: "No request", rdns: "com.okex.wallet" }, provider: {} },
      { info: "not an object", provider: good },
      { info: { uuid: "not-a-uuid", name: "Bad uuid", rdns: "io.zerion.wallet" }, provider: good },
      { info: { uuid: "88888888-8888-4888-8888-888888888888", name: "Bad rdns", rdns: "evil" }, provider: good },
      { info: { uuid: "66666666-6666-4666-8666-666666666666", name: "Node", rdns: "com.brave.wallet" }, provider: document },
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
  // EACH UNDER THE NAME THE SITE GIVES ITS ID, whatever it announced - a
  // wallet calling itself "MetaMask" is drawn as the wallet its id says.
  expect(await rows(page).locator(".cbPickName").allTextContents()).toEqual(
    ["MetaMask", "Rabby Wallet", "Coinbase Wallet", "Rainbow"]);
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

test("a wallet the site does not list is not drawn, is asked nothing, and window.ethereum is not offered in its place", async ({ page }) => {
  // MADE FOR ANOTHER CHAIN FIRST, each already allowing the site.
  const others = [
    { id: "P", uuid: uuid("8"), rdns: "app.phantom", name: "Phantom", account: THIRD, connected: true },
    { id: "K", uuid: uuid("9"), rdns: "app.keplr", name: "MetaMask", account: THIRD, connected: true },
  ];
  // REMEMBERED from before the list, too.
  await page.addInitScript({ content: walletsScript({ rpc: STATE.rpc, list: [others[0], A, others[1], B], legacy: LEGACY,
    store: { wallet: "6963:app.phantom" } }) });
  await page.goto("/curb.html");
  await barReady(page);
  await settle(page);
  expect(await logs(page), "a wallet was asked before the person picked one").toEqual({});
  await page.click("#barConnect");
  await expect(picker(page)).toBeVisible();
  expect(await rows(page).locator(".cbPickName").allTextContents()).toEqual(["MetaMask", "Rabby Wallet"]);
  await page.keyboard.press("Escape");

  // ONLY UNLISTED WALLETS: no picker, no "Browser wallet", and the note says why.
  const alone = await page.context().newPage();
  await alone.addInitScript({ content: walletsScript({ rpc: STATE.rpc, list: others, legacy: LEGACY }) });
  await alone.goto("/curb.html");
  await barReady(alone);
  await settle(alone);
  await alone.click("#barConnect");
  await expect(alone.locator("#siteBar .cbNote")).toContainText("This browser's wallets are not ones the site lists.");
  await expect(picker(alone)).toBeHidden();
  expect(await logs(alone), "a wallet the site does not list, or window.ethereum, was asked").toEqual({});
  await alone.close();
});

test("a remembered id announced twice is chosen for neither: nothing is asked, and the picker says why", async ({ page }) => {
  const twin = { ...B, id: "B2", uuid: uuid("7"), account: THIRD };
  await page.addInitScript({ content: walletsScript({ rpc: STATE.rpc, list: [A, B, twin], store: { wallet: "6963:io.rabby" } }) });
  await page.goto("/curb.html");
  await barReady(page);
  await settle(page);
  await expect(page.locator("#barConnect")).toHaveText("Connect wallet");
  expect(await logs(page), "a wallet was asked something with its id announced twice").toEqual({});
  await page.click("#barConnect");
  await expect(picker(page)).toBeVisible();
  await expect(picker(page).locator(".cbPickWarn")).toContainText("both say they are Rabby Wallet");
  await expect(rows(page)).toHaveCount(3);
});

test("two wallets with one id are both drawn, and the picker says so, with nothing remembered too", async ({ page }) => {
  const twin = { ...A, id: "A2", uuid: uuid("7"), account: OTHER };
  await page.addInitScript({ content: walletsScript({ rpc: STATE.rpc, list: [A, twin, B] }) });
  await page.goto("/curb.html");
  await barReady(page);
  await settle(page);
  await page.click("#barConnect");
  await expect(picker(page).locator(".cbPickWarn")).toContainText("both say they are MetaMask");
  expect(await rows(page).locator(".cbPickName").allTextContents()).toEqual(["MetaMask", "MetaMask", "Rabby Wallet"]);
});

test("the remembered wallet announcing late is connected silently once it arrives", async ({ page }) => {
  await page.addInitScript({ content: walletsScript({ rpc: STATE.rpc, list: [A, { ...B, late: 400 }],
    store: { wallet: "6963:io.rabby" } }) });
  await page.goto("/curb.html");
  await barReady(page);
  await expect(page.locator("#barConnect")).toContainText(short(OTHER), { timeout: 10_000 });
  const asked = await logs(page);
  expect(asked.B).toContain("eth_accounts");
  expect(asked.B).not.toContain("eth_requestAccounts");
  expect(asked.A, "the wallet not remembered was asked").toBeUndefined();
});

test("with phone wallets on, a lone wallet that already allowed the site is connected silently, one that did not is only asked, and Connect then offers both", async ({ browser }) => {
  // A RETURNING VISITOR (the wallet allowed the site before): connected at load,
  // with nothing requested - and the bar's network switch has a wallet to ask.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await useSite(page);
  await page.addInitScript({ content: walletsScript({ rpc: STATE.rpc, list: [A] }) });
  await page.goto("/curb.html");
  await barReady(page);
  await expect(page.locator("#barConnect")).toContainText(short(THIRD), { timeout: 10_000 });
  let asked = await logs(page);
  expect(asked.A).toContain("eth_accounts");
  expect(asked.A, "the returning visitor was prompted").not.toContain("eth_requestAccounts");
  expect(await page.evaluate(() => typeof window.CurbBar.switchChain)).toBe("function");
  await ctx.close();

  // A NEW VISITOR: the lone wallet is asked silently, says no, and stays unchosen,
  // so Connect opens the picker with it and the phone wallet - and nothing is requested before.
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  await useSite(page2);
  await page2.addInitScript({ content: walletsScript({ rpc: STATE.rpc, list: [{ ...A, connected: false }] }) });
  await page2.goto("/curb.html");
  await barReady(page2);
  await settle(page2);
  await expect(page2.locator("#barConnect")).toHaveText("Connect wallet");
  asked = await logs(page2);
  expect(asked.A || [], "the new visitor's wallet was prompted at load").not.toContain("eth_requestAccounts");
  await page2.click("#barConnect");
  await expect(rows(page2)).toHaveCount(2);
  await ctx2.close();
});

test("with phone wallets on, a network switch pressed while the lone wallet is still being asked waits for it, and is sent to it", async ({ page }) => {
  // A WALLET SLOW TO SAY IT ALLOWED THE SITE (an extension waking up): a press
  // in that second must not find "no wallet" - it waits for the load's choice.
  await useSite(page);
  await page.addInitScript({ content: walletsScript({ rpc: STATE.rpc,
    list: [{ ...A, cfg: { chainId: "0x1" }, slow: { eth_accounts: 2500 } }] }) });
  await page.goto("/curb.html");
  await barReady(page);
  const out = await page.evaluate(() => window.CurbBar.switchChain("0x2105").then(() => "switched", (e) => "refused: " + e.message));
  expect(out).toBe("switched");
  expect((await logs(page)).A).toContain("wallet_switchEthereumChain");
});

test("a remembered wallet missing this visit means no wallet is asked anything, and Connect opens the picker", async ({ page }) => {
  await page.addInitScript({ content: walletsScript({ rpc: STATE.rpc, list: [A, B], store: { wallet: "6963:me.rainbow" } }) });
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
    store: { wallet: "6963:io.rabby" } }) });
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

test("a remembered wallet that does not connect is let go: the next Connect opens the picker, in the bar, on app.html and on launch.html", async ({ page }) => {
  // A WAS CONNECTED LAST WEEK; TODAY IT IS LOCKED, OR NO LONGER ALLOWS THE SITE, AND THE PERSON WANTS B.
  const list = [{ ...A, connected: false, decline: true }, { ...B, connected: false }];
  await page.addInitScript({ content: walletsScript({ rpc: STATE.rpc, list, store: { wallet: "6963:io.metamask" } }) });
  const declinedThenPicker = async (connect, where) => {
    await settle(page);
    // THE REMEMBERED WALLET IS ASKED STRAIGHT AWAY, with no picker, and declines.
    await page.click(connect);
    await expect.poll(async () => (await logs(page)).A || [], { message: where }).toContain("eth_requestAccounts");
    await expect(picker(page)).toBeHidden();
    await expect.poll(async () => (await stored(page)).wallet, { message: where + ": the wallet that declined is still remembered" })
      .toBeUndefined();
    // THE NEXT CONNECT ASKS WHICH.
    await page.click(connect);
    await expect(picker(page), where + ": the remembered wallet still stands in the way").toBeVisible();
    await expect(rows(page)).toHaveCount(2);
  };

  await page.goto("/curb.html");
  await barReady(page);
  await declinedThenPicker("#barConnect", "curb.html");
  await rows(page).nth(1).click();
  await expect(page.locator("#barConnect")).toContainText(short(OTHER));
  expect((await stored(page)).wallet).toBe("6963:io.rabby");
  expect((await logs(page)).A.filter((m) => m === "eth_requestAccounts"), "A was asked again").toHaveLength(1);

  for (const [url, where] of [[appUrl, "app.html"], ["/launch.html", "launch.html"]]) {
    await page.evaluate(() => {
      localStorage.setItem("curb.site.v1", JSON.stringify({ wallet: "6963:io.metamask" }));
      sessionStorage.setItem("wallets.log", "{}");
    });
    await page.goto(url);
    await barReady(page);
    await declinedThenPicker("main #connect", where);
    await page.keyboard.press("Escape");
  }
});

test("a row pressed while the first wallet is still answering is the one that connects", async ({ page }) => {
  // A ANSWERS eth_accounts AFTER 600 ms, B AFTER 1.5 s: A's answer lands while B is the choice.
  const list = [{ ...A, connected: false, slow: { eth_accounts: 600 } }, { ...B, connected: false, slow: { eth_accounts: 1500 } }];
  await page.addInitScript({ content: walletsScript({ rpc: STATE.rpc, list }) });
  await page.goto("/curb.html");
  await barReady(page);
  await settle(page);
  await page.click("#barConnect");
  await rows(page).nth(0).click();
  await rows(page).nth(1).click();
  await expect(page.locator("#barConnect")).toContainText(short(OTHER), { timeout: 10_000 });
  await expect(picker(page)).toBeHidden();
  const asked = await logs(page);
  expect(asked.A, "the wallet pressed first was asked to connect").not.toContain("eth_requestAccounts");
  expect(asked.B).toContain("eth_requestAccounts");
  expect((await stored(page)).wallet).toBe("6963:io.rabby");
  expect(await page.evaluate(() => window.CurbBar.wallet() === window.__wallets.B)).toBe(true);
});

test("an account a wallet gives after another tab chose another wallet is not shown as the chosen one's", async ({ context }) => {
  const page = await context.newPage();
  // A, REMEMBERED, TAKES 3 s OVER ITS PROMPT.
  const list = [{ ...A, connected: false, slow: { eth_requestAccounts: 3000 } }, { ...B, connected: false }];
  await page.addInitScript({ content: walletsScript({ rpc: STATE.rpc, list, store: { wallet: "6963:io.metamask" } }) });
  await page.goto("/curb.html");
  await barReady(page);
  await settle(page);
  await page.click("#barConnect");
  await expect.poll(async () => (await logs(page)).A || []).toContain("eth_requestAccounts");
  // MEANWHILE ANOTHER TAB CONNECTS B.
  const other = await context.newPage();
  await other.goto("/terms.html");
  await other.evaluate(() => localStorage.setItem("curb.site.v1", JSON.stringify({ hidden: false, wallet: "6963:io.rabby" })));
  await expect.poll(() => page.evaluate(() => window.CurbBar.wallet() === window.__wallets.B)).toBe(true);
  // A ANSWERS NOW, with its account.
  await page.waitForTimeout(3200);
  await expect(page.locator("#barConnect")).toHaveText("Connect wallet");
  expect(await page.evaluate(() => window.CurbBar.account()), "A's account was shown as B's").toBeNull();
  expect((await stored(page)).wallet).toBe("6963:io.rabby");
});

test("the pages do not wait for wallet discovery that cannot change the choice: no wallet, two, or a Disconnect", async ({ context }) => {
  // WHEN CurbBar.ready SETTLED, against DOMContentLoaded, in the page's own clock.
  const timing = function () {
    var bar;
    window.__t = {};
    document.addEventListener("DOMContentLoaded", function () { window.__t.dcl = performance.now(); }, { once: true });
    Object.defineProperty(window, "CurbBar", { configurable: true, get: function () { return bar; },
      set: function (v) { bar = v; v.ready.then(function () { window.__t.ready = performance.now(); }); } });
  };
  const after = async (url, spec) => {
    const page = await context.newPage();
    await page.addInitScript({ content: walletsScript({ rpc: STATE.rpc, ...spec }, timing) });
    await page.goto(url);
    await page.waitForFunction(() => window.__t.ready !== undefined && window.__t.dcl !== undefined, null, { timeout: 10_000 });
    const t = await page.evaluate(() => window.__t);
    await page.close();
    return t.ready - t.dcl;
  };
  // NO WALLET AT ALL - a phone opening a shared link - on app.html.
  expect(await after(appUrl, { list: [] }), "app.html with no wallet waited for discovery").toBeLessThan(100);
  // TWO WALLETS, NONE REMEMBERED: the person picks, whatever else announces.
  expect(await after("/curb.html", { list: [A, B] }), "two wallets waited for discovery").toBeLessThan(100);
  // A REMEMBERED WALLET THE SITE DOES NOT LIST is not waited for: it would never be drawn.
  expect(await after("/curb.html", { list: [A, B], store: { wallet: "6963:app.phantom" } }),
    "a remembered wallet the site does not list was waited for").toBeLessThan(100);
  // A LONE WALLET STILL WAITS A MOMENT, for a second that may join it.
  expect(await after("/curb.html", { list: [A] }), "a lone wallet was chosen before a second could announce").toBeGreaterThanOrEqual(140);
  // AFTER A DISCONNECT nothing is chosen, so nothing is waited for.
  expect(await after("/launch.html", { list: [A], store: { hidden: true } }), "launch.html after a Disconnect waited").toBeLessThan(100);
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

// ================================================================== Coinbase Wallet's own browser
// THE SITE OPENED INSIDE COINBASE WALLET (go.base.app/app?url=...): the app's
// smart wallet is window.ethereum, with isCoinbaseBrowser, and has already
// allowed the site. Whether it announces itself, and under which id, is not
// documented - so each way is tested: an id the site does not list, nothing,
// and Coinbase Wallet's own. Every test here has WalletConnect configured
// (useSite), so "no phone wallet" means something.
/// A context that is the app's browser: its user agent, on a phone's screen.
const inApp = (browser) => browser.newContext({ userAgent: IN_APP_UA, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
/// The app's wallet announcing an id LISTED does not name, already allowing the site.
const HOST = { id: "H", uuid: uuid("a"), rdns: "app.base.wallet", name: "Base", account: TRADER, connected: true, flags: IN_APP_FLAGS };

test("inside Coinbase Wallet's browser its wallet, announcing an id the site does not list, is Coinbase Wallet: connected silently, and no phone wallet", async ({ browser }) => {
  const ctx = await inApp(browser);
  const page = await ctx.newPage();
  const seen = wcRequests(page);
  await useSite(page);
  await useFakeWalletConnect(page);
  await page.addInitScript({ content: walletsScript({ rpc: STATE.rpc, list: [HOST] }) });
  await page.goto("/curb.html");
  await barReady(page);
  // ALREADY ALLOWED: taken at load, asked only eth_accounts.
  await expect(page.locator("#barConnect")).toContainText(short(TRADER), { timeout: 10_000 });
  let asked = await logs(page);
  expect(asked.H).toContain("eth_accounts");
  expect(asked.H, "the app's wallet was prompted at load").not.toContain("eth_requestAccounts");
  expect(await page.evaluate(() => window.CurbBar.wallet() === window.__wallets.H)).toBe(true);

  // DISCONNECTED AND CONNECTED AGAIN: straight to it - no picker, no phone
  // wallet - and remembered under Coinbase Wallet's id, not the one announced.
  await page.click("#barConnect");
  await page.click("#siteBar .cbOut");
  await expect(page.locator("#barConnect")).toHaveText("Connect wallet");
  await clearLogs(page);
  await page.click("#barConnect");
  await expect(page.locator("#barConnect")).toContainText(short(TRADER), { timeout: 10_000 });
  await expect(picker(page), "a picker was opened for the app's one wallet").toBeHidden();
  expect((await logs(page)).H).toContain("eth_requestAccounts");
  expect((await stored(page)).wallet).toBe("6963:com.coinbase.wallet");

  // THE NEXT PAGE: the remembered id is the app's wallet, chosen silently.
  await clearLogs(page);
  await page.goto("/docs.html");
  await barReady(page);
  await expect(page.locator("#barConnect")).toContainText(short(TRADER), { timeout: 10_000 });
  asked = await logs(page);
  expect(asked.H).toContain("eth_accounts");
  expect(asked.H).not.toContain("eth_requestAccounts");
  expect(seen, "something of WalletConnect's was requested inside the app").toEqual([]);
  await ctx.close();
});

test("inside Coinbase Wallet's browser its wallet, announcing nothing, is Coinbase Wallet and not \"Browser wallet\", and the picker offers no phone wallet", async ({ browser }) => {
  // ALONE, NOT YET ALLOWED: chosen at load (one wallet, no phone wallet), asked
  // silently, not prompted; Connect then asks it and no other.
  let ctx = await inApp(browser);
  let page = await ctx.newPage();
  const seen = wcRequests(page);
  await useSite(page);
  await page.addInitScript({ content: walletsScript({ rpc: STATE.rpc, list: [],
    legacy: { ...LEGACY, connected: false, flags: IN_APP_FLAGS } }) });
  await page.goto("/app.html");
  await barReady(page);
  await settle(page);
  await expect(page.locator("#barConnect")).toHaveText("Connect wallet");
  expect((await logs(page)).eth || [], "the app's wallet was prompted at load").not.toContain("eth_requestAccounts");
  expect(await page.evaluate(() => window.CurbBar.wallet() === window.ethereum), "the lone wallet was not chosen").toBe(true);
  await page.click("#barConnect");
  await expect(page.locator("#wallet")).toContainText(TRADER, { ignoreCase: true, timeout: 20_000 });
  await expect(picker(page)).toBeHidden();
  expect((await logs(page)).eth).toContain("eth_requestAccounts");
  expect((await stored(page)).wallet, "remembered as the browser's window.ethereum, not as Coinbase Wallet").toBe("6963:com.coinbase.wallet");
  expect(seen).toEqual([]);
  await ctx.close();

  // BESIDE A LISTED WALLET: two rows, the app's under Coinbase Wallet's name,
  // and no "Phone wallet" though the site has WalletConnect on.
  ctx = await inApp(browser);
  page = await ctx.newPage();
  await useSite(page);
  await page.addInitScript({ content: walletsScript({ rpc: STATE.rpc, list: [A], legacy: { ...LEGACY, flags: IN_APP_FLAGS } }) });
  await page.goto("/curb.html");
  await barReady(page);
  await settle(page);
  expect(await logs(page), "a wallet was asked before the person picked one").toEqual({});
  await page.click("#barConnect");
  await expect(picker(page)).toBeVisible();
  expect(await rows(page).locator(".cbPickName").allTextContents()).toEqual(["MetaMask", "Coinbase Wallet"]);
  await expect(picker(page)).not.toContainText("Phone wallet");
  await ctx.close();
});

test("inside Coinbase Wallet's browser, the app's wallet announcing Coinbase Wallet's own id is one row, not two", async ({ browser }) => {
  const ctx = await inApp(browser);
  const page = await ctx.newPage();
  await useSite(page);
  // window.ethereum WITH THE FLAG, ANNOUNCED UNDER COINBASE WALLET'S ID AS
  // ANOTHER OBJECT that does not carry it - as a provider that announces a
  // wrapper of itself does.
  const wrapped = function () {
    var h = window.ethereum;
    var wrapper = { request: function (a) { return h.request(a); }, on: function (e, f) { h.on(e, f); },
      removeListener: function (e, f) { h.removeListener(e, f); } };
    var d = { info: { uuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Coinbase Wallet", rdns: "com.coinbase.wallet" }, provider: wrapper };
    window.addEventListener("eip6963:requestProvider", function () {
      window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: d }));
    });
  };
  await page.addInitScript({ content: walletsScript({ rpc: STATE.rpc, list: [B],
    legacy: { ...LEGACY, connected: false, flags: IN_APP_FLAGS } }, wrapped) });
  await page.goto("/curb.html");
  await barReady(page);
  await settle(page);
  expect(await logs(page), "a wallet was asked before the person picked one").toEqual({});
  await page.click("#barConnect");
  await expect(picker(page)).toBeVisible();
  // ONE ROW FOR THE APP'S WALLET, however many ways it said so - and no twin warning.
  expect(await rows(page).locator(".cbPickName").allTextContents()).toEqual(["Rabby Wallet", "Coinbase Wallet"]);
  await expect(picker(page).locator(".cbPickWarn")).toHaveCount(0);
  await rows(page).nth(1).click();
  await expect(page.locator("#barConnect")).toContainText(short(TRADER), { timeout: 10_000 });
  expect(await page.evaluate(() => window.CurbBar.wallet() === window.ethereum), "the app's wallet is not window.ethereum").toBe(true);
  expect((await logs(page)).B, "the wallet not picked was asked").toBeUndefined();
  expect((await stored(page)).wallet).toBe("6963:com.coinbase.wallet");
  await ctx.close();
});

test("on a desktop browser a wallet setting isCoinbaseBrowser is not taken for the app's: unlisted stays unlisted, window.ethereum stays \"Browser wallet\", and the phone wallet stays", async ({ browser }) => {
  // AN EXTENSION ANNOUNCING AN ID THE SITE DOES NOT LIST, WITH THE FLAG: not
  // drawn, asked nothing, and window.ethereum not offered in its place.
  let page = await browser.newPage();
  await page.addInitScript({ content: walletsScript({ rpc: STATE.rpc, list: [HOST], legacy: { ...LEGACY, flags: IN_APP_FLAGS } }) });
  await page.goto("/curb.html");
  await barReady(page);
  await settle(page);
  await page.click("#barConnect");
  await expect(page.locator("#siteBar .cbNote")).toContainText("This browser's wallets are not ones the site lists.");
  await expect(picker(page)).toBeHidden();
  expect(await logs(page), "a wallet only flagged as Coinbase Wallet's browser was asked").toEqual({});
  await page.close();

  // window.ethereum WITH THE FLAG AND NO ANNOUNCEMENT: "Browser wallet", beside
  // the phone wallet - nothing chosen for the person, nothing named for it.
  page = await browser.newPage();
  await useSite(page);
  await page.addInitScript({ content: walletsScript({ rpc: STATE.rpc, list: [], legacy: { ...LEGACY, connected: false, flags: IN_APP_FLAGS } }) });
  await page.goto("/curb.html");
  await barReady(page);
  await settle(page);
  await page.click("#barConnect");
  await expect(picker(page)).toBeVisible();
  expect(await rows(page).locator(".cbPickName").allTextContents()).toEqual(["Browser wallet", "Phone wallet - WalletConnect"]);
  await rows(page).nth(0).click();
  await expect(page.locator("#barConnect")).toContainText(short(TRADER), { timeout: 10_000 });
  expect((await stored(page)).wallet).toBe("legacy");
  await page.close();

  // THE USER AGENT ALONE IS NOT ENOUGH EITHER: inside the app's browser, a
  // provider without the flag announcing an unlisted id is unlisted - and the
  // phone wallet stays, the one way left to connect. It used to be withheld on
  // the user agent alone, and the person was told to install a wallet.
  const ctx = await inApp(browser);
  page = await ctx.newPage();
  await useSite(page);
  await useFakeWalletConnect(page);
  await page.addInitScript({ content: walletsScript({ rpc: STATE.rpc, list: [{ ...HOST, flags: undefined }] }) });
  await page.goto("/curb.html");
  await barReady(page);
  await settle(page);
  await page.click("#barConnect");
  await expect(page.locator("#siteBar .cbWcApps a").first(), "inside the app with no wallet of its own, WalletConnect was withheld")
    .toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#siteBar .cbNote")).not.toContainText("Install one");
  expect(await logs(page)).toEqual({});
  await ctx.close();
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

test("a WalletConnect session left with no account on the site's chain is let go: no page says \"Connected: undefined\", and Connect pairs again", async ({ page }) => {
  await useSite(page);
  await useFakeWalletConnect(page);
  await page.addInitScript({ content: walletsScript({ rpc: STATE.rpc, list: [], store: { wallet: "walletconnect" } },
    new Function("window.__wc = { restore: " + JSON.stringify(wcSession(TRADER)) + " };")) });
  await page.goto("/app.html");
  await barReady(page);
  await expect(page.locator("#wallet")).toContainText(TRADER, { ignoreCase: true, timeout: 15_000 });
  await page.evaluate(() => { window.__adapter = window.CurbBar.wallet(); });

  // THE PHONE MOVES THE SESSION OFF BASE: an update whose only account is on chain 1.
  const offBase = { eip155: { ...wcSession(TRADER).namespaces.eip155, accounts: ["eip155:1:" + TRADER] } };
  await page.evaluate((ns) => window.__wc.up.emit("session_update", { topic: "topic-1", params: { namespaces: ns } }), offBase);
  await expect(page.locator("#barConnect")).toHaveText("Connect wallet");
  expect(await page.evaluate(() => window.CurbBar.wallet()), "the bar kept a session with no account").toBeNull();
  expect((await stored(page)).wallet).toBeUndefined();
  expect(await page.evaluate(() => window.__wc.disconnects), "the session was not ended on the phone").toBe(1);
  // ASKED FOR AN ACCOUNT IT HAS NOT GOT, THE ADAPTER SAYS SO (EIP-1193 4100), not [].
  expect(await page.evaluate(() => window.__adapter.request({ method: "eth_requestAccounts" }).then((a) => a, (e) => e.code))).toBe(4100);

  // CONNECT PAIRS AGAIN - the bar's, which runs app.html's own.
  await page.click("#barConnect");
  await expect(page.locator("#siteBar canvas.cbWcQr")).toHaveCount(1, { timeout: 15_000 });
  await page.evaluate((s) => window.__wc.approve(s), wcSession(TRADER, "topic-2"));
  await expect(page.locator("#wallet")).toContainText("Connected: " + TRADER, { ignoreCase: true, timeout: 15_000 });
  await expect(page.locator("#barConnect")).toContainText(short(TRADER));

  // AN accountsChanged ABOUT ANOTHER CHAIN changes nothing here; one with no account on this chain ends the session.
  await page.evaluate((other) => window.__wc.up.emit("session_event", { topic: "topic-2",
    params: { chainId: "eip155:1", event: { name: "accountsChanged", data: ["eip155:1:" + other] } } }), OTHER);
  await page.waitForTimeout(300);
  await expect(page.locator("#barConnect")).toContainText(short(TRADER));
  await page.evaluate(() => window.__wc.up.emit("session_event", { topic: "topic-2",
    params: { chainId: "eip155:8453", event: { name: "accountsChanged", data: [] } } }));
  await expect(page.locator("#barConnect")).toHaveText("Connect wallet");
  expect(await page.evaluate(() => window.CurbBar.wallet())).toBeNull();
  expect(await page.evaluate(() => window.__wc.disconnects)).toBe(2);
  await expect(page.locator("#wallet")).not.toContainText("undefined");
});

test("on a phone, \"Open <wallet>\" under the bar names the request and opens in a new tab, never in the page waiting on the send", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 800 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await useSite(page);
  await useFakeWalletConnect(page);
  await page.addInitScript({ content: walletsScript({ rpc: STATE.rpc, list: [] }) });
  await page.goto("/curb.html");
  await barReady(page);
  await page.click("#barConnect");
  const rainbow = page.locator("#siteBar .cbWcApps a", { hasText: "Rainbow" });
  await expect(rainbow).toBeVisible({ timeout: 15_000 });
  // THE TAP, WITHOUT WHERE IT GOES: there is no wallet app here to open.
  await page.evaluate(() => document.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest("#siteBar a")) e.preventDefault();
  }, true));
  await rainbow.click();
  await page.evaluate((s) => window.__wc.approve(s), wcSession(TRADER));
  await expect(page.locator("#barConnect")).toContainText(short(TRADER));
  const url = page.url();

  // A SEND, LEFT WAITING ON THE PHONE.
  await page.evaluate((me) => {
    window.__wc.answer = () => new Promise((resolve) => { window.__wc.release = resolve; });
    window.__sending = window.CurbBar.wallet().request({ method: "eth_sendTransaction", params: [{ from: me, to: me, value: "0x1" }] });
  }, TRADER);
  const note = page.locator("#siteBar .cbNote");
  await expect(note).toContainText("Confirm in Fake Phone Wallet.");
  const link = note.locator("a");
  await expect(link).toHaveText("Open Rainbow");
  await expect(link, "the link would take the page waiting on the send away").toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("href", "https://rnbwapp.com/wc?requestId=1001&sessionTopic=topic-1");
  expect(await link.getAttribute("rel")).toContain("noopener");
  expect(page.url()).toBe(url);

  // ANSWERED: the page has the hash, and the line goes.
  await page.evaluate(() => window.__wc.release("0x" + "22".repeat(32)));
  expect(await page.evaluate(() => window.__sending)).toBe("0x" + "22".repeat(32));
  await expect(note).toBeHidden();
  await context.close();
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
