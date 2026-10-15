// THE PENDING-RECORD LIFECYCLE, ON BOTH PAGES, AGAINST THE REAL FORK.
//
// A record exists so one thing is not paid for twice. It used to be cleared as
// "replaced or dropped" on the strength of a nonce the page GUESSED from its own
// endpoint before the wallet signed, with one receipt read and no second look -
// so a create still pending, or one mined between two reads, was cleared and a
// second create let through; a create the wallet sped up was cleared although
// its replacement had made the launch; and launch.html's records refused
// app.html's trades with advice (reload) that could not clear them.
//
// What is held here, each by a test that fails without it:
//   - the nonce recorded is the one the transaction CARRIES, read back by hash
//   - a record is cleared only on a receipt, or on a nonce the sender has moved
//     past WITH no receipt and no node that knows the hash on a second look
//   - a replaced create is looked for: a sped-up one is adopted, one whose
//     nonce made no launch is cleared, and one that cannot be searched for is
//     kept with the warning that a launch may exist
//   - launch.html's records for the launch on screen are settled by app.html,
//     and block it only for the account that sent them
//   - outstandingFor blocks each scope by its own kind only
//   - launch.html settles what can block it too, and ignores app's claims
//   - a record nothing on chain can settle can be forgotten, by hand, only then
//   - round 5: every record is judged, a mined create the form cannot adopt is
//     said once per load and refuses nothing, and no resume after an action
//     writes over its result (N02); a record is settled through an endpoint
//     that serves its chain - never one only a link named (N04, N50); a nonce
//     is kept only when the wallet answered on the record's chain, and a
//     record signed across a network switch, dropped by the network, or
//     unreadable past the hour may be forgotten on confirm (N03, N54, P-R22)
//
// FABRICATED HASHES stand for transactions the node has never seen: that is
// exactly what a replaced hash is from the chain's side. The nonces they carry
// are REAL nonces of REAL transactions, sent here, so every "the nonce has
// been used" is the node's own answer.
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

const STATE = JSON.parse(fs.readFileSync(path.join(__dirname, ".state.json"), "utf8"));
const STUB = fs.readFileSync(path.join(__dirname, "..", "wallet-stub.js"), "utf8");

const APP = STATE.app;
const OWNER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const TRADER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const CHAIN = "0x2105";
const APP_ADDR_STORE = "curb.app.v1";
const keyOf = (rec) => "curb.launch.pending.v3:" + rec.chainId + ":" + rec.hash;
const fake = (byte) => "0x" + byte.repeat(32);
const hex = (n) => "0x" + BigInt(n).toString(16);
const pad = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

test.describe.configure({ mode: "serial" });

// ------------------------------------------------------------------ the node
/// One JSON-RPC call from the test's side - never through the page under test.
async function rpc(method, params) {
  const res = await fetch(STATE.rpc, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(method + ": " + body.error.message);
  return body.result;
}

/// Waits for a receipt and insists it succeeded.
async function mined(hash, what) {
  expect(hash, what + ": no hash").toMatch(/^0x[0-9a-f]{64}$/);
  let receipt = null;
  await expect.poll(async () => (receipt = await rpc("eth_getTransactionReceipt", [hash])) != null,
    { timeout: 20_000, message: what + ": no receipt" }).toBe(true);
  expect(receipt.status, what + ": reverted").toBe("0x1");
  return receipt;
}

/// A REAL TRANSACTION THAT MAKES NO LAUNCH, so its nonce is a used one whose
/// transaction created nothing - what a wallet's "cancel" leaves behind. The
/// node holds both accounts' keys.
async function selfTransfer(from) {
  const hash = await rpc("eth_sendTransaction", [{ from, to: from, value: "0x0" }]);
  const receipt = await mined(hash, "self-transfer from " + from);
  const tx = await rpc("eth_getTransactionByHash", [hash]);
  return { hash, nonce: tx.nonce, block: BigInt(receipt.blockNumber) };
}

// ------------------------------------------------------------------ the pages
let browserRef;
test.beforeAll(async ({ browser }) => { browserRef = browser; });

/// A FRESH CONTEXT PER PAGE: its own storage, so no record leaks between
/// tests, and records planted BEFORE the page's scripts run - once, guarded by
/// sessionStorage, so a reload does not put a cleared record back.
/// `rpc` is the endpoint the LINK names (the wallet always reads the node);
/// `store` is app.html's address book as an earlier visit saved it - an
/// endpoint saved there is one the person chose, and records may be settled
/// through it, which a link's alone may not (recordTransports).
async function openApp(account, { wallet = {}, plant = [], token = null, before = null, extra = "",
  rpc: linkRpc = STATE.rpc, store = null } = {}) {
  const p = await browserRef.newPage();
  p.on("pageerror", (e) => console.log("PAGE ERROR: " + e.message));
  const bootstrap = [
    STUB,
    ";(function () {",
    "  window.__CURB_RECHECK_MS = 200;",
    "  var cfg = " + JSON.stringify({ rpc: STATE.rpc, account, wallet, plant, store, key: APP_ADDR_STORE }) + ";",
    "  if (!sessionStorage.getItem('records.planted')) {",
    "    sessionStorage.setItem('records.planted', '1');",
    "    for (var i = 0; i < cfg.plant.length; i++) {",
    "      var t = cfg.plant[i];",
    "      localStorage.setItem('curb.launch.pending.v3:' + t.chainId + ':' + t.hash, JSON.stringify(t));",
    "    }",
    "    if (cfg.store) localStorage.setItem(cfg.key, JSON.stringify(cfg.store));",
    "  }",
    "  var opts = Object.assign({ forward: true, chainId: '" + CHAIN + "', account: cfg.account }, cfg.wallet);",
    "  window.ethereum = window.makeWallet(cfg.rpc, opts);",
    "})();",
    extra,
  ].join("\n");
  await p.addInitScript({ content: bootstrap });
  if (before) await before(p);
  const q = new URLSearchParams({ rpc: linkRpc, factory: APP.factory, lens: APP.lens });
  if (token) q.set("token", token);
  await p.goto("/app.html?" + q.toString());
  await p.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
  await expect(p.locator("#wallet")).toContainText(account, { ignoreCase: true, timeout: 20_000 });
  return p;
}

/// launch.html the way launch.spec.js opens it, with the recheck shortened.
/// `extra` runs after the wallet exists, before the page's own scripts.
async function openLaunch(page, { wallet = {}, pending = [], extra = "" } = {}) {
  const addrs = { lens: STATE.lens, token: STATE.token, rpc: STATE.rpc };
  const bootstrap = [
    STUB,
    ";(function () {",
    "  window.__CURB_RECHECK_MS = 200;",
    "  var cfg = " + JSON.stringify({ addrs, wallet, pending }) + ";",
    "  localStorage.setItem('curb.launch.addrs', JSON.stringify(cfg.addrs));",
    "  if (!sessionStorage.getItem('records.planted')) {",
    "    sessionStorage.setItem('records.planted', '1');",
    "    for (var i = 0; i < cfg.pending.length; i++) {",
    "      var tx = cfg.pending[i];",
    "      localStorage.setItem('curb.launch.pending.v3:' + tx.chainId + ':' + tx.hash, JSON.stringify(tx));",
    "    }",
    "  }",
    "  if (cfg.wallet) window.ethereum = window.makeWallet(cfg.addrs.rpc, cfg.wallet);",
    "})();",
    extra,
  ].join("\n");
  await page.addInitScript({ content: bootstrap });
  await page.goto("/launch.html");
  await page.waitForFunction(() => !!window.CurbLaunch, null, { timeout: 8_000 });
  return page;
}

const stored = (p, rec) => p.evaluate((k) => localStorage.getItem(k), keyOf(rec));

/// HANDS A READ ON TO THE NODE AND ITS ANSWER BACK. A read still in flight when
/// the page moves on (p.goto) has no one left to answer: its fetched reply is
/// disposed before it can be handed back, and that is not the page's failure.
async function forward(route) {
  try {
    return await route.fulfill({ response: await route.fetch({ url: STATE.rpc }) });
  } catch (e) {
    if (/has been disposed|has been closed|already handled/i.test(String(e && e.message))) return undefined;
    throw e;
  }
}

/// Rewrites the node's answer to ONE method (optionally for one hash) on the
/// page's side; everything else reaches the node untouched.
async function answer(p, handle) {
  await p.route("**/*", async (route) => {
    const req = route.request();
    const raw = req.postData() || "";
    if (req.method() !== "POST" || !raw) return route.continue();
    let m; try { m = JSON.parse(raw); } catch { return route.continue(); }
    const out = handle(m);
    if (out === undefined) return route.continue();
    return route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify(Object.assign({ jsonrpc: "2.0", id: m.id }, out)) });
  });
}

/// PRESS, AND READ WHAT HAPPENED FROM THE MESSAGE'S HISTORY. The message line
/// is rewritten by the resume that runs after every action, so the action's
/// own outcome - a refusal, or the failure after a send - is taken from a
/// MutationObserver, and what was sent from the wallet's own list.
///
/// A WRITE TO THE LINE, NOT A CHANGE INSIDE IT. The line can hold buttons (a
/// record's "Forget this record"), and an action disables every button on the
/// page while it runs: that attribute change inside the line was recorded as
/// a message, with whatever class the line already had - so an "err" or "ok"
/// line left by the load made the action look finished before it had done
/// anything. Only the line's own attributes (class, hidden) and its content
/// count.
async function attempt(p, act) {
  const before = await p.evaluate(() => {
    window.__hist = [];
    if (!window.__histObs) {
      const el = document.getElementById("msg");
      window.__histObs = new MutationObserver((records) => {
        if (!records.some((r) => r.type !== "attributes" || r.target === el)) return;
        window.__hist.push({ cls: el.className, text: el.textContent });
      });
      window.__histObs.observe(el, { childList: true, subtree: true, characterData: true, attributes: true });
    }
    return window.ethereum.sent.length;
  });
  await act();
  await expect.poll(() => p.evaluate(() => window.__hist.some((h) => h.cls === "err" || h.cls === "ok")),
    { timeout: 40_000, message: "the action never finished" }).toBe(true);
  return p.evaluate((n) => ({
    sent: window.ethereum.sent.length - n,
    text: window.__hist.filter((h) => h.cls === "err" || h.cls === "ok").map((h) => h.text).join(" | "),
  }), before);
}

const REFUSED = "already a transaction for this";

/// UNTIL THE PAGE HAS DRAWN THIS LAUNCH IN FULL, its quote included. An action
/// pressed before that is refused as built on another launch's numbers (round
/// 5, N05) - the status line is drawn first, so "Selling" on screen is not yet
/// "ready". A test that acts on a launch it has just opened waits for this.
const drawnFor = (p, token) => expect.poll(
  () => p.evaluate(() => ((window.CurbApp.state.viewFor || {}).token || "").toLowerCase()),
  { timeout: 30_000, message: "the launch was never drawn in full" }).toBe(token.toLowerCase());

async function tryTrade(p) {
  await p.selectOption("#curveSide", "buy");
  await p.fill("#curveAmount", "1");
  await p.evaluate(() => window.CurbApp.refresh(true));
  await expect(p.locator("#curveAct")).toBeEnabled({ timeout: 20_000 });
  return attempt(p, () => p.click("#curveAct"));
}
async function tryCreate(p) {
  await p.fill("#nName", "Record Probe");
  await p.fill("#nSymbol", "RPRB");
  return attempt(p, () => p.click("#create"));
}
async function tryClaim(p) {
  // THE BUTTON IS DISABLED WHILE NOTHING IS OWED, so its handler is called: the
  // question is whether the record check lets the claim reach the owed check,
  // whose "Nothing is owed" sits after it.
  return attempt(p, () => p.evaluate(() => { document.getElementById("claimEscrow").onclick(); }));
}

// ------------------------------------------------------------------ a real create
/// A launch created through the page, and its transaction as the NODE reports
/// it: hash, nonce, block. Shared by the tests that need a create that happened.
let created = null;
let launchTopic = null;

async function createdLaunch(p, name, symbol) {
  const before = await rpc("eth_blockNumber", []);
  // THE FORM'S TERMS READ FIRST: a create pressed before them is refused, rightly.
  await expect.poll(() => p.evaluate(() => !!(window.CurbApp.state.ctx && window.CurbApp.state.ctx.platformKnown)),
    { timeout: 30_000, message: "the form never read the factory's terms" }).toBe(true);
  await p.fill("#nName", name);
  await p.fill("#nSymbol", symbol);
  await p.click("#create");
  await expect(p.locator("#msg")).toContainText("Launched", { timeout: 40_000 });
  const token = await p.evaluate(() => window.CurbApp.state.chainCfg.token);
  expect(token).toMatch(/^0x[0-9a-fA-F]{40}$/);
  launchTopic = launchTopic || await p.evaluate(() =>
    window.CurbKeccak.keccak256("0x" + window.CurbAbi.utf8Hex("LaunchCreated(address,address,address,uint256,uint16)")));
  const logs = await rpc("eth_getLogs", [{ address: APP.factory, topics: [launchTopic, "0x" + pad(token)],
    fromBlock: before, toBlock: "latest" }]);
  expect(logs.length, "the node has no LaunchCreated for the new token").toBe(1);
  const hash = logs[0].transactionHash;
  const tx = await rpc("eth_getTransactionByHash", [hash]);
  return { token, hash, nonce: tx.nonce, block: BigInt(tx.blockNumber) };
}

async function ensureCreated() {
  if (created) return created;
  const p = await openApp(OWNER);
  try { created = await createdLaunch(p, "Records Base", "RECB"); } finally { await p.close(); }
  return created;
}

/// A create record as app.html writes one, for a hash of the caller's choosing.
const createRecord = (hash, fields) => Object.assign({
  page: "app", kind: "create", chainId: CHAIN, rpc: STATE.rpc, lens: APP.lens, token: "",
  factory: APP.factory, from: OWNER, to: APP.factory, hash, what: "create the launch PLANTED",
  sentNonce: null, sentAfterBlock: null,
}, fields);

// ============================================================ the nonce itself
test("the nonce recorded is the one the transaction carried, not a guess from the page's endpoint", async () => {
  // A LAGGING ENDPOINT, AS THE AUDIT DESCRIBED IT. Its transaction count is
  // wrong; the old code recorded exactly that count, before the wallet signed.
  const p = await openApp(OWNER, {
    extra: [
      ";(function () {",
      "  var real = Storage.prototype.setItem;",
      "  window.__pendingWrites = [];",
      "  Storage.prototype.setItem = function (k, v) {",
      "    if (String(k).indexOf('curb.launch.pending.v3:') === 0) { try { window.__pendingWrites.push(JSON.parse(v)); } catch (e) {} }",
      "    return real.call(this, k, v);",
      "  };",
      "})();",
    ].join("\n"),
    before: (pg) => answer(pg, (m) => (m.method === "eth_getTransactionCount" ? { result: "0x1" } : undefined)),
  });
  created = await createdLaunch(p, "Nonce Probe", "NONC");

  const writes = await p.evaluate(() => window.__pendingWrites.filter((w) => w.kind === "create"));
  expect(writes.length, "no create record was ever written").toBeGreaterThan(0);
  const last = writes[writes.length - 1];
  expect(last.hash).toBe(created.hash);
  expect(last.sentNonce, "the record holds a nonce other than the one the transaction carries").toBe(created.nonce);
  expect(created.nonce, "the deployer's nonce happens to equal the lagging answer; the test proves nothing")
    .not.toBe("0x1");
  // AND THE SEARCH FLOOR IS BELOW THE BLOCK IT MINED IN.
  expect(BigInt(last.sentAfterBlock) < created.block, "sentAfterBlock is not below the create's block").toBe(true);
  await p.close();
});

// ============================================================ app.html's creates
test("a create the wallet sped up is adopted: the replacement from the same sender and nonce made the launch", async () => {
  const c = await ensureCreated();
  // THE RECORDED HASH NEVER MINED - the node has never seen it - and the
  // transaction that carried its nonce is the create that did.
  const rec = createRecord(fake("5e"), { sentNonce: c.nonce, sentAfterBlock: hex(c.block - 1n) });
  const p = await openApp(OWNER, { plant: [rec] });

  await expect(p.locator("#msg")).toContainText("through a replacement", { timeout: 30_000 });
  await expect(p.locator("#msg")).toContainText(c.token, { ignoreCase: true });
  await expect(p.locator("#msg")).not.toContainText("replaced or dropped");
  expect((await p.evaluate(() => window.CurbApp.state.chainCfg.token)).toLowerCase(),
    "the launch the replacement made was not adopted").toBe(c.token.toLowerCase());
  expect(await stored(p, rec), "the record outlived its adoption").toBeNull();
  await p.close();
});

test("a create whose nonce went to a transaction that made no launch is cleared as replaced or dropped", async () => {
  // THE SEARCH RANGE HOLDS A CREATE FROM THIS SAME SENDER - the one made
  // earlier - at ANOTHER nonce. Only the transaction that took THIS nonce is a
  // replacement; adopting any launch the account made since would put the
  // wrong token in the form.
  const c = await ensureCreated();
  const cancel = await selfTransfer(OWNER);
  const rec = createRecord(fake("d0"), { sentNonce: cancel.nonce, sentAfterBlock: hex(c.block - 1n) });
  const p = await openApp(OWNER, { plant: [rec] });

  await expect(p.locator("#msg")).toContainText("replaced or dropped", { timeout: 30_000 });
  await expect(p.locator("#msg")).toContainText("no launch was created by it");
  expect(await stored(p, rec), "a truly dropped create was kept").toBeNull();
  expect(await p.evaluate(() => window.CurbApp.state.chainCfg.token), "something was adopted").toBe("");
  await p.close();
});

test("a launch ANOTHER account created at the record's nonce is not taken for its replacement", async () => {
  // THE SENDER HALF OF THE MATCH. The test above holds the nonce half: the
  // same sender at another nonce. Nonces are per account and small on fresh
  // wallets, so a stranger's create at the same number, inside the searched
  // range, is ordinary on a busy factory - and every log the other tests
  // searched was the record's own sender's, so dropping the sender check left
  // them green while a stranger's token was put in the form (round 5, N09).
  const pt = await openApp(TRADER);
  let theirs;
  try { theirs = await createdLaunch(pt, "Stranger Launch", "STRG"); } finally { await pt.close(); }
  // THE RECORD'S NONCE MUST READ AS USED, so the search runs at all: OWNER's
  // count is taken past the stranger's nonce with transactions that make no
  // launch.
  const ownerCount = async () => BigInt(await rpc("eth_getTransactionCount", [OWNER, "latest"]));
  for (let i = 0; i < 64 && (await ownerCount()) <= BigInt(theirs.nonce); i++) await selfTransfer(OWNER);
  expect((await ownerCount()) > BigInt(theirs.nonce), "OWNER's nonce never passed the stranger's; the search would not run")
    .toBe(true);

  // AN OWNER CREATE THAT NEVER MINED, carrying the stranger's nonce, searched
  // from the block before the stranger's launch.
  const rec = createRecord(fake("5f"), { sentNonce: theirs.nonce, sentAfterBlock: hex(theirs.block - 1n) });
  const p = await openApp(OWNER, { plant: [rec] });

  await expect(p.locator("#msg")).toContainText("no launch was created by it", { timeout: 30_000 });
  await expect(p.locator("#msg")).not.toContainText("through a replacement");
  await expect(p.locator("#msg")).not.toContainText(theirs.token, { ignoreCase: true });
  expect(await p.evaluate(() => window.CurbApp.state.chainCfg.token), "a stranger's launch was adopted").toBe("");
  expect(await stored(p, rec)).toBeNull();
  await p.close();
});

test("a replaced create whose replacement cannot be searched for is kept, and says a launch may exist", async () => {
  const cancel = await selfTransfer(OWNER);
  const rec = createRecord(fake("d1"), { sentNonce: cancel.nonce, sentAfterBlock: hex(cancel.block - 1n) });
  const p = await openApp(OWNER, {
    plant: [rec],
    before: (pg) => answer(pg, (m) => (m.method === "eth_getLogs"
      ? { error: { code: -32005, message: "query returned more than 10000 results" } } : undefined)),
  });

  await expect(p.locator("#msg")).toContainText("A LAUNCH MAY EXIST", { timeout: 30_000 });
  await expect(p.locator("#msg button[data-forget]"), "an unsearchable create offers no way out").toBeVisible();
  expect(await stored(p, rec), "a create that may have made a launch was cleared").not.toBeNull();
  await p.close();
});

test("a create the node still has pending is not cleared, although the account's nonce has moved past it", async () => {
  // THE S04 CASE: the recorded nonce sits below the account's count - the old
  // code's guess did exactly this - while the transaction is still waiting.
  const used = await selfTransfer(OWNER);
  const hash = fake("9a");
  const rec = createRecord(hash, { sentNonce: used.nonce, sentAfterBlock: hex(used.block - 1n) });
  const p = await openApp(OWNER, {
    plant: [rec],
    before: (pg) => answer(pg, (m) => (m.method === "eth_getTransactionByHash" && m.params[0] === hash
      ? { result: { hash, from: OWNER, nonce: used.nonce, blockNumber: null, blockHash: null, transactionIndex: null,
          to: APP.factory, value: "0x0", input: "0x", gas: "0x5208", gasPrice: "0x1" } }
      : undefined)),
  });

  await expect(p.locator("#msg")).toContainText("still has it, waiting to be mined", { timeout: 30_000 });
  await expect(p.locator("#msg")).not.toContainText("replaced or dropped");
  expect(await stored(p, rec), "a create still pending was cleared").not.toBeNull();
  await p.close();
});

