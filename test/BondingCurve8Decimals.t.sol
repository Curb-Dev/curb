// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PonsV2BondingCurve} from "../src/vendor/PonsV2BondingCurve.sol";
import {PonsV2BuybackVault} from "../src/vendor/PonsV2BuybackVault.sol";
import {FeePolicySnapshot, IPonsV2FeeEscrow, IPonsV2FeePolicy} from "../src/vendor/interfaces/ILaunchpadV2.sol";
import {MockQuoteToken, MockLaunchToken, MockFeeEscrow, MockFeePolicy} from "./mocks/Mocks.sol";

/**
 * @title BondingCurve8DecimalsTest
 * @notice Exercises the REAL PonsV2BondingCurve against an 8-decimal quote
 * asset, standing in for NVDAc.
 *
 * This is the test CurveMath.t.sol explicitly does not provide. Its scope note
 * says fee and reserve accounting must be proven against the contract, because
 * the library is called with feeBps = 0 on both trade paths and the fee is
 * applied outside it - on the INPUT when buying, on the OUTPUT when selling.
 * Those are the claims checked here.
 *
 * Boundaries kept deliberate:
 *   - Approving a quote asset for the platform is a FACTORY concern and is not
 *     tested here.
 *   - ERC-20 allowance behaviour is the token's concern, not the curve's.
 *   - Creating the graduated Uniswap pool needs the factory and the venue, so
 *     that is out of scope. The CURVE's own graduate() is NOT: threshold
 *     check, fee distribution, reserve handover, trading closure and repeat
 *     rejection are all reachable from here, since this contract already
 *     plays the factory role. Those tests come next.
 */
