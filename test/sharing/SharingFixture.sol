// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {HolderDistributorFactory} from "../../src/curb/sharing/HolderDistributorFactory.sol";
import {HolderFeeDistributor} from "../../src/curb/sharing/HolderFeeDistributor.sol";
import {
    MockCurve, MockEscrow, MockHook, MockLock, MockRegistry, MockSharingGraduator, MockWETH9, LaunchRecords, Tok
} from "./SharingMocks.sol";
import {MerkleBuilder} from "./MerkleBuilder.sol";

/// One mocked CURB core, one distributor factory, and helpers to build
/// launches, roots, trees and payouts.
abstract contract SharingFixture is Test {
    address internal constant WETH = 0x4200000000000000000000000000000000000006;

    MockRegistry internal reg;
    MockSharingGraduator internal grad;
    HolderDistributorFactory internal fac;

    address internal owner = address(0x5AFE);
    address internal publisher = address(0x9B);
    /// A bare hash, so it holds nothing on the Base fork either (0x4E holds
    /// a wei there, and a test reads this address's balance).
    address internal keeperPayee = address(uint160(uint256(keccak256("curb.sharing.fixture.keeperPayee"))));
    address internal guardian = address(0x6A);
    address internal creator = address(0xC0FFEE);
    address internal pm = address(0x0b4A);
    address internal posm = address(0x0b4B);

    struct L {
        address token;
        address quote;
        MockCurve curve;
        MockEscrow escrow;
        MockHook hook;
        HolderFeeDistributor d;
    }

    struct Alloc {
        address a;
        uint256 c0;
        uint256 c1;
    }

    function setUp() public virtual {
        vm.etch(WETH, type(MockWETH9).runtimeCode);
        vm.label(WETH, "WETH");
        reg = new MockRegistry();
        grad = new MockSharingGraduator(address(reg), pm, posm);
        address[] memory vetoers = new address[](2);
        vetoers[0] = guardian;
        vetoers[1] = owner;
        fac = new HolderDistributorFactory(address(reg), address(grad), owner, publisher, keeperPayee, vetoers);
        vm.roll(100);
        vm.warp(1_000_000);
    }

    // ------------------------------------------------------------ launches

    function _newLaunch(address quote) internal returns (L memory l) {
        return _newLaunchWithToken(quote, address(new Tok("LAUNCH", 18)));
    }

    function _newLaunchWithToken(address quote, address token) internal returns (L memory l) {
        l.quote = quote;
        l.token = token;
        l.escrow = new MockEscrow();
        l.hook = new MockHook();
        l.curve = new MockCurve(address(grad), l.escrow, creator, IERC20(quote));
        reg.set(l.token, LaunchRecords.make(address(l.curve), quote, creator, address(l.hook)));
    }

    function _enable(L memory l) internal returns (HolderFeeDistributor d) {
        d = HolderFeeDistributor(payable(grad.enable(l.token, address(fac))));
        l.d = d;
    }

    function _sharingLaunch(address quote) internal returns (L memory l) {
        l = _newLaunch(quote);
        _enable(l);
        vm.roll(vm.getBlockNumber() + 5);
    }

    function _graduate(L memory l) internal returns (MockLock lock) {
        lock = new MockLock(grad, l.token, creator, IERC20(l.quote), IERC20(l.token));
        grad.graduate(l.token, address(lock));
    }

    // ------------------------------------------------------------ money

    function _fund0(L memory l, uint256 a) internal {
        if (l.quote == WETH) {
            vm.deal(address(this), a);
            (bool ok,) = address(l.d).call{value: a}("");
            require(ok, "fund eth");
        } else {
            Tok(l.quote).mint(address(l.d), a);
        }
    }

    function _fund1(L memory l, uint256 a) internal {
        Tok(l.token).mint(address(l.d), a);
    }

    /// What `a` holds of asset 0 (ETH + WETH on a WETH launch).
    function _bal0(L memory l, address a) internal view returns (uint256) {
        if (l.quote == WETH) return a.balance + IERC20(WETH).balanceOf(a);
        return IERC20(l.quote).balanceOf(a);
    }

    function _bal1(L memory l, address a) internal view returns (uint256) {
        return IERC20(l.token).balanceOf(a);
    }

    // ------------------------------------------------------------ roots

    function _activeRoot(HolderFeeDistributor d) internal view returns (HolderFeeDistributor.Root memory r) {
        (r.merkleRoot, r.contentHash, r.cumHolders0, r.cumHolders1, r.cumKeeper0, r.fromBlock, r.toBlock, r.epoch, r.payableAt)
        = d.active();
    }

    function _pendingRoot(HolderFeeDistributor d) internal view returns (HolderFeeDistributor.Root memory r) {
        (r.merkleRoot, r.contentHash, r.cumHolders0, r.cumHolders1, r.cumKeeper0, r.fromBlock, r.toBlock, r.epoch, r.payableAt)
        = d.pending();
    }

    /// The next valid root header for `d`: next epoch number, the contiguous
    /// range up to the previous block.
    function _next(HolderFeeDistributor d, bytes32 mroot, uint256 h0, uint256 h1, uint256 k0)
        internal
        view
        returns (HolderFeeDistributor.Root memory r)
    {
        HolderFeeDistributor.Root memory a = _activeRoot(d);
        // a ripe pending root is promoted by the publish itself
        HolderFeeDistributor.Root memory p = _pendingRoot(d);
        if (p.payableAt != 0 && vm.getBlockTimestamp() >= p.payableAt) a = p;
        r.merkleRoot = mroot;
        r.contentHash = keccak256(abi.encode("file", d.lastProposedEpoch() + 1));
        r.cumHolders0 = uint128(h0);
        r.cumHolders1 = uint128(h1);
        r.cumKeeper0 = uint128(k0);
        r.fromBlock = a.epoch == 0 ? grad.sharingSince(d.launchToken()) : a.toBlock + 1;
        r.toBlock = uint64(vm.getBlockNumber() - 1);
        r.epoch = d.lastProposedEpoch() + 1;
    }

    function _publish(HolderFeeDistributor d, HolderFeeDistributor.Root memory r) internal {
        vm.prank(publisher);
        fac.publish(address(d), r, "ipfs://epoch");
    }

    function _ripen() internal {
        vm.warp(vm.getBlockTimestamp() + 1 hours);
    }

    // ------------------------------------------------------------ trees

    function _hashes(HolderFeeDistributor d, Alloc[] memory al) internal view returns (bytes32[] memory h) {
        h = new bytes32[](al.length);
        for (uint256 i; i < al.length; ++i) {
            h[i] = d.leafOf(al[i].a, al[i].c0, al[i].c1);
        }
    }

    function _tree(HolderFeeDistributor d, Alloc[] memory al) internal view returns (MerkleBuilder.Tree memory) {
        return MerkleBuilder.build(_hashes(d, al));
    }

    function _sum(Alloc[] memory al) internal pure returns (uint256 s0, uint256 s1) {
        for (uint256 i; i < al.length; ++i) {
            s0 += al[i].c0;
            s1 += al[i].c1;
        }
    }

    /// Publishes a root over `al` (header = the leaves' sums, plus `k0`
    /// cumulative keeper fee) and ripens it.
    function _publishAlloc(HolderFeeDistributor d, Alloc[] memory al, uint256 k0)
        internal
        returns (MerkleBuilder.Tree memory t)
    {
        t = _tree(d, al);
        (uint256 s0, uint256 s1) = _sum(al);
        _publish(d, _next(d, MerkleBuilder.root(t), s0, s1, k0));
        _ripen();
    }

    function _pushIdx(HolderFeeDistributor d, Alloc[] memory al, MerkleBuilder.Tree memory t, uint256[] memory idx)
        internal
    {
        (HolderFeeDistributor.Leaf[] memory ls, bytes32[] memory p, bool[] memory f) = _batch(al, t, idx);
        d.push(ls, p, f);
    }

    function _batch(Alloc[] memory al, MerkleBuilder.Tree memory t, uint256[] memory idx)
        internal
        pure
        returns (HolderFeeDistributor.Leaf[] memory ls, bytes32[] memory p, bool[] memory f)
    {
        uint256[] memory order;
        (order, p, f) = MerkleBuilder.multiProof(t, idx);
        ls = new HolderFeeDistributor.Leaf[](order.length);
        for (uint256 i; i < order.length; ++i) {
            Alloc memory x = al[order[i]];
            ls[i] = HolderFeeDistributor.Leaf(x.a, x.c0, x.c1);
        }
    }

    function _pushAll(HolderFeeDistributor d, Alloc[] memory al, MerkleBuilder.Tree memory t) internal {
        uint256[] memory idx = new uint256[](al.length);
        for (uint256 i; i < al.length; ++i) {
            idx[i] = i;
        }
        _pushIdx(d, al, t, idx);
    }

    function _claim(HolderFeeDistributor d, Alloc[] memory al, MerkleBuilder.Tree memory t, uint256 i, address to)
        internal
    {
        bytes32[] memory p = MerkleBuilder.proof(t, i);
        vm.prank(al[i].a);
        d.claim(al[i].c0, al[i].c1, p, to);
    }

    function _two(address a, uint256 a0, uint256 a1, address b, uint256 b0, uint256 b1)
        internal
        pure
        returns (Alloc[] memory al)
    {
        al = new Alloc[](2);
        al[0] = Alloc(a, a0, a1);
        al[1] = Alloc(b, b0, b1);
    }

    receive() external payable {}
}
