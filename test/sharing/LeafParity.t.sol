// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

import {HolderFeeDistributor} from "../../src/curb/sharing/HolderFeeDistributor.sol";
import {SharingFixture} from "./SharingFixture.sol";
import {MerkleBuilder} from "./MerkleBuilder.sol";
import {ChunkedMerkle} from "./ChunkedMerkle.sol";
import {Tok} from "./SharingMocks.sol";

/// @notice Parity with the TypeScript side (CURB-SHARE v1 golden vectors in
///         services/sharer/spec/vectors, read as they are):
///         - the Solidity leafOf equals every vector's leafHashes, at the
///           vector's own distributor address;
///         - the OpenZeppelin tree over those leaves has the vector's root;
///           past CHUNK_ACCOUNTS leaves, the two-level tree (ChunkedMerkle)
///           has it, and each chunk has the root the index lists;
///         - that root, published on a real distributor clone living at the
///           vector's address with the vector's cumulative totals and income,
///           passes every on-chain cap, and pushing every leaf pays each
///           account exactly its cumulative values, epoch after epoch; past
///           one chunk, some leaves of every chunk are claimed and the rest
///           pushed, all with two-level proofs.
contract LeafParityTest is SharingFixture {
    string constant DIR = "./services/sharer/spec/vectors";

    function _isJson(string memory p) internal pure returns (bool) {
        bytes memory b = bytes(p);
        if (b.length < 5) return false;
        return b[b.length - 5] == "." && b[b.length - 4] == "j" && b[b.length - 3] == "s" && b[b.length - 2] == "o"
            && b[b.length - 1] == "n";
    }

    function _vectors() internal view returns (string[] memory files) {
        Vm.DirEntry[] memory es = vm.readDir(DIR, 1);
        uint256 n;
        for (uint256 i; i < es.length; ++i) {
            if (!es[i].isDir && _isJson(es[i].path)) ++n;
        }
        files = new string[](n);
        n = 0;
        for (uint256 i; i < es.length; ++i) {
            if (!es[i].isDir && _isJson(es[i].path)) files[n++] = es[i].path;
        }
    }

    function _u(string memory json, string memory key) internal pure returns (uint256) {
        return vm.parseUint(vm.parseJsonString(json, key));
    }

    function _k(uint256 e, string memory rest) internal pure returns (string memory) {
        return string.concat(".epochs[", vm.toString(e), "]", rest);
    }

    function test_leafOfAndTheRootMatchEveryGoldenVector() public {
        string[] memory files = _vectors();
        assertGe(files.length, 11, "all golden vectors found");
        uint256 checkedLeaves;
        uint256 checkedRoots;
        uint256 checkedChunked;
        for (uint256 f; f < files.length; ++f) {
            string memory json = vm.readFile(files[f]);
            address dAddr = vm.parseJsonAddress(json, ".setup.distributor");
            // the implementation's code at the vector's address: leafOf binds
            // address(this), which is now the vector's distributor
            vm.etch(dAddr, fac.implementation().code);
            HolderFeeDistributor d = HolderFeeDistributor(payable(dAddr));
            for (uint256 e; vm.keyExistsJson(json, _k(e, "")); ++e) {
                if (keccak256(bytes(vm.parseJsonString(json, _k(e, ".expected.result")))) != keccak256("epoch")) {
                    continue;
                }
                bytes32[] memory want = vm.parseJsonBytes32Array(json, _k(e, ".expected.leafHashes"));
                bytes32[] memory got = new bytes32[](want.length);
                address[] memory accounts = new address[](want.length);
                for (uint256 i; i < want.length; ++i) {
                    string[] memory leaf =
                        vm.parseJsonStringArray(json, _k(e, string.concat(".expected.leaves[", vm.toString(i), "]")));
                    assertEq(vm.parseAddress(leaf[0]), dAddr, "every leaf names the distributor");
                    accounts[i] = vm.parseAddress(leaf[1]);
                    got[i] = d.leafOf(accounts[i], vm.parseUint(leaf[2]), vm.parseUint(leaf[3]));
                    assertEq(got[i], want[i], string.concat(files[f], ": leaf hash"));
                    ++checkedLeaves;
                }
                bytes32 root = vm.parseJsonBytes32(json, _k(e, ".expected.merkleRoot"));
                if (got.length > ChunkedMerkle.CHUNK_ACCOUNTS) {
                    _checkChunkedTree(json, e, files[f], accounts, got, root);
                    ++checkedChunked;
                    ++checkedRoots;
                    continue;
                }
                MerkleBuilder.Tree memory t = MerkleBuilder.build(got);
                assertEq(MerkleBuilder.root(t), root, string.concat(files[f], ": root"));
                for (uint256 i; i < got.length; ++i) {
                    assertTrue(MerkleProof.verify(MerkleBuilder.proof(t, i), root, got[i]), "single proof");
                }
                ++checkedRoots;
            }
        }
        emit log_named_uint("leaves checked", checkedLeaves);
        emit log_named_uint("roots checked", checkedRoots);
        emit log_named_uint("chunked roots checked", checkedChunked);
        assertGe(checkedRoots, 19, "every epoch of every vector");
        assertGe(checkedChunked, 1, "a vector past one chunk");
    }

    /// PAST CHUNK_ACCOUNTS LEAVES THE TREE IS BUILT IN CHUNKS (spec 1.7): the
    /// chunks the index lists are the ones the leaves cut into, each with its
    /// first and last account, its count and its root; the root over their
    /// roots is the vector's; every leaf's two-level proof reaches it.
    function _checkChunkedTree(
        string memory json,
        uint256 e,
        string memory file,
        address[] memory accounts,
        bytes32[] memory leaves,
        bytes32 root
    ) internal view {
        ChunkedMerkle.Tree memory t = ChunkedMerkle.build(accounts, leaves);
        uint256 nc = t.chunks.length;
        assertGt(nc, 1, "more than one chunk");
        assertFalse(vm.keyExistsJson(json, _chunkKey(e, nc, "")), string.concat(file, ": no chunk past the last"));
        for (uint256 c; c < nc; ++c) {
            uint256[] memory m = t.members[c];
            assertEq(
                accounts[m[0]],
                vm.parseJsonAddress(json, _chunkKey(e, c, ".first")),
                string.concat(file, ": chunk first account")
            );
            assertEq(
                accounts[m[m.length - 1]],
                vm.parseJsonAddress(json, _chunkKey(e, c, ".last")),
                string.concat(file, ": chunk last account")
            );
            assertEq(m.length, _u(json, _chunkKey(e, c, ".count")), string.concat(file, ": chunk count"));
            assertEq(
                ChunkedMerkle.chunkRoot(t, c),
                vm.parseJsonBytes32(json, _chunkKey(e, c, ".root")),
                string.concat(file, ": chunk root")
            );
        }
        assertEq(t.root, root, string.concat(file, ": root"));
        for (uint256 i; i < leaves.length; ++i) {
            assertTrue(MerkleProof.verify(ChunkedMerkle.proof(t, i), root, leaves[i]), "two-level proof");
        }
    }

    function _chunkKey(uint256 e, uint256 c, string memory rest) internal pure returns (string memory) {
        return _k(e, string.concat(".expected.chunks[", vm.toString(c), "]", rest));
    }

    function test_everyGoldenVectorRootPaysItsCumulativeValuesOnChain() public {
        string[] memory files = _vectors();
        for (uint256 f; f < files.length; ++f) {
            // each vector on a clean state: same distributor address, same accounts
            uint256 snap = vm.snapshotState();
            _replay(files[f]);
            vm.revertToState(snap);
        }
    }

    /// Builds a real launch and distributor, moves the distributor to the
    /// vector's address (same code, same storage), and replays the vector's
    /// epochs on it.
    function _replay(string memory file) internal {
        string memory json = vm.readFile(file);
        address dAddr = vm.parseJsonAddress(json, ".setup.distributor");
        bool weth = vm.parseJsonBool(json, ".setup.quoteIsWeth");
        L memory l = _newLaunch(weth ? WETH : address(new Tok("Q", 8)));
        _enable(l);
        // same clone code, same storage, at the vector's address
        vm.etch(dAddr, address(l.d).code);
        for (uint256 s; s < 32; ++s) {
            vm.store(dAddr, bytes32(s), vm.load(address(l.d), bytes32(s)));
        }
        grad.forceSwitch(l.token, dAddr);
        HolderFeeDistributor d = HolderFeeDistributor(payable(dAddr));
        l.d = d;
        vm.roll(vm.getBlockNumber() + 10);

        for (uint256 e; vm.keyExistsJson(json, _k(e, "")); ++e) {
            if (keccak256(bytes(vm.parseJsonString(json, _k(e, ".expected.result")))) != keccak256("epoch")) {
                continue;
            }
            // income up to the vector's received figures
            uint256 r0 = _u(json, _k(e, ".input.received0"));
            uint256 r1 = _u(json, _k(e, ".input.received1"));
            if (r0 > d.received0()) _fund0(l, r0 - d.received0());
            if (r1 > d.received1()) _fund1(l, r1 - d.received1());
            assertEq(d.received0(), r0, "received0 as the vector saw it");

            bytes32 root = vm.parseJsonBytes32(json, _k(e, ".expected.merkleRoot"));
            HolderFeeDistributor.Root memory r = _next(
                d,
                root,
                _u(json, _k(e, ".expected.cumHolders0")),
                _u(json, _k(e, ".expected.cumHolders1")),
                _u(json, _k(e, ".expected.cumKeeper0"))
            );
            assertEq(r.epoch, _u(json, _k(e, ".expected.epoch")), "epoch numbering matches");
            vm.prank(address(fac));
            d.publish(r, "ipfs://vector");
            bool vetoed = vm.keyExistsJson(json, _k(e, ".input.vetoed"))
                && vm.parseJsonBool(json, _k(e, ".input.vetoed"));
            if (vetoed) {
                vm.prank(address(fac));
                d.veto(r.epoch, "vector veto");
                vm.roll(vm.getBlockNumber() + 10);
                continue;
            }
            _ripen();
            _pushVectorEpoch(json, e, d, l);
            d.payKeeper();
            assertEq(d.keeperPaid0(), r.cumKeeper0);
            vm.roll(vm.getBlockNumber() + 10);
        }
    }

    function _pushVectorEpoch(string memory json, uint256 e, HolderFeeDistributor d, L memory l) internal {
        uint256 n = vm.parseJsonBytes32Array(json, _k(e, ".expected.leafHashes")).length;
        Alloc[] memory al = new Alloc[](n);
        for (uint256 i; i < n; ++i) {
            string[] memory leaf =
                vm.parseJsonStringArray(json, _k(e, string.concat(".expected.leaves[", vm.toString(i), "]")));
            al[i] = Alloc(vm.parseAddress(leaf[1]), vm.parseUint(leaf[2]), vm.parseUint(leaf[3]));
        }
        if (n > ChunkedMerkle.CHUNK_ACCOUNTS) {
            _payChunked(d, al);
        } else {
            MerkleBuilder.Tree memory t = _tree(d, al);
            assertEq(MerkleBuilder.root(t), _activeOrPendingRoot(d), "the Solidity-built tree is the vector's");
            _pushAll(d, al, t);
        }
        for (uint256 i; i < n; ++i) {
            assertEq(_bal0(l, al[i].a), al[i].c0, "paid its cumulative quote share");
            assertEq(_bal1(l, al[i].a), al[i].c1, "paid its cumulative launch-token share");
            assertEq(d.paid0(al[i].a), al[i].c0);
        }
    }

    /// THE DISTRIBUTOR TAKES THE TWO-LEVEL PROOFS AS THEY ARE: in every chunk,
    /// its first, middle and last leaf are claimed by their accounts with the
    /// chunk's proof followed by the top proof (the last chunk is the partial
    /// one); every other leaf of the chunk is pushed in one multiproof, the
    /// chunk's own carried up by the top proof with a false flag per element.
    function _payChunked(HolderFeeDistributor d, Alloc[] memory al) internal {
        address[] memory accounts = new address[](al.length);
        for (uint256 i; i < al.length; ++i) {
            accounts[i] = al[i].a;
        }
        ChunkedMerkle.Tree memory t = ChunkedMerkle.build(accounts, _hashes(d, al));
        assertEq(t.root, _activeOrPendingRoot(d), "the Solidity-built tree is the vector's");
        uint256 nc = t.chunks.length;
        assertGt(nc, 1, "more than one chunk");
        assertLt(t.members[nc - 1].length, ChunkedMerkle.CHUNK_ACCOUNTS, "the last chunk is partial");
        uint256 claimsPaid;
        for (uint256 c; c < nc; ++c) {
            uint256 size = t.members[c].length;
            bool[] memory claimed = new bool[](size);
            claimed[0] = true;
            claimed[size / 2] = true;
            claimed[size - 1] = true;
            uint256 rest = size;
            uint256 paidHere;
            for (uint256 j; j < size; ++j) {
                if (!claimed[j]) continue;
                --rest;
                if (_claimChunked(d, al, t, t.members[c][j])) ++paidHere;
            }
            assertGt(paidHere, 0, "a claim in every chunk moved money");
            claimsPaid += paidHere;
            uint256[] memory pos = new uint256[](rest);
            rest = 0;
            for (uint256 j; j < size; ++j) {
                if (!claimed[j]) pos[rest++] = j;
            }
            (uint256[] memory order, bytes32[] memory p, bool[] memory f) = ChunkedMerkle.multiProof(t, c, pos);
            HolderFeeDistributor.Leaf[] memory ls = new HolderFeeDistributor.Leaf[](order.length);
            for (uint256 i; i < order.length; ++i) {
                Alloc memory x = al[order[i]];
                ls[i] = HolderFeeDistributor.Leaf(x.a, x.c0, x.c1);
            }
            d.push(ls, p, f);
        }
        emit log_named_uint("chunked claims that paid", claimsPaid);
    }

    /// Claims the i-th leaf as its account, with its two-level proof. A leaf
    /// with nothing new still proves: the claim then stops at NothingToClaim,
    /// which comes after the proof check. Returns whether it paid.
    function _claimChunked(HolderFeeDistributor d, Alloc[] memory al, ChunkedMerkle.Tree memory t, uint256 i)
        internal
        returns (bool paid)
    {
        Alloc memory x = al[i];
        bytes32[] memory p = ChunkedMerkle.proof(t, i);
        (uint256 o0, uint256 o1) = d.claimable(x.a, x.c0, x.c1);
        paid = o0 != 0 || o1 != 0;
        if (!paid) vm.expectRevert(abi.encodeWithSelector(HolderFeeDistributor.NothingToClaim.selector, x.a));
        vm.prank(x.a);
        d.claim(x.c0, x.c1, p, address(0));
    }

    function _activeOrPendingRoot(HolderFeeDistributor d) internal view returns (bytes32) {
        HolderFeeDistributor.Root memory p = _pendingRoot(d);
        if (p.payableAt != 0) return p.merkleRoot;
        return _activeRoot(d).merkleRoot;
    }
}
