// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";

import {PositionLock, IPositionManagerMinimal} from "../../src/curb/PositionLock.sol";
import {PositionLockFactory} from "../harness/PositionLockFactory.sol";
import {PoolHarness, MemeToken} from "./B20UniswapV4.t.sol";
import {B20ForkTest} from "./B20ForkTest.sol";

interface IPositionManagerLike {
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
    function nextTokenId() external view returns (uint256);
    function getPositionLiquidity(uint256 tokenId) external view returns (uint128);
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/**
 * @title B20PositionLockForkTest
 * @notice Is the lock actually a lock?
 *
 * Minting a position (B20PositionManager.t.sol) only produced a transferable
 * NFT. "Liquidity is locked" is a claim about what CANNOT happen, and a test
 * that only shows the happy path proves none of it. So most of this file is
 * negative: who is refused, when, and with which error.
 *
 * ACCEPTANCE CRITERIA
 *   1. once locked, the FORMER owner cannot touch the position - not withdraw
 *      it, not decrease its liquidity through PositionManager
 *   2. NOBODY CAN EVER TAKE IT OUT: no caller - the beneficiary, the launcher,
 *      the lock's deployer, a stranger - through any call, now or after ten
 *      years. The lock has no unlock time and no withdrawal at all.
 *   3. fees ARE claimable, for good, and claiming them leaves the principal
 *      liquidity untouched to the unit
 *   4. the lock cannot be filled by a position it was not built for - not a
 *      different token id, not one from a different pool
 */
contract B20PositionLockForkTest is B20ForkTest {
    IPoolManager internal constant POOL_MANAGER = IPoolManager(0x498581fF718922c3f8e6A244956aF099B2652b2b);
    IPositionManagerLike internal constant POSM = IPositionManagerLike(0x7C5f5A4bBd8fD63184577525326123B519429bDc);
    IPermit2 internal constant PERMIT2 = IPermit2(0x000000000022D473030F116dDEE9F6B43aC78BA3);

    address internal constant NVDAC = 0xb20000000000000000000078ee7ce2fE4908108C;
    address internal constant NVDAC_HOLDER = 0x4446Adc0B8136Ffc55DdB7a488Ba5509Ace2A5ef;

    uint24 internal constant FEE = 3000;
    int24 internal constant TICK_SPACING = 60;
    uint160 internal constant SQRT_PRICE_1_1 = 79228162514264337593543950336;
    uint256 internal constant MINT_LIQUIDITY = 1e8;
    uint256 internal constant TEN_YEARS = 10 * 365 days;
    uint256 internal constant SWAP_IN = 1e6;

    /// This position is the pool's ONLY liquidity, so it earns the whole LP
    /// fee: FEE is in hundredths of a bip, so 3000 is 0.30% of 1e6 = 3000 raw.
    /// One direction comes back a unit short because fee growth is tracked as
    /// a per-liquidity X128 value and the collected amount rounds down.
    uint256 internal constant EXPECTED_FEE_EXACT = 3000;
    uint256 internal constant EXPECTED_FEE_ROUNDED = 2999;

    address internal launcher = makeAddr("launcher");
    address internal creator = makeAddr("creator");
    address internal stranger = makeAddr("stranger");

    MemeToken internal meme;
    PoolHarness internal harness;
    PoolKey internal key;
    PositionLockFactory internal factory;
    PositionLock internal lock;
    uint256 internal tokenId;
    int24 internal tickLower;
    int24 internal tickUpper;

    function setUp() public {
        if (!_forkGuard()) return;

        harness = new PoolHarness(POOL_MANAGER);
        meme = new MemeToken(launcher, 1_000_000e18);

        bool nvdacIsCurrency0 = NVDAC < address(meme);
        key = PoolKey({
            currency0: Currency.wrap(nvdacIsCurrency0 ? NVDAC : address(meme)),
            currency1: Currency.wrap(nvdacIsCurrency0 ? address(meme) : NVDAC),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(0))
        });
        POOL_MANAGER.initialize(key, SQRT_PRICE_1_1);

        tickLower = (TickMath.MIN_TICK / TICK_SPACING) * TICK_SPACING;
        tickUpper = (TickMath.MAX_TICK / TICK_SPACING) * TICK_SPACING;

        vm.prank(NVDAC_HOLDER);
        IERC20(NVDAC).transfer(launcher, 5e8);

        // The launcher mints the position, then locks it for the creator. This
        // is the shape the launchpad will use: whoever seeds the pool is not
        // who ends up with it.
        tokenId = POSM.nextTokenId();
        _mint(MINT_LIQUIDITY, launcher);

        // Created and deposited in ONE call. Two transactions would leave a
        // window in which the empty lock exists and the position has not
        // arrived - which is exactly the window a third party would use.
        factory = new PositionLockFactory();

        vm.startPrank(launcher);
        IERC721(address(POSM)).approve(address(factory), tokenId);
        lock = factory.createAndLock(IPositionManagerMinimal(address(POSM)), creator, key, tokenId);
        vm.stopPrank();

        // Someone to trade against, so fees exist to claim.
        vm.prank(NVDAC_HOLDER);
        IERC20(NVDAC).transfer(address(harness), 1e8);
        vm.prank(launcher);
        meme.transfer(address(harness), 1e18);
    }

