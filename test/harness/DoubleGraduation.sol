// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

import {Graduator} from "../../src/curb/Graduator.sol";
import {PositionLock} from "../../src/curb/PositionLock.sol";
import {PonsV2BondingCurve} from "../../src/vendor/PonsV2BondingCurve.sol";

/**
 * @title DoubleGraduation
 * @notice Two graduations inside ONE transaction, which nothing else in this
 *         repository does.
 *
 * WHY THIS NEEDS A CONTRACT AT ALL. A test can call graduate() twice, but each
 * call is its own transaction and that is exactly the case already covered.
 * The interesting one is both landing in a single transaction, and from
 * Solidity that means one contract making both calls.
 *
 * AUDIT.txt section F said this was untested and it was: F's two graduations
 * always land in separate transactions, so anything that persists for the
 * length of a TRANSACTION rather than a call - Uniswap v4's transient deltas
 * and its unlock flag above all - has never had a second graduation land on
 * top of it.
 *
 * IT HAS NO PRIVILEGES AND HOLDS NOTHING. Graduation is permissionless by
 * design, so this is an ordinary caller doing an ordinary thing twice.
 */
contract DoubleGraduation {
    /// Both graduations, back to back, one transaction.
    function graduateBoth(Graduator graduator, address launchA, address launchB)
        external
        returns (PositionLock lockA, PositionLock lockB)
    {
        (lockA,,) = graduator.graduate(launchA);
        (lockB,,) = graduator.graduate(launchB);
    }

    /// ANY NUMBER OF THEM, IN WHATEVER ORDER THE CALLER GIVES. Two graduations
    /// can only be in one order or the reverse, so nothing about two can tell
    /// an order-dependent bug from a coincidence. Three can be handed over in
    /// an order that is not their registration order, which is the case a
    /// registry lookup keyed on position rather than on identity would get
    /// wrong.
    function graduateAll(Graduator graduator, address[] calldata launches)
        external
        returns (PositionLock[] memory locks)
    {
        locks = new PositionLock[](launches.length);
        for (uint256 i = 0; i < launches.length; i++) {
            (locks[i],,) = graduator.graduate(launches[i]);
        }
    }
}

/**
 * @title DoubleFinisher
 * @notice The REALISTIC version of the same thing: one transaction that buys
 *         the last slice of two curves, so both graduate through the crossing
 *         buy's own automatic trigger rather than through a deliberate call.
 *
 * WHY THIS IS THE ONE THAT WOULD ACTUALLY HAPPEN. Nobody sets out to graduate
 * two launches at once. An aggregator, a batcher or an MEV bot filling two
 * pending buys in one transaction does it without meaning to, and then the
 * second graduation runs inside a transaction the first one has already left
 * its marks on.
 *
 * The caller must have approved this contract for the quote asset first; it
 * pulls what it needs, approves each curve and sends the tokens straight back.
 */
contract DoubleFinisher {
    function finishBoth(
        IERC20 quote,
        PonsV2BondingCurve curveA,
        PonsV2BondingCurve curveB,
        uint256 amountEach
    ) external returns (uint256 gotA, uint256 gotB) {
        quote.transferFrom(msg.sender, address(this), amountEach * 2);
        quote.approve(address(curveA), type(uint256).max);
        quote.approve(address(curveB), type(uint256).max);

        // Recipient is the CALLER, not this contract: what is under test is
        // the two graduations sharing a transaction, not where tokens land.
        gotA = curveA.buy(amountEach, 0, msg.sender);
        gotB = curveB.buy(amountEach, 0, msg.sender);

        // Whatever the curves refunded for overshooting goes back too, so this
        // contract ends holding nothing and cannot quietly absorb a difference
        // the test is trying to measure.
        uint256 left = quote.balanceOf(address(this));
        if (left != 0) quote.transfer(msg.sender, left);
    }
}
