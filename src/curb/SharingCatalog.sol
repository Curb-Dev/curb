// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {ISharingCatalog} from "./sharing/ICurbSharing.sol";

/**
 * @title SharingCatalog
 * @notice The list of holder-distributor factory versions a launch may switch
 *         its creator income to.
 *
 * WHAT IT DECIDES, AND WHAT IT CANNOT TOUCH
 *   The Graduator asks this contract one question, isApproved(factory), and
 *   only inside the call that switches a launch's holder sharing on. So:
 *     - it never affects a launch that has already switched. The distributor
 *       is written into the Graduator once and never cleared, and nothing here
 *       is read again for that launch;
 *     - retiring a version stops NEW switches to it, at once, and nothing else;
 *     - the creator names the factory explicitly when switching, so a version
 *       admitted later cannot be slipped under a creator who read another.
 *   It holds no funds and calls nothing.
 *
 * ADMISSION IS SLOW, RETIREMENT IS FAST
 *   A new version is proposed by the owner and becomes usable ADMISSION_DELAY
 *   later, in public, so anyone can read its code before a launch can be bound
 *   to it. Retirement is immediate and permanent, because its only effect is
 *   to refuse.
 *
 * THE BOOTSTRAP, AND WHY IT EXPIRES
 *   The deploy order is catalog, Graduator, hook, distributor factory: the
 *   distributor factory is built on the Graduator, which is built on this.
 *   So the first version cannot exist when this contract is deployed, and a
 *   seven-day wait for it would hold up the whole deployment. admitInitial lets
 *   the deployer admit exactly one factory, once, within BOOTSTRAP_PERIOD of
 *   deployment. After that window, or after the one use, every admission goes
 *   through propose and the delay. Nobody keeps an instant-admit power.
 */
contract SharingCatalog is Ownable2Step, ISharingCatalog {
    /// How long a proposed version waits before a launch can switch to it.
    uint64 public constant ADMISSION_DELAY = 7 days;
    /// How long after deployment the bootstrapper may admit the first version.
    uint64 public constant BOOTSTRAP_PERIOD = 1 days;

    /// admitInitial is refused from this moment on.
    uint64 public immutable bootstrapUntil;
    /// The one address that may call admitInitial: the deployer.
    address public immutable bootstrapper;

    /// When a factory became, or becomes, usable. Zero: never proposed (or
    /// proposed and cancelled).
    mapping(address factory => uint64 at) public admittedAt;
    /// Retired versions. Permanent.
    mapping(address factory => bool) public retired;
    /// The version an interface should offer by default. Zero: none.
    address public recommended;
    /// Whether admitInitial has been used.
    bool public bootstrapped;

    event FactoryAdmitted(address indexed factory, uint64 at);
    event FactoryProposed(address indexed factory, uint64 at);
    event FactoryCancelled(address indexed factory);
    event FactoryRetired(address indexed factory);
    event RecommendedSet(address indexed factory);

    error ZeroAddress();
    error NotTheBootstrapper();
    error AlreadyBootstrapped();
    error BootstrapExpired();
    error NotAContract();
    error AlreadyProposed(address factory);
    error NotPending(address factory);
    error UnknownOrRetired(address factory);
    error FactoryNotApproved(address factory);

    constructor(address owner_, address bootstrapper_) Ownable(owner_) {
        if (bootstrapper_ == address(0)) revert ZeroAddress();
        bootstrapper = bootstrapper_;
        bootstrapUntil = uint64(block.timestamp) + BOOTSTRAP_PERIOD;
    }

    /// @notice Admits the first factory version at once. The bootstrapper only,
    ///         once, before bootstrapUntil.
    function admitInitial(address factory) external {
        if (msg.sender != bootstrapper) revert NotTheBootstrapper();
        if (bootstrapped) revert AlreadyBootstrapped();
        if (block.timestamp >= bootstrapUntil) revert BootstrapExpired();
        if (factory.code.length == 0) revert NotAContract();
        bootstrapped = true;
        admittedAt[factory] = uint64(block.timestamp);
        recommended = factory;
        emit FactoryAdmitted(factory, uint64(block.timestamp));
        emit RecommendedSet(factory);
    }

    /// @notice Proposes a factory version. A launch can switch to it from
    ///         ADMISSION_DELAY from now.
    function propose(address factory) external onlyOwner {
        if (factory.code.length == 0) revert NotAContract();
        if (admittedAt[factory] != 0 || retired[factory]) revert AlreadyProposed(factory);
        uint64 at = uint64(block.timestamp) + ADMISSION_DELAY;
        admittedAt[factory] = at;
        emit FactoryProposed(factory, at);
    }

    /// @notice Withdraws a proposal before it takes effect.
    function cancel(address factory) external onlyOwner {
        // Zero (never proposed) is in the past too, so one comparison covers it.
        if (admittedAt[factory] <= block.timestamp) revert NotPending(factory);
        admittedAt[factory] = 0;
        emit FactoryCancelled(factory);
    }

    /// @notice Stops new launches from switching to `factory`, at once and for
    ///         good. Launches already bound to it are not affected.
    function retire(address factory) external onlyOwner {
        if (admittedAt[factory] == 0 || retired[factory]) revert UnknownOrRetired(factory);
        retired[factory] = true;
        if (recommended == factory) {
            recommended = address(0);
            emit RecommendedSet(address(0));
        }
        emit FactoryRetired(factory);
    }

    /// @notice The version an interface offers by default. Must be approved.
    function setRecommended(address factory) external onlyOwner {
        if (!isApproved(factory)) revert FactoryNotApproved(factory);
        recommended = factory;
        emit RecommendedSet(factory);
    }

    /// @notice Whether a launch may switch to `factory` now: admitted, its
    ///         delay over, and not retired.
    function isApproved(address factory) public view returns (bool) {
        uint64 at = admittedAt[factory];
        return at != 0 && at <= block.timestamp && !retired[factory];
    }
}