test("a create whose nonce has not been used yet is kept, and offers no forget button", async () => {
  const count = await rpc("eth_getTransactionCount", [OWNER, "latest"]);
  const head = await rpc("eth_blockNumber", []);
  const rec = createRecord(fake("9b"), { sentNonce: count, sentAfterBlock: head });
  const p = await openApp(OWNER, { plant: [rec] });

  await expect(p.locator("#msg")).toContainText("has not been used by anything else", { timeout: 30_000 });
  // WHAT CLEARS IT WHEN THE WALLET NO LONGER SHOWS IT: "cancel it there" was
  // impossible then; any transaction at that nonce is not (round 5, N54).
  await expect(p.locator("#msg")).toContainText("zero-value send to yourself");
  await expect(p.locator("#msg")).toContainText("at nonce " + parseInt(count, 16));
  expect(await stored(p, rec), "a create whose nonce is unused was cleared").not.toBeNull();
  // THE CHAIN WILL STILL SETTLE THIS ONE - it mines, or a cancel uses the nonce -
  // so ending it by hand is not offered while it is young. The record carries
  // no age, so its hour starts now (TX.stampJudged).
  await expect(p.locator("#msg button[data-forget]")).toHaveCount(0);
  await p.close();
});

test("a create whose nonce stays unused and whose hash no node knows an hour on can be forgotten, on confirm", async () => {
  // THE SAME RECORD AS ABOVE, SENT TWO HOURS AGO: what a transaction the
  // mempool dropped looks like. It used to be "pending" for good, with no
  // Forget and advice nobody could follow (round 5, N54).
  const count = await rpc("eth_getTransactionCount", [OWNER, "latest"]);
  const head = await rpc("eth_blockNumber", []);
  const rec = createRecord(fake("9d"), { sentNonce: count, sentAfterBlock: head, sentAt: Date.now() - 2 * 3600 * 1000 });
  const p = await openApp(OWNER, { plant: [rec] });

  await expect(p.locator("#msg")).toContainText("most likely dropped", { timeout: 30_000 });
  await expect(p.locator("#msg")).toContainText("zero-value send to yourself");
  const button = p.locator("#msg button[data-forget]");
  await expect(button).toBeVisible();
  // THE CONFIRM SAYS WHAT FORGETTING ALLOWS, and how to make sure it never lands.
  let question = "";
  p.once("dialog", (d) => { question = d.message(); d.dismiss(); });
  await button.click();
  await expect.poll(() => question, { timeout: 20_000, message: "the page never asked before forgetting" })
    .toContain("stop refusing a second send");
  expect(question).toContain("at nonce " + parseInt(count, 16));
  await p.waitForTimeout(500);
  expect(await stored(p, rec), "a record was forgotten although the person declined").not.toBeNull();
  await p.close();
});

test("a create mined between the first receipt read and the nonce read is adopted, not called replaced", async () => {
  const c = await ensureCreated();
  const rec = createRecord(c.hash, { sentNonce: c.nonce, sentAfterBlock: hex(c.block - 1n) });
  // THE FIRST RECEIPT READ says "not yet"; every later one is the node's. That
  // is the window between two reads a transaction can be mined in.
  let first = true;
  const p = await openApp(OWNER, {
    plant: [rec],
    before: (pg) => answer(pg, (m) => {
      if (m.method === "eth_getTransactionReceipt" && m.params[0] === c.hash && first) {
        first = false;
        return { result: null };
      }
      return undefined;
    }),
  });

  await expect(p.locator("#msg")).toContainText("created in a previous visit", { timeout: 30_000 });
  await expect(p.locator("#msg")).not.toContainText("replaced or dropped");
  expect(first, "the page never read the receipt, so the race was not exercised").toBe(false);
  expect((await p.evaluate(() => window.CurbApp.state.chainCfg.token)).toLowerCase()).toBe(c.token.toLowerCase());
  expect(await stored(p, rec)).toBeNull();
  await p.close();
});

test("a create whose receipt a lagging endpoint missed twice is still found by its log, and adopted as itself", async () => {
  // A LOAD-BALANCED ENDPOINT: the backend asked for the receipt, both times,
  // is behind the one that counted the nonce, and knows nothing of the hash.
  // The nonce says "used", so the verdict is "replaced" - and the create must
  // still not be cleared: its own LaunchCreated log is in the searched range.
  const c = await ensureCreated();
  const rec = createRecord(c.hash, { sentNonce: c.nonce, sentAfterBlock: hex(c.block - 1n) });
  let receiptReads = 0;
  let hashReads = 0;
  const p = await openApp(OWNER, {
    plant: [rec],
    before: (pg) => answer(pg, (m) => {
      if (m.method === "eth_getTransactionReceipt" && m.params[0] === c.hash && ++receiptReads <= 2) return { result: null };
      if (m.method === "eth_getTransactionByHash" && m.params[0] === c.hash && ++hashReads <= 1) return { result: null };
      return undefined;
    }),
  });

  await expect(p.locator("#msg")).toContainText("created in a previous visit", { timeout: 30_000 });
  await expect(p.locator("#msg")).not.toContainText("through a replacement");
  await expect(p.locator("#msg")).not.toContainText("replaced or dropped");
  expect(receiptReads, "the lagging reads were never made, so the path was not exercised").toBeGreaterThanOrEqual(3);
  expect((await p.evaluate(() => window.CurbApp.state.chainCfg.token)).toLowerCase()).toBe(c.token.toLowerCase());
  expect(await stored(p, rec)).toBeNull();
  await p.close();
});

test("a record nothing on chain can settle is forgotten only when the person confirms", async () => {
  // NO NONCE AND A HASH THE NODE HAS NEVER SEEN - a record from before nonces
  // were read back, whose transaction went nowhere.
  const rec = createRecord(fake("f0"), {});
  const p = await openApp(OWNER, { plant: [rec] });
  const button = p.locator("#msg button[data-forget]");
  await expect(button).toBeVisible({ timeout: 30_000 });

  // THE QUESTION HAS TO BE ASKED for "declined" to mean anything: a click the
  // page ignored (busy, or the listener gone) would leave the record too.
  let asked = 0;
  p.once("dialog", (d) => { asked++; d.dismiss(); });
  await button.click();
  await expect.poll(() => asked, { timeout: 20_000, message: "the page never asked before forgetting" }).toBe(1);
  await p.waitForTimeout(500);
  expect(await stored(p, rec), "a record was forgotten although the person declined").not.toBeNull();

  await expect(button).toBeVisible({ timeout: 10_000 });
  p.once("dialog", (d) => { asked++; d.accept(); });
  await button.click();
  await expect(p.locator("#msg")).toContainText("is forgotten", { timeout: 20_000 });
  expect(asked).toBe(2);
  expect(await stored(p, rec)).toBeNull();
  await p.close();
});

test("a nonce read from a transaction another address sent is not recorded as this record's", async () => {
  // A SMART WALLET'S BUNDLER sends the user's operation from its own account at
  // its own nonce. Compared with the SENDER's count, that number would later
  // read as "replaced" and clear a record whose operation may still land.
  const hash = fake("9c");
  const rec = createRecord(hash, {});
  const p = await openApp(OWNER, {
    plant: [rec],
    // Page-side, so the wallet stub's forwarded read gets the same answer.
    before: (pg) => answer(pg, (m) => (m.method === "eth_getTransactionByHash" && m.params[0] === hash
      ? { result: { hash, from: TRADER, nonce: "0x0", blockNumber: null, blockHash: null, transactionIndex: null,
          to: APP.factory, value: "0x0", input: "0x", gas: "0x5208", gasPrice: "0x1" } }
      : undefined)),
  });

  await expect(p.locator("#msg")).toContainText("still has it, waiting to be mined", { timeout: 30_000 });
  const kept = JSON.parse(await stored(p, rec));
  expect(kept, "the record is gone").not.toBeNull();
  expect(kept.sentNonce, "another address's nonce was recorded as the sender's").toBeNull();
  await p.close();
});

// ============================================================ launch.html's records on app.html
/// A graduation record as launch.html writes one.
const launchRecord = (hash, token, fields) => Object.assign({
  chainId: CHAIN, lens: APP.lens, token, graduator: APP.graduator, account: TRADER, hash,
  uncertainChain: false, sentNonce: null,
}, fields);

/// A trader's page that sends nothing real: the stub answers the send with a
/// fake hash and a reverted receipt, so "it was sent" is the wallet's list.
/// THE ENDPOINT IS ONE THE PERSON SAVED. That stub answers EVERY receipt with
/// that revert, so a record settled through it would read as reverted; app.html
/// asks a chosen endpoint before the wallet, and a link's endpoint never
/// (recordTransports), so the node's own answers settle launch.html's records.
const dryTrader = (token, plant) => openApp(TRADER, { token, plant, store: { rpc: STATE.rpc },
  wallet: { forward: false, receipt: { status: "0x0" } } });

test("launch.html's graduation record for this launch is settled by app.html, and then blocks nothing", async () => {
  const c = await ensureCreated();
  // A HASH THAT DID MINE, as a graduation whose tab closed before its receipt.
  const done = await selfTransfer(TRADER);
  const rec = launchRecord(done.hash, c.token);
  const p = await dryTrader(c.token, [rec]);
  await expect(p.locator("#status")).toHaveText("Selling", { timeout: 20_000 });

  await expect(p.locator("#msg")).toContainText("sent from launch.html", { timeout: 30_000 });
  await expect(p.locator("#msg")).toContainText("succeeded");
  expect(await stored(p, rec), "app.html left launch.html's settled record in place").toBeNull();

  const r = await tryTrade(p);
  expect(r.text).not.toContain(REFUSED);
  expect(r.sent, "the trade was refused on a record that had already settled").toBe(1);
  await p.close();
});

test("launch.html's unsettled graduation blocks this account's trade, and not another account's", async () => {
  const c = await ensureCreated();
  const mine = launchRecord(fake("7a"), c.token, { account: TRADER });
  const p = await dryTrader(c.token, [mine]);
  await expect(p.locator("#status")).toHaveText("Selling", { timeout: 20_000 });
  const r = await tryTrade(p);
  expect(r.text).toContain(REFUSED);
  expect(r.text).toContain("sent from launch.html");
  expect(r.sent, "a trade went out beside a graduation still unaccounted for").toBe(0);
  expect(await stored(p, mine)).not.toBeNull();
  await p.close();

  // SOMEBODY ELSE'S graduation is not this account paying twice.
  const theirs = launchRecord(fake("7b"), c.token, { account: OWNER });
  const q = await dryTrader(c.token, [theirs]);
  await expect(q.locator("#status")).toHaveText("Selling", { timeout: 20_000 });
  const s = await tryTrade(q);
  expect(s.text).not.toContain(REFUSED);
  expect(s.sent, "another account's graduation refused this account's trade").toBe(1);
  await q.close();
});

test("launch.html's graduation signed across a network switch is kept by app.html, although its nonce is used", async () => {
  // The nonce was read back from the wallet on whatever chain it had moved to,
  // so this chain's count moving past it says nothing. launch.html keeps such a
  // record; app.html, settling it too now, must not clear it as replaced.
  const c = await ensureCreated();
  const used = await selfTransfer(TRADER);
  const rec = launchRecord(fake("7c"), c.token, { uncertainChain: true, sentNonce: used.nonce });
  const p = await dryTrader(c.token, [rec]);
  await expect(p.locator("#msg")).toContainText("changed networks", { timeout: 30_000 });
  await expect(p.locator("#msg")).not.toContainText("replaced or dropped");
  expect(await stored(p, rec), "an uncertain-chain graduation was cleared on this chain's nonce").not.toBeNull();
  await expect(p.locator("#msg button[data-forget]")).toBeVisible();
  await p.close();
});

test("launch.html's graduation signed across a network switch, its nonce unused here, can be forgotten on app.html", async () => {
  // THE OTHER HALF OF THE SAME CASE. The nonce may be another chain's, where
  // the account had sent more: at or above this chain's count it read as
  // "pending, not used yet" - no Forget, every trade on the launch refused,
  // and advice to cancel something no wallet here held (round 5, P-R22, S16).
  const c = await ensureCreated();
  const count = await rpc("eth_getTransactionCount", [TRADER, "latest"]);
  const rec = launchRecord(fake("7e"), c.token, { uncertainChain: true, sentNonce: count });
  const p = await dryTrader(c.token, [rec]);
  await expect(p.locator("#msg")).toContainText("changed networks", { timeout: 30_000 });
  await expect(p.locator("#msg")).not.toContainText("has not been used by anything else");
  await expect(p.locator("#msg button[data-forget]")).toBeVisible();
  expect(await stored(p, rec), "the record went without being asked").not.toBeNull();
  await p.close();
});

test("a refused trade's advice holds: Refresh then says why, and offers to forget the record that refused it", async () => {
  // THE REFUSAL SAYS "press Refresh". Refresh writes nothing to the message
  // line, so the refusal was still on screen when its resume ran - and a
  // refusal on screen kept that resume quiet: the line and its Forget button
  // never came, and pressing the button again only repeated the refusal
  // (round 5, S16).
  const c = await ensureCreated();
  const count = await rpc("eth_getTransactionCount", [TRADER, "latest"]);
  const rec = launchRecord(fake("6f"), c.token, { uncertainChain: true, sentNonce: count });
  const p = await dryTrader(c.token, [rec]);
  // THE CONTROL: the line and its button are what this locator finds on load.
  await expect(p.locator("#msg button[data-forget]")).toBeVisible({ timeout: 30_000 });

  const r = await tryTrade(p);
  expect(r.text).toContain(REFUSED);
  expect(r.text).toContain("press Refresh");
  expect(r.sent, "a trade went out beside a graduation still unaccounted for").toBe(0);
  // THE REFUSAL STAYS after its own action: that resume says nothing.
  await expect(p.locator("#msg")).toContainText(REFUSED);
  await expect(p.locator("#msg button[data-forget]")).toHaveCount(0);

  await p.click("#refresh");
  await expect(p.locator("#msg button[data-forget]"), "Refresh did not bring back the line the refusal pointed to")
    .toBeVisible({ timeout: 30_000 });
  await expect(p.locator("#msg")).toContainText("changed networks");
  expect(await stored(p, rec), "the record went without being asked").not.toBeNull();
  await p.close();
});

test("a link's endpoint is never asked to settle launch.html's record: a receipt it makes up clears nothing", async () => {
  // A LINK CAN NAME ANY ENDPOINT, and this page settled launch.html's records
  // through the one in the form - on load, with no click. One that answers a
  // receipt for a hash the chain never mined deleted the record that stops a
  // trade beside a graduation still unaccounted for (round 5, N50). Here the
  // link's endpoint forwards everything to the node except that one receipt,
  // which it makes up.
  const c = await ensureCreated();
  const hostile = new URL(STATE.rpc);
  hostile.searchParams.set("hostile", "1");
  const HOSTILE = hostile.toString();
  const rec = launchRecord(fake("7d"), c.token, { account: TRADER });
  const p = await openApp(TRADER, { token: c.token, plant: [rec], rpc: HOSTILE,
    before: (pg) => pg.route((u) => u.searchParams.get("hostile") === "1", async (route) => {
      let m = null;
      try { m = JSON.parse(route.request().postData() || ""); } catch { m = null; }
      if (m && m.method === "eth_getTransactionReceipt" && m.params && m.params[0] === rec.hash) {
        return route.fulfill({ status: 200, contentType: "application/json",
          headers: { "access-control-allow-origin": "*" },
          body: JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {
            transactionHash: rec.hash, status: "0x1", logs: [], blockNumber: "0x1", from: TRADER } }) });
      }
      return forward(route);
    }) });

  // THE LIE IS REALLY THERE: asked directly, the link's endpoint says it mined.
  const lie = await p.evaluate(async ({ url, hash }) => {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "eth_getTransactionReceipt", params: [hash] }) });
    return (await r.json()).result;
  }, { url: HOSTILE, hash: rec.hash });
  expect(lie && lie.status, "the link's endpoint does not make the receipt up; the test proves nothing").toBe("0x1");

  // SETTLED THROUGH THE WALLET, on the record's chain: the node has never seen it.
  await expect(p.locator("#msg")).toContainText(rec.hash, { timeout: 30_000 });
  await expect(p.locator("#msg")).not.toContainText("succeeded");
  expect(await stored(p, rec), "a receipt a link's endpoint made up cleared the record").not.toBeNull();
  await p.close();
});

test("a link's endpoint that a save on its visit kept is still never asked to settle launch.html's record later", async () => {
  // ANY FIELD CHANGE OR PICK USED TO SAVE THE WHOLE FORM, the link's endpoint
  // with it, and on the next visit a saved endpoint counted as one the person
  // chose: the lie of the test above cleared the record a visit later, with no
  // link at all (round 5, N50). Two halves now. A save on the link's visit
  // keeps the link's endpoint out of storage altogether (round 5, N13/N14). And
  // an endpoint an EARLIER version did save that way - marked rpcFromLink - is
  // still never asked: the same made-up receipt, one visit on.
  const c = await ensureCreated();
  const hostile = new URL(STATE.rpc);
  hostile.searchParams.set("hostile", "1");
  const HOSTILE = hostile.toString();
  const rec = launchRecord(fake("6d"), c.token, { account: TRADER });
  const p = await openApp(TRADER, { token: c.token, plant: [rec], rpc: HOSTILE,
    before: (pg) => pg.route((u) => u.searchParams.get("hostile") === "1", async (route) => {
      let m = null;
      try { m = JSON.parse(route.request().postData() || ""); } catch { m = null; }
      if (m && m.method === "eth_getTransactionReceipt" && m.params && m.params[0] === rec.hash) {
        return route.fulfill({ status: 200, contentType: "application/json",
          headers: { "access-control-allow-origin": "*" },
          body: JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {
            transactionHash: rec.hash, status: "0x1", logs: [], blockNumber: "0x1", from: TRADER } }) });
      }
      return forward(route);
    }) });
  await expect(p.locator("#msg")).toContainText(rec.hash, { timeout: 30_000 });

  // A SAVE ON THE LINK'S VISIT: it happened (the token is there), and the
  // link's endpoint is not in it.
  await p.dispatchEvent("#token", "change");
  const saved = await p.evaluate((k) => JSON.parse(localStorage.getItem(k) || "{}"), APP_ADDR_STORE);
  expect((saved.token || "").toLowerCase(), "nothing was saved, so the next check proves nothing")
    .toBe(c.token.toLowerCase());
  expect(saved.rpc, "a save on the link's visit kept the link's endpoint").not.toBe(HOSTILE);

  // AS AN EARLIER VERSION SAVED IT: the link's endpoint, marked as the link's.
  await p.evaluate(({ k, rpc, factory, lens, token }) => localStorage.setItem(k, JSON.stringify(
    { rpc, factory, lens, token, chosen: false, rpcFromLink: true })),
  { k: APP_ADDR_STORE, rpc: HOSTILE, factory: APP.factory, lens: APP.lens, token: c.token });

  // THE NEXT VISIT NAMES NO ENDPOINT: the saved one fills the field.
  const q = new URLSearchParams({ factory: APP.factory, lens: APP.lens, token: c.token });
  await p.goto("/app.html?" + q.toString());
  await p.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
  await expect.poll(() => p.evaluate(() => window.CurbApp.state.chainCfg.rpc), { timeout: 10_000,
    message: "the saved endpoint is not the one in the form; the test proves nothing" }).toBe(HOSTILE);
  // THE LIE IS STILL THERE on this visit.
  const lie = await p.evaluate(async ({ url, hash }) => {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "eth_getTransactionReceipt", params: [hash] }) });
    return (await r.json()).result;
  }, { url: HOSTILE, hash: rec.hash });
  expect(lie && lie.status, "the saved endpoint does not make the receipt up; the test proves nothing").toBe("0x1");

  await expect(p.locator("#msg")).toContainText(rec.hash, { timeout: 30_000 });
  await expect(p.locator("#msg")).not.toContainText("succeeded");
  expect(await stored(p, rec), "a receipt a link's saved endpoint made up cleared the record").not.toBeNull();

  // AND A SAVE ON THIS VISIT KEEPS THE MARK. The endpoint is still only the
  // link's; a record written now that forgot so would make the NEXT visit
  // trust it (saveCfg, rpcFromLink).
  await p.dispatchEvent("#token", "change");
  const resaved = await p.evaluate((k) => JSON.parse(localStorage.getItem(k) || "{}"), APP_ADDR_STORE);
  expect(resaved.rpc, "the save dropped the endpoint, so the mark is not what this checks").toBe(HOSTILE);
  expect(resaved.rpcFromLink, "a save forgot that the saved endpoint was only a link's").toBe(true);
  await p.close();
});

