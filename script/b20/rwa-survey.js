// WHAT EXISTS ON BASE, ASKED OF THE CHAIN RATHER THAN OF A LIST.
//
// Usage:  node script/b20/rwa-survey.js [candidates.json]   (RPC=... to point it)
//         node script/b20/rwa-survey.js --site              the assets the site lists
//         BLOCK=<n> to read block n instead of the head; the whole run reads one block
//
// --site asks every factory in web/config.js for its quoteToken() and surveys
// those, so the list is the one the create form offers and not a copy of it.
//
// THERE IS NO WAY TO ENUMERATE B20. base-std's IB20Factory declares exactly
// createB20, getB20Address, isB20 and isB20Initialized - no count, no index,
// no array - and a B20 address is 0xb2, ten zero bytes, then nine bytes that
// cannot be walked. So candidates come from outside and the CHAIN decides.
//
// For each address this asks: isB20() and isB20Initialized() at the factory
// precompile, then symbol/name/decimals/totalSupply, then the three transfer
// policy scopes and what the PolicyRegistry says about each id, then every
// pool at Uniswap v3, Aerodrome v2 and each of Aerodrome's three CL factories
// against both WETH and USDC, with the balances read off the pool.
//
// AERODROME HAS THREE CL FACTORIES, AND ALL THREE ARE LIVE. Slipstream was
// deployed three times - the first, "Gauge Caps" and "Gauges V3", each with a
// PoolFactory of its own (the aerodrome-finance/slipstream README) - and
// Aerodrome's FactoryRegistry approves all three beside v2: poolFactories(),
// read at block 52756903 (18 October 2026), and each answered getPool for
// WETH/USDC there. Until then this asked the first one alone, at five of its six
// tick spacings, while the tokenized stocks' liquidity is in the newest: an
// asset could read as thin here and be deep there. So each CL
// factory is asked at its own tickSpacings(), and every run compares the
// registry's list with the factories asked and names any it does not ask.
//
// A CANDIDATE LIST'S LABEL IS NEVER THE EVIDENCE. The symbol is read from the
// asset; the list's own is carried only so a mismatch can be reported.
//
// CONTROL FIRST, ALWAYS. isB20() was control-tested against two known B20s
// (true) and WETH, USDC and an address with no code (false). Every venue
// factory is control-tested against WETH/USDC on every run, before any
// candidate is asked, and the run stops if one finds no pool (control()).
// Without that, a null result from a wrong address is indistinguishable from
// a null result from an empty chain.
//
// WHAT IT STILL CANNOT SAY: that a run is complete. An asset in none of the
// sources is absent from the output, and nothing on chain would reveal it.
// The result is a floor on what exists, not a ceiling.
require(require("path").join(__dirname, "..", "..", "web", "keccak.js"));
const { keccak256 } = globalThis.CurbKeccak;
const fs = require("fs");
const path = require("path");

const RPC = process.env.RPC || "http://127.0.0.1:8555";
const B20_FACTORY = "0xB20f000000000000000000000000000000000000";
const POLICY_REGISTRY = "0x8453000000000000000000000000000000000002";
const V3_FACTORY = "0x33128a8fc17869897dce68ed026d694621f6fdfd";
const AERO_V2 = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";
/// Aerodrome's FactoryRegistry: the pool factories its Voter accepts.
const AERO_REGISTRY = "0x5C3F18F06CC09CA1910767A34a20F771039E37C0";
/// Aerodrome's Slipstream PoolFactories, oldest first, with the label each
/// pool found there carries.
const AERO_CL = [
  ["aero-cl", "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A"],      // first deployment
  ["aero-cl-caps", "0xaDe65c38CD4849aDBA595a4323a8C7DdfE89716a"], // Gauge Caps
  ["aero-cl-v3", "0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef"],   // Gauges V3, the current one
];
const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAIRS = [["WETH", WETH, 18], ["USDC", USDC, 6]];
const V3_FEES = [100, 500, 3000, 10000];

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
  tickSpacings: sig("tickSpacings()"), poolFactories: sig("poolFactories()"),
  quoteToken: sig("quoteToken()"),
};

