// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {Pool} from "@uniswap/v4-core/src/libraries/Pool.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";

import {PositionLock, IPositionManagerMinimal} from "./PositionLock.sol";
import {LaunchRegistry} from "./LaunchRegistry.sol";
import {
    ISharingCatalog,
    IHolderDistributorFactory,
    IHolderDistributorIdentity,
    IFeeHookSharing
} from "./sharing/ICurbSharing.sol";

interface IPermit2Minimal {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// @dev The part of a bonding curve graduation depends on. Deliberately small:
///      everything here is read or called, nothing is assumed about the rest.
interface IGraduatingCurve {
    /// The TRADEABLE reserves - what the curve's price is quoted against.
    function getReserves() external view returns (uint256 quoteReserve, uint256 tokenReserve);
    function readyToGraduate() external view returns (bool);
    /// Also gated on the curve's factory role, which this contract holds.
    function initialize(address token) external;
    /// Hands over the reserves the curve can physically transfer. Restricted to
    /// the curve's factory, which is why this contract must BE that factory.
    function graduate(address recipient) external returns (uint256 quoteOut, uint256 tokenOut);
    /// The launch token the curve dispenses, fixed by initialize().
    function token() external view returns (address);
    /// Who the curve pays its creator fees to now.
    function deployer() external view returns (address);
}

interface IPositionManagerNextId {
    function nextTokenId() external view returns (uint256);
}

/// @dev The curve's own escape hatch for a quote asset that has stopped
///      delivering to the escrow. This contract holds the role that gates it.
interface IRescuableCurve {
    function rescueFees() external returns (uint256 protocolAmount, uint256 creatorAmount);
}

/// @dev The launch token must be able to destroy its own supply. See the note
///      on the remainder below for why address(0) is not a substitute.
interface IBurnableLaunchToken {
    function burn(uint256 amount) external;
}

/// @dev The hook has to be told which launch its pool belongs to, and it reads
///      the terms out of the registry itself - this passes a name, not a rate.
interface IFeeHookConfig {
    function configureLaunch(address launchToken, PoolKey calldata key) external;
}

/// @dev The curve's creator-fee recipient, which only this contract (the
///      curve's factory role) may move - and which it moves in exactly one
///      place, the holder-sharing switch.
interface ICreatorFeeCurve {
    function setCreatorFeeRecipient(address newRecipient) external;
    function feeEscrow() external view returns (address);
}

/**
 * @title Graduator
 * @notice Moves an ALREADY-LAUNCHED token and its curve reserves into a
 *         Uniswap v4 pool, and locks the resulting LP position - in one
 *         transaction, on terms nobody at graduation time can choose.
 *
 * WHAT THIS IS NOT. It does not create a token. The launch phase does that; by
 * the time graduation runs the token exists, has holders, and has a price the
 * curve arrived at. This contract carries that state across to an AMM without
 * changing it.
 *
 * WHO MAY CALL: ANYONE, AND THE REASON MATTERS
 *   An earlier version took the beneficiary, the refund address and a lock
 *   duration (there is none now) as ARGUMENTS. For graduation to move a
 *   curve's reserves the curve must authorise this contract, and an ERC-20
 *   allowance authorises the CONTRACT, not a caller - so a stranger could aim
 *   a graduation at someone else's funded curve and lock the LP position for
 *   themselves.
 *
 *   WHAT ACTUALLY CLOSES THAT is the write-once LaunchRegistry record: the
 *   only argument is the launch token, everything economic is looked up, and
 *   the curve pays this contract and nobody else. A caller chooses nothing.
 *
 *   A caller restriction was added on top and it was a mistake. It bought no
 *   safety the registry did not already provide, and it broke the curve's own
 *   design: PonsV2BondingCurve calls factory.graduate(token) the instant a buy
 *   crosses the threshold, so the crossing trade graduates atomically. Coming
 *   from the curve, that call was refused. The curve caught the failure - and
 *   BOTH buying and selling are closed from that moment, because sell() also
 *   reverts once readyToGraduate() is true. Holders were left frozen out of
 *   the curve and the pool at once, waiting for an operator.
 *
 *   So graduation is permissionless, as the curve's own comment assumes:
 *   "graduation stays permissionlessly retryable via the factory". The gates
 *   that matter are still there - registered, not already graduated, and the
 *   curve says it is ready - and none of them is about who is asking.
 *
 * THE POOL OPENS AT THE CURVE'S PRICE, NOT AT THE RATIO OF WHAT IT HANDED OVER
 *   These are NOT the same number and assuming they were is a real bug. A
 *   curve with virtual liquidity prices against
 *       phantomQuote + trackedQuote - fees
 *   but can only physically transfer `trackedQuote`. The transferable reserves
 *   are therefore SHORT of the priced reserves by the phantom amount, and a
 *   pool opened at their raw ratio would open BELOW the curve's last price -
 *   an arbitrage gap handed to whoever is watching, paid for by the holders.
 *
 *   So the opening price is read from the curve's own getReserves() BEFORE
 *   graduation, and the handed-over amounts are then deposited AT that price.
 *   The quote side binds (it is short by the phantom amount, which
 *   assertTermsAreSeedable requires to be non-zero). Any quote left over is
 *   refunded to the record's refund address; the launch tokens the pool could
 *   not absorb are BURNED, as the next section explains. (This said "the rest
 *   is refunded", and the rest is always the launch token.)
 *
 * THE REMAINDER IS BURNED, AND THAT IS A PRODUCT DECISION, NOT A CLEANUP
 *   Because the transferable quote is short of the priced quote by the phantom
 *   amount, the quote side binds and a large part of the launch token cannot
 *   be deposited at the curve's price. At the candidate parameters that is a
 *   QUARTER OF THE ENTIRE SUPPLY - the same size as the LP position, and not
 *   covered by its lock.
 *
 *   Vesting it to the creator, holding it as protocol inventory and burning it
 *   are three different products. Burning is what this implements: it is the
 *   only one of the three that creates no address anyone has to be trusted
 *   with, and the float buyers were told about is the float that exists.
 *
 *   IT IS NOT A PARAMETER. There is no per-launch setting, so no launch can be
 *   configured to route the remainder somewhere else, and nothing has to be
 *   checked at registration. The quote remainder - usually zero, and never the
 *   token being launched - still goes to the record's refund address, because
 *   NVDAc is not ours to destroy.
 *
 *   BURNING IS A SUPPLY CHANGE AND NOTHING MORE. It is not a price guarantee
 *   and not a "clean chart": the LP's own tokens remain purchasable, and
 *   locking the position does not lock them out of the market.
 *
 * NO PRIVILEGES OVER VALUE
 *   No owner and no pause, and no path by which this contract moves value it
 *   holds to an address a caller chooses. Reserves go to the pool or to the
 *   record's refund address; the LP position goes to a lock nobody can
 *   open, ever.
 *
 *   rescueCurveFees is not an exception: it moves a CURVE's fees to that
 *   curve's own fixed recipients and touches nothing held here. Those two
 *   recipients may call it at any time; anyone else only once the curve has
 *   sat full and ungraduated for RESCUE_DELAY (noteReady).
 *
 *   EVERY DOOR CHECKS THE RECORD'S CURVE IS THIS TOKEN'S. Graduation, the
 *   fee hatch and the sharing switch refuse a record whose curve dispenses
 *   another token (_requireOwnCurve), behind the registry's own refusal of
 *   such a record.
 *
 *   WHAT IS HELD: anything somebody sends here uninvited. A launch token or a
 *   quote asset transferred in by hand stays, unreachable, and is never
 *   attributed to a launch - see AUDIT.txt A-4 at _burnRemainder and
 *   _refund. This header used to say nothing was held between transactions,
 *   which was the intent and not the fact.
 *
 * HOLDER SHARING: ONE SWITCH PER LAUNCH, HERE, ONE WAY
 *   A launch's creator income - the curve's creator fees, the pool's creator
 *   leg and the locked position's LP fees - can be switched, once and for
 *   good, to a distributor that shares it among the launch's holders. The
 *   switch lives in this contract because this contract already holds the
 *   three powers it needs: it is every curve's factory role (so it can move
 *   the curve's creator-fee recipient), the hook's poolOpener (so the hook
 *   takes the change from it), and the builder of every PositionLock (which
 *   reads the switch live). After the switch the creator's share is 0%.
 *
 *   WHO CAN THROW IT. The record's beneficiary, at any time; or the launcher
 *   that initialized the launch's real curve, inside that same transaction
 *   (enableHolderSharingAtLaunch). Nobody else - not the platform, not the
 *   registry's owner, not a launcher for someone else's launch.
 *
 *   WHERE IT POINTS. Never at an address a caller chooses: at the clone a
 *   catalog-approved distributor factory deploys for that token, checked here
 *   to be a contract that names this token, this quote asset and this
 *   Graduator, used by no other launch, and none of the launch's own or the
 *   deployment's contracts. SharingCatalog decides which factory versions are
 *   approved; it is read only at the switch, so it can never touch a launch
 *   that already switched.
 *
 *   WHAT IT DOES NOT MOVE. Money earned before the switch stays the
 *   creator's (see _enable's clean cut), the LP principal stays the
 *   beneficiary's, and the graduation refund still goes to the record's
 *   refund address. Nothing here can turn the switch off.
 *
 *   No owner or admin was added for this: the catalog holds the version list.
 */
contract Graduator {
    using SafeERC20 for IERC20;

    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager public immutable poolManager;
    IPositionManagerMinimal public immutable positionManager;
    IPermit2Minimal public immutable permit2;
    LaunchRegistry public immutable registry;

    mapping(address launchToken => bool) public hasGraduated;

    /// THE LOCK THIS LAUNCH'S POSITION WENT INTO, ASKABLE.
    ///
    /// @dev PONS keeps the same thing - lockedPositions, keyed by token -
    ///      and for the same reason: the address is in the Graduated event
    ///      too, but an event is something a reader has to go looking for
    ///      through a window of blocks, and a window that is too short
    ///      finds nothing and says nothing. A mapping is asked once.
    mapping(address launchToken => address lock) public lockOf;

    /// AND WHAT WAS BURNED WITH IT. PONS stores lockedTokenSupply beside
    /// lockedPositions for the same reason; this page's own lock panel says it
    /// in so many words - "the Graduator emits the lock address and the burned
    /// amount and stores neither, so every client is left scanning logs for
    /// something a getter could return". Both are getters now.
    mapping(address launchToken => uint256 amount) public burnedOf;

    /// The approved distributor factory versions. Read only inside the switch.
    ISharingCatalog public immutable sharingCatalog;

    /// A launch's holder-sharing switch: its distributor and the block it was
    /// thrown in. One slot. WRITTEN ONCE, NEVER CLEARED - see _enable.
    struct Sharing {
        address distributor;
        uint64 sinceBlock;
    }

    mapping(address launchToken => Sharing) internal _sharing;

    /// The other direction, so one distributor can never serve two launches.
    mapping(address distributor => address launchToken) public launchOfDistributor;

    /// HOW LONG A FULL CURVE MUST SIT UNGRADUATED BEFORE ANYONE MAY FORCE ITS
    /// FEES OUT. Counted from readySince, which noteReady writes. Long enough
    /// for the keeper's graduation scan (every ten minutes by default) and any
    /// visitor to complete the move several times over; short enough that a
    /// launch the issuer has truly stranded waits an hour, not a day.
    uint256 public constant RESCUE_DELAY = 1 hours;

    /// WHEN THIS LAUNCH'S CURVE WAS FIRST SEEN FULL AND UNGRADUATED, by
    /// anyone's noteReady; zero until then. WRITTEN ONCE, NEVER MOVED: a
    /// second note cannot push the rescue's opening later.
    mapping(address launchToken => uint256 at) public readySince;

    /// The transient mark initializeCurve leaves for the creating launcher,
    /// keyed by (token, curve) - see enableHolderSharingAtLaunch.
    bytes32 private constant CREATED_BY_TAG = keccak256("curb.graduator.createdBy");
    /// The transient reentrancy guard's slot - see `locked`.
    bytes32 private constant GUARD_SLOT = keccak256("curb.graduator.guard");

    event Graduated(
        address indexed launchToken,
        address indexed lock,
        uint256 indexed tokenId,
        uint160 sqrtPriceX96,
        uint128 liquidity
    );
    event RemainderBurned(address indexed launchToken, uint256 amount);
    /// The launch's curve was seen full and ungraduated at `at`; its fee
    /// rescue opens to anyone at `at + RESCUE_DELAY` if it is still so then.
    event ReadyNoted(address indexed launchToken, uint256 at);
    /// A launch's creator income now goes to `distributor`, for good.
    /// `graduated` says which leg was redirected here (the pool's if true, the
    /// curve's if false); the lock follows on its own.
    event HolderSharingEnabled(
        address indexed launchToken,
        address indexed distributor,
        address indexed factory,
        address by,
        bool graduated,
        uint64 sinceBlock
    );

    error NotTheLauncher(address caller);
    error NotTheBeneficiary(address caller);
    error NotTheCreatingLauncher(address caller);
    error AlreadySharing(address launchToken);
    error FactoryNotApproved(address factory);
    error NotADistributorForThisToken(address distributor);
    error Reentered();
    /// A constructor argument that is permanent must not be permanently zero.
    error ZeroAddress();
    error AlreadyGraduated(address launchToken);
    /// The record's curve dispenses another token: it is not this launch's.
    error CurveIsAnotherLaunchs(address curve, address itsToken);
    /// The caller is neither the curve's creator-fee recipient nor the
    /// record's platform recipient, and the rescue is not open to anyone yet:
    /// `opensAt` is when it will be if the curve is still full and
    /// ungraduated then, or zero while nobody has noted it ready.
    error RescueNotOpenYet(address caller, uint256 opensAt);
    error CurveNotReady(address curve);
    error ZeroReserves();
    error PriceOutOfRange(uint256 sqrtPriceX96);
    error SeedAllocationEmpty(uint256 supply, uint256 phantomQuote, uint256 graduationThreshold);
    error SeedWouldNotMint(int24 tickSpacing, uint256 amount0, uint256 amount1);
    error SeedAboveTickCap(uint128 liquidity, uint128 cap);
    error PoolAlreadyAtADifferentPrice(uint160 wanted, uint160 existing);
    error PoolInitializationFailed();
    error NoLiquidityFromTheseReserves();
    error LockDidNotTakeCustody();
    error ReservesDidNotArrive(address token, uint256 expected, uint256 received);
    error ReservesTooLargeToEncode(uint256 amount0, uint256 amount1);
    /// A held seed amount above MAX_SEED_AMOUNT, refused from the terms before
    /// any launch exists. Tighter than ReservesTooLargeToEncode (uint128, the
    /// width of the mint's maxima): this is the int128 bound v4 core enforces
    /// on the deposit itself. Named apart also because at this point there is
    /// no pool and so no currency0 and currency1 to report.
    error SeedTooLargeToEncode(uint256 reservedTokens, uint256 graduationThreshold);
    /// THE LARGEST AMOUNT v4 CAN DEPOSIT ON ONE SIDE: Pool.modifyLiquidity
    /// narrows each side's delta with SafeCast.toInt128. The same figure as
    /// PONS's MAX_SEED_AMOUNT (PonsV2GraduationGuard.sol).
    uint256 public constant MAX_SEED_AMOUNT = uint256(uint128(type(int128).max));
    error RemainderNotBurned(address launchToken, uint256 amount, uint256 supplyBefore, uint256 supplyAfter);

    /// ALL FIVE ARE IMMUTABLE, SO A ZERO HERE IS PERMANENT.
    ///
    /// AUDIT.txt A-5. The registry's wire() catches a zero registry, because a
    /// graduator whose registry is not this one fails the loop check. It does
    /// NOT catch a zero poolManager: wire() proves the hook and the graduator
    /// AGREE on a PoolManager, and two zeroes agree. That deployment wires
    /// cleanly, sells a whole launch, and fails at graduation - after the money
    /// is in, which is the one failure this codebase is written to avoid.
    constructor(
        IPoolManager poolManager_,
        IPositionManagerMinimal positionManager_,
        IPermit2Minimal permit2_,
        LaunchRegistry registry_,
        ISharingCatalog sharingCatalog_
    ) {
        if (
            address(poolManager_) == address(0) || address(positionManager_) == address(0)
                || address(permit2_) == address(0) || address(registry_) == address(0)
                || address(sharingCatalog_) == address(0)
        ) revert ZeroAddress();
        poolManager = poolManager_;
        positionManager = positionManager_;
        permit2 = permit2_;
        registry = registry_;
        sharingCatalog = sharingCatalog_;
    }

    /// TRANSIENT, SO IT COSTS NOTHING TO KEEP AND CANNOT BE LEFT SET. Guards
    /// every entry point that calls out while a launch's state is half
    /// written: graduation, the curve-fee hatch and both sharing switches. A
    /// distributor factory's deploy() is the one call into code this project
    /// did not write, and it must not be able to come back in.
    modifier locked() {
        bytes32 slot = GUARD_SLOT;
        bool busy;
        assembly ("memory-safe") {
            busy := tload(slot)
        }
        if (busy) revert Reentered();
        assembly ("memory-safe") {
            tstore(slot, 1)
        }
        _;
        assembly ("memory-safe") {
            tstore(slot, 0)
        }
    }

    /// @notice Initializes a newly created curve.
    ///
    /// PonsV2BondingCurve gates initialize() AND graduate() on one immutable
    /// `factory` address. graduate() is the one that moves value, so that role
    /// has to live here - which means new curves can only be initialized
    /// through here too. This is a passthrough for the launch factory and
    /// nothing more: it holds no funds, reads no record, and the curve itself
    /// refuses a second call.
    /// ANY LAUNCHER THE REGISTRY ADMITS, not only the first one it was wired
    /// with. This used to read registry.launcher(), which is the FIRST factory
    /// and nothing more; once a second quote asset had its own factory, that
    /// factory could be deployed, admitted to the registry and offered in the
    /// interface, and still not create a single launch - because every launch
    /// initializes its curve through here. The registry is the one place that
    /// decides who is a launcher, so this asks it rather than keeping a second,
    /// narrower answer of its own.
    ///
    /// AND IT LEAVES A MARK FOR THIS TRANSACTION ONLY: which launcher
    /// initialized which curve for which token, in transient storage. That is
    /// what lets the creating launcher switch holder sharing on inside the
    /// launch transaction, and nobody else, and never later. KEYED BY THE CURVE
    /// TOO, and read back only against the registry record's curve: a launcher
    /// that initializes a curve of its own for somebody else's token writes a
    /// slot nobody will ever read, and a real curve refuses a second
    /// initialize().
    function initializeCurve(address curve, address launchToken) external {
        if (!registry.isLauncher(msg.sender)) revert NotTheLauncher(msg.sender);
        IGraduatingCurve(curve).initialize(launchToken);
        bytes32 slot = _createdBySlot(launchToken, curve);
        assembly ("memory-safe") {
            tstore(slot, caller())
        }
    }

    function _createdBySlot(address launchToken, address curve) private pure returns (bytes32) {
        return keccak256(abi.encode(CREATED_BY_TAG, launchToken, curve));
    }

    /// THE RECORD'S CURVE MUST SAY IT DISPENSES THIS TOKEN.
    ///
    /// Asked at every door that makes a curve move value: graduation (the
    /// reserve), the curve-fee hatch (the fees) and the sharing switch (the
    /// creator-fee recipient). The registry refuses a record whose curve is
    /// another launch's; this asks again, so that a record which got past it
    /// anyway still cannot aim a live launch's curve at a token that is not its
    /// own. That is the theft the registry's check closes: a launcher's own
    /// token registered over a live curve, and that curve's reserve graduated
    /// into a pool the launcher controls.
    function _requireOwnCurve(address launchToken, address curve) private view {
        address itsToken = IGraduatingCurve(curve).token();
        if (itsToken != launchToken) revert CurveIsAnotherLaunchs(curve, itsToken);
    }

    // ------------------------------------------------------------------
    // HOLDER SHARING
    // ------------------------------------------------------------------

    /// @notice The distributor this launch's creator income goes to, or zero
    ///         while its holder sharing is off.
    function holderDistributorOf(address launchToken) external view returns (address) {
        return _sharing[launchToken].distributor;
    }

    /// @notice The block in which this launch's holder sharing was switched
    ///         on, or zero while it is off.
    function sharingSince(address launchToken) external view returns (uint64) {
        return _sharing[launchToken].sinceBlock;
    }

    /// @notice Switches this launch's creator income to its holders, for good.
    ///         The record's beneficiary only. `factory` is the approved
    ///         distributor factory version the caller read and chose.
    function enableHolderSharing(address launchToken, address factory) external locked returns (address) {
        LaunchRegistry.Launch memory rec = registry.launchOf(launchToken);
        if (msg.sender != rec.beneficiary) revert NotTheBeneficiary(msg.sender);
        return _enable(launchToken, rec, factory);
    }

    /// @notice The same switch, thrown by the launcher that initialized this
    ///         launch's curve, inside the transaction that did it.
    /// @dev The mark initializeCurve left is looked up under the RECORD's
    ///      curve, so only the real curve's initializer finds it; a later
    ///      transaction finds nothing, because the mark is transient. It is
    ///      cleared on use. (The mark can only have been written by an
    ///      admitted launcher, and launchers are never removed, so the mark
    ///      matching the caller is the whole check.)
    function enableHolderSharingAtLaunch(address launchToken, address factory) external locked returns (address) {
        LaunchRegistry.Launch memory rec = registry.launchOf(launchToken);
        bytes32 slot = _createdBySlot(launchToken, rec.curve);
        address createdBy;
        assembly ("memory-safe") {
            createdBy := tload(slot)
        }
        if (createdBy != msg.sender) revert NotTheCreatingLauncher(msg.sender);
        assembly ("memory-safe") {
            tstore(slot, 0)
        }
        return _enable(launchToken, rec, factory);
    }

    /// THE SWITCH ITSELF, IN THIS ORDER, AND THE ORDER IS THE POINT.
    function _enable(address launchToken, LaunchRegistry.Launch memory rec, address factory)
        private
        returns (address d)
    {
        // ---- 0. the record's curve is this launch's own
        _requireOwnCurve(launchToken, rec.curve);
        // ---- 1. once
        if (_sharing[launchToken].distributor != address(0)) revert AlreadySharing(launchToken);
        // ---- 2. a version the catalog approves now
        if (!sharingCatalog.isApproved(factory)) revert FactoryNotApproved(factory);
        // ---- 3. the distributor is the one the factory builds for this token
        d = IHolderDistributorFactory(factory).deploy(launchToken);
        // ---- 4. and it is what it says it is. A factory is trusted to build
        // the right contract, not to name any address it likes: one of this
        // launch's own contracts, or the deployment's, would turn "send it to
        // the holders" into "send it somewhere that already has a role here".
        if (
            d.code.length == 0 || launchOfDistributor[d] != address(0)
                || IHolderDistributorIdentity(d).launchToken() != launchToken
                || IHolderDistributorIdentity(d).quoteToken() != rec.quoteToken
                || IHolderDistributorIdentity(d).graduator() != address(this) || d == rec.curve || d == launchToken
                || d == rec.quoteToken || d == address(rec.hooks) || d == rec.beneficiary || d == rec.refundTo
                || d == rec.platformRecipient || d == address(this) || d == address(registry)
                || d == address(poolManager) || d == address(positionManager)
                || d == ICreatorFeeCurve(rec.curve).feeEscrow()
        ) revert NotADistributorForThisToken(d);

        // ---- 5. A CLEAN CUT. What the creator earned before this call is paid
        // to the creator, through the existing hatches and to the existing
        // recipients, BEFORE the switch below is written - so the lock, which
        // reads the switch live, still pays (or holds for) the beneficiary.
        // Best effort: nothing pending, or an issuer blocking the creator,
        // leaves the amount where it is, and it then goes to the holders. A
        // caller who starves these of gas only gives the creator's own pending
        // fees to the holders. FeeEscrow credits and the hook's `owed` are
        // keyed to the creator's address and are never touched.
        bool graduated = hasGraduated[launchToken];
        if (!graduated) {
            try IRescuableCurve(rec.curve).rescueFees() {} catch {}
        } else {
            try PositionLock(lockOf[launchToken]).claimFees() {} catch {}
        }

        // ---- 6. the switch: written once, never cleared
        uint64 sinceBlock = uint64(block.number);
        _sharing[launchToken] = Sharing(d, sinceBlock);
        launchOfDistributor[d] = launchToken;

        // ---- 7. and the leg that does not read it live is moved. THE ONLY
        // CALL TO setCreatorFeeRecipient IN THIS CODEBASE, and it runs at most
        // once per launch. After graduation the curve has nothing left to pay;
        // the pool's creator leg moves instead.
        if (!graduated) {
            ICreatorFeeCurve(rec.curve).setCreatorFeeRecipient(d);
        } else {
            IFeeHookSharing(address(rec.hooks)).syncCreator(launchToken);
        }
        emit HolderSharingEnabled(launchToken, d, factory, msg.sender, graduated, sinceBlock);
    }

    /// @notice Pays a curve's pending fees straight to its protocol and creator
    ///         recipients, bypassing the escrow, and unblocks its graduation.
    ///
    /// WHY THIS EXISTS, AND IT IS NOT A CONVENIENCE. PonsV2BondingCurve ships
    /// rescueFees() for one named situation, in its own words: a permissioned
    /// quote asset that "can stop delivering to that one address while still
    /// permitting transfers between traders and this curve", after which "the
    /// launch would be stuck on its curve forever". Our quote asset IS a
    /// permissioned asset and that one address IS our escrow.
    ///
    /// The route is real and was provoked on a fork: one blocklist entry on the
    /// escrow, added by the issuer's own policy admin, leaves a full curve that
    /// cannot graduate (the sweep inside graduate() reverts), cannot be bought
    /// from (its allocation is exhausted) and cannot be sold to (it is ready).
    /// Every door at once.
    ///
    /// rescueFees is onlyFactory and THIS CONTRACT HOLDS THAT ROLE. Without a
    /// path through here the hatch exists and nothing can ever open it - and
    /// this contract is immutable, so "add it later" is not available.
    ///
    /// THE CURVE'S CREATOR-FEE RECIPIENT AND THE RECORD'S PLATFORM RECIPIENT
    /// MAY CALL IT AT ANY TIME. This pays raw quote, where the escrow pays a
    /// WETH credit as ETH. Open to anyone at any time, a griefer could force
    /// every batch of a creator's curve tax out as WETH to a creator contract
    /// built around the escrow, which takes ETH and has no way to move a
    /// token - all of its curve-phase income, stranded. The internal clean cut
    /// in _enable calls the curve directly and is not gated by this.
    ///
    /// ANYONE ELSE, ONLY ONCE THE CURVE HAS SAT FULL AND UNGRADUATED FOR
    /// RESCUE_DELAY, counted from readySince (noteReady). A caller chooses
    /// nothing: the curve pays its own immutable protocolFeeRecipient and its
    /// own creator, and the only argument is a launch token that must already
    /// have a registry record whose curve is its own - so this cannot be aimed
    /// at an arbitrary contract. Closing it to strangers for good would put a
    /// stranded launch's recovery behind its two payees, which is the same
    /// mistake graduate() records having made. A full curve is the only one
    /// whose pending fees can block anything: graduation is the door they
    /// block, and it opens at readyToGraduate().
    ///
    /// NOT THE MOMENT THE CURVE IS FULL, WHICH A BUYER DECIDES. This used to
    /// open to anyone at readyToGraduate(). The buy that fills a curve tries
    /// to graduate it, but its sender sets the gas and can starve that call
    /// (the 63/64 rule) - and then call this in the same transaction, on a
    /// curve that is full only because they filled it and ungraduated only
    /// because they starved it: the creator's whole unswept tax forced out as
    /// raw WETH, the grief above, once per launch. A curve that is merely full
    /// is not stuck. One that has sat full for RESCUE_DELAY while graduate()
    /// stayed open to everybody - the keeper completes the move on its own -
    /// is the one this hatch is for.
    ///
    /// WHAT IT DOES NOT FIX: if the blocked address is the protocol's own
    /// recipient rather than the escrow, this pays it directly and reverts for
    /// the same reason. The hatch routes around the ESCROW, not around the
    /// issuer.
    function rescueCurveFees(address launchToken)
        external
        locked
        returns (uint256 protocolAmount, uint256 creatorAmount)
    {
        LaunchRegistry.Launch memory rec = registry.launchOf(launchToken);
        _requireOwnCurve(launchToken, rec.curve);
        IGraduatingCurve curve = IGraduatingCurve(rec.curve);
        if (msg.sender != curve.deployer() && msg.sender != rec.platformRecipient) {
            uint256 since = readySince[launchToken];
            uint256 opensAt = since == 0 ? 0 : since + RESCUE_DELAY;
            // READY NOW TOO: graduation closes the hatch to strangers, and the
            // curve says so (readyToGraduate() is false once it has graduated).
            if (since == 0 || block.timestamp < opensAt || !curve.readyToGraduate()) {
                revert RescueNotOpenYet(msg.sender, opensAt);
            }
        }
        return IRescuableCurve(rec.curve).rescueFees();
    }

    /// @notice Records that this launch's curve is full and ungraduated now,
    ///         which starts the RESCUE_DELAY after which anyone may rescue its
    ///         fees. Anyone may call it; a second call changes nothing.
    ///
    /// A NOTE, NOT A RESCUE: the earliest it can open anything is RESCUE_DELAY
    /// later, so making it in the very transaction that filled the curve and
    /// starved its graduation buys nothing - graduate() stays open to everyone
    /// for the whole hour. The note is asked of the chain, not taken: the
    /// record's curve must be this launch's own and must say it is ready, and
    /// the launch must not have graduated.
    function noteReady(address launchToken) external returns (uint256 since) {
        since = readySince[launchToken];
        if (since != 0) return since;
        if (hasGraduated[launchToken]) revert AlreadyGraduated(launchToken);
        LaunchRegistry.Launch memory rec = registry.launchOf(launchToken);
        _requireOwnCurve(launchToken, rec.curve);
        if (!IGraduatingCurve(rec.curve).readyToGraduate()) revert CurveNotReady(rec.curve);
        since = block.timestamp;
        readySince[launchToken] = since;
        emit ReadyNoted(launchToken, since);
    }

    /// @param launchToken The token the launch already created. Everything else
    ///        comes from its registry record - deliberately not from arguments.
    function graduate(address launchToken)
        external
        locked
        returns (PositionLock lock, uint256 tokenId, PoolKey memory key)
    {
        // No caller check. See the note above: the registry is what protects
        // the terms, and restricting the caller only froze holders out of both
        // venues while they waited for an operator.
        if (hasGraduated[launchToken]) revert AlreadyGraduated(launchToken);
        hasGraduated[launchToken] = true;

        LaunchRegistry.Launch memory rec = registry.launchOf(launchToken);
        _requireOwnCurve(launchToken, rec.curve);
        IGraduatingCurve curve = IGraduatingCurve(rec.curve);

        // ---- 1. the curve's FINAL PRICE, before anything moves.
        // Read from the tradeable reserves, which is what the curve quotes
        // against. Not from what it is about to hand over: those differ by the
        // virtual liquidity, and the difference is the whole point.
        (uint256 pricedQuote, uint256 pricedTokens) = curve.getReserves();
        if (pricedQuote == 0 || pricedTokens == 0) revert ZeroReserves();
        if (!curve.readyToGraduate()) revert CurveNotReady(rec.curve);

        // ---- 2. the reserves leave the curve, to THIS contract only
        uint256 quoteBefore = IERC20(rec.quoteToken).balanceOf(address(this));
        uint256 launchBefore = IERC20(launchToken).balanceOf(address(this));
        (uint256 quoteOut, uint256 tokenOut) = curve.graduate(address(this));
        // Measured, not trusted: a curve that reports more than it sent would
        // otherwise have the pool seeded against reserves that never arrived.
        uint256 quoteReceived = IERC20(rec.quoteToken).balanceOf(address(this)) - quoteBefore;
        uint256 launchReceived = IERC20(launchToken).balanceOf(address(this)) - launchBefore;
        if (quoteReceived != quoteOut) revert ReservesDidNotArrive(rec.quoteToken, quoteOut, quoteReceived);
        if (launchReceived != tokenOut) revert ReservesDidNotArrive(launchToken, tokenOut, launchReceived);
        if (quoteReceived == 0 || launchReceived == 0) revert ZeroReserves();

        // ---- 3. sort, carrying the PRICED amounts and the HELD amounts apart
        bool launchIsCurrency0 = launchToken < rec.quoteToken;
        (uint256 priced0, uint256 priced1) =
            launchIsCurrency0 ? (pricedTokens, pricedQuote) : (pricedQuote, pricedTokens);
        (uint256 held0, uint256 held1) =
            launchIsCurrency0 ? (launchReceived, quoteReceived) : (quoteReceived, launchReceived);

        key = PoolKey({
            currency0: Currency.wrap(launchIsCurrency0 ? launchToken : rec.quoteToken),
            currency1: Currency.wrap(launchIsCurrency0 ? rec.quoteToken : launchToken),
            fee: rec.fee,
            tickSpacing: rec.tickSpacing,
            hooks: rec.hooks
        });

        // ---- 4. the pool opens at the CURVE'S price
        uint160 sqrtPriceX96 = sqrtPriceFromAmounts(priced0, priced1);
        _initializeOrVerify(key, sqrtPriceX96);

        // ---- 4b. and it is bound to THIS launch's tax before it can be traded
        //
        // BEFORE THE LIQUIDITY, ON PURPOSE. The hook refuses to price a swap
        // against a pool it has no record for, so the order only matters if
        // something could trade in between - but putting the binding after the
        // mint would mean the pool holds liquidity for a few instructions while
        // its rate is unknown, and "nobody can reach it in the middle of one
        // transaction" is a weaker reason than not creating the window.
        //
        // The hook reads the rate and the creator from the registry, so this
        // passes only a name. If anything below reverts, this write reverts
        // with it and the launch is unconfigured again - which is what lets the
        // same launch be completed by a later attempt.
        IFeeHookConfig(address(rec.hooks)).configureLaunch(launchToken, key);
        // A LAUNCH THAT SWITCHED HOLDER SHARING ON WHILE ON ITS CURVE: the
        // pool's creator leg starts at its distributor, before the first swap.
        if (_sharing[launchToken].distributor != address(0)) {
            IFeeHookSharing(address(rec.hooks)).syncCreator(launchToken);
        }

        // ---- 5. deposit what we actually hold, at that price
        int24 tickLower = (TickMath.MIN_TICK / rec.tickSpacing) * rec.tickSpacing;
        int24 tickUpper = (TickMath.MAX_TICK / rec.tickSpacing) * rec.tickSpacing;

        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(tickLower),
            TickMath.getSqrtPriceAtTick(tickUpper),
            held0,
            held1
        );
        if (liquidity == 0) revert NoLiquidityFromTheseReserves();

        tokenId = _mint(key, tickLower, tickUpper, liquidity, held0, held1);

        // ---- 6. lock it, in the same transaction, for good: the lock has no
        // unlock time and no withdrawal, only fee collection.
        // The lock reads this launch's holder-sharing switch from here, live.
        lock = new PositionLock(positionManager, rec.beneficiary, key, tokenId, address(this), launchToken);
        // WRITTEN DOWN, NOT ONLY ANNOUNCED. See lockOf.
        lockOf[launchToken] = address(lock);
        IERC721(address(positionManager)).safeTransferFrom(address(this), address(lock), tokenId);
        // The lock's own receive hook enforces identity and pool. This
        // is a second check that custody really moved, because everything above
        // is pointless if the NFT is still sitting here.
        if (!lock.holdsPosition()) revert LockDidNotTakeCustody();

        // ---- 7. nothing THIS GRADUATION brought in is left behind
        // The quote is not ours to destroy, so its remainder goes to the
        // record's refund address. With any phantom liquidity at all the quote
        // is the binding side and this is measured to be zero, but it is not
        // guaranteed to be and is not treated as if it were.
        //
        // MEASURED AGAINST WHAT WE HELD BEFORE, NOT SWEPT. See _refund.
        _refund(rec.quoteToken, rec.refundTo, quoteBefore);

        emit Graduated(launchToken, address(lock), tokenId, sqrtPriceX96, liquidity);

        // ---- 8. and the launch token the pool could not absorb is destroyed.
        // DELIBERATELY LAST. An earlier version burned before refunding the
        // quote and the commit message then claimed no internal step could
        // fail after the burn - which was simply untrue, the refund was right
        // there. Ordering it last makes the claim structural instead of an
        // argument about which of the remaining steps can revert.
        _burnRemainder(launchToken, launchBefore);
    }

