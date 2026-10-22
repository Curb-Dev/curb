// HOLDER SHARING ON THE SITE (core v2 design D.3, D.4 6): the launch form's
// toggle, the creator's switch on a launch's page, the "Holders earn" card, a
// holder's Claim and Claim to another address, Push pending payouts, the check
// of a payout's file, and /sharing.
//
// EVERY PAYOUT HERE IS A REAL ONE. The epoch file is computed from this fork's
// own chain - the token's Transfer log, the blocks' times, the distributor's
// income at the harvest block - by services/sharer's calculator itself (the
// browser build the site serves, imported here), and published through the
// distributor factory by the publisher key the deployment named (anvil's
// account 5, which the node signs for). The page then reads it like any other:
// from the site's path, which these tests serve, or from an IPFS gateway.
//
// THE TESTS BUILD ON EACH OTHER - one launch, its payouts, its holders - so the
// file is serial. What one test must not leave behind (a freeze, an issuer's
// block, half a year of time) is done inside a snapshot that is reverted.
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const STATE = JSON.parse(fs.readFileSync(path.join(__dirname, ".state.json"), "utf8"));
const STUB = fs.readFileSync(path.join(__dirname, "..", "wallet-stub.js"), "utf8");
const APP = STATE.app;
const OWNER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";    // deployer: policy owner, catalog owner, a vetoer
const TRADER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const PUBLISHER = "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc"; // demo-app.sh's sharing publisher (account 5)
const VETOER = "0x14dc79964da2c08b23698b3d3cc7ca32193d9955";    // demo-app.sh's sharing vetoer (account 7)
const NVDAC = "0xb20000000000000000000078ee7ce2fe4908108c";
const POLICY_REGISTRY = "0x8453000000000000000000000000000000000002";
const POOL_MANAGER = "0x498581ff718922c3f8e6a244956af099b2652b2b";
const CURB_ROUTER = "0xea20c3266229a01cd0f45d9c7921a45d5b359561";
const CHAIN = 8453;
const URI = (n) => "ipfs://bafkreicurbsharinge2eepoch" + n;
const SHOTS = process.env.CURB_SHOTS || "";

test.describe.configure({ mode: "serial" });

