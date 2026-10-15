// WHAT EACH QUOTE ASSET IS WORTH, AND WHETHER ONE LAUNCH CAN BE FILLED FROM IT.
//
//   RPC=https://base-rpc.publicnode.com node script/b20/measure-thresholds.js
//
// THAT ENDPOINT, NOT mainnet.base.org, which refuses a run this long with
// rate limits part way through (measured 2026-10-15: the fourteen were priced
// through publicnode in one pass). Everything here reads the latest block, so
// an endpoint without archive state is enough.
//
// RUN THIS IMMEDIATELY BEFORE DEPLOYING. A factory's graduationThreshold is
// immutable, so it freezes whatever price was true when the deployment was
// signed. The numbers in DeployCurb were measured at the pinned fork block and
// were three to fourteen per cent stale within days.
//
// TWO QUESTIONS, TWO SOURCES, AND CONFUSING THEM IS THE TRAP THIS SCRIPT EXISTS
// TO AVOID:
//   WHAT IS IT WORTH   - the pool's own price, slot0's sqrtPriceX96. NOT the
//                        ratio of its balances: Uniswap v3 concentrates
//                        liquidity, so what sits in the contract depends on
//                        where that liquidity was placed. Dividing one balance
//                        by the other gave $153 for NVDAc against a real $226.
//   CAN IT BE OBTAINED - the most of the asset held in ANY pool. Asking only
//                        about USDC pools reported that NVDAc could not fill a
//                        launch while 284 of it sat in a WETH pool.
//
// Both mistakes were made here first, in that order, and both produced a
// confident wrong answer rather than an obvious failure.

// EACH EQUITY'S PRICE, FROM THE POOL'S OWN PRICE - NOT FROM ITS BALANCES.
//
// A first attempt divided a v3 pool's USDC balance by its equity balance and
// got $153 for NVDAc against a table that says $220 and a live venue that says
// $227. The balances are not the price: Uniswap v3 concentrates liquidity, so
// what sits in the contract depends on where that liquidity was placed
// relative to the current tick. slot0's sqrtPriceX96 is the price.
//
// Usage:  RPC=http://127.0.0.1:8561 node price_probe.js
const RPC = process.env.RPC || "http://127.0.0.1:8561";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const V3_FACTORY = "0x33128a8fc17869897dce68ed026d694621f6fdfd";
const WETH = "0x4200000000000000000000000000000000000006";
const TIERS = [100, 500, 3000, 10000];

