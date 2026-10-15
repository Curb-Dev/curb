// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {PositionInfo, PositionInfoLibrary} from "@uniswap/v4-periphery/src/libraries/PositionInfoLibrary.sol";

import {IHolderSharingSource} from "./sharing/ICurbSharing.sol";

interface IPositionManagerMinimal {
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
    function getPositionLiquidity(uint256 tokenId) external view returns (uint128);
    function positionInfo(uint256 tokenId) external view returns (PositionInfo);
}

/**
 * @title PositionLock
 * @notice Holds ONE NAMED Uniswap v4 LP position NFT FOREVER, while its trading
 *         fees are claimed.
 *
 * THE LIQUIDITY NEVER LEAVES
 *   Nobody can take the principal out, ever. Not the launcher, not the
 *   beneficiary, not us, not after any amount of time. That is the whole
 *   product claim, so the contract is built to have no way out at all:
 *
 *     - NO OWNER, NO ADMIN, NO PAUSE, NO RESCUE, NO UPGRADE. There is no
 *       privileged address anywhere in this file. A rescue function would make
 *       every sentence above false, whatever its intentions.
 *     - NO UNLOCK TIME AND NO WITHDRAWAL. No function transfers the NFT out,
 *       approves anyone for it, or removes liquidity from it. The only call
 *       this contract ever makes to the PositionManager is the fee collection
 *       below, with the liquidity to remove HARDCODED to zero and the tokens
 *       taken to this contract.
 *
 * THE LOCK IS BOUND TO A SPECIFIC POSITION BEFORE IT EVER RECEIVES ONE
 *   An earlier version only checked that an incoming NFT came from the right
 *   PositionManager. That is not enough: ANY holder of ANY position from that
 *   same PositionManager could have sent theirs first and filled a single-use
 *   lock, leaving the intended position with nowhere to go. So:
 *
 *     - tokenId is IMMUTABLE and checked on receipt
 *     - the position's pool is checked to be the pool this lock names, because
 *       a token id does not say where the liquidity is, and the pool is what
 *       every claim about this lock is really about
 *
 *   test/harness/PositionLockFactory.sol closes the remaining window by
 *   creating the lock and depositing in one call. It lives under test/ because
 *   nothing deploys it - the Graduator does both itself [AUDIT A-8].
 *
 * FEES ARE CLAIMABLE, PRINCIPAL IS NOT
 *   claimFees() calls DECREASE_LIQUIDITY with a HARDCODED liquidity of zero,
 *   which in v4 collects accrued fees and nothing else. The amount is not a
 *   parameter, so there is no value a caller can pass that removes principal.
 *
 * WHERE FEES GO
 *   To the beneficiary, or, once the launch's holder sharing is on, to its
 *   distributor; that switch is read live from the Graduator and is one way.
 *   The recipient is never a parameter a stranger can fill in.
 *
 * COLLECT FIRST, THEN PAY - OR HOLD
 *   Fees are taken into this contract and only then sent on, measured as the
 *   change in this contract's balances. A recipient that cannot take delivery
 *   (an issuer's block, a refusing token) does not stop the collection: the
 *   amount is written down in `held` for THAT recipient and anyone can push it
 *   out later with release(). So a caller who starves the transfer of gas only
 *   gets the amount held for the same recipient.
 *
 * KNOWN LIMITS, STATED RATHER THAN DISCOVERED LATER
 *   - The beneficiary is immutable and cannot be the zero address. If their key
 *     is lost, the fees go with it, unless the launch's holder sharing is on.
 *     A transferable beneficiary would be a second way to move value and is
 *     deliberately not here.
 *   - One position per lock, for the life of the lock.
 *   - AN ISSUER THAT BLOCKS THIS CONTRACT ITSELF stops every collection until
 *     the block is lifted. Every CURB contract that holds an issuer's asset has
 *     the same exposure.
 *   - NATIVE ETH POOLS ARE REFUSED at construction: collecting by balance
 *     delta is written for two ERC-20s, and no CURB pool uses native ETH.
 */