    function test_lockTookCustodyOfTheRealPosition() public onlyFork {
        assertEq(IERC721(address(POSM)).ownerOf(tokenId), address(lock), "the lock does not own the position");
        assertTrue(lock.holdsPosition(), "the lock does not think it holds anything");
        assertEq(lock.tokenId(), tokenId, "the lock recorded a different token id");
        assertEq(lock.lockedLiquidity(), uint128(MINT_LIQUIDITY), "the locked liquidity is not what was minted");
    }

    /// Criterion 1. The launcher parted with it. Ownership is the only thing
    /// PositionManager checks, so this is the assertion that the lock is real.
    function test_formerOwnerCannotRemoveLiquidity() public onlyFork {
        vm.prank(launcher);
        vm.expectRevert(abi.encodeWithSignature("NotApproved(address)", launcher));
        POSM.modifyLiquidities(_decreaseCalldata(tokenId, MINT_LIQUIDITY, launcher), block.timestamp + 60);

        assertEq(lock.lockedLiquidity(), uint128(MINT_LIQUIDITY), "liquidity moved despite the call reverting");
    }

    /// The position, whole and where it was locked. The same check after
    /// every attempt below.
    function _intact(string memory when) internal view {
        assertEq(IERC721(address(POSM)).ownerOf(tokenId), address(lock), string.concat("the position left the lock ", when));
        assertEq(POSM.getPositionLiquidity(tokenId), uint128(MINT_LIQUIDITY), string.concat("liquidity left ", when));
        assertEq(IERC721(address(POSM)).getApproved(tokenId), address(0), string.concat("the lock approved someone ", when));
        assertTrue(lock.holdsPosition(), string.concat("the lock let go ", when));
    }

    /// Every caller, every call this lock has or ever had.
    function _tryEverything() internal {
        address[5] memory callers = [creator, launcher, stranger, address(this), address(factory)];
        for (uint256 c = 0; c < callers.length; c++) {
            bytes[6] memory calls = [
                abi.encodeWithSignature("withdraw()"),
                abi.encodeWithSignature(
                    "withdrawLiquidity(uint128,uint128,address,uint256)", 0, 0, callers[c], type(uint256).max
                ),
                abi.encodeWithSignature("claimFees()"),
                abi.encodeWithSignature("release(address)", callers[c]),
                abi.encodeWithSignature("onERC721Received(address,address,uint256,bytes)", callers[c], callers[c], tokenId, ""),
                abi.encodeWithSignature("unlockTime()")
            ];
            for (uint256 k = 0; k < calls.length; k++) {
                vm.prank(callers[c]);
                (bool ok,) = address(lock).call(calls[k]);
                ok;
            }
            assertFalse(
                IERC721(address(POSM)).isApprovedForAll(address(lock), callers[c]), "the lock approved an operator"
            );
        }
    }

