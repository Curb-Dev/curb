// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

import {IHolderDistributorFactory, IHolderSharingSource} from "./ICurbSharing.sol";
import {HolderFeeDistributor, SHARING_VETO_WINDOW} from "./HolderFeeDistributor.sol";

interface ILaunchBookRegistered {
    function isRegistered(address launchToken) external view returns (bool);
}

/**
 * @title HolderDistributorFactory (v1)
 * @notice Builds each launch's HolderFeeDistributor at an address that depends
 *         on the launch token alone, and holds the roles its distributors
 *         answer to.
 *
 * ROLES
 *   owner (Ownable2Step, the platform Safe) - adds a vetoer, revokes the
 *     publisher and freezes, all at once: each of these only stops things.
 *     Everything that could let a payout through that a vetoer would stop -
 *     a new publisher, a new keeper payee, removing a vetoer, unfreezing -
 *     is announced first and takes effect only ROLE_DELAY (48 hours) after
 *     the announcement, and only within ROLE_WINDOW after that. It cannot
 *     publish, pay, sweep, upgrade, or change any cap: the caps, the veto
 *     window and the leaf format are constants of the distributor.
 *   vetoers - veto a pending root inside its hour (or at any time while the
 *     factory is frozen), and freeze. They cannot publish, pay or unfreeze.
 *   publisher - proposes one root per distributor at a time, within the
 *     distributor's on-chain caps. Nothing else.
 *   keeperPayee - receives the keeper's gas fee (at most 2% of each epoch).
 *
 * FROZEN
 *   No root is published, no pending root becomes payable (a ripe one waits),
 *   every pending root can be vetoed whatever its hour, and no publisher
 *   rotation is executed. Roots already active keep paying. Unfreezing is
 *   announced and waits ROLE_DELAY, so a freeze holds every queued root for at
 *   least that long - and a freeze cancels an unfreeze already announced, so
 *   every freeze starts that wait again.
 *
 * HOLDERS DEPEND ON A LIVE PUBLISHER, AND THERE IS NO FALLBACK
 *   Money leaves a distributor only under an activated root, and only this
 *   factory's publisher can propose one. If the platform stops publishing -
 *   the publisher key is lost and the owner cannot rotate it, or the keeper is
 *   shut down - no new root is ever published, and everything a switched
 *   launch's distributor receives after its last activated root waits in that
 *   distributor: no holder can claim it, the creator cannot take it back (the
 *   switch is one way, and without it the same income would have stayed the
 *   creator's to claim), and nothing sweeps it. What earlier roots allocated
 *   stays claimable. There is no fallback publisher: this limit is known and
 *   accepted, not overlooked.
 *
 * WHAT THE OWNER ALONE CAN DO TO HOLDERS, AND HOW LONG IT TAKES
 *   A root decides how much each holder is owed; the distributor checks its
 *   totals, not each holder's line, so the roles that publish a root and let
 *   it through decide the split. The vetoers are there to stop a wrong one.
 *   No vetoer can be removed without a ROLE_DELAY announcement, and not
 *   while any root relayed here is still inside its veto hour
 *   (vetoableUntil), so every root published while a vetoer is one gets that
 *   vetoer's whole hour. An owner that also holds the publisher key can
 *   therefore change how unpaid shares are split only after announcing the
 *   removal of every vetoer it does not hold, at least 48 hours ahead; during
 *   those hours holders can claim what the active root already gives them,
 *   and what they have been paid is never taken back.
 *
 * NOT UPGRADEABLE. The implementation is created by the constructor; every
 * distributor is a minimal proxy to it with no admin. A new version is a new
 * factory, admitted through the SharingCatalog, and it serves only launches
 * that switch sharing on after it was admitted.
 */
