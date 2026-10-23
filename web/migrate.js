// /migrate.html, "Move a community": THE SNAPSHOT TOOL, and what filling a
// curve costs on each paired asset.
//
// A project whose community holds an ERC-20 on Base - from any launchpad - can
// relaunch on CURB without help from us: launch the new coin, buy what it will
// give away, snapshot the old token's holders here, and send the airdrop from
// its own Safe with Safe's CSV Airdrop app. This page reads; it never asks a
// wallet for anything and never sends.
//
// THE SNAPSHOT, READ FROM THE CHAIN ALONE. There is no indexer behind the site,
// so the holders are every address a Transfer log of the token names, from the
// block it was created in to the snapshot block, through the windows the
// endpoint takes (the same refusal sorting as token.js and browse.js: a range
// refusal narrows and holds, a result-size one narrows and grows back, a busy
// endpoint is asked again after a pause). Each one's balanceOf AT THE SNAPSHOT
// BLOCK is what counts - not the logs' arithmetic - read through Multicall3 in
// rounds, and the sum is checked against totalSupply at that block. Contracts
// are found with eth_getCode.
//
// THE SITE'S OWN ENDPOINT ONLY, or the visitor's: config.js rpc (or the pair a
// link names, as on every page), whose logs go to config.js logsRpc; or the
// endpoint typed under More, which then takes every read.
//
// A LONG HISTORY IS MANY READS (the site's log endpoint answers 1,000 blocks at
// a time), so the scan says how far it is, can be stopped, and picks up where
// it stopped - after a Stop, or after the endpoint gave up answering.
(function () {
"use strict";
const Bar = window.CurbBar, M = window.CurbMulti, Meta = window.CurbMeta, Sh = window.CurbSharing;
if (!Bar || !M || !Meta || !Sh || !window.CurbAbi || !window.CurbKeccak) return;
const $ = (id) => document.getElementById(id);
const { keccak256 } = window.CurbKeccak;
const { utf8Hex } = window.CurbAbi;
const { el } = Sh;
const sig = (s) => keccak256("0x" + utf8Hex(s)).slice(0, 10);
const hex = (n) => "0x" + BigInt(n).toString(16);
const pad = (a) => String(a).toLowerCase().replace(/^0x/, "").padStart(64, "0");
const isAddr = (s) => /^0x[0-9a-fA-F]{40}$/.test(String(s || "").trim());
const isRpc = (s) => /^https?:\/\/[^\s"'<>]{1,200}$/i.test(String(s || "").trim());
const lower = (s) => String(s || "").trim().toLowerCase();

const SEL = {
  name: sig("name()"), symbol: sig("symbol()"), decimals: sig("decimals()"), totalSupply: sig("totalSupply()"),
  balanceOf: sig("balanceOf(address)"),
  registry: sig("registry()"), isRegistered: sig("isRegistered(address)"),
  launcherCount: sig("launcherCount()"), launcherAt: sig("launcherAt(uint256)"),
  quoteToken: sig("quoteToken()"), graduationThreshold: sig("graduationThreshold()"), supply: sig("supply()"),
  maxDevBuyBps: sig("MAX_DEV_BUY_BPS()"), phantomQuote: sig("phantomQuote()"),
};
const TRANSFER = keccak256("0x" + utf8Hex("Transfer(address,address,uint256)"));

/// LEFT OUT OF EVERY AIRDROP: what is sent to these is gone. The zero address,
/// the two dead addresses tokens are burned to by hand, and (added per
/// snapshot) the old token's own address.
const ZERO = "0x0000000000000000000000000000000000000000";
const BURN = new Set([ZERO, "0x000000000000000000000000000000000000dead", "0xdead000000000000000042069420694206942069"]);

/// A DEV BUY'S CAP AS THE CONTRACT WRITES IT, until the factories are read:
/// CurbLaunchFactory.MAX_DEV_BUY_BPS (2,000 bps of the supply) of the
/// 1,000,000,000 every launch mints (DeployCurb). Read from the factories on
/// this page's deployment when they answer (readCosts).
let capBps = 2000n;
let capSupply = 10n ** 27n;
/// THE TAX THE LARGEST DEV BUY IS PRICED AT in the costs table: the lowest a
/// launch may choose (LaunchRegistry MIN_TOTAL_TAX_BPS).
const MIN_TAX_BPS = 100n;

/// SAFE'S CSV AIRDROP APP (github.com/bh2smith/safe-airdrop, src/hooks/useCsvParser.ts
/// and src/parser, read 23 October 2026): the header names its columns -
/// token_type, token_address, receiver, amount, id - and an amount is in whole
/// tokens, scaled by the token's decimals with any finer fraction dropped. A
/// file of more than 501 lines is refused ("transactions are limited to 500
/// lines"), counted by splitting on line breaks, so a trailing newline is a line
/// of its own: each file is the header and at most SAFE_ROWS rows, and ends
/// without one.
const SAFE_HEADER = "token_type,token_address,receiver,amount,id";
const SAFE_ROWS = 500;

const BAL_CALLS = 100;           // balanceOf calls per aggregate3
const BATCH = 50;                // requests per JSON-RPC batch
const TRIES = 5;                 // a busy endpoint is asked again this often...
const BACKOFF_MS = 500;          // ...after 0.5, 1, 2, 4 and 8 seconds
const WINDOW = 10000;            // the first log window where no ceiling is stated
const WINDOW_MAX = 1000000;      // the widest a window grows
const SIZE_REGROW = 8;           // windows answered under a result-size ceiling before it is tried above
const TABLE_ROWS = 100;          // holders drawn; the files carry every one
const CONTRACTS_SHOWN = 300;

// ---------------------------------------------------------------- the node
/// WHERE A LOG READ GOES: web/config.js logsRpc when the endpoint is the site's
/// own (web/config.js rpc), as sharing.js and token.js logsUrl say; any other
/// endpoint takes every read, logs included.
function logsUrl(url) {
  const c = window.CURB_SITE || {};
  const own = typeof c.rpc === "string" ? c.rpc.trim() : "";
  const logs = typeof c.logsRpc === "string" ? c.logsRpc.trim() : "";
  return logs && own && String(url || "").trim() === own ? logs : url;
}
/// The most blocks of logs asked at once to start with: web/config.js
/// logsBlocks where the logs go to logsRpc (token.js logsCeiling), else 0.
function logsCeiling(url) {
  const n = (window.CURB_SITE || {}).logsBlocks;
  return logsUrl(url) !== url && Number.isInteger(n) && n > 0 ? n : 0;
}
/// THE ENDPOINT A SNAPSHOT READS: the one typed under More, else the pair the
/// site's links carry (CurbBar.config), as every page reads.
function endpoint() {
  const own = $("mRpc").value.trim();
  if (own) {
    if (!isRpc(own)) throw new Error("The endpoint under More is not an http(s) address.");
    return { url: own, logs: own, ceiling: 0 };
  }
  const url = Bar.config().rpc;
  return { url, logs: logsUrl(url), ceiling: logsCeiling(url) };
}
const hostOf = (u) => { try { return new URL(u).host || u; } catch { return String(u); } };

const STOPPED = new Error("stopped");
let rpcId = 0;
const headersFor = (url) => (M.headers ? M.headers(url) : { "content-type": "application/json" });
/// One POST to `url`, given up when the job is stopped. A failure carries the
/// HTTP status, so the refusal sorting can tell a busy endpoint.
async function post(job, url, body) {
  let res;
  try {
    res = await fetch(url, { method: "POST", headers: headersFor(url), body: JSON.stringify(body),
      signal: job ? job.ctl.signal : undefined });
  } catch (e) {
    if (job && job.stopped) throw STOPPED;
    throw e;
  }
  if (!res.ok) throw Object.assign(new Error("the endpoint answered HTTP " + res.status), { status: res.status });
  try { return await res.json(); } catch (e) {
    if (job && job.stopped) throw STOPPED;
    throw new Error("the endpoint did not answer JSON");
  }
}
/// One JSON-RPC request; a node's error carries its code and data.
async function rpcOnce(job, method, params) {
  const url = method === "eth_getLogs" ? job.logs : job.url;
  const j = await post(job, url, { jsonrpc: "2.0", id: ++rpcId, method, params });
  if (j && j.error) {
    throw Object.assign(new Error(j.error.message || "the endpoint refused " + method), { code: j.error.code, data: j.error.data });
  }
  if (!j || !Object.prototype.hasOwnProperty.call(j, "result")) throw new Error("the endpoint answered " + method + " with neither a result nor an error");
  return j.result;
}
/// REFUSED NOW, NOT REFUSED: a rate limit, a timeout, a server's error or a
/// connection that failed. A revert or a bad parameter is an answer.
function transient(e) {
  if (!e || e === STOPPED) return false;
  if (e.status === 429 || e.status >= 500 || e.code === 429 || e.name === "TypeError") return true;
  const msg = String(e.message || "") + (typeof e.data === "string" ? " " + e.data : "");
  return /rate|too many requests|timeout|timed out|busy|capacity|exceeded its|try again/i.test(msg);
}
const stopIf = (job) => { if (job.stopped) throw STOPPED; };
/// A pause that a Stop cuts short.
const pause = (job, ms) => new Promise((res) => {
  const t = setTimeout(res, ms);
  job.ctl.signal.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true });
});
/// A request asked again while the endpoint is busy, TRIES times.
async function ask(job, method, params) {
  for (let busy = 0; ;) {
    stopIf(job);
    try { return await rpcOnce(job, method, params); } catch (e) {
      if (e === STOPPED || job.stopped) throw STOPPED;
      if (!transient(e) || ++busy > TRIES) throw e;
      await pause(job, BACKOFF_MS * 2 ** (busy - 1));
    }
  }
}
/// SEVERAL REQUESTS, in JSON-RPC batches where the endpoint takes them and one
/// at a time where it does not: each answer is its result, or null where it
/// was refused. A request a batch answered busy is asked again by itself.
async function batched(job, reqs) {
  const out = [];
  for (let i = 0; i < reqs.length; i += BATCH) {
    const part = reqs.slice(i, i + BATCH);
    let got = null;
    if (!job.noBatch && part.length > 1) {
      try {
        let arr = null;
        for (let busy = 0; ;) {
          stopIf(job);
          try {
            arr = await post(job, job.url, part.map((r, j) => ({ jsonrpc: "2.0", id: j + 1, method: r.method, params: r.params })));
            break;
          } catch (e) {
            if (e === STOPPED || job.stopped) throw STOPPED;
            if (!transient(e) || ++busy > TRIES) throw e;
            await pause(job, BACKOFF_MS * 2 ** (busy - 1));
          }
        }
        if (!Array.isArray(arr)) throw new Error("no batch");
        const byId = new Map(arr.filter((r) => r && typeof r === "object").map((r) => [r.id, r]));
        got = [];
        for (let j = 0; j < part.length; j++) {
          const r = byId.get(j + 1);
          if (r && !r.error && Object.prototype.hasOwnProperty.call(r, "result")) { got.push(r.result); continue; }
          const e = r && r.error ? Object.assign(new Error(r.error.message || ""), { code: r.error.code, data: r.error.data }) : null;
          got.push(!r || transient(e) ? await ask(job, part[j].method, part[j].params).catch((x) => { if (x === STOPPED) throw x; return null; }) : null);
        }
      } catch (e) {
        if (e === STOPPED) throw e;
        job.noBatch = true;
        got = null;
      }
    }
    if (!got) {
      got = [];
      for (const r of part) got.push(await ask(job, r.method, r.params).catch((x) => { if (x === STOPPED) throw x; return null; }));
    }
    out.push(...got);
  }
  return out;
}
const firstWord = (raw) => {
  const h = String(raw || "").replace(/^0x/, "");
  return /^[0-9a-fA-F]{64}/.test(h) ? BigInt("0x" + h.slice(0, 64)) : null;
};

// ---------------------------------------------------------------- reading the token
/// A NAME OR A SYMBOL, as the token answered it: an ABI string, or the bytes32
/// some old tokens return. A stranger's words: drawn as text, cut to fit.
function words(raw, n) {
  let s = "";
  try { s = Meta.decodeString(raw || "0x"); } catch { s = ""; }
  const h = String(raw || "").replace(/^0x/, "");
  if (!s && h.length === 64) {
    const bytes = (h.match(/../g) || []).map((x) => parseInt(x, 16)).filter((b) => b !== 0);
    s = new TextDecoder("utf-8", { fatal: false }).decode(Uint8Array.from(bytes));
  }
  return Meta.cut(s.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ""), n);
}

