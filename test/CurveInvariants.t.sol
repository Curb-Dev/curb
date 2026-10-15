// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PonsV2BondingCurve} from "../src/vendor/PonsV2BondingCurve.sol";
import {PonsV2BuybackVault} from "../src/vendor/PonsV2BuybackVault.sol";
import {FeePolicySnapshot, IPonsV2FeeEscrow, IPonsV2FeePolicy} from "../src/vendor/interfaces/ILaunchpadV2.sol";
import {IPonsV2LaunchFactoryGraduation} from "../src/vendor/interfaces/ILaunchpadV2Graduation.sol";
import {MockQuoteToken, MockLaunchToken, MockFeeEscrow, MockFeePolicy} from "./mocks/Mocks.sol";

/**
 * @notice Drives random sequences of buys, sells, sweeps and donations, and
 * counts how many of each ACTUALLY succeeded.
 *
 * The counters are not decoration. An invariant run where every call reverts
 * satisfies every invariant trivially, and would report green while proving
 * nothing. afterInvariant() below refuses that outcome.
 */
contract CurveHandler is Test, IPonsV2LaunchFactoryGraduation {
    /// Not immutable: the curve needs this handler's address as its factory,
    /// so the handler has to exist first. Wired once, then frozen.
    PonsV2BondingCurve public curve;
    MockQuoteToken public immutable quote;
    address public immutable poolSeed;

    address internal constant TRADER = address(0xBEEF);

    uint256 public buys;
    uint256 public sells;
    uint256 public sweeps;
    /// Sweeps that actually moved money. An empty sweep is a no-op by design,
    /// so counting it as a success would let the fee-distribution path go
    /// entirely unexercised while the counter still looked healthy.
    uint256 public feePayingSweeps;
    uint256 public graduations;

    /// Reverts the handler did not expect. `catch {}` hides everything, so
    /// anything outside the small expected set is recorded here and fails the
    /// run in afterInvariant(). Without this, "reverts: 0" only means the
    /// HANDLER did not revert - the curve underneath could be failing on every
    /// single call.
    uint256 public unexpectedReverts;
    bytes4 public firstUnexpectedSelector;

    /// Quote sent to the curve outside the trading path. Tracked here so the
    /// accounting invariant can hold it separate from the tradeable reserve.
    uint256 public donatedQuote;

    constructor(MockQuoteToken quote_, address poolSeed_) {
        quote = quote_;
        poolSeed = poolSeed_;
    }

    /// Wires in the curve after it has been deployed against this address.
    /// Deliberately one-shot so a fuzz run cannot repoint the handler.
    function setCurve(PonsV2BondingCurve curve_) external {
        require(address(curve) == address(0), "curve already wired");
        curve = curve_;
    }

    function graduate(address) external {
        graduations++;
        curve.graduate(poolSeed);
    }

    /// A dust trade priced to zero output is a legitimate refusal, not a bug.
    /// Everything else is unexpected until proven otherwise.
    function _record(bytes memory err) private {
        bytes4 selector;
        if (err.length >= 4) {
            selector = bytes4(err);
        }
        if (selector == PonsV2BondingCurve.ZeroAmount.selector) return;
        if (selector == bytes4(keccak256("InsufficientOutputAmount()"))) return;
        if (selector == bytes4(keccak256("InsufficientInputAmount()"))) return;
        if (selector == bytes4(keccak256("InsufficientLiquidity()"))) return;

        if (unexpectedReverts == 0) firstUnexpectedSelector = selector;
        unexpectedReverts++;
    }

    function buy(uint256 amount) external {
        if (curve.graduated() || curve.readyToGraduate()) return;
        // Deliberately small relative to the ~10e8 needed to graduate. An
        // earlier version allowed up to 5e8, which exhausted the allocation in
        // two or three calls and left the sell path almost unreachable - the
        // coverage guard in afterInvariant() is what caught that.
        amount = bound(amount, 1e4, 1e7);
        quote.mint(TRADER, amount);

        vm.startPrank(TRADER);
        quote.approve(address(curve), amount);
        try curve.buy(amount, 0, TRADER) {
            buys++;
        } catch (bytes memory err) {
            _record(err);
        }
        vm.stopPrank();
    }

    function sell(uint256 amount) external {
        if (curve.graduated() || curve.readyToGraduate()) return;
        uint256 held = IERC20(curve.token()).balanceOf(TRADER);
        if (held == 0) return;
        amount = bound(amount, 1, held);

        vm.startPrank(TRADER);
        IERC20(curve.token()).approve(address(curve), amount);
        try curve.sell(amount, 0, TRADER) {
            sells++;
        } catch (bytes memory err) {
            _record(err);
        }
        vm.stopPrank();
    }

    function sweep() external {
        if (curve.graduated()) return;
        uint256 owed = curve.quoteFeeBalance() + curve.creatorTaxBalance();
        try curve.sweepFees(0) {
            sweeps++;
            if (owed > 0) feePayingSweeps++;
        } catch (bytes memory err) {
            _record(err);
        }
    }

    /// A BUY BIG ENOUGH TO FINISH A LAUNCH, deliberately a separate action
    /// rather than a wider bound on buy().
    ///
    /// MEASURED BEFORE IT EXISTED: zero graduations in a 128,000-call
    /// campaign, so every assertion about the post-graduation regime was
    /// passing by never being reached. A balanced walk of 1e7 buys and sells
    /// does not drift the hundred net steps a 10e8 threshold needs.
    ///
    /// WIDENING buy() WOULD HAVE COST THE OTHER HALF. The comment on buy()
    /// records what happened when it allowed 5e8: the allocation was gone in
    /// two or three calls and the sell path became almost unreachable. Two
    /// actions keep both.
    function fill(uint256 amount) external {
        // FILL WAITS UNTIL THE SELL PATH HAS ACTUALLY RUN. Without this gate
        // a campaign graduates in its first three or four calls and sells
        // become unreachable for the rest of it - measured at ZERO sells,
        // which is the failure the handler's own comment on buy() warned
        // about from the other direction. Shaping WHEN an action fires is
        // harness design; none of the invariants below know about it.
        // AND UNTIL FEES HAVE BEEN SWEPT AT LEAST ONCE. Gating on sells alone
        // left campaigns that graduated before any sweep ever ran - measured,
        // one of six. Graduation closes both paths, so fill has to wait for
        // both to have happened rather than for whichever came first.
        if (sells < 3 || feePayingSweeps < 1) return;
        if (curve.graduated() || curve.readyToGraduate()) return;
        amount = bound(amount, 1e8, 4e8);
        quote.mint(TRADER, amount);

        vm.startPrank(TRADER);
        quote.approve(address(curve), amount);
        try curve.buy(amount, 0, TRADER) {
            buys++;
        } catch (bytes memory err) {
            _record(err);
        }
        vm.stopPrank();
    }

    /// Force quote into the curve outside any trade, which the contract is
    /// explicitly designed to leave stranded.
    function donate(uint256 amount) external {
        amount = bound(amount, 1, 1e8);
        quote.mint(address(curve), amount);
        donatedQuote += amount;
    }
}