// DECIMALS ARE CARRIED PER ASSET, not assumed. Every B20 equity is 8 and WETH
// is 18, and a version of this that hard-coded 8 would have priced ETH ten
// billion times wrong while looking like it worked.
const ASSETS = [
  ["WETH", "0x4200000000000000000000000000000000000006", 18],
  ["NVDAc", "0xb20000000000000000000078ee7ce2fe4908108c", 8],
  ["SPCXc", "0xb2000000000000000000007b9fcbd005511acbd5", 8],
  ["GOOGLc", "0xb2000000000000000000002d0ba3164cc74f58b7", 8],
  ["AAPLc", "0xb200000000000000000000c2e324d24d7eecd1fb", 8],
  ["MSFTc", "0xb200000000000000000000ab99cfa739e253872b", 8],
  ["METAc", "0xb2000000000000000000008bc8786b856e61707c", 8],
  ["AMZNc", "0xb200000000000000000000d9192b6b456483c2e8", 8],
  // ADDED 23 SEPTEMBER 2026. Every address and every decimals value below was
  // read back off the chain before being written here - symbol(), decimals()
  // and a non-empty codesize - rather than copied from the survey file.
  //
  // THE DECIMALS ARE NOT ALL 8 ANY MORE. cbXRP and cbADA are 6 and cbHYPE and
  // cbMEGA are 18, so the comment above this list that says "every B20 equity
  // is 8" stops being the whole story here. A version of this that assumed 8
  // would price cbMEGA ten billion times wrong while looking like it worked -
  // the same mistake the header warns about, one asset family over.
  ["TSLAc", "0xb2000000000000000000001e800a7f5189430cd0", 8],
  ["SNDKc", "0xb200000000000000000000397293cb8cda9a10c5", 8],
  ["MSTRc", "0xb2000000000000000000004884b426556b92883d", 8],
  ["COINc", "0xb200000000000000000000c85a31389d71f3ecfb", 8],
  ["cbBTC", "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf", 8],
  ["cbXRP", "0xcb585250f852c6c6bf90434ab21a00f02833a4af", 6],
  ["cbDOGE", "0xcbd06e5a2b0c65597161de254aa074e489deb510", 8],
  ["cbADA", "0xcbada732173e39521cdbe8bf59a6dc85a9fc7b8c", 6],
  ["cbLTC", "0xcb17c9db87b595717c857a08468793f5bab6445f", 8],
  ["cbZEC", "0xb2000000000000000000008501b13360000cb2ec", 8],
  ["cbHYPE", "0xb200000000000000000000451d033a5000cb479e", 18],
  ["cbMEGA", "0xcb111e6a2a3bde90856d299d61341ac302167d23", 18],
  // ADDED 15 OCTOBER 2026, with the list of fourteen (DeployCurb.quoteAssets).
  // Read back off the chain like the rest: USDC is Circle's FiatToken proxy,
  // six decimals; VIRTUAL and AERO are plain eighteen-decimal ERC-20s.
  //
  // USDC IS PRICED HERE BY DEFINITION, NOT MEASURED: every dollar figure this
  // script prints is a USDC figure, so its own price is 1 by construction and
  // Chainlink's USDC / USD (0x7e86...bc6B) is the only check that means
  // anything (DEPLOY.txt PREP 1 point 2). Its DEPTH is measured like any
  // other asset's - the most USDC in any WETH pool.
  ["USDC", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", 6],
  ["VIRTUAL", "0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b", 18],
  ["AERO", "0x940181a94a35a4569e4529a3cdfb74e38fd98631", 18],
];

let id = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// PACED AND RETRIED, BECAUSE A PUBLIC ENDPOINT WILL REFUSE. It refuses loudly
// here rather than answering "no pool", which is what made the earlier survey
// against this endpoint worthless: a rate limit and an absent market looked
// identical. Backing off is the difference between a slow answer and a wrong
// one.
const PACE = Number(process.env.PACE || 250);
async function call(to, data) {
  for (let attempt = 0; ; attempt++) {
    await sleep(PACE);
    const r = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "eth_call", params: [{ to, data }, "latest"] }),
    });
    const j = await r.json().catch(() => ({ error: { message: "unparseable reply" } }));
    if (!j.error) return j.result;
    const msg = String(j.error.message || "");
    if (attempt >= 6 || !/rate limit|too many|429|timeout/i.test(msg)) {
      throw new Error(msg + " (after " + attempt + " retries)");
    }
    await sleep(600 * (attempt + 1));
  }
}
const pad = (a) => a.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const hexNum = (n) => n.toString(16).padStart(64, "0");

async function poolFor(a, b, fee) {
  // getPool(address,address,uint24)
  const res = await call(V3_FACTORY, "0x1698ee82" + pad(a) + pad(b) + hexNum(fee));
  const addr = "0x" + res.slice(-40);
  return /^0x0{40}$/.test(addr) ? null : addr;
}
const balanceOf = async (token, who) =>
  BigInt(await call(token, "0x70a08231" + pad(who)));

async function slot0Sqrt(pool) {
  // slot0() -> sqrtPriceX96 is the first word
  const res = await call(pool, "0x3850c7bd");
  return BigInt("0x" + res.replace(/^0x/, "").slice(0, 64));
}
const token0Of = async (pool) => "0x" + (await call(pool, "0x0dfe1681")).slice(-40);

const Q96 = 2n ** 96n;
/// THE SHAPE DECIDED 2026-10-03: a launch starts at a market cap of the
/// phantom and graduates at (phantom + threshold)^2 / phantom. $4,000 and
/// $55,000 give a phantom of $4,000 and a threshold of $10,832 - the size the
/// market has to supply. (D1 was $13,231 for both.)
const PHANTOM_USD = 4000;
const TARGET_USD = Math.sqrt(PHANTOM_USD * 55000) - PHANTOM_USD;

/// WHAT A POOL HAS TO HOLD ON THE SIDE WE CAN VALUE BEFORE ITS PRICE COUNTS.
///
/// A v3 pool answers slot0 whether or not anybody ever traded in it, and a
/// pool holding nothing answers with whatever tick it was initialised at. That
/// produced $3.4e40 for TSLAc here. A thousand dollars is not a deep market -
/// it is the line under which a number is not evidence of anything.
const PRICE_FLOOR_USD = 1000;

