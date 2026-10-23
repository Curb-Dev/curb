// MOVING A COMMUNITY (migrate.html): the snapshot of an old token's holders at
// a block, the airdrop it becomes, and the two files - Safe's CSV Airdrop file
// and a plain address,amount one - byte for byte.
//
// THE OLD TOKEN IS A REAL ONE, ON THIS RUN'S FORK: a CurbLaunchToken (a plain
// OpenZeppelin ERC-20, from this run's own build in out/) whose whole supply is
// minted to a fresh account, which then hands it out - to wallets, a dead
// address, a contract, a Safe-shaped proxy and a wallet with an EIP-7702
// delegation - burns some, and keeps moving tokens after the snapshot block.
// Its name and symbol are markup, which the page must draw as text.
//
// The page reads it through the run's node, then through an endpoint of this
// file's own (routed) that refuses wide log ranges, answers busy once, takes
// no JSON-RPC batch and no Multicall3 - and must come to the same snapshot.
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
/// Code that only reverts: a contract, as a pool or a locker is to this page.
const SOME_CONTRACT = "0x6080604052600080fd";

const H = {};             // the accounts, by name
let OLD = "";             // the old token
let DEPLOYED = 0;         // the block it was created in
let SNAP = 0;             // the snapshot block
const NEW = STATE.token.toLowerCase();   // a Curb launch: the waiting stack's