// ============================================================ settling every record, and where
test("every record is judged on load, not only those sorted before the first that settled", async () => {
  // A CREATE SORTS FIRST, and the loop used to return at the first record it
  // settled - so a record behind an adopted create was never looked at, and a
  // claim naming another launch went on refusing claims (round 5, N02).
  const c = await ensureCreated();
  const create = createRecord(c.hash, { sentNonce: c.nonce, sentAfterBlock: hex(c.block - 1n) });
  const done = await selfTransfer(OWNER);
  const claim = createRecord(done.hash, { kind: "claim", factory: "0x" + "c9".repeat(20), what: "claim your curve fees" });
  const p = await openApp(OWNER, { plant: [create, claim] });

  await expect(p.locator("#msg")).toContainText("created in a previous visit", { timeout: 30_000 });
  await expect(p.locator("#msg"), "the record sorted behind the adopted create was never judged")
    .toContainText("claim your curve fees", { timeout: 30_000 });
  expect(await stored(p, create)).toBeNull();
  expect(await stored(p, claim)).toBeNull();
  await p.close();
});

test("a mined create the form cannot adopt is said once per load, never over an action's result, and refuses no create", async () => {
  // SENT THROUGH AN ENDPOINT THAT IS GONE. The link's endpoint is not one to
  // settle it through, and the wallet - on the record's chain - reads its
  // receipt, which names the launch; the form is not at that endpoint, so the
  // launch cannot be put in it. It used to be announced after every action
  // and every load, over the action's own report, and it went on refusing a
  // create although the chain had said what it made (round 5, N02).
  const c = await ensureCreated();
  const made = createRecord(c.hash, { rpc: "http://127.0.0.1:1", sentNonce: c.nonce, sentAfterBlock: hex(c.block - 1n) });
  // A RECORD THE CHAIN CANNOT SETTLE, whose line any resume that speaks writes.
  const other = createRecord(fake("d8"), { kind: "action", lens: APP.lens, token: "0x" + "d7".repeat(20),
    what: "buy on the curve" });
  const p = await openApp(OWNER, { plant: [made, other] });

  await expect(p.locator("#msg")).toContainText("created in a previous visit", { timeout: 30_000 });
  await expect(p.locator("#msg")).toContainText(c.token, { ignoreCase: true });
  await expect(p.locator("#msg")).toContainText("still unaccounted for");
  const kept = JSON.parse(await stored(p, made));
  expect(kept, "a create whose address the form never took was cleared").not.toBeNull();
  expect((kept.made || "").toLowerCase(), "the launch its receipt names was not written on the record")
    .toBe(c.token.toLowerCase());

  // AN ACTION THAT SUCCEEDS - a create, which the mined one no longer refuses.
  // The resume after it judges both records again and must say nothing.
  const judged = p.waitForRequest((r) => {
    const body = r.postData() || "";
    return body.includes('"eth_getTransactionReceipt"') && body.includes(other.hash);
  }, { timeout: 60_000 });
  // THE RESUME AFTER THE CREATE HAS FINISHED, counted, not guessed at. Waiting
  // "a second" after the other record's receipt was asked passed with a resume
  // that DID speak: the mined create's dead endpoint kept it asking past that
  // second, and it wrote over the result only after the checks had run.
  const runsBefore = await p.evaluate(() => window.CurbApp.state.resumeRuns);
  const create = await tryCreate(p);
  expect(create.text, "a create the chain has settled still refused a create").not.toContain(REFUSED);
  expect(create.sent).toBeGreaterThan(0);
  await expect(p.locator("#msg")).toContainText("Launched", { timeout: 40_000 });
  await judged;
  await expect.poll(() => p.evaluate(() => window.CurbApp.state.resumeRuns), {
    timeout: 60_000, message: "the resume after the create never finished" }).toBeGreaterThan(runsBefore);
  await expect(p.locator("#msg"), "the resume after an action wrote over its result").toContainText("Launched");
  await expect(p.locator("#msg")).not.toContainText("created in a previous visit");
  await expect(p.locator("#msg")).not.toContainText("still unaccounted for");

  // REFRESH SPEAKS - the other record's line comes back - but the mined create
  // was said once on this load, and is not said again.
  await p.click("#refresh");
  await expect(p.locator("#msg")).toContainText("still unaccounted for", { timeout: 30_000 });
  await expect(p.locator("#msg"), "the mined create was said again on the same load").not.toContainText("created in a previous visit");
  await p.close();
});

test("a record whose own endpoint is gone is settled through the wallet on its chain", async () => {
  // IT USED TO BE ASKED NOWHERE ELSE: "could not be checked" on every load,
  // refusing every trade of its launch on every endpoint (round 5, N04).
  const c = await ensureCreated();
  const done = await selfTransfer(TRADER);
  const rec = createRecord(done.hash, { kind: "action", from: TRADER, lens: APP.lens, token: c.token,
    rpc: "http://127.0.0.1:1", what: "buy on the curve" });
  const p = await openApp(TRADER, { plant: [rec], token: c.token });
  await expect(p.locator("#msg")).toContainText("buy on the curve", { timeout: 30_000 });
  await expect(p.locator("#msg")).toContainText("succeeded");
  expect(await stored(p, rec)).toBeNull();
  await p.close();
});

test("a record whose own endpoint names its chain and then refuses every read is settled through the wallet", async () => {
  // NOT GONE, WORSE: it answers eth_chainId and sends every other question
  // back as a JSON-RPC error - a rate limit, or a revoked key - so it passed
  // for the record's endpoint, the judgement failed there, and the record was
  // "unreadable" on every load beside a wallet holding its receipt (round 5,
  // N04).
  const c = await ensureCreated();
  const done = await selfTransfer(TRADER);
  const flaky = new URL(STATE.rpc);
  flaky.searchParams.set("flaky", "1");
  const FLAKY = flaky.toString();
  const rec = createRecord(done.hash, { kind: "action", from: TRADER, lens: APP.lens, token: c.token,
    rpc: FLAKY, what: "buy on the curve" });
  const p = await openApp(TRADER, { plant: [rec], token: c.token,
    before: (pg) => pg.route((u) => u.searchParams.get("flaky") === "1", async (route) => {
      let m = null;
      try { m = JSON.parse(route.request().postData() || ""); } catch { m = null; }
      if (m && m.method && m.method !== "eth_chainId") {
        return route.fulfill({ status: 200, contentType: "application/json",
          headers: { "access-control-allow-origin": "*" },
          body: JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32005, message: "over rate limit" } }) });
      }
      return forward(route);
    }) });

  // THE ENDPOINT REALLY DOES BOTH: it names the record's chain, and refuses the receipt.
  const probe = await p.evaluate(async ({ url, hash }) => {
    const ask = async (method, params) => (await (await fetch(url, { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }) })).json());
    return { chain: (await ask("eth_chainId", [])).result, receipt: (await ask("eth_getTransactionReceipt", [hash])).error };
  }, { url: FLAKY, hash: rec.hash });
  expect(probe.chain, "the endpoint does not name the record's chain; the test proves nothing").toBe(CHAIN);
  expect((probe.receipt || {}).message, "the endpoint answers the receipt; the test proves nothing")
    .toContain("rate limit");

  await expect(p.locator("#msg")).toContainText("buy on the curve", { timeout: 30_000 });
  await expect(p.locator("#msg")).toContainText("succeeded");
  expect(await stored(p, rec), "a record was kept unreadable beside a wallet holding its receipt").toBeNull();
  await p.close();
});

test("with the wallet elsewhere, a dead endpoint's record waits for an endpoint the person types, not the link's", async () => {
  const c = await ensureCreated();
  const done = await selfTransfer(TRADER);
  const rec = createRecord(done.hash, { kind: "action", from: TRADER, lens: APP.lens, token: c.token,
    rpc: "http://127.0.0.1:1", what: "buy on the curve" });
  const p = await openApp(TRADER, { plant: [rec], token: c.token, wallet: { chainId: "0x1" } });
  // THE LINK'S ENDPOINT serves the record's chain and holds its receipt, and
  // is not asked: nothing this page may ask serves chain 8453.
  await expect(p.locator("#msg")).toContainText("cannot be checked from here", { timeout: 30_000 });
  expect(await stored(p, rec)).not.toBeNull();

  // TYPED, the same endpoint is the person's choice.
  await p.fill("#rpc", STATE.rpc);
  await p.dispatchEvent("#rpc", "change");
  await p.click("#refresh");
  await expect(p.locator("#msg")).toContainText("succeeded", { timeout: 30_000 });
  expect(await stored(p, rec)).toBeNull();
  await p.close();
});

test("a record no endpoint can read is offered for forgetting only past the hour", async () => {
  // SENT ON A CHAIN NOTHING HERE SERVES: "elsewhere" had no Forget at all, so
  // such a record was permanent. Young, it is kept; two hours old, it may go.
  const young = createRecord(fake("e1"), { chainId: "0x1", kind: "action", what: "buy on the curve" });
  const old = createRecord(fake("e2"), { chainId: "0x1", kind: "action", what: "buy on the curve",
    sentAt: Date.now() - 2 * 3600 * 1000 });
  const p = await openApp(OWNER, { plant: [young, old] });
  await expect(p.locator("#msg")).toContainText(young.hash, { timeout: 30_000 });
  await expect(p.locator("#msg")).toContainText(old.hash);
  const buttons = p.locator("#msg button[data-forget]");
  await expect(buttons).toHaveCount(1);
  expect(await buttons.getAttribute("data-forget")).toBe("0x1:" + old.hash);
  await p.close();
});

test("a send whose wallet switched networks in the dialog is marked uncertain, and keeps no nonce read on the other chain", async () => {
  // app.html's send never watched the dialog and asked the wallet for the
  // nonce first, on whatever chain it had moved to: that chain's nonce stored
  // here read as "pending" for as long as this chain's count stayed below it,
  // with no Forget (round 5, N03).
  const c = await ensureCreated();
  const p = await openApp(TRADER, { token: c.token, wallet: { forward: false, receipt: null }, extra: [
    ";(function () {",
    "  var w = window.ethereum, real = w.request.bind(w);",
    "  w.cfg.onSend = function (tx, wallet) { wallet.cfg.chainId = '0x1'; wallet.emit('chainChanged', '0x1'); };",
    "  w.request = function (a) {",
    "    if (a.method === 'eth_getTransactionByHash' && w.cfg.chainId !== '" + CHAIN + "') {",
    "      return Promise.resolve({ hash: a.params[0], from: w.cfg.account, nonce: '0x3e7', blockNumber: null });",
    "    }",
    "    return real(a);",
    "  };",
    "})();",
  ].join("\n") });
  await expect(p.locator("#status")).toHaveText("Selling", { timeout: 20_000 });
  const r = await tryTrade(p);
  expect(r.sent, "nothing was sent, so the dialog was never open").toBe(1);
  const hash = fake("01");   // the stub's first fake hash
  const rec = JSON.parse(await stored(p, { chainId: CHAIN, hash }));
  expect(rec, "the send left no record").not.toBeNull();
  expect(rec.uncertainChain, "a switch inside the dialog was not recorded").toBe(true);
  // THE WALLET DOES ANSWER A NONCE THERE, so the one above is the page's choice.
  const lie = await p.evaluate((h) => window.ethereum.request({ method: "eth_getTransactionByHash", params: [h] }), hash);
  expect(lie.nonce, "the wallet answers no nonce on the other chain; the test proves nothing").toBe("0x3e7");
  expect(rec.sentNonce, "a nonce the wallet read on another chain was kept").toBeNull();
  await p.close();
});

test("a send whose wallet switched networks and back inside the dialog is still recorded as uncertain", async () => {
  // BACK ON THE RIGHT CHAIN WHEN THE HASH RETURNS, so only the event says the
  // dialog crossed networks - and the transaction may have gone either way.
  // The record is written before its receipt clears it, so the writes are
  // watched rather than the store read afterwards.
  const c = await ensureCreated();
  const p = await openApp(TRADER, { token: c.token, wallet: { forward: false, receipt: { status: "0x0" } }, extra: [
    ";(function () {",
    "  var real = Storage.prototype.setItem;",
    "  window.__pendingWrites = [];",
    "  Storage.prototype.setItem = function (k, v) {",
    "    if (String(k).indexOf('curb.launch.pending.v3:') === 0) { try { window.__pendingWrites.push(JSON.parse(v)); } catch (e) {} }",
    "    return real.call(this, k, v);",
    "  };",
    "  window.ethereum.cfg.onSend = function (tx, wallet) {",
    "    wallet.cfg.chainId = '0x1'; wallet.emit('chainChanged', '0x1');",
    "    wallet.cfg.chainId = '" + CHAIN + "'; wallet.emit('chainChanged', '" + CHAIN + "');",
    "  };",
    "})();",
  ].join("\n") });
  await expect(p.locator("#status")).toHaveText("Selling", { timeout: 20_000 });
  const r = await tryTrade(p);
  expect(r.sent, "nothing was sent, so the dialog was never open").toBe(1);
  const writes = await p.evaluate((h) => window.__pendingWrites.filter((w) => w.hash === h), fake("01"));
  expect(writes.length, "the send wrote no record").toBeGreaterThan(0);
  expect(writes[0].uncertainChain, "a switch and back inside the dialog was not recorded").toBe(true);
  await p.close();
});

test("a create prepared in another tab excludes this one whatever lens either tab has", async () => {
  // WITHOUT WEB LOCKS the preparation claim is the only guard, and it was
  // keyed with the lens: a tab with the lens field empty and one with it
  // filled claimed two keys for one factory, and both reached the wallet
  // (round 5, N22). The other tab's claim is planted as a lens-empty tab
  // writes it; this tab has the lens filled.
  const c = await ensureCreated();
  const p = await dryTrader(c.token, []);
  await expect(p.locator("#status")).toHaveText("Selling", { timeout: 20_000 });
  const plantClaim = (subject) => p.evaluate((s) => localStorage.setItem("curb.launch.preparing",
    JSON.stringify([{ pageId: "another-tab", chainId: "0x2105", lens: "", token: s, startedAt: Date.now() }])), subject);

  await plantClaim(APP.factory);
  const create = await tryCreate(p);
  expect(create.text).toContain("Another tab is already preparing this");
  expect(create.sent, "two tabs both sent a create for one factory").toBe(0);

  await plantClaim("claim:" + APP.factory + ":" + TRADER);
  const claim = await tryClaim(p);
  expect(claim.text).toContain("Another tab is already preparing this");
  expect(claim.sent).toBe(0);
  await p.close();
});

// ============================================================ outstandingFor, kind by kind
test("a pending create blocks a create and not a trade", async () => {
  const c = await ensureCreated();
  const rec = createRecord(fake("a1"), { from: TRADER, lens: APP.lens, token: c.token });
  const p = await dryTrader(c.token, [rec]);
  await expect(p.locator("#status")).toHaveText("Selling", { timeout: 20_000 });

  const create = await tryCreate(p);
  expect(create.text).toContain(REFUSED);
  expect(create.sent).toBe(0);
  const trade = await tryTrade(p);
  expect(trade.text, "a slow create refused a trade").not.toContain(REFUSED);
  expect(trade.sent).toBe(1);
  await p.close();
});

test("a pending create-approve counts as a create: it blocks a create and not a trade of the launch it names", async () => {
  const c = await ensureCreated();
  const rec = createRecord(fake("a2"), { kind: "create-approve", from: TRADER, lens: APP.lens, token: c.token,
    what: "approve the dev buy" });
  const p = await dryTrader(c.token, [rec]);
  await expect(p.locator("#status")).toHaveText("Selling", { timeout: 20_000 });

  const create = await tryCreate(p);
  expect(create.text, "the approval inside a create did not hold back a second create").toContain(REFUSED);
  expect(create.sent).toBe(0);
  const trade = await tryTrade(p);
  expect(trade.text, "a create's approval refused a trade of the launch on screen").not.toContain(REFUSED);
  expect(trade.sent).toBe(1);
  await p.close();
});

test("a pending create on another factory does not block a create here", async () => {
  const c = await ensureCreated();
  const rec = createRecord(fake("a3"), { from: TRADER, factory: "0x" + "c3".repeat(20) });
  const p = await dryTrader(c.token, [rec]);
  await expect(p.locator("#status")).toHaveText("Selling", { timeout: 20_000 });
  const create = await tryCreate(p);
  expect(create.text).not.toContain(REFUSED);
  expect(create.sent).toBe(1);
  await p.close();
});

test("a pending claim blocks a claim on its factory, and neither a create nor a trade", async () => {
  const c = await ensureCreated();
  const rec = createRecord(fake("a4"), { kind: "claim", from: TRADER, factory: APP.factory, lens: APP.lens,
    token: c.token, what: "claim your curve fees" });
  const p = await dryTrader(c.token, [rec]);
  await expect(p.locator("#status")).toHaveText("Selling", { timeout: 20_000 });

  const claim = await tryClaim(p);
  expect(claim.text).toContain(REFUSED);
  expect(claim.text).not.toContain("Nothing is owed");
  expect(claim.sent, "two claims went out at once").toBe(0);
  const trade = await tryTrade(p);
  expect(trade.text, "a claim refused a trade").not.toContain(REFUSED);
  expect(trade.sent).toBe(1);
  const create = await tryCreate(p);
  expect(create.text, "a claim refused a create").not.toContain(REFUSED);
  expect(create.sent).toBe(1);
  await p.close();
});

test("a pending claim on another factory does not block a claim here", async () => {
  const c = await ensureCreated();
  const rec = createRecord(fake("a5"), { kind: "claim", from: TRADER, factory: "0x" + "c5".repeat(20),
    what: "claim your curve fees" });
  const p = await dryTrader(c.token, [rec]);
  await expect(p.locator("#status")).toHaveText("Selling", { timeout: 20_000 });
  const claim = await tryClaim(p);
  expect(claim.text, "a claim on another factory refused this one").not.toContain(REFUSED);
  // PAST THE RECORD CHECK either way: nothing owed stops it at the owed check,
  // something owed sends it (to the stub, which reverts it).
  expect(claim.text.includes("Nothing is owed") || claim.sent === 1,
    "the claim never got past the record check: " + claim.text).toBe(true);
  await p.close();
});

test("an app trade on this launch blocks another trade, and not a create", async () => {
  const c = await ensureCreated();
  const rec = createRecord(fake("a6"), { kind: "action", from: TRADER, lens: APP.lens, token: c.token,
    to: APP.factory, what: "buy on the curve" });
  const p = await dryTrader(c.token, [rec]);
  await expect(p.locator("#status")).toHaveText("Selling", { timeout: 20_000 });

  const trade = await tryTrade(p);
  expect(trade.text).toContain(REFUSED);
  expect(trade.sent, "two trades went out for one launch").toBe(0);
  const create = await tryCreate(p);
  expect(create.text, "a trade refused a create").not.toContain(REFUSED);
  expect(create.sent).toBe(1);
  await p.close();
});

test("an app trade whose nonce the account has moved past is cleared as replaced, and the next trade goes out", async () => {
  const c = await ensureCreated();
  const used = await selfTransfer(TRADER);
  const rec = createRecord(fake("a7"), { kind: "action", from: TRADER, lens: APP.lens, token: c.token,
    to: APP.factory, what: "buy on the curve", sentNonce: used.nonce, sentAfterBlock: hex(used.block - 1n) });
  const p = await dryTrader(c.token, [rec]);
  await expect(p.locator("#msg")).toContainText("replaced or dropped", { timeout: 30_000 });
  expect(await stored(p, rec)).toBeNull();
  const trade = await tryTrade(p);
  expect(trade.text).not.toContain(REFUSED);
  expect(trade.sent).toBe(1);
  await p.close();
});

// ============================================================ launch.html
const msgOf = (page) => page.locator("#msg");

test("launch.html's move is not stopped by an app claim that names this launch", async ({ page }) => {
  const claim = { page: "app", kind: "claim", chainId: CHAIN, rpc: STATE.rpc, lens: STATE.lens, token: STATE.token,
    factory: APP.factory, from: TRADER, to: APP.factory, hash: fake("b1"), what: "claim your curve fees" };
  await openLaunch(page, { wallet: { receipt: null }, pending: [claim] });
  await page.click("#connect");
  await expect(page.locator("#complete")).toBeEnabled({ timeout: 20_000 });
  await page.click("#complete");
  await expect(msgOf(page)).toContainText(/Tracking|Waiting for you to confirm/, { timeout: 20_000 });
  expect(await page.evaluate(() => window.ethereum.sent.length), "an app claim refused the move").toBe(1);
  expect(await stored(page, claim), "launch.html touched app's claim record").not.toBeNull();
});

test("launch.html clears its own graduation once the account's nonce is past it and the hash is gone", async ({ page }) => {
  const used = await selfTransfer(TRADER);
  const rec = { chainId: CHAIN, lens: STATE.lens, token: STATE.token, graduator: STATE.other.graduator,
    account: TRADER, hash: fake("b2"), uncertainChain: false, sentNonce: used.nonce };
  await openLaunch(page, { wallet: { receipt: null }, pending: [rec] });
  await expect(msgOf(page)).toContainText("replaced or dropped", { timeout: 30_000 });
  expect(await stored(page, rec), "a graduation the wallet replaced blocks for good").toBeNull();
});

