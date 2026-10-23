// THE WHOLE USER FLOW, WITH TRANSACTIONS THAT ACTUALLY EXECUTE.
//
// Every send here goes to the fork and is mined. The wallet stub forwards
// eth_sendTransaction to the node, which holds the key and signs, so a hash
// coming back means a transaction happened - and every claim below is checked
// against balances and receipts afterwards rather than against what the page
// said it was doing. A stub that only returns a plausible hash would let all of
// this pass while nothing worked.
//
// WHO IS WHO, and it matters. launch() is open to anyone now, so the account
// that creates the launch is a choice rather than a requirement - these use the
// deployer because it is funded. The deployer is ALSO the fee hook's fee
// recipient, so a trade made from it puts the swap output and the hook's fee in
// one balance where they cannot be told apart - a first reading of the pool
// quote looked 1% wrong for exactly that reason, and the quote was right. Every
// trade below is therefore made from a second account that collects nothing,
// which is also the honest demonstration that trading needs no privilege.
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

const STATE = JSON.parse(fs.readFileSync(path.join(__dirname, ".state.json"), "utf8"));
const STUB = fs.readFileSync(path.join(__dirname, "..", "wallet-stub.js"), "utf8");

const APP = STATE.app;
// The OTHER deployment, from script/b20/demo-waiting.sh. Its factory, lens and
// graduator are different addresses, which is the only way a test can tell a
// cached value from a freshly read one.
const OTHER = STATE.other;

// app.js's own address store. launch.js has a DIFFERENT one, and two of these
// tests were poking that one by mistake: the setup did nothing and the test
// agreed with whatever happened.
const APP_ADDR_STORE = "curb.app.v1";

const OWNER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const TRADER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const NVDAC = "0xb20000000000000000000078ee7ce2fe4908108c";

/// PRESS THE BUTTON, DO NOT CALL THE FUNCTION.
///
/// Every action here used to run as page.evaluate(() => CurbApp.curveAction()),
/// which skips the onclick wiring and guard() entirely - unbind every button and
/// the suite stayed green. A click goes through what a person goes through, and
/// then waits for the page to say what happened, because the click returns as
/// soon as the handler is dispatched.
async function press(p, id, expect_) {
  await p.click("#" + id);
  await expect_(p.locator("#msg")).toBeVisible({ timeout: 30_000 });
  // guard() re-enables the buttons when it is done; until then the action runs.
  await p.waitForFunction((sel) => !document.querySelector(sel).disabled, "#" + id, { timeout: 60_000 });
  const msg = await p.locator("#msg").textContent();
  if (/^(Could not|.*reverted|.*was expected)/.test((msg || "").trim())) {
    throw new Error("the page reported a failure: " + msg);
  }
  return msg;
}

// One browser page for the whole flow: it is one user's session, and the state
// each step leaves behind is what the next one needs.
test.describe.configure({ mode: "serial" });

let browserRef;
let page;
let token = null;

/// A FRESH PAGE PER ACCOUNT. addInitScript accumulates on a page, and the order
/// separate init scripts run in is undefined - so switching the wallet by
/// adding a second one would be a race rather than a switch.
async function openApp(account, factoryOverride) {
  if (page) await page.close();
  page = await browserRef.newPage();
  page.on("pageerror", (e) => console.log("PAGE ERROR: " + e.message));

  const bootstrap = [
    STUB,
    ";(function () {",
    "  var cfg = " + JSON.stringify({ rpc: STATE.rpc, account }) + ";",
    "  window.ethereum = window.makeWallet(cfg.rpc, { forward: true, chainId: '0x2105', account: cfg.account });",
    "})();",
  ].join("\n");
  await page.addInitScript({ content: bootstrap });

  const q = new URLSearchParams({ rpc: STATE.rpc, factory: factoryOverride || APP.factory, lens: APP.lens });
  if (token) q.set("token", token);
  await page.goto("/app.html?" + q.toString());
  await page.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
  await page.evaluate(() => window.CurbApp.connect());
  await expect(page.locator("#wallet")).toContainText(account, { ignoreCase: true });
  return page;
}

/// One eth_call over raw RPC, from the test's side - never the page's state.
async function rawCallApp(to, data) {
  const res = await fetch(STATE.rpc, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
  });
  return (await res.json()).result;
}
const padA = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

/// Read a balance the way anything else would: straight from the chain.
/// THE CURVE AS IT WAS IN ONE NAMED BLOCK.
///
/// Every value comes from the SAME block - the one the transaction landed in -
/// so a reserve and a status can be spoken of together. Read at "latest" they
/// cannot: "latest" moves, and a reserve fetched before a transaction was mined,
/// sitting beside a receipt fetched after it, reads like one observation and is
/// two.
async function curveStateAt(p, curve, blockNumber) {
  return p.evaluate(async ({ rpc, curve: c, block }) => {
    const k = window.CurbKeccak.keccak256, h = window.CurbAbi.utf8Hex;
    const sel = (sig) => k("0x" + h(sig)).slice(0, 10);
    const call = (data) => fetch(rpc, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: c, data }, block] }),
    }).then((r) => r.json()).then((r) => r.result);
    return {
      reserve: await call(sel("realQuoteReserve()")),
      threshold: await call(sel("graduationThreshold()")),
      ready: await call(sel("readyToGraduate()")),
      graduated: await call(sel("graduated()")),
      atBlock: block,
    };
  }, { rpc: STATE.rpc, curve, block: blockNumber });
}

/// WAIT FOR A TRANSACTION, AND INSIST IT ARRIVED AND SUCCEEDED.
///
/// eth_sendTransaction returns when the node has ACCEPTED a transaction, not
/// when it has mined it. Three steps in this file refreshed the page against a
/// chain that had not moved yet, and failed one run in three with a message -
/// "expected Waiting, received Selling" - that said nothing about the cause.
///
/// The loops that fixed that lived inside page.evaluate and gave up SILENTLY
/// when the receipt never came, which turns a node that has stopped answering
/// into the same confusing failure. This is the one place it is done, it fails
/// loudly with what it was waiting for, and it requires status 0x1 rather than
/// merely a receipt.
async function mustBeMined(p, hash, what) {
  expect(hash, `${what}: the node returned no transaction hash`).toMatch(/^0x[0-9a-f]{64}$/);
  let receipt = null;
  await expect
    .poll(async () => {
      receipt = await receiptOf(p, hash);
      return receipt != null;
    }, { timeout: 20_000, message: `${what}: no receipt for ${hash} after 20s` })
    .toBe(true);
  expect(receipt.status, `${what}: ${hash} was mined and reverted`).toBe("0x1");
  return receipt;
}

/// The receipt, so a test can compute the fee and the unwrapped ETH itself
/// instead of believing what the page printed.
async function receiptOf(p, hash) {
  return p.evaluate(async ({ rpc, h }) => (await (await fetch(rpc, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [h] }),
  })).json()).result, { rpc: STATE.rpc, h: hash });
}

/// The last transaction MINED, taken from the node rather than from the stub's
/// bookkeeping or from the screen - both of which are things under test.
async function lastHash(p) {
  return p.evaluate(async (rpc) => {
    const b = (await (await fetch(rpc, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["latest", true] }),
    })).json()).result;
    const txs = b.transactions;
    return txs[txs.length - 1].hash;
  }, STATE.rpc);
}

/// ETH IS NOT AN ERC20 and has no balanceOf to call, which is the whole reason
/// the page reports it differently.
async function ethBalance(p, who) {
  return BigInt(await p.evaluate(async ({ rpc, addr }) => (await (await fetch(rpc, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [addr, "latest"] }),
  })).json()).result, { rpc: STATE.rpc, addr: who }));
}

async function balanceOf(p, tokenAddr, who) {
  return BigInt(
    await p.evaluate(
      async ({ tokenAddr, who, rpc }) => {
        const sel = window.CurbKeccak.keccak256("0x" + window.CurbAbi.utf8Hex("balanceOf(address)")).slice(0, 10);
        const data = sel + who.toLowerCase().replace(/^0x/, "").padStart(64, "0");
        const res = await fetch(rpc, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: tokenAddr, data }, "latest"] }),
        });
        return (await res.json()).result;
      },
      { tokenAddr, who, rpc: STATE.rpc }
    )
  );
}

test.beforeAll(async ({ browser }) => {
  browserRef = browser;

  // FUNDS RUN OUT, AND THAT MUST NOT LOOK LIKE A CODE FAILURE.
  //
  // Every trade here spends real NVDAc, and CURB_APP_* attaches to a stack that
  // earlier runs have already traded on. Drained, the suite fails on a balance
  // assertion in the middle of a trade test - which reads as a broken page and
  // is not. It cost a wrong conclusion about two mutations being "caught".
  const probe = await browser.newPage();
  try {
    const raw = await probe.evaluate(
      async ({ rpc, who, nvdac }) => {
        const res = await fetch(rpc, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{
            to: nvdac,
            data: "0x70a08231" + who.toLowerCase().replace(/^0x/, "").padStart(64, "0"),
          }, "latest"] }),
        });
        return (await res.json()).result;
      },
      { rpc: STATE.rpc, who: TRADER, nvdac: NVDAC }
    );
    const held = BigInt(raw || "0x0");
    const need = 200n * 10n ** 8n;           // 200 NVDAc: one pass through this file
    expect(held >= need,
      `the trading account holds ${held} raw NVDAc and this file needs about ${need}. ` +
      `Restart the node and let global-setup deploy again:  bash script/b20/start-node.sh`).toBe(true);
  } finally {
    await probe.close();
  }
});
test.afterAll(async () => { if (page) await page.close(); });

test("a launch is created, and the token comes from the event", async () => {
  await openApp(OWNER);
  await page.fill("#nSymbol", "E2E");
  await page.fill("#nName", "End To End");

  await press(page, "create", expect);
  const created = await page.evaluate(() => window.CurbApp.state.chainCfg.token);
  expect(created).toMatch(/^0x[0-9a-f]{40}$/);
  token = created;
  await expect(page.locator("#msg")).toContainText("Launched");

  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(page.locator("#status")).toHaveText("Selling");
  // 1,000,000,000 before anything is burned.
  await expect(page.locator("#supply")).toHaveText("1,000,000,000");

  // AND IT IS A REAL TOKEN, not just an address the page printed: the whole
  // supply is sitting in the curve the lens reports.
  const curve = await page.evaluate(() => window.CurbApp.state.view.curve);
  expect((await balanceOf(page, token, curve)).toString()).toBe((10n ** 27n).toString());
});

/// THE CURVE'S OWN RATES, read off the curve. These used to be written into
/// the test as { fee: 100n, tax: 300n }, which was the demo's split at the
/// time - and when the fee policy changed to one creator-chosen tax the tests
/// predicted a number the contract had no reason to produce. A rate that a
/// creator picks per launch is not a constant, and a test asserting on an
/// exact integer must not carry its own copy of one.
async function curveFees(page, curve) {
  return page.evaluate(async ({ rpc, curve }) => {
    const k = window.CurbKeccak.keccak256, h = window.CurbAbi.utf8Hex;
    const sel = (sig) => k("0x" + h(sig)).slice(0, 10);
    const call = async (data) => {
      const res = await fetch(rpc, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: curve, data }, "latest"] }),
      });
      return BigInt((await res.json()).result).toString();
    };
    return { fee: await call(sel("feeBps()")), tax: await call(sel("creatorTaxBps()")) };
  }, { rpc: STATE.rpc, curve });
}

test("a buy on the curve delivers EXACTLY what the quote said", async () => {
  await openApp(TRADER);
  await page.fill("#curveAmount", "10");
  await page.selectOption("#curveSide", "buy");
  await page.evaluate(() => window.CurbApp.refresh(true));

  const rates = await curveFees(page, await page.evaluate(() => window.CurbApp.state.view.curve));
  const predicted = BigInt(await page.evaluate(async (rates) => {
    const s = window.CurbApp.state;
    const fees = { fee: BigInt(rates.fee), tax: BigInt(rates.tax) };
    const q = window.CurbApp.quoteBuy(
      window.CurbApp.parseUnits("10", 8),
      { quote: s.view.quoteReserve, token: s.view.tokenReserve },
      fees,
      (1n << 255n)
    );
    return q.out.toString();
  }, rates));
  expect(predicted).toBeGreaterThan(0n);

  const before = await balanceOf(page, token, TRADER);
  await press(page, "curveAct", expect);
  const after = await balanceOf(page, token, TRADER);

  // NOT "about right". The curve's arithmetic is integer arithmetic and the
  // page mirrors it, so the only acceptable answer is the same number.
  expect((after - before).toString()).toBe(predicted.toString());
  // AND THE MESSAGE SAYS IT FROM THE CURVE'S OWN EVENT. It used to report the
  // balance difference, which is a fact about the account over a period rather
  // than about this trade.
  await expect(page.locator("#msg")).toContainText("The curve gave you");
  await expect(page.locator("#msg")).toContainText("exact, in the smallest unit");
  const exactOut = (await page.locator("#msg").textContent()).match(/out\s+(\d+)/);
  expect(exactOut, "the message carries no exact output").not.toBeNull();
  expect(BigInt(exactOut[1]), "the reported output is not what the balance moved by")
    .toBe(after - before);
});

test("the page says so when a trade has no floor under it", async () => {
  // AUDIT.txt E-3 measured what this warning is about: a sandwich against a
  // curve buy that passed no minimum nets the attacker real money and lands
  // the victim's fill 38.7% worse. The slippage field accepts 100, which sets
  // the minimum to exactly zero and reproduces that victim, and nothing on
  // the page used to say so.
  await page.selectOption("#curveSide", "buy");
  await page.fill("#curveAmount", "1");

  // ---- 1. THE DEFAULT IS QUIET. Checked first and on purpose: a warning
  // that is always on screen is not a warning, and every assertion below
  // would pass against one.
  await page.fill("#slippage", "1");
  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(page.locator("#curveQuote")).toContainText("minimum out");
  await expect(page.locator("#curveQuote .unbounded")).toHaveCount(0);
  await expect(page.locator("#curveQuote")).not.toContainText("bound is wide");

  // ---- 2. A WIDE BOUND SAYS IT IS WIDE, and is still not the strong one.
  await page.fill("#slippage", "25");
  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(page.locator("#curveQuote")).toContainText("25% bound is wide");
  await expect(page.locator("#curveQuote .unbounded")).toHaveCount(0);

  // ---- 3. NO FLOOR AT ALL.
  await page.fill("#slippage", "100");
  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(page.locator("#curveQuote .unbounded")).toHaveCount(1);
  await expect(page.locator("#curveQuote")).toContainText("NO FLOOR UNDER THIS TRADE");

  // AND THE WARNING IS TRUE, not merely present. computeCurveQuote is what
  // the button sends, so the floor is read from THERE rather than inferred
  // from the percentage on screen - which would only be checking the screen
  // against itself.
  const min = await page.evaluate(async () => (await window.CurbApp.computeCurveQuote()).min.toString());
  expect(min, "the page warned about a floor of zero it was not actually going to send").toBe("0");

  // ---- and back, so the next test starts where it expects to.
  await page.fill("#slippage", "1");
  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(page.locator("#curveQuote .unbounded")).toHaveCount(0);
});

test("a sell returns exactly the quoted NVDAc, and the fees are shown", async () => {
  await page.selectOption("#curveSide", "sell");
  await page.fill("#curveAmount", "50000000");
  await page.evaluate(() => window.CurbApp.refresh(true));

  // "platform fee", not "curve fee". The row shows the platform's fixed 50 bps,
  // which is HALF OF THE TAX at the band's floor - and beside the tax rate the
  // old label read like a separate charge. The two rows plus the creator's are
  // the tax, and they have to add up on screen.
  await expect(page.locator("#curveQuote")).toContainText("platform fee");
  await expect(page.locator("#curveQuote")).toContainText("creator fee");
  await expect(page.locator("#curveQuote")).toContainText("this launch's tax");
  await expect(page.locator("#curveQuote")).toContainText("minimum out");

  const rates = await curveFees(page, await page.evaluate(() => window.CurbApp.state.view.curve));
  const predicted = BigInt(await page.evaluate(async (rates) => {
    const s = window.CurbApp.state;
    const q = window.CurbApp.quoteSell(
      window.CurbApp.parseUnits("50000000", 18),
      { quote: s.view.quoteReserve, token: s.view.tokenReserve },
      { fee: BigInt(rates.fee), tax: BigInt(rates.tax) }
    );
    return q.out.toString();
  }, rates));

  const before = await balanceOf(page, NVDAC, TRADER);
  await press(page, "curveAct", expect);
  const after = await balanceOf(page, NVDAC, TRADER);
  expect((after - before).toString()).toBe(predicted.toString());
});

test("the page shows Waiting, and anyone can complete the move", async () => {
  // Crossing the threshold on a tight gas limit is the only way to SEE the
  // waiting state: with enough gas the curve graduates inside the buy. The
  // limit is set outside the page because a wallet, not a page, chooses it -
  // what is being tested here is that the page then reads the state and
  // finishes it. The assertions below are on the STATE at the receipt's block,
  // not on why the curve's own attempt failed - the catch keeps no reason, so
  // neither the event nor the receipt carries one.
  await page.selectOption("#curveSide", "buy");
  await page.fill("#curveAmount", "35");
  await page.evaluate(() => window.CurbApp.refresh(true));
  await press(page, "curveAct", expect);

  const curve = await page.evaluate(() => window.CurbApp.state.view.curve);
  const crossing = await page.evaluate(
    async ({ curve, rpc, trader, nvdac }) => {
      const k = window.CurbKeccak.keccak256, h = window.CurbAbi.utf8Hex;
      const sel = (s) => k("0x" + h(s)).slice(0, 10);
      const pad = (v) => v.toLowerCase().replace(/^0x/, "").padStart(64, "0");
      const post = (method, params) =>
        fetch(rpc, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        }).then((r) => r.json());
      const max = "f".repeat(64);
      await post("eth_sendTransaction", [{ from: trader, to: nvdac, data: sel("approve(address,uint256)") + pad(curve) + max }]);
      const call0 = (to, data) => post("eth_call", [{ to, data }, "latest"]).then((r) => r.result);
      const reserveBefore = await call0(curve, sel("realQuoteReserve()"));
      const sent = await post("eth_sendTransaction", [{
        from: trader, to: curve, gas: "0xdbba0", // 900,000, under graduation's own cost
        data: sel("buy(uint256,uint256,address)") + (20n * 10n ** 8n).toString(16).padStart(64, "0") + "0".repeat(64) + pad(trader),
      }]);
      // SENDING IS ALL THAT HAPPENS HERE. Reading the curve now would read it at
      // "latest", which is whatever block exists at this instant - possibly
      // before this transaction is in one. The state is read by the test, AT
      // THE RECEIPT'S BLOCK, once there is a receipt.
      return { error: sent.error ? JSON.stringify(sent.error) : null, hash: sent.result, reserveBefore };
    },
    { curve, rpc: STATE.rpc, trader: TRADER, nvdac: NVDAC }
  );

  // SEND -> RECEIPT -> STATE AT THAT RECEIPT'S BLOCK -> render. Anything else
  // reports a before and an after as if they were one moment, which is how "a
  // successful buy added nothing to the reserve" came to be written down as a
  // finding when nothing of the sort had been measured.
  const crossReceipt = await mustBeMined(page, crossing.hash, "the crossing buy on a tight gas limit");
  crossing.status = crossReceipt.status;
  crossing.gasUsed = parseInt(crossReceipt.gasUsed, 16);
  Object.assign(crossing, await curveStateAt(page, curve, crossReceipt.blockNumber));
  await page.evaluate(() => window.CurbApp.refresh(true));
  const num = (w) => (w ? BigInt(w).toString() : "?");
  const why =
    `crossing buy: error ${crossing.error}, status ${crossing.status}, ` +
    `gasUsed ${crossing.gasUsed} of 900000; reserve ${num(crossing.reserveBefore)} before it, and ` +
    `${num(crossing.reserve)} of ${num(crossing.threshold)} IN ITS OWN BLOCK ${crossing.atBlock}, ` +
    `ready ${num(crossing.ready)}, graduated ${num(crossing.graduated)}`;
  expect(num(crossing.ready), `the curve is not ready after the crossing buy — ${why}`).toBe("1");
  expect(num(crossing.graduated), `the curve graduated instead of waiting — ${why}`).toBe("0");
  await expect(page.locator("#status"), why).toHaveText("Waiting");
  await expect(page.locator("#waitBox")).toBeVisible();
  await expect(page.locator("#curveBox")).toBeHidden();

  await press(page, "complete", expect);
  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(page.locator("#status")).toHaveText("Graduated");
  await expect(page.locator("#msg")).toContainText("Anyone could have sent this");

  // r = 18.5 / 68.5 on the shipped NVDAc terms (re-priced 2026-10-15; it was
  // 18.1 / 67.2 and left 927,45x,xxx), so r^2 - about 7.29% of the supply,
  // about 72,939,000 - is the remainder and it is burned. (A quarter, and
  // 750,000,000 left, on D1's r = 0.5.) The last digits move with the fee
  // drift at the crossing, so they are not pinned.
  await expect(page.locator("#supply")).toHaveText(/^927,06\d,\d{3}$/);
});

test("the lock and the burn are shown, read from the graduator's own record", async () => {
  const facts = page.locator("#lockFacts");
  await expect(facts).toContainText("LP lock");
  await expect(facts).toContainText("held by the lock");
  // NO UNLOCK DATE: there is none.
  await expect(facts).toContainText("never — the liquidity is locked forever");
  await expect(facts).not.toContainText("UTC (");
  await expect(facts).toContainText("beneficiary");
  // The burn, from the graduator's burnedOf: r^2 of the supply on NVDAc's 18.5 /
  // 50 (2026-10-15; 72,54x,xxx on 18.1 / 49.1), the complement of the supply
  // the test above reads.
  await expect(facts).toContainText(/72,93\d,\d{3}/);

  // The lock address on screen really is a contract that holds the position.
  const lock = await page.evaluate(() => {
    const m = document.getElementById("lockFacts").innerHTML.match(/0x[0-9a-fA-F]{40}/);
    return m && m[0];
  });
  expect(lock).toMatch(/^0x[0-9a-fA-F]{40}$/);
  const code = await page.evaluate(
    async ({ lock, rpc }) =>
      (await (await fetch(rpc, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [lock, "latest"] }),
      })).json()).result,
    { lock, rpc: STATE.rpc }
  );
  expect(code.length).toBeGreaterThan(2);
});

/// The value half of the pool quote's "pool fee" row - the row LABELLED so; the
/// cost row mentions "pool fee" in its value too.
const poolFeeValue = (p) => p.locator("#poolQuote .row")
  .filter({ has: p.locator("span:first-child", { hasText: /^pool fee$/ }) })
  .locator("span:nth-child(2)");

test("a pool swap through UniversalRouter delivers exactly the quoted amount", async () => {
  await page.fill("#poolAmount", "1");
  await page.selectOption("#poolSide", "buy");
  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(page.locator("#poolQuote")).toContainText("platform fee");
  await expect(page.locator("#poolQuote")).toContainText("creator fee");
  // AND THE LP FEE ON ITS OWN LINE, because it is not part of the tax and
  // folding it in would report a cost to us that is not ours.
  await expect(page.locator("#poolQuote")).toContainText("pool fee");
  // AND IN WHAT: on a buy the v4 leg takes the quote asset, and the amount
  // says so. It was a bare number (round 5, N28).
  const buySym = await page.evaluate(() => window.CurbApp.state.ctx.quoteSym);
  await expect(poolFeeValue(page), "the pool fee on a buy names no token")
    .toHaveText(new RegExp("^[\\d,.]+ " + buySym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " \\("));


  // THE PAGE'S OWN QUOTE, taken through the page's own code path so the tax it
  // reads is the pool's rather than a constant this test carries.
  const quoted = await page.evaluate(async () => {
    const v = await window.CurbApp.computePoolQuote();
    return {
      out: v.out.toString(), platform: v.q.platform.toString(), creator: v.q.creator.toString(),
      fromQuoter: v.outFromQuoter === true,
    };
  });
  // AND IT CAME FROM THE CHAIN'S OWN QUOTER. The closed form behind it agrees
  // while this pool holds nothing but the launch's locked position - which is
  // this fixture - so a silent fall back would pass every other assertion here
  // and the reason for asking at all would be gone with nothing to show it.
  expect(quoted.fromQuoter, "the page modelled the pool instead of quoting it").toBe(true);

  const before = await balanceOf(page, token, TRADER);
  await press(page, "poolAct", expect);
  const after = await balanceOf(page, token, TRADER);

  // The trader is neither recipient, so this delta is the trade alone.
  expect((after - before).toString()).toBe(quoted.out);
  expect(BigInt(quoted.platform), "the platform's leg was quoted as nothing").toBeGreaterThan(0n);
  expect(BigInt(quoted.creator), "the creator's leg was quoted as nothing").toBeGreaterThan(0n);
  await expect(page.locator("#msg")).toContainText("official UniversalRouter");
});

test("and back out again: selling into the pool returns NVDAc", async () => {
  await page.selectOption("#poolSide", "sell");
  await page.fill("#poolAmount", "1000000");
  await page.evaluate(() => window.CurbApp.refresh(true));
  // ON A SELL THE v4 LEG TAKES LAUNCH TOKENS, and the pool fee is in them (N28).
  await expect(poolFeeValue(page), "the pool fee on a sell names no token").toHaveText(/^[\d,.]+ tokens \(/);

  // THROUGH THE PAGE'S OWN QUOTE, not a hand-rolled call to quotePoolSwap with
  // the tax argument left off. Omitting it quotes an untaxed swap, which is a
  // different number and a test that would pass only while the pool charged
  // nothing.
  const predicted = await page.evaluate(async () => (await window.CurbApp.computePoolQuote()).out.toString());

  const before = await balanceOf(page, NVDAC, TRADER);
  await press(page, "poolAct", expect);
  const after = await balanceOf(page, NVDAC, TRADER);
  expect((after - before).toString()).toBe(predicted);
});

// ============================================================================
// THE COST LINE - checked as a number on the screen, against prices read from
// the contracts that hold them
// ============================================================================
//
// TWO THINGS THIS HAD WRONG THE FIRST TIME, and both would have let a broken
// screen through:
//
//   IT CHECKED THE FUNCTION, NOT THE SCREEN. It compared totalCostBps() to a
//   value it computed, and then asked only whether the page contained SOME
//   percentage. A page that always printed "0.00%" passed. The percentage is
//   parsed out of the row now and compared.
//
//   ITS REFERENCE PRICES CAME FROM THE APP. The v3 mid and the curve's
//   reserves were taken off the quote object the app had just built, so code
//   carrying the WRONG pool's price would carry the test with it. Every
//   reference below is read straight from the contract that holds it - the
//   registry for the launch record, StateView for our pool, the v3 factory for
//   the conversion pool, the curve for its own reserves - through a raw
//   eth_call that touches no app state.

const STATE_VIEW = "0xa3c0c9b65bad0b08107aa264b0f3db444b867a71";
const V3_FACTORY = "0x33128a8fc17869897dce68ed026d694621f6fdfd";
const WETH = "0x4200000000000000000000000000000000000006";

/// A raw eth_call. The page is a transport here and nothing else.
async function rawCall(p, to, data) {
  return p.evaluate(
    async ({ to, data, rpc }) => {
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
      });
      const j = await res.json();
      if (j.error) throw new Error(j.error.message);
      return j.result;
    },
    { to, data, rpc: STATE.rpc }
  );
}

const selOf = (p, sig) =>
  p.evaluate((x) => window.CurbKeccak.keccak256("0x" + window.CurbAbi.utf8Hex(x)).slice(0, 10), sig);
const pad32 = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const wordAt = (hex, i) => BigInt("0x" + hex.replace(/^0x/, "").slice(i * 64, (i + 1) * 64));
const addrAt = (hex, i) => "0x" + hex.replace(/^0x/, "").slice(i * 64 + 24, (i + 1) * 64);

/// EVERYTHING THE COST IS MEASURED AGAINST, read from the contracts.
///
/// From the token address - which this file knows because it watched the
/// creation event - the registry gives the curve, the fee, the tick spacing and
/// the hook. Those five make the pool key, and its id is hashed here rather
/// than asked for. Nothing in this function reads window.CurbApp.
async function chainRefs(p, tokenAddr) {
  const registry = addrAt(await rawCall(p, APP.factory, await selOf(p, "registry()")), 0);
  const rec = await rawCall(p, registry, (await selOf(p, "launchOf(address)")) + pad32(tokenAddr));
  const refs = {
    curve: addrAt(rec, 0),
    fee: Number(wordAt(rec, 5)),
    tickSpacing: Number(wordAt(rec, 6)),
    hooks: addrAt(rec, 7),
    totalTaxBps: Number(wordAt(rec, 8)),
  };
  const tokenIsC0 = tokenAddr.toLowerCase() < NVDAC.toLowerCase();
  refs.tokenIsC0 = tokenIsC0;

  // PoolId = keccak256(abi.encode(PoolKey)). Every field is static, so it is
  // five words end to end with no offset.
  const keyWords =
    pad32(tokenIsC0 ? tokenAddr : NVDAC) +
    pad32(tokenIsC0 ? NVDAC : tokenAddr) +
    refs.fee.toString(16).padStart(64, "0") +
    refs.tickSpacing.toString(16).padStart(64, "0") +
    pad32(refs.hooks);
  refs.poolId = await p.evaluate((x) => window.CurbKeccak.keccak256("0x" + x), keyWords);

  refs.poolSqrt = wordAt(
    await rawCall(p, STATE_VIEW, (await selOf(p, "getSlot0(bytes32)")) + refs.poolId.replace(/^0x/, "")), 0
  );

  const v3Pool = addrAt(
    await rawCall(
      p, V3_FACTORY,
      (await selOf(p, "getPool(address,address,uint24)")) + pad32(WETH) + pad32(NVDAC) + (3000).toString(16).padStart(64, "0")
    ), 0
  );
  refs.v3Sqrt = wordAt(await rawCall(p, v3Pool, await selOf(p, "slot0()")), 0);
  refs.wethIsC0 = WETH.toLowerCase() < NVDAC.toLowerCase();
  return refs;
}

async function curveReserves(p, curve) {
  const raw = await rawCall(p, curve, await selOf(p, "getReserves()"));
  return { quote: wordAt(raw, 0), token: wordAt(raw, 1) };
}

const TWO192 = 1n << 192n;
/// One BigInt ratio, full precision. Carrying these as 1e18 fixed point is what
/// made the cost line read NEGATIVE on a sell once.
const atSqrt = (sqrt, amount, multiply) =>
  multiply ? (amount * sqrt * sqrt) / TWO192 : (amount * TWO192) / (sqrt * sqrt);
const poolAtMidRef = (refs, side, amountIn) =>
  atSqrt(refs.poolSqrt, amountIn, (side === "buy") !== refs.tokenIsC0);
const v3AtMidRef = (refs, amount, wethToNvdac) =>
  atSqrt(refs.v3Sqrt, amount, refs.wethIsC0 === wethToNvdac);
/// THE MIDS OF THE ROUTE THE PAGE ACTUALLY TOOK, in trade order.
///
/// v3AtMidRef below reads ONE hardcoded pool - WETH/NVDAc at 0.3% - which was
/// right while the route was always that tier. AUDIT M-03 changed it: every
/// tier is quoted now and the best OUTPUT wins, so a small trade through thin
/// WETH/NVDAc pools can go two hops via USDC instead. The reference has to
/// follow the page rather than assume, or it measures a different route and
/// reports the difference as the page being wrong.
///
/// THIS IS ALSO WHAT MADE THE COST TEST FLAKY (audit E-3, "passes in five runs
/// of seven"): anything that moved the deepest pool moved the page off the
/// tier this reference assumed.
async function routeMids(p, hops) {
  const legs = [];
  for (const h of hops) {
    if (!h.pool) return null;   // a guessed tier has no address and no mid
    const sqrt = wordAt(await rawCall(p, h.pool, await selOf(p, "slot0()")), 0);
    legs.push({ sqrt, fromIsC0: h.from.toLowerCase() < h.to.toLowerCase() });
  }
  return legs;
}

/// Walks those mids. `forward` is WETH -> quote; a sell runs them back.
function alongRoute(legs, amount, forward) {
  const walk = forward ? legs : legs.slice().reverse();
  let out = amount;
  for (const leg of walk) out = atSqrt(leg.sqrt, out, leg.fromIsC0 === forward);
  return out;
}

const bpsOf = (expected, got) => Number(((expected - got) * 20000n / expected + 1n) / 2n);

/// Raw units to the decimal string a form field takes. No separators, no
/// rounding: the field has to receive exactly the amount being compared.
function unitsToDecimal(v, decimals) {
  const s = v.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? whole + "." + frac : whole;
}

/// THE NUMBER ON THE SCREEN, from the row itself. Returns null when the row
/// says it could not be priced - and throws if the row is missing entirely,
/// because a silently absent cost is the failure this is for.
async function screenCostBps(p, boxId) {
  return p.evaluate((box) => {
    const rows = Array.from(document.querySelectorAll("#" + box + " .row"));
    const hit = rows.find((r) => (r.children[0].textContent || "").trim() === "total execution cost");
    if (!hit) throw new Error("no 'total execution cost' row on screen");
    const text = (hit.children[1].textContent || "").trim();
    const m = text.match(/(\d+(?:\.\d+)?)%/);
    if (!m) return null;
    return Math.round(parseFloat(m[1]) * 100);
  }, boxId);
}

test("the pool's cost line on screen matches the trade that happens, both directions", async () => {
  await openApp(TRADER);
  const refs0 = await chainRefs(page, token);
  expect(refs0.fee, "the launch record's tier is not the decided one").toBe(500);

  for (const [side, amount, inDec] of [["buy", "1", 8], ["sell", "100000", 18]]) {
    await page.selectOption("#poolVia", "nvdac");
    await page.selectOption("#poolSide", side);
    await page.fill("#poolAmount", amount);
    await page.evaluate(() => window.CurbApp.refresh(true));
    await expect(page.locator("#poolAct")).toBeEnabled();

    // THE PRICE BEFORE THE TRADE, read from StateView, not from the page.
    const refs = await chainRefs(page, token);
    const shown = await screenCostBps(page, "poolQuote");
    expect(shown, side + ": the screen showed no percentage").not.toBeNull();

    const outTok = side === "buy" ? token : NVDAC;
    const before = await balanceOf(page, outTok, TRADER);
    const paidBefore = await balanceOf(page, side === "buy" ? NVDAC : token, TRADER);
    await press(page, "poolAct", expect);
    const got = (await balanceOf(page, outTok, TRADER)) - before;
    const paid = paidBefore - (await balanceOf(page, side === "buy" ? NVDAC : token, TRADER));

    // WHAT THE TRADE ACTUALLY DID, against the price it actually happened at.
    const expected = poolAtMidRef(refs, side, paid);
    const truth = bpsOf(expected, got);
    expect(Math.abs(shown - truth),
      side + ": screen said " + shown + " bps, the executed trade cost " + truth)
      .toBeLessThanOrEqual(2);
    // AND IT IS AT LEAST THE TAX, which is taken out of every trade.
    expect(shown, side + ": the screen's cost is under this launch's tax")
      .toBeGreaterThanOrEqual(refs.totalTaxBps - 2);
  }
});