test.beforeAll(async () => {
  if (!fs.existsSync(ARTIFACT)) throw new Error("no " + ARTIFACT + ": the run's build should have made it (forge build)");
  const art = JSON.parse(fs.readFileSync(ARTIFACT, "utf8"));
  H.seed = await signer("seed");
  H.a = await signer("a");
  H.b = await fresh("b");
  H.c = await fresh("c");
  H.d = await fresh("d");
  H.y = await fresh("y");
  H.pool = await fresh("pool");
  H.safe = await fresh("safe");
  H.deleg = await fresh("delegated");
  await rpc("anvil_setCode", [H.pool, SOME_CONTRACT]);
  await rpc("anvil_setCode", [H.safe, SAFE_PROXY]);
  await rpc("anvil_setCode", [H.deleg, "0xef0100" + "63c0c19a282a1b52b07dd5a65b58948a07dae32b"]);

  const args = encode([T.string, T.string, T.string, T.address, T.uint()], [NAME, SYMBOL, "", H.seed, 10000n * E]);
  const r = await sendMined({ from: H.seed, data: art.bytecode.object + args.slice(2), gas: "0x" + (3_000_000).toString(16) });
  OLD = r.contractAddress.toLowerCase();
  DEPLOYED = parseInt(r.blockNumber, 16);

  await transfer(OLD, H.seed, H.a, 1000n * E);
  await transfer(OLD, H.seed, H.b, 2505n * E / 10n);
  await transfer(OLD, H.seed, H.c, 4n * E / 10n);
  await transfer(OLD, H.seed, DEAD, 100n * E);
  await transfer(OLD, H.seed, H.pool, 500n * E);
  await transfer(OLD, H.seed, H.safe, 40n * E);
  await transfer(OLD, H.seed, H.deleg, 42n * E);
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
  [H.seed, 10000n * E - 1000n * E - 2505n * E / 10n - 4n * E / 10n - 100n * E - 500n * E - 40n * E - 42n * E - 1000n * E - 1n],
  [H.a, 900n * E], [H.pool, 500n * E], [H.b, 3505n * E / 10n], [DEAD, 100n * E], [H.deleg, 42n * E],
  [H.safe, 40n * E], [H.c, 4n * E / 10n], [H.y, 1n],
];

// ------------------------------------------------------------------ the page
const pairUrl = (extra = {}) => "/migrate.html?" + new URLSearchParams({ rpc: STATE.rpc, lens: STATE.lens, ...extra }).toString();
async function open(page, extra) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(pairUrl(extra));
  await page.waitForFunction(() => !!window.CurbMigrate, null, { timeout: 10_000 });
  return errors;
}
/// THROUGH AN ENDPOINT OF THIS FILE'S OWN the first block is given, not found:
/// an https endpoint is no fork to the page (sharing.js mayBeFork), so it would
/// bisect from block 0 - which this fork answers from its upstream, slowly.
/// The first test finds it through the node itself.
async function fillForm(page, { rpcUrl = "" } = {}) {
  await page.fill("#mOld", OLD);
  await page.fill("#mBlock", String(SNAP));
  if (rpcUrl) {
    await page.locator("#mMore summary").click();
    await page.fill("#mRpc", rpcUrl);
    await page.fill("#mFrom", String(DEPLOYED));
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
  const kinds = Object.fromEntries(s.holders.map(([a, , k]) => [a, k]));
  expect(kinds[H.pool]).toBe("contract");
  expect(kinds[H.safe]).toBe("safe");
  expect(kinds[H.deleg], "an EIP-7702 wallet was taken for a contract").toBe("delegated");
  expect(kinds[H.a]).toBe("wallet");
  await expect(page.locator("#mSupply")).toContainText("the token's whole supply at that block");

  // THE NAME AND SYMBOL ARE A STRANGER'S MARKUP, drawn as text.
  await expect(page.locator("#mInfo")).toContainText(NAME);
  await expect(page.locator("#mInfo")).toContainText(SYMBOL);
  expect(await page.locator("#mInfo img, #mInfo b b, main img").count()).toBe(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();

  // RATIO 2.5, NO MINIMUM, THE SEED LEFT OUT BY HAND; the pool left out as a
  // contract, the Safe and the 7702 wallet kept, the dead address always out.
  await page.fill("#mRatio", "2.5");
  await page.fill("#mExclude", "not-an-address\n" + H.seed.toUpperCase().replace("0X", "0x"));
  await page.fill("#mNew", NEW);
  await expect(page.locator("#mNewInfo")).toContainText("a Curb launch", { timeout: 15_000 });
  await expect(page.locator("#mExcludeNote")).toContainText("Not addresses, so not used: not-an-address");
  const rows1 = [[H.a, "2250"], [H.b, "876.25"], [H.deleg, "105"], [H.safe, "100"], [H.c, "1"], [H.y, "0.000000000000000002"]];
  await expect(page.locator("#mNeed")).toContainText("must hold at least 3332.250000000000000002 ");
  await expect(page.locator("#mTotals")).toContainText("9");
  const safe1 = await fetchDownload(page, "button.mSafe");
  expect(safe1.name).toBe("airdrop-" + OLD.slice(0, 10) + "-block-" + SNAP + "-safe.csv");
  expect(safe1.text).toBe(safeFile(rows1));
  const plain1 = await fetchDownload(page, "#mPlain");
  expect(plain1.name).toBe("airdrop-" + OLD.slice(0, 10) + "-block-" + SNAP + ".csv");
  expect(plain1.text).toBe(plainFile(rows1));
  const why = (a) => page.locator(`#mTable tr[data-a="${a}"]`);
  await expect(why(H.seed)).toContainText("left out: your list");
  await expect(why(DEAD)).toContainText("left out: burn address");
  await expect(why(H.pool)).toContainText("left out: contract");
  await expect(why(H.deleg)).toContainText("wallet (EIP-7702)");
  expect(await page.locator("#mResult").textContent(), "a missing value was drawn as a word").not.toMatch(/null|undefined|NaN/);

  // RATIO 0.333 AND A MINIMUM OF 1: the dust goes; the Safe left out and the
  // pool kept, by their boxes.
  await page.fill("#mRatio", "0.333");
  await page.fill("#mMin", "1");
  await expect(why(H.c)).toContainText("left out: below the minimum");
  await page.locator(`#mContracts tr[data-a="${H.safe}"] input`).check();
  await page.locator(`#mContracts tr[data-a="${H.pool}"] input`).uncheck();
  const rows2 = [[H.a, "299.7"], [H.pool, "166.5"], [H.b, "116.7165"], [H.deleg, "13.986"]];
  await expect(why(H.safe)).toContainText("left out: Safe, left out");
  await expect(why(H.pool)).not.toContainText("left out");
  expect((await fetchDownload(page, "button.mSafe")).text).toBe(safeFile(rows2));
  expect((await fetchDownload(page, "#mPlain")).text).toBe(plainFile(rows2));

  // A RATIO THAT TURNS ONE WEI INTO NOTHING leaves it out, said so.
  await page.fill("#mRatio", "0.4");
  await page.fill("#mMin", "");
  await expect(why(H.y)).toContainText("left out: rounds to 0");
  // A COMMA IS REFUSED, and no file is offered while it is.
  await page.fill("#mRatio", "0,4");
  await expect(page.locator("#mErr")).toContainText("use a dot for decimals");
  await expect(page.locator("#mFiles button")).toHaveCount(0);
  await page.fill("#mRatio", "1");

  // CONTRACTS NOT LOOKED FOR: the Safe left out by its box above is a holder
  // like any other again.
  await expect(why(H.safe)).toContainText("left out: Safe, left out");
  await page.locator("#mFindContracts").uncheck();
  await expect(page.locator("#mContractsBox")).toBeHidden();
  await expect(why(H.safe)).not.toContainText("left out");

  // A NEW TOKEN THAT IS NO LAUNCH is said to be one.
  await page.fill("#mNew", OLD);
  await expect(page.locator("#mNewInfo")).toContainText("not a launch in Curb's registry", { timeout: 15_000 });

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