/// The token at the snapshot block: its words, decimals and supply.
async function readToken(job) {
  const at = hex(job.block);
  const read = (data) => ask(job, "eth_call", [{ to: job.token, data }, at]);
  const code = await ask(job, "eth_getCode", [job.token, at]);
  if (!code || code === "0x") throw new Error("There is no contract at " + job.token + " at block " + job.block.toLocaleString("en-US") + ".");
  const dec = firstWord(await read(SEL.decimals).catch((e) => { if (e === STOPPED) throw e; return "0x"; }));
  if (dec === null || dec > 77n) throw new Error("The contract at " + job.token + " did not answer decimals() as an ERC-20 does.");
  const [n, s, t] = await Promise.all([SEL.name, SEL.symbol, SEL.totalSupply].map((d) => read(d).catch((e) => { if (e === STOPPED) throw e; return "0x"; })));
  return { name: words(n, 64), symbol: words(s, 24), decimals: Number(dec), totalSupply: firstWord(t) };
}

/// THE LOWEST BLOCK WORTH ASKING ABOUT: on a local fork, the block it forked
/// at (sharing.js forkFloor); elsewhere 0.
function forkFloor(job) {
  return Sh.forkFloor(Sh.reader(job.url)).catch(() => 0);
}
/// THE BLOCK THE TOKEN WAS CREATED IN, by bisection on its code.
async function firstBlock(job) {
  const floor = Math.min(await forkFloor(job), job.block);
  const has = async (n) => (await ask(job, "eth_getCode", [job.token, hex(n)])) !== "0x";
  try {
    let lo = floor, hi = job.block;
    if (await has(lo)) return lo;
    let steps = 0;
    while (lo + 1 < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (await has(mid)) hi = mid; else lo = mid;
      status("Finding the block the token was created in… (" + ++steps + " reads)");
    }
    return hi;
  } catch (e) {
    if (e === STOPPED) throw e;
    throw new Error("The endpoint would not say whether the token existed at an older block (" + (e.message || e) +
      "), so the block it was created in was not found. Give it under More, as From block.");
  }
}

