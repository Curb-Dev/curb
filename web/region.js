// TRADING AND LAUNCHING ARE NOT OFFERED TO VISITORS IN THE UNITED STATES.
//
// The pages that send read this one file (app.html, launch.html) and ask it
// before each send it holds. The contracts are not changed by it and stay open
// to anyone on Base: this is what the site offers, not what the chain allows.
//
// WHERE THE VISITOR IS, THE HOST SAYS. /region is a same-origin file the host
// picks by the visitor's country, so the pages stay static and the same for
// everyone: Vercel by the x-vercel-ip-country header it adds to each request
// (web/vercel.json), Netlify by its Country= condition (web/_redirects).
// region-us.json for the United States and its territories (US, PR, GU, VI,
// AS, MP, UM), region.json for anywhere else, each with Cache-Control:
// no-store, so no browser or cache hands one visitor's answer to another.
//
// HELD: creating a launch (with or without a dev buy), buying and selling on a
// curve, swapping in a pool, every step of the ETH routes (Aerodrome's
// included, and selling back what one left held), completing a waiting
// launch's move, and the approvals, wraps and unwraps sent as part of those.
// OPEN: reading every page, connecting a wallet, claims, holder sharing, the
// migrate kit, the docs.
//
// IT FAILS CLOSED WHERE AN ANSWER IS EXPECTED: on a host config.js lists in
// regionHosts, an answer that cannot be read refuses each held send with a
// try-again, and nothing reaches the wallet. A press asks again first, so one
// failed read is not the last word. On any other host - an IPFS gateway, a
// local server, Cloudflare Pages, which reads no country - nothing answers
// /region, and the pages behave as the default answer (web/README.txt).
(function () {
  "use strict";

  const WORDS = "Trading and launching aren't available in the United States.";
  const UNREAD = "This page couldn't check where you're visiting from, so nothing was sent. Try again in a moment.";
  // HOW LONG AN ANSWER IS WAITED FOR, at load and at a press.
  const WAIT_MS = 8000;

  const listed = ((window.CURB_SITE && window.CURB_SITE.regionHosts) || []).map((h) => String(h).toLowerCase());
  const expected = listed.includes(String(location.hostname).toLowerCase());

  /// "open", "closed", or "unread": a host that did not answer, or answered
  /// anything but the file's own shape. null until the first answer lands.
  let state = null;
  let asking = null;
  const held = [];

  function ask() {
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), WAIT_MS) : null;
    return fetch("/region", { cache: "no-store", credentials: "omit", signal: ctl ? ctl.signal : undefined })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => (j && typeof j.trading === "boolean" ? (j.trading ? "open" : "closed") : "unread"))
      .catch(() => "unread")
      .then((a) => {
        if (timer) clearTimeout(timer);
        state = a;
        if (a === "closed") held.forEach(apply);
        document.dispatchEvent(new CustomEvent("curb:region", { detail: { state: a } }));
        return a;
      });
  }

  /// The answer for this page: asked once at load, again only after one that
  /// could not be read.
  function answer() {
    if (!asking) asking = ask();
    return asking;
  }

  /// FOR A SEND THIS FILE HOLDS: null when it may go, otherwise the sentence
  /// that refuses it. Asked by the action before the wallet is asked anything.
  async function refusal() {
    let a = await answer();
    if (a === "unread") { asking = null; a = await answer(); }
    if (a === "closed") return WORDS + " Nothing was sent.";
    if (a === "unread" && expected) return UNREAD;
    return null;
  }

  function apply(h) {
    const b = h.button;
    b.disabled = true;
    // KEPT DISABLED, WHATEVER ENABLES IT. The pages enable their buttons in
    // many places - after every action, whenever a quote is drawn - and none of
    // them needs to know about this; the action's own refusal stands behind it.
    if (!h.watch) {
      h.watch = new MutationObserver(() => { if (!b.disabled) b.disabled = true; });
      h.watch.observe(b, { attributes: true, attributeFilter: ["disabled"] });
    }
    if (h.noted && !h.note) {
      h.note = document.createElement("p");
      h.note.className = "note regionNote";
      h.note.textContent = WORDS;
      b.insertAdjacentElement("afterend", h.note);
    }
  }

  /// A BUTTON THAT TRADES OR LAUNCHES, held disabled once the answer is
  /// "closed"; with `noted`, the reason is written right after it.
  function hold(button, noted) {
    if (!button) return;
    const h = { button, noted: !!noted, watch: null, note: null };
    held.push(h);
    if (state === "closed") apply(h);
  }

  window.CurbRegion = {
    WORDS, answer, refusal, hold,
    /// Whether the answer in hand says the United States.
    closed: () => state === "closed",
  };

  answer();
})();
