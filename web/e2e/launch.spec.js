// THE BROWSER CHECKS AS A COMMAND THAT CAN FAIL.
//
// tests.html is the in-page suite: eighteen scenarios, opened by hand, loading
// launch.js by fetch-and-eval. It is thorough and it proves nothing about a
// build, because nobody has to run it and nothing exits non-zero when it
// breaks. This file makes it a gate, and covers the things it structurally
// cannot reach:
//
//   1. THE REAL PAGE. tests.html evaluates launch.js itself, so it never tests
//      that launch.html loads the script at all. Every test here navigates to
//      launch.html.
//   2. A PROVIDER THAT IS ALREADY THERE. A wallet extension exists before the
//      page's own scripts run, and a site it has already been permitted on is
//      recognised WITHOUT a click. Injecting a provider afterwards, as the
//      in-page harness must, skips the cold path init() actually takes.
//   3. A REAL RELOAD AND REAL SECOND TABS. tests.html says so itself about its
//      two-context scenario - "they cannot have separate DOMs here" - and
//      asserts on the wallet instead. Here they are two pages sharing one
//      origin's storage and Web Locks, which is what two tabs are.
//
// What is still simulated: the wallet. The confirm dialog, the signing and the
// broadcast come from web/wallet-stub.js - the same file the in-page suite
// uses, so the two cannot drift. Chain reads and chain state are real: the
// stub forwards eth_call to the fork.
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

const STATE = JSON.parse(fs.readFileSync(path.join(__dirname, ".state.json"), "utf8"));
const STUB = fs.readFileSync(path.join(__dirname, "..", "wallet-stub.js"), "utf8");

const ADDRS = { lens: STATE.lens, token: STATE.token, rpc: STATE.rpc };

/// Open launch.html the way a returning user does: the addresses already
/// remembered, and - unless `wallet` is false - a provider present BEFORE the
/// page's scripts run.
async function openPage(page, { wallet = {}, addrs = ADDRS, pending = [] } = {}) {
  // ONE init script, not two.
  //
  // The stub has to be defined before the line that calls makeWallet, and
  // Playwright does not define the order in which separate init scripts run -
  // its documentation says so outright. Two scripts happened to work here, and
  // would have been a race waiting for a slow day. Within one script the order
  // is the order it is written in.
  //
  // The configuration is baked in as JSON rather than passed as an argument,
  // which means FUNCTIONS DO NOT SURVIVE: the in-page suite's onSend hook has
  // no equivalent here. Nothing in this file needs one, and a callback that was
  // silently dropped would be worse than not offering one.
  const bootstrap = [
    STUB,
    ";(function () {",
    "  var cfg = " + JSON.stringify({ addrs, wallet, pending }) + ";",
    "  localStorage.setItem('curb.launch.addrs', JSON.stringify(cfg.addrs));",
    "  for (var i = 0; i < cfg.pending.length; i++) {",
    "    var tx = cfg.pending[i];",
    "    localStorage.setItem('curb.launch.pending.v3:' + tx.chainId + ':' + tx.hash, JSON.stringify(tx));",
    "  }",
    "  if (cfg.wallet) window.ethereum = window.makeWallet(cfg.addrs.rpc, cfg.wallet);",
    "})();",
  ].join("\n");
  await page.addInitScript({ content: bootstrap });

  await page.goto("/launch.html");
  // Short, and on purpose: if the page does not wire its script there is
  // nothing to wait for, and every test would otherwise sit out its full
  // timeout before saying so. A broken <script src> should fail in seconds.
  await page.waitForFunction(() => !!window.CurbLaunch, null, { timeout: 8_000 });
  return page;
}

const msg = (page) => page.locator("#msg");

test("launch.html wires its own script and reads the chain", async ({ page }) => {
  // THE IN-PAGE SUITE CANNOT FAIL ON THIS. It never loads launch.html as a
  // page, so a broken <script src> would leave all eighteen scenarios green.
  await openPage(page, { wallet: false });
  await expect(page.locator("#statusText")).toHaveText("Waiting", { timeout: 20_000 });
  await expect(page.locator("#card")).toBeVisible();
  // No wallet: the move is described but cannot be started from here.
  await expect(page.locator("#complete")).toBeDisabled();
  // The Graduator is read from the lens, never typed.
  await expect(page.locator("#grad")).toHaveValue(/^0x[0-9a-fA-F]{40}$/);
});

