// MOVING A COMMUNITY (migrate.html): the snapshot of an old token's holders at
// a block, the airdrop it becomes, and the two files - Safe's CSV Airdrop file
// and a plain address,amount one - byte for byte.
//
// THE OLD TOKEN IS A REAL ONE, ON THIS RUN'S FORK: a CurbLaunchToken (a plain
// OpenZeppelin ERC-20, from this run's own build in out/) whose whole supply is
// minted to a fresh account, which then hands it out - to wallets, a dead
// address, a pool, a curve, Uniswap v4's PoolManager, a contract nothing
// recognises, a Safe-shaped proxy, a smart wallet as Coinbase deploys one (an
// ERC-1967 proxy to an ERC-4337 account), a wallet with an EIP-7702
// delegation and the token itself - burns some, and keeps moving tokens after
// the snapshot block. Its name and symbol are markup, which the page must draw
// as text.
//
// The page reads it through the run's node, then through an endpoint of this
// file's own (routed) that refuses wide log ranges, answers busy once, takes
// no JSON-RPC batch and no Multicall3 - and must come to the same snapshot;
// one that cannot give one holder's code; one that names a holder that is no
// address; and, once config.js names a deployment, one a link named, from
// which no file is made.
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

const STATE = JSON.parse(fs.readFileSync(path.join(__dirname, ".state.json"), "utf8"));
const REPO = path.resolve(__dirname, "..", "..");
const ARTIFACT = path.join(REPO, "out", "CurbLaunchToken.sol", "CurbLaunchToken.json");

test.describe.configure({ mode: "serial" });

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
/// SEVERAL REQUESTS IN ONE JSON-RPC BATCH: each one's result, in order.
async function rpcBatch(calls) {
  const res = await fetch(STATE.rpc, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(calls.map(([method, params], i) => ({ jsonrpc: "2.0", id: i + 1, method, params }))),
  });
  const byId = new Map((await res.json()).map((r) => [r.id, r]));
  return calls.map(([method], i) => {
    const r = byId.get(i + 1);
    if (!r || r.error) throw new Error(method + ": " + JSON.stringify(r && r.error));
    return r.result;
  });
}
global.window = global.window || global;
require("../keccak.js"); require("../abi.js");
const { encode, T, utf8Hex } = window.CurbAbi;
const keccak = (s) => window.CurbKeccak.keccak256("0x" + utf8Hex(s));
const sel = (s) => keccak(s).slice(0, 10);
const pad = (a) => String(a).toLowerCase().replace(/^0x/, "").padStart(64, "0");
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const E = 10n ** 18n;

async function sendMined(tx) {
  const hash = await rpc("eth_sendTransaction", [tx]);
  for (let i = 0; i < 200; i++) {
    const r = await rpc("eth_getTransactionReceipt", [hash]);
    if (r) { expect(r.status, "this transaction reverted: " + hash).toBe("0x1"); return r; }
    await wait(100);
  }
  throw new Error("never mined: " + hash);
}
/// AN ADDRESS OF ITS OWN, with no code on this chain - this run's own, so a
/// node a run attached to (global-setup.js's presets) gives a second run new ones.
const RUN = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
async function fresh(label) {
  const a = "0x" + keccak("curb migrate.spec " + RUN + " " + label).slice(-40);
  expect(await rpc("eth_getCode", [a, "latest"]), label + " has code on this chain").toBe("0x");
  return a;
}
/// One the node signs for, with ether for gas.
async function signer(label) {
  const a = await fresh(label);
  await rpc("anvil_impersonateAccount", [a]);
  await rpc("anvil_setBalance", [a, "0x" + (10n * E).toString(16)]);
  return a;
}
const transfer = (token, from, to, amount) =>
  sendMined({ from, to: token, data: sel("transfer(address,uint256)") + pad(to) + word(amount) });
const balanceAt = async (token, who, block) =>
  BigInt(await rpc("eth_call", [{ to: token, data: sel("balanceOf(address)") + pad(who) }, "0x" + block.toString(16)]));

/// EIP-55, written here again from the rule rather than taken from the page.
function eip55(a) {
  const h = a.toLowerCase().replace(/^0x/, "");
  const k = keccak(h).slice(2);
  return "0x" + [...h].map((c, i) => (parseInt(k[i], 16) >= 8 ? c.toUpperCase() : c)).join("");
}

// ------------------------------------------------------------------ the old token's history
const NAME = '<img src=x onerror="window.__xss=1">';
const SYMBOL = "<b>OLD</b>";
const DEAD = "0x000000000000000000000000000000000000dead";
/// A SAFE PROXY'S RUNTIME as Safe's factories deploy it (v1.3.0, without its
/// metadata): it answers masterCopy() itself, then delegates.
const SAFE_PROXY = "0x608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fe";
/// Code that only reverts: a contract nothing recognises, as a locker or a
/// staking contract is to this page.
const SOME_CONTRACT = "0x6080604052600080fd";
/// RUNTIME CODE THAT ANSWERS EACH FUNCTION GIVEN WITH ITS WORDS and reverts on
/// anything else: the selector, then DUP1 PUSH4 EQ PUSH2 JUMPI for each, then
/// revert(0, 0), then for each a JUMPDEST, its words stored and returned.
function answering(answers) {
  const entries = Object.entries(answers).map(([f, ws]) => [sel(f).slice(2), ws.map((w) => String(w).replace(/^0x/, "").padStart(64, "0"))]);
  let at = 6 + 11 * entries.length + 4;
  let dispatch = "", blocks = "";
  for (const [s, ws] of entries) {
    dispatch += "8063" + s + "1461" + at.toString(16).padStart(4, "0") + "57";
    let b = "5b";
    ws.forEach((w, i) => { b += "7f" + w + "60" + (i * 32).toString(16).padStart(2, "0") + "52"; });
    b += "60" + (ws.length * 32).toString(16).padStart(2, "0") + "6000f3";
    blocks += b;
    at += b.length / 2;
  }
  return "0x60003560e01c" + dispatch + "600080fd" + blocks;
}
/// A POOL: token0() and token1() answer two tokens (Base's WETH and another).
const POOL_CODE = answering({ "token0()": [pad("0x4200000000000000000000000000000000000006")],
  "token1()": [pad("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913")] });