test("launch.html keeps its graduation signed across a network switch, although the nonce is used", async ({ page }) => {
  const used = await selfTransfer(TRADER);
  const rec = { chainId: CHAIN, lens: STATE.lens, token: STATE.token, graduator: STATE.other.graduator,
    account: TRADER, hash: fake("b6"), uncertainChain: true, sentNonce: used.nonce };
  await openLaunch(page, { wallet: { receipt: null }, pending: [rec] });
  await expect(msgOf(page)).toContainText("changed networks", { timeout: 30_000 });
  await expect(msgOf(page)).not.toContainText("replaced or dropped");
  expect(await stored(page, rec), "an uncertain-chain graduation was cleared on this chain's nonce").not.toBeNull();
  await expect(page.locator("#msg button[data-forget]")).toBeVisible();
});

test("launch.html settles an app trade on this launch that would block its move, then moves", async ({ page }) => {
  const used = await selfTransfer(TRADER);
  const rec = { page: "app", kind: "action", chainId: CHAIN, rpc: STATE.rpc, lens: STATE.lens, token: STATE.token,
    factory: APP.factory, from: TRADER, to: APP.factory, hash: fake("b3"), what: "buy on the curve",
    sentNonce: used.nonce };
  await openLaunch(page, { wallet: { receipt: null }, pending: [rec] });
  await expect(msgOf(page)).toContainText("replaced or dropped", { timeout: 30_000 });
  await expect(msgOf(page)).toContainText("sent from app.html");
  expect(await stored(page, rec)).toBeNull();

  await page.click("#connect");
  await expect(page.locator("#complete")).toBeEnabled({ timeout: 20_000 });
  await page.click("#complete");
  await expect(msgOf(page)).toContainText(/Tracking|Waiting for you to confirm/, { timeout: 20_000 });
  expect(await page.evaluate(() => window.ethereum.sent.length), "the move stayed refused").toBe(1);
});

test("launch.html keeps a graduation whose nonce is unused, and forgets one nothing can settle only on confirm", async ({ page, context }) => {
  const count = await rpc("eth_getTransactionCount", [TRADER, "latest"]);
  const live = { chainId: CHAIN, lens: STATE.lens, token: STATE.token, graduator: STATE.other.graduator,
    account: TRADER, hash: fake("b4"), uncertainChain: false, sentNonce: count };
  await openLaunch(page, { wallet: { receipt: null }, pending: [live] });
  await expect(msgOf(page)).toContainText("has not been used by anything else", { timeout: 30_000 });
  // WHAT CLEARS IT WHEN THE WALLET NO LONGER SHOWS IT (round 5, N54).
  await expect(msgOf(page)).toContainText("zero-value send to yourself");
  await expect(page.locator("#msg button[data-forget]")).toHaveCount(0);
  expect(await stored(page, live)).not.toBeNull();

  // THE SECOND TAB SHARES THIS CONTEXT'S STORAGE, so the live record goes
  // first: the one it opens on is then the record nothing can settle.
  await page.evaluate((k) => localStorage.removeItem(k), keyOf(live));
  const lost = { chainId: CHAIN, lens: STATE.lens, token: STATE.token, graduator: STATE.other.graduator,
    account: TRADER, hash: fake("b5"), uncertainChain: false };
  const p2 = await openLaunch(await context.newPage(), { wallet: { receipt: null }, pending: [lost] });
  const button = p2.locator("#msg button[data-forget]");
  await expect(button).toBeVisible({ timeout: 20_000 });
  // DECLINED FIRST, and only counted as declined once the question was asked.
  let asked = 0;
  p2.once("dialog", (d) => { asked++; d.dismiss(); });
  await button.click();
  await expect.poll(() => asked, { timeout: 20_000, message: "launch.html never asked before forgetting" }).toBe(1);
  await p2.waitForTimeout(500);
  expect(await stored(p2, lost), "launch.html forgot a record although the person declined").not.toBeNull();

  await expect(button).toBeVisible({ timeout: 10_000 });
  p2.once("dialog", (d) => { asked++; d.accept(); });
  await button.click();
  await expect(msgOf(p2)).toContainText("is forgotten", { timeout: 20_000 });
  expect(asked).toBe(2);
  expect(await stored(p2, lost)).toBeNull();
  await p2.close();
});

test("launch.html offers to forget a graduation the network dropped, and says how to use its nonce", async ({ page }) => {
  // ITS NONCE UNUSED, NO NODE THAT KNOWS THE HASH, SENT TWO HOURS AGO. It was
  // "pending" for good, refusing the move, with advice to cancel what no
  // wallet showed any more (round 5, N54).
  const count = await rpc("eth_getTransactionCount", [TRADER, "latest"]);
  const rec = { chainId: CHAIN, lens: STATE.lens, token: STATE.token, graduator: STATE.other.graduator,
    account: TRADER, hash: fake("b8"), uncertainChain: false, sentNonce: count, sentAt: Date.now() - 2 * 3600 * 1000 };
  await openLaunch(page, { wallet: { receipt: null }, pending: [rec] });
  await expect(msgOf(page)).toContainText("most likely dropped", { timeout: 30_000 });
  await expect(msgOf(page)).toContainText("zero-value send to yourself");
  const button = page.locator("#msg button[data-forget]");
  await expect(button).toBeVisible();
  let question = "";
  page.once("dialog", (d) => { question = d.message(); d.dismiss(); });
  await button.click();
  await expect.poll(() => question, { timeout: 20_000, message: "launch.html never asked before forgetting" })
    .toContain("at nonce " + parseInt(count, 16));
  expect(await stored(page, rec), "the record went although the person declined").not.toBeNull();
});

test("launch.html's graduation signed across a network switch, its nonce unused, offers to be forgotten", async ({ page }) => {
  // THE NONCE MAY BE ANOTHER CHAIN'S, where the account had sent more. Unused
  // here, it read as "pending" with no Forget (round 5, P-R22, S16).
  const count = await rpc("eth_getTransactionCount", [TRADER, "latest"]);
  const rec = { chainId: CHAIN, lens: STATE.lens, token: STATE.token, graduator: STATE.other.graduator,
    account: TRADER, hash: fake("b7"), uncertainChain: true, sentNonce: count };
  await openLaunch(page, { wallet: { receipt: null }, pending: [rec] });
  await expect(msgOf(page)).toContainText("changed networks", { timeout: 30_000 });
  await expect(msgOf(page)).not.toContainText("has not been used by anything else");
  await expect(page.locator("#msg button[data-forget]")).toBeVisible();
  expect(await stored(page, rec)).not.toBeNull();
});

test("launch.html keeps no nonce its wallet read on the chain it switched to inside the dialog", async ({ page }) => {
  // THE NONCE WAS READ BACK THROUGH THE WALLET WITH NO CHAIN CHECK: after a
  // switch inside the dialog, the other chain's nonce was stored as this
  // record's (round 5, P-R22). The wallet here answers a nonce only while it
  // is on the other chain, as a real one on that chain would.
  await openLaunch(page, { wallet: { receipt: null }, extra: [
    ";(function () {",
    "  var w = window.ethereum, real = w.request.bind(w);",
    "  w.cfg.onSend = function (tx, wallet) { wallet.cfg.chainId = '0x1'; wallet.emit('chainChanged', '0x1'); };",
    "  w.request = function (a) {",
    "    if (a.method === 'eth_getTransactionByHash' && w.cfg.chainId !== '" + CHAIN + "') {",
    "      return Promise.resolve({ hash: a.params[0], from: w.cfg.account, nonce: '0x3e7', blockNumber: null });",
    "    }",
    "    return real(a);",
    "  };",
    "})();",
  ].join("\n") });
  await page.click("#connect");
  await expect(page.locator("#complete")).toBeEnabled({ timeout: 20_000 });
  await page.click("#complete");
  await expect(msgOf(page)).toContainText("Could not confirm", { timeout: 20_000 });
  const recs = await page.evaluate(() => window.CurbLaunch.loadPendingAll());
  expect(recs.length, "the send left no record").toBe(1);
  expect(recs[0].uncertainChain).toBe(true);
  const lie = await page.evaluate((h) => window.ethereum.request({ method: "eth_getTransactionByHash", params: [h] }),
    recs[0].hash);
  expect(lie.nonce, "the wallet answers no nonce on the other chain; the test proves nothing").toBe("0x3e7");
  expect(recs[0].sentNonce, "a nonce the wallet read on another chain was kept").toBeNull();
});

// ============================================================ round 5: what app.html draws
//
// THE DISPLAY FAMILY. Each test below fails with its fix removed:
//   - status, progress, threshold and supply are the chain's, not the lens's,
//     and a lens that disagrees about the status is refused (S05 / P-R51)
//   - NotFound draws nothing the lens sent beside it, and a lens saying NotFound
//     for a launch the registry records is refused (P-R51)
//   - a launch made by another factory on the same asset is not drawn under
//     this one, moves to its own when nobody chose, and refuses a send (S53)
//   - an unreadable factory takes the previous launch, the owed panel and the
//     context off the screen (S28)
//   - the rescue box belongs to one launch, and only to a revert (S22)
//   - 0 bps is "0%" (S27)
//   - a link naming a lens and a launch takes no factory from storage, and one
//     naming a lens alone says where its factory came from (P-R25)
//   - a create record from another endpoint does not hold the switch (S47)
//   - a dev buy the account cannot fund sends nothing (S20), and on the WETH
//     pair what is short is wrapped from ETH first, as its own send, for a dev
//     buy and for a curve buy - and the page says WETH where WETH moves
//
// WHERE A LENS OR A CONTRACT LIES, the lie is written into the page's own
// eth_call answers; everything else it reads reaches the node untouched.

/// Selectors derived here with the page's own keccak, loaded into a sandbox -
/// never pasted.
const KECCAK = (() => {
  const vm = require("node:vm");
  const box = {};
  box.window = box;
  box.globalThis = box;
  vm.createContext(box);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "keccak.js"), "utf8"), box);
  return box.CurbKeccak.keccak256;
})();
const sel = (sig) => KECCAK("0x" + Buffer.from(sig, "utf8").toString("hex")).slice(0, 10);
const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const WETH_ADDR = "0x4200000000000000000000000000000000000006";
const ONE = 10n ** 18n;

async function ethCall(to, data) { return rpc("eth_call", [{ to, data }, "latest"]); }
const addrOf = (hexWord) => "0x" + hexWord.replace(/^0x/, "").slice(24, 64);
const wordsOf = (hex) => (hex || "0x").replace(/^0x/, "").match(/.{64}/g) || [];
/// Replaces word i of a raw ABI answer.
const setWord = (hex, i, w) => {
  const h = hex.replace(/^0x/, "");
  return "0x" + h.slice(0, i * 64) + w + h.slice((i + 1) * 64);
};
/// Plain decimal text for an 18-decimal amount, as a person would type it.
const units18 = (v) => {
  const frac = (v % ONE).toString().padStart(18, "0").replace(/0+$/, "");
  return (v / ONE).toString() + (frac ? "." + frac : "");
};

/// REWRITES CHOSEN eth_call ANSWERS ON THE PAGE'S SIDE. A rule matches a
/// contract and a calldata prefix and either answers (`result`), edits the
/// node's real answer (`edit`), sends the call to another contract instead
/// (`proxyTo`, which is how a fabricated address is made to behave as a real
/// factory), drops it as a network failure would (`abort`), or answers it with
/// a JSON-RPC error of the rule's choosing (`error`: a revert is code 3, a rate
/// limit -32016 - the node's own shape for both).
async function onCalls(p, rules) {
  await p.route("**/*", async (route) => {
    const req = route.request();
    const raw = req.postData() || "";
    if (req.method() !== "POST" || !raw) return route.continue();
    let m; try { m = JSON.parse(raw); } catch { return route.continue(); }
    if (!m || m.method !== "eth_call" || !m.params || !m.params[0]) return route.continue();
    const to = String(m.params[0].to || "").toLowerCase();
    const data = String(m.params[0].data || m.params[0].input || "").toLowerCase();
    const r = rules.find((x) => to === x.to.toLowerCase() && (!x.data || data.startsWith(x.data.toLowerCase())));
    if (!r) return route.continue();
    if (r.abort) return route.abort("failed");
    if (r.error) {
      return route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id: m.id, error: r.error }) });
    }
    if (r.proxyTo) {
      const moved = { ...m, params: [{ ...m.params[0], to: r.proxyTo }, ...m.params.slice(1)] };
      return route.continue({ postData: JSON.stringify(moved) });
    }
    let result = r.result;
    if (r.edit) {
      const payload = await (await route.fetch()).json();
      if (payload.error) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
      }
      result = r.edit(payload.result || "0x");
    }
    return route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) });
  });
}

/// app.html at a query of the test's choosing, with the page's address book in
/// storage BEFORE its scripts run (once per context).
async function openAt(account, query, { store = null, before = null, wallet = {} } = {}) {
  const p = await browserRef.newPage();
  p.on("pageerror", (e) => console.log("PAGE ERROR: " + e.message));
  const bootstrap = [
    STUB,
    ";(function () {",
    "  var cfg = " + JSON.stringify({ rpc: STATE.rpc, account, store, key: APP_ADDR_STORE, wallet }) + ";",
    "  if (cfg.store && !sessionStorage.getItem('round5.stored')) {",
    "    sessionStorage.setItem('round5.stored', '1');",
    "    localStorage.setItem(cfg.key, JSON.stringify(cfg.store));",
    "  }",
    "  var opts = Object.assign({ forward: true, chainId: '" + CHAIN + "', account: cfg.account }, cfg.wallet);",
    "  window.ethereum = window.makeWallet(cfg.rpc, opts);",
    "})();",
  ].join("\n");
  await p.addInitScript({ content: bootstrap });
  if (before) await before(p);
  await p.goto("/app.html?" + new URLSearchParams(query).toString());
  await p.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
  await expect(p.locator("#wallet")).toContainText(account, { ignoreCase: true, timeout: 20_000 });
  return p;
}

/// THE REGISTRY'S RECORD OF A LAUNCH, and the contracts it names, read from the
/// test's side.
async function launchFacts(token) {
  const registry = addrOf(await ethCall(APP.factory, sel("registry()")));
  const rec = wordsOf(await ethCall(registry, sel("launchOf(address)") + pad(token)));
  const curve = addrOf(rec[0]);
  const escrow = addrOf(await ethCall(curve, sel("feeEscrow()")));
  return { registry, curve, quote: addrOf(rec[1]), escrow };
}
const lensData = (token) => (sel("launchState(address)") + pad(token)).toLowerCase();
const lensRule = (token, edit) => ({ to: APP.lens, data: lensData(token), edit });

async function wethFactoryAddr() {
  const registry = addrOf(await ethCall(APP.factory, sel("registry()")));
  const n = Number(BigInt(await ethCall(registry, sel("launcherCount()"))));
  for (let i = 0; i < n; i++) {
    const f = addrOf(await ethCall(registry, sel("launcherAt(uint256)") + word(i)));
    if (addrOf(await ethCall(f, sel("quoteToken()"))) === WETH_ADDR) return f;
  }
  throw new Error("the registry lists no WETH factory");
}

// ------------------------------------------------------------ S05 / P-R51
test("a lens naming the real curve and pool but other numbers is drawn with the chain's numbers", async () => {
  const c = await ensureCreated();
  const f = await launchFacts(c.token);
  const [realQ, thr, supply] = (await Promise.all([
    ethCall(f.curve, sel("realQuoteReserve()")), ethCall(f.curve, sel("graduationThreshold()")),
    ethCall(c.token, sel("totalSupply()")),
  ])).map((x) => BigInt(x));
  expect(thr > 2n, "the curve has no threshold to lie about").toBe(true);
  // NEAR GRADUATION, A SMALLER THRESHOLD, A LARGER SUPPLY - all beside the
  // genuine curve and pool key, which is what got the old draw past its checks.
  const lie = (hex) => setWord(setWord(setWord(hex, 6, word(thr / 2n - 1n)), 7, word(thr / 2n)), 8, word(supply * 3n));
  const p = await openApp(TRADER, { token: c.token, before: (pg) => onCalls(pg, [lensRule(c.token, lie)]) });

  await expect(p.locator("#status")).toHaveText("Selling", { timeout: 30_000 });
  await expect(p.locator("#supply"), "the lens's supply was drawn")
    .toHaveAttribute("title", "exact: " + supply.toString());
  const drawn = await p.evaluate(() => ({
    real: window.CurbApp.state.view.realQuoteReserve.toString(),
    thr: window.CurbApp.state.view.graduationThreshold.toString(),
  }));
  expect(drawn.real, "the lens's reserve was drawn").toBe(realQ.toString());
  expect(drawn.thr, "the lens's threshold was drawn").toBe(thr.toString());
  const expected = await p.evaluate(({ r, t }) => {
    const d = window.CurbApp.state.ctx.quoteDecimals;
    return window.CurbApp.fmt(BigInt(r), d, 4) + " of " + window.CurbApp.fmt(BigInt(t), d, 4);
  }, { r: realQ.toString(), t: thr.toString() });
  await expect(p.locator("#progressText")).toContainText(expected);
  await p.close();
});

test("a lens that calls a selling launch Waiting is refused, not drawn", async () => {
  const c = await ensureCreated();
  const p = await openApp(TRADER, { token: c.token,
    before: (pg) => onCalls(pg, [lensRule(c.token, (hex) => setWord(hex, 0, word(2)))]) });
  await expect(p.locator("#readmsg")).toContainText("the chain says Selling", { timeout: 30_000 });
  await expect(p.locator("#launchPanel"), "a Waiting panel was drawn for a selling launch").toBeHidden();
  await expect(p.locator("#waitBox")).toBeHidden();
  expect(await p.evaluate(() => window.CurbApp.state.view)).toBeNull();
  await p.close();
});

test("NotFound draws nothing the lens sent beside it, and a NotFound the registry contradicts is refused", async () => {
  // A TOKEN NO REGISTRY KNOWS, with a lens answering NotFound AND a curve and a
  // supply - which used to be printed beside "NotFound".
  const stranger = "0x" + "7a".repeat(20);
  const junk = (hex) => {
    let h = "0x" + (hex || "0x").replace(/^0x/, "").padEnd(14 * 64, "0");
    h = setWord(h, 0, word(0));
    h = setWord(h, 1, pad("0x" + "be".repeat(20)));
    return setWord(h, 8, word(123n * ONE));
  };
  const p = await openApp(TRADER, { token: stranger, before: (pg) => onCalls(pg, [lensRule(stranger, junk)]) });
  await expect(p.locator("#status")).toHaveText("NotFound", { timeout: 30_000 });
  await expect(p.locator("#curveAddr"), "the lens's curve was drawn beside NotFound").toHaveText("—");
  await expect(p.locator("#supply"), "the lens's supply was drawn beside NotFound").toHaveText("—");
  // AND NOTHING OF IT IS KEPT as the launch on screen, for anything that reads it later.
  const kept = await p.evaluate(() => ({ curve: window.CurbApp.state.view.curve, supply: window.CurbApp.state.view.totalSupply.toString() }));
  expect(kept, "the lens's words were kept beside NotFound").toEqual({ curve: "0x" + "0".repeat(40), supply: "0" });
  await p.close();

  // AND A REAL LAUNCH THE LENS CALLS NotFound: the registry records it.
  const c = await ensureCreated();
  const q = await openApp(TRADER, { token: c.token,
    before: (pg) => onCalls(pg, [lensRule(c.token, (hex) => setWord(hex, 0, word(0)))]) });
  await expect(q.locator("#readmsg")).toContainText("reports no launch", { timeout: 30_000 });
  await expect(q.locator("#launchPanel")).toBeHidden();
  await q.close();
});

// ------------------------------------------------------------ S53
test("a launch whose curve pays another escrow is not drawn under this factory, and a send is refused", async () => {
  const c = await ensureCreated();
  const f = await launchFacts(c.token);
  const elsewhere = "0x" + "e5".repeat(20);
  const p = await openApp(TRADER, { token: c.token,
    before: (pg) => onCalls(pg, [{ to: f.curve, data: sel("feeEscrow()"), result: "0x" + pad(elsewhere) }]) });
  await expect(p.locator("#readmsg")).toContainText("made by another", { timeout: 30_000 });
  await expect(p.locator("#readmsg")).toContainText(elsewhere, { ignoreCase: true });
  await expect(p.locator("#launchPanel"), "the launch was drawn with this factory's escrow").toBeHidden();

  // AND THE SEND, asked for directly: the curve's escrow is compared there too.
  const said = await p.evaluate(() => window.CurbApp.curveAction().then(() => "no refusal", (e) => e.message));
  expect(said, "a send went ahead for a launch another factory made").toContain("made by another");
  expect(await p.evaluate(() => window.ethereum.sent.length)).toBe(0);
  await p.close();
});

