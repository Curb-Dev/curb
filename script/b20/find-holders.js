// A FUNDING SOURCE PER ASSET, found the way NVDAc's whale was found.
//
// Usage:  node script/b20/find-holders.js [rpc] [blocks-back]
//
// The fork tests fund a trader by IMPERSONATING A REAL HOLDER, because deal()
// writes storage slots and a B20 is a precompile with none to write. So each
// asset needs an address that actually holds enough of it.
//
// METHOD: scan Transfer logs over a recent window, collect every address that
// appears, ask each for its balance, and rank. The window is small because the
// upstream limits eth_getLogs to 2,000 blocks.
//
// WHAT IS DELIBERATELY EXCLUDED, and why it matters more than the ranking:
//   - the v4 PoolManager, whose balance IS pool accounting. The existing NVDAc
//     fixture already refuses it for that reason.
//   - every Uniswap v3 and Aerodrome pool found for that asset. Same reason:
//     draining one in a test corrupts the venue the ETH route prices against,
//     and a "holder" that is really a pool is not a holder.
// A source that is somebody else's accounting is not a source.
require(require("path").join(__dirname, "..", "..", "web", "keccak.js"));
const { keccak256 } = globalThis.CurbKeccak;

const RPC = process.argv[2] || process.env.RPC || "http://127.0.0.1:8549";
const BACK = Number(process.argv[3] || 1800);
/// Blocks per getLogs request. 1800 fits the upstream's 2,000-block limit for a
/// quiet token; a busy one (cbBTC) is refused as "backend response too large"
/// and needs a smaller page.
const PAGE = Number(process.env.PAGE || 1800);

const ASSETS = {
  SPCXc: "0xb2000000000000000000007b9fcbd005511acbd5",
  GOOGLc: "0xb2000000000000000000002d0ba3164cc74f58b7",
  AMZNc: "0xb200000000000000000000d9192b6b456483c2e8",
  MSFTc: "0xb200000000000000000000ab99cfa739e253872b",
  AAPLc: "0xb200000000000000000000c2e324d24d7eecd1fb",
  METAc: "0xb2000000000000000000008bc8786b856e61707c",
  // THE WRAPPED COINS DeployCurb added on 2026-09-23, which the fixture never
  // grew to cover. cbXRP is SIX decimals, the only one on the floor.
  cbBTC: "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf",
  cbXRP: "0xcb585250f852c6c6bf90434ab21a00f02833a4af",
  cbZEC: "0xb2000000000000000000008501b13360000cb2ec",
  // AND THE THREE ADDED ON 2026-10-15. These are not B20s - deal() could
  // write their balances - but the fixtures fund every asset the same way,
  // from a holder that really held it at the pinned block. USDC is busy
  // enough to want a small window (BACK=20 PAGE=10 ONLY=USDC). On that day
  // mainnet.base.org answered the node's getLogs with 429s and publicnode
  // refuses logs that old, so the three fixtures' holders were found the same
  // way by hand: the Transfer logs read from https://base.gateway.tenderly.co
  // (which serves them), every balance read off the pinned node.
  USDC: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  VIRTUAL: "0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b",
  AERO: "0x940181a94a35a4569e4529a3cdfb74e38fd98631",
};
/// The scale each asset's balance is written in. It was assumed to be eight
/// for everything, which was true while everything was an equity.
const DECIMALS = { cbXRP: 6, USDC: 6, VIRTUAL: 18, AERO: 18 };
const decimalsOf = (sym) => DECIMALS[sym] ?? 8;
/// What each one has to be able to fund: about three times its proposed
/// threshold, which covers filling the curve plus buys and sells on top.
/// Raw units at 8 decimals.
///
/// A FIRST VERSION OF THIS TABLE WAS A HUNDRED TIMES TOO LARGE - it asked for
/// 5,000 SPCXc against a threshold of 44 - and reported holders as SHORT that
/// hold fifty times what the fixture needs. The verdict a tool prints is only
/// as good as the number it compares against.
const NEED = { SPCXc: 150e8, GOOGLc: 150e8, AMZNc: 50e8, MSFTc: 25e8, AAPLc: 15e8, METAc: 12e8,
               // three thresholds each, at DeployCurb's own numbers (the
               // 2026-10-15 list)
               cbBTC: 0.396e8, cbXRP: 24_450e6, cbZEC: 27.6e8,
               USDC: 32_400e6, VIRTUAL: 48_300e18, AERO: 36_600e18 };

