// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

import {DeployCurb} from "../script/DeployCurb.s.sol";
import {LaunchRegistry} from "../src/curb/LaunchRegistry.sol";
import {SharingCatalog} from "../src/curb/SharingCatalog.sol";
import {Graduator, IPermit2Minimal} from "../src/curb/Graduator.sol";
import {IPositionManagerMinimal} from "../src/curb/PositionLock.sol";
import {LaunchLens} from "../src/curb/LaunchLens.sol";
import {ISharingCatalog} from "../src/curb/sharing/ICurbSharing.sol";
import {HolderDistributorFactory} from "../src/curb/sharing/HolderDistributorFactory.sol";

/// REACHES DeployCurb's NEW CHECKS WITHOUT RUNNING A DEPLOYMENT: the sharing
/// roles, the code identities of the contracts core v2 leaves unchanged, and
/// the read-back of what the deploy order built. Inherited, not copied, so the
/// script's own code is what is tested.
contract DeployCurbProbe is DeployCurb {
    /// The deployer every case below runs as.
    address public constant DEPLOYER = address(0xDE91);

    function roles(address publisher, address keeperPayee, address[] memory vetoers, address owner_, bool demo)
        external
        pure
        returns (SharingRoles memory)
    {
        return checkSharingRoles(publisher, keeperPayee, vetoers, owner_, demo, DEPLOYER);
    }

    /// One pin replaced, so each of the five can be shown to be asked.
    uint256 public broken = type(uint256).max;
    bytes32 public brokenWith;

    function breakPin(uint256 i, bytes32 with) external {
        broken = i;
        brokenWith = with;
    }

    function pinnedCode() internal view override returns (string[5] memory artifacts, bytes32[5] memory ids) {
        (artifacts, ids) = super.pinnedCode();
        if (broken < 5) ids[broken] = brokenWith;
    }

    function pins() external view returns (string[5] memory artifacts, bytes32[5] memory ids) {
        return super.pinnedCode();
    }

    function identityOf(bytes memory runtime) external pure returns (bytes32) {
        return codeIdentity(runtime);
    }

    function identity(string memory artifact, bytes32 want) external view {
        requireIdentity(artifact, want);
    }

    function unchanged() external view {
        requireUnchangedCode();
    }

    function order(Asset[] memory list) external pure returns (uint256[] memory) {
        return admissionOrder(list);
    }

    function checksum(string memory raw, address a) external pure returns (bool) {
        return checksumHolds(raw, a);
    }

    function requireCk(string memory name, string memory raw, address a) external pure {
        requireChecksum(name, raw, a);
    }

    function wiring(
        LaunchRegistry registry,
        SharingCatalog catalog,
        Graduator graduator,
        HolderDistributorFactory factory,
        LaunchLens lens,
        address deployer,
        address owner_,
        SharingRoles memory r
    ) external view {
        requireSharingWiring(registry, catalog, graduator, factory, lens, deployer, owner_, r);
    }
}

/// A distributor factory that answers whatever it is told, so each read-back
/// can be made to fail on its own.
contract FakeDistributorFactory {
    address public registry;
    address public graduator;
    address public owner;
    address public publisher;
    address public keeperPayee;
    address public implementation;
    bool public frozen;
    mapping(address => bool) public isVetoer;

    function set(address registry_, address graduator_, address owner_, address publisher_, address keeperPayee_)
        external
    {
        registry = registry_;
        graduator = graduator_;
        owner = owner_;
        publisher = publisher_;
        keeperPayee = keeperPayee_;
    }

    function setImplementation(address a) external {
        implementation = a;
    }

    function setFrozen(bool f) external {
        frozen = f;
    }

    function setVetoer(address a, bool on) external {
        isVetoer[a] = on;
    }
}

contract FakeImplementation {
    address public factory;
    address public graduator;

    function set(address factory_, address graduator_) external {
        factory = factory_;
        graduator = graduator_;
    }
}

