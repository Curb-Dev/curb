// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";

import {B20ForkTest, ISafe} from "./B20ForkTest.sol";
import {FeeEscrow} from "../../src/curb/FeeEscrow.sol";

/// A token that simply refuses to leave. Used to check that a CLAIM which
/// cannot pay leaves the balance exactly where it was.
contract RefusingToken is ERC20 {
    bool public refuse;

    constructor() ERC20("Refusing", "NOPE") {
        _mint(msg.sender, 1_000_000e18);
    }

    function setRefuse(bool v) external {
        refuse = v;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (refuse) revert("this token is not going anywhere");
        return super.transfer(to, amount);
    }
}

/// A token that delivers less than it was asked for - the fee-on-transfer
/// shape, and the reason a credit is measured rather than assumed.
contract ShortToken is ERC20 {
    uint256 public keepBps;

    constructor() ERC20("Short", "SHORT") {
        _mint(msg.sender, 1_000_000e18);
    }

    function setKeep(uint256 bps) external {
        keepBps = bps;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        uint256 kept = (amount * keepBps) / 10_000;
        _transfer(from, to, amount - kept);
        if (kept != 0) _burn(from, kept);
        _approve(from, msg.sender, allowance(from, msg.sender) - amount);
        return true;
    }
}

/// A token whose transfer RETURNS FALSE instead of reverting. The older ERC20s
/// do this, and it is the case SafeERC20 exists for.
contract FalseReturningToken is ERC20 {
    bool public lie;

    constructor() ERC20("False", "FALSE") {
        _mint(msg.sender, 1_000_000e18);
    }

    function setLie(bool v) external {
        lie = v;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (lie) return false; // moves nothing, says nothing went wrong
        return super.transfer(to, amount);
    }
}

/// A token that returns TRUE and delivers less than it said. The fee-on-transfer
/// shape again, but on the way OUT - which a return value cannot show.
contract ShortPayingToken is ERC20 {
    uint256 public keepBps;

    constructor() ERC20("ShortPay", "SPAY") {
        _mint(msg.sender, 1_000_000e18);
    }

    function setKeep(uint256 bps) external {
        keepBps = bps;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        uint256 kept = (amount * keepBps) / 10_000;
        _transfer(msg.sender, to, amount - kept);
        if (kept != 0) _burn(msg.sender, kept);
        return true;
    }
}

/// A token that pays the recipient in full and takes MORE from the sender.
/// The recipient-side check cannot see this: they got exactly what they asked
/// for, and the extra came out of what backs everyone else's balance.
contract OverDrainingToken is ERC20 {
    uint256 public extra;

    constructor() ERC20("OverDrain", "DRAIN") {
        _mint(msg.sender, 1_000_000e18);
    }

    function setExtra(uint256 v) external {
        extra = v;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        _transfer(msg.sender, to, amount); // the recipient is made whole
        if (extra != 0) _burn(msg.sender, extra); // and the sender pays more
        return true;
    }
}

/// A recipient that forwards what it is paid, from inside the callback. It ends
/// up with LESS than was delivered to it - which is the reason the claimant-side
/// check is about a NET GAIN rather than about delivery.
contract ForwardingRecipient {
    FeeEscrow public immutable escrow;
    address public immutable token;
    address public immutable elsewhere;

    constructor(FeeEscrow escrow_, address token_, address elsewhere_) {
        escrow = escrow_;
        token = token_;
        elsewhere = elsewhere_;
    }

    function claim() external {
        escrow.claimToken(token);
    }

    function tokensReceived() external {
        uint256 held = IERC20(token).balanceOf(address(this));
        if (held != 0) IERC20(token).transfer(elsewhere, held);
    }
}

/// A token that hands control to the RECIPIENT mid-transfer - the ERC777
/// shape, and the only shape in which a reentrant claim is worth anything.
contract CallbackToken is ERC20 {
    constructor() ERC20("Callback", "CB") {
        _mint(msg.sender, 1_000_000e18);
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        bool ok = super.transfer(to, amount);
        if (to.code.length != 0) {
            // Deliberately ignoring a failure: a token that reverted because
            // its recipient did would be testing the token, not the escrow.
            (bool called,) = to.call(abi.encodeWithSignature("tokensReceived()"));
            called;
        }
        return ok;
    }
}

