// THE SITE BAR: the same links, the same Connect button and the same account on
// every page.
//
// The account is kept across pages by asking the wallet, silently, on every
// load - so these tests need a wallet that behaves like a real one across
// navigation. The stub alone does not: its permission resets on every load. The
// bootstrap below keeps the grant in localStorage (as a wallet keeps it per
// site), and records every method a page asks for in sessionStorage, which
// survives navigation in the same tab. "Never a prompt" is then a fact to read,
// not an absence to hope for.
const { test, expect } = require("@playwright/test");
const fs = require("fs");
const path = require("path");

const STATE = JSON.parse(fs.readFileSync(path.join(__dirname, ".state.json"), "utf8"));
const STUB = fs.readFileSync(path.join(__dirname, "..", "wallet-stub.js"), "utf8");
const APP = STATE.app;
const TRADER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
// ANOTHER ACCOUNT THE WALLET CAN SWITCH TO - anvil's third, never used to send here.
const OTHER = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);

/// @param granted  whether the site is already allowed when the test starts
/// @param revoke   whether the wallet supports wallet_revokePermissions; the
///                 stub alone forwards it to the node, where it fails
function bootstrap({ granted, revoke = false, account = TRADER }) {
  return [
    STUB,
    ";(function () {",
    "  var KEY = 'stub.granted', LOG = 'stub.methods';",
    "  if (!sessionStorage.getItem('stub.init')) {",
    "    sessionStorage.setItem('stub.init', '1');",
    "    localStorage.setItem(KEY, " + JSON.stringify(granted ? "1" : "0") + ");",
    "  }",
    "  var w = window.makeWallet(" + JSON.stringify(STATE.rpc) + ", { forward: true, chainId: '0x2105', account: " +
      JSON.stringify(account) + ", connected: localStorage.getItem(KEY) === '1' });",
    "  var inner = w.request.bind(w);",
    "  w.request = function (a) {",
    "    try { var l = JSON.parse(sessionStorage.getItem(LOG) || '[]'); l.push(a.method); sessionStorage.setItem(LOG, JSON.stringify(l)); } catch (e) {}",
    "    if (a.method === 'eth_requestAccounts') localStorage.setItem(KEY, '1');",
    revoke
      ? "    if (a.method === 'wallet_revokePermissions') { localStorage.setItem(KEY, '0'); w.cfg.connected = false; return Promise.resolve(null); }"
      : "",
    "    return inner(a);",
    "  };",
    "  window.ethereum = w;",
    "})();",
  ].join("\n");
}

async function methods(page) {
  return page.evaluate(() => JSON.parse(sessionStorage.getItem("stub.methods") || "[]"));
}
async function clearMethods(page) {
  await page.evaluate(() => sessionStorage.setItem("stub.methods", "[]"));
}

const pair = new URLSearchParams({ rpc: STATE.rpc, lens: APP.lens }).toString();
const PAGES = [
  // [path, the nav entry that is current, if any]
  ["/browse.html?" + pair, "Launches"],
  ["/app.html?" + new URLSearchParams({ rpc: STATE.rpc, factory: APP.factory, lens: APP.lens }).toString(), null],
  ["/curb.html", "$CURB"],
  ["/launch.html", null],
  ["/terms.html", null],
  ["/docs.html", "Docs"],
  // WHERE HOLDER SHARING IS SEEN, in the bar on every page (the owner looked for it).
  ["/sharing.html?" + pair, "Holder fees"],
];

async function barReady(page) {
  await page.waitForSelector("#siteBar .cbInner", { timeout: 10_000 });
}

/// ONE BAR, THE SAME ON EVERY PAGE - links, button, and nothing that collides
/// with a page's own ids. app.html and launch.html keep exactly one #connect
/// and one #wallet in <main>; the bar's button is #barConnect.
test("every page carries the same bar, and no page throws", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript({ content: bootstrap({ granted: false }) });
  for (const [url, current] of PAGES) {
    await page.goto(url);
    await barReady(page);
    const nav = await page.locator("#siteBar .cbNav a").allTextContents();
    expect(nav, url + ": the nav differs").toEqual(["$CURB", "Launches", "Holder fees", "Docs"]);
    expect(await page.locator("#barConnect").count(), url + ": not one Connect button").toBe(1);
    expect(await page.locator("#siteBar .cbCta").count(), url + ": no call to action").toBe(1);
    // THE PROJECT'S SOCIALS, X THEN TELEGRAM, each in a new tab with no opener.
    const socials = await page.locator("#siteBar a.cbIcon").evaluateAll((as) =>
      as.map((a) => [a.getAttribute("href"), a.getAttribute("target"), a.getAttribute("rel"), a.getAttribute("aria-label")]));
    expect(socials, url + ": the socials differ").toEqual([
      ["https://x.com/curbfun", "_blank", "noreferrer noopener", "Curb on X"],
      ["https://t.me/CurbCommunity", "_blank", "noreferrer noopener", "Curb on Telegram"],
    ]);
    const cur =await page.locator('#siteBar .cbNav a[aria-current="page"]').allTextContents();
    expect(cur, url + ": the wrong page is marked current").toEqual(current ? [current] : []);
    if (url.startsWith("/app.html") || url.startsWith("/launch.html")) {
      expect(await page.locator("#connect").count(), url + ": #connect is not unique").toBe(1);
      expect(await page.locator("#wallet").count(), url + ": #wallet is not unique").toBe(1);
      expect(await page.locator("main #connect").count(), url + ": #connect left <main>").toBe(1);
    }
    // AT PHONE WIDTH TOO: the bar wraps into two rows and never takes the page sideways.
    await page.setViewportSize({ width: 375, height: 800 });
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(over, url + ": the page scrolls sideways at 375px").toBeLessThanOrEqual(0);
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  expect(errors, "a page threw").toEqual([]);
});

/// A WALLET THAT ALREADY ALLOWED THIS SITE IS SHOWN ON EVERY PAGE, AND NOTHING
/// ASKS IT FOR PERMISSION. Across four pages, the only wallet methods called
/// are reads.
test("an allowed wallet is shown on every page, and nothing prompts it", async ({ page }) => {
  await page.addInitScript({ content: bootstrap({ granted: true }) });
  for (const url of ["/docs.html", "/curb.html", "/browse.html?" + pair, "/terms.html"]) {
    await page.goto(url);
    await barReady(page);
    await expect(page.locator("#barConnect"), url).toContainText(short(TRADER), { timeout: 10_000 });
    await expect(page.locator("#barConnect"), url).toHaveClass(/\bon\b/);
  }
  const asked = await methods(page);
  expect(asked, "no page asked the wallet anything").toContain("eth_accounts");
  expect(asked, "a page prompted the wallet on load").not.toContain("eth_requestAccounts");
  expect(asked, "a page sent something").not.toContain("eth_sendTransaction");
});

