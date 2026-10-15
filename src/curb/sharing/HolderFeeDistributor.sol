// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {IHolderDistributorIdentity, IHolderSharingSource, IPositionLockSharing} from "./ICurbSharing.sol";

// How long a published root waits before it pays. The factory reads it too.
uint256 constant SHARING_VETO_WINDOW = 1 hours;

/// What a distributor asks of the factory that built it.
interface IDistributorFactoryRoles {
    function keeperPayee() external view returns (address);
    function isDistributor(address account) external view returns (bool);
    function frozen() external view returns (bool);
}

/// The leading words of LaunchRegistry.Launch, the only ones read here.
/// @dev The record is all static words and only ever grows at its end (the
///      registry's header says so), so this prefix decodes every version of
///      it: the decoder needs at least these eight words and ignores the rest.
interface ILaunchRecordPrefix {
    struct LaunchPrefix {
        address curve;
        address quoteToken;
        address beneficiary;
        address refundTo;
        uint256 reservedZero;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    function launchOf(address launchToken) external view returns (LaunchPrefix memory);
}

interface ISharingCurve {
    function feeEscrow() external view returns (address);
    function sweepFees(uint256 minBuybackTokensOut) external;
}

interface ISharingEscrow {
    function claimToken(address token) external returns (uint256);
}

interface ISharingHook {
    function claim(address token) external returns (uint256);
}

interface IWETH9 {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

/**
 * @title HolderFeeDistributor
 * @notice One per launch, an EIP-1167 clone built by HolderDistributorFactory
 *         at an address that depends on the launch token alone. Once the
 *         launch's holder sharing switch (in the Graduator) points here, every
 *         creator fee leg of that launch pays this contract, and this contract
 *         pays the launch's holders: pushed by a keeper, with a claim by the
 *         holder itself as the fallback.
 *
 * ASSETS
 *   Asset 0 is the launch's quote asset. On a WETH launch ETH and WETH are
 *   counted together (the escrow and the hook pay ETH, the lock pays WETH) and
 *   holders are paid ETH, or WETH when they will not take ETH. On any other
 *   launch it is the quote token itself. Asset 1 is the launch token, which
 *   arrives as the launch-token side of the locked position's LP fees and is
 *   shared in kind. Donations of either asset count as income and are shared.
 *   Any other asset sent here stays here: there is no way out for it.
 *
 * CUMULATIVE ROOTS
 *   Each epoch the publisher posts one Merkle root whose leaves are
 *   (this distributor, account, cum0, cum1): everything that account has been
 *   allocated since sharing began. A payout is the leaf minus what was already
 *   paid, so a share too small to push today is still in the next leaf, larger,
 *   and an unclaimed share never expires and is never reallocated.
 *
 * WHAT IS ENFORCED HERE, WHATEVER THE ROOT SAYS
 *   - A root never allocates more than this contract has received:
 *     cumHolders0 + cumKeeper0 <= received0() and cumHolders1 <= received1().
 *   - Holders are never paid, in total, more than the active root declares,
 *     even if its leaves were made to sum to more.
 *   - Epochs are numbered one by one, block ranges are contiguous, and the
 *     cumulative totals only grow.
 *   - The keeper's gas fee is at most MAX_KEEPER_FEE_BPS (2%) of each epoch's
 *     new quote allocation, and is visible in RootPublished.
 *   - A root waits VETO_WINDOW (1 hour) before it pays; a vetoer can veto it
 *     during that hour; a pending root can never be replaced. While the
 *     factory is frozen a pending root does not become payable at all and can
 *     be vetoed at any time; the active root keeps paying.
 *   - Infrastructure (see isExcluded) is never paid, even if a root names it.
 *   - Money leaves only to a leaf's account (or the address that account
 *     itself names in claim) and to the factory's keeperPayee within the cap.
 *     There is no owner, no sweep, no upgrade, no delegatecall, no
 *     selfdestruct.
 *
 * WHAT IT DEPENDS ON: A LIVE PUBLISHER, WITH NO FALLBACK
 *   Only the factory's publisher proposes roots, and nothing is paid without
 *   one. Income received after the last activated root waits here until a
 *   later root allocates it. If the platform stops publishing for good - a
 *   lost publisher key the owner cannot rotate, a keeper shut down - that
 *   income waits here for good: no holder can claim it, the launch's creator
 *   cannot take it back (the switch is one way), and nothing sweeps it. What
 *   earlier roots allocated stays claimable. There is no fallback publisher.
 */
contract HolderFeeDistributor is IHolderDistributorIdentity, ReentrancyGuardTransient {
    address public constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 internal constant BPS = 10_000;

    /// How long a published root waits before it pays.
    uint256 public constant VETO_WINDOW = SHARING_VETO_WINDOW;
    /// The keeper's share of an epoch's gross new quote allocation, at most.
    uint256 public constant MAX_KEEPER_FEE_BPS = 200;
    /// Gas handed to each pushed ETH payment. A recipient that needs more, or
    /// refuses, is paid WETH instead.
    uint256 public constant ETH_PUSH_GAS = 50_000;
    /// Gas handed to each pushed token transfer. A transfer that fails within
    /// it is skipped and stays claimable.
    uint256 public constant TOKEN_PUSH_GAS = 200_000;

    struct Root {
        bytes32 merkleRoot;
        /// sha256 of the canonical epoch file.
        bytes32 contentHash;
        uint128 cumHolders0;
        uint128 cumHolders1;
        uint128 cumKeeper0;
        uint64 fromBlock;
        uint64 toBlock;
        uint32 epoch;
        /// Set here at publish (the caller's value is ignored); a pending root
        /// is meaningful only while this is non-zero.
        uint40 payableAt;
    }

    struct Leaf {
        address account;
        uint256 cum0;
        uint256 cum1;
    }

    // ---- the implementation's, shared by every clone
    address public immutable factory;
    address public immutable graduator;

    // ---- this launch, written once by initialize() from the registry
    address public launchToken;
    bool public initialized;
    address public quoteToken;
    address public curve;
    address public hook;
    address public escrow;
    address public poolManager;
    address public positionManager;
    address public registry;

    // ---- roots
    Root public active;
    Root public pending;
    uint32 public lastProposedEpoch;

    // ---- payouts
    mapping(address account => uint256) public paid0;
    mapping(address account => uint256) public paid1;
    uint256 public totalPaid0;
    uint256 public totalPaid1;
    uint256 public keeperPaid0;

    event Initialized(address indexed launchToken, address indexed quoteToken, address curve);
    event Harvested(uint256 received0, uint256 received1);
    event RootPublished(
        uint32 indexed epoch,
        bytes32 merkleRoot,
        uint64 fromBlock,
        uint64 toBlock,
        uint128 dH0,
        uint128 dH1,
        uint128 dK,
        bytes32 contentHash,
        string uri,
        uint40 payableAt
    );
    event RootVetoed(uint32 indexed epoch, bytes32 reason);
    event RootActivated(uint32 indexed epoch, bytes32 root);
    event Paid(address indexed account, address indexed to, uint256 amount0, uint256 amount1, bool pushed);
    event PushSkipped(address indexed account, uint8 asset);
    event ExcludedLeaf(address indexed account);
    event KeeperPaid(address indexed payee, uint256 amount);

    error NotTheFactory(address caller);
    error AlreadyInitialized();
    error PendingRoot(uint32 epoch);
    error NotSharingHere(address launchToken);
    error WrongEpoch(uint32 expected, uint32 got);
    error BadRange(uint64 expectedFrom, uint64 fromBlock, uint64 toBlock);
    error RootShrinks();
    error KeeperFeeAboveCap(uint256 fee, uint256 gross);
    error AllocatesMoreThanReceived(uint8 asset, uint256 allocated, uint256 received);
    error NoSuchPending(uint32 epoch);
    error VetoWindowOver(uint40 payableAt);
    error NothingPending();
    error NotYetPayable(uint40 payableAt);
    error Frozen();
    error NoActiveRoot();
    error BadProof();
    error LeavesExceedRoot(uint8 asset);
    error Excluded(address account);
    error NothingToClaim(address account);
    error TransferRefused(address asset, address to);
    error InexactTransfer(address asset, uint256 amount, uint256 moved);

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotTheFactory(msg.sender);
        _;
    }