let browserRef;
test.beforeAll(async ({ browser }) => {
  browserRef = browser;
  if (!APP.catalog || !APP.sharing) throw new Error("the run's state names no sharing catalog or distributor factory");
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
const { encode, T } = window.CurbAbi;
const keccak = (s) => window.CurbKeccak.keccak256("0x" + window.CurbAbi.utf8Hex(s));
const sel = (s) => keccak(s).slice(0, 10);
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
const pad = (a) => String(a).toLowerCase().replace(/^0x/, "").padStart(64, "0");
const hex = (n) => "0x" + BigInt(n).toString(16);
const addrOf = (raw) => "0x" + String(raw).replace(/^0x/, "").slice(24, 64);
const wordAt = (raw, i) => BigInt("0x" + String(raw).replace(/^0x/, "").slice(i * 64, i * 64 + 64));
const ethCall = (to, data, block = "latest") => rpc("eth_call", [{ to, data }, block]);
const big = async (to, data, block) => BigInt(await ethCall(to, data, block));
const balanceOf = (token, who, block) => big(token, sel("balanceOf(address)") + pad(who), block);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const TRANSFER = keccak("Transfer(address,address,uint256)");

async function sendMined(tx) {
  const hash = await rpc("eth_sendTransaction", [tx]);
  for (let i = 0; i < 200; i++) {
    const r = await rpc("eth_getTransactionReceipt", [hash]);
    if (r) { expect(r.status, "this transaction reverted: " + hash).toBe("0x1"); return r; }
    await wait(100);
  }
  throw new Error("never mined: " + hash);
}
async function inSnapshot(fn) {
  const snap = await rpc("evm_snapshot", []);
  try { return await fn(); } finally {
    expect(await rpc("evm_revert", [snap]), "the snapshot was not reverted").toBe(true);
  }
}
/// Moves the chain's clock on and mines a block at the new time.
async function later(seconds) {
  await rpc("evm_increaseTime", [seconds]);
  await rpc("evm_mine", []);
}
/// A FRESH ACCOUNT OF ITS OWN: no code (the well-known keys carry EIP-7702
/// delegations on Base), the node signing for it, and ether for gas.
async function freshAccount(label) {
  const a = "0x" + keccak("curb sharing.spec " + label).slice(-40);
  expect(await rpc("eth_getCode", [a, "latest"]), "the account has code on this chain").toBe("0x");
  await rpc("anvil_impersonateAccount", [a]);
  await rpc("anvil_setBalance", [a, "0x" + (100n * 10n ** 18n).toString(16)]);
  return a;
}
/// THE ISSUER'S OWN BLOCKLIST, as router.spec.js uses it: NVDAc's receiver
/// policy, updated by that policy's admin.
async function blockReceiving(who, on = true) {
  const scope = await ethCall(NVDAC, sel("TRANSFER_RECEIVER_POLICY()"));
  const policy = BigInt(await ethCall(NVDAC, sel("policyId(bytes32)") + scope.slice(2)));
  const admin = addrOf(await ethCall(POLICY_REGISTRY, sel("policyAdmin(uint64)") + word(policy)));
  await rpc("anvil_impersonateAccount", [admin]);
  await rpc("anvil_setBalance", [admin, "0x" + (10n ** 18n).toString(16)]);
  await sendMined({ from: admin, to: POLICY_REGISTRY,
    data: sel("updateBlocklist(uint64,bool,address[])") + encode([T.uint(64), T.bool, T.array(T.address)], [policy, on, [who]]).slice(2) });
  const ok = BigInt(await ethCall(POLICY_REGISTRY, sel("isAuthorized(uint64,address)") + word(policy) + pad(who))) === 1n;
  expect(ok, "the blocklist update did not take").toBe(!on);
}

// ------------------------------------------------------------------ the page
async function newPage(account, wallet = {}) {
  const p = await browserRef.newPage();
  p.on("pageerror", (e) => console.log("PAGE ERROR: " + (e.stack || e.message)));
  const cfg = { forward: true, chainId: "0x2105", account, ...wallet };
  await p.addInitScript({ content: [
    STUB, ";(function () {",
    "  window.ethereum = window.makeWallet(" + JSON.stringify(STATE.rpc) + ", " + JSON.stringify(cfg) + ");",
    "})();",
  ].join("\n") });
  return p;
}
const appUrl = (factory) => "/app.html?" + new URLSearchParams({ rpc: STATE.rpc, factory, lens: APP.lens }).toString();
async function openForm(account = OWNER) {
  const p = await newPage(account);
  await p.goto(appUrl(APP.factory));
  await p.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
  await p.evaluate(() => window.CurbApp.connect());
  await expect.poll(() => p.evaluate(() => !!(window.CurbApp.state.ctx && window.CurbApp.state.ctx.sharing)),
    { timeout: 30_000, message: "the form never read the factory's sharing offer" }).toBe(true);
  return p;
}
/// The launch's page, with the site's epoch files served from `files` (epoch -> bytes) for `d`.
async function openToken(token, account = OWNER, files = null) {
  const p = await newPage(account);
  if (files) await serveFiles(p, files);
  await p.goto("/token/" + token + "?" + new URLSearchParams({ rpc: STATE.rpc, lens: APP.lens }).toString() + "#holders");
  await expect(p.locator("#tokenView")).toBeVisible({ timeout: 15_000 });
  await expect(p.locator("#tvStatus")).not.toHaveText("—", { timeout: 30_000 });
  await p.evaluate(() => window.CurbApp.connect());
  await expect.poll(() => p.evaluate(() => ((window.CurbApp.state.viewFor || {}).token || "").toLowerCase()),
    { timeout: 30_000 }).toBe(token.toLowerCase());
  return p;
}
/// THE SITE'S PATH FOR THE EPOCH FILES, served from `files.site` (epoch -> bytes,
/// or a function of the epoch), and the IPFS gateways from `files.ipfs`.
/// Anything not given is a 404: no test reaches the real IPFS network.
async function serveFiles(p, files) {
  await p.route(/\/sharing\/\d+\/0x[0-9a-f]{40}\/\d+\.json$/, (route) => {
    const n = Number(/\/(\d+)\.json$/.exec(route.request().url())[1]);
    const b = typeof files.site === "function" ? files.site(n) : (files.site || {})[n];
    if (!b) return route.fulfill({ status: 404, body: "not found" });
    return route.fulfill({ status: 200, contentType: "application/json", body: Buffer.from(b) });
  });
  await p.route(/^https:\/\/(ipfs\.filebase\.io|gateway\.pinata\.cloud|ipfs\.io|dweb\.link|w3s\.link)\/ipfs\/.*/, (route) => {
    const m = /bafkreicurbsharinge2eepoch(\d+)/.exec(route.request().url());
    const b = m && files.ipfs ? files.ipfs[Number(m[1])] : null;
    if (!b) return route.fulfill({ status: 404, body: "not found" });
    return route.fulfill({ status: 200, contentType: "application/octet-stream", body: Buffer.from(b) });
  });
}
async function shot(p, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const [w, h] of [[1280, 900], [390, 844]]) {
    await p.setViewportSize({ width: w, height: h });
    await p.waitForTimeout(400);
    await p.screenshot({ path: path.join(SHOTS, name + "-" + w + ".png"), fullPage: true });
  }
  await p.setViewportSize({ width: 1280, height: 900 });
}
/// What the page last tried to send, and nothing sent: the wallet declines.
async function captureAndDecline(p) {
  await p.evaluate(() => {
    window.__tx = null;
    window.ethereum.cfg.onSend = (tx) => { window.__tx = tx; };
    window.ethereum.cfg.sendError = Object.assign(new Error("User rejected the request."), { code: 4001 });
  });
}
async function stopDeclining(p) {
  await p.evaluate(() => { window.ethereum.cfg.onSend = null; window.ethereum.cfg.sendError = null; });
}
/// launch()'s calldata: word 0 the tuple's offset, then its head - the
/// eleventh member is holderShareFactory.
const shareFieldOf = (data) => "0x" + String(data).slice(10 + 11 * 64, 10 + 12 * 64).slice(24);
const LAUNCH_SEL = sel("launch((string,string,string,bytes32,address,uint16,uint256,address,uint16,address,address))");

// ------------------------------------------------------------------ the payouts
let SHARE = null;
async function share() {
  if (!SHARE) SHARE = await import(pathToFileURL(path.join(__dirname, "..", "curb-share.mjs")).href);
  return SHARE;
}
async function forkFloor() {
  const m = await rpc("anvil_metadata", []);
  return Number(m.forkedNetwork.forkBlockNumber) + 1;
}
/// Every epoch of a launch's distributor so far, computed by CURB-SHARE v1 from
/// this chain: `attempts` are { T, harvestTx, uri } in order.
async function computeEpochs(token, d, attempts) {
  const s = await share();
  const since = Number(await big(APP.graduator, sel("sharingSince(address)") + pad(token)));
  const quote = addrOf(await ethCall(d, sel("quoteToken()")));
  const factory = addrOf(await ethCall(d, sel("factory()")));
  const lastT = attempts[attempts.length - 1].T;
  const logs = await rpc("eth_getLogs", [{ address: token, topics: [TRANSFER], fromBlock: hex(await forkFloor()), toBlock: hex(lastT) }]);
  const transfers = logs.map((l) => ({ block: String(parseInt(l.blockNumber, 16)), logIndex: String(parseInt(l.logIndex, 16)),
    from: addrOf(l.topics[1]), to: addrOf(l.topics[2]), value: BigInt(l.data).toString() }));
  const first = Math.min(Number(transfers[0].block), since);
  const timestamps = {};
  for (let b = first - 1; b <= lastT; b++) {
    timestamps[String(b)] = String(parseInt((await rpc("eth_getBlockByNumber", [hex(b), false])).timestamp, 16));
  }
  const reg = addrOf(await ethCall(APP.lens, sel("registry()")));
  const rec = await ethCall(reg, sel("launchOf(address)") + pad(token));
  const curve = addrOf("0x" + rec.slice(2, 66));
  const hook = addrOf("0x" + rec.slice(2 + 7 * 64, 2 + 8 * 64));
  const escrow = addrOf(await ethCall(curve, sel("feeEscrow()")));
  const lock = addrOf(await ethCall(APP.graduator, sel("lockOf(address)") + pad(token)));
  const exclusions = [
    [curve, "the launch curve"], [hook, "the launch hook"], [escrow, "the launcher FeeEscrow"],
    [APP.graduator, "the Graduator"], [POOL_MANAGER, "the v4 PoolManager"],
    ["0x7c5f5a4bbd8fd63184577525326123b519429bdc", "the v4 PositionManager"], [reg, "the LaunchRegistry"],
    [CURB_ROUTER, "CurbRouter"],
  ].concat(/^0x0{40}$/.test(lock) ? [] : [[lock, "the launch PositionLock"]])
    .map(([a, reason]) => ({ address: a.toLowerCase(), reason }));
  const vector = {
    setup: {
      chainId: String(CHAIN), distributor: d.toLowerCase(), factory: factory.toLowerCase(), launchToken: token.toLowerCase(),
      quoteToken: quote.toLowerCase(), quoteIsWeth: false,
      quoteDecimals: String(Number(await big(quote, sel("decimals()")))), sharingSince: String(since),
      rules: { version: "1", exclusions, keeperKeys: [], ammFactories: [] },
      contracts: {}, keeperTxs: [], opening: { block: String(first - 1), balances: {} }, timestamps, transfers,
    },
    epochs: [],
  };
  for (const a of attempts) {
    vector.epochs.push({ input: {
      toBlock: String(a.T), harvestTx: a.harvestTx, uri: a.uri, vetoed: false,
      received0: a.received0.toString(),
      received1: a.received1.toString(),
      price: null,
    } });
  }
  return s.runVector(vector);
}
const ROOT = T.tuple([T.bytesN(32), T.bytesN(32), T.uint(128), T.uint(128), T.uint(128), T.uint(64), T.uint(64), T.uint(32), T.uint(40)]);
async function publish(d, result, uri) {
  const r = result.root;
  const data = sel("publish(address,(bytes32,bytes32,uint128,uint128,uint128,uint64,uint64,uint32,uint40),string)") +
    encode([T.address, ROOT, T.string], [d, [r.merkleRoot, r.contentHash, r.cumHolders0, r.cumHolders1, r.cumKeeper0,
      r.fromBlock, r.toBlock, r.epoch, 0n], uri]).slice(2);
  return sendMined({ from: PUBLISHER, to: APP.sharing, data });
}
async function harvest(d) {
  // A MINUTE OF HOLDING FIRST. Weight is balance times the seconds between
  // blocks, and this node mines blocks within one second of each other: without
  // it the holders' weight could be zero, and the epoch none.
  await later(60);
  const rc = await sendMined({ from: OWNER, to: d, data: sel("harvest()") });
  // WHAT THE DISTRIBUTOR HAS RECEIVED AT T, read while T is still the newest
  // block: this node does not keep every block's state for good, and a read at
  // an older block can come back as a revert.
  const T = parseInt(rc.blockNumber, 16);
  const [received0, received1] = [await big(d, sel("received0()")), await big(d, sel("received1()"))];
  expect(parseInt(await rpc("eth_blockNumber", []), 16), "a block was mined after the harvest before its figures were read").toBe(T);
  return { T, harvestTx: rc.transactionHash, received0, received1 };
}
const leafOf = (result, who) => {
  const l = result.file.merkle.leaves.find((x) => x[1] === who.toLowerCase());
  return l ? { cum0: BigInt(l[2]), cum1: BigInt(l[3]) } : { cum0: 0n, cum1: 0n };
};

// ------------------------------------------------------------------ what the tests share
const L = { token: null, d: null, attempts: [], results: [], files: {}, holder2: null, other: null };
const fmtOn = (p, v) => p.evaluate(([x]) => window.CurbApp.fmtSmall(BigInt(x), window.CurbApp.state.ctx.quoteDecimals, 6), [String(v)]);
/// A curve buy of `amount` NVDAc by `who`, straight to the curve.
async function curveBuy(token, who, amount) {
  const view = await ethCall(APP.lens, sel("launchState(address)") + pad(token));
  const curve = addrOf("0x" + view.slice(2 + 64, 2 + 128));
  await sendMined({ from: who, to: NVDAC, data: sel("approve(address,uint256)") + pad(curve) + word(amount) });
  // GAS GIVEN, NOT ESTIMATED: a buy that crosses the threshold graduates the
  // launch inside a try, and an estimate finds the cheaper path where that try
  // failed.
  await sendMined({ from: who, to: curve, gas: "0x1c9c380",
    data: sel("buy(uint256,uint256,address)") + word(amount) + word(0) + pad(who) });
}
/// A launch made through the form, its creator wallet `creator`, sharing off.
async function launchFor(creator, name, symbol) {
  const p = await openForm(OWNER);
  const adv = p.locator("#advanced");
  if (!(await adv.evaluate((d) => d.open))) await adv.locator("summary").click();
  await p.fill("#nCreator", creator);
  await p.fill("#nName", name);
  await p.fill("#nSymbol", symbol);
  await p.click("#create");
  await expect(p.locator("#msg")).toContainText("Launched", { timeout: 90_000 });
  const token = await p.evaluate(() => window.CurbApp.state.chainCfg.token);
  await p.close();
  return token;
}

// ================================================================== the bundle
test("the calculator the site serves is services/sharer's own browser build, served as JavaScript", async ({ request }) => {
  const site = fs.readFileSync(path.join(__dirname, "..", "curb-share.mjs"));
  const own = fs.readFileSync(path.join(__dirname, "..", "..", "services", "sharer", "browser", "curb-share.mjs"));
  expect(site.equals(own), "web/curb-share.mjs is not services/sharer/browser/curb-share.mjs: copy it again").toBe(true);
  const res = await request.get("/curb-share.mjs");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toMatch(/javascript/);
});

// ================================================================== the form's choice
test("the launch form's choice: You, the launch's last field is zero; Holders, the five statements, and the catalog's recommended version in that field", async () => {
  test.setTimeout(180_000);
  const recommended = addrOf(await ethCall(APP.catalog, sel("recommended()")));
  expect(/^0x0{40}$/.test(recommended), "the catalog recommends no version, so this proves nothing").toBe(false);
  const p = await openForm(OWNER);
  // OFF BY DEFAULT, and its terms are not shown.
  await expect(p.locator("#nShare")).not.toBeChecked();
  await expect(p.locator("#nShare")).toBeEnabled();
  await expect(p.locator("#shareTerms")).toBeHidden();
  await expect(p.locator("#shareOff")).toBeVisible();
  await p.fill("#nName", "Shared Fees");
  await p.fill("#nSymbol", "SHRF");
  await captureAndDecline(p);
  await p.click("#create");
  await expect(p.locator("#msg")).toContainText("you declined", { timeout: 60_000 });
  let tx = await p.evaluate(() => window.__tx);
  expect(tx && tx.data.slice(0, 10), "the launch was not what the wallet was asked for").toBe(LAUNCH_SEL);
  expect(shareFieldOf(tx.data), "a launch with sharing off carried a distributor version").toBe("0x" + "0".repeat(40));

  // ON: THE FIVE STATEMENTS, IN FULL, and the version named.
  await p.click("label.shareToggle");
  await expect(p.locator("#nShare")).toBeChecked();
  await expect(p.locator("#shareTerms")).toBeVisible();
  // ONE CHOICE OF TWO, NOT A TOGGLE: the chosen one pressed again keeps the
  // choice, "You" takes it back, "Holders" gives it again - by mouse, and by
  // Space and the arrow keys as on any radio pair.
  await expect(p.locator("#earnYouPick")).not.toBeChecked();
  await p.click("#earnHolders");
  await expect(p.locator("#nShare")).toBeChecked();
  await p.locator("#nShare").press("Space");
  await expect(p.locator("#nShare")).toBeChecked();
  await p.click("#earnYou");
  await expect(p.locator("#nShare")).not.toBeChecked();
  await expect(p.locator("#earnYouPick")).toBeChecked();
  await expect(p.locator("#shareTerms")).toBeHidden();
  await expect(p.locator("#shareOff")).toBeVisible();
  await expect(p.locator("#shareLater")).toBeVisible();
  await p.click("#earnYou");
  await expect(p.locator("#nShare")).not.toBeChecked();
  await expect(p.locator("#earnYouPick")).toBeChecked();
  await p.locator("#earnYouPick").press("ArrowRight");
  await expect(p.locator("#nShare")).toBeChecked();
  await expect(p.locator("#shareTerms")).toBeVisible();
  await p.click("#earnYou");
  await p.click("#earnHolders");
  await expect(p.locator("#nShare")).toBeChecked();
  await expect(p.locator("#shareZero")).toHaveText("Your creator share becomes 0%, permanently.");
  await expect(p.locator("#shareWhat")).toHaveText(/Holders receive your tax share, before and after graduation, plus the locked\s+position's LP fees\./);
  await expect(p.locator("#sharePrincipal")).toHaveText("The LP principal stays locked forever; nobody can withdraw it.");
  await expect(p.locator("#shareHow")).toHaveText(/Shares are time-weighted and paid about hourly\. At most 2% of each payout covers\s+gas\. Every payout is public and can be stopped by CURB for 1 hour\./);
  // AND THAT PAYOUTS NEED CURB'S KEEPER, said where the switch is thrown (audit, item 25).
  await expect(p.locator("#sharePublisher")).toHaveText(/^Payouts need CURB's keeper to keep publishing them; unpaid shares wait in the\s+distributor\.$/);
  await expect(p.locator("#shareNever")).toHaveText("Unclaimed shares never expire.");
  // AND THAT CURB CAN FREEZE THEM, in one line that links to the whole list,
  // in a new tab so the form is kept. Who the vetoers are is the docs' to say.
  await expect(p.locator("#shareLimits")).toHaveText("CURB can also freeze payouts: what CURB can and cannot do.");
  await expect(p.locator("#shareLimits a")).toHaveAttribute("href", "docs.html#what-curb-can-and-cannot-do");
  await expect(p.locator("#shareLimits a")).toHaveAttribute("target", "_blank");
  await expect(p.locator("#shareVersion")).toContainText(recommended, { ignoreCase: true });
  await expect(p.locator("#shareVersion")).toContainText("version 1");
  // AND THE SPLIT SAYS WHOSE IT IS.
  await expect(p.locator("#sumYours")).toContainText("0% ·");
  await expect(p.locator("#sumYours")).toContainText("to holders");
  await expect(p.locator("#taxSplit")).toContainText("· holders 0.5%");
  await expect(p.locator("#taxSplit")).toContainText("to the holders.");
  await expect(p.locator("#taxSplit")).not.toContainText("you");
  await p.evaluate(() => { window.__tx = null; });
  await p.click("#create");
  // A NEW REFUSAL, not the last one's line: the wallet was asked again.
  await expect.poll(() => p.evaluate(() => !!window.__tx), { timeout: 60_000, message: "the wallet was not asked again" }).toBe(true);
  await expect(p.locator("#msg")).toContainText("you declined", { timeout: 60_000 });
  tx = await p.evaluate(() => window.__tx);
  expect(shareFieldOf(tx.data), "the launch did not carry the recommended version").toBe(recommended.toLowerCase());

  // AND SENT: the launch shares from its first block.
  await stopDeclining(p);
  await p.click("#create");
  await expect(p.locator("#msg")).toContainText("Launched", { timeout: 90_000 });
  const token = await p.evaluate(() => window.CurbApp.state.chainCfg.token);
  const d = addrOf(await ethCall(APP.graduator, sel("holderDistributorOf(address)") + pad(token)));
  expect(d, "the launch's sharing is off").not.toBe("0x" + "0".repeat(40));
  expect(d, "the distributor is not the recommended version's for this token")
    .toBe(addrOf(await ethCall(recommended, sel("predict(address)") + pad(token))));
  L.token = token;
  L.d = d;
  await shot(p, "form-toggle-on");
  await p.close();
});

test("a version the catalog stops approving cannot be switched on from the form, and one retired while it was shown is not sent", async () => {
  test.setTimeout(120_000);
  const recommended = addrOf(await ethCall(APP.catalog, sel("recommended()")));
  await inSnapshot(async () => {
    // SHOWN, THEN RETIRED BEHIND THE PAGE'S BACK.
    const p = await openForm(OWNER);
    await p.click("label.shareToggle");
    await expect(p.locator("#shareTerms")).toBeVisible();
    await sendMined({ from: OWNER, to: APP.catalog, data: sel("retire(address)") + pad(recommended) });
    await p.fill("#nName", "Retired Share");
    await p.fill("#nSymbol", "RTSH");
    const before = await p.evaluate(() => window.ethereum.sent.length);
    await p.click("#create");
    await expect(p.locator("#msg")).toContainText("Nothing was sent", { timeout: 60_000 });
    await expect(p.locator("#msg")).toContainText("The holder sharing version changed while you were filling this in");
    expect(await p.evaluate(() => window.ethereum.sent.length), "a launch was sent with a retired version").toBe(before);
    // THE REFRESH AFTER THE REFUSAL READ THE CATALOG AGAIN: the toggle is off,
    // and cannot be turned on.
    await expect(p.locator("#nShare")).not.toBeChecked({ timeout: 30_000 });
    await expect(p.locator("#nShare")).toBeDisabled();
    // ...and the choice went back to You, not to neither of the two; the
    // promise of a later switch waits for a version to switch to.
    await expect(p.locator("#earnYouPick")).toBeChecked();
    await expect(p.locator("#shareLater")).toBeHidden();
    // READ AGAIN: the toggle cannot be turned on, and says why.
    await p.reload();
    await p.evaluate(() => window.CurbApp.connect());
    await expect(p.locator("#nShare")).toBeDisabled({ timeout: 30_000 });
    await expect(p.locator("#nShare")).not.toBeChecked();
    await expect(p.locator("#shareUnavailable")).toContainText("no distributor version is approved");
    // A TOGGLE LEFT ON ANYWAY - set by a script, or by a page that read the
    // catalog before it changed - is refused before anything is asked.
    // (Set after the fields: any keystroke redraws the card, which turns a
    // toggle that cannot be honoured off again.)
    await p.fill("#nName", "Retired Share");
    await p.fill("#nSymbol", "RTSH");
    await p.evaluate(() => { document.getElementById("nShare").checked = true; });
    const n = await p.evaluate(() => window.ethereum.sent.length);
    await p.click("#create");
    await expect(p.locator("#msg")).toContainText("Holder sharing is not available on this deployment", { timeout: 60_000 });
    expect(await p.evaluate(() => window.ethereum.sent.length), "a launch was sent with no version approved").toBe(n);
    await p.close();
    // A CATALOG READ THAT LIES - "approved, recommended" for the retired one -
    // still sends nothing: the factory's own simulation meets the Graduator's
    // refusal, and the page says it in the Graduator's words.
    const lie = await openForm(OWNER);
    await lie.route("**/*", async (route) => {
      let m = null;
      try { m = JSON.parse(route.request().postData() || ""); } catch { m = null; }
      const c = m && !Array.isArray(m) && m.method === "eth_call" && m.params && m.params[0];
      if (c && String(c.to || "").toLowerCase() === APP.catalog.toLowerCase()) {
        const d = String(c.data || "").toLowerCase();
        const result = d.startsWith(sel("recommended()")) ? "0x" + pad(recommended)
          : d.startsWith(sel("isApproved(address)")) ? "0x" + word(1) : null;
        if (result) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) });
      }
      return route.fallback();
    });
    await lie.reload();
    await lie.evaluate(() => window.CurbApp.connect());
    await expect(lie.locator("#nShare")).toBeEnabled({ timeout: 30_000 });
    await lie.click("label.shareToggle");
    await lie.fill("#nName", "Lied Share");
    await lie.fill("#nSymbol", "LIED");
    const m = await lie.evaluate(() => window.ethereum.sent.length);
    await lie.click("#create");
    await expect(lie.locator("#msg")).toContainText("is not approved by the catalog now", { timeout: 60_000 });
    expect(await lie.evaluate(() => window.ethereum.sent.length), "a launch the Graduator refuses was sent").toBe(m);
    await lie.close();
  });
});