let id = 0;
/// ONE BLOCK FOR THE WHOLE RUN. A run is a thousand calls over minutes; read at
/// "latest", each would answer at a different block, and a figure quoted "at
/// block N" would be no block's state. main() reads the head once (or takes
/// BLOCK=<n>) and every call below asks at it.
let BLOCK = null;
/// A PUBLIC ENDPOINT THAT SAYS "TOO MANY" IS ASKED AGAIN, after a pause - as
/// HTTP 429 or as a JSON-RPC error - so a refusal to answer is not read as "no
/// pool"; any other failure is the answer.
async function rpc(method, params) {
  for (let tries = 0; ; tries++) {
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    const j = r.status === 429 ? null : await r.json();
    const busy = !j || (j.error && (j.error.code === -32005 || /rate limit|too many/i.test(j.error.message || "")));
    if (busy && tries < 8) { await new Promise((ok) => setTimeout(ok, 1000 * (tries + 1))); continue; }
    return j || { error: { message: "HTTP 429, still, after 8 retries" } };
  }
}
async function call(to, data) {
  if (BLOCK === null) throw new Error("no block pinned before the first call");
  const j = await rpc("eth_call", [{ to, data }, BLOCK]);
  return j.error ? { err: j.error.message } : { ok: j.result };
}
const num = (h) => {
  const w = (h || "").replace(/^0x/, "").slice(0, 64);
  return w.length === 64 ? BigInt("0x" + w) : null;
};
const okNum = (r) => (r.ok ? num(r.ok) : null);
const addrOf = (h) => "0x" + h.replace(/^0x/, "").slice(24, 64);
/// THE POOL A getPool() ANSWER NAMES, or null. Only one full word holding a
/// non-zero address counts: an address with no code answers "0x", which
/// addrOf() turns into "0x" - not the zero address, so it once read as a pool.
const poolOf = (r) => {
  const m = r.ok && /^0x0{24}([0-9a-fA-F]{40})$/.exec(r.ok);
  return m && !/^0{40}$/.test(m[1]) ? "0x" + m[1].toLowerCase() : null;
};
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
/// The words of an ABI-encoded int24[] or address[] return.
const arrayWords = (h) => {
  const w = (h || "").replace(/^0x/, "").match(/.{64}/g) || [];
  if (w.length < 2) return null;
  const n = Number(BigInt("0x" + w[1]));
  return w.length >= 2 + n ? w.slice(2, 2 + n) : null;
};

/// Every pool address to ask for one asset against one pair, as
/// [label, factory, calldata].
function venuesFor(a, pair, pairName, ticks) {
  const v = [];
  for (const fee of V3_FEES) v.push([`uni-v3 ${pairName}/${fee / 10000}%`, V3_FACTORY, S.v3Pool + padAddr(a) + padAddr(pair) + pad(fee)]);
  for (const st of [1, 0]) v.push([`aero-v2 ${pairName}/${st ? "stable" : "vol"}`, AERO_V2, S.aeroV2 + padAddr(a) + padAddr(pair) + pad(st)]);
  for (const [name, f] of AERO_CL) {
    for (const t of ticks.get(f)) v.push([`${name} ${pairName}/t${t}`, f, S.aeroCl + padAddr(a) + padAddr(pair) + pad(t)]);
  }
  return v;
}

/// THE CONTROL. Each CL factory's tick spacings are read from it, then every
/// venue factory must find at least one WETH/USDC pool. One that finds none
/// stops the run: its "no pool" for every candidate would mean nothing.
/// Returns the tick spacings, by factory.
async function control() {
  const ticks = new Map();
  for (const [name, f] of AERO_CL) {
    const r = await call(f, S.tickSpacings);
    const w = r.ok ? arrayWords(r.ok) : null;
    if (!w || !w.length) throw new Error(`control: ${name} ${f} answered no tickSpacings() (${r.err || r.ok})`);
    ticks.set(f, w.map((x) => Number(BigInt.asIntN(24, BigInt("0x" + x)))));
  }
  const found = new Map();
  for (const [, to, data] of venuesFor(WETH, USDC, "USDC", ticks)) {
    const hit = poolOf(await call(to, data)) ? 1 : 0;
    found.set(to, (found.get(to) || 0) + hit);
  }
  const named = [["uni-v3", V3_FACTORY], ["aero-v2", AERO_V2], ...AERO_CL];
  for (const [name, f] of named) {
    if (!found.get(f)) throw new Error(`control: ${name} ${f} found no WETH/USDC pool`);
  }
  console.log("# control, WETH/USDC pools found: " +
    named.map(([name, f]) => `${name} ${found.get(f)}`).join(", "));
  for (const [name, f] of AERO_CL) console.log(`# ${name} ${f} tick spacings: ${ticks.get(f).join(", ")}`);

  // WHAT AERODROME ITSELF LISTS. A factory it approves that is not asked here
  // is a venue this run cannot see, so it is named rather than missed.
  const reg = await call(AERO_REGISTRY, S.poolFactories);
  const listed = reg.ok ? arrayWords(reg.ok) : null;
  if (!listed) {
    console.log(`# Aerodrome's FactoryRegistry did not answer poolFactories(): ${reg.err || reg.ok}`);
  } else {
    const asked = new Set([AERO_V2, ...AERO_CL.map(([, f]) => f)].map((x) => x.toLowerCase()));
    const all = listed.map((x) => addrOf(x).toLowerCase());
    const missed = all.filter((x) => !asked.has(x));
    const unlisted = [...asked].filter((x) => !all.includes(x));
    console.log(`# Aerodrome's FactoryRegistry approves ${all.length} pool factories; ` +
      (missed.length ? `NOT ASKED HERE: ${missed.join(", ")}` : "every one is asked here"));
    if (unlisted.length) console.log(`# asked here but no longer approved: ${unlisted.join(", ")}`);
  }
  return ticks;
}