test("a launch made by a second factory on the same asset moves the page to that factory", async () => {
  const c = await ensureCreated();
  const f = await launchFacts(c.token);
  const n = BigInt(await ethCall(f.registry, sel("launcherCount()")));
  // A SECOND NVDAc FACTORY, listed last. It answers every call as the real one
  // does - so the curve's escrow is ITS escrow - and the page's own factory now
  // reports another.
  const second = "0x" + "5a".repeat(20);
  const p = await openApp(TRADER, { token: c.token, before: (pg) => onCalls(pg, [
    { to: f.registry, data: sel("launcherCount()"), result: "0x" + word(n + 1n) },
    { to: f.registry, data: sel("launcherAt(uint256)") + word(n), result: "0x" + pad(second) },
    { to: APP.factory, data: sel("feeEscrow()"), result: "0x" + pad("0x" + "e6".repeat(20)) },
    { to: second, proxyTo: APP.factory },
  ]) });
  await expect.poll(() => p.evaluate(() => window.CurbApp.state.chainCfg.factory.toLowerCase()),
    { timeout: 30_000, message: "the page stayed on a factory whose escrow never saw this launch's fees" })
    .toBe(second);
  await expect(p.locator("#status")).toHaveText("Selling", { timeout: 30_000 });
  await expect(p.locator("#readmsg")).toContainText("made by another");
  await p.close();
});

// ------------------------------------------------------------ S28
test("a factory that cannot be read takes the last launch, the owed panel and the context off the screen", async () => {
  const c = await ensureCreated();
  const p = await openApp(OWNER, { token: c.token });
  await expect(p.locator("#status")).toHaveText("Selling", { timeout: 30_000 });
  await expect(p.locator("#owedBox")).toBeVisible({ timeout: 30_000 });

  // AN ADDRESS WITH NO CODE: every read of it fails, before any context.
  await p.fill("#factory", "0x000000000000000000000000000000000000dEaD");
  await p.dispatchEvent("#factory", "change");
  await expect(p.locator("#launchPanel"), "the previous launch stayed drawn").toBeHidden({ timeout: 20_000 });
  await expect(p.locator("#owedBox"), "the previous factory's owed panel stayed drawn").toBeHidden();
  await expect(p.locator("#sumGrad"), "the previous asset's threshold stayed on the card").toHaveText("—");
  expect(await p.evaluate(() => window.CurbApp.state.ctx), "the previous context was kept").toBeNull();

  // NOT AN ADDRESS AT ALL. With a lens and a launch in the form, refresh()
  // resolves the launch's own factory instead, so the launch is cleared first:
  // what is held here is the factory's half - the owed panel, the context, the
  // card - which that path used to leave behind.
  await p.fill("#factory", APP.factory);
  await p.dispatchEvent("#factory", "change");
  await expect(p.locator("#status")).toHaveText("Selling", { timeout: 30_000 });
  await p.fill("#token", "");
  await p.dispatchEvent("#token", "change");
  await expect(p.locator("#launchPanel")).toBeHidden({ timeout: 20_000 });
  await expect(p.locator("#owedBox")).toBeVisible({ timeout: 30_000 });
  await p.fill("#factory", "0x1234");
  await p.dispatchEvent("#factory", "change");
  await expect(p.locator("#owedBox"), "a factory that is not an address kept the last one's owed panel")
    .toBeHidden({ timeout: 20_000 });
  await expect(p.locator("#sumGrad")).toHaveText("—");
  expect(await p.evaluate(() => window.CurbApp.state.ctx), "a factory that is not an address kept the last context")
    .toBeNull();
  await p.close();
});

// ------------------------------------------------------------ S22
test("the rescue box belongs to the launch it was shown for, and only to a revert", async () => {
  const c = await ensureCreated();
  const pb = await openApp(OWNER);
  const b = await createdLaunch(pb, "Rescue Other", "RSCO");
  await pb.close();
  const fb = await launchFacts(b.token);

  const p = await openApp(OWNER, { token: c.token });
  await expect(p.locator("#status")).toHaveText("Selling", { timeout: 30_000 });
  await drawnFor(p, c.token);
  const complete = () => p.evaluate(() => window.CurbApp.completeGraduation().then(() => "sent", (e) => e.message));
  // THE BOX'S OWN STATE. It sits inside the "Complete the move" section, which
  // is hidden while a launch is selling - so its visibility says nothing there,
  // and a "hidden" assertion on a selling launch passed whatever the box did.
  const boxHidden = () => p.evaluate(() => document.getElementById("rescueBox").hidden);

  // A REAL REVERT: graduating a launch that is still selling.
  expect(await complete()).toContain("Completing the move would revert");
  expect(await boxHidden(), "a revert did not open the rescue").toBe(false);

  // ANOTHER LAUNCH, WAITING. It is made to look it - the lens and the curve
  // both say so - and nothing was simulated for it.
  await onCalls(p, [
    lensRule(b.token, (hex) => setWord(hex, 0, word(2))),
    { to: fb.curve, data: sel("readyToGraduate()"), result: "0x" + word(1) },
  ]);
  await p.fill("#token", b.token);
  await p.dispatchEvent("#token", "change");
  await expect(p.locator("#status")).toHaveText("Waiting", { timeout: 30_000 });
  await expect(p.locator("#waitBox")).toBeVisible();
  await expect.poll(boxHidden, { message: "the rescue shown for one launch was offered for another" }).toBe(true);
  await p.unroute("**/*");

  // BACK TO THE FIRST, and a refresh: it is selling, so nothing is to rescue.
  await p.fill("#token", c.token);
  await p.dispatchEvent("#token", "change");
  await expect(p.locator("#status")).toHaveText("Selling", { timeout: 30_000 });
  await drawnFor(p, c.token);
  expect(await complete()).toContain("Completing the move would revert");
  expect(await boxHidden(), "a revert did not open the rescue").toBe(false);
  await p.evaluate(() => window.CurbApp.refresh(true));
  await expect.poll(boxHidden, { message: "a rescue stayed up for a launch that is not waiting" }).toBe(true);

  // A DROPPED REPLY IS NOT A REVERT. The graduator is the one a send uses: the factory's.
  const graduator = addrOf(await ethCall(APP.factory, sel("graduator()")));
  await onCalls(p, [{ to: graduator, data: sel("graduate(address)") + pad(c.token), abort: true }]);
  expect(await complete()).toContain("could not be checked");
  expect(await boxHidden(), "a network failure opened the rescue").toBe(true);
  await p.unroute("**/*");
  await p.close();
});

// ------------------------------------------------------------ S27
test("a share of 0 bps prints as 0%, and whole percentages keep their zeros", async () => {
  const p = await openApp(TRADER);
  const out = await p.evaluate(() => [0, 50, 125, 100, 1000].map((b) => window.CurbApp.fmtBps(BigInt(b))));
  expect(out).toEqual(["0%", "0.5%", "1.25%", "1%", "10%"]);
  await p.close();
});

// ------------------------------------------------------------ P-R25
test("a link naming a lens and a launch takes no factory from storage, and a lens alone says where its factory came from", async () => {
  const c = await ensureCreated();
  // STORAGE FROM ANOTHER DEPLOYMENT, chosen there.
  const store = { rpc: STATE.rpc, factory: STATE.other.factory, lens: STATE.lens, token: "", chosen: true };
  const p = await openAt(TRADER, { rpc: STATE.rpc, lens: APP.lens, token: c.token }, { store });
  await expect.poll(() => p.evaluate(() => window.CurbApp.state.chainCfg.factory.toLowerCase()),
    { timeout: 30_000, message: "the factory came from storage, not from the launch" })
    .toBe(APP.factory.toLowerCase());
  await expect(p.locator("#status")).toHaveText("Selling", { timeout: 30_000 });
  await expect(p.locator("#readmsg")).toContainText("The link named no factory");
  await p.close();

  const q = await openAt(TRADER, { rpc: STATE.rpc, lens: APP.lens }, { store });
  await expect(q.locator("#linkWarn")).toContainText("named a lens but no factory", { timeout: 20_000 });
  await expect(q.locator("#linkWarn")).toContainText(STATE.other.factory, { ignoreCase: true });
  await q.close();

  // A LINK TO A LAUNCH ALONE: a factory chosen on an earlier visit, for another
  // asset, does not hold the page off the launch's own factory.
  const wf = await wethFactoryAddr();
  const r = await openAt(TRADER, { rpc: STATE.rpc, token: c.token },
    { store: { rpc: STATE.rpc, factory: wf, lens: APP.lens, token: "", chosen: true } });
  await expect.poll(() => r.evaluate(() => window.CurbApp.state.chainCfg.factory.toLowerCase()),
    { timeout: 30_000, message: "an earlier visit's pick held the page off the launch a link named" })
    .toBe(APP.factory.toLowerCase());
  await r.close();
});

// ------------------------------------------------------------ S20
test("a dev buy the account does not hold is refused before any approval", async () => {
  const quote = addrOf(await ethCall(APP.factory, sel("quoteToken()")));
  const p = await openApp(OWNER, { before: (pg) => onCalls(pg, [
    { to: quote, data: sel("balanceOf(address)") + pad(OWNER), result: "0x" + word(0) },
  ]) });
  await expect(p.locator("#quoteBal")).not.toHaveText("—", { timeout: 30_000 });
  await p.fill("#nName", "Unfunded Buy");
  await p.fill("#nSymbol", "UNFB");
  await p.fill("#nDevBuy", "1");
  const r = await attempt(p, () => p.click("#create"));
  expect(r.text, "the refusal does not say what is held").toContain("holds 0");
  expect(r.sent, "an approval or a launch went out for a dev buy the account cannot pay").toBe(0);
  await p.close();
});

// ------------------------------------------------------------ the WETH pair
/// AN ACCOUNT SHORT OF WETH, from the node's own unlocked accounts: a plain key
/// (no code, or only an EIP-7702 delegation - on Base every one of these
/// well-known keys carries one, TRADER included), ETH to wrap, and less WETH
/// than `limit`. Chosen, not assumed - this is a fork of a real chain, where
/// anybody may have sent WETH to a well-known key.
async function wethShortAccount(limit) {
  const candidates = [
    "0x976ea74026e726554db657fa54763abd0c3a0aa9", "0x14dc79964da2c08b23698b3d3cc7ca32193d9955",
    "0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f", "0xa0ee7a142d267c1f36714e4a8f75612f20a79720",
    "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc", "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65",
  ];
  for (const a of candidates) {
    const code = await rpc("eth_getCode", [a, "latest"]);
    const delegated = /^0xef0100[0-9a-f]{40}$/i.test(code);
    if (code !== "0x" && !delegated) continue;
    if (BigInt(await rpc("eth_getBalance", [a, "latest"])) < ONE) continue;
    const held = BigInt(await ethCall(WETH_ADDR, sel("balanceOf(address)") + pad(a)));
    if (held < limit) return { account: a, held };
  }
  throw new Error("none of the node's accounts is short of WETH with ETH to wrap");
}

let wethLaunch = null;

test("a WETH dev buy the creator is short of is wrapped from ETH first, then approved, then launched", async () => {
  const wf = await wethFactoryAddr();
  const thr = BigInt(await ethCall(wf, sel("graduationThreshold()")));
  // A TWENTIETH OF THE THRESHOLD, well inside the dev buy cap: that is a fifth
  // of the SUPPLY in tokens (MAX_DEV_BUY_BPS), about 0.42 WETH on this curve
  // (1.65 / 4.47 since 2026-10-15).
  expect(BigInt(await ethCall(wf, sel("MAX_DEV_BUY_BPS()"))), "the dev buy cap moved").toBe(2000n);
  const cap = thr / 20n;
  const extra = ONE / 1000n;
  const who = await wethShortAccount(cap - extra);
  const devBuy = who.held + extra;

  const p = await openAt(who.account, { rpc: STATE.rpc, factory: wf, lens: APP.lens });
  // WHAT MOVES, SAID AS WHAT MOVES: the curve takes WETH.
  await expect(p.locator("#quoteLiquidity")).toContainText("its curve takes WETH", { timeout: 30_000 });
  await expect(p.locator("#quoteLiquidity")).not.toContainText("sending ETH");
  await p.fill("#nName", "Wrapped First");
  await p.fill("#nSymbol", "WRPF");
  await p.fill("#nDevBuy", units18(devBuy));
  await p.click("#create");
  await expect(p.locator("#msg")).toContainText("Launched", { timeout: 60_000 });

  const sent = await p.evaluate(() =>
    window.ethereum.sent.map((t) => ({ to: t.to, data: t.data, value: t.value || "0x0" })));
  expect(sent.length, "expected a wrap, an approval and the launch").toBe(3);
  expect(sent[0].to.toLowerCase(), "the first send is not to WETH").toBe(WETH_ADDR);
  expect(sent[0].data.toLowerCase(), "the first send is not WETH.deposit()").toBe(sel("deposit()"));
  expect(BigInt(sent[0].value), "the wrap is not exactly the shortfall").toBe(devBuy - who.held);
  expect(sent[1].data.toLowerCase().startsWith(sel("approve(address,uint256)")), "the second send is not the approval")
    .toBe(true);
  expect(sent[2].to.toLowerCase()).toBe(wf.toLowerCase());
  wethLaunch = { token: await p.evaluate(() => window.CurbApp.state.chainCfg.token), factory: wf };
  await p.close();
});

async function ensureWethLaunch() {
  if (wethLaunch) return wethLaunch;
  const wf = await wethFactoryAddr();
  const p = await openAt(OWNER, { rpc: STATE.rpc, factory: wf, lens: APP.lens });
  await p.fill("#nName", "Records Weth");
  await p.fill("#nSymbol", "RWTH");
  await p.click("#create");
  await expect(p.locator("#msg")).toContainText("Launched", { timeout: 60_000 });
  wethLaunch = { token: await p.evaluate(() => window.CurbApp.state.chainCfg.token), factory: wf };
  await p.close();
  return wethLaunch;
}

/// THE FLOW FROM BEFORE THE CURB ROUTER, which an ETH buy on the WETH pair still
/// takes wherever the router cannot be used (app.js routerReady): pinned with no
/// code at the router's address, put back afterwards byte for byte. With the
/// router there the same buy is one transaction to it (router.spec.js).
const CURB_ROUTER_ADDR = "0xea20c3266229a01cd0f45d9c7921a45d5b359561";
async function withoutRouter(fn) {
  const code = await rpc("eth_getCode", [CURB_ROUTER_ADDR, "latest"]);
  await rpc("anvil_setCode", [CURB_ROUTER_ADDR, "0x"]);
  try { return await fn(); } finally {
    if (code !== "0x") await rpc("anvil_setCode", [CURB_ROUTER_ADDR, code]);
  }
}

test("WITHOUT THE ROUTER: a curve buy on the WETH pair wraps the buyer's shortfall from ETH, says so first, and buys", async () => withoutRouter(async () => {
  const w = await ensureWethLaunch();
  const amount = (2n * ONE) / 1000n;
  const who = await wethShortAccount(amount);
  const p = await openAt(who.account, { rpc: STATE.rpc, factory: w.factory, lens: APP.lens, token: w.token });
  await expect(p.locator("#status")).toHaveText("Selling", { timeout: 30_000 });
  // ETH, WHERE A WETH PAIR'S CURVE STARTS: "WETH" there spends WETH only.
  expect(await p.locator("#curveVia").inputValue(), "a WETH pair's curve does not start on ETH").toBe("eth");
  await p.selectOption("#curveSide", "buy");
  await p.fill("#curveAmount", units18(amount));
  await p.evaluate(() => window.CurbApp.refresh(true));
  await expect(p.locator("#curveQuote"), "the buyer was not told a wrap comes first")
    .toContainText("wrapped from your ETH first", { timeout: 20_000 });
  await expect(p.locator("#curveAct")).toBeEnabled({ timeout: 20_000 });
  const heldNow = BigInt(await ethCall(WETH_ADDR, sel("balanceOf(address)") + pad(who.account)));
  expect(heldNow < amount, "the buyer holds enough WETH; the test proves nothing").toBe(true);

  const r = await attempt(p, () => p.click("#curveAct"));
  expect(r.text, "the buy did not complete").toContain("Done");
  const sent = await p.evaluate(() =>
    window.ethereum.sent.map((t) => ({ to: t.to, data: t.data, value: t.value || "0x0" })));
  expect(sent[0].to.toLowerCase(), "no wrap went out before the buy").toBe(WETH_ADDR);
  expect(sent[0].data.toLowerCase()).toBe(sel("deposit()"));
  expect(BigInt(sent[0].value), "the wrap is not exactly the shortfall").toBe(amount - heldNow);
  expect(sent[sent.length - 1].data.toLowerCase().startsWith(sel("buy(uint256,uint256,address)")),
    "the last send is not the buy").toBe(true);
  await p.close();
}));

// ------------------------------------------------------------ S47
test("a create record sent through another endpoint does not hold the automatic switch; one sent here does", async () => {
  const w = await ensureWethLaunch();
  // ANOTHER ENDPOINT, the same factory address: what a second chain's, or an
  // old fork's, record looks like.
  const far = createRecord(fake("f1"), { rpc: "http://127.0.0.1:1", from: OWNER });
  const p = await openApp(OWNER, { plant: [far], token: w.token });
  await expect.poll(() => p.evaluate(() => window.CurbApp.state.chainCfg.factory.toLowerCase()),
    { timeout: 30_000, message: "a create record from another endpoint held the page on the wrong asset" })
    .toBe(w.factory.toLowerCase());
  await p.close();

  // THE CONTROL: the same record at THIS endpoint still holds it.
  const near = createRecord(fake("f2"), { from: OWNER });
  const q = await openApp(OWNER, { plant: [near], token: w.token });
  await expect(q.locator("#readmsg")).toContainText("priced in WETH", { timeout: 30_000 });
  expect((await q.evaluate(() => window.CurbApp.state.chainCfg.factory)).toLowerCase())
    .toBe(APP.factory.toLowerCase());
  await q.close();
});

// ============================================================ round 5, display: the reviewer's additions
//
// Each fails with its fix removed:
//   - where a launch is, the page asks the chain the way the lens does - the
//     curve's own graduated() counts - and an empty answer is refused rather
//     than read as "Selling" (S05)
//   - the rescue opens only for a revert, not for a node's rate-limit answer,
//     and not on a launch the form moved to while the check was out (S22)
//   - a create record of another chain does not hold the switch, although it
//     was sent through this very endpoint (S47)

// ------------------------------------------------------------ S05
test("a status the graduator or the curve does not answer is refused, not drawn as Selling", async () => {
  const c = await ensureCreated();
  const graduator = addrOf(await ethCall(APP.factory, sel("graduator()")));
  const p = await openApp(TRADER, { token: c.token, before: (pg) => onCalls(pg, [
    { to: graduator, data: sel("hasGraduated(address)") + pad(c.token), result: "0x" },
  ]) });
  await expect(p.locator("#readmsg"), "an empty answer was read as a status")
    .toContainText("answered nothing", { timeout: 30_000 });
  await expect(p.locator("#launchPanel"), "a launch was drawn from an answer that was not there").toBeHidden();
  expect(await p.evaluate(() => window.CurbApp.state.view)).toBeNull();
  await p.close();
});

test("a curve that says it graduated is Graduated, as the lens counts it, not refused", async () => {
  const c = await ensureCreated();
  const f = await launchFacts(c.token);
  // THE CURVE'S OWN FLAG, which the lens asks beside the graduator's. The lens
  // is made to say what it would say with that flag set.
  const p = await openApp(TRADER, { token: c.token, before: (pg) => onCalls(pg, [
    { to: f.curve, data: sel("graduated()"), result: "0x" + word(1) },
    lensRule(c.token, (hex) => setWord(hex, 0, word(3))),
  ]) });
  await expect(p.locator("#status"), "the page's status rule is not the lens's")
    .toHaveText("Graduated", { timeout: 30_000 });
  await expect(p.locator("#readmsg")).not.toContainText("the chain says");
  await p.close();
});

// ------------------------------------------------------------ S22
test("a rate-limit answer to the graduation check is not a revert and opens no rescue", async () => {
  const c = await ensureCreated();
  const graduator = addrOf(await ethCall(APP.factory, sel("graduator()")));
  const p = await openApp(OWNER, { token: c.token });
  await expect(p.locator("#status")).toHaveText("Selling", { timeout: 30_000 });
  await drawnFor(p, c.token);
  await expect(p.locator("#rescueBox")).toBeHidden();
  // THE NODE ANSWERS, AND THE ANSWER IS ABOUT THE NODE: the shape a public
  // endpoint uses for "over rate limit".
  const graduate = (sel("graduate(address)") + pad(c.token)).toLowerCase();
  await p.route("**/*", async (route) => {
    const req = route.request();
    let m = null;
    try { m = JSON.parse(req.postData() || ""); } catch { m = null; }
    const call = m && m.method === "eth_call" && m.params && m.params[0];
    if (call && String(call.to || "").toLowerCase() === graduator.toLowerCase() &&
        String(call.data || call.input || "").toLowerCase() === graduate) {
      return route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32016, message: "over rate limit" } }) });
    }
    return route.continue();
  });
  const said = await p.evaluate(() => window.CurbApp.completeGraduation().then(() => "sent", (e) => e.message));
  expect(said, "a rate limit was reported as a revert").toContain("could not be checked");
  await expect(p.locator("#rescueBox"), "a rate limit opened the rescue").toBeHidden();
  expect(await p.evaluate(() => window.ethereum.sent.length)).toBe(0);
  await p.close();
});

