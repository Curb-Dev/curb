// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";

import {PonsV2BondingCurve} from "../../src/vendor/PonsV2BondingCurve.sol";
import {LaunchRegistry} from "../../src/curb/LaunchRegistry.sol";
import {CurbLaunchFactory} from "../../src/curb/CurbLaunchFactory.sol";
import {CurbLaunchToken} from "../../src/curb/CurbLaunchToken.sol";
import {FeeEscrow} from "../../src/curb/FeeEscrow.sol";
import {PositionLock} from "../../src/curb/PositionLock.sol";
// THE ROUTER THROUGH ITS INTERFACE, deployed from its artifact - never
// imported, for B20Router's reason: a file that imports CurbRouter.sol joins
// the router's compiler profile with everything it imports (foundry.toml).
import {ICurbRouter as CurbRouter} from "../../src/curb/ICurbRouter.sol";
import {DeployCurb} from "../../script/DeployCurb.s.sol";

import {B20ForkTest} from "./B20ForkTest.sol";

/// THE DEPLOYMENT'S OWN LIST, so the terms below are DeployCurb's and not a
/// fourth copy of them. Inherited, as B20MultiAsset's DepthProbe is: a test
/// file's artifact cannot be deployed by path here (fs_permissions), so this
/// file carries its own.
contract QuoteAssetTerms is DeployCurb {
    function assets() external pure returns (Asset[] memory) {
        return quoteAssets();
    }
}

/// DeployCurb.Asset AS ITS ABI ENCODES IT, read through IListedAssets so the
/// test body names its own type.
struct ListedAsset {
    address quote;
    string label;
    uint256 phantomQuote;
    uint256 threshold;
    bool fillable;
    uint8 decimals;
}

interface IListedAssets {
    function assets() external view returns (ListedAsset[] memory);
}

interface IV3FactoryView {
    function getPool(address a, address b, uint24 fee) external view returns (address);
}

