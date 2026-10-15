// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {HolderDistributorFactory} from "../../src/curb/sharing/HolderDistributorFactory.sol";
import {HolderFeeDistributor} from "../../src/curb/sharing/HolderFeeDistributor.sol";
import {SharingFixture} from "./SharingFixture.sol";
import {MerkleBuilder} from "./MerkleBuilder.sol";
import {BlockingTok, EthRefuser, MockEscrow, MockHook, Tok} from "./SharingMocks.sol";

/// Drives one distributor through random sequences of income, publish
/// (honest and dishonest), veto, activate, push, claim, payKeeper, issuer
/// blocks and time - and the factory's roles: freeze, the announced unfreeze,
/// publisher rotation and revocation, keeper payee rotation and cancellation,
/// each landing before, at, inside or past its 48-hour delay and 7-day window -
/// keeping its own model of what must hold.
contract DistributorHandler is Test {
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    uint256 internal constant N = 6;
    /// HolderDistributorFactory's ROLE_DELAY and ROLE_WINDOW, written out so a
    /// change there is a change the model has to be told about.
    uint256 internal constant ROLE_DELAY = 48 hours;
    uint256 internal constant ROLE_WINDOW = 7 days;
    address internal constant STRANGER = address(0xBAD);

    HolderFeeDistributor public d;
    HolderDistributorFactory public fac;
    address public publisher;
    address public guardian;
    address public keeperPayee;
    address public owner;
    address public quote;
    Tok public launch;
    MockHook public hook;
    MockEscrow public escrow;
    bool public weth;
    uint64 public since;

    address[N] public accounts;
    address[2] public alts;
    address public excludedHolder;

    // ---- model of the roots
    struct Head {
        uint32 epoch;
        bytes32 root;
        uint128 h0;
        uint128 h1;
        uint128 k0;
        uint64 fromBlock;
        uint64 toBlock;
        uint40 payableAt;
    }

    Head public act; // the active root as last seen
    Head public pend; // the pending root as published, while havePending
    bool public havePending;
    uint256[N] public actC0;
    uint256[N] public actC1;
    uint256[N] public pendC0;
    uint256[N] public pendC1;
    bytes32[] internal actNodes;
    uint256[] internal actIdx;
    bytes32[] internal pendNodes;
    uint256[] internal pendIdx;
    mapping(uint32 => bool) public vetoed;
    uint32 public lastEpoch;

    // ---- violations seen by the handler (each must stay 0)
    uint256 public badAccepted; // a publish the rules refuse went through
    uint256 public goodRefused; // a publish the rules allow was refused
    uint256 public pendingReplaced; // I5
    uint256 public i3Broken; // epochs, ranges, monotone totals
    uint256 public i4Broken; // keeper fee above 2% of an epoch
    uint256 public i5Broken; // a root active before its time, or a vetoed one
    uint256 public overpaid; // a single payout above what the leaf allowed
    uint256 public roleBroken; // I7: a role moved against its rules, or a move they allow was refused
    uint256 public vetoRefused; // I5: a vetoer's veto the rules allow was refused
    uint256 public keeperMisrouted; // I7: the keeper fee reached other than the current payee

    // ---- model of the factory's roles, as it must hold them
    bool public frozen;
    uint64 public unfreezeAt; // the factory's pendingUnfreezeAt
    address public curPublisher; // zero once revoked
    address public formerPublisher; // one it had before, which must now be refused
    address public nextPublisher;
    uint64 public publisherAt; // the factory's pendingPublisherAt
    /// EVERY KEEPER PAYEE THE FACTORY CAN BE GIVEN: the fixture's, then two
    /// bare hashes (they hold nothing on a Base fork either). I6 sums what
    /// left over all those it has had, and holds the others to zero.
    address[3] public payees;
    bool[3] public payeeHad;
    uint256 public curPayee; // an index into payees
    uint256 public nextPayee;
    uint64 public payeeAt; // the factory's pendingKeeperPayeeAt

    // ---- counters, to see the fuzzer reaching things
    uint256 public nPublished;
    uint256 public nVetoed;
    uint256 public nActivated;
    uint256 public nPushes;
    uint256 public nClaims;
    uint256 public nFrozen;
    uint256 public nUnfrozen;
    uint256 public nPublisherRotations;
    uint256 public nRevoked;
    uint256 public nPayeeRotations;
    uint256 public nCancelled;
    uint256 public nRoleRefusals; // a move the rules refuse, refused
    uint256 public nPaidWhileFrozen; // a push or claim that paid while frozen
    uint256 public nLateVetoes; // a veto past the hour, which only a freeze allows

    constructor(
        HolderFeeDistributor d_,
        HolderDistributorFactory fac_,
        address publisher_,
        address guardian_,
        address keeperPayee_,
        address owner_,
        Tok launch_,
        MockHook hook_,
        MockEscrow escrow_,
        address excluded_
    ) {
        d = d_;
        fac = fac_;
        publisher = publisher_;
        guardian = guardian_;
        keeperPayee = keeperPayee_;
        owner = owner_;
        curPublisher = publisher_;
        payees[0] = keeperPayee_;
        payees[1] = address(uint160(uint256(keccak256("curb.invariants.keeperPayee.1"))));
        payees[2] = address(uint160(uint256(keccak256("curb.invariants.keeperPayee.2"))));
        payeeHad[0] = true;
        quote = d_.quoteToken();
        weth = quote == WETH;
        launch = launch_;
        hook = hook_;
        escrow = escrow_;
        excludedHolder = excluded_;
        for (uint256 i; i < 4; ++i) {
            accounts[i] = address(uint160(0xA0000 + i));
        }
        accounts[4] = weth ? address(new EthRefuser()) : address(0xB10C);
        accounts[5] = excluded_;
        alts[0] = address(0xA17000);
        alts[1] = address(0xA17001);
    }

    function setSince(uint64 s) external {
        since = s;
        clock = vm.getBlockTimestamp();
        height = vm.getBlockNumber();
    }

    // The handler keeps its own clock: the invariant runner does not carry a
    // warp or roll from one call to the next, so every action starts from it.
    uint256 public clock;
    uint256 public height;

    modifier timed() {
        vm.warp(clock);
        vm.roll(height);
        _;
        clock = vm.getBlockTimestamp();
        height = vm.getBlockNumber();
    }

    // ================================================================ helpers

    function bal0(address a) public view returns (uint256) {
        if (weth) return a.balance + IERC20(WETH).balanceOf(a);
        return IERC20(quote).balanceOf(a);
    }

    function bal1(address a) public view returns (uint256) {
        return launch.balanceOf(a);
    }

    function _readActive() internal view returns (Head memory h) {
        (h.root,, h.h0, h.h1, h.k0, h.fromBlock, h.toBlock, h.epoch, h.payableAt) = d.active();
    }

    function _readPending() internal view returns (Head memory h) {
        (h.root,, h.h0, h.h1, h.k0, h.fromBlock, h.toBlock, h.epoch, h.payableAt) = d.pending();
    }

    /// Follows the contract's active root and checks every move it made.
    function _sync() internal {
        Head memory a = _readActive();
        if (a.epoch != act.epoch) {
            nActivated++;
            // it must be the root we saw published, unvetoed, after its time
            if (!havePending || a.epoch != pend.epoch || a.root != pend.root) i5Broken++;
            if (vetoed[a.epoch]) i5Broken++;
            if (a.payableAt > vm.getBlockTimestamp()) i5Broken++;
            // and never while frozen: a freeze holds every pending root. No
            // action both changes the freeze and activates, so the model's
            // flag is the one the activation saw.
            if (frozen) i5Broken++;
            // I3: contiguous, increasing, monotone
            if (a.epoch <= act.epoch) i3Broken++;
            uint64 wantFrom = act.epoch == 0 ? since : act.toBlock + 1;
            if (a.fromBlock != wantFrom || a.toBlock < a.fromBlock) i3Broken++;
            if (a.h0 < act.h0 || a.h1 < act.h1 || a.k0 < act.k0) i3Broken++;
            // I4
            uint256 dK = a.k0 - act.k0;
            uint256 dH = a.h0 - act.h0;
            if (dK * 10_000 > (dH + dK) * 200) i4Broken++;
            act = a;
            for (uint256 i; i < N; ++i) {
                actC0[i] = pendC0[i];
                actC1[i] = pendC1[i];
            }
            actNodes = pendNodes;
            actIdx = pendIdx;
            havePending = false;
        }
        if (havePending) {
            Head memory p = _readPending();
            if (p.payableAt == 0 && !vetoed[pend.epoch]) pendingReplaced++;
            if (p.payableAt != 0 && (p.epoch != pend.epoch || p.root != pend.root || p.payableAt != pend.payableAt)) {
                pendingReplaced++;
            }
        }
    }

    /// Activates a ripe pending root - or, while frozen, sees activate refuse
    /// it. Calling activate regardless, as this did before freezes were
    /// fuzzed, would revert every push and claim made while frozen, and the
    /// active root paying through a freeze would go untried.
    function _ripeNow() internal {
        Head memory p = _readPending();
        if (p.payableAt != 0 && vm.getBlockTimestamp() >= p.payableAt) {
            if (frozen) {
                try d.activate() {
                    i5Broken++;
                } catch {}
            } else {
                d.activate();
            }
        }
        _sync();
    }

    /// THE ROLE ACTIONS' SEED, HASHED. The fuzzer favours edge values - zero
    /// and the all-ones word above all - and both land on a rare branch of a
    /// `seed % 16` (a freeze, a cancellation, a revocation), which made those
    /// several times as frequent as written and left most of a run frozen.
    /// Hashed, each branch comes up as often as its modulus says.
    function _mix(uint256 seed) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(seed, "curb.invariants.roles")));
    }

    /// A publisher the fixture never named: a bare hash, like the payees.
    function _otherPublisher(uint256 k) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encode("curb.invariants.publisher", k)))));
    }

    /// Whether an announcement made for `at` may be executed now.
    function _ripe(uint256 at) internal view returns (bool) {
        uint256 t = vm.getBlockTimestamp();
        return at != 0 && t >= at && t <= at + ROLE_WINDOW;
    }

    /// Whether an announcement for `at` has run out its window, so the owner
    /// must announce again.
    function _lapsed(uint256 at) internal view returns (bool) {
        return at == 0 || vm.getBlockTimestamp() > at + ROLE_WINDOW;
    }

    /// Moves the clock toward an announced change, by `seed`: to one second
    /// short of it, to it exactly, somewhere inside its window (twice as
    /// often), or one second past the window - so each boundary is tried both
    /// ways, and three tries in five may execute. Never backwards (a clock
    /// already past the point stays where it is); blocks advance with the
    /// time, as `warp` does.
    function _toward(uint256 at, uint256 seed) internal {
        uint256 m = seed % 5;
        uint256 t;
        if (m == 0) t = at - 1;
        else if (m == 1) t = at;
        else if (m == 4) t = at + ROLE_WINDOW + 1;
        else t = at + (seed >> 8) % (ROLE_WINDOW + 1);
        uint256 nowT = vm.getBlockTimestamp();
        if (t <= nowT) return;
        vm.warp(t);
        vm.roll(vm.getBlockNumber() + 1 + (t - nowT) / 2);
    }

    function _tree(uint256[N] memory c0, uint256[N] memory c1) internal view returns (MerkleBuilder.Tree memory) {
        bytes32[] memory h = new bytes32[](N);
        for (uint256 i; i < N; ++i) {
            h[i] = d.leafOf(accounts[i], c0[i], c1[i]);
        }
        return MerkleBuilder.build(h);
    }

    function _actTree() internal view returns (MerkleBuilder.Tree memory t) {
        t.nodes = actNodes;
        t.indexOf = actIdx;
    }

    // ================================================================ actions

    function income(uint256 a0, uint256 a1, uint8 via) external timed {
        a0 = bound(a0, 0, 1e24);
        a1 = bound(a1, 0, 1e24);
        if (via % 3 == 0 || weth && via % 3 == 1) {
            // direct: a donation, a lock push, a rescue, a hook direct take
            if (weth) {
                vm.deal(address(this), a0);
                (bool ok,) = address(d).call{value: a0}("");
                require(ok);
            } else {
                Tok(quote).mint(address(d), a0);
            }
        } else if (!weth && via % 3 == 1) {
            // credited to the escrow, then harvested
            Tok(quote).mint(address(this), a0);
            Tok(quote).approve(address(escrow), a0);
            if (a0 != 0) escrow.creditToken(address(d), quote, a0);
            d.harvest();
        } else {
            // owed by the hook, then harvested
            if (weth) {
                vm.deal(address(this), a0);
                (bool ok,) = WETH.call{value: a0}("");
                require(ok);
                IERC20(WETH).transfer(address(hook), a0);
            } else {
                Tok(quote).mint(address(hook), a0);
            }
            if (a0 != 0) hook.accrueOwed(address(d), quote, a0);
            d.harvest();
        }
        launch.mint(address(d), a1);
        _sync();
    }

    function publish(uint256 seed, uint8 mode) external timed {
        vm.roll(vm.getBlockNumber() + 1 + (seed % 5));
        _ripeNow();
        Head memory a = act;
        uint256 avail0 = d.received0() - a.h0 - a.k0;
        uint256 avail1 = d.received1() - a.h1;
        uint256 alloc0 = avail0 * (seed % 101) / 100;
        uint256 alloc1 = avail1 * ((seed >> 8) % 101) / 100;
        uint256 k = alloc0 * 200 / 10_000 * ((seed >> 16) % 101) / 100;
        uint256 h = alloc0 - k;

        uint256[N] memory c0;
        uint256[N] memory c1;
        uint256 s0;
        uint256 s1;
        {
            uint256[N] memory w;
            uint256 wsum;
            for (uint256 i; i < N; ++i) {
                w[i] = uint256(keccak256(abi.encode(seed, i))) % 1000;
                wsum += w[i];
            }
            for (uint256 i; i < N; ++i) {
                uint256 x0 = wsum == 0 ? 0 : h * w[i] / wsum;
                uint256 x1 = wsum == 0 ? 0 : alloc1 * w[i] / wsum;
                c0[i] = actC0[i] + x0;
                c1[i] = actC1[i] + x1;
                s0 += x0;
                s1 += x1;
            }
        }
        // the spec's re-cap: the fee never exceeds 2% of what the leaves hold
        if (k * 9_800 > s0 * 200) k = s0 * 200 / 9_800;
        MerkleBuilder.Tree memory t = _tree(c0, c1);
        HolderFeeDistributor.Root memory r;
        r.merkleRoot = MerkleBuilder.root(t);
        r.contentHash = keccak256(abi.encode(seed));
        r.cumHolders0 = uint128(a.h0 + s0);
        r.cumHolders1 = uint128(a.h1 + s1);
        r.cumKeeper0 = uint128(a.k0 + k);
        r.fromBlock = a.epoch == 0 ? since : a.toBlock + 1;
        r.toBlock = uint64(vm.getBlockNumber() - 1);
        r.epoch = lastEpoch + 1;

        // WHO SENDS IT: the current publisher, now and then the one it had
        // before (refused once rotated away or revoked). With the publisher
        // revoked, only a former one is left to try.
        address who = curPublisher;
        if (
            who == address(0)
                || ((seed >> 24) % 16 == 0 && formerPublisher != address(0) && formerPublisher != curPublisher)
        ) {
            who = formerPublisher != address(0) ? formerPublisher : publisher;
        }
        // Only the current publisher, never while frozen, never over a pending root.
        bool expectOk = !havePending && !frozen && who == curPublisher && who != address(0);
        // mostly honest roots; 1..6 are the dishonest shapes
        uint8 m = mode % 14;
        if (m > 7) m = 0;
        if (m == 1) {
            r.cumHolders0 = uint128(avail0 + a.h0 + 1); // more than received
            r.cumKeeper0 = a.k0;
            expectOk = false;
        } else if (m == 2) {
            r.cumKeeper0 = uint128(a.k0 + (s0 * 200) / 9_800 + 1); // one wei above 2%
            expectOk = false;
        } else if (m == 3) {
            r.epoch = lastEpoch + 2; // skips a number
            expectOk = false;
        } else if (m == 4) {
            r.fromBlock = r.fromBlock + 1; // leaves a gap
            expectOk = false;
        } else if (m == 5 && a.h0 > 0) {
            r.cumHolders0 = a.h0 - 1; // shrinks
            expectOk = false;
        } else if (m == 6 && s0 > 1 && s1 > 1) {
            // leaves that sum to more than the header: allowed to publish,
            // and the payouts must stop at the header
            r.cumHolders0 = uint128(a.h0 + s0 / 2);
            r.cumKeeper0 = a.k0;
            r.cumHolders1 = uint128(a.h1 + s1 / 2);
        } else if (m == 7) {
            r.cumHolders1 = uint128(avail1 + a.h1 + 1); // more launch token than received
            expectOk = false;
        }
        vm.prank(who);
        try fac.publish(address(d), r, "ipfs://fuzz") {
            if (!expectOk) badAccepted++;
            nPublished++;
            lastEpoch = r.epoch;
            havePending = true;
            pend = Head(
                r.epoch,
                r.merkleRoot,
                r.cumHolders0,
                r.cumHolders1,
                r.cumKeeper0,
                r.fromBlock,
                r.toBlock,
                uint40(vm.getBlockTimestamp() + 1 hours)
            );
            for (uint256 i; i < N; ++i) {
                pendC0[i] = c0[i];
                pendC1[i] = c1[i];
            }
            pendNodes = t.nodes;
            pendIdx = t.indexOf;
        } catch {
            if (expectOk) goodRefused++;
        }
        _sync();
    }

    function veto(uint256 seed) external timed {
        Head memory p = _readPending();
        bool inTime = p.payableAt != 0 && vm.getBlockTimestamp() < p.payableAt;
        // A FROZEN FACTORY HOLDS THE ROOT, so it stays vetoable past its hour.
        bool vetoable = p.payableAt != 0 && (inTime || frozen);
        // the guardian vetoes now and then; a stranger tries as often
        if (seed % 4 > 1) return;
        bool byGuardian = seed % 4 == 0;
        vm.prank(byGuardian ? guardian : STRANGER);
        try fac.veto(address(d), p.epoch, "fuzz") {
            if (!vetoable || !byGuardian) i5Broken++;
            if (!inTime) nLateVetoes++;
            vetoed[p.epoch] = true;
            havePending = false;
            nVetoed++;
        } catch {
            if (vetoable && byGuardian) vetoRefused++;
        }
        _sync();
    }

    function warp(uint256 secs) external timed {
        secs = bound(secs, 0, 3 hours);
        vm.warp(vm.getBlockTimestamp() + secs);
        vm.roll(vm.getBlockNumber() + 1 + secs / 2);
        _sync();
    }

    function activate() external timed {
        try d.activate() {} catch {}
        _sync();
    }

    function push(uint256 mask) external timed {
        _ripeNow();
        if (act.epoch == 0) return;
        uint256 n;
        for (uint256 i; i < N; ++i) {
            if (mask >> i & 1 == 1) n++;
        }
        if (n == 0) return;
        uint256[] memory idx = new uint256[](n);
        n = 0;
        for (uint256 i; i < N; ++i) {
            if (mask >> i & 1 == 1) idx[n++] = i;
        }
        (uint256[] memory order, bytes32[] memory p, bool[] memory f) = MerkleBuilder.multiProof(_actTree(), idx);
        HolderFeeDistributor.Leaf[] memory ls = new HolderFeeDistributor.Leaf[](order.length);
        uint256[N] memory before0;
        uint256[N] memory before1;
        uint256[N] memory paidBefore0;
        uint256[N] memory paidBefore1;
        for (uint256 i; i < N; ++i) {
            before0[i] = bal0(accounts[i]);
            before1[i] = bal1(accounts[i]);
            paidBefore0[i] = d.paid0(accounts[i]);
            paidBefore1[i] = d.paid1(accounts[i]);
        }
        for (uint256 i; i < order.length; ++i) {
            uint256 j = order[i];
            ls[i] = HolderFeeDistributor.Leaf(accounts[j], actC0[j], actC1[j]);
        }
        try d.push(ls, p, f) {
            nPushes++;
            if (frozen) nPaidWhileFrozen++;
            for (uint256 i; i < N; ++i) {
                uint256 g0 = bal0(accounts[i]) - before0[i];
                uint256 g1 = bal1(accounts[i]) - before1[i];
                uint256 o0 = actC0[i] > paidBefore0[i] ? actC0[i] - paidBefore0[i] : 0;
                uint256 o1 = actC1[i] > paidBefore1[i] ? actC1[i] - paidBefore1[i] : 0;
                if (g0 > o0 || g1 > o1) overpaid++;
                if (g0 != d.paid0(accounts[i]) - paidBefore0[i]) overpaid++;
                if (g1 != d.paid1(accounts[i]) - paidBefore1[i]) overpaid++;
            }
        } catch {}
        _sync();
    }

    function claim(uint256 who, uint256 toSel) external timed {
        _ripeNow();
        if (act.epoch == 0) return;
        uint256 i = who % N;
        address to = toSel % 3 == 2 ? address(0) : alts[toSel % 3 == 0 ? 0 : 1];
        address recv = to == address(0) ? accounts[i] : to;
        bytes32[] memory p = MerkleBuilder.proof(_actTree(), i);
        uint256 b0 = bal0(recv);
        uint256 b1 = bal1(recv);
        uint256 pb0 = d.paid0(accounts[i]);
        uint256 pb1 = d.paid1(accounts[i]);
        vm.prank(accounts[i]);
        try d.claim(actC0[i], actC1[i], p, to) {
            nClaims++;
            if (frozen) nPaidWhileFrozen++;
            uint256 g0 = bal0(recv) - b0;
            uint256 g1 = bal1(recv) - b1;
            if (g0 != actC0[i] - pb0 && actC0[i] > pb0) overpaid++;
            if (g1 != actC1[i] - pb1 && actC1[i] > pb1) overpaid++;
            if (accounts[i] == excludedHolder) overpaid++;
        } catch {}
        _sync();
    }

    /// The fee goes to the payee the factory names NOW - all of what was paid,
    /// and nothing to any payee it had before or may have later.
    function payKeeper() external timed {
        uint256[3] memory before;
        for (uint256 i; i < 3; ++i) {
            before[i] = bal0(payees[i]);
        }
        uint256 paidBefore = d.keeperPaid0();
        try d.payKeeper() {} catch {}
        uint256 paidNow = d.keeperPaid0() - paidBefore;
        for (uint256 i; i < 3; ++i) {
            uint256 gained = bal0(payees[i]) - before[i];
            if (gained != (i == curPayee ? paidNow : 0)) keeperMisrouted++;
        }
        _sync();
    }

    // ================================================================ roles

    /// A FREEZE TAKES EFFECT AT ONCE, by a vetoer or the owner; a stranger's
    /// is refused. RARE ON PURPOSE: one call in thirty-two freezes (and one
    /// in thirty-two is a stranger's try). A freeze lasts until an
    /// announcement has waited out 48 hours - a few dozen calls - and nothing
    /// is published meanwhile. Measured on four seeds: at one in four most of
    /// a run was frozen, and it published a root or two where the handler
    /// without roles published five to nine.
    function freeze(uint256 seed) external timed {
        seed = _mix(seed);
        uint256 m = seed % 32;
        if (m > 1) return;
        address by = m == 1 ? STRANGER : (seed >> 2) % 2 == 0 ? guardian : owner;
        vm.prank(by);
        try fac.freeze() {
            if (by == STRANGER) roleBroken++;
            if (!frozen) nFrozen++;
            frozen = true;
            // AND IT CANCELS AN UNFREEZE ALREADY ANNOUNCED, so the owner has
            // to announce again and wait 48 hours from then.
            unfreezeAt = 0;
        } catch {
            if (by != STRANGER) roleBroken++;
            else nRoleRefusals++;
        }
        _sync();
    }

    /// A FREEZE ENDS ONLY THROUGH ITS ANNOUNCEMENT: the owner announces it -
    /// only while frozen - and anyone executes it from 48 hours on, within
    /// the 7-day window. A lapsed announcement is announced again.
    function unfreeze(uint256 seed) external timed {
        seed = _mix(seed);
        if (_lapsed(unfreezeAt)) {
            address by = seed % 8 == 7 ? STRANGER : owner;
            vm.prank(by);
            try fac.announceUnfreeze() {
                if (by == STRANGER || !frozen) roleBroken++;
                unfreezeAt = uint64(vm.getBlockTimestamp() + ROLE_DELAY);
            } catch {
                if (by == owner && frozen) roleBroken++;
                else nRoleRefusals++;
            }
        } else {
            _toward(unfreezeAt, seed >> 3);
            bool ok = _ripe(unfreezeAt);
            try fac.unfreeze() {
                if (!ok) roleBroken++;
                unfreezeAt = 0;
                frozen = false;
                nUnfrozen++;
            } catch {
                if (ok) roleBroken++;
                else nRoleRefusals++;
            }
        }
        _sync();
    }

    /// THE PUBLISHER ROTATES ONLY THROUGH ITS ANNOUNCEMENT, executed from 48
    /// hours on, within the window, and never while frozen - a freeze holds a
    /// rotation as it holds roots. The owner may revoke it at once (one call
    /// in sixty-four: a revoked publisher stops every root until a successor
    /// has waited out its delay).
    function rotatePublisher(uint256 seed) external timed {
        seed = _mix(seed);
        uint256 m = seed % 8;
        if (seed % 64 == 63) {
            vm.prank(owner);
            fac.revokePublisher();
            if (curPublisher != address(0)) formerPublisher = curPublisher;
            curPublisher = address(0);
            nextPublisher = address(0);
            publisherAt = 0;
            nRevoked++;
        } else if (_lapsed(publisherAt)) {
            // the current one, the original, or one never named before
            uint256 k = (seed >> 3) % 3;
            address next = k == 0 ? publisher : _otherPublisher(k);
            address by = m == 6 ? STRANGER : owner;
            vm.prank(by);
            try fac.announcePublisher(next) {
                if (by == STRANGER) roleBroken++;
                nextPublisher = next;
                publisherAt = uint64(vm.getBlockTimestamp() + ROLE_DELAY);
            } catch {
                if (by == owner) roleBroken++;
                else nRoleRefusals++;
            }
        } else {
            _toward(publisherAt, seed >> 3);
            bool ok = _ripe(publisherAt) && !frozen;
            try fac.executePublisher() {
                if (!ok) roleBroken++;
                if (curPublisher != address(0) && curPublisher != nextPublisher) formerPublisher = curPublisher;
                curPublisher = nextPublisher;
                nextPublisher = address(0);
                publisherAt = 0;
                nPublisherRotations++;
            } catch {
                if (ok) roleBroken++;
                else nRoleRefusals++;
            }
        }
        _sync();
    }

    /// THE KEEPER PAYEE ROTATES ONLY THROUGH ITS ANNOUNCEMENT, executed from
    /// 48 hours on, within the window. The owner may cancel every announced
    /// change at once - payee, publisher and unfreeze together.
    function rotatePayee(uint256 seed) external timed {
        seed = _mix(seed);
        uint256 m = seed % 8;
        if (seed % 16 == 15) {
            vm.prank(owner);
            fac.cancelPending();
            nextPublisher = address(0);
            publisherAt = 0;
            payeeAt = 0;
            unfreezeAt = 0;
            nCancelled++;
        } else if (_lapsed(payeeAt)) {
            uint256 k = (seed >> 3) % 3;
            address by = m == 6 ? STRANGER : owner;
            vm.prank(by);
            try fac.announceKeeperPayee(payees[k]) {
                if (by == STRANGER) roleBroken++;
                nextPayee = k;
                payeeAt = uint64(vm.getBlockTimestamp() + ROLE_DELAY);
            } catch {
                if (by == owner) roleBroken++;
                else nRoleRefusals++;
            }
        } else {
            _toward(payeeAt, seed >> 3);
            bool ok = _ripe(payeeAt);
            try fac.executeKeeperPayee() {
                if (!ok) roleBroken++;
                curPayee = nextPayee;
                payeeHad[nextPayee] = true;
                payeeAt = 0;
                nPayeeRotations++;
            } catch {
                if (ok) roleBroken++;
                else nRoleRefusals++;
            }
        }
        _sync();
    }

    function toggleBlock(uint256 who) external timed {
        if (weth) return;
        address a = who % 3 == 0 ? accounts[4] : who % 3 == 1 ? alts[0] : accounts[0];
        BlockingTok(quote).setBlocked(a, !BlockingTok(quote).blocked(a));
    }

    receive() external payable {}
}

