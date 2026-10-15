// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";

import {LaunchRegistry} from "../../src/curb/LaunchRegistry.sol";
import {
    IHolderDistributorFactory,
    IHolderDistributorIdentity,
    IHolderSharingSource,
    IPositionLockSharing
} from "../../src/curb/sharing/ICurbSharing.sol";

// =====================================================================
// Mocks of the CURB core, as seen by a holder fee distributor. Each one
// implements the pinned interface (ICurbSharing.sol) or the existing entry
// point the distributor calls (core v2 design, section E.2), and pays the
// way the real contract does: the escrow and the hook pay a WETH launch in
// ETH and fall back to WETH; the curve's sweep credits the escrow; the lock
// collects into itself and pushes, or holds for the same recipient.
// =====================================================================

/// WETH9 as deployed on Base (0x4200...0006): withdraw sends with transfer(),
/// i.e. a 2300 gas stipend. Etched at the predeploy address, so it keeps no
/// constructor state.
contract MockWETH9 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function deposit() public payable {
        balanceOf[msg.sender] += msg.value;
    }

    function withdraw(uint256 wad) external {
        require(balanceOf[msg.sender] >= wad, "weth: balance");
        balanceOf[msg.sender] -= wad;
        payable(msg.sender).transfer(wad);
    }

    function totalSupply() external view returns (uint256) {
        return address(this).balance;
    }

    function approve(address s, uint256 wad) external returns (bool) {
        allowance[msg.sender][s] = wad;
        return true;
    }

    function transfer(address to, uint256 wad) external returns (bool) {
        return transferFrom(msg.sender, to, wad);
    }

    function transferFrom(address from, address to, uint256 wad) public returns (bool) {
        require(balanceOf[from] >= wad, "weth: balance");
        if (from != msg.sender && allowance[from][msg.sender] != type(uint256).max) {
            require(allowance[from][msg.sender] >= wad, "weth: allowance");
            allowance[from][msg.sender] -= wad;
        }
        balanceOf[from] -= wad;
        balanceOf[to] += wad;
        return true;
    }

    receive() external payable {
        deposit();
    }
}

contract Tok is ERC20 {
    uint8 private immutable _dec;

    constructor(string memory n, uint8 dec_) ERC20(n, n) {
        _dec = dec_;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }
}

/// A quote whose issuer can refuse to deliver to (or from) one address, like a
/// B20 policy block.
contract BlockingTok is Tok {
    mapping(address => bool) public blocked;

    constructor() Tok("NVDAc", 8) {}

    function setBlocked(address a, bool b) external {
        blocked[a] = b;
    }

    function _update(address from, address to, uint256 v) internal override {
        require(!blocked[to] && !blocked[from], "blocked");
        super._update(from, to, v);
    }
}

/// Returns true from transfer but moves more than asked (takes a fee from the
/// sender on top).
contract GreedyTok is Tok {
    constructor() Tok("GREEDY", 18) {}

    function transfer(address to, uint256 v) public override returns (bool) {
        _transfer(msg.sender, to, v);
        _burn(msg.sender, 1);
        return true;
    }
}

/// Returns false instead of reverting.
contract FalseTok is Tok {
    bool public refuse;

    constructor() Tok("FALSE", 18) {}

    function setRefuse(bool r) external {
        refuse = r;
    }

    function transfer(address to, uint256 v) public override returns (bool) {
        if (refuse) return false;
        return super.transfer(to, v);
    }
}

/// Burns all the gas it is given on a transfer to `victim`.
contract GasBurningTok is Tok {
    address public victim;

    constructor() Tok("BURN", 18) {}

    function setVictim(address v) external {
        victim = v;
    }

    function transfer(address to, uint256 v) public override returns (bool) {
        if (to == victim) {
            while (true) {}
        }
        return super.transfer(to, v);
    }
}

contract MockRegistry {
    mapping(address => LaunchRegistry.Launch) internal _recs;

    function set(address token, LaunchRegistry.Launch memory r) external {
        _recs[token] = r;
    }

    function launchOf(address token) external view returns (LaunchRegistry.Launch memory r) {
        r = _recs[token];
        require(r.curve != address(0), "NotRegistered");
    }

    function isRegistered(address token) external view returns (bool) {
        return _recs[token].curve != address(0);
    }
}

/// The FeeEscrow's claim side: credits are claimable by their recipient; WETH
/// leaves as ETH (all gas), falling back to WETH.
contract MockEscrow {
    address constant WETH = 0x4200000000000000000000000000000000000006;
    mapping(address => mapping(address => uint256)) public balanceOfToken;

    /// Takes `amount` of `token` from the caller and credits it to `to`.
    function creditToken(address to, address token, uint256 amount) external {
        IERC20(token).transferFrom(msg.sender, address(this), amount);
        balanceOfToken[to][token] += amount;
    }

    function claimToken(address token) external returns (uint256 a) {
        a = balanceOfToken[msg.sender][token];
        require(a != 0, "NothingToClaim");
        balanceOfToken[msg.sender][token] = 0;
        if (token == WETH) {
            MockWETH9(payable(WETH)).withdraw(a);
            (bool sent,) = msg.sender.call{value: a}("");
            if (sent) return a;
            MockWETH9(payable(WETH)).deposit{value: a}();
        }
        require(IERC20(token).transfer(msg.sender, a), "transfer");
    }

    receive() external payable {}
}