/// A QUOTE THE PAGE GAVE UP ON IS CANCELLED, NOT LEFT RUNNING.
///
/// QuoterV2 SIMULATES the swap, so a large amount against a thin tier walks
/// every initialised tick and the eth_call can take minutes. bestV3Leg stops
/// waiting after four seconds - but stopping waiting is not stopping the
/// request, and the first version did only the former.
///
/// WHAT THAT COST, MEASURED: a browser holds about six connections to one
/// host, so a few abandoned quotes filled the pool and every read afterwards
/// queued behind answers nobody would read. One refresh() sat for fifty
/// seconds with NOTHING IN FLIGHT to show for it, and the whole page was
/// stuck for the five minutes it was given.
///
/// THIS CHECKS THE MECHANISM, NOT THE SYMPTOM. Running out of connections is
/// the browser's behaviour; what is ours is whether the call is cut off. The
/// quoter is made to never answer, and the signals sent with those calls are
/// read back afterwards.
test("a quote that times out is cancelled rather than left running", async () => {
  await openApp(TRADER);
  await page.evaluate(() => window.CurbApp.refresh(true));
  await page.selectOption("#poolVia", "eth");
  await page.selectOption("#poolSide", "sell");
  await page.fill("#poolAmount", "100000");

  await page.evaluate(() => {
    const sel = window.CurbKeccak
      .keccak256("0x" + window.CurbAbi.utf8Hex("quoteExactInput(bytes,uint256)"))
      .slice(0, 10);
    window.__quoteSignals = [];
    window.__realFetch = window.fetch;
    // A QUOTER THAT NEVER ANSWERS. Everything else still reaches the node,
    // because the page has to get far enough to ask for a quote at all.
    window.fetch = (url, init) => {
      let body = {};
      try { body = JSON.parse((init && init.body) || "{}"); } catch (e) { /* not ours */ }
      const p = body.params && body.params[0];
      if (!p || typeof p.data !== "string" || !p.data.startsWith(sel)) {
        return window.__realFetch(url, init);
      }
      window.__quoteSignals.push((init && init.signal) || null);
      return new Promise((_, reject) => {
        if (init && init.signal) {
          init.signal.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")));
        }
      });
    };
  });

  await page.evaluate(() => window.CurbApp.computePoolQuote());

  await expect
    .poll(() => page.evaluate(() => (window.__quoteSignals || []).length),
      { message: "no quote was asked for, so this test proved nothing", timeout: 15_000 })
    .toBeGreaterThan(0);

  // WAITED FOR RATHER THAN READ ONCE. The form's own input handler has a batch
  // of its own in flight, started before this one and four seconds from its
  // limit, so a single reading catches half of them mid-air. A signal that was
  // never sent counts as uncancelled here too: `!x` fails the same as `!x.aborted`.
  await expect
    .poll(() => page.evaluate(() =>
      (window.__quoteSignals || []).filter((x) => !x || !x.aborted).length),
      { message: "a quote that timed out left its request running", timeout: 25_000 })
    .toBe(0);

  await page.evaluate(() => { if (window.__realFetch) window.fetch = window.__realFetch; });
});

/// AN OLDER QUOTE DOES NOT WRITE OVER A NEWER ONE.
///
/// Reported by an outside audit and real: renderPoolQuote runs on every
/// keystroke and the answers do not come back in the order they were asked
/// for. An abandoned path takes four seconds, an ordinary one takes two
/// hundred milliseconds - so a figure typed and then corrected could be
/// replaced by the price of the figure that was corrected AWAY.
///
/// WHAT WAS SENT WAS NEVER WRONG. poolActionInner quotes again when the button
/// is pressed. This is about what a person is reading when they press it, which
/// on a page that spends money is not a small thing.
///
/// THE DELAY IS PUT ON THE NODE'S ANSWERS rather than faked in the page, so the
/// ordering under test is the real one: the first render's reads take two
/// seconds, the second render's take none, and the first lands last.
test("a slow quote that lands late does not replace the price on screen", async () => {
  await openApp(TRADER);
  await page.evaluate(() => window.CurbApp.refresh(true));
  await page.selectOption("#poolVia", "nvdac");
  await page.selectOption("#poolSide", "sell");

  await page.evaluate(() => {
    window.__delayMs = 0;
    window.__realFetch = window.fetch;
    window.fetch = async (url, init) => {
      const wait = window.__delayMs || 0;
      if (wait) await new Promise((r) => setTimeout(r, wait));
      return window.__realFetch(url, init);
    };
  });

  await page.evaluate(() => { window.__delayMs = 2000; });
  await page.fill("#poolAmount", "1000");          // the slow one
  await page.evaluate(() => { window.__delayMs = 0; });
  await page.fill("#poolAmount", "1");             // the fast one, typed after it

  // LONGER THAN THE SLOW ONE TAKES, so if it is going to land on top of the
  // fast one it has landed by now.
  await page.waitForTimeout(4000);
  const shown = await page.locator("#poolQuote").textContent();
  await page.evaluate(() => { window.__delayMs = 0; if (window.__realFetch) window.fetch = window.__realFetch; });

  expect(shown, "the older quote wrote over the newer one").not.toContain("1,000 tokens");
  expect(shown, "the newer quote is not the one on screen").toContain("1 tokens");
});

/// A TRADE IS NOT SENT WITH A MINIMUM THAT CAME FROM A MODEL.
///
/// quotePoolSwap is exact only while this pool holds nothing but the launch's
/// own full-range position, and anybody may add a narrower one. The panel is
/// allowed to show that model and says when it is; the send is not allowed to
/// turn it into the bound somebody signs. Optimistic, the transaction reverts
/// for nothing; pessimistic, they accept less protection than the slippage they
/// chose - and a quoter that cannot be reached is exactly when price risk is
/// highest. Raised by an outside audit as M-04, against the fallback added the
/// same day.
test("a trade is refused when only the model could price it", async () => {
  await openApp(TRADER);
  await page.selectOption("#poolSide", "buy");
  await page.fill("#poolAmount", "1");

  const said = await page.evaluate(async () => {
    const sel = window.CurbKeccak
      .keccak256("0x" + window.CurbAbi.utf8Hex(
        "quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))"))
      .slice(0, 10);
    const real = window.fetch;
    // THE V4 QUOTER ALONE GOES SILENT. Everything else still answers, so the
    // page gets as far as having a model and nothing further.
    window.fetch = (url, init) => {
      let body = {};
      try { body = JSON.parse((init && init.body) || "{}"); } catch (e) { /* not ours */ }
      const p = body.params && body.params[0];
      if (!p || typeof p.data !== "string" || !p.data.startsWith(sel)) return real(url, init);
      return new Promise((_, reject) => {
        if (init && init.signal) init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    };
    try {
      const v = await window.CurbApp.computePoolQuote();
      let refused = null;
      try { await window.CurbApp.poolAction(); } catch (e) { refused = e.message || String(e); }
      return { fromQuoter: v.outFromQuoter === true, refused };
    } finally {
      window.fetch = real;
    }
  });

  expect(said.fromQuoter, "the quoter answered after all, so nothing was tested").toBe(false);
  expect(said.refused, "the page sent a trade bounded by its own model").not.toBeNull();
  expect(said.refused).toContain("will not send a trade whose minimum comes from a model");
});

/// AND A QUOTER THAT WILL NOT ANSWER IS NOT A THIN ROUTE.
///
/// The depth question collapsed a timeout, a transport failure and a genuine
/// refusal into one null, and every null read "no route could price buying N".
/// A node having a bad minute is not a market that cannot supply, and saying so
/// puts an economic claim on an endpoint's behaviour. Audit L-01.
test("a depth question nobody answered says so instead of warning about liquidity", async () => {
  await openApp(TRADER);

  const shown = await page.evaluate(async () => {
    const sel = window.CurbKeccak
      .keccak256("0x" + window.CurbAbi.utf8Hex("quoteExactOutput(bytes,uint256)"))
      .slice(0, 10);
    const real = window.fetch;
    window.fetch = (url, init) => {
      let body = {};
      try { body = JSON.parse((init && init.body) || "{}"); } catch (e) { /* not ours */ }
      const p = body.params && body.params[0];
      if (!p || typeof p.data !== "string" || !p.data.startsWith(sel)) return real(url, init);
      return new Promise((_, reject) => {
        if (init && init.signal) init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    };
    try {
      await window.CurbApp.refresh(true);
      return document.getElementById("quoteLiquidity").textContent;
    } finally {
      window.fetch = real;
    }
  });

  expect(shown, "silence was reported as a thin route").not.toContain("THIN ETH ROUTE");
  expect(shown).toContain("could not be read");
});

test("the ETH route's cost line on screen carries the conversion leg", async () => {
  await openApp(TRADER);
  for (const [side, amount] of [["buy", "0.01"], ["sell", "100000"]]) {
    await page.selectOption("#poolVia", "eth");
    await page.selectOption("#poolSide", side);
    await page.fill("#poolAmount", amount);
    await page.evaluate(() => window.CurbApp.refresh(true));

    const refs = await chainRefs(page, token);
    const shown = await screenCostBps(page, "poolQuote");
    expect(shown, side + ": the screen showed no percentage").not.toBeNull();

    // THE INPUT IS THE FORM'S, and the output is the page's quote - which a
    // separate test in this file pins to what the router actually delivers.
    // The PRICES both are measured against are read from the two pools.
    // `mid` is the NVDAc the conversion leg produces, and the comparison below
    // needs it.
    //
    // THE ROUTE COMES BACK IN THE SAME CALL. Asking for it separately meant a
    // second full quote per side - every hop re-discovered and re-quoted - and
    // that alone pushed this test past its minute.
    const { amountIn, out, midNvdac, hops } = await page.evaluate(async () => {
      const v = await window.CurbApp.computePoolQuote();
      return {
        amountIn: v.amount.toString(),
        out: v.out.toString(),
        midNvdac: v.mid ? v.mid.toString() : null,
        hops: v.route && v.route.hops
          ? v.route.hops.map((h) => ({ from: h.from, to: h.to, fee: h.fee, pool: h.pool }))
          : null,
      };
    });
    const a = BigInt(amountIn);
    expect(hops, side + ": the page reported no route").not.toBeNull();
    const legs = await routeMids(page, hops);
    expect(legs, side + ": a hop had no pool address, so it cannot be priced").not.toBeNull();

    const expected = side === "buy"
      ? poolAtMidRef(refs, "buy", alongRoute(legs, a, true))
      : alongRoute(legs, poolAtMidRef(refs, "sell", a), false);
    const truth = bpsOf(expected, BigInt(out));
    expect(Math.abs(shown - truth),
      side + ": screen said " + shown + " bps, the two pools' prices say " + truth +
      // WHAT IT WAS COMPARING, because "1693 against 153" says nothing about
      // which of the two is wrong. Everything the comparison rests on is
      // printed rather than left to be guessed at from the difference.
      " | in=" + amountIn + " out=" + out + " midNvdac=" + midNvdac +
      " expected=" + expected.toString() + " tokenIsC0=" + refs.tokenIsC0 +
      " poolSqrt=" + (refs.poolSqrt !== undefined ? refs.poolSqrt.toString() : "?") +
      // THE ROUTE, because the reference is only as right as the path it was
      // built from - and that path is the page's choice now, not a constant.
      " route=" + hops.map((h) => h.fee).join("/"))
      .toBeLessThanOrEqual(2);

    // AND STRICTLY MORE THAN THE SAME TRADE MADE HOLDING NVDAc ALREADY.
    //
    // THE TWO HAVE TO BE THE SAME TRADE, and the first version of this was not:
    // it filled 0.01, measured the ETH route, then flipped the control and
    // measured 0.01 NVDAc - a trade about two thousand times smaller. On a BUY
    // the comparable direct trade is the one the conversion sets up, so its
    // input is the NET NVDAc that leg produced. On a SELL both routes start
    // from the same token amount, so the form's figure is already right.
    if (side === "buy") {
      expect(midNvdac, "the ETH route reported no NVDAc in the middle").not.toBeNull();
      await page.fill("#poolAmount", unitsToDecimal(BigInt(midNvdac), 8));
    }
    await page.selectOption("#poolVia", "nvdac");
    await page.evaluate(() => window.CurbApp.refresh(true));
    const direct = await screenCostBps(page, "poolQuote");
    expect(shown,
      side + ": the ETH route priced no dearer than the same trade holding NVDAc")
      .toBeGreaterThan(direct);
    // And it is dearer by roughly the conversion leg, not by an accident of
    // size: the gap has to be in the range that leg costs.
    expect(shown - direct, side + ": the gap is not the conversion leg's size")
      .toBeLessThan(400);
  }
});

test("a cost that cannot be priced says so instead of showing a percentage", async () => {
  await openApp(TRADER);
  await page.selectOption("#poolVia", "eth");
  await page.selectOption("#poolSide", "buy");
  await page.fill("#poolAmount", "0.01");
  await page.evaluate(() => window.CurbApp.refresh(true));
  expect(await screenCostBps(page, "poolQuote"), "the control case showed nothing").not.toBeNull();

  // THE CONVERSION POOL'S PRICE IS BROKEN AT THE TRANSPORT. The row must say
  // so, with no figure in it.
  //
  // THIS USED TO BREAK getPool (1698ee82) AND NOW BREAKS slot0 (3850c7bd),
  // because the page changed underneath it and the old injection stopped
  // reaching the thing under test. The route is discovered per asset now - one
  // hop where a WETH pool is better, two through USDC otherwise - and a v3
  // pool's address is CREATE2-deterministic, so the page looks it up once and
  // keeps it. Breaking getPool after that point changes nothing the page still
  // needs, so the old injection tested nothing.
  //
  // THE GUARANTEE IS UNCHANGED, and it is the reason this test exists: a mid
  // price that could not be READ must not be turned into a percentage. slot0
  // is what the mid is read from, so slot0 is what has to fail.
  await page.route("**/*", async (route) => {
    const req = route.request();
    if (req.method() !== "POST") return route.continue();
    if ((req.postData() || "").includes("3850c7bd")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "injected: no slot0" } }),
      });
    }
    return route.continue();
  });
  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(page.locator("#poolQuote")).toContainText("a mid price could not be read");
  expect(await screenCostBps(page, "poolQuote"),
    "a percentage was printed for a cost that could not be priced").toBeNull();
  await page.unroute("**/*");
});

test("a pool swap reports the swap, the hook's fee and the total as three things", async () => {
  // THE FINDING FROM THE REAL-WALLET RUN. The page reported a BALANCE DELTA as
  // "you received". For an account that is also the hook's fee recipient the
  // PoolManager credits it TWICE in one transaction - once with the swap's
  // output and once with the fee - so the number was true of the balance and
  // false about the swap, with nothing on screen to say two things had been
  // added together.
  //
  // Both accounts and both directions. OWNER deployed the stack, so it IS the
  // fee recipient; TRADER is not. DeployCurb makes the deployer the recipient,
  // which is what put a real user in that position in the first place.
  for (const [who, isRecipient] of [[OWNER, true], [TRADER, false]]) {
    for (const [side, amount, outTok, outWho] of [
      ["buy", "1", () => token, who],
      ["sell", "100000", () => NVDAC, who],
    ]) {
      await openApp(who);
      await page.selectOption("#poolSide", side);
      await page.fill("#poolAmount", amount);
      await page.evaluate(() => window.CurbApp.refresh(true));
      await expect(page.locator("#poolAct")).toBeEnabled();

      const before = await balanceOf(page, outTok(), outWho);
      await press(page, "poolAct", expect);
      const after = await balanceOf(page, outTok(), outWho);

      const msg = await page.locator("#msg").textContent();
      const label = `${side} as ${isRecipient ? "the fee recipient" : "an ordinary trader"}`;

      // THE EXACT FIGURES, which exist on screen precisely so this comparison
      // is possible: the readable forms are truncated to six decimals.
      const exact = {};
      for (const m of msg.matchAll(/(gross|platform|creator|net|credited)\s+(\d+)/g)) exact[m[1]] = BigInt(m[2]);
      for (const k of ["gross", "platform", "creator", "net", "credited"]) {
        expect(exact[k], `${label}: the message carries no exact ${k}`).toBeDefined();
      }

      expect(after - before, `${label}: the balance disagrees with the receipt`).toBe(exact.credited);
      expect(exact.platform, `${label}: the platform was charged nothing`).toBeGreaterThan(0n);
      expect(exact.creator, `${label}: the creator was charged nothing`).toBeGreaterThan(0n);

      // WHERE THE TAX SITS DEPENDS ON THE DIRECTION, and that is the thing to
      // assert rather than one subtraction that would be wrong half the time.
      if (side === "buy") {
        // The tax came off the NVDAc going in, so the memecoin that came out is
        // the pool's whole output - nothing was taken from it.
        expect(exact.net, `${label}: the buy's output was taxed`).toBe(exact.gross);
      } else {
        expect(exact.net, `${label}: the sell's net is not the gross minus both legs`)
          .toBe(exact.gross - exact.platform - exact.creator);
      }

      // FEE INCOME, IN WHICHEVER WORDING FITS. OWNER is both payees here, so
      // since R29 the receipt says BOTH legs are this account's rather than
      // "one of those two" - and either way it must say what that part is.
      if (isRecipient) {
        expect(msg).toMatch(/fee income(, not| rather than) something you swapped for/);
      }
      expect(msg).not.toContain("do not match what the pool actually paid out");
    }
  }
});

test("a tax the pool does not charge fails the payment check", async () => {
  // WHY THE OLD CHECK WAS NOT ONE. It compared net + fee against what arrived,
  // and net IS gross - fee, so for an account that is also the fee recipient
  // the fee cancels and the test reduces to gross === credited. A fee computed
  // from the wrong bps moves the same amount out of net and back in, and passes
  // - in exactly the account the whole reading exists for.
  //
  // Each payment the pool made is now matched to a payee and an amount, so a
  // wrong fee has nowhere to hide. This lies about feeBps and requires the page
  // to refuse rather than print a figure it cannot account for.
  await openApp(OWNER);                       // the fee recipient: the hard case
  const hook = await page.evaluate(() => window.CurbApp.state.ctx.hook);
  expect(hook, "no hook in the pinned context").toMatch(/^0x[0-9a-fA-F]{40}$/);
  // LIE ABOUT THE TOTAL, NOT ABOUT THE SPLIT, and the reason is worth keeping.
  //
  // The first version of this lied about platformFeeBps - 250 where the hook
  // charges 50 - and the page ACCEPTED it. On this launch the platform and the
  // creator are the same address, so the chain records two payments to one
  // payee; 250/50 and 50/250 are the same multiset and the total was unchanged.
  // That is not a hole in the check, it is a limit on what a receipt can
  // settle, and the page now says so on screen instead of implying otherwise.
  //
  // What a receipt CAN settle is the total. So this lies about the pool's whole
  // tax: 500 bps where the record says 300.
  const taxOfIdSel = await page.evaluate(() =>
    window.CurbKeccak.keccak256("0x" + window.CurbAbi.utf8Hex("taxOfId(bytes32)")).slice(0, 10));

  // THE REAL REPLY, WITH ONE WORD CHANGED. Inventing the whole answer meant
  // inventing every field in it, and when the record grew two fields the
  // invention was short by two words - so the page read past the end and this
  // test stopped being about a tax mismatch at all. Patching word 0 of the
  // real answer lies about exactly what this test says it lies about.
  await page.route("**/*", async (route) => {
    const body = route.request().postData() || "";
    if (body.toLowerCase().includes(hook.slice(2).toLowerCase()) && body.includes(taxOfIdSel.slice(2))) {
      const real = await route.fetch();
      const payload = await real.json();
      const answer = (payload.result || "").replace(/^0x/, "");
      if (answer.length >= 64) {
        payload.result = "0x" + (500).toString(16).padStart(64, "0") + answer.slice(64);
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
      return;
    }
    await route.continue();
  });

  await page.selectOption("#poolSide", "buy");
  await page.fill("#poolAmount", "1");
  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(page.locator("#poolAct")).toBeEnabled();
  await press(page, "poolAct", expect);

  await expect(page.locator("#msg")).toContainText("do not match what the pool actually paid out");
  await expect(page.locator("#msg")).toContainText("Treat every number above as unexplained");
  await page.unroute("**/*");
});

/// A POOL KEEPS THE PLATFORM SHARE IT OPENED WITH, ON SCREEN AS WELL AS IN THE
/// CONTRACT.
///
/// FeeHook stamps the share into the pool's record when it opens and reads it
/// back on every swap; an announced change decides what the NEXT launch gets.
/// The page has to read the same record, and for a while it did not - it asked
/// the hook what its share is TODAY, which is a different question with the
/// same answer until somebody moves one of them.
///
/// SO THIS MOVES THEM APART, BOTH WAYS. The record is patched and the screen
/// must follow it, or the page is printing a constant. The live rate is
/// watched and must never be asked for, or the screen is one announced change
/// away from naming a share this pool does not charge.
test("the platform share on screen is the pool's own, not the hook's current one", async () => {
  await openApp(TRADER);
  const hook = await page.evaluate(() => window.CurbApp.state.ctx.hook);
  expect(hook, "no hook in the pinned context").toMatch(/^0x[0-9a-fA-F]{40}$/);

  const sels = await page.evaluate(() => ({
    tax: window.CurbKeccak.keccak256("0x" + window.CurbAbi.utf8Hex("taxOfId(bytes32)")).slice(0, 10),
    rate: window.CurbKeccak.keccak256("0x" + window.CurbAbi.utf8Hex("platformFeeBps()")).slice(0, 10),
  }));

  await page.selectOption("#poolSide", "buy");
  await page.fill("#poolAmount", "1");
  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(page.locator("#poolQuote"), "the untouched pool does not show the deployed share")
    .toContainText("0.5% of the NVDAc");

  // ---- THE RECORD MOVES, AND THE SCREEN GOES WITH IT.
  //
  // Word 5 is the pool's own share. 123 is 1.23% and is nothing like 0.5%, so
  // a page printing a constant cannot pass this by accident.
  let liveRateAsked = 0;
  await page.route("**/*", async (route) => {
    const body = route.request().postData() || "";
    const mine = body.toLowerCase().includes(hook.slice(2).toLowerCase());
    if (mine && body.includes(sels.rate.slice(2))) liveRateAsked++;
    if (mine && body.includes(sels.tax.slice(2))) {
      const real = await route.fetch();
      const payload = await real.json();
      const answer = (payload.result || "").replace(/^0x/, "");
      if (answer.length >= 384) {
        payload.result = "0x" + answer.slice(0, 320) + (123).toString(16).padStart(64, "0");
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
      return;
    }
    await route.continue();
  });

  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(page.locator("#poolQuote"), "the screen does not follow the pool's own record")
    .toContainText("1.23% of the NVDAc");

  // ---- AND THE HOOK'S CURRENT SHARE IS NEVER ASKED FOR.
  //
  // Counted rather than stubbed: a stub that is never hit proves nothing on its
  // own, and this is the whole claim - the page reads the record, so it has no
  // reason to ask what the next launch will be stamped with.
  expect(liveRateAsked, "the page asked the hook for its current share").toBe(0);

  await page.unroute("**/*");
  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(page.locator("#poolQuote"), "the patched share outlived the route")
    .toContainText("0.5% of the NVDAc");
});

/// THE PAGE SAYS WHEN IT IS NOT READING THE DEPLOYMENT THIS PRODUCT PUBLISHES.
///
/// Raised by an outside audit as M-04: nothing verifies the contracts a link
/// names. Nothing CAN, today - there is no canonical deployment, because
/// nothing is deployed - so the table is empty and the page adds nothing,
/// which is the honest state rather than an unfinished feature.
///
/// WHICH MEANS THE CHECK WOULD NEVER FIRE IN ANY TEST. So this puts a
/// deployment in the table, points the page somewhere else, and watches. The
/// one live example to compare against is Flaunch, which hardcodes its
/// addresses and offers no override at all; this page has to read forks and
/// second deployments, so it keeps the override and stops being silent about
/// it instead.
test("the page says when it is not pointed at the canonical deployment", async () => {
  await openApp(TRADER);

  const before = await page.evaluate(() => {
    const el = document.getElementById("linkWarn");
    return { hidden: el ? el.hidden : null, text: el ? el.textContent : null };
  });
  expect(before.hidden, "something already warned about where this page points").toBe(true);

  // A DEPLOYMENT THAT IS NOT THIS ONE, recorded for the chain this fork
  // reports. The addresses are deliberately nothing: what is being tested is
  // that the page notices they are not the ones it is reading.
  const said = await page.evaluate(async () => {
    const id = (await (await fetch(window.CurbApp.state.chainCfg.rpc, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    })).json()).result;
    window.CurbApp.CANONICAL[String(id).toLowerCase()] = {
      lens: "0x" + "11".repeat(20),
      factories: ["0x" + "22".repeat(20)],
    };
    await window.CurbApp.warnAboutWhere();
    const el = document.getElementById("linkWarn");
    return { hidden: el.hidden, text: el.textContent };
  });

  expect(said.hidden, "the page did not say it was pointed somewhere else").toBe(false);
  expect(said.text).toContain("NOT THE DEPLOYMENT THIS PRODUCT PUBLISHES");

  // AND IT GOES BACK TO SILENCE when the table has nothing for this chain,
  // which is the state every real page load is in today.
  const quiet = await page.evaluate(async () => {
    for (const k of Object.keys(window.CurbApp.CANONICAL)) delete window.CurbApp.CANONICAL[k];
    return window.CurbApp.canonicalComplaint("0x2105");
  });
  expect(quiet, "an empty table still produced a complaint").toBeNull();
});

test("a read that fails after the send says the transaction still succeeded", async () => {
  // A TRANSACTION THAT WAS MINED IS A FACT; the description of it is not. The
  // hook's settings are read AFTER the receipt, purely to report, and letting
  // that read throw put the page on the generic error path - where a person who
  // has just paid reads "something failed" and sends it again.
  await openApp(TRADER);
  const hook = await page.evaluate(() => window.CurbApp.state.ctx.hook);
  // BREAK A READ THAT ONLY HAPPENS AFTER THE RECEIPT.
  //
  // It used to be platformRecipient(), asked once and only in the report. The
  // page does not ask it any more - the recipient and the rate both come out of
  // the pool's own record now, in the same call the quote makes - so there is no
  // longer a read that is unique to the report BY SELECTOR. There is still one
  // unique by TIME: every quote happens before the transaction goes out, so a
  // read after it belongs to the report and nothing else.
  //
  // Breaking taxOfId from the first send onwards is therefore the same
  // guarantee this test always made, stated as WHEN rather than WHICH.
  const taxSel = await page.evaluate(() =>
    window.CurbKeccak.keccak256("0x" + window.CurbAbi.utf8Hex("taxOfId(bytes32)")).slice(0, 10));

  let sent = false;
  await page.route("**/*", async (route) => {
    const body = route.request().postData() || "";
    if (/eth_send(Raw)?Transaction/.test(body)) sent = true;
    if (sent && body.toLowerCase().includes(hook.slice(2).toLowerCase()) && body.includes(taxSel.slice(2))) {
      const req = JSON.parse(body);
      await route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "node said no" } }) });
      return;
    }
    await route.continue();
  });

  await page.selectOption("#poolSide", "buy");
  await page.fill("#poolAmount", "1");
  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(page.locator("#poolAct")).toBeEnabled();

  const before = await balanceOf(page, token, TRADER);
  await press(page, "poolAct", expect);

  // IT SAYS SO, and it gives the hash rather than leaving the reader guessing.
  await expect(page.locator("#msg")).toContainText("The transaction succeeded");
  await expect(page.locator("#msg")).toContainText("could not be read");
  await expect(page.locator("#msg")).toContainText("does not need to be sent again");
  await expect(page.locator("#msg")).toContainText(/0x[0-9a-f]{64}/);

  // AND THE TRANSACTION REALLY DID HAPPEN - otherwise this would be a page
  // saying "succeeded" about nothing.
  expect(await balanceOf(page, token, TRADER)).toBeGreaterThan(before);
  await page.unroute("**/*");
});

test("ETH buys the token, and the page separates the ETH from the gas", async () => {
  // THE ROUTE PROVED IN test/fork/B20EthRoute.t.sol, now driven from the page:
  // ETH -> WETH -> NVDAc on v3, then NVDAc -> token on our v4 pool, one call.
  await openApp(TRADER);
  await page.selectOption("#poolSide", "buy");
  await page.selectOption("#poolVia", "eth");
  await page.fill("#poolAmount", "0.002");
  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(page.locator("#poolQuote")).toContainText("held by the router between the two legs");
  await expect(page.locator("#poolAct")).toBeEnabled();

  const ethBefore = await ethBalance(page, TRADER);
  const tokenBefore = await balanceOf(page, token, TRADER);
  const nvdacBefore = await balanceOf(page, NVDAC, TRADER);

  await press(page, "poolAct", expect);

  const tokenAfter = await balanceOf(page, token, TRADER);
  expect(tokenAfter, "no tokens arrived from the ETH route").toBeGreaterThan(tokenBefore);

  const msg = await page.locator("#msg").textContent();
  expect(msg).toContain("ETH and this pool are two legs");
  expect(msg).toContain("which is the transaction's value and nothing else");
  expect(msg).toContain("fee ");

  // NOT ONE UNIT OF NVDAc MOVED IN OR OUT OF THE TRADER. That is the point of
  // the route: the middle belongs to the ROUTER for one transaction, and the
  // person never has to hold the quote asset or be handed any of it.
  //   This account happens to hold NVDAc - demo-app.sh funds it - so the check
  //   is that the balance is UNCHANGED, not that it is zero. Asserting zero was
  //   the first version and it was testing the fixture, not the route.
  expect(await balanceOf(page, NVDAC, TRADER), "the route touched the trader's NVDAc")
    .toBe(nvdacBefore);

  // AND THE ETH ADDS UP: value + gas, with nothing unexplained between them.
  const ethAfter = await ethBalance(page, TRADER);
  const exact = {};
  for (const m of msg.matchAll(/(gross|platform|creator|net|credited|paid|feeL2|feeL1|feeKnown)\s+(\d+|unknown)/g)) {
    exact[m[1]] = m[2] === "unknown" ? null : BigInt(m[2]);
  }
  // THE ETH ROUTE'S LAST LEG IS A BUY - NVDAc into the pool - so the tax came
  // off the NVDAc the v3 leg produced, and the memecoin that arrived is the
  // pool's whole output. net === gross is the shape of that, and the two legs
  // are in NVDAc beside it.
  expect(exact.net, "the buy leg's output was taxed").toBe(exact.gross);
  expect(exact.platform, "the platform was charged nothing on the ETH route").toBeGreaterThan(0n);
  expect(exact.creator, "the creator was charged nothing on the ETH route").toBeGreaterThan(0n);

  // THE NUMBERS, NOT THE WORDS. What the page says was paid must be the value
  // that was actually sent, and what it says the fee was must be the fee the
  // RECEIPT says - computed here rather than taken on trust.
  const receipt = await receiptOf(page, await lastHash(page));
  const l2 = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
  const l1 = receipt.l1Fee == null ? 0n : BigInt(receipt.l1Fee);
  expect(exact.paid, "the page did not report the transaction's value as what was paid")
    .toBe(2000000000000000n);
  expect(exact.feeL2, "the reported L2 fee is not gasUsed x effectiveGasPrice").toBe(l2);
  if (receipt.l1Fee == null) {
    // AN ABSENT FIELD MUST READ "unknown", NOT ZERO. Printing 0 would be a
    // number nothing measured, and calling the L2 part "the total" would make
    // it look like the whole cost.
    expect(exact.feeL1, "a missing l1Fee was reported as a number").toBe(null);
    expect(msg).toContain("unknown rather than zero");
    expect(msg).not.toContain("the real cost is higher");
  } else {
    expect(exact.feeL1, "the reported L1 fee is not the receipt's l1Fee").toBe(BigInt(receipt.l1Fee));
  }
  expect(exact.feeKnown, "the known total is not the sum of the parts that are known").toBe(l2 + l1);

  // And the ETH that actually left is the value plus the fee that was charged.
  expect(ethBefore - ethAfter, "the ETH that left is not the value plus the fee charged")
    .toBe(exact.paid + l2 + l1);
  expect(msg).not.toContain("do not match what the pool actually paid out");
});

