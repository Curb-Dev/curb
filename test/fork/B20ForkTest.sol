// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {RecordCurveMaker} from "../mocks/Mocks.sol";

/**
 * @title B20ForkTest
 * @notice The fork gate and the fork-point check, in one place, for every fork
 *         test in this directory.
 *
 * WHY THIS IS A BASE CONTRACT AND NOT A TEST
 *   The check used to live in a single test inside B20UniswapV4.t.sol. Running
 *   any other file on its own - which is the normal way to work - never touched
 *   it, so the one thing every measured constant in this directory depends on
 *   was verified only by accident.
 *
 *   Now every fork test calls _forkGuard() as the FIRST statement of its
 *   setUp(), and onlyFork refuses to run a test whose setUp did not. Forgetting
 *   it is a failure, not a silent skip.
 *
 * WHAT THE FORK POINT IS AND HOW IT DRIFTS
 *   The node is the pin: script/b20/start-node.sh forks Base at FORK_BLOCK, and
 *   forge - given no --fork-block-number - forks at whatever that node calls
 *   latest. Those agree only while nothing has been mined ON THE NODE since it
 *   started. Our own scripts do mine: an impersonated B20 transfer is a local
 *   transaction and anvil mines a local block for it.
 *
 *   So a drifted latest is NOT new mainnet blocks arriving. It is local blocks
 *   on top of the same fork base, and what actually changes underneath a test
 *   is the LOCAL STARTING STATE - balances and approvals those transactions
 *   left behind - not the mainnet data being forked. That is still enough to
 *   move a measured constant, which is why this is checked rather than trusted.
 *
 *   THE FIX IS TO RESTART THE NODE:  bash script/b20/start-node.sh
 *
 * HOW TO RUN THE SUITE
 *   bash script/b20/test-all.sh
 *
 *   It runs two commands, because ONE DID NOT COMPLETE HERE:
 *     base-forge test --no-match-path "test/fork/*"
 *     base-forge test --match-path   "test/fork/*" --fork-url <the node>
 *
 *   WHAT WAS OBSERVED, and only that. Running the whole repository with
 *   --fork-url did not finish in this environment: no output for an hour, forge
 *   alive, the node answering, ten of fifteen suites done and the rest never
 *   arriving. Splitting the fork tests from the rest finished both halves in
 *   about half a minute.
 *     THE CAUSE WAS NOT MEASURED. The suspicion is test/CurveInvariants.t.sol,
 *     which makes a great many calls and needs no fork - but nothing here
 *     measured cache hits, local execution or RPC traffic, so the mechanism is
 *     a guess and is written down as one. What is established is that the
 *     combined command did not complete and the split one did.
 *
 *   ON --fork-block-number, HONESTLY. Passing it to forge in this setup
 *   produced a burst of "failed to get storage ... operation timed out" errors
 *   and left the node unresponsive to any further request. That is what was
 *   OBSERVED, on one occasion, in this environment. The explanation that
 *   suggests itself - that naming a historical block makes anvil serve each
 *   storage read from upstream and that the upstream rate-limits - was NOT
 *   established; nothing here measured upstream traffic or saw a rate-limit
 *   response. Restarting the node is the workaround that was used, not a
 *   diagnosis. If the flag is wanted later, the mechanism needs checking first.
 */

/// Base's canonical Safe deployment. Here rather than in one test file because
/// two of them need it: A6 asks whether a Safe can be paid and can claim, and
/// the fee policy asks whether a Safe can OPERATE it.
interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
}

interface ISafe {
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;
    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 nonce
    ) external view returns (bytes32);
    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures
    ) external payable returns (bool);
    function nonce() external view returns (uint256);
    function getThreshold() external view returns (uint256);
    function getOwners() external view returns (address[] memory);
}

