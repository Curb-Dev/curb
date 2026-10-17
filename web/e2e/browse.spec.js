// THE DISCOVERY PAGE, CHECKED AGAINST THE CHAIN.  (B3)
//
// The point of these is not that the page renders. It is that what it shows
// agrees with what the contracts say - the count, the status of each launch and
// the progress bar - read here directly rather than from the same lens call the
// page made. A page that renders its own mistake consistently passes a test
// that only looks at the page.
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

const STATE = JSON.parse(fs.readFileSync(path.join(__dirname, ".state.json"), "utf8"));
const APP = STATE.app;
// A SECOND, SEPARATE DEPLOYMENT, whose launch is left sitting at its threshold.
// It is the only way to see the Waiting state without driving one there.
const OTHER = STATE.other;

// THE LIST ALONE (?hero=0): most tests here count the list's own reads, and
// the hero's - its launch, its day of trades - are its own test's to check.
const browseUrl = (lens) =>
  "/browse.html?" + new URLSearchParams({ rpc: STATE.rpc, lens, hero: "0" }).toString();
const heroUrl = (lens, q = {}) =>
  "/browse.html?" + new URLSearchParams({ rpc: STATE.rpc, lens, ...q }).toString();
/// web/config.js as the tests are served it (serve.js testConfig), with these
/// launches in its featured list: a ?featured= link is honoured only for one
/// config.js lists (browse.js featuredAllowed).
async function featuring(page, ...tokens) {
  const body = require("./serve.js").testConfig() +
    "\nwindow.CURB_SITE.featured = " + JSON.stringify(tokens) + ";\n";
  await page.route(/\/config\.js(\?.*)?$/, (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body }));
}

// ------------------------------------------------- reading the chain directly

let rpcId = 0;
async function rawCall(to, data) {
  const res = await fetch(STATE.rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "eth_call", params: [{ to, data }, "latest"] }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

// Selectors, written out rather than derived, so this file does not depend on
// the page's own keccak to agree with the page.
// Computed with `cast sig` rather than guessed. Two of these were wrong when
// first written by hand, which a test that never calls the right function
// would not have shown.
const SEL = {
  registry: "0x7b103999",       // registry()
  launchCount: "0x27cca59f",    // launchCount()
  isRegistered: "0xc3c5a547",   // isRegistered(address)
  launchState: "0x3cb24365",    // launchState(address)
  launchPage: "0xb55ab098",   // launchPage(uint256,uint256)
  tokenUri: "0x3c130d90",       // tokenURI()
  name: "0x06fdde03",               // name()
  launcherCount: "0xd48a4846",  // launcherCount()
  launcherAt: "0xfea7ee7a",     // launcherAt(uint256)
  quoteToken: "0x217a4b70",     // quoteToken()
  feeEscrow: "0xc4b7de97",      // feeEscrow() - out/CurbLaunchFactory.sol methodIdentifiers
  decimals: "0x313ce567",       // decimals()
  description: "0x7284e416",    // description() - a Chainlink feed's own name
  latestRoundData: "0xfeaf968c", // latestRoundData()
};
// LaunchRegistered(address,address,address), the registry's record of a launch.
const TOPIC_REGISTERED = "0x9fd8d418cff1010152155e55a312f5c2bbc5ce471864e9320174e12587793f0a";

async function registryOf(lens) {
  return "0x" + (await rawCall(lens, SEL.registry)).replace(/^0x/, "").slice(24);
}

const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const launcherAtData = (i) => SEL.launcherAt + word(i);

/// THE FACTORIES THE REGISTRY LISTS FOR A LAUNCH'S ASSET, read here and never
/// from the page. A registry may list more than one launcher on one asset, so
/// every candidate comes back and a link's factory must be one of them.
async function factoriesFor(lens, token) {
  const reg = await registryOf(lens);
  const view = (await rawCall(lens, SEL.launchState + token.replace(/^0x/, "").toLowerCase().padStart(64, "0")))
    .replace(/^0x/, "");
  const quote = "0x" + view.slice(2 * 64 + 24, 3 * 64);
  const n = Number(BigInt(await rawCall(reg, SEL.launcherCount)));
  const launchers = [];
  for (let i = 0; i < n; i++) {
    const f = "0x" + (await rawCall(reg, launcherAtData(i))).replace(/^0x/, "").slice(24);
    const q = "0x" + (await rawCall(f, SEL.quoteToken)).replace(/^0x/, "").slice(24);
    launchers.push({ factory: f.toLowerCase(), quote: q.toLowerCase() });
  }
  return { quote, launchers, candidates: launchers.filter((l) => l.quote === quote).map((l) => l.factory) };
}

/// The data field of a JSON-RPC eth_call a route intercepted, or "".
function callData(route) {
  const req = route.request();
  const raw = req.postData() || "";
  if (req.method() !== "POST" || !raw) return { msg: null, data: "" };
  let msg;
  try { msg = JSON.parse(raw); } catch { return { msg: null, data: "" }; }
  return { msg, data: ((msg.params && msg.params[0] && msg.params[0].data) || "").toLowerCase() };
}
async function launchCountOf(lens) {
  return Number(BigInt(await rawCall(await registryOf(lens), SEL.launchCount)));
}

// ------------------------------------------------------------------- the page

/// THE LAUNCH A LINK OPENS: its own page is token/0x…, so the token is the
/// path's, not a query parameter.
const tokenOf = (url) => (new URL(url).pathname.match(/\/token\/(0x[0-9a-fA-F]{40})/) || [])[1] || null;

/// THE ADDRESS A CARD NAMES. The card prints it short, 0x1234…abcd, as PONS
/// does, and carries the whole of it on the element's title - the two must be
/// the same address, or the screen and the title name different launches.
/// (The old list printed the whole address as the text; these tests read it
/// from there.)
async function addrOf(card) {
  const el = card.locator(".addr");
  const full = ((await el.getAttribute("title")) || "").trim();
  const shown = ((await el.textContent()) || "").trim();
  expect(full, "the card carries no whole address").toMatch(/^0x[0-9a-fA-F]{40}$/);
  expect(shown, "the short address on the card is not the one on its title").toBe(full.slice(0, 6) + "…" + full.slice(-4));
  return full;
}
const firstAddr = (page) => addrOf(page.locator(".launch").first());
/// THE CARD'S OWN LINK: the whole card is it (its ::after covers the card), and
/// a plain click is what names the launch's factory before handing off.
const openFirst = (page) => page.locator(".launch a.open").first().click();

test("the page lists what the registry holds, and says how many", async ({ page }) => {
  const onChain = await launchCountOf(APP.lens);
  expect(onChain, "the app deployment has no launches to browse").toBeGreaterThan(0);

  await page.goto(browseUrl(APP.lens));
  await expect(page.locator("#loaded")).toContainText(`of ${onChain} launches`, { timeout: 20000 });

  // Every row the page drew is a launch, and the number of rows matches what
  // the chain says - up to the page size, which is what "shown of total" means.
  const rows = page.locator(".launch");
  const shown = Number((await page.locator("#loaded").textContent()).match(/^(\d+) of/)[1]);
  await expect(rows).toHaveCount(shown);
});

test("a launch's address on screen resolves to a registered launch", async ({ page }) => {
  await page.goto(browseUrl(APP.lens));
  await expect(page.locator(".launch").first()).toBeVisible({ timeout: 20000 });

  const addr = await firstAddr(page);

  // isRegistered(address) on the registry the page says it used.
  const reg = await registryOf(APP.lens);
  const data = SEL.isRegistered + addr.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  const answer = await rawCall(reg, data);
  expect(BigInt(answer), `${addr} is on the page but not in the registry`).toBe(1n);
});

test("the progress shown is the one the curve graduates on, not the tradeable reserve", async ({ page }) => {
  await page.goto(browseUrl(APP.lens));
  await expect(page.locator(".launch").first()).toBeVisible({ timeout: 20000 });

  // THE CARD WITH THE BAR, and that same card is opened below. The old list put
  // every curve launch before every graduated one, so its first card was the
  // one measured; a grid sorted newest first may open on a graduated one.
  const curveRow = page.locator(".launch:has(.progress)").first();
  const progress = curveRow.locator(".progress");
  if (!(await progress.count())) test.skip(true, "no selling launch on this page to measure");

  // The exact figures are on the title attribute, in the quote asset's own
  // units - the rendered "12.34 of 60.00" is rounded and cannot be checked
  // against a chain read.
  const title = await progress.getAttribute("title");
  const [real, threshold] = title.match(/(\d+) of (\d+)/).slice(1).map(BigInt);
  expect(threshold, "a launch with no threshold cannot show progress").toBeGreaterThan(0n);

  const shownPct = Number((await progress.textContent()).match(/([\d.]+)%/)[1]);
  const expected = Number((real * 10000n) / threshold) / 100;
  expect(Math.abs(shownPct - expected), `screen said ${shownPct}%, the reserves say ${expected}%`).toBeLessThan(0.05);

  // AND IT IS THE REAL RESERVE, NOT THE TRADEABLE ONE. The tradeable reserve
  // includes the phantom quote, so an untouched launch would read as most of
  // the way to its threshold if the page used it. realQuoteReserve() on the
  // curve has to equal what the bar was drawn from.
  const onCard = await addrOf(curveRow);
  await curveRow.locator("a.open").click();
  await page.waitForURL(/\/token\/0x/);
  const token = tokenOf(page.url());
  expect(token.toLowerCase(), "the card measured is not the card opened").toBe(onCard.toLowerCase());

  const lensData = SEL.launchState + token.replace(/^0x/, "").toLowerCase().padStart(64, "0"); // launchState(address)
  const view = (await rawCall(APP.lens, lensData)).replace(/^0x/, "");
  const wordAt = (i) => BigInt("0x" + view.slice(i * 64, (i + 1) * 64));
  expect(wordAt(6), "the bar was not drawn from realQuoteReserve").toBe(real);
  expect(wordAt(7), "the bar was not drawn against graduationThreshold").toBe(threshold);
});

test("a launch sitting at its threshold is listed as waiting, with the button that ends it", async ({ page, context }) => {
  // The OTHER deployment is the one left at its threshold on purpose.
  await page.goto(browseUrl(OTHER.lens));
  await expect(page.locator("#loaded")).toContainText("launches", { timeout: 20000 });

  // THE CARD MARKED WAITING. There was a "Waiting to graduate" shelf of its own;
  // the grid has one list, and the card says it instead.
  const waiting = page.locator(".launch:has(.tag.waiting)");
  if (!(await waiting.count())) test.skip(true, "the other deployment is not in the waiting state on this run");

  await expect(waiting.locator(".tag.waiting").first()).toBeVisible();
  // NAMED FOR WHAT IT DOES. In this state both sides of the curve are shut and
  // the pool does not exist; the launch goes nowhere until somebody graduates
  // it, and anybody may.
  await expect(waiting.first().locator("a.act")).toHaveText("Graduate it");
  // AND IT GOES WHERE THAT IS DONE: the launch's own page, for this launch.
  const addr = await addrOf(waiting.first());
  // A CTRL CLICK OPENS IT IN A NEW TAB, as on any link - it was a button, and a
  // Ctrl or middle click on it did nothing at all.
  const [tab] = await Promise.all([
    context.waitForEvent("page", { timeout: 10000 }),
    waiting.first().locator("a.act").click({ modifiers: ["Control"] }),
  ]);
  await tab.waitForLoadState("domcontentloaded");
  expect(tokenOf(tab.url()).toLowerCase(), "the new tab is not this launch's page").toBe(addr.toLowerCase());
  await tab.close();
  expect(page.url(), "a Ctrl click also took this tab away").toContain("browse.html");
  await waiting.first().locator("a.act").click();
  await page.waitForURL(/\/token\/0x/, { timeout: 20000 });
  expect(tokenOf(page.url()).toLowerCase()).toBe(addr.toLowerCase());
});

test("the row hands off to app.html with the endpoint and lens it was read with", async ({ page }) => {
  await page.goto(browseUrl(APP.lens));
  await expect(page.locator(".launch").first()).toBeVisible({ timeout: 20000 });

  const addr = await firstAddr(page);
  await openFirst(page);
  await page.waitForURL(/\/token\/0x/);

  const q = new URL(page.url()).searchParams;
  // THE ENDPOINT TRAVELS WITH THE LINK. A page that read one node and then
  // handed the user to another would be showing them a different chain than
  // the one it listed.
  expect(q.get("rpc")).toBe(STATE.rpc);
  expect(q.get("lens")).toBe(APP.lens);
  expect(tokenOf(page.url()).toLowerCase()).toBe(addr.toLowerCase());
  // AND THE FACTORY THAT MADE IT: one the registry lists for this launch's
  // asset, and the one whose escrow the launch's curve pays into - the asset
  // alone does not say which, when two factories serve it (round 5, N25).
  const { candidates } = await factoriesFor(APP.lens, addr);
  expect(candidates.length, "the registry lists no factory for this launch's asset").toBeGreaterThan(0);
  expect(q.get("factory"), "the link carries no factory").toBeTruthy();
  expect(candidates, "the link names a factory that does not serve this launch's asset")
    .toContain(q.get("factory").toLowerCase());
  expect(await escrowOf(q.get("factory")), "the link names a factory whose escrow this launch does not pay into")
    .toBe(await escrowOf(await curveOf(APP.lens, addr)));
});

/// The escrow a factory or a curve names, read here and never from the page.
async function escrowOf(contract) {
  return "0x" + (await rawCall(contract, SEL.feeEscrow)).replace(/^0x/, "").slice(24).toLowerCase();
}
/// A launch's curve, word 1 of the lens's LaunchView.
async function curveOf(lens, token) {
  const view = (await rawCall(lens, SEL.launchState + token.replace(/^0x/, "").toLowerCase().padStart(64, "0")))
    .replace(/^0x/, "");
  return "0x" + view.slice(64 + 24, 2 * 64);
}

/// A LAUNCH IS LINKED TO THE FACTORY THAT MADE IT, not to its asset's
/// last-listed one. The map kept one factory per asset - the later - so with
/// two factories on one asset every launch of the older linked to the newer
/// (round 5, N25). Here the registry is made to list one more launcher, last,
/// on this launch's asset, with an escrow this launch does not pay into. The
/// link must still name the launch's own factory.
test("a launch is linked to the factory whose escrow its curve pays into, not its asset's last-listed one", async ({ page }) => {
  await page.goto(browseUrl(APP.lens));
  await expect(page.locator(".launch").first()).toBeVisible({ timeout: 20000 });
  const addr = await firstAddr(page);
  const { quote, launchers, candidates } = await factoriesFor(APP.lens, addr);
  const n = launchers.length;
  const FAKE = "0x00000000000000000000000000000000fac70001";
  const ELSEWHERE = "0x00000000000000000000000000000000e5c00001";
  let fakeRead = 0;
  await page.route("**/*", async (route) => {
    const { msg, data } = callData(route);
    if (!msg) return route.continue();
    const to = String((msg.params && msg.params[0] && msg.params[0].to) || "").toLowerCase();
    const reply = (v) => route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: "0x" + word(v) }) });
    if (data === SEL.launcherCount) return reply(n + 1);
    if (data === launcherAtData(n)) return reply(FAKE);
    if (to === FAKE && data === SEL.quoteToken) { fakeRead += 1; return reply(quote); }
    if (to === FAKE && data === SEL.feeEscrow) return reply(ELSEWHERE);
    return route.continue();
  });
  await page.goto(browseUrl(APP.lens));
  await expect(page.locator(".launch").first()).toBeVisible({ timeout: 20000 });
  expect((await firstAddr(page)).toLowerCase()).toBe(addr.toLowerCase());
  await openFirst(page);
  await page.waitForURL(/\/token\/0x/, { timeout: 20000 });
  expect(fakeRead, "the extra launcher was never read, so it was never a candidate").toBeGreaterThan(0);
  const f = (new URL(page.url()).searchParams.get("factory") || "").toLowerCase();
  expect(f, "the link went to the asset's last-listed factory, not the launch's own").not.toBe(FAKE);
  expect(candidates, "the link names no factory the registry really lists for this asset").toContain(f);
});

/// A FACTORY LIST THAT NEVER ARRIVES DOES NOT STRAND THE BUTTON. The click
/// waited on the map with no bound, so one read that hung instead of failing
/// left every button saying "Finding this launch's factory…" for good (round 4
/// S26, round 5). app.html resolves a link with no factory itself, so after a
/// bounded wait the click goes without one.
test("a factory list that never arrives does not strand the button", async ({ page }) => {
  await page.route("**/*", async (route) => {
    const { data } = callData(route);
    if (data === SEL.launcherCount) return;            // never answered
    return route.continue();
  });
  await page.goto(browseUrl(APP.lens));
  await expect(page.locator(".launch").first()).toBeVisible({ timeout: 20000 });
  const addr = await firstAddr(page);
  await openFirst(page);
  await expect(page.locator("#msg")).toContainText("Finding this launch's factory");
  await page.waitForURL(/\/token\/0x/, { timeout: 15000 });
  const q = new URL(page.url()).searchParams;
  expect(tokenOf(page.url()).toLowerCase()).toBe(addr.toLowerCase());
  expect(q.get("lens")).toBe(APP.lens);
  expect(q.get("factory"), "a factory was named with no factory list to take it from").toBeNull();
});

/// "SHOW OLDER" READS ONE PAGE AT A TIME. Two at once read the same window -
/// loadPage takes it from `shown` before its awaits - so it was drawn twice,
/// counted twice, and the next window could never be loaded (round 5, N24).
/// The registry is made to claim three launches and every page is served from
/// the one real launch at index 0; the second page's read is held while the
/// handler is called twice, and only one read may go out.
test("Show older does not run twice at once", async ({ page }) => {
  let holding = false;
  const held = [];
  let older = 0;
  await page.route("**/*", async (route) => {
    const { msg, data } = callData(route);
    if (!msg) return route.continue();
    if (data === SEL.launchCount) {
      return route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: "0x" + word(3) }) });
    }
    if (data.startsWith(SEL.launchPage)) {
      msg.params[0].data = SEL.launchPage + word(0) + word(1);
      const go = () => route.continue({ postData: JSON.stringify(msg) });
      if (holding) { older += 1; held.push(go); return; }
      return go();
    }
    return route.continue();
  });
  await page.goto(browseUrl(APP.lens) + "&pageSize=1");
  await expect(page.locator("#loaded")).toContainText("1 of 3 launches", { timeout: 20000 });

  holding = true;
  await page.evaluate(() => { const b = document.getElementById("more"); b.onclick(); b.onclick(); });
  await expect.poll(() => older, { message: "Show older never asked for a page" }).toBeGreaterThan(0);
  await page.waitForTimeout(500);
  expect(older, "two older pages were read at once").toBe(1);
  holding = false;
  for (const go of held.splice(0)) await go();
  await expect(page.locator("#loaded")).toContainText("2 of 3 launches", { timeout: 20000 });
  await expect(page.locator("#more")).toBeEnabled();
});

/// THE HEADING SAYS HOW MANY TOKENS HAVE BEEN CREATED, AND ONLY THAT (the
/// owner's call): the registry's own count, with no waiting and graduated
/// counts beside it, and no line breaking the loaded launches down by status
/// ("9 of 9 launches - 0 waiting, 0 near the threshold, 7 selling, 2
/// graduated"). The registry is made to claim five launches with one loaded,
/// then one.
test("the heading says how many tokens were created, with no status counts and no status line", async ({ page }) => {
  let claimed = 5;
  await page.route("**/*", async (route) => {
    const { msg, data } = callData(route);
    if (!msg) return route.continue();
    if (data === SEL.launchCount) {
      return route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: "0x" + word(claimed) }) });
    }
    if (data.startsWith(SEL.launchPage)) {
      msg.params[0].data = SEL.launchPage + word(0) + word(1);
      return route.continue({ postData: JSON.stringify(msg) });
    }
    return route.continue();
  });
  await page.goto(browseUrl(APP.lens) + "&pageSize=1");
  await expect(page.locator("#loaded")).toContainText("1 of 5 launches", { timeout: 20000 });
  await expect(page.locator(".countPill")).toHaveText("5 tokens created");
  await expect(page.locator(".exTitle"), "the heading still counts waiting or graduated launches").not.toContainText(/waiting|graduated/i);
  await expect(page.locator("#statWaiting, #statGrad, #statWaitingLabel, #statGradLabel")).toHaveCount(0);
  // NO STATUS LINE: the breakdown is gone from the page, not only from the heading.
  await expect(page.locator("main")).not.toContainText(/near the threshold|\d+ selling/);
  await expect(page.locator("#loaded"), "the loaded count is drawn where the eye meets it").toHaveClass(/srOnly/);

  claimed = 1;
  await page.goto(browseUrl(APP.lens) + "&pageSize=1");
  await expect(page.locator("#loaded")).toContainText("1 of 1 launches", { timeout: 20000 });
  await expect(page.locator(".countPill")).toHaveText("1 token created");
});

