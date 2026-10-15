// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {FeeEscrow} from "../src/curb/FeeEscrow.sol";
import {PonsV2BondingCurve} from "../src/vendor/PonsV2BondingCurve.sol";
import {PonsV2BuybackVault} from "../src/vendor/PonsV2BuybackVault.sol";
import {FeePolicySnapshot, IPonsV2FeeEscrow, IPonsV2FeePolicy} from "../src/vendor/interfaces/ILaunchpadV2.sol";
import {IPonsV2LaunchFactoryGraduation} from "../src/vendor/interfaces/ILaunchpadV2Graduation.sol";
import {MockQuoteToken, MockLaunchToken, MockFeePolicy} from "./mocks/Mocks.sol";

/**
 * @notice Drives random sequences across SEVERAL launches that share one
 *         escrow, one quote asset and one handler.
 *
 * AUDIT.txt section F measured the cross-launch seams by hand, with two
 * launches and then three, in orders I chose. Its closing note says what that
 * leaves: "the orders tested are the ones I chose rather than any the machine
 * found". This is the machine looking.
 *
 * THE ESCROW HERE IS THE REAL ONE, not the mock the single-curve invariants
 * use. The whole question is whether several launches paying into one
 * (recipient, token) ledger can reach each other's balances, and a mock that
 * simply records what it is told cannot answer it.
 */