// ================================================================== the card, before any payout
test("a sharing launch's page says holders earn its fees, since which block, through which distributor, and the trade's tax is the holders'", async () => {
  test.setTimeout(180_000);
  expect(L.token, "the toggle test made no launch").toBeTruthy();
  const since = Number(await big(APP.graduator, sel("sharingSince(address)") + pad(L.token)));
  const p = await openToken(L.token, TRADER);
  await expect(p.locator("#tvShare")).toBeVisible({ timeout: 30_000 });
  await expect(p.locator("#tvShareBadge")).toHaveText("Holders earn");
  await expect(p.locator("#tvShare h3")).toHaveText("Holders earn this launch's fees since block " + since);
  await expect(p.locator("#tvShare .shWho")).toContainText(L.d, { ignoreCase: true });
  await expect(p.locator("#shEpoch")).toContainText("No payout yet");
  // NOBODY BUT THE CREATOR SEES THE CREATOR'S PARTS.
  await expect(p.locator("#tvEnableShare")).toHaveCount(0);
  await expect(p.locator("#tvCreatorAfter")).toHaveCount(0);
  // NOT ON THE TRADE PAGE ITSELF (the owner's call): only when asked for by name.
  await p.evaluate(() => { history.replaceState(null, "", location.pathname + location.search); window.dispatchEvent(new HashChangeEvent("hashchange")); });
  await expect(p.locator("#tvShare")).toBeHidden({ timeout: 30_000 });
  await p.evaluate(() => { location.hash = "#holders"; });
  await expect(p.locator("#tvShare")).toBeVisible({ timeout: 30_000 });
  // A TRADE'S TAX IS SAID TO BE THE HOLDERS'.
  const pick = p.locator(".tvAsset.tvPick");
  if ((await pick.count()) && (await pick.textContent()).trim() === "ETH") {
    await pick.click();
    await p.locator('#tvMenu button[data-choice="asset"]').click();
  }
  await p.fill("#tvPay", "2");
  await expect(p.locator("#tvQuote")).toContainText("Fee, and tax for holders, taken from this trade", { timeout: 30_000 });
  // AND THE TRADE'S REPORT, once it went through.
  await expect(p.locator("#tvAct")).toBeEnabled({ timeout: 30_000 });
  await p.click("#tvAct");
  await expect(p.locator("#msg")).toContainText("tax for holders", { timeout: 90_000 });
  await expect(p.locator("#msg")).not.toContainText("creator tax");
  await p.close();
  // THE LONG PAGE'S ROW TOO.
  const lp = await newPage(TRADER);
  await lp.goto("/app.html?" + new URLSearchParams({ rpc: STATE.rpc, factory: APP.factory, lens: APP.lens, token: L.token }).toString());
  await lp.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
  await lp.evaluate(() => window.CurbApp.connect());
  await expect(lp.locator("#curveBox")).toBeVisible({ timeout: 30_000 });
  await lp.selectOption("#curveVia", "quote").catch(() => {});
  await lp.fill("#curveAmount", "1");
  await expect(lp.locator("#curveQuote")).toContainText("tax for holders", { timeout: 30_000 });
  await expect(lp.locator("#curveQuote")).not.toContainText("creator fee");
  await lp.close();
  // TWO HOLDERS, and a third who holds by transfer.
  await curveBuy(L.token, TRADER, 3n * 10n ** 8n);
  L.holder2 = await freshAccount("holder two");
  const tok = await balanceOf(L.token, TRADER);
  await sendMined({ from: TRADER, to: L.token, data: sel("transfer(address,uint256)") + pad(L.holder2) + word(tok / 3n) });
  L.other = await freshAccount("claim-to target");
});

// ================================================================== a payout
test("a published payout waits its hour on the page, then the holder's Claim pays exactly their leaf", async () => {
  test.setTimeout(240_000);
  const h = await harvest(L.d);
  expect(await big(L.d, sel("received0()")), "the harvest brought nothing in, so this proves nothing").toBeGreaterThan(0n);
  L.attempts.push({ ...h, uri: URI(1) });
  const res = await computeEpochs(L.token, L.d, L.attempts);
  const e1 = res[0];
  expect(e1.result, "no epoch came out of the chain's figures").toBe("epoch");
  L.results = res;
  L.files[1] = e1.fileBytes;
  await publish(L.d, e1, URI(1));
  const mine = leafOf(e1, TRADER);
  expect(mine.cum0, "the trader has no share in the payout, so this proves nothing").toBeGreaterThan(0n);

  // ---- IN ITS HOUR: published, counting down, what it adds said.
  let p = await openToken(L.token, TRADER, { site: L.files });
  await expect(p.locator("#shPendingLine")).toContainText("Epoch 1 is published and pays in", { timeout: 30_000 });
  await expect(p.locator("#shCountdown")).toHaveText(/^\d+m \d\ds$/);
  await expect(p.locator("#shPendingMine")).toContainText("Epoch 1, published and waiting its hour, adds " + await fmtOn(p, mine.cum0));
  await expect(p.locator("#shClaim")).toBeDisabled();
  await expect(p.locator("#shVetoed"), "the payout waiting its hour was called vetoed").toHaveCount(0);
  await shot(p, "card-pending");
  await p.close();

  // ---- FROZEN WITH ITS HOUR OVER: the holder's own line waits for the
  // unfreeze too, as the distributor's line says - not "waiting its hour".
  await inSnapshot(async () => {
    await sendMined({ from: VETOER, to: APP.sharing, data: sel("freeze()") });
    await later(3601);
    const q = await openToken(L.token, TRADER, { site: L.files });
    await expect(q.locator("#shPendingLine")).toContainText("pays once publishing is unfrozen", { timeout: 30_000 });
    await expect(q.locator("#shPendingMine")).toHaveText("Epoch 1 adds " + await fmtOn(q, mine.cum0) + " NVDAc to your share once publishing is unfrozen, unless it is vetoed.");
    await q.close();
  });

  // ---- THE HOUR OVER: claimable, and Claim pays the leaf.
  await later(3601);
  p = await openToken(L.token, TRADER, { site: L.files });
  await expect(p.locator("#shClaimable")).toHaveText((await fmtOn(p, mine.cum0)) + " NVDAc", { timeout: 30_000 });
  await expect(p.locator("#shEarned")).toHaveText((await fmtOn(p, mine.cum0)) + " NVDAc");
  await expect(p.locator("#shMePaid")).toHaveText("0 NVDAc");
  await expect(p.locator("#shAccumulating")).toContainText("about $0.05");
  // AN ADDRESS THE ISSUER LETS RECEIVE IS NOT OFFERED ANOTHER ONE.
  await expect(p.locator("#shClaimToAct")).toHaveCount(0);
  await shot(p, "card-holder");
  const before = await balanceOf(NVDAC, TRADER);
  await p.click("#shClaim");
  await expect(p.locator("#msg")).toContainText("Claimed " + (await fmtOn(p, mine.cum0)) + " NVDAc from epoch 1", { timeout: 90_000 });
  expect(await big(L.d, sel("paid0(address)") + pad(TRADER)), "paid0 is not the leaf's cum0").toBe(mine.cum0);
  expect(await balanceOf(NVDAC, TRADER) - before, "the trader was not paid exactly the leaf").toBe(mine.cum0);
  await expect(p.locator("#shActiveLine")).toContainText("In force: epoch 1", { timeout: 30_000 });
  await expect(p.locator("#shClaim")).toBeDisabled({ timeout: 30_000 });
  await p.close();
});

