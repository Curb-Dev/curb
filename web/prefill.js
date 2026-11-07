// A PREFILLED LAUNCH LINK: what it may put in the create form, and when.
//
// An AI agent, or a person, hands someone a link such as
//   https://curbfun.xyz/launchpad?factory=0x...&name=Moon%20Cat&symbol=MCAT&tax=2&earn=holders
// and the form opens with those choices filled in. The person then checks every
// field, connects and presses Create the launch, exactly as with a form they
// filled in by hand: the region gate, the wallet and every check before a send
// are app.js's and run unchanged (web/agents/curb.md says the same to agents).
//
// WHAT A LINK MAY FILL is a short list of cosmetic and launch-choice fields the
// person sees on the form before signing (KEYS), plus the paired asset through
// ?factory=, which app.js loadCfg has always read. Every other key is ignored BY
// CONSTRUCTION: parse() reads KEYS and nothing else, so no list of bad keys
// decides what is safe. NEVER and LINK_DOES_NOT_FILL exist only so the page can
// say that a link tried: a link that names a creator wallet, a dev buy, slippage
// or a recipient is a sign of phishing, and the person is told so.
//
// PURE FUNCTIONS, NO DOM: app.js applies the result, and the unit tests
// (services/sharer/test/site-prefill.test.ts) load this file on its own.
(function () {
"use strict";

/// The only keys parse() reads. The factory is read by app.js loadCfg.
const KEYS = ["name", "symbol", "tax", "earn"];

/// Keys a link can never set, by what they would set. Only for the warning:
/// nothing here is ever read. Compared in lower case with - and _ removed.
const NEVER = [
  ["the creator wallet", ["creatorwallet", "creator", "ncreator", "beneficiary", "wallet", "payto", "recipient", "receiver", "to"]],
  ["the dev buy", ["devbuy", "dev", "ndevbuy", "devpct", "ndevpct", "devslider", "ndevslider", "firstbuy", "buy", "amount", "value"]],
  ["slippage", ["slippage", "poolslippage", "slip"]],
];
/// Fields a link does not fill in this release: free text and links written
/// into the token for good, where a stranger's link could plant a phishing URL
/// in someone's launch. The image cannot be set by a URL at all.
const LINK_DOES_NOT_FILL = [
  ["the description", ["desc", "ndesc", "description"]],
  ["the links", ["site", "nsite", "website", "x", "nx", "twitter", "tg", "ntg", "telegram"]],
  ["the image", ["image", "img", "logo", "nimagefile", "tokenuri", "uri"]],
];

/// A FACTORY AS A LINK WRITES IT: exactly "0x" and 40 hex digits, nothing
/// around it - the string app.js loadCfg reads, not a trimmed or re-cased
/// copy. "0X..." or an address with a space beside it is no factory of the
/// site's (the page would read the raw value), so it is half a link as before
/// and fills nothing. Only the hex digits compare in any case.
const FACTORY = /^0x[0-9a-fA-F]{40}$/;
const lc = (s) => String(s == null ? "" : s).trim().toLowerCase();
const norm = (k) => String(k).toLowerCase().replace(/[-_]/g, "");
/// Whether a link's raw factory is one of `listed`, and not one of `hidden`.
const offered = (raw, listed, hidden) => {
  const f = String(raw == null ? "" : raw);
  if (!FACTORY.test(f)) return false;
  const l = f.toLowerCase();
  return (listed || []).map(lc).includes(l) && !(hidden || []).map(lc).includes(l);
};

/// A name: letters and digits of any script, space and . , ' - & ! ? ( ) + #
/// No emoji, no control, format, bidi or zero-width character, no combining
/// mark, no markup character, no ":". Stricter than the form on purpose: a
/// name is shown on every card for good, so a stranger's link may not plant
/// in it what the person might miss -
const NAME_CHARS = /^[\p{L}\p{N} .,'&!?()+#-]+$/u;
/// - a letter that renders as nothing (the Hangul fillers),
const BLANK_LETTERS = /[\u{115f}\u{1160}\u{3164}\u{ffa0}]/u;
/// - a web address ("Claim at evil.com": a dot between a letter or digit and
///   two letters),
const DOMAIN_LIKE = /[\p{L}\p{N}]\.\p{L}{2,}/u;
/// - or Latin mixed with Cyrillic or Greek, the look-alikes ("Сurb" with a
///   Cyrillic С). One script alone is fine: "Котик 2".
const LATIN = /\p{Script=Latin}/u;
const LOOKALIKE = /[\p{Script=Cyrillic}\p{Script=Greek}]/u;
/// A tax in percent: no sign, no leading zero, no exponent, at most 2 decimals.
const TAX_TEXT = /^(0|[1-9][0-9]{0,2})(\.[0-9]{1,2})?$/;

/// WHETHER A LINK IS HALF A LINK: it names a contract but not where to read it,
/// or where to read but no contract. TODAY'S RULE (app.js loadCfg), with one
/// exception: in production, a link that names one of the site's own factories
/// (listed in config.js, not hidden), once, and no rpc or lens, on a page that
/// reads config.js's own endpoint and lens, is a whole link. Both halves then
/// come from config.js: the factory is one it publishes and the endpoint is its
/// own. A factory named twice is no such link, even when the first is listed:
/// parse() fills nothing from it, so the page must not stay quiet either.
///
/// o: { production, restatesSaved, namesWhat, rpcNamed, lensNamed,
///      factories (every ?factory= value, as written), siteFactories,
///      hiddenFactories, readsSitePair }
function halfLink(o) {
  const old = !o.restatesSaved &&
    ((o.namesWhat && !o.rpcNamed) || (o.rpcNamed && !o.namesWhat));
  if (!old) return false;
  const named = Array.isArray(o.factories) ? o.factories : [];
  const own = !!o.production && !o.rpcNamed && !o.lensNamed && named.length === 1 &&
    offered(named[0], o.siteFactories, o.hiddenFactories) && !!o.readsSitePair;
  return !own;
}

/// One value, checked against its rule, or null when it breaks it.
function check(key, v, o) {
  if (key === "name") {
    if (v.length < 1 || v.length > o.nameMax) return null;
    if (/^ | $/.test(v)) return null;
    if (BLANK_LETTERS.test(v) || DOMAIN_LIKE.test(v)) return null;
    if (LATIN.test(v) && LOOKALIKE.test(v)) return null;
    return NAME_CHARS.test(v) ? v : null;
  }
  if (key === "symbol") {
    return new RegExp("^[A-Za-z0-9]{1," + o.symbolMax + "}$").test(v) ? v : null;
  }
  if (key === "tax") {
    const m = TAX_TEXT.exec(v);
    if (!m) return null;
    const bps = Number(m[1]) * 100 + Number(((m[2] || ".").slice(1) + "00").slice(0, 2));
    return bps >= o.taxMinBps && bps <= o.taxMaxBps ? v : null;
  }
  if (key === "earn") return v === "you" || v === "holders" ? v : null;
  return null;
}

/// WHAT A LINK FILLS IN THE CREATE FORM, if anything.
///
/// q  the page's query (URLSearchParams), after app.js siteQuery()
/// o  { production, tokenView, formThere, readsSitePair, siteFactories,
///      hiddenFactories, nameMax, symbolMax, taxMinBps, taxMaxBps }
///
/// Returns { values, filled, refused, never, notFilled, tried, blocked }:
///   values     the checked values to write, by key (KEYS only)
///   filled     what the link filled: the keys of values, and "factory" when
///              it named one of the site's own
///   refused    [key, why] for each value not used: "rule" or "twice"
///   never      the labels of NEVER keys present (the creator wallet, ...)
///   notFilled  the labels of LINK_DOES_NOT_FILL keys present
///   tried      whether the link carries any key of KEYS
///   blocked    null, or why nothing was filled: "production", "tokenView"
///              (both said nowhere), "endpoint" (the link names rpc or lens),
///              "launch" (it names a token), "factory" (not one this site
///              offers, as written), "factories" (it names more than one) or
///              "saved" (the page reads another endpoint or lens, saved in
///              this browser)
function parse(q, o) {
  const out = { values: {}, filled: [], refused: [], never: [], notFilled: [], tried: false, blocked: null };
  if (!o || !o.production) { out.blocked = "production"; return out; }
  if (o.tokenView || o.formThere === false) { out.blocked = "tokenView"; return out; }
  const keys = [];
  try { for (const k of q.keys()) keys.push(norm(k)); } catch { /* not a query */ }
  for (const [label, names] of NEVER) if (keys.some((k) => names.includes(k))) out.never.push(label);
  for (const [label, names] of LINK_DOES_NOT_FILL) if (keys.some((k) => names.includes(k))) out.notFilled.push(label);
  out.tried = KEYS.some((k) => q.getAll(k).length > 0);
  // A LINK THAT NAMES WHERE TO READ THE CHAIN, OR A LAUNCH, FILLS NOTHING.
  if (q.get("rpc") || q.get("lens")) { out.blocked = "endpoint"; return out; }
  if (q.get("token")) { out.blocked = "launch"; return out; }
  // A NAMED FACTORY MUST BE NAMED ONCE, AND BE ONE OF THE SITE'S OWN, OFFERED,
  // EXACTLY AS WRITTEN (offered).
  const factories = q.getAll("factory");
  if (factories.length > 1) { out.blocked = "factories"; return out; }
  if (factories.length && !offered(factories[0], o.siteFactories, o.hiddenFactories)) {
    out.blocked = "factory";
    return out;
  }
  // AND THE PAGE MUST READ config.js's OWN ENDPOINT AND LENS (not a pair saved
  // in this browser): only then are both halves of the link the site's.
  if (!o.readsSitePair) { out.blocked = "saved"; return out; }
  if (factories.length) out.filled.push("factory");
  for (const k of KEYS) {
    const all = q.getAll(k);
    if (!all.length) continue;
    if (all.length > 1) { out.refused.push([k, "twice"]); continue; }
    const v = check(k, String(all[0]), o);
    if (v === null) { out.refused.push([k, "rule"]); continue; }
    out.values[k] = v;
    out.filled.push(k);
  }
  return out;
}

/// "a", "a and b", "a, b and c".
const list = (xs) => (xs.length < 2 ? xs.join("") : xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1]);
const pct = (bps) => String(bps / 100);
const FIELD = { factory: "the paired asset", name: "the name", symbol: "the symbol", tax: "the creator tax", earn: "who earns it" };

/// WHAT THE FORM SAYS ABOUT THE LINK, as plain sentences, in a fixed order:
/// what was filled (and, when the link chose Holders, what that gives away),
/// each value not used (by its rule, never echoed), why nothing was filled,
/// what the link tried and can never set, and what a link does not fill.
/// Empty when there is nothing to say. `o` as for parse().
function notice(r, o) {
  const out = [];
  if (!r || r.blocked === "production" || r.blocked === "tokenView") return out;
  if (r.filled.length) {
    out.push("Filled in from a link: " + list(r.filled.map((k) => FIELD[k])) + ". Check every field before you " +
      "create. A launch cannot be changed afterwards.");
  }
  // HOLDERS IS THE ONE CHOICE A LINK MAKES FOR OTHER PEOPLE: whoever sent it
  // can buy early and collect the creator's share. Said on its own line.
  if (r.values && r.values.earn === "holders") {
    out.push("This link chose Holders: if you keep that, your creator share is 0% for good and goes to whoever " +
      "holds the token. Choose You to keep it.");
  }
  for (const [k, why] of r.refused) {
    if (why === "twice") { out.push("The link gave " + FIELD[k] + " more than once, so it was not used."); continue; }
    if (k === "name") {
      out.push("The link's name was not used: it must be 1 to " + o.nameMax + " letters, digits, spaces or " +
        ". , ' - & ! ? ( ) + #, with no space at either end, nothing that looks like a web address, and no " +
        "Latin letters mixed with Cyrillic or Greek ones.");
    } else if (k === "symbol") {
      out.push("The link's symbol was not used: it must be 1 to " + o.symbolMax + " letters or digits.");
    } else if (k === "tax") {
      out.push("The link's creator tax was not used: it must be a percent from " + pct(o.taxMinBps) + " to " +
        pct(o.taxMaxBps) + ", with at most 2 decimals.");
    } else if (k === "earn") {
      out.push("The link's choice of who earns the tax was not used: it must be you or holders.");
    }
  }
  // WHY NOTHING WAS FILLED - only when the link tried to fill something: the
  // site's own links (the bar's saved pair) are not prefilled links.
  if (r.tried && r.blocked === "factory") {
    out.push("This link names a factory this site does not offer, so nothing from it was filled in.");
  } else if (r.tried && r.blocked === "factories") {
    out.push("This link names more than one factory, so nothing from it was filled in.");
  } else if (r.tried && r.blocked === "endpoint") {
    out.push("This link names where to read the chain, so nothing from it was filled in.");
  } else if (r.tried && r.blocked === "launch") {
    out.push("This link names a launch, so nothing from it was filled in.");
  } else if (r.tried && r.blocked === "saved") {
    out.push("This page reads another endpoint or lens saved in this browser, so nothing from the link was " +
      "filled in.");
  }
  if (r.never.length) {
    out.push("This link also tried to set " + list(r.never) + ". A link can never set " +
      (r.never.length > 1 ? "those" : "that") + ", so " + (r.never.length > 1 ? "they were" : "it was") +
      " ignored. Be careful with whoever sent it.");
  }
  if (r.notFilled.length) {
    out.push("A link does not fill the description, the links or the image. Add them yourself if you want them.");
  }
  return out;
}

window.CurbPrefill = { KEYS, NEVER, LINK_DOES_NOT_FILL, parse, halfLink, notice };
})();