test("the token sells back to ETH, and the middle is the router's", async () => {
  // NOT FROM AN ANVIL ACCOUNT. Every one of anvil's default addresses has
  // codesize 23 on this fork - an EIP-7702 delegation designator, because those
  // well-known keys have been delegated on Base mainnet - and the code they
  // point at FORWARDS INCOMING ETH somewhere else. The route delivers correctly
  // and the balance never moves, which is what the first version of this test
  // measured and called a failure. The fork test never saw it: makeAddr gives a
  // fresh address with no code.
  const SELLER = "0x00000000000000000000000000000000000e7451";
  const code = await page.evaluate(async ({ rpc, a }) => (await (await fetch(rpc, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [a, "latest"] }),
  })).json()).result, { rpc: STATE.rpc, a: SELLER });
  expect(code, "the ETH seller must be an address with no code of its own").toBe("0x");

  const post = (method, params) => page.evaluate(async ({ rpc, m, p }) => (await (await fetch(rpc, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }),
  })).json()), { rpc: STATE.rpc, m: method, p: params });

  const held = await balanceOf(page, token, TRADER);
  expect(held, "nothing to sell").toBeGreaterThan(0n);
  const SELL = 100000n * 10n ** 18n;
  await post("anvil_impersonateAccount", [SELLER]);
  await post("anvil_setBalance", [SELLER, "0x" + (10n ** 18n).toString(16)]);
  const funding = await post("eth_sendTransaction", [{
    from: TRADER, to: token,
    data: "0xa9059cbb" + SELLER.slice(2).padStart(64, "0") + SELL.toString(16).padStart(64, "0"),
  }]);
  // AND WAIT FOR IT TO BE MINED. eth_sendTransaction returns on acceptance, not
  // on inclusion - the same race that made three other steps in this file
  // intermittent, and which this test walked straight into.
  await expect
    .poll(async () => (await post("eth_getTransactionReceipt", [funding.result])).result != null,
      { timeout: 20_000 })
    .toBe(true);
  expect(await balanceOf(page, token, SELLER), "the seller was not funded with tokens").toBe(SELL);

  await openApp(SELLER);
  const nvdacBefore = await balanceOf(page, NVDAC, SELLER);
  await page.selectOption("#poolSide", "sell");
  await page.selectOption("#poolVia", "eth");
  await page.fill("#poolAmount", "100000");
  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(page.locator("#poolQuote")).toContainText("on the ETH you receive, not on the NVDAc in the middle");
  await expect(page.locator("#poolAct")).toBeEnabled();

  // AN UNRELATED ETH TRANSFER, LANDING INSIDE THE PAGE'S OWN WINDOW.
  //
  // The page reads a balance just before it sends and again after the receipt.
  // Anything that arrives between those two reads is in the difference - and a
  // page that calls that difference "what you received" would report somebody
  // else's transfer as sale proceeds. That is the mistake this file already
  // made once on the token side.
  //
  // Timing it by hand would be a race, so the page's own SWAP TRANSACTION is
  // held on its way out, the transfer is sent while it waits, and then it is
  // released. The transfer therefore lands AFTER the page has read its opening
  // balance and BEFORE the receipt, which is the window - holding the balance
  // READ instead puts the transfer before it, where it cancels out, and that is
  // what the first version of this did.
  const INTERLOPER = 10n ** 16n;              // 0.01 ETH from an unrelated account
  let armed = true;
  let landed = false;
  await page.route("**/*", async (route) => {
    const body = route.request().postData() || "";
    // THE SWAP ITSELF, not the approvals before it. "contains the router's
    // address" is true of the Permit2 approval too - the router is its SPENDER
    // - and firing there put the transfer before the page had read its opening
    // balance, where it cancels out. The destination is what distinguishes them.
    const isSwapSend = body.includes("eth_sendTransaction")
      && body.toLowerCase().includes('"to":"0x6ff5693b99212da76ad316178a184ab56d299b43"');
    if (armed && isSwapSend) {
      armed = false;
      const r = await fetch(STATE.rpc, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "eth_sendTransaction",
          params: [{ from: "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc", to: SELLER,
                     value: "0x" + INTERLOPER.toString(16) }] }),
      });
      landed = !(await r.json()).error;
    }
    await route.continue();
  });

  await press(page, "poolAct", expect);
  await page.unroute("**/*");
  expect(armed, "the page's swap transaction was never seen, so nothing was held").toBe(false);
  expect(landed, "the interloping transfer was refused").toBe(true);

  const msg = await page.locator("#msg").textContent();
  expect(msg).toContain("this transaction unwrapped");
  // THE EVENT NAMES NO RECIPIENT, and the page must not pretend it does.
  expect(msg).toContain("addressed to you by the route it was sent with");
  expect(msg).toContain("your balance moved by");
  expect(msg).toContain("went to the router, not to you");

  // THE NUMBERS, AGAINST THE RECEIPT. What the page calls the ETH this
  // transaction paid out must be the WETH it unwrapped, and the fee must be the
  // receipt's - both computed here rather than believed.
  const receipt = await receiptOf(page, await lastHash(page));
  const l2 = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
  const l1 = receipt.l1Fee == null ? 0n : BigInt(receipt.l1Fee);
  const WITHDRAWAL = "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65";
  const unwrapped = receipt.logs
    .filter((l) => l.address.toLowerCase() === "0x4200000000000000000000000000000000000006"
      && l.topics[0] === WITHDRAWAL)
    .reduce((a, l) => a + BigInt(l.data), 0n);
  expect(unwrapped, "the transaction unwrapped no WETH").toBeGreaterThan(0n);

  const exact = {};
  for (const m of msg.matchAll(/(unwrapped|feeL2|feeL1|feeKnown|balanceMoved)\s+(-?\d+|unknown)/g)) {
    exact[m[1]] = m[2] === "unknown" ? null : BigInt(m[2]);
  }
  expect(exact.unwrapped, "the reported ETH output is not what this transaction unwrapped").toBe(unwrapped);
  expect(exact.feeL2, "the reported L2 fee is not the receipt's").toBe(l2);
  expect(exact.feeL1, "a missing l1Fee must read unknown, not a number")
    .toBe(receipt.l1Fee == null ? null : BigInt(receipt.l1Fee));

  // AND THE TWO FIGURES CAME FROM DIFFERENT PLACES. The balance the page
  // reports moved by the trade PLUS the interloper minus the fee; the output it
  // reports is the trade alone. If the output had been derived from the
  // balance, these would differ by nothing and the first assertion would fail.
  // THE TRANSACTION'S OWN ETH DELTA, from the two blocks around it. anvil mines
  // one transaction per block, so this isolates THIS transaction in a way a
  // wall-clock window never can - which makes it the right thing to check the
  // page against, even though the page cannot use it on a chain where a block
  // holds many transactions.
  const blk = BigInt(receipt.blockNumber);
  const at = (n) => page.evaluate(async ({ rpc, addr, b }) => (await (await fetch(rpc, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [addr, b] }),
  })).json()).result, { rpc: STATE.rpc, addr: SELLER, b: "0x" + n.toString(16) });
  const inTx = BigInt(await at(blk)) - BigInt(await at(blk - 1n));
  expect(inTx, "this transaction's own ETH delta is not the unwrapped amount less the fee")
    .toBe(unwrapped - l2 - l1);

  expect(exact.balanceMoved, "the balance figure does not carry the interloping transfer")
    .toBe(unwrapped - l2 - l1 + INTERLOPER);
  expect(exact.unwrapped, "the interloping transfer was counted as sale proceeds")
    .toBe(unwrapped);
  expect(exact.balanceMoved - exact.unwrapped + l2 + l1,
    "the gap between the two is not the interloping transfer").toBe(INTERLOPER);

  // THE v4 LEG PAID THE ROUTER, and the page's payment matching has to expect
  // that rather than looking for a credit to the trader. If it looked in the
  // wrong place this line would be the failure.
  expect(msg).not.toContain("do not match what the pool actually paid out");

  expect(await balanceOf(page, NVDAC, SELLER), "NVDAc reached the trader on a route to ETH")
    .toBe(nvdacBefore);
  expect(await balanceOf(page, token, SELLER)).toBe(0n);
});

test("the NVDAc path still works alongside the ETH one", async () => {
  // THE OLD WAY MUST NOT HAVE BEEN TRADED AWAY FOR THE NEW ONE.
  await openApp(TRADER);
  await page.selectOption("#poolSide", "buy");
  await page.selectOption("#poolVia", "nvdac");
  await page.fill("#poolAmount", "1");
  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(page.locator("#poolQuote")).not.toContainText("held by the router");
  await expect(page.locator("#poolAct")).toBeEnabled();

  const before = await balanceOf(page, token, TRADER);
  await press(page, "poolAct", expect);
  expect(await balanceOf(page, token, TRADER)).toBeGreaterThan(before);
  // A BUY'S OUTPUT IS UNTOUCHED NOW, so the message says "delivered … the whole
  // output" rather than "produced … after". The wording changed with the side
  // the tax is charged on.
  await expect(page.locator("#msg")).toContainText("the v4 leg delivered");
  await expect(page.locator("#msg")).toContainText("that reached the pool");
});

test("clearing the amount disables the button, and no stale amount survives", async () => {
  // THE BUG THIS IS FOR: the quote was stashed on the button and the action read
  // it back, so typing 10, clearing the field, and pressing the button spent ten
  // NVDAc the user had just deleted.
  await page.selectOption("#poolSide", "buy");
  await page.fill("#poolAmount", "1");
  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(page.locator("#poolAct")).toBeEnabled();

  await page.fill("#poolAmount", "");
  await expect(page.locator("#poolQuote")).toContainText("Enter an amount");
  await expect(page.locator("#poolAct")).toBeDisabled();

  // And nothing can be sent while it is in that state.
  const before = await balanceOf(page, NVDAC, TRADER);
  await page.evaluate(async () => {
    try { await window.CurbApp.poolAction(); } catch {}
  });
  expect((await balanceOf(page, NVDAC, TRADER)).toString()).toBe(before.toString());

  await page.fill("#poolAmount", "0");
  await expect(page.locator("#poolAct")).toBeDisabled();
});

test("a wallet on another chain than the RPC cannot send", async () => {
  // Reads come from the RPC box and sends go through the wallet. A page that
  // never compares them quotes a price on one chain and sends on another.
  await openApp(TRADER);
  await page.evaluate(() => { window.ethereum.cfg.chainId = "0x1"; });

  const before = await balanceOf(page, NVDAC, TRADER);
  await page.fill("#poolAmount", "1");
  await page.evaluate(async () => { try { await window.CurbApp.poolAction(); } catch (e) { window.__err = e.message; } });
  const err = await page.evaluate(() => window.__err || document.getElementById("msg").textContent);
  expect(err).toMatch(/chain 1 .*chain 8453|8453.*chain 1/);
  expect((await balanceOf(page, NVDAC, TRADER)).toString()).toBe(before.toString());
});

test("the last buy is previewed the way the contract prices it", async () => {
  // THE BUG THIS IS FOR: the preview clamped the token output to what was left
  // on the curve but went on charging the fees against the WHOLE amount
  // offered. The contract prices that fill from the token side, grosses it back
  // up, spends only that, and refunds the difference - so offered, spent,
  // refunded and charged are four different numbers on this one trade.
  //
  // A fresh launch, because the one above has already graduated.
  await openApp(OWNER);
  await page.fill("#nName", "Clamp Case");
  await page.fill("#nSymbol", "CLMP");
  await press(page, "create", expect);
  const clampToken = await page.evaluate(() => window.CurbApp.state.chainCfg.token);
  expect(clampToken).toMatch(/^0x[0-9a-f]{40}$/);

  token = clampToken;
  await openApp(TRADER);

  // Most of the way to the threshold, then an offer far bigger than what is
  // left - which is the only way to reach the clamped branch.
  await page.selectOption("#curveSide", "buy");
  await page.fill("#curveAmount", "40");
  await page.evaluate(() => window.CurbApp.refresh(true));
  await press(page, "curveAct", expect);

  await page.fill("#curveAmount", "40");
  await page.evaluate(() => window.CurbApp.refresh(true));

  const preview = await page.evaluate(async () => {
    const v = await window.CurbApp.computeCurveQuote();
    return {
      error: v.error || null,
      offered: v.error ? null : v.q.offered.toString(),
      spent: v.error ? null : v.q.spent.toString(),
      refund: v.error ? null : v.q.refund.toString(),
      out: v.error ? null : v.q.out.toString(),
      clamped: v.error ? null : v.q.clamped,
    };
  });
  expect(preview.error).toBeNull();
  expect(preview.clamped, "this trade was supposed to hit the clamp").toBe(true);
  expect(BigInt(preview.refund), "a clamped buy must refund something").toBeGreaterThan(0n);
  // The screen has to show the difference, not just know it.
  await expect(page.locator("#curveQuote")).toContainText("refunded to you");
  await expect(page.locator("#curveQuote")).toContainText("actually spent");

  // AND THE SCREEN'S COST IS ON WHAT WAS SPENT, NOT ON WHAT WAS OFFERED.
  //
  // The refund never left the buyer, so charging it would report a loss nobody
  // took. Both the reserves and the amounts come from the chain: the reserves
  // straight off the CURVE before the trade, the amounts from the balances
  // afterwards. Nothing here asks the app what it believes.
  const refsC = await chainRefs(page, clampToken);
  const preReserves = await curveReserves(page, refsC.curve);
  const shownCurve = await screenCostBps(page, "curveQuote");
  expect(shownCurve, "the curve preview showed no percentage").not.toBeNull();
  await expect(page.locator("#curveQuote")).toContainText("this launch's tax");

  const tokensBefore = await balanceOf(page, clampToken, TRADER);
  const quoteBefore = await balanceOf(page, NVDAC, TRADER);
  await press(page, "curveAct", expect);
  const tokensAfter = await balanceOf(page, clampToken, TRADER);
  const quoteAfter = await balanceOf(page, NVDAC, TRADER);

  // AGAINST THE CHAIN, all three at once: what arrived, what was actually
  // taken, and that the rest came back.
  expect((tokensAfter - tokensBefore).toString()).toBe(preview.out);
  expect((quoteBefore - quoteAfter).toString()).toBe(preview.spent);
  expect(BigInt(preview.offered) - BigInt(preview.spent)).toBe(BigInt(preview.refund));

  // THE COST THE SCREEN SHOWED, against what the trade really did.
  const reallySpent = quoteBefore - quoteAfter;
  const reallyGot = tokensAfter - tokensBefore;
  const onSpent = bpsOf((reallySpent * preReserves.token) / preReserves.quote, reallyGot);
  const onOffered = bpsOf((BigInt(preview.offered) * preReserves.token) / preReserves.quote, reallyGot);
  expect(onOffered - onSpent,
    "this trade does not separate the two definitions, so it cannot tell them apart")
    .toBeGreaterThan(100);
  expect(Math.abs(shownCurve - onSpent),
    "the curve's cost line was not measured on what was spent: screen " + shownCurve +
    ", on-spent " + onSpent + ", on-offered " + onOffered)
    .toBeLessThanOrEqual(2);
});

test("the curve's SELL cost line matches the sale that happens", async () => {
  // ITS OWN LAUNCH, BECAUSE THE CLAMPED BUY ABOVE GRADUATED ITS ONE. A
  // graduated launch has no curve panel at all, so a sell has to be set up on a
  // curve that is still live.
  const wasToken = token;
  await openApp(OWNER);
  await page.fill("#nName", "Sell Case");
  await page.fill("#nSymbol", "SELL");
  await press(page, "create", expect);
  const sellToken = await page.evaluate(() => window.CurbApp.state.chainCfg.token);
  expect(sellToken).toMatch(/^0x[0-9a-f]{40}$/);
  token = sellToken;
  await openApp(TRADER);

  // Enough to hold tokens, nowhere near the threshold.
  await page.selectOption("#curveSide", "buy");
  await page.fill("#curveAmount", "5");
  await page.evaluate(() => window.CurbApp.refresh(true));
  await press(page, "curveAct", expect);

  await page.selectOption("#curveSide", "sell");
  await page.fill("#curveAmount", "1000000");
  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(page.locator("#curveAct")).toBeEnabled();

  const refsS = await chainRefs(page, sellToken);
  const pre = await curveReserves(page, refsS.curve);
  const shown = await screenCostBps(page, "curveQuote");
  expect(shown, "the curve sell preview showed no percentage").not.toBeNull();

  const tokBefore = await balanceOf(page, sellToken, TRADER);
  const qBefore = await balanceOf(page, NVDAC, TRADER);
  await press(page, "curveAct", expect);
  const sold = tokBefore - (await balanceOf(page, sellToken, TRADER));
  const received = (await balanceOf(page, NVDAC, TRADER)) - qBefore;
  expect(sold, "nothing was sold").toBeGreaterThan(0n);

  // At the curve's own mid, before the sale: NVDAc = tokens * quote / token.
  const truth = bpsOf((sold * pre.quote) / pre.token, received);
  expect(Math.abs(shown - truth),
    "the curve sell's cost line said " + shown + " bps, the sale cost " + truth)
    .toBeLessThanOrEqual(2);
  expect(shown, "the sell cost came out under this launch's tax")
    .toBeGreaterThanOrEqual(refsS.totalTaxBps - 2);

  // Hand the suite back the launch it was working on.
  token = wasToken;
});

test("two real app tabs produce ONE transaction", async ({ context }) => {
  // THE EIGHTEEN SCENARIOS ON THE OTHER PAGE PROVE NOTHING ABOUT THIS ONE.
  // tx-core.js having a lock in it is not app.html using it; `busy` only ever
  // guarded a single page. Two pages of one context share an origin, its
  // storage and its Web Locks - which is what two tabs are.
  const open = async () => {
    const p = await context.newPage();
    const bootstrap = [
      STUB,
      ";(function () {",
      "  var cfg = " + JSON.stringify({ rpc: STATE.rpc, account: TRADER }) + ";",
      // Slow enough that both tabs are inside the send at once.
      "  window.ethereum = window.makeWallet(cfg.rpc, { forward: true, chainId: '0x2105', account: cfg.account, sendDelayMs: 900 });",
      "})();",
    ].join("\n");
    await p.addInitScript({ content: bootstrap });
    const q = new URLSearchParams({ rpc: STATE.rpc, factory: APP.factory, lens: APP.lens, token });
    await p.goto("/app.html?" + q.toString());
    await p.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
    await p.evaluate(() => window.CurbApp.connect());
    return p;
  };

  // A launch that is still on its curve, so both tabs have something to send.
  await openApp(OWNER);
  await page.fill("#nName", "Two Tabs");
  await page.fill("#nSymbol", "TABS");
  await press(page, "create", expect);
  token = await page.evaluate(() => window.CurbApp.state.chainCfg.token);

  const a = await open();
  const b = await open();
  for (const p of [a, b]) {
    await p.selectOption("#curveSide", "buy");
    await p.fill("#curveAmount", "3");
    await p.evaluate(() => window.CurbApp.refresh(true));
    await expect(p.locator("#curveAct")).toBeEnabled();
  }

  // The allowance first, from one tab, so the race below is about the BUY and
  // not about which tab approves.
  await press(a, "curveAct", expect);
  await b.evaluate(() => window.CurbApp.refresh(true));

  // Both at once. One of them must be refused.
  const spentBefore = await balanceOf(a, NVDAC, TRADER);
  await Promise.all([a.click("#curveAct"), b.click("#curveAct")]);
  await a.waitForTimeout(5000);
  const spentAfter = await balanceOf(a, NVDAC, TRADER);

  // THE MEASURE IS THE CHAIN, not the stubs: each tab has its own wallet stub,
  // so counting sends there would count two things that never both happened.
  // Exactly one buy of 3 NVDAc left the account.
  expect((spentBefore - spentAfter).toString()).toBe((3n * 10n ** 8n).toString());

  const both = (await a.locator("#msg").textContent()) + " | " + (await b.locator("#msg").textContent());
  expect(both).toMatch(/Another tab is already|already a transaction for this/);

  await a.close();
  await b.close();
});

test("a launch created and then reloaded is picked back up", async () => {
  // THE RECORD THAT MATTERED MOST WAS THE ONE NOT KEPT. resumePending() used to
  // return early unless a token was selected - and the create transaction is
  // the one that PRODUCES the token, so it was invisible on the next load.
  //
  // Two halves, because the fork mines instantly and a page that waits for its
  // own receipt clears the record before any reload could see it:
  //   1. the record is written, and carries what a recovery needs
  //   2. that same record, put back as if the tab had died before the receipt,
  //      is recovered on the next load
  await openApp(OWNER);
  await page.fill("#nName", "Reload Case");
  await page.fill("#nSymbol", "RLD");

  // Not awaited: catch the record while the transaction is still in flight.
  const recordSeen = page.waitForFunction(
    () => {
      const r = window.CurbTx.loadPendingAll().filter((t) => t.page === "app" && t.kind === "create");
      return r.length ? JSON.stringify(r[0]) : null;
    },
    null,
    { timeout: 30_000 }
  );
  await page.click("#create");
  const record = JSON.parse(await (await recordSeen).jsonValue());

  expect(record.factory.toLowerCase(), "the record must name the factory").toBe(APP.factory.toLowerCase());
  expect(record.from.toLowerCase()).toBe(OWNER.toLowerCase());
  expect(record.rpc, "the record must name the endpoint it was sent through").toBe(STATE.rpc);
  expect(record.hash).toMatch(/^0x[0-9a-f]{64}$/);

  await expect(page.locator("#msg")).toContainText("Launched", { timeout: 30_000 });
  const created = await page.evaluate(() => window.CurbApp.state.chainCfg.token);

  // Now put it back on a page that has NEVER had this token, and load again.
  //
  // A FRESH PAGE, not a goto on the one that just created it. The first version
  // reloaded in place and passed with the mutation applied - so it was passing
  // for some reason other than the one it names, and a test that cannot tell
  // the fix from its absence is not evidence of anything. This is the shape a
  // standalone probe showed to be discriminating.
  token = null;                 // so openApp puts no token in the URL
  await openApp(OWNER);
  const planted = await page.evaluate(
    ({ rec, store }) => {
      localStorage.setItem("curb.launch.pending.v3:" + rec.chainId + ":" + rec.hash, JSON.stringify(rec));
      const addrs = JSON.parse(localStorage.getItem(store) || "{}");
      addrs.token = "";
      localStorage.setItem(store, JSON.stringify(addrs));
      return { token: JSON.parse(localStorage.getItem(store)).token,
               records: window.CurbTx.loadPendingAll().filter((t) => t.kind === "create").length };
    },
    { rec: record, store: APP_ADDR_STORE }
  );
  // THE SETUP HAS TO BE THE SETUP, asserted rather than assumed.
  expect(planted.token, "nothing may remember the token for this to mean anything").toBe("");
  expect(planted.records, "the record to recover must be there").toBe(1);

  await page.reload();
  await page.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
  await page.evaluate(() => window.CurbApp.connect());

  // Recovered WITHOUT a token anywhere: the record carried the factory, so the
  // page could read the receipt and take the address out of its event.
  await expect(page.locator("#msg")).toContainText("created in a previous visit", { timeout: 30_000 });
  await expect(page.locator("#msg")).toContainText(created);
  expect(await page.evaluate(() => window.CurbApp.state.chainCfg.token)).toBe(created);
  token = created;
});

/// Click, wait for the transaction to leave the wallet, and hand back what was
/// sent - whether or not the chain then accepts it.
///
/// WHY NOT press(). press() waits for the action to finish and fails when the
/// page reports a revert, so a mutation that builds the WRONG CALLDATA shows up
/// as "reverted on chain" and the assertion that would have named the cause
/// never runs. What was dispatched is the evidence here.
/// THE ADVANCED SECTION, OPENED THE WAY A CREATOR OPENS IT.
///
/// The creator wallet sits behind a disclosure, so page.fill() on it waits
/// forever while it is shut. (The creator tax used to as well; it has its own
/// card now, and the callers that open this first still work.) Clicked rather
/// than forced open with .open = true: a summary that had stopped responding
/// to clicks would be a real failure, and this is the only place that would
/// still catch it.
async function openAdvanced(p) {
  const box = p.locator("#advanced");
  if (!(await box.evaluate((d) => d.open))) await box.locator("summary").click();
  await expect(p.locator("#nCreator")).toBeVisible();
  await expect(p.locator("#nTax")).toBeVisible();
}

async function dispatch(p, id) {
  const before = await p.evaluate(() => window.ethereum.sent.length);
  await p.click("#" + id);
  await p.waitForFunction((n) => window.ethereum.sent.length > n, before, { timeout: 40_000 });
  return p.evaluate(() => window.ethereum.sent[window.ethereum.sent.length - 1]);
}

/// A launch still on its curve, created if this test is running on its own.
/// Tests that depend on a previous test's leftovers fail differently depending
/// on how they are selected, which is its own kind of unreliable.
async function ensureSellingLaunch(name, symbol) {
  if (token) {
    await openApp(TRADER);
    const status = await page.locator("#status").textContent();
    if (status === "Selling") return;
  }
  await openApp(OWNER);
  await page.fill("#nName", name);
  await page.fill("#nSymbol", symbol);
  await press(page, "create", expect);
  token = await page.evaluate(() => window.CurbApp.state.chainCfg.token);
  await openApp(TRADER);
}

test("a curve trade reports what the curve recorded, not a balance difference", async () => {
  // Same class of mistake, same fix: the numbers come from CurveBuy/CurveSell
  // in this transaction's receipt. A balance read either side of the send is a
  // measurement of the account over a period, not of the trade.
  await ensureSellingLaunch("Receipt Read", "RCPT");
  await page.selectOption("#curveSide", "buy");
  await page.fill("#curveAmount", "3");
  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(page.locator("#curveAct")).toBeEnabled();

  const tokenBefore = await balanceOf(page, token, TRADER);
  await press(page, "curveAct", expect);
  const tokenAfter = await balanceOf(page, token, TRADER);

  const msg = await page.locator("#msg").textContent();
  const exact = {};
  for (const m of msg.matchAll(/(in|out|fee|tax)\s+(\d+)/g)) exact[m[1]] = BigInt(m[2]);
  expect(exact.in, "no exact input in the message").toBeDefined();
  expect(exact.out, "no exact output in the message").toBeDefined();

  // 3 NVDAc in, and the two legs are THIS LAUNCH'S rates OF THE INPUT on a buy
  // - the direction that decides which side they come off. The rates are read
  // off the curve rather than written here: the creator picks the tax now, so
  // a constant in the test would be asserting against a number the contract
  // never promised.
  const rates = await curveFees(page, await page.evaluate(() => window.CurbApp.state.view.curve));
  const fee = BigInt(rates.fee), tax = BigInt(rates.tax);
  expect(exact.in).toBe(300000000n);
  expect(exact.fee).toBe((300000000n * fee) / 10000n);
  expect(exact.tax).toBe((300000000n * tax) / 10000n);

  // AND THE POLICY ITSELF, on the numbers this trade actually produced: the
  // platform's leg is a flat 50 bps of the base whatever the creator chose,
  // and the two legs together are the one tax the launch advertises.
  expect(fee, "the platform's leg is not the fixed 50 bps").toBe(50n);
  expect(exact.fee).toBe((300000000n * 50n) / 10000n);
  const recorded = await page.evaluate(async ({ rpc, registry, token }) => {
    const k = window.CurbKeccak.keccak256, h = window.CurbAbi.utf8Hex;
    const sel = (sig) => k("0x" + h(sig)).slice(0, 10);
    const res = await fetch(rpc, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [
        { to: registry, data: sel("launchOf(address)") + token.replace(/^0x/, "").padStart(64, "0") }, "latest"] }),
    });
    // totalTaxBps is the ninth word of the Launch struct.
    const words = (await res.json()).result.replace(/^0x/, "").match(/.{64}/g);
    return BigInt("0x" + words[8]).toString();
  }, { rpc: STATE.rpc, registry: await page.evaluate(() => window.CurbApp.state.ctx.registry), token });
  expect(fee + tax, "the curve's two legs do not add up to the recorded tax").toBe(BigInt(recorded));
  expect(tokenAfter - tokenBefore, "the event and the balance disagree").toBe(exact.out);
  expect(msg).toContain("both on the NVDAc side");
});

test("an action keeps reading the endpoint it started on", async () => {
  // WHAT THIS IS AND IS NOT. It does not test a chain: both endpoints below are
  // the same node behind an interceptor. What it tests is ROUTING - which URL
  // each call was sent to - by giving the page two endpoint names and recording
  // where every request went. A second node that answered differently would
  // test more; this tests the thing the fix is about.
  //
  // The first attempt at this asserted "no buy happened" and passed with the
  // pin removed, which is why it was thrown away rather than kept.
  await ensureSellingLaunch("Pinned Reads", "PIN");

  // EVERY CALL, WITH ENOUGH OF IT TO TELL THEM APART. "A was used at all" is
  // satisfied by any read; the question is where the read that JUDGES THE
  // RESULT went, so the target and the calldata are recorded too.
  const calls = [];
  const real = STATE.rpc;
  await page.route("**/endpoint-*", async (route) => {
    const url = route.request().url();
    const body = route.request().postData();
    try {
      const req = JSON.parse(body);
      const p0 = (req.params && req.params[0]) || {};
      calls.push({ at: url.endsWith("A") ? "A" : "B", method: req.method, to: (p0.to || "").toLowerCase(), data: p0.data || "" });
    } catch { calls.push({ at: url.endsWith("A") ? "A" : "B", method: "?", to: "", data: "" }); }
    // Forwarded to the node, so the page gets real answers either way.
    const res = await fetch(real, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    await route.fulfill({ status: 200, contentType: "application/json", body: await res.text() });
  });

  const A = new URL("/endpoint-A", page.url()).toString();
  const B = new URL("/endpoint-B", page.url()).toString();

  // Point the page at A and let it settle there.
  await page.evaluate((a) => {
    const el = document.getElementById("rpc");
    el.value = a;
    el.dispatchEvent(new Event("change"));
  }, A);
  await expect(page.locator("#status")).toHaveText("Selling", { timeout: 20_000 });

  await page.selectOption("#curveSide", "buy");
  await page.fill("#curveAmount", "2");
  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(page.locator("#curveAct")).toBeEnabled();

  // ONE SEND, so the action is not stopped by its own "the endpoint changed"
  // guard before it gets to the reads this is about. The allowance is set
  // generously on the node first, so ensureAllowance has nothing to do.
  await page.evaluate(async ({ rpc, curve, trader }) => {
    const k = window.CurbKeccak.keccak256, h = window.CurbAbi.utf8Hex;
    const sel = k("0x" + h("approve(address,uint256)")).slice(0, 10);
    const pad = (v) => v.toLowerCase().replace(/^0x/, "").padStart(64, "0");
    await fetch(rpc, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendTransaction", params: [{
        from: trader, to: "0xb20000000000000000000078ee7ce2fe4908108c",
        data: sel + pad(curve) + "f".repeat(64),
      }] }),
    });
  }, { rpc: STATE.rpc, trader: TRADER, curve: await page.evaluate(() => window.CurbApp.state.view.curve) });

  await page.evaluate(() => { window.ethereum.cfg.sendDelayMs = 1500; });
  await page.click("#curveAct");

  // WAIT FOR THE WALLET TO ACTUALLY BE ASKED, rather than for a number of
  // milliseconds. A fixed sleep makes this a coin flip on a slow machine: too
  // early and the form moves before the action has pinned anything, too late
  // and the send is already done.
  await page.waitForFunction(() => window.ethereum.inflight > 0, null, { timeout: 20_000 });

  // COUNTED FROM HERE. Reads before the form moved would go to A either way and
  // would make this pass without proving anything.
  calls.length = 0;
  await page.evaluate((b) => {
    const el = document.getElementById("rpc");
    el.value = b;
    el.dispatchEvent(new Event("change"));
  }, B);

  await page.waitForTimeout(5000);

  // B is hit by the RENDERING, because what is on screen follows the form -
  // that is not the question. THE QUESTION IS ONE SPECIFIC CALL: the balanceOf
  // that decides what the trade delivered.
  const balanceSel = await page.evaluate(() =>
    window.CurbKeccak.keccak256("0x" + window.CurbAbi.utf8Hex("balanceOf(address)")).slice(0, 10));
  const traderWord = TRADER.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  // THE EXACT CALL: balanceOf(trader) ON THE TOKEN THIS BUY DELIVERS. Without
  // the target in the filter this also matched the NVDAc balance the header
  // shows, which is a different read with different reasons to move.
  const judging = calls.filter(
    (c) => c.method === "eth_call" &&
      c.to === token.toLowerCase() &&
      c.data === balanceSel + traderWord);

  expect(judging.length, "no balance read happened after the form moved").toBeGreaterThan(0);
  // NOT "all of them". The rendering reads the same balances and correctly
  // follows the form to B - that is what the form is for. The point is that
  // ONCE THE FORM HAS MOVED, nothing in the rendering can reach A any more, so
  // an A here can only be the action reading through its pin.
  expect(judging.some((c) => c.at === "A"),
    "every balance read after the form moved went to the new endpoint: " +
    JSON.stringify(judging.map((c) => c.at))).toBe(true);
  await expect(page.locator("#msg")).toContainText("The curve gave you");
  await page.unroute("**/endpoint-*");
  await page.evaluate((r) => {
    const el = document.getElementById("rpc");
    el.value = r;
    el.dispatchEvent(new Event("change"));
  }, STATE.rpc);
});

test("a hash the browser would not store is still on screen at the end", async () => {
  // The warning used to be written and then overwritten by the next line - and
  // the next line is always "waiting for it to be mined", so the one message
  // that had to survive never did.
  await ensureSellingLaunch("Storage Case", "STOR");
  await page.evaluate(() => {
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (String(k).indexOf("curb.launch.pending.v3:") === 0) throw new Error("QuotaExceededError");
      return real.call(this, k, v);
    };
  });

  await page.selectOption("#curveSide", "buy");
  await page.fill("#curveAmount", "2");
  await page.evaluate(() => window.CurbApp.refresh(true));
  await press(page, "curveAct", expect);

  const msg = await page.locator("#msg").textContent();
  expect(msg).toMatch(/would not store/);
  expect(msg).toMatch(/LOST if you reload/);
  expect(msg, "the hash has to still be readable").toMatch(/0x[0-9a-f]{64}/);
});

test("a create whose address cannot be stored keeps its record", async () => {
  // ORDER. The record is the only way back to a token address until that
  // address is somewhere a reload can find it, so it may not be cleared when
  // the receipt lands - it is cleared once the result is KEPT. Here the browser
  // refuses to keep it.
  token = null;
  await openApp(OWNER);
  await page.evaluate((store) => {
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (String(k) === store) throw new Error("QuotaExceededError");
      return real.call(this, k, v);
    };
  }, APP_ADDR_STORE);

  // THE SETUP, ASSERTED. A stub that is not actually refusing makes this test
  // agree with anything.
  const refuses = await page.evaluate((store) => {
    try { localStorage.setItem(store, "x"); return false; } catch { return true; }
  }, APP_ADDR_STORE);
  expect(refuses, "the storage stub is not refusing").toBe(true);

  await page.fill("#nName", "Unstorable");
  await page.fill("#nSymbol", "UNS");
  await press(page, "create", expect);

  await expect(page.locator("#msg")).toContainText("did not keep the address");
  const left = await page.evaluate(() =>
    window.CurbTx.loadPendingAll().filter((t) => t.page === "app" && t.kind === "create"));
  expect(left.length, "the record was cleared before the address was kept anywhere").toBe(1);

  // Tidy up so the next test does not inherit an outstanding record.
  await page.evaluate(() => {
    window.CurbTx.loadPendingAll().forEach((t) => window.CurbTx.clearPending(t));
  });
});

