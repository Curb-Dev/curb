// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

/// @dev What wire() has to be able to check about the hook and the graduator.
interface IWiringCheck {
    function poolManager() external view returns (address);
    function poolOpener() external view returns (address);
    function platformRecipient() external view returns (address);
}

interface IGraduatorWiring {
    function poolManager() external view returns (address);
    function registry() external view returns (address);
}

interface ILauncherWiring {
    function graduator() external view returns (address);
}

/// @dev What register() asks of a record's curve, so the curve itself vouches
///      for the record that names it. PonsV2BondingCurve answers all three.
interface IRegisteredCurve {
    function token() external view returns (address);
    function pairToken() external view returns (address);
    function factory() external view returns (address);
}

/**
 * @title LaunchRegistry
 * @notice The record of what a launch was promised, written once at launch and
 *         read at graduation.
 *
 * WHY THIS EXISTS - A REAL HOLE IT CLOSES
 *   Graduation needs a beneficiary, a refund address and a
 *   pool configuration. If those arrive as call arguments, then ANY caller
 *   picks them. That is not hypothetical: for graduation to move a curve's
 *   reserves, the curve must approve the graduator, and an ERC-20 allowance
 *   authorises the GRADUATOR CONTRACT - not any particular caller of it. So a
 *   stranger could point a graduation at someone else's funded curve and lock
 *   the resulting LP position for themselves.
 *
 *   Here the economic terms are not parameters at all. They are written when
 *   the launch is created and cannot be changed afterwards, by anyone,
 *   including us.
 *
 * WRITE-ONCE, DELIBERATELY
 *   register() refuses to overwrite. A launcher that could rewrite the
 *   beneficiary after people had bought into a launch would be able to take
 *   the LP position at graduation, which is the same hole one level up.
 *
 * IT ALSO REFUSES A CONFIGURATION THAT COULD NOT GRADUATE
 *   The record is permanent, so a bad one is not a retryable mistake: the
 *   launch would take people's money and then be unable to graduate, with no
 *   way to correct it. So the terms are checked HERE, at registration, before
 *   a single buy:
 *
 *     - tickSpacing must be in v4's legal range. Zero would divide by zero
 *       while computing the full-range ticks at graduation.
 *     - the hook must be THE product hook this registry was wired to. Checking
 *       permissions alone was not enough: a hook with no liquidity permissions
 *       can still be pointed at the wrong poolOpener, and then nobody - not
 *       even the graduator - can open the pool, and the launch is stuck after
 *       the sale. Requiring one known address settles the poolOpener, the
 *       permission bits and the fee behaviour together.
 *     - the pool fee must be one this product supports. v4 rejects a fee above
 *       its maximum at initialize(), which would be discovered at graduation,
 *       when it is too late to change.
 *
 *   This is the difference between "the transaction reverted, try again" and
 *   "this launch can never graduate". Only the first is a retry.
 *
 * A RECORD NAMES ITS OWN CURVE, AND NO OTHER RECORD NAMES IT
 *   The curve must answer token() with the record's launch token, pairToken()
 *   with the record's quote asset and factory() with the registering
 *   launcher's graduator, and a curve one record names is refused for any
 *   other. Nothing tied the two together before, and the Graduator holds
 *   every curve's factory role: a launcher could register a token of its own
 *   over a LIVE launch's curve, then graduate that curve's whole reserve into
 *   a pool it controlled, or move that launch's creator income to its own
 *   distributor. See register().
 *
 * THE PRIVILEGE THAT REMAINS, NAMED
 *   The launchers - every address in isLauncher - decide what gets registered
 *   and therefore what can graduate at all. None can redirect an EXISTING
 *   record, and none can name another launch's curve in a record of its own,
 *   but a launch no launcher registers can never graduate.
 *
 *   The owner admits launchers: the first through wire(), which also fixes the
 *   one hook every launcher is checked against, and more afterwards through
 *   addLauncher(), each passing the same loop check, up to MAX_LAUNCHERS in
 *   all. Launchers are add-only and can never be removed. The owner role is
 *   Ownable2Step, so it can be handed on but not to an address that has not
 *   accepted.
 *
 *   This header used to name `launcher`, a single contract, as the privilege.
 *   That field is only the FIRST launcher, kept for readers; register() gates
 *   on isLauncher.
 *
 * THE RECORD'S SHAPE IS A PERMANENT INTERFACE, AND THESE RULES KEEP IT ONE
 *   CurbRouter (0xEa20C3266229a01cd0f45D9c7921a45d5b359561) takes a registry
 *   as a call argument and decodes launchOf() with its own copy of the first
 *   eleven fields. Solidity copies the words it knows and ignores the rest,
 *   so the record may grow without a router rebuild for as long as:
 *     1. `curve` and `quoteToken` stay words 0 and 1;
 *     2. every new field is static and appended at the end;
 *     3. isRegistered(address) returns (bool) and launchOf(address) keep
 *        their names and inputs;
 *     4. `quoteToken` still means the asset the curve trades in.
 *   A dynamic field anywhere would force the router to be rebuilt at a new
 *   address.
 */
