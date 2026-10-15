// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";

import {FeePolicySnapshot} from "../src/vendor/interfaces/ILaunchpadV2.sol";
import {CurbLaunchFactory} from "../src/curb/CurbLaunchFactory.sol";
import {CurbLaunchToken} from "../src/curb/CurbLaunchToken.sol";
import {PonsV2BondingCurve} from "../src/vendor/PonsV2BondingCurve.sol";
import {LaunchLens} from "../src/curb/LaunchLens.sol";
import {Graduator} from "../src/curb/Graduator.sol";

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// The deployed UniversalRouter predates the vendored periphery's extra
/// `minHopPriceX36` field, so the struct it decodes is this one. Using the
/// vendored shape makes every swap revert, which cost this project a session.
struct ExactInputSingleLegacy {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 amountIn;
    uint128 amountOutMinimum;
    bytes hookData;
}

/**
 * @title SelfTestWalletFlow
 * @notice Replays the user flow from ONE address, so the real-wallet GATE can
 *         be shown to pass when the flow happened and fail when it did not.
 *
 * THIS IS NOT THE REAL-WALLET TEST. It is how script/b20/wallet-session.sh is
 * checked. The gate reads the chain and cannot tell a key held by MetaMask
 * from an unlocked anvil account - which is the whole reason `prepare` turns
 * impersonation back off before the session starts. Here impersonation is
 * exactly what is wanted: the point is to produce, and to withhold, each step
 * of the flow on demand.
 *
 * Run one stage at a time:
 *   base-forge script script/SelfTestWalletFlow.s.sol --sig "create()" \
 *     --rpc-url $RPC --broadcast --unlocked --sender $WALLET
 *
 * Addresses come from the environment so nothing is pasted between runs:
 *   CURB_FACTORY CURB_LENS CURB_GRADUATOR  and, after create(), CURB_TOKEN
 */