/// THE ATTACK THIS CONTRACT IS FOR, and a note on the one it replaced.
///
/// A first version had the TOKEN re-enter claimToken. That proved nothing: the
/// escrow keys balances on msg.sender, so a claim made by the token was a claim
/// on the TOKEN'S balance, which is empty - it reverted on NothingToClaim and
/// the test passed no matter what the escrow did with the ordering or the
/// guard. Removing both defences left it green, which is how it was found.
///
/// The shape that matters is a RECIPIENT that re-enters while being paid: same
/// msg.sender, same balance, and with the write after the transfer it would be
/// paid twice out of one credit.
contract ReenteringRecipient {
    FeeEscrow public immutable escrow;
    address public immutable token;
    bool public armed;
    bool public innerSucceeded;

    constructor(FeeEscrow escrow_, address token_) {
        escrow = escrow_;
        token = token_;
    }

    function claim() external {
        armed = true;
        escrow.claimToken(token);
        armed = false;
    }

    function tokensReceived() external {
        if (!armed) return;
        armed = false;
        // Swallowed on purpose: the question is whether the escrow PAYS twice,
        // not whether it reverts. Letting the inner revert escape would take
        // the outer claim down with it and hide the answer.
        try escrow.claimToken(token) returns (uint256) {
            innerSucceeded = true;
        } catch {}
    }
}

/**
 * @title B20FeeEscrowForkTest
 * @notice Can the money actually be taken out, and only by the person it
 *         belongs to?
 *
 * WHY THIS FILE EXISTS. The stack shipped with a mock escrow whose claim
 * functions returned zero and which had no transfer-out path at all, so every
 * fee a curve swept would have been locked in it forever. PRE_MAINNET A2 is
 * that gap. These tests are what "the fees are withdrawable" has to mean.
 *
 * WHAT IS NOT HERE, AND WHERE IT IS. The test that matters most needs a whole
 * stack - a real launch, real buys, the creator's own sweep - so it lives with
 * that stack, in B20Graduation.t.sol:
 *   test_escrow_curveFeesAreSweptAndThenActuallyWithdrawn
 * It asserts the creator's and the platform's REAL NVDAc balances across their
 * claims, because a ledger agreeing with itself is not money arriving.
 *
 * THE INJECTED FAILURES USE TOKEN DOUBLES, and that is a limit worth stating:
 * NVDAc is a precompile and cannot be made to refuse, short-deliver or
 * re-enter on demand. Those three tests therefore establish what THIS CONTRACT
 * does when a token behaves that way, not that NVDAc ever would.
 */

/// A claimant that takes ether without complaint.
contract EthTakingClaimant {
    FeeEscrow public immutable escrow;
    address public immutable token;
    uint256 public received;

    constructor(FeeEscrow escrow_, address token_) {
        escrow = escrow_;
        token = token_;
    }

    function claim() external {
        escrow.claimToken(token);
    }

    receive() external payable {
        received += msg.value;
    }
}

/// A claimant with no way to receive ether at all - no receive, no fallback.
/// Not contrived: a great many contracts are written exactly this way, and one
/// of them will eventually be somebody's creator wallet.
contract EthRefusingClaimant {
    FeeEscrow public immutable escrow;
    address public immutable token;

    constructor(FeeEscrow escrow_, address token_) {
        escrow = escrow_;
        token = token_;
    }

    function claim() external {
        escrow.claimToken(token);
    }
}