test("an already-permitted wallet is recognised at load, with no click", async ({ page }) => {
  // WITHOUT TOUCHING #connect. init() reads eth_accounts itself, which is the
  // path a returning visitor takes: the site already has permission, so the
  // page is expected to know the account before anything is clicked. Every
  // other test here clicks connect first, and a broken auto-detect would hide
  // behind that click in all of them.
  await openPage(page, { wallet: { connected: true, receipt: null } });

  await expect(page.locator("#wallet")).toContainText("Connected:", { timeout: 20_000 });
  await expect(page.locator("#statusText")).toHaveText("Waiting");
  // Enabled by render(), which is reached only if init() actually found the
  // account: the button's state is `busy || !account`.
  await expect(page.locator("#complete")).toBeEnabled();
  expect(await page.evaluate(() => window.ethereum.sent.length)).toBe(0);
});

test("a wallet that has NOT granted permission is not treated as connected", async ({ page }) => {
  // The other half of the same behaviour. eth_accounts returns [] until the
  // site is permitted, and the page must ask rather than assume - without this,
  // an "auto-detect" that simply always reported an account would pass the test
  // above.
  await openPage(page, { wallet: { connected: false, receipt: null } });

  await expect(page.locator("#statusText")).toHaveText("Waiting", { timeout: 20_000 });
  await expect(page.locator("#wallet")).not.toContainText("Connected:");
  await expect(page.locator("#complete")).toBeDisabled();

  // And granting it through the button is what changes that.
  await page.click("#connect");
  await expect(page.locator("#wallet")).toContainText("Connected:");
  await expect(page.locator("#complete")).toBeEnabled();
});

test("a connected wallet sends one transaction, to the Graduator the lens reported", async ({ page }) => {
  await openPage(page, { wallet: { receipt: null } });
  await page.click("#connect");
  await expect(page.locator("#complete")).toBeEnabled();

  await page.click("#complete");
  await expect(msg(page)).toContainText(/Tracking|Waiting for you to confirm/, { timeout: 20_000 });

  const sent = await page.evaluate(() => window.ethereum.sent);
  expect(sent).toHaveLength(1);
  const grad = await page.inputValue("#grad");
  expect(sent[0].to.toLowerCase()).toBe(grad.toLowerCase());
});

test("an unresolved transaction survives an actual page reload", async ({ page }) => {
  // The in-page suite fakes the reload by re-evaluating launch.js into a fresh
  // context. This is the real thing: a new document, a new script run, and the
  // record read back out of storage by init() itself.
  await openPage(page, { wallet: { receipt: null } });
  await page.click("#connect");
  await page.click("#complete");
  await expect(msg(page)).toContainText("Tracking", { timeout: 20_000 });
  const stored = await page.evaluate(() => window.CurbLaunch.loadPendingAll());
  expect(stored).toHaveLength(1);
  const hash = stored[0].hash;
  expect(hash).toMatch(/^0x[0-9a-f]{64}$/);

  await page.reload();
  await page.waitForFunction(() => !!window.CurbLaunch, null, { timeout: 8_000 });
  await expect(msg(page)).toContainText(hash, { timeout: 20_000 });
  await expect(msg(page)).toContainText(/has still not been mined|unaccounted for/);
});

test("two real tabs produce ONE transaction", async ({ context }) => {
  // Two pages of one browser context: one origin, one localStorage, one Web
  // Locks namespace. That is what two tabs are, and it is the thing the
  // in-page harness says outright it cannot build.
  const a = await openPage(await context.newPage(), { wallet: { sendDelayMs: 800, receipt: null } });
  const b = await openPage(await context.newPage(), { wallet: { sendDelayMs: 800, receipt: null } });

  await a.click("#connect");
  await b.click("#connect");
  await expect(a.locator("#complete")).toBeEnabled();
  await expect(b.locator("#complete")).toBeEnabled();

  await Promise.all([a.click("#complete"), b.click("#complete")]);
  await a.waitForTimeout(2500);

  const sentA = await a.evaluate(() => window.ethereum.sent.length);
  const sentB = await b.evaluate(() => window.ethereum.sent.length);
  expect(sentA + sentB).toBe(1);

  // And the tab that did not send says why, rather than looking broken.
  const loser = sentA === 0 ? a : b;
  await expect(msg(loser)).toContainText(
    /Another tab is already sending|already a transaction for this launch/
  );

  await a.close();
  await b.close();
});