    /// The implementation is born initialized, so it can never be one.
    constructor(address graduator_) {
        factory = msg.sender;
        graduator = graduator_;
        initialized = true;
    }

    /// Accepts ETH and does nothing else: no wrapping, no forwarding. The
    /// escrow and the hook pay a WETH launch's fees in ETH and check what they
    /// delivered, and WETH's own withdraw sends with a 2300 gas stipend.
    receive() external payable {}

    /// @notice Called once by the factory, in the transaction that clones this.
    ///         Everything is read from the launch's registry record, never from
    ///         a caller.
    function initialize(address launchToken_) external onlyFactory {
        if (initialized) revert AlreadyInitialized();
        initialized = true;
        IHolderSharingSource g = IHolderSharingSource(graduator);
        address reg = g.registry();
        ILaunchRecordPrefix.LaunchPrefix memory rec = ILaunchRecordPrefix(reg).launchOf(launchToken_);
        launchToken = launchToken_;
        quoteToken = rec.quoteToken;
        curve = rec.curve;
        hook = rec.hooks;
        escrow = ISharingCurve(rec.curve).feeEscrow();
        poolManager = g.poolManager();
        positionManager = g.positionManager();
        registry = reg;
        emit Initialized(launchToken_, rec.quoteToken, rec.curve);
    }