/// A LINK IS TAKEN AS THE PERSON MEANT IT, AND STILL CHECKED. "curb.fun" in the
/// website field was refused with a sentence about schemes - the first
/// real-wallet run met exactly that. A domain without its scheme becomes
/// https://, a handle its profile link; anything that names another scheme is
/// left as typed and refused, before anything is sent.
test("a link typed without its scheme is stored as https, a handle as its profile, and another scheme is refused as typed", async () => {
  await openApp(OWNER);
  const n = await page.evaluate(() => {
    const f = window.CurbApp.normalizeLink;
    return {
      bare: f("website", "curb.fun"),
      www: f("website", " www.curb.fun/about "),
      xHandle: f("x", "@curbfun"),
      tgHandle: f("telegram", "@curbfun"),
      tgPath: f("telegram", "t.me/curbfun"),
      siteHandle: f("website", "@curbfun"),
      js: f("website", "javascript:alert(1)"),
      proto: f("website", "//evil.example"),
      host: f("website", "localhost:8080"),
      word: f("website", "curb"),
      kept: f("website", "ipfs://bafy"),
    };
  });
  expect(n.bare).toBe("https://curb.fun");
  expect(n.www).toBe("https://www.curb.fun/about");
  expect(n.xHandle).toBe("https://x.com/curbfun");
  expect(n.tgHandle).toBe("https://t.me/curbfun");
  expect(n.tgPath).toBe("https://t.me/curbfun");
  expect(n.siteHandle, "a handle means nothing as a website").toBe("@curbfun");
  expect(n.js, "a scheme was rewritten instead of judged as typed").toBe("javascript:alert(1)");
  expect(n.proto).toBe("//evil.example");
  expect(n.host).toBe("localhost:8080");
  expect(n.word).toBe("curb");
  expect(n.kept).toBe("ipfs://bafy");

  // THE FIELD SHOWS WHAT WILL BE STORED as soon as it is left.
  await page.fill("#nSite", "curb.fun");
  await page.dispatchEvent("#nSite", "change");
  await expect(page.locator("#nSite")).toHaveValue("https://curb.fun");
  await page.fill("#nX", "@curbfun");
  await page.dispatchEvent("#nX", "change");
  await expect(page.locator("#nX")).toHaveValue("https://x.com/curbfun");

  // ANOTHER SCHEME IS REFUSED AS TYPED, before anything is sent.
  await page.fill("#nName", "Link Case");
  await page.fill("#nSymbol", "LINK");
  await page.fill("#nSite", "javascript:alert(1)");
  await page.dispatchEvent("#nSite", "change");
  await expect(page.locator("#nSite"), "a refused link was rewritten in the field").toHaveValue("javascript:alert(1)");
  const sentBefore = await page.evaluate(() => window.ethereum.sent.length);
  await page.click("#create");
  await expect(page.locator("#msg")).toContainText("is not a link this page will store", { timeout: 30_000 });
  expect(await page.evaluate(() => window.ethereum.sent.length), "something was sent with a refused link")
    .toBe(sentBefore);
});

test("a create is reported in ITS OWN context when the form has moved on", async () => {
  // The result used to be written into whatever the page was pointed at by the
  // time it arrived, and the event was looked for using the form's factory
  // rather than the one the transaction was sent to.
  token = null;
  await openApp(OWNER);
  await page.fill("#nName", "Moved On");
  await page.fill("#nSymbol", "MOV");

  await page.evaluate(() => { window.ethereum.cfg.sendDelayMs = 1200; });
  await page.click("#create");
  // WHILE THE WALLET IS OPEN, not after a guessed 250 ms. The page does several
  // reads before it asks the wallet, and on a busy endpoint they took longer
  // than the guess - the factory then changed BEFORE the send, the page rightly
  // refused, and the test failed on timing rather than on the behaviour.
  await page.waitForFunction(() => window.ethereum.inflight > 0, null, { timeout: 20_000 });

  // The user points the page at another deployment while the wallet is open.
  const otherFactory = "0x" + "ab".repeat(20);
  await page.evaluate((f) => {
    const el = document.getElementById("factory");
    el.value = f;
    el.dispatchEvent(new Event("change"));
  }, otherFactory);

  // IT HAS TO STILL BE THERE AT THE END. An earlier version of this test
  // accepted the result having existed FOR A MOMENT, recorded by a
  // MutationObserver - which is exactly the failure it was meant to catch, since
  // a user reads the screen and not a history of it.
  // Either wording is fine - the live report or the recovery that follows it,
  // since the record is deliberately kept when the address could not be stored.
  // What may NOT happen is the context being lost on the way.
  await expect(page.locator("#msg")).toContainText(/Launched|previous visit/, { timeout: 30_000 });
  await expect(page.locator("#msg")).toContainText("different deployment");
  // NAMED BY THE CONTEXT IT WAS MADE IN, and still showing what a user would
  // need to copy: the address and the transaction.
  await expect(page.locator("#msg")).toContainText(APP.factory);
  // THE ADDRESS FROM THE EVENT, not "some 40-hex string" - the factory's own
  // address is on screen too and satisfies a regex like that happily.
  const createdToken = await page.evaluate(
    async ({ rpc, factory, topic }) => {
      const recs = window.CurbTx.loadPendingAll().filter((t) => t.kind === "create");
      const hash = recs.length ? recs[0].hash : window.__lastCreateHash;
      const res = await fetch(rpc, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [hash] }),
      });
      const receipt = (await res.json()).result;
      const log = (receipt.logs || []).find(
        (l) => l.address.toLowerCase() === factory.toLowerCase() && l.topics[0] === topic);
      return { token: "0x" + log.topics[1].slice(26), hash };
    },
    { rpc: STATE.rpc, factory: APP.factory, topic: await page.evaluate(() =>
        window.CurbKeccak.keccak256("0x" + window.CurbAbi.utf8Hex("LaunchCreated(address,address,address,uint256,uint16)"))) }
  );

  // AFTER the reading complaint has appeared, so this is about what SURVIVES it.
  await expect(page.locator("#readmsg")).toContainText(/returned nothing|not the contract/, { timeout: 30_000 });

  const result = await page.locator("#msg").textContent();
  expect(result.toLowerCase(), "the created token address must still be on screen")
    .toContain(createdToken.token.toLowerCase());
  expect(result.toLowerCase(), "the transaction hash must still be on screen")
    .toContain(createdToken.hash.toLowerCase());

  // And the form was left alone rather than quietly filled in.
  expect(await page.evaluate(() => document.getElementById("factory").value)).toBe(otherFactory);
  expect(await page.evaluate(() => document.getElementById("token").value)).toBe("");

  // The rendering's complaint lives in its OWN area - readable, and no longer
  // able to overwrite the result above.

  await page.evaluate(() => {
    window.CurbTx.loadPendingAll().forEach((t) => window.CurbTx.clearPending(t));
  });
});

test("a poisoned cache cannot reach the launch calldata at all", async () => {
  // THIS TEST USED TO PROVE A WEAKER THING, and the change is worth stating.
  //
  // The calldata used to carry the hook and a whole fee policy, and `ctx` - a
  // cache the rendering fills from whatever the form last showed - was where
  // they came from. So the test poisoned the cache and checked that the PINNED
  // factory's values went out instead. That was the right test for a launch()
  // that took those fields.
  //
  // launch() takes six fields now: three strings, a salt, the refund address
  // and the tax. The hook, the supply, the curve's shape, the lock, the pool
  // and the entire fee policy are the factory's own immutables. So the check
  // gets stronger and simpler: poison the cache with a whole second
  // deployment's values and NONE of them can appear, because there is no field
  // for them to appear in.
  expect(OTHER.factory.toLowerCase(), "the two deployments must differ for this to mean anything")
    .not.toBe(APP.factory.toLowerCase());

  token = null;
  await openApp(OWNER);

  const truth = await page.evaluate(
    async ({ rpc, factory, otherFactory }) => {
      const k = window.CurbKeccak.keccak256, h = window.CurbAbi.utf8Hex;
      const sel = (sig) => k("0x" + h(sig)).slice(0, 10);
      const call = async (to, data) => {
        const res = await fetch(rpc, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
        });
        return (await res.json()).result;
      };
      const addr = (raw) => "0x" + raw.slice(26);
      const hookOf = async (f) => addr(await call(addr(await call(f, sel("registry()"))), sel("requiredHook()")));
      return { hook: await hookOf(factory), otherHook: await hookOf(otherFactory) };
    },
    { rpc: STATE.rpc, factory: APP.factory, otherFactory: OTHER.factory }
  );
  expect(truth.hook.toLowerCase(), "the two deployments must have different hooks")
    .not.toBe(truth.otherHook.toLowerCase());

  const bogus = "0x" + "cd".repeat(20);
  await page.evaluate(({ hook, other }) => {
    window.CurbApp.state.ctx.hook = hook;
    window.CurbApp.state.ctx.bogus = other;
  }, { hook: truth.otherHook, other: bogus });

  await page.fill("#nName", "Pinned Config");
  await page.fill("#nSymbol", "PCFG");
  await openAdvanced(page);
  await page.fill("#nTax", "3");
  const tx = await dispatch(page, "create");

  const data = tx.data.toLowerCase();
  const word = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

  expect(data, "the other deployment's hook ended up in the calldata").not.toContain(word(truth.otherHook));
  expect(data, "a hook address is in the calldata at all - launch() has no hook field")
    .not.toContain(word(truth.hook));
  expect(data, "a poisoned address reached the calldata").not.toContain(word(bogus));

  // WHAT IS IN THERE: the sender, as the refund address, and the tax. Nothing
  // else addressable.
  expect(data, "the caller's own refund address is missing").toContain(word(OWNER));
  expect(data, "the tax is not in the calldata").toContain((300).toString(16).padStart(64, "0"));

  // NOTHING IS ASSERTED ABOUT A RECEIPT HERE, deliberately. dispatch() reads
  // what the wallet was ASKED to send; this test is about the calldata that was
  // built, and a mined receipt is a different claim tested elsewhere.
});

test("graduate() goes to the graduator the pinned factory names", async () => {
  // WHAT THIS ESTABLISHES, AND WHAT IT CANNOT.
  //
  // It asserts the target: the transaction goes to the Graduator this
  // deployment names, which is a different address from the other
  // deployment's, so a page sending to a hardcoded or wrong one would fail
  // here. It is read from the FACTORY now, not the lens: the lens is a link
  // parameter, and a lens of somebody else's could name any contract.
  //
  // IT DOES NOT DISCRIMINATE THE PIN. Reading the graduator from the pinned
  // lens rather than from the value the rendering caches at load is a real
  // difference, and it CANNOT be reached: the only way the cached value differs
  // from the pinned one is a lens on screen that is not the one the cache was
  // filled from - and beginAction reads the launch through that same lens
  // first, finds status NotFound, and refuses before any send. Another guard
  // already closes the path. Attempts at it are in the history of this file: a
  // delay on registry() that factoryContext had cached, and a delay on
  // graduator() that closed the window it was meant to open.
  //
  // So the fix stands on reading, not on a failing test, and this says so
  // rather than looking like coverage it is not.
  expect(OTHER.graduator.toLowerCase(), "the two graduators must differ for the target to mean anything")
    .not.toBe(APP.graduator.toLowerCase());

  token = null;
  await openApp(OWNER);
  await page.fill("#nName", "Graduator Target");
  await page.fill("#nSymbol", "GTGT");
  await press(page, "create", expect);
  token = await page.evaluate(() => window.CurbApp.state.chainCfg.token);
  // press() returns when the button is enabled again, which happens BEFORE the
  // refresh that follows it finishes - so `view` can still be null here.
  await page.evaluate(() => window.CurbApp.refresh(true));
  const curve = await page.evaluate(() => window.CurbApp.state.view.curve);

  await openApp(TRADER);
  await page.selectOption("#curveSide", "buy");
  await page.fill("#curveAmount", "45");
  await page.evaluate(() => window.CurbApp.refresh(true));
  await press(page, "curveAct", expect);

  const crossing = await page.evaluate(
    async ({ curve, rpc, trader, nvdac }) => {
      const k = window.CurbKeccak.keccak256, h = window.CurbAbi.utf8Hex;
      const sel = (sig) => k("0x" + h(sig)).slice(0, 10);
      const pad = (v) => v.toLowerCase().replace(/^0x/, "").padStart(64, "0");
      const post = (method, params) => fetch(rpc, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }).then((r) => r.json());
      await post("eth_sendTransaction", [{ from: trader, to: nvdac,
        data: sel("approve(address,uint256)") + pad(curve) + "f".repeat(64) }]);
      const reserveBefore = await post("eth_call", [{ to: curve, data: sel("realQuoteReserve()") }, "latest"])
        .then((r) => r.result);
      const sent = await post("eth_sendTransaction", [{ from: trader, to: curve, gas: "0xdbba0",
        data: sel("buy(uint256,uint256,address)") + (20n * 10n ** 8n).toString(16).padStart(64, "0") +
              "0".repeat(64) + pad(trader) }]);
      // SENDING IS ALL THAT HAPPENS HERE. Reading the curve now would read it at
      // "latest", which is whatever block exists at this instant - possibly
      // before this transaction is in one. The state is read by the test, AT
      // THE RECEIPT'S BLOCK, once there is a receipt.
      return { error: sent.error ? JSON.stringify(sent.error) : null, hash: sent.result, reserveBefore };
    },
    { curve, rpc: STATE.rpc, trader: TRADER, nvdac: NVDAC }
  );
  await page.evaluate(() => window.CurbApp.refresh(true));

  // WHY, NOT JUST WHAT. 900000 is a hand-tuned limit: enough for the buy, not
  // enough for the graduation the curve then attempts. This step failed
  // intermittently for a while, and the assertion said only "expected Waiting,
  // received Selling", which says nothing about the cause - so the receipt, the
  // gas it used and the curve's own view come with it now.
  //   EVERY EXPLANATION OFFERED FOR THOSE FAILURES WAS WRONG, and the readings
  //   they rested on were taken in the wrong order: the state was fetched at
  //   "latest" while the transaction might not be in a block yet, then reported
  //   beside a receipt fetched afterwards. Since the order was corrected - and
  //   since the sends started waiting to be mined - it has not failed again.
  //   That is the whole of what is known: recent runs pass, and the earlier
  //   diagnoses were unsound. Nothing here claims a remaining fault.
  // SEND -> RECEIPT -> STATE AT THAT RECEIPT'S BLOCK -> render. Anything else
  // reports a before and an after as if they were one moment, which is how "a
  // successful buy added nothing to the reserve" came to be written down as a
  // finding when nothing of the sort had been measured.
  const crossReceipt = await mustBeMined(page, crossing.hash, "the crossing buy on a tight gas limit");
  crossing.status = crossReceipt.status;
  crossing.gasUsed = parseInt(crossReceipt.gasUsed, 16);
  Object.assign(crossing, await curveStateAt(page, curve, crossReceipt.blockNumber));
  await page.evaluate(() => window.CurbApp.refresh(true));
  const num = (w) => (w ? BigInt(w).toString() : "?");
  const why =
    `crossing buy: error ${crossing.error}, status ${crossing.status}, ` +
    `gasUsed ${crossing.gasUsed} of 900000; reserve ${num(crossing.reserveBefore)} before it, and ` +
    `${num(crossing.reserve)} of ${num(crossing.threshold)} IN ITS OWN BLOCK ${crossing.atBlock}, ` +
    `ready ${num(crossing.ready)}, graduated ${num(crossing.graduated)}`;
  // THE STEP'S OWN RESULT FIRST. A buy that reverted and a page that rendered
  // the wrong word looked identical here, and they are not the same failure.
  expect(num(crossing.ready), `the curve is not ready after the crossing buy — ${why}`).toBe("1");
  expect(num(crossing.graduated), `the curve graduated instead of waiting — ${why}`).toBe("0");
  await expect(page.locator("#status"), why).toHaveText("Waiting");

  // THE LENS NOW NAMES THE OTHER DEPLOYMENT'S GRADUATOR. The send must still
  // go to this factory's: the lens is a link parameter, and before this round
  // the page took the graduator from it.
  const lensBody = APP.lens.toLowerCase().slice(2);
  const gradSel = (await selOf(page, "graduator()")).slice(2);
  await page.route("**/*", async (route) => {
    const body = (route.request().postData() || "").toLowerCase();
    if (body.includes(lensBody) && body.includes('"data":"0x' + gradSel + '"')) {
      const msg = JSON.parse(route.request().postData());
      return route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: "0x" + padA(OTHER.graduator) }) });
    }
    return route.continue();
  });
  const tx = await dispatch(page, "complete");
  await page.unroute("**/*");
  expect(tx.to.toLowerCase(), "graduate() went somewhere other than this deployment's Graduator")
    .toBe(APP.graduator.toLowerCase());
  expect(tx.to.toLowerCase()).not.toBe(OTHER.graduator.toLowerCase());

  await expect(page.locator("#msg")).toContainText("graduated", { timeout: 40_000 });
  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(page.locator("#status")).toHaveText("Graduated");
});

test("a late graduator reply is not filed under the lens now on screen", async () => {
  // THE PATH I WRONGLY CALLED UNREACHABLE.
  //
  // readGraduator sends its question to the lens in the form and used to record
  // the cache key AFTER the await - the form's value when the ANSWER arrived.
  // Move the lens to B and back to A while B's reply is in flight and B's
  // Graduator is stored as A's, with the key saying A so every later refresh
  // short circuits and keeps it. NotFound does not save anything here: the
  // token really is registered in A.
  expect(OTHER.lens.toLowerCase(), "the two lenses must differ")
    .not.toBe(APP.lens.toLowerCase());
  expect(OTHER.graduator.toLowerCase()).not.toBe(APP.graduator.toLowerCase());

  // A launch of THIS deployment's, taken to Waiting.
  token = null;
  await openApp(OWNER);
  await page.fill("#nName", "Late Reply");
  await page.fill("#nSymbol", "LATE");
  await press(page, "create", expect);
  token = await page.evaluate(() => window.CurbApp.state.chainCfg.token);
  // press() returns when the button is enabled again, which happens BEFORE the
  // refresh that follows it finishes - so `view` can still be null here.
  await page.evaluate(() => window.CurbApp.refresh(true));
  const curve = await page.evaluate(() => window.CurbApp.state.view.curve);

  await openApp(TRADER);
  await page.selectOption("#curveSide", "buy");
  await page.fill("#curveAmount", "45");
  await page.evaluate(() => window.CurbApp.refresh(true));
  await press(page, "curveAct", expect);
  const crossing = await page.evaluate(
    async ({ curve, rpc, trader, nvdac }) => {
      const k = window.CurbKeccak.keccak256, h = window.CurbAbi.utf8Hex;
      const sel = (sig) => k("0x" + h(sig)).slice(0, 10);
      const pad = (v) => v.toLowerCase().replace(/^0x/, "").padStart(64, "0");
      const post = (method, params) => fetch(rpc, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }).then((r) => r.json());
      await post("eth_sendTransaction", [{ from: trader, to: nvdac,
        data: sel("approve(address,uint256)") + pad(curve) + "f".repeat(64) }]);
      const sent = await post("eth_sendTransaction", [{ from: trader, to: curve, gas: "0xdbba0",
        data: sel("buy(uint256,uint256,address)") + (20n * 10n ** 8n).toString(16).padStart(64, "0") +
              "0".repeat(64) + pad(trader) }]);
      return { error: sent.error ? JSON.stringify(sent.error) : null, hash: sent.result };
    },
    { curve, rpc: STATE.rpc, trader: TRADER, nvdac: NVDAC }
  );
  await mustBeMined(page, crossing.hash, "the crossing buy on a tight gas limit");
  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(page.locator("#status")).toHaveText("Waiting");

  // Hold up the reply to the question asked OF LENS B, and only that one.
  const graduatorSel = await page.evaluate(() =>
    window.CurbKeccak.keccak256("0x" + window.CurbAbi.utf8Hex("graduator()")).slice(0, 10));
  const otherLensWord = OTHER.lens.toLowerCase().replace(/^0x/, "");
  const held = [];
  await page.route("**/*", async (route) => {
    const body = route.request().postData() || "";
    if (body.includes(graduatorSel.slice(2)) && body.toLowerCase().includes(otherLensWord)) {
      held.push(route);                   // parked; released below
      return;
    }
    await route.continue();
  });

  // SWITCH TO B, AND KEEP THE PROMISE OF A READ THAT STARTS WHILE IT IS B.
  //
  // This is the read the test has to wait for, and waiting for anything else
  // does not stand in for it. An earlier version awaited a NEW refresh started
  // after the reply was released, on the argument that its round trip must
  // outlast the continuation - an argument about scheduling, not a guarantee.
  // Another network call finishing says nothing about whether this one's
  // continuation has run.
  //
  // The change handler starts a refresh and throws the promise away, so a
  // second one is started in the same turn, while the lens is B. Its
  // readGraduator asks lens B, blocks on the parked reply, and cannot resolve
  // before the continuation that would file the answer has run.
  //
  // ONE PARKED QUESTION, NOT TWO. The change handler's refresh is superseded
  // in the same turn, and since the sequence guard (R04/R50) a superseded
  // refresh stops at its first await - before readGraduator. So the question
  // parked is THIS refresh's, whose promise is the one held.
  await page.evaluate((l) => {
    const el = document.getElementById("lens");
    el.value = l;
    el.dispatchEvent(new Event("change"));
    window.__bRead = window.CurbApp.refresh(true).catch((e) => String(e));
  }, OTHER.lens);
  await expect.poll(() => held.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(1);

  // Back to A while B's replies are still parked - and wait for THAT read too,
  // rather than sleeping. It short-circuits, because the cache key still says
  // A, so it resolves as soon as the page has taken the change in.
  await page.evaluate((l) => {
    const el = document.getElementById("lens");
    el.value = l;
    el.dispatchEvent(new Event("change"));
    window.__aRead = window.CurbApp.refresh(true).catch((e) => String(e));
  }, APP.lens);
  await page.evaluate(() => window.__aRead);

  // Now let B's answers arrive, into a page that is looking at A, and wait for
  // THE READ ITSELF to finish.
  for (const r of held) await r.continue();
  await page.evaluate(() => window.__bRead);
  await page.unroute("**/*");

  // WHAT THE PAGE REMEMBERS IS EXACTLY A's - asserted positively, not merely as
  // "not B's", which an unprocessed answer would also satisfy.
  const remembered = await page.evaluate(() => window.CurbApp.state.graduatorAddr);
  expect(remembered.toLowerCase(), "the page is not holding this lens's Graduator")
    .toBe(APP.graduator.toLowerCase());

  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(page.locator("#status")).toHaveText("Waiting");
  const tx = await dispatch(page, "complete");
  expect(tx.to.toLowerCase(), "completion went to the other deployment's Graduator")
    .toBe(APP.graduator.toLowerCase());
});

test("a declined send says nothing was sent; any other failure says it is not certain", async () => {
  // These are two DIFFERENT statements and the page used to make one. A
  // rejection is the only failure after the wallet has been asked that means
  // nothing went out; everything else may have been broadcast, and telling a
  // user it simply failed invites them to pay for it twice.
  await ensureSellingLaunch("Error Shapes", "ERRS");
  await page.selectOption("#curveSide", "buy");
  await page.fill("#curveAmount", "2");
  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(page.locator("#curveAct")).toBeEnabled();

  // 1. the user declines
  await page.evaluate(() => {
    const err = new Error("User rejected the request.");
    err.code = 4001;
    window.ethereum.cfg.sendError = err;
  });
  await page.click("#curveAct");
  await expect(page.locator("#msg")).toContainText("Nothing was sent", { timeout: 30_000 });
  await expect(page.locator("#msg")).toContainText("declined");
  await expect(page.locator("#msg")).not.toContainText("NOT CERTAIN");

  // 2. anything else
  await page.evaluate(() => {
    window.ethereum.cfg.sendError = new Error("provider exploded");
  });
  await page.evaluate(() => window.CurbApp.refresh(true));
  await page.click("#curveAct");
  await expect(page.locator("#msg")).toContainText("NOT CERTAIN NOTHING WAS BROADCAST", { timeout: 30_000 });
  await expect(page.locator("#msg")).toContainText("provider exploded");
  await expect(page.locator("#msg")).not.toContainText("Nothing was sent");

  await page.evaluate(() => { window.ethereum.cfg.sendError = null; });
});

test("an error that merely READS like a refusal is not called a refusal", async () => {
  // 4001 is the only thing that says a user declined. A provider failing for
  // its own reasons can wrap a message that says "user rejected" while the
  // transaction went out anyway, and treating the text as proof is how someone
  // is invited to pay for the same thing twice.
  await ensureSellingLaunch("Text Not Code", "TXTC");
  await page.selectOption("#curveSide", "buy");
  await page.fill("#curveAmount", "2");
  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(page.locator("#curveAct")).toBeEnabled();

  await page.evaluate(() => {
    // The words, deliberately, and NO code.
    window.ethereum.cfg.sendError = new Error("relay said: user rejected the request upstream");
  });
  await page.click("#curveAct");

  await expect(page.locator("#msg")).toContainText("NOT CERTAIN NOTHING WAS BROADCAST", { timeout: 30_000 });
  await expect(page.locator("#msg")).not.toContainText("you declined");
  await page.evaluate(() => { window.ethereum.cfg.sendError = null; });
});

test("a second endpoint's answer is used, not the first one's", async () => {
  // THE KEY'S SHAPE IS NOT THE POINT - the behaviour is. An earlier version of
  // this test went to a dead port and back, where every other read fails too
  // and the old value looks right again on return, and then asserted on the
  // shape of the cache key. That catches the mutation and proves nothing about
  // which answer is used.
  //
  // Here TWO endpoints answer the SAME lens address with DIFFERENT Graduators,
  // both through the interceptor - no second node needed. Switching from one to
  // the other must change what the page holds.
  await ensureSellingLaunch("Endpoint Answer", "EANS");

  const real = STATE.rpc;
  const fabricated = "0x" + "5e".repeat(20);
  const graduatorSel = await page.evaluate(() =>
    window.CurbKeccak.keccak256("0x" + window.CurbAbi.utf8Hex("graduator()")).slice(0, 10));

  await page.unroute("**/answer-*").catch(() => {});
  // A REPLY THAT ARRIVES AFTER THE TEST HAS MOVED ON IS NOT AN ERROR. The page
  // can still have a request in flight when the interception is removed, and
  // fulfilling one then throws "Route is already handled" - which failed a run
  // for a reason that has nothing to do with what this test asserts. The
  // assertions all happen before the unroute; a late fulfill has no reader.
  const answer = async (route, payload) => {
    try {
      await route.fulfill(payload);
    } catch (e) {
      if (!/already handled/i.test(e.message || "")) throw e;
    }
  };
  await page.route("**/answer-*", async (route) => {
    const url = route.request().url();
    const body = route.request().postData() || "";
    const isGraduatorCall = body.includes(graduatorSel.slice(2));

    // Only the SECOND endpoint lies, and only about this one call: everything
    // else is forwarded so the page still works through either of them.
    if (url.endsWith("two") && isGraduatorCall) {
      const req = JSON.parse(body);
      await answer(route, {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id: req.id,
          result: "0x" + fabricated.slice(2).padStart(64, "0") }),
      });
      return;
    }
    const res = await fetch(real, {
      method: "POST", headers: { "content-type": "application/json" }, body,
    });
    await answer(route, { status: 200, contentType: "application/json", body: await res.text() });
  });

  const one = new URL("/answer-one", page.url()).toString();
  const two = new URL("/answer-two", page.url()).toString();
  const setRpc = (u) => page.evaluate((v) => {
    const el = document.getElementById("rpc");
    el.value = v;
    el.dispatchEvent(new Event("change"));
  }, u);

  await setRpc(one);
  await expect
    .poll(async () => (await page.evaluate(() => window.CurbApp.state.graduatorAddr) || "").toLowerCase(),
      { timeout: 20_000 })
    .toBe(APP.graduator.toLowerCase());

  // Same lens address, a different endpoint. Keyed on the address alone the
  // cache hits and the first endpoint's answer survives.
  await setRpc(two);
  await expect
    .poll(async () => (await page.evaluate(() => window.CurbApp.state.graduatorAddr) || "").toLowerCase(),
      { timeout: 20_000 })
    .toBe(fabricated.toLowerCase());

  // And back: the first endpoint's answer is read again rather than the
  // second's being kept.
  await setRpc(one);
  await expect
    .poll(async () => (await page.evaluate(() => window.CurbApp.state.graduatorAddr) || "").toLowerCase(),
      { timeout: 20_000 })
    .toBe(APP.graduator.toLowerCase());

  await page.unroute("**/answer-*");
  await setRpc(STATE.rpc);
  await expect(page.locator("#status")).toHaveText(/Selling|Waiting|Graduated/, { timeout: 20_000 });
});

// LAST IN THE FILE ON PURPOSE. It trades, and every chain above it depends on
// the curve state the test before it left.
test("the receipt names the asset the chain reported, not a hardcoded one", async () => {
  // WHAT THIS CATCHES THAT NOTHING ELSE HERE CAN. Every stack this suite
  // builds is quoted in NVDAc, so a page that PRINTS "NVDAc" and a page that
  // READS the symbol produce identical text and every other assertion in this
  // file passes either way. It stayed that way while both receipts, the
  // allowance prompt and the tax breakdown named NVDAc outright - right here,
  // wrong for anyone trading SPCXc or GOOGLc, which this deployment enables.
  //
  // SO THE CHAIN IS MADE TO SAY SOMETHING ELSE. symbol() - 0x95d89b41 - is the
  // only call a ticker is read from, and only ever for the quote asset
  // [app.js:308, :610, :666], so this changes exactly one thing. The route
  // goes on AFTER openApp because beginAction() re-pins on every action, which
  // is what puts the symbol into the receipt.
  await openApp(TRADER);
  const FAKE = "0x" + (32).toString(16).padStart(64, "0")
                    + (4).toString(16).padStart(64, "0")
                    + Buffer.from("ZQXc", "utf8").toString("hex").padEnd(64, "0");
  await page.route("**/*", async (route) => {
    const req = route.request();
    if (req.method() !== "POST") return route.continue();
    const body = req.postData() || "";
    if (body.includes("95d89b41")) {
      return route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(body).id, result: FAKE }),
      });
    }
    return route.continue();
  });

  await page.fill("#curveAmount", "1");
  await page.selectOption("#curveSide", "buy");
  await page.evaluate(() => window.CurbApp.refresh(true));
  await press(page, "curveAct", expect);

  const msg = await page.locator("#msg").textContent();
  expect(msg, "the receipt did not report a completed trade").toContain("The curve gave you");
  // BOTH DIRECTIONS. Containing the read symbol is not enough on its own: a
  // page printing both would pass that half and still be telling somebody
  // their fee was charged in an asset they never touched.
  expect(msg, "the receipt does not name the symbol the chain reported").toContain("ZQXc");
  expect(msg, "the receipt still says NVDAc, which this chain did not report")
    .not.toContain("NVDAc");
  await page.unroute("**/*");
});

// THE FIX FOR THE ONE FINDING IN AUDIT.txt THAT REACHED USERS. The test above
// proves the symbol is READ; this proves a hostile one is REFUSED, which is a
// different property and the one the fix exists for.
test("a symbol that is markup is not shown as a symbol, and does not execute", async () => {
  // THE DELIVERY IS A LINK. app.html takes its factory and lens off the query
  // string, so somebody else's contract decides what symbol() answers, and the
  // answer reaches innerHTML in fifteen places. The payload here is the
  // ordinary one: an <img> whose onerror fires without any script tag, which
  // survives naive filters that only look for "<script".
  const PAYLOAD = '<img src=x onerror=alert(1)>';
  const hex = Buffer.from(PAYLOAD, "utf8").toString("hex");
  const encoded = "0x" + (32).toString(16).padStart(64, "0")
                       + PAYLOAD.length.toString(16).padStart(64, "0")
                       + hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");

  await openApp(TRADER);
  // A dialog is what an executed payload looks like from out here. Playwright
  // leaves dialogs unhandled by default, which BLOCKS the page - so it is
  // caught, recorded and dismissed, and the assertion is on the record.
  const dialogs = [];
  page.on("dialog", async (d) => { dialogs.push(d.message()); await d.dismiss(); });

  await page.route("**/*", async (route) => {
    const req = route.request();
    if (req.method() !== "POST") return route.continue();
    const body = req.postData() || "";
    if (body.includes("95d89b41")) {
      return route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(body).id, result: encoded }),
      });
    }
    return route.continue();
  });

  // Reload so the page builds its whole context against the hostile answer,
  // rather than only the parts read after this point.
  await page.reload();
  await page.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
  await page.evaluate(() => window.CurbApp.connect());
  await page.fill("#curveAmount", "1");
  await page.selectOption("#curveSide", "buy");
  await page.evaluate(() => window.CurbApp.refresh(true));

  // NOTHING RAN.
  expect(dialogs, `the payload executed: ${dialogs.join(" | ")}`).toHaveLength(0);
  // AND NOTHING WAS INJECTED - an <img> from the payload would be in the DOM
  // whether or not its onerror fired.
  expect(await page.locator('img[src="x"]').count(),
    "the payload was parsed as HTML and put an element in the page").toBe(0);

  // AND IT IS NOT SHOWN AS A TICKER EITHER. The fallback is the truncated
  // address, which is what this page already shows for an asset that will not
  // answer at all.
  const quote = await page.evaluate(() => window.CurbApp.state.ctx.quote);
  // BOTH ENDS. Every B20 address begins 0xb2 and ten zero bytes, so the
  // first six characters cannot tell one equity from another.
  await expect(page.locator("#quoteSymA"))
    .toHaveText(quote.slice(0, 6) + "…" + quote.slice(-4));
  await page.unroute("**/*");
  page.removeAllListeners("dialog");

  // AND LEAVE THE PAGE AS IT WAS FOUND. Removing the route is not enough:
  // the page caches its factory context, so the poisoned symbol outlives
  // the route that produced it and every later test in this serial suite
  // reads it. That cost several runs chasing a fallback this test caused.
  await page.reload();
  await page.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
});

