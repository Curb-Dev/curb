// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {HolderDistributorFactory} from "../../src/curb/sharing/HolderDistributorFactory.sol";
import {HolderFeeDistributor} from "../../src/curb/sharing/HolderFeeDistributor.sol";
import {SharingFixture} from "./SharingFixture.sol";
import {MockSharingGraduator, Tok} from "./SharingMocks.sol";

/// The factory's roles: freeze, revoke, vetoers and the 48 hour rotations.
contract HolderDistributorFactoryTest is SharingFixture {
    address alice = address(0xA11CE);
    address nextPublisher = address(0xC0C);
    Tok quote;
    L l;

    function setUp() public override {
        super.setUp();
        quote = new Tok("QUOTE", 18);
        l = _sharingLaunch(address(quote));
        _fund0(l, 1_000_000);
    }

    function _try(address who) internal returns (bool ok) {
        HolderFeeDistributor.Root memory r = _next(l.d, bytes32(uint256(1)), 1000, 0, 0);
        vm.prank(who);
        try fac.publish(address(l.d), r, "") {
            ok = true;
        } catch {}
    }

    // ------------------------------------------------------------ constructor

    function test_constructorSetsRolesAtOnce() public view {
        assertEq(fac.owner(), owner);
        assertEq(fac.publisher(), publisher);
        assertEq(fac.keeperPayee(), keeperPayee);
        assertTrue(fac.isVetoer(guardian));
        assertTrue(fac.isVetoer(owner));
        assertFalse(fac.isVetoer(publisher));
        assertEq(fac.registry(), address(reg));
        assertEq(fac.graduator(), address(grad));
        assertFalse(fac.frozen());
    }

    function test_constructorRefusesZeroesAndAForeignRegistry() public {
        address[] memory v = new address[](0);
        vm.expectRevert(HolderDistributorFactory.ZeroAddress.selector);
        new HolderDistributorFactory(address(0), address(grad), owner, publisher, keeperPayee, v);
        vm.expectRevert(HolderDistributorFactory.ZeroAddress.selector);
        new HolderDistributorFactory(address(reg), address(0), owner, publisher, keeperPayee, v);
        vm.expectRevert(HolderDistributorFactory.ZeroAddress.selector);
        new HolderDistributorFactory(address(reg), address(grad), owner, address(0), keeperPayee, v);
        vm.expectRevert(HolderDistributorFactory.ZeroAddress.selector);
        new HolderDistributorFactory(address(reg), address(grad), owner, publisher, address(0), v);
        // a graduator reading another registry
        MockSharingGraduator g2 = new MockSharingGraduator(address(0xBEEF), pm, posm);
        vm.expectRevert(
            abi.encodeWithSelector(HolderDistributorFactory.RegistryMismatch.selector, address(reg), address(0xBEEF))
        );
        new HolderDistributorFactory(address(reg), address(g2), owner, publisher, keeperPayee, v);
        address[] memory zeroVetoer = new address[](1);
        vm.expectRevert(HolderDistributorFactory.ZeroAddress.selector);
        new HolderDistributorFactory(address(reg), address(grad), owner, publisher, keeperPayee, zeroVetoer);
    }

    // ------------------------------------------------------------ freeze

    function test_freezeByTheOwnerOrAVetoer_unfreezeOnlyAfterAnAnnouncement() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(HolderDistributorFactory.NotAVetoer.selector, alice));
        fac.freeze();
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(HolderDistributorFactory.NotAVetoer.selector, publisher));
        fac.freeze();

        vm.expectEmit(true, false, false, false, address(fac));
        emit HolderDistributorFactory.Frozen(guardian);
        vm.prank(guardian);
        fac.freeze();
        assertTrue(fac.frozen());
        HolderFeeDistributor.Root memory r = _next(l.d, bytes32(uint256(1)), 1000, 0, 0);
        vm.prank(publisher);
        vm.expectRevert(HolderDistributorFactory.PublishingFrozen.selector);
        fac.publish(address(l.d), r, "");

        // nobody unfreezes at once, the owner included
        vm.prank(owner);
        vm.expectRevert(HolderDistributorFactory.NothingAnnounced.selector);
        fac.unfreeze();
        // a vetoer cannot announce it
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        fac.announceUnfreeze();

        uint64 at = uint64(vm.getBlockTimestamp()) + 48 hours;
        vm.expectEmit(false, false, false, true, address(fac));
        emit HolderDistributorFactory.UnfreezeAnnounced(at);
        vm.prank(owner);
        fac.announceUnfreeze();
        assertEq(fac.pendingUnfreezeAt(), at);
        vm.warp(at - 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(HolderDistributorFactory.ChangeNotReady.selector, at));
        fac.unfreeze();
        assertTrue(fac.frozen());

        // ripe: anyone may execute it
        vm.warp(at);
        vm.expectEmit(false, false, false, false, address(fac));
        emit HolderDistributorFactory.Unfrozen();
        vm.prank(alice);
        fac.unfreeze();
        assertFalse(fac.frozen());
        assertEq(fac.pendingUnfreezeAt(), 0);
        assertTrue(_try(publisher));

        // the announcement is spent: a second freeze needs a second one
        vm.prank(guardian);
        fac.freeze();
        vm.prank(owner);
        vm.expectRevert(HolderDistributorFactory.NothingAnnounced.selector);
        fac.unfreeze();
        assertTrue(fac.frozen());
    }

    /// An unfreeze announced while nothing is frozen would be ripe the moment
    /// a vetoer froze, and undo that freeze at once.
    function test_anUnfreezeCannotBeArmedAheadOfAFreeze() public {
        vm.prank(owner);
        vm.expectRevert(HolderDistributorFactory.NotFrozen.selector);
        fac.announceUnfreeze();
        assertEq(fac.pendingUnfreezeAt(), 0);
        vm.warp(vm.getBlockTimestamp() + 48 hours);
        vm.prank(guardian);
        fac.freeze();
        vm.prank(owner);
        vm.expectRevert(HolderDistributorFactory.NothingAnnounced.selector);
        fac.unfreeze();
        assertTrue(fac.frozen());
    }

    function test_anUnfreezeExpiresAfterItsWindow_andCancelPendingDropsIt() public {
        vm.prank(guardian);
        fac.freeze();
        vm.prank(owner);
        fac.announceUnfreeze();
        uint64 at = uint64(vm.getBlockTimestamp()) + 48 hours;
        vm.warp(at + 7 days + 1);
        vm.expectRevert(abi.encodeWithSelector(HolderDistributorFactory.ChangeExpired.selector, at + 7 days));
        fac.unfreeze();

        vm.prank(owner);
        fac.announceUnfreeze();
        vm.prank(owner);
        fac.cancelPending();
        assertEq(fac.pendingUnfreezeAt(), 0);
        vm.warp(vm.getBlockTimestamp() + 48 hours);
        vm.expectRevert(HolderDistributorFactory.NothingAnnounced.selector);
        fac.unfreeze();
        assertTrue(fac.frozen());
    }

    function test_theOwnerMayFreezeWithoutBeingAVetoer() public {
        vm.prank(owner);
        fac.announceVetoerRemoval(owner);
        vm.warp(vm.getBlockTimestamp() + 48 hours);
        fac.removeVetoer(owner);
        assertFalse(fac.isVetoer(owner));
        vm.prank(owner);
        fac.freeze();
        assertTrue(fac.frozen());
    }

    /// A freeze holds a publisher rotation as it holds roots: a vetoer that
    /// freezes on the announcement keeps the old publisher in place until an
    /// unfreeze, announced in its turn, has waited out its own 48 hours.
    function test_aRotationIsNotExecutedWhileFrozen() public {
        vm.prank(owner);
        fac.announcePublisher(nextPublisher);
        vm.prank(guardian);
        fac.freeze();
        vm.warp(vm.getBlockTimestamp() + 48 hours);
        vm.expectRevert(HolderDistributorFactory.PublishingFrozen.selector);
        fac.executePublisher();
        assertEq(fac.publisher(), publisher);
        vm.prank(owner);
        fac.announceUnfreeze();
        vm.warp(vm.getBlockTimestamp() + 48 hours);
        fac.unfreeze();
        fac.executePublisher();
        assertEq(fac.publisher(), nextPublisher);
    }

    function test_freezeAlsoStopsPublishMany() public {
        vm.prank(guardian);
        fac.freeze();
        address[] memory ds = new address[](1);
        ds[0] = address(l.d);
        HolderFeeDistributor.Root[] memory rs = new HolderFeeDistributor.Root[](1);
        rs[0] = _next(l.d, bytes32(uint256(1)), 1000, 0, 0);
        string[] memory us = new string[](1);
        vm.prank(publisher);
        vm.expectRevert(HolderDistributorFactory.PublishingFrozen.selector);
        fac.publishMany(ds, rs, us);
    }

    // ------------------------------------------------------------ revoke

    function test_revokeIsImmediate_andCancelsAnAnnouncedSuccessor() public {
        vm.prank(owner);
        fac.announcePublisher(nextPublisher);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        fac.revokePublisher();
        vm.expectEmit(true, false, false, false, address(fac));
        emit HolderDistributorFactory.PublisherRevoked(publisher);
        vm.prank(owner);
        fac.revokePublisher();
        assertEq(fac.publisher(), address(0));
        assertEq(fac.pendingPublisher(), address(0));
        assertEq(fac.pendingPublisherAt(), 0);
        assertFalse(_try(publisher));
        vm.warp(vm.getBlockTimestamp() + 48 hours);
        vm.expectRevert(HolderDistributorFactory.NothingAnnounced.selector);
        fac.executePublisher();
    }

    // ------------------------------------------------------------ rotation

    function test_publisherRotationTakes48Hours_andExpiresAfterItsWindow() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        fac.announcePublisher(nextPublisher);
        vm.prank(owner);
        vm.expectRevert(HolderDistributorFactory.ZeroAddress.selector);
        fac.announcePublisher(address(0));

        uint64 at = uint64(vm.getBlockTimestamp()) + 48 hours;
        vm.expectEmit(true, false, false, true, address(fac));
        emit HolderDistributorFactory.PublisherAnnounced(nextPublisher, at);
        vm.prank(owner);
        fac.announcePublisher(nextPublisher);
        assertEq(fac.pendingPublisher(), nextPublisher);
        assertEq(fac.pendingPublisherAt(), at);

        vm.warp(at - 1);
        vm.expectRevert(abi.encodeWithSelector(HolderDistributorFactory.ChangeNotReady.selector, at));
        fac.executePublisher();
        assertEq(fac.publisher(), publisher);

        // ripe: anyone may execute
        vm.warp(at);
        vm.prank(alice);
        fac.executePublisher();
        assertEq(fac.publisher(), nextPublisher);
        assertEq(fac.pendingPublisher(), address(0));
        assertEq(fac.pendingPublisherAt(), 0);

        // a second announcement left past its window expires
        vm.prank(owner);
        fac.announcePublisher(alice);
        uint64 at2 = uint64(vm.getBlockTimestamp()) + 48 hours;
        vm.warp(at2 + 7 days);
        fac.executePublisher(); // the last second of the window still works
        assertEq(fac.publisher(), alice);
        vm.prank(owner);
        fac.announcePublisher(publisher);
        uint64 at3 = uint64(vm.getBlockTimestamp()) + 48 hours;
        vm.warp(at3 + 7 days + 1);
        vm.expectRevert(abi.encodeWithSelector(HolderDistributorFactory.ChangeExpired.selector, at3 + 7 days));
        fac.executePublisher();
        assertEq(fac.publisher(), alice);
    }

    function test_theNewPublisherPublishes_theOldOneNoLonger() public {
        vm.prank(owner);
        fac.announcePublisher(nextPublisher);
        vm.warp(vm.getBlockTimestamp() + 48 hours);
        fac.executePublisher();
        assertFalse(_try(publisher));
        assertTrue(_try(nextPublisher));
    }

    function test_keeperPayeeRotationTakes48Hours() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        fac.announceKeeperPayee(alice);
        vm.prank(owner);
        vm.expectRevert(HolderDistributorFactory.ZeroAddress.selector);
        fac.announceKeeperPayee(address(0));
        vm.prank(owner);
        fac.announceKeeperPayee(alice);
        uint64 at = uint64(vm.getBlockTimestamp()) + 48 hours;
        assertEq(fac.pendingKeeperPayeeAt(), at);
        vm.warp(at - 1);
        vm.expectRevert(abi.encodeWithSelector(HolderDistributorFactory.ChangeNotReady.selector, at));
        fac.executeKeeperPayee();
        vm.warp(at + 7 days + 1);
        vm.expectRevert(abi.encodeWithSelector(HolderDistributorFactory.ChangeExpired.selector, at + 7 days));
        fac.executeKeeperPayee();
        vm.prank(owner);
        fac.announceKeeperPayee(alice);
        vm.warp(vm.getBlockTimestamp() + 48 hours);
        fac.executeKeeperPayee();
        assertEq(fac.keeperPayee(), alice);
        assertEq(fac.pendingKeeperPayee(), address(0));
        vm.expectRevert(HolderDistributorFactory.NothingAnnounced.selector);
        fac.executeKeeperPayee();
    }

    function test_cancelPendingDropsBothAnnouncements() public {
        vm.startPrank(owner);
        fac.announcePublisher(nextPublisher);
        fac.announceKeeperPayee(alice);
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        fac.cancelPending();
        vm.prank(owner);
        fac.cancelPending();
        vm.warp(vm.getBlockTimestamp() + 48 hours);
        vm.expectRevert(HolderDistributorFactory.NothingAnnounced.selector);
        fac.executePublisher();
        vm.expectRevert(HolderDistributorFactory.NothingAnnounced.selector);
        fac.executeKeeperPayee();
        assertEq(fac.publisher(), publisher);
        assertEq(fac.keeperPayee(), keeperPayee);
    }

    // ------------------------------------------------------------ vetoers

    function test_addVetoerIsOwnerOnlyAndAtOnce() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        fac.addVetoer(alice);
        vm.prank(owner);
        vm.expectRevert(HolderDistributorFactory.ZeroAddress.selector);
        fac.addVetoer(address(0));
        vm.expectEmit(true, false, false, true, address(fac));
        emit HolderDistributorFactory.VetoerSet(alice, true);
        vm.prank(owner);
        fac.addVetoer(alice);
        assertTrue(fac.isVetoer(alice));
        // a vetoer it named can veto, in the same block
        _publish(l.d, _next(l.d, bytes32(uint256(1)), 1000, 0, 0));
        vm.prank(alice);
        fac.veto(address(l.d), 1, "x");
        assertEq(_pendingRoot(l.d).payableAt, 0);
    }

    function test_removingAVetoerTakes48Hours_andExpiresAfterItsWindow() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        fac.announceVetoerRemoval(guardian);

        uint64 at = uint64(vm.getBlockTimestamp()) + 48 hours;
        vm.expectEmit(true, false, false, true, address(fac));
        emit HolderDistributorFactory.VetoerRemovalAnnounced(guardian, at);
        vm.prank(owner);
        fac.announceVetoerRemoval(guardian);
        assertEq(fac.vetoerRemovalAt(guardian), at);
        // not at once, the owner included
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(HolderDistributorFactory.ChangeNotReady.selector, at));
        fac.removeVetoer(guardian);
        vm.warp(at - 1);
        vm.expectRevert(abi.encodeWithSelector(HolderDistributorFactory.ChangeNotReady.selector, at));
        fac.removeVetoer(guardian);
        // still a vetoer the whole time
        assertTrue(fac.isVetoer(guardian));
        vm.roll(vm.getBlockNumber() + 2);
        _publish(l.d, _next(l.d, bytes32(uint256(1)), 1000, 0, 0));
        vm.prank(guardian);
        fac.veto(address(l.d), 1, "still here");

        // ripe and past every veto hour: anyone executes it
        vm.warp(at + 1 hours);
        vm.expectEmit(true, false, false, true, address(fac));
        emit HolderDistributorFactory.VetoerSet(guardian, false);
        vm.prank(alice);
        fac.removeVetoer(guardian);
        assertFalse(fac.isVetoer(guardian));
        assertEq(fac.vetoerRemovalAt(guardian), 0);
        vm.roll(vm.getBlockNumber() + 2);
        _publish(l.d, _next(l.d, bytes32(uint256(2)), 1000, 0, 0));
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(HolderDistributorFactory.NotAVetoer.selector, guardian));
        fac.veto(address(l.d), 2, "x");
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(HolderDistributorFactory.NotAVetoer.selector, guardian));
        fac.freeze();
        // and the removal is spent
        vm.expectRevert(HolderDistributorFactory.NothingAnnounced.selector);
        fac.removeVetoer(guardian);

        // an announcement left past its window expires
        vm.prank(owner);
        fac.announceVetoerRemoval(owner);
        uint64 at2 = uint64(vm.getBlockTimestamp()) + 48 hours;
        vm.warp(at2 + 7 days + 1);
        vm.expectRevert(abi.encodeWithSelector(HolderDistributorFactory.ChangeExpired.selector, at2 + 7 days));
        fac.removeVetoer(owner);
        assertTrue(fac.isVetoer(owner));
    }

    /// Every root published while an account is a vetoer gets its whole hour:
    /// a removal that is ripe waits until no root relayed here can still be
    /// vetoed.
    function test_aVetoerIsNotRemovedWhileARootIsInsideItsHour() public {
        vm.prank(owner);
        fac.announceVetoerRemoval(guardian);
        uint64 at = uint64(vm.getBlockTimestamp()) + 48 hours;
        vm.warp(at - 1 minutes);
        _publish(l.d, _next(l.d, bytes32(uint256(1)), 1000, 0, 0));
        uint64 until = uint64(vm.getBlockTimestamp()) + 1 hours;
        assertEq(fac.vetoableUntil(), until);
        assertEq(_pendingRoot(l.d).payableAt, until, "the factory's hour is the distributor's");

        vm.warp(at);
        vm.expectRevert(abi.encodeWithSelector(HolderDistributorFactory.RootsStillVetoable.selector, until));
        fac.removeVetoer(guardian);
        vm.warp(until - 1);
        vm.expectRevert(abi.encodeWithSelector(HolderDistributorFactory.RootsStillVetoable.selector, until));
        fac.removeVetoer(guardian);
        // so the guardian still vetoes in the last second of the hour
        vm.prank(guardian);
        fac.veto(address(l.d), 1, "mismatch");

        // a publishMany moves the hour on as well
        L memory l2 = _sharingLaunch(address(quote));
        _fund0(l2, 500);
        address[] memory ds = new address[](1);
        ds[0] = address(l2.d);
        HolderFeeDistributor.Root[] memory rs = new HolderFeeDistributor.Root[](1);
        rs[0] = _next(l2.d, bytes32(uint256(2)), 500, 0, 0);
        string[] memory us = new string[](1);
        vm.prank(publisher);
        fac.publishMany(ds, rs, us);
        uint64 until2 = uint64(vm.getBlockTimestamp()) + 1 hours;
        assertEq(fac.vetoableUntil(), until2);
        vm.warp(until);
        vm.expectRevert(abi.encodeWithSelector(HolderDistributorFactory.RootsStillVetoable.selector, until2));
        fac.removeVetoer(guardian);

        vm.warp(until2);
        fac.removeVetoer(guardian);
        assertFalse(fac.isVetoer(guardian));
    }

    function test_addingAVetoerAgainCancelsItsAnnouncedRemoval() public {
        vm.prank(owner);
        fac.announceVetoerRemoval(guardian);
        vm.prank(owner);
        fac.addVetoer(guardian);
        assertEq(fac.vetoerRemovalAt(guardian), 0);
        vm.warp(vm.getBlockTimestamp() + 48 hours);
        vm.expectRevert(HolderDistributorFactory.NothingAnnounced.selector);
        fac.removeVetoer(guardian);
        assertTrue(fac.isVetoer(guardian));
    }

    function test_vetoManyVetoesEveryRootOfABatch_allOrNothing() public {
        L memory l2 = _sharingLaunch(address(quote));
        L memory l3 = _sharingLaunch(address(quote));
        _fund0(l2, 500);
        _fund0(l3, 500);
        address[] memory ds = new address[](3);
        ds[0] = address(l.d);
        ds[1] = address(l2.d);
        ds[2] = address(l3.d);
        HolderFeeDistributor.Root[] memory rs = new HolderFeeDistributor.Root[](3);
        rs[0] = _next(l.d, bytes32(uint256(1)), 1000, 0, 0);
        rs[1] = _next(l2.d, bytes32(uint256(2)), 500, 0, 0);
        rs[2] = _next(l3.d, bytes32(uint256(3)), 500, 0, 0);
        string[] memory us = new string[](3);
        vm.prank(publisher);
        fac.publishMany(ds, rs, us);
        uint32[] memory es = new uint32[](3);
        es[0] = 1;
        es[1] = 1;
        es[2] = 1;

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(HolderDistributorFactory.NotAVetoer.selector, alice));
        fac.vetoMany(ds, es, "x");
        uint32[] memory short = new uint32[](2);
        vm.prank(guardian);
        vm.expectRevert(HolderDistributorFactory.LengthMismatch.selector);
        fac.vetoMany(ds, short, "x");
        address[] memory bad = new address[](3);
        bad[0] = address(l.d);
        bad[1] = alice;
        bad[2] = address(l3.d);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(HolderDistributorFactory.UnknownDistributor.selector, alice));
        fac.vetoMany(bad, es, "x");

        // one entry that cannot be vetoed undoes the batch
        uint32[] memory wrong = new uint32[](3);
        wrong[0] = 1;
        wrong[1] = 1;
        wrong[2] = 2;
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(HolderFeeDistributor.NoSuchPending.selector, 2));
        fac.vetoMany(ds, wrong, "x");
        assertGt(_pendingRoot(l.d).payableAt, 0, "the first veto of a failed batch is undone");

        vm.prank(guardian);
        fac.vetoMany(ds, es, "mismatch");
        assertEq(_pendingRoot(l.d).payableAt, 0);
        assertEq(_pendingRoot(l2.d).payableAt, 0);
        assertEq(_pendingRoot(l3.d).payableAt, 0);
    }

    // ------------------------------------------------------------ ownership

    function test_ownershipMovesInTwoSteps_andCannotBeRenounced() public {
        vm.prank(owner);
        vm.expectRevert(HolderDistributorFactory.OwnershipCannotBeRenounced.selector);
        fac.renounceOwnership();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        fac.renounceOwnership();
        vm.prank(owner);
        fac.transferOwnership(alice);
        assertEq(fac.owner(), owner);
        vm.prank(alice);
        fac.acceptOwnership();
        assertEq(fac.owner(), alice);
    }

    // ------------------------------------------------------------ publishMany

    function test_publishManyPublishesEach_andRefusesMismatchedLengths() public {
        L memory l2 = _sharingLaunch(address(quote));
        _fund0(l2, 500);
        address[] memory ds = new address[](2);
        ds[0] = address(l.d);
        ds[1] = address(l2.d);
        HolderFeeDistributor.Root[] memory rs = new HolderFeeDistributor.Root[](2);
        rs[0] = _next(l.d, bytes32(uint256(1)), 1000, 0, 0);
        rs[1] = _next(l2.d, bytes32(uint256(2)), 500, 0, 0);
        string[] memory us = new string[](2);
        us[0] = "ipfs://a";
        us[1] = "ipfs://b";
        string[] memory short = new string[](1);
        vm.prank(publisher);
        vm.expectRevert(HolderDistributorFactory.LengthMismatch.selector);
        fac.publishMany(ds, rs, short);
        HolderFeeDistributor.Root[] memory rshort = new HolderFeeDistributor.Root[](1);
        vm.prank(publisher);
        vm.expectRevert(HolderDistributorFactory.LengthMismatch.selector);
        fac.publishMany(ds, rshort, us);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(HolderDistributorFactory.NotThePublisher.selector, alice));
        fac.publishMany(ds, rs, us);
        vm.prank(publisher);
        fac.publishMany(ds, rs, us);
        assertEq(_pendingRoot(l.d).merkleRoot, bytes32(uint256(1)));
        assertEq(_pendingRoot(l2.d).merkleRoot, bytes32(uint256(2)));
        // one bad entry undoes the batch
        address[] memory bad = new address[](1);
        bad[0] = alice;
        HolderFeeDistributor.Root[] memory r1 = new HolderFeeDistributor.Root[](1);
        string[] memory u1 = new string[](1);
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(HolderDistributorFactory.UnknownDistributor.selector, alice));
        fac.publishMany(bad, r1, u1);
    }
}