/// A CURVE: getReserves() answers two reserves.
const CURVE_CODE = answering({ "getReserves()": [word(1000n * E), word(2000n * E)] });
/// A SMART WALLET AS COINBASE DEPLOYS ONE: Solady's ERC-1967 proxy - its code
/// names the implementation slot and nothing else - delegating to an account
/// that answers entryPoint() with EntryPoint v0.6.
const IMPLEMENTATION_SLOT = "0x" + (BigInt(keccak("eip1967.proxy.implementation")) - 1n).toString(16).padStart(64, "0");
const ERC1967_PROXY = "0x363d3d373d3d363d7f" + IMPLEMENTATION_SLOT.slice(2) + "545af43d6000803e6038573d6000fd5b3d6000f3";
const ACCOUNT_CODE = answering({ "entryPoint()": [pad("0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789")] });
/// Uniswap v4's PoolManager on Base, on this fork.
const POOL_MANAGER = "0x498581ff718922c3f8e6a244956af099b2652b2b";

const H = {};             // the accounts, by name
let OLD = "";             // the old token
let DEPLOYED = 0;         // the block it was created in
let SNAP = 0;             // the snapshot block
const NEW = STATE.token.toLowerCase();   // a Curb launch: the waiting stack's
let ART = null;           // CurbLaunchToken's build

/// A CurbLaunchToken of `supply` minted to `to`: its address and its block.
async function deployToken(name, symbol, to, supply) {
  const args = encode([T.string, T.string, T.string, T.address, T.uint()], [name, symbol, "", to, supply]);
  const r = await sendMined({ from: to, data: ART.bytecode.object + args.slice(2), gas: "0x" + (3_000_000).toString(16) });
  return { token: r.contractAddress.toLowerCase(), block: parseInt(r.blockNumber, 16) };
}

test.beforeAll(async () => {
  if (!fs.existsSync(ARTIFACT)) throw new Error("no " + ARTIFACT + ": the run's build should have made it (forge build)");
  ART = JSON.parse(fs.readFileSync(ARTIFACT, "utf8"));
  H.seed = await signer("seed");
  H.a = await signer("a");
  H.b = await fresh("b");
  H.c = await fresh("c");
  H.d = await fresh("d");
  H.y = await fresh("y");
  H.pool = await fresh("pool");
  H.curve = await fresh("curve");
  H.box = await fresh("box");
  H.safe = await fresh("safe");
  H.smart = await fresh("smart");
  H.impl = await fresh("implementation");
  H.deleg = await fresh("delegated");
  H.pm = POOL_MANAGER;
  expect(await rpc("eth_getCode", [H.pm, "latest"]), "the PoolManager is not on this fork").not.toBe("0x");
  expect(ERC1967_PROXY.startsWith("0x363d3d373d3d363d7f360894"), "not the proxy a Coinbase Smart Wallet is").toBe(true);
  await rpc("anvil_setCode", [H.pool, POOL_CODE]);
  await rpc("anvil_setCode", [H.curve, CURVE_CODE]);
  await rpc("anvil_setCode", [H.box, SOME_CONTRACT]);
  await rpc("anvil_setCode", [H.safe, SAFE_PROXY]);
  await rpc("anvil_setCode", [H.impl, ACCOUNT_CODE]);
  await rpc("anvil_setCode", [H.smart, ERC1967_PROXY]);
  await rpc("anvil_setStorageAt", [H.smart, IMPLEMENTATION_SLOT, "0x" + pad(H.impl)]);
  await rpc("anvil_setCode", [H.deleg, "0xef0100" + "63c0c19a282a1b52b07dd5a65b58948a07dae32b"]);
  // THE SMART WALLET ANSWERS AS AN ACCOUNT, through its proxy.
  expect(await rpc("eth_call", [{ to: H.smart, data: sel("entryPoint()") }, "latest"])).toBe("0x" + pad("0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789"));

  const old = await deployToken(NAME, SYMBOL, H.seed, 10000n * E);
  OLD = old.token;
  DEPLOYED = old.block;

  await transfer(OLD, H.seed, H.a, 1000n * E);
  await transfer(OLD, H.seed, H.b, 2505n * E / 10n);
  await transfer(OLD, H.seed, H.c, 4n * E / 10n);
  await transfer(OLD, H.seed, DEAD, 100n * E);
  await transfer(OLD, H.seed, H.pool, 500n * E);
  await transfer(OLD, H.seed, H.safe, 40n * E);
  await transfer(OLD, H.seed, H.deleg, 42n * E);
  await transfer(OLD, H.seed, H.pm, 70n * E);
  await transfer(OLD, H.seed, H.curve, 60n * E);
  await transfer(OLD, H.seed, H.smart, 30n * E);
  await transfer(OLD, H.seed, H.box, 20n * E);
  // THE TOKEN ITSELF HOLDS SOME, as a tax token's does.
  await transfer(OLD, H.seed, OLD, 5n * E);
  await transfer(OLD, H.a, H.b, 100n * E);
  await sendMined({ from: H.seed, to: OLD, data: sel("burn(uint256)") + word(1000n * E) });
  const last = await transfer(OLD, H.seed, H.y, 1n);
  SNAP = parseInt(last.blockNumber, 16);
  // AFTER THE SNAPSHOT: a new holder, and one who sold out. Neither may show.
  await transfer(OLD, H.seed, H.d, 77n * E);
  await transfer(OLD, H.a, H.c, 900n * E);
  expect(await balanceAt(OLD, H.a, SNAP)).toBe(900n * E);
  expect(await balanceAt(OLD, H.a, SNAP + 2)).toBe(0n);
});