/// Uniswap's SwapRouter02, for the long way round.
interface ISwapRouter02Like {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

/// The part of Circle's FiatToken (USDC, and Coinbase's cbBTC and cbXRP) this
/// file uses.
interface IFiatTokenBlacklist {
    function blacklister() external view returns (address);
    function isBlacklisted(address account) external view returns (bool);
    function blacklist(address account) external;
}

interface IPositionManagerView {
    function nextTokenId() external view returns (uint256);
}

/**
 * @title B20NewQuoteAssetsForkTest
 * @notice THE THREE QUOTE ASSETS ADDED ON 2026-10-15 - USDC, VIRTUAL, AERO -
 *         END TO END WITH ETH ALONE: a launch on each, bought with ETH through
 *         CurbRouter, sold back for ETH, filled to graduation with ETH and
 *         graduated, and every fee the curve charged found in the escrow under
 *         the right name, in the asset, claimable.
 *
 * WHY THESE THREE NEED THEIR OWN PROOF. Every asset the list held before was a
 * B20 (an issuer policy, eight decimals), WETH, or a Coinbase-wrapped coin. Two
 * shapes are new: USDC is Circle's FiatToken with SIX decimals and a blacklist
 * the router asks (CurbRouter._notBlacklisted), and VIRTUAL and AERO are plain
 * eighteen-decimal ERC-20s whose isBlacklisted question simply reverts, which
 * the router must read as "no list" and not as a refusal. B20MultiAsset runs
 * the lifecycle on each with a holder's tokens; this runs it the way a user
 * meets it, with ETH and nothing else.
 *
 * THE ROUTES ARE THE PAGE'S RULE, MEASURED AT THE PIN, not assumed: whichever
 * v3 pool holds the most of the asset (_route). At the pinned block that is
 * WETH/USDC 0.3% for USDC (84.8 million USDC) - one hop, asserted - WETH/AERO
 * 0.3% for AERO (1,327,756 AERO, one hop), and USDC/VIRTUAL 0.3% for VIRTUAL
 * (787,611, against 518,725 in its WETH/0.05% pool), so VIRTUAL's route is two
 * hops through USDC - the same shapes live Base had on 2026-10-15. Each
 * holds tens of thresholds at the pin, so nothing here is dealt: the fill is
 * bought from the real pools, which is the claim being tested.
 *
 * THE STACK IS DeployCurb's, FROM ITS BUILT ARTIFACTS (vm.deployCode), as in
 * B20Router: one registry, one Graduator, one hook, the WETH factory wire()d
 * first, and each new asset's factory addLauncher()ed with its phantom,
 * threshold and decimals read from DeployCurb.quoteAssets().
 */
contract B20NewQuoteAssetsForkTest is B20ForkTest {
    address internal constant POOL_MANAGER = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
    address internal constant POSM = 0x7C5f5A4bBd8fD63184577525326123B519429bDc;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant V3_FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    address internal constant SWAP_ROUTER02 = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address internal constant B20_FACTORY = 0xB20f000000000000000000000000000000000000;

    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant VIRTUAL = 0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b;
    address internal constant AERO = 0x940181a94A35A4569E4529A3CDfB74e38FD98631;

    uint256 internal constant SUPPLY = 1_000_000_000e18;
    uint24 internal constant POOL_FEE = 500;
    int24 internal constant TICK_SPACING = 10;
    uint16 internal constant TAX_BPS = 300;
    uint16 internal constant MAX_IMPACT_BPS = 500;
    uint256 internal constant PLATFORM_BPS = 50;
    uint256 internal constant BPS = 10_000;

    bytes32 internal constant CURVE_BUY = keccak256("CurveBuy(address,address,uint256,uint256,uint256,uint256)");
    bytes32 internal constant CURVE_SELL = keccak256("CurveSell(address,address,uint256,uint256,uint256,uint256)");
    bytes32 internal constant FEES_SWEPT = keccak256("FeesSwept(uint256,uint256,uint256)");

    /// EVERY ACTOR HAS A LABEL OF ITS OWN, and setUp checks none has code -
    /// B20Router's lesson: forge's "alice" carries an EIP-7702 delegation on
    /// Base, and the router rightly pays such an address WETH, not ETH.
    address internal creator = makeAddr("new-quote-asset-creator");
    address internal protocolRecipient = makeAddr("new-quote-asset-protocol");
    address internal buyer = makeAddr("new-quote-asset-buyer");
    address internal filler = makeAddr("new-quote-asset-filler");
    address internal stranger = makeAddr("new-quote-asset-stranger");

    struct Pair {
        address token;
        address curve;
        address quote;
        address factory;
    }

    /// What the curve charged, summed off its own events, and what was swept.
    struct Fees {
        uint256 charged;
        uint256 taxed;
        uint256 sweptProtocol;
        uint256 sweptBuyback;
        uint256 sweptCreator;
        uint256 trades;
    }

    IListedAssets internal listed;
    CurbRouter internal router;
    LaunchRegistry internal registry;
    address internal graduator;
    address internal hook;

    function setUp() public {
        if (!_forkGuard()) return;
        address[5] memory actors = [creator, protocolRecipient, buyer, filler, stranger];
        for (uint256 i = 0; i < actors.length; i++) {
            require(actors[i].code.length == 0, "an actor has code on the fork - give it another label");
        }
        listed = IListedAssets(address(new QuoteAssetTerms()));
        router = CurbRouter(payable(vm.deployCode("CurbRouter.sol:CurbRouter")));
        registry = LaunchRegistry(vm.deployCode("LaunchRegistry.sol:LaunchRegistry", abi.encode(address(this))));
        address catalog = vm.deployCode("SharingCatalog.sol:SharingCatalog", abi.encode(address(this), address(this)));
        graduator = vm.deployCode(
            "Graduator.sol:Graduator", abi.encode(POOL_MANAGER, POSM, PERMIT2, address(registry), catalog)
        );
        hook = _mineHook(graduator);
        // WETH's FACTORY IS WIRED FIRST, as DeployCurb admits it; the new
        // assets' are added after it, through the same loop check.
        registry.wire(_factory(_listedAs("WETH")), hook);
        vm.deal(buyer, 100 ether);
        vm.deal(filler, 100 ether);
    }

    // ================================================================
    // the terms and the routes
    // ================================================================

    /// THE THREE ARE ON THE LIST, WITH THE SCALE EACH TOKEN REPORTS, AND THEIR
    /// SHAPE IS THE DECIDED ONE. Read from DeployCurb, and each decimals put to
    /// the token itself, which is the check the factory makes at construction
    /// and at every launch.
    function test_theThreeAreListed_atTheirOwnScale_andTheDecidedShape() public onlyFork {
        string[3] memory labels = ["USDC", "VIRTUAL", "AERO"];
        address[3] memory quotes = [USDC, VIRTUAL, AERO];
        uint8[3] memory scale = [uint8(6), 18, 18];
        for (uint256 i = 0; i < 3; i++) {
            ListedAsset memory a = _listedAs(labels[i]);
            assertEq(a.quote, quotes[i], string.concat(labels[i], ": DeployCurb lists another address"));
            assertEq(a.decimals, scale[i], string.concat(labels[i], ": DeployCurb sizes it at another scale"));
            assertEq(
                uint256(CurbLaunchToken(a.quote).decimals()), scale[i], string.concat(labels[i], ": the token reports another scale")
            );
            assertTrue(a.fillable, string.concat(labels[i], ": DeployCurb does not call it fillable"));
            // (V + T)^2 / V^2 = 55 / 4 = 13.75, within verify-assets.js's band.
            uint256 shape = ((a.phantomQuote + a.threshold) ** 2 * 10_000) / (a.phantomQuote ** 2);
            assertGe(shape, 134_062, string.concat(labels[i], ": graduates under 13.4 times its start"));
            assertLe(shape, 140_937, string.concat(labels[i], ": graduates over 14.1 times its start"));
            assertFalse(_isB20(a.quote), string.concat(labels[i], ": a B20 now - this file no longer covers a non-B20"));
        }
    }

    /// USDC IS ONE HOP FROM WETH, through the deepest pool there is; AERO is
    /// one hop too; VIRTUAL's deepest pool is against USDC, so its route is
    /// two. Each pool holds many thresholds at the pin, so the fills below are
    /// the market's and nothing is dealt.
    function test_theRoutesAreTheDeepestPools_andUsdcIsOneHop() public onlyFork {
        (bytes memory usdcBuy,) = _route(USDC);
        assertEq(usdcBuy.length, 20 + 23, "the USDC route is not a single hop from WETH");
        (bytes memory aeroBuy,) = _route(AERO);
        assertEq(aeroBuy.length, 20 + 23, "AERO's deepest pool at the pin is no longer against WETH");
        (bytes memory virtualBuy,) = _route(VIRTUAL);
        assertEq(virtualBuy.length, 20 + 23 * 2, "VIRTUAL's deepest pool at the pin is no longer against USDC");
        string[3] memory labels = ["USDC", "VIRTUAL", "AERO"];
        for (uint256 i = 0; i < 3; i++) {
            ListedAsset memory a = _listedAs(labels[i]);
            uint256 held = _deepestHeld(a.quote);
            emit log_named_decimal_uint(string.concat(labels[i], ": its deepest pool holds"), held, a.decimals);
            assertGe(held, a.threshold * 10, string.concat(labels[i], ": its deepest pool holds under ten thresholds here"));
        }
    }

    // ================================================================
    // end to end, with ETH alone
    // ================================================================

    function test_usdcLaunch_endToEnd_withEthAlone() public onlyFork {
        _endToEnd("USDC");
    }

    function test_aeroLaunch_endToEnd_withEthAlone() public onlyFork {
        _endToEnd("AERO");
    }

    function test_virtualLaunch_endToEnd_withEthAlone() public onlyFork {
        _endToEnd("VIRTUAL");
    }

    /// LAUNCH, BUY WITH ETH, SELL FOR ETH, FILL WITH ETH, GRADUATE, AND THE FEES.
    ///
    /// Each router call is compared with the long way on a snapshot - the swap
    /// by hand, then the curve - and must land on exactly its numbers. Every
    /// CurveBuy and CurveSell the curve emits is summed, each one's legs held
    /// to exactly 50 and 250 basis points of its gross, and the graduation's
    /// FeesSwept must hand over exactly those sums - all of the platform's to
    /// the platform, all of the creator's to the creator, none to a buyback -
    /// and the escrow must credit, and then pay, exactly that, in the asset.
    function _endToEnd(string memory label) internal {
        ListedAsset memory a = _listedAs(label);
        Pair memory p = _launch(a);
        (bytes memory buyPath, bytes memory sellPath) = _route(a.quote);
        Fees memory f;
        uint256 poolHeldBefore = IERC20(a.quote).balanceOf(POOL_MANAGER);

        // ---- 1. a buy with ETH, the same as the long way
        uint256 ethIn = 0.2 ether;
        (uint256 swapped, uint256 longWay) = _longWayBuy(p, buyPath, ethIn);
        vm.getRecordedLogs();
        vm.recordLogs();
        vm.prank(buyer);
        uint256 out =
            router.buyWithEth{value: ethIn}(address(registry), p.token, buyPath, swapped, longWay, buyer, block.timestamp);
        _addFees(f, vm.getRecordedLogs(), p.curve);
        assertEq(out, longWay, string.concat(label, ": the router delivered other than the long way"));
        assertEq(IERC20(p.token).balanceOf(buyer), longWay, string.concat(label, ": the buyer did not receive the tokens"));
        assertEq(IERC20(p.quote).balanceOf(buyer), 0, string.concat(label, ": the asset was left with the buyer"));
        _assertRouterEmpty(p);

        // ---- 2. half of it sold back for ETH, the same as the long way
        uint256 tokensIn = out / 2;
        uint256 ethExpected = _longWaySell(p, sellPath, tokensIn);
        vm.prank(buyer);
        IERC20(p.token).approve(address(router), tokensIn);
        uint256 ethBefore = buyer.balance;
        vm.getRecordedLogs();
        vm.recordLogs();
        vm.prank(buyer);
        uint256 ethOut = router.sellForEth(
            address(registry), p.token, tokensIn, 0, sellPath, ethExpected, buyer, block.timestamp
        );
        _addFees(f, vm.getRecordedLogs(), p.curve);
        assertEq(ethOut, ethExpected, string.concat(label, ": the sale paid other than the long way"));
        assertEq(buyer.balance - ethBefore, ethOut, string.concat(label, ": the sale did not arrive as ETH"));
        assertEq(IERC20(WETH).balanceOf(buyer), 0, string.concat(label, ": the sale paid WETH to a wallet that takes ETH"));
        _assertRouterEmpty(p);

        // ---- 3. the rest of the curve, bought with ETH: it graduates inside
        // the buy, and what the curve did not need comes back to the caller
        // in the asset.
        PonsV2BondingCurve c = PonsV2BondingCurve(p.curve);
        uint256 netLeft = c.graduationThreshold() - c.realQuoteReserve();
        uint256 grossLeft = (netLeft * BPS) / (BPS - TAX_BPS) + 1;
        // ETH FOR IT, from the first buy's rate with a third on top for the
        // price moving across a fill thirty times that size.
        uint256 ethFill = (grossLeft * ethIn * 4) / (swapped * 3);
        vm.getRecordedLogs();
        vm.recordLogs();
        vm.prank(filler);
        router.buyWithEth{value: ethFill}(address(registry), p.token, buyPath, grossLeft, 0, filler, block.timestamp);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        _addFees(f, logs, p.curve);
        assertTrue(c.graduated(), string.concat(label, ": the fill bought with ETH did not graduate the launch"));
        (,, uint256 quoteRefund, uint256 ethRefund) = _bought(logs);
        assertGt(quoteRefund, 0, string.concat(label, ": the fill was not past the threshold - nothing to refund"));
        assertEq(ethRefund, 0, string.concat(label, ": a swap leg came back as ETH"));
        assertEq(IERC20(p.quote).balanceOf(filler), quoteRefund, string.concat(label, ": the refund did not reach the caller"));
        _assertRouterEmpty(p);

        // ---- 4. the pool it opened: this asset, our hook, our tier, a lock
        // that pays the creator
        _assertGraduatedPool(p, a, poolHeldBefore);

        // ---- 5. the fees
        _assertFeesLanded(p, a, f);
    }

    /// EACH LEG EXACT, ON EVERY TRADE. A buy's `quoteIn` is its gross; a
    /// sale's gross is what it paid plus its two legs.
    function _addFees(Fees memory f, Vm.Log[] memory logs, address curve) internal pure {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != curve || logs[i].topics.length == 0) continue;
            bytes32 t0 = logs[i].topics[0];
            if (t0 == CURVE_BUY || t0 == CURVE_SELL) {
                (uint256 x, uint256 y, uint256 fee, uint256 tax) = abi.decode(logs[i].data, (uint256, uint256, uint256, uint256));
                // CurveBuy(quoteIn, tokensOut, fee, tax); CurveSell(tokensIn, quoteOut, fee, tax).
                uint256 gross = t0 == CURVE_BUY ? x : y + fee + tax;
                require(fee == (gross * PLATFORM_BPS) / BPS, "a trade's platform leg is not 50 bps of its gross");
                require(tax == (gross * (TAX_BPS - PLATFORM_BPS)) / BPS, "a trade's creator leg is not 250 bps of its gross");
                f.charged += fee;
                f.taxed += tax;
                f.trades++;
            } else if (t0 == FEES_SWEPT) {
                (uint256 pa, uint256 ba, uint256 ca) = abi.decode(logs[i].data, (uint256, uint256, uint256));
                f.sweptProtocol += pa;
                f.sweptBuyback += ba;
                f.sweptCreator += ca;
            }
        }
    }

    function _assertFeesLanded(Pair memory p, ListedAsset memory a, Fees memory f) internal {
        string memory label = a.label;
        assertEq(f.trades, 3, string.concat(label, ": not three curve trades - a buy, a sale and the fill"));
        assertGt(f.charged, 0, string.concat(label, ": the curve charged the platform nothing"));
        assertGt(f.taxed, 0, string.concat(label, ": the curve charged the creator nothing"));
        assertEq(f.sweptProtocol, f.charged, string.concat(label, ": the sweep handed over other than the platform legs"));
        assertEq(f.sweptCreator, f.taxed, string.concat(label, ": the sweep handed over other than the creator legs"));
        assertEq(f.sweptBuyback, 0, string.concat(label, ": a buyback was swept, and every launch here has it off"));
        PonsV2BondingCurve c = PonsV2BondingCurve(p.curve);
        assertEq(c.quoteFeeBalance(), 0, string.concat(label, ": platform fees were left on the curve"));
        assertEq(c.creatorTaxBalance(), 0, string.concat(label, ": creator fees were left on the curve"));

        FeeEscrow escrow = FeeEscrow(payable(address(CurbLaunchFactory(p.factory).feeEscrow())));
        assertEq(escrow.quoteToken(), a.quote, string.concat(label, ": the factory's escrow is for another asset"));
        assertEq(
            escrow.balanceOfToken(protocolRecipient, a.quote), f.charged,
            string.concat(label, ": the escrow credits the platform other than its legs")
        );
        assertEq(
            escrow.balanceOfToken(creator, a.quote), f.taxed,
            string.concat(label, ": the escrow credits the creator other than its legs")
        );

        // AND EACH CLAIM PAYS IT, IN THE ASSET - not in ether, which only a
        // WETH escrow pays.
        uint256 pBefore = IERC20(a.quote).balanceOf(protocolRecipient);
        uint256 cBefore = IERC20(a.quote).balanceOf(creator);
        uint256 pEth = protocolRecipient.balance;
        vm.prank(protocolRecipient);
        assertEq(escrow.claimToken(a.quote), f.charged, string.concat(label, ": the platform's claim paid another amount"));
        vm.prank(creator);
        assertEq(escrow.claimToken(a.quote), f.taxed, string.concat(label, ": the creator's claim paid another amount"));
        assertEq(IERC20(a.quote).balanceOf(protocolRecipient) - pBefore, f.charged, string.concat(label, ": the platform's claim did not arrive"));
        assertEq(IERC20(a.quote).balanceOf(creator) - cBefore, f.taxed, string.concat(label, ": the creator's claim did not arrive"));
        assertEq(protocolRecipient.balance, pEth, string.concat(label, ": the platform was paid in ether too"));
        emit log_named_decimal_uint(string.concat(label, ": the platform's legs, claimed"), f.charged, a.decimals);
        emit log_named_decimal_uint(string.concat(label, ": the creator's legs, claimed"), f.taxed, a.decimals);
    }

    function _assertGraduatedPool(Pair memory p, ListedAsset memory a, uint256 poolHeldBefore) internal view {
        string memory label = a.label;
        LaunchRegistry.Launch memory rec = registry.launchOf(p.token);
        assertEq(rec.quoteToken, a.quote, string.concat(label, ": the record is on another asset"));
        assertEq(uint256(rec.fee), uint256(POOL_FEE), string.concat(label, ": the pool tier is not ours"));
        assertEq(int256(rec.tickSpacing), int256(TICK_SPACING), string.concat(label, ": the tick spacing is not ours"));
        assertEq(address(rec.hooks), hook, string.concat(label, ": the pool has another hook"));
        assertGt(
            IERC20(a.quote).balanceOf(POOL_MANAGER), poolHeldBefore, string.concat(label, ": no reserve reached the v4 pool")
        );
        uint256 tokenId = IPositionManagerView(POSM).nextTokenId() - 1;
        PositionLock lock = PositionLock(payable(IERC721(POSM).ownerOf(tokenId)));
        assertEq(lock.beneficiary(), creator, string.concat(label, ": the locked position pays someone else"));
    }

    // ================================================================
    // the blacklist question
    // ================================================================

    /// USDC KEEPS A BLACKLIST AND THE ROUTER ASKS IT: a caller and a recipient
    /// Circle's blacklister has listed are refused by name, on the buy and on
    /// the sale, with nothing moved - as on cbBTC and cbXRP (B20Router). And
    /// the same caller, unlisted, trades (the control).
    function test_usdc_aBlacklistedCallerOrRecipientIsRefusedByName() public onlyFork {
        Pair memory p = _launch(_listedAs("USDC"));
        (bytes memory buyPath, bytes memory sellPath) = _route(USDC);
        address blocked = makeAddr("new-quote-asset-blacklisted");
        vm.deal(blocked, 5 ether);
        vm.prank(blocked);
        uint256 held = router.buyWithEth{value: 0.1 ether}(address(registry), p.token, buyPath, 1, 0, blocked, block.timestamp);
        assertGt(held, 0, "the control: an unlisted caller could not buy the USDC pair");

        address blacklister = IFiatTokenBlacklist(USDC).blacklister();
        assertTrue(blacklister != address(0), "USDC names no blacklister");
        vm.prank(blacklister);
        IFiatTokenBlacklist(USDC).blacklist(blocked);
        assertTrue(IFiatTokenBlacklist(USDC).isBlacklisted(blocked), "the premise: the entry is not in force");
        bytes memory refusal = abi.encodeWithSelector(CurbRouter.BlacklistedBy.selector, USDC, blocked);

        // AS CALLER, both ways.
        uint256 ethBefore = blocked.balance;
        vm.prank(blocked);
        vm.expectRevert(refusal);
        router.buyWithEth{value: 0.1 ether}(address(registry), p.token, buyPath, 1, 0, stranger, block.timestamp);
        vm.startPrank(blocked);
        IERC20(p.token).approve(address(router), held);
        vm.expectRevert(refusal);
        router.sellForEth(address(registry), p.token, held, 0, sellPath, 1, stranger, block.timestamp);
        vm.stopPrank();
        assertEq(IERC20(p.token).balanceOf(blocked), held, "a refused sale took tokens");
        assertEq(blocked.balance, ethBefore, "a refused buy cost ETH");

        // AS RECIPIENT, for a caller USDC allows.
        vm.prank(buyer);
        vm.expectRevert(refusal);
        router.buyWithEth{value: 0.1 ether}(address(registry), p.token, buyPath, 1, 0, blocked, block.timestamp);
        _assertRouterEmpty(p);
    }

    /// VIRTUAL AND AERO KEEP NO LIST, AND THE QUESTION DOES NOT STOP THEM.
    /// isBlacklisted is not a function either token has: the call reverts, and
    /// the router reads that as "no list" (the buys and sales above went
    /// through it). Measured here so the premise is a fact, not a reading of
    /// their source: the call fails or answers anything but a true word.
    function test_virtualAndAero_haveNoBlacklistToAsk() public onlyFork {
        address[2] memory plain = [VIRTUAL, AERO];
        for (uint256 i = 0; i < 2; i++) {
            (bool ok, bytes memory ret) = plain[i].staticcall{gas: 100_000}(
                abi.encodeWithSelector(IFiatTokenBlacklist.isBlacklisted.selector, buyer)
            );
            bool listed_ = ok && ret.length >= 32 && abi.decode(ret, (uint256)) == 1;
            assertFalse(listed_, "a plain ERC-20 answered that a fresh wallet is blacklisted");
            assertFalse(ok && ret.length >= 32, "the premise moved: the token answers isBlacklisted now");
        }
    }

    // ================================================================
    // fixture
    // ================================================================

    function _listedAs(string memory label) internal view returns (ListedAsset memory) {
        ListedAsset[] memory all = listed.assets();
        for (uint256 i = 0; i < all.length; i++) {
            if (keccak256(bytes(all[i].label)) == keccak256(bytes(label))) return all[i];
        }
        revert(string.concat("DeployCurb.quoteAssets() does not list ", label));
    }

    function _factory(ListedAsset memory a) internal returns (address) {
        address escrow = vm.deployCode("FeeEscrow.sol:FeeEscrow", abi.encode(a.quote));
        address policy = vm.deployCode("FeePolicy.sol:FeePolicy", abi.encode(protocolRecipient, escrow, MAX_IMPACT_BPS));
        address vault =
            vm.deployCode("PonsV2BuybackVault.sol:PonsV2BuybackVault", abi.encode(address(this), policy, escrow));
        return vm.deployCode(
            "CurbLaunchFactory.sol:CurbLaunchFactory",
            abi.encode(
                address(registry),
                graduator,
                a.quote,
                policy,
                escrow,
                vault,
                CurbLaunchFactory.Terms({
                    supply: SUPPLY,
                    quoteDecimals: a.decimals,
                    phantomQuote: a.phantomQuote,
                    graduationThreshold: a.threshold,
                    poolFee: POOL_FEE,
                    tickSpacing: TICK_SPACING,
                    hooks: IHooks(hook),
                    protocolFeeRecipient: protocolRecipient,
                    maxInternalPriceImpactBps: MAX_IMPACT_BPS,
                    launchFee: 0
                })
            )
        );
    }

    /// The hook's salt, mined against this contract as B20Router mines it.
    function _mineHook(address graduator_) internal returns (address hook_) {
        bytes memory init = abi.encodePacked(
            vm.getCode("FeeHook.sol:FeeHook"),
            abi.encode(POOL_MANAGER, protocolRecipient, address(registry), graduator_, address(this))
        );
        bytes32 initHash = keccak256(init);
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
                | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        for (uint256 salt; salt < 500_000; salt++) {
            address candidate = address(
                uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initHash))))
            );
            if (uint160(candidate) & Hooks.ALL_HOOK_MASK != flags || candidate.code.length != 0) continue;
            assembly ("memory-safe") {
                hook_ := create2(0, add(init, 0x20), mload(init), salt)
            }
            require(hook_ == candidate, "the hook did not deploy to the mined address");
            return hook_;
        }
        revert("no hook salt found");
    }

    /// The asset's factory, admitted after WETH's, and one launch on it.
    function _launch(ListedAsset memory a) internal returns (Pair memory p) {
        address f = _factory(a);
        registry.addLauncher(f);
        (uint16 bps, address to) = CurbLaunchFactory(f).currentPlatformPolicy();
        vm.prank(creator);
        (CurbLaunchToken token, PonsV2BondingCurve curve) = CurbLaunchFactory(f).launch(
            CurbLaunchFactory.LaunchConfig({
                name: a.label,
                symbol: a.label,
                tokenUri: "",
                salt: bytes32(uint256(1)),
                quoteRefundTo: creator,
                totalTaxBps: TAX_BPS,
                devBuy: 0,
                creatorWallet: address(0),
                expectedPlatformBps: bps,
                expectedPlatformRecipient: to,
                holderShareFactory: address(0)
            })
        );
        p = Pair(address(token), address(curve), a.quote, f);
        assertEq(registry.launchOf(p.token).quoteToken, a.quote, "the record names another asset");
        assertEq(CurbLaunchFactory(f).quoteToken(), a.quote, "the factory quotes another asset");
        assertEq(CurbLaunchFactory(f).graduationThreshold(), a.threshold, "the factory carries another threshold");
        assertEq(CurbLaunchFactory(f).phantomQuote(), a.phantomQuote, "the factory carries another phantom");
    }

    /// THE PAGE'S RULE: the pool holding the most of the asset, against WETH
    /// directly or against USDC (reached from WETH through its own deepest
    /// pool). Buy path WETH -> ... -> asset; the sale's is its reverse.
    function _route(address asset) internal view returns (bytes memory buyPath, bytes memory sellPath) {
        (uint24 wTier, uint256 wHeld) = _deepestTier(WETH, asset, asset);
        (uint24 uTier, uint256 uHeld) = asset == USDC ? (uint24(0), uint256(0)) : _deepestTier(USDC, asset, asset);
        require(wHeld != 0 || uHeld != 0, "no v3 pool holds the asset at any tier");
        if (wHeld >= uHeld) {
            buyPath = abi.encodePacked(WETH, wTier, asset);
            sellPath = abi.encodePacked(asset, wTier, WETH);
        } else {
            (uint24 hop,) = _deepestTier(WETH, USDC, USDC);
            buyPath = abi.encodePacked(WETH, hop, USDC, uTier, asset);
            sellPath = abi.encodePacked(asset, uTier, USDC, hop, WETH);
        }
    }

    function _deepestHeld(address asset) internal view returns (uint256) {
        (, uint256 w) = _deepestTier(WETH, asset, asset);
        (, uint256 u) = asset == USDC ? (uint24(0), uint256(0)) : _deepestTier(USDC, asset, asset);
        return w > u ? w : u;
    }

    function _deepestTier(address a, address b, address held_) internal view returns (uint24 best, uint256 most) {
        uint24[4] memory tiers = [uint24(100), 500, 3000, 10000];
        for (uint256 i = 0; i < tiers.length; i++) {
            address pool = IV3FactoryView(V3_FACTORY).getPool(a, b, tiers[i]);
            if (pool == address(0)) continue;
            uint256 held = IERC20(held_).balanceOf(pool);
            if (held > most) {
                most = held;
                best = tiers[i];
            }
        }
    }

    /// THE LONG WAY, ON A SNAPSHOT: swap ETH for the asset by hand, then buy
    /// with exactly what arrived. What arrived, and what the curve gave.
    function _longWayBuy(Pair memory p, bytes memory path, uint256 ethIn)
        internal
        returns (uint256 swapped, uint256 tokens)
    {
        uint256 snap = vm.snapshotState();
        vm.startPrank(buyer);
        swapped = ISwapRouter02Like(SWAP_ROUTER02).exactInput{value: ethIn}(
            ISwapRouter02Like.ExactInputParams({path: path, recipient: buyer, amountIn: ethIn, amountOutMinimum: 0})
        );
        IERC20(p.quote).approve(p.curve, swapped);
        tokens = PonsV2BondingCurve(p.curve).buy(swapped, 0, buyer);
        vm.stopPrank();
        vm.revertToState(snap);
        assertGt(swapped, 0, "the route delivered none of the asset");
        assertGt(tokens, 0, "the long way delivered no tokens");
    }

    /// The sale the long way, on a snapshot: to the curve, then the asset
    /// swapped for WETH. The WETH it came to.
    function _longWaySell(Pair memory p, bytes memory path, uint256 tokensIn) internal returns (uint256 weth) {
        uint256 snap = vm.snapshotState();
        vm.startPrank(buyer);
        IERC20(p.token).approve(p.curve, tokensIn);
        uint256 got = PonsV2BondingCurve(p.curve).sell(tokensIn, 0, buyer);
        IERC20(p.quote).approve(SWAP_ROUTER02, got);
        weth = ISwapRouter02Like(SWAP_ROUTER02).exactInput(
            ISwapRouter02Like.ExactInputParams({path: path, recipient: buyer, amountIn: got, amountOutMinimum: 0})
        );
        vm.stopPrank();
        vm.revertToState(snap);
        assertGt(weth, 0, "the long way sold for nothing");
    }

    /// The router's own account of a buy: BoughtWithEth's last four words.
    function _bought(Vm.Log[] memory logs)
        internal
        view
        returns (uint256 quoteIn, uint256 tokensOut, uint256 quoteRefund, uint256 ethRefund)
    {
        bytes32 sig = keccak256("BoughtWithEth(address,address,address,address,uint256,uint256,uint256,uint256,uint256)");
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(router) || logs[i].topics[0] != sig) continue;
            uint256 ethIn_;
            address registry_;
            (registry_, ethIn_, quoteIn, tokensOut, quoteRefund, ethRefund) =
                abi.decode(logs[i].data, (address, uint256, uint256, uint256, uint256, uint256));
            return (quoteIn, tokensOut, quoteRefund, ethRefund);
        }
        revert("the router emitted no BoughtWithEth");
    }

    /// THE ROUTER HOLDS NOTHING after a call: no ETH, no WETH, no USDC, none
    /// of the asset or the launch token, and no allowance left standing.
    function _assertRouterEmpty(Pair memory p) internal view {
        address r = address(router);
        assertEq(r.balance, 0, "ETH was left in the router");
        assertEq(IERC20(WETH).balanceOf(r), 0, "WETH was left in the router");
        assertEq(IERC20(USDC).balanceOf(r), 0, "USDC was left in the router");
        assertEq(IERC20(p.quote).balanceOf(r), 0, "the quote asset was left in the router");
        assertEq(IERC20(p.token).balanceOf(r), 0, "launch tokens were left in the router");
        assertEq(IERC20(WETH).allowance(r, SWAP_ROUTER02), 0, "a WETH allowance to SwapRouter02 was left standing");
        assertEq(IERC20(p.quote).allowance(r, SWAP_ROUTER02), 0, "an asset allowance to SwapRouter02 was left standing");
        assertEq(IERC20(p.quote).allowance(r, p.curve), 0, "an asset allowance to the curve was left standing");
    }

    function _isB20(address asset) internal view returns (bool) {
        (bool ok, bytes memory ret) = B20_FACTORY.staticcall(abi.encodeWithSignature("isB20(address)", asset));
        require(ok && ret.length == 32, "the B20 factory did not answer");
        return abi.decode(ret, (bool));
    }
}
