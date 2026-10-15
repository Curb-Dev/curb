// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice The part of WETH9 this project uses.
///
/// @dev DECLARED HERE RATHER THAN IMPORTED. WETH9 predates the interfaces it
///      would otherwise be described by - withdraw() takes a uint256 and
///      returns nothing, deposit() is payable and returns nothing - and the
///      canonical source is not a dependency of this project.
///
///      transfer() is here so a failed ETH send can fall back to handing over
///      the wrapped token. WETH9 returns true or reverts; it has no silent
///      failure and no transfer hook, which is why it is called directly
///      rather than through SafeERC20.
interface IWETH {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}