contract MultiLaunchHandler is Test, IPonsV2LaunchFactoryGraduation {
    MockQuoteToken public immutable quote;
    address public immutable poolSeed;

    PonsV2BondingCurve[] public curves;
    address[] public creators;
    mapping(address launchToken => uint256 index) internal _indexOfToken;
    mapping(address launchToken => bool known) internal _isKnownToken;

    /// Whether a launch has EVER moved money to the escrow, tracked here
    /// rather than derived from the escrow - the point is to check the escrow
    /// against something that is not the escrow.
    mapping(uint256 index => bool everPaidOut) public everPaidOut;
    /// Quote force-sent to a curve outside any trade, per curve.
    mapping(uint256 index => uint256 donated) public donatedTo;

    address internal constant TRADER = address(0xBEEF);

    uint256 public buys;
    uint256 public sells;
    uint256 public sweeps;
    uint256 public feePayingSweeps;
    uint256 public graduations;
    /// Launches that ever traded, so a run where the fuzzer only ever touched
    /// one of them cannot pass as a cross-launch measurement.
    mapping(uint256 index => bool traded) public everTraded;

    uint256 public unexpectedReverts;
    bytes4 public firstUnexpectedSelector;

    constructor(MockQuoteToken quote_, address poolSeed_) {
        quote = quote_;
        poolSeed = poolSeed_;
    }

    function addCurve(PonsV2BondingCurve curve_, address creator_, address launchToken_) external {
        _indexOfToken[launchToken_] = curves.length;
        _isKnownToken[launchToken_] = true;
        curves.push(curve_);
        creators.push(creator_);
    }

    function curveCount() external view returns (uint256) {
        return curves.length;
    }

    /// The curve calls this on its own factory when a buy crosses the
    /// threshold. WHICH curve is worked out from the token it names rather
    /// than from msg.sender, so a curve that reported somebody else's token
    /// would be caught here rather than quietly graduating the wrong one.
    function graduate(address launchToken) external {
        require(_isKnownToken[launchToken], "graduate() for an unknown token");
        uint256 i = _indexOfToken[launchToken];
        require(msg.sender == address(curves[i]), "a curve graduated another launch");
        graduations++;
        everPaidOut[i] = true;
        curves[i].graduate(poolSeed);
    }

    function _record(bytes memory err) private {
        bytes4 selector;
        if (err.length >= 4) selector = bytes4(err);
        if (selector == PonsV2BondingCurve.ZeroAmount.selector) return;
        if (selector == bytes4(keccak256("InsufficientOutputAmount()"))) return;
        if (selector == bytes4(keccak256("InsufficientInputAmount()"))) return;
        if (selector == bytes4(keccak256("InsufficientLiquidity()"))) return;

        if (unexpectedReverts == 0) firstUnexpectedSelector = selector;
        unexpectedReverts++;
    }

    function _pick(uint256 which) private view returns (uint256) {
        return bound(which, 0, curves.length - 1);
    }

    function buy(uint256 which, uint256 amount) external {
        uint256 i = _pick(which);
        PonsV2BondingCurve curve = curves[i];
        if (curve.graduated() || curve.readyToGraduate()) return;
        amount = bound(amount, 1e4, 1e7);
        quote.mint(TRADER, amount);

        vm.startPrank(TRADER);
        quote.approve(address(curve), amount);
        try curve.buy(amount, 0, TRADER) {
            buys++;
            everTraded[i] = true;
        } catch (bytes memory err) {
            _record(err);
        }
        vm.stopPrank();
    }

    function sell(uint256 which, uint256 amount) external {
        uint256 i = _pick(which);
        PonsV2BondingCurve curve = curves[i];
        if (curve.graduated() || curve.readyToGraduate()) return;
        uint256 held = IERC20(curve.token()).balanceOf(TRADER);
        if (held == 0) return;
        amount = bound(amount, 1, held);

        vm.startPrank(TRADER);
        IERC20(curve.token()).approve(address(curve), amount);
        try curve.sell(amount, 0, TRADER) {
            sells++;
            everTraded[i] = true;
        } catch (bytes memory err) {
            _record(err);
        }
        vm.stopPrank();
    }

    function sweep(uint256 which) external {
        uint256 i = _pick(which);
        PonsV2BondingCurve curve = curves[i];
        if (curve.graduated()) return;
        uint256 owed = curve.quoteFeeBalance() + curve.creatorTaxBalance();
        try curve.sweepFees(0) {
            sweeps++;
            if (owed > 0) {
                feePayingSweeps++;
                everPaidOut[i] = true;
            }
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
    function fill(uint256 which, uint256 amount) external {
        uint256 i = _pick(which);
        PonsV2BondingCurve curve = curves[i];
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
            everTraded[i] = true;
        } catch (bytes memory err) {
            _record(err);
        }
        vm.stopPrank();
    }

    function donate(uint256 which, uint256 amount) external {
        uint256 i = _pick(which);
        amount = bound(amount, 1, 1e8);
        quote.mint(address(curves[i]), amount);
        donatedTo[i] += amount;
    }
}

/**
 * @title CrossLaunchInvariantsTest
 * @notice What has to stay true of SEVERAL launches sharing one escrow, over
 *         any sequence the fuzzer can reach.
 *
 * Section F asserted these by hand at two launches and then three, in orders
 * chosen by the person who wrote them. The same properties are stated here as
 * invariants so the sequences come from somewhere other than my imagination.
 */
contract CrossLaunchInvariantsTest is Test {
    uint256 internal constant LAUNCHES = 3;
    uint256 internal constant SUPPLY = 1_000_000_000e18;
    uint256 internal constant PHANTOM_QUOTE = 30e8;
    uint256 internal constant GRADUATION_THRESHOLD = 10e8;
    uint256 internal constant FEE_BPS = 100;
    uint16 internal constant PROTOCOL_SHARE_BPS = 2000;

    address internal constant PROTOCOL_RECIPIENT = address(0xA11CE);
    address internal constant POOL_SEED = address(0x5EED);

    MockQuoteToken internal quote;
    FeeEscrow internal escrow;
    MultiLaunchHandler internal handler;

    function setUp() public {
        quote = new MockQuoteToken("Mock NVDA", "mNVDAc", 8);
        escrow = new FeeEscrow(address(quote));

        FeePolicySnapshot memory snapshot = FeePolicySnapshot({
            protocolFeeRecipient: PROTOCOL_RECIPIENT,
            protocolFeeShareBps: PROTOCOL_SHARE_BPS,
            buybackBurnBps: 0,
            hookFeeBps: 0,
            maxInternalPriceImpactBps: 500
        });

        handler = new MultiLaunchHandler(quote, POOL_SEED);
        address handlerAddress = address(handler);

        MockFeePolicy policy = new MockFeePolicy(snapshot, address(escrow), handlerAddress);
        PonsV2BuybackVault vault =
            new PonsV2BuybackVault(address(this), IPonsV2FeePolicy(address(policy)), IPonsV2FeeEscrow(address(escrow)));

        // THREE LAUNCHES AT THREE DIFFERENT TAXES AND THREE DIFFERENT
        // CREATORS. Different taxes so no assertion can hold because two
        // launches happen to produce the same numbers - the mistake F-10 was
        // written to avoid.
        uint256[LAUNCHES] memory taxes = [uint256(100), 250, 400];
        for (uint256 i = 0; i < LAUNCHES; i++) {
            address creator = address(uint160(0xC0FFEE00 + i));
            PonsV2BondingCurve curve = new PonsV2BondingCurve(
                address(quote),
                creator,
                handlerAddress,
                IPonsV2FeePolicy(address(policy)),
                snapshot,
                IPonsV2FeeEscrow(address(escrow)),
                vault,
                PHANTOM_QUOTE,
                FEE_BPS,
                taxes[i],
                false,
                GRADUATION_THRESHOLD
            );
            MockLaunchToken launchToken = new MockLaunchToken(SUPPLY, address(curve));
            vm.prank(handlerAddress);
            curve.initialize(address(launchToken));
            handler.addCurve(curve, creator, address(launchToken));
        }

        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = MultiLaunchHandler.buy.selector;
        selectors[1] = MultiLaunchHandler.sell.selector;
        selectors[2] = MultiLaunchHandler.sweep.selector;
        selectors[3] = MultiLaunchHandler.donate.selector;
        selectors[4] = MultiLaunchHandler.fill.selector;
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
    // What several launches sharing one ledger may not do to each other
    // ------------------------------------------------------------------

    /// EVERY UNIT THE ESCROW HOLDS IS SPOKEN FOR, and every unit it owes is
    /// there. This is F-1 and F-10 as a property rather than as two examples.
    ///
    /// It is the one that a cross-launch accounting mistake cannot hide from:
    /// crediting the wrong recipient keeps the sum right, but crediting more
    /// or less than arrived does not, and neither does paying out of a balance
    /// that was never backed.
    function invariant_theEscrowHoldsExactlyWhatItOwes() public view {
        uint256 owed = escrow.balanceOfToken(PROTOCOL_RECIPIENT, address(quote));
        for (uint256 i = 0; i < LAUNCHES; i++) {
            owed += escrow.balanceOfToken(handler.creators(i), address(quote));
        }
        assertEq(
            quote.balanceOf(address(escrow)), owed, "the escrow's balance and the sum of its credits disagree"
        );
    }

    /// A CREATOR WHOSE OWN LAUNCH HAS NEVER PAID OUT HAS NOTHING TO CLAIM.
    ///
    /// The direct statement of isolation, and it deliberately does not
    /// recompute the fee split: reimplementing the arithmetic under test is
    /// how a test comes to agree with the bug. What it compares is the escrow
    /// against a flag the HANDLER sets, which is not derived from the escrow
    /// at all.
    function invariant_aCreditOnlyEverComesFromTheCreatorsOwnLaunch() public view {
        for (uint256 i = 0; i < LAUNCHES; i++) {
            if (!handler.everPaidOut(i)) {
                assertEq(
                    escrow.balanceOfToken(handler.creators(i), address(quote)),
                    0,
                    "a creator was credited by a launch that was not theirs"
                );
            }
        }
    }

    /// EVERY CURVE'S BOOKS BALANCE, all of them, after every call.
    ///
    /// E-10 checked this along one sequence on one curve. Here it has to hold
    /// on all three at once, including curves the fuzzer has not touched for a
    /// hundred calls while it worked on another.
    function invariant_everyCurvesBooksBalance() public view {
        for (uint256 i = 0; i < LAUNCHES; i++) {
            (PonsV2BondingCurve curve,) = _launch(i);
            uint256 held = quote.balanceOf(address(curve));
            if (curve.graduated()) {
                // Graduation hands the tradeable reserve away; what stays is
                // what was force-sent, which is a different identity and is
                // asserted as one rather than skipped.
                assertEq(held, handler.donatedTo(i), "a graduated curve holds more than the donations sent to it");
            } else {
                assertEq(
                    held,
                    curve.trackedQuote() + handler.donatedTo(i),
                    "a curve holds quote that is neither tracked nor donated"
                );
                assertLe(
                    curve.quoteFeeBalance() + curve.creatorTaxBalance(),
                    held,
                    "a curve owes more in fees than it holds"
                );
            }
        }
    }

    /// NO CURVE EVER SELLS INTO ITS RESERVED ALLOCATION.
    ///
    /// E-11 proved this of one curve driven straight to its boundary. Here it
    /// has to survive three curves being driven in whatever interleaving the
    /// fuzzer picks, including sells that put tokens back.
    function invariant_noCurveBreachesItsReservedAllocation() public view {
        for (uint256 i = 0; i < LAUNCHES; i++) {
            (PonsV2BondingCurve curve,) = _launch(i);
            if (curve.graduated()) continue;
            assertGe(
                curve.trackedTokens(), curve.reservedTokens(), "a curve sold into the allocation reserved for its pool"
            );
        }
    }

    /// THE RUN HAS TO HAVE BEEN A CROSS-LAUNCH RUN.
    ///
    /// Every invariant above is satisfied trivially by a campaign that only
    /// ever traded one launch, or that reverted on every call. afterInvariant
    /// refuses both: this is the same guard the single-curve suite has, and it
    /// is what caught that suite's own sizing mistake.
    function afterInvariant() public view {
        assertEq(handler.unexpectedReverts(), 0, "the handler saw reverts it did not expect");
        assertGt(handler.buys(), 0, "no buy ever succeeded");
        assertGt(handler.sells(), 0, "no sell ever succeeded");
        assertGt(handler.feePayingSweeps(), 0, "no sweep ever moved money, so the escrow was never exercised");

        uint256 touched;
        for (uint256 i = 0; i < LAUNCHES; i++) {
            if (handler.everTraded(i)) touched++;
        }
        assertGe(touched, 2, "only one launch was ever traded, so nothing here was a cross-launch measurement");

        // AND AT LEAST ONE LAUNCH HAS TO HAVE GRADUATED. Without this the
        // post-graduation branch of the books invariant never executes and
        // passes by never being reached - which is exactly the shape of
        // assertion this guard exists to refuse.
        assertGt(handler.graduations(), 0, "nothing ever graduated, so the post-graduation identity went unchecked");
    }

    function _launch(uint256 i) internal view returns (PonsV2BondingCurve curve, address creator) {
        curve = handler.curves(i);
        creator = handler.creators(i);
    }
}
