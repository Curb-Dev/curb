// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {FeePolicySnapshot, IPonsV2FeeEscrow, IPonsV2FeePolicy} from "../../src/vendor/interfaces/ILaunchpadV2.sol";

/// @notice ERC-20 with configurable decimals, so a test can stand an 8-decimal
/// quote asset (NVDAc is 8) next to an 18-decimal one.
contract MockQuoteToken is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Stands in for PonsV2LauncherToken. The real one mints its whole
/// supply to the curve in its constructor and the curve's initialize() relies
/// on that, so this does the same and nothing else.
contract MockLaunchToken is ERC20 {
    constructor(uint256 supply, address curve) ERC20("Mock Launch", "MOCK") {
        _mint(curve, supply);
    }
}

/// @notice Records what the curve credits it. Enough to assert fee routing
/// without pulling in the real escrow.
contract MockFeeEscrow is IPonsV2FeeEscrow {
    using SafeERC20 for IERC20;

    mapping(address recipient => uint256 amount) public nativeCredited;
    mapping(address recipient => mapping(address token => uint256 amount)) public tokenCredited;

    function credit(address recipient) external payable {
        nativeCredited[recipient] += msg.value;
    }

    function creditToken(address recipient, address token, uint256 amount) external {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        tokenCredited[recipient][token] += amount;
    }

    function claim() external pure returns (uint256) {
        return 0;
    }

    function claim(uint256) external pure returns (uint256) {
        return 0;
    }

    function claimToken(address) external pure returns (uint256) {
        return 0;
    }

    function claimToken(address, uint256) external pure returns (uint256) {
        return 0;
    }

    function balanceOf(address recipient) external view returns (uint256) {
        return nativeCredited[recipient];
    }

    function balanceOfToken(address recipient, address token) external view returns (uint256) {
        return tokenCredited[recipient][token];
    }
}

/// @notice Fixed fee policy. The curve snapshots this at construction, so the
/// values only have to be right at deploy time.
contract MockFeePolicy is IPonsV2FeePolicy {
    FeePolicySnapshot private _snapshot;
    address private _escrow;
    address private _sweepOperator;

    constructor(FeePolicySnapshot memory snapshot_, address escrow_, address sweepOperator_) {
        _snapshot = snapshot_;
        _escrow = escrow_;
        _sweepOperator = sweepOperator_;
    }

    function protocolFeeShareBps() external view returns (uint256) {
        return _snapshot.protocolFeeShareBps;
    }

    function buybackBurnBps() external view returns (uint256) {
        return _snapshot.buybackBurnBps;
    }

    function protocolFeeRecipient() external view returns (address) {
        return _snapshot.protocolFeeRecipient;
    }

    function feeEscrow() external view returns (IPonsV2FeeEscrow) {
        return IPonsV2FeeEscrow(_escrow);
    }

    function maxInternalPriceImpactBps() external view returns (uint256) {
        return _snapshot.maxInternalPriceImpactBps;
    }

    function feeSweepOperator() external view returns (address) {
        return _sweepOperator;
    }

    function currentFeePolicy() external view returns (FeePolicySnapshot memory) {
        return _snapshot;
    }
}

/// @notice A curve that answers the three questions LaunchRegistry.register
/// asks of the curve a record names, and nothing else. For fixtures that write
/// a record by hand: the registry refuses a record whose curve does not say
/// the record is its own, and one curve serves one record, so each hand-made
/// record needs a curve of its own.
contract RecordCurve {
    address public immutable token;
    address public immutable pairToken;
    address public immutable factory;

    constructor(address token_, address pairToken_, address factory_) {
        token = token_;
        pairToken = pairToken_;
        factory = factory_;
    }
}

/// @notice Makes RecordCurves from its own nonce. Etched at a fixed address by
/// B20ForkTest._recordCurve, so a fixture that takes a curve per record does
/// not move its own nonce - and with it the address, and so the v4 currency
/// order, of every token it deploys afterwards.
contract RecordCurveMaker {
    function make(address token, address pairToken, address factory) external returns (address) {
        return address(new RecordCurve(token, pairToken, factory));
    }
}
