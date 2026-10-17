// HOLDER SHARING ON THE SITE: what a launch's distributor holds and has paid,
// what a holder is owed and how to take it, the check of every published
// epoch file, and the creator's one-way switch.
//
// TWO PAGES USE THIS FILE.
//   - A launch's own page (/token/0x..., app.html in its token view): the
//     "Holders earn" card for everyone, the holder's own panel, the verify
//     panel, and for the launch's creator the switch, the balances earned before
//     it, and the note that the liquidity is locked forever (#tvLocked) - there
//     is no withdrawal to offer. Every transaction it sends
//     goes through app.js's own pin, lock, record and receipt (CurbApp.send);
//     this file builds calldata and nothing else.
//   - /sharing (sharing.html): every distributor, the roles behind them and
//     every change announced to those roles, and the catalog's versions.
//
// NOTHING HERE IS TRUSTED THAT THE CHAIN DID NOT SAY. An epoch file is used only
// when its sha256 is the contentHash the distributor holds, wherever it came
// from (the site first, then IPFS gateways), and a chunk of one only when its
// sha256 is the one that file names; its tree is rebuilt from its leaves,
// never taken from it; and the check itself is services/sharer's own
// calculator, compiled for the browser (curb-share.mjs, loaded on first use).
(function () {
"use strict";
if (!window.CurbAbi || !window.CurbKeccak) return;

const { words, wordToAddress, wordToBig, wordToInt, utf8Hex, encode, T } = window.CurbAbi;
const { keccak256 } = window.CurbKeccak;
const $ = (id) => document.getElementById(id);
const sig = (s) => keccak256("0x" + utf8Hex(s)).slice(0, 10);
const topic = (s) => keccak256("0x" + utf8Hex(s));
const pad = (a) => String(a).toLowerCase().replace(/^0x/, "").padStart(64, "0");
const padNum = (n) => BigInt(n).toString(16).padStart(64, "0");
const same = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
const isAddr = (s) => /^0x[0-9a-fA-F]{40}$/.test(String(s || "").trim());
const ZERO = "0x0000000000000000000000000000000000000000";
const isZero = (a) => !a || same(a, ZERO);
const short = (a) => (isAddr(a) ? a.slice(0, 6) + "…" + a.slice(-4) : String(a || ""));
const hex = (n) => "0x" + BigInt(n).toString(16);
const WETH = "0x4200000000000000000000000000000000000006";
const STATE_VIEW = "0xa3c0c9b65bad0b08107aa264b0f3db444b867a71";   // Uniswap v4 StateView on Base

/// THE DISTRIBUTOR'S CONSTANTS, as v1 has them (HolderFeeDistributor): the veto
/// hour and the keeper's 2% are read off the contract where it matters; these
/// are for words only.
const VETO_WINDOW_S = 3600;
const ROLE_DELAY_S = 48 * 3600;
const ROLE_WINDOW_S = 7 * 86400;
const ADMISSION_DELAY_S = 7 * 86400;
/// A push of a leaf costs gas, so the keeper pushes only what is worth it: at
/// least about $0.05, and 25 times what pushing it costs (design D.2.6). Below
/// that a share builds up; it never expires, and the holder may claim it.
const PUSH_FLOOR_USD = 0.05;
/// How many leaves the page reads `paid` for, and pushes at once.
const LEAVES_READ_MAX = 1000;
const PUSH_BATCH = 100;
/// How far back an epoch's history is walked, file by file.
const HISTORY_MAX = 12;
/// WHAT THE PAGE TELLS A READER TO RUN to check a payout from the chain itself:
/// services/sharer's own CLI, from the repository, with every flag it needs.
/// It used to say `npx @curb/sharer verify`: that package is not published, so
/// the command failed - and a name nobody holds on npm is one anybody can take
/// and serve code under. It also left out --config, without which the CLI
/// refuses to run. The config and the files are this site's own.
///
/// WHERE THAT REPOSITORY IS: filled on deploy day (DEPLOY.txt STEP 5, 16
/// October 2026) with the public code repository
/// (services/sharer/RUNBOOK.md part 4.1), pinned to the commit the keeper
/// runs - a branch moves on, and a reader must run the code that made the
/// files - as
///   https://github.com/<org>/<repo>/tree/<the deployed commit, 40 hex>/services/sharer
/// The contracts were deployed from c26d22ac. The keeper and the guardian run
/// f4119446, which changes services/sharer only in how a refused eth_getLogs
/// is read (src/chain/logs.ts): the epoch files it makes are byte for byte
/// what c26d22ac makes. A keeper rebuilt from a commit that changes that code
/// moves this to that commit in the same change.
/// Left "", the page names the repository without an address.
const CODE_AT = "https://github.com/Curb-Dev/curb/tree/f41194461e1e25906da2ce1e0f3fd6ed7fb4dbcb/services/sharer";
const VERIFY_WHERE = "In services/sharer of the CURB repository" + (CODE_AT ? " (" + CODE_AT + ")" : "") +
  ", with Node 22.18 or later, after npm ci --omit=dev:";
function verifyCommand({ d, epoch, chainId, origin }) {
  const site = String(origin || "https://<this site>").replace(/\/+$/, "");
  return "node src/cli.ts verify --distributor " + (d || "<distributor>") + " --epoch " + (epoch || "<n>") +
    " --rpc <your RPC> --rpc <a second RPC> --config " + site + FILES_PATH + (chainId || "8453") + "/config.json --site " + site;
}

/// WHERE THE EPOCH FILES ARE: on the site under /sharing/<chain>/<distributor>/
/// <epoch>.json (the keeper publishes them there and pins them to IPFS), and
/// at the ipfs:// URI the distributor's RootPublished event names. The site is
/// asked first; a gateway is asked only when the site's copy is missing or
/// does not hash to what the chain holds.
const FILES_PATH = "/sharing/";
/// THE PINNERS' OWN GATEWAYS FIRST. The keeper pins every file on Filebase and
/// Pinata before its root goes on chain, so their public gateways hold it at
/// once (both answer CORS with *); the public ones after them must find it
/// over the DHT, may rate-limit, and a fetch here has no timeout.
const GATEWAYS = ["https://ipfs.filebase.io/ipfs/", "https://gateway.pinata.cloud/ipfs/", "https://ipfs.io/ipfs/", "https://dweb.link/ipfs/", "https://w3s.link/ipfs/"];
/// The browser build of services/sharer's calculator (CURB-SHARE v1).
const BUNDLE = "/curb-share.mjs";

const SEL = {
  // graduator
  holderDistributorOf: sig("holderDistributorOf(address)"), sharingSince: sig("sharingSince(address)"),
  lockOf: sig("lockOf(address)"), hasGraduated: sig("hasGraduated(address)"), sharingCatalog: sig("sharingCatalog()"),
  enableHolderSharing: sig("enableHolderSharing(address,address)"), registry: sig("registry()"),
  // distributor
  active: sig("active()"), pending: sig("pending()"), lastProposedEpoch: sig("lastProposedEpoch()"),
  received0: sig("received0()"), received1: sig("received1()"), totalPaid0: sig("totalPaid0()"),
  totalPaid1: sig("totalPaid1()"), keeperPaid0: sig("keeperPaid0()"), paid0: sig("paid0(address)"),
  paid1: sig("paid1(address)"), isExcluded: sig("isExcluded(address)"), factory: sig("factory()"),
  quoteToken: sig("quoteToken()"), launchToken: sig("launchToken()"), curve: sig("curve()"), hook: sig("hook()"),
  escrow: sig("escrow()"),
  claim: sig("claim(uint256,uint256,bytes32[],address)"),
  push: sig("push((address,uint256,uint256)[],bytes32[],bool[])"),
  // distributor factory
  frozen: sig("frozen()"), publisher: sig("publisher()"), pendingPublisher: sig("pendingPublisher()"),
  pendingPublisherAt: sig("pendingPublisherAt()"), keeperPayee: sig("keeperPayee()"),
  pendingKeeperPayee: sig("pendingKeeperPayee()"), pendingKeeperPayeeAt: sig("pendingKeeperPayeeAt()"),
  pendingUnfreezeAt: sig("pendingUnfreezeAt()"), isVetoer: sig("isVetoer(address)"),
  vetoerRemovalAt: sig("vetoerRemovalAt(address)"), owner: sig("owner()"), pendingOwner: sig("pendingOwner()"),
  version: sig("VERSION()"), predict: sig("predict(address)"),
  // catalog
  recommended: sig("recommended()"), isApproved: sig("isApproved(address)"), admittedAt: sig("admittedAt(address)"),
  retired: sig("retired(address)"),
  // lock
  held: sig("held(address,uint256)"), release: sig("release(address)"),

  holdsPosition: sig("holdsPosition()"), beneficiary: sig("beneficiary()"), tokenId: sig("tokenId()"),
  positionManager: sig("positionManager()"), poolKeyView: sig("poolKeyView()"),
  // curve, escrow, hook
  creatorTaxBalance: sig("creatorTaxBalance()"), quoteFeeBalance: sig("quoteFeeBalance()"),
  protocolFeeShareBps: sig("protocolFeeShareBps()"), deployer: sig("deployer()"), feeEscrow: sig("feeEscrow()"),
  escrowBalanceOf: sig("balanceOfToken(address,address)"), hookOwed: sig("owed(address,address)"),
  // erc20
  balanceOf: sig("balanceOf(address)"), symbol: sig("symbol()"), decimals: sig("decimals()"),
  totalSupply: sig("totalSupply()"),
  // lens
  launchCount: sig("launchCount()"), launchPage: sig("launchPage(uint256,uint256)"), graduator: sig("graduator()"),
  // v4
  getPositionLiquidity: sig("getPositionLiquidity(uint256)"), positionInfo: sig("positionInfo(uint256)"),
  getSlot0: sig("getSlot0(bytes32)"), getFeeGrowthInside: sig("getFeeGrowthInside(bytes32,int24,int24)"),
  getPositionInfo: sig("getPositionInfo(bytes32,address,int24,int24,bytes32)"),
};
const TOPIC = {
  rootPublished: topic("RootPublished(uint32,bytes32,uint64,uint64,uint128,uint128,uint128,bytes32,string,uint40)"),
  rootVetoed: topic("RootVetoed(uint32,bytes32)"),
  vetoerSet: topic("VetoerSet(address,bool)"),
  vetoerRemovalAnnounced: topic("VetoerRemovalAnnounced(address,uint64)"),
  factoryAdmitted: topic("FactoryAdmitted(address,uint64)"),
  factoryProposed: topic("FactoryProposed(address,uint64)"),
  factoryCancelled: topic("FactoryCancelled(address)"),
  factoryRetired: topic("FactoryRetired(address)"),
  recommendedSet: topic("RecommendedSet(address)"),
  holderSharingEnabled: topic("HolderSharingEnabled(address,address,address,address,bool,uint64)"),
};
/// THE DISTRIBUTOR'S AND THE LOCK'S OWN REFUSALS, as sentences (app.js
/// revertSentence reads the selector out of a simulation's revert).
const REFUSALS = {
  [sig("BadProof()")]: () => "the proof does not match the distributor's active root - the page's copy of the epoch file is not the one in force. Refresh and try again.",
  [sig("NoActiveRoot()")]: () => "no payout is active on this distributor yet.",
  [sig("NothingToClaim(address)")]: () => "this account has nothing left to take under the active payout.",
  [sig("Excluded(address)")]: (w) => wordToAddress(w[0]) + " is one of the addresses this distributor never pays (a pool, the curve, the lock or another platform contract).",
  [sig("TransferRefused(address,address)")]: (w) => "the transfer of " + wordToAddress(w[0]) + " to " + wordToAddress(w[1]) + " was refused - by the asset's issuer, most often, or because that address does not take it.",
  [sig("LeavesExceedRoot(uint8)")]: () => "these leaves would pay more than the active root declares.",
  [sig("NotTheBeneficiary(address)")]: () => "only this launch's creator wallet can switch its holder sharing on.",
  [sig("AlreadySharing(address)")]: () => "this launch's holder sharing is already on.",
  [sig("FactoryNotApproved(address)")]: (w) => "the distributor version " + wordToAddress(w[0]) + " is not approved by the catalog now. Refresh to read the one it approves.",
  [sig("NotADistributorForThisToken(address)")]: (w) => "the version built " + wordToAddress(w[0]) + ", which the Graduator refuses as this launch's distributor.",
  [sig("CurveIsAnotherLaunchs(address,address)")]: (w) => "the curve " + wordToAddress(w[0]) + " named in this launch's record sells another token (" + wordToAddress(w[1]) + "), so the Graduator will not switch its sharing on. This launch's record is not one to trust.",
  [sig("NothingHeld(address)")]: () => "the lock holds nothing for that address.",
  [sig("ReleaseRefused(address,uint256)")]: () => "the transfer was refused again; what is held stays held.",
  [sig("NoPositionHeld()")]: () => "the lock no longer holds the position.",
};

// ---------------------------------------------------------------- the node
let rpcId = 0;
/// WHERE A LOG READ GOES: web/config.js logsRpc when the endpoint is the
/// site's own (web/config.js rpc), as web/browse.js logsUrl says; any other
/// endpoint takes every read, logs included.
function logsUrl(url) {
  const c = window.CURB_SITE || {};
  const own = typeof c.rpc === "string" ? c.rpc.trim() : "";
  const logs = typeof c.logsRpc === "string" ? c.logsRpc.trim() : "";
  return logs && own && String(url || "").trim() === own ? logs : url;
}
/// THE MOST BLOCKS OF LOGS ASKED AT ONCE TO START WITH, where `url`'s logs go
/// to logsRpc: web/config.js logsBlocks (token.js logsCeiling). 0 elsewhere.
function logsCeiling(url) {
  const n = (window.CURB_SITE || {}).logsBlocks;
  return logsUrl(url) !== url && Number.isInteger(n) && n > 0 ? n : 0;
}
/// One JSON-RPC request. A node's error is marked fromNode, with its code and
/// data, so app.js's isRevert and revertSentence read it the way they read
/// their own.
async function rpcAt(url, method, params) {
  // THE SITE'S OWN ENDPOINT IS ASKED ITS CHAIN ONCE A VISIT (multicall.js chainId).
  const M = window.CurbMulti;
  if (method === "eth_chainId" && M && M.chainId) return M.chainId(url, () => rpcSend(url, method, params));
  return rpcSend(url, method, params);
}
/// The headers of a JSON-RPC POST to `url` (multicall.js headers): text/plain to
/// the site's own endpoints, so no CORS preflight is made first.
const rpcHeaders = (url) => (window.CurbMulti && window.CurbMulti.headers ? window.CurbMulti.headers(url)
  : { "content-type": "application/json" });
async function rpcSend(url, method, params) {
  const to = method === "eth_getLogs" ? logsUrl(url) : url;
  const res = await fetch(to, {
    method: "POST", headers: rpcHeaders(to),
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  if (!res.ok) throw new Error("The endpoint answered HTTP " + res.status + " rather than a result.");
  const body = await res.json();
  if (body.error) {
    throw Object.assign(new Error(body.error.message || JSON.stringify(body.error)),
      { fromNode: true, code: body.error.code, data: body.error.data });
  }
  if (!body || !Object.prototype.hasOwnProperty.call(body, "result")) {
    throw new Error("The endpoint answered " + method + " with neither a result nor an error.");
  }
  return body.result;
}
/// ONE eth_call; at "latest" on the site's own endpoint it goes out with the
/// reads made at the same moment (multicall.js), and a revert among them is
/// thrown as rpcAt throws one the node answered.
function gathered(url, to, data, block) {
  const M = window.CurbMulti;
  if (block || !M || !M.on(url)) return rpcAt(url, "eth_call", [{ to, data }, block || "latest"]);
  return M.call(url, to, data, () => rpcAt(url, "eth_call", [{ to, data }, "latest"])).then((r) => {
    if (r.ok) return r.data;
    throw Object.assign(new Error("execution reverted"), { fromNode: true, code: 3, data: r.data });
  });
}
/// Several eth_calls in one request where the endpoint takes a batch, one at a
/// time where it does not. Each answer is its result, or null where it failed.
/// On the site's own endpoint they are gathered by multicall.js instead.
async function callsAt(url, calls) {
  if (!calls.length) return [];
  const M = window.CurbMulti;
  if (M && M.on(url) && calls.every((c) => !c.block)) {
    return Promise.all(calls.map((c) => gathered(url, c.to, c.data).catch(() => null)));
  }
  const out = [];
  for (let i = 0; i < calls.length; i += 100) {
    const part = calls.slice(i, i + 100);
    let got = null;
    try {
      const res = await fetch(url, {
        method: "POST", headers: rpcHeaders(url),
        body: JSON.stringify(part.map((c, j) => ({ jsonrpc: "2.0", id: j + 1, method: "eth_call",
          params: [{ to: c.to, data: c.data }, c.block || "latest"] }))),
      });
      const arr = await res.json();
      if (!Array.isArray(arr)) throw new Error("no batch");
      const byId = new Map(arr.map((r) => [r.id, r]));
      got = part.map((_, j) => { const r = byId.get(j + 1); return r && !r.error ? r.result : null; });
    } catch {
      got = [];
      for (const c of part) got.push(await rpcAt(url, "eth_call", [{ to: c.to, data: c.data }, c.block || "latest"]).catch(() => null));
    }
    out.push(...got);
  }
  return out;
}
const w0 = (raw) => { const w = words(raw || "0x"); return w.length ? w[0] : null; };
const big = (raw) => { const w = w0(raw); return w === null ? null : wordToBig(w); };
const addr = (raw) => { const w = w0(raw); return w === null ? null : wordToAddress(w); };

/// A reader bound to one endpoint.
function reader(url) {
  const call = (to, data, block) => gathered(url, to, data, block);
  return {
    url,
    call,
    calls: (list) => callsAt(url, list),
    rpc: (m, p) => rpcAt(url, m, p),
    async head() {
      const b = await rpcAt(url, "eth_getBlockByNumber", ["latest", false]);
      return { number: parseInt(b.number, 16), ts: parseInt(b.timestamp, 16), at: Date.now() };
    },
  };
}

// ---------------------------------------------------------------- reading the contracts
/// A Root as the distributor's active() and pending() return it: nine words.
function decodeRoot(raw) {
  const w = words(raw);
  if (w.length < 9) throw new Error("the distributor answered " + w.length + " words for a root, expected 9");
  return {
    merkleRoot: "0x" + w[0], contentHash: "0x" + w[1],
    cumHolders0: wordToBig(w[2]), cumHolders1: wordToBig(w[3]), cumKeeper0: wordToBig(w[4]),
    fromBlock: wordToBig(w[5]), toBlock: wordToBig(w[6]), epoch: Number(wordToBig(w[7])),
    payableAt: Number(wordToBig(w[8])),
  };
}

/// Everything about one distributor that the pages draw, in one batch.
async function readDistributor(r, d) {
  const names = ["active", "pending", "lastProposedEpoch", "received0", "received1", "totalPaid0", "totalPaid1",
    "keeperPaid0", "factory", "launchToken", "quoteToken", "curve", "hook", "escrow"];
  const got = await r.calls(names.map((n) => ({ to: d, data: SEL[n] })));
  const by = Object.fromEntries(names.map((n, i) => [n, got[i]]));
  if (!by.active || !by.factory) throw new Error("the distributor at " + d + " did not answer");
  const out = {
    d, active: decodeRoot(by.active), pending: decodeRoot(by.pending),
    lastProposed: Number(big(by.lastProposedEpoch) || 0n),
    received0: big(by.received0), received1: big(by.received1),
    totalPaid0: big(by.totalPaid0), totalPaid1: big(by.totalPaid1), keeperPaid0: big(by.keeperPaid0),
    factory: addr(by.factory), launchToken: addr(by.launchToken), quoteToken: addr(by.quoteToken),
    curve: addr(by.curve), hook: addr(by.hook), escrow: addr(by.escrow),
  };
  out.frozen = big(await r.call(out.factory, SEL.frozen).catch(() => "0x")) === 1n;
  return out;
}

/// THE ROOT A CLAIM OR A PUSH SENT NOW WOULD MEET. claim(), push() and
/// payKeeper() promote a ripe pending root on the way in - unless the factory
/// is frozen - so a pending root whose hour is over is the one in force.
function inForce(dist, now) {
  const p = dist.pending;
  const ripe = p.payableAt !== 0 && now >= p.payableAt && !dist.frozen;
  return ripe ? { root: p, ripe: true } : { root: dist.active, ripe: false };
}
/// A pending root is meaningful only while its payableAt is not zero.
const hasPending = (dist) => dist.pending.payableAt !== 0;

/// THE EPOCH NUMBERS VETOED since the root in force: every number between it
/// and the last one proposed that is not the pending root's. Earlier vetoes
/// are in each later file's `supersedes`.
function vetoedSince(dist) {
  const out = [];
  const from = Math.max(dist.active.epoch, 0);
  for (let n = from + 1; n <= dist.lastProposed; n++) {
    if (hasPending(dist) && dist.pending.epoch === n) continue;
    out.push(n);
  }
  return out;
}

/// The distributor factory's roles, and every change announced to them.
async function readRoles(r, f) {
  const names = ["version", "publisher", "pendingPublisher", "pendingPublisherAt", "keeperPayee", "pendingKeeperPayee",
    "pendingKeeperPayeeAt", "frozen", "pendingUnfreezeAt", "owner", "pendingOwner"];
  const got = await r.calls(names.map((n) => ({ to: f, data: SEL[n] })));
  const by = Object.fromEntries(names.map((n, i) => [n, got[i]]));
  return {
    f, version: big(by.version), publisher: addr(by.publisher), pendingPublisher: addr(by.pendingPublisher),
    pendingPublisherAt: Number(big(by.pendingPublisherAt) || 0n), keeperPayee: addr(by.keeperPayee),
    pendingKeeperPayee: addr(by.pendingKeeperPayee), pendingKeeperPayeeAt: Number(big(by.pendingKeeperPayeeAt) || 0n),
    frozen: big(by.frozen) === 1n, pendingUnfreezeAt: Number(big(by.pendingUnfreezeAt) || 0n),
    owner: addr(by.owner), pendingOwner: addr(by.pendingOwner),
  };
}

/// AN ANNOUNCED CHANGE THAT CAN STILL HAPPEN: announced (at != 0) and not yet
/// past the window in which anyone may execute it. Expired ones are history.
const live = (at, now) => at !== 0 && now <= at + ROLE_WINDOW_S;

/// The warnings an announced change deserves, as sentences.
function roleWarnings(roles, now, removals) {
  const out = [];
  const when = (at) => (at <= now ? "now" : "from " + new Date(at * 1000).toLocaleString());
  if (roles.frozen) {
    out.push("Publishing is frozen: no new payout is published, and one already published waits, still vetoable. " +
      "Payouts already in force keep paying.");
  }
  if (live(roles.pendingUnfreezeAt, now)) out.push("An end to the freeze is announced: publishing can resume " + when(roles.pendingUnfreezeAt) + ", unless a vetoer freezes again first, which cancels it.");
  if (!isZero(roles.pendingPublisher) && live(roles.pendingPublisherAt, now)) {
    out.push("A new publisher, " + roles.pendingPublisher + ", is announced and can take over " + when(roles.pendingPublisherAt) + ".");
  }
  if (!isZero(roles.pendingKeeperPayee) && live(roles.pendingKeeperPayeeAt, now)) {
    out.push("A new keeper payee, " + roles.pendingKeeperPayee + ", is announced and can take over " +
      when(roles.pendingKeeperPayeeAt) + ".");
  }
  for (const x of removals || []) {
    out.push("Removing the vetoer " + x.account + " is announced: it can be removed " + when(x.at) +
      ", once no payout is still inside its veto hour.");
  }
  if (isZero(roles.publisher)) out.push("There is no publisher: no new payout can be published until one is named.");
  return out;
}

/// The catalog's verdict on one version.
async function readCatalog(r, c) {
  const [rec, boot] = await r.calls([{ to: c, data: SEL.recommended }, { to: c, data: sig("bootstrapUntil()") }]);
  return { c, recommended: addr(rec), bootstrapUntil: Number(big(boot) || 0n) };
}

// ---------------------------------------------------------------- logs
/// WHAT KIND OF REFUSAL, as web/browse.js logError sorts them: a result-size
/// refusal halves the window and grows back, a block-range refusal halves it
/// and holds, anything else is asked again after a pause. The error's data is
/// read as well when it is a string - where Tenderly's public gateway says a
/// range was too wide, under the bare message "invalid params".
function logError(e) {
  const msg = String((e && e.message) || "") + (e && typeof e.data === "string" ? " | " + e.data : "");
  if ((e && (e.status === 429 || e.code === 429)) || /rate|too many requests|timeout|timed out/i.test(msg)) return "busy";
  if ((e && e.code === -32005) ||
      /more than [\d,]+ (results|logs)|query returned|too many (results|logs)|response size|size exceed/i.test(msg)) return "size";
  if (/range|too many blocks|limit exceeded/i.test(msg)) return "range";
  return "busy";
}
/// eth_getLogs over [from, to] in windows that adapt to what the endpoint
/// refuses. `budget` caps the requests; past it the scan stops and says so.
async function getLogs(r, filter, from, to, budget = 400) {
  const out = [];
  // NO WIDER THAN THE CEILING config.js STATES for the log endpoint (logsCeiling):
  // from 10,000 a 1,000-block ceiling cost four refusals before every read.
  const said = logsCeiling(r.url);
  let size = said ? Math.min(10000, said) : 10000, cap = said || 100000, busy = 0, asked = 0;
  let start = from;
  while (start <= to) {
    if (++asked > budget) return { logs: out, complete: false, reached: start - 1 };
    const end = Math.min(to, start + size - 1);
    try {
      const logs = await r.rpc("eth_getLogs", [{ ...filter, fromBlock: hex(start), toBlock: hex(end) }]);
      out.push(...(logs || []));
      start = end + 1;
      busy = 0;
      if (size < cap) size = Math.min(cap, size * 2);
    } catch (e) {
      const kind = logError(e);
      if (kind === "busy") {
        if (++busy > 4) throw e;
        await new Promise((res) => setTimeout(res, 500 * 2 ** (busy - 1)));
        continue;
      }
      if (size <= 250) throw e;
      size = Math.max(250, Math.floor(size / 2));
      if (kind === "range") cap = size;
    }
  }
  return { logs: out, complete: true, reached: to };
}

/// THE LOWEST BLOCK WORTH ASKING ABOUT on a local fork: nothing of a deployment
/// made on it exists below the block it forked at (token.js forkFloor). On a
/// real network the method does not exist and this is 0.
const forkFloors = new Map();
/// WHETHER AN ENDPOINT MAY BE A LOCAL FORK, worth asking where it forked: one
/// on this machine, or over plain http (token.js mayBeFork).
function mayBeFork(url) {
  let u;
  try { u = new URL(String(url || "")); } catch { return true; }
  return u.protocol !== "https:" || /^(localhost|127(\.\d{1,3}){3}|\[::1\])$|\.localhost$/i.test(u.hostname);
}
function forkFloor(r) {
  if (!forkFloors.has(r.url)) {
    forkFloors.set(r.url, !mayBeFork(r.url) ? Promise.resolve(0) : r.rpc("anvil_metadata", [])
      .then((m) => (m && m.forkedNetwork && Number(m.forkedNetwork.forkBlockNumber) >= 0 ? Number(m.forkedNetwork.forkBlockNumber) + 1 : 0))
      .catch(() => 0));
  }
  return forkFloors.get(r.url);
}

/// THE FIRST BLOCK WHOSE TIME IS AT LEAST `ts`, by bisection between lo and hi.
async function blockAtTime(r, ts, lo, hi) {
  const tsOf = async (n) => parseInt((await r.rpc("eth_getBlockByNumber", [hex(n), false])).timestamp, 16);
  if (await tsOf(hi) < ts) return hi;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (await tsOf(mid) >= ts) hi = mid; else lo = mid + 1;
  }
  return lo;
}

/// THE BLOCK A CONTRACT WAS DEPLOYED IN, by bisection on its code - from the
/// fork's own block on a fork. An endpoint that keeps no old state refuses the
/// old reads, and then the floor is a lookback from the head instead.
async function deployBlock(r, a, headNumber, lookback = 2_000_000) {
  const floor = Math.max(await forkFloor(r), 0);
  const has = async (n) => (await r.rpc("eth_getCode", [a, hex(n)])) !== "0x";
  try {
    let lo = floor, hi = headNumber;
    if (!(await has(hi))) return null;
    if (await has(lo)) return lo;
    while (lo + 1 < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (await has(mid)) hi = mid; else lo = mid;
    }
    return hi;
  } catch {
    return Math.max(floor, headNumber - lookback);
  }
}

/// The RootPublished event of one root: it names the file's URI. The root was
/// published VETO_WINDOW before its payableAt, so its block is found by time,
/// and only that block's logs are asked for.
async function publishedEvent(r, d, root, headNumber) {
  if (!root.payableAt && !root.epoch) return null;
  // payableAt of an active root is kept (only pending's flag is cleared), so
  // both are found the same way.
  const at = root.payableAt - VETO_WINDOW_S;
  const lo = Number(root.toBlock) + 1;
  if (!(at > 0) || lo > headNumber) return null;
  const b = await blockAtTime(r, at, lo, headNumber);
  const logs = await r.rpc("eth_getLogs", [{ address: d, topics: [TOPIC.rootPublished, "0x" + padNum(root.epoch)],
    fromBlock: hex(Math.max(lo, b - 2)), toBlock: hex(Math.min(headNumber, b + 2)) }]);
  if (!logs || !logs.length) return null;
  const l = logs[logs.length - 1];
  return { uri: decodeEventUri(l.data), block: parseInt(l.blockNumber, 16), tx: l.transactionHash };
}
/// RootPublished's data: merkleRoot, fromBlock, toBlock, dH0, dH1, dK,
/// contentHash, then the uri's offset, then payableAt.
function decodeEventUri(data) {
  const h = String(data || "").replace(/^0x/, "");
  const off = Number(BigInt("0x" + h.slice(7 * 64, 8 * 64))) * 2;
  const len = Number(BigInt("0x" + h.slice(off, off + 64)));
  const bytes = h.slice(off + 64, off + 64 + len * 2);
  return new TextDecoder().decode(Uint8Array.from(bytes.match(/../g) || [], (x) => parseInt(x, 16)));
}

// ---------------------------------------------------------------- the epoch files
let bundle = null;
/// services/sharer's calculator for the browser, loaded on first use.
function share() {
  if (!bundle) bundle = import(BUNDLE).catch((e) => { bundle = null; throw e; });
  return bundle;
}
async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return "0x" + Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}
/// The bytes at `url`: gunzipped when they arrive gzipped and undecoded.
async function fetchBytes(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  let bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b && typeof DecompressionStream === "function") {
    const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    bytes = new Uint8Array(await new Response(s).arrayBuffer());
  }
  return bytes;
}
/// The site's own path for an epoch file.
const siteFile = (chainId, d, epoch) => FILES_PATH + chainId + "/" + d.toLowerCase() + "/" + epoch + ".json";
/// The gateway URLs for an ipfs:// URI, or none for anything else.
function gatewayUrls(uri) {
  const m = /^ipfs:\/\/(?:ipfs\/)?([A-Za-z0-9]+)(\/[^\s?#]*)?$/.exec(String(uri || ""));
  return m ? GATEWAYS.map((g) => g + m[1] + (m[2] || "")) : [];
}

const fileCache = new Map();   // contentHash -> { bytes, source }
/// AN EPOCH FILE WHOSE sha256 IS THE CONTENT HASH THE CHAIN HOLDS: from the
/// site, then each gateway for its URI. Each source's outcome is kept in
/// `tried`. When no copy hashes right, the last copy fetched is returned too,
/// marked not ok - the verify panel shows what is wrong with it; nothing else
/// uses it.
/// `uri` may be a function that finds it: it is asked only once the site's copy
/// has failed, since finding it costs a search for the event.
async function loadFile({ chainId, d, epoch, contentHash, uri }) {
  const want = String(contentHash).toLowerCase();
  if (fileCache.has(want)) return { ok: true, ...fileCache.get(want), tried: [] };
  const sources = [siteFile(chainId, d, epoch)];
  const tried = [];
  let last = null;
  let gateways = false;
  for (let i = 0; i < sources.length || !gateways; i++) {
    if (i >= sources.length) {
      gateways = true;
      let u = uri;
      try { u = typeof uri === "function" ? await uri() : uri; } catch { u = ""; }
      sources.push(...gatewayUrls(u));
      if (i >= sources.length) break;
    }
    const src = sources[i];
    try {
      const bytes = await fetchBytes(src);
      const h = await sha256Hex(bytes);
      tried.push({ src, hash: h, ok: h === want });
      if (h === want) {
        fileCache.set(want, { bytes, source: src });
        return { ok: true, bytes, source: src, tried };
      }
      last = { bytes, source: src };
    } catch (e) {
      tried.push({ src, error: (e && e.message) || String(e) });
    }
  }
  return { ok: false, bytes: last ? last.bytes : null, source: last ? last.source : "", tried };
}

/// A CHUNK OF AN EPOCH FILE WHOSE sha256 IS THE ONE ITS INDEX NAMES. Past 512
/// accounts a file keeps its rows in chunk files: the file the chain hashes
/// (the index) names each chunk by its sha256, so the site serves it at
/// /sharing/<chain>/<distributor>/chunks/<sha256>.json and IPFS at the CID
/// that hash is; nothing else about a chunk is trusted.
async function loadChunk({ chainId, d, chunk }) {
  const s = await share();
  const want = String(chunk.sha256).toLowerCase();
  if (fileCache.has(want)) return { ok: true, ...fileCache.get(want), tried: [] };
  const cid = s.chunkCid(chunk);
  const sources = ["/" + s.chunkPath(chainId, d, want), ...(cid ? GATEWAYS.map((g) => g + cid) : [])];
  const tried = [];
  for (const src of sources) {
    try {
      const bytes = await fetchBytes(src);
      const h = await sha256Hex(bytes);
      tried.push({ src, hash: h, ok: h === want });
      if (h === want) {
        fileCache.set(want, { bytes, source: src });
        return { ok: true, bytes, source: src, tried };
      }
    } catch (e) {
      tried.push({ src, error: (e && e.message) || String(e) });
    }
  }
  return { ok: false, bytes: null, source: "", tried };
}

/// A VERIFIED FILE, PARSED: its leaves, rows and window. A file of at most 512
/// accounts carries them all; past that the page reads only the chunk that
/// holds `account` - its row, its leaf and what proves it against the root -
/// and with no account none (`parts` then names what the rows cover). The
/// page never needs every account's row, so it never fetches every chunk.
async function parsedFile(bytes, { account } = {}) {
  const s = await share();
  const index = s.parseEpochIndex(bytes);
  if (!index.chunks.length) return s.parseEpochFile(bytes);
  const k = account ? s.chunkIndexOf(index, account) : -1;
  if (k < 0) return s.epochPart(bytes, -1, null);
  const got = await loadChunk({ chainId: index.chainId, d: index.distributor, chunk: index.chunks[k] });
  if (!got.ok) throw new Error("the part of the payout file that holds " + short(account) + " could not be fetched with the hash the file names");
  return s.epochPart(bytes, k, got.bytes);
}

/// THE PART OF A CHUNKED FILE THIS PAGE CHECKS: the chunk holding `account`,
/// or the first one; null for a file whose rows are in it. { k, got }.
async function chunkToCheck(s, ctx, d, index, account) {
  if (!index || !index.chunks.length) return null;
  const at = account ? s.chunkIndexOf(index, account) : -1;
  const k = at >= 0 ? at : 0;
  return { k, got: await loadChunk({ chainId: ctx.chainId, d, chunk: index.chunks[k] }) };
}

/// THE CHECK OF ONE EPOCH, step by step, as the verify panel draws it - with
/// services/sharer's own verifyEpochFile, given the chain's figures for that
/// root and, when it can be fetched, the epoch before it. A file past 512
/// accounts keeps its rows in chunks: the page checks the index and the chunk
/// that holds the account (the first one without an account) - the root over
/// every chunk's root, the chunks' sums against the on-chain totals, that
/// chunk's rows, shares and root - and says so; the guardian and the
/// verifiers check every chunk.
async function checkEpoch(ctx, dist, root, uri, account) {
  const s = await share();
  const got = await loadFile({ chainId: ctx.chainId, d: dist.d, epoch: root.epoch, contentHash: root.contentHash, uri });
  const steps = [];
  steps.push({ key: "fetch", ok: !!got.bytes, text: got.bytes
    ? "Fetched from " + got.source
    : "No copy could be fetched (" + (got.tried.map((t) => t.src + ": " + (t.error || "wrong hash")).join("; ") || "no source") + ")" });
  if (!got.bytes) return { steps, problems: [], tried: got.tried };
  const hash = s.sha256Hex(got.bytes);
  steps.push({ key: "hash", ok: hash === root.contentHash.toLowerCase(),
    text: "sha256 " + hash + (hash === root.contentHash.toLowerCase() ? " is " : " is not ") + "the on-chain contentHash " + root.contentHash });
  let index = null;
  try { index = s.parseEpochIndex(got.bytes); } catch { index = null; }
  const part = await chunkToCheck(s, ctx, dist.d, index, account);
  if (part) {
    const c = index.chunks[part.k];
    steps.push({ key: "chunk", ok: part.got.ok, text: part.got.ok
      ? "Its " + c.count + " accounts from " + short(c.first) + " to " + short(c.last) + " - chunk " + (part.k + 1) + " of " + index.chunks.length +
        ", fetched from " + part.got.source + " - hash to the sha256 the file names. This page checks that chunk and the file's figures for the others; the guardian checks every chunk"
      : "Chunk " + (part.k + 1) + " of " + index.chunks.length + " could not be fetched with the sha256 the file names (" +
        (part.got.tried.map((t) => t.src + ": " + (t.error || "wrong hash")).join("; ") || "no source") + ")" });
  }
  let prev = null;
  if (index && index.prev) {
    const p = await loadFile({ chainId: ctx.chainId, d: dist.d, epoch: Number(index.prev.epoch), contentHash: index.prev.contentHash, uri: index.prev.uri });
    if (p.ok) {
      // the earlier file whole, or its chunk holding the same account
      try {
        const pi = s.parseEpochIndex(p.bytes);
        const pp = await chunkToCheck(s, ctx, dist.d, pi, account || (part && index.chunks[part.k].first));
        prev = !pp ? s.parseEpochFile(p.bytes) : pp.got.ok ? s.epochPart(p.bytes, pp.k, pp.got.bytes) : null;
      } catch { prev = null; }
    }
  }
  const chainRoot = {
    distributor: dist.d, epoch: BigInt(root.epoch), contentHash: root.contentHash, merkleRoot: root.merkleRoot,
    cumHolders0: root.cumHolders0, cumHolders1: root.cumHolders1, cumKeeper0: root.cumKeeper0,
    fromBlock: root.fromBlock, toBlock: root.toBlock,
  };
  const v = s.verifyEpochFile(got.bytes, chainRoot, prev, part ? { chunks: part.got.ok ? [part.got.bytes] : [], partial: true } : {});
  const f = v.file;
  const problems = [...v.problems];
  if (part && !part.got.ok) problems.push("chunk " + (part.k + 1) + " could not be fetched, so its rows were not checked");
  let rebuilt = "";
  try { rebuilt = f && f.merkle.leaves.length ? s.treeOf(f).root : ""; } catch { rebuilt = ""; }
  steps.push({ key: "root", ok: !!rebuilt && rebuilt === root.merkleRoot.toLowerCase(),
    text: "Merkle root rebuilt from the file's " + (part ? "chunk roots, the chunk checked rebuilt from its leaves: " : "leaves: ") + (rebuilt || "(none)") +
      (rebuilt === root.merkleRoot.toLowerCase() ? " - the on-chain root" : ", not the on-chain root " + root.merkleRoot) });
  const t = v.totals;
  const totalsOk = !!t && t.cumHolders0 === root.cumHolders0 && t.cumHolders1 === root.cumHolders1 && t.cumKeeper0 === root.cumKeeper0;
  const capOk = !v.problems.some((p) => /2% cap|keeper fee/.test(p));
  steps.push({ key: "totals", ok: totalsOk && capOk,
    text: (totalsOk ? (part ? "The chunks' sums add up to the on-chain totals" : "The leaves sum to the on-chain totals")
      : (part ? "The chunks' sums do not add up to the on-chain totals" : "The leaves do not sum to the on-chain totals")) +
      (f ? "; keeper fee " + f.keeper.fee + (capOk ? ", within 2% of the payout" : ", above the 2% cap") : "") });
  let mine = null;
  if (f && account) {
    let p = null;
    try { p = s.proofOf(s.treeOf(f), account); } catch { p = null; }
    if (p) {
      const leaf = s.leafHash(dist.d.toLowerCase(), account.toLowerCase(), p.cum0, p.cum1);
      mine = { ...p, leaf, verified: s.verifyProof(root.merkleRoot, leaf, p.proof) };
    }
    steps.push({ key: "leaf", ok: !mine || mine.verified,
      text: mine ? "Your leaf proves against the on-chain root (" + mine.proof.length + " hashes)" : "This file has no leaf for your account" });
  }
  steps.push({ key: "prev", ok: true, info: true, text: prev
    ? "Checked against epoch " + prev.epoch + "'s file too: the range continues it, and no earlier share " + (part ? "in this chunk " : "") + "was dropped"
    : index && index.prev ? "Epoch " + index.prev.epoch + "'s file could not be fetched, so the link to it was not checked"
    : "The first epoch: there is no earlier file" });
  return { steps, problems, ok: v.ok && problems.length === v.problems.length, file: f, mine, source: got.source, tried: got.tried };
}

/// The cumulative values an account's leaf holds in a parsed file, or zeros.
function leafOf(file, account) {
  const a = String(account).toLowerCase();
  for (const l of file.merkle.leaves) if (l[1] === a) return { cum0: BigInt(l[2]), cum1: BigInt(l[3]) };
  return { cum0: 0n, cum1: 0n };
}
function rowOf(file, account) {
  const a = String(account).toLowerCase();
  return file.accounts.find((x) => x.a === a) || null;
}

// ---------------------------------------------------------------- Uniswap v4 arithmetic
// WHAT THE LOCKED POSITION HOLDS AND HAS EARNED, at the pool's price now. It
// takes the position's ticks, the pool's price and v4's tick arithmetic,
// ported here.
const Q96 = 1n << 96n;
const Q128 = 1n << 128n;
const MAX_U256 = (1n << 256n) - 1n;
const TICK_FACTORS = [
  [0x2n, 0xfff97272373d413259a46990580e213an], [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n], [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20n, 0xff973b41fa98c081472e6896dfb254c0n], [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n], [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200n, 0xf987a7253ac413176f2b074cf7815e54n], [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n], [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n], [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000n, 0x31be135f97d08fd981231505542fcfa6n], [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000n, 0x5d6af8dedb81196699c329225ee604n], [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000n, 0x48a170391f7dc42444e8fa2n],
];
/// TickMath.getSqrtPriceAtTick, exactly.
function sqrtAtTick(tick) {
  const t = BigInt(tick);
  const abs = t < 0n ? -t : t;
  if (abs > 887272n) throw new Error("tick out of range");
  let ratio = (abs & 1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  for (const [bit, f] of TICK_FACTORS) if ((abs & bit) !== 0n) ratio = (ratio * f) >> 128n;
  if (t > 0n) ratio = MAX_U256 / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}
/// What `liquidity` between two ticks is worth at sqrtP, rounded down as a
/// removal pays it (LiquidityAmounts / SqrtPriceMath).
function amountsFor(liquidity, sqrtP, tickLower, tickUpper) {
  let sa = sqrtAtTick(tickLower), sb = sqrtAtTick(tickUpper);
  if (sa > sb) [sa, sb] = [sb, sa];
  const L = BigInt(liquidity);
  const a0 = (lo, hi) => ((L * Q96 * (hi - lo)) / hi) / lo;
  const a1 = (lo, hi) => (L * (hi - lo)) / Q96;
  if (sqrtP <= sa) return { amount0: a0(sa, sb), amount1: 0n };
  if (sqrtP >= sb) return { amount0: 0n, amount1: a1(sa, sb) };
  return { amount0: a0(sqrtP, sb), amount1: a1(sa, sqrtP) };
}
/// PositionInfo, packed: | 200 bits poolId | 24 tickUpper | 24 tickLower | 8 hasSubscriber |.
function ticksOf(info) {
  const x = BigInt(info);
  const s24 = (v) => { const n = v & 0xffffffn; return Number(n >= 0x800000n ? n - 0x1000000n : n); };
  return { tickLower: s24(x >> 8n), tickUpper: s24(x >> 32n) };
}
function poolIdOf(key) {
  return keccak256(encode([T.tuple([T.address, T.address, T.uint(24), T.int(24), T.address])],
    [[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]]));
}

/// THE LOCKED POSITION, AS THE CHAIN HOLDS IT NOW: its liquidity, its ticks,
/// the pool's price, what the principal is worth, and the LP fees accrued and
/// not yet collected (v4's fee growth inside the range, since the position's
/// last update).
async function readPosition(r, lock) {
  const [pm, idW, keyW, holds] = await r.calls([
    { to: lock, data: SEL.positionManager }, { to: lock, data: SEL.tokenId }, { to: lock, data: SEL.poolKeyView },
    { to: lock, data: SEL.holdsPosition },
  ]);
  const out = { holds: big(holds) === 1n };
  const kw = words(keyW || "0x");
  if (!pm || !idW || kw.length < 5) return out;
  const key = { currency0: wordToAddress(kw[0]), currency1: wordToAddress(kw[1]), fee: wordToBig(kw[2]),
    tickSpacing: wordToInt(kw[3], 24), hooks: wordToAddress(kw[4]) };
  const tokenId = big(idW);
  const id = poolIdOf(key);
  const positionManager = addr(pm);
  const [liqW, infoW, slotW] = await r.calls([
    { to: positionManager, data: SEL.getPositionLiquidity + padNum(tokenId) },
    { to: positionManager, data: SEL.positionInfo + padNum(tokenId) },
    { to: STATE_VIEW, data: SEL.getSlot0 + id.slice(2) },
  ]);
  if (!liqW || !infoW || !slotW) return { ...out, key };
  const liquidity = big(liqW);
  const { tickLower, tickUpper } = ticksOf(big(infoW));
  const sqrtP = big(slotW);
  const principal = amountsFor(liquidity, sqrtP, tickLower, tickUpper);
  let fees = null;
  try {
    const tl = padNum(BigInt.asUintN(256, BigInt(tickLower))), tu = padNum(BigInt.asUintN(256, BigInt(tickUpper)));
    const [inside, pos] = await r.calls([
      { to: STATE_VIEW, data: SEL.getFeeGrowthInside + id.slice(2) + tl + tu },
      { to: STATE_VIEW, data: SEL.getPositionInfo + id.slice(2) + pad(positionManager) + tl + tu + padNum(tokenId) },
    ]);
    const iw = words(inside), pw = words(pos);
    if (iw.length >= 2 && pw.length >= 3) {
      const grow = (now, last) => ((((wordToBig(now) - wordToBig(last)) % (1n << 256n)) + (1n << 256n)) % (1n << 256n));
      fees = { amount0: (grow(iw[0], pw[1]) * wordToBig(pw[0])) / Q128, amount1: (grow(iw[1], pw[2]) * wordToBig(pw[0])) / Q128 };
    }
  } catch { fees = null; }
  return { ...out, key, tokenId, positionManager, liquidity, tickLower, tickUpper, sqrtP, principal, fees };
}

// ---------------------------------------------------------------- formatting
/// "1.2345" from a raw amount, at most `places` decimals, trailing zeros cut.
function fmt(v, decimals, places = 6) {
  if (v === null || v === undefined) return "—";
  if (window.CurbApp && window.CurbApp.fmtSmall) return window.CurbApp.fmtSmall(v, decimals, places);
  const b = BigInt(v);
  const base = 10n ** BigInt(decimals);
  const whole = b / base;
  let frac = (b % base).toString().padStart(decimals, "0").slice(0, places).replace(/0+$/, "");
  return whole.toLocaleString("en-US") + (frac ? "." + frac : "");
}
function untilText(s) {
  if (s <= 0) return "now";
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m " + String(s % 60).padStart(2, "0") + "s";
  if (s < 86400) return Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m";
  return Math.floor(s / 86400) + "d " + Math.floor((s % 86400) / 3600) + "h";
}
function el(tag, props, kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("data-") || k.startsWith("aria-") || k === "role" || k === "for") e.setAttribute(k, v);
    else e[k] = v;
  }
  for (const kid of kids || []) if (kid !== null && kid !== undefined && kid !== false) e.append(kid);
  return e;
}
/// An address, linked to Basescan on Base itself and copyable everywhere.
function addrEl(a, chainId) {
  if (chainId === 8453) {
    return el("a", { class: "shAddr", href: "https://basescan.org/address/" + a, target: "_blank", rel: "noreferrer noopener", text: a });
  }
  return el("code", { class: "shAddr", text: a });
}

window.CurbSharing = {
  // readers, for the pages and the browser tests
  reader, readDistributor, readRoles, readCatalog, inForce, hasPending, vetoedSince, roleWarnings,
  decodeRoot, decodeEventUri, publishedEvent, blockAtTime, deployBlock, forkFloor, getLogs, logError,
  // files
  loadFile, loadChunk, checkEpoch, parsedFile, siteFile, gatewayUrls, share, leafOf, rowOf,
  // v4
  sqrtAtTick, amountsFor, ticksOf, readPosition,
  // the rest of this file, for the pages
  SEL, TOPIC, REFUSALS, fmt, untilText, el, addrEl, short, same, isZero, isAddr, pad, padNum, verifyCommand,
  constants: { VETO_WINDOW_S, ROLE_DELAY_S, ROLE_WINDOW_S, ADMISSION_DELAY_S, PUSH_FLOOR_USD, LEAVES_READ_MAX,
    PUSH_BATCH, HISTORY_MAX, VERIFY_WHERE, FILES_PATH, GATEWAYS },
};
})();
