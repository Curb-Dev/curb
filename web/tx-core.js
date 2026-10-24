// THE PROTECTIONS AROUND SENDING, IN ONE PLACE.
//
// These were written for launch.html, one correction at a time, and each of
// them exists because something went wrong: a record that only lived in memory
// and vanished on reload, a list that two tabs lost updates from, a claim taken
// after the wallet dialog had already opened, a migration that deleted what it
// could not read. app.html needs every one of them and must not get a second,
// younger copy - the wallet stub already taught this lesson once, where two
// runners were testing different wallets while claiming to test one page.
//
// WHAT IS PER-CONTEXT AND WHAT IS NOT. Nothing here keeps module state that
// belongs to a page. The pending store is localStorage and is genuinely shared;
// the send lock is handed out as an instance, so two evaluations of a page hold
// two locks rather than one; the page id and the disposed flag stay with the
// page and are passed in. The test harness evaluates launch.js repeatedly to
// make independent contexts, and a shared `releaseSendLock` or a shared page id
// would quietly make those contexts one.
(function () {

const same = (a, b) => (a || "").toLowerCase() === (b || "").toLowerCase();
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------------------------------------------------------------- pending
// ONE STORAGE KEY PER TRANSACTION, not one key holding a list.
//
// A list is a read-modify-write, and two tabs doing that at once lose one of
// the two records - the same lost-update that made the preparation claim
// useless on its own. Per-launch locks do not help here, because two tabs
// sending for DIFFERENT launches hold different locks and still write the same
// list. A key per transaction has no shared cell to lose.
const PENDING_PREFIX = "curb.launch.pending.v3:";
const PENDING_STORE_V2 = "curb.launch.pending.v2"; // migrated from, then dropped
const PENDING_STORE_V1 = "curb.launch.pending";

function keyOf(tx) { return tx.chainId + ":" + tx.hash; }
function storageKeyOf(tx) { return PENDING_PREFIX + keyOf(tx); }

function loadPendingAll() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || k.indexOf(PENDING_PREFIX) !== 0) continue;
      try {
        const v = JSON.parse(localStorage.getItem(k));
        if (v && v.hash) out.push(v);
      } catch {}
    }
  } catch {}
  return out;
}

/// @return true if the record is actually on disk. A page that cannot write
///         must not go on implying the hash will survive a reload.
function savePending(tx) {
  try {
    localStorage.setItem(storageKeyOf(tx), JSON.stringify(tx));
  } catch {
    return false;
  }
  // Written is not stored: private modes and quota failures can both accept the
  // call and keep nothing.
  try { return !!localStorage.getItem(storageKeyOf(tx)); } catch { return false; }
}

function clearPending(tx) {
  try { localStorage.removeItem(storageKeyOf(tx)); } catch {}
}

/// ADDS TO A RECORD THAT IS STILL THERE, and never brings one back. A field
/// learned after the record was written - the nonce, read back once the hash is
/// known - must not resurrect a record another tab settled in the meantime.
/// @return true if the record was on disk and now holds the fields.
function updatePending(tx, fields) {
  let cur = null;
  try { cur = JSON.parse(localStorage.getItem(storageKeyOf(tx))); } catch { return false; }
  if (!cur || !cur.hash) return false;
  return savePending({ ...cur, ...fields });
}

/// Unresolved records for one launch, on one chain. Identity is the TRIPLE:
/// the same token address exists under more than one lens deployment.
function unresolvedFor(chainId, lens, token) {
  return loadPendingAll().filter(
    (t) => t.chainId === chainId && same(t.lens, lens) && same(t.token, token)
  );
}