// LAST ON PURPOSE. This suite is serial and this test switches the
// selected quote factory. Placed mid-file, a restoration that failed
// would break every test after it and the failure would name the wrong
// one. At the end it can only break itself.
test("a quote asset too thin to fill a launch says so, and a deep one does not", async () => {
  // Some listed assets cannot be bought one graduation threshold at a time
  // through Uniswap v3 (or, for nine assets, Aerodrome). That is a fact about the
  // pools rather than about this code, so the page reads it at render time -
  // and this checks both answers, because a warning that is always on screen
  // is not a warning.
  const note = page.locator("#quoteLiquidity");
  const pick = page.locator("#quotePick");

  // ---- 1. THE DEEP ONE IS QUIET. NVDAc's pool holds more than twice a
  // threshold, so the line states the two numbers and carries no warning.
  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(note).toBeVisible();
  // NOT ASSERTED ON THE SYMBOL. The page falls back to a truncated address
  // when it cannot validate one, and it does here - which is a fixture
  // difference rather than the subject of this test. What matters is the
  // comparison the line makes, so that is what is checked.
  await expect(note).toContainText("to graduate");

  // WHY IT FELL BACK, reported rather than shrugged at. A transient RPC
  // failure and an asset answering with rubbish look identical on screen and
  // want opposite fixes, so the page records which it was.
  // NO SYMBOL FELL BACK, asserted rather than logged. The page records why it
  // ever shows a truncated address instead of a ticker, and by this point in
  // the run that record has to be empty: the one test that deliberately makes
  // a symbol unreadable cleans up after itself now. It did not before, and
  // every test after it read the poisoned context - which is what sent me
  // looking for a product bug that was not there.
  const trouble = await page.evaluate(() => window.CurbApp.state.symbolTrouble);
  expect(trouble, "a quote asset's symbol fell back to its address: " + JSON.stringify(trouble))
    .toEqual({});
  await expect(page.locator("#quoteLiquidity.unbounded")).toHaveCount(0);

  // ---- 2. THE THIN ONE SAYS SO.
  // FOUND BY THE ASSET'S ADDRESS, NOT BY ITS LABEL. The picker labels options
  // with symbolOf(), which falls back to a truncated address when it cannot
  // read one - and does exactly that in this fixture. Matching on the label
  // made this test depend on a fallback that has nothing to do with liquidity.
  const AAPLC = "0xb200000000000000000000C2e324d24d7eEcd1fb".toLowerCase();

  // WAIT FOR THE PICKER TO BE FILLED BEFORE READING IT.
  //
  // fillQuotePicker() runs at init (and on an address field's change) and asks every factory in the registry
  // what it prices against - fourteen of them since 2026-10-15, where it was
  // eight and then eleven. It is not
  // awaited by anything the test can see, so reading sel.options the moment
  // refresh() returns is a race, and it started losing when the list grew.
  // The failure reads "no option quotes AAPLc" and looks like a product bug.
  await expect
    .poll(async () => page.evaluate(() => {
      const sel = document.getElementById("quotePick");
      return sel ? Array.from(sel.options).filter((o) => o.value).length : 0;
    }), { message: "the quote picker never filled", timeout: 20_000 })
    .toBeGreaterThan(1);

  const found = await page.evaluate(async (arg) => {
    // DEFENSIVE AND SELF-REPORTING. A throw inside evaluate() surfaces as a
    // stack with no page state in it, which cost two runs to not learn
    // anything from. Everything that could be missing is reported instead.
    const aaplc = arg && arg.aaplc;
    const rpc = arg && arg.rpc;
    const sel = document.getElementById("quotePick");
    if (!sel) return { ok: false, why: "no #quotePick on the page" };
    if (!aaplc || !rpc) return { ok: false, why: "the test passed aaplc=" + aaplc + " rpc=" + rpc };
    const opts = Array.from(sel.options || []);
    const labels = opts.map((o) => o.textContent);
    for (const o of opts) {
      if (!o || !o.value) continue;
      const r = await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call",
          params: [{ to: o.value, data: "0x217a4b70" }, "latest"] }),
      });
      const j = await r.json();
      const quote = "0x" + String(j.result || "").slice(-40);
      if (quote.toLowerCase() === aaplc) {
        sel.value = o.value;
        sel.dispatchEvent(new Event("change"));
        return { ok: true, labels };
      }
    }
    return { ok: false, labels, why: "no option's factory quotes AAPLc" };
  }, { aaplc: AAPLC, rpc: STATE.rpc });
  expect(found.ok,
    "the thin case is untested: " + (found.why || "?") +
    ". The picker offered: " + JSON.stringify(found.labels || null)).toBe(true);

  // WITH AERODROME, AAPLc IS NOT THIN: its pools there can buy one threshold,
  // and the line says where the price came from.
  await expect(note).toContainText("(on Aerodrome)", { timeout: 20000 });
  await expect(page.locator("#quoteLiquidity.unbounded")).toHaveCount(0);

  // AERODROME SILENT WHILE UNISWAP REFUSES IS NOT THIN EITHER: Uniswap's
  // refusal is its pools speaking, Aerodrome's quoter not answering in time is
  // nobody speaking - and its pools are the ones that can fill this.
  const silentAero = await page.evaluate(async () => {
    const sel = window.CurbKeccak
      .keccak256("0x" + window.CurbAbi.utf8Hex("quoteExactOutput(bytes,uint256)"))
      .slice(0, 10);
    const quoter = "0x514c8b5f54112481e28028f1166bd78501089259";
    const real = window.fetch;
    window.fetch = (url, init) => {
      let body = {};
      try { body = JSON.parse((init && init.body) || "{}"); } catch (e) { /* not ours */ }
      const p = body.params && body.params[0];
      if (!p || String(p.to || "").toLowerCase() !== quoter || typeof p.data !== "string" || !p.data.startsWith(sel)) {
        return real(url, init);
      }
      return new Promise((_, reject) => {
        if (init && init.signal) init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    };
    try {
      await window.CurbApp.refresh(true);
      return document.getElementById("quoteLiquidity").textContent;
    } finally {
      window.fetch = real;
    }
  });
  expect(silentAero, "Aerodrome not answering was reported as a thin route").not.toContain("THIN ETH ROUTE");
  expect(silentAero).toContain("could not be read");

  // THE THIN HALF, WITH AERODROME'S QUOTER GONE: its code hash then mismatches
  // for a fresh read, and an answer it cannot give is no price.
  const AERO_QUOTER = "0x514c8b5f54112481e28028f1166bd78501089259";
  const node = async (method, params) => {
    const r = await fetch(STATE.rpc, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = await r.json();
    if (j.error) throw new Error(method + ": " + JSON.stringify(j.error));
    return j.result;
  };
  const quoterCode = await node("eth_getCode", [AERO_QUOTER, "latest"]);
  await node("anvil_setCode", [AERO_QUOTER, "0x"]);
  try {
    await page.evaluate(() => window.CurbApp.refresh(true));
    await expect(page.locator("#quoteLiquidity.unbounded")).toHaveCount(1, { timeout: 20000 });
    // THE ROUTE, NOT THE MARKET: with Aerodrome's quoter gone the check asks
    // Uniswap v3 alone, where this asset is thin (app.js quoteLiquidityNote).
    await expect(note).toContainText("THIN ETH ROUTE");
    await expect(note).toContainText("Uniswap v3");
    await expect(note).toContainText("before it can graduate");

    // AND THE NUMBER IS THE CHAIN'S, not the sentence's, or the warning is
    // decoration that happens to be the right colour.
    //
    // IT IS THE THRESHOLD NOW, NOT A BALANCE. The warning stopped being about
    // what the pools hold - a balance says where liquidity sits, not what is
    // reachable - and became about what the quoter would charge to buy one
    // threshold. So the figure to check is the size that could not be priced,
    // and it has to be the factory's own.
    const text = await note.innerText();
    const quoted = text.match(/buying\s+([\d,.]+)/);
    expect(quoted, "the warning quotes no size at all: " + text).not.toBeNull();
    const onChain = await page.evaluate(() => ({
      threshold: window.CurbApp.state.ctx.threshold.toString(),
      decimals: Number(window.CurbApp.state.ctx.quoteDecimals),
    }));
    expect(
      Number(quoted[1].replace(/,/g, "")),
      "the size in the warning is not this factory's threshold"
    ).toBeCloseTo(Number(onChain.threshold) / 10 ** onChain.decimals, 1);
  } finally {
    await node("anvil_setCode", [AERO_QUOTER, quoterCode]);
  }

  // ---- 3. AND IT GOES AWAY AGAIN, so nothing here is a one-way latch.
  // BY ADDRESS HERE TOO. This line matched on the label and threw
  // "reading 'value' of undefined" when no option was labelled NVDAc - the
  // same symbol fallback as above, left behind in the half of the test that
  // only restores state. Fixing one and not the other is how a diagnostic
  // points at the wrong place.
  const NVDAC_Q = "0xb20000000000000000000078ee7ce2fE4908108C".toLowerCase();
  const restored = await page.evaluate(async (arg) => {
    const sel = document.getElementById("quotePick");
    if (!sel) return false;
    for (const o of Array.from(sel.options || [])) {
      if (!o || !o.value) continue;
      const r = await fetch(arg.rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call",
          params: [{ to: o.value, data: "0x217a4b70" }, "latest"] }),
      });
      const j = await r.json();
      if (("0x" + String(j.result || "").slice(-40)).toLowerCase() === arg.deep) {
        sel.value = o.value;
        sel.dispatchEvent(new Event("change"));
        return true;
      }
    }
    return false;
  }, { deep: NVDAC_Q, rpc: STATE.rpc });
  expect(restored, "could not switch back to the deep asset").toBe(true);
  await expect(page.locator("#quoteLiquidity.unbounded")).toHaveCount(0, { timeout: 20000 });
});

// THE SUMMARY CARD. Placed with the other end-of-file tests because it types
// into the create form, and the launch this suite creates happens first.
test("the summary card shows the factory's terms and the tax as it is typed", async () => {
  await openApp(TRADER);
  await page.evaluate(() => window.CurbApp.refresh(true));

  const card = page.locator("#launchSummary");
  await expect(card).toBeVisible();

  // THE FACTORY'S HALF, read from the chain rather than written into the page.
  // Not asserted on the symbol: the picker's label falls back to a truncated
  // address in this fixture, which has nothing to do with these terms.
  await expect(page.locator("#sumSupply")).toContainText("1,000,000,000");
  // NVDAc's threshold, 50 since the re-pricing of 2026-10-15 (49.1 before):
  // the whole figure and the space after it, so 500 or 150 cannot pass.
  await expect(page.locator("#sumGrad")).toHaveText(/^50 \S/);
  // WHAT THE CARD ACTUALLY WRITES. The row is labelled "liquidity", so the
  // value says what happens to it: locked, for good.
  await expect(page.locator("#sumLock")).toHaveText("Locked forever");

  // THE CREATOR'S HALF, live. Typed, not set - the card listens to input.
  await page.fill("#nName", "Summary Probe");
  await page.fill("#nSymbol", "PROBE");
  await openAdvanced(page);
  await page.fill("#nTax", "3");
  await expect(page.locator("#sumName")).toHaveText("Summary Probe");
  await expect(page.locator("#sumTicker")).toHaveText("$PROBE");
  await expect(page.locator("#sumFee")).toContainText("3.00%");
  // The split is the part a creator actually decides on: 3% chosen leaves
  // 2.5% theirs, because the platform's half-point is fixed at every setting.
  await expect(page.locator("#sumYours")).toContainText("2.50%");

  // AND IT TRACKS, so this is not a card that rendered once and stuck.
  await page.fill("#nTax", "5");
  await expect(page.locator("#sumFee")).toContainText("5.00%");
  await expect(page.locator("#sumYours")).toContainText("4.50%");
});

/// WHAT THE FIELD PROMISES IS WHAT THE FIELD DOES.
///
/// "Maximum 32 characters" sat under an input that accepted two hundred, and
/// the same under the symbol. A hint that is not enforced is worse than no
/// hint: it tells somebody the form is looking after them while it is not.
///
/// BOTH HALVES ARE CHECKED because they fail differently. maxlength stops a
/// person typing or pasting; it does nothing about a value set any other way,
/// and the launch is permanent either way.
test("the name and symbol limits the form advertises are the ones it enforces", async () => {
  await openApp(TRADER);

  await expect(page.locator("#nName")).toHaveAttribute("maxlength", "32");
  await expect(page.locator("#nSymbol")).toHaveAttribute("maxlength", "10");

  // TYPED, not set: this is the half the browser enforces.
  await page.fill("#nName", "");
  await page.locator("#nName").pressSequentially("x".repeat(40), { timeout: 20_000 });
  expect(await page.locator("#nName").inputValue()).toHaveLength(32);

  await page.fill("#nSymbol", "");
  await page.locator("#nSymbol").pressSequentially("y".repeat(20), { timeout: 20_000 });
  expect(await page.locator("#nSymbol").inputValue()).toHaveLength(10);

  // SET, not typed: maxlength does nothing here, so the page has to.
  await page.evaluate(() => {
    document.getElementById("nName").value = "z".repeat(33);
    document.getElementById("nSymbol").value = "OK";
  });
  const tooLong = await page.evaluate(async () => {
    try { await window.CurbApp.createLaunch(); return "sent"; }
    catch (e) { return e.message; }
  });
  expect(tooLong, "a 33-character name was accepted").toContain("33");
  expect(tooLong, "the refusal does not say what the maximum is").toContain("32");

  await page.evaluate(() => {
    document.getElementById("nName").value = "Fine";
    document.getElementById("nSymbol").value = "S".repeat(11);
  });
  const symToo = await page.evaluate(async () => {
    try { await window.CurbApp.createLaunch(); return "sent"; }
    catch (e) { return e.message; }
  });
  expect(symToo, "an 11-character symbol was accepted").toContain("11");
  expect(symToo, "the refusal does not say what the maximum is").toContain("10");
});

/// AND A NAME THAT IS TOO LONG ANYWAY STAYS INSIDE THE CARD.
///
/// The summary is a fixed 300px column. Before overflow-wrap, one unbroken
/// word drew straight over its edge and out of the panel - which is what the
/// screenshot that started this showed.
test("a name longer than the summary card wraps instead of leaving it", async () => {
  await openApp(TRADER);
  await page.evaluate(() => window.CurbApp.refresh(true));

  // SET RATHER THAN TYPED, deliberately: maxlength would stop this, and the
  // point is that the card survives a value maxlength never saw.
  const fit = await page.evaluate(() => {
    const n = document.getElementById("nName");
    const s = document.getElementById("nSymbol");
    n.value = "asd" + "d".repeat(140);
    s.value = "d".repeat(90);
    n.dispatchEvent(new Event("input"));
    s.dispatchEvent(new Event("input"));
    const card = document.getElementById("launchSummary").getBoundingClientRect();
    const name = document.getElementById("sumName").getBoundingClientRect();
    const tick = document.getElementById("sumTicker").getBoundingClientRect();
    return {
      nameOver: Math.round(name.right - card.right),
      tickOver: Math.round(tick.right - card.right),
      pageScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      wrapped: name.height > 30,
    };
  });
  expect(fit.nameOver, "the name drew past the right edge of the card").toBeLessThanOrEqual(0);
  expect(fit.tickOver, "the ticker drew past the right edge of the card").toBeLessThanOrEqual(0);
  expect(fit.pageScroll, "the page gained a horizontal scrollbar").toBe(0);
  expect(fit.wrapped, "the name did not wrap at all").toBe(true);
});

/// EVERY PAIRED ASSET SHOWS ITS OWN ARTWORK, AND ONE WITHOUT A FILE DOES NOT
/// SHOW A BROKEN PICTURE.
///
/// The fallback is the part worth testing. Nothing probes for the file before
/// adding the <img>, so an asset with no artwork depends entirely on the error
/// handler removing it - and a removed image is what lets the coloured tile
/// underneath come back.
test("an asset with a logo file shows it, and one without falls back to its tile", async () => {
  await openApp(TRADER);
  await page.evaluate(() => window.CurbApp.refresh(true));

  const stocks = page.locator(".qtab", { hasText: "Stocks" });
  await stocks.click();

  // POLLED, NOT READ ONCE. The cards are drawn the moment the tab is clicked
  // and the pictures arrive a little after; a single read races them and the
  // failure would look like a missing file.
  const read = () =>
    page.evaluate(() =>
      [...document.querySelectorAll("#quoteGrid .qcard")].map((c) => {
        const img = c.querySelector(".qmarkImg");
        return {
          sym: c.querySelector(".qsym") ? c.querySelector(".qsym").textContent : "",
          src: img ? img.getAttribute("src") : null,
          loaded: img ? img.complete && img.naturalWidth > 0 : false,
        };
      })
    );
  await expect
    .poll(async () => (await read()).every((c) => c.loaded), {
      message: "not every equity card ended up with artwork that loaded",
    })
    .toBe(true);
  const drawn = await read();
  expect(drawn.length, "no equity cards were drawn").toBeGreaterThan(0);
  for (const card of drawn) {
    // THE QUERY IS NOT PART OF THE CLAIM. The src carries a cache-busting
    // version - the marks changed colour once and browsers kept serving the
    // old white ones - and this test is about which FILE was asked for.
    // THE EXTENSION IS NOT PART OF THE CLAIM EITHER. Two assets have no vector
    // anywhere and carry the raster their own project serves.
    expect(card.src.split("?")[0].replace(/\.(svg|png)$/, ""), `${card.sym} asked for no artwork`).toBe(
      "assets/" + card.sym.toLowerCase().replace(/[^a-z0-9]/g, "")
    );
    expect(card.loaded, `${card.sym} has a file that did not load`).toBe(true);
  }

  // AND WITH THE FILE GONE, the picture removes itself rather than sitting
  // there as a broken icon over the letters.
  //
  // RELOADED RATHER THAN REFRESHED. refresh() does not redraw these cards -
  // fillQuotePicker() runs at init, when the endpoint, factory or lens field
  // changes, and after the automatic switch - never on a plain refresh - so a
  // route installed and then refreshed would never have been
  // requested, and the first version of this assertion could not have failed.
  const gone = drawn[0].src;
  // MATCHED WITHOUT THE QUERY, and with a trailing wildcard so the version
  // does not have to be repeated here to keep this test honest.
  await page.route("**/" + gone.split("?")[0] + "*", (r) => r.fulfill({ status: 404, body: "" }));
  await page.reload();
  await page.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
  await page.locator(".qtab", { hasText: "Stocks" }).click();
  await expect
    .poll(
      async () =>
        page.evaluate((src) => {
          const cards = [...document.querySelectorAll("#quoteGrid .qcard")];
          if (!cards.length) return "no cards yet";
          const still = cards.find((c) => {
            const i = c.querySelector(".qmarkImg");
            return i && i.getAttribute("src").split("?")[0] === src.split("?")[0];
          });
          return still ? "still there" : "removed";
        }, gone),
      { message: "the image for a missing file was left in place" }
    )
    .toBe("removed");

  // AND THE OTHERS ARE UNTOUCHED, so the removal is about that one file and
  // not about the reload having drawn nothing at all.
  const survivors = await page.evaluate(
    () => [...document.querySelectorAll("#quoteGrid .qmarkImg")].length
  );
  expect(survivors, "every logo vanished, not just the one that 404ed").toBeGreaterThan(0);

  const lettersBack = await page.evaluate(() => {
    const mark = document.querySelector("#quoteGrid .qcard .qmark");
    return { text: mark.textContent.trim(), coloured: !!mark.style.background };
  });
  expect(lettersBack.text, "the tile underneath has no letters").not.toBe("");
  expect(lettersBack.coloured, "the tile underneath lost its colour").toBe(true);
});

/// THE TERMS LEFT THE FORM AND DID NOT LEAVE THE PRODUCT.
///
/// Seven paragraphs of permanent consequences were the last thing in the
/// create panel. They are gone from it, which is the point; the test is that
/// they are still reachable, because "removed from the form" and "deleted"
/// are very different promises to have made a creator.
test("the permanent terms moved out of the form and are still one click away", async () => {
  await openApp(TRADER);

  expect(
    await page.locator("#advanced p.note").count(),
    "the long paragraphs are still inside the form"
  ).toBe(0);

  const link = page.locator('a[href="terms.html"]');
  await expect(link).toHaveCount(1);

  const terms = await browserRef.newPage();
  const res = await terms.goto("/terms.html");
  expect(res.status(), "terms.html is not being served").toBe(200);
  // THE PARAGRAPHS THEMSELVES, not merely a page that exists.
  expect(await terms.locator("p.note").count(), "the terms page is empty").toBeGreaterThanOrEqual(7);
  await expect(terms.locator("body")).toContainText("burned");
  await expect(terms.locator("body")).toContainText("0.5%");
  await terms.close();
});

/// WHAT A CREATOR CLAIMS, WHICH IS NOT ALWAYS WHAT THEY ARE CHARGED IN.
///
/// On a pair quoted in WETH the escrow and the hook both hold the fee until it
/// is claimed, and each unwraps inside its claim, so the fee is claimed as
/// ether. It used to say "paid to you in ETH", as though it arrived with the
/// trade; nothing does on that pair. Every other asset pays in itself. The card and the line under the tax field both have to say so, and
/// they have to stop saying so when the asset changes.
///
/// THE ASSET IS SWITCHED THROUGH THE CARDS, not by reloading with another
/// factory: the point is that the answer tracks the choice.
test("the page says a fee is claimed as ether on an ETH pair and in the asset otherwise", async () => {
  await openApp(TRADER);
  await page.evaluate(() => window.CurbApp.refresh(true));

  // THE FIXTURE OPENS ON THE EQUITY FACTORY. Charged and paid in the same
  // thing, so there is nothing extra to say and the line must not say it.
  await expect(page.locator("#sumPaidIn")).toHaveText(/c$/);
  await expect(page.locator("#sumPaidIn")).not.toHaveText("ETH");
  await expect(page.locator("#taxSplit")).not.toContainText("claimed as");

  // AND IT NAMES THE ASSET RATHER THAN A PLACEHOLDER. quoteSym starts life as
  // the string "the quote asset" and is replaced when the factory answers;
  // this line was drawn once, before that, and said so until somebody typed.
  await expect(page.locator("#taxSplit")).not.toContainText("the quote asset");

  // MATCHED ON THE TICKER, NOT ON THE CARD. The card also contains the mark,
  // whose two letters are part of its text - a card labelled ETH reads
  // "ETETH" - so a regex anchored to the whole card matches nothing.
  const eth = page.locator(".qcard").filter({ has: page.locator(".qsym", { hasText: /^ETH$/ }) });
  await expect(eth).toHaveCount(1);
  await eth.click();

  await expect(page.locator("#sumPaidIn")).toHaveText("ETH");
  await expect(page.locator("#taxSplit")).toContainText("claimed as ETH");
  await expect(page.locator("#taxSplit")).not.toContainText("paid to you");
  // AND THE THING IT IS CHARGED ON IS STILL NAMED HONESTLY. A trader needs the
  // wrapped token to trade this pool; only the payout is ether.
  await expect(page.locator("#taxSplit")).toContainText("on 100 WETH");
});

/// THE DESCRIPTION IS ON THE CARD, AND ONLY WHEN THERE IS ONE.
///
/// It is the one field a creator writes that had nowhere to show. Hidden while
/// empty rather than left as a blank paragraph, because the card is short and
/// an empty line in it reads as something failing to load.
test("the description a creator types appears on the summary card", async () => {
  await openApp(TRADER);
  await page.evaluate(() => window.CurbApp.refresh(true));

  await expect(page.locator("#sumDesc")).toBeHidden();

  await page.fill("#nDesc", "A memecoin priced against a tokenized share.");
  await expect(page.locator("#sumDesc")).toBeVisible();
  await expect(page.locator("#sumDesc")).toHaveText("A memecoin priced against a tokenized share.");

  // AND IT GOES AWAY AGAIN, so the card does not keep a line nobody asked for.
  await page.fill("#nDesc", "");
  await expect(page.locator("#sumDesc")).toBeHidden();

  // TEXT, NOT MARKUP. The same string goes into the token's permanent
  // metadata and is typed by a stranger - AUDIT A-1.
  await page.fill("#nDesc", "<img src=x onerror=\"window.__desc_ran=1\">");
  await expect(page.locator("#sumDesc")).toContainText("<img");
  expect(await page.evaluate(() => window.__desc_ran), "the description executed").toBeUndefined();
  expect(
    await page.evaluate(() => document.querySelector("#sumDesc img")),
    "the description became an element"
  ).toBeNull();
});

/// THE CARD READS IN THE ORDER IT WAS ASKED TO READ IN.
///
/// Asserted as a sequence rather than row by row: the complaint this answers
/// was about the order, and a set of individual assertions would pass with
/// them shuffled.
test("the summary card lists the split first and what is locked last, and no launch fee", async () => {
  await openApp(TRADER);
  await page.evaluate(() => window.CurbApp.refresh(true));

  const labels = await page.evaluate(() =>
    [...document.querySelectorAll("#launchSummary .row")].map((r) => r.children[0].textContent.trim())
  );
  // "OF THAT, YOURS" DIRECTLY UNDER THE TRADE FEE IT IS A SHARE OF, with the
  // token it is claimed as. Under "liquidity" it read as a share of the locked
  // liquidity (round 5, N30).
  // NO LAUNCH FEE ROW: launching costs gas only.
  expect(labels).not.toContain("launch fee");
  expect(labels.slice(0, 6)).toEqual([
    "paired with",
    "trade fee",
    "of that, yours",
    "you claim it as",
    "graduation",
    "liquidity",
  ]);

  // AND THE LOCK ROW SAYS IT HAS NO END.
  await expect(page.locator("#sumLock")).toHaveText("Locked forever");
});

/// A FIRST BUY CANNOT TAKE MORE THAN THREE QUARTERS OF THE CURVE.
///
/// TWO HALVES, AND THE SECOND IS THE ONE THAT COUNTS. The field HOLDS a
/// figure above the ceiling at the ceiling as it is typed, so nobody walks
/// into a refusal by accident and the line beneath says what was held - in
/// the asset's own units, read from the factory, because the threshold is per
/// asset.
///
/// THAT HOLD IS A COURTESY. It listens to input events, so anything that puts
/// a value in without a keystroke skips it; createLaunch refuses after it, and
/// the factory refuses after that (B20Graduation.t.sol). The second half sets
/// the field without an event on purpose, to check the refusal is still there
/// rather than replaced by the cap.
// THE CAP IS A FIFTH OF THE SUPPLY, IN TOKENS (CurbLaunchFactory.MAX_DEV_BUY_BPS
// = 2000), so in NVDAc it depends on the tax: at the form's 1% (0.5% platform,
// 0.5% creator) on the 18.5 / 50 NVDAc curve (re-priced 2026-10-15) the
// largest buy within it is 4.67171716 NVDAc - a quarter of the phantom,
// grossed up by the tax - shown at six places, 4.671717. (On 18.1 / 49.1 it
// was 4.570707; the old ceiling was 75% of the threshold, 36.825, and bought
// 66% of the supply.)
test("the form holds a dev buy at a fifth of the supply, and refuses one that gets past the field", async () => {
  await openApp(TRADER);
  await page.evaluate(() => window.CurbApp.refresh(true));

  // THE CAP IS SHOWN WITHOUT BEING ASKED FOR, in the asset and as a share of
  // the supply. Read before anything is typed: the hold rewrites this line.
  await expect(page.locator("#devBuyCap")).toContainText("20% of the supply");
  await expect(page.locator("#devBuyCap")).toContainText("4.671717 NVDAc");

  await page.fill("#nName", "Cap Probe");
  await page.fill("#nSymbol", "CAP");

  // ---- typed: held, and said so.
  await page.fill("#nDevBuy", "46");
  await expect(page.locator("#nDevBuy"), "the field kept a figure above the cap")
    .toHaveValue("4.671717");
  await expect(page.locator("#devBuyCap"), "nothing said the figure had been held")
    .toContainText("Held at 4.671717");

  // ---- past the field: still refused, still naming the figure.
  await page.evaluate(() => { document.getElementById("nDevBuy").value = "46"; });
  const over = await page.evaluate(async () => {
    try { await window.CurbApp.createLaunch(); return "sent"; }
    catch (e) { return e.message; }
  });
  expect(over, "a dev buy above the ceiling was accepted").not.toBe("sent");
  expect(over, "the refusal does not name the cap").toContain("4.671717");
  expect(over, "the refusal does not name the share").toContain("20% of the supply");
  expect(over, "the refusal does not say nothing was sent").toContain("Nothing was sent");
});

/// ENTERING AN ETH-QUOTED POOL IS A WRAP, NOT A SWAP.
///
/// AUDIT C-1, AND THE REASON IT SURVIVED THIS LONG. Every pool test in this
/// file runs on the equity-quoted launch the fixture builds, so the pair this
/// product puts first had no coverage and neither did the route that serves
/// it. What the route did there was quote and send WETH -> USDC -> WETH: a
/// round trip that prices perfectly well, costs two pool fees, and arrives at
/// the token the buyer already had. Measured against the deployed QuoterV2 it
/// returned 0.994005604549159684 for 1.
///
/// THE CALLDATA IS THE CLAIM. A quote reading 1:1 says nothing about what the
/// wallet is asked to sign, and the loss was in the transaction.
test("an ETH-quoted pool is entered by wrapping, with no swap leg in the calldata", async () => {
  await openApp(OWNER);

  // ---- move the page onto the WETH factory the way a creator does.
  await expect
    .poll(async () => page.evaluate(() =>
      Array.from(document.querySelectorAll("#quotePick").length ? document.getElementById("quotePick").options : [])
        .filter((o) => o.value).length),
      { message: "the quote picker never filled", timeout: 20_000 })
    .toBeGreaterThan(1);

  const eth = page.locator(".qcard").filter({ has: page.locator(".qsym", { hasText: /^ETH$/ }) });
  await expect(eth, "no ETH card in the picker").toHaveCount(1);
  await eth.click();

  await expect
    .poll(async () => page.evaluate(() => {
      const c = window.CurbApp.state.ctx;
      return c ? c.quoteSym : null;
    }), { message: "the page never moved onto the WETH factory", timeout: 20_000 })
    .toBe("WETH");

  // ---- a launch of its own, taken past the threshold so a pool exists.
  await page.fill("#nName", "Wrap Only");
  await page.fill("#nSymbol", "WRAP");
  await press(page, "create", expect);

  await page.selectOption("#curveSide", "buy");
  await page.fill("#curveAmount", "10");
  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(page.locator("#curveAct")).toBeEnabled();
  await press(page, "curveAct", expect);
  await page.evaluate(() => window.CurbApp.refresh(true));
  // CROSSING THE THRESHOLD LEAVES IT WAITING, not graduated - the pool is
  // opened by a second, permissionless call. Same two steps as the lifecycle
  // test above.
  await expect(page.locator("#status"), "the WETH launch never filled").toHaveText("Waiting", {
    timeout: 20_000,
  });
  await press(page, "complete", expect);
  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(page.locator("#status"), "the WETH launch never graduated").toHaveText("Graduated", {
    timeout: 20_000,
  });

  // ---- and now the thing under test.
  await page.selectOption("#poolSide", "buy");
  await page.selectOption("#poolVia", "eth");
  await page.fill("#poolAmount", "0.05");
  await page.evaluate(() => window.CurbApp.refresh(true));

  // THE ROUTE SAYS SO IN WORDS. "held by the router between the two legs" is
  // the line a routed trade prints; there is no middle here to hold.
  await expect(page.locator("#poolQuote")).toContainText("wrap only");
  await expect(page.locator("#poolQuote")).not.toContainText("held by the router");
  await expect(page.locator("#poolAct")).toBeEnabled();

  const tx = await dispatch(page, "poolAct");

  // THE PACKED COMMANDS, READ OFF THE CALLDATA. execute(bytes,bytes[],uint256)
  // puts the command bytes in the first dynamic argument.
  const body = tx.data.toLowerCase().slice(10);
  const off = Number(BigInt("0x" + body.slice(0, 64))) * 2;
  const len = Number(BigInt("0x" + body.slice(off, off + 64))) * 2;
  const cmds = body.slice(off + 64, off + 64 + len);

  // 0b wrapEth, 10 v4Swap, 04 sweep. 00 is v3SwapExactIn and must not be here.
  expect(cmds, "the ETH route into a WETH pool still carries a v3 swap").toBe("0b1004");

  // ---- AND THE TRADE ITSELF RECONCILES.
  //
  // THIS IS THE HALF THAT WAS MISSING, and AUDIT M-01 is what it costs. The
  // test above reads what the wallet was ASKED to send; nothing in this file
  // ever mined a trade on a WETH pool, so nobody noticed that the receipt
  // check could not account for the fees. The hook records them as a debt and
  // the pool manager pays it once, for the total - so a page matching two
  // payments to two payees called a perfectly good trade a mismatch.
  await press(page, "poolAct", expect);
  const msg = await page.locator("#msg").textContent();
  expect(msg, "a successful WETH trade was reported as unreconciled")
    .not.toContain("does not match");
  // AND IT SAYS WHERE THE FEES WENT. On a WETH pool the hook keeps both legs
  // as a debt; the receipt used to describe them as paid, and - this account
  // being both the creator and the platform - as "fee income" that arrived.
  expect(msg, "the receipt called a debt a payment").toContain("wrote it down as owed");
  expect(msg, "the receipt told the payee the fee is already in their balance")
    .toContain("not in your balance yet");
  expect(msg).not.toContain("part of what arrived is fee income");
});