/// I1-I7 over the handler's random sequences.
///
/// DEPTH 300, WHERE IT WAS 150 BEFORE THE ROLE ACTIONS. Four more actions share
/// the calls, and a freeze or a revoked publisher stops roots for a few dozen
/// of them. Measured by the last run's counters on six fuzz seeds: about five
/// roots published and three and a half activated per run, where the handler
/// without roles, at 150, published six to seven and activated about four.
abstract contract DistributorInvariantsBase is SharingFixture {
    DistributorHandler internal h;
    L internal l;

    function _quote() internal virtual returns (address);

    function setUp() public override {
        super.setUp();
        L memory m = _newLaunch(_quote());
        _enable(m);
        l = m;
        uint64 since = grad.sharingSince(l.token);
        vm.roll(vm.getBlockNumber() + 3);
        h = new DistributorHandler(l.d, fac, publisher, guardian, keeperPayee, owner, Tok(l.token), l.hook, l.escrow, pm);
        h.setSince(since);
        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](13);
        sel[0] = DistributorHandler.income.selector;
        sel[1] = DistributorHandler.publish.selector;
        sel[2] = DistributorHandler.veto.selector;
        sel[3] = DistributorHandler.warp.selector;
        sel[4] = DistributorHandler.activate.selector;
        sel[5] = DistributorHandler.push.selector;
        sel[6] = DistributorHandler.claim.selector;
        sel[7] = DistributorHandler.payKeeper.selector;
        sel[8] = DistributorHandler.toggleBlock.selector;
        sel[9] = DistributorHandler.freeze.selector;
        sel[10] = DistributorHandler.unfreeze.selector;
        sel[11] = DistributorHandler.rotatePublisher.selector;
        sel[12] = DistributorHandler.rotatePayee.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
        // ONE FIXED CALLER, A BARE HASH. The handler pranks whoever each action
        // needs, so the fuzzer's own msg.sender means nothing here - but left
        // random it is a new address on every call, and on a Base fork every
        // new address is a round trip to the fork's upstream: this suite never
        // finished in fork mode. No key signs for this address, so it holds
        // nothing on any chain.
        targetSender(address(uint160(uint256(keccak256("curb.invariants.sender")))));
    }

    function _active() internal view returns (HolderFeeDistributor.Root memory) {
        return _activeRoot(l.d);
    }

    /// I1: paid <= active totals <= received, per asset.
    function invariant_I1_neverPaysMoreThanDeclared_neverDeclaresMoreThanReceived() public view {
        HolderFeeDistributor d = l.d;
        HolderFeeDistributor.Root memory a = _active();
        assertLe(d.totalPaid0(), a.cumHolders0, "holders paid <= declared");
        assertLe(d.keeperPaid0(), a.cumKeeper0, "keeper paid <= declared");
        assertLe(uint256(a.cumHolders0) + a.cumKeeper0, d.received0(), "declared <= received (0)");
        assertLe(d.totalPaid1(), a.cumHolders1, "holders paid <= declared (1)");
        assertLe(a.cumHolders1, d.received1(), "declared <= received (1)");
    }

    /// I2: no account is paid beyond its leaf, the ledger adds up, and a payout
    ///     never exceeded what the leaf still allowed.
    function invariant_I2_paidNeverExceedsTheLeaf() public view {
        HolderFeeDistributor d = l.d;
        uint256 s0;
        uint256 s1;
        for (uint256 i; i < 6; ++i) {
            address a = h.accounts(i);
            assertLe(d.paid0(a), h.actC0(i), "paid0 <= cum0");
            assertLe(d.paid1(a), h.actC1(i), "paid1 <= cum1");
            s0 += d.paid0(a);
            s1 += d.paid1(a);
        }
        assertEq(s0, d.totalPaid0(), "the ledger adds up (0)");
        assertEq(s1, d.totalPaid1(), "the ledger adds up (1)");
        assertEq(h.overpaid(), 0, "no single payout above its leaf");
    }

    /// I3: monotone roots, epochs one by one, contiguous ranges.
    function invariant_I3_rootsAreMonotoneAndContiguous() public view {
        assertEq(h.i3Broken(), 0);
        assertEq(l.d.lastProposedEpoch(), h.lastEpoch());
        HolderFeeDistributor.Root memory a = _active();
        assertLe(a.epoch, l.d.lastProposedEpoch());
    }

    /// I4: the keeper fee is at most 2% of every epoch's gross new quote.
    function invariant_I4_keeperFeeWithinTwoPercent() public view {
        assertEq(h.i4Broken(), 0);
        HolderFeeDistributor.Root memory a = _active();
        // and in total, too
        assertLe(uint256(a.cumKeeper0) * 10_000, (uint256(a.cumHolders0) + a.cumKeeper0) * 200);
    }

    /// I5: nothing active before its time or while frozen, nothing vetoed
    ///     ever active, a pending root vetoable inside its hour and for as long
    ///     as a freeze holds it, no pending root replaced, no publish the rules
    ///     refuse accepted - a former publisher's, or any while frozen.
    function invariant_I5_vetoWindowAndNoReplacement() public view {
        assertEq(h.i5Broken(), 0, "timing / veto");
        assertEq(h.vetoRefused(), 0, "a veto the rules allow was refused");
        assertEq(h.pendingReplaced(), 0, "a pending root was replaced");
        assertEq(h.badAccepted(), 0, "a refused publish went through");
        assertEq(h.goodRefused(), 0, "an allowed publish was refused");
        HolderFeeDistributor.Root memory a = _active();
        assertLe(a.payableAt, vm.getBlockTimestamp());
        assertFalse(h.vetoed(a.epoch) && a.epoch != 0);
    }

    /// I6: money left only to leaf accounts, the addresses they named, and the
    ///     keeper payees the factory has had; infrastructure got nothing. The
    ///     keeper's side is summed over EVERY payee the factory has had, so a
    ///     fee paid to a payee rotated away still counts, and a payee it was
    ///     never given holds nothing.
    function invariant_I6_onlyHoldersAndTheKeeperArePaid() public view {
        HolderFeeDistributor d = l.d;
        uint256 out0;
        uint256 out1;
        for (uint256 i; i < 6; ++i) {
            out0 += h.bal0(h.accounts(i));
            out1 += h.bal1(h.accounts(i));
        }
        out0 += h.bal0(h.alts(0)) + h.bal0(h.alts(1));
        out1 += h.bal1(h.alts(0)) + h.bal1(h.alts(1));
        for (uint256 i; i < 3; ++i) {
            address k = h.payees(i);
            if (h.payeeHad(i)) out0 += h.bal0(k);
            else assertEq(h.bal0(k), 0, "a payee the factory never had was paid");
            assertEq(h.bal1(k), 0, "the keeper takes only quote");
        }
        assertEq(out0, d.totalPaid0() + d.keeperPaid0(), "every quote unit out went to a holder or the keeper");
        assertEq(out1, d.totalPaid1(), "every launch token out went to a holder");
        assertEq(h.bal0(pm), 0, "an excluded holder is never paid");
        assertEq(h.bal1(pm), 0);
        assertEq(d.received0(), h.bal0(address(d)) + d.totalPaid0() + d.keeperPaid0());
    }

    /// I7: the factory's roles moved only by their rules - a freeze at once
    ///     and only by a vetoer or the owner; an unfreeze, a publisher and a
    ///     keeper payee only through an announcement executed from 48 hours
    ///     on and within its 7-day window, the publisher never while frozen;
    ///     every announcement the owner's alone - and every move those rules
    ///     allow went through. The keeper fee went to the payee of the moment.
    ///     And the factory holds exactly what the handler expects.
    function invariant_I7_rolesMoveOnlyByTheirRules() public view {
        assertEq(h.roleBroken(), 0, "a role moved against its rules, or a move they allow was refused");
        assertEq(h.keeperMisrouted(), 0, "the keeper fee reached other than the current payee");
        assertEq(fac.frozen(), h.frozen(), "frozen");
        assertEq(fac.publisher(), h.curPublisher(), "publisher");
        assertEq(fac.keeperPayee(), h.payees(h.curPayee()), "keeper payee");
        assertEq(fac.pendingUnfreezeAt(), h.unfreezeAt(), "announced unfreeze");
        assertEq(fac.pendingPublisherAt(), h.publisherAt(), "announced publisher");
        assertEq(fac.pendingPublisher(), h.nextPublisher(), "announced publisher address");
        assertEq(fac.pendingKeeperPayeeAt(), h.payeeAt(), "announced keeper payee");
    }

    function afterInvariant() external {
        emit log_named_uint("published", h.nPublished());
        emit log_named_uint("vetoed", h.nVetoed());
        emit log_named_uint("activated", h.nActivated());
        emit log_named_uint("pushes", h.nPushes());
        emit log_named_uint("claims", h.nClaims());
        emit log_named_uint("frozen", h.nFrozen());
        emit log_named_uint("unfrozen", h.nUnfrozen());
        emit log_named_uint("publisher rotations", h.nPublisherRotations());
        emit log_named_uint("publisher revocations", h.nRevoked());
        emit log_named_uint("payee rotations", h.nPayeeRotations());
        emit log_named_uint("cancellations", h.nCancelled());
        emit log_named_uint("role moves refused by the rules", h.nRoleRefusals());
        emit log_named_uint("payouts while frozen", h.nPaidWhileFrozen());
        emit log_named_uint("vetoes past the hour (frozen)", h.nLateVetoes());
    }
}

/// forge-config: default.invariant.runs = 128
/// forge-config: default.invariant.depth = 300
contract DistributorInvariantsWethTest is DistributorInvariantsBase {
    function _quote() internal pure override returns (address) {
        return WETH;
    }
}

/// forge-config: default.invariant.runs = 128
/// forge-config: default.invariant.depth = 300
contract DistributorInvariantsBlockingQuoteTest is DistributorInvariantsBase {
    function _quote() internal override returns (address) {
        return address(new BlockingTok());
    }
}