/// UNREADABLE IS NOT EMPTY, AND UNUSABLE IS NOT EMPTY EITHER.
///
/// The first version turned any parse failure into an empty list and then
/// deleted the key on the grounds that there was nothing in it. A record
/// damaged by a truncated write still has a transaction hash in it that a
/// person can read; deleting it is the one thing that makes it unrecoverable.
/// Nothing here can repair such a record, so nothing here may destroy it.
///
/// The key is removed only when this function positively understands the
/// contents to be nothing, or has moved every record out of them.
function migrateOne(storeKey, extract) {
  let raw;
  try { raw = localStorage.getItem(storeKey); } catch { return null; }
  if (!raw) return null;

  const kept = (why) => ({ storeKey, moved: 0, failed: 0, unusable: 0, unreadable: why });
  const drop = () => { try { localStorage.removeItem(storeKey); } catch {} return null; };

  let parsed;
  try { parsed = JSON.parse(raw); } catch { return kept("damaged"); }
  // A stored literal null or undefined holds nothing by any reading of it.
  if (parsed === null || parsed === undefined) return drop();

  let candidates;
  try { candidates = extract(parsed); } catch { return kept("damaged"); }
  if (!Array.isArray(candidates)) candidates = [candidates];

  const records = candidates.filter((t) => t && t.hash && t.chainId);
  const unusable = candidates.length - records.length;
  const failed = records.filter((tx) => !savePending(tx));

  // Anything left behind - a record this version cannot read, or one this
  // browser would not store - keeps the old key exactly as it was.
  if (failed.length || unusable) {
    return { storeKey, moved: records.length - failed.length, failed: failed.length, unusable, unreadable: null };
  }
  return drop();
}

/// @return null when everything moved, or the HTML of what to tell the user.
///         The message is built here so both pages say the same thing; showing
///         it is the page's job.
function migratePendingStore() {
  const problems = [
    migrateOne(PENDING_STORE_V1, (v) => (Array.isArray(v) ? v : [v])),
    migrateOne(PENDING_STORE_V2, (v) => (Array.isArray(v) ? v : [v])),
  ].filter(Boolean);
  if (!problems.length) return null;

  // SAY WHICH OF THE THREE IT WAS. "Could not be moved" covers a browser that
  // refused to store, a record in a shape this version does not know, and a
  // store too damaged to parse - and the user's next step is different in each
  // case, so they are not worth collapsing into one sentence.
  const failed = problems.reduce((n, p) => n + p.failed, 0);
  const unusable = problems.reduce((n, p) => n + p.unusable, 0);
  const damaged = problems.filter((p) => p.unreadable);
  const keys = problems.map((p) => `<code>${escapeHtml(p.storeKey)}</code>`).join(" and ");

  const parts = [];
  if (failed) {
    parts.push(`${failed} record${failed > 1 ? "s" : ""} could not be written into this browser's storage`);
  }
  if (unusable) {
    parts.push(`${unusable} record${unusable > 1 ? "s" : ""} ` +
      `${unusable > 1 ? "were" : "was"} not in a shape this page can read`);
  }
  if (damaged.length) {
    parts.push(`${damaged.length > 1 ? "older stores were" : "an older store was"} too damaged to read at all`);
  }

  return `An older version of this page left transaction records behind: ${parts.join(", and ")}. ` +
    `NOTHING HAS BEEN DELETED — they are still under ${keys} in this browser's local storage. ` +
    `This page cannot recover them for you: if you were waiting on a transaction, read the hash out of ` +
    `that key in your browser's developer tools, or find it in your wallet's activity. Until then this ` +
    `page cannot show it as unaccounted for.`;
}

// ---------------------------------------------------------------- the claim
// A CLAIM TAKEN BEFORE THE WALLET DIALOG OPENS.
//
// Checking the pending records was not enough: a record only exists once a
// hash comes back, so two tabs could both look, both find nothing, and both
// open a confirm dialog. The claim is written first, so the second tab sees it
// while the first is still waiting on the user.
//
// It EXPIRES, because a tab closed mid-dialog would otherwise lock the launch
// forever. And localStorage has no compare-and-set, so the write is followed by
// a re-read: if someone else claimed it at the same moment, the earlier
// startedAt wins and ties break on the page id. That is best effort, not a
// mutex - navigator.locks is used as well where the browser has it, which does
// give real mutual exclusion between tabs of the same origin.
//
// THE PAGE ID IS PASSED IN, not generated here: each evaluation of a page is
// its own participant, and one shared id would make two tabs look like one.
const PREPARE_STORE = "curb.launch.preparing";
const PREPARE_TTL_MS = 180000;

