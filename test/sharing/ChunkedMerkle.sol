// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {MerkleBuilder} from "./MerkleBuilder.sol";

/// @notice The distributor's tree in two levels (CURB-SHARE spec 1.7,
///         services/sharer/src/calc/merkle.ts) in Solidity, for tests:
///         - the leaves, in account (address) order, are cut into chunks of
///           CHUNK_ACCOUNTS consecutive leaves, the last holding the rest;
///         - each chunk is the StandardMerkleTree of its leaf hashes
///           (MerkleBuilder);
///         - with one chunk the root is that chunk's root;
///         - with more, the root is the SimpleMerkleTree of the chunk roots
///           with the default options: the roots taken as they are (not
///           hashed again), sorted, sorted-pair hashing - which is
///           MerkleBuilder over the roots;
///         - a claim proof is the leaf's proof in its chunk, then its chunk
///           root's proof in the top tree;
///         - a push multiproof is the chunk's multiproof, then the top proof,
///           one false flag per element.
library ChunkedMerkle {
    /// services/sharer/src/calc/merkle.ts CHUNK_ACCOUNTS.
    uint256 internal constant CHUNK_ACCOUNTS = 512;

    struct Tree {
        bytes32 root;
        MerkleBuilder.Tree[] chunks;
        /// The tree of the chunk roots; empty with one chunk.
        MerkleBuilder.Tree top;
        /// members[c][j]: the leaf (index as given) at position j of chunk c,
        /// in account order.
        uint256[][] members;
        /// The chunk of the i-th leaf as given, and its position there.
        uint256[] chunkOf;
        uint256[] posOf;
    }

    /// `accounts[i]` is the account of `leaves[i]`; any order, no repeats.
    function build(address[] memory accounts, bytes32[] memory leaves) internal pure returns (Tree memory t) {
        uint256 n = leaves.length;
        require(n != 0, "empty tree");
        require(accounts.length == n, "one account per leaf");
        // CHUNKS ARE CUT IN ACCOUNT ORDER, not in leaf-hash order: sort the
        // leaves by address first (insertion sort; a sorted input stays linear)
        uint256[] memory order = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            order[i] = i;
        }
        for (uint256 i = 1; i < n; ++i) {
            uint256 o = order[i];
            uint160 k = uint160(accounts[o]);
            uint256 j = i;
            while (j > 0 && uint160(accounts[order[j - 1]]) > k) {
                order[j] = order[j - 1];
                --j;
            }
            order[j] = o;
        }
        for (uint256 i = 1; i < n; ++i) {
            require(accounts[order[i]] != accounts[order[i - 1]], "two leaves for one account");
        }

        uint256 nc = (n + CHUNK_ACCOUNTS - 1) / CHUNK_ACCOUNTS;
        t.chunks = new MerkleBuilder.Tree[](nc);
        t.members = new uint256[][](nc);
        t.chunkOf = new uint256[](n);
        t.posOf = new uint256[](n);
        bytes32[] memory roots = new bytes32[](nc);
        for (uint256 c; c < nc; ++c) {
            uint256 from = c * CHUNK_ACCOUNTS;
            uint256 size = n - from < CHUNK_ACCOUNTS ? n - from : CHUNK_ACCOUNTS;
            uint256[] memory m = new uint256[](size);
            bytes32[] memory h = new bytes32[](size);
            for (uint256 j; j < size; ++j) {
                m[j] = order[from + j];
                h[j] = leaves[m[j]];
                t.chunkOf[m[j]] = c;
                t.posOf[m[j]] = j;
            }
            t.members[c] = m;
            t.chunks[c] = MerkleBuilder.build(h);
            roots[c] = MerkleBuilder.root(t.chunks[c]);
        }
        if (nc == 1) {
            t.root = roots[0];
        } else {
            // THE TOP TAKES THE CHUNK ROOTS AS THEY ARE: SimpleMerkleTree's
            // leaf is the bytes32 value itself, so MerkleBuilder (which sorts
            // and pairs what it is given) builds it without hashing them again.
            t.top = MerkleBuilder.build(roots);
            t.root = MerkleBuilder.root(t.top);
        }
    }

    function chunkRoot(Tree memory t, uint256 c) internal pure returns (bytes32) {
        return MerkleBuilder.root(t.chunks[c]);
    }

    /// The proof that carries chunk c's root to the root; empty with one chunk.
    function topProof(Tree memory t, uint256 c) internal pure returns (bytes32[] memory) {
        if (t.chunks.length == 1) return new bytes32[](0);
        return MerkleBuilder.proof(t.top, c);
    }

    /// THE CHUNK'S PROOF COMES FIRST: the claim proof of the i-th leaf as
    /// given climbs its chunk to the chunk root, then the top to the root.
    function proof(Tree memory t, uint256 i) internal pure returns (bytes32[] memory p) {
        uint256 c = t.chunkOf[i];
        bytes32[] memory inChunk = MerkleBuilder.proof(t.chunks[c], t.posOf[i]);
        bytes32[] memory up = topProof(t, c);
        p = new bytes32[](inChunk.length + up.length);
        for (uint256 j; j < inChunk.length; ++j) {
            p[j] = inChunk[j];
        }
        for (uint256 j; j < up.length; ++j) {
            p[inChunk.length + j] = up[j];
        }
    }

    /// A push multiproof for leaves of chunk c (`pos` are positions in that
    /// chunk): the chunk's multiproof, then the top proof with a false flag
    /// each. `order[i]` is the leaf (index as given) to pass i-th.
    function multiProof(Tree memory t, uint256 c, uint256[] memory pos)
        internal
        pure
        returns (uint256[] memory order, bytes32[] memory p, bool[] memory flags)
    {
        (uint256[] memory o, bytes32[] memory mp, bool[] memory mf) = MerkleBuilder.multiProof(t.chunks[c], pos);
        order = new uint256[](o.length);
        for (uint256 i; i < o.length; ++i) {
            order[i] = t.members[c][o[i]];
        }
        bytes32[] memory up = topProof(t, c);
        p = new bytes32[](mp.length + up.length);
        flags = new bool[](mf.length + up.length);
        for (uint256 i; i < mp.length; ++i) {
            p[i] = mp[i];
        }
        for (uint256 i; i < mf.length; ++i) {
            flags[i] = mf[i];
        }
        for (uint256 i; i < up.length; ++i) {
            p[mp.length + i] = up[i];
        }
    }
}