    // ------------------------------------------------------------------
    // INCOME
    // ------------------------------------------------------------------

    /// @notice Pulls in everything the core owes this distributor. Anyone may
    ///         call it. Each step is a plain call whose failure is ignored, so
    ///         a step with nothing to do, or one an issuer blocks, never stops
    ///         the others. Every source pays only this contract.
    function harvest() external nonReentrant {
        address t = launchToken;
        address q = quoteToken;
        IHolderSharingSource g = IHolderSharingSource(graduator);
        // Before graduation the curve holds this launch's pending tax; we are
        // its fee recipient (`deployer`), so we may sweep it. This also moves
        // the platform's share to the platform, as any sweep does.
        if (!g.hasGraduated(t)) _poke(curve, abi.encodeCall(ISharingCurve.sweepFees, (0)));
        _poke(escrow, abi.encodeCall(ISharingEscrow.claimToken, (q)));
        _poke(hook, abi.encodeCall(ISharingHook.claim, (q)));
        address lock = g.lockOf(t);
        if (lock != address(0)) {
            _poke(lock, abi.encodeCall(IPositionLockSharing.claimFees, ()));
            _poke(lock, abi.encodeCall(IPositionLockSharing.release, (address(this))));
        }
        emit Harvested(received0(), received1());
    }

    /// Everything this contract has ever received of the quote asset: what it
    /// holds plus what it has paid out to holders and to the keeper.
    function received0() public view returns (uint256) {
        return _held0() + totalPaid0 + keeperPaid0;
    }

    /// Everything this contract has ever received of the launch token.
    function received1() public view returns (uint256) {
        return IERC20(launchToken).balanceOf(address(this)) + totalPaid1;
    }

    function _held0() private view returns (uint256 h) {
        address q = quoteToken;
        h = IERC20(q).balanceOf(address(this));
        if (q == WETH) h += address(this).balance;
    }

    /// A call whose outcome is ignored and whose reply is never copied.
    function _poke(address target, bytes memory data) private {
        assembly ("memory-safe") {
            pop(call(gas(), target, 0, add(data, 0x20), mload(data), 0, 0))
        }
    }

    // ------------------------------------------------------------------
    // ROOTS
    // ------------------------------------------------------------------