/// THE FIRST CARD DOES NOT WAIT ON THE FACTORY LIST, AND A CLICK DOES.
///
/// The factory map used to be read before the launch count, one launcher after
/// another: 23 sequential round trips with eleven assets before anything was
/// drawn (round 4, S26). Here launcherCount is held back. The card must appear
/// anyway, and a click on it must wait for the map rather than hand off without
/// the factory - so that half is checked too, before and after the release.
/// (The wait is bounded - browse.js CLICK_WAIT_MS, 5 s - and the release comes
/// well inside it; the test after the N25 one checks the bound.)
test("the first card is drawn before the factory list arrives, and a click waits for it", async ({ page }) => {
  const parked = [];
  let hold = true;
  await page.route("**/*", async (route) => {
    const { data } = callData(route);
    if (hold && data === SEL.launcherCount) { parked.push(route); return; }   // released below
    return route.continue();
  });
  await page.goto(browseUrl(APP.lens));
  await expect.poll(() => parked.length, { message: "the page never asked for the launchers", timeout: 20000 })
    .toBeGreaterThan(0);
  await expect(page.locator(".launch").first(), "the first card waited on the factory list")
    .toBeVisible({ timeout: 20000 });
  expect(parked.length, "the factory list was released early, so the card proved nothing").toBeGreaterThan(0);
  const addr = await firstAddr(page);

  await openFirst(page);
  await page.waitForTimeout(1000);
  expect(page.url(), "the click handed off before the factory list arrived").toContain("browse.html");

  hold = false;
  for (const r of parked) await r.continue();
  await page.waitForURL(/\/token\/0x/, { timeout: 20000 });
  const q = new URL(page.url()).searchParams;
  expect(tokenOf(page.url()).toLowerCase()).toBe(addr.toLowerCase());
  const { candidates } = await factoriesFor(APP.lens, addr);
  expect(candidates, "the link that waited still carries no factory for this launch's asset")
    .toContain((q.get("factory") || "").toLowerCase());
});

/// ONE LAUNCHER THAT CANNOT BE READ COSTS ONLY ITS OWN ASSET.
///
/// The map was one try around the whole loop, so a failure at launcher 0
/// dropped every launcher after it and every link went without a factory
/// (round 4, S26). Launcher 0 fails here, and launcher 1 is answered with this
/// card's own factory - so the card's link can carry it only if the page kept
/// reading past the failure. (Rewritten rather than found, because which index
/// holds which asset depends on the deployment.)
test("one launcher that cannot be read costs only its own asset's links", async ({ page }) => {
  await page.goto(browseUrl(APP.lens));
  await expect(page.locator(".launch").first()).toBeVisible({ timeout: 20000 });
  const addr = await firstAddr(page);
  const { quote, launchers } = await factoriesFor(APP.lens, addr);
  const home = launchers.findIndex((l) => l.quote === quote);
  expect(home, "the registry lists no factory for this launch's asset").toBeGreaterThanOrEqual(0);
  expect(launchers.length, "one launcher only: a failure there is the whole map failing").toBeGreaterThan(1);

  let failed = 0;
  let rewritten = 0;
  await page.route("**/*", async (route) => {
    const { msg, data } = callData(route);
    if (data === launcherAtData(0)) { failed += 1; return route.fulfill({ status: 500, body: "down" }); }
    if (data === launcherAtData(1)) {
      rewritten += 1;
      msg.params[0].data = launcherAtData(home);
      return route.continue({ postData: JSON.stringify(msg) });
    }
    return route.continue();
  });
  await page.goto(browseUrl(APP.lens));
  await expect(page.locator(".launch").first()).toBeVisible({ timeout: 20000 });
  expect((await firstAddr(page)).toLowerCase()).toBe(addr.toLowerCase());
  await openFirst(page);
  await page.waitForURL(/\/token\/0x/, { timeout: 20000 });
  expect(failed, "launcher 0 was never failed, so nothing was tested").toBeGreaterThan(0);
  expect(rewritten, "launcher 1 was never read: the page stopped at the failure").toBeGreaterThan(0);
  const q = new URL(page.url()).searchParams;
  expect(q.get("factory"), "one failed launcher took every link's factory with it").toBeTruthy();
  expect(launchers.filter((l) => l.quote === quote).map((l) => l.factory),
    "the link names a factory that does not serve this launch's asset").toContain(q.get("factory").toLowerCase());
});

/// A LAUNCHER READ THAT FAILED IS ASKED AGAIN WHEN ITS LAUNCH IS OPENED.
///
/// Per-launcher reads keep one failure from costing every asset, but the gap
/// they leave used to last the whole visit: every link to that asset went
/// without a factory, and a returning visitor who once chose another asset was
/// refused on app.html (round 4, S26). Every launcher serving this card's
/// asset fails its FIRST read here and answers after, so the card's link can
/// carry the factory only if the click asked again.
test("a launcher read that failed is asked again when its launch is opened", async ({ page }) => {
  await page.goto(browseUrl(APP.lens));
  await expect(page.locator(".launch").first()).toBeVisible({ timeout: 20000 });
  const addr = await firstAddr(page);
  const { launchers, quote, candidates } = await factoriesFor(APP.lens, addr);
  const homes = launchers.map((l, i) => (l.quote === quote ? i : -1)).filter((i) => i >= 0);
  expect(homes.length, "the registry lists no factory for this launch's asset").toBeGreaterThan(0);

  const asked = new Map(homes.map((i) => [launcherAtData(i), 0]));
  await page.route("**/*", async (route) => {
    const { data } = callData(route);
    if (asked.has(data)) {
      asked.set(data, asked.get(data) + 1);
      if (asked.get(data) === 1) return route.fulfill({ status: 500, body: "down" });
    }
    return route.continue();
  });
  await page.goto(browseUrl(APP.lens));
  await expect(page.locator(".launch").first()).toBeVisible({ timeout: 20000 });
  expect((await firstAddr(page)).toLowerCase()).toBe(addr.toLowerCase());
  // EVERY FIRST READ FAILED before the click, so the first map has the gap.
  await expect.poll(() => [...asked.values()].every((n) => n >= 1),
    { message: "a launcher on this asset was never read, so no gap was made", timeout: 20000 }).toBe(true);

  await openFirst(page);
  await page.waitForURL(/\/token\/0x/, { timeout: 20000 });
  expect([...asked.values()].some((n) => n >= 2), "no launcher on this asset was asked a second time").toBe(true);
  const q = new URL(page.url()).searchParams;
  expect(q.get("factory"), "a failed read cost this asset's link its factory for the whole visit").toBeTruthy();
  expect(candidates, "the link names a factory that does not serve this launch's asset")
    .toContain(q.get("factory").toLowerCase());
});

/// THE END OF THE LIST, which is reachable with any number of launches: when
/// everything has been shown the button is off and says so. pageSize=1 makes
/// the first page end immediately rather than after 25.
test("paging stops at the end of the list and says it has", async ({ page }) => {
  const total = await launchCountOf(APP.lens);
  await page.goto(browseUrl(APP.lens) + "&pageSize=1");
  await expect(page.locator("#loaded")).toContainText(`1 of ${total} launches`, { timeout: 20000 });
  await expect(page.locator(".launch")).toHaveCount(1);

  if (total === 1) {
    await expect(page.locator("#more")).toBeDisabled();
    await expect(page.locator("#more")).toHaveText("Nothing older");
  } else {
    await expect(page.locator("#more")).toBeEnabled();
  }
});

/// WALKING A SECOND PAGE IS NOT COVERED BY THIS FIXTURE, and saying so is the
/// point of this test rather than a note somewhere.
///
/// The stacks e2e builds hold ONE launch each - demo-app.sh says outright that
/// creating one is the demo - and making another needs a forge script, not
/// something a spec should be driving. So the browser's accumulate-and-append
/// path runs here only when a registry happens to hold more, and it SKIPS
/// loudly when it does not. It is not covered by "7 passed".
///
/// What IS covered, at the contract level and unconditionally, is the paging
/// itself: B20Graduation's test_browsingPagesAndStopsAtTheEnd and
/// test_aPageCarriesEachLaunchesState walk two launches through launchSlice and
/// launchPage, including the short read at the end.
test("paging walks the whole list without repeating or skipping a launch", async ({ page }) => {
  const total = await launchCountOf(APP.lens);
  test.skip(
    total < 2,
    `NOT COVERED: this registry holds ${total} launch, so the second-page path never runs. ` +
    `The contract-level paging is covered in B20Graduation.t.sol.`
  );

  await page.goto(browseUrl(APP.lens) + "&pageSize=1");
  await expect(page.locator("#loaded")).toContainText(`1 of ${total} launches`, { timeout: 20000 });
  await expect(page.locator(".launch")).toHaveCount(1);

  const seen = [];
  for (let i = 1; i <= total; i++) {
    await expect(page.locator(".launch")).toHaveCount(i);
    const addrs = await page.locator(".launch .addr").evaluateAll((els) => els.map((e) => e.title));
    seen.length = 0;
    seen.push(...addrs.map((a) => a.trim().toLowerCase()));
    if (i < total) {
      await expect(page.locator("#more")).toBeEnabled();
      await page.locator("#more").click();
      await expect(page.locator("#loaded")).toContainText(`${i + 1} of ${total}`, { timeout: 20000 });
    }
  }

  expect(seen.length, "the pages did not add up to the whole list").toBe(total);
  expect(new Set(seen).size, "a launch appeared on two pages").toBe(total);
  await expect(page.locator("#more")).toBeDisabled();
  await expect(page.locator("#more")).toHaveText("Nothing older");
});

test("a lens address with no contract behind it says so, in words", async ({ page }) => {
  // eth_call to an address with no code returns "0x" rather than reverting, and
  // decoding that raises "Cannot convert 0x to a BigInt" - which is what this
  // page used to put in front of a reader who had pasted a wrong address.
  await page.goto(browseUrl("0x000000000000000000000000000000000000dEaD"));
  await expect(page.locator("#msg")).toContainText("no lens answered", { timeout: 20000 });
  await expect(page.locator("#msg")).not.toContainText("BigInt");
  await expect(page.locator(".launch")).toHaveCount(0);
});

test("an empty or unreachable registry says so instead of drawing an empty list", async ({ page }) => {
  // A lens address with no contract behind it: the read fails, and the page has
  // to say that rather than render zero launches as though it had looked.
  await page.goto(browseUrl("0x000000000000000000000000000000000000dEaD"));
  await expect(page.locator("#msg")).toContainText(/Could not read|no launches/, { timeout: 20000 });
  await expect(page.locator(".launch")).toHaveCount(0);
});

/// A PAGE IS NEVER ASKED OF THE LENS LARGER THAN THE LENS WILL ANSWER, AND A
/// SHORT ANSWER IS SAID RATHER THAN COUNTED.
///
/// LaunchLens caps a page at 50. The page used to accept ?pageSize up to 200,
/// ask for all of it, get the oldest 50 of the window back and count 200 as
/// shown - so the newest 150 were skipped for good. Here the registry is made
/// to claim 120 launches: the request must be held to 50, and when the lens
/// answers with fewer than asked, that must be reported, not counted as shown.
test("a page is held to the lens's ceiling, and a short answer is reported", async ({ page }) => {
  const asked = [];
  await page.route("**/*", async (route) => {
    const req = route.request();
    const raw = req.postData() || "";
    if (req.method() !== "POST" || !raw) return route.continue();
    let msg;
    try { msg = JSON.parse(raw); } catch { return route.continue(); }
    const data = ((msg.params && msg.params[0] && msg.params[0].data) || "").toLowerCase();
    if (data === SEL.launchCount) {
      const body = { jsonrpc: "2.0", id: msg.id, result: "0x" + (120).toString(16).padStart(64, "0") };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    }
    if (data.startsWith(SEL.launchPage)) {
      asked.push(Number(BigInt("0x" + data.slice(-64))));
      // THE LENS ANSWERS SHORT: the request is rewritten to ask for ONE launch
      // from the start of the registry, which exists, so what comes back is a
      // real one-entry page where the page asked for a full one. (Asking the
      // real registry for a window past its end reverts instead of shortening.)
      msg.params[0].data = SEL.launchPage + "0".repeat(64) + (1).toString(16).padStart(64, "0");
      return route.continue({ postData: JSON.stringify(msg) });
    }
    return route.continue();
  });
  await page.goto(browseUrl(APP.lens) + "&pageSize=200");
  await expect.poll(() => asked.length, { message: "the page never asked the lens for a page" }).toBeGreaterThan(0);
  expect(Math.max(...asked), "the page asked for more than the lens will describe").toBeLessThanOrEqual(50);
  await expect(page.locator("#msg")).toContainText("for a page of 50");
});

/// AN IMAGE STORED AS BYTES IS SHOWN, AND A NAME IS READ AS UTF-8.
///
/// The create form stores the picture itself as a data:image/webp URI; the
/// browse page only let http/https/ipfs through, so no launch made by this
/// product ever showed its image here. And names were decoded one byte per
/// character, so anything outside ASCII came out as mojibake.
test("an image stored as bytes is shown, and a name is read as UTF-8", async ({ page }) => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const meta = { image: "data:image/png;base64," + png, description: "" };
  const uri = "data:application/json;base64," + Buffer.from(JSON.stringify(meta)).toString("base64");
  const abiString = (s) => {
    const hex = Buffer.from(s, "utf8").toString("hex");
    const len = Buffer.byteLength(s, "utf8");
    return "0x" + (32).toString(16).padStart(64, "0") + len.toString(16).padStart(64, "0") +
      hex.padEnd(Math.ceil(hex.length / 64) * 64 || 64, "0");
  };
  const NAME = "Çay ☕ Keşif";
  await page.route("**/*", async (route) => {
    const req = route.request();
    const raw = req.postData() || "";
    if (req.method() !== "POST" || !raw) return route.continue();
    let msg;
    try { msg = JSON.parse(raw); } catch { return route.continue(); }
    const data = ((msg.params && msg.params[0] && msg.params[0].data) || "").toLowerCase();
    const reply = (result) => route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) });
    if (data === SEL.tokenUri) return reply(abiString(uri));
    if (data === SEL.name) return reply(abiString(NAME));
    return route.continue();
  });
  await page.goto(browseUrl(APP.lens));
  await expect(page.locator("img[src^='data:image/png;base64,']").first(),
    "no launch drew an image stored as bytes").toBeAttached({ timeout: 30_000 });
  await expect(page.getByText(NAME).first(), "a UTF-8 name was not decoded as UTF-8").toBeAttached();
});

/// WHAT safeImage REFUSES, AND WHERE IT DOES NOT REACH. Only raster types in
/// base64 are drawn from a data: URI, and a data: URI never becomes a link.
test("an svg or html data URI is not drawn, and a data: link is not offered", async ({ page }) => {
  const svg = "data:image/svg+xml;base64," + Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>").toString("base64");
  // THE LINK HALF WITH TEETH: a data: URI safeImage WOULD accept, in a link
  // field - so only the image-only rule keeps it from becoming an href - and a
  // positive control, so the test fails if the metadata was never parsed.
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const meta = { image: svg, website: png, twitter: "https://x.com/curbfun", description: "" };
  const uri = "data:application/json;base64," + Buffer.from(JSON.stringify(meta)).toString("base64");
  const abiString = (str) => {
    const hex = Buffer.from(str, "utf8").toString("hex");
    return "0x" + (32).toString(16).padStart(64, "0") + Buffer.byteLength(str, "utf8").toString(16).padStart(64, "0") +
      hex.padEnd(Math.ceil(hex.length / 64) * 64 || 64, "0");
  };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const raw = req.postData() || "";
    if (req.method() !== "POST" || !raw) return route.continue();
    let m; try { m = JSON.parse(raw); } catch { return route.continue(); }
    const data = ((m.params && m.params[0] && m.params[0].data) || "").toLowerCase();
    if (data === SEL.tokenUri) {
      return route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id: m.id, result: abiString(uri) }) });
    }
    return route.continue();
  });
  await page.goto(browseUrl(APP.lens));
  await expect(page.locator(".launch").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("img[src^='data:image/svg']")).toHaveCount(0);
  await expect(page.locator("a[href^='data:']")).toHaveCount(0);
  // IN A CARD. The header carries an x.com/curbfun link of its own, so an
  // unscoped control was satisfied before any metadata was parsed.
  await expect(page.locator(".launch a[href^='https://x.com/curbfun']").first(),
    "the positive control is missing: the metadata was never parsed").toBeAttached();
});

/// AND AN IMAGE THAT IS TOO LARGE, OR NOT BASE64, IS NOT DRAWN EITHER.
test("an oversized or non-base64 data image is not drawn", async ({ page }) => {
  // BOTH ARE REAL IMAGES, and that is checked below. A broken picture is taken
  // off the page by its own onerror fallback, so the "A" * 70 KB and the
  // "not-base64-at-all" this used were never drawn whatever the rules said -
  // the test passed with the size check deleted.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  // Past the 64 KB ceiling with bytes after IEND, which a decoder ignores.
  const big = "data:image/png;base64," + Buffer.concat([png, Buffer.alloc(70 * 1024)]).toString("base64");
  // The same picture, percent-encoded rather than base64.
  const raw = "data:image/png," + [...png].map((x) => "%" + x.toString(16).padStart(2, "0")).join("");
  const abiString = (str) => {
    const hex = Buffer.from(str, "utf8").toString("hex");
    return "0x" + (32).toString(16).padStart(64, "0") + Buffer.byteLength(str, "utf8").toString(16).padStart(64, "0") +
      hex.padEnd(Math.ceil(hex.length / 64) * 64 || 64, "0");
  };
  // ONE PICTURE PER PAGE LOAD, served to every card. It used to alternate the
  // two across cards, which needs two cards - and a run of this file on its
  // own has one.
  let image = big;
  let served = 0;
  await page.route("**/*", async (route) => {
    const req = route.request();
    const body = req.postData() || "";
    if (req.method() !== "POST" || !body) return route.continue();
    let m; try { m = JSON.parse(body); } catch { return route.continue(); }
    const data = ((m.params && m.params[0] && m.params[0].data) || "").toLowerCase();
    if (data === SEL.tokenUri) {
      served += 1;
      const meta = { image, twitter: "https://x.com/curbprobe" };
      const uri = "data:application/json;base64," + Buffer.from(JSON.stringify(meta)).toString("base64");
      return route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id: m.id, result: abiString(uri) }) });
    }
    return route.continue();
  });

  for (const [label, picture] of [["oversized", big], ["non-base64", raw]]) {
    image = picture;
    served = 0;
    await page.goto(browseUrl(APP.lens));
    // THE PRECONDITION: this picture would be drawn if the rules let it through.
    const decodes = await page.evaluate(async (src) => {
      const i = new Image();
      i.src = src;
      try { await i.decode(); return true; } catch { return false; }
    }, picture);
    expect(decodes, `the ${label} picture is not a real image, so the page would hide it anyway`).toBe(true);
    // A CARD DRAWN WITH THIS METADATA - in a card, with a handle the header
    // does not carry. The header's own x.com/curbfun link used to satisfy this
    // before a single card existed, so the count was taken on an empty list.
    await expect.poll(() => served, { message: `the ${label} picture was never served`, timeout: 30_000 })
      .toBeGreaterThanOrEqual(1);
    await expect(page.locator(".launch a[href^='https://x.com/curbprobe']").first()).toBeAttached({ timeout: 30_000 });
    await expect(page.locator("img[src^='data:image']"), `the ${label} picture was drawn`).toHaveCount(0);
  }
});

/// A FAILED DECIMALS READ IS ASKED AGAIN. Only the first decimals() call
/// fails. The page shows that as raw units; the next read of the same asset
/// must ask again and get 8 - two reads at once sharing one request - and a
/// complete answer must then be kept.
///
/// ASKED THROUGH window.CurbBrowse, not by paging. This used to look for a
/// later card on the same asset behind "Show older", and the fixture has one
/// selling launch - so it could never pass, and was never green.
test("a failed decimals read is not remembered", async ({ page }) => {
  let failed = false;
  let decimalsCalls = 0;
  await page.route("**/*", async (route) => {
    const req = route.request();
    const body = req.postData() || "";
    if (req.method() !== "POST" || !body) return route.continue();
    let m; try { m = JSON.parse(body); } catch { return route.continue(); }
    const data = ((m.params && m.params[0] && m.params[0].data) || "").toLowerCase();
    const to = ((m.params && m.params[0] && m.params[0].to) || "").toLowerCase();
    // NVDAc's OWN decimals() only. Failing the first decimals() of any asset
    // made the test depend on which card the page reads first - a graduated
    // card, on another asset, has no progress line to show "raw units" on.
    if (data === "0x313ce567" && to === "0xb20000000000000000000078ee7ce2fe4908108c") {
      decimalsCalls += 1;
      if (!failed) { failed = true; return route.fulfill({ status: 500, body: "once" }); }
    }
    return route.continue();
  });

  // THE FAILURE IS SEEN FIRST: the card on that asset falls back to raw units,
  // with the symbol - whose read did not fail - still beside it. On the market
  // cap now: the old list said "X of Y" beside the bar, the grid shows the
  // market cap there, and it is the figure the asset's decimals scale.
  const lines = () => page.locator(".launch .mc .mcVal").allTextContents();
  await page.goto(browseUrl(APP.lens));
  await expect.poll(async () => (await lines()).some((t) => t.includes("raw units")),
    { message: "no card fell back to raw units", timeout: 30_000 }).toBe(true);
  expect(failed, "the decimals read was never failed").toBe(true);
  const rawLine = (await lines()).find((t) => t.includes("raw units")).trim();
  const sym = rawLine.split(/\s+/).pop();
  expect(sym, "the raw-units line lost its symbol").toBe("NVDAc");

  // THEN THE NEXT READ OF THAT ASSET ASKS AGAIN - two at once, sharing ONE
  // request - and gets the real answer. A remembered failure (a cached null,
  // or the failed promise left in flight) would hand back null here.
  const NVDAC = "0xb20000000000000000000078ee7ce2fE4908108C";
  const before = decimalsCalls;
  const again = await page.evaluate(async (asset) => {
    const b = window.CurbBrowse;
    const [x, y] = await Promise.all([b.quoteMetaFor(b.rpc, asset), b.quoteMetaFor(b.rpc, asset)]);
    return [x.decimals, y.decimals];
  }, NVDAC);
  expect(again, "the failed read was remembered").toEqual([8, 8]);
  expect(decimalsCalls - before, "two reads at once did not share one request").toBe(1);

  // AND A COMPLETE ANSWER IS KEPT: a third read sends nothing.
  await page.evaluate((asset) => window.CurbBrowse.quoteMetaFor(window.CurbBrowse.rpc, asset), NVDAC);
  expect(decimalsCalls - before, "a complete answer was not kept").toBe(1);
});