const POOL_MANAGER = "0x498581ff718922c3f8e6a244956af099b2652b2b";
const V3_FACTORY = "0x33128a8fc17869897dce68ed026d694621f6fdfd";
const AERO_V2 = "0x420dd381b31aef6683db6b902084cb0ffece40da";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const WETH = "0x4200000000000000000000000000000000000006";

const utf8Hex = (s) => Array.from(Buffer.from(s, "utf8")).map((b) => b.toString(16).padStart(2, "0")).join("");
const sig = (s) => keccak256("0x" + utf8Hex(s)).slice(0, 10);
const topic = (s) => keccak256("0x" + utf8Hex(s));
const padAddr = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const padNum = (n) => BigInt(n).toString(16).padStart(64, "0");
const TRANSFER = topic("Transfer(address,address,uint256)");
const S = { balanceOf: sig("balanceOf(address)"), getPool: sig("getPool(address,address,uint24)"),
            aeroPool: sig("getPool(address,address,bool)") };

let id = 0;
async function rpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
const call = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);
const addrOf = (h) => "0x" + (h || "").replace(/^0x/, "").slice(24, 64);
const num = (h) => {
  const w = (h || "").replace(/^0x/, "").slice(0, 64);
  return w.length === 64 ? BigInt("0x" + w) : 0n;
};
const human = (v, sym) => (Number(v) / 10 ** decimalsOf(sym)).toLocaleString("en-US", { maximumFractionDigits: 4 });

async function poolsOf(asset) {
  const out = new Set([POOL_MANAGER]);
  for (const pair of [USDC, WETH]) {
    for (const fee of [100, 500, 3000, 10000]) {
      try {
        const p = addrOf(await call(V3_FACTORY, S.getPool + padAddr(asset) + padAddr(pair) + padNum(fee)));
        if (!/^0x0{40}$/.test(p)) out.add(p.toLowerCase());
      } catch {}
    }
    for (const st of [1, 0]) {
      try {
        const p = addrOf(await call(AERO_V2, S.aeroPool + padAddr(asset) + padAddr(pair) + padNum(st)));
        if (!/^0x0{40}$/.test(p)) out.add(p.toLowerCase());
      } catch {}
    }
  }
  return out;
}

(async () => {
  const head = Number(await rpc("eth_blockNumber", []));
  console.log(`# rpc ${RPC}, head ${head}, scanning ${BACK} blocks back in ${PAGE}-block pages\n`);

  const only = (process.env.ONLY || "").split(",").filter(Boolean);
  for (const [sym, asset] of Object.entries(ASSETS)) {
    if (only.length && !only.includes(sym)) continue;
    const excluded = await poolsOf(asset);
    const seen = new Set();
    for (let to = head; to > head - BACK; to -= PAGE) {
      const from = Math.max(0, to - (PAGE - 1));
      let logs = [];
      try {
        logs = await rpc("eth_getLogs", [{
          address: asset, topics: [TRANSFER],
          fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16),
        }]);
      } catch (e) { console.log(`  (${sym}: getLogs refused - ${e.message})`); break; }
      for (const l of logs) {
        for (const t of (l.topics || []).slice(1, 3)) {
          const a = addrOf(t).toLowerCase();
          if (a !== "0x" + "0".repeat(40) && !excluded.has(a)) seen.add(a);
        }
      }
    }

    const ranked = [];
    for (const a of seen) {
      try {
        const b = num(await call(asset, S.balanceOf + padAddr(a)));
        if (b > 0n) ranked.push([a, b]);
      } catch {}
    }
    ranked.sort((x, y) => (y[1] > x[1] ? 1 : y[1] < x[1] ? -1 : 0));

    const need = BigInt(Math.round(NEED[sym]));
    console.log(`${sym}  ${asset}`);
    console.log(`  needs ${human(need, sym)}; ${seen.size} candidate addresses, ${ranked.length} with a balance`);
    if (!ranked.length) { console.log("  NO HOLDER FOUND in this window\n"); continue; }
    for (const [a, b] of ranked.slice(0, 3)) {
      console.log(`  ${a}  ${human(b, sym)} ${sym}${b >= need ? "   <= ENOUGH" : ""}`);
    }
    if (ranked[0][1] < need) console.log(`  BIGGEST IS SHORT of ${human(need, sym)}`);
    console.log("");
  }
})().catch((e) => { console.error("FAILED: " + e.message); process.exit(1); });