/// A WALLET THAT HAS NOT ALLOWED THIS SITE IS NOT SHOWN AS CONNECTED, and is
/// not prompted - on any page.
test("a wallet that has not allowed the site is not shown, and not prompted", async ({ page }) => {
  await page.addInitScript({ content: bootstrap({ granted: false }) });
  for (const url of ["/browse.html?" + pair, "/curb.html", "/docs.html"]) {
    await page.goto(url);
    await barReady(page);
    await page.waitForTimeout(300);
    await expect(page.locator("#barConnect"), url).toHaveText("Connect wallet");
  }
  expect(await methods(page)).not.toContain("eth_requestAccounts");
});

/// CONNECTED ONCE, CONNECTED EVERYWHERE: the click asks once, and the next page
/// shows the account with no second prompt.
test("connecting on one page carries to the next without asking again", async ({ page }) => {
  await page.addInitScript({ content: bootstrap({ granted: false }) });
  await page.goto("/curb.html");
  await barReady(page);
  await page.click("#barConnect");
  await expect(page.locator("#barConnect")).toContainText(short(TRADER));
  expect((await methods(page)).filter((m) => m === "eth_requestAccounts").length).toBe(1);
  await clearMethods(page);
  await page.goto("/docs.html");
  await barReady(page);
  await expect(page.locator("#barConnect")).toContainText(short(TRADER), { timeout: 10_000 });
  await page.goto("/browse.html?" + pair);
  await barReady(page);
  await expect(page.locator("#barConnect")).toContainText(short(TRADER), { timeout: 10_000 });
  expect(await methods(page), "the next pages prompted again").not.toContain("eth_requestAccounts");
});

/// ON app.html AND launch.html THE BAR RUNS THE PAGE'S OWN CONNECT. Otherwise
/// the bar would show an account the page did not know it had: app.js's
/// `account` stays null and every action says "Connect a wallet first".
for (const [label, url] of [
  ["app.html", "/app.html?" + new URLSearchParams({ rpc: STATE.rpc, factory: APP.factory, lens: APP.lens }).toString()],
  ["launch.html", "/launch.html"],
]) {
  test(`on ${label} the bar's Connect runs the page's own, and the page's own updates the bar`, async ({ page }) => {
    await page.addInitScript({ content: bootstrap({ granted: false }) });
    await page.goto(url);
    await barReady(page);
    await expect(page.locator("#wallet")).not.toContainText("Connected:");
    await page.click("#barConnect");
    await expect(page.locator("#wallet"), "the page's connect did not run").toContainText("Connected:", { timeout: 20_000 });
    await expect(page.locator("#wallet")).toContainText(TRADER, { ignoreCase: true });
    await expect(page.locator("#barConnect")).toContainText(short(TRADER));

    // AND THE OTHER WAY: a page reloaded without permission, connected from its own button.
    await page.evaluate(() => { localStorage.setItem("stub.granted", "0"); });
    await page.reload();
    await barReady(page);
    await expect(page.locator("#barConnect")).toHaveText("Connect wallet");
    await page.click("main #connect");
    await expect(page.locator("#barConnect"), "the bar did not hear the page's connect").toContainText(short(TRADER), { timeout: 20_000 });
  });
}

/// DISCONNECT HOLDS ON EVERY PAGE until the person connects again - here with a
/// wallet that does NOT support wallet_revokePermissions, so the bar's own
/// memory of the choice is all that holds. app.html's silent detection honours
/// it too, so the page does not quietly reconnect under the bar.
test("Disconnect hides the account on every page until connecting again", async ({ page }) => {
  await page.addInitScript({ content: bootstrap({ granted: true, revoke: false }) });
  await page.goto("/docs.html");
  await barReady(page);
  await expect(page.locator("#barConnect")).toContainText(short(TRADER), { timeout: 10_000 });
  await page.click("#barConnect");
  await expect(page.locator("#siteBar .cbMenu")).toBeVisible();
  await expect(page.locator("#siteBar .cbWho")).toHaveText(TRADER);
  await page.click("#siteBar .cbOut");
  await expect(page.locator("#barConnect")).toHaveText("Connect wallet");

  await clearMethods(page);
  await page.goto("/curb.html");
  await barReady(page);
  await page.waitForTimeout(300);
  await expect(page.locator("#barConnect"), "the account came back after a Disconnect").toHaveText("Connect wallet");
  expect(await methods(page), "the bar asked the wallet after a Disconnect").not.toContain("eth_accounts");

  await page.goto("/app.html?" + new URLSearchParams({ rpc: STATE.rpc, factory: APP.factory, lens: APP.lens }).toString());
  await barReady(page);
  await page.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
  await page.waitForTimeout(500);
  await expect(page.locator("#wallet"), "app.html reconnected silently after a Disconnect").not.toContainText("Connected:");
  await expect(page.locator("#barConnect")).toHaveText("Connect wallet");

  // CONNECTING AGAIN LIFTS IT.
  await page.goto("/curb.html");
  await barReady(page);
  await page.click("#barConnect");
  await expect(page.locator("#barConnect")).toContainText(short(TRADER));
  await page.goto("/docs.html");
  await barReady(page);
  await expect(page.locator("#barConnect")).toContainText(short(TRADER), { timeout: 10_000 });
});

/// DISCONNECT ON launch.html RELOADS IT, AND IT STAYS DISCONNECTED: its silent
/// eth_accounts check is not made, and the wallet's own account events are
/// ignored, until the person connects again. Only app.html was visited after a
/// Disconnect before, so launch.js's gate could be deleted with the suite green
/// (round 5, N35). The positive control comes first: with the site allowed,
/// the same page DOES connect silently and DOES follow an account event.
test("Disconnect on launch.html reloads it, and neither its silent check nor a wallet event reconnects it", async ({ page }) => {
  await page.addInitScript({ content: bootstrap({ granted: true, revoke: false }) });
  await page.goto("/launch.html");
  await barReady(page);
  await expect(page.locator("#wallet"), "launch.html did not connect silently to an allowed wallet")
    .toContainText("Connected:", { timeout: 10_000 });
  await page.evaluate((a) => window.ethereum.emit("accountsChanged", [a]), OTHER);
  await expect(page.locator("#wallet"), "launch.html did not follow the wallet's account event")
    .toContainText(OTHER, { ignoreCase: true });

  await page.evaluate(() => { window.__beforeDisconnect = 1; });
  await page.click("#barConnect");
  const reloaded = page.waitForEvent("load");
  await page.click("#siteBar .cbOut");
  await reloaded;
  await barReady(page);
  expect(await page.evaluate(() => window.__beforeDisconnect), "the page was not reloaded").toBeUndefined();
  await page.waitForFunction(() => !!window.CurbLaunch, null, { timeout: 8_000 });
  await page.waitForTimeout(500);
  await expect(page.locator("#wallet"), "launch.html reconnected silently after a Disconnect")
    .not.toContainText("Connected:");
  await expect(page.locator("#barConnect")).toHaveText("Connect wallet");

  await page.evaluate((a) => window.ethereum.emit("accountsChanged", [a]), TRADER);
  await page.waitForTimeout(300);
  await expect(page.locator("#wallet"), "a wallet event reconnected launch.html after a Disconnect")
    .not.toContainText("Connected:");
  await expect(page.locator("#barConnect"), "a wallet event reconnected the bar after a Disconnect")
    .toHaveText("Connect wallet");
});