/// The PONS curve as the distributor sees it: `factory` is the Graduator,
/// `deployer` is the creator fee recipient, sweepFees is open to the deployer
/// and credits its pending tax to the escrow, rescueFees (Graduator-only) pays
/// the deployer directly.
contract MockCurve {
    address public immutable factory;
    MockEscrow public immutable escrowContract;
    address public deployer;
    bool public graduated;
    uint256 public pendingTax;
    IERC20 public immutable quote;
    /// Counts sweeps attempted after graduation, which the real curve refuses
    /// (AlreadyGraduated). Kept as a counter so a test can see a distributor
    /// that tries anyway.
    uint256 public lateSweeps;
    bool public refuseSweep;

    constructor(address factory_, MockEscrow escrow_, address deployer_, IERC20 quote_) {
        factory = factory_;
        escrowContract = escrow_;
        deployer = deployer_;
        quote = quote_;
    }

    function feeEscrow() external view returns (address) {
        return address(escrowContract);
    }

    function setCreatorFeeRecipient(address r) external {
        require(msg.sender == factory, "onlyFactory");
        deployer = r;
    }

    function setGraduated() external {
        graduated = true;
    }

    function setRefuseSweep(bool r) external {
        refuseSweep = r;
    }

    /// Creator tax accrues here; the test funds it first.
    function accrue(uint256 a) external {
        pendingTax += a;
    }

    function sweepFees(uint256) external {
        if (graduated) {
            lateSweeps++;
            return;
        }
        require(!refuseSweep, "InternalSwapRequiresOperator");
        require(msg.sender == deployer, "NotFeeSweepOperator");
        uint256 a = pendingTax;
        require(a != 0, "ZeroAmount");
        pendingTax = 0;
        quote.approve(address(escrowContract), a);
        escrowContract.creditToken(deployer, address(quote), a);
    }

    function rescueFees() external returns (uint256, uint256) {
        require(msg.sender == factory, "onlyFactory");
        uint256 a = pendingTax;
        pendingTax = 0;
        require(quote.transfer(deployer, a), "transfer");
        return (0, a);
    }
}

/// The FeeHook's claim side: `owed` per recipient; WETH leaves as ETH (all
/// gas) and falls back to WETH; a direct take is a plain transfer.
contract MockHook {
    address constant WETH = 0x4200000000000000000000000000000000000006;
    mapping(address => mapping(address => uint256)) public owed;

    function accrueOwed(address to, address token, uint256 a) external {
        owed[to][token] += a;
    }

    function directTake(address to, address token, uint256 a) external {
        require(IERC20(token).transfer(to, a), "transfer");
    }

    function claim(address token) external returns (uint256 a) {
        a = owed[msg.sender][token];
        require(a != 0, "NothingOwed");
        owed[msg.sender][token] = 0;
        if (token == WETH) {
            MockWETH9(payable(WETH)).withdraw(a);
            (bool sent,) = msg.sender.call{value: a}("");
            if (sent) return a;
            MockWETH9(payable(WETH)).deposit{value: a}();
        }
        require(IERC20(token).transfer(msg.sender, a), "transfer");
    }

    receive() external payable {}
}