/// A QUOTE ASSET THAT WILL NOT GIVE ITS DECIMALS IS SHOWN IN RAW UNITS, said as
/// such - not guessed at 8, which is 10^10 wrong for WETH, and not cached.
test("a quote asset whose decimals cannot be read is shown in raw units", async ({ page }) => {
  await page.route("**/*", async (route) => {
    const req = route.request();
    const raw = req.postData() || "";
    if (req.method() !== "POST" || !raw) return route.continue();
    let m; try { m = JSON.parse(raw); } catch { return route.continue(); }
    const data = ((m.params && m.params[0] && m.params[0].data) || "").toLowerCase();
    if (data === "0x313ce567") return route.fulfill({ status: 500, body: "rate limited" });
    return route.continue();
  });
  await page.goto(browseUrl(APP.lens));
  // A CARD ON THE CURVE: a graduated one's market cap is its pool's, which the
  // grid does not draw, so it has no figure in any unit (and the old list put
  // curve launches first, which a grid sorted newest first does not).
  const curve = page.locator(".launch:has(.progress)").first();
  await expect(curve).toBeVisible({ timeout: 30_000 });
  await expect(curve.locator(".mc .mcVal")).toContainText("raw units");
  // AND NOT DOLLARS: a dollar figure needs the scale that could not be read.
  await expect(curve.locator(".mc .mcVal")).not.toContainText("$");
});

// ------------------------------------------------------------- the Explore grid
//
// WHAT THE GRID ADDED (the owner's call, after PONS's Explore): the market cap
// in dollars on every card, how long ago each launch was made, a time filter,
// and Oldest as a question about the registry's other end. Each is checked
// against the chain read here, not against the page's own figures.

// CHAINLINK'S DOLLAR FEEDS FOR THE FIXTURE'S ASSETS, from Chainlink's directory
// for Base - token.spec.js's copy, not prices.js - each used only after it names
// itself on chain as the feed written here.
const FEEDS = {
  "0x4200000000000000000000000000000000000006": ["0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70", "ETH / USD"],
  "0xb20000000000000000000078ee7ce2fe4908108c": ["0x04689a41629776563e6822f76f2e57d148d28513", "Coinbase NVDA"],
  "0xb200000000000000000000c2e324d24d7eecd1fb": ["0x787f13dea48db0897cbcdd985de77809d837f988", "Coinbase AAPL"],
  "0xb2000000000000000000008501b13360000cb2ec": ["0x69e5bc4988a9af30ec827c5609c0d41028446ec0", "ZEC / USD"],
};

async function rpcRaw(method, params) {
  const res = await fetch(STATE.rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(method + ": " + body.error.message);
  return body.result;
}
function stringOf(raw) {
  const hex = String(raw).replace(/^0x/, "");
  const len = Number(BigInt("0x" + hex.slice(64, 128)));
  return Buffer.from(hex.slice(128, 128 + len * 2), "hex").toString();
}
/// A launch's LaunchView from the lens, the words the grid draws from.
async function launchView(lens, token) {
  const v = (await rawCall(lens, SEL.launchState + token.replace(/^0x/, "").toLowerCase().padStart(64, "0")))
    .replace(/^0x/, "");
  const w = (i) => BigInt("0x" + v.slice(i * 64, (i + 1) * 64));
  return { status: Number(w(0)), quote: "0x" + v.slice(2 * 64 + 24, 3 * 64), quoteReserve: w(4), tokenReserve: w(5),
    totalSupply: w(8) };
}
/// Dollars per whole unit of `quote`, by its own feed, after the feed names itself.
async function feedUsdOf(quote) {
  const f = FEEDS[quote.toLowerCase()];
  expect(stringOf(await rawCall(f[0], SEL.description)), "the feed is not the one written here").toBe(f[1]);
  const dec = Number(BigInt(await rawCall(f[0], SEL.decimals)));
  const answer = BigInt("0x" + (await rawCall(f[0], SEL.latestRoundData)).replace(/^0x/, "").slice(64, 128));
  return Number(answer) / 10 ** dec;
}
/// A figure as the card prints it - "$13.2K" - back into a number.
function shownNumber(s) {
  const m = String(s).replace(/,/g, "").match(/([0-9.]+)\s*([KMBT])?/);
  if (!m) return NaN;
  return Number(m[1]) * ({ K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[m[2]] || 1);
}

// ------------------------------------------------- pages of launches, served
//
// THE FIXTURE'S APP REGISTRY HOLDS ONE LAUNCH, and an order, a second asset or
// a launch past the threshold needs more than one. So a test can serve the page
// a launchPage answer of its own: every record starts as the real launch's
// fourteen words, read here from the lens, and the test rewrites the words it
// is about. The figures checked are then computed from the words SERVED.
//
// LaunchView, word by word: 0 status, 1 curve, 2 quoteToken, 3 beneficiary,
// 4 quoteReserve, 5 tokenReserve, 6 realQuoteReserve, 7 graduationThreshold,
// 8 totalSupply, 9-13 poolKey (currency0, currency1, fee, tickSpacing, hooks).
const W = { status: 0, quote: 2, quoteReserve: 4, tokenReserve: 5, real: 6, threshold: 7, supply: 8, c0: 9 };
// AN ASSET WITH NO FEED: on Base a symbol and decimals, and no feed in
// prices.js. Circle's EURC, six decimals, read back on live Base on 2026-10-15
// ("EURC", 6). It was USDC until USDC became a quote asset that day, priced by
// USDC / USD - which turned every "has no dollars" check here into a card with
// dollars.
const NO_FEED = "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42";
// THE CARD THE NVDA FEED PRICES: the newest NVDAc launch still on its curve.
// Not simply the first card with a bar - assets.spec.js runs before this file
// and leaves the newest launches on USDC, VIRTUAL and AERO, which the NVDA
// feed has nothing to do with.
const nvdacCurveCard = (page) =>
  page.locator('.launch:has(.progress):has(.pairBadge[title="Paired with NVDAc"])').first();
const WETH_ADDR = "0x4200000000000000000000000000000000000006";
const NVDAC = "0xb20000000000000000000078ee7ce2fe4908108c";
const NVDA_FEED = "0x04689a41629776563e6822f76f2e57d148d28513";
const STATE_VIEW = "0xa3c0c9b65bad0b08107aa264b0f3db444b867a71";   // Uniswap v4 StateView on Base
const GET_SLOT0 = "0xc815641c";   // getSlot0(bytes32)
const SYMBOL = "0x95d89b41";      // symbol()
const TOTAL_SUPPLY = "0x18160ddd"; // totalSupply()
const GRADUATE = "0xff6d8d05";    // graduate(address) - the Graduator's, open to anyone
const DEPLOYER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";   // anvil's first account, unlocked on the fork
const addrWord = (a) => String(a).replace(/^0x/, "").toLowerCase().padStart(64, "0");
const big = (w) => BigInt("0x" + w);
/// A string as a contract returns it.
function abiStr(s) {
  const hex = Buffer.from(s, "utf8").toString("hex");
  return "0x" + word(32) + word(Buffer.byteLength(s, "utf8")) + hex.padEnd(Math.ceil(hex.length / 64) * 64 || 64, "0");
}
const rpcReply = (route, id, result) => route.fulfill({ status: 200, contentType: "application/json",
  body: JSON.stringify({ jsonrpc: "2.0", id, result }) });
const rpcRefuse = (route, id, code, message) => route.fulfill({ status: 200, contentType: "application/json",
  body: JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) });

/// The real launch at index 0 of a registry: its token and every word of its
/// record - sixteen from the current lens, fourteen from one before launchedAt
/// and the holder distributor were appended. The length is read off the answer.
async function realRecord(lens) {
  const hex = (await rawCall(lens, SEL.launchPage + word(0) + word(1))).replace(/^0x/, "");
  const at = (i) => hex.slice(i * 64, (i + 1) * 64);
  const tokensAt = Number(big(at(0))) / 32;
  const viewsAt = Number(big(at(1))) / 32;
  const stride = hex.length / 64 - viewsAt - 1;
  return { token: "0x" + at(tokensAt + 1).slice(24), words: Array.from({ length: stride }, (_, i) => at(viewsAt + 1 + i)) };
}
/// A launchPage answer's records, cut to the fourteen words a lens from before
/// core v2 returned - so the page under test meets the lens it must still read.
function toOldLens(result) {
  const hex = String(result || "").replace(/^0x/, "");
  const at = (i) => hex.slice(i * 64, (i + 1) * 64);
  const tokensAt = Number(big(at(0))) / 32;
  const viewsAt = Number(big(at(1))) / 32;
  const n = Number(big(at(tokensAt)));
  if (!n) return result;
  const stride = (hex.length / 64 - viewsAt - 1) / n;
  const records = [];
  for (let i = 0; i < n; i++) {
    records.push({ token: "0x" + at(tokensAt + 1 + i).slice(24),
      words: Array.from({ length: 14 }, (_, j) => at(viewsAt + 1 + i * stride + j)) });
  }
  return encodePage(records);
}
/// EVERY launchPage ANSWER AS A 14-WORD LENS GIVES IT: no launchedAt, no holder
/// distributor. The cards' ages then come from the log scan, which is what the
/// tests of that scan are about.
async function asOldLens(page) {
  await page.route("**/*", async (route) => {
    const { msg, data } = callData(route);
    if (!msg || !data.startsWith(SEL.launchPage)) return route.fallback();
    const res = await route.fetch();
    const body = await res.json();
    if (body && body.result) body.result = toOldLens(body.result);
    return route.fulfill({ response: res, body: JSON.stringify(body) });
  });
}
/// An ABI-encoded (address[], LaunchView[]) answer for these records.
function encodePage(records) {
  const n = records.length;
  const out = [word(64), word(64 + 32 * (1 + n)), word(n)];
  for (const r of records) out.push(addrWord(r.token));
  out.push(word(n));
  for (const r of records) out.push(...r.words);
  return "0x" + out.join("");
}
/// Serves the page a registry of `count` launches, record i being make(i, a
/// fresh copy of the real record). Routes registered after this one are asked
/// first; what they pass on with route.fallback() reaches this one. Returns the
/// real record and the launchPage start indices the page asked for.
async function servePages(page, lens, count, make) {
  const real = await realRecord(lens);
  const starts = [];
  await page.route("**/*", async (route) => {
    const { msg, data } = callData(route);
    if (!msg) return route.continue();
    if (data === SEL.launchCount) return rpcReply(route, msg.id, "0x" + word(count));
    if (data.startsWith(SEL.launchPage)) {
      const start = Number(BigInt("0x" + data.slice(10, 74)));
      const n = Number(BigInt("0x" + data.slice(74, 138)));
      starts.push(start);
      const recs = [];
      for (let i = start; i < Math.min(count, start + n); i++) {
        const copy = { token: real.token, words: real.words.slice() };
        recs.push(make(i, copy) || copy);
      }
      return rpcReply(route, msg.id, encodePage(recs));
    }
    return route.continue();
  });
  return { real, starts };
}
/// The cards' registry indices, in the order on screen.
const order = (page) => page.locator(".launch").evaluateAll((els) => els.map((e) => Number(e.dataset.index)));
async function decimalsOf(asset) { return Number(BigInt(await rawCall(asset, SEL.decimals))); }
async function symbolOf(asset) { return stringOf(await rawCall(asset, SYMBOL)); }
/// The JSON-RPC message a route intercepted, single or batch, or null.
function rpcMsg(route) {
  const req = route.request();
  if (req.method() !== "POST") return null;
  try { return JSON.parse(req.postData() || ""); } catch { return null; }
}
/// THE MARKET CAP ON A CARD IS THE CURVE'S PRICE TIMES THE SUPPLY, IN DOLLARS by
/// the asset's own feed: quoteReserve / tokenReserve per token (the tradeable
/// reserves, which are what the curve prices at), times totalSupply, times the
/// feed's answer - with where the dollars come from on the tooltip.
///
/// THE TOKEN RESERVE IS SERVED AT A THIRD OF ITSELF. On a fresh launch it equals
/// the supply, so the ratio was exactly 1 and "quoteReserve in dollars" passed
/// for the market cap (a mutant dropping supply / tokenReserve survived).
test("a curve card's market cap is its price times the supply, in dollars by the asset's own feed", async ({ page }) => {
  const { real } = await servePages(page, APP.lens, 1, (i, r) => {
    r.words[W.tokenReserve] = word(big(r.words[W.tokenReserve]) / 3n);
    return r;
  });
  const quote = "0x" + real.words[W.quote].slice(24);
  expect(FEEDS[quote], "the fixture's launch is paired with an asset whose feed this file does not name").toBeTruthy();
  const qr = big(real.words[W.quoteReserve]);
  const tr = big(real.words[W.tokenReserve]) / 3n;
  const supply = big(real.words[W.supply]);
  expect(tr > 0n && tr !== supply, "the served token reserve equals the supply, so the ratio proves nothing").toBe(true);

  await page.goto(browseUrl(APP.lens));
  const card = page.locator(".launch").first();
  await expect(card.locator(".mc .mcVal"), "the card never showed dollars").toContainText("$", { timeout: 30000 });
  const qd = await decimalsOf(quote);
  const per = await feedUsdOf(quote);
  const want = (Number((qr * supply) / tr) / 10 ** qd) * per;
  const shown = await card.locator(".mc .mcVal").textContent();
  expect(Math.abs(shownNumber(shown) - want) / want,
    `the card's market cap is not the curve's price times the supply in dollars: ${shown}, want $${want.toFixed(2)}`)
    .toBeLessThan(0.02);
  const title = await card.locator(".mc").getAttribute("title");
  expect(title, "the figure does not say where its dollars come from").toContain("Chainlink");
  // AND THE SAME FIGURE IN THE PAIR'S OWN ASSET, on the tooltip.
  const sym = await symbolOf(quote);
  const inPair = shownNumber(title.split(" " + sym)[0]);
  const wantPair = Number((qr * supply) / tr) / 10 ** qd;
  expect(Math.abs(inPair - wantPair) / wantPair, "the tooltip's figure in the pair's asset is wrong: " + title).toBeLessThan(0.02);
  // THE PAIRED ASSET'S BADGE (the owner's list): its symbol as the asset itself
  // gives it, on the picture.
  await expect(card.locator(".pairBadge")).toHaveAttribute("title", "Paired with " + sym);
  await expect(card.locator(".pairBadge b")).toHaveText(sym);
});

/// A GRADUATED LAUNCH TRADES IN ITS POOL, so its curve's last price is not its
/// market cap and must not be drawn as one. Every launch on the page is made to
/// read as graduated while its curve still holds tokens and no pool exists for
/// it - a card that priced off the curve would show a figure - and every card
/// must show "—", say its pool gave no price, and carry the Graduated mark
/// instead of the bar. (The pool's own price is checked against a real pool at
/// the end of this file.)
test("a graduated launch whose pool gives no price shows no market cap, never its curve's last price", async ({ page }) => {
  let rewritten = 0;
  let priceable = 0;
  await page.route("**/*", async (route) => {
    const { msg, data } = callData(route);
    // EVERY POOL GIVES NO PRICE - a launch that really graduated earlier in
    // the run (app.spec.js graduates one on this lens) included, whose pool
    // would otherwise answer with its real price.
    const to = String((msg && msg.params && msg.params[0] && msg.params[0].to) || "").toLowerCase();
    if (msg && to === STATE_VIEW && data.startsWith(GET_SLOT0)) return rpcReply(route, msg.id, "0x" + word(0).repeat(4));
    if (!msg || !data.startsWith(SEL.launchPage)) return route.continue();
    const res = await route.fetch();
    const body = await res.json();
    let hex = String(body.result || "").replace(/^0x/, "");
    const viewsAt = Number(BigInt("0x" + hex.slice(64, 128))) * 2;
    const n = Number(BigInt("0x" + hex.slice(viewsAt, viewsAt + 64)));
    // THE RECORD'S LENGTH FROM THE ANSWER, as the page reads it.
    const stride = n ? (hex.length - viewsAt - 64) / 64 / n : 14;
    for (let i = 0; i < n; i++) {
      const at = viewsAt + 64 + i * stride * 64;
      if (BigInt("0x" + hex.slice(at + 5 * 64, at + 6 * 64)) > 0n) priceable += 1;   // tokenReserve
      hex = hex.slice(0, at) + word(3) + hex.slice(at + 64);
      rewritten += 1;
    }
    body.result = "0x" + hex;
    return route.fulfill({ response: res, body: JSON.stringify(body) });
  });
  await page.goto(browseUrl(APP.lens));
  await expect(page.locator(".launch").first()).toBeVisible({ timeout: 20000 });
  expect(rewritten, "no launch was made to read as graduated").toBeGreaterThan(0);
  expect(priceable, "no launch's curve held tokens, so a curve price could not have been drawn anyway").toBeGreaterThan(0);
  // Long enough for the dollars to land, were a curve price going to be drawn.
  await page.waitForTimeout(3000);
  const cards = page.locator(".launch");
  for (let i = 0; i < (await cards.count()); i++) {
    await expect(cards.nth(i).locator(".mc .mcVal")).toHaveText("—");
    await expect(cards.nth(i).locator(".mc")).toHaveAttribute("title", /pool gave no price/);
    await expect(cards.nth(i).locator(".tag.graduated")).toBeVisible();
    await expect(cards.nth(i).locator(".progress")).toHaveCount(0);
  }
});

/// HOW LONG AGO A LAUNCH WAS MADE IS ITS REGISTRY RECORD'S BLOCK TIME. Read here
/// from the registry's own LaunchRegistered event and that block, and compared
/// with the exact time the card carries and the rounded one it prints.
for (const stride of [16, 14]) test(`a card says how long ago it launched, by the block the registry recorded it in (${stride}-word lens)`, async ({ page }) => {
  // FROM LaunchView w14 ON THE CURRENT LENS, from the registry's log on one
  // without it: the same block's time either way.
  if (stride === 14) await asOldLens(page);
  await page.goto(browseUrl(APP.lens));
  const card = page.locator(".launch").first();
  await expect(card).toBeVisible({ timeout: 20000 });
  const addr = await addrOf(card);
  const meta = await rpcRaw("anvil_metadata", []).catch(() => null);
  const from = meta && meta.forkedNetwork ? Number(meta.forkedNetwork.forkBlockNumber) + 1 : 0;
  const logs = await rpcRaw("eth_getLogs", [{ address: await registryOf(APP.lens),
    topics: [TOPIC_REGISTERED, "0x" + addr.replace(/^0x/, "").toLowerCase().padStart(64, "0")],
    fromBlock: "0x" + from.toString(16), toBlock: "latest" }]);
  expect(logs.length, "the registry has no record of this launch").toBe(1);
  const born = parseInt((await rpcRaw("eth_getBlockByNumber", [logs[0].blockNumber, false])).timestamp, 16);
  const head = parseInt((await rpcRaw("eth_getBlockByNumber", ["latest", false])).timestamp, 16);

  const age = card.locator(".age");
  await expect(age, "the card never said when it launched").toHaveAttribute("data-ts", String(born), { timeout: 30000 });
  const text = (await age.textContent()).trim();
  const m = text.match(/^(\d+)(s|m|h|d) ago$/);
  expect(m, `"${text}" is not an age`).toBeTruthy();
  const unit = { s: 1, m: 60, h: 3600, d: 86400 }[m[2]];
  const secs = head - born;
  // BY THE CHAIN'S CLOCK, which the page read a moment ago and this test just
  // now: the printed figure is floored to its unit, and a minute of slack
  // covers the time between the two reads.
  expect(secs, `the card says ${text}; the chain says ${secs}s`).toBeGreaterThanOrEqual(Number(m[1]) * unit - 60);
  expect(secs, `the card says ${text}; the chain says ${secs}s`).toBeLessThan((Number(m[1]) + 1) * unit + 60);
  // UNDER AN HOUR OLD IT IS GREEN, and not after. (Away from the hour's edge,
  // where the page's clock and this read can fall either side of it.)
  if (Math.abs(secs - 3600) > 120) {
    if (secs < 3600) await expect(age, "a launch under an hour old is not marked fresh").toHaveClass(/\bfresh\b/);
    else await expect(age, "a launch over an hour old is marked fresh").not.toHaveClass(/\bfresh\b/);
  }
});

/// THE TIME FILTER KEEPS WHAT WAS MADE INSIDE IT AND LEAVES OUT WHAT WAS NOT. The
/// block times the page asks for are answered as two days before the newest
/// block - every launch here was made today, so without that the filter could
/// not leave anything out - and the newest block's own time is left alone. Set
/// from the head rather than shifted, so a fork whose clock an earlier suite
/// moved still reads every launch as exactly two days old.
for (const stride of [16, 14]) test(`24h and 7d keep the launches made inside them and leave out the rest (${stride}-word lens)`, async ({ page }) => {
  const TWO_DAYS = 2 * 86400;
  const headTs = parseInt((await rpcRaw("eth_getBlockByNumber", ["latest", false])).timestamp, 16);
  let aged = 0;
  if (stride === 16) {
    // ON THE CURRENT LENS THE TIME IS ITS WORD 14: every record says two days.
    await page.route("**/*", async (route) => {
      const { msg, data } = callData(route);
      if (!msg || !data.startsWith(SEL.launchPage)) return route.fallback();
      const res = await route.fetch();
      const body = await res.json();
      let hex = String(body.result || "").replace(/^0x/, "");
      const viewsAt = Number(BigInt("0x" + hex.slice(64, 128))) * 2;
      const n = Number(BigInt("0x" + hex.slice(viewsAt, viewsAt + 64)));
      const st = n ? (hex.length - viewsAt - 64) / 64 / n : 16;
      for (let i = 0; i < n; i++) {
        const at = viewsAt + 64 + (i * st + 14) * 64;
        hex = hex.slice(0, at) + word(headTs - TWO_DAYS) + hex.slice(at + 64);
        aged += 1;
      }
      body.result = "0x" + hex;
      return route.fulfill({ response: res, body: JSON.stringify(body) });
    });
  } else {
  await asOldLens(page);
  // FALLBACK, NOT CONTINUE, for what this does not take: continue() would send
  // the lens's answer past asOldLens, uncut.
  await page.route("**/*", async (route) => {
    const req = route.request();
    const raw = req.postData() || "";
    let msg;
    try { msg = JSON.parse(raw); } catch { return route.fallback(); }
    // THE BATCH OF LAUNCH BLOCKS, not the single read of the newest block.
    if (!Array.isArray(msg) || !msg.length || !msg.every((m) => m.method === "eth_getBlockByNumber")) return route.fallback();
    const res = await route.fetch();
    const body = await res.json();
    for (const r of Array.isArray(body) ? body : []) {
      if (r && r.result && r.result.timestamp) {
        r.result.timestamp = "0x" + (headTs - TWO_DAYS).toString(16);
        aged += 1;
      }
    }
    return route.fulfill({ response: res, body: JSON.stringify(body) });
  });
  }
  await page.goto(browseUrl(APP.lens));
  await expect(page.locator("#loaded")).toContainText("launches", { timeout: 20000 });
  const shown = Number((await page.locator("#loaded").textContent()).match(/^(\d+) of/)[1]);
  await expect.poll(() => aged, { message: "no launch block's time was asked for", timeout: 30000 }).toBeGreaterThan(0);
  await expect(page.locator(".launch .age").first()).toHaveText(/^2d ago$/, { timeout: 30000 });

  await page.click('.chip[data-range="86400"]');
  await expect(page.locator(".launch"), "a launch two days old was kept by 24h").toHaveCount(0);
  await expect(page.locator("#msg")).toContainText("0 made in the last 24 hours");
  await page.click('.chip[data-range="604800"]');
  await expect(page.locator(".launch"), "7d left out a launch two days old").toHaveCount(shown);
  await page.click('.chip[data-range="0"]');
  await expect(page.locator(".launch")).toHaveCount(shown);
});

/// OLDEST IS A QUESTION ABOUT THE REGISTRY'S OTHER END. With a page of one and
/// more launches than that, the oldest of the newest page is not the oldest
/// launch: Oldest must read the registry from index 0, page forward from there,
/// and Newest must go back to its end. The registry is made to claim three
/// launches and every page is served from the real one at index 0, as the Show
/// older test does, so what is checked is which window each read asks for.
test("Oldest reads the registry from its start, and Newest from its end again", async ({ page }) => {
  const starts = [];
  await page.route("**/*", async (route) => {
    const { msg, data } = callData(route);
    if (!msg) return route.continue();
    if (data === SEL.launchCount) {
      return route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: "0x" + word(3) }) });
    }
    if (data.startsWith(SEL.launchPage)) {
      starts.push(Number(BigInt("0x" + data.slice(10, 74))));
      msg.params[0].data = SEL.launchPage + word(0) + word(1);
      return route.continue({ postData: JSON.stringify(msg) });
    }
    return route.continue();
  });
  await page.goto(browseUrl(APP.lens) + "&pageSize=1");
  await expect(page.locator("#loaded")).toContainText("1 of 3 launches", { timeout: 20000 });
  expect(starts, "the first page was not the registry's newest").toEqual([2]);

  await page.click("#sortOld");
  await expect(page.locator("#more")).toHaveText("Show newer (2 more)", { timeout: 20000 });
  await expect(page.locator("#loaded")).toContainText("1 of 3 launches");
  expect(starts, "Oldest did not read from the registry's start").toEqual([2, 0]);
  await page.locator("#more").click();
  await expect(page.locator("#loaded")).toContainText("2 of 3 launches", { timeout: 20000 });
  expect(starts, "the next page after the oldest was not the next index").toEqual([2, 0, 1]);
  // AND DRAWN OLDEST FIRST: which window was read is not the order on screen.
  expect(await order(page), "Oldest drew the cards newest first").toEqual([0, 1]);

  await page.click("#sortNew");
  await expect(page.locator("#more")).toHaveText("Show older (2 more)", { timeout: 20000 });
  expect(starts, "Newest did not go back to the registry's end").toEqual([2, 0, 1, 2]);
  await page.locator("#more").click();
  await expect(page.locator("#loaded")).toContainText("2 of 3 launches", { timeout: 20000 });
  expect(await order(page), "Newest drew the cards oldest first").toEqual([2, 1]);
});