/// THE CEILING A RANGE REFUSAL STATES, when it states one (token.js statedLimit).
function statedLimit(e) {
  const text = String((e && e.message) || "") + " " + (e && typeof e.data === "string" ? e.data : "");
  const m = /maximum (?:of )?([\d,]+) blocks|limited to (?:a )?([\d,]+)(?:[ -]block)? range|up to (?:a )?([\d,]+)[ -]block range/i.exec(text);
  const n = m ? Number(String(m[1] || m[2] || m[3]).replace(/,/g, "")) : 0;
  return Number.isInteger(n) && n > 0 ? n : 0;
}
/// "range", "size" or "busy", sorted as every page sorts them (sharing.js logError).
const logKind = (e) => (typeof Sh.logError === "function" ? Sh.logError(e) : "range");

function addWord(job, w) {
  const h = String(w || "").toLowerCase().replace(/^0x/, "");
  if (h.length !== 64 || !/^0{24}/.test(h)) return;
  job.seen.add("0x" + h.slice(24));
}
/// The addresses a page of Transfer logs names, sender and receiver both.
/// A Transfer with a fourth topic carries a token id: an NFT's.
function collect(job, logs) {
  for (const l of logs) {
    if (!l || l.removed || lower(l.address) !== job.token) continue;
    const t = Array.isArray(l.topics) ? l.topics.map(lower) : [];
    if (t[0] !== TRANSFER) continue;
    if (t.length === 3) { addWord(job, t[1]); addWord(job, t[2]); continue; }
    if (t.length === 4) { job.nft = true; continue; }
    const d = String(l.data || "").replace(/^0x/, "");
    if (t.length === 1 && d.length >= 128) { addWord(job, d.slice(0, 64)); addWord(job, d.slice(64, 128)); }
  }
}

/// EVERY TRANSFER LOG FROM job.next TO THE SNAPSHOT BLOCK, in the windows the
/// endpoint takes; job.next moves on with each window answered, so a stopped
/// scan picks up where it was.
async function scan(job) {
  const total = job.block - job.from + 1;
  const started = Date.now(), startedAt = job.next;
  let busy = 0;
  while (job.next <= job.block) {
    stopIf(job);
    const start = job.next;
    const end = Math.min(job.block, start + job.size - 1);
    let logs;
    try {
      logs = await rpcOnce(job, "eth_getLogs", [{ address: job.token, topics: [TRANSFER], fromBlock: hex(start), toBlock: hex(end) }]);
      if (!Array.isArray(logs)) throw new Error("the endpoint answered eth_getLogs without a list");
    } catch (e) {
      if (e === STOPPED || job.stopped) throw STOPPED;
      // A REFUSAL THAT STATES A CEILING IN BLOCKS is about the range, whatever
      // else it says.
      const kind = statedLimit(e) > 0 ? "range" : logKind(e);
      if (kind === "busy") {
        if (++busy > TRIES) throw e;
        await pause(job, BACKOFF_MS * 2 ** (busy - 1));
        continue;
      }
      // A RANGE OR A RESULT LIMIT: ask for less, down to one block. A range
      // refusal's ceiling holds; a result-size one is tried above again later.
      if (job.size <= 1) throw e;
      const stated = statedLimit(e);
      const next = Math.max(1, kind === "range" && stated > 0 && stated < job.size ? stated : Math.floor(job.size / 2));
      if (kind === "range") job.cap = next;
      else job.calm = -SIZE_REGROW;
      job.size = next;
      continue;
    }
    busy = 0;
    collect(job, logs);
    job.next = end + 1;
    if (job.calm < 0) job.calm += 1;
    else job.size = Math.min(job.cap || WINDOW_MAX, job.size * 2);
    const done = job.next - job.from;
    const rate = (job.next - startedAt) / Math.max(1, Date.now() - started);
    const left = rate > 0 ? (job.block + 1 - job.next) / rate : 0;
    progress(done / total, "Reading transfers through " + hostOf(job.logs) + ": block " + Math.min(job.next, job.block).toLocaleString("en-US") +
      " of " + job.block.toLocaleString("en-US") + " (" + Math.floor((done / total) * 100) + "%) · " +
      job.seen.size.toLocaleString("en-US") + " addresses seen" + (left > 5000 ? " · about " + duration(left) + " left" : ""));
  }
}
function duration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 90) return s + " s";
  if (s < 5400) return Math.round(s / 60) + " min";
  return (s / 3600).toFixed(1) + " h";
}

/// EACH ADDRESS'S balanceOf AT THE SNAPSHOT BLOCK, through Multicall3 in
/// rounds of BAL_CALLS; where that is refused (an endpoint, a block before
/// Multicall3), call by call. A balance the token would not give is unread.
async function readBalances(job) {
  const list = job.list;
  for (let i = job.balAt; i < list.length; i += BAL_CALLS) {
    stopIf(job);
    const part = list.slice(i, i + BAL_CALLS);
    const calls = part.map((a) => ({ to: job.token, data: SEL.balanceOf + pad(a) }));
    let got = null;
    if (!job.noMulti && part.length > 1) {
      try {
        const raw = await ask(job, "eth_call", [{ to: M.MULTICALL3, data: M.encode(calls) }, hex(job.block)]);
        got = M.decode(raw, calls.length).map((r) => (r.ok ? firstWord(r.data) : null));
      } catch (e) {
        if (e === STOPPED) throw e;
        job.noMulti = true;
      }
    }
    if (!got) {
      got = (await batched(job, calls.map((c) => ({ method: "eth_call", params: [{ to: c.to, data: c.data }, hex(job.block)] }))))
        .map(firstWord);
    }
    part.forEach((a, j) => { if (got[j] === null) job.unread.push(a); else job.bal.set(a, got[j]); });
    job.balAt = i + BAL_CALLS;
    progress(Math.min(1, job.balAt / list.length), "Reading balances at block " + job.block.toLocaleString("en-US") + ": " +
      Math.min(job.balAt, list.length).toLocaleString("en-US") + " of " + list.length.toLocaleString("en-US"));
  }
}