contract SelfTestWalletFlow is Script {
    address internal constant NVDAC = 0xb20000000000000000000078ee7ce2fE4908108C;
    address internal constant ROUTER = 0x6fF5693b99212Da76ad316178A184AB56D299b43;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    uint8 internal constant V4_SWAP = 0x10;

    // The curve's terms are the factory's, not repeated here: an unused copy
    // of them said 60/60 after DeployCurb had moved on.
    uint256 internal constant SUPPLY = 1_000_000_000e18;

    function factory() internal view returns (CurbLaunchFactory) {
        return CurbLaunchFactory(vm.envAddress("CURB_FACTORY"));
    }

    function lens() internal view returns (LaunchLens) {
        return LaunchLens(vm.envAddress("CURB_LENS"));
    }

    function token() internal view returns (address) {
        return vm.envAddress("CURB_TOKEN");
    }

    function curve() internal view returns (PonsV2BondingCurve) {
        return PonsV2BondingCurve(lens().launchState(token()).curve);
    }

    /// STEP 1 - create a launch. ANY sender will do: launch() is open to
    /// everyone, and whoever sends it becomes the creator.
    ///
    /// The economics are no longer arguments. The supply, the curve's shape,
    /// the lock, the pool and the fee policy all come from the factory this
    /// script reads out of the environment, so the only thing this step
    /// chooses is the token's identity and its tax.
    function create() external {
        address me = msg.sender;
        vm.startBroadcast();
        // The fee is the factory's, read back rather than repeated here.
        CurbLaunchFactory f = factory();
        (uint16 expectBps, address expectTo) = f.currentPlatformPolicy();
        (CurbLaunchToken t, PonsV2BondingCurve c) = f.launch{value: f.launchFee()}(
            CurbLaunchFactory.LaunchConfig({
                name: "Gate Flow",
                symbol: "GATE",
                tokenUri: "",
                // A salt of its own, so this token is never the one DeployCurb
                // made on the way in.
                salt: keccak256("curb.selftest.wallet.gate"),
                quoteRefundTo: me,
                totalTaxBps: 300,
                devBuy: 0,
                creatorWallet: address(0),
                expectedPlatformBps: expectBps,
                expectedPlatformRecipient: expectTo,
                holderShareFactory: address(0)
            })
        );
        vm.stopBroadcast();
        console.log("token", address(t));
        console.log("curve", address(c));
    }

    /// STEP 2 - buy CURB_AMOUNT of NVDAc worth on the curve.
    function buy() external {
        uint256 amount = vm.envUint("CURB_AMOUNT");
        PonsV2BondingCurve c = curve();
        vm.startBroadcast();
        IERC20(NVDAC).approve(address(c), amount);
        c.buy(amount, 1, msg.sender);
        vm.stopBroadcast();
        console.log("bought with", amount);
    }

    /// STEP 3 - sell CURB_AMOUNT of the launch token back.
    function sell() external {
        uint256 amount = vm.envUint("CURB_AMOUNT");
        PonsV2BondingCurve c = curve();
        vm.startBroadcast();
        IERC20(token()).approve(address(c), amount);
        c.sell(amount, 1, msg.sender);
        vm.stopBroadcast();
        console.log("sold", amount);
    }

    /// STEP 4 - buying up to just SHORT of the threshold IS NOT HERE.
    ///
    /// It was: a loop that bought until the reserve reached a stopping point,
    /// broadcast as one script run. Forge's multi-transaction broadcast left
    /// NONCE GAPS on this node - some sends never arrived, the rest sat queued,
    /// and the run hung polling for receipts that could not come. The buys are
    /// driven one transaction at a time from selftest-wallet-gate.sh instead,
    /// which is also closer to a person confirming them in a wallet.
    ///
    /// GRADUATION IS AUTOMATIC ON THE BUY THAT CROSSES: the curve calls the
    /// graduator itself, so a loop that ran until `readyToGraduate()` would find
    /// the launch already Graduated and the next buy reverting with
    /// CurveGraduated - which is what happened the first time this was written.
    /// Waiting exists only when that automatic attempt runs out of gas, so the
    /// crossing buy goes out separately on a starved gas limit.

    /// STEP 5 - the permissionless button.
    function graduate() external {
        vm.startBroadcast();
        Graduator(vm.envAddress("CURB_GRADUATOR")).graduate(token());
        vm.stopBroadcast();
        console.log("graduated");
    }

    /// STEP 6 - trade the pool the graduation created, through the router the
    /// page uses, with the approvals the page makes.
    function poolTrade() external {
        address t = token();
        PoolKey memory key = lens().launchState(t).poolKey;
        uint128 amountIn = uint128(vm.envUint("CURB_AMOUNT"));
        address tokenIn = NVDAC;
        address tokenOut = t;

        bytes memory actions =
            abi.encodePacked(uint8(Actions.SWAP_EXACT_IN_SINGLE), uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL));
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            ExactInputSingleLegacy({
                poolKey: key,
                zeroForOne: tokenIn == Currency.unwrap(key.currency0),
                amountIn: amountIn,
                amountOutMinimum: 1,
                hookData: ""
            })
        );
        params[1] = abi.encode(Currency.wrap(tokenIn), amountIn);
        params[2] = abi.encode(Currency.wrap(tokenOut), uint128(1));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);

        uint256 before = IERC20(tokenOut).balanceOf(msg.sender);
        vm.startBroadcast();
        IERC20(tokenIn).approve(PERMIT2, type(uint256).max);
        IPermit2(PERMIT2).approve(tokenIn, ROUTER, amountIn, uint48(block.timestamp + 3600));
        IUniversalRouter(ROUTER).execute(abi.encodePacked(V4_SWAP), inputs, block.timestamp + 60);
        vm.stopBroadcast();
        console.log("received", IERC20(tokenOut).balanceOf(msg.sender) - before);
    }

    /// A transaction from this address that is NOT part of the flow - used to
    /// show that the "nothing was sent" checks fail when something was.
    function noise() external {
        vm.startBroadcast();
        IERC20(NVDAC).approve(address(0xdead), 1);
        vm.stopBroadcast();
        console.log("noise sent");
    }

    /// A transaction from SOMEONE ELSE, used to show that the gate notices a
    /// chain being driven by something other than the wallet.
    function stranger() external {
        vm.startBroadcast(vm.envAddress("CURB_STRANGER"));
        IERC20(NVDAC).approve(address(0xdead), 1);
        vm.stopBroadcast();
        console.log("stranger sent");
    }
}