    /// @notice Refuses launch terms whose graduation could never be minted.
    ///
    /// @dev EVERYTHING BELOW ALREADY HAPPENS AT GRADUATION. The point of doing
    ///      it here is WHEN: a factory is built with immutable terms, so this
    ///      settles every launch it will ever create before one exists, rather
    ///      than surfacing as a full curve that cannot be completed. PONS does
    ///      the same one step later, per launch - see its _requireSeedableTerms
    ///      - because their economics are settable per asset and ours are not.
    ///
    ///      THE SEED IS DETERMINED BY THE TERMS. The curve reserves
    ///      supply * phantom / (phantom + threshold) and never sells through
    ///      it, and it opens the pool at its own final price: the virtual quote
    ///      against that reserve. Neither depends on how the curve was traded,
    ///      which is what makes a check this early mean anything.
    ///
    ///      BOTH ORDERINGS, because v4 sorts a pool's currencies by address and
    ///      the launch token does not exist yet.
    ///
    ///      WHAT IT DOES NOT CATCH: the curve's fee and the creator's tax move
    ///      the realised quote slightly off the threshold, so this narrows the
    ///      failure rather than removing it.
    function assertTermsAreSeedable(
        uint256 supply,
        uint256 phantomQuote,
        uint256 graduationThreshold,
        int24 tickSpacing
    ) external pure {
        uint256 virtualQuote = phantomQuote + graduationThreshold;
        uint256 reserved = FullMath.mulDiv(supply, phantomQuote, virtualQuote);
        // The curve's own rule, applied one step earlier: an allocation that
        // rounds away has nothing to seed with, and one that is the whole
        // supply leaves nothing to sell.
        if (reserved == 0 || reserved >= supply) {
            revert SeedAllocationEmpty(supply, phantomQuote, graduationThreshold);
        }
        // AND BOTH HELD AMOUNTS MUST FIT WHAT v4 WILL ACTUALLY DEPOSIT.
        // graduate() passes the WHOLE held reserve to _mint as amount0Max and
        // amount1Max. The held token amount is exactly `reserved`: the curve
        // hands over what it tracked and the sweep does not move it. The held
        // quote is the threshold, give or take the fee drift noted above.
        //
        // THE BOUND IS int128, NOT uint128. _mint's own check is uint128
        // (ReservesTooLargeToEncode), because that is the width of the
        // maxima it downcasts to - but Pool.modifyLiquidity narrows each
        // side's delta with SafeCast.toInt128, so a deposit past int128's
        // range reverts inside v4 core whatever the maxima say. The quote
        // binds and is deposited in full, so a threshold between 2^127 and
        // 2^128 passed a uint128 check here, sold a whole curve, and then
        // failed every graduation with SafeCastOverflow. The line is int128's
        // maximum, 2^127 - 1, where PONS draws it (PonsV2GraduationGuard's
        // MAX_SEED_AMOUNT). IT IS THE EXACT LIMIT AND MUST NOT BE RAISED: the
        // negated delta could carry -2^127, but PoolManager._settle narrows
        // the amount paid in with toInt128 as well, which refuses any x >=
        // 2^127, so a deposit of exactly 2^127 fails there.
        // Deposits never exceed the held amounts (the mint refuses more than
        // its maxima), so bounding the held amounts would be enough - and the
        // token side IS bounded exactly, since `reserved` is what is held.
        // THE QUOTE SIDE IS BOUNDED BY ITS STAND-IN. What is held is the
        // realised reserve, which the curve's rounding (always in its own
        // favour) can leave a little ABOVE the threshold; no bound on that
        // drift can be derived from the terms, so a threshold within it of
        // this line can still pass and fail at graduation. That is the
        // "narrows rather than removes" of the @dev above, and it applies here
        // too: nothing shipped is within orders of magnitude of it.
        // Before the price and liquidity checks below, whose arithmetic is not
        // written for amounts this size and would fail with a less useful error.
        if (reserved > MAX_SEED_AMOUNT || graduationThreshold > MAX_SEED_AMOUNT) {
            revert SeedTooLargeToEncode(reserved, graduationThreshold);
        }
        // The quote as currency0, then the launch token as currency0.
        _assertSeedable(tickSpacing, virtualQuote, reserved, graduationThreshold, reserved);
        _assertSeedable(tickSpacing, reserved, virtualQuote, reserved, graduationThreshold);
    }