/// EVERY HOLDER AT THE SNAPSHOT BLOCK, largest first, as the page must find them.
const holdersAtSnap = () => [
  [H.seed, 10000n * E - 1000n * E - 2505n * E / 10n - 4n * E / 10n - 100n * E - 500n * E - 40n * E - 42n * E -
    70n * E - 60n * E - 30n * E - 20n * E - 5n * E - 1000n * E - 1n],
  [H.a, 900n * E], [H.pool, 500n * E], [H.b, 3505n * E / 10n], [DEAD, 100n * E], [H.pm, 70n * E], [H.curve, 60n * E],
  [H.deleg, 42n * E], [H.safe, 40n * E], [H.smart, 30n * E], [H.box, 20n * E], [OLD, 5n * E], [H.c, 4n * E / 10n], [H.y, 1n],
];
/// An amount as the files write it: whole tokens, every decimal, no trailing zero.
const tokens = (v) => {
  const frac = (BigInt(v) % E).toString().padStart(18, "0").replace(/0+$/, "");
  return (BigInt(v) / E).toString() + (frac ? "." + frac : "");
};

// ------------------------------------------------------------------ the page
const pairUrl = (extra = {}) => "/migrate.html?" + new URLSearchParams({ rpc: STATE.rpc, lens: STATE.lens, ...extra }).toString();
async function open(page, extra, url) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url || pairUrl(extra));
  await page.waitForFunction(() => !!window.CurbMigrate, null, { timeout: 10_000 });
  return errors;
}
/// EVERY keccak256 THE PAGE ASKS FOR, counted (window.__hashes): the one
/// keccak.js hands out is wrapped as it is handed.
async function countHashes(page) {
  await page.addInitScript(() => {
    let held;
    window.__hashes = 0;
    Object.defineProperty(window, "CurbKeccak", { configurable: true, get: () => held,
      set(v) { const inner = v.keccak256; held = { ...v, keccak256: (x) => { window.__hashes++; return inner(x); } }; } });
  });
}
/// THROUGH AN ENDPOINT OF THIS FILE'S OWN the first block is given, not found:
/// an https endpoint is no fork to the page (sharing.js mayBeFork), so it would
/// bisect from block 0 - which this fork answers from its upstream, slowly.
/// The first test finds it through the node itself.
async function fillForm(page, { rpcUrl = "", from = 0, token = OLD, block = SNAP } = {}) {
  await page.fill("#mOld", token);
  await page.fill("#mBlock", String(block));
  if (rpcUrl || from) {
    await page.locator("#mMore summary").click();
    if (rpcUrl) await page.fill("#mRpc", rpcUrl);
    await page.fill("#mFrom", String(from || DEPLOYED));
  }
}
async function snapshot(page, opts) {
  await fillForm(page, opts);
  await page.click("#mRun");
  await expect(page.locator("#mResult")).toBeVisible({ timeout: 45_000 });
}
/// The snapshot the page holds, its amounts as strings.
const held = (page) => page.evaluate(() => {
  const s = window.CurbMigrate.snapshot();
  return { from: s.from, block: s.block, decimals: s.decimals, name: s.name, symbol: s.symbol, sum: String(s.sum),
    totalSupply: String(s.totalSupply), addresses: s.addresses, unread: s.unread,
    holders: s.holders.map((h) => [h.a, String(h.bal), h.kind]) };
});
async function fetchDownload(page, locator) {
  const [dl] = await Promise.all([page.waitForEvent("download"), page.locator(locator).click()]);
  return { name: dl.suggestedFilename(), text: fs.readFileSync(await dl.path(), "utf8") };
}
const safeFile = (rows) => ["token_type,token_address,receiver,amount,id",
  ...rows.map(([a, amount]) => "erc20," + eip55(NEW) + "," + eip55(a) + "," + amount + ",")].join("\n");
const plainFile = (rows) => "address,amount\n" + rows.map(([a, amount]) => eip55(a) + "," + amount + "\n").join("");

let first = null;   // the snapshot read through the run's node, for the refusing endpoint to match