contract BondingCurve8DecimalsTest is Test {
    uint256 internal constant BPS = 10_000;

    /// NVDAc is 8 decimals. This is the whole point of the fixture.
    uint8 internal constant QUOTE_DECIMALS = 8;

    uint256 internal constant SUPPLY = 1_000_000_000e18;
    /// Sized at the quote asset's own scale, per PairTokenEconomics.
    uint256 internal constant PHANTOM_QUOTE = 30e8;
    uint256 internal constant GRADUATION_THRESHOLD = 10e8;

    uint256 internal constant FEE_BPS = 100; // 1%
    uint256 internal constant CREATOR_TAX_BPS = 300; // 3%
    uint16 internal constant PROTOCOL_SHARE_BPS = 2000; // 20% of the fee

    address internal constant PROTOCOL_RECIPIENT = address(0xA11CE);
    address internal constant DEPLOYER = address(0xDEadBeef);
    address internal constant TRADER = address(0xBEEF);

    MockQuoteToken internal quote;
    MockLaunchToken internal launchToken;
    MockFeeEscrow internal escrow;
    MockFeePolicy internal policy;
    PonsV2BuybackVault internal vault;
    PonsV2BondingCurve internal curve;

    function setUp() public {
        quote = new MockQuoteToken("Mock NVDA", "mNVDAc", QUOTE_DECIMALS);
        escrow = new MockFeeEscrow();

        FeePolicySnapshot memory snapshot = FeePolicySnapshot({
            protocolFeeRecipient: PROTOCOL_RECIPIENT,
            protocolFeeShareBps: PROTOCOL_SHARE_BPS,
            buybackBurnBps: 0,
            hookFeeBps: 0,
            maxInternalPriceImpactBps: 500
        });
        policy = new MockFeePolicy(snapshot, address(escrow), address(this));
        vault =
            new PonsV2BuybackVault(address(this), IPonsV2FeePolicy(address(policy)), IPonsV2FeeEscrow(address(escrow)));

        // This test contract acts as both deployer and factory, so it may call
        // the curve's onlyFactory initialize().
        curve = new PonsV2BondingCurve(
            address(quote),
            DEPLOYER,
            address(this),
            IPonsV2FeePolicy(address(policy)),
            snapshot,
            IPonsV2FeeEscrow(address(escrow)),
            vault,
            PHANTOM_QUOTE,
            FEE_BPS,
            CREATOR_TAX_BPS,
            false, // buyback disabled - our plan turns it off at launch
            GRADUATION_THRESHOLD
        );

        launchToken = new MockLaunchToken(SUPPLY, address(curve));
        curve.initialize(address(launchToken));

        quote.mint(TRADER, 1_000e8);
        vm.prank(TRADER);
        quote.approve(address(curve), type(uint256).max);
    }

    // ------------------------------------------------------------------
    // The fixture itself
    // ------------------------------------------------------------------

    /// An 8-decimal quote asset is accepted and the curve is quotable with it.
    function test_curveAcceptsAn8DecimalQuoteAsset() public view {
        assertEq(quote.decimals(), 8, "fixture is not 8 decimals");
        assertFalse(curve.isNativeQuote(), "curve thinks this is a native launch");

        (uint256 quoteReserve, uint256 tokenReserve) = curve.getReserves();
        assertEq(quoteReserve, PHANTOM_QUOTE, "opening quote reserve is not the phantom reserve");
        assertGt(tokenReserve, 0, "no token reserve");
    }

    // ------------------------------------------------------------------
    // Buy: fee comes off the INPUT
    // ------------------------------------------------------------------

    /// A buy must charge fee and creator tax on the quote spent, not on the
    /// tokens received, and must bank both away from the tradeable reserve.
    function test_buy_takesFeeFromTheInput() public {
        uint256 spend = 1e8; // 1.0 of an 8-decimal quote

        (uint256 quoteReserveBefore,) = curve.getReserves();

        vm.prank(TRADER);
        uint256 tokensOut = curve.buy(spend, 0, TRADER);

        uint256 expectedFee = spend * FEE_BPS / BPS;
        uint256 expectedTax = spend * CREATOR_TAX_BPS / BPS;

        assertEq(curve.quoteFeeBalance(), expectedFee, "protocol fee not accrued from the input");
        assertEq(curve.creatorTaxBalance(), expectedTax, "creator tax not accrued from the input");

        // The reserve grew by the net only: accrued fees are excluded from it.
        (uint256 quoteReserveAfter,) = curve.getReserves();
        assertEq(
            quoteReserveAfter - quoteReserveBefore,
            spend - expectedFee - expectedTax,
            "reserve moved by the gross spend, so fees are not segregated"
        );

        assertGt(tokensOut, 0, "buy returned nothing");
        assertEq(IERC20(address(launchToken)).balanceOf(TRADER), tokensOut, "tokens not delivered");
    }

    /// Raising the fee must reduce tokens received for the same spend.
    function test_buy_higherFeeBuysFewerTokens() public {
        uint256 spend = 1e8;

        vm.prank(TRADER);
        uint256 tokensAtOnePercent = curve.buy(spend, 0, TRADER);

        // A second, identical curve with a fatter fee.
        PonsV2BondingCurve pricier = _freshCurve(500, CREATOR_TAX_BPS);
        quote.mint(TRADER, spend);
        vm.startPrank(TRADER);
        quote.approve(address(pricier), type(uint256).max);
        uint256 tokensAtFivePercent = pricier.buy(spend, 0, TRADER);
        vm.stopPrank();

        assertLt(tokensAtFivePercent, tokensAtOnePercent, "a higher fee did not cost the buyer tokens");
    }

    // ------------------------------------------------------------------
    // Sell: fee comes off the OUTPUT
    // ------------------------------------------------------------------

    /// A sell prices the tokens first and then takes fee and tax out of the
    /// quote produced - the opposite side from a buy.
    function test_sell_takesFeeFromTheOutput() public {
        uint256 spend = 10e8;

        vm.prank(TRADER);
        uint256 tokensOut = curve.buy(spend, 0, TRADER);

        uint256 feeAfterBuy = curve.quoteFeeBalance();
        uint256 taxAfterBuy = curve.creatorTaxBalance();

        vm.startPrank(TRADER);
        IERC20(address(launchToken)).approve(address(curve), tokensOut);
        uint256 quoteOut = curve.sell(tokensOut, 0, TRADER);
        vm.stopPrank();

        uint256 sellFee = curve.quoteFeeBalance() - feeAfterBuy;
        uint256 sellTax = curve.creatorTaxBalance() - taxAfterBuy;

        // Reconstruct the gross the curve must have computed before charging.
        uint256 gross = quoteOut + sellFee + sellTax;
        assertEq(sellFee, gross * FEE_BPS / BPS, "sell fee was not taken off the gross output");
        assertEq(sellTax, gross * CREATOR_TAX_BPS / BPS, "sell tax was not taken off the gross output");

        assertEq(quote.balanceOf(TRADER), 1_000e8 - spend + quoteOut, "trader was not paid the net");
    }

    /// Buying and immediately selling back must lose money, since both legs
    /// are taxed on opposite sides.
    function test_roundTripLosesTheFeeOnBothLegs() public {
        uint256 spend = 10e8;
        uint256 balanceBefore = quote.balanceOf(TRADER);

        vm.startPrank(TRADER);
        uint256 tokensOut = curve.buy(spend, 0, TRADER);
        IERC20(address(launchToken)).approve(address(curve), tokensOut);
        curve.sell(tokensOut, 0, TRADER);
        vm.stopPrank();

        assertLt(quote.balanceOf(TRADER), balanceBefore, "a round trip did not cost anything");
    }

    // ------------------------------------------------------------------
    // Reserve segregation
    // ------------------------------------------------------------------

    /// Accrued fees must never be tradeable: the reserve the curve prices
    /// against has to exclude them, however much has piled up.
    function test_accruedFeesAreNotTradeable() public {
        for (uint256 i = 0; i < 5; i++) {
            vm.prank(TRADER);
            curve.buy(1e8, 0, TRADER);
        }

        uint256 banked = curve.quoteFeeBalance() + curve.creatorTaxBalance();
        assertGt(banked, 0, "no fees accrued, so this proves nothing");

        (uint256 quoteReserve,) = curve.getReserves();
        uint256 held = quote.balanceOf(address(curve));

        assertEq(quoteReserve, PHANTOM_QUOTE + held - banked, "reserve does not exclude the accrued fees");
    }

    // ------------------------------------------------------------------
    // 8 vs 18 decimals, at contract level
    // ------------------------------------------------------------------

    /// CurveMath.t.sol proves the pure formula is scale invariant. The contract
    /// floors fee and tax to integers, so a divergence is only possible when
    /// the fee legs do NOT divide exactly. A spend of 1e8 divides cleanly at
    /// both 1% and 3% and would pass this test without exercising anything, so
    /// the input below is deliberately indivisible.
    function test_8vs18Decimals_buy_agreeWithinRounding() public {
        // 12_345_679 * 100 / 10_000 = 123_456.79 -> floors, losing 0.79
        // 12_345_679 * 300 / 10_000 = 370_370.37 -> floors, losing 0.37
        uint256 spend8 = 12_345_679;
        assertTrue(spend8 * FEE_BPS % BPS != 0, "fixture divides exactly, so it tests nothing");
        assertTrue(spend8 * CREATOR_TAX_BPS % BPS != 0, "fixture divides exactly, so it tests nothing");

        vm.prank(TRADER);
        uint256 tokensFrom8 = curve.buy(spend8, 0, TRADER);

        (PonsV2BondingCurve curve18,) = _scaledUpLaunch();
        vm.startPrank(TRADER);
        uint256 tokensFrom18 = curve18.buy(spend8 * 1e10, 0, TRADER);
        vm.stopPrank();

        // TOLERANCE, justified rather than guessed. The 18-decimal side has
        // 1e10 more precision, so its fee legs floor away nothing at this
        // size. The 8-decimal side loses under one unit on each of two legs,
        // out of a spend of ~1.2e7 - so under 2/1.2e7, i.e. ~1.6e-7 relative.
        // 1e-6 is the next round number above that.
        assertApproxEqRel(tokensFrom8, tokensFrom18, 1e12, "buy: 8 and 18 decimals diverge beyond rounding");
    }

    /// The same comparison in the sell direction, where the fee comes off the
    /// output instead of the input.
    function test_8vs18Decimals_sell_agreeWithinRounding() public {
        uint256 spend8 = 12_345_679;

        vm.prank(TRADER);
        uint256 tokens8 = curve.buy(spend8, 0, TRADER);

        (PonsV2BondingCurve curve18,) = _scaledUpLaunch();
        vm.prank(TRADER);
        uint256 tokens18 = curve18.buy(spend8 * 1e10, 0, TRADER);

        // Sell the smaller of the two positions on both curves, so the trade
        // is identical in token terms.
        uint256 sellAmount = tokens8 < tokens18 ? tokens8 : tokens18;

        vm.startPrank(TRADER);
        IERC20(address(launchToken)).approve(address(curve), sellAmount);
        uint256 quoteBack8 = curve.sell(sellAmount, 0, TRADER);
        IERC20(curve18.token()).approve(address(curve18), sellAmount);
        uint256 quoteBack18 = curve18.sell(sellAmount, 0, TRADER);
        vm.stopPrank();

        // Scale the 8-decimal proceeds up to compare like with like.
        assertApproxEqRel(quoteBack8 * 1e10, quoteBack18, 1e12, "sell: 8 and 18 decimals diverge beyond rounding");
    }

    /// Flooring the fee legs means the trader pays slightly LESS than the exact
    /// fraction, so rounding does favour them - the protocol and creator eat
    /// the remainder. What must hold is that no value is created or destroyed:
    /// every unit spent is either fee, tax, or reserve.
    function test_smallTrade_reserveAccountingHolds() public {
        // Boundaries around where each floored leg first becomes non-zero.
        // fee  = spend / 100      -> first 1 at spend = 100
        // tax  = spend * 3 / 100  -> first 1 at spend = 34
        uint256[4] memory spends = [uint256(33), 34, 99, 100];

        for (uint256 i = 0; i < spends.length; i++) {
            PonsV2BondingCurve fresh = _freshCurve(FEE_BPS, CREATOR_TAX_BPS);
            quote.mint(TRADER, spends[i]);
            vm.startPrank(TRADER);
            quote.approve(address(fresh), type(uint256).max);

            (uint256 reserveBefore,) = fresh.getReserves();
            fresh.buy(spends[i], 0, TRADER);
            vm.stopPrank();

            uint256 fee = fresh.quoteFeeBalance();
            uint256 tax = fresh.creatorTaxBalance();
            (uint256 reserveAfter,) = fresh.getReserves();

            assertEq(fee, spends[i] * FEE_BPS / BPS, "fee leg did not floor as expected");
            assertEq(tax, spends[i] * CREATOR_TAX_BPS / BPS, "tax leg did not floor as expected");
            assertEq(reserveAfter - reserveBefore, spends[i] - fee - tax, "value went missing on a dust trade");
        }
    }

    /// Pin the arithmetic the previous test's boundaries rest on, so a future
    /// change to the fee constants cannot quietly invalidate them.
    function test_dustFeeLegsFloorAsDocumented() public pure {
        assertEq(uint256(50) * FEE_BPS / BPS, 0, "1% of 50 should floor to 0");
        assertEq(uint256(50) * CREATOR_TAX_BPS / BPS, 1, "3% of 50 should floor to 1, not 0");
    }

    // ------------------------------------------------------------------
    // Fee DISTRIBUTION - accrual was covered above, payout was not
    // ------------------------------------------------------------------

    /// The sweep splits the protocol fee by protocolFeeShareBps, hands the
    /// remainder plus the whole creator tax to the deployer, and credits both
    /// through the escrow.
    function test_sweepFees_splitsProtocolAndCreator() public {
        vm.prank(TRADER);
        curve.buy(2e8, 0, TRADER);

        uint256 pending = curve.quoteFeeBalance();
        uint256 tax = curve.creatorTaxBalance();
        assertGt(pending, 0, "no fee accrued, so the sweep proves nothing");

        uint256 expectedProtocol = pending * PROTOCOL_SHARE_BPS / BPS;
        // The creator tax bypasses the split entirely and is paid in full.
        uint256 expectedCreator = pending - expectedProtocol + tax;

        curve.sweepFees(0);

        assertEq(
            escrow.tokenCredited(PROTOCOL_RECIPIENT, address(quote)),
            expectedProtocol,
            "protocol was not credited its share of the fee"
        );
        assertEq(
            escrow.tokenCredited(DEPLOYER, address(quote)),
            expectedCreator,
            "creator was not credited the rest of the fee plus the whole tax"
        );
        assertEq(
            quote.balanceOf(address(escrow)), expectedProtocol + expectedCreator, "escrow did not receive the quote"
        );
    }

    /// Sweeping must clear the accrued balances.
    function test_sweepFees_clearsAccruedBalances() public {
        vm.prank(TRADER);
        curve.buy(2e8, 0, TRADER);

        curve.sweepFees(0);

        assertEq(curve.quoteFeeBalance(), 0, "protocol fee balance not cleared");
        assertEq(curve.creatorTaxBalance(), 0, "creator tax balance not cleared");
    }

    /// The load-bearing invariant, SCOPED TO buybackEnabled = false, which is
    /// our MVP setting. Accrued fees were already excluded from the reserve and
    /// the sweep reduces trackedQuote by exactly what it pays, so the reserve
    /// comes out unchanged. With buyback ON this does NOT hold: the buyback
    /// spends part of the fee against the curve's own reserve and moves both
    /// sides. Re-establish this separately if buyback is ever enabled.
    function test_sweepFees_doesNotMoveTheReserve() public {
        vm.prank(TRADER);
        curve.buy(2e8, 0, TRADER);

        (uint256 quoteReserveBefore, uint256 tokenReserveBefore) = curve.getReserves();

        curve.sweepFees(0);

        (uint256 quoteReserveAfter, uint256 tokenReserveAfter) = curve.getReserves();
        assertEq(quoteReserveAfter, quoteReserveBefore, "paying fees out moved the quote reserve");
        assertEq(tokenReserveAfter, tokenReserveBefore, "paying fees out moved the token reserve");
    }

    /// A buy priced after a sweep must match one priced before it. Same scope
    /// as above: buyback disabled.
    function test_sweepFees_doesNotChangeThePriceATraderGets() public {
        vm.prank(TRADER);
        curve.buy(2e8, 0, TRADER);

        uint256 probe = 1e8;

        uint256 snapshot = vm.snapshotState();
        vm.prank(TRADER);
        uint256 tokensWithoutSweep = curve.buy(probe, 0, TRADER);
        vm.revertToState(snapshot);

        curve.sweepFees(0);
        vm.prank(TRADER);
        uint256 tokensAfterSweep = curve.buy(probe, 0, TRADER);

        assertEq(tokensAfterSweep, tokensWithoutSweep, "the sweep changed what the next buyer receives");
    }

    /// Only the sweep operator or the deployer may sweep.
    function test_sweepFees_rejectsStrangers() public {
        vm.prank(TRADER);
        curve.buy(2e8, 0, TRADER);

        vm.expectRevert(PonsV2BondingCurve.NotFeeSweepOperator.selector);
        vm.prank(TRADER);
        curve.sweepFees(0);

        // The deployer is allowed even though it is not the operator.
        vm.prank(DEPLOYER);
        curve.sweepFees(0);
        assertEq(curve.quoteFeeBalance(), 0, "deployer should have been able to sweep");
    }

    /// Sweeping with nothing accrued is a no-op, not a revert.
    function test_sweepFees_withNothingAccruedIsHarmless() public {
        (uint256 reserveBefore,) = curve.getReserves();
        curve.sweepFees(0);
        (uint256 reserveAfter,) = curve.getReserves();

        assertEq(reserveAfter, reserveBefore, "an empty sweep still moved the reserve");
        assertEq(quote.balanceOf(address(escrow)), 0, "an empty sweep credited something");
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /// The same launch economics quoted in an 18-decimal asset, with the
    /// trader funded and approved.
    function _scaledUpLaunch() internal returns (PonsV2BondingCurve curve18, MockQuoteToken quote18) {
        quote18 = new MockQuoteToken("Mock NVDA 18", "mNVDAc18", 18);
        curve18 = _freshCurveWithQuote(address(quote18), PHANTOM_QUOTE * 1e10, GRADUATION_THRESHOLD * 1e10);
        quote18.mint(TRADER, 1_000e18);
        vm.prank(TRADER);
        quote18.approve(address(curve18), type(uint256).max);
    }

    function _freshCurve(uint256 feeBps, uint256 taxBps) internal returns (PonsV2BondingCurve fresh) {
        fresh = _deploy(address(quote), PHANTOM_QUOTE, GRADUATION_THRESHOLD, feeBps, taxBps);
    }

    function _freshCurveWithQuote(address quoteToken, uint256 phantom, uint256 threshold)
        internal
        returns (PonsV2BondingCurve fresh)
    {
        fresh = _deploy(quoteToken, phantom, threshold, FEE_BPS, CREATOR_TAX_BPS);
    }

    function _deploy(address quoteToken, uint256 phantom, uint256 threshold, uint256 feeBps, uint256 taxBps)
        private
        returns (PonsV2BondingCurve fresh)
    {
        FeePolicySnapshot memory snapshot = FeePolicySnapshot({
            protocolFeeRecipient: PROTOCOL_RECIPIENT,
            protocolFeeShareBps: PROTOCOL_SHARE_BPS,
            buybackBurnBps: 0,
            hookFeeBps: 0,
            maxInternalPriceImpactBps: 500
        });
        fresh = new PonsV2BondingCurve(
            quoteToken,
            DEPLOYER,
            address(this),
            IPonsV2FeePolicy(address(policy)),
            snapshot,
            IPonsV2FeeEscrow(address(escrow)),
            vault,
            phantom,
            feeBps,
            taxBps,
            false,
            threshold
        );
        fresh.initialize(address(new MockLaunchToken(SUPPLY, address(fresh))));
    }
}
