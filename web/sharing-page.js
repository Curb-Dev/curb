// /sharing (sharing.html), "Holder fees": WHAT THE CONNECTED WALLET EARNED from
// the holder sharing of the tokens it holds, token by token, and the total
// (the owner's call: a list, not an explanation - the how is in docs.md).
//
// All of it is read from the chain through the lens the bar's links carry: the
// launches that share (word 15 of a lens record names the distributor), each
// distributor's payout in force, its file - used only once its sha256 is the
// chain's (sharing.js loadFile) - for what this wallet earned, and paid0/paid1
// for what it was paid. Claimable is earned less paid, and Claim takes it here
// (the owner's call: the token's page no longer carries a holder card).
(function () {
"use strict";
const Sh = window.CurbSharing;
if (!Sh || !window.CurbBar) return;
const $ = (id) => document.getElementById(id);
const { el, fmt, isZero, short, SEL, pad } = Sh;
const { words, wordToAddress, wordToBig, encode, T } = window.CurbAbi;
const ZERO = "0x0000000000000000000000000000000000000000";
const TOKEN_URI = "0x3c130d90"; // tokenURI()

const say = (t) => { const m = $("msg"); m.textContent = t; m.hidden = !t; };
const b = (x) => { const w = words(x || "0x"); return w.length ? wordToBig(w[0]) : 0n; };
const a = (x) => { const w = words(x || "0x"); return w.length ? wordToAddress(w[0]) : ZERO; };
const str = (x) => { try { return window.CurbMeta.decodeString(x || "0x"); } catch { return ""; } };

/// The launchPage answer, decoded at the stride its records have (browse.js
/// viewStride): only what this page needs - the token, the status, word 15.
function decodePage(raw) {
  const hex = String(raw || "0x").replace(/^0x/, "");
  if (hex.length < 128) return [];
  const at = (i) => hex.slice(i * 64, (i + 1) * 64);
  const tokensAt = Number(BigInt("0x" + at(0))) / 32;
  const viewsAt = Number(BigInt("0x" + at(1))) / 32;
  const n = Number(BigInt("0x" + at(tokensAt)));
  if (!n) return [];
  const rest = hex.length / 64 - viewsAt - 1;
  if (rest % n !== 0) throw new Error("the lens returned a page whose records do not divide it");
  const stride = rest / n;
  if (stride < 14) throw new Error("the lens returned records of " + stride + " words");
  const out = [];
  for (let i = 0; i < n; i++) {
    const base = viewsAt + 1 + i * stride;
    out.push({ token: "0x" + at(tokensAt + 1 + i).slice(24), status: Number(BigInt("0x" + at(base))),
      quote: "0x" + at(base + 2).slice(24), launchedAt: stride >= 15 ? Number(BigInt("0x" + at(base + 14))) : null,
      d: stride >= 16 ? "0x" + at(base + 15).slice(24) : null, stride });
  }
  return out;
}

/// Dollars, short: cents from a dollar up, four significant figures below.
function usd(n) {
  if (n === null || !isFinite(n)) return "";
  if (n === 0) return "$0";
  if (n >= 1) return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return "$" + Number(n.toPrecision(4)).toString();
}

/// Every launch whose holder sharing is on: [{ token, d }].
async function sharingLaunches(r, lens, graduator) {
  const registry = a(await r.call(lens, SEL.registry));
  const total = Number(b(await r.call(registry, SEL.launchCount)));
  const launches = [];
  let stride = null;
  for (let i = 0; i < total; i += 50) {
    const page = decodePage(await r.call(lens, SEL.launchPage + Sh.padNum(i) + Sh.padNum(Math.min(50, total - i))));
    if (page.length) stride = page[0].stride;
    launches.push(...page);
  }
  // A LENS WITHOUT WORD 15 CANNOT SAY: the Graduator is asked for each launch.
  if (stride !== null && stride < 16) {
    const ds = await r.calls(launches.map((x) => ({ to: graduator, data: SEL.holderDistributorOf + pad(x.token) })));
    launches.forEach((x, i) => { x.d = a(ds[i]); });
  }
  return launches.filter((x) => x.d && !isZero(x.d));
}

/// ONE TOKEN'S LINE for this wallet, or null when it earned nothing there.
async function lineFor(r, x, who, head, chainId) {
  const dist = await Sh.readDistributor(r, x.d);
  const force = Sh.inForce(dist, head.ts);
  const [p0, p1, symW, uriW, qSymW, qDecW] = await r.calls([
    { to: dist.d, data: SEL.paid0 + pad(who) }, { to: dist.d, data: SEL.paid1 + pad(who) },
    { to: x.token, data: SEL.symbol }, { to: x.token, data: TOKEN_URI },
    { to: dist.quoteToken, data: SEL.symbol }, { to: dist.quoteToken, data: SEL.decimals },
  ]);
  const paid0 = b(p0), paid1 = b(p1);
  // WHAT THE PAYOUT IN FORCE GIVES THIS WALLET, from its checked file.
  let earned = null;
  let file = null;
  if (force.root.epoch > 0) {
    const got = await Sh.loadFile({ chainId, d: dist.d, epoch: force.root.epoch, contentHash: force.root.contentHash,
      uri: async () => ((await Sh.publishedEvent(r, dist.d, force.root, head.number)) || {}).uri || "" });
    if (got.ok) {
      file = got.bytes;
      try { earned = Sh.leafOf(await Sh.parsedFile(got.bytes, { account: who }), who); } catch { earned = null; }
    }
  } else {
    earned = { cum0: 0n, cum1: 0n };
  }
  const known = earned !== null;
  if (known && earned.cum0 === 0n && earned.cum1 === 0n && paid0 === 0n && paid1 === 0n) return null;
  if (!known && paid0 === 0n && paid1 === 0n) return null;
  const qs = str(qSymW);
  const meta = window.CurbMeta.parseMeta(str(uriW));
  const per = await window.CurbPrices.usdPerQuote({ call: (to, data) => r.call(to, data), quote: dist.quoteToken,
    decimals: Number(b(qDecW)) || 18 }).then((p) => p.per).catch(() => null);
  return {
    token: x.token, d: dist.d, sym: window.CurbMeta.cut(str(symW), 16) || short(x.token), image: meta.image,
    qSym: qs === "WETH" ? "ETH" : qs, qd: Number(b(qDecW)) || 18, per, file,
    earned0: known ? earned.cum0 : null, earned1: known ? earned.cum1 : null, paid0, paid1,
    claim0: known && earned.cum0 > paid0 ? earned.cum0 - paid0 : known ? 0n : null,
    claim1: known && earned.cum1 > paid1 ? earned.cum1 - paid1 : known ? 0n : null,
  };
}

function hueOf(address) {
  let h = 0;
  for (let i = 2; i < address.length; i++) h = (h * 31 + address.charCodeAt(i)) >>> 0;
  return h % 360;
}

/// One figure: the amount in the token's asset (and its launch tokens, when the
/// LP side paid any), with dollars under it.
function figure(cls, label, v0, v1, line) {
  const cell = el("div", { class: "shFig " + cls });
  cell.append(el("span", { class: "shFigLabel", text: label }));
  if (v0 === null) { cell.append(el("b", { text: "—" })); return cell; }
  cell.append(el("b", { text: fmt(v0, line.qd, 6) + " " + line.qSym + (v1 && v1 > 0n ? " + " + fmt(v1, 18, 4) + " $" + line.sym : "") }));
  const d = line.per === null ? null : Number(v0) / 10 ** line.qd * line.per;
  if (d !== null) cell.append(el("span", { class: "shUsd", text: usd(d) }));
  return cell;
}

function draw(lines, failed) {
  const box = $("shMine");
  if (!lines.length) {
    box.replaceChildren(el("p", { class: "shNote", id: "shNothing", text: failed
      ? "Your holder fees could not all be read just now."
      : "No holder fees earned yet." }));
    return;
  }
  const rows = lines.map((l) => {
    const pic = el("span", { class: "shPic" });
    pic.style.background = `linear-gradient(135deg, hsl(${hueOf(l.token)} 58% 44%), hsl(${(hueOf(l.token) + 48) % 360} 62% 26%))`;
    pic.append(el("i", { text: (l.sym[0] || "?").toUpperCase() }));
    if (l.image) {
      const im = el("img", { alt: "" });
      im.addEventListener("error", () => im.remove());
      im.src = window.CurbMeta.displayUrl(l.image);
      pic.append(im);
    }
    const link = window.CurbBar.withConfig("token/" + l.token);
    const owed = (l.claim0 !== null && l.claim0 > 0n) || (l.claim1 !== null && l.claim1 > 0n);
    return el("div", { class: "shMineRow", "data-token": l.token.toLowerCase() }, [
      el("a", { class: "shWhat", href: link }, [pic, el("b", { text: "$" + l.sym })]),
      figure("shEarnedFig", "Earned", l.earned0, l.earned1, l),
      figure("shPaidFig", "Paid", l.paid0, l.paid1, l),
      figure("shClaimFig", "Claimable", l.claim0, l.claim1, l),
      owed ? claimButton(l) : el("span", { class: "shClaimLink none" }),
    ]);
  });
  // THE TOTAL, IN DOLLARS: the assets differ, so only dollars add up.
  const sum = (k) => {
    let t = 0, any = false;
    for (const l of lines) if (l.per !== null && l[k] !== null) { t += Number(l[k]) / 10 ** l.qd * l.per; any = true; }
    return any ? usd(t) : "—";
  };
  const total = el("div", { class: "shMineRow shTotal", id: "shTotal" }, [
    el("span", { class: "shWhat" }, [el("b", { text: "Total" })]),
    el("div", { class: "shFig" }, [el("span", { class: "shFigLabel", text: "Earned" }), el("b", { id: "shTotalEarned", text: sum("earned0") })]),
    el("div", { class: "shFig" }, [el("span", { class: "shFigLabel", text: "Paid" }), el("b", { id: "shTotalPaid", text: sum("paid0") })]),
    el("div", { class: "shFig" }, [el("span", { class: "shFigLabel", text: "Claimable" }), el("b", { id: "shTotalClaimable", text: sum("claim0") })]),
    el("span", { class: "shClaimLink none" }),
  ]);
  box.replaceChildren(el("div", { class: "shMineList" }, [...rows, total]),
    failed ? el("p", { class: "shNote warn", text: failed + " token(s) could not be read just now." }) : "");
}

// ---------------------------------------------------------------- claim
/// A notice in the bar's toast: kind "ok", "err" or "wait".
function notice(kind, html) {
  const m = $("msg");
  m.className = kind;
  m.innerHTML = html;
  m.hidden = false;
}
const esc = (x) => String(x).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
/// The transaction: on Base's explorer, elsewhere its short hash to copy.
const txLine = (hash, chainId) => chainId === 8453
  ? `<a class="toastChain" href="https://basescan.org/tx/${hash}" target="_blank" rel="noopener">View on chain ↗</a>`
  : `<span class="toastChain">tx <code data-copy="${hash}" title="${hash}">${hash.slice(0, 6)}…${hash.slice(-4)}</code></span>`;

const TICK = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3.5 8.4l2.9 2.9 6.1-6.6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/// THE WALLET, MOVED TO THE NETWORK THIS PAGE READS - on a press, through the
/// site bar's switch (CurbBar.switchChain, the one app.html uses), never by
/// itself. The button lives in the notice; one listener on #msg runs it.
const networkName = (hex) => (hex === "0x2105" ? "Base" : "network " + parseInt(hex, 16));
const switchButton = (hex) =>
  `<button type="button" class="btn shSwitch" data-switch-chain="${esc(hex)}">Switch the wallet to ${esc(networkName(hex))}</button>`;
$("msg").addEventListener("click", async (e) => {
  const btn = e.target && e.target.closest ? e.target.closest("button[data-switch-chain]") : null;
  if (!btn || !window.CurbBar.switchChain) return;
  const hex = btn.dataset.switchChain;
  btn.disabled = true;
  try {
    await window.CurbBar.switchChain(hex, window.CurbBar.config().rpc);
    notice("ok", "The wallet is on " + esc(networkName(hex)) + " now. Press Claim again.");
  } catch (err) {
    notice("err", err && err.code === 4001 ? "The wallet stayed where it was." : esc((err && err.message) || err));
  }
});

function claimButton(l) {
  const btn = el("button", { type: "button", class: "btn shClaimLink", text: "Claim" });
  btn.addEventListener("click", () => claim(l, btn));
  return btn;
}

async function receiptOf(r, hash) {
  for (let i = 0; i < 240; i++) {
    const rec = await r.rpc("eth_getTransactionReceipt", [hash]).catch(() => null);
    if (rec) return rec;
    await new Promise((res) => setTimeout(res, 1500));
  }
  return null;
}

/// THE CLAIM, FROM THIS PAGE: the proof built from the payout's checked file,
/// simulated, then sent from the connected wallet. To this wallet only; a
/// wallet that cannot receive claims to another address on the token's page
/// (token/0x…#holders).
let claiming = false;
async function claim(l, btn) {
  if (claiming) return;
  claiming = true;
  btn.disabled = true;
  try {
    const who = window.CurbBar.account();
    // THE WALLET THE PERSON CHOSE in the bar (topbar.js "the wallets"), and no other.
    const eth = window.CurbBar.wallet();
    if (!eth || !who) throw new Error("Connect a wallet first.");
    const r = Sh.reader(window.CurbBar.config().rpc);
    const [walletChain, nodeChain] = await Promise.all([eth.request({ method: "eth_chainId" }), r.rpc("eth_chainId", [])]);
    // ONCE config.js NAMES A DEPLOYMENT, ITS CHAIN AND ITS ENDPOINT ONLY (the
    // bar's chainRefusal and endpointRefusal, as app.html's sends): the switch
    // offered is to that chain, never to the one a link's endpoint serves.
    const site = window.CurbBar.sendChain ? window.CurbBar.sendChain() : null;
    const offChain = window.CurbBar.chainRefusal ? window.CurbBar.chainRefusal(walletChain) : null;
    if (offChain) {
      notice("err", esc(offChain) + " " + switchButton(site));
      return;
    }
    // ANOTHER NETWORK IS NOT A DEAD END: the notice carries the switch (see
    // switchButton), and the claim is pressed again once the wallet is there.
    if (parseInt(walletChain, 16) !== parseInt(nodeChain, 16)) {
      notice("err", "Your wallet is on another network than this page reads. " +
        (site ? "" : switchButton("0x" + parseInt(nodeChain, 16).toString(16))));
      return;
    }
    const offEndpoint = window.CurbBar.endpointRefusal ? window.CurbBar.endpointRefusal(window.CurbBar.config().rpc) : null;
    if (offEndpoint) {
      notice("err", esc(offEndpoint));
      return;
    }
    if (!l.file) throw new Error("The payout file could not be read just now. Try again shortly.");
    const s = await Sh.share();
    const p = s.proofOf(s.treeOf(await Sh.parsedFile(l.file, { account: who })), who);
    if (!p) throw new Error("This wallet has no share in the payout in force.");
    const data = SEL.claim + encode([T.uint(256), T.uint(256), T.array(T.bytesN(32)), T.address], [p.cum0, p.cum1, p.proof, ZERO]).slice(2);
    try {
      await r.rpc("eth_call", [{ from: who, to: l.d, data }, "latest"]);
    } catch (e) {
      const link = window.CurbBar.withConfig("token/" + l.token) + "#holders";
      notice("err", "This claim would fail. <a href=\"" + esc(link) + "\">Claim to another address</a>");
      return;
    }
    // CURB'S BUILDER CODE (builder-code.js).
    const signed = window.CurbBuilder.attribute({ from: who, to: l.d, data });
    notice("wait", "Confirm the claim in your wallet…");
    let hash;
    try {
      hash = await eth.request({ method: "eth_sendTransaction", params: [signed] });
    } catch (e) {
      notice("err", e && e.code === 4001 ? "Cancelled." : esc((e && e.message) || e));
      return;
    }
    notice("wait", "Claiming…");
    const rec = await receiptOf(r, hash);
    if (!rec || rec.status !== "0x1") { notice("err", "The claim failed. " + txLine(hash, parseInt(nodeChain, 16))); return; }
    const got = (l.claim0 || 0n);
    notice("ok", `<span class="toastShort"><span class="toastIcon">${TICK}</span><span class="toastBody"><b class="toastTitle">Claimed</b>` +
      `<span class="toastLine"><strong>${esc(fmt(got, l.qd, 6))} ${esc(l.qSym)}</strong> <span class="toastArrow">·</span> ${esc(l.sym)}</span></span></span>` +
      txLine(hash, parseInt(nodeChain, 16)));
    go();
  } catch (e) {
    notice("err", esc((e && e.message) || e));
  } finally {
    claiming = false;
    btn.disabled = false;
  }
}

let run = 0;
async function main() {
  const seq = ++run;
  const cfg = window.CurbBar.config();
  if (!Sh.isAddr(cfg.lens)) {
    say(cfg.halfLink ? "This link names only half of what the page needs (an endpoint and a lens)." : "No lens is set.");
    $("shMine").replaceChildren();
    return;
  }
  if (window.CurbBar.ready) await window.CurbBar.ready;
  const who = window.CurbBar.account();
  if (!who) {
    say("");
    $("shMine").replaceChildren(el("p", { class: "shNote", id: "shConnect", text: "Connect a wallet to see your holder fees." }));
    return;
  }
  $("shMine").replaceChildren(el("p", { class: "shNote", text: "Reading…" }));
  const r = Sh.reader(cfg.rpc);
  const head = await r.head();
  const chainId = parseInt(await r.rpc("eth_chainId", []), 16);
  const graduator = a(await r.call(cfg.lens, SEL.graduator));
  const launches = await sharingLaunches(r, cfg.lens, graduator);
  const lines = [];
  let failed = 0;
  for (let i = 0; i < launches.length; i += 6) {
    const got = await Promise.all(launches.slice(i, i + 6).map((x) => lineFor(r, x, who, head, chainId).catch(() => { failed += 1; return null; })));
    for (const l of got) if (l) lines.push(l);
  }
  if (seq !== run) return;
  say("");
  draw(lines, failed);
}

const go = () => main().catch((e) => say("Could not read: " + ((e && e.message) || e)));
let last;
window.CurbBar.onAccount((acc) => { if (acc === last) return; last = acc; go(); });
window.CurbSharingPage = { decodePage };
})();