test("the eighteen in-page scenarios all pass", async ({ page }) => {
  // The gate. tests.html reports into window.__testResults, so its result is
  // this process's exit code rather than something a person has to look at.
  const q = new URLSearchParams({ ...ADDRS, auto: "1" });
  await page.goto("/tests.html?" + q.toString());

  const results = await page
    .waitForFunction(() => window.__testResults, null, { timeout: 55_000 })
    .then((h) => h.jsonValue());

  const failed = results.results.filter((r) => r.ok === false);
  expect(failed.map((r) => `${r.name} — ${r.why}`)).toEqual([]);
  // A SKIP is not a pass. Every scenario after the first is skipped when the
  // launch is not Waiting, and a run of eighteen skips would otherwise look
  // like a clean run with zero failures.
  expect(results.skip, "scenarios were skipped - is the launch still Waiting?").toBe(0);
  expect(results.pass).toBe(18);
});

/// APP.HTML'S RECORDS ARE APP.HTML'S TO SETTLE.
///
/// Both pages share one store. launch.html used to settle and DELETE every
/// record it found - app's kept create record included, the one app needs to
/// recover a new token's address - and then report on whatever token was in
/// app's form. A mined transaction of app's is planted; it must still be there.
test("launch.html leaves app.html's pending records alone", async ({ page }) => {
  const post = (method, params) => fetch(STATE.rpc, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }).then((r) => r.json()).then((r) => r.result);
  const chainId = await post("eth_chainId", []);
  let hash = null;
  for (let n = Number(await post("eth_blockNumber", [])); n > 0 && !hash; n--) {
    const block = await post("eth_getBlockByNumber", ["0x" + n.toString(16), false]);
    if (block && block.transactions && block.transactions.length) hash = block.transactions[0];
  }
  expect(hash, "no mined transaction on this node to plant").toBeTruthy();

  const record = { page: "app", kind: "create", chainId, rpc: STATE.rpc, lens: "", token: "",
    factory: STATE.app.factory, from: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8", to: STATE.app.factory,
    hash, what: "create the launch PLANTED" };
  // forward: true, so the receipt comes from the node. The stub's own answer
  // is null by default - "not mined" - and a record that never reads as mined
  // never reaches the code that deleted it, so the test passed either way.
  await openPage(page, { pending: [record], wallet: { forward: true } });
  await expect(page.locator("#card")).toBeVisible({ timeout: 20_000 });
  const key = "curb.launch.pending.v3:" + chainId + ":" + hash;
  // resumePending runs at load; give it the time a settle would take.
  await page.waitForTimeout(3_000);
  expect(await page.evaluate((k) => localStorage.getItem(k), key), "launch.html deleted app.html's record").not.toBeNull();
  // THE HASH, not the record's `what` - launch.html never prints `what`, so
  // that assertion could not fail.
  await expect(msg(page)).not.toContainText(hash);
});

/// complete() IGNORES app.html's CREATES AND CLAIMS, AND COUNTS ITS TRADES ON
/// THIS LAUNCH.
test("launch.html's complete ignores an app create or claim, and is blocked by an app trade on this launch", async ({ context }) => {
  const plant = (kind, lens, token) => ({ page: "app", kind, chainId: "0x2105", rpc: STATE.rpc, lens, token,
    factory: STATE.app.factory, from: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8", to: STATE.app.factory,
    hash: "0x" + ({ create: "21", "create-approve": "23", claim: "24" }[kind] || "22").repeat(32), what: kind });

  // PLANTED ON THIS LAUNCH, AS app.html WRITES THEM. A create's record carries
  // whatever lens and token were in app's form, which can be this very launch.
  // Planted with an empty lens and token, as they were, they never matched
  // launch.html's search at all - so the kind filter was not what let complete
  // through, and the test passed with it deleted.
  // A CLAIM TOO: it is recorded against the lens and token in app's form the
  // same way, and its exclusion was the one clause of the filter no plant
  // reached - deleting it left this green (round 4, P-R41).
  const p1 = await context.newPage();
  await openPage(p1, { wallet: { receipt: null },
    pending: [plant("create", STATE.lens, STATE.token), plant("create-approve", STATE.lens, STATE.token),
      plant("claim", STATE.lens, STATE.token)] });
  await p1.click("#connect");
  await p1.click("#complete");
  await expect(msg(p1)).toContainText(/Tracking|Waiting for you to confirm/, { timeout: 20_000 });
  // p1's OWN SEND NEVER MINES (receipt: null) and the two pages share one
  // context, so its record would block p2 first - with "a previous visit" -
  // and the app-trade refusal below would never be reached. Cleared, so p2
  // starts with nothing but the record it plants.
  await p1.evaluate(() => localStorage.clear());
  await p1.close();

  const p2 = await context.newPage();
  await openPage(p2, { wallet: { receipt: null }, pending: [plant("action", STATE.lens, STATE.token)] });
  await p2.click("#connect");
  await p2.click("#complete");
  // BLOCKED BY THE APP TRADE, IN EITHER WORDING: the refusal ("already a
  // transaction"), or the line launch.html now writes for a record it tried to
  // settle and cannot ("has still not been mined ... Forget this record").
  // What matters is the hash named and nothing sent.
  await expect(msg(p2)).toContainText(/already a transaction|has still not been mined/, { timeout: 20_000 });
  await expect(msg(p2), "p2 was blocked by something other than the app trade").toContainText("0x" + "22".repeat(32));
  expect(await p2.evaluate(() => window.ethereum.sent.length), "a second payment for one move was sent").toBe(0);
  await p2.close();
});