function newPageId() {
  return Math.random().toString(36).slice(2) + "-" + Date.now().toString(36);
}

function loadPreparing() {
  try {
    const v = JSON.parse(localStorage.getItem(PREPARE_STORE) || "[]");
    if (!Array.isArray(v)) return [];
    const now = Date.now();
    return v.filter((p) => p && p.startedAt && now - p.startedAt < PREPARE_TTL_MS);
  } catch { return []; }
}

function writePreparing(list) {
  try { localStorage.setItem(PREPARE_STORE, JSON.stringify(list)); } catch {}
}

const isSameLaunch = (p, chainId, lens, token) =>
  p.chainId === chainId && same(p.lens, lens) && same(p.token, token);

function claimPreparation(pageId, chainId, lens, token) {
  const mine = { pageId, chainId, lens, token, startedAt: Date.now() };
  const list = loadPreparing().filter((p) => p.pageId !== pageId);
  list.push(mine);
  writePreparing(list);

  // Re-read: the write above is not atomic against another tab's.
  const now = loadPreparing().filter((p) => isSameLaunch(p, chainId, lens, token));
  const winner = now.sort((a, b) => a.startedAt - b.startedAt || (a.pageId < b.pageId ? -1 : 1))[0];
  if (!winner || winner.pageId !== pageId) return null;
  return mine;
}

function releasePreparation(mine) {
  if (!mine) return;
  writePreparing(loadPreparing().filter((p) => p.pageId !== mine.pageId));
}

function preparingElsewhere(pageId, chainId, lens, token) {
  return loadPreparing().find((p) => isSameLaunch(p, chainId, lens, token) && p.pageId !== pageId) || null;
}

// ---------------------------------------------------------------- the lock
// WHERE THIS DOES AND DOES NOT HOLD. navigator.locks is real mutual exclusion
// between contexts of one origin. Without it there is no primitive in the
// platform that gives it - localStorage has no compare-and-set - so the storage
// claim is the only guard, and two tabs CAN still both send if they interleave
// inside it. A page says so rather than implying a protection it does not have.
//
// CHECKED WHEN ASKED, not when this file loaded: the test harness removes
// navigator.locks and re-evaluates a page to test the unsupported path, and a
// value captured at load would still say the API is there.
const locksSupported = () =>
  !!(typeof navigator !== "undefined" && navigator.locks && navigator.locks.request);

/// One lock holder per caller. Module-level state here would let one page's
/// drop() release another page's lock.
function makeSendLock() {
  let release = null;
  return {
    get supported() { return locksSupported(); },
    /// @return "held" | "taken" | "unsupported"
    async acquire(name) {
      if (!locksSupported()) return "unsupported";
      try {
        return await new Promise((resolve, reject) => {
          navigator.locks.request(name, { ifAvailable: true }, (lock) => {
            if (!lock) { resolve("taken"); return; }
            resolve("held");
            return new Promise((done) => { release = done; });
          }).catch(reject);
        });
      } catch {
        // An API that threw is not an API that excluded anything. Treated as
        // absent, which is honest, rather than as success, which was fail-open.
        return "unsupported";
      }
    },
    drop() { if (release) { release(); release = null; } },
  };
}

// ---------------------------------------------------------------- receipts
const defaultReceiptTimeout = () =>
  (typeof window !== "undefined" && window.__CURB_RECEIPT_TIMEOUT_MS) || 120000;

