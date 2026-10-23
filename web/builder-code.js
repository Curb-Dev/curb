// CURB'S BASE BUILDER CODE (ERC-8021), on every transaction the site sends.
//
// Base's Dashboard gave CURB the code bc_hhvip0hj on 23 October 2026 (project
// "Curb", 6adb5cfb9fd7480a0f113787). ERC-8021 attribution is a suffix after
// the calldata: the code, its length, the schema id 0 and the ERC's 16-byte
// marker. A contract reads its arguments from where the ABI puts them and
// never past them, so the call does exactly what it did without the suffix;
// Base reads the suffix off the chain to count what CURB's site sent.
//
// ONE FILE, ONE SUFFIX: app.js, launch.js and sharing-page.js each send
// through `CurbBuilder.attribute` and nothing else, so no path can attribute
// to another app or be left out (site.spec.js reads every sender).
//
// A CALL WITH NO DATA IS LEFT AS IT IS. A plain value transfer runs a
// contract's receive(); with bytes after it, the same transfer runs its
// fallback() instead, which may do something else or revert.
(function () {
  "use strict";

  const code = "bc_hhvip0hj";
  const dataSuffix = "0x62635f686876697030686a0b0080218021802180218021802180218021";
  const SUFFIX = dataSuffix.slice(2);

  /// A NEW TRANSACTION OBJECT with the suffix after its data; the one given is
  /// never changed. Already carrying it, the data is kept (a second pass adds
  /// nothing). Throws on data that is not whole bytes of hex - before any
  /// wallet is asked, so nothing is sent.
  function attribute(tx) {
    if (!tx || typeof tx !== "object" || Array.isArray(tx)) throw new TypeError("no transaction to attribute");
    const data = tx.data === undefined || tx.data === null ? "0x" : String(tx.data);
    if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(data)) throw new TypeError("the transaction's data is not whole bytes of hex");
    if (data === "0x" || data.slice(2).toLowerCase().endsWith(SUFFIX)) return { ...tx };
    return { ...tx, data: data + SUFFIX };
  }

  window.CurbBuilder = Object.freeze({ code, dataSuffix, attribute });
})();