// ------------------------------------------------------------- the card itself

/// THE CARD'S OWN LINK IS A REAL LINK to the launch's page, with the endpoint
/// and lens it was read with - a middle or Ctrl click opens THAT in a new tab,
/// and only a plain click is taken over (to name the factory first). Every
/// hand-off test before this one reads location after a plain click, which
/// never looks at the href.
test("a card's own link carries the endpoint and lens, and a Ctrl or middle click opens it in a new tab", async ({ page, context }) => {
  await page.goto(browseUrl(APP.lens));
  const card = page.locator(".launch").first();
  await expect(card).toBeVisible({ timeout: 20000 });
  const addr = await addrOf(card);
  const u = new URL(await card.locator("a.open").getAttribute("href"), page.url());
  expect(tokenOf(u.href).toLowerCase(), "the card's link is not to this launch").toBe(addr.toLowerCase());
  expect(u.searchParams.get("rpc"), "the card's link drops the endpoint").toBe(STATE.rpc);
  expect(u.searchParams.get("lens"), "the card's link drops the lens").toBe(APP.lens);

  const newTab = async (how, what) => {
    const [tab] = await Promise.all([context.waitForEvent("page", { timeout: 10000 }), how()]);
    await tab.waitForLoadState("domcontentloaded");
    expect(tokenOf(tab.url()).toLowerCase(), what + " did not open this launch in a new tab").toBe(addr.toLowerCase());
    expect(new URL(tab.url()).searchParams.get("lens"), what + " opened a link without the lens").toBe(APP.lens);
    await tab.close();
    expect(page.url(), what + " also took this tab away").toContain("browse.html");
  };
  await newTab(() => card.locator("a.open").click({ modifiers: ["Control"] }), "a Ctrl click on the name");
  await newTab(() => card.locator("a.open").click({ button: "middle" }), "a middle click on the name");
  // AND ON THE PARTS THAT SIT ABOVE THE LINK'S COVER (so their titles show).
  await newTab(() => card.locator(".mc").click({ modifiers: ["Control"] }), "a Ctrl click on the market cap");
  await newTab(() => card.locator(".mc").click({ button: "middle" }), "a middle click on the market cap");
});

/// THE WHOLE CARD OPENS THE LAUNCH, AND ITS DETAILS STILL SHOW THEIR TITLES.
/// The link's cover lies over the picture - so a right click there is a link's
/// menu, and a click opens the launch - while the parts with a title (market
/// cap, badge, bar, address, age) sit above it: under the cover no pointer
/// could reach a title, which is how every one of them was out of reach. And a
/// creator's link, above the cover too, opens its own address and nothing else.
test("a click anywhere on a card opens the launch, the details' titles can be reached, and a creator's link opens on its own", async ({ page, context }) => {
  const meta = { twitter: "https://x.com/curbprobe" };
  const uri = "data:application/json;base64," + Buffer.from(JSON.stringify(meta)).toString("base64");
  await context.route(/^https:\/\/x\.com\//, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>x</title>probe" }));
  await page.route("**/*", async (route) => {
    const { msg, data } = callData(route);
    if (msg && data === SEL.tokenUri) return rpcReply(route, msg.id, abiStr(uri));
    return route.fallback();
  });
  await page.goto(browseUrl(APP.lens));
  const card = page.locator(".launch").first();
  await expect(card.locator(".age")).toHaveAttribute("data-ts", /^\d+$/, { timeout: 30000 });
  await expect(card.locator(".mc .mcVal")).toContainText("$", { timeout: 30000 });
  const addr = await addrOf(card);

  // WHAT IS UNDER THE MIDDLE OF EACH DETAIL IS THAT DETAIL, not the cover.
  for (const sel of [".mc", ".pairBadge", ".age", ".addr", ".progress"]) {
    const el = card.locator(sel).first();
    expect(await el.count(), `the card has no ${sel}`).toBe(1);
    await el.scrollIntoViewIfNeeded();
    const reached = await el.evaluate((e) => {
      const r = e.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!hit && hit.closest("[title]") === e;
    });
    expect(reached, `the link's cover lies over ${sel}, so its title cannot be reached`).toBe(true);
    expect(await el.getAttribute("title"), `${sel} carries no title`).toBeTruthy();
  }
  // AND THE PICTURE IS THE LINK (its cover).
  const pic = await card.locator(".pic").boundingBox();
  expect(await page.evaluate(([x, y]) => {
    const hit = document.elementFromPoint(x, y);
    return !!hit && !!hit.closest("a.open");
  }, [pic.x + pic.width / 2, pic.y + pic.height * 0.7]), "the picture is not covered by the card's link").toBe(true);

  // A CREATOR'S LINK: its own address in a new tab, and this page stays.
  const [pop] = await Promise.all([
    context.waitForEvent("page", { timeout: 10000 }),
    card.locator('.socials a[href^="https://x.com/curbprobe"]').click({ timeout: 5000 }),
  ]);
  await pop.waitForLoadState("domcontentloaded").catch(() => {});
  expect(pop.url(), "the creator's link did not open its own address").toContain("x.com/curbprobe");
  await pop.close();
  expect(page.url(), "the creator's link opened the launch instead").toContain("browse.html");

  // A CLICK ON THE PICTURE opens the launch...
  await page.mouse.click(pic.x + pic.width / 2, pic.y + pic.height * 0.7);
  await page.waitForURL(/\/token\/0x/, { timeout: 20000 });
  expect(tokenOf(page.url()).toLowerCase(), "the picture opened another launch").toBe(addr.toLowerCase());
  // ...AND SO DOES ONE ON THE MARKET CAP, which sits above the cover.
  await page.goto(browseUrl(APP.lens));
  await expect(page.locator(".launch .mc").first()).toBeVisible({ timeout: 20000 });
  await page.locator(".launch .mc").first().click();
  await page.waitForURL(/\/token\/0x/, { timeout: 20000 });
  expect(tokenOf(page.url()).toLowerCase(), "the market cap opened another launch").toBe(addr.toLowerCase());
});

/// THE WHOLE ADDRESS, ON A PHONE TOO: hover does not exist there, so the short
/// address is a button that copies the whole of it - without opening the launch.
test("the short address copies the whole address and does not open the launch", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(browseUrl(APP.lens));
  const card = page.locator(".launch").first();
  await expect(card).toBeVisible({ timeout: 20000 });
  const addr = await addrOf(card);
  await card.locator(".addr").click();
  await expect(card.locator(".addr")).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText()), "the clipboard does not hold the whole address").toBe(addr);
  await page.waitForTimeout(500);
  expect(page.url(), "copying the address opened the launch").toContain("browse.html");
  await expect(card.locator(".addr")).toHaveText(addr.slice(0, 6) + "…" + addr.slice(-4), { timeout: 5000 });
});

/// ON A PHONE THE SYMBOL KEEPS THE CARD'S WIDTH. The creator's links sat beside
/// it and cut "$MOONCAT" to "$MOO…" at 375 px; they take a line of their own.
test("on a phone a card's symbol is not cut short by the creator's links", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const { token } = await realRecord(APP.lens);
  const meta = { website: "https://example.com/curb", twitter: "https://x.com/curbprobe", telegram: "https://t.me/curbprobe" };
  const uri = "data:application/json;base64," + Buffer.from(JSON.stringify(meta)).toString("base64");
  await page.route("**/*", async (route) => {
    const { msg, data } = callData(route);
    const to = String((msg && msg.params && msg.params[0] && msg.params[0].to) || "").toLowerCase();
    if (msg && data === SEL.tokenUri) return rpcReply(route, msg.id, abiStr(uri));
    if (msg && data === SYMBOL && to === token.toLowerCase()) return rpcReply(route, msg.id, abiStr("MOONCAT"));
    return route.fallback();
  });
  await page.goto(browseUrl(APP.lens));
  // THE CARD OF THE LAUNCH SERVED, found by its address: newest first, it is
  // not the first card once other suites have launched on this lens.
  await expect(page.locator(".launch").first()).toBeVisible({ timeout: 20000 });
  const idx = await page.locator(".launch .addr").evaluateAll(
    (els, t) => els.findIndex((e) => (e.getAttribute("title") || "").toLowerCase() === t), token.toLowerCase());
  expect(idx, "the served launch has no card on the first page").toBeGreaterThanOrEqual(0);
  const card = page.locator(".launch").nth(idx);
  await expect(card.locator(".socials a")).toHaveCount(3, { timeout: 20000 });
  await expect(card.locator(".sym")).toHaveText("$MOONCAT");
  const sym = await card.locator(".sym").evaluate((el) => ({ need: el.scrollWidth, have: el.clientWidth }));
  expect(sym.need, `the symbol is cut: it needs ${sym.need}px and has ${sym.have}px`).toBeLessThanOrEqual(sym.have);
});

/// KEYBOARD FOCUS ON A CARD LOOKS LIKE IT DOES ON EVERY OTHER CONTROL: the
/// site's 2px ring, round the card - and only while the card's own link has it,
/// not when the focus is on the Graduate it link inside the same card.
test("keyboard focus on a card's link draws the site's 2px ring round the card, and nothing when the focus is elsewhere in it", async ({ page }) => {
  await page.goto(browseUrl(OTHER.lens));
  await expect(page.locator(".launch").first()).toBeVisible({ timeout: 20000 });
  let found = false;
  for (let i = 0; i < 80 && !found; i++) {
    await page.keyboard.press("Tab");
    found = await page.evaluate(() => !!document.activeElement && document.activeElement.matches(".launch a.open"));
  }
  expect(found, "the card's link was never reached with Tab").toBe(true);
  const ringOf = () => page.evaluate(() => {
    const c = document.activeElement.closest(".launch");
    if (!c) return "outside a card";
    const s = getComputedStyle(c);
    return s.outlineStyle === "none" ? "none" : `${s.outlineStyle} ${s.outlineWidth}`;
  });
  expect(await ringOf(), "the focused card has no 2px ring").toBe("solid 2px");
  await page.keyboard.press("Tab");
  const next = await page.evaluate(() => document.activeElement.className);
  expect(await ringOf(), `with the focus on ${next} in the card, the card still draws the ring`).toMatch(/^(none|outside a card)$/);
});