/// Polled through the SAME provider the transaction went through, and only
/// while that provider is still on the chain it went to. A receipt looked for
/// on a different chain than the send is not an answer about this transaction.
function waitForReceipt(tx, eth, opts) {
  const { timeoutMs = defaultReceiptTimeout(), isDisposed = () => false } = opts || {};
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (isDisposed()) return reject(new Error("this page was replaced while waiting"));
      try {
        const request = (m, p) => eth.request({ method: m, params: p });
        const chainId = await request("eth_chainId", []);
        if (chainId !== tx.chainId) {
          return reject(new Error("the wallet switched networks while the transaction was in flight"));
        }
        const r = await request("eth_getTransactionReceipt", [tx.hash]);
        if (r) return resolve(r);
        if (Date.now() - started > timeoutMs) return reject(new Error("timed out"));
        setTimeout(tick, 1500);
      } catch (e) { reject(e); }
    };
    tick();
  });
}

// ---------------------------------------------------------------- smart wallets
// A MINED RECEIPT IS NOT ALWAYS THE ACCOUNT'S OWN VERDICT. A smart wallet
// (ERC-4337: Coinbase Wallet's, the one its in-app browser connects) sends what
// the person signed as a user operation, and a bundler puts it on chain inside
// a transaction of its own, to the EntryPoint. The hash the wallet hands back
// can be that bundle's, and its receipt says status 0x1 when the bundle ran -
// whether or not the operation inside it did. The EntryPoint says which, in
// UserOperationEvent's `success` (with UserOperationRevertReason beside it). A
// page that read `status` alone called a reverted buy, claim or move done.
//
// MATCHED BY SENDER, THE CONNECTED ACCOUNT. A bundle carries many accounts'
// operations, and another account's failure in it is not this one's. ERC-4337's
// bundlers put one operation per sender in a bundle (ERC-7562's rule, unless
// the sender is staked), so the sender names this one. ONLY THE ENTRYPOINTS
// DEPLOYED ON BASE count: any contract can emit an event with the same topic.
//
// A BUNDLE WITH NO OPERATION OF THIS ACCOUNT'S says nothing about it: a receipt
// someone else sent, whose EntryPoint events are all other accounts', is not
// this account's transaction, and is not called a success either.
/// v0.6, v0.7 and v0.8, each with code on Base (eth_getCode at mainnet.base.org).
const ENTRY_POINTS = Object.freeze([
  "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789",
  "0x0000000071727de22e5e9d8baf0edac6f37da032",
  "0x4337084d9e255ff0702461cf8895ce9e3b5ff108",
]);
/// keccak256("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)"),
/// the same in all three: userOpHash, sender and paymaster indexed, then nonce,
/// success, actualGasCost and actualGasUsed in the data.
const USER_OP_EVENT = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";

/// THE ENTRYPOINT'S UserOperationEvents IN A RECEIPT, as { op, sender, success }.
/// A log too short to carry `success` is read as an operation that did not succeed.
function userOpsOf(receipt) {
  const out = [];
  for (const l of receipt && Array.isArray(receipt.logs) ? receipt.logs : []) {
    if (!l || !ENTRY_POINTS.includes(String(l.address || "").toLowerCase())) continue;
    const t = Array.isArray(l.topics) ? l.topics.map((x) => String(x || "").toLowerCase()) : [];
    if (t[0] !== USER_OP_EVENT || t.length < 3) continue;
    const data = String(l.data || "").replace(/^0x/, "");
    const flag = data.length >= 128 ? data.slice(64, 128) : "";
    out.push({ op: t[1], sender: "0x" + t[2].slice(-40), success: /[1-9a-f]/.test(flag) });
  }
  return out;
}

/// WHETHER A MINED RECEIPT SAYS THE ACCOUNT'S TRANSACTION WENT THROUGH - the
/// one question every page asks of a receipt before it says anything worked.
/// @param sender  the account that sent it (the connected account)
/// @return { ok: true } or { ok: false, why } - why "reverted" (the receipt's
///   status), "operation" (this account's user operation reverted inside a
///   bundle that ran) or "elsewhere" (a bundle with no operation of this
///   account's in it)
function receiptVerdict(receipt, sender) {
  if (!receipt || receipt.status !== "0x1") return { ok: false, why: "reverted" };
  const ops = userOpsOf(receipt);
  const mine = sender ? ops.filter((o) => same(o.sender, sender)) : ops;
  if (mine.some((o) => !o.success)) return { ok: false, why: "operation" };
  if (!mine.length && ops.length && !same(receipt.from, sender)) return { ok: false, why: "elsewhere" };
  return { ok: true };
}