/// DISCONNECT DOES NOT RELOAD A PAGE WHILE AN ACTION IS WAITING ON THE WALLET.
/// A reload between the wallet's dialog and the record of what it sent loses
/// the hash of a transaction the wallet then sends (round 5, N44). Here
/// complete() is left waiting on the wallet's first answer: launch.html's
/// #connect is disabled for as long as it runs, the bar's Disconnect is refused
/// with a note, and the page is neither reloaded nor disconnected. The test
/// above is the control: the same click on the same page, idle, does reload it.
test("Disconnect does not reload launch.html while an action is waiting on the wallet", async ({ page }) => {
  await page.addInitScript({ content: bootstrap({ granted: true, revoke: false }) });
  await page.goto("/launch.html");
  await barReady(page);
  await expect(page.locator("#wallet")).toContainText("Connected:", { timeout: 10_000 });
  await expect(page.locator("main #connect"), "#connect is disabled with nothing running").toBeEnabled();

  await page.evaluate(({ lens, token }) => {
    window.__beforeDisconnect = 1;
    document.getElementById("lens").value = lens;
    document.getElementById("token").value = token;
    // THE WALLET NEVER ANSWERS - so nothing is ever sent, and complete() stays busy.
    const eth = window.ethereum;
    const inner = eth.request;
    eth.request = (a) => (a.method === "eth_chainId" ? new Promise(() => {}) : inner(a));
    window.CurbLaunch.complete();
  }, { lens: STATE.lens, token: STATE.token });
  await expect(page.locator("main #connect"), "launch.html's #connect is not disabled while it is busy")
    .toBeDisabled();

  await page.click("#barConnect");
  await page.click("#siteBar .cbOut");
  // VISIBLE, not only present: the click that showed it must not hide it again.
  await expect(page.locator("#siteBar .cbNote")).toBeVisible();
  await expect(page.locator("#siteBar .cbNote")).toContainText("waiting on the wallet");
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => window.__beforeDisconnect), "the page was reloaded mid-action").toBe(1);
  await expect(page.locator("#barConnect"), "the refused Disconnect disconnected anyway").toContainText(short(TRADER));
  expect(await page.evaluate(() => localStorage.getItem("curb.site.v1") || ""),
    "the refused Disconnect was remembered").not.toContain('"hidden":true');
});

/// A DISCONNECT IN ONE TAB HOLDS IN TABS ALREADY OPEN, and a connect there
/// lifts it. The bar read the choice once at load, so an open app.html or
/// launch.html kept the account - and could send from it - after the person
/// disconnected in another tab (round 5, N46). Two tabs are open: launch.html,
/// whose bar drops the account and whose page is reloaded so its own copy goes
/// too, and docs.html, where the bar is the only account. On a connect in the
/// third, docs.html's bar picks the account up; launch.html's bar does NOT, as
/// its page would not know it had one - both wait for the page to load again.
test("a Disconnect in one tab holds in a tab already open, and a connect lifts it there", async ({ context }) => {
  await context.addInitScript({ content: bootstrap({ granted: true, revoke: false }) });
  const open = await context.newPage();
  await open.goto("/launch.html");
  await barReady(open);
  await expect(open.locator("#wallet")).toContainText("Connected:", { timeout: 10_000 });
  await expect(open.locator("#barConnect")).toContainText(short(TRADER));
  await open.evaluate(() => { window.__beforeDisconnect = 1; });

  const side = await context.newPage();
  await side.goto("/docs.html");
  await barReady(side);
  await expect(side.locator("#barConnect")).toContainText(short(TRADER), { timeout: 10_000 });

  const other = await context.newPage();
  await other.goto("/curb.html");
  await barReady(other);
  await expect(other.locator("#barConnect")).toContainText(short(TRADER), { timeout: 10_000 });
  const reloaded = open.waitForEvent("load");
  await other.click("#barConnect");
  await other.click("#siteBar .cbOut");
  await expect(other.locator("#barConnect")).toHaveText("Connect wallet");

  await expect(side.locator("#barConnect"), "the open docs tab's bar kept the account").toHaveText("Connect wallet");
  await reloaded;
  await barReady(open);
  expect(await open.evaluate(() => window.__beforeDisconnect), "the open launch.html was not reloaded").toBeUndefined();
  await open.waitForFunction(() => !!window.CurbLaunch, null, { timeout: 8_000 });
  await open.waitForTimeout(500);
  await expect(open.locator("#barConnect"), "the open tab's bar kept the account").toHaveText("Connect wallet");
  await expect(open.locator("#wallet"), "the open tab's page kept the account").not.toContainText("Connected:");

  // CONNECTING AGAIN IN THE OTHER TAB LIFTS IT: docs.html's bar asks and shows it...
  await other.click("#barConnect");
  await expect(other.locator("#barConnect")).toContainText(short(TRADER));
  await expect(side.locator("#barConnect"), "a connect in another tab did not reach this one")
    .toContainText(short(TRADER), { timeout: 10_000 });
  // ...launch.html's bar stays with its page, which has no account yet...
  await open.waitForTimeout(500);
  await expect(open.locator("#barConnect"), "the bar showed an account its page does not have").toHaveText("Connect wallet");
  await expect(open.locator("#wallet")).not.toContainText("Connected:");
  // ...and the choice is lifted there too: loaded again, both detect the account.
  await open.reload();
  await barReady(open);
  await expect(open.locator("#wallet"), "the connect elsewhere was not lifted here").toContainText("Connected:", { timeout: 10_000 });
  await expect(open.locator("#barConnect")).toContainText(short(TRADER));
});