/// THE SMALL GREY TEXT IS READABLE: at least 4.5 to 1 against what it sits on,
/// which is what WCAG AA asks of text this size. The address, the MC tag and
/// the line under the heading measured 3.4 to 3.6.
test("the small grey text on the page is at least 4.5:1 against what it sits on", async ({ page }) => {
  await page.goto(browseUrl(APP.lens));
  await expect(page.locator(".launch .age").first()).toHaveAttribute("data-ts", /^\d+$/, { timeout: 30000 });
  const ratios = await page.evaluate(() => {
    const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    const rgb = (s) => (s.match(/[\d.]+/g) || []).map(Number);
    const bgOf = (el) => {
      for (let e = el; e; e = e.parentElement) {
        const c = rgb(getComputedStyle(e).backgroundColor);
        if (c.length === 3 || c[3] === 1) return c.slice(0, 3);
      }
      return [255, 255, 255];
    };
    const out = {};
    for (const sel of [".launch .addr", ".launch .mcTag", ".launch .age", ".launch .sym", "#msg"]) {
      const el = document.querySelector(sel);
      if (!el) { out[sel] = null; continue; }
      const a = lum(rgb(getComputedStyle(el).color).slice(0, 3)), b = lum(bgOf(el));
      out[sel] = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    }
    return out;
  });
  for (const [sel, r] of Object.entries(ratios)) {
    expect(r, `${sel} is not on the page`).not.toBeNull();
    expect(r, `${sel} reads at ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  }
});

// ------------------------------------------------------------- orders and pairs

/// MARKET CAP AND PROGRESS ARE ORDERS, checked on cards whose figures differ.
/// Three launches are served: two on the fixture's own asset, the second at
/// three times the first's quote reserve, and one on EURC, which has no feed
/// here - so it has no dollar figure, must say so in EURC with no "$", and must
/// come after the two that have one. Each is given its own way to graduation.
test("Market cap ranks by dollars with a card that has none last, and Progress by the way to graduation", async ({ page }) => {
  await servePages(page, APP.lens, 3, (i, r) => {
    const thr = big(r.words[W.threshold]);
    r.words[W.status] = word(1);
    if (i === 1) r.words[W.quoteReserve] = word(big(r.words[W.quoteReserve]) * 3n);
    if (i === 2) r.words[W.quote] = addrWord(NO_FEED);
    r.words[W.real] = word([thr / 2n, thr / 10n, (thr * 9n) / 10n][i]);
    return r;
  });
  await page.goto(browseUrl(APP.lens));
  await expect(page.locator(".launch")).toHaveCount(3, { timeout: 20000 });
  expect(await order(page), "Newest is not newest first").toEqual([2, 1, 0]);
  const card = (i) => page.locator(`.launch[data-index="${i}"]`);
  await expect(card(0).locator(".mc .mcVal")).toContainText("$", { timeout: 30000 });
  await expect(card(1).locator(".mc .mcVal")).toContainText("$", { timeout: 30000 });
  // THREE TIMES THE QUOTE RESERVE IS THREE TIMES THE MARKET CAP.
  const ratio = shownNumber(await card(1).locator(".mc .mcVal").textContent()) /
    shownNumber(await card(0).locator(".mc .mcVal").textContent());
  expect(Math.abs(ratio - 3), `three times the reserve drew ${ratio.toFixed(3)} times the market cap`).toBeLessThan(0.05);
  // THE ONE ON EURC: in EURC, with no dollar sign, saying why, and its badge.
  const eurc = await symbolOf(NO_FEED);
  await expect(card(2).locator(".mc"), "the card without a feed does not say why it has no dollars")
    .toHaveAttribute("title", /no Chainlink feed that names itself/, { timeout: 30000 });
  await expect(card(2).locator(".mc .mcVal")).toContainText(eurc);
  await expect(card(2).locator(".mc .mcVal"), "a figure in EURC's own units carries a dollar sign").not.toContainText("$");
  await expect(card(2).locator(".pairBadge")).toHaveAttribute("title", "Paired with " + eurc);

  await page.click("#sortMc");
  await expect.poll(() => order(page), { message: "Market cap is not by dollars with the card without dollars last" })
    .toEqual([1, 0, 2]);
  await page.click("#sortProgress");
  await expect.poll(() => order(page), { message: "Progress is not closest to graduating first" }).toEqual([2, 0, 1]);
});

/// THE STATUS PILLS (the owner's call): All, Bonding - still selling on the
/// curve - and Graduated. Four launches are served, one of each status and a
/// second selling one.
test("the status pills show every launch, the ones still bonding, or the graduated ones", async ({ page }) => {
  const statuses = [1, 3, 2, 1];
  await servePages(page, APP.lens, 4, (i, r) => { r.words[W.status] = word(statuses[i]); return r; });
  await page.goto(browseUrl(APP.lens));
  await expect(page.locator(".launch")).toHaveCount(4, { timeout: 20000 });
  await page.click("#statusBonding");
  await expect.poll(() => order(page), { message: "Bonding is not the launches still selling on their curve" }).toEqual([3, 0]);
  await page.click("#statusGraduated");
  await expect.poll(() => order(page), { message: "Graduated is not the graduated launches" }).toEqual([1]);
  await expect(page.locator(".launch .tag.graduated")).toHaveCount(1);
  // WITH ANOTHER ORDER the filter holds.
  await page.click("#sortOld");
  await expect.poll(() => order(page)).toEqual([1]);
  await page.click("#statusAll");
  await expect.poll(() => order(page), { message: "All does not bring every launch back" }).toEqual([0, 1, 2, 3]);
});

/// "JUST BOUGHT" (the owner's name for it - not PONS's "Recent buys"): only
/// launches still bonding on their curve, the newest buy first, a launch with
/// none after by launch time, read from the curves' CurveBuy events with ONE
/// eth_getLogs by topic0 over the newest blocks - at most the public 2,000,
/// learnt down when refused - and read again every ~15 s, re-ordering when a
/// launch is bought. Six launches are served with curves of their own; the
/// logs are the test's, and a stranger's curve among them is not a launch.
test("Just bought lists only bonding launches, the newest buy first, from one log read, and re-orders when one is bought", async ({ page }) => {
  test.setTimeout(120_000);
  global.window = global.window || global;
  require("../keccak.js");
  const topic = window.CurbKeccak.keccak256("0x" +
    Buffer.from("CurveBuy(address,address,uint256,uint256,uint256,uint256)", "utf8").toString("hex"));
  const curveOf = (i) => "0x" + (0xc0 + i).toString(16).repeat(20);
  const statuses = [1, 1, 3, 2, 1, 1];        // 2 graduated, 3 waiting
  const { real } = await servePages(page, APP.lens, 6, (i, r) => {
    r.words[W.status] = word(statuses[i]);
    r.words[1] = addrWord(curveOf(i));
    return r;
  });
  // WHAT EACH BUY SPENT, in the asset's smallest units, at its feed's price:
  // only about $5 or more counts (browse.js buyCounts) - a 1-wei buy every
  // block kept a launch first for the gas alone (audit, item 24).
  const quote = "0x" + real.words[W.quote].slice(24);
  expect(FEEDS[quote], "the fixture's launch is paired with an asset whose feed this file does not name").toBeTruthy();
  const qd = await decimalsOf(quote);
  const per = await feedUsdOf(quote);
  const usd = (d) => BigInt(Math.floor((d / per) * 10 ** qd));
  // BLOCKS BEFORE THE HEAD of each buy: the graduated and the waiting launch
  // were bought last, and must not show; 0 before 1; 4 and 5 not at all. The
  // newest buys of 1 and 5 are too small to count: 1 wei, and $4.
  const bought = [{ i: 1, ago: 40 }, { i: 0, ago: 30 }, { i: 2, ago: 5 }, { i: 3, ago: 5 },
    { i: 1, ago: 2, spent: 1n }, { i: 5, ago: 1, spent: usd(4) }];
  const asks = [];
  let limit = 1000;                             // this endpoint's range, below the page's first ask
  await page.route("**/*", async (route) => {
    const m = rpcMsg(route);
    if (!m || Array.isArray(m)) return route.fallback();
    // NO FORK FLOOR, as on the real network: the window is the whole 2,000.
    if (m.method === "anvil_metadata") return rpcRefuse(route, m.id, -32601, "Method not found");
    if (m.method !== "eth_getLogs") return route.fallback();
    const f = m.params[0];
    if (!f.topics || f.topics[0] !== topic) return route.fallback();
    asks.push(f);
    const from = parseInt(f.fromBlock, 16), to = parseInt(f.toBlock, 16);
    if (to - from + 1 > limit) return rpcRefuse(route, m.id, -32600, "eth_getLogs is limited to a " + limit + " range");
    // CurveBuy's data: quoteIn, tokensOut, fee, tax. A buy says $10 unless it says otherwise.
    const log = (address, ago, spent = usd(10)) => ({ address, topics: [topic], data: "0x" + word(spent) + word(1) + word(0) + word(0),
      blockNumber: "0x" + (to - ago).toString(16), logIndex: "0x0", transactionHash: "0x" + "ab".repeat(32) });
    return rpcReply(route, m.id, bought.map((b) => log(curveOf(b.i), b.ago, b.spent)).concat([log("0x" + "ee".repeat(20), 1)]));
  });
  await page.goto(browseUrl(APP.lens));
  await expect(page.locator(".launch")).toHaveCount(6, { timeout: 20000 });
  expect(asks.length, "the buys were read before Just bought was chosen").toBe(0);
  await page.click("#sortBought");
  await expect.poll(() => order(page), { message: "Just bought is not bonding launches by their newest buy" })
    .toEqual([0, 1, 5, 4]);
  // ONE REQUEST BY TOPIC ALONE, held to the endpoint's range: refused at 2,000,
  // asked again at 1,000, and the window kept.
  expect(asks.length, "the refused range was not asked again at half").toBe(2);
  expect(asks.every((a) => !a.address && a.topics.length === 1), "the buys were not asked by topic0 alone").toBe(true);
  const span = (a) => parseInt(a.toBlock, 16) - parseInt(a.fromBlock, 16) + 1;
  expect(asks.map(span)).toEqual([2000, 1000]);
  expect(await page.evaluate(() => window.CurbBrowse.buyWindow)).toBe(1000);
  // BOUGHT NOW, FOR $6: launch 4 jumps to the top on the next read, one request.
  bought.push({ i: 4, ago: 0, spent: usd(6) });
  const before = asks.length;
  await expect.poll(() => order(page), { message: "a launch bought since did not move to the top", timeout: 40_000 })
    .toEqual([4, 0, 1, 5]);
  expect(asks.length - before, "a refresh asked for more than one window of logs").toBe(1);
  expect(span(asks[asks.length - 1])).toBe(1000);
});

/// WHERE AN ASSET HAS NO DOLLAR PRICE, A BUY COUNTS FOR "Just bought" FROM A
/// THOUSANDTH OF A WHOLE UNIT (browse.js buyCounts): EURC has no feed in
/// prices.js, so launch 1's newer buy of 0.0009 EURC leaves it behind launch
/// 0, bought earlier for 0.0011.
test("Just bought on an asset with no dollar price counts a buy only from a thousandth of a unit", async ({ page }) => {
  test.setTimeout(60_000);
  global.window = global.window || global;
  require("../keccak.js");
  const topic = window.CurbKeccak.keccak256("0x" +
    Buffer.from("CurveBuy(address,address,uint256,uint256,uint256,uint256)", "utf8").toString("hex"));
  const curveOf = (i) => "0x" + (0xd0 + i).toString(16).repeat(20);
  await servePages(page, APP.lens, 2, (i, r) => {
    r.words[W.status] = word(1);
    r.words[W.quote] = addrWord(NO_FEED);
    r.words[1] = addrWord(curveOf(i));
    return r;
  });
  const unit = 10n ** BigInt(await decimalsOf(NO_FEED));
  const bought = [{ i: 0, ago: 10, spent: (unit * 11n) / 10000n }, { i: 1, ago: 5, spent: (unit * 9n) / 10000n }];
  await page.route("**/*", async (route) => {
    const m = rpcMsg(route);
    if (!m || Array.isArray(m)) return route.fallback();
    if (m.method !== "eth_getLogs") return route.fallback();
    const f = m.params[0];
    if (!f.topics || f.topics[0] !== topic) return route.fallback();
    const to = parseInt(f.toBlock, 16);
    return rpcReply(route, m.id, bought.map((b) => ({ address: curveOf(b.i), topics: [topic],
      data: "0x" + word(b.spent) + word(1) + word(0) + word(0), blockNumber: "0x" + (to - b.ago).toString(16),
      logIndex: "0x0", transactionHash: "0x" + "cd".repeat(32) })));
  });
  await page.goto(browseUrl(APP.lens));
  await expect(page.locator(".launch")).toHaveCount(2, { timeout: 20000 });
  await expect(page.locator(".launch").first().locator(".mc"), "EURC has a dollar price after all")
    .toHaveAttribute("title", /no Chainlink feed that names itself/, { timeout: 30000 });
  await page.click("#sortBought");
  await expect.poll(() => order(page), { message: "a buy below a thousandth of an EURC moved its launch up" }).toEqual([0, 1]);
  await expect(page.locator('.launch[data-index="0"] .age')).toHaveText(/^bought \d+[smhd] ago$/, { timeout: 20000 });
  await expect(page.locator('.launch[data-index="1"] .age')).not.toContainText("bought");
});

/// A WETH PAIR IS CALLED ETH, as the picker and the swap card call it, and is
/// priced by ETH / USD.
test("a WETH pair is called ETH on its badge, and priced by ETH / USD", async ({ page }) => {
  await servePages(page, APP.lens, 1, (i, r) => { r.words[W.quote] = addrWord(WETH_ADDR); return r; });
  expect(await symbolOf(WETH_ADDR), "WETH does not call itself WETH here").toBe("WETH");
  await page.goto(browseUrl(APP.lens));
  const card = page.locator(".launch").first();
  await expect(card).toBeVisible({ timeout: 20000 });
  await expect(card.locator(".pairBadge")).toHaveAttribute("title", "Paired with ETH");
  await expect(card.locator(".pairBadge b")).toHaveText("ETH");
  await expect(card.locator(".mc")).toHaveAttribute("title", /ETH \/ USD \(Chainlink\)/, { timeout: 30000 });
  await expect(card.locator(".mc .mcVal")).toContainText("$");
});

/// A FEED THAT DOES NOT NAME ITSELF AS THE ONE WRITTEN DOWN IS NOT USED: the
/// card stays in the asset's own units, with no dollar sign.
test("a feed that does not name itself is not used, and the card stays in the asset's own units", async ({ page }) => {
  let asked = 0;
  await page.route("**/*", async (route) => {
    const { msg, data } = callData(route);
    const to = String((msg && msg.params && msg.params[0] && msg.params[0].to) || "").toLowerCase();
    if (msg && to === NVDA_FEED && data === SEL.description) {
      asked += 1;
      return rpcReply(route, msg.id, abiStr("Coinbase NVDA, but not this one"));
    }
    return route.fallback();
  });
  await page.goto(browseUrl(APP.lens));
  const card = nvdacCurveCard(page);
  await expect(card.locator(".mc")).toHaveAttribute("title", /no Chainlink feed that names itself/, { timeout: 30000 });
  expect(asked, "the feed's name was never asked for").toBeGreaterThan(0);
  await expect(card.locator(".mc .mcVal")).toContainText("NVDAc");
  await expect(card.locator(".mc .mcVal"), "a feed that did not name itself was used").not.toContainText("$");
});

/// A DOLLAR PRICE THAT COULD NOT BE READ IS ASKED AGAIN. One refused feed call
/// in the first page's burst used to leave every card on that asset in its own
/// units for the visit (kept as "no dollars", and asked again by nothing).
test("a dollar price that could not be read is asked again, and the card turns to dollars", async ({ page }) => {
  test.setTimeout(60_000);
  let asked = 0;
  await page.route("**/*", async (route) => {
    const { msg, data } = callData(route);
    const to = String((msg && msg.params && msg.params[0] && msg.params[0].to) || "").toLowerCase();
    if (msg && to === NVDA_FEED && data === SEL.description) {
      asked += 1;
      if (asked === 1) return route.fulfill({ status: 429, contentType: "text/plain", body: "Too Many Requests" });
    }
    return route.fallback();
  });
  await page.goto(browseUrl(APP.lens));
  const card = nvdacCurveCard(page);
  await expect(card.locator(".mc"), "the refusal is not said as a refusal")
    .toHaveAttribute("title", /could not be read just now/, { timeout: 30000 });
  await expect(card.locator(".mc .mcVal")).not.toContainText("$");
  await expect(card.locator(".mc .mcVal"), "the refused read was kept as no dollars").toContainText("$", { timeout: 40000 });
  expect(asked, "the feed was not asked again").toBeGreaterThanOrEqual(2);
});

/// DOLLARS THAT LAND AFTER THE LAUNCH TIMES ARE STILL DRAWN. The feed's answer
/// is held until the card has its age, and only then let through.
test("dollars that arrive after the launch times are drawn when they land", async ({ page }) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let held = 0;
  await page.route("**/*", async (route) => {
    const { msg, data } = callData(route);
    const to = String((msg && msg.params && msg.params[0] && msg.params[0].to) || "").toLowerCase();
    if (msg && to === NVDA_FEED && data === SEL.latestRoundData) { held += 1; await gate; }
    return route.fallback();
  });
  await page.goto(browseUrl(APP.lens));
  const card = nvdacCurveCard(page);
  await expect(card.locator(".age")).toHaveAttribute("data-ts", /^\d+$/, { timeout: 30000 });
  await expect.poll(() => held, { message: "the feed's answer was never asked for" }).toBeGreaterThan(0);
  await page.waitForTimeout(300);
  await expect(card.locator(".mc .mcVal"), "dollars were drawn before the feed answered").not.toContainText("$");
  release();
  await expect(card.locator(".mc .mcVal"), "the dollars that landed were not drawn").toContainText("$", { timeout: 2500 });
});

/// A TIME WINDOW IS ABOUT THE NEWEST LAUNCHES. After Oldest, 24h used to look
/// only at the registry's oldest ones and say none was made that day.
test("a time window chosen after Oldest reads the registry's newest launches again", async ({ page }) => {
  const { starts } = await servePages(page, APP.lens, 2, () => null);
  await page.goto(browseUrl(APP.lens) + "&pageSize=1");
  await expect(page.locator("#loaded")).toContainText("1 of 2 launches", { timeout: 20000 });
  await page.click("#sortOld");
  await expect(page.locator("#more")).toHaveText("Show newer (1 more)", { timeout: 20000 });
  expect(starts, "Oldest did not read from the registry's start").toEqual([1, 0]);
  await page.click('.chip[data-range="86400"]');
  await expect(page.locator("#more")).toHaveText("Show older (1 more)", { timeout: 20000 });
  expect(starts, "24h after Oldest kept looking at the oldest launches").toEqual([1, 0, 1]);
  await expect(page.locator("#msg")).toContainText("of the 1 loaded made in the last 24 hours");
});

// ------------------------------------------------------------- launch times, bounded

/// THE PAGE AS IF ON A REAL NETWORK, not a fork: anvil_metadata does not exist
/// there, and a node that keeps no state from eight days ago refuses a read at
/// that block. The launch-time scan's floor is then eight days back, as on Base.
/// Logs from before this fork's own block are answered here as empty, so no
/// request reaches past the fork whatever the page asks for.
async function asRealNetwork(page) {
  const meta = await rpcRaw("anvil_metadata", []);
  const forkBlock = Number(meta.forkedNetwork.forkBlockNumber);
  await page.route("**/*", async (route) => {
    const msg = rpcMsg(route);
    if (!msg || Array.isArray(msg)) return route.fallback();
    if (msg.method === "anvil_metadata") return rpcRefuse(route, msg.id, -32601, "the method anvil_metadata does not exist");
    if (msg.method === "eth_call" && msg.params && msg.params[1] && msg.params[1] !== "latest") {
      return rpcRefuse(route, msg.id, -32000, "missing trie node");
    }
    if (msg.method === "eth_getLogs") {
      const f = msg.params[0];
      if (parseInt(f.toBlock, 16) <= forkBlock) return rpcReply(route, msg.id, []);
      if (parseInt(f.fromBlock, 16) <= forkBlock) {
        f.fromBlock = "0x" + (forkBlock + 1).toString(16);
        return route.fallback({ postData: JSON.stringify(msg) });
      }
    }
    return route.fallback();
  });
}
/// Counts eth_getLogs, and answers it with `answer(msg, n)` when that returns
/// something other than undefined.
async function onLogs(page, answer = () => undefined) {
  const seen = { n: 0 };
  await page.route("**/*", async (route) => {
    const msg = rpcMsg(route);
    if (!msg || Array.isArray(msg) || msg.method !== "eth_getLogs") return route.fallback();
    seen.n += 1;
    const a = await answer(msg, seen.n, route);
    if (a === "handled") return;
    if (a !== undefined) return rpcReply(route, msg.id, a);
    return route.fallback();
  });
  return seen;
}

/// A LOG RANGE THE ENDPOINT ALWAYS REFUSES COSTS A FEW REQUESTS, NOT A LOOP: the
/// window halves to its floor, the scan stops, and the card says the time could
/// not be read. (Without the floor the scan asked for 250 blocks forever.)
test("a log range the endpoint always refuses costs a bounded number of requests, and the age says it could not be read", async ({ page }) => {
  // THE LOG SCAN IS THE FALLBACK FOR A LENS WITHOUT launchedAt: met here on one.
  await asOldLens(page);
  const logs = await onLogs(page, async (msg, n, route) => {
    await rpcRefuse(route, msg.id, -32600, "eth_getLogs is limited to a 2,000 range");
    return "handled";
  });
  await page.goto(browseUrl(APP.lens));
  const age = page.locator(".launch .age").first();
  await expect(age).toHaveText("—", { timeout: 30000 });
  await expect(age).toHaveAttribute("title", /could not be read/);
  const n = logs.n;
  expect(n, "the refused range cost more than a handful of requests").toBeLessThanOrEqual(6);
  await page.waitForTimeout(4000);
  expect(logs.n - n, "the refused range was asked again straight away").toBe(0);
});

/// THE REAL PROVIDERS' REFUSALS, SORTED BY KIND. A result-size refusal names a
/// block range too, and read as a range ceiling it never grows back; a rate
/// limit is neither and must not narrow the window at all.
test("the real providers' log refusals are told apart: result size, block range, busy", async ({ page }) => {
  await page.goto(browseUrl(APP.lens));
  await page.waitForFunction(() => window.CurbBrowse && typeof window.CurbBrowse.logError === "function");
  const kinds = await page.evaluate(() => {
    const k = (code, message, status, data) => window.CurbBrowse.logError(Object.assign(new Error(message), { code, status, data }));
    return {
      // Tenderly's public gateway: the reason only in the error's data
      tenderlyRange: k(-32602, "invalid params", undefined, "Block range too large for public access: maximum 1000 blocks. Try with this block range [0x3240d6a, 0x3241152], or use an access key for larger ranges."),
      bareInvalid: k(-32602, "invalid params"),
      infuraSize: k(-32005, "query returned more than 10000 results. Try with this block range [0x1, 0x2]."),
      alchemySize: k(-32602, "Log response size exceeded. You can make eth_getLogs requests with up to a 2K block range and no limit on the response size, or you can request any block range with a cap of 10K logs in the response."),
      baseRange: k(-32614, "eth_getLogs is limited to a 10,000 range"),
      blocksRange: k(-32000, "block range limit exceeded"),
      rate: k(429, "Too Many Requests", 429),
      infuraRate: k(-32005, "daily request count exceeded, request rate limited"),
      other: k(-32000, "header not found"),
    };
  });
  expect(kinds).toEqual({
    tenderlyRange: "range", bareInvalid: "busy",
    infuraSize: "size", alchemySize: "size", baseRange: "range", blocksRange: "range",
    rate: "busy", infuraRate: "busy", other: "busy",
  });
});

/// ONCE EVERY CARD HAS ITS TIME, NO FURTHER LOG IS ASKED FOR - on a network
/// whose floor is eight days back, so a scan that did not stop would walk on.
test("once every card has its launch time, no further log is asked for", async ({ page }) => {
  // THE LOG SCAN IS THE FALLBACK FOR A LENS WITHOUT launchedAt: met here on one.
  await asOldLens(page);
  await asRealNetwork(page);
  const logs = await onLogs(page);
  await page.goto(browseUrl(APP.lens));
  await expect(page.locator(".launch .age").first()).toHaveAttribute("data-ts", /^\d+$/, { timeout: 30000 });
  const n = logs.n;
  await page.waitForTimeout(3000);
  expect(logs.n - n, "logs were still asked for after every card was placed").toBe(0);
  expect(n, "the newest launch took more than one window to find").toBe(1);
});

/// A RATE-LIMITED LOG REQUEST IS ASKED AGAIN AS IT WAS. On an endpoint that
/// limits a log range to 2,000 blocks, any error used to halve the window for
/// the visit: one 429 left every later window at 1,000, doubling the walk. Here
/// nothing is registered in the range scanned, so the walk goes all the way to
/// its floor - what this page costs on such an endpoint, until the chain keeps
/// launch times - and reads "8d+ ago".
test("a rate-limited log request is asked again with the same window, and a refused range is learnt once", async ({ page }) => {
  // THE LOG SCAN IS THE FALLBACK FOR A LENS WITHOUT launchedAt: met here on one.
  await asOldLens(page);
  test.setTimeout(120_000);
  await asRealNetwork(page);
  const served = [];
  let refusedRange = 0;
  let limited = null;
  await onLogs(page, async (msg, n, route) => {
    const f = msg.params[0];
    const from = parseInt(f.fromBlock, 16), to = parseInt(f.toBlock, 16);
    if (to - from + 1 > 2000) {
      refusedRange += 1;
      await rpcRefuse(route, msg.id, -32600, "eth_getLogs is limited to a 2,000 range");
      return "handled";
    }
    if (n === 3) {
      limited = [from, to];
      await route.fulfill({ status: 429, contentType: "text/plain", body: "Too Many Requests" });
      return "handled";
    }
    served.push([from, to]);
    return [];
  });
  await page.goto(browseUrl(APP.lens));
  const age = page.locator(".launch .age").first();
  await expect(age, "the walk did not reach its floor").toHaveText("8d+ ago", { timeout: 90000 });
  expect(limited, "no request was rate-limited, so this proves nothing").not.toBeNull();
  expect(served.some(([a, b]) => a === limited[0] && b === limited[1]),
    "the rate-limited window was not asked again as it was").toBe(true);
  expect(refusedRange, "a range the endpoint refused was asked for again").toBe(1);
  const sizes = served.map(([a, b]) => b - a + 1);
  expect(sizes.slice(0, -1).every((s) => s === 2000),
    "a window shrank after a rate limit: " + [...new Set(sizes)].join(", ")).toBe(true);
  expect(served.length, "the walk cost more windows than eight days at 2,000 blocks").toBeLessThanOrEqual(174);
});

/// FIVE REFUSALS IN A ROW PAUSE THE LAUNCH TIMES, THEY DO NOT END THEM. Four
/// errors in a row used to end launch times for the visit, with every age at
/// "—" and the 24h and 7d windows empty until a reload.
test("five rate-limited log requests in a row pause the launch times, and they are read after the pause", async ({ page }) => {
  // THE LOG SCAN IS THE FALLBACK FOR A LENS WITHOUT launchedAt: met here on one.
  await asOldLens(page);
  test.setTimeout(90_000);
  const logs = await onLogs(page, async (msg, n, route) => {
    if (n > 5) return undefined;
    await route.fulfill({ status: 429, contentType: "text/plain", body: "Too Many Requests" });
    return "handled";
  });
  await page.goto(browseUrl(APP.lens));
  const age = page.locator(".launch .age").first();
  await expect(age, "the paused scan is not said as unknown").toHaveText("—", { timeout: 30000 });
  await expect(age, "the launch time was never read after the pause").toHaveAttribute("data-ts", /^\d+$/, { timeout: 45000 });
  expect(logs.n, "the refusals were not five, then one that answered").toBe(6);
});

/// A LAUNCH THE REGISTRY'S LOG DOES NOT SHOW, ON A FORK, IS UNKNOWN - not "8d+
/// ago": the scan's floor here is the fork's own block, not eight days back.
/// The time windows leave it out and count it as such.
test("a launch the registry's log does not show reads '—', and the time windows count it as unknown", async ({ page }) => {
  // THE LOG SCAN IS THE FALLBACK FOR A LENS WITHOUT launchedAt: met here on one.
  await asOldLens(page);
  await onLogs(page, () => []);
  await page.goto(browseUrl(APP.lens));
  await expect(page.locator(".launch .age").first()).toHaveText("—", { timeout: 30000 });
  await page.click('.chip[data-range="86400"]');
  await expect(page.locator(".launch"), "24h kept a launch whose time is unknown").toHaveCount(0);
  await expect(page.locator("#msg")).toContainText(/ \d+ whose launch time could not be read/);
  await page.click('.chip[data-range="604800"]');
  await expect(page.locator(".launch"), "7d kept a launch whose time is unknown").toHaveCount(0);
});

/// ONE READ SAYS WHICH LAUNCHES ARE OLDER THAN EIGHT DAYS: launchCount() at the
/// block eight days back. Every launch below that count reads "8d+ ago" with no
/// log scanned, and the time windows leave it out.
test("a launch the registry already counted eight days ago reads 8d+ ago with no log read, and the time windows leave it out", async ({ page }) => {
  // THE LOG SCAN IS THE FALLBACK FOR A LENS WITHOUT launchedAt: met here on one.
  await asOldLens(page);
  await asRealNetwork(page);
  const total = await launchCountOf(APP.lens);
  let historic = 0;
  await page.route("**/*", async (route) => {
    const msg = rpcMsg(route);
    const p = msg && !Array.isArray(msg) && msg.method === "eth_call" && msg.params;
    if (p && p[1] && p[1] !== "latest" && String(p[0].data).toLowerCase() === SEL.launchCount) {
      historic += 1;
      return rpcReply(route, msg.id, "0x" + word(total));
    }
    return route.fallback();
  });
  const logs = await onLogs(page);
  await page.goto(browseUrl(APP.lens));
  await expect(page.locator(".launch .age").first()).toHaveText("8d+ ago", { timeout: 30000 });
  expect(historic, "the registry was not asked how many launches it held eight days ago").toBe(1);
  expect(logs.n, "logs were scanned for launches the registry already placed before the window").toBe(0);
  await page.click('.chip[data-range="86400"]');
  await expect(page.locator(".launch"), "24h kept a launch over eight days old").toHaveCount(0);
  await expect(page.locator("#msg")).toContainText("0 made in the last 24 hours");
  await expect(page.locator("#msg")).not.toContainText("could not be read");
  await page.click('.chip[data-range="604800"]');
  await expect(page.locator(".launch"), "7d kept a launch over eight days old").toHaveCount(0);
});

/// WHAT WAS FOUND IS KEPT IN THIS BROWSER: a second visit asks the chain for no
/// logs - a launch's block never changes - unless the block the kept scan
/// stopped at is no longer the same block (a fork rebuilt at the same address).
test("a second visit takes the launch times this browser found, unless the chain they came from has changed", async ({ page }) => {
  // THE LOG SCAN IS THE FALLBACK FOR A LENS WITHOUT launchedAt: met here on one.
  await asOldLens(page);
  const logs = await onLogs(page);
  await page.goto(browseUrl(APP.lens));
  const age = page.locator(".launch .age").first();
  await expect(age).toHaveAttribute("data-ts", /^\d+$/, { timeout: 30000 });
  const ts = await age.getAttribute("data-ts");
  const first = logs.n;
  expect(first, "the first visit read no logs, so this proves nothing").toBeGreaterThan(0);
  await page.reload();
  await expect(age).toHaveAttribute("data-ts", ts, { timeout: 30000 });
  expect(logs.n - first, "the second visit scanned the logs again").toBe(0);

  await page.evaluate(() => {
    const k = "curb.browse.times.v1";
    const s = JSON.parse(localStorage.getItem(k));
    for (const e of Object.values(s)) e.topHash = "0x" + "ab".repeat(32);
    localStorage.setItem(k, JSON.stringify(s));
  });
  const before = logs.n;
  await page.reload();
  await expect(age).toHaveAttribute("data-ts", ts, { timeout: 30000 });
  expect(logs.n - before, "a kept scan was used though the block it stopped at is not the same block").toBeGreaterThan(0);
});

// ------------------------------------------------------------- a graduated launch's pool

/// A GRADUATED LAUNCH'S MARKET CAP IS ITS POOL'S PRICE TIMES ITS SUPPLY, in
/// dollars (the owner's list: a dollar market cap on every card, as PONS has).
/// The other deployment's waiting launch is graduated here for real - anyone may
/// - and the figure is checked against the pool's slot0 read straight from
/// Uniswap v4's StateView, the token's supply and the asset's feed. The fork is
/// put back afterwards, so the waiting launch is waiting again for what follows.
test("a graduated launch's market cap is its Uniswap v4 pool's price times its supply, in dollars, and the Graduated pill shows it", async ({ page }) => {
  test.setTimeout(120_000);
  const token = STATE.token;
  const lens = OTHER.lens;
  const snap = await rpcRaw("evm_snapshot", []);
  try {
    const before = await launchView(lens, token);
    test.skip(before.status !== 2 && before.status !== 3, "the other deployment's launch is neither waiting nor graduated on this run");
    if (before.status === 2) {
      const hash = await rpcRaw("eth_sendTransaction", [{ from: DEPLOYER, to: OTHER.graduator,
        data: GRADUATE + addrWord(token), gas: "0x" + (12_000_000).toString(16) }]);
      let rc = null;
      for (let i = 0; i < 40 && !rc; i++) {
        rc = await rpcRaw("eth_getTransactionReceipt", [hash]);
        if (!rc) await new Promise((res) => setTimeout(res, 250));
      }
      expect(rc && rc.status, `the graduation ${hash} did not go through`).toBe("0x1");
    }
    const v = (await rawCall(lens, SEL.launchState + addrWord(token))).replace(/^0x/, "");
    const w = (i) => v.slice(i * 64, (i + 1) * 64);
    expect(Number(big(w(0))), "the launch did not graduate").toBe(3);
    const quote = "0x" + w(2).slice(24);
    global.window = global.window || global;
    require("../keccak.js");
    const poolId = window.CurbKeccak.keccak256("0x" + v.slice(9 * 64, 14 * 64));
    const sqrt = big((await rawCall(STATE_VIEW, GET_SLOT0 + poolId.replace(/^0x/, ""))).replace(/^0x/, "").slice(0, 64));
    expect(sqrt > 0n, "the launch's pool has no price, so this proves nothing").toBe(true);
    const supply = big((await rawCall(token, TOTAL_SUPPLY)).replace(/^0x/, ""));
    const tokenIsC0 = ("0x" + w(9).slice(24)).toLowerCase() === token.toLowerCase();
    const qd = await decimalsOf(quote);
    const r = Number(sqrt) / 2 ** 96;
    const perToken = tokenIsC0 ? r * r * 10 ** (18 - qd) : 10 ** (18 - qd) / (r * r);
    const inPair = perToken * (Number(supply) / 1e18);
    const want = inPair * (await feedUsdOf(quote));

    await page.goto(browseUrl(lens));
    const card = page.locator(".launch:has(.tag.graduated)").first();
    await expect(card).toBeVisible({ timeout: 20000 });
    await expect(card.locator(".mc .mcVal"), "the graduated card never showed dollars").toContainText("$", { timeout: 30000 });
    const shown = await card.locator(".mc .mcVal").textContent();
    expect(Math.abs(shownNumber(shown) - want) / want,
      `the graduated card's market cap is not its pool's price times its supply: ${shown}, want $${want.toFixed(2)}`)
      .toBeLessThan(0.02);
    const title = await card.locator(".mc").getAttribute("title");
    expect(title, "the figure does not say it is the pool's price").toContain("Uniswap v4 pool");
    const sym = await symbolOf(quote);
    expect(Math.abs(shownNumber(title.split(" " + sym)[0]) - inPair) / inPair,
      "the tooltip's figure in the pair's asset is not the pool's: " + title).toBeLessThan(0.02);
    // THE GRADUATED PILL: only graduated launches, each with its pool's dollar figure.
    await page.click("#statusGraduated");
    await expect(page.locator(".launch:not(:has(.tag.graduated))"), "Graduated shows a launch that is not").toHaveCount(0);
    await expect(page.locator(".launch:has(.tag.graduated)").first().locator(".mc .mcVal")).toHaveText(shown);
  } finally {
    await page.goto("about:blank").catch(() => {});
    await rpcRaw("evm_revert", [snap]);
  }
});

/// A LAUNCH BLOCK'S TIME THAT COULD NOT BE READ IS ASKED AGAIN, not kept as
/// unknown for the visit: the batch of block reads is refused once here.
test("a launch block's time that could not be read is asked again", async ({ page }) => {
  // THE LOG SCAN IS THE FALLBACK FOR A LENS WITHOUT launchedAt: met here on one.
  await asOldLens(page);
  test.setTimeout(90_000);
  let batches = 0;
  await page.route("**/*", async (route) => {
    const msg = rpcMsg(route);
    if (Array.isArray(msg) && msg.length && msg.every((m) => m.method === "eth_getBlockByNumber")) {
      batches += 1;
      if (batches === 1) return route.fulfill({ status: 429, contentType: "text/plain", body: "Too Many Requests" });
    }
    if (msg && !Array.isArray(msg) && msg.method === "eth_getBlockByNumber" && batches === 1 && msg.params[0] !== "latest") {
      // THE ONE-BY-ONE FALLBACK after the refused batch, refused as well.
      return route.fulfill({ status: 429, contentType: "text/plain", body: "Too Many Requests" });
    }
    return route.fallback();
  });
  await page.goto(browseUrl(APP.lens));
  const age = page.locator(".launch .age").first();
  await expect.poll(() => batches, { message: "the launch block's time was never asked for", timeout: 30000 }).toBeGreaterThan(0);
  await expect(age, "the refused block time was kept as unknown").toHaveAttribute("data-ts", /^\d+$/, { timeout: 45000 });
  expect(batches, "the block's time was not asked again").toBeGreaterThanOrEqual(2);
});

// ------------------------------------------------------------- what the grid had dropped, put back
//
// THE LIST BEFORE THE GRID (ad391631) printed, beside each curve launch's bar,
// how much of the paired asset was in against the threshold, and put waiting
// launches first with a full-width "Graduate it". The grid kept the amount only
// on a tooltip (which a phone cannot show) and sorted a waiting launch by age.
const CBBTC_ADDR = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf";
/// THE RULE THE CARD IS HELD TO, written here rather than read from the page:
/// from one whole unit up, at most two places; under it, three significant
/// digits - never "0.00" for something that is not nothing.
const raisedFigure = (raw, decimals) => {
  const n = Number(raw) / 10 ** decimals;
  if (n === 0) return "0";
  return n >= 1 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 })
    : n.toLocaleString("en-US", { maximumSignificantDigits: 3 });
};

test("a curve card says, as text a phone can read, how much of the paired asset is in against the threshold - never rounded to zero", async ({ page }) => {
  // A cbBTC LAUNCH 1.46% OF THE WAY: 0.0021835 of 0.15 cbBTC, which two fixed
  // places printed as "0.00 of 0.15 cbBTC" beside a bar at 1.4%.
  await servePages(page, APP.lens, 2, (i, r) => {
    if (i === 0) {
      r.words[W.quote] = addrWord(CBBTC_ADDR);
      r.words[W.real] = word(218350n);
      r.words[W.threshold] = word(15000000n);
    } else {
      r.words[W.real] = word(big(r.words[W.threshold]) * 3n / 4n + 12345n);
    }
    r.words[W.status] = word(1);
    return r;
  });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(browseUrl(APP.lens));
  const cards = page.locator(".launch:has(.progress)");
  await expect(cards).toHaveCount(2, { timeout: 20000 });
  for (let i = 0; i < 2; i++) {
    const card = cards.nth(i);
    const title = await card.locator(".progress").getAttribute("title");
    const [real, threshold] = title.match(/(\d+) of (\d+)/).slice(1).map(BigInt);
    const quote = "0x" + (await launchView(APP.lens, await addrOf(card))).quote.slice(-40);
    const btc = real === 218350n;
    const asset = btc ? CBBTC_ADDR : quote;
    const d = await decimalsOf(asset);
    let sym = await symbolOf(asset);
    if (sym === "WETH") sym = "ETH";
    const want = `${raisedFigure(real, d)} of ${raisedFigure(threshold, d)} ${sym}`;
    // VISIBLE TEXT, not only a title.
    await expect(card.locator(".raised"), "the card does not say how much is in, as text").toBeVisible();
    await expect(card.locator(".raised")).toHaveText(want);
    if (btc) await expect(card.locator(".raised")).toHaveText("0.00218 of 0.15 cbBTC");
    // AND THE TOOLTIP SAYS THE SAME, after its raw figures.
    expect(title).toContain(want + " to graduate");
  }
});

test("waiting launches are named above the grid in every order, each with the way to graduate it", async ({ page }) => {
  await servePages(page, APP.lens, 3, (i, r) => {
    r.words[W.status] = word(i === 1 ? 2 : 1);
    if (i === 1) r.words[W.real] = r.words[W.threshold];
    return r;
  });
  await page.goto(browseUrl(APP.lens));
  await expect(page.locator(".launch")).toHaveCount(3, { timeout: 20000 });
  const bar = page.locator("#waitingBar");
  await expect(bar, "a waiting launch is not named above the grid").toBeVisible();
  await expect(bar).toContainText("1 launch is waiting to graduate");
  const waitingCard = page.locator(".launch:has(.tag.waiting)");
  await expect(waitingCard).toHaveCount(1);
  const sym = (await waitingCard.locator(".sym").textContent()).trim();
  const go = bar.locator("a.btn");
  await expect(go).toHaveCount(1);
  await expect(go).toHaveText("Graduate " + sym);
  expect(await go.getAttribute("href"), "the bar's button does not lead where the card's does")
    .toBe(await waitingCard.locator("a.act").getAttribute("href"));
  // IN EVERY ORDER: the bar does not depend on where the card is sorted to.
  for (const id of ["#sortOld", "#sortMc", "#sortProgress", "#sortNew"]) {
    await page.click(id);
    await expect(bar, "the waiting launch's line went away under " + id).toBeVisible();
    await expect(go).toHaveText("Graduate " + sym);
  }
  // AND IT LEADS TO THE LAUNCH'S OWN PAGE.
  await go.click();
  await page.waitForURL(/\/token\/0x/, { timeout: 20000 });
});

test("with no launch waiting, nothing is said above the grid", async ({ page }) => {
  await servePages(page, APP.lens, 2, (i, r) => { r.words[W.status] = word(1); return r; });
  await page.goto(browseUrl(APP.lens));
  await expect(page.locator(".launch")).toHaveCount(2, { timeout: 20000 });
  await expect(page.locator("#waitingBar")).toBeHidden();
});

test("a card's dollar market cap says how old the price behind it is, as the launch's own page does", async ({ page }) => {
  test.setTimeout(90_000);
  await servePages(page, APP.lens, 1, (i, r) => { r.words[W.quote] = addrWord(NVDAC); r.words[W.status] = word(1); return r; });
  // THE FEED'S OWN TIME AND THE CHAIN'S, read here.
  const round = (await rawCall(NVDA_FEED, SEL.latestRoundData)).replace(/^0x/, "");
  const updatedAt = Number(BigInt("0x" + round.slice(3 * 64, 4 * 64)));
  const head = await rpcRaw("eth_getBlockByNumber", ["latest", false]);
  const s = Math.max(0, Number(BigInt(head.timestamp)) - updatedAt);
  const unit = s < 45 ? "" : s < 3600 ? "m" : s < 86400 ? "h" : "d";
  const n = unit === "m" ? s / 60 : unit === "h" ? s / 3600 : s / 86400;
  await page.goto(browseUrl(APP.lens));
  const mc = page.locator(".launch .mc").first();
  await expect(mc.locator(".mcVal")).toContainText("$", { timeout: 30000 });
  await expect.poll(async () => (await mc.getAttribute("title")) || "", { timeout: 30000 })
    .toMatch(/by Coinbase NVDA \(Chainlink\), (its price as of \d+[mhd] ago|just updated)$/);
  const title = await mc.getAttribute("title");
  if (!unit) {
    expect(title).toContain(", just updated");
  } else {
    const m = title.match(/its price as of (\d+)([mhd]) ago$/);
    expect(m, "the price's age is not said: " + title).not.toBeNull();
    expect(m[2]).toBe(unit);
    // ROUNDED THE SAME WAY, give or take the seconds between the two reads.
    expect(Math.abs(Number(m[1]) - Math.round(n)), "the age is not the feed's: " + title).toBeLessThanOrEqual(1);
  }
});

// ------------------------------------------------------------- core v2's two appended words
//
// LaunchView grew from 14 words to 16 (LaunchLens): w14 is when the launch was
// registered, by the registry's own clock, and w15 the distributor its creator
// income goes to once its holder sharing is on. Both the launches page and the
// bar's search read the record's length off the answer, so a 14-word lens still
// reads - its cards' ages from the registry's log, as before.

const W14 = 14, W15 = 15;

/// WITH THE CURRENT LENS NO LOG IS READ FOR A LAUNCH'S AGE: it is word 14. The
/// served record says a time of its own - an hour before the head - so an age
/// taken from anywhere else (the block of the registry's event) cannot match.
test("on the current lens a card's age is its record's launchedAt, and no log is read for it", async ({ page }) => {
  const headTs = parseInt((await rpcRaw("eth_getBlockByNumber", ["latest", false])).timestamp, 16);
  const real = await realRecord(APP.lens);
  expect(real.words.length, "the lens under test does not return 16 words a record").toBe(16);
  const want = headTs - 3600;
  await servePages(page, APP.lens, 1, (i, r) => { r.words[W14] = word(want); return r; });
  const logs = await onLogs(page);
  await page.goto(browseUrl(APP.lens));
  const age = page.locator(".launch .age").first();
  await expect(age).toHaveAttribute("data-ts", String(want), { timeout: 30000 });
  await expect(age).toHaveText("1h ago");
  await page.waitForTimeout(2500);
  expect(logs.n, "a log was read for a launch time the lens gave").toBe(0);
});

/// A RECORD WHOSE launchedAt IS ZERO SAYS NOTHING, and is not a launch of 1970.
test("a record whose launchedAt is zero reads '—', not an age", async ({ page }) => {
  await servePages(page, APP.lens, 1, (i, r) => { r.words[W14] = word(0); return r; });
  await page.goto(browseUrl(APP.lens));
  const age = page.locator(".launch .age").first();
  await expect(age).toHaveText("—", { timeout: 30000 });
  await expect(age).not.toHaveAttribute("data-ts", /./);
});

/// "HOLDERS EARN" IS WORD 15 BEING SET: a distributor named there, and not
/// zero. The same launch with w15 zero carries no mark, and neither does one
/// read through a 14-word lens.
test("a launch whose word 15 names a distributor carries 'Holders earn', and only that one", async ({ page }) => {
  const D = "0x" + "d1".repeat(20);
  await servePages(page, APP.lens, 2, (i, r) => { r.words[W15] = i === 1 ? addrWord(D) : word(0); return r; });
  await page.goto(browseUrl(APP.lens));
  await expect(page.locator(".launch")).toHaveCount(2, { timeout: 20000 });
  const marked = page.locator(".launch[data-index='1'] .holdersEarn");
  await expect(marked).toHaveText("Holders earn");
  await expect(marked).toHaveAttribute("title", new RegExp(D, "i"));
  await expect(page.locator(".launch[data-index='0'] .holdersEarn")).toHaveCount(0);
});

test("a 14-word lens draws no 'Holders earn' mark and still dates its cards", async ({ page }) => {
  await asOldLens(page);
  await page.goto(browseUrl(APP.lens));
  const age = page.locator(".launch .age").first();
  await expect(age).toHaveAttribute("data-ts", /^\d+$/, { timeout: 30000 });
  await expect(page.locator(".holdersEarn")).toHaveCount(0);
});

/// THE DECODERS, HANDED PAGES OF EVERY LENGTH. Three records at 14, 15 and 16
/// words, each with its own values in the words a card reads; a decoder that
/// assumed fourteen reads the second and third record from the wrong words.
/// Both the launches page's and the search's.
for (const which of ["browse", "search"]) {
  test(`the ${which} decoder reads 3 records at 14, 15 and 16 words, and refuses a page whose records do not divide`, async ({ page }) => {
    await page.goto(browseUrl(APP.lens));
    if (which === "search") {
      await page.click("#barSearch");
      await page.waitForFunction(() => !!(window.CurbSearch && window.CurbSearch.decodeLaunchPage));
    } else {
      await page.waitForFunction(() => !!(window.CurbBrowse && window.CurbBrowse.decodeLaunchPage));
    }
    const make = (stride) => {
      const recs = [0, 1, 2].map((k) => {
        const w = Array.from({ length: stride }, () => word(0));
        w[0] = word(k + 1);                         // status
        w[1] = addrWord("0x" + String(k + 1).repeat(40));   // curve
        w[6] = word(1000 + k);                      // realQuoteReserve
        w[7] = word(5000 + k);                      // graduationThreshold
        if (stride >= 15) w[14] = word(1700000000 + k);
        if (stride >= 16) w[15] = addrWord("0x" + "e" + String(k).repeat(39));
        return { token: "0x" + "a" + String(k).repeat(39), words: w };
      });
      return encodePage(recs);
    };
    for (const stride of [14, 15, 16]) {
      const got = await page.evaluate(([w, raw]) => {
        const f = w === "search" ? window.CurbSearch.decodeLaunchPage : window.CurbBrowse.decodeLaunchPage;
        return JSON.stringify(f(raw), (k, v) => (typeof v === "bigint" ? v.toString() : v));
      }, [which, make(stride)]);
      const rows = JSON.parse(got);
      expect(rows.length, `stride ${stride}: not three records`).toBe(3);
      rows.forEach((r, k) => {
        expect(r.token, `stride ${stride}: record ${k}'s token`).toBe("0x" + "a" + String(k).repeat(39));
        expect(Number(r.status), `stride ${stride}: record ${k}'s status`).toBe(k + 1);
        expect(String(r.realQuoteReserve), `stride ${stride}: record ${k}'s raised amount`).toBe(String(1000 + k));
        expect(String(r.graduationThreshold), `stride ${stride}: record ${k}'s threshold`).toBe(String(5000 + k));
        if (which === "browse") {
          expect(r.launchedAt, `stride ${stride}: record ${k}'s launchedAt`).toBe(stride >= 15 ? 1700000000 + k : null);
          expect(r.holderDistributor, `stride ${stride}: record ${k}'s distributor`)
            .toBe(stride >= 16 ? "0x" + "e" + String(k).repeat(39) : null);
        }
      });
    }
    // A PAGE WHOSE RECORDS DO NOT DIVIDE IT, OR ARE SHORTER THAN 14 WORDS, IS NOT ONE.
    const bad = make(16).slice(0, -64);
    const errs = await page.evaluate(([w, a, b]) => {
      const f = w === "search" ? window.CurbSearch.decodeLaunchPage : window.CurbBrowse.decodeLaunchPage;
      const msg = (raw) => { try { f(raw); return ""; } catch (e) { return e.message; } };
      return [msg(a), msg(b)];
    }, [which, bad, make(13)]);
    expect(errs[0], "a page whose records do not divide was decoded").toMatch(/do not divide/);
    expect(errs[1], "records of 13 words were decoded").toMatch(/fewer than 14|do not divide/);
  });
}