/// The PositionLock's sharing side (IPositionLockSharing): fees accrue "in the
/// position" (here: in this contract, uncollected); claimFees collects them
/// and pushes to the live fee recipient, or holds them for it; release pays a
/// party's held amounts.
contract MockLock is IPositionLockSharing {
    IHolderSharingSource public immutable source;
    address public immutable launchToken;
    address public immutable beneficiary;
    IERC20 public immutable c0;
    IERC20 public immutable c1;
    uint256 public uncollected0;
    uint256 public uncollected1;
    bool public holdsPosition = true;
    mapping(address => uint256[2]) internal _held;

    constructor(IHolderSharingSource s, address token, address ben, IERC20 c0_, IERC20 c1_) {
        source = s;
        launchToken = token;
        beneficiary = ben;
        c0 = c0_;
        c1 = c1_;
    }

    function accrue(uint256 a0, uint256 a1) external {
        uncollected0 += a0;
        uncollected1 += a1;
    }

    function setHoldsPosition(bool h) external {
        holdsPosition = h;
    }

    function held(address party, uint256 i) external view returns (uint256) {
        return _held[party][i];
    }

    function feeRecipient() public view returns (address) {
        address d = source.holderDistributorOf(launchToken);
        return d != address(0) ? d : beneficiary;
    }

    function claimFees() external {
        require(holdsPosition, "NoPosition");
        address to = feeRecipient();
        uint256 a0 = uncollected0;
        uint256 a1 = uncollected1;
        uncollected0 = 0;
        uncollected1 = 0;
        _payOrHold(c0, to, a0, 0);
        _payOrHold(c1, to, a1, 1);
    }

    function _payOrHold(IERC20 c, address to, uint256 a, uint256 i) private {
        if (a == 0) return;
        try c.transfer(to, a) returns (bool ok) {
            if (ok) return;
        } catch {}
        _held[to][i] += a;
    }

    function release(address party) external {
        uint256 a0 = _held[party][0];
        uint256 a1 = _held[party][1];
        require(a0 != 0 || a1 != 0, "NothingHeld");
        _held[party][0] = 0;
        _held[party][1] = 0;
        if (a0 != 0) require(c0.transfer(party, a0), "transfer");
        if (a1 != 0) require(c1.transfer(party, a1), "transfer");
    }
}

/// The Graduator as a sharing source (IHolderSharingSource), plus the parts of
/// _enable a distributor depends on: deploy through the factory, the identity
/// checks, the write-once switch with its block, and the curve redirect.
contract MockSharingGraduator is IHolderSharingSource {
    address public immutable registry;
    address public immutable poolManager;
    address public immutable positionManager;
    mapping(address => address) public holderDistributorOf;
    mapping(address => uint64) public sharingSince;
    mapping(address => address) public lockOf;
    mapping(address => bool) public hasGraduated;

    constructor(address registry_, address pm, address posm) {
        registry = registry_;
        poolManager = pm;
        positionManager = posm;
    }

    function enable(address token, address factory) external returns (address d) {
        require(holderDistributorOf[token] == address(0), "AlreadySharing");
        d = IHolderDistributorFactory(factory).deploy(token);
        LaunchRegistry.Launch memory rec = MockRegistry(registry).launchOf(token);
        require(d.code.length != 0, "NoCode");
        require(IHolderDistributorIdentity(d).launchToken() == token, "token");
        require(IHolderDistributorIdentity(d).quoteToken() == rec.quoteToken, "quote");
        require(IHolderDistributorIdentity(d).graduator() == address(this), "graduator");
        holderDistributorOf[token] = d;
        sharingSince[token] = uint64(block.number);
        if (!hasGraduated[token]) MockCurve(rec.curve).setCreatorFeeRecipient(d);
    }

    /// Points a token's switch at any address, for tests of what a distributor
    /// does when the switch is not (or no longer) its own.
    function forceSwitch(address token, address d) external {
        holderDistributorOf[token] = d;
        sharingSince[token] = uint64(block.number);
    }

    function graduate(address token, address lock) external {
        hasGraduated[token] = true;
        lockOf[token] = lock;
        LaunchRegistry.Launch memory rec = MockRegistry(registry).launchOf(token);
        MockCurve(rec.curve).setGraduated();
    }

    function rescue(address curve) external {
        MockCurve(curve).rescueFees();
    }
}

// ---------------------------------------------------------------- holders

contract EthRefuser {
    receive() external payable {
        revert("no ETH");
    }
}

contract EthGasBurner {
    receive() external payable {
        while (true) {}
    }
}

/// Tries to re-enter the distributor from its ETH receive.
contract Reenterer {
    address public target;
    bytes public data;
    bool public reverted;
    bytes public revertData;

    function arm(address t, bytes calldata d) external {
        target = t;
        data = d;
    }

    receive() external payable {
        if (target == address(0)) return;
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            reverted = true;
            revertData = ret;
        }
    }
}

/// An account that claims for itself, as a contract wallet would.
contract ClaimingWallet {
    function claim(address d, uint256 c0, uint256 c1, bytes32[] calldata p, address to) external {
        (bool ok, bytes memory ret) =
            d.call(abi.encodeWithSignature("claim(uint256,uint256,bytes32[],address)", c0, c1, p, to));
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }

    receive() external payable {
        revert("contract wallet takes no ETH");
    }
}

/// Builds a LaunchRegistry.Launch by field, so the record can grow at its end
/// without breaking this file.
library LaunchRecords {
    function make(address curve, address quote, address beneficiary, address hook)
        internal
        pure
        returns (LaunchRegistry.Launch memory r)
    {
        r.curve = curve;
        r.quoteToken = quote;
        r.beneficiary = beneficiary;
        r.refundTo = beneficiary;
        r.fee = 3000;
        r.tickSpacing = 60;
        r.hooks = IHooks(hook);
        r.totalTaxBps = 300;
        r.platformBps = 50;
        r.platformRecipient = address(0x91A7);
    }
}
