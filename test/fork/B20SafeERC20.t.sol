// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {B20ForkTest} from "./B20ForkTest.sol";
import {DeployCurb} from "../../script/DeployCurb.s.sol";
import {DepthProbe} from "./B20MultiAsset.t.sol";

interface IERC20Decimals {
    function decimals() external view returns (uint8);
}

/**
 * @title B20SafeERC20ForkTest
 * @notice Does OpenZeppelin's SafeERC20 do the right thing against a real B20
 *         token, and what does a FAILED B20 movement actually look like?
 *
 * WHY THIS IS NOT OBVIOUS. SafeERC20 exists because ERC-20 return values are
 * inconsistent, and its fallback for a call that returns NOTHING is
 * `extcodesize(token) > 0` - it reads an empty return from an address with code
 * as success, and from an address without code as failure. B20 tokens are not
 * ordinary contracts: NVDAc's code is a SINGLE byte. One byte is not zero, so
 * the check passes, but that is a fact about this deployment rather than
 * anything the library promises, and nothing here had checked it.
 *
 * THE PART THAT CHANGES HOW WE WRITE CODE. A B20 movement that cannot happen
 * does not return false - it REVERTS, with B20's own custom errors, and
 * SafeERC20 bubbles them unchanged. So SafeERC20FailedOperation is NOT what a
 * caller sees, and code that catches it to detect a failed NVDAc movement would
 * never fire. The vendored curve moves the whole quote side through SafeERC20,
 * so this is the failure mode our error handling has to be written against.
 *
 * WHERE vm.expectRevert DOES NOT WORK HERE, AND WHERE IT DOES. It produced a
 * WRONG ANSWER before this was understood: three of these tests appeared to
 * show SafeERC20 swallowing the token's error and reverting with
 * SafeERC20FailedOperation instead.
 *
 *   The cheatcode hooks the next call one frame below the test. SafeERC20's
 *   functions are internal, so a direct `nvdac.safeTransfer(...)` is INLINED
 *   into the test contract and the call one frame below is the TOKEN call
 *   itself - the very call the wrapper is about to inspect. Hooked there, the
 *   wrapper produced SafeERC20FailedOperation, which the unhooked code never
 *   produces: same call, same token, the cheatcode the only difference.
 *
 *   Put an external boundary in between and the hooked call is the helper,
 *   with the token call a frame deeper and untouched - and expectRevert then
 *   matches the error the wrapper bubbled.
 *   test_expectRevertMatchesAcrossAnExternalBoundary is that case, so the
 *   narrower rule is a test rather than a claim: not "expectRevert cannot
 *   assert a revert a wrapper inspects", but "not when the wrapper is inlined
 *   into the test".
 *
 *   The failures below are still captured from a real call and compared BYTE
 *   FOR BYTE, because that pins every argument as well as the selector, which
 *   expectRevert with a bare selector does not.
 *
 * WHAT THIS DOES NOT ESTABLISH. B20 is an issuer-controlled asset. Nothing here
 * exercises an issuer restriction - a frozen account, a paused token, a
 * transfer refused for a compliance reason - because at this fork point we have
 * no address in that condition. The last test shows that an ORDINARY fresh
 * address can receive and send at this block; it says nothing about what the
 * issuer can do to one, and ROADMAP keeps that open.
 */
