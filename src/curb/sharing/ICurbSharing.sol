// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice The pinned interfaces between the CURB core and a launch's holder
///         fee distributor.
///
/// @dev PINNED (core v2 design, section E.2). These declarations change only
///      by an explicit amendment to the design. The core (Graduator, FeeHook,
///      PositionLock) and every distributor version are built against them,
///      so the two sides can be written and tested apart.
///
///      The event ABI, the Merkle leaf format, the epoch file schema and the
///      CURB-SHARE v1 spec pinned with them are listed in
///      docs/sharing/INTERFACES.md.

/// The list of distributor factory versions a launch may be switched to.
interface ISharingCatalog {
    function isApproved(address factory) external view returns (bool);
    function recommended() external view returns (address);
}

/// Implemented by the Graduator: where a launch's holder sharing switch lives.
interface IHolderSharingSource {
    function holderDistributorOf(address launchToken) external view returns (address);
    function sharingSince(address launchToken) external view returns (uint64);
    function lockOf(address launchToken) external view returns (address);
    function hasGraduated(address launchToken) external view returns (bool);
    function registry() external view returns (address);
    function poolManager() external view returns (address);
    function positionManager() external view returns (address);
}

/// A catalog-approved factory that deploys one distributor per launch.
interface IHolderDistributorFactory {
    function deploy(address launchToken) external returns (address); // deterministic, idempotent
    function predict(address launchToken) external view returns (address);
    function VERSION() external view returns (uint256);
}

/// What the Graduator checks on a freshly deployed distributor.
interface IHolderDistributorIdentity {
    function launchToken() external view returns (address);
    function quoteToken() external view returns (address);
    function graduator() external view returns (address);
}

interface IFeeHookSharing {
    function syncCreator(address launchToken) external; // onlyPoolOpener
}

interface IPositionLockSharing {
    function claimFees() external; // permissionless, collect-or-hold
    function release(address party) external; // permissionless
    function feeRecipient() external view returns (address);
    function held(address party, uint256 i) external view returns (uint256);
}