contract DeployCurbChecksTest is Test {
    DeployCurbProbe internal probe;

    address internal owner_ = makeAddr("policy owner");
    address internal publisher = makeAddr("publisher");
    address internal keeper = makeAddr("keeper payee");
    address internal guardian = makeAddr("guardian");
    address internal guardian2 = makeAddr("second guardian");

    function setUp() public {
        probe = new DeployCurbProbe();
    }

    function _list(address a) internal pure returns (address[] memory l) {
        l = new address[](1);
        l[0] = a;
    }

    function _list(address a, address b) internal pure returns (address[] memory l) {
        l = new address[](2);
        l[0] = a;
        l[1] = b;
    }

    // ================================================================
    // THE SHARING ROLES
    // ================================================================

    /// The roles as a real run names them: the separate vetoers in order, the
    /// policy owner added last and once.
    function test_sharingRoles_aRealRunNamesAllThreeAndThePolicyOwnerIsAddedLast() public view {
        DeployCurb.SharingRoles memory r = probe.roles(publisher, keeper, _list(guardian, guardian2), owner_, false);
        assertEq(r.publisher, publisher, "publisher");
        assertEq(r.keeperPayee, keeper, "keeper payee");
        assertEq(r.vetoers.length, 3, "the policy owner was not added, or added twice");
        assertEq(r.vetoers[0], guardian, "first vetoer");
        assertEq(r.vetoers[1], guardian2, "second vetoer");
        assertEq(r.vetoers[2], owner_, "the policy owner is not the last vetoer");
    }

    /// A real run without a separate vetoer is refused; a demo is not, and its
    /// only vetoer is the policy owner.
    function test_sharingRoles_onlyADemoMayNameNoSeparateVetoer() public {
        vm.expectRevert(
            bytes(
                "CURB_SHARING_VETOERS is not set. A real deployment names at least one vetoer besides the policy owner, held apart from the publisher."
            )
        );
        probe.roles(publisher, keeper, new address[](0), owner_, false);

        DeployCurb.SharingRoles memory r = probe.roles(publisher, keeper, new address[](0), owner_, true);
        assertEq(r.vetoers.length, 1, "a demo's vetoers are not the policy owner alone");
        assertEq(r.vetoers[0], owner_, "a demo's vetoer is not the policy owner");
    }

    /// A real run takes no default: an unset publisher or keeper payee is
    /// refused, each in its own words.
    function test_sharingRoles_aRealRunRefusesAnUnsetPublisherOrKeeperPayee() public {
        vm.expectRevert(
            bytes(
                "CURB_SHARING_PUBLISHER is not set (or is the zero address). It is the key that proposes holder payouts; a real deployment names it."
            )
        );
        probe.roles(address(0), keeper, _list(guardian), owner_, false);
        vm.expectRevert(
            bytes(
                "CURB_SHARING_KEEPER_PAYEE is not set (or is the zero address). It receives the keeper's gas fee; a real deployment names it."
            )
        );
        probe.roles(publisher, address(0), _list(guardian), owner_, false);
    }

    /// A demo fills an unset publisher and keeper payee with the deployer,
    /// each on its own, and keeps what was named.
    function test_sharingRoles_aDemoFillsWhatIsUnsetWithTheDeployer() public view {
        address d = probe.DEPLOYER();
        DeployCurb.SharingRoles memory r = probe.roles(address(0), address(0), new address[](0), owner_, true);
        assertEq(r.publisher, d, "a demo's unset publisher is not the deployer");
        assertEq(r.keeperPayee, d, "a demo's unset keeper payee is not the deployer");
        r = probe.roles(publisher, address(0), new address[](0), owner_, true);
        assertEq(r.publisher, publisher, "a demo replaced the publisher it was given");
        assertEq(r.keeperPayee, d, "a demo's unset keeper payee is not the deployer");
        r = probe.roles(address(0), keeper, new address[](0), owner_, true);
        assertEq(r.publisher, d, "a demo's unset publisher is not the deployer");
        assertEq(r.keeperPayee, keeper, "a demo replaced the keeper payee it was given");
    }

    /// A vetoer is there to stop the publisher, wherever it sits in the list.
    function test_sharingRoles_aVetoerMayNotBeThePublisher() public {
        vm.expectRevert(
            bytes("a CURB_SHARING_VETOERS entry is the publisher. A vetoer is there to stop the publisher's payouts.")
        );
        probe.roles(publisher, keeper, _list(guardian, publisher), owner_, false);
        vm.expectRevert(
            bytes("a CURB_SHARING_VETOERS entry is the publisher. A vetoer is there to stop the publisher's payouts.")
        );
        probe.roles(publisher, keeper, _list(publisher), owner_, true);
    }

    /// The policy owner is a vetoer already; in the list it would read as a
    /// separate one.
    function test_sharingRoles_thePolicyOwnerIsRefusedInTheList() public {
        vm.expectRevert(
            bytes(
                "a CURB_SHARING_VETOERS entry is the policy owner, which is a vetoer already. Name the separate vetoers there."
            )
        );
        probe.roles(publisher, keeper, _list(guardian, owner_), owner_, false);
    }

    function test_sharingRoles_aZeroOrRepeatedVetoerIsRefused() public {
        vm.expectRevert(bytes("a CURB_SHARING_VETOERS entry is the zero address"));
        probe.roles(publisher, keeper, _list(guardian, address(0)), owner_, false);
        vm.expectRevert(bytes("CURB_SHARING_VETOERS names one address twice"));
        probe.roles(publisher, keeper, _list(guardian, guardian), owner_, false);
    }

    // ================================================================
    // THE ADMISSION ORDER
    // ================================================================

    function _asset(address quote) internal pure returns (DeployCurb.Asset memory a) {
        a.quote = quote;
        a.label = "x";
        a.threshold = 1;
    }

    function _order(address[] memory quotes) internal view returns (uint256[] memory) {
        DeployCurb.Asset[] memory list = new DeployCurb.Asset[](quotes.length);
        for (uint256 i = 0; i < quotes.length; i++) list[i] = _asset(quotes[i]);
        return probe.order(list);
    }

    function _eq(uint256[] memory got, uint256[3] memory want, uint256 n, string memory why) internal pure {
        assertEq(got.length, n, why);
        for (uint256 i = 0; i < n; i++) assertEq(got[i], want[i], why);
    }

    /// WETH FIRST - the wire(), with $CURB right behind it - wherever the list
    /// puts it, and every other asset in the list's own order after it, each
    /// index once. A list without WETH keeps its order, and WETH alone is its
    /// own order.
    function test_admissionOrder_putsWethFirstAndKeepsTheRest() public view {
        address weth = 0x4200000000000000000000000000000000000006;
        address a = address(0xA11);
        address b = address(0xB22);
        address[] memory q = new address[](3);
        (q[0], q[1], q[2]) = (weth, a, b);
        _eq(_order(q), [uint256(0), 1, 2], 3, "WETH first in the list stays first");
        (q[0], q[1], q[2]) = (a, weth, b);
        _eq(_order(q), [uint256(1), 0, 2], 3, "WETH in the middle is admitted first");
        (q[0], q[1], q[2]) = (a, b, weth);
        _eq(_order(q), [uint256(2), 0, 1], 3, "WETH last in the list is admitted first");
        address[] memory two = new address[](2);
        (two[0], two[1]) = (a, b);
        _eq(_order(two), [uint256(0), 1, 0], 2, "a list without WETH keeps its order");
        address[] memory one = new address[](1);
        one[0] = weth;
        _eq(_order(one), [uint256(0), 0, 0], 1, "WETH alone");
    }

    // ================================================================
    // THE EIP-55 CHECKSUM OF AN ADDRESS READ FROM THE ENVIRONMENT
    // ================================================================

    /// A MIXED-CASE ADDRESS IS HELD TO ITS CHECKSUM, and one in a single case
    /// carries none to hold. The mistyped form - one letter's case flipped -
    /// still parses, to the same address, so it is this check and not forge
    /// that refuses it. A6's recorded recipient is the address used.
    function test_checksum_aMixedCaseAddressIsHeldToItsChecksum() public view {
        address a = 0x52483b53c8C08Ece00932A65DaE70487dcCD21E0;
        string memory good = "0x52483b53c8C08Ece00932A65DaE70487dcCD21E0";
        string memory flipped = "0x52483b53c8c08Ece00932A65DaE70487dcCD21E0";
        assertEq(vm.toString(a), good, "vm.toString writes the checksummed form (the premise)");
        assertEq(vm.parseAddress(flipped), a, "forge parses the mistyped form to the same address (the premise)");
        assertTrue(probe.checksum(good, a), "the checksummed form is refused");
        assertFalse(probe.checksum(flipped, a), "a mixed-case form with a wrong checksum passes");
        assertTrue(probe.checksum("0x52483b53c8c08ece00932a65dae70487dccd21e0", a), "all lower case carries no checksum");
        assertTrue(probe.checksum("0x52483B53C8C08ECE00932A65DAE70487DCCD21E0", a), "all upper case carries no checksum");
        address digits = 0x1111111111111111111111111111111111111111;
        assertTrue(probe.checksum("0x1111111111111111111111111111111111111111", digits), "no letters, no checksum");
    }

    /// AND THE REFUSAL NAMES THE VARIABLE, without printing the checksummed
    /// form of the typo.
    function test_checksum_theRefusalNamesTheVariable() public {
        address a = 0x52483b53c8C08Ece00932A65DaE70487dcCD21E0;
        vm.expectRevert(
            bytes(
                "CURB_PLATFORM_RECIPIENT is written in mixed case and that is not its EIP-55 checksum: one mistyped character reads like this. Copy the address again from where it is kept; never correct it by hand."
            )
        );
        probe.requireCk("CURB_PLATFORM_RECIPIENT", "0x52483b53c8c08Ece00932A65DaE70487dcCD21E0", a);
        probe.requireCk("CURB_PLATFORM_RECIPIENT", "0x52483b53c8C08Ece00932A65DaE70487dcCD21E0", a); // the control
    }

    // ================================================================
    // THE CODE IDENTITIES
    // ================================================================

    /// The trailer is cut by the length in the last two bytes, and only the
    /// trailer: a different trailer is the same identity, a different body is
    /// not.
    function test_codeIdentity_cutsTheMetadataTrailerByItsOwnLength() public view {
        bytes memory a = hex"6080604052aabbccddeea1b2c30003";
        assertEq(probe.identityOf(a), keccak256(hex"6080604052aabbccddee"), "the trailer was not cut by its length");
        assertEq(
            probe.identityOf(hex"6080604052aabbccddeeffffff0003"),
            probe.identityOf(a),
            "a different trailer gave a different identity"
        );
        assertTrue(
            probe.identityOf(hex"6080604052aabbccddefa1b2c30003") != probe.identityOf(a),
            "a different body gave the same identity"
        );
        assertEq(probe.identityOf(hex"0000"), keccak256(""), "an empty trailer and no body");
    }

    function test_codeIdentity_refusesALengthPastTheCodeAndAMissingTrailer() public {
        vm.expectRevert(bytes("the metadata length runs past the code"));
        probe.identityOf(hex"6080a1b2c30006");
        vm.expectRevert(bytes("no runtime code to identify"));
        probe.identityOf(hex"00");
    }

    /// THE PIN ITSELF: this build's five unchanged contracts are the reviewed
    /// ones. It fails the moment one of them is edited, which is its purpose;
    /// a deliberate change updates the constant in DeployCurb.s.sol.
    function test_theFiveUnchangedContractsBuildToTheirPinnedIdentities() public view {
        probe.unchanged();
    }

    /// The five are the contracts core v2 leaves unchanged, each named by its
    /// own artifact - a pin beside the wrong artifact would refuse every build.
    function test_pinnedCode_namesTheFiveUnchangedContracts() public view {
        (string[5] memory a,) = probe.pins();
        assertEq(a[0], "PonsV2BondingCurve.sol:PonsV2BondingCurve");
        assertEq(a[1], "FeeEscrow.sol:FeeEscrow");
        assertEq(a[2], "CurbLaunchToken.sol:CurbLaunchToken");
        assertEq(a[3], "FeePolicy.sol:FeePolicy");
        assertEq(a[4], "PonsV2BuybackVault.sol:PonsV2BuybackVault");
    }

    /// EACH OF THE FIVE IS ASKED: one wrong pin at a time, and the run stops
    /// naming that artifact.
    function test_eachOfTheFivePinsIsAsked() public {
        (string[5] memory a,) = probe.pins();
        bytes32 wrong = keccak256("not the reviewed code");
        for (uint256 i = 0; i < 5; i++) {
            probe.breakPin(i, wrong);
            bytes32 actual = probe.identityOf(vm.getDeployedCode(a[i]));
            vm.expectRevert(
                bytes(
                    string.concat(
                        a[i],
                        " builds to code identity ",
                        vm.toString(actual),
                        ", not the pinned ",
                        vm.toString(wrong),
                        ": its code changed. Core v2 leaves it unchanged; if the change is meant, update its IDENTITY_ constant."
                    )
                )
            );
            probe.unchanged();
        }
        probe.breakPin(type(uint256).max, bytes32(0));
        probe.unchanged();
    }

    /// A build that differs is refused, naming the artifact, what it builds
    /// to and what was pinned.
    function test_aChangedContractIsRefusedBeforeAnythingIsSent() public {
        bytes32 actual = probe.identityOf(vm.getDeployedCode("FeeEscrow.sol:FeeEscrow"));
        bytes32 pinned = bytes32(uint256(1));
        vm.expectRevert(
            bytes(
                string.concat(
                    "FeeEscrow.sol:FeeEscrow builds to code identity ",
                    vm.toString(actual),
                    ", not the pinned ",
                    vm.toString(pinned),
                    ": its code changed. Core v2 leaves it unchanged; if the change is meant, update its IDENTITY_ constant."
                )
            )
        );
        probe.identity("FeeEscrow.sol:FeeEscrow", pinned);
        // and the same artifact against its own identity passes (the control)
        probe.identity("FeeEscrow.sol:FeeEscrow", actual);
    }

    // ================================================================
    // THE READ-BACK OF THE DEPLOY ORDER
    // ================================================================

    struct Built {
        LaunchRegistry registry;
        SharingCatalog catalog;
        Graduator graduator;
        LaunchLens lens;
    }

    /// The shared contracts the order builds, with placeholder v4 addresses:
    /// nothing here trades, and the Graduator's constructor asks only that
    /// they are not zero.
    function _built() internal returns (Built memory b) {
        b.registry = new LaunchRegistry(address(this));
        b.catalog = new SharingCatalog(owner_, address(this));
        b.graduator = new Graduator(
            IPoolManager(address(0x1001)),
            IPositionManagerMinimal(address(0x1002)),
            IPermit2Minimal(address(0x1003)),
            b.registry,
            ISharingCatalog(address(b.catalog))
        );
        b.lens = new LaunchLens(b.registry, b.graduator);
    }

    function _roles() internal view returns (DeployCurb.SharingRoles memory r) {
        r.publisher = publisher;
        r.keeperPayee = keeper;
        r.vetoers = _list(guardian, owner_);
    }

    /// The control: the deploy order's own contracts, the real factory built
    /// with the roles and admitted by the deployer, pass every read-back.
    function test_wiring_theDeployOrdersOwnContractsPass() public {
        Built memory b = _built();
        HolderDistributorFactory f = new HolderDistributorFactory(
            address(b.registry), address(b.graduator), owner_, publisher, keeper, _list(guardian, owner_)
        );
        b.catalog.admitInitial(address(f));
        probe.wiring(b.registry, b.catalog, b.graduator, f, b.lens, address(this), owner_, _roles());
    }

    function _fakeAdmitted(Built memory b) internal returns (FakeDistributorFactory f, FakeImplementation impl) {
        f = new FakeDistributorFactory();
        impl = new FakeImplementation();
        f.set(address(b.registry), address(b.graduator), owner_, publisher, keeper);
        f.setVetoer(guardian, true);
        f.setVetoer(owner_, true);
        f.setImplementation(address(impl));
        impl.set(address(f), address(b.graduator));
        b.catalog.admitInitial(address(f));
    }

    function _expectWiring(Built memory b, address f, address deployer, address owner, string memory why) internal {
        vm.expectRevert(bytes(why));
        probe.wiring(b.registry, b.catalog, b.graduator, HolderDistributorFactory(f), b.lens, deployer, owner, _roles());
    }

    /// Each link, broken on its own, is refused with its own sentence.
    function test_wiring_eachLinkIsReadBackOnItsOwn() public {
        Built memory b = _built();
        (FakeDistributorFactory f, FakeImplementation impl) = _fakeAdmitted(b);
        // the fake as admitted passes (the control for every case below)
        probe.wiring(b.registry, b.catalog, b.graduator, HolderDistributorFactory(address(f)), b.lens, address(this), owner_, _roles());

        // the Graduator against another registry, and another catalog
        Built memory other = _built();
        vm.expectRevert(bytes("the Graduator reads another registry"));
        probe.wiring(other.registry, b.catalog, b.graduator, HolderDistributorFactory(address(f)), b.lens, address(this), owner_, _roles());
        vm.expectRevert(bytes("the Graduator asks another sharing catalog"));
        probe.wiring(b.registry, other.catalog, b.graduator, HolderDistributorFactory(address(f)), b.lens, address(this), owner_, _roles());

        // the catalog's owner and bootstrapper
        _expectWiring(b, address(f), address(this), makeAddr("not the owner"), "the sharing catalog's owner is not CURB_POLICY_OWNER");
        _expectWiring(b, address(f), makeAddr("not the deployer"), owner_, "the sharing catalog's bootstrapper is not the deployer");

        // the distributor factory's registry, Graduator, owner, roles and state
        f.set(address(other.registry), address(b.graduator), owner_, publisher, keeper);
        _expectWiring(b, address(f), address(this), owner_, "the distributor factory reads another registry");
        f.set(address(b.registry), address(other.graduator), owner_, publisher, keeper);
        _expectWiring(b, address(f), address(this), owner_, "the distributor factory reads another Graduator");
        f.set(address(b.registry), address(b.graduator), makeAddr("someone else"), publisher, keeper);
        _expectWiring(b, address(f), address(this), owner_, "the distributor factory's owner is not CURB_POLICY_OWNER");
        f.set(address(b.registry), address(b.graduator), owner_, makeAddr("another publisher"), keeper);
        _expectWiring(b, address(f), address(this), owner_, "the distributor factory's publisher is not the one named");
        f.set(address(b.registry), address(b.graduator), owner_, publisher, makeAddr("another payee"));
        _expectWiring(b, address(f), address(this), owner_, "the distributor factory's keeper payee is not the one named");
        f.set(address(b.registry), address(b.graduator), owner_, publisher, keeper);
        f.setVetoer(guardian, false);
        _expectWiring(b, address(f), address(this), owner_, "a vetoer named is not a vetoer of the distributor factory");
        f.setVetoer(guardian, true);
        f.setVetoer(owner_, false);
        _expectWiring(b, address(f), address(this), owner_, "a vetoer named is not a vetoer of the distributor factory");
        f.setVetoer(owner_, true);
        f.setFrozen(true);
        _expectWiring(b, address(f), address(this), owner_, "the distributor factory starts frozen");
        f.setFrozen(false);

        // the implementation: no code, another factory, another Graduator
        f.setImplementation(makeAddr("no code here"));
        _expectWiring(b, address(f), address(this), owner_, "the distributor implementation has no code");
        f.setImplementation(address(impl));
        impl.set(makeAddr("another factory"), address(b.graduator));
        _expectWiring(b, address(f), address(this), owner_, "the distributor implementation answers to another factory");
        impl.set(address(f), address(other.graduator));
        _expectWiring(b, address(f), address(this), owner_, "the distributor implementation reads another Graduator");
        impl.set(address(f), address(b.graduator));

        // the lens
        LaunchLens wrongRegistry = new LaunchLens(other.registry, b.graduator);
        vm.expectRevert(bytes("the lens reads another registry"));
        probe.wiring(b.registry, b.catalog, b.graduator, HolderDistributorFactory(address(f)), wrongRegistry, address(this), owner_, _roles());
        LaunchLens wrongGraduator = new LaunchLens(b.registry, other.graduator);
        vm.expectRevert(bytes("the lens reads another Graduator"));
        probe.wiring(b.registry, b.catalog, b.graduator, HolderDistributorFactory(address(f)), wrongGraduator, address(this), owner_, _roles());

        // and everything put back passes again
        probe.wiring(b.registry, b.catalog, b.graduator, HolderDistributorFactory(address(f)), b.lens, address(this), owner_, _roles());
    }

    /// The catalog's three answers about the factory: bootstrapped, approved,
    /// recommended - each refused on its own.
    function test_wiring_theCatalogMustHaveAdmittedAndRecommendTheFactory() public {
        Built memory b = _built();
        FakeDistributorFactory f = new FakeDistributorFactory();
        FakeImplementation impl = new FakeImplementation();
        f.set(address(b.registry), address(b.graduator), owner_, publisher, keeper);
        f.setVetoer(guardian, true);
        f.setVetoer(owner_, true);
        f.setImplementation(address(impl));
        impl.set(address(f), address(b.graduator));

        // never admitted, bootstrap unused
        _expectWiring(b, address(f), address(this), owner_, "the sharing catalog's bootstrap was not used");

        // the bootstrap spent on another factory: not approved
        FakeDistributorFactory first = new FakeDistributorFactory();
        b.catalog.admitInitial(address(first));
        _expectWiring(b, address(f), address(this), owner_, "the sharing catalog does not approve the distributor factory");

        // approved through the delay, but another is recommended
        vm.prank(owner_);
        b.catalog.propose(address(f));
        vm.warp(vm.getBlockTimestamp() + b.catalog.ADMISSION_DELAY());
        _expectWiring(b, address(f), address(this), owner_, "the sharing catalog does not recommend the distributor factory");

        // recommended: passes (the control)
        vm.prank(owner_);
        b.catalog.setRecommended(address(f));
        probe.wiring(b.registry, b.catalog, b.graduator, HolderDistributorFactory(address(f)), b.lens, address(this), owner_, _roles());
    }
}