// ================================================================== verify
test("the verify panel checks a payout's file against the chain: from the site, from a gateway when the site has none, and a tampered copy is rejected", async () => {
  test.setTimeout(180_000);
  const good = L.files[1];
  const run = async (files) => {
    const p = await openToken(L.token, TRADER, files);
    await expect(p.locator("#tvVerify")).toBeVisible({ timeout: 30_000 });
    await p.locator("#tvVerify > summary").click();
    // THE PANEL STAYS OPEN THROUGH THE CARD'S REDRAW.
    await p.evaluate(() => window.CurbSharingToken.refresh());
    await expect(p.locator("#tvVerify"), "the redraw folded the panel up").toHaveAttribute("open", "");
    await p.click("#shVerifyAct");
    await expect(p.locator("#shVerdict")).toBeVisible({ timeout: 60_000 });
    return p;
  };
  // ---- FROM THE SITE: every step holds, and the holder's own leaf proves.
  let p = await run({ site: { 1: good } });
  await expect(p.locator("#shVerdict")).toHaveText("Epoch 1's file checks out against the chain.");
  for (const k of ["fetch", "hash", "root", "totals", "leaf"]) {
    await expect(p.locator(`#shChecks li[data-step="${k}"]`), k).toHaveClass("ok");
  }
  await expect(p.locator('#shChecks li[data-step="fetch"]')).toContainText("/sharing/" + CHAIN + "/" + L.d.toLowerCase() + "/1.json");
  // THE COMMAND THAT RUNS: services/sharer's own CLI with the flags it needs -
  // this site's published config and files - and no npm name nobody publishes.
  const origin = new URL(p.url()).origin;
  await expect(p.locator("#shCli")).toHaveText("node src/cli.ts verify --distributor " + L.d + " --epoch 1 --rpc <your RPC> --rpc <a second RPC>" +
    " --config " + origin + "/sharing/" + CHAIN + "/config.json --site " + origin, { ignoreCase: true });
  await expect(p.locator("#tvVerify")).toContainText("In services/sharer of the CURB repository");
  await expect(p.locator("#tvVerify")).not.toContainText("npx");
  await shot(p, "verify-ok");
  await p.close();
  // ---- THE SITE HAS NONE: the gateway's copy, for the URI the chain recorded.
  p = await run({ site: {}, ipfs: { 1: good } });
  await expect(p.locator("#shVerdict")).toHaveText("Epoch 1's file checks out against the chain.");
  await expect(p.locator('#shChecks li[data-step="fetch"]')).toContainText("ipfs/bafkreicurbsharinge2eepoch1");
  await p.close();
  // ---- TAMPERED: one account's share made larger. The hash and the sums fail.
  const text = Buffer.from(good).toString("utf8");
  const f = JSON.parse(text);
  const row = f.accounts.find((a) => a.a === TRADER.toLowerCase());
  const bad = text.replace('"s0":"' + row.s0 + '"', '"s0":"' + (BigInt(row.s0) + 1n) + '"');
  expect(bad, "the tampering changed nothing").not.toBe(text);
  p = await run({ site: { 1: Buffer.from(bad, "utf8") } });
  await expect(p.locator("#shVerdict")).toContainText("does NOT check out");
  await expect(p.locator('#shChecks li[data-step="hash"]')).toHaveClass("bad");
  await expect(p.locator('#shChecks li[data-step="hash"]')).toContainText("is not the on-chain contentHash");
  await expect(p.locator(".shProblems")).toContainText("s0");
  // AND THE PAGE DOES NOT PAY FROM IT: the holder panel has no checked file.
  await expect(p.locator("#shActiveLine")).toContainText("could not be fetched and checked");
  await shot(p, "verify-tampered");
  await p.close();
  // ---- TAMPERED IN THE LEAF ITSELF: the trader's cumulative value made larger.
  // The file writes no leaves: a leaf is its row's [D, a, cum0, cum1], rebuilt
  // by whoever reads it (spec README 2, `merkle`). So the trader's cum0 is in
  // one place, its row in `accounts` - the rows are in the file itself up to
  // 512 of them; `weights`, `stateAtEnd` and the window do not carry it - and
  // changing it there changes the leaf. The tree, the sums and the trader's own
  // proof then no longer match the chain.
  expect(f.chunks, "the file keeps its rows in chunks, so the trader's row is not in it").toEqual([]);
  expect(BigInt(row.cum0), "the trader's row is not the leaf the chain's root commits to").toBe(leafOf(L.results[0], TRADER).cum0);
  // The row as the canonical file writes it: keys sorted, no space.
  const canon = (o) => "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + JSON.stringify(o[k])).join(",") + "}";
  const was = canon(row);
  expect(text.split(was).length - 1, "the trader's row is not written once in the file").toBe(1);
  const more = (BigInt(row.cum0) + 7n).toString();
  const bad2 = text.replace(was, canon({ ...row, cum0: more }));
  // Still a well-formed file, read the way the page reads it, whose leaf for
  // the trader holds the larger value.
  const tampered = (await share()).parseEpochFile(new Uint8Array(Buffer.from(bad2, "utf8")));
  const leaf = tampered.merkle.leaves.find((x) => x[1] === TRADER.toLowerCase());
  expect(leaf && leaf[2], "the leaf was not tampered").toBe(more);
  p = await run({ site: { 1: Buffer.from(bad2, "utf8") } });
  await expect(p.locator("#shVerdict")).toContainText("does NOT check out");
  for (const k of ["hash", "root", "totals", "leaf"]) {
    await expect(p.locator(`#shChecks li[data-step="${k}"]`), k).toHaveClass("bad");
  }
  await p.close();
});

// ================================================================== claim to another address
test("a holder the issuer blocks is offered Claim to another address of theirs, and it pays that address exactly the leaf", async () => {
  test.setTimeout(180_000);
  const e1 = L.results[0];
  const mine = leafOf(e1, L.holder2);
  expect(mine.cum0, "the second holder has no share, so this proves nothing").toBeGreaterThan(0n);
  await inSnapshot(async () => {
    await blockReceiving(L.holder2);
    const p = await openToken(L.token, L.holder2, { site: L.files });
    await expect(p.locator("#shBlockedNote")).toContainText("does not let this address receive it", { timeout: 30_000 });
    await expect(p.locator("#shClaimToAct")).toBeVisible();
    await shot(p, "card-claim-to");
    // A PLAIN CLAIM IS REFUSED BEFORE ANYTHING IS SENT, in the contract's words.
    const before = await p.evaluate(() => window.ethereum.sent.length);
    await p.click("#shClaim");
    await expect(p.locator("#msg")).toContainText("The claim would revert", { timeout: 60_000 });
    await expect(p.locator("#msg")).toContainText("was refused");
    expect(await p.evaluate(() => window.ethereum.sent.length), "a claim that must revert was sent").toBe(before);
    // AN ADDRESS THE DISTRIBUTOR NEVER PAYS IS REFUSED TOO, and so is no
    // address, this address, and one the issuer blocks as well.
    await p.fill("#shClaimTo", POOL_MANAGER);
    await p.click("#shClaimToAct");
    await expect(p.locator("#msg")).toContainText("is an address the distributor refuses to pay", { timeout: 60_000 });
    await p.fill("#shClaimTo", "nope");
    await p.click("#shClaimToAct");
    await expect(p.locator("#msg")).toContainText("Enter the address to be paid at", { timeout: 60_000 });
    await p.fill("#shClaimTo", L.holder2);
    await p.click("#shClaimToAct");
    await expect(p.locator("#msg")).toContainText("That is this address", { timeout: 60_000 });
    const blockedToo = await freshAccount("blocked target");
    await blockReceiving(blockedToo);
    await p.fill("#shClaimTo", blockedToo);
    await p.click("#shClaimToAct");
    await expect(p.locator("#msg")).toContainText("receive NVDAc either", { timeout: 60_000 });
    expect(await p.evaluate(() => window.ethereum.sent.length), "a refused claim-to was sent").toBe(before);
    // TO ANOTHER ADDRESS OF THEIRS.
    const to0 = await balanceOf(NVDAC, L.other);
    // AND WHEN THE ISSUER'S POLICY READ SAYS YES BUT THE TRANSFER IS REFUSED -
    // the claim, simulated, is what tells - the other address is offered all
    // the same.
    const q = await newPage(L.holder2);
    await q.route("**/*", async (route) => {
      let m = null;
      try { m = JSON.parse(route.request().postData() || ""); } catch { m = null; }
      const c = m && !Array.isArray(m) && m.method === "eth_call" && m.params && m.params[0];
      if (c && String(c.to || "").toLowerCase() === POLICY_REGISTRY && String(c.data || "").includes(pad(L.holder2))) {
        return route.fulfill({ status: 200, contentType: "application/json",
          body: JSON.stringify({ jsonrpc: "2.0", id: m.id, result: "0x" + word(1) }) });
      }
      return route.fallback();
    });
    await serveFiles(q, { site: L.files });
    await q.goto("/token/" + L.token + "?" + new URLSearchParams({ rpc: STATE.rpc, lens: APP.lens }).toString() + "#holders");
    await q.evaluate(() => window.CurbApp.connect());
    await expect(q.locator("#shClaimToAct"), "a refused transfer did not offer another address").toBeVisible({ timeout: 30_000 });
    await expect(q.locator("#shBlockedNote")).toContainText("A claim to this address was refused");
    await q.close();
    await p.fill("#shClaimTo", L.other);
    // AN ADDRESS BEING TYPED OUTLIVES THE CARD'S REDRAW.
    await p.evaluate(() => window.CurbSharingToken.refresh());
    await expect(p.locator("#shClaimTo"), "the redraw wiped the address typed").toHaveValue(L.other);
    await p.click("#shClaimToAct");
    await expect(p.locator("#msg")).toContainText("paid to " + L.other, { timeout: 90_000 });
    expect(await big(L.d, sel("paid0(address)") + pad(L.holder2)), "the leaf was not booked as paid").toBe(mine.cum0);
    expect(await balanceOf(NVDAC, L.other) - to0, "the other address was not paid exactly the leaf").toBe(mine.cum0);
    await p.close();
  });
});

// ================================================================== push
test("Push pending payouts pays every holder still owed by the payout in force, from any account", async () => {
  test.setTimeout(180_000);
  const e1 = L.results[0];
  const owed = e1.file.merkle.leaves.filter((l) => l[1] !== TRADER.toLowerCase());
  expect(owed.length, "nobody is owed, so this proves nothing").toBeGreaterThan(0);
  const pusher = await freshAccount("pusher");
  const p = await openToken(L.token, pusher, { site: L.files });
  await expect(p.locator("#shPushNote")).toContainText(owed.length + " holder", { timeout: 30_000 });
  await expect(p.locator("#shActiveLine")).toContainText("Paying: 1 of " + e1.file.merkle.leaves.length + " holders paid in full");
  await expect(p.locator("#shPush")).toBeEnabled();
  await p.click("#shPush");
  await expect(p.locator("#msg")).toContainText("Pushed: " + owed.length + " holder", { timeout: 90_000 });
  for (const l of owed) {
    expect(await big(L.d, sel("paid0(address)") + pad(l[1])), "a holder was not pushed their share: " + l[1]).toBe(BigInt(l[2]));
  }
  await expect(p.locator("#shActiveLine")).toContainText("Every holder in it is paid", { timeout: 30_000 });
  await expect(p.locator("#shPush")).toBeDisabled();
  await p.close();
});