    /// Criterion 2. Including the address that deployed the lock - which is
    /// this test contract, i.e. the party with the most reason to expect a way
    /// back in - and the beneficiary, after ten years. There is none.
    function test_nobodyCanEverTakeTheLiquidityOut() public onlyFork {
        _generateFees();
        _tryEverything();
        _intact("at once");

        vm.warp(vm.getBlockTimestamp() + TEN_YEARS);
        _tryEverything();
        _intact("after ten years");

        // Nor through PositionManager directly, by anyone, then.
        address[3] memory who = [creator, launcher, stranger];
        for (uint256 i = 0; i < who.length; i++) {
            vm.prank(who[i]);
            vm.expectRevert(abi.encodeWithSignature("NotApproved(address)", who[i]));
            POSM.modifyLiquidities(_decreaseCalldata(tokenId, MINT_LIQUIDITY, who[i]), vm.getBlockTimestamp() + 60);
            vm.prank(who[i]);
            vm.expectRevert();
            IERC721(address(POSM)).transferFrom(address(lock), who[i], tokenId);
        }
        _intact("after ten years of asking PositionManager");
    }

    /// Criterion 2, with calldata nobody chose: any caller, any bytes, any time
    /// up to ten years out.
    function testFuzz_noCallTakesTheLiquidityOut(address caller, bytes calldata data, uint32 dt) public onlyFork {
        vm.warp(vm.getBlockTimestamp() + bound(dt, 0, TEN_YEARS));
        _generateFees();
        vm.prank(caller);
        (bool ok,) = address(lock).call(data);
        ok;
        _intact("after an arbitrary call");
    }

    /// Criterion 3. A lock that also freezes the creator's fee income is a
    /// worse product, so fees must flow - and must not be a way out.
    function test_feesAreClaimableWhilePrincipalIsNot() public onlyFork {
        _generateFees();

        uint256 nvdacBefore = IERC20(NVDAC).balanceOf(creator);
        uint256 memeBefore = meme.balanceOf(creator);

        lock.claimFees();

        uint256 nvdacGained = IERC20(NVDAC).balanceOf(creator) - nvdacBefore;
        uint256 memeGained = meme.balanceOf(creator) - memeBefore;

        emit log_named_uint("creator NVDAc fees", nvdacGained);
        emit log_named_uint("creator MEME fees ", memeGained);

        // Exact, not "more than zero". The fee rate, the swap size and the fact
        // that this position holds all the liquidity fix these numbers; a
        // greater-than-zero check would pass on any of them being wrong.
        assertEq(nvdacGained, EXPECTED_FEE_EXACT, "NVDAc fee is not 0.30% of the swap input");
        assertEq(memeGained, EXPECTED_FEE_ROUNDED, "MEME fee is not 0.30% of the swap input, less the rounding");

        // The point of the test: the principal did not move by one unit.
        _intact("after claiming fees");

        // And ten years on the fees still flow, to the same party, and the
        // principal still does not.
        vm.warp(vm.getBlockTimestamp() + TEN_YEARS);
        _generateFees();
        nvdacBefore = IERC20(NVDAC).balanceOf(creator);
        vm.prank(stranger);
        lock.claimFees();
        assertGt(IERC20(NVDAC).balanceOf(creator) - nvdacBefore, 0, "no fees ten years on");
        assertEq(IERC20(NVDAC).balanceOf(stranger), 0, "the caller was paid");
        _intact("after claiming fees ten years on");
    }

    /// The lock is single-use.
    function test_lockRefusesASecondPosition() public onlyFork {
        uint256 secondId = POSM.nextTokenId();
        _mint(MINT_LIQUIDITY, launcher);

        // A lock that already holds something refuses on the single-use rule -
        // that check comes first, so the identity check is not even reached.
        // On an EMPTY lock the order is reversed and WrongPosition fires; that
        // is the squatting case, covered by its own test above.
        vm.prank(launcher);
        vm.expectRevert(PositionLock.OnlyOnePosition.selector);
        IERC721(address(POSM)).safeTransferFrom(launcher, address(lock), secondId);
        assertEq(IERC721(address(POSM)).ownerOf(secondId), launcher, "the second position was taken anyway");
    }

