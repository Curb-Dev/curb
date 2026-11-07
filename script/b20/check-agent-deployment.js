#!/usr/bin/env node
// WHAT web/agents/deployment.json TELLS AI AGENTS, CHECKED AGAINST BASE.
//
//   node script/b20/check-agent-deployment.js [rpc] [--file path]
//
// Read-only: eth_call and eth_getCode on any Base endpoint (default
// https://mainnet.base.org, public and keyless). Nothing is signed or sent.
// Run it once before the file is published, and after any change to it.
//
// It checks, for the file:
//   - the lens's registry and graduator, and the graduator's sharing catalog,
//     are the ones the file names, and every contract it names has code;
//   - the registry's launchers are exactly the assets' factories;
//   - each factory's registry, graduator, hook, quote asset, supply, tax band
//     and graduation threshold are the file's;
//   - each asset's decimals() and symbol() are the file's, and its threshold
//     in whole units is its raw threshold placed by those decimals;
//   - each dollar feed's description() and decimals() are the file's, and its
//     answer is above zero;
//   - $CURB is a launch the lens knows.
// It exits 1 and names each mismatch.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

global.window = global.window || global;
require(path.join(__dirname, "..", "..", "web", "keccak.js"));
const utf8Hex = (s) => Buffer.from(s, "utf8").toString("hex");
const sel = (s) => window.CurbKeccak.keccak256("0x" + utf8Hex(s)).slice(0, 10);
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
const pad = (a) => String(a).toLowerCase().replace(/^0x/, "").padStart(64, "0");
const addrOf = (raw) => ("0x" + String(raw).replace(/^0x/, "").slice(24, 64)).toLowerCase();
const num = (raw, i = 0) => BigInt("0x" + (String(raw).replace(/^0x/, "").slice(64 * i, 64 * (i + 1)) || "0"));
const signed = (raw, i) => BigInt.asIntN(256, num(raw, i));
/// An ABI string return, or a bytes32 one (some tokens answer that way).
function str(raw) {
  const h = String(raw).replace(/^0x/, "");
  if (h.length === 64) return Buffer.from(h, "hex").toString("utf8").replace(/\0+$/, "");
  const len = Number(BigInt("0x" + h.slice(64, 128)));
  return Buffer.from(h.slice(128, 128 + 2 * len), "hex").toString("utf8");
}
/// Raw units placed by `decimals`, with no trailing zeros.
function units(raw, decimals) {
  const s = BigInt(raw).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals) || "0";
  const frac = decimals ? s.slice(s.length - decimals).replace(/0+$/, "") : "";
  return frac ? whole + "." + frac : whole;
}

function client(url) {
  let id = 0;
  const request = async (method, params) => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
      const j = await res.json().catch(() => ({ error: { message: "HTTP " + res.status } }));
      if (!j.error) return j.result;
      const busy = res.status === 429 || /rate|limit|busy|timeout/i.test(String(j.error.message));
      if (!busy || attempt >= 4) throw new Error(method + ": " + JSON.stringify(j.error));
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  };
  return {
    call: (to, data) => request("eth_call", [{ to, data }, "latest"]),
    code: (a) => request("eth_getCode", [a, "latest"]),
  };
}

/// What the chain says, for the factories given (config.js's order): per asset
/// its token, decimals, symbol and threshold, and per feed its description and
/// decimals. Used by the check below, and to write the file in the first place.
async function readAssets(c, factories, feeds) {
  const out = [];
  for (const f of factories) {
    const token = addrOf(await c.call(f, sel("quoteToken()")));
    const decimals = Number(num(await c.call(token, sel("decimals()"))));
    const feed = feeds[token];
    const one = {
      factory: f.toLowerCase(), token, decimals, symbol: str(await c.call(token, sel("symbol()"))),
      graduationThreshold: num(await c.call(f, sel("graduationThreshold()"))).toString(),
      registry: addrOf(await c.call(f, sel("registry()"))),
      graduator: addrOf(await c.call(f, sel("graduator()"))),
      hooks: addrOf(await c.call(f, sel("hooks()"))),
      supply: num(await c.call(f, sel("supply()"))).toString(),
      taxMin: Number(num(await c.call(f, sel("minTotalTaxBps()")))),
      taxMax: Number(num(await c.call(f, sel("maxTotalTaxBps()")))),
      feed: null,
    };
    if (feed) {
      const round = await c.call(feed, sel("latestRoundData()"));
      one.feed = { address: feed.toLowerCase(), description: str(await c.call(feed, sel("description()"))),
        decimals: Number(num(await c.call(feed, sel("decimals()")))), answer: signed(round, 1).toString(),
        updatedAt: Number(num(round, 3)) };
    }
    out.push(one);
  }
  return out;
}

