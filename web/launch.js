// ONE EVALUATION, ONE PRIVATE SCOPE.
//
// Everything below lives inside this function, and it has to. At the top level
// of a script - or of an indirect eval, which is how the test harness loads a
// "second tab" - `function` declarations are VAR-SCOPED: they become properties
// of the global object, and a second evaluation overwrites every one of them.
// `let` and `const` do not; an eval keeps those to itself.
//
// The result was a file that looked like it had per-context state and did not.
// Each context kept its own `disposed`, `account`, `busy` - but every function
// that read them resolved `show`, `$`, `savePending` and the rest through the
// GLOBAL scope, so they all ran the newest context's copies against the newest
// context's variables. A retired context's receipt poll therefore wrote into
// the live page through the live context's DOM helper, straight past the check
// that was meant to stop it, and the "two tabs" scenario was never really two.
//
// Inside a function body, a function declaration is scoped to that body. One
// evaluation is then genuinely one context - in the page and in the harness
// alike, because this wrapper is in the file rather than in the harness.
//
// The body is deliberately NOT re-indented: several messages are multi-line
// template literals, and indenting those would change the text users read.
(function () {

// A CONTEXT CAN BE RETIRED. Each evaluation of this file has its own module
// state, and a receipt poll started by one outlives the DOM it was drawing to -
// for the whole timeout. The test harness resets the page between scenarios, so
// without this the previous scenario's poll keeps running for two minutes,
// against a page that is gone, and "every scenario gets a fresh page" is not
// true. Declared first, because $() below reads it.
let disposed = false;

// ---------------------------------------------------------------- constants
const SEL = {
  launchState: "0x3cb24365",
  graduator:   "0x0245a483",
  graduate:    "0xff6d8d05",
  decimals:    "0x313ce567",
  symbol:      "0x95d89b41",
};
const STATUS = ["NotFound", "Selling", "Waiting", "Graduated"];
const STORE = "curb.launch.addrs";

// A RETIRED CONTEXT HAS NO PAGE. Every DOM access in this file goes through
// here, so one check covers all of them: once dispose() has run, nothing this
// context does can reach the document.
//
// This is not tidiness. A receipt poll started by a retired context keeps
// running, and its next tick walks the ordinary error path - which ends in
// show(). show() looks the element up when it is CALLED, so it found the
// element belonging to whatever page had replaced it, and the old context wrote
// its "could not confirm" over the new page's message. Two scenarios failed on
// a message neither of them had produced.
const detached = (id) => {
  const el = document.createElement(id === "msg" || id === "card" ? "div" : "input");
  el.id = id;
  return el;
};
const $ = (id) => (disposed ? detached(id) : document.getElementById(id));
let account = null;
let busy = false;
// #connect IS DISABLED FOR AS LONG AS busy IS SET, because that is how the site
// bar knows an action is waiting on the wallet: its Connect is not taken and its
// Disconnect does not reload the page while #connect is disabled (topbar.js).
// A reload in the middle of complete() lost the hash of a transaction the
// wallet then sent (round 5, N44). Every change of busy goes through here.
function setBusy(v) {
  busy = v;
  $("connect").disabled = v;
}
let lensGraduator = null; // read from the lens, never typed

// A transaction, PINNED to everything it was sent against. The form can change
// while a transaction is in flight - a different token, a different lens, a
// different wallet network - and checking the result against whatever the form
// says NOW would let A's transaction be confirmed by B's state.
//
// PERSISTED, because a page that only remembers it in memory forgets it on the
// first refresh - and "the hash is kept" would then be true only while the tab
// stays open, which is not when a user needs it.
// THE SEND-PATH PROTECTIONS LIVE IN tx-core.js.
//
// They were written here, one correction at a time, and app.html needs every
// one of them. A second copy would drift - the wallet stub already taught that
// lesson, where two runners tested different wallets while claiming to test one
// page - so they moved out rather than being duplicated.
//
// PAGE_ID and the send lock stay PER CONTEXT. The test harness evaluates this
// file repeatedly to make independent contexts, and a shared page id or a
// shared lock holder would quietly make two tabs into one.
const TX = window.CurbTx;
const {
  keyOf, loadPendingAll, savePending, clearPending, unresolvedFor,
  loadPreparing, waitForReceipt: waitForReceiptCore,
} = TX;

const PAGE_ID = TX.newPageId();
const sendLock = TX.makeSendLock();
const LOCKS_SUPPORTED = sendLock.supported;

const claimPreparation = (chainId, lens, token) => TX.claimPreparation(PAGE_ID, chainId, lens, token);
const releasePreparation = (mine) => TX.releasePreparation(mine);
const preparingElsewhere = (chainId, lens, token) => TX.preparingElsewhere(PAGE_ID, chainId, lens, token);
const acquireSendLock = (name) => sendLock.acquire(name);
const dropSendLock = () => sendLock.drop();

/// The migration builds the message; showing it is this page's job.
function migratePendingStore() {
  const problem = TX.migratePendingStore();
  if (problem) show("err", problem);
}

// Records THIS page is settling right now. Without it, a chainChanged event
// fired while a transaction is in flight runs resumePending(), which then
// announces that very transaction as "unaccounted for from a previous visit"
// and overwrites the message settle() is in the middle of producing.
const settling = new Set();

// Records created BY THIS PAGE LOAD. They have already been reported on, right
// where the user was looking, so resumePending() must not describe them as
// coming "from a previous visit" and overwrite that report. A real reload
// starts with this empty, which is exactly when the announcement is wanted.
const thisSession = new Set();

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------- helpers
const pad = (addr) => addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const word = (hex, i) => hex.slice(2 + i * 64, 2 + (i + 1) * 64);
const toAddr = (w) => "0x" + w.slice(24);
const toBig = (w) => BigInt("0x" + w);
const isAddr = (s) => /^0x[0-9a-fA-F]{40}$/.test((s || "").trim());
const same = (a, b) => (a || "").toLowerCase() === (b || "").toLowerCase();

function fmt(value, decimals, places = 4) {
  const base = 10n ** BigInt(decimals);
  const whole = (value / base).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (value % base).toString().padStart(decimals, "0").slice(0, places).replace(/0+$/, "");
  return whole + (frac ? "." + frac : "");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function show(kind, html) {
  const el = $("msg");
  el.hidden = false;
  el.className = kind || "";
  el.innerHTML = html;
}
function clearMsg() { $("msg").hidden = true; }

// ---------------------------------------------------------------- transports
// Two of them, kept separate on purpose. A read done through the wallet and a
// send done through the wallet are the same chain; a read done through the RPC
// box is not necessarily the chain the wallet is on.
function walletProvider() {
  if (!window.ethereum) throw new Error("No injected wallet found.");
  return window.ethereum;
}

let rpcId = 0;
async function rpcRequest(method, params) {
  const url = ($("rpc").value || "").trim();
  if (!url) throw new Error("Connect a wallet, or give an RPC endpoint to read from.");
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  if (!res.ok) throw new Error("RPC returned HTTP " + res.status);
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || "RPC error");
  return body.result;
}

const readTransport = () =>
  account && window.ethereum
    ? (m, p) => walletProvider().request({ method: m, params: p })
    : rpcRequest;

async function callWith(request, to, data) {
  return request("eth_call", [{ to, data }, "latest"]);
}

// ---------------------------------------------------------------- reading
// launchState returns a fully STATIC struct, so the return data is 14 words
// with no offset: status, curve, quoteToken, beneficiary, quoteReserve,
// tokenReserve, realQuoteReserve, graduationThreshold, totalSupply, then the
// five words of the PoolKey.
function decodeState(raw) {
  return {
    status: Number(toBig(word(raw, 0))),
    curve: toAddr(word(raw, 1)),
    quoteToken: toAddr(word(raw, 2)),
    beneficiary: toAddr(word(raw, 3)),
    quoteReserve: toBig(word(raw, 4)),
    tokenReserve: toBig(word(raw, 5)),
    realQuoteReserve: toBig(word(raw, 6)),
    graduationThreshold: toBig(word(raw, 7)),
    totalSupply: toBig(word(raw, 8)),
    pool: {
      currency0: toAddr(word(raw, 9)),
      currency1: toAddr(word(raw, 10)),
      fee: Number(toBig(word(raw, 11))),
      hooks: toAddr(word(raw, 13)),
    },
  };
}

async function readState(request, lens, token) {
  const raw = await callWith(request, lens, SEL.launchState + pad(token));
  if (!raw || raw === "0x") {
    throw new Error("The lens returned nothing. Either that address holds no LaunchLens, or this network is not where it lives.");
  }
  const s = decodeState(raw);
  // THE QUOTE SIDE IS SCALED BY ITS OWN ASSET. It was printed at a fixed 8
  // decimals - right for the equities and cbBTC, a factor of 10^10 wrong for
  // WETH and 100 the other way for cbXRP. A launch may be priced in any of the
  // deployment's assets, so the asset is asked.
  s.quoteDecimals = null;
  s.quoteSym = "quote";
  if (/^0x0{40}$/i.test(s.quoteToken)) return s;
  try {
    const d = await callWith(request, s.quoteToken, SEL.decimals);
    if (d && d.length >= 66) s.quoteDecimals = Number(toBig(word(d, 0)));
  } catch { s.quoteDecimals = null; }
  try {
    const sym = decodeShortString(await callWith(request, s.quoteToken, SEL.symbol));
    if (/^[\x20-\x7e]{1,16}$/.test(sym)) s.quoteSym = sym;
  } catch { /* the ticker is a label; its absence is not an error */ }
  return s;
}

/// An ABI string, decoded as UTF-8. Short and forgiving: a ticker that will not
/// decode is left out, not reported.
function decodeShortString(raw) {
  if (!raw || raw.length < 2 + 64 * 2) return "";
  const at = Number(toBig(word(raw, 0))) / 32;
  const len = Number(toBig(word(raw, at)));
  const body = raw.slice(2 + (at + 1) * 64, 2 + (at + 1) * 64 + len * 2);
  const bytes = new Uint8Array(body.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/// A quote amount in its own asset's units, or raw units said as such when the
/// asset would not give its decimals.
const fmtQuote = (s, v) =>
  s.quoteDecimals === null ? v.toString() + " (raw units; the asset did not answer decimals())" : fmt(v, s.quoteDecimals) + " " + s.quoteSym;

/// The graduator is never typed. Asking the lens means the button can only
/// ever aim at the deployment the state came from.
async function readGraduator(request, lens) {
  const raw = await callWith(request, lens, SEL.graduator);
  if (!raw || raw === "0x") throw new Error("No LaunchLens at that address on this network.");
  return toAddr(word(raw, 0));
}

/// THE NEWEST REFRESH DRAWS, AND ONLY WHILE THE FORM STILL SAYS WHAT IT READ.
/// refresh() is fired by every field change, the Refresh button, connect and
/// the wallet's events, and nothing ordered them: an older read landing last
/// drew the previous token's status and "Graduate" button under the new form,
/// and left lensGraduator from the old lens - so complete() refused with "you
/// are looking at one deployment and about to transact on another" (round 5,
/// N31). Each call takes a number; one that is no longer the newest, or whose
/// lens and token are no longer in the form, writes nothing and returns null.
let refreshSeq = 0;

async function refresh(quiet) {
  if (disposed) return null;
  const mine = ++refreshSeq;
  const lens = $("lens").value.trim();
  const token = $("token").value.trim();
  const stale = () => disposed || mine !== refreshSeq ||
    lens !== $("lens").value.trim() || token !== $("token").value.trim();
  if (!isAddr(lens) || !isAddr(token)) {
    $("card").hidden = true;
    if (!quiet) show("err", "Enter a LaunchLens address and a launch token address.");
    return null;
  }
  try {
    const request = readTransport();
    const graduator = await readGraduator(request, lens);
    if (stale()) return null;
    lensGraduator = graduator;
    $("grad").value = lensGraduator;
    const s = await readState(request, lens, token);
    if (stale()) return null;
    if (!quiet) clearMsg();
    render(s);
    return s;
  } catch (e) {
    if (stale()) return null;
    $("card").hidden = true;
    $("grad").value = "";
    lensGraduator = null;
    show("err", escapeHtml(e.message || String(e)));
    return null;
  }
}

function render(s) {
  const name = STATUS[s.status] || "Unknown";
  $("card").hidden = false;
  $("dot").className = "dot " + name.toLowerCase();
  $("statusText").textContent = name;

  $("statusNote").textContent = {
    NotFound:  "This registry has never heard of that token. It is not an early-stage launch — it is not a launch at all, so nothing here should be traded.",
    Selling:   "The curve is open. Buying and selling both happen on the curve; there is no pool yet.",
    Waiting:   "The threshold is reached but the move to the pool has not completed. While this lasts the curve refuses BOTH buys and sells, and the pool does not exist yet — so nothing can be traded until someone finishes the move.",
    Graduated: "The launch is finished. Trading happens in the Uniswap v4 pool below; the LP position is locked.",
  }[name] || "";

  const waiting = name === "Waiting";
  $("actionWrap").hidden = !waiting;
  $("complete").disabled = busy || !account;
  $("complete").title = !account ? "Connect a wallet to send the transaction." : "";

  const selling = name === "Selling";
  $("progressWrap").hidden = !selling;
  if (selling && s.graduationThreshold > 0n) {
    const pct = Number((s.realQuoteReserve * 10000n) / s.graduationThreshold) / 100;
    $("progress").style.width = Math.min(100, pct).toFixed(2) + "%";
    $("progressText").textContent =
      `${fmtQuote(s, s.realQuoteReserve)} of ${fmtQuote(s, s.graduationThreshold)} raised — ${pct.toFixed(2)}%`;
  }

  const facts = [];
  if (name !== "NotFound") {
    facts.push(["curve", s.curve], ["quote asset", s.quoteToken], ["LP beneficiary", s.beneficiary],
               ["token supply", fmt(s.totalSupply, 18, 0)]);
    if (name !== "Graduated") {
      facts.push(["curve quote reserve", fmtQuote(s, s.quoteReserve)], ["curve token reserve", fmt(s.tokenReserve, 18, 0)]);
    } else {
      facts.push(["pool currency0", s.pool.currency0], ["pool currency1", s.pool.currency1],
                 ["pool fee", s.pool.fee + " (hundredths of a bip)"], ["pool hook", s.pool.hooks]);
    }
  }
  $("facts").innerHTML = facts.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join("");
}

// ---------------------------------------------------------------- writing
/// WHICH RECORDS FOR A LAUNCH STAND IN THE WAY OF MOVING IT. This page's own,
/// and app.html's trades and graduations - two pages must not both pay for one
/// move. Not app's creates and claims: they carry whatever token was in app's
/// form, not a claim on this launch. One predicate, because complete() refuses
/// on it and resumePending() settles by it: a record that can block this page
/// is a record this page can clear.
const countsAgainstMove = (t) =>
  t.page !== "app" || (t.kind !== "create" && t.kind !== "create-approve" && t.kind !== "claim");

async function complete() {
  const lens = $("lens").value.trim();
  const token = $("token").value.trim();
  if (!account) return show("err", "Connect a wallet first.");
  if (!isAddr(lens) || !isAddr(token)) return show("err", "Enter a LaunchLens address and a launch token address.");

  setBusy(true);
  $("complete").disabled = true;

  // THE PROVIDER IS PINNED FOR THE WHOLE PREPARATION. Re-reading
  // window.ethereum on every call means a wallet swapped underneath could
  // answer half the checks and receive the send.
  const eth = window.ethereum;
  if (!eth) { setBusy(false); return show("err", "No injected wallet found."); }
  const request = (m, p) => eth.request({ method: m, params: p });

  const done = (kind, html) => { setBusy(false); $("complete").disabled = !account; show(kind, html); };

  // The lock's name needs a chain, so this one read happens before it. Nothing
  // is decided on it - every check that matters is repeated inside the lock.
  let lockChain;
  try {
    lockChain = await request("eth_chainId", []);
  } catch (e) {
    return done("err", "Could not reach the wallet: " + escapeHtml(e.message || String(e)));
  }
  // ONCE config.js NAMES A DEPLOYMENT, NOTHING IS SENT ON ANY OTHER CHAIN (the
  // site bar's chainRefusal, as on app.html). This page reads through the
  // wallet itself, so the chain is the whole question here; the wallet is not
  // moved anywhere from this page.
  const offChain = window.CurbBar && window.CurbBar.chainRefusal ? window.CurbBar.chainRefusal(lockChain) : null;
  if (offChain) return done("err", escapeHtml(offChain));

  const lockName = "curb:send:" + lockChain + ":" + lens.toLowerCase() + ":" + token.toLowerCase();
  const lockState = await acquireSendLock(lockName);
  if (lockState === "taken") {
    return done("wait",
      `Another tab is already sending this move and is waiting for its wallet. ` +
      `Finish or cancel it there rather than sending a second transaction.`);
  }

  let sentTx = null;
  let claim = null;
  // Whether eth_sendTransaction was ever ATTEMPTED. Before it, "nothing was
  // sent" is a fact; after it, it is a guess.
  let dispatched = false;
  // Set if the wallet reports a network change while the confirm dialog is
  // open. The re-check below happens BEFORE the dialog, so it cannot see that.
  let switchedDuringDialog = false;
  const onChainChanged = () => { switchedDuringDialog = true; };
  let startChain = null;

  // EVERYTHING FROM HERE IS INSIDE THE LOCK, AND THE finally RELEASES IT.
  // An earlier version returned straight out of the "already graduated" and
  // "not waiting" branches while still holding both the Web Lock and the
  // claim. A Web Lock is held until its page lets go or closes, so that left
  // the launch un-sendable in every other tab, and the claim's three-minute
  // expiry did nothing about it.
  try {
    // RE-READ INSIDE THE LOCK. Checking the pending records before taking the
    // lock is worthless: another tab can finish and write its hash in between,
    // and this one would then send a second transaction on a stale "none
    // outstanding". Everything below is read now, holding the lock.
    // An app.html trade or graduation on THIS launch still counts; its creates
    // and claims do not (countsAgainstMove says why).
    const outstanding = unresolvedFor(lockChain, lens, token).filter(countsAgainstMove);
    if (outstanding.length) {
      return done("wait",
        `There is already a transaction for this launch that has not been accounted for: ` +
        `<code>${escapeHtml(outstanding[0].hash)}</code>. Sending another could pay for the same move twice. ` +
        `This page checks it on every load and clears it once the chain shows it was mined or replaced — ` +
        `app.html's trades on this launch included. If the chain cannot settle it, reload: this page then ` +
        `says why for one such record at a time, and offers to forget it where that is possible.`);
    }

    const elsewhere = preparingElsewhere(lockChain, lens, token);
    if (elsewhere) {
      return done("wait",
        `Another tab is already sending this move and is waiting for its wallet. ` +
        `Finish or cancel it there rather than sending a second transaction.`);
    }
    claim = claimPreparation(lockChain, lens, token);
    if (!claim) {
      return done("wait", `Another tab claimed this move at the same moment. Finish or cancel it there.`);
    }

    const chainId = await request("eth_chainId", []);
    startChain = chainId;
    if (chainId !== lockChain) throw new Error("the wallet changed networks while this was being prepared");

    const accounts = await request("eth_accounts", []);
    const from = accounts && accounts[0];
    if (!from || !same(from, account)) throw new Error("the wallet's account changed");

    // The lens must EXIST on the wallet's chain, and the graduator comes from
    // it. THIS IS NOT PROOF OF WHICH NETWORK YOU ARE ON: a fork carries the
    // same addresses as the chain it forked, so a fork and its mainnet are
    // indistinguishable this way. What it does catch is a network where this
    // deployment is absent, or where it is a different one.
    const graduator = await readGraduator(request, lens);
    if (lensGraduator && !same(graduator, lensGraduator)) {
      throw new Error(
        "The lens on your wallet's network reports a different Graduator than the one the displayed state came from. " +
        "You are looking at one deployment and about to transact on another."
      );
    }

    // And the launch must still be Waiting ON THAT CHAIN, not merely in the
    // panel above.
    const s = await readState(request, lens, token);
    if (s.status === 3) {
      await refresh(true);
      return done("ok", "Nothing to do — the move has already completed. Someone else finished it.");
    }
    if (s.status !== 2) {
      await refresh(true);
      return done("err", "On your wallet's network this launch is <strong>" + STATUS[s.status] +
        "</strong>, not Waiting. Nothing was sent.");
    }

    // SIMULATED FIRST, as app.html does: a graduation that must revert is not
    // sent. The usual cause is an issuer blocklist on the fee escrow, and the
    // exit - Graduator.rescueCurveFees, open to the curve's two payees at any
    // time and to anyone an hour after the launch is noted stuck
    // (Graduator.noteReady) - was named nowhere.
    try {
      await request("eth_call", [{ from, to: graduator, data: SEL.graduate + pad(token) }, "latest"]);
    } catch (e) {
      return done("err",
        "Completing the move would revert: " + escapeHtml(e.message || String(e)) + ". If the issuer has blocked " +
        "the fee escrow, Graduator.rescueCurveFees(" + escapeHtml(token) + ") pays the curve's fees straight to " +
        "their recipients and unblocks it. Its creator-fee recipient and the platform's recipient may call it now; " +
        "anyone else an hour after Graduator.noteReady(" + escapeHtml(token) + ") has noted the launch stuck. " +
        "app.html offers both. Nothing was sent.");
    }

    // RE-CHECKED IMMEDIATELY BEFORE SENDING. Everything above took several
    // round trips, and a network or account switch during them would otherwise
    // send to a target that was verified on a different chain.
    const chainNow = await request("eth_chainId", []);
    const accountsNow = await request("eth_accounts", []);
    if (chainNow !== chainId) throw new Error("the wallet changed networks while this was being prepared");
    if (!accountsNow[0] || !same(accountsNow[0], from)) throw new Error("the wallet changed accounts while this was being prepared");

    const snapshot = { chainId, lens, token, graduator, account: from };
    show("wait", "Waiting for you to confirm in your wallet…" +
      (lockState === "unsupported"
        ? " (This browser has no Web Locks API, so a second tab is only discouraged here, not prevented — do not send this from two tabs.)"
        : ""));

    dispatched = true;
    // Watched for the life of the request. The wallet's confirm dialog can sit
    // open for minutes, and a network switch inside it is invisible to any
    // check made beforehand.
    try { eth.on && eth.on("chainChanged", onChainChanged); } catch {}
    let hash;
    try {
      hash = await request("eth_sendTransaction", [
        { from, to: graduator, data: SEL.graduate + pad(token) },
      ]);
    } finally {
      try { eth.removeListener && eth.removeListener("chainChanged", onChainChanged); } catch {}
    }

    // `sentAt` IS THE RECORD'S AGE: one the chain cannot settle may be offered
    // for forgetting an hour on (TX.readVerdict, TX.mayForget).
    sentTx = { ...snapshot, hash, uncertainChain: switchedDuringDialog, sentNonce: null, sentAt: Date.now() };
    const stored = savePending(sentTx);
    thisSession.add(keyOf(sentTx));
    sentTx.storedOk = stored;
    if (!stored) {
      show("err",
        `This browser would not store the transaction, so it will be LOST if you reload. ` +
        `Copy this hash now: <code>${escapeHtml(hash)}</code>`);
    }
  } catch (e) {
    // CHECKED AGAINST THE TOKEN THIS ATTEMPT WAS FOR, and only on the chain it
    // was prepared against. The form may have moved to another launch while
    // the wallet dialog was open - and so may the network, in which case the
    // same lens and token address on a DIFFERENT chain would answer, and
    // "someone else finished it" would be about another chain's launch.
    let after = null;
    try {
      const chainNow = await request("eth_chainId", []);
      if (startChain && chainNow === startChain) after = await readState(request, lens, token);
    } catch {}

    const drifted = token !== $("token").value.trim() || lens !== $("lens").value.trim();
    const about = drifted ? ` (for <code>${escapeHtml(token)}</code>, no longer the one in the form)` : "";

    // A USER REJECTION IS THE ONLY ERROR AFTER DISPATCH THAT MEANS "NOTHING WAS
    // SENT". EIP-1193 code 4001 says the user declined; anything else - a
    // dropped connection, a provider that threw after dispatching - may have
    // broadcast the transaction anyway, and claiming otherwise invites a second
    // payment for the same move.
    const rejected = e && (e.code === 4001 || /user rejected|user denied/i.test(e.message || ""));
    const why = escapeHtml(e.message || String(e));

    setBusy(false);
    $("complete").disabled = !account;
    if (after && after.status === 3) {
      show("ok", `That launch is graduated${about} — someone else completed it.`);
    } else if (!dispatched) {
      show("err", `Nothing was sent${about} — ${why}. You can try again.`);
    } else if (rejected) {
      show("err", `Nothing was sent${about}: you declined it in the wallet. You can try again.`);
    } else {
      show("wait",
        `The wallet was asked to send and then failed${about}: ${why}. ` +
        `It is NOT certain nothing was broadcast — check your wallet's activity before sending again.`);
    }
    if (!drifted) await refresh(true);
    return;
  } finally {
    // ONE PLACE. Every path out of the block above passes through here, which
    // is the only way a lock survives refactoring.
    releasePreparation(claim);
    claim = null;
    dropSendLock();
  }

  if (sentTx) {
    // THE NONCE THE TRANSACTION CARRIES, read back from the wallet that sent
    // it - AFTER the lock is released. The record is already written, and a
    // read that is slow to answer must not hold every other tab off the move
    // (a second attempt was told "another tab is sending" instead of "already a
    // transaction"). It is what lets a graduation the wallet sped up or
    // cancelled be recognised on the next load, once the account's nonce has
    // moved past it. Never guessed: null stays null.
    // AND ONLY WHILE THE WALLET IS ON THE RECORD'S CHAIN, asked just before.
    // After a switch inside the dialog it answered on the chain it had moved
    // to, and that chain's nonce - at or above this chain's count - judged the
    // record "pending" here for as long as the count stayed below it, with no
    // Forget, refusing the move and app.html's trades (round 5, P-R22, S16). A
    // wallet on another chain now also marks the record uncertain: it need not
    // have emitted the event.
    let carried = null;
    try {
      const chainNow = await request("eth_chainId", []);
      if (chainNow === sentTx.chainId) {
        carried = await TX.nonceOfHash(sentTx.hash, [request], sentTx.account);
      } else if (!sentTx.uncertainChain) {
        sentTx.uncertainChain = true;
        TX.updatePending(sentTx, { uncertainChain: true });
      }
    } catch { carried = null; }
    if (carried !== null) {
      sentTx.sentNonce = carried;
      TX.updatePending(sentTx, { sentNonce: carried });
    }
    await settle(sentTx, eth);
  }
}

/// SENT IS NOT DONE, and the result is checked against the transaction's OWN
/// snapshot rather than whatever the form says by the time it lands.
async function settle(tx, eth) {
  eth = eth || window.ethereum;
  settling.add(keyOf(tx));
  try {
    return await settleInner(tx, eth);
  } finally {
    settling.delete(keyOf(tx));
  }
}

async function settleInner(tx, eth) {
  // Appended to every message below. A page that could not store the hash must
  // keep saying so - an earlier version showed the warning and then overwrote
  // it with settle()'s own first line.
  const lossWarning = tx.storedOk === false
    ? ` This browser would not store it, so it is LOST if you reload — copy the hash now.`
    : "";
  const link = `<code>${escapeHtml(tx.hash)}</code>`;
  show("wait", `Tracking ${link}. Waiting for it to be mined…${lossWarning}`);

  let receipt;
  try {
    receipt = await waitForReceipt(tx, eth);
  } catch (e) {
    setBusy(false);
    $("complete").disabled = !account;
    // NOT A FAILURE. Whether the wait timed out or the wallet moved networks,
    // the transaction may still be in the mempool, so the hash is kept and
    // nothing is claimed about it either way.
    const why = (e && e.message) === "timed out"
      ? "no receipt yet"
      : escapeHtml(e.message || String(e));
    return show("wait",
      `Could not confirm ${link}: ${why}. It may still be mined — this is NOT a failure, and sending again ` +
      `could pay for the same move twice. Check that hash in your wallet or an explorer before retrying.${lossWarning}`);
  }

  setBusy(false);
  $("complete").disabled = !account;
  clearPending(tx);

  // Read the outcome on the chain the transaction was SENT to, for the token
  // it was sent for - not the current form.
  let after = null;
  try {
    const request = (m, p) => eth.request({ method: m, params: p });
    const nowChain = await request("eth_chainId", []);
    if (nowChain === tx.chainId) {
      after = await readState(request, tx.lens, tx.token);
    }
  } catch { /* fall through to the honest "cannot confirm" branch */ }

  const drifted = tx.token !== $("token").value.trim() || tx.lens !== $("lens").value.trim();
  const about = drifted ? ` (for token <code>${escapeHtml(tx.token)}</code>, which is no longer the one in the form)` : "";

  if (tx.uncertainChain) {
    // The wallet changed networks while the confirm dialog was open, so what
    // it signed and where it went are not established by anything checked
    // before the dialog opened.
    return show("wait",
      `${link} was signed while the wallet changed networks, so which chain it went to is not established here. ` +
      (after && after.status === 3
        ? `The launch on the chain it was prepared for IS graduated, but that may be someone else's doing.`
        : `Check the hash in your wallet before sending anything else.`));
  }

  if (receipt.status !== "0x1") {
    if (after && after.status === 3) {
      show("ok", `Your transaction reverted${about}, but that launch is graduated — someone else completed it first.`);
    } else {
      show("err", `The transaction was mined but reverted${about}. Nothing changed; you can try again.`);
    }
  } else if (after && after.status === 3) {
    show("ok", `Done — confirmed on chain, not just submitted${about}. Trading now happens in the pool.`);
  } else if (after) {
    show("err", `The transaction succeeded but that launch still does not read as graduated${about}. Do not assume it worked.`);
  } else {
    show("wait", `The transaction succeeded${about}, but the wallet is no longer on the network it was sent to, so the result could not be confirmed here.`);
  }

  if (!drifted) await refresh(true);
}

function dispose() { disposed = true; }

/// The poll lives in tx-core.js; the disposed flag stays with this page.
const waitForReceipt = (tx, eth, timeoutMs) =>
  waitForReceiptCore(tx, eth, { timeoutMs, isDisposed: () => disposed });

// ---------------------------------------------------------------- wiring
$("connect").onclick = async () => {
  try {
    const accounts = await walletProvider().request({ method: "eth_requestAccounts" });
    account = accounts[0];
    const chainId = await walletProvider().request({ method: "eth_chainId", params: [] });
    $("wallet").textContent =
      `Connected: ${account} on chain ${parseInt(chainId, 16)} — this address pays the gas for any transition it completes. ` +
      `Reads switch to the wallet's network while it is connected.`;
    // THE SITE BAR SHOWS THE ACCOUNT TOO (topbar.js). Nothing listens in tests.html.
    document.dispatchEvent(new CustomEvent("curb:page-account", { detail: account }));
    await refresh();
    await resumePending();
  } catch (e) {
    show("err", escapeHtml(e.message || String(e)));
  }
};
$("refresh").onclick = () => refresh();
$("complete").onclick = complete;

for (const id of ["lens", "token", "rpc"]) {
  $(id).addEventListener("change", () => {
    const v = {};
    for (const k of ["lens", "token", "rpc"]) v[k] = $(k).value.trim();
    try { localStorage.setItem(STORE, JSON.stringify(v)); } catch {}
    refresh();
  });
}

/// A TRANSACTION SURVIVES A REFRESH. Without this the hash lives only in the
/// tab that sent it, so "we kept your hash" was true exactly until the user
/// reloaded - which is when they are most likely to be looking for it.
async function resumePending() {
  // Anything this page is already settling is not "from a previous visit" and
  // must not be announced as one.
  // THIS PAGE'S OWN RECORDS, AND APP'S ONLY WHERE THEY BLOCK THIS PAGE.
  // app.html writes into the same store and marks its records page:"app"; this
  // used to settle and DELETE all of them - the create record app keeps so it
  // can recover a new token's address included - and then report on whatever
  // token was in app's form. So app's records were left alone entirely, and
  // then an app trade on the launch on screen refused complete() with advice
  // to reload that could not clear it. The ones countsAgainstMove counts, for
  // the launch on screen, are settled here too; nothing else of app's is.
  const onScreenToken = $("token").value.trim();
  const onScreenLens = $("lens").value.trim();
  const all = loadPendingAll().filter((t) =>
    (t.page !== "app" ||
      (countsAgainstMove(t) && same(t.lens, onScreenLens) && same(t.token, onScreenToken))) &&
    !settling.has(keyOf(t)) && !thisSession.has(keyOf(t)));
  if (!all.length) return;

  // PICK THE ONE THIS PAGE CAN ACTUALLY ACT ON. Taking all[0] meant a stale
  // record from another chain could hide a newer one on the chain the user is
  // on, permanently: nothing would ever resolve it, so it would stay first.
  let currentChain = null;
  try { currentChain = window.ethereum ? await window.ethereum.request({ method: "eth_chainId" }) : null; } catch {}
  // IDENTITY IS chainId + lens + token, HERE TOO. Scoring on the token alone
  // let a record belonging to a DIFFERENT LaunchLens deployment outrank the one
  // for the launch actually on screen, because the same token address exists
  // under both. unresolvedFor() has always used the triple; this did not.
  const score = (t) =>
    (t.chainId === currentChain ? 2 : 0) +
    (same(t.token, onScreenToken) && same(t.lens, onScreenLens) ? 1 : 0);
  const sorted = [...all].sort((a, b) => score(b) - score(a));
  const tx = sorted[0];
  if (!tx || !tx.hash) return;

  // And the others are listed rather than left invisible.
  const rest = sorted.slice(1);
  const alsoNote = rest.length
    ? ` ${rest.length} other unaccounted transaction${rest.length > 1 ? "s" : ""}: ` +
      rest.map((t) => `<code>${escapeHtml(t.hash.slice(0, 12))}…</code> on chain ${parseInt(t.chainId, 16)}`).join(", ") + "."
    : "";

  // SHOWN WITH OR WITHOUT A WALLET. A locked or absent wallet is the ordinary
  // case on a reload, and it is exactly when an unaccounted transaction most
  // needs to be visible - and the RPC field, when it serves the record's
  // chain, can still check it (recordTransport).
  await actOnRecord(tx, window.ethereum || null, alsoNote);
}

/// WHERE A RECORD IS ASKED ABOUT: the wallet while it is on the record's
/// chain, then the RPC field when it serves that chain. launch.html fills that
/// field only from what the person typed or saved - it takes nothing from the
/// link - so it is an endpoint the person chose. A record whose wallet had
/// moved to another chain used to be checked nowhere at all.
/// @return {request, wallet} or {none: true, walletChain}.
async function recordTransport(tx, eth) {
  let walletChain = null;
  if (eth) {
    try { walletChain = await eth.request({ method: "eth_chainId" }); } catch { walletChain = null; }
    if (walletChain === tx.chainId) return { request: (m, p) => eth.request({ method: m, params: p }), wallet: true };
  }
  if (($("rpc").value || "").trim()) {
    let rpcChain = null;
    try { rpcChain = await rpcRequest("eth_chainId", []); } catch { rpcChain = null; }
    if (rpcChain === tx.chainId) return { request: rpcRequest, wallet: false };
  }
  return { none: true, walletChain };
}

/// Which launch a record is for, said so two records can be told apart.
function describeRecord(tx) {
  return `for <code>${escapeHtml(tx.token)}</code> on chain ${parseInt(tx.chainId, 16)}` +
    // Only when it is not the deployment on screen: otherwise it is noise, and
    // when it IS different it is the only thing telling two records apart.
    (same(tx.lens, $("lens").value.trim())
      ? ""
      : ` through a different LaunchLens, <code>${escapeHtml(tx.lens)}</code>,`) +
    (tx.page === "app" ? ` (sent from app.html: ${escapeHtml(tx.what || "a trade")})` : "");
}

/// WHAT THE CHAIN PROVES ABOUT ONE RECORD, ACTED ON. TX.judgePending decides,
/// the same questions app.html asks: a receipt settles it; a nonce the account
/// has moved past, with no receipt and no node that knows the hash on a second
/// look, clears it as replaced; anything short of that keeps it.
/// @return "forgettable" when nothing on chain can settle it - or nothing can
///         read it an hour on - "dropped:<nonce>" for a transaction the network
///         let go, and "" otherwise; only the first two may be ended by hand.
///         The message is shown here.
async function actOnRecord(tx, eth, alsoNote) {
  // AN AGE FOR EVERY RECORD, so one the chain will never settle can be let go
  // an hour on (TX.stampJudged says where the age comes from).
  tx = TX.stampJudged(tx);
  const link = `<code>${escapeHtml(tx.hash)}</code>`;
  const forToken = describeRecord(tx);
  const twice = " Sending again could pay for the same move twice.";
  const button = `<button type="button" class="forget" data-forget="${escapeHtml(keyOf(tx))}">Forget this record</button>`;
  const age = TX.ageOf(tx);
  const old = age === null ? "" : ` It was first recorded here ${TX.ageText(age)} ago.`;
  // NOTHING CAN READ IT: let go only past the hour, and said which side of it
  // this record is on.
  const unread = (lead) => {
    const stale = TX.isStale(tx);
    show("wait", `${lead}${twice}` +
      (stale
        ? `${old} That is past the hour after which this page lets a record nothing can read be forgotten; if ` +
          `your wallet's activity shows it never went through, you can forget it. ${button}`
        : ` If nothing can read it an hour after it was first recorded here, this page offers to forget it.`) +
      alsoNote);
    return stale ? "forgettable" : "";
  };

  let where;
  try { where = await recordTransport(tx, eth); } catch { where = { none: true, walletChain: null }; }
  if (where.none) {
    const lead = `A transaction from a previous visit is unaccounted for: ${link}, ${forToken}.`;
    if (!eth) return unread(`${lead} Connect the wallet that sent it to check.`);
    if (where.walletChain) {
      return unread(`${lead} Your wallet is on chain ${parseInt(where.walletChain, 16)}, and the RPC field does ` +
        `not serve chain ${parseInt(tx.chainId, 16)} either, so it cannot be checked from here.`);
    }
    return unread(`${lead} The wallet would not say which network it is on, so it cannot be checked from here.`);
  }

  try {
    // A SEND SIGNED WHILE THE WALLET CHANGED NETWORKS is "uncertain" on any
    // verdict short of a receipt - its nonce may be another chain's - and a
    // nonce unused an hour on with no node that knows the hash is "dropped"
    // (TX.readVerdict). Both may be forgotten by hand.
    const verdict = TX.readVerdict(tx, await TX.judgePending(tx, where.request));
    if (verdict.nonce && tx.sentNonce == null) TX.updatePending(tx, { sentNonce: verdict.nonce });

    if (verdict.state === "mined") {
      if (tx.page === "app" || !where.wallet) {
        // APP'S RECORD, APP'S WORDS - and a receipt read through the RPC field
        // cannot go through settle(), which waits through the wallet. Only
        // whether it landed is said here; what a trade delivered is app.html's
        // to work out from its receipt.
        clearPending(tx);
        const ok = verdict.receipt.status === "0x1";
        show(ok ? "ok" : "err",
          `A transaction from a previous visit ${forToken} ${ok ? "succeeded" : "reverted"}: ${link}.${alsoNote}`);
        if (tx.page !== "app") await refresh(true);
        return "";
      }
      // It landed. Judge it exactly as settle() would have.
      setBusy(false);
      await settle(tx, eth);
      return "";
    }

    if (verdict.state === "replaced") {
      clearPending(tx);
      show("wait",
        `A transaction from a previous visit was replaced or dropped by the wallet - its nonce has been used by ` +
        `another transaction: ${link}, ${forToken}. Its record is cleared; check the wallet's activity for what ` +
        `went through instead.${alsoNote}`);
      await refresh(true);
      return "";
    }

    const n = verdict.nonce ? parseInt(verdict.nonce, 16) : null;
    if (verdict.state === "pending") {
      show("wait", `A transaction from a previous visit has still not been mined: ${link}, ${forToken}.` +
        (verdict.seen
          ? ` The node still has it, waiting to be mined.${twice}`
          : ` Its nonce (${n}) has not been used by anything else, so it still can be.${twice} If your wallet ` +
            `shows it, cancel or speed it up there. If it does not, the wallet may have dropped it: ` +
            `${TX.useTheNonce(n)} If no node knows the hash an hour after it was sent, this page offers to ` +
            `forget it.`) +
        alsoNote);
      return "";
    }

    const why = {
      // "replaced" OR AN UNUSED NONCE ON A RECORD SIGNED ACROSS A NETWORK
      // SWITCH: this chain's nonce cannot speak for it either way.
      uncertain:
        `It was signed while the wallet changed networks, so which chain it went to is not established, and ` +
        `this chain's nonce cannot say what became of it.${twice} Check the hash in your wallet; if it went ` +
        `elsewhere or never went through, you can forget it.`,
      dropped:
        `Its nonce (${n}) is unused, and the node does not know the hash.${old} The network has most likely ` +
        `dropped it - but a wallet that still holds it can send it again, so to be sure it never lands, use the ` +
        `nonce first. ${TX.useTheNonce(n)}${twice} If you have checked, you can forget it.`,
      // A NONCE THIS CHAIN NEVER REACHES (tx-core judgePending): the wallet's
      // count is another chain's. app.js aheadWords says the same.
      ahead:
        `Your wallet's transaction count does not match this chain: it signed this as transaction number ${n}, ` +
        `but this account has sent only ${verdict.chainCount ? parseInt(verdict.chainCount, 16) : "fewer"} here, ` +
        `so it can never go through on this chain. Reset the wallet's activity for this account, then forget ` +
        `this record.`,
    }[verdict.state] ||
      `The node does not know that hash and there is no nonce to judge it by, so nothing on chain can settle ` +
      `it.${twice} Check your wallet's activity; if it is not there and never went through, you can forget it.`;
    show("wait", `A transaction from a previous visit has still not been mined: ${link}, ${forToken}. ${why} ` +
      button + alsoNote);
    return verdict.state === "dropped" ? "dropped:" + n : "forgettable";
  } catch (e) {
    return unread(`Could not check a transaction from a previous visit (${link}, ${forToken}): ` +
      `${escapeHtml(e.message || String(e))}.`);
  }
}

/// ENDED BY HAND, AND ONLY WHILE THE CHAIN STILL HAS NOTHING TO SAY. Asked
/// again first: it may have mined, or been replaced, since the button was drawn.
async function forgetRecord(key) {
  if (disposed || busy) return;
  const tx = loadPendingAll().find((t) => keyOf(t) === key);
  if (!tx) return;
  const verdict = await actOnRecord(tx, window.ethereum || null, "");
  if (verdict !== "forgettable" && verdict.indexOf("dropped:") !== 0) return;
  // WHAT FORGETTING ALLOWS, said before it is done - and for a dropped one,
  // how to make sure it never lands.
  const n = verdict.indexOf("dropped:") === 0 ? verdict.slice(8) : null;
  const ok = window.confirm(
    `Forget the record of ${tx.hash}?\n\nOnly do this if your wallet's activity shows it never went through. ` +
    `This page will stop refusing a second send because of it - and if it did go through, or goes through ` +
    `later, a second send pays for the same move twice.` +
    (n !== null && n !== "null"
      ? `\n\nA wallet that kept it can still send it. Any transaction from this account at nonce ${n} - a ` +
        `zero-value send to yourself - makes sure it never lands.`
      : ""));
  if (!ok) return;
  clearPending(tx);
  show("wait", `The record of <code>${escapeHtml(tx.hash)}</code> is forgotten. If it turns up in your wallet's ` +
    `activity after all, it was real.`);
}

async function init() {
  migratePendingStore();
  // THE FORGET BUTTON lives inside the message line, which show() redraws
  // whole, so it is listened for once here rather than wired per drawing.
  $("msg").addEventListener("click", (e) => {
    const b = e.target && e.target.closest && e.target.closest("button[data-forget]");
    if (b) forgetRecord(b.getAttribute("data-forget"));
  });
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || "{}");
    for (const k of ["lens", "token", "rpc"]) if (saved[k]) $(k).value = saved[k];
  } catch {}

  // AFTER A DISCONNECT IN THE SITE BAR the silent check is not made, and the
  // wallet's own account events are ignored, until the person connects again.
  const barHidden = () => !!(window.CurbBar && window.CurbBar.isHidden());
  if (window.ethereum) {
    try {
      const a = barHidden() ? [] : await window.ethereum.request({ method: "eth_accounts" });
      if (a && a[0]) {
        account = a[0];
        const chainId = await window.ethereum.request({ method: "eth_chainId" });
        $("wallet").textContent =
          `Connected: ${account} on chain ${parseInt(chainId, 16)} — this address pays the gas for any transition it completes.`;
      }
    } catch {}
    // THE NOTE FOLLOWS THE ACCOUNT. It used to keep naming the account the
    // wallet had just switched away from.
    window.ethereum.on?.("accountsChanged", async (a) => {
      if (barHidden()) return;
      account = a && a[0];
      $("wallet").textContent = account
        ? `Connected: ${account} — this address pays the gas for any transition it completes.`
        : "No wallet connected. Reading works without one; completing a transition needs one.";
      await refresh();
      await resumePending();
    });
    window.ethereum.on?.("chainChanged", async () => { await refresh(); await resumePending(); });
  }

  if (isAddr($("lens").value) && isAddr($("token").value)) await refresh(true);
  // ALWAYS, wallet or not. An unaccounted transaction is not something to show
  // only to users who happen to have an unlocked wallet.
  await resumePending();
}

window.CurbLaunch = {
  init, refresh, complete, settle, resumePending,
  loadPendingAll, savePending, clearPending,
  loadPreparing, claimPreparation, releasePreparation, PAGE_ID,
  acquireSendLock, dropSendLock, LOCKS_SUPPORTED, unresolvedFor,
  migratePendingStore, dispose,
};

if (!window.__CURB_TEST__) init();

})();
