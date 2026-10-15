// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {LaunchRegistry} from "./LaunchRegistry.sol";
import {IWETH} from "./IWETH.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev The one thing the hook asks an admitted launcher: which escrow its
///      curves pay through. Declared narrowly, like the factory's own view of
///      the hook, so the hook depends on nothing else a launcher happens to have.
interface ILauncherEscrow {
    function feeEscrow() external view returns (address);
}

/// @dev The poolOpener's (the Graduator's) one-way holder-sharing switch.
interface IHolderSharingSwitch {
    function holderDistributorOf(address launchToken) external view returns (address);
}

/**
 * @notice The graduated pool's half of the fee policy.
 *
 * ONE TAX, THE SAME ON BOTH SIDES OF GRADUATION.
 *   A launch charges ONE tax on every buy and every sell, between 1% and 5%,
 *   chosen by its creator when the launch is created and never changeable
 *   afterwards. Of that tax the platform takes a share of the base - 50 bps
 *   at deployment - and the creator takes the rest.
 *
 *   THAT SHARE IS FROZEN, NOT FIXED, and the difference is worth the word. The
 *   owner may announce a change, and it lands after POLICY_CHANGE_DELAY under
 *   the ceiling maxPlatformFeeBps() sets. What no announcement can do is move
 *   it under something that already exists: a launch carries the value in
 *   force when it was CREATED - written into its registry record - and both
 *   its curve and, after graduation, its pool charge that copy.
 *
 *   The curve already charges exactly this; this
 *   hook is what makes the pool charge it too, so a trader's cost does not
 *   change shape the moment a launch graduates.
 *
 * WHICH TOKEN, AND WHY IT IS NOT SIMPLY "THE OUTPUT"
 *   The base is the NVDAc side, both directions. The old hook charged the
 *   OUTPUT of the swap, which on a buy is the memecoin - so half the revenue
 *   arrived in a different illiquid token per launch, and the two directions
 *   were not charged on comparable amounts.
 *
 *     BUY   NVDAc -> MEME   NVDAc is the INPUT.  Charged in beforeSwap, on the
 *                           trader's WHOLE NVDAc input. What reaches the pool -
 *                           and therefore what the LP fee and the price apply
 *                           to - is the input MINUS the tax.
 *     SELL  MEME -> NVDAc   NVDAc is the OUTPUT. Charged in afterSwap, on the
 *                           GROSS NVDAc the swap produced.
 *
 *   The buy side is why this hook needs permissions the old one did not have.
 *   afterSwap can only return a delta on the UNSPECIFIED currency, and for an
 *   exact-input swap that is the output - it cannot reach the input at all.
 *   Taking the input needs beforeSwap with a delta on the SPECIFIED currency,
 *   which is BEFORE_SWAP_RETURNS_DELTA. A hook's address encodes its
 *   permissions, so that is a different address and a different deployment.
 *
 * ROUNDING, STATED RATHER THAN LEFT TO THE READER
 *   Each leg is an independent floor of the base:
 *
 *       platform = base * P         / 10000    rounded DOWN
 *       creator  = base * (T - P)   / 10000    rounded DOWN
 *
 *   where P is the launch's own platformBps (50 at deployment) and T its tax.
 *
 *   Never a split of a combined total. That is not a stylistic choice: if the
 *   total were computed first and then divided, the platform's share would
 *   move with T by a wei or two at a time, and "the platform takes the same
 *   amount whatever the creator chose" would be false in exactly the cases
 *   nobody checks. Independent floors make it true at every T, and the trader
 *   keeps both remainders - the sum can only ever be at or below base * T.
 *
 * THE POOL'S RATE IS WRITTEN ONCE, BY THE GRADUATOR, FROM THE RECORD
 *   configureLaunch() takes a token and a key and reads EVERYTHING ELSE out of
 *   the registry itself. The caller supplies no rate and no recipient, so
 *   there is nothing for a caller to get wrong or to lie about; the only thing
 *   they can do is name a launch, and the hook checks that the key really is
 *   that launch's pool before believing it.
 *
 *   Only the poolOpener - the graduator - may call it. Calling it again with
 *   the same record is a no-op, because the record is write-once and therefore
 *   cannot produce different values; anything else reverts. So the rate a pool
 *   charges is fixed the moment the pool exists, and if graduation reverts
 *   afterwards this storage reverts with it - the launch is then unconfigured
 *   again and the next attempt writes it afresh.
 *
 * IT ALSO DECIDES WHO MAY OPEN THE POOL, AND THAT IS NOT A SIDE JOB
 *   A v4 pool is identified by its key, so anyone can call initialize() on a
 *   key before we do and set the opening price. Refusing to graduate into a
 *   pool at the wrong price stops them CHOOSING our price but not BLOCKING us:
 *   the key is taken, permanently, and every graduation attempt afterwards
 *   fails. There is no way to recover it, because a pool cannot be
 *   re-initialized and the hook is part of the key.
 *
 *   beforeInitialize is the only place this can be prevented rather than
 *   detected, so `poolOpener` is the only address allowed to open a pool
 *   carrying this hook. The attack stops being possible instead of becoming a
 *   permanent block.
 *
 * WHERE A FEE GOES
 *   Straight out of the pool manager to its payee WHERE THAT WORKS. Where it
 *   does not, it is taken into this contract and written down in `owed`, and
 *   the payee takes it with claim():
 *     - ALWAYS on a WETH pool. Paying ether means calling the payee while the
 *       pool manager is unlocked, and no gas bound makes that safe. So on the
 *       product's primary pair BOTH legs accrue here on every swap, and a
 *       creator's ether arrives when they claim it, not when somebody trades.
 *     - on any other pool whose payee the issuer has blocked, for that leg.
 *   A swap that reverts later - for a minimum output or anything else - takes
 *   the take and the `owed` write down with it, so a debt exists only for a
 *   swap that happened.
 *
 *   An earlier version of this paragraph said nothing ever accrued here and
 *   there was no claim step. That was true before the debt model and was the
 *   first thing a reader met for a long time after it stopped being.
 *
 * WHAT THIS HOOK DOES NOT DO
 *
 *   Per-user fees or exemptions are impossible as written: the `sender` this
 *   hook sees is the UniversalRouter, not the trader.
 *
 *   IT DOES NOT TAX LIQUIDITY, SO A RANGE ORDER TRADES ONE SIDE TAX-FREE.
 *   ACCEPTED. The tax is taken from the swapper, in beforeSwap and afterSwap,
 *   and this hook holds no add- or remove-liquidity permission (the registry
 *   refuses a hook that does). A holder who mints a position of launch tokens
 *   alone just above a graduated pool's price has them turned into quote as
 *   buyers - who pay the tax - push the price through the range, then removes
 *   the quote with no swap and no sell tax; quote alone just below the price
 *   buys the same way. That is a v4 property, not a bug here: closing it would
 *   take a liquidity permission and so a new hook address. No money in a pool
 *   is taken by it; what the creator, the holders and the platform miss is
 *   the tax on those fills.
 */
