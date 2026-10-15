// A LAUNCH TOKEN'S OWN WORDS, READ WITHOUT TRUSTING THEM.
//
// Every string here comes from a stranger: anyone can call the factory with
// any name, symbol and tokenURI, so what a page reads back is input, not
// content. These rules lived inside browse.js; the site's search (search.js)
// reads the same tokens, and two copies of an XSS rule are two rules that
// drift. Both load this file and use window.CurbMeta; nothing else is exported.
//
// What a caller must still do itself: put names and symbols into textContent
// (never innerHTML), links into an href only after safeUrl, and an image src
// only after safeImage and displayUrl.
(function () {
"use strict";

const WORD = 64;
const numAt = (hex, i) => BigInt("0x" + hex.slice(i * WORD, (i + 1) * WORD));

/// A dynamic ABI string, as UTF-8.
function decodeString(raw) {
  const hex = (raw || "0x").replace(/^0x/, "");
  if (hex.length < WORD * 2) return "";
  const at = Number(numAt(hex, 0)) * 2 / WORD;
  const len = Number(numAt(hex, at));
  const body = hex.slice((at + 1) * WORD, (at + 1) * WORD + len * 2);
  // UTF-8, NOT ONE CHARACTER PER BYTE. A name with an accent or an emoji is
  // several bytes per character on chain, and reading each byte as latin-1
  // printed it as mojibake. Invalid sequences become U+FFFD rather than
  // throwing: a stranger's bytes must not take the row down.
  const bytes = new Uint8Array(body.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/// Trimmed to fit a row, with the ellipsis saying it was cut.
function cut(s, n) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

/// WHAT A LINK OUT OF A TOKEN IS ALLOWED TO BE.
///
/// The same rule the create form applies on the way in, applied again on the
/// way out - because a launch does not have to have been made by this page.
/// Anyone can call the factory with any string, so what comes back here is a
/// stranger's input and `javascript:` in an href is the whole attack.
const SAFE_URL = /^(https:\/\/|http:\/\/|ipfs:\/\/)[^\s"'<>]{1,180}$/i;
const safeUrl = (u) => (typeof u === "string" && SAFE_URL.test(u) ? u : "");

/// AN IMAGE MAY ALSO BE BYTES. The create form stores the picture itself, as a
/// data:image/webp URI, precisely so it survives without anybody's server - and
/// safeUrl refused every one, so no launch made by this product ever showed its
/// image. Accepted for images only, never for a link, and only raster types in
/// base64: an <img> does not run what it loads, and nothing else on the page is
/// given this string. The size bound is the create form's own ceiling with room
/// to spare.
const SAFE_IMAGE_DATA = /^data:image\/(webp|png|jpeg|gif);base64,[A-Za-z0-9+\/]+={0,2}$/;
const safeImage = (u) =>
  typeof u === "string" && u.length <= 64 * 1024 && SAFE_IMAGE_DATA.test(u) ? u : safeUrl(u);

/// ipfs:// is not something a browser can fetch. Rendered through a gateway,
/// and only for display - what is STORED stays the ipfs:// form, which is the
/// one that does not depend on anybody's gateway still existing.
const displayUrl = (u) =>
  u.startsWith("ipfs://") ? "https://ipfs.io/ipfs/" + u.slice(7) : u;

/// The token's metadata, parsed without trusting any of it.
///
/// PARSE FAILURES ARE NORMAL, NOT EXCEPTIONAL. Most tokenUri values in the
/// wild will be empty, an IPFS hash nobody is going to fetch, or something no
/// page here has seen. Every one of those is a launch that still gets drawn -
/// with the letters it has today.
function parseMeta(uri) {
  const empty = { image: "", website: "", twitter: "", telegram: "", description: "" };
  if (typeof uri !== "string" || !uri.startsWith("data:application/json;base64,")) return empty;
  try {
    const json = new TextDecoder().decode(
      Uint8Array.from(atob(uri.slice(29)), (c) => c.charCodeAt(0))
    );
    const m = JSON.parse(json);
    if (!m || typeof m !== "object") return empty;
    return {
      image: safeImage(m.image),
      website: safeUrl(m.website),
      twitter: safeUrl(m.twitter),
      telegram: safeUrl(m.telegram),
      description: typeof m.description === "string" ? cut(m.description, 140) : "",
    };
  } catch { return empty; }
}

window.CurbMeta = { decodeString, cut, safeUrl, safeImage, displayUrl, parseMeta };

})();
