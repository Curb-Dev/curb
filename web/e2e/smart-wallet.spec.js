// A SMART WALLET'S RECEIPT (ERC-4337), AS EVERY PAGE MUST READ IT.
//
// Coinbase Wallet's accounts - the ones its in-app browser connects - are smart
// wallets: what the person signs goes on chain as a user operation inside a
// bundler's transaction to the EntryPoint, and the hash the wallet hands back
// can be that bundle's. Its receipt says status 0x1 when the bundle ran,
// whether or not the operation did; the EntryPoint says which, in
// UserOperationEvent's `success`. A page that read `status` alone said "Done"
// for a buy that bought nothing.
//
// These tests make that receipt on the run's own fork: wallet-stub.js's
// `userOps` turns the send into a bundle, and the contract fake-wallets.js puts
// at an EntryPoint's address for the length of a test emits the event - so the
// receipt is the node's own, read through the wallet and the endpoint alike.
// Each page that judges a send is held to it: a curve buy on app.html's token
// view (and a bundle that ran without reaching the curve, or that carries
// another account's buy on the same curve), a sweep and a claim that never
// reached the curve or the escrow, the move on launch.html, and records
// settled on the next load. The holder's claim on /sharing is held to it in
// sharing.spec.js, where its payout is.
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const { ENTRY_POINT, USER_OP_EVENT, withReportingEntryPoint, bundled, otherOp } = require("./fake-wallets.js");
/// EntryPoint v0.9, the newest on Base: a record's bundle is made there.
const V09 = "0x433709009b8330fda32311df1c2afa402ed8d009";

const STATE = JSON.parse(fs.readFileSync(path.join(__dirname, ".state.json"), "utf8"));
const STUB = fs.readFileSync(path.join(__dirname, "..", "wallet-stub.js"), "utf8");
const APP = STATE.app;
const OWNER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const WETH = "0x4200000000000000000000000000000000000006";
const CHAIN = "0x2105";

// NOT SERIAL: each test stands alone - the launch is made once per worker, on
// first use - so one failing does not skip the others.
let browserRef;
test.beforeAll(async ({ browser }) => { browserRef = browser; });