/// WHAT AN ADDRESS'S CODE SAYS IT IS. No code, or an EIP-7702 delegation
/// (0xef0100 and an address), is a wallet: a person can move what it holds. A
/// Safe proxy - it answers masterCopy() (0xa619486e) before delegating - is a
/// person's or a team's wallet too. Anything else is a contract.
const SAFE_PROXY = /7fa619486e0{56}/i;
function kindOf(code) {
  const c = String(code || "0x").toLowerCase();
  if (c === "0x") return "wallet";
  if (/^0xef0100[0-9a-f]{40}$/.test(c)) return "delegated";
  if (SAFE_PROXY.test(c)) return "safe";
  return "contract";
}
/// The code of every holder with a balance, now.
async function readCodes(job) {
  const holders = job.list.filter((a) => (job.bal.get(a) || 0n) > 0n);
  for (let i = job.codeAt; i < holders.length; i += BATCH) {
    stopIf(job);
    const part = holders.slice(i, i + BATCH);
    const got = await batched(job, part.map((a) => ({ method: "eth_getCode", params: [a, "latest"] })));
    part.forEach((a, j) => job.kind.set(a, got[j] === null ? "unknown" : kindOf(got[j])));
    job.codeAt = i + BATCH;
    progress(Math.min(1, job.codeAt / holders.length), "Finding contracts among the holders: " +
      Math.min(job.codeAt, holders.length).toLocaleString("en-US") + " of " + holders.length.toLocaleString("en-US"));
  }
  job.codesRead = true;
}

