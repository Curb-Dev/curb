// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PonsV2BondingCurve} from "../src/vendor/PonsV2BondingCurve.sol";
import {PonsV2BuybackVault} from "../src/vendor/PonsV2BuybackVault.sol";
import {FeePolicySnapshot, IPonsV2FeeEscrow, IPonsV2FeePolicy} from "../src/vendor/interfaces/ILaunchpadV2.sol";
import {IPonsV2LaunchFactoryGraduation} from "../src/vendor/interfaces/ILaunchpadV2Graduation.sol";
import {MockQuoteToken, MockLaunchToken, MockFeeEscrow, MockFeePolicy} from "./mocks/Mocks.sol";

/**
 * @title CurveGraduationTest
 * @notice Graduation at the CURVE level, with this contract playing the
 * factory.
 *
 * Creating the graduated Uniswap pool depends on the venue decision, which is
 * still open. Everything on this side of that boundary does not: the threshold
 * check, the clamped fill and refund when a buy crosses it, fee distribution,
 * reserve handover, trading closure, and refusing a second call.
 *
 * The curve asks its factory to graduate inside a try/catch, so a failing
 * factory is a first-class case rather than a hypothetical - this fixture can
 * fail on demand to exercise it.
 */
contract CurveGraduationTest is Test, IPonsV2LaunchFactoryGraduation {
    uint256 internal constant BPS = 10_000;

    uint256 internal constant SUPPLY = 1_000_000_000e18;
    uint256 internal constant PHANTOM_QUOTE = 30e8;
    uint256 internal constant GRADUATION_THRESHOLD = 10e8;

    uint256 internal constant FEE_BPS = 100;
    uint256 internal constant CREATOR_TAX_BPS = 300;
    uint16 internal constant PROTOCOL_SHARE_BPS = 2000;

    address internal constant PROTOCOL_RECIPIENT = address(0xA11CE);
    address internal constant DEPLOYER = address(0xDEadBeef);
    address internal constant TRADER = address(0xBEEF);
    address internal constant POOL_SEED = address(0x5EED);

    MockQuoteToken internal quote;
    MockLaunchToken internal launchToken;
    MockFeeEscrow internal escrow;
    MockFeePolicy internal policy;
    PonsV2BuybackVault internal vault;
    PonsV2BondingCurve internal curve;

    /// Makes the factory callback revert, so the curve's catch branch runs.
    bool internal factoryShouldFail;
    uint256 internal graduateCalls;

    function setUp() public {
        quote = new MockQuoteToken("Mock NVDA", "mNVDAc", 8);
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
            false,
            GRADUATION_THRESHOLD
        );

        launchToken = new MockLaunchToken(SUPPLY, address(curve));
        curve.initialize(address(launchToken));

        quote.mint(TRADER, 1_000e8);
        vm.prank(TRADER);
        quote.approve(address(curve), type(uint256).max);
    }

    /// The factory callback the curve invokes from _tryAutoGraduate().
    function graduate(address) external {
        graduateCalls++;
        if (factoryShouldFail) revert("factory is down");
        curve.graduate(POOL_SEED);
    }

    // ------------------------------------------------------------------
    // Before the threshold
    // ------------------------------------------------------------------

    function test_graduate_revertsBeforeTheAllocationIsExhausted() public {
        vm.prank(TRADER);
        curve.buy(1e8, 0, TRADER);

        assertFalse(curve.readyToGraduate(), "fixture graduated far too early");

        vm.expectRevert(PonsV2BondingCurve.NotReadyToGraduate.selector);
        curve.graduate(POOL_SEED);
    }

    /// Tested in the ready-but-not-yet-graduated state on purpose. If this ran
    /// after graduation completed, removing onlyFactory entirely would still
    /// leave it passing on AlreadyGraduated - so it would not test access
    /// control at all.
    function test_onlyTheFactoryMayGraduate() public {
        factoryShouldFail = true; // reach the threshold without completing
        _fillToThreshold();

        assertTrue(curve.readyToGraduate(), "precondition: must be ready");
        assertFalse(curve.graduated(), "precondition: must not have graduated");

        vm.expectRevert(PonsV2BondingCurve.NotFactory.selector);
        vm.prank(TRADER);
        curve.graduate(POOL_SEED);
    }

    // ------------------------------------------------------------------
    // Crossing the threshold
    // ------------------------------------------------------------------

    /// A buy larger than the remaining allocation must fill what is left and
    /// refund the rest, rather than reverting or overselling.
    function test_crossingBuy_isClampedAndRefunded() public {
        factoryShouldFail = true; // keep the curve open so state is inspectable

        uint256 sellableBefore = curve.sellableTokens();
        uint256 balanceBefore = quote.balanceOf(TRADER);
        uint256 oversized = 100e8; // far more than the allocation can absorb

        vm.prank(TRADER);
        uint256 tokensOut = curve.buy(oversized, 0, TRADER);

        assertEq(tokensOut, sellableBefore, "the fill was not clamped to the remaining allocation");

        uint256 actuallySpent = balanceBefore - quote.balanceOf(TRADER);
        assertLt(actuallySpent, oversized, "nothing was refunded");
        assertEq(curve.sellableTokens(), 0, "allocation should be exhausted after the clamped fill");
        assertTrue(curve.readyToGraduate(), "curve should be ready to graduate");
    }

    /// Fees on the clamped leg are charged on what was actually spent, not on
    /// what was offered.
    function test_crossingBuy_chargesFeesOnTheSpendNotTheOffer() public {
        factoryShouldFail = true;

        uint256 balanceBefore = quote.balanceOf(TRADER);
        vm.prank(TRADER);
        curve.buy(100e8, 0, TRADER);

        uint256 spent = balanceBefore - quote.balanceOf(TRADER);
        assertEq(curve.quoteFeeBalance(), spent * FEE_BPS / BPS, "fee was not charged on the actual spend");
        assertEq(curve.creatorTaxBalance(), spent * CREATOR_TAX_BPS / BPS, "tax was not charged on the actual spend");
    }

    // ------------------------------------------------------------------
    // Automatic graduation
    // ------------------------------------------------------------------

    function test_autoGraduation_firesWhenTheAllocationIsExhausted() public {
        _fillToThreshold();

        assertEq(graduateCalls, 1, "the curve did not ask its factory to graduate");
        assertTrue(curve.graduated(), "curve did not graduate");
    }

    /// A failing factory must be announced, not swallowed, and must leave the
    /// curve un-graduated so the attempt can be repeated.
    function test_autoGraduation_failureIsAnnouncedAndLeavesCurveOpen() public {
        factoryShouldFail = true;

        vm.recordLogs();
        _fillToThreshold();

        // The counter is 0, not 1, and that is correct: graduateCalls++ ran
        // inside the call that reverted, so it was rolled back with it.
        //
        // Scope that carefully. A launch STUCK waiting to graduate is visible
        // from state - readyToGraduate() true while graduated() is false, which
        // is asserted just below. What state cannot show is that a particular
        // attempt was made and failed; only the event carries that.
        assertEq(graduateCalls, 0, "a reverted call should have rolled its own bookkeeping back");
        assertFalse(curve.graduated(), "a failed graduation must not mark the curve graduated");

        bool sawFailureEvent;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == keccak256("AutoGraduationFailed(address,uint256)")) {
                sawFailureEvent = true;
            }
        }
        assertTrue(sawFailureEvent, "the failure was swallowed instead of announced");
    }

    /// The retry the announcement exists for: once the factory recovers, the
    /// same launch graduates.
    function test_autoGraduation_canBeRetriedAfterAFailure() public {
        factoryShouldFail = true;
        _fillToThreshold();
        assertFalse(curve.graduated(), "precondition: should not have graduated yet");

        // Retry through the FACTORY entry point, not straight into the curve.
        // Calling the curve directly would only show the curve is retryable;
        // the claim is that the flow works once the factory recovers.
        factoryShouldFail = false;
        uint256 callsBefore = graduateCalls;
        this.graduate(address(launchToken));

        assertEq(graduateCalls, callsBefore + 1, "the retry did not go through the factory");
        assertTrue(curve.graduated(), "retry after recovery did not graduate the curve");
    }

    // ------------------------------------------------------------------
    // What graduation does
    // ------------------------------------------------------------------

    function test_graduate_distributesAccruedFees() public {
        factoryShouldFail = true;
        _fillToThreshold();

        uint256 pending = curve.quoteFeeBalance();
        uint256 tax = curve.creatorTaxBalance();
        assertGt(pending, 0, "no fees accrued, so this proves nothing");

        uint256 expectedProtocol = pending * PROTOCOL_SHARE_BPS / BPS;
        uint256 expectedCreator = pending - expectedProtocol + tax;

        factoryShouldFail = false;
        curve.graduate(POOL_SEED);

        assertEq(escrow.tokenCredited(PROTOCOL_RECIPIENT, address(quote)), expectedProtocol, "protocol not paid");
        assertEq(escrow.tokenCredited(DEPLOYER, address(quote)), expectedCreator, "creator not paid");
        assertEq(curve.quoteFeeBalance(), 0, "fee balance not cleared by graduation");
        assertEq(curve.creatorTaxBalance(), 0, "tax balance not cleared by graduation");
    }

    /// The recipient must receive EXACTLY the tracked reserves. "More than
    /// zero" would pass on a short transfer, so the expected amounts are read
    /// off the curve before graduating and compared exactly afterwards.
    function test_graduate_handsTheReservesToTheRecipient() public {
        factoryShouldFail = true;
        _fillToThreshold();

        // What the curve intends to hand over, measured after the sweep that
        // graduation performs first: paying fees reduces trackedQuote.
        uint256 pending = curve.quoteFeeBalance();
        uint256 tax = curve.creatorTaxBalance();
        uint256 protocolAmount = pending * PROTOCOL_SHARE_BPS / BPS;
        uint256 paidOut = protocolAmount + (pending - protocolAmount + tax);

        uint256 expectedQuote = curve.trackedQuote() - paidOut;
        uint256 expectedTokens = curve.trackedTokens();

        factoryShouldFail = false;
        this.graduate(address(launchToken));

        assertEq(quote.balanceOf(POOL_SEED), expectedQuote, "pool seed did not receive exactly the tracked quote");
        assertEq(
            IERC20(address(launchToken)).balanceOf(POOL_SEED),
            expectedTokens,
            "pool seed did not receive exactly the tracked tokens"
        );
        assertEq(curve.trackedQuote(), 0, "curve still tracks quote after handing over");
        assertEq(curve.trackedTokens(), 0, "curve still tracks tokens after handing over");
    }

    /// Quote force-sent to the curve must not be folded into the pool seed -
    /// otherwise a donation could move the price the pool opens at.
    function test_graduate_leavesDonationsStranded() public {
        factoryShouldFail = true;
        _fillToThreshold();

        uint256 donation = 5e8;
        quote.mint(address(curve), donation);

        uint256 pending = curve.quoteFeeBalance();
        uint256 tax = curve.creatorTaxBalance();
        uint256 protocolAmount = pending * PROTOCOL_SHARE_BPS / BPS;
        uint256 paidOut = protocolAmount + (pending - protocolAmount + tax);
        uint256 expectedQuote = curve.trackedQuote() - paidOut;

        factoryShouldFail = false;
        this.graduate(address(launchToken));

        // The two must be accounted separately: the seed gets exactly the
        // tracked reserve, and exactly the donation stays behind.
        assertEq(quote.balanceOf(POOL_SEED), expectedQuote, "the donation leaked into the pool seed");
        assertEq(quote.balanceOf(address(curve)), donation, "the donation did not stay stranded");
    }

    // ------------------------------------------------------------------
    // After graduation
    // ------------------------------------------------------------------

    function test_graduate_closesTrading() public {
        _fillToThreshold();

        vm.expectRevert(PonsV2BondingCurve.CurveGraduated.selector);
        vm.prank(TRADER);
        curve.buy(1e8, 0, TRADER);

        uint256 held = IERC20(address(launchToken)).balanceOf(TRADER);
        vm.startPrank(TRADER);
        IERC20(address(launchToken)).approve(address(curve), held);
        vm.expectRevert(PonsV2BondingCurve.CurveGraduated.selector);
        curve.sell(held, 0, TRADER);
        vm.stopPrank();
    }

    function test_graduate_rejectsASecondCall() public {
        _fillToThreshold();

        vm.expectRevert(PonsV2BondingCurve.AlreadyGraduated.selector);
        curve.graduate(POOL_SEED);
    }

    function test_graduate_closesSweeping() public {
        _fillToThreshold();

        vm.expectRevert(PonsV2BondingCurve.AlreadyGraduated.selector);
        curve.sweepFees(0);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /// Buys enough to exhaust the sellable allocation, which is what actually
    /// triggers graduation - the quote threshold and the token allocation are
    /// the same point by construction.
    function _fillToThreshold() internal {
        vm.prank(TRADER);
        curve.buy(100e8, 0, TRADER);
    }
}