/// WHAT IS OWED IS SHOWN, AND THE BUTTON THAT TAKES IT WORKS - IN ETHER.
///
/// The page promised a WETH launch's creator "paid to you in ETH" and had no
/// way at all to collect: the curve's fees wait in the escrow and a WETH pool's
/// wait in the hook, each until claimed. The account here is the creator of the
/// WETH launch above AND the platform, so both ledgers hold something for it.
/// Checked against the chain and the claims' own events, not the page.
test("what an ETH pair owes this account is shown, and claiming it pays ether", async () => {
  await page.evaluate(() => window.CurbApp.refresh(true));
  const where = await page.evaluate(async ({ rpc }) => {
    const k = window.CurbKeccak.keccak256, h = window.CurbAbi.utf8Hex;
    const sel = (sig) => k("0x" + h(sig)).slice(0, 10);
    const res = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call",
        params: [{ to: window.CurbApp.state.chainCfg.factory, data: sel("feeEscrow()") }, "latest"] }) });
    const escrow = "0x" + (await res.json()).result.slice(26);
    return { escrow, quote: window.CurbApp.state.ctx.quote, factory: window.CurbApp.state.chainCfg.factory };
  }, { rpc: STATE.rpc });
  // THE HOOK FROM THE CHAIN, not from the page under test: registry(factory).requiredHook().
  const registryOfFactory = "0x" + (await rawCallApp(where.factory, await selOf(page, "registry()"))).slice(26);
  where.hook = "0x" + (await rawCallApp(registryOfFactory, await selOf(page, "requiredHook()"))).slice(26);
  expect(where.quote.toLowerCase(), "the page is not on the WETH factory any more")
    .toBe("0x4200000000000000000000000000000000000006");

  const owed = () => page.evaluate(async ({ rpc, hook, escrow, who, weth }) => {
    const k = window.CurbKeccak.keccak256, h = window.CurbAbi.utf8Hex;
    const sel = (sig) => k("0x" + h(sig)).slice(0, 10);
    const pad = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
    const call = async (to, data) => {
      const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }) });
      return BigInt((await r.json()).result).toString();
    };
    return {
      hook: await call(hook, sel("owed(address,address)") + pad(who) + pad(weth)),
      escrow: await call(escrow, sel("balanceOfToken(address,address)") + pad(who) + pad(weth)),
    };
  }, { rpc: STATE.rpc, hook: where.hook, escrow: where.escrow, who: OWNER,
       weth: "0x4200000000000000000000000000000000000006" });

  const before = await owed();
  expect(BigInt(before.hook), "the WETH pool trade left nothing owed on the hook").toBeGreaterThan(0n);
  expect(BigInt(before.escrow), "the WETH curve left nothing in the escrow").toBeGreaterThan(0n);

  await expect(page.locator("#owedBox")).toBeVisible();
  // THE NUMBERS ON SCREEN ARE THE CHAIN'S, formatted the page's own way.
  const shown = await page.evaluate(([h, e]) =>
    [window.CurbApp.fmt(BigInt(h), 18, 6), window.CurbApp.fmt(BigInt(e), 18, 6), window.CurbApp.fmt(0n, 18, 6)],
    [before.hook, before.escrow]);
  await expect(page.locator("#owedHook")).toHaveText(shown[0] + " WETH");
  await expect(page.locator("#owedEscrow")).toHaveText(shown[1] + " WETH");
  await expect(page.locator("#owedNote")).toContainText("paid as ETH when you claim");
  await expect(page.locator("#claimHook")).toBeEnabled();
  await expect(page.locator("#claimEscrow")).toBeEnabled();

  const topic = (sig) => page.evaluate((s) => window.CurbKeccak.keccak256("0x" + window.CurbAbi.utf8Hex(s)), sig);
  const claimAndRead = async (button, contract, eventSig) => {
    // THE MESSAGE THIS CLAIM WROTE, not the one the last claim left: wait for
    // a "Claimed in" line naming a hash that was not on screen before.
    const prior = ((await page.locator("#msg").textContent()) || "").match(/0x[0-9a-f]{64}/i);
    await press(page, button, expect);
    await expect
      .poll(async () => {
        const t = (await page.locator("#msg").textContent()) || "";
        const h = t.match(/0x[0-9a-f]{64}/i);
        return t.includes("Claimed in") && h && (!prior || h[0] !== prior[0]);
      }, { message: `${button}: no new "Claimed in" message`, timeout: 60_000 })
      .toBeTruthy();
    const msg = (await page.locator("#msg").textContent()) || "";
    const hash = (msg.match(/0x[0-9a-f]{64}/i) || [])[0];
    const receipt = await mustBeMined(page, hash, "the " + button + " claim");
    const t = await topic(eventSig);
    const log = receipt.logs.find((l) => l.address.toLowerCase() === contract.toLowerCase() && l.topics[0] === t);
    expect(log, `${button}: no ${eventSig} in the receipt - it was not paid as ether`).toBeTruthy();
    return BigInt(log.data.slice(0, 66));
  };

  expect(await claimAndRead("claimHook", where.hook, "PaidAsNative(address,uint256)"),
    "the hook paid a different amount from what it owed").toBe(BigInt(before.hook));
  expect(await claimAndRead("claimEscrow", where.escrow, "ClaimedAsNative(address,uint256)"),
    "the escrow paid a different amount from what it held").toBe(BigInt(before.escrow));

  const after = await owed();
  expect(after.hook, "the hook still owes after the claim").toBe("0");
  expect(after.escrow, "the escrow still holds after the claim").toBe("0");
  await expect(page.locator("#claimHook")).toBeDisabled();
  await expect(page.locator("#claimEscrow")).toBeDisabled();
  await expect(page.locator("#owedHook")).toHaveText(shown[2] + " WETH");
  await expect(page.locator("#owedEscrow")).toHaveText(shown[2] + " WETH");

  // AND WITH NOTHING OWED, A CLICK SENDS NOTHING. The buttons are briefly
  // enabled after any action; the claim itself now reads what is owed first
  // rather than signing a transaction that must revert.
  const sentBefore = await page.evaluate(() => window.ethereum.sent.length);
  await page.evaluate(() => { document.getElementById("claimHook").disabled = false; });
  await page.click("#claimHook");
  await expect(page.locator("#msg")).toContainText("Nothing is owed", { timeout: 30_000 });
  expect(await page.evaluate(() => window.ethereum.sent.length), "a claim of nothing was sent").toBe(sentBefore);
});

/// A LENS NAMING ANOTHER POOL GETS NOTHING SENT.
///
/// The pool key a trade is encoded with came from the lens, which is a link
/// parameter: the right two currencies and somebody else's hook would have
/// routed the swap into their pool. The key is rebuilt from the registry
/// record now, and a lens that disagrees is refused.
test("a pool trade is never sent to a pool the registry does not name", async () => {
  await page.evaluate(() => window.CurbApp.refresh(true));
  await page.selectOption("#poolSide", "buy");
  await page.selectOption("#poolVia", "eth");
  await page.fill("#poolAmount", "0.01");
  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(page.locator("#poolAct")).toBeEnabled();

  const lens = APP.lens.toLowerCase().slice(2);
  const sel = (await selOf(page, "launchState(address)")).slice(2);
  const impostorHook = "ab".repeat(20);
  await page.route("**/*", async (route) => {
    const body = (route.request().postData() || "").toLowerCase();
    if (body.includes(lens) && body.includes(sel)) {
      const real = await route.fetch();
      const payload = await real.json();
      const answer = (payload.result || "").replace(/^0x/, "");
      if (answer.length >= 14 * 64) {
        payload.result = "0x" + answer.slice(0, 13 * 64) + impostorHook.padStart(64, "0") + answer.slice(14 * 64);
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    }
    return route.continue();
  });
  const sentBefore = await page.evaluate(() => window.ethereum.sent.length);
  await page.click("#poolAct");
  await expect(page.locator("#msg")).toContainText("names a different pool", { timeout: 30_000 });
  expect(await page.evaluate(() => window.ethereum.sent.length), "a swap or an approval was sent").toBe(sentBefore);
  await page.unroute("**/*");
});

/// AND AN EQUITY-QUOTED POOL STILL SWAPS.
///
/// The change is scoped to the pair it was made for. Without this, removing
/// the leg for everybody would look identical to fixing it for one.
test("an equity-quoted pool still routes ETH through a swap", async () => {
  // ITS OWN LAUNCH, GRADUATED HERE. The shared token is whatever the test
  // before it left, and several of them leave it selling - so depending on it
  // makes this pass or fail on how the file was filtered rather than on the
  // route.
  await openApp(OWNER);
  await page.fill("#nName", "Route Scope");
  await page.fill("#nSymbol", "RSCP");
  await press(page, "create", expect);
  await page.selectOption("#curveSide", "buy");
  await page.fill("#curveAmount", "70");
  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(page.locator("#curveAct")).toBeEnabled();
  await press(page, "curveAct", expect);
  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(page.locator("#status")).toHaveText("Waiting", { timeout: 20_000 });
  await press(page, "complete", expect);
  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(page.locator("#status")).toHaveText("Graduated", { timeout: 20_000 });

  await page.selectOption("#poolSide", "buy");
  await page.selectOption("#poolVia", "eth");
  await page.fill("#poolAmount", "0.002");
  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(page.locator("#poolAct")).toBeEnabled();

  const tx = await dispatch(page, "poolAct");
  const body = tx.data.toLowerCase().slice(10);
  const off = Number(BigInt("0x" + body.slice(0, 64))) * 2;
  const len = Number(BigInt("0x" + body.slice(off, off + 64))) * 2;
  const cmds = body.slice(off + 64, off + 64 + len);

  // 0b wrapEth, 00 v3SwapExactIn, 10 v4Swap, 04 sweep.
  expect(cmds, "the equity route lost its swap leg").toBe("0b001004");
});

/// THE TWO NUMBER FIELDS STOP AT THEIR MAXIMUM AS THEY ARE TYPED.
///
/// The tax refused anything outside 1-5% and said so, but the field itself
/// took whatever you typed - so 9 could be sitting in it while the line under
/// it said 1-5%. The dev buy was worse: it refused above the ceiling only when
/// the button was pressed, and the sentence beneath it went on stating a limit
/// the field was ignoring.
///
/// HELD, AND SAID SO. Clamping in silence rewrites what somebody typed without
/// telling them, which is the same lie as a limit advertised and not enforced.
test("the tax and the dev buy are held at the most this launch allows", async () => {
  await openApp(TRADER);
  await page.evaluate(() => window.CurbApp.refresh(true));
  // BOTH FIELDS ARE INSIDE THE COLLAPSED PANEL. Without this the locator
  // resolves, stays invisible and is retried until the test's minute is gone.
  await openAdvanced(page);
  await expect(page.locator("#devBuyCap")).toContainText("20%");

  // ---- THE TAX. Five is the top of the band and has to be reachable.
  await page.fill("#nTax", "5");
  expect(await page.locator("#nTax").inputValue(), "5% was not accepted").toBe("5");
  await expect(page.locator("#taxSplit")).toContainText("4.5%");

  await page.fill("#nTax", "9");
  expect(await page.locator("#nTax").inputValue(), "the tax was not held at its maximum").toBe("5");
  await expect(page.locator("#taxSplit")).toContainText("Held at 5%");

  // AND A VALUE INSIDE THE BAND IS LEFT ALONE, including a fractional one -
  // and the line stops saying it held anything.
  await page.fill("#nTax", "4.5");
  expect(await page.locator("#nTax").inputValue()).toBe("4.5");
  await expect(page.locator("#taxSplit"), "the split line still says it was held")
    .not.toContainText("Held at");

  // ---- THE DEV BUY, whose maximum is what buys a fifth of the supply AT THIS
  // TAX - 4.84293192 NVDAc at the 4.5% just typed, against 4.671717 at 1%, on
  // the 18.5 / 50 NVDAc curve of 2026-10-15 - and not a number written into
  // the page.
  await page.fill("#nDevBuy", "999");
  expect(await page.locator("#nDevBuy").inputValue(), "the dev buy was not held at the cap").toBe("4.842931");
  await expect(page.locator("#devBuyCap")).toContainText("Held at 4.842931");

  await page.fill("#nDevBuy", "3");
  expect(await page.locator("#nDevBuy").inputValue(), "a dev buy under the cap was changed").toBe("3");
  // AND THE LINE GOES BACK TO THE CEILING IT NORMALLY STATES. nDevBuy is not
  // one of the fields that redraw the summary, so "Held at 45" used to sit
  // under a field reading 10 until something else happened to redraw it.
  await expect(page.locator("#devBuyCap"), "the cap line still says a figure was held")
    .not.toContainText("Held at");
  await expect(page.locator("#devBuyCap")).toContainText("20%");
});

/// THE SPLIT A CREATOR READ IS THE SPLIT THAT IS SENT - OR NOTHING IS.
///
/// The factory refuses a launch whose expected platform terms no longer match
/// the hook's (PlatformPolicyMoved). The page used to defeat that by reading
/// the policy AGAIN at send time and sending the fresh values, so a change that
/// ripened while the form was being filled in went through onto a record
/// nobody can edit. Here the chain "moves" after the split is drawn: every
/// later answer says 0.8%. The page must refuse before any gas, name the
/// change, and draw the new split on the next refresh.
test("a launch is refused, before any gas, when the platform's terms moved after they were shown", async () => {
  token = null;
  await openApp(OWNER);
  await page.evaluate(() => window.CurbApp.refresh(true));
  await openAdvanced(page);
  await page.fill("#nTax", "3");
  await expect(page.locator("#taxSplit")).toContainText("platform 0.5%");

  const factory = APP.factory.toLowerCase().slice(2);
  const sel = await page.evaluate(() =>
    window.CurbKeccak.keccak256("0x" + window.CurbAbi.utf8Hex("currentPlatformPolicy()")).slice(2, 10));
  await page.route("**/*", async (route) => {
    const body = (route.request().postData() || "").toLowerCase();
    if (body.includes(factory) && body.includes(sel)) {
      const real = await route.fetch();
      const payload = await real.json();
      const answer = (payload.result || "").replace(/^0x/, "");
      if (answer.length >= 128) payload.result = "0x" + (80).toString(16).padStart(64, "0") + answer.slice(64);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
      return;
    }
    await route.continue();
  });

  const sentBefore = await page.evaluate(() => window.ethereum.sent.length);
  await page.fill("#nName", "Moved Terms");
  await page.fill("#nSymbol", "MOVED");
  await page.click("#create");
  await expect(page.locator("#msg")).toContainText("changed while you were filling this in", { timeout: 30_000 });
  await expect(page.locator("#msg")).toContainText("from 0.5% to 0.8%");
  expect(await page.evaluate(() => window.ethereum.sent.length), "something was sent anyway").toBe(sentBefore);

  // THE CACHED CONTEXT WAS DROPPED, so the next refresh draws what applies now.
  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(page.locator("#taxSplit")).toContainText("platform 0.8%");
  await page.unroute("**/*");

  // AND BACK: the screen now says 0.8% and the chain 0.5% - refused the same way.
  await page.click("#create");
  await expect(page.locator("#msg")).toContainText("from 0.8% to 0.5%", { timeout: 30_000 });
  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(page.locator("#taxSplit")).toContainText("platform 0.5%");

  // THE RECIPIENT ALONE MOVING is refused too, and named. Word 1 of the answer.
  const moved = "de".repeat(20);
  await page.route("**/*", async (route) => {
    const body = (route.request().postData() || "").toLowerCase();
    if (body.includes(factory) && body.includes(sel)) {
      const real = await route.fetch();
      const payload = await real.json();
      const answer = (payload.result || "").replace(/^0x/, "");
      if (answer.length >= 128) payload.result = "0x" + answer.slice(0, 64) + moved.padStart(64, "0") + answer.slice(128);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
      return;
    }
    await route.continue();
  });
  await page.click("#create");
  await expect(page.locator("#msg")).toContainText("its recipient from", { timeout: 30_000 });
  expect(await page.evaluate(() => window.ethereum.sent.length), "something was sent anyway").toBe(sentBefore);
  await page.unroute("**/*");
});

/// THE CURVE THAT GETS AN APPROVAL IS THE ONE THE REGISTRY NAMES.
///
/// The lens is a link parameter. A link with the genuine factory and a lens of
/// somebody else's naming their own contract as the curve used to have this
/// page ask for an approval to that contract. Here the lens's answer is
/// rewritten to name another curve; the registry, asked directly, disagrees,
/// and nothing is sent.
test("an approval is never asked for a curve the registry does not name", async () => {
  await ensureSellingLaunch("Registry Named", "RGNM");
  await page.selectOption("#curveSide", "buy");
  await page.fill("#curveAmount", "1");
  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(page.locator("#curveAct")).toBeEnabled();

  const lens = APP.lens.toLowerCase().slice(2);
  const sel = await page.evaluate(() =>
    window.CurbKeccak.keccak256("0x" + window.CurbAbi.utf8Hex("launchState(address)")).slice(2, 10));
  const impostor = "be".repeat(20);
  await page.route("**/*", async (route) => {
    const body = (route.request().postData() || "").toLowerCase();
    if (body.includes(lens) && body.includes(sel)) {
      const real = await route.fetch();
      const payload = await real.json();
      const answer = (payload.result || "").replace(/^0x/, "");
      if (answer.length >= 14 * 64) {
        payload.result = "0x" + answer.slice(0, 64) + impostor.padStart(64, "0") + answer.slice(128);
      }
      // A READ THE PAGE GAVE UP ON while it was being fetched here (its own
      // timeout, a refresh replacing it) is already handled: nothing to answer.
      try {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
      } catch (e) {
        if (!/already handled/i.test(String(e && e.message))) throw e;
      }
      return;
    }
    await route.continue().catch((e) => { if (!/already handled/i.test(String(e && e.message))) throw e; });
  });

  const sentBefore = await page.evaluate(() => window.ethereum.sent.length);
  await page.click("#curveAct");
  await expect(page.locator("#msg")).toContainText("the registry names", { timeout: 30_000 });
  expect(await page.evaluate(() => window.ethereum.sent.length), "an approval or a buy was sent").toBe(sentBefore);
  await page.unroute("**/*");
});

/// A LAUNCH UNDER ANOTHER ASSET'S FACTORY MOVES A LINK'S FACTORY - SAYING SO,
/// SAVING NOTHING - AND LEAVES A FACTORY THE PERSON CHOSE ALONE.
///
/// A link can name a factory that did not make the launch - an older link, one
/// edited by hand, one written before the launch's own factory was known - and
/// every number was then scaled by the wrong asset. (A browse link names the
/// launch's own factory when browse.js knows it; one with a lens and a token
/// and no factory takes none from storage and is resolved from the lens's
/// registry - "a link with no factory is read under the one the registry lists
/// for its asset" holds that.) The first fix moved the factory ALWAYS: it undid a
/// creator's own pick of an asset, silently, and wrote the link's endpoint into
/// storage. This holds both halves.
test("a launch under another asset's factory moves a link's factory, not a chosen one", async () => {
  await ensureSellingLaunch("Home Factory", "HOME");
  const wethFactory = await page.evaluate(async ({ rpc }) => {
    const k = window.CurbKeccak.keccak256, h = window.CurbAbi.utf8Hex;
    const sel = (sig) => k("0x" + h(sig)).slice(0, 10);
    const call = async (to, data) => {
      const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }) });
      return (await r.json()).result;
    };
    const registry = window.CurbApp.state.ctx.registry;
    const n = Number(BigInt(await call(registry, sel("launcherCount()"))));
    for (let i = 0; i < n; i++) {
      const f = "0x" + (await call(registry, sel("launcherAt(uint256)") + i.toString(16).padStart(64, "0"))).slice(26);
      const q = "0x" + (await call(f, sel("quoteToken()"))).slice(26);
      if (q === "0x4200000000000000000000000000000000000006") return f;
    }
    return null;
  }, { rpc: STATE.rpc });
  expect(wethFactory, "the registry has no WETH factory to misplace the launch under").toBeTruthy();

  // ---- CHOSEN: the person types the WETH factory. It stays; the launch is simply not drawn.
  await page.fill("#factory", wethFactory);
  await page.dispatchEvent("#factory", "change");
  await expect(page.locator("#readmsg")).toContainText("priced in NVDAc", { timeout: 30_000 });
  await expect(page.locator("#readmsg")).toContainText("which you chose");
  expect(await page.evaluate(() => window.CurbApp.state.chainCfg.factory.toLowerCase()),
    "the page undid the person's own choice of factory").toBe(wethFactory.toLowerCase());
  await expect(page.locator("#launchPanel")).toBeHidden();

  // ---- FROM A LINK: the same pairing arrives in the URL. The page moves, says
  // so where it stays readable, and writes nothing into storage. openApp opens
  // a FRESH context, so its storage starts empty and must stay that way.
  await openApp(TRADER, wethFactory);
  await expect
    .poll(() => page.evaluate(() => window.CurbApp.state.chainCfg.factory.toLowerCase()),
      { message: "the page stayed on a factory for another asset", timeout: 30_000 })
    .toBe(APP.factory.toLowerCase());
  await expect(page.locator("#factory")).toHaveValue(new RegExp(APP.factory.slice(2), "i"));
  await expect(page.locator("#status")).toHaveText("Selling");
  await expect(page.locator("#progressText")).toContainText("NVDAc");
  await expect(page.locator("#readmsg")).toContainText("so the page moved from the WETH factory");
  expect(await page.evaluate((k) => localStorage.getItem(k), APP_ADDR_STORE),
    "the automatic switch wrote the link's addresses into storage").toBeNull();
});

/// A LAUNCH THE REGISTRY DOES NOT KNOW, OR KNOWS IN ANOTHER ASSET, IS REFUSED
/// BEFORE ANYTHING IS SENT - with the sentence written for each, not a raw
/// revert. launchOf reverts for an unknown token, so the first sentence used
/// to be unreachable; neither refusal had a test.
test("a launch the registry does not know, or prices in another asset, is refused before gas", async () => {
  await ensureSellingLaunch("Registry Refusals", "RGRF");
  await page.selectOption("#curveSide", "buy");
  await page.fill("#curveAmount", "1");
  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(page.locator("#curveAct")).toBeEnabled();

  const registry = (await page.evaluate(() => window.CurbApp.state.ctx.registry)).toLowerCase().slice(2);
  const isReg = (await selOf(page, "isRegistered(address)")).slice(2);
  const launchOfSel = (await selOf(page, "launchOf(address)")).slice(2);
  const sentBefore = await page.evaluate(() => window.ethereum.sent.length);

  // ---- UNKNOWN
  await page.route("**/*", async (route) => {
    const body = (route.request().postData() || "").toLowerCase();
    if (body.includes(registry) && body.includes(isReg)) {
      const msg = JSON.parse(route.request().postData());
      return route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: "0x" + "0".repeat(64) }) });
    }
    return route.continue();
  });
  await page.click("#curveAct");
  await expect(page.locator("#msg")).toContainText("has no record in this factory's registry", { timeout: 30_000 });
  expect(await page.evaluate(() => window.ethereum.sent.length), "something was sent").toBe(sentBefore);
  await page.unroute("**/*");
  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(page.locator("#curveAct")).toBeEnabled();

  // ---- ANOTHER ASSET, in the registry's own record (word 1)
  await page.route("**/*", async (route) => {
    const body = (route.request().postData() || "").toLowerCase();
    if (body.includes(registry) && body.includes(launchOfSel)) {
      const real = await route.fetch();
      const payload = await real.json();
      const answer = (payload.result || "").replace(/^0x/, "");
      if (answer.length >= 128) {
        payload.result = "0x" + answer.slice(0, 64) + padA("0x4200000000000000000000000000000000000006") + answer.slice(128);
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    }
    return route.continue();
  });
  await page.click("#curveAct");
  await expect(page.locator("#msg")).toContainText("This launch is priced in", { timeout: 30_000 });
  await expect(page.locator("#msg")).toContainText("Nothing is sent");
  expect(await page.evaluate(() => window.ethereum.sent.length), "something was sent").toBe(sentBefore);
  await page.unroute("**/*");
});

/// FEES STILL ON A CURVE ARE SHOWN TO EACH PAYEE AS THEIR OWN, AND ONLY THE
/// CREATOR SWEEPS THEM - on the FIRST load of the page, with no extra refresh.
///
/// This used to run as one account that was both the creator and the platform,
/// so swapping or merging the two buckets could not be seen; and it refreshed
/// twice, which hid that the panel read the previous launch on the first
/// load. Here TRADER creates, so the creator and the platform (OWNER) differ.
test("fees on a curve are shown to each payee as their own, and only the creator sweeps them", async () => {
  token = null;
  await openApp(TRADER);
  await page.fill("#nName", "Sweep Source");
  await page.fill("#nSymbol", "SWEEP");
  await press(page, "create", expect);
  token = await page.evaluate(() => window.CurbApp.state.chainCfg.token);
  await page.evaluate(() => window.CurbApp.refresh(true));
  await page.selectOption("#curveSide", "buy");
  await page.fill("#curveAmount", "2");
  await page.evaluate(() => window.CurbApp.refresh(true));
  await press(page, "curveAct", expect);

  const big = (w) => BigInt(w);
  const registry = "0x" + (await rawCallApp(APP.factory, await selOf(page, "registry()"))).slice(26);
  const rec = await rawCallApp(registry, (await selOf(page, "launchOf(address)")) + padA(token));
  const curve = "0x" + rec.slice(2 + 24, 2 + 64);
  const taxSel = await selOf(page, "creatorTaxBalance()");
  const feeSel = await selOf(page, "quoteFeeBalance()");
  const tax = big(await rawCallApp(curve, taxSel));
  const fee = big(await rawCallApp(curve, feeSel));
  expect(tax, "the trade left no creator fee on the curve").toBeGreaterThan(0n);
  expect(fee, "the trade left no platform fee on the curve").toBeGreaterThan(0n);
  const fmt8 = (v) => page.evaluate((x) => window.CurbApp.fmt(BigInt(x), 8, 6), v.toString());

  // ---- THE PLATFORM: its bucket only, and no sweep - which it cannot send.
  await openApp(OWNER);
  await expect(page.locator("#owedCurveRow")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#owedCurve")).toHaveText((await fmt8(fee)) + " NVDAc");
  await expect(page.locator("#sweepCurve")).toBeDisabled();
  const sentOwner = await page.evaluate(() => window.ethereum.sent.length);
  await page.evaluate(() => { document.getElementById("sweepCurve").disabled = false; });
  await page.click("#sweepCurve");
  await expect(page.locator("#msg")).toContainText("Only this launch's creator", { timeout: 30_000 });
  expect(await page.evaluate(() => window.ethereum.sent.length), "a non-creator's sweep was sent").toBe(sentOwner);

  // ---- THE CREATOR: their bucket only, and the sweep.
  await openApp(TRADER);
  await expect(page.locator("#owedCurveRow")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#owedCurve")).toHaveText((await fmt8(tax)) + " NVDAc");
  await expect(page.locator("#sweepCurve")).toBeEnabled();

  const escrow = "0x" + (await rawCallApp(APP.factory, await selOf(page, "feeEscrow()"))).slice(26);
  const balSel = await selOf(page, "balanceOfToken(address,address)");
  const escrowOf = async (who) => big(await rawCallApp(escrow, balSel + padA(who) + padA(NVDAC)));
  const traderBefore = await escrowOf(TRADER);
  const ownerBefore = await escrowOf(OWNER);

  const msg = await press(page, "sweepCurve", expect);
  const hash = (msg.match(/0x[0-9a-f]{64}/i) || [])[0];
  await mustBeMined(page, hash, "the sweep");

  expect(big(await rawCallApp(curve, taxSel)) + big(await rawCallApp(curve, feeSel)), "the curve still holds fees")
    .toBe(0n);
  expect((await escrowOf(TRADER)) - traderBefore, "the creator was not credited exactly their bucket").toBe(tax);
  expect((await escrowOf(OWNER)) - ownerBefore, "the platform was not credited exactly its bucket").toBe(fee);

  // ---- A SECOND SWEEP SENDS NOTHING: the curve is empty and says so.
  // The panel stops offering it first - the row and the button are hidden
  // once the curve holds nothing. The refusal behind it is for the moment
  // after an action when every button is enabled again, so it is pressed the
  // way that moment would let it be: through the button's own handler, in one
  // turn, before the next redraw can hide it again.
  // AFTER THE REFRESH THAT FOLLOWS THE SWEEP HAS LANDED - the row used to come
  // back as "0" then, and this passed only by catching the moment before
  // (round 4, S10).
  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(page.locator("#owedCurveRow"), "an empty curve still shows a row").toBeHidden();
  await expect(page.locator("#sweepCurve"), "an empty curve still offers a sweep").toBeHidden();
  const sentAfter = await page.evaluate(() => window.ethereum.sent.length);
  await page.evaluate(() => {
    const b = document.getElementById("sweepCurve");
    b.hidden = false; b.disabled = false; b.click();
  });
  await expect(page.locator("#msg")).toContainText("Nothing on this curve to sweep", { timeout: 30_000 });
  expect(await page.evaluate(() => window.ethereum.sent.length), "an empty sweep was sent").toBe(sentAfter);
});

/// WHAT THE ESCROW HOLDS IS SHOWN TO EACH PAYEE AS THEIR OWN; A RESTRICTED
/// ACCOUNT IS NOT OFFERED A CLAIM AND CANNOT SEND ONE; AND THE CLAIM PAYS THE
/// CLAIMANT EXACTLY WHAT IT HELD.
///
/// The only test of the escrow and hook rows ran as an account that was the
/// creator AND the platform, so a panel reading the other payee's balance
/// passed (round 4, P-R07). The sweep above has just credited TRADER (the
/// creator) and OWNER (the platform) different amounts in one escrow, and each
/// must see theirs. The hook rows are checked the same way, but on an NVDAc
/// pool nothing is normally owed there to either; the debt written in below,
/// for TRADER alone, is what tells a hook row reading the other payee apart.
///
/// THE RESTRICTION IS THE ISSUER'S ANSWER, REWRITTEN. isAuthorized on the policy
/// registry is made to say no for this account, as a blocklist entry would.
/// Nothing else changes, so a claim that got past the page would go through on
/// chain - which is what makes "nothing was sent" mean something. Neither the
/// disabled buttons nor claimFeesInner's own refusal had a test (round 4, S13 /
/// S21).
test("the escrow shows each payee their own, and a restricted account cannot claim from it", async () => {
  await openApp(TRADER);
  await page.evaluate(() => window.CurbApp.refresh(true));
  const escrow = "0x" + (await rawCallApp(APP.factory, await selOf(page, "feeEscrow()"))).slice(26);
  const registry = "0x" + (await rawCallApp(APP.factory, await selOf(page, "registry()"))).slice(26);
  const hook = "0x" + (await rawCallApp(registry, await selOf(page, "requiredHook()"))).slice(26);
  const balSel = await selOf(page, "balanceOfToken(address,address)");
  const owedSel = await selOf(page, "owed(address,address)");
  const escrowOf = async (who) => BigInt(await rawCallApp(escrow, balSel + padA(who) + padA(NVDAC)));
  const hookOf = async (who) => BigInt(await rawCallApp(hook, owedSel + padA(who) + padA(NVDAC)));
  const fmt8 = (v) => page.evaluate((x) => window.CurbApp.fmt(BigInt(x), 8, 6), v.toString());

  const traderHeld = await escrowOf(TRADER);
  const ownerHeld = await escrowOf(OWNER);
  expect(traderHeld, "the creator holds nothing in the escrow - this runs after the sweep test").toBeGreaterThan(0n);
  expect(traderHeld, "both payees hold the same, so a panel reading the other's would pass").not.toBe(ownerHeld);

  // ---- EACH PAYEE, THEIR OWN
  await expect(page.locator("#owedEscrow")).toHaveText((await fmt8(traderHeld)) + " NVDAc", { timeout: 30_000 });
  await expect(page.locator("#owedHook")).toHaveText((await fmt8(await hookOf(TRADER))) + " NVDAc");
  await openApp(OWNER);
  await expect(page.locator("#owedEscrow")).toHaveText((await fmt8(ownerHeld)) + " NVDAc", { timeout: 30_000 });
  await expect(page.locator("#owedHook")).toHaveText((await fmt8(await hookOf(OWNER))) + " NVDAc");

  // ---- RESTRICTED: the creator again, who has something to claim.
  //
  // A HOOK DEBT IS WRITTEN IN TOO. Nothing is owed there on an NVDAc pool, so
  // the hook's button was off whatever the restriction said, and dropping the
  // restriction from it left this green. The route answers owed(TRADER, NVDAc)
  // with a debt, so both buttons are on before the restriction and each one's
  // "off" after it is the restriction's doing.
  await openApp(TRADER);
  const policyRegistry = "8453000000000000000000000000000000000002";
  const authSel = (await selOf(page, "isAuthorized(uint64,address)")).slice(2);
  const hookOwedData = (owedSel + padA(TRADER) + padA(NVDAC)).slice(2).toLowerCase();
  const hookAddr = hook.toLowerCase().slice(2);
  const fakeDebt = 12345n;
  let restrict = false;
  const answer = (raw, word) => {
    const msg = JSON.parse(raw);
    return { status: 200, contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: "0x" + word.toString(16).padStart(64, "0") }) };
  };
  await page.route("**/*", async (route) => {
    const raw = route.request().postData() || "";
    const body = raw.toLowerCase();
    if (restrict && body.includes(policyRegistry) && body.includes(authSel) && body.includes(TRADER.slice(2))) {
      return route.fulfill(answer(raw, 0n));
    }
    if (body.includes(hookAddr) && body.includes(hookOwedData)) return route.fulfill(answer(raw, fakeDebt));
    return route.continue();
  });
  await page.evaluate(() => window.CurbApp.refresh(true));
  // THE POSITIVE CONTROL: both offered while unrestricted, so "disabled" below
  // is the restriction and not an empty balance.
  await expect(page.locator("#owedHook")).toHaveText((await fmt8(fakeDebt)) + " NVDAc", { timeout: 30_000 });
  await expect(page.locator("#claimEscrow"), "the escrow claim is not offered even unrestricted").toBeEnabled({ timeout: 30_000 });
  await expect(page.locator("#claimHook"), "the hook claim is not offered even unrestricted").toBeEnabled();
  await expect(page.locator("#policyRow")).not.toContainText("RESTRICTED");

  restrict = true;
  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(page.locator("#policyRow"), "the issuer's refusal never reached the page").toContainText("RESTRICTED");
  await expect(page.locator("#claimEscrow"), "a restricted account is offered the escrow claim").toBeDisabled();
  await expect(page.locator("#claimHook"), "a restricted account is offered the hook claim").toBeDisabled();
  await expect(page.locator("#owedNote")).toContainText("has restricted this account");

  // AND A CLAIM THAT GETS PAST THE BUTTON - the moment after an action when
  // every button is enabled again - is refused before anything is signed.
  // Enabled and clicked in one turn, so no redraw can disable it in between.
  // #msg is wiped first so the second refusal cannot pass on the first's words.
  // The hook's refusal is the restriction's and not "nothing is owed": that
  // check comes first in claimFeesInner and would have said so.
  for (const id of ["claimEscrow", "claimHook"]) {
    const sentBefore = await page.evaluate(() => window.ethereum.sent.length);
    await page.evaluate((x) => {
      const m = document.getElementById("msg"); m.innerHTML = ""; m.hidden = true;
      const b = document.getElementById(x); b.disabled = false; b.click();
    }, id);
    await expect(page.locator("#msg"), `${id}: no refusal`)
      .toContainText("has restricted this account, so the claim would revert", { timeout: 30_000 });
    expect(await page.evaluate(() => window.ethereum.sent.length), `${id}: a restricted account's claim was sent`)
      .toBe(sentBefore);
  }
  expect(await escrowOf(TRADER), "the escrow paid out a restricted account's claim").toBe(traderHeld);
  await page.unroute("**/*");

  // ---- LIFTED: the same claim goes, and pays exactly what was held, to the
  // claimant alone.
  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(page.locator("#policyRow")).not.toContainText("RESTRICTED");
  await expect(page.locator("#claimEscrow")).toBeEnabled({ timeout: 30_000 });
  const walletBefore = await balanceOf(page, NVDAC, TRADER);
  await page.click("#claimEscrow");
  await expect(page.locator("#msg")).toContainText("Claimed in", { timeout: 60_000 });
  const hash = (((await page.locator("#msg").textContent()) || "").match(/0x[0-9a-f]{64}/i) || [])[0];
  await mustBeMined(page, hash, "the creator's escrow claim");
  expect((await balanceOf(page, NVDAC, TRADER)) - walletBefore, "the claim did not pay the creator what it held")
    .toBe(traderHeld);
  expect(await escrowOf(TRADER), "the escrow still holds for the creator").toBe(0n);
  expect(await escrowOf(OWNER), "the creator's claim moved the platform's balance").toBe(ownerHeld);
});