test("a rescue for a launch the form has left while its check was out is not shown on the next one", async () => {
  const c = await ensureCreated();
  const pb = await openApp(OWNER);
  const b = await createdLaunch(pb, "Rescue Moved", "RSCM");
  await pb.close();
  const fb = await launchFacts(b.token);
  const graduator = addrOf(await ethCall(APP.factory, sel("graduator()")));

  const p = await openApp(OWNER, { token: c.token });
  await expect(p.locator("#status")).toHaveText("Selling", { timeout: 30_000 });
  await drawnFor(p, c.token);
  // THE SIMULATION FOR c IS HELD until the form has moved to b. It then comes
  // back a real revert - c is still selling - which is about c, not b.
  // AND b IS MADE TO LOOK WAITING - the lens and the curve both say so, as in
  // the S22 test above - so the "Complete the move" section the box sits in is
  // DRAWN. On a selling b that section is hidden, and the box inside it read as
  // hidden whatever the page did to it (round 5, N10).
  // THE HELD REQUEST IS KEPT, NOT SLEPT ON: the handler returns at once and the
  // request is continued later, so nothing else waits behind it.
  const graduate = (sel("graduate(address)") + pad(c.token)).toLowerCase();
  const lensB = lensData(b.token);
  const readyB = sel("readyToGraduate()").toLowerCase();
  const answerWith = (route, id, result) => route.fulfill({ status: 200, contentType: "application/json",
    body: JSON.stringify({ jsonrpc: "2.0", id, result }) });
  let held = null;
  await p.route("**/*", async (route) => {
    const req = route.request();
    let m = null;
    try { m = JSON.parse(req.postData() || ""); } catch { m = null; }
    const call = m && m.method === "eth_call" && m.params && m.params[0];
    if (!call) return route.continue();
    const to = String(call.to || "").toLowerCase();
    const data = String(call.data || call.input || "").toLowerCase();
    if (to === graduator.toLowerCase() && data === graduate && !held) { held = route; return; }
    if (to === APP.lens.toLowerCase() && data.startsWith(lensB)) {
      const payload = await (await route.fetch()).json();
      if (payload.error) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
      }
      return answerWith(route, m.id, setWord(payload.result || "0x", 0, word(2)));
    }
    if (to === fb.curve.toLowerCase() && data.startsWith(readyB)) return answerWith(route, m.id, "0x" + word(1));
    return route.continue();
  });
  const done = p.evaluate(() => window.CurbApp.completeGraduation().then(() => "sent", (e) => e.message));
  await expect.poll(() => !!held, { timeout: 30_000, message: "the graduation check was never asked" }).toBe(true);
  await p.fill("#token", b.token);
  await p.dispatchEvent("#token", "change");
  await expect(p.locator("#status")).toHaveText("Waiting", { timeout: 30_000 });
  await expect(p.locator("#waitBox"), "the section the box sits in is not drawn, so the box cannot be seen either way")
    .toBeVisible();
  await held.continue();
  expect(await done).toContain("Completing the move would revert");
  // THE BOX'S OWN STATE, and what a person sees: its parent is drawn now.
  expect(await p.evaluate(() => document.getElementById("rescueBox").hidden),
    "the rescue for one launch opened on the launch the form moved to").toBe(true);
  await expect(p.locator("#rescueBox")).toBeHidden();

  // THE CONTROL: a revert for the launch now on screen opens the same box, and
  // this same locator sees it - so its absence above is the page's doing.
  await drawnFor(p, b.token);
  expect(await p.evaluate(() => window.CurbApp.completeGraduation().then(() => "sent", (e) => e.message)))
    .toContain("Completing the move would revert");
  await expect(p.locator("#rescueBox"), "the box cannot be seen here at all, so its absence above proves nothing")
    .toBeVisible();
  await p.close();
});

// ------------------------------------------------------------ S47
test("a create record of another chain at this endpoint does not hold the automatic switch", async () => {
  const w = await ensureWethLaunch();
  // THIS ENDPOINT, the same factory address, ANOTHER chain id: what a local
  // node restarted on another chain leaves behind. resumePending keeps it as
  // sent elsewhere, so it never clears itself.
  const other = createRecord(fake("f3"), { chainId: "0x1", from: OWNER });
  const p = await openApp(OWNER, { plant: [other], token: w.token });
  await expect.poll(() => p.evaluate(() => window.CurbApp.state.chainCfg.factory.toLowerCase()),
    { timeout: 30_000, message: "a create record of another chain held the page on the wrong asset" })
    .toBe(w.factory.toLowerCase());
  await p.close();
});

// ============================================================ round 5, the send paths and the create form
//
// Each fails with its fix removed:
//   - a trade is held to the launch DRAWN, not to a token the form moved to
//     while its read was out, nor to one whose read landed while its quote is
//     still being drawn (N05)
//   - a curve trade needs a curve that is still selling, a pool trade a launch
//     that has graduated, and completing the move one not graduated yet (N18)
//   - what is sold or paid is held before any approval for it, on a curve sale
//     and on both sides of a pool trade (N20)
//   - a claim asks the claimant's receiving side and the payer's sending side
//     of the issuer's policy, and only those (N19)
//   - a sweep is simulated first; a revert names the rescue and a rate limit
//     is not a revert (N21)
//   - a launch fee or a dev buy ceiling that cannot be read refuses the create,
//     a rate limit included (N17)
//   - launch() is simulated before the wrap and the approval, and again, exactly,
//     after them and before it is sent (N55)
//   - a comma in the share field refuses the create, whatever was typed before
//     it, and only while the field still holds it (S02); in "% of supply" mode
//     the lines that would name the amount name the share field (S24)

/// COUNTS WHAT THE WALLET WAS ASKED TO SEND, including a send the node then
/// refuses. `sent` lists only what the node took - a launch that fails its own
/// estimation never appears there - so "nothing reached the wallet" is read
/// from here.
async function countAsks(p) {
  await p.evaluate(() => {
    window.__asked = [];
    window.ethereum.cfg.onSend = (tx) => { window.__asked.push({ to: tx.to, data: tx.data }); };
  });
  return () => p.evaluate(() => window.__asked);
}

let graduated = null;
/// A LAUNCH TAKEN ALL THE WAY TO ITS POOL through the page: created, bought past
/// its threshold, and moved - the steps app.spec.js takes, from OWNER, who is
/// funded with 2,000 NVDAc by demo-app.sh.
async function ensureGraduated() {
  if (graduated) return graduated;
  const p = await openApp(OWNER);
  try {
    const g = await createdLaunch(p, "Records Pool", "RPOL");
    await p.selectOption("#curveSide", "buy");
    await p.fill("#curveAmount", "70");
    await p.evaluate(() => window.CurbApp.refresh(true));
    await expect(p.locator("#curveAct")).toBeEnabled({ timeout: 20_000 });
    const bought = await attempt(p, () => p.click("#curveAct"));
    expect(bought.text, "the buy past the threshold did not complete").toContain("Done");
    await p.evaluate(() => window.CurbApp.refresh(true));
    await expect(p.locator("#status")).toHaveText("Waiting", { timeout: 20_000 });
    const moved = await attempt(p, () => p.click("#complete"));
    expect(moved.text, "the move into the pool did not complete").toContain("graduated in");
    await p.evaluate(() => window.CurbApp.refresh(true));
    await expect(p.locator("#status")).toHaveText("Graduated", { timeout: 20_000 });
    graduated = g;
  } finally {
    await p.close();
  }
  return graduated;
}

// ------------------------------------------------------------ N05
test("a trade is held to the launch on screen: one entered while its read is out is refused, and goes once drawn", async () => {
  const c = await ensureCreated();
  const pb = await openApp(OWNER);
  const b = await createdLaunch(pb, "Pinned Other", "PINO");
  await pb.close();
  const [fc, fb] = [await launchFacts(c.token), await launchFacts(b.token)];

  const p = await openApp(TRADER, { token: c.token });
  await expect(p.locator("#status")).toHaveText("Selling", { timeout: 30_000 });
  await p.selectOption("#curveSide", "buy");
  await p.fill("#curveAmount", "1");
  await p.evaluate(() => window.CurbApp.refresh(true));
  await expect(p.locator("#curveAct")).toBeEnabled({ timeout: 20_000 });

  // b IS PASTED IN, AND ITS READ IS HELD - kept, not slept on, so nothing else
  // waits behind it - while c's numbers and c's enabled button stay drawn:
  // the moment between a blur's `change` and the click that follows it.
  // AND b's FIRST QUOTE IS HELD TOO, for the second press below: the first
  // feeBps() asked of b's curve is the one its first drawing asks.
  const lensB = lensData(b.token);
  const feeB = sel("feeBps()").toLowerCase();
  let held = null;
  let heldQuote = null;
  await p.route("**/*", async (route) => {
    let m = null;
    try { m = JSON.parse(route.request().postData() || ""); } catch { m = null; }
    const call = m && m.method === "eth_call" && m.params && m.params[0];
    const to = call ? String(call.to || "").toLowerCase() : "";
    const data = call ? String(call.data || call.input || "").toLowerCase() : "";
    if (call && !held && to === APP.lens.toLowerCase() && data.startsWith(lensB)) { held = route; return; }
    if (call && !heldQuote && to === fb.curve.toLowerCase() && data.startsWith(feeB)) { heldQuote = route; return; }
    return route.continue();
  });
  await p.fill("#token", b.token);
  await p.dispatchEvent("#token", "change");
  await expect.poll(() => !!held, { timeout: 30_000, message: "the new launch's read was never asked" }).toBe(true);
  expect(await p.evaluate(() => window.CurbApp.state.view.curve.toLowerCase()), "c is not the launch on screen")
    .toBe(fc.curve);
  await expect(p.locator("#curveAct")).toBeEnabled();

  const r = await attempt(p, () => p.click("#curveAct"));
  expect(r.text, "a trade was built for a launch whose numbers were never drawn")
    .toContain("still loading the launch you entered");
  expect(r.sent, "a trade went to the launch in the field rather than the one on screen").toBe(0);

  // ---- b's READ HAS LANDED AND ITS QUOTE HAS NOT. The refresh after that
  // refusal reads b and starts drawing it: the status and the curve are b's,
  // while the tax, the expected out and the minimum under the button - enabled
  // again when the refused action ended - are still c's.
  await expect.poll(() => !!heldQuote, { timeout: 30_000, message: "b's quote was never asked" }).toBe(true);
  expect(await p.evaluate(() => window.CurbApp.state.view.curve.toLowerCase()), "b's read has not landed")
    .toBe(fb.curve);
  await expect(p.locator("#curveAct")).toBeEnabled();
  const r2 = await attempt(p, () => p.click("#curveAct"));
  expect(r2.text, "a trade was built for b while the rows under the button were c's")
    .toContain("still loading the launch you entered");
  expect(r2.sent, "a trade went out on a quote that was never drawn").toBe(0);
  await heldQuote.continue();
  await held.continue();
  await p.unroute("**/*");

  // THE CONTROL: once b is drawn - its quote too - the same press trades b.
  await expect.poll(() => p.evaluate(() => ((window.CurbApp.state.viewFor || {}).token || "").toLowerCase()),
    { timeout: 30_000, message: "b was never drawn" }).toBe(b.token.toLowerCase());
  expect(await p.evaluate(() => window.CurbApp.state.view.curve.toLowerCase())).toBe(fb.curve);
  await expect(p.locator("#curveAct")).toBeEnabled({ timeout: 20_000 });
  const ok = await attempt(p, () => p.click("#curveAct"));
  expect(ok.text, "the drawn launch could not be traded, so the refusal above proves nothing").toContain("Done");
  await p.close();
});

// ------------------------------------------------------------ N18
test("a sell pressed after the curve closed is refused before its approval", async () => {
  const c = await ensureCreated();
  const f = await launchFacts(c.token);
  const p = await openApp(TRADER, { token: c.token });
  await expect(p.locator("#status")).toHaveText("Selling", { timeout: 30_000 });
  await p.selectOption("#curveSide", "sell");
  await p.fill("#curveAmount", "1");
  await p.evaluate(() => window.CurbApp.refresh(true));
  await expect(p.locator("#curveAct")).toBeEnabled({ timeout: 20_000 });

  // ANOTHER BUYER CROSSES THE THRESHOLD after the draw: the lens and the curve
  // now both say Waiting, so beginAction's check that they agree passes.
  await onCalls(p, [
    lensRule(c.token, (hex) => setWord(hex, 0, word(2))),
    { to: f.curve, data: sel("readyToGraduate()"), result: "0x" + word(1) },
  ]);
  const r = await attempt(p, () => p.click("#curveAct"));
  expect(r.text, "a sell was prepared on a curve that no longer sells").toContain("reached its threshold since the page drew it");
  expect(r.sent, "an approval or a sell went out on a closed curve").toBe(0);
  await p.close();
});

test("a pool trade on a launch that has not graduated is refused before anything else", async () => {
  const c = await ensureCreated();
  const p = await openApp(TRADER, { token: c.token });
  await expect(p.locator("#status")).toHaveText("Selling", { timeout: 30_000 });
  await drawnFor(p, c.token);
  // AS FROM A PAGE THAT DREW IT GRADUATED: the pool panel is hidden on a
  // selling launch, so its fields are set and its handler called straight.
  await p.evaluate(() => {
    document.getElementById("poolSide").value = "buy";
    document.getElementById("poolAmount").value = "1";
  });
  const said = await p.evaluate(() => window.CurbApp.poolAction().then(() => "sent", (e) => e.message));
  expect(said).toContain("has not graduated, so it has no pool to trade in yet");
  expect(await p.evaluate(() => window.ethereum.sent.length)).toBe(0);
  await p.close();
});