contract PositionLock is IERC721Receiver {
    using PoolIdLibrary for PoolKey;
    using PositionInfoLibrary for PositionInfo;

    IERC721 public immutable positionNft;
    IPositionManagerMinimal public immutable positionManager;
    address public immutable beneficiary;
    /// The one position this lock will ever accept. Immutable, so it cannot be
    /// decided by whoever transfers first.
    uint256 public immutable tokenId;
    /// Who says whether this launch's fees go to its holders - the Graduator
    /// that built this lock - and for which token. Zero for a lock built
    /// outside a graduation: its fees always go to the beneficiary.
    IHolderSharingSource public immutable sharingSource;
    address public immutable launchToken;

    PoolKey internal poolKey;

    /// True from the moment the position arrives. Nothing sets it back.
    bool public holdsPosition;

    /// Fees this lock collected and could not deliver, per recipient and per
    /// currency index (0 = poolKey.currency0, 1 = currency1). release() pays
    /// them out. Only a fee recipient - the beneficiary, or the distributor
    /// once sharing is on - is ever written here.
    mapping(address party => uint256[2]) public held;

    event PositionLocked(uint256 indexed tokenId);
    /// `to` is who the collected amounts were for; FeesHeld follows for any
    /// part that could not be delivered.
    event FeesClaimed(uint256 indexed tokenId, address indexed to, uint256 amount0, uint256 amount1);
    event FeesHeld(address indexed party, uint256 indexed currencyIndex, uint256 amount);
    event FeesReleased(address indexed party, uint256 amount0, uint256 amount1);

    error NoPositionHeld();
    error OnlyOnePosition();
    error NotThePositionManager(address caller);
    error WrongPosition(uint256 expected, uint256 received);
    error WrongPool(bytes25 expected, bytes25 received);
    error BeneficiaryIsZero();
    error NativeCurrencyNotSupported();
    error NothingHeld(address party);
    /// release() could not deliver; the booking is kept.
    error ReleaseRefused(address party, uint256 currencyIndex);

    constructor(
        IPositionManagerMinimal positionManager_,
        address beneficiary_,
        PoolKey memory poolKey_,
        uint256 tokenId_,
        address sharingSource_,
        address launchToken_
    ) {
        if (beneficiary_ == address(0)) revert BeneficiaryIsZero();
        if (Currency.unwrap(poolKey_.currency0) == address(0) || Currency.unwrap(poolKey_.currency1) == address(0)) {
            revert NativeCurrencyNotSupported();
        }
        positionManager = positionManager_;
        positionNft = IERC721(address(positionManager_));
        beneficiary = beneficiary_;
        poolKey = poolKey_;
        tokenId = tokenId_;
        sharingSource = IHolderSharingSource(sharingSource_);
        launchToken = launchToken_;
    }

    /// @notice Accepts the ONE position this lock names, from the
    ///         PositionManager it was built for, once.
    function onERC721Received(address, address, uint256 tokenId_, bytes calldata) external returns (bytes4) {
        if (msg.sender != address(positionNft)) revert NotThePositionManager(msg.sender);
        if (holdsPosition) revert OnlyOnePosition();
        if (tokenId_ != tokenId) revert WrongPosition(tokenId, tokenId_);

        bytes25 expectedPool = bytes25(PoolId.unwrap(poolKey.toId()));
        bytes25 actualPool = positionManager.positionInfo(tokenId_).poolId();
        if (actualPool != expectedPool) revert WrongPool(expectedPool, actualPool);

        holdsPosition = true;
        emit PositionLocked(tokenId_);
        return IERC721Receiver.onERC721Received.selector;
    }

    /// @notice Where this lock's fees go: the launch's holder distributor once
    ///         its sharing is on, the beneficiary otherwise.
    /// @dev READ LIVE, never stored here, so this lock has no setter and
    ///      nothing to keep in step. A failing read reverts rather than falling
    ///      back to the beneficiary: a fallback would let a caller starve the
    ///      read of gas and pay the beneficiary fees that belong to holders.
    function feeRecipient() public view returns (address) {
        address d = _distributor();
        return d == address(0) ? beneficiary : d;
    }

    /// The launch's distributor, or zero while its sharing is off.
    function _distributor() private view returns (address) {
        if (address(sharingSource) == address(0)) return address(0);
        return sharingSource.holderDistributorOf(launchToken);
    }

    /// @notice Collects accrued trading fees and sends them to feeRecipient(),
    ///         or holds them for it if it cannot take delivery. Callable by
    ///         anyone, because the destination is fixed and there is nothing to
    ///         gain by calling it on someone else's behalf.
    function claimFees() external {
        if (!holdsPosition) revert NoPositionHeld();
        _claimTo(feeRecipient());
    }

    /// @notice Pays `party` what this lock is holding for it. Anyone may push
    ///         it; the destination is the party itself.
    function release(address party) external {
        uint256[2] memory h;
        for (uint256 i = 0; i < 2; i++) {
            h[i] = held[party][i];
            if (h[i] == 0) continue;
            held[party][i] = 0;
            // Reverting on a refusal puts both bookings back; the party is
            // paid the whole of what is held, or nothing.
            if (!_transfer(i, party, h[i])) revert ReleaseRefused(party, i);
        }
        if (h[0] == 0 && h[1] == 0) revert NothingHeld(party);
        emit FeesReleased(party, h[0], h[1]);
    }

    function _token(uint256 i) private view returns (IERC20) {
        return IERC20(Currency.unwrap(i == 0 ? poolKey.currency0 : poolKey.currency1));
    }

    /// Collects the accrued fees INTO THIS CONTRACT, measured as balance
    /// deltas - so nothing depends on the recipient accepting, and nothing
    /// already held here is counted again - then sends each currency to `to`,
    /// or holds it for `to` if it cannot take delivery.
    function _claimTo(address to) private {
        uint256[2] memory got;
        for (uint256 i = 0; i < 2; i++) {
            got[i] = _token(i).balanceOf(address(this));
        }
        // ---- the ONLY call this contract makes to the PositionManager.
        // DECREASE_LIQUIDITY by a literal zero collects fees and nothing else,
        // and TAKE_PAIR sends what it collected here. Neither the liquidity
        // nor the destination is a parameter, so neither can be anything else.
        bytes memory actions = abi.encodePacked(uint8(Actions.DECREASE_LIQUIDITY), uint8(Actions.TAKE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(tokenId, uint256(0), uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(poolKey.currency0, poolKey.currency1, address(this));
        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp);
        for (uint256 i = 0; i < 2; i++) {
            uint256 amount = _token(i).balanceOf(address(this)) - got[i];
            got[i] = amount;
            if (amount == 0 || _transfer(i, to, amount)) continue;
            held[to][i] += amount;
            emit FeesHeld(to, i, amount);
        }
        emit FeesClaimed(tokenId, to, got[0], got[1]);
    }

    /// One transfer, which may fail without failing anything else. It counts
    /// as delivered only if the call did not revert AND this contract's
    /// balance fell by exactly `amount`. Nothing of the reply is copied.
    ///
    /// THE BALANCE DECIDES, NOT THE RETURN VALUE. A token that returns false
    /// and moves nothing is caught by the balance; one that returns false and
    /// moves the amount anyway has delivered it, and booking it as held would
    /// promise a party tokens this contract no longer has - paid, on release,
    /// out of what is held for somebody else.
    function _transfer(uint256 i, address to, uint256 amount) private returns (bool ok) {
        IERC20 token = _token(i);
        uint256 before = token.balanceOf(address(this));
        bytes memory data = abi.encodeCall(IERC20.transfer, (to, amount));
        assembly ("memory-safe") {
            ok := call(gas(), token, 0, add(data, 0x20), mload(data), 0, 0)
        }
        ok = ok && token.balanceOf(address(this)) + amount == before;
    }

    /// @notice The liquidity this lock is holding, read from PositionManager
    ///         rather than from anything this contract stores. It never goes
    ///         down: nothing here removes liquidity.
    function lockedLiquidity() external view returns (uint128) {
        if (!holdsPosition) return 0;
        return positionManager.getPositionLiquidity(tokenId);
    }

    function poolKeyView() external view returns (PoolKey memory) {
        return poolKey;
    }
}