test("a snapshot at a block finds every holder and balance then, and the files are exact", async ({ page }) => {
  await countHashes(page);
  const errors = await open(page, { token: OLD });
  // A LINK MAY NAME THE OLD TOKEN.
  await expect(page.locator("#mOld")).toHaveValue(OLD);
  await snapshot(page);
  const s = await held(page);
  first = s;
  expect(s.from, "the token's first block was not found").toBe(DEPLOYED);
  expect(s.block).toBe(SNAP);
  expect(s.decimals).toBe(18);
  expect(s.unread).toEqual([]);
  // EVERY ADDRESS A LOG NAMED UP TO THE BLOCK, and not the one that came after.
  expect(s.holders.map(([a, b]) => [a, b])).toEqual(holdersAtSnap().map(([a, b]) => [a, String(b)]));
  expect(s.holders.find(([a]) => a === H.d), "a holder from after the snapshot block").toBeUndefined();
  expect(s.sum).toBe(String(9000n * E));
  expect(s.totalSupply).toBe(String(9000n * E));
  // EACH CONTRACT TOLD APART BY WHAT IT ANSWERS.
  const kinds = Object.fromEntries(s.holders.map(([a, , k]) => [a, k]));
  expect(kinds[H.pool], "a pool that answers token0() and token1()").toBe("pool");
  expect(kinds[H.curve], "a curve that answers getReserves()").toBe("pool");
  expect(kinds[H.pm], "Uniswap v4's PoolManager").toBe("pool");
  expect(kinds[H.smart], "a Coinbase-style smart wallet was taken for a contract").toBe("account");
  expect(kinds[H.box]).toBe("contract");
  expect(kinds[H.safe]).toBe("safe");
  expect(kinds[H.deleg], "an EIP-7702 wallet was taken for a contract").toBe("delegated");
  expect(kinds[H.a]).toBe("wallet");
  await expect(page.locator("#mSupply")).toContainText("the token's whole supply at that block");

  // THE NAME AND SYMBOL ARE A STRANGER'S MARKUP, drawn as text.
  await expect(page.locator("#mInfo")).toContainText(NAME);
  await expect(page.locator("#mInfo")).toContainText(SYMBOL);
  expect(await page.locator("#mInfo img, #mInfo b b, main img").count()).toBe(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();

  // RATIO 2.5, NO MINIMUM, THE SEED LEFT OUT BY HAND; the pool, the curve, the
  // PoolManager and the contract nothing recognises left out, the Safe, the
  // smart wallet and the 7702 wallet kept, the dead address and the token
  // itself always out.
  await page.fill("#mRatio", "2.5");
  await page.fill("#mExclude", "not-an-address\n" + H.seed.toUpperCase().replace("0X", "0x"));
  await page.fill("#mNew", NEW);
  await expect(page.locator("#mNewInfo")).toContainText("a Curb launch", { timeout: 15_000 });
  await expect(page.locator("#mExcludeNote")).toContainText("Not addresses, so not used: not-an-address");
  const rows1 = [[H.a, "2250"], [H.b, "876.25"], [H.deleg, "105"], [H.safe, "100"], [H.smart, "75"], [H.c, "1"], [H.y, "0.000000000000000002"]];
  await expect(page.locator("#mNeed")).toContainText("must hold at least 3407.250000000000000002 ");
  await expect(page.locator("#mTotals")).toContainText("14");
  const safe1 = await fetchDownload(page, "button.mSafe");
  expect(safe1.name).toBe("airdrop-" + OLD.slice(0, 10) + "-block-" + SNAP + "-safe.csv");
  expect(safe1.text).toBe(safeFile(rows1));
  const plain1 = await fetchDownload(page, "#mPlain");
  expect(plain1.name).toBe("airdrop-" + OLD.slice(0, 10) + "-block-" + SNAP + ".csv");
  expect(plain1.text).toBe(plainFile(rows1));
  const why = (a) => page.locator(`#mTable tr[data-a="${a}"]`);
  await expect(why(H.seed)).toContainText("left out: your list");
  await expect(why(DEAD)).toContainText("left out: burn address");
  await expect(why(OLD)).toContainText("left out: the token itself");
  for (const a of [H.pool, H.curve, H.pm]) await expect(why(a)).toContainText("left out: pool");
  await expect(why(H.box)).toContainText("left out: contract");
  await expect(why(H.smart)).toContainText("smart wallet");
  await expect(why(H.smart)).not.toContainText("left out");
  await expect(why(H.deleg)).toContainText("wallet (EIP-7702)");
  // THE CONTRACTS, EACH SWITCHABLE AND SAID WHAT IT IS; the token itself is out
  // whatever is ticked, so it is not offered.
  const box = (a) => page.locator(`#mContracts tr[data-a="${a}"]`);
  await expect(box(H.pm)).toContainText("Uniswap v4's PoolManager");
  await expect(box(H.pool)).toContainText("a pool or a curve");
  await expect(box(H.smart)).toContainText("smart wallet (ERC-4337)");
  await expect(box(H.box)).toContainText("contract, not recognised");
  for (const a of [H.pool, H.curve, H.pm, H.box]) await expect(box(a).locator("input")).toBeChecked();
  for (const a of [H.safe, H.smart]) await expect(box(a).locator("input")).not.toBeChecked();
  await expect(box(OLD)).toHaveCount(0);
  await expect(page.locator("#mContracts")).toContainText("1 contract is not a pool, a Safe or a smart wallet this page recognises");
  expect(await page.locator("#mResult").textContent(), "a missing value was drawn as a word").not.toMatch(/null|undefined|NaN/);

  // A REDRAW HASHES NOTHING IT HAS HASHED BEFORE: a keystroke in the ratio
  // builds no Safe file, and draws addresses already checksummed.
  await page.evaluate(() => { window.__hashes = 0; });
  await page.fill("#mRatio", "5");
  await expect(page.locator("#mNeed")).toContainText("must hold at least 6814.500000000000000005 ");
  expect(await page.evaluate(() => window.__hashes), "a redraw hashed addresses again").toBe(0);

  // RATIO 0.333 AND A MINIMUM OF 1: the dust goes; the Safe left out and the
  // pool kept, by their boxes, and the contract nothing recognises kept by
  // the list of contracts to keep.
  await page.fill("#mRatio", "0.333");
  await page.fill("#mMin", "1");
  await expect(why(H.c)).toContainText("left out: below the minimum");
  await page.locator(`#mContracts tr[data-a="${H.safe}"] input`).check();
  await page.locator(`#mContracts tr[data-a="${H.pool}"] input`).uncheck();
  await page.fill("#mInclude", "nope\n" + H.box);
  await expect(page.locator("#mIncludeNote")).toContainText("Not addresses, so not used: nope");
  const rows2 = [[H.a, "299.7"], [H.pool, "166.5"], [H.b, "116.7165"], [H.deleg, "13.986"], [H.smart, "9.99"], [H.box, "6.66"]];
  await expect(why(H.safe)).toContainText("left out: Safe, left out");
  await expect(why(H.pool)).not.toContainText("left out");
  await expect(why(H.box)).not.toContainText("left out");
  await expect(box(H.box).locator("input")).not.toBeChecked();
  expect((await fetchDownload(page, "button.mSafe")).text).toBe(safeFile(rows2));
  expect((await fetchDownload(page, "#mPlain")).text).toBe(plainFile(rows2));
  // A BALANCE OF EXACTLY THE MINIMUM IS IN; one below it is not.
  await page.fill("#mMin", "42");
  await expect(why(H.smart)).toContainText("left out: below the minimum");
  await expect(why(H.deleg), "a balance of exactly the minimum was left out").not.toContainText("left out");

  // A RATIO THAT TURNS ONE WEI INTO NOTHING leaves it out, said so.
  await page.fill("#mRatio", "0.4");
  await page.fill("#mMin", "");
  await expect(why(H.y)).toContainText("left out: rounds to 0");
  // A COMMA IS REFUSED, and no file is offered while it is.
  await page.fill("#mRatio", "0,4");
  await expect(page.locator("#mErr")).toContainText("use a dot for decimals");
  await expect(page.locator("#mFiles button")).toHaveCount(0);

  // WHAT THE AIRDROP NEEDS AGAINST WHAT A LAUNCH HAS: 1,842.9 old tokens (and
  // a wei) are in it now. Past a dev buy, the curve; past the 73% the curve
  // sells, the pool after graduation; past the whole supply, no Safe file.
  await page.fill("#mRatio", "200000");
  await expect(page.locator("#mNeed")).toContainText("the rest has to be bought on the curve after the launch");
  await page.fill("#mRatio", "500000");
  await expect(page.locator("#mNeed")).toContainText("more than the curve sells, about 730,000,000 (73% of the supply): " +
    "the rest has to be bought from the pool once the launch has graduated.");
  await expect(page.locator("button.mSafe")).toBeEnabled();
  await page.fill("#mRatio", "1000000");
  await expect(page.locator("#mNeed")).toContainText("more than the new coin's whole supply of 1,000,000,000");
  await expect(page.locator("#mNeed")).toHaveClass(/bad/);
  await expect(page.locator("button.mSafe")).toBeDisabled();
  await page.fill("#mRatio", "1");
  await expect(page.locator("button.mSafe")).toBeEnabled();

  // CONTRACTS NOT LOOKED FOR: the Safe left out by its box above is a holder
  // like any other again - and the token itself is still left out.
  await expect(why(H.safe)).toContainText("left out: Safe, left out");
  await page.locator("#mFindContracts").uncheck();
  await expect(page.locator("#mContractsBox")).toBeHidden();
  await expect(why(H.safe)).not.toContainText("left out");
  await expect(why(OLD)).toContainText("left out: the token itself");
  expect((await fetchDownload(page, "#mPlain")).text, "the token itself is in the file").not.toContain(eip55(OLD));

  // A NEW TOKEN TYPED: the Safe file made for the last one goes at once, while
  // the new one is still being read (its decimals held back here), and comes
  // back for the new one.
  let release;
  const gate = new Promise((r) => { release = r; });
  const rpcUrl = new RegExp("^" + STATE.rpc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/?$");
  await page.route(rpcUrl, async (route) => {
    let b = null;
    try { b = JSON.parse(route.request().postData() || "null"); } catch { b = null; }
    if (b && b.method === "eth_call" && String(b.params[0].to).toLowerCase() === OLD && b.params[0].data === sel("decimals()")) await gate;
    return route.continue();
  });
  await expect(page.locator("button.mSafe")).toBeEnabled();
  await page.fill("#mNew", OLD);
  await expect(page.locator("button.mSafe"), "the last token's Safe file was still offered").toBeDisabled();
  release();
  // A NEW TOKEN THAT IS NO LAUNCH is said to be one.
  await expect(page.locator("#mNewInfo")).toContainText("not a launch in Curb's registry", { timeout: 15_000 });
  await expect(page.locator("button.mSafe")).toBeEnabled();
  await page.unroute(rpcUrl);

  // AT A PHONE'S WIDTH, nothing takes the page sideways.
  await page.setViewportSize({ width: 375, height: 800 });
  await page.waitForTimeout(300);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over, "the page scrolls sideways at 375px").toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

test("the arithmetic: another token's decimals, Safe's 500-row files, and a known EIP-55 address", async ({ page }) => {
  await open(page);
  const got = await page.evaluate(() => {
    const m = window.CurbMigrate;
    const rows = Array.from({ length: 1001 }, (_, i) => ({ a: "0x" + (i + 1).toString(16).padStart(40, "0"), amount: 10n ** 18n }));
    const files = m.safeFiles(rows, "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266", 18);
    return {
      six: m.exact(m.scale(1234567n, m.parseRatio("1.5"), 6, 18), 18),
      down: m.exact(m.scale(10n ** 18n, m.parseRatio("0.000001"), 18, 6), 6),
      floor: m.exact(m.scale(1n, m.parseRatio("0.999"), 18, 6), 6),
      known: m.checksum("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"),
      lines: files.map((f) => f.split(/\r\n|\r|\n/).length),
      last: files[2],
      tooFine: (() => { try { m.parseRatio("0.0000000000000000001"); return "taken"; } catch (e) { return e.message; } })(),
      // NO FILE CARRIES A RECEIVER THAT IS NOT AN ADDRESS: commas and a line
      // break would be columns and rows of their own.
      notAddress: [
        () => m.checksum("0x,1000\nerc20,0x0000000000000000000000000000"),
        () => m.safeFiles([{ a: "0x" + "g".repeat(40), amount: 1n }], "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266", 18),
        () => m.plainFile([{ a: "0x123", amount: 1n }], 18),
      ].map((f) => { try { return "written: " + f(); } catch (e) { return e.message; } }),
    };
  });
  expect(got.six).toBe("1.8518505");
  expect(got.down).toBe("0.000001");
  expect(got.floor).toBe("0");
  expect(got.known).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
  // SAFE'S APP REFUSES A FILE OF MORE THAN 501 LINES, a trailing newline counted.
  expect(got.lines).toEqual([501, 501, 2]);
  expect(got.last).toBe("token_type,token_address,receiver,amount,id\nerc20,0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266," +
    eip55("0x" + (1001).toString(16).padStart(40, "0")) + ",1,");
  expect(got.tooFine).toContain("more than 18 decimal places");
  for (const r of got.notAddress) expect(r).toMatch(/^Not an address, so not written/);
});

/// AN ENDPOINT OF THIS FILE'S OWN, routed to the run's node. `answer` sees each
/// request (an object, or an array for a batch) and may answer it instead.
const REFUSING = "https://refusing.example/rpc";
async function routeEndpoint(page, answer) {
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST, OPTIONS" };
  await page.route(/^https:\/\/refusing\.example\/rpc$/, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    let body = null;
    try { body = JSON.parse(req.postData() || "null"); } catch { body = null; }
    const own = await answer(body);
    try {
      if (own) {
        return await route.fulfill({ status: own.status || 200, headers: cors, contentType: "application/json",
          body: typeof own.body === "string" ? own.body : JSON.stringify(own.body) });
      }
      const res = await fetch(STATE.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: req.postData() });
      return await route.fulfill({ status: res.status, headers: cors, contentType: "application/json", body: await res.text() });
    } catch { /* the page gave the request up (a Stop) */ }
  });
}
const span = (b) => parseInt(b.params[0].toBlock, 16) - parseInt(b.params[0].fromBlock, 16) + 1;
/// A WINDOW TOO WIDE, refused in the words of the site's own log endpoint
/// (Tenderly's public gateway, as browse.spec.js has it), at `most` blocks.
const tooWide = (b, most) => ({ jsonrpc: "2.0", id: b.id, error: { code: -32602, message: "invalid params",
  data: "Block range too large for public access: maximum " + most + " blocks. Try with this block range [" +
    b.params[0].fromBlock + ", 0x" + (parseInt(b.params[0].fromBlock, 16) + most - 1).toString(16) + "], or use an access key for larger ranges." } });

test("an endpoint that refuses wide ranges, answers busy, and takes no batch and no Multicall3 gives the same snapshot", async ({ page }) => {
  expect(first, "the first test did not run").not.toBeNull();
  const answered = [];
  let busyOnce = false;
  await routeEndpoint(page, async (b) => {
    if (Array.isArray(b)) return { body: { jsonrpc: "2.0", id: null, error: { code: -32600, message: "batch requests are not served" } } };
    if (b.method === "eth_getLogs") {
      if (!busyOnce) { busyOnce = true; return { status: 429, body: { jsonrpc: "2.0", id: b.id, error: { code: 429, message: "Too Many Requests" } } }; }
      if (span(b) > 3) return { body: tooWide(b, 3) };
      answered.push(span(b));
    }
    if (b.method === "eth_call" && String(b.params[0].to).toLowerCase() === "0xca11bde05977b3631167028862be2a173976ca11") {
      return { body: { jsonrpc: "2.0", id: b.id, error: { code: -32000, message: "this endpoint does not run Multicall3" } } };
    }
    return undefined;
  });
  const errors = await open(page);
  await snapshot(page, { rpcUrl: REFUSING });
  expect(await held(page)).toEqual(first);
  expect(busyOnce).toBe(true);
  expect(answered.length).toBeGreaterThan(0);
  expect(Math.max(...answered), "a window wider than the endpoint's stated 3 blocks was answered").toBeLessThanOrEqual(3);
  await expect(page.locator("#mStatus")).toContainText("refusing.example");
  expect(errors).toEqual([]);
});

test("a long scan shows its progress, stops on Stop, and Continue picks up where it stopped", async ({ page }) => {
  expect(first, "the first test did not run").not.toBeNull();
  let logs = 0;
  let arrived, release;
  const third = new Promise((r) => { arrived = r; });
  const gate = new Promise((r) => { release = r; });
  const asked = [];
  await routeEndpoint(page, async (b) => {
    if (b && b.method === "eth_getLogs") {
      if (span(b) > 1) return { body: tooWide(b, 1) };
      asked.push(parseInt(b.params[0].fromBlock, 16));
      if (++logs === 3) { arrived(); await gate; }
    }
    return undefined;
  });
  const errors = await open(page);
  await fillForm(page, { rpcUrl: REFUSING });
  await page.click("#mRun");
  await Promise.race([third, wait(20_000).then(async () => {
    throw new Error("the third log read never came: " + await page.locator("#mStatus").textContent());
  })]);
  await expect(page.locator("#mProgress")).toBeVisible();
  await expect(page.locator("#mStatus")).toContainText("Reading transfers through refusing.example");
  await expect(page.locator("#mStop")).toBeVisible();
  await expect(page.locator("#mOld")).toBeDisabled();
  await page.click("#mStop");
  release();
  await expect(page.locator("#mStatus")).toContainText("Stopped at block", { timeout: 10_000 });
  await expect(page.locator("#mContinue")).toBeVisible();
  await expect(page.locator("#mResult")).toBeHidden();
  const before = asked.length;
  await page.click("#mContinue");
  await expect(page.locator("#mResult")).toBeVisible({ timeout: 45_000 });
  expect(await held(page)).toEqual(first);
  // NOTHING READ TWICE BUT THE WINDOW THE STOP CUT SHORT.
  const again = asked.slice(before);
  expect(again[0], "Continue did not pick up at the window the Stop cut short").toBe(asked[2]);
  expect(new Set(asked).size).toBe(asked.length - 1);
  expect(errors).toEqual([]);
});

/// Batches refused, as test 3's endpoint refuses them: every request comes alone.
const NO_BATCH = { body: { jsonrpc: "2.0", id: null, error: { code: -32600, message: "batch requests are not served" } } };

test("a holder whose code could not be read is listed, left out and said so, and Continue reads it again", async ({ page }) => {
  expect(first, "the first test did not run").not.toBeNull();
  let failing = true, refused = 0;
  await routeEndpoint(page, async (b) => {
    if (Array.isArray(b)) return NO_BATCH;
    // THE POOL'S CODE, NOW, NOT GIVEN: an error that is no busy endpoint's.
    if (failing && b.method === "eth_getCode" && String(b.params[0]).toLowerCase() === H.pool && b.params[1] === "latest") {
      refused++;
      return { body: { jsonrpc: "2.0", id: b.id, error: { code: -32000, message: "missing trie node" } } };
    }
    return undefined;
  });
  const errors = await open(page);
  await snapshot(page, { rpcUrl: REFUSING });
  expect(refused).toBeGreaterThan(0);
  const s = await held(page);
  const kinds = Object.fromEntries(s.holders.map(([a, , k]) => [a, k]));
  expect(kinds[H.pool]).toBe("unknown");
  const why = (a) => page.locator(`#mTable tr[data-a="${a}"]`);
  await expect(why(H.pool), "a pool whose code was not read went into the airdrop").toContainText("left out: code not read");
  await expect(page.locator(`#mContracts tr[data-a="${H.pool}"]`)).toContainText("code not read");
  await expect(page.locator(`#mContracts tr[data-a="${H.pool}"] input`)).toBeChecked();
  await expect(page.locator("#mCodesUnread")).toContainText("1 holder's code could not be read");
  await expect(page.locator("#mStatus")).toContainText("1 holder's code could not be read; Continue asks for it again.");
  await page.fill("#mNew", NEW);
  await expect(page.locator("#mNewInfo")).toContainText("a Curb launch", { timeout: 15_000 });
  expect((await fetchDownload(page, "#mPlain")).text, "the unread pool is in the file").not.toContain(eip55(H.pool));
  // CONTINUE, ONCE THE ENDPOINT ANSWERS: the pool is a pool, and the snapshot
  // is the first test's.
  await expect(page.locator("#mContinue")).toBeVisible();
  failing = false;
  await page.click("#mContinue");
  await expect(page.locator("#mCodesUnread")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator("#mContinue")).toBeHidden();
  expect(await held(page)).toEqual(first);
  await expect(why(H.pool)).toContainText("left out: pool");
  expect(errors).toEqual([]);
});

test("a log that names a holder that is no address puts nothing in the files", async ({ page }) => {
  // FORTY CHARACTERS AFTER 24 ZEROS, as a topic carries an address - but
  // commas and a line break, which in a file would be rows of their own.
  const EVIL = ",9999,\nerc20,0xbad,1000000,\n".padEnd(40, "x");
  expect(EVIL.length).toBe(40);
  let named = 0, asked = 0;
  await routeEndpoint(page, async (b) => {
    if (Array.isArray(b)) return NO_BATCH;
    if (b.method === "eth_getLogs") {
      const res = await fetch(STATE.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
      const j = await res.json();
      if (!Array.isArray(j.result) || !j.result.length) return { body: j };
      named++;
      const l = j.result[0];
      return { body: { ...j, result: [...j.result, { ...l, logIndex: "0x999", topics: [l.topics[0], "0x" + "0".repeat(24) + EVIL, l.topics[2]] }] } };
    }
    // ITS BALANCE, ANSWERED, should the page ever ask.
    if (b.method === "eth_call" && String(b.params[0].data || "").includes(EVIL.toLowerCase())) {
      asked++;
      return { body: { jsonrpc: "2.0", id: b.id, result: "0x" + word(5n * E) } };
    }
    return undefined;
  });
  const errors = await open(page);
  await page.locator("#mFindContracts").uncheck();
  await snapshot(page, { rpcUrl: REFUSING });
  expect(named, "no log carried the word").toBeGreaterThan(0);
  expect(asked, "the page asked the balance of a word that is no address").toBe(0);
  const s = await held(page);
  expect(s.holders.map(([a, b]) => [a, b])).toEqual(holdersAtSnap().map(([a, b]) => [a, String(b)]));
  await page.fill("#mNew", NEW);
  await expect(page.locator("#mNewInfo")).toContainText("a Curb launch", { timeout: 15_000 });
  // EVERY HOLDER BUT THE DEAD ADDRESS AND THE TOKEN ITSELF, at 1 for 1: no
  // contract was looked for.
  const rows = holdersAtSnap().filter(([a]) => a !== DEAD && a !== OLD).map(([a, b]) => [a, tokens(b)]);
  expect((await fetchDownload(page, "button.mSafe")).text).toBe(safeFile(rows));
  expect((await fetchDownload(page, "#mPlain")).text).toBe(plainFile(rows));
  await expect(page.locator(`#mTable tr[data-a="${OLD}"]`)).toContainText("left out: the token itself");
  expect(errors).toEqual([]);
});

/// web/config.js AS DEPLOY DAY WRITES IT (prod.spec.js standIn), naming this
/// run's node as the site's own endpoint and its lens.
async function deployedConfig(page) {
  const site = { chainId: 8453, rpc: STATE.rpc, logsRpc: "", logsBlocks: 0, lens: STATE.lens, registry: "", factories: [],
    explorer: "https://basescan.org", featured: [], banner: "", hiddenFactories: [], hiddenLaunches: [], walletConnectProjectId: "" };
  await page.route(/\/config\.js(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8",
    body: "window.CURB_SITE = " + JSON.stringify(site) + ";" }));
}

test("once config.js names a deployment, no file is made from a link's endpoint; the site's or the visitor's own is used", async ({ page }) => {
  await deployedConfig(page);
  await routeEndpoint(page, async () => undefined);
  // A LINK NAMING ANOTHER ENDPOINT, AND ANOTHER LENS: it is read, and said so
  // under the bar, but what it answered makes no file - and whether the new
  // token is a launch is config.js's registry's word, not the link's (the
  // full-flow stack's registry has no launch of the waiting stack's).
  const errors = await open(page, null, "/migrate.html?" + new URLSearchParams({ rpc: REFUSING, lens: STATE.app.lens }).toString());
  await expect(page.locator("#cbEndpoint")).toBeVisible();
  await snapshot(page, { from: DEPLOYED });
  await page.fill("#mNew", NEW);
  await expect(page.locator("#mNewInfo"), "the link's lens decided what is a launch").toContainText("a Curb launch", { timeout: 15_000 });
  await expect(page.locator("button.mSafe")).toBeDisabled();
  await expect(page.locator("#mPlain")).toBeDisabled();
  await expect(page.locator("#mRefused")).toContainText("This snapshot was read through refusing.example");
  // THE SAME ENDPOINT, TYPED UNDER MORE, is the visitor's own.
  await page.fill("#mRpc", REFUSING);
  await page.click("#mRun");
  await expect(page.locator("#mStatus")).toContainText("Read ", { timeout: 45_000 });
  await expect(page.locator("#mResult")).toBeVisible();
  await expect(page.locator("#mRefused")).toHaveCount(0);
  await expect(page.locator("button.mSafe")).toBeEnabled();
  await expect(page.locator("#mFiles")).toContainText("Read through refusing.example");
  // NO LINK: the site's own endpoint.
  await page.goto("/migrate.html");
  await page.waitForFunction(() => !!window.CurbMigrate, null, { timeout: 10_000 });
  await expect(page.locator("#cbEndpoint")).toBeHidden();
  await snapshot(page);
  await page.fill("#mNew", NEW);
  await expect(page.locator("#mNewInfo")).toContainText("a Curb launch", { timeout: 15_000 });
  await expect(page.locator("button.mSafe")).toBeEnabled();
  await expect(page.locator("#mRefused")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("past the 300 contracts listed, the note says what the files do with the rest, and any of them can be kept or left out", async ({ page }) => {
  test.setTimeout(180_000);
  // 302 CONTRACTS NOTHING RECOGNISES, then 4 SAFES, smallest last.
  const seed = await signer("many seed");
  const many = await deployToken("Many", "MANY", seed, 1_000_000n * E);
  const boxes = Array.from({ length: 302 }, (_, i) => "0x" + keccak("curb migrate.spec " + RUN + " many box " + i).slice(-40));
  const safes = Array.from({ length: 4 }, (_, i) => "0x" + keccak("curb migrate.spec " + RUN + " many safe " + i).slice(-40));
  await rpcBatch([...boxes.map((a) => ["anvil_setCode", [a, SOME_CONTRACT]]), ...safes.map((a) => ["anvil_setCode", [a, SAFE_PROXY]])]);
  // EVERY TRANSFER IN ONE JSON-RPC BATCH, each with its own nonce and gas, so
  // the node takes them in order however it serves a batch - and in one block:
  // a block mined for each is most of a minute on this fork.
  const sends = [...boxes.map((a, i) => [a, BigInt(1000 - i) * E]), ...safes.map((a, i) => [a, BigInt(10 - i) * E])];
  const nonce = parseInt(await rpc("eth_getTransactionCount", [seed, "latest"]), 16);
  let hashes;
  await rpc("evm_setAutomine", [false]);
  try {
    hashes = await rpcBatch(sends.map(([to, amount], i) => ["eth_sendTransaction", [{ from: seed, to: many.token,
      data: sel("transfer(address,uint256)") + pad(to) + word(amount), nonce: "0x" + (nonce + i).toString(16), gas: "0x" + (100_000).toString(16) }]]));
    await rpc("evm_mine", []);
  } finally {
    await rpc("evm_setAutomine", [true]);
  }
  let receipts = [];
  for (let i = 0; i < 100; i++) {
    receipts = await rpcBatch(hashes.map((h) => ["eth_getTransactionReceipt", [h]]));
    if (receipts.every(Boolean)) break;
    // WHAT ONE BLOCK'S GAS DID NOT TAKE goes into the next.
    await rpc("evm_mine", []);
  }
  expect(receipts.every((r) => r && r.status === "0x1"), "a transfer to a contract holder was not mined, or reverted").toBe(true);
  const block = Math.max(...receipts.map((r) => parseInt(r.blockNumber, 16)));

  const errors = await open(page);
  await fillForm(page, { token: many.token, block });
  await page.click("#mRun");
  await expect(page.locator("#mResult")).toBeVisible({ timeout: 120_000 });
  const more = page.locator("#mContractsMore");
  // THE OTHER SIX: boxes 300 and 301 left out, the four Safes kept.
  await expect(more).toHaveText("The 300 largest of 306 contracts are listed. Of the other 6, 2 left out and 4 in the airdrop: " +
    "list an address under Keep these contracts, or under Leave out these addresses, to change one.");
  await expect(page.locator(`#mContracts tr[data-a="${boxes[299]}"]`)).toHaveCount(1);
  await expect(page.locator(`#mContracts tr[data-a="${boxes[300]}"]`)).toHaveCount(0);
  // ONE KEPT BY THE LIST, ONE SAFE LEFT OUT BY THE OTHER.
  await page.fill("#mInclude", boxes[301]);
  await expect(more).toContainText("Of the other 6, 1 left out and 5 in the airdrop");
  await page.fill("#mExclude", safes[3]);
  await expect(more).toContainText("Of the other 6, 2 left out and 4 in the airdrop");
  const plain = (await fetchDownload(page, "#mPlain")).text;
  expect(plain).toContain(eip55(boxes[301]) + ",699\n");
  expect(plain).not.toContain(eip55(boxes[300]));
  expect(plain).toContain(eip55(safes[2]) + ",8\n");
  expect(plain).not.toContain(eip55(safes[3]));
  expect(errors).toEqual([]);
});

test("what filling a curve costs is read from the factories: the threshold and the largest dev buy", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/migrate.html?" + new URLSearchParams({ rpc: STATE.rpc, lens: STATE.app.lens }).toString());
  const weth = page.locator("#mCostTable tbody tr", { hasText: "WETH" });
  await expect(weth).toHaveCount(1, { timeout: 20_000 });
  // 4.47 WETH, and a fifth of the supply bought from a new curve holding it
  // against 1.65 WETH: 0.4125 WETH into the curve, 0.41666... paid at a 1% tax.
  await expect(weth).toContainText("4.47 WETH");
  await expect(weth).toContainText("about 0.4166 WETH");
  await expect(page.locator("#mCapLine")).toHaveText("20% of the supply (200,000,000 tokens)");
  // EVERY ASSET THE REGISTRY ADMITS, once.
  const n = await page.locator("#mCostTable tbody tr").count();
  expect(n).toBeGreaterThanOrEqual(14);
  // AT A PHONE'S WIDTH the table scrolls in its own box.
  await page.setViewportSize({ width: 375, height: 800 });
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});
