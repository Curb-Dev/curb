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
// view (and a bundle that ran without reaching the curve), the move on
// launch.html, and a record settled on the next load. The holder's claim on
// /sharing is held to it in sharing.spec.js, where its payout is.
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const { ENTRY_POINT, USER_OP_EVENT, withReportingEntryPoint, bundled } = require("./fake-wallets.js");

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
  expect(got.entryPoints).toEqual([
    "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789", "0x0000000071727de22e5e9d8baf0edac6f37da032",
    "0x4337084d9e255ff0702461cf8895ce9e3b5ff108"]);
  // THIS FORK IS BASE'S: an address with no code here is not an EntryPoint on Base.
  for (const a of got.entryPoints) {
    expect((await rpc("eth_getCode", [a, "latest"])).length, a + " has no code on this fork of Base").toBeGreaterThan(1000);
  }
  await p.close();
});

test("a receipt is judged for the account that sent it: its own operation's failure is a failure, another account's is not, and only an EntryPoint's event counts", async () => {
  const p = await browserRef.newPage();
  await p.goto("/launch.html");
  await p.waitForFunction(() => !!window.CurbTx, null, { timeout: 8_000 });
  const out = await p.evaluate(({ event }) => {
    const TX = window.CurbTx;
    const [V6, V7, V8] = TX.ENTRY_POINTS;
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
    mineFailedV6: "operation", mineFailedV7: "operation", mineFailedV8: "operation", mineFailedUpper: "operation",
    mineSucceeded: "ok", theirsFailedMineSucceeded: "ok", onlyTheirs: "elsewhere", notAnEntryPoint: "ok",
    ownWithTheirs: "ok", shortData: "operation",
  });
  expect(out.words).toEqual(["reverted on chain", "was mined, but your wallet's operation inside it reverted",
    "was mined, but nothing in it is an operation from your account, so nothing shows it went through"]);
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

test("a create record whose smart-wallet operation reverted is settled as a revert on the next load, not kept as a launch to find", async () => {
  test.setTimeout(120_000);
  const { who, bundler } = await launch();
  await withReportingEntryPoint(rpc, async () => {
    // A BUNDLE AS A SMART WALLET SENT IT FOR A CREATE, the tab closed before its receipt.
    const rc = await sendMined({ from: bundler, to: ENTRY_POINT, data: "0x" + "0c".repeat(32) + pad(who) + word(0) });
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