    /// @notice Posted by the factory on the publisher's behalf.
    function publish(Root calldata r, string calldata uri) external onlyFactory nonReentrant {
        _promote();
        // A pending root is never replaced, so nobody can restart an honest
        // root's veto hour by posting over it.
        if (pending.payableAt != 0) revert PendingRoot(pending.epoch);
        address t = launchToken;
        IHolderSharingSource g = IHolderSharingSource(graduator);
        if (g.holderDistributorOf(t) != address(this)) revert NotSharingHere(t);

        uint32 want = lastProposedEpoch + 1; // a vetoed number is burned
        if (r.epoch != want) revert WrongEpoch(want, r.epoch);

        Root memory a = active;
        // Contiguous: a veto leaves `active` where it was, so the vetoed
        // range is offered again.
        uint64 from = a.epoch == 0 ? g.sharingSince(t) : a.toBlock + 1;
        if (r.fromBlock != from || r.toBlock < r.fromBlock || r.toBlock >= block.number) {
            revert BadRange(from, r.fromBlock, r.toBlock);
        }
        if (r.cumHolders0 < a.cumHolders0 || r.cumHolders1 < a.cumHolders1 || r.cumKeeper0 < a.cumKeeper0) {
            revert RootShrinks();
        }
        uint256 dH0 = r.cumHolders0 - a.cumHolders0;
        uint256 dK = r.cumKeeper0 - a.cumKeeper0;
        // fee <= 2% of the epoch's gross new quote allocation (holders + fee)
        if (dK * BPS > (dH0 + dK) * MAX_KEEPER_FEE_BPS) revert KeeperFeeAboveCap(dK, dH0 + dK);

        uint256 in0 = received0();
        uint256 alloc0 = uint256(r.cumHolders0) + r.cumKeeper0;
        if (alloc0 > in0) revert AllocatesMoreThanReceived(0, alloc0, in0);
        uint256 in1 = received1();
        if (r.cumHolders1 > in1) revert AllocatesMoreThanReceived(1, r.cumHolders1, in1);

        uint40 at = uint40(block.timestamp + VETO_WINDOW);
        pending = r;
        pending.payableAt = at;
        lastProposedEpoch = r.epoch;
        emit RootPublished(
            r.epoch,
            r.merkleRoot,
            r.fromBlock,
            r.toBlock,
            uint128(dH0),
            r.cumHolders1 - a.cumHolders1,
            uint128(dK),
            r.contentHash,
            uri,
            at
        );
    }

    /// @notice A vetoer's veto, through the factory, inside the root's hour -
    ///         or at any time while the factory is frozen, since a frozen
    ///         factory holds the root. Only the flag is cleared; the epoch
    ///         number stays burned.
    function veto(uint32 epoch, bytes32 reason) external onlyFactory {
        uint40 at = pending.payableAt;
        if (at == 0 || pending.epoch != epoch) revert NoSuchPending(epoch);
        if (block.timestamp >= at && !_frozen()) revert VetoWindowOver(at);
        pending.payableAt = 0;
        emit RootVetoed(epoch, reason);
    }

    /// @notice Makes a ripe pending root the active one. Anyone; push, claim,
    ///         payKeeper and publish also do it on the way in. Never while the
    ///         factory is frozen: the root waits, still vetoable.
    function activate() external nonReentrant {
        uint40 at = pending.payableAt;
        if (at == 0) revert NothingPending();
        if (block.timestamp < at) revert NotYetPayable(at);
        if (_frozen()) revert Frozen();
        _activate();
    }

    /// A ripe pending root becomes active on the way into push, claim,
    /// payKeeper and publish - unless the factory is frozen, when the active
    /// root keeps paying and the pending one waits.
    function _promote() private {
        uint40 at = pending.payableAt;
        if (at == 0 || block.timestamp < at || _frozen()) return;
        _activate();
    }

    function _activate() private {
        Root memory p = pending;
        active = p;
        pending.payableAt = 0;
        emit RootActivated(p.epoch, p.merkleRoot);
    }

    function _frozen() private view returns (bool) {
        return IDistributorFactoryRoles(factory).frozen();
    }

    // ------------------------------------------------------------------
    // PAYOUTS
    // ------------------------------------------------------------------

