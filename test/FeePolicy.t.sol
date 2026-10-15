// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {FeePolicySnapshot, IPonsV2FeeEscrow} from "../src/vendor/interfaces/ILaunchpadV2.sol";
import {FeePolicy} from "../src/curb/FeePolicy.sol";

/**
 * @title FeePolicyTest
 * @notice Can a policy be deployed that publishes terms no launch would use?
 *
 * THE GAP THIS IS FOR, and it was found by reading rather than by a test.
 * protocolFeeShareBps, buybackBurnBps, hookFeeBps and feeSweepOperator were all
 * constructor arguments, and the deployment script compared only some of them -
 * not buybackBurnBps and not hookFeeBps. The factory writes zero for both into
 * every launch, so a policy deployed with anything else would have published
 * terms nothing uses and every assertion in the deployment would still have
 * passed.
 *
 * They are constants now. A value that cannot be set cannot be set wrong, and
 * these tests are what says so: there is no argument that reaches them, and the
 * struct and the individual getters are built from the same constants so they
 * cannot disagree with each other either.
 *
 * NO FORK NEEDED. Nothing here touches B20 or Uniswap - the policy is a
 * contract that answers questions - so this runs with the ordinary suite and
 * costs a fraction of a second.
 */
contract FeePolicyTest is Test {
    address internal platform = makeAddr("platform");
    address internal escrow = makeAddr("escrow");
    uint16 internal constant IMPACT = 500;

    function _policy() internal returns (FeePolicy) {
        return new FeePolicy(platform, IPonsV2FeeEscrow(escrow), IMPACT);
    }

    /// THE FOUR THAT ARE NOT A DEPLOYMENT'S TO CHOOSE. There is no constructor
    /// argument for any of them, so this is checking that the values are the
    /// ones the product needs - not that a caller passed them correctly.
    function test_theProductsFixedTermsAreConstants() public {
        FeePolicy policy = _policy();

        assertEq(policy.protocolFeeShareBps(), 10_000, "the protocol does not take all of the base fee");
        assertEq(policy.buybackBurnBps(), 0, "buyback is not off");
        assertEq(policy.feeSweepOperator(), address(0), "this policy names a sweep operator");
        assertEq(policy.currentFeePolicy().hookFeeBps, 0, "the unused hook rate is not zero");

        // And the same values are what the type itself publishes, so a reader
        // does not need an instance to know them.
        assertEq(FeePolicy(policy).PROTOCOL_FEE_SHARE_BPS(), 10_000, "the constant disagrees with the getter");
        assertEq(FeePolicy(policy).BUYBACK_BURN_BPS(), 0, "the constant disagrees with the getter");
        assertEq(FeePolicy(policy).HOOK_FEE_BPS(), 0, "the constant disagrees with the getter");
        assertEq(FeePolicy(policy).NO_SWEEP_OPERATOR(), address(0), "the constant disagrees with the getter");
    }

    /// THE STRUCT AND THE GETTERS CANNOT DISAGREE, because they are built from
    /// the same constants and the same immutables. Somebody reading
    /// currentFeePolicy() and somebody reading the getters must not get
    /// different answers about the same deployment.
    function test_theSnapshotAgreesWithEveryGetter() public {
        FeePolicy policy = _policy();
        FeePolicySnapshot memory snap = policy.currentFeePolicy();

        assertEq(snap.protocolFeeRecipient, policy.protocolFeeRecipient(), "recipient");
        assertEq(uint256(snap.protocolFeeShareBps), policy.protocolFeeShareBps(), "share");
        assertEq(uint256(snap.buybackBurnBps), policy.buybackBurnBps(), "buyback burn");
        assertEq(uint256(snap.maxInternalPriceImpactBps), policy.maxInternalPriceImpactBps(), "impact ceiling");
    }

    /// THE SHARE MUST ALSO BE THE FACTORY'S - two constants in two contracts,
    /// with nothing in the language making them equal. That comparison needs a
    /// deployed factory, so it lives where one exists:
    ///   B20Graduation.t.sol :: test_policy_agreesWithTheFactoryOnEveryTerm
    /// and DeployCurb asserts it again before anything is registered. Solidity
    /// cannot read another contract's public constant through its type, which
    /// is why it is not done here.

    // ----------------------------------------------------------------
    // what a deployment CAN choose, and what it cannot get away with
    // ----------------------------------------------------------------

    function test_aZeroRecipientIsRefused() public {
        vm.expectRevert(FeePolicy.ZeroAddress.selector);
        new FeePolicy(address(0), IPonsV2FeeEscrow(escrow), IMPACT);
    }

    function test_aZeroEscrowIsRefused() public {
        vm.expectRevert(FeePolicy.ZeroAddress.selector);
        new FeePolicy(platform, IPonsV2FeeEscrow(address(0)), IMPACT);
    }

    /// THE CURVE REFUSES BOTH ENDS OF THIS, so a policy publishing one could
    /// never launch anything. Refused where it is written instead.
    function test_anImpactCeilingTheCurveWouldRejectIsRefused() public {
        vm.expectRevert(abi.encodeWithSelector(FeePolicy.ImpactOutOfRange.selector, uint16(0)));
        new FeePolicy(platform, IPonsV2FeeEscrow(escrow), 0);

        vm.expectRevert(abi.encodeWithSelector(FeePolicy.ImpactOutOfRange.selector, uint16(10_000)));
        new FeePolicy(platform, IPonsV2FeeEscrow(escrow), 10_000);

        // And the edges that ARE allowed really are, so the refusal above is
        // specific rather than a constructor that refuses everything.
        new FeePolicy(platform, IPonsV2FeeEscrow(escrow), 1);
        new FeePolicy(platform, IPonsV2FeeEscrow(escrow), 9_999);
    }

    /// THE THREE ARGUMENTS ARE THE THREE THINGS A DEPLOYMENT DECIDES, and they
    /// are carried through unchanged. Nothing else is reachable from outside.
    function test_theThreeArgumentsAreWhatTheyWereGiven() public {
        FeePolicy policy = new FeePolicy(platform, IPonsV2FeeEscrow(escrow), 1234);
        assertEq(policy.protocolFeeRecipient(), platform, "the recipient changed");
        assertEq(address(policy.feeEscrow()), escrow, "the escrow changed");
        assertEq(policy.maxInternalPriceImpactBps(), 1234, "the impact ceiling changed");
    }
}