// ------------------------------------------------------------------ the chain, from node
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
const keccak = (s) => window.CurbKeccak.keccak256("0x" + window.CurbAbi.utf8Hex(s));
const sel = (s) => keccak(s).slice(0, 10);
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
const pad = (a) => String(a).toLowerCase().replace(/^0x/, "").padStart(64, "0");
const addrOf = (raw) => "0x" + String(raw).replace(/^0x/, "").slice(24, 64);
const ethCall = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);
const balanceOf = async (token, who) => BigInt(await ethCall(token, sel("balanceOf(address)") + pad(who)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendMined(tx) {
  const hash = await rpc("eth_sendTransaction", [tx]);
  for (let i = 0; i < 200; i++) {
    const r = await rpc("eth_getTransactionReceipt", [hash]);
    if (r) { expect(r.status, "this transaction reverted: " + hash).toBe("0x1"); return r; }
    await wait(100);
  }
  throw new Error("never mined: " + hash);
}
/// A FRESH ACCOUNT OF ITS OWN: no code (the well-known keys carry EIP-7702
/// delegations on Base), the node signing for it, and plenty of ether.
async function freshAccount(label) {
  const a = "0x" + keccak("curb smart-wallet.spec " + label).slice(-40);
  expect(await rpc("eth_getCode", [a, "latest"]), "the account has code on this chain").toBe("0x");
  await rpc("anvil_impersonateAccount", [a]);
  await rpc("anvil_setBalance", [a, "0x" + (100n * 10n ** 18n).toString(16)]);
  return a;
}
/// The run's factory whose asset is `quote`.
async function factoryFor(quote) {
  const registry = addrOf(await ethCall(APP.lens, sel("registry()")));
  const n = Number(BigInt(await ethCall(registry, sel("launcherCount()"))));
  for (let i = 0; i < n; i++) {
    const f = addrOf(await ethCall(registry, sel("launcherAt(uint256)") + word(i)));
    if (addrOf(await ethCall(f, sel("quoteToken()"))) === quote.toLowerCase()) return f;
  }
  return null;
}

// ------------------------------------------------------------------ the page
/// A page whose wallet is the stub forwarding to the node, as `account`, with
/// `wallet` on top (userOps for a smart wallet's bundle); `plant` is records
/// put in the pending store before the page loads.
async function newPage(account, wallet = {}, plant = []) {
  const p = await browserRef.newPage();
  p.on("pageerror", (e) => console.log("PAGE ERROR: " + (e.stack || e.message)));
  const cfg = { forward: true, chainId: CHAIN, account, ...wallet };
  await p.addInitScript({ content: [
    STUB, ";(function () {",
    "  var plant = " + JSON.stringify(plant) + ";",
    "  if (!sessionStorage.getItem('smart.planted')) {",
    "    sessionStorage.setItem('smart.planted', '1');",
    "    plant.forEach(function (t) { localStorage.setItem('curb.launch.pending.v3:' + t.chainId + ':' + t.hash, JSON.stringify(t)); });",
    "  }",
    "  window.ethereum = window.makeWallet(" + JSON.stringify(STATE.rpc) + ", " + JSON.stringify(cfg) + ");",
    "})();",
  ].join("\n") });
  return p;
}
/// A launch on `factory`, made from the form by the deployer, as router.spec.js makes them.
async function createOn(factory, name, symbol) {
  const p = await newPage(OWNER);
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
async function openToken(token, account, wallet) {
  const p = await newPage(account, wallet);
  await p.goto("/token/" + token + "?" + new URLSearchParams({ rpc: STATE.rpc, lens: APP.lens }).toString());
  await expect(p.locator("#tokenView")).toBeVisible({ timeout: 15_000 });
  await expect(p.locator("#tvStatus")).not.toHaveText("—", { timeout: 30_000 });
  await p.evaluate(() => window.CurbApp.connect());
  await expect.poll(() => p.evaluate(() => ((window.CurbApp.state.viewFor || {}).token || "").toLowerCase()),
    { timeout: 30_000 }).toBe(token.toLowerCase());
  return p;
}
/// The swap card on a buy, paying with the pair's own asset: the curve's own buy, one send.
async function buyWithAsset(p, amount) {
  const sym = (await p.locator("#tvSym").textContent()).trim().replace(/^\$/, "");
  if ((await p.locator("#tvPayAsset").textContent()).trim() === sym) await p.click("#tvFlip");
  const pick = p.locator(".tvAsset.tvPick");
  if (await pick.count() && (await pick.textContent()).trim() === "ETH") {
    await pick.click();
    await p.locator('#tvMenu button[data-choice="asset"]').click();
    await expect(p.locator("#tvMenu")).toHaveCount(0);
  }
  await expect(p.locator("#tvPayAsset")).toHaveText("WETH");
  await p.fill("#tvPay", amount);
  await expect(p.locator("#tvAct")).toHaveText(/^Buy \$/, { timeout: 30_000 });
  await expect(p.locator("#tvAct")).toBeEnabled({ timeout: 30_000 });
  // AN EMPTY BLOCK FIRST, as router.spec.js's press does: the estimate's block a fresh one.
  await rpc("evm_mine", []);
  await p.evaluate(() => { document.getElementById("msg").textContent = ""; });
  await p.click("#tvAct");
}
/// The launch's curve, as the lens names it.
const curveOf = async (token) => addrOf("0x" + (await ethCall(APP.lens, sel("launchState(address)") + pad(token))).slice(2 + 64, 2 + 128));
/// WETH OF THE ENTRYPOINT'S OWN, for what a test has it do inside a bundle -
/// pay for another account's operation, as that account would - allowed to
/// `spender`. Sent as the EntryPoint, whatever code is at its address then.
async function entryPointHolds(amount, spender) {
  await rpc("anvil_impersonateAccount", [ENTRY_POINT]);
  const eth = BigInt(await rpc("eth_getBalance", [ENTRY_POINT, "latest"]));
  await rpc("anvil_setBalance", [ENTRY_POINT, "0x" + (eth + amount + 10n ** 17n).toString(16)]);
  await sendMined({ from: ENTRY_POINT, to: WETH, data: sel("deposit()"), value: "0x" + amount.toString(16) });
  if (spender) await sendMined({ from: ENTRY_POINT, to: WETH, data: sel("approve(address,uint256)") + pad(spender) + word(amount) });
}
/// app.html's form on `token`, as `account`, `wallet` on top (newPage's).
async function openForm(account, factory, token, wallet) {
  const p = await newPage(account, wallet);
  await p.goto("/app.html?" + new URLSearchParams({ rpc: STATE.rpc, factory, lens: APP.lens, token }).toString());
  await p.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
  await p.evaluate(() => window.CurbApp.connect());
  await expect(p.locator("#wallet")).toContainText(account, { ignoreCase: true, timeout: 20_000 });
  return p;
}
/// The bundles mined since `fromBlock`: the EntryPoint's events, decoded.
async function opsSince(fromBlock) {
  const logs = await rpc("eth_getLogs", [{ address: ENTRY_POINT, topics: [USER_OP_EVENT], fromBlock, toBlock: "latest" }]);
  return logs.map((l) => ({ sender: addrOf(l.topics[2]), success: BigInt("0x" + l.data.slice(2 + 64, 2 + 128)) !== 0n,
    hash: l.transactionHash }));
}
const nextBlock = async () => "0x" + (BigInt(await rpc("eth_blockNumber", [])) + 1n).toString(16);

// ================================================================== the verdict itself
test("the event and the EntryPoints the pages read are ERC-4337's: the topic from its signature, and each address with code on this Base fork", async () => {
  const p = await browserRef.newPage();
  await p.goto("/launch.html");
  await p.waitForFunction(() => !!window.CurbTx, null, { timeout: 8_000 });
  const got = await p.evaluate(() => ({ event: window.CurbTx.USER_OP_EVENT, entryPoints: window.CurbTx.ENTRY_POINTS.slice() }));
  expect(got.event).toBe(keccak("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)"));
  // v0.9 TOO: it has code on Base, and was missing at first.
  expect(got.entryPoints).toEqual([
    "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789", "0x0000000071727de22e5e9d8baf0edac6f37da032",
    "0x4337084d9e255ff0702461cf8895ce9e3b5ff108", V09]);
  // THIS FORK IS BASE'S: an address with no code here is not an EntryPoint on
  // Base - and each one's code emits the two events the pages read.
  const before = await p.evaluate(() => window.CurbTx.BEFORE_EXECUTION);
  expect(before).toBe(keccak("BeforeExecution()"));
  for (const a of got.entryPoints) {
    const code = String(await rpc("eth_getCode", [a, "latest"])).toLowerCase();
    expect(code.length, a + " has no code on this fork of Base").toBeGreaterThan(1000);
    expect(code, a + "'s code has no UserOperationEvent").toContain(got.event.slice(2));
    expect(code, a + "'s code has no BeforeExecution").toContain(before.slice(2));
  }
  await p.close();
});

test("a receipt is judged for the account that sent it: its own operation's failure is a failure, another account's is not, and only an EntryPoint's event counts", async () => {
  const p = await browserRef.newPage();
  await p.goto("/launch.html");
  await p.waitForFunction(() => !!window.CurbTx, null, { timeout: 8_000 });
  const out = await p.evaluate(({ event }) => {
    const TX = window.CurbTx;
    const [V6, V7, V8, V9] = TX.ENTRY_POINTS;
    const ME = "0x" + "a1".repeat(20), THEM = "0x" + "b2".repeat(20), BUNDLER = "0x" + "c3".repeat(20);
    const w = (n) => BigInt(n).toString(16).padStart(64, "0");
    const t = (a) => "0x" + a.slice(2).padStart(64, "0");
    const op = (address, sender, success, data) => ({ address, topics: [event, "0x" + "0e".repeat(32), t(sender), t("0x00")],
      data: data !== undefined ? data : "0x" + w(7) + w(success ? 1 : 0) + w(0) + w(0) });
    const r = (logs, from = BUNDLER, status = "0x1") => ({ status, from, logs });
    const v = (rec, who = ME) => TX.receiptVerdict(rec, who).ok ? "ok" : TX.receiptVerdict(rec, who).why;
    return {
      eoa: v(r([], ME)),
      reverted: v(r([], ME, "0x0")),
      mineFailedV6: v(r([op(V6, ME, false)])),
      mineFailedV7: v(r([op(V7, ME, false)])),
      mineFailedV8: v(r([op(V8, ME, false)])),
      mineFailedV9: v(r([op(V9, ME, false)])),
      // CHECKSUMMED ADDRESSES AND TOPICS are the same addresses.
      mineFailedUpper: v(r([op(V6.toUpperCase().replace("0X", "0x"), ME.toUpperCase().replace("0X", "0x"), false)])),
      mineSucceeded: v(r([op(V6, ME, true)])),
      theirsFailedMineSucceeded: v(r([op(V6, THEM, false), op(V6, ME, true)])),
      onlyTheirs: v(r([op(V6, THEM, true)])),
      // ANY CONTRACT CAN EMIT THE TOPIC: from one that is not an EntryPoint it is nothing.
      notAnEntryPoint: v(r([op("0x" + "d4".repeat(20), ME, false)])),
      // SENT BY THE ACCOUNT ITSELF, with someone else's event in it: the account's own transaction.
      ownWithTheirs: v(r([op(V6, THEM, true)], ME)),
      shortData: v(r([op(V6, ME, true, "0x" + w(1))])),
      words: ["reverted", "operation", "elsewhere"].map((why) => TX.failedWords({ ok: false, why })),
    };
  }, { event: USER_OP_EVENT });
  expect(out).toMatchObject({
    eoa: "ok", reverted: "reverted",
    mineFailedV6: "operation", mineFailedV7: "operation", mineFailedV8: "operation", mineFailedV9: "operation",
    mineFailedUpper: "operation",
    mineSucceeded: "ok", theirsFailedMineSucceeded: "ok", onlyTheirs: "elsewhere", notAnEntryPoint: "ok",
    ownWithTheirs: "ok", shortData: "operation",
  });
  expect(out.words).toEqual(["reverted on chain", "was mined, but your wallet's operation inside it reverted",
    "was mined, but nothing in it is an operation from your account, so nothing shows it went through"]);
  await p.close();
});

test("what a bundle did is read from the account's own operation: its logs, from the EntryPoint's event before it to its own UserOperationEvent", async () => {
  const p = await browserRef.newPage();
  await p.goto("/launch.html");
  await p.waitForFunction(() => !!window.CurbTx, null, { timeout: 8_000 });
  const out = await p.evaluate(({ event }) => {
    const TX = window.CurbTx;
    const [V6, , , V9] = TX.ENTRY_POINTS;
    const ME = "0x" + "a1".repeat(20), THEM = "0x" + "b2".repeat(20), ELSE = "0x" + "d4".repeat(20);
    const w = (n) => BigInt(n).toString(16).padStart(64, "0");
    const t = (a) => "0x" + a.slice(2).padStart(64, "0");
    const op = (address, sender) => ({ address, topics: [event, "0x" + "0e".repeat(32), t(sender), t("0x00")],
      data: "0x" + w(0) + w(1) + w(0) + w(0) });
    const before = (address) => ({ address, topics: [TX.BEFORE_EXECUTION], data: "0x" });
    const log = (name) => ({ address: "0x" + "c3".repeat(20), topics: ["0x" + "11".repeat(32)], data: "0x", name });
    const names = (logs) => logs.map((l) => l.name || (l.topics[0] === event ? "op " + l.topics[2].slice(-2) : "before"));
    const bundle = { status: "0x1", from: "0x" + "c3".repeat(20), transactionHash: "0x" + "ab".repeat(32),
      logs: [log("validation"), before(V6), log("theirs"), op(V6, THEM), log("mine"), log("mine too"), op(V6, ME),
        log("after"), op(V6, ELSE)] };
    const eoa = { status: "0x1", from: ME, logs: [log("a"), log("b")] };
    const own = TX.ownReceipt(bundle, ME);
    return {
      mine: names(TX.ownLogs(bundle, ME)),
      theirs: names(TX.ownLogs(bundle, THEM)),
      last: names(TX.ownLogs(bundle, ELSE)),
      // NO BeforeExecution (an EntryPoint that only reports): the first operation's run from the start.
      noBefore: names(TX.ownLogs({ logs: [log("x"), op(V9, ME), log("y"), op(V9, THEM)] }, ME)),
      // TWO OPERATIONS OF ONE SENDER (a staked one may): both.
      twice: names(TX.ownLogs({ logs: [before(V6), log("one"), op(V6, ME), log("other"), op(V6, THEM), log("two"),
        op(V6, ME)] }, ME)),
      // ANY OTHER CONTRACT'S UserOperationEvent cuts nothing.
      notAnEntryPoint: names(TX.ownLogs({ logs: [log("x"), op("0x" + "e5".repeat(20), ME), log("y")] }, ME)),
      eoaUntouched: TX.ownReceipt(eoa, ME) === eoa,
      noneOfMineUntouched: TX.ownReceipt(bundle, "0x" + "f6".repeat(20)) === bundle,
      copied: own !== bundle && own.transactionHash === bundle.transactionHash && own.status === "0x1" &&
        own.from === bundle.from && bundle.logs.length === 9,
    };
  }, { event: USER_OP_EVENT });
  expect(out).toEqual({
    mine: ["mine", "mine too", "op a1"],
    theirs: ["theirs", "op b2"],
    last: ["after", "op d4"],
    noBefore: ["x", "op a1"],
    twice: ["one", "op a1", "two", "op a1"],
    notAnEntryPoint: ["x", "op a1", "y"],
    eoaUntouched: true, noneOfMineUntouched: true, copied: true,
  });
  await p.close();
});

// ================================================================== app.html
let L = null;
/// A WETH-pair launch, a smart account holding WETH for it, and a bundler.
async function launch() {
  if (L) return L;
  const token = await createOn(await factoryFor(WETH), "Smart Weth", "SMW");
  const who = await freshAccount("smart account");
  await sendMined({ from: who, to: WETH, data: sel("deposit()"), value: "0x" + (5n * 10n ** 17n).toString(16) });
  L = { token, who, bundler: await freshAccount("bundler") };
  return L;
}

test("a curve buy whose smart-wallet operation reverted is said as failed: nothing bought, nothing spent, no \"Done\"", async () => {
  test.setTimeout(300_000);
  const { token, who, bundler } = await launch();
  await withReportingEntryPoint(rpc, async () => {
    // THE BUY GOES AS A BUNDLE WHOSE OPERATION REVERTED; THE APPROVAL BEFORE IT AS IT ALWAYS DOES.
    const p = await openToken(token, who, { userOps: bundled(bundler, false, [sel("buy(uint256,uint256,address)")]) });
    const weth0 = await balanceOf(WETH, who);
    const fromBlock = await nextBlock();
    await buyWithAsset(p, "0.1");
    const msg = p.locator("#msg");
    await expect(msg).toContainText("buy on the curve was mined, but your wallet's operation inside it reverted", { timeout: 120_000 });
    await expect(msg, "a reverted operation was reported as a success").toHaveClass(/err/);
    await expect(msg).toContainText("Nothing changed.");
    await expect(msg).not.toContainText("Done");
    // THE RECEIPT IS WHAT A SMART WALLET'S IS: status 0x1, from the bundler, this account's operation failed.
    const ops = await opsSince(fromBlock);
    expect(ops, "no bundle carried this account's operation").toHaveLength(1);
    expect(ops[0]).toMatchObject({ sender: who, success: false });
    const rc = await rpc("eth_getTransactionReceipt", [ops[0].hash]);
    expect(rc.status, "the bundle itself did not run, so this proves nothing").toBe("0x1");
    expect(rc.from.toLowerCase()).toBe(bundler);
    // AND THE CHAIN AGREES: no token, all the WETH.
    expect(await balanceOf(token, who), "tokens arrived, so the operation did not fail").toBe(0n);
    expect(await balanceOf(WETH, who)).toBe(weth0);
    const sent = await p.evaluate(() => window.ethereum.sent.map((t) => String(t.data).slice(0, 10)));
    expect(sent, "the page did not ask for the approval and the buy").toEqual([sel("approve(address,uint256)"), sel("buy(uint256,uint256,address)")]);
    expect(await p.evaluate(() => window.CurbTx.loadPendingAll().length), "a record of the failed buy was kept").toBe(0);
    await p.close();
  });
});

test("a smart wallet's bundle that ran without reaching the curve is not a buy, though its operation says it succeeded", async () => {
  test.setTimeout(300_000);
  const { token, who, bundler } = await launch();
  await withReportingEntryPoint(rpc, async () => {
    const p = await openToken(token, who, { userOps: bundled(bundler, true, [sel("buy(uint256,uint256,address)")]) });
    await buyWithAsset(p, "0.1");
    const msg = p.locator("#msg");
    await expect(msg).toContainText("carries no CurveBuy event from the curve, so it did not buy on it", { timeout: 120_000 });
    await expect(msg, "a bundle with no CurveBuy was reported as a buy").toHaveClass(/err/);
    await expect(msg).not.toContainText("Done");
    expect(await balanceOf(token, who)).toBe(0n);
    await p.close();
  });
});

test("a smart wallet's bundle that carries another account's buy on the same curve is not this account's buy", async () => {
  test.setTimeout(300_000);
  const { token, who, bundler } = await launch();
  const curve = await curveOf(token);
  const them = "0x" + keccak("curb smart-wallet.spec them").slice(-40);
  const spend = 10n ** 16n;
  await withReportingEntryPoint(rpc, async () => {
    // THE OTHER ACCOUNT'S OPERATION FIRST, IN THE SAME BUNDLE: a real buy on this
    // curve, made by the EntryPoint as that account would, to that account.
    await entryPointHolds(spend, curve);
    const theirs = otherOp(them, true, { to: curve, data: sel("buy(uint256,uint256,address)") + word(spend) + word(0) + pad(them) });
    const p = await openToken(token, who, { userOps: bundled(bundler, true, [sel("buy(uint256,uint256,address)")], theirs) });
    const fromBlock = await nextBlock();
    await buyWithAsset(p, "0.1");
    const msg = p.locator("#msg");
    await expect(msg).toContainText("carries no CurveBuy event from the curve, so it did not buy on it", { timeout: 120_000 });
    await expect(msg, "another account's buy in the bundle was reported as this one's").toHaveClass(/err/);
    await expect(msg).not.toContainText("Done");
    // THE BUNDLE IS WHAT IT SAYS: the other operation bought, this one did nothing.
    const ops = await opsSince(fromBlock);
    expect(ops.map((o) => o.sender), "the two operations are not in one bundle").toEqual([them, who]);
    expect(new Set(ops.map((o) => o.hash)).size).toBe(1);
    expect(await balanceOf(token, them), "the other operation bought nothing, so this proves nothing").toBeGreaterThan(0n);
    expect(await balanceOf(token, who)).toBe(0n);
    await p.close();
  });
});

test("a sweep and a claim whose smart-wallet operations ran without reaching the curve or the escrow are said as failed, not done", async () => {
  test.setTimeout(300_000);
  const { token, bundler } = await launch();
  const factory = await factoryFor(WETH);
  const curve = await curveOf(token);
  // FEES ON THE CURVE: an account's own buy.
  const buyer = await freshAccount("fee buyer");
  const spend = 5n * 10n ** 16n;
  await sendMined({ from: buyer, to: WETH, data: sel("deposit()"), value: "0x" + spend.toString(16) });
  await sendMined({ from: buyer, to: WETH, data: sel("approve(address,uint256)") + pad(curve) + word(spend) });
  await sendMined({ from: buyer, to: curve, data: sel("buy(uint256,uint256,address)") + word(spend) + word(0) + pad(buyer) });
  const onCurve = async () => BigInt(await ethCall(curve, sel("creatorTaxBalance()"))) + BigInt(await ethCall(curve, sel("quoteFeeBalance()")));
  expect(await onCurve(), "the buy left no fees on the curve").toBeGreaterThan(0n);
  const escrow = addrOf(await ethCall(factory, sel("feeEscrow()")));
  const owed = async () => BigInt(await ethCall(escrow, sel("balanceOfToken(address,address)") + pad(OWNER) + pad(WETH)));
  await withReportingEntryPoint(rpc, async () => {
    // THE CREATOR'S SWEEP, AS A BUNDLE THAT RAN AROUND AN OPERATION THAT DID NOTHING.
    let p = await openForm(OWNER, factory, token, { userOps: bundled(bundler, true, [sel("sweepFees(uint256)")]) });
    await expect(p.locator("#sweepCurve")).toBeEnabled({ timeout: 30_000 });
    const fees = await onCurve();
    await p.click("#sweepCurve");
    let msg = p.locator("#msg");
    await expect(msg).toContainText("carries no FeesSwept event from the curve, so no fees were swept", { timeout: 120_000 });
    await expect(msg, "a sweep that swept nothing was reported as done").toHaveClass(/err/);
    await expect(msg).not.toContainText("Fees swept");
    expect(await onCurve(), "the fees left the curve, so the operation did something").toBe(fees);
    expect(await p.evaluate(() => window.ethereum.sent.map((t) => String(t.data).slice(0, 10)))).toEqual([sel("sweepFees(uint256)")]);
    await p.close();

    // SWEPT FOR REAL, so the escrow owes the creator; then the claim, as such a bundle.
    await sendMined({ from: OWNER, to: curve, data: sel("sweepFees(uint256)") + word(0) });
    const due = await owed();
    expect(due, "the sweep credited the creator nothing").toBeGreaterThan(0n);
    p = await openForm(OWNER, factory, token, { userOps: bundled(bundler, true, [sel("claimToken(address)")]) });
    await expect(p.locator("#claimEscrow")).toBeEnabled({ timeout: 30_000 });
    await p.click("#claimEscrow");
    msg = p.locator("#msg");
    await expect(msg).toContainText("carries no Claimed event from the fee escrow, so nothing was claimed", { timeout: 120_000 });
    await expect(msg, "a claim that paid nothing was reported as done").toHaveClass(/err/);
    await expect(msg).not.toContainText("Claimed in");
    expect(await owed(), "the escrow paid, so the operation did something").toBe(due);
    await p.close();
  });
});

test("a create record whose smart-wallet operation reverted is settled as a revert on the next load, not kept as a launch to find", async () => {
  test.setTimeout(120_000);
  const { who, bundler } = await launch();
  // AT EntryPoint v0.9, the newest: the other tests' bundles go to v0.6.
  await withReportingEntryPoint(rpc, async () => {
    // A BUNDLE AS A SMART WALLET SENT IT FOR A CREATE, the tab closed before its receipt.
    const rc = await sendMined({ from: bundler, to: V09, data: "0x" + "0c".repeat(32) + pad(who) + word(0) });
    const rec = { page: "app", kind: "create", chainId: CHAIN, rpc: STATE.rpc, lens: APP.lens, token: "", factory: APP.factory,
      from: who, to: APP.factory, hash: rc.transactionHash, what: "create the launch SMART", sentNonce: null,
      sentAfterBlock: null, uncertainChain: false, sentAt: Date.now() };
    const p = await newPage(who, {}, [rec]);
    await p.goto("/app.html?" + new URLSearchParams({ rpc: STATE.rpc, factory: APP.factory, lens: APP.lens }).toString());
    await p.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
    const msg = p.locator("#msg");
    await expect(msg).toContainText("An earlier transaction (create the launch SMART) was mined, but your wallet's operation inside it reverted",
      { timeout: 30_000 });
    await expect(msg).toHaveClass(/err/);
    expect(await p.evaluate((k) => localStorage.getItem(k), "curb.launch.pending.v3:" + CHAIN + ":" + rec.hash),
      "the record of a create that made nothing was kept").toBeNull();
    await p.close();
  }, V09);
});

test("a two-step buy's swap record whose smart-wallet operation reverted is cleared on the next load, not kept as held, though the bundle delivered to the account", async () => {
  test.setTimeout(120_000);
  const { token, who, bundler } = await launch();
  const factory = await factoryFor(WETH);
  const delivered = 10n ** 15n;
  await withReportingEntryPoint(rpc, async () => {
    // A BUNDLE THAT CARRIES A DELIVERY TO THE ACCOUNT - WETH from the
    // EntryPoint, in the operation's own logs - around an operation that reverted.
    await entryPointHolds(delivered);
    const rc = await sendMined({ from: bundler, to: ENTRY_POINT, data: "0x" + "0f".repeat(32) + pad(who) + word(0) +
      pad(WETH) + sel("transfer(address,uint256)").slice(2) + pad(who) + word(delivered) });
    const credit = rc.logs.find((l) => l.address.toLowerCase() === WETH && l.topics[0] === keccak("Transfer(address,address,uint256)"));
    expect(credit && addrOf(credit.topics[2]), "the bundle delivered nothing, so this proves nothing").toBe(who);
    const rec = { page: "app", kind: "eth-swap", chainId: CHAIN, rpc: STATE.rpc, lens: APP.lens, token, factory,
      from: who, to: WETH, hash: rc.transactionHash, what: "swap ETH for WETH SMART (step 1 of 2)", sentNonce: null,
      sentAfterBlock: null, uncertainChain: false, sentAt: Date.now(), venue: "aerodrome", asset: WETH, assetSym: "WETH",
      assetDecimals: 18, ethIn: "0x" + delivered.toString(16), minOut: "0x0" };
    const p = await newPage(who, {}, [rec]);
    await p.goto("/app.html?" + new URLSearchParams({ rpc: STATE.rpc, factory, lens: APP.lens }).toString());
    await p.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
    const msg = p.locator("#msg");
    await expect(msg).toContainText("An earlier transaction (swap ETH for WETH SMART (step 1 of 2)) was mined, but your wallet's operation inside it reverted",
      { timeout: 30_000 });
    await expect(msg).toHaveClass(/err/);
    expect(await p.evaluate((k) => localStorage.getItem(k), "curb.launch.pending.v3:" + CHAIN + ":" + rec.hash),
      "a swap whose operation reverted was kept as held").toBeNull();
    await p.close();
  });
});

// ================================================================== launch.html
test("launch.html's move through a smart wallet whose operation reverted says it failed, and the launch is still waiting", async () => {
  test.setTimeout(120_000);
  const bundler = await freshAccount("launch bundler");
  await withReportingEntryPoint(rpc, async () => {
    const p = await browserRef.newPage();
    await p.addInitScript({ content: [
      STUB, ";(function () {",
      "  localStorage.setItem('curb.launch.addrs', JSON.stringify(" + JSON.stringify({ lens: STATE.lens, token: STATE.token, rpc: STATE.rpc }) + "));",
      "  window.ethereum = window.makeWallet(" + JSON.stringify(STATE.rpc) + ", " +
        JSON.stringify({ forward: true, chainId: CHAIN, userOps: bundled(bundler, false, [sel("graduate(address)")]) }) + ");",
      "})();",
    ].join("\n") });
    await p.goto("/launch.html");
    await p.waitForFunction(() => !!window.CurbLaunch, null, { timeout: 8_000 });
    await expect(p.locator("#statusText")).toHaveText("Waiting", { timeout: 20_000 });
    await p.click("#connect");
    await expect(p.locator("#complete")).toBeEnabled({ timeout: 20_000 });
    const fromBlock = await nextBlock();
    await p.click("#complete");
    const msg = p.locator("#msg");
    await expect(msg).toContainText("The transaction was mined, but your wallet's operation inside it reverted", { timeout: 60_000 });
    await expect(msg).toHaveClass(/err/);
    await expect(msg, "a reverted operation was called a success").not.toContainText("succeeded");
    const ops = await opsSince(fromBlock);
    expect(ops, "the move did not go as a bundle").toHaveLength(1);
    expect(ops[0].success).toBe(false);
    // NOTHING MOVED: the launch the other suites need is still waiting.
    await expect(p.locator("#statusText")).toHaveText("Waiting", { timeout: 20_000 });
    expect(await p.evaluate(() => window.CurbLaunch.loadPendingAll().length)).toBe(0);
    await p.close();
  });
});

test("launch.html settles app.html's record of a trade whose smart-wallet operation reverted as a revert, read through the RPC field with no wallet", async () => {
  test.setTimeout(120_000);
  const who = await freshAccount("launch record account");
  const bundler = await freshAccount("launch record bundler");
  await withReportingEntryPoint(rpc, async () => {
    // A BUNDLE AS A SMART WALLET SENT IT FOR A BUY ON app.html, the tab closed before its receipt.
    const rc = await sendMined({ from: bundler, to: ENTRY_POINT, data: "0x" + "1c".repeat(32) + pad(who) + word(0) });
    const rec = { page: "app", kind: "action", chainId: CHAIN, rpc: STATE.rpc, lens: STATE.lens, token: STATE.token,
      factory: APP.factory, from: who, to: STATE.token, hash: rc.transactionHash, what: "buy on the curve SMART",
      sentNonce: null, sentAfterBlock: null, uncertainChain: false, sentAt: Date.now() };
    const p = await browserRef.newPage();
    p.on("pageerror", (e) => console.log("PAGE ERROR: " + (e.stack || e.message)));
    await p.addInitScript({ content: [
      "if (!sessionStorage.getItem('smart.planted')) {",
      "  sessionStorage.setItem('smart.planted', '1');",
      "  localStorage.setItem('curb.launch.addrs', JSON.stringify(" + JSON.stringify({ lens: STATE.lens, token: STATE.token, rpc: STATE.rpc }) + "));",
      "  localStorage.setItem(" + JSON.stringify("curb.launch.pending.v3:" + CHAIN + ":" + rec.hash) + ", " + JSON.stringify(JSON.stringify(rec)) + ");",
      "}",
    ].join("\n") });
    await p.goto("/launch.html");
    await p.waitForFunction(() => !!window.CurbLaunch, null, { timeout: 8_000 });
    const msg = p.locator("#msg");
    await expect(msg).toContainText("A transaction from a previous visit", { timeout: 30_000 });
    await expect(msg).toContainText("was mined, but your wallet's operation inside it reverted");
    await expect(msg, "a reverted operation was called a success").toHaveClass(/err/);
    await expect(msg).not.toContainText("succeeded");
    expect(await p.evaluate(() => window.CurbLaunch.loadPendingAll().length), "the record was not settled").toBe(0);
    await p.close();
  });
});