    /// @notice Pays many leaves of the active root at once, proven together by
    ///         one multiproof. Anyone may call it. An excluded account is
    ///         skipped; a token transfer refused within TOKEN_PUSH_GAS is
    ///         skipped and stays claimable; an ETH payment refused within
    ///         ETH_PUSH_GAS is paid as WETH.
    function push(Leaf[] calldata leaves, bytes32[] calldata proof, bool[] calldata flags) external nonReentrant {
        _promote();
        if (active.epoch == 0) revert NoActiveRoot();
        uint256 n = leaves.length;
        bytes32[] memory hashes = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            hashes[i] = leafOf(leaves[i].account, leaves[i].cum0, leaves[i].cum1);
        }
        if (!MerkleProof.multiProofVerifyCalldata(proof, flags, active.merkleRoot, hashes)) revert BadProof();
        address lock = IHolderSharingSource(graduator).lockOf(launchToken);
        for (uint256 i; i < n; ++i) {
            Leaf calldata l = leaves[i];
            address a = l.account;
            if (_excluded(a, lock)) {
                emit ExcludedLeaf(a);
                continue;
            }
            (uint256 s0, uint256 s1) = _settle(a, a, l.cum0, l.cum1, true);
            if (s0 != 0 || s1 != 0) emit Paid(a, a, s0, s1, true);
        }
    }

    /// @notice The fallback: the caller takes its own leaf, to itself or to an
    ///         address it names (`to`; zero means itself). Full gas; a WETH
    ///         launch pays ETH, or WETH if `to` will not take ETH; a refused
    ///         token transfer reverts.
    function claim(uint256 cum0, uint256 cum1, bytes32[] calldata proof, address to) external nonReentrant {
        _promote();
        if (active.epoch == 0) revert NoActiveRoot();
        address a = msg.sender;
        if (!MerkleProof.verifyCalldata(proof, active.merkleRoot, leafOf(a, cum0, cum1))) revert BadProof();
        if (to == address(0)) to = a;
        address lock = IHolderSharingSource(graduator).lockOf(launchToken);
        if (_excluded(a, lock)) revert Excluded(a);
        if (_excluded(to, lock)) revert Excluded(to);
        (uint256 s0, uint256 s1) = _settle(a, to, cum0, cum1, false);
        if (s0 == 0 && s1 == 0) revert NothingToClaim(a);
        emit Paid(a, to, s0, s1, false);
    }

    /// @notice Pays the factory's keeperPayee what the active root grants it
    ///         and it has not yet taken, as the quote token (WETH on a WETH
    ///         launch, never raw ETH). Anyone may call it. A pull, so a payee
    ///         that refuses never blocks holders.
    function payKeeper() external nonReentrant {
        _promote();
        uint256 due = active.cumKeeper0 - keeperPaid0;
        if (due == 0) return;
        address to = IDistributorFactoryRoles(factory).keeperPayee();
        keeperPaid0 += due;
        address q = quoteToken;
        if (q == WETH) {
            uint256 w = IERC20(WETH).balanceOf(address(this));
            if (w < due) IWETH9(WETH).deposit{value: due - w}();
        }
        _sendToken(q, to, due, false);
        emit KeeperPaid(to, due);
    }

    /// Books and sends one account's unpaid share of each asset. The ledger is
    /// written before the transfer; a refused push puts it back.
    function _settle(address account, address to, uint256 cum0, uint256 cum1, bool pushed)
        private
        returns (uint256 s0, uint256 s1)
    {
        uint256 p0 = paid0[account];
        if (cum0 > p0) {
            uint256 o = cum0 - p0;
            uint256 tp = totalPaid0 + o;
            if (tp > active.cumHolders0) revert LeavesExceedRoot(0);
            paid0[account] = cum0;
            totalPaid0 = tp;
            if (_send0(to, o, pushed)) {
                s0 = o;
            } else {
                paid0[account] = p0;
                totalPaid0 = tp - o;
                emit PushSkipped(account, 0);
            }
        }
        uint256 p1 = paid1[account];
        if (cum1 > p1) {
            uint256 o = cum1 - p1;
            uint256 tp = totalPaid1 + o;
            if (tp > active.cumHolders1) revert LeavesExceedRoot(1);
            paid1[account] = cum1;
            totalPaid1 = tp;
            if (_sendToken(launchToken, to, o, pushed)) {
                s1 = o;
            } else {
                paid1[account] = p1;
                totalPaid1 = tp - o;
                emit PushSkipped(account, 1);
            }
        }
    }