/// WHAT A FAILED VERDICT SAYS, after "the transaction" or a page's own name for
/// it - the same words on every page.
function failedWords(verdict) {
  if (verdict && verdict.why === "operation") return "was mined, but your wallet's operation inside it reverted";
  if (verdict && verdict.why === "elsewhere") {
    return "was mined, but nothing in it is an operation from your account, so nothing shows it went through";
  }
  return "reverted on chain";
}

// ---------------------------------------------------------------- settling
// A RECORD IS CLEARED ONLY ON WHAT THE CHAIN PROVES, and both pages ask the
// chain the same questions, here.
//
// The first version of "replaced or dropped" compared the sender's mined nonce
// with a nonce the PAGE had guessed from its own endpoint before the wallet
// signed. The wallet picks the nonce - it may hold a transaction that endpoint
// has not seen, or the person may set one - so the guess could sit below the
// real one, and a create that was still pending was cleared, never adopted, and
// a second create (a second launch fee, a second dev buy) was let through. It
// also read the receipt once and the nonce once, so a transaction mined between
// the two reads was announced as replaced.
//
// So: the nonce is the one the transaction CARRIES, read back by its hash once
// the wallet returns it (`sentNonce`; the old guessed `nonce` field is not read
// at all). And "replaced" needs every one of these, in this order: no receipt;
// the sender's nonce at a named block has moved past the record's; then, after
// a pause long enough for a block, still no receipt and a node that does not
// know the hash. Anything short of that is "pending" or "unknown", and the
// record stays.

/// THE PAUSE BEFORE THE SECOND LOOK. Base makes a block every two seconds; a
/// transaction mined between the first receipt read and the nonce read shows up
/// in the second receipt read only if that read is at least a block later. A
/// test harness shortens it through the window flag.
const recheckDelay = () =>
  (typeof window !== "undefined" && window.__CURB_RECHECK_MS != null) ? window.__CURB_RECHECK_MS : 3000;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const isQuantity = (v) => typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v);

/// A NONCE IS ONLY A NONCE OF THE ACCOUNT THAT SENT IT. The record is judged
/// by comparing it with the sender's transaction count, so a transaction whose
/// `from` is anyone else - a smart wallet's bundler, which sends the user's
/// operation from its own account at its own nonce - carries a number that says
/// nothing about the sender. Compared anyway, a bundler nonce below the account's
/// count reads as "replaced" and clears a record whose operation may still land.
/// @return the transaction's nonce when it was sent by `sender`, else null.
const nonceFrom = (t, sender) => (t && isQuantity(t.nonce) && sender && same(t.from, sender) ? t.nonce : null);

/// THE NONCE A TRANSACTION CARRIES, asked of each transport in turn - the
/// wallet that broadcast it first, since it is the one certain to know it.
/// @param sender  the account the record says sent it; a transaction the node
///                reports from anyone else yields no nonce (nonceFrom says why).
/// @return the nonce as the chain's hex quantity, or null when nobody knows the
///         hash. Null is stored as null; it is never filled in with a guess.
async function nonceOfHash(hash, requests, sender) {
  for (const request of requests) {
    try {
      const n = nonceFrom(await request("eth_getTransactionByHash", [hash]), sender);
      if (n !== null) return n;
    } catch { /* the next transport, if any */ }
  }
  return null;
}

