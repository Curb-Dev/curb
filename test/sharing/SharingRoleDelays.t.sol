// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {HolderDistributorFactory} from "../../src/curb/sharing/HolderDistributorFactory.sol";
import {HolderFeeDistributor} from "../../src/curb/sharing/HolderFeeDistributor.sol";
import {SharingFixture} from "./SharingFixture.sol";
import {MerkleBuilder} from "./MerkleBuilder.sol";
import {Tok} from "./SharingMocks.sol";
import {Vm} from "forge-std/Vm.sol";

/// The attacks a review ran against the roles around a distributor, kept as
/// regressions. The owner (the platform Safe) holds the publisher key here;
/// the guardian is an independent vetoer. A root decides how unpaid shares
/// are split and the distributor checks only its totals, so the guardian is
/// what stands between the platform and those shares. Each test shows that
/// the guardian keeps its veto for as long as it was promised.
contract SharingRoleDelaysTest is SharingFixture {
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA201);
    address thief = address(0x7E1F);
    address evilPublisher = address(0xE7E7);
    Tok quote;
    L l;

    function setUp() public override {
        super.setUp();
        quote = new Tok("QUOTE", 18);
        l = _sharingLaunch(address(quote));
    }

    /// Epoch 1, honest: alice 40, bob 40, carol 18, keeper 2. Only bob is
    /// pushed; alice and carol accumulate.
    function _honestEpoch1() internal returns (Alloc[] memory al, MerkleBuilder.Tree memory t) {
        _fund0(l, 100e18);
        al = new Alloc[](3);
        al[0] = Alloc(alice, 40e18, 0);
        al[1] = Alloc(bob, 40e18, 0);
        al[2] = Alloc(carol, 18e18, 0);
        t = _publishAlloc(l.d, al, 2e18);
        l.d.activate();
        uint256[] memory idx = new uint256[](1);
        idx[0] = 1;
        _pushIdx(l.d, al, t, idx);
        assertEq(quote.balanceOf(bob), 40e18);
        assertEq(l.d.paid0(alice), 0);
    }

    /// The root that hands every unpaid share to the thief: the totals do not
    /// shrink, bob's paid leaf stays, alice and carol are dropped.
    function _evilEpoch(address pub) internal returns (uint32 epoch) {
        Alloc[] memory ev = _two(bob, 40e18, 0, thief, 58e18, 0);
        vm.roll(vm.getBlockNumber() + 2);
        HolderFeeDistributor.Root memory r = _next(l.d, MerkleBuilder.root(_tree(l.d, ev)), 98e18, 0, 2e18);
        vm.prank(pub);
        fac.publish(address(l.d), r, "ipfs://evil");
        epoch = l.d.lastProposedEpoch();
    }

    function _thiefTries() internal returns (bool ok) {
        Alloc[] memory ev = _two(bob, 40e18, 0, thief, 58e18, 0);
        MerkleBuilder.Tree memory te = _tree(l.d, ev);
        bytes32[] memory p = MerkleBuilder.proof(te, 1);
        vm.prank(thief);
        try l.d.claim(58e18, 0, p, thief) {
            ok = true;
        } catch {}
    }

    /// PATH 1, as the review ran it: the owner drops the guardian in the block
    /// its own publisher posts the theft root. The removal now has to be
    /// announced, so in that block the guardian is still a vetoer and the
    /// root is vetoed; alice then takes her share from the active root.
    function test_A1_theOwnerCannotDropTheGuardianInTheBlockOfATheftRoot() public {
        (Alloc[] memory al, MerkleBuilder.Tree memory t) = _honestEpoch1();

        vm.prank(owner);
        fac.announceVetoerRemoval(guardian);
        vm.expectRevert(
            abi.encodeWithSelector(HolderDistributorFactory.ChangeNotReady.selector, uint64(vm.getBlockTimestamp()) + 48 hours)
        );
        fac.removeVetoer(guardian);
        uint32 evil = _evilEpoch(publisher);

        vm.prank(guardian);
        fac.veto(address(l.d), evil, "mismatch");
        _ripen();
        assertFalse(_thiefTries(), "the vetoed theft root never pays");
        _claim(l.d, al, t, 0, address(0));
        assertEq(quote.balanceOf(alice), 40e18);
    }

    /// PATH 1b: the removal announced 48 hours ahead, and the theft root
    /// posted a minute before it ripens. The removal waits out the root's
    /// hour, so the guardian still vetoes it.
    function test_A1b_aRipeRemovalWaitsOutTheHourOfARootPostedJustBefore() public {
        _honestEpoch1();
        vm.prank(owner);
        fac.announceVetoerRemoval(guardian);
        uint64 at = uint64(vm.getBlockTimestamp()) + 48 hours;
        vm.warp(at - 1 minutes);
        uint32 evil = _evilEpoch(publisher);
        vm.warp(at);
        vm.expectRevert(
            abi.encodeWithSelector(HolderDistributorFactory.RootsStillVetoable.selector, uint64(at - 1 minutes + 1 hours))
        );
        fac.removeVetoer(guardian);
        vm.warp(at + 58 minutes);
        vm.prank(guardian);
        fac.veto(address(l.d), evil, "mismatch");
        _ripen();
        assertFalse(_thiefTries());
    }

    /// PATH 2, as the review ran it: a rotation to the owner's own key. The
    /// guardian freezes on the announcement. Forty-eight hours later the owner
    /// can execute none of the three things it executed in one block before:
    /// the rotation is held by the freeze, the unfreeze was never announced
    /// (and can only be announced now), and the guardian's removal was never
    /// announced either. The new publisher cannot post anything until both
    /// have waited out their own 48 hours, and the guardian is still a vetoer
    /// when it does.
    function test_A2_aRotationCannotUndoTheGuardiansFreezeOrVetoInOneBlock() public {
        _honestEpoch1();
        vm.startPrank(owner);
        fac.revokePublisher();
        fac.announcePublisher(evilPublisher);
        vm.stopPrank();
        vm.prank(guardian);
        fac.freeze();

        vm.warp(vm.getBlockTimestamp() + 48 hours);
        vm.roll(vm.getBlockNumber() + 10);
        vm.startPrank(owner);
        vm.expectRevert(HolderDistributorFactory.PublishingFrozen.selector);
        fac.executePublisher();
        vm.expectRevert(HolderDistributorFactory.NothingAnnounced.selector);
        fac.unfreeze();
        vm.expectRevert(HolderDistributorFactory.NothingAnnounced.selector);
        fac.removeVetoer(guardian);
        fac.announceUnfreeze();
        vm.stopPrank();

        // the soonest the owner can act: another 48 hours, still inside the
        // rotation's window, and the guardian is still a vetoer
        vm.warp(vm.getBlockTimestamp() + 48 hours);
        fac.unfreeze();
        fac.executePublisher();
        assertEq(fac.publisher(), evilPublisher);
        assertTrue(fac.isVetoer(guardian));
        uint32 evil = _evilEpoch(evilPublisher);
        vm.prank(guardian);
        fac.veto(address(l.d), evil, "mismatch");
        _ripen();
        assertFalse(_thiefTries());
    }

    /// CONTROL: what the delays are for. With the guardian's removal announced
    /// and waited out, nothing stops a theft root; the holders' defence is the
    /// 48 hours of notice, in which they can claim what the active root gives
    /// them. Alice does; carol does not.
    function test_A3_afterAnAnnouncedRemovalHoldersHadTheirNotice() public {
        (Alloc[] memory al, MerkleBuilder.Tree memory t) = _honestEpoch1();
        vm.prank(owner);
        fac.announceVetoerRemoval(guardian);
        vm.prank(owner);
        fac.announceVetoerRemoval(owner);
        // during the notice, alice claims
        _claim(l.d, al, t, 0, address(0));
        vm.warp(vm.getBlockTimestamp() + 48 hours);
        fac.removeVetoer(guardian);
        fac.removeVetoer(owner);
        // the root that drops alice and carol can no longer pay alice's 40
        // twice: the totals stop it
        _evilEpoch(publisher);
        _ripen();
        assertFalse(_thiefTries(), "alice's paid 40 cannot be paid again");
        // but a root that keeps alice and drops carol pays the thief carol's 18
        Alloc[] memory ev = new Alloc[](3);
        ev[0] = Alloc(alice, 40e18, 0);
        ev[1] = Alloc(bob, 40e18, 0);
        ev[2] = Alloc(thief, 18e18, 0);
        MerkleBuilder.Tree memory te = _tree(l.d, ev);
        vm.roll(vm.getBlockNumber() + 2);
        _publish(l.d, _next(l.d, MerkleBuilder.root(te), 98e18, 0, 2e18));
        _ripen();
        _claim(l.d, ev, te, 2, address(0));
        assertEq(quote.balanceOf(thief), 18e18, "carol, who did not claim in the notice, lost hers");
        assertEq(quote.balanceOf(alice), 40e18, "what alice was paid stays paid");
    }

    /// PATH 4, as the 2026-10-08 audit ran it: the factory is frozen and the
    /// owner has already announced the unfreeze. Forty hours in, the publisher
    /// key leaks and the guardian freezes again. That freeze used to change
    /// nothing - the old announcement still ripened eight hours later, and the
    /// thief unfroze and published in one block, leaving the guardian the
    /// plain veto hour instead of the 48 it froze for. The freeze now cancels
    /// the announcement: at the old ripe time there is nothing to execute, and
    /// the owner's next announcement waits its own 48 hours.
    function test_A4_aFreezeCancelsAnUnfreezeAlreadyAnnounced() public {
        _honestEpoch1();
        // a freeze with nothing announced cancels nothing and says nothing
        vm.recordLogs();
        vm.prank(owner);
        fac.freeze();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(
                logs[i].topics[0] != HolderDistributorFactory.UnfreezeCancelled.selector,
                "a freeze with no unfreeze announced reported cancelling one"
            );
        }
        vm.prank(owner);
        fac.announceUnfreeze();
        uint64 ripe = uint64(vm.getBlockTimestamp()) + 48 hours;
        assertEq(fac.pendingUnfreezeAt(), ripe);

        vm.warp(vm.getBlockTimestamp() + 40 hours);
        vm.expectEmit(true, false, false, true, address(fac));
        emit HolderDistributorFactory.UnfreezeCancelled(guardian);
        vm.prank(guardian);
        fac.freeze();
        assertEq(fac.pendingUnfreezeAt(), 0, "the announced unfreeze survived the freeze");

        vm.warp(ripe);
        vm.prank(thief);
        vm.expectRevert(HolderDistributorFactory.NothingAnnounced.selector);
        fac.unfreeze();
        assertTrue(fac.frozen(), "the factory unfroze");
        HolderFeeDistributor.Root memory r = _next(l.d, bytes32(uint256(1)), 98e18, 0, 2e18);
        vm.prank(publisher);
        vm.expectRevert(HolderDistributorFactory.PublishingFrozen.selector);
        fac.publish(address(l.d), r, "ipfs://evil");

        // the owner announces again, and the 48 hours run from now
        vm.prank(owner);
        fac.announceUnfreeze();
        assertEq(fac.pendingUnfreezeAt(), uint64(vm.getBlockTimestamp()) + 48 hours, "the new wait is not 48 hours");
    }

    /// B, as the review ran it: a stolen publisher key posts a theft root on
    /// three distributors in one publishMany; the guardian freezes and the
    /// owner revokes the key. The freeze now holds all three roots, and one
    /// vetoMany kills them.
    function test_B_aFreezeHoldsEveryRootAStolenKeyQueued() public {
        uint256 n = 3;
        L[] memory ls = new L[](n);
        ls[0] = l;
        for (uint256 i = 1; i < n; ++i) {
            ls[i] = _sharingLaunch(address(quote));
        }
        vm.roll(vm.getBlockNumber() + 3);
        address[] memory ds = new address[](n);
        HolderFeeDistributor.Root[] memory rs = new HolderFeeDistributor.Root[](n);
        string[] memory us = new string[](n);
        Alloc[] memory ev = _two(thief, 98e18, 0, alice, 0, 0);
        MerkleBuilder.Tree[] memory ts = new MerkleBuilder.Tree[](n);
        for (uint256 i; i < n; ++i) {
            _fund0(ls[i], 100e18);
            ds[i] = address(ls[i].d);
            ts[i] = _tree(ls[i].d, ev);
            rs[i] = _next(ls[i].d, MerkleBuilder.root(ts[i]), 98e18, 0, 2e18);
        }
        vm.prank(publisher);
        fac.publishMany(ds, rs, us);

        vm.prank(guardian);
        fac.freeze();
        vm.prank(owner);
        fac.revokePublisher();

        _ripen();
        _ripen();
        for (uint256 i; i < n; ++i) {
            vm.expectRevert(HolderFeeDistributor.Frozen.selector);
            ls[i].d.activate();
            bytes32[] memory p = MerkleBuilder.proof(ts[i], 0);
            vm.prank(thief);
            vm.expectRevert(HolderFeeDistributor.NoActiveRoot.selector);
            ls[i].d.claim(98e18, 0, p, thief);
        }
        uint32[] memory es = new uint32[](n);
        for (uint256 i; i < n; ++i) {
            es[i] = 1;
        }
        vm.prank(guardian);
        fac.vetoMany(ds, es, "stolen key");
        for (uint256 i; i < n; ++i) {
            assertEq(_pendingRoot(ls[i].d).payableAt, 0);
        }
        assertEq(quote.balanceOf(thief), 0);
    }
}
