// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {B20ForkTest} from "./B20ForkTest.sol";

/// HOW A B20 TOKEN REFUSES, AND HOW TO ASK IT FIRST.  (C1)
///
/// Issuer restrictions were carried as unknown: what a restricted address does,
/// and whether anything can be checked before a trade. Both are answered here,
/// against the real token and the real registry at the pinned block.
///
///   THE REFUSAL IS A REVERT with a named error carrying its arguments -
///   PolicyForbids(bytes32 policyScope, uint64 policyId). Not false, not a
///   silent no-op, and nothing moves.
///
///   IT CAN BE ASKED FIRST. NVDAc names a policy per scope
///   (policyId(TRANSFER_RECEIVER_POLICY()) reads 5 here) and the PolicyRegistry
///   precompile answers isAuthorized(policyId, account).
///
/// THE REFUSAL IS PROVOKED THROUGH THE REAL MECHANISM, not injected: policy 5's
/// own admin is impersonated on the fork to add an address to its blocklist,
/// and the token is then asked to pay it. That is B20 enforcing its own policy.
/// It is NOT an address Coinbase has restricted in production - none was found,
/// every address probed reads as authorized - so what the issuer actually does
/// in the wild is still unobserved.
///
/// AN EARLIER VERSION OF THIS FILE CLAIMED THE OPPOSITE: that no restriction
/// could be detected in advance by any means. That was wrong twice over, and
/// both mistakes are worth keeping because either would happen again.
///   NVDAc answers an unknown selector by reverting with THE FOUR BYTES OF THE
///   CALL, which cast prints as `custom error 0x...` - so an absent function
///   reads as a rejection. test_anUnknownSelectorIsEchoedBack pins that down.
///   And the probe used names invented from prose - transferSenderPolicy(),
///   policyRegistry() - while B20 declares TRANSFER_SENDER_POLICY() and
///   policyId(bytes32). Every guess echoed back, and the absences were read as
///   "nothing exists" instead of "these names are wrong". The interfaces are
///   published in base/base-std and were not consulted until afterwards.
contract B20RestrictionsForkTest is B20ForkTest {
    address internal constant NVDAC = 0xb20000000000000000000078ee7ce2fE4908108C;
    /// A SECOND EQUITY UNDER THE SAME POLICY, so "the mechanism travels" can
    /// be measured instead of argued. Verified B20, 8 decimals [MULTI_RWA.txt 2.1].
    address internal constant METAC = 0xb2000000000000000000008bC8786B856E61707C;
    address internal constant SOMEBODY = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;

    function setUp() public {
        _forkGuard();
    }

    /// AN UNKNOWN SELECTOR COMES BACK AS ITSELF, and that is why several notes
    /// in this repository said "reverts" where the truth is "is not there".
    ///
    /// Calling anything NVDAc does not implement reverts with the four bytes of
    /// the call as the revert data. cast renders that as `custom error 0x...`,
    /// which reads like the token raising an error of its own - so
    /// uiMultiplier(), priceFeed() and oracle() were all written down as
    /// rejections when the token simply has no such function.
    ///
    /// Asserted against selectors that cannot be anyone's function, so this
    /// says something about the TOKEN rather than about the names chosen.
    function test_anUnknownSelectorIsEchoedBack() public onlyFork {
        bytes4[4] memory probes =
            [bytes4(0xdeadbeef), bytes4(0x12345678), bytes4(0xffffffff), bytes4(0x00000000)];

        for (uint256 i = 0; i < probes.length; i++) {
            (bool ok, bytes memory ret) = NVDAC.staticcall(abi.encodePacked(probes[i]));
            assertFalse(ok, "an unknown selector did not revert");
            assertEq(ret.length, 4, "the revert data is not four bytes");
            assertEq(bytes4(ret), probes[i], "the revert data is not the selector that was called");
        }
    }

    /// EXTRA CALLDATA DOES NOT CHANGE THE ANSWER, which the probe below relies
    /// on and a first version of it simply assumed.
    ///
    /// That version sent three arguments to every name, including ones taking
    /// none. Had this token checked calldata length, a function that EXISTS
    /// would have refused the call and been recorded as absent - the probe
    /// would have been measuring its own mistake. Measured here instead:
    /// decimals() answers 8 with 96 bytes of padding after it, and
    /// balanceOf(address) answers with 64 bytes of surplus.
    function test_surplusCalldataDoesNotChangeTheAnswer() public onlyFork {
        (bool bare, bytes memory bareRet) = NVDAC.staticcall(abi.encodeWithSignature("decimals()"));
        (bool padded, bytes memory paddedRet) =
            NVDAC.staticcall(abi.encodePacked(bytes4(keccak256("decimals()")), uint256(1), uint256(1), uint256(1)));
        assertTrue(bare && padded, "decimals() stopped answering");
        assertEq(abi.decode(paddedRet, (uint8)), abi.decode(bareRet, (uint8)), "padding changed decimals()");

        (bool b1, bytes memory r1) = NVDAC.staticcall(abi.encodeWithSelector(IERC20.balanceOf.selector, SOMEBODY));
        (bool b2, bytes memory r2) = NVDAC.staticcall(
            abi.encodePacked(IERC20.balanceOf.selector, uint256(uint160(SOMEBODY)), uint256(1), uint256(1))
        );
        assertTrue(b1 && b2, "balanceOf() stopped answering");
        assertEq(abi.decode(r2, (uint256)), abi.decode(r1, (uint256)), "padding changed balanceOf()");
    }

    /// SO "IT REVERTED" IS NOT EVIDENCE OF ANYTHING until the data is read.
    /// A real function and an absent one are told apart by comparing the revert
    /// data with the selector, which is what this does.
    ///
    /// WHAT THIS ESTABLISHES, NARROWLY: the conventions other tokens use are
    /// not what B20 uses. ERC-1404's detectTransferRestriction, the various
    /// isFrozen/isBlocked/isAllowed spellings - thirteen names, each called
    /// with its own arity, all absent.
    ///
    /// IT DOES NOT ESTABLISH THAT NOTHING CAN BE ASKED, and reading it that way
    /// is exactly the mistake this file was first written around. B20's own
    /// route is policyId(bytes32) on the token plus isAuthorized on the
    /// registry, and it works - see test_theTokenIsBoundToAPolicyThatReallyExists.
    /// This test is here so a reader coming from ERC-1404 knows why those calls
    /// fail, not to say the question is unanswerable.
    function test_noneOfTheUsualRestrictionViewsExist() public onlyFork {
        // no arguments
        string[2] memory nullary = ["paused()", "isPaused()"];
        // one address
        string[7] memory unary = [
            "isFrozen(address)",
            "frozen(address)",
            "isBlocked(address)",
            "isBlacklisted(address)",
            "isAllowed(address)",
            "isWhitelisted(address)",
            "isVerified(address)"
        ];
        // from, to, amount
        string[4] memory ternary = [
            "detectTransferRestriction(address,address,uint256)",  // ERC-1404
            "canTransfer(address,address,uint256)",
            "checkTransferAllowed(address,address,uint256)",
            "restrictionCode(address,address,uint256)"
        ];

        for (uint256 i = 0; i < nullary.length; i++) {
            _assertAbsent(nullary[i], abi.encodePacked(bytes4(keccak256(bytes(nullary[i])))));
        }
        for (uint256 i = 0; i < unary.length; i++) {
            _assertAbsent(unary[i], abi.encodeWithSelector(bytes4(keccak256(bytes(unary[i]))), SOMEBODY));
        }
        for (uint256 i = 0; i < ternary.length; i++) {
            _assertAbsent(
                ternary[i],
                abi.encodeWithSelector(bytes4(keccak256(bytes(ternary[i]))), SOMEBODY, SOMEBODY, uint256(1))
            );
        }
    }

    // ================================================================
    // THE LIVE REFUSAL, PROVOKED THROUGH B20's OWN POLICY MECHANISM
    // ================================================================
    //
    // Everything above is about how to READ this token - that an absent
    // function echoes its selector, and that the ERC-1404 conventions are not
    // what B20 uses. This is what actually happens, and it is NOT an injected
    // failure: NVDAc really is bound to a policy, that policy is really
    // enforced by the token, and the refusal below comes out of B20 itself.
    //
    // HOW. NVDAc names a policy per scope - policyId(TRANSFER_SENDER_POLICY())
    // reads 5 at this block, as does the receiver scope - and policy 5 lives in
    // the PolicyRegistry precompile with an admin of its own. On a fork, that
    // admin can be impersonated and an address added to the blocklist. The
    // token is then asked to move value to it.
    //
    // WHAT THIS IS AND IS NOT. It is the real mechanism, the real token and the
    // real registry, at a pinned block. It is NOT an address that Coinbase has
    // restricted in production: none was found - every address probed reads as
    // authorized - so what a genuinely restricted account looks like in the
    // wild is still unobserved. What is now measured is the SHAPE of the
    // refusal the mechanism produces.
    address internal constant POLICY_REGISTRY = 0x8453000000000000000000000000000000000002;

    /// The error B20 raises when a policy slot denies an operation, from
    /// base-std's IB20: error PolicyForbids(bytes32 policyScope, uint64 policyId)
    error PolicyForbids(bytes32 policyScope, uint64 policyId);

    function test_theTokenIsBoundToAPolicyThatReallyExists() public onlyFork {
        bytes32 senderScope = _scope("TRANSFER_SENDER_POLICY()");
        bytes32 receiverScope = _scope("TRANSFER_RECEIVER_POLICY()");
        assertTrue(senderScope != bytes32(0), "the sender scope reads as zero");

        uint64 senderPolicy = _policyId(senderScope);
        uint64 receiverPolicy = _policyId(receiverScope);
        assertGt(senderPolicy, 0, "NVDAc names no sender policy");
        emit log_named_uint("  sender policy id", senderPolicy);
        emit log_named_uint("  receiver policy id", receiverPolicy);

        (bool ok, bytes memory ret) =
            POLICY_REGISTRY.staticcall(abi.encodeWithSignature("policyExists(uint64)", senderPolicy));
        assertTrue(ok && abi.decode(ret, (bool)), "the policy the token names does not exist");
    }

    /// AND A BLOCKED RECIPIENT IS REFUSED, with the error named and its
    /// arguments checked - not merely "it reverted".
    function test_aBlockedRecipientIsRefusedWithPolicyForbids() public onlyFork {
        address whale = 0x853F5f1B92b16714Fe6CDA67CAad0856B83C7ab9;
        address victim = makeAddr("c1-blocked-recipient");

        bytes32 receiverScope = _scope("TRANSFER_RECEIVER_POLICY()");
        uint64 policy = _policyId(receiverScope);

        // Before: authorized, and a transfer works. Without this the refusal
        // below could be anything - a broken fixture, a wrong address.
        assertTrue(_authorized(policy, victim), "the recipient was already blocked");
        vm.prank(whale);
        IERC20(NVDAC).transfer(victim, 1e8);
        assertEq(IERC20(NVDAC).balanceOf(victim), 1e8, "the baseline transfer did not arrive");

        // Block it, as the policy's own admin.
        address admin = _policyAdmin(policy);
        address[] memory who = new address[](1);
        who[0] = victim;
        vm.prank(admin);
        (bool set,) = POLICY_REGISTRY.call(
            abi.encodeWithSignature("updateBlocklist(uint64,bool,address[])", policy, true, who)
        );
        // NOT A SKIP. A branch that returns quietly when the setup fails is a
        // test that reports success for having done nothing - and this is the
        // one measurement C1 turns on.
        assertTrue(set, "the registry refused the blocklist update; the refusal below was never provoked");
        assertFalse(_authorized(policy, victim), "the blocklist update did not take");

        // THE REFUSAL. Named, with its arguments read.
        vm.prank(whale);
        vm.expectRevert(abi.encodeWithSelector(PolicyForbids.selector, receiverScope, policy));
        IERC20(NVDAC).transfer(victim, 1e8);

        // AND NOTHING MOVED. A refusal that had already taken the sender's
        // balance would be a different and much worse thing.
        assertEq(IERC20(NVDAC).balanceOf(victim), 1e8, "the refused transfer still credited the recipient");

        emit log_string("  refusal observed: PolicyForbids(TRANSFER_RECEIVER_POLICY, policy)");
    }

    /// IT REVERTS. It does not return false and it does not quietly do nothing -
    /// which is the question C1 asked and the one that decides how any of this
    /// can be surfaced. Checked from the raw call rather than through a
    /// wrapper that would hide the difference.
    function test_theRefusalIsARevertNotAFalseReturn() public onlyFork {
        address whale = 0x853F5f1B92b16714Fe6CDA67CAad0856B83C7ab9;
        address victim = makeAddr("c1-blocked-2");
        uint64 policy = _policyId(_scope("TRANSFER_RECEIVER_POLICY()"));

        address[] memory who = new address[](1);
        who[0] = victim;
        vm.prank(_policyAdmin(policy));
        (bool set,) = POLICY_REGISTRY.call(
            abi.encodeWithSignature("updateBlocklist(uint64,bool,address[])", policy, true, who)
        );
        assertTrue(set, "the registry refused the blocklist update; nothing was provoked");
        assertFalse(_authorized(policy, victim), "the blocklist update did not take");

        vm.prank(whale);
        (bool ok, bytes memory ret) =
            NVDAC.call(abi.encodeWithSelector(IERC20.transfer.selector, victim, uint256(1e8)));

        assertFalse(ok, "the transfer returned instead of reverting - B20 refuses by REVERTING");
        assertEq(bytes4(ret), PolicyForbids.selector, "it reverted with something other than PolicyForbids");
        assertEq(ret.length, 4 + 64, "PolicyForbids did not carry its two arguments");
    }


    /// F3 AND F4, IN ONE MEASUREMENT.
    ///
    /// Until now two things were only ARGUED. That C1's refusal mechanism is
    /// the same on assets other than NVDAc - argued from their all reporting
    /// policy 5. And that spreading a product across these equities does not
    /// spread issuer risk - argued from their sharing one admin. An argument
    /// from a shared identifier is not a measurement of shared behaviour.
    ///
    /// So: block ONE address ONCE, as policy 5's own admin, and then ask TWO
    /// DIFFERENT ASSETS to pay it.
    ///
    /// CRITERIA, before measuring:
    ///   P1  METAc reports the same receiver policy as NVDAc - asked, not assumed
    ///   P2  before the block, BOTH assets pay the address
    ///   P3  one blocklist entry is added, once, on that policy
    ///   P4  after it, BOTH refuse with PolicyForbids carrying their own scope
    ///   P5  neither refusal moved anything
    function test_oneBlocklistEntryStopsTwoDifferentAssets() public onlyFork {
        address metaHolder = 0xEAF57753BC382E0324a1D43F72E7027705a2273E;
        address nvdaHolder = 0x853F5f1B92b16714Fe6CDA67CAad0856B83C7ab9;
        address victim = makeAddr("f3-blocked-on-both");

        // ---- P1
        bytes32 nvdaScope = _scopeOf(NVDAC, "TRANSFER_RECEIVER_POLICY()");
        bytes32 metaScope = _scopeOf(METAC, "TRANSFER_RECEIVER_POLICY()");
        uint64 nvdaPolicy = _policyIdOf(NVDAC, nvdaScope);
        uint64 metaPolicy = _policyIdOf(METAC, metaScope);
        assertEq(metaPolicy, nvdaPolicy, "P1: the two assets are not under the same policy after all");
        assertEq(metaScope, nvdaScope, "P1: the two assets name different receiver scopes");

        // ---- P2. Without a working baseline a later refusal proves nothing.
        vm.prank(nvdaHolder);
        IERC20(NVDAC).transfer(victim, 1e8);
        vm.prank(metaHolder);
        IERC20(METAC).transfer(victim, 1e8);
        assertEq(IERC20(NVDAC).balanceOf(victim), 1e8, "P2: the NVDAc baseline did not arrive");
        assertEq(IERC20(METAC).balanceOf(victim), 1e8, "P2: the METAc baseline did not arrive");

        // ---- P3. ONE entry, on ONE policy, touching neither token directly.
        address[] memory who = new address[](1);
        who[0] = victim;
        vm.prank(_policyAdmin(nvdaPolicy));
        (bool set,) = POLICY_REGISTRY.call(
            abi.encodeWithSignature("updateBlocklist(uint64,bool,address[])", nvdaPolicy, true, who)
        );
        assertTrue(set, "P3: the registry refused the blocklist update; nothing below was provoked");
        assertFalse(_authorized(nvdaPolicy, victim), "P3: the blocklist update did not take");

        // ---- P4. BOTH, from one entry.
        vm.prank(nvdaHolder);
        vm.expectRevert(abi.encodeWithSelector(PolicyForbids.selector, nvdaScope, nvdaPolicy));
        IERC20(NVDAC).transfer(victim, 1e8);

        vm.prank(metaHolder);
        vm.expectRevert(abi.encodeWithSelector(PolicyForbids.selector, metaScope, metaPolicy));
        IERC20(METAC).transfer(victim, 1e8);

        // ---- P5
        assertEq(IERC20(NVDAC).balanceOf(victim), 1e8, "P5: the refused NVDAc transfer still credited");
        assertEq(IERC20(METAC).balanceOf(victim), 1e8, "P5: the refused METAc transfer still credited");

        emit log_string("  one blocklist entry refused BOTH assets: issuer risk is shared, not spread");
    }

    function _scope(string memory name) internal view returns (bytes32) {
        return _scopeOf(NVDAC, name);
    }

    function _policyId(bytes32 scope) internal view returns (uint64) {
        return _policyIdOf(NVDAC, scope);
    }

    /// The same two questions, of any asset. Added for the test below, which
    /// has to ask a SECOND asset rather than assume its answer matches.
    function _scopeOf(address token, string memory name) internal view returns (bytes32) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature(name));
        require(ok, string.concat(name, " did not answer"));
        return abi.decode(ret, (bytes32));
    }

    function _policyIdOf(address token, bytes32 scope) internal view returns (uint64) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("policyId(bytes32)", scope));
        require(ok, "policyId() did not answer");
        return abi.decode(ret, (uint64));
    }

    function _authorized(uint64 policy, address who) internal view returns (bool) {
        (bool ok, bytes memory ret) =
            POLICY_REGISTRY.staticcall(abi.encodeWithSignature("isAuthorized(uint64,address)", policy, who));
        require(ok, "isAuthorized() did not answer");
        return abi.decode(ret, (bool));
    }

    function _policyAdmin(uint64 policy) internal view returns (address) {
        (bool ok, bytes memory ret) =
            POLICY_REGISTRY.staticcall(abi.encodeWithSignature("policyAdmin(uint64)", policy));
        require(ok, "policyAdmin() did not answer");
        return abi.decode(ret, (address));
    }

    function _assertAbsent(string memory name, bytes memory call) internal {
        (bool ok, bytes memory ret) = NVDAC.staticcall(call);
        assertFalse(ok, string.concat(name, " answered; this file's premise is out of date"));
        // ABSENT, rather than present and refusing: the token handed back the
        // selector it was asked for.
        assertEq(ret.length, 4, string.concat(name, " reverted with something other than a selector"));
        assertEq(
            bytes4(ret),
            bytes4(keccak256(bytes(name))),
            string.concat("NVDAc gave a real error for ", name, " - it may implement it after all")
        );
    }

    /// AND THE ONES IT DOES IMPLEMENT ANSWER, so the check above is not simply
    /// describing a token that refuses everything.
    function test_theFunctionsItDoesHaveAnswerNormally() public onlyFork {
        (bool okDec, bytes memory dec) = NVDAC.staticcall(abi.encodeWithSignature("decimals()"));
        assertTrue(okDec, "decimals() did not answer");
        assertEq(abi.decode(dec, (uint8)), 8, "decimals() is not 8");

        (bool okSym, bytes memory sym) = NVDAC.staticcall(abi.encodeWithSignature("symbol()"));
        assertTrue(okSym, "symbol() did not answer");
        assertGt(bytes(abi.decode(sym, (string))).length, 0, "symbol() came back empty");
        // balanceOf on an address with nothing is a real zero, not a refusal.
        (bool ok, bytes memory ret) =
            NVDAC.staticcall(abi.encodeWithSelector(IERC20.balanceOf.selector, address(this)));
        assertTrue(ok, "balanceOf() did not answer");
        assertEq(ret.length, 32, "balanceOf() answered with something other than a number");
    }

    /// THE BASELINE THE REFUSALS ARE READ AGAINST.
    ///
    /// This whole comment used to say the opposite of what the file now shows -
    /// that no view could be called, that an interface could not warn anybody,
    /// and that the shape of the failure was unknown. All three were written
    /// before TRANSFER_RECEIVER_POLICY() and policyId() were found, and all
    /// three are wrong: the check exists, the refusal is PolicyForbids, and the
    /// tests above provoke it. Left here as a note because a stale comment
    /// contradicting its own file is worse than no comment.
    ///
    /// What remains true: no address restricted BY THE ISSUER was found, so the
    /// refusals here are provoked by impersonating the policy admin on a fork.
    function test_anOrdinaryTransferGoesThrough() public onlyFork {
        // The baseline, and named for what it shows. Calling these addresses
        // "unrestricted" - as a first version of this did - asserts the very
        // thing that cannot be checked: all that is known is that this transfer
        // worked. It is here so a later "no restriction could be observed" is
        // not confused with "transfers do not work in this fixture".
        address whale = 0x853F5f1B92b16714Fe6CDA67CAad0856B83C7ab9;
        address to = makeAddr("c1-recipient");
        uint256 before = IERC20(NVDAC).balanceOf(to);

        vm.prank(whale);
        IERC20(NVDAC).transfer(to, 1e8);

        assertEq(IERC20(NVDAC).balanceOf(to) - before, 1e8, "an ordinary transfer did not arrive");
    }
}
