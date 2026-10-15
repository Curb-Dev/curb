// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {PonsV2BondingCurve} from "../../src/vendor/PonsV2BondingCurve.sol";
import {Graduator} from "../../src/curb/Graduator.sol";

import {HolderSharingForkBase} from "./HolderSharing.t.sol";

/// THE BUYER WHO FILLS A CURVE, IN ONE TRANSACTION: the buy, with the curve's
/// automatic graduation starved of gas (the 63/64 rule), and - when told - the
/// note and the fee rescue after it. A starve that did not take, because the
/// curve graduated after all or the buy itself ran out, is refused as such, so
/// a scan over the gas can find the amount that does.
contract StarvingBuyer {
    function fill(
        PonsV2BondingCurve curve,
        IERC20 quote,
        uint256 amount,
        uint256 buyGas,
        Graduator grad,
        address token,
        bool rescue
    ) external {
        SafeERC20.forceApprove(quote, address(curve), amount);
        curve.buy{gas: buyGas}(amount, 0, address(this));
        require(curve.readyToGraduate() && !curve.graduated(), "not starved");
        if (rescue) {
            grad.noteReady(token);
            grad.rescueCurveFees(token);
        }
    }
}

/// THE FEE RESCUE OPENS TO STRANGERS AN HOUR AFTER A CURVE IS NOTED STUCK, NOT
/// THE MOMENT IT IS FULL - on the pinned fork, on the real curve, buying the
/// real WETH.
///
/// THE ATTACK OF THE 2026-10-08 RE-REVIEW, ITEM 12. "Ready" was something a
/// buyer could reach on purpose: the buy that fills a curve starves the
/// curve's own graduation call and, in the same transaction, calls
/// rescueCurveFees - forcing the creator's whole unswept tax out as raw WETH,
/// where the escrow would have paid it as ETH. The rescue now opens to anyone
/// only RESCUE_DELAY after noteReady recorded the curve full and ungraduated,
/// so a note made in that transaction opens nothing for an hour, and in that
/// hour graduate() is open to everybody.
contract RescueTimingForkTest is HolderSharingForkBase {
    uint256 internal constant FILL = 5e18;

    /// A WETH launch with ordinary trade on it, so its curve holds creator tax
    /// that a rescue would force out, and a buyer funded to fill it.
    function _setUpFill() internal returns (Stack memory s, Launched memory l, StarvingBuyer b, uint256 tax) {
        s = _stack(_weth());
        l = _launch(s, address(0), 0);
        _buy(s, l, 1e18);
        tax = l.curve.creatorTaxBalance();
        assertGt(tax, 0, "the trade left no creator tax, so a rescue would force nothing out");
        assertFalse(l.curve.readyToGraduate(), "the trade filled the curve; the premise moved");
        b = new StarvingBuyer();
        _fund(s.a, address(b), FILL);
    }

    /// The curve filled by `b` with its graduation starved, as a transaction
    /// of its own: the state the attack's buy leaves, and the one a stranded
    /// launch is in.
    function _starve(Stack memory s, Launched memory l, StarvingBuyer b) internal returns (uint256 buyGas) {
        uint256 snap = vm.snapshotState();
        for (uint256 g = 250_000; g < 2_000_000; g += 10_000) {
            try b.fill(l.curve, IERC20(s.a.quote), FILL, g, s.graduator, address(l.token), false) {
                return g;
            } catch {}
            vm.revertToState(snap);
        }
        revert("could not leave the curve full but ungraduated");
    }

    /// THE SAME-TRANSACTION ATTACK: fill, starve, note, rescue - refused at
    /// the rescue, at every gas that leaves the curve full and ungraduated. A
    /// rescue that went through fails here; the only refusal accepted is the
    /// hatch's own, naming the hour it would open.
    function test_aBuyerWhoStarvesTheGraduationCannotRescueInTheSameTransaction() public onlyFork {
        (Stack memory s, Launched memory l, StarvingBuyer b,) = _setUpFill();
        bytes memory closed = abi.encodeWithSelector(
            Graduator.RescueNotOpenYet.selector, address(b), vm.getBlockTimestamp() + s.graduator.RESCUE_DELAY()
        );
        uint256 snap = vm.snapshotState();
        uint256 starvedAndRefused;
        for (uint256 g = 250_000; g < 2_000_000; g += 10_000) {
            try b.fill(l.curve, IERC20(s.a.quote), FILL, g, s.graduator, address(l.token), true) {
                fail("the buyer who filled the curve and starved its graduation rescued its fees in the same transaction");
            } catch (bytes memory why) {
                if (keccak256(why) == keccak256(closed)) starvedAndRefused++;
            }
            vm.revertToState(snap);
        }
        assertGt(starvedAndRefused, 0, "no gas left the curve full and ungraduated; the attack was never tried");
    }

    /// AND THE HOUR IS THE MOVE'S. The starve as its own transaction, the
    /// note after it: a stranger is refused the rescue, anyone completes the
    /// move, the creator's tax goes into the escrow as the creator's credit -
    /// none of it as raw WETH - and when the hour is up the hatch stays shut,
    /// because the curve has moved.
    function test_inTheHourAfterTheNoteAnyoneCompletesTheMoveAndTheTaxGoesThroughTheEscrow() public onlyFork {
        (Stack memory s, Launched memory l, StarvingBuyer b, uint256 tax) = _setUpFill();
        _starve(s, l, b);
        tax = l.curve.creatorTaxBalance();
        vm.prank(address(b));
        uint256 since = s.graduator.noteReady(address(l.token));
        uint256 opensAt = since + s.graduator.RESCUE_DELAY();

        vm.warp(opensAt - 1);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Graduator.RescueNotOpenYet.selector, stranger, opensAt));
        s.graduator.rescueCurveFees(address(l.token));

        uint256 creditBefore = s.escrow.balanceOfToken(creator, s.a.quote);
        vm.prank(stranger);
        s.graduator.graduate(address(l.token));
        assertTrue(l.curve.graduated(), "the move did not complete");
        assertEq(IERC20(s.a.quote).balanceOf(creator), 0, "the creator was paid raw WETH");
        assertEq(
            s.escrow.balanceOfToken(creator, s.a.quote) - creditBefore, tax, "the creator's tax did not reach the escrow"
        );

        vm.warp(opensAt);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Graduator.RescueNotOpenYet.selector, stranger, opensAt));
        s.graduator.rescueCurveFees(address(l.token));
    }

    /// A LAUNCH NOBODY MOVES FOR THE HOUR IS STUCK, AND THEN ANYONE MAY RESCUE
    /// IT - the recovery the hatch exists for, still behind no operator. The
    /// rescue pays the creator directly, and the move completes after it.
    function test_aCurveLeftFullForTheHourOpensTheRescueToAStranger() public onlyFork {
        (Stack memory s, Launched memory l, StarvingBuyer b,) = _setUpFill();
        _starve(s, l, b);
        uint256 tax = l.curve.creatorTaxBalance();
        vm.prank(stranger);
        uint256 since = s.graduator.noteReady(address(l.token));
        vm.warp(since + s.graduator.RESCUE_DELAY());

        vm.prank(stranger);
        (, uint256 creatorAmount) = s.graduator.rescueCurveFees(address(l.token));
        assertGe(creatorAmount, tax, "the rescue did not pay the creator's tax");
        assertEq(IERC20(s.a.quote).balanceOf(creator), creatorAmount, "the rescue paid the creator somewhere else");

        vm.prank(stranger);
        s.graduator.graduate(address(l.token));
        assertTrue(l.curve.graduated(), "the move did not complete after the rescue");
    }
}