/// THE BAR FOLLOWS THE WALLET'S OWN ACCOUNT EVENTS, AND IGNORES THEM AFTER A
/// DISCONNECT. No spec ever emitted accountsChanged, so the handler - and its
/// gate - could be deleted with the suite green (round 5, N37). On docs.html,
/// which has no account of its own, only the bar can be listening.
test("the bar follows the wallet's account changes, and ignores them after a Disconnect", async ({ page }) => {
  await page.addInitScript({ content: bootstrap({ granted: true, revoke: false }) });
  await page.goto("/docs.html");
  await barReady(page);
  await expect(page.locator("#barConnect")).toContainText(short(TRADER), { timeout: 10_000 });
  await page.evaluate((a) => window.ethereum.emit("accountsChanged", [a]), OTHER);
  await expect(page.locator("#barConnect"), "the bar did not follow a switched account").toContainText(short(OTHER));
  await page.evaluate(() => window.ethereum.emit("accountsChanged", []));
  await expect(page.locator("#barConnect"), "the bar kept an account the wallet took away").toHaveText("Connect wallet");
  await page.evaluate((a) => window.ethereum.emit("accountsChanged", [a]), TRADER);
  await expect(page.locator("#barConnect")).toContainText(short(TRADER));

  await page.click("#barConnect");
  await page.click("#siteBar .cbOut");
  await expect(page.locator("#barConnect")).toHaveText("Connect wallet");
  await page.evaluate((a) => window.ethereum.emit("accountsChanged", [a]), OTHER);
  await page.waitForTimeout(300);
  await expect(page.locator("#barConnect"), "a wallet event undid the Disconnect").toHaveText("Connect wallet");
});

/// THE BAR CARRIES rpc AND lens ONLY AS A PAIR, AND NEVER STORES A LINK'S PAIR.
/// A pair stored from a URL would point every later visit - and the create
/// form's factory list - at a registry of the link's choosing.
test("the bar carries the link's rpc and lens as a pair, and forgets them after", async ({ page }) => {
  await page.addInitScript({ content: bootstrap({ granted: false }) });
  await page.goto("/browse.html?" + pair);
  await barReady(page);
  const launches = await page.locator('#siteBar .cbNav a[data-k="browse"]').getAttribute("href");
  const q = new URLSearchParams(launches.split("?")[1] || "");
  expect(q.get("rpc"), "the Launches link lost the rpc").toBe(STATE.rpc);
  expect(q.get("lens"), "the Launches link lost the lens").toBe(APP.lens);
  const cta = await page.locator("#siteBar .cbCta").getAttribute("href");
  expect(cta).toContain("app.html?");
  expect(cta.endsWith("#create-launch")).toBe(true);

  // AN rpc ALONE IS NOT CARRIED - app.html calls that a half link.
  await page.goto("/browse.html?" + new URLSearchParams({ rpc: STATE.rpc }).toString());
  await barReady(page);
  expect(await page.locator('#siteBar .cbNav a[data-k="browse"]').getAttribute("href")).toBe("browse.html");

  // AND A PAGE OPENED WITH NO PAIR DOES NOT INHERIT THE EARLIER LINK'S.
  await page.goto("/docs.html");
  await barReady(page);
  expect(await page.locator('#siteBar .cbNav a[data-k="browse"]').getAttribute("href"),
    "a link's pair was stored and reused").toBe("browse.html");
  expect(await page.evaluate(() => localStorage.getItem("curb.site.v1") || "")).not.toContain("lens");

  // ON app.html THE CALL TO ACTION IS AN IN-PAGE JUMP, not a reload that drops the factory.
  await page.goto("/app.html?" + new URLSearchParams({ rpc: STATE.rpc, factory: APP.factory, lens: APP.lens }).toString());
  await barReady(page);
  expect(await page.locator("#siteBar .cbCta").getAttribute("href")).toBe("#create-launch");
});

/// A LINK'S PAIR SURVIVES EVERY INTERNAL LINK, EVEN WITH ANOTHER PAIR SAVED.
/// $CURB and Docs went bare, so browse (pair A) -> Docs -> Launches landed on
/// the pair app.html had saved (pair B) with no notice; and browse.js read the
/// query on its own terms, so the list and the bar could name two registries
/// (round 5, N45). Walked by clicking, the way a person gets there - pair B is
/// saved first, so every step that dropped A would show B instead.
test("a link's pair survives the bar's links and the pages' own, even with another pair saved", async ({ page }) => {
  const A = APP.lens;
  const B = STATE.lens;
  expect(A.toLowerCase(), "the two deployments share a lens, so nothing would be told apart").not.toBe(B.toLowerCase());
  const lensOf = (url) => (new URL(url, "http://x/").searchParams.get("lens") || "").toLowerCase();
  await page.goto("/docs.html");
  await page.evaluate(({ rpc, lens }) => localStorage.setItem("curb.app.v1", JSON.stringify({ rpc, lens })),
    { rpc: STATE.rpc, lens: B });

  await page.goto("/browse.html?" + pair);
  await barReady(page);
  await page.click('#siteBar .cbNav a[data-k="docs"]');
  await page.waitForURL(/docs\.html/);
  expect(lensOf(page.url()), "the bar's Docs link dropped the pair").toBe(A.toLowerCase());
  await barReady(page);
  await page.click('#siteBar .cbNav a[data-k="browse"]');
  await page.waitForURL(/browse\.html/);
  expect(lensOf(page.url()), "browse (A) -> Docs -> Launches did not come back to A").toBe(A.toLowerCase());
  await expect.poll(() => page.evaluate(() => window.CurbBrowse && window.CurbBrowse.lens),
    { message: "browse.html read another registry than its link named" }).toBe(A);

  // $CURB, AND curb.html's OWN LINK TO THE LAUNCHES.
  await barReady(page);
  await page.click('#siteBar .cbNav a[data-k="curb"]');
  await page.waitForURL(/curb\.html/);
  expect(lensOf(page.url()), "the bar's $CURB link dropped the pair").toBe(A.toLowerCase());
  expect(lensOf(await page.locator('main a[href^="browse.html"]').first().getAttribute("href")),
    "curb.html's link to the launches dropped the pair").toBe(A.toLowerCase());
  // browse.html's launch button and terms.html's way back to the form.
  await page.goto("/browse.html?" + pair);
  await barReady(page);
  expect(lensOf(await page.locator('main a.btn[href^="app.html"]').getAttribute("href")),
    "browse.html's launch button dropped the pair").toBe(A.toLowerCase());
  await page.goto("/terms.html?" + pair);
  await barReady(page);
  expect(lensOf(await page.locator('a.back[href^="app.html"]').getAttribute("href")),
    "terms.html's way back dropped the pair").toBe(A.toLowerCase());

  // AND WITH NO LINK, browse.html reads the pair the bar carries - the saved one.
  await page.goto("/browse.html");
  await barReady(page);
  expect(lensOf(await page.locator('#siteBar .cbNav a[data-k="browse"]').getAttribute("href"))).toBe(B.toLowerCase());
  await expect.poll(() => page.evaluate(() => window.CurbBrowse && window.CurbBrowse.lens),
    { message: "browse.html with no link read something other than the bar's pair" }).toBe(B);
});