/// THE SEARCH SHOWS EACH TOKEN'S PICTURE (the owner's call), read from its
/// tokenURI by token-meta.js's rules, and the letter tile when it has none. A
/// fresh tab each time: the search keeps what it read for a minute per tab.
test("the bar's search shows each token's own picture, or its letters when it has none", async ({ context }) => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const uri = "data:application/json;base64," +
    Buffer.from(JSON.stringify({ image: "data:image/png;base64," + png })).toString("base64");
  const open = async (tokenUri) => {
    const p = await context.newPage();
    await p.route("**/*", async (route) => {
      const { msg, data } = callData(route);
      if (!msg || data !== SEL.tokenUri) return route.continue();
      return rpcReply(route, msg.id, abiStr(tokenUri));
    });
    await p.goto(browseUrl(APP.lens));
    await p.click("#barSearch");
    await expect(p.locator("#cbSearch .cbHit").first()).toBeVisible({ timeout: 30_000 });
    return p;
  };
  const p = await open(uri);
  const pic = p.locator("#cbSearch .cbHit .cbAv img").first();
  await expect(pic, "a search result drew no picture").toHaveAttribute("src", "data:image/png;base64," + png, { timeout: 30_000 });
  // POLLED, NOT READ ONCE: the list is drawn again as each launch's reads land,
  // and a single read taken while its rows are being replaced found no box at
  // all - twice in a full run, never alone.
  await expect.poll(async () => {
    const box = await pic.boundingBox();
    return !!(box && box.width >= 30 && box.height >= 30);
  }, { message: "the picture does not fill its tile", timeout: 15_000 }).toBe(true);
  await p.close();
  // NO PICTURE: the letters, and no image at all.
  const q = await open("");
  await expect(q.locator("#cbSearch .cbHit .cbSym").first()).not.toHaveText("…", { timeout: 30_000 });
  await expect(q.locator("#cbSearch .cbHit .cbAv img")).toHaveCount(0);
  await expect(q.locator("#cbSearch .cbHit .cbAv").first()).toHaveText(/^\S{1,2}$/);
  await q.close();
});