contract HolderDistributorFactory is IHolderDistributorFactory, Ownable2Step {
    uint256 public constant VERSION = 1;
    uint64 public constant ROLE_DELAY = 48 hours;
    uint64 public constant ROLE_WINDOW = 7 days;

    address public immutable registry;
    address public immutable graduator;
    address public immutable implementation;

    address public publisher;
    bool public frozen;
    address public pendingPublisher;
    uint64 public pendingPublisherAt;
    address public keeperPayee;
    address public pendingKeeperPayee;
    uint64 public pendingKeeperPayeeAt;
    /// The end of the veto hour of the latest root relayed here. No vetoer is
    /// removed before it.
    uint256 public vetoableUntil;
    /// When an announced unfreeze may be executed; 0 when none is announced.
    uint256 public pendingUnfreezeAt;

    mapping(address account => bool) public isVetoer;
    /// When an announced removal of a vetoer may be executed; 0 when none.
    mapping(address account => uint64) public vetoerRemovalAt;
    mapping(address launchToken => address) public distributorOf;
    mapping(address distributor => bool) public isDistributor;

    event DistributorDeployed(address indexed launchToken, address indexed distributor);
    event PublisherAnnounced(address indexed next, uint64 at);
    event PublisherUpdated(address indexed previous, address indexed next);
    event PublisherRevoked(address indexed previous);
    event KeeperPayeeAnnounced(address indexed next, uint64 at);
    event KeeperPayeeUpdated(address indexed previous, address indexed next);
    event PendingCancelled();
    event VetoerSet(address indexed account, bool isVetoer);
    event VetoerRemovalAnnounced(address indexed account, uint64 at);
    event Frozen(address indexed by);
    event UnfreezeAnnounced(uint64 at);
    /// A freeze cancelled the unfreeze that was announced.
    event UnfreezeCancelled(address indexed by);
    event Unfrozen();

    error ZeroAddress();
    error RegistryMismatch(address registry, address graduatorRegistry);
    error NotRegistered(address launchToken);
    error NotThePublisher(address caller);
    error PublishingFrozen();
    error NotFrozen();
    error NotAVetoer(address caller);
    error UnknownDistributor(address distributor);
    error LengthMismatch();
    error NothingAnnounced();
    error ChangeNotReady(uint64 at);
    error ChangeExpired(uint64 expiredAt);
    error RootsStillVetoable(uint256 until);
    error OwnershipCannotBeRenounced();

    constructor(
        address registry_,
        address graduator_,
        address owner_,
        address publisher_,
        address keeperPayee_,
        address[] memory vetoers_
    ) Ownable(owner_) {
        if (registry_ == address(0) || graduator_ == address(0) || publisher_ == address(0) || keeperPayee_ == address(0))
        {
            revert ZeroAddress();
        }
        address gr = IHolderSharingSource(graduator_).registry();
        if (gr != registry_) revert RegistryMismatch(registry_, gr);
        registry = registry_;
        graduator = graduator_;
        publisher = publisher_;
        keeperPayee = keeperPayee_;
        emit PublisherUpdated(address(0), publisher_);
        emit KeeperPayeeUpdated(address(0), keeperPayee_);
        for (uint256 i; i < vetoers_.length; ++i) {
            _setVetoer(vetoers_[i], true);
        }
        implementation = address(new HolderFeeDistributor(graduator_));
    }

    // ------------------------------------------------------------------
    // BUILDING
    // ------------------------------------------------------------------

    /// @notice The distributor for a registered launch token, built if it is
    ///         not yet. Anyone may call it, and calling it first changes
    ///         nothing: the address depends on the token alone, the clone is
    ///         initialized from the registry in the same transaction, and a
    ///         distributor the launch's switch never points at receives nothing.
    function deploy(address launchToken) external returns (address d) {
        d = distributorOf[launchToken];
        if (d != address(0)) return d;
        if (!ILaunchBookRegistered(registry).isRegistered(launchToken)) revert NotRegistered(launchToken);
        d = Clones.cloneDeterministic(implementation, _salt(launchToken));
        distributorOf[launchToken] = d;
        isDistributor[d] = true;
        HolderFeeDistributor(payable(d)).initialize(launchToken);
        emit DistributorDeployed(launchToken, d);
    }

    /// @notice Where a launch token's distributor is, or will be.
    function predict(address launchToken) external view returns (address) {
        return Clones.predictDeterministicAddress(implementation, _salt(launchToken));
    }

    function _salt(address launchToken) private pure returns (bytes32) {
        return bytes32(uint256(uint160(launchToken)));
    }

    // ------------------------------------------------------------------
    // PUBLISHING
    // ------------------------------------------------------------------

    function publish(address distributor, HolderFeeDistributor.Root calldata root, string calldata uri) external {
        _startPublishing();
        _publish(distributor, root, uri);
    }

    function publishMany(
        address[] calldata distributors,
        HolderFeeDistributor.Root[] calldata roots,
        string[] calldata uris
    ) external {
        _startPublishing();
        uint256 n = distributors.length;
        if (roots.length != n || uris.length != n) revert LengthMismatch();
        for (uint256 i; i < n; ++i) {
            _publish(distributors[i], roots[i], uris[i]);
        }
    }

    /// Only the publisher, never while frozen; and every root relayed now is
    /// vetoable for the next hour, so no vetoer is removed before that.
    function _startPublishing() private {
        if (msg.sender != publisher) revert NotThePublisher(msg.sender);
        if (frozen) revert PublishingFrozen();
        vetoableUntil = block.timestamp + SHARING_VETO_WINDOW;
    }

    function _publish(address distributor, HolderFeeDistributor.Root calldata root, string calldata uri) private {
        if (!isDistributor[distributor]) revert UnknownDistributor(distributor);
        HolderFeeDistributor(payable(distributor)).publish(root, uri);
    }

    // ------------------------------------------------------------------
    // STOPPING: each of these takes effect at once, because each only stops
    // ------------------------------------------------------------------

    /// @notice Vetoes a distributor's pending root inside its hour, or at any
    ///         time while frozen.
    function veto(address distributor, uint32 epoch, bytes32 reason) external {
        _checkVetoer();
        _veto(distributor, epoch, reason);
    }

    /// @notice Vetoes several pending roots in one transaction - everything a
    ///         publishMany queued, say. All or nothing.
    function vetoMany(address[] calldata distributors, uint32[] calldata epochs, bytes32 reason) external {
        _checkVetoer();
        uint256 n = distributors.length;
        if (epochs.length != n) revert LengthMismatch();
        for (uint256 i; i < n; ++i) {
            _veto(distributors[i], epochs[i], reason);
        }
    }

    function _checkVetoer() private view {
        if (!isVetoer[msg.sender]) revert NotAVetoer(msg.sender);
    }

    function _veto(address distributor, uint32 epoch, bytes32 reason) private {
        if (!isDistributor[distributor]) revert UnknownDistributor(distributor);
        HolderFeeDistributor(payable(distributor)).veto(epoch, reason);
    }

    /// @notice Stops new roots and holds every pending one, at once. Roots
    ///         already active keep paying.
    /// @dev AND IT CANCELS AN UNFREEZE ALREADY ANNOUNCED. Otherwise a freeze
    ///      on a factory that was frozen and had its unfreeze announced
    ///      changed nothing: the old announcement still ripened on time, and
    ///      the 48 hours a vetoer's freeze is meant to buy shrank to whatever
    ///      was left of it - down to the plain veto hour, with only the owner's
    ///      cancelPending to stop it. Clearing it only stops things, like
    ///      everything else in this section, so it takes effect at once; the
    ///      owner must announce again and wait ROLE_DELAY from now.
    function freeze() external {
        if (msg.sender != owner() && !isVetoer[msg.sender]) revert NotAVetoer(msg.sender);
        frozen = true;
        emit Frozen(msg.sender);
        if (pendingUnfreezeAt != 0) {
            pendingUnfreezeAt = 0;
            emit UnfreezeCancelled(msg.sender);
        }
    }

    /// @notice Removes the publisher at once, and any announced successor.
    function revokePublisher() external onlyOwner {
        emit PublisherRevoked(publisher);
        publisher = address(0);
        pendingPublisher = address(0);
        pendingPublisherAt = 0;
    }

    /// @notice Makes `account` a vetoer at once, and cancels any announced
    ///         removal of it.
    function addVetoer(address account) external onlyOwner {
        _setVetoer(account, true);
        vetoerRemovalAt[account] = 0;
    }

    function _setVetoer(address account, bool on) private {
        if (account == address(0)) revert ZeroAddress();
        isVetoer[account] = on;
        emit VetoerSet(account, on);
    }

    // ------------------------------------------------------------------
    // WHAT COULD LET A PAYOUT THROUGH: announced, then ROLE_DELAY, then
    // executable by anyone for ROLE_WINDOW
    // ------------------------------------------------------------------

    function announceVetoerRemoval(address account) external onlyOwner {
        uint64 at = _ripeAt();
        vetoerRemovalAt[account] = at;
        emit VetoerRemovalAnnounced(account, at);
    }

    /// @notice Executes an announced removal. Not while a root relayed here
    ///         is still inside its veto hour: the vetoer keeps that hour.
    function removeVetoer(address account) external {
        _requireRipe(vetoerRemovalAt[account]);
        if (block.timestamp < vetoableUntil) revert RootsStillVetoable(vetoableUntil);
        vetoerRemovalAt[account] = 0;
        _setVetoer(account, false);
    }

    /// @notice Announces the end of a freeze. Only while frozen, so an
    ///         unfreeze can never be armed ahead of the freeze it would undo.
    function announceUnfreeze() external onlyOwner {
        if (!frozen) revert NotFrozen();
        uint64 at = _ripeAt();
        pendingUnfreezeAt = at;
        emit UnfreezeAnnounced(at);
    }

    function unfreeze() external {
        _requireRipe(uint64(pendingUnfreezeAt));
        pendingUnfreezeAt = 0;
        frozen = false;
        emit Unfrozen();
    }

    function announcePublisher(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        uint64 at = _ripeAt();
        pendingPublisher = next;
        pendingPublisherAt = at;
        emit PublisherAnnounced(next, at);
    }

    /// @notice Not while frozen: a freeze holds a rotation as it holds roots.
    function executePublisher() external {
        _requireRipe(pendingPublisherAt);
        if (frozen) revert PublishingFrozen();
        emit PublisherUpdated(publisher, pendingPublisher);
        publisher = pendingPublisher;
        pendingPublisher = address(0);
        pendingPublisherAt = 0;
    }

    function announceKeeperPayee(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        uint64 at = _ripeAt();
        pendingKeeperPayee = next;
        pendingKeeperPayeeAt = at;
        emit KeeperPayeeAnnounced(next, at);
    }

    function executeKeeperPayee() external {
        _requireRipe(pendingKeeperPayeeAt);
        emit KeeperPayeeUpdated(keeperPayee, pendingKeeperPayee);
        keeperPayee = pendingKeeperPayee;
        pendingKeeperPayee = address(0);
        pendingKeeperPayeeAt = 0;
    }

    /// Cancels the announced publisher, keeper payee and unfreeze. (A vetoer's
    /// announced removal is cancelled by adding it again.)
    function cancelPending() external onlyOwner {
        pendingPublisher = address(0);
        pendingPublisherAt = 0;
        pendingKeeperPayee = address(0);
        pendingKeeperPayeeAt = 0;
        pendingUnfreezeAt = 0;
        emit PendingCancelled();
    }

    /// When a change announced now may be executed.
    function _ripeAt() private view returns (uint64) {
        return uint64(block.timestamp) + ROLE_DELAY;
    }

    function _requireRipe(uint64 at) private view {
        if (at == 0) revert NothingAnnounced();
        if (block.timestamp < at) revert ChangeNotReady(at);
        if (block.timestamp > at + ROLE_WINDOW) revert ChangeExpired(at + ROLE_WINDOW);
    }

    /// Without an owner nobody could unfreeze publishing or rotate a role, so
    /// ownership can only be handed over (two-step), never dropped.
    function renounceOwnership() public view override onlyOwner {
        revert OwnershipCannotBeRenounced();
    }
}