/// WHAT THE BAR TAKES FROM THE SAVED PAIR, AND WHAT IT DOES NOT.
///  - A saved pair is read and carried by the bar (the control), but the
///    pages' own links stay as written: the next page reads it anyway, and on
///    a link to app.html it made a plain visit a link that "names a lens but no
///    factory" (round 5, N51's shape).
///  - A saved pair whose endpoint app.html marked as only a link's
///    (rpcFromLink) is not read at all: a stranger's endpoint does not become
///    the bar's because the person touched some other field (round 5, N12).
///  - A half link - an rpc with no lens - does not fall back to the saved pair:
///    browse.html says it was half a link and reads nothing, and the bar
///    carries nothing, rather than both showing a registry the link never named.
test("the bar reads a saved pair only when the person set it, and a half link reads nothing", async ({ page }) => {
  const B = STATE.lens;
  const lensOf = (url) => (new URL(url, "http://x/").searchParams.get("lens") || "").toLowerCase();
  const save = (extra) => page.evaluate(({ rpc, lens, extra }) =>
    localStorage.setItem("curb.app.v1", JSON.stringify({ rpc, lens, ...extra })), { rpc: STATE.rpc, lens: B, extra });
  await page.goto("/docs.html");
  await save({ rpcFromLink: false });

  await page.goto("/terms.html");
  await barReady(page);
  expect(lensOf(await page.locator('#siteBar .cbNav a[data-k="browse"]').getAttribute("href")),
    "the control: the bar did not read the saved pair").toBe(B.toLowerCase());
  expect(await page.locator("a.back").getAttribute("href"), "terms.html's way back took the saved pair")
    .toBe("app.html");
  await page.goto("/curb.html");
  await barReady(page);
  expect(await page.locator('main a[href^="browse.html"]').first().getAttribute("href"),
    "curb.html's link took the saved pair").toBe("browse.html");

  await save({ rpcFromLink: true });
  await page.goto("/docs.html");
  await barReady(page);
  expect(await page.locator('#siteBar .cbNav a[data-k="browse"]').getAttribute("href"),
    "the bar carried a saved pair whose endpoint only a link brought").toBe("browse.html");

  await save({ rpcFromLink: false });
  await page.goto("/browse.html?" + new URLSearchParams({ rpc: STATE.rpc }).toString());
  await barReady(page);
  await expect(page.locator("#msg"), "a half link was not said").toContainText("only half of where to read");
  expect(await page.locator('#siteBar .cbNav a[data-k="browse"]').getAttribute("href"),
    "a half link fell back to the saved pair in the bar").toBe("browse.html");
  await page.waitForTimeout(500);
  expect(await page.locator(".launch").count(), "a half link listed the saved registry's launches").toBe(0);
});

// ---------------------------------------------------------------- the docs page

/// THE DOCS ARE docs.md, RENDERED, with a table of contents that matches the
/// headings it was built from - every entry lands on a heading that exists.
test("the docs page renders docs.md, and its contents lead to real headings", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/docs.html");
  await page.waitForSelector("#docArticle h2", { timeout: 10_000 });
  await expect(page).toHaveTitle(/Curb Docs/);
  const r = await page.evaluate(() => {
    const heads = [...document.querySelectorAll("#docArticle h2, #docArticle h3")].map((h) => h.id);
    const toc = [...document.querySelectorAll("#docTocList a")].map((a) => a.getAttribute("href"));
    return { heads, toc, missing: toc.filter((h) => !document.getElementById(h.slice(1))) };
  });
  expect(r.heads.length, "no sections were rendered").toBeGreaterThan(5);
  expect(r.toc, "the contents do not list the headings in order").toEqual(r.heads.map((id) => "#" + id));
  expect(r.missing, "a contents entry points nowhere").toEqual([]);
  expect(errors).toEqual([]);
});

/// TWO LIMITS THE OWNER ACCEPTED ARE SAID WHERE A READER LOOKS (audit, items 23
/// and 25): a range order in a graduated pool skips the tax on its side, under
/// Fees; and holder payouts need CURB's keeper to keep publishing, under Holder
/// sharing - each in its own section, as rendered.
test("the docs say that a range order skips the pool's tax, and that holder payouts need CURB's keeper", async ({ page }) => {
  await page.goto("/docs.html");
  await page.waitForSelector("#docArticle h2", { timeout: 10_000 });
  const section = (id) => page.evaluate((id) => {
    const h = document.getElementById(id);
    const out = [];
    for (let n = h && h.nextElementSibling; n && n.tagName !== "H2"; n = n.nextElementSibling) out.push(n.textContent);
    return out.join(" ").replace(/\s+/g, " ");
  }, id);
  expect(await section("fees")).toContain("a holder who trades through liquidity of their own in a narrow range of the pool " +
    "(a range order) pays no tax on that side, a Uniswap v4 limitation CURB accepts");
  expect(await section("holder-sharing")).toContain("Payouts also need CURB's keeper to keep publishing them: nobody else can, " +
    "and if it stopped, what arrived after the last payout would wait in the distributor, unpaid - it never expires.");
});

/// THE CONTENTS FIT A 900px WINDOW DOWN TO "Paired-asset addresses" AGAIN: the
/// CURB router's own entry pushed that one under the sticky column's fold, where
/// only scrolling the column found it.
test("the docs contents show every entry down to Paired-asset addresses in a 1280 by 900 window", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/docs.html");
  await page.waitForSelector("#docTocList a", { timeout: 10_000 });
  await expect(page.locator("#docTocList a", { hasText: "CURB router" }), "the router's entry is gone, so this proves nothing")
    .toHaveCount(1);
  const r = await page.evaluate(() => {
    const box = document.getElementById("docToc");
    const b = box.getBoundingClientRect();
    const a = [...document.querySelectorAll("#docTocList a")].find((x) => x.textContent.trim() === "Paired-asset addresses");
    const ar = a.getBoundingClientRect();
    return { scrollTop: box.scrollTop, boxBottom: b.bottom, linkBottom: ar.bottom };
  });
  expect(r.scrollTop).toBe(0);
  expect(r.linkBottom, "Paired-asset addresses is below the contents column's fold").toBeLessThanOrEqual(r.boxBottom);
});

/// A CONNECTED WALLET'S WHOLE ADDRESS STAYS INSIDE A PHONE'S WIDTH on the
/// wallet setup page; it pushed the page sideways. Read from this run's node
/// only: the page's default endpoints are other people's.
test("wallet-setup.html keeps a connected wallet's address inside a phone's width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript({ content: bootstrap({ granted: true }) });
  await page.goto("/wallet-setup.html?" + new URLSearchParams({ rpc: STATE.rpc, scratch: STATE.rpc }).toString());
  await expect(page.locator("#walletState")).toContainText(TRADER, { timeout: 20_000 });
  const w = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, view: innerWidth }));
  expect(w.page, "the page scrolls sideways at a phone's width").toBeLessThanOrEqual(w.view);
});

