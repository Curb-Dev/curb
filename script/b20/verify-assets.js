// WHAT A DEPLOYMENT ACTUALLY STOOD UP, read back off the chain.
//
// Usage:  node script/b20/verify-assets.js <registry> [rpc]
//
// THE MAINNET READ-BACK IS script/b20/check-deployment.sh, which checks all of
// this - the shape, the escrows, one factory per asset, one recipient - and
// every owner, role and term besides, against the run record, the list in
// DeployCurb.quoteAssets() and the variables the preflight took. This stays
// for a quick look at any registry, with no record at hand.
//
// The deploy script's own require()s run before anything is registered, which
// is where they belong - but they check what that transaction believed. This
// reads the finished state instead: every launcher the registry admits, the
// asset each one prices against, the threshold each one will write into a
// launch, and whether the escrow behind it will accept that asset at all.
//
// THE ESCROW CHECK IS THE ONE WORTH HAVING. An escrow built for another token
// refuses every credit its factory's launches ever make, and the failure would
// arrive at the first fee sweep - months later, with money already taken.
require(require("path").join(__dirname, "..", "..", "web", "keccak.js"));
const { keccak256 } = globalThis.CurbKeccak;

const REGISTRY = process.argv[2];
const RPC = process.argv[3] || process.env.RPC || "http://127.0.0.1:8546";
if (!/^0x[0-9a-fA-F]{40}$/.test(REGISTRY || "")) {
  console.error("usage: node script/b20/verify-assets.js <registry address> [rpc]");
  process.exit(2);
}

const utf8Hex = (s) => Array.from(Buffer.from(s, "utf8")).map((b) => b.toString(16).padStart(2, "0")).join("");
const sig = (s) => keccak256("0x" + utf8Hex(s)).slice(0, 10);
const padAddr = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const padNum = (n) => BigInt(n).toString(16).padStart(64, "0");

const S = {
  launcherCount: sig("launcherCount()"), launcherAt: sig("launcherAt(uint256)"),
  isLauncher: sig("isLauncher(address)"), requiredHook: sig("requiredHook()"),
  launcher: sig("launcher()"),
  quoteToken: sig("quoteToken()"), graduationThreshold: sig("graduationThreshold()"),
  phantomQuote: sig("phantomQuote()"), poolFee: sig("poolFee()"), tickSpacing: sig("tickSpacing()"),
  feeEscrow: sig("feeEscrow()"), protocolFeeRecipient: sig("protocolFeeRecipient()"),
  symbol: sig("symbol()"), decimals: sig("decimals()"),
};

let id = 0;
async function call(to, data) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "eth_call", params: [{ to, data }, "latest"] }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const num = (h) => {
  const w = (h || "").replace(/^0x/, "").slice(0, 64);
  if (w.length !== 64) throw new Error("no answer");
  return BigInt("0x" + w);
};
const addrOf = (h) => "0x" + h.replace(/^0x/, "").slice(24, 64);
function str(raw) {
  const h = (raw || "").replace(/^0x/, "");
  if (h.length < 128) return "";
  const len = Number(BigInt("0x" + h.slice(64, 128)));
  return Buffer.from(h.slice(128, 128 + len * 2), "hex").toString("utf8");
}
const human = (v, d) => {
  const b = 10n ** BigInt(d);
  return (Number(v / b) + Number(v % b) / Number(b)).toLocaleString("en-US", { maximumFractionDigits: 4 });
};

let failures = 0;
function check(ok, what) {
  if (!ok) { failures++; console.log("    FAIL  " + what); }
}

(async () => {
  const n = Number(num(await call(REGISTRY, S.launcherCount)));
  const hook = addrOf(await call(REGISTRY, S.requiredHook));
  const first = addrOf(await call(REGISTRY, S.launcher));
  console.log(`registry   ${REGISTRY}`);
  console.log(`hook       ${hook}`);
  console.log(`launchers  ${n}\n`);

  const seenAssets = new Set();
  let recipient = null;
  for (let i = 0; i < n; i++) {
    const f = addrOf(await call(REGISTRY, S.launcherAt + padNum(i)));
    const quote = addrOf(await call(f, S.quoteToken));
    const sym = str(await call(quote, S.symbol));
    const dec = Number(num(await call(quote, S.decimals)));
    const thr = num(await call(f, S.graduationThreshold));
    const ph = num(await call(f, S.phantomQuote));
    const escrow = addrOf(await call(f, S.feeEscrow));
    const escrowAsset = addrOf(await call(escrow, S.quoteToken));
    const who = addrOf(await call(f, S.protocolFeeRecipient));

    console.log(`[${i}] ${sym.padEnd(8)} ${f}`);
    console.log(`     asset      ${quote}  (${dec} decimals)`);
    console.log(`     threshold  ${thr} raw = ${human(thr, dec)} ${sym}`);
    console.log(`     escrow     ${escrow}`);

    check(BigInt(await call(REGISTRY, S.isLauncher + padAddr(f))) === 1n, `${sym}: the registry does not list its own launcher`);
    check(escrowAsset.toLowerCase() === quote.toLowerCase(),
      `${sym}: the escrow is for ${escrowAsset}, not this factory's asset`);
    // THE DECIDED SHAPE (2026-10-03): START ABOUT $4K, GRADUATE ABOUT $55K.
    // The start market cap is the phantom and the graduation one is
    // (phantom + threshold)^2 / phantom, so their ratio - ((ph + thr) / ph)^2
    // - is the shape with the dollar unit cancelled: 55 / 4 = 13.75. Every
    // shipped pair lands within 0.5% of it; the band is 2.5% each way, so a
    // pair from the old r = 0.5 (ratio 4) or a typo in either figure fails.
    // Only the size is per asset.
    check(ph > 0n, `${sym}: the phantom is zero`);
    const shape = ph > 0n ? ((ph + thr) * (ph + thr) * 10000n) / (ph * ph) : 0n;
    console.log(`     phantom    ${ph} raw = ${human(ph, dec)} ${sym}  (graduation / start = ${Number(shape) / 10000})`);
    check(shape >= 134062n && shape <= 140937n,
      `${sym}: phantom ${ph} and threshold ${thr} graduate at ${Number(shape) / 10000} times the start, not about 13.75 ($4K to $55K)`);
    check(thr > 0n, `${sym}: the threshold is zero`);
    check(!seenAssets.has(quote.toLowerCase()), `${sym}: a second factory on the same asset`);
    seenAssets.add(quote.toLowerCase());
    // ONE RECIPIENT ACROSS ALL OF THEM. A6 is one decision, not one per asset.
    if (recipient === null) recipient = who;
    check(who.toLowerCase() === recipient.toLowerCase(), `${sym}: pays a different platform recipient`);
    console.log("");
  }

  check(first.toLowerCase() === addrOf(await call(REGISTRY, S.launcherAt + padNum(0))).toLowerCase(),
    "launcher() is not the launcher at index 0");

  console.log(failures === 0
    ? `OK  ${n} assets, one registry, one hook, one recipient, every escrow matched.`
    : `${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error("FAILED: " + e.message); process.exit(1); });
