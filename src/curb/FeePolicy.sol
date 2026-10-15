// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {FeePolicySnapshot, IPonsV2FeeEscrow, IPonsV2FeePolicy} from "../vendor/interfaces/ILaunchpadV2.sol";

/**
 * @title FeePolicy
 * @notice The fee terms a deployment publishes, as a contract the curve can ask.
 *
 * WHAT IT REPLACES. The stack shipped with MockFeePolicy, imported into the
 * deployment script out of test/. That was the last piece of test code in the
 * deploy path.
 *
 * WHAT THE CURVE ACTUALLY READS FROM IT - ONE THING
 *   PonsV2BondingCurve asks a policy for exactly one value at runtime:
 *   feeSweepOperator(), when someone calls sweepFees. Every other number it
 *   uses was SNAPSHOTTED at construction from what the FACTORY handed it, not
 *   from here.
 *
 *   That does not make the rest decoration. They are what a reader - a person,
 *   an indexer, a front end - gets when they ask this deployment what its terms
 *   are, and an answer that is merely unused is still an answer. So each one
 *   has to be the SAME value the factory writes into a launch. Below is how
 *   that is guaranteed rather than hoped for - with ONE EXCEPTION.
 *
 * THE EXCEPTION: THE PLATFORM RECIPIENT IS THE ONE AT DEPLOYMENT
 *   launch() does not take the recipient from here or from the factory's own
 *   copy. It reads the hook's platformRecipient, which the hook's owner can
 *   rotate behind an announcement, and stamps THAT into the launch's record;
 *   the curve and the pool both pay from the stamp. So protocolFeeRecipient()
 *   below is right on the day of deployment and stale after the first
 *   rotation. The live answer is CurbLaunchFactory.currentPlatformPolicy(),
 *   and a launch's own answer is its registry record. This header used to
 *   promise the published recipient was always the one launches are written
 *   with.
 *
 * WHAT IS A CONSTANT HERE AND WHY THAT MATTERS
 *   Four of these terms are not this deployment's to choose - they are what
 *   the product IS - so they are constants rather than constructor arguments:
 *
 *       protocolFeeShareBps  10000   all of the base fee, which is what keeps
 *                                    the platform's share (read off the hook at
 *                                    launch and frozen per launch; 50 bps at
 *                                    deployment, settable 0-80 for future
 *                                    launches) independent of the tax a creator
 *                                    picked
 *       buybackBurnBps           0   buyback is off for every launch
 *       hookFeeBps               0   read by nothing in this stack
 *       feeSweepOperator      0x00   there is no such role
 *
 *   THEY USED TO BE ARGUMENTS, AND THE DEPLOYMENT CHECKED ONLY SOME OF THEM.
 *   It compared the recipient, the share, the impact ceiling, the escrow and
 *   the operator - and not buybackBurnBps or hookFeeBps. The factory writes
 *   zero for both into every launch, so a policy deployed with anything else
 *   would have published terms no launch uses and every check would still have
 *   passed. A value that cannot be set cannot be set wrong; that is why these
 *   moved here rather than gaining a sixth comparison.
 *
 *   What remains an argument is what a DEPLOYMENT genuinely decides: who is
 *   paid, which escrow holds it, and the price-impact ceiling.
 *
 * NOTHING HERE IS ADJUSTABLE
 *   No owner, no setters. Changing a term published here means deploying a new
 *   policy and a new factory - except the platform's share and recipient,
 *   which live on the hook, not here (see above). Either way, launches already
 *   created keep the terms they were created with, because a curve snapshots
 *   them and the registry record is write-once.
 *   That is the same shape as everything else in this stack and it is the
 *   reason a live launch cannot be repriced by anybody, including us.
 */
contract FeePolicy is IPonsV2FeePolicy {
    /// No operator exists, at any address. See the note above.
    address public constant NO_SWEEP_OPERATOR = address(0);
    /// All of the base fee. Must equal CurbLaunchFactory.PROTOCOL_FEE_SHARE_BPS,
    /// which the deployment asserts.
    uint16 public constant PROTOCOL_FEE_SHARE_BPS = 10_000;
    /// Buyback is off for every launch this stack creates.
    uint16 public constant BUYBACK_BURN_BPS = 0;
    /// Read by nothing here. Zero rather than a number that would look meant.
    uint16 public constant HOOK_FEE_BPS = 0;

    address private immutable _protocolFeeRecipient;
    uint16 private immutable _maxInternalPriceImpactBps;
    IPonsV2FeeEscrow private immutable _feeEscrow;

    error ZeroAddress();
    error ImpactOutOfRange(uint16 bps);

    constructor(address protocolFeeRecipient_, IPonsV2FeeEscrow feeEscrow_, uint16 maxInternalPriceImpactBps_) {
        if (protocolFeeRecipient_ == address(0) || address(feeEscrow_) == address(0)) revert ZeroAddress();
        // The curve refuses a zero or a full 10,000 here, so a policy that
        // published one could never be used to launch anything. Refused where
        // it is written rather than discovered at the first launch.
        if (maxInternalPriceImpactBps_ == 0 || maxInternalPriceImpactBps_ >= 10_000) {
            revert ImpactOutOfRange(maxInternalPriceImpactBps_);
        }

        _protocolFeeRecipient = protocolFeeRecipient_;
        _maxInternalPriceImpactBps = maxInternalPriceImpactBps_;
        _feeEscrow = feeEscrow_;
    }

    function protocolFeeShareBps() external pure returns (uint256) {
        return PROTOCOL_FEE_SHARE_BPS;
    }

    function buybackBurnBps() external pure returns (uint256) {
        return BUYBACK_BURN_BPS;
    }

    /// @notice The platform recipient AT DEPLOYMENT. Not what a launch created
    ///         today is stamped with - see the note at the top; ask
    ///         CurbLaunchFactory.currentPlatformPolicy() for that.
    function protocolFeeRecipient() external view returns (address) {
        return _protocolFeeRecipient;
    }

    function feeEscrow() external view returns (IPonsV2FeeEscrow) {
        return _feeEscrow;
    }

    function maxInternalPriceImpactBps() external view returns (uint256) {
        return _maxInternalPriceImpactBps;
    }

    /// @notice Always the zero address. See the note at the top.
    function feeSweepOperator() external pure returns (address) {
        return NO_SWEEP_OPERATOR;
    }

    /// @notice The whole of it, in the shape the factory hands a curve.
    /// @dev BUILT FROM THE SAME CONSTANTS AND THE SAME IMMUTABLES the getters
    ///      return, so the struct and the individual answers cannot disagree.
    ///      The factory builds its own snapshot rather than reading this one -
    ///      it has to, since it is constructed before the factory exists - and
    ///      the deployment asserts the two agree on everything a deployment
    ///      chooses, AT DEPLOYMENT. protocolFeeRecipient in this struct is the
    ///      deployment's; a launch's is read from the hook when it is created.
    function currentFeePolicy() external view returns (FeePolicySnapshot memory) {
        return FeePolicySnapshot({
            protocolFeeRecipient: _protocolFeeRecipient,
            protocolFeeShareBps: PROTOCOL_FEE_SHARE_BPS,
            buybackBurnBps: BUYBACK_BURN_BPS,
            hookFeeBps: HOOK_FEE_BPS,
            maxInternalPriceImpactBps: _maxInternalPriceImpactBps
        });
    }
}