/// THE RESCUE OPENS TO A STRANGER AN HOUR AFTER THE LAUNCH IS NOTED STUCK
/// (Graduator.noteReady, re-review item 12), not the moment the curve is full.
/// A real Waiting launch - bought past its threshold, not moved - and a
/// stranger's two presses of "Rescue the curve's fees": the first is refused
/// by the graduator's simulation, so the page sends the note instead, as its
/// one send, and says when the rescue opens; the second is refused naming that
/// time, and sends nothing. The note is read back from the graduator.
test("a stranger's first rescue press notes the launch stuck and says when it opens, and the second sends nothing", async () => {
  test.setTimeout(150_000);
  const po = await openApp(OWNER);
  let w;
  try {
    w = await createdLaunch(po, "Records Stuck", "RSTK");
    await po.selectOption("#curveSide", "buy");
    await po.fill("#curveAmount", "70");
    await po.evaluate(() => window.CurbApp.refresh(true));
    await expect(po.locator("#curveAct")).toBeEnabled({ timeout: 20_000 });
    const bought = await attempt(po, () => po.click("#curveAct"));
    expect(bought.text, "the buy past the threshold did not complete").toContain("Done");
  } finally {
    await po.close();
  }
  const graduator = addrOf(await ethCall(APP.factory, sel("graduator()")));
  const readySince = async () => BigInt(await ethCall(graduator, sel("readySince(address)") + pad(w.token)));
  expect(await readySince(), "the launch was noted before anybody pressed").toBe(0n);

  const p = await openApp(TRADER, { token: w.token });
  await expect(p.locator("#status")).toHaveText("Waiting", { timeout: 30_000 });
  await drawnFor(p, w.token);
  const press = () => attempt(p, () => p.evaluate(() => {
    document.getElementById("rescueBox").hidden = false;
    const b = document.getElementById("rescue"); b.disabled = false; b.click();
  }));
  const first = await press();
  expect(first.text, "the first press did not note the launch").toContain("Noted as stuck");
  expect(first.text).toContain("Nothing was rescued yet");
  const since = await readySince();
  expect(since, "the note did not reach the graduator").toBeGreaterThan(0n);
  const opens = new Date(Number(since + 3600n) * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  expect(first.text, "the page did not say when the rescue opens, from the graduator's own note").toContain(opens);
  expect(first.sent, "the note was not the press's one send").toBe(1);

  const second = await press();
  expect(second.text, "the second press was not refused").toContain("it opens at " + opens);
  expect(second.text).toContain("is neither this curve's creator-fee recipient nor the platform's recipient");
  expect(second.sent, "the second press sent something").toBe(0);
  expect(await readySince(), "the second press moved the note").toBe(since);
  await p.close();
});

test("a move pressed after somebody else completed it is refused, and offers no rescue", async () => {
  const g = await ensureGraduated();
  const p = await openApp(TRADER, { token: g.token });
  await expect(p.locator("#status")).toHaveText("Graduated", { timeout: 30_000 });
  await drawnFor(p, g.token);
  // AS FROM A PAGE THAT DREW IT WAITING: the handler, called straight.
  const said = await p.evaluate(() => window.CurbApp.completeGraduation().then(() => "sent", (e) => e.message));
  expect(said, "a graduated launch's move was simulated and its revert blamed on the escrow")
    .toContain("already completed its move into the pool");
  expect(said).not.toContain("Rescue the curve's fees");
  // THE BOX'S OWN STATE: it sits in the "Complete the move" section, hidden on a
  // graduated launch, so only the property says whether the page opened it. The
  // rescue tests above see this same property turn false on a real revert.
  expect(await p.evaluate(() => document.getElementById("rescueBox").hidden), "the rescue was offered").toBe(true);
  expect(await p.evaluate(() => window.ethereum.sent.length)).toBe(0);
  await p.close();
});

// ------------------------------------------------------------ N20
test("a curve sale of more than the account holds is refused before its approval", async () => {
  const c = await ensureCreated();
  const p = await openApp(TRADER, { token: c.token, before: (pg) => onCalls(pg, [
    { to: c.token, data: sel("balanceOf(address)") + pad(TRADER), result: "0x" + word(0) },
  ]) });
  await expect(p.locator("#status")).toHaveText("Selling", { timeout: 30_000 });
  await p.selectOption("#curveSide", "sell");
  await p.fill("#curveAmount", "1");
  await p.evaluate(() => window.CurbApp.refresh(true));
  await expect(p.locator("#curveAct")).toBeEnabled({ timeout: 20_000 });
  const r = await attempt(p, () => p.click("#curveAct"));
  expect(r.text, "the refusal does not give the numbers").toContain("This sale needs 1 tokens, and this account holds 0 tokens");
  expect(r.sent, "an approval went out for tokens the account does not hold").toBe(0);
  await p.close();
});

test("a pool trade of more than the account holds is refused before either approval, on both sides", async () => {
  const g = await ensureGraduated();
  const quote = addrOf(await ethCall(APP.factory, sel("quoteToken()")));
  const p = await openApp(TRADER, { token: g.token, before: (pg) => onCalls(pg, [
    { to: g.token, data: sel("balanceOf(address)") + pad(TRADER), result: "0x" + word(0) },
    { to: quote, data: sel("balanceOf(address)") + pad(TRADER), result: "0x" + word(0) },
  ]) });
  await expect(p.locator("#status")).toHaveText("Graduated", { timeout: 30_000 });
  for (const [side, amount, needs] of [["sell", "1", "This sale needs"], ["buy", "0.01", "This buy needs"]]) {
    await p.selectOption("#poolSide", side);
    await p.selectOption("#poolVia", "nvdac");
    await p.fill("#poolAmount", amount);
    await p.evaluate(() => window.CurbApp.refresh(true));
    await expect(p.locator("#poolAct"), side + ": the pool never priced the trade").toBeEnabled({ timeout: 30_000 });
    const r = await attempt(p, () => p.click("#poolAct"));
    expect(r.text, side + ": the refusal does not give the numbers").toContain(needs);
    expect(r.text).toContain("this account holds 0");
    expect(r.sent, side + ": an approval went out for what the account does not hold").toBe(0);
  }
  await p.close();
});

// ------------------------------------------------------------ N19
test("a claim asks the claimant's receiving side and the payer's sending side of the policy, and nothing else", async () => {
  const quote = addrOf(await ethCall(APP.factory, sel("quoteToken()")));
  const escrow = addrOf(await ethCall(APP.factory, sel("feeEscrow()")));
  const registry = addrOf(await ethCall(APP.factory, sel("registry()")));
  const hook = addrOf(await ethCall(registry, sel("requiredHook()")));
  const REG = "0x8453000000000000000000000000000000000002";
  // SOMETHING OWED FROM BOTH PAYERS, so each button's state is the policy's.
  const owed = [
    { to: escrow, data: sel("balanceOfToken(address,address)") + pad(TRADER) + pad(quote), result: "0x" + word(3n * 10n ** 8n) },
    { to: hook, data: sel("owed(address,address)") + pad(TRADER) + pad(quote), result: "0x" + word(3n * 10n ** 8n) },
  ];
  // THE SENDING SIDE GETS A POLICY OF ITS OWN (77), which blocks `blocked`; the
  // receiving side keeps the asset's real one. Today both scopes map to one
  // policy (B20Restrictions.t.sol), so only a split makes the direction matter.
  const scope = "5e".repeat(32);
  const auth = (id, who) => sel("isAuthorized(uint64,address)") + word(id) + (who ? pad(who) : "");
  const sendersBlocked = (...blocked) => [
    { to: quote, data: sel("TRANSFER_SENDER_POLICY()"), result: "0x" + scope },
    { to: quote, data: sel("policyId(bytes32)") + scope, result: "0x" + word(77) },
    ...blocked.map((who) => ({ to: REG, data: auth(77, who), result: "0x" + word(0) })),
    { to: REG, data: auth(77), result: "0x" + word(1) },
  ];

  // ---- THE CLAIMANT FROZEN FOR SENDING ONLY: a claim, which he only receives, goes.
  const p = await openApp(TRADER, { before: (pg) => onCalls(pg, [...owed, ...sendersBlocked(TRADER)]) });
  // The trade view still calls him restricted - a trade sends too - which is
  // also how this test knows the split reached the page.
  await expect(p.locator("#policyRow")).toContainText("RESTRICTED", { timeout: 30_000 });
  await expect(p.locator("#claimEscrow"), "a claim the issuer allows is not offered").toBeEnabled({ timeout: 30_000 });
  await expect(p.locator("#claimHook")).toBeEnabled();
  const asks = await countAsks(p);
  const r = await attempt(p, () => p.evaluate(() => document.getElementById("claimEscrow").onclick()));
  expect(r.text, "a claim was refused over the claimant's SENDING side").not.toContain("restricted this account");
  expect((await asks()).length, "the claim never reached the wallet").toBe(1);

  // ---- THE ESCROW BLOCKED FROM SENDING: its claim is refused, the hook's is not.
  await p.unroute("**/*");
  await onCalls(p, [...owed, ...sendersBlocked(escrow)]);
  await p.evaluate(() => window.CurbApp.refresh(true));
  await expect(p.locator("#policyRow")).not.toContainText("RESTRICTED", { timeout: 30_000 });
  await expect(p.locator("#claimEscrow"), "a claim from an escrow the issuer blocks is offered")
    .toBeDisabled({ timeout: 30_000 });
  await expect(p.locator("#claimHook"), "the hook, which may send, lost its claim too").toBeEnabled();
  await expect(p.locator("#owedNote")).toContainText("blocks the fee escrow from sending");
  const r2 = await attempt(p, () => p.evaluate(() => document.getElementById("claimEscrow").onclick()));
  expect(r2.text, "a claim from a blocked escrow was not refused").toContain("blocks the fee escrow at");
  expect((await asks()).length, "a claim from a blocked escrow reached the wallet").toBe(1);
  await p.close();
});

// ------------------------------------------------------------ N21
test("a sweep that would revert is refused naming the rescue, and a check nobody answered sends nothing", async () => {
  const c = await ensureCreated();
  const f = await launchFacts(c.token);
  // SOMETHING ON THE CURVE for its creator (OWNER made c), and the sweep's
  // simulation answered by the rule - the send itself is not an eth_call.
  const rules = (error) => [
    { to: f.curve, data: sel("creatorTaxBalance()"), result: "0x" + word(1000) },
    { to: f.curve, data: sel("sweepFees(uint256)") + word(0), error },
  ];
  const p = await openApp(OWNER, { token: c.token,
    before: (pg) => onCalls(pg, rules({ code: 3, message: "execution reverted", data: "0xa43fec12" })) });
  await expect(p.locator("#status")).toHaveText("Selling", { timeout: 30_000 });
  await drawnFor(p, c.token);
  await expect(p.locator("#sweepCurve"), "the creator is not offered the sweep at all").toBeEnabled({ timeout: 30_000 });
  const r = await attempt(p, () => p.evaluate(() => document.getElementById("sweepCurve").onclick()));
  expect(r.text, "a sweep that must revert was not refused").toContain("Sweeping would revert");
  expect(r.text, "the way out is not named").toContain("rescueCurveFees");
  expect(r.sent, "a sweep that must revert was sent").toBe(0);

  // A RATE LIMIT IS NOT A REVERT: refused as unchecked, and still nothing sent.
  await p.unroute("**/*");
  await onCalls(p, rules({ code: -32016, message: "over rate limit" }));
  const r2 = await attempt(p, () => p.evaluate(() => document.getElementById("sweepCurve").onclick()));
  expect(r2.text, "a rate limit was reported as a revert").toContain("could not be checked");
  expect(r2.sent).toBe(0);
  await p.close();
});

// ------------------------------------------------------------ N17
test("a dev buy ceiling that cannot be read refuses the create, a rate limit included", async () => {
  const p = await openApp(OWNER);
  // THE FACTORY'S TERMS ARE READ AND CACHED FIRST, so what fails below is the
  // create's own fresh read and nothing else.
  await expect(p.locator("#sumGrad")).not.toHaveText("—", { timeout: 30_000 });
  const asks = await countAsks(p);
  const rateLimited = { code: -32016, message: "over rate limit" };
  await p.fill("#nName", "Fee Unread");
  await p.fill("#nSymbol", "FEEU");
  await onCalls(p, [{ to: APP.factory, data: sel("MAX_DEV_BUY_BPS()"), error: rateLimited }]);
  await p.fill("#nDevBuy", "1");
  const r2 = await attempt(p, () => p.click("#create"));
  expect(r2.text, "a rate-limited ceiling was taken for no ceiling").toContain("dev buy ceiling could not be read");
  expect((await asks()).length, "something was sent on a ceiling nobody read").toBe(0);

  // A REVERT THAT CARRIES A REASON is the factory refusing, not a factory
  // without the term: the card does not read it as "absent", and neither does
  // the send (lacksFunction, round 5 N06). It used to be "no ceiling" here
  // while the card refused the same answer.
  const withReason = { code: 3, message: "execution reverted: custom error", data: "0x12345678" };
  await p.unroute("**/*");
  await onCalls(p, [{ to: APP.factory, data: sel("MAX_DEV_BUY_BPS()"), error: withReason }]);
  const r3 = await attempt(p, () => p.click("#create"));
  expect(r3.text, "a ceiling refused with a reason was taken for no ceiling").toContain("dev buy ceiling could not be read");
  expect((await asks()).length, "something was sent on a ceiling refused with a reason").toBe(0);
  await p.unroute("**/*");
  await p.close();
});

// ------------------------------------------------------------ no launch fee
test("launching costs gas only: the factory charges nothing and the create carries no ether", async () => {
  // THE DEPLOYMENT'S OWN FIGURE, read off the chain: DeployCurb built this
  // factory, so a fee put back in the script shows here.
  expect(BigInt(await ethCall(APP.factory, sel("launchFee()"))), "the deployed factory charges a launch fee").toBe(0n);
  const p = await openApp(OWNER);
  await expect(p.locator("#sumGrad")).not.toHaveText("—", { timeout: 30_000 });
  await expect(p.locator("#sumLaunchFee"), "the card still has a launch fee row").toHaveCount(0);
  await expect(p.locator("#sumLock")).toHaveText("Locked forever");
  // WHAT THE PAGE ASKS THE NODE AND THE WALLET, with ether or without. The
  // wallet refuses the send, so nothing is created.
  const valued = [];
  p.on("request", (req) => {
    let m = null;
    try { m = JSON.parse(req.postData() || ""); } catch { m = null; }
    const call = m && (m.method === "eth_call" || m.method === "eth_estimateGas") && m.params && m.params[0];
    if (call && String(call.to || "").toLowerCase() === APP.factory.toLowerCase() && call.value && BigInt(call.value) !== 0n) {
      valued.push(call.value);
    }
  });
  await p.evaluate(() => {
    window.__sent = [];
    window.ethereum.cfg.onSend = (tx) => { window.__sent.push({ to: tx.to, data: tx.data, value: tx.value || null }); };
    window.ethereum.cfg.sendError = Object.assign(new Error("User rejected the request."), { code: 4001 });
  });
  await p.fill("#nName", "Free Launch");
  await p.fill("#nSymbol", "FREE");
  await attempt(p, () => p.click("#create"));
  const sent = await p.evaluate(() => window.__sent);
  await p.evaluate(() => { window.ethereum.cfg.onSend = null; window.ethereum.cfg.sendError = null; });
  const launches = sent.filter((t) => String(t.to || "").toLowerCase() === APP.factory.toLowerCase());
  expect(launches.length, "the create was never asked of the wallet").toBe(1);
  expect(launches[0].value === null || BigInt(launches[0].value) === 0n, "the create carried ether: " + launches[0].value).toBe(true);
  expect(valued, "the create was simulated with ether").toEqual([]);
  await p.close();
});

// ------------------------------------------------------------ N55
test("launch() is simulated before the wrap and the approval, and exactly again before it is sent", async () => {
  const escrow = addrOf(await ethCall(APP.factory, sel("feeEscrow()")));
  const p = await openApp(OWNER);
  await expect(p.locator("#sumGrad")).not.toHaveText("—", { timeout: 30_000 });
  const asks = await countAsks(p);

  // ---- A CREATOR WALLET PASTED WRONG: the escrow, copied off this page.
  // THE FIELD IS BEHIND THE "Advanced" DISCLOSURE, and fill() waits for ever on
  // a field that is not shown - so the disclosure is opened as a person would.
  const advanced = p.locator("#advanced");
  if (!(await advanced.evaluate((d) => d.open))) await advanced.locator("summary").click();
  await expect(p.locator("#nCreator")).toBeVisible();
  await p.fill("#nName", "Escrow Creator");
  await p.fill("#nSymbol", "ESCR");
  await p.fill("#nCreator", escrow);
  await p.fill("#nDevBuy", "1");
  const r = await attempt(p, () => p.click("#create"));
  expect(r.text, "the factory's refusal was not predicted").toContain("The factory would refuse this launch");
  expect(r.text, "the refusal is not said in the factory's terms").toContain("one of this deployment's own contracts");
  expect(await asks(), "a wrap, an approval or the launch was asked for a launch that must revert").toEqual([]);

  // ---- WHAT ONLY THE EXACT TRANSACTION CAN SHOW, after its approval: the
  // launch WITH its first buy is made to revert (the dev-buy-free copy is not).
  await p.fill("#nCreator", "");
  const launchSel = sel("launch((string,string,string,bytes32,address,uint16,uint256,address,uint16,address,address))").toLowerCase();
  // THE FIRST BUY IS WORD 7 AFTER THE SELECTOR: the tuple's offset, then name,
  // symbol, uri, salt, refund, tax - then devBuy.
  const devBuyOf = (data) => BigInt("0x" + (data.slice(10 + 7 * 64, 10 + 8 * 64) || "0"));
  let exactAsked = 0;
  await p.route("**/*", async (route) => {
    let m = null;
    try { m = JSON.parse(route.request().postData() || ""); } catch { m = null; }
    const call = m && m.method === "eth_call" && m.params && m.params[0];
    const data = call ? String(call.data || call.input || "").toLowerCase() : "";
    if (call && String(call.to || "").toLowerCase() === APP.factory.toLowerCase() && data.startsWith(launchSel) &&
        devBuyOf(data) !== 0n) {
      exactAsked += 1;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        jsonrpc: "2.0", id: m.id, error: { code: 3, message: "execution reverted: the pull was refused" } }) });
    }
    return route.continue();
  });
  const r2 = await attempt(p, () => p.click("#create"));
  expect(exactAsked, "the exact launch was never simulated").toBeGreaterThan(0);
  expect(r2.text, "a launch that must revert was not refused").toContain("The factory would refuse this launch");
  const launches = (await asks()).filter((t) => (t.data || "").toLowerCase().startsWith(launchSel));
  expect(launches, "the launch was sent although its simulation reverted").toEqual([]);
  await p.unroute("**/*");
  await p.close();
});

// ------------------------------------------------------------ S02 / S24
test("a comma in the share field refuses the create: no amount from an earlier keystroke is sent", async () => {
  const p = await openApp(TRADER);
  await expect(p.locator("#sumGrad")).not.toHaveText("—", { timeout: 30_000 });
  await p.click('#devMode [data-mode="pct"]');
  await p.fill("#nDevPct", "");
  await p.locator("#nDevPct").pressSequentially("1");
  // THE CONTROL: a share is turned into an amount the card prices.
  await expect(p.locator("#devBuyOut")).toContainText("of the supply");
  expect(await p.locator("#nDevBuy").inputValue(), "the share wrote no amount").not.toBe("");

  await p.locator("#nDevPct").pressSequentially(",5");
  expect(await p.locator("#nDevPct").inputValue(), "the comma was dropped or rewritten").toBe("1,5");
  await expect(p.locator("#devBuyOut")).toContainText("Use a point for decimals");
  // A KEYSTROKE ANYWHERE ELSE REDRAWS THE CARD, and the refusal is still what it says.
  await p.fill("#nName", "Share Comma");
  await p.fill("#nSymbol", "SHCM");
  await expect(p.locator("#devBuyOut"), "the card priced the amount from before the comma")
    .toContainText("Use a point for decimals");
  await expect(p.locator("#sumDevBuy")).toHaveText("—");
  const asks = await countAsks(p);
  const r = await attempt(p, () => p.click("#create"));
  expect(r.text, "the create went ahead on the amount from before the comma").toContain("Use a point for decimals");
  expect(await asks(), "something was sent").toEqual([]);

  // ---- AND THE REFUSAL GOES WITH WHAT IT WAS ABOUT. "Amount" and back redraws
  // the share field from the amount, which is empty: the comma is gone from
  // the screen, so its refusal must go from the card and from Create too. The
  // wallet declines, so the create that now reaches it sends nothing.
  await p.click('#devMode [data-mode="amount"]');
  await p.click('#devMode [data-mode="pct"]');
  await expect(p.locator("#nDevPct"), "the share field kept the comma").toHaveValue("");
  await expect(p.locator("#devBuyOut"), "the card kept a refusal about a comma no longer there")
    .toContainText("No dev buy");
  await p.evaluate(() => {
    window.ethereum.cfg.sendError = Object.assign(new Error("User rejected the request."), { code: 4001 });
  });
  const r2 = await attempt(p, () => p.click("#create"));
  expect(r2.text, "Create refused over a comma the share field no longer holds").not.toContain("Use a point");
  expect(r2.text).toContain("you declined");
  expect((await asks()).length, "the create never reached the wallet").toBe(1);
  await p.close();
});

test("in % of supply mode an amount this asset cannot take is said about the share field, on the card and at send", async () => {
  const p = await openApp(TRADER);
  await expect(p.locator("#sumGrad")).not.toHaveText("—", { timeout: 30_000 });
  await p.click('#devMode [data-mode="pct"]');
  await expect(p.locator("#nDevBuy"), "the amount field is on screen in % mode").toBeHidden();

  // WHAT A CHANGE OF ASSET LEAVES IN THE HIDDEN AMOUNT FIELD, written without an
  // input event as that change writes it: past this asset's ceiling of 45 ...
  await p.evaluate(() => { document.getElementById("nDevBuy").value = "46"; });
  await p.evaluate(() => window.CurbApp.refresh(true));
  await expect(p.locator("#devBuyOut")).toContainText("share field");
  await expect(p.locator("#devBuyOut"), "the line talks about a field that is not on screen").not.toContainText("Lower it");
  await expect(p.locator("#sumDevBuy")).toHaveText("above the ceiling");
  let said = await p.evaluate(() => window.CurbApp.createLaunch().then(() => "sent", (e) => e.message));
  expect(said, "the send's refusal talks about the hidden amount").toContain("share field");

  // ... and finer than its 8 decimals.
  await p.evaluate(() => { document.getElementById("nDevBuy").value = "1.123456789"; });
  await p.evaluate(() => window.CurbApp.refresh(true));
  await expect(p.locator("#devBuyOut")).toContainText("share field");
  await expect(p.locator("#devBuyOut")).not.toContainText("The amount has");
  said = await p.evaluate(() => window.CurbApp.createLaunch().then(() => "sent", (e) => e.message));
  expect(said, "the send's refusal talks about the hidden amount").toContain("share field");

  // THE CONTROL: the same figure in amount mode is said about the amount.
  await p.click('#devMode [data-mode="amount"]');
  await expect(p.locator("#devBuyOut")).toContainText("The amount has more decimal places");
  expect(await p.evaluate(() => window.ethereum.sent.length)).toBe(0);
  await p.close();
});

// ============================================================ round 5: the reads
/// Changing the factory field to the same factory empties the context cache
/// the way any field change does, and refreshes.
async function refetchFactory(p, factory = APP.factory) {
  await p.fill("#factory", factory);
  await p.dispatchEvent("#factory", "change");
}

// ------------------------------------------------------------ N06 / N11 / S19
test("a factory term the node answers with a rate limit or its own failure is asked again, not cached as zero", async () => {
  const p = await openApp(TRADER);
  await expect(p.locator("#sumGrad")).not.toHaveText("—", { timeout: 30_000 });
  await expect(p.locator("#devBuyCap")).toContainText("20%");
  const readMsg = p.locator("#readmsg");

  // ---- A RATE LIMIT on the ceiling: a JSON-RPC error answer with HTTP 200,
  // which is the shape a public endpoint uses (an HTTP 500 is app.spec.js's).
  await onCalls(p, [{ to: APP.factory, data: sel("MAX_DEV_BUY_BPS()"),
    error: { code: -32005, message: "rate limited" } }]);
  await refetchFactory(p);
  await expect(readMsg, "the failed read was not said").toContainText("rate limited", { timeout: 20_000 });
  expect(await p.evaluate(() => window.CurbApp.state.ctx === null), "a context was built on a rate-limited term")
    .toBe(true);
  await p.unroute("**/*");
  // NOT a field change and NOT the button: a plain refresh, which reads the
  // context from the cache when there is one.
  await p.evaluate(() => window.CurbApp.refresh(true));
  await expect(p.locator("#devBuyCap"), "the rate-limited ceiling was kept as 'no ceiling'").toContainText("20%");
  expect(await p.evaluate(() => window.CurbApp.state.ctx.maxDevBuyBps.toString())).toBe("2000");

  // ---- THE NODE'S OWN FAILURE on the threshold (-32603): not "no threshold".
  await onCalls(p, [{ to: APP.factory, data: sel("graduationThreshold()"),
    error: { code: -32603, message: "internal error" } }]);
  await refetchFactory(p);
  await expect(readMsg).toContainText("internal error", { timeout: 20_000 });
  await p.unroute("**/*");
  await p.evaluate(() => window.CurbApp.refresh(true));
  // NVDAc's threshold: 50 since the re-pricing of 2026-10-15 (49.1 before).
  await expect(p.locator("#sumGrad"), "an internal error was kept as a threshold of 0").toHaveText(/^50 \S/);

  // ---- A REVERT THAT CARRIES DATA is the contract refusing for a reason of
  // its own, not a function it lacks: not "no ceiling" either.
  await onCalls(p, [{ to: APP.factory, data: sel("MAX_DEV_BUY_BPS()"),
    error: { code: 3, message: "execution reverted: custom error", data: "0x12345678" } }]);
  await refetchFactory(p);
  await expect(readMsg).toContainText("custom error", { timeout: 20_000 });
  expect(await p.evaluate(() => window.CurbApp.state.ctx === null), "a refusal with a reason was read as 'absent'")
    .toBe(true);
  await p.unroute("**/*");
  await p.evaluate(() => window.CurbApp.refresh(true));
  await expect(p.locator("#devBuyCap")).toContainText("20%");

  // ---- AN HTTP FAILURE WITH A REVERT IN ITS BODY: a gateway's answer, not the
  // node's, whatever the body says.
  const ceilingData = sel("MAX_DEV_BUY_BPS()").toLowerCase();
  await p.route("**/*", async (route) => {
    let m = null;
    try { m = JSON.parse(route.request().postData() || ""); } catch { m = null; }
    const call = m && m.method === "eth_call" && m.params && m.params[0];
    if (call && String(call.to || "").toLowerCase() === APP.factory.toLowerCase() &&
        String(call.data || call.input || "").toLowerCase().startsWith(ceilingData)) {
      return route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({
        jsonrpc: "2.0", id: m.id, error: { code: 3, message: "execution reverted" } }) });
    }
    return route.continue();
  });
  await refetchFactory(p);
  await expect(readMsg).toContainText("HTTP 502", { timeout: 20_000 });
  await p.unroute("**/*");
  await p.evaluate(() => window.CurbApp.refresh(true));
  await expect(p.locator("#devBuyCap"), "a gateway's 502 was read as a factory without a ceiling")
    .toContainText("20%");

  // ---- A REPLY WITH NEITHER A RESULT NOR AN ERROR: HTTP 200 and valid JSON,
  // but no answer in it. It came back as "no words", which is how a factory
  // without the function reads.
  await p.route("**/*", async (route) => {
    let m = null;
    try { m = JSON.parse(route.request().postData() || ""); } catch { m = null; }
    const call = m && m.method === "eth_call" && m.params && m.params[0];
    if (call && String(call.to || "").toLowerCase() === APP.factory.toLowerCase() &&
        String(call.data || call.input || "").toLowerCase().startsWith(ceilingData)) {
      return route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id: m.id }) });
    }
    return route.continue();
  });
  await refetchFactory(p);
  await expect(readMsg, "an empty reply was not said").toContainText("neither a result nor an error",
    { timeout: 20_000 });
  expect(await p.evaluate(() => window.CurbApp.state.ctx === null), "a context was built on an empty reply")
    .toBe(true);
  await p.unroute("**/*");
  await p.evaluate(() => window.CurbApp.refresh(true));
  await expect(p.locator("#devBuyCap"), "an empty reply was read as a factory without a ceiling")
    .toContainText("20%");

  // ---- THE CONTROL: a REVERT WITH NOTHING IN IT is what a factory without the
  // function answers, and that still reads as "no ceiling of its own": the
  // line then names the graduation threshold, never a share of the supply.
  await onCalls(p, [{ to: APP.factory, data: sel("MAX_DEV_BUY_BPS()"),
    error: { code: 3, message: "execution reverted", data: "0x" } }]);
  await refetchFactory(p);
  await expect(p.locator("#devBuyCap"), "a factory without the function lost its default")
    .toContainText("just under this launch's graduation threshold", { timeout: 20_000 });
  await expect(p.locator("#devBuyCap")).not.toContainText("20%");
  await p.unroute("**/*");
  await refetchFactory(p);
  await expect(p.locator("#devBuyCap")).toContainText("20%", { timeout: 20_000 });
  await p.close();
});