/// AN OLDER READ THAT LANDS LAST DRAWS NOTHING. refresh() had no staleness
/// guard, so a read for the previous token finishing after the one for the
/// token now in the form drew its status and "Graduate" button under the new
/// form (round 5, N31). The first read's launch state is held until the form
/// has moved on and drawn; it is then let through.
test("an older launch.html read that lands last does not draw over the launch now in the form", async ({ page }) => {
  await openPage(page, { wallet: false });
  // THE CONTROL: this status line can show the held launch's status at all.
  await expect(page.locator("#statusText")).toHaveText("Waiting", { timeout: 20_000 });

  const launchState = ("0x3cb24365" + STATE.token.toLowerCase().replace(/^0x/, "").padStart(64, "0"));
  // KEPT, NOT SLEPT ON: the handler returns at once and the request is let
  // through later, so nothing else waits behind it.
  let held = null;
  await page.route("**/*", (route) => {
    let m = null;
    try { m = JSON.parse(route.request().postData() || ""); } catch { m = null; }
    const call = m && m.method === "eth_call" && m.params && m.params[0];
    if (call && !held && String(call.data || call.input || "").toLowerCase() === launchState) {
      held = route;
      return;
    }
    return route.continue();
  });
  const first = page.evaluate(() => window.CurbLaunch.refresh(true).then((s) => (s ? s.status : null)));
  await expect.poll(() => !!held, { timeout: 20_000, message: "the first read never asked for the launch" }).toBe(true);

  // A TOKEN NO REGISTRY KNOWS, read and drawn while the first read is out.
  await page.fill("#token", "0x000000000000000000000000000000000000bEEF");
  await page.dispatchEvent("#token", "change");
  await expect(page.locator("#statusText")).toHaveText("NotFound", { timeout: 20_000 });

  await held.continue();
  expect(await first, "the older read drew a launch the form had left").toBeNull();
  await expect(page.locator("#statusText")).toHaveText("NotFound");
});

/// THE QUOTE SIDE IS SCALED BY THE ASSET'S OWN DECIMALS. It was a fixed 8,
/// which every launch in this file happens to use - so the asset's answer is
/// changed to 6 here, and the figure must move by exactly a factor of 100.
test("launch.html scales the quote side by the asset's own decimals", async ({ page, context }) => {
  const readReserve = async (p) => {
    const dd = p.locator("#facts dt", { hasText: "curve quote reserve" }).locator("xpath=following-sibling::dd[1]");
    await expect(dd).toBeVisible({ timeout: 20_000 });
    return (await dd.textContent()) || "";
  };
  await openPage(page);
  const at8 = await readReserve(page);
  expect(at8).toContain("NVDAc");

  const p2 = await context.newPage();
  await p2.route("**/*", async (route) => {
    const raw = route.request().postData() || "";
    if (route.request().method() !== "POST" || !raw) return route.continue();
    let m; try { m = JSON.parse(raw); } catch { return route.continue(); }
    const data = ((m.params && m.params[0] && m.params[0].data) || "").toLowerCase();
    if (m.method === "eth_call" && data === "0x313ce567") {
      return route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id: m.id, result: "0x" + (6).toString(16).padStart(64, "0") }) });
    }
    return route.continue();
  });
  await openPage(p2);
  const at6 = await readReserve(p2);
  const num = (t) => Number(t.replace(/[^0-9.]/g, ""));
  expect(num(at8), "the reserve read as zero, so the comparison means nothing").toBeGreaterThan(0);
  expect(num(at6) / num(at8), "the figure did not follow the asset's decimals").toBeCloseTo(100, 1);
});
