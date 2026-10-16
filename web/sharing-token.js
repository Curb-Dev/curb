// HOLDER SHARING ON A LAUNCH'S OWN PAGE (/token/0x..., app.html in its token
// view). Drawn from web/sharing.js's readers; every transaction goes through
// app.js's own pin, lock, record and receipt (CurbApp.beginAction / send), so
// this file adds no way of sending - only the calldata.
//
// WHAT IT DRAWS
//   NOT ON THE TRADE PAGE (the owner's call): what a holder earned and claims
//   is on Holder fees (sharing-page.js). The card below opens only when asked
//   for by name - token/0x…#holders (or #claim) - for the details behind it.
//   There, once the launch's holder sharing is on (#tvShare): the
//   distributor, since when, what it received and paid, the keeper's fees, what
//   is not yet allocated, the payout in force or waiting out its veto hour, any
//   veto, every announced change to the roles behind it, and "Push pending
//   payouts", which anyone may send.
//   For a connected holder: what they earned, were paid and can claim, what is
//   still building up below the push threshold, an estimate of the next payout
//   (said to be one), their share epoch by epoch, Claim - and Claim to another
//   address of theirs when the issuer blocks this one or it cannot receive.
//   The check of each published epoch file (#tvVerify).
//   For the creator wallet (#tvCreatorShare, in the fees card): before the
//   switch, the button that throws it, behind a typed confirmation; after it,
//   what the lock holds for the creator from before, and that the principal
//   stays locked forever.
(function () {
"use strict";
if (!document.documentElement.classList.contains("tokenView")) return;
const App = window.CurbApp;
const Sh = window.CurbSharing;
if (!App || !Sh) return;

const $ = (id) => document.getElementById(id);
const { el, fmt, same, isZero, isAddr, short, SEL, REFUSALS, pad, padNum } = Sh;
const C = Sh.constants;
const { words, wordToAddress, wordToBig, encode, T } = window.CurbAbi;
const S = () => App.state;

const ZERO = "0x0000000000000000000000000000000000000000";
const WETH = "0x4200000000000000000000000000000000000006";
const TRANSFER_REFUSED = window.CurbKeccak.keccak256("0x" + window.CurbAbi.utf8Hex("TransferRefused(address,address)")).slice(0, 10);
/// The selector a revert carries, wherever the node put it (app.js revertSentence reads it the same way).
function revertSelector(e) {
  const inMessage = /custom error:?\s*(0x[0-9a-fA-F]{8})/i.exec((e && e.message) || "");
  const raw = typeof (e && e.data) === "string" ? e.data
    : e && e.data && typeof e.data.data === "string" ? e.data.data : inMessage ? inMessage[1] : "";
  return raw.slice(0, 10).toLowerCase();
}

/// What was read, for the token on screen. Replaced whole on every read.
const V = {
  token: "",
  seq: 0,
  data: null,        // see load()
  fileFor: "",       // the contentHash of the file in V.data.file
  history: null,     // { for: contentHash, rows } once walked
  verify: null,      // { epoch, result } of the last check drawn
  removals: { for: "", list: [], at: 0 },
  timer: null,
};

const quoteDec = () => (S().ctx ? S().ctx.quoteDecimals : 18);
const quoteSym = () => (S().ctx ? App.displaySymbol(S().ctx.quoteSym || "") : "");
const isWethPair = () => !!(S().ctx && same(S().ctx.quote, WETH));
const two = (a0, a1, sym1) =>
  fmt(a0, quoteDec(), 6) + " " + quoteSym() + (a1 && a1 > 0n ? " + " + fmt(a1, 18, 4) + " " + sym1 : "");
const chainNow = () => (V.data && V.data.head ? V.data.head.ts + Math.floor((Date.now() - V.data.head.at) / 1000) : null);

// ---------------------------------------------------------------- reading
/// Everything the sharing parts of this page draw, read in one pass.
async function load() {
  const st = S();
  const v = st.view;
  if (!v || !st.viewFor || !same(st.viewFor.token, st.chainCfg.token) || !st.ctx) return null;
  const token = st.chainCfg.token;
  const r = Sh.reader(st.chainCfg.rpc);
  const head = await r.head();
  const chainId = parseInt(await r.rpc("eth_chainId", []), 16);
  const graduator = st.ctx.graduator || st.graduatorAddr;
  // WORD 15 OF THE LENS, or - from a lens that cannot say - the Graduator itself.
  let d = v.holderDistributor;
  if (d === null || d === undefined) {
    d = await r.call(graduator, SEL.holderDistributorOf + pad(token)).then((x) => wordToAddress(words(x)[0])).catch(() => ZERO);
  }
  const symW = await r.call(token, SEL.symbol).catch(() => "0x");
  const sym1 = decodeSym(symW) || "TOKEN";
  const base = { token, r, head, chainId, graduator, d, view: v, sym1, account: st.account, ctx: st.ctx };
  if (isZero(d)) return { ...base, on: false };

  const [dist, sinceW, lockW] = await Promise.all([
    Sh.readDistributor(r, d),
    r.call(graduator, SEL.sharingSince + pad(token)),
    r.call(graduator, SEL.lockOf + pad(token)),
  ]);
  const since = Number(wordToBig(words(sinceW)[0]));
  const lock = wordToAddress(words(lockW)[0]);
  const roles = await Sh.readRoles(r, dist.factory);
  const now = head.ts;
  const force = Sh.inForce(dist, now);
  // THE FILE OF THE ROOT IN FORCE, used only once its sha256 is the chain's.
  let file = null, fileOk = false, fileSource = "", fileTried = [];
  if (force.root.epoch > 0) {
    const got = await Sh.loadFile({ chainId, d, epoch: force.root.epoch, contentHash: force.root.contentHash,
      uri: async () => ((await Sh.publishedEvent(r, d, force.root, head.number)) || {}).uri || "" });
    fileTried = got.tried;
    if (got.ok) {
      // the connected holder's part of it (all of it, for a file of at most 512 accounts)
      try { file = await Sh.parsedFile(got.bytes, { account: st.account }); fileOk = true; fileSource = got.source; } catch { file = null; }
    }
  }
  // THE PAYOUT WAITING ITS HOUR, when there is one: what it would give, from
  // its own file, checked against its own hash.
  let pendingFile = null;
  if (Sh.hasPending(dist) && !force.ripe) {
    const got = await Sh.loadFile({ chainId, d, epoch: dist.pending.epoch, contentHash: dist.pending.contentHash,
      uri: async () => ((await Sh.publishedEvent(r, d, dist.pending, head.number)) || {}).uri || "" });
    if (got.ok) { try { pendingFile = await Sh.parsedFile(got.bytes, { account: st.account }); } catch { pendingFile = null; } }
  }
  // WHAT IS EARNED AND NOT YET COLLECTED INTO THE DISTRIBUTOR: its escrow
  // credit, the hook's debt to it, the curve's pending tax while it is the
  // curve's recipient, and what the lock holds for it. harvest() takes it all.
  const toCollect = await readToCollect(r, dist, lock, v);
  // THE HOLDER'S OWN LINE.
  let me = null;
  if (st.account) {
    me = await readHolder(r, dist, force, file, st.account, v, lock);
    me.pendingLeaf = pendingFile ? Sh.leafOf(pendingFile, st.account) : null;
  }
  return { ...base, on: true, dist, since, lock, roles, force, file, fileOk, fileSource, fileTried, toCollect, me, pendingFile };
}

function decodeSym(raw) {
  try { return window.CurbMeta && window.CurbMeta.decodeString ? window.CurbMeta.decodeString(raw).slice(0, 16) : ""; }
  catch { return ""; }
}

async function readToCollect(r, dist, lock, v) {
  const q = dist.quoteToken;
  const calls = [
    { to: dist.escrow, data: SEL.escrowBalanceOf + pad(dist.d) + pad(q) },
    { to: dist.hook, data: SEL.hookOwed + pad(dist.d) + pad(q) },
  ];
  const onCurve = v.status === 1 || v.status === 2;
  if (onCurve) {
    calls.push({ to: dist.curve, data: SEL.deployer }, { to: dist.curve, data: SEL.creatorTaxBalance },
      { to: dist.curve, data: SEL.quoteFeeBalance }, { to: dist.curve, data: SEL.protocolFeeShareBps });
  }
  if (!isZero(lock)) calls.push({ to: lock, data: SEL.held + pad(dist.d) + padNum(0) }, { to: lock, data: SEL.held + pad(dist.d) + padNum(1) });
  const got = await r.calls(calls);
  const b = (x) => { const w = words(x || "0x"); return w.length ? wordToBig(w[0]) : 0n; };
  let q0 = b(got[0]) + b(got[1]);
  let t1 = 0n;
  let i = 2;
  if (onCurve) {
    const dep = got[i] ? wordToAddress(words(got[i])[0]) : ZERO;
    if (same(dep, dist.d)) {
      const fee = b(got[i + 2]);
      q0 += b(got[i + 1]) + (fee - (fee * b(got[i + 3])) / 10000n);
    }
    i += 4;
  }
  if (!isZero(lock)) {
    // The lock's two currencies are the pool's, in address order; the quote is one of them.
    const quoteIs0 = same(v.poolKey.currency0, q);
    const h0 = b(got[i]), h1 = b(got[i + 1]);
    if (quoteIs0) { q0 += h0; t1 += h1; } else { q0 += h1; t1 += h0; }
  }
  return { q0, t1 };
}

/// ONE HOLDER'S STANDING under the root in force: earned (the leaf's
/// cumulative values), paid, claimable, whether the issuer blocks them, and an
/// estimate of the next payout.
async function readHolder(r, dist, force, file, who, v, lock) {
  const [p0, p1, bal, supply, excl] = await r.calls([
    { to: dist.d, data: SEL.paid0 + pad(who) }, { to: dist.d, data: SEL.paid1 + pad(who) },
    { to: S().chainCfg.token, data: SEL.balanceOf + pad(who) },
    { to: S().chainCfg.token, data: SEL.totalSupply }, { to: dist.d, data: SEL.isExcluded + pad(who) },
  ]);
  const b = (x) => { const w = words(x || "0x"); return w.length ? wordToBig(w[0]) : 0n; };
  const paid0 = b(p0), paid1 = b(p1);
  const leaf = file ? Sh.leafOf(file, who) : { cum0: 0n, cum1: 0n };
  const claim0 = leaf.cum0 > paid0 ? leaf.cum0 - paid0 : 0n;
  const claim1 = leaf.cum1 > paid1 ? leaf.cum1 - paid1 : 0n;
  // WHETHER A CLAIM TO THIS ADDRESS CAN LAND: the issuer's receiving side for a
  // stock pair, the FiatToken blacklist for cbBTC, cbXRP and USDC. Never read as
  // a yes when it cannot be asked; an asset with neither (WETH, VIRTUAL, AERO)
  // blocks nothing.
  const q = dist.quoteToken;
  const ask = (to, data) => r.call(to, data);
  const recv = await App.policyAllows(q, who, "receive", ask);
  const listed = await App.coinBlacklists(q, who, ask);
  const blocked = (recv.known && !recv.allowed) || listed;
  // THE ESTIMATE: the share of what is not yet allocated (and what is still to
  // be collected) that this balance would take if it were held through the
  // epoch, against every balance that shares - the supply less what the
  // excluded addresses hold. Time weighting makes the real figure differ.
  const excluded = file ? file.rules.exclusions.map((x) => x.address) : [];
  for (const a of [dist.curve, dist.hook, lock, dist.d, "0x000000000000000000000000000000000000dead",
    "0x498581ff718922c3f8e6a244956af099b2652b2b"]) if (a && !isZero(a) && !excluded.includes(a.toLowerCase())) excluded.push(a.toLowerCase());
  const exBal = await r.calls(excluded.map((a) => ({ to: S().chainCfg.token, data: SEL.balanceOf + pad(a) })));
  const eligible = b(supply) - exBal.reduce((s, x) => s + b(x), 0n);
  return { who, paid0, paid1, leaf, claim0, claim1, balance: b(bal), eligible, excluded: b(excl) === 1n,
    blocked, policy: recv.policy || "", listed };
}

// ---------------------------------------------------------------- drawing: everyone
/// Whether the holder card was asked for: token/0x…#holders, or #claim.
const asked = () => location.hash === "#holders" || location.hash === "#claim";

function draw(data) {
  const card = $("tvShare");
  if (!card) return;
  drawCreator(data);
  if (!data || !data.on || !asked()) { card.hidden = true; card.replaceChildren(); return; }
  card.hidden = false;
  const { dist, force, roles, since, chainId, sym1 } = data;
  const now = data.head.ts;
  const kids = [];

  // ---- the badge and the distributor
  const head = el("div", { class: "shHead" }, [
    el("span", { class: "shBadge", id: "tvShareBadge", text: "Holders earn" }),
    el("h3", { text: "Holders earn this launch's fees since block " + since }),
  ]);
  kids.push(head);
  kids.push(el("p", { class: "shWho" }, [
    "Distributor ", Sh.addrEl(dist.d, chainId), roles.version !== null ? " · v" + roles.version : "",
  ]));

  // ---- the figures
  const unalloc0 = (dist.received0 || 0n) - force.root.cumHolders0 - force.root.cumKeeper0;
  const unalloc1 = (dist.received1 || 0n) - force.root.cumHolders1;
  const box = (id, value, label) => el("div", { class: "shBox" }, [el("b", { id, text: value }), el("span", { text: label })]);
  kids.push(el("div", { class: "shGrid" }, [
    box("shReceived", two(dist.received0, dist.received1, sym1), "received"),
    box("shPaid", two(dist.totalPaid0, dist.totalPaid1, sym1), "paid to holders"),
    box("shKeeper", fmt(force.root.cumKeeper0, quoteDec(), 6) + " " + quoteSym(), "keeper gas (max 2%)"),
    box("shUnalloc", two(unalloc0 < 0n ? 0n : unalloc0, unalloc1 < 0n ? 0n : unalloc1, sym1), "for the next payout"),
  ]));
  if (data.toCollect.q0 > 0n || data.toCollect.t1 > 0n) {
    kids.push(el("p", { class: "shNote", id: "shToCollect", text: "To collect: " + two(data.toCollect.q0, data.toCollect.t1, sym1) }));
  }

  // ---- the epoch
  kids.push(drawEpoch(data, now));

  // ---- warnings about the roles behind the payouts
  const warn = Sh.roleWarnings(roles, now, V.removals.for === dist.factory ? V.removals.list : []);
  for (const p of V.removals.for === dist.factory ? V.removals.catalog || [] : []) warn.push(p);
  if (warn.length) {
    kids.push(el("ul", { class: "shWarn", id: "shWarnings" }, warn.map((w) => el("li", { text: w }))));
  }

  // ---- push pending payouts
  kids.push(drawPush(data));

  // ---- the holder's own panel
  kids.push(drawHolder(data));

  // ---- the verify panel
  kids.push(drawVerifyShell(data));

  card.replaceChildren(...kids);
  tick();
}

function drawEpoch(data, now) {
  const { dist, force } = data;
  const wrap = el("div", { class: "shEpoch", id: "shEpoch" });
  const lines = [];
  const p = dist.pending;
  if (Sh.hasPending(dist) && !force.ripe) {
    const left = p.payableAt - now;
    lines.push(el("div", { class: "shState pending", id: "shPendingLine" }, [
      "Epoch " + p.epoch + " is published and pays " + (dist.frozen ? "once publishing is unfrozen - until then it waits, and can still be vetoed" : "in "),
      dist.frozen ? "" : el("b", { class: "shCountdown", id: "shCountdown", "data-at": String(p.payableAt), text: Sh.untilText(left) }),
      dist.frozen ? "." : ", unless a vetoer stops it before then.",
    ]));
  }
  if (force.root.epoch > 0) {
    const r = force.root;
    lines.push(el("div", { class: "shState active", id: "shActiveLine", text:
      "In force: epoch " + r.epoch + ", blocks " + r.fromBlock + " to " + r.toBlock + ". " +
      // A RIPE ROOT IS IN FORCE ALREADY: the next claim or push makes it active.
      (force.ripe ? "Its veto hour is over. " : "") +
      (data.fileOk ? paidCount(data) : "Its file could not be fetched and checked just now, so the payouts it lists are not shown.") }));
  } else if (!Sh.hasPending(dist)) {
    lines.push(el("div", { class: "shState", text: "No payout yet." }));
  }
  const vetoed = Sh.vetoedSince(dist);
  if (vetoed.length) {
    lines.push(el("div", { class: "shState vetoed", id: "shVetoed", text: "Vetoed: epoch " + vetoed.join(", ") + "." }));
  }
  if (!Sh.hasPending(dist) && force.root.epoch > 0 && dist.frozen) {
    lines.push(el("div", { class: "shState", text: "Next payout: none while publishing is frozen." }));
  }
  wrap.append(...lines);
  return wrap;
}

/// "x of y holders paid" from the leaves and their `paid` - read for at most
/// LEAVES_READ_MAX leaves - or the amounts when there are more.
function paidCount(data) {
  const pc = data.paidCount;
  const r = data.force.root;
  const amounts = "Paid " + two(data.dist.totalPaid0, data.dist.totalPaid1, data.sym1) + " of " +
    two(r.cumHolders0, r.cumHolders1, data.sym1) + " allocated.";
  if (!pc) return amounts;
  if (pc.unpaid === 0) return "Every holder in it is paid (" + pc.total + ").";
  return "Paying: " + (pc.total - pc.unpaid) + " of " + pc.total + " holders paid in full. " + amounts;
}

// ---------------------------------------------------------------- push
function drawPush(data) {
  const pc = data.paidCount;
  const b = el("button", { type: "button", class: "ghost shPush", id: "shPush", text: "Push pending payouts" });
  b.disabled = S().busy || !S().account || !data.fileOk || !pc || pc.unpaid === 0;
  b.addEventListener("click", () => App.guard(() => pushPending()));
  const why = data.force.root.epoch === 0 || !data.fileOk || !pc || pc.unpaid === 0 ? ""
    : pc.unpaid + " holder" + (pc.unpaid === 1 ? "" : "s") + " owed.";
  return el("div", { class: "shRow" }, [b, el("span", { class: "shNote", id: "shPushNote", text: why })]);
}

/// Reads `paid` for every leaf of the file in force (at most LEAVES_READ_MAX).
/// A file past 512 accounts is read one holder's chunk at a time (`parts`):
/// the page has not every leaf, so it reads none.
async function readPaid(r, dist, file) {
  const leaves = file.merkle.leaves;
  if (file.parts || leaves.length > C.LEAVES_READ_MAX) return null;
  const calls = [];
  for (const l of leaves) calls.push({ to: dist.d, data: SEL.paid0 + pad(l[1]) }, { to: dist.d, data: SEL.paid1 + pad(l[1]) });
  const got = await r.calls(calls);
  const out = [];
  leaves.forEach((l, i) => {
    const p0 = got[2 * i] ? wordToBig(words(got[2 * i])[0]) : null;
    const p1 = got[2 * i + 1] ? wordToBig(words(got[2 * i + 1])[0]) : null;
    const c0 = BigInt(l[2]), c1 = BigInt(l[3]);
    out.push({ account: l[1], cum0: c0, cum1: c1, owed0: p0 === null ? null : c0 > p0 ? c0 - p0 : 0n,
      owed1: p1 === null ? null : c1 > p1 ? c1 - p1 : 0n });
  });
  return out;
}

async function pushPending() {
  const pin = await App.beginAction("trade");
  return App.withSendLock(pin, async () => {
    const r = Sh.reader(pin.rpc);
    const head = await r.head();
    const d = await r.call(pin.graduator, SEL.holderDistributorOf + pad(pin.token)).then((x) => wordToAddress(words(x)[0]));
    if (isZero(d)) throw new Error("This launch's holder sharing is off. Nothing was sent.");
    const dist = await Sh.readDistributor(r, d);
    const force = Sh.inForce(dist, head.ts);
    if (force.root.epoch === 0) throw new Error("No payout is in force yet, so there is nothing to push. Nothing was sent.");
    const got = await Sh.loadFile({ chainId: parseInt(pin.chainId, 16), d, epoch: force.root.epoch,
      contentHash: force.root.contentHash, uri: async () => ((await Sh.publishedEvent(r, d, force.root, head.number)) || {}).uri || "" });
    if (!got.ok) throw new Error("The payout's file could not be fetched with the hash the distributor holds, so no proof can be built. Nothing was sent.");
    const s = await Sh.share();
    const file = await Sh.parsedFile(got.bytes);
    const rows = await readPaid(r, dist, file);
    if (!rows) throw new Error("This payout has more holders than this page reads. Nothing was sent.");
    // THE LARGEST SHARES FIRST, at most PUSH_BATCH, and never an address the
    // distributor would only skip.
    const exclusions = new Set(file.rules.exclusions.map((x) => x.address));
    const owed = rows.filter((x) => (x.owed0 > 0n || x.owed1 > 0n) && !exclusions.has(x.account))
      .sort((a, b) => (b.owed0 > a.owed0 ? 1 : b.owed0 < a.owed0 ? -1 : 0)).slice(0, C.PUSH_BATCH);
    if (!owed.length) throw new Error("Every holder in this payout is paid already. Nothing was sent.");
    const tree = s.treeOf(file);
    const mp = s.multiProofFor(tree, owed.map((x) => x.account));
    const data = SEL.push + encode(
      [T.array(T.tuple([T.address, T.uint(256), T.uint(256)])), T.array(T.bytesN(32)), T.array(T.bool)],
      [mp.leaves.map((l) => [l.account, l.cum0, l.cum1]), mp.proof, mp.flags]).slice(2);
    await simulate(pin, { to: d, data }, "The push");
    await App.send(pin, { to: d, data }, "push " + owed.length + " pending payout" + (owed.length === 1 ? "" : "s"), "sharing");
    App.show("ok", "Pushed: " + owed.length + " holder" + (owed.length === 1 ? "" : "s") + " paid their share of epoch " + force.root.epoch + ".");
  });
}

/// A call simulated with this account before it is sent; a revert refuses it
/// in the contract's own words.
async function simulate(pin, tx, what) {
  try {
    await pin.read("eth_call", [{ from: pin.from, to: tx.to, data: tx.data }, "latest"]);
  } catch (e) {
    if (!App.isRevert(e)) {
      throw new Error("Whether " + what.toLowerCase() + " would go through could not be checked: " +
        ((e && e.message) || String(e)) + ". Nothing was sent - try again.");
    }
    throw Object.assign(new Error(what + " would revert: " + App.revertSentence(e, REFUSALS) + " Nothing was sent."), { revert: e });
  }
}

// ---------------------------------------------------------------- the holder
function drawHolder(data) {
  const wrap = el("div", { class: "shHolder", id: "tvHolder" });
  const me = data.me;
  if (!S().account) {
    wrap.append(el("p", { class: "shNote", text: "Connect a wallet to see your share." }));
    return wrap;
  }
  if (!me) return wrap;
  wrap.append(el("h4", { text: "Your share" }));
  if (me.excluded) {
    wrap.append(el("p", { class: "shNote", id: "shExcluded", text: "This address is one this distributor never pays: a pool, the curve, the lock or another platform contract." }));
    return wrap;
  }
  const sym1 = data.sym1;
  const box = (id, value, label) => el("div", { class: "shBox" }, [el("b", { id, text: value }), el("span", { text: label })]);
  wrap.append(el("div", { class: "shGrid" }, [
    box("shEarned", two(me.leaf.cum0, me.leaf.cum1, sym1), "earned"),
    box("shMePaid", two(me.paid0, me.paid1, sym1), "paid"),
    box("shClaimable", two(me.claim0, me.claim1, sym1), "claimable"),
    box("shEstimate", estimateText(data), "next (estimate)"),
  ]));
  // THE PAYOUT WAITING ITS HOUR, as it would leave this holder.
  if (me.pendingLeaf) {
    const p = data.dist.pending;
    const more0 = me.pendingLeaf.cum0 - me.leaf.cum0, more1 = me.pendingLeaf.cum1 - me.leaf.cum1;
    const adds = more0 > 0n || more1 > 0n ? "adds " + two(more0, more1, sym1) + " to your share" : "adds nothing to your share";
    // FROZEN, its hour no longer counts: it waits for the unfreeze, as the line above says.
    wrap.append(el("p", { class: "shNote", id: "shPendingMine", text: data.dist.frozen
      ? "Epoch " + p.epoch + " " + adds + " once publishing is unfrozen, unless it is vetoed."
      : "Epoch " + p.epoch + ", published and waiting its hour, " + adds + ", unless it is vetoed." }));
  }
  // BELOW THE PUSH THRESHOLD IT BUILDS UP, and the threshold is said.
  const owed = me.claim0 > 0n || me.claim1 > 0n;
  if (owed) wrap.append(el("p", { class: "shNote", id: "shAccumulating", text: "Sent to you automatically from about $" +
    C.PUSH_FLOOR_USD.toFixed(2) + ", or claim it now." }));
  const claim = el("button", { type: "button", class: "shClaim", id: "shClaim", text: "Claim" });
  claim.disabled = S().busy || !owed || !data.fileOk;
  claim.addEventListener("click", () => App.guard(() => claimShare(null)));
  const row = el("div", { class: "shRow" }, [claim]);
  // CLAIM TO ANOTHER ADDRESS OF YOURS: offered when this one cannot take it.
  if (owed && (me.blocked || me.refused || V.cannotReceive === me.who.toLowerCase())) {
    // WHAT WAS TYPED OUTLIVES A REDRAW: the card is drawn again after every
    // refresh, and an address being typed was wiped by it.
    const to = el("input", { id: "shClaimTo", placeholder: "0x… another address of yours", spellcheck: false, autocomplete: "off",
      value: V.claimTo || "" });
    to.addEventListener("input", () => { V.claimTo = to.value; });
    const go = el("button", { type: "button", class: "ghost", id: "shClaimToAct", text: "Claim to another address of mine" });
    go.disabled = S().busy || !data.fileOk;
    go.addEventListener("click", () => App.guard(() => claimShare(($("shClaimTo").value || "").trim())));
    row.append(to, go);
    wrap.append(el("p", { class: "shNote warn", id: "shBlockedNote", text: (me.listed
      ? "This coin's issuer has blacklisted this address."
      : me.blocked
        ? "The issuer of " + quoteSym() + " does not let this address receive it (policy " + me.policy + ")."
        : "A claim to this address was refused.") + " Claim to another address of yours." }));
  }
  wrap.append(row);
  wrap.append(drawHistoryShell(data));
  return wrap;
}

function estimateText(data) {
  const me = data.me;
  if (!me || me.eligible <= 0n || me.balance === 0n) return "0 " + quoteSym();
  const r = data.force.root;
  const pot0 = (data.dist.received0 || 0n) - r.cumHolders0 - r.cumKeeper0 + data.toCollect.q0;
  const pot1 = (data.dist.received1 || 0n) - r.cumHolders1 + data.toCollect.t1;
  // AT MOST 2% OF IT COVERS GAS: the estimate takes the whole 2% off.
  const e0 = pot0 > 0n ? (pot0 * 98n / 100n) * me.balance / me.eligible : 0n;
  const e1 = pot1 > 0n ? pot1 * me.balance / me.eligible : 0n;
  return "about " + two(e0, e1, data.sym1);
}

async function claimShare(to) {
  const pin = await App.beginAction("trade");
  return App.withSendLock(pin, async () => {
    if (to !== null) {
      if (!isAddr(to)) throw new Error("Enter the address to be paid at. Nothing was sent.");
      if (same(to, pin.from)) throw new Error("That is this address; press Claim instead. Nothing was sent.");
    }
    const r = Sh.reader(pin.rpc);
    const head = await r.head();
    const d = await r.call(pin.graduator, SEL.holderDistributorOf + pad(pin.token)).then((x) => wordToAddress(words(x)[0]));
    if (isZero(d)) throw new Error("This launch's holder sharing is off. Nothing was sent.");
    const dist = await Sh.readDistributor(r, d);
    const force = Sh.inForce(dist, head.ts);
    if (force.root.epoch === 0) throw new Error("No payout is in force yet. Nothing was sent.");
    const got = await Sh.loadFile({ chainId: parseInt(pin.chainId, 16), d, epoch: force.root.epoch,
      contentHash: force.root.contentHash, uri: async () => ((await Sh.publishedEvent(r, d, force.root, head.number)) || {}).uri || "" });
    if (!got.ok) throw new Error("The payout's file could not be fetched with the hash the distributor holds, so your proof cannot be built. Nothing was sent.");
    const s = await Sh.share();
    const file = await Sh.parsedFile(got.bytes, { account: pin.from });
    const p = s.proofOf(s.treeOf(file), pin.from);
    if (!p) throw new Error("This address has no share in epoch " + force.root.epoch + ". Nothing was sent.");
    if (to !== null) {
      // THE ADDRESS NAMED MUST BE ABLE TO TAKE IT: one the distributor pays at
      // all, and one the issuer lets receive.
      const ex = await r.call(d, SEL.isExcluded + pad(to));
      if (wordToBig(words(ex)[0]) === 1n) throw new Error(to + " is an address the distributor refuses to pay (a pool, the curve, the lock or a platform contract). Nothing was sent.");
      const recv = await App.policyAllows(dist.quoteToken, to, "receive", (t, x) => r.call(t, x));
      if (recv.known && !recv.allowed) throw new Error("The issuer does not let " + to + " receive " + quoteSym() + " either. Nothing was sent.");
      if (await App.coinBlacklists(dist.quoteToken, to, (t, x) => r.call(t, x))) throw new Error("The issuer has blacklisted " + to + " too. Nothing was sent.");
    }
    const data = SEL.claim + encode([T.uint(256), T.uint(256), T.array(T.bytesN(32)), T.address],
      [p.cum0, p.cum1, p.proof, to === null ? ZERO : to]).slice(2);
    try {
      await simulate(pin, { to: d, data }, "The claim");
    } catch (e) {
      // A REFUSED TRANSFER TO THIS ADDRESS: the way out is another address of
      // the holder's, and the panel offers it from now on.
      if (to === null && e.revert && revertSelector(e.revert) === TRANSFER_REFUSED) V.cannotReceive = pin.from.toLowerCase();
      throw e;
    }
    const before0 = await r.call(d, SEL.paid0 + pad(pin.from)).then((x) => wordToBig(words(x)[0]));
    await App.send(pin, { to: d, data }, to === null ? "claim your holder share" : "claim your holder share to " + to, "sharing");
    const after0 = await r.call(d, SEL.paid0 + pad(pin.from)).then((x) => wordToBig(words(x)[0]));
    App.show("ok", "Claimed " + App.fmt(after0 - before0, quoteDec(), 6) + " " + quoteSym() +
      " from epoch " + force.root.epoch + (to === null ? "" : ", paid to " + to) + "." +
      (isWethPair() ? " Paid as ETH, or as WETH to an address that will not take ether." : ""));
  });
}

// ---------------------------------------------------------------- history
function drawHistoryShell(data) {
  const d = el("details", { class: "shHistory", id: "shHistory" }, [el("summary", { text: "Your share, payout by payout" })]);
  const body = el("div", { id: "shHistoryBody" });
  d.append(body);
  d.addEventListener("toggle", () => { if (d.open) drawHistory(data, body); });
  if (V.historyOpen) { d.open = true; drawHistory(data, body); }
  d.addEventListener("toggle", () => { V.historyOpen = d.open; });
  return d;
}
/// WALKED BACK FILE BY FILE from the one in force: each names the one before
/// it with its contentHash, so each is checked against the hash the later one
/// carries - the chain's hash for the first.
async function drawHistory(data, body) {
  const me = data.me;
  if (!data.fileOk || !me) { body.replaceChildren(el("p", { class: "shNote", text: "No checked payout file yet." })); return; }
  const key = data.force.root.contentHash + "|" + me.who;
  if (V.history && V.history.for === key) { body.replaceChildren(V.history.table); return; }
  body.replaceChildren(el("p", { class: "shNote", text: "Reading the payout files…" }));
  const rows = [];
  let file = data.file;
  let ok = true;
  for (let i = 0; i < C.HISTORY_MAX && file; i++) {
    const row = Sh.rowOf(file, me.who);
    rows.push({ epoch: file.epoch, from: file.window.fromBlock, to: file.window.toBlock, s0: row ? row.s0 : 0n, s1: row ? row.s1 : 0n,
      cum0: row ? row.cum0 : 0n, cum1: row ? row.cum1 : 0n, vetoed: file.supersedes.map(String) });
    if (!file.prev) break;
    const got = await Sh.loadFile({ chainId: data.chainId, d: data.dist.d, epoch: Number(file.prev.epoch),
      contentHash: file.prev.contentHash, uri: file.prev.uri });
    if (!got.ok) { ok = false; break; }
    try { file = await Sh.parsedFile(got.bytes, { account: me.who }); } catch { ok = false; break; }
  }
  const table = el("table", { class: "shTable", id: "shHistoryTable" }, [
    el("thead", {}, [el("tr", {}, ["Payout", "Blocks", "Your share", "Your total"].map((h) => el("th", { text: h })))]),
    el("tbody", {}, rows.map((x) => el("tr", { "data-epoch": String(x.epoch) }, [
      el("td", { text: "Epoch " + x.epoch + (x.vetoed.length ? " (after veto of " + x.vetoed.join(", ") + ")" : "") }),
      el("td", { text: x.from + "–" + x.to }),
      el("td", { text: two(x.s0, x.s1, data.sym1) }),
      el("td", { text: two(x.cum0, x.cum1, data.sym1) }),
    ]))),
  ]);
  const wrap = el("div", {}, [table, ok ? null : el("p", { class: "shNote", text: "An earlier file could not be fetched; the walk stops here." })]);
  V.history = { for: key, table: wrap };
  body.replaceChildren(wrap);
}

// ---------------------------------------------------------------- verify
function drawVerifyShell(data) {
  const d = el("details", { class: "shVerify", id: "tvVerify" }, [el("summary", { text: "Check the payout files yourself" })]);
  const body = el("div", { id: "tvVerifyBody" });
  const pick = el("select", { id: "shVerifyEpoch" });
  const roots = [];
  if (Sh.hasPending(data.dist) && !data.force.ripe) roots.push(["pending", data.dist.pending]);
  if (data.force.root.epoch > 0) roots.push(["force", data.force.root]);
  for (const [k, r] of roots) {
    pick.append(el("option", { value: k, text: "Epoch " + r.epoch + (k === "pending" ? " (published, in its veto hour)" : " (in force)") }));
  }
  // OPEN AND ON THE EPOCH CHOSEN, AS IT WAS: the card is drawn again after
  // every refresh, and the panel used to fold up under the reader.
  d.open = !!V.verifyOpen;
  d.addEventListener("toggle", () => { V.verifyOpen = d.open; });
  if (V.verifyPick && roots.some(([k]) => k === V.verifyPick)) pick.value = V.verifyPick;
  pick.addEventListener("change", () => { V.verifyPick = pick.value; });
  const go = el("button", { type: "button", class: "ghost", id: "shVerifyAct", text: "Check" });
  go.disabled = !roots.length;
  go.addEventListener("click", () => runVerify(data, roots, pick.value, body));
  d.append(el("p", { class: "shNote", text: C.VERIFY_WHERE }),
    el("code", { class: "shCli", id: "shCli", text: Sh.verifyCommand({ d: data.dist.d, epoch: roots.length ? roots[0][1].epoch : 1,
      chainId: data.chainId, origin: location.origin }) }),
    roots.length ? el("div", { class: "shRow" }, [pick, go]) : el("p", { class: "shNote", text: "Nothing has been published yet." }),
    body);
  if (V.verify && roots.some(([k, r]) => r.epoch === V.verify.epoch)) body.append(V.verify.node);
  return d;
}

async function runVerify(data, roots, which, body) {
  const found = roots.find(([k]) => k === which);
  if (!found) return;
  const root = found[1];
  body.replaceChildren(el("p", { class: "shNote", text: "Checking epoch " + root.epoch + "…" }));
  let res;
  try {
    res = await Sh.checkEpoch({ chainId: data.chainId }, data.dist, root,
      async () => ((await Sh.publishedEvent(data.r, data.dist.d, root, data.head.number)) || {}).uri || "", S().account);
  } catch (e) {
    body.replaceChildren(el("p", { class: "shNote warn", text: "The check could not run: " + ((e && e.message) || e) }));
    return;
  }
  const ok = res.steps.every((s) => s.ok) && (res.problems || []).length === 0;
  const node = el("div", { class: "shChecks", id: "shChecks", "data-ok": String(ok) }, [
    el("p", { class: ok ? "shVerdict ok" : "shVerdict bad", id: "shVerdict", text: ok
      ? "Epoch " + root.epoch + "'s file checks out against the chain."
      : "Epoch " + root.epoch + "'s file does NOT check out: the copy fetched is not what the chain holds, or its figures do not add up." }),
    el("ul", { class: "shSteps" }, res.steps.map((s) => el("li", { class: s.info ? "info" : s.ok ? "ok" : "bad", "data-step": s.key, text: s.text }))),
    res.problems && res.problems.length
      ? el("details", { class: "shProblems", open: !ok }, [el("summary", { text: res.problems.length + " problem" + (res.problems.length === 1 ? "" : "s") + " found" }),
        el("ul", {}, res.problems.map((p) => el("li", { text: p })))])
      : null,
    res.mine ? el("details", { class: "shProof" }, [el("summary", { text: "Your leaf and proof" }),
      el("code", { text: "leaf " + res.mine.leaf + "\ncum0 " + res.mine.cum0 + "\ncum1 " + res.mine.cum1 + "\nproof\n" + res.mine.proof.join("\n") })]) : null,
  ]);
  V.verify = { epoch: root.epoch, node };
  // INTO THE PANEL ON SCREEN: a redraw while the check ran replaced the one it started in.
  ($("tvVerifyBody") || body).replaceChildren(node);
}

// ---------------------------------------------------------------- the creator
function drawCreator(data) {
  const slot = $("tvCreatorShare");
  if (!slot) return;
  slot.replaceChildren();
  if (!data) return;
  const v = data.view;
  const you = !!data.account && same(data.account, v.beneficiary);
  if (!data.on) {
    // THE SWITCH, FOR THE CREATOR WALLET ONLY, and only where the catalog
    // approves a version to switch to.
    if (!you) return;
    const offer = data.ctx.sharing;
    const available = !!(offer && offer.known && offer.approved && !isZero(offer.factory));
    const b = el("button", { type: "button", class: "ghost", id: "tvEnableShare", text: "Enable holder sharing" });
    b.disabled = S().busy || !available;
    b.addEventListener("click", () => openEnable(data));
    slot.append(el("div", { class: "shCreator" }, [
      available ? null : el("p", { class: "shNote", text: "Holder sharing is unavailable: no distributor version is approved." }), b]
      .filter(Boolean)));
    return;
  }
  if (!you) return;
  // AFTER THE SWITCH: what the lock holds for the creator from before it, and
  // that the principal stays where it is.
  const wrap = el("div", { class: "shCreator", id: "tvCreatorAfter" });
  wrap.append(el("p", { class: "shNote", text: "Holder sharing on since block " + data.since + "." }));
  if (data.creator && (data.creator.held0 > 0n || data.creator.held1 > 0n)) {
    const rel = el("button", { type: "button", class: "ghost", id: "tvReleaseHeld", text: "Release what the lock holds for you" });
    rel.disabled = S().busy;
    rel.addEventListener("click", () => App.guard(() => releaseHeld()));
    wrap.append(el("div", { class: "shRow" }, [el("span", { class: "shNote", id: "tvHeldNote", text: "The lock holds " +
      lockAmounts(data, data.creator.held0, data.creator.held1) + " for you." }), rel]));
  }
  if (data.position) wrap.append(drawLocked(data));
  slot.append(wrap);
}

function lockAmounts(data, a0, a1) {
  const k = data.position && data.position.key;
  const quoteIs0 = k ? same(k.currency0, data.dist.quoteToken) : true;
  const q = quoteIs0 ? a0 : a1, t = quoteIs0 ? a1 : a0;
  return two(q, t, data.sym1);
}

/// THE LOCKED POSITION, as it stands: locked forever, with nothing to press.
/// The lock has no withdrawal, so this page offers none.
function drawLocked(data) {
  const p = data.position;
  const box = el("div", { class: "shWithdraw", id: "tvLocked" });
  box.append(el("p", { class: "shNote", id: "tvLockedForever", text: p.holds
    ? "LP locked forever." : "The lock does not hold the position." }));
  return box;
}

async function releaseHeld() {
  const pin = await App.beginAction("trade");
  return App.withSendLock(pin, async () => {
    const lock = await pin.call(pin.graduator, SEL.lockOf + pad(pin.token)).then((x) => wordToAddress(words(x)[0]));
    if (isZero(lock)) throw new Error("This launch has no lock. Nothing was sent.");
    const data = SEL.release + pad(pin.view.beneficiary);
    await simulate(pin, { to: lock, data }, "The release");
    await App.send(pin, { to: lock, data }, "release what the lock holds for the creator", "sharing");
    App.show("ok", "Released: the lock paid the creator wallet what it held for it.");
  });
}

// ---------------------------------------------------------------- the switch
async function openEnable(data) {
  const offer = data.ctx.sharing;
  const v = data.view;
  const graduated = v.status === 3;
  // WHAT IS SETTLED TO THE CREATOR FIRST: the curve's pending tax before
  // graduation, the locked position's accrued LP fees after it.
  let pendingLine = "";
  try {
    if (!graduated) {
      const [tax, fee, pbps] = await data.r.calls([{ to: v.curve, data: SEL.creatorTaxBalance }, { to: v.curve, data: SEL.quoteFeeBalance },
        { to: v.curve, data: SEL.protocolFeeShareBps }]);
      const t = wordToBig(words(tax)[0]), f = wordToBig(words(fee)[0]), b = wordToBig(words(pbps)[0]);
      const yours = t + (f - (f * b) / 10000n);
      pendingLine = "The curve holds " + fmt(yours, quoteDec(), 6) + " " + quoteSym() + " of creator tax not yet swept: it is paid " +
        "to you first, in the same transaction, as far as the issuer allows.";
    } else {
      const lock = await data.r.call(data.graduator, SEL.lockOf + pad(data.token)).then((x) => wordToAddress(words(x)[0]));
      const p = await Sh.readPosition(data.r, lock);
      data.position = p;
      pendingLine = p.fees
        ? "The locked position has accrued about " + lockAmounts({ ...data, dist: { quoteToken: v.quoteToken } }, p.fees.amount0, p.fees.amount1) +
          " of LP fees: they are collected and paid to you first, in the same transaction (held in the lock for you if they cannot be delivered)."
        : "Any LP fees the locked position has accrued are collected and paid to you first, in the same transaction.";
    }
  } catch { pendingLine = "What you earned so far is paid to you first, in the same transaction, as far as the issuer allows."; }
  const dlg = el("dialog", { class: "shDialog", id: "shEnableDialog" });
  const input = el("input", { id: "shEnableConfirm", placeholder: "SHARE", autocomplete: "off", spellcheck: false });
  const go = el("button", { type: "button", id: "shEnableAct", text: "Enable holder sharing" });
  go.disabled = true;
  input.addEventListener("input", () => { go.disabled = input.value.trim() !== "SHARE"; });
  const cancel = el("button", { type: "button", class: "ghost", id: "shEnableCancel", text: "Cancel" });
  cancel.addEventListener("click", () => { dlg.close(); dlg.remove(); });
  go.addEventListener("click", () => {
    if (input.value.trim() !== "SHARE") return;
    dlg.close(); dlg.remove();
    App.guard(() => enableSharing(offer.factory));
  });
  dlg.append(
    el("h3", { text: "Share this launch's fees with its holders" }),
    el("p", { text: "This is for good: nobody can turn it off, CURB included." }),
    el("ul", { class: "shList" }, [
      el("li", { text: "Your creator share becomes 0%, permanently." }),
      el("li", { text: graduated
        ? "From now on, the pool's creator fees and the locked position's LP fees go to the holders."
        : "From now on, the curve's creator tax goes to the holders, and after graduation the pool's creator fees and the locked position's LP fees do too." }),
      el("li", { id: "shEnablePending", text: pendingLine }),
      el("li", { text: "What you can already claim stays yours. The LP principal stays locked forever, as it is now." }),
      el("li", { text: "Shares are time-weighted and paid about hourly. At most 2% of each payout covers gas. Every payout is public and can be stopped by the CURB multisig or CURB's guardian for 1 hour." }),
      el("li", { id: "shEnablePublisher", text: "Payouts need CURB's keeper to keep publishing them; unpaid shares wait in the distributor." }),
      el("li", { text: "Unclaimed shares never expire." }),
    ]),
    el("p", { class: "shNote", text: "Paid through distributor version " + (offer.version === null ? "?" : offer.version) + " at " + offer.factory + ", the one the CURB catalog recommends." }),
    el("label", { for: "shEnableConfirm", text: "Type SHARE to confirm" }), input,
    el("div", { class: "shRow" }, [cancel, go]),
  );
  document.body.append(dlg);
  dlg.showModal();
  input.focus();
}

async function enableSharing(shown) {
  const pin = await App.beginAction("trade");
  return App.withSendLock(pin, async () => {
    if (!same(pin.view.beneficiary, pin.from)) {
      throw new Error("Only this launch's creator wallet (" + pin.view.beneficiary + ") can switch its holder sharing on. Nothing was sent.");
    }
    const r = Sh.reader(pin.rpc);
    const already = await r.call(pin.graduator, SEL.holderDistributorOf + pad(pin.token)).then((x) => wordToAddress(words(x)[0]));
    if (!isZero(already)) throw new Error("This launch's holder sharing is already on. Nothing was sent.");
    // THE VERSION SHOWN, READ AGAIN: the catalog's owner can retire a version or
    // recommend another at any moment, and the switch is for good.
    const catW = await r.call(pin.graduator, SEL.sharingCatalog);
    const now = await App.sharingOffer({ catalog: wordToAddress(words(catW)[0]) }, (t, x) => r.call(t, x));
    if (!now.known) throw new Error("The holder sharing catalog could not be read just now. Nothing was sent - try again.");
    if (!now.approved || !same(now.factory, shown)) {
      throw new Error("The distributor version changed while this was open: the catalog now " +
        (now.approved ? "recommends " + now.factory : "approves none") + ". Nothing was sent - press Refresh and look again.");
    }
    const data = SEL.enableHolderSharing + pad(pin.token) + pad(shown);
    await simulate(pin, { to: pin.graduator, data }, "Switching holder sharing on");
    await App.send(pin, { to: pin.graduator, data }, "switch this launch's holder sharing on, for good", "sharing");
    App.show("ok", "<strong>Holder sharing is on</strong>");
  });
}

// ---------------------------------------------------------------- the creator's figures
/// What the lock holds for the creator from before the switch, and the
/// position's state, for the creator wallet only.
async function readCreator(data) {
  if (!data || !data.on || !data.account || !same(data.account, data.view.beneficiary)) return;
  if (isZero(data.lock)) return;
  const [h0, h1] = await data.r.calls([{ to: data.lock, data: SEL.held + pad(data.view.beneficiary) + padNum(0) },
    { to: data.lock, data: SEL.held + pad(data.view.beneficiary) + padNum(1) }]);
  const b = (x) => { const w = words(x || "0x"); return w.length ? wordToBig(w[0]) : 0n; };
  data.creator = { held0: b(h0), held1: b(h1) };
  data.position = await Sh.readPosition(data.r, data.lock).catch(() => null);
}

/// Announced vetoer removals and catalog proposals, from the logs of the last
/// nine days (ROLE_DELAY + ROLE_WINDOW): anything older has expired. Once per
/// factory per page.
async function readRemovals(data) {
  const f = data.dist.factory;
  if (V.removals.for === f || V.removals.running) return;
  V.removals.running = true;
  try {
    const r = data.r;
    const span = Math.ceil((C.ROLE_DELAY_S + C.ROLE_WINDOW_S) / 2) + 1000;
    const from = Math.max(await Sh.forkFloor(r), data.head.number - span, 0);
    const catW = await r.call(data.graduator, SEL.sharingCatalog).catch(() => "0x");
    const catalog = words(catW).length ? wordToAddress(words(catW)[0]) : null;
    const addrs = catalog ? [f, catalog] : [f];
    const got = await Sh.getLogs(r, { address: addrs, topics: [[Sh.TOPIC.vetoerRemovalAnnounced, Sh.TOPIC.factoryProposed]] },
      from, data.head.number, 120);
    const now = data.head.ts;
    const list = [], cat = [];
    for (const l of got.logs) {
      const who = "0x" + l.topics[1].slice(26);
      const at = Number(BigInt(l.data.slice(0, 66)));
      if (l.topics[0] === Sh.TOPIC.vetoerRemovalAnnounced && same(l.address, f)) {
        const cur = Number(wordToBig(words(await r.call(f, SEL.vetoerRemovalAt + pad(who)))[0]));
        if (cur === at && now <= at + C.ROLE_WINDOW_S) list.push({ account: who, at });
      } else if (catalog && same(l.address, catalog)) {
        const [adm, ret] = await r.calls([{ to: catalog, data: SEL.admittedAt + pad(who) }, { to: catalog, data: SEL.retired + pad(who) }]);
        if (Number(wordToBig(words(adm)[0])) === at && at > now && wordToBig(words(ret)[0]) === 0n) {
          cat.push("A new distributor version, " + who + ", is proposed to the CURB catalog and can be approved from " +
            new Date(at * 1000).toLocaleString() + ". It changes nothing for a launch that already shares.");
        }
      }
    }
    if (!got.complete) cat.push("Announced changes older than block " + got.reached + " were not read here; the sharing page lists them all.");
    V.removals = { for: f, list, catalog: cat, at: Date.now() };
  } catch {
    V.removals = { for: f, list: [], catalog: ["Announced vetoer changes could not be read just now; the sharing page lists them."], at: Date.now() };
  } finally {
    V.removals.running = false;
  }
}

// ---------------------------------------------------------------- the loop
async function refresh() {
  const seq = ++V.seq;
  let data;
  try {
    data = await load();
    if (data && data.on && data.fileOk) {
      // PAID MOVES ONLY WITH THE TOTALS, so the leaves are read again only
      // when a payout was made since.
      const key = data.force.root.contentHash + "|" + data.dist.totalPaid0 + "|" + data.dist.totalPaid1;
      if (!V.paid || V.paid.key !== key) {
        const rows = await readPaid(data.r, data.dist, data.file).catch(() => null);
        V.paid = { key: rows ? key : "", rows };
      }
      const rows = V.paid.rows;
      data.paidCount = rows ? { total: rows.length, unpaid: rows.filter((x) => x.owed0 > 0n || x.owed1 > 0n).length } : null;
      if (data.me && (data.me.claim0 > 0n || data.me.claim1 > 0n)) await canReceive(data);
    }
    if (data) await readCreator(data);
  } catch (e) {
    if (seq !== V.seq) return;
    const card = $("tvShare");
    if (card && !card.hidden) {
      card.append(el("p", { class: "shNote warn", text: "The holder sharing figures could not be read just now (" + ((e && e.message) || e) + ")." }));
    }
    return;
  }
  if (seq !== V.seq) return;
  V.data = data;
  draw(data);
  // THE BOUNDED SCAN FOR ANNOUNCED REMOVALS, after the card is up; it redraws
  // the warnings when it lands.
  if (data && data.on && V.removals.for !== data.dist.factory) {
    readRemovals(data).then(() => { if (V.data === data) draw(data); });
  }
  document.dispatchEvent(new CustomEvent("curb:sharingDrawn", { detail: { on: !!(data && data.on) } }));
}

/// WHETHER A CLAIM TO THE HOLDER'S OWN ADDRESS WOULD LAND, asked by
/// simulating it: a transfer the issuer refuses, or one the address will not
/// take, reverts TransferRefused - and then the panel offers another address.
async function canReceive(data) {
  try {
    const s = await Sh.share();
    const p = s.proofOf(s.treeOf(data.file), data.me.who);
    if (!p) return;
    const call = SEL.claim + encode([T.uint(256), T.uint(256), T.array(T.bytesN(32)), T.address], [p.cum0, p.cum1, p.proof, ZERO]).slice(2);
    await data.r.rpc("eth_call", [{ from: data.me.who, to: data.dist.d, data: call }, "latest"]);
    data.me.refused = false;
  } catch (e) {
    data.me.refused = revertSelector(e) === TRANSFER_REFUSED;
  }
}

/// The veto countdown, by the chain's clock.
function tick() {
  const c = $("shCountdown");
  if (!c) return;
  const now = chainNow();
  if (now === null) return;
  const left = Number(c.dataset.at) - now;
  c.textContent = Sh.untilText(left);
  if (left <= 0 && !tick.reloaded) { tick.reloaded = true; refresh(); }
}

let pending = null;
function schedule() {
  clearTimeout(pending);
  pending = setTimeout(refresh, 50);
}

function start() {
  document.addEventListener("curb:drawn", schedule);
  document.addEventListener("curb:refreshed", schedule);
  window.addEventListener("hashchange", schedule);
  if (window.CurbBar) window.CurbBar.onAccount(() => schedule());
  setInterval(() => { tick(); }, 1000);
  setInterval(() => { if (!document.hidden && !S().busy) schedule(); }, 30000);
  schedule();
}

window.CurbSharingToken = {
  refresh, get data() { return V.data; },
  /// So a test can ask what the page decided about the switch.
  get state() { return { on: !!(V.data && V.data.on), d: V.data && V.data.d, fileOk: !!(V.data && V.data.fileOk) }; },
};

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
else start();
})();