// ================================================================== paid to holders
/// web/config.js AS DEPLOY DAY WRITES IT, naming this run's full-flow stack
/// (prod.spec.js standIn): a page whose link names no endpoint reads the site's
/// own - the only one on which it reads stats.json (token.js statsFile,
/// browse.js readStats) - with any of its fields as `over` says.
let SITE_CONFIG = null;
async function asTheSite(p, over = {}) {
  if (!SITE_CONFIG) {
    const registry = addrOf(await ethCall(APP.lens, sel("registry()")));
    const n = Number(await big(registry, sel("launcherCount()")));
    const factories = [];
    for (let i = 0; i < n; i++) factories.push(addrOf(await ethCall(registry, sel("launcherAt(uint256)") + word(i))));
    SITE_CONFIG = { chainId: CHAIN, rpc: STATE.rpc, lens: APP.lens, registry, factories,
      explorer: "https://basescan.org", featured: [], banner: "", hiddenFactories: [], hiddenLaunches: [] };
  }
  const body = "window.CURB_SITE = " + JSON.stringify({ ...SITE_CONFIG, ...over }) + ";";
  await p.route(/\/config\.js(\?.*)?$/, (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body }));
}
/// stats.json AS THE HISTORY INDEX WRITES IT (services/sharer/scripts/
/// index-history.ts), its `launches` given - null serves none at all - at the
/// site's path, naming the chain that path names, and any of the file's own
/// fields as `file` says (a schema or a chain it is not). What comes back
/// counts the fetches.
async function serveStats(p, launches, file = {}) {
  const asked = { n: 0 };
  await p.route(/\/sharing\/\d+\/stats\.json$/, (route) => {
    asked.n++;
    if (launches === null) return route.fulfill({ status: 404, body: "not found" });
    const chainId = Number(/\/sharing\/(\d+)\/stats\.json$/.exec(route.request().url())[1]);
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ schema: "curb.stats/1", chainId,
      generatedAt: { block: 1, timestamp: 1 }, launches, totals: {}, ...file }) });
  });
  return asked;
}
const ZERO_ADDR = "0x" + "0".repeat(40);
/// ONE LAUNCH'S ENTRY, read from this chain as the index reads it: its curve,
/// asset and decimals from the lens and the asset, and - given - holderSharing.
async function entryFor(token, holderSharing) {
  const view = await ethCall(APP.lens, sel("launchState(address)") + pad(token));
  const quote = addrOf("0x" + view.slice(2 + 128, 2 + 192));
  return { curve: addrOf("0x" + view.slice(2 + 64, 2 + 128)), quote, quoteDecimals: Number(await big(quote, sel("decimals()"))),
    status: "selling", firstTradeBlock: null, lastTradeBlock: null, curveBuys: 0, curveSells: 0, buyers: 0, traders: 0,
    curveVolume: "0", poolSwaps: 0, poolVolume: "0", holders: 0, ...(holderSharing ? { holderSharing } : {}) };
}
/// WHAT THE DISTRIBUTOR HAS PAID, as the index reads it each run (paidBy).
const paidBy = async (d) => ({ distributor: d.toLowerCase(), paidQuote: String(await big(d, sel("totalPaid0()"))),
  paidToken: String(await big(d, sel("totalPaid1()"))) });
/// AN ENDPOINT OF ANOTHER NAME FOR THE RUN'S NODE, served through Playwright
/// (prod.spec.js routeEndpoint): what a link to some other endpoint reads.
const OTHER_ENDPOINT = "http://another-endpoint.test";
async function routeEndpoint(p, url) {
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST, OPTIONS" };
  await p.route(new RegExp("^" + url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(/.*)?$"), async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const res = await fetch(STATE.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: req.postData() });
    return route.fulfill({ status: res.status, headers: cors, contentType: "application/json", body: await res.text() });
  });
}
/// The launch's page as the site serves it, with `stats` (and `file`) as its
/// stats.json, and `site` as asTheSite takes it.
async function openAsSite(token, stats, file = {}, site = {}) {
  const p = await newPage(TRADER);
  await asTheSite(p, site);
  await serveFiles(p, { site: L.files });
  const asked = await serveStats(p, stats, file);
  await p.goto("/token/" + token);
  await expect(p.locator("#tokenView")).toBeVisible({ timeout: 15_000 });
  await expect(p.locator("#tvStatus")).not.toHaveText("—", { timeout: 30_000 });
  return { p, asked };
}
/// The Launches page as the site serves it, and the card of `token` on it -
/// with `file` as serveStats takes it, `site` as asTheSite does, and through a
/// link's endpoint `rpc` where one is given.
async function browseAsSite(stats, { file = {}, rpc = "", site = {} } = {}) {
  const p = await newPage(TRADER);
  await asTheSite(p, site);
  if (rpc) await routeEndpoint(p, rpc);
  const asked = await serveStats(p, stats, file);
  await p.goto(rpc ? "/?" + new URLSearchParams({ rpc, lens: APP.lens }).toString() : "/");
  return { p, asked, card: (token) => p.locator(".launch", { has: p.locator(`button.addr[title="${token}" i]`) }) };
}
/// WHAT OF A CARD'S LINE IS CUT OFF: wider or taller than its box, or any piece
/// of its text laid out past the box's sides or the card's.
const cutOff = (line) => line.evaluate((el) => {
  const box = el.getBoundingClientRect();
  const card = el.closest(".launch").getBoundingClientRect();
  const range = document.createRange();
  range.selectNodeContents(el);
  const past = (r, o) => r.left < o.left - 0.5 || r.right > o.right + 0.5;
  return { wide: el.scrollWidth > el.clientWidth, tall: el.scrollHeight > el.clientHeight,
    outside: [...range.getClientRects()].filter((r) => r.width > 0 && (past(r, box) || past(r, card))).length };
});
/// A PHONE'S WIDTH, and until the Launches page lays its cards two across
/// (browse.html's 560px rule): a card's line is then about 136px wide.
async function asAPhone(p, line) {
  await p.setViewportSize({ width: 375, height: 812 });
  await expect.poll(() => line.evaluate((el) => el.getBoundingClientRect().width),
    { timeout: 10_000, message: "the card is not a phone's two-across card" }).toBeLessThan(160);
}
/// Until the page has decided this launch's line with what it read (token.js
/// drawPaid's data-drawn).
const decided = (p, token) => expect(p.locator("#tvPaid")).toHaveAttribute("data-drawn", token.toLowerCase(), { timeout: 30_000 });
/// browse.js fmtQuote, for the figure a card prints.
const cardFigure = (x, d) => {
  const n = Number(x) / 10 ** d;
  if (n === 0) return "0";
  return n >= 1 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : n.toLocaleString("en-US", { maximumSignificantDigits: 3 });
};
const NVDA_FEED = "0x04689a41629776563e6822f76f2e57d148d28513";
const ETH_FEED = "0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70";
/// Dollars per whole NVDAc, by the feed the site reads (prices.js USD_FEEDS).
async function nvdaUsd() {
  const dec = Number(await big(NVDA_FEED, sel("decimals()")));
  const round = await ethCall(NVDA_FEED, sel("latestRoundData()"));
  return Number(wordAt(round, 1)) / 10 ** dec;
}

test("a launch that shares says what it paid its holders, first on its card and on its Launches card: from stats.json, in its asset and in dollars", async () => {
  test.setTimeout(180_000);
  // REAL PAYOUTS: the claim and the push before this paid epoch 1 in full.
  const paid = await big(L.d, sel("totalPaid0()"));
  expect(paid, "the distributor has paid nothing, so this proves nothing").toBeGreaterThan(0n);
  const entry = await entryFor(L.token, await paidBy(L.d));
  expect(entry.holderSharing.paidQuote).toBe(String(paid));
  const qd = entry.quoteDecimals;
  const usd = (Number(paid) / 10 ** qd) * (await nvdaUsd());
  const near = (x) => Math.abs(Number(x) - usd) <= usd * 1e-9;

  // ---- ITS OWN PAGE: at the top of its card, under its name.
  const { p, asked } = await openAsSite(L.token, { [L.token.toLowerCase()]: entry });
  await expect(p.locator("#tvPaid")).toBeVisible({ timeout: 30_000 });
  await expect(p.locator(".tvSwap > .tvHead + #tvPaid"), "not at the top of the launch's card").toHaveCount(1);
  const amount = await p.evaluate(([x, d]) => window.CurbApp.fmtSmall(BigInt(x), d, 6), [String(paid), qd]);
  await expect(p.locator("#tvPaidAmount")).toHaveText(amount + " NVDAc");
  await expect(p.locator("#tvPaid")).toHaveAttribute("data-paid", String(paid));
  // IN DOLLARS by the NVDA feed, once its rate has come.
  await expect.poll(() => p.locator("#tvPaid").getAttribute("data-usd"), { timeout: 30_000, message: "no dollars came" }).not.toBeNull();
  expect(near(await p.locator("#tvPaid").getAttribute("data-usd")), "the dollars are not the amount at the feed's price").toBe(true);
  await expect(p.locator("#tvPaidUsd")).toHaveText(/^\(~\$[\d.,]+[KMB]?\)$/);
  await expect(p.locator("#tvPaid")).toHaveText("Paid to holders: " + amount + " NVDAc " + (await p.locator("#tvPaidUsd").textContent()));
  await expect(p.locator("#tvPaid")).toHaveAttribute("title", new RegExp(String(paid) + " of NVDAc's smallest units.*" + L.d, "i"));
  expect(asked.n, "stats.json was not read once").toBe(1);
  await shot(p, "paid-token");
  await p.close();

  // ---- ITS CARD ON THE LAUNCHES PAGE: a small line under "Holders earn".
  const b = await browseAsSite({ [L.token.toLowerCase()]: entry });
  const line = b.card(L.token).locator(".holdersEarn + .paid");
  await expect(line).toBeVisible({ timeout: 30_000 });
  await expect(line).toHaveAttribute("data-paid", String(paid));
  await expect.poll(() => line.getAttribute("data-usd"), { timeout: 30_000, message: "no dollars came on the card" }).not.toBeNull();
  expect(near(await line.getAttribute("data-usd")), "the card's dollars are not the amount at the feed's price").toBe(true);
  await expect(line).toHaveText(new RegExp("^Paid to holders: " + cardFigure(paid, qd).replace(/[.]/g, "\\.") + " NVDAc \\(~\\$[\\d.,]+[KMBT]?\\)$"));
  await expect(line.locator("b")).toHaveText(cardFigure(paid, qd) + " NVDAc");
  await shot(b.p, "paid-card");
  // AT A PHONE'S WIDTH, TWO CARDS ACROSS: the line wraps, and all of it - the
  // dollars too - is inside the card. Cut to one line it read "Paid to
  // holders: 0.025 NVD…", and its title cannot be reached by touch.
  await asAPhone(b.p, line);
  expect.soft(await cutOff(line), "the line is cut off at a phone's width").toEqual({ wide: false, tall: false, outside: 0 });
  await expect(line).toContainText("(~$");
  await b.p.close();

  // ---- A LINK'S OWN ENDPOINT, NOT THE SITE'S - the same node under another
  // name: stats.json is not asked, and nothing is drawn from it.
  const q = await newPage(TRADER);
  await asTheSite(q);
  await routeEndpoint(q, OTHER_ENDPOINT);
  const notAsked = await serveStats(q, { [L.token.toLowerCase()]: entry });
  await q.goto("/token/" + L.token + "?" + new URLSearchParams({ rpc: OTHER_ENDPOINT, lens: APP.lens }).toString());
  await expect(q.locator("#tvStatus")).not.toHaveText("—", { timeout: 30_000 });
  await decided(q, L.token);
  await expect(q.locator("#tvPaid")).toBeHidden();
  expect(notAsked.n, "stats.json was read through a link's endpoint").toBe(0);
  await q.close();

  // ---- NOR ON THE LAUNCHES PAGE through a link's endpoint: a ?rpc= fork of
  // Base answers the site's chain id, and would be shown mainnet's figures.
  const r = await browseAsSite({ [L.token.toLowerCase()]: entry }, { rpc: OTHER_ENDPOINT });
  await expect(r.card(L.token).locator(".holdersEarn"), "the card was not read through the link's endpoint").toBeVisible({ timeout: 30_000 });
  await expect(r.card(L.token).locator(".paid")).toHaveAttribute("data-stats", "read", { timeout: 30_000 });
  await expect(r.card(L.token).locator(".paid")).toBeHidden();
  expect(r.asked.n, "the Launches page read stats.json through a link's endpoint").toBe(0);
  await r.p.close();
});