/// THE SITE'S ASSETS: whatever every factory in web/config.js prices against,
/// asked of the factory. The comment after each address is carried as the
/// list's label, so a factory pricing against something else is reported.
async function siteCandidates() {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "web", "config.js"), "utf8");
  const ctx = { window: {} };
  require("vm").runInNewContext(src, ctx);
  const out = [];
  for (const f of ctx.window.CURB_SITE.factories) {
    const q = await call(f, S.quoteToken);
    if (!q.ok || num(q.ok) === null) throw new Error(`factory ${f} answered no quoteToken() (${q.err || q.ok})`);
    const label = src.match(new RegExp('"' + f + '",\\s*//\\s*(\\S+)'));
    out.push({ address: addrOf(q.ok), symbol: label ? label[1] : "" });
  }
  return out;
}

async function main() {
  // THE BLOCK, before the first call: --site's own quoteToken() reads too.
  if (process.env.BLOCK) {
    BLOCK = "0x" + BigInt(process.env.BLOCK).toString(16);
  } else {
    const bn = await rpc("eth_blockNumber", []);
    if (bn.error || !/^0x[0-9a-fA-F]+$/.test(bn.result || "")) {
      throw new Error(`eth_blockNumber gave no block (${JSON.stringify(bn.error || bn.result)})`);
    }
    BLOCK = bn.result;
  }
  console.log(`# block: ${Number(BigInt(BLOCK))} (every call below reads this block)`);

  // CANDIDATES. Any address is accepted: a pairing asset that is NOT a B20 -
  // six of the eight "cb" wrapped assets are plain ERC-20s - still has to be
  // measured rather than dropped for failing a shape test.
  const site = process.argv[2] === "--site";
  const list = site ? await siteCandidates() : JSON.parse(fs.readFileSync(
    process.argv[2] || path.join(__dirname, "rwa-candidates.json"), "utf8")).tokens || [];
  const byAddr = new Map();
  for (const t of list) {
    const a = (t.address || "").toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(a)) byAddr.set(a, t.symbol || "");
  }
  const cands = [...byAddr.keys()].sort();
  console.log(`# candidates from ${site ? "web/config.js's factories" : "the token list"}: ${cands.length}`);
  const ticks = await control();
  console.log("");

  const rows = [];
  // A getPool() THAT FAILED IS NOT "NO POOL", so each one is named at the end.
  const unanswered = [];
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
      // An asset against itself (WETH, USDC) has no pool to find.
      if (a === pair.toLowerCase()) continue;
      for (const [label, to, data] of venuesFor(a, pair, pairName, ticks)) {
        const p = await call(to, data);
        if (p.err) unanswered.push(`${r.sym || a} ${label}`);
        const pool = poolOf(p);
        if (!pool) continue;
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
        console.log(`  ${p.label.padEnd(24)} ${p.pool}`);
        console.log(`  ${" ".repeat(24)} ${human(p.asset, r.dec)} ${r.sym} / ${human(p.pair, p.pairDec)} ${p.pairName}`);
      }
    }
    console.log("");
  }
  console.log(`# verified: ${rows.length} of ${cands.length} candidates`);
  console.log(`# getPool calls that failed: ${unanswered.length ? unanswered.join(", ") : "none"}`);
}

main().catch((e) => { console.error("FAILED: " + e.message); process.exit(1); });
