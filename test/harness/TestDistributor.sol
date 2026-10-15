// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {LaunchRegistry} from "../../src/curb/LaunchRegistry.sol";
import {IHolderDistributorFactory, IHolderDistributorIdentity} from "../../src/curb/sharing/ICurbSharing.sol";

interface ITestHookClaim {
    function claim(address token) external returns (uint256);
}

interface ITestEscrowClaim {
    function claimToken(address token) external returns (uint256);
}

interface ITestLock {
    function claimFees() external;
    function release(address party) external;
}

interface ITestCurveSweep {
    function sweepFees(uint256 minBuybackTokensOut) external;
}

/// A MINIMAL STAND-IN FOR A HOLDER DISTRIBUTOR, for the core's tests only.
///
/// It meets what the core requires of every distributor version (core v2
/// design, section E.2): it answers the identity the Graduator checks, accepts
/// plain token transfers and ETH, never forwards anything inside a callback,
/// has no owner and no way to move funds out, and so never pays more than it
/// received. Its pull functions are the existing core entry points the real
/// distributor's harvest() calls, open to anyone, each paying into this
/// contract and nowhere else.
contract TestDistributor is IHolderDistributorIdentity {
    address public immutable factory;
    address public launchToken;
    address public quoteToken;
    address public graduator;

    constructor() {
        factory = msg.sender;
    }

    function initialize(address launchToken_, address quoteToken_, address graduator_) external {
        require(msg.sender == factory && launchToken == address(0), "TestDistributor: init");
        launchToken = launchToken_;
        quoteToken = quoteToken_;
        graduator = graduator_;
    }

    /// Accepts ETH (from WETH, the escrow or the hook) and does nothing else.
    receive() external payable {}

    function pullHook(address hook) external returns (uint256) {
        return ITestHookClaim(hook).claim(quoteToken);
    }

    function pullEscrow(address escrow) external returns (uint256) {
        return ITestEscrowClaim(escrow).claimToken(quoteToken);
    }

    function pullLock(address lock) external {
        ITestLock(lock).claimFees();
    }

    function releaseFromLock(address lock) external {
        ITestLock(lock).release(address(this));
    }

    function sweepCurve(address curve) external {
        ITestCurveSweep(curve).sweepFees(0);
    }
}

/// Deploys one TestDistributor per launch token, at a CREATE2 address salted
/// by the token, idempotently: the same address every time, and a second
/// deploy() returns the first one. The identity comes from the registry
/// record, never from a caller.
contract TestDistributorFactory is IHolderDistributorFactory {
    uint256 public constant VERSION = 0;
    LaunchRegistry public immutable registry;
    address public immutable graduator;

    constructor(LaunchRegistry registry_, address graduator_) {
        registry = registry_;
        graduator = graduator_;
    }

    function deploy(address launchToken) external returns (address d) {
        d = predict(launchToken);
        if (d.code.length != 0) return d;
        LaunchRegistry.Launch memory rec = registry.launchOf(launchToken);
        d = address(new TestDistributor{salt: bytes32(uint256(uint160(launchToken)))}());
        TestDistributor(payable(d)).initialize(launchToken, rec.quoteToken, graduator);
    }

    function predict(address launchToken) public view returns (address) {
        bytes32 h = keccak256(
            abi.encodePacked(
                bytes1(0xff),
                address(this),
                bytes32(uint256(uint160(launchToken))),
                keccak256(type(TestDistributor).creationCode)
            )
        );
        return address(uint160(uint256(h)));
    }
}