/// A LENS WHOSE STATUS, POOL KEY OR RECORD HOOK DISAGREES WITH THE CHAIN GETS
/// NOTHING SENT. Three of beginAction's refusals had no test: the status
/// comparison, the key, and the record's hook against the registry's own.
/// EVERY PART OF THE KEY, not only the fee: this said "the fee and spacing
/// half" and changed the fee alone, so the spacing and both currencies could
/// be dropped from the comparison with the suite green (round 4, S36 / P-R09).
test("a lens whose status, pool key or record hook disagrees with the chain gets nothing sent", async () => {
  await ensureSellingLaunch("Status Checks", "STAT");
  await page.selectOption("#curveSide", "buy");
  await page.fill("#curveAmount", "1");
  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(page.locator("#curveAct")).toBeEnabled();

  const lens = APP.lens.toLowerCase().slice(2);
  const registry = (await page.evaluate(() => window.CurbApp.state.ctx.registry)).toLowerCase().slice(2);
  const stateSel = (await selOf(page, "launchState(address)")).slice(2);
  const recSel = (await selOf(page, "launchOf(address)")).slice(2);
  const word = (v) => BigInt(v).toString(16).padStart(64, "0");
  const rewrite = (to, sel, edits) => page.route("**/*", async (route) => {
    const body = (route.request().postData() || "").toLowerCase();
    const hit = edits.find((e) => body.includes(e.to) && body.includes(e.sel));
    if (!hit) return route.continue();
    const real = await route.fetch();
    const payload = await real.json();
    let answer = (payload.result || "").replace(/^0x/, "");
    for (const [i, w] of hit.words) answer = answer.slice(0, i * 64) + w + answer.slice((i + 1) * 64);
    payload.result = "0x" + answer;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
  });
  const tryAndExpect = async (text) => {
    const sentBefore = await page.evaluate(() => window.ethereum.sent.length);
    // THE LAST CASE'S REFUSAL IS WIPED FIRST. Three cases here end in the same
    // words, and #msg keeps a result until the next one: the spacing and the
    // currency cases passed on the fee case's message, checked before their own
    // click had got as far as sending - so dropping either term from the key
    // comparison left this green (round 4, S36 / P-R09).
    await page.evaluate(() => { const m = document.getElementById("msg"); m.innerHTML = ""; m.hidden = true; });
    // THE REFRESH EVERY ACTION ENDS WITH (guard, refreshAndResume) READS THE
    // LENS THROUGH THE REWRITE TOO - and refresh() now holds the lens to the
    // registry as beginAction does, so it takes the launch off the screen. It
    // is let finish before the rewrite is taken away, and the rewrite is taken
    // away only once every request it holds has its answer. Taken away
    // mid-read, a handler's answer met "Route is already handled!", the throw
    // left the next case's read unanswered, and that click waited 30 seconds on
    // an empty #msg (the 2026-10-09 run, the currencies case).
    await page.evaluate(() => {
      window.__statusRefreshed = new Promise((done) =>
        document.addEventListener("curb:refreshed", () => done(), { once: true }));
    });
    await page.click("#curveAct");
    await expect(page.locator("#msg")).toContainText(text, { timeout: 30_000 });
    expect(await page.evaluate(() => window.ethereum.sent.length), "something was sent").toBe(sentBefore);
    await page.evaluate(() => window.__statusRefreshed);
    await page.unrouteAll({ behavior: "wait" });
    await page.evaluate(() => window.CurbApp.refresh(true));
    await expect(page.locator("#curveAct")).toBeEnabled();
  };

  // ---- the lens says Waiting; the chain says Selling
  await rewrite(null, null, [{ to: lens, sel: stateSel, words: [[0, word(2)]] }]);
  await tryAndExpect("the chain says Selling");

  // ---- the lens names another fee tier
  await rewrite(null, null, [{ to: lens, sel: stateSel, words: [[11, word(3000)]] }]);
  await tryAndExpect("names a different pool");

  // THE LENS'S OWN ANSWER, read here, so the spacing is moved off whatever it
  // really is and the currencies are the real two, swapped.
  const realState = (await rawCallApp(APP.lens, "0x" + stateSel + padA(token))).replace(/^0x/, "");
  expect(realState.length, "the lens did not describe this launch").toBeGreaterThanOrEqual(14 * 64);
  const realWord = (i) => realState.slice(i * 64, (i + 1) * 64);
  expect(realWord(9), "the two currencies are the same word, so swapping them changes nothing")
    .not.toBe(realWord(10));

  // ---- the lens names another tick spacing
  await rewrite(null, null, [{ to: lens, sel: stateSel, words: [[12, word(BigInt("0x" + realWord(12)) + 1n)]] }]);
  await tryAndExpect("names a different pool");

  // ---- the lens swaps the two currencies
  await rewrite(null, null, [{ to: lens, sel: stateSel, words: [[9, realWord(10)], [10, realWord(9)]] }]);
  await tryAndExpect("names a different pool");

  // ---- the record itself names another hook, and the lens agrees with it
  const impostor = "cd".repeat(20).padStart(64, "0");
  await rewrite(null, null, [
    { to: registry, sel: recSel, words: [[7, impostor]] },
    { to: lens, sel: stateSel, words: [[13, impostor]] },
  ]);
  await tryAndExpect("not the registry's own");
});

/// A CREATE IS REFUSED WHEN THE PLATFORM'S TERMS COULD NOT BE READ - the split
/// on screen then says the share is unread rather than showing one nobody read
/// from the chain - and the refusal clears once they can be read again (the
/// policy is no longer cached, failed reads included).
test("a create is refused while the platform's terms cannot be read, and not after", async () => {
  token = null;
  await openApp(OWNER);
  const factory = APP.factory.toLowerCase().slice(2);
  const sel = (await selOf(page, "currentPlatformPolicy()")).slice(2);
  await page.route("**/*", async (route) => {
    const body = (route.request().postData() || "").toLowerCase();
    if (body.includes(factory) && body.includes(sel)) return route.fulfill({ status: 500, body: "down" });
    return route.continue();
  });
  await page.evaluate(() => window.CurbApp.refresh(true));
  await page.fill("#nName", "No Terms");
  await page.fill("#nSymbol", "NOTERM");
  const sentBefore = await page.evaluate(() => window.ethereum.sent.length);
  await page.click("#create");
  await expect(page.locator("#msg")).toContainText("has not read the platform's terms", { timeout: 30_000 });
  expect(await page.evaluate(() => window.ethereum.sent.length), "a create was sent on unread terms").toBe(sentBefore);
  // AND THE SCREEN SAYS SO rather than showing a 0.5% it never read (round 4, S23).
  await expect(page.locator("#taxSplit")).toContainText("could not be read");
  await expect(page.locator("#sumYours")).toHaveText("—");
  await page.unroute("**/*");
  await page.evaluate(() => window.CurbApp.refresh(true));
  expect(await page.evaluate(() => window.CurbApp.state.ctx.platformKnown),
    "the failed read was remembered after the endpoint recovered").toBe(true);
});

/// AN OLDER REFRESH NEVER DRAWS OVER A NEWER ONE. The launch read of one
/// refresh, on launch A, is held back; meanwhile the page moves to launch B on
/// the same factory and draws it. When A's answer is finally released, the
/// old refresh must leave B on screen.
///
/// TWO LAUNCHES, NOT AN EMPTY FIELD. This used to clear the token instead,
/// and that proved nothing: the older refresh then asked the registry about an
/// empty token and hid the panel by itself, so the test passed with the
/// sequence guard deleted. With B in the field, an older refresh that is not
/// stopped compares A's curve with B's record and hides B.
test("an older refresh never draws over a newer one", async () => {
  await ensureSellingLaunch("Seq Guard", "SEQG");
  const a = token;
  await page.fill("#nName", "Seq Guard B");
  await page.fill("#nSymbol", "SEQB");
  await press(page, "create", expect);
  const b = await page.evaluate(() => window.CurbApp.state.chainCfg.token);
  expect(b.toLowerCase(), "the second create did not make a second launch").not.toBe(a.toLowerCase());
  const registry = "0x" + (await rawCallApp(APP.factory, await selOf(page, "registry()"))).slice(26);
  const curveOf = async (t) =>
    "0x" + (await rawCallApp(registry, (await selOf(page, "launchOf(address)")) + padA(t))).slice(2 + 24, 2 + 64);
  const curveB = await curveOf(b);

  // Back to A, drawn.
  await page.fill("#token", a);
  await page.dispatchEvent("#token", "change");
  await expect(page.locator("#curveAddr")).toHaveText(await curveOf(a), { ignoreCase: true, timeout: 30_000 });

  const lens = APP.lens.toLowerCase().slice(2);
  const sel = (await selOf(page, "launchState(address)")).slice(2);
  // PARKED, NOT SLEPT ON. A handler that sleeps holds back the requests
  // behind it as well, so B's refresh finished only after A's had done its
  // damage and simply drew over it - and the test passed with the guard
  // deleted. Parked, A's answer is released only once B is on screen.
  let parked = null;
  await page.route("**/*", async (route) => {
    const body = (route.request().postData() || "").toLowerCase();
    if (!parked && body.includes(lens) && body.includes(sel)) {
      parked = route;                   // released below
      return;
    }
    return route.continue();
  });
  const slow = page.evaluate(() => window.CurbApp.refresh(true));
  await expect.poll(() => !!parked, { message: "the slow read never started" }).toBe(true);
  await page.fill("#token", b);
  await page.dispatchEvent("#token", "change");
  await expect(page.locator("#curveAddr")).toHaveText(curveB, { ignoreCase: true, timeout: 20_000 });

  // NOW A's ANSWER ARRIVES, into a page showing B.
  await parked.continue();
  await slow;
  await page.waitForTimeout(500);
  await expect(page.locator("#launchPanel"), "a stale refresh hid the launch on screen").toBeVisible();
  await expect(page.locator("#curveAddr"), "a stale refresh drew another launch").toHaveText(curveB, { ignoreCase: true });
  await expect(page.locator("#readmsg")).not.toContainText("describes this launch differently");
  await page.unroute("**/*");
  token = a;
  await page.fill("#token", a);
  await page.dispatchEvent("#token", "change");
});

/// The registry's WETH factory, found from the chain through the page's
/// registry - the same walk two tests above do inline.
async function wethFactoryOf(p) {
  return p.evaluate(async ({ rpc }) => {
    const k = window.CurbKeccak.keccak256, h = window.CurbAbi.utf8Hex;
    const sel = (sig) => k("0x" + h(sig)).slice(0, 10);
    const call = async (to, data) => {
      const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }) });
      return (await r.json()).result;
    };
    const registry = window.CurbApp.state.ctx.registry;
    const n = Number(BigInt(await call(registry, sel("launcherCount()"))));
    for (let i = 0; i < n; i++) {
      const f = "0x" + (await call(registry, sel("launcherAt(uint256)") + i.toString(16).padStart(64, "0"))).slice(26);
      const q = "0x" + (await call(f, sel("quoteToken()"))).slice(26);
      if (q === "0x4200000000000000000000000000000000000006") return f;
    }
    return null;
  }, { rpc: STATE.rpc });
}

/// A LAUNCH THE LENS DESCRIBES DIFFERENTLY FROM THE REGISTRY IS NOT DRAWN - ON
/// A REFRESH, WITH NOTHING PRESSED (round 4, S11 / S29 / S36).
///
/// refresh() compares the lens's curve and every part of its pool key with the
/// registry's record before drawing anything. The tests that rewrote the lens
/// pressed a button straight away, so they reached beginAction's copy of the
/// check and never this one: deleting it left the suite green, and the older-
/// refresh test above leans on it besides. Each word is changed on its own -
/// the curve, the two currencies swapped, the fee, the spacing, the hook - so
/// dropping any one term of the comparison fails here.
///
/// THE LAUNCH IS THIS TEST'S OWN, CREATED AND BOUGHT BY TRADER, so its creator
/// fee puts a curve row on TRADER's panel: "the row is not drawn" below is a
/// change from a drawn row, not the empty default.
test("a launch the lens describes differently from the registry is not drawn", async () => {
  // A create, a buy and ten refreshes.
  test.setTimeout(120_000);
  const keep = token;
  token = null;
  await openApp(TRADER);
  await page.fill("#nName", "Draw Check");
  await page.fill("#nSymbol", "DRAW");
  await press(page, "create", expect);
  token = await page.evaluate(() => window.CurbApp.state.chainCfg.token);
  await page.evaluate(() => window.CurbApp.refresh(true));
  await page.selectOption("#curveSide", "buy");
  await page.fill("#curveAmount", "1");
  await page.evaluate(() => window.CurbApp.refresh(true));
  await press(page, "curveAct", expect);
  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(page.locator("#launchPanel")).toBeVisible();
  await expect(page.locator("#owedCurveRow"), "the creator's curve row is not drawn to begin with")
    .toBeVisible({ timeout: 30_000 });

  const lens = APP.lens.toLowerCase().slice(2);
  const stateSel = (await selOf(page, "launchState(address)")).slice(2);
  const real = (await rawCallApp(APP.lens, "0x" + stateSel + padA(token))).replace(/^0x/, "");
  expect(real.length, "the lens did not describe this launch").toBeGreaterThanOrEqual(14 * 64);
  const w = (i) => real.slice(i * 64, (i + 1) * 64);
  expect(w(9), "the two currencies are the same word, so swapping them changes nothing").not.toBe(w(10));
  const bump = (i) => (BigInt("0x" + w(i)) + 1n).toString(16).padStart(64, "0");
  const cases = [
    { what: "another curve", says: "(another curve", words: [[1, "be".repeat(20).padStart(64, "0")]] },
    { what: "the currencies swapped", says: "(another pool)", words: [[9, w(10)], [10, w(9)]] },
    { what: "another fee", says: "(another pool)", words: [[11, bump(11)]] },
    { what: "another tick spacing", says: "(another pool)", words: [[12, bump(12)]] },
    { what: "another hook", says: "(another pool)", words: [[13, "cd".repeat(20).padStart(64, "0")]] },
  ];
  for (const c of cases) {
    await page.route("**/*", async (route) => {
      const body = (route.request().postData() || "").toLowerCase();
      if (!(body.includes(lens) && body.includes(stateSel))) return route.continue();
      const resp = await route.fetch();
      const payload = await resp.json();
      let answer = (payload.result || "").replace(/^0x/, "");
      if (answer.length >= 14 * 64) {
        for (const [i, x] of c.words) answer = answer.slice(0, i * 64) + x + answer.slice((i + 1) * 64);
      }
      payload.result = "0x" + answer;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });
    await page.evaluate(() => window.CurbApp.refresh(true));
    await expect(page.locator("#launchPanel"), `${c.what}: the launch was drawn anyway`).toBeHidden();
    await expect(page.locator("#readmsg")).toContainText("describes this launch differently");
    await expect(page.locator("#readmsg")).toContainText(c.says);
    await expect(page.locator("#owedCurveRow"), `${c.what}: the curve row was drawn for it`).toBeHidden();
    await page.unroute("**/*");
    // AND BACK, so every case starts from a drawn launch and a drawn row.
    await page.evaluate(() => window.CurbApp.refresh(true));
    await expect(page.locator("#launchPanel"), `${c.what}: the launch did not come back once the lens agreed`)
      .toBeVisible();
    await expect(page.locator("#owedCurveRow")).toBeVisible({ timeout: 30_000 });
  }
  token = keep;
});

/// A LINK WITH A LENS AND A TOKEN BUT NO FACTORY IS READ UNDER THE FACTORY THE
/// REGISTRY LISTS FOR THE LAUNCH'S ASSET, AND SAYS SO (round 4, S29). Older
/// browse links carried no factory. The resolution in refresh() had no test,
/// and without it a fresh browser stops at "Enter a factory address". A new
/// page is a new browser context here, so nothing is left in storage to fill
/// the gap instead.
test("a link with no factory is read under the one the registry lists for its asset", async () => {
  await ensureSellingLaunch("No Factory Link", "NOFAC");
  // THE LAUNCH'S ASSET FROM THE REGISTRY'S RECORD, not from the page.
  const registry = "0x" + (await rawCallApp(APP.factory, await selOf(page, "registry()"))).slice(26);
  const rec = await rawCallApp(registry, (await selOf(page, "launchOf(address)")) + padA(token));
  const quote = addrAt(rec, 1);
  const quoteSel = await selOf(page, "quoteToken()");
  const p = await browserRef.newPage();
  try {
    await p.goto("/app.html?" + new URLSearchParams({ rpc: STATE.rpc, lens: APP.lens, token }).toString());
    await p.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
    await expect
      .poll(() => p.evaluate(() => window.CurbApp.state.chainCfg.factory || ""),
        { message: "a link that named no factory was not given one", timeout: 30_000 })
      .toMatch(/^0x[0-9a-fA-F]{40}$/);
    const got = await p.evaluate(() => window.CurbApp.state.chainCfg.factory);
    expect(addrAt(await rawCallApp(got, quoteSel), 0).toLowerCase(), "the factory given serves another asset than the launch's")
      .toBe(quote.toLowerCase());
    await expect(p.locator("#readmsg")).toContainText("The link named no factory", { timeout: 30_000 });
    await expect(p.locator("#status")).toHaveText("Selling", { timeout: 30_000 });
  } finally {
    await p.close();
  }
});

/// AN OLDER REFRESH ON ONE FACTORY NEVER WRITES OVER THE FACTORY THE PAGE HAS
/// MOVED TO (round 4, P-R50).
///
/// The older-refresh test above parks the LAUNCH read on one factory, and the
/// code already stopped a stale refresh right after that read before the
/// factory half was guarded - so it passed with every factory-half check
/// removed. Here each read of the factory half is parked in turn on the NVDAc
/// factory: the platform policy, the threshold behind the depth line, the
/// balance and the issuer's policy. The page moves to the WETH factory and
/// draws it, and only then is the old answer released. Nothing the page shows
/// for the WETH factory may change. Each round first checks that the field it
/// is about reads differently on the two factories, so a stale write would
/// show.
test("an older refresh on one factory never writes over the factory the page moved to", async () => {
  // FOUR ROUNDS, each a fresh page and up to two whole refreshes of waiting:
  // more than one test's default minute on a slow node.
  test.setTimeout(180_000);
  const keep = token;
  token = null;
  await openApp(TRADER);
  await page.evaluate(() => window.CurbApp.refresh(true));
  const weth = await wethFactoryOf(page);
  expect(weth, "the registry has no WETH factory to move to").toBeTruthy();
  const snap = () => page.evaluate(() => {
    const t = (id) => (document.getElementById(id).textContent || "").trim();
    const c = window.CurbApp.state.ctx;
    return {
      ctx: c ? c.factory.toLowerCase() : "", quoteAddr: t("quoteAddr").toLowerCase(), quoteSymA: t("quoteSymA"),
      quoteLiquidity: t("quoteLiquidity"), quoteBal: t("quoteBal"), policyRow: t("policyRow"),
    };
  });
  const rounds = [
    { field: "ctx", to: APP.factory, sig: "currentPlatformPolicy()" },
    { field: "quoteLiquidity", to: APP.factory, sig: "graduationThreshold()" },
    { field: "quoteBal", to: NVDAC, sig: "balanceOf(address)", also: TRADER },
    { field: "policyRow", to: NVDAC, sig: "TRANSFER_SENDER_POLICY()" },
  ];
  for (const r of rounds) {
    await openApp(TRADER);
    await expect(page.locator("#quoteAddr")).toHaveText(NVDAC, { ignoreCase: true, timeout: 30_000 });
    // HOW LONG ONE WHOLE REFRESH TAKES HERE, so the wait after the release
    // covers whatever is left of the parked one.
    const t0 = Date.now();
    await page.evaluate(() => window.CurbApp.refresh(true));
    const took = Date.now() - t0;
    const onNvdac = await snap();
    // THE DEPTH LINE HAS TWO WRITES, each behind its own staleness check: the
    // answer, and the catch's "could not be read". Only the first is the one
    // this round parks in front of, so it must be the one this factory takes.
    if (r.field === "quoteLiquidity") {
      expect(onNvdac.quoteLiquidity, "the depth read failed here, so the guard before a real answer is not reached")
        .not.toContain("could not be read, so this cannot say");
    }

    // NOTHING OF THAT REFRESH STILL OUT. It fires the owed panel's render
    // without awaiting it, and that render asks the issuer the very questions
    // the policy round parks: the held read was ITS late one, the refresh below
    // never waited on anything, and a stale policy write went unseen.
    await expect.poll(() => page.evaluate(() => window.CurbApp.state.owedPending), { timeout: 30_000 }).toBe(0);
    const to = r.to.toLowerCase().slice(2);
    const sel = (await selOf(page, r.sig)).slice(2);
    let parked = null;
    await page.route("**/*", async (route) => {
      const body = (route.request().postData() || "").toLowerCase();
      if (!parked && body.includes(to) && body.includes(sel) && (!r.also || body.includes(r.also.slice(2)))) {
        parked = route;                 // released below
        return;
      }
      return route.continue();
    });
    const slow = page.evaluate(() => window.CurbApp.refresh(true));
    // UP TO A WHOLE REFRESH: the balance and the policy come after the depth
    // quote, which may wait out its own four-second limit.
    await expect.poll(() => !!parked, { message: `${r.sig}: the parked read never started`, timeout: 30_000 })
      .toBe(true);
    await page.fill("#factory", weth);
    await page.dispatchEvent("#factory", "change");
    await page.evaluate(() => window.CurbApp.refresh(true));
    await expect(page.locator("#quoteAddr")).toHaveText(WETH, { ignoreCase: true });
    const onWeth = await snap();
    expect(onWeth.ctx, "the page did not move to the WETH factory").toBe(weth.toLowerCase());
    expect(onWeth[r.field], `${r.field} reads the same on both factories, so a stale write could not be seen`)
      .not.toBe(onNvdac[r.field]);

    // NOW THE NVDAc FACTORY'S ANSWER ARRIVES, into a page showing WETH.
    await parked.continue();
    await slow;
    await page.waitForTimeout(Math.max(1_000, 2 * took));
    expect(await snap(), `a refresh parked on ${r.sig} wrote over the WETH factory`).toEqual(onWeth);
    await page.unroute("**/*");
  }
  token = keep;
});

/// A CREATE STILL WAITING TO BE ADOPTED ON THIS FACTORY STOPS THE SWITCH. The
/// page must not re-point the factory a pending create belongs to.
test("a pending create on this factory stops the automatic switch", async () => {
  await ensureSellingLaunch("Pending Guard", "PEND");
  const nvdaToken = token;
  const wethFactory = await page.evaluate(async ({ rpc }) => {
    const k = window.CurbKeccak.keccak256, h = window.CurbAbi.utf8Hex;
    const sel = (sig) => k("0x" + h(sig)).slice(0, 10);
    const call = async (to, data) => {
      const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }) });
      return (await r.json()).result;
    };
    const registry = window.CurbApp.state.ctx.registry;
    const n = Number(BigInt(await call(registry, sel("launcherCount()"))));
    for (let i = 0; i < n; i++) {
      const f = "0x" + (await call(registry, sel("launcherAt(uint256)") + i.toString(16).padStart(64, "0"))).slice(26);
      const q = "0x" + (await call(f, sel("quoteToken()"))).slice(26);
      if (q === "0x4200000000000000000000000000000000000006") return f;
    }
    return null;
  }, { rpc: STATE.rpc });
  await openApp(TRADER, wethFactory);
  await page.evaluate(({ f, rpc, lens, from }) => {
    window.CurbTx.savePending({ page: "app", kind: "create", chainId: "0x2105", rpc, lens, token: "", factory: f,
      from, to: f, hash: "0x" + "12".repeat(32), what: "create the launch PENDING", nonce: null });
  }, { f: wethFactory, rpc: STATE.rpc, lens: APP.lens, from: TRADER });
  await page.reload();
  await page.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
  await expect(page.locator("#readmsg")).toContainText("It is not drawn here", { timeout: 30_000 });
  expect(await page.evaluate(() => window.CurbApp.state.chainCfg.factory.toLowerCase()),
    "the page re-pointed a factory with a create still waiting on it").toBe(wethFactory.toLowerCase());
  await page.evaluate(() => { window.CurbTx.loadPendingAll().forEach((t) => window.CurbTx.clearPending(t)); });
  token = nvdaToken;
});

/// THE TAX AND THE DEV BUY TAKE A NUMBER AND NOTHING ELSE. Letters used to sit
/// in either field until the button was pressed and parseTax or readDevBuy
/// refused them. Typed key by key, the way a person types: a second point is
/// dropped, and digits past what the chain can hold never arrive - at the
/// asset's own decimals, 8 on this factory, not at some fixed count (S41).
test("the creator tax and the dev buy take only numbers", async () => {
  await openApp(TRADER);
  await page.evaluate(() => window.CurbApp.refresh(true));

  await page.fill("#nTax", "");
  await page.locator("#nTax").pressSequentially("ab2.5x");
  expect(await page.locator("#nTax").inputValue(), "a letter survived in the tax").toBe("2.5");
  await expect(page.locator("#sumFee")).toContainText("2.50%");
  await page.fill("#nTax", "1.2345");
  expect(await page.locator("#nTax").inputValue(), "the tax kept a place finer than a basis point")
    .toBe("1.23");

  await page.fill("#nDevBuy", "");
  await page.locator("#nDevBuy").pressSequentially("1a.2.3b");
  expect(await page.locator("#nDevBuy").inputValue(), "the dev buy kept a letter or a second point")
    .toBe("1.23");
  await page.fill("#nDevBuy", "");
  await page.locator("#nDevBuy").pressSequentially("1.123456789");
  expect(await page.locator("#nDevBuy").inputValue(), "the dev buy was not cut at the asset's 8 decimals")
    .toBe("1.12345678");

  await page.click('#devMode [data-mode="pct"]');
  await expect(page.locator("#nDevPct")).toBeVisible();
  await expect(page.locator("#nDevBuy")).toBeHidden();
  await page.fill("#nDevPct", "");
  await page.locator("#nDevPct").pressSequentially("x5.555");
  expect(await page.locator("#nDevPct").inputValue(), "the share kept a letter or a third place").toBe("5.55");

  await page.click('#devMode [data-mode="amount"]');
  await page.fill("#nDevBuy", "");
  await page.fill("#nTax", "1");
});

/// A COMMA IS SHOWN AND REFUSED, NEVER GUESSED AT (round 4, S02). Read as a
/// decimal point, the page's own printed ceiling "6,300" became 6.3; dropped,
/// a "1,5" typed key by key became 15. Either is off by orders of magnitude,
/// so the comma stays visible, the field is marked, the line under it says to
/// use a point, and the send refuses in the same words.
test("a comma in the tax or the dev buy is shown and refused, never reinterpreted", async () => {
  await openApp(TRADER);
  await page.evaluate(() => window.CurbApp.refresh(true));

  await page.fill("#nTax", "");
  await page.locator("#nTax").pressSequentially("1,5");
  expect(await page.locator("#nTax").inputValue(), "the comma was dropped or rewritten").toBe("1,5");
  await expect(page.locator("#nTax")).toHaveClass(/numBad/);
  await expect(page.locator("#taxSplit")).toContainText("Use a point for decimals");
  await expect(page.locator("#sumFee")).toHaveText("—");
  await page.fill("#nTax", "1.5");
  await expect(page.locator("#nTax")).not.toHaveClass(/numBad/);
  await expect(page.locator("#sumFee")).toContainText("1.50%");

  // THE PAGE'S OWN CEILING, PASTED THE WAY IT IS PRINTED.
  await page.fill("#nDevBuy", "6,300");
  expect(await page.locator("#nDevBuy").inputValue()).toBe("6,300");
  await expect(page.locator("#devBuyOut")).toContainText("Use a point for decimals");
  await page.fill("#nName", "Comma Probe");
  await page.fill("#nSymbol", "COMMA");
  const sentBefore = await page.evaluate(() => window.ethereum.sent.length);
  const refused = await page.evaluate(async () => {
    try { await window.CurbApp.createLaunch(); return "sent"; } catch (e) { return e.message; }
  });
  expect(refused, "a dev buy with a comma was sent").toContain("Use a point for decimals");
  expect(await page.evaluate(() => window.ethereum.sent.length), "something was sent").toBe(sentBefore);
  await page.fill("#nDevBuy", "");
  await page.fill("#nTax", "1");
});

/// EVERY 0.01% STEP IN THE BAND IS ACCEPTED (round 4, S01). The float check
/// this replaced refused 59 of the 401 legal settings - 1.1%, 1.15%, 2.3%,
/// 4.1% - because 2.3 * 100 is 229.99999999999997 in floating point. All 401
/// are asked here, and the two the form was seen refusing are typed.
test("every creator tax from 1.00% to 5.00% in 0.01% steps is accepted", async () => {
  await openApp(TRADER);
  await page.evaluate(() => window.CurbApp.refresh(true));
  const refused = await page.evaluate(() => {
    const bad = [];
    for (let bps = 100; bps <= 500; bps++) {
      const text = (bps / 100).toFixed(2).replace(/\.?0+$/, "");
      try {
        if (window.CurbApp.parseTax(text) !== BigInt(bps)) bad.push(text + " misread");
      } catch (e) { bad.push(text); }
    }
    return bad;
  });
  expect(refused, "legal taxes were refused").toEqual([]);
  for (const [typed, shown] of [["2.3", "2.30%"], ["1.15", "1.15%"], ["4.1", "4.10%"]]) {
    await page.fill("#nTax", typed);
    await expect(page.locator("#sumFee")).toHaveText(shown);
  }
  await page.fill("#nTax", "1");
});

/// THE SLIDER'S LAST STOP IS THE CEILING TO THE UNIT - on a ceiling with digits
/// below six places, which is the only kind where that branch decides anything
/// and which no asset in this fixture has (round 4, S35). So the function is
/// asked directly, with such a ceiling.
test("the slider's last stop is a ceiling with digits below six places, exactly", async () => {
  await openApp(TRADER);
  const r = await page.evaluate(() => {
    const cap = 3600000000123456789n;                      // 18 decimals, digits below six places
    return {
      end: window.CurbApp.sliderAmount(1000, cap, 18).toString(),
      nearly: window.CurbApp.sliderAmount(999, cap, 18).toString(),
      none: window.CurbApp.sliderAmount(0, cap, 18).toString(),
    };
  });
  expect(r.end, "the end of the track is not the ceiling").toBe("3600000000123456789");
  // 999/1000 of it is 3.596400000123333332; rounded DOWN at six places, the
  // digits below them go: 3.5964 exactly.
  expect(r.nearly).toBe("3596400000000000000");
  expect(r.none).toBe("0");
});

/// AN AMOUNT ABOVE THE CEILING IS NOT PRICED AS A BUY (round 4, S24). It gets
/// into the field without an input event when the asset changes under a typed
/// figure; the readout and the summary used to price it as if it were valid.
test("an amount above the ceiling is flagged, not priced", async () => {
  await openApp(TRADER);
  await page.evaluate(() => window.CurbApp.refresh(true));
  await page.evaluate(() => { document.getElementById("nDevBuy").value = "46"; });
  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(page.locator("#devBuyOut")).toContainText("Above the most this launch allows");
  await expect(page.locator("#devBuyOut")).not.toContainText("You pay");
  await expect(page.locator("#sumDevBuy")).toHaveText("above the ceiling");
  await page.evaluate(() => { document.getElementById("nDevBuy").value = ""; });
  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(page.locator("#sumDevBuy")).toHaveText("None");
});

/// A FACTORY TERM THAT FAILS TO LOAD IS ASKED AGAIN, NOT KEPT AS ZERO (round 4,
/// S19). One dropped reply to MAX_DEV_BUY_BPS() used to be cached for the
/// session as "no ceiling", moving the slider's end to 100% of the threshold.
test("a factory term that fails to load is asked again, not cached as zero", async () => {
  await openApp(TRADER);
  const factory = APP.factory.toLowerCase().slice(2);
  const sel = (await selOf(page, "MAX_DEV_BUY_BPS()")).slice(2);
  let failed = 0;
  await page.route("**/*", async (route) => {
    const body = (route.request().postData() || "").toLowerCase();
    if (!failed && body.includes(factory) && body.includes(sel)) { failed += 1; return route.fulfill({ status: 500, body: "down" }); }
    return route.continue();
  });
  // A fresh factory context: the cache is emptied the way a factory change empties it.
  await page.evaluate(() => {
    const f = document.getElementById("factory");
    f.dispatchEvent(new Event("change"));
  });
  await expect.poll(() => failed, { message: "the ceiling read was never failed" }).toBe(1);
  await page.unroute("**/*");
  await page.evaluate(() => window.CurbApp.refresh(true));
  await expect(page.locator("#devBuyCap"), "the failed read was kept as 'no ceiling'").toContainText("20%");
  expect(await page.evaluate(() => window.CurbApp.state.ctx.maxDevBuyBps.toString())).toBe("2000");
});

