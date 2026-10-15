// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";

import {ICurbRouter} from "../src/curb/ICurbRouter.sol";

/**
 * @title DeployRouter
 * @notice Deploys CurbRouter through the canonical deterministic deployment
 *         proxy, so it lands at ONE address on Base and on every fork of it -
 *         and only at the address this file names.
 *
 * WHY CREATE2, AND WHY THIS PROXY
 *   The router has no constructor arguments and no owner - WETH, SwapRouter02
 *   and Base's precompiles are constants in its code - so its creation code is
 *   the same everywhere, and so is its address: the proxy's CREATE2 is a
 *   function of the proxy, the salt below and that code, and nothing else. Not
 *   the deployer's key, not its nonce. A fork of Base carries the proxy at the
 *   same address with the same code, so a rehearsal on the fork lands exactly
 *   where the real deployment will.
 *
 *   The proxy is Arachnid's, at 0x4e59b448...4956C, which is also what forge
 *   routes `new X{salt:}` through under --broadcast. It is called directly
 *   here rather than through that syntax, so the address does not depend on a
 *   forge flag (--create2-deployer) someone could pass without noticing.
 *
 * WHAT MOVES THE ADDRESS - AND WHAT NO LONGER DOES
 *   The router is compiled without the metadata hash (foundry.toml), and
 *   nothing imports it, so file paths, comments, a lib/ that is a symlink and
 *   forge's auto-detected remappings do not reach its bytecode. What still
 *   moves it is CODE: CurbRouter.sol or the OpenZeppelin files it imports, the
 *   compiler version, or the optimizer settings. This file takes the creation
 *   code from the build artifact (vm.getCode) for that reason - importing the
 *   contract would put this script in the router's compiler profile.
 *
 * THE ADDRESS IS PINNED, NOT JUST PRINTED
 *   EXPECTED_ROUTER is the address the page and the docs carry, and
 *   EXPECTED_RUNTIME_CODEHASH is keccak256 of the code that will live there -
 *   the page compares eth_getCode's keccak with it before it offers the
 *   one-click path, because a buy sent to an address with no code SUCCEEDS
 *   and the ETH is gone. run() refuses to broadcast when the code as built
 *   lands anywhere else or hashes to anything else, so a build that differs
 *   from the reviewed one cannot quietly deploy a router the page does not
 *   know. A deliberate router change updates both constants, and the fork
 *   test, in the same commit.
 *
 * WHAT IT REFUSES
 *   A chain without the proxy, without WETH, whose SwapRouter02 does not wrap
 *   that WETH, or without the B20 factory the router asks about stock assets -
 *   the router would deploy there and fail on every call. And code already at
 *   the address that is not this router's: CREATE2 cannot produce that from
 *   the same creation code, so it means the code here is not what is
 *   deployed, and the script says so instead of pointing the page at it. The
 *   same code already there is not an error; it is the deployment having
 *   happened, and the address is printed again.
 *
 * TO READ THE ADDRESS AND THE CODE HASH (no transaction):
 *   base-forge script script/DeployRouter.s.sol --rpc-url <a Base RPC>
 *
 * TO DEPLOY IT, the owner, from the signing shell, as with DeployCurb:
 *   base-forge script script/DeployRouter.s.sol --rpc-url <a Base RPC> \
 *     --broadcast --account <the deployer's keystore>
 *   Anybody may send this transaction and the result is the same contract at
 *   the same address - there is nothing in it for the sender to own.
 *
 * NEVER ONTO THE SUITE'S PINNED NODE. A broadcast mines a block there, and
 * every fork test then fails its fork-point check at once. A rehearsal needs
 * a node of its own (see the header of script/DeployCurb.s.sol).
 */