async function check(file, url) {
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const c = client(url);
  const bad = [];
  const want = (ok, what) => { if (!ok) bad.push(what); };
  const k = d.contracts || {};
  want(d.schema === "curb.deployment/1", "schema is " + d.schema);
  want(d.chainId === 8453, "chainId is " + d.chainId);
  const chain = Number(BigInt(await (async () => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "eth_chainId", params: [] }) });
    return (await res.json()).result;
  })()));
  want(chain === d.chainId, "the endpoint serves chain " + chain + ", not " + d.chainId);
  for (const [name, a] of Object.entries(k)) {
    const code = await c.code(a);
    want(code && code !== "0x", name + " " + a + " has no code");
  }
  want(addrOf(await c.call(k.lens, sel("registry()"))) === k.registry, "lens.registry() is not contracts.registry");
  want(addrOf(await c.call(k.lens, sel("graduator()"))) === k.graduator, "lens.graduator() is not contracts.graduator");
  want(addrOf(await c.call(k.graduator, sel("sharingCatalog()"))) === k.sharingCatalog, "graduator.sharingCatalog() is not contracts.sharingCatalog");
  const n = Number(num(await c.call(k.registry, sel("launcherCount()"))));
  const launchers = [];
  for (let i = 0; i < n; i++) launchers.push(addrOf(await c.call(k.registry, sel("launcherAt(uint256)") + word(i))));
  const factories = d.assets.map((a) => a.factory);
  want(JSON.stringify([...launchers].sort()) === JSON.stringify([...factories].sort()),
    "the registry's launchers are not the assets' factories:\n    registry " + launchers.join(", ") + "\n    file     " + factories.join(", "));
  const feeds = Object.fromEntries(d.assets.filter((a) => a.usdFeed).map((a) => [a.token, a.usdFeed.address]));
  const got = await readAssets(c, factories, feeds);
  d.assets.forEach((a, i) => {
    const g = got[i];
    const at = a.symbol + " (" + a.factory + ")";
    want(g.token === a.token, at + ": quoteToken() is " + g.token);
    want(g.decimals === a.decimals, at + ": decimals() is " + g.decimals);
    want(g.symbol === a.symbol, at + ": symbol() is " + g.symbol);
    want(g.graduationThreshold === a.graduationThreshold, at + ": graduationThreshold() is " + g.graduationThreshold + ", the file says " + a.graduationThreshold);
    want(units(a.graduationThreshold, a.decimals) === a.graduationThresholdUnits, at + ": graduationThresholdUnits is not graduationThreshold placed by decimals");
    want(g.registry === k.registry, at + ": registry() is " + g.registry);
    want(g.graduator === k.graduator, at + ": graduator() is " + g.graduator);
    want(g.hooks === k.feeHook, at + ": hooks() is " + g.hooks);
    want(g.supply === d.launchTerms.supply, at + ": supply() is " + g.supply);
    want(g.taxMin === d.launchTerms.taxBps.min && g.taxMax === d.launchTerms.taxBps.max, at + ": the tax band is " + g.taxMin + "-" + g.taxMax);
    want(a.launchUrl === d.site + "/launchpad?factory=" + a.factory, at + ": launchUrl is " + a.launchUrl);
    if (a.usdFeed) {
      want(g.feed.description === a.usdFeed.description, at + ": the feed's description() is " + JSON.stringify(g.feed.description));
      want(g.feed.decimals === a.usdFeed.decimals, at + ": the feed's decimals() is " + g.feed.decimals);
      want(BigInt(g.feed.answer) > 0n, at + ": the feed answers " + g.feed.answer);
    }
  });
  const st = await c.call(k.lens, sel("launchState(address)") + pad(k.curbToken));
  want(num(st, 0) !== 0n, "the lens does not know $CURB " + k.curbToken);
  return { bad, got };
}

async function main() {
  const args = process.argv.slice(2);
  const fi = args.indexOf("--file");
  const file = fi >= 0 ? args[fi + 1] : path.join(__dirname, "..", "..", "web", "agents", "deployment.json");
  const url = args.filter((a, i) => !a.startsWith("--") && (fi < 0 || i !== fi + 1))[0] || "https://mainnet.base.org";
  const { bad, got } = await check(file, url);
  for (const g of got) {
    console.log(`${g.symbol.padEnd(8)} ${g.factory}  threshold ${units(g.graduationThreshold, g.decimals)}` +
      (g.feed ? `  feed ${g.feed.description} (${g.feed.decimals} dp) updated ${new Date(g.feed.updatedAt * 1000).toISOString()}` : ""));
  }
  if (bad.length) {
    for (const b of bad) console.log("FAIL  " + b);
    console.log(`${bad.length} mismatch(es) between ${path.basename(file)} and the chain`);
    process.exit(1);
  }
  console.log(`ok    ${path.basename(file)} matches the chain at ${url.replace(/\/v2\/.*$/, "/v2/...")}`);
}

module.exports = { readAssets, client, units, check };
if (require.main === module) {
  main().catch((e) => { console.error(e.message || e); process.exit(2); });
}