/// A PRESET WRITES THE FIELD, and everything that listens to the field
/// redraws - because it fires the field's own event rather than drawing
/// anything itself. The preset that matches is lit, and a value between two
/// of them lights none.
test("a tax preset writes the field and lights itself, and a value between presets lights none", async () => {
  await openApp(TRADER);
  await page.evaluate(() => window.CurbApp.refresh(true));

  await page.click('#taxPresets [data-tax="3"]');
  expect(await page.locator("#nTax").inputValue()).toBe("3");
  await expect(page.locator("#sumFee")).toContainText("3.00%");
  await expect(page.locator("#taxSplit")).toContainText("you 2.5%");
  await expect(page.locator('#taxPresets [data-tax="3"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('#taxPresets [aria-pressed="true"]')).toHaveCount(1);

  await page.fill("#nTax", "2.5");
  await expect(page.locator('#taxPresets [aria-pressed="true"]'), "a preset is lit for a value it is not")
    .toHaveCount(0);

  await page.click('#taxPresets [data-tax="1"]');
  await expect(page.locator("#sumFee")).toContainText("1.00%");
});

/// THE SLIDER RUNS FROM NOTHING TO THE CEILING. Its last stop is the ceiling
/// itself, to the unit - a slider whose end fell short would make the largest
/// legal dev buy the one amount it could not reach.
test("the dev buy slider runs from nothing to the ceiling, to the last unit", async () => {
  await openApp(TRADER);
  await page.evaluate(() => window.CurbApp.refresh(true));

  // The cap at the form's 1% tax: 4.67171716 NVDAc buys a fifth of the supply
  // (on the 18.5 / 50 NVDAc curve of 2026-10-15; 4.57070706 on 18.1 / 49.1).
  await page.locator("#nDevSlider").fill("1000");
  expect(await page.locator("#nDevBuy").inputValue(), "the end of the track is not the cap").toBe("4.67171716");
  await expect(page.locator("#sumDevBuy")).toContainText("4.6717");
  // EXACTLY 20.00%: the phantom divides by four, and at 1% the cap amount nets V / 4.
  await expect(page.locator("#sumDevBuy")).toContainText("20.00%");
  // Half of 4.67171716, at six places (2.285353 on 18.1 / 49.1).
  await page.locator("#nDevSlider").fill("500");
  expect(await page.locator("#nDevBuy").inputValue(), "half the track is not half the cap").toBe("2.335858");
  await page.locator("#nDevSlider").fill("0");
  expect(await page.locator("#nDevBuy").inputValue()).toBe("");
  await expect(page.locator("#devBuyOut")).toContainText("No dev buy");
  await expect(page.locator("#sumDevBuy")).toHaveText("None");
});

/// A DEV BUY TYPED AS A SHARE OF THE SUPPLY ARRIVES AS THAT SHARE. The page
/// turns the share into an amount with the curve's own arithmetic, and only
/// the amount is sent. This creates the launch and holds the page's figure
/// against the balance the chain actually delivered - to the unit, not
/// approximately, because the page mirrors the curve rather than estimating
/// it.
test("a dev buy typed as a share of the supply arrives as that share, to the unit", async () => {
  token = null;
  await openApp(TRADER);
  await page.evaluate(() => window.CurbApp.refresh(true));
  await page.fill("#nName", "Share Probe");
  await page.fill("#nSymbol", "SHARE");
  await page.click('#taxPresets [data-tax="2"]');
  await page.click('#devMode [data-mode="pct"]');
  await page.fill("#nDevPct", "10");

  const amountText = await page.locator("#nDevBuy").inputValue();
  expect(amountText, "the share wrote no amount").not.toBe("");
  const promised = await page.evaluate((t) => {
    const a = window.CurbApp.parseUnits(t, window.CurbApp.state.ctx.quoteDecimals);
    const q = window.CurbApp.devBuyQuote(a);
    return { out: q.out.toString(), share: q.shareBps.toString() };
  }, amountText);
  expect(BigInt(promised.share), "the amount written buys less than the share asked for")
    .toBeGreaterThanOrEqual(1000n);
  await expect(page.locator("#devBuyOut")).toContainText("10.00% of the supply");
  await expect(page.locator("#sumDevBuy")).toContainText("10.00%");

  await press(page, "create", expect);
  token = await page.evaluate(() => window.CurbApp.state.chainCfg.token);
  const bal = BigInt(await rawCallApp(token, "0x70a08231" + padA(TRADER)));
  expect(bal, "the chain delivered a different number of tokens than the page promised")
    .toBe(BigInt(promised.out));
});

// ============================================================ round 5: the form's configuration
//
// Each of these opens its OWN page, in a fresh browser context, so what it
// plants in storage and what the page saves there reach nothing else in this
// serial suite.

/// app.html IN A FRESH CONTEXT at a query of the test's choosing, with its
/// address book planted as an earlier visit left it - once, guarded by
/// sessionStorage, so a reload or a later page in the same context does not put
/// it back over what the page saved.
async function freshApp(query, { store = null, account = TRADER, hash = "", before = null } = {}) {
  const p = await browserRef.newPage();
  p.on("pageerror", (e) => console.log("PAGE ERROR: " + e.message));
  const bootstrap = [
    STUB,
    ";(function () {",
    "  var cfg = " + JSON.stringify({ rpc: STATE.rpc, account, store, key: APP_ADDR_STORE }) + ";",
    "  if (cfg.store && !sessionStorage.getItem('fresh.stored')) {",
    "    sessionStorage.setItem('fresh.stored', '1');",
    "    localStorage.setItem(cfg.key, JSON.stringify(cfg.store));",
    "  }",
    "  window.ethereum = window.makeWallet(cfg.rpc, { forward: true, chainId: '0x2105', account: cfg.account });",
    "})();",
  ].join("\n");
  await p.addInitScript({ content: bootstrap });
  if (before) await before(p);
  await p.goto("/app.html?" + new URLSearchParams(query).toString() + hash);
  await p.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
  return p;
}

/// The factories the picker offers, by address, once it has filled.
async function pickerFactories(p) {
  await expect
    .poll(() => p.evaluate(() => Array.from(document.getElementById("quotePick").options).filter((o) => o.value).length),
      { message: "the quote picker never filled", timeout: 30_000 })
    .toBeGreaterThan(1);
  return p.evaluate(() => Array.from(document.getElementById("quotePick").options)
    .filter((o) => o.value).map((o) => o.value.toLowerCase()));
}

/// Every factory a registry lists, read from the test's side.
async function launchersOf(p, registry) {
  const n = Number(wordAt(await rawCall(p, registry, await selOf(p, "launcherCount()")), 0));
  const at = await selOf(p, "launcherAt(uint256)");
  const out = [];
  for (let i = 0; i < n; i++) out.push(addrAt(await rawCall(p, registry, at + i.toString(16).padStart(64, "0")), 0));
  return out.map((a) => a.toLowerCase());
}

const shortOf = (a) => a.slice(0, 6) + "…" + a.slice(-4);
// The first four bytes of keccak256("launcherCount()") and of
// keccak256("launcherAt(uint256)"), as the page sends them - fixed here because
// a route is installed before the page, and its hashing, exist.
const LAUNCHER_COUNT = "0xd48a4846";
const LAUNCHER_AT = "0xfea7ee7a";

/// A LINK'S ENDPOINT AND LENS ARE NEVER SAVED BY A FIELD CHANGE OR A PICK
/// (round 5, N13/N14/N36).
///
/// saveCfg wrote the whole form, and the form held what the link put there: a
/// stranger's app.html?rpc=..&lens=.., one pasted token or one asset card, and
/// the site bar - which reads app.html's saved pair - carried that endpoint and
/// registry on every page and into every search, on every later visit. The
/// site test only ever checked browse.html, which never saves.
///
/// Here: a link naming an endpoint and a lens this browser never saved, the
/// token field changed and an asset card clicked - both of which save. Storage
/// then holds the token (the save happened) and no endpoint, lens or factory;
/// docs.html's bar, which CAN carry a pair (the control, from a link of its
/// own), carries none. Last, the person types the endpoint and the lens: those
/// ARE saved, so the check above could see a saved pair had there been one.
test("a link's endpoint and lens are never saved by a field change or a pick, and the bar carries neither after", async () => {
  const stranger = new URL(STATE.rpc);
  stranger.searchParams.set("stranger", "1");
  const LINK_RPC = stranger.toString();
  const lensOf = (href) => (new URL(href, "http://x/").searchParams.get("lens") || "").toLowerCase();
  const p = await freshApp({ rpc: LINK_RPC, lens: OTHER.lens }, {
    hash: "#create-launch",
    before: (pg) => pg.route((u) => u.searchParams.get("stranger") === "1",
      async (route) => route.fulfill({ response: await route.fetch({ url: STATE.rpc }) })),
  });
  try {
    await pickerFactories(p);
    await p.fill("#token", NVDAC);
    await p.dispatchEvent("#token", "change");
    const card = p.locator(".qcard").first();
    await card.click();
    const picked = await p.evaluate(() => window.CurbApp.state.chainCfg.factory);
    expect(picked, "the card click did not reach the form").toMatch(/^0x[0-9a-fA-F]{40}$/);

    const saved = await p.evaluate((k) => JSON.parse(localStorage.getItem(k) || "null"), APP_ADDR_STORE);
    expect(saved, "nothing was saved, so nothing below proves anything").not.toBeNull();
    expect((saved.token || "").toLowerCase(), "the token change was not saved").toBe(NVDAC.toLowerCase());
    expect(saved.rpc, "the link's endpoint was saved").toBeUndefined();
    expect(saved.lens, "the link's lens was saved").toBeUndefined();
    expect(saved.factory, "a factory picked from the link's registry was saved").toBeUndefined();

    // THE CONTROL: this bar carries a pair when one is there to carry.
    await p.goto("/docs.html?" + new URLSearchParams({ rpc: STATE.rpc, lens: OTHER.lens }).toString());
    await p.waitForSelector("#siteBar .cbInner", { timeout: 10_000 });
    expect(lensOf(await p.locator('#siteBar .cbNav a[data-k="browse"]').getAttribute("href")),
      "the control: the bar does not carry a link's pair, so its silence below means nothing")
      .toBe(OTHER.lens.toLowerCase());

    await p.goto("/docs.html");
    await p.waitForSelector("#siteBar .cbInner", { timeout: 10_000 });
    expect(lensOf(await p.locator('#siteBar .cbNav a[data-k="browse"]').getAttribute("href")),
      "the bar's Launches link carries the link's lens a visit later").toBe("");
    expect(lensOf(await p.locator("#siteBar .cbCta").getAttribute("href")),
      "the bar's + Launch token carries the link's lens a visit later").toBe("");

    // WHAT THE PERSON TYPES IS SAVED.
    await p.goto("/app.html?" + new URLSearchParams({ rpc: LINK_RPC, lens: OTHER.lens }).toString());
    await p.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
    await p.fill("#rpc", STATE.rpc);
    await p.dispatchEvent("#rpc", "change");
    await p.fill("#lens", OTHER.lens);
    await p.dispatchEvent("#lens", "change");
    const typed = await p.evaluate((k) => JSON.parse(localStorage.getItem(k) || "{}"), APP_ADDR_STORE);
    expect(typed.rpc, "an endpoint the person typed was not saved").toBe(STATE.rpc);
    expect((typed.lens || "").toLowerCase(), "a lens the person typed was not saved").toBe(OTHER.lens.toLowerCase());
  } finally {
    await p.close();
  }
});

/// A PICK FROM A LIST ONLY A LINK'S FACTORY SUPPLIED IS NOT SAVED; ONE FROM A
/// FACTORY THE PERSON TYPED IS (round 5, N14).
///
/// The endpoint and the lens here are the person's own; only the factory is the
/// link's - another deployment's - so the asset cards are ITS registry's
/// factories. A card click used to save one of them, chosen: a stranger's
/// registry's contract, kept for every later visit. The stored factory must
/// survive the click. Then the person types that same factory into the field,
/// which makes it theirs: it is saved, and so is the next card they click - so
/// the check above could see a saved pick had there been one.
test("a pick from a list only a link's factory supplied is not saved, and one after the person types the factory is", async () => {
  const store = { rpc: STATE.rpc, lens: APP.lens, factory: APP.factory, token: "", chosen: false };
  const p = await freshApp({ factory: OTHER.factory }, { store });
  try {
    const listed = await pickerFactories(p);
    expect(listed, "the picker is not the link's factory's registry").toContain(OTHER.factory.toLowerCase());
    expect(listed, "the picker lists the person's own factory; the two lists cannot be told apart")
      .not.toContain(APP.factory.toLowerCase());
    await p.locator(".qcard").first().click();
    const picked = (await p.evaluate(() => window.CurbApp.state.chainCfg.factory)).toLowerCase();
    expect(listed, "the card click did not put a listed factory in the form").toContain(picked);
    const afterPick = await p.evaluate((k) => JSON.parse(localStorage.getItem(k) || "{}"), APP_ADDR_STORE);
    expect((afterPick.factory || "").toLowerCase(), "a factory picked from the link's registry was saved")
      .toBe(APP.factory.toLowerCase());
    expect(afterPick.chosen, "a pick from the link's registry was saved as chosen").toBe(false);

    // THE CONTROL: typed, the factory is the person's, and so is a pick after it.
    await p.fill("#factory", OTHER.factory);
    await p.dispatchEvent("#factory", "change");
    const typed = await p.evaluate((k) => JSON.parse(localStorage.getItem(k) || "{}"), APP_ADDR_STORE);
    expect((typed.factory || "").toLowerCase(), "a factory the person typed was not saved").toBe(OTHER.factory.toLowerCase());
    await p.locator(".qcard").last().click();
    const second = (await p.evaluate(() => window.CurbApp.state.chainCfg.factory)).toLowerCase();
    const afterTyped = await p.evaluate((k) => JSON.parse(localStorage.getItem(k) || "{}"), APP_ADDR_STORE);
    expect((afterTyped.factory || "").toLowerCase(), "a pick after the person typed the factory was not saved").toBe(second);
    expect(afterTyped.chosen).toBe(true);
  } finally {
    await p.close();
  }
});

/// A LINK THAT ONLY RESTATES THE SAVED PAIR - the site bar's own "+ Launch
/// token", app.html?rpc=..&lens=..#create-launch - KEEPS A CHOSEN FACTORY AND
/// RAISES NO HALF-LINK WARNING (round 5, N51).
///
/// It used to read as a link naming a lens and no factory: #linkWarn blamed the
/// site's own button for a deployment mismatch, the chosen flag was dropped,
/// and a stored launch of another asset moved the create form off the factory
/// the person had picked - and the next save forgot the pick for good. The
/// control first: a link naming ANOTHER lens does raise the warning, so its
/// absence below is the page's decision and not a warning that cannot show.
test("the bar's own link to the create form keeps a chosen factory and says nothing about half a link", async () => {
  await ensureSellingLaunch("Bar Link", "BARL");
  const nvdaLaunch = token;
  const quoteSel = await selOf(page, "quoteToken()");
  let wethFactory = null;
  for (const f of await launchersOf(page, addrAt(await rawCall(page, APP.factory, await selOf(page, "registry()")), 0))) {
    if (addrAt(await rawCall(page, f, quoteSel), 0).toLowerCase() === WETH.toLowerCase()) wethFactory = f;
  }
  expect(wethFactory, "the registry has no WETH factory to have chosen").toBeTruthy();
  const store = { rpc: STATE.rpc, lens: APP.lens, factory: wethFactory, token: nvdaLaunch, chosen: true };

  const other = await freshApp({ rpc: STATE.rpc, lens: OTHER.lens }, { store, hash: "#create-launch" });
  try {
    await expect(other.locator("#linkWarn"), "the control: a link naming another lens was not warned about")
      .toContainText("named a lens but no factory", { timeout: 20_000 });
  } finally {
    await other.close();
  }

  const p = await freshApp({ rpc: STATE.rpc, lens: APP.lens }, { store, hash: "#create-launch" });
  try {
    await expect(p.locator("#readmsg")).toContainText("priced in NVDAc", { timeout: 30_000 });
    await expect(p.locator("#readmsg"), "the page moved off the factory the person chose")
      .toContainText("which you chose");
    expect(await p.evaluate(() => window.CurbApp.state.chainCfg.factory.toLowerCase())).toBe(wethFactory.toLowerCase());
    await expect(p.locator("#linkWarn"), "the site's own link was called half a link")
      .not.toContainText("named a lens but no factory");
    await expect(p.locator("#linkWarn")).not.toContainText("only half of where to look");

    // A SAVE KEEPS THE PICK.
    await p.dispatchEvent("#rpc", "change");
    const saved = await p.evaluate((k) => JSON.parse(localStorage.getItem(k) || "{}"), APP_ADDR_STORE);
    expect(saved.chosen, "the next save forgot the pick").toBe(true);
    expect((saved.factory || "").toLowerCase()).toBe(wethFactory.toLowerCase());
  } finally {
    await p.close();
  }
});

/// THE PICKER IS READ AGAIN WHEN THE FACTORY FIELD CHANGES (round 5, N52).
///
/// Only a lens change refilled it: after a factory of another deployment was
/// typed, the cards still offered the first registry's factories, and a click
/// put one of them back in the form, chosen. Here the factory field moves to
/// the other deployment, and every option must then be one of ITS registry's
/// launchers - which share none with the first, checked first.
test("the asset picker follows a factory typed into the form to its own registry", async () => {
  const p = await freshApp({ rpc: STATE.rpc, factory: APP.factory, lens: APP.lens });
  try {
    const before = await pickerFactories(p);
    expect(before, "the picker did not list the page's own factory to begin with").toContain(APP.factory.toLowerCase());
    const otherRegistry = addrAt(await rawCall(p, OTHER.factory, await selOf(p, "registry()")), 0);
    const theirs = await launchersOf(p, otherRegistry);
    expect(theirs.length, "the other registry lists nothing").toBeGreaterThan(1);
    expect(theirs.filter((f) => before.includes(f)), "the two registries share a factory; nothing can be told apart")
      .toEqual([]);

    await p.fill("#factory", OTHER.factory);
    await p.dispatchEvent("#factory", "change");
    await expect
      .poll(() => p.evaluate(() => Array.from(document.getElementById("quotePick").options)
        .filter((o) => o.value).map((o) => o.value.toLowerCase()).sort().join(",")),
        { message: "the picker still offers the previous registry's factories", timeout: 30_000 })
      .toBe([...theirs].sort().join(","));
  } finally {
    await p.close();
  }
});

/// AN OLDER FILL OF THE PICKER NEVER LANDS OVER A NEWER ONE (round 5, N52).
///
/// A page with a lens and no factory reads its list from the lens's registry.
/// That read is held here while the person types the other deployment's
/// factory, whose own list is then drawn; only then is the held read let go.
/// The older fill's endpoint and lens have not changed - only which of the two
/// it reads from has - so nothing but the fill's sequence says it is stale.
/// Once let go it must ask the lens's registry nothing more and draw nothing:
/// the picker still offers the typed factory's registry, and the first
/// registry's launcherCount() was never asked (the read that would follow).
const REGISTRY_SEL = "0x7b103999";
test("an older fill of the asset picker never lands over the list for a factory typed after it", async () => {
  const hold = { on: true, parked: [], firstCounted: 0 };
  let firstRegistry = null;
  const p = await freshApp({ rpc: STATE.rpc, lens: APP.lens }, {
    before: (pg) => pg.route((u) => u.toString().startsWith(STATE.rpc), async (route) => {
      let m = null;
      try { m = JSON.parse(route.request().postData() || ""); } catch { m = null; }
      const call = m && m.method === "eth_call" && m.params && m.params[0] ? m.params[0] : null;
      const to = call ? String(call.to || "").toLowerCase() : "";
      const data = call ? String(call.data || "").toLowerCase() : "";
      if (hold.on && to === APP.lens.toLowerCase() && data === REGISTRY_SEL) { hold.parked.push(route); return; }
      if (firstRegistry && to === firstRegistry && data === LAUNCHER_COUNT) hold.firstCounted += 1;
      return route.continue();
    }),
  });
  try {
    expect(await selOf(p, "registry()"), "the route's selector is not the page's").toBe(REGISTRY_SEL);
    // FROM THE TEST'S SIDE: through the page, this read would be the one held.
    firstRegistry = addrAt(await rawCallApp(APP.lens, REGISTRY_SEL), 0).toLowerCase();
    const otherRegistry = addrAt(await rawCall(p, OTHER.factory, REGISTRY_SEL), 0).toLowerCase();
    expect(otherRegistry, "the two deployments share a registry; nothing can be told apart").not.toBe(firstRegistry);
    const theirs = (await launchersOf(p, otherRegistry)).sort().join(",");
    await expect.poll(() => hold.parked.length, { message: "the lens's registry was never asked", timeout: 20_000 })
      .toBeGreaterThan(0);

    await p.fill("#factory", OTHER.factory);
    await p.dispatchEvent("#factory", "change");
    const offered = () => p.evaluate(() => Array.from(document.getElementById("quotePick").options)
      .filter((o) => o.value).map((o) => o.value.toLowerCase()).sort().join(","));
    await expect.poll(offered, { message: "the typed factory's list was never drawn", timeout: 30_000 }).toBe(theirs);

    // LET THE OLDER READ GO, and give it every chance to land.
    hold.on = false;
    const released = hold.parked.splice(0);
    await Promise.all(released.map((r) => r.continue()));
    await p.evaluate(() => new Promise((r) => setTimeout(r, 3000)));
    expect(hold.firstCounted, "the overtaken fill went on to read the first registry").toBe(0);
    expect(await offered(), "the overtaken fill drew the first registry's list over the typed factory's").toBe(theirs);
  } finally {
    await p.close();
  }
});

/// A REGISTRY THAT CLAIMS MORE LAUNCHERS THAN THE PAGE WILL READ IS REFUSED,
/// NOT WALKED (round 5, N49).
///
/// The count came from a registry a link can choose, and it alone decided how
/// many rounds of reads ran: 2^255, and the page sent eth_calls through the
/// person's endpoint until the tab closed. The registry's launcherCount() is
/// answered with 2^255 here. The picker must say it refused, and not one
/// launcherAt() may have been asked; the count route must have been hit, or
/// the refusal was about something else.
test("a launcher count past the page's limit is refused without a single read of a launcher", async () => {
  const counted = { count: 0, at: 0 };
  const p = await freshApp({ rpc: STATE.rpc, factory: APP.factory, lens: APP.lens }, {
    before: async (pg) => {
      await pg.route((u) => u.toString().startsWith(STATE.rpc), async (route) => {
        let m = null;
        try { m = JSON.parse(route.request().postData() || ""); } catch { m = null; }
        const data = m && m.method === "eth_call" && m.params && m.params[0] ? String(m.params[0].data || "") : "";
        if (data === LAUNCHER_COUNT) {
          counted.count += 1;
          return route.fulfill({ status: 200, contentType: "application/json",
            headers: { "access-control-allow-origin": "*" },
            body: JSON.stringify({ jsonrpc: "2.0", id: m.id, result: "0x8" + "0".repeat(63) }) });
        }
        if (data.startsWith(LAUNCHER_AT)) counted.at += 1;
        return route.continue();
      });
    },
  });
  try {
    expect(await selOf(p, "launcherCount()"), "the route's selector is not the page's").toBe(LAUNCHER_COUNT);
    expect(await selOf(p, "launcherAt(uint256)"), "the route's selector is not the page's").toBe(LAUNCHER_AT);
    await expect(p.locator("#quotePick option").first(), "the page did not say it refused the count")
      .toHaveText(/more than the 256 this page will read/, { timeout: 30_000 });
    expect(counted.count, "the count was never asked; the refusal is about something else").toBeGreaterThan(0);
    expect(counted.at, "the page read launchers from a registry claiming 2^255 of them").toBe(0);
    await expect(p.locator(".qcard")).toHaveCount(0);
  } finally {
    await p.close();
  }
});

/// TWO FACTORIES FOR ONE ASSET ARE TOLD APART ON THE CARDS AND IN THE OPTIONS
/// (round 5, N53).
///
/// The fixture's registry holds one factory per asset, so a second NVDAc one is
/// added to what the page reads: launcherCount() answers one more, and the new
/// last index is the other deployment's NVDAc factory - a real contract with
/// real terms. Both must then be listed with their own addresses, the one
/// admitted last marked newest, and no two of the NVDAc cards or options may
/// read the same.
test("two factories for one asset are told apart on the cards and in the options", async () => {
  const probe = await freshApp({ rpc: STATE.rpc, factory: APP.factory, lens: APP.lens });
  expect(await selOf(probe, "launcherCount()"), "the route's selector is not the page's").toBe(LAUNCHER_COUNT);
  expect(await selOf(probe, "launcherAt(uint256)"), "the route's selector is not the page's").toBe(LAUNCHER_AT);
  const quoteSel = await selOf(probe, "quoteToken()");
  const ours =addrAt(await rawCall(probe, APP.factory, quoteSel), 0).toLowerCase();
  const theirs = addrAt(await rawCall(probe, OTHER.factory, quoteSel), 0).toLowerCase();
  const registry = addrAt(await rawCall(probe, APP.factory, await selOf(probe, "registry()")), 0).toLowerCase();
  const n = Number(wordAt(await rawCall(probe, registry, LAUNCHER_COUNT), 0));
  await probe.close();
  expect(theirs, "the other deployment's factory is not on the same asset; there is no twin to draw").toBe(ours);

  const p = await freshApp({ rpc: STATE.rpc, factory: APP.factory, lens: APP.lens }, {
    before: (pg) => pg.route((u) => u.toString().startsWith(STATE.rpc), async (route) => {
      let m = null;
      try { m = JSON.parse(route.request().postData() || ""); } catch { m = null; }
      const call = m && m.method === "eth_call" && m.params && m.params[0] ? m.params[0] : null;
      const to = call ? String(call.to || "").toLowerCase() : "";
      const data = call ? String(call.data || "").toLowerCase() : "";
      const reply = (result) => route.fulfill({ status: 200, contentType: "application/json",
        headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) });
      if (to === registry && data === LAUNCHER_COUNT) return reply("0x" + (n + 1).toString(16).padStart(64, "0"));
      if (to === registry && data === LAUNCHER_AT + n.toString(16).padStart(64, "0")) {
        return reply("0x" + padA(OTHER.factory));
      }
      return route.continue();
    }),
  });
  try {
    const listed = await pickerFactories(p);
    expect(listed, "the added factory is not listed").toContain(OTHER.factory.toLowerCase());
    expect(listed).toContain(APP.factory.toLowerCase());

    const options = await p.evaluate((fs) => Array.from(document.getElementById("quotePick").options)
      .filter((o) => fs.includes(o.value.toLowerCase())).map((o) => ({ f: o.value.toLowerCase(), text: o.textContent })),
    [APP.factory.toLowerCase(), OTHER.factory.toLowerCase()]);
    expect(options.length).toBe(2);
    expect(options[0].text, "the two options read the same").not.toBe(options[1].text);
    for (const o of options) {
      expect(o.text.toLowerCase(), "an option does not name its factory").toContain(shortOf(o.f));
    }
    expect(options.find((o) => o.f === OTHER.factory.toLowerCase()).text, "the factory admitted last is not marked")
      .toContain("newest");
    expect(options.find((o) => o.f === APP.factory.toLowerCase()).text).not.toContain("newest");

    // THE CARDS: the NVDAc ones, under whichever tab holds them.
    await p.locator(".qtab", { hasText: "Stocks" }).click();
    const cards = await p.evaluate((q) => Array.from(document.querySelectorAll(".qcard"))
      .filter((c) => (c.title || "").toLowerCase().includes(q)).map((c) => ({ text: c.innerText, title: c.title })), ours);
    expect(cards.length, "there are not two cards for the asset").toBe(2);
    expect(cards[0].text, "the two cards read the same").not.toBe(cards[1].text);
    const texts = cards.map((c) => c.text.toLowerCase()).join(" | ");
    expect(texts).toContain(shortOf(OTHER.factory.toLowerCase()));
    expect(texts).toContain(shortOf(APP.factory.toLowerCase()));
    for (const c of cards) expect(c.title, "a card's title does not carry its terms").toMatch(/threshold|terms unread/);
  } finally {
    await p.close();
  }
});

/// "NEWEST" IS NOT GUESSED PAST A FACTORY THAT DID NOT ANSWER (round 5, N53).
///
/// The mark is what sends a creator to an asset's current terms, and it was
/// given to the last factory that ANSWERED: one admitted after it whose reads
/// failed - a rate limit is enough - may be a third for the same asset. The
/// registry here lists the same two twins as the test above plus one more
/// index, which the endpoint answers with a JSON-RPC error. The twins are still
/// told apart (the labels are there, so the page is drawing them), and neither
/// is called newest.
test("a factory admitted later that did not answer leaves neither twin marked newest", async () => {
  const probe = await freshApp({ rpc: STATE.rpc, factory: APP.factory, lens: APP.lens });
  const quoteSel = await selOf(probe, "quoteToken()");
  const ours = addrAt(await rawCall(probe, APP.factory, quoteSel), 0).toLowerCase();
  const theirs = addrAt(await rawCall(probe, OTHER.factory, quoteSel), 0).toLowerCase();
  const registry = addrAt(await rawCall(probe, APP.factory, await selOf(probe, "registry()")), 0).toLowerCase();
  const n = Number(wordAt(await rawCall(probe, registry, LAUNCHER_COUNT), 0));
  await probe.close();
  expect(theirs, "the other deployment's factory is not on the same asset; there is no twin to draw").toBe(ours);

  const asked = { unread: 0 };
  const p = await freshApp({ rpc: STATE.rpc, factory: APP.factory, lens: APP.lens }, {
    before: (pg) => pg.route((u) => u.toString().startsWith(STATE.rpc), async (route) => {
      let m = null;
      try { m = JSON.parse(route.request().postData() || ""); } catch { m = null; }
      const call = m && m.method === "eth_call" && m.params && m.params[0] ? m.params[0] : null;
      const to = call ? String(call.to || "").toLowerCase() : "";
      const data = call ? String(call.data || "").toLowerCase() : "";
      const answer = (body) => route.fulfill({ status: 200, contentType: "application/json",
        headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ jsonrpc: "2.0", id: m.id, ...body }) });
      if (to === registry && data === LAUNCHER_COUNT) return answer({ result: "0x" + (n + 2).toString(16).padStart(64, "0") });
      if (to === registry && data === LAUNCHER_AT + n.toString(16).padStart(64, "0")) {
        return answer({ result: "0x" + padA(OTHER.factory) });
      }
      if (to === registry && data === LAUNCHER_AT + (n + 1).toString(16).padStart(64, "0")) {
        asked.unread += 1;
        return answer({ error: { code: -32005, message: "rate limited" } });
      }
      return route.continue();
    }),
  });
  try {
    const listed = await pickerFactories(p);
    expect(listed, "the added factory is not listed").toContain(OTHER.factory.toLowerCase());
    expect(asked.unread, "the later index was never asked for; nothing went unread").toBeGreaterThan(0);
    const options = await p.evaluate((fs) => Array.from(document.getElementById("quotePick").options)
      .filter((o) => fs.includes(o.value.toLowerCase())).map((o) => ({ f: o.value.toLowerCase(), text: o.textContent })),
    [APP.factory.toLowerCase(), OTHER.factory.toLowerCase()]);
    expect(options.length).toBe(2);
    // THE CONTROL: the twins are labelled, so a "newest" would be in this text.
    for (const o of options) {
      expect(o.text.toLowerCase(), "the twins were not labelled at all").toContain(shortOf(o.f));
      expect(o.text, "a factory was called newest past one admitted after it that did not answer")
        .not.toContain("newest");
    }
  } finally {
    await p.close();
  }
});

/// HALF OF THE SAVED PAIR, RESTATED, IS NOT HALF A LINK (round 5, N51).
///
/// A link naming only the lens this browser saved reads it at the endpoint
/// saved WITH it: there are not two places for the halves to have come from,
/// and "this link gave only half of where to look" said otherwise. The control
/// first: the same link naming ANOTHER lens is warned about, so the silence
/// after it is the page's decision.
test("a link restating only the saved lens is not called half a link, and another lens is", async () => {
  const store = { rpc: STATE.rpc, lens: APP.lens, factory: APP.factory, token: "", chosen: false };
  const other = await freshApp({ lens: OTHER.lens }, { store });
  try {
    await expect(other.locator("#linkWarn"), "the control: a lens with no endpoint was not called half a link")
      .toContainText("only half of where to look", { timeout: 20_000 });
  } finally {
    await other.close();
  }

  const p = await freshApp({ lens: APP.lens }, { store });
  try {
    await pickerFactories(p);   // the page is well past init, where the warning is written
    expect(await p.evaluate(() => window.CurbApp.state.chainCfg.rpc), "the saved endpoint is not the one in use")
      .toBe(STATE.rpc);
    await expect(p.locator("#linkWarn"), "the saved lens, restated, was called half a link")
      .not.toContainText("only half of where to look");
  } finally {
    await p.close();
  }
});

/// A WALLET'S accountsChanged MOVES THIS PAGE'S ACCOUNT, AND THE BAR'S - AND
/// AFTER A DISCONNECT, NEITHER (round 5, N37).
///
/// Both handlers were new and nothing ever emitted the event: deleting either,
/// or either one's Disconnect gate, left every suite green. The wallet stub
/// keeps its listeners and emits synchronously (wallet-stub.js emit), so
/// whatever a handler does to the page is done by the time emit returns. The
/// first half is the control for the second: the same event, before the
/// Disconnect, visibly changes both.
test("a wallet's account change moves the page and the bar, and after a Disconnect neither", async () => {
  const p = await freshApp({ rpc: STATE.rpc, factory: APP.factory, lens: APP.lens });
  try {
    await expect(p.locator("#wallet")).toContainText(TRADER, { ignoreCase: true, timeout: 20_000 });
    await p.waitForSelector("#siteBar .cbInner", { timeout: 10_000 });
    await expect(p.locator("#barConnect")).toContainText(shortOf(TRADER), { timeout: 10_000 });

    await p.evaluate((a) => window.ethereum.emit("accountsChanged", [a]), OWNER);
    await expect(p.locator("#wallet"), "the page kept the old account").toContainText(OWNER, { ignoreCase: true });
    await expect(p.locator("#barConnect"), "the bar kept the old account").toContainText(shortOf(OWNER));
    expect(await p.evaluate(() => window.CurbApp.state.account.toLowerCase())).toBe(OWNER.toLowerCase());

    // DISCONNECT, from the bar. app.html is reloaded by it.
    await p.waitForFunction(() => !document.getElementById("connect").disabled, null, { timeout: 30_000 });
    await p.click("#barConnect");
    const reloaded = p.waitForEvent("load");
    await p.click("#siteBar .cbOut");
    await reloaded;
    await p.waitForFunction(() => !!window.CurbApp, null, { timeout: 8_000 });
    await p.waitForSelector("#siteBar .cbInner", { timeout: 10_000 });
    await expect(p.locator("#barConnect")).toHaveText("Connect wallet");
    await expect(p.locator("#wallet")).not.toContainText("Connected:");

    await p.evaluate((a) => window.ethereum.emit("accountsChanged", [a]), OWNER);
    await expect(p.locator("#wallet"), "a wallet event put an account back on the page after a Disconnect")
      .not.toContainText("Connected:");
    await expect(p.locator("#barConnect"), "a wallet event put an account back in the bar after a Disconnect")
      .toHaveText("Connect wallet");
    expect(await p.evaluate(() => window.CurbApp.state.account)).toBeNull();
  } finally {
    await p.close();
  }
});
