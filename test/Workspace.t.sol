// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Curb} from "../src/Curb.sol";

/// Proves the workspace resolves OpenZeppelin, v4-core and our own source.
contract WorkspaceTest is Test {
    function test_workspaceWiring() public {
        assertEq(new Curb().NAME(), "CURB");
        assertGt(TickMath.MAX_TICK, 0);
        assertTrue(type(IERC20Metadata).interfaceId != bytes4(0));
    }
}