/**
 * @title CurveInvariantsTest
 * @notice The accounting identities the curve must hold across any sequence of
 * operations, rather than after a single one.
 *
 * Pre- and post-graduation are different regimes and are asserted separately:
 * graduation hands the tradeable reserves away, so the balance identity that
 * holds while trading is deliberately not the one that holds afterwards.
 */
contract CurveInvariantsTest is Test {
    uint256 internal constant SUPPLY = 1_000_000_000e18;
    uint256 internal constant PHANTOM_QUOTE = 30e8;
    uint256 internal constant GRADUATION_THRESHOLD = 10e8;
    uint256 internal constant FEE_BPS = 100;
    uint256 internal constant CREATOR_TAX_BPS = 300;
    uint16 internal constant PROTOCOL_SHARE_BPS = 2000;

    address internal constant PROTOCOL_RECIPIENT = address(0xA11CE);
    address internal constant DEPLOYER = address(0xDEadBeef);
    address internal constant POOL_SEED = address(0x5EED);

    MockQuoteToken internal quote;
    MockLaunchToken internal launchToken;
    MockFeeEscrow internal escrow;
    PonsV2BondingCurve internal curve;
    CurveHandler internal handler;

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

        // The handler is the factory, so auto-graduation routes through it.
        // It is deployed first and wired afterwards, rather than predicting an
        // address from a nonce - that arithmetic breaks the moment anything
        // else is deployed in setUp.
        handler = new CurveHandler(quote, POOL_SEED);
        address handlerAddress = address(handler);

        MockFeePolicy policy = new MockFeePolicy(snapshot, address(escrow), handlerAddress);
        PonsV2BuybackVault vault =
            new PonsV2BuybackVault(address(this), IPonsV2FeePolicy(address(policy)), IPonsV2FeeEscrow(address(escrow)));

        curve = new PonsV2BondingCurve(
            address(quote),
            DEPLOYER,
            handlerAddress,
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
        handler.setCurve(curve);

        launchToken = new MockLaunchToken(SUPPLY, address(curve));
        vm.prank(handlerAddress);
        curve.initialize(address(launchToken));

        // Only the trading surface is fuzzed. setCurve is one-shot anyway, but
        // excluding it keeps the run from wasting calls on a guaranteed revert.
        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = CurveHandler.buy.selector;
        selectors[1] = CurveHandler.sell.selector;
        selectors[2] = CurveHandler.sweep.selector;
        selectors[3] = CurveHandler.donate.selector;
        selectors[4] = CurveHandler.fill.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
        // ONE FIXED CALLER, A BARE HASH. The handler pranks whoever each action
        // needs, so the fuzzer's own msg.sender means nothing here - but left
        // random it is a new address on every call, and on a Base fork every
        // new address is a round trip to the fork's upstream: this suite never
        // finished in fork mode. No key signs for this address, so it holds
        // nothing on any chain.
        targetSender(address(uint160(uint256(keccak256("curb.invariants.sender")))));
    }

    // ------------------------------------------------------------------
    // Accounting identities
    // ------------------------------------------------------------------

    /// While trading, every unit of quote the curve holds is either tracked
    /// reserve or a stranded donation. Nothing else may exist.
    function invariant_quoteBalanceIsTrackedPlusDonations() public view {
        if (curve.graduated()) return;
        assertEq(
            quote.balanceOf(address(curve)),
            curve.trackedQuote() + handler.donatedQuote(),
            "quote held does not equal tracked reserve plus donations"
        );
    }

    /// The same for the launch token: no untracked balance while trading.
    function invariant_tokenBalanceMatchesTracked() public view {
        if (curve.graduated()) return;
        assertEq(
            IERC20(address(launchToken)).balanceOf(address(curve)),
            curve.trackedTokens(),
            "token held does not equal tracked reserve"
        );
    }

    /// Accrued fees must always be backed by quote the curve actually holds.
    /// If this ever fails, fees have been promised that cannot be paid.
    function invariant_accruedFeesAreBacked() public view {
        if (curve.graduated()) return;
        assertLe(
            curve.quoteFeeBalance() + curve.creatorTaxBalance(),
            curve.trackedQuote(),
            "accrued fees exceed the tracked quote behind them"
        );
    }

    /// The reserve the curve prices against is the tracked quote net of fees,
    /// on top of the phantom reserve - never anything else.
    function invariant_reserveExcludesFeesAndDonations() public view {
        if (curve.graduated()) return;
        (uint256 quoteReserve,) = curve.getReserves();
        assertEq(
            quoteReserve,
            PHANTOM_QUOTE + curve.trackedQuote() - curve.quoteFeeBalance() - curve.creatorTaxBalance(),
            "the priced reserve drifted from its definition"
        );
    }

    /// The graduated pool's allocation is never sold into.
    function invariant_reservedAllocationIsNeverSold() public view {
        if (curve.graduated()) return;
        assertGe(curve.trackedTokens(), curve.reservedTokens(), "the curve sold into the graduated pool's allocation");
    }

    /// After graduation the tradeable reserves are gone, but donations stay
    /// stranded - a different rule for a different regime.
    function invariant_afterGraduationOnlyDonationsRemain() public view {
        if (!curve.graduated()) return;
        assertEq(curve.trackedQuote(), 0, "graduated curve still tracks quote");
        assertEq(curve.trackedTokens(), 0, "graduated curve still tracks tokens");
        // Everything tradeable left for the pool seed and the fees left for
        // the escrow, so exactly the donations are what stayed behind.
        assertEq(
            quote.balanceOf(address(curve)),
            handler.donatedQuote(),
            "a graduated curve holds something other than the stranded donations"
        );
    }

    // ------------------------------------------------------------------
    // Coverage: the run has to have actually done something
    // ------------------------------------------------------------------

    /// An invariant run in which every call reverted would satisfy everything
    /// above and prove nothing. Refuse that result explicitly.
    function afterInvariant() public view {
        assertGt(handler.buys(), 0, "no buy succeeded in the whole run - the invariants proved nothing");

        // AND SOMETHING HAS TO HAVE GRADUATED. Measured at 0 before fill()
        // existed, which meant invariant_afterGraduationOnlyDonationsRemain
        // was asserting about a state the campaign never reached. A guard for
        // the coverage this file's own comment claims to separate.
        assertGt(
            handler.graduations(),
            0,
            "nothing graduated in the whole run - the post-graduation invariant proved nothing"
        );
        assertGt(handler.sells(), 0, "no sell succeeded in the whole run");
        assertGt(handler.sweeps(), 0, "no sweep succeeded in the whole run");

        // A sweep with nothing owed is a no-op. At least one must have moved
        // real money, or the distribution path was never touched.
        assertGt(handler.feePayingSweeps(), 0, "every sweep in the run was empty - fees were never distributed");

        // The handler catches curve reverts so a run can continue. Anything it
        // did not expect has to surface here rather than being absorbed.
        assertEq(
            handler.unexpectedReverts(),
            0,
            "the curve reverted for a reason the handler did not expect - see firstUnexpectedSelector"
        );
    }

    // ------------------------------------------------------------------
    // Reachability: the post-graduation regime must actually be visited
    // ------------------------------------------------------------------

    /// invariant_afterGraduationOnlyDonationsRemain returns early whenever the
    /// curve has not graduated, so a campaign that never reaches graduation
    /// satisfies it without executing a single assertion. This drives there
    /// deterministically and checks the same properties, so that regime is
    /// covered whatever the fuzzer happened to do.
    function test_postGraduationRegimeIsReachedAndHolds() public {
        handler.donate(1e8);
        uint256 donated = handler.donatedQuote();

        // Buy until the allocation is exhausted and auto-graduation fires.
        for (uint256 i = 0; i < 400 && !curve.graduated(); i++) {
            handler.buy(1e7);
        }

        assertTrue(curve.graduated(), "could not drive the fixture to graduation");
        assertGt(handler.graduations(), 0, "graduation did not route through the factory");

        assertEq(curve.trackedQuote(), 0, "graduated curve still tracks quote");
        assertEq(curve.trackedTokens(), 0, "graduated curve still tracks tokens");
        assertEq(quote.balanceOf(address(curve)), donated, "a graduated curve holds something other than the donations");
        assertGt(quote.balanceOf(POOL_SEED), 0, "the pool seed was never funded");
    }
}