contract DeployRouter is Script {
    /// Arachnid's deterministic deployment proxy.
    address internal constant CREATE2_PROXY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    /// Its runtime code, byte for byte, as read off the fork of Base at block
    /// 51171034. The same on every chain it exists on - it was deployed from a
    /// presigned transaction - so a different hash means a different contract.
    bytes internal constant PROXY_CODE =
        hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

    /// THE SALT. Fixed, so the address is fixed; change it only to deploy a
    /// second, separate router on purpose.
    bytes32 public constant SALT = keccak256("CURB CurbRouter v1");

    /// WHERE THE REVIEWED ROUTER LANDS, and the hash of the code it leaves
    /// there. See the header: both are checked before anything is sent.
    address public constant EXPECTED_ROUTER = 0xEa20C3266229a01cd0f45D9c7921a45d5b359561;
    bytes32 public constant EXPECTED_RUNTIME_CODEHASH =
        0x25814dde01efddddcc582ba476471c80ce6de85154d1ee6a357f28cb67b37c5e;

    /// The build artifact the creation code comes from.
    string internal constant ARTIFACT = "CurbRouter.sol:CurbRouter";

    /// What the router hardcodes, repeated so the chain can be checked BEFORE
    /// anything is sent. The deployed router is asked for its own afterwards.
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant SWAP_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address internal constant B20_FACTORY = 0xB20f000000000000000000000000000000000000;
    address internal constant POLICY_REGISTRY = 0x8453000000000000000000000000000000000002;

    /// @notice Where the router lands for the code as built now.
    function predictedAddress() public view returns (address) {
        return vm.computeCreate2Address(SALT, keccak256(vm.getCode(ARTIFACT)), CREATE2_PROXY);
    }

    /// @notice keccak256 of the runtime code the router leaves, as built now.
    function runtimeCodehash() public view returns (bytes32) {
        return keccak256(vm.getDeployedCode(ARTIFACT));
    }

    /// @dev The two pinned values, behind one function so the fork test can
    ///      show run() refusing a build that does not match them. Nothing here
    ///      overrides it.
    function _expected() internal view virtual returns (address router, bytes32 codehash) {
        return (EXPECTED_ROUTER, EXPECTED_RUNTIME_CODEHASH);
    }

    function run() external returns (ICurbRouter router) {
        _preflight();
        (address expectedAt, bytes32 expectedCode) = _expected();
        address at = predictedAddress();
        require(at == expectedAt, "DeployRouter: the router as built does not land at EXPECTED_ROUTER");
        require(
            runtimeCodehash() == expectedCode,
            "DeployRouter: the router as built does not hash to EXPECTED_RUNTIME_CODEHASH"
        );

        if (at.code.length != 0) {
            require(
                keccak256(at.code) == expectedCode,
                "DeployRouter: other bytecode already lives at the CREATE2 address - refusing"
            );
            console.log("CurbRouter already deployed at", at);
            console.log("runtime code hash");
            console.logBytes32(expectedCode);
            return ICurbRouter(payable(at));
        }

        vm.startBroadcast();
        (bool ok, bytes memory ret) = CREATE2_PROXY.call(abi.encodePacked(SALT, vm.getCode(ARTIFACT)));
        vm.stopBroadcast();

        // THE PROXY RETURNS THE ADDRESS IT CREATED, twenty bytes, and reverts
        // if the creation failed. Both halves are checked: that it created
        // something, and that it is where this script said it would be.
        require(ok, "DeployRouter: the deployment proxy reverted");
        require(ret.length == 20 && address(bytes20(ret)) == at, "DeployRouter: the router landed somewhere else");
        require(keccak256(at.code) == expectedCode, "DeployRouter: the code at the address is not the router's");

        router = ICurbRouter(payable(at));
        require(
            router.WETH() == WETH && router.SWAP_ROUTER() == SWAP_ROUTER && router.B20_FACTORY() == B20_FACTORY
                && router.POLICY_REGISTRY() == POLICY_REGISTRY,
            "DeployRouter: constants moved"
        );

        console.log("CurbRouter", at);
        console.log("runtime code hash");
        console.logBytes32(expectedCode);
        console.log("chain id  ", block.chainid);
    }

    function _preflight() internal view {
        require(
            keccak256(CREATE2_PROXY.code) == keccak256(PROXY_CODE),
            "DeployRouter: no deterministic deployment proxy on this chain"
        );
        require(WETH.code.length != 0, "DeployRouter: no WETH on this chain");
        require(SWAP_ROUTER.code.length != 0, "DeployRouter: no SwapRouter02 on this chain");
        (bool ok, bytes memory raw) = SWAP_ROUTER.staticcall(abi.encodeWithSignature("WETH9()"));
        require(
            ok && raw.length == 32 && abi.decode(raw, (address)) == WETH,
            "DeployRouter: SwapRouter02 here does not wrap this WETH"
        );
        // A PRECOMPILE HAS NO CODE TO CHECK, and a call to an address with no
        // code succeeds with nothing in it - so the factory is asked a question
        // it must answer: WETH is not a B20.
        (ok, raw) = B20_FACTORY.staticcall(abi.encodeWithSignature("isB20(address)", WETH));
        require(ok && raw.length == 32 && !abi.decode(raw, (bool)), "DeployRouter: no B20 factory on this chain");
    }
}