    /// The quote leg. On a WETH launch it goes as ETH (ETH_PUSH_GAS when
    /// pushed, all gas when claimed) and falls back to WETH, so it never
    /// fails softly; any other quote goes through _sendToken.
    function _send0(address to, uint256 amount, bool pushed) private returns (bool) {
        if (quoteToken != WETH) return _sendToken(quoteToken, to, amount, pushed);
        if (address(this).balance < amount) IWETH9(WETH).withdraw(IERC20(WETH).balanceOf(address(this)));
        uint256 g = pushed ? ETH_PUSH_GAS : gasleft();
        bool ok;
        assembly ("memory-safe") {
            ok := call(g, to, amount, 0, 0, 0, 0)
        }
        if (!ok) {
            IWETH9(WETH).deposit{value: amount}();
            _sendToken(WETH, to, amount, false);
        }
        return true;
    }

    /// A token transfer that counts only if the call succeeded, returned true
    /// or nothing, AND our own balance fell by exactly `amount`. A pushed
    /// transfer gets TOKEN_PUSH_GAS and may fail softly; any other reverts.
    function _sendToken(address token, address to, uint256 amount, bool pushed) private returns (bool ok) {
        uint256 before = IERC20(token).balanceOf(address(this));
        uint256 g = pushed ? TOKEN_PUSH_GAS : gasleft();
        assembly ("memory-safe") {
            let m := mload(0x40)
            mstore(m, 0xa9059cbb00000000000000000000000000000000000000000000000000000000)
            mstore(add(m, 0x04), to)
            mstore(add(m, 0x24), amount)
            mstore(0, 0)
            let s := call(g, token, 0, m, 0x44, 0, 0x20)
            switch returndatasize()
            case 0 { ok := and(s, gt(extcodesize(token), 0)) }
            default { ok := and(s, and(gt(returndatasize(), 0x1f), eq(mload(0), 1))) }
        }
        if (!ok) {
            if (!pushed) revert TransferRefused(token, to);
            return false;
        }
        uint256 afterBal = IERC20(token).balanceOf(address(this));
        if (afterBal + amount != before) revert InexactTransfer(token, amount, before - afterBal);
    }

    // ------------------------------------------------------------------
    // RULES AND VIEWS
    // ------------------------------------------------------------------

    /// The OpenZeppelin StandardMerkleTree leaf for
    /// ["address","address","uint256","uint256"] = [this, account, cum0, cum1].
    /// Binding this distributor into the leaf makes a proof useless anywhere
    /// else.
    function leafOf(address account, uint256 cum0, uint256 cum1) public view returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(address(this), account, cum0, cum1))));
    }

    /// What `account` could still take under a leaf (cum0, cum1).
    function claimable(address account, uint256 cum0, uint256 cum1) external view returns (uint256, uint256) {
        uint256 p0 = paid0[account];
        uint256 p1 = paid1[account];
        return (cum0 > p0 ? cum0 - p0 : 0, cum1 > p1 ? cum1 - p1 : 0);
    }

    /// Addresses that are never paid, checked here as well as off chain.
    function isExcluded(address account) external view returns (bool) {
        return _excluded(account, IHolderSharingSource(graduator).lockOf(launchToken));
    }

    function _excluded(address a, address lock) private view returns (bool) {
        return a == address(0) || a == DEAD || a == address(this) || a == launchToken || a == quoteToken
            || a == curve || a == hook || a == escrow || a == graduator || a == poolManager || a == positionManager
            || a == registry || a == factory || a == lock || IDistributorFactoryRoles(factory).isDistributor(a);
    }
}