test("a payout past the sixth place is printed as what it is, never as 0, and a large one keeps its digits on a phone's card", async () => {
  test.setTimeout(120_000);
  const key = L.token.toLowerCase();
  // 50 OF NVDAc's SMALLEST UNITS (8 decimals, as cbBTC's) is 0.0000005: past the
  // six places App.fmt keeps, where it said "0 NVDAc" beside a dollar figure
  // that was not 0. And 5e13 of the token (18 decimals) is past the tooltip's 4.
  const base = await entryFor(L.token, null);
  const qd = base.quoteDecimals;
  expect(qd, "NVDAc has too few decimals for a figure past the sixth place").toBeGreaterThan(6);
  const tiny = { ...base, holderSharing: { distributor: L.d.toLowerCase(), paidQuote: String(5n * 10n ** BigInt(qd - 7)), paidToken: "50000000000000" } };
  const { p } = await openAsSite(L.token, { [key]: tiny });
  await expect(p.locator("#tvPaid")).toBeVisible({ timeout: 30_000 });
  const [quote, token] = await p.evaluate(([x, y, d]) => [window.CurbApp.fmtSmall(BigInt(x), d, 6), window.CurbApp.fmtSmall(BigInt(y), 18, 4)],
    [tiny.holderSharing.paidQuote, tiny.holderSharing.paidToken, qd]);
  expect([quote, token]).toEqual(["0.0000005", "0.00005"]);
  await expect.soft(p.locator("#tvPaidAmount"), "the amount").toHaveText(quote + " NVDAc");
  await expect.soft(p.locator("#tvPaidAmount"), "the amount").not.toHaveText(/^0 /);
  await expect.soft(p.locator("#tvPaid"), "the tooltip").toHaveAttribute("title", new RegExp("; and " + token.replace(".", "\\.") + " \\S+ of the token itself"));
  await expect.soft(p.locator("#tvPaid"), "the tooltip").not.toHaveAttribute("title", /; and 0 /);
  await p.close();

  // ---- A LARGE ONE, ON A PHONE'S CARD: 1,234,567.89 NVDAc and its dollars,
  // whole - cut to one line, the figure itself lost its digits.
  const large = { ...tiny, holderSharing: { ...tiny.holderSharing, paidQuote: String(123456789n * 10n ** BigInt(qd - 2)) } };
  const b = await browseAsSite({ [key]: large });
  const line = b.card(L.token).locator(".paid");
  await expect(line).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => line.getAttribute("data-usd"), { timeout: 30_000, message: "no dollars came on the card" }).not.toBeNull();
  await asAPhone(b.p, line);
  await expect(line.locator("b")).toHaveText("1,234,567.89 NVDAc");
  expect.soft(await cutOff(line), "the line is cut off at a phone's width").toEqual({ wide: false, tall: false, outside: 0 });
  await expect(line).toHaveText(/^Paid to holders: 1,234,567\.89 NVDAc \(~\$[\d.,]+[KMBT]?\)$/);
  await b.p.close();
});

test("an entry or a file that does not match what the page read itself draws nothing: another distributor, curve, asset or decimals; another schema or chain, in the file or at the endpoint", async () => {
  test.setTimeout(300_000);
  const withPaid = await entryFor(L.token, await paidBy(L.d));
  expect(BigInt(withPaid.holderSharing.paidQuote), "the distributor has paid nothing, so this proves nothing").toBeGreaterThan(0n);
  const key = L.token.toLowerCase();
  const elsewhere = "0x" + "5a".repeat(20);
  // EACH BREAKS ONE CHECK ALONE, on a launch that shares and an amount above 0
  // (the first test draws this very entry, unbroken).
  const entry = (over, sharing = {}) => ({ [key]: { ...withPaid, ...over, holderSharing: { ...withPaid.holderSharing, ...sharing } } });
  const cases = [
    ["naming another distributor", entry({}, { distributor: elsewhere }), {}],
    ["of another curve", entry({ curve: elsewhere }), {}],
    ["of another asset", entry({ quote: elsewhere }), {}],
    ["with its decimals off by one", entry({ quoteDecimals: withPaid.quoteDecimals + 1 }), {}],
    ["of another schema", entry({}), { schema: "curb.stats/2" }],
    ["of another chain", entry({}), { chainId: 1 }],
  ];
  // EVERY CASE ON BOTH PAGES, EACH FAILURE NAMED: one drawn line does not hide
  // the others.
  for (const [what, stats, file] of cases) {
    const { p, asked } = await openAsSite(L.token, stats, file);
    await decided(p, L.token);
    expect(asked.n, what + ": stats.json was not read").toBe(1);
    await expect.soft(p.locator("#tvPaid"), "the launch's page, " + what).toBeHidden();
    await expect.soft(p.locator("#tvPaid"), "the launch's page, " + what).toBeEmpty();
    await p.close();
    const b = await browseAsSite(stats, { file });
    const line = b.card(L.token).locator(".paid");
    await expect(line, what).toHaveAttribute("data-stats", "read", { timeout: 30_000 });
    expect(b.asked.n, what + ": the Launches page did not read stats.json").toBe(1);
    await expect.soft(line, "its card, " + what).toBeHidden();
    await b.p.close();
  }

  // ---- A SITE WHOSE OWN ENDPOINT ANSWERS ANOTHER CHAIN THAN ITS config.js
  // NAMES (chain 1 named; this node is Base): neither page asks for a file -
  // which, at that chain's path, says it is that chain's.
  const site = { chainId: 1 };
  const t = await openAsSite(L.token, { [key]: withPaid }, {}, site);
  await decided(t.p, L.token);
  await expect.soft(t.p.locator("#tvPaid"), "the launch's page, on another chain than config.js names").toBeHidden();
  expect.soft(t.asked.n, "the launch's page asked for stats.json on another chain than config.js names").toBe(0);
  await t.p.close();
  const c = await browseAsSite({ [key]: withPaid }, { site });
  const line = c.card(L.token).locator(".paid");
  await expect(line).toHaveAttribute("data-stats", "read", { timeout: 30_000 });
  await expect.soft(line, "its card, on another chain than config.js names").toBeHidden();
  expect.soft(c.asked.n, "the Launches page asked for stats.json on another chain than config.js names").toBe(0);
  await c.p.close();
});

test("nothing is drawn at 0, from a stats.json without the field or the launch, nor for a launch that does not share; and no dollars where none can be read", async () => {
  test.setTimeout(300_000);
  const withPaid = await entryFor(L.token, await paidBy(L.d));
  const key = L.token.toLowerCase();
  // ---- AT 0, AS THE INDEX WRITES IT BEFORE THE FIRST PAYOUT; WITHOUT THE FIELD,
  // AS A FILE FROM BEFORE IT; WITHOUT THE LAUNCH; AND NO FILE AT ALL.
  const cases = [
    ["at 0", { [key]: { ...withPaid, holderSharing: { ...withPaid.holderSharing, paidQuote: "0" } } }],
    ["without the field", { [key]: await entryFor(L.token, null) }],
    ["without the launch", {}],
    ["with no file", null],
  ];
  for (const [what, stats] of cases) {
    const { p, asked } = await openAsSite(L.token, stats);
    await decided(p, L.token);
    expect(asked.n, what + ": stats.json was not read").toBe(1);
    await expect(p.locator("#tvPaid"), what).toBeHidden();
    await expect(p.locator("#tvPaid"), what).toBeEmpty();
    await p.close();
  }
  for (const [what, stats] of cases.slice(0, 2)) {
    const b = await browseAsSite(stats);
    const line = b.card(L.token).locator(".paid");
    await expect(line, what).toHaveAttribute("data-stats", "read", { timeout: 30_000 });
    await expect(line, what).toBeHidden();
    await b.p.close();
  }

  await inSnapshot(async () => {
    // ---- A LAUNCH THAT DOES NOT SHARE, which a stats.json says paid its
    // holders: the lens is the page's, and it says the launch does not share.
    const creator = await freshAccount("paid-to-holders creator");
    const other = await launchFor(creator, "Keeps Fees", "KEEP");
    const lie = { ...(await entryFor(other, null)), holderSharing: { ...withPaid.holderSharing, paidQuote: "5000000" } };
    const both = { [key]: withPaid, [other.toLowerCase()]: lie };
    // AND ONE NAMING THE ZERO ADDRESS - the distributor this launch's view
    // names - so that only the page's own sharingOn() stands in its way.
    const zero = { ...lie, holderSharing: { ...lie.holderSharing, distributor: ZERO_ADDR } };
    for (const [what, stats] of [["naming the sharing launch's distributor", both], ["naming the zero address", { [other.toLowerCase()]: zero }]]) {
      const o = await openAsSite(other, stats);
      await decided(o.p, other);
      await expect(o.p.locator("#tvPaid"), what).toBeHidden();
      await o.p.close();
    }
    const b = await browseAsSite(both);
    await expect(b.card(L.token).locator(".paid"), "the control: the sharing launch's line").toBeVisible({ timeout: 30_000 });
    await expect(b.card(other)).toBeVisible();
    await expect(b.card(other).locator(".paid, .holdersEarn")).toHaveCount(0);
    await b.p.close();

    // ---- NO DOLLAR PRICE: neither NVDAc's feed nor ETH's answers (an empty
    // account where each was). The amount alone, never a guessed figure.
    for (const f of [NVDA_FEED, ETH_FEED]) await rpc("anvil_setCode", [f, "0x"]);
    const amount = withPaid.holderSharing.paidQuote;
    const t = await openAsSite(L.token, { [key]: withPaid });
    await expect(t.p.locator("#tvPaid")).toBeVisible({ timeout: 30_000 });
    // THE RATE WAS ASKED AND NONE CAME: the market cap is drawn in the asset's units.
    await expect(t.p.locator("#tvMcap")).toContainText("NVDAc", { timeout: 30_000 });
    await t.p.waitForTimeout(3000);
    await expect(t.p.locator("#tvPaidUsd")).toHaveCount(0);
    expect(await t.p.locator("#tvPaid").getAttribute("data-usd"), "a dollar figure with no price").toBeNull();
    const fig = await t.p.evaluate(([x, d]) => window.CurbApp.fmtSmall(BigInt(x), d, 6), [amount, withPaid.quoteDecimals]);
    await expect(t.p.locator("#tvPaid")).toHaveText("Paid to holders: " + fig + " NVDAc");
    await expect(t.p.locator("#tvPaid")).toHaveAttribute("title", /No dollar price of NVDAc could be read/);
    await shot(t.p, "paid-token-no-usd");
    await t.p.close();
    const c = await browseAsSite({ [key]: withPaid });
    const line = c.card(L.token).locator(".paid");
    await expect(line).toBeVisible({ timeout: 30_000 });
    await expect(c.card(L.token).locator(".mcVal")).toContainText("NVDAc", { timeout: 30_000 });
    await c.p.waitForTimeout(3000);
    await expect(line).toHaveText("Paid to holders: " + cardFigure(BigInt(amount), withPaid.quoteDecimals) + " NVDAc");
    expect(await line.getAttribute("data-usd"), "a dollar figure on the card with no price").toBeNull();
    await c.p.close();
  });
});