/// @param tx       a pending record: hash, and `from` (app.html) or `account`
///                 (launch.html), and `sentNonce` when it was read back.
/// @param request  (method, params) => result, on the chain the record was sent to.
/// @return {state, receipt?, nonce?, head?, seen?}
///   "mined"    a receipt exists, success or revert: settle it by the receipt.
///   "pending"  the node still knows the hash (seen: true), or the nonce the
///              transaction used has not been used yet and the node does not
///              know the hash (seen: false) - which is also what a transaction
///              the mempool dropped looks like; readVerdict tells them apart
///              by age.
///   "replaced" the sender's nonce at block `head` is past this one, and a
///              second look found no receipt and a node that does not know the
///              hash: this hash will never mine. For a create, the transaction
///              that took its nonce may still have created - see findReplacement.
///   "unknown"  no receipt, no node that knows the hash, and no nonce to judge
///              by: nothing the chain says can settle it.
///   "ahead"    its nonce is above the sender's count here and above what the
///              node's pending pool reaches (`chainCount` is the count): the
///              wallet's count is not this chain's, and it can never mine.
/// Throws when a read fails; a record whose check failed is kept.
async function judgePending(tx, request) {
  let receipt = await request("eth_getTransactionReceipt", [tx.hash]);
  if (receipt) return { state: "mined", receipt };

  const sender = tx.from || tx.account;
  let nonce = isQuantity(tx.sentNonce) ? tx.sentNonce : null;
  if (nonce === null) {
    // NOT RECORDED - the read-back failed, or the record predates it. The node
    // may still know the transaction, and then the nonce it used is a fact.
    const seen = await request("eth_getTransactionByHash", [tx.hash]);
    if (seen) return { state: "pending", seen: true, nonce: nonceFrom(seen, sender) };
    return { state: "unknown", nonce: null };
  }
  if (!sender) return { state: "unknown", nonce };

  // AT A NAMED BLOCK, so the logs a create is looked for in are read to the
  // same height the nonce was: "latest" twice can be two different blocks on a
  // load-balanced endpoint.
  const head = await request("eth_blockNumber", []);
  if (!isQuantity(head)) throw new Error("the node did not say which block it is at");
  const used = await request("eth_getTransactionCount", [sender, head]);
  if (!isQuantity(used)) throw new Error("the node did not say how many transactions " + sender + " has sent");
  // AN UNUSED NONCE IS NOT A TRANSACTION STILL WAITING. The node is asked
  // whether it holds the hash: one it does not hold, with its nonce unused, is
  // either not yet propagated or dropped - and only the second can be let go.
  if (BigInt(used) <= BigInt(nonce)) {
    const held = await request("eth_getTransactionByHash", [tx.hash]);
    // A NONCE THIS CHAIN CANNOT REACH. Above the account's count, and above
    // what the node's own pending pool would bring it to: nothing this account
    // has sent here fills the gap, so the transaction waits for ever - the node
    // holds it queued, or never knew it. That is a wallet whose count is not
    // this chain's: one that remembers another network, or an older copy of
    // this local fork (the owner hit it on a create). Said plainly, and it may
    // be forgotten at once (readVerdict, mayForget). A pending pool that will
    // not say counts as no gap - the record stays "pending".
    if (BigInt(nonce) > BigInt(used)) {
      let pend = null;
      try { pend = await request("eth_getTransactionCount", [sender, "pending"]); } catch { pend = null; }
      if (isQuantity(pend) && BigInt(nonce) >= BigInt(pend)) {
        return { state: "ahead", seen: !!held, nonce, chainCount: used };
      }
    }
    return { state: "pending", seen: !!held, nonce };
  }

  // THE SECOND LOOK. The nonce moving is also what a transaction mined between
  // the first receipt read and the count looks like.
  await pause(recheckDelay());
  receipt = await request("eth_getTransactionReceipt", [tx.hash]);
  if (receipt) return { state: "mined", receipt };
  if (await request("eth_getTransactionByHash", [tx.hash])) return { state: "pending", seen: true, nonce };
  return { state: "replaced", nonce, head };
}