/// WHATEVER IS IN docs.md, IT NEVER BECOMES HTML, AND ONLY SAFE LINKS BECOME
/// LINKS. The file is the owner's, but a renderer that trusts it is one
/// careless paste away from running a stranger's script. Also: a heading named
/// "Ethereum" must not become an element with id="ethereum", which a browser
/// with no wallet exposes as window.ethereum - the bar would then take a heading
/// for a wallet.
test("markup in docs.md never becomes HTML, and only safe links become links", async ({ page }) => {
  const hostile = [
    "# Hostile",
    "",
    "<script>window.__ran = 1</script>",
    "",
    '<img src="x" onerror="window.__img = 1">',
    "",
    "[js](javascript:window.__js=1) [data](data:text/html,hi) [proto](//evil.example) [ok](https://example.com/a) [rel](terms.html#x)",
    "",
    "## Ethereum",
    "",
    "text",
  ].join("\n");
  await page.route("**/docs.md", (route) => route.fulfill({ status: 200, contentType: "text/plain; charset=utf-8", body: hostile }));
  await page.goto("/docs.html");
  await page.waitForSelector("#docArticle h2", { timeout: 10_000 });
  const r = await page.evaluate(() => {
    const safe = (h) => /^https?:\/\//i.test(h) || /^[a-z0-9-]+\.html(#[\w-]+)?$/i.test(h) || /^#[\w-]+$/.test(h);
    return {
      ran: window.__ran, img: window.__img,
      elements: document.querySelectorAll("#docArticle script, #docArticle img").length,
      bad: [...document.querySelectorAll("#docArticle a")].map((a) => a.getAttribute("href")).filter((h) => !safe(h)),
      ok: !!document.querySelector('#docArticle a[href="https://example.com/a"][rel~="noopener"]'),
      rel: !!document.querySelector('#docArticle a[href="terms.html#x"]'),
      literal: document.getElementById("docArticle").textContent.includes("<script>"),
      ethereumIsElement: typeof window.ethereum === "object" && window.ethereum instanceof Element,
      headingId: document.querySelector("#docArticle h2").id,
    };
  });
  expect(r.ran, "a script in docs.md ran").toBeUndefined();
  expect(r.img, "an onerror in docs.md ran").toBeUndefined();
  expect(r.elements, "markup in docs.md became elements").toBe(0);
  expect(r.literal, "the markup was not shown as text").toBe(true);
  expect(r.bad, "an unsafe link became a link").toEqual([]);
  expect(r.ok, "a plain https link was not kept").toBe(true);
  expect(r.rel, "a same-site link was not kept").toBe(true);
  expect(r.headingId, "a heading took the id 'ethereum'").not.toBe("ethereum");
  expect(r.ethereumIsElement, "a heading became window.ethereum").toBe(false);
  // AND THE BAR, ASKED NOW - after the headings exist - still finds no wallet.
  // The class it painted at load proves nothing about clobbering: it was
  // computed before docs.js drew a single heading (round 5, N62). A click reads
  // window.ethereum afresh, and a heading standing in for it would answer
  // "eth.request is not a function" instead.
  await page.click("#barConnect");
  await expect(page.locator("#siteBar .cbNote"), "the bar took something for a wallet")
    .toContainText("No browser wallet found");
});

test("a docs.md that cannot be fetched says so", async ({ page }) => {
  await page.route("**/docs.md", (route) => route.fulfill({ status: 404, body: "missing" }));
  await page.goto("/docs.html");
  await expect(page.locator("#docArticle")).toContainText("could not be loaded", { timeout: 10_000 });
});

// ---------------------------------------------------------------- search, on every page

const BAR_PAGES = [
  "/browse.html?" + pair,
  "/app.html?" + new URLSearchParams({ rpc: STATE.rpc, factory: APP.factory, lens: APP.lens }).toString(),
  "/curb.html",
  "/launch.html",
  "/terms.html",
  "/docs.html",
];

/// SEARCH IS IN THE BAR ON EVERY PAGE, AND Ctrl K OPENS IT - the badge says so.
/// The same sheet everywhere; Escape closes it.
test("search is in the bar on every page, and Ctrl K opens and closes it", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  for (const url of BAR_PAGES) {
    await page.goto(url);
    await barReady(page);
    await expect(page.locator("#barSearch"), url + ": no search in the bar").toBeVisible();
    await page.keyboard.press("Control+k");
    await expect(page.locator("#cbSearch"), url + ": Ctrl K did not open the search").toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#cbSq")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator("#cbSearch"), url + ": Escape did not close it").toBeHidden();
    await page.click("#barSearch");
    await expect(page.locator("#cbSearch"), url + ": the button did not open it").toBeVisible();
    await page.keyboard.press("Escape");
  }
  expect(errors, "a page threw").toEqual([]);
});

/// The token's own symbol and name, read by the test with its own selectors.
async function labelOf(page, token) {
  return page.evaluate(async ({ rpc, token }) => {
    const hex = (s) => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, "0")).join("");
    const sel = (s) => window.CurbKeccak.keccak256("0x" + hex(s)).slice(0, 10);
    const call = async (data) => {
      const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: token, data }, "latest"] }) });
      return (await r.json()).result;
    };
    const str = (raw) => {
      const h = raw.slice(2);
      const len = parseInt(h.slice(64, 128), 16);
      const bytes = h.slice(128, 128 + len * 2).match(/../g) || [];
      return new TextDecoder().decode(new Uint8Array(bytes.map((b) => parseInt(b, 16))));
    };
    return { sym: str(await call(sel("symbol()"))), name: str(await call(sel("name()"))) };
  }, { rpc: STATE.rpc, token });
}

