// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {PonsV2BondingCurveMath as Curve} from "../src/vendor/PonsV2BondingCurveMath.sol";
import {CurveMathHarness} from "./harness/CurveMathHarness.sol";

/**
 * @title CurveMathTest
 * @notice Tests the vendored constant-product LIBRARY. Read the scope limit
 * below before citing any result here as evidence about the product.
 *
 * SCOPE - what this file does and does not prove.
 * These tests exercise PonsV2BondingCurveMath in isolation. They say nothing
 * about how PonsV2BondingCurve actually prices a buy or a sell, because the
 * production contract does not use this library the way these tests do:
 *
 *   buy   fee and creator tax are computed on the quote INPUT and subtracted
 *         before the curve is called, and the curve is called with feeBps = 0
 *   sell  the curve is called with feeBps = 0 to get grossQuoteOut, then fee
 *         and tax are taken OUT OF THE OUTPUT
 *   both  the tradeable reserve excludes accrued fees:
 *         phantomQuote + trackedQuote - quoteFeeBalance - creatorTaxBalance
 *
 * So on the trade paths the library is always called with feeBps = 0. Fee and
 * reserve accounting has to be proven against the real contract, and is not
 * proven here.
 *
 * The parameter is NOT dead, though: PonsV2LaunchFactory._requireQuotable
 * passes the real curveFeeBps into quoteAmountOut as a launch-time
 * sanity check that the configured curve can price a reference buy at all.
 * So test_lib_fee* below does describe a path that runs in production - just
 * that guard, not a trade.
 *
 * The decimal-invariance tests below are likewise about the pure formula with
 * exactly scalable inputs. The real contract floors fee and tax to integers,
 * so small amounts can diverge between an 8- and an 18-decimal quote. That
 * tolerance belongs in the contract-level tests, not here.
 */