// ---------------------------------------------------------------- amounts and files
/// A decimal the person typed, in units of `decimals` places. No comma, as on
/// the launch form: "1,5" is a thousand-separator in one place and a decimal
/// point in another.
function parseUnits(text, decimals, what) {
  const t = String(text || "").trim();
  if (t.includes(",")) throw new Error(what + ": use a dot for decimals, and no thousands separators.");
  const m = /^(\d*)(?:\.(\d*))?$/.exec(t);
  if (!m || (!m[1] && !m[2])) throw new Error(what + " is not a number.");
  const frac = (m[2] || "").replace(/0+$/, "");
  if (frac.length > decimals) throw new Error(what + " has more than " + decimals + " decimal places.");
  return BigInt(m[1] || "0") * 10n ** BigInt(decimals) + BigInt((frac || "0").padEnd(decimals, "0"));
}
/// A RATIO, exactly: new tokens per old token as num / den.
function parseRatio(text) {
  const t = String(text || "").trim();
  if (!t) throw new Error("Give the ratio: how many new tokens each old token gets.");
  const num = parseUnits(t, 18, "The ratio");
  if (num === 0n) throw new Error("The ratio must be more than 0.");
  return { num, den: 10n ** 18n };
}
/// AN OLD BALANCE IN THE NEW TOKEN'S UNITS, at the ratio, rounded down.
function scale(bal, ratio, oldDecimals, newDecimals) {
  return (BigInt(bal) * ratio.num * 10n ** BigInt(newDecimals)) / (ratio.den * 10n ** BigInt(oldDecimals));
}
/// AN AMOUNT AS A FILE CARRIES IT: whole tokens, every decimal it has and no
/// trailing zero, no separator.
function exact(v, decimals) {
  const b = BigInt(v);
  const base = 10n ** BigInt(decimals);
  const frac = (b % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return (b / base).toString() + (frac ? "." + frac : "");
}
/// An amount as the page shows it: thousands separated, at most `places` decimals.
function shown(v, decimals, places = 4) {
  if (v === null || v === undefined) return "—";
  const b = BigInt(v);
  const base = 10n ** BigInt(decimals);
  const frac = (b % base).toString().padStart(decimals, "0").slice(0, places).replace(/0+$/, "");
  const whole = (b / base).toLocaleString("en-US");
  if (b > 0n && b / base === 0n && !frac) return "<0." + "0".repeat(Math.max(0, places - 1)) + "1";
  return whole + (frac ? "." + frac : "");
}
/// AN ADDRESS IN ITS EIP-55 FORM, which Safe's app reads as it reads any.
function checksum(a) {
  const h = lower(a).replace(/^0x/, "");
  const k = keccak256("0x" + utf8Hex(h)).slice(2);
  let out = "0x";
  for (let i = 0; i < 40; i++) out += parseInt(k[i], 16) >= 8 ? h[i].toUpperCase() : h[i];
  return out;
}

/// WHO GETS WHAT, from a snapshot and the page's settings - nothing read.
///   settings: { ratio, minRaw, exclude (Set), contractsOn, choice (Map:
///   address -> true to leave out), newDecimals }
/// Each holder is in exactly one list: rows (in the files) or out, with why.
function plan(snap, s) {
  const rows = [], out = [];
  let needed = 0n, inOld = 0n, outOld = 0n;
  for (const h of snap.holders) {
    const kind = h.kind || "";
    let why = "";
    if (BURN.has(h.a)) why = "burn address";
    else if (h.a === snap.token) why = "the token itself";
    else if (s.exclude.has(h.a)) why = "your list";
    else if (s.contractsOn && (kind === "contract" || kind === "safe") &&
      (s.choice.has(h.a) ? s.choice.get(h.a) : kind === "contract")) why = kind === "safe" ? "Safe, left out" : "contract";
    else if (h.bal < s.minRaw) why = "below the minimum";
    let amount = 0n;
    if (!why) {
      amount = scale(h.bal, s.ratio, snap.decimals, s.newDecimals);
      if (amount === 0n) why = "rounds to 0";
    }
    if (why) { out.push({ a: h.a, bal: h.bal, why }); outOld += h.bal; continue; }
    rows.push({ a: h.a, bal: h.bal, amount });
    needed += amount;
    inOld += h.bal;
  }
  return { rows, out, needed, inOld, outOld };
}
/// SAFE'S FILES: the header and at most SAFE_ROWS rows each, no trailing
/// newline (see SAFE_HEADER), every row an erc20 transfer of the new token.
function safeFiles(rows, newToken, newDecimals) {
  const token = checksum(newToken);
  const files = [];
  for (let i = 0; i < rows.length; i += SAFE_ROWS) {
    files.push([SAFE_HEADER, ...rows.slice(i, i + SAFE_ROWS).map((r) =>
      "erc20," + token + "," + checksum(r.a) + "," + exact(r.amount, newDecimals) + ",")].join("\n"));
  }
  return files;
}
/// THE PLAIN FILE: address,amount, one line each, every line ended.
function plainFile(rows, newDecimals) {
  return "address,amount\n" + rows.map((r) => checksum(r.a) + "," + exact(r.amount, newDecimals) + "\n").join("");
}
function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = el("a", { href: url, download: name, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ---------------------------------------------------------------- the page
let job = null;      // the snapshot being read, or the last one stopped
let snap = null;     // the last snapshot read in full
const choice = new Map();  // contract -> leave out (true) or keep (false), as the person set it
let newToken = { address: "", decimals: 18, symbol: "", read: false, error: "" };

function status(text, bad) {
  const s = $("mStatus");
  s.hidden = !text;
  s.textContent = text || "";
  s.className = bad ? "bad" : "";
}
let drawnAt = 0;
function progress(frac, text) {
  const p = $("mProgress");
  p.hidden = false;
  p.value = Math.round(Math.max(0, Math.min(1, frac)) * 1000);
  // AT MOST FIVE TIMES A SECOND: a fast node answers hundreds of windows a second.
  if (Date.now() - drawnAt > 200 || frac >= 1) { drawnAt = Date.now(); status(text); }
}
function busy(on) {
  for (const id of ["mOld", "mBlock", "mFrom", "mRpc", "mRun", "mFindContracts"]) $(id).disabled = on;
  $("mStop").hidden = !on;
  if (on) $("mContinue").hidden = true;
}

/// A SNAPSHOT TO READ, from the form - or the one stopped, to go on with.
function newJob() {
  const token = lower($("mOld").value);
  if (!isAddr(token)) throw new Error("Give the old token's address: 0x and 40 hex characters.");
  const blockText = $("mBlock").value.trim().replace(/[\s_]/g, "");
  const fromText = $("mFrom").value.trim().replace(/[\s_]/g, "");
  if (blockText && !/^\d{1,12}$/.test(blockText)) throw new Error("The block is a whole number, or blank for the latest.");
  if (fromText && !/^\d{1,12}$/.test(fromText)) throw new Error("From block is a whole number, or blank.");
  const ep = endpoint();
  return {
    token, blockAsked: blockText ? Number(blockText) : null, fromAsked: fromText ? Number(fromText) : null,
    url: ep.url, logs: ep.logs, ceiling: ep.ceiling, findContracts: $("mFindContracts").checked,
    stopped: false, ctl: new AbortController(), block: null, from: null, info: null, chainId: null,
    next: null, size: ep.ceiling ? Math.min(ep.ceiling, WINDOW) : WINDOW, cap: ep.ceiling || 0, calm: 0,
    seen: new Set(), nft: false, list: null, balAt: 0, bal: new Map(), unread: [], noMulti: false, noBatch: false,
    kind: new Map(), codeAt: 0, codesRead: false,
  };
}

async function run(goOn) {
  let j;
  try {
    j = goOn && job ? job : newJob();
  } catch (e) { status(e.message, true); return; }
  if (goOn) { j.stopped = false; j.ctl = new AbortController(); }
  job = j;
  busy(true);
  try {
    if (j.chainId === null) {
      status("Reading the chain…");
      j.chainId = parseInt(await ask(j, "eth_chainId", []), 16);
    }
    if (j.block === null) {
      const head = parseInt(await ask(j, "eth_blockNumber", []), 16);
      if (j.blockAsked !== null && j.blockAsked > head) throw new Error("Block " + j.blockAsked.toLocaleString("en-US") + " is not mined yet: the chain is at " + head.toLocaleString("en-US") + ".");
      j.block = j.blockAsked !== null ? j.blockAsked : head;
    }
    if (!j.info) {
      status("Reading the token at block " + j.block.toLocaleString("en-US") + "…");
      j.info = await readToken(j);
    }
    if (j.from === null) {
      if (j.fromAsked !== null && j.fromAsked > j.block) throw new Error("From block is after the snapshot block.");
      j.from = j.fromAsked !== null ? j.fromAsked : await firstBlock(j);
      j.next = j.from;
    }
    await scan(j);
    if (j.nft && !j.seen.size) throw new Error("This contract's Transfer events carry a token id: it is an NFT, not an ERC-20.");
    if (!j.list) j.list = [...j.seen].sort();
    await readBalances(j);
    if (j.findContracts && !j.codesRead) await readCodes(j);
    finish(j);
  } catch (e) {
    if (e === STOPPED) {
      status("Stopped" + stoppedWhere(j) + ". Continue picks up from there.");
      $("mContinue").hidden = false;
    } else {
      status(String((e && e.message) || e) + (j.next !== null && j.next > j.from ? " Continue tries again from where it stopped." : ""), true);
      $("mContinue").hidden = !(j.next !== null);
    }
  } finally {
    busy(false);
  }
}
function stoppedWhere(j) {
  if (j.next !== null && j.next <= j.block) return " at block " + j.next.toLocaleString("en-US") + " of " + j.block.toLocaleString("en-US");
  if (j.list && j.balAt < j.list.length) return " after " + j.balAt.toLocaleString("en-US") + " balances";
  return "";
}

/// THE SNAPSHOT, READ IN FULL: kept, and drawn.
function finish(j) {
  const holders = [];
  for (const a of j.list) {
    const bal = j.bal.get(a);
    if (bal && bal > 0n) holders.push({ a, bal, kind: j.codesRead ? j.kind.get(a) || "unknown" : "" });
  }
  holders.sort((x, y) => (y.bal > x.bal ? 1 : y.bal < x.bal ? -1 : x.a < y.a ? -1 : x.a > y.a ? 1 : 0));
  let sum = 0n;
  for (const h of holders) sum += h.bal;
  snap = { token: j.token, chainId: j.chainId, block: j.block, from: j.from, ...j.info, holders, sum,
    unread: j.unread.slice(), addresses: j.list.length, contractsLooked: j.codesRead, endpoint: hostOf(j.url) };
  $("mProgress").hidden = true;
  status("Read " + j.list.length.toLocaleString("en-US") + " addresses from block " + j.from.toLocaleString("en-US") +
    " to " + j.block.toLocaleString("en-US") + " through " + hostOf(j.url) + (j.logs !== j.url ? " and " + hostOf(j.logs) : "") + ".");
  $("mContinue").hidden = true;
  drawInfo();
  draw();
  $("mResult").hidden = false;
}

function drawInfo() {
  const s = snap;
  // LINKED ON THE SITE'S OWN CHAIN ONLY (config.js chainId and explorer).
  const site = Bar.site();
  const explorer = s.chainId === site.chainId ? site.explorer : "";
  const tokenEl = explorer ? el("a", { class: "addr", href: explorer + "/token/" + s.token, target: "_blank", rel: "noreferrer noopener", text: s.token })
    : el("code", { class: "addr", text: s.token });
  $("mInfo").replaceChildren(el("b", { text: s.name || "(no name)" }), " (", el("b", { text: s.symbol || "?" }), ") · ", tokenEl,
    " · " + s.decimals + " decimals · at block " + s.block.toLocaleString("en-US") +
    (s.chainId !== site.chainId ? " · chain " + s.chainId + ", not this site's " + site.chainId : ""));
  const sup = $("mSupply");
  const sym = s.symbol || "tokens";
  if (s.totalSupply === null) {
    sup.className = "note warn";
    sup.textContent = "The holders' balances add up to " + shown(s.sum, s.decimals) + " " + sym + "; the token did not answer totalSupply() to check them against.";
  } else if (s.sum === s.totalSupply) {
    sup.className = "note good";
    sup.textContent = "The holders' balances add up to " + shown(s.sum, s.decimals) + " " + sym + ", the token's whole supply at that block.";
  } else {
    sup.className = "note warn";
    sup.textContent = "The holders' balances add up to " + shown(s.sum, s.decimals) + " " + sym + ", and the total supply at that block is " +
      shown(s.totalSupply, s.decimals) + ": " + (s.sum < s.totalSupply ? "some balance came without a Transfer log, or was not read." : "this token's balances are not what its supply says (a rebasing token, perhaps).");
  }
  if (s.unread.length) {
    sup.textContent += " " + s.unread.length.toLocaleString("en-US") + " address" + (s.unread.length === 1 ? "'s" : "es'") +
      " balance could not be read, so " + (s.unread.length === 1 ? "it is" : "they are") + " not in the files: " + s.unread.slice(0, 5).join(", ") + (s.unread.length > 5 ? " …" : "") + ".";
    sup.className = "note warn";
  }
}

/// THE PAGE'S SETTINGS, or the sentence that says what is wrong with them.
function settings() {
  const errs = [];
  let ratio = null, minRaw = 0n;
  try { ratio = parseRatio($("mRatio").value); } catch (e) { errs.push(e.message); }
  const minText = $("mMin").value.trim();
  if (minText) { try { minRaw = parseUnits(minText, snap.decimals, "The minimum"); } catch (e) { errs.push(e.message); } }
  const exclude = new Set();
  const bad = [];
  for (const w of $("mExclude").value.split(/[\s,;]+/)) {
    if (!w) continue;
    if (isAddr(w)) exclude.add(lower(w)); else bad.push(w);
  }
  return { errs, bad, s: { ratio, minRaw, exclude, contractsOn: !!snap.contractsLooked && $("mFindContracts").checked, choice,
    newDecimals: newToken.read ? newToken.decimals : 18 } };
}

function box(value, label) { return el("div", { class: "box" }, [el("b", { text: value }), el("span", { text: label })]); }

function draw() {
  if (!snap) return;
  const { errs, bad, s } = settings();
  const errEl = $("mErr");
  const excl = $("mExcludeNote");
  excl.textContent = "The zero and dead addresses and the old token itself are always left out." +
    (bad.length ? " Not addresses, so not used: " + bad.slice(0, 3).map((x) => Meta.cut(x, 20)).join(", ") + (bad.length > 3 ? " …" : "") + "." : "");
  const sym = snap.symbol || "old tokens";
  const newSym = newToken.read && newToken.symbol ? newToken.symbol : "new tokens";
  if (errs.length) {
    errEl.hidden = false;
    errEl.className = "note bad";
    errEl.textContent = errs.join(" ");
    $("mFiles").replaceChildren();
    $("mNeed").textContent = "";
    $("mTotals").replaceChildren(box(snap.holders.length.toLocaleString("en-US"), "holders at block " + snap.block.toLocaleString("en-US")));
    drawContracts(null);
    drawTable(null, s);
    return;
  }
  errEl.hidden = true;
  const p = plan(snap, s);
  $("mTotals").replaceChildren(
    box(snap.holders.length.toLocaleString("en-US"), "holders with a balance at block " + snap.block.toLocaleString("en-US")),
    box(p.rows.length.toLocaleString("en-US"), "in the airdrop, holding " + shown(p.inOld, snap.decimals) + " " + sym),
    box(p.out.length.toLocaleString("en-US"), "left out, holding " + shown(p.outOld, snap.decimals) + " " + sym),
    box(shown(p.needed, s.newDecimals), newSym + " needed at " + $("mRatio").value.trim() + " per old token"),
  );
  const need = $("mNeed");
  // A LAUNCH TOKEN HAS 18 DECIMALS; a new token of other decimals is compared in its own.
  const cap = (capSupply * capBps * 10n ** BigInt(s.newDecimals)) / (10000n * 10n ** 18n);
  const capText = shown(cap, s.newDecimals, 0) + " (" + (Number(capBps) / 100) + "% of the supply)";
  need.className = p.needed > cap ? "note warn" : "note";
  need.textContent = p.rows.length
    ? "The Safe that sends the airdrop must hold at least " + exact(p.needed, s.newDecimals) + " " + newSym + " when you submit it. " +
      (p.needed > cap
        ? "That is more than a dev buy can receive, " + capText + ": the rest has to be bought on the curve after the launch, like anyone's buy."
        : "A dev buy can receive up to " + capText + ".")
    : "Nobody is left in the airdrop.";
  drawFiles(p, s);
  drawContracts(s);
  drawTable(p, s);
}

function drawFiles(p, s) {
  const files = $("mFiles");
  files.replaceChildren();
  if (!p.rows.length) return;
  const stem = "airdrop-" + snap.token.slice(0, 10) + "-block-" + snap.block;
  const newOk = isAddr(newToken.address) && newToken.read;
  const safe = newOk ? safeFiles(p.rows, newToken.address, s.newDecimals) : [];
  if (newOk) {
    safe.forEach((text, i) => {
      const name = stem + "-safe" + (safe.length > 1 ? "-part-" + (i + 1) + "-of-" + safe.length : "") + ".csv";
      const label = "Safe file" + (safe.length > 1 ? ", part " + (i + 1) + " of " + safe.length : "");
      const b = el("button", { type: "button", class: "mSafe", text: label, "data-file": name });
      b.addEventListener("click", () => download(name, text));
      files.append(b);
    });
  } else {
    files.append(el("button", { type: "button", class: "mSafe", text: "Safe file", disabled: true,
      title: "Give the new token's address first: Safe's file names it on every row" }));
  }
  const plain = el("button", { type: "button", class: "ghost", id: "mPlain", text: "address,amount file", "data-file": stem + ".csv" });
  plain.addEventListener("click", () => download(stem + ".csv", plainFile(p.rows, s.newDecimals)));
  files.append(plain);
  if (!newOk) files.append(el("span", { class: "hint", text: newToken.error || "Give the new token's address for Safe's file." }));
}

function drawContracts(s) {
  const boxEl = $("mContractsBox");
  const list = $("mContracts");
  const contracts = snap.contractsLooked ? snap.holders.filter((h) => h.kind === "contract" || h.kind === "safe") : [];
  boxEl.hidden = !(snap.contractsLooked && $("mFindContracts").checked);
  if (boxEl.hidden) return;
  if (!contracts.length) { list.replaceChildren(el("p", { class: "note", text: "None of the holders is a contract." })); return; }
  const rows = contracts.slice(0, CONTRACTS_SHOWN).map((h) => {
    const out = choice.has(h.a) ? choice.get(h.a) : h.kind === "contract";
    const cb = el("input", { type: "checkbox", checked: out, "aria-label": "Leave out " + h.a });
    cb.addEventListener("change", () => { choice.set(h.a, cb.checked); draw(); });
    return el("tr", { "data-a": h.a }, [
      el("td", {}, [cb]),
      el("td", {}, [el("span", { class: "addr", text: checksum(h.a) })]),
      el("td", { class: "num", text: shown(h.bal, snap.decimals) }),
      el("td", { text: h.kind === "safe" ? "looks like a Safe" : "contract" }),
    ]);
  });
  list.replaceChildren(el("div", { class: "tableWrap" }, [el("table", {}, [
    el("thead", {}, [el("tr", {}, [el("th", { text: "Leave out" }), el("th", { text: "Address" }),
      el("th", { class: "num", text: "Old balance" }), el("th", { text: "What it is" })])]),
    el("tbody", {}, rows),
  ])]));
  if (contracts.length > CONTRACTS_SHOWN) {
    list.append(el("p", { class: "note", text: "The " + CONTRACTS_SHOWN + " largest of " + contracts.length.toLocaleString("en-US") +
      " contracts are listed; the others are left out." }));
  }
}

function drawTable(p, s) {
  const amounts = new Map(), whyOf = new Map();
  if (p) { for (const r of p.rows) amounts.set(r.a, r.amount); for (const o of p.out) whyOf.set(o.a, o.why); }
  const shownRows = snap.holders.slice(0, TABLE_ROWS);
  $("mTableNote").textContent = snap.holders.length > TABLE_ROWS
    ? "The " + TABLE_ROWS + " largest of " + snap.holders.length.toLocaleString("en-US") + " holders. The files have every one in the airdrop."
    : snap.holders.length.toLocaleString("en-US") + " holder" + (snap.holders.length === 1 ? "" : "s") + ", largest first.";
  const kindNote = (k) => (k === "delegated" ? "wallet (EIP-7702)" : k === "safe" ? "Safe" : k === "contract" ? "contract" : "");
  const rows = shownRows.map((h, i) => {
    const why = whyOf.get(h.a);
    const amount = amounts.get(h.a);
    return el("tr", { "data-a": h.a, class: why ? "left" : "" }, [
      el("td", { class: "num", text: String(i + 1) }),
      el("td", {}, [el("span", { class: "addr", text: checksum(h.a) })]),
      el("td", { class: "num", text: shown(h.bal, snap.decimals) }),
      el("td", { class: "num", text: amount !== undefined ? shown(amount, s.newDecimals) : "—" }),
      el("td", {}, [el("span", { class: "why", text: [why ? "left out: " + why : "", kindNote(h.kind)].filter(Boolean).join(" · ") })]),
    ]);
  });
  $("mTable").replaceChildren(el("div", { class: "tableWrap" }, [el("table", {}, [
    el("thead", {}, [el("tr", {}, [el("th", { class: "num", text: "#" }), el("th", { text: "Holder" }),
      el("th", { class: "num", text: "Old balance" }), el("th", { class: "num", text: "New tokens" }), el("th", { text: "" })])]),
    el("tbody", {}, rows),
  ])]));
}

// ---------------------------------------------------------------- the new token
let newRead = 0;
/// THE NEW TOKEN: its decimals and symbol, now, and whether the lens's
/// registry knows it as a launch. Read through the endpoint a snapshot reads.
async function readNew() {
  const a = lower($("mNew").value);
  const info = $("mNewInfo");
  const mine = ++newRead;
  newToken = { address: a, decimals: 18, symbol: "", read: false, error: "" };
  if (!a) { info.hidden = true; draw(); return; }
  if (!isAddr(a)) {
    newToken.error = "The new token is not an address: 0x and 40 hex characters.";
    info.hidden = false; info.className = "note bad"; info.textContent = newToken.error; draw(); return;
  }
  info.hidden = false; info.className = "note"; info.textContent = "Reading the new token…";
  try {
    const ep = endpoint();
    const r = Sh.reader(ep.url);
    const [d, sy] = await Promise.all([r.call(a, SEL.decimals), r.call(a, SEL.symbol).catch(() => "0x")]);
    const dec = firstWord(d);
    if (dec === null || dec > 77n) throw new Error("it did not answer decimals()");
    let registered = null;
    const lens = Bar.config().lens;
    if (isAddr(lens)) {
      try {
        const reg = "0x" + String(await r.call(lens, SEL.registry)).replace(/^0x/, "").slice(24, 64);
        registered = firstWord(await r.call(reg, SEL.isRegistered + pad(a))) === 1n;
      } catch { registered = null; }
    }
    if (mine !== newRead) return;
    newToken = { address: a, decimals: Number(dec), symbol: words(sy, 24), read: true, error: "" };
    info.className = registered === false ? "note warn" : "note";
    info.textContent = (newToken.symbol || "The new token") + ", " + newToken.decimals + " decimals" +
      (registered === true ? ", a Curb launch." : registered === false ? ". It is not a launch in Curb's registry: check the address." : ".");
  } catch (e) {
    if (mine !== newRead) return;
    newToken.error = "The new token could not be read: " + ((e && e.message) || e) + ".";
    info.className = "note bad";
    info.textContent = newToken.error;
  }
  draw();
}

// ---------------------------------------------------------------- what filling a curve costs
/// EVERY FACTORY THE LENS'S REGISTRY ADMITS: its asset, its graduation
/// threshold, and the largest dev buy at the lowest tax - read, never typed.
async function readCosts() {
  const box = $("mCosts");
  const cfg = Bar.config();
  if (!isAddr(cfg.lens)) {
    box.replaceChildren(el("p", { class: "note", text: "No lens is set, so the thresholds are not read here. The docs list them under Paired assets." }));
    return;
  }
  try {
    const r = Sh.reader(cfg.rpc);
    const word = async (to, data) => firstWord(await r.call(to, data));
    const addrAt = (raw) => "0x" + String(raw || "").replace(/^0x/, "").slice(24, 64);
    const registry = addrAt(await r.call(cfg.lens, SEL.registry));
    const n = Number(await word(registry, SEL.launcherCount));
    if (!Number.isSafeInteger(n) || n < 0 || n > 64) throw new Error("the registry did not say how many factories it has");
    const factories = (await r.calls(Array.from({ length: n }, (_, i) => ({ to: registry, data: SEL.launcherAt + hex(i).slice(2).padStart(64, "0") }))))
      .map((x) => (x ? addrAt(x) : null)).filter((f) => isAddr(f) && !(Bar.incident && Bar.incident.factoryHidden(f)));
    const names = ["quoteToken", "graduationThreshold", "supply", "maxDevBuyBps", "phantomQuote"];
    const got = await r.calls(factories.flatMap((f) => names.map((k) => ({ to: f, data: SEL[k] }))));
    const terms = factories.map((f, i) => {
      const w = (k) => got[i * names.length + names.indexOf(k)];
      return { f, quote: w("quoteToken") ? addrAt(w("quoteToken")) : null, threshold: firstWord(w("graduationThreshold")),
        supply: firstWord(w("supply")), bps: firstWord(w("maxDevBuyBps")), phantom: firstWord(w("phantomQuote")) };
    }).filter((t) => isAddr(t.quote) && t.threshold);
    const quotes = [...new Set(terms.map((t) => t.quote))];
    const qGot = await r.calls(quotes.flatMap((q) => [{ to: q, data: SEL.symbol }, { to: q, data: SEL.decimals }]));
    const qInfo = new Map(quotes.map((q, i) => [q, { sym: words(qGot[i * 2], 16), dec: firstWord(qGot[i * 2 + 1]) }]));
    const seen = new Set();
    const rows = [];
    for (const t of terms) {
      const q = qInfo.get(t.quote);
      if (!q || q.dec === null || q.dec > 77n) continue;
      const key = t.quote + "|" + t.threshold;
      if (seen.has(key)) continue;
      seen.add(key);
      const dec = Number(q.dec);
      // THE LARGEST DEV BUY: a new curve holds the whole supply against
      // phantomQuote, so a fifth of the supply costs phantom x bps / (10000 -
      // bps) into the curve, and the tax comes off the payment first.
      let dev = "—";
      if (t.supply && t.bps && t.bps > 0n && t.bps < 10000n && t.phantom) {
        const net = (t.phantom * t.bps) / (10000n - t.bps);
        dev = "about " + shown((net * 10000n + 9999n - MIN_TAX_BPS) / (10000n - MIN_TAX_BPS), dec) + " " + (q.sym || "");
      }
      rows.push(el("tr", {}, [el("td", { text: q.sym || t.quote }), el("td", { class: "num", text: shown(t.threshold, dec) + " " + (q.sym || "") }),
        el("td", { class: "num", text: dev })]));
    }
    // THE CAP, AS THE FACTORIES HOLD IT, when they all agree.
    const caps = new Set(terms.filter((t) => t.supply && t.bps).map((t) => t.supply + "|" + t.bps));
    if (caps.size === 1) {
      const t = terms.find((x) => x.supply && x.bps);
      capSupply = t.supply; capBps = t.bps;
      $("mCapLine").textContent = (Number(capBps) / 100) + "% of the supply (" + shown((capSupply * capBps) / 10000n, 18, 0) + " tokens)";
    }
    if (!rows.length) throw new Error("no factory answered");
    box.replaceChildren(el("div", { class: "tableWrap" }, [el("table", { id: "mCostTable" }, [
      el("thead", {}, [el("tr", {}, [el("th", { text: "Paired asset" }), el("th", { class: "num", text: "Fills the curve" }),
        el("th", { class: "num", text: "Largest dev buy, 1% tax" })])]),
      el("tbody", {}, rows),
    ])]));
    if (snap) draw();
  } catch (e) {
    box.replaceChildren(el("p", { class: "note", text: "The thresholds could not be read (" + ((e && e.message) || e) + "). The docs list them under Paired assets." }));
  }
}

// ---------------------------------------------------------------- wiring
/// A NEW SNAPSHOT REPLACES THE ONE SHOWN, and the choices made for its contracts.
$("mRun").addEventListener("click", () => {
  job = null;
  snap = null;
  choice.clear();
  $("mResult").hidden = true;
  run(false);
});
$("mContinue").addEventListener("click", () => run(true));
$("mStop").addEventListener("click", () => {
  if (!job) return;
  job.stopped = true;
  job.ctl.abort();
});
/// A STOPPED SNAPSHOT GOES ON ONLY WITH WHAT IT WAS STARTED WITH.
for (const id of ["mOld", "mBlock", "mFrom", "mRpc"]) {
  $(id).addEventListener("input", () => { if (!$("mStop").hidden) return; $("mContinue").hidden = true; });
}
$("mFindContracts").addEventListener("change", () => {
  // TICKED AFTER A SNAPSHOT READ WITHOUT IT: the codes are read now.
  if (snap && $("mFindContracts").checked && !snap.contractsLooked && job && job.list && $("mStop").hidden) {
    job.findContracts = true;
    run(true);
    return;
  }
  draw();
});
let typing = 0;
const later = (fn) => () => { clearTimeout(typing); typing = setTimeout(fn, 150); };
for (const id of ["mRatio", "mMin", "mExclude"]) $(id).addEventListener("input", later(draw));
let newTyping = 0;
$("mNew").addEventListener("input", () => { clearTimeout(newTyping); newTyping = setTimeout(readNew, 250); });

// A LINK MAY NAME THE OLD TOKEN (?token=0x…), so a project can hand its own.
try {
  const q = new URLSearchParams(location.search);
  if (isAddr(q.get("token"))) $("mOld").value = q.get("token").trim();
} catch { /* no query */ }

readCosts();

/// For the browser tests: the arithmetic and the files, with nothing read.
window.CurbMigrate = { parseUnits, parseRatio, scale, exact, shown, checksum, plan, safeFiles, plainFile, kindOf,
  snapshot: () => snap, constants: { SAFE_HEADER, SAFE_ROWS, BURN: [...BURN] } };
})();