/// A CREATE THAT WAS REPLACED MAY STILL HAVE CREATED.
///
/// The usual replacement of a create is the wallet's "speed up": the same
/// calldata at a higher fee, from the same sender at the same nonce. It mines,
/// it creates the launch, it spends the launch fee and the dev buy - and the
/// recorded hash never mines. Calling that "replaced or dropped" reads as
/// "nothing happened" and invites a second create.
///
/// Looked for by what a replacement IS: a transaction from the record's sender
/// carrying the record's nonce. Every `topic0` event `address` emitted between
/// the block read before the send and the block the nonce was judged at is
/// checked; there is no call that finds a transaction by sender and nonce.
/// @param verdict  the "replaced" answer from judgePending (nonce, head).
/// @return {receipt} for the replacement that emitted the event;
///         {none: true} when the logs over that whole range show none;
///         {cannot: why} when the range or the logs could not be read. The
///         caller keeps the record then: a launch may exist.
/// @param topics  a narrower filter than `topic0` alone, when given - a swap
///                 replaced looks only at the asset's transfers to its sender.
async function findReplacement(tx, verdict, request, address, topic0, topics) {
  const sender = tx.from || tx.account;
  if (!isQuantity(tx.sentAfterBlock)) {
    return { cannot: "the record does not say which block it was sent after, so there is no range to search" };
  }
  if (!isQuantity(verdict.head) || BigInt(tx.sentAfterBlock) > BigInt(verdict.head)) {
    return { cannot: "the node is behind the block the record was sent after" };
  }
  let logs;
  try {
    logs = await request("eth_getLogs", [{ address, topics: topics || [topic0], fromBlock: tx.sentAfterBlock, toBlock: verdict.head }]);
  } catch (e) {
    return { cannot: "the node would not return the logs since the send (" + (e && e.message ? e.message : String(e)) + ")" };
  }
  if (!Array.isArray(logs)) return { cannot: "the node returned no list of logs" };
  const hashes = [...new Set(logs.map((l) => l && l.transactionHash).filter(Boolean))];
  for (const h of hashes) {
    let t;
    try { t = await request("eth_getTransactionByHash", [h]); } catch (e) {
      return { cannot: "a transaction in those logs could not be read (" + (e && e.message ? e.message : String(e)) + ")" };
    }
    // A LOGGED TRANSACTION THE NODE WILL NOT DESCRIBE cannot be ruled out.
    if (!t || !isQuantity(t.nonce)) return { cannot: "the node would not describe " + h + ", which is in those logs" };
    if (!same(t.from, sender) || BigInt(t.nonce) !== BigInt(verdict.nonce)) continue;
    let r;
    try { r = await request("eth_getTransactionReceipt", [h]); } catch { r = null; }
    if (!r) return { cannot: "the replacement " + h + " has no receipt to read the launch from" };
    return { receipt: r };
  }
  return { none: true };
}

// ---------------------------------------------------------------- letting go
// A RECORD THE CHAIN WILL NEVER SETTLE MUST NOT BLOCK FOR EVER. Three kinds
// were stuck that way: a transaction the mempool dropped (its nonce unused, no
// node that knows the hash - the chain settles it only if the account happens
// to send again), a record signed while the wallet changed networks whose
// nonce is still unused here, and a record no endpoint this page may ask about
// can read. Each refused its scope with no way out but editing localStorage.
//
// Nothing here forgets anything. It decides when a page may OFFER to forget,
// behind a confirm that says what forgetting allows; the person decides.

/// AN HOUR, AND IT IS A CHOICE, NOT A FACT OF THE CHAIN. Base makes a block
/// every two seconds, so a transaction a node still held would have been mined
/// or replaced many times over in that time; a record nothing can read for an
/// hour is not a passing outage. A test harness shortens it through the flag.
const STALE_AFTER_MS = 60 * 60 * 1000;
const staleAfter = () =>
  (typeof window !== "undefined" && window.__CURB_STALE_MS != null) ? window.__CURB_STALE_MS : STALE_AFTER_MS;

const isTime = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;