contract LaunchRegistry is Ownable2Step {
    struct Launch {
        /// The bonding curve holding this launch's reserves.
        address curve;
        /// The stock-paired quote asset the curve trades against.
        address quoteToken;
        /// Who the graduated LP position is locked for.
        address beneficiary;
        /// Where leftover QUOTE - NVDAc - is returned after the pool is
        /// seeded. Not the launch token: that remainder is BURNED instead, and
        /// the Graduator says why in its own step 8. Naming these apart matters
        /// because the burned side is about a quarter of the supply.
        address refundTo;
        /// ALWAYS ZERO. This word held a lock duration when the graduated
        /// position could be withdrawn after one; it is now locked forever and
        /// nothing reads this word. It is kept, and register() requires it to
        /// be zero, so that every later word stays where readers decode it.
        uint256 reservedZero;
        uint24 fee;
        int24 tickSpacing;
        IHooks hooks;
        /// The ONE tax this launch charges on every buy and every sell, in
        /// basis points of the launch's quote asset. The platform's share -
        /// platformBps below, frozen into this record at launch - comes out of
        /// it and the creator takes the rest; raising it raises only the
        /// creator's part. Chosen by the creator AT LAUNCH and written
        /// here, which is a write-once record - so nobody, including us,
        /// can change it afterwards, and the graduated pool is bound to the
        /// same number as the curve.
        uint16 totalTaxBps;
        /// THE PLATFORM'S SHARE OF THAT TAX, AND WHO RECEIVES IT - one
        /// snapshot, taken when the launch was created, used by the curve and
        /// by the pool that opens later.
        ///
        /// THE HOOK'S OWN VALUES ARE THE POLICY FOR THE NEXT LAUNCH, not for
        /// this one. They were read twice before this field existed - once by
        /// the factory into the curve, once by the hook into the pool - and a
        /// change announced between those two moments split a single launch in
        /// half. Here they are written once into the thing that is permanent.
        uint16 platformBps;
        address platformRecipient;
        /// WHEN THE RECORD WAS WRITTEN, by the registry's clock, never the
        /// launcher's: register() overwrites whatever the launcher passed with
        /// block.timestamp. Last, and packed beside platformRecipient, so it
        /// costs no storage slot and moves no word a reader already decodes.
        uint64 launchedAt;
    }

    /// THE TAX BAND, DEFINED HERE AND NOWHERE ELSE.
    ///
    /// It lives in the registry rather than in the factory because the record
    /// is the thing that is permanent: the curve reads its own rate at
    /// construction and the graduated pool will read this record, so a value
    /// outside the band must be impossible to WRITE, not merely impossible to
    /// pass through today's factory. A later launcher gets the same refusal.
    ///
    /// The factory reads both of these at construction and enforces the same
    /// band itself, so the two cannot drift apart.
    uint16 public constant MIN_TOTAL_TAX_BPS = 100;
    uint16 public constant MAX_TOTAL_TAX_BPS = 500;

    /// THE PLATFORM'S STARTING SHARE, AND NOTHING MORE.
    ///
    /// FeeHook reads this once, in its constructor, as the initial value of its
    /// own settable platformFeeBps. From there the share is the HOOK'S: the
    /// owner may announce a change and it lands after a delay, and launch()
    /// reads the hook's value and freezes it into each launch's record
    /// (Launch.platformBps), which is what both the curve and the pool charge.
    ///
    /// This used to say it was defined here and nowhere else and read by both
    /// chargers at construction. Neither was true: the factory keeps its own
    /// PLATFORM_FEE_BPS as the floor its tax band is checked against, and no
    /// charger reads this one after the hook is built.
    uint16 public constant PLATFORM_FEE_BPS = 50;

    /// The exact permission set the product hook must claim: it gates pool
    /// initialization and takes a fee on each side of a swap - the input in
    /// beforeSwap, the output in afterSwap - and nothing else.
    /// An address encodes its permissions, so this is checkable without
    /// trusting the code behind it.
    /// BEFORE_SWAP AND ITS DELTA ARE NEW, and they are the whole reason the
    /// hook's address changed. The fee is charged on the NVDAc side in both
    /// directions, and on a buy NVDAc is the INPUT - which afterSwap cannot
    /// reach, since for an exact-input swap the unspecified side is the
    /// output. Taking the input needs a delta on the SPECIFIED currency in
    /// beforeSwap. A hook encodes its permissions in its address, so this is
    /// checkable here without trusting the code behind it.
    uint160 internal constant REQUIRED_HOOK_FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
            | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
    );

    /// Every hook permission that can block a liquidity operation. Kept as a
    /// belt-and-braces check on whatever hook is wired in.
    uint160 internal constant LIQUIDITY_BLOCKING_FLAGS = uint160(
        Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.AFTER_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.AFTER_REMOVE_LIQUIDITY_FLAG
    );

    /// The FIRST launcher wired, kept under its old name so nothing that reads
    /// it has to change. The cycle is real - the registry needs the factory's
    /// address, the factory needs the graduator's, the graduator needs the
    /// registry's - so the first launcher and the hook are wired in one call.
    /// The owner keeps one standing power after it: admitting more launchers
    /// through addLauncher(), each checked against that same hook.
    address public launcher;
    /// The ONE hook a launch may be registered with. Deliberately an exact
    /// address rather than a property test: see the note above.
    address public requiredHook;
    bool public wired;

    /// MORE THAN ONE LAUNCHER, BECAUSE THE QUOTE ASSET AND THE PARAMETERS THAT
    /// GO WITH IT ARE IMMUTABLE ON A FACTORY. A second quote asset therefore
    /// needs a second factory, and a registry that admits only one would force
    /// a second registry - which would split discovery in two and buy nothing.
    ///
    /// ADD-ONLY, AND NEVER REPLACEABLE. The property that made one write-once
    /// call safe was that nothing could be swapped underneath a live launch;
    /// that property is kept here by having no removal and no overwrite. Each
    /// launcher passes the SAME loop check the first one did, against the hook
    /// fixed by the first call, and a launcher that is already in cannot be
    /// re-added.
    mapping(address launcher => bool) public isLauncher;
    address[] private _launchers;

    /// AND THE LIST HAS A CEILING. Every launch walks it (the factory refuses a
    /// launcher's escrow as a beneficiary) and so does every platform-recipient
    /// change in the hook, each with gas-capped probes per launcher. Without a
    /// ceiling, whoever holds the owner key could admit enough junk launchers -
    /// each one passing every check above for a few cents - to push every
    /// launch past a block's gas, for good, since nothing can be removed.
    /// Thirty-two is about three times the assets used today and bounds that
    /// walk at roughly 2M gas per launch whoever holds the key.
    uint256 public constant MAX_LAUNCHERS = 32;

    mapping(address launchToken => Launch) private _launches;

    /// THE TOKEN EACH REGISTERED CURVE WAS REGISTERED FOR, so no curve is
    /// named by two records. Written once, by register(), never cleared.
    mapping(address curve => address launchToken) public launchOfCurve;

    /// EVERY LAUNCH TOKEN, IN REGISTRATION ORDER - so the thing can be browsed.
    ///
    /// A mapping cannot be walked, and without this the only way to build a
    /// list is eth_getLogs over LaunchRegistered. MEASURED against the upstream
    /// this project uses: "eth_getLogs is limited to a 2,000 range" - about 67
    /// minutes of Base at 2s blocks. A month after deployment that is ~650
    /// requests to draw one page, a year after it is ~7,900. That is not a page
    /// anyone waits for, and it gets worse every day by construction.
    ///
    /// No entry can repeat: register() refuses a token that already has a
    /// record, so the push below happens exactly once per token.
    address[] private _all;

    error IndexOutOfRange(uint256 index, uint256 length);

    event LauncherSet(address indexed launcher);
    event LaunchRegistered(address indexed launchToken, address indexed curve, address indexed beneficiary);

    error NotTheLauncher(address caller);
    error NotTheDeployer(address caller);
    error LauncherAlreadySet(address launcher);
    error TooManyLaunchers(uint256 maximum);
    error LauncherNotSet();
    error AlreadyRegistered(address launchToken);
    error NotRegistered(address launchToken);
    error IncompleteRecord();
    /// The record's retired lock-duration word was not zero. See reservedZero.
    error ReservedWordNotZero(uint256 value);
    /// DELIBERATELY NOT THE SAME SIGNATURE AS THE FACTORY'S. Both refuse a tax
    /// outside the band, and an identical `TaxOutOfRange(uint16,uint16,uint16)`
    /// on both would share a selector - so a test could not tell which contract
    /// refused, and deleting the factory's check would leave every test green.
    /// That is not a hypothetical: it happened, and a mutation run caught it.
    error TaxOutOfRange(uint16 totalTaxBps, uint16 minimum, uint16 maximum);
    error PlatformShareAboveTax(uint16 platformBps, uint16 totalTaxBps);
    error BeneficiaryIsTheEscrow(address beneficiary);
    error PlatformRecipientIsTheEscrow(address platformRecipient);
    error IllegalTickSpacing(int24 tickSpacing);
    error HookCanBlockLiquidity(address hooks);
    error UnsupportedHook(address hooks, address required);
    error UnsupportedPoolFee(uint24 fee);
    error GraduatorPointsElsewhere(address graduator, address itsRegistry);
    error HookHasNoCode(address hooks);
    error HookHasWrongPermissions(address hooks, uint160 claimed);
    error HookHasWrongOpener(address hooks, address itsOpener, address graduator);
    error HookHasWrongPoolManager(address hooks, address itsPoolManager);
    /// The launcher will not say which escrow its curves pay, or says zero.
    error LauncherEscrowUnreadable(address launcher);
    /// The hook's platform recipient is this launcher, or this launcher's escrow.
    error LauncherIsThePlatformRecipient(address launcher, address platformRecipient);
    /// The record's curve did not answer `question` - token(), pairToken() or
    /// factory() - with the record's own value, or did not answer at all.
    error CurveDoesNotMatch(address curve, bytes4 question);
    /// Another record already names this curve.
    error CurveAlreadyRegistered(address curve, address launchToken);

    /// THE ROLE'S NAME EVERYWHERE ELSE IN THIS REPO. It is the owner now and
    /// can be handed on, but nothing that reads it has to learn a new word.
    function deployer() public view returns (address) {
        return owner();
    }

    /// @dev Ownable's own zero check runs before this body, so a zero here
    ///      reverts OwnableInvalidOwner rather than IncompleteRecord. That is
    ///      the only reason the check that used to be on this line is gone.
    constructor(address deployer_) Ownable(deployer_) {}

    /// @notice Names the FIRST launcher and fixes the one hook every later
    ///         launcher is checked against. Callable exactly once, by the
    ///         owner, before any launch exists. Further launchers come in
    ///         through addLauncher().
    ///
    /// Both in one call because both close the same cycle: the hook's
    /// poolOpener is the graduator, the graduator needs this registry, and
    /// this registry needs the factory. One write-once step for the hook and
    /// the first launcher; afterwards the only thing that changes is the
    /// launcher set, growing through addLauncher(), and no record ever does.
    ///
    /// AND THE WIRING IS CHECKED, NOT JUST RECORDED. Requiring registered
    /// launches to match `requiredHook` only proves they match whatever was
    /// chosen here - it says nothing about whether that choice works. A hook
    /// with no code, or the right code pointed at the wrong opener or the wrong
    /// PoolManager, would be accepted and every launch under it would be stuck
    /// after its sale. So this call verifies the whole loop closes:
    ///
    ///   the launcher's graduator points back at THIS registry
    ///   the hook has code, and exactly the permissions this design needs
    ///   the hook's poolOpener IS that graduator
    ///   the hook and the graduator agree on the PoolManager
    ///   the launcher names its escrow, and the hook does not pay either
    ///
    /// After that, the address-equality check in register() is a real check,
    /// because the address it compares against has been shown to work.
    function wire(address launcher_, address requiredHook_) external {
        if (msg.sender != owner()) revert NotTheDeployer(msg.sender);
        if (wired) revert LauncherAlreadySet(launcher);
        if (launcher_ == address(0) || requiredHook_ == address(0)) revert IncompleteRecord();

        _checkLoopCloses(launcher_, requiredHook_);

        wired = true;
        launcher = launcher_;
        requiredHook = requiredHook_;
        _addLauncher(launcher_);
    }

    /// @notice Admits another factory, against the hook this registry already
    ///         fixed. For a second quote asset, which needs its own factory
    ///         because the asset and its parameters are immutable there.
    ///
    /// @dev THE HOOK IS NOT A PARAMETER HERE, AND THAT IS THE POINT. It was
    ///      chosen and proved by wire(); letting a later call name a different
    ///      one would reopen exactly the hole wire()'s checks close. Every other
    ///      check wire() performs is performed again, against that same hook.
    ///
    ///      There is no removal and no replacement. A launcher that is in is in
    ///      for good, so no launch can have the thing that registered it swapped
    ///      out from under it.
    function addLauncher(address launcher_) external {
        if (msg.sender != owner()) revert NotTheDeployer(msg.sender);
        if (!wired) revert LauncherNotSet();
        if (launcher_ == address(0)) revert IncompleteRecord();
        if (isLauncher[launcher_]) revert LauncherAlreadySet(launcher_);

        _checkLoopCloses(launcher_, requiredHook);
        _addLauncher(launcher_);
    }

    function launcherCount() external view returns (uint256) {
        return _launchers.length;
    }

    function launcherAt(uint256 index) external view returns (address) {
        if (index >= _launchers.length) revert IndexOutOfRange(index, _launchers.length);
        return _launchers[index];
    }

    function _addLauncher(address launcher_) private {
        if (_launchers.length >= MAX_LAUNCHERS) revert TooManyLaunchers(MAX_LAUNCHERS);
        isLauncher[launcher_] = true;
        _launchers.push(launcher_);
        emit LauncherSet(launcher_);
    }

    /// THE WHOLE LOOP, CHECKED RATHER THAN RECORDED. Requiring registered
    /// launches to match `requiredHook` only proves they match whatever was
    /// chosen; it says nothing about whether that choice works. So: the
    /// launcher's graduator points back at THIS registry, the hook has code and
    /// exactly the permissions this design needs, the hook's poolOpener IS that
    /// graduator, and hook and graduator agree on the PoolManager. Then the
    /// launcher names its escrow, and neither is the hook's platform recipient.
    function _checkLoopCloses(address launcher_, address hook_) private view {
        address graduator = ILauncherWiring(launcher_).graduator();
        if (IGraduatorWiring(graduator).registry() != address(this)) {
            revert GraduatorPointsElsewhere(graduator, IGraduatorWiring(graduator).registry());
        }
        if (hook_.code.length == 0) revert HookHasNoCode(hook_);
        if (uint160(hook_) & Hooks.ALL_HOOK_MASK != REQUIRED_HOOK_FLAGS) {
            revert HookHasWrongPermissions(hook_, uint160(hook_) & Hooks.ALL_HOOK_MASK);
        }
        if (IWiringCheck(hook_).poolOpener() != graduator) {
            revert HookHasWrongOpener(hook_, IWiringCheck(hook_).poolOpener(), graduator);
        }
        if (IWiringCheck(hook_).poolManager() != IGraduatorWiring(graduator).poolManager()) {
            revert HookHasWrongPoolManager(hook_, IWiringCheck(hook_).poolManager());
        }

        // THE LAUNCHER MUST NAME ITS ESCROW. The hook asks every admitted
        // launcher for its feeEscrow() whenever a platform recipient is
        // announced or lands, so it can refuse any of them as the payee. There
        // is no removal from this list: ONE launcher that cannot answer would
        // make every later announcement and execution revert, and the platform
        // recipient could never be changed again. Refused here, once, where
        // refusing costs nothing permanent. A zero is refused with it: no curve
        // can pay an escrow at address zero, so a launcher saying so is wrong.
        (bool okEsc, bytes memory rawEsc) = launcher_.staticcall(abi.encodeWithSignature("feeEscrow()"));
        if (!okEsc || rawEsc.length != 32) revert LauncherEscrowUnreadable(launcher_);
        address escrow = abi.decode(rawEsc, (address));
        if (escrow == address(0)) revert LauncherEscrowUnreadable(launcher_);

        // AND NEITHER IT NOR ITS ESCROW CAN ALREADY BE THE PLATFORM RECIPIENT.
        // The hook refuses both when a recipient is announced and again when it
        // lands, but only for launchers admitted by then. So a recipient can
        // land FIRST - an escrow deployed but not yet admitted, or an address
        // predicted for one. WHAT THIS DOES NOT DO: undo that. From the moment
        // it landed, every other factory stamps it into its launches, and
        // nothing on chain could have known the address would be an escrow.
        // WHAT IT DOES: refuse to admit the launcher until the recipient is
        // corrected, and say so here, before any launch, instead of at the
        // first launch this launcher's own factory refuses. It also makes the
        // live recipient never an admitted launcher or its escrow, in either
        // order, without leaning on each factory's own check - which is
        // CurbLaunchFactory's, not every launcher's. (A recipient still PENDING
        // is caught by the hook's own check when it lands.)
        address recipient = IWiringCheck(hook_).platformRecipient();
        if (recipient == launcher_ || recipient == escrow) revert LauncherIsThePlatformRecipient(launcher_, recipient);
    }

    /// @notice Pool fee tiers this product supports. Anything else is refused
    ///         at registration rather than discovered at graduation.
    function isSupportedFee(uint24 fee) public pure returns (bool) {
        return fee == 500 || fee == 3000 || fee == 10_000;
    }

    function register(address launchToken, Launch calldata launch) external {
        if (!wired) revert LauncherNotSet();
        if (!isLauncher[msg.sender]) revert NotTheLauncher(msg.sender);
        if (launchToken == address(0)) revert IncompleteRecord();
        if (_launches[launchToken].curve != address(0)) revert AlreadyRegistered(launchToken);
        if (
            launch.curve == address(0) || launch.quoteToken == address(0) || launch.beneficiary == address(0)
                || launch.refundTo == address(0)
        ) {
            revert IncompleteRecord();
        }
        if (launch.quoteToken == launchToken) revert IncompleteRecord();
        // THE BENEFICIARY IS NOT THE CURVE'S OWN ESCROW. The escrow refuses to
        // credit itself, so every sweep - and graduate(), which sweeps first -
        // would revert on such a launch. The factory refuses it too; checked
        // here as well because further launchers can be admitted. Asked of the
        // curve, since the escrow is the curve's; a curve that will not say is
        // not refused for that alone.
        {
            (bool okEsc, bytes memory rawEsc) = launch.curve.staticcall(abi.encodeWithSignature("feeEscrow()"));
            if (okEsc && rawEsc.length == 32) {
                address escrow = abi.decode(rawEsc, (address));
                if (escrow == launch.beneficiary) revert BeneficiaryIsTheEscrow(launch.beneficiary);
                // THE PLATFORM RECIPIENT TOO: the curve credits it through the
                // same escrow call, so the same brick.
                if (escrow == launch.platformRecipient) revert PlatformRecipientIsTheEscrow(launch.platformRecipient);
            }
        }

        // A permanent record of terms that cannot work is worse than a failed
        // transaction, so these are checked before anyone can buy.
        if (launch.reservedZero != 0) revert ReservedWordNotZero(launch.reservedZero);
        if (launch.tickSpacing < TickMath.MIN_TICK_SPACING || launch.tickSpacing > TickMath.MAX_TICK_SPACING) {
            revert IllegalTickSpacing(launch.tickSpacing);
        }
        if (address(launch.hooks) != requiredHook) {
            revert UnsupportedHook(address(launch.hooks), requiredHook);
        }
        if (uint160(address(launch.hooks)) & LIQUIDITY_BLOCKING_FLAGS != 0) {
            revert HookCanBlockLiquidity(address(launch.hooks));
        }
        if (!isSupportedFee(launch.fee)) revert UnsupportedPoolFee(launch.fee);
        if (launch.totalTaxBps < MIN_TOTAL_TAX_BPS || launch.totalTaxBps > MAX_TOTAL_TAX_BPS) {
            revert TaxOutOfRange(launch.totalTaxBps, MIN_TOTAL_TAX_BPS, MAX_TOTAL_TAX_BPS);
        }
        // AND THE PLATFORM SNAPSHOT, the two newest permanent fields and the
        // only two that went unchecked. A share above the whole tax registers
        // cleanly and then underflows FeeHook._legs on the first pool swap -
        // every trade in that pool reverting forever, with the LP position
        // locked inside it. A zero recipient writes a pool whose platform leg
        // is owed to nobody. Today's factory refuses both; the reason to check
        // here is that further launchers can be admitted and the record cannot
        // be edited afterwards.
        if (launch.platformRecipient == address(0)) revert IncompleteRecord();
        if (launch.platformBps > launch.totalTaxBps) {
            revert PlatformShareAboveTax(launch.platformBps, launch.totalTaxBps);
        }

        // THE CURVE MUST BE THIS LAUNCH'S, AND NO OTHER RECORD'S. Nothing tied
        // the two together, and the Graduator holds every curve's factory role.
        // So an admitted launcher - a mistaken admission, a stolen owner key -
        // could register a token of its own over a LIVE launch's curve: then
        // graduate(<its token>) handed that curve's whole reserve and its tokens
        // to a pool the attacker's token was paired in, and the attacker drained
        // it with freely minted tokens (a fork run took 3.90 of a curve's 3.94
        // WETH); or the record's beneficiary switched holder sharing on and the
        // live launch's creator income went to the attacker's distributor.
        // The curve itself has to vouch for the record now: its token is this
        // token, its asset is this record's, its factory role is this
        // launcher's graduator. And a curve one record names is refused for
        // any other - a second line, since a real curve's token never changes.
        // CurbLaunchFactory initializes the curve before it registers, so its
        // own flow passes unchanged. LAST, so that every refusal above keeps
        // its own error.
        address curve = launch.curve;
        _requireCurveSays(curve, IRegisteredCurve.token.selector, launchToken);
        _requireCurveSays(curve, IRegisteredCurve.pairToken.selector, launch.quoteToken);
        _requireCurveSays(curve, IRegisteredCurve.factory.selector, ILauncherWiring(msg.sender).graduator());
        if (launchOfCurve[curve] != address(0)) revert CurveAlreadyRegistered(curve, launchOfCurve[curve]);
        launchOfCurve[curve] = launchToken;

        _launches[launchToken] = launch;
        // THE LAUNCHER'S VALUE IS NEVER TRUSTED. A reader orders and dates
        // launches by this word, so it is the registry's own clock.
        _launches[launchToken].launchedAt = uint64(block.timestamp);
        _all.push(launchToken);
        emit LaunchRegistered(launchToken, launch.curve, launch.beneficiary);
    }

    /// The curve answers the no-argument call `question` with exactly `want`,
    /// or the registration is refused.
    ///
    /// BOUNDED, BOTH WAYS, like the factory's reads of other launchers: 20,000
    /// gas for the call and one word of the reply copied, so a curve that burns
    /// its gas or answers with a megabyte costs a fixed amount. COMPARED AS A
    /// WHOLE WORD, not decoded: a dirty word over the right address is no
    /// match, and a curve with no code answers nothing and is refused.
    function _requireCurveSays(address curve, bytes4 question, address want) private view {
        uint256 word = uint256(uint160(want));
        bool hit;
        assembly ("memory-safe") {
            mstore(0, question)
            let ok := staticcall(20000, curve, 0, 4, 0, 32)
            hit := and(and(ok, eq(returndatasize(), 32)), eq(mload(0), word))
        }
        if (!hit) revert CurveDoesNotMatch(curve, question);
    }

    /// @notice How many launches have been registered.
    function launchCount() external view returns (uint256) {
        return _all.length;
    }

    /// @notice The launch token registered at `index`, oldest first.
    function launchAt(uint256 index) external view returns (address) {
        if (index >= _all.length) revert IndexOutOfRange(index, _all.length);
        return _all[index];
    }

    /// @notice Up to `count` launch tokens starting at `start`, oldest first.
    /// @dev A short read past the end rather than a revert: a caller paging
    ///      through a list that is still growing should get the tail it asked
    ///      for, not an error it has to guess the cause of. `start` past the
    ///      end IS an error - that is a caller with a wrong idea of the list,
    ///      not a race with it.
    function launchSlice(uint256 start, uint256 count) external view returns (address[] memory page) {
        uint256 n = _all.length;
        if (start > n) revert IndexOutOfRange(start, n);
        // COUNTED FROM THE ROOM LEFT, NOT BY ADDING TO `start`. `start + count`
        // overflows and panics for the one caller this function is written for
        // - somebody asking for "everything from here" with type(uint256).max -
        // which is the exact case the comment above promises a short read for.
        uint256 room = n - start;
        uint256 take = count > room ? room : count;
        page = new address[](take);
        for (uint256 i = 0; i < take; i++) {
            page[i] = _all[start + i];
        }
    }

    function launchOf(address launchToken) external view returns (Launch memory launch) {
        launch = _launches[launchToken];
        if (launch.curve == address(0)) revert NotRegistered(launchToken);
    }

    function isRegistered(address launchToken) external view returns (bool) {
        return _launches[launchToken].curve != address(0);
    }
}
