// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

import {PositionLock, IPositionManagerMinimal} from "../../src/curb/PositionLock.sol";

/**
 * @title PositionLockFactory
 * @notice Creates a lock and deposits the position in ONE transaction.
 *
 * MOVED HERE FROM src/curb/PositionLock.sol ON 2026-09-21 - AUDIT A-8. It was
 * never deployed: the Graduator creates its lock itself and transfers the NFT
 * in the same call, so this had two users and both were fork tests. Sitting in
 * src/ it compiled into the production source set and would have appeared in a
 * verified-source bundle on an explorer, where a reader cannot tell deployed
 * code from code that is not.
 *
 * IT IS STILL WORTH HAVING, which is why it moved rather than went. The two
 * tests that use it exercise PositionLock's deposit path on its own, separately
 * from a whole graduation - and a lock that can only be tested through a
 * graduation is a lock whose own failures are hard to see.
 *
 * WHY IT EXISTS AT ALL. PositionLock's own checks make a WRONG deposit
 * impossible, but two separate transactions still leave a window in which the
 * intended deposit has not happened yet. Doing both here removes the window
 * rather than arguing that it is short.
 *
 * It holds nothing and has no privileges. It needs approval for the ONE token
 * it is about to move - approve(factory, tokenId), NOT setApprovalForAll - and
 * it transfers that token to a lock it created in the same call, so there is no
 * state in which it can direct a position anywhere else.
 */
contract PositionLockFactory {
    event LockCreated(address indexed lock, uint256 indexed tokenId, address indexed beneficiary);

    function createAndLock(
        IPositionManagerMinimal positionManager,
        address beneficiary,
        PoolKey calldata poolKey,
        uint256 tokenId
    ) external returns (PositionLock lock) {
        // No sharing source: a lock built outside a graduation pays the beneficiary.
        lock = new PositionLock(positionManager, beneficiary, poolKey, tokenId, address(0), address(0));
        IERC721(address(positionManager)).safeTransferFrom(msg.sender, address(lock), tokenId);
        emit LockCreated(address(lock), tokenId, beneficiary);
    }
}