/// SEARCH FINDS A LAUNCH BY ITS SYMBOL, ITS NAME AND ITS ADDRESS, FROM A PAGE
/// THAT HAS NO LAUNCHES OF ITS OWN - and a hit opens the launch page with the
/// rpc/lens pair the bar carries.
test("search finds a launch by symbol, name and address from any page, and opens it", async ({ page }) => {
  const token = STATE.token.toLowerCase();
  await page.goto("/docs.html?" + new URLSearchParams({ rpc: STATE.rpc, lens: STATE.lens }).toString());
  await barReady(page);
  await page.click("#barSearch");
  const hit = page.locator(`#cbSearch .cbHit[data-token="${token}"]`);
  await expect(hit, "the launch never appeared").toHaveCount(1, { timeout: 30_000 });
  const { sym, name } = await labelOf(page, token);
  expect(sym, "the fixture's token has no symbol").not.toBe("");

  for (const [what, q] of [["symbol", sym], ["name", name.slice(0, 5)], ["address", token.slice(2, 14)]]) {
    await page.fill("#cbSq", q);
    await expect(hit, "not found by its " + what).toHaveCount(1);
    await expect(hit.locator(".cbSym")).toHaveText(sym);
  }
  await page.fill("#cbSq", "zzzz-no-such-launch");
  await expect(hit).toHaveCount(0);
  await expect(page.locator("#cbSresults")).toContainText("No launch matches");

  await page.fill("#cbSq", sym);
  await expect(hit).toHaveCount(1);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/token\/0x/, { timeout: 10_000 });
  const q = new URL(page.url()).searchParams;
  const opened = (new URL(page.url()).pathname.match(/\/token\/(0x[0-9a-fA-F]{40})/) || [])[1] || "";
  expect(opened.toLowerCase(), "Enter opened another launch").toBe(token);
  expect(q.get("rpc"), "the hit dropped the rpc").toBe(STATE.rpc);
  expect(q.get("lens").toLowerCase(), "the hit dropped the lens").toBe(STATE.lens.toLowerCase());
});

/// A FULL ADDRESS IS ALWAYS OFFERED - the sheet holds only the newest launches,
/// and an address is how a token is usually passed around.
test("a full address is offered even when it is not among the launches searched", async ({ page }) => {
  const stranger = "0x1234567890abcdef1234567890abcdef12345678";
  await page.goto("/curb.html?" + new URLSearchParams({ rpc: STATE.rpc, lens: STATE.lens }).toString());
  await barReady(page);
  await page.click("#barSearch");
  await page.fill("#cbSq", stranger);
  const row = page.locator(`#cbSearch .cbHit[data-token="${stranger}"]`);
  await expect(row).toHaveCount(1, { timeout: 30_000 });
  await expect(row).toContainText("Open this address");
  expect(await row.getAttribute("href")).toContain("token/" + stranger);
});

/// A SYMBOL IS A STRANGER'S STRING. One that is markup is shown as the
/// characters it is, and nothing in it runs.
test("a symbol that is markup is shown as text in the search, and does not run", async ({ page }) => {
  const token = STATE.token.toLowerCase();
  const evil = '<img src=x onerror="window.__pwn=1">';
  const abiString = (str) => {
    const hex = Buffer.from(str, "utf8").toString("hex");
    return "0x" + (32).toString(16).padStart(64, "0") + Buffer.byteLength(str, "utf8").toString(16).padStart(64, "0") +
      hex.padEnd(Math.ceil(hex.length / 64) * 64 || 64, "0");
  };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const body = req.postData() || "";
    if (req.method() !== "POST" || !body) return route.continue();
    let m; try { m = JSON.parse(body); } catch { return route.continue(); }
    const p0 = m.params && m.params[0];
    // symbol() is 0x95d89b41; the test asks nothing else of this token.
    if (p0 && String(p0.to).toLowerCase() === token && String(p0.data).toLowerCase() === "0x95d89b41") {
      return route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id: m.id, result: abiString(evil) }) });
    }
    return route.continue();
  });
  await page.goto("/docs.html?" + new URLSearchParams({ rpc: STATE.rpc, lens: STATE.lens }).toString());
  await barReady(page);
  await page.click("#barSearch");
  const sym = page.locator(`#cbSearch .cbHit[data-token="${token}"] .cbSym`);
  await expect(sym).toHaveText(evil.slice(0, 15) + "…", { timeout: 30_000 });
  expect(await page.locator("#cbSearch img").count(), "the symbol became an element").toBe(0);
  expect(await page.evaluate(() => window.__pwn), "the symbol ran").toBeUndefined();
});

// ------------------------------------------ search, against a registry the test controls
//
// Two launches, each of whose symbol and name the test answers - or holds back
// until it chooses to. Registry order is [B, A], so newest first A is listed
// above B. B's ADDRESS contains "beef"; A's SYMBOL is BEEF and its name Zeta
// coin, so "beef" matches B at once and A only once A's label has been read.
const FAKE_LENS = "0x00000000000000000000000000000000000c0de1";
const FAKE_REG = "0x00000000000000000000000000000000000c0de2";
const ROW_A = { token: "0x000000000000000000000000000000000000a001", sym: "BEEF", name: "Zeta coin" };
const ROW_B = { token: "0x00000000000000000000000000000000beef0002", sym: "BBB", name: "Bee" };
const SEARCH_SEL = { registry: "0x7b103999", launchCount: "0x27cca59f", launchPage: "0xb55ab098",
  symbol: "0x95d89b41", name: "0x06fdde03" };

function abiStr(s) {
  const hex = Buffer.from(s, "utf8").toString("hex");
  return "0x" + (32).toString(16).padStart(64, "0") + Buffer.byteLength(s, "utf8").toString(16).padStart(64, "0") +
    hex.padEnd(Math.ceil(hex.length / 64) * 64 || 64, "0");
}
/// launchPage's answer for these tokens: two offsets, the token array, and one
/// fourteen-word LaunchView each (Selling, nothing raised of a threshold of 100).
function launchPageOf(tokens) {
  const w = (v) => BigInt(v).toString(16).padStart(64, "0");
  let hex = w(64) + w(64 + 32 * (1 + tokens.length)) + w(tokens.length) + tokens.map(w).join("") + w(tokens.length);
  for (const _ of tokens) hex += w(1) + w(0).repeat(6) + w(100) + w(0).repeat(6);
  return "0x" + hex;
}
/// Serves the fake registry; A's label reads are parked in `held` until released.
async function fakeRegistry(page) {
  const held = [];
  const registryOrder = [ROW_B, ROW_A];
  await page.route("**/*", async (route) => {
    const req = route.request();
    const body = req.postData() || "";
    if (req.method() !== "POST" || !body) return route.continue();
    let m; try { m = JSON.parse(body); } catch { return route.continue(); }
    const p0 = (m.params && m.params[0]) || {};
    const to = String(p0.to || "").toLowerCase();
    const data = String(p0.data || "").toLowerCase();
    const reply = (result) => route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) });
    if (to === FAKE_LENS && data === SEARCH_SEL.registry) return reply("0x" + FAKE_REG.slice(2).padStart(64, "0"));
    if (to === FAKE_REG && data === SEARCH_SEL.launchCount) return reply("0x" + (2).toString(16).padStart(64, "0"));
    if (to === FAKE_LENS && data.startsWith(SEARCH_SEL.launchPage)) {
      const start = Number(BigInt("0x" + data.slice(10, 74)));
      const count = Number(BigInt("0x" + data.slice(74, 138)));
      return reply(launchPageOf(registryOrder.slice(start, start + count).map((r) => r.token)));
    }
    const row = registryOrder.find((r) => r.token === to);
    if (row && (data === SEARCH_SEL.symbol || data === SEARCH_SEL.name)) {
      const answer = () => reply(abiStr(data === SEARCH_SEL.symbol ? row.sym : row.name));
      if (row === ROW_A && !held.released) { held.push(answer); return; }   // answered on release
      return answer();
    }
    return route.continue();
  });
  held.release = async () => { held.released = true; for (const answer of held.splice(0)) await answer(); };
  return held;
}
// -1 UNTIL search.js HAS LOADED: the bar fetches it on the first click, so a
// poll that starts right after that click finds no CurbSearch yet - and an
// evaluate that throws ends expect.poll instead of being retried.
const labelledCount = (page) => page.evaluate(() => (window.CurbSearch ? window.CurbSearch.state.index.labelled : -1));
const hitTokens = (page) => page.locator("#cbSearch .cbHit").evaluateAll((els) => els.map((e) => e.dataset.token));