    /// The priced pair sets the opening price; the held pair is what is
    /// deposited at it. They are not the same numbers - the difference is the
    /// curve's virtual liquidity - which is why graduate() carries them apart
    /// and so does this.
    function _assertSeedable(
        int24 tickSpacing,
        uint256 priced0,
        uint256 priced1,
        uint256 held0,
        uint256 held1
    ) private pure {
        uint160 sqrtPriceX96 = sqrtPriceFromAmounts(priced0, priced1);
        int24 tickLower = (TickMath.MIN_TICK / tickSpacing) * tickSpacing;
        int24 tickUpper = (TickMath.MAX_TICK / tickSpacing) * tickSpacing;
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(tickLower),
            TickMath.getSqrtPriceAtTick(tickUpper),
            held0,
            held1
        );
        if (liquidity == 0) revert SeedWouldNotMint(tickSpacing, held0, held1);
        // THE MINT INITIALIZES BOTH BOUNDARY TICKS, so this position's own
        // liquidity is the whole of liquidityGross at each of them. v4 reverts
        // with TickLiquidityOverflow past the cap a spacing implies, and that
        // rejection is independent of the one above.
        uint128 cap = Pool.tickSpacingToMaxLiquidityPerTick(tickSpacing);
        if (liquidity > cap) revert SeedAboveTickCap(liquidity, cap);
    }

    /// @notice sqrt(amount1 / amount0) in Q64.96, the form a v4 pool stores.
    /// @dev Public so a front end can show the opening price before committing
    ///      to it, and so tests can assert the pool matches it exactly rather
    ///      than approximately.
    ///
    ///      TWO PRECISIONS, SO THE WHOLE v4 RANGE IS REACHABLE. As a Q192 ratio
    ///      the result overflows once amount1/amount0 reaches 2^64 - far below
    ///      what a pool accepts (~2^128) - and failed as a bare FullMath
    ///      overflow, which left the upper bound below unreachable. cbBTC's
    ///      shipped terms sit at 90% of that edge. Below it, the Q192 path is
    ///      unchanged; above it a Q128 ratio is used and shifted into Q96.
    function sqrtPriceFromAmounts(uint256 amount0, uint256 amount1) public pure returns (uint160) {
        uint256 sqrtPrice;
        if (amount1 / amount0 < (1 << 64)) {
            sqrtPrice = _sqrt(FullMath.mulDiv(amount1, 1 << 192, amount0));
        } else if (amount1 / amount0 < (1 << 128)) {
            sqrtPrice = _sqrt(FullMath.mulDiv(amount1, 1 << 128, amount0)) << 32;
        } else {
            revert PriceOutOfRange(type(uint256).max);
        }
        if (sqrtPrice < TickMath.MIN_SQRT_PRICE || sqrtPrice >= TickMath.MAX_SQRT_PRICE) {
            revert PriceOutOfRange(sqrtPrice);
        }
        return uint160(sqrtPrice);
    }

    // ------------------------------------------------------------------

    /// A pool anyone may have initialized first.
    ///
    /// Accepting one only at OUR price stops an attacker CHOOSING the opening
    /// price, but on its own it does not stop them BLOCKING the graduation:
    /// they open it at any other price and every attempt afterwards reverts
    /// here, permanently. The real defence is a hook that refuses to let anyone
    /// but this contract initialize - see FeeHook's beforeInitialize. This
    /// check is what remains for pools whose hook does not gate initialization,
    /// and for those the block is real and is documented as such.
    function _initializeOrVerify(PoolKey memory key, uint160 sqrtPriceX96) private {
        try poolManager.initialize(key, sqrtPriceX96) returns (int24) {
            return;
        } catch {
            (uint160 existing,,,) = poolManager.getSlot0(key.toId());
            if (existing == 0) revert PoolInitializationFailed();
            if (existing != sqrtPriceX96) revert PoolAlreadyAtADifferentPrice(sqrtPriceX96, existing);
        }
    }

    function _mint(
        PoolKey memory key,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        uint256 amount0Max,
        uint256 amount1Max
    ) private returns (uint256 tokenId) {
        address token0 = Currency.unwrap(key.currency0);
        address token1 = Currency.unwrap(key.currency1);

        // Solidity does not check explicit downcasts, and both of these are
        // downcast below - Permit2 allowances are uint160, the mint's maximums
        // uint128. Truncating would authorise LESS than intended, which fails
        // safe but surfaces as a confusing slippage revert rather than this.
        if (amount0Max > type(uint128).max || amount1Max > type(uint128).max) {
            revert ReservesTooLargeToEncode(amount0Max, amount1Max);
        }

        // The real two-step flow, for exactly what this graduation may spend.
        // forceApprove, NOT approve. What it is FOR: a token whose approve
        // returns nothing (USDT's shape) makes a raw approve revert on decoding,
        // and a raw approve's false return was being ignored besides. What it
        // is NOT for, though this comment used to say so: a stale quote
        // allowance. The quote is the binding side and is spent to the last
        // unit (measured in B20Graduation), so its allowance is back to zero
        // after every graduation; the launch token keeps a remainder, but each
        // launch has a new token that is never approved twice. forceApprove's
        // reset path is therefore defence in depth, and B20MultiAsset leaves a
        // stale allowance by hand to exercise it.
        IERC20(token0).forceApprove(address(permit2), amount0Max);
        IERC20(token1).forceApprove(address(permit2), amount1Max);
        permit2.approve(token0, address(positionManager), uint160(amount0Max), uint48(block.timestamp + 1));
        permit2.approve(token1, address(positionManager), uint160(amount1Max), uint48(block.timestamp + 1));

        bytes memory actions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(
            key,
            tickLower,
            tickUpper,
            uint256(liquidity),
            uint128(amount0Max),
            uint128(amount1Max),
            address(this),
            bytes("")
        );
        params[1] = abi.encode(key.currency0, key.currency1);

        tokenId = IPositionManagerNextId(address(positionManager)).nextTokenId();
        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp);
    }

    /// @param heldBefore what this contract already held when the graduation
    ///        started. Everything above it is this graduation's remainder.
    function _burnRemainder(address launchToken, uint256 heldBefore) private {
        // AUDIT.txt A-4. This used to burn the whole balance. Anyone can send
        // a launch token here, and burning it would put somebody else's
        // transfer into this launch's RemainderBurned event and its supply
        // change - numbers a chart and a holder read as the launch's own.
        //
        // WHAT HAPPENS TO SUCH A TRANSFER NOW: it stays here, unreachable,
        // because there is no rescue path and this launch can never graduate
        // twice. That is not a new condition - it was already unreachable the
        // moment it arrived, and the donor loses it either way. What changes is
        // that it stops being attributed to a launch it was never part of.
        uint256 balance = IERC20(launchToken).balanceOf(address(this));
        if (balance <= heldBefore) return;
        uint256 left = balance - heldBefore;

        // TOTAL SUPPLY IS WHAT IS CHECKED, NOT OUR BALANCE. An earlier version
        // only confirmed this contract held nothing afterwards, which a burn()
        // that simply transferred the tokens elsewhere would satisfy just as
        // well - the very thing the check was written to catch. Supply falling
        // by exactly the amount is what "burned" means.
        uint256 supplyBefore = IERC20(launchToken).totalSupply();
        IBurnableLaunchToken(launchToken).burn(left);
        uint256 supplyAfter = IERC20(launchToken).totalSupply();

        if (supplyAfter > supplyBefore || supplyBefore - supplyAfter != left) {
            revert RemainderNotBurned(launchToken, left, supplyBefore, supplyAfter);
        }
        // Belt and braces: the supply fell by the right amount AND nothing of
        // THIS graduation's is still sitting here. Not "nothing at all" - what
        // was here before the graduation is deliberately untouched.
        if (IERC20(launchToken).balanceOf(address(this)) != heldBefore) {
            revert RemainderNotBurned(launchToken, left, supplyBefore, supplyAfter);
        }

        burnedOf[launchToken] = left;
        emit RemainderBurned(launchToken, left);
    }

    /// @param heldBefore what this contract already held when the graduation
    ///        started. Only what arrived SINCE is this graduation's to move.
    function _refund(address token, address to, uint256 heldBefore) private {
        // AUDIT.txt A-4. This used to send the whole balance. Anyone can send
        // the quote asset to this contract, and the next graduation would have
        // forwarded it to THAT launch's refund address - a third party, chosen
        // by whichever launch happened to graduate next.
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance <= heldBefore) return;
        uint256 left = balance - heldBefore;
        // safeTransfer: reverts on a false return AND accepts a token that
        // returns nothing. The raw call decoded a bool, so a USDT-shaped quote -
        // the shape forceApprove in _mint exists for - made every graduation
        // with a non-zero remainder revert.
        IERC20(token).safeTransfer(to, left);
    }

    /// Babylonian integer square root. Returns floor(sqrt(x)).
    ///
    /// SMALL INPUTS ARE ANSWERED DIRECTLY. The iteration starts from
    /// (x >> 1) + 1, which at x = 2 is 2 and never goes below the start, so it
    /// returned 2 rather than 1. Uniswap v2's version special-cases x <= 3 for
    /// exactly this. Unreachable through sqrtPriceFromAmounts (a result that
    /// small is refused as PriceOutOfRange either way), but the doc line above
    /// is a promise about every input.
    function _sqrt(uint256 x) private pure returns (uint256 z) {
        if (x <= 3) return x == 0 ? 0 : 1;
        z = x;
        uint256 y = (x >> 1) + 1;
        while (y < z) {
            z = y;
            y = (x / y + y) >> 1;
        }
    }

    // NO onERC721Received. It was here "to accept the position we just
    // minted", but PositionManager mints with a plain _mint and never calls it;
    // the only calls it ever got were safeTransferFroms of OTHER people's
    // positions, which it accepted into a contract with no way to send them
    // back. Without it such a transfer reverts and the sender keeps the NFT.
}