    /// Criterion 4. The original version checked only that the NFT came from
    /// the right PositionManager. Any holder of any position from that same
    /// PositionManager could therefore have filled a single-use lock with
    /// something nobody asked for, leaving the intended position homeless.
    function test_lockRefusesAPositionItWasNotBuiltFor() public onlyFork {
        uint256 otherId = POSM.nextTokenId();
        _mint(MINT_LIQUIDITY, launcher);

        // A lock that has not yet received anything - the state a squatter
        // would target.
        uint256 pendingId = POSM.nextTokenId();
        PositionLock pending =
            new PositionLock(IPositionManagerMinimal(address(POSM)), creator, key, pendingId, address(0), address(0));

        vm.prank(launcher);
        vm.expectRevert(abi.encodeWithSelector(PositionLock.WrongPosition.selector, pendingId, otherId));
        IERC721(address(POSM)).safeTransferFrom(launcher, address(pending), otherId);

        assertFalse(pending.holdsPosition(), "the lock accepted a position it was not built for");
        assertEq(IERC721(address(POSM)).ownerOf(otherId), launcher, "the squatting position was taken anyway");
    }

    /// Criterion 4. The right token id in the WRONG pool. A token id says
    /// nothing about where the liquidity is, and the pool is what the lock's
    /// whole claim is about.
    function test_lockRefusesAPositionFromAnotherPool() public onlyFork {
        PoolKey memory otherPool = key;
        otherPool.fee = 500;
        POOL_MANAGER.initialize(otherPool, SQRT_PRICE_1_1);

        uint256 otherId = POSM.nextTokenId();
        _mintInPool(otherPool, MINT_LIQUIDITY, launcher);

        PositionLock pending =
            new PositionLock(IPositionManagerMinimal(address(POSM)), creator, key, otherId, address(0), address(0));

        vm.prank(launcher);
        vm.expectRevert(
            abi.encodeWithSelector(
                PositionLock.WrongPool.selector,
                bytes25(keccak256(abi.encode(key))),
                bytes25(keccak256(abi.encode(otherPool)))
            )
        );
        IERC721(address(POSM)).safeTransferFrom(launcher, address(pending), otherId);

        assertFalse(pending.holdsPosition(), "the lock accepted a position from a different pool");
    }

    /// A lock whose beneficiary is address(0) would bury the position and every
    /// fee it ever earns. Refused at construction rather than discovered later.
    function test_lockRejectsAZeroBeneficiary() public onlyFork {
        vm.expectRevert(PositionLock.BeneficiaryIsZero.selector);
        new PositionLock(IPositionManagerMinimal(address(POSM)), address(0), key, tokenId, address(0), address(0));
    }

    // ------------------------------------------------------------------

    function _mint(uint256 liquidity, address owner) internal {
        _mintInPool(key, liquidity, owner);
    }

    function _mintInPool(PoolKey memory poolKey, uint256 liquidity, address owner) internal {
        address token0 = Currency.unwrap(poolKey.currency0);
        address token1 = Currency.unwrap(poolKey.currency1);

        vm.startPrank(owner);
        IERC20(token0).approve(address(PERMIT2), type(uint256).max);
        IERC20(token1).approve(address(PERMIT2), type(uint256).max);
        PERMIT2.approve(token0, address(POSM), type(uint160).max, uint48(block.timestamp + 3600));
        PERMIT2.approve(token1, address(POSM), type(uint160).max, uint48(block.timestamp + 3600));

        bytes memory actions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] =
            abi.encode(poolKey, tickLower, tickUpper, liquidity, type(uint128).max, type(uint128).max, owner, bytes(""));
        params[1] = abi.encode(poolKey.currency0, poolKey.currency1);

        POSM.modifyLiquidities(abi.encode(actions, params), block.timestamp + 60);
        vm.stopPrank();
    }

    function _decreaseCalldata(uint256 id, uint256 liquidity, address recipient)
        internal
        view
        returns (bytes memory)
    {
        bytes memory actions = abi.encodePacked(uint8(Actions.DECREASE_LIQUIDITY), uint8(Actions.TAKE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(id, liquidity, uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1, recipient);
        return abi.encode(actions, params);
    }

    /// Both directions, so fees accrue in both currencies.
    function _generateFees() internal {
        harness.swap(key, true, -int256(SWAP_IN));
        harness.swap(key, false, -int256(SWAP_IN));
    }
}