/// A LABEL THAT ARRIVES DOES NOT MOVE THE ROWS ALREADY SHOWN. It used to redraw
/// the list in index order every 250 ms, so a row a new symbol made match was
/// inserted ABOVE the one on screen - under a pointer about to click it
/// (round 5, N47). B is listed for "beef" by its address; when A's symbol
/// arrives, A goes below B, not above it.
test("a label arriving adds its row below the ones shown, not above them", async ({ page }) => {
  const held = await fakeRegistry(page);
  await page.goto("/docs.html?" + new URLSearchParams({ rpc: STATE.rpc, lens: FAKE_LENS }).toString());
  await barReady(page);
  await page.click("#barSearch");
  await page.mouse.move(1, 1);
  await page.fill("#cbSq", "beef");
  await expect.poll(() => labelledCount(page), { message: "B's label was never read", timeout: 20_000 }).toBe(1);
  await expect.poll(() => held.length, { message: "A's label was never asked for" }).toBeGreaterThan(0);
  expect(await hitTokens(page), "only B should match before A's label").toEqual([ROW_B.token]);

  await held.release();
  await expect.poll(() => labelledCount(page)).toBe(2);
  await expect.poll(() => hitTokens(page), { message: "A never appeared once its symbol was read" })
    .toEqual([ROW_B.token, ROW_A.token]);
  // A NEW QUERY STARTS AGAIN IN THE INDEX'S OWN ORDER, newest first.
  await page.fill("#cbSq", "bee");
  await expect.poll(() => hitTokens(page)).toEqual([ROW_A.token, ROW_B.token]);
});

/// NOTHING IS REDRAWN UNDER THE POINTER. A label that arrives while the pointer
/// is over the list waits for it to leave: the row being pointed at is the same
/// element before and after, and A's symbol appears only once the pointer goes.
test("labels arriving while the pointer is over the list wait for it to leave", async ({ page }) => {
  const held = await fakeRegistry(page);
  await page.goto("/docs.html?" + new URLSearchParams({ rpc: STATE.rpc, lens: FAKE_LENS }).toString());
  await barReady(page);
  await page.click("#barSearch");
  await expect.poll(() => labelledCount(page), { timeout: 20_000 }).toBe(1);
  const rowB = page.locator(`#cbSearch .cbHit[data-token="${ROW_B.token}"]`);
  const symA = page.locator(`#cbSearch .cbHit[data-token="${ROW_A.token}"] .cbSym`);
  await expect(symA).toHaveText("…");
  await rowB.hover();
  await rowB.evaluate((e) => { e.__pointed = true; });

  await held.release();
  await expect.poll(() => labelledCount(page)).toBe(2);
  await page.waitForTimeout(700);   // more than two flushes
  expect(await page.evaluate(() => [...document.querySelectorAll("#cbSearch .cbHit")].some((e) => e.__pointed === true)),
    "the row under the pointer was rebuilt while it was there").toBe(true);
  await expect(symA, "the list was redrawn under the pointer").toHaveText("…");

  await page.mouse.move(1, 1);
  await expect(symA, "the held labels were never drawn once the pointer left").toHaveText("BEEF");
});

/// "NO LAUNCH MATCHES" ONLY ONCE THE NAMES HAVE BEEN READ. Before, the sheet
/// said so while names were still arriving - of a launch that was there and
/// simply not labelled yet (round 5, N47). "zeta" is A's name: while it is held
/// the sheet says it is still reading; once read, A is found; and a query that
/// matches nothing then does get "No launch matches" - so the test can see it.
test("the search does not say no launch matches before the names are read", async ({ page }) => {
  const held = await fakeRegistry(page);
  await page.goto("/docs.html?" + new URLSearchParams({ rpc: STATE.rpc, lens: FAKE_LENS }).toString());
  await barReady(page);
  await page.click("#barSearch");
  await expect.poll(() => labelledCount(page), { timeout: 20_000 }).toBe(1);
  await page.fill("#cbSq", "zeta");
  await expect(page.locator("#cbSresults")).toContainText("Still reading names (1 of 2 read)");
  await expect(page.locator("#cbSresults"), "no match was claimed before A's name was read")
    .not.toContainText("No launch matches");

  await held.release();
  await expect(page.locator(`#cbSearch .cbHit[data-token="${ROW_A.token}"]`)).toHaveCount(1);
  await page.fill("#cbSq", "nothing-like-it");
  await expect(page.locator("#cbSresults")).toContainText("No launch matches");
});

/// NO REGISTRY, NO GUESS: a page opened with no rpc/lens pair says there is
/// nothing to search yet, rather than showing an empty list as an empty registry.
test("with no registry configured, the search says so", async ({ page }) => {
  await page.goto("/docs.html");
  await barReady(page);
  await page.click("#barSearch");
  await expect(page.locator("#cbSresults")).toContainText("No registry is configured", { timeout: 10_000 });
});

/// NOTHING IS FETCHED OR READ UNTIL THE SEARCH IS OPENED: no search.js, no
/// eth_call. A page that never searches pays nothing for it.
test("the search loads and reads nothing until it is opened", async ({ page }) => {
  const seen = { script: 0, calls: 0 };
  page.on("request", (r) => {
    if (r.url().endsWith("/search.js")) seen.script += 1;
    if (r.method() === "POST" && (r.postData() || "").includes("eth_call")) seen.calls += 1;
  });
  await page.goto("/docs.html?" + new URLSearchParams({ rpc: STATE.rpc, lens: STATE.lens }).toString());
  await barReady(page);
  await page.waitForTimeout(800);
  expect(seen, "the search was fetched or read before anyone opened it").toEqual({ script: 0, calls: 0 });
  await page.click("#barSearch");
  await expect(page.locator("#cbSearch .cbHit").first()).toBeVisible({ timeout: 30_000 });
  expect(seen.script).toBe(1);
  expect(seen.calls).toBeGreaterThan(0);
});