abstract contract B20ForkTest is Test {
    /// Must match FORK_BLOCK in script/b20/env.sh.
    uint256 internal constant FORK_BLOCK = 51171034;
    uint256 internal constant BASE_CHAIN_ID = 8453;

    bool private _forkGuardRan;

    /// @dev The first statement of every fork test's setUp:
    ///        function setUp() public { if (!_forkGuard()) return; ... }
    ///      Returns false when this is not the fork, so setUp can stop before
    ///      touching any address that only exists there.
    function _forkGuard() internal returns (bool onFork) {
        if (block.chainid != BASE_CHAIN_ID) return false;
        require(
            block.number == FORK_BLOCK,
            "fork point drifted: the node has mined past its fork block - restart it with script/b20/start-node.sh"
        );
        _forkGuardRan = true;
        return true;
    }

    modifier onlyFork() {
        if (block.chainid != BASE_CHAIN_ID) {
            // A declared fork run that is not on the fork is a broken command,
            // not a reason to quietly report PASS.
            require(!vm.envOr("B20_FORK", false), "B20_FORK is set but this is not the Base fork");
            vm.skip(true);
        }
        require(_forkGuardRan, "setUp() did not call _forkGuard() - the fork point was never checked");
        _;
    }

    // ------------------------------------------------------------------
    // A CURVE FOR A RECORD WRITTEN BY HAND
    // ------------------------------------------------------------------

    /// Where the RecordCurveMaker is etched. A bare hash, so nothing is there.
    address private constant RECORD_CURVE_MAKER = address(uint160(uint256(keccak256("curb.B20ForkTest.record curve maker"))));

    /// A curve that says the record is its own: the registry refuses a record
    /// whose curve does not, and one curve serves one record.
    ///
    /// MADE BY AN ETCHED MAKER, NOT WITH `new` HERE. A `new` would move this
    /// contract's nonce, and with it the address of every token a fixture
    /// deploys afterwards - which decides a v4 pool's currency order, and so a
    /// swap's rounding. One fee test compares three fresh pools to the wei and
    /// stopped matching when each record took a curve of its own this way.
    function _recordCurve(address token, address pairToken, address factory) internal returns (address) {
        if (RECORD_CURVE_MAKER.code.length == 0) vm.etch(RECORD_CURVE_MAKER, type(RecordCurveMaker).runtimeCode);
        return RecordCurveMaker(RECORD_CURVE_MAKER).make(token, pairToken, factory);
    }

    // ------------------------------------------------------------------
    // A REAL SAFE, FROM THE REAL FACTORY, ON THE FORK
    // ------------------------------------------------------------------

    address internal constant SAFE_PROXY_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address internal constant SAFE_SINGLETON_L2 = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;

    /// Deploys a 2-of-3 through Base's own factory and returns the owners' keys
    /// so a transaction can be signed. Both addresses are asserted to have code
    /// first: a wrong constant would otherwise make every test using this pass
    /// while measuring nothing.
    function _deploySafe() internal returns (ISafe safe, uint256[3] memory keys, address[3] memory owners) {
        assertGt(SAFE_PROXY_FACTORY.code.length, 0, "no Safe proxy factory on this chain");
        assertGt(SAFE_SINGLETON_L2.code.length, 0, "no Safe singleton on this chain");

        (address o1, uint256 k1) = makeAddrAndKey("safe owner 1");
        (address o2, uint256 k2) = makeAddrAndKey("safe owner 2");
        (address o3, uint256 k3) = makeAddrAndKey("safe owner 3");

        // SORTED ASCENDING. Safe requires signatures ordered by signer address,
        // so sorting the OWNERS here lets the signing code follow this order
        // instead of sorting again and getting it wrong.
        address[3] memory a = [o1, o2, o3];
        uint256[3] memory k = [k1, k2, k3];
        for (uint256 i = 0; i < 3; i++) {
            for (uint256 j = i + 1; j < 3; j++) {
                if (a[j] < a[i]) {
                    (a[i], a[j]) = (a[j], a[i]);
                    (k[i], k[j]) = (k[j], k[i]);
                }
            }
        }
        owners = a;
        keys = k;

        address[] memory list = new address[](3);
        list[0] = a[0];
        list[1] = a[1];
        list[2] = a[2];
        bytes memory initializer = abi.encodeCall(
            ISafe.setup, (list, 2, address(0), "", address(0), address(0), 0, payable(address(0)))
        );
        safe = ISafe(ISafeProxyFactory(SAFE_PROXY_FACTORY).createProxyWithNonce(SAFE_SINGLETON_L2, initializer, 0));
    }

    /// Two signatures over the Safe's own transaction hash, in owner order.
    function _signSafeTx(ISafe safe, uint256[3] memory keys, address to, bytes memory data)
        internal
        view
        returns (bytes memory sigs)
    {
        bytes32 h = safe.getTransactionHash(to, 0, data, 0, 0, 0, 0, address(0), address(0), safe.nonce());
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(keys[0], h);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(keys[1], h);
        sigs = abi.encodePacked(r1, s1, v1, r2, s2, v2);
    }

    /// Runs one call THROUGH the Safe, driven by somebody who is not an owner -
    /// which is how a Safe is normally operated and proves the threshold is
    /// what authorises, not the sender.
    function _safeExec(ISafe safe, uint256[3] memory keys, address to, bytes memory data) internal {
        bytes memory sigs = _signSafeTx(safe, keys, to, data);
        vm.prank(makeAddr("safe relayer"));
        bool ok = safe.execTransaction(to, 0, data, 0, 0, 0, 0, address(0), payable(address(0)), sigs);
        assertTrue(ok, "the Safe transaction did not execute");
    }
}
