// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice The OpenZeppelin StandardMerkleTree algorithm (@openzeppelin/merkle-tree,
///         default options) in Solidity, for tests: leaves sorted by hash,
///         stored at the end of a flat array, sorted-pair keccak for every
///         parent, single proofs and multiproofs built the same way the
///         JavaScript library builds them.
library MerkleBuilder {
    struct Tree {
        bytes32[] nodes;
        /// nodes index of the i-th leaf as given (not as sorted).
        uint256[] indexOf;
    }

    function hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    function build(bytes32[] memory leaves) internal pure returns (Tree memory t) {
        uint256 n = leaves.length;
        require(n != 0, "empty tree");
        // sort a copy of the hashes ascending, remembering where each came from
        bytes32[] memory s = new bytes32[](n);
        uint256[] memory from = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            s[i] = leaves[i];
            from[i] = i;
        }
        for (uint256 i = 1; i < n; ++i) {
            bytes32 k = s[i];
            uint256 f = from[i];
            uint256 j = i;
            while (j > 0 && s[j - 1] > k) {
                s[j] = s[j - 1];
                from[j] = from[j - 1];
                --j;
            }
            s[j] = k;
            from[j] = f;
        }
        uint256 len = 2 * n - 1;
        t.nodes = new bytes32[](len);
        t.indexOf = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            t.nodes[len - 1 - i] = s[i];
            t.indexOf[from[i]] = len - 1 - i;
        }
        if (len > n) {
            for (uint256 i = len - 1 - n + 1; i > 0; --i) {
                uint256 k = i - 1;
                t.nodes[k] = hashPair(t.nodes[2 * k + 1], t.nodes[2 * k + 2]);
            }
        }
    }

    function root(Tree memory t) internal pure returns (bytes32) {
        return t.nodes[0];
    }

    function _sibling(uint256 i) private pure returns (uint256) {
        return i % 2 == 1 ? i + 1 : i - 1;
    }

    function _parent(uint256 i) private pure returns (uint256) {
        return (i - 1) / 2;
    }

    /// The proof of the i-th leaf as given.
    function proof(Tree memory t, uint256 leaf) internal pure returns (bytes32[] memory p) {
        uint256 k = t.indexOf[leaf];
        uint256 depth;
        for (uint256 j = k; j > 0; j = _parent(j)) {
            ++depth;
        }
        p = new bytes32[](depth);
        uint256 d;
        while (k > 0) {
            p[d++] = t.nodes[_sibling(k)];
            k = _parent(k);
        }
    }

    /// A multiproof for the given leaves (indices into the leaves as given).
    /// Returns the order in which their hashes must be passed (`order[i]` is a
    /// leaf index), the proof and the flags.
    function multiProof(Tree memory t, uint256[] memory leafIdx)
        internal
        pure
        returns (uint256[] memory order, bytes32[] memory p, bool[] memory flags)
    {
        uint256 m = leafIdx.length;
        uint256[] memory idx = new uint256[](m);
        order = new uint256[](m);
        for (uint256 i; i < m; ++i) {
            idx[i] = t.indexOf[leafIdx[i]];
            order[i] = leafIdx[i];
        }
        // sort descending by node index
        for (uint256 i = 1; i < m; ++i) {
            uint256 k = idx[i];
            uint256 o = order[i];
            uint256 j = i;
            while (j > 0 && idx[j - 1] < k) {
                idx[j] = idx[j - 1];
                order[j] = order[j - 1];
                --j;
            }
            idx[j] = k;
            order[j] = o;
        }
        for (uint256 i = 1; i < m; ++i) {
            require(idx[i] != idx[i - 1], "duplicate leaf");
        }
        // a queue: at most m + depth pushes; bound generously
        uint256[] memory q = new uint256[](m + t.nodes.length + 1);
        uint256 head;
        uint256 tail;
        for (uint256 i; i < m; ++i) {
            q[tail++] = idx[i];
        }
        bytes32[] memory pp = new bytes32[](t.nodes.length);
        bool[] memory ff = new bool[](t.nodes.length);
        uint256 np;
        uint256 nf;
        while (tail > head && q[head] > 0) {
            uint256 j = q[head++];
            uint256 s = _sibling(j);
            uint256 par = _parent(j);
            if (tail > head && s == q[head]) {
                ff[nf++] = true;
                head++;
            } else {
                ff[nf++] = false;
                pp[np++] = t.nodes[s];
            }
            q[tail++] = par;
        }
        if (m == 0) pp[np++] = t.nodes[0];
        p = new bytes32[](np);
        for (uint256 i; i < np; ++i) {
            p[i] = pp[i];
        }
        flags = new bool[](nf);
        for (uint256 i; i < nf; ++i) {
            flags[i] = ff[i];
        }
    }
}
