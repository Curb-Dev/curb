// WHAT EXISTS ON BASE, ASKED OF THE CHAIN RATHER THAN OF A LIST.
//
// Usage:  node script/b20/rwa-survey.js [candidates.json]   (RPC=... to point it)
//
// THERE IS NO WAY TO ENUMERATE B20. base-std's IB20Factory declares exactly
// createB20, getB20Address, isB20 and isB20Initialized - no count, no index,
// no array - and a B20 address is 0xb2, ten zero bytes, then nine bytes that
// cannot be walked. So candidates come from outside and the CHAIN decides.
//
// For each address this asks: isB20() and isB20Initialized() at the factory
// precompile, then symbol/name/decimals/totalSupply, then the three transfer
// policy scopes and what the PolicyRegistry says about each id, then every
// pool at Uniswap v3, Aerodrome v2 and Aerodrome CL against both WETH and
// USDC, with the balances read off the pool.
//
// A CANDIDATE LIST'S LABEL IS NEVER THE EVIDENCE. The symbol is read from the
// asset; the list's own is carried only so a mismatch can be reported.
//
// CONTROL FIRST, ALWAYS. isB20() was control-tested against two known B20s
// (true) and WETH, USDC and an address with no code (false); the three venue
// factories against WETH/USDC. Without that, a null result from a wrong
// address is indistinguishable from a null result from an empty chain.
//
// WHAT IT STILL CANNOT SAY: that a run is complete. An asset in none of the
// sources is absent from the output, and nothing on chain would reveal it.
// The result is a floor on what exists, not a ceiling.
require(require("path").join(__dirname, "..", "..", "web", "keccak.js"));
const { keccak256 } = globalThis.CurbKeccak;
const fs = require("fs");

const RPC = process.env.RPC || "http://127.0.0.1:8555";
const B20_FACTORY = "0xB20f000000000000000000000000000000000000";
const POLICY_REGISTRY = "0x8453000000000000000000000000000000000002";
const V3_FACTORY = "0x33128a8fc17869897dce68ed026d694621f6fdfd";
const AERO_V2 = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";
const AERO_CL = "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A";
const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAIRS = [["WETH", WETH, 18], ["USDC", USDC, 6]];
const V3_FEES = [100, 500, 3000, 10000];
const AERO_TICKS = [1, 50, 100, 200, 2000];

const utf8Hex = (s) => Array.from(Buffer.from(s, "utf8")).map((b) => b.toString(16).padStart(2, "0")).join("");
const sig = (s) => keccak256("0x" + utf8Hex(s)).slice(0, 10);
const pad = (x) => BigInt(x).toString(16).padStart(64, "0");
const padAddr = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

const S = {
  isB20: sig("isB20(address)"), isInit: sig("isB20Initialized(address)"),
  name: sig("name()"), symbol: sig("symbol()"), decimals: sig("decimals()"),
  totalSupply: sig("totalSupply()"), balanceOf: sig("balanceOf(address)"),
  sender: sig("TRANSFER_SENDER_POLICY()"), receiver: sig("TRANSFER_RECEIVER_POLICY()"),
  executor: sig("TRANSFER_EXECUTOR_POLICY()"), policyId: sig("policyId(bytes32)"),
  policyExists: sig("policyExists(uint64)"), policyAdmin: sig("policyAdmin(uint64)"),
  v3Pool: sig("getPool(address,address,uint24)"),
  aeroV2: sig("getPool(address,address,bool)"),
  aeroCl: sig("getPool(address,address,int24)"),
};

let id = 0;
async function call(to, data) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "eth_call", params: [{ to, data }, "latest"] }) });
  const j = await r.json();
  return j.error ? { err: j.error.message } : { ok: j.result };
}
const num = (h) => {
  const w = (h || "").replace(/^0x/, "").slice(0, 64);
  return w.length === 64 ? BigInt("0x" + w) : null;
};
const okNum = (r) => (r.ok ? num(r.ok) : null);
const addrOf = (h) => "0x" + h.replace(/^0x/, "").slice(24, 64);
const isTrue = (r) => { const n = okNum(r); return n !== null && n === 1n; };
function decodeString(hex) {
  const h = hex.replace(/^0x/, "");
  if (h.length < 128) return "";
  const len = Number(BigInt("0x" + h.slice(64, 128)));
  return Buffer.from(h.slice(128, 128 + len * 2), "hex").toString("utf8");
}
/// Units to a readable figure. Kept at 4 places with the raw figure carried
/// alongside, because a rounded number is not something anyone can check.
const human = (v, d) => {
  if (v === null || d === null) return "no answer";
  const b = 10n ** BigInt(d);
  return (Number(v / b) + Number(v % b) / Number(b)).toLocaleString("en-US",
    { maximumFractionDigits: 4 });
};