// ================================================================== history
test("a second payout: each holder's share is listed payout by payout, from the files chained back to the one in force", async () => {
  test.setTimeout(240_000);
  await curveBuy(L.token, TRADER, 2n * 10n ** 8n);
  // THE ESTIMATE, BEFORE THE HARVEST: the tax waiting on the curve (the
  // distributor is its recipient; the platform takes the whole base fee),
  // less the whole 2%, times this balance over every balance that shares -
  // here the supply less what the curve holds, the only excluded holder.
  {
    const view = await ethCall(APP.lens, sel("launchState(address)") + pad(L.token));
    const curve = addrOf("0x" + view.slice(2 + 64, 2 + 128));
    const active = await ethCall(L.d, sel("active()"));
    const pending = await ethCall(L.d, sel("pending()"));
    const root = wordAt(pending, 8) !== 0n ? pending : active;   // the ripe epoch 1 is the one in force
    const pot = (await big(L.d, sel("received0()"))) - wordAt(root, 2) - wordAt(root, 4) +
      (await big(curve, sel("creatorTaxBalance()")));
    const eligible = (await big(L.token, sel("totalSupply()"))) - (await balanceOf(L.token, curve));
    const est = ((pot * 98n) / 100n) * (await balanceOf(L.token, TRADER)) / eligible;
    expect(est, "the estimate would be zero, so this proves nothing").toBeGreaterThan(0n);
    const p0 = await openToken(L.token, TRADER, { site: L.files });
    await expect(p0.locator("#shEstimate")).toHaveText("about " + (await fmtOn(p0, est)) + " NVDAc", { timeout: 30_000 });
    await expect(p0.locator("#shEstimate + span")).toContainText("estimate");
    await p0.close();
  }
  const h = await harvest(L.d);
  L.attempts.push({ ...h, uri: URI(2) });
  const res = await computeEpochs(L.token, L.d, L.attempts);
  expect(Buffer.from(res[0].fileBytes).equals(Buffer.from(L.files[1])), "the first epoch did not compute the same again").toBe(true);
  const e2 = res[1];
  expect(e2.result).toBe("epoch");
  L.results = res;
  L.files[2] = e2.fileBytes;
  await publish(L.d, e2, URI(2));
  await later(3601);
  const p = await openToken(L.token, TRADER, { site: L.files });
  await expect(p.locator("#shActiveLine")).toContainText("In force: epoch 2", { timeout: 30_000 });
  await p.locator("#shHistory > summary").click();
  const rows = p.locator("#shHistoryTable tbody tr");
  await expect(rows).toHaveCount(2, { timeout: 30_000 });
  const row = (r) => r.file.accounts.find((a) => a.a === TRADER.toLowerCase());
  await expect(rows.nth(0)).toHaveAttribute("data-epoch", "2");
  await expect(rows.nth(0)).toContainText((await fmtOn(p, row(e2).s0)) + " NVDAc");
  await expect(rows.nth(0)).toContainText((await fmtOn(p, row(e2).cum0)) + " NVDAc");
  await expect(rows.nth(1)).toHaveAttribute("data-epoch", "1");
  await expect(rows.nth(1)).toContainText((await fmtOn(p, row(res[0]).s0)) + " NVDAc");
  await shot(p, "card-history");
  await p.close();
});

// ================================================================== warnings
test("a vetoed payout is said, and so are a freeze, an announced unfreeze, publisher and vetoer removal", async () => {
  test.setTimeout(240_000);
  await inSnapshot(async () => {
    // A THIRD ROOT, vetoed inside its hour - after the second, ripe, is made
    // the active one (anyone may).
    await sendMined({ from: TRADER, to: L.d, data: sel("activate()") });
    const active = await ethCall(L.d, sel("active()"));
    const cumH0 = wordAt(active, 2), cumH1 = wordAt(active, 3), cumK0 = wordAt(active, 4), toBlock = wordAt(active, 6);
    await rpc("evm_mine", []);
    const head = BigInt(await rpc("eth_blockNumber", []));
    const data = sel("publish(address,(bytes32,bytes32,uint128,uint128,uint128,uint64,uint64,uint32,uint40),string)") +
      encode([T.address, ROOT, T.string], [L.d, ["0x" + "11".repeat(32), "0x" + "22".repeat(32), cumH0, cumH1, cumK0,
        toBlock + 1n, head - 1n, 3n, 0n], URI(3)]).slice(2);
    await sendMined({ from: PUBLISHER, to: APP.sharing, data });
    // FROZEN, A ROOT WHOSE HOUR IS OVER STILL WAITS - and can still be vetoed.
    await sendMined({ from: VETOER, to: APP.sharing, data: sel("freeze()") });
    await later(3601);
    let p = await openToken(L.token, TRADER, { site: L.files });
    await expect(p.locator("#shPendingLine")).toContainText("pays once publishing is unfrozen", { timeout: 30_000 });
    await expect(p.locator("#shActiveLine")).toContainText("In force: epoch 2");
    await p.close();
    await sendMined({ from: VETOER, to: APP.sharing,
      data: sel("veto(address,uint32,bytes32)") + pad(L.d) + word(3) + "0".repeat(64) });
    // AND EVERY ROLE CHANGE THERE IS TO ANNOUNCE, and a new catalog version.
    await sendMined({ from: OWNER, to: APP.sharing, data: sel("announceUnfreeze()") });
    await sendMined({ from: OWNER, to: APP.sharing, data: sel("announcePublisher(address)") + pad(L.other) });
    await sendMined({ from: OWNER, to: APP.sharing, data: sel("announceKeeperPayee(address)") + pad(L.holder2) });
    await sendMined({ from: OWNER, to: APP.sharing, data: sel("announceVetoerRemoval(address)") + pad(VETOER) });
    await sendMined({ from: OWNER, to: APP.catalog, data: sel("propose(address)") + pad(APP.graduator) });
    p = await openToken(L.token, TRADER, { site: L.files });
    await expect(p.locator("#shVetoed")).toContainText("Vetoed: epoch 3", { timeout: 30_000 });
    let w = p.locator("#shWarnings");
    await expect(w).toContainText("Publishing is frozen", { timeout: 30_000 });
    await expect(w).toContainText("An end to the freeze is announced");
    await expect(w).toContainText("A new publisher, " + L.other.toLowerCase());
    await expect(w).toContainText("A new keeper payee, " + L.holder2.toLowerCase());
    await expect(w).toContainText("Removing the vetoer " + VETOER, { timeout: 60_000 });
    await expect(w).toContainText("A new distributor version, " + APP.graduator.toLowerCase(), { timeout: 60_000 });
    await shot(p, "card-warnings");
    await p.close();
    // A REMOVAL CANCELLED - the vetoer added again - is no longer warned of.
    await sendMined({ from: OWNER, to: APP.sharing, data: sel("addVetoer(address)") + pad(VETOER) });
    p = await openToken(L.token, TRADER, { site: L.files });
    w = p.locator("#shWarnings");
    await expect(w).toContainText("A new publisher", { timeout: 30_000 });
    await p.waitForTimeout(3000);
    await expect(w).not.toContainText("Removing the vetoer");
    await p.close();
    // PAST THEIR WINDOW, ANNOUNCEMENTS NOBODY CARRIED OUT ARE HISTORY; THE
    // FREEZE ITSELF IS NOT. And with the publisher revoked, there is none.
    await later(10 * 86400);
    await sendMined({ from: OWNER, to: APP.sharing, data: sel("revokePublisher()") });
    p = await openToken(L.token, TRADER, { site: L.files });
    w = p.locator("#shWarnings");
    await expect(w).toContainText("Publishing is frozen", { timeout: 30_000 });
    await expect(w).toContainText("There is no publisher");
    await expect(w).not.toContainText("A new keeper payee");
    await expect(w).not.toContainText("An end to the freeze is announced");
    await expect(w).not.toContainText("A new distributor version");
    await p.close();
  });
});

// ================================================================== /sharing
test("Holder fees lists what the connected wallet earned, token by token: earned, paid, claimable, a total, and Claim", async () => {
  test.setTimeout(120_000);
  // THE TOKEN'S OWN CARD, read at the same state: the page must agree with it.
  const t = await openToken(L.token, TRADER, { site: L.files });
  await expect(t.locator("#shEarned")).toHaveText(/NVDAc/, { timeout: 30_000 });
  const card = {
    earned: (await t.locator("#shEarned").textContent()).trim(),
    paid: (await t.locator("#shMePaid").textContent()).trim(),
    claimable: (await t.locator("#shClaimable").textContent()).trim(),
  };
  await t.close();
  expect(card.earned, "the trader earned nothing, so this proves nothing").not.toBe("0 NVDAc");

  const p = await newPage(TRADER);
  await serveFiles(p, { site: L.files });
  await p.goto("/sharing?" + new URLSearchParams({ rpc: STATE.rpc, lens: APP.lens }).toString());
  await expect(p.locator(".lede")).toHaveText("The fees your tokens earned you, by token.");
  const row = p.locator(`.shMineRow[data-token="${L.token.toLowerCase()}"]`);
  await expect(row).toBeVisible({ timeout: 60_000 });
  await expect(row.locator(".shEarnedFig b")).toHaveText(card.earned);
  await expect(row.locator(".shPaidFig b")).toHaveText(card.paid);
  await expect(row.locator(".shClaimFig b")).toHaveText(card.claimable);
  await expect(row.locator(".shWhat")).toHaveAttribute("href", new RegExp("token/" + L.token, "i"));
  await expect(row.locator(".shWhat b")).toHaveText(/^\$\S+/);
  // THE TOTAL, IN DOLLARS by the asset's own feed.
  await expect(p.locator("#shTotalEarned")).toHaveText(/^\$[\d.,]+$/);
  await expect(row.locator(".shEarnedFig .shUsd")).toHaveText(/^\$[\d.,]+$/);
  // CLAIM, ON THIS PAGE: epoch 2 is in force and nobody pushed it, so the
  // trader is owed - it pays, and the row reads nothing claimable afterwards.
  expect(card.claimable, "nothing is claimable, so the claim below proves nothing").not.toBe("0 NVDAc");
  await row.locator("button.shClaimLink").click();
  await expect(p.locator("#msg .toastTitle")).toHaveText("Claimed", { timeout: 90_000 });
  await expect(p.locator(`.shMineRow[data-token="${L.token.toLowerCase()}"] .shClaimFig b`)).toHaveText("0 NVDAc", { timeout: 60_000 });
  await expect(p.locator(`.shMineRow[data-token="${L.token.toLowerCase()}"] button.shClaimLink`)).toHaveCount(0);
  // NO EXPLANATIONS, ROLES OR CATALOG ON THIS PAGE ANY MORE (they are in the docs).
  await expect(p.locator("main")).not.toContainText("Distributor versions");
  await expect(p.locator("main")).not.toContainText("node src/cli.ts");
  await shot(p, "sharing-page");
  await p.close();

  // A WALLET THAT EARNED NOTHING: one short line.
  const n = await newPage("0xa0Ee7A142d267C1f36714E4a8F75612F20a79720");
  await serveFiles(n, { site: L.files });
  await n.goto("/sharing?" + new URLSearchParams({ rpc: STATE.rpc, lens: APP.lens }).toString());
  await expect(n.locator("#shNothing")).toHaveText("No holder fees earned yet.", { timeout: 60_000 });
  await expect(n.locator(".shMineRow")).toHaveCount(0);
  await n.close();
});