contract CurveMathTest is Test {
    uint256 internal constant BPS = 10_000;

    /// 18 decimals -> 8 decimals is exactly ten orders of magnitude.
    uint256 internal constant DEC_SCALE = 1e10;

    /// A launch's token side. Never scaled: the meme token stays 18 decimals
    /// whatever the quote asset is.
    uint256 internal constant TOKEN_RESERVE = 800_000_000e18;

    /// Quote reserve expressed for an 18-decimal quote (e.g. WETH).
    uint256 internal constant QUOTE_RESERVE_18 = 30e18;

    uint256 internal constant FEE_BPS = 100; // 1%

    CurveMathHarness internal harness;

    function setUp() public {
        harness = new CurveMathHarness();
    }

    // ------------------------------------------------------------------
    // The load-bearing claim
    // ------------------------------------------------------------------

    /// Scaling the quote side down by 1e10 must not change how many tokens a
    /// proportionally scaled buy returns.
    function test_lib_quoteDecimalsDoNotChangeTokensOut() public pure {
        uint256 spend18 = 1e18; // 1.0 of an 18-decimal quote
        uint256 spend8 = spend18 / DEC_SCALE; // the same 1.0, at 8 decimals

        uint256 out18 = Curve.getAmountOut(spend18, QUOTE_RESERVE_18, TOKEN_RESERVE, FEE_BPS);
        uint256 out8 = Curve.getAmountOut(spend8, QUOTE_RESERVE_18 / DEC_SCALE, TOKEN_RESERVE, FEE_BPS);

        assertEq(out8, out18, "8-decimal quote priced differently from 18-decimal");
        assertGt(out18, 0, "degenerate fixture");
    }

    /// The same invariance across a spread of trade sizes, including one large
    /// enough to move the curve hard.
    function test_lib_quoteDecimalsInvariant_acrossSizes() public pure {
        uint256[5] memory spends18 = [uint256(1e16), 1e17, 1e18, 5e18, 25e18];

        for (uint256 i = 0; i < spends18.length; i++) {
            uint256 out18 = Curve.getAmountOut(spends18[i], QUOTE_RESERVE_18, TOKEN_RESERVE, FEE_BPS);
            uint256 out8 =
                Curve.getAmountOut(spends18[i] / DEC_SCALE, QUOTE_RESERVE_18 / DEC_SCALE, TOKEN_RESERVE, FEE_BPS);
            assertEq(out8, out18, "decimal invariance broke at some trade size");
        }
    }

    /// Fuzzed, so the claim is not resting on chosen numbers.
    function testFuzz_lib_quoteDecimalsInvariant(uint256 spend18, uint256 quoteReserve18) public pure {
        // Keep both sides exact multiples of the scale factor, which is what
        // "size the economics at 10^8" means in practice.
        spend18 = bound(spend18, 1, 1_000e18) * DEC_SCALE;
        quoteReserve18 = bound(quoteReserve18, 1, 10_000e18) * DEC_SCALE;

        uint256 out18 = Curve.getAmountOut(spend18, quoteReserve18, TOKEN_RESERVE, FEE_BPS);
        uint256 out8 = Curve.getAmountOut(spend18 / DEC_SCALE, quoteReserve18 / DEC_SCALE, TOKEN_RESERVE, FEE_BPS);

        assertEq(out8, out18, "decimal invariance is not universal");
    }

    /// The economics doc claims the SHAPE depends only on
    /// threshold / (threshold + phantomQuote). Same ratio, different absolute
    /// scale, must reach the same fraction of supply.
    function test_lib_curveShapeDependsOnRatioNotScale() public pure {
        // Spend the whole phantom reserve in one trade, at two scales.
        uint256 smallPhantom = 30e8;
        uint256 largePhantom = 30e18;

        uint256 outSmall = Curve.getAmountOut(smallPhantom, smallPhantom, TOKEN_RESERVE, FEE_BPS);
        uint256 outLarge = Curve.getAmountOut(largePhantom, largePhantom, TOKEN_RESERVE, FEE_BPS);

        assertEq(outSmall, outLarge, "shape depended on absolute scale");
    }

    // ------------------------------------------------------------------
    // Fee behaviour
    // ------------------------------------------------------------------

    /// LIBRARY BEHAVIOUR ONLY. The production buy and sell paths pass
    /// feeBps = 0 and handle the fee outside the curve, so this proves a
    /// property of the library, not of a trade. See the scope note above.
    function test_lib_feeReducesOutputMonotonically() public pure {
        uint256 spend = 1e18;
        uint256 prev = type(uint256).max;

        uint16[4] memory fees = [0, 100, 500, 1000];
        for (uint256 i = 0; i < fees.length; i++) {
            uint256 out = Curve.getAmountOut(spend, QUOTE_RESERVE_18, TOKEN_RESERVE, fees[i]);
            assertLt(out, prev, "output did not fall as the fee rose");
            prev = out;
        }
    }

    /// LIBRARY BEHAVIOUR ONLY - see the scope note. Not the product's fee
    /// model: the real buy subtracts fee and tax from the input itself and
    /// then calls the curve with feeBps = 0.
    function test_lib_feeIsEquivalentToShrinkingTheInput() public pure {
        uint256 spend = 1e18;
        uint256 withFee = Curve.getAmountOut(spend, QUOTE_RESERVE_18, TOKEN_RESERVE, FEE_BPS);
        uint256 shrunk = Curve.getAmountOut(spend * (BPS - FEE_BPS) / BPS, QUOTE_RESERVE_18, TOKEN_RESERVE, 0);

        // Not bit-identical: the fee path keeps precision that pre-shrinking
        // loses to integer division. Same to within one wei of output.
        assertApproxEqAbs(withFee, shrunk, 1, "fee is not a clean input haircut");
    }

    // ------------------------------------------------------------------
    // Round trip and no-free-money
    // ------------------------------------------------------------------

    /// getAmountIn must ask for at least what getAmountOut would consume.
    function test_lib_getAmountIn_roundTripsWithoutLoss() public pure {
        uint256 wantTokens = 1_000_000e18;

        uint256 needed = Curve.getAmountIn(wantTokens, QUOTE_RESERVE_18, TOKEN_RESERVE, FEE_BPS);
        uint256 got = Curve.getAmountOut(needed, QUOTE_RESERVE_18, TOKEN_RESERVE, FEE_BPS);

        assertGe(got, wantTokens, "quoted input bought fewer tokens than asked for");
    }

    /// Buying then selling back must never return more quote than was spent.
    function test_lib_roundTripCannotProfit() public pure {
        uint256 spend = 1e18;

        uint256 tokensOut = Curve.getAmountOut(spend, QUOTE_RESERVE_18, TOKEN_RESERVE, FEE_BPS);
        uint256 quoteBack = Curve.getAmountOut(tokensOut, TOKEN_RESERVE - tokensOut, QUOTE_RESERVE_18 + spend, FEE_BPS);

        assertLt(quoteBack, spend, "buy-then-sell returned a profit");
    }

    // ------------------------------------------------------------------
    // Failure paths
    // ------------------------------------------------------------------

    function test_lib_revertsOnZeroInput() public {
        vm.expectRevert(Curve.InsufficientInputAmount.selector);
        harness.getAmountOut(0, QUOTE_RESERVE_18, TOKEN_RESERVE, FEE_BPS);
    }

    function test_lib_revertsOnEmptyReserve() public {
        vm.expectRevert(Curve.InsufficientLiquidity.selector);
        harness.getAmountOut(1e18, 0, TOKEN_RESERVE, FEE_BPS);
    }

    /// A dust trade against a huge reserve rounds to zero out, and that must
    /// revert rather than silently take the input.
    function test_lib_revertsWhenOutputRoundsToZero() public {
        vm.expectRevert(Curve.InsufficientOutputAmount.selector);
        harness.getAmountOut(1, type(uint128).max, 1, FEE_BPS);
    }

    /// A 100% fee has no input that produces output.
    function test_lib_getAmountIn_revertsAtFullFee() public {
        vm.expectRevert(Curve.InsufficientLiquidity.selector);
        harness.getAmountIn(1e18, QUOTE_RESERVE_18, TOKEN_RESERVE, BPS);
    }

    /// getAmountIn cannot promise more output than the reserve holds.
    function test_lib_getAmountIn_revertsBeyondReserve() public {
        vm.expectRevert(Curve.InsufficientLiquidity.selector);
        harness.getAmountIn(TOKEN_RESERVE, QUOTE_RESERVE_18, TOKEN_RESERVE, FEE_BPS);
    }

    /// quoteAmountOut is the non-reverting variant: same answer, or zero.
    function test_lib_quoteAmountOut_returnsZeroInsteadOfReverting() public pure {
        assertEq(Curve.quoteAmountOut(0, QUOTE_RESERVE_18, TOKEN_RESERVE, FEE_BPS), 0);
        assertEq(Curve.quoteAmountOut(1e18, 0, TOKEN_RESERVE, FEE_BPS), 0);
        assertEq(Curve.quoteAmountOut(1e18, QUOTE_RESERVE_18, TOKEN_RESERVE, BPS), 0);

        assertEq(
            Curve.quoteAmountOut(1e18, QUOTE_RESERVE_18, TOKEN_RESERVE, FEE_BPS),
            Curve.getAmountOut(1e18, QUOTE_RESERVE_18, TOKEN_RESERVE, FEE_BPS),
            "quote and revert variants disagree on a valid trade"
        );
    }
}