/// "JUST BOUGHT" ON A REAL CHAIN (the owner: "it does not work properly"). Two
/// launches made and bought through the site, the older bought first; then a
/// buy on the older one must put it first within one refresh (~15 s), and its
/// card must show the buy - its raised figure moved and "bought … ago" - not
/// the reserves it had when the page loaded, which is what the owner saw: the
/// card jumped up still saying 0%. The fork is put back afterwards.
test("Just bought on a real chain: a launch bought now jumps to the top within one refresh, with its new figures", async ({ browser }) => {
  test.setTimeout(300_000);
  const STUB = fs.readFileSync(path.join(__dirname, "..", "wallet-stub.js"), "utf8");
  const OWNER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
  const open = async () => {
    const p = await browser.newPage();
    await p.addInitScript({ content: STUB + ";window.ethereum = window.makeWallet(" + JSON.stringify(STATE.rpc) +
      ", { forward: true, chainId: '0x2105', account: " + JSON.stringify(OWNER) + " });" });
    return p;
  };
  const appAt = (q) => "/app.html?" + new URLSearchParams({ rpc: STATE.rpc, factory: APP.factory, lens: APP.lens, ...q }).toString();
  async function create(name, symbol) {
    const p = await open();
    await p.goto(appAt({}));
    await p.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
    await p.evaluate(() => window.CurbApp.connect());
    await expect.poll(() => p.evaluate(() => !!(window.CurbApp.state.ctx && window.CurbApp.state.ctx.quote)), { timeout: 30_000 }).toBe(true);
    await p.fill("#nName", name);
    await p.fill("#nSymbol", symbol);
    await p.click("#create");
    await expect(p.locator("#msg")).toContainText("Launched", { timeout: 60_000 });
    const token = (await p.evaluate(() => window.CurbApp.state.chainCfg.token)).toLowerCase();
    await p.close();
    return token;
  }
  async function buy(token, amount) {
    const p = await open();
    await p.goto(appAt({ token }));
    await p.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
    await p.evaluate(() => window.CurbApp.connect());
    await p.evaluate(() => window.CurbApp.refresh(true));
    await expect(p.locator("#curveBox")).toBeVisible({ timeout: 30_000 });
    await p.selectOption("#curveSide", "buy");
    await p.selectOption("#curveVia", "quote");
    await p.fill("#curveAmount", amount);
    await p.click("#curveAct");
    await expect(p.locator("#msg")).toContainText("Done", { timeout: 90_000 });
    await p.close();
  }
  const snap = await rpcRaw("evm_snapshot", []);
  try {
    const older = await create("Bought Long Ago", "OLDB");
    const newer = await create("Bought Lately", "NEWB");
    await buy(older, "1");
    await rpcRaw("evm_mine", []);
    await buy(newer, "1");

    const page = await open();
    await page.goto(browseUrl(APP.lens));
    await expect(page.locator(".launch").first()).toBeVisible({ timeout: 20_000 });
    await page.click("#sortBought");
    const top = () => page.locator(".launch .addr").evaluateAll((els) => els.slice(0, 2).map((e) => e.title.toLowerCase()));
    await expect.poll(top, { message: "Just bought is not the newest buy first", timeout: 20_000 }).toEqual([newer, older]);
    const card = page.locator(".launch", { has: page.locator(`.addr[title="${older}" i]`) });
    const raisedBefore = (await card.locator(".raised").textContent()).trim();
    await expect(card.locator(".age")).toHaveText(/^bought \d+[smhd] ago$/);

    // BOUGHT NOW, on the launch bought longest ago.
    await buy(older, "2");
    const t0 = Date.now();
    await expect.poll(top, { message: "a launch bought since did not move to the top within one refresh", timeout: 20_000 })
      .toEqual([older, newer]);
    expect(Date.now() - t0, "it took more than one refresh").toBeLessThan(20_000);
    // ITS CARD SAYS SO: the figures read again, and when it was bought.
    const moved = page.locator(".launch").first();
    await expect(moved.locator(".raised"), "the card that jumped up still shows the reserves from before the buy")
      .not.toHaveText(raisedBefore, { timeout: 5_000 });
    await expect(moved.locator(".age")).toHaveText(/^bought \d+s ago$/);
    // BACK ON NEWEST, the age is the launch's own again.
    await page.click("#sortNew");
    await expect(moved.locator(".age")).not.toContainText("bought");
    await page.close();
  } finally {
    expect(await rpcRaw("evm_revert", [snap]), "the snapshot was not reverted").toBe(true);
  }
});