contract B20FeeEscrowForkTest is B20ForkTest {
    address internal constant NVDAC = 0xb20000000000000000000078ee7ce2fE4908108C;
    address internal constant NVDAC_HOLDER = 0x4446Adc0B8136Ffc55DdB7a488Ba5509Ace2A5ef;

    address internal creatorA = makeAddr("creator A");
    address internal creatorB = makeAddr("creator B");
    address internal platform = makeAddr("platform");
    address internal stranger = makeAddr("stranger");

    FeeEscrow internal escrow;

    function setUp() public {
        if (!_forkGuard()) return;
        escrow = new FeeEscrow(NVDAC);
        vm.prank(NVDAC_HOLDER);
        IERC20(NVDAC).transfer(address(this), 10e8);
    }

    /// One credit, the way a curve makes one: approve, then let the escrow pull.
    function _credit(address recipient, uint256 amount) internal {
        IERC20(NVDAC).approve(address(escrow), amount);
        escrow.creditToken(recipient, NVDAC, amount);
    }

    // ================================================================
    // separate balances, and only your own
    // ================================================================

    /// TWO LAUNCHES AND TWO CREATORS through ONE escrow, plus the platform's
    /// share from both. Every balance is its own, and a claim moves only that.
    function test_balancesAreSeparatePerRecipient() public onlyFork {
        _credit(creatorA, 3e8);
        _credit(creatorB, 2e8);
        _credit(platform, 1e8); // launch A's platform leg
        _credit(platform, 4e7); // launch B's, into the same balance

        assertEq(escrow.balanceOfToken(creatorA, NVDAC), 3e8, "creator A's balance is wrong");
        assertEq(escrow.balanceOfToken(creatorB, NVDAC), 2e8, "creator B's balance is wrong");
        assertEq(escrow.balanceOfToken(platform, NVDAC), 14e7, "the platform's two launches did not add up");

        uint256 held = IERC20(NVDAC).balanceOf(address(escrow));
        assertEq(held, 3e8 + 2e8 + 14e7, "the escrow holds something other than the sum of its ledgers");

        // A takes theirs; nobody else's moves.
        vm.prank(creatorA);
        escrow.claimToken(NVDAC);

        assertEq(IERC20(NVDAC).balanceOf(creatorA), 3e8, "creator A was not paid");
        assertEq(escrow.balanceOfToken(creatorA, NVDAC), 0, "creator A's balance survived the claim");
        assertEq(escrow.balanceOfToken(creatorB, NVDAC), 2e8, "creator B's balance moved");
        assertEq(escrow.balanceOfToken(platform, NVDAC), 14e7, "the platform's balance moved");
        assertEq(IERC20(NVDAC).balanceOf(creatorB), 0, "creator B was paid somebody else's claim");
    }

    /// THERE IS NO WAY TO REACH SOMEBODY ELSE'S BALANCE, because there is no
    /// argument for it: a claim pays msg.sender from msg.sender's ledger. A
    /// stranger calling gets the refusal an empty balance gets, which is the
    /// same thing said twice and is the point.
    function test_aStrangerCannotReachAnotherBalance() public onlyFork {
        _credit(creatorA, 5e8);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(FeeEscrow.NothingToClaim.selector, stranger, NVDAC));
        escrow.claimToken(NVDAC);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(FeeEscrow.NothingToClaim.selector, stranger, NVDAC));
        escrow.claimToken(NVDAC, 1);

        assertEq(escrow.balanceOfToken(creatorA, NVDAC), 5e8, "somebody else's balance changed");
        assertEq(IERC20(NVDAC).balanceOf(stranger), 0, "a stranger was paid");
    }

    function test_partialClaimsLeaveTheRest() public onlyFork {
        _credit(creatorA, 5e8);

        vm.prank(creatorA);
        escrow.claimToken(NVDAC, 2e8);
        assertEq(IERC20(NVDAC).balanceOf(creatorA), 2e8, "the partial claim paid the wrong amount");
        assertEq(escrow.balanceOfToken(creatorA, NVDAC), 3e8, "the remainder is wrong");

        vm.prank(creatorA);
        escrow.claimToken(NVDAC, 1e8);
        assertEq(escrow.balanceOfToken(creatorA, NVDAC), 2e8, "the second partial claim is wrong");

        vm.prank(creatorA);
        escrow.claimToken(NVDAC);
        assertEq(IERC20(NVDAC).balanceOf(creatorA), 5e8, "the whole balance did not arrive across three claims");
        assertEq(escrow.balanceOfToken(creatorA, NVDAC), 0, "something was left behind");
    }

    function test_overClaimingIsRefusedAndChangesNothing() public onlyFork {
        _credit(creatorA, 5e8);

        vm.prank(creatorA);
        vm.expectRevert(abi.encodeWithSelector(FeeEscrow.ClaimExceedsBalance.selector, 5e8 + 1, 5e8));
        escrow.claimToken(NVDAC, 5e8 + 1);

        assertEq(escrow.balanceOfToken(creatorA, NVDAC), 5e8, "a refused claim moved the balance");
        assertEq(IERC20(NVDAC).balanceOf(creatorA), 0, "a refused claim paid something");

        // And the legitimate claim still works afterwards.
        vm.prank(creatorA);
        escrow.claimToken(NVDAC);
        assertEq(IERC20(NVDAC).balanceOf(creatorA), 5e8, "the balance was not claimable after a refusal");
    }

    // ================================================================
    // what this contract will not take, and will not invent
    // ================================================================

    function test_anUnsupportedTokenIsRefusedBothWays() public onlyFork {
        RefusingToken other = new RefusingToken();
        other.approve(address(escrow), type(uint256).max);

        vm.expectRevert(abi.encodeWithSelector(FeeEscrow.UnsupportedToken.selector, address(other)));
        escrow.creditToken(creatorA, address(other), 1e18);

        vm.prank(creatorA);
        vm.expectRevert(abi.encodeWithSelector(FeeEscrow.UnsupportedToken.selector, address(other)));
        escrow.claimToken(address(other));
    }

    /// NATIVE ETH IS REFUSED OUTRIGHT, not accepted into a ledger nothing can
    /// pay out of. The interface carries a native half this product has no use
    /// for, and a silent no-op there is a place for value to vanish.
    function test_nativeEthIsRefused() public onlyFork {
        vm.deal(address(this), 1 ether);

        vm.expectRevert(FeeEscrow.NativeNotSupported.selector);
        escrow.credit{value: 1 ether}(creatorA);

        vm.expectRevert(FeeEscrow.NativeNotSupported.selector);
        escrow.claim();

        vm.expectRevert(FeeEscrow.NativeNotSupported.selector);
        escrow.claim(1);

        // And it cannot be pushed in around the side either. There IS a
        // receive() now - a WETH escrow needs one to take back what it just
        // unwrapped - but it accepts ether from WETH and from nothing else,
        // so this send is refused exactly as it was before it existed.
        (bool sent,) = address(escrow).call{value: 1 ether}("");
        assertFalse(sent, "the escrow accepted a bare ETH transfer");
        assertEq(address(escrow).balance, 0, "the escrow holds ETH");
        assertEq(escrow.balanceOf(creatorA), 0, "the native ledger is not always zero");
    }

    // ================================================================
    // injected token failures - see the note at the top of this file
    // ================================================================

    /// A SHORT DELIVERY IS REFUSED, so no balance is ever larger than the
    /// money behind it.
    function test_aShortDeliveryIsRefused() public onlyFork {
        ShortToken short = new ShortToken();
        FeeEscrow shortEscrow = new FeeEscrow(address(short));
        short.approve(address(shortEscrow), type(uint256).max);

        short.setKeep(100); // keeps 1%
        vm.expectRevert(abi.encodeWithSelector(FeeEscrow.DeliveryMismatch.selector, address(short), 1e18, 99e16));
        shortEscrow.creditToken(creatorA, address(short), 1e18);

        assertEq(shortEscrow.balanceOfToken(creatorA, address(short)), 0, "a short delivery created a balance");

        // Exactly is accepted, which is what makes the refusal above specific
        // rather than a contract that refuses everything.
        short.setKeep(0);
        shortEscrow.creditToken(creatorA, address(short), 1e18);
        assertEq(shortEscrow.balanceOfToken(creatorA, address(short)), 1e18, "an exact delivery was not credited");
    }

    /// A CLAIM THAT CANNOT PAY LEAVES THE BALANCE WHERE IT WAS. The write
    /// happens before the transfer, so this is asking whether the revert really
    /// unwinds it.
    function test_aFailedTransferLeavesTheBalanceIntact() public onlyFork {
        RefusingToken refusing = new RefusingToken();
        FeeEscrow refusingEscrow = new FeeEscrow(address(refusing));
        refusing.approve(address(refusingEscrow), type(uint256).max);
        refusingEscrow.creditToken(creatorA, address(refusing), 4e18);

        refusing.setRefuse(true);
        vm.prank(creatorA);
        vm.expectRevert(bytes("this token is not going anywhere"));
        refusingEscrow.claimToken(address(refusing));

        assertEq(
            refusingEscrow.balanceOfToken(creatorA, address(refusing)), 4e18,
            "the balance was written down by a claim that never paid"
        );

        // And once the token behaves, the same balance is still claimable.
        refusing.setRefuse(false);
        vm.prank(creatorA);
        refusingEscrow.claimToken(address(refusing));
        assertEq(refusing.balanceOf(creatorA), 4e18, "the balance was not claimable afterwards");
        assertEq(refusingEscrow.balanceOfToken(creatorA, address(refusing)), 0, "the balance survived a real claim");
    }

    // ================================================================
    // the way OUT, which the way IN was already measured for
    // ================================================================

    /// A TOKEN THAT RETURNS FALSE IS A FAILED CLAIM. SafeERC20 turns that into
    /// a revert; without it the balance would have gone to zero with nothing
    /// paid at all.
    function test_aClaimThatReturnsFalseIsRefused() public onlyFork {
        FalseReturningToken liar = new FalseReturningToken();
        FeeEscrow liarEscrow = new FeeEscrow(address(liar));
        liar.approve(address(liarEscrow), type(uint256).max);
        liarEscrow.creditToken(creatorA, address(liar), 4e18);

        liar.setLie(true);
        vm.prank(creatorA);
        vm.expectRevert(
            abi.encodeWithSelector(bytes4(keccak256("SafeERC20FailedOperation(address)")), address(liar))
        );
        liarEscrow.claimToken(address(liar));

        assertEq(liar.balanceOf(creatorA), 0, "a token that moved nothing paid something");
        assertEq(
            liarEscrow.balanceOfToken(creatorA, address(liar)), 4e18,
            "the balance was written down by a claim that paid nothing"
        );

        liar.setLie(false);
        vm.prank(creatorA);
        liarEscrow.claimToken(address(liar));
        assertEq(liar.balanceOf(creatorA), 4e18, "the balance was not claimable once the token behaved");
    }

    /// A TOKEN THAT RETURNS TRUE AND PAYS LESS IS ALSO A FAILED CLAIM, and a
    /// return value cannot show it. THIS IS WHAT THE CONTRACT DID BEFORE THE
    /// CHECK EXISTED, measured rather than described: a 4e18 balance paid
    /// 3.96e18, the claim reported success, and the balance still went to
    /// ZERO - so the claimant lost 0.04e18 and had nothing left to claim it
    /// with. The way in was measured from the start; the way out was not.
    function test_aClaimThatShortPaysIsRefusedAndTheBalanceSurvives() public onlyFork {
        ShortPayingToken pay = new ShortPayingToken();
        FeeEscrow payEscrow = new FeeEscrow(address(pay));
        pay.approve(address(payEscrow), type(uint256).max);
        payEscrow.creditToken(creatorA, address(pay), 4e18);

        pay.setKeep(100); // pays 99%
        vm.prank(creatorA);
        vm.expectRevert(
            abi.encodeWithSelector(FeeEscrow.ShortPayment.selector, address(pay), 4e18, 396e16)
        );
        payEscrow.claimToken(address(pay));

        assertEq(pay.balanceOf(creatorA), 0, "a refused claim paid something");
        assertEq(
            payEscrow.balanceOfToken(creatorA, address(pay)), 4e18,
            "the claimant's entitlement did not survive a short payment"
        );
        assertEq(pay.balanceOf(address(payEscrow)), 4e18, "the escrow no longer holds what it owes");

        // AND IT IS STILL CLAIMABLE once the token pays in full - the point of
        // refusing rather than paying what turned up.
        pay.setKeep(0);
        vm.prank(creatorA);
        payEscrow.claimToken(address(pay));
        assertEq(pay.balanceOf(creatorA), 4e18, "the balance was not claimable afterwards");
        assertEq(payEscrow.balanceOfToken(creatorA, address(pay)), 0, "the balance survived a full payment");
    }

    /// THE OTHER SIDE OF THE SAME COIN, and the one the recipient check misses.
    ///
    /// The claimant is paid in full - their side is satisfied - while the token
    /// takes MORE out of the escrow than was claimed. A shared vault has to be
    /// bounded on both sides, or one claimant is made whole out of another's
    /// money. Two rights-holders are funded here precisely so the surplus has
    /// somewhere to come from.
    function test_aClaimThatOverDrainsTheEscrowIsRefused() public onlyFork {
        OverDrainingToken drain = new OverDrainingToken();
        FeeEscrow drainEscrow = new FeeEscrow(address(drain));
        drain.approve(address(drainEscrow), type(uint256).max);
        drainEscrow.creditToken(creatorA, address(drain), 4e18);
        drainEscrow.creditToken(creatorB, address(drain), 10e18);

        drain.setExtra(4e16); // pays A their 4, and takes 4.04 from the escrow

        vm.prank(creatorA);
        vm.expectRevert(
            abi.encodeWithSelector(FeeEscrow.OverDrawn.selector, address(drain), 4e18, 404e16)
        );
        drainEscrow.claimToken(address(drain));

        // BOTH ENTITLEMENTS AND THE ASSETS BEHIND THEM.
        assertEq(drainEscrow.balanceOfToken(creatorA, address(drain)), 4e18, "the claimant's entitlement moved");
        assertEq(drainEscrow.balanceOfToken(creatorB, address(drain)), 10e18, "a bystander's entitlement moved");
        assertEq(drain.balanceOf(address(drainEscrow)), 14e18, "the escrow's assets were drained");
        assertEq(drain.balanceOf(creatorA), 0, "a refused claim paid something");

        // And once the token stops overcharging, both can be claimed in full.
        drain.setExtra(0);
        vm.prank(creatorA);
        drainEscrow.claimToken(address(drain));
        vm.prank(creatorB);
        drainEscrow.claimToken(address(drain));
        assertEq(drain.balanceOf(creatorA), 4e18, "A was not paid afterwards");
        assertEq(drain.balanceOf(creatorB), 10e18, "B was not paid afterwards");
        assertEq(drain.balanceOf(address(drainEscrow)), 0, "the escrow kept something");
    }

    /// A RECIPIENT THAT FORWARDS WHAT IT IS PAID IS ALSO REFUSED, and that is a
    /// consequence worth stating rather than discovering.
    ///
    /// The claimant-side check measures a NET GAIN, not a delivery. A recipient
    /// that moves the tokens on from inside the callback ends up with less than
    /// arrived, and this contract cannot tell that apart from a token that
    /// short-paid - so it pays out under neither.
    ///
    /// WHAT THIS TEST SHOWS IS THAT SUCH A CLAIM IS REFUSED. It does not show
    /// that the recipient could have avoided it: an account whose forwarding
    /// lives in immutable code cannot choose otherwise, and for that address
    /// the escrow is unusable rather than merely strict.
    function test_aRecipientThatForwardsMidTransferIsRefused() public onlyFork {
        CallbackToken cb = new CallbackToken();
        FeeEscrow cbEscrow = new FeeEscrow(address(cb));
        ForwardingRecipient fwd = new ForwardingRecipient(cbEscrow, address(cb), stranger);

        cb.approve(address(cbEscrow), type(uint256).max);
        cbEscrow.creditToken(address(fwd), address(cb), 5e18);
        cbEscrow.creditToken(creatorB, address(cb), 7e18);

        vm.expectRevert(abi.encodeWithSelector(FeeEscrow.ShortPayment.selector, address(cb), 5e18, 0));
        fwd.claim();

        assertEq(cbEscrow.balanceOfToken(address(fwd), address(cb)), 5e18, "the forwarder's entitlement moved");
        assertEq(cbEscrow.balanceOfToken(creatorB, address(cb)), 7e18, "a bystander's entitlement moved");
        assertEq(cb.balanceOf(address(cbEscrow)), 12e18, "the escrow's assets moved");
        assertEq(cb.balanceOf(stranger), 0, "the forwarded destination was paid");
    }

    /// THE ESCROW CANNOT BE CREDITED TO ITSELF. Such a balance could never be
    /// claimed - this contract cannot call itself - and it would make the two
    /// measurements in a claim read the same account twice.
    function test_aBalanceCreditedToTheEscrowItselfIsRefused() public onlyFork {
        IERC20(NVDAC).approve(address(escrow), 1e8);
        vm.expectRevert(FeeEscrow.RecipientIsTheEscrow.selector);
        escrow.creditToken(address(escrow), NVDAC, 1e8);

        assertEq(escrow.balanceOfToken(address(escrow), NVDAC), 0, "the escrow credited itself");
        assertEq(IERC20(NVDAC).balanceOf(address(escrow)), 0, "the escrow took the tokens anyway");
    }

    /// A PARTIAL CLAIM IS MEASURED THE SAME WAY, so the check cannot be walked
    /// around by asking for less.
    function test_aShortPaidPartialClaimIsRefusedToo() public onlyFork {
        ShortPayingToken pay = new ShortPayingToken();
        FeeEscrow payEscrow = new FeeEscrow(address(pay));
        pay.approve(address(payEscrow), type(uint256).max);
        payEscrow.creditToken(creatorA, address(pay), 4e18);

        pay.setKeep(2500); // pays 75%
        vm.prank(creatorA);
        vm.expectRevert(
            abi.encodeWithSelector(FeeEscrow.ShortPayment.selector, address(pay), 2e18, 15e17)
        );
        payEscrow.claimToken(address(pay), 2e18);

        assertEq(payEscrow.balanceOfToken(creatorA, address(pay)), 4e18, "a refused partial claim moved the balance");
    }

    /// A RECIPIENT THAT RE-ENTERS WHILE BEING PAID CANNOT BE PAID TWICE.
    ///
    /// Two credits go in, to two different people, so the escrow is holding
    /// more than the attacker is owed. A second payment would therefore come
    /// out of SOMEBODY ELSE'S money, which is what makes this worth checking
    /// rather than a self-limiting bug.
    function test_aReentrantRecipientCannotBePaidTwice() public onlyFork {
        CallbackToken cb = new CallbackToken();
        FeeEscrow cbEscrow = new FeeEscrow(address(cb));
        ReenteringRecipient attacker = new ReenteringRecipient(cbEscrow, address(cb));

        cb.approve(address(cbEscrow), type(uint256).max);
        cbEscrow.creditToken(address(attacker), address(cb), 6e18);
        cbEscrow.creditToken(creatorB, address(cb), 10e18); // a bystander's money

        attacker.claim();

        assertEq(cb.balanceOf(address(attacker)), 6e18, "the attacker was paid more than they were owed");
        assertFalse(attacker.innerSucceeded(), "the escrow paid a reentrant claim");
        assertEq(cbEscrow.balanceOfToken(address(attacker), address(cb)), 0, "the attacker's balance survived");
        assertEq(
            cbEscrow.balanceOfToken(creatorB, address(cb)), 10e18,
            "the bystander's ledger entry changed"
        );
        assertEq(
            cb.balanceOf(address(cbEscrow)), 10e18,
            "the escrow no longer holds what it owes the bystander"
        );
    }

    // ================================================================
    // A6 - CAN THE PLATFORM'S RECIPIENT BE A SAFE, AND STILL GET PAID
    // ================================================================

    /// A SAFE CAN HOLD THE QUOTE ASSET, AND CAN CLAIM ITS OWN BALANCE.
    ///
    /// A6 has been sitting on "an EOA for now, a Safe intended later" without
    /// anybody checking that the second half is possible. Two things could have
    /// made it impossible and both are only visible against the real chain:
    /// the quote asset is a B20 with a transfer policy, and FeeEscrow pays
    /// msg.sender with no recipient argument - so the recipient has to BE the
    /// caller, which for a Safe means clearing its own threshold.
    ///
    /// NOT A TEST OF SAFE. It is a test of OUR escrow and OUR quote asset
    /// against a real multisig, which is the combination nothing else covers.
    function test_aSafeCanReceiveTheQuoteAssetAndClaimFromTheEscrow() public onlyFork {
        (ISafe safe, uint256[3] memory keys,) = _deploySafe();
        assertEq(safe.getThreshold(), 2, "the Safe did not deploy 2-of-3");
        assertEq(safe.getOwners().length, 3, "the Safe did not deploy with three owners");

        // ---- 1. it can be paid at all. A plain B20 transfer to a contract.
        vm.prank(NVDAC_HOLDER);
        IERC20(NVDAC).transfer(address(safe), 1e8);
        assertEq(IERC20(NVDAC).balanceOf(address(safe)), 1e8, "the issuer's policy refused a Safe");

        // ---- 2. it is owed something through the escrow, the way a sweep owes
        //         the platform.
        uint256 owed = 4e8;
        _credit(address(safe), owed);
        assertEq(escrow.balanceOfToken(address(safe), NVDAC), owed, "the credit did not land");

        // ---- 3. AND IT CAN COLLECT. Two of three signatures, executed by
        //         somebody who is not an owner at all - which is how a Safe is
        //         normally driven and proves the threshold is what matters.
        uint256 before = IERC20(NVDAC).balanceOf(address(safe));
        bytes memory call_ = abi.encodeWithSignature("claimToken(address)", NVDAC);
        bytes memory sigs = _signSafeTx(safe, keys, address(escrow), call_);

        vm.prank(stranger);
        bool ok = safe.execTransaction(
            address(escrow), 0, call_, 0, 0, 0, 0, address(0), payable(address(0)), sigs
        );
        assertTrue(ok, "the Safe transaction did not execute");

        assertEq(IERC20(NVDAC).balanceOf(address(safe)) - before, owed, "the Safe was not paid what it claimed");
        assertEq(escrow.balanceOfToken(address(safe), NVDAC), 0, "the balance was not written down");
    }

    /// AND ONE SIGNATURE IS NOT ENOUGH, so the test above is measuring the
    /// threshold rather than a Safe that would execute for anybody.
    function test_aSafeBelowItsThresholdCannotClaim() public onlyFork {
        (ISafe safe, uint256[3] memory keys,) = _deploySafe();
        _credit(address(safe), 2e8);

        bytes memory call_ = abi.encodeWithSignature("claimToken(address)", NVDAC);
        bytes32 h = safe.getTransactionHash(
            address(escrow), 0, call_, 0, 0, 0, 0, address(0), address(0), safe.nonce()
        );
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(keys[0], h);
        bytes memory one = abi.encodePacked(r1, s1, v1);

        // THE EXACT REASON, MEASURED RATHER THAN LEFT BARE. A bare
        // expectRevert() passes on ANY failure - a typo in the calldata, a
        // Safe that is not there - so it would not distinguish "the threshold
        // held" from "nothing happened". Safe 1.4.1 answers Error("GS020"),
        // signatures data too short, and that is what is required here.
        vm.prank(stranger);
        vm.expectRevert("GS020");
        safe.execTransaction(address(escrow), 0, call_, 0, 0, 0, 0, address(0), payable(address(0)), one);

        assertEq(escrow.balanceOfToken(address(safe), NVDAC), 2e8, "the balance moved on a failed claim");
    }

    // ================================================================
    // A WETH escrow pays out in ETH
    //
    // The credit is still denominated in WETH and every balance, event and
    // measurement above is unchanged. Only the last step differs: the escrow
    // unwraps and sends ether, and falls back to the wrapped token for a
    // recipient that will not take it.
    // ================================================================

    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    /// The WETH/USDC 0.3% pool, which held 13,620 WETH at the pinned block. A
    /// balance to borrow from; nothing here trades against it.
    address internal constant WETH_HOLDER = 0x6c561B446416E1A00E8E93E221854d6eA4171372;

    /// A WETH escrow with `amount` already credited to `recipient`.
    function _wethEscrow(address recipient, uint256 amount) internal returns (FeeEscrow e) {
        e = new FeeEscrow(WETH);
        vm.prank(WETH_HOLDER);
        IERC20(WETH).transfer(address(this), amount);
        IERC20(WETH).approve(address(e), amount);
        e.creditToken(recipient, WETH, amount);
    }

    /// THE WHOLE POINT: a creator claiming their fees gets ether.
    ///
    /// Asserted in both directions. Their ether rises by the full amount AND
    /// their WETH does not move, because "paid in ether" and "paid twice" look
    /// the same if only one side is measured.
    function test_weth_aClaimLeavesAsEther() public onlyFork {
        uint256 amount = 2 ether;
        FeeEscrow e = _wethEscrow(creatorA, amount);

        uint256 ethBefore = creatorA.balance;
        uint256 wethBefore = IERC20(WETH).balanceOf(creatorA);

        vm.prank(creatorA);
        e.claimToken(WETH);

        assertEq(creatorA.balance - ethBefore, amount, "the claim did not arrive as ether");
        assertEq(IERC20(WETH).balanceOf(creatorA), wethBefore, "the claim arrived as WETH too");
        assertEq(address(e).balance, 0, "the escrow kept ether");
        assertEq(IERC20(WETH).balanceOf(address(e)), 0, "the escrow kept WETH");
        assertEq(e.balanceOfToken(creatorA, WETH), 0, "the credited balance survived the claim");
    }

    /// A CONTRACT THAT CAN TAKE ETHER IS PAID IN ETHER, not quietly dropped to
    /// the wrapped token because it is not an EOA.
    function test_weth_aContractThatTakesEtherIsPaidInEther() public onlyFork {
        uint256 amount = 1 ether;
        FeeEscrow e = new FeeEscrow(WETH);
        EthTakingClaimant who = new EthTakingClaimant(e, WETH);

        vm.prank(WETH_HOLDER);
        IERC20(WETH).transfer(address(this), amount);
        IERC20(WETH).approve(address(e), amount);
        e.creditToken(address(who), WETH, amount);

        who.claim();

        assertEq(who.received(), amount, "its receive() never ran");
        assertEq(address(who).balance, amount, "it was not paid in ether");
        assertEq(IERC20(WETH).balanceOf(address(who)), 0, "it was paid in WETH as well");
    }

    /// AND A CLAIM IS NEVER LOST TO HOW THE CLAIMANT TAKES DELIVERY.
    ///
    /// A contract with no receive() and no fallback cannot be sent ether at
    /// all. Reverting would strand its fees permanently - the credited balance
    /// would sit there with no way out - so the ether is wrapped straight back
    /// and paid as WETH in the same call.
    function test_weth_aClaimantThatCannotTakeEtherIsPaidInWeth() public onlyFork {
        uint256 amount = 1 ether;
        FeeEscrow e = new FeeEscrow(WETH);
        EthRefusingClaimant who = new EthRefusingClaimant(e, WETH);

        vm.prank(WETH_HOLDER);
        IERC20(WETH).transfer(address(this), amount);
        IERC20(WETH).approve(address(e), amount);
        e.creditToken(address(who), WETH, amount);

        // THE OFFER WAS MADE AND TURNED DOWN, rather than never made. WETH in
        // the claimant's hands is also what an escrow that never unwraps
        // produces, so the balance alone cannot tell the two apart - this test
        // passed with the whole ether path deleted until this line existed.
        vm.expectEmit(true, false, false, true, address(e));
        emit FeeEscrow.ClaimedAsWrapped(address(who), amount);
        who.claim();

        assertEq(address(who).balance, 0, "a contract with no receive() was sent ether");
        assertEq(IERC20(WETH).balanceOf(address(who)), amount, "the fallback did not pay WETH");
        assertEq(address(e).balance, 0, "the escrow kept ether after the fallback");
        assertEq(IERC20(WETH).balanceOf(address(e)), 0, "the escrow kept WETH after the fallback");
        assertEq(e.balanceOfToken(address(who), WETH), 0, "the claim was not consumed");
    }

    /// ETHER FROM ANYWHERE BUT WETH IS REFUSED.
    ///
    /// The only ether this contract should ever hold is what it unwrapped for
    /// a claim already in progress. Anything else is money with no credited
    /// balance behind it and no way out, so it is turned away at the door
    /// rather than trapped.
    function test_weth_strayEtherIsRefused() public onlyFork {
        FeeEscrow e = new FeeEscrow(WETH);
        vm.deal(stranger, 1 ether);

        vm.prank(stranger);
        (bool ok,) = address(e).call{value: 1 ether}("");

        assertFalse(ok, "the escrow accepted ether from a stranger");
        assertEq(address(e).balance, 0, "stray ether stayed in the escrow");
    }

    /// AND EVERY OTHER QUOTE ASSET IS UNTOUCHED.
    ///
    /// The unwrapping is reached only when the escrow's own quote asset IS
    /// WETH. An NVDAC escrow pays NVDAC and moves no ether at all - which is
    /// what makes this change safe for the deployments that already exist.
    function test_aNonWethEscrowStillPaysItsOwnToken() public onlyFork {
        _credit(creatorA, 3e8);
        uint256 ethBefore = creatorA.balance;

        vm.prank(creatorA);
        escrow.claimToken(NVDAC);

        assertEq(IERC20(NVDAC).balanceOf(creatorA), 3e8, "the token claim did not pay out");
        assertEq(creatorA.balance, ethBefore, "a non-WETH claim moved ether");
        assertEq(address(escrow).balance, 0, "a non-WETH escrow ended up holding ether");
    }

}