contract FeeHook is IHooks, Ownable2Step {
    using PoolIdLibrary for PoolKey;

    uint256 internal constant BPS = 10_000;

    IPoolManager public immutable poolManager;

    /// @notice Base's wrapped ether, an OP-Stack predeploy at the same address
    ///         on every Base network. See FeeEscrow.WETH for why it is a
    ///         constant.
    address public constant WETH = 0x4200000000000000000000000000000000000006;

    /// @notice What this contract owes a fee recipient, per quote asset.
    ///
    /// @dev A DEBT RATHER THAN A PUSH. Paying during the swap made every trade
    ///      in a pool depend on one address being willing and permitted to
    ///      receive - see AUDIT X-1 and Y-1. A recipient who cannot take
    ///      delivery now loses nothing but the time until they can.
    mapping(address recipient => mapping(address token => uint256 amount)) public owed;

    /// The claim path sends ether and then, if that fails, moves a token. Both
    /// are external calls, and the balance is written down before either - the
    /// guard is the second line of defence, not the first. Same shape as
    /// FeeEscrow, deliberately.
    bool private _claiming;

    /// THIS HOOK IS THE FEE POLICY, which is the shape PONS uses: their
    /// PonsV2MemeHook implements IPonsV2FeePolicy itself. The two values below
    /// are the whole of it, and ONE place holds them: CurbLaunchFactory.launch()
    /// reads them into each new launch's record, and the curve and the pool
    /// both charge that record - never these live values.
    ///
    /// ONE SOURCE IS NOT A TIDINESS POINT. They used to be a shared constant,
    /// which could not drift by construction. Two settable copies could, and
    /// D2's promise is exactly that a trader's cost does not change shape at
    /// graduation - so if they are settable at all, they are settable here.
    ///
    /// WHAT A CHANGE REACHES: LAUNCHES CREATED AFTER IT, AND NOTHING ELSE.
    ///   launch() reads these two once and writes them into the launch's
    ///   registry record; the curve is built from them and configureLaunch
    ///   copies the same record into the pool. So a launch that exists keeps
    ///   its share and its recipient on both sides, for as long as it exists.
    ///
    ///   This block used to say the pool side was live and that PONS's setter
    ///   reached every pool. Both were wrong: PONS stamps the policy into each
    ///   pool at registration (PonsV2MemeHook.sol:371) and pays from that copy.
    address public platformRecipient;
    uint16 public platformFeeBps;

    /// HOW LONG A CHANGE IS VISIBLE BEFORE IT CAN LAND. thestonks.exchange's
    /// number, taken rather than invented: their operator's fee change sits
    /// behind "a 24-hour announced on-chain delay". The point is that anyone
    /// about to launch can see it coming and decide. A trader already in a
    /// graduated pool has nothing to react to: a change never reaches a launch
    /// that exists.
    uint64 public constant POLICY_CHANGE_DELAY = 24 hours;

    /// AND HOW LONG IT STAYS EXECUTABLE. Ours, not theirs - see _requireRipe.
    uint64 public constant POLICY_CHANGE_WINDOW = 7 days;

    /// THE SHARE OF ITS OWN TAX A LAUNCH ALWAYS KEEPS, in bps. Their rule:
    /// "hard caps that always leave the creator at least 20%".
    uint16 public constant CREATOR_MIN_SHARE_BPS = 2_000;

    /// The announced-but-not-yet-applied change, readable by anybody who wants
    /// to know what is coming. readyAt == 0 means nothing is pending.
    address public pendingRecipient;
    uint64 public pendingRecipientReadyAt;
    uint16 public pendingFeeBps;
    uint64 public pendingFeeReadyAt;
    LaunchRegistry public immutable registry;
    /// The only address that may initialize a pool carrying this hook, and the
    /// only one that may configure a launch on it.
    address public immutable poolOpener;

    struct LaunchFee {
        /// The launch's whole tax, in bps of the NVDAc base. The platform's
        /// leg comes out of it; the creator's is the remainder.
        uint16 totalTaxBps;
        /// Which side of the pair is NVDAc. Stored rather than re-derived so a
        /// swap never has to ask the registry anything.
        bool quoteIsCurrency0;
        /// The record's beneficiary. The same address the LP position locks
        /// for, because they are the same person by definition - until the
        /// launch's holder sharing is switched on, when syncCreator moves this
        /// leg, once and for good, to the launch's distributor.
        address creator;
        bool configured;
        /// WHERE THE PLATFORM'S LEG GOES, FROZEN WHEN THE LAUNCH WAS CREATED.
        ///
        /// Copied from the launch's registry record at configureLaunch, and
        /// that record was written by launch() from the hook's values at that
        /// moment. So a change announced between a launch's creation and its
        /// graduation does NOT reach its pool. PONS stamps per pool at
        /// registration for the same reason; one hook serves every pool here,
        /// so the copy is per record.
        ///
        /// platform AND platformBps ARE LAST ON PURPOSE, and appended to taxOfId's list for
        /// the same reason: the page decodes by position, so anything new goes
        /// after what is already being read. feeOf/feeOfId return the struct
        /// itself; taxOfId is the flat one and has to be kept in step by hand.
        address platform;
        /// AND HOW MUCH THAT LEG IS, frozen with it. PONS stamps the share
        /// alongside the recipient and reads both back from the record; a
        /// freeze on one and not the other would be half of that design.
        uint16 platformBps;
        /// WHETHER `creator` IS NOW THE LAUNCH'S HOLDER DISTRIBUTOR. Set once,
        /// by syncCreator, never cleared. Last for the same positional reason
        /// as the two fields above; it packs into their slot, which a swap
        /// reads anyway, so it costs a swap nothing.
        bool holderShared;
    }

    mapping(PoolId poolId => LaunchFee) internal _fees;

    /// Per TOKEN: every quote asset the deployment enables (eleven today)
    /// shares this hook, and a single counter would add different assets.
    mapping(address token => uint256 amount) public collected;

    event LaunchConfigured(PoolId indexed poolId, address indexed launchToken, uint16 totalTaxBps, address creator);
    /// The pool's creator leg now pays the launch's holder distributor.
    event CreatorRedirected(PoolId indexed poolId, address indexed launchToken, address previous, address distributor);
    /// A WETH debt claimed as ether. Emitted by claim(), beside FeeClaimed,
    /// once per claim - never during a swap.
    event PaidAsNative(address indexed to, uint256 amount);
    /// A WETH debt whose claimant refused ether, paid as WETH instead. Emitted
    /// by claim(), beside FeeClaimed, for the whole amount claimed - not per
    /// leg, and never during a swap.
    event PaidAsWrapped(address indexed to, uint256 amount);
    /// A fee leg the pool could not deliver in the swap, recorded as a debt.
    event FeeAccrued(address indexed to, address indexed token, uint256 amount);
    /// A fee leg that went straight out, which is the ordinary case for every
    /// asset except WETH.
    event FeePaidDirect(address indexed to, address indexed token, uint256 amount);
    /// A debt settled by its owner.
    event FeeClaimed(address indexed to, address indexed token, uint256 amount);

    event FeeCharged(
        PoolId indexed poolId, address indexed quoteToken, uint256 base, uint256 platformAmount, uint256 creatorAmount
    );

    /// ANNOUNCED AND APPLIED ARE SEPARATE EVENTS, because the announcement is
    /// the thing with news in it. An indexer watching only the *Updated events
    /// would see a change land with no warning, which is the property the delay
    /// exists to remove.
    event PlatformRecipientAnnounced(address indexed previous, address indexed next, uint64 readyAt);
    event PlatformFeeBpsAnnounced(uint16 previous, uint16 next, uint64 readyAt);
    /// ONE EVENT PER KIND, WITH WHAT WAS WITHDRAWN. They shared a bare
    /// PlatformChangeCancelled(), so with both kinds pending a reader could not
    /// tell which one was still coming.
    event PlatformRecipientCancelled(address pending);
    event PlatformFeeBpsCancelled(uint16 pending);
    event PlatformRecipientUpdated(address indexed previous, address indexed next);
    event PlatformFeeBpsUpdated(uint16 previous, uint16 next);

    error NotPoolManager();
    /// A constructor argument that is permanent must not be permanently zero.
    error ZeroAddress();
    /// The platform's cut would leave a launch's creator under their floor.
    error PlatformFeeAboveCap(uint16 bps, uint16 cap);
    /// Executing or cancelling something nobody announced.
    error NothingAnnounced();
    /// The announced delay has not run yet.
    error ChangeNotReady(uint64 readyAt, uint64 nowAt);
    /// The announcement went stale. Announce it again, in the open.
    error ChangeExpired(uint64 expiredAt, uint64 nowAt);
    error HookNotImplemented();
    error ExactOutputNotSupported();
    error NotThePoolOpener(address sender);
    error PoolNotConfigured(PoolId poolId);
    error AlreadyConfiguredDifferently(PoolId poolId);
    error RecipientIsTheHook();
    /// NOT NAMED PlatformRecipientIsInfrastructure, WHICH IS THE FACTORY'S. Two
    /// errors with the same name and argument types share a selector, and a
    /// test asserting one would be satisfied by the other.
    error RecipientIsDeploymentContract(address recipient);
    error InexactTransfer(address token, uint256 expected, uint256 received);
    error KeyIsNotThisLaunchsPool(address launchToken);
    error PartialFillNotSupported(uint256 offered, uint256 spent);
    error RecordNamesAnotherHook(address hooks);
    /// ETH arrived from something other than unwrapping this hook's own WETH.
    error UnexpectedNative(address from);
    /// Nothing is owed to this caller in this asset.
    error NothingOwed(address who, address token);
    error ClaimReentered();
    /// syncCreator for a launch whose holder sharing is off.
    error NotSharing(address launchToken);
    /// syncCreator for a pool whose creator leg already moved.
    error AlreadyShared(PoolId poolId);

    /// THE THREE IMMUTABLES HERE ARE STILL PERMANENT, SO A ZERO IS PERMANENT.
    ///
    /// AUDIT.txt A-5. The registry's wire() proves the loop closes and so
    /// catches a zero poolOpener and a zero registry. It cannot catch the
    /// recipient, which nothing on chain checked at all. That one can be
    /// replaced now, but only by an announcement that lands after
    /// POLICY_CHANGE_DELAY. Until then a zero would make every launch() revert
    /// (the curve's constructor and the registry both refuse a zero platform
    /// recipient). No buy would be affected: a buy charges the recipient frozen
    /// into its launch's record, never this live value. (This used to say a
    /// zero would revert every buy until somebody called "the setter". Both
    /// halves described a design this hook no longer has.)
    ///
    /// THE OWNER IS AN ARGUMENT, NOT msg.sender. This hook is deployed at a
    /// MINED address, so its deployer is whatever helper did the mining. Taking
    /// the owner from msg.sender would hand the fee policy to that, quietly.
    constructor(
        IPoolManager poolManager_,
        address platformRecipient_,
        LaunchRegistry registry_,
        address poolOpener_,
        address owner_
    ) Ownable(owner_) {
        if (
            address(poolManager_) == address(0) || platformRecipient_ == address(0)
                || address(registry_) == address(0) || poolOpener_ == address(0)
        ) revert ZeroAddress();
        // AND NOT THIS CONTRACT, for the reason announcePlatformRecipient
        // gives. The address is mined for its permission bits, so it is known
        // before this runs and could be passed here by mistake.
        if (platformRecipient_ == address(this)) revert RecipientIsTheHook();
        // NOR THE OTHER CONTRACTS THIS HOOK IS BUILT ON, for the reason
        // _refuseDeploymentContract gives. The launchers are not asked here:
        // none can be admitted yet, because wire() needs this hook's code to
        // exist before it will fix it as the registry's hook. wire() asks the
        // other way round instead, and refuses a first launcher that is, or
        // whose escrow is, this recipient.
        if (
            platformRecipient_ == address(poolManager_) || platformRecipient_ == address(registry_)
                || platformRecipient_ == poolOpener_
        ) revert RecipientIsDeploymentContract(platformRecipient_);
        poolManager = poolManager_;
        platformRecipient = platformRecipient_;
        registry = registry_;
        // The registry's constant is the STARTING value now rather than a
        // binding one. It is still the one place the number is first written.
        platformFeeBps = registry_.PLATFORM_FEE_BPS();
        poolOpener = poolOpener_;
    }

    // ------------------------------------------------------------------
    // CHANGING THE POLICY: ANNOUNCE, WAIT, EXECUTE
    //
    // THIS IS THESTONKS.EXCHANGE'S SHAPE, not PONS's, and the choice was
    // deliberate. PONS lets its owner move the fee policy in one transaction -
    // nine such functions on their hook, seventeen on their factory. The
    // reference that runs on OUR chain, against the same tokenized equities,
    // is tighter: its operator may "change the fee split within hard caps that
    // always leave the creator at least 20%", and "each behind a 24-hour
    // announced on-chain delay".
    //
    // WHAT THE DELAY BUYS, and it is not ceremony: a creator deciding whether
    // to launch here can SEE a change coming and decide before it lands. It
    // reaches only launches created afterwards, so nobody already trading is
    // affected at all. An immediate setter gives a creator the news and the
    // consequence in the same block.
    //
    // WHAT THE CAP BUYS: the floor is not "the owner cannot break the
    // contract", it is "the creator keeps most of their own tax". Those are
    // very different promises and only the second is worth making.
    // ------------------------------------------------------------------

    /// @notice Announces a new recipient. Executable after POLICY_CHANGE_DELAY.
    function announcePlatformRecipient(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        // THE HOOK CANNOT BE ITS OWN PAYEE. _deliver would take the fee here
        // and credit owed[address(this)], and claim() pays msg.sender - so the
        // hook would have to call itself to ever hand it over, which nothing
        // does. The money would be counted, owed, and unreachable.
        //
        // IT IS CHECKED AT THE ANNOUNCEMENT rather than at the payment: from
        // here it is stamped into every launch CREATED afterwards, so one
        // wrong announcement would reach all of them.
        if (next == address(this)) revert RecipientIsTheHook();
        _refuseDeploymentContract(next);
        pendingRecipient = next;
        pendingRecipientReadyAt = uint64(block.timestamp) + POLICY_CHANGE_DELAY;
        emit PlatformRecipientAnnounced(platformRecipient, next, pendingRecipientReadyAt);
    }

    /// NONE OF THIS DEPLOYMENT'S OWN CONTRACTS CAN BE THE PLATFORM'S PAYEE.
    ///
    /// WHY HERE. This is the single choke point: whatever is announced and
    /// executed is stamped into every launch created afterwards, on every
    /// asset's factory at once, and a launch's record can never be edited. Each
    /// factory also checks at launch, but a factory knows only its own escrow,
    /// so an announced escrow of asset B passed factory A's check and went into
    /// every launch A created from then on.
    ///
    /// WHICH ADDRESSES, AND WHY THESE. Every one the hook can reach from what
    /// it holds, where a platform leg could arrive and never be claimed:
    ///   the PoolManager  a take to it is a transfer to itself: the tokens
    ///                    stay in the manager and nobody is owed them
    ///   the registry     no code path in it can claim, or move a token
    ///   the poolOpener   the graduator. That covers EVERY launcher's
    ///                    graduator, not only the first one's: the registry
    ///                    admits a launcher only when this hook's poolOpener
    ///                    IS its graduator, so asking each one again would be
    ///                    a check that can never fire
    ///   its PositionManager  asked of the poolOpener. Tokens taken to it are
    ///                    anybody's through its SWEEP action
    ///   each launcher    the factory, which cannot claim either
    ///   and its escrow   the escrow refuses to credit itself, so every sweep
    ///                    of a curve paying it would revert, and graduate()
    ///                    sweeps first
    /// The hook itself is refused by its own error, before this runs. The
    /// escrows are asked of the registry's launchers because the hook holds no
    /// list of its own, and DeployCurb gives each asset its own escrow.
    ///
    /// WHAT IT CANNOT SEE: a launcher admitted AFTER the recipient landed. The
    /// registry covers that order: it refuses to admit a launcher that is, or
    /// whose escrow is, the live recipient.
    ///
    /// EVERY QUESTION TO ANOTHER CONTRACT HERE IS BOUNDED - see _names. The
    /// registry refuses a launcher that will not name its escrow, so an
    /// unbounded read used to be safe only as long as every admitted launcher
    /// stayed polite: one that burned its gas or answered with a megabyte would
    /// have reverted every announcement and execution for good, since nothing
    /// is ever removed from that list. A launcher that does not answer is now
    /// skipped, not obeyed.
    function _refuseDeploymentContract(address next) private view {
        if (
            next == address(poolManager) || next == address(registry) || next == poolOpener
                || _names(poolOpener, POSITION_MANAGER_SELECTOR, next)
        ) {
            revert RecipientIsDeploymentContract(next);
        }
        uint256 n = registry.launcherCount();
        for (uint256 i = 0; i < n; i++) {
            address launcher = registry.launcherAt(i);
            if (next == launcher || _names(launcher, ILauncherEscrow.feeEscrow.selector, next)) {
                revert RecipientIsDeploymentContract(next);
            }
        }
    }

    /// positionManager(), which the poolOpener (the Graduator) answers.
    bytes4 private constant POSITION_MANAGER_SELECTOR = 0x791b98bc;

    /// Whether `target` answers the no-argument call `sel` with exactly
    /// `who`, as a whole word. At most 20,000 gas for the call and one word of
    /// the reply copied, so no contract on the other end can make the question
    /// cost more than that. Anything else - a revert, a short or long reply, a
    /// word with dirty upper bits - is "no".
    function _names(address target, bytes4 sel, address who) private view returns (bool hit) {
        assembly ("memory-safe") {
            mstore(0, sel)
            let ok := staticcall(20000, target, 0, 4, 0, 32)
            hit := and(and(ok, eq(returndatasize(), 32)), eq(mload(0), who))
        }
    }

    /// @notice Applies an announced recipient, once its delay has passed.
    function executePlatformRecipient() external onlyOwner {
        uint64 readyAt = pendingRecipientReadyAt;
        _requireRipe(readyAt);
        // ASKED AGAIN WHEN IT LANDS, not only when it was announced. A launcher
        // admitted during the delay can bring an escrow at the very address
        // that was announced, and this is the moment the recipient starts
        // being stamped into new launches.
        _refuseDeploymentContract(pendingRecipient);
        emit PlatformRecipientUpdated(platformRecipient, pendingRecipient);
        platformRecipient = pendingRecipient;
        pendingRecipient = address(0);
        pendingRecipientReadyAt = 0;
    }

    /// @notice Abandons an announced recipient change.
    function cancelPlatformRecipient() external onlyOwner {
        if (pendingRecipientReadyAt == 0) revert NothingAnnounced();
        emit PlatformRecipientCancelled(pendingRecipient);
        pendingRecipient = address(0);
        pendingRecipientReadyAt = 0;
    }

    /// AN ANNOUNCEMENT GOES STALE, AND THAT PART IS OURS RATHER THAN THEIRS.
    ///
    /// Their page describes the delay and not a window. Without one, an
    /// announcement made today can be executed in six months, by which time
    /// nobody is watching and the delay has bought nothing - the information it
    /// was supposed to give people has expired but the power has not. So a
    /// change must be applied inside POLICY_CHANGE_WINDOW or announced again.
    function _requireRipe(uint64 readyAt) private view {
        if (readyAt == 0) revert NothingAnnounced();
        if (block.timestamp < readyAt) revert ChangeNotReady(readyAt, uint64(block.timestamp));
        if (block.timestamp > readyAt + POLICY_CHANGE_WINDOW) {
            revert ChangeExpired(readyAt + POLICY_CHANGE_WINDOW, uint64(block.timestamp));
        }
    }

    /// RENOUNCING IS DELIBERATELY LEFT WORKING, WHICH IS WHERE WE DIVERGE FROM
    /// PONS ON PURPOSE.
    ///
    /// PonsV2MemeHook overrides renounceOwnership to revert, and gives its
    /// reason: "An ownerless hook could never rotate the fee sweep operator, so
    /// accrued fees on every graduated pool would stay stranded." That reason
    /// does not hold here. Our feeSweepOperator is a constant address(0) and is
    /// never rotated, and the curve lets the creator sweep their own launch
    /// whenever no buyback is involved - which is always, because buyback is off
    /// by construction. An ownerless hook strands nothing of ours.
    ///
    /// SO RENOUNCING IS A CLEAN EXIT RATHER THAN A HAZARD. It freezes both
    /// values where they stand, for ever, and the product returns to exactly
    /// the immutable arrangement it had before these setters existed. That is
    /// what makes this the one reversible decision at deployment: the key can
    /// be transferred, and it can also be given up entirely.
    ///
    /// Copying PONS's override would have removed that, for a reason that is
    /// theirs and not ours.

    /// @notice The most the platform's cut may ever be set to.
    ///
    /// THESTONKS' RULE, APPLIED TO OUR ARITHMETIC. Theirs is "hard caps that
    /// always leave the creator at least 20%". Our creator keeps
    /// totalTaxBps - platformFeeBps out of totalTaxBps, so leaving them a fifth
    /// means the platform takes at most four fifths - and the binding case is
    /// the SMALLEST tax a launch may choose, because a cap that only held at
    /// 5% would not protect the launch that picked 1%.
    ///
    /// At MIN_TOTAL_TAX_BPS = 100 that is 80 bps. The deployed value is 50, so
    /// this owner can go from 0.5% to at most 0.8% and a 1% launch always keeps
    /// at least 0.2%.
    ///
    /// IT REPLACES A WEAKER BOUND THAT WAS ALSO MINE. The first version capped
    /// at MIN_TOTAL_TAX_BPS itself - the point where the creator's leg
    /// underflows and every swap on their pool reverts. That is the line
    /// between working and broken, not between fair and unfair, and only the
    /// second is worth a promise.
    function maxPlatformFeeBps() public view returns (uint16) {
        return uint16((uint256(registry.MIN_TOTAL_TAX_BPS()) * (BPS - CREATOR_MIN_SHARE_BPS)) / BPS);
    }

    /// @notice Announces a new platform cut. Executable after the delay.
    function announcePlatformFeeBps(uint16 next) external onlyOwner {
        uint16 ceiling = maxPlatformFeeBps();
        if (next > ceiling) revert PlatformFeeAboveCap(next, ceiling);
        pendingFeeBps = next;
        pendingFeeReadyAt = uint64(block.timestamp) + POLICY_CHANGE_DELAY;
        emit PlatformFeeBpsAnnounced(platformFeeBps, next, pendingFeeReadyAt);
    }

    /// @notice Applies an announced cut, once its delay has passed.
    /// @dev The cap is checked at announcement and not again here: it is
    ///      derived from a constant, so it cannot have moved in between, and
    ///      re-checking would only hide that if it ever stopped being one.
    function executePlatformFeeBps() external onlyOwner {
        _requireRipe(pendingFeeReadyAt);
        emit PlatformFeeBpsUpdated(platformFeeBps, pendingFeeBps);
        platformFeeBps = pendingFeeBps;
        pendingFeeBps = 0;
        pendingFeeReadyAt = 0;
    }

    /// @notice Abandons an announced cut.
    function cancelPlatformFeeBps() external onlyOwner {
        if (pendingFeeReadyAt == 0) revert NothingAnnounced();
        emit PlatformFeeBpsCancelled(pendingFeeBps);
        pendingFeeBps = 0;
        pendingFeeReadyAt = 0;
    }

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    function feeOf(PoolKey calldata key) external view returns (LaunchFee memory) {
        return _fees[key.toId()];
    }

    function feeOfId(PoolId poolId) external view returns (LaunchFee memory) {
        return _fees[poolId];
    }

    /// @notice The same thing as flat words.
    /// @dev For readers that decode by hand rather than through an ABI
    ///      library - the page does - where a struct return is offset
    ///      arithmetic and this is one word per field.
    ///
    ///      THE TWO POLICY FIELDS ARE APPENDED, not inserted, so a reader that
    ///      only wants the first four still finds them where they were. The
    ///      struct grew once without this growing with it and the page asked
    ///      for a word that was not there.
    function taxOfId(PoolId poolId)
        external
        view
        returns (
            uint16 totalTaxBps,
            bool quoteIsCurrency0,
            address creator,
            bool configured,
            address platform,
            uint16 platformBps
        )
    {
        LaunchFee memory f = _fees[poolId];
        return (f.totalTaxBps, f.quoteIsCurrency0, f.creator, f.configured, f.platform, f.platformBps);
    }

    /// @notice Binds a pool to its launch's tax and creator, from the registry.
    /// @dev The graduator calls this in the same transaction that opens the
    ///      pool. Everything charged afterwards comes from what is written
    ///      here, and what is written here comes from the write-once record -
    ///      not from the caller.
    function configureLaunch(address launchToken, PoolKey calldata key) external {
        if (msg.sender != poolOpener) revert NotThePoolOpener(msg.sender);

        LaunchRegistry.Launch memory rec = registry.launchOf(launchToken);
        if (address(rec.hooks) != address(this)) revert RecordNamesAnotherHook(address(rec.hooks));

        // THE KEY HAS TO BE THIS LAUNCH'S POOL, not merely a pool. Without
        // this a caller could name a real launch and hand over some other
        // key, and that other pool would inherit this launch's tax.
        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        bool quoteIsCurrency0 = c0 == rec.quoteToken;
        bool wellFormed = address(key.hooks) == address(this) && key.fee == rec.fee
            && key.tickSpacing == rec.tickSpacing
            && ((quoteIsCurrency0 && c1 == launchToken) || (c1 == rec.quoteToken && c0 == launchToken));
        if (!wellFormed) revert KeyIsNotThisLaunchsPool(launchToken);

        PoolId id = key.toId();
        LaunchFee storage existing = _fees[id];
        if (existing.configured) {
            // WRITE-ONCE IN SUBSTANCE. The record cannot change, so a second
            // call for the same launch can only ever carry the same values -
            // which makes this a no-op rather than a rewrite, and leaves the
            // graduator's "a pool already open at our price" path working.
            // Anything else is a different launch reaching for this pool.
            //
            // THE PLATFORM FIELDS ARE COMPARED TOO. Both sides come from the
            // same write-once record, so they cannot drift. (This used to leave
            // them out on the grounds that the stamp and the hook's current
            // value drift apart - true of the old design, which read the hook
            // here; not of this one, which copies the record.)
            //
            // A CREATOR LEG THAT MOVED TO THE LAUNCH'S HOLDER DISTRIBUTOR IS
            // STILL THE SAME LAUNCH: compared with the poolOpener's switch,
            // which is write-once, rather than with the record. (Only
            // syncCreator ever writes anything but the beneficiary here, and it
            // sets holderShared in the same breath, so the flag needs no
            // separate check.)
            bool sameCreator = existing.creator == rec.beneficiary
                || existing.creator == IHolderSharingSwitch(poolOpener).holderDistributorOf(launchToken);
            if (
                existing.totalTaxBps != rec.totalTaxBps || !sameCreator
                    || existing.quoteIsCurrency0 != quoteIsCurrency0 || existing.platform != rec.platformRecipient
                    || existing.platformBps != rec.platformBps
            ) revert AlreadyConfiguredDifferently(id);
            return;
        }

        _fees[id] = LaunchFee({
            totalTaxBps: rec.totalTaxBps,
            quoteIsCurrency0: quoteIsCurrency0,
            creator: rec.beneficiary,
            configured: true,
            // THE LAUNCH'S OWN, NOT THIS HOOK'S CURRENT ONES. The record was
            // written when the launch was created and the curve was built from
            // the same two values; reading them again here would give a pool a
            // different split from the curve it graduated out of.
            platform: rec.platformRecipient,
            platformBps: rec.platformBps,
            holderShared: false
        });
        emit LaunchConfigured(id, launchToken, rec.totalTaxBps, rec.beneficiary);
    }

    /// @notice Moves this launch's pool creator leg to its holder distributor,
    ///         once, for good. The poolOpener (the Graduator) only, from its
    ///         own switch or from graduate().
    /// @dev CHOOSES NOTHING. The pool is rebuilt from the registry record, not
    ///      taken from the caller, and the distributor is read from the
    ///      poolOpener's write-once switch - so this can only ever move a
    ///      configured pool's leg from the beneficiary to that one address.
    ///      Debts already booked in `owed` stay with whoever earned them.
    ///      Nothing on the swap path changes: a swap reads `creator` exactly
    ///      as before.
    function syncCreator(address launchToken) external {
        if (msg.sender != poolOpener) revert NotThePoolOpener(msg.sender);
        LaunchRegistry.Launch memory rec = registry.launchOf(launchToken);
        bool launchIsCurrency0 = launchToken < rec.quoteToken;
        PoolId id = PoolKey({
            currency0: Currency.wrap(launchIsCurrency0 ? launchToken : rec.quoteToken),
            currency1: Currency.wrap(launchIsCurrency0 ? rec.quoteToken : launchToken),
            fee: rec.fee,
            tickSpacing: rec.tickSpacing,
            hooks: rec.hooks
        }).toId();
        LaunchFee storage f = _fees[id];
        if (!f.configured) revert PoolNotConfigured(id);
        address d = IHolderSharingSwitch(poolOpener).holderDistributorOf(launchToken);
        if (d == address(0)) revert NotSharing(launchToken);
        if (f.holderShared) revert AlreadyShared(id);
        // The two payees _deliver could never hand over: this hook would owe
        // itself, and a take to the PoolManager is a transfer to itself.
        if (d == address(this)) revert RecipientIsTheHook();
        if (d == address(poolManager)) revert RecipientIsDeploymentContract(d);
        emit CreatorRedirected(id, launchToken, f.creator, d);
        f.creator = d;
        f.holderShared = true;
    }

    /// `sender` is whoever called PoolManager.initialize - the graduator when
    /// we open the pool, and the attacker when they try to take the key first.
    function beforeInitialize(address sender, PoolKey calldata, uint160)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
        if (sender != poolOpener) revert NotThePoolOpener(sender);
        return IHooks.beforeInitialize.selector;
    }

    /// THE BUY SIDE. NVDAc is the input, so the fee is taken here, before the
    /// swap prices anything - which is what makes the trader's whole input the
    /// base and the post-tax amount what the pool actually trades.
    function beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        // ENFORCED, not assumed. This fee is defined on the NVDAc side, and on
        // an exact-OUTPUT swap the specified currency is the output - so the
        // same arithmetic would charge the wrong side. Our own interface only
        // sends exact-input, but that constrains our interface, not the pool:
        // anyone can swap against it. So refuse rather than mis-charge.
        if (params.amountSpecified > 0) revert ExactOutputNotSupported();

        PoolId id = key.toId();
        LaunchFee memory cfg = _fees[id];
        // FAIL CLOSED. A pool whose launch was never configured must not trade
        // free of charge; it must not trade at all.
        if (!cfg.configured) revert PoolNotConfigured(id);

        // The input is currency0 when zeroForOne. NVDAc being the input is a
        // buy; otherwise the NVDAc arrives on the way out and afterSwap has it.
        bool quoteIsInput = params.zeroForOne == cfg.quoteIsCurrency0;
        if (!quoteIsInput) return (IHooks.beforeSwap.selector, toBeforeSwapDelta(0, 0), 0);

        Currency quote = params.zeroForOne ? key.currency0 : key.currency1;
        uint256 base = uint256(-params.amountSpecified);
        uint256 charged = _pay(id, quote, base, cfg);
        if (charged == 0) return (IHooks.beforeSwap.selector, toBeforeSwapDelta(0, 0), 0);

        // A POSITIVE SPECIFIED DELTA IS THE HOOK TAKING FROM THE INPUT. The
        // pool then swaps what is left, so the price and the LP fee apply to
        // the post-tax amount - which is the policy, not a rounding artefact.
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(int128(uint128(charged)), 0), 0);
    }

    /// THE SELL SIDE. NVDAc is the output, and afterSwap is the first point the
    /// gross amount is known for an exact-input swap.
    function afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, int128)
    {
        // Unreachable through beforeSwap, which refuses it first. Kept because
        // a hook that is correct only because of another of its own entry
        // points is one edit away from not being correct.
        if (params.amountSpecified > 0) revert ExactOutputNotSupported();

        PoolId id = key.toId();
        LaunchFee memory cfg = _fees[id];
        if (!cfg.configured) revert PoolNotConfigured(id);

        bool quoteIsInput = params.zeroForOne == cfg.quoteIsCurrency0;
        if (quoteIsInput) {
            // THE BUY WAS CHARGED IN beforeSwap, ON THE AMOUNT THE TRADER ASKED
            // TO SPEND - and beforeSwap runs before anybody knows whether the
            // pool will take all of it.
            //
            // An exact-input swap can stop early and leave part of the input
            // unspent - at a sqrtPriceLimitX96 the caller supplied, or at the
            // bound of the price range when the pool has no more liquidity to
            // trade against. The trader gets that part back, and a fee charged
            // on it would be a fee on money they never spent.
            //
            // A CUSTOM LIMIT IS NOT THE ONLY WAY IN. Our own interface supplies
            // none, and that does NOT mean a swap through it always fills: a
            // trade large enough to run the price to the range's own bound
            // stops there too, and is refused here like any other partial fill.
            //
            // THIS HOOK DOES NOT SUPPORT PARTIAL FILLS. It reverts the whole
            // transaction rather than charge for what was not spent. The reason
            // it does not instead refund is a property of THIS design, not a
            // law: the fee is taken in beforeSwap, and afterSwap - the first
            // point a partial fill is visible - may only return a delta on the
            // UNSPECIFIED currency, which for an exact-input swap is the
            // output. Handing input back from here would need a different
            // arrangement of where the fee is taken, and that is a redesign
            // rather than a line.
            uint256 requested = uint256(-params.amountSpecified);
            (uint256 platformAmount, uint256 creatorAmount) = _legs(requested, cfg);
            uint256 offered = requested - platformAmount - creatorAmount;
            int128 spentSigned = params.zeroForOne ? delta.amount0() : delta.amount1();
            uint256 spent = spentSigned < 0 ? uint256(uint128(-spentSigned)) : 0;
            if (spent != offered) revert PartialFillNotSupported(offered, spent);
            return (IHooks.afterSwap.selector, 0);
        }

        (Currency quote, int128 out) =
            params.zeroForOne ? (key.currency1, delta.amount1()) : (key.currency0, delta.amount0());
        if (out <= 0) return (IHooks.afterSwap.selector, 0);

        uint256 charged = _pay(id, quote, uint256(uint128(out)), cfg);
        return (IHooks.afterSwap.selector, int128(uint128(charged)));
    }

    /// The two legs, each an independent floor of the base. Pure, and separate
    /// from paying them, because afterSwap has to recompute the buy's legs to
    /// know what beforeSwap handed the pool.
    function _legs(uint256 base, LaunchFee memory cfg)
        private
        view
        returns (uint256 platformAmount, uint256 creatorAmount)
    {
        // THIS POOL'S RATE, NOT THE HOOK'S CURRENT ONE. The subtraction is
        // also why it matters: against a live rate a launch whose whole tax sat
        // near the platform's share would start reverting every swap the day
        // the rate was raised past it.
        platformAmount = (base * cfg.platformBps) / BPS;
        creatorAmount = (base * (cfg.totalTaxBps - cfg.platformBps)) / BPS;
    }

    /// @notice Accepts ETH from WETH alone. See FeeEscrow.receive().
    receive() external payable {
        if (msg.sender != WETH) revert UnexpectedNative(msg.sender);
    }

    /// One leg out of the pool, WITHOUT letting the recipient decide whether
    /// the swap succeeds.
    ///
    /// @dev WETH IS NEVER SENT HERE. Delivering ether means calling the
    ///      recipient, and there is no gas bound that makes that safe inside
    ///      the lock: 30,000 is enough to reach PoolManager.take, whose only
    ///      gate is onlyWhenUnlocked, and one unsettled delta reverts the
    ///      entire swap. AUDIT X-1. So WETH becomes a debt and leaves on
    ///      claim(), where the lock is closed and the guard is real.
    ///
    ///      EVERY OTHER ASSET IS STILL TRIED DIRECTLY. That is what this has
    ///      always done, it is what the pool's own tests describe, and a B20
    ///      token is a precompile with no transfer callback - so the direct
    ///      path hands control to nobody. What it CAN do is refuse: the
    ///      issuer's receiver policy is consulted on every transfer, and a
    ///      blocked creator used to take the whole swap down with it. AUDIT
    ///      Y-1. Now the refusal costs that recipient a delay and nobody else
    ///      anything.
    ///
    ///      THE catch IS NARROW BY CONSTRUCTION, not by inspecting the reason.
    ///      Only the transfer is inside it; a failure anywhere else in this
    ///      function is not caught and still reverts the swap.
    function _deliver(Currency quote, address token, address to, uint256 amount) private {
        if (token == WETH) {
            _takeExact(quote, token, amount);
            owed[to][token] += amount;
            emit FeeAccrued(to, token, amount);
            return;
        }
        try poolManager.take(quote, to, amount) {
            emit FeePaidDirect(to, token, amount);
        } catch {
            _takeExact(quote, token, amount);
            owed[to][token] += amount;
            emit FeeAccrued(to, token, amount);
        }
    }

    /// WHAT ARRIVED, NOT WHAT WAS ASKED FOR.
    ///
    /// @dev PONS's _takeExact, and for the same reason: the line after this one
    ///      credits `owed` with the figure that was REQUESTED, so a token that
    ///      hands over less leaves this contract owing more than it holds - and
    ///      the shortfall is found by whoever claims last.
    ///
    ///      ONLY WHERE WE ARE THE RECIPIENT. A take straight to a payee can be
    ///      short and no book of ours is wrong about it; this one is ours to
    ///      get right. And nobody can provoke it: how a token transfers is the
    ///      asset's property, not a caller's choice, so failing here cannot be
    ///      used to stop a swap the way a reverting recipient once could.
    function _takeExact(Currency quote, address token, uint256 amount) private {
        uint256 before = IERC20(token).balanceOf(address(this));
        poolManager.take(quote, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        if (received != amount) revert InexactTransfer(token, amount, received);
    }

    /// @notice Takes what this contract owes you in `token`.
    ///
    /// @dev TO THE CALLER, NEVER TO A PARAMETER. There is no recipient
    ///      argument, so there is nothing for a phishing flow to fill in.
    ///
    ///      WRITTEN DOWN FIRST. The balance is zeroed before anything external
    ///      happens, so a token or a wallet that calls back finds nothing left
    ///      to claim. The guard below is the second line, not the first.
    ///
    ///      WETH LEAVES AS ETHER, and falls back to the wrapped token if the
    ///      claimant will not take it - which costs them nothing but the
    ///      wrapper, and cannot affect anybody else now that this is outside
    ///      the lock.
    function claim(address token) external returns (uint256 amount) {
        if (_claiming) revert ClaimReentered();
        _claiming = true;

        amount = owed[msg.sender][token];
        if (amount == 0) revert NothingOwed(msg.sender, token);
        owed[msg.sender][token] = 0;

        if (token == WETH) {
            IWETH(WETH).withdraw(amount);
            (bool sent,) = msg.sender.call{value: amount}("");
            if (sent) {
                emit PaidAsNative(msg.sender, amount);
                emit FeeClaimed(msg.sender, token, amount);
                _claiming = false;
                return amount;
            }
            IWETH(WETH).deposit{value: amount}();
            emit PaidAsWrapped(msg.sender, amount);
        }

        // AND WHAT LEAVES IS WHAT WAS OWED. PONS checks its own payouts the
        // same way (_payOut). safeTransfer proves the call did not revert; it
        // proves nothing about the amount, and this balance was already zeroed
        // above - so a short transfer would close a debt that was not paid.
        uint256 before = IERC20(token).balanceOf(msg.sender);
        SafeERC20.safeTransfer(IERC20(token), msg.sender, amount);
        uint256 received = IERC20(token).balanceOf(msg.sender) - before;
        if (received != amount) revert InexactTransfer(token, amount, received);
        emit FeeClaimed(msg.sender, token, amount);
        _claiming = false;
    }

    /// Both legs, each to its payee or into `owed`.
    ///
    /// @dev NOTHING IS UNWRAPPED HERE. On a WETH pool both legs are taken into
    ///      this contract and recorded as debts; the unwrap happens in claim(),
    ///      once per claimant, and falls back to WETH if the claimant refuses
    ///      ether. On every other pool each leg goes straight to its payee and
    ///      only a refused leg becomes a debt. See _deliver for why WETH never
    ///      takes the direct path.
    ///
    ///      `collected` and FeeCharged name the quote token, because that is
    ///      what the pool was charged in - whichever way it then left.
    function _pay(PoolId id, Currency quote, uint256 base, LaunchFee memory cfg) private returns (uint256 charged) {
        (uint256 platformAmount, uint256 creatorAmount) = _legs(base, cfg);
        charged = platformAmount + creatorAmount;
        if (charged == 0) return 0;

        address token = Currency.unwrap(quote);
        // THIS POOL'S, NOT THE HOOK'S CURRENT ONE. See LaunchFee.platform.
        if (platformAmount != 0) _deliver(quote, token, cfg.platform, platformAmount);
        if (creatorAmount != 0) _deliver(quote, token, cfg.creator, creatorAmount);
        collected[token] += charged;
        emit FeeCharged(id, token, base, platformAmount, creatorAmount);
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }
}
