// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {stdError} from "forge-std/StdError.sol";
// FOR READING THE HOOK'S OWN EVENTS. forge-std's Test.sol imports Vm by
// name, which does not put the type in scope here.
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/IERC6093.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Pool} from "@uniswap/v4-core/src/libraries/Pool.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {ActionConstants} from "@uniswap/v4-periphery/src/libraries/ActionConstants.sol";
import {ExactInputSingleLegacy} from "./B20HookedPool.t.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";

import {PonsV2BondingCurve} from "../../src/vendor/PonsV2BondingCurve.sol";
import {PonsV2BondingCurveMath} from "../../src/vendor/PonsV2BondingCurveMath.sol";
import {DevBuyCap} from "../harness/DevBuyCap.sol";
import {PonsV2BuybackVault} from "../../src/vendor/PonsV2BuybackVault.sol";
import {FeePolicySnapshot, IPonsV2FeeEscrow, IPonsV2FeePolicy} from "../../src/vendor/interfaces/ILaunchpadV2.sol";

import {Graduator, IPermit2Minimal} from "../../src/curb/Graduator.sol";
import {LaunchRegistry} from "../../src/curb/LaunchRegistry.sol";
import {CurbLaunchFactory} from "../../src/curb/CurbLaunchFactory.sol";
import {CurbLaunchToken} from "../../src/curb/CurbLaunchToken.sol";
import {PositionLock, IPositionManagerMinimal} from "../../src/curb/PositionLock.sol";
import {DoubleGraduation, DoubleFinisher} from "../harness/DoubleGraduation.sol";
import {FeeHook} from "../../src/curb/FeeHook.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {FeeEscrow} from "../../src/curb/FeeEscrow.sol";
import {FeePolicy} from "../../src/curb/FeePolicy.sol";
import {LaunchLens} from "../../src/curb/LaunchLens.sol";
import {SharingCatalog} from "../../src/curb/SharingCatalog.sol";
import {ISharingCatalog} from "../../src/curb/sharing/ICurbSharing.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {B20ForkTest, ISafe} from "./B20ForkTest.sol";

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IPermit2Approve {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}
import {PoolHarness} from "./B20UniswapV4.t.sol";
// THE SAME USDT SHAPE THE MULTI-ASSET GRADUATIONS RUN AGAINST, imported rather
// than copied so there is one definition of what "USDT-shaped" means here.
import {UsdtShapedToken} from "./B20MultiAsset.t.sol";

/// The deployed router's exact-output params, in its own field order - the
/// counterpart of ExactInputSingleLegacy.
struct ExactOutputSingleLegacy {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 amountOut;
    uint128 amountInMaximum;
    bytes hookData;
}

interface IPositionManagerLike {
    function getPositionLiquidity(uint256 tokenId) external view returns (uint128);
    function nextTokenId() external view returns (uint256);
}

/// @notice A launch token whose burn() moves the tokens somewhere else instead
///         of destroying them - balance emptied, totalSupply untouched.
///
/// Written to be storage-layout compatible with CurbLaunchToken (OpenZeppelin
/// ERC20 followed by one string) so it can be vm.etch'd over a real launch
/// token: the code changes, the balances and the supply stay exactly where
/// they were. Mocking burn() into a no-op cannot express this adversary,
/// because a no-op leaves the graduator's balance in place - which is why the
/// old balance-only check passed that test.
contract MovingBurnToken is ERC20 {
    string private _tokenUri;

    address internal constant SINK = address(0xdead);

    constructor() ERC20("moving", "MOVE") {}

    function burn(uint256 amount) external {
        _transfer(msg.sender, SINK, amount);
    }

    function tokenURI() external view returns (string memory) {
        return _tokenUri;
    }
}

/// @notice A launch token that under-delivers ONLY the curve's handover to the
///         graduator, and is otherwise completely honest - including a real
///         burn().
///
/// THE HONESTY MATTERS FOR THE MUTATION. A first version simply halved every
/// transfer and had no burn() at all. With the arrival check removed,
/// graduation would then have failed at the burn instead - so the test failing
/// under mutation proved only that SOMETHING went wrong, not that the missing
/// check was what stopped a bad graduation completing. This one lets a
/// graduation run to completion on a short reserve, which is the thing the
/// check exists to prevent.
///
/// The target is an immutable, so it survives into the runtime code that gets
/// etched. Storage layout matches CurbLaunchToken: OpenZeppelin ERC20 followed
/// by one string.
contract ShortDeliveryToken is ERC20 {
    string private _tokenUri;

    address public immutable underDeliverTo;

    constructor(address underDeliverTo_) ERC20("short", "SHORT") {
        underDeliverTo = underDeliverTo_;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        // Half to the graduator, honest to everyone else - so the refund and
        // any other movement behave normally.
        _transfer(msg.sender, to, to == underDeliverTo ? amount / 2 : amount);
        return true;
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    function tokenURI() external view returns (string memory) {
        return _tokenUri;
    }
}

/// @notice A hook that refuses liquidity, for failing a mint on purpose.
contract LiquidityRefusingHook {
    error LiquidityRefused();

    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert LiquidityRefused();
    }
}

/**
 * @title B20GraduationForkTest
 * @notice Graduation against the REAL bonding curve, driven to its threshold by
 *         real buys, on the pinned Base fork with real NVDAc.
 *
 * SCOPE. Graduation moves the token the launch ALREADY created, plus the
 * curve's reserves, into a pool. It does not create a token.
 *
 * THE STARTING STATE IS REACHED WITH PRODUCT CONTRACTS, NOT WITH vm.prank
 *   These tests used to set up by impersonating the curve's factory role:
 *       vm.prank(address(graduator)); curve.initialize(address(token));
 *   That made graduation testable from a state no product contract could
 *   produce - a shape, not a system. CurbLaunchFactory.launch() now creates
 *   the curve, the token, the initialization and the registry record in one
 *   real transaction, and every test below starts from its output.
 *
 * WHY THE REAL CURVE AND NOT A BALANCE HOLDER
 *   An earlier version of this file used a contract that merely held two
 *   balances, so "the pool opens at the curve's price" only ever checked the
 *   ratio of two numbers the test itself had chosen. It could not have caught
 *   the thing that actually matters:
 *
 *     the curve PRICES against   phantomQuote + trackedQuote - fees
 *     but can only HAND OVER     trackedQuote
 *
 *   The transferable reserves are short of the priced reserves by the virtual
 *   liquidity. Seeding a pool at the ratio of what was handed over opens it
 *   BELOW the curve's last price - an arbitrage gap handed to whoever is
 *   watching, paid for by the people who bought on the curve. Only a real
 *   curve, bought up to its threshold, puts a number on that.
 *
 * ACCEPTANCE CRITERIA
 *   1. curve reserves -> pool -> LP NFT -> lock with the right beneficiary and
 *      duration, in ONE transaction
 *   2. TWO different things, which an earlier version confused:
 *        (a) a permanently broken configuration is refused BEFORE the launch
 *            opens for sale, because afterwards it cannot be corrected
 *        (b) a TRANSIENT failure rolls its attempt back completely - including
 *            the hasGraduated flag - and the SAME record graduates once the
 *            condition clears
 *   3. the pool's opening price equals the CURVE'S final price - not the ratio
 *      of what it transferred - with token ordering and the 8-vs-18 decimals
 *      difference accounted for, asserted in both orderings
 *   4. nobody but the launcher can graduate, and nothing economic is a caller
 *      argument
 *   5. a pool someone else tries to open first is PREVENTED, not merely
 *      detected, and graduation still completes afterwards
 */
interface IV3PoolMinimal {
    function token0() external view returns (address);
    function slot0()
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool);
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

/// SELLS NVDAc INTO THE v3 POOL FOR WETH, and pays the callback out of its own
/// balance. Deliberately not the UniversalRouter: the router does this leg with
/// three other commands around it, and what is wanted here is the exit leg's
/// own cost, with nothing else in the way.
contract V3ExitHarness {
    address internal constant NVDAC_ = 0xb20000000000000000000078ee7ce2fE4908108C;
    uint160 internal constant MIN_SQRT = 4295128740;
    uint160 internal constant MAX_SQRT = 1461446703485210103287273052203988822378723970341;

    /// RETURNS WHAT WAS SPENT AS WELL AS WHAT CAME BACK. An exact-input swap
    /// that reaches its price limit fills PARTIALLY: the pool takes what it can
    /// and the rest stays here. Charging the whole offer as the cost of the
    /// fill is the same mistake the depth work made once already, so the spent
    /// leg is read off the deltas rather than assumed to be `amountIn`.
    function sell(address pool, uint256 amountIn) external returns (uint256 wethOut, uint256 spent) {
        bool zeroForOne = IV3PoolMinimal(pool).token0() == NVDAC_;
        (int256 a0, int256 a1) = IV3PoolMinimal(pool).swap(
            address(this), zeroForOne, int256(amountIn), zeroForOne ? MIN_SQRT : MAX_SQRT, ""
        );
        (int256 inp, int256 out) = zeroForOne ? (a0, a1) : (a1, a0);
        wethOut = uint256(-out);
        spent = uint256(inp);
    }

    function nvdacLeft() external view returns (uint256) {
        return IERC20(NVDAC_).balanceOf(address(this));
    }

    /// Only NVDAc is ever owed here - it is the only thing being sold - so the
    /// positive delta, whichever side it lands on, is the amount to hand over.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        uint256 owed = amount0Delta > 0 ? uint256(amount0Delta) : uint256(amount1Delta);
        IERC20(NVDAC_).transfer(msg.sender, owed);
    }
}


/// A fee recipient with no way to receive ether at all - no receive, no
/// fallback. Not contrived: a great many contracts are written this way, and
/// one of them will eventually be somebody's creator wallet.
contract EthRefuser {
    function collect(FeeHook hook, address token) external returns (uint256) {
        return hook.claim(token);
    }
}

/// A claimant whose receive() tries to claim again, and records what happened
/// instead of reverting - so the ether is accepted and the attempt is visible.
contract ReentrantClaimant {
    FeeHook public hook;
    address public token;
    bytes public reentryError;
    bool public reentered;

    function collect(FeeHook h, address t) external returns (uint256) {
        hook = h;
        token = t;
        return h.claim(t);
    }

    receive() external payable {
        if (address(hook) == address(0)) return;
        try hook.claim(token) returns (uint256) {
            reentered = true;
        } catch (bytes memory e) {
            reentryError = e;
        }
    }
}

/// A fee recipient whose receive() does more work than the hook's stipend
/// covers. Writing cold storage slots is the cheapest honest way to spend
/// more than thirty thousand gas without pretending to loop forever.
contract ExpensiveReceiver {
    mapping(uint256 => uint256) private _scratch;

    function collect(FeeHook hook, address token) external returns (uint256) {
        return hook.claim(token);
    }

    receive() external payable {
        for (uint256 i = 0; i < 4; i++) {
            _scratch[i] = block.number + i + 1;
        }
    }
}

/// A CURVE THAT HANDS THE GRADUATOR MORE QUOTE THAN ITS OWN PRICE ABSORBS.
///
/// No real curve does this: with phantom liquidity the quote is the binding
/// side and the refund measures zero. That is why _refund's transfer was never
/// reached with a non-zero amount, and why a raw bool-decoding transfer, or no
/// transfer at all, survived every test. This one quotes its price from
/// (pricedQuote, pricedTokens) and hands over `heldQuote` against the same
/// tokens, so the token side binds and the extra quote is left for the refund.
///
/// The quote is USDT-shaped: its transfer returns nothing, which is exactly
/// what a raw `if (!transfer(...))` cannot decode.
contract OverQuotedCurve {
    UsdtShapedToken public immutable quote;
    uint256 public immutable pricedQuote;
    uint256 public immutable pricedTokens;
    uint256 public immutable heldQuote;
    /// The graduator it answers to. The registry asks a record's curve for its
    /// token, its asset and its factory, and refuses a record the curve does
    /// not vouch for.
    address public immutable factory;
    IERC20 public token;

    constructor(
        UsdtShapedToken quote_,
        uint256 pricedQuote_,
        uint256 pricedTokens_,
        uint256 heldQuote_,
        address factory_
    ) {
        quote = quote_;
        pricedQuote = pricedQuote_;
        pricedTokens = pricedTokens_;
        heldQuote = heldQuote_;
        factory = factory_;
    }

    function setToken(IERC20 token_) external {
        token = token_;
    }

    function pairToken() external view returns (address) {
        return address(quote);
    }

    function getReserves() external view returns (uint256, uint256) {
        return (pricedQuote, pricedTokens);
    }

    function readyToGraduate() external pure returns (bool) {
        return true;
    }

    function initialize(address) external pure {}

    function graduate(address to) external returns (uint256 quoteOut, uint256 tokenOut) {
        quoteOut = heldQuote;
        tokenOut = token.balanceOf(address(this));
        quote.transfer(to, quoteOut);
        require(token.transfer(to, tokenOut), "token transfer failed");
    }
}

/// A LAUNCHER THAT CLOSES THE REGISTRY'S LOOP AND WILL NOT NAME ITS ESCROW.
///
/// Its graduator is the fixture's, so every check the registry made before
/// passes; the only thing missing is feeEscrow(), which reverts until
/// sayZero() makes it answer address zero.
contract NoEscrowLauncher {
    address public immutable graduator;
    bool private _zero;

    constructor(address graduator_) {
        graduator = graduator_;
    }

    function sayZero() external {
        _zero = true;
    }

    function feeEscrow() external view returns (address) {
        require(_zero, "no escrow");
        return address(0);
    }
}

/// A JUNK LAUNCHER THAT PASSES ADMISSION AND THEN COSTS EVERY LAUNCH.
///
/// With full gas it names the fixture's graduator and an escrow, so the
/// registry admits it. Starved - as the factory's and the hook's gas-capped
/// probes call it - every answer spins until the probe's gas is gone.
contract JunkLauncher {
    address public immutable graduator;

    constructor(address graduator_) {
        graduator = graduator_;
    }

    function feeEscrow() external view returns (address) {
        if (gasleft() < 100_000) _spin();
        return address(0xBEEF);
    }

    fallback() external {
        _spin();
    }

    function _spin() private pure {
        uint256 i;
        while (i != type(uint256).max) i++;
    }
}

/// A PLATFORM RECIPIENT THAT BURNS ALL THE GAS IT IS SENT.
contract GasBurningRecipient {
    receive() external payable {
        uint256 i;
        while (i != type(uint256).max) i++;
    }
}

/// Somebody's NFT, for showing where it can and cannot be sent.
contract StrayNft is ERC721 {
    constructor() ERC721("Stray", "STRAY") {}

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }
}


/// A fee recipient that re-enters the pool manager from inside its receive().
///
/// NOT CONTRIVED. take() is callable by anybody while the manager is unlocked
/// - PoolManager.sol:291, onlyWhenUnlocked and nothing else - and it records
/// the debt against msg.sender. A delta nobody settles makes unlock() revert
/// the entire transaction, which here is somebody else's swap.
contract TakingReceiver {
    IPoolManager private immutable manager;
    address private immutable weth;

    constructor(IPoolManager manager_, address weth_) {
        manager = manager_;
        weth = weth_;
    }

    function collect(FeeHook hook, address token) external returns (uint256) {
        return hook.claim(token);
    }

    receive() external payable {
        // ONE WEI, AND IT IS NEVER SETTLED. The point is the delta, not the
        // money: a nonzero count at the end of unlock() reverts everything.
        // Wrapped in a try so a stipend too small to reach this leaves the
        // call SUCCEEDING, which is what the hook would see either way.
        try manager.take(Currency.wrap(weth), address(this), 1) {} catch {}
    }
}

/// Burns every unit of gas it is given.
contract GasBurner {
    fallback() external {
        while (true) {}
    }
}

/// Answers every call with a megabyte of zeros.
contract HugeReturner {
    fallback() external {
        assembly {
            return(0, 0x100000)
        }
    }
}

contract B20GraduationForkTest is B20ForkTest {

    /// A sharing catalog for a Graduator under test: this contract owns it and
    /// may bootstrap it. Nothing is admitted unless a test admits it.
    function _catalog() internal returns (ISharingCatalog) {
        return ISharingCatalog(address(new SharingCatalog(address(this), address(this))));
    }
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager internal constant POOL_MANAGER = IPoolManager(0x498581fF718922c3f8e6A244956aF099B2652b2b);
    IPositionManagerLike internal constant POSM = IPositionManagerLike(0x7C5f5A4bBd8fD63184577525326123B519429bDc);
    IPermit2Minimal internal constant PERMIT2 = IPermit2Minimal(0x000000000022D473030F116dDEE9F6B43aC78BA3);

    address internal constant NVDAC = 0xb20000000000000000000078ee7ce2fE4908108C;
    /// A SECOND REAL B20, for the tests that need two quote assets. Verified
    /// on chain: isB20 true, 8 decimals, policy 5 - MULTI_RWA.txt 2.1.
    address internal constant AAPLC = 0xb200000000000000000000C2e324d24d7eEcd1fb;
    address internal constant NVDAC_HOLDER = 0x4446Adc0B8136Ffc55DdB7a488Ba5509Ace2A5ef;
    /// Holds ~5,797 NVDAc at the pinned block, against NVDAC_HOLDER's ~13.3.
    /// Found by scanning Transfer logs in a 400-block window and ranking the
    /// addresses by balance; needed because a 60 NVDAc depth fixture does not
    /// fit inside the smaller holder. Deliberately NOT the v4 PoolManager,
    /// which also holds a large balance but whose balance IS pool accounting.
    address internal constant NVDAC_WHALE = 0x853F5f1B92b16714Fe6CDA67CAad0856B83C7ab9;

    /// Base's PolicyRegistry precompile, and the error a B20 raises when it
    /// refuses. Declared here rather than imported so this file stays readable
    /// on its own; B20Restrictions declares the same pair for the same reason.
    ///
    /// THE NAME MATTERS. It is 0xa43fec12 because it is called PolicyForbids;
    /// a local alias hashes to something else and the assertion can never
    /// match, however right its arguments are.
    address internal constant POLICY_REG = 0x8453000000000000000000000000000000000002;
    error PolicyForbids(bytes32 policyScope, uint64 policyId);

    uint8 internal constant NVDAC_DECIMALS = 8;
    uint8 internal constant LAUNCH_DECIMALS = 18;

    /// THE SHIPPING TIER, so the suite measures the pool we intend to deploy.
    /// It was 3000 while that was the demo's leftover; the decision on
    /// 2026-09-16 made it 0.05%. The tier-3000 rows in DEPTH.txt were a
    /// COMPARISON and the tests that produced them name 3000 explicitly, so
    /// they still reproduce.
    uint24 internal constant FEE = 500;
    int24 internal constant TICK_SPACING = 10;

    // Curve economics, in NVDAc's own 8 decimals.
    uint256 internal constant SUPPLY = 1_000_000_000e18;
    // THE SHIPPED NVDAc TERMS, DeployCurb's own, not a number chosen to fit
    // the fixture - the 2026-10-03 shape, about $4K at the start and $55K at
    // graduation, at NVDAc's price of 2026-10-15 ($216.53). They were 18.1 /
    // 49.1 at the price D1 sized NVDAc at; the re-pricing moved them by 2%.
    //   r = phantom / (phantom + threshold) = 18.5 / 68.5, about 0.27, so the
    //   supply splits about 73.0% to buyers / 19.7% to the LP / 7.3%
    //   remainder, and the curve's price runs about 13.7x from the first
    //   buyer to the last.
    //   UNTIL 2026-10-03 THIS WAS D1'S 60/60 (r = 0.5): 50/25/25 and 4x. The
    //   threshold 60 NVDAc was what held a 1 NVDAc buy at or under 3% of
    //   execution cost against the opening pool - see the costLimit tests,
    //   which still measure that r = 0.5 grid on their own terms. The shipped
    //   pool is thinner than that, by the owner's choice.
    // Earlier revisions used 30/5 because that fitted the small NVDAc holder,
    // which made a fixture constraint look like product economics. It needs
    // NVDAC_WHALE, and that is the right way round.
    uint256 internal constant PHANTOM_QUOTE = 18.5e8; // virtual: never transferable
    uint256 internal constant GRADUATION_THRESHOLD = 50e8;
    uint256 internal constant TRADER_FUNDING = 66e8;
    /// The ONE tax a launch charges. The platform's fixed 50 bps comes out of
    /// it and the creator takes the remaining 250. Chosen inside the registry's
    /// 100..500 band, like any creator would.
    uint16 internal constant TOTAL_TAX_BPS = 300;
    uint256 internal constant PLATFORM_FEE_BPS = 50;
    uint256 internal constant CREATOR_TAX_BPS = TOTAL_TAX_BPS - PLATFORM_FEE_BPS;
    uint16 internal constant PROTOCOL_SHARE_BPS = 10_000;

    address internal launcher = makeAddr("launcher");
    address internal creator = makeAddr("creator");
    address internal refundTo = makeAddr("refund");
    address internal attacker = makeAddr("attacker");
    address internal trader = makeAddr("curve-trader");
    address internal protocolRecipient = makeAddr("protocol");

    LaunchRegistry internal registry;
    Graduator internal graduator;
    CurbLaunchFactory internal factory;
    LaunchLens internal lens;
    FeeHook internal hook;
    FeePolicySnapshot internal snapshot;
    uint256 internal saltCounter;

    IPonsV2FeePolicy internal feePolicy;
    IPonsV2FeeEscrow internal feeEscrow;
    /// The concrete escrow, kept because the interface cannot be asked what it
    /// credited to whom - and "what each side was actually paid" is the only
    /// form of the fee question worth asserting.
    FeeEscrow internal escrowMock;
    PonsV2BuybackVault internal buybackVault;

    function setUp() public {
        if (!_forkGuard()) return;

        // The real wiring. The cycle - registry needs the factory, the factory
        // needs the graduator, the graduator needs the registry - is broken by
        // one write-once pointer rather than a mutable owner.
        registry = new LaunchRegistry(address(this));
        graduator = new Graduator(POOL_MANAGER, IPositionManagerMinimal(address(POSM)), PERMIT2, registry, _catalog());
        hook = _mineHook(address(graduator), registry);

        FeeEscrow escrow = new FeeEscrow(NVDAC);
        escrowMock = escrow;
        snapshot = FeePolicySnapshot({
            protocolFeeRecipient: protocolRecipient,
            protocolFeeShareBps: PROTOCOL_SHARE_BPS,
            buybackBurnBps: 0,
            hookFeeBps: 0,
            maxInternalPriceImpactBps: 500
        });
        // THE REAL POLICY, not a mock. This file tests the product stack, so
        // the stack it builds has to be the one a deployment builds - and the
        // real policy's feeSweepOperator is a constant zero rather than an
        // argument, which is the behaviour the sweep tests depend on.
        FeePolicy policy =
            new FeePolicy(protocolRecipient, IPonsV2FeeEscrow(address(escrow)), 500);
        PonsV2BuybackVault vault =
            new PonsV2BuybackVault(address(this), IPonsV2FeePolicy(address(policy)), IPonsV2FeeEscrow(address(escrow)));

        factory = new CurbLaunchFactory(
            registry,
            graduator,
            NVDAC,
            IPonsV2FeePolicy(address(policy)),
            IPonsV2FeeEscrow(address(escrow)),
            vault,
            _terms(IHooks(address(hook)), FEE, TICK_SPACING)
        );
        registry.wire(address(factory), address(hook));
        lens = new LaunchLens(registry, graduator);

        feePolicy = IPonsV2FeePolicy(address(policy));
        feeEscrow = IPonsV2FeeEscrow(address(escrow));
        buybackVault = vault;

    }

    /// The graduator is the only address allowed to open a pool carrying this
    /// hook. Mined before the factory exists, because the registry is wired to
    /// this exact address.
    /// THE REGISTRY IS AN ARGUMENT, because a hook reads its rates out of one.
    /// A hook mined against the main registry but wired into a second stack
    /// would look right and then find no record for that stack's launches.
    function _mineHook(address poolOpener, LaunchRegistry reg) internal returns (FeeHook) {
        return _mineHookPaying(protocolRecipient, poolOpener, reg);
    }

    /// The same, paying `recipient` as the platform from its construction.
    function _mineHookPaying(address recipient, address poolOpener, LaunchRegistry reg) internal returns (FeeHook) {
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
                | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        (address hookAddress, bytes32 salt) = HookMiner.find(
            address(this),
            flags,
            type(FeeHook).creationCode,
            abi.encode(POOL_MANAGER, recipient, reg, poolOpener, address(this))
        );
        FeeHook mined = new FeeHook{salt: salt}(POOL_MANAGER, recipient, reg, poolOpener, address(this));
        require(address(mined) == hookAddress, "hook did not deploy to the mined address");
        return mined;
    }

    /// A SECOND, independently wired stack. Used only by the deep-failure test,
    /// which needs a launch whose pool nobody is gating - i.e. the world before
    /// FeeHook's beforeInitialize existed.
    /// A second, unwired stack. wire() is what these tests are aimed at, so it
    /// is deliberately NOT called here.
    function _deployUnwiredStack()
        internal
        returns (LaunchRegistry reg2, Graduator grad2, CurbLaunchFactory fac2)
    {
        reg2 = new LaunchRegistry(address(this));
        grad2 = new Graduator(POOL_MANAGER, IPositionManagerMinimal(address(POSM)), PERMIT2, reg2, _catalog());
        fac2 = new CurbLaunchFactory(
            reg2, grad2, NVDAC, feePolicy, feeEscrow, buybackVault,
            _terms(IHooks(address(hook)), FEE, TICK_SPACING)
        );
    }

    // ================================================================
    // Criterion 1
    // ================================================================

    function test_graduationIsOneTransactionFromCurveToLock() public onlyFork {
        (PonsV2BondingCurve curve, CurbLaunchToken token) = _launchAndFill(true);

        (uint256 pricedQuote, uint256 pricedTokens) = curve.getReserves();
        uint256 expectedTokenId = POSM.nextTokenId();
        uint256 poolQuoteBefore = IERC20(NVDAC).balanceOf(address(POOL_MANAGER));

        vm.prank(launcher);
        (PositionLock lock, uint256 tokenId,) = factory.graduate(address(token));

        assertEq(tokenId, expectedTokenId, "graduation minted a different position than it reported");
        assertGt(POSM.getPositionLiquidity(tokenId), 0, "no liquidity in the graduated position");
        assertEq(IERC721(address(POSM)).ownerOf(tokenId), address(lock), "the lock does not hold the position");

        // The terms came from the registry, so they are the terms the launch
        // was registered with - not anything a caller chose.
        assertEq(lock.beneficiary(), creator, "the lock pays someone else");
        assertEq(address(lock.poolKeyView().hooks), address(hook), "the lock is bound to a pool without our hook");

        assertTrue(curve.graduated(), "the curve did not close");
        assertEq(curve.tokenReserve(), 0, "the curve kept tradeable tokens");
        assertEq(token.balanceOf(address(graduator)), 0, "the graduator kept launch tokens");
        assertEq(IERC20(NVDAC).balanceOf(address(graduator)), 0, "the graduator kept quote");

        uint256 quoteIntoPool = IERC20(NVDAC).balanceOf(address(POOL_MANAGER)) - poolQuoteBefore;
        uint256 quoteRefunded = IERC20(NVDAC).balanceOf(refundTo);
        uint256 tokensIntoPool = token.balanceOf(address(POOL_MANAGER));
        uint256 tokensRefunded = token.balanceOf(refundTo);
        uint256 burned = SUPPLY - token.totalSupply();

        emit log_named_uint("priced quote reserve ", pricedQuote);
        emit log_named_uint("transferable quote   ", quoteIntoPool + quoteRefunded);
        emit log_named_uint("quote into the pool  ", quoteIntoPool);

        // THE TOKEN SIDE, WITH ITS DENOMINATORS SPELLED OUT. "86% was refunded"
        // is true of what graduation RECEIVED and false of the total supply,
        // and only the second number says how much of the token is walking
        // around unlocked. Both are reported so neither can be quoted alone.
        //
        // Measured from the BUYER'S OWN BALANCE, not as SUPPLY minus the rest.
        // The earlier version defined soldOnCurve by subtraction and then
        // asserted the three added up to SUPPLY - an identity that holds by
        // construction and could not have failed.
        uint256 soldOnCurve = token.balanceOf(trader);
        emit log_named_uint("supply at launch                ", SUPPLY);
        emit log_named_uint("sold on the curve to buyers     ", soldOnCurve);
        emit log_named_uint("handed to graduation            ", tokensIntoPool + burned);
        emit log_named_uint("  of that, into the LP position ", tokensIntoPool);
        emit log_named_uint("  of that, BURNED               ", burned);
        emit log_named_uint("burned as bps of LAUNCH supply  ", burned * 10_000 / SUPPLY);
        emit log_named_uint("supply after the burn           ", token.totalSupply());
        emit log_named_uint("  held by buyers, bps of it     ", soldOnCurve * 10_000 / token.totalSupply());
        emit log_named_uint("  in the pool,    bps of it     ", tokensIntoPool * 10_000 / token.totalSupply());

        // Independently measured balances, plus what was destroyed, must account
        // for the supply the launch minted - and no other address may hold any.
        assertEq(soldOnCurve + tokensIntoPool + burned, SUPPLY, "the token supply does not add up");
        // The burn is REAL: totalSupply fell, rather than the tokens moving to
        // an address that merely looks like a hole.
        assertEq(token.totalSupply(), soldOnCurve + tokensIntoPool, "totalSupply does not match what still exists");
        assertEq(token.balanceOf(address(0)), 0, "tokens were sent to address(0) instead of burned");
        assertEq(token.balanceOf(address(curve)), 0, "the curve still holds launch tokens");
        assertEq(token.balanceOf(address(graduator)), 0, "the graduator still holds launch tokens");
        assertEq(token.balanceOf(creator), 0, "the creator received launch tokens from graduation");

        // THE SHAPE'S THREE SHARES, from the terms alone: with r = phantom /
        // (phantom + threshold) the curve sells (1 - r), the LP takes r(1 - r)
        // and the remainder r^2 is BURNED. At the shipped r of about 0.27
        // that is about 73.1% / 19.7% / 7.3% - no longer D1's 50/25/25.
        assertEq(tokensRefunded, 0, "launch tokens were refunded instead of burned");
        uint256 v = PHANTOM_QUOTE + GRADUATION_THRESHOLD;
        assertApproxEqRel(
            soldOnCurve, FullMath.mulDiv(SUPPLY, GRADUATION_THRESHOLD, v), 1e15,
            "the curve did not sell (1 - r) of the supply"
        );
        assertApproxEqRel(
            tokensIntoPool, FullMath.mulDiv(FullMath.mulDiv(SUPPLY, PHANTOM_QUOTE, v), GRADUATION_THRESHOLD, v), 1e15,
            "the LP did not take r(1 - r) of the supply"
        );
        assertApproxEqRel(
            burned, FullMath.mulDiv(FullMath.mulDiv(SUPPLY, PHANTOM_QUOTE, v), PHANTOM_QUOTE, v), 1e15,
            "the remainder burned is not r^2 of the supply"
        );

        // THE GAP, MEASURED. The curve can never hand over its phantom
        // liquidity, so the transferable quote is short of the priced quote by
        // exactly that. This is the number a balance-holder fixture could not
        // have produced, and the reason the opening price cannot be taken from
        // the amounts that actually moved.
        assertEq(
            pricedQuote - (quoteIntoPool + quoteRefunded),
            PHANTOM_QUOTE,
            "transferable quote does not differ from the priced quote by the phantom amount"
        );
        // What graduation received is now split between the pool and the fire.
        assertEq(tokensIntoPool + burned, pricedTokens, "the token side is not fully accounted for");
    }

    // ================================================================
    // Criterion 4 - authorisation
    // ================================================================

    /// The hole this closes: an ERC-20 allowance authorises the GRADUATOR, not
    /// a caller of it. Before the registry, a stranger could aim a graduation
    /// at someone else's funded curve and name themselves the beneficiary.
    /// A STRANGER MAY TRIGGER IT, AND CHANGES NOTHING BY DOING SO.
    ///
    /// This test used to assert the opposite. Restricting the caller bought no
    /// safety the registry did not already provide - graduate() takes only the
    /// token, so there is no beneficiary, refund address or duration for any
    /// caller to supply - and it cost a real one: a launch whose automatic
    /// graduation was starved sat with buying AND selling closed until an
    /// operator appeared.
    ///
    /// What protects the terms is the write-once record. That is what this now
    /// checks: the attacker's own graduation pays the registered creator.
    function test_aStrangerCanTriggerButChangesNothing() public onlyFork {
        (, CurbLaunchToken token) = _launchAndFill(true);

        uint256 attackerTokensBefore = token.balanceOf(attacker);

        vm.prank(attacker);
        (PositionLock lock,,) = graduator.graduate(address(token));

        assertEq(lock.beneficiary(), creator, "the caller redirected the locked position");
        assertEq(address(lock.poolKeyView().hooks), address(hook), "the caller changed the pool");
        assertEq(token.balanceOf(attacker), attackerTokensBefore, "the caller took launch tokens");
        assertEq(IERC20(NVDAC).balanceOf(attacker), 0, "the caller took quote");
        assertEq(token.balanceOf(refundTo), 0, "the remainder went somewhere other than the fire");
    }

    /// Write-once means write-once for EVERYONE. The interesting case is not a
    /// stranger - it is the one contract that is allowed to write at all.
    function test_theRegistryRefusesToRewriteALaunch() public onlyFork {
        (, CurbLaunchToken token) = _launchAndFill(true);

        LaunchRegistry.Launch memory hijack = registry.launchOf(address(token));
        hijack.beneficiary = attacker;

        // A stranger: refused on authority.
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(LaunchRegistry.NotTheLauncher.selector, attacker));
        registry.register(address(token), hijack);

        // The factory itself - the only address the registry accepts writes
        // from: refused on the record already existing.
        vm.prank(address(factory));
        vm.expectRevert(abi.encodeWithSelector(LaunchRegistry.AlreadyRegistered.selector, address(token)));
        registry.register(address(token), hijack);

        assertEq(registry.launchOf(address(token)).beneficiary, creator, "the record changed");
    }

    function test_aLaunchCannotGraduateTwice() public onlyFork {
        (, CurbLaunchToken token) = _launchAndFill(true);

        vm.prank(launcher);
        factory.graduate(address(token));

        vm.prank(launcher);
        vm.expectRevert(abi.encodeWithSelector(Graduator.AlreadyGraduated.selector, address(token)));
        factory.graduate(address(token));
    }

    // ================================================================
    // Criterion 2 - rollback
    // ================================================================

    // ================================================================
    // Criterion 2a - a broken configuration never reaches a buyer
    // ================================================================

    /// These are not retryable mistakes. The registry record is permanent, so a
    /// launch registered with terms that cannot graduate would take people's
    /// money and then be stuck forever. Each is refused at launch, with no
    /// money anywhere near the curve.

    /// THESE MOVED, AND THE MOVE IS THE POINT.
    ///
    /// They used to hand a bad hook, fee tier, tick spacing or lock duration to
    /// launch() and watch the registry refuse it. launch() is open to anyone
    /// now, so those are not parameters any more - they are terms fixed when
    /// the FACTORY is built. A bad one is therefore not a launch to be refused;
    /// it is a factory that must not exist, and the constructor is where it is
    /// stopped. That is strictly earlier than "before anyone can buy".
    ///
    /// The hook is the one exception, and it is tested the other way below,
    /// because the registry is wired only after the factory exists.

    function test_aFactoryOnAnUnsupportedPoolFeeCannotBeDEPLOYED() public onlyFork {
        vm.expectRevert(abi.encodeWithSelector(CurbLaunchFactory.UnsupportedPoolFee.selector, uint24(1234)));
        new CurbLaunchFactory(
            registry, graduator, NVDAC, feePolicy, feeEscrow, buybackVault,
            _terms(IHooks(address(hook)), 1234, TICK_SPACING)
        );
    }

    /// BOTH ENDS OF THE SPACING, and the ceiling is here because it was missing.
    ///
    /// The constructor checked only `<= 0`. The registry's ceiling is
    /// TickMath.MAX_TICK_SPACING - 32767 - so a factory built on 32768 deployed
    /// perfectly well and then refused every launch anyone ever asked it for.
    /// The header claimed such a factory "cannot be deployed at all"; it could.
    function test_aFactoryOnAnIllegalTickSpacingCannotBeDEPLOYED() public onlyFork {
        int24 min_ = TickMath.MIN_TICK_SPACING;
        int24 max_ = TickMath.MAX_TICK_SPACING;

        vm.expectRevert(
            abi.encodeWithSelector(CurbLaunchFactory.IllegalTickSpacing.selector, int24(0), min_, max_)
        );
        new CurbLaunchFactory(
            registry, graduator, NVDAC, feePolicy, feeEscrow, buybackVault,
            _terms(IHooks(address(hook)), FEE, 0)
        );

        vm.expectRevert(
            abi.encodeWithSelector(CurbLaunchFactory.IllegalTickSpacing.selector, max_ + 1, min_, max_)
        );
        new CurbLaunchFactory(
            registry, graduator, NVDAC, feePolicy, feeEscrow, buybackVault,
            _terms(IHooks(address(hook)), FEE, max_ + 1)
        );
    }

    /// AND THE EDGES THEMSELVES DEPLOY. A bound nobody can sit on is a
    /// different bound from the one the registry enforces, and the point of
    /// checking here is to agree with the registry rather than to be stricter.
    function test_bothEdgesOfTheTickSpacingDeploy() public onlyFork {
        new CurbLaunchFactory(
            registry, graduator, NVDAC, feePolicy, feeEscrow, buybackVault,
            _terms(IHooks(address(hook)), FEE, TickMath.MIN_TICK_SPACING)
        );
        new CurbLaunchFactory(
            registry, graduator, NVDAC, feePolicy, feeEscrow, buybackVault,
            _terms(IHooks(address(hook)), FEE, TickMath.MAX_TICK_SPACING)
        );
    }

    /// A FACTORY WHOSE CURVES WOULD REFUSE ITS BUYBACK IMPACT CAP CANNOT BE
    /// DEPLOYED.
    ///
    /// Every launch() copies maxInternalPriceImpactBps into a new
    /// PonsV2BondingCurve, whose constructor reverts InvalidFeePolicy unless it
    /// is in (0, 10_000). The factory stored it unchecked, so a factory built
    /// with 0 or 10_000 deployed, passed wire() and addLauncher(), and then
    /// refused every launch it was ever asked for.
    function test_aFactoryWithABuybackImpactCapItsCurvesRefuseCannotBeDEPLOYED() public onlyFork {
        CurbLaunchFactory.Terms memory t = _terms(IHooks(address(hook)), FEE, TICK_SPACING);

        t.maxInternalPriceImpactBps = 0;
        vm.expectRevert(
            abi.encodeWithSelector(
                CurbLaunchFactory.MaxPriceImpactOutOfRange.selector, uint16(0), uint16(0), uint16(10_000)
            )
        );
        new CurbLaunchFactory(registry, graduator, NVDAC, feePolicy, feeEscrow, buybackVault, t);

        t.maxInternalPriceImpactBps = 10_000;
        vm.expectRevert(
            abi.encodeWithSelector(
                CurbLaunchFactory.MaxPriceImpactOutOfRange.selector, uint16(10_000), uint16(0), uint16(10_000)
            )
        );
        new CurbLaunchFactory(registry, graduator, NVDAC, feePolicy, feeEscrow, buybackVault, t);
    }

    /// AND THE EDGES THE CURVE ACCEPTS DEPLOY AND LAUNCH - the check agrees
    /// with the curve rather than being stricter. A launch at each edge is the
    /// proof, since the curve is what refuses.
    function test_bothEdgesOfTheBuybackImpactCapDeployAndLaunch() public onlyFork {
        uint16[2] memory edges = [uint16(1), uint16(9_999)];
        for (uint256 i = 0; i < 2; i++) {
            CurbLaunchFactory.Terms memory t = _terms(IHooks(address(hook)), FEE, TICK_SPACING);
            t.maxInternalPriceImpactBps = edges[i];
            CurbLaunchFactory fac = new CurbLaunchFactory(registry, graduator, NVDAC, feePolicy, feeEscrow, buybackVault, t);
            registry.addLauncher(address(fac));
            CurbLaunchFactory.LaunchConfig memory cfg = _config(true);
            cfg.salt = _saltForSideOf(fac, cfg, true);
            vm.prank(creator);
            (CurbLaunchToken token, PonsV2BondingCurve curve) = fac.launch(cfg);
            assertEq(address(curve.token()), address(token), "a launch at an accepted edge did not wire up");
        }
    }

    // ================================================================
    // THE FEE POLICY IS SETTABLE - announced, delayed, capped
    // ================================================================

    /// The three steps, for tests whose subject is something else. Tests ABOUT
    /// the delay do them by hand.
    function _movePolicyRecipient(FeeHook h, address next) internal {
        h.announcePlatformRecipient(next);
        vm.warp(block.timestamp + h.POLICY_CHANGE_DELAY());
        h.executePlatformRecipient();
    }

    function _movePolicyFee(FeeHook h, uint16 next) internal {
        h.announcePlatformFeeBps(next);
        vm.warp(block.timestamp + h.POLICY_CHANGE_DELAY());
        h.executePlatformFeeBps();
    }

    /// A LAUNCH KEEPS THE POLICY IT WAS CREATED WITH, AND THE NEXT ONE DOES NOT.
    ///
    /// This is PONS's shape and the reason for copying it rather than inventing
    /// one: PonsV2MemeHook holds the policy behind onlyOwner setters and their
    /// factory snapshots currentFeePolicy() into each curve, so an owner can
    /// change what FUTURE launches charge and can never reach an existing one.
    /// The curve's own comment says it: "Global hook policy updates affect
    /// future launches but cannot redirect an active curve's protocol share."
    function test_aCurveKeepsThePolicyItWasLaunchedWith() public onlyFork {
        address before = hook.platformRecipient();
        uint16 rateBefore = hook.platformFeeBps();

        CurbLaunchFactory.LaunchConfig memory launchCfg = _config(true);
        vm.prank(creator);
        (, PonsV2BondingCurve early) = factory.launch(launchCfg);

        address moved = makeAddr("the new platform recipient");
        _movePolicyRecipient(hook, moved);
        _movePolicyFee(hook, rateBefore + 10);

        // THE OLD LAUNCH IS UNTOUCHED. Both numbers, not just the address.
        assertEq(early.protocolFeeRecipient(), before, "an existing curve's recipient moved");
        assertEq(early.feeBps(), rateBefore, "an existing curve's platform rate moved");

        // AND THE NEXT ONE TAKES THE NEW POLICY.
        CurbLaunchFactory.LaunchConfig memory cfg = _config(true);
        cfg.salt = bytes32(uint256(0xA11CE));
        cfg.salt = _saltForSide(cfg, true);
        vm.prank(creator);
        (, PonsV2BondingCurve later) = factory.launch(cfg);
        assertEq(later.protocolFeeRecipient(), moved, "a new curve did not take the new recipient");
        assertEq(later.feeBps(), rateBefore + 10, "a new curve did not take the new rate");

        // AND THE CREATOR'S SHARE IS STILL THE REMAINDER, not a second copy of
        // the old sum - which is what would rot if the factory kept its own.
        assertEq(
            later.creatorTaxBps(), TOTAL_TAX_BPS - (rateBefore + 10),
            "the creator's leg was not recomputed against the new platform fee"
        );
    }

    /// A LAUNCH CARRIES ONE PLATFORM POLICY FROM ITS CURVE INTO ITS POOL.
    ///
    /// THIS TEST HAS BEEN WRONG TWICE, IN OPPOSITE DIRECTIONS, AND BOTH ARE
    /// WORTH KEEPING.
    ///
    /// It first asserted the pool side was LIVE - that a change reached a pool
    /// already trading - on the strength of "PONS's owner can call
    /// setProtocolFeeRecipient at any time and it reaches every pool". The
    /// setter is real (PonsV2MemeHook.sol:263) and reaches no pool that is
    /// already open: each stamps the policy at registration (:371) and every
    /// payout reads it back (:599, :712, :734).
    ///
    /// So it was inverted, and became "a pool keeps the policy it opened with"
    /// - true, and still not enough. The curve froze its share at launch and
    /// the hook froze its own again at graduation, so a change announced
    /// between those two moments gave ONE launch two different splits. An
    /// outside audit found that seam (M-01) and it could not be closed by
    /// anything the page said.
    ///
    /// ONE SNAPSHOT NOW, IN THE REGISTRY RECORD, taken when the launch is
    /// created and read by both halves. What the hook holds is the policy for
    /// the NEXT launch and can reach nothing that exists.
    function test_aLaunchCarriesOnePolicyFromItsCurveIntoItsPool() public onlyFork {
        address before = hook.platformRecipient();
        uint16 rateBefore = hook.platformFeeBps();
        address moved = makeAddr("the next platform recipient");
        assertEq(IERC20(NVDAC).balanceOf(moved), 0, "the fixture's new recipient already holds NVDAc");

        // ---- a launch created under the old policy, and NOT yet graduated.
        CurbLaunchFactory.LaunchConfig memory cfg = _config(true);
        cfg.totalTaxBps = TOTAL_TAX_BPS;
        cfg.salt = _saltForSide(cfg, true);
        vm.prank(creator);
        (CurbLaunchToken token, PonsV2BondingCurve curve) = factory.launch(cfg);
        assertEq(curve.protocolFeeRecipient(), before, "the curve did not take the policy in force");
        assertEq(uint16(curve.feeBps()), rateBefore, "the curve did not take the rate in force");

        // ---- the policy moves while that launch is still on its curve.
        _movePolicyRecipient(hook, moved);
        _movePolicyFee(hook, rateBefore + 10);
        assertEq(hook.platformRecipient(), moved, "the announced recipient did not take");

        // ---- and only now does it graduate.
        _fillToThreshold(curve);
        require(curve.graduated(), "the launch did not graduate");
        PoolKey memory key = _keyFor(token, IHooks(address(hook)));
        vm.prank(NVDAC_WHALE);
        IERC20(NVDAC).transfer(trader, 5e7);

        FeeHook.LaunchFee memory bound = hook.feeOf(key);
        assertEq(bound.platform, before, "the pool took a recipient its launch never agreed to");
        assertEq(bound.platformBps, rateBefore, "the pool took a rate its launch never agreed to");

        // AND THE MONEY FOLLOWS THE RECORD, not the assertion above it.
        uint256 oldBefore = IERC20(NVDAC).balanceOf(protocolRecipient);
        _routerSwap(key, NVDAC, address(token), 1e7, 1);
        assertGt(
            IERC20(NVDAC).balanceOf(protocolRecipient) - oldBefore, 0,
            "the pool paid somebody other than its launch's recipient"
        );
        assertEq(IERC20(NVDAC).balanceOf(moved), 0, "the pool paid the recipient announced after its launch");

        // ---- AND A LAUNCH CREATED AFTER THE CHANGE TAKES THE NEW POLICY,
        // which is the half that makes the delay worth having at all.
        CurbLaunchFactory.LaunchConfig memory next = _config(true);
        next.totalTaxBps = TOTAL_TAX_BPS;
        next.salt = bytes32(uint256(0xB0B));
        next.salt = _saltForSide(next, true);
        (next.expectedPlatformBps, next.expectedPlatformRecipient) = factory.currentPlatformPolicy();
        vm.prank(creator);
        (, PonsV2BondingCurve later) = factory.launch(next);
        assertEq(later.protocolFeeRecipient(), moved, "a new launch did not take the new recipient");
        assertEq(uint16(later.feeBps()), rateBefore + 10, "a new launch did not take the new rate");
    }

    /// AND A LAUNCH WHOSE EXPECTED TERMS HAVE MOVED IS REFUSED.
    ///
    /// A change is announced and ripens on a timestamp, so it can land between
    /// a creator reading their split and the transaction being mined. Without
    /// this the launch would be written on terms nobody had read, into a record
    /// that cannot be edited afterwards.
    function test_aLaunchIsRefusedWhenThePolicyMovedUnderIt() public onlyFork {
        CurbLaunchFactory.LaunchConfig memory cfg = _config(true);
        cfg.totalTaxBps = TOTAL_TAX_BPS;
        cfg.salt = bytes32(uint256(0xC0FFEE));
        cfg.salt = _saltForSide(cfg, true);
        uint16 expected = cfg.expectedPlatformBps;

        _movePolicyFee(hook, expected + 10);

        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(
                CurbLaunchFactory.PlatformPolicyMoved.selector,
                expected,
                expected + 10,
                cfg.expectedPlatformRecipient,
                hook.platformRecipient()
            )
        );
        factory.launch(cfg);
    }

    /// AND THE RECIPIENT ALONE MOVING IS ENOUGH TO REFUSE IT.
    ///
    /// The test above moves only the share. Every other test that moves the
    /// recipient rebuilds its config afterwards, so deleting the recipient half
    /// of the factory's comparison left the whole suite green - and it is the
    /// half that decides where a write-once record's platform leg goes.
    function test_aLaunchIsRefusedWhenOnlyThePlatformRecipientMoved() public onlyFork {
        CurbLaunchFactory.LaunchConfig memory cfg = _config(true);
        cfg.totalTaxBps = TOTAL_TAX_BPS;
        cfg.salt = bytes32(uint256(0xC0FFEF));
        cfg.salt = _saltForSide(cfg, true);
        address oldTo = cfg.expectedPlatformRecipient;
        address newTo = makeAddr("the rotated platform recipient");
        uint16 bps = cfg.expectedPlatformBps;

        _movePolicyRecipient(hook, newTo);

        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(CurbLaunchFactory.PlatformPolicyMoved.selector, bps, bps, oldTo, newTo)
        );
        factory.launch(cfg);
    }

    /// A LAUNCH FOR ONE OF THIS DEPLOYMENT'S OWN CONTRACTS IS REFUSED.
    ///
    /// The escrow is the one that matters: it refuses to credit itself, so an
    /// escrow creator makes every sweep revert - and graduate() sweeps first,
    /// so the full curve could never graduate. The others could never use what
    /// they were paid. Each is refused before anything is created.
    function test_aLaunchForTheDeploymentsOwnContractsIsRefused() public onlyFork {
        address[5] memory infra = [
            address(factory.feeEscrow()), address(graduator), address(hook), address(registry), address(factory)
        ];
        for (uint256 i = 0; i < infra.length; i++) {
            CurbLaunchFactory.LaunchConfig memory cfg = _config(true);
            cfg.creatorWallet = infra[i];
            vm.prank(creator);
            vm.expectRevert(abi.encodeWithSelector(CurbLaunchFactory.CreatorIsInfrastructure.selector, infra[i]));
            factory.launch(cfg);
        }
    }

    /// AND A LAUNCH FOR THE POOLMANAGER, by the hook's own rule.
    ///
    /// FeeHook refuses the PoolManager as a payee because a take to it is a
    /// transfer to itself, and the creator's leg of every pool swap goes
    /// through that same delivery - so a PoolManager creator loses every pool
    /// fee, holds escrow credit it can never claim, and owns a locked position
    /// it can never withdraw. The factory's comment said nothing else about the
    /// creator was checkable; this one was.
    ///
    /// THE POSITIVE CONTROL is the same config with an ordinary creator, which
    /// launches - so the refusal is about the address, not the config.
    function test_aLaunchForThePoolManagerIsRefused() public onlyFork {
        address manager = address(graduator.poolManager());
        assertEq(manager, address(hook.poolManager()), "the graduator and the hook name different managers");
        assertGt(manager.code.length, 0, "the manager is not deployed on this fork");

        CurbLaunchFactory.LaunchConfig memory cfg = _config(true);
        cfg.creatorWallet = manager;
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(CurbLaunchFactory.CreatorIsInfrastructure.selector, manager));
        factory.launch(cfg);

        cfg.creatorWallet = makeAddr("an ordinary cold wallet");
        vm.prank(creator);
        (CurbLaunchToken token,) = factory.launch(cfg);
        assertEq(registry.launchOf(address(token)).beneficiary, cfg.creatorWallet, "the control launch did not land");
    }

    /// AND EVERY OTHER CONTRACT OF THIS DEPLOYMENT THE FACTORY CAN REACH.
    ///
    /// The PoolManager fix left a comment saying the only thing unchecked was
    /// whether an ordinary address belongs to the creator - while the
    /// PositionManager (an NFT it never moves, tokens anybody can SWEEP), the
    /// fee policy, the buyback vault, and every OTHER admitted launcher and its
    /// escrow (the hook's own payee list) were all accepted, and none of them
    /// can claim what the escrow credits or take the locked position.
    ///
    /// THE OTHER LAUNCHER IS A REAL ONE, admitted, with its own escrow - so the
    /// refusal is read from the registry, not from this factory's own fields.
    /// THE POSITIVE CONTROL is the same config with an ordinary creator.
    function test_aLaunchForAnyOtherContractOfTheDeploymentIsRefused() public onlyFork {
        CurbLaunchFactory other = _secondFactory();
        registry.addLauncher(address(other));
        address otherEscrow = address(other.feeEscrow());
        assertTrue(otherEscrow != address(factory.feeEscrow()), "the premise moved: both factories share an escrow");

        address[5] memory infra = [
            address(graduator.positionManager()),
            address(factory.feePolicy()),
            address(factory.buybackVault()),
            address(other),
            otherEscrow
        ];
        for (uint256 i = 0; i < infra.length; i++) {
            CurbLaunchFactory.LaunchConfig memory cfg = _config(true);
            cfg.creatorWallet = infra[i];
            vm.prank(creator);
            vm.expectRevert(abi.encodeWithSelector(CurbLaunchFactory.CreatorIsInfrastructure.selector, infra[i]));
            factory.launch(cfg);
        }

        CurbLaunchFactory.LaunchConfig memory control = _config(true);
        control.creatorWallet = makeAddr("an ordinary cold wallet");
        vm.prank(creator);
        (CurbLaunchToken token,) = factory.launch(control);
        assertEq(registry.launchOf(address(token)).beneficiary, control.creatorWallet, "the control launch did not land");
    }

    /// AND NOT THE LAUNCH'S OWN CURVE OR TOKEN, whose addresses a caller can
    /// predict - the curve from the factory's nonce, the token from the salt -
    /// and neither of which can claim a fee or take a position.
    ///
    /// THE PREDICTIONS ARE PROVED, not assumed: the control launch, made with
    /// the same salt at the same nonce (a reverted launch moves neither), lands
    /// its curve and token at exactly the addresses refused above. Without that
    /// a wrong prediction would make both refusals vacuous.
    function test_aLaunchForItsOwnCurveOrTokenIsRefused() public onlyFork {
        CurbLaunchFactory.LaunchConfig memory cfg = _config(true);
        address curveToBe = vm.computeCreateAddress(address(factory), vm.getNonce(address(factory)));
        address tokenToBe = vm.computeCreate2Address(
            cfg.salt,
            keccak256(
                abi.encodePacked(
                    type(CurbLaunchToken).creationCode,
                    abi.encode(cfg.name, cfg.symbol, cfg.tokenUri, curveToBe, factory.supply())
                )
            ),
            address(factory)
        );

        cfg.creatorWallet = curveToBe;
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(CurbLaunchFactory.CreatorIsInfrastructure.selector, curveToBe));
        factory.launch(cfg);

        cfg.creatorWallet = tokenToBe;
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(CurbLaunchFactory.CreatorIsInfrastructure.selector, tokenToBe));
        factory.launch(cfg);

        cfg.creatorWallet = makeAddr("an ordinary cold wallet");
        vm.prank(creator);
        (CurbLaunchToken token, PonsV2BondingCurve curve) = factory.launch(cfg);
        assertEq(address(curve), curveToBe, "the curve prediction was wrong, so its refusal proved nothing");
        assertEq(address(token), tokenToBe, "the token prediction was wrong, so its refusal proved nothing");
    }

    /// AND THE REGISTRY REFUSES IT TOO, for the one that bricks a launch, from
    /// its own launcher - because further launchers can be admitted.
    function test_theRegistryRefusesABeneficiaryThatIsTheCurvesEscrow() public onlyFork {
        CurbLaunchFactory.LaunchConfig memory launchCfg = _config(true);
        vm.prank(creator);
        (CurbLaunchToken token,) = factory.launch(launchCfg);

        LaunchRegistry.Launch memory rec = registry.launchOf(address(token));
        address escrow = address(PonsV2BondingCurve(rec.curve).feeEscrow());
        rec.beneficiary = escrow;

        vm.prank(address(factory));
        vm.expectRevert(abi.encodeWithSelector(LaunchRegistry.BeneficiaryIsTheEscrow.selector, escrow));
        registry.register(makeAddr("a record whose beneficiary is the escrow"), rec);
    }

    /// A LAUNCHER THAT IS ALREADY THE PLATFORM RECIPIENT, OR WHOSE ESCROW IS,
    /// CANNOT BE ADMITTED.
    ///
    /// The escrow refuses to credit itself, so every sweep and every graduation
    /// of a curve paying it reverts: the same brick as an escrow creator,
    /// reached through the other address the curve credits. The hook refuses
    /// every ADMITTED launcher and escrow when a recipient is announced and
    /// when it lands (test_theHookRefusesEveryDeploymentContractAsThePlatformRecipient),
    /// which leaves one order: the recipient lands FIRST, and a launcher whose
    /// escrow (or whose own address) it is gets admitted afterwards. That used
    /// to be admitted, and only the launcher's own factory knew anything was
    /// wrong, at its first launch. The registry now refuses it at the door,
    /// so the live recipient is never an admitted launcher or escrow in either
    /// order. (What it cannot do is stop the other factories stamping that
    /// address from the moment it landed; nothing could know it would become
    /// an escrow.) Here the escrow's address is predicted from this contract's
    /// nonce and landed before the escrow exists.
    function test_aLauncherThatIsAlreadyThePlatformRecipientCannotBeAdmitted() public onlyFork {
        address escrowToBe = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        _movePolicyRecipient(hook, escrowToBe);
        CurbLaunchFactory later = _wethFactoryUnadmitted();
        assertEq(address(later.feeEscrow()), escrowToBe, "the escrow did not land at the predicted address");

        vm.expectRevert(
            abi.encodeWithSelector(LaunchRegistry.LauncherIsThePlatformRecipient.selector, address(later), escrowToBe)
        );
        registry.addLauncher(address(later));
        assertFalse(registry.isLauncher(address(later)), "a launcher paying its own escrow was admitted");

        // AND THE LAUNCHER ITSELF, built but not yet admitted when it landed.
        CurbLaunchFactory another = _secondFactory();
        _movePolicyRecipient(hook, address(another));
        vm.expectRevert(
            abi.encodeWithSelector(
                LaunchRegistry.LauncherIsThePlatformRecipient.selector, address(another), address(another)
            )
        );
        registry.addLauncher(address(another));

        // AND AN ORDINARY RECIPIENT ADMITS BOTH, so the refusals above are about
        // who is paid and not about admitting at all.
        _movePolicyRecipient(hook, makeAddr("an ordinary platform recipient"));
        registry.addLauncher(address(later));
        registry.addLauncher(address(another));
    }

    /// AND THE FIRST LAUNCHER IS ASKED THE SAME AT wire(). The hook is built
    /// before any launcher exists and cannot ask; the registry can, and a stack
    /// whose hook pays the first factory's escrow is refused before it opens.
    function test_aStackWhoseHookPaysTheFirstLaunchersEscrowCannotBeWired() public onlyFork {
        LaunchRegistry reg2 = new LaunchRegistry(address(this));
        Graduator grad2 = new Graduator(POOL_MANAGER, IPositionManagerMinimal(address(POSM)), PERMIT2, reg2, _catalog());
        FeeHook hook2 = _mineHookPaying(address(feeEscrow), address(grad2), reg2);
        CurbLaunchFactory fac2 = new CurbLaunchFactory(
            reg2, grad2, NVDAC, feePolicy, feeEscrow, buybackVault,
            _terms(IHooks(address(hook2)), FEE, TICK_SPACING)
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                LaunchRegistry.LauncherIsThePlatformRecipient.selector, address(fac2), address(feeEscrow)
            )
        );
        reg2.wire(address(fac2), address(hook2));
        assertFalse(reg2.wired(), "a stack paying its own escrow was wired");
    }

    /// A LAUNCHER THAT WILL NOT NAME ITS ESCROW CANNOT BE ADMITTED.
    ///
    /// The hook asks every admitted launcher for its escrow each time a
    /// platform recipient is announced or lands, and nothing is ever removed
    /// from that list. So one launcher without a feeEscrow() would make every
    /// later announcement and execution revert, and the platform recipient
    /// could never be changed again. Refused at the door, where refusing
    /// costs nothing permanent; and the hook's announcements still work after.
    function test_aLauncherThatWillNotNameItsEscrowCannotBeAdmitted() public onlyFork {
        NoEscrowLauncher mute = new NoEscrowLauncher(address(graduator));
        vm.expectRevert(abi.encodeWithSelector(LaunchRegistry.LauncherEscrowUnreadable.selector, address(mute)));
        registry.addLauncher(address(mute));
        assertFalse(registry.isLauncher(address(mute)), "a launcher with no escrow was admitted");

        // A ZERO IS NOT AN ESCROW EITHER.
        NoEscrowLauncher zero = new NoEscrowLauncher(address(graduator));
        zero.sayZero();
        vm.expectRevert(abi.encodeWithSelector(LaunchRegistry.LauncherEscrowUnreadable.selector, address(zero)));
        registry.addLauncher(address(zero));

        // AND THE HOOK'S ANNOUNCEMENTS STILL WORK, which is what was at stake.
        address next = makeAddr("a recipient after the refusal");
        hook.announcePlatformRecipient(next);
        vm.warp(block.timestamp + hook.POLICY_CHANGE_DELAY());
        hook.executePlatformRecipient();
        assertEq(hook.platformRecipient(), next, "the platform recipient could not be changed");
    }

    /// EVERY TERM OF THE FACTORY'S REFUSAL.
    ///
    /// None of them can be reached honestly any more: the hook refuses the
    /// graduator, the registry, itself and every admitted launcher and escrow,
    /// and the registry will not admit a launcher that already is, or whose
    /// escrow already is, the recipient. The factory's check is the last line
    /// if either of those ever changes, so the hook's answer is MOCKED here,
    /// one term at a time, and the factory has to refuse each on its own.
    /// Deleting any one of the five comparisons fails exactly one iteration:
    /// that launch goes on past the factory's check and is refused later, by
    /// PlatformPolicyMoved (the config was built before the mock), which is
    /// not the error expected.
    function test_aLaunchIsRefusedWhenThePlatformRecipientIsAnyDeploymentContract() public onlyFork {
        address[5] memory infra = [
            address(factory.feeEscrow()), address(graduator), address(hook), address(registry), address(factory)
        ];
        for (uint256 i = 0; i < infra.length; i++) {
            CurbLaunchFactory.LaunchConfig memory cfg = _config(true);
            vm.mockCall(address(hook), abi.encodeWithSignature("platformRecipient()"), abi.encode(infra[i]));
            vm.prank(creator);
            vm.expectRevert(
                abi.encodeWithSelector(CurbLaunchFactory.PlatformRecipientIsInfrastructure.selector, infra[i])
            );
            factory.launch(cfg);
            vm.clearMockedCalls();
        }
        // AND THE MOCK IS GONE: an ordinary launch still goes through.
        CurbLaunchFactory.LaunchConfig memory ok = _config(true);
        vm.prank(creator);
        factory.launch(ok);
    }

    /// AND THE REGISTRY REFUSES IT FROM ITS OWN LAUNCHER, for later launchers.
    function test_theRegistryRefusesAPlatformRecipientThatIsTheCurvesEscrow() public onlyFork {
        CurbLaunchFactory.LaunchConfig memory launchCfg = _config(true);
        vm.prank(creator);
        (CurbLaunchToken token,) = factory.launch(launchCfg);

        LaunchRegistry.Launch memory rec = registry.launchOf(address(token));
        address escrow = address(PonsV2BondingCurve(rec.curve).feeEscrow());
        rec.platformRecipient = escrow;

        vm.prank(address(factory));
        vm.expectRevert(abi.encodeWithSelector(LaunchRegistry.PlatformRecipientIsTheEscrow.selector, escrow));
        registry.register(makeAddr("a record paying the platform leg to the escrow"), rec);
    }

    /// THE OPENING-PRICE HELPER COVERS v4's RANGE. As a Q192 ratio it overflowed
    /// at amount1/amount0 = 2^64 with a bare FullMath error - cbBTC's shipped
    /// terms are at 81% of that (86% before the 2026-10-15 re-pricing, 90% on
    /// D1's) - and its own PriceOutOfRange upper bound could
    /// never fire. Past 2^64 it now uses a Q128 ratio; past 2^128 it refuses.
    function test_theOpeningPriceHelperCoversTheWholeRange() public onlyFork {
        assertEq(graduator.sqrtPriceFromAmounts(1, 2 ** 64), 2 ** 128, "wrong price at a ratio of 2^64");
        assertEq(graduator.sqrtPriceFromAmounts(1, 2 ** 70), 2 ** 131, "wrong price at a ratio of 2^70");
        // cbBTC's shipped terms, both orderings, as the factory checks them.
        uint256 virtualQuote = 0.0487e8 + 0.132e8;
        uint256 reserved = FullMath.mulDiv(SUPPLY, 0.0487e8, virtualQuote);
        assertGt(graduator.sqrtPriceFromAmounts(virtualQuote, reserved), 0, "cbBTC's price did not compute");
        assertGt(graduator.sqrtPriceFromAmounts(reserved, virtualQuote), 0, "cbBTC's inverse did not compute");
        vm.expectRevert(abi.encodeWithSelector(Graduator.PriceOutOfRange.selector, type(uint256).max));
        graduator.sqrtPriceFromAmounts(1, 2 ** 129);
    }

    /// THE SQUARE ROOT IS THE FLOOR AT ITS SMALLEST INPUTS TOO.
    ///
    /// The Babylonian loop starts at (x >> 1) + 1 and never goes below it, so
    /// at x = 2 it returned 2 instead of floor(sqrt(2)) = 1. The results here
    /// are all far below MIN_SQRT_PRICE and refused, and the refusal carries
    /// the root - which is how a private helper's answer is read from outside.
    function test_theSquareRootIsTheFloorAtItsSmallestInputs() public onlyFork {
        // A Q192 ratio of exactly 1, 2, 3 and 4.
        uint256 q192 = 2 ** 192;
        uint256[4] memory amount0 = [q192, q192 / 2, q192 / 3, q192 / 4];
        uint256[4] memory root = [uint256(1), 1, 1, 2];
        for (uint256 i = 0; i < 4; i++) {
            vm.expectRevert(abi.encodeWithSelector(Graduator.PriceOutOfRange.selector, root[i]));
            graduator.sqrtPriceFromAmounts(amount0[i], 1);
        }
    }

    /// EACH CANCEL SAYS WHICH CHANGE IT WITHDREW, AND WHAT IT WAS.
    function test_eachCancelNamesTheChangeItWithdrew() public onlyFork {
        address next = makeAddr("a recipient announced and withdrawn");
        hook.announcePlatformRecipient(next);
        vm.expectEmit(address(hook));
        emit FeeHook.PlatformRecipientCancelled(next);
        hook.cancelPlatformRecipient();

        uint16 bps = hook.platformFeeBps() + 5;
        hook.announcePlatformFeeBps(bps);
        vm.expectEmit(address(hook));
        emit FeeHook.PlatformFeeBpsCancelled(bps);
        hook.cancelPlatformFeeBps();
    }

    /// THE HOOK CANNOT BE ANNOUNCED AS ITS OWN PAYEE.
    ///
    /// _deliver would take the fee to the hook and credit owed[address(this)],
    /// and claim() pays msg.sender - so the hook would have to call itself to
    /// ever hand it over, and nothing does. Checked at the announcement rather
    /// than at the payment because from there it is stamped into every launch
    /// configured afterwards.
    function test_theHookCannotBeAnnouncedAsThePlatformRecipient() public onlyFork {
        vm.expectRevert(FeeHook.RecipientIsTheHook.selector);
        hook.announcePlatformRecipient(address(hook));
    }

    /// NOR CAN ANY OTHER CONTRACT OF THIS DEPLOYMENT, ON ANY ASSET'S FACTORY.
    ///
    /// The announcement is the choke point: what lands is stamped into every
    /// launch created afterwards on EVERY factory. Each factory checks at
    /// launch too, but knows only its own escrow - so announcing asset B's
    /// escrow went straight into every launch on asset A. The second factory
    /// here, with its own escrow, is that asset B.
    function test_theHookRefusesEveryDeploymentContractAsThePlatformRecipient() public onlyFork {
        CurbLaunchFactory assetB = _wethFactory();
        address[7] memory infra = [
            address(POOL_MANAGER),
            address(registry),
            address(graduator),
            address(factory),
            address(factory.feeEscrow()),
            address(assetB),
            address(assetB.feeEscrow())
        ];
        for (uint256 i = 0; i < infra.length; i++) {
            vm.expectRevert(abi.encodeWithSelector(FeeHook.RecipientIsDeploymentContract.selector, infra[i]));
            hook.announcePlatformRecipient(infra[i]);
        }
        assertEq(hook.pendingRecipientReadyAt(), 0, "a refused announcement left something pending");

        // AND AN ORDINARY ADDRESS IS STILL ANNOUNCED, so the refusals above are
        // about those addresses and not about announcing at all.
        address fine = makeAddr("an ordinary platform recipient");
        hook.announcePlatformRecipient(fine);
        assertEq(hook.pendingRecipient(), fine, "an ordinary recipient was refused");
    }

    /// AND IT IS ASKED AGAIN WHEN THE CHANGE LANDS.
    ///
    /// An address that was nobody's at the announcement can be an escrow by
    /// the time the delay runs out: a launcher admitted in between brings its
    /// escrow with it. The announcement was clean; the execution must not be.
    function test_aRecipientThatBecameADeploymentContractWhileAnnouncedCannotLand() public onlyFork {
        address before = hook.platformRecipient();
        address escrowToBe = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        hook.announcePlatformRecipient(escrowToBe);

        CurbLaunchFactory assetB = _wethFactory();
        assertEq(address(assetB.feeEscrow()), escrowToBe, "the escrow did not land at the predicted address");

        vm.warp(block.timestamp + hook.POLICY_CHANGE_DELAY());
        vm.expectRevert(abi.encodeWithSelector(FeeHook.RecipientIsDeploymentContract.selector, escrowToBe));
        hook.executePlatformRecipient();
        assertEq(hook.platformRecipient(), before, "an escrow became the platform recipient");
    }

    /// AND A HOOK CANNOT BE BUILT PAYING THEM IN THE FIRST PLACE. The launchers
    /// are not asked at construction - none can be admitted before this hook
    /// has code - but the three contracts it is built on are.
    function test_theHookCannotBeBuiltPayingItsOwnInfrastructure() public onlyFork {
        address[3] memory infra = [address(POOL_MANAGER), address(registry), address(graduator)];
        for (uint256 i = 0; i < infra.length; i++) {
            vm.expectRevert(abi.encodeWithSelector(FeeHook.RecipientIsDeploymentContract.selector, infra[i]));
            new FeeHook(POOL_MANAGER, infra[i], registry, address(graduator), address(this));
        }
    }

    /// THE CAP LEAVES THE CREATOR A FIFTH OF THEIR OWN TAX, WHICH IS
    /// THESTONKS' RULE RATHER THAN A NUMBER WE PICKED.
    ///
    /// Their operator may "change the fee split within hard caps that always
    /// leave the creator at least 20%". Ours keeps totalTaxBps -
    /// platformFeeBps, and the binding case is the SMALLEST tax a launch may
    /// choose - a cap that only held at 5% would not protect the launch that
    /// picked 1%.
    ///
    /// AN EARLIER VERSION OF THIS TEST CAPPED AT THE UNDERFLOW POINT, where the
    /// creator's leg goes to zero and every swap on their pool reverts. That is
    /// the line between working and broken, not between fair and unfair.
    function test_theCapAlwaysLeavesTheCreatorAFifthOfTheirTax() public onlyFork {
        uint16 floorTax = registry.MIN_TOTAL_TAX_BPS();
        uint16 cap = hook.maxPlatformFeeBps();

        // 20% of the smallest tax stays with the creator, by arithmetic.
        assertEq(cap, (floorTax * 80) / 100, "the cap is not four fifths of the tax floor");
        assertEq(floorTax - cap, (floorTax * 20) / 100, "the creator is not left a fifth");
        assertLt(cap, floorTax, "the cap reaches the underflow point");

        // At the cap exactly: allowed.
        _movePolicyFee(hook, cap);
        assertEq(hook.platformFeeBps(), cap, "the cap itself was refused");

        // One above it: refused AT ANNOUNCEMENT, so nothing is ever pending
        // that could not be applied.
        vm.expectRevert(abi.encodeWithSelector(FeeHook.PlatformFeeAboveCap.selector, uint16(cap + 1), cap));
        hook.announcePlatformFeeBps(cap + 1);
        assertEq(hook.pendingFeeReadyAt(), 0, "a refused announcement left something pending");
    }

    /// THE DELAY IS THE POINT OF THE WHOLE ARRANGEMENT, so it is measured on
    /// both sides: too early is refused, and too late is refused.
    function test_aPolicyChangeIsAnnouncedWaitedForAndCanGoStale() public onlyFork {
        address next = makeAddr("announced recipient");
        address before = hook.platformRecipient();

        // NOTHING PENDING, NOTHING TO EXECUTE.
        vm.expectRevert(FeeHook.NothingAnnounced.selector);
        hook.executePlatformRecipient();

        hook.announcePlatformRecipient(next);
        uint64 readyAt = hook.pendingRecipientReadyAt();
        assertEq(readyAt, uint64(block.timestamp) + hook.POLICY_CHANGE_DELAY(), "the delay is not 24 hours");
        assertEq(hook.pendingRecipient(), next, "the announcement is not readable");
        assertEq(hook.platformRecipient(), before, "announcing changed it immediately");

        // TOO EARLY - one second short.
        //
        // THE EXPECTED TIME IS STATED, NOT READ BACK. Two earlier versions of
        // this built the expectation from block.timestamp after the warp, and
        // both got the PRE-warp value: vm.warp does not move the timestamp the
        // already-running test frame sees, only the one the next call sees. The
        // assertion then compared the environment against itself and failed on
        // its own arithmetic. Naming the number the test means - readyAt - 1 -
        // is both correct and the thing a reader wants to see.
        vm.warp(readyAt - 1);
        vm.expectRevert(abi.encodeWithSelector(FeeHook.ChangeNotReady.selector, readyAt, readyAt - 1));
        hook.executePlatformRecipient();

        // TOO LATE - one second past the window. The announcement expires
        // rather than sitting executable for ever, which is the half of this
        // that is ours rather than theirs.
        uint64 expiresAt = readyAt + hook.POLICY_CHANGE_WINDOW();
        vm.warp(expiresAt + 1);
        vm.expectRevert(abi.encodeWithSelector(FeeHook.ChangeExpired.selector, expiresAt, expiresAt + 1));
        hook.executePlatformRecipient();
        assertEq(hook.platformRecipient(), before, "a stale change landed anyway");

        // AND INSIDE THE WINDOW IT LANDS.
        hook.announcePlatformRecipient(next);
        vm.warp(block.timestamp + hook.POLICY_CHANGE_DELAY());
        hook.executePlatformRecipient();
        assertEq(hook.platformRecipient(), next, "an announced, ripe change did not land");
        assertEq(hook.pendingRecipientReadyAt(), 0, "the pending slot was not cleared");
    }

    /// AND IT CAN BE CALLED OFF, which is the other thing an announcement needs
    /// to be worth announcing.
    function test_anAnnouncedChangeCanBeCancelled() public onlyFork {
        address before = hook.platformRecipient();
        hook.announcePlatformRecipient(makeAddr("never mind"));
        hook.cancelPlatformRecipient();
        assertEq(hook.pendingRecipientReadyAt(), 0, "the cancellation left it pending");

        vm.warp(block.timestamp + hook.POLICY_CHANGE_DELAY() + 1);
        vm.expectRevert(FeeHook.NothingAnnounced.selector);
        hook.executePlatformRecipient();
        assertEq(hook.platformRecipient(), before, "a cancelled change landed");
    }

    /// AND IT IS AN OWNER, WITH EVERYTHING THAT MEANS. A stranger cannot move
    /// the platform's cut, and ownership transfer is two-step so a mistyped
    /// address cannot take the policy with it.
    function test_onlyTheOwnerMovesTheFeePolicy() public onlyFork {
        address stranger = makeAddr("not the policy owner");

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        hook.announcePlatformRecipient(stranger);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        hook.announcePlatformFeeBps(10);

        // AND EXECUTING SOMEBODY ELSE'S ANNOUNCEMENT IS NOT A LOOPHOLE EITHER.
        hook.announcePlatformRecipient(makeAddr("the owner's own choice"));
        vm.warp(block.timestamp + hook.POLICY_CHANGE_DELAY());
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        hook.executePlatformRecipient();
        hook.cancelPlatformRecipient();

        // TWO-STEP: naming a new owner does not hand it over.
        hook.transferOwnership(stranger);
        assertEq(hook.owner(), address(this), "ownership moved on the first step");
        vm.prank(stranger);
        hook.acceptOwnership();
        assertEq(hook.owner(), stranger, "ownership did not move on acceptance");
    }

    /// GIVING THE KEY UP PUTS THE PRODUCT BACK WHERE IT WAS.
    ///
    /// PONS overrides renounceOwnership to revert, because an ownerless hook of
    /// theirs could never rotate the fee sweep operator and every graduated
    /// pool's fees would strand. That reason is theirs: our operator is a
    /// constant address(0) and is never rotated, and the creator can sweep
    /// their own launch because buyback is off by construction.
    ///
    /// So renouncing costs nothing here and buys something - the policy freezes
    /// where it stands and the arrangement is the immutable one this product
    /// had before the setters existed. Measured rather than asserted, because
    /// "the admin key can be given up" is the whole answer to "you added an
    /// admin key".
    function test_theFeePolicyKeyCanBeGivenUpAndThePolicyThenFreezes() public onlyFork {
        address frozenTo = makeAddr("the recipient it freezes at");
        _movePolicyRecipient(hook, frozenTo);
        uint16 frozenAt = hook.platformFeeBps();

        hook.renounceOwnership();
        assertEq(hook.owner(), address(0), "the key was not given up");

        // NOBODY CAN MOVE IT AFTERWARDS - not the old owner, not anyone, and
        // not by announcing either.
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        hook.announcePlatformRecipient(makeAddr("too late"));

        address stranger = makeAddr("also too late");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        hook.announcePlatformFeeBps(1);

        // AND THE PRODUCT STILL WORKS, frozen at what it was. A launch created
        // after the renouncement takes the frozen policy, which is the point:
        // this is the old immutable arrangement, not a broken one.
        assertEq(hook.platformRecipient(), frozenTo, "the frozen recipient moved");
        assertEq(hook.platformFeeBps(), frozenAt, "the frozen rate moved");

        CurbLaunchFactory.LaunchConfig memory launchCfg = _config(true);
        vm.prank(creator);
        (, PonsV2BondingCurve after_) = factory.launch(launchCfg);
        assertEq(after_.protocolFeeRecipient(), frozenTo, "a launch after renouncing took a different recipient");
        assertEq(after_.feeBps(), frozenAt, "a launch after renouncing took a different rate");
    }

    /// A SAFE CAN HOLD AND OPERATE THE FEE POLICY, ACCEPTANCE INCLUDED.
    ///
    /// A6 measured that a Safe can be PAID and can CLAIM. This is the other
    /// half, and it is the one with a step people miss: Ownable2Step does not
    /// hand ownership over until the new owner CALLS acceptOwnership, and a
    /// Safe cannot simply call - it has to clear its own threshold to do it.
    /// A transfer to a Safe that never accepts leaves the old owner holding the
    /// policy while everybody believes it moved.
    ///
    /// Then the whole arrangement is driven through it: announce, wait the 24
    /// hours, execute - each one a separate 2-of-3, and each relayed by
    /// somebody who is not an owner at all, which is how a Safe is actually
    /// operated and proves the threshold is what authorises rather than the
    /// sender.
    function test_aSafeCanTakeOverAndOperateTheFeePolicy() public onlyFork {
        (ISafe safe, uint256[3] memory keys,) = _deploySafe();
        assertEq(safe.getThreshold(), 2, "the fixture is not 2-of-3");

        // ---- 1. HANDING IT OVER IS TWO STEPS, AND THE FIRST ONE MOVES NOTHING.
        hook.transferOwnership(address(safe));
        assertEq(hook.owner(), address(this), "ownership moved without acceptance");
        assertEq(hook.pendingOwner(), address(safe), "the Safe was not named as pending owner");

        // The Safe accepts, through its own threshold.
        _safeExec(safe, keys, address(hook), abi.encodeWithSignature("acceptOwnership()"));
        assertEq(hook.owner(), address(safe), "the Safe did not end up owning the policy");

        // ---- 2. AND THE OLD OWNER IS OUT. Not a formality: this is the whole
        // point of moving it.
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        hook.announcePlatformRecipient(makeAddr("the old owner trying"));

        // ---- 3. THE SAFE ANNOUNCES.
        address next = makeAddr("the Safe's chosen recipient");
        address before = hook.platformRecipient();
        _safeExec(safe, keys, address(hook), abi.encodeWithSignature("announcePlatformRecipient(address)", next));
        assertEq(hook.pendingRecipient(), next, "the Safe's announcement did not register");
        assertEq(hook.platformRecipient(), before, "announcing changed it immediately");

        // ---- 4. THE DELAY BINDS THE SAFE TOO. It is not an owner privilege to
        // skip; a multisig waits like anybody else.
        _safeExec(safe, keys, address(hook), abi.encodeWithSignature("cancelPlatformRecipient()"));
        assertEq(hook.pendingRecipientReadyAt(), 0, "the Safe could not call off its own announcement");

        // ---- 5. AND THE FULL CYCLE LANDS.
        _safeExec(safe, keys, address(hook), abi.encodeWithSignature("announcePlatformRecipient(address)", next));
        vm.warp(block.timestamp + hook.POLICY_CHANGE_DELAY());
        _safeExec(safe, keys, address(hook), abi.encodeWithSignature("executePlatformRecipient()"));
        assertEq(hook.platformRecipient(), next, "the Safe could not execute its own ripe change");

        // ---- 6. AND THE CAP STILL BINDS A SAFE. An owner with three signers
        // is still an owner, not an exception.
        //
        // AND SAFE REPORTS IT BY REVERTING, NOT BY RETURNING FALSE - measured,
        // because the first version of this asserted a false return and got
        // GS013 instead. With gasPrice and safeTxGas both zero, Safe bubbles an
        // inner failure as a revert of the whole execTransaction. The exact
        // string is required rather than a bare expectRevert, so this cannot
        // pass on some other failure.
        uint16 cap = hook.maxPlatformFeeBps();
        bytes memory tooMuch = abi.encodeWithSignature("announcePlatformFeeBps(uint16)", cap + 1);
        bytes memory sigs = _signSafeTx(safe, keys, address(hook), tooMuch);
        vm.prank(makeAddr("safe relayer"));
        vm.expectRevert("GS013");
        safe.execTransaction(address(hook), 0, tooMuch, 0, 0, 0, 0, address(0), payable(address(0)), sigs);
        assertEq(hook.pendingFeeReadyAt(), 0, "a refused announcement left something pending");
    }

    /// AN ANNOUNCED CHANGE SURVIVES A HANDOVER, AND ONLY THE NEW OWNER CAN
    /// FINISH IT.
    ///
    /// Found by auditing the timelock I had just written rather than by a
    /// failure: an announcement is stored on the CONTRACT, not against the
    /// owner who made it, so handing the key over carries it along. Three
    /// things could have been true and only one of them is safe, so it is
    /// pinned rather than reasoned about:
    ///
    ///   the OLD owner cannot finish what they started once they have handed
    ///     over - otherwise a handover would not really be one;
    ///   the NEW owner can, but only by calling execute deliberately - it
    ///     cannot land on them by accident;
    ///   and they can call it off instead, which is what makes inheriting a
    ///     pending change survivable.
    ///
    /// NOT CLEARED ON TRANSFER, deliberately. The announcement was made in
    /// public and the delay is what gives other people time to act on it;
    /// wiping it silently at handover would take that back.
    function test_anAnnouncedChangeSurvivesAHandoverAndOnlyTheNewOwnerFinishesIt()
        public
        onlyFork
    {
        address next = makeAddr("the announced recipient");
        address before = hook.platformRecipient();
        address heir = makeAddr("the next policy owner");

        hook.announcePlatformRecipient(next);
        uint64 readyAt = hook.pendingRecipientReadyAt();

        hook.transferOwnership(heir);
        vm.prank(heir);
        hook.acceptOwnership();
        assertEq(hook.owner(), heir, "the handover did not complete");

        // THE ANNOUNCEMENT CAME WITH IT, and is still readable.
        assertEq(hook.pendingRecipient(), next, "the handover dropped the announcement");
        assertEq(hook.pendingRecipientReadyAt(), readyAt, "the handover reset the clock");

        vm.warp(readyAt);

        // THE OLD OWNER CANNOT FINISH IT.
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        hook.executePlatformRecipient();
        assertEq(hook.platformRecipient(), before, "the old owner landed a change after handing over");

        // THE NEW ONE CAN CALL IT OFF...
        vm.prank(heir);
        hook.cancelPlatformRecipient();
        assertEq(hook.pendingRecipientReadyAt(), 0, "the heir could not call off an inherited change");
        assertEq(hook.platformRecipient(), before, "cancelling landed it anyway");

        // ...OR MAKE IT THEIR OWN AND FINISH IT.
        vm.prank(heir);
        hook.announcePlatformRecipient(next);
        vm.warp(block.timestamp + hook.POLICY_CHANGE_DELAY());
        vm.prank(heir);
        hook.executePlatformRecipient();
        assertEq(hook.platformRecipient(), next, "the heir could not run the policy");
    }

    // ================================================================
    // ECONOMIC ATTACKS
    //
    // AUDIT.txt's "WHAT THIS REVIEW DID NOT DO" named this and it stayed
    // unnamed for a day: "no economic attack: sandwiching a graduation, timing
    // the crossing buy, or MEV around a pool opening at the curve's price".
    //
    // GRADUATION IS THE ONE MOMENT VALUE MOVES BETWEEN TWO SYSTEMS, so it is
    // where an attacker would look. Each test below writes down what would
    // count as a finding BEFORE it measures, because a test whose criterion
    // arrives after the number is a test that agrees with whatever happened.
    // ================================================================

    /// E-1  BUY THE CURVE, GRADUATE IT, DUMP INTO THE FRESH POOL - ONE ACTOR,
    ///      ONE SEQUENCE, NO VICTIM NEEDED.
    ///
    /// THE CRITERION, STATED FIRST: the attacker must end with LESS quote than
    /// they started with. If this sequence profits, the graduation is handing
    /// value to whoever triggers it, and every launch would be raced.
    ///
    /// WHY IT MIGHT HAVE WORKED: the pool is seeded with what the curve could
    /// physically transfer, which is SHORT of what it priced against by the
    /// phantom reserve. A pool opened at the ratio of what arrived would open
    /// BELOW the curve's last price, and the first seller would be selling
    /// into a gap the holders paid for. The Graduator's step 1 exists to stop
    /// exactly that, and this is the measurement of whether it does.
    function test_attack_buyGraduateAndDumpCannotProfit() public onlyFork {
        CurbLaunchFactory.LaunchConfig memory launchCfg = _config(true);
        vm.prank(creator);
        (CurbLaunchToken token, PonsV2BondingCurve curve) = factory.launch(launchCfg);

        // THE TRADER IS THE ATTACKER HERE, because the router helpers prank as
        // them. Who runs the sequence is not what is under test.
        //
        // FUNDED ONCE, AND THE FILL IS DONE BY HAND. The first version used
        // _fillToThreshold, which funds the trader a SECOND time - and the test
        // then reported a 4.29e9 "profit" that was entirely that transfer. It
        // would have been the worst finding in this project and it was my own
        // arithmetic. A balance comparison is only a measurement if nothing
        // else moves the balance.
        vm.prank(NVDAC_WHALE);
        IERC20(NVDAC).transfer(trader, TRADER_FUNDING * 3);
        uint256 before = IERC20(NVDAC).balanceOf(trader);

        vm.startPrank(trader);
        IERC20(NVDAC).approve(address(curve), type(uint256).max);
        curve.buy(40e8, 0, trader);
        // And finishes the launch themselves, so nobody else's timing is
        // involved - the best case for them. Oversized on purpose: the curve
        // fills to its allocation and refunds the rest.
        curve.buy(TRADER_FUNDING, 0, trader);
        vm.stopPrank();
        require(curve.graduated(), "the fixture did not graduate");

        // And dumps everything into the pool that just opened.
        uint128 held = uint128(token.balanceOf(trader));
        assertGt(held, 0, "the attacker bought nothing, so this measures nothing");
        PoolKey memory key = _keyFor(token, IHooks(address(hook)));
        _approveRouter(address(token), held);
        _executeSwap(key, address(token), NVDAC, held, 1);

        uint256 after_ = IERC20(NVDAC).balanceOf(trader);
        assertLt(after_, before, "THE ROUND TRIP THROUGH GRADUATION PROFITED - the pool opens too low");
        emit log_named_uint("  E-1 attacker lost, raw NVDAc", before - after_);
    }

    /// E-2  THE POOL OPENS AT THE CURVE'S LAST PRICE, NOT AT THE RATIO OF WHAT
    ///      IT HANDED OVER.
    ///
    /// THE CRITERION: the pool's sqrtPrice must equal the price computed from
    /// the curve's PRICED reserves - the ones including the phantom - and must
    /// be strictly ABOVE the price computed from what was actually transferred.
    /// The second half is what makes the first half worth asserting: if they
    /// were equal the distinction would be decorative.
    ///
    /// This is E-1's mechanism, measured directly rather than through a trade.
    function test_attack_theOpeningPriceLeavesNoGapToArbitrage() public onlyFork {
        CurbLaunchFactory.LaunchConfig memory launchCfg = _config(true);
        vm.prank(creator);
        (CurbLaunchToken token, PonsV2BondingCurve curve) = factory.launch(launchCfg);
        _fillWithoutGraduating(curve);

        (uint256 pricedQuote, uint256 pricedTokens) = curve.getReserves();
        (, uint256 realTokens) = (curve.realQuoteReserve(), pricedTokens);
        uint256 realQuote = curve.realQuoteReserve();

        bool tokenIsC0 = address(token) < NVDAC;
        uint160 atPriced = graduator.sqrtPriceFromAmounts(
            tokenIsC0 ? pricedTokens : pricedQuote, tokenIsC0 ? pricedQuote : pricedTokens
        );
        uint160 atHeld = graduator.sqrtPriceFromAmounts(
            tokenIsC0 ? realTokens : realQuote, tokenIsC0 ? realQuote : realTokens
        );

        vm.clearMockedCalls();
        graduator.graduate(address(token));

        PoolKey memory key = _keyFor(token, IHooks(address(hook)));
        (uint160 opened,,,) = POOL_MANAGER.getSlot0(key.toId());

        assertEq(opened, atPriced, "the pool did not open at the curve's own last price");
        assertTrue(atPriced != atHeld, "priced and held prices are identical, so this proves nothing");

        // AND THE GAP IT AVOIDS IS NOT SMALL. Named in the direction a seller
        // would have exploited: opening at the held ratio would put the
        // memecoin CHEAPER than the curve just sold it for.
        emit log_named_uint("  E-2 sqrtPrice at the curve's price", opened);
        emit log_named_uint("  E-2 sqrtPrice had it used what arrived", atHeld);
    }

    /// E-3  SANDWICHING AN UNBOUNDED CURVE BUY. THIS ONE IS EXPECTED TO WORK.
    ///
    /// THE CRITERION, AND IT IS THE OPPOSITE OF THE OTHERS: a sandwich against
    /// a victim who sets NO minimum SHOULD succeed, on this or any other
    /// constant-product market. A test claiming otherwise would be claiming
    /// something impossible, and the honest thing is to measure what it takes
    /// and what stops it.
    ///
    /// WHAT STOPS IT is the victim's own minTokensOut, which our page always
    /// sends - so the second half asserts the same sandwich fails against a
    /// bounded trade.
    function test_attack_aSandwichWorksWithoutABoundAndFailsWithOne() public onlyFork {
        CurbLaunchFactory.LaunchConfig memory launchCfg = _config(true);
        vm.prank(creator);
        (CurbLaunchToken token, PonsV2BondingCurve curve) = factory.launch(launchCfg);

        vm.prank(NVDAC_WHALE);
        IERC20(NVDAC).transfer(attacker, TRADER_FUNDING);
        vm.prank(NVDAC_WHALE);
        IERC20(NVDAC).transfer(trader, TRADER_FUNDING);
        // BOTH SIDES OF THE TRADE NEED AN ALLOWANCE. The curve pulls the quote
        // on a buy and the launch TOKEN on a sell; approving only the first is
        // what the initial version did, and it died on the allowance rather
        // than on anything it was testing.
        vm.startPrank(attacker);
        IERC20(NVDAC).approve(address(curve), type(uint256).max);
        token.approve(address(curve), type(uint256).max);
        vm.stopPrank();
        vm.prank(trader);
        IERC20(NVDAC).approve(address(curve), type(uint256).max);

        // ---- the unbounded victim
        uint256 attackerBefore = IERC20(NVDAC).balanceOf(attacker);
        vm.prank(attacker);
        uint256 got = curve.buy(20e8, 0, attacker);
        vm.prank(trader);
        curve.buy(10e8, 0, trader);          // the victim, with NO bound
        vm.prank(attacker);
        curve.sell(got, 0, attacker);
        uint256 attackerAfter = IERC20(NVDAC).balanceOf(attacker);

        // NOT ASSERTED AS A PROFIT. Whether it clears the two taxes depends on
        // the victim's size against the reserve, and pinning a direction here
        // would be pinning this fixture rather than the property. What IS the
        // property: the victim got fewer tokens than they would have alone,
        // and the only thing that can protect them is their own bound.
        emit log_named_int(
            "  E-3 attacker net over the sandwich, raw NVDAc",
            int256(attackerAfter) - int256(attackerBefore)
        );

        // ---- THE SAME SANDWICH, AGAINST A BOUNDED VICTIM.
        // Quote what the victim would get alone, require exactly that, and the
        // front-run makes their trade impossible rather than merely worse.
        uint256 feeTotal = curve.feeBps() + curve.creatorTaxBps();
        uint256 net = 10e8 - (10e8 * feeTotal) / 10_000;
        (uint256 q, uint256 t) = curve.getReserves();
        uint256 alone = PonsV2BondingCurveMath.getAmountOut(net, q, t, 0);

        vm.prank(attacker);
        curve.buy(20e8, 0, attacker);        // the front-run

        // AND HOW MUCH WORSE THE VICTIM'S FILL JUST BECAME, computed rather
        // than asserted vaguely. This is the damage a sandwich does even when
        // the bound stops it: the trade does not go through at all.
        (uint256 q2, uint256 t2) = curve.getReserves();
        uint256 afterFrontRun = PonsV2BondingCurveMath.getAmountOut(net, q2, t2, 0);
        assertLt(afterFrontRun, alone, "the front-run did not make the victim's fill worse");
        emit log_named_uint("  E-3 victim would have got, raw tokens", alone);
        emit log_named_uint("  E-3 victim would now get,  raw tokens", afterFrontRun);

        // THE FULL REVERT DATA, not just the selector: this Foundry requires it
        // for an error with arguments, and supplying it makes the assertion
        // sharper - it pins exactly what the curve would have filled.
        vm.prank(trader);
        vm.expectRevert(
            abi.encodeWithSelector(PonsV2BondingCurve.SlippageExceeded.selector, afterFrontRun, alone)
        );
        curve.buy(10e8, alone, trader);
    }

    /// E-4  TIMING THE GRADUATION BUYS NOTHING, which is what makes starving
    ///      the automatic attempt of gas pointless.
    ///
    /// THE CRITERION: the opening price of a launch that graduates NOW and one
    /// that graduates after an arbitrary delay must be IDENTICAL. If it moved,
    /// a keeper could sit on a ready launch and pick their moment, and the
    /// AutoGraduationFailed event would be a signal to trade on rather than a
    /// signal to fix something.
    function test_attack_delayingGraduationCannotMoveTheOpeningPrice() public onlyFork {
        CurbLaunchFactory.LaunchConfig memory launchCfg = _config(true);
        vm.prank(creator);
        (CurbLaunchToken token, PonsV2BondingCurve curve) = factory.launch(launchCfg);
        _fillWithoutGraduating(curve);
        vm.clearMockedCalls();

        (uint256 q0, uint256 t0) = curve.getReserves();
        bool c0 = address(token) < NVDAC;
        uint160 now_ = graduator.sqrtPriceFromAmounts(c0 ? t0 : q0, c0 ? q0 : t0);

        // A READY LAUNCH IS FROZEN ON BOTH SIDES, which is why time cannot move
        // it: buying is closed because the allocation is gone, and selling is
        // closed because readyToGraduate() is true.
        vm.prank(trader);
        vm.expectRevert(PonsV2BondingCurve.CurveGraduated.selector);
        curve.buy(1e8, 0, trader);

        vm.warp(block.timestamp + 30 days);
        vm.roll(block.number + 200_000);

        (uint256 q1, uint256 t1) = curve.getReserves();
        assertEq(q1, q0, "the quote reserve moved while the launch sat ready");
        assertEq(t1, t0, "the token reserve moved while the launch sat ready");

        graduator.graduate(address(token));
        PoolKey memory key = _keyFor(token, IHooks(address(hook)));
        (uint160 opened,,,) = POOL_MANAGER.getSlot0(key.toId());
        assertEq(opened, now_, "a month of waiting changed the price the pool opened at");
    }

    /// E-5  SPLITTING A TRADE TO ROUND THE FEE AWAY.
    ///
    /// THE CRITERION: the fee on a trade split into many pieces must not be
    /// materially below the fee on the same trade made whole. "Materially" is
    /// made precise before measuring: each piece can lose at most one raw unit
    /// per leg to flooring, so twenty pieces can lose at most forty units -
    /// 4e-7 NVDAc - and anything beyond that is a real leak.
    ///
    /// THIS IS WHAT MIN_QUOTE_DECIMALS EXISTS FOR, and the floor it protects
    /// is far away at eight decimals: a fee rounds to zero only below
    /// 10000/feeBps raw units, which here is 200 - two millionths of one NVDAc.
    function test_attack_splittingATradeCannotRoundTheFeeAway() public onlyFork {
        CurbLaunchFactory.LaunchConfig memory launchCfg = _config(true);
        vm.prank(creator);
        (, PonsV2BondingCurve whole) = factory.launch(launchCfg);
        CurbLaunchFactory.LaunchConfig memory cfg2 = _config(true);
        // Overwritten on the very next line in an earlier version, which read
        // as though the salt were 0x5171. _saltForSide derives it from the
        // name, symbol and uri - never from cfg.salt - so the assignment was
        // dead and only misleading.
        cfg2.salt = _saltForSide(cfg2, true);
        vm.prank(creator);
        (, PonsV2BondingCurve split) = factory.launch(cfg2);

        vm.prank(NVDAC_WHALE);
        IERC20(NVDAC).transfer(trader, TRADER_FUNDING);
        vm.startPrank(trader);
        IERC20(NVDAC).approve(address(whole), type(uint256).max);
        IERC20(NVDAC).approve(address(split), type(uint256).max);

        uint256 total = 20e8;
        whole.buy(total, 0, trader);
        uint256 wholeFee = whole.quoteFeeBalance() + whole.creatorTaxBalance();

        uint256 pieces = 20;
        for (uint256 i = 0; i < pieces; i++) split.buy(total / pieces, 0, trader);
        uint256 splitFee = split.quoteFeeBalance() + split.creatorTaxBalance();
        vm.stopPrank();

        assertLe(wholeFee - splitFee, pieces * 2, "splitting the trade avoided a material part of the fee");
        emit log_named_uint("  E-5 fee in one trade, raw", wholeFee);
        emit log_named_uint("  E-5 fee in twenty,   raw", splitFee);
    }

    /// E-6  A ROUND TRIP THROUGH THE CURVE ALONE CANNOT PROFIT.
    ///
    /// THE CRITERION: buy then immediately sell must return LESS than was put
    /// in. The math library already proves this of the formula
    /// [test_lib_roundTripCannotProfit]; this proves it of the CURVE, with its
    /// two fee legs and its tracked reserves, which is the thing anybody would
    /// actually trade against.
    function test_attack_aRoundTripThroughTheCurveCannotProfit() public onlyFork {
        CurbLaunchFactory.LaunchConfig memory launchCfg = _config(true);
        vm.prank(creator);
        (CurbLaunchToken token, PonsV2BondingCurve curve) = factory.launch(launchCfg);

        vm.prank(NVDAC_WHALE);
        IERC20(NVDAC).transfer(attacker, TRADER_FUNDING);
        uint256 before = IERC20(NVDAC).balanceOf(attacker);

        vm.startPrank(attacker);
        IERC20(NVDAC).approve(address(curve), type(uint256).max);
        token.approve(address(curve), type(uint256).max);
        uint256 out = curve.buy(15e8, 0, attacker);
        curve.sell(out, 0, attacker);
        vm.stopPrank();

        uint256 after_ = IERC20(NVDAC).balanceOf(attacker);
        assertLt(after_, before, "a curve round trip PROFITED");
        emit log_named_uint("  E-6 round trip cost, raw NVDAc", before - after_);
    }

    /// E-7  DONATING TO THE CURVE TO MOVE ITS PRICE.
    ///
    /// THE CRITERION: force-sending quote and launch tokens to the curve must
    /// change NOTHING - not the reserves, not what a buy costs, and above all
    /// not the price the graduated pool opens at.
    ///
    /// WHY THIS IS THE FIRST THING AN ATTACKER TRIES. A curve that priced off
    /// balanceOf would let anyone move the whole book with a transfer that
    /// calls nothing and can be front-run into any position in the block. It
    /// is the oldest AMM attack there is and it costs one transaction to try.
    ///
    /// AND IT IS A CLAIM THE CODE MAKES ABOUT ITSELF: graduate() says in prose
    /// that a donation "cannot move the price the pool opens at". That
    /// sentence had no test under it until this one.
    function test_attack_donatingToTheCurveCannotMoveThePrice() public onlyFork {
        CurbLaunchFactory.LaunchConfig memory launchCfg = _config(true);
        vm.prank(creator);
        (CurbLaunchToken token, PonsV2BondingCurve curve) = factory.launch(launchCfg);
        _fillWithoutGraduating(curve);

        (uint256 q0, uint256 t0) = curve.getReserves();
        uint160 priceBefore = _ourPrice(token, q0, t0);
        uint256 trackedQuoteBefore = curve.trackedQuote();
        uint256 trackedTokensBefore = curve.trackedTokens();

        // THE DONATION, ON BOTH SIDES AND OVERSIZED. 500e8 of NVDAc is over
        // eight times this launch's whole graduation threshold, so if the
        // curve read its own balance anywhere this would be unmissable.
        uint256 quoteGift = 500e8;
        uint256 tokenGift = 1_000e18;
        vm.prank(NVDAC_WHALE);
        IERC20(NVDAC).transfer(address(curve), quoteGift);
        vm.prank(trader);
        token.transfer(address(curve), tokenGift);

        (uint256 q1, uint256 t1) = curve.getReserves();
        assertEq(q1, q0, "a quote donation moved the quote reserve");
        assertEq(t1, t0, "a token donation moved the token reserve");
        assertEq(curve.trackedQuote(), trackedQuoteBefore, "the donation was credited as tracked quote");
        assertEq(curve.trackedTokens(), trackedTokensBefore, "the donation was credited as tracked tokens");

        // AND THE PRICE THE POOL ACTUALLY OPENS AT, which is the one that
        // matters - the reserves above are only how it is computed.
        graduator.graduate(address(token));
        PoolKey memory key = _keyFor(token, IHooks(address(hook)));
        (uint160 opened,,,) = POOL_MANAGER.getSlot0(key.toId());
        assertEq(opened, priceBefore, "a donation moved the price the pool opened at");

        // THE DONATION IS STRANDED, which is the deliberate half of this: it
        // is not folded into the pool's seed and there is no rescue for it.
        // Whoever sends it has burned it. That is the price of the immunity.
        assertEq(
            IERC20(NVDAC).balanceOf(address(curve)),
            quoteGift,
            "the donated quote did not stay stranded on the curve"
        );
        assertEq(token.balanceOf(address(curve)), tokenGift, "the donated tokens did not stay stranded");
        emit log_named_uint("  E-7 quote donated and burned, raw NVDAc", quoteGift);
    }

    /// E-8  OVERSIZING THE LAST BUY TO LEAK QUOTE THROUGH THE REFUND.
    ///
    /// THE CRITERION: the attacker must pay for exactly what they received and
    /// get the rest back - the curve's balance rises by what left the buyer's
    /// wallet, to the wei, with the fee legs taken from the SPENT amount
    /// rather than the offered one.
    ///
    /// WHY THIS IS THE SHARPEST EDGE IN THE CONTRACT. The clamped fill is the
    /// only branch that re-derives its own input: it prices from the token
    /// side, grosses the result back up through the fee legs with a CEILING
    /// division, and refunds the difference. A gross-up that rounded the other
    /// way would either overcharge the last buyer of every launch or hand them
    /// tokens the curve was not paid for - and this is the one buy in a launch
    /// that is guaranteed to happen, every time, to somebody.
    function test_attack_oversizingTheLastBuyCannotLeakQuote() public onlyFork {
        CurbLaunchFactory.LaunchConfig memory launchCfg = _config(true);
        vm.prank(creator);
        (CurbLaunchToken token, PonsV2BondingCurve curve) = factory.launch(launchCfg);

        // The mint is suppressed so the clamped buy can be measured where it
        // lands, instead of graduating out from under the assertions.
        vm.mockCallRevert(
            address(POSM),
            abi.encodeWithSelector(IPositionManagerMinimal.modifyLiquidities.selector),
            abi.encodeWithSignature("Error(string)", "starved")
        );

        vm.prank(NVDAC_WHALE);
        IERC20(NVDAC).transfer(attacker, TRADER_FUNDING * 4);
        vm.startPrank(attacker);
        IERC20(NVDAC).approve(address(curve), type(uint256).max);
        curve.buy(40e8, 0, attacker);        // most of the way, cleanly

        uint256 sellable = curve.sellableTokens();
        uint256 curveBefore = IERC20(NVDAC).balanceOf(address(curve));
        uint256 mine = IERC20(NVDAC).balanceOf(attacker);
        uint256 offered = 200e8;             // wildly more than the rest costs

        // WHAT THE PRICING DEMANDS FOR THAT LAST SLICE, computed the same way
        // the curve computes it, so the gross-up can be checked against the
        // number it is supposed to cover rather than only against itself.
        (uint256 qBefore, uint256 tBefore) = curve.getReserves();
        uint256 net = PonsV2BondingCurveMath.getAmountIn(sellable, qBefore, tBefore, 0);

        uint256 got = curve.buy(offered, 0, attacker);
        vm.stopPrank();
        vm.clearMockedCalls();

        uint256 spent = mine - IERC20(NVDAC).balanceOf(attacker);
        assertLt(spent, offered, "nothing was refunded, so the clamp never ran and this proves nothing");
        assertEq(got, sellable, "the clamped fill did not stop exactly at the allocation");

        // NOT A WEI IN OR OUT. The curve's balance rose by what the attacker
        // paid and by nothing else, so the refund cannot have over- or
        // under-returned: those are the same number seen from both ends.
        assertEq(
            IERC20(NVDAC).balanceOf(address(curve)) - curveBefore,
            spent,
            "the curve's balance and the buyer's payment disagree"
        );
        // And the accounting matches the metal, fees included - the buckets
        // live INSIDE trackedQuote, so this is the whole reconciliation.
        assertEq(
            curve.trackedQuote(),
            IERC20(NVDAC).balanceOf(address(curve)),
            "tracked quote drifted from the curve's actual balance"
        );
        // AND THE DIRECTION OF THE ROUNDING, which the checks above do not
        // reach: they hold under EITHER rounding, because a consistent
        // under-charge is still consistent. A mutation flipping the gross-up
        // from Ceil to Floor left all of them green, which is how this
        // assertion came to exist.
        //
        // The gross-up exists so the reserve is credited with AT LEAST what
        // the formula demanded for those tokens. Rounded the other way the
        // curve hands out the slice having been paid a wei short, every
        // launch, on the one buy that always happens.
        (uint256 qAfter,) = curve.getReserves();
        assertGe(qAfter - qBefore, net, "the reserve was credited LESS than the fill was priced at");
        // And from the other side, so this cannot be satisfied by overcharging.
        // TWO UNITS, NOT ONE: the gross-up's ceiling leaves less than one
        // unit over net once the fee legs come back off, but the platform fee
        // and the creator tax are each floored on their own, and each floor
        // can leave up to one more unit in the reserve. This said "at most
        // one" while it held at D1's 60/60 by the luck of the numbers; the
        // shipped 18.5/50.0 (15 October) lands on net + 2, as 18.1/49.1 did.
        assertLe(qAfter - qBefore, net + 2, "the buyer was charged more than the ceiling can explain");

        emit log_named_uint("  E-8 offered, raw NVDAc", offered);
        emit log_named_uint("  E-8 charged, raw NVDAc", spent);
        emit log_named_uint("  E-8 priced at,          raw", net);
        emit log_named_uint("  E-8 credited to reserve, raw", qAfter - qBefore);
    }

    /// E-9  TRADING INSIDE THE GRADUATION WINDOW.
    ///
    /// THE CRITERION: with the curve READY but not yet graduated, both a buy
    /// and a sell must revert. Not one of them - both.
    ///
    /// WHY THE WINDOW EXISTS AT ALL. The crossing buy graduates the launch
    /// itself, but `_tryAutoGraduate` swallows a failure so that a problem at
    /// the pool cannot take an honest buyer's trade down with it. That leaves
    /// a real, reachable state - ready, not graduated - and this fixture is
    /// exactly it.
    ///
    /// WHAT A SELL WOULD HAVE BOUGHT. graduate() hands the pool whatever
    /// trackedTokens holds. A sell landing in the window puts tokens BACK on
    /// the curve and takes quote OFF it, so the pool would open deeper and
    /// cheaper than the reserved allocation fixes it at - E-2's guarantee
    /// undone from the other side, by anyone, for the price of a transaction.
    /// The curve's own comment says the window has to be closed on both sides;
    /// this is the measurement.
    function test_attack_theGraduationWindowIsClosedOnBothSides() public onlyFork {
        CurbLaunchFactory.LaunchConfig memory launchCfg = _config(true);
        vm.prank(creator);
        (CurbLaunchToken token, PonsV2BondingCurve curve) = factory.launch(launchCfg);
        _fillWithoutGraduating(curve);

        assertTrue(curve.readyToGraduate(), "the curve is not ready, so the window never opened");
        assertFalse(curve.graduated(), "the curve graduated, so this is not the window");

        // THE SELL SIDE - the one that could move the opening price.
        vm.startPrank(trader);
        token.approve(address(curve), type(uint256).max);
        vm.expectRevert(PonsV2BondingCurve.CurveGraduated.selector);
        curve.sell(1_000e18, 0, trader);
        vm.stopPrank();

        // AND THE BUY SIDE, which closes at the allocation rather than at the
        // flag - a different check in the code, so a separate measurement.
        vm.prank(NVDAC_WHALE);
        IERC20(NVDAC).transfer(attacker, 10e8);
        vm.startPrank(attacker);
        IERC20(NVDAC).approve(address(curve), type(uint256).max);
        vm.expectRevert(PonsV2BondingCurve.CurveGraduated.selector);
        curve.buy(10e8, 0, attacker);
        vm.stopPrank();
    }

    /// E-10  A LONG MIXED SEQUENCE, WATCHING THE ACCOUNTING RATHER THAN THE
    ///       PROFIT.
    ///
    /// THE CRITERION, ASSERTED AFTER EVERY SINGLE TRADE: the curve's real
    /// NVDAc balance equals trackedQuote exactly, and the two fee buckets
    /// together never exceed it.
    ///
    /// WHY THAT IS THE INVARIANT AND NOT SOMETHING PRETTIER. trackedQuote is
    /// what graduation hands the pool; the buckets are what the platform and
    /// the creator are owed and are carved out of that same number. If the
    /// balance ever falls BELOW trackedQuote the pool gets seeded with money
    /// that is not there and graduation reverts for good; if the buckets ever
    /// exceed it, a sweep pays out reserve belonging to the holders. Both are
    /// silent - no revert marks the moment - so they have to be watched step
    /// by step rather than checked once at the end.
    ///
    /// Buys and sells interleaved because the two move trackedQuote in
    /// opposite directions while both ADD to the buckets, which is the
    /// combination most likely to drift.
    function test_attack_noSequenceOfTradesCanBreakTheCurvesAccounting() public onlyFork {
        CurbLaunchFactory.LaunchConfig memory launchCfg = _config(true);
        vm.prank(creator);
        (CurbLaunchToken token, PonsV2BondingCurve curve) = factory.launch(launchCfg);

        vm.prank(NVDAC_WHALE);
        IERC20(NVDAC).transfer(attacker, TRADER_FUNDING * 2);
        vm.startPrank(attacker);
        IERC20(NVDAC).approve(address(curve), type(uint256).max);
        token.approve(address(curve), type(uint256).max);

        // Deliberately uneven sizes: equal trades can hide a rounding error by
        // letting it cancel against itself.
        uint256[8] memory buys = [uint256(7e8), 3e8, 11e8, 1e8, 5e8, 13e8, 2e8, 9e8];
        uint256 steps;
        for (uint256 i = 0; i < buys.length; ++i) {
            if (curve.readyToGraduate() || curve.graduated()) break;
            uint256 out = curve.buy(buys[i], 0, attacker);
            _assertCurveBooksBalance(curve, "after a buy");
            ++steps;

            // Sell a THIRD of it back, so the sequence does not simply walk up
            // the curve and the two directions actually interleave.
            if (out > 3 && !curve.readyToGraduate() && !curve.graduated()) {
                curve.sell(out / 3, 0, attacker);
                _assertCurveBooksBalance(curve, "after a sell");
                ++steps;
            }
        }
        vm.stopPrank();

        assertGe(steps, 8, "the sequence was too short to be worth calling a sequence");
        emit log_named_uint("  E-10 trades with the books checked after each", steps);
        emit log_named_uint("  E-10 platform bucket at the end, raw", curve.quoteFeeBalance());
        emit log_named_uint("  E-10 creator bucket at the end,  raw", curve.creatorTaxBalance());
    }

    /// E-11  BUYING PAST THE RESERVED ALLOCATION.
    ///
    /// THE CRITERION: no buy, at any size, may leave trackedTokens below
    /// reservedTokens - and when the curve is finally ready the two must be
    /// EQUAL, not merely close.
    ///
    /// WHY EQUALITY IS THE POINT. The reserved allocation is the pool's entire
    /// seed on the token side. E-2 proves the pool opens at the curve's last
    /// price; that guarantee is computed FROM this number. A buy that ate into
    /// the reserve would seed the pool thin, and one that left some behind
    /// would strand it on a dead curve forever. The curve's prose says it
    /// "fills only up to its reserved allocation" - this is both halves of
    /// that sentence, checked after every buy rather than once at the end.
    function test_attack_theReservedAllocationCannotBeBreached() public onlyFork {
        CurbLaunchFactory.LaunchConfig memory launchCfg = _config(true);
        vm.prank(creator);
        (CurbLaunchToken token, PonsV2BondingCurve curve) = factory.launch(launchCfg);

        // The mint is suppressed so the loop can run to the boundary and STOP
        // there, rather than graduating out from under its own last assertion.
        vm.mockCallRevert(
            address(POSM),
            abi.encodeWithSelector(IPositionManagerMinimal.modifyLiquidities.selector),
            abi.encodeWithSignature("Error(string)", "starved")
        );

        vm.prank(NVDAC_WHALE);
        IERC20(NVDAC).transfer(attacker, TRADER_FUNDING * 4);
        uint256 reserved = curve.reservedTokens();
        uint256 mintedToCurve = curve.trackedTokens();
        assertGt(reserved, 0, "there is no reserved allocation, so this proves nothing");

        vm.startPrank(attacker);
        IERC20(NVDAC).approve(address(curve), type(uint256).max);
        uint256 rounds;
        for (uint256 i = 0; i < 12 && !curve.readyToGraduate(); ++i) {
            // The last round necessarily overshoots, which is the point: the
            // clamp is the branch that could breach the reserve, so the loop
            // has to reach it rather than stopping politely short.
            curve.buy(20e8, 0, attacker);
            assertGe(curve.trackedTokens(), reserved, "a buy ate into the reserved allocation");
            ++rounds;
        }
        vm.stopPrank();
        vm.clearMockedCalls();

        assertTrue(curve.readyToGraduate(), "the loop never reached the threshold, so it proved nothing");
        assertEq(curve.trackedTokens(), reserved, "the allocation was not exhausted exactly");
        assertEq(
            token.balanceOf(attacker),
            mintedToCurve - reserved,
            "the tokens released do not account for the allocation"
        );
        emit log_named_uint("  E-11 buys before the boundary", rounds);
        emit log_named_uint("  E-11 reserved for the pool, raw tokens", reserved);
    }

    /// E-12  GRADUATING SOMEBODY ELSE'S LAUNCH.
    ///
    /// THE CRITERION: the caller gets NOTHING. Not the locked position, not a
    /// share of the reserves, not a token - and the lock's beneficiary is the
    /// creator who launched it.
    ///
    /// WHY IT HAS TO BE BOTH PERMISSIONLESS AND WORTHLESS. Graduation must not
    /// need the creator, or a launch dies whenever they walk away - so anybody
    /// can call it. That makes "whoever calls it" an attacker-controlled input
    /// to the one function that mints the LP position and moves every reserve
    /// the launch holds. The terms it reads come from the write-once registry
    /// record instead, and this is the measurement that the caller is not one
    /// of them.
    function test_attack_graduatingSomeoneElsesLaunchGainsNothing() public onlyFork {
        CurbLaunchFactory.LaunchConfig memory launchCfg = _config(true);
        vm.prank(creator);
        (CurbLaunchToken token, PonsV2BondingCurve curve) = factory.launch(launchCfg);
        _fillWithoutGraduating(curve);

        uint256 quoteBefore = IERC20(NVDAC).balanceOf(attacker);
        uint256 tokensBefore = token.balanceOf(attacker);

        vm.prank(attacker);
        (PositionLock lock,,) = graduator.graduate(address(token));

        assertEq(lock.beneficiary(), creator, "the caller took the locked position");
        assertEq(IERC20(NVDAC).balanceOf(attacker), quoteBefore, "the caller was paid quote to graduate");
        assertEq(token.balanceOf(attacker), tokensBefore, "the caller was paid tokens to graduate");
        assertEq(IERC721(address(POSM)).ownerOf(lock.tokenId()), address(lock), "the position is not in the lock");
    }

    /// The books, checked from both ends. Factored out because E-10 calls it
    /// after every trade, and a copy per call site is a copy per chance to
    /// check the wrong thing.
    function _assertCurveBooksBalance(PonsV2BondingCurve curve, string memory when) internal view {
        uint256 held = IERC20(NVDAC).balanceOf(address(curve));
        assertEq(curve.trackedQuote(), held, string.concat("tracked quote drifted from the balance ", when));
        assertLe(
            curve.quoteFeeBalance() + curve.creatorTaxBalance(),
            held,
            string.concat("the fee buckets exceed the money on hand ", when)
        );
    }

    // ================================================================
    // CROSS-LAUNCH
    //
    // Section E measures one launch at a time. Nothing in this system is
    // per-launch except the curve and the token: the escrow is keyed by
    // RECIPIENT, the hook's fee counter by TOKEN, and the Graduator is a
    // single contract every graduation moves money through. Those are the
    // seams, so these are the tests.
    // ================================================================

    /// X-1  ONE ESCROW, TWO LAUNCHES, AND THE SHARES MUST NOT MIX.
    ///
    /// THE CRITERION: launch B graduating must not move launch A's credit by a
    /// single unit, a claim by one creator must not touch the other's, and the
    /// escrow's actual balance must equal the sum of every credit it owes -
    /// nothing unbacked, nothing unaccounted.
    ///
    /// WHY THE ESCROW IS THE FIRST PLACE TO LOOK. It is keyed by (recipient,
    /// token), NOT by launch, so every launch quoting NVDAc pays into the same
    /// contract and the platform's balance is deliberately the sum of all of
    /// them. A shared pot with per-recipient accounting is exactly the shape
    /// where one launch's money ends up under another's name, and no revert
    /// would mark the moment.
    function test_cross_twoLaunchesShareTheEscrowButNotTheirFees() public onlyFork {
        address creatorA = makeAddr("cross creator A");
        address creatorB = makeAddr("cross creator B");

        // Opposite ends of the legal band, so the two launches cannot produce
        // equal legs and accidentally agree.
        _graduatedBy(creatorA, 100);
        uint256 aCredit = escrowMock.balanceOfToken(creatorA, NVDAC);
        uint256 platformAfterA = escrowMock.balanceOfToken(protocolRecipient, NVDAC);
        assertGt(aCredit, 0, "launch A credited its creator nothing, so this proves nothing");

        _graduatedBy(creatorB, 500);
        uint256 bCredit = escrowMock.balanceOfToken(creatorB, NVDAC);
        assertGt(bCredit, 0, "launch B credited its creator nothing");

        // THE ASSERTION THIS TEST EXISTS FOR.
        assertEq(escrowMock.balanceOfToken(creatorA, NVDAC), aCredit, "B's graduation moved A's credit");
        assertGt(
            escrowMock.balanceOfToken(protocolRecipient, NVDAC),
            platformAfterA,
            "the platform's share did not grow, so the two launches are not sharing anything"
        );

        // FULLY BACKED. Three recipients exist in this fixture and the escrow
        // must hold exactly what it owes them - not more, which would be
        // somebody's stranded transfer counted as reserve, and not less, which
        // would be a credit that cannot be paid.
        uint256 owed = aCredit + bCredit + escrowMock.balanceOfToken(protocolRecipient, NVDAC);
        assertEq(
            IERC20(NVDAC).balanceOf(address(escrowMock)), owed, "the escrow's balance and its credits disagree"
        );

        // AND A CLAIM IS ISOLATED, which is the other half: a shared pot is
        // only safe if drawing from it cannot reach past your own share.
        uint256 escrowBefore = IERC20(NVDAC).balanceOf(address(escrowMock));
        vm.prank(creatorA);
        escrowMock.claimToken(NVDAC);
        assertEq(escrowMock.balanceOfToken(creatorA, NVDAC), 0, "A's claim left A something");
        assertEq(escrowMock.balanceOfToken(creatorB, NVDAC), bCredit, "A's claim moved B's credit");
        assertEq(
            IERC20(NVDAC).balanceOf(address(escrowMock)),
            escrowBefore - aCredit,
            "the escrow paid out something other than exactly A's share"
        );
        emit log_named_uint("  X-1 creator A credit at 100 bps, raw", aCredit);
        emit log_named_uint("  X-1 creator B credit at 500 bps, raw", bCredit);
    }

    /// X-2  TOKENS PARKED ON THE GRADUATOR, THROUGH THEIR OWN LAUNCH'S
    ///      GRADUATION AND THEN SOMEBODY ELSE'S.
    ///
    /// THE CRITERION: the parked tokens survive both graduations untouched,
    /// and the supply falls by the curve's remainder ALONE - not by the
    /// remainder plus somebody's parked transfer.
    ///
    /// THIS IS THE HALF OF A-4 THAT HAS NEVER RUN. _burnRemainder takes a
    /// heldBefore and burns only what arrived above it, and every test of it
    /// so far has passed heldBefore == 0 - the existing donation test says so
    /// itself: "the graduator holds no launch token afterwards because none
    /// was donated to it here". The non-zero branch is the one the fix was
    /// written for and it was the one nothing exercised.
    ///
    /// AN EARLIER VERSION OF THIS TEST PARKED A'S TOKENS AND THEN GRADUATED B,
    /// which could not have failed: _burnRemainder only ever reads the one
    /// token it is handed, so launch A's ERC-20 was never in reach of launch
    /// B's graduation under any version of the code. It asserted something
    /// nothing could break. The parking now happens before A'S OWN
    /// graduation, where the burn genuinely has to tell the two apart, and
    /// B's graduation is kept afterwards as the cross-launch half.
    function test_cross_parkedTokensSurviveTheirOwnLaunchAndTheNextOne() public onlyFork {
        CurbLaunchFactory.LaunchConfig memory cfgA = _config(true);
        vm.prank(creator);
        (CurbLaunchToken tokenA, PonsV2BondingCurve curveA) = factory.launch(cfgA);

        vm.prank(NVDAC_WHALE);
        IERC20(NVDAC).transfer(attacker, 20e8);
        vm.startPrank(attacker);
        IERC20(NVDAC).approve(address(curveA), type(uint256).max);
        uint256 parked = curveA.buy(5e8, 0, attacker);
        // PARKED BY AN ORDINARY TRANSFER, which calls nothing and which the
        // Graduator cannot refuse.
        tokenA.transfer(address(graduator), parked);
        vm.stopPrank();

        assertGt(parked, 0, "the fixture bought nothing to park");
        assertEq(tokenA.balanceOf(address(graduator)), parked, "the fixture did not park the tokens");
        uint256 supplyBefore = tokenA.totalSupply();

        // ---- act one: A'S OWN GRADUATION, with its own tokens sitting there.
        _fillToThreshold(curveA);
        require(curveA.graduated(), "A did not graduate");

        assertEq(
            tokenA.balanceOf(address(graduator)),
            parked,
            "the graduation burned or moved the parked tokens"
        );
        // The remainder WAS burned - so this is not vacuous - and the parked
        // tokens were not part of it.
        uint256 burned = supplyBefore - tokenA.totalSupply();
        assertGt(burned, 0, "nothing was burned at all, so the burn path never ran");
        assertLt(burned, parked + burned, "the parked tokens were counted into the burn");
        assertEq(
            tokenA.totalSupply() + burned, supplyBefore, "supply moved by something other than the burn"
        );

        // ---- act two: SOMEBODY ELSE'S GRADUATION, afterwards.
        uint256 supplyAfterA = tokenA.totalSupply();
        (, CurbLaunchToken tokenB,) = _graduatedBy(makeAddr("cross creator B2"), TOTAL_TAX_BPS);
        assertTrue(address(tokenB) != address(tokenA), "the fixture launched the same token twice");

        assertEq(tokenA.totalSupply(), supplyAfterA, "launch B's graduation burned launch A's supply");
        assertEq(
            tokenA.balanceOf(address(graduator)), parked, "launch B's graduation moved launch A's tokens"
        );
    }

    /// X-3  A GRADUATION MUST NOT LEAVE QUOTE BEHIND FOR THE NEXT ONE TO TAKE.
    ///
    /// THE CRITERION: after each graduation the Graduator holds exactly what it
    /// held before it, and the second launch's refund address receives nothing
    /// from the first.
    ///
    /// WHY RESIDUE IS THE WHOLE RISK. _refund forwards everything above what
    /// was held when the graduation started. That is safe against a donation,
    /// which the existing A-4 test covers. What it cannot be safe against is a
    /// graduation that leaves its OWN dust behind: the next launch's refund
    /// address would be handed it, and unlike a donation this would happen on
    /// its own, every time, with nobody having done anything strange.
    ///
    /// AND THE REFUND IS MEASURED TO BE EMPTY, which is the part worth pinning.
    /// The Graduator says so in prose - "with any phantom liquidity at all the
    /// quote is the binding side and this is measured to be zero, but it is
    /// not guaranteed to be" - and a sentence claiming a measurement should be
    /// one. So the refund address receiving EXACTLY NOTHING is asserted rather
    /// than merely allowed.
    ///
    /// THIS TEST DOES NOT GUARD THE REFUND LOGIC, and pretending otherwise
    /// would be the mistake. Disabling _refund entirely leaves it green,
    /// measured - correctly, because nothing flows through that path here.
    /// What it guards is the CLAIM: the day the quote stops binding exactly,
    /// a launch starts leaving dust for the next one and this goes red.
    function test_cross_neitherGraduationLeavesResidueForTheNext() public onlyFork {
        address sinkA = makeAddr("cross refund A");
        address sinkB = makeAddr("cross refund B");

        uint256 gradBefore = IERC20(NVDAC).balanceOf(address(graduator));

        CurbLaunchFactory.LaunchConfig memory cfgA = _config(true);
        cfgA.quoteRefundTo = sinkA;
        cfgA.salt = _saltForSide(cfgA, true);
        vm.prank(creator);
        (, PonsV2BondingCurve curveA) = factory.launch(cfgA);
        _fillToThreshold(curveA);
        require(curveA.graduated(), "A did not graduate");

        assertEq(
            IERC20(NVDAC).balanceOf(address(graduator)),
            gradBefore,
            "launch A's graduation left quote on the graduator"
        );
        uint256 sinkAAfterA = IERC20(NVDAC).balanceOf(sinkA);
        assertEq(sinkAAfterA, 0, "launch A refunded quote - the quote side no longer binds exactly");

        CurbLaunchFactory.LaunchConfig memory cfgB = _config(true);
        cfgB.quoteRefundTo = sinkB;
        cfgB.salt = _saltForSide(cfgB, true);
        vm.prank(creator);
        (, PonsV2BondingCurve curveB) = factory.launch(cfgB);
        _fillToThreshold(curveB);
        require(curveB.graduated(), "B did not graduate");

        assertEq(
            IERC20(NVDAC).balanceOf(address(graduator)),
            gradBefore,
            "launch B's graduation left quote on the graduator"
        );
        assertEq(
            IERC20(NVDAC).balanceOf(sinkA), sinkAAfterA, "launch B's graduation paid launch A's refund address"
        );
        assertEq(IERC20(NVDAC).balanceOf(sinkB), 0, "launch B refunded quote - the quote side no longer binds");
    }

    /// X-4  TWO LAUNCHES, TWO TAXES, AND AN IDENTICAL POOL EITHER WAY.
    ///
    /// THE CRITERION: each pool opens at the price computed from ITS OWN curve;
    /// the two pools come out identical in price AND depth; the two curves were
    /// paid DIFFERENT amounts to get there; and each locked position belongs to
    /// its own launch's creator.
    ///
    /// THIS TEST WAS WRONG TWICE AND THAT IS WHERE IT CAME FROM. It first
    /// asserted the two prices differ - red, identical. Then that the 5% launch
    /// would be seeded thinner - red, identical to the wei. Neither was a bug;
    /// both were me assuming the tax reaches the pool.
    ///
    /// IT DOES NOT, AND HERE IS WHY. The graduation threshold is measured on
    /// realQuoteReserve(), which already excludes both fee buckets. So the
    /// curve fills until the quote NET OF TAX reaches the threshold, whatever
    /// the tax was - and hands the pool that same number every time, against
    /// the same reserved allocation. Price and depth are factory constants
    /// wearing a disguise.
    ///
    /// SO THE TAX IS PAID BY THE TRADERS ON THE WAY UP AND BY NOBODY ELSE. A
    /// 5% launch costs its buyers more to fill and opens exactly the pool a 1%
    /// launch opens. That is a real product statement, it had never been
    /// written down, and the last two assertions here are what hold it.
    ///
    /// AND WHAT PROVES THE RECORDS ARE SEPARATE, since price and depth now
    /// cannot: the locked position belongs to each launch's OWN creator. Two
    /// graduations through one Graduator reading one registry, and neither
    /// picked up the other's terms.
    function test_cross_eachPoolOpensAtItsOwnCurvesPrice() public onlyFork {
        address creatorA = makeAddr("cross creator A4");
        address creatorB = makeAddr("cross creator B4");

        (CurbLaunchToken tokenA, uint160 wantA, uint256 paidA) = _fillAndPrice(creatorA, 100);
        (PositionLock lockA,,) = graduator.graduate(address(tokenA));
        PoolId idA = _keyFor(tokenA, IHooks(address(hook))).toId();
        (uint160 openedA,,,) = POOL_MANAGER.getSlot0(idA);

        (CurbLaunchToken tokenB, uint160 wantB, uint256 paidB) = _fillAndPrice(creatorB, 500);
        (PositionLock lockB,,) = graduator.graduate(address(tokenB));
        PoolId idB = _keyFor(tokenB, IHooks(address(hook))).toId();
        (uint160 openedB,,,) = POOL_MANAGER.getSlot0(idB);

        assertEq(openedA, wantA, "pool A did not open at launch A's price");
        assertEq(openedB, wantB, "pool B did not open at launch B's price");

        // THE SAME, DELIBERATELY - TO THE WEI OF ROUNDING. If either of these
        // ever moves by more, a creator has gained the ability to choose the
        // pool their buyers land in. Not exact: the last buy's fee and tax
        // are floored separately (see E-8), so the reserve a curve closes on
        // can differ by a unit or two of quote with the tax - at D1's 60/60
        // it happened not to, at 18.1/49.1 it moved the opening price by
        // under one part in ten billion, and the shipped 18.5/50.0 passes the
        // same line. One part in a billion is
        // the line: a tax that reached the price would move it by about its
        // own size, the four points between 1% and 5%, millions of times more.
        assertApproxEqRel(openedA, openedB, 1e9, "two launches opened at different prices");
        uint128 liqA = POOL_MANAGER.getLiquidity(idA);
        uint128 liqB = POOL_MANAGER.getLiquidity(idB);
        assertGt(liqA, 0, "pool A was seeded with nothing");
        assertApproxEqRel(liqA, liqB, 1e9, "two launches were seeded with different depth");

        // AND THE PRICE OF THAT SAMENESS WAS PAID BY THE BUYERS. Without this
        // the two assertions above would also pass on a curve that ignored the
        // tax entirely.
        assertGt(paidB, paidA, "the 5% launch did not cost its buyers more than the 1% one");

        // THE RECORDS STAYED APART.
        assertEq(lockA.beneficiary(), creatorA, "launch A's position went to the wrong creator");
        assertEq(lockB.beneficiary(), creatorB, "launch B's position went to the wrong creator");

        emit log_named_uint("  X-4 both pools opened at sqrtPrice", openedA);
        emit log_named_uint("  X-4 both pools seeded with liquidity", liqA);
        emit log_named_uint("  X-4 paid into the 100 bps curve, raw", paidA);
        emit log_named_uint("  X-4 paid into the 500 bps curve, raw", paidB);
    }

    /// X-5  ONE HOOK, TWO TAXES.
    ///
    /// THE CRITERION: an identical swap in each pool is charged that POOL'S
    /// tax - 100 bps in one, 500 in the other - and the hook's shared counter
    /// ends at the sum of the two, not at either one doubled.
    ///
    /// WHY THIS IS THE SHARPEST SEAM IN THE SYSTEM. There is ONE FeeHook for
    /// every pool. It keeps a frozen config per pool id and a fee total per
    /// TOKEN, so the config is separated and the counter is deliberately not.
    /// If a swap ever read the wrong pool's frozen config, the money would go
    /// to the wrong creator at the wrong rate and every number involved would
    /// still look plausible.
    function test_cross_oneHookChargesEachPoolItsOwnTax() public onlyFork {
        address creatorA = makeAddr("cross creator A5");
        address creatorB = makeAddr("cross creator B5");
        (PoolKey memory keyA, CurbLaunchToken tokenA,) = _graduatedBy(creatorA, 100);
        (PoolKey memory keyB, CurbLaunchToken tokenB,) = _graduatedBy(creatorB, 500);

        uint128 amountIn = 1e7; // 0.1 NVDAc, the same into both
        (uint256 platA, uint256 credA) = _taxLegs(amountIn, 100);
        (uint256 platB, uint256 credB) = _taxLegs(amountIn, 500);
        assertTrue(credA != credB, "the two taxes produce the same creator leg, so this proves nothing");

        vm.prank(NVDAC_WHALE);
        IERC20(NVDAC).transfer(trader, 5e8);
        uint256 collectedBefore = hook.collected(NVDAC);
        uint256 platformBefore = IERC20(NVDAC).balanceOf(protocolRecipient);

        uint256 aBefore = IERC20(NVDAC).balanceOf(creatorA);
        assertGt(_routerSwap(keyA, NVDAC, address(tokenA), amountIn, 1), 0, "the swap in pool A delivered nothing");
        assertEq(IERC20(NVDAC).balanceOf(creatorA) - aBefore, credA, "pool A did not charge pool A's tax");

        uint256 bBefore = IERC20(NVDAC).balanceOf(creatorB);
        assertGt(_routerSwap(keyB, NVDAC, address(tokenB), amountIn, 1), 0, "the swap in pool B delivered nothing");
        assertEq(IERC20(NVDAC).balanceOf(creatorB) - bBefore, credB, "pool B did not charge pool B's tax");

        // AND NEITHER SWAP PAID THE OTHER'S CREATOR.
        assertEq(IERC20(NVDAC).balanceOf(creatorA) - aBefore, credA, "pool B's swap paid launch A's creator");

        // THE SHARED COUNTER IS THE SUM, which is what "shared" has to mean.
        assertEq(
            hook.collected(NVDAC) - collectedBefore,
            platA + credA + platB + credB,
            "the hook's token-wide counter is not the two pools added up"
        );
        assertEq(
            IERC20(NVDAC).balanceOf(protocolRecipient) - platformBefore,
            platA + platB,
            "the platform was not paid both pools' legs"
        );
        emit log_named_uint("  X-5 creator A leg at 100 bps, raw", credA);
        emit log_named_uint("  X-5 creator B leg at 500 bps, raw", credB);
    }

    /// X-6  THE SAME CONFIGURATION LAUNCHED TWICE.
    ///
    /// THE CRITERION: two distinct tokens, two distinct curves, two registry
    /// records, each with its own launcher - or a clean revert. What must not
    /// happen is one launch quietly overwriting the other's record.
    ///
    /// WHY THE SALT IS NOT ENOUGH TO COLLIDE. The token's CREATE2 address
    /// folds in the curve address, and the curve is made with CREATE at the
    /// factory's CURRENT NONCE - so the second launch derives a different
    /// address from identical calldata. That is worth pinning precisely
    /// BECAUSE it is not obvious: a reader who sees a caller-supplied salt
    /// reasonably expects reusing it to collide.
    function test_cross_relaunchingTheSameConfigCannotOverwriteTheFirst() public onlyFork {
        CurbLaunchFactory.LaunchConfig memory cfg = _config(true);

        vm.prank(creator);
        (CurbLaunchToken tokenA, PonsV2BondingCurve curveA) = factory.launch(cfg);

        address second = makeAddr("second launcher");
        vm.prank(second);
        (CurbLaunchToken tokenB, PonsV2BondingCurve curveB) = factory.launch(cfg);

        assertTrue(address(tokenA) != address(tokenB), "the same salt produced the same token");
        assertTrue(address(curveA) != address(curveB), "the same salt produced the same curve");

        LaunchRegistry.Launch memory recA = registry.launchOf(address(tokenA));
        LaunchRegistry.Launch memory recB = registry.launchOf(address(tokenB));
        assertEq(recA.curve, address(curveA), "launch A's record does not point at launch A's curve");
        assertEq(recB.curve, address(curveB), "launch B's record does not point at launch B's curve");
        assertEq(recA.beneficiary, creator, "the second launch overwrote the first's beneficiary");
        assertEq(recB.beneficiary, second, "the second launch did not record its own launcher");
    }

    /// Y-1  TWO GRADUATIONS IN ONE TRANSACTION, TRIGGERED DELIBERATELY.
    ///
    /// THE CRITERION IS A COMPARISON, not a list of properties: a reference
    /// launch is graduated in its OWN transaction first, and the two that
    /// share a transaction must come out indistinguishable from it - same
    /// opening price, same depth - with each lock going to its own creator and
    /// nothing left on the Graduator.
    ///
    /// WHY A TRANSACTION IS A DIFFERENT UNIT FROM A CALL. Uniswap v4 keeps its
    /// currency deltas and its unlock flag in TRANSIENT storage, which is
    /// cleared at the end of a transaction and not at the end of a call. Every
    /// graduation in section F landed in a transaction of its own, so the
    /// second one has never had to run on top of whatever the first left
    /// behind. Both graduations here settle the same currency, NVDAc, which is
    /// where a leftover delta would show.
    ///
    /// WHY IT IS NOT AN EXOTIC CASE. Graduation is permissionless on purpose,
    /// so anyone may call it, twice, from a contract - and Y-2 shows the same
    /// thing happening without anyone intending it.
    function test_cross_twoGraduationsInOneTransactionMatchTwoSeparateOnes() public onlyFork {
        // ---- the reference, graduated alone, in its own transaction.
        (CurbLaunchToken tokenR,,) = _fillAndPrice(makeAddr("ref creator"), TOTAL_TAX_BPS);
        graduator.graduate(address(tokenR));
        PoolId idR = _keyFor(tokenR, IHooks(address(hook))).toId();
        (uint160 priceR,,,) = POOL_MANAGER.getSlot0(idR);
        uint128 liqR = POOL_MANAGER.getLiquidity(idR);
        assertGt(liqR, 0, "the reference pool was seeded with nothing");

        // ---- two more, both left standing at the boundary.
        address cA = makeAddr("one tx creator A");
        address cB = makeAddr("one tx creator B");
        (CurbLaunchToken tokenA, uint160 wantA,) = _fillAndPrice(cA, TOTAL_TAX_BPS);
        (CurbLaunchToken tokenB, uint160 wantB,) = _fillAndPrice(cB, TOTAL_TAX_BPS);

        uint256 gradBefore = IERC20(NVDAC).balanceOf(address(graduator));

        // ---- ONE TRANSACTION, BOTH.
        DoubleGraduation both = new DoubleGraduation();
        (PositionLock lockA, PositionLock lockB) =
            both.graduateBoth(graduator, address(tokenA), address(tokenB));

        PoolId idA = _keyFor(tokenA, IHooks(address(hook))).toId();
        PoolId idB = _keyFor(tokenB, IHooks(address(hook))).toId();
        (uint160 openedA,,,) = POOL_MANAGER.getSlot0(idA);
        (uint160 openedB,,,) = POOL_MANAGER.getSlot0(idB);

        assertEq(openedA, wantA, "pool A did not open at launch A's own price");
        assertEq(openedB, wantB, "pool B did not open at launch B's own price");

        // THE COMPARISON THIS TEST EXISTS FOR.
        assertEq(openedA, priceR, "sharing a transaction moved the first pool's opening price");
        assertEq(openedB, priceR, "sharing a transaction moved the second pool's opening price");
        assertEq(POOL_MANAGER.getLiquidity(idA), liqR, "sharing a transaction changed pool A's depth");
        assertEq(POOL_MANAGER.getLiquidity(idB), liqR, "sharing a transaction changed pool B's depth");

        // AND NOTHING CROSSED BETWEEN THEM.
        assertEq(lockA.beneficiary(), cA, "launch A's position went to the wrong creator");
        assertEq(lockB.beneficiary(), cB, "launch B's position went to the wrong creator");
        assertTrue(address(lockA) != address(lockB), "both launches got the same lock");
        assertEq(
            IERC20(NVDAC).balanceOf(address(graduator)),
            gradBefore,
            "the shared transaction left quote on the graduator"
        );
        assertEq(IERC20(NVDAC).balanceOf(address(both)), 0, "the caller was paid for graduating");
    }

    /// Y-2  THE SAME THING WITHOUT ANYONE MEANING IT.
    ///
    /// THE CRITERION: identical to Y-1, but nobody calls graduate() at all -
    /// one transaction buys the last slice of two curves and each crossing buy
    /// graduates its own launch on the way out.
    ///
    /// WHY THIS IS THE ONE THAT WILL ACTUALLY HAPPEN. Nobody sets out to
    /// graduate two launches at once. An aggregator, a batcher or a bot
    /// filling two pending buys in one transaction does it without intending
    /// to, and the second graduation then runs inside a transaction the first
    /// has already left its marks on.
    ///
    /// AND THE GRADUATION IS NESTED HERE, which Y-1's is not: it happens from
    /// inside buy()'s own reentrancy-guarded scope, through _tryAutoGraduate,
    /// which is why graduate() is deliberately not nonReentrant. Y-1 exercises
    /// two graduations side by side; this exercises two of them each wrapped
    /// in a curve call, in one transaction.
    function test_cross_twoCrossingBuysInOneTransactionGraduateBothCleanly() public onlyFork {
        (CurbLaunchToken tokenR,,) = _fillAndPrice(makeAddr("ref creator 2"), TOTAL_TAX_BPS);
        graduator.graduate(address(tokenR));
        PoolId idR = _keyFor(tokenR, IHooks(address(hook))).toId();
        (uint160 priceR,,,) = POOL_MANAGER.getSlot0(idR);
        uint128 liqR = POOL_MANAGER.getLiquidity(idR);

        // Two fresh launches, untouched - the finisher's buy has to cross both.
        address cA = makeAddr("batched creator A");
        address cB = makeAddr("batched creator B");
        CurbLaunchFactory.LaunchConfig memory cfgA = _config(true);
        vm.prank(cA);
        (CurbLaunchToken tokenA, PonsV2BondingCurve curveA) = factory.launch(cfgA);
        CurbLaunchFactory.LaunchConfig memory cfgB = _config(true);
        vm.prank(cB);
        (CurbLaunchToken tokenB, PonsV2BondingCurve curveB) = factory.launch(cfgB);

        DoubleFinisher finisher = new DoubleFinisher();
        vm.prank(NVDAC_WHALE);
        IERC20(NVDAC).transfer(attacker, TRADER_FUNDING * 4);
        vm.startPrank(attacker);
        IERC20(NVDAC).approve(address(finisher), type(uint256).max);
        // Oversized on purpose: each curve fills to its allocation and refunds
        // the rest, so both cross inside the one call.
        finisher.finishBoth(IERC20(NVDAC), curveA, curveB, TRADER_FUNDING);
        vm.stopPrank();

        assertTrue(curveA.graduated(), "curve A did not graduate from the batched buy");
        assertTrue(curveB.graduated(), "curve B did not graduate from the batched buy");

        PoolId idA = _keyFor(tokenA, IHooks(address(hook))).toId();
        PoolId idB = _keyFor(tokenB, IHooks(address(hook))).toId();
        (uint160 openedA,,,) = POOL_MANAGER.getSlot0(idA);
        (uint160 openedB,,,) = POOL_MANAGER.getSlot0(idB);

        assertEq(openedA, priceR, "the batched buy moved pool A's opening price");
        assertEq(openedB, priceR, "the batched buy moved pool B's opening price");
        assertEq(POOL_MANAGER.getLiquidity(idA), liqR, "the batched buy changed pool A's depth");
        assertEq(POOL_MANAGER.getLiquidity(idB), liqR, "the batched buy changed pool B's depth");

        // THE BATCHER KEPT NOTHING, which is what makes the refunds and the
        // two graduations add up rather than merely look plausible.
        assertEq(IERC20(NVDAC).balanceOf(address(finisher)), 0, "the batcher kept quote");
        assertEq(tokenA.balanceOf(address(finisher)), 0, "the batcher kept launch A's tokens");
        assertEq(tokenB.balanceOf(address(finisher)), 0, "the batcher kept launch B's tokens");
    }

    /// F-10  THREE LAUNCHES, THREE CREATORS, ONE ESCROW.
    ///
    /// THE CRITERION: each creator's credit is untouched by BOTH of the other
    /// two graduations - checked after each one, not once at the end - and the
    /// escrow's balance equals the sum of all four credits exactly.
    ///
    /// WHY THREE AND NOT TWO. With two launches, "A was not disturbed by B" is
    /// also what you would see if credits were being written to the wrong slot
    /// in a way that happened to land on B's. Three gives the mistake somewhere
    /// else to land, and the platform - which is SUPPOSED to accumulate from
    /// all of them - is the fourth party that tells accumulation apart from
    /// leakage.
    function test_cross_threeLaunchesKeepTheirCreditsApart() public onlyFork {
        address cA = makeAddr("three creator A");
        address cB = makeAddr("three creator B");
        address cC = makeAddr("three creator C");

        _graduatedBy(cA, 100);
        uint256 aCredit = escrowMock.balanceOfToken(cA, NVDAC);
        uint256 platform1 = escrowMock.balanceOfToken(protocolRecipient, NVDAC);
        assertGt(aCredit, 0, "launch A credited its creator nothing");

        _graduatedBy(cB, 300);
        uint256 bCredit = escrowMock.balanceOfToken(cB, NVDAC);
        uint256 platform2 = escrowMock.balanceOfToken(protocolRecipient, NVDAC);
        assertEq(escrowMock.balanceOfToken(cA, NVDAC), aCredit, "B's graduation moved A's credit");
        assertGt(platform2, platform1, "the platform did not accumulate B's leg");

        _graduatedBy(cC, 500);
        uint256 cCredit = escrowMock.balanceOfToken(cC, NVDAC);
        uint256 platform3 = escrowMock.balanceOfToken(protocolRecipient, NVDAC);

        // AFTER THE THIRD, BOTH EARLIER ONES ARE STILL EXACTLY WHERE THEY WERE.
        assertEq(escrowMock.balanceOfToken(cA, NVDAC), aCredit, "C's graduation moved A's credit");
        assertEq(escrowMock.balanceOfToken(cB, NVDAC), bCredit, "C's graduation moved B's credit");
        assertGt(platform3, platform2, "the platform did not accumulate C's leg");

        // THREE DIFFERENT TAXES, THREE DIFFERENT CREDITS - so none of the
        // assertions above can be passing because the numbers coincide.
        assertTrue(aCredit != bCredit && bCredit != cCredit && aCredit != cCredit, "two credits came out equal");

        // AND EVERY UNIT THE ESCROW HOLDS IS SPOKEN FOR.
        assertEq(
            IERC20(NVDAC).balanceOf(address(escrowMock)),
            aCredit + bCredit + cCredit + platform3,
            "the escrow holds something no credit accounts for"
        );

        // A CLAIM FROM THE MIDDLE ONE REACHES NEITHER NEIGHBOUR.
        vm.prank(cB);
        escrowMock.claimToken(NVDAC);
        assertEq(escrowMock.balanceOfToken(cA, NVDAC), aCredit, "B's claim took from A");
        assertEq(escrowMock.balanceOfToken(cC, NVDAC), cCredit, "B's claim took from C");
        assertEq(escrowMock.balanceOfToken(protocolRecipient, NVDAC), platform3, "B's claim took from the platform");

        emit log_named_uint("  F-10 credit at 100 bps, raw", aCredit);
        emit log_named_uint("  F-10 credit at 300 bps, raw", bCredit);
        emit log_named_uint("  F-10 credit at 500 bps, raw", cCredit);
    }

    /// F-11  THREE GRADUATIONS IN ONE TRANSACTION, OUT OF REGISTRATION ORDER.
    ///
    /// THE CRITERION: launched A, B, C and graduated C, A, B - in one
    /// transaction - every pool must still open at its own price and match a
    /// launch graduated alone, and every lock must go to its own creator.
    ///
    /// WHY THE ORDER IS THE POINT. F-8 put two graduations in one transaction,
    /// but two can only be done in one order or its reverse, so nothing there
    /// separates "handled independently" from "handled in the order they were
    /// registered". Three graduated out of order is the case a lookup keyed on
    /// POSITION rather than on identity gets wrong - and the registry keeps an
    /// ordered _all array beside its mapping, so a position-keyed read is a
    /// plausible thing for someone to write.
    function test_cross_threeGraduationsOutOfOrderInOneTransaction() public onlyFork {
        (CurbLaunchToken tokenR,,) = _fillAndPrice(makeAddr("ref creator 3"), TOTAL_TAX_BPS);
        graduator.graduate(address(tokenR));
        PoolId idR = _keyFor(tokenR, IHooks(address(hook))).toId();
        (uint160 priceR,,,) = POOL_MANAGER.getSlot0(idR);
        uint128 liqR = POOL_MANAGER.getLiquidity(idR);
        assertGt(liqR, 0, "the reference pool was seeded with nothing");

        address cA = makeAddr("order creator A");
        address cB = makeAddr("order creator B");
        address cC = makeAddr("order creator C");
        (CurbLaunchToken tokenA, uint160 wantA,) = _fillAndPrice(cA, TOTAL_TAX_BPS);
        (CurbLaunchToken tokenB, uint160 wantB,) = _fillAndPrice(cB, TOTAL_TAX_BPS);
        (CurbLaunchToken tokenC, uint160 wantC,) = _fillAndPrice(cC, TOTAL_TAX_BPS);

        uint256 gradBefore = IERC20(NVDAC).balanceOf(address(graduator));

        // REGISTERED A, B, C - GRADUATED C, A, B.
        address[] memory order = new address[](3);
        order[0] = address(tokenC);
        order[1] = address(tokenA);
        order[2] = address(tokenB);

        DoubleGraduation many = new DoubleGraduation();
        PositionLock[] memory locks = many.graduateAll(graduator, order);

        _assertOpenedLike(tokenC, wantC, priceR, liqR, "C");
        _assertOpenedLike(tokenA, wantA, priceR, liqR, "A");
        _assertOpenedLike(tokenB, wantB, priceR, liqR, "B");

        assertEq(locks[0].beneficiary(), cC, "the first graduation's lock went to the wrong creator");
        assertEq(locks[1].beneficiary(), cA, "the second graduation's lock went to the wrong creator");
        assertEq(locks[2].beneficiary(), cB, "the third graduation's lock went to the wrong creator");
        assertTrue(
            address(locks[0]) != address(locks[1]) && address(locks[1]) != address(locks[2])
                && address(locks[0]) != address(locks[2]),
            "two launches got the same lock"
        );
        assertEq(
            IERC20(NVDAC).balanceOf(address(graduator)),
            gradBefore,
            "three graduations in one transaction left quote behind"
        );
        assertEq(IERC20(NVDAC).balanceOf(address(many)), 0, "the caller was paid for graduating");
    }

    /// One pool measured three ways: against its own computed price, and
    /// against a launch that graduated alone in its own transaction.
    function _assertOpenedLike(
        CurbLaunchToken token,
        uint160 want,
        uint160 priceR,
        uint128 liqR,
        string memory which
    ) internal view {
        PoolId id = _keyFor(token, IHooks(address(hook))).toId();
        (uint160 opened,,,) = POOL_MANAGER.getSlot0(id);
        assertEq(opened, want, string.concat("pool ", which, " did not open at its own price"));
        assertEq(opened, priceR, string.concat("pool ", which, " differs from a lone graduation"));
        assertEq(POOL_MANAGER.getLiquidity(id), liqR, string.concat("pool ", which, " has the wrong depth"));
    }

    /// THE CREATOR WALLET IS PAID, AND THE LAUNCHER IS NOT.
    ///
    /// THE CRITERION: with creatorWallet set, all three of the things that used
    /// to follow msg.sender follow the wallet instead - the curve's creator-fee
    /// recipient, the hook's creator for the graduated pool, and the locked LP
    /// position - and the address that actually sent the transaction ends with
    /// nothing.
    ///
    /// WHY ALL THREE AND NOT JUST THE FEES. They were one address before this
    /// field existed, and splitting only some of them would be worse than
    /// either: a creator who moved their income to a cold wallet and left the
    /// LP on the hot one would not have been told.
    function test_creatorWalletIsPaidAndTheLauncherIsNot() public onlyFork {
        address launcher = makeAddr("hot launcher");
        address wallet = makeAddr("cold creator wallet");

        CurbLaunchFactory.LaunchConfig memory cfg = _config(true);
        cfg.creatorWallet = wallet;
        cfg.salt = _saltForSide(cfg, true);

        vm.prank(launcher);
        (CurbLaunchToken token, PonsV2BondingCurve curve) = factory.launch(cfg);

        // 1. THE CURVE PAYS THE WALLET. `deployer` is the curve's name for the
        //    creator-fee recipient [PonsV2BondingCurve.sol:108].
        assertEq(curve.deployer(), wallet, "the curve pays the launcher, not the creator wallet");

        // 2. THE RECORD NAMES THE WALLET, which is what the hook reads as the
        //    creator for the graduated pool's fees.
        LaunchRegistry.Launch memory rec = registry.launchOf(address(token));
        assertEq(rec.beneficiary, wallet, "the record names the launcher");

        // 3. AND THE LOCKED POSITION ANSWERS TO IT.
        _fillWithoutGraduating(curve);
        (PositionLock lock,,) = graduator.graduate(address(token));
        assertEq(lock.beneficiary(), wallet, "the locked position went to the launcher");

        // THE LAUNCHER GOT NOTHING. Not the fees, not the position, not a
        // token - which is the whole point of separating them.
        assertEq(IERC20(NVDAC).balanceOf(launcher), 0, "the launcher was paid quote");
        assertEq(token.balanceOf(launcher), 0, "the launcher was given launch tokens");
        assertTrue(launcher != wallet, "the fixture used one address for both, so this proves nothing");
    }

    /// ZERO STILL MEANS THE SENDER, and this is the assertion that lets the
    /// field be added at all.
    ///
    /// Every call site that predates it passes address(0), and the deployment
    /// script is one of them. If the default ever stopped resolving to
    /// msg.sender, those launches would silently pay an address nobody chose -
    /// address(0) among them.
    function test_creatorWalletDefaultsToTheSender() public onlyFork {
        address launcher = makeAddr("plain launcher");
        CurbLaunchFactory.LaunchConfig memory cfg = _config(true);
        assertEq(cfg.creatorWallet, address(0), "the fixture set a wallet, so the default is not what is measured");

        vm.prank(launcher);
        (CurbLaunchToken token, PonsV2BondingCurve curve) = factory.launch(cfg);

        assertEq(curve.deployer(), launcher, "the default did not resolve to the sender");
        assertEq(registry.launchOf(address(token)).beneficiary, launcher, "the record did not name the sender");
    }

    /// THE CREATOR BUYS FIRST, IN THE LAUNCH ITSELF.
    ///
    /// THE CRITERION: the creator wallet ends holding launch tokens, the curve
    /// ends holding the quote, and the FACTORY ends holding nothing.
    ///
    /// WHY THE LAST ONE MATTERS MOST. Before this the factory moved no tokens
    /// at all, so a bug in it could not cost anybody money. It custodies the
    /// caller's quote asset for the length of one call now, and "holds nothing
    /// afterwards" is the property that keeps that bounded.
    function test_devBuy_theCreatorGetsTheFirstTokensAndTheFactoryKeepsNothing() public onlyFork {
        address wallet = makeAddr("devbuy creator wallet");
        // Under the cap: at most a fifth of the supply, about 4.6 NVDAc here.
        uint256 spend = 3e8;

        vm.prank(NVDAC_WHALE);
        IERC20(NVDAC).transfer(creator, TRADER_FUNDING);

        CurbLaunchFactory.LaunchConfig memory cfg = _config(true);
        cfg.creatorWallet = wallet;
        cfg.devBuy = spend;
        cfg.salt = _saltForSide(cfg, true);

        uint256 senderBefore = IERC20(NVDAC).balanceOf(creator);

        vm.startPrank(creator);
        IERC20(NVDAC).approve(address(factory), spend);
        (CurbLaunchToken token, PonsV2BondingCurve curve) = factory.launch(cfg);
        vm.stopPrank();

        // THE TOKENS WENT TO THE WALLET, not to whoever sent the transaction.
        assertGt(token.balanceOf(wallet), 0, "the creator wallet got no tokens");
        assertEq(token.balanceOf(creator), 0, "the sender got the tokens instead of the wallet");

        // THE QUOTE REACHED THE CURVE, and the sender paid for it.
        assertEq(IERC20(NVDAC).balanceOf(address(curve)), spend, "the curve did not receive the dev buy");
        assertEq(senderBefore - IERC20(NVDAC).balanceOf(creator), spend, "the sender paid something other than the dev buy");

        // AND THE FACTORY KEPT NOTHING - neither the quote nor the token, and
        // no allowance standing on the curve.
        assertEq(IERC20(NVDAC).balanceOf(address(factory)), 0, "the factory kept quote");
        assertEq(token.balanceOf(address(factory)), 0, "the factory kept launch tokens");
        assertEq(IERC20(NVDAC).allowance(address(factory), address(curve)), 0, "the factory left an allowance standing");

        // The launch is still a launch: not graduated, and still tradeable.
        assertFalse(curve.graduated(), "the dev buy graduated the launch inside its own creation");
    }

    /// An untouched curve on the fixture's terms at `taxBps`: a launch with no
    /// dev buy, to price one against (DevBuyCap). Every curve on this factory
    /// starts from the same reserves, so a dev buy on the next launch at the
    /// same tax moves exactly the way a buy on this one would.
    function _freshCurveAt(uint16 taxBps) internal returns (PonsV2BondingCurve curve) {
        CurbLaunchFactory.LaunchConfig memory cfg = _config(true);
        cfg.totalTaxBps = taxBps;
        cfg.salt = _saltForSide(cfg, true);
        vm.prank(creator);
        (, curve) = factory.launch(cfg);
    }

    /// A launch at `taxBps` whose dev buy of `spend` the creator approved.
    function _launchWithDevBuy(uint16 taxBps, uint256 spend)
        internal
        returns (CurbLaunchToken token, PonsV2BondingCurve curve)
    {
        CurbLaunchFactory.LaunchConfig memory cfg = _config(true);
        cfg.totalTaxBps = taxBps;
        cfg.devBuy = spend;
        cfg.salt = _saltForSide(cfg, true);
        vm.startPrank(creator);
        IERC20(NVDAC).approve(address(factory), spend);
        (token, curve) = factory.launch(cfg);
        vm.stopPrank();
    }

    /// The same launch, expected to be refused with exactly `why`. The salt is
    /// mined BEFORE expectRevert: _saltForSide makes a call of its own, and
    /// the expectation would be spent on it.
    function _refuseDevBuy(uint16 taxBps, uint256 spend, bytes memory why) internal {
        CurbLaunchFactory.LaunchConfig memory cfg = _config(true);
        cfg.totalTaxBps = taxBps;
        cfg.devBuy = spend;
        cfg.salt = _saltForSide(cfg, true);
        vm.startPrank(creator);
        IERC20(NVDAC).approve(address(factory), spend);
        vm.expectRevert(why);
        factory.launch(cfg);
        vm.stopPrank();
    }

    /// A DEV BUY THAT COULD GRADUATE THE LAUNCH IS REFUSED - and one wei
    /// below the threshold is refused by the token cap instead.
    ///
    /// THE CRITERION: at the threshold DevBuyTooLarge, before any quote moves;
    /// at threshold - 1 DevBuyAboveShare, with the tokens that buy would have
    /// received.
    ///
    /// WHY REFUSED RATHER THAN HANDLED. Graduating inside launch() would build
    /// the pool, mint the position and create the lock in the same call that
    /// creates the token - a great deal of machinery in one transaction, for a
    /// case nobody needs. Strictly below the threshold means the net added to
    /// the reserve is strictly below it, so readyToGraduate() cannot be true
    /// when the buy returns. THE THRESHOLD RULE IS THE LIVE ONE AGAIN: it
    /// stood behind a quote ceiling of three quarters of the threshold, and
    /// the cap is in tokens now. Without it the threshold itself would reach
    /// the buy and be refused by the cap (the tax keeps its net below the
    /// threshold), which is the wrong error, and this test says which.
    function test_devBuy_atTheThresholdIsRefused() public onlyFork {
        uint256 threshold = factory.graduationThreshold();

        vm.prank(NVDAC_WHALE);
        IERC20(NVDAC).transfer(creator, TRADER_FUNDING * 2);

        uint256 senderBefore = IERC20(NVDAC).balanceOf(creator);
        _refuseDevBuy(
            TOTAL_TAX_BPS, threshold,
            abi.encodeWithSelector(CurbLaunchFactory.DevBuyTooLarge.selector, threshold, threshold)
        );

        PonsV2BondingCurve fresh = _freshCurveAt(TOTAL_TAX_BPS);
        uint256 cap = (SUPPLY * factory.MAX_DEV_BUY_BPS()) / 10_000;
        _refuseDevBuy(
            TOTAL_TAX_BPS, threshold - 1,
            abi.encodeWithSelector(
                CurbLaunchFactory.DevBuyAboveShare.selector,
                DevBuyCap.tokensOut(fresh, threshold - 1), cap, factory.MAX_DEV_BUY_BPS()
            )
        );
        assertEq(IERC20(NVDAC).balanceOf(creator), senderBefore, "a refused dev buy cost the creator something");
    }

    /// A STRANGER'S BALANCE ON THE FACTORY IS NOT THE CALLER'S.
    ///
    /// THE CRITERION: quote sent to the factory by somebody else stays there
    /// across a dev buy, and the caller gets back only what their own buy
    /// refunded.
    ///
    /// THIS IS AUDIT A-4, CHECKED BEFORE IT COULD BE WRITTEN. The Graduator
    /// had exactly this bug: it forwarded "its balance", so anybody's transfer
    /// became the next launch's to give away. The factory sweeps a measured
    /// delta instead, and this is what says so.
    function test_devBuy_doesNotSweepSomebodyElsesBalance() public onlyFork {
        uint256 gift = 7e8;
        vm.prank(NVDAC_WHALE);
        IERC20(NVDAC).transfer(address(factory), gift);
        assertEq(IERC20(NVDAC).balanceOf(address(factory)), gift, "the fixture did not land the gift");

        vm.prank(NVDAC_WHALE);
        IERC20(NVDAC).transfer(creator, TRADER_FUNDING);

        CurbLaunchFactory.LaunchConfig memory cfg = _config(true);
        cfg.devBuy = 2e8;
        cfg.salt = _saltForSide(cfg, true);

        uint256 senderBefore = IERC20(NVDAC).balanceOf(creator);
        vm.startPrank(creator);
        IERC20(NVDAC).approve(address(factory), 2e8);
        factory.launch(cfg);
        vm.stopPrank();

        // THE GIFT IS UNTOUCHED, and the caller paid exactly their own buy.
        assertEq(IERC20(NVDAC).balanceOf(address(factory)), gift, "the stranger's balance was swept away");
        assertEq(senderBefore - IERC20(NVDAC).balanceOf(creator), 2e8, "the caller was charged something other than their dev buy");
    }

    /// THE CAP IS A FIFTH OF THE SUPPLY, IN TOKENS: the largest dev buy whose
    /// tokens stay within it goes through, and one unit of NVDAc more is
    /// refused.
    ///
    /// Both sides of one line, in one test, because a cap tested only from
    /// above is a cap that could be off by one in the direction nobody looks.
    /// The line is found by replaying the curve's own buy arithmetic on an
    /// untouched curve (DevBuyCap), and the test asserts that what the launch
    /// actually delivered is what the replay said - so a replay that drifted
    /// would fail here rather than move the line with it.
    function test_devBuy_theCapIsAFifthOfTheSupply() public onlyFork {
        assertEq(factory.MAX_DEV_BUY_BPS(), 2000, "the cap is not a fifth of the supply");
        uint256 cap = (SUPPLY * 2000) / 10_000;
        uint256 threshold = factory.graduationThreshold();

        vm.prank(NVDAC_WHALE);
        IERC20(NVDAC).transfer(creator, TRADER_FUNDING * 2);

        PonsV2BondingCurve fresh = _freshCurveAt(TOTAL_TAX_BPS);
        uint256 atCap = DevBuyCap.largest(fresh, cap, threshold);
        uint256 over = DevBuyCap.tokensOut(fresh, atCap + 1);
        assertGt(over, cap, "one unit more does not cross the cap, so this is not the line");

        // ---- one unit over is refused, with what it would have received.
        _refuseDevBuy(
            TOTAL_TAX_BPS, atCap + 1,
            abi.encodeWithSelector(CurbLaunchFactory.DevBuyAboveShare.selector, over, cap, uint16(2000))
        );

        // ---- and the largest legal one goes through, at about 20%.
        uint256 before = IERC20(NVDAC).balanceOf(creator);
        (CurbLaunchToken token, PonsV2BondingCurve curve) = _launchWithDevBuy(TOTAL_TAX_BPS, atCap);
        uint256 bought = token.balanceOf(creator);
        assertEq(before - IERC20(NVDAC).balanceOf(creator), atCap, "the largest legal dev buy was not spent in full");
        assertEq(bought, DevBuyCap.tokensOut(fresh, atCap), "the launch delivered something the replay did not say");
        // EXACTLY THE CAP, not just under it: the phantom divides by four, so
        // a net of V / 4 buys N / 5 to the token, and at 3% the gross that nets
        // it exists. So the line is tested AT equality - a cap written as
        // `got >= cap` would refuse this launch.
        assertEq(bought, cap, "on these terms the largest legal dev buy should land exactly on the cap");
        assertFalse(curve.graduated(), "the largest legal dev buy graduated the launch");
    }

    /// THE LARGEST LEGAL DEV BUY STILL GETS NOTHING BACK.
    ///
    /// THE CRITERION: at the largest buy the token cap admits, the caller is
    /// charged the whole amount and the factory refunds nothing.
    ///
    /// WHY THIS TEST EXISTS. The refund branch in _devBuy was written for a
    /// curve that clamps its fill, and a mutation removing it entirely left
    /// every devBuy test green - so it was never exercised. It cannot be: the
    /// curve clamps only when the buy would exhaust the sellable allocation,
    /// which happens exactly when the quote reaches the graduation threshold,
    /// and a fifth of the supply is far inside the 73% the curve sells. The
    /// branch is defensive, not live.
    ///
    /// AUDIT D-1 IS THE SAME SHAPE - a guard made unreachable by a tighter
    /// bound added elsewhere - and the lesson there was that a check nobody
    /// can reach should be labelled rather than quietly kept. This is the
    /// label, as a measurement instead of a comment.
    function test_devBuy_theLargestLegalOneRefundsNothing() public onlyFork {
        vm.prank(NVDAC_WHALE);
        IERC20(NVDAC).transfer(creator, TRADER_FUNDING * 2);

        PonsV2BondingCurve fresh = _freshCurveAt(TOTAL_TAX_BPS);
        uint256 spend = DevBuyCap.largest(
            fresh, (SUPPLY * factory.MAX_DEV_BUY_BPS()) / 10_000, factory.graduationThreshold()
        );

        uint256 before = IERC20(NVDAC).balanceOf(creator);
        (, PonsV2BondingCurve curve) = _launchWithDevBuy(TOTAL_TAX_BPS, spend);

        // CHARGED IN FULL: nothing came back, so the refund branch did not run.
        assertEq(before - IERC20(NVDAC).balanceOf(creator), spend, "something was refunded");
        assertEq(IERC20(NVDAC).balanceOf(address(curve)), spend, "the curve did not keep the whole buy");
        assertEq(IERC20(NVDAC).balanceOf(address(factory)), 0, "the factory kept quote");
        assertFalse(curve.graduated(), "the largest legal dev buy graduated the launch");
        assertFalse(curve.readyToGraduate(), "the largest legal dev buy left the curve ready to graduate");
    }

    /// WHAT THE CAP COSTS IN NVDAc AND WHAT IT LEAVES UNSOLD, MEASURED, at both
    /// ends of the tax band.
    ///
    /// THE ARITHMETIC IT CHECKS, on the shipped NVDAc terms (the fixture's):
    /// the whole supply N sits on the curve against a virtual quote reserve V
    /// (the phantom), and a net quote of q buys N * q / (V + q), so a fifth of
    /// N takes q = V / 4 = 4.625 NVDAc net - grossed up by the tax, which comes
    /// off the input first: 4.672 at 1% and 4.868 at 5%. (The old ceiling,
    /// three quarters of the threshold, would be 37.5 NVDAc and bought 67% of
    /// the supply.) The curve sells N * T / (V + T) = 72.99% of N before the
    /// threshold T, so a full cap leaves 52.99% of N, 72.6% of what it sells.
    ///
    /// THE BANDS ARE LITERALS, not the formula over MAX_DEV_BUY_BPS: a moved
    /// cap has to fail here, and a band computed from it would move with it.
    function test_devBuy_theCapCostsAQuarterOfThePhantomAndLeavesMostOfTheCurve() public onlyFork {
        uint256 threshold = factory.graduationThreshold();
        assertEq(factory.phantomQuote(), 18.5e8, "the premise moved: the phantom is not the shipped 18.5 NVDAc");
        assertEq(threshold, 50e8, "the premise moved: the threshold is not the shipped 50.0 NVDAc");
        uint256 sellable =
            SUPPLY - FullMath.mulDiv(SUPPLY, factory.phantomQuote(), factory.phantomQuote() + threshold);
        uint256 cap = (SUPPLY * factory.MAX_DEV_BUY_BPS()) / 10_000;

        vm.prank(NVDAC_WHALE);
        IERC20(NVDAC).transfer(creator, TRADER_FUNDING * 2);

        uint16[2] memory taxes = [factory.minTotalTaxBps(), factory.maxTotalTaxBps()];
        assertEq(taxes[0], 100, "the premise moved: the lowest tax is not 1%");
        assertEq(taxes[1], 500, "the premise moved: the highest tax is not 5%");
        uint256[2] memory costLo = [uint256(4.66e8), uint256(4.86e8)];
        uint256[2] memory costHi = [uint256(4.68e8), uint256(4.88e8)];
        for (uint256 i = 0; i < 2; i++) {
            PonsV2BondingCurve fresh = _freshCurveAt(taxes[i]);
            uint256 spend = DevBuyCap.largest(fresh, cap, threshold);
            emit log_named_uint("tax bps", taxes[i]);
            emit log_named_uint("largest dev buy, NVDAc units", spend);
            assertGe(spend, costLo[i], "the cap costs less NVDAc than the arithmetic says");
            assertLe(spend, costHi[i], "the cap costs more NVDAc than the arithmetic says");

            (CurbLaunchToken token, PonsV2BondingCurve curve) = _launchWithDevBuy(taxes[i], spend);
            uint256 bought = token.balanceOf(creator);
            // TWO WAYS OF COUNTING, which must agree: what the creator holds,
            // and what the curve says it can still sell.
            assertEq(sellable - bought, curve.sellableTokens(), "the creator's tokens and the curve disagree");
            uint256 leftBps = (curve.sellableTokens() * 10_000) / sellable;
            emit log_named_uint("sellable left unsold, bps", leftBps);
            assertGe(leftBps, 7255, "a capped dev buy left less of the allocation than the arithmetic says");
            assertLe(leftBps, 7270, "a capped dev buy left more of the allocation than the arithmetic says");
        }
    }

    // ================================================================
    // The launch fee
    //
    // Charged in native ETH, on top of gas, and forwarded to the hook's
    // CURRENT platform recipient in the same call. Every other fixture in
    // this file charges nothing, so these are the only tests that see a fee.
    // ================================================================

    /// A SECOND FACTORY ON THE FIXTURE REGISTRY, differing only in the price
    /// of a launch.
    ///
    /// ON THE SHARED REGISTRY AND GRADUATOR, not fresh ones. The hook is bound
    /// to the graduator that opens its pools and refuses any other with
    /// HookHasWrongOpener, so a factory built on a new graduator cannot even be
    /// admitted - a different failure from the one under test, and the first
    /// version of this helper hit exactly that.
    ///
    /// ADMITTED WITH addLauncher(), NOT wire(). A registry takes its launcher
    /// and its hook once and refuses a second wire() with LauncherAlreadySet;
    /// addLauncher() is the door a second factory goes through, against the
    /// hook already chosen. The second version of this helper hit that one.
    ///
    /// Being admitted is required rather than incidental: the fee is paid to
    /// the address behind registry.requiredHook(), and a factory the registry
    /// does not know cannot register its launch at all.
    function _factoryCharging(uint256 fee) internal returns (CurbLaunchFactory fac) {
        CurbLaunchFactory.Terms memory t = _terms(IHooks(address(hook)), FEE, TICK_SPACING);
        t.launchFee = fee;

        fac = new CurbLaunchFactory(registry, graduator, NVDAC, feePolicy, feeEscrow, buybackVault, t);
        registry.addLauncher(address(fac));
    }

    /// PAID, FORWARDED, AND NOT KEPT.
    ///
    /// Three claims in one test because they are one property: the fee leaves
    /// the creator, arrives at the platform, and the factory is not a place
    /// money sits. A factory holding ETH would be a balance with no withdrawal
    /// function attached to it.
    function test_launchFee_reachesThePlatformAndTheFactoryKeepsNothing() public onlyFork {
        uint256 fee = 0.0005 ether;
        CurbLaunchFactory fac = _factoryCharging(fee);
        address platformTo = hook.platformRecipient();

        CurbLaunchFactory.LaunchConfig memory cfg = _config(true);
        cfg.salt = _saltForSideOf(fac, cfg, true);

        vm.deal(creator, 1 ether);
        uint256 creatorBefore = creator.balance;
        uint256 platformBefore = platformTo.balance;

        vm.prank(creator);
        (CurbLaunchToken token, PonsV2BondingCurve curve) = fac.launch{value: fee}(cfg);

        assertEq(platformTo.balance - platformBefore, fee, "the platform did not receive the launch fee");
        // Gas is not charged against a pranked balance, so the whole
        // difference here is the fee itself.
        assertEq(creatorBefore - creator.balance, fee, "the creator paid something other than the fee");
        assertEq(address(fac).balance, 0, "the factory kept ETH");
        assertEq(address(curve).balance, 0, "the curve was handed ETH");
        assertEq(address(token).balance, 0, "the token was handed ETH");
        // AND THE LAUNCH IS A REAL ONE, not a payment that produced nothing.
        assertEq(address(curve.token()), address(token), "the paid launch did not wire up");
    }

    /// TOO LITTLE IS REFUSED, WITH BOTH NUMBERS.
    ///
    /// The error carries what was sent AND what was required, because a caller
    /// who is one wei short and a caller who sent nothing otherwise read the
    /// same message.
    function test_launchFee_payingTooLittleIsRefusedWithBothNumbers() public onlyFork {
        uint256 fee = 0.0005 ether;
        CurbLaunchFactory fac = _factoryCharging(fee);

        CurbLaunchFactory.LaunchConfig memory cfg = _config(true);
        cfg.salt = _saltForSideOf(fac, cfg, true);

        vm.deal(creator, 1 ether);
        vm.expectRevert(
            abi.encodeWithSelector(CurbLaunchFactory.LaunchFeeMismatch.selector, fee - 1, fee)
        );
        vm.prank(creator);
        fac.launch{value: fee - 1}(cfg);

        // AND NOTHING WAS TAKEN on the way to refusing.
        assertEq(address(fac).balance, 0, "a refused launch left ETH in the factory");
    }

    /// TOO MUCH IS REFUSED TOO - "exact", not "at least".
    ///
    /// Accepting an overpayment would leave change in a contract that holds
    /// nothing else and has no way to give it back. Refusing costs the caller
    /// one reverted transaction instead of the whole overpayment.
    function test_launchFee_payingTooMuchIsRefusedRatherThanKept() public onlyFork {
        uint256 fee = 0.0005 ether;
        CurbLaunchFactory fac = _factoryCharging(fee);
        address platformTo = hook.platformRecipient();

        CurbLaunchFactory.LaunchConfig memory cfg = _config(true);
        cfg.salt = _saltForSideOf(fac, cfg, true);

        vm.deal(creator, 1 ether);
        uint256 platformBefore = platformTo.balance;

        vm.expectRevert(
            abi.encodeWithSelector(CurbLaunchFactory.LaunchFeeMismatch.selector, fee + 1, fee)
        );
        vm.prank(creator);
        fac.launch{value: fee + 1}(cfg);

        assertEq(address(fac).balance, 0, "an overpayment stayed in the factory");
        assertEq(platformTo.balance, platformBefore, "an overpayment was forwarded anyway");
    }

    /// A FACTORY THAT CHARGES NOTHING REFUSES ETH RATHER THAN SWALLOWING IT.
    ///
    /// Zero is a legal fee and is what every other fixture in this file uses.
    /// The risk at zero is not undercharging: it is a payable function quietly
    /// accepting value nobody asked for, with no way to return it.
    function test_launchFee_aFreeFactoryRefusesEthRatherThanKeepingIt() public onlyFork {
        CurbLaunchFactory.LaunchConfig memory cfg = _config(true);
        cfg.salt = _saltForSide(cfg, true);

        vm.deal(creator, 1 ether);
        vm.expectRevert(
            abi.encodeWithSelector(CurbLaunchFactory.LaunchFeeMismatch.selector, uint256(1), uint256(0))
        );
        vm.prank(creator);
        factory.launch{value: 1}(cfg);

        assertEq(address(factory).balance, 0, "the free factory kept the ETH it was sent");
    }
    /// A RECIPIENT THAT WILL NOT TAKE THE FEE NO LONGER STOPS THE LAUNCH.
    ///
    /// THIS TEST ASSERTED THE OPPOSITE WHEN IT WAS WRITTEN. Refusing the launch
    /// was reasoned about as "rather than leaving the fee stranded in this
    /// contract" - a point about the money, which never weighed what it cost
    /// everybody else. The fee is the platform's own and the recipient is the
    /// platform's own address, so a recipient that cannot take ether is the
    /// platform's problem; making it stop every creator from launching is a far
    /// larger failure. AUDIT M-06.
    ///
    /// The recipient's code is replaced with a body that reverts immediately -
    /// PUSH1 0, PUSH1 0, REVERT - which is what a plain value transfer to any
    /// contract without a payable fallback already does.
    function test_launchFee_aRefusedFeeIsHeldRatherThanStoppingTheLaunch() public onlyFork {
        uint256 fee = 0.0005 ether;
        CurbLaunchFactory fac = _factoryCharging(fee);
        address platformTo = hook.platformRecipient();
        assertTrue(platformTo != address(this), "the recipient is the test contract");
        assertTrue(platformTo != address(fac), "the recipient is the factory");
        vm.etch(platformTo, hex"60006000fd");

        CurbLaunchFactory.LaunchConfig memory cfg = _config(true);
        cfg.salt = _saltForSideOf(fac, cfg, true);

        vm.deal(creator, 1 ether);
        vm.prank(creator);
        (CurbLaunchToken token, PonsV2BondingCurve curve) = fac.launch{value: fee}(cfg);

        // ---- THE LAUNCH IS REAL.
        assertEq(address(curve.token()), address(token), "the launch did not wire up");

        // ---- AND THE FEE IS HELD FOR THEM, not lost and not forced on them.
        assertEq(fac.unclaimedLaunchFees(platformTo), fee, "the refused fee was not recorded");
        assertEq(address(fac).balance, fee, "the factory does not hold what it says it holds");

        // ---- AND IT COMES OUT ONCE THEY CAN TAKE IT.
        vm.etch(platformTo, hex"");
        uint256 before = platformTo.balance;
        vm.prank(platformTo);
        assertEq(fac.withdrawLaunchFees(), fee, "the withdrawal paid the wrong amount");
        assertEq(platformTo.balance - before, fee, "the withdrawal did not arrive");
        assertEq(fac.unclaimedLaunchFees(platformTo), 0, "the credit survived the withdrawal");
        assertEq(address(fac).balance, 0, "the factory kept ether after the withdrawal");
    }

    /// A RECIPIENT THAT BURNS THE GAS IT IS SENT IS HELD LIKE A REFUSAL.
    ///
    /// Sent with all the gas there is, such a recipient left the launch 1/64 of
    /// its gas, so every launch on the factory needed about 64 times its cost
    /// and none fitted a 2^24 per-transaction cap. The fee call is gas-capped,
    /// so the launch fits and the fee is held for withdrawLaunchFeesTo.
    function test_launchFee_aGasBurningRecipientIsHeldAndTheLaunchStillFits() public onlyFork {
        uint256 fee = 0.0005 ether;
        CurbLaunchFactory fac = _factoryCharging(fee);
        address platformTo = hook.platformRecipient();
        vm.etch(platformTo, address(new GasBurningRecipient()).code);

        CurbLaunchFactory.LaunchConfig memory cfg = _config(true);
        cfg.salt = _saltForSideOf(fac, cfg, true);

        vm.deal(creator, 1 ether);
        vm.prank(creator);
        (CurbLaunchToken token, PonsV2BondingCurve curve) = fac.launch{value: fee, gas: 16_777_216}(cfg);

        assertEq(address(curve.token()), address(token), "the launch did not wire up");
        assertEq(fac.unclaimedLaunchFees(platformTo), fee, "the burned call's fee was not held");
        assertEq(address(fac).balance, fee, "the factory does not hold what it says it holds");
    }

    /// AND A RECIPIENT THAT STILL REFUSES ETHER CAN SEND ITS HELD FEES
    /// SOMEWHERE THAT TAKES THEM.
    ///
    /// The test above lets the recipient start accepting ether before it
    /// withdraws, which is the one case that never needed help. The fees held
    /// here are exactly the ones the recipient refused, and withdrawLaunchFees
    /// pays that same address the same way - so for a contract with no payable
    /// receive the pull failed like the push and the balance was stuck for
    /// good. withdrawLaunchFeesTo takes a destination; the balance stays keyed
    /// by the caller.
    function test_launchFee_aRecipientThatStillRefusesEtherWithdrawsToAnotherAddress() public onlyFork {
        uint256 fee = 0.0005 ether;
        CurbLaunchFactory fac = _factoryCharging(fee);
        address platformTo = hook.platformRecipient();
        vm.etch(platformTo, hex"60006000fd");

        CurbLaunchFactory.LaunchConfig memory cfg = _config(true);
        cfg.salt = _saltForSideOf(fac, cfg, true);
        vm.deal(creator, 1 ether);
        vm.prank(creator);
        fac.launch{value: fee}(cfg);
        assertEq(fac.unclaimedLaunchFees(platformTo), fee, "the refused fee was not recorded");

        // ---- THE PROBLEM, SHOWN FIRST: the plain pull pays the address that
        // refused, and it refuses again.
        vm.prank(platformTo);
        vm.expectRevert(abi.encodeWithSelector(CurbLaunchFactory.LaunchFeeNotTaken.selector, platformTo, fee));
        fac.withdrawLaunchFees();

        // ---- A STRANGER NAMING A DESTINATION MOVES NOTHING: the balance is
        // keyed by the caller, not by the destination.
        address stranger = makeAddr("a stranger to the held fee");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(CurbLaunchFactory.NoUnclaimedFees.selector, stranger));
        fac.withdrawLaunchFeesTo(stranger);

        // ---- NOWHERE IS REFUSED, rather than burning the fee at address zero.
        vm.prank(platformTo);
        vm.expectRevert(CurbLaunchFactory.ZeroDestination.selector);
        fac.withdrawLaunchFeesTo(address(0));

        // ---- A DESTINATION THAT ALSO REFUSES leaves the balance where it was.
        address alsoRefuses = makeAddr("a destination that also refuses ether");
        vm.etch(alsoRefuses, hex"60006000fd");
        vm.prank(platformTo);
        vm.expectRevert(abi.encodeWithSelector(CurbLaunchFactory.LaunchFeeNotTaken.selector, alsoRefuses, fee));
        fac.withdrawLaunchFeesTo(alsoRefuses);
        assertEq(fac.unclaimedLaunchFees(platformTo), fee, "a failed withdrawal lost the credit");

        // ---- AND ONE THAT TAKES ETHER GETS IT, while the recipient still refuses.
        address treasury = makeAddr("the platform's treasury");
        uint256 treasuryBefore = treasury.balance;
        uint256 recipientBefore = platformTo.balance;
        vm.expectEmit(true, true, false, true, address(fac));
        emit CurbLaunchFactory.LaunchFeeWithdrawn(platformTo, treasury, fee);
        vm.prank(platformTo);
        assertEq(fac.withdrawLaunchFeesTo(treasury), fee, "the withdrawal paid the wrong amount");
        assertEq(treasury.balance - treasuryBefore, fee, "the fee did not arrive at the named address");
        assertEq(platformTo.balance, recipientBefore, "the recipient's own balance moved");
        assertEq(fac.unclaimedLaunchFees(platformTo), 0, "the credit survived the withdrawal");
        assertEq(address(fac).balance, 0, "the factory kept ether after the withdrawal");
    }

    /// THE FEE IS THE DEPLOYMENT'S, NOT THE CALLER'S.
    ///
    /// launchFee() is immutable and public, so the page can read what a launch
    /// will cost before asking anyone to sign. A factory whose price could be
    /// argued at call time would be a factory whose quoted price means nothing.
    function test_launchFee_isReadableAndFixedPerDeployment() public onlyFork {
        assertEq(factory.launchFee(), 0, "the fixture factory charges something");
        assertEq(_factoryCharging(0.0005 ether).launchFee(), 0.0005 ether, "the fee did not survive the constructor");
        assertEq(_factoryCharging(3 ether).launchFee(), 3 ether, "a large fee did not survive the constructor");
    }

    /// Launched BY a named address rather than by the fixture's one creator,
    /// because everything above turns on two launches having different owners.
    function _graduatedBy(address who, uint16 tax)
        internal
        returns (PoolKey memory key, CurbLaunchToken token, PonsV2BondingCurve curve)
    {
        CurbLaunchFactory.LaunchConfig memory cfg = _config(true);
        cfg.totalTaxBps = tax;
        cfg.salt = _saltForSide(cfg, true);

        vm.prank(who);
        (token, curve) = factory.launch(cfg);
        _fillToThreshold(curve);
        require(curve.graduated(), "the launch did not graduate");
        key = _keyFor(token, IHooks(address(hook)));
    }

    /// Filled to the boundary but NOT graduated, with the price its curve
    /// should open at computed while the reserves still exist to compute it
    /// from - graduation zeroes them.
    ///
    /// `paid` is the GROSS the curve took in, fee buckets included, which is
    /// what the buyers actually handed over. getReserves() nets the buckets
    /// out, so it is the same at the boundary whatever the tax - and that
    /// difference is the whole point of X-4.
    function _fillAndPrice(address who, uint16 tax)
        internal
        returns (CurbLaunchToken token, uint160 want, uint256 paid)
    {
        CurbLaunchFactory.LaunchConfig memory cfg = _config(true);
        cfg.totalTaxBps = tax;
        cfg.salt = _saltForSide(cfg, true);

        vm.prank(who);
        PonsV2BondingCurve curve;
        (token, curve) = factory.launch(cfg);
        _fillWithoutGraduating(curve);

        (uint256 q, uint256 t) = curve.getReserves();
        want = _ourPrice(token, q, t);
        paid = curve.trackedQuote();
    }

    /// THE BUYBACK VAULT IS INERT, AND THIS IS WHAT KEEPS IT THAT WAY.
    ///
    /// AUDIT A-9 and E1 both lean on it: three of these are DEPLOYED, one per
    /// asset, each with a permanent owner, and nothing can ever call them. That
    /// is an argument spread over two files today. Here it is a test, so the
    /// day somebody wires one it goes red and they have to mean it.
    ///
    /// WHAT MAKES IT INERT, read out of the vault rather than assumed: every
    /// value-touching entry point is gated on `factory != address(0)`, and
    /// setFactory - its ONLY owner-only function - is called nowhere in this
    /// repository. There is no receive and no fallback, so it cannot even be
    /// sent ETH, and lock() is the only path a token could arrive by.
    ///
    /// AND THE ONE SHORT-CIRCUIT THAT LOOKS LIKE A WAY IN IS NOT ONE.
    /// _isAuthorizedLocker returns TRUE for the feePolicy address before it
    /// ever checks the factory - but lock() checks the factory FIRST, so that
    /// branch is unreachable while factory is zero. Worth a line because
    /// reading the authoriser alone would suggest otherwise.
    function test_theBuybackVaultCannotBeReachedAtAll() public onlyFork {
        assertGt(address(buybackVault).code.length, 0, "the fixture has no vault to test");
        assertEq(buybackVault.factory(), address(0), "the vault was wired, so this measures nothing");

        // LOCKING IS SHUT, for the curve, for the fee policy, for anybody.
        address[3] memory callers =
            [address(this), address(feePolicy), address(makeAddr("some curve"))];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(PonsV2BuybackVault.NotFactory.selector);
            buybackVault.lock(NVDAC, 1, creator, protocolRecipient, 0);
        }

        // AND SO IS EVERY WAY VALUE COULD LEAVE.
        vm.prank(creator);
        vm.expectRevert(PonsV2BuybackVault.NotFactory.selector);
        buybackVault.release(NVDAC);

        vm.prank(creator);
        vm.expectRevert(PonsV2BuybackVault.NotFactory.selector);
        buybackVault.updateCreatorRecipient(NVDAC, creator);

        // IT HOLDS NOTHING AND ITS BOOKS ARE EMPTY.
        assertEq(IERC20(NVDAC).balanceOf(address(buybackVault)), 0, "the vault holds quote");
        assertEq(buybackVault.totalLocked(NVDAC), 0, "the vault has locked something");
        assertEq(buybackVault.totalReleased(NVDAC), 0, "the vault has released something");

        // AND IT CANNOT BE SENT ETH - no receive, no fallback.
        (bool sent,) = address(buybackVault).call{value: 1 wei}("");
        assertFalse(sent, "the vault accepted ETH, so it has a receive or fallback after all");
    }

    /// ONE BLOCKLIST ENTRY ON THE ESCROW BLOCKS GRADUATION - UNTIL
    /// rescueCurveFees IS CALLED, WHICH ANYONE MAY DO ONCE THE LAUNCH HAS SAT
    /// STUCK FOR AN HOUR.
    ///
    /// FOUND BY READING PonsV2BondingCurve LINE BY LINE. The curve carries a
    /// rescueFees() whose own comment names this exact failure - a permissioned
    /// quote asset that stops delivering to ONE address while trading carries
    /// on, leaving fees unreachable and "the launch stuck on its curve
    /// forever". It is onlyFactory and our Graduator holds that role. When this
    /// test was written the Graduator exposed no path to it and the launch was
    /// stranded for good; Graduator.rescueCurveFees is that path now, and the
    /// last steps below prove it opens the launch. (The name and this header
    /// used to say "no way out" after the hatch existed.)
    ///
    /// WHY THE FEES BLOCK GRADUATION AT ALL: graduate() sweeps before it hands
    /// over the reserves, the sweep credits the escrow, and fees accrue from
    /// the first trade - so by the time the threshold is crossed the sweep is
    /// never a no-op.
    ///
    /// PROVOKED, NOT SIMULATED. The issuer's own policy admin adds the entry
    /// through the real PolicyRegistry precompile.
    function test_blocklistingTheEscrowBlocksGraduationUntilRescueCurveFees() public onlyFork {
        CurbLaunchFactory.LaunchConfig memory launchCfg = _config(true);
        vm.prank(creator);
        (CurbLaunchToken token, PonsV2BondingCurve curve) = factory.launch(launchCfg);

        // ---- S1. A BASELINE FIRST. Without one, a later refusal could be
        // anything at all.
        //
        // AND THE SCOPE THAT ACTUALLY FIRES IS THE EXECUTOR'S, MEASURED RATHER
        // THAN GUESSED. The first version of this test named the RECEIVER
        // scope, which is the obvious reading - the escrow is being paid - and
        // the chain answered with the executor's instead. FeeEscrow.creditToken
        // PULLS: it calls transferFrom itself, so it is the executor of its own
        // payment and is refused there, before the receiver check is reached.
        // Blocking it would stop the transfer either way; which scope reports
        // it is the part that had to be read off the chain.
        bytes32 scope = _scopeNamed(NVDAC, "TRANSFER_EXECUTOR_POLICY()");
        uint64 policy = _policyFor(NVDAC, scope);
        vm.prank(NVDAC_WHALE);
        IERC20(NVDAC).transfer(address(escrowMock), 1e8);
        assertEq(IERC20(NVDAC).balanceOf(address(escrowMock)), 1e8, "S1: the escrow could not be paid to begin with");

        // ---- S2. The issuer blocks the ESCROW. Not the curve, not a trader,
        // not the token - one address, and it is ours.
        address[] memory who = new address[](1);
        who[0] = address(escrowMock);
        vm.prank(_adminOf(policy));
        (bool set,) = POLICY_REG.call(
            abi.encodeWithSignature("updateBlocklist(uint64,bool,address[])", policy, true, who)
        );
        assertTrue(set, "S2: the registry refused the blocklist update; nothing below was provoked");

        // ---- S3. TRADING STILL WORKS, which is the whole shape of this
        // failure - nothing looks wrong until the launch tries to finish.
        _fillToThreshold(curve);
        assertFalse(curve.graduated(), "S3: it graduated, so the escrow was not actually in the way");
        assertTrue(curve.readyToGraduate(), "S3: the curve is not even ready, so this measures nothing");

        // ---- S4. AND NOW NOTHING WORKS. Every door at once.
        vm.expectRevert(abi.encodeWithSelector(PolicyForbids.selector, scope, policy));
        graduator.graduate(address(token));

        vm.prank(trader);
        vm.expectRevert(PonsV2BondingCurve.CurveGraduated.selector);
        curve.buy(1e8, 0, trader);

        vm.prank(trader);
        vm.expectRevert(PonsV2BondingCurve.CurveGraduated.selector);
        curve.sell(1e18, 0, trader);

        // ---- S5. THE EXIT PONS BUILT IS BEHIND A ROLE. Called directly on the
        // curve it refuses, because the caller is not the factory (the
        // Graduator). The route is the Graduator's rescueCurveFees - S6.
        vm.expectRevert(PonsV2BondingCurve.NotFactory.selector);
        curve.rescueFees();

        emit log_string("  the launch is full and ready, and every ordinary door is shut");

        // ---- S6. AND THE HATCH OPENS IT. rescueCurveFees pays the fees
        // straight to the recipients instead of through the escrow, which is
        // the one address the issuer blocked. A stranger drives it - nobody
        // has to wait for an operator - once the launch has sat stuck for
        // the hatch's hour: noted ready (by anyone), and an hour later.
        address passerBy = makeAddr("any passer-by");
        vm.prank(passerBy);
        vm.expectRevert(abi.encodeWithSelector(Graduator.RescueNotOpenYet.selector, passerBy, 0));
        graduator.rescueCurveFees(address(token));
        vm.prank(passerBy);
        uint256 since = graduator.noteReady(address(token));
        vm.warp(since + graduator.RESCUE_DELAY());
        uint256 protoBefore = IERC20(NVDAC).balanceOf(protocolRecipient);
        vm.prank(passerBy);
        (uint256 paidProtocol,) = graduator.rescueCurveFees(address(token));
        assertGt(paidProtocol, 0, "S6: the rescue moved nothing, so it proves nothing");
        assertEq(
            IERC20(NVDAC).balanceOf(protocolRecipient) - protoBefore, paidProtocol,
            "S6: the protocol was not actually paid"
        );

        // ---- S7. AND NOW IT GRADUATES. The sweep inside graduate() finds
        // nothing pending and returns early, so the escrow is never touched.
        graduator.graduate(address(token));
        assertTrue(curve.graduated(), "S7: the launch still did not graduate after the rescue");
        assertTrue(registry.isRegistered(address(token)), "S7: the record went missing");

        emit log_string("  and the hatch got it out: fees paid direct, launch graduated, escrow untouched");
    }

    function _scopeNamed(address asset, string memory name) internal view returns (bytes32) {
        (bool ok, bytes memory ret) = asset.staticcall(abi.encodeWithSignature(name));
        require(ok, string.concat(name, " did not answer"));
        return abi.decode(ret, (bytes32));
    }

    function _policyFor(address asset, bytes32 scope) internal view returns (uint64) {
        (bool ok, bytes memory ret) = asset.staticcall(abi.encodeWithSignature("policyId(bytes32)", scope));
        require(ok, "policyId() did not answer");
        return abi.decode(ret, (uint64));
    }

    function _adminOf(uint64 policy) internal view returns (address) {
        (bool ok, bytes memory ret) =
            POLICY_REG.staticcall(abi.encodeWithSignature("policyAdmin(uint64)", policy));
        require(ok, "policyAdmin() did not answer");
        return abi.decode(ret, (address));
    }

    /// A STRANGER'S TRANSFER IS NOT PART OF THIS LAUNCH'S GRADUATION.
    ///
    /// AUDIT.txt A-4. _refund and _burnRemainder used to act on this contract's
    /// WHOLE balance. The graduator holds nothing between transactions, so that
    /// reads as equivalent - until somebody sends it something. Then the next
    /// graduation forwards their quote to ITS refund address, a third party
    /// neither of them chose, and burns their launch tokens into ITS supply
    /// change and ITS RemainderBurned event.
    ///
    /// THE POOL WAS NEVER AT RISK and is not what this checks: held0/held1 come
    /// from a measured delta across curve.graduate(), which already excluded
    /// anything sitting here first. This is about what happens to the rest.
    function test_aDonationToTheGraduatorIsNotSweptIntoALaunch() public onlyFork {
        address sink = makeAddr("a4 refund sink");
        CurbLaunchFactory.LaunchConfig memory cfg = _config(true);
        cfg.quoteRefundTo = sink;
        cfg.salt = _saltForSide(cfg, true);

        vm.prank(creator);
        (CurbLaunchToken token, PonsV2BondingCurve curve) = factory.launch(cfg);

        // A STRANGER PUTS QUOTE IN THE GRADUATOR, before the graduation and
        // with nothing to do with it. 5 NVDAc, from the whale.
        uint256 donation = 5 * 1e8;
        vm.prank(NVDAC_WHALE);
        IERC20(NVDAC).transfer(address(graduator), donation);
        assertEq(
            IERC20(NVDAC).balanceOf(address(graduator)), donation,
            "the fixture did not land the donation"
        );

        uint256 sinkBefore = IERC20(NVDAC).balanceOf(sink);
        uint256 supplyBefore = token.totalSupply();

        _fillToThreshold(curve);
        require(curve.graduated(), "the fixture did not graduate");

        // THE DONATION STAYED. It is not the sink's, and it is not this
        // launch's to move.
        assertEq(
            IERC20(NVDAC).balanceOf(sink) - sinkBefore, 0,
            "the donation was forwarded to this launch's refund address"
        );
        assertEq(
            IERC20(NVDAC).balanceOf(address(graduator)), donation,
            "the donation did not stay where it was sent"
        );

        // AND THE BURN IS THE LAUNCH'S OWN. Supply fell - so the remainder was
        // burned and this is not vacuous - and every unit of it came from the
        // curve, not from anywhere else. The graduator holds no launch token
        // afterwards because none was donated to it here; the quote side is
        // what carries the donation.
        assertLt(token.totalSupply(), supplyBefore, "nothing was burned, so this proves nothing");
        assertEq(token.balanceOf(address(graduator)), 0, "launch tokens were left in the graduator");
        assertEq(token.balanceOf(sink), 0, "launch tokens went to the refund address");
    }

    /// WHAT quoteRefundTo IS FOR, asserted rather than described. The field was
    /// documented as "where launch tokens the pool could not absorb are sent",
    /// which is the wrong remainder: the QUOTE is refunded there and the launch
    /// token is BURNED. Those are about a quarter of the supply apart.
    function test_theRefundAddressReceivesQUOTE_andTheTokenIsBurned() public onlyFork {
        address sink = makeAddr("refund sink");
        CurbLaunchFactory.LaunchConfig memory cfg = _config(true);
        cfg.quoteRefundTo = sink;
        cfg.salt = _saltForSide(cfg, true);

        uint256 sinkQuoteBefore = IERC20(NVDAC).balanceOf(sink);

        vm.prank(creator);
        (CurbLaunchToken token, PonsV2BondingCurve curve) = factory.launch(cfg);
        _fillToThreshold(curve);
        require(curve.graduated(), "the fixture did not graduate");

        // THE TOKEN SIDE: nothing arrives at the refund address, and the supply
        // is down by what RemainderBurned says.
        assertEq(token.balanceOf(sink), 0, "launch tokens were sent to the refund address");
        assertLt(token.totalSupply(), SUPPLY, "nothing was burned");

        // THE QUOTE SIDE, SAID HONESTLY. A first version of this asserted
        // `balanceOf(sink) == sinkQuoteBefore + refunded` where `refunded` was
        // itself that balance minus the same starting figure - an equation that
        // holds whatever the contract does, and proves nothing.
        //
        // What is actually true here: with phantom liquidity the QUOTE is the
        // binding side, so the refund measures ZERO in this configuration. That
        // is the measurement, and it is asserted as the zero it is rather than
        // dressed up as a transfer test.
        assertEq(IERC20(NVDAC).balanceOf(sink) - sinkQuoteBefore, 0, "a quote refund was not expected here");
        // A NON-ZERO QUOTE REFUND IS NOT EXERCISED BY THIS TEST. No real curve
        // reaches one; test_aNonZeroQuoteRefundReachesTheRefundAddress forces
        // one with a curve that hands over more quote than its price absorbs.

        // NOTHING LEFT BEHIND, which is the claim that does not depend on which
        // side binds.
        assertEq(IERC20(NVDAC).balanceOf(address(curve)), 0, "quote was left in the curve");
        assertEq(IERC20(NVDAC).balanceOf(address(graduator)), 0, "quote was left in the graduator");
        assertEq(token.balanceOf(address(graduator)), 0, "launch tokens were left in the graduator");
    }

    /// THE RECORD'S RETIRED LOCK-DURATION WORD MUST BE ZERO. The position is
    /// locked forever, so a record that carries a duration says something
    /// false about its launch; the registry refuses to write it.
    function test_aRecordWithALockDurationIsRefused() public onlyFork {
        address tok = makeAddr("a token with a lock duration");
        LaunchRegistry.Launch memory rec = LaunchRegistry.Launch({
            curve: makeAddr("its curve"),
            quoteToken: NVDAC,
            beneficiary: creator,
            refundTo: creator,
            reservedZero: 180 days,
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook)),
            platformBps: uint16(PLATFORM_FEE_BPS),
            platformRecipient: protocolRecipient,
            totalTaxBps: TOTAL_TAX_BPS,
            launchedAt: 0
        });
        vm.prank(address(factory));
        vm.expectRevert(abi.encodeWithSelector(LaunchRegistry.ReservedWordNotZero.selector, uint256(180 days)));
        registry.register(tok, rec);
    }

    /// A FACTORY ON ANOTHER ASSET'S ESCROW CANNOT BE DEPLOYED.
    ///
    /// FeeEscrow credits one token and refuses the rest, and the curve sweeps
    /// into it before graduate() hands anything over. So such a factory takes
    /// buys, can never sweep, and every full curve it makes is stuck until
    /// somebody calls rescueCurveFees by hand. PONS refuses that wiring at
    /// every launch; only DeployCurb's require stood between this product and
    /// it, and a factory deployed any other way met nothing at all.
    function test_aFactoryOnAnotherAssetsEscrowCannotBeDEPLOYED() public onlyFork {
        vm.expectRevert(
            abi.encodeWithSelector(
                CurbLaunchFactory.EscrowIsForAnotherAsset.selector, address(feeEscrow), NVDAC, AAPLC
            )
        );
        new CurbLaunchFactory(
            registry, graduator, AAPLC, feePolicy, feeEscrow, buybackVault,
            _terms(IHooks(address(hook)), FEE, TICK_SPACING)
        );

        // AND ONE THAT WILL NOT SAY WHICH ASSET IT CREDITS IS REFUSED, not
        // taken on trust. The registry has code and no quoteToken().
        FeePolicy onRegistry = new FeePolicy(protocolRecipient, IPonsV2FeeEscrow(address(registry)), 500);
        vm.expectRevert(abi.encodeWithSelector(CurbLaunchFactory.EscrowUnreadable.selector, address(registry)));
        new CurbLaunchFactory(
            registry, graduator, NVDAC, IPonsV2FeePolicy(address(onRegistry)),
            IPonsV2FeeEscrow(address(registry)), buybackVault,
            _terms(IHooks(address(hook)), FEE, TICK_SPACING)
        );
    }

    /// AND ONE WHOSE POLICY NAMES A DIFFERENT ESCROW FROM THE ONE ITS CURVES
    /// PAY. Both escrows are NVDAc's, so the asset check above passes and this
    /// is the only thing that can refuse it.
    function test_aFactoryWhosePolicyNamesAnotherEscrowCannotBeDEPLOYED() public onlyFork {
        FeeEscrow other = new FeeEscrow(NVDAC);
        vm.expectRevert(
            abi.encodeWithSelector(
                CurbLaunchFactory.PolicyNamesAnotherEscrow.selector, address(feeEscrow), address(other)
            )
        );
        new CurbLaunchFactory(
            registry, graduator, NVDAC, feePolicy, IPonsV2FeeEscrow(address(other)), buybackVault,
            _terms(IHooks(address(hook)), FEE, TICK_SPACING)
        );
    }

    /// A FACTORY WHOSE SEED CAN NEVER BE MINTED CANNOT BE DEPLOYED.
    ///
    /// graduate() hands the WHOLE held reserve to the mint as its maxima, and
    /// v4 core refuses a deposit above 2^127 on either side, and the factory
    /// draws its line one below that (the next test pins it). The held token
    /// amount is the curve's reservation,
    /// fixed by the terms - so a supply large enough puts every launch this
    /// factory will ever make into a full curve that cannot graduate.
    /// assertTermsAreSeedable did not check that bound; the audit built
    /// exactly these terms and watched them pass.
    function test_aFactoryWhoseSeedCannotBeEncodedCannotBeDEPLOYED() public onlyFork {
        CurbLaunchFactory.Terms memory t = _terms(IHooks(address(hook)), FEE, 200);
        t.supply = 1e39;
        t.phantomQuote = 0.15e8;
        t.graduationThreshold = 0.15e8;
        uint256 reserved = FullMath.mulDiv(t.supply, t.phantomQuote, t.phantomQuote + t.graduationThreshold);
        assertGt(reserved, type(uint128).max, "the premise moved: this reservation fits a uint128");

        vm.expectRevert(
            abi.encodeWithSelector(Graduator.SeedTooLargeToEncode.selector, reserved, t.graduationThreshold)
        );
        new CurbLaunchFactory(registry, graduator, NVDAC, feePolicy, feeEscrow, buybackVault, t);

        // AND THE QUOTE SIDE: the held quote is the threshold.
        t.supply = SUPPLY;
        t.phantomQuote = 2 ** 129;
        t.graduationThreshold = 2 ** 129;
        vm.expectRevert(
            abi.encodeWithSelector(Graduator.SeedTooLargeToEncode.selector, SUPPLY / 2, uint256(2 ** 129))
        );
        new CurbLaunchFactory(registry, graduator, NVDAC, feePolicy, feeEscrow, buybackVault, t);
    }

    /// THE SEED BOUND IS v4's int128, NOT THE MINT'S uint128 - BOTH SIDES OF
    /// THE LINE, ON BOTH SIDES OF THE POOL.
    ///
    /// Pool.modifyLiquidity narrows each side's (negative) delta with
    /// SafeCast.toInt128, and PoolManager._settle narrows the amount paid in
    /// with toInt128 too, so a deposit of 2^127 or more reverts inside v4 core
    /// whatever the mint's uint128 maxima allow. The bound was uint128, and a
    /// threshold in (2^127, 2^128] passed it, sold a whole curve, and failed
    /// every graduation for good. The line is drawn at int128's maximum,
    /// 2^127 - 1, as PONS draws it, so 2^127 itself is refused too. The
    /// previous test uses 2^129 and never reached that range.
    ///
    /// EACH REFUSAL HAS AN ACCEPTANCE ONE UNIT BELOW IT, on terms that pass
    /// every other check - so the line under test is this one, and a refusal
    /// cannot be coming from the price or tick-cap checks instead.
    function test_theSeedBoundIsV4sInt128OnBothSides() public onlyFork {
        uint256 lastFit = uint256(uint128(type(int128).max)); // 2^127 - 1
        assertEq(graduator.MAX_SEED_AMOUNT(), lastFit, "the bound is not int128's maximum");
        CurbLaunchFactory.Terms memory t =
            _terms(IHooks(address(hook)), FEE, TickMath.MAX_TICK_SPACING);

        // ---- THE QUOTE SIDE: the held quote is the threshold. phantom ==
        // threshold (D1's shape, which keeps the reservation at exactly half
        // the supply and so easy to aim at the line), a supply that keeps the
        // price and the liquidity in range at the widest spacing.
        t.supply = 5e35;
        t.phantomQuote = lastFit;
        t.graduationThreshold = lastFit;
        new CurbLaunchFactory(registry, graduator, NVDAC, feePolicy, feeEscrow, buybackVault, t);

        t.phantomQuote = lastFit + 1;
        t.graduationThreshold = lastFit + 1;
        assertLe(t.graduationThreshold, type(uint128).max, "the premise moved: this threshold fails uint128 too");
        vm.expectRevert(
            abi.encodeWithSelector(Graduator.SeedTooLargeToEncode.selector, t.supply / 2, lastFit + 1)
        );
        new CurbLaunchFactory(registry, graduator, NVDAC, feePolicy, feeEscrow, buybackVault, t);

        // ---- THE TOKEN SIDE: the held token is the reservation, which is
        // exactly supply / 2 when phantom == threshold.
        t.phantomQuote = 1e35;
        t.graduationThreshold = 1e35;
        t.supply = 2 * lastFit;
        assertEq(
            FullMath.mulDiv(t.supply, t.phantomQuote, t.phantomQuote + t.graduationThreshold), lastFit,
            "the premise moved: the reservation is not the last amount that fits"
        );
        new CurbLaunchFactory(registry, graduator, NVDAC, feePolicy, feeEscrow, buybackVault, t);

        t.supply = 2 * (lastFit + 1);
        vm.expectRevert(
            abi.encodeWithSelector(Graduator.SeedTooLargeToEncode.selector, lastFit + 1, uint256(1e35))
        );
        new CurbLaunchFactory(registry, graduator, NVDAC, feePolicy, feeEscrow, buybackVault, t);
    }

    /// A NON-ZERO QUOTE REFUND REACHES THE REFUND ADDRESS, ON A USDT-SHAPED
    /// QUOTE.
    ///
    /// _refund moved to safeTransfer so that a quote whose transfer returns
    /// nothing does not revert the graduation, and no test had ever sent it a
    /// non-zero amount: with phantom liquidity the quote binds and the refund
    /// measures zero. So a raw bool-decoding transfer, or no transfer at all,
    /// passed everything. OverQuotedCurve hands over twice the quote its price
    /// absorbs, registered directly as the launcher, so the token side binds
    /// and about half the quote is left over.
    function test_aNonZeroQuoteRefundReachesTheRefundAddress() public onlyFork {
        UsdtShapedToken usdt = new UsdtShapedToken();
        uint256 pricedQuote = 10_000e6;
        uint256 tokens = SUPPLY / 2;
        OverQuotedCurve curve = new OverQuotedCurve(usdt, pricedQuote, tokens, 2 * pricedQuote, address(graduator));
        CurbLaunchToken token = new CurbLaunchToken("Refund", "RFND", "", address(curve), tokens);
        curve.setToken(IERC20(address(token)));
        usdt.mint(address(curve), 2 * pricedQuote);

        address sink = makeAddr("the refund address");
        vm.prank(address(factory));
        registry.register(
            address(token),
            LaunchRegistry.Launch({
                curve: address(curve),
                quoteToken: address(usdt),
                beneficiary: creator,
                refundTo: sink,
                reservedZero: 0,
                fee: FEE,
                tickSpacing: TICK_SPACING,
                hooks: IHooks(address(hook)),
                platformBps: uint16(PLATFORM_FEE_BPS),
                platformRecipient: protocolRecipient,
                totalTaxBps: TOTAL_TAX_BPS,
                launchedAt: 0
            })
        );

        uint256 poolBefore = usdt.balanceOf(address(POOL_MANAGER));
        graduator.graduate(address(token));
        uint256 intoPool = usdt.balanceOf(address(POOL_MANAGER)) - poolBefore;

        uint256 refunded = usdt.balanceOf(sink);
        assertGt(intoPool, 0, "the pool took no quote at all");
        assertGt(refunded, pricedQuote / 2, "the quote the pool could not absorb was not refunded");
        assertEq(refunded, 2 * pricedQuote - intoPool, "the refund is not what the pool left over");
        assertEq(usdt.balanceOf(address(graduator)), 0, "the graduator kept quote");
    }

    /// AND THE GRADUATOR TAKES NOBODY'S NFT.
    ///
    /// Its onERC721Received was removed: PositionManager mints with a plain
    /// _mint and never called it, and the only calls it ever got were
    /// safeTransferFroms of OTHER people's tokens, which it accepted into a
    /// contract with no way to send them back. Without it the transfer reverts
    /// and the sender keeps the token.
    function test_theGraduatorRefusesAnNftSentToIt() public onlyFork {
        StrayNft nft = new StrayNft();
        address owner = makeAddr("somebody with an NFT");
        nft.mint(owner, 1);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InvalidReceiver.selector, address(graduator)));
        nft.safeTransferFrom(owner, address(graduator), 1);
        assertEq(nft.ownerOf(1), owner, "the NFT left its owner");
    }

    /// Checking a hook's PERMISSIONS was not enough on its own: a hook with no
    /// liquidity permissions can still name the wrong poolOpener, and then
    /// nobody - not even the graduator - can open the pool and the launch is
    /// stuck after the sale. So the registry requires one exact hook address,
    /// which settles the permissions, the opener and the fee behaviour at once.
    ///
    /// A factory built on such a hook CAN be deployed - its constructor has
    /// nothing to compare against, since wire() happens afterwards - so this
    /// builds one and shows the registry refusing its very first launch, with
    /// no money anywhere near a curve.
    function test_aFactoryOnAForeignHookIsRefusedAtItsFirstLaunch() public onlyFork {
        LiquidityRefusingHook refusing = _deployRefusingHook();
        (CurbLaunchFactory fac, FeeHook wired) = _stackWiredAgainst(IHooks(address(refusing)));

        // BUILT BEFORE THE PRANK. _configFor reads fac.supply() to predict the
        // token's address, and an external call between expectRevert and the
        // call under test is the call expectRevert matches against - it would
        // consume both the prank and the expectation on a view that succeeds.
        CurbLaunchFactory.LaunchConfig memory cfg = _configFor(fac, true);

        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(LaunchRegistry.UnsupportedHook.selector, address(refusing), address(wired))
        );
        fac.launch(cfg);
    }

    /// A hook that IS ours but was built for a different graduator could not
    /// open our pools. The same exact-address check catches it; a permissions
    /// check never would.
    function test_aFactoryOnAHookBoundElsewhereIsRefusedAtItsFirstLaunch() public onlyFork {
        FeeHook foreign = _mineHook(attacker, registry);
        (CurbLaunchFactory fac, FeeHook wired) = _stackWiredAgainst(IHooks(address(foreign)));

        // BUILT BEFORE THE PRANK. _configFor reads fac.supply() to predict the
        // token's address, and an external call between expectRevert and the
        // call under test is the call expectRevert matches against - it would
        // consume both the prank and the expectation on a view that succeeds.
        CurbLaunchFactory.LaunchConfig memory cfg = _configFor(fac, true);

        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(LaunchRegistry.UnsupportedHook.selector, address(foreign), address(wired))
        );
        fac.launch(cfg);
    }

    // ================================================================
    // Anyone may launch - and that is exactly why nothing else is open
    // ================================================================

    /// The door. A stranger with no relationship to this deployment creates a
    /// launch, and the launch is THEIRS: the curve pays its creator fees to
    /// them and the graduated position will be locked for them.
    function test_aStrangerCanLaunchAndIsTheCreator() public onlyFork {
        address stranger = makeAddr("a stranger");
        CurbLaunchFactory.LaunchConfig memory cfg = _config(true);

        vm.prank(stranger);
        (CurbLaunchToken token, PonsV2BondingCurve curve) = factory.launch(cfg);

        assertEq(curve.deployer(), stranger, "the creator fee recipient is not the caller");
        assertEq(registry.launchOf(address(token)).beneficiary, stranger, "the LP beneficiary is not the caller");
    }

    /// WHAT OPENING THE DOOR MUST NOT OPEN. The fee policy used to be a
    /// calldata argument, which was safe only while the door was shut. A
    /// stranger's launch must still pay US, at OUR rate.
    function test_aStrangerCannotRedirectTheFeesOrChangeTheShare() public onlyFork {
        address stranger = makeAddr("a greedy stranger");
        CurbLaunchFactory.LaunchConfig memory launchCfg = _config(true);
        vm.prank(stranger);
        (, PonsV2BondingCurve curve) = factory.launch(launchCfg);

        assertEq(curve.protocolFeeRecipient(), protocolRecipient, "the caller redirected the protocol fee");
        assertEq(curve.protocolFeeShareBps(), PROTOCOL_SHARE_BPS, "the caller changed the protocol share");
        assertEq(curve.feeBps(), PLATFORM_FEE_BPS, "the caller changed the platform fee");
        assertEq(curve.buybackEnabled(), false, "the caller turned buyback on");
    }

    /// The terms are the FACTORY'S, not the caller's, and reading them off the
    /// curve is what proves the calldata could not have carried them.
    function test_aStrangersLaunchUsesTheFactorysTerms() public onlyFork {
        CurbLaunchFactory.LaunchConfig memory launchCfg = _config(true);
        vm.prank(makeAddr("another stranger"));
        (CurbLaunchToken token, PonsV2BondingCurve curve) = factory.launch(launchCfg);

        assertEq(token.totalSupply(), SUPPLY, "the caller chose the supply");
        assertEq(curve.phantomQuote(), PHANTOM_QUOTE, "the caller chose the curve's shape");
        assertEq(curve.graduationThreshold(), GRADUATION_THRESHOLD, "the caller chose the threshold");

        LaunchRegistry.Launch memory rec = registry.launchOf(address(token));
        assertEq(rec.reservedZero, 0, "the record carries a lock duration");
        assertEq(rec.fee, FEE, "the caller chose the pool fee tier");
        assertEq(rec.tickSpacing, TICK_SPACING, "the caller chose the tick spacing");
        assertEq(address(rec.hooks), address(hook), "the caller chose the hook");
    }

    // ================================================================
    // The tax: a band, a fixed platform share, and no way back
    // ================================================================

    function test_theTaxBandIsRefusedAtBothEdges() public onlyFork {
        uint16 min_ = registry.MIN_TOTAL_TAX_BPS();
        uint16 max_ = registry.MAX_TOTAL_TAX_BPS();

        CurbLaunchFactory.LaunchConfig memory low = _config(true);
        low.totalTaxBps = min_ - 1;
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(CurbLaunchFactory.TaxOutOfBand.selector, min_ - 1, min_, max_));
        factory.launch(low);

        CurbLaunchFactory.LaunchConfig memory high = _config(true);
        high.totalTaxBps = max_ + 1;
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(CurbLaunchFactory.TaxOutOfBand.selector, max_ + 1, min_, max_));
        factory.launch(high);
    }

    /// The edges themselves are INSIDE. A band nobody can sit on the rim of is
    /// a different band from the one that was decided.
    function test_bothEdgesOfTheTaxBandAreAccepted() public onlyFork {
        uint16 min_ = registry.MIN_TOTAL_TAX_BPS();
        uint16 max_ = registry.MAX_TOTAL_TAX_BPS();

        CurbLaunchFactory.LaunchConfig memory low = _config(true);
        low.totalTaxBps = min_;
        vm.prank(creator);
        (CurbLaunchToken lowToken, PonsV2BondingCurve lowCurve) = factory.launch(low);

        CurbLaunchFactory.LaunchConfig memory high = _config(true);
        high.totalTaxBps = max_;
        vm.prank(creator);
        (CurbLaunchToken highToken, PonsV2BondingCurve highCurve) = factory.launch(high);

        assertEq(registry.launchOf(address(lowToken)).totalTaxBps, min_, "the floor was not recorded");
        assertEq(registry.launchOf(address(highToken)).totalTaxBps, max_, "the ceiling was not recorded");
        assertEq(lowCurve.creatorTaxBps(), min_ - PLATFORM_FEE_BPS, "the floor's creator share is wrong");
        assertEq(highCurve.creatorTaxBps(), max_ - PLATFORM_FEE_BPS, "the ceiling's creator share is wrong");
    }

    /// THE DECISION'S WHOLE POINT, AS ITS OWN TEST. Two launches, the tax five
    /// times apart, the same NVDAc spent on each: the platform is paid the SAME
    /// INTEGER and only the creator's side moves.
    function test_thePlatformsShareDoesNotMoveWithTheTax() public onlyFork {
        uint16 min_ = registry.MIN_TOTAL_TAX_BPS();
        uint16 max_ = registry.MAX_TOTAL_TAX_BPS();
        uint256 spend = 10e8;

        (uint256 lowProtocol, uint256 lowCreator) = _feesAfterABuyAtTax(min_, spend);
        (uint256 highProtocol, uint256 highCreator) = _feesAfterABuyAtTax(max_, spend);

        assertEq(lowProtocol, (spend * PLATFORM_FEE_BPS) / 10_000, "the platform was not PAID a fixed 50 bps");
        assertEq(highProtocol, lowProtocol, "the platform's take moved when the creator raised their tax");
        assertEq(lowCreator, (spend * (min_ - PLATFORM_FEE_BPS)) / 10_000, "the creator's floor payout is wrong");
        assertEq(highCreator, (spend * (max_ - PLATFORM_FEE_BPS)) / 10_000, "the creator's ceiling payout is wrong");
        assertGt(highCreator, lowCreator, "raising the tax did not raise the creator's share");
    }

    /// AND NOBODY CAN CHANGE IT AFTERWARDS - not the creator, not a stranger,
    /// and not us. The two setters that could move a launch's economics are
    /// gated on the curve's factory role, which this stack gives to the
    /// graduator. The graduator never calls setBuybackEnabled, and calls
    /// setCreatorFeeRecipient only from its holder sharing switch - once, one
    /// way, to the launch's own catalog-approved distributor, never to an
    /// address anyone names - so nobody reaches either setter directly. The
    /// record is write-once besides.
    function test_nobodyCanChangeALaunchsTaxAfterwards() public onlyFork {
        CurbLaunchFactory.LaunchConfig memory launchCfg = _config(true);
        vm.prank(creator);
        (CurbLaunchToken token, PonsV2BondingCurve curve) = factory.launch(launchCfg);

        uint256 taxBefore = curve.creatorTaxBps();

        address[3] memory whoever = [creator, attacker, address(factory)];
        for (uint256 i = 0; i < whoever.length; i++) {
            vm.prank(whoever[i]);
            vm.expectRevert(PonsV2BondingCurve.NotFactory.selector);
            curve.setCreatorFeeRecipient(attacker);

            vm.prank(whoever[i]);
            vm.expectRevert(PonsV2BondingCurve.NotFactory.selector);
            curve.setBuybackEnabled(true);
        }

        assertEq(curve.creatorTaxBps(), taxBefore, "the tax moved");
        assertEq(curve.feeBps(), PLATFORM_FEE_BPS, "the platform fee moved");
        assertEq(registry.launchOf(address(token)).totalTaxBps, TOTAL_TAX_BPS, "the record moved");
    }

    /// The record itself refuses a second write, so the tax cannot be revised
    /// by re-registering the same token even from the one address the registry
    /// listens to.
    function test_theTaxCannotBeRewrittenByReRegistering() public onlyFork {
        CurbLaunchFactory.LaunchConfig memory launchCfg = _config(true);
        vm.prank(creator);
        (CurbLaunchToken token,) = factory.launch(launchCfg);

        LaunchRegistry.Launch memory rewrite = registry.launchOf(address(token));
        rewrite.totalTaxBps = registry.MAX_TOTAL_TAX_BPS();

        vm.prank(address(factory));
        vm.expectRevert(abi.encodeWithSelector(LaunchRegistry.AlreadyRegistered.selector, address(token)));
        registry.register(address(token), rewrite);

        assertEq(registry.launchOf(address(token)).totalTaxBps, TOTAL_TAX_BPS, "the record was rewritten");
    }

    /// The registry is where the band is defined, so it must refuse an
    /// out-of-band record even from its own launcher - a future factory does
    /// not get to widen it.
    function test_theRegistryRefusesAnOutOfBandRecordFromItsOwnLauncher() public onlyFork {
        CurbLaunchFactory.LaunchConfig memory launchCfg = _config(true);
        vm.prank(creator);
        (CurbLaunchToken token,) = factory.launch(launchCfg);

        LaunchRegistry.Launch memory rec = registry.launchOf(address(token));
        rec.totalTaxBps = registry.MAX_TOTAL_TAX_BPS() + 1;

        uint16 min_ = registry.MIN_TOTAL_TAX_BPS();
        uint16 max_ = registry.MAX_TOTAL_TAX_BPS();

        vm.prank(address(factory));
        vm.expectRevert(
            abi.encodeWithSelector(LaunchRegistry.TaxOutOfRange.selector, uint16(max_ + 1), min_, max_)
        );
        registry.register(makeAddr("some other token"), rec);
    }

    /// AND THE PLATFORM SNAPSHOT, the two fields the registry used to take on
    /// trust. A share above the whole tax registers, sells a curve, graduates -
    /// and then every swap in the pool underflows in FeeHook._legs, forever,
    /// with the LP position locked inside. Refused where it is written, from
    /// the registry's own launcher, because further launchers can be admitted.
    function test_theRegistryRefusesAPlatformShareAboveTheTax() public onlyFork {
        CurbLaunchFactory.LaunchConfig memory launchCfg = _config(true);
        vm.prank(creator);
        (CurbLaunchToken token,) = factory.launch(launchCfg);

        LaunchRegistry.Launch memory rec = registry.launchOf(address(token));
        rec.platformBps = rec.totalTaxBps + 1;

        vm.prank(address(factory));
        vm.expectRevert(
            abi.encodeWithSelector(
                LaunchRegistry.PlatformShareAboveTax.selector, uint16(rec.totalTaxBps + 1), rec.totalTaxBps
            )
        );
        registry.register(makeAddr("a record with a share above its tax"), rec);

        // THE BOUNDARY IS ALLOWED: a share equal to the tax leaves the creator
        // nothing, which is a strange launch but not a broken pool. On a curve
        // of its own that vouches for it: the sample's curve is its launch's,
        // and the registry refuses it for any other token.
        address boundary = makeAddr("a record whose share is the whole tax");
        rec.platformBps = rec.totalTaxBps;
        rec.curve = _recordCurve(boundary, rec.quoteToken, address(graduator));
        vm.prank(address(factory));
        registry.register(boundary, rec);
    }

    function test_theRegistryRefusesAPlatformRecipientOfNobody() public onlyFork {
        CurbLaunchFactory.LaunchConfig memory launchCfg = _config(true);
        vm.prank(creator);
        (CurbLaunchToken token,) = factory.launch(launchCfg);

        LaunchRegistry.Launch memory rec = registry.launchOf(address(token));
        rec.platformRecipient = address(0);

        vm.prank(address(factory));
        vm.expectRevert(LaunchRegistry.IncompleteRecord.selector);
        registry.register(makeAddr("a record paying nobody"), rec);
    }

    function test_theRegistryCanOnlyBeWiredOnce() public onlyFork {
        vm.expectRevert(abi.encodeWithSelector(LaunchRegistry.LauncherAlreadySet.selector, address(factory)));
        registry.wire(attacker, address(hook));
        assertEq(registry.launcher(), address(factory), "the launcher changed");
        assertEq(registry.requiredHook(), address(hook), "the required hook changed");
    }

    // ================================================================
    // Criterion 2b - a transient failure, then the SAME record graduating
    // ================================================================

    /// Not ready yet is the textbook transient condition: it clears by itself
    /// as people buy. The attempt must leave nothing behind - in particular
    /// hasGraduated, which graduate() sets before it does any work.
    function test_aTransientFailureClearsAndTheSameRecordGraduates() public onlyFork {
        (PonsV2BondingCurve curve, CurbLaunchToken token) = _launch(true);

        vm.prank(launcher);
        vm.expectRevert(abi.encodeWithSelector(Graduator.CurveNotReady.selector, address(curve)));
        factory.graduate(address(token));

        assertFalse(graduator.hasGraduated(address(token)), "the flag survived a failed graduation");

        // The condition clears the ordinary way - and clearing it IS the
        // graduation, because the buy that crosses the threshold carries it.
        _fillToThreshold(curve);

        assertTrue(graduator.hasGraduated(address(token)), "the crossing buy did not graduate the launch");
        PositionLock lock = PositionLock(_lockOf(token));
        assertEq(lock.beneficiary(), creator, "the automatic graduation used different terms");
        assertEq(IERC721(address(POSM)).ownerOf(lock.tokenId()), address(lock), "no locked position exists");
    }

    // ================================================================
    // The states between "ready" and "graduated"
    // ================================================================

    /// THE HAPPY PATH HAS NO WAITING STATE AT ALL. The curve asks its factory
    /// to graduate the instant a buy exhausts the allocation, so the crossing
    /// trade carries the migration. Nobody has to do anything afterwards.
    function test_theCrossingBuyGraduatesInTheSameTransaction() public onlyFork {
        (PonsV2BondingCurve curve, CurbLaunchToken token) = _launch(true);

        vm.prank(NVDAC_WHALE);
        IERC20(NVDAC).transfer(trader, TRADER_FUNDING);
        vm.startPrank(trader);
        IERC20(NVDAC).approve(address(curve), type(uint256).max);
        curve.buy(TRADER_FUNDING, 0, trader);
        vm.stopPrank();

        assertTrue(curve.graduated(), "the curve did not close on the crossing buy");
        assertTrue(graduator.hasGraduated(address(token)), "graduation did not run inside the buy");
        assertLt(token.totalSupply(), SUPPLY, "the remainder was not burned inside the buy");

        PoolKey memory key = _keyFor(token, IHooks(address(hook)));
        (uint160 sqrtPriceX96,,,) = POOL_MANAGER.getSlot0(key.toId());
        assertGt(sqrtPriceX96, 0, "no pool was opened inside the buy");
    }

    /// AND WHEN THE AUTOMATIC ATTEMPT FAILS, THE STATE IS REAL.
    ///
    /// The failure here is INJECTED, not starved: a revert inside the mint. The
    /// real cause this stands in for is a crossing buyer leaving too little gas
    /// under the 63/64 rule, and that is NOT what is tested - neither the
    /// starvation nor whether enough gas survives for the catch. What is tested
    /// is the state the curve is left in once its attempt has failed, for
    /// whatever reason.
    ///
    /// The launch is then READY BUT NOT GRADUATED, and in that state BOTH sides
    /// of the curve are shut: sell() refuses once readyToGraduate() is true,
    /// and buy() refuses because the allocation is exhausted. Holders can reach
    /// neither the curve nor a pool that does not exist yet.
    ///
    /// This is the state an interface has to name, and the reason graduation is
    /// permissionless: anyone can end it.
    function test_aFailedAutoGraduationLeavesAVisibleWaitingState() public onlyFork {
        (PonsV2BondingCurve curve, CurbLaunchToken token) = _launch(true);
        _fillWithoutGraduating(curve);

        // Ready, not graduated - the state itself, readable on chain.
        assertTrue(curve.readyToGraduate(), "the curve is not ready");
        assertFalse(curve.graduated(), "the curve graduated after all");
        assertFalse(graduator.hasGraduated(address(token)), "the graduator thinks it is done");

        // The reserves are still in the curve, untouched.
        (uint256 quote, uint256 tokens) = curve.getReserves();
        assertGt(quote, 0, "the curve lost its quote reserve");
        assertGt(tokens, 0, "the curve lost its token reserve");
        assertEq(token.totalSupply(), SUPPLY, "something was burned while merely waiting");

        // No pool yet.
        PoolKey memory key = _keyFor(token, IHooks(address(hook)));
        (uint160 sqrtPriceX96,,,) = POOL_MANAGER.getSlot0(key.toId());
        assertEq(sqrtPriceX96, 0, "a pool exists while the launch is still waiting");

        // BOTH SIDES OF THE CURVE ARE SHUT. Buying is out because the
        // allocation is gone; selling is out because sell() refuses once the
        // curve is ready. A holder in this state has nowhere to go.
        address holder = trader;
        vm.startPrank(holder);
        token.approve(address(curve), type(uint256).max);
        vm.expectRevert(PonsV2BondingCurve.CurveGraduated.selector);
        curve.sell(1e18, 0, holder);
        vm.stopPrank();

        vm.prank(NVDAC_WHALE);
        IERC20(NVDAC).transfer(attacker, 1e8);
        vm.startPrank(attacker);
        IERC20(NVDAC).approve(address(curve), type(uint256).max);
        // CurveGraduated, but NOT from the graduated flag - that is still
        // false. It comes from the allocation being exhausted, which is a
        // different line in buy(). Matched specifically so a buy failing for
        // any other reason does not satisfy this.
        vm.expectRevert(PonsV2BondingCurve.CurveGraduated.selector);
        curve.buy(1e8, 0, attacker);
        vm.stopPrank();
        assertFalse(curve.graduated(), "the fixture is no longer in the waiting state");

        // ANYONE CAN END IT. That is the whole reason the caller is not
        // restricted: the party who most needs this unstuck is a holder, not
        // an operator.
        vm.prank(attacker);
        (PositionLock lock,,) = graduator.graduate(address(token));

        assertTrue(curve.graduated(), "the curve did not close");
        assertEq(lock.beneficiary(), creator, "the rescuer redirected the position");
        (sqrtPriceX96,,,) = POOL_MANAGER.getSlot0(key.toId());
        assertGt(sqrtPriceX96, 0, "the pool still does not exist");
    }

    // ================================================================
    // The wiring itself, checked rather than recorded
    // ================================================================

    /// Requiring every launch to match `requiredHook` only proves they match
    /// whatever was chosen at wiring. It says nothing about whether that choice
    /// works - and a hook that cannot open our pools would leave every launch
    /// under it stuck AFTER its sale. So wire() verifies the loop closes.

    function test_wiringRefusesAHookWithNoCode() public onlyFork {
        (LaunchRegistry reg2,, CurbLaunchFactory fac2) = _deployUnwiredStack();
        address notAHook = makeAddr("not-a-hook");

        vm.expectRevert(abi.encodeWithSelector(LaunchRegistry.HookHasNoCode.selector, notAHook));
        reg2.wire(address(fac2), notAHook);
    }

    /// THE ROLE CAN BE HANDED ON, IN TWO STEPS, AND THE OLD HOLDER LOSES IT.
    ///
    /// PONS's shape: PonsV2LaunchFactory is Ownable2Step (:55), its admin calls
    /// are immediate, and the role itself moves only to an address that proves
    /// it is reachable by accepting. Ours was an immutable address until
    /// 2026-09-23 - a lost key meant no further quote asset could ever be
    /// admitted, and a leaked one could admit them for as long as the registry
    /// exists. Neither is a decision this contract should make permanently on
    /// somebody's behalf.
    ///
    /// THE POWER ITSELF IS UNCHANGED and so is its name: addLauncher still runs
    /// the whole loop check, a launcher that is in cannot be removed, and the
    /// refusal is still NotTheDeployer.
    function test_theDeployerRoleIsHandedOnInTwoStepsAndTheOldOneLosesIt() public onlyFork {
        (LaunchRegistry reg2,, CurbLaunchFactory fac2) = _deployUnwiredStack();
        address next = makeAddr("the next deployer");
        assertEq(reg2.deployer(), address(this), "this test is not the registry's deployer");

        reg2.transferOwnership(next);
        // NOT YET. A one-step hand-off to an address nobody holds is the
        // mistake the second step exists to prevent, so the role has to stay
        // where it is until the new holder speaks.
        assertEq(reg2.deployer(), address(this), "the role moved before it was accepted");

        vm.prank(next);
        reg2.acceptOwnership();
        assertEq(reg2.deployer(), next, "the role did not move once it was accepted");

        // AND THE OLD HOLDER IS REFUSED, by the error it always was.
        vm.expectRevert(abi.encodeWithSelector(LaunchRegistry.NotTheDeployer.selector, address(this)));
        reg2.wire(address(fac2), address(1));
    }

    /// A FACTORY WHOSE LAUNCHES COULD NEVER GRADUATE IS NOT DEPLOYED.
    ///
    /// The graduator has always refused an unmintable seed - a price outside
    /// TickMath's range, or amounts that mint no liquidity. It refused it AT
    /// GRADUATION, which is after the money is in: a threshold sized wrong
    /// showed up as a full curve nobody could complete, and the fourteen
    /// thresholds in DeployCurb are hand-sized per asset against live prices.
    ///
    /// THE TERMS ARE IMMUTABLE ON THE FACTORY, so asking once at construction
    /// settles every launch that factory will ever create. PONS asks per
    /// launch (_requireSeedableTerms) because their economics are settable and
    /// ours are not.
    ///
    /// THIS ONE DEPLOYS. Calling the guard directly would prove the arithmetic
    /// and not that anything asks it.
    function test_aFactoryWhoseSeedCouldNeverMintIsRefused() public onlyFork {
        LaunchRegistry reg2 = new LaunchRegistry(address(this));
        Graduator grad2 = new Graduator(POOL_MANAGER, IPositionManagerMinimal(address(POSM)), PERMIT2, reg2, _catalog());
        FeeHook hook2 = _mineHook(address(grad2), reg2);

        // A supply of one: the reserve is supply * phantom / (phantom +
        // threshold), which at the shipped r of about 0.27 is a quarter of it,
        // and a quarter of one is none.
        vm.expectRevert(
            abi.encodeWithSelector(
                Graduator.SeedAllocationEmpty.selector, uint256(1), PHANTOM_QUOTE, GRADUATION_THRESHOLD
            )
        );
        new CurbLaunchFactory(
            reg2,
            grad2,
            NVDAC,
            feePolicy,
            feeEscrow,
            buybackVault,
            CurbLaunchFactory.Terms({
                supply: 1,
                quoteDecimals: 8,
                phantomQuote: PHANTOM_QUOTE,
                graduationThreshold: GRADUATION_THRESHOLD,
                poolFee: FEE,
                tickSpacing: TickMath.MAX_TICK_SPACING,
                hooks: IHooks(address(hook2)),
                protocolFeeRecipient: protocolRecipient,
                maxInternalPriceImpactBps: 500,
                launchFee: 0
            })
        );
    }

    /// AND THE REJECTION THAT IS AWKWARD TO REACH THROUGH A DEPLOYMENT: a seed
    /// carrying more liquidity than a tick may hold.
    ///
    /// v4's own TickLiquidityOverflow, which nothing in this codebase looked
    /// for before. Read straight off the guard because wrapping a factory
    /// around it would test the constructor a second time and this line once.
    ///
    /// THE OTHER BRANCH, SeedWouldNotMint, IS NOT TESTED AND CANNOT BE. For a
    /// full-range position the liquidity is sqrt(amount0 * amount1) to within
    /// rounding - the bounds are so far either side of the price that each
    /// formula collapses to one side - so with both amounts non-zero, and
    /// assertTermsAreSeedable refuses a zero allocation before it gets there,
    /// the result is never below 1. It stays as defence against that formula
    /// changing, and saying so is better than a test tuned until it passed.
    function test_theSeedGuardRefusesMoreLiquidityThanATickMayCarry() public onlyFork {
        // The spacing sets the cap and the narrowest has the lowest: about
        // 1.9e32 at a spacing of 1. sqrt(1e34 * 1e34) clears it and stays well
        // inside uint128.
        uint128 cap = Pool.tickSpacingToMaxLiquidityPerTick(1);
        assertGt(cap, 0, "the tick cap is zero, so nothing below is being tested");
        uint256 huge = 1e34;
        // THE FIGURE IS 1e34 DIVIDED BY ROOT TWO, and the reason is worth
        // stating: the seed's price is a half rather than one, because the
        // priced pair is (phantom + threshold) against the reserve and the
        // reserve is half the supply. Written out rather than recomputed here -
        // if the shape ever changes this should fail and be read again.
        vm.expectRevert(
            abi.encodeWithSelector(
                Graduator.SeedAboveTickCap.selector, uint128(7071067811865475244279504352542908), cap
            )
        );
        graduator.assertTermsAreSeedable(huge * 2, huge, huge, 1);
    }

    /// THE GRADUATOR RECORDS THE LOCK AND THE BURN, so no client has to hunt
    /// for them in a window of logs.
    ///
    /// PONS keeps the same two - lockedPositions and lockedTokenSupply, keyed
    /// by token. The page's lock panel used to scan the last few hundred
    /// blocks for ours and say so when the graduation was older than that; its
    /// own comment called it a gap in the contracts rather than in the page.
    function test_theGraduatorRecordsTheLockAndTheBurn() public onlyFork {
        (, CurbLaunchToken token,,) = _graduatedAt(TOTAL_TAX_BPS);

        address lock = graduator.lockOf(address(token));
        assertTrue(lock != address(0), "the graduator kept no lock for this launch");
        assertGt(lock.code.length, 0, "the recorded lock is not a contract");
        assertEq(
            PositionLock(payable(lock)).beneficiary(), creator, "the recorded lock is somebody else's"
        );

        // AND THE BURN, which the page shows beside it: r^2 of the supply,
        // about 7.3% at the shipped shape.
        assertGt(graduator.burnedOf(address(token)), 0, "the graduator kept no burn for this launch");
    }

    /// A TAKE THAT ARRIVES SHORT IS NOT WRITTEN DOWN AS IF IT ARRIVED.
    ///
    /// PONS's _takeExact, and the reason is the line after it: `owed` is
    /// credited with the figure that was ASKED FOR, so a token handing over
    /// less would leave the hook owing more than it holds, and the shortfall
    /// would be found by whoever claimed last.
    ///
    /// THE CONDITION IS SIMULATED, not the token. None of the fourteen assets
    /// behaves this way and building one that does would be a fixture of its
    /// own; balanceOf returning the same figure twice is precisely what a short
    /// transfer looks like from inside the guard, and the line under test is
    /// ours either way.
    function test_aShortTakeIsRefusedRatherThanCredited() public onlyFork {
        (CurbLaunchToken token, PoolKey memory key) = _graduatedOnWeth(creator);

        uint128 amountIn = 0.01 ether;
        vm.prank(WETH_HOLDER);
        IERC20(WETH9).transfer(trader, amountIn);
        _approveRouter(WETH9, amountIn);

        // The hook's own WETH balance stops moving, so every take looks short.
        vm.mockCall(
            WETH9,
            abi.encodeWithSelector(IERC20.balanceOf.selector, address(hook)),
            abi.encode(uint256(0))
        );

        vm.prank(trader);
        (bool ok, bytes memory err) = address(ROUTER).call(
            abi.encodeWithSignature(
                "execute(bytes,bytes[],uint256)",
                abi.encodePacked(V4_SWAP_CMD),
                _swapInputs(key, WETH9, address(token), amountIn, 0),
                block.timestamp + 60
            )
        );
        vm.clearMockedCalls();

        assertFalse(ok, "a take that arrived short was accepted");
        assertTrue(
            _mentions(err, FeeHook.InexactTransfer.selector),
            "the swap failed for some other reason than the short take"
        );
    }

    /// AND A CLAIM THAT PAYS SHORT DOES NOT CLOSE THE DEBT.
    ///
    /// PONS checks its own payouts the same way (_payOut). safeTransfer proves
    /// the call did not revert; it proves nothing about the amount, and the
    /// balance is zeroed before the transfer - so without this a short payment
    /// would settle a debt that was never paid.
    ///
    /// THE CLAIMANT REFUSES ETHER ON PURPOSE. On a WETH pair the claim leaves
    /// as ether and returns before any transfer; only a claimant that will not
    /// take it reaches the wrapped path, which is the one with the transfer in
    /// it.
    function test_aShortClaimIsRefusedRatherThanSettled() public onlyFork {
        EthRefuser refuser = new EthRefuser();
        (CurbLaunchToken token, PoolKey memory key) = _graduatedOnWeth(address(refuser));

        uint128 amountIn = 0.01 ether;
        vm.prank(WETH_HOLDER);
        IERC20(WETH9).transfer(trader, amountIn);
        _approveRouter(WETH9, amountIn);
        vm.prank(trader);
        (bool ok,) = address(ROUTER).call(
            abi.encodeWithSignature(
                "execute(bytes,bytes[],uint256)",
                abi.encodePacked(V4_SWAP_CMD),
                _swapInputs(key, WETH9, address(token), amountIn, 0),
                block.timestamp + 60
            )
        );
        assertTrue(ok, "the swap that accrues the fee did not go through");
        uint256 owedNow = hook.owed(address(refuser), WETH9);
        assertGt(owedNow, 0, "nothing was owed, so nothing could be claimed short");

        // The claimant's balance stands still, which is what a short transfer
        // looks like from inside the guard.
        vm.mockCall(
            WETH9,
            abi.encodeWithSelector(IERC20.balanceOf.selector, address(refuser)),
            abi.encode(uint256(0))
        );
        vm.expectRevert(
            abi.encodeWithSelector(FeeHook.InexactTransfer.selector, WETH9, owedNow, uint256(0))
        );
        refuser.collect(hook, WETH9);
        vm.clearMockedCalls();

        // AND THE DEBT IS STILL THERE. A revert is only worth having if it
        // leaves the books where they were.
        assertEq(hook.owed(address(refuser), WETH9), owedNow, "the debt moved under a claim that reverted");
    }

    function test_wiringRefusesTheZeroHook() public onlyFork {
        (LaunchRegistry reg2,, CurbLaunchFactory fac2) = _deployUnwiredStack();

        vm.expectRevert(LaunchRegistry.IncompleteRecord.selector);
        reg2.wire(address(fac2), address(0));
    }

    /// THE ARGUMENTS THAT NOTHING DOWNSTREAM COULD HAVE CAUGHT.
    ///
    /// AUDIT.txt A-5. wire() checks that the loop CLOSES, and a loop of zeroes
    /// closes: hook and graduator agree on a PoolManager when both are the zero
    /// address. So these two had to be refused where they are set, because
    /// every one of them is immutable and a deployment that gets past wire()
    /// has already stopped being fixable.
    ///
    /// EACH ONE ON ITS OWN, not one call with four zeroes: a single check in
    /// the wrong place would satisfy that and leave three arguments unguarded.
    function test_theGraduatorRefusesAZeroAddressArgument() public onlyFork {
        // Built first, then the cheatcode armed - expectRevert hooks the very
        // next call, and constructing the fixtures inside its range is how that
        // goes wrong.
        IPositionManagerMinimal pm = IPositionManagerMinimal(address(POSM));
        LaunchRegistry reg = registry;
        ISharingCatalog cat = _catalog();

        vm.expectRevert(Graduator.ZeroAddress.selector);
        new Graduator(IPoolManager(address(0)), pm, PERMIT2, reg, cat);

        vm.expectRevert(Graduator.ZeroAddress.selector);
        new Graduator(POOL_MANAGER, IPositionManagerMinimal(address(0)), PERMIT2, reg, cat);

        vm.expectRevert(Graduator.ZeroAddress.selector);
        new Graduator(POOL_MANAGER, pm, IPermit2Minimal(address(0)), reg, cat);

        vm.expectRevert(Graduator.ZeroAddress.selector);
        new Graduator(POOL_MANAGER, pm, PERMIT2, LaunchRegistry(address(0)), cat);

        vm.expectRevert(Graduator.ZeroAddress.selector);
        new Graduator(POOL_MANAGER, pm, PERMIT2, reg, ISharingCatalog(address(0)));
    }

    /// AND THE HOOK'S RECIPIENT, WHICH IS THE ONE NOTHING ON CHAIN CHECKED.
    ///
    /// A zero platformRecipient sends every platform leg to address(0) through
    /// poolManager.take, so every buy on every pool carrying the hook reverts -
    /// permanently, on an immutable field, discovered by the first trader.
    /// wire() cannot see it: the recipient is not part of the loop.
    ///
    /// NOT MINED. These are constructor refusals, so the address never has to
    /// carry hook permission bits - the revert happens before anything looks.
    function test_theHookRefusesAZeroAddressArgument() public onlyFork {
        LaunchRegistry reg = registry;
        address opener = address(graduator);

        vm.expectRevert(FeeHook.ZeroAddress.selector);
        new FeeHook(IPoolManager(address(0)), protocolRecipient, reg, opener, address(this));

        vm.expectRevert(FeeHook.ZeroAddress.selector);
        new FeeHook(POOL_MANAGER, address(0), reg, opener, address(this));

        vm.expectRevert(FeeHook.ZeroAddress.selector);
        new FeeHook(POOL_MANAGER, protocolRecipient, LaunchRegistry(address(0)), opener, address(this));

        vm.expectRevert(FeeHook.ZeroAddress.selector);
        new FeeHook(POOL_MANAGER, protocolRecipient, reg, address(0), address(this));
    }

    /// The case the address-equality check could never have caught: a hook that
    /// is ours, deploys fine, claims the right permissions - and opens pools
    /// for somebody else.
    function test_wiringRefusesAHookBoundToAnotherOpener() public onlyFork {
        (LaunchRegistry reg2,, CurbLaunchFactory fac2) = _deployUnwiredStack();
        address graduator2 = address(fac2.graduator());
        FeeHook foreign = _mineHook(attacker, registry);

        vm.expectRevert(
            abi.encodeWithSelector(LaunchRegistry.HookHasWrongOpener.selector, address(foreign), attacker, graduator2)
        );
        reg2.wire(address(fac2), address(foreign));
    }

    function test_wiringRefusesAHookWithTheWrongPermissions() public onlyFork {
        (LaunchRegistry reg2,, CurbLaunchFactory fac2) = _deployUnwiredStack();
        LiquidityRefusingHook wrongBits = _deployRefusingHook();

        vm.expectRevert(
            abi.encodeWithSelector(
                LaunchRegistry.HookHasWrongPermissions.selector,
                address(wrongBits),
                uint160(address(wrongBits)) & Hooks.ALL_HOOK_MASK
            )
        );
        reg2.wire(address(fac2), address(wrongBits));
    }

    /// And a launcher whose graduator answers to a different registry: the loop
    /// does not close, so the wiring is refused.
    function test_wiringRefusesALauncherPointingAtAnotherRegistry() public onlyFork {
        (LaunchRegistry reg2,,) = _deployUnwiredStack();

        vm.expectRevert(
            abi.encodeWithSelector(
                LaunchRegistry.GraduatorPointsElsewhere.selector, address(graduator), address(registry)
            )
        );
        reg2.wire(address(factory), address(hook));
    }

    // ================================================================
    // A SECOND QUOTE ASSET - the registry admitting more than one factory
    // ================================================================

    /// WHY THIS EXISTS AT ALL. A factory's quote asset and its threshold are
    /// immutable, so a second asset needs a second factory. A registry that
    /// admitted only one would force a second REGISTRY, which would split
    /// discovery in two and buy nothing.
    ///
    /// WHAT MADE THE OLD ONE SAFE, AND WHAT KEEPS IT SAFE NOW. wire() could be
    /// called once, so nothing could be swapped underneath a live launch.
    /// addLauncher() keeps that by having no removal and no overwrite, by
    /// refusing to touch the hook, and by running the SAME loop check. Each of
    /// those three is a test below, because "it is add-only" is a claim about
    /// code that has to be shown rather than asserted in a comment.
    ///
    /// CRITERIA, stated before measuring:
    ///   W1  an admitted second factory can register, and its record carries
    ///       ITS OWN quote asset, not the first one's
    ///   W2  a factory that was never admitted still cannot register
    ///   W3  only the deployer may admit one
    ///   W4  admitting before wiring is refused
    ///   W5  admitting the same factory twice is refused
    ///   W6  the loop check runs for the second one too
    ///   W7  the launchers enumerate, and an index past the end reverts
    ///   W8  admitting one moves neither the hook nor the first launcher

    /// A second factory on THIS registry, priced against a different B20 asset,
    /// with that asset's own escrow and policy.
    ///
    /// IT BORROWED THE FIRST ONE'S ESCROW, on the grounds that this is a test
    /// of the registry and DeployCurb's require checked the match. The factory
    /// checks it itself now (test_aFactoryOnAnotherAssetsEscrowCannotBeDEPLOYED),
    /// so a factory on a borrowed escrow can no longer be built at all.
    function _secondFactory() internal returns (CurbLaunchFactory fac2) {
        (FeeEscrow aaplEscrow, IPonsV2FeePolicy aaplPolicy) = _escrowAndPolicyFor(AAPLC);
        fac2 = new CurbLaunchFactory(
            registry, graduator, AAPLC, aaplPolicy, IPonsV2FeeEscrow(address(aaplEscrow)), buybackVault,
            _terms(IHooks(address(hook)), FEE, TICK_SPACING)
        );
    }

    /// An escrow for `quote` and a policy naming it, the pair DeployCurb builds
    /// per asset. The escrow is created FIRST, in this contract's next nonce.
    function _escrowAndPolicyFor(address quote) internal returns (FeeEscrow escrow, IPonsV2FeePolicy policy) {
        escrow = new FeeEscrow(quote);
        policy = IPonsV2FeePolicy(
            address(new FeePolicy(protocolRecipient, IPonsV2FeeEscrow(address(escrow)), 500))
        );
    }

    /// A record shaped like a real one, taken from a real launch and pointed
    /// at another asset. Registering it directly, as the factory, is what tests
    /// the REGISTRY rather than the factory that usually calls it.
    function _recordFor(address quote) internal returns (LaunchRegistry.Launch memory rec) {
        CurbLaunchFactory.LaunchConfig memory launchCfg = _config(true);
        vm.prank(creator);
        (CurbLaunchToken sample,) = factory.launch(launchCfg);
        rec = registry.launchOf(address(sample));
        rec.quoteToken = quote;
    }

    // W1, and W8 alongside it
    function test_asecondFactoryOnAnotherAssetCanRegister() public onlyFork {
        CurbLaunchFactory fac2 = _secondFactory();
        assertEq(fac2.quoteToken(), AAPLC, "the second factory is not on the second asset");

        registry.addLauncher(address(fac2));

        // W8 - nothing that was already fixed moved.
        assertEq(registry.launcher(), address(factory), "the first launcher changed");
        assertEq(registry.requiredHook(), address(hook), "the required hook changed");
        assertTrue(registry.isLauncher(address(factory)), "the first launcher was dropped");
        assertTrue(registry.isLauncher(address(fac2)), "the second launcher was not admitted");

        // A real first-asset launch, so the two can be compared afterwards.
        CurbLaunchFactory.LaunchConfig memory launchCfg = _config(true);
        vm.prank(creator);
        (CurbLaunchToken first,) = factory.launch(launchCfg);

        address second = makeAddr("a second asset's launch token");
        LaunchRegistry.Launch memory rec = _recordFor(AAPLC);
        // ITS OWN CURVE, ON ITS OWN ASSET: the sample's curve trades NVDAc for
        // the sample's token, and the registry refuses it for this record.
        rec.curve = _recordCurve(second, AAPLC, address(graduator));
        vm.prank(address(fac2));
        registry.register(second, rec);

        // W1 - the record carries the SECOND asset, and the first launch is
        // untouched. A registry that silently kept one asset for both would put
        // every trade on the wrong token.
        assertEq(registry.launchOf(second).quoteToken, AAPLC, "the record kept the first asset");
        assertEq(registry.launchOf(address(first)).quoteToken, NVDAC, "the first launch's asset moved");
    }

    // W2
    function test_afactoryThatWasNeverAdmittedCannotRegister() public onlyFork {
        CurbLaunchFactory fac2 = _secondFactory();
        // Deliberately NOT added.
        LaunchRegistry.Launch memory rec = _recordFor(AAPLC);
        address unadmitted = makeAddr("unadmitted token");
        vm.prank(address(fac2));
        vm.expectRevert(abi.encodeWithSelector(LaunchRegistry.NotTheLauncher.selector, address(fac2)));
        registry.register(unadmitted, rec);
    }

    // W3
    function test_onlyTheDeployerMayAdmitALauncher() public onlyFork {
        CurbLaunchFactory fac2 = _secondFactory();
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(LaunchRegistry.NotTheDeployer.selector, attacker));
        registry.addLauncher(address(fac2));
        assertFalse(registry.isLauncher(address(fac2)), "an outsider admitted a launcher");
    }

    // W4 - the hook is fixed by wire(), so there is nothing to check against
    // before it has run.
    function test_alauncherCannotBeAdmittedBeforeWiring() public onlyFork {
        (LaunchRegistry reg2,, CurbLaunchFactory fac2) = _deployUnwiredStack();
        vm.expectRevert(LaunchRegistry.LauncherNotSet.selector);
        reg2.addLauncher(address(fac2));
    }

    // THE LIST HAS A CEILING. An owner key could otherwise admit junk
    // launchers - each passing every admission check - until no launch fits a
    // block, for good, since none can be removed. At the ceiling, with every
    // slot a launcher that spins each starved probe, a launch still fits 2^24.
    function test_theLauncherListHasACeilingSoJunkCannotOutgrowALaunch() public onlyFork {
        address grad = address(factory.graduator());
        uint256 cap = registry.MAX_LAUNCHERS();
        while (registry.launcherCount() < cap) {
            registry.addLauncher(address(new JunkLauncher(grad)));
        }
        address extra = address(new JunkLauncher(grad));
        vm.expectRevert(abi.encodeWithSelector(LaunchRegistry.TooManyLaunchers.selector, cap));
        registry.addLauncher(extra);
        assertEq(registry.launcherCount(), cap, "a refused add still grew the list");
        assertFalse(registry.isLauncher(extra), "a launcher past the ceiling was admitted");

        CurbLaunchFactory.LaunchConfig memory cfg = _config(true);
        vm.prank(creator);
        (CurbLaunchToken token,) = factory.launch{gas: 16_777_216}(cfg);
        assertTrue(registry.isRegistered(address(token)), "a launch at the ceiling did not fit 2^24 gas");
    }

    // W5
    function test_thesameLauncherCannotBeAdmittedTwice() public onlyFork {
        CurbLaunchFactory fac2 = _secondFactory();
        registry.addLauncher(address(fac2));

        vm.expectRevert(abi.encodeWithSelector(LaunchRegistry.LauncherAlreadySet.selector, address(fac2)));
        registry.addLauncher(address(fac2));

        // And the first one is still refused too, which is the same guard.
        vm.expectRevert(abi.encodeWithSelector(LaunchRegistry.LauncherAlreadySet.selector, address(factory)));
        registry.addLauncher(address(factory));
        assertEq(registry.launcherCount(), 2, "a refused add still grew the list");
    }

    // W6 - the check that made wire() worth trusting runs here too. A factory
    // whose graduator answers to another registry would leave every launch
    // under it stuck after its sale.
    function test_admittingALauncherRunsTheSameLoopCheck() public onlyFork {
        (LaunchRegistry reg2, Graduator grad2, CurbLaunchFactory stray) = _deployUnwiredStack();

        vm.expectRevert(
            abi.encodeWithSelector(
                LaunchRegistry.GraduatorPointsElsewhere.selector, address(grad2), address(reg2)
            )
        );
        registry.addLauncher(address(stray));
        assertFalse(registry.isLauncher(address(stray)), "a stray factory was admitted");
    }

    // W9 - THE ONE THAT MATTERS, AND THE ONE THE OTHER EIGHT MISS.
    //
    // Admitting a factory to the registry is not the same as it being able to
    // work. Every curve is initialized through the Graduator, and creating a
    // launch calls that path - so if the Graduator recognises only ONE factory,
    // a second asset can be deployed, admitted, listed in the interface, and
    // still not able to create a single launch.
    //
    // W1..W8 all pass without this, because they never call launch() on the
    // second factory.
    function test_asecondFactoryCanActuallyCreateALaunch() public onlyFork {
        CurbLaunchFactory fac2 = _secondFactory();
        registry.addLauncher(address(fac2));

        CurbLaunchFactory.LaunchConfig memory launchCfg = _config(true);
        vm.prank(creator);
        (CurbLaunchToken token2, PonsV2BondingCurve curve2) = fac2.launch(launchCfg);

        assertEq(registry.launchOf(address(token2)).quoteToken, AAPLC, "the launch is on the wrong asset");
        assertTrue(address(curve2) != address(0), "no curve");
    }

    // W7
    function test_thelaunchersEnumerate() public onlyFork {
        assertEq(registry.launcherCount(), 1, "wiring did not record the first launcher");
        assertEq(registry.launcherAt(0), address(factory), "the first launcher is not at index 0");

        CurbLaunchFactory fac2 = _secondFactory();
        registry.addLauncher(address(fac2));

        assertEq(registry.launcherCount(), 2, "the second launcher was not recorded");
        assertEq(registry.launcherAt(1), address(fac2), "the second launcher is not at index 1");

        vm.expectRevert(abi.encodeWithSelector(LaunchRegistry.IndexOutOfRange.selector, uint256(2), uint256(2)));
        registry.launcherAt(2);
    }

    /// A failure DEEP in the sequence: the reserves have left the curve and the
    /// pool has been initialized when the mint fails. Wiring validation makes
    /// this unreachable through a misconfigured launch - which is the point of
    /// that validation - but it does not make the rollback itself untestable,
    /// and "it can't happen" is a worse guarantee than "it unwinds".
    ///
    /// The failure is injected, transient, and then cleared, so the SAME launch
    /// completes afterwards.
    function test_aFailedMintUnwindsEverythingAndTheSameLaunchThenCompletes() public onlyFork {
        (PonsV2BondingCurve curve, CurbLaunchToken token) = _launchAndFill(true);

        (uint256 quoteBefore, uint256 tokensBefore) = curve.getReserves();
        uint256 tokenIdBefore = POSM.nextTokenId();
        PoolKey memory key = _keyFor(token, IHooks(address(hook)));

        vm.mockCallRevert(
            address(POSM),
            abi.encodeWithSelector(IPositionManagerMinimal.modifyLiquidities.selector),
            abi.encodeWithSignature("Error(string)", "position manager is down")
        );

        vm.prank(launcher);
        vm.expectRevert("position manager is down");
        factory.graduate(address(token));

        // Everything before the mint is undone: the curve's reserves, its
        // closed flag, the pool, and the graduator's own bookkeeping.
        (uint256 quoteAfter, uint256 tokensAfter) = curve.getReserves();
        assertEq(quoteAfter, quoteBefore, "quote reserves left the curve anyway");
        assertEq(tokensAfter, tokensBefore, "token reserves left the curve anyway");
        assertFalse(curve.graduated(), "the curve closed during a failed graduation");
        assertFalse(graduator.hasGraduated(address(token)), "the flag survived a failed graduation");
        assertEq(POSM.nextTokenId(), tokenIdBefore, "a position NFT survived a failed graduation");
        assertEq(token.balanceOf(address(graduator)), 0, "tokens were stranded in the graduator");
        assertEq(token.balanceOf(refundTo), 0, "a failed attempt refunded something");
        (uint160 sqrtPriceX96,,,) = POOL_MANAGER.getSlot0(key.toId());
        assertEq(sqrtPriceX96, 0, "the pool survived a failed graduation");

        // The condition clears, and the same launch - same record, never
        // rewritten - graduates.
        vm.clearMockedCalls();

        vm.prank(launcher);
        (PositionLock lock, uint256 tokenId,) = factory.graduate(address(token));
        assertEq(tokenId, tokenIdBefore, "the retry did not mint the position the failure left free");
        assertEq(IERC721(address(POSM)).ownerOf(tokenId), address(lock), "the retry produced no locked position");
        assertEq(lock.beneficiary(), creator, "the retry used different terms");
        assertTrue(curve.graduated(), "the curve did not close on the successful attempt");
    }

    /// THE BURN HAS TO UNWIND TOO.
    ///
    /// The mint-failure test above fails BEFORE the burn, so it proves nothing
    /// about it. The burn is the last thing graduation does, so to fail after
    /// it the whole transaction has to revert from outside - a batch, a
    /// multicall, any caller that does something else afterwards and throws.
    ///
    /// THE HARNESS REPORTS WHAT IT SAW BEFORE IT THREW. An earlier version of
    /// this test only asserted that the outer call failed, which it would have
    /// done just as happily if graduation had reverted long before reaching the
    /// burn - the test would have passed while proving nothing. The helper now
    /// measures the supply drop INSIDE the reverting frame and carries it out
    /// in a custom error, and this test matches that error in full.
    error GraduatedThenReverted(uint256 supplyBefore, uint256 supplyAfter);

    function test_aFailureAfterTheBurnUnwindsTheBurn() public onlyFork {
        (PonsV2BondingCurve curve, CurbLaunchToken token) = _launchAndFill(true);

        uint256 supplyBefore = token.totalSupply();
        (uint256 quoteBefore, uint256 tokensBefore) = curve.getReserves();
        uint256 tokenIdBefore = POSM.nextTokenId();

        // r^2 of the supply at the fixture's terms - about 7.3% at the shipped
        // shape (it was a quarter at D1's r = 0.5).
        uint256 expectedBurn = FullMath.mulDiv(
            FullMath.mulDiv(SUPPLY, PHANTOM_QUOTE, PHANTOM_QUOTE + GRADUATION_THRESHOLD),
            PHANTOM_QUOTE, PHANTOM_QUOTE + GRADUATION_THRESHOLD
        );

        (bool ok, bytes memory err) =
            address(this).call(abi.encodeCall(this.graduateThenRevert, (address(token), supplyBefore)));
        assertFalse(ok, "the harness was supposed to revert after graduating");

        // Matched in full, so this test cannot pass on a graduation that failed
        // before the burn: that path reverts with something else entirely.
        assertEq(bytes4(err), GraduatedThenReverted.selector, "the harness threw before it finished graduating");
        bytes memory body = new bytes(err.length - 4);
        for (uint256 i = 0; i < body.length; i++) {
            body[i] = err[i + 4];
        }
        (uint256 reportedBefore, uint256 reportedAfter) = abi.decode(body, (uint256, uint256));
        assertEq(reportedBefore, supplyBefore, "the harness saw a different supply going in");
        assertApproxEqRel(
            reportedBefore - reportedAfter, expectedBurn, 1e15, "the burn inside the reverted frame was the wrong size"
        );

        // The burn is undone: the supply is back, and it is back because it was
        // never destroyed, not because something was re-minted.
        assertEq(token.totalSupply(), supplyBefore, "the burn survived a reverted transaction");
        assertEq(
            token.balanceOf(address(curve)),
            FullMath.mulDiv(supplyBefore, PHANTOM_QUOTE, PHANTOM_QUOTE + GRADUATION_THRESHOLD),
            "the curve's allocation did not come back"
        );

        (uint256 quoteAfter, uint256 tokensAfter) = curve.getReserves();
        assertEq(quoteAfter, quoteBefore, "quote reserves did not come back");
        assertEq(tokensAfter, tokensBefore, "token reserves did not come back");
        assertFalse(curve.graduated(), "the curve stayed closed");
        assertFalse(graduator.hasGraduated(address(token)), "the flag survived");
        assertEq(POSM.nextTokenId(), tokenIdBefore, "a position NFT survived");

        // And the same launch still graduates afterwards.
        vm.prank(launcher);
        (PositionLock lock, uint256 tokenId,) = factory.graduate(address(token));
        assertEq(IERC721(address(POSM)).ownerOf(tokenId), address(lock), "the retry produced no locked position");
        assertLt(token.totalSupply(), supplyBefore, "the retry did not burn");
    }

    /// THE CASE THE BALANCE-ONLY CHECK COULD NOT CATCH. A burn() that MOVES
    /// the tokens empties the graduator exactly as a real burn would; only
    /// totalSupply tells the two apart. Remove the supply check from
    /// _burnRemainder and this test fails - which is the point of it.
    ///
    /// Done by etching a storage-layout-compatible implementation over the
    /// real token, so the balances and the supply are untouched and only the
    /// code behind burn() changes. A mocked no-op cannot express this: it
    /// leaves the graduator holding the tokens, so the old check caught it by
    /// accident.
    function test_aBurnThatMovesTokensIsRejected() public onlyFork {
        (, CurbLaunchToken token) = _launchAndFill(true);

        bytes memory honestCode = address(token).code;
        vm.etch(address(token), address(new MovingBurnToken()).code);

        (uint256 amount, uint256 supplyBefore, uint256 supplyAfter) = _graduateExpectingNotBurned(address(token));

        // Nothing was destroyed, and the graduator WAS emptied - the exact
        // shape a balance-only check would have accepted.
        assertEq(supplyAfter, supplyBefore, "the fake burn changed the supply, so it is not the case under test");
        assertGt(amount, 0, "there was no remainder to burn, so this proves nothing");

        vm.etch(address(token), honestCode);

        // The refusal left nothing behind, and an honest burn destroys exactly
        // the amount the fake one tried to walk off with.
        assertEq(token.totalSupply(), SUPPLY, "supply changed during a refused graduation");
        assertEq(token.balanceOf(address(0xdead)), 0, "the moved tokens survived the revert");

        vm.prank(launcher);
        factory.graduate(address(token));
        assertEq(SUPPLY - token.totalSupply(), amount, "the honest burn destroyed a different amount");
    }

    /// The simpler adversary: burn() that does nothing at all. Kept as its own
    /// case, but it is the weaker one - the graduator is still holding the
    /// tokens afterwards, so even a balance-only check would refuse it.
    function test_aBurnThatDoesNothingIsRejected() public onlyFork {
        (, CurbLaunchToken token) = _launchAndFill(true);

        vm.mockCall(address(token), abi.encodeWithSelector(CurbLaunchToken.burn.selector), "");
        (uint256 amount, uint256 supplyBefore, uint256 supplyAfter) = _graduateExpectingNotBurned(address(token));
        vm.clearMockedCalls();

        assertEq(supplyAfter, supplyBefore, "the no-op burn changed the supply");
        assertGt(amount, 0, "there was no remainder to burn, so this proves nothing");

        assertEq(token.totalSupply(), SUPPLY, "supply changed during a refused graduation");
        vm.prank(launcher);
        factory.graduate(address(token));
        assertLt(token.totalSupply(), SUPPLY, "the retry did not burn");
    }

    /// Graduates expecting RemainderNotBurned, and returns its parameters.
    /// Decoded rather than matched with a bare expectRevert, so a graduation
    /// that failed for any other reason fails the test instead of satisfying
    /// it - and so the caller can assert what the fake burn actually did.
    function _graduateExpectingNotBurned(address launchToken)
        internal
        returns (uint256 amount, uint256 supplyBefore, uint256 supplyAfter)
    {
        vm.prank(launcher);
        (bool ok, bytes memory err) =
            address(factory).call(abi.encodeCall(CurbLaunchFactory.graduate, (launchToken)));

        assertFalse(ok, "graduation accepted a burn that destroyed nothing");
        assertEq(bytes4(err), Graduator.RemainderNotBurned.selector, "graduation failed for some other reason");

        bytes memory body = new bytes(err.length - 4);
        for (uint256 i = 0; i < body.length; i++) {
            body[i] = err[i + 4];
        }
        address reported;
        (reported, amount, supplyBefore, supplyAfter) = abi.decode(body, (address, uint256, uint256, uint256));
        assertEq(reported, launchToken, "the error named a different token");
    }

    /// @dev external so the test can call it low-level and survive the revert.
    ///      Graduates completely, checks the burn actually happened in this
    ///      frame, and reports the supply either side of it on the way out. A
    ///      bare revert here would let the test pass on a graduation that never
    ///      reached the burn.
    function graduateThenRevert(address launchToken, uint256 supplyBefore) external {
        vm.prank(launcher);
        factory.graduate(launchToken);

        uint256 supplyAfter = IERC20(launchToken).totalSupply();
        require(supplyAfter < supplyBefore, "graduation did not burn anything");

        revert GraduatedThenReverted(supplyBefore, supplyAfter);
    }

    // ================================================================
    // A quote asset that refuses to move
    // ================================================================

    /// WHAT IS AND IS NOT ESTABLISHED HERE, BEFORE ANY OF IT IS READ.
    ///
    ///   INJECTED. Every failure below is produced with a cheatcode against
    ///   NVDAc's transfer path. They establish how OUR contracts behave when a
    ///   quote transfer is refused or silently does nothing.
    ///
    ///   NOT OBSERVED. No B20 issuer restriction was triggered on chain. We
    ///   have no restricted address to test against, so the real error - its
    ///   selector, its message, whether it reverts at all rather than returning
    ///   false - is UNKNOWN. These tests must not be read as "B20 restrictions
    ///   behave like this".
    ///
    ///   THREE DIFFERENT SHAPES, THREE DIFFERENT DEFENCES. An earlier note here
    ///   said the second test covered a transfer returning false. It did not -
    ///   it mocks one returning TRUE and moving nothing, which is a different
    ///   path with a different guard:
    ///     reverts            -> the curve's SafeERC20 takes the attempt down
    ///     returns false      -> SafeERC20 again, via its return-value check
    ///     true, no delivery  -> the graduator measuring what arrived, though
    ///                           the zero-reserve check a line later refuses it
    ///                           anyway - the measurement's contribution here
    ///                           is a precise diagnosis, not the refusal
    ///     true, SHORT        -> the measurement, and ONLY the measurement
    ///   Whichever shape a live restriction takes, one of these catches it -
    ///   but which one it takes is still unknown. See ROADMAP section 6.3.

    /// A refused quote transfer must not be reported as a completed
    /// graduation. The curve uses SafeERC20, so a reverting transfer takes the
    /// whole attempt down; what this checks is that NOTHING is left behind and
    /// the launch is still completable afterwards.
    function test_aRefusedQuoteTransferLeavesTheLaunchWaiting() public onlyFork {
        (PonsV2BondingCurve curve, CurbLaunchToken token) = _launchAndFill(true);

        (uint256 quoteBefore, uint256 tokensBefore) = curve.getReserves();
        uint256 tokenIdBefore = POSM.nextTokenId();

        // The curve hands its quote reserve to the graduator. Refused.
        vm.mockCallRevert(
            NVDAC,
            abi.encodeWithSelector(IERC20.transfer.selector),
            abi.encodeWithSignature("Error(string)", "issuer restriction")
        );

        vm.prank(attacker);
        vm.expectRevert("issuer restriction");
        graduator.graduate(address(token));

        vm.clearMockedCalls();

        // Still waiting, with everything where it was.
        (uint256 quoteAfter, uint256 tokensAfter) = curve.getReserves();
        assertEq(quoteAfter, quoteBefore, "quote reserves moved despite the refusal");
        assertEq(tokensAfter, tokensBefore, "token reserves moved despite the refusal");
        assertFalse(curve.graduated(), "the curve closed on a refused transfer");
        assertFalse(graduator.hasGraduated(address(token)), "the launch was marked graduated");
        assertEq(POSM.nextTokenId(), tokenIdBefore, "a position survived");
        assertEq(token.totalSupply(), SUPPLY, "something was burned");

        // The restriction lifts and the SAME launch completes, from any caller.
        vm.prank(attacker);
        (PositionLock lock,,) = graduator.graduate(address(token));
        assertTrue(curve.graduated(), "the launch did not complete once the restriction lifted");
        assertEq(lock.beneficiary(), creator, "the terms changed across the retry");
    }

    /// A transfer that returns FALSE. SafeERC20 checks the return value, so
    /// this never reaches our own guard - it is the curve's safeTransfer that
    /// refuses. Its own test because it is a different path from the one below,
    /// which returns TRUE.
    function test_aQuoteTransferReturningFalseIsRefused() public onlyFork {
        (PonsV2BondingCurve curve, CurbLaunchToken token) = _launchAndFill(true);

        (uint256 quoteBefore, uint256 tokensBefore) = curve.getReserves();
        uint256 tokenIdBefore = POSM.nextTokenId();

        vm.mockCall(NVDAC, abi.encodeWithSelector(IERC20.transfer.selector), abi.encode(false));

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, NVDAC));
        graduator.graduate(address(token));

        vm.clearMockedCalls();

        (uint256 quoteAfter, uint256 tokensAfter) = curve.getReserves();
        assertEq(quoteAfter, quoteBefore, "quote reserves moved despite the refusal");
        assertEq(tokensAfter, tokensBefore, "token reserves moved despite the refusal");
        assertFalse(curve.graduated(), "the curve closed on a refused transfer");
        assertFalse(graduator.hasGraduated(address(token)), "the launch was marked graduated");
        assertEq(POSM.nextTokenId(), tokenIdBefore, "a position survived");
        assertEq(token.totalSupply(), SUPPLY, "something was burned");

        vm.prank(attacker);
        (PositionLock lock,,) = graduator.graduate(address(token));
        assertTrue(curve.graduated(), "the launch did not complete once the transfer worked");
        assertEq(lock.beneficiary(), creator, "the terms changed across the retry");
    }

    /// THE DANGEROUS SHAPE: a transfer that returns true and moves nothing.
    ///
    /// SafeERC20 cannot catch this - the call succeeded and the return value
    /// says so - and the curve would then report reserves it no longer has.
    /// The graduator measures what ARRIVED rather than trusting the curve's
    /// return value, which is the only thing standing between this and a pool
    /// seeded against money that was never delivered.
    function test_aSilentlyIneffectiveQuoteTransferIsCaught() public onlyFork {
        (PonsV2BondingCurve curve, CurbLaunchToken token) = _launchAndFill(true);

        (uint256 quoteBefore,) = curve.getReserves();
        uint256 transferable = quoteBefore - PHANTOM_QUOTE;

        // transfer() returns true and does nothing at all.
        vm.mockCall(NVDAC, abi.encodeWithSelector(IERC20.transfer.selector), abi.encode(true));

        vm.prank(attacker);
        (bool ok, bytes memory err) =
            address(graduator).call(abi.encodeCall(Graduator.graduate, (address(token))));

        vm.clearMockedCalls();

        assertFalse(ok, "graduation accepted reserves that never arrived");
        assertEq(bytes4(err), Graduator.ReservesDidNotArrive.selector, "it failed for some other reason");

        bytes memory body = new bytes(err.length - 4);
        for (uint256 i = 0; i < body.length; i++) {
            body[i] = err[i + 4];
        }
        (address reportedToken, uint256 expected, uint256 received) =
            abi.decode(body, (address, uint256, uint256));
        assertEq(reportedToken, NVDAC, "the error named the wrong asset");
        assertEq(expected, transferable, "the curve claimed a different amount");
        assertEq(received, 0, "something actually arrived");

        // And the launch is untouched and still completable.
        assertFalse(curve.graduated(), "the curve closed on a transfer that did nothing");
        vm.prank(attacker);
        graduator.graduate(address(token));
        assertTrue(curve.graduated(), "the launch did not complete once the transfer worked");
    }

    /// THE CASE ONLY THIS GUARD CATCHES: PARTIAL delivery.
    ///
    /// A total non-delivery is caught anyway - the next line refuses zero
    /// reserves - so removing the arrival check still reverts, just with
    /// ZeroReserves and a worse diagnosis. A transfer that delivers SOME of
    /// what it reports is the one that would otherwise go through.
    ///
    /// AND THE LP FIGURE IS NOT WHAT SHOWS IT. Measured on D1's 60/60 terms
    /// (r = 0.5), against a healthy run at the same parameters, the pool receives about the same either way -
    /// the quote side binds, so the LP takes what the quote can pair with and
    /// the rest would have been burned. What changes is where the rest goes:
    ///
    ///                          healthy        short delivery, check removed
    ///     into the LP          250,000,000    249,999,999
    ///     burned               249,999,999    ~0
    ///     stranded in curve    0              250,000,000
    ///
    /// A quarter of the supply sits in a curve that has closed and reported
    /// success. Nothing can move it: the curve will not trade it, and no other
    /// path reaches it.
    ///
    /// Shown on the launch token, because a short-delivery double can be etched
    /// over our own ERC20. The same shape on the B20 quote asset is not
    /// constructible here - it is a precompile - so that direction is reasoned,
    /// not measured.
    ///
    /// The double is honest in every other respect, burn() included, so that a
    /// graduation CAN run to completion on a short reserve once the check is
    /// removed. Otherwise the mutation would only show that something else
    /// broke later.
    function test_aPartiallyDeliveredReserveIsCaught() public onlyFork {
        (PonsV2BondingCurve curve, CurbLaunchToken token) = _launchAndFill(true);

        (, uint256 pricedTokens) = curve.getReserves();
        bytes memory honestCode = address(token).code;
        vm.etch(address(token), address(new ShortDeliveryToken(address(graduator))).code);

        vm.prank(attacker);
        (bool ok, bytes memory err) =
            address(graduator).call(abi.encodeCall(Graduator.graduate, (address(token))));

        assertFalse(ok, "graduation accepted a half-delivered reserve");
        assertEq(bytes4(err), Graduator.ReservesDidNotArrive.selector, "it failed for some other reason");

        bytes memory body = new bytes(err.length - 4);
        for (uint256 i = 0; i < body.length; i++) {
            body[i] = err[i + 4];
        }
        (address reportedToken, uint256 expected, uint256 received) =
            abi.decode(body, (address, uint256, uint256));
        assertEq(reportedToken, address(token), "the error named the wrong asset");
        assertEq(expected, pricedTokens, "the curve reported a different amount");
        assertEq(received, pricedTokens / 2, "the double did not deliver half");

        vm.etch(address(token), honestCode);

        assertFalse(curve.graduated(), "the curve closed on a half-delivered reserve");
        vm.prank(attacker);
        graduator.graduate(address(token));
        assertTrue(curve.graduated(), "the launch did not complete once delivery worked");
    }

    // ================================================================
    // What an interface is allowed to show
    // ================================================================

    /// One call, one answer, derived from what the chain already says. The
    /// lens keeps no status of its own: a second copy is a second thing that
    /// can be wrong, and the moment it disagrees with the curve the interface
    /// is lying to somebody.

    function test_lens_unregisteredTokenIsNotFound() public onlyFork {
        address stranger = makeAddr("never-launched");

        LaunchLens.LaunchView memory v = lens.launchState(stranger);

        // NOT Selling. An unregistered address rendered as an early launch is
        // a live-looking market with a zero price, which is worse than an
        // error.
        assertEq(uint256(v.status), uint256(LaunchLens.LaunchStatus.NotFound), "an unknown token got a status");
        assertEq(v.curve, address(0), "an unknown token came back with a curve");
        assertEq(v.beneficiary, address(0), "an unknown token came back with a beneficiary");
    }

    function test_lens_reportsSellingBeforeTheThreshold() public onlyFork {
        (PonsV2BondingCurve curve, CurbLaunchToken token) = _launch(true);

        LaunchLens.LaunchView memory v = lens.launchState(address(token));

        assertEq(uint256(v.status), uint256(LaunchLens.LaunchStatus.Selling), "a fresh launch is not selling");
        assertEq(v.curve, address(curve), "wrong curve");
        assertEq(v.quoteToken, NVDAC, "wrong quote asset");
        assertEq(v.beneficiary, creator, "wrong beneficiary");
        assertEq(v.graduationThreshold, GRADUATION_THRESHOLD, "wrong threshold");
        assertEq(v.realQuoteReserve, 0, "a fresh curve already holds quote");
        assertEq(v.totalSupply, SUPPLY, "wrong supply");

        // Progress is readable: buy some, and the bar moves without the status
        // changing.
        vm.prank(NVDAC_WHALE);
        IERC20(NVDAC).transfer(trader, 10e8);
        vm.startPrank(trader);
        IERC20(NVDAC).approve(address(curve), type(uint256).max);
        curve.buy(10e8, 0, trader);
        vm.stopPrank();

        v = lens.launchState(address(token));
        assertEq(uint256(v.status), uint256(LaunchLens.LaunchStatus.Selling), "a partial fill changed the status");
        assertGt(v.realQuoteReserve, 0, "progress did not move");
        assertLt(v.realQuoteReserve, v.graduationThreshold, "the fixture already finished");
    }

    function test_lens_reportsWaitingWhenReadyButNotGraduated() public onlyFork {
        (PonsV2BondingCurve curve, CurbLaunchToken token) = _launch(true);
        _fillWithoutGraduating(curve);

        LaunchLens.LaunchView memory v = lens.launchState(address(token));

        assertEq(uint256(v.status), uint256(LaunchLens.LaunchStatus.Waiting), "a ready launch is not waiting");
        // The reserves are still the curve's, and nothing has been burned -
        // which is what makes this a state and not a failure.
        assertGt(v.quoteReserve, 0, "the curve lost its quote reserve");
        assertGt(v.tokenReserve, 0, "the curve lost its token reserve");
        assertEq(v.totalSupply, SUPPLY, "something was burned while waiting");
    }

    function test_lens_reportsGraduatedAfterTheCrossingBuy() public onlyFork {
        (PonsV2BondingCurve curve, CurbLaunchToken token) = _launch(true);
        _fillToThreshold(curve);

        LaunchLens.LaunchView memory v = lens.launchState(address(token));

        assertEq(uint256(v.status), uint256(LaunchLens.LaunchStatus.Graduated), "the launch is not graduated");
        assertLt(v.totalSupply, SUPPLY, "the remainder was not burned");

        // The pool key is the one that exists, so the interface can route to it
        // without reconstructing anything.
        (uint160 sqrtPriceX96,,,) = POOL_MANAGER.getSlot0(v.poolKey.toId());
        assertGt(sqrtPriceX96, 0, "the reported pool does not exist");
        assertEq(address(v.poolKey.hooks), address(hook), "the reported pool has the wrong hook");
    }

    /// THE ORDER OF THE CHECKS IS LOAD-BEARING. readyToGraduate() goes false
    /// again once the curve has graduated, so asking it before the graduated
    /// flag would report a finished launch as Selling - the worst of the four
    /// answers, because it invites a trade the curve will refuse.
    function test_lens_doesNotReportAFinishedLaunchAsSelling() public onlyFork {
        (PonsV2BondingCurve curve, CurbLaunchToken token) = _launch(true);
        _fillToThreshold(curve);

        assertFalse(curve.readyToGraduate(), "the fixture does not exercise the trap");
        assertTrue(curve.graduated(), "the fixture did not graduate");
        assertEq(
            uint256(lens.statusOf(address(token))),
            uint256(LaunchLens.LaunchStatus.Graduated),
            "a finished launch was reported as selling"
        );
    }

    /// A FAILED ATTEMPT IS HISTORY, NOT A STATE. The launch below fails its
    /// automatic graduation, waits, then completes. Afterwards the lens must
    /// say Graduated - an interface reading AutoGraduationFailed from the log
    /// would say the opposite.
    function test_lens_ignoresAPastFailure() public onlyFork {
        (PonsV2BondingCurve curve, CurbLaunchToken token) = _launch(true);
        _fillWithoutGraduating(curve);

        assertEq(uint256(lens.statusOf(address(token))), uint256(LaunchLens.LaunchStatus.Waiting), "not waiting");

        // Anyone ends it.
        vm.prank(attacker);
        graduator.graduate(address(token));

        assertEq(
            uint256(lens.statusOf(address(token))),
            uint256(LaunchLens.LaunchStatus.Graduated),
            "a launch that once failed is still reported as unfinished"
        );
    }

    // ================================================================
    // Criterion 5 - the pool nobody else can open
    // ================================================================

    /// Detecting a wrong price is not enough. An attacker who opens the pool at
    /// ANY other price takes the key permanently: a pool cannot be
    /// re-initialized, and the hook is part of the key, so every graduation
    /// afterwards would revert. The hook refuses the initialization instead, so
    /// the attack stops being possible rather than becoming a permanent block.
    function test_anAttackerCannotOpenThePoolAtAll() public onlyFork {
        (, CurbLaunchToken token) = _launchAndFill(true);
        PoolKey memory key = _keyFor(token, IHooks(address(hook)));

        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(hook),
                IHooks.beforeInitialize.selector,
                abi.encodeWithSelector(FeeHook.NotThePoolOpener.selector, attacker),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
        POOL_MANAGER.initialize(key, uint160(1 << 96));

        (uint160 sqrtPriceX96,,,) = POOL_MANAGER.getSlot0(key.toId());
        assertEq(sqrtPriceX96, 0, "the attacker opened the pool");

        // And the graduation the attack was meant to block completes.
        vm.prank(launcher);
        (PositionLock lock, uint256 tokenId,) = factory.graduate(address(token));
        assertEq(IERC721(address(POSM)).ownerOf(tokenId), address(lock), "graduation did not complete after the attack");
        assertGt(POSM.getPositionLiquidity(tokenId), 0, "the graduated position holds no liquidity");
    }

    // ================================================================
    // Curve parameters decide the supply split - it is not a fixed property
    // ================================================================

    /// WHAT THIS IS FOR
    ///   The 73.46% remainder reported elsewhere in this file is NOT a property
    ///   of graduation. It is what this fixture's 30 NVDAc phantom against a
    ///   5 NVDAc threshold produces, and those two numbers were chosen so the
    ///   fixture would fit inside the NVDAc balance available on the pinned
    ///   fork. Fixture constraints are not product economics. Deciding what to
    ///   do with the remainder before choosing the parameters that create it
    ///   would be settling the second question first.
    ///
    ///   So: one test per parameter set - each a real launch on the real curve,
    ///   bought to its real threshold, every figure MEASURED from balances.
    ///   They are separate tests because the fork's NVDAc holder does not have
    ///   enough to fund five thresholds in one transaction's worth of state.
    ///
    /// THE RELATIONSHIP, STATED SO THE NUMBERS CAN CONTRADICT IT
    ///   With r = phantom / (phantom + threshold):
    ///       sold to buyers  = supply * (1 - r)
    ///       into the LP     = supply * r * (1 - r)
    ///       remainder       = supply * r^2
    ///   The LP share peaks at r = 1/2; the remainder grows as the SQUARE of r.
    ///   A high phantom relative to the threshold is what produces a large
    ///   remainder. Each test asserts its measurements against this to within
    ///   0.5% of supply - a wider gap means the model is wrong, not the numbers.

    function test_supplySplit_phantom30_threshold5() public onlyFork {
        _reportSplit(30e8, 5e8);
    }

    function test_supplySplit_phantom18_threshold6() public onlyFork {
        _reportSplit(18e8, 6e8);
    }

    function test_supplySplit_phantom9_threshold9() public onlyFork {
        _reportSplit(9e8, 9e8);
    }

    function test_supplySplit_phantom3_threshold9() public onlyFork {
        _reportSplit(3e8, 9e8);
    }

    function test_supplySplit_phantom1_threshold9() public onlyFork {
        _reportSplit(1e8, 9e8);
    }

    function _reportSplit(uint256 phantomQuote, uint256 graduationThreshold) internal {
        (uint256 sold, uint256 intoLp, uint256 remainder, uint256 lpQuote) =
            _measureSplit(phantomQuote, graduationThreshold);

        // Three independently measured balances, so this is a real check.
        assertEq(sold + intoLp + remainder, SUPPLY, "the supply is not accounted for");

        uint256 soldBps = sold * 10_000 / SUPPLY;
        uint256 lpBps = intoLp * 10_000 / SUPPLY;
        uint256 remBps = remainder * 10_000 / SUPPLY;

        emit log_named_string(
            "parameters",
            string.concat(
                vm.toString(phantomQuote / 1e8),
                " NVDAc phantom / ",
                vm.toString(graduationThreshold / 1e8),
                " NVDAc threshold"
            )
        );
        emit log_named_uint("sold to buyers      bps of supply", soldBps);
        emit log_named_uint("into the LP         bps of supply", lpBps);
        emit log_named_uint("remainder           bps of supply", remBps);
        // NOT "free float". This is what sits OUTSIDE the pool, and only while
        // the remainder goes to an ordinary address - burn or vesting changes
        // it. And the pool's own tokens are purchasable: locking the LP NFT
        // locks the position, not the tokens inside it from being bought.
        emit log_named_uint("outside the pool      bps of supply", soldBps + remBps);
        emit log_named_uint("LP quote, raw NVDAc              ", lpQuote);

        uint256 rBps = phantomQuote * 10_000 / (phantomQuote + graduationThreshold);
        assertApproxEqAbs(soldBps, 10_000 - rBps, 50, "sold share does not match (1 - r)");
        assertApproxEqAbs(lpBps, rBps * (10_000 - rBps) / 10_000, 50, "LP share does not match r(1 - r)");
        assertApproxEqAbs(remBps, rBps * rBps / 10_000, 50, "remainder does not match r squared");
    }

    /// One full launch -> fill -> graduate, with every number read from a
    /// balance afterwards. Deliberately returns nothing derived by subtraction.
    function _measureSplit(uint256 phantomQuote, uint256 graduationThreshold)
        internal
        returns (uint256 sold, uint256 intoLp, uint256 remainder, uint256 lpQuote)
    {
        address buyer = makeAddr(string.concat("buyer-", vm.toString(phantomQuote)));
        address remainderSink = makeAddr(string.concat("sink-", vm.toString(phantomQuote)));

        (CurbLaunchFactory fac,) = _stackOnShape(phantomQuote, graduationThreshold);
        CurbLaunchFactory.LaunchConfig memory cfg = _config(true);
        cfg.quoteRefundTo = remainderSink;
        cfg.salt = _saltForSideOf(fac, cfg, true);

        vm.prank(creator);
        (CurbLaunchToken token, PonsV2BondingCurve curve) = fac.launch(cfg);

        // A real buy, oversized: the curve fills up to its allocation, charges
        // for what it used and refunds the rest. Funded from the whale and
        // scaled to THIS row's threshold - the sweep varies the threshold, so a
        // single global funding constant would either starve the large rows or
        // overdraw the small holder.
        uint256 poolQuoteBefore = IERC20(NVDAC).balanceOf(address(POOL_MANAGER));

        // The crossing buy graduates the launch itself - the real path.
        uint256 funding = graduationThreshold * 110 / 100;
        vm.prank(NVDAC_WHALE);
        IERC20(NVDAC).transfer(buyer, funding);
        vm.startPrank(buyer);
        IERC20(NVDAC).approve(address(curve), type(uint256).max);
        curve.buy(funding, 0, buyer);
        vm.stopPrank();
        require(curve.graduated(), "parameter set did not graduate on the crossing buy");

        sold = token.balanceOf(buyer);
        intoLp = token.balanceOf(address(POOL_MANAGER));
        // The remainder is burned, so it is the supply that disappeared, not a
        // balance sitting anywhere.
        remainder = SUPPLY - token.totalSupply();
        assertEq(token.balanceOf(remainderSink), 0, "the remainder was refunded instead of burned");
        lpQuote = IERC20(NVDAC).balanceOf(address(POOL_MANAGER)) - poolQuoteBefore;
    }

    // ================================================================
    // The two candidates, side by side
    // ================================================================

    /// NOT A PARAMETER CHOICE. Two candidates measured on the real curve and
    /// the real pool, so the choice can be made on what a user would actually
    /// experience rather than on which supply split looks nicer.
    ///
    /// Each reports four things:
    ///   1. how far the price travels from the first curve buyer to the last
    ///   2. where the supply ends up, and where it would end up if the
    ///      remainder were burned
    ///   3. what a buy of a realistic size costs against the graduated pool
    ///   4. the same for a sell
    ///
    /// The price-impact figures are EFFECTIVE prices - what the trader actually
    /// pays or receives - so they include the pool's 0.30% LP fee and the
    /// hook's 1% output fee. They are not pure slippage.

    function test_candidate_9phantom_9threshold() public onlyFork {
        _reportCandidate(9e8, 9e8);
    }

    function test_candidate_3phantom_9threshold() public onlyFork {
        _reportCandidate(3e8, 9e8);
    }

    function _reportCandidate(uint256 phantomQuote, uint256 graduationThreshold) internal {
        emit log_string("================================================");
        emit log_named_string(
            "CANDIDATE",
            string.concat(
                vm.toString(phantomQuote / 1e8), " NVDAc phantom / ", vm.toString(graduationThreshold / 1e8), " NVDAc threshold"
            )
        );

        address buyer = makeAddr(string.concat("cbuyer-", vm.toString(phantomQuote)));
        address sink = makeAddr(string.concat("csink-", vm.toString(phantomQuote)));

        (CurbLaunchFactory fac,) = _stackOnShape(phantomQuote, graduationThreshold);
        CurbLaunchFactory.LaunchConfig memory cfg = _config(true);
        cfg.quoteRefundTo = sink;
        cfg.salt = _saltForSideOf(fac, cfg, true);

        vm.prank(creator);
        (CurbLaunchToken token, PonsV2BondingCurve curve) = fac.launch(cfg);

        // ---- 1. how far the price travels along the curve, MEASURED
        (uint256 startQuote, uint256 startTokens) = curve.getReserves();

        uint256 funding = graduationThreshold * 110 / 100;
        vm.prank(NVDAC_WHALE);
        IERC20(NVDAC).transfer(buyer, funding);

        // The curve's final reserves cannot be read from inside the crossing
        // buy, so its automatic graduation is suppressed, the reserves read,
        // and graduation then run. The amounts are the same either way - the
        // same reserves are handed over - but only observable with the steps
        // apart.
        vm.mockCallRevert(
            address(POSM),
            abi.encodeWithSelector(IPositionManagerMinimal.modifyLiquidities.selector),
            abi.encodeWithSignature("Error(string)", "starved")
        );
        vm.startPrank(buyer);
        IERC20(NVDAC).approve(address(curve), type(uint256).max);
        curve.buy(funding, 0, buyer);
        vm.stopPrank();
        vm.clearMockedCalls();
        require(curve.readyToGraduate(), "candidate did not reach its threshold");

        (uint256 endQuote, uint256 endTokens) = curve.getReserves();

        // (endQuote/endTokens) / (startQuote/startTokens), rearranged into ONE
        // division. Computing each spot price first truncates the starting one
        // to zero - phantom quote is ~1e9 against a ~1e27 supply - and then
        // divides by it.
        uint256 priceRatioQ18 =
            FullMath.mulDiv(endQuote * startTokens, 1e18, endTokens * startQuote);
        emit log_named_uint("curve price multiplier, first buyer to last (1e18 = 1x)", priceRatioQ18);

        // The PoolManager is a singleton holding every pool's currencies, so
        // its NVDAc balance is not our pool's depth. The delta across
        // graduation is.
        uint256 poolQuoteBefore = IERC20(NVDAC).balanceOf(address(POOL_MANAGER));

        // THIS ROW'S OWN STACK. The token was launched by `fac`, and the main
        // factory forwards to a graduator that has never heard of it.
        vm.prank(launcher);
        (,, PoolKey memory key) = fac.graduate(address(token));

        uint256 lpQuote = IERC20(NVDAC).balanceOf(address(POOL_MANAGER)) - poolQuoteBefore;
        emit log_named_uint("quote depth in the pool, raw NVDAc      ", lpQuote);

        // ---- 2. where the supply ends up
        uint256 sold = token.balanceOf(buyer);
        uint256 intoLp = token.balanceOf(address(POOL_MANAGER));
        uint256 remainder = SUPPLY - token.totalSupply();
        assertEq(token.balanceOf(sink), 0, "the remainder was refunded instead of burned");
        assertEq(sold + intoLp + remainder, SUPPLY, "the supply is not accounted for");

        emit log_named_uint("sold to buyers            bps of launch supply", sold * 10_000 / SUPPLY);
        emit log_named_uint("into the LP position      bps of launch supply", intoLp * 10_000 / SUPPLY);
        emit log_named_uint("burned                    bps of launch supply", remainder * 10_000 / SUPPLY);
        emit log_named_uint("supply after the burn     bps of launch supply", token.totalSupply() * 10_000 / SUPPLY);
        emit log_named_uint("  held by buyers          bps of it            ", sold * 10_000 / token.totalSupply());
        emit log_named_uint("  in the pool             bps of it            ", intoLp * 10_000 / token.totalSupply());

        // ---- 3 and 4. what a trade actually costs
        _reportImpact(key, token, buyer, lpQuote, 1);
        _reportImpact(key, token, buyer, lpQuote, 5);
        _reportImpact(key, token, buyer, lpQuote, 10);
    }

    /// Buys and sells sized as a percentage of the pool's quote depth, so the
    /// two candidates are compared on the same footing.
    function _reportImpact(
        PoolKey memory key,
        CurbLaunchToken token,
        address tokenSource,
        uint256 depth,
        uint256 pctOfDepth
    ) internal {
        uint128 quoteIn = uint128(depth * pctOfDepth / 100);

        // Mid price before the trade, as raw quote per raw token.
        (uint160 sqrtPriceX96,,,) = POOL_MANAGER.getSlot0(key.toId());
        uint256 midQ18 = _quotePerTokenQ18(key, sqrtPriceX96);

        bool quoteIsCurrency0 = Currency.unwrap(key.currency0) == NVDAC;

        // BOTH LEGS ARE MEASURED FROM THE SAME POOL STATE. Selling straight
        // after the buy would be quoted against a price the buy itself moved,
        // which is a different question and, at 5% of depth, produced a "sell"
        // above the pre-buy mid.
        uint256 snap = vm.snapshotState();

        PoolHarness harness = new PoolHarness(POOL_MANAGER);
        vm.prank(NVDAC_WHALE);
        IERC20(NVDAC).transfer(address(harness), quoteIn);
        uint256 tokensBefore = token.balanceOf(address(harness));
        harness.swap(key, quoteIsCurrency0, -int256(uint256(quoteIn)));
        uint256 tokensOut = token.balanceOf(address(harness)) - tokensBefore;

        uint256 buyPriceQ18 = FullMath.mulDiv(quoteIn, 1e18 * 1e10, tokensOut);

        // ONE DEFINITION, AND IT IS THE SHORTFALL AGAINST MID
        //     cost = 1 - (what came back) / (what the mid says should have)
        // For a buy that is (paid - mid) / PAID. It used to be divided by MID,
        // which is a different quantity - "the price I paid was this much over
        // mid" rather than "this much of my money did not arrive" - while the
        // sell leg below was already the shortfall. Both were printed in one
        // table under one "bps" heading and compared with each other. The two
        // are related by x -> x/(1-x): equal to a bp at 48 bps, a factor of
        // four apart at 7745. The old table's headline - "a buy costs more
        // than a sell of the same size, consistently" - was reading that gap.
        emit log_named_uint(
            string.concat("buy  ", vm.toString(pctOfDepth), "% of depth - shortfall vs mid, bps"),
            (buyPriceQ18 - midQ18) * 10_000 / buyPriceQ18
        );
        // The other definition for the same trade, NAMED rather than mixed in,
        // because the costLimit tests below assert on this one.
        emit log_named_uint(
            string.concat("buy  ", vm.toString(pctOfDepth), "% of depth - price paid over mid, bps"),
            (buyPriceQ18 - midQ18) * 10_000 / midQ18
        );

        vm.revertToState(snap);

        // THE SELL IS SIZED FROM THE MID, NOT FROM THE BUY'S OUTPUT. Selling
        // the tokens the buy produced sells LESS than the stated size: that
        // amount has already been reduced by both fees and by the buy's own
        // price impact, so "sell 10% of depth" was really selling about 9%.
        uint256 tokensAtMid = FullMath.mulDiv(quoteIn, 1e18 * 1e10, midQ18);

        PoolHarness seller = new PoolHarness(POOL_MANAGER);
        vm.prank(tokenSource);
        token.transfer(address(seller), tokensAtMid);
        uint256 quoteBefore = IERC20(NVDAC).balanceOf(address(seller));
        seller.swap(key, !quoteIsCurrency0, -int256(tokensAtMid));
        uint256 quoteOut = IERC20(NVDAC).balanceOf(address(seller)) - quoteBefore;

        uint256 sellPriceQ18 = FullMath.mulDiv(quoteOut, 1e18 * 1e10, tokensAtMid);
        emit log_named_uint(
            string.concat("sell ", vm.toString(pctOfDepth), "% of depth - shortfall vs mid, bps"),
            (midQ18 - sellPriceQ18) * 10_000 / midQ18
        );

        vm.revertToState(snap);
    }

    /// Quote per token, scaled by 1e18 and corrected for the 8-vs-18 decimals
    /// gap, from a pool's sqrtPriceX96.
    function _quotePerTokenQ18(PoolKey memory key, uint160 sqrtPriceX96) internal pure returns (uint256) {
        uint256 priceX96 = FullMath.mulDiv(sqrtPriceX96, sqrtPriceX96, 1 << 96);
        bool tokenIsCurrency0 = Currency.unwrap(key.currency0) != NVDAC;
        uint256 quotePerTokenX96 = tokenIsCurrency0 ? priceX96 : FullMath.mulDiv(1 << 96, 1 << 96, priceX96);
        return FullMath.mulDiv(quotePerTokenX96, 1e10 * 1e18, 1 << 96);
    }

    // ================================================================
    // How big does the pool have to be? Same trades, different thresholds.
    // ================================================================

    /// THE QUESTION THIS ANSWERS
    ///   "9 or 3" was the wrong question. r decides the supply split and how
    ///   far the price travels; the THRESHOLD decides how much a real trade
    ///   costs. Holding r at 0.5 - phantom scaled with the threshold, the
    ///   candidate assumption - these rows vary only the threshold and quote
    ///   the SAME ABSOLUTE trade sizes against each.
    ///
    /// WHY ABSOLUTE AND NOT "% OF DEPTH"
    ///   A trade sized as a percentage of depth costs the same percentage
    ///   wherever depth is set - that is what the earlier table showed, and it
    ///   is why it could not answer this. A user does not scale their order to
    ///   our pool; they buy some amount. Raising the threshold lowers the cost
    ///   of THAT order, not of a proportional one.
    ///
    /// THE TAX THESE ROWS ARE MEASURED AT IS TOTAL_TAX_BPS - 3%, THE MIDDLE OF
    /// THE BAND - AND IT HAS TO BE SAID OUT LOUD.
    ///   Every figure includes the 0.30% LP fee and that 3% tax, so roughly 329
    ///   bps of each one is fee and does not fall with depth at any threshold.
    ///   A creator picks the tax between 1% and 5% now, so these rows are one
    ///   launch's costs and not the product's. At the band's floor the fee part
    ///   is about 130 bps and at the ceiling about 528. The comment here used
    ///   to say "the 1% hook fee ... roughly 130 bps", left over from when the
    ///   tax was fixed at 1%, which understated every row in the table by about
    ///   200 bps of fee.
    ///   The floor, under the same definition the rows use:
    ///       fee floor = 1 - 0.997 * (1 - T)
    ///       T = 1%  129.7 bps     T = 3%  329.1 bps     T = 5%  528.5 bps

    function test_depth_threshold2NVDAc() public onlyFork {
        _reportDepth(2e8);
    }

    function test_depth_threshold4NVDAc() public onlyFork {
        _reportDepth(4e8);
    }

    function test_depth_threshold8NVDAc() public onlyFork {
        _reportDepth(8e8);
    }

    function _reportDepth(uint256 threshold) internal {
        // r = 0.5: phantom scales WITH the threshold, so the supply split and
        // the curve's price multiplier stay fixed while depth changes.
        (PoolKey memory key, CurbLaunchToken token, address buyer, uint256 lpQuote) = _launchAt(threshold, threshold);

        emit log_string("================================================");
        emit log_named_uint("threshold / phantom, raw NVDAc (r = 0.5)", threshold);
        emit log_named_uint("pool quote depth, raw NVDAc             ", lpQuote);
        // THE TAX IS PART OF EVERY NUMBER BELOW, so it is printed with them
        // rather than left in a constant a reader has to go and find.
        emit log_named_uint("launch tax, bps (1% floor .. 5% ceiling)", TOTAL_TAX_BPS);
        emit log_named_uint("LP fee, bps                             ", 30);

        uint256[3] memory sizes = [uint256(5e6), 25e6, 1e8]; // 0.05, 0.25, 1.00 NVDAc

        for (uint256 i = 0; i < sizes.length; i++) {
            _reportAbsoluteImpact(key, token, buyer, sizes[i]);
        }
    }

    /// One absolute trade size, both directions, both measured from the same
    /// untouched pool state.
    function _reportAbsoluteImpact(PoolKey memory key, CurbLaunchToken token, address tokenSource, uint256 quoteIn)
        internal
    {
        (uint160 sqrtPriceX96,,,) = POOL_MANAGER.getSlot0(key.toId());
        uint256 midQ18 = _quotePerTokenQ18(key, sqrtPriceX96);
        bool quoteIsCurrency0 = Currency.unwrap(key.currency0) == NVDAC;

        uint256 snap = vm.snapshotState();

        PoolHarness buyerHarness = new PoolHarness(POOL_MANAGER);
        vm.prank(NVDAC_WHALE);
        IERC20(NVDAC).transfer(address(buyerHarness), quoteIn);
        uint256 tokensBefore = token.balanceOf(address(buyerHarness));
        buyerHarness.swap(key, quoteIsCurrency0, -int256(quoteIn));
        uint256 tokensOut = token.balanceOf(address(buyerHarness)) - tokensBefore;
        uint256 buyPriceQ18 = FullMath.mulDiv(quoteIn, 1e18 * 1e10, tokensOut);

        vm.revertToState(snap);

        uint256 tokensAtMid = FullMath.mulDiv(quoteIn, 1e18 * 1e10, midQ18);
        PoolHarness sellerHarness = new PoolHarness(POOL_MANAGER);
        vm.prank(tokenSource);
        token.transfer(address(sellerHarness), tokensAtMid);
        uint256 quoteBefore = IERC20(NVDAC).balanceOf(address(sellerHarness));
        sellerHarness.swap(key, !quoteIsCurrency0, -int256(tokensAtMid));
        uint256 quoteOut = IERC20(NVDAC).balanceOf(address(sellerHarness)) - quoteBefore;
        uint256 sellPriceQ18 = FullMath.mulDiv(quoteOut, 1e18 * 1e10, tokensAtMid);

        vm.revertToState(snap);

        // THE SAME ONE DEFINITION AS EVERYWHERE ELSE: 1 - returned/expected.
        // For a buy that is (paid - mid)/PAID, not (paid - mid)/mid. See the
        // note in _reportImpact for what the second one did to this table.
        emit log_named_uint(
            string.concat("  buy  ", _nvdac(quoteIn), " NVDAc - shortfall vs mid, bps"),
            (buyPriceQ18 - midQ18) * 10_000 / buyPriceQ18
        );
        emit log_named_uint(
            string.concat("  sell ", _nvdac(quoteIn), " NVDAc worth - shortfall vs mid, bps"),
            (midQ18 - sellPriceQ18) * 10_000 / midQ18
        );
        emit log_named_uint(
            string.concat("  buy  ", _nvdac(quoteIn), " NVDAc - price paid over mid, bps"),
            (buyPriceQ18 - midQ18) * 10_000 / midQ18
        );
    }

    /// Raw NVDAc to two decimal places. The fractional part needs padding:
    /// without it 5e6 printed as "0.5" when it is 0.05, which made every small
    /// trade in the table look ten times larger than it was.
    function _nvdac(uint256 raw) internal pure returns (string memory) {
        uint256 hundredths = (raw % 1e8) / 1e6;
        return string.concat(
            vm.toString(raw / 1e8), ".", hundredths < 10 ? "0" : "", vm.toString(hundredths)
        );
    }

    /// A launch at the given parameters, filled and graduated. Returns what the
    /// depth tests need and nothing else.
    function _launchAt(uint256 phantomQuote, uint256 threshold)
        internal
        returns (PoolKey memory key, CurbLaunchToken token, address buyer, uint256 lpQuote)
    {
        return _launchAtTax(phantomQuote, threshold, TOTAL_TAX_BPS);
    }

    // ================================================================
    // THE DECISION GRID - every threshold candidate against every tax
    // ================================================================
    //
    /// WHAT THIS IS FOR. The depth tables above answer "what does a trade cost
    /// at this threshold". A THRESHOLD DECISION needs that crossed with the
    /// tax, because the tax is a floor no depth can get under and a creator
    /// picks it: 1% costs 130 bps before any impact at all, and 5% costs 528.
    /// So the same absolute trades are run against every candidate threshold at
    /// every corner of the tax band, and the result is a grid somebody can read
    /// a decision off - not a decision.
    ///
    /// THE SIZES ARE FIXED IN NVDAc and chosen as the equivalents of $50, $100,
    /// $500, $1,000 and $5,000 at 211.7849 USD per NVDAc - the mid read at
    /// block 51357412 in DEPTH.txt section 1. That price is a property of that
    /// block and nothing else; the NVDAc amounts are what is actually measured.
    ///
    /// r = 0.5 THROUGHOUT, phantom scaled with the threshold, because that is
    /// what the pool depth figures assume: lpQuote comes out equal to the
    /// threshold. A different r would move the depth and every row with it.
    ///
    /// THIS IS ONE LEG. A user arriving with dollars pays the conversion in
    /// DEPTH.txt section 1 as well, and that leg is measured separately and on
    /// somebody else's liquidity. The two are never added inside this test.
    uint256 internal constant DSIZE_50 = 23_610_000;        // ~$50
    uint256 internal constant DSIZE_100 = 47_220_000;       // ~$100
    uint256 internal constant DSIZE_500 = 236_090_000;      // ~$500
    uint256 internal constant DSIZE_1K = 472_180_000;       // ~$1,000
    uint256 internal constant DSIZE_5K = 2_360_920_000;     // ~$5,000

    function test_decisionGrid_threshold10NVDAc() public onlyFork {
        _decisionGrid(10e8, 3000, 60);
    }

    function test_decisionGrid_threshold20NVDAc() public onlyFork {
        _decisionGrid(20e8, 3000, 60);
    }

    function test_decisionGrid_threshold60NVDAc() public onlyFork {
        _decisionGrid(60e8, 3000, 60);
    }

    /// THE SAME GRID AT THE OTHER CANDIDATE TIER.
    ///
    /// "0.05% would take about 25 bps off every cell" was written here and is
    /// wrong. 25 bps is the difference in the FEE, which is most of what a tiny
    /// trade pays and a shrinking part of what a large one pays; and a lower
    /// fee also lets MORE of the input reach the pool, which moves the price
    /// further. The two effects do not cancel to a constant, so the tier is
    /// measured at the same sizes rather than subtracted.
    function test_decisionGrid_tier500_threshold10NVDAc() public onlyFork {
        _decisionGrid(10e8, 500, 10);
    }

    function test_decisionGrid_tier500_threshold20NVDAc() public onlyFork {
        _decisionGrid(20e8, 500, 10);
    }

    function test_decisionGrid_tier500_threshold60NVDAc() public onlyFork {
        _decisionGrid(60e8, 500, 10);
    }

    /// THE SIZES A USER ACTUALLY ARRIVES WITH, measured rather than assumed.
    ///
    /// Somebody who converts $X of ETH into NVDAc does not then hold $X of
    /// NVDAc - they hold what the swap returned. Quoting our pool at the
    /// nominal $X overstates the buy, by 31 to 41 bps at $5,000, and an
    /// earlier version of DEPTH.txt compared that overstated buy against a
    /// sell computed on the real net and concluded sells were cheaper. The
    /// error was larger than the difference being claimed.
    ///
    /// These are the NET NVDAc the entry leg really produced at block
    /// 51359669, printed by `measure-depth.sh` with DEPTH_ENTRY_USD set. They
    /// belong to that block the same way the nominal sizes belong to theirs.
    uint256 internal constant NETE_50 = 23_495_063;
    uint256 internal constant NETE_100 = 46_984_062;
    uint256 internal constant NETE_500 = 234_677_982;
    uint256 internal constant NETE_1K = 468_753_107;
    uint256 internal constant NETE_5K = 2_319_871_193;

    uint256 internal constant NETU_50 = 23_493_897;
    uint256 internal constant NETU_100 = 46_979_400;
    uint256 internal constant NETU_500 = 234_561_721;
    uint256 internal constant NETU_1K = 468_216_524;
    uint256 internal constant NETU_5K = 2_284_798_614;

    function test_decisionGrid_netETH_threshold10NVDAc() public onlyFork {
        _decisionGridAt(10e8, 3000, 60, _five(NETE_50, NETE_100, NETE_500, NETE_1K, NETE_5K));
    }

    function test_decisionGrid_netETH_threshold20NVDAc() public onlyFork {
        _decisionGridAt(20e8, 3000, 60, _five(NETE_50, NETE_100, NETE_500, NETE_1K, NETE_5K));
    }

    function test_decisionGrid_netETH_threshold60NVDAc() public onlyFork {
        _decisionGridAt(60e8, 3000, 60, _five(NETE_50, NETE_100, NETE_500, NETE_1K, NETE_5K));
    }

    function test_decisionGrid_netUSDC_threshold10NVDAc() public onlyFork {
        _decisionGridAt(10e8, 3000, 60, _five(NETU_50, NETU_100, NETU_500, NETU_1K, NETU_5K));
    }

    function test_decisionGrid_netUSDC_threshold20NVDAc() public onlyFork {
        _decisionGridAt(20e8, 3000, 60, _five(NETU_50, NETU_100, NETU_500, NETU_1K, NETU_5K));
    }

    function test_decisionGrid_netUSDC_threshold60NVDAc() public onlyFork {
        _decisionGridAt(60e8, 3000, 60, _five(NETU_50, NETU_100, NETU_500, NETU_1K, NETU_5K));
    }

    function _five(uint256 a, uint256 b, uint256 c, uint256 d, uint256 e)
        internal
        pure
        returns (uint256[] memory out)
    {
        out = new uint256[](5);
        out[0] = a;
        out[1] = b;
        out[2] = c;
        out[3] = d;
        out[4] = e;
    }

    // ================================================================
    // THE SCENARIO - one user story, priced both ways at both tiers
    // ================================================================
    //
    /// THE USER THIS IS BUILT AROUND arrives with ETH and leaves for ETH. That
    /// is a SCENARIO, not a measured user profile: nothing in this repository
    /// observes who trades or how much, and an earlier summary asserted a
    /// median trade size on no evidence at all. $100 is the size the design is
    /// being judged at and $500 is a second point to look at, because those are
    /// the two the founder named - not because anything here says they are
    /// typical.
    ///
    /// THE NET AMOUNTS ARE THE ENTRY LEG'S OUTPUT at block 51360335, measured
    /// by `measure-depth.sh` with DEPTH_ENTRY_USD="100,500". Somebody who
    /// converts $100 of ETH holds 0.46984101 NVDAc, not $100 of NVDAc, and this
    /// is the amount our pool is then measured at.
    uint256 internal constant SCEN_NET_100 = 46_984_101;   // $100 of ETH, via WETH/0.30%
    uint256 internal constant SCEN_NET_500 = 234_678_951;  // $500 of ETH, via WETH/0.30%

    function test_scenario_ethBuy_tier3000_threshold10NVDAc() public onlyFork {
        _scenarioGrid(10e8, 3000, 60);
    }

    function test_scenario_ethBuy_tier3000_threshold20NVDAc() public onlyFork {
        _scenarioGrid(20e8, 3000, 60);
    }

    function test_scenario_ethBuy_tier3000_threshold60NVDAc() public onlyFork {
        _scenarioGrid(60e8, 3000, 60);
    }

    function test_scenario_ethBuy_tier500_threshold10NVDAc() public onlyFork {
        _scenarioGrid(10e8, 500, 10);
    }

    function test_scenario_ethBuy_tier500_threshold20NVDAc() public onlyFork {
        _scenarioGrid(20e8, 500, 10);
    }

    function test_scenario_ethBuy_tier500_threshold60NVDAc() public onlyFork {
        _scenarioGrid(60e8, 500, 10);
    }

    function _scenarioGrid(uint256 threshold, uint24 fee_, int24 spacing_) internal {
        uint256[] memory sizes = new uint256[](2);
        sizes[0] = SCEN_NET_100;
        sizes[1] = SCEN_NET_500;
        _decisionGridAt(threshold, fee_, spacing_, sizes);
    }

    function _decisionGrid(uint256 threshold, uint24 fee_, int24 spacing_) internal {
        uint256[] memory sizes = new uint256[](5);
        sizes[0] = DSIZE_50;
        sizes[1] = DSIZE_100;
        sizes[2] = DSIZE_500;
        sizes[3] = DSIZE_1K;
        sizes[4] = DSIZE_5K;
        _decisionGridAt(threshold, fee_, spacing_, sizes);
    }

    function _decisionGridAt(uint256 threshold, uint24 fee_, int24 spacing_, uint256[] memory sizes)
        internal
    {
        uint16[3] memory taxes = [uint16(100), uint16(300), uint16(500)];

        for (uint256 t = 0; t < taxes.length; t++) {
            (PoolKey memory key, CurbLaunchToken token, address buyer, uint256 lpQuote) =
                _launchAtTaxTier(threshold, threshold, taxes[t], fee_, spacing_);

            emit log_string("================================================");
            emit log_named_uint("threshold, raw NVDAc                    ", threshold);
            emit log_named_uint("pool quote depth, raw NVDAc             ", lpQuote);
            emit log_named_uint("launch tax, bps                         ", taxes[t]);
            emit log_named_uint("LP fee, bps                             ", uint256(fee_) / 100);

            for (uint256 i = 0; i < sizes.length; i++) {
                _decisionImpact(key, token, buyer, sizes[i]);
            }
        }
    }

    /// One size, both directions, SHORTFALL against mid on both - the same
    /// definition the conversion tables use.
    ///
    /// THE SELL IS GUARDED. Selling "X NVDAc worth" at a small threshold asks
    /// for more tokens than the buyer ever received: at 10 NVDAc of depth a
    /// 23.6 NVDAc sell is 59% of the supply against a holder with 50%. An
    /// unguarded transfer reverts and takes the whole row with it, so the
    /// shortage is reported as what it is rather than crashing the grid.
    function _decisionImpact(PoolKey memory key, CurbLaunchToken token, address tokenSource, uint256 quoteIn)
        internal
    {
        (uint160 sqrtPriceX96,,,) = POOL_MANAGER.getSlot0(key.toId());
        uint256 midQ18 = _quotePerTokenQ18(key, sqrtPriceX96);
        bool quoteIsCurrency0 = Currency.unwrap(key.currency0) == NVDAC;

        uint256 snap = vm.snapshotState();

        PoolHarness buyerHarness = new PoolHarness(POOL_MANAGER);
        vm.prank(NVDAC_WHALE);
        IERC20(NVDAC).transfer(address(buyerHarness), quoteIn);
        uint256 tokensBefore = token.balanceOf(address(buyerHarness));
        buyerHarness.swap(key, quoteIsCurrency0, -int256(quoteIn));
        uint256 tokensOut = token.balanceOf(address(buyerHarness)) - tokensBefore;
        uint256 buyPriceQ18 = FullMath.mulDiv(quoteIn, 1e18 * 1e10, tokensOut);

        vm.revertToState(snap);

        emit log_named_uint(
            string.concat("  buy  ", _nvdac(quoteIn), " NVDAc - shortfall vs mid, bps"),
            (buyPriceQ18 - midQ18) * 10_000 / buyPriceQ18
        );

        uint256 tokensAtMid = FullMath.mulDiv(quoteIn, 1e18 * 1e10, midQ18);
        if (token.balanceOf(tokenSource) < tokensAtMid) {
            emit log_named_uint(
                string.concat("  sell ", _nvdac(quoteIn), " NVDAc worth - NOT MEASURED, the holder is short by bps of it"),
                (tokensAtMid - token.balanceOf(tokenSource)) * 10_000 / tokensAtMid
            );
            vm.revertToState(snap);
            return;
        }

        PoolHarness sellerHarness = new PoolHarness(POOL_MANAGER);
        vm.prank(tokenSource);
        token.transfer(address(sellerHarness), tokensAtMid);
        uint256 quoteBefore = IERC20(NVDAC).balanceOf(address(sellerHarness));
        sellerHarness.swap(key, !quoteIsCurrency0, -int256(tokensAtMid));
        uint256 quoteOut = IERC20(NVDAC).balanceOf(address(sellerHarness)) - quoteBefore;
        uint256 sellPriceQ18 = FullMath.mulDiv(quoteOut, 1e18 * 1e10, tokensAtMid);

        vm.revertToState(snap);

        emit log_named_uint(
            string.concat("  sell ", _nvdac(quoteIn), " NVDAc worth - shortfall vs mid, bps"),
            (midQ18 - sellPriceQ18) * 10_000 / midQ18
        );
    }

    function _launchAtTax(uint256 phantomQuote, uint256 threshold, uint16 tax)
        internal
        returns (PoolKey memory key, CurbLaunchToken token, address buyer, uint256 lpQuote)
    {
        return _launchAtTaxTier(phantomQuote, threshold, tax, FEE, TICK_SPACING);
    }

    function _launchAtTaxTier(
        uint256 phantomQuote,
        uint256 threshold,
        uint16 tax,
        uint24 fee_,
        int24 spacing_
    ) internal returns (PoolKey memory key, CurbLaunchToken token, address buyer, uint256 lpQuote) {
        buyer = makeAddr(string.concat("dbuyer-", vm.toString(threshold), "-", vm.toString(uint256(fee_))));

        (CurbLaunchFactory fac, FeeHook depthHook) = _stackOnShapeTier(phantomQuote, threshold, fee_, spacing_);
        CurbLaunchFactory.LaunchConfig memory cfg = _config(true);
        cfg.totalTaxBps = tax;
        cfg.quoteRefundTo =
            makeAddr(string.concat("dsink-", vm.toString(threshold), "-", vm.toString(uint256(fee_))));
        cfg.salt = _saltForSideOf(fac, cfg, true);

        vm.prank(creator);
        PonsV2BondingCurve curve;
        (token, curve) = fac.launch(cfg);

        // Fund the buy generously but leave the holder enough for the trades
        // that follow. threshold / 0.96 covers the curve's 4% total fee.
        uint256 funding = threshold * 110 / 100;
        vm.prank(NVDAC_WHALE);
        IERC20(NVDAC).transfer(buyer, funding);

        uint256 poolQuoteBefore = IERC20(NVDAC).balanceOf(address(POOL_MANAGER));
        vm.startPrank(buyer);
        IERC20(NVDAC).approve(address(curve), type(uint256).max);
        curve.buy(funding, 0, buyer);
        vm.stopPrank();
        require(curve.graduated(), "depth fixture did not graduate on the crossing buy");

        key = _keyForTier(token, IHooks(address(depthHook)), fee_, spacing_);
        lpQuote = IERC20(NVDAC).balanceOf(address(POOL_MANAGER)) - poolQuoteBefore;
    }

    // ================================================================
    // The cost limits, asserted rather than logged
    // ================================================================

    /// WHAT "COST" MEANS HERE, NARROWLY, AND IT IS NOT THE TABLES' DEFINITION
    ///   These assert on PRICE PAID OVER MID - (paid - mid) / mid - because a
    ///   "3% limit" is most naturally read as "the price is no more than 3%
    ///   worse than mid". The depth tables above report the SHORTFALL -
    ///   (paid - mid) / paid - "this share of my money did not arrive". The two
    ///   are x and x/(1-x): identical to a basis point down at 48 bps, a factor
    ///   of four apart at 7745. Both are printed here, each named, and neither
    ///   is ever put in a column with the other.
    ///
    ///   Execution cost against the pool's spot price immediately before the
    ///   trade, including the 0.30% LP fee and the launch's own TAX. It does
    ///   NOT include gas, a USDC->NVDAc conversion on the way in, or the price
    ///   moving while the transaction waits. A user arriving with USDC pays
    ///   more than this, and that total has not been measured.
    ///
    /// THESE NUMBERS ARE AT THE BAND'S FLOOR - A 1% TAX - AND THAT MATTERS.
    ///   The tax used to be a fixed 1% for every launch, so one depth answered
    ///   the question for everybody. A creator picks it now, between 1% and 5%,
    ///   and the constant term below is 1 / (0.997 * (1 - T)) - 1. It does not
    ///   fall with depth, so it is a FLOOR on what a trade costs:
    ///       T = 1%   131.40 bps      T = 3%   340.28 bps      T = 5%  551.68
    ///   A 3% limit is therefore unreachable at ANY depth once a launch charges
    ///   3% or more. That is not a defect in these tests; it is what choosing a
    ///   high tax does, and a creator choosing one should be told so.
    ///
    /// THE CLOSED FORM, AND WHY THE ROUNDED NUMBERS WERE NOT SAFE
    ///   For a constant-product pool at depth Q, a buy of T quote costs
    ///       1 / (0.997 * 0.99) - 1  +  T / (0.99 * Q)
    ///   The first term is the two fees - 131.404 bps at a 1% tax - and does
    ///   not fall with depth. Solving for a 1 NVDAc trade, at that tax:
    ///       <= 3%  needs 59.3126 NVDAc     <= 5%  needs 27.1300 NVDAc
    ///   Rounding those DOWN breaks the limit: 59 NVDAc costs 3.0089% and 27
    ///   NVDAc costs 5.0178%. The test candidates are 60 and 28, and the limit
    ///   is asserted rather than reported.
    ///
    /// SOLVED FOR DEPTH
    ///       depth  >=  T * 10,000 / (C - 131.40431395...)
    ///   where C is the limit in bps.
    ///
    ///   THERE USED TO BE A 0.99 IN THAT DENOMINATOR and an earlier note in
    ///   this file warned that dropping it "quietly breaks the very limit it is
    ///   solving for". That warning was right about the fee it described - a
    ///   fee on the OUTPUT - and is wrong about this one. Taking the tax off
    ///   the INPUT cancels it: the pool moves by what it actually receives, so
    ///   the term is T/Q. 59.31 is the answer now, and 59.91 would be the
    ///   error. The old figure is kept here rather than quietly swapped,
    ///   because the two are a worked example of a cost depending on WHERE a
    ///   fee is taken and not only how large it is.
    ///
    /// THE CHECK IS MADE ON THE UNROUNDED RATIO. Rounding the cost to whole
    /// basis points before comparing lets 300.04 bps pass a 300 bps limit,
    /// because it becomes 300 first. test_costLimit_59_9DepthIsJustOver is the
    /// regression: that depth costs 300.0355 bps, reports as 300, and must be
    /// rejected anyway.
    ///
    /// 60 AND 28 ARE TEST CANDIDATES, NOT CHOSEN PRODUCT PARAMETERS.

    uint256 internal constant ONE_NVDAC = 1e8;

    function test_costLimit_1NVDAc_under3pct_needs52Depth() public onlyFork {
        _assertCostLimit(52e8, ONE_NVDAC, 300);
    }

    function test_costLimit_1NVDAc_under5pct_needs26Depth() public onlyFork {
        _assertCostLimit(26e8, ONE_NVDAC, 500);
    }

    /// And the rounded-down depths do NOT meet the limits - so the assertions
    /// above are load-bearing rather than comfortably satisfied by anything.
    function test_costLimit_51DepthMissesThe3pctLimit() public onlyFork {
        (uint256 excess, uint256 mid) = _measureBuy(51e8, ONE_NVDAC);
        emit log_named_uint("51 NVDAc depth, 1 NVDAc buy, price over mid, bps", excess * 10_000 / mid);
        assertFalse(_withinLimit(excess, mid, 300), "51 NVDAc should NOT have met the 3% limit");
    }

    function test_costLimit_25DepthMissesThe5pctLimit() public onlyFork {
        (uint256 excess, uint256 mid) = _measureBuy(25e8, ONE_NVDAC);
        emit log_named_uint("25 NVDAc depth, 1 NVDAc buy, price over mid, bps", excess * 10_000 / mid);
        assertFalse(_withinLimit(excess, mid, 500), "25 NVDAc should NOT have met the 5% limit");
    }

    /// THE REGRESSION FOR THE ROUNDING BUG. A depth that costs just over a 300
    /// bps limit but reports as 300 once rounded to whole basis points - which
    /// the old assertion accepted. The unrounded comparison must reject it
    /// while the reported figure still reads 300.
    ///
    /// THE DEPTH MOVED WITH THE FORMULA. It was 59.9 while the fee came off the
    /// output; with the tax on the input the boundary is 59.3126, so 59.9 is
    /// comfortably UNDER the limit now and would have tested nothing. 59.2
    /// costs 300.32 bps: over, and still reads 300.
    function test_costLimit_51_5DepthIsJustOverAndIsRejected() public onlyFork {
        (uint256 excess, uint256 mid) = _measureBuy(515e7, ONE_NVDAC);

        uint256 roundedBps = excess * 10_000 / mid;
        emit log_named_uint("51.5 NVDAc depth, price over mid rounded to bps", roundedBps);
        assertEq(roundedBps, 300, "fixture is wrong: this case must ROUND to exactly the limit");

        assertFalse(_withinLimit(excess, mid, 300), "a cost just over the limit was accepted after rounding");
    }

    function _assertCostLimit(uint256 threshold, uint256 tradeSize, uint256 limitBps) internal {
        (uint256 excess, uint256 mid) = _measureBuy(threshold, tradeSize);
        uint256 roundedBps = excess * 10_000 / mid;

        emit log_named_uint("pool depth, raw NVDAc            ", threshold);
        emit log_named_uint("trade size, raw NVDAc            ", tradeSize);
        emit log_named_uint("launch tax, bps (the band's floor)", registry.MIN_TOTAL_TAX_BPS());
        emit log_named_uint("cost: price paid over mid, bps   ", roundedBps);
        emit log_named_uint("limit, bps (on the same definition)", limitBps);
        emit log_named_uint("predicted by the closed form, bps", _predictedCostBps(threshold, tradeSize));
        // THE SAME TRADE UNDER THE TABLES' DEFINITION, so the two halves of
        // DEPTH.txt can be read against each other without converting by hand.
        // excess/(mid + excess) is 1 - mid/paid, which is 1 - out/expected.
        emit log_named_uint("cost: shortfall vs mid, bps      ", excess * 10_000 / (mid + excess));

        // The LIMIT is checked on the unrounded ratio. Rounding first would let
        // anything below limit+1 bps through.
        assertTrue(
            _withinLimit(excess, mid, limitBps), "execution cost exceeds the limit this depth was chosen for"
        );

        // The model and the chain must agree, or one of them is wrong. Two bps
        // covers the finite LP range and the integer rounding the formula
        // ignores; anything wider is a real disagreement.
        assertApproxEqAbs(roundedBps, _predictedCostBps(threshold, tradeSize), 2, "measurement and closed form disagree");
    }

    /// excess/mid <= limitBps/10_000, cross-multiplied so nothing is rounded
    /// before the comparison.
    ///
    /// Checked arithmetic on purpose: if either product ever overflowed, this
    /// reverts and the test fails loudly rather than wrapping and silently
    /// inverting the answer. At the magnitudes here - mid around 1e10, excess
    /// around 1e8 - both products sit near 1e12, far below the limit.
    function _withinLimit(uint256 excess, uint256 mid, uint256 limitBps) internal pure returns (bool) {
        return excess * 10_000 <= limitBps * mid;
    }

    /// 1/(0.997*0.99) - 1 + T/(0.99*Q), in basis points.
    ///
    /// Carried at 1e6 sub-bps precision and divided once at the end, because
    /// both terms round to the same handful of bps and rounding each
    /// separately loses the difference the limits turn on.
    function _predictedCostBps(uint256 depth, uint256 tradeSize) internal pure returns (uint256) {
        // (1 - 0.98703) / 0.98703, in bps, scaled by 1e6.
        // (1 - k) / k in bps, scaled by 1e6, with k = (1 - tax)(1 - LP fee).
        // At a 1% tax and the 0.05% tier k = 0.989505, so the floor is 106.063
        // bps. It was 131.404 while the tier was 0.30%, and every depth below
        // moved with it - that is the point of the tier being a decision.
        uint256 feeFloor = uint256(10_495) * 10_000 * 1_000_000 / 989_505;
        // T / Q, in bps, scaled by 1e6.
        //
        // IT USED TO BE T / (0.99 * Q), AND THE 0.99 WAS THE HOOK FEE. When the
        // fee came off the OUTPUT, a trader had to put in 1/(1-tax) times as
        // much to end up with the same tokens, and that inflation showed up in
        // the price-impact term. The tax comes off the INPUT now: the pool
        // simply sees less, and the whole (1-tax)(1-f) cancels against the same
        // factor in the fee floor. The term is the bare T/Q again.
        uint256 slippage = FullMath.mulDiv(tradeSize, uint256(10_000) * 1_000_000, depth);
        return (feeFloor + slippage) / 1_000_000;
    }

    /// @return excess how much more than the pre-trade mid the buyer paid
    /// @return mid the pre-trade mid, same units - deliberately NOT a ratio, so
    ///         the caller can compare without rounding first
    function _measureBuy(uint256 threshold, uint256 tradeSize) internal returns (uint256 excess, uint256 mid) {
        // AT THE BAND'S FLOOR, and that is now part of the claim rather than a
        // detail. The cost of a trade depends on the launch's own tax, so
        // "what depth does 1 NVDAc need" has no single answer any more - it has
        // one per tax, and the floor is the best case.
        (PoolKey memory key, CurbLaunchToken token,,) =
            _launchAtTax(threshold, threshold, registry.MIN_TOTAL_TAX_BPS());

        (uint160 sqrtPriceX96,,,) = POOL_MANAGER.getSlot0(key.toId());
        uint256 midQ18 = _quotePerTokenQ18(key, sqrtPriceX96);

        PoolHarness harness = new PoolHarness(POOL_MANAGER);
        vm.prank(NVDAC_WHALE);
        IERC20(NVDAC).transfer(address(harness), tradeSize);
        uint256 before = token.balanceOf(address(harness));
        harness.swap(key, Currency.unwrap(key.currency0) == NVDAC, -int256(tradeSize));
        uint256 tokensOut = token.balanceOf(address(harness)) - before;

        uint256 paidQ18 = FullMath.mulDiv(tradeSize, 1e18 * 1e10, tokensOut);
        return (paidQ18 - midQ18, midQ18);
    }

    // ================================================================
    // Criterion 3 - price continuity
    // ================================================================

    function test_openingPriceMatchesTheCurve_launchTokenIsCurrency0() public onlyFork {
        _assertPriceRoundTrip(true);
    }

    function test_openingPriceMatchesTheCurve_launchTokenIsCurrency1() public onlyFork {
        _assertPriceRoundTrip(false);
    }

    function _assertPriceRoundTrip(bool launchIsCurrency0) internal {
        (PonsV2BondingCurve curve, CurbLaunchToken token) = _launchAndFill(launchIsCurrency0);
        assertEq(address(token) < NVDAC, launchIsCurrency0, "the token did not land on the intended side of NVDAc");

        // The curve's final price, recorded independently BEFORE graduation
        // touches anything.
        (uint256 pricedQuote, uint256 pricedTokens) = curve.getReserves();
        uint256 scale = 10 ** (LAUNCH_DECIMALS - NVDAC_DECIMALS);
        uint256 curvePriceQ18 = FullMath.mulDiv(pricedQuote * scale, 1e18, pricedTokens);

        vm.prank(launcher);
        (,, PoolKey memory key) = factory.graduate(address(token));
        (uint160 sqrtPriceX96,,,) = POOL_MANAGER.getSlot0(key.toId());

        uint256 priceX96 = FullMath.mulDiv(sqrtPriceX96, sqrtPriceX96, 1 << 96);
        uint256 quotePerLaunchX96 = launchIsCurrency0 ? priceX96 : FullMath.mulDiv(1 << 96, 1 << 96, priceX96);
        uint256 poolPriceQ18 = FullMath.mulDiv(quotePerLaunchX96, scale * 1e18, 1 << 96);

        // What a naive implementation would have opened at: the ratio of what
        // the curve could physically transfer.
        uint256 naivePriceQ18 = FullMath.mulDiv((pricedQuote - PHANTOM_QUOTE) * scale, 1e18, pricedTokens);

        emit log_named_uint("curve final price  (1e18 = 1.0 NVDAc/CURBL)", curvePriceQ18);
        emit log_named_uint("pool opening price (same units)            ", poolPriceQ18);
        emit log_named_uint("naive transferable-ratio price (WRONG)     ", naivePriceQ18);

        // Is the ordering step load-bearing? Without it the answer must be
        // materially different, or this test proves nothing about ordering.
        if (!launchIsCurrency0) {
            uint256 uninverted = FullMath.mulDiv(priceX96, scale * 1e18, 1 << 96);
            assertTrue(uninverted != poolPriceQ18, "the ordering step changes nothing - this test proves nothing");
        }

        // The mistake being avoided is large, not a rounding difference.
        assertLt(naivePriceQ18, curvePriceQ18, "fixture is wrong: the naive price must be lower");
        assertGt(curvePriceQ18 - naivePriceQ18, curvePriceQ18 / 100, "the naive price is too close to matter");

        (uint256 priced0, uint256 priced1) =
            launchIsCurrency0 ? (pricedTokens, pricedQuote) : (pricedQuote, pricedTokens);

        // (a) THE POOL STORES WHAT THE GRADUATOR COMPUTED. Exact, no tolerance.
        assertEq(
            sqrtPriceX96,
            graduator.sqrtPriceFromAmounts(priced0, priced1),
            "the pool did not open at the price the graduator computed"
        );

        // (b) AND THAT COMPUTATION IS ITSELF RIGHT. (a) alone only shows the
        // number was written through faithfully - it would pass just as well if
        // sqrtPriceFromAmounts were wrong. So check it against its DEFINITION
        // rather than against a reimplementation of it:
        //
        //     (sqrtP / 2^96)^2  ==  amount1 / amount0
        //
        // squared back up into Q96 on the left and computed directly on the
        // right, by two different routes through FullMath. The contract takes
        // one integer square root and one mulDiv, each of which floors.
        //
        // THE BUDGET IS RELATIVE, NOT ABSOLUTE. The sqrt's floor costs at most
        // 1 ulp of sqrtP, and SQUARING re-amplifies it: (x-1)^2 differs from
        // x^2 by about 2x, so the error on the squared value is about 2/sqrtP
        // of that value. Writing "2 units" instead - as a first attempt here
        // did - happens to hold at one currency ordering and fails by eight
        // orders of magnitude at the other, purely because the magnitudes are
        // different. Plus one ulp for each of the two mulDivs.
        uint256 squaredBackX96 = FullMath.mulDiv(sqrtPriceX96, sqrtPriceX96, 1 << 96);
        uint256 definitionX96 = FullMath.mulDiv(priced1, 1 << 96, priced0);
        uint256 squareBudget = FullMath.mulDiv(definitionX96, 2, sqrtPriceX96) + 2;
        assertApproxEqAbs(
            squaredBackX96, definitionX96, squareBudget, "sqrtPriceFromAmounts does not match its definition"
        );

        // (c) The human-readable round trip is a READABILITY check, and its
        // looseness is this test's arithmetic, not the contract's. An earlier
        // bound of "one part in 1e12" was simply what the old 30/5 fixture
        // produced; the same code lands at four parts in 1e12 at the candidate
        // parameters, so it was a magic number expiring rather than a
        // regression. Replacing it with "ten quanta" was no better - the 10 was
        // never justified either.
        //
        // The budget, one term per flooring division this test performs:
        //   priceX96            = mulDiv(sqrtP, sqrtP, 2^96)   1 ulp
        //   quotePerLaunchX96   = mulDiv(2^96, 2^96, priceX96) 1 ulp, when the
        //                         ordering requires the inversion
        //   poolPriceQ18        = mulDiv(..., scale*1e18, 2^96) 1 ulp absolute
        // A 1 ulp error in an X96 quantity is a RELATIVE error of 1/that
        // quantity, so each contributes curvePriceQ18 / (its own magnitude).
        uint256 allowed = FullMath.mulDiv(curvePriceQ18, 1, priceX96)
            + FullMath.mulDiv(curvePriceQ18, 1, quotePerLaunchX96) + 1;
        uint256 diff = poolPriceQ18 > curvePriceQ18 ? poolPriceQ18 - curvePriceQ18 : curvePriceQ18 - poolPriceQ18;
        assertLe(diff, allowed, "the round trip drifted further than this test's own flooring explains");
    }

    // ================================================================

    /// For tests whose subject IS the graduate() call: leaves the launch in the
    /// ready-but-ungraduated state, because otherwise the crossing buy has
    /// already graduated it and there is nothing left to call.
    function _launchAndFill(bool launchBelowNvdac)
        internal
        returns (PonsV2BondingCurve curve, CurbLaunchToken token)
    {
        (curve, token) = _launch(launchBelowNvdac);
        _fillWithoutGraduating(curve);
    }

    /// One real transaction through the product factory: curve, token,
    /// initialization and the permanent registry record. Nothing impersonated.
    function _launch(bool launchBelowNvdac)
        internal
        returns (PonsV2BondingCurve curve, CurbLaunchToken token)
    {
        CurbLaunchFactory.LaunchConfig memory cfg = _config(launchBelowNvdac);
        // THE SENDER IS THE CREATOR. launch() takes no creator argument, so
        // pranking as `creator` is what makes them the beneficiary - and that
        // is the product's real path now that anyone may call it.
        vm.prank(creator);
        (token, curve) = factory.launch(cfg);
    }

    /// The terms a DEPLOYMENT fixes. Everything priced lives here now rather
    /// than in a launch's calldata, which is what makes launch() safe to open.
    function _terms(IHooks hooks_, uint24 poolFee_, int24 tickSpacing_)
        internal
        view
        returns (CurbLaunchFactory.Terms memory)
    {
        return CurbLaunchFactory.Terms({
            supply: SUPPLY,
            quoteDecimals: 8,                       // NVDAc, written out rather than read back
            phantomQuote: PHANTOM_QUOTE,
            graduationThreshold: GRADUATION_THRESHOLD,
            poolFee: poolFee_,
            tickSpacing: tickSpacing_,
            hooks: hooks_,
            protocolFeeRecipient: protocolRecipient,
            maxInternalPriceImpactBps: 500,
            launchFee: 0
        });
    }

    /// What a CREATOR chooses. The signature keeps its hook and lock-duration
    /// arguments so callers read the same, but they now select a FACTORY built
    /// on those terms rather than smuggling them through a launch.
    function _config(bool launchBelowNvdac)
        internal
        returns (CurbLaunchFactory.LaunchConfig memory cfg)
    {
        cfg = CurbLaunchFactory.LaunchConfig({
            name: "Curb Launch",
            symbol: "CURBL",
            tokenUri: "ipfs://curb",
            salt: bytes32(0),
            quoteRefundTo: refundTo,
            totalTaxBps: TOTAL_TAX_BPS,
            devBuy: 0,
            creatorWallet: address(0),
            // WHAT THE HOOK SAYS NOW. A caller that read a different number
            // would be refused, which is the point of the field.
            expectedPlatformBps: hook.platformFeeBps(),
            expectedPlatformRecipient: hook.platformRecipient(),
holderShareFactory: address(0)
        });
        cfg.salt = _saltForSide(cfg, launchBelowNvdac);
    }

    /// Real buys until the curve says it is done - not a balance transfer.
    ///
    /// THE CROSSING BUY NOW GRADUATES. PonsV2BondingCurve calls
    /// factory.graduate(token) the moment a buy exhausts the allocation, and
    /// graduation is permissionless, so the launch is normally graduated by the
    /// time this returns. That is the product's real path.
    function _fillToThreshold(PonsV2BondingCurve curve) internal {
        vm.prank(NVDAC_WHALE);
        IERC20(NVDAC).transfer(trader, TRADER_FUNDING);

        vm.startPrank(trader);
        IERC20(NVDAC).approve(address(curve), type(uint256).max);
        // Oversized on purpose: the curve fills only up to its reserved
        // allocation and refunds the rest, which is its documented behaviour
        // for the last buy of a launch.
        curve.buy(TRADER_FUNDING, 0, trader);
        vm.stopPrank();

        require(curve.graduated() || curve.readyToGraduate(), "fixture did not reach the graduation threshold");
    }

    /// Fills to the threshold but leaves the launch UNGRADUATED.
    ///
    /// WHAT THIS DOES AND DOES NOT REPRODUCE. It injects a revert into the
    /// mint, so the curve's try/catch runs and the buy stands - which is the
    /// state AFTER a failed automatic attempt, and that is all. It does NOT
    /// starve the call of gas, and it says nothing about whether enough gas
    /// remains for the catch to execute when a real crossing buyer sets a tight
    /// limit. That is the 63/64 question and it is untested.
    ///
    /// Tests whose subject is the graduate() call start here, because otherwise
    /// the crossing buy has already graduated the launch.
    function _fillWithoutGraduating(PonsV2BondingCurve curve) internal {
        vm.mockCallRevert(
            address(POSM),
            abi.encodeWithSelector(IPositionManagerMinimal.modifyLiquidities.selector),
            abi.encodeWithSignature("Error(string)", "starved")
        );
        _fillToThreshold(curve);
        vm.clearMockedCalls();

        require(!curve.graduated(), "the launch graduated despite the suppressed mint");
        require(curve.readyToGraduate(), "fixture did not reach the graduation threshold");
    }

    function _ourPrice(CurbLaunchToken token, uint256 pricedQuote, uint256 pricedTokens)
        internal
        view
        returns (uint160)
    {
        (uint256 priced0, uint256 priced1) =
            address(token) < NVDAC ? (pricedTokens, pricedQuote) : (pricedQuote, pricedTokens);
        return graduator.sqrtPriceFromAmounts(priced0, priced1);
    }

    /// The lock an automatic graduation created. graduate()'s return value is
    /// not available when the curve calls it, so it is recovered from the
    /// position's owner instead.
    function _lockOf(CurbLaunchToken) internal view returns (address) {
        return IERC721(address(POSM)).ownerOf(POSM.nextTokenId() - 1);
    }



    /// TWO CONTRACTS, ONE SET OF TERMS, AND NOTHING MAKING THEM AGREE.
    ///
    /// The policy publishes the deployment's terms; the factory writes them
    /// into every launch. Four of them are constants on the policy now - the
    /// share, the buyback burn, the unused hook rate and the sweep operator -
    /// so a deployment cannot get THOSE apart. The share still exists as a
    /// separate constant on each contract, and the three real arguments can
    /// always be handed over wrong. This is where that stops.
    ///
    /// DeployCurb asserts the same before it registers anything. Both, because
    /// the script's requires only run when the script runs.
    function test_policy_agreesWithTheFactoryOnEveryTerm() public onlyFork {
        FeePolicy policy = FeePolicy(address(factory.feePolicy()));

        assertEq(
            policy.protocolFeeShareBps(), uint256(factory.PROTOCOL_FEE_SHARE_BPS()),
            "the policy and the factory disagree on the protocol's share"
        );
        assertEq(
            policy.protocolFeeRecipient(), factory.protocolFeeRecipient(),
            "the policy and the factory name different protocol fee recipients"
        );
        assertEq(
            policy.maxInternalPriceImpactBps(), uint256(factory.maxInternalPriceImpactBps()),
            "the policy and the factory disagree on the price-impact ceiling"
        );
        assertEq(address(policy.feeEscrow()), address(factory.feeEscrow()), "they point at different escrows");
        assertEq(policy.feeSweepOperator(), address(0), "this stack has a sweep operator");

        // AND THE TWO PLACES A TRADER IS CHARGED PAY THE SAME PERSON - but the
        // check that establishes it has changed shape, because the ARCHITECTURE
        // did. It used to compare two copies of one constant. Now there is one
        // settable source, the hook, and the factory reads it at launch. So
        // what is worth asserting is that a launch really does carry the hook's
        // CURRENT values - a comparison of two copies would pass trivially and
        // tell nobody anything.
        CurbLaunchFactory.LaunchConfig memory launchCfg = _config(true);
        vm.prank(creator);
        (, PonsV2BondingCurve sample) = factory.launch(launchCfg);
        assertEq(
            sample.protocolFeeRecipient(), hook.platformRecipient(),
            "a new curve does not pay the hook's current recipient"
        );
        assertEq(
            uint256(sample.feeBps()), uint256(hook.platformFeeBps()),
            "a new curve does not charge the hook's current rate"
        );
    }

    // ================================================================
    // THE FEES COME OUT - curve, sweep, escrow, claim
    // ================================================================

    /// PRE_MAINNET A2 WAS THIS: the escrow took the tokens and had no way to
    /// give them back, so every fee a curve swept was locked in it. This is the
    /// whole path, end to end, with the assertions on REAL NVDAc BALANCES.
    ///
    /// The escrow's own ledger is asserted too, but only as a cross-check: a
    /// ledger that agrees with itself is not money arriving, and the balances
    /// below are what "the fees are withdrawable" has to mean.
    function test_escrow_curveFeesAreSweptAndThenActuallyWithdrawn() public onlyFork {
        CurbLaunchFactory.LaunchConfig memory cfg = _config(true);
        vm.prank(creator);
        (, PonsV2BondingCurve curve) = factory.launch(cfg);

        uint256 spend = 20e8;
        vm.prank(NVDAC_WHALE);
        IERC20(NVDAC).transfer(trader, spend);
        vm.startPrank(trader);
        IERC20(NVDAC).approve(address(curve), spend);
        curve.buy(spend, 0, trader);
        vm.stopPrank();

        (uint256 expectedPlatform, uint256 expectedCreator) = _taxLegs(spend, TOTAL_TAX_BPS);
        assertGt(expectedPlatform, 0, "this fixture charges nothing");

        // ---- the sweep. THE CREATOR'S OWN, with no operator anywhere.
        address nobody = makeAddr("not the creator");
        vm.prank(nobody);
        vm.expectRevert(PonsV2BondingCurve.NotFeeSweepOperator.selector);
        curve.sweepFees(0);

        vm.prank(creator);
        curve.sweepFees(0);

        // ---- in the escrow, against the arithmetic
        assertEq(
            escrowMock.balanceOfToken(protocolRecipient, NVDAC), expectedPlatform,
            "the platform's escrow balance is not 50 bps of the buy"
        );
        assertEq(
            escrowMock.balanceOfToken(creator, NVDAC), expectedCreator,
            "the creator's escrow balance is not the rest of the tax"
        );
        assertEq(
            IERC20(NVDAC).balanceOf(address(escrowMock)), expectedPlatform + expectedCreator,
            "the escrow holds something other than the sum of the two balances"
        );

        // ---- AND OUT AGAIN, each by the person it belongs to
        uint256 creatorNvdacBefore = IERC20(NVDAC).balanceOf(creator);
        uint256 platformNvdacBefore = IERC20(NVDAC).balanceOf(protocolRecipient);

        vm.prank(creator);
        escrowMock.claimToken(NVDAC);
        vm.prank(protocolRecipient);
        escrowMock.claimToken(NVDAC);

        assertEq(
            IERC20(NVDAC).balanceOf(creator) - creatorNvdacBefore, expectedCreator,
            "the creator's NVDAc did not arrive"
        );
        assertEq(
            IERC20(NVDAC).balanceOf(protocolRecipient) - platformNvdacBefore, expectedPlatform,
            "the platform's NVDAc did not arrive"
        );
        assertEq(escrowMock.balanceOfToken(creator, NVDAC), 0, "the creator's balance survived the claim");
        assertEq(escrowMock.balanceOfToken(protocolRecipient, NVDAC), 0, "the platform's balance survived");
        assertEq(IERC20(NVDAC).balanceOf(address(escrowMock)), 0, "the escrow kept something");
    }

    /// GRADUATION SWEEPS ON ITS WAY THROUGH, and what it sweeps is claimable
    /// too. This is the path a launch takes when nobody ever calls sweepFees.
    function test_escrow_whatGraduationSweepsIsAlsoClaimable() public onlyFork {
        (PonsV2BondingCurve curve,) = _launch(true);
        _fillToThreshold(curve);
        require(curve.graduated(), "the fixture did not graduate");

        uint256 creatorOwed = escrowMock.balanceOfToken(creator, NVDAC);
        uint256 platformOwed = escrowMock.balanceOfToken(protocolRecipient, NVDAC);
        assertGt(creatorOwed, 0, "graduation swept no creator fee");
        assertGt(platformOwed, 0, "graduation swept no platform fee");

        uint256 creatorBefore = IERC20(NVDAC).balanceOf(creator);
        uint256 platformBefore = IERC20(NVDAC).balanceOf(protocolRecipient);

        vm.prank(creator);
        escrowMock.claimToken(NVDAC);
        vm.prank(protocolRecipient);
        escrowMock.claimToken(NVDAC);

        assertEq(IERC20(NVDAC).balanceOf(creator) - creatorBefore, creatorOwed, "the creator's NVDAc did not arrive");
        assertEq(
            IERC20(NVDAC).balanceOf(protocolRecipient) - platformBefore, platformOwed,
            "the platform's NVDAc did not arrive"
        );
    }

    // ================================================================
    // THE POOL CHARGES THE LAUNCH'S OWN TAX - end to end, through the
    // official router, against a pool a real graduation created
    // ================================================================
    //
    // NOTHING BELOW OPENS A POOL OR BINDS A RATE BY HAND. Each of these runs a
    // launch from creation, through the curve, across the threshold and into
    // the pool the graduator actually made - and then trades it the way our own
    // front end does, through UniversalRouter. A fixture that opened the pool
    // itself would be testing the hook; these test the product.

    IUniversalRouter internal constant ROUTER = IUniversalRouter(0x6fF5693b99212Da76ad316178A184AB56D299b43);
    IPermit2Approve internal constant PERMIT2_APPROVE = IPermit2Approve(0x000000000022D473030F116dDEE9F6B43aC78BA3);
    uint8 internal constant V4_SWAP_CMD = 0x10;

    /// A BUY IS CHARGED ON THE NVDAc THE TRADER SENT, and the pool receives the
    /// rest. Both legs land in NVDAc, and the memecoin balances stay at zero.
    function test_poolTax_aBuyIsChargedOnTheNvdacInput() public onlyFork {
        (PoolKey memory key, CurbLaunchToken token, FeeHook poolHook,) = _graduatedAt(TOTAL_TAX_BPS);
        uint128 amountIn = 1e7; // 0.1 NVDAc

        (uint256 expectedPlatform, uint256 expectedCreator) = _taxLegs(amountIn, TOTAL_TAX_BPS);

        uint256 platformBefore = IERC20(NVDAC).balanceOf(protocolRecipient);
        uint256 creatorBefore = IERC20(NVDAC).balanceOf(creator);
        uint256 poolBefore = IERC20(NVDAC).balanceOf(address(POOL_MANAGER));

        uint256 got = _routerSwap(key, NVDAC, address(token), amountIn, 1);

        assertGt(got, 0, "the buy delivered nothing");
        assertEq(
            IERC20(NVDAC).balanceOf(protocolRecipient) - platformBefore, expectedPlatform,
            "the platform's leg is not 50 bps of the NVDAc sent"
        );
        assertEq(
            IERC20(NVDAC).balanceOf(creator) - creatorBefore, expectedCreator,
            "the creator's leg is not the rest of the tax"
        );
        assertEq(
            IERC20(NVDAC).balanceOf(address(POOL_MANAGER)) - poolBefore,
            amountIn - expectedPlatform - expectedCreator,
            "the pool did not receive the input minus the tax"
        );
        assertEq(token.balanceOf(protocolRecipient), 0, "the platform was paid in the memecoin");
        assertEq(poolHook.collected(NVDAC), expectedPlatform + expectedCreator, "the hook's accounting disagrees");
    }

    /// A SELL IS CHARGED ON THE GROSS NVDAc THE SWAP PRODUCED, and the trader
    /// keeps the remainder.
    function test_poolTax_aSellIsChargedOnTheGrossNvdacOutput() public onlyFork {
        (PoolKey memory key, CurbLaunchToken token,,) = _graduatedAt(TOTAL_TAX_BPS);

        uint128 bought = uint128(_routerSwap(key, NVDAC, address(token), 1e7, 1));
        uint128 toSell = bought / 2;

        uint256 platformBefore = IERC20(NVDAC).balanceOf(protocolRecipient);
        uint256 creatorBefore = IERC20(NVDAC).balanceOf(creator);
        uint256 poolBefore = IERC20(NVDAC).balanceOf(address(POOL_MANAGER));

        uint256 net = _routerSwap(key, address(token), NVDAC, toSell, 1);

        uint256 gross = poolBefore - IERC20(NVDAC).balanceOf(address(POOL_MANAGER));
        (uint256 expectedPlatform, uint256 expectedCreator) = _taxLegs(gross, TOTAL_TAX_BPS);

        assertEq(
            IERC20(NVDAC).balanceOf(protocolRecipient) - platformBefore, expectedPlatform,
            "the platform's leg is not 50 bps of the gross output"
        );
        assertEq(
            IERC20(NVDAC).balanceOf(creator) - creatorBefore, expectedCreator,
            "the creator's leg is not the rest of the tax"
        );
        assertEq(net, gross - expectedPlatform - expectedCreator, "the trader did not keep the remainder");
    }

    /// THE DECISION, ON THE REAL THING. Three launches at 1%, 3% and 5%, the
    /// same NVDAc base on each, both directions: the platform is paid the same
    /// integer every time and only the creator's leg moves.
    function test_poolTax_thePlatformsShareIsTheSameAtEveryTax() public onlyFork {
        uint16[3] memory taxes = [registry.MIN_TOTAL_TAX_BPS(), 300, registry.MAX_TOTAL_TAX_BPS()];
        uint128 amountIn = 1e7;

        uint256[3] memory buyPlatform;
        uint256[3] memory buyCreator;
        uint256[3] memory sellPlatform;
        uint256[3] memory sellGross;

        for (uint256 i = 0; i < 3; i++) {
            (PoolKey memory key, CurbLaunchToken token,,) = _graduatedAt(taxes[i]);

            uint256 pBefore = IERC20(NVDAC).balanceOf(protocolRecipient);
            uint256 cBefore = IERC20(NVDAC).balanceOf(creator);
            uint128 bought = uint128(_routerSwap(key, NVDAC, address(token), amountIn, 1));
            buyPlatform[i] = IERC20(NVDAC).balanceOf(protocolRecipient) - pBefore;
            buyCreator[i] = IERC20(NVDAC).balanceOf(creator) - cBefore;

            pBefore = IERC20(NVDAC).balanceOf(protocolRecipient);
            uint256 poolBefore = IERC20(NVDAC).balanceOf(address(POOL_MANAGER));
            _routerSwap(key, address(token), NVDAC, bought / 2, 1);
            sellPlatform[i] = IERC20(NVDAC).balanceOf(protocolRecipient) - pBefore;
            sellGross[i] = poolBefore - IERC20(NVDAC).balanceOf(address(POOL_MANAGER));
        }

        // THE BUY BASE IS THE INPUT, identical by construction.
        assertEq(buyPlatform[0], (uint256(amountIn) * PLATFORM_FEE_BPS) / 10_000, "not a fixed 50 bps");
        assertEq(buyPlatform[1], buyPlatform[0], "the platform's take moved between 1% and 3%");
        assertEq(buyPlatform[2], buyPlatform[0], "the platform's take moved between 1% and 5%");
        assertGt(buyCreator[1], buyCreator[0], "raising the tax did not raise the creator's leg");
        assertGt(buyCreator[2], buyCreator[1], "raising the tax did not raise the creator's leg");

        // THE SELL BASE IS THE GROSS OUTPUT, so the three are only comparable
        // if the pools were - and they are not exactly: a bigger tax means a
        // smaller buy reached the pool, so the sell starts from a slightly
        // different price. Each is therefore checked against ITS OWN base
        // rather than against the others.
        for (uint256 i = 0; i < 3; i++) {
            assertEq(
                sellPlatform[i], (sellGross[i] * PLATFORM_FEE_BPS) / 10_000,
                "the platform's sell leg is not 50 bps of that trade's own gross"
            );
        }
    }

    /// A MINIMUM OUTPUT THAT CANNOT BE MET TAKES EVERYTHING WITH IT - both
    /// recipients' payments and the hook's own accounting. They were never
    /// anywhere else to be stranded.
    function test_poolTax_aFailedMinimumUndoesBothFeesAndTheAccounting() public onlyFork {
        (PoolKey memory key, CurbLaunchToken token, FeeHook poolHook,) = _graduatedAt(TOTAL_TAX_BPS);

        uint256 platformBefore = IERC20(NVDAC).balanceOf(protocolRecipient);
        uint256 creatorBefore = IERC20(NVDAC).balanceOf(creator);
        uint256 collectedBefore = poolHook.collected(NVDAC);
        uint256 traderBefore = IERC20(NVDAC).balanceOf(trader);

        // APPROVE FIRST, EXPECT SECOND. See _approveRouter.
        _approveRouter(NVDAC, 1e7);
        vm.expectRevert();
        _executeSwap(key, NVDAC, address(token), 1e7, type(uint128).max);

        assertEq(IERC20(NVDAC).balanceOf(protocolRecipient), platformBefore, "the platform kept a fee from a failed swap");
        assertEq(IERC20(NVDAC).balanceOf(creator), creatorBefore, "the creator kept a fee from a failed swap");
        assertEq(poolHook.collected(NVDAC), collectedBefore, "the hook's accounting survived a failed swap");
        assertEq(IERC20(NVDAC).balanceOf(trader), traderBefore, "the trader paid for a swap that did not happen");

        // AND THE POOL STILL WORKS AFTERWARDS. A revert that left anything
        // half-done would show up here.
        assertGt(_routerSwap(key, NVDAC, address(token), 1e7, 1), 0, "the pool stopped working after a failed swap");
    }

    /// A GRADUATION THAT FAILS AFTER THE POOL IS BOUND UNBINDS IT AGAIN, and
    /// the same launch completes later. The binding is storage in the hook, so
    /// this is the same question as the reserves and the burn: does the whole
    /// attempt come back if any step of it fails?
    function test_poolTax_aFailedGraduationUnbindsTheHookToo() public onlyFork {
        (PonsV2BondingCurve curve, CurbLaunchToken token) = _launch(true);

        // Fill to the threshold with graduation suppressed, so the launch sits
        // ready and the completing call can be watched on its own.
        vm.mockCallRevert(
            address(POSM),
            abi.encodeWithSelector(IPositionManagerMinimal.modifyLiquidities.selector),
            abi.encodeWithSignature("Error(string)", "not yet")
        );
        _fillToThreshold(curve);
        vm.clearMockedCalls();
        require(!curve.graduated() && curve.readyToGraduate(), "fixture did not reach the waiting state");

        PoolKey memory key = _keyFor(token, IHooks(address(hook)));

        // The mint fails, which is AFTER the pool is opened and bound.
        vm.mockCallRevert(
            address(POSM),
            abi.encodeWithSelector(IPositionManagerMinimal.modifyLiquidities.selector),
            abi.encodeWithSignature("Error(string)", "mint refused")
        );
        vm.prank(attacker);
        vm.expectRevert();
        factory.graduate(address(token));
        vm.clearMockedCalls();

        // NOT CONFIGURED. If the write had survived the revert, a later
        // attempt would meet a pool already bound - and the whole retry story
        // would depend on that binding happening to be identical.
        assertFalse(hook.feeOf(key).configured, "the hook kept a binding from a failed graduation");

        // AND THE SAME LAUNCH COMPLETES, on the same record, and the pool it
        // makes is bound and charges.
        vm.prank(attacker);
        factory.graduate(address(token));
        assertTrue(curve.graduated(), "the launch did not graduate on the retry");

        FeeHook.LaunchFee memory cfg = hook.feeOf(key);
        assertTrue(cfg.configured, "the retry did not bind the pool");
        assertEq(cfg.totalTaxBps, TOTAL_TAX_BPS, "the retry bound a different tax");
        assertEq(cfg.creator, creator, "the retry bound a different creator");
    }

    /// EXACT-OUTPUT IS STILL REFUSED, THROUGH THE OFFICIAL ROUTER, against a
    /// real pool - and for the hook's reason, not for any reason.
    ///
    /// This used to swap through a harness straight into the pool manager and
    /// accept any revert at all. With the hook's guard deleted, the fee
    /// arithmetic then overflowed on the negated amount - also a revert - and
    /// the test stayed green with the thing its name promises gone.
    function test_poolTax_exactOutputIsRefusedThroughTheRouter() public onlyFork {
        (PoolKey memory key, CurbLaunchToken token,,) = _graduatedAt(TOTAL_TAX_BPS);
        _approveRouter(NVDAC, 1e7);

        bytes memory actions =
            abi.encodePacked(uint8(Actions.SWAP_EXACT_OUT_SINGLE), uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL));
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            ExactOutputSingleLegacy({
                poolKey: key,
                zeroForOne: Currency.unwrap(key.currency0) == NVDAC,
                amountOut: 1e18,
                amountInMaximum: 1e7,
                hookData: ""
            })
        );
        params[1] = abi.encode(Currency.wrap(NVDAC), uint256(1e7));
        params[2] = abi.encode(Currency.wrap(address(token)), uint256(1e18));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);

        vm.prank(trader);
        try ROUTER.execute(abi.encodePacked(V4_SWAP_CMD), inputs, block.timestamp + 60) {
            assertTrue(false, "an exact-output swap went through the router");
        } catch (bytes memory err) {
            assertTrue(
                _mentions(err, FeeHook.ExactOutputNotSupported.selector),
                "the router refused the exact-output swap, but not for the hook's reason"
            );
        }
    }

    // ---------------- helpers for the pool-tax tests ----------------

    /// A launch at `tax`, taken all the way to a graduated pool by the product
    /// itself. Returns that pool's key and the stack that made it.
    function _graduatedAt(uint16 tax)
        internal
        returns (PoolKey memory key, CurbLaunchToken token, FeeHook poolHook, PonsV2BondingCurve curve)
    {
        return _graduatedAtSeeded(tax, bytes32(0));
    }

    /// THE SAME FIXTURE, WITH A SECOND ADDRESS AVAILABLE. The salt is mined
    /// from the config, so two calls with the same one ask the factory for the
    /// same token. A test that needs two pools seeds the second.
    function _graduatedAtSeeded(uint16 tax, bytes32 seed)
        internal
        returns (PoolKey memory key, CurbLaunchToken token, FeeHook poolHook, PonsV2BondingCurve curve)
    {
        CurbLaunchFactory.LaunchConfig memory cfg = _config(true);
        cfg.totalTaxBps = tax;
        if (seed != bytes32(0)) cfg.salt = seed;
        cfg.salt = _saltForSide(cfg, true);

        vm.prank(creator);
        (token, curve) = factory.launch(cfg);
        _fillToThreshold(curve);
        require(curve.graduated(), "the launch did not graduate");

        poolHook = hook;
        key = _keyFor(token, IHooks(address(hook)));

        // Fund the trader for whatever the test does next.
        vm.prank(NVDAC_WHALE);
        IERC20(NVDAC).transfer(trader, 5e7);
    }

    function _taxLegs(uint256 base, uint16 tax) internal pure returns (uint256 platformCut, uint256 creatorCut) {
        platformCut = (base * PLATFORM_FEE_BPS) / 10_000;
        creatorCut = (base * (tax - PLATFORM_FEE_BPS)) / 10_000;
    }

    /// Through the OFFICIAL router, with the real two-step Permit2 flow - the
    /// same path web/app.js takes.
    function _routerSwap(PoolKey memory key, address tokenIn, address tokenOut, uint128 amountIn, uint128 minOut)
        internal
        returns (uint256)
    {
        _approveRouter(tokenIn, amountIn);
        uint256 outBefore = IERC20(tokenOut).balanceOf(trader);
        _executeSwap(key, tokenIn, tokenOut, amountIn, minOut);
        return IERC20(tokenOut).balanceOf(trader) - outBefore;
    }

    /// SPLIT FROM THE SWAP ON PURPOSE. A test that expects the swap to revert
    /// must not have two approvals standing between expectRevert and the call
    /// it is about - expectRevert would match the first of them, which succeeds.
    function _approveRouter(address tokenIn, uint128 amountIn) internal {
        vm.startPrank(trader);
        IERC20(tokenIn).approve(address(PERMIT2), type(uint256).max);
        PERMIT2_APPROVE.approve(tokenIn, address(ROUTER), amountIn, uint48(block.timestamp + 3600));
        vm.stopPrank();
    }

    function _executeSwap(PoolKey memory key, address tokenIn, address tokenOut, uint128 amountIn, uint128 minOut)
        internal
    {
        bytes memory actions =
            abi.encodePacked(uint8(Actions.SWAP_EXACT_IN_SINGLE), uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL));
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            ExactInputSingleLegacy({
                poolKey: key,
                zeroForOne: tokenIn == Currency.unwrap(key.currency0),
                amountIn: amountIn,
                amountOutMinimum: minOut,
                hookData: ""
            })
        );
        params[1] = abi.encode(Currency.wrap(tokenIn), amountIn);
        params[2] = abi.encode(Currency.wrap(tokenOut), minOut);

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);

        vm.prank(trader);
        ROUTER.execute(abi.encodePacked(V4_SWAP_CMD), inputs, block.timestamp + 60);
    }

    function _keyFor(CurbLaunchToken token, IHooks hooks) internal pure returns (PoolKey memory) {
        return _keyForTier(token, hooks, FEE, TICK_SPACING);
    }

    /// A KEY IS ONLY VALID FOR THE STACK THAT MINTED IT. The fee and spacing
    /// are part of the pool id, so a key built with 3000 against a pool opened
    /// at 500 addresses a pool that does not exist - and the swap fails in a
    /// way that looks like the pool being broken.
    function _keyForTier(CurbLaunchToken token, IHooks hooks, uint24 fee_, int24 spacing_)
        internal
        pure
        returns (PoolKey memory)
    {
        bool launchIsCurrency0 = address(token) < NVDAC;
        return PoolKey({
            currency0: Currency.wrap(launchIsCurrency0 ? address(token) : NVDAC),
            currency1: Currency.wrap(launchIsCurrency0 ? NVDAC : address(token)),
            fee: fee_,
            tickSpacing: spacing_,
            hooks: hooks
        });
    }

    function _deployRefusingHook() internal returns (LiquidityRefusingHook) {
        (address hookAddress, bytes32 salt) = HookMiner.find(
            address(this), uint160(Hooks.BEFORE_ADD_LIQUIDITY_FLAG), type(LiquidityRefusingHook).creationCode, ""
        );
        LiquidityRefusingHook refusing = new LiquidityRefusingHook{salt: salt}();
        require(address(refusing) == hookAddress, "refusing hook did not deploy to the mined address");
        return refusing;
    }

    /// Ordering is an accident of address in production. Here it has to be
    /// both ways on purpose, so the salt the factory is given is searched for
    /// the side we want. The curve's address is predicted first, because the
    /// token's constructor takes it.
    /// A COMPLETE, INDEPENDENT STACK ON A GIVEN CURVE SHAPE.
    ///
    /// The phantom reserve and the threshold used to be launch parameters, and
    /// a test that swept them just filled in a different struct. They are
    /// factory terms now - a caller cannot choose the curve they are buying
    /// into - so sweeping them means building a factory per row, with its own
    /// registry, graduator and hook mined for that graduator.
    function _stackOnShape(uint256 phantomQuote_, uint256 threshold_)
        internal
        returns (CurbLaunchFactory fac2, FeeHook hook2)
    {
        return _stackOnShapeTier(phantomQuote_, threshold_, FEE, TICK_SPACING);
    }

    /// THE SAME STACK WITH THE POOL'S FEE TIER AS AN ARGUMENT.
    ///
    /// The tier is a factory immutable, so comparing 0.05% against 0.30% means
    /// deploying two stacks - there is no setter, and that is the point. It is
    /// a deployment decision, not a dial.
    function _stackOnShapeTier(uint256 phantomQuote_, uint256 threshold_, uint24 fee_, int24 spacing_)
        internal
        returns (CurbLaunchFactory fac2, FeeHook hook2)
    {
        LaunchRegistry reg2 = new LaunchRegistry(address(this));
        Graduator grad2 = new Graduator(POOL_MANAGER, IPositionManagerMinimal(address(POSM)), PERMIT2, reg2, _catalog());
        hook2 = _mineHook(address(grad2), reg2);
        fac2 = new CurbLaunchFactory(
            reg2,
            grad2,
            NVDAC,
            feePolicy,
            feeEscrow,
            buybackVault,
            CurbLaunchFactory.Terms({
                supply: SUPPLY,
                quoteDecimals: 8,                   // NVDAc
                phantomQuote: phantomQuote_,
                graduationThreshold: threshold_,
                poolFee: fee_,
                tickSpacing: spacing_,
                hooks: IHooks(address(hook2)),
                protocolFeeRecipient: protocolRecipient,
                maxInternalPriceImpactBps: 500,
            launchFee: 0
            })
        );
        reg2.wire(address(fac2), address(hook2));
    }

    /// A whole stack whose registry REQUIRES a proper hook of its own, but
    /// whose factory was BUILT on `factoryHook`. The only way to reach the
    /// registry's hook check now that the hook is not a launch parameter.
    ///
    /// The wired hook has to be mined for THIS stack's graduator: wire() checks
    /// that too, and being refused there would prove something else entirely.
    function _stackWiredAgainst(IHooks factoryHook)
        internal
        returns (CurbLaunchFactory fac2, FeeHook wiredHook)
    {
        LaunchRegistry reg2 = new LaunchRegistry(address(this));
        Graduator grad2 = new Graduator(POOL_MANAGER, IPositionManagerMinimal(address(POSM)), PERMIT2, reg2, _catalog());
        wiredHook = _mineHook(address(grad2), reg2);
        fac2 = new CurbLaunchFactory(
            reg2, grad2, NVDAC, feePolicy, feeEscrow, buybackVault,
            _terms(factoryHook, FEE, TICK_SPACING)
        );
        reg2.wire(address(fac2), address(wiredHook));
    }

    function _configFor(CurbLaunchFactory fac, bool launchBelowNvdac)
        internal
        returns (CurbLaunchFactory.LaunchConfig memory cfg)
    {
        cfg = _config(launchBelowNvdac);
        cfg.salt = _saltForSideOf(fac, cfg, launchBelowNvdac);
    }

    /// One launch at `tax`, one real buy of `spend` NVDAc against it, a real
    /// sweep, and WHAT EACH SIDE WAS ACTUALLY PAID - read out of the escrow by
    /// recipient, not out of the curve's pending balances.
    ///
    /// THE PENDING BALANCES WOULD HAVE BEEN THE WRONG THING TO READ, and a
    /// mutation run is what showed it: quoteFeeBalance is the base fee BEFORE
    /// the protocol/creator split, so setting the protocol's share to 2000 left
    /// it untouched and the test stayed green while the platform's actual take
    /// fell by four fifths. The split happens at the sweep; so the sweep is
    /// where the measurement has to be.
    function _feesAfterABuyAtTax(uint16 tax, uint256 spend)
        internal
        returns (uint256 protocolPaid, uint256 creatorPaid)
    {
        CurbLaunchFactory.LaunchConfig memory cfg = _config(true);
        cfg.totalTaxBps = tax;
        vm.prank(creator);
        (, PonsV2BondingCurve curve) = factory.launch(cfg);

        vm.prank(NVDAC_WHALE);
        IERC20(NVDAC).transfer(trader, spend);
        vm.startPrank(trader);
        IERC20(NVDAC).approve(address(curve), spend);
        curve.buy(spend, 0, trader);
        vm.stopPrank();

        uint256 protocolBefore = escrowMock.balanceOfToken(protocolRecipient, NVDAC);
        uint256 creatorBefore = escrowMock.balanceOfToken(creator, NVDAC);

        // The creator may sweep their own launch; this one is theirs.
        vm.prank(creator);
        curve.sweepFees(0);

        return (
            escrowMock.balanceOfToken(protocolRecipient, NVDAC) - protocolBefore,
            escrowMock.balanceOfToken(creator, NVDAC) - creatorBefore
        );
    }

    function _saltForSide(CurbLaunchFactory.LaunchConfig memory cfg, bool wantBelowNvdac)
        internal
        returns (bytes32)
    {
        return _saltForSideOf(factory, cfg, wantBelowNvdac);
    }

    function _saltForSideOf(CurbLaunchFactory fac, CurbLaunchFactory.LaunchConfig memory cfg, bool wantBelowNvdac)
        internal
        returns (bytes32)
    {
        // THIS HELPER MAKES AN EXTERNAL CALL - fac.supply(), below - AND THAT
        // CONSUMES A PRANK. Never call it from inside a launch argument:
        //
        //     vm.prank(creator);
        //     factory.launch(_config(true));   // launch() runs as the TEST
        //
        // The argument is evaluated first, supply() eats the prank, and the
        // launch is created by whoever was going to call it anyway. Twenty-four
        // sites in this file did that, and only E-12 - the one test that ever
        // asked who the beneficiary was - noticed. Hoist the config to its own
        // line and prank immediately before the launch.
        //
        // The factory creates the curve with CREATE at its CURRENT nonce, then
        // the token with CREATE2. Predicting the curve one too far put the
        // token on whichever side chance allowed.
        address predictedCurve = vm.computeCreateAddress(address(fac), vm.getNonce(address(fac)));

        bytes memory initCode = abi.encodePacked(
            type(CurbLaunchToken).creationCode,
            // The supply is the FACTORY'S now, not the config's - it is one of
            // the terms a caller can no longer choose.
            abi.encode(cfg.name, cfg.symbol, cfg.tokenUri, predictedCurve, fac.supply())
        );
        bytes32 initCodeHash = keccak256(initCode);

        for (uint256 i = 0; i < 4096; i++) {
            bytes32 salt = keccak256(abi.encodePacked(saltCounter, i));
            address predicted = address(
                uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(fac), salt, initCodeHash))))
            );
            if ((predicted < NVDAC) == wantBelowNvdac) {
                saltCounter++;
                return salt;
            }
        }
        revert("no salt put the launch token on the requested side of NVDAc");
    }

    // ================================================================
    // C2  A MASS SELL - EVERYBODY LEAVING, ONE AFTER ANOTHER
    // ================================================================
    //
    // THE CRITERIA WERE FIXED BEFORE ANY OF THIS WAS MEASURED, and they are
    // asserted here rather than printed, so a run that breaks one FAILS:
    //   S1  the accounting does not corrupt - after every sale the curve's
    //       real NVDAc balance is exactly the quote it says it is tracking,
    //       and trackedTokens is exactly the token balance it holds
    //   S2  what is reported is what is received - the seller's real NVDAc
    //       balance rises by exactly the quoteOut sell() returned
    //   S3  the next seller can still leave - no sale in the queue reverts
    //   S4  the price falls and stays positive - never rises, never zero
    //   S5  the slippage bound holds - a sale asking for more than the curve
    //       will pay REVERTS, it does not part-fill and pay less
    //
    // WHAT IS MEASURED AND IS NOT A CRITERION: each seller's net NVDAc, the
    // price before and after, and what is left at the end. Those are numbers
    // for the record; no threshold is asserted on them, because none has been
    // chosen - D4 is still unset.
    //
    // THE SALES ARE CONSECUTIVE. Each one starts from the state the one before
    // it left behind. That is the whole point: five independent sales, each
    // starting from the launch price, would be a different measurement wearing
    // this one's name.
    //
    // ON THE CURVE, BELOW THE THRESHOLD. sell() refuses once readyToGraduate()
    // is true, so a curve filled to the threshold has no sellers at all - that
    // case is already recorded elsewhere in this file. Here the buyers stop
    // short of it, and the question is what happens when they all turn round.

    /// The NVDAc/WETH v3 pool on Base at the pinned block - the same one
    /// B20EthRoute's route uses, and the only tier with liquidity.
    address internal constant V3_NVDAC_WETH = 0x8e740D5Fa742B763cD82159894b9919eD57E4f70;

    uint256 internal constant MS_PHANTOM = 60e8;
    uint256 internal constant MS_THRESHOLD = 60e8;
    uint256 internal constant MS_SELLERS = 5;
    /// 10 NVDAc each, so the five together stay under the 60 threshold and
    /// selling never locks on the way in.
    uint256 internal constant MS_EACH = 10e8;

    function test_massSell_onTheCurve_tax100() public onlyFork {
        _massSellOnCurve(100);
    }

    function test_massSell_onTheCurve_tax300() public onlyFork {
        _massSellOnCurve(300);
    }

    function test_massSell_onTheCurve_tax500() public onlyFork {
        _massSellOnCurve(500);
    }

    function _massSellOnCurve(uint16 tax) internal {
        (CurbLaunchFactory fac,) = _stackOnShapeTier(MS_PHANTOM, MS_THRESHOLD, 500, 10);

        CurbLaunchFactory.LaunchConfig memory cfg = _config(true);
        cfg.totalTaxBps = tax;
        cfg.quoteRefundTo = makeAddr(string.concat("ms-sink-", vm.toString(uint256(tax))));
        cfg.salt = _saltForSideOf(fac, cfg, true);

        vm.prank(creator);
        (CurbLaunchToken token, PonsV2BondingCurve curve) = fac.launch(cfg);

        emit log_string("");
        emit log_string(
            string.concat(
                "=== MASS SELL ON THE CURVE, tax ", vm.toString(uint256(tax) / 100), "% - 60/60, 0.05% tier ==="
            )
        );

        // ---- everybody buys in, one after another ----------------------
        address[] memory sellers = new address[](MS_SELLERS);
        uint256[] memory held = new uint256[](MS_SELLERS);
        MsBooks memory books;
        for (uint256 i = 0; i < MS_SELLERS; i++) {
            sellers[i] = makeAddr(string.concat("ms-", vm.toString(uint256(tax)), "-", vm.toString(i)));
            vm.prank(NVDAC_WHALE);
            IERC20(NVDAC).transfer(sellers[i], MS_EACH);
            vm.startPrank(sellers[i]);
            IERC20(NVDAC).approve(address(curve), type(uint256).max);
            uint256 walletBefore = IERC20(NVDAC).balanceOf(sellers[i]);
            held[i] = curve.buy(MS_EACH, 0, sellers[i]);
            vm.stopPrank();
            // The whole offer has to be taken, or the books below would be
            // tracking an amount the curve never received.
            assertEq(
                walletBefore - IERC20(NVDAC).balanceOf(sellers[i]),
                MS_EACH,
                "the buy was refunded in part; the books assume the full offer was spent"
            );
            books.real += MS_EACH;
            books.platform += (MS_EACH * curve.feeBps()) / 10_000;
            books.creator += (MS_EACH * curve.creatorTaxBps()) / 10_000;
            _msAssertBooks(curve, token, books, string.concat("buy ", vm.toString(i)));
        }
        require(!curve.readyToGraduate(), "the buy-in reached the threshold; selling would be shut");

        uint256 midBefore = _msMid(curve);
        emit log_string(
            string.concat(
                "  after the buy-in: mid ",
                vm.toString(midBefore),
                " (quote per token, 1e36), curve holds ",
                _nvdac(IERC20(NVDAC).balanceOf(address(curve))),
                " NVDAc"
            )
        );

        // ---- then everybody leaves, in the same order ------------------
        uint256 lastMid = midBefore;
        uint256 paidOut;
        for (uint256 i = 0; i < MS_SELLERS; i++) {
            uint256 before = IERC20(NVDAC).balanceOf(sellers[i]);
            // Worked out BEFORE the sale, from the reserves it will price
            // against, so the books are a prediction the contract then has to
            // match - not a description of whatever it did.
            (uint256 net, uint256 legFee, uint256 legTax) = _msLegs(curve, held[i]);

            vm.startPrank(sellers[i]);
            token.approve(address(curve), type(uint256).max);
            // S3 IS THIS LINE. A revert here fails the test.
            uint256 reported = curve.sell(held[i], 0, sellers[i]);
            vm.stopPrank();

            uint256 arrived = IERC20(NVDAC).balanceOf(sellers[i]) - before;
            assertEq(arrived, reported, "S2: the seller did not receive what sell() reported");
            assertEq(arrived, net, "S2: the sale paid something other than the three legs predicted");
            paidOut += arrived;

            books.real -= net;
            books.platform += legFee;
            books.creator += legTax;
            _msAssertBooks(curve, token, books, string.concat("sale ", vm.toString(i)));

            // EXECUTION COST, against the mid THIS sale started from. It is a
            // different quantity from "what they got back for what they put
            // in": that ratio is profit and loss, and it carries the price
            // move since they bought. This is the cost of the transaction
            // itself - fees, tax, and the sale walking down its own curve.
            uint256 expected = (held[i] * lastMid) / 1e36;
            uint256 costBps = expected == 0 ? 0 : ((expected - arrived) * 10_000) / expected;

            uint256 mid = _msMid(curve);
            assertLt(mid, lastMid, "S4: the price did not fall on a sale");
            assertGt(mid, 0, "S4: the price reached zero");
            lastMid = mid;

            emit log_string(
                string.concat(
                    "  seller ",
                    vm.toString(i),
                    " sold ",
                    vm.toString(held[i] / 1e18),
                    "e18 tokens: took ",
                    _nvdac(arrived),
                    " NVDAc, worth ",
                    _nvdac(expected),
                    " at the mid it started from -> execution cost ",
                    vm.toString(costBps),
                    " bps.  (P&L against the ",
                    _nvdac(MS_EACH),
                    " put in is a separate thing.)  mid now ",
                    vm.toString(mid)
                )
            );
        }

        // ---- WHERE THE FIVE SALES LEFT IT, READ BEFORE ANYTHING ELSE ---
        //
        // This used to be read after S5's late buyer had put another 10 NVDAc
        // in, so "50 in, 49 out" and "1.09 waiting in the fee buckets" were
        // describing two different sets of transactions and were printed as
        // though they were one. The end state belongs to the five sales.
        (uint256 qr, uint256 tr) = curve.getReserves();
        uint256 realAtEnd = IERC20(NVDAC).balanceOf(address(curve));
        uint256 owedAtEnd = curve.quoteFeeBalance() + curve.creatorTaxBalance();

        emit log_string(
            string.concat(
                "  five in, five out: put in ",
                _nvdac(MS_EACH * MS_SELLERS),
                " NVDAc, took out ",
                _nvdac(paidOut),
                " NVDAc"
            )
        );
        emit log_string(
            string.concat(
                "  left behind: quote reserve ",
                _nvdac(qr),
                " of which ",
                _nvdac(MS_PHANTOM),
                " is phantom (see the raw figure below - it is not exactly empty), token reserve ",
                vm.toString(tr / 1e18),
                "e18, the curve's real NVDAc ",
                _nvdac(realAtEnd)
            )
        );
        emit log_string(
            string.concat("  fees waiting to be swept: ", _nvdac(owedAtEnd), " NVDAc"));

        // THE TRADEABLE RESERVE, RAW. "60.00 of which 60.00 is phantom" is a
        // two-decimal rendering and cannot tell nothing from a dust remainder,
        // so the number itself is printed and then asserted.
        uint256 tradeableLeft = qr - MS_PHANTOM;
        emit log_named_uint("  tradeable reserve left, raw (NVDAc, 8dp) - DUST, not zero", tradeableLeft);
        // AND IT IS NOT ZERO. Printed to two decimals it read as "60.00 of
        // which 60.00 is phantom", which is how "the tradeable reserve is
        // empty" got written down. What was MEASURED is a remainder of 2 raw
        // units at a 1% tax, 1 at 3% and 3 at 5%, in this fixture.
        //
        // WHERE IT COMES FROM IS NOT MEASURED. Fee and tax are both rounded
        // down on every leg, which is the obvious candidate and is why the
        // bound below is written in legs - but nothing here traces a unit of
        // the remainder to a particular rounding, and no run was done that
        // would separate that explanation from another one.
        //
        // WHETHER ANYONE COULD TAKE IT IS ALSO NOT MEASURED. It sits in the
        // tradeable reserve, so the curve would price a trade against it; no
        // trade was attempted to find out what such a trade returns.
        //
        // THE BOUND IS A REGRESSION LIMIT FOR THIS FIXTURE, NOT A THEOREM.
        // Ten legs, at most one unit each, is where the number came from; it
        // holds for these three runs and says nothing about other sizes,
        // counts or tax rates. It is here so a remainder that stops being a
        // remainder is noticed.
        assertLe(
            tradeableLeft,
            MS_SELLERS * 2,
            "the leftover in the tradeable reserve grew past this fixture's regression limit"
        );
        // AND THE END STATE CLOSES EXACTLY, once the remainder is named.
        // "Every real NVDAc left is somebody's fee" was the second thing the
        // two-decimal log made look true: 0.99 held against 0.99 owed, while
        // the raw figures were 99499998 and 99499996. What is left is the fees
        // owed PLUS the remainder above, which is in the tradeable reserve and
        // in neither fee bucket.
        assertEq(
            realAtEnd,
            owedAtEnd + tradeableLeft,
            "what the curve holds is not the fees it owes plus the tradeable dust"
        );

        // ---- S5, IN A SNAPSHOT OF ITS OWN --------------------------------
        //
        // It needs a sixth trader with tokens to sell, and buying those tokens
        // moves the curve. Doing that on the state above would rewrite the end
        // state that was just recorded, so it happens here and is rolled back,
        // and the rollback is CHECKED rather than assumed.
        uint256 stateBeforeS5 = vm.snapshotState();

        address late = makeAddr(string.concat("ms-late-", vm.toString(uint256(tax))));
        vm.prank(NVDAC_WHALE);
        IERC20(NVDAC).transfer(late, MS_EACH);
        vm.startPrank(late);
        IERC20(NVDAC).approve(address(curve), type(uint256).max);
        uint256 lateTokens = curve.buy(MS_EACH, 0, late);
        token.approve(address(curve), type(uint256).max);
        uint256 willPay = _msQuoteOutFor(curve, lateTokens);
        vm.expectRevert(
            abi.encodeWithSelector(PonsV2BondingCurve.SlippageExceeded.selector, willPay, willPay + 1)
        );
        curve.sell(lateTokens, willPay + 1, late);
        vm.stopPrank();
        emit log_string(
            string.concat(
                "  S5 (in a snapshot, rolled back): a sale demanding one unit more than the ",
                _nvdac(willPay),
                " NVDAc that is payable reverted, rather than part-filling"
            )
        );

        vm.revertToState(stateBeforeS5);
        assertEq(
            IERC20(NVDAC).balanceOf(address(curve)), realAtEnd, "S5's snapshot did not roll back the balance"
        );
        assertEq(
            curve.quoteFeeBalance() + curve.creatorTaxBalance(), owedAtEnd, "S5's snapshot did not roll back the fees"
        );

        // ================================================================
        // L. AND WHAT IS LEFT IS REACHABLE - the second half of what C2 asks
        // ================================================================
        //
        // The books balancing says nothing about whether anybody can get at
        // what the books describe. After a queue of sellers has emptied the
        // tradeable reserve, three things have to still work, and they are
        // asserted here rather than reasoned about:
        //   L1  the fees can be swept out of the curve
        //   L2  each party can then withdraw their own share as real NVDAc
        //   L3  the curve still trades - a new buyer can arrive and be filled
        //
        // These run on the state the five sales left, after S5's snapshot has
        // been rolled back, so they are asked of the real end state.

        // L1. The creator is the curve's deployer here, and the sweep operator
        // is unset, so this is the path a launch actually has.
        uint256 protocolOwedBefore = feeEscrow.balanceOfToken(protocolRecipient, NVDAC);
        uint256 creatorOwedBefore = feeEscrow.balanceOfToken(creator, NVDAC);
        vm.prank(creator);
        curve.sweepFees(0);
        assertEq(
            curve.quoteFeeBalance() + curve.creatorTaxBalance(), 0, "L1: the sweep left fees behind on the curve"
        );
        uint256 protocolOwed = feeEscrow.balanceOfToken(protocolRecipient, NVDAC) - protocolOwedBefore;
        uint256 creatorOwed = feeEscrow.balanceOfToken(creator, NVDAC) - creatorOwedBefore;
        assertEq(protocolOwed + creatorOwed, owedAtEnd, "L1: what was swept is not what was owed");
        assertGt(protocolOwed, 0, "L1: the protocol was credited nothing");
        assertGt(creatorOwed, 0, "L1: the creator was credited nothing");

        // L2. Credited is not paid. Both sides withdraw, and it is their REAL
        // NVDAc balance that is asserted, not the escrow's ledger.
        uint256 protocolWalletBefore = IERC20(NVDAC).balanceOf(protocolRecipient);
        vm.prank(protocolRecipient);
        feeEscrow.claimToken(NVDAC);
        assertEq(
            IERC20(NVDAC).balanceOf(protocolRecipient) - protocolWalletBefore,
            protocolOwed,
            "L2: the protocol did not receive what it was owed"
        );
        uint256 creatorWalletBefore = IERC20(NVDAC).balanceOf(creator);
        vm.prank(creator);
        feeEscrow.claimToken(NVDAC);
        assertEq(
            IERC20(NVDAC).balanceOf(creator) - creatorWalletBefore,
            creatorOwed,
            "L2: the creator did not receive what they were owed"
        );

        // L3. And the curve is still a market. A new buyer arrives after the
        // queue has been through and is filled - which is also what says the
        // remainder in the tradeable reserve is reachable rather than stranded.
        address latecomer = makeAddr(string.concat("ms-after-", vm.toString(uint256(tax))));
        vm.prank(NVDAC_WHALE);
        IERC20(NVDAC).transfer(latecomer, MS_EACH);
        vm.startPrank(latecomer);
        IERC20(NVDAC).approve(address(curve), type(uint256).max);
        uint256 boughtAfter = curve.buy(MS_EACH, 0, latecomer);
        vm.stopPrank();
        // "MORE THAN NOTHING" IS NOT AN ASSERTION. The curve holds the entire
        // supply again, so a buy would return something no matter how broken
        // the state was. What says the curve came back is that the SAME offer
        // buys what the FIRST buyer got, to within the fees the queue left
        // behind - the reserves are where they started.
        assertApproxEqRel(
            boughtAfter,
            held[0],
            0.01e18,
            "L3: the same offer no longer buys what it did before the queue"
        );

        emit log_string(
            string.concat(
                "  reachable: swept ",
                _nvdac(owedAtEnd),
                " NVDAc (protocol ",
                _nvdac(protocolOwed),
                " / creator ",
                _nvdac(creatorOwed),
                "), both claimed in full, and a later buyer was filled with ",
                vm.toString(boughtAfter / 1e18),
                "e18 tokens"
            )
        );
    }

    /// S1, asserted after EVERY sale rather than once at the end: a book that
    /// balances only at the finish would hide a sale that left it wrong and a
    /// later one that happened to put it back.
    ///
    /// A SECOND RECONCILIATION THAT WAS NOT ONE. This used to rebuild the
    /// balance as `quoteReserve - phantom + fees owed` and call that an
    /// independent check. It is not: getReserves() computes
    ///     quoteReserve = phantom + trackedQuote - platformFees - creatorFees
    /// so taking the phantom out and adding the fees back returns trackedQuote
    /// exactly. The "second" assertion was the first one rearranged, and fee
    /// buckets that were both wrong would have sailed through it.
    ///
    /// WHAT IS INDEPENDENT is a set of books kept OUTSIDE the contract: every
    /// amount that went in, every amount that came out, and each leg's fee and
    /// tax worked out from the rates rather than read back from the balances
    /// they are supposed to explain. The three totals are then asserted
    /// SEPARATELY - the curve's real NVDAc, the protocol's bucket, and the
    /// creator's - so a fee that landed in the wrong bucket, or in no bucket,
    /// shows up as itself instead of cancelling out.
    struct MsBooks {
        uint256 real;
        uint256 platform;
        uint256 creator;
    }

    function _msAssertBooks(PonsV2BondingCurve curve, CurbLaunchToken token, MsBooks memory books, string memory at)
        internal
    {
        assertEq(
            IERC20(NVDAC).balanceOf(address(curve)),
            books.real,
            string.concat("S1: the curve's real NVDAc is not what went in minus what came out, at ", at)
        );
        assertEq(
            curve.quoteFeeBalance(),
            books.platform,
            string.concat("S1: the protocol's fee bucket does not match the fees charged, at ", at)
        );
        assertEq(
            curve.creatorTaxBalance(),
            books.creator,
            string.concat("S1: the creator's tax bucket does not match the tax charged, at ", at)
        );
        // And the contract's own tracking, which must agree with all of it.
        assertEq(
            IERC20(NVDAC).balanceOf(address(curve)),
            curve.trackedQuote(),
            string.concat("S1: real NVDAc does not match trackedQuote, at ", at)
        );
        assertEq(
            token.balanceOf(address(curve)),
            curve.trackedTokens(),
            string.concat("S1: real tokens do not match trackedTokens, at ", at)
        );
    }

    /// The three legs of a sale, worked out here rather than taken from the
    /// curve, so the books above owe nothing to the numbers they check.
    function _msLegs(PonsV2BondingCurve curve, uint256 tokensIn)
        internal
        view
        returns (uint256 net, uint256 fee, uint256 tax)
    {
        (uint256 q, uint256 t) = curve.getReserves();
        uint256 gross = PonsV2BondingCurveMath.getAmountOut(tokensIn, t, q, 0);
        fee = (gross * curve.feeBps()) / 10_000;
        tax = (gross * curve.creatorTaxBps()) / 10_000;
        net = gross - fee - tax;
    }

    /// Quote per token, 1e36 fixed point, from the reserves the curve actually
    /// prices against - the phantom included, because that is what it trades on.
    ///
    /// THE SCALE IS 1e36 AND THAT IS NOT DECORATION. NVDAc carries 8 decimals
    /// and the launch token 18, so quote/token is around 5e-18. At 1e18 the
    /// whole run quantised to 19, 12, 9, 7, 6, 6 - two significant figures -
    /// and the last step read as "the price did not move" when it had moved
    /// and the ruler could not see it. Same mistake as the cost display's, in
    /// a different place.
    function _msMid(PonsV2BondingCurve curve) internal view returns (uint256) {
        (uint256 q, uint256 t) = curve.getReserves();
        return t == 0 ? 0 : (q * 1e36) / t;
    }

    /// What a sale of `tokensIn` would pay right now, by the curve's own
    /// arithmetic, so S5 can ask for exactly one unit more than is payable.
    /// BOTH RATES ARE READ OFF THE CURVE, not taken from the launch config.
    /// The config carries the creator's TOTAL tax, and the platform's fixed
    /// 50 bps comes out of that total - so creatorTaxBps is not the number
    /// that was handed to launch(). Using the config's figure here made this
    /// helper under-state what a sale pays, and S5 then asked for an amount
    /// the curve could still afford and no revert came.
    function _msQuoteOutFor(PonsV2BondingCurve curve, uint256 tokensIn) internal view returns (uint256) {
        (uint256 q, uint256 t) = curve.getReserves();
        uint256 gross = PonsV2BondingCurveMath.getAmountOut(tokensIn, t, q, 0);
        uint256 fee = (gross * curve.feeBps()) / 10_000;
        uint256 taxAmt = (gross * curve.creatorTaxBps()) / 10_000;
        return gross - fee - taxAmt;
    }

    // ================================================================
    // C2, SECOND HALF  THE SAME QUEUE, IN THE GRADUATED POOL
    // ================================================================
    //
    // THE CRITERIA, FIXED BEFORE MEASURING, asserted rather than printed:
    //   P1  every seller in the queue gets out - no swap in the sequence
    //       reverts, and none returns nothing
    //   P2  the money is conserved AND it went to the right people. The
    //       pool's NVDAc falls by exactly what the seller, the platform and
    //       the creator gained between them - and each of those three is
    //       separately equal to its own independently computed share. A total
    //       on its own would pass with the creator's leg paid to the platform,
    //       or with the fee left sitting in the hook.
    //   P3  the price falls and stays positive across the queue
    //   P4  the pool's token balance rises by exactly what was sold into it
    //
    // AND THE EXIT LEG, ON THE SAME QUEUE:
    //   E1  every conversion goes through and returns more than nothing
    //   E2  how much of each offer the leg actually took - the spent leg read
    //       off the swap's deltas, cross-checked against what the pool gained
    //       and what stayed behind unspent. A balance that merely rose says a
    //       swap happened, not that the whole offer went in.
    //   E3  the rate each seller gets is worse than the one before. The v3
    //       pool is NOT reset between sellers: resetting it would measure five
    //       first sellers and say nothing about a queue.
    //
    // MEASURED, NOT ASSERTED: each seller's NVDAc and ETH, the execution cost
    // against the mid that seller's swap started from, and the cumulative price
    // move on both legs. No threshold - D4 is unset.
    //
    // CONSECUTIVE, as on the curve: seller i swaps into whatever seller i-1
    // left. Five independent swaps from the graduation price would be a
    // different measurement.

    function test_massSell_inThePool_tax100() public onlyFork {
        _massSellInPool(100);
    }

    function test_massSell_inThePool_tax300() public onlyFork {
        _massSellInPool(300);
    }

    function test_massSell_inThePool_tax500() public onlyFork {
        _massSellInPool(500);
    }

    function _massSellInPool(uint16 tax) internal {
        (PoolKey memory key, CurbLaunchToken token, address holder,) =
            _launchAtTaxTier(MS_PHANTOM, MS_THRESHOLD, tax, FEE, TICK_SPACING);

        bool quoteIsCurrency0 = Currency.unwrap(key.currency0) == NVDAC;
        // SIX SHARES, THOUGH ONLY FIVE SELL HERE. The routed run below cuts
        // six - five for the queue and one for the seller whose bound refuses -
        // and the two measurements are only comparable if a seller is the same
        // size in both. Cutting five here and six there made the first seller's
        // figures differ, and they were reported as agreeing.
        uint256 each = token.balanceOf(holder) / (MS_SELLERS + 1);
        require(each > 0, "the crossing buyer holds no tokens to share out");

        // THE HOOK THIS POOL ACTUALLY RUNS, read off the key. _launchAtTaxTier
        // builds a stack of its own, so the suite-level `hook` field belongs to
        // a different pool; reading the recipients off it happened to agree
        // because both stacks name the same platform address, which is exactly
        // the kind of accident a fee check should not depend on.
        // PAYABLE, because the hook has a receive() now - it takes back the ether
        // it unwraps for a WETH pool. The cast has to say so.
        FeeHook poolHook = FeeHook(payable(address(key.hooks)));
        address platformAddr = poolHook.platformRecipient();
        address creatorAddr = poolHook.feeOf(key).creator;
        assertEq(creatorAddr, creator, "the pool's hook does not name this launch's creator");

        emit log_string("");
        emit log_string(
            string.concat(
                "=== MASS SELL IN THE GRADUATED POOL, tax ",
                vm.toString(uint256(tax) / 100),
                "% - 60/60, 0.05% tier ==="
            )
        );
        emit log_string(
            string.concat(
                "  five holders, ",
                vm.toString(each / 1e18),
                "e18 tokens each, selling one after another into the same pool"
            )
        );

        uint256 lastMid = _poolMidQ18(key);
        uint256 tookTotal;

        // ONE v3 POOL FOR THE WHOLE QUEUE, never rolled back between sellers.
        V3ExitHarness exit = new V3ExitHarness();
        uint256 v3NvdacAtStart = IERC20(NVDAC).balanceOf(V3_NVDAC_WETH);
        uint256 lastRate = type(uint256).max;
        uint256 ethTotal;

        for (uint256 i = 0; i < MS_SELLERS; i++) {
            uint256 poolQuoteBefore = IERC20(NVDAC).balanceOf(address(POOL_MANAGER));
            uint256 poolTokensBefore = token.balanceOf(address(POOL_MANAGER));
            uint256 platformBefore = IERC20(NVDAC).balanceOf(platformAddr);
            uint256 creatorBefore = IERC20(NVDAC).balanceOf(creatorAddr);
            uint256 hookBefore = IERC20(NVDAC).balanceOf(address(poolHook));

            PoolHarness seller = new PoolHarness(POOL_MANAGER);
            vm.prank(holder);
            token.transfer(address(seller), each);

            // P1 IS THIS CALL. A revert here fails the test.
            seller.swap(key, !quoteIsCurrency0, -int256(each));
            uint256 took = IERC20(NVDAC).balanceOf(address(seller));
            assertGt(took, 0, "P1: the seller got nothing out of the pool");
            tookTotal += took;

            // P2, FIRST: nothing created, nothing lost.
            uint256 leftPool = poolQuoteBefore - IERC20(NVDAC).balanceOf(address(POOL_MANAGER));
            uint256 platformTook = IERC20(NVDAC).balanceOf(platformAddr) - platformBefore;
            uint256 creatorTook = IERC20(NVDAC).balanceOf(creatorAddr) - creatorBefore;
            assertEq(
                leftPool,
                took + platformTook + creatorTook,
                "P2: the NVDAc that left the pool is not what the three of them gained"
            );
            // P2, SECOND, AND THIS IS THE PART A TOTAL CANNOT DO. Each share
            // against its own expectation, worked out here from the rates
            // rather than read back from the transfers they explain. The
            // platform's 50 bps is D1's fixed share and the creator takes the
            // rest of the launch's tax.
            uint256 expPlatform = (leftPool * 50) / 10_000;
            uint256 expCreator = (leftPool * (uint256(tax) - 50)) / 10_000;
            assertEq(platformTook, expPlatform, "P2: the platform's leg is not 50 bps of what left the pool");
            assertEq(creatorTook, expCreator, "P2: the creator's leg is not the rest of the launch's tax");
            assertEq(took, leftPool - expPlatform - expCreator, "P2: the seller did not get what the fees left");
            // And none of it stayed behind in the hook.
            assertEq(
                IERC20(NVDAC).balanceOf(address(poolHook)), hookBefore, "P2: the hook kept NVDAc from the swap"
            );
            // P4: and the tokens went in, all of them.
            assertEq(
                token.balanceOf(address(POOL_MANAGER)) - poolTokensBefore,
                each,
                "P4: the pool did not take in exactly what was sold"
            );

            uint256 expected = (each * lastMid) / 1e18 / 1e10;
            uint256 costBps = expected == 0 ? 0 : ((expected - took) * 10_000) / expected;

            uint256 mid = _poolMidQ18(key);
            assertLt(mid, lastMid, "P3: the pool price did not fall on a sale");
            assertGt(mid, 0, "P3: the pool price reached zero");
            lastMid = mid;

            // ---- and straight out to ETH, into whatever the last one left --
            //
            // NO SLIPPAGE BOUND ON THIS LEG. The swap is given MIN/MAX_SQRT,
            // so it takes whatever price it finds. That is not the same as
            // "it always succeeds" - an exact-input swap that reaches its
            // limit fills only partially - which is why the spent leg is
            // measured below rather than assumed.
            //
            // WHAT A ROUTED USER WOULD GET IS NOT DECIDED HERE, and an earlier
            // version of this comment claimed it was. Whether the real route
            // reverts depends on the minimum THAT USER sets: someone who
            // accepts the quote in front of them trades at these prices, and
            // only a minimum above what the route can deliver refuses. And
            // when the routed sale does revert it reverts WHOLE - the v4 leg
            // unwinds with it, so that seller is left holding MEME, not NVDAc.
            //
            // This is therefore the output and price impact of THIS sequence
            // of sales at THIS block, measured directly against the v3 pool.
            // It is not a statement about how much liquidity is reachable.
            uint256 v3Before = IERC20(NVDAC).balanceOf(V3_NVDAC_WETH);
            uint256 v3MidBefore = _v3MidWeiPerNvdac();
            vm.prank(address(seller));
            IERC20(NVDAC).transfer(address(exit), took);
            uint256 exitHeldBefore = exit.nvdacLeft();
            (uint256 wethOut, uint256 spent) = exit.sell(V3_NVDAC_WETH, took);

            assertGt(wethOut, 0, "E1: the exit leg returned no WETH");
            // E2: HOW MUCH OF THE OFFER THE LEG ACTUALLY TOOK. The pool's
            // balance merely rising says a swap happened, not that the whole
            // offer went in - and the two come apart exactly when this matters.
            // Spent is read from the swap's own deltas and cross-checked
            // against what the pool gained and what is left sitting here.
            assertEq(
                IERC20(NVDAC).balanceOf(V3_NVDAC_WETH) - v3Before,
                spent,
                "E2: the pool did not gain what the swap says was spent"
            );
            assertEq(
                exit.nvdacLeft(),
                exitHeldBefore - spent,
                "E2: the unspent NVDAc is not left sitting in the harness"
            );
            uint256 fillBps = (spent * 10_000) / took;
            // COST IS CHARGED ON WHAT WAS SPENT, not on what was offered.
            uint256 rate = (wethOut * 1e8) / spent;
            uint256 v3CostBps = v3MidBefore == 0 || rate >= v3MidBefore
                ? 0
                : ((v3MidBefore - rate) * 10_000) / v3MidBefore;
            assertLt(rate, lastRate, "E3: a later seller got a better rate than the one before");
            lastRate = rate;
            ethTotal += wethOut;

            emit log_string(
                string.concat(
                    "  seller ",
                    vm.toString(i),
                    ": took ",
                    _nvdac(took),
                    " NVDAc, worth ",
                    _nvdac(expected),
                    " at the mid it started from -> execution cost ",
                    vm.toString(costBps),
                    " bps.  platform ",
                    _nvdac(platformTook),
                    " / creator ",
                    _nvdac(creatorTook),
                    ".  mid now ",
                    vm.toString(mid),
                    "  ->  ETH leg: ",
                    vm.toString(wethOut),
                    " wei for ",
                    _nvdac(spent),
                    " NVDAc spent (fill ",
                    vm.toString(fillBps),
                    " bps of the offer), rate ",
                    vm.toString(rate),
                    " vs mid ",
                    vm.toString(v3MidBefore),
                    " -> exit cost ",
                    vm.toString(v3CostBps),
                    " bps"
                )
            );
        }

        emit log_string(
            string.concat(
                "  five sellers out of the pool: ", _nvdac(tookTotal), " NVDAc between them"
            )
        );
        emit log_named_uint(
            "  POOL_MANAGER NVDAc after, raw 8dp - ALL v4 pools, not only this one",
            IERC20(NVDAC).balanceOf(address(POOL_MANAGER))
        );
        emit log_string(
            string.concat(
                "  the exit leg over this sequence: ",
                vm.toString(ethTotal),
                " wei of WETH out, ",
                _nvdac(IERC20(NVDAC).balanceOf(V3_NVDAC_WETH) - v3NvdacAtStart),
                " NVDAc in, and ",
                _nvdac(exit.nvdacLeft()),
                " NVDAc never went in at all"
            )
        );
        emit log_string(
            "  (WETH, not native ETH - this measures the v3 leg by itself, with no unwrap)"
        );

        // L4. WHAT IS LEFT IN THE POOL IS STILL REACHABLE. A buyer arriving
        // after the queue is filled, and can sell back again - which is the
        // pool's half of what C2 asks for, and is asserted rather than assumed
        // from the pool still holding a balance.
        PoolHarness after_ = new PoolHarness(POOL_MANAGER);
        vm.prank(NVDAC_WHALE);
        IERC20(NVDAC).transfer(address(after_), MS_EACH);
        after_.swap(key, quoteIsCurrency0, -int256(MS_EACH));
        uint256 boughtBack = token.balanceOf(address(after_));
        assertGt(boughtBack, 0, "L4: the pool would not fill a buyer after the queue");

        after_.swap(key, !quoteIsCurrency0, -int256(boughtBack));
        assertGt(IERC20(NVDAC).balanceOf(address(after_)), 0, "L4: the pool would not take the tokens back");

        emit log_string(
            string.concat(
                "  reachable: a later buyer got ",
                vm.toString(boughtBack / 1e18),
                "e18 tokens for ",
                _nvdac(MS_EACH),
                " NVDAc and could sell them back for ",
                _nvdac(IERC20(NVDAC).balanceOf(address(after_))),
                " NVDAc"
            )
        );
    }

    /// The v3 pool's mid as wei of WETH per WHOLE NVDAc, from slot0. Read
    /// before each conversion so the exit leg's cost is measured against the
    /// price that conversion started from, the same way the v4 leg is.
    function _v3MidWeiPerNvdac() internal view returns (uint256) {
        (uint160 sq,,,,,,) = IV3PoolMinimal(V3_NVDAC_WETH).slot0();
        uint256 ratioQ = FullMath.mulDiv(uint256(sq), uint256(sq), 1 << 96);
        return IV3PoolMinimal(V3_NVDAC_WETH).token0() == NVDAC
            ? FullMath.mulDiv(ratioQ, 1e8, 1 << 96)
            : FullMath.mulDiv(1 << 96, 1e8, ratioQ);
    }

    /// The pool's mid as quote per token, 1e18 fixed point, from slot0 rather
    /// than from any quote - the same reading the depth tables use.
    function _poolMidQ18(PoolKey memory key) internal view returns (uint256) {
        (uint160 sqrtPriceX96,,,) = POOL_MANAGER.getSlot0(key.toId());
        return _quotePerTokenQ18(key, sqrtPriceX96);
    }

    // ================================================================
    // C2  THE SAME QUEUE, THROUGH THE REAL ROUTER, TO NATIVE ETH
    // ================================================================
    //
    // The direct v3 measurement above reads one leg on its own. This runs the
    // whole route a user would actually send - MEME -> v4 -> NVDAc -> v3 ->
    // WETH -> UNWRAP -> ETH - through the deployed UniversalRouter, on THIS
    // launch's 0.05% pool, five sellers one after another with nothing reset
    // between them.
    //
    // HOW THE MINIMUM IS CHOSEN, because the answer depends on it:
    //   the successful queue asks for 1 wei. That is a user who accepts the
    //   quote in front of them, and it is the LEAST demanding bound there is -
    //   so it measures what the route can deliver, not what a user would
    //   tolerate. A user with a real bound gets less often, never more.
    //   the refused sale asks for what the FIRST seller received. That is a
    //   user who turns up expecting the price the first one got. It is one
    //   choice of bound out of many and is named as such; a lower bound would
    //   have gone through.
    //
    // AND THIS ONE DELIVERS NATIVE ETH. The direct measurement stops at WETH.

    /// ROUTER and V4_SWAP_CMD are already declared above - the same deployed
    /// router the rest of this file uses.
    uint8 internal constant CMD_V3_SWAP_EXACT_IN = 0x00;
    uint8 internal constant CMD_SWEEP = 0x04;
    uint8 internal constant CMD_UNWRAP_WETH = 0x0c;
    uint24 internal constant V3_FEE = 3000;
    /// keccak("InsufficientETH()")[0:4], the UniversalRouter's own error when
    /// UNWRAP_WETH cannot deliver the minimum it was given.
    bytes4 internal constant INSUFFICIENT_ETH = 0x6a12f104;
    address internal constant WETH9 = 0x4200000000000000000000000000000000000006;

    function test_massSell_routedToEth_tax100() public onlyFork {
        _massSellRouted(100);
    }

    function test_massSell_routedToEth_tax500() public onlyFork {
        _massSellRouted(500);
    }

    function _massSellRouted(uint16 tax) internal {
        (PoolKey memory key, CurbLaunchToken token, address holder,) =
            _launchAtTaxTier(MS_PHANTOM, MS_THRESHOLD, tax, FEE, TICK_SPACING);
        // PAYABLE, because the hook has a receive() now - it takes back the ether
        // it unwraps for a WETH pool. The cast has to say so.
        FeeHook poolHook = FeeHook(payable(address(key.hooks)));
        address platformAddr = poolHook.platformRecipient();
        address creatorAddr = poolHook.feeOf(key).creator;

        // SIX SHARES, NOT FIVE: the queue is five and the sixth is the seller
        // whose bound refuses. Cutting five and then asking for a sixth left
        // the holder empty.
        uint256 each = token.balanceOf(holder) / (MS_SELLERS + 1);

        emit log_string("");
        emit log_string(
            string.concat(
                "=== MASS SELL THROUGH THE ROUTER TO NATIVE ETH, tax ",
                vm.toString(uint256(tax) / 100),
                "% - 60/60, 0.05% tier ==="
            )
        );

        uint256 firstOut;
        uint256 ethTotal;
        for (uint256 i = 0; i < MS_SELLERS; i++) {
            address s = makeAddr(string.concat("rt-", vm.toString(uint256(tax)), "-", vm.toString(i)));
            vm.prank(holder);
            token.transfer(s, each);
            _routeApprove(s, token);

            uint256 ethBefore = s.balance;
            vm.prank(s);
            // THE BOUND IS 1 wei: accept the quote in front of you.
            ROUTER.execute(_routeSellCommands(), _routeSellInputs(key, token, uint128(each), 1), block.timestamp + 60);
            uint256 got = s.balance - ethBefore;

            assertGt(got, 0, "R1: the routed sale delivered no native ETH");
            assertEq(token.balanceOf(s), 0, "R1: the seller still holds MEME");
            assertEq(IERC20(NVDAC).balanceOf(s), 0, "R1: NVDAc was left with the seller");
            // AND THE ROUTER IS EMPTY AFTERWARDS. In a queue this is not
            // housekeeping: the route ends with SWEEP, so anything one seller
            // left behind would be swept to the NEXT one, and the sequence
            // would stop measuring what it claims to.
            assertEq(IERC20(NVDAC).balanceOf(address(ROUTER)), 0, "R1: NVDAc left in the router");
            assertEq(IERC20(WETH9).balanceOf(address(ROUTER)), 0, "R1: WETH left in the router");
            assertEq(address(ROUTER).balance, 0, "R1: native ETH left in the router");
            if (i == 0) firstOut = got;
            ethTotal += got;

            emit log_string(
                string.concat("  seller ", vm.toString(i), ": ", vm.toString(got), " wei of NATIVE ETH")
            );
        }
        emit log_string(string.concat("  five routed exits: ", vm.toString(ethTotal), " wei of native ETH"));

        // ---- and one that asks for the first seller's price ---------------
        address late = makeAddr(string.concat("rt-late-", vm.toString(uint256(tax))));
        vm.prank(holder);
        token.transfer(late, each);
        _routeApprove(late, token);

        uint256 poolQuoteBefore = IERC20(NVDAC).balanceOf(address(POOL_MANAGER));
        uint256 poolTokenBefore = token.balanceOf(address(POOL_MANAGER));
        uint256 v3NvdacBefore = IERC20(NVDAC).balanceOf(V3_NVDAC_WETH);
        uint256 v3WethBefore = IERC20(WETH9).balanceOf(V3_NVDAC_WETH);
        uint256 platformBefore = IERC20(NVDAC).balanceOf(platformAddr);
        uint256 creatorBefore = IERC20(NVDAC).balanceOf(creatorAddr);
        uint256 memeBefore = token.balanceOf(late);
        uint256 ethBefore2 = late.balance;

        // THE ERROR IS NAMED. A bare expectRevert here would pass on a wrong
        // path, a bad encoding or a missing approval just as happily as on the
        // bound - which would make "the minimum refused it" a claim proved by
        // a mistake. This file already warns about that a few hundred lines up;
        // writing it bare was repeating the thing the warning is about.
        //
        // MEASURED: the deployed router bubbles InsufficientETH() - the check
        // UNWRAP_WETH makes on what reaches the recipient - so the refusal
        // comes from the last leg, which is where the bound was put.
        vm.prank(late);
        vm.expectRevert(INSUFFICIENT_ETH);
        ROUTER.execute(
            _routeSellCommands(), _routeSellInputs(key, token, uint128(each), firstOut), block.timestamp + 60
        );

        // R2: IT UNWINDS WHOLE. Not just "the sale failed" - both pools, both
        // fee legs and the seller's own tokens have to be where they were. A
        // route that reverted after moving the v4 leg would leave this seller
        // holding NVDAc instead of MEME, which is the case worth ruling out.
        assertEq(IERC20(NVDAC).balanceOf(address(POOL_MANAGER)), poolQuoteBefore, "R2: the v4 pool's NVDAc moved");
        assertEq(token.balanceOf(address(POOL_MANAGER)), poolTokenBefore, "R2: the v4 pool's tokens moved");
        assertEq(IERC20(NVDAC).balanceOf(V3_NVDAC_WETH), v3NvdacBefore, "R2: the v3 pool's NVDAc moved");
        assertEq(IERC20(WETH9).balanceOf(V3_NVDAC_WETH), v3WethBefore, "R2: the v3 pool's WETH moved");
        assertEq(IERC20(NVDAC).balanceOf(platformAddr), platformBefore, "R2: the platform was paid on a failed sale");
        assertEq(IERC20(NVDAC).balanceOf(creatorAddr), creatorBefore, "R2: the creator was paid on a failed sale");
        assertEq(token.balanceOf(late), memeBefore, "R2: the seller lost MEME on a failed sale");
        assertEq(IERC20(NVDAC).balanceOf(late), 0, "R2: the seller was left holding NVDAc");
        assertEq(late.balance, ethBefore2, "R2: the seller's ETH changed on a failed sale");

        emit log_string(
            string.concat(
                "  a sixth seller asking for the FIRST seller's ",
                vm.toString(firstOut),
                " wei was refused, and everything unwound"
            )
        );
    }

    function _routeApprove(address who, CurbLaunchToken token) internal {
        vm.startPrank(who);
        token.approve(address(PERMIT2), type(uint256).max);
        IPermit2Approve(address(PERMIT2)).approve(
            address(token), address(ROUTER), type(uint160).max, uint48(block.timestamp + 3600)
        );
        vm.stopPrank();
    }

    function _routeSellCommands() internal pure returns (bytes memory) {
        return abi.encodePacked(V4_SWAP_CMD, CMD_V3_SWAP_EXACT_IN, CMD_UNWRAP_WETH, CMD_SWEEP);
    }

    function _routeSellInputs(PoolKey memory key, CurbLaunchToken token, uint128 amountIn, uint256 minEthOut)
        internal
        view
        returns (bytes[] memory inputs)
    {
        inputs = new bytes[](4);
        inputs[0] = _routeV4SellInput(key, token, amountIn);
        inputs[1] = abi.encode(
            ActionConstants.ADDRESS_THIS,
            ActionConstants.CONTRACT_BALANCE,
            uint256(0),
            abi.encodePacked(NVDAC, V3_FEE, WETH9),
            false
        );
        inputs[2] = abi.encode(ActionConstants.MSG_SENDER, minEthOut);
        inputs[3] = abi.encode(NVDAC, ActionConstants.MSG_SENDER, uint256(0));
    }

    function _routeV4SellInput(PoolKey memory key, CurbLaunchToken token, uint128 amountIn)
        internal
        pure
        returns (bytes memory)
    {
        bytes memory actions =
            abi.encodePacked(uint8(Actions.SETTLE), uint8(Actions.SWAP_EXACT_IN_SINGLE), uint8(Actions.TAKE));
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(Currency.wrap(address(token)), uint256(amountIn), true);
        params[1] = abi.encode(
            ExactInputSingleLegacy({
                poolKey: key,
                zeroForOne: address(token) == Currency.unwrap(key.currency0),
                amountIn: ActionConstants.OPEN_DELTA,
                amountOutMinimum: uint128(0),
                hookData: ""
            })
        );
        params[2] = abi.encode(Currency.wrap(NVDAC), ActionConstants.ADDRESS_THIS, ActionConstants.OPEN_DELTA);
        return abi.encode(actions, params);
    }

    // ================================================================
    // B3  THE REGISTRY CAN BE BROWSED
    // ================================================================
    //
    // Discovery needs a list, and a mapping is not one. The alternative is
    // eth_getLogs over LaunchRegistered, and this upstream answers
    // "eth_getLogs is limited to a 2,000 range" - about 67 minutes of Base at
    // 2s blocks - so a list gets more expensive to draw every day it exists.
    // These assert the list is there, is in order, and pages.

    function test_theRegistryCanBeBrowsed() public onlyFork {
        uint256 before = registry.launchCount();

        (, CurbLaunchToken first) = _launch(true);
        assertEq(registry.launchCount(), before + 1, "the first launch was not counted");
        assertEq(registry.launchAt(before), address(first), "the first launch is not at its index");

        (, CurbLaunchToken second) = _launch(false);
        assertEq(registry.launchCount(), before + 2, "the second launch was not counted");
        assertEq(registry.launchAt(before + 1), address(second), "registration order is not preserved");

        // Every listed token resolves to a record - a list of addresses that
        // cannot be looked up would be a worse list than none.
        assertEq(registry.launchOf(registry.launchAt(before)).curve != address(0), true, "a listed launch has no record");
    }

    /// A PAGE PAST THE END IS SHORT, NOT AN ERROR. A caller paging a list that
    /// is still growing should get the tail it asked for.
    function test_browsingPagesAndStopsAtTheEnd() public onlyFork {
        uint256 before = registry.launchCount();
        (, CurbLaunchToken a) = _launch(true);
        (, CurbLaunchToken b) = _launch(false);

        address[] memory page = registry.launchSlice(before, 10);
        assertEq(page.length, 2, "the page was not cut short at the end of the list");
        assertEq(page[0], address(a), "page order is wrong");
        assertEq(page[1], address(b), "page order is wrong");

        address[] memory one = registry.launchSlice(before, 1);
        assertEq(one.length, 1, "a one-item page came back the wrong size");
        assertEq(one[0], address(a), "a one-item page has the wrong item");

        address[] memory none = registry.launchSlice(registry.launchCount(), 5);
        assertEq(none.length, 0, "a page starting exactly at the end is not empty");
    }

    /// ONE CALL DRAWS A PAGE, with each launch's state already in it.
    function test_aPageCarriesEachLaunchesState() public onlyFork {
        uint256 before = registry.launchCount();
        (PonsV2BondingCurve curveA, CurbLaunchToken a) = _launch(true);
        (, CurbLaunchToken b) = _launch(false);

        (address[] memory tokens, LaunchLens.LaunchView[] memory views) = lens.launchPage(before, 10);
        assertEq(tokens.length, 2, "the page is the wrong length");
        assertEq(views.length, tokens.length, "a state is missing for a token on the page");
        assertEq(tokens[0], address(a), "page order is wrong");
        assertEq(tokens[1], address(b), "page order is wrong");

        // Selling, with the progress an interface needs to show.
        assertEq(uint256(views[0].status), uint256(LaunchLens.LaunchStatus.Selling), "a new launch is not Selling");
        assertEq(views[0].curve, address(curveA), "the page names the wrong curve");
        assertGt(views[0].graduationThreshold, 0, "no threshold to measure progress against");

        // And it tracks the launch through a state change rather than being a
        // snapshot of registration.
        _fillWithoutGraduating(curveA);
        (, LaunchLens.LaunchView[] memory after_) = lens.launchPage(before, 1);
        assertEq(uint256(after_[0].status), uint256(LaunchLens.LaunchStatus.Waiting), "the page did not follow the launch");
    }

    /// AND "EVERYTHING FROM HERE" IS A SHORT READ TOO, not a panic.
    ///
    /// AUDIT.txt A-7. `start + count` overflowed for the one caller this
    /// function's own comment is written for - somebody who does not know the
    /// length and asks for all of it - so the promise of a short read held for
    /// every count except the natural way to say "the rest".
    function test_browsingTheRestOfTheListDoesNotOverflow() public onlyFork {
        uint256 before = registry.launchCount();
        (, CurbLaunchToken a) = _launch(true);
        (, CurbLaunchToken b) = _launch(false);

        address[] memory rest = registry.launchSlice(before, type(uint256).max);
        assertEq(rest.length, 2, "asking for the rest did not return the tail");
        assertEq(rest[0], address(a), "the tail is in the wrong order");
        assertEq(rest[1], address(b), "the tail is in the wrong order");

        // And from the very end, where room is zero and the old arithmetic
        // overflowed just the same.
        address[] memory none = registry.launchSlice(registry.launchCount(), type(uint256).max);
        assertEq(none.length, 0, "the rest of an exhausted list is not empty");

        // The whole list from the start, the other way somebody says "all".
        address[] memory all = registry.launchSlice(0, type(uint256).max);
        assertEq(all.length, registry.launchCount(), "the whole list came back the wrong length");
    }

    /// PAST THE END IS AN ERROR, because that is a caller with a wrong idea of
    /// the list rather than one racing it.
    function test_browsingRefusesAnIndexThatIsNotThere() public onlyFork {
        uint256 n = registry.launchCount();
        vm.expectRevert(abi.encodeWithSelector(LaunchRegistry.IndexOutOfRange.selector, n, n));
        registry.launchAt(n);

        vm.expectRevert(abi.encodeWithSelector(LaunchRegistry.IndexOutOfRange.selector, n + 1, n));
        registry.launchSlice(n + 1, 1);
    }

    // ================================================================
    // A WETH pool pays its fees in ETH
    //
    // The hook pushes both legs on every swap. On a WETH pair it takes the
    // whole charge at once, unwraps it, and sends ether - and falls back to
    // the wrapped token for a recipient that will not take it, because a
    // revert here would stop the swap itself and with it the whole pool.
    // ================================================================

    /// The WETH/USDC 0.3% pool, which held 13,620 WETH at the pinned block. A
    /// balance to borrow from; nothing here trades against it.
    address internal constant WETH_HOLDER = 0x6c561B446416E1A00E8E93E221854d6eA4171372;

    /// SMALL ON PURPOSE. These tests are about where a fee LANDS, not about
    /// how large it is, and a smaller threshold is a faster fill.
    uint256 internal constant WETH_THRESHOLD = 0.5 ether;

    /// A WETH-quoted factory on the fixture's own registry, graduator and
    /// hook. The hook is asset-agnostic - it is the pool's record that names
    /// the quote - so this is the same hook every other test here uses.
    ///
    /// ITS OWN ESCROW AND ITS OWN POLICY, both naming WETH's escrow. It used to
    /// borrow NVDAc's policy, which the factory now refuses: a policy that
    /// names another escrow is a stack wired two ways. THE ESCROW IS CREATED
    /// FIRST, and two tests predict its address from this contract's nonce.
    function _wethFactory() internal returns (CurbLaunchFactory fac) {
        fac = _wethFactoryUnadmitted();
        registry.addLauncher(address(fac));
    }

    /// The same factory, built but not admitted.
    function _wethFactoryUnadmitted() internal returns (CurbLaunchFactory fac) {
        (FeeEscrow wethEscrow, IPonsV2FeePolicy wethPolicy) = _escrowAndPolicyFor(WETH9);
        fac = new CurbLaunchFactory(
            registry,
            graduator,
            WETH9,
            wethPolicy,
            IPonsV2FeeEscrow(address(wethEscrow)),
            buybackVault,
            CurbLaunchFactory.Terms({
                supply: SUPPLY,
                quoteDecimals: 18,                  // WETH
                phantomQuote: WETH_THRESHOLD,
                graduationThreshold: WETH_THRESHOLD,
                poolFee: FEE,
                tickSpacing: TICK_SPACING,
                hooks: IHooks(address(hook)),
                protocolFeeRecipient: protocolRecipient,
                maxInternalPriceImpactBps: 500,
                launchFee: 0
            })
        );
    }

    /// Launched on WETH, filled past the threshold, graduated, and handed back
    /// with the key of the pool it opened.
    ///
    /// THE SALT IS NOT MINED HERE. Which side the launch token lands on does
    /// not matter to a fee: the key is built from the addresses that actually
    /// resulted rather than from an assumption about their order.
    function _graduatedOnWeth(address creatorWallet)
        internal
        returns (CurbLaunchToken token, PoolKey memory key)
    {
        CurbLaunchFactory fac = _wethFactory();

        CurbLaunchFactory.LaunchConfig memory cfg = _config(true);
        cfg.salt = keccak256("curb.weth.fee.payout");
        cfg.creatorWallet = creatorWallet;

        vm.prank(creator);
        (CurbLaunchToken t, PonsV2BondingCurve curve) = fac.launch(cfg);
        token = t;

        uint256 spend = WETH_THRESHOLD * 2;
        vm.prank(WETH_HOLDER);
        IERC20(WETH9).transfer(trader, spend);
        vm.startPrank(trader);
        IERC20(WETH9).approve(address(curve), type(uint256).max);
        curve.buy(spend, 0, trader);
        vm.stopPrank();
        require(curve.graduated(), "the WETH launch did not graduate");

        bool launchIsCurrency0 = address(token) < WETH9;
        key = PoolKey({
            currency0: Currency.wrap(launchIsCurrency0 ? address(token) : WETH9),
            currency1: Currency.wrap(launchIsCurrency0 ? WETH9 : address(token)),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });
    }

    /// DID THE HOOK SAY IT PAID THIS RECIPIENT, AND IN WHICH FORM?
    ///
    /// THE BALANCE ALONE CANNOT ANSWER IT. A recipient holding WETH after a
    /// swap proves nothing: that is what happens when the fallback runs AND
    /// what happens if the unwrapping never runs at all. Disabling the WETH
    /// branch outright left both fallback tests below green until this
    /// existed, which is the whole reason it does.
    ///
    /// `wrapped` picks which of the two announcements to look for.
    function _hookAnnounced(address to, bool wrapped) internal returns (bool) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 wanted = wrapped
            ? keccak256("PaidAsWrapped(address,uint256)")
            : keccak256("PaidAsNative(address,uint256)");
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(hook)) continue;
            if (logs[i].topics.length < 2) continue;
            if (logs[i].topics[0] != wanted) continue;
            if (logs[i].topics[1] == bytes32(uint256(uint160(to)))) return true;
        }
        return false;
    }
    /// THE WHOLE POINT: a trade on a WETH pool owes both legs, and a claim
    /// pays them in ether.
    ///
    /// NOTHING LEAVES DURING THE SWAP, which is the fix for AUDIT X-1: the
    /// pool calls nobody while the manager is unlocked.
    function test_wethPool_bothFeeLegsLeaveAsEther() public onlyFork {
        (CurbLaunchToken token, PoolKey memory key) = _graduatedOnWeth(address(0));

        uint128 amountIn = 0.01 ether;
        vm.prank(WETH_HOLDER);
        IERC20(WETH9).transfer(trader, amountIn);

        uint256 creatorEthBefore = creator.balance;
        uint256 platformEthBefore = protocolRecipient.balance;
        uint256 creatorWethBefore = IERC20(WETH9).balanceOf(creator);
        uint256 platformWethBefore = IERC20(WETH9).balanceOf(protocolRecipient);

        _routerSwap(key, WETH9, address(token), amountIn, 0);

        assertEq(creator.balance, creatorEthBefore, "the swap paid the creator inside the lock");
        assertEq(protocolRecipient.balance, platformEthBefore, "the swap paid the platform inside the lock");

        uint256 creatorOwed = hook.owed(creator, WETH9);
        uint256 platformOwed = hook.owed(protocolRecipient, WETH9);
        assertGt(creatorOwed, 0, "the creator's fee was not recorded");
        assertGt(platformOwed, 0, "the platform's fee was not recorded");
        // THE HOOK HOLDS EXACTLY WHAT IT SAYS IT OWES. Anything else is a leak
        // in one direction or a shortfall in the other.
        assertEq(
            IERC20(WETH9).balanceOf(address(hook)), creatorOwed + platformOwed,
            "the hook does not hold what it says it owes"
        );
        assertEq(address(hook).balance, 0, "the hook is sitting on ether between swaps");

        vm.recordLogs();
        vm.prank(creator);
        assertEq(hook.claim(WETH9), creatorOwed, "the claim did not pay what was owed");
        assertTrue(_hookAnnounced(creator, false), "the claim paid ether without PaidAsNative");
        vm.prank(protocolRecipient);
        hook.claim(WETH9);

        assertEq(creator.balance - creatorEthBefore, creatorOwed, "the creator's claim did not arrive as ether");
        assertEq(
            protocolRecipient.balance - platformEthBefore, platformOwed,
            "the platform's claim did not arrive as ether"
        );
        assertEq(IERC20(WETH9).balanceOf(creator), creatorWethBefore, "the creator was paid in WETH as well");
        assertEq(
            IERC20(WETH9).balanceOf(protocolRecipient), platformWethBefore, "the platform was paid in WETH as well"
        );
        assertEq(hook.owed(creator, WETH9), 0, "the debt survived the claim");
        assertEq(IERC20(WETH9).balanceOf(address(hook)), 0, "the hook kept WETH after both claims");
        assertEq(address(hook).balance, 0, "the hook kept ether after both claims");
    }
    /// A CLAIMANT THAT CANNOT TAKE ETHER IS PAID THE WRAPPED TOKEN.
    ///
    /// The fallback still exists and still matters - it is just outside the
    /// lock now, so the worst it can cost is the wrapper rather than the pool.
    function test_wethPool_aCreatorThatRefusesEtherGetsWethAndTheSwapStillWorks() public onlyFork {
        EthRefuser refuser = new EthRefuser();
        (CurbLaunchToken token, PoolKey memory key) = _graduatedOnWeth(address(refuser));

        uint128 amountIn = 0.01 ether;
        vm.prank(WETH_HOLDER);
        IERC20(WETH9).transfer(trader, amountIn);

        uint256 got = _routerSwap(key, WETH9, address(token), amountIn, 0);
        assertGt(got, 0, "the swap did not go through");

        uint256 due = hook.owed(address(refuser), WETH9);
        assertGt(due, 0, "the refuser's fee was not recorded");

        vm.recordLogs();
        refuser.collect(hook, WETH9);
        assertTrue(_hookAnnounced(address(refuser), true), "the fallback paid WETH without PaidAsWrapped");

        assertEq(address(refuser).balance, 0, "a contract with no receive() was sent ether");
        assertEq(IERC20(WETH9).balanceOf(address(refuser)), due, "the fallback did not pay the wrapped token");
        assertEq(hook.owed(address(refuser), WETH9), 0, "the debt survived the claim");
        assertEq(address(hook).balance, 0, "the hook kept ether after the fallback");
        // WHAT IS LEFT IS THE PLATFORM'S, UNCLAIMED. Asserting zero here was
        // wrong: one claimant collecting does not empty a contract that owes
        // somebody else. The invariant is that the balance equals the debts.
        assertEq(
            IERC20(WETH9).balanceOf(address(hook)), hook.owed(protocolRecipient, WETH9),
            "the hook holds something it does not owe"
        );

        // AND THE NEXT CLAIM STILL GOES THROUGH. The fallback leaves claim()
        // by its token path, which has its own line clearing the re-entry
        // guard - and the guard is ordinary storage. Without that line every
        // claim after this one, by anybody, reverts ClaimReentered for good.
        uint256 platformDue = hook.owed(protocolRecipient, WETH9);
        assertGt(platformDue, 0, "the platform is owed nothing; the second claim proves nothing");
        uint256 platformEthBefore = protocolRecipient.balance;
        vm.prank(protocolRecipient);
        assertEq(hook.claim(WETH9), platformDue, "the claim after a wrapped payout did not pay");
        assertEq(protocolRecipient.balance - platformEthBefore, platformDue, "the second claim did not arrive");
    }
    /// A CLAIM CANNOT BE ENTERED TWICE, A CLAIM OF NOTHING IS REFUSED, AND THE
    /// HOOK TAKES ETHER ONLY FROM WETH.
    ///
    /// None of claim()'s own defences had a test: deleting the guard, the
    /// NothingOwed check, or the receive() restriction left the suite green.
    /// The claimant here re-enters from receive() and keeps the error instead
    /// of reverting, so the ether is accepted and the attempt is on record.
    function test_wethPool_claimCannotBeReenteredOrEmptyAndOnlyWethSendsEther() public onlyFork {
        ReentrantClaimant sneaky = new ReentrantClaimant();
        (CurbLaunchToken token, PoolKey memory key) = _graduatedOnWeth(address(sneaky));

        uint128 amountIn = 0.01 ether;
        vm.prank(WETH_HOLDER);
        IERC20(WETH9).transfer(trader, amountIn);
        _routerSwap(key, WETH9, address(token), amountIn, 0);

        uint256 due = hook.owed(address(sneaky), WETH9);
        assertGt(due, 0, "the fee was not recorded");
        sneaky.collect(hook, WETH9);

        assertFalse(sneaky.reentered(), "a second claim went through from inside the first");
        bytes memory err = sneaky.reentryError();
        assertGe(err.length, 4, "the re-entry did not revert");
        assertEq(bytes4(err), FeeHook.ClaimReentered.selector, "the re-entry failed for some other reason");
        assertEq(address(sneaky).balance, due, "the claimant was not paid exactly once, in ether");
        assertEq(hook.owed(address(sneaky), WETH9), 0, "the debt survived the claim");

        address nobody = makeAddr("owed nothing");
        vm.prank(nobody);
        vm.expectRevert(abi.encodeWithSelector(FeeHook.NothingOwed.selector, nobody, WETH9));
        hook.claim(WETH9);

        vm.deal(address(this), 1 ether);
        (bool ok, bytes memory ret) = address(hook).call{value: 1 wei}("");
        assertFalse(ok, "the hook accepted ether from something other than WETH");
        assertEq(bytes4(ret), FeeHook.UnexpectedNative.selector, "ether was refused for some other reason");
    }

    /// AND A RECIPIENT THAT DOES REAL WORK ON ARRIVAL IS PAID IN ETHER NOW.
    ///
    /// THIS TEST USED TO ASSERT THE OPPOSITE, and the change is the point. The
    /// old payout ran inside afterSwap and had to bound the recipient's gas to
    /// 30,000, so anybody whose receive() wrote storage was dropped to the
    /// wrapped token. A claim happens outside the lock, where the write-down
    /// and the guard are the protection, so there is no bound and no reason
    /// for one.
    function test_wethPool_aCreatorWhoseReceiveDoesRealWorkIsStillPaidInEther() public onlyFork {
        ExpensiveReceiver greedy = new ExpensiveReceiver();
        (CurbLaunchToken token, PoolKey memory key) = _graduatedOnWeth(address(greedy));

        uint128 amountIn = 0.01 ether;
        vm.prank(WETH_HOLDER);
        IERC20(WETH9).transfer(trader, amountIn);

        _routerSwap(key, WETH9, address(token), amountIn, 0);

        uint256 due = hook.owed(address(greedy), WETH9);
        assertGt(due, 0, "the fee was not recorded");

        greedy.collect(hook, WETH9);

        assertEq(address(greedy).balance, due, "an expensive receive() was dropped to the wrapped token");
        assertEq(IERC20(WETH9).balanceOf(address(greedy)), 0, "it was paid in WETH as well");
    }

    /// AND AN NVDAc POOL IS UNTOUCHED.
    ///
    /// The unwrapping is reached only when the pool's quote asset IS WETH.
    /// Every equity pair keeps the path it always had, which is what makes
    /// this change safe for the launches that already exist.
    function test_anEquityPoolStillPaysItsOwnToken() public onlyFork {
        (PoolKey memory key, CurbLaunchToken token,) = _graduatedBy(creator, TOTAL_TAX_BPS);

        vm.prank(NVDAC_WHALE);
        IERC20(NVDAC).transfer(trader, TRADER_FUNDING);
        uint256 creatorEthBefore = creator.balance;
        uint256 creatorTokBefore = IERC20(NVDAC).balanceOf(creator);

        _routerSwap(key, NVDAC, address(token), uint128(1e8), 0);

        assertGt(IERC20(NVDAC).balanceOf(creator) - creatorTokBefore, 0, "the equity fee did not arrive");
        assertEq(creator.balance, creatorEthBefore, "an equity pool moved ether");
        assertEq(address(hook).balance, 0, "the hook ended up holding ether on an equity pool");
    }
    /// AND THE GRIEFER CANNOT STOP THE POOL ANY MORE.
    ///
    /// THIS TEST ASSERTED THE OPPOSITE THIS MORNING, and the inversion is the
    /// evidence. The payout used to call the recipient inside afterSwap with a
    /// 30,000 stipend; that was enough to reach PoolManager.take, whose only
    /// gate is onlyWhenUnlocked, and one unsettled delta reverted the entire
    /// swap with CurrencyNotSettled. AUDIT X-1.
    ///
    /// Nothing calls the recipient during a swap now, so the same griefer has
    /// nothing to re-enter.
    function test_wethPool_aGrieferCanNoLongerStopEverySwap() public onlyFork {
        TakingReceiver griefer = new TakingReceiver(POOL_MANAGER, WETH9);
        (CurbLaunchToken token, PoolKey memory key) = _graduatedOnWeth(address(griefer));

        uint128 amountIn = 0.01 ether;
        vm.prank(WETH_HOLDER);
        IERC20(WETH9).transfer(trader, amountIn);

        _approveRouter(WETH9, amountIn);

        vm.prank(trader);
        (bool ok, bytes memory err) = address(ROUTER).call(
            abi.encodeWithSignature(
                "execute(bytes,bytes[],uint256)",
                abi.encodePacked(V4_SWAP_CMD),
                _swapInputs(key, WETH9, address(token), amountIn, 0),
                block.timestamp + 60
            )
        );
        assertTrue(ok, "the griefing recipient still stops the swap");
        assertFalse(
            _mentions(err, bytes4(keccak256("CurrencyNotSettled()"))),
            "the swap still ends in an unsettled delta"
        );

        // AND THEY ARE STILL OWED THEIR FEE. Closing the hole confiscated
        // nothing; it only moved when the money moves.
        assertGt(hook.owed(address(griefer), WETH9), 0, "the fee was not recorded for the griefer");
    }


    /// The swap inputs, split out so a test can send them itself and read the
    /// revert data rather than only learn that something failed.
    function _swapInputs(PoolKey memory key, address tokenIn, address tokenOut, uint128 amountIn, uint128 minOut)
        internal
        pure
        returns (bytes[] memory inputs)
    {
        bytes memory actions =
            abi.encodePacked(uint8(Actions.SWAP_EXACT_IN_SINGLE), uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL));
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            ExactInputSingleLegacy({
                poolKey: key,
                zeroForOne: tokenIn == Currency.unwrap(key.currency0),
                amountIn: amountIn,
                amountOutMinimum: minOut,
                hookData: ""
            })
        );
        params[1] = abi.encode(Currency.wrap(tokenIn), amountIn);
        params[2] = abi.encode(Currency.wrap(tokenOut), minOut);
        inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);
    }

    /// Does `blob` contain this selector anywhere? Router errors arrive wrapped,
    /// so the inner reason is a needle rather than the first four bytes.
    function _mentions(bytes memory blob, bytes4 sel) internal pure returns (bool) {
        if (blob.length < 4) return false;
        for (uint256 i = 0; i + 4 <= blob.length; i++) {
            if (blob[i] == sel[0] && blob[i + 1] == sel[1] && blob[i + 2] == sel[2] && blob[i + 3] == sel[3]) {
                return true;
            }
        }
        return false;
    }


    /// AUDIT Y-1, CLOSED: an issuer blocking the creator's fee address no
    /// longer stops the swaps in a graduated equity pool. The refused leg
    /// becomes a debt in `owed` and the swap goes through.
    ///
    /// THE CLAIM, from the second external audit: non-WETH fees are taken
    /// straight to the recipient inside the swap callback, a B20 transfer asks
    /// the receiver policy, and a blocked receiver reverts - taking the whole
    /// swap with it. The existing restriction tests prove a blocked TRANSFER
    /// is refused; they do not connect that to a SWAP. This does.
    ///
    /// THIS HEADER USED TO SAY "PROOF, NOT A FIX" and that such a pool "cannot
    /// be repaired from inside the product". That was true when the test was
    /// written, and it proved the swap reverted. The body now proves the
    /// opposite, and the header says so. The creator address is still fixed
    /// at launch with no rotation; what changed is that a block costs that
    /// creator a delay and nobody else a trade.
    function test_equityPool_aBlockedCreatorNoLongerStopsEverySwap() public onlyFork {
        address blocked = makeAddr("blocked creator");
        (PoolKey memory key, CurbLaunchToken token,) = _graduatedBy(blocked, TOTAL_TAX_BPS);

        vm.prank(NVDAC_WHALE);
        IERC20(NVDAC).transfer(trader, TRADER_FUNDING);

        // ---- THE CONTROL. The same swap, before anything is blocked. Without
        // this the test below proves only that something reverts.
        uint256 got = _routerSwap(key, NVDAC, address(token), uint128(1e8), 0);
        assertGt(got, 0, "the pool did not work even before the blocklist entry");

        // ---- THE ISSUER BLOCKS THE CREATOR AS A RECEIVER. One entry, on a
        // policy this product does not own and cannot appeal to.
        bytes32 scope = _scopeNamed(NVDAC, "TRANSFER_RECEIVER_POLICY()");
        uint64 policy = _policyFor(NVDAC, scope);
        address[] memory who = new address[](1);
        who[0] = blocked;
        vm.prank(_adminOf(policy));
        (bool set,) = POLICY_REG.call(
            abi.encodeWithSignature("updateBlocklist(uint64,bool,address[])", policy, true, who)
        );
        assertTrue(set, "the registry refused the blocklist update; nothing below was provoked");

        // ---- AND THE SAME SWAP STILL GOES THROUGH.
        //
        // THIS ASSERTED THE OPPOSITE WHEN IT WAS WRITTEN, which is the evidence
        // that AUDIT Y-1 is closed. The fee used to be taken straight to the
        // creator inside the swap, so the issuer's refusal took the swap with
        // it; the refusal is caught now and the leg becomes a debt.
        _approveRouter(NVDAC, uint128(1e8));
        vm.prank(trader);
        (bool ok, bytes memory err) = address(ROUTER).call(
            abi.encodeWithSignature(
                "execute(bytes,bytes[],uint256)",
                abi.encodePacked(V4_SWAP_CMD),
                _swapInputs(key, NVDAC, address(token), uint128(1e8), 0),
                block.timestamp + 60
            )
        );
        assertTrue(ok, "a blocked creator still stops the pool");
        assertFalse(_mentions(err, PolicyForbids.selector), "the swap still ends in PolicyForbids");

        // ---- THE FEE IS OWED, NOT LOST.
        uint256 due = hook.owed(blocked, NVDAC);
        assertGt(due, 0, "the blocked creator's fee was not recorded");

        // ---- AND CLAIMING IS STILL REFUSED WHILE THE BLOCK STANDS, which is
        // the issuer's decision and not this product's to override. What
        // changed is who pays for it: the creator waits, everybody else trades.
        vm.prank(blocked);
        vm.expectRevert();
        hook.claim(NVDAC);
        assertEq(hook.owed(blocked, NVDAC), due, "a refused claim lost the debt");
    }

    /// A CLAIM PAID IN THE TOKEN LEAVES THE NEXT CLAIM OPEN.
    ///
    /// Every successful claim in this file used to leave by the ether exit,
    /// which clears the re-entry guard on its own line. The token exit clears
    /// it on another, and no test ever claimed again after taking it - so
    /// deleting that line, which freezes every claim by every payee after the
    /// first token payout, left the suite green. Here both payees are blocked
    /// so both legs become NVDAc debts, the block is lifted, and they claim
    /// one after the other.
    function test_equityPool_aClaimPaidInTheTokenLeavesTheNextClaimOpen() public onlyFork {
        address blocked = makeAddr("blocked creator, later unblocked");
        (PoolKey memory key, CurbLaunchToken token,) = _graduatedBy(blocked, TOTAL_TAX_BPS);
        vm.prank(NVDAC_WHALE);
        IERC20(NVDAC).transfer(trader, TRADER_FUNDING);

        bytes32 scope = _scopeNamed(NVDAC, "TRANSFER_RECEIVER_POLICY()");
        uint64 policy = _policyFor(NVDAC, scope);
        address[] memory who = new address[](2);
        who[0] = blocked;
        who[1] = protocolRecipient;
        vm.prank(_adminOf(policy));
        (bool set,) = POLICY_REG.call(
            abi.encodeWithSignature("updateBlocklist(uint64,bool,address[])", policy, true, who)
        );
        assertTrue(set, "the registry refused the blocklist update");

        _routerSwap(key, NVDAC, address(token), uint128(1e8), 0);
        uint256 creatorDue = hook.owed(blocked, NVDAC);
        uint256 platformDue = hook.owed(protocolRecipient, NVDAC);
        assertGt(creatorDue, 0, "the creator's leg did not become a debt");
        assertGt(platformDue, 0, "the platform's leg did not become a debt");

        vm.prank(_adminOf(policy));
        (bool lifted,) = POLICY_REG.call(
            abi.encodeWithSignature("updateBlocklist(uint64,bool,address[])", policy, false, who)
        );
        assertTrue(lifted, "the registry refused to lift the block");

        uint256 creatorBefore = IERC20(NVDAC).balanceOf(blocked);
        vm.prank(blocked);
        assertEq(hook.claim(NVDAC), creatorDue, "the first token claim did not pay");
        assertEq(IERC20(NVDAC).balanceOf(blocked) - creatorBefore, creatorDue, "the first claim did not arrive");

        uint256 platformBefore = IERC20(NVDAC).balanceOf(protocolRecipient);
        vm.prank(protocolRecipient);
        assertEq(hook.claim(NVDAC), platformDue, "the claim after a token payout did not pay");
        assertEq(
            IERC20(NVDAC).balanceOf(protocolRecipient) - platformBefore, platformDue,
            "the second claim did not arrive"
        );
    }

    // ================================================================
    // THE r7 LOWS, PINNED (core v2 design, section C).
    // ================================================================

    function _cfgSalted(uint256 n) internal returns (CurbLaunchFactory.LaunchConfig memory cfg) {
        cfg = _config(true);
        cfg.salt = bytes32(n);
        cfg.salt = _saltForSide(cfg, true);
    }

    // ---- C1: the platform recipient is refused on the same list as the creator.
    function test_r9_C1_platformRecipientRefusesEveryOwnContract() public onlyFork {
        vm.prank(creator);
        (CurbLaunchToken launched,) = factory.launch(_cfgSalted(0xA1));
        address[7] memory infra = [
            address(graduator.poolManager()),
            address(graduator.positionManager()),
            address(factory.feePolicy()),
            address(factory.buybackVault()),
            factory.quoteToken(),
            address(PERMIT2),
            address(launched)
        ];
        for (uint256 i = 0; i < infra.length; i++) {
            CurbLaunchFactory.LaunchConfig memory cfg = _cfgSalted(0xB0 + i);
            vm.mockCall(address(hook), abi.encodeWithSignature("platformRecipient()"), abi.encode(infra[i]));
            vm.prank(creator);
            vm.expectRevert(
                abi.encodeWithSelector(CurbLaunchFactory.PlatformRecipientIsInfrastructure.selector, infra[i])
            );
            factory.launch(cfg);
            vm.clearMockedCalls();
        }
        vm.prank(creator);
        factory.launch(_cfgSalted(0xC1));
    }

    // ---- F2: the quote asset, Permit2, launch tokens and the other assets' policy and vault.
    function test_r9_F2_creatorRefusesQuotePermit2LaunchTokensAndOtherAssetsPolicyAndVault() public onlyFork {
        (FeeEscrow aEsc, IPonsV2FeePolicy aPol) = _escrowAndPolicyFor(AAPLC);
        PonsV2BuybackVault aVault =
            new PonsV2BuybackVault(address(this), aPol, IPonsV2FeeEscrow(address(aEsc)));
        CurbLaunchFactory other = new CurbLaunchFactory(
            registry, graduator, AAPLC, aPol, IPonsV2FeeEscrow(address(aEsc)), aVault,
            _terms(IHooks(address(hook)), FEE, TICK_SPACING)
        );
        registry.addLauncher(address(other));

        vm.prank(creator);
        (CurbLaunchToken launched,) = factory.launch(_cfgSalted(0xA2));

        address[5] memory infra =
            [factory.quoteToken(), address(PERMIT2), address(launched), address(aPol), address(aVault)];
        for (uint256 i = 0; i < infra.length; i++) {
            CurbLaunchFactory.LaunchConfig memory cfg = _cfgSalted(0xD0 + i);
            cfg.creatorWallet = infra[i];
            vm.prank(creator);
            vm.expectRevert(abi.encodeWithSelector(CurbLaunchFactory.CreatorIsInfrastructure.selector, infra[i]));
            factory.launch(cfg);
        }
        CurbLaunchFactory.LaunchConfig memory ok = _cfgSalted(0xC2);
        ok.creatorWallet = makeAddr("an ordinary cold wallet");
        vm.prank(creator);
        factory.launch(ok);
    }

    // ---- F3: destinations that would keep the ether are refused.
    function test_r9_F3_withdrawLaunchFeesToRefusesWethQuoteAndSelf() public onlyFork {
        uint256 fee = 0.0005 ether;
        CurbLaunchFactory fac = _factoryCharging(fee);
        address platformTo = hook.platformRecipient();
        vm.etch(platformTo, hex"60006000fd");
        CurbLaunchFactory.LaunchConfig memory cfg = _config(true);
        cfg.salt = _saltForSideOf(fac, cfg, true);
        vm.deal(creator, 1 ether);
        vm.prank(creator);
        fac.launch{value: fee}(cfg);

        uint256 wethBefore = IERC20(WETH9).balanceOf(address(fac));
        address[3] memory bad = [WETH9, fac.quoteToken(), address(fac)];
        for (uint256 i = 0; i < bad.length; i++) {
            vm.prank(platformTo);
            vm.expectRevert(abi.encodeWithSelector(CurbLaunchFactory.DestinationKeepsNoEther.selector, bad[i]));
            fac.withdrawLaunchFeesTo(bad[i]);
        }
        assertEq(fac.unclaimedLaunchFees(platformTo), fee, "a refused destination moved the credit");
        assertEq(IERC20(WETH9).balanceOf(address(fac)), wethBefore, "the factory was given WETH it cannot move");

        address treasury = makeAddr("the platform's treasury");
        vm.prank(platformTo);
        fac.withdrawLaunchFeesTo(treasury);
        assertEq(treasury.balance, fee, "the control withdrawal did not arrive");
    }

    // ---- F7: an unreadable launcher is skipped, and only skipped.
    function test_r9_F7_anUnreadableLauncherIsSkippedNotRefused() public onlyFork {
        CurbLaunchFactory other = _secondFactory();
        registry.addLauncher(address(other));
        bytes memory ask = abi.encodeWithSignature("feeEscrow()");
        address wallet = makeAddr("an ordinary cold wallet");

        // A REVERT: skipped, and the launcher itself is still refused by address.
        vm.mockCallRevert(address(other), ask, "");
        CurbLaunchFactory.LaunchConfig memory cfg = _cfgSalted(0xE1);
        cfg.creatorWallet = wallet;
        vm.prank(creator);
        factory.launch(cfg);
        cfg = _cfgSalted(0xE2);
        cfg.creatorWallet = address(other);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(CurbLaunchFactory.CreatorIsInfrastructure.selector, address(other)));
        factory.launch(cfg);
        vm.clearMockedCalls();

        // A WORD THAT IS NOT AN ADDRESS: skipped.
        vm.mockCall(address(other), ask, abi.encode(type(uint256).max));
        cfg = _cfgSalted(0xE3);
        cfg.creatorWallet = wallet;
        vm.prank(creator);
        factory.launch(cfg);

        // DIRTY UPPER BITS OVER THE CREATOR: not read as the creator.
        vm.mockCall(address(other), ask, abi.encode(uint256(uint160(wallet)) | (uint256(1) << 200)));
        cfg = _cfgSalted(0xE4);
        cfg.creatorWallet = wallet;
        vm.prank(creator);
        factory.launch(cfg);

        // A SHORT REPLY: skipped.
        vm.mockCall(address(other), ask, hex"01");
        cfg = _cfgSalted(0xE5);
        cfg.creatorWallet = wallet;
        vm.prank(creator);
        factory.launch(cfg);
        vm.clearMockedCalls();

        // AND THE CONTROL: answering, its escrow is refused.
        cfg = _cfgSalted(0xE6);
        cfg.creatorWallet = address(other.feeEscrow());
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(CurbLaunchFactory.CreatorIsInfrastructure.selector, address(other.feeEscrow()))
        );
        factory.launch(cfg);
    }

    // ---- F1: a launcher that burns gas or returns megabytes costs a bounded amount.
    function test_r9_F1_aGasBurningOrHugeReplyLauncherDoesNotStopLaunches() public onlyFork {
        CurbLaunchFactory other = _secondFactory();
        registry.addLauncher(address(other));
        address wallet = makeAddr("an ordinary cold wallet");

        CurbLaunchFactory.LaunchConfig memory cfg = _cfgSalted(0xF0);
        cfg.creatorWallet = wallet;
        uint256 g0 = gasleft();
        vm.prank(creator);
        factory.launch(cfg);
        uint256 normal = g0 - gasleft();

        vm.etch(address(other), type(GasBurner).runtimeCode);
        cfg = _cfgSalted(0xF1);
        cfg.creatorWallet = wallet;
        g0 = gasleft();
        vm.prank(creator);
        factory.launch{gas: 3 * normal}(cfg);
        assertLt(g0 - gasleft(), normal + 200_000, "a gas-burning launcher cost more than its cap");

        vm.etch(address(other), type(HugeReturner).runtimeCode);
        cfg = _cfgSalted(0xF2);
        cfg.creatorWallet = wallet;
        g0 = gasleft();
        vm.prank(creator);
        factory.launch{gas: 3 * normal}(cfg);
        assertLt(g0 - gasleft(), normal + 200_000, "a huge reply was copied");
    }

    // ---- F1, the hook's sibling: the PositionManager is refused as the platform payee.
    function test_r9_F1hook_theHookRefusesThePositionManagerAsThePlatformRecipient() public onlyFork {
        address posm = address(graduator.positionManager());
        vm.expectRevert(abi.encodeWithSelector(FeeHook.RecipientIsDeploymentContract.selector, posm));
        hook.announcePlatformRecipient(posm);
        assertEq(hook.pendingRecipientReadyAt(), 0, "a refused announcement left something pending");
        address fine = makeAddr("an ordinary platform recipient");
        hook.announcePlatformRecipient(fine);
        assertEq(hook.pendingRecipient(), fine, "an ordinary recipient was refused");
    }

    // ---- F1, the hook's sibling: a launcher that misbehaves cannot stop an announcement.
    function test_r9_F1hook_aGasBurningOrHugeReplyLauncherDoesNotStopAnnouncements() public onlyFork {
        CurbLaunchFactory other = _secondFactory();
        registry.addLauncher(address(other));
        address fine = makeAddr("an ordinary platform recipient");

        uint256 g0 = gasleft();
        hook.announcePlatformRecipient(fine);
        uint256 normal = g0 - gasleft();
        hook.cancelPlatformRecipient();

        // A REVERT: skipped, not obeyed.
        vm.mockCallRevert(address(other), abi.encodeWithSignature("feeEscrow()"), "");
        hook.announcePlatformRecipient(fine);
        hook.cancelPlatformRecipient();
        vm.clearMockedCalls();

        vm.etch(address(other), type(GasBurner).runtimeCode);
        g0 = gasleft();
        hook.announcePlatformRecipient{gas: normal + 400_000}(fine);
        assertLt(g0 - gasleft(), normal + 100_000, "a gas-burning launcher cost more than its cap");
        hook.cancelPlatformRecipient();

        vm.etch(address(other), type(HugeReturner).runtimeCode);
        g0 = gasleft();
        hook.announcePlatformRecipient{gas: normal + 400_000}(fine);
        assertLt(g0 - gasleft(), normal + 100_000, "a huge reply was copied");
        assertEq(hook.pendingRecipient(), fine, "the announcement did not land");
    }

    // ================================================================
    // launchedAt IN THE RECORD AND THE VIEW (core v2 design, section B).
    // ================================================================

    /// THE REGISTRY'S CLOCK, NEVER THE LAUNCHER'S. A launch made through the
    /// factory is stamped with the block's time, and a launcher that passes a
    /// value of its own - zero, one, the largest uint64 - has it overwritten.
    function test_launchedAt_isTheRegistrysClockEvenWhenTheLauncherPassesAnother() public onlyFork {
        vm.warp(vm.getBlockTimestamp() + 1234);
        (, CurbLaunchToken token) = _launch(true);
        LaunchRegistry.Launch memory rec = registry.launchOf(address(token));
        assertEq(rec.launchedAt, uint64(vm.getBlockTimestamp()), "a factory launch was not stamped with the block time");

        uint64[2] memory lies = [uint64(1), type(uint64).max];
        for (uint256 i = 0; i < lies.length; i++) {
            vm.warp(vm.getBlockTimestamp() + 7);
            address other = makeAddr(string(abi.encodePacked("a directly registered token ", vm.toString(i))));
            rec.curve = _recordCurve(other, rec.quoteToken, address(graduator));
            rec.launchedAt = lies[i];
            vm.prank(address(factory));
            registry.register(other, rec);
            assertEq(
                registry.launchOf(other).launchedAt,
                uint64(vm.getBlockTimestamp()),
                "the launcher's own launchedAt was kept"
            );
        }
    }

    /// AND IT COSTS NO STORAGE SLOT: it packs into the record's seventh slot
    /// beside platformRecipient, and the slot after it stays empty.
    function test_launchedAt_packsBesidePlatformRecipientInTheRecordsLastSlot() public onlyFork {
        vm.warp(vm.getBlockTimestamp() + 99);
        (, CurbLaunchToken token) = _launch(true);
        LaunchRegistry.Launch memory rec = registry.launchOf(address(token));

        // The mapping's slot is found rather than assumed: the record's first
        // word is the curve.
        bytes32 base;
        bool found;
        for (uint256 slot = 0; slot < 64 && !found; slot++) {
            bytes32 b = keccak256(abi.encode(address(token), slot));
            if (vm.load(address(registry), b) == bytes32(uint256(uint160(rec.curve)))) {
                base = b;
                found = true;
            }
        }
        assertTrue(found, "the record's storage was not found");
        uint256 w6 = uint256(vm.load(address(registry), bytes32(uint256(base) + 6)));
        assertEq(address(uint160(w6)), rec.platformRecipient, "slot 6 does not hold platformRecipient");
        assertEq(uint64(w6 >> 160), rec.launchedAt, "slot 6 does not hold launchedAt beside it");
        assertEq(rec.launchedAt, uint64(vm.getBlockTimestamp()), "the stamp is not the block time");
        assertEq(w6 >> 224, 0, "slot 6 holds something else too");
        assertEq(vm.load(address(registry), bytes32(uint256(base) + 7)), bytes32(0), "the record grew a slot");
    }

    function _rawLaunchState(address launchToken) internal view returns (bytes memory raw) {
        bool ok;
        (ok, raw) = address(lens).staticcall(abi.encodeCall(LaunchLens.launchState, (launchToken)));
        assertTrue(ok, "launchState reverted");
    }

    function _word(bytes memory raw, uint256 i) internal pure returns (uint256 w) {
        // memory-safe: a plain assembly block anywhere in this contract turns
        // off via-IR's stack-to-memory mover for all of it.
        assembly ("memory-safe") {
            w := mload(add(add(raw, 0x20), mul(i, 0x20)))
        }
    }

    /// THE VIEW IS SIXTEEN WORDS, AND WORDS 14 AND 15 ARE launchedAt AND THE
    /// HOLDER DISTRIBUTOR - in every status, read by position the way the page
    /// reads them, and the same in launchPage.
    function test_lens_wordsFourteenAndFifteenAreLaunchedAtAndTheDistributor() public onlyFork {
        bytes memory raw = _rawLaunchState(makeAddr("never launched"));
        assertEq(raw.length, 16 * 32, "the view is not sixteen words");
        assertEq(_word(raw, 0), uint256(LaunchLens.LaunchStatus.NotFound), "not NotFound");
        assertEq(_word(raw, 14), 0, "an unknown token has a launch time");
        assertEq(_word(raw, 15), 0, "an unknown token has a distributor");

        vm.warp(vm.getBlockTimestamp() + 77);
        uint256 before = registry.launchCount();
        (PonsV2BondingCurve curve, CurbLaunchToken token) = _launch(true);
        uint64 at = registry.launchOf(address(token)).launchedAt;
        assertEq(at, uint64(vm.getBlockTimestamp()), "the record was not stamped");

        raw = _rawLaunchState(address(token));
        assertEq(raw.length, 16 * 32, "the view is not sixteen words");
        assertEq(_word(raw, 0), uint256(LaunchLens.LaunchStatus.Selling), "not Selling");
        assertEq(_word(raw, 1), uint256(uint160(address(curve))), "word 1 moved");
        assertEq(_word(raw, 14), at, "word 14 is not launchedAt while Selling");
        assertEq(_word(raw, 15), 0, "word 15 is set while sharing is off");

        vm.warp(vm.getBlockTimestamp() + 50);
        _fillWithoutGraduating(curve);
        raw = _rawLaunchState(address(token));
        assertEq(_word(raw, 0), uint256(LaunchLens.LaunchStatus.Waiting), "not Waiting");
        assertEq(_word(raw, 14), at, "word 14 is not launchedAt while Waiting");
        assertEq(_word(raw, 15), 0, "word 15 is set while sharing is off");

        graduator.graduate(address(token));
        raw = _rawLaunchState(address(token));
        assertEq(_word(raw, 0), uint256(LaunchLens.LaunchStatus.Graduated), "not Graduated");
        assertEq(_word(raw, 14), at, "word 14 is not launchedAt once Graduated");
        assertEq(_word(raw, 15), 0, "word 15 is set while sharing is off");

        (, LaunchLens.LaunchView[] memory views) = lens.launchPage(before, 1);
        assertEq(views[0].launchedAt, at, "launchPage does not carry launchedAt");
        assertEq(views[0].holderDistributor, address(0), "launchPage carries a distributor while sharing is off");
    }
}