/// WHEN THIS BROWSER FIRST KNEW OF A RECORD: `sentAt`, which both pages write
/// when the wallet returns a hash, or - for a record older than that field -
/// `firstJudgedAt`, stamped here the first time a page judges it. An age is
/// never guessed from anything else, so an older record's hour starts when a
/// page first looked at it, not when it was sent.
/// @return the record, carrying the stamp; the stored copy gets it too.
function stampJudged(tx) {
  if (isTime(tx.sentAt) || isTime(tx.firstJudgedAt)) return tx;
  const now = Date.now();
  updatePending(tx, { firstJudgedAt: now });
  return { ...tx, firstJudgedAt: now };
}

/// @return milliseconds since the record's first known moment, or null.
function ageOf(tx) {
  const t = isTime(tx.sentAt) ? tx.sentAt : isTime(tx.firstJudgedAt) ? tx.firstJudgedAt : null;
  return t === null ? null : Math.max(0, Date.now() - t);
}
const isStale = (tx) => { const a = ageOf(tx); return a !== null && a >= staleAfter(); };

/// A duration said in words, for the line that shows the evidence.
function ageText(ms) {
  const min = Math.floor(ms / 60000);
  if (min < 1) return "less than a minute";
  if (min < 120) return min + " minute" + (min === 1 ? "" : "s");
  const h = Math.floor(min / 60);
  return h < 48 ? h + " hours" : Math.floor(h / 24) + " days";
}

/// WHAT A VERDICT MEANS FOR ONE RECORD, the same on both pages.
///   "uncertain"  signed while the wallet changed networks: its nonce may be
///                another chain's, so this chain's count moving past it
///                ("replaced") or not reaching it ("pending", unseen) says
///                nothing about it.
///   "dropped"    its nonce unused and no node that knows the hash, an hour
///                or more after it was sent: the mempool let it go. A wallet
///                that kept it can still send it, which the page says.
/// Every other verdict is returned as judgePending gave it.
function readVerdict(tx, verdict) {
  const unseen = verdict.state === "pending" && !verdict.seen;
  if (tx.uncertainChain && (verdict.state === "replaced" || verdict.state === "ahead" || unseen)) {
    return { ...verdict, state: "uncertain" };
  }
  if (unseen && isStale(tx)) return { ...verdict, state: "dropped" };
  return verdict;
}

/// THE STATES A PERSON MAY END BY HAND: the chain has nothing left to say about
/// them, or - "made" - it has said everything: a create mined whose launch is
/// named in its receipt, kept only to carry that address. "unreadable" and
/// "elsewhere" (no endpoint this page may ask serves the record's chain) join
/// them once the record is past the hour: a while ago, nothing can read it.
const FORGETTABLE = new Set(["unknown", "unsearched", "uncertain", "dropped", "made", "ahead"]);
function mayForget(tx, why) {
  if (!why) return false;
  if (FORGETTABLE.has(why.state)) return true;
  return (why.state === "unreadable" || why.state === "elsewhere") && isStale(tx);
}

/// THE WAY OUT OF A NONCE THAT IS NEVER USED, said the same on both pages. A
/// wallet that no longer shows the transaction has nothing to cancel; any
/// transaction from the account at that nonce replaces it.
const useTheNonce = (n) =>
  `Any transaction from this account at nonce ${n} replaces it - for example a zero-value send to yourself ` +
  `with the nonce set to ${n} in the wallet - and once that nonce is used, this page settles the record by ` +
  `what took it.`;

window.CurbTx = {
  keyOf, storageKeyOf, loadPendingAll, savePending, clearPending, updatePending, unresolvedFor, migratePendingStore,
  newPageId, loadPreparing, claimPreparation, releasePreparation, preparingElsewhere,
  makeSendLock, locksSupported, waitForReceipt, defaultReceiptTimeout,
  ENTRY_POINTS, USER_OP_EVENT, userOpsOf, receiptVerdict, failedWords,
  nonceOfHash, judgePending, findReplacement,
  stampJudged, ageOf, isStale, ageText, staleAfter, readVerdict, mayForget, useTheNonce,
};

})();
