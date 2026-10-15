// SPDX-License-Identifier: MIT
//
// ---------------------------------------------------------------------------
// THIRD-PARTY CODE - VENDORED UNMODIFIED, FOR EVALUATION AND TESTING
//
//   Source   : github.com/ponsdotdev/ponsfamily
//              contractsV2/src/v2/interfaces/ILaunchpadV2Graduation.sol
//   Commit   : debbc21fb27761245356fe9b61a9276437147a1c
//   Licence  : MIT (as declared by the upstream file)
//   Retrieved: 11 September 2026
//
//   Vendored so our tests can exercise the REAL contract rather than a
//   reimplementation. Presence here is NOT adoption: the reuse decision is
//   open (REUSE_ANALYSIS.txt, DIFF_TABLE.txt). In particular the interfaces
//   encode PONS's fee-escrow, buyback and graduation model, which we have
//   deliberately not committed to.
//
//   Copied verbatim - do not edit. To change behaviour, fork into src/ under
//   our own name so this file's provenance stays exact.
// ---------------------------------------------------------------------------
pragma solidity ^0.8.26;

/**
 * @notice Narrow callback a bonding curve uses to ask its factory to graduate
 * a token the instant a buy crosses the ETH threshold. Kept separate from
 * ILaunchpadV2.sol so the curve's compile unit stays free of the factory's
 * full launch-record surface.
 */
interface IPonsV2LaunchFactoryGraduation {
    function graduate(address token) external;
}
