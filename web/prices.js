// DOLLARS PER WHOLE UNIT OF A QUOTE ASSET, shared by a launch's own page
// (token.js) and the launches page (browse.js).
//
// It lived inside token.js. The launches page now shows every market cap in
// dollars too, and two copies of a feed map are two maps that drift: a feed
// corrected in one would leave the other page quoting a different number for
// the same launch. Both pages load this file and use window.CurbPrices.
//
// EVERYTHING HERE IS A READ, and the caller supplies the transport: `call(to,
// data)` is the page's own eth_call against the endpoint it already reads
// from, so this file adds no host and no second idea of which chain is meant.
(function () {
"use strict";

const WETH = "0x4200000000000000000000000000000000000006";

// CHAINLINK'S OWN DOLLAR PRICE FOR EACH QUOTE ASSET, on Base: [feed, what its
// description() must say]. Taken from Chainlink's feed directory for Base and
// read back on chain on 2026-09-28 - each answered its description, and the
// equities agreed with their own Uniswap markets to about a per cent. A feed is
// used only after it names itself on chain as the one listed here; otherwise
// the asset is priced through WETH (usdPerQuote, when the caller can price that
// leg), and failing that no dollar figure is shown at all. The equity feeds
// follow US market hours, so over a weekend their answer is Friday's close.
//
// USDC, VIRTUAL AND AERO JOINED ON 2026-10-15 (the owner's list of fourteen).
// Each feed was read back on live Base that day before it was written here:
// description() "USDC / USD", "VIRTUAL / USD" and "AERO / USD", decimals() 8
// for all three, answering $0.9999, $0.674 and $0.886. USDC's matters most: it
// is the feed the conversion check (app.js withConversion) holds an ETH ->
// USDC swap against, and without it every ETH trade on the USDC pair would be
// refused as unchecked.
const USD_FEEDS = {
  [WETH]: ["0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70", "ETH / USD"],
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": ["0x7e860098f58bbfc8648a4311b374b1d669a2bc6b", "USDC / USD"],
  "0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b": ["0xeaf310161c9ef7c813a14f8fef6fb271434019f7", "VIRTUAL / USD"],
  "0x940181a94a35a4569e4529a3cdfb74e38fd98631": ["0x4ec5970fc728c5f65ba413992cd5ff6fd70fcff0", "AERO / USD"],
  "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": ["0x07da0e54543a844a80abe69c8a12f22b3aa59f9d", "cbBTC / USD"],
  "0xcb585250f852c6c6bf90434ab21a00f02833a4af": ["0xeee1a9d5a0c36d99972c057cb959267e88ab9160", "CBXRP / USD"],
  "0xb2000000000000000000008501b13360000cb2ec": ["0x69e5bc4988a9af30ec827c5609c0d41028446ec0", "ZEC / USD"],
  "0xb20000000000000000000078ee7ce2fe4908108c": ["0x04689a41629776563e6822f76f2e57d148d28513", "Coinbase NVDA"],
  "0xb2000000000000000000002d0ba3164cc74f58b7": ["0x5bf49e0ffa937ce2fff033c739ad7c634c4d34f2", "Coinbase GOOGL"],
  "0xb2000000000000000000007b9fcbd005511acbd5": ["0x6a634b235903c4ad6376892180d6ff8612e3fa68", "Coinbase SPCX"],
  "0xb200000000000000000000d9192b6b456483c2e8": ["0x06a8e4b3abb3b7543d8396fb2b763d22820cb295", "Coinbase AMZN"],
  "0xb200000000000000000000ab99cfa739e253872b": ["0xeb10a6c9aa7e537aed766c08c35dae35b321b18c", "Coinbase MSFT"],
  "0xb200000000000000000000c2e324d24d7eecd1fb": ["0x787f13dea48db0897cbcdd985de77809d837f988", "Coinbase AAPL"],
  "0xb2000000000000000000008bc8786b856e61707c": ["0x6526ae6797a76123638b863aee4dd27ba4e4b27d", "Coinbase META"],
  // Equities app.js names that no factory lists yet - priced if one ever does.
  "0xb2000000000000000000001e800a7f5189430cd0": ["0xfaf869185383a24f8cb00e27bda6b63b9905dcb4", "Coinbase TSLA"],
  "0xb2000000000000000000004884b426556b92883d": ["0xb3ce282cd188b35da0e38d8bc7d58e33173d202a", "Coinbase MSTR"],
  "0xb200000000000000000000397293cb8cda9a10c5": ["0x388b0dc46c0fb05a74bee0994fa5b02c6fcca2ea", "Coinbase SNDK"],
  "0xb200000000000000000000c85a31389d71f3ecfb": ["0x408e44f504a7371a345f03a73ddc96a4b48e8aa7", "Coinbase COIN"],
  "0xb20000000000000000000019f6e7c675b73c2e4d": ["0x0231cf2635d1e17bb5c2462cc7504ba1fbd61f33", "Coinbase CRCL"],
  "0xb2000000000000000000004aff16039ba04bdfbc": ["0xab657c39bac0d5886250d70849e2e3e008f2eecb", "Coinbase INTC"],
};

// SELECTORS ARE DERIVED, NOT PASTED - the rule app.js states: a mistyped
// constant is a call to a function that does not exist, and here that would
// quietly cost every card its dollars. Both pages load keccak.js first.
const utf8Hex = (s) =>
  Array.from(new TextEncoder().encode(s)).map((b) => b.toString(16).padStart(2, "0")).join("");
const sig = (s) => window.CurbKeccak.keccak256("0x" + utf8Hex(s)).slice(0, 10);
const SEL = {
  latestRoundData: sig("latestRoundData()"),
  description: sig("description()"),
  decimals: sig("decimals()"),
};

// Flat words out of a static return - the same reading as abi.js words(), which
// the launches page does not load.
const WORD = 64;
function words(raw) {
  const h = (raw || "").replace(/^0x/, "");
  const out = [];
  for (let i = 0; i + WORD <= h.length; i += WORD) out.push(h.slice(i, i + WORD));
  return out;
}
const wordToBig = (w) => BigInt("0x" + w);
const word0 = (raw) => { const w = words(raw || "0x"); return w.length ? wordToBig(w[0]) : null; };

/// A whole-unit float from an integer and its decimals, without going through
/// a Number that cannot hold the integer.
function toFloat(big, dec) {
  if (big === null || big === undefined) return NaN;
  const b = BigInt(big);
  const neg = b < 0n;
  const a = neg ? -b : b;
  const base = 10n ** BigInt(dec);
  const whole = Number(a / base);
  const frac = Number(a % base) / Number(base);
  return (neg ? -1 : 1) * (whole + frac);
}

/// THE FEED'S OWN NAME, read as UTF-8 by the site's one decoder (token-meta.js).
/// Without it nothing can be checked, and an unchecked feed is not used.
function decodeString(raw) {
  const Meta = window.CurbMeta || null;
  return Meta && Meta.decodeString ? Meta.decodeString(raw) : "";
}

/// One Chainlink feed's answer in dollars, with when it was given - or null
/// when the feed does not call itself `expect`, or answers nothing positive.
async function feedUsd(call, feed, expect) {
  const d = decodeString(await call(feed, SEL.description));
  if (d.trim() !== expect) return null;
  const dec = Number(word0(await call(feed, SEL.decimals)));
  const w = words(await call(feed, SEL.latestRoundData));
  const answer = w.length >= 4 ? wordToBig(w[1]) : 0n;
  const value = answer > 0n && Number.isInteger(dec) ? toFloat(answer, dec) : NaN;
  return isFinite(value) && value > 0 ? { value, updatedAt: Number(wordToBig(w[3])) } : null;
}

/// DOLLARS PER WHOLE UNIT OF `quote`: { per, src, updatedAt, failed }, with per
/// null when nothing answered. `failed` says WHY it is null: true when a read
/// threw (a refused or rate-limited call - worth asking again soon), false when
/// every read answered and there is simply no dollar price (no feed, or a feed
/// that does not name itself - asking again changes nothing). A caller that
/// keeps answers must not keep a failed one as if it were the second kind.
/// The asset's own Chainlink feed first (USD_FEEDS).
/// Where it has none, or its feed does not name itself, and the caller passed
/// `inEth` - one whole unit of the asset in WETH wei, or null (app.js
/// quoteAssetInEth, the v3 legs the ETH route trades through) - the asset is
/// priced in WETH that way and the WETH in dollars by ETH / USD. A page that
/// cannot price that leg passes none, and the asset then has no dollar figure:
/// the page shows its own units rather than a guess.
///
/// ON ANY CHAIN THAT ANSWERS FOR THE FEED. It was Base and one fork's chain id
/// only, so a fork serving another id showed the pair's units (the owner's
/// report, on 84531); the description() check is what decides, not the id.
async function usdPerQuote({ call, quote, decimals, inEth }) {
  const key = String(quote || "").toLowerCase();
  let per = null;
  let src = "";
  let updatedAt = 0;
  let failed = false;
  const threw = () => { failed = true; return null; };
  try {
    const own = USD_FEEDS[key];
    const direct = own ? await feedUsd(call, own[0], own[1]).catch(threw) : null;
    if (direct) {
      per = direct.value;
      src = own[1] + " (Chainlink)";
      updatedAt = direct.updatedAt;
    } else if (key !== WETH && typeof inEth === "function") {
      const eth = await feedUsd(call, ...USD_FEEDS[WETH]).catch(threw);
      const wei = eth ? await Promise.resolve().then(() => inEth(quote, decimals)).catch(threw) : null;
      if (eth && wei) {
        per = toFloat(wei, 18) * eth.value;
        src = "its Uniswap v3 market in WETH, and ETH / USD (Chainlink)";
        updatedAt = eth.updatedAt;
        failed = false;
      }
    }
  } catch { per = null; failed = true; }
  return { per, src, updatedAt, failed: per === null && failed };
}

window.CurbPrices = { USD_FEEDS, WETH, feedUsd, usdPerQuote, toFloat };

})();