async function main() {
  // CANDIDATES. Any address is accepted: a pairing asset that is NOT a B20 -
  // six of the eight "cb" wrapped assets are plain ERC-20s - still has to be
  // measured rather than dropped for failing a shape test.
  const raw = fs.readFileSync(
    process.argv[2] || require("path").join(__dirname, "rwa-candidates.json"), "utf8");
  const list = JSON.parse(raw).tokens || [];
  const byAddr = new Map();
  for (const t of list) {
    const a = (t.address || "").toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(a)) byAddr.set(a, t.symbol || "");
  }
  const cands = [...byAddr.keys()].sort();
  console.log(`# candidates from the token list: ${cands.length}`);
  const bn = await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "eth_blockNumber", params: [] }) })).json();
  console.log(`# fork block: ${Number(bn.result)}\n`);

  const rows = [];
  for (const a of cands) {
    const real = await call(B20_FACTORY, S.isB20 + padAddr(a));
    const init = await call(B20_FACTORY, S.isInit + padAddr(a));
    const b20 = isTrue(real);

    const sym = await call(a, S.symbol);
    const nm = await call(a, S.name);
    const dec = await call(a, S.decimals);
    const sup = await call(a, S.totalSupply);
    const r = {
      addr: a, listSym: byAddr.get(a),
      sym: sym.ok ? decodeString(sym.ok) : "?", name: nm.ok ? decodeString(nm.ok) : "?",
      dec: okNum(dec) === null ? null : Number(okNum(dec)),
      supply: okNum(sup),
      b20, init: isTrue(init), pools: [], policy: {},
    };

    for (const [what, s] of [["sender", S.sender], ["receiver", S.receiver], ["executor", S.executor]]) {
      const scope = await call(a, s);
      if (!scope.ok) { r.policy[what] = "no answer"; continue; }
      const pid = await call(a, S.policyId + scope.ok.replace(/^0x/, ""));
      if (!pid.ok) { r.policy[what] = "no answer"; continue; }
      const n = okNum(pid);
      if (n === null) { r.policy[what] = "no answer"; continue; }
      let admin = "";
      if (n !== 0n) {
        const ad = await call(POLICY_REGISTRY, S.policyAdmin + pad(n));
        const ex = await call(POLICY_REGISTRY, S.policyExists + pad(n));
        admin = `${isTrue(ex) ? "" : " (NOT REGISTERED)"} ${ad.ok ? addrOf(ad.ok) : "?"}`;
      }
      r.policy[what] = `${n}${admin}`;
    }

    for (const [pairName, pair, pairDec] of PAIRS) {
      const venues = [];
      for (const fee of V3_FEES) venues.push([`uni-v3 ${pairName}/${fee / 10000}%`, V3_FACTORY, S.v3Pool + padAddr(a) + padAddr(pair) + pad(fee)]);
      for (const st of [1, 0]) venues.push([`aero-v2 ${pairName}/${st ? "stable" : "vol"}`, AERO_V2, S.aeroV2 + padAddr(a) + padAddr(pair) + pad(st)]);
      for (const t of AERO_TICKS) venues.push([`aero-cl ${pairName}/t${t}`, AERO_CL, S.aeroCl + padAddr(a) + padAddr(pair) + pad(t)]);
      for (const [label, to, data] of venues) {
        const p = await call(to, data);
        if (!p.ok) continue;
        const pool = addrOf(p.ok);
        if (/^0x0{40}$/.test(pool)) continue;
        const ba = await call(a, S.balanceOf + padAddr(pool));
        const bp = await call(pair, S.balanceOf + padAddr(pool));
        if (!ba.ok || !bp.ok) continue;
        const av = num(ba.ok), pv = num(bp.ok);
        if (av === null || pv === null) continue;
        r.pools.push({ label, pool, asset: av, pair: pv, pairName, pairDec });
      }
    }
    rows.push(r);
    console.log(`OK  ${r.sym.padEnd(8)} ${a}  dec=${r.dec}  pools=${r.pools.length}`);
  }

  console.log("\n\n================================ VERIFIED B20 ASSETS ================================\n");
  rows.sort((x, y) => x.sym.localeCompare(y.sym));
  for (const r of rows) {
    console.log(`${r.sym}   ${r.name}`);
    console.log(`  address      ${r.addr}`);
    console.log(`  isB20        ${r.b20}, initialized=${r.init}`);
    console.log(`  decimals     ${r.dec}`);
    console.log(`  totalSupply  ${r.supply} raw  = ${human(r.supply, r.dec)}`);
    if (r.listSym && r.listSym !== r.sym) console.log(`  NOTE         token list called it "${r.listSym}"`);
    console.log(`  policy       sender=${r.policy.sender}  receiver=${r.policy.receiver}  executor=${r.policy.executor}`);
    if (!r.pools.length) { console.log("  liquidity    NO POOL FOUND at any venue asked"); }
    else {
      // Biggest first, by what the pool holds of the PAIR - the side a person
      // arrives with. This is custody, an upper bound, not depth.
      r.pools.sort((p, q) => Number(q.pair * 10n ** BigInt(18 - q.pairDec) - p.pair * 10n ** BigInt(18 - p.pairDec)));
      for (const p of r.pools) {
        console.log(`  ${p.label.padEnd(22)} ${p.pool}`);
        console.log(`  ${" ".repeat(22)} ${human(p.asset, r.dec)} ${r.sym} / ${human(p.pair, p.pairDec)} ${p.pairName}`);
      }
    }
    console.log("");
  }
  console.log(`# verified: ${rows.length} of ${cands.length} candidates`);
}

main().catch((e) => { console.error("FAILED: " + e.message); process.exit(1); });
