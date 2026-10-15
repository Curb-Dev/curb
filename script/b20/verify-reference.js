// THEIR CLAIMS, ASKED OF BASE MAINNET. Read-only: eth_call and eth_getCode
// only. Their pages say "no bonding curve, the whole supply is one
// single-sided Uniswap V3 position on the 1% tier, locked forever". This
// project's own rule is that reading more prose is not verification.
require(require("path").join(__dirname, "..", "..", "web", "keccak.js"));
const { keccak256 } = globalThis.CurbKeccak;
const RPC = process.env.MAINNET_RPC || "https://mainnet.base.org";
const utf8Hex = (s) => Array.from(Buffer.from(s, "utf8")).map((b) => b.toString(16).padStart(2, "0")).join("");
const sig = (s) => keccak256("0x" + utf8Hex(s)).slice(0, 10);
const padAddr = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const padNum = (n) => BigInt(n).toString(16).padStart(64, "0");

const STONKEX = "0x5ab000ff9B9FfE0349CE5ffA5fD86f217C3680F5";
const V3_FACTORY = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD";
const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const STOCKS = {
  NVDAc: "0xb20000000000000000000078ee7ce2fE4908108C",
  AAPLc: "0xb200000000000000000000C2e324d24d7eEcd1fb",
  GOOGLc: "0xb2000000000000000000002D0BA3164cc74f58B7",
  METAc: "0xb2000000000000000000008bC8786B856E61707C",
  TSLAc: "0xb2000000000000000000001e800a7f5189430cd0",
  COINc: "0xb200000000000000000000c85a31389d71f3ecfb",
};
const S = { symbol: sig("symbol()"), decimals: sig("decimals()"), totalSupply: sig("totalSupply()"),
            balanceOf: sig("balanceOf(address)"), getPool: sig("getPool(address,address,uint24)"),
            liquidity: sig("liquidity()") };

let id = 0;
async function rpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(to, data) {
  for (let i = 0; i < 4; i++) {
    try { const r = await rpc("eth_call", [{ to, data }, "latest"]); await sleep(220); return r; }
    catch (e) {
      if (!/rate limit/i.test(e.message) || i === 3) throw e;
      await sleep(1500 * (i + 1));
    }
  }
}
const addrOf = (h) => "0x" + (h || "").replace(/^0x/, "").slice(24, 64);
const num = (h) => { const w = (h || "").replace(/^0x/, "").slice(0, 64); return w.length === 64 ? BigInt("0x" + w) : null; };
function str(raw) {
  const h = (raw || "").replace(/^0x/, "");
  if (h.length < 128) return "";
  const len = Number(BigInt("0x" + h.slice(64, 128)));
  return Buffer.from(h.slice(128, 128 + len * 2), "hex").toString("utf8");
}
const human = (v, d) => { const b = 10n ** BigInt(d); return (Number(v / b) + Number(v % b) / Number(b)).toLocaleString("en-US", { maximumFractionDigits: 2 }); };

(async () => {
  console.log("# " + RPC + ", block " + Number(await rpc("eth_blockNumber", [])) + "\n");
  const dec = Number(num(await call(STONKEX, S.decimals)));
  console.log(`$STONKEX ${STONKEX}`);
  console.log(`  symbol      ${JSON.stringify(str(await call(STONKEX, S.symbol)))}`);
  console.log(`  decimals    ${dec}`);
  console.log(`  totalSupply ${human(num(await call(STONKEX, S.totalSupply)), dec)}\n`);

  // THE CLAIM UNDER TEST: a coin of theirs is paired with a STOCK on v3, at
  // the 1% tier, and the position is single-sided at the start.
  const tiers = [100, 500, 3000, 10000];
  for (const [sym, stock] of Object.entries({ ...STOCKS, WETH, USDC })) {
    for (const fee of tiers) {
      const pool = addrOf(await call(V3_FACTORY, S.getPool + padAddr(STONKEX) + padAddr(stock) + padNum(fee)));
      if (/^0x0{40}$/.test(pool)) continue;
      const a = num(await call(STONKEX, S.balanceOf + padAddr(pool)));
      const b = num(await call(stock, S.balanceOf + padAddr(pool)));
      const sd = Number(num(await call(stock, S.decimals)));
      console.log(`  v3 ${sym}/${fee / 10000}%  ${pool}`);
      console.log(`     holds ${human(a, dec)} STONKEX / ${human(b, sd)} ${sym}`);
    }
  }
})().catch((e) => { console.error("FAILED: " + e.message); process.exit(1); });