/// The price of one unit of `addr` in USD, or null with a reason.
///
/// PRICED AGAINST WHICHEVER SIDE IS REAL. USDC when there is a USDC pool with
/// money in it, WETH otherwise - and WETH itself is priced against USDC first,
/// so the second case is the first case with one extra multiplication.
async function priceOf(addr, dec, wethUsd) {
  const candidates = [];
  for (const [qname, quote, qdec] of [["USDC", USDC, 6], ["WETH", WETH, 18]]) {
    if (addr.toLowerCase() === quote.toLowerCase()) continue;
    if (qname === "WETH" && wethUsd === null) continue;
    for (const fee of TIERS) {
      const pool = await poolFor(addr, quote, fee);
      if (!pool) continue;
      const quoteHeld = await balanceOf(quote, pool);
      const quoteUsd = (Number(quoteHeld) / 10 ** qdec) * (qname === "USDC" ? 1 : wethUsd);
      if (quoteUsd < PRICE_FLOOR_USD) continue;
      candidates.push({ pool, quote, qdec, qname, fee, quoteUsd });
    }
  }
  if (!candidates.length) return { price: null, why: "no pool holding $" + PRICE_FLOOR_USD + "+ to price against" };

  // The deepest qualifying market on the side we can value.
  candidates.sort((a, b) => b.quoteUsd - a.quoteUsd);
  const best = candidates[0];

  const sqrt = await slot0Sqrt(best.pool);
  const t0 = (await token0Of(best.pool)).toLowerCase();
  const r = Number(sqrt) / Number(Q96);
  const raw1per0 = r * r;
  const assetIs0 = t0 === addr.toLowerCase();
  const perAsset = assetIs0
    ? raw1per0 * 10 ** (dec - best.qdec)
    : (1 / raw1per0) * 10 ** (dec - best.qdec);
  const price = perAsset * (best.qname === "USDC" ? 1 : wethUsd);
  return { price, why: best.qname + "/" + best.fee };
}

(async () => {
  // WETH FIRST, AND ON ITS OWN, because every asset whose only market is
  // against WETH is priced through it. A run that could not price WETH cannot
  // price those, and says so rather than quietly falling back to USDC-only.
  let wethUsd = null;
  {
    const r = await priceOf(WETH, 18, null);
    wethUsd = r.price;
    console.log(wethUsd === null
      ? "WARNING: WETH itself could not be priced - " + r.why + " - so WETH-quoted assets cannot be priced either."
      : "WETH = $" + wethUsd.toFixed(2) + " (" + r.why + "), used to price anything whose market is against WETH.");
    console.log("");
  }

  console.log("asset    price $     deepest pool holds   threshold ($10,832)   fills?  phantom ($4,000)  where");
  for (const [sym, addr, dec] of ASSETS) {
    // THE PRICE COMES FROM A USDC POOL. The DEPTH does not - it is the most of
    // this asset that sits in ANY pool, and a first version of this asked only
    // about USDC and was about to report that NVDAc could not fill a launch
    // while 154 of it sat in a WETH pool. "Can this be obtained" and "what is
    // it worth" are different questions and they have different sources.
    //
    // USDC IS LISTED SINCE 2026-10-15, so it is no longer skipped as "the
    // pricing asset": it is priced at 1 by construction (see ASSETS) and its
    // depth is read off its WETH pools like anything else's.
    const isUsdc = addr.toLowerCase() === USDC.toLowerCase();
    const p = isUsdc ? { price: 1, why: "USDC itself: 1 by construction, check it against USDC / USD" }
      : await priceOf(addr, dec, wethUsd);
    if (p.price === null) { console.log(`${sym.padEnd(8)} ${p.why}`); continue; }

    let deepest = 0n;
    let where = "-";
    for (const [qname, quote] of [["WETH", WETH], ["USDC", USDC]]) {
      if (quote.toLowerCase() === addr.toLowerCase()) continue; // no pool pairs an asset with itself
      for (const fee of TIERS) {
        const pool = await poolFor(addr, quote, fee);
        if (!pool) continue;
        const held = await balanceOf(addr, pool);
        if (held > deepest) { deepest = held; where = qname + "/" + fee; }
      }
    }
    const price = p.price;
    const heldUnits = Number(deepest) / 10 ** dec;
    const units = TARGET_USD / price;
    console.log(
      `${sym.padEnd(8)} ${price.toFixed(2).padStart(9)}   ${heldUnits.toFixed(2).padStart(18)}   ` +
      `${units.toFixed(2).padStart(19)}   ${heldUnits >= units ? "yes" : "NO "}  ` +
      `${(PHANTOM_USD / price).toFixed(4).padStart(16)}  ` +
      `(depth ${where}, price ${p.why})`
    );
  }
})();