test("a hook or a symbol that did not answer is not kept for the session: WETH is claimed as ETH once it answers", async () => {
  const weth = await wethFactoryAddr();
  const p = await openApp(TRADER);
  await expect(p.locator("#sumGrad")).not.toHaveText("—", { timeout: 30_000 });
  const { hook, quote, quoteSym } = await p.evaluate(() => {
    const c = window.CurbApp.state.ctx;
    return { hook: c.hook, quote: c.quote, quoteSym: c.quoteSym };
  });
  expect(quoteSym, "the fixture's asset answers symbol(), or the symbol half means nothing").not.toMatch(/^0x/);

  // ---- THE HOOK'S WETH() RATE-LIMITED while the WETH factory is read.
  await onCalls(p, [{ to: hook, data: sel("WETH()"), error: { code: -32005, message: "rate limited" } }]);
  await refetchFactory(p, weth);
  await expect(p.locator("#readmsg")).toContainText("rate limited", { timeout: 20_000 });
  await p.unroute("**/*");
  await p.evaluate(() => window.CurbApp.refresh(true));
  await expect(p.locator("#sumPaired")).toHaveText("WETH", { timeout: 20_000 });
  await expect(p.locator("#sumPaidIn"), "one rate-limited reply was kept as 'this hook does not unwrap'")
    .toHaveText("ETH");

  // ---- THE ASSET'S symbol() RATE-LIMITED: shown as the address this once ...
  await refetchFactory(p);
  await expect(p.locator("#sumPaired")).toHaveText(quoteSym, { timeout: 20_000 });
  await onCalls(p, [{ to: quote, data: sel("symbol()"), error: { code: -32005, message: "rate limited" } }]);
  await refetchFactory(p);
  await expect(p.locator("#sumPaired"), "the fallback is not shown, so this proves nothing").toHaveText(/^0x/,
    { timeout: 20_000 });
  // ... and asked again by the next refresh, which a cached context would not.
  await p.unroute("**/*");
  await p.evaluate(() => window.CurbApp.refresh(true));
  await expect(p.locator("#sumPaired"), "the address fallback was cached as the asset's symbol").toHaveText(quoteSym);
  await p.close();
});

test("Refresh reads the factory's terms again rather than redrawing the cached ones", async () => {
  const p = await openApp(TRADER);
  await expect(p.locator("#sumGrad")).not.toHaveText("—", { timeout: 30_000 });
  const before = (await p.locator("#sumSupply").textContent()).trim();
  expect(before, "the fixture already has the supply this test fakes").not.toContain("123");
  await onCalls(p, [{ to: APP.factory, data: sel("supply()"), result: "0x" + word(123n * 10n ** 18n) }]);
  // THE CONTROL: a plain refresh uses the cache, so the new answer is not seen.
  await p.evaluate(() => window.CurbApp.refresh(true));
  await expect(p.locator("#sumSupply"), "the context is not cached, so this proves nothing").toHaveText(before);
  await p.click("#refresh");
  await expect(p.locator("#sumSupply"), "Refresh redrew the cached terms").toHaveText("123",
    { timeout: 20_000 });
  await p.unroute("**/*");
  await p.close();
});

// ------------------------------------------------------------ N07
test("a lens with no code on this endpoint does not keep the last asset's labels beside a new factory", async () => {
  const weth = await wethFactoryAddr();
  const p = await openApp(TRADER);
  await expect(p.locator("#sumGrad")).not.toHaveText("—", { timeout: 30_000 });
  const first = await p.evaluate(() => window.CurbApp.state.ctx.quoteSym);
  await expect(p.locator("#quoteSymA")).toHaveText(first);
  await expect(p.locator(".qs").first()).toHaveText(first);
  await expect.poll(() => p.evaluate(() => (window.CurbApp.state.graduatorAddr || "").toLowerCase()),
    { timeout: 20_000 }).toBe(APP.graduator.toLowerCase());

  await p.fill("#lens", "0x000000000000000000000000000000000000dEaD");
  await p.dispatchEvent("#lens", "change");
  // A LENS THAT DID NOT ANSWER HAS NO GRADUATOR, and the last lens's is not kept
  // in its place.
  await expect.poll(() => p.evaluate(() => window.CurbApp.state.graduatorAddr), { timeout: 20_000,
    message: "the last lens's graduator was kept for a lens that did not answer" }).toBeNull();
  await refetchFactory(p, weth);
  await expect.poll(() => p.evaluate(() => (window.CurbApp.state.ctx || {}).quoteSym), { timeout: 20_000 })
    .toBe("WETH");
  // EVERY LABEL NAMES THE ASSET THE AMOUNT IS NOW SCALED BY.
  await expect(p.locator("#quoteSymA"), "the balance row still names the last asset").toHaveText("WETH");
  await expect(p.locator(".qs").first(), "the amount's unit still names the last asset").toHaveText("WETH");
  await expect(p.locator("#sumPaired")).toHaveText("WETH");
  await expect(p.locator("#readmsg")).not.toContainText("slice");
  await p.close();
});

// ------------------------------------------------------------ S28
test("a balance that fails to load while switching factory leaves nothing of the last factory on screen", async () => {
  await ensureCreated();
  const weth = await wethFactoryAddr();
  const p = await openApp(OWNER);
  await expect(p.locator("#sumGrad")).not.toHaveText("—", { timeout: 30_000 });
  const first = await p.evaluate(() => window.CurbApp.state.ctx.quoteSym);
  // THE CONTROL: the owed panel and the balance are drawn, in the first asset.
  await expect(p.locator("#owedBox")).toBeVisible({ timeout: 30_000 });
  await expect(p.locator("#owedEscrow")).toContainText(first);
  await expect(p.locator("#quoteBal")).toContainText(first);

  await onCalls(p, [{ to: WETH_ADDR, data: sel("balanceOf(address)") + pad(OWNER), abort: true }]);
  await refetchFactory(p, weth);
  await expect(p.locator("#quoteBal"), "the last asset's balance stayed beside the new factory")
    .toHaveText("could not be read", { timeout: 20_000 });
  await expect(p.locator("#owedEscrow"), "the last factory's owed amounts stayed on screen")
    .toContainText("WETH", { timeout: 20_000 });
  await expect(p.locator("#quoteSymA")).toHaveText("WETH");
  await p.unroute("**/*");
  await p.close();
});

// ------------------------------------------------------------ N27
test("a launch-token balance that fails to load is said, not drawn as zero", async () => {
  const c = await ensureCreated();
  const p = await openApp(OWNER, { token: c.token });
  await expect(p.locator("#status")).toHaveText("Selling", { timeout: 30_000 });
  // NOT "you hold 0": the line still says "you hold" about the quote asset, and
  // a quote balance under 1 would read "you hold 0.4" - so the token's own
  // figure is what is looked for. THE CONTROL: that figure, while it is read.
  const tokenFigure = /you hold [\d,.]+ of this token/;
  await expect(p.locator("#balances")).toContainText(tokenFigure);
  await onCalls(p, [{ to: c.token, data: sel("balanceOf(address)") + pad(OWNER),
    error: { code: -32005, message: "rate limited" } }]);
  await p.evaluate(() => window.CurbApp.refresh(true));
  await expect(p.locator("#balances"), "a failed read was drawn as a balance").toContainText("could not be read");
  await expect(p.locator("#balances")).not.toContainText(tokenFigure);
  await p.unroute("**/*");

  // ---- NotFound ASKS NOTHING, so it states no holding: the quote asset's
  // balance is still said (the line is drawn), the token's is not.
  await p.fill("#token", WETH_ADDR);
  await p.dispatchEvent("#token", "change");
  await expect(p.locator("#status")).toHaveText("NotFound", { timeout: 30_000 });
  await expect(p.locator("#balances"), "the line was not redrawn, so the check below proves nothing")
    .not.toContainText("could not be read");
  await expect(p.locator("#balances")).toContainText("you hold");
  await expect(p.locator("#balances"), "a balance nobody asked for was drawn for NotFound")
    .not.toContainText("of this token");
  await p.close();

  // ---- NO WALLET, NOTHING ASKED: no "you hold 0" for either figure.
  const q = await browserRef.newPage();
  await q.goto("/app.html?" + new URLSearchParams({ rpc: STATE.rpc, factory: APP.factory, lens: APP.lens,
    token: c.token }).toString());
  await expect(q.locator("#status")).toHaveText("Selling", { timeout: 30_000 });
  await expect(q.locator("#balances"), "balances were drawn for an account that is not connected")
    .toHaveText("connect a wallet to see what you hold");
  await q.close();
});

// ------------------------------------------------------------ N23
test("an older curve quote that lands last does not draw a buy under the Sell button", async () => {
  const c = await ensureCreated();
  const f = await launchFacts(c.token);
  const p = await openApp(TRADER, { token: c.token });
  await expect(p.locator("#status")).toHaveText("Selling", { timeout: 30_000 });
  await p.selectOption("#curveSide", "buy");
  await p.fill("#curveAmount", "1");
  await p.evaluate(() => window.CurbApp.refresh(true));
  // THE CONTROL: a buy's breakdown is something this test can see.
  await expect(p.locator("#curveQuote")).toContainText("you offer");

  // THE FIRST feeBps() ASKED FROM HERE ON IS HELD - kept, not slept on.
  const feeData = sel("feeBps()").toLowerCase();
  const held = [];
  await p.route("**/*", async (route) => {
    let m = null;
    try { m = JSON.parse(route.request().postData() || ""); } catch { m = null; }
    const call = m && m.method === "eth_call" && m.params && m.params[0];
    if (call && !held.length && String(call.to || "").toLowerCase() === f.curve.toLowerCase() &&
        String(call.data || call.input || "").toLowerCase().startsWith(feeData)) {
      held.push(route);
      return;
    }
    return route.continue();
  });
  await p.evaluate(() => {
    // LARGE ENOUGH THAT A SALE OF IT PRICES TO SOMETHING: the newer quote,
    // below, sells this many tokens.
    document.getElementById("curveAmount").value = "5000";
    window.__olderQuote = window.CurbApp.renderCurveQuote();
  });
  await expect.poll(() => held.length, { timeout: 20_000, message: "the older quote was never asked" }).toBe(1);

  // A NEWER QUOTE, for a sale, overtakes it.
  await p.selectOption("#curveSide", "sell");
  await expect(p.locator("#curveQuote")).toContainText("you sell", { timeout: 20_000 });
  await expect(p.locator("#curveAct")).toHaveText("Sell to the curve");

  await held[0].continue();
  await p.evaluate(() => window.__olderQuote);
  await expect(p.locator("#curveQuote"), "the older buy quote drew over the sale").toContainText("you sell");
  await expect(p.locator("#curveQuote")).not.toContainText("you offer");
  await p.unroute("**/*");
  await p.close();
});

test("a curve quote asked while the factory is switched does not price the last launch in the next asset", async () => {
  const c = await ensureCreated();
  const weth = await wethFactoryAddr();
  const p = await openApp(TRADER, { token: c.token });
  await expect(p.locator("#status")).toHaveText("Selling", { timeout: 30_000 });
  const first = await p.evaluate(() => window.CurbApp.state.ctx.quoteSym);
  expect(first, "the launch is already in WETH, so the ticker below proves nothing").not.toBe("WETH");
  await p.selectOption("#curveSide", "buy");
  await p.fill("#curveAmount", "1");
  await p.evaluate(() => window.CurbApp.renderCurveQuote());
  // THE CONTROL: a quote this test can see, naming the launch's own asset.
  await expect(p.locator("#curveQuote")).toContainText("you offer");
  await expect(p.locator("#curveQuote")).toContainText("1 " + first);

  // THE SWITCH IS HELD after the new context is in place and before the launch
  // is read again: the first read of this account's WETH balance is parked.
  const balData = (sel("balanceOf(address)") + pad(TRADER)).toLowerCase();
  const held = [];
  await p.route("**/*", async (route) => {
    let m = null;
    try { m = JSON.parse(route.request().postData() || ""); } catch { m = null; }
    const call = m && m.method === "eth_call" && m.params && m.params[0];
    if (call && !held.length && String(call.to || "").toLowerCase() === WETH_ADDR &&
        String(call.data || call.input || "").toLowerCase().startsWith(balData)) {
      held.push(route);
      return;
    }
    return route.continue();
  });
  await refetchFactory(p, weth);
  await expect.poll(() => held.length, { timeout: 20_000, message: "the switch never reached the balance" }).toBe(1);
  // IN THE GAP: the context is the next asset's, the launch still the last one.
  const gap = await p.evaluate(() => {
    const s = window.CurbApp.state;
    return { sym: s.ctx && s.ctx.quoteSym, launchQuote: s.view && s.view.quoteToken, ctxQuote: s.ctx && s.ctx.quote };
  });
  expect(gap.sym).toBe("WETH");
  expect(gap.launchQuote, "the launch was already taken down, so nothing is in the gap").toBeTruthy();
  expect(gap.launchQuote.toLowerCase()).not.toBe(gap.ctxQuote.toLowerCase());

  await p.evaluate(() => {
    document.getElementById("curveAmount").value = "2";
    return window.CurbApp.renderCurveQuote();
  });
  await expect(p.locator("#curveQuote"), "the quote was not drawn at all, so the check below proves nothing")
    .toContainText("being read again");
  await expect(p.locator("#curveQuote"), "the last launch's curve was priced in the next asset")
    .not.toContainText("WETH");

  await held[0].continue();
  await p.unroute("**/*");
  await p.close();
});

// ------------------------------------------------------------ N29 / S23
test("with no factory read, the split, the card and the tax band print no platform share and no lock", async () => {
  const p = await openApp(TRADER);
  await expect(p.locator("#sumGrad")).not.toHaveText("—", { timeout: 30_000 });
  const setTax = (v) => p.evaluate((t) => {
    const el = document.getElementById("nTax");
    el.value = t;
    el.dispatchEvent(new Event("input"));
  }, v);

  // THE CONTROLS, with a factory read: the share, the band's sentence about it
  // and the fee are all on screen, so the assertions below can see them.
  await expect(p.locator("#sumLock")).toHaveText("Locked forever");
  await setTax("0.9");
  await expect(p.locator("#taxSplit")).toContainText("0.5% of it is the platform's");
  await setTax("2");
  await expect(p.locator("#taxSplit")).toContainText("platform 0.5%");
  await expect(p.locator("#sumYours")).toHaveText("1.50%");

  // ---- NO FACTORY.
  await p.fill("#factory", "");
  await p.dispatchEvent("#factory", "change");
  await expect.poll(() => p.evaluate(() => window.CurbApp.state.ctx === null), { timeout: 20_000 }).toBe(true);
  await expect(p.locator("#taxSplit"), "the fallback share was printed with no factory read")
    .toContainText("no factory has been read yet");
  await expect(p.locator("#taxSplit")).not.toContainText("platform 0.5%");
  await expect(p.locator("#sumYours"), "the creator's part was worked out from a share nobody read").toHaveText("—");
  await expect(p.locator("#sumLock"), "a lock nobody read was printed").toHaveText("—");
  await setTax("0.9");
  await expect(p.locator("#taxSplit")).toContainText("must be between 1% and 5%");
  await expect(p.locator("#taxSplit"), "the band does not say the share is still to be read")
    .toContainText("how much is read from the factory");
  await expect(p.locator("#taxSplit"), "the band states the fallback share as the platform's")
    .not.toContainText("0.5%");
  await p.close();
});

test("a dev buy that cannot be priced for want of the platform's share says so, not that the tax is invalid", async () => {
  const p = await openApp(TRADER);
  await expect(p.locator("#sumGrad")).not.toHaveText("—", { timeout: 30_000 });
  await p.evaluate(() => {
    const el = document.getElementById("nTax");
    el.value = "2";
    el.dispatchEvent(new Event("input"));
  });
  await p.fill("#nDevBuy", "1");
  // THE CONTROL: priced, with this tax, while the share is read.
  await expect(p.locator("#devBuyOut")).toContainText("You pay");

  await onCalls(p, [{ to: APP.factory, data: sel("currentPlatformPolicy()"),
    error: { code: -32005, message: "rate limited" } }]);
  await p.evaluate(() => window.CurbApp.refresh(true));
  expect(await p.evaluate(() => window.CurbApp.state.ctx.platformKnown)).toBe(false);
  await expect(p.locator("#devBuyOut"), "the unread share was not named")
    .toContainText("platform's share could not be read");
  await expect(p.locator("#devBuyOut"), "a valid tax was blamed").not.toContainText("creator tax has to be valid");
  await p.unroute("**/*");
  await p.evaluate(() => window.CurbApp.refresh(true));
  await expect(p.locator("#devBuyOut")).toContainText("You pay");
  await p.close();
});

// ============================================================ a wallet whose count is another chain's
/// THE OWNER'S NOTE: a wallet that remembered an older fork signed a create at
/// a nonce far ahead of this chain's; the node kept it queued, it never mined,
/// and every later create was refused as "There is already a transaction for
/// this that has not been accounted for", with no way on. Now it is said at
/// once and plainly - the wallet's count does not match this chain, reset its
/// activity - and the record can be forgotten on the spot.
const AHEAD = 100000n;   // far past anything this run sends from OWNER
test("a create the wallet signs at a nonce this chain never reaches is said plainly at once, and can be forgotten", async () => {
  test.setTimeout(120_000);
  const p = await openApp(OWNER);
  await expect.poll(() => p.evaluate(() => !!(window.CurbApp.state.ctx && window.CurbApp.state.ctx.platformKnown)),
    { timeout: 30_000 }).toBe(true);
  // THE WALLET'S COUNT IS ANOTHER CHAIN'S: its send goes out at a nonce far ahead.
  const count = BigInt(await rpc("eth_getTransactionCount", [OWNER, "latest"]));
  let rewritten = null;
  await p.route("**/*", async (route) => {
    const req = route.request();
    let m = null;
    try { m = req.method() === "POST" ? JSON.parse(req.postData() || "") : null; } catch { m = null; }
    if (!m || m.method !== "eth_sendTransaction" || rewritten) return route.continue();
    m.params[0].nonce = hex(count + AHEAD);
    rewritten = m.params[0].nonce;
    return route.continue({ postData: JSON.stringify(m) });
  });
  const out = await tryCreate(p);
  expect(rewritten, "the create was never sent, so this proves nothing").not.toBeNull();
  expect(out.text, "the gap was not said plainly").toContain("Your wallet's transaction count does not match this chain");
  expect(out.text).toContain("reset the wallet's activity");
  expect(out.text, "the create waited out its receipt before saying anything").not.toContain("waiting to be mined");
  const forget = p.locator("#msg button[data-forget]");
  await expect(forget, "no way to forget the record was offered").toBeVisible();
  // THE NODE STILL HOLDS IT QUEUED: it is real, and it will not mine.
  await p.unroute("**/*");
  p.once("dialog", (d) => d.accept());
  await forget.click();
  await expect(p.locator("#msg")).toContainText("is forgotten", { timeout: 30_000 });
  // AND THE NEXT CREATE GOES THROUGH: nothing refuses it any more.
  const again = await tryCreate(p);
  expect(again.text, "a create after forgetting was still refused").toContain("Launched");
  await p.close();
});

test("a record signed at a nonce this chain never reaches refuses the next create in plain words, with its Forget button", async () => {
  test.setTimeout(90_000);
  const count = BigInt(await rpc("eth_getTransactionCount", [OWNER, "latest"]));
  // THE NODE HAS NEVER SEEN THIS HASH, and its nonce is far past OWNER's.
  const rec = createRecord(fake("a7"), { sentNonce: hex(count + AHEAD), sentAt: Date.now() });
  const p = await openApp(OWNER, { plant: [rec] });
  await expect.poll(() => p.evaluate(() => !!(window.CurbApp.state.ctx && window.CurbApp.state.ctx.platformKnown)),
    { timeout: 30_000 }).toBe(true);
  const out = await tryCreate(p);
  expect(out.sent, "a create was sent past an unsettled record").toBe(0);
  expect(out.text, "the refusal does not say the wallet's count is another chain's")
    .toContain("Your wallet's transaction count does not match this chain");
  expect(out.text).toContain("sent only " + count);
  await expect(p.locator("#msg button[data-forget]"), "the refusal offers no Forget").toBeVisible();
  p.once("dialog", (d) => d.accept());
  await p.locator("#msg button[data-forget]").click();
  await expect(p.locator("#msg")).toContainText("is forgotten", { timeout: 30_000 });
  expect(await stored(p, rec), "the record was not forgotten").toBeNull();
  await p.close();
});