// ================================================================== the hero
test("the hero: one line and the Launch button, and the registry's first launch as a card with its market cap, its day's change and its price line", async ({ browser }) => {
  test.setTimeout(300_000);
  const STUB = fs.readFileSync(path.join(__dirname, "..", "wallet-stub.js"), "utf8");
  const OWNER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
  const open = async (viewport = { width: 1280, height: 860 }) => {
    const p = await browser.newPage({ viewport });
    await p.addInitScript({ content: STUB + ";window.ethereum = window.makeWallet(" + JSON.stringify(STATE.rpc) +
      ", { forward: true, chainId: '0x2105', account: " + JSON.stringify(OWNER) + " });" });
    return p;
  };
  // One decimal under 1,000%; whole and grouped above it.
  const CHANGE = /^[+−](\d{1,3}\.\d|\d{1,3}(,\d{3})+)%$/;

  const WETH_ADDR = "0x4200000000000000000000000000000000000006";
  const appAt = (q) => "/app.html?" + new URLSearchParams({ rpc: STATE.rpc, factory: APP.factory, lens: APP.lens, ...q }).toString();
  /// A launch made through the form, on `factory`; its token.
  async function create(factory, name, symbol) {
    const c = await open();
    await c.goto(appAt({ factory }));
    await c.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
    await c.evaluate(() => window.CurbApp.connect());
    await expect.poll(() => c.evaluate(() => !!(window.CurbApp.state.ctx && window.CurbApp.state.ctx.quote)), { timeout: 30_000 }).toBe(true);
    await c.fill("#nName", name);
    await c.fill("#nSymbol", symbol);
    await c.evaluate(() => { window.CURB_STAY_AFTER_CREATE = true; });
    await c.click("#create");
    await expect(c.locator("#msg")).toContainText("Launched", { timeout: 60_000 });
    const token = (await c.evaluate(() => window.CurbApp.state.chainCfg.token)).toLowerCase();
    await c.close();
    return token;
  }
  /// The registry's first page as the page decodes it: its first launch, and its first ETH pair.
  async function firstPage(pg) {
    const n = Math.min(await launchCountOf(APP.lens), 50);
    const raw = await rawCall(APP.lens, SEL.launchPage + "0".repeat(64) + n.toString(16).padStart(64, "0"));
    return pg.evaluate(([r, weth]) => {
      const all = window.CurbBrowse.decodeLaunchPage(r);
      const eth = all.find((x) => x.quoteToken.toLowerCase() === weth);
      return { first: all[0].token, eth: eth ? eth.token.toLowerCase() : null };
    }, [raw, WETH_ADDR]);
  }

  const snap = await rpcRaw("evm_snapshot", []);
  try {
    // THE DEFAULT: the registry's first launch paired with ETH - $CURB on the
    // real deployment (the owner's call: an ETH pair on the front page). This
    // run's registry may hold none yet: one is made on the WETH factory first.
    let p = await open();
    await p.goto(heroUrl(APP.lens));
    let picked = await firstPage(p);
    if (!picked.eth) {
      const registry = await registryOf(APP.lens);
      const count = Number(BigInt(await rawCall(registry, SEL.launcherCount)));
      let wethFactory = null;
      for (let i = 0; i < count && !wethFactory; i++) {
        const f = "0x" + (await rawCall(registry, SEL.launcherAt + i.toString(16).padStart(64, "0"))).slice(26);
        if (("0x" + (await rawCall(f, SEL.quoteToken)).slice(26)).toLowerCase() === WETH_ADDR) wethFactory = f;
      }
      expect(wethFactory, "this deployment has no WETH factory").not.toBeNull();
      await create(wethFactory, "Hero Eth", "HETH");
      await p.close();
      p = await open();
      await p.goto(heroUrl(APP.lens));
      picked = await firstPage(p);
    }
    expect(picked.eth, "no launch in the registry's first page is paired with ETH, so this proves nothing").not.toBeNull();
    const first = picked.eth;
    await expect(p.locator("#heroPairSym")).toHaveText("ETH", { timeout: 30_000 });
    await expect(p.locator("#heroTitle")).toHaveText("Launch coins paired with ETH, stocks & more");
    await expect(p.locator("#heroLaunch")).toHaveAttribute("href", /app\.html\?.*lens=.*#create-launch$/);
    const card = p.locator("#heroCard");
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toHaveAttribute("href", new RegExp("token/" + first, "i"));
    await expect(p.locator("#heroSym")).toHaveText("$" + (await symbolOf(first)));
    await expect(p.locator("#heroMc")).toHaveText(/\d/, { timeout: 30_000 });
    await expect(p.locator("#heroChg")).toHaveText(CHANGE, { timeout: 60_000 });
    // NO COUNTS IN IT (the owner's call).
    await expect(p.locator("#hero")).not.toContainText("tokens created");
    await p.close();
    // ?hero=0: the list alone.
    const bare = await open();
    await bare.goto(browseUrl(APP.lens));
    await expect(bare.locator(".launch").first()).toBeVisible({ timeout: 30_000 });
    await expect(bare.locator("#hero")).toBeHidden();
    await bare.close();

    // A LAUNCH TRADED TODAY, featured by the link: its line has the day's trades
    // and its change is up after a second buy raised its price.
    const c = await open();
    await c.goto(appAt({}));
    await c.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
    await c.evaluate(() => window.CurbApp.connect());
    await expect.poll(() => c.evaluate(() => !!(window.CurbApp.state.ctx && window.CurbApp.state.ctx.quote)), { timeout: 30_000 }).toBe(true);
    await c.fill("#nName", "Hero Probe");
    await c.fill("#nSymbol", "HERO");
    await c.evaluate(() => { window.CURB_STAY_AFTER_CREATE = true; });
    await c.click("#create");
    await expect(c.locator("#msg")).toContainText("Launched", { timeout: 60_000 });
    const token = (await c.evaluate(() => window.CurbApp.state.chainCfg.token)).toLowerCase();
    await c.close();
    for (const amount of ["1", "2"]) {
      const b = await open();
      await b.goto(appAt({ token }));
      await b.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
      await b.evaluate(() => window.CurbApp.connect());
      await b.evaluate(() => window.CurbApp.refresh(true));
      await expect(b.locator("#curveBox")).toBeVisible({ timeout: 30_000 });
      await b.selectOption("#curveSide", "buy");
      await b.selectOption("#curveVia", "quote");
      await b.fill("#curveAmount", amount);
      await b.click("#curveAct");
      await expect(b.locator("#msg")).toContainText("Done", { timeout: 90_000 });
      await b.close();
      await rpcRaw("evm_mine", []);
    }
    const f = await open();
    await featuring(f, token);
    await f.goto(heroUrl(APP.lens, { featured: token }));
    await expect(f.locator("#heroCard")).toHaveAttribute("href", new RegExp("token/" + token, "i"), { timeout: 30_000 });
    await expect(f.locator("#heroSym")).toHaveText("$HERO");
    // THE DAY'S TRADES (two buys, and a dev buy if the form made one) AND THE PRICE NOW.
    await expect.poll(async () => Number(await f.locator("#heroLine").getAttribute("data-points")), { timeout: 60_000 })
      .toBeGreaterThanOrEqual(3);
    await expect(f.locator("#heroLine .heroPath")).toHaveCount(1);
    await expect(f.locator("#heroChg")).toHaveText(/^\+(\d{1,3}\.\d|\d{1,3}(,\d{3})+)%$/);
    await expect(f.locator("#heroChg")).not.toHaveText("+0.0%");
    await f.close();

    // ON A PHONE: the card under the words, no line, no sentence.
    const m = await open({ width: 375, height: 812 });
    await featuring(m, token);
    await m.goto(heroUrl(APP.lens, { featured: token }));
    await expect(m.locator("#heroCard")).toBeVisible({ timeout: 30_000 });
    await expect(m.locator("#heroLine")).toBeHidden();
    await expect(m.locator(".heroCopy p")).toBeHidden();
    const copy = await m.locator(".heroCopy").boundingBox();
    const box = await m.locator("#heroCard").boundingBox();
    expect(box.y, "the card is not under the words on a phone").toBeGreaterThanOrEqual(copy.y + copy.height - 1);
    await m.close();
  } finally {
    await rpcRaw("evm_revert", [snap]);
  }
});

// ================================================================== the hero from $CURB's second day
//
// WHAT THE FRONT PAGE'S CARD RUNS ON ONCE ITS LAUNCH IS A DAY OLD: the rescan
// every two minutes, the day read as the 43,200 blocks below the head where
// there is no anvil_metadata, the price a day back read at that block, and a
// launch that trades in its pool. Each on a copy of the chain thrown away after
// it.

const HERO_STUB = fs.readFileSync(path.join(__dirname, "..", "wallet-stub.js"), "utf8");
/// One decimal under 1,000%; whole and grouped above it.
const HERO_CHANGE = /^[+−](\d{1,3}\.\d|\d{1,3}(,\d{3})+)%$/;
/// The hero's change as it is written, as a number of percent.
function changeOf(s) {
  const m = String(s).trim().match(/^([+−])([\d,.]+)%$/);
  return m ? (m[1] === "−" ? -1 : 1) * Number(m[2].replace(/,/g, "")) : NaN;
}
const heroPoints = async (p) => Number(await p.locator("#heroLine").getAttribute("data-points"));
/// A page with the wallet stub, forwarding to the run's node as the deployer.
async function heroPage(browser) {
  const p = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await p.addInitScript({ content: HERO_STUB + ";window.ethereum = window.makeWallet(" + JSON.stringify(STATE.rpc) +
    ", { forward: true, chainId: '0x2105', account: " + JSON.stringify(DEPLOYER) + " });" });
  return p;
}
/// A launch made through the form on `factory`: its token, lower case.
async function launchThroughForm(browser, factory, name, symbol) {
  const c = await heroPage(browser);
  await c.goto("/app.html?" + new URLSearchParams({ rpc: STATE.rpc, factory, lens: APP.lens }).toString());
  await c.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
  await c.evaluate(() => window.CurbApp.connect());
  await expect.poll(() => c.evaluate(() => !!(window.CurbApp.state.ctx && window.CurbApp.state.ctx.quote)), { timeout: 30_000 }).toBe(true);
  await c.fill("#nName", name);
  await c.fill("#nSymbol", symbol);
  await c.evaluate(() => { window.CURB_STAY_AFTER_CREATE = true; });
  await c.click("#create");
  await expect(c.locator("#msg")).toContainText("Launched", { timeout: 60_000 });
  const token = (await c.evaluate(() => window.CurbApp.state.chainCfg.token)).toLowerCase();
  await c.close();
  return token;
}

/// A ?featured= LINK PUTS A LAUNCH IN THE FRONT PAGE'S CARD ONLY WHEN config.js
/// LISTS IT (audit, item 18): a link naming any registered launch put a
/// stranger's token in the one featured slot on the genuine domain. Named and
/// unlisted, it is ignored and the card features what it would with no link;
/// listed, it is featured.
test("a ?featured= link is honoured only for a launch config.js lists; any other is ignored", async ({ browser }) => {
  test.setTimeout(240_000);
  const snap = await rpcRaw("evm_snapshot", []);
  try {
    const a = await launchThroughForm(browser, APP.factory, "Featured Probe A", "FPA");
    const b = await launchThroughForm(browser, APP.factory, "Featured Probe B", "FPB");
    /// The token the card features once it is drawn.
    const featuredOn = async (p, url) => {
      await p.goto(url);
      await expect(p.locator("#heroCard")).toBeVisible({ timeout: 30_000 });
      return (await p.locator("#heroCard").getAttribute("data-token")).toLowerCase();
    };
    // WITH NO LINK: what the card features on its own.
    let p = await heroPage(browser);
    const plain = await featuredOn(p, heroUrl(APP.lens));
    await p.close();
    const named = plain === a ? b : a;
    // NAMED, AND config.js LISTS NOTHING (the file as committed): ignored.
    p = await heroPage(browser);
    expect(await featuredOn(p, heroUrl(APP.lens, { featured: named })), "an unlisted launch named by a link was featured").toBe(plain);
    await p.waitForTimeout(1500);
    expect((await p.locator("#heroCard").getAttribute("data-token")).toLowerCase(), "the card moved to the unlisted launch late").toBe(plain);
    await p.close();
    // NAMED, AND config.js LISTS ANOTHER: still ignored.
    p = await heroPage(browser);
    await featuring(p, plain === a ? a : b);
    expect(await featuredOn(p, heroUrl(APP.lens, { featured: named })), "a launch config.js does not list was featured").toBe(plain);
    await p.close();
    // NAMED AND LISTED: featured.
    p = await heroPage(browser);
    await featuring(p, named);
    await p.goto(heroUrl(APP.lens, { featured: named }));
    await expect(p.locator("#heroCard")).toHaveAttribute("data-token", named, { timeout: 30_000 });
    await p.close();
  } finally {
    expect(await rpcRaw("evm_revert", [snap]), "the snapshot was not reverted").toBe(true);
  }
});
/// A selector or a topic, from the page's own keccak run in node.
function keccakOf(s) {
  global.window = global.window || global;
  require("../keccak.js"); require("../abi.js");
  return window.CurbKeccak.keccak256("0x" + window.CurbAbi.utf8Hex(s));
}
const HERO_BUY_TOPIC = keccakOf("CurveBuy(address,address,uint256,uint256,uint256,uint256)");
const HERO_SELL_TOPIC = keccakOf("CurveSell(address,address,uint256,uint256,uint256,uint256)");
const HERO_SWAP_TOPIC = keccakOf("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");
const HERO_POOL_MANAGER = "0x498581ff718922c3f8e6a244956af099b2652b2b";
/// A transaction from the test's side, mined, insisting it succeeded: its receipt.
async function minedTx(tx, what) {
  const hash = await rpcRaw("eth_sendTransaction", [tx]);
  let rc = null;
  for (let i = 0; i < 80 && !rc; i++) {
    rc = await rpcRaw("eth_getTransactionReceipt", [hash]);
    if (!rc) await new Promise((r) => setTimeout(r, 250));
  }
  expect(rc && rc.status, what + " did not go through").toBe("0x1");
  return rc;
}
/// A buy of `quoteIn` NVDAc units on an NVDAc launch's curve, from the deployer: the buy's receipt.
async function buyNvdaCurve(curve, quoteIn) {
  await minedTx({ from: DEPLOYER, to: NVDAC, data: keccakOf("approve(address,uint256)").slice(0, 10) + addrWord(curve) + word(quoteIn) },
    "the approval");
  return minedTx({ from: DEPLOYER, to: curve,
    data: keccakOf("buy(uint256,uint256,address)").slice(0, 10) + word(quoteIn) + word(0) + addrWord(DEPLOYER) }, "the buy");
}
/// An NVDAc curve's price per whole token in whole NVDAc at `block`, from the
/// lens's reserves (8 decimals against the token's 18).
async function nvdaCurvePriceAt(token, block) {
  const raw = (await rpcRaw("eth_call", [{ to: APP.lens, data: SEL.launchState + addrWord(token) }, block])).replace(/^0x/, "");
  const w = (i) => BigInt("0x" + raw.slice(i * 64, (i + 1) * 64));
  return (Number(w(4)) / Number(w(5))) * 1e10;
}
/// What one curve trade paid per whole token, in whole units of an asset of `qd` decimals.
function curveTradePrice(log, qd) {
  const d = log.data.replace(/^0x/, "");
  const n = (i) => BigInt("0x" + d.slice(i * 64, (i + 1) * 64));
  const buy = log.topics[0] === HERO_BUY_TOPIC;
  const tokens = buy ? n(1) : n(0);
  const quote = buy ? n(0) - n(2) - n(3) : n(1) + n(2) + n(3);
  return (Number(quote) / Number(tokens)) * 10 ** (18 - qd);
}

/// THE LINE KEEPS UP WITH THE TRADES AND COUNTS EACH ONCE. Every two minutes the
/// card reads again only the blocks it has not read: a buy made after the page
/// loaded is one new point and moves the change, and a rescan with nothing new
/// adds nothing and reads nothing twice. The two minutes are the page's own
/// clock, moved on (Playwright's clock).
test("the hero's rescan: a trade made after the page loaded is one new point on its line, and a rescan with nothing new adds none", async ({ browser }) => {
  test.setTimeout(240_000);
  const snap = await rpcRaw("evm_snapshot", []);
  try {
    const token = await launchThroughForm(browser, APP.factory, "Hero Rescan", "HRSC");
    const curve = (await curveOf(APP.lens, token)).toLowerCase();
    await buyNvdaCurve(curve, 10n ** 8n);
    await buyNvdaCurve(curve, 2n * 10n ** 8n);
    const p = await heroPage(browser);
    const reads = [];   // the hero's own log reads, [from, to]: the curve's
    await p.route("**/*", async (route) => {
      const msg = rpcMsg(route);
      if (msg && !Array.isArray(msg) && msg.method === "eth_getLogs") {
        const f = msg.params[0];
        if (String(f.address || "").toLowerCase() === curve) reads.push([parseInt(f.fromBlock, 16), parseInt(f.toBlock, 16)]);
      }
      return route.fallback();
    });
    await p.clock.install();
    await featuring(p, token);
    await p.goto(heroUrl(APP.lens, { featured: token }));
    await expect(p.locator("#heroCard")).toHaveAttribute("href", new RegExp("token/" + token, "i"), { timeout: 30_000 });
    await expect.poll(() => heroPoints(p), { timeout: 60_000, message: "the line was never drawn" }).toBeGreaterThanOrEqual(3);
    await expect(p.locator("#heroChg")).toHaveText(HERO_CHANGE, { timeout: 30_000 });
    const before = await heroPoints(p);
    const changeBefore = changeOf(await p.locator("#heroChg").textContent());
    const readTo = Math.max(...reads.map(([, b]) => b));

    // A BUY AFTER THE PAGE LOADED, then the page's two minutes moved on.
    const bought = parseInt((await buyNvdaCurve(curve, 3n * 10n ** 8n)).blockNumber, 16);
    const asked = reads.length;
    await p.clock.fastForward(2 * 60 * 1000 + 1000);
    await expect.poll(() => heroPoints(p), { timeout: 30_000, message: "the rescan did not draw the new buy as one point" })
      .toBe(before + 1);
    await expect.poll(async () => changeOf(await p.locator("#heroChg").textContent()),
      { timeout: 30_000, message: "the change did not move with the buy" }).toBeGreaterThan(changeBefore);
    // ONLY THE BLOCKS NOT YET READ, the new buy's among them.
    const rescan = reads.slice(asked);
    expect(rescan.length, "the rescan read no log").toBeGreaterThan(0);
    expect(Math.min(...rescan.map(([a]) => a)), "the rescan did not start after the blocks it had read").toBe(readTo + 1);
    expect(Math.max(...rescan.map(([, b]) => b)), "the rescan did not reach the new buy").toBeGreaterThanOrEqual(bought);

    // AND A RESCAN WITH NOTHING NEW: nothing added, nothing read again.
    const asked2 = reads.length;
    await p.clock.fastForward(2 * 60 * 1000 + 1000);
    await p.waitForTimeout(3000);
    expect(await heroPoints(p), "a rescan with nothing new changed the line").toBe(before + 1);
    expect(reads.slice(asked2).filter(([a]) => a <= bought), "a rescan read again blocks it had read").toEqual([]);
    await p.close();
  } finally {
    await rpcRaw("evm_revert", [snap]);
  }
});

/// A LAUNCH OLDER THAN A DAY, AS ON BASE ITSELF. There is no anvil_metadata, so
/// the day is the 43,200 blocks below the head and not the fork's own; the
/// endpoint limits a log range (to 1,000 blocks here) and is busy once; and the
/// change is against the price at the block a day back, read at that block -
/// not against the first trade of the day, nor the launch's first price.
///
/// THE HEAD IS SAID TO BE A DAY ON: its number 43,200 blocks past the block
/// after the first buy, its time a day after the second buy less ten minutes,
/// and the blocks above the real head answer no logs. A day of this fork's
/// blocks takes minutes to mine.
test("the hero on a launch older than a day: the day's 43,200 blocks without anvil_metadata, through a log limit and a 429, and its change against the price a day back", async ({ browser }) => {
  test.setTimeout(240_000);
  const snap = await rpcRaw("evm_snapshot", []);
  try {
    const token = await launchThroughForm(browser, APP.factory, "Hero Old", "HOLD");
    const curve = (await curveOf(APP.lens, token)).toLowerCase();
    const first = await buyNvdaCurve(curve, 10n ** 8n);
    // TWO HOURS LATER, the second buy: inside the day the page sees, the first outside it.
    await rpcRaw("evm_increaseTime", ["0x" + (2 * 3600).toString(16)]);
    const second = await buyNvdaCurve(curve, 2n * 10n ** 8n);
    const dayAgo = parseInt(first.blockNumber, 16);
    const latest = await rpcRaw("eth_getBlockByNumber", ["latest", false]);
    const real = parseInt(latest.number, 16);
    const head = dayAgo + 43200;
    const secondTs = parseInt((await rpcRaw("eth_getBlockByNumber", [second.blockNumber, false])).timestamp, 16);
    const now = secondTs + 86400 - 600;
    const LIMIT = 1000;
    const seen = { served: [], refused: 0, busy: null, meta: 0 };
    const p = await heroPage(browser);
    await p.route("**/*", async (route) => {
      const msg = rpcMsg(route);
      if (!msg || Array.isArray(msg)) return route.fallback();
      if (msg.method === "anvil_metadata") {
        seen.meta += 1;
        return rpcRefuse(route, msg.id, -32601, "the method anvil_metadata does not exist");
      }
      if (msg.method === "eth_getBlockByNumber" && msg.params[0] === "latest") {
        return rpcReply(route, msg.id, { ...latest, number: "0x" + head.toString(16), timestamp: "0x" + now.toString(16) });
      }
      if (msg.method !== "eth_getLogs") return route.fallback();
      const f = msg.params[0];
      if (String(f.address || "").toLowerCase() !== curve) return route.fallback();
      const from = parseInt(f.fromBlock, 16), to = parseInt(f.toBlock, 16);
      if (to - from + 1 > LIMIT) {
        seen.refused += 1;
        return rpcRefuse(route, msg.id, -32600, "eth_getLogs is limited to a 1,000 range");
      }
      if (!seen.busy && seen.served.length === 3) {
        seen.busy = [from, to];
        return route.fulfill({ status: 429, contentType: "text/plain", body: "Too Many Requests" });
      }
      seen.served.push([from, to]);
      if (from > real) return rpcReply(route, msg.id, []);
      if (to > real) {
        f.toBlock = "0x" + real.toString(16);
        return route.fallback({ postData: JSON.stringify(msg) });
      }
      return route.fallback();
    });
    await featuring(p, token);
    await p.goto(heroUrl(APP.lens, { featured: token }));
    await expect(p.locator("#heroCard")).toHaveAttribute("href", new RegExp("token/" + token, "i"), { timeout: 30_000 });
    // THE DAY'S LINE: the price a day back, the second buy, and the price now.
    await expect.poll(() => heroPoints(p), { timeout: 90_000, message: "the day's line is not its three points" }).toBe(3);
    await expect(p.locator("#heroChg")).toHaveText(HERO_CHANGE, { timeout: 30_000 });

    // THE CHANGE IS AGAINST THE PRICE A DAY BACK, read at that block.
    const ref = await nvdaCurvePriceAt(token, "0x" + dayAgo.toString(16));
    const nowPrice = await nvdaCurvePriceAt(token, "latest");
    const want = (nowPrice / ref - 1) * 100;
    // NOT VACUOUS: the day's first trade and the launch's first price give other figures.
    const secondLog = second.logs.find((l) => l.address.toLowerCase() === curve && l.topics[0] === HERO_BUY_TOPIC);
    const againstFirstTrade = (nowPrice / curveTradePrice(secondLog, 8) - 1) * 100;
    expect(Math.abs(want - againstFirstTrade), "the price a day back and the day's first trade agree, so this proves nothing")
      .toBeGreaterThan(1);
    const shown = changeOf(await p.locator("#heroChg").textContent());
    expect(Math.abs(shown - want), `the change ${shown}% is not against the price a day back (${want.toFixed(2)}%)`).toBeLessThan(0.15);

    // THE DAY WAS THE 43,200 BLOCKS BELOW THE HEAD, read in the endpoint's windows.
    expect(seen.meta, "anvil_metadata was never asked, so its absence was not met").toBeGreaterThan(0);
    expect(Math.min(...seen.served.map(([a]) => a)), "the day did not start 43,200 blocks below the head").toBe(head - 43200);
    expect(Math.max(...seen.served.map(([, b]) => b)), "the day did not reach the head").toBe(head);
    expect(seen.refused, "the log limit was met more than once: it was not learnt").toBe(1);
    expect(seen.busy, "no read was rate-limited, so this proves nothing about it").not.toBeNull();
    expect(seen.served.some(([a, b]) => a === seen.busy[0] && b === seen.busy[1]), "the rate-limited window was not asked again as it was")
      .toBe(true);
    const narrow = seen.served.filter(([a, b]) => b !== head && b - a + 1 !== LIMIT);
    expect(narrow, "windows narrower than the endpoint's limit were asked for").toEqual([]);
    await p.close();
  } finally {
    await rpcRaw("evm_revert", [snap]);
  }
});

/// A GRADUATED LAUNCH ON THE FRONT PAGE: its change from its pool's price, and
/// its line with the pool's swaps after the curve's trades. The other
/// deployment's waiting launch is moved into its pool here - anyone may - and
/// bought there once through its own page's swap card, in ETH.
test("the hero on a graduated launch: its change from its pool's price, and the pool's swaps on its line", async ({ browser }) => {
  test.setTimeout(300_000);
  const token = STATE.token.toLowerCase();
  const lens = OTHER.lens;
  const snap = await rpcRaw("evm_snapshot", []);
  try {
    const before = await launchView(lens, token);
    test.skip(before.status !== 2 && before.status !== 3, "the other deployment's launch is neither waiting nor graduated on this run");
    if (before.status === 2) {
      await minedTx({ from: DEPLOYER, to: OTHER.graduator, data: GRADUATE + addrWord(token), gas: "0x" + (12_000_000).toString(16) },
        "the graduation");
    }
    // ONE BUY IN THE POOL, through the launch's own page.
    const t = await heroPage(browser);
    await t.goto("/token/" + token + "?" + new URLSearchParams({ rpc: STATE.rpc, lens }).toString());
    await expect(t.locator("#tvStatus")).toHaveText("Graduated", { timeout: 30_000 });
    await t.evaluate(() => window.CurbApp.connect());
    await expect.poll(() => t.evaluate(() => ((window.CurbApp.state.viewFor || {}).token || "").toLowerCase()), { timeout: 30_000 })
      .toBe(token);
    await t.fill("#tvPay", "0.01");
    await expect(t.locator("#tvAct")).toBeEnabled({ timeout: 30_000 });
    await t.click("#tvAct");
    await expect(t.locator("#msg")).toContainText("Swapped", { timeout: 90_000 });
    await t.close();

    // WHAT THE CHAIN SAYS: the day's trades on the curve and in the pool, the
    // first of them, and the pool's price now.
    const v = (await rawCall(lens, SEL.launchState + addrWord(token))).replace(/^0x/, "");
    const w = (i) => v.slice(i * 64, (i + 1) * 64);
    expect(Number(big(w(0))), "the launch did not graduate").toBe(3);
    const curve = "0x" + w(1).slice(24);
    const quote = "0x" + w(2).slice(24);
    const qd = await decimalsOf(quote);
    // THE POOL'S ID, hashed from the record's PoolKey as the page hashes it (keccakOf loaded the keccak).
    const poolId = window.CurbKeccak.keccak256("0x" + v.slice(9 * 64, 14 * 64));
    const tokenIsC0 = ("0x" + w(9).slice(24)).toLowerCase() === token;
    const poolPrice = (sqrt) => {
      const r = Number(sqrt) / 2 ** 96;
      return tokenIsC0 ? r * r * 10 ** (18 - qd) : 10 ** (18 - qd) / (r * r);
    };
    const meta = await rpcRaw("anvil_metadata", []);
    const head = await rpcRaw("eth_getBlockByNumber", ["latest", false]);
    const from = "0x" + Math.max(parseInt(head.number, 16) - 43200, Number(meta.forkedNetwork.forkBlockNumber) + 1).toString(16);
    const curveLogs = await rpcRaw("eth_getLogs", [{ address: curve, topics: [[HERO_BUY_TOPIC, HERO_SELL_TOPIC]], fromBlock: from, toBlock: head.number }]);
    const swaps = await rpcRaw("eth_getLogs", [{ address: HERO_POOL_MANAGER, topics: [HERO_SWAP_TOPIC, poolId], fromBlock: from, toBlock: head.number }]);
    expect(swaps.length, "no swap in the launch's pool, so its line proves nothing about swaps").toBeGreaterThan(0);
    const start = parseInt(head.timestamp, 16) - 86400;
    const tsOf = async (b) => parseInt((await rpcRaw("eth_getBlockByNumber", [b, false])).timestamp, 16);
    const day = [];
    for (const l of curveLogs.concat(swaps)) if (await tsOf(l.blockNumber) >= start) day.push(l);
    day.sort((a, b) => parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16) || parseInt(a.logIndex, 16) - parseInt(b.logIndex, 16));
    const launchedAt = v.length / 64 >= 16 ? Number(big(w(14))) : 0;
    expect(launchedAt > start, "the launch is older than a day on this run's chain, which this test does not read").toBe(true);
    const firstPrice = day[0].topics[0] === HERO_SWAP_TOPIC
      ? poolPrice(BigInt("0x" + day[0].data.replace(/^0x/, "").slice(128, 192)))
      : curveTradePrice(day[0], qd);
    const sqrtNow = big((await rawCall(STATE_VIEW, GET_SLOT0 + poolId.replace(/^0x/, ""))).replace(/^0x/, "").slice(0, 64));
    const want = (poolPrice(sqrtNow) / firstPrice - 1) * 100;

    const p = await heroPage(browser);
    await featuring(p, token);
    await p.goto(heroUrl(lens, { featured: token }));
    await expect(p.locator("#heroCard")).toHaveAttribute("href", new RegExp("token/" + token, "i"), { timeout: 30_000 });
    // EVERY TRADE OF THE DAY, THE POOL'S SWAPS AMONG THEM, AND THE PRICE NOW.
    await expect.poll(() => heroPoints(p), { timeout: 60_000, message: "the line does not hold the day's trades and swaps" })
      .toBe(day.length + 1);
    await expect(p.locator("#heroMc")).toHaveText(/\d/, { timeout: 30_000 });
    await expect(p.locator("#heroMc"), "the market cap is not the pool's").toHaveAttribute("title", /Uniswap v4 pool/);
    await expect(p.locator("#heroChg")).toHaveText(HERO_CHANGE, { timeout: 30_000 });
    const shown = changeOf(await p.locator("#heroChg").textContent());
    expect(Math.abs(shown - want), `the change ${shown}% is not the pool's price against the day's first trade (${want.toFixed(2)}%)`)
      .toBeLessThanOrEqual(Math.max(0.15, Math.abs(want) * 0.005));
    await p.close();
  } finally {
    await rpcRaw("evm_revert", [snap]);
  }
});
