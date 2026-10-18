// THE WHOLE FLOW, AGAINST A REAL CHAIN.
//
// create a launch -> trade the curve -> cross the threshold -> complete the
// move into the pool -> trade the pool -> read the lock and the burn.
//
// WHAT IS REAL AND WHAT IS NOT. Every number on this page is read from the
// chain, every button sends a transaction that is mined, and every result is
// taken from the receipt or from balances after it. Nothing is remembered
// between loads except the addresses in the form. The wallet is the only thing
// that can be simulated, and only when the test harness substitutes one.
//
// THE QUOTES ARE COMPUTED HERE, because nothing on-chain will do it. The curve
// has no preview function, so the arithmetic below mirrors PonsV2BondingCurve's
// and has to stay in step with it - test/e2e checks predicted against realised
// on a real trade rather than trusting that it does.
(function () {

const { T, encode, words, wordToAddress, wordToBig, wordToInt, utf8Hex } = window.CurbAbi;
const { keccak256 } = window.CurbKeccak;
// The send-path protections, shared with launch.html rather than rewritten.
const TX = window.CurbTx;
const PAGE_ID = TX.newPageId();
// Per page, not per module: two app tabs are two participants.
const sendLock = TX.makeSendLock();

// ---------------------------------------------------------------- constants
// Base mainnet, which is what the fork serves.
const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
const ROUTER = "0x6ff5693b99212da76ad316178a184ab56d299b43";
// v4-periphery's own Base fork test uses this StateView; it is how the pool's
// price and liquidity are read, and therefore how a pool swap is quoted.
const STATE_VIEW = "0xa3c0c9b65bad0b08107aa264b0f3db444b867a71";
/// Uniswap's own Quoter for v4 on Base, from their deployments page - the same
/// row that carries the PoolManager, StateView and Universal Router addresses
/// above and below this line, which is how it was checked.
const V4_QUOTER = "0x0d5e0f971ed27fbff6c2837bf31316121532048d";
// The singleton every v4 pool lives in. It is the emitter of the Swap event a
// trade is reported from, so a log from anywhere else is not this pool's.
const POOL_MANAGER = "0x498581ff718922c3f8e6a244956af099b2652b2b";
// THE ETH ROUTE. A graduated launch trades against a stock, and a person
// holds ETH, so the page routes: ETH -> WETH -> (USDC ->) the quote asset on
// Uniswap v3, then the quote asset -> token on our own v4 pool, in ONE router
// call. Whether the middle hop is there is discovered per asset and decided by
// the quoter, not assumed - see bestV3Leg(). Proved against the deployed
// router in test/fork/B20EthRoute.t.sol, one hop and two.
const WETH = "0x4200000000000000000000000000000000000006";

/// THE CURB ROUTER: an ETH buy on any curve in one transaction, and a curve sale
/// paid in ETH (src/curb/CurbRouter.sol). Stateless and ownerless, deployed with
/// CREATE2 through the deterministic proxy, so it sits at this address on Base
/// and on every fork of it - and its runtime code hashes to `codehash` on every
/// chain. THE ONLY PLACE THIS FILE NAMES EITHER: a router change updates these
/// two lines, script/DeployRouter.s.sol's EXPECTED_ROUTER and
/// EXPECTED_RUNTIME_CODEHASH, and docs.md, together.
///
/// NOTHING IS SENT TO IT unless eth_getCode at the address hashes to `codehash`
/// on the chain being read (routerReady): a call to an address with no code
/// SUCCEEDS, and ETH sent with it is gone. Otherwise the page uses the flows it
/// had before the router (a swap then the buy; approve, sell, unwrap).
const CURB_ROUTER = Object.freeze({
  address: "0xEa20C3266229a01cd0f45D9c7921a45d5b359561",
  codehash: "0x25814dde01efddddcc582ba476471c80ce6de85154d1ee6a357f28cb67b37c5e",
});
/// Uniswap's SwapRouter02 on Base, which the CURB router swaps through. Named
/// here only so the create form can refuse it as a launch's payee: a fee or a
/// refund paid to it is anybody's to sweep.
const SWAP_ROUTER02 = "0x2626664c2603336E57B271c5C0b26F421741e481";

/// THE AERODROME ROUTE (the owner's call, 18 October 2026): ETH -> the pair's
/// asset on Aerodrome Slipstream's "Gauges V3" factory, where the tokenized
/// stocks' deep pools are, then the curve bought with exactly what arrived - two
/// sends and no contract of ours. Taken where it beats the CURB router's
/// one-send route by AERO_MARGIN_BPS and AERO_MIN_GAIN_WEI, where Uniswap cannot
/// fill the amount, or where the CURB router cannot be used and it is not worse
/// (preferAerodrome).
///
/// NOTHING IS SENT TO THE ROUTER unless eth_getCode at its address hashes to
/// `codehash`, asked again right before the send (aeroStillThere); its factory
/// and WETH are immutables, so the hash pins them too, and the factory has no
/// upgrade path. NO QUOTE IS TAKEN from a quoter whose code hashes to anything
/// but its own. A buy sends ETH as value and approves NOTHING to the router; the
/// one allowance it is ever given is a sell-back's, for exactly the amount sold
/// - and it pulls only from the caller, inside the caller's own swap. Every path
/// is a row of AERO_PATHS. THE ONLY PLACES THESE ARE NAMED: here, docs.md's
/// "Aerodrome route" and e2e/aero.spec.js, changed together.
/// Source: aerodrome-finance/slipstream README, "Gauges V3 Deployment".
const AERODROME = Object.freeze({
  factory: "0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef",
  router: Object.freeze({ address: "0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F",
    codehash: "0xfedc4e21e1097b0ec1b4f1aa901cf645c22f9e5d297727b0f37275ee1d083df4" }),
  quoter: Object.freeze({ address: "0x514c8B5f54112481E28028F1166Bd78501089259",
    codehash: "0x4c4c43e0024343e65597f0f0a1b829aaf69e5a6c0a0148fb63d28ff5730be551" }),
});
/// HOW MUCH BETTER AERODROME MUST BE, with the CURB router usable: 50 bps of
/// what arrives (quote drift and a fee that moves, plus the cost of selling
/// back) AND 0.0005 ETH of value (the price of two more confirmations).
const AERO_MARGIN_BPS = 50n;
const AERO_MIN_GAIN_WEI = 5n * 10n ** 14n;        // 0.0005 ETH
/// THE GAS A TWO-STEP BUY'S LATER SENDS ARE KEPT ETH FOR: step 1 (~0.49M
/// measured) + approve + buy, with room - and never less than token.js's
/// GAS_KEEP.
const TWO_STEP_GAS = 1_200_000n;
const TWO_STEP_ETH_KEEP = 3n * 10n ** 14n;        // 0.0003 ETH
/// THE PRICE BOUNDS A v3-STYLE POOL STOPS AT. A quote whose price ended within
/// one of them ran the pool out before the input was used: a partial fill,
/// priced by both quoters as if it were complete.
const MIN_SQRT_RATIO = 4295128739n;
const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;
/// THE PAIRS THE AERODROME ROUTE MAY TAKE, and the only paths it may take on
/// each - every hop on the Gauges V3 factory, by tick spacing. Keyed by the
/// factory's quoteToken(), lower case. Frozen at every level.
const AERO_PATHS = (() => {
  const A = {
    cbxrp: "0xcb585250f852c6c6bf90434ab21a00f02833a4af", cbzec: "0xb2000000000000000000008501b13360000cb2ec",
    googlc: "0xb2000000000000000000002d0ba3164cc74f58b7", nvdac: "0xb20000000000000000000078ee7ce2fe4908108c",
    spcxc: "0xb2000000000000000000007b9fcbd005511acbd5", amznc: "0xb200000000000000000000d9192b6b456483c2e8",
    msftc: "0xb200000000000000000000ab99cfa739e253872b", aaplc: "0xb200000000000000000000c2e324d24d7eecd1fb",
    metac: "0xb2000000000000000000008bc8786b856e61707c",
  };
  // USDC'S ADDRESS WRITTEN OUT: its constant is declared further down, after
  // this table is built.
  const weth = WETH.toLowerCase();
  const usdc = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const hop = (from, ts, to) => Object.freeze({ from, to, ts });
  const path = (...hops) => Object.freeze(hops);
  const rows = (...paths) => Object.freeze(paths);
  const viaUsdc = (a, ts2) => [path(hop(weth, 50, usdc), hop(usdc, ts2, a)), path(hop(weth, 1, usdc), hop(usdc, ts2, a))];
  return Object.freeze({
    [A.cbxrp]: rows(path(hop(weth, 100, A.cbxrp))), [A.cbzec]: rows(...viaUsdc(A.cbzec, 200)),
    [A.googlc]: rows(...viaUsdc(A.googlc, 10), path(hop(weth, 50, A.googlc))),
    [A.nvdac]: rows(...viaUsdc(A.nvdac, 10), path(hop(weth, 50, A.nvdac))),
    [A.spcxc]: rows(...viaUsdc(A.spcxc, 10)), [A.amznc]: rows(...viaUsdc(A.amznc, 10)),
    [A.msftc]: rows(...viaUsdc(A.msftc, 10)), [A.aaplc]: rows(...viaUsdc(A.aaplc, 10)),
    [A.metac]: rows(...viaUsdc(A.metac, 10)),
  });
})();
const aeroRows = (quote) => AERO_PATHS[String(quote || "").toLowerCase()] || null;

/// BUMPED WHENEVER A FILE IN web/assets CHANGES.
///
/// The marks were white on a dark tile and are now the companies' own colours
/// on a white one. A browser holding the old files draws white on white and
/// every logo disappears, with no error and nothing to search for. A version
/// in the URL is the only thing that makes a changed file a different file.
/// browse.js draws the same badges without loading this file, and keeps a copy
/// of assetLogo and of this version: bump both.
const ASSET_VERSION = "4";

/// ASSETS WHOSE ARTWORK IS NOT AN SVG.
///
/// Everything else is a vector from a brand icon set. These two are not in any
/// of them, so the file is the mark each project serves from its own site -
/// which is the most authoritative source there is for what a logo looks like,
/// and a raster at 48 and 180 pixels against a tile drawn at 28.
const ASSET_FILE = { cbhype: "cbhype.png", cbmega: "cbmega.png" };
/// A QUOTE ASSET'S LOGO FILE, by its TRUE symbol - weth.svg for the pair shown
/// as ETH, because WETH is what the contract is - or "" for none. A page that
/// shows it removes the image when it fails to load (the picker, the swap card).
function assetLogo(sym) {
  const slug = (sym || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return slug ? "assets/" + (ASSET_FILE[slug] || slug + ".svg") + "?v=" + ASSET_VERSION : "";
}
/// THE MIDDLE OF THE TWO-HOP ROUTE. Every B20 equity measured has its deepest
/// pool against USDC, not WETH - MULTI_RWA.txt 2.2 - so this is the leg that
/// makes ETH entry possible for anything but NVDAc. AND A PAIR OF ITS OWN since
/// 2026-10-15, where it is the end of a one-hop route and never a middle
/// (routesThroughUsdc).
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
/// Every tier a v3 pool can exist at. Which one to use is MEASURED, not
/// chosen: see v3Candidates() and bestV3Leg().
const V3_TIERS = [100, 500, 3000, 10000];
/// Base's PolicyRegistry precompile, which decides who a B20 policy admits.
const POLICY_REGISTRY = "0x8453000000000000000000000000000000000002";
// V3_FEE IS GONE. It was 3000 with the note "the only NVDAc/WETH fee tier on
// Base with liquidity at the pinned block" - true of NVDAc and of nothing else,
// which is exactly why ETH entry did not exist for any other asset. The tier is
// discovered per asset now, and chosen by the quoter; see bestV3Leg().
// Uniswap's QuoterV2. The v3 leg is priced by ASKING IT rather than by
// reimplementing tick math in this file - there is already one hand-written
// mirror of somebody else's arithmetic here (the curve) and it is kept honest
// only by a test that compares it to the wei.
const QUOTER_V2 = "0x3d4e44eb1374240ce5f1b871ab261cd16335b76a";
/// HOW LONG ANY QUOTE MAY TAKE. Shared by the v3 leg and the v4 one because
/// the reason is shared: both quoters SIMULATE, and a simulation against a
/// pool that cannot be priced does not come back.
const QUOTE_TIMEOUT_MS = 4000;
/// AND HOW MUCH WORK THE NODE MAY DO FOR ONE QuoterV2 QUOTE: 3,000,000 gas.
/// The page stops waiting after QUOTE_TIMEOUT_MS, but the node does not stop
/// simulating. A tier with almost nothing around its price - cbBTC/WETH at
/// 0.01%, tick spacing 1 - walks tick-bitmap words until the gas runs out, and
/// with the node's own cap that took longer than 20 seconds on a fork. Anvil
/// holds its state for the whole of it: nothing mined and no other read
/// answered meanwhile, so a curve sale for ETH on a cbBTC launch froze the
/// whole fork (review, round 2). Capped, that path reverts in about 0.1 s and
/// counts as unquotable. The heaviest real quote measured, a whole cbBTC through
/// the 1% tier, reported 0.53M gas, so the cap leaves room several times over.
const QUOTE_GAS = "0x2dc6c0";
// Uniswap v3's factory, used for ONE thing: finding the WETH/NVDAc pool so its
// mid price can be read. The total-cost line below is a shortfall against mid,
// and a mid has to come from a price - asking the quoter for a tiny trade
// would answer with a price that already has the LP fee in it.
const V3_FACTORY = "0x33128a8fc17869897dce68ed026d694621f6fdfd";

// UniversalRouter commands, and the magic amounts its v4 actions understand.
const CMD = { v3SwapExactIn: "00", sweep: "04", wrapEth: "0b", unwrapWeth: "0c", v4Swap: "10" };
const ACT = { settle: "0b", swapExactInSingle: "06", take: "0e" };
// address(1) is the caller, address(2) is the router itself.
const MSG_SENDER = "0x0000000000000000000000000000000000000001";
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002";
// "spend my whole balance of it", and "spend the whole open delta".
const CONTRACT_BALANCE = 1n << 255n;
const OPEN_DELTA = 0n;

const Q96 = 1n << 96n;

/// Selectors are DERIVED, not pasted. A mistyped constant is a call to a
/// function that does not exist, and the revert says nothing about which one.
const sig = (s) => keccak256("0x" + utf8Hex(s)).slice(0, 10);
const topic = (s) => keccak256("0x" + utf8Hex(s));

const SEL = {
  // factory / registry / lens
  launch: sig(
    // SIX FIELDS AND NO SNAPSHOT. The fee policy used to be the second
    // argument here; it is built inside the factory now, because launch() is
    // open to anyone and a stranger must not be able to say who gets paid.
    // SEVEN FIELDS SINCE creatorWallet. The selector is the whole
    // signature, so leaving this at six made every launch revert.
    // EIGHT FIELDS SINCE devBuy. Read off the struct rather than
    // remembered - the seven-field version of this line shipped once and
    // reverted every launch.
    // TEN SINCE THE EXPECTED PLATFORM TERMS, which the factory compares against
    // its own before it writes anything permanent.
    // ELEVEN SINCE holderShareFactory: zero for a launch that keeps its creator
    // income, otherwise the distributor version the creator chose to share it
    // through. Last, because the struct is encoded by position.
    "launch((string,string,string,bytes32,address,uint16,uint256,address,uint16,address,address))"
  ),
  // HOLDER SHARING: the Graduator holds the switch, the catalog says which
  // distributor versions may be switched to.
  sharingCatalog: sig("sharingCatalog()"),
  catalogRecommended: sig("recommended()"),
  catalogIsApproved: sig("isApproved(address)"),
  distributorVersion: sig("VERSION()"),
  holderDistributorOf: sig("holderDistributorOf(address)"),
  currentPlatformPolicy: sig("currentPlatformPolicy()"),
  registry: sig("registry()"),
  launchOf: sig("launchOf(address)"),
  rescueCurveFees: sig("rescueCurveFees(address)"),
  // THE NOTE THAT STARTS THE RESCUE'S HOUR for anyone but the curve's two
  // payees, when it was made, and the hour itself (Graduator.RESCUE_DELAY).
  noteReady: sig("noteReady(address)"),
  readySince: sig("readySince(address)"),
  rescueDelay: sig("RESCUE_DELAY()"),
  isRegistered: sig("isRegistered(address)"),
  hasGraduated: sig("hasGraduated(address)"),
  readyToGraduate: sig("readyToGraduate()"),
  curveGraduated: sig("graduated()"),
  getReserves: sig("getReserves()"),
  // WHAT THE PROGRESS BAR IS MADE OF, asked of the curve rather than taken
  // from the lens, which is a link parameter (round 5, S05).
  realQuoteReserve: sig("realQuoteReserve()"),
  totalSupply: sig("totalSupply()"),
  // WETH9's wrap. A curve on the WETH pair pulls WETH with an approval and
  // takes no ETH, so ETH is wrapped first - as its own pinned, recorded send.
  wethDeposit: sig("deposit()"),
  // And its unwrap: what a curve pays back in WETH - a sale's proceeds, a
  // buy's refund - is turned into ether the same way (unwrapPaid).
  wethWithdraw: sig("withdraw(uint256)"),
  sweepFees: sig("sweepFees(uint256)"),
  creatorTaxBalance: sig("creatorTaxBalance()"),
  quoteFeeBalance: sig("quoteFeeBalance()"),
  curveDeployer: sig("deployer()"),
  curveProtocolRecipient: sig("protocolFeeRecipient()"),
  graduationThreshold: sig("graduationThreshold()"),
  factorySupply: sig("supply()"),
  // THE LARGEST FIRST BUY, as a share of the threshold. Public on the factory,
  // so the form reads it instead of keeping a second copy - see AUDIT A-2.
  maxDevBuyBps: sig("MAX_DEV_BUY_BPS()"),
  // THE CURVE'S STARTING QUOTE RESERVE. A new curve holds the whole supply
  // against this and nothing else, so it is what prices a first buy.
  phantomQuote: sig("phantomQuote()"),
  // The hook's own WETH constant. Present only on a hook that unwraps.
  hookWeth: sig("WETH()"),
  launcherCount: sig("launcherCount()"),
  launcherAt: sig("launcherAt(uint256)"),
  quoteToken: sig("quoteToken()"),
  requiredHook: sig("requiredHook()"),
  launchState: sig("launchState(address)"),
  graduate: sig("graduate(address)"),
  graduator: sig("graduator()"),
  // curve
  buy: sig("buy(uint256,uint256,address)"),
  sell: sig("sell(uint256,uint256,address)"),
  feeBps: sig("feeBps()"),
  creatorTaxBps: sig("creatorTaxBps()"),
  sellableTokens: sig("sellableTokens()"),
  // erc20
  balanceOf: sig("balanceOf(address)"),
  allowance: sig("allowance(address,address)"),
  approve: sig("approve(address,uint256)"),
  decimals: sig("decimals()"),
  symbol: sig("symbol()"),
  // For the paired-asset cards' second line. Added with them - the card code
  // referenced SEL.name before it existed, and the try/catch around the read
  // would have swallowed that into "every card has no name".
  name: sig("name()"),
  // THE ISSUER'S POLICY, asked before a trade rather than discovered by one.
  // C1 established that B20 answers these: the asset names a scope, the scope
  // maps to a policy id, and the PolicyRegistry precompile says whether an
  // address is authorized under it.
  transferSenderPolicy: sig("TRANSFER_SENDER_POLICY()"),
  transferReceiverPolicy: sig("TRANSFER_RECEIVER_POLICY()"),
  transferExecutorPolicy: sig("TRANSFER_EXECUTOR_POLICY()"),
  policyId: sig("policyId(bytes32)"),
  isAuthorized: sig("isAuthorized(uint64,address)"),
  isBlacklisted: sig("isBlacklisted(address)"),
  // permit2 / router
  permit2Approve: sig("approve(address,address,uint160,uint48)"),
  execute: sig("execute(bytes,bytes[],uint256)"),
  // state view
  getSlot0: sig("getSlot0(bytes32)"),
  v3GetPool: sig("getPool(address,address,uint24)"),
  v3Slot0: sig("slot0()"),
  quoteExactInputSingleV3: sig("quoteExactInputSingle((address,address,uint256,uint24,uint160))"),
  /// The MULTI-HOP quoter. It takes a packed path and so covers one hop as
  /// well as two, which is why the single-hop one above is no longer called.
  lockOf: sig("lockOf(address)"),
  burnedOf: sig("burnedOf(address)"),
  lockTokenId: sig("tokenId()"),
  lockedLiquidity: sig("lockedLiquidity()"),
  quoteExactInputV3: sig("quoteExactInput(bytes,uint256)"),
  quoteExactOutputV3: sig("quoteExactOutput(bytes,uint256)"),
  quoteExactInputSingleV4:
    sig("quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))"),
  getLiquidity: sig("getLiquidity(bytes32)"),
  // lock
  lockBeneficiary: sig("beneficiary()"),
  holdsPosition: sig("holdsPosition()"),
  // the pool's fee hook. taxOfId is a FLAT getter decoded by position:
  ///   [0] uint16 totalTaxBps   [1] bool quoteIsCurrency0   [2] address creator
  ///   [3] bool configured      [4] address platform         [5] uint16 platformBps
  /// Six words. FeeHook appends new fields at the end so these indices hold;
  /// a seventh goes at [6], never in between.
  taxOfId: sig("taxOfId(bytes32)"),
  // WHAT IS OWED, AND TAKING IT. The curve's fees sit IN THE CURVE until its
  // creator sweeps them (sweepFees) or the launch graduates, and only then
  // reach the factory's escrow; the hook keeps a leg it could not pay straight
  // out - and on a WETH pool, every leg - in its own ledger. Escrow and hook
  // release only on a claim.
  hookOwed: sig("owed(address,address)"),
  hookClaim: sig("claim(address)"),
  feeEscrow: sig("feeEscrow()"),
  escrowBalanceOf: sig("balanceOfToken(address,address)"),
  escrowClaim: sig("claimToken(address)"),
  // THE CURB ROUTER (CURB_ROUTER). Both signatures are ICurbRouter's.
  routerBuy: sig("buyWithEth(address,address,bytes,uint256,uint256,address,uint256)"),
  routerSell: sig("sellForEth(address,address,uint256,uint256,bytes,uint256,address,uint256)"),
  // AERODROME'S SwapRouter (AERODROME.router). Each is a PUSH4 in its code.
  aeroMulticall: sig("multicall(bytes[])"),
  aeroExactInput: sig("exactInput((bytes,address,uint256,uint256,uint256))"),
  refundEth: sig("refundETH()"),
  unwrapWeth9: sig("unwrapWETH9(uint256,address)"),
};

const TOPIC = {
  graduated: topic("Graduated(address,address,uint256,uint160,uint128)"),
  burned: topic("RemainderBurned(address,uint256)"),
  launchCreated: topic("LaunchCreated(address,address,address,uint256,uint16)"),
  // What a trade DID, as the contracts themselves recorded it.
  transfer: topic("Transfer(address,address,uint256)"),
  swap: topic("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"),
  curveBuy: topic("CurveBuy(address,address,uint256,uint256,uint256,uint256)"),
  curveSell: topic("CurveSell(address,address,uint256,uint256,uint256,uint256)"),
  curveRefund: topic("CurveBuyRefunded(address,uint256)"),
  // WETH9's own event for turning WETH back into ETH. It is the only
  // transaction-specific record of an ETH payout there is: ETH moves without a
  // Transfer, so a balance is otherwise the only thing to look at, and a
  // balance is not a statement about one transaction.
  wethWithdrawal: topic("Withdrawal(address,uint256)"),
  // AND ITS WRAP: what Aerodrome's router wrapped of a buy's ETH, so what it
  // refunded is the rest.
  wethDeposit: topic("Deposit(address,uint256)"),
  // THE CURB ROUTER'S OWN ACCOUNT OF A TRADE: what was paid, what arrived, what
  // came back. A router trade is reported from these and nothing else.
  routerBought: topic("BoughtWithEth(address,address,address,address,uint256,uint256,uint256,uint256,uint256)"),
  routerSold: topic("SoldForEth(address,address,address,address,uint256,uint256,uint256,bool)"),
};

const STATUS = ["NotFound", "Selling", "Waiting", "Graduated"];

// NO LAUNCH PARAMETERS LIVE HERE. Supply, curve shape, lock, pool fee and
// tick spacing are terms the factory holds immutably and this page reads them
// from it. A CANDIDATE table used to sit here "to be shown beside the form";
// nothing showed it, and its pool fee and tick spacing (3000/60) had drifted
// from what ships (500/10).

/// The share in force for THIS factory, read with the rest of its context -
/// or NULL WHEN NOTHING HAS READ IT: no factory context yet, a factory that
/// could not be read, or a policy read that failed.
///
/// THERE IS NO FALLBACK NUMBER. A 0.5% stood in here for an unread share, and
/// every caller printed it as a fact - "platform 0.5% · you 1.5%" beside a hook
/// that might say 0.8%, and the tax band's "0.5% of it is the platform's"
/// before any factory was read (round 5, N29 / S23). A caller that gets null
/// says the share is unread; it has no number to print by mistake.
const platformShareBps = () => (ctx && ctx.platformKnown ? ctx.platformBps : null);
const TAX_MIN_BPS = 100n;
const TAX_MAX_BPS = 500n;

// ---------------------------------------------------------------- plumbing
const $ = (id) => document.getElementById(id);
const isAddr = (s) => /^0x[0-9a-fA-F]{40}$/.test((s || "").trim());
const same = (a, b) => (a || "").toLowerCase() === (b || "").toLowerCase();
const pad32 = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let account = null;
let chainCfg = { rpc: "", factory: "", lens: "", token: "" };
/// The chain the endpoint said it serves, once asked (warnAboutWhere): an
/// explorer link is drawn only for Base itself.
let chainIdShown = null;
let cache = {};   // addresses read from the factory, per factory address
let busy = false;

const STORE = "curb.app.v1";

/// THE BUILT-IN DEPLOYMENT (web/config.js), as the site bar read it: the
/// endpoint and lens a visit with no link and nothing saved reads, the
/// factories this product publishes (CANONICAL) and the factories the site no
/// longer offers (fillQuotePicker). Without the bar - a page with no #siteBar -
/// a local node and no lens, as before config.js.
const SITE = window.CurbBar && window.CurbBar.site ? window.CurbBar.site()
  : { chainId: 8453, rpc: "", registry: "", defaultRpc: "http://127.0.0.1:8546", defaultLens: "", factories: [],
      hiddenFactories: [] };
const DEFAULT_RPC = SITE.defaultRpc;
const DEFAULT_LENS = isAddr(SITE.defaultLens) ? SITE.defaultLens : "";
/// Whether an endpoint and a lens are exactly the built-in pair (only a
/// config.js that names a lens has one).
const isDefaultPair = (rpc, lens) =>
  !!DEFAULT_LENS && String(rpc || "").trim() === DEFAULT_RPC && same(String(lens || "").trim(), DEFAULT_LENS);
/// THE PRODUCTION SITE: config.js names a lens. There the endpoint and the
/// contracts are config.js's alone, so app.html neither shows nor edits them
/// (initFeesPanel) - whatever a link names - and the create form starts empty
/// (init). Without a lens - a fork, the browser tests - the page is as it was.
const PRODUCTION = !!DEFAULT_LENS;
/// A factory the site no longer offers (config.js hiddenFactories).
const factoryHidden = (f) => !!(window.CurbBar && window.CurbBar.incident && window.CurbBar.incident.factoryHidden(f));

/// THIS URL'S QUERY, WITH A RESTATED BUILT-IN PAIR TAKEN OUT. A link whose
/// ?rpc=&lens= are exactly config.js's, opened where nothing else is saved,
/// names nothing a plain URL would not read - the site bar carries no such
/// pair (topbar.js withConfig), and reading it as a link would open the
/// settings panel and warn about the site's own deployment. With another pair
/// saved it stays: it names the built-in pair over that one.
function siteQuery() {
  const q = new URLSearchParams(location.search);
  if (!isDefaultPair(q.get("rpc"), q.get("lens"))) return q;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE) || "{}") || {}; } catch { saved = {}; }
  const savedOther = (saved.rpc && String(saved.rpc).trim() !== DEFAULT_RPC) ||
    (saved.lens && !same(String(saved.lens).trim(), DEFAULT_LENS));
  if (savedOther) return q;
  q.delete("rpc");
  q.delete("lens");
  return q;
}

/// A LAUNCH'S OWN PAGE, token/0x…, relative to the site's root (app.html sits
/// there, and on a token's page the <base> is the root). The bar's pair rides
/// along when the page was opened with one; a launch made at another
/// deployment than the one on screen gets that deployment's endpoint and lens.
function tokenPageHref(token, where) {
  const path = "token/" + token;
  if (where && where.rpc && isAddr(where.lens) && (where.rpc !== chainCfg.rpc || !same(where.lens, chainCfg.lens))) {
    return path + "?" + new URLSearchParams({ rpc: where.rpc, lens: where.lens }).toString();
  }
  return window.CurbBar ? window.CurbBar.withConfig(path) : path;
}

/// Two values of one field are the same value: an endpoint exactly, an address
/// in any case.
const sameField = (k, a, b) =>
  k === "rpc" ? String(a || "").trim() === String(b || "").trim() : same(String(a || "").trim(), String(b || "").trim());

/// WHAT A LINK PUT IN THE FORM THAT THIS BROWSER HAD NOT SAVED - rpc, lens,
/// factory - as loadCfg() found it. See saveCfg().
let linkValues = {};
/// The fields the person set on this visit: typed into, or (the factory) picked
/// from a list that no link supplied. See saveCfg().
let edited = {};
/// Whether the asset picker's list was read through something only a link
/// named. A pick from it is then the link's choice as much as the person's.
let pickerFromLink = false;

/// A FIELD STILL HOLDING ONLY THE LINK'S VALUE: the link named it, it differs
/// from what was saved, and the person has not set it since.
const linkHeld = (k) =>
  linkValues[k] !== undefined && !edited[k] && sameField(k, chainCfg[k], linkValues[k]);

function saveCfg() {
  // WHETHER THE FACTORY WAS CHOSEN travels with it, so a pick made in one visit
  // is not undone by the automatic switch on the next.
  //
  // NOTHING A LINK NAMED IS SAVED UNLESS THE PERSON SET IT. A pick, a field
  // change or an adopted create used to save the whole form, the link's
  // endpoint and lens included, and the site bar reads that pair (topbar.js):
  // one stranger's link, then one click on an asset card, and every later
  // visit, every page's links and every search pointed at their endpoint and
  // registry (round 5, N13/N14). So, per field:
  //  - an endpoint or a lens that is still only the link's keeps the STORED one
  //    (typing into the field makes it the person's);
  //  - the factory and its chosen flag belong to the deployment they were read
  //    on: under a link's endpoint or lens they keep the stored ones, because a
  //    factory from a link's registry saved beside the person's own endpoint
  //    would be a stranger's contract on the person's chain, chosen;
  //  - a factory a link named keeps the stored one too, unless the person typed
  //    one, or picked one from a list no link supplied;
  //  - THE TOKEN IS SAVED AS IT STANDS. It is only which launch to show, read
  //    through whatever registry the page is on - on the person's own, a token
  //    of another deployment is refused as unknown, as a typed one is - and
  //    adoptCreated() counts a create as kept only once its address is here,
  //    so holding it back would leave every create made through a link
  //    unkept.
  // Read from storage NOW, not at load: another tab may have saved since.
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(STORE) || "{}") || {}; } catch { stored = {}; }
  const rpcHeld = linkHeld("rpc");
  const deploymentHeld = rpcHeld || linkHeld("lens");
  const factoryHeld = deploymentHeld || (linkValues.factory !== undefined && !edited.factory);
  const out = {
    rpc: rpcHeld ? stored.rpc : chainCfg.rpc,
    factory: factoryHeld ? stored.factory : chainCfg.factory,
    lens: linkHeld("lens") ? stored.lens : chainCfg.lens,
    token: chainCfg.token,
    chosen: factoryHeld ? stored.chosen === true : !!factoryChosen,
    // AND WHETHER THE SAVED ENDPOINT WAS ONLY A LINK'S - which, since the rule
    // above, only a record written before it can be. Read back on a later visit
    // as "saved", such an endpoint counted as chosen, and records were settled
    // through it (round 5, N50). loadCfg reads the flag back.
    rpcFromLink: rpcHeld ? stored.rpcFromLink === true : !!linkOnlyRpc && chainCfg.rpc === linkOnlyRpc,
  };
  // THE BUILT-IN PAIR (web/config.js) IS NOT SAVED unless the person typed it.
  // A visit that only read it keeps what was stored (nothing, or that same
  // pair), so it stays the site's to change: saved, the endpoint a visitor
  // happened to read on their first visit would outlive every later change of
  // it, and the site bar would carry it as a pair the person set.
  if (!rpcHeld && !linkHeld("lens") && !edited.rpc && !edited.lens && isDefaultPair(out.rpc, out.lens)) {
    out.rpc = stored.rpc;
    out.lens = stored.lens;
  }
  try { localStorage.setItem(STORE, JSON.stringify(out)); } catch {}
}
/// True when the link named a contract but not where to read it, so the
/// endpoint below came from the last session instead. See loadCfg().
let mixedEndpoint = false;

/// THE DEPLOYMENTS THIS PRODUCT CALLS ITS OWN, by chain id.
///
/// WRITTEN IN web/config.js, NOT HERE: its chainId, lens and factories are the
/// one record of the deployment, which the site bar and the settings loader
/// read too. Until deploy day fills them in there is no lens, so nothing is
/// entered and this page says nothing extra about a link - an empty table is
/// the honest state rather than an unfinished feature. A factory admitted
/// later is added to config.js's list in the same change, or every page on it
/// warns.
///
/// LOWERCASE, AND COMPARED THAT WAY. An address that differs only in case is
/// the same contract, and a warning that fired on capitalisation would be
/// worse than none.
const CANONICAL = {};
if (DEFAULT_LENS && Number.isSafeInteger(SITE.chainId)) {
  CANONICAL["0x" + SITE.chainId.toString(16)] = {
    lens: DEFAULT_LENS.toLowerCase(),
    registry: String(SITE.registry || "").toLowerCase(),
    factories: (SITE.factories || []).map((f) => String(f).toLowerCase()),
    // THE SITE'S OWN ENDPOINT. A page read through it needs no second source;
    // one read through any other has the contracts a send goes to read again
    // through the wallet (beginAction).
    rpc: String(SITE.rpc || "").trim(),
  };
}
/// The deployment this product publishes on a chain (hex id), or null.
/// sameChainId (below, with the pending records) compares them as numbers.
const canonicalOn = (chainId) => {
  for (const k of Object.keys(CANONICAL)) if (sameChainId(k, chainId)) return CANONICAL[k];
  return null;
};
/// THE ONE CHAIN A SEND MAY GO TO, as hex, once config.js names a deployment
/// (CANONICAL holds it); null while it names none - a fork, a test node, the
/// file before deploy day - when a send goes on the chain this page reads.
/// Every other chain is refused (chainVerdict), and the wallet is only ever
/// offered a switch to this one: holding the factory and the registry to
/// config.js (canonicalRefusal) can happen only on the chain config.js names,
/// and on any other a link's endpoint decides every contract a send reaches.
const NAMED_CHAIN = Object.keys(CANONICAL)[0] || null;

/// WHETHER A SEND MAY GO OUT FROM A WALLET ON `walletChain` WHILE THIS PAGE
/// READS `nodeChain` (both hex), or why not: { message, chainId }, chainId
/// being the one chain the wallet may be offered a switch to, or null when no
/// switch would help. One verdict for beginAction and for the wrong-network
/// line at connect (walletOffNetwork), so both say and offer the same thing.
function chainVerdict(walletChain, nodeChain) {
  if (NAMED_CHAIN && !sameChainId(walletChain, NAMED_CHAIN)) {
    return {
      chainId: NAMED_CHAIN,
      message: `Your wallet is on chain ${parseInt(walletChain, 16)}, and this site's deployment is on ` +
        `${chainName(NAMED_CHAIN)} (chain ${parseInt(NAMED_CHAIN, 16)}). Nothing is sent on any other chain: a ` +
        `contract at the same address there is not this site's, whatever a link's endpoint says.`,
    };
  }
  if (walletChain === nodeChain) return null;
  return {
    // A SWITCH TO THE ENDPOINT'S NETWORK, only while config.js names none:
    // with a deployment named the wallet is already on its chain here, and the
    // endpoint is the one that is elsewhere.
    chainId: NAMED_CHAIN ? null : nodeChain,
    message: `Your wallet is on chain ${parseInt(walletChain, 16)} and the RPC endpoint serves chain ` +
      `${parseInt(nodeChain, 16)}. Everything on this page was read from the RPC, so nothing is sent ` +
      `until they are the same network.` + (NAMED_CHAIN ? " This site's own endpoint reads its own chain: open " +
      "the page without the link's endpoint." : ""),
  };
}

/// WHY NOTHING IS SENT TO THIS FACTORY OR REGISTRY, or null when they are the
/// site's own.
///
/// A WARNING WAS NOT ENOUGH (Codex H-01, and the audit after it). The endpoint
/// a link names answers every read this page makes, including which registry a
/// factory reports and which curve that registry records - and every check
/// beginAction makes compares one of that endpoint's answers with another. A
/// proxy that forwarded everything to a real node and lied only about
/// factory.registry() had the genuine router take a buyer's ETH to a curve of
/// its choosing, on the genuine domain, with nothing on screen. So on the
/// chain config.js names, once it names a deployment, a send goes only to a
/// factory config.js lists, whose registry is the one config.js names. Asked on
/// every send, of the factory the send is pinned to - so a factory the picker,
/// a refresh or a link moved the form to is held to it too.
function canonicalRefusal(known, factory, registry) {
  if (!known) return null;
  const f = String(factory || "").toLowerCase();
  if (!(known.factories || []).includes(f)) {
    return "The factory " + factory + " is not one this site publishes for this chain, so nothing is sent to it " +
      "or through it. Pick the asset again, or open the launch from this site's own pages.";
  }
  if (!known.registry || String(registry || "").toLowerCase() !== known.registry) {
    return "The endpoint this page reads says this factory's registry is " + registry + ", which is not the registry " +
      "this site publishes" + (known.registry ? " (" + known.registry + ")" : "") + ". Nothing is sent - the endpoint " +
      "in this link is not telling the truth about the chain, or this site's settings are incomplete.";
  }
  return null;
}

/// WHY NOTHING IS SENT FROM A PAGE READ THROUGH `rpc` ON THE CHAIN config.js
/// NAMES, or null: only config.js's own endpoint (known.rpc) sends there.
///
/// REFUSED, NOT CROSS-CHECKED. Through any other endpoint this page used to ask
/// the wallet's own network again for the facts it had listed - the factory's
/// asset, the registry's record, the escrows, the router's code - and sent
/// when they agreed. What it had not listed stayed the endpoint's word: the
/// quoter's answers (which fee tier an ETH leg takes, and so its minimum), the
/// price feeds, the curve's reserves, and even whether the router has code,
/// which decides the route. An endpoint seeding an unused fee tier of a thin
/// asset at an absurd price then had the page build a swap through it with a
/// minimum it chose. Moving every send-time read to the wallet would need every
/// one of them found, now and in every later change; refusing the send needs
/// one check, and reading through a link's endpoint stays open. A person who
/// wants to send opens the page through the site's own endpoint.
function endpointRefusal(known, rpc) {
  if (!known) return null;
  const r = String(rpc || "").trim();
  if (known.rpc && r === known.rpc) return null;
  return "This page reads the chain through " + endpointHost(r) + ", not through this site's own endpoint, so " +
    "nothing is sent from it: the minimum, the route and the contract a send goes to would all be that " +
    "endpoint's word. Open the page without the link's endpoint (this site's own address alone) to send.";
}
/// An endpoint as a person reads it: its host, without the path a key sits in.
function endpointHost(url) {
  try { return new URL(String(url || "")).host || String(url || ""); } catch { return String(url || ""); }
}

/// SAYS SO IF THESE ARE NOT THE CONTRACTS THIS PRODUCT PUBLISHES.
///
/// @dev ASKED ONCE, AT INIT: a page cannot change chains without a reload, and
///      a warning about where it is pointed should not flicker with a quote.
///      A chain with no canonical deployment recorded adds nothing - there is
///      nothing to be wrong about, and the factory and lens are named in the
///      fields at the top of the page.
///
///      A FUNCTION RATHER THAN A LINE INSIDE init(), so a test can put a
///      deployment in the table and watch this fire. A check whose table is
///      empty in every test is a check nobody has ever seen work.
async function warnAboutWhere() {
  let id;
  try { id = await rpc("eth_chainId", []); }
  catch { return; }   // an endpoint that will not say is refresh()'s problem
  chainIdShown = parseInt(id, 16);
  whereChain = id;
  recheckWhere();
}
/// The chain warnAboutWhere was told, as hex, or null before it answered.
let whereChain = null;
/// What init() found wrong with the link itself (a half link, a factory from
/// the last session), said before the complaint about the deployment.
let whereReasons = [];
/// THE COMPLAINT ASKED AGAIN WHENEVER THE FACTORY MAY HAVE MOVED - a pick, the
/// automatic switch, a refresh that found a launch's own factory - not only at
/// init: a factory the page moved to afterwards was never compared with
/// config.js. The chain is still the one asked at init.
function recheckWhere() {
  const el = $("linkWarn");
  if (!el) return;
  const all = whereReasons.slice();
  const complaint = whereChain === null ? null : canonicalComplaint(whereChain);
  if (complaint) all.push(complaint);
  el.hidden = !all.length;
  el.textContent = all.join(" ");
}

/// WHAT IS WRONG WITH WHERE THIS PAGE IS POINTED, if anything.
///
/// null when the chain has no canonical deployment recorded: there is nothing
/// to be right or wrong about, and the page already names what it is reading.
function canonicalComplaint(chainId) {
  const known = CANONICAL[String(chainId || "").toLowerCase()];
  if (!known) return null;
  const lens = (chainCfg.lens || "").toLowerCase();
  const factory = (chainCfg.factory || "").toLowerCase();
  const lensOk = !lens || lens === String(known.lens || "").toLowerCase();
  const factoryOk = !factory
    || (known.factories || []).some((f) => String(f).toLowerCase() === factory);
  if (lensOk && factoryOk) return null;
  return "THIS IS NOT THE DEPLOYMENT THIS PRODUCT PUBLISHES. " +
    "The " + (lensOk ? "factory" : "lens") + " in this link is not one of the addresses recorded for " +
    "this chain, so every number on this page is about somebody else's contracts. That may be exactly " +
    "what you meant - a fork, a second deployment, a review - and it is worth being sure it is.";
}
/// WHICH HALF THE LINK GAVE, so the warning can say which one is missing. A
/// module-level record rather than a reach back into loadCfg's own URL object,
/// which is not in scope where the message is written.
let linkGaveEndpoint = false;
/// True when the link named a lens but no factory and no launch, so the factory
/// in the form is the last session's. See loadCfg().
let factoryFromStorage = false;
/// THE ENDPOINT ONLY A LINK BROUGHT - on this visit, when this browser had not
/// saved it before, or on an earlier one whose save (by an earlier version of
/// this page, which saved a link's endpoint) marked it so; null once
/// the person types into the RPC field. See loadCfg() and saveCfg().
let linkOnlyRpc = null;
/// Whether the link named a factory. A create form nobody pointed at an asset
/// starts on the WETH pair (fillQuotePicker); one a link pointed at stays there.
let linkNamedFactory = false;

/// A TOKEN'S OWN PAGE: /token/0x…, this file in its token view (app.html's
/// <head> sets the base and the class). The address in the path is read as a
/// link naming that launch, exactly as ?token= is.
const TOKEN_PATH = /\/token\/(0x[0-9a-fA-F]{40})\/?$/.exec(location.pathname);
const TOKEN_VIEW = !!TOKEN_PATH;

function loadCfg() {
  const q = siteQuery();
  if (TOKEN_PATH && !q.get("token")) q.set("token", TOKEN_PATH[1]);
  linkNamedFactory = !!q.get("factory");
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE) || "{}"); } catch {}
  if (!saved || typeof saved !== "object") saved = {};
  // A SAVED FACTORY THE SITE NO LONGER OFFERS (config.js hiddenFactories) is
  // not put back in the form: the create form would launch on it with no
  // card to say so. A link that names one still opens it - a token's own
  // factory, for a holder selling out of a hidden launch.
  if (isAddr(saved.factory) && factoryHidden(saved.factory)) saved = { ...saved, factory: "", chosen: false };
  // A LINK TO A LAUNCH THAT NAMES ITS LENS AND NO FACTORY TAKES NO FACTORY
  // FROM STORAGE. refresh() resolves one from the lens's own registry and the
  // launch's curve. Filled from the last session instead, that resolution was
  // skipped: a stored factory of another deployment made the page say "this
  // factory's registry has no record of it", and a stored factory of the same
  // one, chosen back then, suppressed the move to the launch's own factory
  // (round 5, P-R25).
  const lensLinkToLaunch = !!(q.get("lens") && q.get("token") && !q.get("factory"));
  // LAST, THE BUILT-IN DEPLOYMENT (web/config.js): its endpoint, and its lens
  // beside that endpoint only - read on any other, a lens address is either
  // nothing or somebody else's contract. So a first visit with no link - a
  // token's page shared on X, the create form - reads the deployment with
  // nothing to type. The factory has no built-in value: the create form
  // starts on the WETH pair the lens's registry lists (fillQuotePicker), and
  // a token's page finds its launch's own (refresh, launchFactoryOf).
  for (const k of ["rpc", "factory", "lens", "token"]) {
    chainCfg[k] = q.get(k) || (k === "factory" && lensLinkToLaunch ? "" : saved[k]) ||
      (k === "rpc" ? DEFAULT_RPC : k === "lens" && String(chainCfg.rpc).trim() === DEFAULT_RPC ? DEFAULT_LENS : "");
    if ($(k)) $(k).value = chainCfg[k];
  }
  // WHAT THE LINK NAMED THAT THIS BROWSER HAD NOT SAVED. saveCfg() keeps these
  // out of storage until the person sets them (round 5, N13/N14).
  linkValues = {};
  edited = {};
  for (const k of ["rpc", "lens", "factory"]) {
    if (q.get(k) && !sameField(k, q.get(k), saved[k])) linkValues[k] = q.get(k);
  }
  // A LINK THAT ONLY RESTATES WHAT WAS SAVED NAMES NOTHING NEW. The site bar's
  // "+ Launch token" carries the saved pair to app.html#create-launch and
  // nothing else (topbar.js withConfig); read as a link, it raised "this link
  // named a lens but no factory" about the site's own button, and it dropped a
  // factory the person had chosen, so the automatic switch could move the
  // create form to another asset and the next save forgot the pick (round 5,
  // N51). The factory in storage was saved with that very pair: there are no
  // two places for it to have come from.
  const restatesSaved = !q.get("factory") && !q.get("token") && !!(q.get("rpc") || q.get("lens")) &&
    ["rpc", "lens"].every((k) => !q.get(k) || (saved[k] && sameField(k, q.get(k), saved[k])));
  // A LENS WITH NO FACTORY AND NO LAUNCH still reads its factory from the last
  // session, and init() says so: the two came from different places.
  factoryFromStorage = !restatesSaved &&
    !!(q.get("lens") && !q.get("factory") && !lensLinkToLaunch && chainCfg.factory);

  // A LINK THAT NAMES A CONTRACT BUT NOT AN ENDPOINT IS HALF A LINK.
  //
  // An address means nothing without the chain it is on: read on another node
  // it is either empty or somebody else's contract, and this page has no way
  // to tell those apart from the real one. It happens for a dull reason -
  // a URL with & in it, pasted into a shell that cuts it at the first & - and
  // it produced a page confidently reporting the wrong asset and no launch
  // fee. Recorded here and said out loud in refresh(), because silence is
  // what made it cost an evening.
  // BOTH DIRECTIONS. A link that names a contract but no endpoint reads it
  // wherever the last session pointed; a link that names an endpoint but no
  // contract reads whatever the last session chose, there. Either way the two
  // halves came from different places and nothing on screen said so.
  // A FACTORY RESTORED FROM A VISIT WHERE THE PERSON CHOSE IT is still chosen;
  // one a link names is not. NOR IS ONE KEPT UNDER A LINK THAT NAMES A LAUNCH
  // OR A LENS: the person followed a link to something, and a pick from an
  // earlier visit must not stop the page moving to that launch's own factory,
  // or have it call that factory "the one you chose". A LINK THAT RESTATES THE
  // SAVED PAIR is no such link (above): the pick stands.
  factoryChosen = !q.get("factory") && (!q.get("lens") || restatesSaved) && !q.get("token") &&
    saved.chosen === true && same(saved.factory, chainCfg.factory);

  const namesWhere = !!q.get("rpc");
  linkGaveEndpoint = namesWhere;
  // AN ENDPOINT ONLY A LINK NAMED is not one to settle records through: it is
  // compared with what this browser had saved BEFORE anything on this visit
  // wrote to storage - and a saved endpoint that was itself only a link's is
  // still only a link's, on this visit or with no link at all (round 5, N50;
  // recordTransports says why). saveCfg no longer saves a link's endpoint, so
  // only a record an earlier version wrote carries that mark (rpcFromLink); it
  // keeps the mark for as long as that endpoint stays saved.
  const savedFromLink = saved.rpcFromLink === true;
  if (namesWhere) linkOnlyRpc = q.get("rpc") !== saved.rpc || savedFromLink ? q.get("rpc") : null;
  else linkOnlyRpc = savedFromLink && chainCfg.rpc === saved.rpc ? chainCfg.rpc : null;
  const namesWhat = !!(q.get("factory") || q.get("lens"));
  // Half of a saved pair, restated, is not half a link: the other half is the
  // one saved with it.
  mixedEndpoint = !restatesSaved && ((namesWhat && !namesWhere) || (namesWhere && !namesWhat));
}

let rpcId = 0;
/// THE ENDPOINT IS AN ARGUMENT, not a global read at call time.
///
/// Everything used to go through chainCfg.rpc, which the user can edit while a
/// wallet dialog is open: the receipt would then be looked for on one endpoint
/// and the balances that judge the result read from another. An action pins its
/// endpoint at the start and every read it makes afterwards uses that one.
/// `signal` IS HOW A CALLER CANCELS, and only one caller needs to.
///
/// Racing a promise against a timer abandons the PROMISE; the request carries
/// on. A browser holds about six connections to one host, so a few abandoned
/// calls fill the pool and everything the page asks for afterwards waits
/// behind answers nobody will read - which looks like a frozen page rather
/// than a slow one, because nothing is in flight to see. See bestV3Leg.
async function rpcAt(url, method, params, signal) {
  // THE SITE'S OWN ENDPOINT IS ASKED ITS CHAIN ONCE A VISIT (multicall.js chainId).
  const M = window.CurbMulti;
  if (method === "eth_chainId" && !signal && M && M.chainId) return M.chainId(url, () => rpcSend(url, method, params));
  return rpcSend(url, method, params, signal);
}
/// The headers of a JSON-RPC POST to `url` (multicall.js headers): text/plain to
/// the site's own endpoints, so no CORS preflight is made first.
const rpcHeaders = (url) => (window.CurbMulti && window.CurbMulti.headers ? window.CurbMulti.headers(url)
  : { "content-type": "application/json" });
async function rpcSend(url, method, params, signal) {
  const res = await fetch(url, {
    method: "POST",
    headers: rpcHeaders(url),
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    signal,
  });
  // AN HTTP FAILURE IS THE ENDPOINT'S, WHATEVER ITS BODY SAYS. A gateway or a
  // rate limiter can answer 429 or 5xx with a JSON-RPC error body, and that
  // body used to be taken as the node's own answer - one saying "reverted" was
  // then read as "this contract has no such function" (round 5, N06). Thrown
  // unmarked, so nothing reads it as a statement about the contract.
  if (!res.ok) {
    let said = "";
    try { const b = await res.json(); said = b && b.error && b.error.message ? String(b.error.message) : ""; }
    catch { said = ""; }
    throw new Error("The endpoint answered HTTP " + res.status + (said ? " (" + said + ")" : "") + " rather than a result.");
  }
  const body = await res.json();
  if (body.error) {
    // THE NODE ANSWERED, AND THE ANSWER WAS AN ERROR - a revert, usually. Marked,
    // so a caller can tell "this contract has no such function" apart from "the
    // endpoint did not answer", which a fetch, an HTTP or a JSON failure means
    // instead.
    const err = new Error(body.error.message || JSON.stringify(body.error));
    err.fromNode = true;
    // AND WHICH ERROR. An endpoint answers a rate limit or its own failure in
    // this same shape, and that is not a statement about the contract.
    err.code = body.error.code;
    // AND WHAT A REVERT CARRIES, so a simulation can say which of the
    // contract's own refusals it met (revertSentence) rather than print hex.
    err.data = body.error.data;
    throw err;
  }
  // NEITHER A RESULT NOR AN ERROR IS NOT AN ANSWER. JSON-RPC carries exactly
  // one of the two; a body with neither - a proxy's `{}` - came back as
  // undefined, which words() reads as no words, and a factory term then read as
  // "this factory has no such function" and was cached as zero (round 5, N06).
  // A null result is an answer (a receipt not mined yet) and is returned.
  if (!body || typeof body !== "object" || !Object.prototype.hasOwnProperty.call(body, "result")) {
    throw new Error("The endpoint answered " + method + " with neither a result nor an error.");
  }
  return body.result;
}

/// WHETHER AN ERROR IS THE CONTRACT REFUSING, as opposed to the endpoint failing.
///
/// rpcAt marks what the node itself answered - and a node answers a rate limit
/// ("over rate limit", -32016) or its own trouble in that same shape, so being
/// from the node is not enough. Only an answer that IS a revert counts: code 3,
/// which carries revert data, or a message that says it reverted. Everything
/// that asks "does this contract refuse / lack this?" uses this one rule; a
/// dropped reply read as "absent" turned a launch fee into 0 and a dev buy
/// ceiling into 100% (round 5, N17).
const isRevert = (e) => !!(e && e.fromNode && (e.code === 3 || /revert/i.test(e.message || "")));

/// WHETHER AN ERROR MEANS "THIS CONTRACT HAS NO SUCH FUNCTION" - a revert that
/// carries nothing, which is what a contract built before a term existed
/// answers a call to it with. A revert that carries data is the contract
/// refusing for a reason of its own, and anything that is not a revert is the
/// endpoint's; neither says the function is absent. One rule for the page's
/// reads of a factory's terms and the create's fresh reads of the same terms,
/// so the screen and the send cannot disagree about which answer is "absent"
/// (round 5, N06).
const lacksFunction = (e) =>
  isRevert(e) && (e.data === undefined || e.data === null || e.data === "" || e.data === "0x");

// The unpinned pair, for rendering: what is on screen follows the form.
const rpc = (method, params, signal) => rpcAt(chainCfg.rpc, method, params, signal);
/// THE CHAIN AN ENDPOINT SERVES, asked once per endpoint; a failed ask is not
/// kept, so the next one asks again.
const chainIds = new Map();
function chainIdAt(url) {
  if (!chainIds.has(url)) {
    chainIds.set(url, rpcAt(url, "eth_chainId", []).catch((e) => { chainIds.delete(url); throw e; }));
  }
  return chainIds.get(url);
}
/// `gas`, when given, caps what the node may spend simulating the call (hex).
/// Only the quoter's calls pass one - see QUOTE_GAS.
const callBody = (to, data, gas) => (gas ? { to, data, gas } : { to, data });
/// A READ WITHOUT A GAS LIMIT OR AN ABORT, ON THE SITE'S OWN ENDPOINT, GOES
/// OUT WITH THE READS MADE AT THE SAME MOMENT (multicall.js), and a revert
/// among them comes back as rpcAt throws a revert the node answered.
const Multi = window.CurbMulti || null;
function gatheredRevert(data) {
  const err = new Error("execution reverted");
  err.fromNode = true;
  err.code = 3;
  err.data = data;
  return err;
}
const callAt = (url, to, data, signal, gas) => (!gas && !signal && Multi && Multi.on(url)
  ? Multi.call(url, to, data, () => rpcAt(url, "eth_call", [{ to, data }, "latest"])).then((r) => {
    if (r.ok) return r.data;
    throw gatheredRevert(r.data);
  })
  : rpcAt(url, "eth_call", [callBody(to, data, gas), "latest"], signal));
/// A DISPLAY READ AT `url`, which takes the answer multicall.js asked for it
/// a moment ago where there is one (warmed); an action's pinned reads go
/// through callAt itself and never do.
const displayAt = (url, to, data) => {
  const w = Multi && Multi.warmed ? Multi.warmed(url, to, data) : null;
  if (!w) return callAt(url, to, data);
  return w.then((r) => {
    if (r.ok) return r.data;
    throw gatheredRevert(r.data);
  }, () => callAt(url, to, data));
};
const call = (to, data, signal, gas) => (!gas && !signal ? displayAt(chainCfg.rpc, to, data)
  : callAt(chainCfg.rpc, to, data, signal, gas));

/// THE WALLET THE PERSON CHOSE in the site bar (topbar.js "the wallets"), or
/// null: never one they did not pick. window.ethereum only without the bar.
const injected = () => (window.CurbBar && window.CurbBar.wallet ? window.CurbBar.wallet() : window.ethereum) || null;
function wallet() {
  if (!injected()) throw new Error("No injected wallet. Reading works without one; sending does not.");
  return injected();
}

/// EVERY ACTION IS PINNED TO WHAT IT WAS BUILT AGAINST.
///
/// The first version sent through the wallet and then looked for the receipt on
/// whatever RPC the form held - two different networks, if they disagreed, and
/// no check that they did not. It also let the form move under a transaction in
/// flight, and kept the hash nowhere, so a reload lost it.
///
/// beginAction reads the identity once and REFUSES a mismatch up front; the
/// send re-reads chain and account immediately before dispatch, because
/// everything in between takes round trips a user can switch networks during.
async function beginAction(scope) {
  // NOTHING WARM STANDS IN FOR A READ FROM HERE ON (multicall.js forget): what
  // is drawn after an action is read after it.
  if (Multi && Multi.forget) Multi.forget();
  // THE SNAPSHOT IS TAKEN BEFORE THE FIRST await, AND NOTHING AFTER IT READS
  // THE FORM.
  //
  // The previous version asked the RPC for its chain id and only recorded which
  // endpoint that was several awaits later - so a form edited in between meant
  // one endpoint was VERIFIED and a different one was PINNED. There is nothing
  // asynchronous between these lines and the reads that follow them.
  const eth = injected();
  if (!eth) throw new Error("No injected wallet. Reading works without one; sending does not.");
  const pin = {
    eth, scope, from: account,
    rpc: chainCfg.rpc, lens: chainCfg.lens, token: chainCfg.token, factory: chainCfg.factory,
    call(to, data, signal, gas) { return callAt(this.rpc, to, data, signal, gas); },
    read(method, params) { return rpcAt(this.rpc, method, params); },
  };
  // AND WHAT WAS DRAWN WHEN THE BUTTON WAS PRESSED, in the same breath. The
  // pin above is the FORM, and the form moves before the screen does: a token
  // pasted into the field fires `change` on blur, before the click, and its
  // refresh is still out when the trade is built - so the pin named launch B
  // while the tax, the expected out and the minimum on screen were launch A's
  // (round 5, N05). Compared once the launch is read, below.
  const drawnView = view;
  const drawnFor = viewFor;
  // AND THE CURVE QUOTE THAT WAS ON SCREEN: the press sends another route only
  // where that needs no more confirmations and has no lower minimum.
  pin.drawn = curveDrawn;
  if (!pin.from) throw new Error("Connect a wallet first.");

  const walletChain = await eth.request({ method: "eth_chainId" });
  // ONCE config.js NAMES A DEPLOYMENT, ITS CHAIN AND NO OTHER (chainVerdict),
  // asked before the endpoint is: what the endpoint says it serves changes
  // nothing about where a send may go.
  //
  // THE RPC BOX IS NOT THE WALLET. Reads come from one and sends from the
  // other, so a page that never compares them can quote a price from one chain
  // and send a transaction to another. Asked of the PINNED endpoint, so what is
  // checked is what will be used.
  const nodeChain = NAMED_CHAIN && !sameChainId(walletChain, NAMED_CHAIN)
    ? null : await pin.read("eth_chainId", []);
  const off = chainVerdict(walletChain, nodeChain);
  if (off) {
    // CARRIES THE WAY OUT where there is one: guard() draws a button that asks
    // the wallet to move (switchWalletTo) - to config.js's chain once it names
    // a deployment, never to the endpoint's.
    throw Object.assign(new Error(off.message), off.chainId ? { switchTo: off.chainId } : {});
  }
  pin.chainId = walletChain;

  const accounts = await eth.request({ method: "eth_accounts" });
  const from = accounts && accounts[0];
  if (!from || !same(from, pin.from)) throw new Error("The wallet's account changed. Reconnect and try again.");

  // THE DEPLOYMENT, READ FROM THE PINNED FACTORY THROUGH THE PINNED ENDPOINT.
  //
  // These used to be copied out of `ctx` - a cache the rendering fills from
  // whatever the form last showed - so an action could be sent to one factory
  // while being built with another's hook or quote asset.
  if (!isAddr(pin.factory)) throw new Error("Enter a CurbLaunchFactory address.");
  pin.registry = oneAddress(await pin.call(pin.factory, SEL.registry), `The factory's registry()`);
  // ON THE CHAIN config.js NAMES, ONLY ITS FACTORIES AND ITS REGISTRY - asked of
  // the factory this send is pinned to, on every send (canonicalRefusal) - AND
  // ONLY THROUGH ITS OWN ENDPOINT (endpointRefusal): through any other, every
  // read a send is built from would be that endpoint's word. With a deployment
  // named, chainVerdict above has already refused every other chain; with none
  // named - a fork, a test node - the page sends on what it reads, as before.
  const known = canonicalOn(pin.chainId);
  const refusal = canonicalRefusal(known, pin.factory, pin.registry) || endpointRefusal(known, pin.rpc);
  if (refusal) throw new Error(refusal);
  pin.quote = oneAddress(await pin.call(pin.factory, SEL.quoteToken),
    `The factory's quoteToken()`);

  pin.hook = oneAddress(await pin.call(pin.registry, SEL.requiredHook),
    `The registry's requiredHook()`);
  // THE DECIMALS TOO: every amount a send carries is scaled by them, and an
  // endpoint that said 18 for an 8-decimal asset would have a typed 1 spend
  // ten billion of it.
  const decimals = words(await pin.call(pin.quote, SEL.decimals));
  if (!decimals.length) throw new Error(`The quote asset at ${pin.quote} did not answer decimals().`);
  pin.quoteDecimals = Number(wordToBig(decimals[0]));
  // THE NAME COMES FROM THE ASSET TOO. A page that reads the number from
  // one asset and prints another asset's ticker beside it is worse than a
  // page with no ticker at all.
  pin.quoteSym = await symbolOf(pin.quote, (to, data) => pin.call(to, data));

  // AND THE LAUNCH ITSELF, plus the graduator that ends it - from the pinned
  // lens, not from a value read once at load.
  if (scope === "trade") {
    if (!isAddr(pin.token) || !isAddr(pin.lens)) throw new Error("Enter a LaunchLens address and a launch token.");
    // THE GRADUATOR FROM THE FACTORY, NOT THE LENS. The lens is a link
    // parameter; the factory is the thing the page is pinned to.
    pin.graduator = oneAddress(await pin.call(pin.factory, SEL.graduator),
      `The factory's graduator()`);
    pin.view = await readLaunchWith(pin, pin.token);
    if (pin.view.status === 0) throw new Error("That token is not a registered launch on this deployment.");

    // THE CURVE THAT GETS AN APPROVAL IS THE ONE THE REGISTRY NAMES.
    //
    // It used to be whatever the lens said, and the lens comes from the link.
    // A link with the genuine factory - real asset, real ticker, real
    // threshold, everything a careful person checks - and a lens of somebody
    // else's naming their own contract as the curve would have had this page
    // ask for an approval to it. The registry was already read above, from the
    // factory; one more call asks it. A lens that merely CLAIMS the right
    // registry proves nothing, so the record itself is what is compared.
    // ASKED FIRST, because launchOf REVERTS for a token it does not know - so
    // the sentence below used to be unreachable and the user got a raw revert.
    const registered = words(await pin.call(pin.registry, SEL.isRegistered + pad32(pin.token)));
    if (!registered.length || wordToBig(registered[0]) === 0n) {
      throw new Error(
        "That token has no record in this factory's registry (" + pin.registry + "), whatever the lens says. " +
        "Nothing is sent for a launch the registry does not know."
      );
    }
    const rec = words(await pin.call(pin.registry, SEL.launchOf + pad32(pin.token)));
    if (rec.length < 8) throw new Error("The registry would not return this launch's record.");
    const recCurve = wordToAddress(rec[0]);
    const recQuote = wordToAddress(rec[1]);
    if (!same(recCurve, pin.view.curve)) {
      throw new Error(
        "The lens at " + pin.lens + " names " + pin.view.curve + " as this launch's curve; the registry names " +
        recCurve + ". Nothing is approved to a curve the registry does not name - check where this link came from."
      );
    }
    // AND THE LAUNCH IS PRICED IN THIS FACTORY'S ASSET. The factory pinned may
    // be one typed by hand, or one a link named for another launch - and then
    // every amount is scaled by the wrong decimals and the approval is for an
    // asset the curve never pulls.
    if (!same(recQuote, pin.quote)) {
      const theirs = await symbolOf(recQuote, (to, data) => pin.call(to, data)).catch(() => recQuote);
      throw new Error(
        "This launch is priced in " + theirs + ", and the factory on this page is for " + pin.quoteSym + ". " +
        "Nothing is sent: pick the " + theirs + " factory and try again."
      );
    }
    // AND IT WAS MADE BY THIS FACTORY, NOT MERELY BY ONE ON THE SAME ASSET.
    // The registry admits several factories per asset and its record names
    // none of them; the curve names the escrow its fees go to. A sweep, and
    // the claim after it, are about THAT escrow - and a page pinned to another
    // factory on the same asset told a creator to claim where nothing had
    // arrived (round 5, S53).
    const [curveEscrow, ourEscrow] = await Promise.all([
      pin.call(recCurve, SEL.feeEscrow).then((r) => oneAddress(r, "The curve's feeEscrow()")),
      pin.call(pin.factory, SEL.feeEscrow).then((r) => oneAddress(r, "The factory's feeEscrow()")),
    ]);
    if (!same(curveEscrow, ourEscrow)) {
      throw new Error(
        "This launch was made by another " + pin.quoteSym + " factory: its curve pays its fees into the escrow " +
        curveEscrow + ", and the factory on this page uses " + ourEscrow + ". Nothing is sent - open it " +
        "under its own factory."
      );
    }

    // THE POOL, AND THE STATUS, FROM THE CHAIN - NOT FROM THE LENS.
    //
    // The checks above closed the curve's approval. A pool trade still used
    // the lens's pool key as it came, so the same link could send a swap into
    // a pool with the right two currencies and somebody else's hook - one that
    // quotes honestly in simulation and pays out the bare minimum on chain -
    // and the lens's status decided which panel was offered at all. The record
    // holds the fee, the spacing and the hook; the currencies are the token and
    // its quote; the graduator and the curve say where the launch is. That key
    // is the one traded, and a lens that disagrees is refused, not corrected.
    const recFee = wordToBig(rec[5]);
    const recSpacing = wordToInt(rec[6], 24);
    const recHooks = wordToAddress(rec[7]);
    if (!same(recHooks, pin.hook)) {
      throw new Error(
        "This launch's record names the hook " + recHooks + ", not the registry's own " + pin.hook + ". " +
        "Nothing is sent."
      );
    }
    const tokenIsC0 = pin.token.toLowerCase() < recQuote.toLowerCase();
    const key = {
      currency0: tokenIsC0 ? pin.token : recQuote,
      currency1: tokenIsC0 ? recQuote : pin.token,
      fee: recFee,
      tickSpacing: recSpacing,
      hooks: recHooks,
    };
    const lk = pin.view.poolKey;
    const sameKey = same(lk.currency0, key.currency0) && same(lk.currency1, key.currency1) &&
      lk.fee === key.fee && lk.tickSpacing === key.tickSpacing && same(lk.hooks, key.hooks);
    if (!sameKey) {
      throw new Error(
        "The lens at " + pin.lens + " names a different pool for this launch than the registry records " +
        "(hook " + key.hooks + ", fee " + key.fee + ", spacing " + key.tickSpacing + "). Nothing is sent to a " +
        "pool the registry does not name - check where this link came from."
      );
    }
    pin.view.poolKey = key;
    // WHETHER IT SHARES, from the pinned Graduator, not the lens (see refresh).
    try {
      const w = words(await pin.call(pin.graduator, SEL.holderDistributorOf + pad32(pin.token)));
      pin.view.holderDistributor = w.length ? wordToAddress(w[0]) : null;
    } catch (e) {
      if (!lacksFunction(e)) throw e;
      pin.view.holderDistributor = null;
    }

    const chainStatus = await chainStatusOf((to, data) => pin.call(to, data), pin.graduator, pin.token, recCurve);
    if (chainStatus !== pin.view.status) {
      throw new Error(
        "The lens reports this launch as " + STATUS[pin.view.status] + "; the chain says " + STATUS[chainStatus] +
        ". Nothing is sent - refresh, and if it persists, check where this link came from."
      );
    }

    // THE LAUNCH SENT TO IS THE LAUNCH THAT WAS ON SCREEN. Everything a person
    // checks before pressing - the tax, what comes out, the minimum - was drawn
    // for `drawnFor`; a trade built for any other token, factory, lens or
    // endpoint, or against a curve other than the one in `view` - which a
    // newer read can have replaced while its quote is still being drawn - is
    // refused rather than sent on numbers nobody was shown. No launch drawn at
    // all is refused the same way. Checked last, after the refusals above that
    // say what is wrong with the launch itself.
    const sameAsDrawn = !!(drawnView && drawnFor) && same(drawnFor.token, pin.token) &&
      same(drawnFor.factory, pin.factory) && same(drawnFor.lens, pin.lens) && drawnFor.rpc === pin.rpc &&
      same(drawnView.curve, pin.view.curve);
    if (!sameAsDrawn) {
      throw new Error(
        "The launch on screen is not the one in the form: the page is still loading the launch you entered " +
        "(" + pin.token + "), or could not draw it, so the numbers shown are not its numbers. Nothing was sent - " +
        "wait for it to be drawn, check it, and press again."
      );
    }
  }
  return pin;
}

/// WHERE A LAUNCH IS, AS THE CHAIN SAYS IT: graduated first, because
/// readyToGraduate() answers false once a curve has graduated, then the curve.
/// The lens computes the same thing, and the lens is a link parameter, so both
/// beginAction and refresh() ask here and refuse a lens that disagrees.
///
/// THE LENS'S RULE, ALL OF IT: the graduator's flag OR the curve's own. Asking
/// only the graduator made a graduated launch read under a factory whose
/// graduator is another one "Selling" - and then refused, since the lens says
/// Graduated. AND AN ANSWER THAT IS MISSING IS NOT "NO": an empty reply used to
/// read as not graduated and not ready, which is Selling - a status drawn, with
/// a Buy button, from nothing (round 5, S05).
/// @return 1 Selling, 2 Waiting, 3 Graduated
async function chainStatusOf(callFn, graduator, token, curve) {
  const flag = async (to, data, what) => {
    const w = words(await callFn(to, data));
    if (!w.length) throw new Error(what + " answered nothing, so where this launch is cannot be told.");
    return wordToBig(w[0]) !== 0n;
  };
  // ASKED TOGETHER, ANSWERED IN THE SAME ORDER: a flag's failure counts only
  // where the one-by-one reading would have reached it.
  const got = await Promise.allSettled([
    flag(graduator, SEL.hasGraduated + pad32(token), "The graduator's hasGraduated()"),
    flag(curve, SEL.curveGraduated, "The curve's graduated()"),
    flag(curve, SEL.readyToGraduate, "The curve's readyToGraduate()"),
  ]);
  const at = (i) => { if (got[i].status === "rejected") throw got[i].reason; return got[i].value; };
  if (at(0)) return 3;
  if (at(1)) return 3;
  return at(2) ? 2 : 1;
}

/// Records this page is responsible for. Marked, because launch.html writes
/// into the same store and the two pages answer for different things.
const APP_MARK = "app";
/// THE RECORDS THIS PAGE IS STILL WAITING ON, by key. send() writes a record
/// and then waits for its receipt; resumePending runs after every action and can
/// overlap the next one, and it settled such a record from under its own send -
/// "An earlier transaction (claim your curve fees) succeeded" over the claim's
/// own result. launch.js keeps the same set (thisSession/settling).
const inFlight = new Set();
function outstandingFor(pin) {
  return TX.loadPendingAll().filter((t) => {
    if (t.chainId !== pin.chainId) return false;
    // A CREATE THE CHAIN HAS SETTLED IS NOT OUTSTANDING. `made` is the launch
    // its receipt names, written by adoptCreated when the page could not put
    // it in the form; the record stays only to carry that address, and a
    // second create is a second launch the person asks for, not a double send.
    if (t.made) return false;
    // A TWO-STEP BUY'S SWAP THE CHAIN HAS SETTLED IS NOT OUTSTANDING EITHER: its
    // `held` is what it delivered, kept so the page can offer Buy with it and
    // Sell it back. Until it is mined it blocks, so a second press cannot pay
    // for the swap twice.
    if (t.kind === "eth-swap" && t.held) return false;
    // LAUNCH.HTML'S OWN RECORDS carry no page mark. A graduation it sent for
    // THIS launch counts against a trade here: two pages must not both pay for
    // one move, and launch.js already counts app's records the other way.
    // FROM THIS ACCOUNT ONLY, as app's own records are: somebody else's pending
    // graduation is not this account paying twice, and it used to refuse every
    // account in the browser. launch.js names the sender `account`.
    // resumePending settles these for the launch on screen, so the refusal's
    // advice to press Refresh is true of them too.
    if (t.page !== APP_MARK) {
      return pin.scope === "trade" && !t.page && same(t.account, pin.from) &&
        same(t.lens, pin.lens) && same(t.token, pin.token);
    }
    if (!same(t.from, pin.from)) return false;
    // EACH SCOPE IS BLOCKED ONLY BY ITS OWN KIND. A claim is about a factory
    // and an account; a create (and the approval sent inside it) is about a
    // factory; a trade is about a launch. They used to block each other: a
    // slow create refused every trade on the factory, and an approval inside a
    // create - recorded against whatever launch was on screen - refused
    // trades of that unrelated launch.
    const createKind = t.kind === "create" || t.kind === "create-approve";
    if (pin.scope === "claim" || t.kind === "claim") {
      return pin.scope === "claim" && t.kind === "claim" && same(t.factory, pin.factory);
    }
    if (pin.scope === "create") return createKind && same(t.factory, pin.factory);
    return !createKind && same(t.lens, pin.lens) && same(t.token, pin.token);
  });
}

const lockNameFor = (pin) =>
  pin.scope === "create"
    ? `curb:app:create:${pin.chainId}:${(pin.factory || "").toLowerCase()}`
    : pin.scope === "claim"
      ? `curb:app:claim:${pin.chainId}:${(pin.factory || "").toLowerCase()}:${(pin.from || "").toLowerCase()}`
      // THE SAME NAME launch.html USES for a send about one launch, so the two
      // pages take one lock rather than one each.
      : `curb:send:${pin.chainId}:${(pin.lens || "").toLowerCase()}:${(pin.token || "").toLowerCase()}`;

/// THE SAME ORDER launch.html ARRIVED AT, AND FOR THE SAME REASONS.
///
/// lock, THEN read what is outstanding, then claim, then act, then release in a
/// finally. `busy` only ever guarded this one page: two app tabs, or a retry
/// after a receipt timed out, could both send the same thing. Checking the
/// records before taking the lock is worthless - another tab can finish and
/// write its hash in between - so the check happens holding it.
async function withSendLock(pin, fn) {
  const lockState = await sendLock.acquire(lockNameFor(pin));
  if (lockState === "taken") {
    throw new Error("Another tab is already sending for this launch. Finish or cancel it there.");
  }
  let claim = null;
  try {
    // EVERY OUTSTANDING RECORD IS JUDGED, not only the first: a two-step buy's
    // swap that the chain shows mined turns "held" here and refuses nothing,
    // and a press after it used to be refused by the record it had just become.
    for (const o of outstandingFor(pin)) {
      // SAY WHOSE IT IS AND WHAT CLEARS IT. The advice used to be "reload",
      // which did nothing for a record this page never settled.
      // JUDGED ON THE SPOT, so a record signed at a nonce this chain never
      // reaches (TX.judgePending "ahead") is said plainly, with its Forget
      // button, now - not as "not accounted for" until a Refresh. Words the
      // judging would say about a record it settled are not said here; the
      // refusal below stands for this press either way, as it always did.
      let why = null;
      try {
        const out = await settleRecord(TX.stampJudged(o), () => {});
        why = out && out.still ? out.still : null;
      } catch { why = null; }
      if (why && why.state === "held") continue;
      if (why && why.state === "ahead") {
        const line = stillLine(o, why);
        throw Object.assign(new Error(line.replace(/<[^>]*>/g, "")), { html: line });
      }
      const whose = o.page === APP_MARK ? "" : " (sent from launch.html, to complete the move to the pool)";
      // WHAT CLEARS IT, TRULY. The chain clears a record once it shows it mined
      // or replaced; a record it never will - its hash unknown, its nonce
      // unused an hour on, its chain uncertain - is ended only by hand, and the
      // Forget button is on the line Refresh draws for it (round 5, S16).
      throw new Error(
        `There is already a transaction for this that has not been accounted for: ${o.hash}${whose}. ` +
        `Sending another could pay for the same thing twice. This page clears it once the chain shows it ` +
        `was mined or replaced. If the chain cannot settle it, press Refresh: the line about it then says ` +
        `why, and offers to forget it where that is possible.`
      );
    }
    // The claim is keyed the same way the lock is: a create is about a factory,
    // a trade is about a token. Using whatever token happened to be in the form
    // would let two creates claim different keys and both proceed.
    const subject = pin.scope === "create" ? pin.factory
      : pin.scope === "claim" ? "claim:" + pin.factory + ":" + pin.from
      : pin.token;
    // AND WITHOUT THE LENS for a create or a claim, as the lock's name is. It
    // is the only guard in a browser with no Web Locks, and keyed with the
    // lens, a tab with the lens field empty and one with it filled claimed two
    // keys for one factory and both reached the wallet (round 5, N22).
    const claimLens = pin.scope === "trade" ? pin.lens : "";
    if (TX.preparingElsewhere(PAGE_ID, pin.chainId, claimLens, subject)) {
      throw new Error("Another tab is already preparing this. Finish or cancel it there.");
    }
    claim = TX.claimPreparation(PAGE_ID, pin.chainId, claimLens, subject);
    if (!claim) throw new Error("Another tab claimed this at the same moment. Finish or cancel it there.");

    if (lockState === "unsupported") {
      show("wait",
        "This browser has no Web Locks API, so a second tab is only discouraged here, not prevented — " +
        "do not send this from two tabs.");
    }
    return await fn();
  } finally {
    TX.releasePreparation(claim);
    sendLock.drop();
  }
}

/// SENT IS NOT DONE. Waits for the receipt through the SAME provider the
/// transaction went through, records the hash so a reload cannot lose it, and
/// reports the status from the receipt rather than from having sent.
/// @param keep  true to leave the pending record in place. A transaction whose
///              RESULT still has to be read and stored is not finished when the
///              receipt lands: clearing there loses the record in the window
///              between the receipt and the result being kept, and for a create
///              that window is where the token address is found.
/// @param extra  fields merged into the record before it is stored - a two-step
///               buy's swap ("eth-swap") carries what it is for.
async function send(pin, tx, what, kind, keep, extra) {
  const chainNow = await pin.eth.request({ method: "eth_chainId" });
  const accountsNow = await pin.eth.request({ method: "eth_accounts" });
  if (chainNow !== pin.chainId) throw new Error("The wallet changed networks while this was being prepared. Nothing was sent.");
  if (!accountsNow[0] || !same(accountsNow[0], pin.from)) {
    throw new Error("The wallet changed accounts while this was being prepared. Nothing was sent.");
  }
  if (chainCfg.rpc !== pin.rpc) throw new Error("The RPC endpoint changed while this was being prepared. Nothing was sent.");
  if (!same(chainCfg.factory, pin.factory)) {
    throw new Error("The factory on screen changed while this was being prepared. Nothing was sent.");
  }
  if (pin.scope === "trade" && (!same(chainCfg.token, pin.token) || !same(chainCfg.lens, pin.lens))) {
    throw new Error("The launch on screen changed while this was being prepared. Nothing was sent.");
  }

  // A BLOCK THIS TRANSACTION CANNOT BE MINED AT OR BEFORE. Read before the
  // wallet is asked, so anything it signs mines later - even on an endpoint
  // that lags, whose answer is only lower. A create replaced by a "speed up" is
  // looked for from here (TX.findReplacement); without it, the record says so
  // and is kept rather than searched from a guessed block.
  // THE NONCE IS NOT GUESSED HERE. It used to be this endpoint's "pending"
  // count, read before signing - but the wallet picks the nonce, and a guess
  // below the real one cleared a create that was still pending.
  let sentAfterBlock = null;
  try { sentAfterBlock = await pin.read("eth_blockNumber", []); } catch { sentAfterBlock = null; }

  // THE WALLET THIS WAS PINNED TO IS STILL THE ONE CHOSEN: one picked in the
  // bar since (here or in another tab) is not the one that was checked.
  if (injected() !== pin.eth) throw new Error("The wallet changed while this was being prepared. Nothing was sent.");
  show("wait", `Waiting for you to confirm: ${escapeHtml(what)}…`);

  // A REJECTION IS THE ONLY FAILURE AFTER THIS POINT THAT MEANS NOTHING WAS
  // SENT.
  //
  // Every other error here - a dropped connection, a provider that threw after
  // handing the transaction on - may have broadcast it anyway. Reporting those
  // as a plain failure invites the user to press the button again and pay for
  // the same thing twice, and this page had exactly one message for all of
  // them. EIP-1193 code 4001 is the user declining; it is the one case that can
  // be stated flatly.
  //
  // A NETWORK SWITCH INSIDE THE DIALOG is invisible to every check made before
  // it, so it is watched for the life of the request, as launch.html does. A
  // transaction signed across one may have gone to either chain; the record
  // says so (`uncertainChain`), and no nonce is taken from the wallet while it
  // is on another chain than the record's.
  let switchedDuringDialog = false;
  const onChainChanged = () => { switchedDuringDialog = true; };
  try { pin.eth.on && pin.eth.on("chainChanged", onChainChanged); } catch {}
  let hash;
  try {
    hash = await pin.eth.request({ method: "eth_sendTransaction", params: [{ ...tx, from: pin.from }] });
  } catch (e) {
    // THE CODE, AND ONLY THE CODE. An earlier version also accepted any error
    // whose TEXT said "user rejected" - and a provider that fails for its own
    // reasons can say that in a wrapped message while the transaction went out
    // anyway. Saying "nothing was sent" on the strength of a string is how a
    // user is invited to pay twice. EIP-1193 defines 4001 for this; anything
    // else is uncertain, including something that reads exactly like a refusal.
    if (e && e.code === 4001) {
      // MARKED, so a caller that goes on after a decline (unwrapPaid) can say
      // so in its own words rather than parse these.
      throw Object.assign(new Error(`Nothing was sent: you declined ${what} in the wallet. You can try again.`), { declined: true });
    }
    // MARKED TOO (`uncertain`), so a caller with something riding on this send
    // - a two-step buy's step 2, a sale back - does not call it "not made".
    throw Object.assign(new Error(
      `The wallet was asked to send ${what} and then failed: ${e && e.message ? e.message : String(e)}. ` +
      `IT IS NOT CERTAIN NOTHING WAS BROADCAST — check your wallet's activity before sending again, ` +
      `because a second attempt would pay for the same thing twice.`
    ), { uncertain: true });
  } finally {
    try { pin.eth.removeListener && pin.eth.removeListener("chainChanged", onChainChanged); } catch {}
  }

  // EVERY FIELD THE RECOVERY NEEDS. A record that only says "a transaction for
  // this token" cannot describe the one that CREATES the token, and that is the
  // transaction most worth not losing.
  // `sentAt` IS WHEN THE HASH CAME BACK, the only age a record has: a record
  // the chain cannot settle may be offered for forgetting an hour on
  // (TX.readVerdict, TX.mayForget).
  const record = {
    page: APP_MARK, kind: kind || "action", chainId: pin.chainId, rpc: pin.rpc,
    lens: pin.lens, token: pin.token, factory: pin.factory, from: pin.from,
    to: tx.to, hash, what, sentNonce: null, sentAfterBlock,
    uncertainChain: switchedDuringDialog, sentAt: Date.now(),
  };
  if (extra) Object.assign(record, extra);
  const flightKey = TX.keyOf(record);
  inFlight.add(flightKey);
  try {
  if (!TX.savePending(record)) {
    sticky =
      `This browser would not store <code>${escapeHtml(hash)}</code>, so it will be LOST if you reload. ` +
      `Copy that hash now.`;
    show("err", "The transaction was sent but could not be recorded.");
  } else {
    show("wait", `Sent <code>${escapeHtml(hash)}</code> — waiting for it to be mined…`);
  }

  // THE NONCE THE TRANSACTION CARRIES, read back by its hash - from the wallet
  // that broadcast it first, then the pinned endpoint. It is what lets a hash
  // the wallet replaced ("speed up", "cancel") be recognised later, when the
  // sender's nonce has moved past it. Stored AFTER the record, so a slow answer
  // cannot delay the one thing a reload needs; left null when nobody knows the
  // hash yet, and resumePending asks again.
  //
  // THE WALLET ONLY WHILE IT IS ON THE RECORD'S CHAIN, asked just before: a
  // nonce it reads by hash on another chain is that chain's, and stored here it
  // judged the record "pending" for as long as this chain's count stayed below
  // it - with no Forget, refusing every send of its scope (round 5, N03). The
  // pinned endpoint serves the record's chain (beginAction checked), so what it
  // knows is true of this chain whichever way the wallet went.
  //
  // A WALLET NEED NOT EMIT THE EVENT, so the chain it is on now counts too: one
  // that answers another chain after the dialog may have sent there. A read
  // that fails is evidence of nothing, and keeps the wallet out of the read.
  let chainAfter = null;
  try { chainAfter = await pin.eth.request({ method: "eth_chainId" }); } catch { chainAfter = null; }
  if (chainAfter !== null && chainAfter !== pin.chainId && !record.uncertainChain) {
    record.uncertainChain = true;
    TX.updatePending(record, { uncertainChain: true });
  }
  const walletHere = chainAfter === pin.chainId;
  record.sentNonce = await TX.nonceOfHash(hash, [
    ...(walletHere ? [(m, p) => pin.eth.request({ method: m, params: p })] : []),
    (m, p) => pin.read(m, p),
  ], pin.from);
  if (record.sentNonce !== null) TX.updatePending(record, { sentNonce: record.sentNonce });

  // A NONCE THIS CHAIN NEVER REACHES IS SAID NOW, not after a minute of waiting
  // and then as "a transaction not accounted for" on every later press. The
  // record stays - the transaction is real, and would mine if the gap ever
  // filled - with its Forget button on the line. Only on the record's own
  // chain: a send signed across a network switch is judged by its record.
  if (record.sentNonce !== null && !record.uncertainChain) {
    const gap = await nonceGap(pin, record.sentNonce, hash);
    if (gap !== null) {
      const n = parseInt(record.sentNonce, 16);
      const said = aheadWords(n, gap);
      throw Object.assign(new Error(`Sent ${hash}, but it will not be mined.` + said), {
        html: `Sent <code>${escapeHtml(hash)}</code>, but it will not be mined.` + escapeHtml(said) +
          ` <button type="button" class="ghost" data-forget="${escapeHtml(TX.keyOf(record))}">Forget this record</button>`,
      });
    }
  }

  // A WAIT THAT ENDS WITHOUT A RECEIPT - the minute up, the wallet on another
  // network - says nothing about the transaction: it was sent, its record
  // stays, and it may still be mined. Marked (`sent`), so a caller with
  // something riding on it says that rather than "not made".
  let receipt;
  try {
    receipt = await TX.waitForReceipt(record, pin.eth, { timeoutMs: 60000 });
  } catch (e) {
    throw Object.assign(e instanceof Error ? e : new Error(String(e)), { sent: hash });
  }
  if (!keep) TX.clearPending(record);
  receipt.record = record;
  return finishSend(receipt, what, hash);
  } finally {
    inFlight.delete(flightKey);
  }
}

/// The tail of send(), once the receipt is in hand: a revert throws here. The
/// in-flight entry is dropped by send()'s finally either way.
function finishSend(receipt, what, hash) {
  // THE WARNING IS NOT CLEARED HERE. A receipt arriving does not put the hash
  // back anywhere it can be read from after a reload, and the success line is
  // exactly the message that used to overwrite it. It goes when the NEXT action
  // starts, by which point the user has seen it.
  if (receipt.status !== "0x1") throw new Error(`${what} reverted on chain (${hash}). Nothing changed.`);
  return receipt;
}

/// A transaction this page sent and then lost sight of - a reload, a closed
/// tab - is announced rather than forgotten.
/// NOT CONDITIONAL ON A TOKEN BEING SELECTED.
///
/// The first version returned early unless a launch token was in the form -
/// which made the CREATE transaction, the one that produces the token address,
/// invisible on the next load. That is the transaction least able to be
/// reconstructed and the most expensive to send twice.
///
/// Records carry what they were: the kind, the target, the account and the
/// endpoint they were sent through, so each is read back on the endpoint it
/// went to first, and on another only where recordTransports allows one.
///
/// AND LAUNCH.HTML'S RECORDS FOR THE LAUNCH ON SCREEN. outstandingFor counts a
/// graduation sent from launch.html against this page's trades, so this page
/// has to be able to settle one. It used to skip them: a graduation whose tab
/// closed before the receipt refused every trade here, with advice to reload
/// that could not help, until launch.html happened to be opened on that launch
/// again. Only the launch on screen, because that is the only place they block.
/// A MINED CREATE THE FORM COULD NOT ADOPT IS SAID ONCE PER LOAD, by key. It
/// used to be said again after every action and every load, over the action's
/// own result or refusal (round 5, N02); its record now stays only to carry the
/// address the receipt named (`made`), and refuses nothing.
const saidMade = new Set();

/// HOW MANY RESUMES HAVE FINISHED, quiet or not. The browser tests read it
/// (CurbApp.state): a quiet resume writes nothing, so without it a test could
/// not tell one that has run and said nothing from one still asking a slow
/// endpoint - and a check made "a second later" passed whatever the page did.
let resumeRuns = 0;
async function resumePending(opts) {
  try { return await resumePendingInner(opts); } finally { resumeRuns += 1; }
}

async function resumePendingInner(opts) {
  // QUIET: settle, adopt and clear as usual, but write nothing to the message
  // line - it holds what an action just did, or why it was refused (guard()).
  // Every message about a record goes through the `say` handed to settleRecord
  // and adoptCreated, is collected, and is shown at the end only when this
  // resume may speak.
  const quiet = !!(opts && opts.silent);
  // NOT A RECORD THIS PAGE IS STILL SENDING: its own send() settles it.
  const all = TX.loadPendingAll().filter((t) => !inFlight.has(TX.keyOf(t)));
  const mine = all.filter((t) => t.page === APP_MARK && (!account || same(t.from, account)));
  const theirs = all.filter((t) => !t.page && same(t.lens, chainCfg.lens) && same(t.token, chainCfg.token) &&
    (!account || same(t.account, account)));
  const records = mine.concat(theirs);
  if (!records.length) return;

  // The one for the launch on screen first, then the rest - a create has no
  // token to match on and must not be pushed behind a trade.
  const score = (t) =>
    (same(t.token, chainCfg.token) && same(t.lens, chainCfg.lens) ? 2 : 0) + (t.kind === "create" ? 1 : 0);
  const sorted = [...records].sort((a, b) => score(b) - score(a));

  // EVERY RECORD IS JUDGED. The loop used to return at the first one settled,
  // and a create sorts ahead of every record not about the launch on screen -
  // so a mined create the form could not adopt kept a claim naming another
  // launch, or a second create, from ever being looked at (round 5, N02).
  const settled = [];
  const still = [];
  for (const rec of sorted) {
    // AN AGE FOR EVERY RECORD, so one the chain will never settle can be let
    // go an hour on (TX.stampJudged says where the age comes from).
    const tx = TX.stampJudged(rec);
    const lines = [];
    let outcome;
    try { outcome = await settleRecord(tx, (kind, html) => lines.push({ kind, html })); }
    catch { outcome = { still: { state: "unreadable" } }; }
    if (outcome.done) settled.push(...lines);
    else still.push({ tx, why: outcome.still });
  }
  // WHAT A SETTLED RECORD CHANGED IS READ AGAIN where anything on screen may
  // have come from an answer multicall.js asked before it was mined (forget
  // says how many this page took): the whole refresh, which owns the launch,
  // the balances and the owed panel, and sends the token view curb:drawn. The
  // refresh, not one panel: a newer refresh running meanwhile is then
  // superseded rather than left to drop its own drawing. AFTER THE REPORT
  // (finally, below), which does not depend on it: awaited first, it held the
  // report back for a whole refresh, and an action pressed meanwhile had its
  // own line written over.
  const reread = settled.length > 0 && !!(Multi && Multi.forget) && Multi.forget() > 0;
  try {
    if (quiet) return;

    const parts = settled.map((l) => l.html);
    let made = false;
    for (const s of still) {
      // WHAT A SWAP LEFT IN THE WALLET: the launch on screen says it in its held
      // row; any other launch's gets one line, once per record, ever.
      if (s.why.state === "held") {
        const here = same(s.tx.token, chainCfg.token) && same(s.tx.lens, chainCfg.lens);
        if (here || s.tx.heldSaid) continue;
        // AS IT IS NOW: a step 2 or a sale back judged in this same pass may
        // have spent it (settleRecord, spendsHeld) since it was read.
        const key = TX.keyOf(s.tx);
        const now = TX.loadPendingAll().find((t) => TX.keyOf(t) === key);
        if (!now || !now.held || !TX.updatePending(now, { heldSaid: true })) continue;
        let amount = null;
        try { amount = BigInt(now.held); } catch { amount = null; }
        parts.push(`You hold ${amount === null ? "" : escapeHtml(fmt(amount, Number(s.tx.assetDecimals) || 0, 6)) + " "}` +
          `${escapeHtml(s.tx.assetSym || "of the asset")} from a swap for <a href="` +
          `${escapeHtml(tokenPageHref(s.tx.token, { rpc: s.tx.rpc, lens: s.tx.lens }))}">this launch</a>: open it to ` +
          `buy with it or sell it back.`);
        continue;
      }
      if (s.why.state === "made") {
        const key = TX.keyOf(s.tx);
        if (saidMade.has(key)) continue;
        saidMade.add(key);
        made = true;
      }
      parts.push(stillLine(s.tx, s.why));
    }
    if (!parts.length) return;
    const kind = settled.some((l) => l.kind === "err") ? "err"
      : (settled.some((l) => l.kind === "ok") || made) ? "ok" : "wait";
    show(kind, parts.join("<br>"));
  } finally {
    if (reread) await refresh(true).catch(() => {});
  }
}

/// An endpoint the person chose: anything but the one only a link named.
const personChoseRpc = (url) => !!url && url !== linkOnlyRpc;

/// WHERE A RECORD IS ASKED ABOUT, in this order, and only where its chain is
/// served now:
///   1. the endpoint an app.html record was sent through (`tx.rpc`);
///   2. the endpoint in the form, when the person chose it - typed it, or it
///      was saved by a visit where it was not a link's alone - and NEVER one
///      only a link brought, on this visit or saved from an earlier one. A
///      link can name an endpoint that answers a receipt the chain never
///      produced, and a fabricated receipt cleared the double-send guard on
///      load, with no click (round 5, N50);
///   3. the wallet, while it is on the record's chain.
/// A record whose own endpoint stopped answering, or moved to another chain,
/// used to be asked nowhere else and stayed "unreadable" for good, refusing its
/// scope on every endpoint (round 5, N04). launch.html's records name no
/// endpoint and start at 2.
/// LAZY, ONE AT A TIME: the next is asked only when the caller could not use
/// the last - it served another chain, or it named this chain and then failed
/// the reads themselves (settleRecord moves on then).
/// @yield {request, url} - url is null for the wallet - for each transport that
///        says it serves the record's chain. `seen` is filled as it goes:
///        `reached` when anything answered at all, `served` with the first
///        other chain named.
async function* recordTransports(tx, seen) {
  const foreign = tx.page !== APP_MARK;
  const atUrl = async (url) => {
    const request = (m, p) => rpcAt(url, m, p);
    let id;
    try { id = await request("eth_chainId", []); } catch { return null; }
    seen.reached = true;
    if (id === tx.chainId) return { request, url };
    if (seen.served == null) seen.served = id;
    return null;
  };
  if (!foreign && tx.rpc) {
    const own = await atUrl(tx.rpc);
    if (own) yield own;
  }
  if (personChoseRpc(chainCfg.rpc) && (foreign || chainCfg.rpc !== tx.rpc)) {
    const form = await atUrl(chainCfg.rpc);
    if (form) yield form;
  }
  const w = injected();
  if (w) {
    let id = null;
    try { id = await w.request({ method: "eth_chainId" }); seen.reached = true; }
    catch { /* a wallet that will not say is not a way to ask */ }
    if (id !== null && id === tx.chainId) yield { request: (m, p) => w.request({ method: m, params: p }), url: null };
    else if (id !== null && seen.served == null) seen.served = id;
  }
}

/// What the chain says about one record, acted on (TX.judgePending decides,
/// TX.readVerdict says what that means for this record). A settled record is
/// cleared, or adopted, and said through `say`; anything the chain does not
/// prove leaves it where it is.
/// @return {done: true} when a message about it has been said; {still: why}
///         when the record stays - "made" for a create mined whose launch the
///         form could not take, with the words for it in `why.html`.
async function settleRecord(tx, say) {
  say = say || show;
  const foreign = tx.page !== APP_MARK;
  // A SWAP THAT HAS DELIVERED IS SETTLED: what is left is the asset it left in
  // the wallet, which the held row offers to buy with or sell back.
  if (tx.kind === "eth-swap" && tx.held && !foreign) return { still: { state: "held" } };

  // A NONCE THE RECORD LACKS may still be known to the wallet that sent it. An
  // endpoint does not necessarily see a pending transaction at all.
  if (tx.sentNonce == null && injected()) {
    try {
      const w = injected();
      if ((await w.request({ method: "eth_chainId" })) === tx.chainId) {
        const n = await TX.nonceOfHash(tx.hash, [(m, p) => w.request({ method: m, params: p })], tx.from || tx.account);
        if (n !== null) { tx = { ...tx, sentNonce: n }; TX.updatePending(tx, { sentNonce: n }); }
      }
    } catch { /* judged on what the endpoint knows */ }
  }

  // A SEND SIGNED WHILE THE WALLET CHANGED NETWORKS - launch.html's or this
  // page's own - is "uncertain" on any verdict short of a receipt, and a nonce
  // unused an hour on with no node that knows the hash is "dropped": both may
  // be forgotten by hand (TX.readVerdict).
  // AN ENDPOINT THAT NAMES THE CHAIN AND THEN FAILS THE READS is passed over
  // for the next, as one that serves another chain is. A provider that answers
  // eth_chainId and refuses the rest - a rate limit, or a revoked key, sent
  // back as a JSON-RPC error - otherwise kept its record "unreadable" beside an
  // endpoint or wallet that held the receipt (round 5, N04). A read that fails
  // everywhere it was tried is thrown: the record stays, "unreadable".
  const seen = { reached: false, served: null };
  let where = null;
  let verdict = null;
  let failure = null;
  for await (const candidate of recordTransports(tx, seen)) {
    try {
      verdict = TX.readVerdict(tx, await TX.judgePending(tx, candidate.request));
      where = candidate;
      break;
    } catch (e) { failure = e; }
  }
  if (!where) {
    if (failure) throw failure;
    return { still: { state: seen.reached ? "elsewhere" : "unreadable", served: seen.served } };
  }
  const request = where.request;
  // A RECOVERED CREATE IS ADOPTED UNDER THE ENDPOINT THAT PROVED IT: the one
  // whose receipt names the launch. Through the wallet that is no endpoint, so
  // the one it was sent through stands.
  const adoptRpc = where.url || tx.rpc;
  if (verdict.nonce && tx.sentNonce == null) TX.updatePending(tx, { sentNonce: verdict.nonce });
  const link = `<code>${escapeHtml(tx.hash)}</code>`;
  const what = foreign ? "completing the move to the pool, sent from launch.html" : (tx.what || "an action");

  if (verdict.state === "mined") {
    const receipt = verdict.receipt;
    if (receipt.status === "0x1" && tx.kind === "create" && !foreign) {
      // adoptCreated clears the record ITSELF, and only once the address is
      // somewhere that survives a reload. An error thrown in here leaves the
      // record in place, which is the point.
      return adopted(adoptCreated({ factory: tx.factory, lens: tx.lens, rpc: adoptRpc }, receipt, tx, null, true, say));
    }
    // A TWO-STEP BUY'S SWAP, MINED: what it delivered is held until it is
    // spent, sold back or dismissed - a reload between the steps loses nothing.
    if (receipt.status === "0x1" && tx.kind === "eth-swap" && !foreign) {
      const held = creditsTo(receipt, tx.asset, tx.from).reduce((a, b) => a + b, 0n);
      if (held > 0n) {
        TX.updatePending(tx, { held: held.toString(), heldAt: Date.now(), heldBlock: receipt.blockNumber });
        return { still: { state: "held" } };
      }
    }
    // A SEND THAT SPENT WHAT A SWAP LEFT HELD - step 2, a sale back - mined
    // after its own wait gave up (a timeout, a network switch, a reload): what
    // it took from this account is no longer held. Without this the swap's
    // record kept the whole amount, and beside other units of the asset the
    // held row and the refusal of ETH buys went on about units already spent.
    if (receipt.status === "0x1" && tx.spendsHeld && !foreign && isAddr(tx.asset)) {
      spendHeldOf(tx.chainId, tx.from, tx.lens, tx.token, netSpent(receipt, tx.asset, tx.from));
    }
    TX.clearPending(tx);
    say(receipt.status === "0x1" ? "ok" : "err",
      // "EARLIER", NOT "FROM A PREVIOUS VISIT": the record may be another open
      // tab's, mined a moment ago.
      `An earlier transaction (${escapeHtml(what)}) ` +
      `${receipt.status === "0x1" ? "succeeded" : "reverted"}: ${link}.`);
    return { done: true };
  }

  if (verdict.state === "replaced") {
    const replacedLine =
      `A transaction from a previous visit (${escapeHtml(what)}) was replaced or dropped by the wallet - ` +
      `its nonce has been used by another transaction: ${link}. Its record is cleared`;
    if (tx.kind === "create" && !foreign) {
      // A SPED-UP CREATE IS A REPLACEMENT THAT DID CREATE: adopted, not
      // cleared. Only when the search positively finds nothing is it called
      // replaced; a search that could not be made keeps the record.
      const found = await TX.findReplacement(tx, verdict, request, tx.factory, TOPIC.launchCreated);
      if (found.receipt) {
        // THE RECORDED HASH ITSELF can be what the search finds: an endpoint
        // whose backends lag can miss its receipt on both reads and still serve
        // its log. That is the create, adopted as itself - not called a speed-up.
        const itself = same(found.receipt.transactionHash, tx.hash);
        return adopted(adoptCreated({ factory: tx.factory, lens: tx.lens, rpc: adoptRpc }, found.receipt, tx, null,
          itself || "replaced", say));
      }
      if (found.cannot) return { still: { state: "unsearched", why: found.cannot } };
      TX.clearPending(tx);
      say("wait", `${replacedLine}. Every launch this factory made since it was sent was checked, and none ` +
        `came from the transaction that took its place, so no launch was created by it.`);
      return { done: true };
    }
    // A SPED-UP SWAP DELIVERED ALL THE SAME: looked for by what a replacement
    // is - this sender, this nonce - among the asset's transfers to the buyer.
    // A cancel delivers nothing and is cleared; a search that could not be made
    // keeps the record.
    if (tx.kind === "eth-swap" && !foreign && isAddr(tx.asset)) {
      const found = await TX.findReplacement(tx, verdict, request, tx.asset, TOPIC.transfer,
        [TOPIC.transfer, null, "0x" + pad32(tx.from)]);
      if (found.receipt && found.receipt.status === "0x1") {
        const held = creditsTo(found.receipt, tx.asset, tx.from).reduce((a, b) => a + b, 0n);
        if (held > 0n) {
          TX.updatePending(tx, { held: held.toString(), heldAt: Date.now(), heldBlock: found.receipt.blockNumber,
            replacedBy: found.receipt.transactionHash });
          return { still: { state: "held" } };
        }
      }
      if (found.cannot) return { still: { state: "unsearched", why: found.cannot } };
    }
    TX.clearPending(tx);
    say("wait", `${replacedLine}; check the wallet's activity for what went through instead.`);
    return { done: true };
  }

  return { still: verdict };
}

/// A recovered create, as settleRecord reports it: said and done when the form
/// took it, kept as "made" - said once per load by resumePending - when not.
async function adopted(out) {
  if (out.kept) { await refresh(true); return { done: true }; }
  return { still: { state: "made", token: out.token, html: out.html } };
}

/// Why a record is still there, and what would clear it.
function stillLine(tx, why) {
  const forget = TX.mayForget(tx, why)
    ? ` <button type="button" class="ghost" data-forget="${escapeHtml(TX.keyOf(tx))}">Forget this record</button>`
    : "";
  if (why.state === "made") {
    return `${why.html} Its record is kept only to carry that address: it no longer refuses a create.${forget}`;
  }
  const link = `<code>${escapeHtml(tx.hash)}</code>`;
  const lead = tx.page !== APP_MARK
    ? `A transaction launch.html sent for this launch (completing the move to the pool) is still unaccounted for: ${link}.`
    : `A transaction from a previous visit is still unaccounted for: ${link} (${escapeHtml(tx.what || "an action")}).`;
  const twice = " Sending again could pay for the same thing twice.";
  const n = why.nonce ? parseInt(why.nonce, 16) : null;
  if (why.state === "ahead") return lead + aheadWords(n, why.chainCount) + forget;
  if (why.state === "unsearched" && tx.kind === "eth-swap") {
    return lead + ` Your wallet replaced the swap with another transaction, and whether that one delivered ` +
      `${escapeHtml(tx.assetSym || "the asset")} could not be checked: ${escapeHtml(why.why || "")}. Check your ` +
      `wallet's activity; if you have checked, you can forget it.` + forget;
  }
  const age = TX.ageOf(tx);
  const old = age === null ? "" : ` It was first recorded here ${TX.ageText(age)} ago.`;
  // UNREADABLE AND ELSEWHERE ARE LET GO ONLY PAST THE HOUR, and the line says
  // which side of it this record is on.
  const hour = forget
    ? `${old} That is past the hour after which this page lets a record nothing can read be forgotten; if ` +
      `your wallet's activity shows it never went through, you can forget it.`
    : ` If nothing can read it an hour after it was first recorded here, this page offers to forget it.`;
  const detail = {
    pending: why.seen
      ? ` The node still has it, waiting to be mined.${twice}`
      : ` It has not been mined, and its nonce (${n}) has not been used by anything else, so it still can be.${twice} ` +
        `If your wallet shows it, cancel or speed it up there. If it does not, the wallet may have dropped it: ` +
        `${TX.useTheNonce(n)} If no node knows the hash an hour after it was sent, this page offers to forget it.`,
    dropped:
      ` It has not been mined, its nonce (${n}) is unused, and the node does not know the hash.${old} The ` +
      `network has most likely dropped it - but a wallet that still holds it can send it again, so to be sure ` +
      `it never lands, use the nonce first. ${TX.useTheNonce(n)}${twice} If you have checked, you can forget it.`,
    unknown:
      ` The node does not know that hash, and there is no record of the nonce it used, so nothing on chain can ` +
      `settle it.${twice} Check your wallet's activity; if it is not there and never went through, you can forget it.`,
    unsearched:
      ` Your wallet replaced it with another transaction, and whether that one created a launch could not be ` +
      `checked: ${escapeHtml(why.why || "")}. A LAUNCH MAY EXIST - look at your wallet's activity before creating ` +
      `again. The record is kept, so a second create stays refused; if you have checked, you can forget it.`,
    uncertain:
      ` It was signed while the wallet changed networks, so which chain it went to is not established, and ` +
      `this chain's nonce cannot say what became of it.${twice} Check the hash in your wallet; if it went ` +
      `elsewhere or never went through, you can forget it.`,
    elsewhere:
      ` It was sent on chain ${parseInt(tx.chainId, 16)}, and nothing this page may ask about it - the endpoint ` +
      `it was sent through, one you typed or saved, or the wallet - serves that chain now` +
      `${why.served ? ` (the first to answer serves chain ${parseInt(why.served, 16)})` : ""}, so it cannot be ` +
      `checked from here.${twice}${hour}`,
    unreadable: ` It could not be checked just now: nothing this page may ask about it answered.${twice}${hour}`,
  }[why.state] || ` It could not be checked just now.${twice}${hour}`;
  return lead + detail + forget;
}

/// A WALLET WHOSE COUNT IS NOT THIS CHAIN'S, in plain words, with the way out.
/// The owner met it as "There is already a transaction for this that has not
/// been accounted for" and could not create: a wallet that remembered an older
/// fork signed at a nonce this chain never reaches.
function aheadWords(n, chainCount) {
  const c = chainCount ? parseInt(chainCount, 16) : null;
  return ` Your wallet's transaction count does not match this chain: it signed this as transaction number ` +
    `${n}, but this account has sent only ${c === null ? "fewer" : c} here, so it can never go through on this ` +
    `chain. That happens when the wallet remembers another network or an older copy of this chain. To fix it, ` +
    `reset the wallet's activity for this account (MetaMask: Settings, Advanced, Clear activity tab data; ` +
    `other wallets call it reset account or clear activity), then forget this record and send again.`;
}

/// IS THE NONCE A TRANSACTION CARRIES ONE THIS CHAIN CAN REACH? Asked right
/// after a send, through the pinned endpoint: above the account's count and
/// above what the node's pending pool brings it to is a gap nothing fills.
/// AND THE WALLET IS ASKED TOO, while it is on the record's chain: an endpoint
/// that lags reports a count behind the chain's, and on its word alone a
/// transaction that will mine was called one that never can. Both must see
/// the gap.
/// @return the account's count (a quantity) when it is such a gap, else null -
///         and null when a count cannot be read: a guess never refuses.
async function nonceGap(pin, nonce, hash) {
  const isQ = (x) => /^0x[0-9a-f]+$/i.test(x || "");
  const gapAt = async (ask) => {
    const used = await ask("eth_getTransactionCount", [pin.from, "latest"]);
    if (!isQ(used) || BigInt(nonce) <= BigInt(used)) return null;
    const pend = await ask("eth_getTransactionCount", [pin.from, "pending"]);
    if (!isQ(pend) || BigInt(nonce) < BigInt(pend)) return null;
    return used;
  };
  try {
    const used = await gapAt((m, p) => pin.read(m, p));
    if (used === null) return null;
    // A TRANSACTION ALREADY MINED IS NO GAP, whatever a count says.
    for (const ask of [(m, p) => pin.read(m, p), (m, p) => pin.eth.request({ method: m, params: p })]) {
      try { if (await ask("eth_getTransactionReceipt", [hash])) return null; } catch { /* the next one */ }
    }
    let walletChain = null;
    try { walletChain = await pin.eth.request({ method: "eth_chainId" }); } catch { walletChain = null; }
    if (walletChain === pin.chainId) {
      const seen = await gapAt((m, p) => pin.eth.request({ method: m, params: p }));
      if (seen === null) return null;
    }
    return used;
  } catch { return null; }
}

/// WHAT FORGETTING ALLOWS, said before it is done.
function forgetQuestion(tx, why) {
  if (why.state === "ahead") {
    return `Forget the record of ${tx.hash}?\n\nYour wallet signed it at a transaction number this chain has not ` +
      `reached, so it cannot go through here. Reset the wallet's activity too, or its next transaction will ` +
      `carry the same wrong number.`;
  }
  if (why.state === "made") {
    return `Forget the record of ${tx.hash}?\n\nThe launch it created, ${why.token}, exists on chain whatever ` +
      `you do: forgetting only drops this page's note of its address, so copy it first if you need it.`;
  }
  const n = why.nonce ? parseInt(why.nonce, 16) : null;
  return `Forget the record of ${tx.hash}?\n\nOnly do this if your wallet's activity shows it never went through. ` +
    `This page will stop refusing a second send because of it - and if it did go through, or goes through ` +
    `later, a second send pays for the same thing twice.` +
    (why.state === "dropped" && n !== null
      ? `\n\nA wallet that kept it can still send it. Any transaction from this account at nonce ${n} - a ` +
        `zero-value send to yourself - makes sure it never lands.`
      : "");
}

/// ENDED BY HAND, AND ONLY WHILE THE CHAIN STILL HAS NOTHING TO SAY. Asked
/// again first: it may have mined, or been replaced, since the button was drawn.
async function forgetRecord(key) {
  if (busy) return;
  const found = TX.loadPendingAll().find((t) => TX.keyOf(t) === key);
  if (!found) return;
  const tx = TX.stampJudged(found);
  busy = true;
  try {
    let outcome;
    try { outcome = await settleRecord(tx); } catch { outcome = { still: { state: "unreadable" } }; }
    if (outcome.done) return;
    if (!TX.mayForget(tx, outcome.still)) { show("wait", stillLine(tx, outcome.still)); return; }
    const ok = window.confirm(forgetQuestion(tx, outcome.still));
    if (!ok) return;
    TX.clearPending(tx);
    show("wait",
      `The record of <code>${escapeHtml(tx.hash)}</code> is forgotten. If it turns up in your wallet's activity ` +
      `after all, it was real.`);
  } finally {
    busy = false;
  }
}

/// A WARNING THAT CANNOT BE OVERWRITTEN BY THE NEXT MESSAGE.
///
/// When the browser refuses to store a hash, the page says so - and then the
/// next line it wrote replaced it, which is exactly the message that must not
/// be lost. It is appended to everything until that transaction resolves.
let sticky = null;
/// HOW MANY TIMES THE MESSAGE LINE HAS BEEN WRITTEN, so guard() can tell a
/// refusal its own action wrote from one an earlier action left on screen.
let msgWrites = 0;

function show(kind, html) {
  msgWrites += 1;
  const el = $("msg");
  el.hidden = false;
  el.className = kind || "";
  el.innerHTML = html + (sticky ? ` <span class="warn">${sticky}</span>` : "");
}

/// WHAT THE PAGE COULD NOT READ, kept apart from what a transaction DID.
///
/// They shared one line, and the reading one always came last: point the form
/// at something that is not a factory and the address of the launch you had
/// just created vanished behind the complaint about it. A result a user may
/// need to copy must not be transient.
function showRead(html) {
  const el = $("readmsg");
  if (!html) { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  el.innerHTML = html;
}

// ---------------------------------------------------------------- formatting
function fmt(value, decimals, places = 4) {
  const v = BigInt(value);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = v % base;
  if (places === 0) return whole.toLocaleString("en-US");
  const fracStr = frac.toString().padStart(decimals, "0").slice(0, places).replace(/0+$/, "");
  return whole.toLocaleString("en-US") + (fracStr ? "." + fracStr : "");
}
/// A FIGURE THAT IS NOT ZERO IS NEVER PRINTED AS ZERO. fmt() cuts at `places`,
/// and a cbBTC fee of 0.00000327 (8 decimals) came out as "0 cbBTC" beside a
/// trade that paid it. Past the cut, this shows the first two significant
/// digits, at most to the asset's own decimals; every other figure is fmt's.
function fmtSmall(value, decimals, places = 6) {
  const v = BigInt(value);
  const s = fmt(v, decimals, places);
  if (v <= 0n || s !== "0") return s;
  for (let p = places + 1; p <= decimals; p++) {
    if (fmt(v, decimals, p) !== "0") return fmt(v, decimals, Math.min(decimals, p + 1));
  }
  return s;
}
/// Parses what a person typed into the token's smallest unit, without floats:
/// 0.1 of an 8-decimal token is 10000000, and via Number it is not.
function parseUnits(text, decimals) {
  const s = String(text == null ? "" : text).trim();
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") throw new Error("not a number: " + text);
  const [w, f = ""] = s.split(".");
  if (f.length > decimals) throw new Error(`more than ${decimals} decimal places`);
  return BigInt((w || "0") + f.padEnd(decimals, "0"));
}

// ---------------------------------------------------------------- chain reads
/// A CALL THAT ANSWERS NOTHING IS NOT AN ADDRESS.
///
/// An eth_call to an address with no code, or to one that has no such function,
/// returns "0x" - and reading a word out of that gave "cannot read properties
/// of undefined", which tells a user nothing about what they typed wrong.
function oneAddress(raw, what) {
  const w = words(raw);
  if (!w.length) {
    throw new Error(
      `${what} returned nothing. That address has no code on this network, or it is not the contract it is in the field for.`
    );
  }
  return wordToAddress(w[0]);
}

/// THE ASSET'S OWN NAME, with a fallback that is honest about being one. A
/// token that will not answer symbol() still has to be tradeable here, so its
/// address stands in rather than a guess at what it is called.
/// WHAT A TICKER MAY CONTAIN. Letters, digits, and the few separators real
/// symbols use. Anything else - markup, control characters, a thousand
/// characters of padding - is not a ticker, and this page puts the symbol into
/// innerHTML in fifteen places.
const TICKER = /^[A-Za-z0-9 ._+-]{1,16}$/;

/// THE ASSET'S OWN NAME FOR ITSELF, AND IT IS NOT TRUSTED AS MARKUP.
///
/// `factory` and `lens` come off the query string [see readConfig], so a link
/// chooses which contracts this page reads and therefore which contract answers
/// symbol(). Checking the answer HERE, once, is what keeps the fifteen sinks
/// safe - including the ones somebody adds later, which is the half that
/// escaping each call site does not cover.
///
/// A string that fails the check is NOT cleaned up and shown anyway. It falls
/// back to the truncated address, the same answer this gives for an asset that
/// will not respond: something that is not a symbol should not be displayed as
/// one.
/// WHY A FALLBACK HAPPENED, kept so it can be told apart from the symbol
/// simply being unreadable. A transient RPC failure and an asset that answers
/// with rubbish produce the same string on screen and want opposite fixes.
/// KEYED BY TOKEN, not a single last-write. The first version of this kept
/// only the most recent fallback and was read after a test that causes one
/// deliberately, so it reported that test's asset and hid the one being
/// looked for. A diagnostic that can be overwritten by unrelated activity is
/// not a diagnostic.
const symbolTrouble = {};

/// BOTH ENDS OF THE ADDRESS, because one end is not enough here. Every B20
/// equity is 0xb2 followed by ten zero bytes, so the first six characters are
/// identical for all thirteen of them - the old fallback rendered NVDAc and
/// METAc as the same indistinguishable "0xb200…". What tells them apart is at
/// the other end.
const shortAddress = (a) => a.slice(0, 6) + "…" + a.slice(-4);

async function symbolOf(token, callFn) {
  const short = shortAddress(token);
  try {
    const raw = decodeAbiString(await callFn(token, SEL.symbol));
    if (TICKER.test(raw)) return raw;
    symbolTrouble[token.toLowerCase()] = "answered " + JSON.stringify(raw);
    return short;
  } catch (e) {
    symbolTrouble[token.toLowerCase()] = "threw: " + (e && e.message ? e.message : String(e));
    return short;
  }
}

/// A dynamic string as the ABI returns it: offset, length, bytes.
function decodeAbiString(raw) {
  const h = (raw || "").replace(/^0x/, "");
  if (h.length < 128) return "";
  const len = Number(BigInt("0x" + h.slice(64, 128)));
  if (!len || h.length < 128 + len * 2) return "";
  const bytes = h.slice(128, 128 + len * 2).match(/.{2}/g).map((b) => parseInt(b, 16));
  // The length is exact for a dynamic string, so there is no padding to strip.
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/// The most factories one registry may list before this page refuses to read
/// them: the number browse.js uses for the same read.
const MAX_LAUNCHERS = 256;
/// How many factories quoteChoices reads at once: the site's Alchemy endpoint
/// answered forty calls in parallel without a refusal (17 October 2026), and
/// two lists can be read at the same moment.
const QUOTE_READS_AT_ONCE = 6;

/// EVERY FACTORY THE REGISTRY ADMITS, and the asset each one prices against.
/// READ, NOT CONFIGURED: a quote asset added to the registry appears here
/// without this file changing, and one that was never added cannot be offered
/// by editing the page. One unreadable factory must not hide the rest.
///
/// AT MOST MAX_LAUNCHERS, AND ONLY WHILE ASKED. The count comes from a registry
/// a link can choose (through its lens or its factory), and it used to decide
/// alone how many rounds of reads this ran: a contract answering 2^255 kept the
/// page sending eth_calls through the person's endpoint until the tab closed,
/// and every later refresh started another such loop (round 5, N49). A count
/// above the limit is refused whole, as browse.js refuses it - listing the
/// first 256 of a registry that claims more would be a guess at which ones
/// matter - and `live`, when given, is asked before every round, so a caller
/// that has moved on stops the reads rather than merely ignoring them.
/// @param live  optional () => boolean; false stops the reads with an error
/// @return one entry per listed factory, in the registry's order - which is the
///         order it admitted them, since it only ever appends (LaunchRegistry) -
///         and, as `.unread`, the indices whose factory could not be read, so
///         nothing drawn from the rest pretends to know what those were
/// THE LIST, SHARED AND KEPT - on the site's own endpoint only (config.js rpc).
/// A launch's page asked for it twice at the same moment (its factory and the
/// asset picker), 56 reads each; and a factory, its asset and that asset's
/// name and symbol never change, while the registry only ever appends. So two
/// callers within a minute share one read, and what was read is kept in this
/// browser by registry and index: the next visit asks the count and only the
/// factories admitted since. Elsewhere - a fork, a link's endpoint, the tests'
/// nodes - every call reads everything, as before.
const QUOTE_LISTS = new Map();
const QUOTE_LIST_MS = 60_000;
const QUOTE_KEEP = "curb.quoteChoices.v1";
function quoteListKey(registry, url) {
  const site = window.CURB_SITE || {};
  const own = typeof site.rpc === "string" ? site.rpc.trim() : "";
  return own && String(url || "").trim() === own && isAddr(registry) ? own + "|" + String(registry).toLowerCase() : "";
}
function keptQuotes(key) {
  try {
    const all = JSON.parse(localStorage.getItem(QUOTE_KEEP) || "{}");
    return Array.isArray(all[key]) ? all[key] : [];
  } catch { return []; }
}
function keepQuotes(key, list) {
  try {
    const all = JSON.parse(localStorage.getItem(QUOTE_KEEP) || "{}") || {};
    all[key] = list.map((c) => ({ factory: c.factory, quote: c.quote, sym: c.sym, name: c.name, index: c.index }));
    const keys = Object.keys(all);
    while (keys.length > 8) delete all[keys.shift()];
    localStorage.setItem(QUOTE_KEEP, JSON.stringify(all));
  } catch { /* storage refused: nothing kept */ }
}
async function quoteChoices(registry, callFn, live, url) {
  const key = quoteListKey(registry, url);
  if (!key) return readQuoteChoices(registry, callFn, live, []);
  const hit = QUOTE_LISTS.get(key);
  let p = hit && Date.now() - hit.at < QUOTE_LIST_MS ? hit.promise : null;
  if (!p) {
    // ALL AT ONCE WHERE multicall.js GATHERS THEM: one round trip per step for
    // every factory, rather than a step per six.
    p = readQuoteChoices(registry, callFn, null, keptQuotes(key), !!window.CurbMulti).then((list) => { keepQuotes(key, list); return list; });
    QUOTE_LISTS.set(key, { at: Date.now(), promise: p });
    p.catch(() => { if (QUOTE_LISTS.get(key) && QUOTE_LISTS.get(key).promise === p) QUOTE_LISTS.delete(key); });
  }
  const list = await p;
  if (live && !live()) throw new Error("superseded");
  const out = list.map((c) => ({ ...c }));
  out.unread = (list.unread || []).slice();
  return out;
}
async function readQuoteChoices(registry, callFn, live, kept, wide = false) {
  const w = words(await callFn(registry, SEL.launcherCount));
  const out = [];
  out.unread = [];
  if (!w.length) return out;
  const count = wordToBig(w[0]);
  if (count > BigInt(MAX_LAUNCHERS)) {
    throw new Error("The registry reports " + count + " factories, more than the " + MAX_LAUNCHERS +
      " this page will read from one registry.");
  }
  // A FEW FACTORIES AT A TIME, each one's name and symbol together. One by
  // one, fourteen factories were 56 reads end to end, about five seconds on
  // Base, and a launch's page read the list twice before it showed the launch
  // (measured on curbfun.xyz, 17 October 2026: status at 10.5 s). The order
  // is the registry's whatever finishes first, and `live` is still asked
  // before every factory.
  const n = Number(count);
  const got = new Array(n).fill(null);
  let next = 0;
  const worker = async () => {
    for (;;) {
      if (live && !live()) throw new Error("superseded");
      const i = next++;
      if (i >= n) return;
      // KEPT FROM AN EARLIER VISIT (quoteChoices): the same index of the same
      // registry is the same factory, asset, name and symbol for good.
      const k = kept[i];
      if (k && k.index === i && isAddr(k.factory) && isAddr(k.quote) && typeof k.sym === "string" && typeof k.name === "string") {
        got[i] = { factory: k.factory, quote: k.quote, sym: k.sym, name: k.name, index: i };
        continue;
      }
      try {
        const idx = BigInt(i).toString(16).padStart(64, "0");
        const f = oneAddress(await callFn(registry, SEL.launcherAt + idx), "launcherAt");
        const quote = oneAddress(await callFn(f, SEL.quoteToken), "quoteToken");
        // THE NAME IS FOR THE CARD'S SECOND LINE and is allowed to be missing:
        // a launch whose asset will not answer name() still gets a card.
        const [rawName, sym] = await Promise.all([
          callFn(quote, SEL.name).then((r) => { try { return decodeAbiString(r); } catch { return ""; } }, () => ""),
          symbolOf(quote, callFn),
        ]);
        const name = /^[\x20-\x7e]{1,40}$/.test(rawName) ? rawName : "";
        got[i] = { factory: f, quote, sym, name, index: i };
      } catch { got[i] = null; /* keep going */ }
    }
  };
  await Promise.all(Array.from({ length: wide ? n : Math.min(QUOTE_READS_AT_ONCE, n) }, worker));
  for (let i = 0; i < n; i++) {
    if (got[i]) out.push(got[i]);
    else out.unread.push(i);
  }
  return out;
}

/// THE FACTORY THAT MADE A LAUNCH, found from the launch rather than from its
/// asset.
///
/// THE ASSET IS NOT ENOUGH. The registry admits several factories per asset -
/// a second one is the only way to change an asset's immutable terms - and its
/// record names none of them. What the launch does name is the escrow its curve
/// pays into, and that escrow is what the owed panel reads, what a claim takes
/// from and what a sweep fills. Picking "the first factory for this asset"
/// pointed all three at an escrow that never received this launch's fees
/// (round 5, S53). Two factories that share one escrow are the same answer for
/// every one of those, and the first is taken.
/// @param live  optional () => boolean, handed to quoteChoices: false stops the
///              reads, and the answer is then null
/// @return the quoteChoices entry, or null when no listed factory matches
async function launchFactoryOf(registry, quote, curveEscrow, callFn, live) {
  // SHARED ONLY WHEN IT READS THE PAGE'S OWN ENDPOINT (call): a pinned pair reads its own.
  const choices = await quoteChoices(registry, callFn, live, callFn === call ? chainCfg.rpc : "").catch(() => []);
  for (const c of choices) {
    if (live && !live()) return null;
    if (!same(c.quote, quote)) continue;
    try {
      const escrow = oneAddress(await callFn(c.factory, SEL.feeEscrow), "feeEscrow");
      if (same(escrow, curveEscrow)) return c;
    } catch { /* an unreadable factory is not this launch's */ }
  }
  return null;
}

/// WHETHER THE ISSUER WILL LET THIS ACCOUNT HOLD THE QUOTE ASSET, asked
/// BEFORE a trade instead of found out by one. A refusal is a revert
/// (PolicyForbids, 0xa43fec12), so without this the user meets it as a failed
/// transaction with a four-byte error in it.
///
/// A MEASURED FACT WORTH SAYING HERE: every B20 equity measured sits under ONE
/// policy with ONE admin, so a restriction is not per-asset. Switching to
/// another stock does not route around it - test_oneBlocklistEntryStopsTwo-
/// DifferentAssets proves that with one blocklist entry stopping two assets.
///
/// AN ASSET THAT NAMES NO POLICY AT ALL is `none: true` (and still known: false,
/// so nothing that refuses on a known "no" changes): every coin that is not a
/// B20 - WETH answers its fallback's empty "0x", and a plain ERC-20 such as
/// VIRTUAL or AERO, or Circle's USDC, reverts with nothing, which is
/// lacksFunction. Only the policy row reads it, to say "no issuer policy"
/// rather than "could not be read" of a question that was answered.
/// @param how  { rpc, call, eth? } - when given, the policy ids come from
///             policyIds (kept for a minute for a quote); the answer is the same.
async function policyStanding(quote, account, callFn, how) {
  if (!account) return { known: false };
  try {
    let ids = null;
    if (how) ids = await policyIds(how, quote, !!how.eth).catch(() => null);
    if (ids && ids.failed) ids = null;
    let list;
    if (ids) {
      if (ids.none || (!ids.has.send && !ids.has.receive)) return { known: false, none: true };
      list = [ids.send, ids.receive].filter((id, i) => (i === 0 ? ids.has.send : ids.has.receive) && id !== null);
    } else {
      const scopes = [];
      for (const sel of [SEL.transferSenderPolicy, SEL.transferReceiverPolicy]) {
        let raw;
        try { raw = await callFn(quote, sel); } catch (e) { if (lacksFunction(e)) continue; throw e; }
        if (raw && raw !== "0x") scopes.push(raw);
      }
      if (!scopes.length) return { known: false, none: true };
      list = [];
      for (const scope of scopes) {
        const idRaw = await callFn(quote, SEL.policyId + scope.replace(/^0x/, ""));
        if (!idRaw || idRaw === "0x") continue;
        list.push(wordToBig(words(idRaw)[0]));
      }
    }

    for (const id of list) {
      // Policy 0 is "no policy": nothing to ask, and nothing to warn about.
      if (id === 0n) continue;
      const ok = await callFn(
        POLICY_REGISTRY,
        SEL.isAuthorized + pad32Num(id) + pad32(account)
      );
      if (!ok || ok === "0x") return { known: false };
      if (wordToBig(words(ok)[0]) !== 1n) return { known: true, allowed: false, policy: id.toString() };
    }
    return { known: true, allowed: true };
  } catch {
    // A page that cannot ask must not imply it asked and got a yes.
    return { known: false };
  }
}

const pad32Num = (n) => BigInt(n).toString(16).padStart(64, "0");

/// THE ASSET'S THREE POLICY IDS - sender, receiver, executor - read once and
/// kept for a minute per endpoint and asset for a quote (GRADUATION_TTL_MS); a
/// send asks again (fresh). Two parallel rounds: the scopes, then their ids.
/// A read that failed is not kept, and is marked `failed`: a value it left null
/// is unknown, not "no policy".
/// @return { none: true } for an asset that names no policy at all, or
///         { send, receive, execute, has, failed } - each id a bigint, or null
///         where the scope reads empty; `has` says which scopes were named.
const policyIdCache = new Map();   // rpc|quote -> { at, p }
function policyIds(how, quote, fresh) {
  // FRESH FOR A PIN IS FRESH ONCE PER PIN: the press's own reads, shared by
  // every question it asks, not read again by each.
  if (fresh && how && how.eth) {
    const k = String(quote || "").toLowerCase();
    how.policyIdsRead = how.policyIdsRead || {};
    if (!how.policyIdsRead[k]) {
      how.policyIdsRead[k] = readPolicyIds(how, quote);
      how.policyIdsRead[k].then((ids) => { if (ids.failed) delete how.policyIdsRead[k]; }, () => { delete how.policyIdsRead[k]; });
    }
    return how.policyIdsRead[k];
  }
  const key = ((how.rpc || "") + "|" + (quote || "")).toLowerCase();
  const kept = policyIdCache.get(key);
  if (!fresh && kept && Date.now() - kept.at < GRADUATION_TTL_MS) return kept.p;
  const p = readPolicyIds(how, quote);
  policyIdCache.set(key, { at: Date.now(), p });
  const drop = () => { if (policyIdCache.get(key) && policyIdCache.get(key).p === p) policyIdCache.delete(key); };
  p.then((ids) => { if (ids.failed) drop(); }, drop);
  return p;
}
async function readPolicyIds(how, quote) {
  let failed = false;
  const scopeOf = async (selector) => {
    try {
      const raw = await how.call(quote, selector);
      return raw && raw !== "0x" ? raw : null;
    } catch (e) {
      if (!lacksFunction(e)) failed = true;
      return null;
    }
  };
  const scopes = await Promise.all(
    [SEL.transferSenderPolicy, SEL.transferReceiverPolicy, SEL.transferExecutorPolicy].map(scopeOf));
  if (!failed && scopes.every((s) => s === null)) return { none: true };
  const ids = await Promise.all(scopes.map(async (s) => {
    if (s === null) return null;
    try {
      const w = words(await how.call(quote, SEL.policyId + s.replace(/^0x/, "").slice(0, 64)));
      return w.length ? wordToBig(w[0]) : null;
    } catch { failed = true; return null; }
  }));
  return { none: false, send: ids[0], receive: ids[1], execute: ids[2], failed,
    has: { send: scopes[0] !== null, receive: scopes[1] !== null, execute: scopes[2] !== null } };
}

/// WHETHER `who` IS AUTHORIZED UNDER ONE POLICY: true, false, or null when the
/// registry's answer could not be read. Policy 0, or none, admits everyone.
async function authorizedUnder(how, id, who) {
  if (id === null || id === undefined || id === 0n) return true;
  try {
    const w = words(await how.call(POLICY_REGISTRY, SEL.isAuthorized + pad32Num(id) + pad32(who)));
    return w.length ? wordToBig(w[0]) === 1n : null;
  } catch { return null; }
}

/// THIS ACCOUNT'S STANDING WITH THE ISSUER, asked before every ETH buy - not
/// only inside routerRoute, which used to return before asking it whenever the
/// CURB router was not ready.
/// @return { blocked, listed, twoWay } - blocked: the policy that refuses the
///         account, or null; listed: a coin's blacklist names it; twoWay: true
///         when both directions are positively allowed (or the asset has no
///         policies), false when either is refused, null when unknown or no
///         account is connected.
async function buyerStanding(how, fresh) {
  if (!how.from) return { blocked: null, listed: false, twoWay: null };
  const ask = (to, data) => how.call(to, data);
  const [ids, listed] = await Promise.all([
    policyIds(how, how.quote, fresh).catch(() => null),
    coinBlacklists(how.quote, how.from, ask),
  ]);
  if (ids && ids.none) return { blocked: null, listed, twoWay: true };
  if (!ids) return { blocked: null, listed, twoWay: null };
  const [sendOk, receiveOk] = await Promise.all([
    ids.has.send ? (ids.send === null ? Promise.resolve(ids.failed ? null : true) : authorizedUnder(how, ids.send, how.from))
      : Promise.resolve(ids.failed ? null : true),
    ids.has.receive ? (ids.receive === null ? Promise.resolve(ids.failed ? null : true) : authorizedUnder(how, ids.receive, how.from))
      : Promise.resolve(ids.failed ? null : true),
  ]);
  const blocked = sendOk === false ? ids.send.toString() : receiveOk === false ? ids.receive.toString() : null;
  return { blocked, listed, twoWay: sendOk === false || receiveOk === false ? false
    : sendOk === true && receiveOk === true ? true : null };
}

/// WHETHER THE ISSUER WILL LET A TWO-STEP BUY FINISH, AND BE UNDONE, asked
/// before its first step. A B20 checks its executor policy on a transferFrom
/// whose caller is not `from`, and two such pulls happen: the curve's in step 2,
/// and in a sell-back Aerodrome's router pulling from the buyer.
/// @param standingP  buyerStanding's promise, shared with the quote.
/// @return { fallbackOk, aeroOk } - each true only on positive answers. With no
///         account both are true: the quote is priced only, and the press asks.
async function twoStepStanding(how, curve, fresh, standingP) {
  if (!how.from) return { fallbackOk: true, aeroOk: true };
  const ids = await policyIds(how, how.quote, fresh).catch(() => null);
  if (ids && ids.none) {
    // NO POLICIES: a coin's blacklist is the question (cbXRP); a listed buyer
    // is refused before this, and whether the curve is listed is
    // graduationBlocked's.
    const listed = await coinBlacklists(how.quote, AERODROME.router.address, (to, data) => how.call(to, data));
    return { fallbackOk: true, aeroOk: !listed };
  }
  if (!ids || ids.failed) return { fallbackOk: false, aeroOk: false };
  const [standing, curveIn, curveMoves, routerMoves] = await Promise.all([
    standingP,
    authorizedUnder(how, ids.receive, curve),
    authorizedUnder(how, ids.execute, curve),
    authorizedUnder(how, ids.execute, AERODROME.router.address),
  ]);
  const fallbackOk = !!standing && standing.twoWay === true && curveIn === true && curveMoves === true;
  return { fallbackOk, aeroOk: fallbackOk && routerMoves === true };
}

/// ONE DIRECTION OF THE ISSUER'S POLICY, for one address.
///
/// A TRADE NEEDS BOTH - the account sends one asset and receives the other -
/// and policyStanding asks both. A CLAIM IS ONE TRANSFER, from the escrow or
/// the hook TO the account: the account has to be allowed to RECEIVE and the
/// payer to SEND. Asking policyStanding refused a claim when the issuer froze
/// only the account's outgoing transfers - a claim that would succeed - and
/// never noticed a payer the issuer blocks from sending, whose claim reverts
/// (round 5, N19). B20 names a scope per direction; the scope maps to a policy
/// id; the PolicyRegistry says whether the address is authorized under it.
/// @param direction  "send" (TRANSFER_SENDER_POLICY) or "receive"
///                   (TRANSFER_RECEIVER_POLICY)
/// @return { known, allowed, policy } - known false when the asset names no
///         such policy or any answer is missing: never read as a yes.
async function policyAllows(quote, who, direction, callFn) {
  if (!who) return { known: false };
  try {
    const scope = await callFn(quote, direction === "send" ? SEL.transferSenderPolicy : SEL.transferReceiverPolicy);
    if (!scope || scope === "0x") return { known: false };
    const idWords = words(await callFn(quote, SEL.policyId + scope.replace(/^0x/, "").slice(0, 64)));
    if (!idWords.length) return { known: false };
    const id = wordToBig(idWords[0]);
    // Policy 0 is "no policy": everybody is allowed.
    if (id === 0n) return { known: true, allowed: true };
    const ok = words(await callFn(POLICY_REGISTRY, SEL.isAuthorized + pad32Num(id) + pad32(who)));
    if (!ok.length) return { known: false };
    return { known: true, allowed: wordToBig(ok[0]) === 1n, policy: id.toString() };
  } catch {
    return { known: false };
  }
}

/// WHETHER THIS LAUNCH COULD GRADUATE, AS THE PAIRED ASSET'S ISSUER STANDS NOW:
/// null when nothing read says it could not, or the sentence why not.
///
/// A FULL CURVE THAT CANNOT GRADUATE FREEZES ITS HOLDERS. Its sells stop once it
/// is ready (sellableTokens() is 0), its buys stop with them, and graduate()
/// reverts for as long as the issuer refuses one of the addresses the reserve
/// moves through: the curve pays it to the Graduator, and the Graduator pays it
/// into Uniswap's PoolManager through Permit2. One blocklist entry on the
/// Graduator - one address for every launch - would freeze every full curve on
/// the asset, and the page kept taking buys. So before a buy every one of them
/// is asked: on a B20, each direction its role needs (the curve sends and
/// receives, the Graduator receives and sends, the PoolManager receives, Permit2
/// executes the transfer); on a coin with a blacklist (cbBTC, cbXRP, USDC),
/// whether it lists any of them; on a plain ERC-20 (VIRTUAL, AERO) the
/// blacklist question reverts, which is "no list", so nothing stops the buy. An
/// answer that could not be read is not a refusal -
/// the issuer standing of the trader and the router is read the same way.
/// Asked again for every send (fresh); a quote may use what was read in the
/// last minute.
const GRADUATION_TTL_MS = 60 * 1000;
const graduationVerdicts = new Map();   // rpc|quote|curve|graduator -> { at, why }
async function graduationBlocked(how, curve, graduator, fresh) {
  if (!how.quote || same(how.quote, WETH) || !isAddr(curve) || !isAddr(graduator)) return null;
  const key = [how.rpc || "", how.quote, curve, graduator].join("|").toLowerCase();
  const kept = graduationVerdicts.get(key);
  if (!fresh && kept && Date.now() - kept.at < GRADUATION_TTL_MS) return kept.why;
  const ask = (to, data) => how.call(to, data);
  // THE IDS FROM policyIds, kept for a minute for a quote and asked again for
  // a send: a scope or id that could not be read is null, as it always was.
  const ids = await policyIds(how, how.quote, fresh).catch(() => ({ none: true }));
  const [sendP, receiveP, executeP] = ids.none ? [null, null, null] : [ids.send, ids.receive, ids.execute];
  const parties = [
    { who: curve, name: "this launch's curve", asks: [["send", sendP], ["receive", receiveP]] },
    { who: graduator, name: "the Graduator", asks: [["receive", receiveP], ["send", sendP]] },
    { who: POOL_MANAGER, name: "Uniswap's PoolManager", asks: [["receive", receiveP]] },
    { who: PERMIT2, name: "Permit2", asks: [["move", executeP]] },
  ];
  const sym = how.quoteSym || quoteSym;
  let why = null;
  if (sendP !== null || receiveP !== null || executeP !== null) {
    const asked = parties.flatMap((p) => p.asks.filter(([, id]) => id !== null && id !== 0n).map(([verb, id]) => ({ p, verb, id })));
    const answers = await Promise.all(asked.map((a) => ask(POLICY_REGISTRY, SEL.isAuthorized + pad32Num(a.id) + pad32(a.p.who))
      .then((r) => { const w = words(r); return w.length ? wordToBig(w[0]) === 1n : null; }).catch(() => null)));
    const no = asked.find((a, i) => answers[i] === false);
    if (no) why = "the issuer of " + sym + " does not let " + no.p.name + " " + no.verb + " it (policy " + no.id + ")";
  } else {
    const listed = await Promise.all(parties.map((p) => coinBlacklists(how.quote, p.who, ask)));
    const i = listed.findIndex(Boolean);
    if (i >= 0) why = "the issuer of " + sym + " has blacklisted " + parties[i].name;
  }
  const sentence = why === null ? null
    : "This launch could not graduate: " + why + ", and graduating moves the curve's reserve through the curve, the " +
      "Graduator, Permit2 and Uniswap's PoolManager. Once its curve fills, its holders could neither sell on it nor " +
      "trade in a pool, so no buy is sent. Selling stays open.";
  graduationVerdicts.set(key, { at: Date.now(), why: sentence });
  return sentence;
}

/// WHETHER A CLAIM FROM `payer` TO `who` WOULD PASS THE ISSUER: the claimant's
/// receiving side, the payer's sending side. See policyAllows.
async function claimStanding(quote, payer, who, callFn) {
  const [receiver, sender] = await Promise.all([
    policyAllows(quote, who, "receive", callFn),
    payer ? policyAllows(quote, payer, "send", callFn) : Promise.resolve({ known: false }),
  ]);
  return {
    claimantBlocked: receiver.known && !receiver.allowed, claimantPolicy: receiver.policy,
    payerBlocked: sender.known && !sender.allowed, payerPolicy: sender.policy,
  };
}

async function factoryContext() {
  const f = chainCfg.factory.toLowerCase();
  // THE CACHE HOLDS WHAT CANNOT CHANGE. The platform policy can - the hook's
  // owner executes an announced change whenever the delay allows - so it is
  // read on every call and never cached, and neither is a failed read of it.
  // It used to be cached with the rest: a change that landed while the page
  // was open went unseen until a create was refused, and one dropped reply
  // blocked creating for the session behind advice ("Refresh") that could not
  // clear it.
  if (cache[f]) return withPolicy(cache[f]);
  // IN THREE ROUNDS, each read waiting only for what it needs: the factory's
  // own answers together (its registry, asset, Graduator and terms), then what
  // each of them leads to (the hook, the asset's decimals and symbol, the
  // catalog), then the hook's WETH. One after another they were nine round
  // trips before a token's page could draw (17 October 2026). Every read is
  // checked as it was; any one that throws leaves the context uncached.
  // THE SYMBOL MAY FALL BACK TO THE ADDRESS (symbolOf), and that is shown - but
  // a fallback forced by a reply that never came is not the asset's answer, so
  // it is not cached: the next refresh asks again. It used to be kept for the
  // session as quoteSym after one dropped reply (round 5, S19). A revert IS the
  // asset's answer, and is kept.
  let symbolUnanswered = false;
  // THE TERMS THIS FACTORY FIXES, read once and cached with the rest of the
  // context. They are per asset - the threshold especially - so a number
  // written into the page would be right for one factory and wrong for six.
  // ZERO ONLY FOR "NO SUCH FUNCTION": a revert that carries nothing
  // (lacksFunction), which is what a factory built before a term existed
  // answers a call to it with, or a call that returns no words at all - and
  // zero is the true reading there. EVERYTHING ELSE THROWS, so this context is
  // not cached and the next refresh asks again. A dropped reply used to be
  // cached as zero (round 4, S19); then any answer FROM THE NODE was, and a node
  // answers a rate limit (-32016) or its own failure in that same shape - one
  // such reply turned the dev buy ceiling into
  // 100% of the threshold and the threshold into 0 for the session (round 5,
  // N06). A revert that carries data is the contract refusing for a reason of
  // its own, not a function it lacks, and throws too; so does a reply with
  // neither a result nor an error (rpcAt).
  const readOr0 = async (selector) => {
    try { const w = words(await call(f, selector)); return w.length ? wordToBig(w[0]) : 0n; }
    catch (e) { if (lacksFunction(e)) return 0n; throw e; }
  };
  const [registry, quote, graduator, supply, threshold, maxDevBuyBps, phantomQuote] = await Promise.all([
    call(f, SEL.registry).then((r) => oneAddress(r, `The factory's registry()`)),
    call(f, SEL.quoteToken).then((r) => oneAddress(r, `The factory's quoteToken()`)),
    call(f, SEL.graduator).then((r) => oneAddress(r, "The factory's graduator()")),
    readOr0(SEL.factorySupply),
    readOr0(SEL.graduationThreshold),
    readOr0(SEL.maxDevBuyBps),
    // Zero on a factory that does not answer, and then the form prices no
    // first buy at all rather than guessing at one.
    readOr0(SEL.phantomQuote),
  ]);
  // THE SHARING CATALOG, through the Graduator this factory hands its launches
  // to. Both links are immutable, so they are cached with the rest; what the
  // catalog says is not (withPolicy reads it on every call). A Graduator from
  // before holder sharing has no sharingCatalog() - a revert that carries
  // nothing - and offers no sharing: null. Any other failure throws, as the
  // terms above do, so a dropped reply is not cached as "no sharing here".
  const [hook, decimalsRaw, quoteSym, catalog] = await Promise.all([
    call(registry, SEL.requiredHook).then((r) => oneAddress(r, `The registry's requiredHook()`)),
    call(quote, SEL.decimals).then((r) => words(r)),
    symbolOf(quote, (to, data) => call(to, data).catch((e) => {
      if (!isRevert(e)) symbolUnanswered = true;
      throw e;
    })),
    call(graduator, SEL.sharingCatalog).then(
      (r) => { const w = words(r); return w.length ? wordToAddress(w[0]) : null; },
      (e) => { if (!lacksFunction(e)) throw e; return null; },
    ),
  ]);
  if (!decimalsRaw.length) throw new Error(`The quote asset at ${quote} did not answer decimals().`);

  // DOES THE HOOK ACTUALLY UNWRAP? A hook that has the WETH constant has
  // the code that pays ether; one that predates it answers nothing and the
  // card must not promise ether on its behalf. AUDIT A-4.
  // "ANSWERS NOTHING" IS A HOOK WITHOUT THE FUNCTION - a revert with nothing in
  // it, or no word back. A reply that never came is not that: it used to become
  // "does not unwrap", cached for the session, so a WETH pair said "claimed as
  // WETH" after one rate-limited reply (round 5, S19). It throws now, like the
  // terms above.
  let unwrapsWeth = false;
  try {
    const w = words(await call(hook, SEL.hookWeth));
    unwrapsWeth = w.length > 0 && same(wordToAddress(w[0]), WETH);
  } catch (e) {
    if (!lacksFunction(e)) throw e;
    unwrapsWeth = false;
  }
  // THE PLATFORM'S SHARE, FROM THE HOOK THIS FACTORY IS BOUND TO. launch()
  // reads it from there and freezes it into the curve, so this is the number a
  // creator's split is actually made of - and it can be changed, behind the
  // hook's announced delay, for launches created after the change. Read in
  // withPolicy(), below, on every call.
  const base = {
    factory: f,
    registry, quote, hook, quoteSym, quoteDecimals: Number(wordToBig(decimalsRaw[0])),
    supply, threshold, phantomQuote,
    // Zero means a factory built before the ceiling existed.
    maxDevBuyBps: maxDevBuyBps === 0n ? DEFAULT_MAX_DEV_BUY_BPS : maxDevBuyBps,
    unwrapsWeth,
    graduator, catalog,
  };
  if (!symbolUnanswered) cache[f] = base;
  return withPolicy(base);
}

/// The factory's context plus the platform policy AS IT IS NOW.
///
/// FROM THE FACTORY, WHICH READS IT WHERE launch() DOES. Walking to the hook
/// by hand would be a second way of finding the same number. BOTH WORDS ARE
/// KEPT: the recipient is what createLaunch carries into the calldata.
/// platformKnown false means the read failed; every place that would show the
/// share says it is unread instead (platformShareBps), and nothing about the
/// failure is remembered.
async function withPolicy(base) {
  let platformBps = 0n;
  let platformTo = null;
  let platformKnown = false;
  // THE SHARING OFFER ALONGSIDE, not after: both are fresh reads on every call.
  const offer = sharingOffer(base);
  try {
    const w = words(await call(base.factory, SEL.currentPlatformPolicy));
    if (w.length >= 2) {
      platformBps = wordToBig(w[0]);
      platformTo = wordToAddress(w[1]);
      platformKnown = true;
    }
  } catch { platformKnown = false; }
  return { ...base, platformBps, platformTo, platformKnown, sharing: await offer };
}

/// WHAT HOLDER SHARING THIS FACTORY'S LAUNCHES CAN BE SWITCHED TO, AS THE
/// CATALOG SAYS IT NOW: its recommended distributor version, whether it is
/// approved, and that version's number. Never cached - the catalog's owner can
/// retire a version at once - and never a guess: a read that failed is
/// { known: false }, and the form then offers nothing and says why.
/// @return { known, catalog, factory, approved, version } - `factory` is the
///         zero address when the catalog recommends none.
async function sharingOffer(base, callFn = call) {
  if (!base.catalog) return { known: true, catalog: null, factory: ZERO_ADDRESS, approved: false, version: null };
  try {
    const rec = oneAddress(await callFn(base.catalog, SEL.catalogRecommended), "The catalog's recommended()");
    if (same(rec, ZERO_ADDRESS)) return { known: true, catalog: base.catalog, factory: rec, approved: false, version: null };
    const [ok, ver] = await Promise.all([
      callFn(base.catalog, SEL.catalogIsApproved + pad32(rec)),
      callFn(rec, SEL.distributorVersion).catch(() => "0x"),
    ]);
    const okW = words(ok);
    if (!okW.length) throw new Error("the catalog did not answer isApproved()");
    const verW = words(ver);
    return {
      known: true, catalog: base.catalog, factory: rec,
      approved: wordToBig(okW[0]) === 1n,
      version: verW.length ? wordToBig(verW[0]) : null,
    };
  } catch {
    return { known: false, catalog: base.catalog, factory: ZERO_ADDRESS, approved: false, version: null };
  }
}

/// The lens's LaunchView, flat: fourteen static words.
/// @param how  { call, lens } - the endpoint and lens to read through. Actions
///             pass their pinned pair; rendering passes the live one.
async function readLaunchWith(how, token) {
  const raw = await how.call(how.lens, SEL.launchState + pad32(token));
  const w = words(raw);
  if (w.length < 14) throw new Error("the lens returned " + w.length + " words, expected 14");
  // WORDS 14 AND 15 (launchedAt, the holder distributor) ARE NOT TAKEN FROM
  // THE LENS: the drawn launch reads both from the registry and the Graduator
  // (refresh), and an action from the pinned Graduator (beginAction).
  return {
    status: Number(wordToBig(w[0])),
    curve: wordToAddress(w[1]),
    quoteToken: wordToAddress(w[2]),
    beneficiary: wordToAddress(w[3]),
    quoteReserve: wordToBig(w[4]),
    tokenReserve: wordToBig(w[5]),
    realQuoteReserve: wordToBig(w[6]),
    graduationThreshold: wordToBig(w[7]),
    totalSupply: wordToBig(w[8]),
    poolKey: {
      currency0: wordToAddress(w[9]),
      currency1: wordToAddress(w[10]),
      fee: wordToBig(w[11]),
      tickSpacing: wordToInt(w[12], 24),
      hooks: wordToAddress(w[13]),
    },
  };
}

const readLaunch = (token) => readLaunchWith({ call, lens: chainCfg.lens }, token);

const erc20 = {
  balanceOf: async (t, who) => wordToBig(words(await call(t, SEL.balanceOf + pad32(who)))[0]),
  allowance: async (t, owner, spender) =>
    wordToBig(words(await call(t, SEL.allowance + pad32(owner) + pad32(spender)))[0]),
  decimals: async (t) => Number(wordToBig(words(await call(t, SEL.decimals))[0])),
};

function poolId(key) {
  return keccak256(
    encode([T.tuple([T.address, T.address, T.uint(24), T.int(24), T.address])], [
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ])
  );
}

async function poolStateWith(how, key) {
  const id = poolId(key);
  const slot0 = words(await how.call(STATE_VIEW, SEL.getSlot0 + id.replace(/^0x/, "")));
  const liq = wordToBig(words(await how.call(STATE_VIEW, SEL.getLiquidity + id.replace(/^0x/, "")))[0]);
  return { sqrtPriceX96: wordToBig(slot0[0]), liquidity: liq, id };
}

const poolState = (key) => poolStateWith({ call }, key);

// ---------------------------------------------------------------- the quotes
//
// THE CURVE'S ARITHMETIC, MIRRORED. PonsV2BondingCurve takes both fees off the
// INPUT on a buy and off the OUTPUT on a sell, and the swap itself is constant
// product with the fee argument zero. Integer division throughout, rounding the
// way Solidity rounds, because a quote that is one wei out on the last digit is
// a quote that disagrees with the chain.
const BPS = 10000n;
const amountOut = (amtIn, rIn, rOut) => (amtIn * rOut) / (rIn + amtIn);

/// getAmountIn, as PonsV2BondingCurveMath computes it: numerator over
/// denominator, PLUS ONE. The +1 is not a rounding nicety - it is what makes
/// the input enough - and a preview without it is a wei short of the contract.
function amountIn(out, rIn, rOut) {
  if (rOut <= out) return null;
  return (out * rIn * BPS) / ((rOut - out) * BPS) + 1n;
}

/// THE LAST BUY IS NOT PRICED LIKE THE OTHERS, and the first version of this
/// showed it as though it were: it clamped the token output to what was left
/// and went on charging fees on the whole amount offered. The contract does
/// something different - it prices the clamped fill from the token side, grosses
/// that back up so the fee legs still come out of the input, spends only that,
/// and REFUNDS the rest. Offered, spent, refunded and charged are four numbers,
/// and on this one trade they are not the same number.
function quoteBuy(offered, r, fees, sellable) {
  let spent = offered;
  let fee = (spent * fees.fee) / BPS;
  let tax = (spent * fees.tax) / BPS;
  let out = 0n;
  if (spent - fee - tax > 0n) out = amountOut(spent - fee - tax, r.quote, r.token);

  let clamped = false;
  if (out > sellable) {
    clamped = true;
    out = sellable;
    const need = amountIn(sellable, r.quote, r.token);
    if (need === null) {
      return { offered, spent: 0n, refund: offered, fee: 0n, tax: 0n, net: 0n, out: 0n, clamped, unpriceable: true };
    }
    // Grossed up so the fees come out of the input, rounding UP as the contract
    // does, then capped at what was actually offered.
    const denom = BPS - fees.fee - fees.tax;
    const grossed = (need * BPS + denom - 1n) / denom;
    spent = grossed < offered ? grossed : offered;
    fee = (spent * fees.fee) / BPS;
    tax = (spent * fees.tax) / BPS;
  }
  return { offered, spent, refund: offered - spent, fee, tax, net: spent - fee - tax, out, clamped };
}

function quoteSell(tokensIn, r, fees) {
  const gross = amountOut(tokensIn, r.token, r.quote);
  const fee = (gross * fees.fee) / BPS;
  const tax = (gross * fees.tax) / BPS;
  return { out: gross - fee - tax, fee, tax, gross };
}

// THE POOL'S ARITHMETIC. The graduation position is FULL RANGE, so a swap
// cannot leave it and the single-range formulas are exact rather than an
// approximation.
//
// THE ORDER MATTERS AND IT IS NOT THE ORDER IT USED TO BE. The hook took its
// share of the OUTPUT, so it was subtracted last. The tax is on the NVDAc side
// now, which means:
//
//   BUY   the tax comes off the INPUT FIRST. What the pool prices - and what
//         the LP fee applies to - is the amount AFTER the tax. Getting this
//         order wrong makes the quote wrong by the whole tax.
//   SELL  the LP fee and the swap happen first, and the tax comes off the
//         NVDAc that comes out.
//
// `tax` is { taxBps, platformBps, quoteIsInput } for this pool, read from the
// hook. A null tax means no hook, and the quote is a bare pool swap.
/// THE POOL'S OWN TAX, READ FROM THE HOOK, FOR THIS POOL. Never a constant:
/// the creator chose it when the launch was created, and two launches on the
/// same deployment charge different amounts. A pool with no hook, or one the
/// hook has no record for, quotes as an untaxed swap - and the send would then
/// fail rather than quietly cost more, because the hook refuses it.
async function poolTax(w, key, quoteIsInput) {
  const hook = key.hooks;
  if (!hook || /^0x0{40}$/i.test(hook)) return null;
  const cfg = words(await w.call(hook, SEL.taxOfId + poolId(key).replace(/^0x/, "")));
  if (wordToBig(cfg[3]) !== 1n) return null;
  // THIS POOL'S SHARE, FROM ITS OWN RECORD. Asking the hook for its current
  // one would report what the NEXT launch gets stamped with. FeeHook.LaunchFee.
  return { taxBps: wordToBig(cfg[0]), platformBps: wordToBig(cfg[5]), quoteIsInput };
}

/// WHAT THE POOL WOULD ACTUALLY PAY, ASKED OF THE CHAIN.
///
/// The Quoter runs the swap inside poolManager.unlock and reverts with the
/// result, so what comes back has crossed whatever ticks the trade crosses and
/// has been through this pool's hook - including its tax, because the hook
/// returns a delta on both sides. quotePoolSwap below cannot do the first of
/// those and should not be asked to.
///
/// null RATHER THAN A GUESS when it cannot answer. The caller decides what to
/// do with that, and the panel says which number it ended up showing.
///
/// CANCELLED, NOT MERELY ABANDONED, for the reason rpcAt's signal exists: a
/// simulation against a pool it cannot price can sit for minutes, and a
/// request nobody is waiting for still holds a connection.
async function quoteV4(w, key, zeroForOne, amountIn) {
  const abort = typeof AbortController === "function" ? new AbortController() : null;
  let timer;
  try {
    const data = SEL.quoteExactInputSingleV4 + encode(
      [T.tuple([
        T.tuple([T.address, T.address, T.uint(24), T.int(24), T.address]),
        T.bool, T.uint(128), T.bytes,
      ])],
      [[[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks], zeroForOne, amountIn, "0x"]]
    ).slice(2);
    const raw = await Promise.race([
      w.call(V4_QUOTER, data, abort ? abort.signal : undefined, QUOTE_GAS),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          if (abort) abort.abort();
          reject(new Error("the v4 quote timed out"));
        }, QUOTE_TIMEOUT_MS);
      }),
    ]);
    const w0 = words(raw);
    return w0.length ? wordToBig(w0[0]) : null;
  } catch {
    if (abort) abort.abort();
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function quotePoolSwap(pool, zeroForOne, amountIn, feePips, tax) {
  const { sqrtPriceX96: P, liquidity: L } = pool;
  if (L === 0n || P === 0n) return null;

  const legs = (base) => {
    if (!tax) return { platform: 0n, creator: 0n };
    return {
      platform: (base * tax.platformBps) / BPS,
      creator: (base * (tax.taxBps - tax.platformBps)) / BPS,
    };
  };

  // On a buy the tax is taken before anything else happens.
  const inTax = tax && tax.quoteIsInput ? legs(amountIn) : { platform: 0n, creator: 0n };
  const swapIn = amountIn - inTax.platform - inTax.creator;
  if (swapIn <= 0n) return null;

  const lpFee = (swapIn * feePips + 999999n) / 1000000n; // rounds up, as v4 does
  const inAfterFee = swapIn - lpFee;
  if (inAfterFee <= 0n) return null;

  let out;
  if (zeroForOne) {
    // sqrtNext = L*Q96*P / (L*Q96 + dx*P), rounding up
    const num = L * Q96 * P;
    const den = L * Q96 + inAfterFee * P;
    const sqrtNext = (num + den - 1n) / den;
    out = (L * (P - sqrtNext)) / Q96;
  } else {
    const sqrtNext = P + (inAfterFee * Q96) / L;
    out = (L * Q96 * (sqrtNext - P)) / (sqrtNext * P);
  }
  // And on a sell it is taken from what came out.
  const outTax = tax && !tax.quoteIsInput ? legs(out) : { platform: 0n, creator: 0n };
  const platform = inTax.platform + outTax.platform;
  const creator = inTax.creator + outTax.creator;
  return {
    out: out - outTax.platform - outTax.creator,
    lpFee,
    platform,
    creator,
    taxOnInput: tax ? tax.quoteIsInput : false,
    gross: out,
    taxBps: tax ? tax.taxBps : 0n,
    platformBps: tax ? tax.platformBps : 0n,
  };
}

/// WHAT THE WHOLE TRADE COSTS AGAINST MID, in basis points.
///
///     cost = 1 - (what you get) / (what the mid price says you should get)
///
/// EVERY LEG THE TRANSACTION HAS IS IN IT. On the ETH route that is the v3
/// conversion AND our pool - somebody pressing the ETH button pays both,
/// whoever collects them - and on the direct route it is our pool alone.
///
/// IT IS A SHORTFALL AGAINST MID AND NOTHING ELSE. Not gas, which is paid in
/// ETH on top and is not part of a price; not the price moving between this
/// quote and the send. It is the definition DEPTH.txt measures with, so the two
/// can be held next to each other.
///
/// NULL RATHER THAN A GUESS. A missing mid removes the line. It never falls
/// back to a different number and keeps the same label.
function totalCostBps(v) {
  if (!v || !v.pool || !v.q || !v.pool.sqrtPriceX96) return null;
  const P = v.pool.sqrtPriceX96;

  let expected;
  if (v.via === "eth") {
    // A DIRECT ROUTE HAS NO MID TO READ AND NEEDS NONE: one wrapped ether is
    // one ether, so the conversion leg is the identity and the whole cost is
    // the pool's. Without this the cost line disappeared on exactly the pair
    // this product puts first.
    const direct = !!(v.route && v.route.direct);
    if (!direct && (!v.v3Mid || !v.v3Mid.legs || !v.v3Mid.legs.length)) return null;
    if (v.side === "buy") {
      const quoteAtMid = direct ? v.amount : convertAtV3Mid(v.v3Mid, v.amount, true);
      expected = poolAtMid(P, v.tokenIsC0, "buy", quoteAtMid);      // the quote asset -> token
    } else {
      const quoteAtMid = poolAtMid(P, v.tokenIsC0, "sell", v.amount); // token -> the quote asset
      expected = direct ? quoteAtMid : convertAtV3Mid(v.v3Mid, quoteAtMid, false);
    }
  } else {
    expected = poolAtMid(P, v.tokenIsC0, v.side, v.amount);
  }
  if (expected <= 0n || v.out === undefined || v.out === null) return null;
  // A TRADE CANNOT BEAT THE MID. If it reads as though it did, the price this
  // was measured against is not the price the trade happened at, and a
  // negative "cost" would be a lie in the reassuring direction.
  if (v.out > expected) return null;
  return Number(((expected - v.out) * 20000n / expected + 1n) / 2n);
}

const withSlippage = (out, bps) => (out * (BPS - BigInt(bps))) / BPS;

/// WHAT A CURVE TRADE COSTS AGAINST THE CURVE'S OWN MID, in basis points.
///
/// The curve has no LP fee and no conversion leg - it is one hop - so this is
/// the platform's cut, the creator's cut and the curve's own movement.
///
/// ON A CLAMPED BUY THE COST IS ON WHAT WAS SPENT. The last buy takes only as
/// much as the allocation still needs and REFUNDS the rest; that refund never
/// left the buyer, so charging it as a cost would report a loss nobody took.
/// It is the same rule the pool tables use for a partial fill.
///
/// NULL RATHER THAN A GUESS when the reserves are not there to price against.
function curveCostBps(v) {
  const r = v && v.reserves;
  if (!v || !v.q || !r || r.quote === 0n || r.token === 0n) return null;
  let expected;
  if (v.side === "buy") {
    if (v.q.spent === undefined || v.q.spent <= 0n) return null;
    expected = (v.q.spent * r.token) / r.quote;     // tokens at mid for what was spent
  } else {
    expected = (v.amount * r.quote) / r.token;      // the quote asset at mid for the tokens sold
  }
  if (expected <= 0n || v.q.out === undefined) return null;
  if (v.q.out > expected) return null;              // cannot be better than mid
  return Number(((expected - v.q.out) * 20000n / expected + 1n) / 2n);
}

/// THE BOUND A CURVE BUY IS SENT WITH.
///
/// THE CURVE'S BOUND IS A PRICE, NOT AN AMOUNT (PonsV2BondingCurve.buy): it
/// refuses when spent * minTokensOut > received * tokensOut - the tokens per
/// unit actually spent, against minTokensOut per unit offered. For a buy that
/// spends all it offers that is just tokensOut >= minTokensOut. For the buy the
/// threshold clamps it is not: it spends a fraction of what it offers, and the
/// slippage taken off the clamped amount allowed a price as much worse as the
/// offer was larger than the spend. Offer 999 ETH for a fill that costs 5 and
/// "1% slippage" accepted 200 times fewer tokens per ETH - a buyer ahead of it
/// could take most of what was left and this one would still go through, for
/// a sliver, at the top of the curve (the owner's "999 ETH at 1%" note).
///
/// SO A CLAMPED BUY'S BOUND IS THE QUOTED PRICE, minus the slippage, scaled to
/// what is offered: the curve then holds the fill to that many tokens per unit
/// SPENT, as an unclamped buy is held. Unclamped, this is the old bound.
function buyMin(q, bps) {
  if (!q.clamped || !(q.spent > 0n)) return withSlippage(q.out, bps);
  return withSlippage((q.out * q.offered) / q.spent, bps);
}

/// THE TRADE'S OWN PRICE IMPACT, in basis points: how much worse its average
/// price is than the price before it, the fees and the tax left out - those
/// are on their own rows. (The total cost row is the two together.)
function impactBps(expected, got) {
  if (!(expected > 0n) || got === undefined || got === null) return null;
  if (got >= expected) return 0;
  return Number(((expected - got) * 20000n / expected + 1n) / 2n);
}
/// On the curve: what reaches it (net of fee and tax) priced at its reserves'
/// ratio, against what it pays out. A clamped buy is measured on what it spends.
/// @return { bps, after } - after is the curve's price once this trade is done,
///         as a multiple of its price now (constant product: the quote reserve's
///         growth, squared) - or null when the reserves are not there.
function curveImpact(v) {
  const r = v && v.reserves;
  if (!v || !v.q || !r || r.quote === 0n || r.token === 0n) return null;
  if (v.side === "buy") {
    const net = v.q.net;
    if (!(net > 0n)) return null;
    const grow = Number(r.quote + net) / Number(r.quote);
    return { bps: impactBps((net * r.token) / r.quote, v.q.out), after: grow * grow };
  }
  const shrink = Number(r.token) / Number(r.token + v.amount);
  return { bps: impactBps((v.amount * r.quote) / r.token, v.q.gross), after: shrink * shrink };
}
/// In the pool: what reaches the v4 leg after the tax on the way in and the
/// pool's fee, at the pool's mid, against what that leg pays before the tax on
/// the way out. The v3 conversion on the ETH route is not in it.
function poolImpact(v) {
  if (!v || !v.q || !v.pool || !v.pool.sqrtPriceX96) return null;
  const q = v.q;
  const amountIn = v.via === "eth" && v.side === "buy" ? v.mid : v.amount;
  if (!(amountIn > 0n)) return null;
  const net = amountIn - (q.taxOnInput ? q.platform + q.creator : 0n) - q.lpFee;
  if (!(net > 0n)) return null;
  return { bps: impactBps(poolAtMid(v.pool.sqrtPriceX96, v.tokenIsC0, v.side, net), q.gross), after: null };
}
/// WARNED ABOVE 5%, AND STRONGLY ABOVE 15% (the owner's thresholds).
const IMPACT_WARN_BPS = 500;
const IMPACT_STRONG_BPS = 1500;
const impactLevel = (bps) => bps === null ? "" : bps > IMPACT_STRONG_BPS ? "strong" : bps > IMPACT_WARN_BPS ? "warn" : "";
/// The figure, as both pages print it: "12.34%".
const impactText = (bps) => (bps / 100).toFixed(2) + "%";
/// What the price does, in words, when it moves a lot.
function afterWords(side, after) {
  if (!(after > 0) || !isFinite(after)) return "";
  if (side === "buy" && after >= 1.5) {
    return " It moves the curve's price to " + (after >= 10 ? Math.round(after).toLocaleString("en-US") : after.toFixed(1)) +
      "× what it is now.";
  }
  if (side === "sell" && after <= 0.67) return " It moves the curve's price down to " + Math.round(after * 100) + "% of what it is now.";
  return "";
}
/// The warning under the figure, or "".
function impactWarning(imp, side) {
  if (!imp || imp.bps === null) return "";
  const lvl = impactLevel(imp.bps);
  if (!lvl) return "";
  const pct = impactText(imp.bps);
  return lvl === "strong"
    ? `VERY HIGH PRICE IMPACT: ${pct}. This ${side} is large against what the curve or pool holds, so its ` +
      `average price is ${pct} worse than the price now - on top of the fee and the tax.` + afterWords(side, imp.after) +
      ` A smaller amount, or several, costs less.`
    : `High price impact: ${pct} worse than the price now, before the fee and the tax.` + afterWords(side, imp.after);
}

/// THE UNISWAP LEG AGAINST THE MARKET (the owner's report: on a fork whose
/// WETH/NVDAc pool had been emptied, 22 ETH bought 0.0000005 NVDAc, and the
/// page priced the curve and said nothing about the swap before it). What the
/// leg between ETH and the pair's asset pays, valued at Chainlink's prices,
/// against what goes into it: the shortfall in basis points - the pool's fee,
/// its depth and any price it has been pushed to, together. Warned above 5%
/// and strongly above 15%, as a trade's own impact is; ABOVE 50% NOTHING IS
/// SENT - the asset itself can be paid or received instead.
const CONV_BLOCK_BPS = 5000;
const CONV_TTL_MS = 60 * 1000;
/// HOW LONG THE LAST GOOD PRICE STANDS IN FOR A READ THAT FAILED: a feed read
/// refused under load (a 429) is asked again on the next quote, and meanwhile
/// a price a few minutes old checks the swap as well as a fresh one would.
const CONV_FALLBACK_MS = 15 * 60 * 1000;
const convPrices = new Map();   // rpc|asset -> { at, per } - per null when every read answered and there is no price
/// Dollars per whole unit by the asset's OWN feed - never through the Uniswap
/// market the leg trades in, which is what is being checked.
/// @return { per } - or per null and why: "failed" when a read threw and no
///         good price from the last CONV_FALLBACK_MS is kept, "nofeed" when
///         every read answered and the asset has no feed that names itself.
async function feedPer(w, asset, decimals) {
  const key = (w.rpc || "") + "|" + asset.toLowerCase();
  const kept = convPrices.get(key);
  if (kept && Date.now() - kept.at < CONV_TTL_MS) return kept.per ? { per: kept.per } : { per: null, why: "nofeed" };
  if (!window.CurbPrices) return { per: null, why: "failed" };
  const r = await window.CurbPrices.usdPerQuote({ call: (to, data) => w.call(to, data), quote: asset, decimals })
    .catch(() => ({ per: null, failed: true }));
  if (!r.failed) {
    convPrices.set(key, { at: Date.now(), per: r.per });
    return r.per ? { per: r.per } : { per: null, why: "nofeed" };
  }
  if (kept && kept.per && Date.now() - kept.at < CONV_FALLBACK_MS) return { per: kept.per };
  return { per: null, why: "failed" };
}
/// @return the quote with conv: { bps } added, or an error past the block - or,
///         when either price could not be had, with convUnchecked: { why }, and
///         every send refuses it (convUncheckedRefusal).
///
/// FAIL CLOSED. A feed read that failed used to return the quote with no
/// conversion line at all: no warning and no block, on screen or at the send,
/// exactly when an endpoint under load refuses reads - and the owner's own
/// drained pool had 22 ETH buy 0.0000005 NVDAc. Now the card says the swap is
/// not checked, and nothing is sent through it until it is.
async function withConversion(w, v) {
  if (!v || v.error || !w.quote || same(w.quote, WETH)) return v;
  const buy = v.side === "buy";
  const ethAmt = buy ? v.amount : v.ethOut !== undefined ? v.ethOut : v.out;
  const qAmt = buy ? v.mid : v.via === "router" ? (v.q && v.q.out) : v.mid;
  if (!(ethAmt > 0n) || !(qAmt > 0n)) return v;
  const [ethFeed, quoteFeed] = await Promise.all([feedPer(w, WETH, 18), feedPer(w, w.quote, w.quoteDecimals)]);
  const eth = ethFeed.per;
  const per = quoteFeed.per;
  if (!eth || !per) {
    const sym = w.quoteSym || quoteSym;
    const missing = !eth ? { what: "ETH", why: ethFeed.why } : { what: sym, why: quoteFeed.why };
    v.convUnchecked = {
      why: missing.why === "nofeed"
        ? missing.what + " has no Chainlink price this page can check it against"
        : "the Chainlink price of " + missing.what + " could not be read just now",
    };
    return v;
  }
  const ethUsd = window.CurbPrices.toFloat(ethAmt, 18) * eth;
  const qUsd = window.CurbPrices.toFloat(qAmt, w.quoteDecimals) * per;
  const given = buy ? ethUsd : qUsd;
  const got = buy ? qUsd : ethUsd;
  if (!(given > 0)) return v;
  const bps = got >= given ? 0 : Math.round((1 - got / given) * 10000);
  if (bps > CONV_BLOCK_BPS) {
    const sym = w.quoteSym || quoteSym;
    return {
      error: `The swap ${buy ? "from ETH into " + sym : "from " + sym + " into ETH"} would pay ${impactText(bps)} less ` +
        `than the market price (Chainlink): the pool it swaps through is too thin, or too far off, for this amount. Nothing is ` +
        `sent - ${buy ? "pay with " + sym : "receive " + sym} instead, or use a smaller amount.`,
      conv: { bps, blocked: true },
    };
  }
  v.conv = { bps };
  return v;
}
/// WHAT A SWAP NOBODY COULD CHECK SAYS, under the quote (withConversion).
function uncheckedWords(v, sym) {
  if (!v || !v.convUnchecked) return "";
  return "Conversion not checked against Chainlink: " + v.convUnchecked.why + ". A thin or pushed pool " +
    "can pay far less than the market, so nothing is sent " + (v.side === "buy" ? "with ETH" : "for ETH") +
    " until it is checked - " + (v.side === "buy" ? "pay with " : "receive ") + sym + " instead, or try again in a moment.";
}
/// THE SEND'S REFUSAL OF AN UNCHECKED SWAP, asked by every send that quoted one.
function convUncheckedRefusal(v, sym) {
  if (!v || !v.convUnchecked) return null;
  return "Nothing was sent: the swap " + (v.side === "buy" ? "from ETH into " + sym : "from " + sym + " into ETH") +
    " could not be checked against Chainlink's price (" + v.convUnchecked.why + "), and unchecked a thin or pushed " +
    "pool can pay far less than the market. " + (v.side === "buy" ? "Pay with " : "Receive ") + sym +
    " instead, or try again in a moment.";
}
/// The conversion's line, or "": the figure and, past 5%, what it means.
function conversionWords(v, sym) {
  if (!v || !v.conv) return "";
  const lvl = impactLevel(v.conv.bps);
  if (!lvl) return "";
  const pct = impactText(v.conv.bps);
  const leg = v.side === "buy" ? "ETH into " + sym : sym + " into ETH";
  return lvl === "strong"
    ? `VERY COSTLY CONVERSION: the swap of ${leg} pays ${pct} less than the market price (Chainlink), before the ` +
      `curve or the pool. Paying with ${sym} itself, or a smaller amount, costs less.`
    : `The swap of ${leg} pays ${pct} less than the market price (Chainlink).`;
}

// ---------------------------------------------------------------- rendering
let view = null;      // the last read launch
/// WHAT IS ON SCREEN - { token, factory, lens, rpc } as the form held them
/// when refresh() started the read it drew - set only once renderLaunch has
/// finished drawing that launch, quote rows included, and null with `view`.
/// The form moves the moment a field changes and the drawing only when the
/// reads land; beginAction holds a trade to this, not to the form (round 5,
/// N05). While a new launch is being drawn it still names the last one.
let viewFor = null;
let ctx = null;       // factory context
/// WHETHER THE PERSON CHOSE THIS FACTORY, as opposed to a link or storage
/// handing it over. Set by the factory field and the asset picker; cleared when
/// another launch or lens is loaded. The automatic switch in refresh() only
/// ever moves a factory nobody chose.
let factoryChosen = false;
/// WHAT THE LAST AUTOMATIC SWITCH SAID, kept on screen until the person next
/// changes an address - a later refresh must not wipe the only explanation of
/// why the factory field holds something they did not type.
let switchNote = null;
/// WHICH LAUNCH THE RESCUE BOX WAS SHOWN FOR - { token, factory, rpc } - or
/// null. renderLaunch() keeps the box only for that launch while it waits.
let rescueFor = null;
function hideRescue() {
  rescueFor = null;
  if ($("rescueBox")) $("rescueBox").hidden = true;
}
/// A create still waiting to be adopted must not be re-pointed under it.
/// Scoped to what adoption depends on (adoptCreated): THIS factory at THIS
/// endpoint, and this account. Any create record anywhere used to disable the
/// switch for good; then the endpoint was left out, and a factory address is
/// only its deployer's nonce - the same deployer makes the same address on
/// another chain - so a record sent through another endpoint still blocked it
/// (round 5, S47).
/// AND THE CHAIN THAT ENDPOINT SERVES NOW. A URL is not a chain: a local node
/// restarted on another chain id answers at the same address, and a record of
/// that other chain is never adopted here (resumePending keeps it as sent
/// "elsewhere", which offers to forget it only an hour on) - so it used to hold
/// the switch for good. `served` is what the endpoint answered just now; when
/// it did not answer, nothing is placed and the record blocks.
/// WHAT THIS DOES NOT TELL APART: a fork restarted at the SAME endpoint serves
/// the same chain id and the same factory address, so nothing a record carries
/// distinguishes it. Such a record blocks until resumePending settles it or
/// the person forgets it by hand. A record that names no endpoint or no chain
/// is older than the field, and still blocks: it cannot be placed.
/// A CREATE ALREADY MINED (`made`) waits for nothing: its launch is known.
const sameChainId = (a, b) => { try { return BigInt(a) === BigInt(b); } catch { return false; } };
const unresolvedCreate = (served) => TX.loadPendingAll().some((t) =>
  t.page === APP_MARK && t.kind === "create" && !t.made && same(t.factory, chainCfg.factory) &&
  (!t.rpc || t.rpc === chainCfg.rpc) && (!t.chainId || !served || sameChainId(t.chainId, served)) &&
  (!account || same(t.from, account)));
/// THE QUOTE ASSET'S TICKER, for the route helpers, which are called without
/// the context object. Set by refresh() the moment the factory is read.
let quoteSym = "the quote asset";
let meta = null;      // token symbol/decimals, balances

/// WHICH QUOTE ASSETS ARE EQUITIES, listed rather than derived.
///
/// THE OBVIOUS DERIVATION IS WRONG. Every B20 equity begins 0xb2 followed by
/// ten zero bytes, so "starts with 0xb2 means stock" looks like it would work -
/// and it would have labelled Basecat, a memecoin at
/// 0xb2000000000000000000004c27f6523082f41d01, as a stock. The B20 prefix says
/// who issued a token, not what it represents.
///
/// So the thirteen are named. A quote asset not in this set is shown as a
/// coin, which is the right default: the list of equities is small, known and
/// slow-moving, and everything else on Base is not an equity.
const EQUITIES = new Set([
  "0xb20000000000000000000078ee7ce2fe4908108c", // NVDAc
  "0xb2000000000000000000007b9fcbd005511acbd5", // SPCXc
  "0xb2000000000000000000002d0ba3164cc74f58b7", // GOOGLc
  "0xb200000000000000000000c2e324d24d7eecd1fb", // AAPLc
  "0xb200000000000000000000ab99cfa739e253872b", // MSFTc
  "0xb2000000000000000000008bc8786b856e61707c", // METAc
  "0xb200000000000000000000d9192b6b456483c2e8", // AMZNc
  "0xb2000000000000000000004884b426556b92883d", // MSTRc
  "0xb2000000000000000000001e800a7f5189430cd0", // TSLAc
  "0xb200000000000000000000397293cb8cda9a10c5", // SNDKc
  "0xb200000000000000000000c85a31389d71f3ecfb", // COINc
  "0xb20000000000000000000019f6e7c675b73c2e4d", // CRCLc
  "0xb2000000000000000000004aff16039ba04bdfbc", // INTCc
]);
const isEquity = (a) => EQUITIES.has((a || "").toLowerCase());

/// WHICH GROUP THE CARDS ARE SHOWING. Kept outside the render so switching
/// the selected asset does not jump the reader back to the first tab.
let quoteTab = "Coins";

/// WHAT A FEE IS CLAIMED AS, which is not always what it was charged in.
///
/// A launch priced against WETH pays its creator and the platform in native
/// ether WHEN THEY CLAIM: the escrow holds the curve's fees and the hook holds
/// every pool fee on a WETH pair, and each unwraps inside its claim - falling
/// back to WETH for a claimant that refuses ether. Nothing is unwrapped, or
/// paid, during a swap. This used to say FeeHook unwrapped on every swap.
/// Every other quote asset pays in itself.
///
/// SEPARATE FROM displaySymbol BELOW ON PURPOSE. That one is a shorter name
/// for the same token; this one is a different token from the one charged,
/// and the difference is the whole point of saying it.
function payoutSymbol() {
  if (!ctx) return "";
  // ASKED, NOT ASSUMED. Comparing the quote asset to a constant says what THIS
  // page believes; it says nothing about whether the deployment on the other
  // end unwraps. Against a hook built before 22 September the card would have
  // announced ether and the claimant would have received the wrapped token.
  // ctx.unwrapsWeth is read from the hook - see factoryContext().
  if (!same(ctx.quote, WETH)) return ctx.quoteSym;
  return ctx.unwrapsWeth ? "ETH" : ctx.quoteSym;
}

/// True when a fee is charged in one thing and paid in another, which is the
/// only case worth spending a line of the screen on.
function payoutDiffers() {
  return !!ctx && payoutSymbol() !== ctx.quoteSym;
}

/// WHAT THE PERSON CHOOSING CALLS IT. WETH is ETH to them, and to both
/// reference launchpads. The card's title still carries the real symbol and
/// the address, so this is a shorter name rather than a different claim.
///
/// ONLY ON THE PICKER, AND TRUE THERE BECAUSE OF WHAT THE SENDS DO. The curve
/// and the factory pull WETH; this page wraps a buyer's or a creator's
/// shortfall from ETH before that (ensureQuoteHeld), claims unwrap to ETH, and
/// the pool has an ETH route. Everywhere an amount is pulled or approved - the
/// curve quote, the dev buy, the approvals, the balances - the real symbol is
/// used, so the line under the number says WETH where WETH moves. Without the
/// wrap this label promised a pair that could not be bought with ETH.
const DISPLAY_SYMBOL = { WETH: "ETH" };
const displaySymbol = (sym) => DISPLAY_SYMBOL[sym] || sym;

/// A COLOUR FROM THE ADDRESS, so a mark is recognisable and two assets are
/// never the same tile. Deterministic: no state, no fetch, same everywhere.
function markColour(address) {
  let h = 0;
  for (let i = 2; i < address.length; i++) h = (h * 31 + address.charCodeAt(i)) >>> 0;
  return "hsl(" + (h % 360) + " 58% 42%)";
}

/// THE CARDS, DRAWN FROM THE SAME GROUPS THE SELECT HOLDS.
///
/// EVERY CARD WRITES TO THE SELECT AND DISPATCHES ITS CHANGE EVENT rather than
/// doing the work itself. One piece of state, one code path - the same one the
/// keyboard and the browser tests take.
///
/// Built with createElement and textContent, never innerHTML: the symbol and
/// the name come off a stranger's contract, which is what AUDIT A-1 was.
function renderQuoteCards(groups) {
  const tabs = $("quoteTabs");
  const grid = $("quoteGrid");
  if (!tabs || !grid) return;
  const present = groups.filter(([, m]) => m.length);
  if (!present.some(([label]) => label === quoteTab)) {
    quoteTab = present.length ? present[0][0] : "Coins";
  }

  tabs.replaceChildren();
  for (const [label, members] of present) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "qtab";
    b.setAttribute("aria-selected", String(label === quoteTab));
    b.textContent = label;
    const count = document.createElement("i");
    count.textContent = String(members.length);
    b.appendChild(count);
    b.addEventListener("click", () => { quoteTab = label; renderQuoteCards(groups); });
    tabs.appendChild(b);
  }

  const members = (present.find(([label]) => label === quoteTab) || [null, []])[1];
  grid.replaceChildren();
  for (const c of members) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "qcard";
    card.setAttribute("aria-pressed", String(same(c.factory, chainCfg.factory)));
    card.title = c.quote;

    const shown = displaySymbol(c.sym);

    const mark = document.createElement("span");
    mark.className = "qmark";
    mark.style.background = markColour(c.quote);
    mark.textContent = (shown || "?").slice(0, 2).toUpperCase();
    // THE REAL LOGO IF THERE IS A FILE FOR IT, the coloured tile if not. The
    // image removes itself when it fails to load, which is what makes an
    // asset with no artwork degrade to the tile instead of to a broken icon.
    // Keyed on the TRUE symbol, not the displayed one: the file for the pair
    // labelled ETH is weth.svg, because WETH is what the contract is.
    const logo = assetLogo(c.sym);
    if (logo) {
      const art = document.createElement("img");
      art.className = "qmarkImg";
      art.alt = "";
      art.addEventListener("error", () => art.remove());
      art.src = logo;
      mark.appendChild(art);
    }
    card.appendChild(mark);

    // TICKER ONLY. The company name was a second line of grey that said what
    // the ticker already says; what it is and where it lives are on the title.
    const sym = document.createElement("span");
    sym.className = "qsym";
    sym.textContent = shown || shortAddress(c.quote);
    card.title = (c.name ? c.name + " — " : "") + (c.sym || "") + " " + c.quote;
    if (c.twin) {
      // ONE OF SEVERAL FACTORIES FOR THIS ASSET: the card says which one, and
      // its terms are on the title (describeTwins).
      const text = document.createElement("span");
      text.className = "qtext";
      const twin = document.createElement("span");
      twin.className = "qtwin";
      twin.textContent = c.twin.label;
      text.append(sym, twin);
      card.appendChild(text);
      card.title += " — factory " + c.factory + " — " + c.twin.terms;
    } else {
      card.appendChild(sym);
    }

    card.addEventListener("click", () => {
      const sel = $("quotePick");
      sel.value = c.factory;
      sel.dispatchEvent(new Event("change"));
      for (const other of grid.querySelectorAll(".qcard")) other.setAttribute("aria-pressed", "false");
      card.setAttribute("aria-pressed", "true");
    });
    grid.appendChild(card);
  }
}

/// Offers every quote asset the registry admits. Failure here is not fatal:
/// the factory field still takes an address typed by hand, which is what it
/// did before there was a picker.
async function fillQuotePicker() {
  const sel = $("quotePick");
  // ONLY THE NEWEST FILL DRAWS, and only for the endpoint and source it was
  // started for. Fills overlap - a field change, the automatic switch, init -
  // and an older one landing last put the previous registry's factories back
  // under the new one's fields (round 5, N52).
  fillQuotePicker.seq = (fillQuotePicker.seq || 0) + 1;
  const mine = fillQuotePicker.seq;
  // THE FACTORY'S REGISTRY WHEN THERE IS A FACTORY. A create needs no lens, and
  // the factory is what an action is pinned to anyway.
  const fromFactory = isAddr(chainCfg.factory);
  const source = fromFactory ? chainCfg.factory : chainCfg.lens;
  const url = chainCfg.rpc;
  const key = url + "|" + (source || "").toLowerCase();
  const live = () => mine === fillQuotePicker.seq && chainCfg.rpc === url &&
    same(fromFactory ? chainCfg.factory : chainCfg.lens, source);
  // A LIST FROM ANOTHER ENDPOINT OR REGISTRY IS NOT LEFT UP WHILE THIS ONE IS
  // READ, nor after it fails: a click on it would put that other registry's
  // factory in the form, chosen.
  if (fillQuotePicker.drawn !== key) clearQuotePicker(sel, "— reading —");
  if (!isAddr(source)) { clearQuotePicker(sel, "— none found —"); return; }
  // WHETHER A LINK SUPPLIED THIS LIST: its endpoint, or the factory or lens the
  // list is read from. A pick from it is not saved as the person's (saveCfg).
  const listFromLink = linkHeld("rpc") ||
    (fromFactory ? linkValues.factory !== undefined && !edited.factory : linkHeld("lens"));
  try {
    const registry = oneAddress(await callAt(url, source, SEL.registry),
      fromFactory ? "The factory's registry()" : "The lens's registry()");
    if (!live()) return;
    const atUrl = (to, data) => displayAt(url, to, data);
    const listed = await quoteChoices(registry, atUrl, live, url);
    // A FACTORY THE SITE NO LONGER OFFERS (config.js hiddenFactories - the
    // halt PRE_MAINNET D4 names for an asset) is not a choice: the registry
    // cannot drop a launcher, so the page does. Only here - a launch already
    // made on it still finds its factory (launchFactoryOf), so its holders can
    // trade and claim.
    // AND ON THE CHAIN config.js NAMES, ONLY THE FACTORIES IT LISTS. The list is
    // read through the endpoint, which may be a link's, and a create sends the
    // dev buy to the factory picked - so a factory config.js does not name is
    // not offered (beginAction refuses a send to one anyway). Asked of the
    // endpoint the list was read through; an endpoint that will not say which
    // chain it serves keeps the list whole, and the send is still checked.
    let site = null;
    try { site = canonicalOn(await chainIdAt(url)); } catch { site = null; }
    if (!live()) return;
    const choices = listed.filter((c) => !factoryHidden(c.factory) &&
      (!site || site.factories.includes(String(c.factory).toLowerCase())));
    choices.unread = listed.unread;
    // A FILL THAT HAS BEEN OVERTAKEN ASKS NOTHING MORE: the twins' terms are
    // up to three reads per factory, all at once.
    if (!live()) return;
    await describeTwins(choices, atUrl);
    if (!live()) return;
    fillQuotePicker.drawn = key;
    pickerFromLink = listFromLink;
    sel.replaceChildren();
    const none = document.createElement("option");
    none.value = "";
    none.textContent = choices.length ? "— pick one —" : "— none found —";
    sel.appendChild(none);
    // GROUPED, because a coin and an equity are different things to price
    // against and the list should not pretend otherwise. Coins first: ETH is
    // the primary pair. AND ETH FIRST AMONG THE COINS, whatever the registry's
    // order: the deploy admits the WETH factory LAST (DEPLOY.txt decision 6,
    // $CURB in the very next transaction), which put ETH after every other
    // coin here. The sort is stable, so the rest keep the registry's order.
    const ethFirst = (a, b) => (same(b.quote, WETH) ? 1 : 0) - (same(a.quote, WETH) ? 1 : 0);
    const groups = [
      ["Coins", choices.filter((c) => !isEquity(c.quote)).sort(ethFirst)],
      ["Stocks", choices.filter((c) => isEquity(c.quote))],
    ];
    for (const [label, members] of groups) {
      if (!members.length) continue;
      const g = document.createElement("optgroup");
      g.label = label;
      for (const c of members) {
        const o = document.createElement("option");
        o.value = c.factory;
        o.textContent = displaySymbol(c.sym) + (c.twin ? " · " + c.twin.label + " · " + c.twin.terms : "");
        if (same(c.factory, chainCfg.factory)) o.selected = true;
        g.appendChild(o);
      }
      sel.appendChild(g);
    }
    renderQuoteCards(groups);
    // ETH UNLESS SOMEONE SAID OTHERWISE. With no factory the person chose, none
    // a link named and no launch in the form, the create form starts on the
    // WETH pair - ETH is the primary pair (decided 2026-09-22) - rather than on
    // whatever an earlier visit or the automatic switch left in the field. Of
    // several WETH factories only the one marked newest is taken; with none
    // marked, nothing is guessed and the field is left as it was.
    if (!factoryChosen && !linkNamedFactory && !isAddr(chainCfg.token)) {
      const eth = choices.filter((c) => same(c.quote, WETH));
      const pick = eth.length === 1 ? eth[0] : eth.find((c) => c.twin && /newest/.test(c.twin.label));
      if (pick && !same(pick.factory, chainCfg.factory)) {
        chainCfg.factory = pick.factory;
        if ($("factory")) $("factory").value = pick.factory;
        cache = {};
        fillQuotePicker();
        refresh();
      }
    }
  } catch (e) {
    // TYPING AN ADDRESS BY HAND STILL WORKS; what the list said is gone, and
    // the one line left says why when the reason is the registry's size.
    if (!live()) return;
    fillQuotePicker.drawn = null;
    clearQuotePicker(sel, /more than the \d+ this page will read/.test(String(e && e.message))
      ? "— " + e.message + " —"
      : "— could not be read —");
  }
}

/// EMPTIES THE PICKER AND ITS CARDS, leaving one line that says why.
function clearQuotePicker(sel, why) {
  if (sel) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = why;
    sel.replaceChildren(o);
  }
  if ($("quoteTabs")) $("quoteTabs").replaceChildren();
  if ($("quoteGrid")) $("quoteGrid").replaceChildren();
}

/// TWO FACTORIES FOR ONE ASSET ARE TOLD APART, by what differs between them.
///
/// The registry admits several per asset - a second is the only way to change
/// an asset's immutable terms - and the cards and the options were drawn from
/// the asset alone: two "NVDAc" tiles with one tooltip, nothing to say which
/// held the current terms, and a creator could launch for good on the retired
/// one (round 5, N53). Each twin gets its factory's address, "newest" on the
/// one the registry admitted last (it only appends, so its order is the order
/// of admission), and its threshold as the factory reports it
/// - "terms unread" when it did not answer, never a number it did not give.
/// NEWEST ONLY WHEN NOTHING LATER WENT UNREAD. A factory admitted after this one
/// that did not answer (choices.unread) may be a third for the same asset, and
/// then "newest" would be a guess - the very mark that sends a creator to the
/// current terms. With a later factory unread, no twin is marked.
/// Sets c.twin = { label, terms } on each; a lone factory gets nothing.
async function describeTwins(choices, callFn) {
  const byQuote = {};
  for (const c of choices) (byQuote[c.quote.toLowerCase()] = byQuote[c.quote.toLowerCase()] || []).push(c);
  const twins = Object.values(byQuote).filter((g) => g.length > 1);
  const unread = choices.unread || [];
  await Promise.all(twins.flat().map(async (c) => {
    const group = byQuote[c.quote.toLowerCase()];
    const newest = group.every((o) => o.index <= c.index) && !unread.some((i) => i > c.index);
    let terms = "terms unread";
    try {
      const [t, dec] = await Promise.all([
        callFn(c.factory, SEL.graduationThreshold), callFn(c.quote, SEL.decimals),
      ]).then((r) => r.map((x) => words(x)));
      // DECIMALS FROM A STRANGER'S CONTRACT ARE BOUNDED before 10^decimals is
      // built from them: no real token has more than 77 (2^256 < 10^78).
      if (t.length && dec.length && wordToBig(dec[0]) <= 77n) {
        terms = "threshold " + fmt(wordToBig(t[0]), Number(wordToBig(dec[0]))) + " " + (c.sym || "");
      }
    } catch { terms = "terms unread"; }
    c.twin = { label: shortAddress(c.factory) + (newest ? " · newest" : ""), terms };
  }));
}

/// CAN THIS SITE'S ETH ROUTE FILL A LAUNCH ON THIS ASSET TODAY?
///
/// The curve has to TAKE IN one graduation threshold of the quote asset before
/// it can graduate. A buyer paying ETH gets the asset through Uniswap v3 (the
/// CURB router's SwapRouter02 path) and, for the AERO_PATHS assets - the seven
/// tokenized stocks, cbXRP and cbZEC - on Aerodrome too, where its router and
/// quoter are the code this page pins (aeroReady). So both venues are asked
/// here whether they can buy one threshold, and the cheaper one is named. It is
/// asked of the chain rather than written into a list, because it moves.
///
/// IT IS NOT A VERDICT ON THE ASSET'S MARKET, and the wording must not say it
/// is. At Base block 52756903 (18 October 2026) the seven tokenized stocks'
/// largest Uniswap v3 USDC pools held $1.3K to $32K of USDC each, and their
/// Aerodrome Slipstream pools (the Gauges V3 factory) $422K to $1.07M -
/// custody, not depth, read by script/b20/rwa-survey.js --site. An asset
/// warned about here can be deep elsewhere, and a buyer paying in the asset
/// itself is not limited by this. So the note says "ETH route", never "thin
/// market".
///
/// THE DEEPEST UNISWAP v3 POOL AGAINST WETH OR USDC is the fallback when the
/// quoter cannot be asked: what that route's pools hold, a bound on what it
/// can deliver and not a depth.
///
/// NOTHING IS BLOCKED. Launching against a thin route is a legitimate choice -
/// holders can sell back to the curve right up until graduation, so a launch
/// that waits traps nobody. What is not legitimate is letting somebody choose
/// it without knowing.
async function quoteLiquidityNote(pin, threshold) {
  const how = { call: pin.call, read: pin.read, rpc: pin.rpc, quote: pin.quote };

  // ETH IS NOT BOUGHT FROM A MARKET TO FILL AN ETH LAUNCH. People send it.
  // This fell through to reading what USDC/WETH pools hold - the depth of a
  // conversion nobody makes - and then blamed a quoter it had skipped.
  if (same(pin.quote, WETH)) return { nativePair: true };

  // ---- THE QUESTION, ASKED OF THE QUOTERS. What would it cost to buy one
  // threshold of this asset with WETH at Uniswap v3 - and on Aerodrome, for an
  // AERO_PATHS asset whose router and quoter are the pinned code? An answer is
  // proof the route can deliver that size; a refusal from every path of both
  // venues is the thin case. An exact-output quote needs the whole amount, so
  // it needs no partial check.
  if (!same(pin.quote, WETH)) {
    try {
      const rows = aeroRows(pin.quote);
      const aero = rows && how.read ? await aeroReady(how).catch(() => ({ ok: false })) : { ok: false };
      const paths = await v3Candidates(how);
      const priced = await Promise.all([
        ...paths.map((hops) => quoteToBuy(how, hops, threshold).then((r) => ({ ...r, venue: "uniswap" }))),
        ...(aero.ok ? rows : []).map((hops) => quoteToBuy(how, hops, threshold, true).then((r) => ({ ...r, venue: "aerodrome" }))),
      ]);
      let cheapest = null;
      let venue = null;
      for (const r of priced) {
        if (r.cost !== undefined && (cheapest === null || r.cost < cheapest)) { cheapest = r.cost; venue = r.venue; }
      }
      if (cheapest !== null) return { costWeth: cheapest, enough: true, asked: true, venue };
      // EVERY VENUE ASKED REFUSED is the thin case. A SILENT ONE is not: the
      // quoter refusing is the pools speaking, a timeout is nobody speaking,
      // and only the first is worth a warning about liquidity. Asked of each
      // venue: Uniswap refusing while Aerodrome timed out was called thin on
      // both, about pools that never answered and can fill it.
      const answered = (where) => priced.some((r) => r.venue === where && !r.unavailable);
      if (answered("uniswap") && (!aero.ok || answered("aerodrome"))) {
        return { costWeth: null, enough: false, asked: true, aeroAsked: !!aero.ok };
      }
      return { unreadable: true, enough: false, asked: true };
    } catch (e) {
      /* fall through to what custody can say */
    }
  }

  // NOT USDC AGAINST ITSELF (routesThroughUsdc): on the USDC pair the WETH
  // pools are the whole route.
  const [vsWeth, vsUsdc] = await Promise.all([
    v3PoolsBetween(how, WETH, pin.quote, pin.quote),
    routesThroughUsdc(pin.quote) ? v3PoolsBetween(how, USDC, pin.quote, pin.quote) : [],
  ]);
  let deepest = 0n;
  for (const p of [...vsWeth, ...vsUsdc]) if (p.held > deepest) deepest = p.held;
  return { deepest, enough: deepest >= threshold, asked: false };
}

/// WHAT ONE THRESHOLD OF THE ASSET WOULD COST IN WETH along this route, or
/// null if this route cannot supply it.
///
/// @dev EXACT OUTPUT, SO THE PATH IS REVERSED - quoteExactOutput reads from the
///      token being bought back to the one being spent, which is what
///      v3PathBytes already produces when told the trade is not WETH-to-quote.
///
///      CANCELLED ON THE LIMIT, like every other quote here: this one simulates
///      too, and a route that cannot be priced would otherwise hold a
///      connection nobody is waiting on.
/// @returns {cost}                a price, so the market can supply it
///          {unpriceable: true}   the quoter refused: it cannot, at this size
///          {unavailable: true}   nobody could be asked - a timeout, a node
///
/// THE THIRD ONE IS NOT THE SECOND. A refusal from the quoter is a fact about
/// the market; a timeout is a fact about the minute. Calling both "thin" makes
/// the page say something economic about a network error.
/// @param aero  the path is an AERO_PATHS row, asked of Aerodrome's quoter.
async function quoteToBuy(how, hops, amountOut, aero) {
  const abort = typeof AbortController === "function" ? new AbortController() : null;
  let timer;
  try {
    const data = SEL.quoteExactOutputV3
      + encode([T.bytes, T.uint(256)], [aero ? aeroPathBytes(hops, false) : v3PathBytes({ hops }, false), amountOut]).slice(2);
    const raw = await Promise.race([
      how.call(aero ? AERODROME.quoter.address : QUOTER_V2, data, abort ? abort.signal : undefined, QUOTE_GAS),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          if (abort) abort.abort();
          reject(new Error("the depth quote timed out"));
        }, QUOTE_TIMEOUT_MS);
      }),
    ]);
    const w = words(raw);
    return w.length ? { cost: wordToBig(w[0]) } : { unpriceable: true };
  } catch (e) {
    if (abort) abort.abort();
    // A REVERT IS THE QUOTER ANSWERING. It simulates the swap and reverts when
    // the pools cannot produce the amount, which is the answer we asked for.
    // Anything else - our own four-second limit, an abort, a transport failure
    // - is the question never arriving.
    const said = (e && e.message ? e.message : String(e)).toLowerCase();
    if (said.includes("revert")) return { unpriceable: true };
    return { unavailable: true };
  } finally {
    clearTimeout(timer);
  }
}

function showQuoteLiquidity(el, ctx, threshold, res) {
  el.hidden = false;
  el.classList.remove("warn", "unbounded");
  const sym = ctx.quoteSym;

  // WHAT MOVES, SAID AS WHAT MOVES. It used to say a launch here "is filled
  // by people sending ETH" - while the curve pulls WETH with an approval and
  // takes no ETH, and nothing wrapped it. A buyer pays ETH, and the CURB router
  // wraps it and buys in the same transaction (curveTradeViaRouter); only where
  // the router cannot be used does this page wrap the shortfall first, as a
  // transaction of its own (ensureQuoteHeld). The note says that, and not more.
  //
  // ASKED OF THE PAIR, NOT ONLY OF THE ANSWER. A failed threshold read reaches
  // here as null, and on the WETH pair that read "the ETH route could not be
  // read" about a route that does not exist.
  if ((res && res.nativePair) || same(ctx.quote, WETH)) {
    el.textContent =
      "A launch paired with ETH is priced in WETH, wrapped ETH: its curve takes WETH. A buyer pays ETH, and " +
      "the CURB router wraps it and buys in the same transaction; only where the router is not available " +
      "does this page wrap ETH into WETH first, as a transaction of its own. ETH and WETH are one for one, " +
      "so there is no market depth to measure here.";
    return;
  }
  if (res === null) {
    el.textContent = "The depth of this site's ETH route to " + sym +
      " could not be read, so this cannot say whether a launch can be filled with ETH.";
    return;
  }
  const need = fmt(threshold, ctx.quoteDecimals, 2);

  // THE WARNING NAMES THE ROUTE, NOT THE MARKET. What failed is buying one
  // threshold with ETH at Uniswap v3, the one way ETH reaches the asset here;
  // it said "THIN MARKET ... until more NVDAc exists" while NVDAc's main
  // market held many thresholds at Aerodrome. "Bought with ETH alone" is the
  // whole consequence: a buyer paying in the asset is not held up by it.
  const thinHead = "<strong>THIN ETH ROUTE.</strong> ";
  const thinTail = ", so one bought with ETH alone may sit unfilled. You can still launch, and holders " +
    "can sell back to the curve the whole time: nothing is locked while it waits.";

  // WHAT THE QUOTER SAID, WHERE IT SAID ANYTHING. The figure is a price, not a
  // balance: what one threshold of the asset would cost to buy today.
  if (res.asked) {
    // NOBODY ANSWERED, WHICH IS NOT AN ANSWER.
    if (res.unreadable) {
      el.textContent =
        "Whether this site's ETH route can buy the " + need + " " + sym + " a launch needs could not be read: " +
        "a route did not answer in time. That is this endpoint or the quoter, not the market \u2014 try again.";
      return;
    }
    if (res.enough) {
      el.textContent =
        "A launch needs " + need + " " + sym + " to graduate, and buying that much with ETH here today " +
        "would cost about " + fmt(res.costWeth, 18, 4) + " WETH" + (res.venue === "aerodrome" ? " (on Aerodrome)" : "") +
        " \u2014 so the market can supply it.";
      return;
    }
    el.classList.add("warn", "unbounded");
    el.innerHTML = thinHead + (res.aeroAsked ? "Neither Uniswap v3 nor Aerodrome" : "Uniswap v3") +
      " could price buying " + escapeHtml(need) + " " + escapeHtml(sym) +
      ", what a launch has to take in before it can graduate" + thinTail;
    return;
  }

  // AND THE OLDER READING WHEN IT DID NOT, named as what it is. A balance is
  // where liquidity sits, not what is reachable at the price a trade crosses.
  const held = fmt(res.deepest, ctx.quoteDecimals, 2);
  if (res.enough) {
    el.textContent = "The deepest Uniswap v3 " + sym + " pool holds " + held + ", and a launch needs " + need +
      " to graduate. (Read from what the pools hold; the quoter could not be asked.)";
  } else {
    el.classList.add("warn", "unbounded");
    el.innerHTML = thinHead + "The deepest Uniswap v3 " + escapeHtml(sym) + " pool holds " + escapeHtml(held) +
      ", and a launch has to take in " + escapeHtml(need) + " before it can graduate" + thinTail +
      " (Read from what the pools hold; the quoter could not be asked.)";
  }
}

/// THE CARD, DRAWN FROM WHAT IS KNOWN RIGHT NOW.
///
/// The creator's half comes from the form as they type; the factory's half
/// comes from ctx, which is read once per asset. Nothing here is a second
/// source of truth - every number is the one the contract will use, or a dash
/// where the page does not know it yet.
/// The split, shown as the number is typed. Purely a reading of what the
/// contract will do with it - the contract still decides.
///
/// AT MODULE SCOPE AND REDRAWN ON EVERY REFRESH. It names the quote asset,
/// and the page does not know which asset that is until the factory answers.
/// Drawn once at init, it said "on 100 the quote asset" until somebody
/// happened to type in the tax field.
function renderTaxSplit() {
  const el = $("taxSplit");
  if (!el) return;
  let bps;
  try { bps = parseTax($("nTax").value); }
  catch (e) { el.textContent = e.message; return; }
  // CHARGED IN ONE THING, PAID IN ANOTHER, and this is the line where a
  // creator decides the number - so it is the line that has to say both.
  // "CLAIMED AS", NOT "PAID IN". On the WETH pair nothing reaches the creator
  // during a trade; it waits in the escrow and the hook until they claim it,
  // and the claim is where it becomes ether.
  // AN UNREAD SHARE IS SAID, NOT SUBSTITUTED - with no factory context too.
  // A fallback of 0.5% stood in silently here after one dropped reply, while
  // the hook might say 0.8% (round 4, S23), and again whenever there was no
  // context at all: before the first read, and after any factory read failed
  // (round 5, N29). The send refuses in both states anyway; the screen says why.
  const platform = platformShareBps();
  if (platform === null) {
    el.textContent = ctx
      ? "The platform's share could not be read from this factory just now, so the split is not " +
        "shown and a launch would be refused. Refresh to try again."
      : "The platform's share is read from the factory, and no factory has been read yet, so the split " +
        "is not shown.";
    return;
  }
  const paidIn = payoutDiffers() ? ", claimed as " + payoutSymbol() : "";
  // WITH SHARING ON THE CREATOR'S PART IS THE HOLDERS', and the line says whose.
  const who = shareWanted() ? "holders" : "you";
  el.textContent =
    "platform " + fmtBps(platform) + " · " + who + " " + fmtBps(bps - platform) +
    "  — on 100 " + quoteSym + ": " + (Number(platform) / 100).toFixed(2) + " to the platform, " +
    (Number(bps - platform) / 100).toFixed(2) + " to " + (shareWanted() ? "the holders" : "you" + paidIn) + ".";
}

/// THE "WHO EARNS YOUR TAX" CARD: the five statements while Holders is chosen,
/// the version it would switch to, and - when the catalog approves none, or
/// could not be read - a Holders choice that cannot be made, with the reason.
function renderShare() {
  const box = $("nShare");
  if (!box) return;
  const offer = ctx && ctx.sharing;
  const available = !!(offer && offer.known && offer.approved && !same(offer.factory, ZERO_ADDRESS));
  const why = !ctx
    ? "" : !offer || !offer.known
      ? "Whether holder sharing is available could not be read from this deployment just now. Refresh to try again."
      : !offer.catalog
        ? "This deployment has no holder sharing."
        : !available ? "Holder sharing is not available yet: no distributor version is approved." : "";
  // A CHOICE THAT CANNOT BE HONOURED IS NOT MADE, AND CANNOT BE; Holders chosen
  // before the version was retired goes back to You with it, and the reason is
  // shown. (Through the You radio: a radio unchecked by itself leaves the pair
  // with neither chosen.)
  if (!available && ctx && box.checked) {
    if ($("earnYouPick")) $("earnYouPick").checked = true;
    else box.checked = false;
  }
  box.disabled = !!ctx && !available;
  $("shareUnavailable").hidden = !why;
  $("shareUnavailable").textContent = why;
  const on = box.checked;
  $("shareTerms").hidden = !on;
  $("shareOff").hidden = on;
  // "Later, from the token page" only while there is a version to switch to.
  if ($("shareLater")) $("shareLater").hidden = !!ctx && !available;
  const v = $("shareVersion");
  v.replaceChildren();
  if (on && available) {
    v.append("Paid through distributor version " + (offer.version === null ? "?" : offer.version.toString()) +
      ", the one the CURB catalog recommends: ");
    // ITS SOURCE, where an explorer can show it: on Base itself only.
    const a = document.createElement(chainIdShown === 8453 ? "a" : "code");
    a.textContent = offer.factory;
    if (chainIdShown === 8453) {
      a.href = "https://basescan.org/address/" + offer.factory + "#code";
      a.target = "_blank";
      a.rel = "noreferrer noopener";
    }
    v.append(a, ".");
  }
}

function renderLaunchSummary() {
  if (!$("launchSummary")) return;

  const name = ($("nName").value || "").trim();
  const sym = ($("nSymbol").value || "").trim();
  $("sumName").textContent = name || "Your token";
  $("sumTicker").textContent = sym ? "$" + sym : "ticker";

  // THE DESCRIPTION, WHERE A TOKEN PAGE WOULD PUT IT. Hidden rather than left
  // as an empty paragraph, so a creator who writes nothing gets a card with
  // nothing missing from it. textContent, never innerHTML: this is the same
  // string that goes into the token's permanent metadata and it is typed by a
  // stranger - AUDIT A-1.
  const desc = ($("nDesc") ? $("nDesc").value || "" : "").trim();
  const descEl = $("sumDesc");
  if (descEl) {
    descEl.textContent = desc;
    descEl.hidden = !desc;
  }

  // The avatar shows the image if one is given and loads, and the first two
  // letters underneath it otherwise - the same fallback the browse list uses.
  const av = $("sumAvatar");
  av.textContent = (sym || name || "—").slice(0, 2).toUpperCase();
  const old = av.querySelector("img");
  if (old) old.remove();
  if (tokenImage) {
    const el = document.createElement("img");
    el.alt = "";
    el.addEventListener("error", () => el.remove());
    el.src = tokenImage;
    av.appendChild(el);
  }

  $("sumPaired").textContent = ctx && ctx.quoteSym ? ctx.quoteSym : "—";

  let bps = null;
  try { bps = parseTax($("nTax").value); } catch { /* the split line reports it */ }
  $("sumFee").textContent = bps === null ? "—" : (Number(bps) / 100).toFixed(2) + "%";
  // A DASH WHILE THE SHARE IS UNREAD, a factory never read included (N29).
  const platform = platformShareBps();
  renderShare();
  const sharing = shareWanted();
  // WITH SHARING ON, YOURS IS NOTHING, and the holders' share is said beside it.
  $("sumYours").textContent =
    bps === null || platform === null
      ? "—"
      : sharing
        ? "0% · " + (Number(bps - platform) / 100).toFixed(2) + "% to holders"
        : (Number(bps - platform) / 100).toFixed(2) + "%";

  $("sumGrad").textContent = ctx && ctx.threshold
    ? fmt(ctx.threshold, ctx.quoteDecimals, 2) + " " + ctx.quoteSym
    : "—";
  $("sumSupply").textContent = ctx && ctx.supply ? fmt(ctx.supply, 18, 0) : "—";
  // LOCKED FOREVER on every launch anyone can make here: the lock has no
  // unlock time and no withdrawal. A dash until a factory has been read, as
  // every other factory term on the card.
  $("sumLock").textContent = ctx ? "Locked forever" : "—";

  // WHAT THE CREATOR ACTUALLY CLAIMS. On an ETH pair the fee is charged in
  // WETH and unwrapped inside the claim, so the row above about the tax and
  // this one are about two different tokens.
  if ($("sumPaidIn")) $("sumPaidIn").textContent = !ctx ? "—" : sharing ? "holders are paid it" : payoutSymbol();

  // THE MOST A DEV BUY CAN BE, IN THIS ASSET'S UNITS AND AS A SHARE OF THE
  // SUPPLY. Per asset and per tax, because the factory caps the tokens and the
  // quote that buys them differs - so a figure written into the page would be
  // right for one factory and wrong for the others.
  const devCap = $("devBuyCap");
  if (devCap) {
    const cap = ctx ? devBuyCeiling(ctx.threshold, ctx.maxDevBuyBps) : null;
    const capped = ctx && ctx.maxDevBuyBps < 10000n;
    devCap.textContent = cap === null
      ? (capped
        ? (ctx.threshold && !ctx.platformKnown
          ? "The most a dev buy can be appears once the platform's share is read from this factory. Refresh to try again."
          : "The most a dev buy can be appears once the creator tax is valid.")
        : "")
      : "Max dev buy: " + fmt(cap, ctx.quoteDecimals, 6) + " " + ctx.quoteSym +
        (capped
          ? " — about " + sharePlain(ctx.maxDevBuyBps) + "% of the supply, the most a first buy may receive" +
            " (at this creator tax)."
          : " — just under this launch's graduation threshold.");
  }

  // THE PRESET THAT MATCHES, lit - and none of them when the field holds a
  // value between two of them.
  for (const b of document.querySelectorAll("#taxPresets [data-tax]")) {
    b.setAttribute("aria-pressed", String(bps !== null && BigInt(b.dataset.tax) * 100n === bps));
  }
  renderDevBuy();
}

async function refresh(quiet) {
  // ONLY THE NEWEST REFRESH DRAWS - and from its FIRST await, not its tenth.
  // Refreshes overlap: a click, the end of an action, a picker change, a test.
  // The guard used to start after the factory half, so an older refresh still
  // wrote the depth note (with one asset's figures under another's ticker)
  // and could leave the global context pointing at the factory the person had
  // just left. Everything here now works on a local context and checks it is
  // still the newest before each write.
  refresh.seq = (refresh.seq || 0) + 1;
  const mySeq = refresh.seq;
  const stale = () => mySeq !== refresh.seq;
  // A launch that is not drawn is not "the launch on screen" either: the owed
  // panel reads `view`, and a panel left from the previous launch described a
  // curve nobody was looking at. Nor is a rescue offered for it.
  const noLaunch = () => {
    $("launchPanel").hidden = true; view = null; viewFor = null; hideRescue();
    // MOVED OUT OF THE PANEL in the token view, so hidden with it by hand.
    if ($("unwrapBox")) $("unwrapBox").hidden = true;
  };
  // AND A FACTORY THAT CANNOT BE READ IS NOT THE FACTORY ON SCREEN. These paths
  // used to write only the error line, leaving the previous launch, its owed
  // amounts with enabled Claim buttons, and the summary card's threshold and
  // supply drawn beside a factory address that no longer produced them
  // (round 5, S28). Callers check stale() first: an older refresh must not
  // wipe what a newer one drew.
  const noFactory = () => {
    noLaunch();
    ctx = null;
    if ($("owedBox")) $("owedBox").hidden = true;
    quoteSym = "the quote asset";
    $("quoteAddr").textContent = "—";
    $("quoteSymA").textContent = "quote asset";
    for (const el of document.querySelectorAll(".qs")) el.textContent = "the quote asset";
    $("quoteBal").textContent = "—";
    $("quoteLiquidity").hidden = true;
    $("policyRow").textContent = "—";
    $("policyRow").className = "";
    $("policyNote").hidden = true;
    renderLaunchSummary();
    renderTaxSplit();
  };

  // A LINK WITH A LENS AND A TOKEN BUT NO FACTORY - what older browse links
  // carried, and what loadCfg() now leaves the factory empty for - is resolved
  // to the factory that MADE the launch, and said so: of the factories the
  // lens's registry lists for its asset, the one whose escrow its curve pays
  // into (launchFactoryOf, round 5, S53). A creator with no lens needs only a
  // factory.
  if (!isAddr(chainCfg.factory) && isAddr(chainCfg.lens) && isAddr(chainCfg.token)) {
    try {
      const reg = oneAddress(await call(chainCfg.lens, SEL.registry), "The lens's registry()");
      const known = words(await call(reg, SEL.isRegistered + pad32(chainCfg.token)));
      if (known.length && wordToBig(known[0]) !== 0n) {
        const rec = words(await call(reg, SEL.launchOf + pad32(chainCfg.token)));
        const escrow = oneAddress(await call(wordToAddress(rec[0]), SEL.feeEscrow), "The curve's feeEscrow()");
        const home = await launchFactoryOf(reg, wordToAddress(rec[1]), escrow, call, () => !stale());
        if (stale()) return;
        if (home) {
          $("factory").value = home.factory;
          chainCfg.factory = home.factory;
          // NOT SAID ON A TOKEN'S OWN PAGE: /token/0x… names the launch and
          // nothing else by design, so finding its factory is the normal path
          // there, not something the link left out.
          if (!TOKEN_VIEW) {
            switchNote = escapeHtml(
              "The link named no factory, so the one the lens's registry lists as having made this launch (" +
              home.sym + ", " + home.factory + ") is used."
            );
          }
        }
      }
    } catch { /* falls through to asking for a factory */ }
  }
  if (!isAddr(chainCfg.factory)) {
    if (stale()) return;
    noFactory();
    if (!quiet) showRead("Enter a factory address.");
    return;
  }
  // THE FACTORY THIS REFRESH READS, held to config.js's list again (recheckWhere).
  recheckWhere();

  // THE CONTEXT THIS REFRESH READ, if it got that far: a failure before it is
  // a failure of the factory, and one after it only of the launch.
  let here = null;
  // WHETHER THE FACTORY'S HALF OF THE PAGE - the labels, the card, the balance,
  // the policy row and the owed panel - has been drawn for `here`. Until it has,
  // what is on screen is the LAST factory's, and a failure in that gap used to
  // take only the launch away: the owed amounts, the balance and the standing
  // of factory A stayed beside factory B's context (round 5, S28).
  let factoryDrawn = false;
  try {
    here = await factoryContext();
    if (stale()) return;
    // NO AWAIT BETWEEN HERE AND THE LABELS. ctx and the labels that name its
    // asset change in one tick; an unused lens read sat between them, and a lens
    // with no code on this endpoint threw there, leaving the previous asset's
    // unit beside the amount field while the amount was scaled by the new one
    // (round 5, N07). That read now comes after the factory's half.
    ctx = here;

    quoteSym = here.quoteSym;
    $("quoteAddr").textContent = here.quote;
    // Every place the page names the asset in prose, from one source.
    $("quoteSymA").textContent = here.quoteSym;
    for (const el of document.querySelectorAll(".qs")) el.textContent = here.quoteSym;
    // THE READS BELOW THAT WAIT FOR NOTHING ON THIS PAGE, STARTED NOW and taken
    // where they were: the lens's Graduator, and the registry's and the lens's
    // word on the launch. Behind the factory's half, one after another, they
    // were two round trips more before a token's status (17 October 2026).
    // Each is only read here; what is drawn from it, and when, is as before,
    // and a launch or lens changed in the meantime is asked again below.
    const early = isAddr(chainCfg.token) && isAddr(chainCfg.lens) ? {
      token: chainCfg.token,
      lens: chainCfg.lens,
      reg: Promise.allSettled([
        call(here.registry, SEL.isRegistered + pad32(chainCfg.token)),
        call(here.registry, SEL.launchOf + pad32(chainCfg.token)),
      ]),
      view: readLaunch(chainCfg.token),
    } : null;
    if (early) early.view.catch(() => {});
    const graduatorRead = readGraduator();
    graduatorRead.catch(() => {});
    // AND WHETHER THE CURB ROUTER IS HERE (routerReady, below): one read of
    // its code, once per endpoint and chain, which waited for all of this.
    const routerRead = routerReady({ rpc: chainCfg.rpc, read: rpc }).catch(() => {});
    // AND WHETHER THAT THRESHOLD CAN BE REACHED AT ALL. Read every refresh so
    // it tracks the market rather than the day this was written.
    try {
      const tw = words(await call(here.factory, SEL.graduationThreshold));
      const threshold = tw.length ? wordToBig(tw[0]) : 0n;
      const res = threshold > 0n
        ? await quoteLiquidityNote({ call, read: rpc, rpc: chainCfg.rpc, quote: here.quote }, threshold)
        : null;
      if (stale()) return;
      showQuoteLiquidity($("quoteLiquidity"), here, threshold, res);
    } catch {
      // A failed read must not take the page down with it: the rest of this
      // panel is what a creator needs to act, and this line is advice.
      if (stale()) return;
      showQuoteLiquidity($("quoteLiquidity"), here, 0n, null);
    }

    // The factory's half of the summary card changes with the asset, and so
    // does the tax split under the field - it names that asset.
    renderLaunchSummary();
    renderTaxSplit();

    // A BALANCE THAT CANNOT BE READ SAYS SO, and stops nothing else. It used to
    // throw out of the factory's half before the policy row and the owed panel
    // were redrawn, so the previous factory's were left up (round 5, S28).
    if (account) {
      const bal = await erc20.balanceOf(here.quote, account).catch(() => null);
      if (stale()) return;
      $("quoteBal").textContent = bal === null
        ? "could not be read"
        : fmt(bal, here.quoteDecimals, 4) + " " + here.quoteSym;
    } else {
      $("quoteBal").textContent = "—";
    }

    // THE ISSUER'S ANSWER, BEFORE THE TRADE RATHER THAN INSTEAD OF ONE.
    const standing = await policyStanding(here.quote, account, call);
    if (stale()) return;
    // FOR TRADES ONLY. It was kept for the owed panel and the claims too, and a
    // claim is one direction of this - the account receiving, the payer sending
    // - so they ask claimStanding instead (round 5, N19).
    const el = $("policyRow");
    const note = $("policyNote");
    note.hidden = true;
    if (!account) {
      el.textContent = "connect a wallet to check";
      el.className = "";
    } else if (standing.none) {
      // NO B20 POLICY TO ASK (policyStanding): the one rule left is a FiatToken
      // blacklist (cbBTC, cbXRP, USDC), the same question the router asks. A
      // coin without one (WETH, VIRTUAL, AERO) answers that one with a revert,
      // which coinBlacklists reads as "not listed".
      const listed = await coinBlacklists(here.quote, account, call);
      if (stale()) return;
      el.textContent = listed ? "BLACKLISTED by the issuer of " + here.quoteSym : "no issuer policy; not blacklisted";
      el.className = listed ? "bad" : "ok";
    } else if (!standing.known) {
      el.textContent = "could not be read";
      el.className = "";
    } else if (standing.allowed) {
      el.textContent = "allowed to hold " + here.quoteSym;
      el.className = "ok";
    } else {
      el.textContent = "RESTRICTED by the issuer (policy " + standing.policy + ")";
      el.className = "bad";
      note.hidden = false;
      note.innerHTML =
        "<strong>The issuer of " + escapeHtml(here.quoteSym) + " has restricted this account.</strong> " +
        "A transfer to it reverts with PolicyForbids, so a trade here would fail after you paid the gas. " +
        "Every tokenized equity measured sits under the SAME policy with the same admin, so choosing " +
        "another stock does not route around it.";
    }

    // WHAT IS WAITING FOR THIS ACCOUNT, before the launch is read: the escrow
    // and the hook rows need no launch. The curve row does, and is drawn again
    // once the launch below is known.
    renderOwed(null).catch(() => { if ($("owedBox")) $("owedBox").hidden = true; });
    factoryDrawn = true;

    // THE LENS'S GRADUATOR, for the record only: nothing drawn or sent uses it -
    // the launch and the lock use the factory's graduator. After the factory's
    // half, and its failure caught, so a lens with no code here costs nothing
    // but this read (N07).
    try { await graduatorRead; } catch { /* the launch read below reports a bad lens */ }
    if (stale()) return;

    if (!isAddr(chainCfg.token)) {
      noLaunch();
      // No launch selected is not an error and not a result; it is just the
      // panel being empty. Whatever a transaction last said stays said.
      showRead(switchNote);
      return;
    }
    if (!isAddr(chainCfg.lens)) {
      noLaunch();
      showRead("Enter a LaunchLens address to read this launch. Creating one needs only the factory.");
      return;
    }

    // WHAT THIS DRAWING IS FOR, taken in the same tick as the read it starts:
    // the token and lens the lens is asked about, the endpoint asked, and the
    // factory whose context is `here`. It becomes `viewFor` once drawn.
    const readFor = { token: chainCfg.token, factory: here.factory, lens: chainCfg.lens, rpc: chainCfg.rpc };
    // THE REGISTRY IS ASKED WHILE THE LENS IS (see below): both answers are
    // needed and neither waits on the other. launchOf reverts for a token the
    // registry does not know, and is then simply not used.
    // THE ONES STARTED ABOVE, where they were asked about this launch and lens.
    const asked = early && same(early.token, chainCfg.token) && same(early.lens, chainCfg.lens) ? early : null;
    const regReads = asked ? asked.reg : Promise.allSettled([
      call(here.registry, SEL.isRegistered + pad32(chainCfg.token)),
      call(here.registry, SEL.launchOf + pad32(chainCfg.token)),
    ]);
    const readView = await (asked ? asked.view : readLaunch(chainCfg.token));
    if (stale()) return;

    // A LAUNCH IS DRAWN ONLY AS THE REGISTRY AND THE CHAIN RECORD IT.
    //
    // The record decides the launch's ASSET (a launch priced in another asset
    // is not drawn in this one - see the switch below), the FACTORY that made
    // it, its CURVE and its POOL KEY; the curve, the token and the factory's
    // graduator decide its STATUS and every number drawn. The page used to
    // check only the asset and draw whatever curve and pool the lens named;
    // then it checked curve and pool and still drew the lens's status,
    // progress, threshold and supply - so a lens naming the genuine curve could
    // show a Selling launch as Waiting or Graduated at any percentage, with
    // the matching panel (round 5, S05). The lens now only says where to look.
    //
    // AND THE PAGE MOVES ONLY WHEN NOBODY CHOSE THIS FACTORY: a creator who
    // picked an asset keeps it (the launch is simply not drawn), and a create
    // still waiting to be adopted on this factory is never re-pointed. The move
    // is said out loud and is not saved by the switch itself.
    //
    // THE REGISTRY IS ASKED FOR NotFound TOO. A lens answering status 0 used to
    // skip every check, and its curve, supply and progress were printed beside
    // "NotFound" (round 5, P-R51).
    let rec = null;
    let known = false;
    let readFailed = false;
    try {
      const [kGot, recGot] = await regReads;
      if (kGot.status === "rejected") throw kGot.reason;
      const k = words(kGot.value);
      known = k.length > 0 && wordToBig(k[0]) !== 0n;
      if (known) {
        if (recGot.status === "rejected") throw recGot.reason;
        rec = words(recGot.value);
        if (rec.length < 8) { rec = null; readFailed = true; }
      }
    } catch { readFailed = true; }
    if (stale()) return;
    if (readFailed) {
      noLaunch();
      showRead(escapeHtml(
        "Whether this factory's registry knows " + chainCfg.token + " could not be read just now. " +
        "Nothing is drawn until it can be - try Refresh."));
      return;
    }

    let drawn;
    if (readView.status === 0) {
      if (known) {
        noLaunch();
        showRead(escapeHtml(
          "The lens at " + chainCfg.lens + " reports no launch at " + chainCfg.token + ", but this factory's " +
          "registry records one. Nothing it reports is drawn - check where this link came from."));
        return;
      }
      // NotFound AS NOTHING AT ALL. Whatever the lens sent beside the status is
      // not drawn: NotFound is not a launch in an early state.
      drawn = NOT_FOUND_VIEW;
    } else {
      if (!known) {
        noLaunch();
        showRead(escapeHtml(
          "The lens reports a launch at " + chainCfg.token + ", but this factory's registry has no record " +
          "of it. It is not drawn here."));
        return;
      }
      const theirQuote = wordToAddress(rec[1]);
      const recCurve = wordToAddress(rec[0]);
      // WHICH FACTORY MADE IT: the asset, and the escrow its curve pays into.
      // The registry admits several factories per asset, and one on the right
      // asset but the wrong escrow drew the launch with an owed panel, a claim
      // and a sweep message about an escrow that never saw its fees (S53).
      const [curveEscrow, ourEscrow] = await Promise.all([
        call(recCurve, SEL.feeEscrow).then((r) => oneAddress(r, "The curve's feeEscrow()")),
        call(here.factory, SEL.feeEscrow).then((r) => oneAddress(r, "The factory's feeEscrow()")),
      ]);
      if (stale()) return;
      const sameAsset = same(theirQuote, here.quote);
      if (!sameAsset || !same(curveEscrow, ourEscrow)) {
        const home = await launchFactoryOf(here.registry, theirQuote, curveEscrow, call, () => !stale());
        const theirs = home ? home.sym
          : sameAsset ? here.quoteSym
          : await symbolOf(theirQuote, call).catch(() => theirQuote);
        // THE CHAIN THE ENDPOINT SERVES, asked only when a move is on the table:
        // a create record of another chain does not hold it (unresolvedCreate).
        const served = home && !factoryChosen && !refresh.switching
          ? await rpc("eth_chainId", []).catch(() => null)
          : null;
        if (stale()) return;
        if (home && !factoryChosen && !refresh.switching && !unresolvedCreate(served)) {
          switchNote = escapeHtml(sameAsset
            ? "This launch was made by another " + theirs + " factory (" + home.factory + "), whose escrow " +
              "holds its fees, so the page moved to it to draw it."
            : "This launch is priced in " + theirs + ", so the page moved from the " + here.quoteSym +
              " factory to the " + theirs + " one (" + home.factory + ") to draw it. Pick another asset to " +
              "create on that one instead."
          );
          $("factory").value = home.factory;
          chainCfg.factory = home.factory;
          cache = {};
          fillQuotePicker();
          refresh.switching = true;
          try { await refresh(quiet); } finally { refresh.switching = false; }
          return;
        }
        noLaunch();
        showRead(escapeHtml(sameAsset
          ? "This launch was made by another " + here.quoteSym + " factory: its curve pays its fees into the " +
            "escrow " + curveEscrow + ", and the factory on this page" + (factoryChosen ? ", which you chose," : "") +
            " uses " + ourEscrow + ". It is not drawn here, because what is owed, a claim and a sweep would " +
            "all be about the wrong escrow." + (home ? " Pick the factory " + home.factory + " to see it." : "")
          : "This launch is priced in " + theirs + ", and the factory on this page is for " + here.quoteSym +
            (factoryChosen ? ", which you chose" : "") +
            ". It is not drawn here, because every number would be in the wrong asset." +
            (home ? " Pick the " + theirs + " factory to see it." : "")
        ));
        return;
      }
      // THE CURVE AND THE POOL, against the record, exactly as beginAction
      // checks them before a send.
      const tokenIsC0 = chainCfg.token.toLowerCase() < theirQuote.toLowerCase();
      const lk = readView.poolKey;
      const sameCurve = same(recCurve, readView.curve);
      const sameKey = same(lk.currency0, tokenIsC0 ? chainCfg.token : theirQuote) &&
        same(lk.currency1, tokenIsC0 ? theirQuote : chainCfg.token) &&
        lk.fee === wordToBig(rec[5]) && lk.tickSpacing === wordToInt(rec[6], 24) &&
        same(lk.hooks, wordToAddress(rec[7]));
      if (!sameCurve || !sameKey) {
        noLaunch();
        showRead(escapeHtml(
          "The lens at " + chainCfg.lens + " describes this launch differently from the registry " +
          (sameCurve ? "(another pool)" : "(another curve: the registry names " + recCurve + ")") +
          ". Nothing it reports is drawn - check where this link came from."
        ));
        return;
      }

      // THE STATUS AND THE NUMBERS, FROM THE CHAIN. The status as beginAction
      // works it out, from the factory's graduator (not the lens's) and the
      // curve; a lens that disagrees is refused, not corrected, as it is at a
      // send. The numbers are simply read where the lens reads them.
      // THE GRADUATOR factoryContext READ FOR THIS FACTORY (immutable), or asked.
      const graduator = isAddr(here.graduator) ? here.graduator
        : oneAddress(await call(here.factory, SEL.graduator), "The factory's graduator()");
      // AND WHETHER IT SHARES ITS FEES WITH ITS HOLDERS, from the same
      // Graduator - never the lens's word 15: what a quote and a report call
      // the tax, and what the token view draws, follow it. A Graduator from
      // before holder sharing answers nothing: null, "cannot say".
      const [status, realW, thrW, supW, resW, shareW] = await Promise.all([
        chainStatusOf(call, graduator, chainCfg.token, recCurve),
        call(recCurve, SEL.realQuoteReserve),
        call(recCurve, SEL.graduationThreshold),
        call(chainCfg.token, SEL.totalSupply),
        call(recCurve, SEL.getReserves),
        call(graduator, SEL.holderDistributorOf + pad32(chainCfg.token)).catch((e) => (lacksFunction(e) ? "0x" : Promise.reject(e))),
      ]);
      if (stale()) return;
      // A DISAGREEMENT IS ASKED AGAIN, BOTH SIDES IN ONE TICK AND NEITHER WARM
      // (callAt, gathered into one aggregate, so of one block), before the lens
      // is refused: the lens was read seconds before the chain's flags, and a
      // launch that filled or graduated in between disagreed for no fault of
      // the lens. Agreeing now, the refresh starts over and draws what both
      // say; disagreeing still, the lens is refused as before.
      if (status !== readView.status) {
        const cold = (to, d) => callAt(chainCfg.rpc, to, d);
        const [lensNow, chainNow] = await Promise.all([
          readLaunchWith({ call: cold, lens: chainCfg.lens }, chainCfg.token).then((r) => r.status, () => null),
          chainStatusOf(cold, graduator, chainCfg.token, recCurve).catch(() => null),
        ]);
        if (stale()) return;
        if (lensNow !== null && lensNow === chainNow && !refresh.recheckedStatus) {
          // NOTHING WARM INTO THAT REFRESH: those answers are from before the change.
          if (Multi && Multi.forget) Multi.forget();
          refresh.recheckedStatus = true;
          try { await refresh(quiet); } finally { refresh.recheckedStatus = false; }
          return;
        }
      }
      if (status !== readView.status) {
        noLaunch();
        showRead(escapeHtml(
          "The lens at " + chainCfg.lens + " reports this launch as " + STATUS[readView.status] + "; the chain " +
          "says " + STATUS[status] + ". Nothing it reports is drawn - refresh, and if it persists, check where " +
          "this link came from."));
        return;
      }
      // A WORD THAT IS MISSING IS NOT ZERO. Nothing is drawn from a guess.
      const word = (raw, what, i = 0) => {
        const w = words(raw);
        if (w.length <= i) throw new Error(what + " answered nothing, so this launch is not drawn.");
        return wordToBig(w[i]);
      };
      drawn = {
        status,
        curve: recCurve,
        quoteToken: theirQuote,
        beneficiary: wordToAddress(rec[2]),
        quoteReserve: word(resW, "The curve's getReserves()", 0),
        tokenReserve: word(resW, "The curve's getReserves()", 1),
        realQuoteReserve: word(realW, "The curve's realQuoteReserve()"),
        graduationThreshold: word(thrW, "The curve's graduationThreshold()"),
        totalSupply: word(supW, "The token's totalSupply()"),
        poolKey: readView.poolKey,
        holderDistributor: words(shareW).length ? wordToAddress(words(shareW)[0]) : null,
        // WHEN THE REGISTRY RECORDED IT (word 11 of its record), for the token
        // view's search for the creation block (token.js creationNear). 0 when
        // the record is shorter.
        launchedAt: rec.length >= 12 ? Number(wordToBig(rec[11])) : 0,
      };
    }

    // A TOKEN THAT IS NOT A LAUNCH may not even be a token: balanceOf on an
    // address with no code answers "0x", which used to throw here and replace
    // NotFound with a JavaScript error - so NotFound asks nothing at all, and
    // renderLaunch states no holding of it. A REGISTERED LAUNCH TOKEN always
    // has code, and a failed read of it is not zero: it was drawn as "you hold
    // 0" after one dropped reply (round 5, N27). Null, and renderLaunch says it
    // could not be read. WITH NO WALLET nothing is asked either, and `who` says
    // so: the zeros below are placeholders renderLaunch does not print.
    const who = account;
    const tokenBal = who && drawn.status !== 0
      ? await erc20.balanceOf(chainCfg.token, who).catch(() => null)
      : 0n;
    const quoteBal = who ? await erc20.balanceOf(here.quote, who) : 0n;
    if (stale()) return;
    view = drawn;
    meta = { decimals: 18, tokenBal, quoteBal, who };
    await renderLaunch();
    if (stale()) return;
    // ONLY NOW IS IT THE LAUNCH ON SCREEN. renderLaunch writes the status and
    // the progress at once but awaits the quote - the tax, what comes out, the
    // minimum - and until that lands the rows under the button are still the
    // previous launch's. Marked before it, a press in that gap was built for
    // this launch on numbers drawn for the last one (round 5, N05). Until
    // here `viewFor` still names the last launch drawn, so beginAction refuses.
    viewFor = readFor;
    showRead(switchNote);
    // AND THE CURVE ROW, now that the launch on screen is known - AWAITED, so a
    // refresh that has returned has finished drawing. It was fired and
    // forgotten, and a test that asserted the panel right after a refresh was
    // reading whatever the previous render had left (round 4, S10).
    await renderOwed(view).catch(() => {});
    // WHETHER THE CURB ROUTER IS HERE, asked once per endpoint and chain before
    // the token view draws: it offers ETH for a curve sale only where the router
    // can pay it (routerUsable).
    if (view.status === 1) {
      await routerRead;
      await routerReady({ rpc: chainCfg.rpc, read: rpc }).catch(() => {});
    }
    if (stale()) return;
    // AND THE FACTORY THE AUTOMATIC SWITCH MAY HAVE MOVED TO, held to config.js.
    recheckWhere();
    // THE TOKEN VIEW REDRAWS FROM HERE (token.js): the launch on screen, its
    // balances and what it is owed have all just been read.
    document.dispatchEvent(new CustomEvent("curb:drawn"));
  } catch (e) {
    // A READING failure. It says nothing about a transaction, so it does not go
    // where transaction results go. AND IT LEAVES NOTHING OF THE LAST READ ON
    // SCREEN (S28): until the factory's half was drawn for this factory, that
    // half goes too - not only when the factory itself did not answer.
    if (stale()) return;
    if (!factoryDrawn) noFactory(); else noLaunch();
    showRead(escapeHtml(e.message || String(e)));
  }
}

/// WHAT NotFound IS DRAWN FROM: nothing. See refresh().
const ZERO_ADDRESS = "0x" + "0".repeat(40);
const NOT_FOUND_VIEW = Object.freeze({
  status: 0, curve: ZERO_ADDRESS, quoteToken: ZERO_ADDRESS, beneficiary: ZERO_ADDRESS,
  holderDistributor: null,
  quoteReserve: 0n, tokenReserve: 0n, realQuoteReserve: 0n, graduationThreshold: 0n, totalSupply: 0n,
  poolKey: Object.freeze({ currency0: ZERO_ADDRESS, currency1: ZERO_ADDRESS, fee: 0n, tickSpacing: 0, hooks: ZERO_ADDRESS }),
});

/// WHOSE THE TAX IS, as every quote and report here names it: the creator's -
/// or, once the launch's holder sharing is on (LaunchView w15), its holders'.
/// The curve's creator leg and the pool's both go to the distributor then.
const sharesWithHolders = (v) => !!(v && v.holderDistributor && !same(v.holderDistributor, ZERO_ADDRESS));
const taxName = (v) => (sharesWithHolders(v) ? "tax for holders" : "creator tax");
const feeName = (v) => (sharesWithHolders(v) ? "tax for holders" : "creator fee");

/// "Unwrap to ETH", shown while a WETH pair's page is open to an account that
/// holds WETH (unwrapWeth). From the balance refresh() just read.
function drawUnwrap() {
  const box = $("unwrapBox");
  if (!box) return;
  const held = !!(meta && meta.who && ctx && same(ctx.quote, WETH) && typeof meta.quoteBal === "bigint" && meta.quoteBal > 0n);
  box.hidden = !held;
  if (held) $("unwrapText").textContent = `You hold ${fmt(meta.quoteBal, 18, 6)} WETH - wrapped ether.`;
}

async function renderLaunch() {
  const v = view;
  $("launchPanel").hidden = false;
  $("status").textContent = STATUS[v.status];
  $("status").className = "status s" + v.status;
  // THE RESCUE BELONGS TO THE LAUNCH IT WAS OFFERED FOR, while it still waits.
  // It used to stay up for every launch loaded after it, saying "Completing
  // the move would revert" about one nothing had been simulated for - with a
  // button that sent the rescue for THAT one (round 5, S22).
  if (!(rescueFor && v.status === 2 && same(rescueFor.token, chainCfg.token) &&
        same(rescueFor.factory, chainCfg.factory) && rescueFor.rpc === chainCfg.rpc)) {
    hideRescue();
  }
  if (v.status === 0) {
    // NOTHING TO DRAW, AND NOTHING IS. See NOT_FOUND_VIEW.
    $("curveAddr").textContent = "—";
    $("supply").textContent = "—";
    $("supply").title = "";
    $("progress").style.width = "0%";
    $("progressText").textContent = "—";
  } else {
    $("curveAddr").textContent = v.curve;
    // SHORT TO READ, EXACT ON INSPECTION. A supply printed with no decimals is
    // 750,000,000 when the chain holds 750000000.086107037161304513, and the
    // burn below is the figure most likely to be checked against a receipt.
    $("supply").textContent = fmt(v.totalSupply, 18, 0);
    $("supply").title = "exact: " + v.totalSupply.toString();

    const pct = v.graduationThreshold === 0n
      ? 0
      : Number((v.realQuoteReserve * 10000n) / v.graduationThreshold) / 100;
    $("progress").style.width = Math.min(100, pct) + "%";
    $("progressText").textContent =
      `${fmt(v.realQuoteReserve, ctx.quoteDecimals, 4)} of ${fmt(v.graduationThreshold, ctx.quoteDecimals, 4)} ${ctx.quoteSym}` +
      ` — ${pct.toFixed(2)}%`;
  }

  // THE FIGURES ONLY AS READ. Null is a read that failed (refresh), and is
  // said; NotFound asks nothing - the address may not even be a token - so it
  // states no holding of it; and with no wallet nothing was asked at all. Each
  // of these used to print "you hold 0" about a balance nobody read (round 5,
  // N27).
  $("balances").innerHTML = !meta.who
    ? "connect a wallet to see what you hold"
    : (v.status === 0
      ? `you hold `
      : meta.tokenBal === null
        ? `your balance of this token <strong>could not be read</strong> just now, and you hold `
        : `you hold <strong>${fmt(meta.tokenBal, 18, 4)}</strong> of this token and `) +
      `<strong>${fmt(meta.quoteBal, ctx.quoteDecimals, 4)}</strong> ${ctx.quoteSym}`;
  drawUnwrap();

  $("curveBox").hidden = v.status !== 1;
  // ETH ON EITHER SIDE OF EVERY CURVE: through the CURB router where it can be
  // used, the longer way where it cannot (computeCurveQuote says which).
  if ($("curveViaRow")) $("curveViaRow").hidden = false;
  // ON A WETH PAIR THE TWO CHOICES ARE ETH AND WETH, and ETH is where the page
  // starts (one confirmation through the router, as on the swap card). "WETH"
  // is WETH: a buy spends what the account holds and wraps nothing, a sale pays
  // WETH and unwraps nothing (computeCurveQuote's wethOnly). Once per launch
  // drawn, like the pool's: a choice made after it is the person's.
  if ($("curveVia")) {
    const wethPair = same(ctx.quote, WETH);
    const q = $("curveVia").querySelector('option[value="quote"]');
    if (q) q.textContent = wethPair ? "WETH" : "The quote asset";
    if (v.status === 1 && !same(curveViaFor, chainCfg.token)) {
      curveViaFor = chainCfg.token;
      if (wethPair) $("curveVia").value = "eth";
    }
  }
  $("waitBox").hidden = v.status !== 2;
  $("poolBox").hidden = v.status !== 3;
  $("lockBox").hidden = v.status !== 3;

  if (v.status === 1) await renderCurveQuote();
  if (v.status === 3) {
    // ETHER BY DEFAULT IN A WETH POOL - the direct path pays and takes WETH, and
    // people hold ether (the owner's call, 2026-09-28). Once per launch drawn: a
    // choice made after it is the person's, and a refresh keeps it.
    if (!same(poolViaFor, chainCfg.token)) {
      poolViaFor = chainCfg.token;
      if (same(ctx.quote, WETH)) $("poolVia").value = "eth";
    }
    await renderPoolQuote();
    // THE LOCK PANEL IS NOT AWAITED, AND THAT IS THE POINT.
    //
    // It is two stages of plain reads - lockOf, then six at once (five lock
    // getters and burnedOf) - and none of them is needed to trade. It used to
    // scan logs, which is why this was first made fire-and-forget; the scan is
    // gone, and the reason that remains is that two round trips on a slow
    // endpoint are not worth holding the rest of the page for.
    //
    // It writes its own box and nothing else reads what it finds, so letting
    // it land late costs nothing. A failure is reported in that box, which is
    // why the rejection is caught here rather than left to become an unhandled
    // one.
    renderLock().catch((e) => {
      const box = $("lockFacts");
      if (box) box.innerHTML = note("Could not read the lock: " + escapeHtml(e.message || String(e)));
    });
  }
}

// ---------------------------------------------------------------- the CURB router
//
// ONE CONFIRMATION FOR AN ETH BUY ON EVERY CURVE, AND ETH FROM A SALE ON EVERY
// CURVE (the owner's call, 2026-10-01: "too many confirmations - people may
// misread it"). The router is used only when all of these hold, and the flows
// from before it are used, and said to be, whenever one does not:
//   - its code is on the chain being read and is the code this page knows
//     (routerReady);
//   - on a stock pair, the issuer lets both this account and the router send
//     and receive the asset, and on a FiatToken coin (cbBTC, cbXRP, USDC) its
//     issuer has blacklisted neither - the router asks the same questions on chain
//     and refuses the trade otherwise (routerRoute).

/// WHAT EACH ENDPOINT AND CHAIN SAID ABOUT THE ROUTER'S CODE, once it answered.
/// A read that failed is not an answer and is not kept: the next quote asks
/// again.
const routerVerdicts = new Map();
/// THE NEWEST VERDICT FOR THE ENDPOINT ON SCREEN, for the token view, which has
/// to decide what to offer without waiting: true, false, or null (not asked yet).
let routerSeen = { rpc: "", ok: null };

/// WHETHER THE CURB ROUTER IS THERE, AS THE CHAIN SAYS.
/// @param how  { rpc, read(method, params), chainId? } - the pinned endpoint for
///             an action (with the chain it checked), the live one for a quote.
/// @param fresh  ask the chain now, whatever was kept. A quote may use what
///               was kept; a send to the router never does (routerStillThere).
/// @return { ok, why } - why is a reason for a person when ok is false.
async function routerReady(how, fresh = false) {
  let chain;
  try { chain = how.chainId || await how.read("eth_chainId", []); }
  catch { return { ok: false, why: "this network could not be asked whether the CURB router is on it" }; }
  const key = String(how.rpc || "").toLowerCase() + "|" + String(chain).toLowerCase();
  if (!fresh && routerVerdicts.has(key)) return routerVerdicts.get(key);
  let code;
  try { code = await how.read("eth_getCode", [CURB_ROUTER.address, "latest"]); }
  catch { return { ok: false, why: "the CURB router's code could not be read just now" }; }
  // THE HASH OF THE CODE, NOT THE PRESENCE OF CODE. An address with other code
  // at it takes the ETH just as well as the router would, and does something
  // else with it.
  const verdict = !code || code === "0x"
    ? { ok: false, why: "the CURB router is not deployed on this network" }
    : same(keccak256(code), CURB_ROUTER.codehash)
      ? { ok: true, why: "" }
      : { ok: false, why: "the code at the CURB router's address is not the router this page knows" };
  routerVerdicts.set(key, verdict);
  if (how.rpc === chainCfg.rpc) routerSeen = { rpc: how.rpc, ok: verdict.ok };
  return verdict;
}

/// What the token view may assume before it asks: the last verdict for the
/// endpoint on screen, or null.
const routerUsable = () => (routerSeen.rpc === chainCfg.rpc ? routerSeen.ok : null);

/// THE ISSUER'S REFUSAL OF THIS ACCOUNT, in the words the policy row uses.
const restrictedTrade = (sym, policy) =>
  "The issuer of " + sym + " has restricted this account (policy " + policy + "). A transfer to it reverts with " +
  "PolicyForbids, so this trade would fail after you paid the gas. Every tokenized equity measured sits under the " +
  "SAME policy with the same admin, so choosing another stock does not route around it. Nothing was sent.";

/// WHETHER THIS TRADE GOES THROUGH THE ROUTER.
/// @param how  routerReady's, plus { call, from, quote, quoteSym }
/// @return { use: true } | { use: false, why } | { use: false, blocked: policy }
///
/// ON A STOCK PAIR THE ROUTER ENFORCES THE ISSUER'S POLICY: it refuses a caller,
/// a recipient or itself that the asset's sender or receiver policy rejects
/// (CurbRouter._checkIssuer). So the same two questions are asked here first,
/// with policyStanding: this account's - refused, and no route would work, so
/// the trade is refused with the policy row's message - and the router's -
/// refused, and the trade takes the longer way it took before the router. An
/// answer that could not be read is not a refusal; the simulation before the
/// send still catches one.
/// @param standingP  buyerStanding's promise, when the caller asks about the
///                   account itself (an ETH buy): then only the router's
///                   questions are asked here, and the account's answers are
///                   taken from it.
async function routerRoute(how, standingP) {
  const ready = await routerReady(how);
  if (!ready.ok) return { use: false, why: ready.why };
  if (same(how.quote, WETH)) return { use: true };
  const ask = (to, data) => how.call(to, data);
  const [me, router, meListed, routerListed] = await Promise.all([
    standingP ? standingP.then((s) => (s.blocked ? { known: true, allowed: false, policy: s.blocked } : { known: false }))
      : policyStanding(how.quote, how.from, ask, how),
    policyStanding(how.quote, CURB_ROUTER.address, ask, how),
    standingP ? standingP.then((s) => !!s.listed) : coinBlacklists(how.quote, how.from, ask),
    coinBlacklists(how.quote, CURB_ROUTER.address, ask),
  ]);
  if (me.known && !me.allowed) return { use: false, blocked: me.policy };
  if (meListed) return { use: false, listed: true };
  const sym = how.quoteSym || "the pair's asset";
  if (router.known && !router.allowed) {
    return { use: false, why: "the issuer of " + sym + " does not let the CURB router hold it (policy " + router.policy + ")" };
  }
  if (routerListed) return { use: false, why: "the issuer of " + sym + " has blacklisted the CURB router" };
  return { use: true };
}

/// A FIATTOKEN COIN'S OWN BLACKLIST (cbBTC, cbXRP, and Circle's USDC since
/// 2026-10-15: isBlacklisted), the question the router asks of every asset that
/// is neither WETH nor a B20 (CurbRouter._notBlacklisted). Only an answer of
/// exactly 1 is a yes; a revert, nothing or anything else means the asset keeps
/// no such list - a B20 refuses the selector, and so do VIRTUAL and AERO, plain
/// ERC-20s measured on live Base that day - and a read that failed is not a
/// refusal either: the simulation before the send still catches one.
async function coinBlacklists(quote, who, ask) {
  try {
    const w = words(await ask(quote, SEL.isBlacklisted + pad32(who)));
    return w.length > 0 && wordToBig(w[0]) === 1n;
  } catch { return false; }
}

/// THE COIN'S ISSUER HAS BLACKLISTED THIS ACCOUNT: it refuses any transfer to
/// or from it, so no route to this pair works for it.
const blacklistedTrade = (sym) =>
  "The issuer of " + sym + " has blacklisted this account: it refuses every transfer to or from it, so this trade " +
  "would fail after you paid the gas. Nothing was sent.";

/// THE ROUTER'S OWN REFUSALS, as sentences - keyed by selector, derived from
/// ICurbRouter's signatures like every selector here.
const ROUTER_REFUSALS = {
  [sig("Expired(uint256,uint256)")]: () => "its deadline passed before it could be mined.",
  [sig("ZeroRecipient()")]: () => "it names no one to pay.",
  [sig("RecipientIsTheRouter()")]: () => "it would pay the router itself.",
  [sig("RecipientCannotBePaid(address)")]: (w) => wordToAddress(w[0]) + " cannot be paid through it.",
  [sig("NoEthSent()")]: () => "no ETH was sent with the buy.",
  [sig("NotALaunch(address,address)")]: () => "the registry does not record this launch.",
  [sig("PathOnWethLaunch()")]: () => "a swap route was given for an ETH pair, which needs none.",
  [sig("MalformedPath(uint256)")]: () => "the swap route is malformed.",
  [sig("PathStartsElsewhere(address,address)")]: () => "the swap route starts at the wrong asset.",
  [sig("PathEndsElsewhere(address,address)")]: () => "the swap route ends at the wrong asset.",
  [sig("NoQuoteMinimum()")]: () => "the swap has no floor under it.",
  [sig("NoEthMinimum()")]: () => "the ETH it pays has no floor under it.",
  [sig("QuoteBelowMinimum(uint256,uint256)")]: () =>
    "the swap would deliver less of the pair's asset than your slippage allows.",
  [sig("EthBelowMinimum(uint256,uint256)")]: () => "the sale would pay less ETH than your slippage allows.",
  [sig("RouteLeftInput(uint256)")]: () => "a Uniswap pool on the route cannot take the whole amount.",
  [sig("RouteStoppedMidway(address,uint256)")]: () => "a Uniswap pool on the route cannot take the whole amount.",
  [sig("IssuerForbids(address,bytes32,uint64)")]: (w) =>
    "the issuer of the pair's asset does not let " +
    (same(wordToAddress(w[0]), CURB_ROUTER.address) ? "the CURB router" : wordToAddress(w[0])) +
    " send or receive it (policy " + wordToBig(w[2]) + ").",
  [sig("UnexpectedEth(address)")]: () => "it was sent ETH it does not take.",
  [sig("BlacklistedBy(address,address)")]: (w) =>
    "the issuer of the pair's asset has blacklisted " +
    (same(wordToAddress(w[1]), CURB_ROUTER.address) ? "the CURB router" : wordToAddress(w[1])) + ".",
};

/// THE EXACT TRANSACTION, RUN FIRST, so the wallet is never asked to sign one
/// the router refuses - and the refusal arrives as a sentence.
async function simulateRouter(pin, tx, what) {
  try {
    await pin.read("eth_call", [{ from: pin.from, to: tx.to, data: tx.data, value: tx.value || "0x0" }, "latest"]);
  } catch (e) {
    if (!isRevert(e)) {
      throw new Error(`${what} could not be checked before asking your wallet (${e && e.message ? e.message : String(e)}). ` +
        `Nothing was sent.`);
    }
    throw new Error(`The CURB router would refuse ${what}: ${revertSentence(e, ROUTER_REFUSALS)} Nothing was sent.`);
  }
}

// ---------------------------------------------------------------- the Aerodrome route
/// WHAT EACH ENDPOINT AND CHAIN SAID ABOUT AERODROME'S ROUTER AND QUOTER CODE,
/// once both reads answered (routerVerdicts' rule).
const aeroVerdicts = new Map();

/// WHETHER AERODROME'S ROUTER AND QUOTER ARE THE CODE THIS PAGE PINS, as the
/// chain says - routerReady's question, asked of both.
/// @param fresh  ask the chain now: a pin always does (aeroStillThere too).
/// @return { ok, why, unread } - unread when a code read failed (not kept).
async function aeroReady(how, fresh = false) {
  let chain;
  try { chain = how.chainId || await how.read("eth_chainId", []); }
  catch { return { ok: false, unread: true, why: "this network could not be asked whether Aerodrome's router is on it" }; }
  const key = String(how.rpc || "").toLowerCase() + "|" + String(chain).toLowerCase();
  if (!fresh && aeroVerdicts.has(key)) return aeroVerdicts.get(key);
  let codes;
  try {
    codes = await Promise.all([AERODROME.router.address, AERODROME.quoter.address]
      .map((a) => how.read("eth_getCode", [a, "latest"])));
  } catch { return { ok: false, unread: true, why: "Aerodrome's code could not be read just now" }; }
  const [router, quoter] = codes;
  const verdict = !router || router === "0x"
    ? { ok: false, why: "Aerodrome's swap router is not deployed on this network" }
    : !same(keccak256(router), AERODROME.router.codehash)
      ? { ok: false, why: "the code at Aerodrome's swap router's address is not the router this page knows" }
      : !quoter || quoter === "0x" || !same(keccak256(quoter), AERODROME.quoter.codehash)
        ? { ok: false, why: "the code at Aerodrome's quoter's address is not the quoter this page knows" }
        : { ok: true, why: "" };
  aeroVerdicts.set(key, verdict);
  return verdict;
}

/// THE ROUTER'S CODE, READ AGAIN IMMEDIATELY BEFORE THE WALLET IS ASKED to send
/// to it (routerStillThere's rule). The verdict is kept, so the next quote
/// takes another route.
async function aeroStillThere(pin) {
  const ready = await aeroReady(pin, true);
  if (!ready.ok) throw new Error(`This swap was not sent: ${ready.why}. Nothing was sent.`);
}

/// The packed path for Aerodrome: token, tick spacing (3 bytes, big-endian),
/// token - v3PathBytes's layout with `ts` for `fee`. Reversed for a sell-back.
function aeroPathBytes(hops, forward) {
  const list = forward ? hops : hops.slice().reverse();
  let out = (forward ? list[0].from : list[0].to).replace(/^0x/, "");
  for (const h of list) {
    out += (BigInt(h.ts) & 0xffffffn).toString(16).padStart(6, "0");
    out += (forward ? h.to : h.from).replace(/^0x/, "");
  }
  return "0x" + out.toLowerCase();
}

/// ONE ANSWER OF EITHER QUOTER (Uniswap's QuoterV2, Aerodrome's), decoded:
/// (amountOut, uint160[] sqrtPriceX96AfterList, ...). PARTIAL when a hop's
/// price ended at a bound: the pool ran out before the input was used, and
/// both quoters price that as if it were whole.
/// @return { out, partial } - or null when the answer cannot be read.
function decodeQuote(raw, hopCount) {
  const w = words(raw);
  if (w.length < 2) return null;
  try {
    const out = wordToBig(w[0]);
    const off = Number(wordToBig(w[1]) / 32n);
    if (!(off > 0) || off >= w.length) return null;
    const n = Number(wordToBig(w[off]));
    if (n !== hopCount || off + 1 + n > w.length) return null;
    const after = w.slice(off + 1, off + 1 + n).map(wordToBig);
    return { out, partial: after.some((s) => s <= MIN_SQRT_RATIO + 1n || s >= MAX_SQRT_RATIO - 1n) };
  } catch { return null; }
}

/// ONE CANDIDATE PATH, ASKED OF A QUOTER, bounded by QUOTE_TIMEOUT_MS and
/// QUOTE_GAS and cancelled on the limit (bestV3Leg says why).
/// @return { answered: true, out, partial } - a revert (or the node running
///         out of gas) is an answer, with out 0; { answered: false } for the
///         limit, an abort, a transport failure or an answer that cannot be read.
async function askQuoter(how, quoter, pathHex, hopCount, amountIn) {
  const abort = typeof AbortController === "function" ? new AbortController() : null;
  let timer;
  try {
    const data = SEL.quoteExactInputV3 + encode([T.bytes, T.uint(256)], [pathHex, amountIn]).slice(2);
    const raw = await Promise.race([
      how.call(quoter, data, abort ? abort.signal : undefined, QUOTE_GAS),
      new Promise((_, reject) => {
        timer = setTimeout(() => { if (abort) abort.abort(); reject(new Error("quote timed out")); }, QUOTE_TIMEOUT_MS);
      }),
    ]);
    const got = decodeQuote(raw, hopCount);
    return got ? { answered: true, out: got.out, partial: got.partial } : { answered: false };
  } catch (e) {
    if (abort) abort.abort();
    const ranOut = !!(e && e.fromNode && /out of gas|gas required exceeds/i.test(e.message || ""));
    return isRevert(e) || ranOut ? { answered: true, out: 0n, partial: false, reverted: true } : { answered: false };
  } finally {
    clearTimeout(timer);
  }
}

/// THE LEG, FROM EVERY CANDIDATE'S ANSWER: the complete candidate with the
/// largest out; else, when one at least answered, { partial: true } with the
/// largest answered; else { unread: true }.
function legOf(quoted) {
  let best = null;
  let bestAny = null;
  for (const c of quoted) {
    if (!c.answered) continue;
    if (!c.partial && !c.reverted && c.out > 0n && (!best || c.out > best.out)) best = c;
    if (!bestAny || c.out > bestAny.out) bestAny = c;
  }
  if (best) return { out: best.out, hops: best.hops, path: best.path, partial: false };
  if (bestAny) return { partial: true, out: bestAny.out, hops: bestAny.hops, path: bestAny.path };
  return { unread: true };
}

/// THE AERODROME LEG FOR AN ETH BUY OF `amountIn`: every AERO_PATHS row for the
/// pair, quoted in parallel on the pinned quoter.
/// @return a leg (legOf), or { off: why } when the pair is not a candidate or
///         Aerodrome is not usable here.
async function aeroLeg(how, amountIn, fresh) {
  const rows = aeroRows(how.quote);
  if (!rows) return { off: "not a candidate" };
  const throughUsdc = rows.some((hops) => hops.some((h) => same(h.to, USDC)));
  const [ready, usdcListed] = await Promise.all([
    aeroReady(how, fresh),
    // THE ROUTER HOLDS USDC BETWEEN THE HOPS: a path through it is dropped when
    // Circle has blacklisted the router. A read that failed is not a listing;
    // the simulation before the send catches one.
    throughUsdc ? coinBlacklists(USDC, AERODROME.router.address, (to, data) => how.call(to, data)) : false,
  ]);
  if (ready.unread) return { unread: true };
  if (!ready.ok) return { off: ready.why };
  const usable = rows.filter((hops) => !(usdcListed && hops.some((h) => same(h.to, USDC))));
  if (!usable.length) return { off: "the issuer of USDC has blacklisted Aerodrome's router" };
  const quoted = await Promise.all(usable.map(async (hops) => {
    const path = aeroPathBytes(hops, true);
    return { ...(await askQuoter(how, AERODROME.quoter.address, path, hops.length, amountIn)), hops, path };
  }));
  return legOf(quoted);
}

/// THE UNISWAP LEG FOR AN ETH BUY, classified the same way and never throwing.
async function uniLeg(how, amountIn) {
  try { return await bestV3Leg(how, true, amountIn); } catch { return { unread: true }; }
}

/// WHICH ROUTE AN ETH BUY TAKES (preferAerodrome), as a pure function.
///   - with the CURB router usable: Aerodrome only when it beats the one-send
///     route by AERO_MARGIN_BPS and AERO_MIN_GAIN_WEI of value, or when Uniswap
///     answered and cannot fill the whole amount; an unread Uniswap leg never
///     turns a one-send buy into three confirmations.
///   - without it: Aerodrome whenever it is usable and delivers at least what
///     the UniversalRouter two-step would - both are two-step, and Aerodrome's
///     carries a code-hash pin, a simulation and the partial guard.
/// @param aero  null unless the Aerodrome leg is complete or partial and the
///              issuer's two-step answers allow it.
function preferAerodrome({ amountIn, uni, aero, oneSend }) {
  if (!aero || aero.partial || !(aero.out > 0n)) return { use: false, why: "no-aero" };
  if (!uni || uni.unread) return oneSend ? { use: false, why: "uni-unread" } : { use: true, why: "only-route" };
  if (uni.partial || !(uni.out > 0n)) return { use: true, why: "one-step-cannot-fill" };
  if (!oneSend) return aero.out >= uni.out ? { use: true, why: "no-one-send" } : { use: false, why: "uniswap-better" };
  if (aero.out * 10000n < uni.out * (10000n + AERO_MARGIN_BPS)) return { use: false, why: "margin" };
  if (((aero.out - uni.out) * amountIn) / aero.out < AERO_MIN_GAIN_WEI) return { use: false, why: "floor" };
  return { use: true, why: "better" };
}

/// THE STEP-1 TRANSACTION: multicall([exactInput(path, recipient, deadline,
/// amountIn, amountOutMinimum), refundETH()]), the ETH as value. The recipient
/// is the buyer, never 0 - which would leave the asset on the router.
function aeroBuyData(pathHex, recipient, deadline, amountIn, minOut) {
  const inner = SEL.aeroExactInput + pad32Num(0x20) + encode(
    [T.bytes, T.address, T.uint(256), T.uint(256), T.uint(256)],
    [pathHex, recipient, deadline, amountIn, minOut]).slice(2);
  return SEL.aeroMulticall + encode([T.array(T.bytes)], [[inner, SEL.refundEth]]).slice(2);
}

/// THE SELL-BACK TRANSACTION: the reversed path into WETH held by the router,
/// then unwrapWETH9 pays it all to the buyer in ETH - and refuses below `minWeth`.
function aeroSellData(pathHex, deadline, amountIn, minWeth, to) {
  const inner = SEL.aeroExactInput + pad32Num(0x20) + encode(
    [T.bytes, T.address, T.uint(256), T.uint(256), T.uint(256)],
    [pathHex, AERODROME.router.address, deadline, amountIn, minWeth]).slice(2);
  const unwrap = SEL.unwrapWeth9 + encode([T.uint(256), T.address], [minWeth, to]).slice(2);
  return SEL.aeroMulticall + encode([T.array(T.bytes)], [[inner, unwrap]]).slice(2);
}

/// AERODROME'S REFUSALS, as the sentence after "Aerodrome would refuse this
/// swap: " - Error(string) from its router, its periphery's TransferHelper or
/// a pool. A passed deadline reverts with no data at all.
const AERO_REFUSALS = {
  "Too little received": "it would deliver less than your slippage allows.",
  IW: "it would pay less ETH than your slippage allows.",
  TF: "a pool on the route could not pay out (an issuer's policy or blacklist, or a pool short of the asset).",
  ST: "a transfer the swap needs was refused (an issuer's policy or blacklist).",
  STF: "a transfer the swap needs was refused (an issuer's policy or blacklist).",
  STE: "it could not pay ETH to this account.",
};
/// An Error(string)'s string, from revert data, or null.
function revertString(data) {
  const h = String(data || "").replace(/^0x/, "");
  if (!h.toLowerCase().startsWith("08c379a0")) return null;
  try {
    const w = words("0x" + h.slice(8));
    const off = Number(wordToBig(w[0]) / 32n);
    const len = Number(wordToBig(w[off]));
    const bytes = h.slice(8 + (off + 1) * 64, 8 + (off + 1) * 64 + len * 2);
    return decodeURIComponent(bytes.replace(/../g, "%$&"));
  } catch { return null; }
}
function aeroRefusal(e) {
  const data = revertData(e);
  if (!data || data === "0x") return "it gave no reason (a passed deadline gives none).";
  const s = revertString(data);
  if (s === null) return revertSentence(e, {});
  return AERO_REFUSALS[s] || `the router said "${s}".`;
}

/// A GAS LIMIT WITH ROOM, for a send to Aerodrome's router: twice the node's
/// estimate. Its pools ask their fee module inside the swap, and an estimate
/// counts gas used, not the 1/64 every call keeps back - on the fork a step 1
/// estimated at 537,834 ran out of gas inside the USDC/SPCXc pool and reverted,
/// and the same transaction with twice that used 450,927. Gas not used is not
/// charged. An estimate that fails leaves a fixed 1,000,000 (the simulation
/// before it has passed).
async function withGasRoom(pin, tx) {
  let est = null;
  try {
    est = BigInt(await pin.read("eth_estimateGas", [{ from: pin.from, to: tx.to, data: tx.data, value: tx.value || "0x0" }]));
  } catch { est = null; }
  return { ...tx, gas: "0x" + (est === null || !(est > 0n) ? 1_000_000n : est * 2n).toString(16) };
}

/// THE EXACT TRANSACTION TO AERODROME'S ROUTER, run first through the pinned
/// endpoint, so the wallet is never asked to sign one it refuses.
async function simulateAero(pin, tx, what) {
  try {
    await pin.read("eth_call", [{ from: pin.from, to: tx.to, data: tx.data, value: tx.value || "0x0" }, "latest"]);
  } catch (e) {
    if (!isRevert(e)) {
      throw new Error(`${what} could not be checked before asking your wallet (${e && e.message ? e.message : String(e)}). ` +
        `Nothing was sent.`);
    }
    throw new Error(`Aerodrome would refuse this swap: ${aeroRefusal(e)} Nothing was sent.`);
  }
}

/// ONE v3 PATH, QUOTED AS IT IS. bestV3Leg chooses the path; this prices the
/// chosen one at another amount - the floor of a sale, where the curve pays its
/// minimum and the swap has to start from that.
async function quoteV3Path(how, path, amountIn) {
  const abort = typeof AbortController === "function" ? new AbortController() : null;
  let timer;
  try {
    const w = words(await Promise.race([
      how.call(QUOTER_V2, SEL.quoteExactInputV3 + encode([T.bytes, T.uint(256)], [path, amountIn]).slice(2),
        abort ? abort.signal : undefined, QUOTE_GAS),
      new Promise((_, reject) => {
        timer = setTimeout(() => { if (abort) abort.abort(); reject(new Error("quote timed out")); }, QUOTE_TIMEOUT_MS);
      }),
    ]));
    return w.length ? wordToBig(w[0]) : 0n;
  } finally {
    clearTimeout(timer);
  }
}

const MAX_UINT = (1n << 256n) - 1n;

/// A CURVE TRADE THROUGH THE ROUTER, priced: the bounds it carries are the
/// slippage off a fresh quote, and none of them may be zero.
///   buy   ETH in. minQuoteOut is the slippage off QuoterV2's answer for the
///         path (on an ETH pair the quote IS the ETH, so it is the amount);
///         minTokensOut the slippage off what that minimum buys on the curve.
///   sale  tokens in. minQuoteOut is the curve's own bound; minEthOut the
///         slippage off what the path pays for THAT minimum.
/// @param given  on a buy, the Uniswap leg already quoted for this amount
///               (computeCurveQuote's uniLeg) - used instead of asking again.
async function routerQuote(w, side, amount, r, fees, sellable, slip, given) {
  const bps = Math.round(slip * 100);
  const sym = w.quoteSym || quoteSym;
  const noFloor = (what) => ({
    error: `At ${slip}% slippage ${what} would have no floor at all, and the router refuses that. ` +
      `Lower the slippage, or raise the amount.`,
  });
  const weth = same(w.quote, WETH);
  if (side === "buy") {
    let leg;
    if (weth) leg = { out: amount, hops: [], direct: true };
    else if (given && !given.unread && !given.partial) leg = given;
    else {
      try { leg = await quoteV3(w, true, amount); } catch (e) { return { error: e.message || String(e) }; }
    }
    if (!leg || leg.out === 0n) return { error: "Cannot swap this much ETH into the pair's asset." };
    const midMin = weth ? amount : withSlippage(leg.out, bps);
    if (!(midMin > 0n)) return noFloor("the swap into " + sym);
    const q = quoteBuy(leg.out, r, fees, sellable);
    const qMin = quoteBuy(midMin, r, fees, sellable);
    if (q.unpriceable || qMin.unpriceable) return { error: "The curve cannot price a trade this size." };
    if (qMin.out === 0n) return { error: "That amount is too small to receive anything." };
    // A PRICE BOUND ON THE BUY THE THRESHOLD CLAMPS (buyMin).
    const min = buyMin(qMin, bps);
    if (!(min > 0n)) return noFloor("the buy");
    return {
      side, amount, fees, slip, q, curve: w.view.curve, reserves: r, via: "router", steps: 1,
      mid: leg.out, midMin, min, minBasis: qMin.offered, minIsPrice: !!(qMin.clamped && qMin.spent > 0n),
      route: { hops: leg.hops, direct: !!leg.direct },
      path: weth ? "0x" : v3PathBytes({ hops: leg.hops }, true),
    };
  }
  const q = quoteSell(amount, r, fees);
  if (q.out === 0n) return { error: "That amount is too small to receive anything." };
  const min = withSlippage(q.out, bps);
  if (!(min > 0n)) return noFloor("the sale");
  let ethOut, ethMin, route, path;
  if (weth) {
    ethOut = q.out; ethMin = min; route = { hops: [], direct: true }; path = "0x";
  } else {
    let leg;
    try { leg = await quoteV3(w, false, q.out); } catch (e) { return { error: e.message || String(e) }; }
    if (!leg || leg.out === 0n) return { error: "Cannot swap this much " + sym + " into ETH." };
    path = v3PathBytes({ hops: leg.hops }, false);
    let atMin;
    try { atMin = await quoteV3Path(w, path, min); } catch (e) { return { error: "The route into ETH could not be priced: " + (e.message || e) }; }
    ethOut = leg.out; ethMin = withSlippage(atMin, bps); route = { hops: leg.hops, direct: false };
  }
  if (!(ethMin > 0n)) return noFloor("the ETH this sale pays");
  // THE ROUTER'S ALLOWANCE, ASKED ONCE PER TOKEN AND WITHOUT A LIMIT (the
  // owner's call): a sale of a token it already covers is one confirmation.
  let allowance = null;
  if (w.from && isAddr(w.token)) {
    try {
      const a = words(await w.call(w.token, SEL.allowance + pad32(w.from) + pad32(CURB_ROUTER.address)));
      allowance = a.length ? wordToBig(a[0]) : null;
    } catch { allowance = null; }
  }
  return {
    side, amount, fees, slip, q, curve: w.view.curve, reserves: r, via: "router",
    steps: allowance === null ? null : allowance >= amount ? 1 : 2,
    min, ethOut, ethMin, route, path,
  };
}

/// HOW MANY TIMES THE WALLET ASKS, in words - what the card and the long page
/// both print.
const confirmationsWords = (v) =>
  v.steps === 1 ? "1 confirmation"
    : v.steps === 2 ? "2 confirmations (first sale of this token)"
      : "1 confirmation, or 2 the first time you sell this token";

/// THE LIVE ENDPOINT AND THE FORM'S LAUNCH, as computeCurveQuote reads them for
/// the screen: the same fields an action's pin carries.
const liveWhere = (shown) => ({
  call, read: rpc, rpc: chainCfg.rpc, view: shown || view, quoteDecimals: ctx.quoteDecimals, quote: ctx.quote,
  quoteSym: ctx.quoteSym, token: chainCfg.token, from: account, graduator: ctx.graduator,
});

/// The curve card's fields, read in one tick.
const readCurveForm = () => ({
  side: $("curveSide").value,
  slipText: ($("slippage").value || "").trim(),
  text: ($("curveAmount").value || "").trim(),
  via: $("curveVia") ? $("curveVia").value : "quote",
});

/// THE QUOTE IS RECOMPUTED, NEVER REMEMBERED.
///
/// The first version stashed the amount on the button's dataset and the action
/// read it back. Clear the field after typing 10 and the preview said "enter an
/// amount" while the button still carried 10 - and pressing it spent ten NVDAc
/// the user had just deleted. Nothing is carried between reading the form and
/// sending now: both go through here, and a null answer means no transaction.
/// @param where  { call, view, quoteDecimals } - pinned for an action, live for
///               rendering. Nothing in here reads a global, so the number shown
///               and the number sent cannot come from two different launches.
/// @param form  the fields to price, when not the form as it is now: a sale
///              re-priced after its approval is priced for what was pressed.
async function computeCurveQuote(where, form) {
  const w = where || liveWhere();
  // THE FORM IS READ ONCE, IN ONE TICK, BEFORE ANY AWAIT. The side was read
  // here and the amount and slippage after four round trips, so one quote could
  // pair the side of one moment with the amount of another - a buy's breakdown,
  // the amount scaled at the quote asset's decimals, under a Sell button
  // (round 5, N23).
  const f = form || readCurveForm();
  const { side, slipText, text } = f;
  // ETH ON EITHER SIDE, ON ANY PAIR: through the CURB router when it can be
  // used (routerRoute), one transaction. When it cannot, the flows from before
  // it: a buy on a pair that is not WETH swaps first and buys after
  // (curveBuyWithEth); on the WETH pair the direct path wraps what is short and
  // unwraps what the curve pays.
  const wantsEth = f.via === "eth" && !!w.quote;
  let route = null;
  // THE CURVE'S FOUR ANSWERS TOGETHER: none of them needs another, and one
  // after the other they were four round trips before every quote.
  const [feeWord, taxWord, sellableWord, resvWord] = await Promise.all([
    w.call(w.view.curve, SEL.feeBps), w.call(w.view.curve, SEL.creatorTaxBps),
    w.call(w.view.curve, SEL.sellableTokens), w.call(w.view.curve, SEL.getReserves),
  ]);
  const fees = { fee: wordToBig(words(feeWord)[0]), tax: wordToBig(words(taxWord)[0]) };
  const sellable = wordToBig(words(sellableWord)[0]);
  // THE RESERVES FROM THE CURVE ITSELF, like the fee and the sellable above.
  // They came from the lens's view, which is a link parameter: a lens naming
  // the right curve but under-reporting a reserve lowered the minimum a trader
  // signed, with the approval and the trade going to the real curve.
  const resv = words(resvWord);
  if (resv.length < 2) return { error: "The curve would not report its reserves." };
  const r = { quote: wordToBig(resv[0]), token: wordToBig(resv[1]) };

  const slip = Number(slipText);
  if (!slipText || !isFinite(slip) || slip < 0 || slip > 100) {
    return { error: "Slippage must be a percentage between 0 and 100." };
  }

  const decimals = side === "buy" ? (wantsEth ? 18 : w.quoteDecimals) : 18;
  if (!text) return { error: "Enter an amount." };
  let amount;
  try { amount = parseUnits(text, decimals); } catch (e) { return { error: e.message }; }
  if (amount === 0n) return { error: "Enter an amount above zero." };

  // NO BUY INTO A LAUNCH THAT COULD NOT GRADUATE (graduationBlocked), however it
  // is paid. Asked afresh for a send - a pin carries the wallet it sends
  // through - and from the last minute's answer for the quote on screen. A sale
  // is never stopped here: selling is the way out while the curve still sells.
  if (side === "buy") {
    const stuck = await graduationBlocked(w, w.view.curve, w.graduator, !!w.eth);
    if (stuck) return { error: stuck };
  }

  // AN ETH BUY ON A PAIR THAT IS NOT WETH: the CURB router in one send, the
  // swap on Aerodrome then the curve, or the UniversalRouter two-step - decided
  // here, on every quote, and never remembered on the button (ethBuyQuote).
  if (wantsEth && side === "buy" && !same(w.quote, WETH)) {
    return ethBuyQuote(w, f, amount, r, fees, sellable, slip);
  }

  // THE ROUTER OR NOT, decided on every quote - the one an action sends with
  // included - and never remembered on the button.
  let routerNote = "";
  if (wantsEth) {
    route = await routerRoute(w);
    if (route.blocked) return { error: restrictedTrade(w.quoteSym || quoteSym, route.blocked) };
    if (route.listed) return { error: blacklistedTrade(w.quoteSym || quoteSym) };
    if (route.use) {
      const v = await withConversion(w, await routerQuote(w, side, amount, r, fees, sellable, slip));
      if (!v.error) v.form = f;
      return v;
    }
    const sym = w.quoteSym || quoteSym;
    if (side === "sell" && !same(w.quote, WETH)) {
      // NO OTHER WAY TO ETH FROM THIS CURVE: it pays only its asset.
      return { error: "A sale here pays ETH only through the CURB router, and " + route.why + ". Choose " + sym +
        " to receive instead." };
    }
    routerNote = "Not through the CURB router: " + route.why + ", so this takes the longer way.";
  }

  const q = side === "buy" ? quoteBuy(amount, r, fees, sellable) : quoteSell(amount, r, fees);
  if (side === "buy" && q.unpriceable) return { error: "The curve cannot price a trade this size." };
  if (q.out === 0n) return { error: "That amount is too small to receive anything." };
  return {
    side, amount, fees, slip, q, curve: w.view.curve,
    // A BUY THE THRESHOLD CLAMPS IS BOUND BY ITS PRICE (buyMin).
    min: side === "buy" ? buyMin(q, Math.round(slip * 100)) : withSlippage(q.out, Math.round(slip * 100)),
    minBasis: side === "buy" ? q.offered : undefined,
    // CARRIED SO THE COST HAS A MID TO MEASURE AGAINST. The curve's mid is its
    // own reserve ratio; there is no pool and no oracle in this path.
    reserves: r, routerNote,
    // WETH CHOSEN ON A WETH PAIR: WETH in, WETH out - nothing wrapped before a
    // buy, nothing unwrapped after a sale or a refund. ETH chosen there and no
    // router is the other case: the shortfall wrapped, the proceeds unwrapped.
    wethOnly: !wantsEth && same(w.quote, WETH),
  };
}

const UNI_UNREAD = (sym) => "The ETH route could not be priced just now. Try again in a moment, or pay with " + sym + ".";
const UNI_PARTIAL = (sym) => "Uniswap cannot swap this much ETH into " + sym + " in full. Nothing is sent - pay with " +
  sym + " instead, or use a smaller amount.";
const TWO_STEP_UNCHECKED = (sym) => "Without the CURB router, paying ETH here takes two transactions, and the issuer " +
  "of " + sym + " has not been shown to allow the second. Nothing is sent - pay with " + sym + " instead.";

/// AN ETH BUY ON A PAIR THAT IS NOT WETH, priced every way it can go, in one
/// round: the account's standing with the issuer, the CURB router's own
/// questions, the issuer's answers for a two-step buy, and both venues. Then
/// preferAerodrome decides.
///   - A UNISWAP LEG THAT CANNOT TAKE THE WHOLE AMOUNT IS REFUSED here, on both
///     Uniswap routes: the CURB router used to refuse it only at its
///     simulation, and the UniversalRouter two-step executed it and left the
///     unspent WETH or USDC on the UniversalRouter for anybody to sweep.
///   - THE TWO-STEP ROUTES ARE OFFERED only when the issuer positively allows
///     both steps (twoStepStanding): a buyer must not be left holding an asset
///     the curve cannot take.
/// Every result carries `form`, `why` (the rule's reason), `aeroUnread` and
/// `steps` (1 through the CURB router, up to 3 for either two-step route).
async function ethBuyQuote(w, f, amount, r, fees, sellable, slip) {
  const fresh = !!w.eth;
  const sym = w.quoteSym || quoteSym;
  const standingP = buyerStanding(w, fresh);
  const [standing, route, gate, uni, aero] = await Promise.all([
    standingP,
    routerRoute(w, standingP),
    twoStepStanding(w, w.view.curve, fresh, standingP),
    uniLeg(w, amount),
    aeroLeg(w, amount, fresh),
  ]);
  if (standing.blocked) return { error: restrictedTrade(sym, standing.blocked) };
  if (standing.listed) return { error: blacklistedTrade(sym) };
  if (route.blocked) return { error: restrictedTrade(sym, route.blocked) };
  if (route.listed) return { error: blacklistedTrade(sym) };
  const usable = aero.unread || aero.off || !gate.aeroOk ? null : aero;
  const pick = preferAerodrome({ amountIn: amount, uni, aero: usable, oneSend: !!route.use });
  const tag = (v) => (v.error ? v : Object.assign(v, { form: f, why: pick.why, aeroUnread: !!aero.unread }));
  const routerNote = route.use ? "" : "Not through the CURB router: " + route.why + ", so this takes the longer way.";
  if (pick.use) return tag(await withConversion(w, aeroQuote(w, amount, usable, r, fees, sellable, slip, routerNote)));
  if (uni.unread) return { error: UNI_UNREAD(sym) };
  if (uni.partial) return { error: uni.out > 0n ? UNI_PARTIAL(sym) : "Cannot swap this much ETH into the pair's asset." };
  if (route.use) return tag(await withConversion(w, await routerQuote(w, "buy", amount, r, fees, sellable, slip, uni)));
  if (!gate.fallbackOk) return { error: TWO_STEP_UNCHECKED(sym) };
  return tag(await withConversion(w, uniTwoStepQuote(w, amount, uni, r, fees, sellable, slip, routerNote)));
}

/// THE UNIVERSALROUTER TWO-STEP, priced: TWO LEGS, EACH BOUNDED. The swap's
/// minimum is the slippage off what the route quotes; the curve's minimum is
/// the slippage off what that minimum would buy - so the worst case of both is
/// what the buyer signs for.
function uniTwoStepQuote(w, amount, leg, r, fees, sellable, slip, routerNote) {
  if (!leg || !(leg.out > 0n)) return { error: "Cannot swap this much ETH into the pair's asset." };
  const bps = Math.round(slip * 100);
  const midMin = withSlippage(leg.out, bps);
  const q = quoteBuy(leg.out, r, fees, sellable);
  const qMin = quoteBuy(midMin, r, fees, sellable);
  if (q.unpriceable || qMin.unpriceable) return { error: "The curve cannot price a trade this size." };
  if (qMin.out === 0n) return { error: "That amount is too small to receive anything." };
  return {
    side: "buy", amount, fees, slip, q, curve: w.view.curve, reserves: r, via: "eth", steps: 3,
    mid: leg.out, midMin, route: { hops: leg.hops, direct: !!leg.direct },
    min: buyMin(qMin, bps), minBasis: qMin.offered, minIsPrice: !!(qMin.clamped && qMin.spent > 0n), routerNote,
  };
}

/// THE AERODROME ROUTE, priced the same way: the swap's minimum is the slippage
/// off Aerodrome's quote, the curve's the slippage off what that minimum buys.
/// Its refusals are in its own words, not the router's.
function aeroQuote(w, amount, aero, r, fees, sellable, slip, routerNote) {
  const bps = Math.round(slip * 100);
  const sym = w.quoteSym || quoteSym;
  const noFloor = { error: `At ${slip}% slippage the swap into ${sym} would have no floor at all. Lower the ` +
    `slippage, or raise the amount.` };
  const midMin = withSlippage(aero.out, bps);
  if (!(midMin > 0n)) return noFloor;
  const q = quoteBuy(aero.out, r, fees, sellable);
  const qMin = quoteBuy(midMin, r, fees, sellable);
  if (q.unpriceable || qMin.unpriceable) return { error: "The curve cannot price a trade this size." };
  if (qMin.out === 0n) return { error: "That amount is too small to receive anything." };
  const min = buyMin(qMin, bps);
  if (!(min > 0n)) return noFloor;
  return {
    side: "buy", amount, fees, slip, q, curve: w.view.curve, reserves: r, via: "aero", steps: 3,
    mid: aero.out, midMin, min, minBasis: qMin.offered, minIsPrice: !!(qMin.clamped && qMin.spent > 0n),
    route: { hops: aero.hops, venue: "aerodrome" }, path: aero.path, routerNote,
  };
}

/// WHAT A BUY WILL TAKE THAT THE ACCOUNT DOES NOT HOLD, said before the press.
/// On the WETH pair the curve pulls WETH and takes no ETH: the shortfall is
/// wrapped from ETH as a transaction of its own (ensureQuoteHeld), and this is
/// where the buyer learns there will be one. Empty when nothing is short, or
/// when no balance has been read.
function heldNote(offered, wethOnly) {
  if (!account || !meta || !ctx || meta.quoteBal === undefined || meta.quoteBal >= offered) return "";
  const held = fmt(meta.quoteBal, ctx.quoteDecimals, 6) + " " + ctx.quoteSym;
  const short = offered - meta.quoteBal;
  if (same(ctx.quote, WETH) && wethOnly) {
    return note("You hold " + escapeHtml(held) + ", less than this buy offers, so it would be refused. Choose ETH " +
      "to pay with ether instead.");
  }
  if (same(ctx.quote, WETH)) {
    return note("You hold " + escapeHtml(held) + ". The curve takes WETH, not ETH, so the " +
      escapeHtml(fmt(short, 18, 6)) + " WETH short is wrapped from your ETH first - its own transaction, " +
      "before the approval and the buy.");
  }
  return note("You hold " + escapeHtml(held) + ", less than this buy offers, so it would be refused.");
}

/// ONLY THE LAST CURVE QUOTE ASKED FOR DRAWS, as with the pool (poolQuoteSeq).
/// A quote is asked on every keystroke and every change of side, with four
/// round trips each, and they land in any order: without this an older buy
/// quote drew its breakdown under a button already reading "Sell to the
/// curve", or one launch's figures landed under the next launch's ticker
/// (round 5, N23). What is sent was never affected - curveAction quotes again.
let curveQuoteSeq = 0;

/// THE CURVE QUOTE ON SCREEN, as the press compares it (curveActionInner): the
/// route it showed, its minimums (the swap's and the curve's, and what the
/// curve's is per), whether that minimum is a price, and how many
/// confirmations it said. Keyed by the exact fields it was priced from, so a
/// press of other fields matches nothing - and nothing has to clear it when the
/// card writes the same fields again.
/// ON THE TOKEN PAGE ONLY THE CARD WRITES IT (token.js requote): the long
/// page's fields are hidden there, and a refresh priced them on its own - a
/// quote the card had not drawn yet stood for the one on screen, and a press in
/// between sent Aerodrome under a card that said the CURB router.
let curveDrawn = null;
const drawnKey = (f, curve, from) =>
  [f.side, f.text, f.slipText, f.via, curve, from].map((x) => String(x || "").toLowerCase()).join("|");
function noteDrawn(v) {
  curveDrawn = v && !v.error && v.form && v.curve
    ? { key: drawnKey(v.form, v.curve, account), via: v.via || "", min: v.min, midMin: v.midMin,
        minBasis: v.minBasis, minIsPrice: !!v.minIsPrice,
        clamped: !!((v.q && v.q.clamped) || v.minIsPrice), steps: v.steps || 1 }
    : null;
}

/// NEVER BELOW THE MINIMUMS SHOWN, on the route that was shown. The press
/// prices it again, and a pool or a curve that moved since the quote was drawn
/// moved the fresh minimums with it - sent as they were, they were lower than
/// the "at least" the card printed. So each is the higher of the two: a move
/// within the slippage still fills, and one past it is refused by the
/// simulation rather than sent lower. A minimum that is a price (a clamped buy)
/// is held as a price: the one shown, per unit of what this press offers.
function floorAtDrawn(v, d) {
  if (!d || d.via !== v.via) return v;
  const out = { ...v };
  if (typeof d.midMin === "bigint" && typeof v.midMin === "bigint" && d.midMin > v.midMin) out.midMin = d.midMin;
  if (typeof d.min !== "bigint" || typeof v.min !== "bigint") return out;
  const shown = (d.minIsPrice || v.minIsPrice) && d.minBasis > 0n && v.minBasis > 0n
    ? (d.min * v.minBasis + d.minBasis - 1n) / d.minBasis
    : d.min;
  if (shown > v.min) out.min = shown;
  return out;
}
/// WHAT THE PRESS SAYS WHEN THE ROUTE OR PRICE IT WOULD SEND IS NOT THE ONE SHOWN.
const ROUTE_CHANGED = "The price or route changed since the quote was shown. Nothing was sent. Check the new " +
  "quote and press Buy again.";

/// A BUY THE THRESHOLD CLAMPS, SAID PLAINLY (the owner's call): how much of
/// the offer will be used, and that the rest comes back in the same
/// transaction - or how, where it does not. Shared with the swap card.
/// @param refundSym  what the rest comes back as on this route.
function clampWords(v, c, refundSym) {
  const q = v.q;
  const used = fmt(q.spent, c.quoteDecimals, 6) + " " + c.quoteSym;
  const offered = fmt(q.offered, c.quoteDecimals, 6) + " " + c.quoteSym;
  const back = fmt(q.refund, c.quoteDecimals, 6) + " " + refundSym;
  const how = v.via === "router" ? " It comes back to you as " + refundSym + ", in the same transaction."
    // TWO-STEP: the swap is its own transaction, so "the same transaction" is
    // the curve buy's - and what comes back is the pair's asset.
    : v.via === "aero" || v.via === "eth" ? " It comes back to you as " + refundSym + " with the curve buy."
    : v.wethOnly ? " It comes back as WETH, in the same transaction, and stays WETH."
    : same(c.quote, WETH) ? " It comes back as WETH, in the same transaction, and is unwrapped into ETH straight after - a second confirmation."
    : " It comes back to you as " + refundSym + ", in the same transaction.";
  return "This buy reaches the graduation threshold, so only " + used + " of the " + offered + " offered will be " +
    "used - the fee and the tax are charged on that - and the rest, " + back + ", is not spent." + how;
}

async function renderCurveQuote() {
  const mine = ++curveQuoteSeq;
  const stale = () => mine !== curveQuoteSeq;
  const out = $("curveQuote");
  const act = $("curveAct");
  const invalid = (why) => { out.textContent = why; act.disabled = true; };
  // THE CONTEXT THIS QUOTE IS PRICED AND LABELLED IN, taken with the form in
  // one tick: the decimals it scales by and the ticker it prints are the same
  // asset's, whatever ctx is when the answer lands.
  const c = ctx;
  const shown = view;
  act.textContent = $("curveSide").value === "buy" ? "Buy on the curve" : "Sell to the curve";
  if ($("curveViaLabel")) $("curveViaLabel").textContent = $("curveSide").value === "buy" ? "Pay with" : "Receive";
  // AND ONLY WHEN THE LAUNCH ON SCREEN IS IN THAT ASSET. refresh() swaps ctx
  // for the new factory's before it has read the launch, so a keystroke in that
  // gap met the last launch's curve and the next factory's asset: it priced one
  // launch's curve at another asset's decimals and printed that asset's ticker
  // under it (round 5, N23). The refresh that is out draws the quote again.
  if (!c || !shown || !same(shown.quoteToken, c.quote)) {
    return invalid("The launch on screen is being read again for the asset now in the form; its quote follows.");
  }
  try {
    const v = await computeCurveQuote({ ...liveWhere(shown), quoteDecimals: c.quoteDecimals, quote: c.quote, quoteSym: c.quoteSym,
      graduator: c.graduator });
    if (stale()) return;
    if (!TOKEN_VIEW) noteDrawn(v);
    if (v.error) return invalid(v.error);
    // WHY THE ROUTER IS NOT USED, when ETH was asked for and it is not.
    const routerLine = v.routerNote ? note(escapeHtml(v.routerNote)) : "";

    const { q, fees, slip, min } = v;
    // THE TAX IS THE TWO CUTS TOGETHER. On the curve they arrive as separate
    // numbers - the platform's fixed share and the creator's remainder - but
    // what a person chose and what they pay is the sum.
    const taxTotalBps = Number(fees.fee) + Number(fees.tax);
    const costBps = curveCostBps(v);
    const costRow = costBps === null
      ? row("total execution cost", "not shown: the curve's reserves could not be read")
      : row("total execution cost",
          "<strong>" + (costBps / 100).toFixed(2) + "%</strong> against the curve's mid" +
          " — this launch's tax and the curve's own movement, gas not included");
    // THE TRADE'S OWN PRICE IMPACT (the owner's call: slippage is only the
    // tolerance; this is how far the trade itself moves the price).
    const imp = curveImpact(v);
    const impactRow = imp && imp.bps !== null
      ? row("price impact", `<strong class="impact ${impactLevel(imp.bps)}">${impactText(imp.bps)}</strong>` +
          " — how much worse than the curve's price now, before the fee and the tax")
      : "";
    const impactLine = imp ? impactWarning(imp, v.side) : "";
    const impactNote = impactLine
      ? `<p class="note warn impactWarn ${impactLevel(imp.bps)}">${escapeHtml(impactLine)}</p>` : "";
    const convRows = convRowsOf(v, c.quoteSym);
    const taxRow = row("this launch's tax",
      (taxTotalBps / 100) + "% of the " + c.quoteSym + " " + (v.side === "buy" ? "spent" : "this sale produces") +
      " — permanent, chosen by the creator");
    if (v.side === "buy") {
      // PAID IN ETH: the swap first, then the curve rows for what it delivers.
      // ON THE WETH PAIR THROUGH THE ROUTER there is no swap, but the payment
      // is still ETH: said as ETH, and wrapped one for one into the WETH the
      // curve rows are in - and what comes back past the threshold is ETH.
      const wethPair = same(c.quote, WETH);
      const ethRows = (v.via === "eth" || v.via === "router" || v.via === "aero") && !wethPair
        ? row("you pay", fmt(v.amount, 18, 6) + " ETH") +
          row((v.via === "aero" ? "routed on Aerodrome: " : "routed: ") + escapeHtml(routeWords(v.route, c.quoteSym, true)),
            "about " + fmt(v.mid, c.quoteDecimals, 6) + " " + c.quoteSym + ", at least " +
            fmt(v.midMin, c.quoteDecimals, 6) + " (" + slip + "% slippage)")
        : v.via === "router" && wethPair
        ? row("you pay", fmt(v.amount, 18, 6) + " ETH, wrapped one for one into WETH for the curve")
        : "";
      const refundSym = v.via === "router" && wethPair ? "ETH" : c.quoteSym;
      out.innerHTML = ethRows +
        row("you offer", fmt(q.offered, c.quoteDecimals, 6) + " " + c.quoteSym) +
        (q.clamped ? row("actually spent", fmt(q.spent, c.quoteDecimals, 6) + " " + c.quoteSym) : "") +
        (q.clamped ? row("refunded to you", fmt(q.refund, c.quoteDecimals, 6) + " " + refundSym) : "") +
        taxRow +
        row("platform fee", fmt(q.fee, c.quoteDecimals, 6) + " " + c.quoteSym + " (" + fees.fee + " bps of what is spent)") +
        row(feeName(view), fmt(q.tax, c.quoteDecimals, 6) + " " + c.quoteSym + " (" + fees.tax + " bps of what is spent)") +
        row("into the curve", fmt(q.net, c.quoteDecimals, 6) + " " + c.quoteSym) +
        row("expected out", "<strong>" + fmt(q.out, 18, 6) + "</strong> tokens") +
        // A CLAMPED BUY IS BOUND BY ITS PRICE, NOT AN AMOUNT (buyMin): what is
        // left on the curve when it lands is what it gets, at no worse a price.
        (q.clamped
          ? row("minimum out", "no fixed amount: the curve's rest, at no worse than " +
              fmt((min * 10n ** BigInt(c.quoteDecimals)) / (v.minBasis || q.offered), 18, 6) + " tokens per " +
              c.quoteSym + " spent (" + slip + "% slippage)")
          : row("minimum out", fmt(min, 18, 6) + " tokens (" + slip + "% slippage)")) +
        slippageWarning(slip, min) +
        impactRow + impactNote + convRows +
        costRow +
        (v.via === "router"
          ? note("1 confirmation: the CURB router " + (same(c.quote, WETH) ? "wraps your ETH" :
                 "swaps your ETH into " + escapeHtml(c.quoteSym)) + " and buys on the curve in the same transaction.")
          : v.via === "aero"
          ? note("Up to 3 confirmations: the swap on Aerodrome, then the curve buy.")
          : v.via === "eth"
          ? note("Two steps, each its own confirmation: the swap of your ETH into " + escapeHtml(c.quoteSym) +
                 ", then the curve buy with exactly what it delivers (with an approval first when needed).")
          : heldNote(q.offered, v.wethOnly)) + routerLine +
        (q.clamped
          ? `<p class="note clampNote">${escapeHtml(clampWords(v, c, refundSym))}</p>`
          : "");
    } else {
      out.innerHTML =
        row("you sell", fmt(v.amount, 18, 6) + " tokens") +
        row("gross", fmt(q.gross, c.quoteDecimals, 6) + " " + c.quoteSym) +
        taxRow +
        row("platform fee", fmt(q.fee, c.quoteDecimals, 6) + " " + c.quoteSym + " (" + fees.fee + " bps)") +
        row(feeName(view), fmt(q.tax, c.quoteDecimals, 6) + " " + c.quoteSym + " (" + fees.tax + " bps)") +
        row("expected out", "<strong>" + fmt(q.out, c.quoteDecimals, 6) + "</strong> " + c.quoteSym) +
        row("minimum out", fmt(min, c.quoteDecimals, 6) + " " + c.quoteSym + " (" + slip + "% slippage)") +
        slippageWarning(slip, min) +
        impactRow + impactNote + convRows +
        (v.via === "router"
          ? row("you receive", "about <strong>" + fmt(v.ethOut, 18, 6) + "</strong> ETH, at least " + fmt(v.ethMin, 18, 6) +
              " ETH" + (same(c.quote, WETH) ? "" : " - routed " + escapeHtml(routeWords(v.route, c.quoteSym, false))))
          : "") +
        costRow +
        (v.via === "router"
          ? note(escapeHtml(confirmationsWords(v)) + ": the CURB router sells to the curve and pays you ETH in one " +
                 "transaction." + (v.steps === 1 ? ""
                   : v.steps === 2 ? " Your wallet first asks to let the router move this token - once, with no limit."
                   : " The first time you sell this token through it, your wallet first asks to let the router " +
                     "move it - once, with no limit."))
          : v.wethOnly
          ? note("WETH chosen: the curve pays WETH, and it stays WETH in your wallet. Choose ETH to be paid ether.")
          // ETHER BACK ON THE WETH PAIR: said before the press - see unwrapPaid.
          : same(c.quote, WETH)
          ? note("The curve pays WETH, and it is unwrapped into ETH straight after - its own transaction, so your " +
                 "wallet asks twice.")
          : "") + routerLine;
    }
    act.disabled = !account || busy;
  } catch (e) {
    if (stale()) return;
    if (!TOKEN_VIEW) noteDrawn(null);
    invalid(e.message || String(e));
  }
}

/// Same rule as the curve: recomputed on demand, never carried on the button.
/// THE v3 LEG, PRICED BY THE CHAIN. QuoterV2 simulates the swap and returns
/// what would come out; eth_call is enough because nothing is written.
/// THE WETH/NVDAc MID, as the pool's own sqrt price rather than as a number.
///
/// WHY NOT ASK THE QUOTER. A quote is a price you would get, fee and impact
/// included; a mid is the price before either. Measuring a cost against a
/// quote would report zero cost by construction.
///
/// AND WHY NOT CARRY IT AS A 1e18 FIXED POINT, which is what this did first.
/// These prices are ratios of raw units with very different decimals - tokens
/// per NVDAc is around 4e16, NVDAc per WETH around 2e-8 - and a reciprocal
/// taken in 1e18 quantises to a couple of significant figures. The cost line
/// came out NEGATIVE on a sell, which is how it was found. Every conversion
/// below is one BigInt ratio with the 2^192 kept in it.

/// WHICH POOLS EXIST BETWEEN TWO TOKENS, and what each holds of `of`. The
/// custody figure is what decides the route: a pool cannot sell more of an
/// asset than it holds, so the one holding more is the one a buyer can use.
async function v3PoolsBetween(how, a, b, of) {
  const out = [];
  for (const fee of V3_TIERS) {
    const poolWord = words(await how.call(
      V3_FACTORY, SEL.v3GetPool + encode([T.address, T.address, T.uint(24)], [a, b, fee]).slice(2)
    ))[0];
    const pool = wordToAddress(poolWord);
    if (/^0x0{40}$/i.test(pool)) continue;
    const held = wordToBig(words(await how.call(of, SEL.balanceOf + pad32(pool)))[0] || "0x0");
    out.push({ fee, pool, held });
  }
  out.sort((x, y) => (y.held > x.held ? 1 : y.held < x.held ? -1 : 0));
  return out;
}

/// THE ROUTE FROM ETH TO THE QUOTE ASSET, discovered rather than assumed.
///
/// One hop where a WETH pool holds more of the asset than any USDC pool does;
/// two hops through USDC otherwise. For NVDAc that picks the WETH pool at 0.3%
/// - the route this page already used - and for every other equity measured it
/// picks USDC, because their WETH pools hold nothing or do not exist.
///
/// THE COINS OF 2026-10-15 MEASURED ON LIVE BASE: AERO's deepest pool is
/// AERO/WETH at 0.3% (one hop), VIRTUAL's is VIRTUAL/USDC at 0.3% (both kinds
/// are candidates, and the quoter picks), and USDC is the one asset with NO
/// USDC leg - its WETH pools are the direct hop (routesThroughUsdc).
///
/// NO EPSILON IS INVOLVED. The rule compares two measured custody figures
/// against each other, so there is no threshold anybody had to pick and
/// nothing to get wrong when liquidity moves.
/// THE CANDIDATE PATHS.
///
/// Discovery uses getPool and the pools' balances, which is cheap and picks
/// the TIER within a venue well: a pool cannot sell more of an asset than it
/// holds. It does NOT pick between venues - see bestV3Leg.
///
/// IT DEGRADES INSTEAD OF FAILING. The old code needed no pool lookup to
/// QUOTE - it named the tier and asked the quoter - so a broken getPool cost
/// the cost line and nothing else. Needing the lookup to build a path made a
/// transport failure kill the whole quote, which is strictly worse for
/// somebody trying to trade. So a failed lookup falls back to the plain
/// WETH->asset paths at every tier and lets the quoter sort them out; the
/// USDC route and the cost line are what is lost, and the trade still prices.
///
/// THE ADDRESSES ARE CACHED; THE DECISION IS NOT. A v3 pool's address is
/// CREATE2-deterministic from the factory, the pair and the tier, so it cannot
/// change and there is nothing to re-read. What CAN change - which route is
/// better right now - is asked of the quoter on every single quote, at the
/// real size, in bestV3Leg. A stale tier here can only mean a candidate was
/// missed, never that a price was wrong.
///
/// WITHOUT THE CACHE THIS COSTS ABOUT TWENTY eth_calls PER QUOTE. That is not
/// a test detail: it is twenty extra round trips every time somebody types a
/// digit, and it timed out the browser suite at sixty seconds.
const candidateCache = new Map();
/// WHETHER THE ROUTE MAY PASS THROUGH USDC: everywhere but on the USDC pair
/// itself (owner's list of 2026-10-15). There USDC is the END of the route, and
/// the WETH/USDC pools are the direct hop: asking for USDC/USDC pools (four
/// getPool calls that can only answer zero) and reading the WETH/USDC pools a
/// second time as a "first leg" (eight more) would be twelve wasted round trips
/// for every new quote asset read, and a USDC -> USDC hop is one no pool prices.
const routesThroughUsdc = (quote) => !same(quote, USDC);
async function v3Candidates(how) {
  const key = ((how.rpc || chainCfg.rpc || "") + "|" + (how.quote || "")).toLowerCase();
  if (candidateCache.has(key)) return candidateCache.get(key);
  try {
    const direct = await v3PoolsBetween(how, WETH, how.quote, how.quote);
    const viaUsdc = routesThroughUsdc(how.quote);
    const toQuote = viaUsdc ? await v3PoolsBetween(how, USDC, how.quote, how.quote) : [];
    const toUsdc = viaUsdc ? await v3PoolsBetween(how, WETH, USDC, USDC) : [];

    // EVERY TIER THAT EXISTS IS A CANDIDATE, AND THE QUOTER DECIDES.
    //
    // This used to keep only [0] of each list - the tier holding the most of
    // the asset - and throw the rest away before anything was priced. Custody
    // is not executable depth at the current price: a v3 pool's balance says
    // where its liquidity was placed, not how much of it is around the tick a
    // trade actually crosses. The same mistake the header of
    // measure-thresholds.js describes for PRICE, made for ROUTE. AUDIT M-03.
    //
    // THE TWO-HOP SIDE IS BOUNDED, because every path costs a quoter call and
    // the combinations multiply. Each leg is already sorted by custody, so the
    // top two per leg is four paths - enough to let a better tier win, not
    // enough to turn one quote into twenty round trips.
    const paths = [];
    for (const d of direct) {
      paths.push([{ from: WETH, to: how.quote, fee: d.fee, pool: d.pool }]);
    }
    // ONE TWO-HOP CANDIDATE, not four. Every extra path is a quoter call on
    // the page's critical path, and the tier that matters on the direct leg is
    // the one this finding was about; combining two tiers on each hop bought
    // little and cost four round trips per quote.
    if (toUsdc.length && toQuote.length) {
      paths.push([
        { from: WETH, to: USDC, fee: toUsdc[0].fee, pool: toUsdc[0].pool },
        { from: USDC, to: how.quote, fee: toQuote[0].fee, pool: toQuote[0].pool },
      ]);
    }
    // ONLY A SUCCESSFUL LOOKUP IS KEPT. Caching a failure would let one
    // dropped request decide the route for the rest of the session.
    if (paths.length) { candidateCache.set(key, paths); return paths; }
  } catch { /* fall through to the paths that need no lookup */ }

  // NO POOL ADDRESSES HERE, so no mid either - which is why the cost line goes
  // and says so rather than being computed from something that was not read.
  return V3_TIERS.map((fee) => [{ from: WETH, to: how.quote, fee, pool: null }]);
}

/// THE ROUTE, CHOSEN BY ASKING WHAT COMES OUT.
///
/// An earlier version chose by custody and called the rule direction-neutral.
/// It is not. Custody says where an asset can be BOUGHT; it says nothing about
/// where it can be SOLD, and for NVDAc the two answers differ by 85% at the
/// size of a graduation threshold - the WETH pool holds 0.818 WETH and simply
/// runs out. So both candidates are quoted at the real amount and the better
/// one wins. Two extra eth_calls, and no proxy for the thing being decided.
async function bestV3Leg(how, wethToQuote, amountIn) {
  const paths = await v3Candidates(how);
  if (!paths.length) return { unread: true };
  // QUOTED IN PARALLEL, because the paths are independent and there are
  // several of them now. Asking the quoter about each tier in turn - which is
  // what this did when there was only ever one candidate - turned one price
  // into eight sequential round trips and timed the page out.
  // A PATH THAT WILL NOT ANSWER IN TIME IS NOT A PATH.
  //
  // QuoterV2 SIMULATES the swap, so a large amount against a nearly empty tier
  // walks every initialized tick between here and nowhere, and the eth_call
  // effectively never returns. That could not happen while only the deepest
  // tier was ever quoted; it can now that every tier is - and one such path
  // would hold up the whole quote, on the page as well as in a test.
  //
  // Abandoned rather than waited on: the other paths still answer, and a path
  // nobody can price in four seconds is not one to route a trade through.
  // AND THE CALL IS CANCELLED, not merely stopped being waited for. Giving up
  // on the promise while the request ran left the connection held: six of
  // those and the page could not ask the node anything at all, which is how a
  // four second limit turned into a fifty second freeze.
  // EACH PATH ENDS ONE OF THREE WAYS (askQuoter): complete, partial - the pool
  // ran out before the input was used, which the quoter prices as if it had
  // not - or not answered at all. THE BEST COMPLETE CANDIDATE WINS: a larger
  // partial one beside it used to win, and the swap then left the input it
  // could not use on the router for anybody to sweep. A path that failed must
  // not hide the others.
  const quoted = await Promise.all(paths.map(async (hops) => ({
    ...(await askQuoter(how, QUOTER_V2, v3PathBytes({ hops }, wethToQuote), hops.length, amountIn)), hops,
  })));
  return legOf(quoted);
}

/// The packed v3 path: token, fee, token, fee, token. Reversed for a sell,
/// because the router walks it in trade order.
function v3PathBytes(route, wethToQuote) {
  const hops = wethToQuote ? route.hops : route.hops.slice().reverse();
  let out = (wethToQuote ? hops[0].from : hops[0].to).replace(/^0x/, "");
  for (const h of hops) {
    out += h.fee.toString(16).padStart(6, "0");
    out += (wethToQuote ? h.to : h.from).replace(/^0x/, "");
  }
  return "0x" + out;
}

/// THE MID OF THE ROUTE THAT WAS CHOSEN, one entry per hop. Only the cost
/// line uses it and the caller tolerates a null, so a route that cannot be
/// priced costs that line and nothing else.
/// The route in words, in trade order, with the tier of each hop - so the cost
/// line can be read against the path it came from.
function routeWords(route, sym, wethToQuote) {
  // A WRAP IS NOT A ROUTE, and saying "ETH → WETH → ETH" would describe the
  // round trip this replaced.
  if (route && route.direct) return wethToQuote ? "ETH → WETH (wrap only)" : "WETH → ETH (unwrap only)";
  if (!route || !route.hops || !route.hops.length) return wethToQuote ? "ETH in" : "ETH out";
  const name = (a) =>
    a.toLowerCase() === WETH.toLowerCase() ? "WETH"
      : a.toLowerCase() === USDC.toLowerCase() ? "USDC" : sym;
  const hops = wethToQuote ? route.hops : route.hops.slice().reverse();
  let out = wethToQuote ? "ETH → WETH" : name(hops[0].to);
  for (const h of hops) {
    const to = wethToQuote ? h.to : h.from;
    out += ` → ${name(to)}`;
  }
  if (!wethToQuote) out += " → ETH";
  return out;
}

async function v3MidsFor(how, hops) {
  const legs = [];
  for (const h of hops) {
    if (!h.pool) return null;   // discovered by fallback: no address, no mid
    const sqrt = wordToBig(words(await how.call(h.pool, SEL.v3Slot0))[0]);
    if (sqrt === 0n) return null;
    legs.push({ sqrt, fromIsC0: h.from.toLowerCase() < h.to.toLowerCase() });
  }
  return { legs, hops: hops.length };
}

const TWO192 = 1n << 192n;

/// amount of `wantC0 ? currency0 : currency1` that `amount` of the other side
/// is worth at a sqrt price. One ratio, full precision, no intermediate scale.
function atMid(sqrt, amount, multiply) {
  const p2 = sqrt * sqrt;                       // price(c1 per c0) * 2^192
  if (p2 === 0n) return 0n;
  return multiply ? (amount * p2) / TWO192 : (amount * TWO192) / p2;
}

/// WETH -> NVDAc, or NVDAc -> WETH, at the v3 mid.
/// Walks the route's legs at their mid prices. One hop is the old behaviour;
/// two composes them, which is the whole arithmetic of the two-hop route.
function convertAtV3Mid(mid, amount, wethToQuote) {
  if (!mid || !mid.legs || !mid.legs.length) return 0n;
  const legs = wethToQuote ? mid.legs : mid.legs.slice().reverse();
  let out = amount;
  for (const leg of legs) {
    // The quote per the other side is price(c1/c0) when `from` is currency0,
    // and its reciprocal otherwise. Going the other way inverts it again.
    out = atMid(leg.sqrt, out, leg.fromIsC0 === wethToQuote);
    if (out === 0n) return 0n;
  }
  return out;
}

/// What our own pool would return at its mid: NVDAc in and tokens out on a
/// buy, tokens in and NVDAc out on a sell.
function poolAtMid(sqrt, tokenIsC0, side, amountIn) {
  // tokens per NVDAc is 2^192/P^2 when the token is currency0. Wanting tokens
  // multiplies by it; wanting NVDAc divides.
  return atMid(sqrt, amountIn, (side === "buy") !== tokenIsC0);
}

/// THE WHOLE v3 LEG. Returns what comes out AND the path it came out of, so
/// the transaction is built from the route that was priced.
async function quoteV3(how, wethToQuote, amountIn) {
  // THE QUOTE ASSET IS WETH: THERE IS NOTHING TO SWAP.
  //
  // One wrapped ether is one ether, so the leg is the identity and asking a
  // quoter would be asking about a pool that does not exist. Before this, the
  // route builder found no WETH/WETH pool, fell through to its two-hop branch
  // and priced WETH -> USDC -> WETH - which quotes perfectly well and loses
  // 0.6% to two pool fees on the way to the token the buyer already had.
  //
  // `direct` rather than an empty `hops`: an empty hops list already means
  // "the pool lookup failed, guess a tier", and those two must not be the same
  // thing to anything downstream.
  if (same(how.quote, WETH)) return { out: amountIn, hops: [], direct: true };

  // THE SAME CONTRACT AS BEFORE FOR ITS OTHER CALLERS (the router's sale leg,
  // the pool's ETH route, quoteAssetInEth): a leg nobody answered is said as
  // that, and a leg that only fills in part comes back marked `partial`.
  const sym = how.quoteSym || quoteSym;
  const best = await bestV3Leg(how, wethToQuote, amountIn);
  if (!best || best.unread) {
    throw new Error(`The route between ETH and ${sym} could not be priced just now. Try again in a moment, ` +
      `or trade with ${sym} directly.`);
  }
  if (!(best.out > 0n)) {
    throw new Error(
      `No v3 route between ETH and ${sym} could be priced at this size. ` +
      `Trade with ${sym} directly instead.`
    );
  }
  return best;
}

/// ONE WHOLE UNIT OF A QUOTE ASSET, IN WETH - for the token view's dollar
/// figures (token.js), never for a trade: nothing is sent on this number. Priced
/// by the same v3 legs the ETH route trades through, selling one unit into
/// WETH; WETH itself is one. null when no leg answers, and the view then shows
/// the asset's own units instead of guessing a dollar figure.
async function quoteAssetInEth(quote, decimals) {
  if (same(quote, WETH)) return 10n ** 18n;
  try {
    const r = await quoteV3({ call, quote }, false, 10n ** BigInt(decimals));
    return r && r.out > 0n ? r.out : null;
  } catch { return null; }
}

async function computePoolQuote(where) {
  const w = where || { call, view, quoteDecimals: ctx.quoteDecimals, token: chainCfg.token, quote: ctx.quote };
  if (!w.view || !w.view.poolKey) return { error: "No pool for this launch yet." };
  const key = w.view.poolKey;
  const pool = await poolStateWith(w, key);
  $("poolId").textContent = pool.id;
  if (pool.liquidity === 0n) return { error: "The pool has no liquidity." };

  const side = $("poolSide").value;
  const via = $("poolVia").value;
  const tokenIsC0 = same(key.currency0, w.token);
  const zeroForOne = side === "buy" ? !tokenIsC0 : tokenIsC0;
  // WHAT THE PERSON HANDS OVER AND WHAT THEY GET BACK. Paying in ETH does not
  // change the pool - the token is still priced in NVDAc - it changes which
  // end of the route they stand at.
  const inDec = side === "buy" ? (via === "eth" ? 18 : w.quoteDecimals) : 18;
  const outDec = side === "buy" ? 18 : (via === "eth" ? 18 : w.quoteDecimals);

  const slipText = ($("poolSlippage").value || "").trim();
  const slip = Number(slipText);
  if (!slipText || !isFinite(slip) || slip < 0 || slip > 100) {
    return { error: "Slippage must be a percentage between 0 and 100." };
  }

  const text = ($("poolAmount").value || "").trim();
  if (!text) return { error: "Enter an amount." };
  let amount;
  try { amount = parseUnits(text, inDec); } catch (e) { return { error: e.message }; }
  if (amount === 0n) return { error: "Enter an amount above zero." };

  if (via !== "eth") {
    const q = quotePoolSwap(pool, zeroForOne, amount, key.fee, await poolTax(w, key, side === "buy"));
    if (!q || q.out === 0n) return { error: "Cannot quote a trade this size." };
    // THE CHAIN'S ANSWER WHERE THERE IS ONE, and the closed form behind it.
    // Both are net of this pool's tax: the quoter because the hook runs inside
    // its simulation, the closed form because it takes the legs off itself.
    const asked = await quoteV4(w, key, zeroForOne, amount);
    const fromQuoter = asked !== null && asked > 0n;
    const out = fromQuoter ? asked : q.out;
    return {
      side, via, amount, zeroForOne, inDec, outDec, slip, q, key,
      out, outFromQuoter: fromQuoter, min: withSlippage(out, Math.round(slip * 100)),
      pool, tokenIsC0,
    };
  }

  // TWO LEGS, AND THE BOUND GOES ON THE SECOND ONE'S OUTPUT.
  //
  // The NVDAc in the middle is the ROUTER's for the length of one transaction.
  // Bounding it would be a promise about a balance the person never holds and
  // cannot spend: the leg after it could still deliver anything. So the middle
  // is quoted to build the route and never bounded, and the minimum is applied
  // to the last thing that moves.
  let mid, out, q;
  let hops = null;
  let directLeg = false;
  let fromQuoter = false;
  try {
    if (side === "buy") {
      const leg = await quoteV3(w, true, amount);              // ETH -> the quote asset
      mid = leg.out;
      hops = leg.hops;
      directLeg = !!leg.direct;
      if (mid === 0n) return { error: `Cannot quote the ETH leg into ${quoteSym} at this size.` };
      q = quotePoolSwap(pool, zeroForOne, mid, key.fee, await poolTax(w, key, true));   // the quote asset -> token
      if (!q || q.out === 0n) return { error: "Cannot quote a trade this size." };
      const askedBuy = await quoteV4(w, key, zeroForOne, mid);
      fromQuoter = askedBuy !== null && askedBuy > 0n;
      out = fromQuoter ? askedBuy : q.out;
    } else {
      q = quotePoolSwap(pool, zeroForOne, amount, key.fee, await poolTax(w, key, false)); // token -> the quote asset
      if (!q || q.out === 0n) return { error: "Cannot quote a trade this size." };
      // THE MIDDLE IS WHAT THE NEXT LEG IS QUOTED ON, so it is the one that has
      // to be right. Already net of the hook either way.
      const askedSell = await quoteV4(w, key, zeroForOne, amount);
      fromQuoter = askedSell !== null && askedSell > 0n;
      mid = fromQuoter ? askedSell : q.out;
      const leg = await quoteV3(w, false, mid);                // the quote asset -> ETH
      out = leg.out;
      hops = leg.hops;
      directLeg = !!leg.direct;
      if (out === 0n) return { error: `Cannot quote the ${quoteSym} leg back into ETH at this size.` };
    }
  } catch (e) {
    return { error: e.message || String(e) };
  }
  // THE MID FOR THE ROUTE'S FIRST LEG, for the total-cost line. It is fetched
  // rather than inferred, and a failure here loses that one line instead of
  // the quote - a person can still see what they pay and get.
  // THE ROUTE TRAVELS WITH THE QUOTE. Rediscovering it when the transaction is
  // built would let the path that was PRICED and the path that is SENT differ,
  // which is the same class of mistake as pinning an address and then reading
  // the form again. `hops` is whatever quoteV3 actually chose above.
  const route = hops ? { hops, direct: directLeg } : null;

  let v3Mid = null;
  if (hops) {
    try { v3Mid = await v3MidsFor(w, hops); } catch (e) { v3Mid = null; }
  }

  return withConversion(w, {
    side, via, amount, zeroForOne, inDec, outDec, slip, q, key, mid, out,
    outFromQuoter: fromQuoter,
    min: withSlippage(out, Math.round(slip * 100)),
    pool, v3Mid, tokenIsC0, route,
  });
}

/// COUNTS THE QUOTES ASKED FOR, SO ONLY THE LAST ONE IS ALLOWED TO DRAW.
///
/// They do not come back in order: an abandoned path takes four seconds and an
/// ordinary one takes two hundred milliseconds, so an older answer can land on
/// top of a newer one. What was sent was never affected - poolActionInner
/// quotes again when the button is pressed - but what a person READ when they
/// pressed it was.
let poolQuoteSeq = 0;

/// THE CONVERSION'S ROW AND WARNING (withConversion), on either card.
function convRowsOf(v, sym) {
  if (v && v.convUnchecked) {
    return row("conversion", '<strong class="impact warn">not checked</strong> against the market price (Chainlink)') +
      `<p class="note warn impactWarn warn convUnchecked">${escapeHtml(uncheckedWords(v, sym))}</p>`;
  }
  if (!v || !v.conv) return "";
  const lvl = impactLevel(v.conv.bps);
  const line = conversionWords(v, sym);
  return row("conversion", `<strong class="impact ${lvl}">${impactText(v.conv.bps)}</strong>` +
      " — what the swap " + (v.side === "buy" ? "from ETH" : "into ETH") + " pays below the market price (Chainlink)") +
    (line ? `<p class="note warn impactWarn ${lvl}">${escapeHtml(line)}</p>` : "");
}

/// THE POOL TRADE'S PRICE IMPACT, row and warning, as the curve's are drawn.
function poolImpactRows(v) {
  const imp = poolImpact(v);
  if (!imp || imp.bps === null) return "";
  const line = impactWarning(imp, v.side);
  return row("price impact", `<strong class="impact ${impactLevel(imp.bps)}">${impactText(imp.bps)}</strong>` +
      " — how much worse than the pool's price now, before the pool fee and the tax" +
      (v.via === "eth" ? " (the v4 leg; the ETH conversion is in the total cost)" : "")) +
    (line ? `<p class="note warn impactWarn ${impactLevel(imp.bps)}">${escapeHtml(line)}</p>` : "");
}
/// The launch #poolVia was last given its default for (renderLaunch).
let poolViaFor = "";
/// The launch the curve's "Pay with / Receive" default was last set for.
let curveViaFor = "";

async function renderPoolQuote() {
  const mine = ++poolQuoteSeq;
  const stale = () => mine !== poolQuoteSeq;
  const out = $("poolQuote");
  const act = $("poolAct");
  const invalid = (why) => { out.textContent = why; act.disabled = true; };
  try {
    const v = await computePoolQuote();
    if (stale()) return;                 // a newer quote is already on screen
    const viaNow = $("poolVia").value;
    act.textContent = ($("poolSide").value === "buy" ? "Buy in the pool" : "Sell in the pool") +
      (viaNow === "eth" ? " with ETH" : "");
    if (v.error) return invalid(v.error);

    const { q, inDec, outDec, slip, min, side, via } = v;
    const eth = via === "eth";
    const payUnit = side === "buy" ? (eth ? "ETH" : quoteSym) : "tokens";
    const getUnit = side === "buy" ? "tokens" : (eth ? "ETH" : quoteSym);
    const costBps = totalCostBps(v);
    // THE TAX IS IN NVDAc BOTH WAYS, so there is no per-direction unit for it
    // any more - which is the readable half of charging one side.

    out.innerHTML =
      row("you pay", fmt(v.amount, inDec, 6) + " " + payUnit) +
      (eth
        // THE MIDDLE IS THE ROUTER'S, for the length of one transaction. It is
        // shown because a person should see the route they are taking, and
        // labelled because it is never theirs to hold or to be owed.
        ? row(
            // THE ROUTE, NAMED. A person reading "routed" cannot tell whether
            // their ETH went straight into the asset or through USDC, and the
            // two cost differently. It is also the only place a reader could
            // notice the route changing under them.
            side === "buy" ? `routed: ${routeWords(v.route, quoteSym, true)}`
                           : `routed: ${routeWords(v.route, quoteSym, false)}`,
            // A DIRECT ROUTE HAS NO MIDDLE WORTH SHOWING. One wrapped ether is
            // one ether, so the amount would repeat the line above it and the
            // words "between the two legs" would describe a conversion that
            // does not happen.
            v.route && v.route.direct
              ? "no conversion — one wrapped ether is one ether"
              : fmt(v.mid, ctx.quoteDecimals, 6) + " " + quoteSym + ", held by the router between the two legs"
          )
        : "") +
      // THE TAX AS A RATE, not only as two amounts. It is this launch's, the
      // creator picked it, and nobody can change it - so it belongs on the
      // confirmation screen as a number, next to the fee that is not it.
      row("this launch's tax", (Number(q.taxBps) / 100) + "% of the " + quoteSym + " " +
        (q.taxOnInput ? "you send" : "this leg produces") +
        " — permanent, chosen by the creator") +
      // IN THE v4 LEG'S INPUT, AND SAID IN IT: the quote asset on a buy (ETH
      // arrives there already converted), launch tokens on a sell. It printed a
      // bare number, and "pool fee 3,000" on a sell could be either (N28).
      row("pool fee", fmt(q.lpFee, side === "buy" && eth ? ctx.quoteDecimals : inDec, 6) + " " +
        (side === "buy" ? quoteSym : "tokens") +
        " (" + Number(view.poolKey.fee) / 10000 + "% on the v4 leg, separate from the tax)") +
      // THREE SEPARATE LINES, AND THE LP FEE IS NOT ONE OF THE TAX'S. It is the
      // pool's own, it stays in the locked position, and folding it in would
      // report a cost to us that is not ours.
      // THE RATE IS THIS POOL'S OWN, READ FROM ITS RECORD, NOT WRITTEN HERE.
      // q.platformBps is the share frozen into this launch when it was created
      // (poolTax, taxOfId word [5]); the hook's current share - which its owner
      // can change behind an announced delay - applies only to launches made
      // after a change, so it would be the wrong number for this pool, and the
      // chain can never disagree with the frozen one. "At every tax" still
      // holds: the platform's leg is that share of the base whatever tax a
      // launch chose (round 5, P-Q-N41).
      row("platform fee", fmt(q.platform, ctx.quoteDecimals, 6) + " " + ctx.quoteSym +
        " (" + fmtBps(q.platformBps) + " of the " + ctx.quoteSym + " " +
        (q.taxOnInput ? "you send" : "this leg produces") + ", at every tax)") +
      row(feeName(view), fmt(q.creator, ctx.quoteDecimals, 6) + " " + ctx.quoteSym + " (the rest of this launch's tax)") +
      row("expected out", "<strong>" + fmt(v.out, outDec, 6) + "</strong> " + getUnit) +
      row("minimum out", fmt(min, outDec, 6) + " " + getUnit + " (" + slip + "% slippage)" +
        (eth ? " — on the " + getUnit + " you receive, not on the " + ctx.quoteSym + " in the middle" : "")) +
      slippageWarning(slip, min) +
      poolImpactRows(v) + convRowsOf(v, ctx.quoteSym) +
      // THE ONE NUMBER THAT ANSWERS "what is this costing me". Tax, LP fee and
      // price impact together, and on the ETH route the conversion as well.
      (costBps === null
        ? row("total execution cost", "not shown: a mid price could not be read")
        : row("total execution cost",
            "<strong>" + (costBps / 100).toFixed(2) + "%</strong> against mid" +
            (eth ? " — the conversion and our pool together" : " — tax, pool fee and price impact") +
            ", gas not included")) +
      // WHICH NUMBER THIS IS. The quoter runs the swap and has crossed whatever
      // ticks it crosses; the fallback is arithmetic over the pool's CURRENT
      // price and is exact only while nobody but us has added liquidity - which
      // nothing prevents. Saying so is cheaper than being wrong quietly.
      (v.outFromQuoter
        ? ""
        : note("This figure is modelled on the pool's current price rather than quoted from it: " +
               "the v4 quoter did not answer. It is exact only while this pool holds no liquidity " +
               "but the launch's own locked position.")) +
      (eth && side === "buy" ? row("gas", "paid in ETH on top of the amount above") : "");
    act.disabled = !account || busy;
  } catch (e) {
    // A FAILURE IS AS STALE AS A PRICE. An older quote that could not be
    // priced must not replace a newer one that could.
    if (stale()) return;
    invalid(e.message || String(e));
  }
}

async function renderLock() {
  const box = $("lockFacts");
  // WHOSE LOCK THIS IS, fixed now. It lands late by design, so it must not land
  // on a launch the page has moved on from - A's lock used to fill B's box.
  const forToken = chainCfg.token;
  const forFactory = chainCfg.factory;
  const current = () => same(forToken, chainCfg.token) && same(forFactory, chainCfg.factory);
  try {
    // THE FACTORY'S GRADUATOR, as beginAction uses - not the lens's.
    const grad = oneAddress(await call(forFactory, SEL.graduator), "The factory's graduator()");
    // ASKED, NOT SEARCHED. The Graduator records the lock and the burn now, so
    // the address comes from a getter and everything else comes off the lock
    // itself - tokenId, beneficiary and liquidity are all public on
    // PositionLock, and only its address was ever missing.
    //
    // WHAT THIS REPLACED: a scan of the last few hundred blocks, with a retry
    // that quartered the window when the endpoint refused the range - it
    // answered "limited to a 2,000 range" when that was written and "limited to
    // a 1,000 range" on 23 September 2026, at which point every lock read on
    // this page failed with a 413. A graduation older than the window could not
    // be read at all, and the panel had to say so.
    const lock = wordToAddress(words(await call(grad, SEL.lockOf + pad32(forToken)))[0]);
    if (!current()) return;
    if (/^0x0{40}$/i.test(lock)) {
      box.innerHTML = note(
        "This graduator has no lock recorded for this token. Either it has not graduated, or it " +
        "graduated through a different deployment than the lens on screen names.");
      return;
    }

    const [tokenIdW, liqW, beneficiaryW, heldW, burnedW] = await Promise.all([
      call(lock, SEL.lockTokenId),
      call(lock, SEL.lockedLiquidity),
      call(lock, SEL.lockBeneficiary),
      call(lock, SEL.holdsPosition),
      call(grad, SEL.burnedOf + pad32(forToken)),
    ]);
    if (!current()) return;
    const tokenId = wordToBig(words(tokenIdW)[0]);
    const liquidity = wordToBig(words(liqW)[0]);
    const burned = wordToBig(words(burnedW)[0]);
    const stillHeld = wordToBig(words(heldW)[0]) === 1n;

    box.innerHTML =
      row("LP lock", `<code>${escapeHtml(lock)}</code>`) +
      row("position", "#" + tokenId + (stillHeld ? " \u2014 held by the lock" : " \u2014 NOT held by the lock")) +
      row("liquidity", liquidity.toString()) +
      row("unlocks", "never \u2014 the liquidity is locked forever") +
      row("beneficiary", `<code>${escapeHtml(wordToAddress(words(beneficiaryW)[0]))}</code>`) +
      row("burned",
        "<strong title=\"exact: " + burned.toString() + "\">" + fmt(burned, 18, 0) +
        "</strong> tokens, recorded by the graduator" +
        "<span class=\"exact\">exact, in the smallest unit: <code>" + burned.toString() + "</code></span>");
  } catch (e) {
    if (!current()) return;
    box.innerHTML = note("Could not read the lock: " + escapeHtml(e.message || String(e)));
  }
}

// READ FROM THE LENS THAT IS ON SCREEN NOW.
//
// It used to be read once at load. Change the lens afterwards - to another
// deployment on the same chain, which is exactly what a second stack is - and
// the page went on offering to complete the move through the OLD deployment's
// graduator, for a token registered in the new one. NOTHING DRAWN OR SENT READS
// IT NOW: the launch, the move and the lock use the factory's graduator. It is
// kept, and kept honest, for the state the tests read (refresh(), N07).
let graduatorAddr = null;
let graduatorFromLens = null;
const cacheGraduator = () => graduatorAddr;

/// THE ANSWER IS FILED UNDER WHAT IT WAS ASKED OF: THE LENS AND THE ENDPOINT.
///
/// This used to record `chainCfg.lens` AFTER the await - the form's value at
/// the moment the reply arrived, not the one the question went to. Change the
/// lens to B and back to A while B's reply is in flight and B's Graduator was
/// stored as A's, with the cache key saying A so every later refresh short
/// circuited and kept it. Nothing downstream noticed: the token really is
/// registered in A, so the NotFound check does not fire, and the lock panel
/// then reads its logs from a Graduator that never graduated it.
///
/// THE ENDPOINT IS PART OF THE KEY TOO. A lens address is not unique to a
/// network: point the RPC box at another chain where the same address holds a
/// different deployment - or nothing - and a key of the lens alone says the
/// answer is still good.
///
/// A reply is DISCARDED unless both are still what they were when it was asked.
async function readGraduator() {
  const askedLens = chainCfg.lens;
  const askedRpc = chainCfg.rpc;
  if (!isAddr(askedLens)) { graduatorAddr = null; graduatorFromLens = null; return; }

  const key = askedLens.toLowerCase() + "@" + askedRpc;
  if (graduatorFromLens === key) return;

  const moved = () => !same(askedLens, chainCfg.lens) || askedRpc !== chainCfg.rpc;
  let answer;
  try {
    answer = oneAddress(await displayAt(askedRpc, askedLens, SEL.graduator), "The lens's graduator()");
  } catch (e) {
    // NO ANSWER IS NOT THE LAST LENS'S ANSWER: what was held is dropped, so
    // nothing is kept about a lens that did not reply. A lens with no code here
    // answered "0x", which threw a TypeError about 'slice' (N07).
    if (!moved()) { graduatorAddr = null; graduatorFromLens = null; }
    throw e;
  }
  // The form moved on: this is an answer about something else.
  if (moved()) return;
  graduatorAddr = answer;
  graduatorFromLens = key;
}

const row = (k, v) => `<div class="row"><span>${escapeHtml(k)}</span><span>${v}</span></div>`;
const note = (t) => `<p class="note">${t}</p>`;

/// THE SLIPPAGE BOUND IS THE ONLY THING BETWEEN A TRADE AND A SANDWICH,
/// which AUDIT.txt E-3 measured rather than argued: against a buy that
/// passed no minimum, the attack nets the attacker real money and the
/// victim's fill lands 38.7% worse. The field accepts 100, which sets the
/// minimum to exactly zero and reproduces that victim.
///
/// KEYED ON THE MINIMUM, NOT ON THE FIELD READING 100. Zero is the state
/// that removes the protection, and it is also reachable from below - a
/// small enough amount at a wide enough bound floors to zero as well. The
/// warning is about the condition, not about one way of spelling it.
///
/// IT DOES NOT BLOCK THE TRADE. The bound is the trader's to set and
/// there are reasons to widen it. Saying nothing was the problem.
const slippageWarning = (slip, min) => {
  if (min === 0n) {
    return `<p class="note warn unbounded"><strong>NO FLOOR UNDER THIS TRADE.</strong> The minimum out is zero, so it will be accepted at any price at all - anyone who sees it first can move the price against you and keep the difference. Lower the slippage, or raise the amount, to set a floor.</p>`;
  }
  if (slip >= 10) {
    return note(`A ${slip}% bound is wide: this can fill up to ${slip}% worse than quoted and still go through.`);
  }
  return "";
};

// ---------------------------------------------------------------- actions
/// RUN WHERE IT CAN ACTUALLY REACH THE CASE IT IS FOR.
///
/// It used to sit at the end of refresh(), past the branch that returns when no
/// launch token is in the form - so the CREATE transaction, the one that has no
/// token yet because it is what produces it, could never be recovered. It runs
/// after the render now, from the callers, whether or not a token is selected.
async function refreshAndResume(quiet, silentResume) {
  await refresh(quiet);
  await resumePending({ silent: !!silentResume });
  document.dispatchEvent(new CustomEvent("curb:refreshed"));
}

/// @param opts.resumeSpeaks  true for Refresh and Connect, which are not
///                           actions: the resume after them says what it found.
async function guard(fn, opts) {
  if (busy) return;
  busy = true;
  sticky = null; // a new action; the last one's warning has been read by now
  document.querySelectorAll("button").forEach((b) => (b.disabled = true));
  const writesBefore = msgWrites;
  try {
    await fn();
  } catch (e) {
    // e.html IS THIS PAGE'S OWN MARKUP, built with escapeHtml round every value
    // (a record's line with its Forget button); anything else is text.
    show("err", e && typeof e.html === "string" ? e.html
      : escapeHtml(e.message || String(e)) + (e && e.switchTo ? switchButton(e.switchTo) : ""));
  } finally {
    busy = false;
    document.querySelectorAll("button").forEach((b) => (b.disabled = false));
    // WHAT AN ACTION DID STAYS ON SCREEN - its result, or why it was refused.
    // The resume that follows every action used to write over both: another
    // tab's approval, mined a moment later, replaced "already a transaction for
    // this" with the news that it had succeeded, and a mined create the form
    // could not adopt replaced a trade's own report after every trade (round 5,
    // N02). After an action the resume still settles what the chain has
    // settled, and says nothing; the next load, Refresh or connect says it -
    // and their own resume is quiet too when what they did was refused. Passed
    // down, not held in a global: a second action can start while this resume
    // is still running.
    // REFUSED BY THIS CALL, not merely an error on screen: Refresh writes
    // nothing to the message line, so a refusal an earlier action left there
    // kept Refresh's resume quiet - and the refusal's own advice, "press
    // Refresh" to see the record's line and its Forget button, did nothing.
    const refused = msgWrites !== writesBefore && !$("msg").hidden && $("msg").className === "err";
    // WHAT THE ACTION ITSELF CAME TO, told before its refresh. The refresh lands
    // later, and by then the line can hold the next action's news - a network
    // switch pressed while it ran says "ok" - so the swap card decides whether
    // to clear the amount on this, not on whatever the line says by then.
    const ok = msgWrites !== writesBefore && !$("msg").hidden && $("msg").className === "ok";
    document.dispatchEvent(new CustomEvent("curb:actionDone", { detail: { ok, refused } }));
    const speaks = !!(opts && opts.resumeSpeaks) && !refused;
    await refreshAndResume(true, !speaks);
  }
}

/// Approves only when the allowance is short, and for exactly what is needed
/// plus nothing. An unlimited approval is the convenient thing and the wrong
/// thing to demonstrate. The one exception on this page is the CURB router's
/// allowance for a sale paid in ETH, asked once per token - see
/// ensureRouterAllowance for why that one is acceptable.
/// @param kind  the record kind for the approval - a create passes its own, so
///              the approval is scoped like the create it belongs to.
async function ensureAllowance(pin, token, spender, amount, label, kind) {
  const have = wordToBig(words(await pin.call(token, SEL.allowance + pad32(pin.from) + pad32(spender)))[0]);
  if (have >= amount) return false;
  await send(pin, { to: token, data: SEL.approve + pad32(spender) + amount.toString(16).padStart(64, "0") },
    `approve ${label}`, kind);
  return true;
}

/// ENOUGH OF THE QUOTE ASSET FOR WHAT IS ABOUT TO BE PULLED, BEFORE AN APPROVAL
/// IS PAID FOR.
///
/// The factory (a dev buy) and the curve (a buy) take the quote asset with
/// transferFrom. Nothing checked the balance first, so a creator short of it
/// paid for an approval, then for a launch that failed estimation or reverted,
/// and kept a standing allowance (round 5, S20).
///
/// ON THE WETH PAIR, WHAT IS SHORT IS WRAPPED FROM ETH. The pair is offered as
/// ETH, and a curve there pulls WETH and takes no ETH at all - so a buyer
/// holding only ETH was asked for an approval of a token they did not have.
/// The shortfall is wrapped with WETH9's deposit() as its OWN send: pinned,
/// recorded and waited for like every other, so a reload cannot lose it and a
/// second press cannot pay for it twice. Only the shortfall: WETH already held
/// is used first. Any other asset is refused with the numbers.
async function ensureQuoteHeld(pin, amount, label, kind) {
  const balanceOf = async () => {
    const w = words(await pin.call(pin.quote, SEL.balanceOf + pad32(pin.from)));
    if (!w.length) throw new Error(`The quote asset would not say what this account holds. Nothing was sent.`);
    return wordToBig(w[0]);
  };
  const have = await balanceOf();
  if (have >= amount) return false;
  const short = amount - have;
  const need = `${fmt(amount, pin.quoteDecimals, 6)} ${pin.quoteSym}`;
  const held = `${fmt(have, pin.quoteDecimals, 6)} ${pin.quoteSym}`;
  if (!same(pin.quote, WETH)) {
    throw new Error(`${label} needs ${need}, and this account holds ${held}. Nothing was sent.`);
  }
  const eth = BigInt(await pin.read("eth_getBalance", [pin.from, "latest"]));
  if (eth < short) {
    throw new Error(
      `${label} needs ${need}; this account holds ${held}, and the ${fmt(short, 18, 6)} ETH that would be ` +
      `wrapped to make up the rest is more than its ${fmt(eth, 18, 6)} ETH. Nothing was sent.`);
  }
  await send(pin, { to: WETH, data: SEL.wethDeposit, value: "0x" + short.toString(16) },
    `wrap ${fmt(short, 18, 6)} ETH into WETH for ${label.toLowerCase()}`, kind);
  // CHECKED AGAIN, NOT ASSUMED. A wrap that mined and left the balance short
  // (another transaction spent it meanwhile) would fail the pull after it.
  // The receipt comes from the wallet and this balance from the pinned
  // endpoint, which can be a block behind - so the refusal says what a second
  // press does: it reads the balance afresh and wraps only what is still short.
  const after = await balanceOf();
  if (after < amount) {
    throw new Error(`ETH was wrapped, and this account still holds only ${fmt(after, pin.quoteDecimals, 6)} ` +
      `WETH of the ${need} needed. Nothing more was sent. If the endpoint had not caught up with the wrap yet, ` +
      `pressing again reads the balance afresh and wraps only what is still short.`);
  }
  return true;
}

/// ENOUGH OF ANY TOKEN FOR WHAT IS ABOUT TO BE PULLED, read before an approval
/// for it is paid for - refused with the numbers, never wrapped. ensureQuoteHeld
/// is the quote asset's version, which wraps on the WETH pair; this one covers
/// what that one never reached: a curve sale, and both sides of a pool trade
/// (round 5, N20). A balance that cannot be read refuses too.
/// @param hint  a sentence added to the refusal, or ""
async function ensureHeld(pin, token, amount, decimals, unit, label, hint = "") {
  const w = words(await pin.call(token, SEL.balanceOf + pad32(pin.from)));
  if (!w.length) throw new Error(`${label}: the token would not say what this account holds. Nothing was sent.`);
  const have = wordToBig(w[0]);
  if (have >= amount) return;
  throw new Error(
    `${label} needs ${fmt(amount, decimals, 6)} ${unit}, and this account holds ${fmt(have, decimals, 6)} ${unit}. ` +
    `Nothing was sent.` + (hint ? " " + hint : ""));
}

/// ETHER BACK, NOT WETH, ON THE WETH PAIR (the owner's call, 2026-09-28).
///
/// The curve pays in its quote asset, and on the WETH pair that is WETH: a sale's
/// proceeds, and the part of a buy it could not spend. The pool's ETH route
/// unwraps inside its own transaction; the curve is immutable and has no such
/// step, so the page adds one straight after - WETH9's withdraw() for EXACTLY
/// what the trade paid, as its own send: pinned, recorded and waited for, like
/// the wrap before a buy. WETH the account held before is left alone.
///
/// IT NEVER THROWS. The trade before it has already succeeded, and a refusal
/// here read as a failed trade invites a second one. It returns what was
/// unwrapped and, when nothing was, why - the report says both, and the WETH
/// stays where it is, with #unwrap offering to turn it into ether later.
async function unwrapPaid(pin, amount, what) {
  if (!same(pin.quote, WETH) || amount <= 0n) return { unwrapped: 0n, why: "" };
  let have;
  try {
    have = wordToBig(words(await pin.call(WETH, SEL.balanceOf + pad32(pin.from)))[0]);
  } catch (e) {
    return { unwrapped: 0n, why: "the account's WETH could not be read to check it first" };
  }
  // A BALANCE BELOW WHAT WAS PAID is an endpoint behind the wallet, or the WETH
  // moved on already. withdraw() would revert either way, so it is not asked.
  if (have < amount) {
    return { unwrapped: 0n, why: `the endpoint shows ${fmt(have, 18, 6)} WETH in the account, less than the ` +
      `${fmt(amount, 18, 6)} this trade paid, so nothing was unwrapped` };
  }
  const blocked = await unwrapBlocked(pin, amount);
  if (blocked) return { unwrapped: 0n, why: blocked, blocked: true };
  try {
    const receipt = await send(pin, { to: WETH, data: SEL.wethWithdraw + amount.toString(16).padStart(64, "0") },
      `unwrap the ${fmt(amount, 18, 6)} WETH ${what} into ETH`);
    return { unwrapped: unwrappedFor(receipt, pin.from), why: "" };
  } catch (e) {
    if (e && e.declined) return { unwrapped: 0n, why: "you declined the unwrap in your wallet", declined: true };
    return { unwrapped: 0n, why: e && e.message ? e.message : String(e) };
  }
}

/// WHETHER THIS ACCOUNT CAN TAKE ETHER FROM WETH AT ALL. WETH9 pays with
/// transfer() - 2,300 gas - so an account whose code spends more than that to
/// receive (a smart-contract wallet, or a key delegated to one under EIP-7702)
/// makes withdraw() revert. Simulated first, from this account, so the wallet
/// is never asked to sign a revert. "" when it can; otherwise why not.
async function unwrapBlocked(pin, amount) {
  try {
    await pin.read("eth_call", [{
      from: pin.from, to: WETH, data: SEL.wethWithdraw + amount.toString(16).padStart(64, "0"),
    }, "latest"]);
    return "";
  } catch (e) {
    const m = e && e.message ? e.message : String(e);
    return /revert/i.test(m)
      ? "this account cannot take ether from WETH, which sends it with only 2,300 gas - a wallet that is a " +
        "contract, or a key delegated to one, needs more to receive it. Your wallet app can unwrap it"
      : "the unwrap could not be checked before asking your wallet (" + m + ")";
  }
}

/// THE WETH THIS TRANSACTION UNWRAPPED FOR `who`, from WETH9's own Withdrawal
/// event - the amount the chain says, not the amount that was asked.
const unwrappedFor = (receipt, who) =>
  logsOf(receipt, WETH, TOPIC.wethWithdrawal)
    .filter((l) => l.topics.length > 1 && same(wordToAddress(l.topics[1].slice(2)), who))
    .map((l) => wordToBig(words(l.data)[0]))
    .reduce((a, b) => a + b, 0n);

/// What the report says about unwrapPaid's result.
function unwrapWords(u, amount) {
  if (amount <= 0n) return "";
  if (u.unwrapped > 0n) {
    return ` It was unwrapped straight after: ${amt(u.unwrapped, 18, "ETH")} is in your wallet as ether.`;
  }
  const why = String(u.why || "").trim();
  return ` <strong>It is still WETH in your wallet</strong> - it was not unwrapped: ` +
    `${escapeHtml(/[.!?]$/.test(why) ? why : why + ".")}` +
    // THE BUTTON ONLY WHERE IT CAN HELP: an account that cannot take ether from
    // WETH cannot take it from the button either.
    (u.blocked ? "" : ` The "Unwrap to ETH" button turns it into ether when you like.`);
}

/// EVERY WETH THE ACCOUNT HOLDS, TURNED INTO ETHER, on a WETH pair's page: what a
/// sale left when its unwrap was declined, or anything held from before. The
/// whole balance, read through the pinned endpoint the moment it is sent.
async function unwrapWeth() {
  const pin = await beginAction("trade");
  return withSendLock(pin, async () => {
    if (!same(pin.quote, WETH)) throw new Error("This launch is not paired with WETH, so there is nothing to unwrap here.");
    const w = words(await pin.call(WETH, SEL.balanceOf + pad32(pin.from)));
    if (!w.length) throw new Error("WETH would not say what this account holds. Nothing was sent.");
    const have = wordToBig(w[0]);
    if (have === 0n) throw new Error("This account holds no WETH. Nothing was sent.");
    const blocked = await unwrapBlocked(pin, have);
    if (blocked) throw new Error(blocked.charAt(0).toUpperCase() + blocked.slice(1) + ". Nothing was sent.");
    const receipt = await send(pin, { to: WETH, data: SEL.wethWithdraw + have.toString(16).padStart(64, "0") },
      `unwrap ${fmt(have, 18, 6)} WETH into ETH`);
    const got = unwrappedFor(receipt, pin.from);
    showDone(doneHead("Unwrapped", `${brief(got, 18)} WETH <span class="toastArrow">→</span> <strong>ETH</strong>`), receipt, `Unwrapped ${amt(got, 18, "WETH")} into ether in <code>${escapeHtml(receipt.transactionHash)}</code>.` +
      exactly([["unwrapped", got]]));
  });
}

/// WHAT THE FORM SAYS THE LIMITS ARE. The token contract has none: these are
/// this page's rules, and they exist because a name that does not fit anywhere
/// it is displayed is a name the creator cannot change afterwards.
const NAME_MAX = 32;
/// The description's limit. It is this page's, not the token's - the token
/// stores whatever it is given - and it exists because the metadata is
/// permanent and calldata is paid for.
const DESC_MAX = 300;
const SYMBOL_MAX = 10;

async function createLaunch() {
  const name = $("nName").value.trim();
  const symbol = $("nSymbol").value.trim();
  if (!name || !symbol) throw new Error("A name and a symbol are needed.");
  // CHECKED HERE AS WELL AS ON THE INPUT. maxlength stops typing and pasting;
  // it does not stop a value set any other way, and the hint under the field
  // promised a limit that nothing was actually enforcing.
  if (name.length > NAME_MAX) {
    throw new Error(`The name is ${name.length} characters. The maximum is ${NAME_MAX}.`);
  }
  if (symbol.length > SYMBOL_MAX) {
    throw new Error(`The symbol is ${symbol.length} characters. The maximum is ${SYMBOL_MAX}.`);
  }
  const tax = parseTax($("nTax").value);
  const pin = await beginAction("create");
  const creatorWallet = readCreatorWallet();
  // THE QUOTE REFUND GOES TO THE SENDER (createLaunchInner), held to the same rule.
  const refundWhy = unpayable(pin.from);
  if (refundWhy) throw new Error("The quote refund address - this account - is " + refundWhy + ". Nothing was sent.");

  // THE DEV BUY IS SCALED BY WHAT WAS PINNED, AND ONLY BY THAT.
  //
  // It used to read the display context - `ctx ? ctx.quoteDecimals : 8` - so a
  // page whose factory read had not finished scaled the amount by a guess and
  // skipped both limits. pin holds the decimals this very transaction will use,
  // and the threshold and the share are read from the SAME factory here rather
  // than from whatever the screen last showed. AUDIT A-1.
  const [thrWord, shareWord] = await Promise.all([
    pin.call(pin.factory, SEL.graduationThreshold),
    // A REVERT THAT CARRIES NOTHING IS "NO CEILING OF ITS OWN" (an older
    // factory); anything else is a read that failed, and the send stops rather
    // than treat it as 100%. NOT ANY ANSWER FROM THE NODE: a rate limit arrives
    // in the same shape and used to lift the ceiling to the whole threshold
    // (round 5, N17). NOR A REVERT WITH A REASON, which the card refuses to
    // read as "absent" too (lacksFunction, N06) - the send read it as 100%.
    pin.call(pin.factory, SEL.maxDevBuyBps).catch((e) => {
      if (lacksFunction(e)) return "0x";
      throw new Error("This factory's dev buy ceiling could not be read just now. Nothing was sent - try again.");
    }),
  ]);
  const pinnedThreshold = words(thrWord).length ? wordToBig(words(thrWord)[0]) : 0n;
  const pinnedShareRaw = words(shareWord).length ? wordToBig(words(shareWord)[0]) : 0n;
  const pinnedShare = pinnedShareRaw === 0n ? DEFAULT_MAX_DEV_BUY_BPS : pinnedShareRaw;
  const devBuy = readDevBuy(pin.quoteDecimals, pinnedThreshold, pinnedShare, pin.factory);

  // THE SPLIT THE CREATOR READ, TAKEN BEFORE ANYTHING ELSE IS ASKED. It is the
  // one number on this form the chain can change behind their back - an
  // announced policy change ripens on a timestamp - so what goes into the
  // transaction is what was on screen, and the factory refuses it if the chain
  // no longer agrees. Only from a context read off THIS factory: the screen
  // may be showing another one's.
  const shown = ctx;
  if (!shown || !same(shown.factory, pin.factory) || !shown.platformKnown) {
    throw new Error(
      "This page has not read the platform's terms from this factory, so the split on screen is not " +
      "a number it can stand behind. Press Refresh, check the split, and send again."
    );
  }
  // HOLDER SHARING, AS IT WAS SHOWN: the version the toggle named, or none. The
  // switch is for good, so a version the creator did not see is never sent -
  // createLaunchInner reads the catalog again and refuses one that moved.
  let share = ZERO_ADDRESS;
  if (shareWanted()) {
    const offer = shown.sharing;
    if (!offer || !offer.known) {
      throw new Error("Whether holder sharing is available could not be read from this deployment just now. " +
        "Nothing was sent - press Refresh, or choose You under Who earns your tax.");
    }
    if (!offer.approved || same(offer.factory, ZERO_ADDRESS)) {
      throw new Error("Holder sharing is not available on this deployment: its catalog approves no distributor " +
        "version. Nothing was sent - choose You under Who earns your tax to launch without it.");
    }
    share = offer.factory;
  }
  const expected = { bps: shown.platformBps, to: shown.platformTo, share };
  return withSendLock(pin, () => createLaunchInner(pin, name, symbol, tax, creatorWallet, devBuy, expected));
}

/// Whether the form's "Who earns your tax" says Holders.
const shareWanted = () => !!($("nShare") && $("nShare").checked);

/// THE ONE NUMBER A CREATOR CHOOSES. Read as a percentage, sent as basis
/// points, and refused here rather than on chain when it is outside the band -
/// the contract refuses it too, and that is the check that counts, but a form
/// that lets you spend gas to be told no is a worse form.
function parseTax(raw) {
  const text = (raw || "").trim();
  if (text.includes(",")) throw new Error(COMMA_REFUSED);
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error("The tax must be a number, in percent.");
  // AS A DECIMAL STRING, NEVER THROUGH A FLOAT. Number("2.3") * 100 is
  // 229.99999999999997, and the float check this used refused 59 of the 401
  // legal settings - 1.1%, 2.3%, 4.1% among them - with a message that was
  // false (round 4, S01). The whole and the fractional digits are read as
  // integers here, by hand, so nothing is ever rounded.
  const [whole, frac = ""] = text.split(".");
  if (frac.length > 2) {
    throw new Error("The tax is in basis points on chain, so it cannot be finer than 0.01%.");
  }
  const bps = BigInt(whole) * 100n + BigInt((frac + "00").slice(0, 2));
  if (bps < TAX_MIN_BPS || bps > TAX_MAX_BPS) {
    // THE PLATFORM'S SHARE ONLY AS READ. The 0.5% fallback was stated here as
    // "the platform's, at every setting" before any factory had been read
    // (round 5, S23).
    const platform = platformShareBps();
    throw new Error(
      "The tax must be between " + fmtBps(TAX_MIN_BPS) + " and " + fmtBps(TAX_MAX_BPS) + ". " +
      (platform === null
        ? "Part of it is the platform's, at every setting - how much is read from the factory - and the rest is yours."
        : fmtBps(platform) + " of it is the platform's, at every setting; the rest is yours.")
    );
  }
  return bps;
}

/// Basis points as a percentage, with no trailing zeros AFTER THE POINT.
/// The pattern used to run on the bare number, so 0 bps - a platform share the
/// hook allows - printed "%", and 1000 bps printed "1%" (round 5, S27). Fixed
/// at two places first, so the zeros stripped are only ever decimals.
const fmtBps = (bps) => (Number(bps) / 100).toFixed(2).replace(/\.?0+$/, "") + "%";

/// HOLDS A NUMBER FIELD AT ITS MAXIMUM AS IT IS TYPED, and says so.
///
/// @param el     the input
/// @param max    the largest value allowed, as a Number
/// @param note   where to say it was held; may be missing
/// @param label  how to name the maximum in that message
///
/// TRAILING DOTS AND EMPTY STRINGS ARE LEFT ALONE. "4." is halfway through
/// typing "4.5" and rewriting it mid-keystroke would fight the person.
function capField(el, max, note, label) {
  if (!el) return;
  const text = (el.value || "").trim();
  if (text === "" || text.endsWith(".")) return;
  if (!/^\d+(\.\d+)?$/.test(text)) return;   // parseTax/readDevBuy report this
  if (Number(text) <= max) return;
  el.value = String(max);
  if (note) note.textContent = "Held at " + label + ", the most this launch allows.";
  return true;
}

/// DIGITS AND ONE DECIMAL POINT, NOTHING ELSE - AND A COMMA IS SHOWN, NOT GUESSED.
///
/// The creator tax and the dev buy are numbers and only numbers. A letter in
/// either used to sit in the field until the button was pressed and parseTax
/// or readDevBuy refused it; now it never arrives. Digits past `decimals`
/// places are dropped as they are typed - the chain could not hold them anyway.
///
/// A COMMA STAYS IN THE FIELD AND MAKES IT INVALID. This first read a comma as
/// a decimal point, so "6,300" - the page's own cbXRP ceiling, printed with a
/// thousands separator - became 6.3, a dev buy a thousand times smaller than
/// meant (round 4, S02). Dropping the comma instead turns a "1,5" typed key by
/// key into 15. Either guess can be wrong by orders of magnitude, so neither is
/// made: the comma stays where the person can see it, the field is marked, and
/// the line under it says to use a point. Nothing is sent while it is there.
///
/// The caret stays where it was relative to what was kept, so correcting a
/// digit in the middle does not throw the cursor to the end of the field.
function numericOnly(el, decimals) {
  if (!el) return false;
  const clean = (text) => {
    let v = String(text).replace(/[^\d.,]/g, "");
    if (v.includes(",")) return v;              // refused where it is read, not rewritten here
    const dot = v.indexOf(".");
    if (dot !== -1) {
      v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, "");
      if (Number.isInteger(decimals)) v = decimals === 0 ? v.slice(0, dot) : v.slice(0, dot + 1 + decimals);
    }
    return v;
  };
  const before = el.value;
  const after = clean(before);
  el.classList.toggle("numBad", after.includes(","));
  if (after === before) return false;
  const caret = el.selectionStart;
  el.value = after;
  if (caret !== null && document.activeElement === el) {
    const at = Math.min(clean(before.slice(0, caret)).length, after.length);
    try { el.setSelectionRange(at, at); } catch { /* not every input has a caret */ }
  }
  return true;
}

/// The one sentence every refusal of a comma uses.
const COMMA_REFUSED = "Use a point for decimals (1.5) and no thousands separators - a comma could mean " +
  "either, so it is not taken.";

/// WHERE THE SLIDER'S STOP PUTS THE AMOUNT. Its last stop is the ceiling to
/// the last unit; every other stop is rounded down at six places so the field
/// it writes stays readable. Pure, so a test can hold it to a ceiling with
/// digits below six places - which no asset in the fixture has (round 4, S35).
function sliderAmount(stop, cap, decimals) {
  const s = BigInt(stop);
  return s >= 1000n ? cap : roundUnits((cap * s) / 1000n, decimals, 6, true);
}

/// An amount rounded at `places` decimals - DOWN, or UP so a buy reaches what
/// was asked for rather than falling a unit short.
function roundUnits(v, decimals, places, down) {
  const unit = 10n ** BigInt(Math.max(decimals - places, 0));
  let r = (v / unit) * unit;
  if (!down && r < v) r += unit;
  return r;
}

/// An amount as a field holds it: every digit, no thousands separators.
const plainUnits = (v, decimals) => fmt(v, decimals, decimals).replace(/,/g, "");

/// A share of the supply, from basis points. "under 0.01%" rather than a
/// zero that reads as nothing bought.
const fmtShare = (bps) => (BigInt(bps) === 0n ? "under 0.01%" : (Number(bps) / 100).toFixed(2) + "%");
const sharePlain = (bps) => (Number(bps) / 100).toFixed(2).replace(/\.?0+$/, "");

/// WHAT A FIRST BUY OF `amount` RECEIVES, priced the way the curve will.
///
/// A new curve's reserves are phantomQuote against the whole supply -
/// getReserves is phantomQuote plus what it has taken in, less the fee
/// buckets, all zero before the first trade - and a buy takes the platform's
/// share (feeBps) and the creator's (creatorTaxBps) off the INPUT before a
/// constant-product swap. That is quoteBuy exactly, with the reserves a curve
/// starts from; launch() sets feeBps to the platform share and creatorTaxBps
/// to the rest of the tax. Null until the factory's terms and a valid tax are
/// known.
function devBuyQuote(amount) {
  // Not priced on a share this page could not read (round 4, S23).
  if (!ctx || !ctx.supply || !ctx.phantomQuote || !ctx.threshold || !ctx.platformKnown) return null;
  let bps;
  try { bps = parseTax($("nTax").value); } catch { return null; }
  const platform = platformShareBps();
  const fees = { fee: platform, tax: bps - platform };
  const r = { quote: ctx.phantomQuote, token: ctx.supply };
  // What the curve keeps back for the pool; a first buy is capped far below
  // it, so the clamp in quoteBuy never engages here - but it is the curve's
  // own number, not an assumption that it will not.
  const reserved = (ctx.supply * ctx.phantomQuote) / (ctx.phantomQuote + ctx.threshold);
  const q = quoteBuy(BigInt(amount), r, fees, ctx.supply - reserved);
  return { ...q, shareBps: (q.out * 10000n) / ctx.supply, fees };
}

/// THE AMOUNT THAT BUYS `shareBps` OF THE SUPPLY - the inverse of the above.
/// Grossed up so the fee legs still come out of the input, rounding UP, and
/// never past the ceiling.
function devBuyForShare(shareBps) {
  const base = devBuyQuote(0n);
  if (!base) return null;
  const out = (ctx.supply * BigInt(shareBps)) / 10000n;
  if (out === 0n) return 0n;
  const net = amountIn(out, ctx.phantomQuote, ctx.supply);
  if (net === null) return null;
  const denom = BPS - base.fees.fee - base.fees.tax;
  let gross = (net * BPS + denom - 1n) / denom;
  const cap = devBuyCeiling(ctx.threshold, ctx.maxDevBuyBps);
  if (cap !== null && gross > cap) gross = cap;
  return gross;
}

/// Which unit the dev buy is typed in. The AMOUNT field is the one
/// createLaunch reads in both; the share field writes into it.
let devMode = "amount";
/// WHY THE SHARE FIELD HOLDS SOMETHING THE AMOUNT FIELD DOES NOT SAY - the
/// sentence the card and the refusal both use - or null when the two agree.
///
/// Every keystroke in the share field clears the amount first; only a share
/// turned into an amount leaves this null. A comma used to stop the handler
/// before it wrote anything, so "1" then ",5" left the 1% amount in the hidden
/// field, the refusal line was redrawn away by the next keystroke anywhere, and
/// Create sent the 1% buy (round 5, S02). In "% of supply" mode readDevBuy
/// refuses while this is set; typing an amount or moving the slider makes the
/// amount the source again and clears it.
let devPctPending = null;

function setDevMode(mode) {
  devMode = mode === "pct" ? "pct" : "amount";
  for (const b of document.querySelectorAll("#devMode [data-mode]")) {
    b.setAttribute("aria-pressed", String(b.dataset.mode === devMode));
  }
  if ($("devAmountField")) $("devAmountField").hidden = devMode !== "amount";
  if ($("devPctField")) $("devPctField").hidden = devMode !== "pct";
  renderLaunchSummary();
}

/// THE DEV BUY CARD: the slider, the other unit, and what the buy receives.
/// Drawn from the AMOUNT field - the share field and the slider are two ways
/// of writing that one number, never a second source of it. A share that has
/// not become an amount (devPctPending) is said as such and priced as nothing.
function renderDevBuy() {
  const out = $("devBuyOut");
  if (!out) return;
  const slider = $("nDevSlider");
  const sum = $("sumDevBuy");
  const pctEl = $("nDevPct");
  const cap = ctx && ctx.threshold ? devBuyCeiling(ctx.threshold, ctx.maxDevBuyBps) : null;
  if (slider) slider.disabled = cap === null;
  if (cap === null) {
    // THE CEILING NEEDS THE PLATFORM'S SHARE now (it prices the tokens a buy
    // receives), so an unread share stops here - and is named, not blamed on
    // the tax (round 5, S23).
    out.textContent = ctx && ctx.threshold && !ctx.platformKnown
      ? "The platform's share could not be read from this factory just now, so the buy is not priced. " +
        "Refresh to try again."
      : "What a first buy can be appears once this factory's terms are read and the creator tax is valid.";
    if (sum) sum.textContent = "—";
    return;
  }
  const sym = ctx.quoteSym;
  const dec = ctx.quoteDecimals;
  const capQ = devBuyQuote(cap);
  if ($("devSliderMax")) {
    $("devSliderMax").textContent = "Max " + fmt(cap, dec, 4) + " " + sym +
      (ctx.maxDevBuyBps < 10000n ? " · " + sharePlain(ctx.maxDevBuyBps) + "% of supply"
        : capQ ? " · " + fmtShare(capQ.shareBps) : "");
  }

  let amount;
  const text = ($("nDevBuy").value || "").trim();
  let tooFine = false;
  try { amount = text ? parseUnits(text, dec) : 0n; }
  catch { amount = null; tooFine = /^\d*\.\d+$/.test(text); }
  if (slider && document.activeElement !== slider) {
    const a = amount === null ? 0n : amount > cap ? cap : amount;
    slider.value = String(Number((a * 1000n) / cap));
  }
  // IN "% OF SUPPLY" MODE THE AMOUNT FIELD IS NOT ON SCREEN, so nothing below
  // may talk about it there: a line that would name the amount names the share
  // field instead, the one the person can see and change (round 5, S24).
  const inPct = devMode === "pct";
  // THE SHARE FIELD REDRAWN FROM THE AMOUNT says what the amount says, so a
  // refusal about what it held before no longer stands. "1,5" typed, then
  // "Amount" and back, cleared the share field here and left its comma
  // refusal on the card and on Create, about a field that was now empty.
  const showShare = (v) => {
    if (!pctEl || document.activeElement === pctEl) return;
    pctEl.value = v;
    devPctPending = null;
  };
  // A SHARE NOT TURNED INTO AN AMOUNT says why, and prices nothing: the amount
  // field is empty, and "No dev buy" beside "1,5" would be a second wrong story.
  if (inPct && devPctPending) {
    out.textContent = devPctPending;
    if (sum) sum.textContent = "—";
    return;
  }
  if (amount === null) {
    // After the asset changes, a figure typed for an 18-decimal asset can have
    // more places than the new one holds (round 4, S24).
    out.textContent = text.includes(",")
      ? COMMA_REFUSED
      : tooFine
        ? (inPct
          ? "The share in the share field was worked out for another asset: the amount it came to has more " +
            "decimal places than " + sym + " has (" + dec + "). Type the share again."
          : "The amount has more decimal places than " + sym + " has (" + dec + "). Shorten it.")
        : inPct ? "Type a share of the supply in the share field." : "Enter an amount in " + sym + ".";
    if (sum) sum.textContent = "—";
    return;
  }
  // ABOVE THE CEILING IS NOT A BUY THIS LAUNCH CAN MAKE, so it is not priced
  // as one. It gets here when the asset changes under a typed figure: the field
  // is held at the ceiling only on its own input event (round 4, S24).
  if (amount > cap) {
    out.textContent = inPct
      ? "The share in the share field was worked out for another asset, and here it comes to more than the most " +
        "this launch allows (" + fmt(cap, dec, 4) + " " + sym + (capQ ? ", " + fmtShare(capQ.shareBps) +
        " of the supply" : "") + "). Type the share again, or the launch will be refused before anything is sent."
      : "Above the most this launch allows (" + fmt(cap, dec, 4) + " " + sym + "). " +
        "Lower it, or the launch will be refused before anything is sent.";
    if (sum) sum.textContent = "above the ceiling";
    return;
  }
  if (amount === 0n) {
    out.textContent = "No dev buy. The first trade is left to the market.";
    if (sum) sum.textContent = "None";
    showShare("");
    return;
  }
  const q = devBuyQuote(amount);
  if (!q) {
    // THE CAUSE devBuyQuote STOPPED ON, named. It said "the creator tax has to
    // be valid" whatever the cause, so an unread platform share - with a
    // perfectly valid tax in the field - was blamed on the tax (round 5, S23).
    let taxOk = true;
    try { parseTax($("nTax").value); } catch { taxOk = false; }
    out.textContent = !ctx.platformKnown
      ? "The platform's share could not be read from this factory just now, so the buy is not priced. " +
        "Refresh to try again."
      : !ctx.supply || !ctx.phantomQuote
        ? "This factory does not report the starting reserves a first buy is priced from, so it is not priced."
        : !taxOk
          ? "The creator tax has to be valid before the buy can be priced."
          : "The buy could not be priced.";
    if (sum) sum.textContent = fmt(amount, dec, 4) + " " + sym;
    return;
  }
  const tick = ($("nSymbol").value || "").trim();
  out.textContent =
    "You pay " + fmt(amount, dec, 6) + " " + sym + " and receive about " + fmt(q.out, 18, 0) + " " +
    (tick ? "$" + tick : "tokens") + " — " + fmtShare(q.shareBps) + " of the supply. " +
    fmt(q.fee + q.tax, dec, 6) + " " + sym + " of the payment is the trade tax, taken first as on any buy.";
  if (sum) sum.textContent = fmtShare(q.shareBps) + " for " + fmt(amount, dec, 4) + " " + sym;
  showShare(sharePlain(q.shareBps));
}

/// WHAT A LINK IS ALLOWED TO BE.
///
/// AUDIT A-1 was an XSS that arrived through a token symbol, so a field whose
/// whole purpose is to be rendered as a link gets checked before it is stored
/// rather than only before it is shown. `javascript:` and `data:` are the two
/// that turn a link into code; everything is rejected except the three schemes
/// that cannot.
///
/// CHECKED ON THE WAY IN AS WELL AS ON THE WAY OUT, deliberately. The display
/// side escapes too, but this string is about to be written into a token
/// FOREVER - a bad one cannot be cleaned up later, only refused now.
const LINK_OK = /^(https:\/\/|http:\/\/|ipfs:\/\/)[^\s"'<>]{1,180}$/i;

/// WHAT A PERSON TYPES FOR A LINK, made into the link it means - BEFORE the
/// check above, never instead of it. A bare "curb.fun" was refused with a
/// sentence about schemes, which is how the first real-wallet run met this
/// form. So a domain typed without its scheme is taken as https://, and an X
/// or Telegram handle ("@name") as its profile link. Anything that already
/// names a scheme ("javascript:...", "localhost:8080") is returned exactly as
/// typed and judged by LINK_OK as it stands, so nothing that check refuses can
/// be let in by this; "//host" is left alone and refused the same way.
function normalizeLink(kind, raw) {
  const v = String(raw || "").trim();
  if (!v) return "";
  const handle = /^@([A-Za-z0-9_]{1,64})$/.exec(v);
  if (handle && kind === "x") return "https://x.com/" + handle[1];
  if (handle && kind === "telegram") return "https://t.me/" + handle[1];
  if (/^[a-z][a-z0-9+.-]*:/i.test(v) || v.startsWith("//")) return v;
  // A HOST WITH A DOT IN IT, then a path if any: a domain without its scheme.
  if (/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+([/?#][^\s"'<>]*)?$/.test(v)) return "https://" + v;
  return v;
}

function cleanLink(id, what, kind) {
  const typed = ($(id).value || "").trim();
  const v = normalizeLink(kind, typed);
  if (!v) return "";
  if (!LINK_OK.test(v)) {
    throw new Error(`The ${what} "${typed.slice(0, 60)}" is not a link this page will store: write it as a web ` +
      `address (https://…, http://… or ipfs://…) with no spaces or quotes${kind === "website" ? "" : ", or as @name"}. ` +
      `Nothing was sent.`);
  }
  // WHAT GOES INTO THE TOKEN FOR GOOD, shown in the field before it is sent.
  $(id).value = v;
  return v;
}

/// The token's metadata, as a data: URI.
///
/// NOT AN IPFS HASH. There is no backend here and a pinning service would be
/// the first thing able to go down and take every token's identity with it.
/// This is stored on chain with the token and needs nobody's server.
///
/// The shape is the flat one memecoin indexers already read - name, symbol,
/// description, image, website, twitter, telegram - rather than a nested one
/// that would be ours alone.
/// THE PICTURE, SHRUNK IN THE BROWSER AND CARRIED AS BYTES.
///
/// 128x128 WebP turns anything a phone camera produces into a few kilobytes,
/// which is what makes storing it in calldata affordable. The ceiling refuses
/// the rest rather than letting somebody find out what it costs from a failed
/// transaction.
const IMAGE_PX = 128;
const IMAGE_MAX_BYTES = 24 * 1024;
let tokenImage = "";          // a data: URI, or "" for none

async function shrinkToDataUri(file) {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = IMAGE_PX;
  canvas.height = IMAGE_PX;
  const ctx = canvas.getContext("2d");
  // COVER, NOT STRETCH. A non-square picture is cropped to its middle rather
  // than squashed, because a squashed logo looks like a mistake by us.
  const side = Math.min(bitmap.width, bitmap.height);
  ctx.drawImage(
    bitmap,
    (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side,
    0, 0, IMAGE_PX, IMAGE_PX
  );
  for (const q of [0.82, 0.7, 0.55, 0.4]) {
    const uri = canvas.toDataURL("image/webp", q);
    if (uri.length <= IMAGE_MAX_BYTES) return uri;
  }
  throw new Error(
    "That image will not fit on chain even after shrinking. Try a simpler one - " +
    "flat colours and few details compress far better than a photograph."
  );
}

function buildTokenUri(name, symbol) {
  // REFUSED, NOT CUT. This used to slice to 300 while the field advertised
  // nothing and the summary card showed the whole string, so a creator read
  // back more than was stored - permanently, since the token has no setter.
  // The field carries maxlength now; this is the half that a paste or a
  // scripted value cannot get round.
  const desc = ($("nDesc").value || "").trim();
  if (desc.length > DESC_MAX) {
    throw new Error(
      `The description is ${desc.length} characters. The maximum is ${DESC_MAX}, and it is permanent.`
    );
  }
  const meta = {
    name,
    symbol,
    description: desc,
    image: tokenImage,
    website: cleanLink("nSite", "website", "website"),
    twitter: cleanLink("nX", "X link", "x"),
    telegram: cleanLink("nTg", "Telegram link", "telegram"),
  };
  // Empty fields are dropped rather than stored as "": a reader can then tell
  // "not given" from "given as blank", and it is calldata we do not pay for.
  for (const k of Object.keys(meta)) if (!meta[k]) delete meta[k];
  const json = JSON.stringify(meta);
  // btoa is byte-oriented; this is the standard dance for UTF-8 so a Turkish
  // or emoji description does not throw.
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(json)));
  return "data:application/json;base64," + b64;
}

/// WHERE THIS LAUNCH'S INCOME AND ITS LOCKED POSITION GO.
///
/// Blank means the connected account, which is what every launch did before
/// the field existed. A typed address takes the creator fees, the pool's
/// creator share AND the locked LP position - PositionLock answers only to it
/// - and none of the three can be moved afterwards.
function readCreatorWallet() {
  const v = ($("nCreator").value || "").trim();
  if (!v) return "0x0000000000000000000000000000000000000000";
  if (!isAddr(v)) throw new Error("The creator wallet must be an address, or blank to use this account.");
  const why = unpayable(v);
  if (why) throw new Error("The creator wallet is " + why + ". Nothing was sent.");
  return v;
}

/// ADDRESSES THAT WOULD KEEP A LAUNCH'S PAYMENTS FOR GOOD, or leave them for
/// anybody - refused as its creator wallet and as its quote refund address. The
/// factory refuses its own contracts (CreatorIsInfrastructure); these are not
/// its to know. The CURB router passes on nothing it was not handed inside a
/// trade, so fees or a refund paid to it stay there; WETH keeps ether sent to
/// it as WETH for the sender; and SwapRouter02 holds whatever reaches it for
/// the next caller to sweep.
/// @return "" when the address can be paid, otherwise what it is
function unpayable(a) {
  if (same(a, CURB_ROUTER.address)) {
    return "the CURB router's address, which passes on nothing it is sent outside a trade, so whatever this launch " +
      "paid it would be lost";
  }
  if (same(a, WETH)) return "WETH's address, which would keep whatever this launch paid it";
  if (same(a, SWAP_ROUTER02)) {
    return "Uniswap's SwapRouter02, which leaves whatever reaches it for anybody to take";
  }
  if (same(a, AERODROME.router.address)) {
    return "Aerodrome's swap router, which leaves whatever reaches it for anybody to take (refundETH, sweepToken, " +
      "unwrapWETH9)";
  }
  return "";
}

/// HOW MUCH OF THEIR OWN LAUNCH THE CREATOR BUYS, in the launch itself.
///
/// Blank or zero means none. The factory refuses anything at or above the
/// graduation threshold, because a buy that could graduate the launch would
/// build the pool inside launch() - so the page refuses it first, with a
/// sentence instead of a revert.
/// WHAT A CREATOR MAY TAKE BEFORE ANYBODY ELSE, as a share of the SUPPLY: the
/// factory refuses a first buy that would receive more than MAX_DEV_BUY_BPS of
/// it (2000, a fifth). It was a share of the graduation threshold, a quote
/// ceiling, until three quarters of the threshold turned out to buy 66% of the
/// supply on the shipped curves.
///
/// READ FROM THE FACTORY, NOT REPEATED HERE. The contract's MAX_DEV_BUY_BPS is
/// public, so it costs one call - the same call this page already makes for the
/// supply and the threshold. A copy would let the
/// form refuse a buy the factory allows, or promise one it refuses after the
/// gas, and it would print the wrong figure while doing it.
///
/// The fallback is only for a factory built before the cap existed, where
/// zero means "no cap of its own" and the below-threshold rule is the only one.
const DEFAULT_MAX_DEV_BUY_BPS = 10000n;

/// THE LARGEST FIRST BUY THE FACTORY TAKES, in the quote asset's own units, or
/// null when it cannot be worked out yet.
///
/// The factory counts the cap in TOKENS - what the curve's buy returns - and
/// separately refuses anything at or above the graduation threshold. In the
/// quote asset that is the largest amount devBuyQuote prices at or under
/// shareBps of the supply, so it moves with the creator tax (the tax comes off
/// the input first) and needs the starting reserves and the platform share:
/// found by bisection over that same arithmetic, and never past threshold - 1.
/// `factory`, when given, is the factory the figure must be for; a context read
/// off another one gives null rather than its own cap.
function devBuyCeiling(threshold, shareBps, factory) {
  const share = shareBps === undefined || shareBps === null ? null : BigInt(shareBps);
  if (!threshold || share === null || share === 0n) return null;
  const top = BigInt(threshold) - 1n;
  if (top <= 0n) return null;
  if (share >= 10000n) return top;
  if (!ctx || (factory && !same(ctx.factory, factory))) return null;
  const maxTokens = (ctx.supply * share) / 10000n;
  const out = (amount) => { const q = devBuyQuote(amount); return q ? q.out : null; };
  const atTop = out(top);
  if (atTop === null) return null;
  if (atTop <= maxTokens) return top;
  let lo = 0n;
  let hi = top;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (out(mid) <= maxTokens) lo = mid; else hi = mid;
  }
  return lo;
}

function readDevBuy(decimals, threshold, shareBps, factory) {
  // IN "% OF SUPPLY" MODE THE SHARE FIELD IS WHAT THE PERSON SEES, and a share
  // that did not become an amount is refused in the words the card uses - never
  // read as the empty amount field ("no dev buy") or as an amount an earlier
  // keystroke left there (round 5, S02). Asked BEFORE the empty check: a share
  // being typed leaves the amount field empty on purpose.
  const inPct = devMode === "pct";
  if (inPct && devPctPending) throw new Error(devPctPending + " Nothing was sent.");
  const text = ($("nDevBuy").value || "").trim();
  if (!text) return 0n;

  // NOTHING IS PARSED FROM A GUESS.
  //
  // This used to be called with `ctx ? ctx.quoteDecimals : 8` and
  // `ctx ? ctx.threshold : 0n`, so a page whose factory read had not finished
  // parsed the amount at eight decimals and skipped both limits. On WETH that
  // sent a ten-billionth of what was typed; on cbXRP, which is SIX decimals,
  // it sent a hundred times more. Neither is recoverable and both look like a
  // successful launch.
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(
      "This launch's quote asset has not been read yet, so the amount cannot be scaled. " +
      "Wait for the panel above to fill in, or reload."
    );
  }
  if (!threshold) {
    throw new Error(
      "This launch's graduation threshold has not been read yet, so a first buy cannot be checked " +
      "against it. Wait for the panel above to fill in, or reload."
    );
  }

  if (text.includes(",")) throw new Error(COMMA_REFUSED);
  // THE SHARE FIELD, NAMED, when that is the field on screen (round 5, S24).
  const pctText = (($("nDevPct") && $("nDevPct").value) || "").trim();
  const asShare = "The share in the share field" + (pctText ? " (" + pctText + "%)" : "") +
    " was worked out for another asset: ";
  let v;
  try { v = parseUnits(text, decimals); } catch (e) {
    throw new Error(inPct ? asShare + "the amount it came to cannot be scaled to this asset (" + e.message +
      "). Type the share again. Nothing was sent." : e.message);
  }
  if (v === 0n) return 0n;
  // THE CAP FIRST, because it is the tighter of the two and its message is
  // the one that tells a creator what they can actually do. It is worked out
  // from this factory's reserves and the tax on screen, so without them the
  // send stops rather than skip it.
  const capped = shareBps !== undefined && shareBps !== null && BigInt(shareBps) < 10000n;
  const cap = devBuyCeiling(threshold, shareBps, factory);
  if (capped && cap === null) {
    throw new Error(
      "The most a first buy can be is worked out from this factory's terms and the creator tax, and they " +
      "are not read yet. Wait for the panel above to fill in, check the tax, and send again. Nothing was sent."
    );
  }
  if (capped && v > cap) {
    throw new Error(
      (inPct ? asShare + "it comes to " + fmt(v, decimals, 4) + ", and a first buy " : "A first buy ") +
      "can receive at most " + sharePlain(shareBps) + "% of the supply, which at this creator tax is " +
      fmt(cap, decimals, 6) + ". " +
      (inPct ? "Type the share again. Nothing was sent." : "You asked for " + fmt(v, decimals, 6) + ". Nothing was sent.")
    );
  }
  if (threshold && v >= threshold) {
    throw new Error(
      "A first buy has to be below this launch's graduation threshold of " +
      fmt(threshold, decimals, 4) + ". Otherwise it would graduate the launch in the same transaction."
    );
  }
  return v;
}

/// The questions the registry asks a record's curve (CurveDoesNotMatch's
/// second argument), in words.
const CURVE_QUESTIONS = {
  [sig("token()")]: "token() (the token it sells)",
  [sig("pairToken()")]: "pairToken() (the asset it is paired with)",
  [sig("factory()")]: "factory() (the graduator it moves into)",
};

/// THE GRADUATOR'S OWN REFUSALS OF graduate() AND rescueCurveFees(), as
/// sentences, for their simulations below.
const GRADUATOR_REFUSALS = {
  // A record whose curve sells another token is not this launch's: the
  // graduator will not graduate it, rescue its fees or switch its sharing on.
  [sig("CurveIsAnotherLaunchs(address,address)")]: (w) =>
    "the curve " + wordToAddress(w[0]) + " named in this launch's record sells another token (" +
    wordToAddress(w[1]) + "), so the graduator treats it as no part of this launch. This launch's record is " +
    "not one to trust: do not buy it.",
  // The curve's creator-fee recipient and the platform's recipient may rescue
  // its fees at any time; anyone else only once the launch has sat full and
  // unmoved for the graduator's hour, counted from a note anyone may make
  // (noteReady). The second word is when that opens, or zero before a note.
  [sig("RescueNotOpenYet(address,uint256)")]: (w) => {
    const at = wordToBig(w[1]);
    return wordToAddress(w[0]) + " is neither this curve's creator-fee recipient nor the platform's recipient, " +
      "who may rescue its fees at any time. Anyone else may only once the launch has sat full and unmoved for an " +
      "hour after somebody noted it stuck - " + (at === 0n
      ? "nobody has yet; pressing \"Rescue the curve's fees\" notes it."
      : "it opens at " + utcMinute(at) + " if the move has not completed by then.");
  },
  [sig("CurveNotReady(address)")]: (w) =>
    "the curve " + wordToAddress(w[0]) + " is not full, so this launch is not waiting for its move.",
  [sig("AlreadyGraduated(address)")]: (w) =>
    "the launch " + wordToAddress(w[0]) + " has already moved into its pool.",
};
/// A chain time (seconds) as a person reads it, to the minute, in UTC - the
/// clock the graduator compares against.
function utcMinute(seconds) {
  const d = new Date(Number(seconds) * 1000);
  return isNaN(d.getTime()) ? String(seconds) : d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

/// THE FACTORY'S OWN REFUSALS OF A LAUNCH, as sentences. Keyed by the error's
/// selector, derived from its signature in CurbLaunchFactory.sol like every
/// selector here. One not listed is reported as the node worded it.
const LAUNCH_REFUSALS = {
  [sig("CreatorIsInfrastructure(address)")]: (w) =>
    // NOT A LIST OF WHICH. The factory's own list (launch() and
    // _refuseOtherLaunchers) is longer than any this page could keep in step
    // with, so the sentence names examples and says what they have in common.
    // AND SINCE THE r7 FIXES, MORE THAN ITS OWN CONTRACTS: the paired asset,
    // Permit2, any launch token, and every other launcher's escrow, policy and
    // vault - addresses that can no more use what a launch pays them.
    "the creator wallet " + wordToAddress(w[0]) + " is an address that could never use the fees and the locked " +
    "position a launch pays its creator: one of this deployment's own contracts (such as its fee escrow, its " +
    "graduator or its hook, or another asset's), the paired asset, Permit2 or a launch token. Leave the field " +
    "blank to use your own account, or enter an address you control.",
  [sig("PlatformRecipientIsInfrastructure(address)")]: (w) =>
    "the platform's fee recipient (" + wordToAddress(w[0]) + ") is one of this deployment's own contracts, so " +
    "this factory makes no launch until the platform changes it.",
  [sig("PlatformPolicyMoved(uint16,uint16,address,address)")]: (w) =>
    "the platform's terms moved while this was being prepared (now " + fmtBps(wordToBig(w[1])) + " to " +
    wordToAddress(w[3]) + "). Press Refresh to see the split that applies now.",
  // THE DEV BUY CAP, IN TOKENS. readDevBuy refuses first; this is what is left
  // when the chain's figure and the page's still differ at the send.
  [sig("DevBuyAboveShare(uint256,uint256,uint16)")]: (w) =>
    "the dev buy would receive " + fmt(wordToBig(w[0]), 18, 0) + " tokens, and a first buy may receive at most " +
    fmt(wordToBig(w[1]), 18, 0) + " (" + sharePlain(wordToBig(w[2])) + "% of the supply). Lower the dev buy.",
  [sig("LaunchFeeMismatch(uint256,uint256)")]: (w) =>
    "it charges a launch fee of " + fmt(wordToBig(w[1]), 18, 18) + " ETH, and this page launches only on " +
    "factories that charge none.",
  [sig("TaxOutOfBand(uint16,uint16,uint16)")]: (w) =>
    "a tax of " + fmtBps(wordToBig(w[0])) + " is outside its band of " + fmtBps(wordToBig(w[1])) + " to " +
    fmtBps(wordToBig(w[2])) + ".",
  [sig("QuoteDecimalsMismatch(address,uint8,uint8)")]: (w) =>
    "the quote asset now reports " + wordToBig(w[2]) + " decimals, not the " + wordToBig(w[1]) + " its " +
    "threshold was written in, so this factory makes no launch at all.",
  // THE GRADUATOR'S, met inside launch() when holder sharing is switched on in it.
  [sig("FactoryNotApproved(address)")]: (w) =>
    "the holder sharing version " + wordToAddress(w[0]) + " is not approved by the catalog now. Press Refresh to " +
    "read the version it approves, or choose You under Who earns your tax.",
  [sig("CurveIsAnotherLaunchs(address,address)")]: (w) =>
    "the graduator would not switch holder sharing on: the curve " + wordToAddress(w[0]) + " this factory " +
    "recorded sells another token (" + wordToAddress(w[1]) + "). This factory makes no launch the graduator " +
    "accepts; choose another one.",
  // THE REGISTRY'S, met inside launch() when the factory records the launch.
  // The registry takes a record only when its curve vouches for it - its own
  // token, paired asset and graduator - and no other record names that curve.
  // A factory of this deployment never meets either; one that does is not
  // making launches the registry can accept.
  [sig("CurveDoesNotMatch(address,bytes4)")]: (w) =>
    "the launch registry refused the record: its curve " + wordToAddress(w[0]) + " does not answer " +
    (CURVE_QUESTIONS["0x" + w[1].slice(0, 8)] || "0x" + w[1].slice(0, 8)) + " with this launch's own value. " +
    "This factory makes no launch the registry accepts; choose another one.",
  [sig("CurveAlreadyRegistered(address,address)")]: (w) =>
    "the launch registry refused the record: its curve " + wordToAddress(w[0]) + " already belongs to the " +
    "launch " + wordToAddress(w[1]) + ", and a curve serves one launch only. This factory makes no launch the " +
    "registry accepts; choose another one.",
};

/// THE REVERT DATA WHERE THE NODE PUTS IT: error.data, or nested once more;
/// failing both, a "custom error 0x<selector>" the node wrote into its
/// message. "" when there is none.
function revertData(e) {
  const inMessage = /custom error:?\s*(0x[0-9a-fA-F]{8})(?:[:\s,]+(?:0x)?([0-9a-fA-F]+))?/i.exec((e && e.message) || "");
  return typeof (e && e.data) === "string" ? e.data
    : e && e.data && typeof e.data.data === "string" ? e.data.data
      : inMessage ? inMessage[1] + (inMessage[2] || "") : "";
}

/// A simulation's revert as a sentence: the factory's own words where the
/// revert data names one of its refusals, the node's otherwise.
/// @param table  the refusals to look the selector up in - the factory's by
///               default, the CURB router's for a router trade, the
///               graduator's for a move into the pool or a rescue.
function revertSentence(e, table = LAUNCH_REFUSALS) {
  const raw = revertData(e);
  const say = table[raw.slice(0, 10).toLowerCase()];
  if (say) {
    try { return say(words("0x" + raw.slice(10))); } catch { /* fall back to the node's words */ }
  }
  return (e && e.message ? e.message : String(e)) + ".";
}

/// @param expected  { bps, to } - the platform split the creator was SHOWN.
async function createLaunchInner(pin, name, symbol, tax, creatorWallet, devBuy, expected) {
  // NO OWNER CHECK. launch() is open to anyone. The creator is creatorWallet,
  // or the caller when that is empty.

  // A salt nobody has used, so the token address is new each time.
  const salt = keccak256("0x" + utf8Hex(name + symbol + Date.now() + Math.random()));
  // TEN FIELDS, and nothing with a price on it: the supply, the curve's shape,
  // the lock, the pool and the fee policy are the factory's.
  // THE FIFTH FIELD IS quoteRefundTo, AND IT IS ONLY THE QUOTE. Leftover NVDAc
  // comes back to the sender; the launch tokens the pool could not absorb are
  // burned. The field used to be called remainderTo and was documented as the
  // token remainder, which was the wrong one of the two.
  // THE THIRD FIELD USED TO BE "". CurbLaunchToken stores it in its
  // constructor and has no setter, so every launch made from this page had an
  // empty tokenUri permanently - no image, no links, no description, ever.
  // WHAT THE SPLIT ON SCREEN WAS MADE OF, carried into the transaction. The
  // factory refuses the launch if the policy has moved since - which it can,
  // on a timestamp, while this is being signed.
  //
  // THE SHOWN VALUES, NOT A FRESH READ. This used to read the policy again
  // here and send THAT, so the factory's check compared the chain with itself
  // and a change that ripened while the form was being filled in went
  // straight through - onto a record nobody can edit. The fresh read below is
  // only so the refusal arrives as a sentence, before any gas, instead of as a
  // revert; the factory's check is the one that counts.
  const policy = words(await pin.call(pin.factory, SEL.currentPlatformPolicy));
  if (policy.length < 2) throw new Error("The factory would not say what platform terms it applies.");
  const nowBps = wordToBig(policy[0]);
  const nowTo = wordToAddress(policy[1]);
  if (nowBps !== expected.bps || !same(nowTo, expected.to)) {
    // NOTHING TO FORGET. The next refresh reads the policy fresh - withPolicy()
    // never caches it - so it draws the split in force by itself. A `delete
    // cache[...]` here claimed to do that and only made the factory's
    // immutable terms be read again (round 5, S59).
    const moved = [];
    if (nowBps !== expected.bps) moved.push("its share from " + fmtBps(expected.bps) + " to " + fmtBps(nowBps));
    if (!same(nowTo, expected.to)) moved.push("its recipient from " + expected.to + " to " + nowTo);
    throw new Error(
      "The platform's terms changed while you were filling this in: " + moved.join(" and ") + ". " +
      "Nothing was sent. Press Refresh to see the split that applies now, and send again if you still want it."
    );
  }
  const expectBps = expected.bps;
  const expectTo = expected.to;

  // THE SHARING VERSION, READ AGAIN THROUGH THE PINNED ENDPOINT. The catalog's
  // owner can retire a version, or recommend another, at any moment; a launch
  // carries only the version the creator was shown, and only while the catalog
  // still approves it. (The Graduator checks the approval too, and that is the
  // check that counts - this is so a refusal arrives as a sentence.)
  const shareFactory = expected.share || ZERO_ADDRESS;
  if (!same(shareFactory, ZERO_ADDRESS)) {
    const grad = oneAddress(await pin.call(pin.factory, SEL.graduator), "The factory's graduator()");
    const cat = words(await pin.call(grad, SEL.sharingCatalog).catch(() => "0x"));
    const now = await sharingOffer({ catalog: cat.length ? wordToAddress(cat[0]) : null }, (to, d) => pin.call(to, d));
    if (!now.known) {
      throw new Error("The holder sharing catalog could not be read just now. Nothing was sent - try again.");
    }
    if (!same(now.factory, shareFactory) || !now.approved) {
      throw new Error(
        "The holder sharing version changed while you were filling this in: the catalog now " +
        (now.approved && !same(now.factory, ZERO_ADDRESS) ? "recommends " + now.factory : "approves none") +
        ", not the " + shareFactory + " shown. Nothing was sent. Press Refresh to read it again."
      );
    }
  }

  const tokenUri = buildTokenUri(name, symbol);
  // THE CALLDATA FOR A GIVEN FIRST BUY. Everything else is the same in both
  // uses: the launch sent, and the dev-buy-free copy simulated below.
  const launchData = (firstBuy) => SEL.launch + encode(
    [T.tuple([
      T.string, T.string, T.string, T.bytesN(32), T.address, T.uint(16), T.uint(256), T.address,
      T.uint(16), T.address, T.address,
    ])],
    [[name, symbol, tokenUri, salt, pin.from, tax, firstBuy, creatorWallet, expectBps, expectTo, shareFactory]]
  ).slice(2);
  const data = launchData(devBuy);

  // LAUNCHING COSTS GAS ONLY. No launch fee is sent: every CURB factory
  // charges none, and the factory refuses any ether it is not owed. A factory
  // that did charge one is refused by the simulation below, with its figure,
  // before anything is paid for.

  // A LAUNCH THAT MUST REVERT IS NOT SENT, AND NOTHING IS PAID FOR IN FRONT OF
  // IT (round 5, N55). launch() is simulated with this exact sender, value and
  // calldata. It used to be sent blind, behind a wrap and an approval: a
  // creator wallet pasted wrong (the escrow or the hook, copied off this page),
  // a quote asset whose decimals moved, a platform recipient the factory
  // refuses - each cost those two transactions, left an allowance standing,
  // and only then failed.
  // WHAT IS SIMULATED WHEN, AND WHY. With no dev buy the simulation is of the
  // very transaction sent, before anything. With one, the factory would pull
  // funds this account has not yet approved, so an honest simulation of it
  // cannot run until the approval has - and faking a balance or an allowance
  // needs the asset's storage layout, which this page does not know. So:
  //   1. BEFORE anything is paid for, the same launch WITHOUT the first buy.
  //      launch() reads cfg.devBuy only after every other check it makes -
  //      the creator-wallet refusals (CreatorIsInfrastructure), the tax band,
  //      the decimals re-check, the platform recipient and terms, the fee -
  //      and after register(), so all of those are proved here.
  //   2. The first buy's own conditions, from the pinned factory: its ceiling
  //      and the threshold (readDevBuy), the balance (ensureQuoteHeld), the
  //      allowance (ensureAllowance).
  //   3. AFTER the approval, the exact transaction, before it is sent. What
  //      only that can see - the issuer refusing the pull, a quote asset that
  //      delivers less than it was asked for - costs the approval, never a
  //      reverted launch.
  const simulate = async (callData, spent) => {
    const req = { from: pin.from, to: pin.factory, data: callData };
    try {
      await pin.read("eth_call", [req, "latest"]);
    } catch (e) {
      if (!isRevert(e)) {
        throw new Error("Whether the factory would accept this launch could not be checked: " +
          (e && e.message ? e.message : String(e)) + ". " + spent + " Try again.");
      }
      throw new Error("The factory would refuse this launch: " + revertSentence(e) + " " + spent);
    }
  };
  await simulate(devBuy > 0n ? launchData(0n) : data, "Nothing was sent.");

  if (devBuy > 0n) {
    // THE FACTORY PULLS THE DEV BUY, so it needs an allowance first - and only
    // for this one amount. A factory with standing permission over somebody's
    // equities is a factory that could take them later; this one cannot.
    // HELD FIRST, THEN APPROVED. See ensureQuoteHeld. The wrap, like the
    // approval, is recorded as part of the create.
    const wrapped = await ensureQuoteHeld(pin, devBuy, "Your first buy", "create-approve");
    const approved = await ensureAllowance(pin, pin.quote, pin.factory, devBuy,
      `${fmt(devBuy, pin.quoteDecimals, 6)} ${pin.quoteSym} to the factory for your first buy`, "create-approve");
    const paid = [wrapped ? "the wrap" : "", approved ? "the approval" : ""].filter(Boolean);
    const kept = [approved ? "the allowance stays until it is spent or you revoke it" : "",
      wrapped ? "the WETH it made is yours" : ""].filter(Boolean);
    await simulate(data, paid.length
      ? "The launch was not sent; " + paid.join(" and ") + " sent ahead of it " + (paid.length > 1 ? "are" : "is") +
        " mined: " + kept.join(", and ") + "."
      : "Nothing was sent.");
  }

  // KEPT until the address has been read out and stored.
  const tx = { to: pin.factory, data };
  const receipt = await send(pin, tx, `create the launch ${symbol}`, "create", true);
  adoptCreated(pin, receipt, receipt.record, symbol, false, null, name);
}

/// The one place a created launch is taken out of a receipt and put somewhere.
/// Shared by the live path and the recovery so they cannot disagree.
///
/// THE FACTORY IS THE PINNED ONE. Filtering on chainCfg.factory meant a form
/// edited during the wait could make this look for the event of a DIFFERENT
/// deployment in this receipt, and find nothing - or worse, find something.
/// @param say  where the words go: show() for the live create; resumePending's
///             collector for a recovery, which says it only when it may speak.
/// @return {token, kept, html} - `kept` when the address is in the form and in
///         storage, and the record is cleared.
function adoptCreated(pin, receipt, record, symbol, recovered, say, name) {
  say = say || show;
  const created = (receipt.logs || []).find(
    (l) => same(l.address, pin.factory) && l.topics[0] === TOPIC.launchCreated);
  if (!created) throw new Error("the launch was mined but no LaunchCreated event was found");
  const token = wordToAddress(created.topics[1].replace(/^0x/, ""));

  // THE RESULT BELONGS TO THE CONTEXT IT WAS MADE IN. If the page has been
  // pointed at another deployment meanwhile, say so and leave the form alone
  // rather than quietly writing this token into a place it does not exist.
  // A CREATE DEPENDS ON THE FACTORY, THE ENDPOINT AND THE CHAIN - NOT THE LENS.
  // Comparing the lens meant a launch created with no lens was never adopted
  // once one was filled in, and its record then blocked the factory.
  const stillThere = same(chainCfg.factory, pin.factory) && chainCfg.rpc === pin.rpc;

  if (stillThere) {
    chainCfg.token = token;
    $("token").value = token;
    // The last automatic switch was about the previous launch, not this one.
    switchNote = null;
    saveCfg();
  }

  // STORED BEFORE THE RECORD GOES. Until the address is somewhere it survives a
  // reload, the record is the only way back to it.
  let keptSomewhere = stillThere;
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || "{}");
    keptSomewhere = keptSomewhere && same(saved.token, token);
  } catch { keptSomewhere = false; }

  if (keptSomewhere && record) TX.clearPending(record);
  // NOT KEPT, AND NOT OUTSTANDING EITHER. The chain has said what this create
  // made - its receipt names the launch - so it can no longer be paid for
  // twice by accident. The record stays to carry the address until the form
  // can take it or the person forgets it; outstandingFor lets a create by.
  else if (record) TX.updatePending(record, { made: token });

  // SHORT, AND ABOUT THE TOKEN (the owner's call: "launched, view it here",
  // with its contract address). The transaction is in the wallet's activity.
  // The two exceptions below stay, because each changes what to do next.
  // WHEN THE PAGE CANNOT KEEP IT, EVERYTHING TO COPY IS SAID - the transaction
  // too - because the notice is then the only record left on screen.
  const tx = `<code>${escapeHtml(receipt.transactionHash)}</code>`;
  const where = stillThere
    ? ""
    : ` The page is on a different deployment now, so it was left as it is: this launch was made in ${tx}, ` +
      `under factory <code>${escapeHtml(pin.factory)}</code> on <code>${escapeHtml(pin.rpc)}</code>.`;
  const kept = keptSomewhere ? "" : ` This browser did not keep the address - copy it now` +
    (stillThere ? ` (made in ${tx}).` : ".");

  // ONE COMPACT LINE (the owner's call): "Launched", the name and $SYMBOL, the
  // short contract address with its copy button (the whole address is in
  // data-copy; topbar.js adds the button) and a small "View". A recovery says
  // what it was first, with the whole address, since it has no name to show.
  const who = [name ? escapeHtml(name) : "", symbol ? "$" + escapeHtml(symbol) : ""].filter(Boolean).join(" · ");
  const lead = recovered === "replaced"
    ? "A launch you created in a previous visit completed, through a replacement (a speed-up) your wallet sent."
    : recovered ? "A launch you created in a previous visit completed." : "";
  const addr = escapeHtml(token);
  // THE WHOLE ADDRESS WHEN THE NOTICE IS ITS ONLY RECORD (a recovery, a form
  // that moved on, a browser that did not keep it): it must be readable as is.
  const code = recovered || where || kept ? `<code>${addr}</code>`
    : `<code data-copy="${addr}" title="${addr}">${addr.slice(0, 6)}…${addr.slice(-4)}</code>`;
  const line = (view) => `<span class="toastLaunch" data-linger><strong>Launched</strong>` +
    (who ? `<span class="toastWho">${who}</span>` : "") + code + view + `</span>`;
  const html = (lead ? `<span class="toastHead">${lead}</span>` : "") +
    line(`<a class="toastCta" data-linger href="${escapeHtml(tokenPageHref(token, pin))}">View</a>`) +
    (where || kept ? `<span class="toastMore">${where}${kept}</span>` : "");
  // A RECOVERY THE FORM COULD NOT TAKE IS NOT SAID HERE. It comes back as
  // "made", and resumePending says it once per load, through its own `say`.
  if (!recovered || keptSomewhere) say("ok", html);
  // STRAIGHT TO THE NEW TOKEN'S PAGE, with its trade card in view (the owner's
  // call), carrying the notice there. Only for a live create the form kept: a
  // recovery, or a create the page could not keep, stays to say so.
  if (!recovered && stillThere && keptSomewhere && !window.CURB_STAY_AFTER_CREATE) {
    try { sessionStorage.setItem(CREATED_NOTICE, JSON.stringify({ token: token.toLowerCase(), html: line("") })); } catch {}
    location.assign(tokenPageHref(token, pin) + "#trade");
  }
  return { token, kept: keptSomewhere, html };
}

/// THE CREATE'S NOTICE, carried across the move to the token's page.
const CREATED_NOTICE = "curb.created.notice";
function showCreatedNotice() {
  if (!TOKEN_VIEW) return;
  let got = null;
  try { got = JSON.parse(sessionStorage.getItem(CREATED_NOTICE) || "null"); sessionStorage.removeItem(CREATED_NOTICE); } catch {}
  if (got && typeof got.html === "string" && same(got.token, TOKEN_PATH[1])) show("ok", got.html);
}

async function curveAction() {
  const pin = await beginAction("trade");
  return withSendLock(pin, () => curveActionInner(pin));
}

// ------------------------------------------- what a transaction actually did
//
// A BALANCE READ BEFORE A SEND AND AGAIN AFTER IT IS NOT A MEASUREMENT OF THAT
// SEND. Anything else mined in between lands in the difference - and in the
// first real-wallet run something did. The account was also the fee hook's
// recipient, so the PoolManager credited it TWICE in one transaction, once with
// the swap's output and once with the hook's fee. The page added them together
// and called the sum "received": true of the balance, false about the swap, and
// no sign on screen that two different things had been combined.
//
// Everything below is read from THIS transaction's receipt.

/// WHAT THIS TRANSACTION COST, AND WHETHER THAT IS ALL OF IT.
///
/// Base charges an L2 execution fee AND an L1 data fee, and the second one
/// arrives as `l1Fee` on the receipt. A node that does not add those fields -
/// the forked anvil this is developed against does not - leaves the L1 part
/// simply unknown, and treating unknown as zero would understate what the
/// person paid. So it is reported as incomplete instead.
function txFee(receipt) {
  // A FIELD THAT IS NOT THERE IS UNKNOWN, NOT ZERO. Returning 0n for a missing
  // gasUsed or l1Fee put a number on screen that nothing had measured, and
  // "feeTotal" then meant "some of the fee" while looking like all of it.
  const l2 = receipt.gasUsed != null && receipt.effectiveGasPrice != null
    ? BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice)
    : null;
  const l1 = receipt.l1Fee != null ? BigInt(receipt.l1Fee) : null;
  const missing = [];
  if (l2 === null) missing.push("the L2 execution fee");
  if (l1 === null) missing.push("Base's L1 data fee");
  return { l2, l1, known: (l2 || 0n) + (l1 || 0n), missing };
}

/// THE ETH THIS TRANSACTION PAID OUT, from its own logs.
///
/// UNWRAP_WETH makes the router call WETH.withdraw, which emits Withdrawal with
/// the exact amount - and that is the amount the router then forwards. A
/// balance difference would include anything else that arrived while the
/// transaction was in flight, which is the mistake this file already made once
/// on the token side.
const ethUnwrapped = (receipt) =>
  logsOf(receipt, WETH, TOPIC.wethWithdrawal)
    .filter((l) => l.topics.length > 1 && same(wordToAddress(l.topics[1].slice(2)), ROUTER))
    .map((l) => wordToBig(words(l.data)[0]))
    .reduce((a, b) => a + b, 0n);

/// A READ THAT FAILS AFTER A TRANSACTION SUCCEEDED IS NOT A FAILED TRANSACTION.
///
/// Everything after the send is reporting - the hook's settings, a balance for
/// the cross-check - and those are RPC calls that can fail on their own. Letting
/// one throw puts the page on the generic error path, and a person who reads
/// "something went wrong" after a transaction that was MINED is a person about
/// to send it again and pay twice. The transaction is the fact; the description
/// of it is not.
async function report(receipt, fn) {
  try {
    await fn();
  } catch (e) {
    const hash = (receipt && receipt.record && receipt.record.hash) || (receipt && receipt.transactionHash) || "";
    show("ok",
      `<strong>The transaction succeeded.</strong> Its result could not be read: ` +
      `${escapeHtml(e && e.message ? e.message : String(e))}. ` +
      `Transaction: <code>${escapeHtml(hash)}</code>. It does not need to be sent again.`);
  }
}

const logsOf = (receipt, address, topic0) =>
  (receipt.logs || []).filter((l) => same(l.address, address) && l.topics && l.topics[0] === topic0);

/// ERC20 credits to one account, in one transaction.
const creditsTo = (receipt, token, who) =>
  logsOf(receipt, token, TOPIC.transfer)
    .filter((l) => l.topics.length > 2 && same(wordToAddress(l.topics[2].slice(2)), who))
    .map((l) => wordToBig(words(l.data)[0]));

/// Readable, WITHOUT throwing the exact figure away. fmt() truncates - it is
/// how 4045403871017936841026317 became "4,045,403.871017" - so a reader
/// checking the page against the chain was comparing against a shortened copy.
const amt = (v, decimals, unit) =>
  `<strong title="exact: ${v.toString()}">${escapeHtml(fmtSmall(v, decimals, 6))}</strong> ${unit}`;
const exactly = (pairs) =>
  `<br><span class="exact">exact, in the smallest unit: ` +
  pairs.map(([label, v]) =>
    `${escapeHtml(label)} <code>${v === null || v === undefined ? "unknown" : v.toString()}</code>`
  ).join(" · ") + `</span>`;

/// A TRANSACTION'S RESULT, SHORT (the owner's call): a tick, what happened -
/// "Swapped" - and under it what went and what came, "11 ETH → 200,812 DEMO",
/// with the transaction on chain in the corner. The full account (fee, tax,
/// exact figures) stays in the line, unshown in the notice, for whoever reads
/// it from the page.
/// A figure written out, not abbreviated: whole from a thousand up, four
/// decimals from one, four significant digits below.
function brief(v, decimals) {
  const n = Number(v) / 10 ** decimals;
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return n.toLocaleString("en-US", { maximumSignificantDigits: 4 });
}
const TICK = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3.5 8.4l2.9 2.9 6.1-6.6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
/// The notice's head: the tick, a title, and an optional line under it.
const doneHead = (title, line = "") =>
  `<span class="toastIcon">${TICK}</span><span class="toastBody"><b class="toastTitle">${title}</b>` +
  (line ? `<span class="toastLine">${line}</span>` : "") + `</span>`;
/// "Swapped / 11 ETH → 200,812 DEMO", from the two sides of a trade, and what
/// came back, when something did.
const wentCame = (out, outDec, outUnit, got, gotDec, gotUnit, back = "") =>
  doneHead("Swapped", `${brief(out, outDec)} ${escapeHtml(outUnit)} <span class="toastArrow">→</span> ` +
    `<strong>${brief(got, gotDec)} ${escapeHtml(gotUnit)}</strong>` + (back ? `<span class="toastBack">${back}</span>` : ""));
const hashOf = (receipt) =>
  (receipt && (receipt.transactionHash || (receipt.record && receipt.record.hash))) || "";
/// The transaction, on Base's explorer; on any other chain (a local fork has
/// none) its short hash, which the notice gives a copy button.
function chainLink(hash) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return "";
  return chainIdShown === 8453
    ? `<a class="toastChain" href="https://basescan.org/tx/${hash}" target="_blank" rel="noopener">View on chain ↗</a>`
    : `<span class="toastChain">tx <code data-copy="${hash}" title="${hash}">${hash.slice(0, 6)}…${hash.slice(-4)}</code></span>`;
}
function showDone(head, receipt, full = "") {
  show("ok", `<span class="toastShort">${head}</span>` + chainLink(hashOf(receipt)) +
    (full ? `<span class="toastLong">${full}</span>` : ""));
}
/// The launch token's symbol for a one-line result, or "tokens".
const launchSym = (pin) => symbolOf(pin.token, (to, data) => pin.call(to, data)).catch(() => "tokens");

/// THE SWAP, AND WHATEVER ELSE ARRIVED, KEPT APART.
///
/// THE TAX IS ON THE NVDAc SIDE, AND WHICH SIDE THAT IS DEPENDS ON THE
/// DIRECTION. That is the whole reason this is not one subtraction any more:
///
///   BUY   NVDAc -> MEME   the tax comes off the INPUT, before the swap. The
///                         memecoin the trader receives is the pool's whole
///                         output, untouched, and the two fee payments are in
///                         NVDAc - the token they were spending.
///   SELL  MEME -> NVDAc   the tax comes off the OUTPUT. The trader keeps the
///                         gross minus both legs.
///
/// gross     the pool's own Swap event, on the output side
/// platform  base * P / 10000, floored - P the launch's own platformBps
/// creator   base * (T - P) / 10000, floored  (P was 50 at deployment)
///           Both are RECOMPUTED here rather than read from the hook's own
///           FeeCharged event, so a pool charging something other than what it
///           records shows up as a mismatch instead of being echoed back.
/// net       what the trader is left with on the output side.
/// credited  what this transaction actually moved into the account, summed from
///           the output token's Transfer logs in this receipt.
/// EVERY PAYMENT MATCHED TO A PAYEE, one for one. A multiset, because the two
/// can go to the SAME address - which is the case this whole thing exists for -
/// and then two separate payments of two specific amounts have to be present,
/// not one payment of their sum.
/// EVERY FEE LEG MATCHED, TO ITS PAYEE OR TO THE HOOK.
///
/// The amount is exact either way; only the destination is allowed to be one
/// of two. A leg the pool could not hand over is taken to the hook and
/// recorded as a debt - always on a WETH pool, and on any pool whose recipient
/// the issuer has blocked - so "paid" and "owed" are both settlements and a
/// receipt that shows either is a receipt that adds up.
function matchFeeLegs(actual, fees, hook) {
  if (actual.length !== fees.length) return false;
  const left = actual.slice();
  for (const f of fees) {
    const i = left.findIndex((a) => a.amount === f.amount && (same(a.to, f.to) || (hook && same(a.to, hook))));
    if (i < 0) return false;
    left.splice(i, 1);
  }
  return true;
}

function matchPayments(actual, expected) {
  if (actual.length !== expected.length) return false;
  const left = actual.slice();
  for (const e of expected) {
    const i = left.findIndex((a) => same(a.to, e.to) && a.amount === e.amount);
    if (i < 0) return false;
    left.splice(i, 1);
  }
  return true;
}

/// `netTo` is WHO THE SWAP'S OUTPUT IS PAID TO, which is not always the person
/// holding the wallet. On the ETH route's sell the v4 leg pays its NVDAc to the
/// ROUTER, because that NVDAc is the next leg's input and never theirs.
async function readSwapResult(pin, receipt, { id, outToken, zeroForOne, netTo, inToken, amountIn }) {
  netTo = netTo || pin.from;
  const credited = creditsTo(receipt, outToken, pin.from).reduce((a, b) => a + b, 0n);
  const out = {
    credited, gross: null, net: null, reconciles: false, why: "",
    platform: null, creator: null, feeToken: null, quoteIsInput: false,
    platformRecipient: null, creatorRecipient: null, feeToMe: false,
  };

  const swap = logsOf(receipt, POOL_MANAGER, TOPIC.swap).find((l) => l.topics[1] === id);
  if (!swap) { out.why = "it carries no Swap event for this pool"; return out; }
  const w = words(swap.data);
  const signed = zeroForOne ? wordToInt(w[1], 256) : wordToInt(w[0], 256);
  if (signed <= 0n) { out.why = "the pool's Swap event reports no output on this side"; return out; }
  out.gross = signed;

  const hook = pin.hook && !/^0x0{40}$/i.test(pin.hook) ? pin.hook : null;
  if (!hook) {
    out.platform = 0n;
    out.creator = 0n;
    out.net = out.gross;
    return reconcileSwap(receipt, out, { outToken, netTo, inToken, hook: pin.hook });
  }

  const cfg = words(await pin.call(hook, SEL.taxOfId + id.replace(/^0x/, "")));
  if (wordToBig(cfg[3]) !== 1n) { out.why = "this pool has no tax recorded on the hook"; return out; }
  const totalTaxBps = wordToBig(cfg[0]);
  const platformBps = wordToBig(cfg[5]);   // the launch's, frozen when it was created
  // THIS POOL'S, FROM ITS OWN RECORD. Asking the hook for its current
  // recipient would name the one the NEXT launch gets stamped with; the fee
  // this receipt is about went where the record says. FeeHook.LaunchFee.
  out.platformRecipient = wordToAddress(cfg[4]);
  out.creatorRecipient = wordToAddress(cfg[2]);

  // WHICH SIDE THE TAX IS ON. The quote asset is the base either way; on a buy
  // it is the money going in, on a sell the money coming out.
  out.quoteIsInput = same(inToken, pin.quote);

  // THE BASE ON A BUY IS MEASURED, NOT PASSED IN. It is the NVDAc that actually
  // reached the PoolManager in this transaction - the router settles the whole
  // amount and the hook takes its legs back out of that - so this is the figure
  // the hook charged on.
  //
  // IT IS NOT WHAT THE PERSON SENT, on the ETH route. There the v4 leg's input
  // is whatever the v3 leg produced, which is NVDAc and is not known until the
  // transaction has run. Passing the form's amount put an ETH-scale number in
  // and produced a tax five thousand times too large - caught because the
  // payments then did not reconcile, which is what that check is for.
  const settled = out.quoteIsInput
    ? logsOf(receipt, inToken, TOPIC.transfer)
        .filter((l) => l.topics.length > 2 && same(wordToAddress(l.topics[2].slice(2)), POOL_MANAGER))
        .reduce((a, l) => a + wordToBig(words(l.data)[0]), 0n)
    : 0n;
  const base = out.quoteIsInput ? settled : out.gross;
  out.base = base;
  out.feeToken = out.quoteIsInput ? inToken : outToken;
  // KEPT, BECAUSE THE RECEIPT NAMES IT. The share differs between launches -
  // each launch's is frozen into its registry record when the launch is
  // created, from whatever the hook's policy was then, and its pool copies it
  // at graduation - so the receipt says the one this pool charged rather than
  // any figure the reader's page might carry.
  out.platformBps = platformBps;
  out.platform = (base * platformBps) / 10000n;
  out.creator = (base * (totalTaxBps - platformBps)) / 10000n;
  // On a buy the output is untouched: the tax never entered the pool.
  out.net = out.quoteIsInput ? out.gross : out.gross - out.platform - out.creator;
  out.feeToMe = same(out.platformRecipient, pin.from) || same(out.creatorRecipient, pin.from);

  return reconcileSwap(receipt, out, { outToken, netTo, inToken, hook: pin.hook });
}

/// EVERY PAYMENT THE POOL MANAGER MADE, MATCHED TO A PAYEE AND AN AMOUNT.
///
/// Checking a sum is not a check when the trader IS a recipient: the fee
/// cancels out and a wrong rate passes. So each payment is matched one for one,
/// as a multiset - two payments to the same address still have to both be
/// there, with those two amounts.
///
/// AND ON A BUY THE TWO SIDES ARE IN DIFFERENT TOKENS. The output goes out in
/// the memecoin while the fees go out in NVDAc, so they are matched separately;
/// adding them would be adding two assets.
/// `hook` is THE ADDRESS THE FEES MAY HAVE GONE TO INSTEAD. Passed in
/// rather than read from a global: this function is handed everything it
/// judges, and reaching for the page's live state here would judge a mined
/// receipt against whatever the screen shows now.
function reconcileSwap(receipt, out, { outToken, netTo, inToken, hook }) {
  const paidIn = (token) => logsOf(receipt, token, TOPIC.transfer)
    .filter((l) => l.topics.length > 2 && same(wordToAddress(l.topics[1].slice(2)), POOL_MANAGER))
    .map((l) => ({ to: wordToAddress(l.topics[2].slice(2)), amount: wordToBig(words(l.data)[0]) }));

  const fees = [];
  if (out.platform > 0n) fees.push({ to: out.platformRecipient, amount: out.platform });
  if (out.creator > 0n) fees.push({ to: out.creatorRecipient, amount: out.creator });

  // WHAT THIS CAN AND CANNOT SETTLE. When the two recipients are the SAME
  // address - which they are on a launch whose creator is also the platform -
  // the chain records two payments to one payee, and a multiset match cannot
  // tell 50/250 from 250/50. The TOTAL is still checked; the split between the
  // legs is arithmetic this page performed, not something it observed. Said
  // out loud rather than left for a reader to notice.
  out.splitIsObserved = !same(out.platformRecipient, out.creatorRecipient);

  // A FEE LEG MAY GO TO THE HOOK INSTEAD OF ITS PAYEE, and that is a success
  // rather than a mismatch.
  //
  // The hook records a fee as a DEBT whenever it cannot hand it over inside
  // the swap: always on a WETH pool, because calling a recipient while the
  // pool manager is unlocked is what AUDIT X-1 was; and on any pool whose
  // recipient the issuer has blocked, which is AUDIT Y-1. In both cases the
  // pool manager pays the hook that leg, and the recipient claims it later.
  // Before this the page called every such trade unreconciled.
  const feeTotal = fees.reduce((sum, f) => sum + f.amount, 0n);
  // ONE PAYMENT PER LEG, TO THE PAYEE OR TO THE HOOK.
  //
  // _deliver runs per leg, so a pool that records both as debts takes TWICE -
  // once each - and the receipt shows two payments to the hook, not one of
  // their sum. Per leg is also the only shape that describes the mixed case:
  // the platform paid straight out while the creator's address is blocked.
  const feesSettled = (payments) => matchFeeLegs(payments, fees, hook);

  const outPayments = paidIn(outToken);
  if (out.quoteIsInput) {
    out.reconciles = matchPayments(outPayments, [{ to: netTo, amount: out.net }])
      && feesSettled(paidIn(inToken));
  } else {
    // THE OUTPUT AND THE FEES SHARE A TOKEN HERE, so the net is matched first
    // and the fee legs against what is left.
    const rest = outPayments.slice();
    const i = rest.findIndex((x) => same(x.to, netTo) && x.amount === out.net);
    out.reconciles = i >= 0 && feesSettled(rest.filter((_, k) => k !== i));
  }
  // WHETHER ANY LEG BECAME A DEBT, recorded rather than left for a reader to
  // work out from a balance that did not move.
  out.feesAccrued = out.reconciles && !!hook
    && (out.quoteIsInput ? paidIn(inToken) : outPayments).some((x) => same(x.to, hook));
  // AND WHICH ONE, per leg - direct payments matched first, then the hook's.
  // The receipt used to tell a payee their own leg was kept whenever ANY leg
  // was, which on a non-WETH pool can be the other payee's.
  out.legs = [];
  if (out.reconciles) {
    const pool = (out.quoteIsInput ? paidIn(inToken) : outPayments.filter((x) => !(same(x.to, netTo) && x.amount === out.net))).slice();
    for (const f of fees) {
      let i = pool.findIndex((a) => a.amount === f.amount && same(a.to, f.to));
      let accrued = false;
      if (i < 0 && hook) { i = pool.findIndex((a) => a.amount === f.amount && same(a.to, hook)); accrued = i >= 0; }
      if (i >= 0) pool.splice(i, 1);
      out.legs.push({ to: f.to, amount: f.amount, accrued });
    }
  }

  if (!out.reconciles) {
    // BOTH SIDES, BECAUSE EITHER CAN BE THE ONE THAT FAILED. This described
    // only the output side, so a fee-side mismatch printed a list of payments
    // that were all correct and said nothing about the ones that were not.
    const feePayments = out.quoteIsInput ? paidIn(inToken) : outPayments;
    const show = (list) => (list.length ? list.map((x) => `${x.amount} to ${x.to}`).join(", ") : "nothing");
    out.why =
      `this pool paid out ${outPayments.length} time(s) on the output side - ` +
      show(outPayments) +
      ` - and that does not match a swap of ${out.gross} with ${out.platform} to the platform ` +
      `and ${out.creator} to ${sharesWithHolders(view) ? "the holders" : "the creator"}. On the fee side the pool manager paid ` +
      show(feePayments) +
      // NOT THE WORDS "was expected": the browser suite's press() helper treats
      // any message matching /.*was expected/ as the page reporting a failure,
      // so that phrase in an explanation turns a correct refusal into a test
      // error. The helper's pattern is looser than it looks; this sidesteps it
      // rather than loosening what many other tests rely on.
      `; each fee leg should appear as its own payment, to its payee or to the hook at ` +
      (hook || "an address this page could not read");
  }
  return out;
}

async function curveActionInner(pin) {
  // ONLY A SELLING CURVE TRADES. A buy that crosses the threshold closes the
  // curve for everyone, and the panel stays drawn until the next refresh - so a
  // sell pressed in between was quoted (getReserves still answers), approved
  // and sent, and reverted with CurveGraduated after two transactions' gas
  // (round 5, N18). pin.view.status is the CHAIN's, checked against the lens by
  // beginAction a moment ago.
  if (pin.view.status !== 1) {
    throw new Error(pin.view.status === 2
      ? "This launch has reached its threshold since the page drew it, so its curve no longer buys or sells. " +
        "Nothing was sent. Complete the move into the pool (Refresh shows the button), then trade there."
      : "This launch has graduated since the page drew it, so its curve is closed. Nothing was sent. " +
        "Refresh, and trade it in the pool.");
  }
  // RECOMPUTED HERE, from the form and THE PINNED CONTEXT, at the moment of
  // sending. The preview is a display; this is the number that gets spent, and
  // it is priced against the launch this action was authorised for rather than
  // whatever the page is showing by now.
  let v = await computeCurveQuote(pin);
  if (v.error) throw new Error(v.error);
  // A SWAP TO OR FROM ETH THAT COULD NOT BE CHECKED AGAINST CHAINLINK IS NOT SENT
  // (withConversion): the router's buy and sale, and the two-step buy.
  const unchecked = convUncheckedRefusal(v, pin.quoteSym);
  if (unchecked) throw new Error(unchecked);
  // ONE SWAP AT A TIME: what an earlier one delivered is used, or dismissed,
  // before ETH buys another - a second press must not buy a second step 1.
  // Said first: it is the reason that holds whatever the route.
  if (v.via === "aero" || v.via === "eth") {
    const holding = await heldFor(pin);
    if (holding > 0n) {
      throw new Error(`You still hold ${fmt(holding, pin.quoteDecimals, 6)} ${pin.quoteSym} from an earlier swap ` +
        `for this launch. Nothing was sent. Press Buy with it to use it, or Dismiss it to pay with ETH again.`);
    }
  }
  // THE ROUTE SENT IS THE ROUTE SHOWN, or one that needs no more confirmations
  // and has no lower minimum. The quote is taken again here, and a route that
  // changed in between - Aerodrome winning at the press after a one-send quote,
  // or an Aerodrome read failing after an Aerodrome quote, which would send the
  // other route at whatever minimum it has - is refused rather than sent. The
  // route shown is sent with the minimums shown where the fresh ones are lower
  // (floorAtDrawn).
  if (v.side === "buy" && v.form && v.form.via === "eth" && !same(pin.quote, WETH)) {
    const d = pin.drawn && pin.drawn.key === drawnKey(v.form, v.curve, pin.from) ? pin.drawn : null;
    const clamped = !!((v.q && v.q.clamped) || v.minIsPrice);
    const changed = d ? d.via !== v.via : v.via === "aero";
    if (changed && (!d || (v.steps || 1) > d.steps || clamped || d.clamped || v.min < d.min ||
                    (d.via === "aero" && v.aeroUnread))) {
      throw new Error(ROUTE_CHANGED);
    }
    // AND THE ROUTE SHOWN IS SENT AT NO LOWER A MINIMUM THAN IT SHOWED.
    v = floorAtDrawn(v, d);
  }
  if (v.via === "router") return curveTradeViaRouter(pin, v);
  if (v.via === "aero") return curveBuyViaAerodrome(pin, v);
  if (v.via === "eth") return curveBuyWithEth(pin, v);
  const { side, amount, min, curve } = v;

  // THE BALANCE IS STILL READ - as a CHECK, not as the answer. It is read
  // through the pinned endpoint on both sides of the send, which is also what
  // proves this action never follows the form to another deployment mid-flight.
  const outToken = side === "buy" ? pin.token : pin.quote;
  const balanceOfPinned = (t) => pin.call(t, SEL.balanceOf + pad32(pin.from)).then((r) => wordToBig(words(r)[0]));
  const before = await balanceOfPinned(outToken);

  let receipt;
  if (side === "buy") {
    // HELD FIRST - wrapped from ETH on the WETH pair, unless WETH itself was
    // chosen - THEN APPROVED.
    if (v.wethOnly) await ensureHeld(pin, pin.quote, amount, 18, "WETH", "This buy", "Choose ETH to pay with ether instead.");
    else await ensureQuoteHeld(pin, amount, "This buy", "action");
    await ensureAllowance(pin, pin.quote, curve, amount, `${fmt(amount, pin.quoteDecimals, 6)} ${pin.quoteSym} to the curve`);
    receipt = await send(pin, {
      to: curve,
      data: SEL.buy + amount.toString(16).padStart(64, "0") + min.toString(16).padStart(64, "0") + pad32(pin.from),
    }, "buy on the curve");
  } else {
    // THE TOKENS ARE HELD BEFORE THE APPROVAL IS PAID FOR, as the quote asset
    // is on a buy (ensureQuoteHeld). A sale of more than the account holds used
    // to cost an approval and then fail, leaving the allowance standing
    // (round 5, N20).
    await ensureHeld(pin, pin.token, amount, 18, "tokens", "This sale");
    await ensureAllowance(pin, pin.token, curve, amount, `${fmt(amount, 18, 6)} tokens to the curve`);
    receipt = await send(pin, {
      to: curve,
      data: SEL.sell + amount.toString(16).padStart(64, "0") + min.toString(16).padStart(64, "0") + pad32(pin.from),
    }, "sell to the curve");
  }

  await report(receipt, async () => {
    // FROM THE CURVE'S OWN EVENT, not from a balance either side of the send.
    // The curve states what it moved and what it charged; a balance difference
    // states what happened to the account, which is not the same question.
    const ev = logsOf(receipt, curve, side === "buy" ? TOPIC.curveBuy : TOPIC.curveSell)[0];
    if (!ev) {
      show("ok", `Done, but this transaction carries no ${side === "buy" ? "CurveBuy" : "CurveSell"} event, ` +
        `so there is nothing to report from it. Its hash is in your wallet's activity.`);
      return;
    }
    const [inAmt, outAmt, fee, tax] = words(ev.data).slice(0, 4).map(wordToBig);
    // WHAT A SWAP LEFT HELD, SPENT HERE, is no longer held (Buy with it).
    if (side === "buy") spendHeld(pin, inAmt);
    const outDec = side === "buy" ? 18 : pin.quoteDecimals;
    const unit = side === "buy" ? "tokens" : pin.quoteSym;
    const refundLog = logsOf(receipt, curve, TOPIC.curveRefund)[0];
    const refund = refundLog ? wordToBig(words(refundLog.data)[0]) : 0n;

    // AND THE TWO ARE COMPARED. Equal is the ordinary case and says nothing worth
    // a line. Unequal means this token moved for some other reason while the
    // trade was in flight, and THAT is worth saying - to whoever is reading a
    // balance and assuming it describes what they just did.
    const moved = (await balanceOfPinned(outToken)) - before;
    const drift = moved !== outAmt
      ? ` Your balance of it moved by ${amt(moved, outDec, unit)} over the same period, which is not the same ` +
        `number: something else moved this token too. The figures above are this transaction's.`
      : "";

    // ON THE WETH PAIR, WHAT THE CURVE PAID IN WETH BECOMES ETHER - measured
    // above first, so the drift check compares this transaction with itself.
    // NOT WHEN WETH WAS CHOSEN: then WETH is what was asked for, and it stays.
    const paidWeth = v.wethOnly ? 0n : side === "sell" ? outAmt : refund;
    const u = await unwrapPaid(pin, paidWeth, side === "sell" ? "this sale paid" : "this buy refunded");

    const sym = await launchSym(pin);
    const payUnit = same(pin.quote, WETH) && !v.wethOnly ? "ETH" : pin.quoteSym;
    showDone(side === "buy"
      ? wentCame(inAmt, pin.quoteDecimals, payUnit, outAmt, 18, sym)
      : wentCame(inAmt, 18, sym, outAmt, pin.quoteDecimals, payUnit), receipt,
      `Done. The curve gave you ${amt(outAmt, outDec, unit)} for ` +
      `${amt(inAmt, side === "buy" ? pin.quoteDecimals : 18, side === "buy" ? pin.quoteSym : "tokens")}` +
      `, charging ${amt(fee, pin.quoteDecimals, pin.quoteSym)} fee and ` +
      `${amt(tax, pin.quoteDecimals, pin.quoteSym)} ${taxName(pin.view)} — both on the ${pin.quoteSym} side, in either direction.` +
      (refund > 0n
        ? ` It could not spend all of what you offered and refunded ${amt(refund, pin.quoteDecimals, pin.quoteSym)}.`
        : "") + drift + unwrapWords(u, same(pin.quote, WETH) ? paidWeth : 0n) +
      exactly([["in", inAmt], ["out", outAmt], ["fee", fee], ["tax", tax]]
        .concat(refund > 0n ? [["refund", refund]] : [])
        .concat(u.unwrapped > 0n ? [["unwrapped", u.unwrapped]] : [])));
  });
}

/// A CURVE TRADE THROUGH THE CURB ROUTER: one transaction.
///   buy   buyWithEth with the ETH typed: the router wraps it, swaps it along
///         the priced path (none on the WETH pair), buys on the curve for this
///         account, and pays back anything the curve refunds.
///   sale  sellForEth: the router pulls the tokens, sells them, swaps the
///         proceeds into WETH and pays ETH. The tokens move only with an
///         allowance to the router - asked ONCE per token and without a limit
///         (the owner's call), so every later sale of it is one confirmation.
/// The bounds are the ones computeCurveQuote just priced, and a sale is priced
/// again after its approval. Every send is simulated first and reported from
/// the router's own event.
async function curveTradeViaRouter(pin, v) {
  const weth = same(pin.quote, WETH);
  if (v.side === "buy") {
    if (!(v.min > 0n) || (!weth && !(v.midMin > 0n))) {
      throw new Error("This buy has no floor under it, and the router refuses that. Nothing was sent.");
    }
    const eth = BigInt(await pin.read("eth_getBalance", [pin.from, "latest"]));
    if (eth < v.amount) {
      throw new Error(`This buy pays ${fmt(v.amount, 18, 6)} ETH, and this account holds ${fmt(eth, 18, 6)} ETH. Nothing was sent.`);
    }
    const data = SEL.routerBuy + encode(
      [T.address, T.address, T.bytes, T.uint(256), T.uint(256), T.address, T.uint(256)],
      [pin.registry, pin.token, v.path, v.midMin, v.min, pin.from, await chainDeadline(pin)]).slice(2);
    const tx = { to: CURB_ROUTER.address, data, value: "0x" + v.amount.toString(16) };
    await simulateRouter(pin, tx, "this buy");
    await routerStillThere(pin, "this buy");
    const held = await heldBefore(pin);
    const receipt = await send(pin, tx, `buy with ${fmt(v.amount, 18, 6)} ETH through the CURB router (1 confirmation)`);
    await report(receipt, async () => reportRouterBuy(pin, v, receipt, await heldAfter(held), await launchSym(pin)));
    return;
  }

  // THE SALE. The tokens are held before anything is approved (ensureHeld), and
  // the router's code is read again before the approval to it is asked for.
  await ensureHeld(pin, pin.token, v.amount, 18, "tokens", "This sale");
  await routerStillThere(pin, "the approval for this sale");
  const approved = await ensureRouterAllowance(pin, v.amount);
  try {
    let s = v;
    if (approved) {
      // PRICED AGAIN FOR WHAT WAS PRESSED: the approval took a confirmation's
      // worth of time, and others may have traded meanwhile.
      s = await computeCurveQuote(pin, v.form);
      if (s.error) throw new Error(s.error);
      const unchecked = convUncheckedRefusal(s, pin.quoteSym);
      if (unchecked) throw new Error(unchecked);
      if (s.via !== "router" || s.side !== "sell" || s.amount !== v.amount) {
        throw new Error("it no longer prices the same way. Press Sell again.");
      }
    }
    if (!(s.min > 0n) || !(s.ethMin > 0n)) {
      throw new Error("This sale has no floor under it, and the router refuses that. Nothing was sent.");
    }
    const data = SEL.routerSell + encode(
      [T.address, T.address, T.uint(256), T.uint(256), T.bytes, T.uint(256), T.address, T.uint(256)],
      [pin.registry, pin.token, s.amount, s.min, s.path, s.ethMin, pin.from, await chainDeadline(pin)]).slice(2);
    const tx = { to: CURB_ROUTER.address, data };
    await simulateRouter(pin, tx, "this sale");
    await routerStillThere(pin, "this sale");
    const held = await heldBefore(pin);
    const receipt = await send(pin, tx, `sell ${fmt(s.amount, 18, 6)} tokens for ETH through the CURB router`);
    await report(receipt, async () => reportRouterSale(pin, s, receipt, await heldAfter(held), await launchSym(pin)));
  } catch (e) {
    if (!approved) throw e;
    // THE APPROVAL WAS SENT AND MINED, AND IT STANDS. Whatever stopped the sale
    // after it - a decline in the wallet, a refusal in the simulation, a price
    // that moved - "Nothing was sent" would not be true, and the allowance is
    // the one thing the docs promise to be plain about.
    throw Object.assign(new Error(afterRouterApproval(e)), { declined: !!(e && e.declined) });
  }
}

/// WHAT A SALE THAT STOPPED AFTER ITS APPROVAL SAYS: the allowance that now
/// stands, how to take it back, and then why the sale itself was not made.
function afterRouterApproval(e) {
  // THE ROUTER GONE BETWEEN THE APPROVAL AND THE SALE says its own reason,
  // not routerStillThere's sentence with "Nothing was sent" cut out of it.
  const why = e && e.routerGone && e.why ? e.why : String(e && e.message ? e.message : e)
    .replace(/^Nothing was sent: /, "")
    .replace(/\s*Nothing (more |else )?was sent\.?/g, "")
    .replace(/\s*You can try again\.?/g, "")
    .trim();
  return "The CURB router may now sell this token for you: an allowance with no limit, kept for your next sale " +
    "(revoke it by setting it to 0). The sale itself was not made: " + (/[.!?]$/.test(why) ? why : why + ".") +
    " Nothing else was sent" + (e && e.routerGone
      ? "; the quote now takes the way the page used before the router."
      : "; pressing Sell again asks only for the sale.");
}

/// THE ROUTER'S CODE, READ AGAIN FROM THE CHAIN IMMEDIATELY BEFORE A SEND THAT
/// NEEDS IT - never the verdict a quote kept. A call to an address with no code
/// succeeds, so a router that is gone (a fork reset under the same URL, a code
/// change) would take the ETH and do nothing, and the simulation before the
/// send cannot tell. The answer is kept, so the next quote takes the longer way.
async function routerStillThere(pin, what) {
  const ready = await routerReady(pin, true);
  if (!ready.ok) {
    throw Object.assign(new Error(`${what.charAt(0).toUpperCase() + what.slice(1)} was not sent: ${ready.why}. ` +
      `Nothing was sent; the quote now takes the way the page used before the router.`), { routerGone: true, why: ready.why });
  }
}

/// TEN MINUTES FROM THE CHAIN'S OWN CLOCK, which is the one the router compares
/// against (block.timestamp). The wall clock is the same on Base, but not on a
/// fork that stands still, nor on a machine whose clock is off - there a
/// deadline built from it was weeks long or already past.
async function chainDeadline(pin) {
  const b = await pin.read("eth_getBlockByNumber", ["latest", false]);
  if (!b || !b.timestamp) throw new Error("The chain's time could not be read to set the deadline. Nothing was sent.");
  return BigInt(b.timestamp) + 600n;
}

/// THE ROUTER'S ALLOWANCE FOR THIS TOKEN: ONCE, AND WITHOUT A LIMIT. The only
/// unlimited approval this page asks for (the owner's call, 2026-10-01). It is
/// acceptable because of what the router is: no owner, no storage, and it
/// pulls tokens only from msg.sender inside that caller's own sellForEth call -
/// nobody else can make it spend them. Revoked like any allowance, by approving
/// it for 0. Every other approval on this page stays exact (ensureAllowance).
/// @return whether an approval was sent
async function ensureRouterAllowance(pin, amount) {
  const read = async () => {
    const w = words(await pin.call(pin.token, SEL.allowance + pad32(pin.from) + pad32(CURB_ROUTER.address)));
    if (!w.length) throw new Error("The token would not say what the router may move. Nothing was sent.");
    return wordToBig(w[0]);
  };
  if ((await read()) >= amount) return false;
  await send(pin, { to: pin.token, data: SEL.approve + pad32(CURB_ROUTER.address) + MAX_UINT.toString(16) },
    "let the CURB router sell this token for you - asked once for this token, with no limit (1 of 2 confirmations)");
  if ((await read()) < amount) {
    // A STOP AFTER THE APPROVAL MINED, worded like every other one: the
    // allowance stands, how to take it back, and why the sale was not made.
    throw new Error(afterRouterApproval(new Error("the endpoint does not show the approval yet")));
  }
  return true;
}

/// THE ROUTER'S EVENT FOR THIS TRADE: from the router, about this account and
/// this token. Its words after the indexed three.
function routerEventOf(receipt, topic0, pin) {
  const ev = logsOf(receipt, CURB_ROUTER.address, topic0).find((l) => l.topics.length > 2 &&
    same(wordToAddress(l.topics[1].slice(2)), pin.from) && same(wordToAddress(l.topics[2].slice(2)), pin.token));
  return ev ? words(ev.data) : null;
}

/// A ROUTER TRANSACTION THAT MINED WITHOUT THE ROUTER'S EVENT did not trade
/// through the router, whatever else it did - said as the error it is.
function noRouterEvent(receipt, name) {
  show("err", `This transaction was mined, but it carries no ${name} event from the CURB router, so it is not a ` +
    `trade through the router and this page cannot say what it did. Look it up in your wallet's activity: ` +
    `<code>${escapeHtml((receipt && receipt.transactionHash) || "")}</code>.`);
}

/// WHETHER A REFUND THE ROUTER PAID CAME AS WETH. _payEth sends WETH when the
/// account will not take ether (a contract wallet), and BoughtWithEth does not
/// say which: the WETH Transfer from the router to this account, for exactly
/// that amount, does. (A Withdrawal of the amount happens either way.)
const refundCameAsWeth = (receipt, pin, amount) => amount > 0n &&
  logsOf(receipt, WETH, TOPIC.transfer).some((l) => l.topics.length > 2 &&
    same(wordToAddress(l.topics[1].slice(2)), CURB_ROUTER.address) &&
    same(wordToAddress(l.topics[2].slice(2)), pin.from) && wordToBig(words(l.data)[0]) === amount);

/// A BUY THROUGH THE ROUTER, AS ITS BoughtWithEth SAYS: what was paid, what the
/// swap delivered, what the curve gave, and what came back - none of it from
/// the quote. The curve's own CurveBuy adds the fee and the tax it charged.
function reportRouterBuy(pin, v, receipt, held, sym = "tokens") {
  const w = routerEventOf(receipt, TOPIC.routerBought, pin);
  if (!w || w.length < 6) return noRouterEvent(receipt, "BoughtWithEth");
  const [ethIn, quoteIn, tokensOut, quoteRefund, ethRefund] = w.slice(1, 6).map(wordToBig);
  const weth = same(pin.quote, WETH);
  const unitQ = (x) => amt(x, pin.quoteDecimals, escapeHtml(pin.quoteSym));
  const cb = logsOf(receipt, v.curve, TOPIC.curveBuy)[0];
  const [, , fee, tax] = cb ? words(cb.data).slice(0, 4).map(wordToBig) : [null, null, null, null];
  const asWeth = refundCameAsWeth(receipt, pin, ethRefund);
  showDone(wentCame(asWeth ? ethIn : ethIn - ethRefund, 18, "ETH", tokensOut, 18, sym,
    (asWeth && ethRefund > 0n ? `+${brief(ethRefund, 18)} WETH back ` : "") +
    (quoteRefund > 0n ? `+${brief(quoteRefund, pin.quoteDecimals)} ${escapeHtml(pin.quoteSym)} back` : "")), receipt,
    `Done, in one transaction through the CURB router. You paid ${amt(ethIn, 18, "ETH")}` +
    (weth ? "" : `; the route (${escapeHtml(routeWords(v.route, pin.quoteSym, true))}) delivered ${unitQ(quoteIn)}`) +
    `, and the curve gave you ${amt(tokensOut, 18, "tokens")}` +
    (fee !== null ? `, charging ${unitQ(fee)} fee and ${unitQ(tax)} ${taxName(pin.view)}` : "") + "." +
    (ethRefund > 0n
      ? ` It could not spend all of it, and ${amt(ethRefund, 18, asWeth ? "WETH" : "ETH")} came back to you in the same ` +
        `transaction` + (asWeth ? " - as WETH, because this account would not take ether." : ".")
      : "") +
    (quoteRefund > 0n ? ` It could not spend all of it, and ${unitQ(quoteRefund)} came back to you in the same transaction; it stays in your wallet.` : "") +
    tokenDrift(held, tokensOut) +
    exactly([["paid", ethIn], ["into the curve", quoteIn], ["out", tokensOut]]
      .concat(fee !== null ? [["fee", fee], ["tax", tax]] : [])
      .concat(quoteRefund > 0n ? [["refund", quoteRefund]] : [])
      .concat(ethRefund > 0n ? [[asWeth ? "WETH refund" : "ETH refund", ethRefund]] : [])));
}

/// A SALE THROUGH THE ROUTER, AS ITS SoldForEth SAYS: what was sold, what the
/// curve paid, and the ETH that reached this account - as WETH when the account
/// would not take ether. The curve's own CurveSell adds the fee and the tax it
/// charged, as it does for a buy (reportRouterBuy) and as the sale paid in the
/// pair's asset says them: the router's event does not carry them, and a sale
/// for ETH is the default one.
function reportRouterSale(pin, s, receipt, held, sym = "tokens") {
  const w = routerEventOf(receipt, TOPIC.routerSold, pin);
  if (!w || w.length < 5) return noRouterEvent(receipt, "SoldForEth");
  const [tokensIn, quoteOut, ethOut] = w.slice(1, 4).map(wordToBig);
  const asWeth = wordToBig(w[4]) !== 0n;
  const weth = same(pin.quote, WETH);
  const unitQ = (x) => amt(x, pin.quoteDecimals, escapeHtml(pin.quoteSym));
  const cs = logsOf(receipt, s.curve, TOPIC.curveSell)[0];
  const [, , fee, tax] = cs ? words(cs.data).slice(0, 4).map(wordToBig) : [null, null, null, null];
  showDone(wentCame(tokensIn, 18, sym, ethOut, 18, asWeth ? "WETH" : "ETH"), receipt,
    `Done, in one transaction through the CURB router. You sold ${amt(tokensIn, 18, "tokens")}` +
    `; the curve paid ${unitQ(quoteOut)}` +
    (fee !== null
      ? `, charging ${unitQ(fee)} fee and ${unitQ(tax)} ${taxName(pin.view)} — both on the ${escapeHtml(pin.quoteSym)} side, in either direction`
      : "") +
    (weth ? (asWeth ? "" : ", and the router unwrapped it into ETH")
      : `, and the route (${escapeHtml(routeWords(s.route, pin.quoteSym, false))}) turned it into ETH`) +
    `. You received ${amt(ethOut, 18, asWeth ? "WETH" : "ETH")}` +
    (asWeth ? " - as WETH, because this account would not take ether." : ".") +
    tokenDrift(held, -tokensIn) +
    exactly([["sold", tokensIn], ["curve paid", quoteOut]]
      .concat(fee !== null ? [["fee", fee], ["tax", tax]] : [])
      .concat([["received", ethOut]])));
}

/// THE LAUNCH TOKEN'S BALANCE, read through the pinned endpoint on both sides
/// of a router trade - as a CHECK, as curveActionInner reads the balance of
/// what a direct trade pays out. The ETH side cannot be checked this way (gas
/// moves it too); the token side can, and a router trade moves it by exactly
/// what the router's event says.
const launchBalancePinned = (pin) =>
  pin.call(pin.token, SEL.balanceOf + pad32(pin.from)).then((r) => wordToBig(words(r)[0]));
async function heldBefore(pin) {
  try { return { pin, before: await launchBalancePinned(pin) }; } catch { return null; }
}
/// Said only when the balance moved by another number than this trade's: then
/// something else moved this token while it was in flight, and whoever reads
/// the balance as what they just did should know. Either read failing says
/// nothing, rather than a difference that is not there.
function tokenDrift(held, expected) {
  // A BALANCE OF NOTHING IS A BALANCE: 0n after a sale of all of it is read.
  if (!held || held.after === null || held.after === undefined) return "";
  const moved = held.after - held.before;
  if (moved === expected) return "";
  const said = moved < 0n ? "-" + fmt(-moved, 18, 6) : fmt(moved, 18, 6);
  return ` Your balance of this token moved by <strong title="exact: ${moved.toString()}">${escapeHtml(said)}</strong> ` +
    `tokens over the same period, which is not the same number: something else moved this token too. ` +
    `The figures above are this transaction's.`;
}
async function heldAfter(held) {
  if (!held) return held;
  try { held.after = await launchBalancePinned(held.pin); } catch { held.after = null; }
  return held;
}

/// A CURVE BUY PAID IN ETH IN TWO STEPS, ON A PAIR WHOSE ASSET IS NOT WETH. The
/// curve takes only its own asset, so the ETH is swapped into it first - each
/// step its own send, pinned, recorded and waited for:
///   1. the swap, delivered to this account and bounded below: on Aerodrome
///      (curveBuyViaAerodrome) or through the UniversalRouter (curveBuyWithEth);
///   2. the curve bought with EXACTLY what arrived (buyCurveWithArrived).
/// If step 2 does not happen, the swap has: the account holds the asset, the
/// page says so and keeps saying so across reloads (the swap's record, kind
/// "eth-swap"), and offers Buy with it and Sell it back.

/// The record a two-step buy's swap carries beside the usual fields.
const ethSwapExtra = (pin, v, venue, path) => ({
  venue, asset: pin.quote, assetSym: pin.quoteSym, assetDecimals: pin.quoteDecimals, curve: v.curve,
  ethIn: "0x" + v.amount.toString(16), minOut: "0x" + v.midMin.toString(16), path,
});

/// ETH FOR THE BUY AND FOR THE SENDS AFTER IT. A two-step buy that spends all
/// the ETH on its swap cannot pay for the approval and the buy, and leaves the
/// asset held: so what step 1 pays, plus twice the gas of the whole thing at
/// the price now, never less than token.js's GAS_KEEP.
async function twoStepEthCheck(pin, v) {
  const [balHex, priceHex] = await Promise.all([
    pin.read("eth_getBalance", [pin.from, "latest"]), pin.read("eth_gasPrice", []),
  ]);
  const eth = BigInt(balHex);
  const byGas = 2n * BigInt(priceHex) * TWO_STEP_GAS;
  const keep = byGas > TWO_STEP_ETH_KEEP ? byGas : TWO_STEP_ETH_KEEP;
  if (eth < v.amount + keep) {
    throw new Error(`This buy pays ${fmt(v.amount, 18, 6)} ETH and its later steps need gas; this account holds ` +
      `${fmt(eth, 18, 6)} ETH. Nothing was sent.`);
  }
}

/// STEP 1, SENT AND WAITED FOR. A receipt that does not come within the wait
/// leaves the record (it blocks trades of this launch until the chain settles
/// it) and is said as what it is.
async function sendStepOne(pin, tx, what, extra) {
  try {
    return await send(pin, tx, what, "eth-swap", true, extra);
  } catch (e) {
    if (e && e.message === "timed out") {
      throw new Error("The swap was sent but is not mined yet; its hash is in your wallet's activity. Nothing more " +
        "was sent. Once it is mined, this page shows what it delivered, to buy with it or sell it back.");
    }
    throw e;
  }
}

/// WHAT STEP 1 DELIVERED: its own Transfer logs to this account, capped by the
/// balance READ AT ITS OWN BLOCK - an endpoint behind that block errors rather
/// than answering low. One retry a second later.
/// @return { credits, bal, received } - bal null when it could not be read.
async function arrivedFrom(pin, receipt) {
  const credits = creditsTo(receipt, pin.quote, pin.from).reduce((a, b) => a + b, 0n);
  let bal = null;
  for (let i = 0; i < 2 && bal === null; i++) {
    if (i) await new Promise((r) => setTimeout(r, 1000));
    try {
      const w = words(await pin.read("eth_call",
        [{ to: pin.quote, data: SEL.balanceOf + pad32(pin.from) }, receipt.blockNumber]));
      bal = w.length ? wordToBig(w[0]) : null;
    } catch { bal = null; }
  }
  return { credits, bal, received: bal !== null && bal < credits ? bal : credits };
}

/// THE BUTTONS THAT GO WITH WHAT A SWAP LEFT HELD, carrying the amount and the
/// asset, so they work even where the record could not be stored.
function heldButtons(asset, amount) {
  const a = escapeHtml(String(asset));
  const n = escapeHtml(amount.toString());
  return ` <button type="button" class="ghost" data-held-buy="${n}" data-held-asset="${a}">Buy with it</button>` +
    (aeroRows(asset)
      ? ` <button type="button" class="ghost" data-held-sell="${n}" data-held-asset="${a}">Sell it back</button>` : "");
}

/// A REFUSAL'S OWN WORDS WITHOUT "Nothing was sent" - something was.
const withoutNothingSent = (e) => String(typeof e === "string" ? e : e && e.message ? e.message : e)
  .replace(/^Nothing was sent: /, "")
  .replace(/\s*Nothing (more |else )?was sent\.?/g, "")
  .replace(/\s*You can try again\.?/g, "")
  .trim();

/// THE SWAP WENT THROUGH AND THE BUY DID NOT: said as that, with the way on.
function heldError(pin, amount, e, approved) {
  const why = withoutNothingSent(e);
  const r = `${fmt(amount, pin.quoteDecimals, 6)} ${pin.quoteSym}`;
  const text = `The swap went through: you hold ${r}. The buy was not made: ${/[.!?]$/.test(why) ? why : why + "."}` +
    (approved ? ` The curve's approval for exactly ${r} stands; Buy with it uses it.` : "");
  return Object.assign(new Error(text), { html: escapeHtml(text) + heldButtons(pin.quote, amount), held: amount });
}

/// THE SWAP WENT THROUGH AND THE BUY WAS SENT, OR MAY HAVE BEEN, WITHOUT BEING
/// SEEN MINED: not "not made", and no Buy with it or Sell it back for what it
/// is about to spend. Its record settles it once the chain does (settleRecord).
function stepTwoUnsettled(pin, amount, e) {
  const r = `${fmt(amount, pin.quoteDecimals, 6)} ${pin.quoteSym}`;
  return new Error(e && e.uncertain
    ? `The swap went through: you hold ${r}. ${e.message}`
    : `The swap went through and delivered ${r}. The curve buy with it was sent but is not mined yet; its hash is ` +
      `in your wallet's activity. Once it is mined, this page shows what is left of it.`);
}

/// THE CURVE'S OWN REFUSALS OF A BUY, for step 2's simulation
/// (PonsV2BondingCurve's errors; PolicyForbids is a B20's).
function curveRefusal(e, sym) {
  const issuer = () => `the issuer of ${sym} refused a transfer it needs.`;
  return revertSentence(e, {
    [sig("SlippageExceeded(uint256,uint256)")]: () => "the curve's price moved past your slippage since the swap.",
    [sig("CurveGraduated()")]: () => "the curve is no longer selling.",
    [sig("MinimumOutputRequired()")]: () => "it has no floor.",
    [sig("TransferFailed()")]: issuer,
    "0xa43fec12": issuer,
  });
}

/// STEP 2'S FLOOR: never worse than the card showed. Step 1 is public, so
/// anyone who sees it can push the curve before step 2 - and taking the
/// slippage off the curve as it is then would follow them. Keyed on the
/// CARD's clamp: a card whose minimum was a price (a clamped buy) has it scaled
/// to what arrived; an amount stays an amount. The curve checks spent * min <=
/// received * tokensOut, so either way the fill is held to the card's price.
function stepTwoFloor(v, received, q2, bps) {
  const card = v.minIsPrice ? (v.min * received + v.minBasis - 1n) / v.minBasis : v.min;
  const own = buyMin(q2, bps);
  return own > card ? own : card;
}

/// STEP 2, SHARED BY BOTH TWO-STEP ROUTES: the curve bought with exactly what
/// arrived - its status, the issuer's graduation questions and its prices read
/// again, an exact approval when the allowance is short, and the buy simulated
/// before the wallet is asked.
/// @param st  { approved } is set once step 2's approval was sent; { unsettled }
///            when the buy itself went to the wallet and was not seen mined.
/// @return { receipt, refund }
async function buyCurveWithArrived(pin, v, received, st) {
  const sym = pin.quoteSym;
  const view2 = await readLaunchWith(pin, pin.token);
  if (view2.status !== 1) throw new Error("the curve is no longer selling");
  const stuck = await graduationBlocked(pin, v.curve, pin.graduator, true);
  if (stuck) throw new Error(stuck);
  const [feeW, taxW, sellW, resW] = await Promise.all([
    pin.call(v.curve, SEL.feeBps), pin.call(v.curve, SEL.creatorTaxBps),
    pin.call(v.curve, SEL.sellableTokens), pin.call(v.curve, SEL.getReserves),
  ]);
  const res = words(resW);
  if (res.length < 2) throw new Error("the curve would not report its reserves");
  const q2 = quoteBuy(received, { quote: wordToBig(res[0]), token: wordToBig(res[1]) },
    { fee: wordToBig(words(feeW)[0]), tax: wordToBig(words(taxW)[0]) }, wordToBig(words(sellW)[0]));
  if (q2.unpriceable || q2.out === 0n) throw new Error("the curve cannot price a buy of what arrived");
  const min2 = stepTwoFloor(v, received, q2, Math.round(v.slip * 100));
  const r = `${fmt(received, pin.quoteDecimals, 6)} ${sym}`;
  st.approved = await ensureAllowance(pin, pin.quote, v.curve, received, `${r} to the curve`);
  const data = SEL.buy + received.toString(16).padStart(64, "0") + min2.toString(16).padStart(64, "0") + pad32(pin.from);
  try {
    await pin.read("eth_call", [{ from: pin.from, to: v.curve, data }, "latest"]);
  } catch (e) {
    if (!isRevert(e)) {
      throw new Error(`the buy could not be checked before asking your wallet (${e && e.message ? e.message : String(e)})`);
    }
    throw new Error(curveRefusal(e, sym));
  }
  // THE RECORD SAYS WHAT IT SPENDS, so one that mines after this page stopped
  // waiting for it still takes what it spent off the swap's (settleRecord).
  let receipt;
  try {
    receipt = await send(pin, { to: v.curve, data },
      `buy on the curve with the ${r} the swap delivered (step 2 of 2)`, "action", false,
      { spendsHeld: true, asset: pin.quote });
  } catch (e) {
    // SENT, OR MAYBE SENT, AND NOT SEEN MINED: not a buy that was not made.
    st.unsettled = !!(e && (e.sent || e.uncertain));
    throw e;
  }
  const refundLog = logsOf(receipt, v.curve, TOPIC.curveRefund)[0];
  return { receipt, refund: refundLog ? wordToBig(words(refundLog.data)[0]) : 0n, q2 };
}

/// AFTER STEP 1, BOTH ROUTES: what arrived, kept as held; step 2; and the
/// report. Any stop after step 1 is the held message.
async function finishTwoStep(pin, v, swap, venue) {
  const sym = pin.quoteSym;
  const record = swap.record;
  const { credits, bal, received } = await arrivedFrom(pin, swap);
  if (credits === 0n) {
    TX.clearPending(record);
    throw new Error(`The swap was mined but delivered no ${sym} to this account. Its hash is in your wallet's activity.`);
  }
  TX.updatePending(record, { held: received.toString(), heldAt: Date.now(), heldBlock: swap.blockNumber });
  if (bal === null) throw heldError(pin, received, "what arrived could not be read just now", false);
  const st = { approved: false, unsettled: false };
  let out;
  try {
    out = await buyCurveWithArrived(pin, v, received, st);
  } catch (e) {
    throw st.unsettled ? stepTwoUnsettled(pin, received, e) : heldError(pin, received, e, st.approved);
  }
  // A REFUND PAST THE THRESHOLD IS THE ASSET, AND IT IS HELD like what step 1
  // left: Sell it back is offered for it.
  if (out.refund > 0n) {
    TX.updatePending(record, { held: out.refund.toString(), heldAt: Date.now(), heldBlock: out.receipt.blockNumber });
  } else {
    TX.clearPending(record);
  }
  const buy = out.receipt;
  const unitEth = (x) => amt(x, 18, "ETH");
  const unitQ = (x) => amt(x, pin.quoteDecimals, escapeHtml(sym));
  // WHAT AERODROME'S ROUTER DID NOT WRAP, it refunded (refundETH): the wrap is
  // WETH's own Deposit to the router, in step 1's receipt.
  const wrapped = venue === "aerodrome"
    ? logsOf(swap, WETH, TOPIC.wethDeposit)
      .filter((l) => l.topics.length > 1 && same(wordToAddress(l.topics[1].slice(2)), AERODROME.router.address))
      .map((l) => wordToBig(words(l.data)[0])).reduce((a, b) => a + b, 0n)
    : v.amount;
  const ethBack = v.amount > wrapped ? v.amount - wrapped : 0n;
  await report(buy, async () => {
    const ev = logsOf(buy, v.curve, TOPIC.curveBuy)[0];
    const [inAmt, outAmt, fee, tax] = ev ? words(ev.data).slice(0, 4).map(wordToBig) : [received, out.q2.out, 0n, 0n];
    const refund = out.refund;
    const route = escapeHtml(routeWords(v.route, sym, true));
    showDone(wentCame(v.amount - ethBack, 18, "ETH", outAmt, 18, await launchSym(pin),
      refund > 0n ? `+${brief(refund, pin.quoteDecimals)} ${escapeHtml(sym)} back` : ""), buy,
      `Done. You paid ${unitEth(v.amount)}; ` +
      (venue === "aerodrome" ? `on Aerodrome the route (${route})` : `the route (${route})`) +
      ` delivered ${unitQ(received)}, and the curve gave you ${amt(outAmt, 18, "tokens")} for it, charging ` +
      `${unitQ(fee)} fee and ${unitQ(tax)} ${taxName(pin.view)}.` +
      (ethBack > 0n ? ` Aerodrome's router sent back ${unitEth(ethBack)} it did not use.` : "") +
      (refund > 0n
        ? ` The curve refunded ${unitQ(refund)} past the threshold; it stays in your wallet, and ` +
          (aeroRows(pin.quote) ? "Sell it back is offered below." : "Buy with it is offered below.")
        : "") +
      exactly([["paid", v.amount], ["swapped", received], ["in", inAmt], ["out", outAmt], ["fee", fee], ["tax", tax]]
        .concat(refund > 0n ? [["refund", refund]] : [])
        .concat(ethBack > 0n ? [["ETH back", ethBack]] : [])));
  });
}

/// THE AERODROME ROUTE (AERODROME): step 1 sends the ETH as value to its pinned
/// SwapRouter - no approval - along a frozen AERO_PATHS row, to this account,
/// bounded by the slippage off the pinned quoter's answer; then step 2.
async function curveBuyViaAerodrome(pin, v) {
  if (!(v.midMin > 0n) || !(v.min > 0n)) throw new Error("This buy has no floor under it. Nothing was sent.");
  // THE PATH IS A ROW OF THE TABLE, FROM WETH TO THIS PAIR'S ASSET - as bytes,
  // not as whatever the quote carried.
  const rows = aeroRows(pin.quote) || [];
  const path = String(v.path || "").toLowerCase();
  const row = rows.find((hops) => aeroPathBytes(hops, true) === path);
  if (!row || !path.startsWith(WETH.toLowerCase()) || !path.endsWith(pin.quote.toLowerCase().replace(/^0x/, ""))) {
    throw new Error("The swap's route is not one this page knows for " + pin.quoteSym + ". Nothing was sent.");
  }
  await twoStepEthCheck(pin, v);
  const tx = { to: AERODROME.router.address, value: "0x" + v.amount.toString(16),
    data: aeroBuyData(path, pin.from, await chainDeadline(pin), v.amount, v.midMin) };
  await simulateAero(pin, tx, "the swap");
  const sent = await withGasRoom(pin, tx);
  await aeroStillThere(pin);
  const swap = await sendStepOne(pin, sent,
    `swap ${fmt(v.amount, 18, 6)} ETH into ${pin.quoteSym} on Aerodrome (step 1 of 2: then the curve buy)`,
    ethSwapExtra(pin, v, "aerodrome", path));
  await finishTwoStep(pin, v, swap, "aerodrome");
}

/// THE UNIVERSALROUTER TWO-STEP, where the CURB router cannot be used and
/// Aerodrome is not taken: step 1 wraps the ETH and swaps it along the v3 route
/// that was priced, out to this account, bounded below; then step 2.
async function curveBuyWithEth(pin, v) {
  await twoStepEthCheck(pin, v);
  const path = v3PathBytes(v.route, true);
  const commands = "0x" + CMD.wrapEth + CMD.v3SwapExactIn;
  const inputs = [
    encode([T.address, T.uint(256)], [ADDRESS_THIS, v.amount]),
    encode([T.address, T.uint(256), T.uint(256), T.bytes, T.bool],
      [pin.from, CONTRACT_BALANCE, v.midMin, path, false]),
  ];
  const data = SEL.execute + encode([T.bytes, T.array(T.bytes), T.uint(256)],
    [commands, inputs, await chainDeadline(pin)]).slice(2);
  const swap = await sendStepOne(pin, { to: ROUTER, data, value: "0x" + v.amount.toString(16) },
    `swap ${fmt(v.amount, 18, 6)} ETH into ${pin.quoteSym} (step 1 of 2: then the curve buy)`,
    ethSwapExtra(pin, v, "uniswap", path));
  await finishTwoStep(pin, v, swap, "uniswap");
}

// ---------------------------------------------------------------- what a swap left held
/// THIS ACCOUNT'S SWAPS FOR ONE LAUNCH THAT LEFT THE ASSET HELD, oldest first.
const heldRecordsOf = (chainId, from, lens, token) => TX.loadPendingAll()
  .filter((t) => t.page === APP_MARK && t.kind === "eth-swap" && t.held && sameChainId(t.chainId, chainId) &&
    same(t.from, from) && same(t.lens, lens) && same(t.token, token))
  .sort((a, b) => (a.sentAt || 0) - (b.sentAt || 0));
const heldSum = (recs) => recs.reduce((a, t) => { try { return a + BigInt(t.held); } catch { return a; } }, 0n);

/// The launch on screen's (App.heldSwaps).
function heldSwaps() {
  if (!account || chainIdShown === null) return [];
  return heldRecordsOf(chainIdShown, account, chainCfg.lens, chainCfg.token);
}

/// The newest block any of these records' amounts was read at.
const newestHeldBlock = (recs) =>
  recs.reduce((m, t) => { try { const b = BigInt(t.heldBlock); return b > m ? b : m; } catch { return m; } }, 0n);

/// WHAT THIS ACCOUNT STILL HOLDS FROM SWAPS FOR THE PINNED LAUNCH, capped by its
/// balance read through the pin - AT A BLOCK AT OR AFTER EVERY RECORD'S, as the
/// held row reads it (renderHeld). Read at "latest", an endpoint whose backend
/// was still behind the swap answered the balance from before it, 0, and a
/// second step 1 went out on that. A balance that cannot be read, or an
/// endpoint behind the swap, leaves the records' sum: refusing a second swap
/// on it is the safe side.
async function heldFor(pin) {
  const recs = heldRecordsOf(pin.chainId, pin.from, pin.lens, pin.token);
  const sum = heldSum(recs);
  if (sum === 0n) return 0n;
  try {
    const n = await pin.read("eth_blockNumber", []);
    if (BigInt(n) < newestHeldBlock(recs)) return sum;
    const w = words(await pin.read("eth_call", [{ to: pin.quote, data: SEL.balanceOf + pad32(pin.from) }, n]));
    if (w.length && wordToBig(w[0]) < sum) return wordToBig(w[0]);
  } catch { /* the sum stands */ }
  return sum;
}

/// KNOWN SPENDS OF WHAT IS HELD - a curve buy paid in the asset, a sell-back,
/// step 2 - taken off the records, oldest first; a record brought to 0 is
/// cleared.
function spendHeld(pin, spent) {
  spendHeldOf(pin.chainId, pin.from, pin.lens, pin.token, spent);
}
function spendHeldOf(chainId, from, lens, token, spent) {
  let left = spent;
  for (const t of heldRecordsOf(chainId, from, lens, token)) {
    if (left <= 0n) break;
    const h = BigInt(t.held);
    if (h <= left) { TX.clearPending(t); left -= h; } else { TX.updatePending(t, { held: (h - left).toString() }); left = 0n; }
  }
}

/// WHAT A TRANSACTION TOOK OF `token` FROM `who`, net: its transfers out of the
/// account less those back to it - a curve buy past the threshold pulls what
/// it was offered and refunds the rest.
function netSpent(receipt, token, who) {
  let out = 0n;
  for (const l of logsOf(receipt, token, TOPIC.transfer)) {
    if (l.topics.length < 3) continue;
    const amount = wordToBig(words(l.data)[0]);
    if (same(wordToAddress(l.topics[1].slice(2)), who)) out += amount;
    if (same(wordToAddress(l.topics[2].slice(2)), who)) out -= amount;
  }
  return out;
}

/// THE HELD ROW, on the swap card (#tvHeld) and the long page (#heldRow):
/// what this account holds from swaps for the launch on screen, with Buy with
/// it, Sell it back (AERO_PATHS assets) and Dismiss. The amount is the records'
/// sum, capped by the balance read DIRECTLY at the node's block - and only at a
/// block at or after every record's: an endpoint behind that shows the records'
/// amount, and a balance of 0 there clears them (the asset left by other means).
let heldSeq = 0;
let heldShown = null;   // { amount, asset } as last drawn
async function renderHeld() {
  const boxes = ["tvHeld", "heldRow"].map((id) => $(id)).filter(Boolean);
  if (!boxes.length) return;
  const mine = ++heldSeq;
  const hide = () => { heldShown = null; for (const b of boxes) { b.hidden = true; b.innerHTML = ""; } };
  const recs = heldSwaps();
  if (!recs.length || !ctx) return hide();
  const asset = recs[0].asset;
  const sym = recs[0].assetSym || ctx.quoteSym;
  const decimals = Number(recs[0].assetDecimals);
  let amount = heldSum(recs);
  try {
    const n = await rpc("eth_blockNumber", []);
    if (BigInt(n) >= newestHeldBlock(recs)) {
      const w = words(await rpcAt(chainCfg.rpc, "eth_call", [{ to: asset, data: SEL.balanceOf + pad32(account) }, n]));
      if (w.length) {
        const bal = wordToBig(w[0]);
        if (bal === 0n) {
          if (mine !== heldSeq) return;
          for (const t of recs) TX.clearPending(t);
          return hide();
        }
        if (bal < amount) amount = bal;
      }
    }
  } catch { /* the records' amount stands */ }
  if (mine !== heldSeq) return;
  heldShown = { amount, asset };
  const a = escapeHtml(asset);
  const html = `<span>You hold ${escapeHtml(fmt(amount, decimals, 6))} ${escapeHtml(sym)} from a swap.</span>` +
    heldButtons(asset, amount) +
    ` <button type="button" class="ghost" data-held-dismiss="${a}">Dismiss</button>`;
  for (const b of boxes) { b.innerHTML = html; b.hidden = false; }
}

/// BUY WITH IT: nothing is sent. The swap card - or the long page's curve or
/// pool form - is set to pay with the asset, for what is held, and priced.
function buyWithHeld(carried, asset) {
  if (!ctx || !same(asset, ctx.quote)) return;
  const recs = heldSwaps();
  const amount = recs.length && heldShown && same(heldShown.asset, asset) ? heldShown.amount : carried;
  // TO THE LAST UNIT, not at the % buttons' eight places: on an 18-decimal
  // asset those left a remainder held, a "You hold 0" row, and ETH buys
  // refused for it.
  const text = plainUnits(amount, ctx.quoteDecimals);
  if (TOKEN_VIEW) {
    document.dispatchEvent(new CustomEvent("curb:buyWithHeld", { detail: { text } }));
    return;
  }
  if (view && view.status === 3) {
    $("poolSide").value = "buy";
    $("poolVia").value = "nvdac";
    $("poolAmount").value = text;
    renderPoolQuote();
    return;
  }
  $("curveSide").value = "buy";
  if ($("curveVia")) $("curveVia").value = "quote";
  $("curveAmount").value = text;
  renderCurveQuote();
}

/// SELL IT BACK: what is held, sold for ETH on Aerodrome along a reversed
/// AERO_PATHS row - an EXACT approval to its router for the amount sold, the
/// swap into WETH held by the router and unwrapWETH9 to this account, bounded
/// below, simulated, and checked against Chainlink like any swap.
async function sellHeldBack(slipText, carried) {
  const pin = await beginAction("trade");
  return withSendLock(pin, () => sellHeldBackInner(pin, slipText, carried));
}
async function sellHeldBackInner(pin, slipText, carried) {
  const sym = pin.quoteSym;
  const rows = aeroRows(pin.quote);
  if (!rows) throw new Error(`Selling ${sym} back on Aerodrome is not offered here. Nothing was sent.`);
  const slip = Number(slipText);
  if (!slipText || !isFinite(slip) || slip < 0 || slip > 100) {
    throw new Error("Slippage must be a percentage between 0 and 100. Nothing was sent.");
  }
  const bps = Math.round(slip * 100);
  const recs = heldRecordsOf(pin.chainId, pin.from, pin.lens, pin.token);
  const want = recs.length ? heldSum(recs) : carried;
  const bw = words(await pin.call(pin.quote, SEL.balanceOf + pad32(pin.from)));
  if (!bw.length) throw new Error(`${sym} would not say what this account holds. Nothing was sent.`);
  const bal = wordToBig(bw[0]);
  const amount = want < bal ? want : bal;
  if (!(amount > 0n)) throw new Error(`This account holds no ${sym} from the swap to sell back. Nothing was sent.`);
  const standing = await buyerStanding(pin, true);
  if (standing.blocked) throw new Error(restrictedTrade(sym, standing.blocked));
  if (standing.listed) throw new Error(blacklistedTrade(sym));
  const ready = await aeroReady(pin, true);
  if (!ready.ok) throw new Error(`Selling it back was not sent: ${ready.why}. Nothing was sent.`);
  const r = `${fmt(amount, pin.quoteDecimals, 6)} ${sym}`;
  const priceBack = async () => {
    const quoted = await Promise.all(rows.map(async (hops) => {
      const path = aeroPathBytes(hops, false);
      return { ...(await askQuoter(pin, AERODROME.quoter.address, path, hops.length, amount)), hops, path };
    }));
    const leg = legOf(quoted);
    if (leg.unread) throw new Error(`Selling ${sym} back could not be priced just now. Nothing was sent.`);
    if (leg.partial || !(leg.out > 0n)) throw new Error(`Aerodrome cannot take ${r} back in full. Nothing was sent.`);
    const minWeth = withSlippage(leg.out, bps);
    if (!(minWeth > 0n)) {
      throw new Error(`At ${slip}% slippage selling it back would have no floor at all. Lower the slippage. Nothing was sent.`);
    }
    const c = await withConversion(pin, { side: "sell", via: "aero-back", ethOut: leg.out, mid: amount });
    if (c.error) throw new Error(c.error);
    const unchecked = convUncheckedRefusal(c, sym);
    if (unchecked) throw new Error(unchecked);
    return { leg, minWeth };
  };
  let priced = await priceBack();
  await aeroStillThere(pin);
  const approved = await ensureAllowance(pin, pin.quote, AERODROME.router.address, amount,
    `${r} to Aerodrome's router, to sell it back`);
  try {
    // PRICED AGAIN after an approval: it took a confirmation's worth of time.
    if (approved) priced = await priceBack();
    const tx = { to: AERODROME.router.address,
      data: aeroSellData(priced.leg.path, await chainDeadline(pin), amount, priced.minWeth, pin.from) };
    await simulateAero(pin, tx, "selling it back");
    const sent = await withGasRoom(pin, tx);
    await aeroStillThere(pin);
    // THE RECORD SAYS WHAT IT SPENDS (settleRecord), as step 2's does.
    let receipt;
    try {
      receipt = await send(pin, sent, `sell ${r} back for ETH on Aerodrome`, "action", false,
        { spendsHeld: true, asset: pin.quote });
    } catch (e) {
      // SENT, OR MAYBE SENT, AND NOT SEEN MINED: not a sale that was not made,
      // and no Revoke for an allowance it is about to use.
      if (e && e.sent) {
        throw Object.assign(new Error(`The sale of ${r} was sent but is not mined yet; its hash is in your wallet's ` +
          `activity. Once it is mined, this page shows what is left of it.`), { unsettled: true });
      }
      if (e && e.uncertain) throw Object.assign(e, { unsettled: true });
      throw e;
    }
    spendHeld(pin, amount);
    await report(receipt, async () => {
      const eth = logsOf(receipt, WETH, TOPIC.wethWithdrawal)
        .filter((l) => l.topics.length > 1 && same(wordToAddress(l.topics[1].slice(2)), AERODROME.router.address))
        .map((l) => wordToBig(words(l.data)[0])).reduce((a, b) => a + b, 0n);
      showDone(wentCame(amount, pin.quoteDecimals, sym, eth, 18, "ETH"), receipt,
        `Sold ${amt(amount, pin.quoteDecimals, escapeHtml(sym))} for ${amt(eth, 18, "ETH")} on Aerodrome.` +
        exactly([["sold", amount], ["received", eth]]));
    });
  } catch (e) {
    if (!approved || (e && e.unsettled)) throw e;
    // THE APPROVAL WAS SENT AND MINED, AND IT STANDS - for exactly what was to
    // be sold, and only Aerodrome's router may use it, inside a swap of this
    // account's own. Said, with the way to take it back.
    const why = withoutNothingSent(e);
    const text = `Aerodrome's router may now move exactly ${r} for you. The sale was not made: ` +
      `${/[.!?]$/.test(why) ? why.replace(/[.!?]$/, "") : why}. Nothing else was sent.`;
    throw Object.assign(new Error(text), { html: escapeHtml(text) +
      ` <button type="button" class="ghost" data-held-revoke="${escapeHtml(pin.quote)}">Revoke</button>` });
  }
}

/// REVOKE: Aerodrome's router's allowance for this launch's asset, set to 0.
async function revokeAero(asset) {
  const pin = await beginAction("trade");
  if (!same(asset, pin.quote)) throw new Error("That allowance is for another asset than this launch's. Nothing was sent.");
  return withSendLock(pin, async () => {
    await send(pin, { to: pin.quote, data: SEL.approve + pad32(AERODROME.router.address) + pad32Num(0) },
      `set Aerodrome's router's allowance for your ${pin.quoteSym} to 0`);
    show("ok", `Revoked: Aerodrome's router may no longer move your ${escapeHtml(pin.quoteSym)}.`);
  });
}

/// DISMISS: the records go; the asset stays in the wallet.
function dismissHeld() {
  for (const t of heldSwaps()) TX.clearPending(t);
  renderHeld();
}

/// WHAT THIS ACCOUNT IS OWED IN THIS FACTORY'S ASSET, and from where.
///
/// NOTHING A LAUNCH EARNS ARRIVES BY ITSELF. A curve's fees stay IN THE CURVE
/// until its creator sweeps them or it graduates, and only then reach the
/// factory's escrow. On a WETH pool the hook keeps both legs of every swap in
/// its own ledger, because paying ether means calling the payee while the pool
/// manager is unlocked; on other pools a leg waits there only when its payee
/// could not be paid - an issuer block, most often. Escrow and hook release on
/// a claim, the curve on a sweep.
/// @param v  the launch refresh() has just drawn, or null for "no launch yet":
///           the curve row belongs to THAT launch and no other. It used to read
///           the global `view` before refresh() had re-read the launch, and
///           showed the previous launch's fees beside the new one.
/// HOW MANY OWED RENDERS ARE STILL OUT. refresh() fires one without awaiting
/// it; the browser tests wait for this to reach 0 before they hold a read, so
/// the read they hold is the refresh's own and not a late one of that render's
/// (they ask the issuer the same questions).
let owedPending = 0;
async function renderOwed(v) {
  owedPending += 1;
  try { return await renderOwedInner(v); } finally { owedPending -= 1; }
}
async function renderOwedInner(v) {
  // ONLY THE NEWEST RENDER WRITES. refresh() fires one without a launch early
  // and one for the drawn launch at its end; the first could land last and hide
  // the curve row and the Sweep button of the launch on screen (round 4, S25).
  const mine = (renderOwed.seq = (renderOwed.seq || 0) + 1);
  const box = $("owedBox");
  if (!box) return;
  if (!account || !ctx) { box.hidden = true; return; }
  const who = account;
  const here = ctx;
  // ONE CONTEXT FOR EVERYTHING BELOW. The escrow was resolved from the form's
  // factory and the balances keyed by the context's asset, so a factory change
  // mid-refresh could draw one asset's escrow against another's.
  const f = here.factory;
  let fromEscrow = null;
  let fromHook = null;
  let escrow = null;
  try {
    escrow = oneAddress(await call(f, SEL.feeEscrow), "The factory's feeEscrow()");
    const w = words(await call(escrow, SEL.escrowBalanceOf + pad32(who) + pad32(here.quote)));
    fromEscrow = w.length ? wordToBig(w[0]) : null;
  } catch { fromEscrow = null; }
  try {
    const w = words(await call(here.hook, SEL.hookOwed + pad32(who) + pad32(here.quote)));
    fromHook = w.length ? wordToBig(w[0]) : null;
  } catch { fromHook = null; }
  // WHAT THE ISSUER SAYS ABOUT EACH CLAIM, as claimFeesInner asks it: this
  // account receiving, and each payer sending (round 5, N19).
  const [viaEscrow, viaHook] = await Promise.all([
    claimStanding(here.quote, escrow, who, call),
    claimStanding(here.quote, here.hook, who, call),
  ]);
  // THE LOADED LAUNCH'S CURVE, if it is still on one and in this asset: what
  // it holds for this account and has not swept yet. Only the curve's creator
  // (its deployer) can sweep; the platform's share also leaves at graduation.
  let onCurve = null;
  let canSweep = false;
  if (v && (v.status === 1 || v.status === 2) && isAddr(v.curve) && same(v.quoteToken, here.quote)) {
    try {
      const [dep, plat, tax, fee] = await Promise.all([
        call(v.curve, SEL.curveDeployer), call(v.curve, SEL.curveProtocolRecipient),
        call(v.curve, SEL.creatorTaxBalance), call(v.curve, SEL.quoteFeeBalance),
      ]);
      const isCreator = same(wordToAddress(words(dep)[0]), who);
      const isPlatform = same(wordToAddress(words(plat)[0]), who);
      const creatorPart = isCreator ? wordToBig(words(tax)[0]) : 0n;
      const platformPart = isPlatform ? wordToBig(words(fee)[0]) : 0n;
      if (isCreator || isPlatform) onCurve = creatorPart + platformPart;
      canSweep = isCreator && (wordToBig(words(tax)[0]) + wordToBig(words(fee)[0])) > 0n;
    } catch { onCurve = null; canSweep = false; }
  }
  // The form moved on while these were being read: they are about something else.
  if (!same(who, account) || !same(f, chainCfg.factory) || here !== ctx || (v && v !== view) ||
      mine !== renderOwed.seq) return;

  // NOTHING ON THE CURVE, NO ROW. The row came back as "0" after the refresh
  // that follows a sweep, and the test that said it was hidden passed only by
  // catching a moment before that refresh landed (round 4, S10). Kept when the
  // creator could still sweep someone else's part.
  const showRow = onCurve !== null && (onCurve > 0n || canSweep);
  // WHETHER ANYTHING IS OWED AT ALL: a claim or a sweep with something in it.
  // In production the panel is shown only then (initFeesPanel); on a fork the
  // box shows its zeros, as it always has.
  box.dataset.owed = showRow || [fromEscrow, fromHook].some((x) => x !== null && x > 0n) ? "1" : "";
  box.hidden = false;
  const said = (x) => (x === null ? "could not be read" : fmt(x, here.quoteDecimals, 6) + " " + here.quoteSym);
  $("owedEscrow").textContent = said(fromEscrow);
  $("owedHook").textContent = said(fromHook);
  // NEVER ENABLED WHILE AN ACTION RUNS. This render is fired without being
  // awaited, so it can land in the middle of a claim and re-enable its button -
  // letting a second click through, and letting the page look finished while
  // it is not. guard() redraws when the action ends.
  // AND NOT FOR A CLAIM THE ISSUER REFUSES: one to an account it will not let
  // receive the asset - the very reason a hook debt exists - or from a payer it
  // will not let send it. Only those two sides; an account frozen for sending
  // alone can still be paid (round 5, N19).
  const restricted = viaEscrow.claimantBlocked || viaHook.claimantBlocked;
  $("claimEscrow").disabled = busy || restricted || viaEscrow.payerBlocked ||
    !(fromEscrow !== null && fromEscrow > 0n);
  $("claimHook").disabled = busy || restricted || viaHook.payerBlocked || !(fromHook !== null && fromHook > 0n);
  if ($("owedCurveRow")) {
    $("owedCurveRow").hidden = !showRow;
    $("owedCurve").textContent = onCurve === null ? "\u2014" : said(onCurve);
    $("sweepCurve").hidden = !showRow;
    $("sweepCurve").disabled = busy || !canSweep;
  }
  const payerLine = (viaEscrow.payerBlocked ? ["fee escrow"] : []).concat(viaHook.payerBlocked ? ["fee hook"] : []);
  const curveLine = (restricted
    ? "The issuer has restricted this account, so a claim - a transfer to it - would revert; what is owed " +
      "stays owed until the block is lifted. "
    : "") +
    (payerLine.length
      ? "The issuer blocks the " + payerLine.join(" and the ") + " from sending " + here.quoteSym + ", so a claim " +
        "from " + (payerLine.length > 1 ? "either" : "it") + " would revert until that block is lifted. "
      : "") +
    "A curve's fees stay in the curve until its creator sweeps them to the escrow, or the " +
    "launch graduates; then they are claimed from the escrow.";
  $("owedNote").textContent = same(here.quote, WETH)
    ? curveLine + " Owed in WETH and paid as ETH when you claim; an address that refuses ether gets WETH " +
      "instead of a failed claim. On an ETH pair every pool fee waits in the hook until it is claimed."
    : curveLine + " A pool fee waits in the hook only when it could not be paid to you directly, most " +
      "often because the issuer blocked the transfer.";
}

/// THE CREATOR MOVES THEIR CURVE'S FEES INTO THE ESCROW. sweepFees is gated on
/// the curve's deployer - the creator - and moves both buckets, the platform's
/// and theirs. Pinned like a trade: the curve is the one the registry names.
async function sweepCurveFees() {
  const pin = await beginAction("trade");
  return withSendLock(pin, () => sweepCurveFeesInner(pin));
}

async function sweepCurveFeesInner(pin) {
  if (pin.view.status !== 1 && pin.view.status !== 2) throw new Error("Only a launch still on its curve has fees there to sweep.");
  const dep = wordToAddress(words(await pin.call(pin.view.curve, SEL.curveDeployer))[0]);
  if (!same(dep, pin.from)) {
    throw new Error("Only this launch's creator (" + dep + ") can sweep its curve's fees; they also move at graduation.");
  }
  // NOTHING ON THE CURVE, NOTHING SENT. The curve does not revert on an empty
  // sweep, so the transaction would succeed, move nothing, and be reported as
  // having moved fees; the buttons are briefly enabled after any action.
  const [taxW, feeW] = await Promise.all([
    pin.call(pin.view.curve, SEL.creatorTaxBalance), pin.call(pin.view.curve, SEL.quoteFeeBalance),
  ]);
  const pending = wordToBig(words(taxW)[0] || "0") + wordToBig(words(feeW)[0] || "0");
  if (pending === 0n) throw new Error("Nothing on this curve to sweep. Nothing was sent.");
  // SIMULATED FIRST, as a graduation is. The sweep credits the escrow - a
  // transfer INTO it - and an issuer that has blocked the escrow reverts that,
  // so the button used to cost a reverted transaction with no word about the
  // way out (round 5, N21). A revert refuses and names the rescue; a reply that
  // is not a revert (a rate limit, a dropped connection) refuses as unchecked.
  try {
    await pin.read("eth_call", [{ from: pin.from, to: pin.view.curve, data: SEL.sweepFees + "0".repeat(64) }, "latest"]);
  } catch (e) {
    const why = e && e.message ? e.message : String(e);
    if (!isRevert(e)) {
      throw new Error("Whether sweeping would succeed could not be checked: " + why + ". Nothing was sent - try again.");
    }
    throw new Error(
      "Sweeping would revert: " + why + ". If the issuer has blocked the fee escrow, the fees cannot pass " +
      "through it: the graduator's rescueCurveFees pays them straight to their recipients instead. Its " +
      "creator-fee recipient or the platform's recipient may send it at any time; anyone else only once the " +
      "curve is full and has sat unmoved for an hour after being noted stuck. This page offers it (\"Rescue the " +
      "curve's fees\") once the launch has reached its threshold, when \"Complete the move\" finds that the move " +
      "would revert. Nothing was sent.");
  }
  const receipt = await send(pin, { to: pin.view.curve, data: SEL.sweepFees + "0".repeat(64) },
    "sweep this launch's curve fees to the escrow");
  showDone(doneHead("Fees swept", "Ready to claim"), receipt,
    `Swept in <code>${escapeHtml(receipt.transactionHash)}</code>. The fees are in the escrow now: ` +
    `"Claim curve fees" takes yours.`);
  await renderOwed();
}

async function claimFees(from) {
  const pin = await beginAction("claim");
  return withSendLock(pin, () => claimFeesInner(pin, from));
}

/// @param from  "escrow" for the curve's fees, "hook" for the pool's.
async function claimFeesInner(pin, from) {
  // BOTH ADDRESSES FROM THE PINNED FACTORY, like everything else a send uses:
  // the escrow is the factory's, the hook is its registry's.
  const to = from === "escrow"
    ? oneAddress(await pin.call(pin.factory, SEL.feeEscrow), "The factory's feeEscrow()")
    : pin.hook;
  const data = (from === "escrow" ? SEL.escrowClaim : SEL.hookClaim) + pad32(pin.quote);
  const what = from === "escrow" ? "claim your curve fees" : "claim your pool fees";
  // NOTHING OWED, NOTHING SENT. Both contracts revert on a zero claim, and the
  // buttons are briefly enabled after any action until the panel redraws.
  const owedNow = words(await pin.call(to, (from === "escrow" ? SEL.escrowBalanceOf : SEL.hookOwed) +
    pad32(pin.from) + pad32(pin.quote)));
  if (!owedNow.length || wordToBig(owedNow[0]) === 0n) {
    throw new Error("Nothing is owed to this account there in " + pin.quoteSym + ". Nothing was sent.");
  }
  // A CLAIM IS A TRANSFER FROM THE ESCROW OR THE HOOK TO THIS ACCOUNT, which a
  // restricting issuer refuses on either end: this account receiving, or the
  // payer sending. Only those two sides - see policyAllows.
  const standing = await claimStanding(pin.quote, to, pin.from, (t, d) => pin.call(t, d));
  if (standing.claimantBlocked) {
    throw new Error(
      "The issuer of " + pin.quoteSym + " has restricted this account, so the claim would revert. What is owed " +
      "stays owed until the block is lifted. Nothing was sent.");
  }
  if (standing.payerBlocked) {
    throw new Error(
      "The issuer of " + pin.quoteSym + " blocks the " + (from === "escrow" ? "fee escrow" : "fee hook") + " at " + to +
      " from sending it (policy " + standing.payerPolicy + "), so the claim would revert. What is owed stays owed " +
      "there until the issuer lifts that block. Nothing was sent.");
  }
  const receipt = await send(pin, { to, data }, what, "claim");
  showDone(doneHead("Claimed", `<strong>${brief(wordToBig(owedNow[0]), pin.quoteDecimals)} ${escapeHtml(same(pin.quote, WETH) ? "ETH" : pin.quoteSym)}</strong>`), receipt,
    `Claimed in <code>${escapeHtml(receipt.transactionHash)}</code>. ` +
    (same(pin.quote, WETH)
      ? "It was paid as ETH, or as WETH if your address would not take ether."
      : `It was paid in ${escapeHtml(pin.quoteSym)}.`));
  await renderOwed();
}

/// EVERYTHING THIS ACCOUNT CAN TAKE, IN ONE PRESS (the owner's call: one Claim,
/// not a button per contract). The fees live in up to three places - the
/// launch's curve until its creator sweeps them, the factory's escrow, and the
/// hook - so the press walks them in that order: the curve swept into the
/// escrow when this account is its creator and something waits there, then the
/// escrow, then the hook, each only when it holds something and each its own
/// send, checked by the same code the separate buttons use.
async function claimAll() {
  const pin = await beginAction("trade");
  return withSendLock(pin, async () => {
    const owed = async (to, sel) => {
      const w = words(await pin.call(to, sel + pad32(pin.from) + pad32(pin.quote)));
      return w.length ? wordToBig(w[0]) : 0n;
    };
    let swept = false;
    if (pin.view.status === 1 || pin.view.status === 2) {
      const dep = wordToAddress(words(await pin.call(pin.view.curve, SEL.curveDeployer))[0]);
      if (same(dep, pin.from)) {
        const [taxW, feeW] = await Promise.all([
          pin.call(pin.view.curve, SEL.creatorTaxBalance), pin.call(pin.view.curve, SEL.quoteFeeBalance),
        ]);
        if (wordToBig(words(taxW)[0] || "0") + wordToBig(words(feeW)[0] || "0") > 0n) {
          await sweepCurveFeesInner(pin);
          swept = true;
        }
      }
    }
    const escrow = oneAddress(await pin.call(pin.factory, SEL.feeEscrow), "The factory's feeEscrow()");
    const fromEscrow = await owed(escrow, SEL.escrowBalanceOf);
    if (fromEscrow > 0n) await claimFeesInner(pin, "escrow");
    const fromHook = await owed(pin.hook, SEL.hookOwed);
    if (fromHook > 0n) await claimFeesInner(pin, "hook");
    if (!swept && fromEscrow === 0n && fromHook === 0n) {
      throw new Error(`Nothing is waiting for this account in ${pin.quoteSym}. Nothing was sent.`);
    }
    const unit = same(pin.quote, WETH) ? "ETH" : pin.quoteSym;
    showDone(doneHead("Claimed", `<strong>${brief(fromEscrow + fromHook, pin.quoteDecimals)} ${escapeHtml(unit)}</strong>`), null, `Claimed ${amt(fromEscrow + fromHook, pin.quoteDecimals, escapeHtml(unit))}` +
      (swept ? ", with this launch's curve fees swept in first" : "") + "." +
      (same(pin.quote, WETH) ? " Paid as ETH, or as WETH to an address that will not take ether." : "") +
      exactly([["escrow", fromEscrow], ["hook", fromHook]]));
    await renderOwed();
  });
}

async function completeGraduation() {
  const pin = await beginAction("trade");
  return withSendLock(pin, () => completeGraduationInner(pin));
}

async function completeGraduationInner(pin) {
  if (!pin.graduator) throw new Error("the graduator address is not known");
  // A LAUNCH ALREADY IN ITS POOL HAS NO MOVE TO COMPLETE - the chain's status,
  // as beginAction read it, like the curve's and the pool's own checks. One
  // that somebody else moved since the page drew it Waiting used to reach the
  // simulation below, whose revert was then offered the rescue: the box opened
  // and the sentence blamed a blocked escrow, for a launch already trading in
  // its pool (round 5, N18). Graduated is the only status a Waiting draw can
  // find besides Waiting itself - a launch never goes back to its curve - so a
  // selling one is left to the simulation, which reverts for it truly.
  if (pin.view.status === 3) {
    throw new Error("This launch has already completed its move into the pool since the page drew it. " +
      "Nothing was sent. Refresh, and trade it there.");
  }
  // SIMULATED FIRST. A graduation that must revert - most often because the
  // issuer has blocked the fee escrow, so the sweep inside graduate() fails -
  // used to be sent anyway, with no word about the one way out.
  try {
    await pin.read("eth_call", [{ from: pin.from, to: pin.graduator, data: SEL.graduate + pad32(pin.token) }, "latest"]);
  } catch (e) {
    // A REVERT IS A STATEMENT ABOUT THIS LAUNCH; A DROPPED REPLY IS NOT. The
    // box used to open on any failure, a network error included, and then
    // offered a rescue for a launch nothing had shown to be stuck (round 5,
    // S22). rpcAt marks what the node itself answered - and a node answers a
    // rate limit ("over rate limit", -32016) or its own trouble in the same
    // shape, so only an answer that IS a revert counts: code 3, which carries
    // revert data, or a message that says it reverted.
    const reverted = isRevert(e);
    if (!reverted) {
      throw new Error(
        "Whether completing the move would succeed could not be checked: " + (e && e.message ? e.message : String(e)) +
        ". Nothing was sent - try again.");
    }
    // AND IT IS FILED UNDER THIS LAUNCH, so the next one loaded does not show
    // it - and it opens only while that launch is still the one on screen: the
    // form can move while the simulation is out.
    rescueFor = { token: pin.token, factory: pin.factory, rpc: pin.rpc };
    const onScreen = same(pin.token, chainCfg.token) && same(pin.factory, chainCfg.factory) && pin.rpc === chainCfg.rpc;
    if ($("rescueBox") && onScreen) $("rescueBox").hidden = false;
    throw new Error(
      "Completing the move would revert: " + revertSentence(e, GRADUATOR_REFUSALS) + " If the issuer has " +
      "blocked the fee escrow, \"Rescue the curve's fees\" below pays them straight to their recipients - its " +
      "creator-fee recipient and the platform's recipient may send it now, anyone else an hour after the launch " +
      "is noted stuck (the first press notes it) - and the move can then complete. Nothing was sent.");
  }
  const receipt = await send(pin, { to: pin.graduator, data: SEL.graduate + pad32(pin.token) },
    "complete the move into the pool");
  showDone(doneHead("Graduated", "Trading in the pool now"), receipt,
    `The launch graduated in <code>${escapeHtml(receipt.transactionHash)}</code>, ` +
    `using ${parseInt(receipt.gasUsed, 16).toLocaleString("en-US")} gas. ` +
    `Anyone could have sent this, and the sender gets nothing for it.`);
}

/// THE EXIT FOR A CURVE WHOSE ESCROW THE ISSUER HAS BLOCKED. Graduator.
/// rescueCurveFees pays the curve's fees straight to their fixed recipients
/// instead of through the escrow, which unblocks graduate(). This page offers
/// it only for a launch Waiting (status 2), the only time pending fees block
/// anything. The curve's creator-fee recipient (its deployer(), read live) and
/// the platform's recipient may send it at any time. ANYONE ELSE ONLY AN HOUR
/// AFTER THE LAUNCH WAS NOTED STUCK (Graduator.noteReady, RescueNotOpenYet):
/// a buyer who fills a curve can starve its graduation, so "full" alone is not
/// "stuck", and a stranger must not force a creator's fees out as raw WETH to
/// a contract that takes only ETH. So for anyone else the first press NOTES
/// the launch - its own transaction, said as such - and says when the rescue
/// opens; a press after that hour rescues. The caller chooses nothing but the
/// launch.
async function rescueFees() {
  const pin = await beginAction("trade");
  return withSendLock(pin, async () => {
    if (pin.view.status !== 2) throw new Error("Only a launch waiting to complete its move needs this.");
    const data = SEL.rescueCurveFees + pad32(pin.token);
    // SIMULATED FIRST, as the move is: a rescue that must revert says why in
    // the graduator's words, and is not sent.
    try {
      await pin.read("eth_call", [{ from: pin.from, to: pin.graduator, data }, "latest"]);
    } catch (e) {
      if (!isRevert(e)) {
        throw new Error("Whether rescuing the fees would succeed could not be checked: " +
          (e && e.message ? e.message : String(e)) + ". Nothing was sent - try again.");
      }
      // NOBODY HAS NOTED IT YET: the note is what this press sends instead.
      const raw = revertData(e).toLowerCase();
      const ws = raw.startsWith(sig("RescueNotOpenYet(address,uint256)")) ? words("0x" + raw.slice(10)) : [];
      if (ws.length >= 2 && wordToBig(ws[1]) === 0n) return noteStuck(pin);
      throw new Error("Rescuing the curve's fees would revert: " + revertSentence(e, GRADUATOR_REFUSALS) +
        " Nothing was sent.");
    }
    const receipt = await send(pin, { to: pin.graduator, data }, "rescue this curve's fees");
    hideRescue();
    showDone(doneHead("Fees rescued", "Complete the move now"), receipt,
      `Rescued in <code>${escapeHtml(receipt.transactionHash)}</code>: the curve's fees were paid to their ` +
      `recipients directly. Complete the move now.`);
  });
}

/// THE NOTE THAT STARTS THE RESCUE'S HOUR (Graduator.noteReady), sent by
/// rescueFees for an account the rescue is not open to yet, when nobody has
/// noted the launch. Simulated first like every send here; and the hour is
/// read back from the graduator after the receipt - its note and its own
/// RESCUE_DELAY - so the time said is the chain's, not this page's sum.
async function noteStuck(pin) {
  const data = SEL.noteReady + pad32(pin.token);
  try {
    await pin.read("eth_call", [{ from: pin.from, to: pin.graduator, data }, "latest"]);
  } catch (e) {
    if (!isRevert(e)) {
      throw new Error("Whether noting this launch stuck would succeed could not be checked: " +
        (e && e.message ? e.message : String(e)) + ". Nothing was sent - try again.");
    }
    throw new Error("Noting this launch stuck would revert: " + revertSentence(e, GRADUATOR_REFUSALS) +
      " Nothing was sent.");
  }
  const receipt = await send(pin, { to: pin.graduator, data },
    "note this launch as stuck, which opens the rescue of its fees to anyone an hour from now");
  let when = "an hour after this note";
  try {
    const [since, delay] = await Promise.all([
      pin.call(pin.graduator, SEL.readySince + pad32(pin.token)).then((r) => wordToBig(words(r)[0] || "0")),
      pin.call(pin.graduator, SEL.rescueDelay).then((r) => wordToBig(words(r)[0] || "0")),
    ]);
    if (since > 0n && delay > 0n) when = utcMinute(since + delay);
  } catch { /* the sentence below says it without the time */ }
  showDone(doneHead("Noted as stuck", "The rescue opens later"), receipt,
    `Noted in <code>${escapeHtml(receipt.transactionHash)}</code>. Nothing was rescued yet: anyone may rescue ` +
    `this curve's fees from ${escapeHtml(when)} if the move has still not completed by then - press "Rescue the ` +
    `curve's fees" again then. Its creator-fee recipient and the platform's recipient may rescue them now, and ` +
    `anyone may complete the move whenever it stops reverting.`);
}

async function poolAction() {
  const pin = await beginAction("trade");
  return withSendLock(pin, () => poolActionInner(pin));
}

/// THE v4 LEG OF THE ETH ROUTE, as the deployed router's actions.
///
/// `settleFrom` is who pays the input: the ROUTER on a buy, where the NVDAc it
/// is about to spend came from the v3 leg, and the PERSON on a sell, where the
/// tokens are theirs and Permit2 moves them.
/// `takeTo` is who receives the output: the person on a buy, and the ROUTER on
/// a sell, because that NVDAc is the next leg's input and never theirs.
function v4Leg(pin, k, { zeroForOne, tokenIn, tokenOut, settleAmount, settleFromUser, takeTo, minOut }) {
  const actions = "0x" + ACT.settle + ACT.swapExactInSingle + ACT.take;
  const settle = encode([T.address, T.uint(256), T.bool], [tokenIn, settleAmount, settleFromUser]);
  const swap = encode(
    [T.tuple([T.tuple([T.address, T.address, T.uint(24), T.int(24), T.address]), T.bool, T.uint(128), T.uint(128), T.bytes])],
    [[[k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks], zeroForOne, OPEN_DELTA, minOut, "0x"]]
  );
  const take = encode([T.address, T.address, T.uint(256)], [tokenOut, takeTo, OPEN_DELTA]);
  // THE PARAMS ARE POSITIONAL: params[i] belongs to the i-th action byte.
  return encode([T.bytes, T.array(T.bytes)], [actions, [settle, swap, take]]);
}

/// The whole ETH route, in the order the router runs it.
///
/// Proved against the deployed router in test/fork/B20EthRoute.t.sol, including
/// that a failing second leg takes the first one back with it, and that the
/// minimum is measured against what ARRIVES rather than the NVDAc in between.
function ethRoute(pin, v, k) {
  // ONE COMMAND EITHER WAY. UniversalRouter's v3SwapExactIn takes a PACKED
  // PATH, so a two-hop route is a longer path and not a second command - the
  // whole thing still unwinds as one transaction if any leg fails.
  const path = (wethToQuote) => v3PathBytes(v.route, wethToQuote);
  // NO SWAP LEG WHEN THE QUOTE ASSET IS WETH. The wrap alone puts the router
  // in possession of exactly what the pool wants - see quoteV3.
  const direct = !!(v.route && v.route.direct);
  if (v.side === "buy") {
    const commands = direct
      ? "0x" + CMD.wrapEth + CMD.v4Swap + CMD.sweep
      : "0x" + CMD.wrapEth + CMD.v3SwapExactIn + CMD.v4Swap + CMD.sweep;
    const inputs = [
      encode([T.address, T.uint(256)], [ADDRESS_THIS, v.amount]),
      ...(direct ? [] : [encode([T.address, T.uint(256), T.uint(256), T.bytes, T.bool],
        [ADDRESS_THIS, v.amount, 0n, path(true), false])]),
      v4Leg(pin, k, {
        zeroForOne: v.zeroForOne, tokenIn: pin.quote, tokenOut: pin.token,
        settleAmount: CONTRACT_BALANCE, settleFromUser: false, takeTo: MSG_SENDER, minOut: v.min,
      }),
      encode([T.address, T.address, T.uint(256)], [pin.quote, MSG_SENDER, 0n]),
    ];
    return { commands, inputs, value: v.amount };
  }
  const commands = direct
    ? "0x" + CMD.v4Swap + CMD.unwrapWeth + CMD.sweep
    : "0x" + CMD.v4Swap + CMD.v3SwapExactIn + CMD.unwrapWeth + CMD.sweep;
  const inputs = [
    v4Leg(pin, k, {
      zeroForOne: v.zeroForOne, tokenIn: pin.token, tokenOut: pin.quote,
      settleAmount: v.amount, settleFromUser: true, takeTo: ADDRESS_THIS, minOut: 0n,
    }),
    ...(direct ? [] : [encode([T.address, T.uint(256), T.uint(256), T.bytes, T.bool],
      [ADDRESS_THIS, CONTRACT_BALANCE, 0n, path(false), false])]),
    // THE BOUND, on the ETH. Everything before it is plumbing.
    encode([T.address, T.uint(256)], [MSG_SENDER, v.min]),
    encode([T.address, T.address, T.uint(256)], [pin.quote, MSG_SENDER, 0n]),
  ];
  return { commands, inputs, value: 0n };
}

async function poolActionInner(pin) {
  // ONLY A GRADUATED LAUNCH HAS A POOL - the chain's status, as beginAction
  // read it - which is the curve's rule turned round (round 5, N18).
  if (pin.view.status !== 3) {
    throw new Error("This launch has not graduated, so it has no pool to trade in yet. Nothing was sent. " +
      "Refresh: " + (pin.view.status === 2 ? "it is waiting to complete its move." : "it trades on its curve."));
  }
  const v = await computePoolQuote(pin);
  if (v.error) throw new Error(v.error);
  // NOR AN ETH ROUTE WHOSE SWAP COULD NOT BE CHECKED (withConversion).
  const unchecked = convUncheckedRefusal(v, pin.quoteSym);
  if (unchecked) throw new Error(unchecked);
  // A MODEL MAY PREVIEW A TRADE. IT MAY NOT BOUND ONE.
  //
  // quotePoolSwap is exact only while this pool holds nothing but the launch's
  // own full-range position, and anybody may add a narrower one. The panel says
  // when it is showing that model; what it must not do is turn it into the
  // minimum somebody signs. Optimistic, the transaction reverts for nothing;
  // pessimistic, they accept less protection than the slippage they chose - and
  // the quoter being unreachable is exactly when price risk is highest.
  if (!v.outFromQuoter) {
    throw new Error(
      "The v4 quoter did not answer, so this page has only its own model of the pool. " +
      "It will not send a trade whose minimum comes from a model. Try again in a moment."
    );
  }
  const { side, amount, min, zeroForOne, outDec, key: k, via } = v;
  const eth = via === "eth";

  // WHAT THE PERSON HANDS OVER. Paying in ETH means no token leaves their
  // account at all on a buy - it rides as the transaction's value - so there is
  // nothing for Permit2 to be approved for.
  const tokenIn = side === "buy" ? pin.quote : pin.token;
  const tokenOut = side === "buy" ? pin.token : pin.quote;
  const needsPermit2 = !(eth && side === "buy");

  if (needsPermit2) {
    // HELD FIRST, THEN THE TWO APPROVALS. Without this a seller of more than
    // they hold, or a buyer paying in WETH they do not have, paid for both
    // approvals and then a swap that failed - with the allowances left standing
    // (round 5, N20). Refused, not wrapped: on the WETH pair the ETH route
    // already wraps inside the swap itself, in one transaction.
    const buying = side === "buy";
    await ensureHeld(pin, tokenIn, amount, buying ? pin.quoteDecimals : 18, buying ? pin.quoteSym : "tokens",
      buying ? "This buy" : "This sale",
      buying && same(pin.quote, WETH)
        ? "To pay with the ETH you hold, choose \"ETH (routed)\": the route wraps it inside the same transaction."
        : "");
    // THE REAL TWO-STEP PERMIT2 FLOW: the token approves Permit2, then Permit2
    // approves the router. Neither step is a shortcut for the other.
    await ensureAllowance(pin, tokenIn, PERMIT2, amount, "Permit2 to move this token");
    const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600);
    await send(pin, {
      to: PERMIT2,
      data: SEL.permit2Approve + encode([T.address, T.address, T.uint(160), T.uint(48)],
        [tokenIn, ROUTER, amount, expiry]).slice(2),
    }, "let the router spend through Permit2");
  }

  // THE LEGACY LAYOUT, without minHopPriceX36. ROUTER_ACCESS.txt: the deployed
  // router rejects the layout in our vendored periphery, and every swap built
  // against the vendored ABI would fail inside the router's own callback.
  // `k` is the pool key beginAction REBUILT FROM THE REGISTRY RECORD - not the
  // lens's, which only had to agree with it, and not whatever is on screen.
  let commands, inputs, value;
  if (eth) {
    ({ commands, inputs, value } = ethRoute(pin, v, k));
  } else {
    const swapParams = encode(
      [T.tuple([T.tuple([T.address, T.address, T.uint(24), T.int(24), T.address]), T.bool, T.uint(128), T.uint(128), T.bytes])],
      [[[k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks], zeroForOne, amount, min, "0x"]]
    );
    const settle = encode([T.address, T.uint(128)], [tokenIn, amount]);
    const take = encode([T.address, T.uint(128)], [tokenOut, min]);
    const actions = "0x060c0f"; // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL
    commands = "0x10";
    inputs = [encode([T.bytes, T.array(T.bytes)], [actions, [swapParams, settle, take]])];
    value = 0n;
  }
  const data = SEL.execute + encode([T.bytes, T.array(T.bytes), T.uint(256)],
    [commands, inputs, BigInt(Math.floor(Date.now() / 1000) + 600)]).slice(2);

  // THE ETH BALANCE BEFORE, for the one output that is not an ERC20 transfer
  // and cannot be read out of the logs.
  const ethBefore = eth && side === "sell"
    ? BigInt(await pin.read("eth_getBalance", [pin.from, "latest"]))
    : 0n;
  const tx = { to: ROUTER, data };
  if (value > 0n) tx.value = "0x" + value.toString(16);
  const receipt = await send(pin, tx, eth ? "the ETH route through UniversalRouter" : "swap through UniversalRouter");

  await report(receipt, async () => {
    // WHO THE v4 LEG PAYS. On the ETH route's sell it is the ROUTER: that NVDAc
    // is the next leg's input, and reading it as the person's would be reading
    // the route wrong.
    const netTo = eth && side === "sell" ? ROUTER : pin.from;
    // THE INPUT IS PART OF THE READING NOW. On a buy the tax comes off what
    // was SENT, so the base is not on the output side at all and cannot be
    // recovered from the Swap event alone.
    const r = await readSwapResult(
      pin, receipt, { id: poolId(k), outToken: tokenOut, zeroForOne, netTo, inToken: tokenIn, amountIn: v.amount }
    );
    const unit = side === "buy" ? "tokens" : pin.quoteSym;

    // ETH IS NOT AN ERC20 AND HAS NO Transfer TO READ. What the person paid on
    // a buy is the transaction's value, exactly; what they received on a sell
    // is a balance difference - and that difference also carries the GAS, which
    // is not part of the trade. The receipt says what the gas cost, so the two
    // are separated rather than reported as one number.
    const fee = txFee(receipt);
    const part = (v, what) => (v === null ? `${what} <strong>unknown</strong>` : `${what} ${amt(v, 18, "ETH")}`);
    const feeLine = `fee: ` + part(fee.l2, "L2 execution") + ", " + part(fee.l1, "L1 data") +
      (fee.missing.length
        // NOT "the real cost is higher". A receipt without l1Fee may be a node
        // that does not report it OR a chain that charges none, and this page
        // cannot tell those apart. What is certain is only what is written here.
        ? ` — the total below is the KNOWN part: ${escapeHtml(fee.missing.join(" and "))} ` +
          `${fee.missing.length > 1 ? "are" : "is"} not on this receipt, so it is unknown rather than zero`
        : "") +
      ` (known total ${amt(fee.known, 18, "ETH")})`;
    let ethLines = [];
    // THE SAME FIGURES IN THE SMALLEST UNIT, so they can be checked against a
    // receipt rather than read off a six-decimal rendering.
    let ethExact = [];
    if (eth && side === "buy") {
      ethLines = [
        `you paid ${amt(amount, 18, "ETH")}, which is the transaction's value and nothing else`,
        feeLine + ", on top of it",
      ];
      ethExact = [["paid", amount], ["feeL2", fee.l2], ["feeL1", fee.l1], ["feeKnown", fee.known]];
    } else if (eth && side === "sell") {
      // FROM THE TRANSACTION, not from the balance. The Withdrawal event is
      // what this transaction unwrapped and forwarded; the balance is reported
      // beside it as what it is, and a disagreement is named rather than
      // absorbed.
      const out = ethUnwrapped(receipt);
      const after = BigInt(await pin.read("eth_getBalance", [pin.from, "latest"]));
      const moved = after - ethBefore;
      ethLines = [
        out > 0n
          // WHAT THE EVENT SAYS AND WHAT IT DOES NOT. WETH9 records the ROUTER
          // turning WETH back into ETH; it names no recipient. That it reached
          // you rests on the route this page built - UNWRAP_WETH addressed to
          // the caller - and on this transaction having succeeded.
          ? `this transaction unwrapped ${amt(out, 18, "ETH")}, addressed to you by the route it was sent with`
          : `<strong>this transaction shows no ETH being unwrapped</strong>, so what it paid out cannot be stated`,
        feeLine,
        `your balance moved by ${amt(moved, 18, "ETH")} over the same period — that is not the same ` +
          `statement: it carries the fee, and anything else that arrived while this was in flight`,
        `the ${pin.quoteSym} in between went to the router, not to you, and was spent on the second leg`,
      ];
      ethExact = [
        ["unwrapped", out], ["feeL2", fee.l2], ["feeL1", fee.l1], ["feeKnown", fee.known],
        ["balanceMoved", moved],
      ];
      // The two agree only when nothing else touched the account AND the fee is
      // fully known. Both conditions are stated rather than assumed.
      if (!fee.missing.length && out > 0n && moved !== out - fee.known) {
        // NOT "something other than this transaction". An account with code of
        // its own can forward what it receives WITHIN this transaction - which
        // is exactly what every anvil default account does on this fork, being
        // 7702-delegated on Base - so the difference is not evidence of a second
        // transaction. Say what is unexplained, not what caused it.
        ethLines.push(
          `<strong>The balance change is not explained by the unwrapped amount and the known fees.</strong> ` +
          `Unwrapped minus fee is ${amt(out - fee.known, 18, "ETH")} and the balance moved ` +
          `${amt(moved, 18, "ETH")}. There may be other ETH movements in this same transaction — an ` +
          `address with code of its own forwards what it receives — or in the period this was measured over.`
        );
      }
    }

    if (r.gross == null) {
      show("ok",
        `Swapped through the official UniversalRouter, but this transaction carries no Swap event for ` +
        `this pool, so what the swap itself produced cannot be stated. It moved ` +
        `${amt(r.credited, side === "buy" ? 18 : pin.quoteDecimals, side === "buy" ? "tokens" : pin.quoteSym)} ` +
        `into your account.` + exactly([["credited", r.credited]]));
      return;
    }

    const netUnit = side === "buy" ? "tokens" : pin.quoteSym;
    const netDec = side === "buy" ? 18 : pin.quoteDecimals;

    // THREE LINES, NEVER ONE MERGED NUMBER. The platform's share and the
    // creator's share are separate charges to separate people, and the pool's
    // own LP fee is a third thing that is not ours at all - it stays inside the
    // position and is not part of the tax.
    const taxDec = pin.quoteDecimals;
    const taxLines = [
      `the tax was charged in ${pin.quoteSym}, on ${r.quoteIsInput ? "the " + amt(r.base, taxDec, pin.quoteSym) + " that reached the pool" : "the gross " + pin.quoteSym + " this swap produced"}`,
      `platform ${amt(r.platform, taxDec, pin.quoteSym)} — ${fmtBps(r.platformBps)} of that, whatever tax this launch chose`,
      `creator ${amt(r.creator, taxDec, pin.quoteSym)} — the rest of this launch's tax, to ${escapeHtml(r.creatorRecipient || "its creator")}`,
    ].concat(r.splitIsObserved === false
      ? [`both of those go to the SAME address here, so the receipt shows one total and the ` +
         `split above is this page's arithmetic rather than something it can read back`]
      : []).concat([
      `the pool's own LP fee is separate from all of this: it stays in the locked position and is not shown here`,
    ]);
    // A DEBT IS NOT A PAYMENT. reconcileSwap already knew which legs went to
    // the hook rather than to their payees - that is how it reconciled - and
    // the receipt used to throw it away and describe every fee as delivered.
    if (r.feesAccrued) {
      taxLines.push(
        `at least one of those legs did not reach its payee in this transaction: the hook at ` +
        `${escapeHtml(pin.hook)} kept it and wrote it down as owed. ` +
        (same(pin.quote, WETH)
          ? `On an ETH pair that is every leg, every time. `
          : `On this pair that happens when the payee could not be paid directly. `) +
        `The payee takes it with claim() - "Claim pool fees" on this page`
      );
    }
    if (r.feeToMe) {
      const mine = (r.legs || []).filter((l) => same(l.to, pin.from));
      const kept = mine.filter((l) => l.accrued).length;
      const both = mine.length >= 2;
      const owedLine = `"owed to you from pool trading" above until you claim it`;
      taxLines.push(both
        ? (kept === mine.length
            ? `BOTH legs are THIS account's, and the hook kept both: not in your balance yet, but in ${owedLine}`
            : kept === 0
              ? `BOTH legs are THIS account's, and both arrived with the swap - that part is fee income, not ` +
                `something you swapped for`
              : `BOTH legs are THIS account's: one arrived with the swap, and the one the hook kept is in ${owedLine}`)
        : kept
          ? `one of those two is THIS account, and its leg was kept by the hook: it is not in your balance ` +
            `yet but in ${owedLine}`
          : `one of those two is THIS account, so part of what arrived is fee income rather than ` +
            `something you swapped for`);
    }

    const lines = ethLines.concat([
      r.quoteIsInput
        ? `the v4 leg delivered ${amt(r.net, netDec, netUnit)} — the whole output, because the tax came off ` +
          `the ${pin.quoteSym} before the pool ever saw it`
        : `the v4 leg produced ${amt(r.gross, netDec, netUnit)} gross and you keep ` +
          `${amt(r.net, netDec, netUnit)}` + (eth && side === "sell" ? ", paid to the router" : ""),
    ]).concat(taxLines).concat([
      `this transaction moved ${amt(r.credited, netDec, netUnit)} into your account in total`,
    ]);
    const sym = await launchSym(pin);
    const payUnit = eth ? "ETH" : pin.quoteSym;
    const payDec = eth ? 18 : pin.quoteDecimals;
    const head = side === "buy"
      ? wentCame(amount, payDec, payUnit, r.net, 18, sym)
      : wentCame(amount, 18, sym, eth ? ethUnwrapped(receipt) : r.net, payDec, payUnit);
    (r.reconciles ? (html) => showDone(head, receipt, html) : (html) => show("err", html))(
      (eth ? `Routed through the official UniversalRouter: ETH and this pool are two legs.<br>`
           : `Swapped through the official UniversalRouter.<br>`) +
      lines.map((l) => "• " + l).join("<br>") +
      (r.reconciles
        ? ""
        : `<br><strong>These figures do not match what the pool actually paid out.</strong> ` +
          escapeHtml(r.why) + `. Treat every number above as unexplained and read the transaction itself.`) +
      exactly(ethExact.concat([
        ["gross", r.gross], ["platform", r.platform], ["creator", r.creator],
        ["net", r.net], ["credited", r.credited],
      ])));
  });
}

// ---------------------------------------------------------------- wiring
/// THE SITE BAR SHOWS THE ACCOUNT TOO (topbar.js), and learns of a connect
/// made here from this event - a wallet is not obliged to emit accountsChanged
/// for it, and the test wallet never does. Nothing listens in tests.html.
const tellBar = (a) => document.dispatchEvent(new CustomEvent("curb:page-account", { detail: a || null }));

/// Whether the person chose Disconnect in the site bar. The silent check at
/// load and a wallet's own account events are ignored until they connect again.
const barHidden = () => !!(window.CurbBar && window.CurbBar.isHidden());

async function connect() {
  const eth = window.CurbBar && window.CurbBar.pick ? await window.CurbBar.pick() : wallet();
  if (!eth) return;
  // NOT CONNECTED: the bar lets go of a wallet another can be picked over (topbar.js declined).
  const accounts = await eth.request({ method: "eth_requestAccounts" })
    .catch((e) => { if (window.CurbBar && window.CurbBar.declined) window.CurbBar.declined(eth); throw e; });
  account = accounts[0];
  $("wallet").textContent = "Connected: " + account;
  tellBar(account);
  await refreshAndResume();
  // THE WRONG NETWORK SAID AT CONNECT, with the way out - not first at the
  // moment a trade is refused for it.
  const off = await walletOffNetwork().catch(() => null);
  if (off) show("err", escapeHtml(off.message) + (off.chainId ? switchButton(off.chainId) : ""));
}

/// THE WALLET ON A NETWORK NOTHING IS SENT ON, or null: another network than
/// the endpoint this page reads, or - once config.js names a deployment - any
/// but its chain. { message, chainId } where chainId is the one network the
/// wallet may be offered (chainVerdict), or null when no switch would help.
async function walletOffNetwork() {
  const eth = injected();
  if (!eth) return null;
  const [walletChain, nodeChain] = await Promise.all([
    eth.request({ method: "eth_chainId" }),
    rpcAt(chainCfg.rpc, "eth_chainId", []),
  ]);
  return chainVerdict(walletChain, nodeChain);
}

/// What a network is called when the wallet is asked to add it.
const chainName = (hex) => (hex === "0x2105" ? "Base" : "CURB fork " + parseInt(hex, 16));

/// The button that moves the wallet (#msg's click listener runs it).
const switchButton = (hex) =>
  `<br><button type="button" class="toastCta" data-switch-chain="${escapeHtml(hex)}">` +
  `Switch the wallet to ${escapeHtml(chainName(hex))}</button>`;

/// THE WALLET, MOVED TO THE NETWORK THIS PAGE READS - when asked, never by
/// itself. A network the wallet does not know (EIP-3085 error 4902) is offered
/// to it to add: Base with its public endpoint and explorer, anything else
/// (a local fork) with the endpoint this page reads. The wallet shows the
/// person both requests; nothing here decides for them.
///
/// THE SITE BAR'S, WHERE THERE IS ONE (CurbBar.switchChain): one way to move
/// the wallet, which the Holder fees page offers too. The copy below is for a
/// page without the bar, and holds to the same rule: once config.js names a
/// deployment, only to its chain (NAMED_CHAIN), never added with a link's
/// endpoint.
async function switchWalletTo(hex) {
  if (window.CurbBar && window.CurbBar.switchChain) return window.CurbBar.switchChain(hex, chainCfg.rpc);
  const eth = injected();
  if (!eth) throw new Error("No injected wallet.");
  if (NAMED_CHAIN && !sameChainId(hex, NAMED_CHAIN)) {
    throw new Error("This site sends only on " + chainName(NAMED_CHAIN) + ", so it does not move your wallet to chain " +
      parseInt(hex, 16) + ".");
  }
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e) {
    const unknown = e && (e.code === 4902 || (e.data && e.data.originalError && e.data.originalError.code === 4902));
    if (!unknown) throw e;
    const base = hex === "0x2105";
    const addWith = base ? "https://mainnet.base.org" : NAMED_CHAIN ? SITE.rpc : chainCfg.rpc;
    if (!addWith) throw new Error("Your wallet does not know chain " + parseInt(hex, 16) + ". Add it in the wallet itself.");
    await eth.request({ method: "wallet_addEthereumChain", params: [{
      chainId: hex,
      chainName: chainName(hex),
      rpcUrls: [addWith],
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      ...(base ? { blockExplorerUrls: ["https://basescan.org"] } : {}),
    }] });
  }
}

/// THE WHERE PANEL (endpoint, contracts, what the wallet is owed) starts closed
/// for someone launching a token, and open for a link that names an endpoint
/// or a contract - a fork, a test, a deployment being checked. Once its reader
/// opens or closes it, it stays as they left it: saved on their click, never
/// on this page's own setting of it. In production it is initFeesPanel's.
const WHERE_OPEN_KEY = "curb.whereOpen";
function initWherePanel() {
  const d = $("wherePanel");
  if (!d || d.tagName !== "DETAILS") return;
  if (PRODUCTION) return initFeesPanel(d);
  let kept = null;
  try { kept = localStorage.getItem(WHERE_OPEN_KEY); } catch { kept = null; }
  // A RESTATED BUILT-IN PAIR OPENS NOTHING (siteQuery): it names no fork, no
  // test and no other deployment.
  const q = siteQuery();
  d.open = kept === "1" || (kept === null && ["rpc", "factory", "lens", "token"].some((k) => q.has(k)));
  const summary = d.querySelector("summary");
  if (summary) summary.addEventListener("click", () => {
    try { localStorage.setItem(WHERE_OPEN_KEY, d.open ? "0" : "1"); } catch { /* a preference, not state */ }
  });
}

/// IN PRODUCTION THE PANEL IS ONLY WHAT THE WALLET IS OWED. The endpoint, the
/// contracts, the wallet's line, the quote asset and the issuer's row are
/// config.js's and the site bar's (which has its own Connect), so they are not
/// shown - nor for a link naming another deployment, whose sends
/// endpointRefusal refuses. What is left is #owedBox, as "Your fees": shown,
/// open, while renderOwed finds the connected wallet owed something, and the
/// whole panel hidden otherwise. The claims are drawn and wired as on a fork.
function initFeesPanel(d) {
  d.classList.add("feesOnly");
  const title = d.querySelector("summary h2");
  if (title) title.textContent = "Your fees";
  const hint = d.querySelector("summary .whereHint");
  if (hint) hint.remove();
  d.hidden = true;
  const box = $("owedBox");
  if (!box) return;
  // IT FOLLOWS THE BOX, WHOEVER SETS IT: renderOwed, a factory that cannot be
  // read, a render that failed.
  new MutationObserver(() => {
    const owed = !box.hidden && box.dataset.owed === "1";
    // OPENED AS IT APPEARS, and left as its reader sets it while it stays.
    if (owed && d.hidden) d.open = true;
    d.hidden = !owed;
  }).observe(box, { attributes: true, attributeFilter: ["hidden", "data-owed"] });
}

/// Every dev-buy field back to "no dev buy": the amount, the share, the slider.
function resetDevBuy() {
  devPctPending = null;
  for (const id of ["nDevBuy", "nDevPct"]) if ($(id)) $(id).value = "";
  if ($("nDevSlider")) $("nDevSlider").value = "0";
  renderLaunchSummary();
  renderDevBuy();
}

async function init() {
  initWherePanel();
  // THE PRODUCTION FORM STARTS EMPTY, on its placeholders. "Curb Demo" and
  // "DEMO" are for a fork and the browser tests, which create with them.
  if (PRODUCTION) for (const id of ["nName", "nSymbol"]) if ($(id)) $(id).value = "";
  loadCfg();
  showCreatedNotice();
  // SAID ONCE, AND IT STAYS. Everything below was read at an endpoint the link
  // did not name, so it is the first thing to know and the last thing that
  // should be cleared by an unrelated refresh.
  const reasons = [];
  if (mixedEndpoint) {
    reasons.push(
      "This link gave only half of where to look: " +
      (linkGaveEndpoint
        ? "an endpoint but no contract, so the factory and lens below are the ones from your last session."
        : "a contract but no endpoint, so it is being read at " + chainCfg.rpc + ", the one from your last session.") +
      " If those two halves are not from the same deployment, every number on this page is about " +
      "something else. Open the whole link, or set both below."
    );
  }
  if (factoryFromStorage) {
    reasons.push(
      "This link named a lens but no factory, so the factory below (" + chainCfg.factory + ") is the one " +
      "from your last session. If the two are not from the same deployment, what this page says about a " +
      "launch is about something else. Pick the asset below, or open the whole link."
    );
  }
  whereReasons = reasons;
  recheckWhere();
  warnAboutWhere();
  // THE ENDPOINT THIS FORM READS, said under the site bar when it is not the
  // site's own (topbar.js endpointNotice) - the form's, which a half link can
  // make differ from the one the bar carries.
  if (window.CurbBar && window.CurbBar.endpointNotice) window.CurbBar.endpointNotice(chainCfg.rpc);
  for (const id of ["rpc", "factory", "lens", "token"]) {
    $(id).addEventListener("change", () => {
      chainCfg[id] = $(id).value.trim();
      // THIS FIELD IS THE PERSON'S NOW, and saveCfg() may keep it; the others
      // keep whatever standing they had (round 5, N13/N14).
      edited[id] = true;
      // WHAT IS IN THE RPC FIELD NOW WAS TYPED, so records may be settled
      // through it (recordTransports); the link's endpoint no longer stands.
      if (id === "rpc") linkOnlyRpc = null;
      if (id === "rpc" && window.CurbBar && window.CurbBar.endpointNotice) window.CurbBar.endpointNotice(chainCfg.rpc);
      if (id === "factory") factoryChosen = true;
      if (id === "token" || id === "lens") factoryChosen = false;
      switchNote = null;
      saveCfg();
      cache = {};
      // THE PICKER IS READ THROUGH THE ENDPOINT AND FROM THE FACTORY'S REGISTRY
      // (or the lens's), so a change to any of the three reads it again. Only
      // the lens used to: after a new endpoint or factory the cards still
      // offered the old registry's factories, and a click re-pointed the form
      // at one of them, chosen (round 5, N52).
      if (id !== "token") fillQuotePicker();
      refresh();
    });
  }
  fillQuotePicker();
  // THE PICKER IS FILLED FROM THE CHAIN, and choosing one only fills the
  // factory field - the address stays visible and stays the thing that is
  // pinned before anything is sent.
  $("quotePick").addEventListener("change", () => {
    const v = $("quotePick").value;
    if (!v) return;
    $("factory").value = v;
    chainCfg.factory = v;
    factoryChosen = true;
    // A PICK IS THE PERSON SETTING THE FACTORY - unless the list itself came
    // through a link's endpoint, lens or factory: then the choices were the
    // link's, and saving one would keep a stranger's registry's factory
    // (round 5, N14). saveCfg() says what is kept.
    if (!pickerFromLink) edited.factory = true;
    switchNote = null;
    // A NEW ASSET STARTS WITH NO DEV BUY. The amount was left in the field, and
    // 10 typed for ETH read as 10 cbBTC after the switch (the owner's report).
    resetDevBuy();
    saveCfg();
    cache = {};
    refresh();
  });
  // THE FORGET BUTTON lives inside the message line, which is redrawn whole on
  // every show(), so it is listened for here rather than wired per drawing.
  $("msg").addEventListener("click", (e) => {
    const b = e.target && e.target.closest && e.target.closest("button[data-forget]");
    if (b) forgetRecord(b.getAttribute("data-forget"));
    // THE WRONG NETWORK'S WAY OUT (switchButton): the wallet is asked, and
    // says so; the page reads nothing new, it only waits for the next press.
    const sw = e.target && e.target.closest && e.target.closest("button[data-switch-chain]");
    if (sw) {
      const hex = sw.getAttribute("data-switch-chain");
      guard(async () => {
        await switchWalletTo(hex);
        const off = await walletOffNetwork().catch(() => null);
        if (off) throw Object.assign(new Error(off.message), off.chainId ? { switchTo: off.chainId } : {});
        show("ok", `Your wallet is on ${escapeHtml(chainName(hex))} now, the network this page reads. ` +
          `Press what you were doing again.`);
      });
    }
  });
  // WHAT A SWAP LEFT HELD: its buttons are in the message line and in the held
  // rows, which are redrawn whole, so they are listened for here. Each carries
  // the amount and the asset, so it works where no record could be stored.
  document.addEventListener("click", (e) => {
    const b = e.target && e.target.closest &&
      e.target.closest("button[data-held-buy],button[data-held-sell],button[data-held-dismiss],button[data-held-revoke]");
    if (!b || busy) return;
    let carried = 0n;
    try { carried = BigInt(b.getAttribute("data-held-buy") || b.getAttribute("data-held-sell") || "0"); } catch { carried = 0n; }
    if (b.hasAttribute("data-held-buy")) buyWithHeld(carried, b.getAttribute("data-held-asset"));
    else if (b.hasAttribute("data-held-sell")) {
      // THE SLIPPAGE AS IT IS AT THE CLICK, in one tick.
      const slipText = ((TOKEN_VIEW && $("tvSlip") ? $("tvSlip").value : $("slippage").value) || "").trim();
      guard(() => sellHeldBack(slipText, carried));
    } else if (b.hasAttribute("data-held-revoke")) guard(() => revokeAero(b.getAttribute("data-held-revoke")));
    else dismissHeld();
  });
  document.addEventListener("curb:drawn", () => { renderHeld(); });
  document.addEventListener("curb:refreshed", () => { renderHeld(); });
  $("connect").onclick = () => guard(connect, { resumeSpeaks: true });
  // REFRESH READS THE FACTORY AGAIN TOO. What the context cache holds is meant
  // to be immutable, but it is only as good as the replies it was built from,
  // and the button the page's own messages send people to used to redraw the
  // same cached terms whatever they said (round 5, N06). A field change or a
  // picker choice empties the cache; so does this.
  $("refresh").onclick = () => guard(() => { cache = {}; return refresh(); }, { resumeSpeaks: true });
  $("create").onclick = () => guard(createLaunch);
  $("curveAct").onclick = () => guard(curveAction);
  $("complete").onclick = () => guard(completeGraduation);
  if ($("claimEscrow")) $("claimEscrow").onclick = () => guard(() => claimFees("escrow"));
  if ($("claimHook")) $("claimHook").onclick = () => guard(() => claimFees("hook"));
  if ($("sweepCurve")) $("sweepCurve").onclick = () => guard(sweepCurveFees);
  if ($("rescue")) $("rescue").onclick = () => guard(rescueFees);
  if ($("unwrap")) $("unwrap").onclick = () => guard(unwrapWeth);
  if ($("claimAll")) $("claimAll").onclick = () => guard(claimAll);
  $("poolAct").onclick = () => guard(poolAction);
  // A LINK IS SHOWN AS IT WILL BE STORED as soon as the field is left:
  // "curb.fun" becomes https://curb.fun there, before Create. What cannot be
  // made into a link is left as typed, and Create says why.
  for (const [id, kind] of [["nSite", "website"], ["nX", "x"], ["nTg", "telegram"]]) {
    if (!$(id)) continue;
    $(id).addEventListener("change", () => {
      const v = normalizeLink(kind, $(id).value);
      if (v && LINK_OK.test(v)) $(id).value = v;
    });
  }
  if ($("nTax")) {
    // HELD AT THE TOP OF THE BAND. The split line below already refused
    // anything outside it as you typed; the field itself did not, so 9 could
    // be sitting in it while the page said 1-5%.
    $("nTax").addEventListener("input", () => {
      // A NUMBER OR NOTHING, before the cap or anything else reads it. A comma
      // stays and parseTax says why it is refused.
      numericOnly($("nTax"), 2);
      // CAP, THEN DRAW, THEN SAY IT WAS CAPPED. The split line is the note, so
      // writing the note first meant renderTaxSplit immediately erased it and
      // the field went to 5 without a word about why.
      const held = capField($("nTax"), Number(TAX_MAX_BPS) / 100, null, null);
      renderTaxSplit();
      if (held) {
        $("taxSplit").textContent =
          "Held at " + fmtBps(TAX_MAX_BPS) + ", the most a launch may charge. " +
          $("taxSplit").textContent;
      }
    });
    renderTaxSplit();
  }

  // THE SUMMARY CARD. Redrawn on every keystroke that can change it, and on
  // every refresh, because the factory's half of it changes when the quote
  // asset does.
  // nDesc IS IN THIS LIST because the card shows it now. It was not, and the
  // description appeared on the card only when some other field was touched.
  // THE DEV BUY IS HELD AT THIS ASSET'S CEILING, and the line under it says
  // what that is. It used to refuse only when the button was pressed, so the
  // field and the sentence beneath it disagreed the whole time you typed.
  if ($("nDevBuy")) {
    $("nDevBuy").addEventListener("input", () => {
      // THE AMOUNT IS THE SOURCE AGAIN: a share left unconverted no longer
      // speaks for what is sent (devPctPending).
      devPctPending = null;
      // A NUMBER OR NOTHING, at no more places than the asset has. A comma
      // stays, and the readout under the field says why nothing is priced.
      numericOnly($("nDevBuy"), ctx ? ctx.quoteDecimals : null);
      if (!ctx) return;                       // nothing read yet: nothing to cap against
      const cap = devBuyCeiling(ctx.threshold, ctx.maxDevBuyBps);
      if (cap === null) return;
      // THE LINE GOES BACK TO WHAT IT NORMALLY SAYS FIRST, and the hold writes
      // over it only when it holds. Without this "Held at 45" stayed under a
      // field that had since been typed down to 10.
      renderLaunchSummary();
      capField(
        $("nDevBuy"), Number(fmt(cap, ctx.quoteDecimals, 6).replace(/,/g, "")),
        $("devBuyCap"), fmt(cap, ctx.quoteDecimals, 6) + " " + ctx.quoteSym
      );
      // AND THE READOUT FROM WHAT THE FIELD HOLDS NOW, not from the figure
      // the hold just replaced.
      renderDevBuy();
    });
  }

  // THE PRESETS WRITE THE FIELD AND FIRE ITS OWN EVENT, so the split line,
  // the summary and the dev buy redraw exactly as they do when it is typed.
  for (const b of document.querySelectorAll("#taxPresets [data-tax]")) {
    b.addEventListener("click", () => {
      $("nTax").value = b.dataset.tax;
      $("nTax").dispatchEvent(new Event("input"));
    });
  }
  for (const b of document.querySelectorAll("#devMode [data-mode]")) {
    b.addEventListener("click", () => setDevMode(b.dataset.mode));
  }

  // THE DEV BUY AS A SHARE OF THE SUPPLY. Converted to an amount with the
  // curve's own arithmetic and written into the amount field, which is what
  // is sent - held at the share the ceiling buys, and said so.
  if ($("nDevPct")) {
    $("nDevPct").addEventListener("input", () => {
      numericOnly($("nDevPct"), 2);
      // NOTHING FROM AN EARLIER KEYSTROKE SURVIVES THIS ONE. The amount is
      // cleared and the share marked as not yet an amount FIRST; only a share
      // turned into an amount below writes both back. Every early return here
      // used to leave the previous keystroke's amount in the hidden field, and
      // that is what Create sent (round 5, S02). readDevBuy and the card say
      // why while devPctPending is set.
      $("nDevBuy").value = "";
      devPctPending = null;
      let held = false;
      let capQ = null;
      const text = ($("nDevPct").value || "").trim();
      if (text.includes(",")) {
        devPctPending = "In the share field: " + COMMA_REFUSED;
      } else if (text !== "") {
        const cap = ctx ? devBuyCeiling(ctx.threshold, ctx.maxDevBuyBps) : null;
        capQ = cap === null ? null : devBuyQuote(cap);
        // "1." IS 1 - halfway to "1.5", and already a number - so it is
        // converted like one; the field itself is never rewritten mid-keystroke.
        const share = Number(text);
        if (!capQ) {
          devPctPending = "The share cannot be turned into an amount until the creator tax is valid and this " +
            "factory's terms are read. Fix the tax, then type the share again.";
        } else if (!isFinite(share)) {
          devPctPending = "The share in the share field is not a number yet. Finish it, or clear it.";
        } else {
          // HELD AT THE FACTORY'S OWN SHARE (20), not at what the cap amount
          // happens to round to (19.99): 20 typed is converted and the amount
          // held at the cap below.
          const maxPct = ctx.maxDevBuyBps < 10000n ? Number(ctx.maxDevBuyBps) / 100 : Number(capQ.shareBps) / 100;
          held = !!capField($("nDevPct"), maxPct, null, null);
          let amount = cap;
          if (!held) {
            const need = devBuyForShare(Math.round(share * 100));
            if (need === null) {
              devPctPending = "The share cannot be turned into an amount until the creator tax is valid and " +
                "this factory's terms are read. Fix the tax, then type the share again.";
            } else {
              // ROUNDED UP AT SIX PLACES, so the share is reached rather than
              // missed by a unit - and never past the ceiling.
              const up = roundUnits(need, ctx.quoteDecimals, 6, false);
              amount = up > cap ? cap : up;
            }
          }
          if (!devPctPending) $("nDevBuy").value = amount === 0n ? "" : plainUnits(amount, ctx.quoteDecimals);
        }
      }
      renderLaunchSummary();
      if (held) {
        $("devBuyCap").textContent = "Held at " +
          (ctx.maxDevBuyBps < 10000n ? sharePlain(ctx.maxDevBuyBps) + "%" : fmtShare(capQ.shareBps)) +
          " of the supply, the most this launch allows.";
      }
    });
  }

  // THE SLIDER RUNS FROM NOTHING TO THE CEILING. Its last stop is the
  // ceiling to the last unit; every other stop is rounded down at six places
  // so the field it writes stays readable.
  if ($("nDevSlider")) {
    $("nDevSlider").addEventListener("input", () => {
      if (!ctx) return;
      const cap = devBuyCeiling(ctx.threshold, ctx.maxDevBuyBps);
      if (cap === null) return;
      const amount = sliderAmount($("nDevSlider").value || "0", cap, ctx.quoteDecimals);
      $("nDevBuy").value = amount === 0n ? "" : plainUnits(amount, ctx.quoteDecimals);
      // The slider wrote the amount, so the share field is redrawn from it.
      devPctPending = null;
      renderLaunchSummary();
    });
  }

  for (const id of ["nName", "nSymbol", "nTax", "nDesc"]) {
    const el = $(id);
    if (el) el.addEventListener("input", renderLaunchSummary);
  }
  // WHO EARNS THE TAX: its terms, the split and the summary follow the choice at
  // once. Both radios: a radio says change only when it becomes the chosen one.
  for (const id of ["nShare", "earnYouPick"]) {
    if ($(id)) $(id).addEventListener("change", () => { renderTaxSplit(); renderLaunchSummary(); });
  }
  // THE FILE IS READ ONCE, WHEN IT IS CHOSEN. Shrinking on every keystroke
  // would be wasteful and the result never changes until the file does.
  if ($("nImageFile")) {
    // THE CHOSEN IMAGE IN THE PICKER ITSELF (the owner's call): the one the
    // token will carry, after the shrink - not the file as it was on disk.
    const preview = () => {
      const pick = document.querySelector(".filePick");
      const img = $("nImagePreview");
      if (!pick || !img) return;
      pick.classList.toggle("hasImage", !!tokenImage);
      if (tokenImage) img.src = tokenImage; else img.removeAttribute("src");
    };
    $("nImageFile").addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      const note = $("nImageNote");
      if (!file) {
        tokenImage = "";
        preview();
        if ($("nImageName")) $("nImageName").textContent = "Choose image";
        if (note) note.textContent = "";
        renderLaunchSummary();
        return;
      }
      try {
        tokenImage = await shrinkToDataUri(file);
        // THE LABEL CARRIES THE STATE, because the native input's own text is
        // drawn by the browser in the browser's language and cannot be set.
        if ($("nImageName")) $("nImageName").textContent = file.name;
        if (note) note.textContent =
          Math.ceil(tokenImage.length / 1024) + " KB stored in the token, 128x128.";
      } catch (err) {
        tokenImage = "";
        if (note) note.textContent = err.message || String(err);
      }
      preview();
      renderLaunchSummary();
    });
  }
  renderLaunchSummary();

  for (const id of ["curveAmount", "curveSide", "slippage", "curveVia"]) $(id).addEventListener("input", () => renderCurveQuote());
  for (const id of ["poolAmount", "poolSide", "poolSlippage", "poolVia"]) {
    $(id).addEventListener("input", () => renderPoolQuote());
  }

  // THE WALLET THE BAR CHOSE, once it has found the wallets (topbar.js).
  if (window.CurbBar && window.CurbBar.ready) await window.CurbBar.ready;
  const eth = injected();
  const walletOn = (window.CurbBar && window.CurbBar.walletOn) || ((e, f) => eth.on?.(e, f));
  if (eth || window.CurbBar) {
    if (eth && !barHidden()) {
      try {
        const a = await eth.request({ method: "eth_accounts" });
        if (a && a[0]) { account = a[0]; $("wallet").textContent = "Connected: " + account; }
      } catch {}
    }
    // A SWITCHED ACCOUNT IS THIS PAGE'S ACCOUNT FROM THEN ON. It used to be
    // noticed only at the next send ("The wallet's account changed"), while the
    // site bar already showed the new one. Sends still re-check at dispatch.
    // On the bar's handler, so a wallet picked or restored later is followed too.
    try {
      walletOn("accountsChanged", (a) => {
        if (barHidden()) return;
        account = (a && a[0]) || null;
        $("wallet").textContent = account
          ? "Connected: " + account
          : "No wallet connected. Reading works without one; every action needs one.";
        refreshAndResume(true);
      });
    } catch { /* a wallet without events */ }
  }

  await refreshAndResume(true);
}

window.CurbApp = {
  init, refresh, createLaunch, curveAction, poolAction, completeGraduation, connect, resumePending,
  CANONICAL, canonicalComplaint, warnAboutWhere, normalizeLink,
  quoteBuy, quoteSell, quotePoolSwap, computeCurveQuote, computePoolQuote,
  // So a test can hold one quote's promise and let a newer one overtake it.
  renderCurveQuote,
  // THE TWO COST FUNCTIONS ARE EXPOSED so a test can check the number the
  // screen shows against one it worked out for itself, rather than checking
  // that the screen agrees with the screen.
  totalCostBps, curveCostBps,
  readLaunch, poolState, poolId, parseUnits, fmt, fmtSmall, poolTax,
  // The dev buy's pricing and the number filter, so a test can hold the
  // screen's figure against the chain's rather than against the screen.
  devBuyQuote, devBuyForShare, numericOnly, setDevMode, sliderAmount, parseTax,
  // The percentage every share on the page is printed with.
  fmtBps,
  // graduatorKey is exposed for the same reason the rest of this is: so a test
  // can ask what the page believes rather than infer it from behaviour.
  get state() { return { account, chainCfg, ctx, view, viewFor, meta, busy, graduatorAddr, graduatorKey: graduatorFromLens, symbolTrouble, resumeRuns, owedPending }; },
  // For the token view (token.js): the same names the page prints.
  displaySymbol, tokenPageHref, quoteAssetInEth, assetLogo,
  // THE CURB ROUTER: its pinned address and code hash, and the last verdict on
  // whether it is here (true, false, or null before it was asked).
  CURB_ROUTER, routerUsable, confirmationsWords,
  // THE PRICE IMPACT AND THE CLAMP, as the swap card says them (token.js).
  curveImpact, poolImpact, impactLevel, impactText, impactWarning, clampWords, buyMin, conversionWords, uncheckedWords,
  // HOLDER SHARING (sharing.js) SENDS THROUGH THESE AND ONLY THESE: the same
  // pin, lock, record and receipt every trade here goes through, the same
  // refusal sentences, the same issuer questions. It adds no way of sending.
  beginAction, withSendLock, send, guard, show, isRevert, revertSentence, policyAllows, coinBlacklists,
  sharingOffer,
  // THE AERODROME ROUTE: its pins and paths, the rule, the encodings and the
  // floor, as pure functions a test can hold against the chain; the quote on
  // screen as the press compares it; and what a swap left held.
  AERODROME, AERO_PATHS, preferAerodrome, aeroPathBytes, aeroBuyData, aeroSellData, decodeQuote, stepTwoFloor,
  floorAtDrawn, noteDrawn, get drawn() { return curveDrawn; }, heldSwaps, renderHeld,
};

if (!window.__CURB_APP_TEST__) init();

})();