contract B20SafeERC20ForkTest is B20ForkTest {
    using SafeERC20 for IERC20;

    address internal constant NVDAC = 0xb20000000000000000000078ee7ce2fE4908108C;
    /// Holds ~5,797 NVDAc at the pinned block.
    address internal constant NVDAC_WHALE = 0x853F5f1B92b16714Fe6CDA67CAad0856B83C7ab9;

    uint256 internal constant ONE = 1e8; // NVDAc has 8 decimals


    // B20's OWN errors, recovered from the selectors it reverts with. They are
    // NOT OpenZeppelin's: ERC20InsufficientBalance is 0xe450d38c, and what
    // NVDAc actually returns is 0xdb42144d.
    error InsufficientBalance(address account, uint256 balance, uint256 needed);
    error InsufficientAllowance(address spender, uint256 allowance, uint256 needed);
    error InvalidReceiver(address receiver);

    IERC20 internal nvdac = IERC20(NVDAC);
    address internal recipient = address(uint160(uint256(keccak256("curb.safeerc20.recipient"))));
    address internal spender = address(uint160(uint256(keccak256("curb.safeerc20.spender"))));

    function setUp() public {
        if (!_forkGuard()) return;
        // 100 NVDAc to this contract, so every case below is about SafeERC20
        // rather than about funding.
        vm.prank(NVDAC_WHALE);
        nvdac.transfer(address(this), 100 * ONE);
    }

    // ------------------------------------------------------------------ shape

    /// The one byte that decides whether SafeERC20's no-return-data fallback
    /// reads as success or as a failed operation.
    function test_theTokenIsOneByteOfCode() public onlyFork {
        assertEq(NVDAC.code.length, 1, "NVDAc is not a one-byte contract any more");
        assertEq(uint8(NVDAC.code[0]), 0xef, "the single code byte is not 0xef");
        assertEq(IERC20Decimals(NVDAC).decimals(), 8, "decimals moved");
    }

    /// ...and the three mutating calls this file exercises - transfer, approve
    /// and transferFrom - never reach it, because each returns a full word of
    /// `true`. Checked on the RAW call, which is the only place the return
    /// shape is visible at all. It says nothing about entry points not called
    /// here.
    function test_transferApproveAndTransferFromEachReturnOneWordOfTrue() public onlyFork {
        _assertReturnsTrue(abi.encodeCall(IERC20.transfer, (recipient, ONE)), "transfer");
        _assertReturnsTrue(abi.encodeCall(IERC20.approve, (spender, ONE)), "approve");

        vm.prank(NVDAC_WHALE);
        nvdac.approve(address(this), ONE);
        _assertReturnsTrue(abi.encodeCall(IERC20.transferFrom, (NVDAC_WHALE, recipient, ONE)), "transferFrom");
    }

    // -------------------------------------------------------- the happy paths

    function test_safeTransferMovesExactlyTheAmount() public onlyFork {
        uint256 fromBefore = nvdac.balanceOf(address(this));
        uint256 toBefore = nvdac.balanceOf(recipient);

        nvdac.safeTransfer(recipient, 7 * ONE);

        assertEq(nvdac.balanceOf(address(this)), fromBefore - 7 * ONE, "the sender's balance is wrong");
        assertEq(nvdac.balanceOf(recipient), toBefore + 7 * ONE, "the recipient's balance is wrong");
    }

    function test_safeTransferFromSpendsExactlyTheAllowance() public onlyFork {
        vm.prank(NVDAC_WHALE);
        nvdac.approve(address(this), 10 * ONE);

        uint256 whaleBefore = nvdac.balanceOf(NVDAC_WHALE);
        uint256 toBefore = nvdac.balanceOf(recipient);

        nvdac.safeTransferFrom(NVDAC_WHALE, recipient, 4 * ONE);

        assertEq(nvdac.balanceOf(NVDAC_WHALE), whaleBefore - 4 * ONE, "the payer's balance is wrong");
        assertEq(nvdac.balanceOf(recipient), toBefore + 4 * ONE, "the recipient's balance is wrong");
        assertEq(nvdac.allowance(NVDAC_WHALE, address(this)), 6 * ONE, "the allowance was not spent exactly");
    }

    /// The USDT problem - an approve that reverts unless the allowance is set
    /// to zero first - does not apply here. forceApprove tries the direct
    /// approve and only falls back to reset-then-set if it fails; the raw call
    /// below shows the direct one succeeds, so that fallback is dead weight
    /// against this token rather than a requirement of it.
    function test_forceApproveOverwritesANonZeroAllowanceDirectly() public onlyFork {
        nvdac.forceApprove(spender, 5 * ONE);
        assertEq(nvdac.allowance(address(this), spender), 5 * ONE, "the first approval did not stick");

        (bool ok, bytes memory ret) = NVDAC.call(abi.encodeCall(IERC20.approve, (spender, 9 * ONE)));
        assertTrue(ok, "a raw non-zero-over-non-zero approve reverted");
        assertTrue(abi.decode(ret, (bool)), "a raw non-zero-over-non-zero approve returned false");
        assertEq(nvdac.allowance(address(this), spender), 9 * ONE, "the overwrite did not stick");

        nvdac.forceApprove(spender, 3 * ONE);
        assertEq(nvdac.allowance(address(this), spender), 3 * ONE, "forceApprove did not overwrite");
    }

    /// THE SAME PROPERTY, ON EVERY ASSET THE PRODUCT ACTUALLY ENABLES - read from
    /// DeployCurb's own list, not retyped.
    ///
    /// WHAT IT NO LONGER CARRIES: Graduator._mint used to approve Permit2 with
    /// a raw approve and no reset, and this test was the only thing licensing
    /// that - on THREE of the eleven assets of the day while claiming all of
    /// them. The mint now uses forceApprove, so a USDT-shaped asset no longer
    /// strands a full curve whatever this says; that is proven against such a
    /// token in B20MultiAsset. What this still measures is which path
    /// forceApprove takes on each shipped asset: the direct one, with no reset.
    ///
    /// ONE POLICY AND ONE ADMIN ACROSS THE THIRTEEN EQUITIES IS AN ARGUMENT
    /// that they share an implementation. It is not a measurement that they
    /// do, and this is measured instead - and seven of the fourteen are not
    /// equities at all: WETH, the three Coinbase-wrapped coins, and since
    /// 2026-10-15 Circle's USDC and the plain ERC-20s VIRTUAL and AERO.
    function test_nonZeroOverNonZeroApproveWorksOnEveryEnabledAsset() public onlyFork {
        DeployCurb.Asset[] memory shipped = new DepthProbe().assets();
        assertEq(shipped.length, 14, "the deployment's asset list changed size - re-read this test");
        for (uint256 i = 0; i < shipped.length; i++) {
            address a = shipped[i].quote;
            string memory name = shipped[i].label;
            IERC20 asset = IERC20(a);

            (bool first, bytes memory r1) = a.call(abi.encodeCall(IERC20.approve, (spender, 5 * ONE)));
            assertTrue(first, string.concat(name, ": the first approve reverted"));
            assertTrue(abi.decode(r1, (bool)), string.concat(name, ": the first approve returned false"));
            assertEq(asset.allowance(address(this), spender), 5 * ONE, string.concat(name, ": it did not stick"));

            // THE ONE THAT DECIDES IT: non-zero written over non-zero, raw,
            // with no reset in between.
            (bool second, bytes memory r2) = a.call(abi.encodeCall(IERC20.approve, (spender, 9 * ONE)));
            assertTrue(second, string.concat(name, ": non-zero over non-zero REVERTED"));
            assertTrue(abi.decode(r2, (bool)), string.concat(name, ": the overwrite returned false"));
            assertEq(
                asset.allowance(address(this), spender), 9 * ONE,
                string.concat(name, ": the overwrite did not take effect")
            );
        }
    }

    function test_increaseAndDecreaseAllowanceAreExact() public onlyFork {
        nvdac.forceApprove(spender, 0);
        nvdac.safeIncreaseAllowance(spender, 11 * ONE);
        assertEq(nvdac.allowance(address(this), spender), 11 * ONE, "increase is wrong");
        nvdac.safeDecreaseAllowance(spender, 4 * ONE);
        assertEq(nvdac.allowance(address(this), spender), 7 * ONE, "decrease is wrong");
    }

    // -------------------------------------------------------- what failure IS

    /// THE FINDING, on both sides of the wrapper: the token reverts with its
    /// own error, and SafeERC20 hands that error through untouched.
    function test_aFailedTransferCarriesTheTokensOwnErrorThroughSafeERC20() public onlyFork {
        uint256 held = nvdac.balanceOf(address(this));
        bytes memory expected = abi.encodeWithSelector(InsufficientBalance.selector, address(this), held, held + 1);

        // Raw, so the error is the token's and nothing else's.
        (bool rawOk, bytes memory rawRet) = NVDAC.call(abi.encodeCall(IERC20.transfer, (recipient, held + 1)));
        assertFalse(rawOk, "an over-balance transfer succeeded");
        assertEq(rawRet, expected, "the raw error is not InsufficientBalance with these arguments");

        // And through SafeERC20: the same bytes, unchanged.
        bytes memory wrapped = _revertDataOf(abi.encodeCall(this.callSafeTransfer, (recipient, held + 1)));
        assertEq(wrapped, expected, "SafeERC20 did not pass the token's error through unchanged");

        // Which is the point: this is NOT the library's own error.
        assertTrue(
            bytes4(wrapped) != SafeERC20.SafeERC20FailedOperation.selector,
            "it reverted with SafeERC20FailedOperation after all"
        );
        assertEq(nvdac.balanceOf(address(this)), held, "the failed attempt moved something");
    }

    /// try* swallows a REVERT, not merely a false return - which is the only
    /// reason it is usable against this token at all.
    function test_trySafeTransferReturnsFalseWhereTheTokenReverts() public onlyFork {
        assertTrue(nvdac.trySafeTransfer(recipient, ONE), "a good transfer did not report success");

        uint256 held = nvdac.balanceOf(address(this));
        assertFalse(nvdac.trySafeTransfer(recipient, held + 1), "a failing transfer reported success");
        assertEq(nvdac.balanceOf(address(this)), held, "the failed attempt moved something");
    }

    /// THE NARROWING, as a test. Same cheatcode, same token, same wrapper - the
    /// only difference from the inlined case is that the reverting call is a
    /// frame deeper, behind callSafeTransfer's external boundary. Here
    /// expectRevert sees exactly what SafeERC20 bubbled.
    function test_expectRevertMatchesAcrossAnExternalBoundary() public onlyFork {
        vm.expectRevert(abi.encodeWithSelector(InvalidReceiver.selector, address(0)));
        this.callSafeTransfer(address(0), ONE);
    }

    function test_transferToTheZeroAddressRevertsWithInvalidReceiver() public onlyFork {
        bytes memory got = _revertDataOf(abi.encodeCall(this.callSafeTransfer, (address(0), ONE)));
        assertEq(got, abi.encodeWithSelector(InvalidReceiver.selector, address(0)), "not InvalidReceiver(0)");
    }

    function test_transferFromWithoutAllowanceRevertsWithInsufficientAllowance() public onlyFork {
        vm.prank(NVDAC_WHALE);
        nvdac.approve(address(this), 0);

        bytes memory got = _revertDataOf(abi.encodeCall(this.callSafeTransferFrom, (NVDAC_WHALE, recipient, ONE)));
        assertEq(
            got,
            abi.encodeWithSelector(InsufficientAllowance.selector, address(this), 0, ONE),
            "not InsufficientAllowance with these arguments"
        );
    }

    // ------------------------------------------------------------- recipients

    /// An address that has never been seen before can receive NVDAc and send it
    /// on. That is what the launchpad needs: curves, pools and locks are all
    /// fresh addresses.
    ///
    /// IT IS NOT A STATEMENT ABOUT ISSUER CONTROL. It shows there is no
    /// allowlist standing between two ordinary addresses at this block. What
    /// the issuer can do to a specific account is not exercised here, because
    /// no account in that condition is known at this fork point.
    function test_aFreshAddressCanReceiveAndSendItOn() public onlyFork {
        address fresh = address(uint160(uint256(keccak256(abi.encodePacked("curb.fresh", block.number)))));
        assertEq(nvdac.balanceOf(fresh), 0, "the 'fresh' address already holds NVDAc");

        nvdac.safeTransfer(fresh, 2 * ONE);
        assertEq(nvdac.balanceOf(fresh), 2 * ONE, "it did not receive the exact amount");

        vm.prank(fresh);
        IERC20(NVDAC).safeTransfer(recipient, 2 * ONE);
        assertEq(nvdac.balanceOf(fresh), 0, "it could not send the whole amount on");
    }

    // ---------------------------------------------------------------- helpers

    /// SafeERC20's functions are internal, so they are exercised from here and
    /// called back into through the external boundary that makes their revert
    /// data readable.
    function callSafeTransfer(address to, uint256 value) external {
        nvdac.safeTransfer(to, value);
    }

    function callSafeTransferFrom(address from, address to, uint256 value) external {
        nvdac.safeTransferFrom(from, to, value);
    }

    /// @return the revert data of a call that MUST revert.
    function _revertDataOf(bytes memory callData) internal returns (bytes memory) {
        (bool ok, bytes memory ret) = address(this).call(callData);
        assertFalse(ok, "the call was expected to revert and did not");
        assertGe(ret.length, 4, "it reverted with no error selector at all");
        return ret;
    }

    function _assertReturnsTrue(bytes memory data, string memory what) internal {
        (bool ok, bytes memory ret) = NVDAC.call(data);
        assertTrue(ok, string.concat(what, " reverted"));
        assertEq(ret.length, 32, string.concat(what, " did not return exactly one word"));
        assertTrue(abi.decode(ret, (bool)), string.concat(what, " returned false"));
    }
}
