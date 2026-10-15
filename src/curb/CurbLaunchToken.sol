// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title CurbLaunchToken
 * @notice The token a launch creates. Fixed supply, minted once, to the curve.
 *
 * Deliberately plain. No mint after construction, no owner, no pause, no
 * blacklist, no transfer hook - every one of those is a lever someone would
 * eventually have to be trusted not to pull, and a launchpad's whole claim is
 * that there is nobody to trust.
 *
 * The entire supply goes to the bonding curve at construction. Buyers get
 * theirs by buying; whatever is unsold at graduation is the curve's to hand
 * over. There is no allocation to anyone, including us, because there is no
 * second mint.
 *
 * IT CAN BE BURNED, AND BURNING REALLY REDUCES totalSupply
 *   Graduation burns the part of the reserve the pool could not absorb. That
 *   has to be a real burn: OpenZeppelin's _burn is internal, and sending to
 *   address(0) or a dead address does NOT reduce totalSupply - it would leave
 *   every reader of the supply, from a price chart to a governance quorum,
 *   quoting a float that does not exist.
 *
 *   burn() destroys the CALLER'S OWN tokens and nothing else. There is no
 *   burnFrom, no allowance path and no privileged burner, so no address can
 *   destroy anyone else's balance.
 */
contract CurbLaunchToken is ERC20 {
    string private _tokenUri;

    constructor(string memory name_, string memory symbol_, string memory tokenUri_, address curve_, uint256 supply_)
        ERC20(name_, symbol_)
    {
        _tokenUri = tokenUri_;
        _mint(curve_, supply_);
    }

    /// @notice Destroys `amount` of the caller's own tokens, reducing
    ///         totalSupply by the same amount.
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    /// @notice Off-chain metadata (image, description, links) for this launch.
    function tokenURI() external view returns (string memory) {
        return _tokenUri;
    }
}