// ================================================================== the creator's switch
test("the switch after launch is the creator wallet's alone, behind a typed confirmation, and pays the creator the curve's pending tax first", async () => {
  test.setTimeout(240_000);
  // A LAUNCH WITHOUT SHARING, with tax waiting on its curve - and a creator of
  // its own, since the deployer is the platform's recipient too and a rescue
  // pays the platform its share as well.
  const creator = await freshAccount("later creator");
  const token = await launchFor(creator, "Later Share", "LTSH");
  await curveBuy(token, TRADER, 2n * 10n ** 8n);
  const view = await ethCall(APP.lens, sel("launchState(address)") + pad(token));
  const curve = addrOf("0x" + view.slice(2 + 64, 2 + 128));
  const pendingTax = await big(curve, sel("creatorTaxBalance()"));
  expect(pendingTax, "no tax waits on the curve, so this proves nothing").toBeGreaterThan(0n);

  // SOMEONE ELSE: no button - and while it does not share, the tax is the creator's.
  const q = await openToken(token, TRADER);
  await expect(q.locator("#tvFeeWho")).toContainText("Paid to", { timeout: 30_000 });
  await expect(q.locator("#tvFeeWho")).not.toContainText("(you)");
  await expect(q.locator("#tvEnableShare")).toHaveCount(0);
  await expect(q.locator("#tvShare")).toBeHidden();
  const pick = q.locator(".tvAsset.tvPick");
  if ((await pick.count()) && (await pick.textContent()).trim() === "ETH") {
    await pick.click();
    await q.locator('#tvMenu button[data-choice="asset"]').click();
  }
  await q.fill("#tvPay", "1");
  await expect(q.locator("#tvQuote")).toContainText("Fee and tax, taken from this trade", { timeout: 30_000 });
  await q.close();
  const lq = await newPage(TRADER);
  await lq.goto("/app.html?" + new URLSearchParams({ rpc: STATE.rpc, factory: APP.factory, lens: APP.lens, token }).toString());
  await lq.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
  await lq.evaluate(() => window.CurbApp.connect());
  await expect(lq.locator("#curveBox")).toBeVisible({ timeout: 30_000 });
  await lq.selectOption("#curveVia", "quote").catch(() => {});
  await lq.fill("#curveAmount", "1");
  await expect(lq.locator("#curveQuote")).toContainText("creator fee", { timeout: 30_000 });
  await lq.close();

  // THE CREATOR: the button, and the dialog it opens.
  const p = await openToken(token, creator);
  await expect(p.locator("#tvEnableShare")).toBeVisible({ timeout: 30_000 });
  await expect(p.locator("#tvShare")).toBeHidden();
  await p.click("#tvEnableShare");
  const dlg = p.locator("#shEnableDialog");
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText("Your creator share becomes 0%, permanently.");
  await expect(dlg).toContainText("Unclaimed shares never expire.");
  await expect(p.locator("#shEnablePublisher")).toHaveText("Payouts need CURB's keeper to keep publishing them; unpaid shares wait in the distributor.");
  await expect(dlg).toContainText("Every payout is public and can be stopped by CURB for 1 hour.");
  await expect(p.locator("#shEnableLimits")).toHaveText("CURB can also freeze payouts: what CURB can and cannot do.");
  await expect(p.locator("#shEnableLimits a")).toHaveAttribute("href", "docs.html#what-curb-can-and-cannot-do");
  await expect(p.locator("#shEnablePending")).toContainText((await fmtOn(p, pendingTax)) + " NVDAc of creator tax not yet swept");
  await expect(p.locator("#shEnableAct")).toBeDisabled();
  await p.fill("#shEnableConfirm", "SHAR");
  await expect(p.locator("#shEnableAct")).toBeDisabled();
  await p.fill("#shEnableConfirm", "SHARE");
  await expect(p.locator("#shEnableAct")).toBeEnabled();
  await shot(p, "enable-modal");
  // RETIRED WHILE THE DIALOG WAS OPEN: refused, nothing sent.
  await inSnapshot(async () => {
    const rec = addrOf(await ethCall(APP.catalog, sel("recommended()")));
    await sendMined({ from: OWNER, to: APP.catalog, data: sel("retire(address)") + pad(rec) });
    const n = await p.evaluate(() => window.ethereum.sent.length);
    await p.click("#shEnableAct");
    await expect(p.locator("#msg")).toContainText("The distributor version changed while this was open", { timeout: 60_000 });
    expect(await p.evaluate(() => window.ethereum.sent.length), "a switch to a retired version was sent").toBe(n);
  });
  await p.reload();
  await p.evaluate(() => window.CurbApp.connect());
  await expect(p.locator("#tvEnableShare")).toBeVisible({ timeout: 30_000 });
  await p.click("#tvEnableShare");
  await p.fill("#shEnableConfirm", "SHARE");
  const before = await balanceOf(NVDAC, creator);
  await p.click("#shEnableAct");
  await expect(p.locator("#msg")).toContainText("Holder sharing is on", { timeout: 90_000 });
  const d = addrOf(await ethCall(APP.graduator, sel("holderDistributorOf(address)") + pad(token)));
  expect(d, "the switch did not land").not.toBe("0x" + "0".repeat(40));
  expect(addrOf(await ethCall(curve, sel("deployer()"))), "the curve does not pay the distributor").toBe(d);
  // THE CLEAN CUT: the pending tax went to the creator, in that transaction.
  expect(await balanceOf(NVDAC, creator) - before, "the creator was not paid the pending tax first").toBe(pendingTax);
  await expect(p.locator("#tvShare")).toBeVisible({ timeout: 30_000 });
  await expect(p.locator("#tvEnableShare")).toHaveCount(0);
  await expect(p.locator("#tvCreatorAfter")).toContainText("Holder sharing on since block");
  await expect(p.locator("#tvEarnedNote")).toContainText("before holder sharing");
  await expect(p.locator("#sweepCurve")).toBeHidden();
  await shot(p, "creator-after");
  await p.close();
  // MORE TRADING, AND THE DISTRIBUTOR HARVESTS: the curve's tax is the holders'
  // now. The creator's "claimable now" does not count it, and the creator's
  // "earned" stays what was paid before the switch - not the distributor's sweep.
  await curveBuy(token, TRADER, 2n * 10n ** 8n);
  expect(await big(curve, sel("creatorTaxBalance()")), "nothing waits on the curve for the holders").toBeGreaterThan(0n);
  const c2 = await openToken(token, creator);
  await expect(c2.locator("#tvClaimable")).toHaveText("0 NVDAc", { timeout: 30_000 });
  await expect(c2.locator("#tvUnswept")).toBeHidden();
  await c2.close();
  await sendMined({ from: TRADER, to: d, data: sel("harvest()") });
  const c3 = await openToken(token, creator);
  await expect(c3.locator("#tvEarned")).toHaveText((await fmtOn(c3, pendingTax)) + " NVDAc", { timeout: 30_000 });
  await c3.close();
});

// ================================================================== after graduation: held fees and the principal
test("after graduation the lock's held fees are released to the creator, and the principal stays locked forever - ten years on too", async () => {
  test.setTimeout(420_000);
  await inSnapshot(async () => {
    // A LAUNCH THAT GRADUATES WITHOUT SHARING, and trades in its pool.
    const creator = await freshAccount("graduated creator");
    const token = await launchFor(creator, "Graduate Share", "GRSH");
    const thr = await big(APP.factory, sel("graduationThreshold()"));
    await curveBuy(token, TRADER, thr * 2n);
    if ((await big(APP.graduator, sel("hasGraduated(address)") + pad(token))) !== 1n) {
      await sendMined({ from: TRADER, to: APP.graduator, gas: "0x1c9c380", data: sel("graduate(address)") + pad(token) });
    }
    expect(await big(APP.graduator, sel("hasGraduated(address)") + pad(token)), "the launch did not graduate").toBe(1n);
    const lock = addrOf(await ethCall(APP.graduator, sel("lockOf(address)") + pad(token)));
    // POOL TRADES, through the card, so the position earns LP fees.
    const tp = await openToken(token, TRADER);
    await expect(tp.locator("#tvStatus")).toHaveText("Graduated", { timeout: 30_000 });
    for (const side of ["buy", "sell"]) {
      const sym = (await tp.locator("#tvSym").textContent()).trim().replace(/^\$/, "");
      const tokenPays = (await tp.locator("#tvPayAsset").textContent()).trim() === sym;
      if ((side === "sell") !== tokenPays) await tp.click("#tvFlip");
      const pick = tp.locator(".tvAsset.tvPick");
      if ((await pick.count()) && (await pick.textContent()).trim() === "ETH") {
        await pick.click();
        await tp.locator('#tvMenu button[data-choice="asset"]').click();
      }
      await tp.fill("#tvPay", side === "buy" ? "5" : "100000");
      await expect(tp.locator("#tvAct")).toBeEnabled({ timeout: 30_000 });
      await tp.click("#tvAct");
      await expect(tp.locator("#msg")).toContainText(/Swapped through/, { timeout: 90_000 });
    }
    await tp.close();
    // THE ISSUER BLOCKS THE CREATOR, and the creator switches sharing on: the
    // lock's fee collection for the creator cannot deliver its NVDAc, and holds it.
    await blockReceiving(creator);
    const p = await openToken(token, creator);
    await expect(p.locator("#tvEnableShare")).toBeVisible({ timeout: 30_000 });
    await p.click("#tvEnableShare");
    await p.fill("#shEnableConfirm", "SHARE");
    await p.click("#shEnableAct");
    await expect(p.locator("#msg")).toContainText("Holder sharing is on", { timeout: 90_000 });
    const quoteIs0 = NVDAC < token.toLowerCase();
    const held = await big(lock, sel("held(address,uint256)") + pad(creator) + word(quoteIs0 ? 0 : 1));
    expect(held, "nothing was held for the creator, so this proves nothing").toBeGreaterThan(0n);
    await blockReceiving(creator, false);
    await p.reload();
    await p.evaluate(() => window.CurbApp.connect());
    await expect(p.locator("#tvReleaseHeld")).toBeVisible({ timeout: 30_000 });
    await expect(p.locator("#tvHeldNote")).toContainText((await fmtOn(p, held)) + " NVDAc");
    const before = await balanceOf(NVDAC, creator);
    await p.click("#tvReleaseHeld");
    await expect(p.locator("#msg")).toContainText("Released", { timeout: 90_000 });
    expect(await balanceOf(NVDAC, creator) - before, "the release did not pay the creator what was held").toBe(held);
    await expect(p.locator("#tvReleaseHeld")).toHaveCount(0, { timeout: 30_000 });
    // LOCKED FOREVER: the page says so, and offers no withdrawal.
    await expect(p.locator("#tvLockedForever")).toHaveText("LP locked forever.", { timeout: 30_000 });
    await expect(p.locator("#tvWithdrawAct")).toHaveCount(0);
    await expect(p.locator("#tvUnlockAt")).toHaveCount(0);
    await shot(p, "locked-forever");
    await p.close();
    const liquidity = await big(lock, sel("lockedLiquidity()"));
    expect(liquidity, "the lock holds no liquidity, so this proves nothing").toBeGreaterThan(0n);
    // TEN YEARS ON: still locked, for the creator too, and still nothing to press.
    await later(10 * 365 * 86400);
    const ask = async (data) => {
      try { await rpc("eth_call", [{ from: creator, to: lock, data }, "latest"]); return "answered"; } catch { return "refused"; }
    };
    expect(await ask(sel("withdraw()")), "the lock answered withdraw()").toBe("refused");
    expect(await ask(sel("withdrawLiquidity(uint128,uint128,address,uint256)") + word(0) + word(0) + pad(creator) + word(2n ** 255n)),
      "the lock answered withdrawLiquidity()").toBe("refused");
    expect(await big(lock, sel("holdsPosition()")), "the lock let go of the position").toBe(1n);
    expect(await big(lock, sel("lockedLiquidity()")), "liquidity left the lock in ten years").toBe(liquidity);
    const w = await openToken(token, creator);
    await expect(w.locator("#tvLockedForever")).toContainText("locked forever", { timeout: 30_000 });
    await expect(w.locator("#tvWithdrawAct")).toHaveCount(0);
    await w.close();
  });
});

// ================================================================== Explore
test("on Explore, the sharing launch's card carries 'Holders earn', read from the lens's word 15", async () => {
  const p = await newPage(TRADER);
  await p.goto("/browse.html?" + new URLSearchParams({ rpc: STATE.rpc, lens: APP.lens }).toString());
  const card = p.locator(".launch", { has: p.locator(`button.addr[title="${L.token}" i]`) });
  await expect(card.locator(".holdersEarn")).toHaveText("Holders earn", { timeout: 30_000 });
  await expect(card.locator(".holdersEarn")).toHaveAttribute("title", new RegExp(L.d, "i"));
  await shot(p, "explore-badge");
  await p.close();
});

// ================================================================== the bounds of the page's own arithmetic
test("v4's tick arithmetic, ported, gives the protocol's own bounds and the centre", async ({ page }) => {
  await page.goto("/sharing?" + new URLSearchParams({ rpc: STATE.rpc, lens: APP.lens }).toString());
  await page.waitForFunction(() => !!window.CurbSharing);
  const got = await page.evaluate(() => [887272, -887272, 0].map((t) => window.CurbSharing.sqrtAtTick(t).toString()));
  // TickMath.MAX_SQRT_PRICE, MIN_SQRT_PRICE and 2^96.
  expect(got).toEqual(["1461446703485210103287273052203988822378723970342", "4295128739", (1n << 96n).toString()]);
});
