// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

import {PonsV2BondingCurve} from "../vendor/PonsV2BondingCurve.sol";
import {PonsV2BuybackVault} from "../vendor/PonsV2BuybackVault.sol";
import {FeePolicySnapshot, IPonsV2FeeEscrow, IPonsV2FeePolicy} from "../vendor/interfaces/ILaunchpadV2.sol";

/// @dev decimals() is OPTIONAL in ERC-20, so it gets its own minimal
///      interface rather than being assumed onto IERC20.
interface IDecimals {
    function decimals() external view returns (uint8);
}

/// @dev The fee policy, which lives on the HOOK - the same arrangement PONS
///      uses, where PonsV2MemeHook implements IPonsV2FeePolicy itself. Declared
///      narrowly here so the factory reads the two numbers it snapshots and
///      nothing else.
interface IPlatformPolicy {
    function platformFeeBps() external view returns (uint16);
    function platformRecipient() external view returns (address);
}

/// @dev What the registry requires every admitted launcher to answer. Declared
///      apart from this contract's own getter because a launcher need not be a
///      CurbLaunchFactory.
interface ILauncherFeeEscrow {
    function feeEscrow() external view returns (address);
    /// Asked of the other launchers only, and only through a bounded read:
    /// the registry requires feeEscrow() and nothing else of a launcher.
    function feePolicy() external view returns (address);
    function buybackVault() external view returns (address);
}

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {CurbLaunchToken} from "./CurbLaunchToken.sol";
import {LaunchRegistry} from "./LaunchRegistry.sol";
import {Graduator} from "./Graduator.sol";
import {PositionLock} from "./PositionLock.sol";

/**
 * @title CurbLaunchFactory
 * @notice Creates a launch: the curve, the token, the curve's initialization,
 *         and the registry record that fixes how it will graduate - in ONE
 *         transaction, before anyone can buy.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT OPTIONAL
 *   The graduation tests used to reach their starting state by impersonating
 *   the curve's factory role in the test itself:
 *
 *       vm.prank(address(graduator));
 *       curve.initialize(address(token));
 *
 *   That made graduation testable while leaving the state it graduates FROM
 *   unreachable with product contracts. A test that begins from a state the
 *   product cannot produce is testing a shape, not a system. This contract is
 *   that missing entry point.
 *
 * ANYONE MAY LAUNCH. THAT IS WHY ALMOST NOTHING IS A PARAMETER.
 *   launch() was owner-only, and an owner-only entry point can be handed a
 *   whole fee policy as calldata without anyone being able to abuse it. Opening
 *   the door changes what every parameter MEANS: a field a stranger fills in is
 *   not configuration, it is an attack surface.
 *
 *   So the door opened and the parameters closed in the same change. What a
 *   caller may choose is their launch's IDENTITY, ONE NUMBER, and who it is
 *   for:
 *
 *       name, symbol, tokenUri, salt     what the token is
 *       quoteRefundTo                    where leftover quote is returned
 *       totalTaxBps                      1% to 5%, the tax on their launch
 *       devBuy                           an optional first buy, capped
 *       creatorWallet                    who the launch is for (zero = caller)
 *       expectedPlatformBps/Recipient    what they read; refused if it moved
 *       holderShareFactory               share the creator income with the
 *                                        launch's holders (zero = no)
 *
 *   Everything with a price on it is fixed before a stranger can touch it:
 *   the supply, the curve's shape, the pool's fee tier and
 *   tick spacing, the hook, the fee policy and the escrow are fixed in this
 *   contract at construction. The PLATFORM'S share and recipient are read from
 *   the hook at launch and frozen into that launch's record - fixed for the
 *   launch, not for the factory, and never chosen by the caller.
 *
 *   THE CREATOR IS creatorWallet, OR msg.sender WHEN THAT IS ZERO. The same
 *   address becomes the curve's creator-fee recipient, the record's
 *   beneficiary (the locked LP position) and the hook's creator, and LaunchCreated
 *   indexes it as `creator` - until the launch's holder sharing is switched
 *   on, when its income (never the position) goes to the launch's
 *   distributor instead. It is NOT necessarily the sender, and nothing
 *   verifies it beyond refusing the contracts that would brick the launch
 *   (see launch()). This paragraph used to say the creator was always the
 *   sender and that a creator field did not exist; creatorWallet was added
 *   for a cold wallet and the paragraph was not.
 *
 * THE FEE SPLIT: ONE CONSTANT, AND ONE VALUE READ OFF THE HOOK AT LAUNCH
 *   One tax per launch, chosen by the creator between 1% and 5%. The platform
 *   takes the same share of the trade base at every tax setting - 0.5% at
 *   deployment, frozen per launch from the hook - and the creator takes the
 *   rest. Raising the tax raises the creator's half and nothing else.
 *
 *   The curve already has this shape, so no curve code changed. Its base fee is
 *   the platform's share as read from the hook at launch (0.5% at deployment)
 *   and its "creator tax" leg is the remainder -
 *   the leg that is paid to the creator in full and never enters the split. The
 *   protocol's share of the base fee is set to all of it, which is what makes
 *   the platform's take independent of what the creator chose:
 *
 *       feeBps              = the hook's platformFeeBps AT LAUNCH
 *       protocolFeeShareBps = PROTOCOL_FEE_SHARE_BPS    10000, all of it
 *       creatorTaxBps       = totalTaxBps - that share  the creator's choice
 *
 *   NOT PLATFORM_FEE_BPS, which this file's own constant is, and which is only
 *   the floor the tax band is checked against. launch() reads the share off the
 *   hook and freezes THAT into the curve, so a change announced on the hook
 *   reaches launches created after it and no others. An earlier version of
 *   these three lines said "50, always" and was wrong the day the share became
 *   settable.
 *
 * EVERYTHING PERMANENT IS DECIDED HERE, BEFORE THE FIRST BUY
 *   A launch's graduation terms - beneficiary, pool
 *   configuration, refund destination, and now its tax - are written to the
 *   registry in this same transaction and can never be changed afterwards. So
 *   they are also VALIDATED here, not at graduation: a configuration that
 *   cannot graduate must fail before anyone puts money into the curve, because
 *   afterwards there is no way to fix it and the money is already in.
 *
 *   Most of the terms this contract fixes go one step further and are checked
 *   in the CONSTRUCTOR, against the registry's own rules: an unsupported fee
 *   tier, an illegal tick spacing or an impossible lock cannot be deployed at
 *   all, so such a factory never reaches a first launch to be refused at.
 *   The HOOK is the exception and the constructor says why - the registry is
 *   wired after the factory exists, so there is nothing to compare against
 *   yet. That one is caught by the registry at the first launch, which is
 *   still before anybody's money is in a curve.
 *
 * THE CURVE'S FACTORY ROLE GOES TO THE GRADUATOR
 *   PonsV2BondingCurve gates both initialize() and graduate() on one immutable
 *   `factory` address. graduate() is the one that moves value, so that address
 *   has to be the graduator. This factory therefore initializes new curves
 *   THROUGH the graduator, which accepts the call only from the registry's
 *   launcher - this contract.
 *
 * WHAT PRIVILEGE IS LEFT
 *   None over EXISTING launches. There is no owner, no pause and no setter on
 *   this contract, and every record it writes is write-once. Nor can another
 *   launcher reach them: the registry refuses any record that names one of
 *   these curves for a token other than its own. What is not
 *   immutable is what a NEW launch takes from the hook: the platform's share,
 *   its recipient and so the launch fee's recipient, which the hook's owner may
 *   change behind a 24-hour announcement. Everything else a launch is built
 *   with is fixed here.
 */
contract CurbLaunchFactory {
    using SafeERC20 for IERC20;

    /// What a creator may choose. Everything else is fixed at construction.
    struct LaunchConfig {
        string name;
        string symbol;
        string tokenUri;
        /// The CREATE2 salt of the token. The token's address also depends on
        /// the curve's, and the curve is created with CREATE from this
        /// factory's nonce - so a salt mined off-chain for a side or a vanity
        /// address holds only if no other launch on this factory lands first.
        bytes32 salt;
        /// WHERE LEFTOVER **NVDAc** GOES - not launch tokens.
        ///
        /// Graduation seeds the pool with what the curve holds, and whichever
        /// side does not bind leaves a remainder. The two remainders are
        /// treated differently and the difference is the whole reason this
        /// field is named for one of them:
        ///   the QUOTE  is not ours to destroy, so it is RETURNED here
        ///   the TOKEN  is the launch's own, and is BURNED - RemainderBurned
        ///              says how much, and it is not dust: it is the
        ///              quarter-ish of supply the pool could not absorb
        /// With any phantom liquidity at all the quote is the binding side and
        /// this refund measures zero, but that is measured, not guaranteed.
        address quoteRefundTo;
        /// The ONE tax on every buy and sell, 100..500 bps. The platform's
        /// share comes out of it; the creator takes the rest.
        uint16 totalTaxBps;
        /// THE CREATOR'S OWN FIRST BUY, in quote units, made inside this same
        /// transaction. Zero means none, which is what every launch did before
        /// this field existed.
        ///
        /// WHY IT IS HERE RATHER THAN A SECOND TRANSACTION: between a launch
        /// and the creator's own first buy there is a block in which anybody
        /// can be the first buyer of a launch they did not make. Doing it here
        /// closes that window entirely rather than making it small.
        ///
        /// WHAT IT MAY BUY IS CAPPED IN TOKENS: at most MAX_DEV_BUY_BPS - a
        /// fifth - of the token supply, and a buy that would get more is
        /// refused with DevBuyAboveShare. The cap is on what the buy RECEIVES,
        /// so it is the same fifth on every asset, at every tax and on any
        /// curve shape; the quote that buys it differs per asset and per tax
        /// (the tax comes off the input first), and the site works it out.
        /// It must also be below the graduation threshold (DevBuyTooLarge),
        /// so a buy that could graduate the launch - and create the pool
        /// inside launch() - stays unreachable rather than merely unlikely.
        /// WHAT THE CAP DOES NOT DO is limit what the creator can hold: see
        /// _devBuy.
        ///
        /// The caller pays it and must have approved this factory for it. The
        /// tokens go to creatorWallet; anything the curve refunds goes back to
        /// the caller.
        uint256 devBuy;
        /// WHO THE LAUNCH PAYS, and who owns its locked position. Zero means
        /// the caller, which is what every launch did before this field
        /// existed.
        ///
        /// IT IS THREE THINGS AT ONCE:
        ///   the curve's creator-fee recipient,
        ///   the hook's creator for the graduated pool's fees, and
        ///   the beneficiary of the locked LP position.
        /// It stays the beneficiary for good. Its INCOME - the first two, and
        /// the locked position's LP fees - can be switched once, one way, to
        /// the launch's holder distributor (holderShareFactory below, or
        /// Graduator.enableHolderSharing later); nothing can switch it back or
        /// point it anywhere else. The position itself never leaves its
        /// lock, for anyone (claimFees() is open to anyone and pays a fixed
        /// recipient), so a wallet the creator does not control loses them
        /// any income not yet switched. There is no setter anywhere that can
        /// move it afterwards - see PRE_MAINNET C3.
        ///
        /// WHY IT IS WORTH THE RISK: launching from a hot wallet and being
        /// paid into a cold one is the ordinary case, and before this the two
        /// had to be the same address for ever.
        address creatorWallet;
        /// WHAT THE CALLER BELIEVED THE PLATFORM'S TERMS WERE.
        ///
        /// A policy change is announced and lands after a delay, so it can ripen
        /// between building a transaction and mining it. Without these a launch
        /// would quietly be created on terms nobody had read; with them it is
        /// refused and the caller looks again. Pass what currentPlatformPolicy()
        /// said when the split was shown.
        ///
        /// LAST, AND THAT IS NOT A STYLE CHOICE. The page encodes this struct BY
        /// POSITION; Solidity's named construction does not care, so putting
        /// these in the middle compiled everywhere and reverted every launch the
        /// page sent. Anything a positional reader consumes goes on the end.
        uint16 expectedPlatformBps;
        address expectedPlatformRecipient;
        /// SHARE THIS LAUNCH'S CREATOR INCOME WITH ITS HOLDERS FROM THE START.
        /// Zero means no. Otherwise the distributor factory version the caller
        /// read from the SharingCatalog: inside this transaction the Graduator
        /// deploys that version's distributor for the new token and switches
        /// the curve's creator leg to it, so even the dev buy's tax goes to the
        /// holders while the dev-buy tokens go to the creator. A version the
        /// catalog does not approve refuses the whole launch.
        ///
        /// LAST, for the positional reason above.
        address holderShareFactory;
    }

    /// THE CREATOR'S FIRST BUY, and the only place this contract ever holds a
    /// token.
    ///
    /// EVERY AMOUNT HERE IS A MEASURED DELTA. What the quote asset actually
    /// delivered, what the curve actually took, what came back as a refund -
    /// none of it is assumed from what was asked for. A fee-on-transfer quote
    /// asset, a curve that clamped the fill, and a stray transfer from a
    /// stranger all produce the same shape of bug if a balance is read
    /// instead: somebody else's money moving on this caller's behalf. AUDIT
    /// A-4 is that bug, found in the Graduator.
    function _devBuy(PonsV2BondingCurve curve, IERC20 quote, uint256 amount, address to) private {
        // ---- the rule that protects the transaction: never the threshold.
        //
        // A dev buy at or above the graduation threshold could graduate the
        // launch inside its own creation transaction, so it is refused before
        // anything moves. LIVE AGAIN: it stood behind a quote ceiling (three
        // quarters of the threshold) until the cap below moved to tokens, and
        // is now the only check made before the buy. AUDIT D-1.
        if (amount >= graduationThreshold) revert DevBuyTooLarge(amount, graduationThreshold);

        // WHAT THE CAP BELOW LIMITS: THE ATOMIC BUY MADE INSIDE launch(), AND
        // NOTHING ELSE. A fifth of the supply, of the 73% the shipped curves
        // sell, leaves 53% of the supply to be bought when launch() returns.
        //
        // WHAT IT DOES NOT DO, AND THIS COMMENT USED TO CLAIM. It called itself
        // the fairness ceiling and said it stopped a creator taking all but a
        // wei of the curve. It does not: launch() is open to any caller and
        // returns the curve already initialized, and the curve's buy() is open
        // to anyone from that moment. A creator's own contract can call
        // launch() and then curve.buy() for the rest IN THE SAME TRANSACTION,
        // before any public transaction can land - and that buy may even
        // graduate the launch. Nothing here caps what one address holds from
        // block one, or leaves the public a window. Limiting that would be a
        // product change (a per-address cap, or a curve that takes only the
        // dev buy for some blocks), not a comment; until one is made, nothing
        // may promise buyers "the rest of the curve".
        uint256 heldBefore = quote.balanceOf(address(this));
        quote.safeTransferFrom(msg.sender, address(this), amount);
        uint256 arrived = quote.balanceOf(address(this)) - heldBefore;
        if (arrived == 0) revert DevBuyNotSpent(amount, 0);

        quote.forceApprove(address(curve), arrived);
        // ---- THE CAP, ON WHAT THE BUY RECEIVED rather than on what it paid.
        //
        // A quote ceiling is a token share only through one curve shape and
        // one tax: the old three quarters of the threshold bought 66% of the
        // supply once the phantom shrank to about 0.37 of the threshold.
        // Counted in tokens it cannot drift with the terms. Checked AFTER the
        // buy, from the curve's own tokensOut - the curve was created by this
        // transaction from code this factory fixes, and it transfers exactly
        // that many of this deployment's plain ERC20 to `to` - and the revert
        // undoes the buy with everything else.
        uint256 got = curve.buy(arrived, 0, to);
        uint256 cap = (supply * MAX_DEV_BUY_BPS) / 10_000;
        if (got > cap) revert DevBuyAboveShare(got, cap, MAX_DEV_BUY_BPS);
        // APPROVAL CLEARED WHETHER OR NOT IT WAS USED. A clamped fill leaves
        // an allowance standing, and an allowance this contract does not need
        // is one it should not be carrying.
        quote.forceApprove(address(curve), 0);

        // WHAT CAME BACK IS THE CALLER'S - AND NOTHING CAN, TODAY.
        //
        // DEFENSIVE, NOT LIVE, and labelled so rather than left to read as
        // working code. The curve refunds only when it CLAMPS a fill, which
        // happens exactly when the buy would exhaust the sellable allocation -
        // and that is the graduation threshold, which devBuy is kept below,
        // and a fifth of the supply, which is well inside the 73% the curve
        // sells. Measured at the largest buy the token cap admits: charged in
        // full, nothing returned [test_devBuy_theLargestLegalOneRefundsNothing].
        //
        // KEPT ANYWAY. The cap and the clamp live in two different contracts,
        // and one comparison is the cheapest guard against them ever drifting
        // apart. AUDIT D-1 is the same shape and reached the same answer: a
        // check nobody can reach should be labelled, not deleted and not left
        // looking load-bearing.
        //
        // Measured against what was held before this call, so a balance that
        // was already here - however it got here - is not handed to whoever
        // launched next.
        uint256 heldAfter = quote.balanceOf(address(this));
        if (heldAfter > heldBefore) {
            quote.safeTransfer(msg.sender, heldAfter - heldBefore);
        }
    }

    /// The terms a deployment fixes. A struct because they are set together and
    /// checked together, and because naming them at the call site is the
    /// difference between a readable deployment and a row of bare numbers.
    struct Terms {
        uint256 supply;
        /// THE SCALE THE TWO FIGURES BELOW WERE SIZED IN, checked against what
        /// the asset itself reports. PONS's guard - setPairTokenEconomics takes
        /// the same declaration - and the only one that catches a threshold
        /// written for the wrong asset. 8400e6 is 8,400 cbXRP at six decimals
        /// and 84 of them at eight, and nothing else here can tell which was
        /// meant.
        uint8 quoteDecimals;
        uint256 phantomQuote;
        uint256 graduationThreshold;
        uint24 poolFee;
        int24 tickSpacing;
        IHooks hooks;
        address protocolFeeRecipient;
        /// Only reachable through the buyback path, which is off for every
        /// launch this factory creates. The curve still refuses anything
        /// outside (0, 10_000) in its constructor, so it is carried rather than
        /// hard-coded to nothing - and the constructor below refuses the same
        /// range, since every launch() would otherwise revert inside
        /// `new PonsV2BondingCurve`.
        uint16 maxInternalPriceImpactBps;
        /// WHAT CREATING A LAUNCH COSTS, in native ETH, on top of gas. Zero
        /// charges nothing, which is what DeployCurb sets for every factory:
        /// launching costs gas only.
        ///
        /// It is paid to the hook's CURRENT platform recipient rather than to
        /// an address frozen here, so it follows the same policy - and the
        /// same 24-hour announcement - as the trade fee. Two revenue addresses
        /// would be one more than anybody was told about.
        uint256 launchFee;
    }

    /// THE FLOOR THE TAX BAND IS CHECKED AGAINST, in the constructor - and
    /// nothing else. It is NOT the platform's cut: launch() reads that off the
    /// hook and freezes it into the record. It used to be captioned as the cut,
    /// "fixed at every tax setting", which was the same number and not the
    /// same thing.
    uint16 public constant PLATFORM_FEE_BPS = 50;
    /// All of the base fee goes to the protocol, so the creator is paid
    /// entirely through the tax leg and the platform's take never moves.
    uint16 public constant PROTOCOL_FEE_SHARE_BPS = 10_000;

    /// THE COARSEST QUOTE ASSET THIS PRODUCT WILL PRICE AGAINST.
    ///
    /// Taken from PONS, which refuses a pair token below six decimals, and for
    /// the reason it gives: the fee is integer basis points of the quote leg,
    /// so on a coarse asset every trade below 10_000/feeBps base units rounds
    /// its fee to ZERO, and a trader splits one order into fee-free pieces.
    /// Our curve does the same arithmetic, so it inherits the same floor.
    ///
    /// It is also the cheapest guard against the other half of the problem: a
    /// phantom reserve sized for one scale, applied to an asset of another,
    /// misprices the curve by orders of magnitude and nothing downstream would
    /// notice. Every B20 equity measured carries 8 [MULTI_RWA.txt 2.1], so this
    /// does not bite today - which is exactly when it is cheap to add.
    uint8 public constant MIN_QUOTE_DECIMALS = 6;

    LaunchRegistry public immutable registry;
    Graduator public immutable graduator;
    /// The graduator's PoolManager and PositionManager, copied once at
    /// construction for the creator check in launch(). Exact, not a snapshot
    /// that can go stale: both are immutable in the graduator, which is
    /// immutable here. Copied rather than asked at every launch because the
    /// two calls cost runtime bytes this contract is short of.
    address private immutable graduatorPoolManager;
    address private immutable graduatorPositionManager;
    address public immutable quoteToken;
    /// The scale the phantom reserve and the threshold were written in, as
    /// declared at construction and checked against the asset then and at
    /// every launch.
    uint8 public immutable declaredQuoteDecimals;

    IPonsV2FeePolicy public immutable feePolicy;
    IPonsV2FeeEscrow public immutable feeEscrow;
    PonsV2BuybackVault public immutable buybackVault;

    uint256 public immutable supply;
    uint256 public immutable phantomQuote;
    uint256 public immutable graduationThreshold;
    /// What creating a launch costs in native ETH. See Terms.launchFee.
    uint256 public immutable launchFee;

    /// @notice The most a creator's first buy may RECEIVE, in basis points of
    ///         the token supply: a fifth. (It was 7500 of the graduation
    ///         threshold, a quote ceiling, which bought 66% of the supply on
    ///         the shipped curves.)
    ///
    /// @dev A CONSTANT, NOT A TERM. Terms carries what differs per deployment;
    ///      this is a rule about what a launch is allowed to be, identical on
    ///      every asset. In Terms it would be a knob somebody could set to
    ///      10_000 in a deployment nobody read, which is the one value that
    ///      makes the rule pointless.
    uint16 public constant MAX_DEV_BUY_BPS = 2000;

    /// The gas the launch fee is sent with. See launch().
    uint256 private constant LAUNCH_FEE_CALL_GAS = 50_000;

    /// @notice Launch fees a recipient would not accept, held for them.
    ///
    /// @dev The only ether this contract ever holds, and only because the
    ///      alternative was refusing the launch. See the fee block in launch().
    mapping(address recipient => uint256 amount) public unclaimedLaunchFees;

    /// The fee call hands control to the platform recipient before anything is
    /// created. A trusted role is a reason to bound the blast radius, not to
    /// skip bounding it.
    bool private _launching;
    uint24 public immutable poolFee;
    int24 public immutable tickSpacing;
    IHooks public immutable hooks;
    /// The platform recipient AT DEPLOYMENT, kept for readers and checked
    /// non-zero. launch() does not use it: it stamps each launch with the
    /// hook's recipient, which currentPlatformPolicy() returns.
    address public immutable protocolFeeRecipient;
    uint16 public immutable maxInternalPriceImpactBps;

    /// Read from the registry at construction rather than restated, so the band
    /// this factory enforces and the band the record enforces cannot diverge.
    uint16 public immutable minTotalTaxBps;
    uint16 public immutable maxTotalTaxBps;

    /// A launch fee the recipient refused, held for them instead of refusing
    /// the launch.
    event LaunchFeeUnclaimed(address indexed to, uint256 amount);
    /// `recipient` is whose held balance it was; `to` is where the ether went -
    /// the same address from withdrawLaunchFees, the named one from
    /// withdrawLaunchFeesTo.
    event LaunchFeeWithdrawn(address indexed recipient, address indexed to, uint256 amount);

    event LaunchCreated(
        address indexed launchToken, address indexed curve, address indexed creator, uint256 supply, uint16 totalTaxBps
    );

    error ZeroAddress();
    error ZeroSupply();
    /// The quote asset is too coarse, or will not say how coarse it is.
    error QuoteDecimalsTooFew(address quoteToken, uint8 decimals, uint8 minimum);
    error QuoteDecimalsUnreadable(address quoteToken);
    error QuoteDecimalsMismatch(address quoteToken, uint8 declared, uint8 actual);
    error CreatorIsInfrastructure(address creator);
    error PlatformRecipientIsInfrastructure(address platformRecipient);
    /// NOT NAMED TaxOutOfRange, WHICH IS THE REGISTRY'S. Two errors with the
    /// same name and the same argument types share a selector, and a test
    /// asserting on one would be satisfied by the other - so deleting this
    /// check would leave the suite green while the registry quietly did the
    /// work one step later. That happened; a mutation run is what found it.
    error TaxOutOfBand(uint16 totalTaxBps, uint16 minimum, uint16 maximum);
    /// A launch whose whole tax is under the platform's current cut would leave
    /// the creator nothing and underflow the hook's own split. Separate from
    /// TaxOutOfBand because the band is the registry's and this is the LIVE
    /// rate, which the owner can move between one launch and the next.
    error TaxBelowPlatformFee(uint16 totalTaxBps, uint16 platformFeeBps);
    error PlatformPolicyMoved(uint16 expectedBps, uint16 actualBps, address expectedTo, address actualTo);

    /// @notice The platform terms a launch created RIGHT NOW would be frozen
    ///         with - the two values to pass as expectedPlatformBps and
    ///         expectedPlatformRecipient.
    /// @dev    Read from the same place launch() reads them, which is the point:
    ///         a caller that worked them out some other way could be asking
    ///         about a different hook than the one that will be used.
    function currentPlatformPolicy() external view returns (uint16 bps, address to) {
        address policyHook = registry.requiredHook();
        if (policyHook == address(0)) revert RegistryNotWired();
        bps = IPlatformPolicy(policyHook).platformFeeBps();
        to = IPlatformPolicy(policyHook).platformRecipient();
    }
    /// No hook has been fixed yet, so there is no fee policy to freeze into a
    /// curve. register() would refuse this launch anyway; saying so here keeps
    /// the reason a name instead of a revert with no data.
    error RegistryNotWired();
    /// EXACT, not "at least". Change left in this contract would be change it
    /// has no other reason to hold, and refunding it is another transfer that
    /// can fail.
    error LaunchFeeMismatch(uint256 sent, uint256 required);
    /// A first buy that would receive more than MAX_DEV_BUY_BPS of the token
    /// supply. Carries the tokens it would have received, the most it may,
    /// and the share, so the caller does not have to work out either.
    error DevBuyAboveShare(uint256 tokensOut, uint256 maxTokens, uint16 shareBps);
    /// withdrawLaunchFees or withdrawLaunchFeesTo could not deliver a held fee
    /// to `to`; the revert restores the balance. (launch() no longer refuses a fee the
    /// recipient will not take - it holds it in unclaimedLaunchFees.)
    error LaunchFeeNotTaken(address to, uint256 amount);
    /// Nothing is held for this address.
    error NoUnclaimedFees(address who);

    /// A launch was started from inside another launch.
    error LaunchReentered();
    /// A dev buy at or above the threshold could graduate the launch inside
    /// its own creation transaction. Refused rather than handled, before the
    /// quote moves.
    error DevBuyTooLarge(uint256 asked, uint256 mustBeBelow);
    /// The curve did not take what it was given, which should be impossible on
    /// a curve created in this transaction - so it is an error rather than a
    /// silent partial fill.
    error DevBuyNotSpent(uint256 offered, uint256 taken);
    error UnsupportedPoolFee(uint24 fee);
    error IllegalTickSpacing(int24 tickSpacing, int24 minimum, int24 maximum);
    error BandBelowPlatformFee(uint16 minimum, uint16 platformFee);
    /// The escrow credits one asset, and it is not this factory's.
    error EscrowIsForAnotherAsset(address escrow, address escrowAsset, address quoteToken);
    /// The escrow will not say which asset it credits, so it cannot be checked.
    error EscrowUnreadable(address escrow);
    /// The fee policy points at a different escrow from the one the curves pay.
    error PolicyNamesAnotherEscrow(address policyEscrow, address feeEscrow);
    /// The curve refuses this value in its constructor (InvalidFeePolicy), so
    /// every launch() would revert. Carries the curve's open bounds.
    error MaxPriceImpactOutOfRange(uint16 maxInternalPriceImpactBps, uint16 exclusiveMinimum, uint16 exclusiveMaximum);
    /// withdrawLaunchFeesTo was asked to send the fee nowhere.
    error ZeroDestination();
    /// withdrawLaunchFeesTo was asked to send ether to a contract that keeps
    /// it with no way back out: this factory, the quote asset, or WETH.
    error DestinationKeepsNoEther(address to);

    /// Base's wrapped ether, an OP-Stack predeploy at the same address on
    /// every Base network.
    address internal constant BASE_WETH = 0x4200000000000000000000000000000000000006;
    /// Uniswap's Permit2, at the same address on every chain it is deployed to.
    address internal constant BASE_PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    constructor(
        LaunchRegistry registry_,
        Graduator graduator_,
        address quoteToken_,
        IPonsV2FeePolicy feePolicy_,
        IPonsV2FeeEscrow feeEscrow_,
        PonsV2BuybackVault buybackVault_,
        Terms memory terms
    ) {
        if (
            address(registry_) == address(0) || address(graduator_) == address(0) || quoteToken_ == address(0)
                || address(feePolicy_) == address(0) || address(feeEscrow_) == address(0)
                || address(buybackVault_) == address(0) || terms.protocolFeeRecipient == address(0)
        ) revert ZeroAddress();
        if (terms.supply == 0) revert ZeroSupply();
        // THE CURVE'S OWN RANGE FOR THE BUYBACK IMPACT CAP, APPLIED HERE.
        // PonsV2BondingCurve's constructor reverts InvalidFeePolicy unless
        // 0 < maxInternalPriceImpactBps < 10_000, and every launch() copies
        // this term into a new curve. Unchecked, a factory with 0 or 10_000
        // deployed cleanly, passed wire() and addLauncher() - neither reads it -
        // and then reverted every launch it was ever asked for. DeployCurb's
        // equality with the fee policy is the only other guard, and it is off
        // chain.
        if (terms.maxInternalPriceImpactBps == 0 || terms.maxInternalPriceImpactBps >= 10_000) {
            revert MaxPriceImpactOutOfRange(terms.maxInternalPriceImpactBps, 0, 10_000);
        }

        // AND THE ASSET MUST SAY HOW COARSE IT IS. An asset that will not
        // answer decimals() cannot be checked against the floor, and this
        // factory's phantom reserve is denominated in that asset's units -
        // so silence here is not something to accept on trust.
        (bool ok, bytes memory raw) = quoteToken_.staticcall(abi.encodeCall(IDecimals.decimals, ()));
        if (!ok || raw.length != 32) revert QuoteDecimalsUnreadable(quoteToken_);
        uint8 quoteDecimals = abi.decode(raw, (uint8));
        if (quoteDecimals < MIN_QUOTE_DECIMALS) {
            revert QuoteDecimalsTooFew(quoteToken_, quoteDecimals, MIN_QUOTE_DECIMALS);
        }
        // AND IT MUST BE THE SCALE THE THRESHOLD WAS WRITTEN IN. Reading the
        // asset proves it is a token; comparing it against what the deployer
        // declared proves the number beside it was sized for THIS one. Without
        // the declaration there is nothing to compare: every figure here is
        // plausible at some scale.
        if (quoteDecimals != terms.quoteDecimals) {
            revert QuoteDecimalsMismatch(quoteToken_, terms.quoteDecimals, quoteDecimals);
        }

        // AND THE ESCROW MUST BE THIS ASSET'S. FeeEscrow credits exactly one
        // token and refuses every other with UnsupportedToken, and the curve
        // sweeps its fees into it before graduate() can hand anything over. A
        // factory built on another asset's escrow therefore takes buys, can
        // never sweep, and turns every full curve into one that cannot graduate
        // without a hand-made rescueCurveFees. PONS checks the same wiring at
        // every launch (_requireLaunchDependenciesWired: "a partially wired
        // stack could otherwise accept buys but later block fee sweeps or
        // graduation"). Ours is immutable, so checking it once, here, is every
        // launch. DeployCurb requires the same off chain; a factory deployed
        // any other way had nothing checking it.
        //
        // AN ESCROW THAT WILL NOT ANSWER IS REFUSED, not assumed to be right.
        {
            (bool okEsc, bytes memory rawEsc) =
                address(feeEscrow_).staticcall(abi.encodeWithSignature("quoteToken()"));
            if (!okEsc || rawEsc.length != 32) revert EscrowUnreadable(address(feeEscrow_));
            address escrowAsset = abi.decode(rawEsc, (address));
            if (escrowAsset != quoteToken_) {
                revert EscrowIsForAnotherAsset(address(feeEscrow_), escrowAsset, quoteToken_);
            }
        }
        // AND THE POLICY MUST NAME THAT SAME ESCROW. The curve reads only the
        // sweep operator from the policy today, so a mismatch breaks nothing
        // now. It is still a stack wired two ways, which is the thing PONS
        // refuses, and anything that ever asks the policy where fees go would
        // be told the wrong place.
        if (address(feePolicy_.feeEscrow()) != address(feeEscrow_)) {
            revert PolicyNamesAnotherEscrow(address(feePolicy_.feeEscrow()), address(feeEscrow_));
        }

        // THE SAME RULES THE REGISTRY APPLIES, APPLIED ONE STEP EARLIER.
        // These terms are now immutable, so a bad one is not a launch that gets
        // refused - it is a factory that can never produce a good launch. Catch
        // it where it can still be fixed by redeploying nothing but this.
        if (!registry_.isSupportedFee(terms.poolFee)) revert UnsupportedPoolFee(terms.poolFee);
        // BOTH ENDS. This checked only `<= 0`, which made the header's claim
        // that an illegal spacing "cannot be deployed at all" wider than the
        // code: the registry's ceiling is TickMath.MAX_TICK_SPACING, so 32768
        // deployed happily and then refused every launch it was ever asked for.
        // A factory that cannot produce a single launch is exactly what this
        // constructor exists to prevent.
        if (terms.tickSpacing < TickMath.MIN_TICK_SPACING || terms.tickSpacing > TickMath.MAX_TICK_SPACING) {
            revert IllegalTickSpacing(terms.tickSpacing, TickMath.MIN_TICK_SPACING, TickMath.MAX_TICK_SPACING);
        }
        // AND A LAUNCH HERE MUST BE ABLE TO GRADUATE. The graduator refuses an
        // unmintable seed already; asking it now, with the terms that are about
        // to become immutable, turns "this launch cannot be completed" from
        // something a full curve discovers into something a deployment does.
        // After the spacing check above, which this divides by.
        graduator_.assertTermsAreSeedable(
            terms.supply, terms.phantomQuote, terms.graduationThreshold, terms.tickSpacing
        );

        // THE HOOK IS THE ONE TERM THIS CONSTRUCTOR CANNOT CHECK, and pretending
        // otherwise would be worse than not checking. The registry is wired to
        // its launcher AFTER the factory exists - the factory needs the
        // registry's address to be constructed at all - so requiredHook() is
        // still the zero address while this runs, on every deployment that can
        // actually work. A comparison against it would pass unconditionally and
        // read like a guarantee.
        // The registry refuses a foreign hook in register(), which is the first
        // launch and still before anybody's money is in a curve. That is where
        // this one is caught.

        uint16 min_ = registry_.MIN_TOTAL_TAX_BPS();
        uint16 max_ = registry_.MAX_TOTAL_TAX_BPS();
        // A band whose floor is at or below the platform's own fee would leave
        // the creator nothing, or underflow computing their share.
        if (min_ <= PLATFORM_FEE_BPS) revert BandBelowPlatformFee(min_, PLATFORM_FEE_BPS);

        registry = registry_;
        graduator = graduator_;
        graduatorPoolManager = address(graduator_.poolManager());
        graduatorPositionManager = address(graduator_.positionManager());
        quoteToken = quoteToken_;
        declaredQuoteDecimals = terms.quoteDecimals;
        feePolicy = feePolicy_;
        feeEscrow = feeEscrow_;
        buybackVault = buybackVault_;

        supply = terms.supply;
        phantomQuote = terms.phantomQuote;
        graduationThreshold = terms.graduationThreshold;
        launchFee = terms.launchFee;
        poolFee = terms.poolFee;
        tickSpacing = terms.tickSpacing;
        hooks = terms.hooks;
        protocolFeeRecipient = terms.protocolFeeRecipient;
        maxInternalPriceImpactBps = terms.maxInternalPriceImpactBps;
        minTotalTaxBps = min_;
        maxTotalTaxBps = max_;
    }

    /// @notice Convenience passthrough to the graduator.
    ///
    /// Graduation is PERMISSIONLESS and the graduator is its real entry point -
    /// normally the curve calls it itself, in the same transaction as the buy
    /// that crosses the threshold. This exists so an operator has a named way
    /// to complete a launch whose automatic attempt failed, and it is open to
    /// anyone for the same reason: a launch stuck ready-but-ungraduated has both
    /// buying and selling closed, so nobody should need permission to unstick
    /// it. Every economic term still comes from the registry record.
    function graduate(address launchToken)
        external
        returns (PositionLock lock, uint256 tokenId, PoolKey memory key)
    {
        return graduator.graduate(launchToken);
    }

    /// @notice Creates the curve and the token, initializes the curve, and
    ///         fixes the graduation terms - all before anyone can buy.
    /// @dev Open to anyone. The creator is cfg.creatorWallet, or the caller
    ///      when that is zero: they receive the curve's creator fees and, at
    ///      graduation, the locked LP position.
    function launch(LaunchConfig calldata cfg)
        external
        payable
        returns (CurbLaunchToken token, PonsV2BondingCurve curve)
    {
        if (_launching) revert LaunchReentered();
        _launching = true;
        if (cfg.quoteRefundTo == address(0)) revert ZeroAddress();
        if (cfg.totalTaxBps < minTotalTaxBps || cfg.totalTaxBps > maxTotalTaxBps) {
            revert TaxOutOfBand(cfg.totalTaxBps, minTotalTaxBps, maxTotalTaxBps);
        }

        // ZERO MEANS THE CALLER. Written this way rather than requiring an
        // explicit address so that a caller who does not care - and every call
        // site that predates the field - gets the old behaviour exactly.
        address creator = cfg.creatorWallet == address(0) ? msg.sender : cfg.creatorWallet;
        // NOT A CONTRACT OF THIS DEPLOYMENT. The escrow refuses to credit
        // itself (RecipientIsTheEscrow), so an escrow creator makes every
        // sweep revert - and graduate() sweeps first, so the full curve could
        // never graduate: buy and sell closed, a pool that never opens, and
        // only a hand-made call to rescueCurveFees to get out. The others
        // cannot use what they would be paid either.
        //
        // AND NOT THE POOLMANAGER, by the hook's own rule. FeeHook refuses it
        // as a payee because a take to it is a transfer to itself - the tokens
        // stay in the manager and nobody is owed them - and the creator's leg
        // of every pool swap is paid through that same delivery. A PoolManager
        // creator would lose every pool fee, hold escrow credit it can never
        // claim and own a locked position it can never withdraw. Read from the
        // graduator, which mints into that manager, so it is the one the
        // launch will actually graduate into. (This comment used to say
        // nothing else about the address was checkable; the PoolManager was.)
        //
        // AND NOT THE POSITIONMANAGER. The lock hands the position, and the
        // fees it collects, to the creator: an NFT sent to the PositionManager
        // is owned by a contract that never moves it, and tokens taken to it
        // are anybody's through its SWEEP action. Nor the fee policy or the
        // buyback vault, which have no path to claim what the escrow credits.
        //
        // AND NOT THE QUOTE ASSET, PERMIT2 OR ANY REGISTERED LAUNCH TOKEN.
        // None of them can claim an escrow credit or move a locked position,
        // and all three are known on chain. See _isOwnContract.
        //
        // AND NOT ANOTHER LAUNCHER, ITS ESCROW, ITS FEE POLICY OR ITS BUYBACK
        // VAULT - see _refuseOtherLaunchers - nor this launch's own token or
        // curve, which do not exist yet and are refused once they do, below.
        //
        // WHAT IS STILL NOT CHECKED: every address outside this deployment that
        // cannot use what it is paid - another project's token contract, a
        // contract with no way to claim - and whether an ordinary address is
        // one the creator controls. Neither is knowable on chain. What this
        // refuses is every contract of THIS deployment the factory can reach.
        if (_isOwnContract(creator)) revert CreatorIsInfrastructure(creator);
        _refuseOtherLaunchers(creator);

        // AND THE ASSET STILL HAS THE SCALE THE THRESHOLD WAS WRITTEN IN. PONS
        // re-checks this at every launch, not just at approval, because "an
        // upgradeable quote asset can change it afterwards, and this curve
        // prices against the stored figure for its entire life"
        // (PonsV2LaunchFactory.sol:783-788). The constructor's check was the
        // half of that guard this file copied; this is the other half.
        {
            (bool okDec, bytes memory rawDec) = quoteToken.staticcall(abi.encodeCall(IDecimals.decimals, ()));
            if (!okDec || rawDec.length != 32) revert QuoteDecimalsUnreadable(quoteToken);
            uint8 nowDecimals = abi.decode(rawDec, (uint8));
            if (nowDecimals != declaredQuoteDecimals) {
                revert QuoteDecimalsMismatch(quoteToken, declaredQuoteDecimals, nowDecimals);
            }
        }

        // THE POLICY IS READ NOW AND FROZEN INTO THIS CURVE, which is how PONS
        // does it: their factory calls the hook's currentFeePolicy() at launch
        // and the curve keeps that snapshot for ever. A later change reaches
        // launches made AFTER it and never reaches this one.
        //
        // READ FROM THE HOOK, NOT FROM A COPY HERE, and written into this
        // launch's record below. The graduated pool charges the same two
        // numbers because configureLaunch copies them from that record - not
        // from the hook's current values - so the pre-graduation rate and the
        // post-graduation rate cannot drift, which is D2's promise.
        //
        // STILL NEVER FROM THE CALLER. This used to be a calldata argument and
        // a stranger could have named themselves the protocol's fee recipient;
        // that stays closed. What opened is that the OWNER may change it for
        // future launches, which is a different door.
        // READ FROM THE REGISTRY'S HOOK, NOT FROM THIS FACTORY'S OWN FIELD.
        //
        // They are the same address for any factory that can actually launch,
        // because register() refuses a record naming any other hook. But this
        // call happens BEFORE that check, and a factory built on a foreign hook
        // is a thing that can exist - its constructor has nothing to compare
        // against, since wire() happens afterwards. Reading from `hooks` here
        // called platformFeeBps() on whatever that was, and a contract without
        // the function reverted with NO DATA - turning the registry's clear
        // UnsupportedHook into a silent failure one step earlier. A test caught
        // exactly that.
        //
        // The registry's hook is also the RIGHT one on the merits: it is the
        // hook that will charge the graduated pool, so it is the one whose
        // policy the curve should be frozen against.
        address policyHook = registry.requiredHook();
        if (policyHook == address(0)) revert RegistryNotWired();
        IPlatformPolicy policy = IPlatformPolicy(policyHook);
        uint16 platformBps = policy.platformFeeBps();
        address platformTo = policy.platformRecipient();
        // AND THE PLATFORM RECIPIENT IS NOT ONE OF THIS DEPLOYMENT'S CONTRACTS -
        // the same brick as an escrow creator, reached through the other
        // address the curve credits.
        //
        // THE HOOK AND THE REGISTRY REFUSE ALL OF THESE FIRST. The hook, at
        // the announcement and again when it lands: the PoolManager, the
        // registry, the graduator, and every launcher admitted by then, with
        // its escrow. The registry, at admission: a launcher that is, or whose
        // escrow is, the recipient already in force. Between them no term
        // below can fire through today's contracts in either order. It stays
        // because it costs a comparison each, and because this factory does
        // not choose which hook or registry it is built on. (This comment used
        // to say the hook could not tell the escrows apart and that this check
        // covered them all. It knew only this factory's escrow, one of eleven.)
        //
        // THE SAME LIST AS THE CREATOR'S. This used to name five of the
        // contracts the creator check named, so the PoolManager, the
        // PositionManager, the fee policy and the buyback vault passed here.
        if (_isOwnContract(platformTo)) revert PlatformRecipientIsInfrastructure(platformTo);
        // AND THEY MUST BE WHAT THE CALLER BELIEVED. An announced change ripens
        // on a timestamp, so it can land between building this transaction and
        // mining it; without this the launch would be created on terms nobody
        // had read, and the record is permanent.
        if (cfg.expectedPlatformBps != platformBps || cfg.expectedPlatformRecipient != platformTo) {
            revert PlatformPolicyMoved(
                cfg.expectedPlatformBps, platformBps, cfg.expectedPlatformRecipient, platformTo
            );
        }

        // ---- the launch fee, before anything is created.
        //
        // FIRST, so a refused payment costs the caller one reverted call
        // rather than the gas of a whole deployment. Forwarded immediately; a
        // fee the recipient refuses is held here in unclaimedLaunchFees until
        // it is withdrawn, which is the one thing this contract can hold.
        if (msg.value != launchFee) revert LaunchFeeMismatch(msg.value, launchFee);
        if (launchFee != 0) {
            // GAS-CAPPED: a recipient that burns what it is given would
            // otherwise leave this launch 1/64 of its gas, and every launch on
            // every factory would need ~64x its gas. A Safe's receive takes a
            // few thousand; one that needs more is held like a refusal.
            (bool paid,) = platformTo.call{value: launchFee, gas: LAUNCH_FEE_CALL_GAS}("");
            // A REFUSAL COSTS THE PLATFORM A DELAY, NOT EVERYBODY A LAUNCH.
            //
            // This used to revert. The fee is the platform's own money and the
            // recipient is the platform's own address, so a recipient that
            // cannot take ether is the platform's problem - and making it stop
            // every creator from launching is a far larger failure than making
            // the platform collect later. AUDIT M-06. COLLECTING LATER MEANS
            // withdrawLaunchFeesTo, which lets the recipient send its balance
            // to an address that takes ether - the plain withdrawLaunchFees
            // pays the address that just refused, the same way.
            if (!paid) {
                unclaimedLaunchFees[platformTo] += launchFee;
                emit LaunchFeeUnclaimed(platformTo, launchFee);
            }
        }
        // UNREACHABLE BY CONSTRUCTION TODAY, AND KEPT ANYWAY - said plainly so
        // nobody reads it as load-bearing and nobody deletes it as dead.
        //
        // It was written when the hook's fee could be raised to
        // MIN_TOTAL_TAX_BPS itself, where the creator's leg goes to zero. The
        // cap is tighter now: FeeHook.maxPlatformFeeBps() is four fifths of
        // that floor, so totalTaxBps >= 100 > 80 >= platformBps always and this
        // cannot fire.
        //
        // KEPT because the two bounds live in DIFFERENT CONTRACTS - the band is
        // the factory's immutable copy of the registry's floor, the cap is the
        // hook's live computation from it - and a check that costs one
        // comparison is the cheapest possible guard against them ever drifting.
        // Deleting it would make the invariant depend on reasoning across two
        // contracts instead of on an assertion.
        if (cfg.totalTaxBps < platformBps) revert TaxBelowPlatformFee(cfg.totalTaxBps, platformBps);

        FeePolicySnapshot memory snapshot = FeePolicySnapshot({
            protocolFeeRecipient: platformTo,
            protocolFeeShareBps: PROTOCOL_FEE_SHARE_BPS,
            buybackBurnBps: 0,
            hookFeeBps: 0,
            maxInternalPriceImpactBps: maxInternalPriceImpactBps
        });

        // The graduator holds the curve's factory role, because that role gates
        // graduate() and graduate() is what moves value.
        curve = new PonsV2BondingCurve(
            quoteToken,
            creator,
            address(graduator),
            feePolicy,
            snapshot,
            feeEscrow,
            buybackVault,
            phantomQuote,
            platformBps,
            cfg.totalTaxBps - platformBps,
            false,
            graduationThreshold
        );

        token = new CurbLaunchToken{salt: cfg.salt}(cfg.name, cfg.symbol, cfg.tokenUri, address(curve), supply);

        // AND NOT THIS LAUNCH'S OWN TOKEN OR CURVE. Both addresses can be
        // predicted before the call - the curve from this factory's nonce, the
        // token from the salt - and neither contract can claim what the escrow
        // credits it or move a position locked for it. Checked here, the first
        // moment both exist and before anything is registered or bought.
        if (creator == address(curve) || creator == address(token)) {
            revert CreatorIsInfrastructure(creator);
        }

        graduator.initializeCurve(address(curve), address(token));

        // Validated inside register(): a configuration that could not graduate
        // must fail HERE, with no money in the curve, rather than at graduation
        // when it cannot be fixed and the money is already in.
        registry.register(
            address(token),
            LaunchRegistry.Launch({
                curve: address(curve),
                quoteToken: quoteToken,
                beneficiary: creator,
                refundTo: cfg.quoteRefundTo,
                reservedZero: 0,
                fee: poolFee,
                tickSpacing: tickSpacing,
                hooks: hooks,
                platformBps: platformBps,
                platformRecipient: platformTo,
                totalTaxBps: cfg.totalTaxBps,
                // Stamped by the registry with its own clock; whatever is
                // passed here is overwritten.
                launchedAt: 0
            })
        );

        // ---- the creator's own first buy, if they asked for one.
        //
        // AFTER register(), because until the record exists the launch is not
        // a launch and a buy that crossed the threshold would have nothing to
        // graduate into. Before the event, so what it reports is finished.
        //
        // AND AFTER THE SWITCH, IF THE CREATOR ASKED FOR ONE: the dev buy's
        // tax is then already the holders'. Only this factory, which just
        // initialized the curve, can throw it here - see
        // Graduator.enableHolderSharingAtLaunch.
        if (cfg.holderShareFactory != address(0)) {
            graduator.enableHolderSharingAtLaunch(address(token), cfg.holderShareFactory);
        }
        if (cfg.devBuy != 0) {
            _devBuy(curve, IERC20(quoteToken), cfg.devBuy, creator);
        }

        emit LaunchCreated(address(token), address(curve), creator, supply, cfg.totalTaxBps);
        _launching = false;
    }

    /// EVERY CONTRACT OF THIS DEPLOYMENT THE FACTORY CAN NAME, plus the three
    /// outside addresses that can never use what a launch pays them: the quote
    /// asset, Permit2 and a registered launch token. ONE LIST, used for the
    /// creator and for the platform recipient alike. It used to be two `||`
    /// chains of different lengths, and via-IR compiled each of them in full.
    function _isOwnContract(address a) private view returns (bool) {
        return a == address(feeEscrow) || a == address(graduator) || a == address(hooks)
            || a == address(registry) || a == address(this) || a == graduatorPoolManager
            || a == graduatorPositionManager || a == address(feePolicy) || a == address(buybackVault)
            || a == quoteToken || a == BASE_PERMIT2 || registry.isRegistered(a);
    }

    /// Whether `target` answers the no-argument call `sel` with exactly the
    /// word `want`.
    ///
    /// BOUNDED, BOTH WAYS. 20,000 gas for the call, and at most one word of the
    /// reply copied - so a launcher that burns its gas or answers with a
    /// megabyte costs every launch a fixed amount, not whatever it chooses.
    /// The high-level staticcall this replaces forwarded all but 1/64 of the
    /// gas and copied the whole reply into memory.
    ///
    /// COMPARED AS A WHOLE WORD, not decoded as an address: decoding reverts on
    /// a word with its upper bits set, which is the unreadable case again, and
    /// a dirty word over the right address must not count as a match.
    function _answers(address target, bytes4 sel, uint256 want) private view returns (bool hit) {
        assembly ("memory-safe") {
            mstore(0, sel)
            let ok := staticcall(20000, target, 0, 4, 0, 32)
            hit := and(and(ok, eq(returndatasize(), 32)), eq(mload(0), want))
        }
    }

    /// NO LAUNCH FOR ANOTHER LAUNCHER, ITS ESCROW, ITS FEE POLICY OR ITS
    /// BUYBACK VAULT - the hook's own list for the platform payee
    /// (FeeHook._refuseDeploymentContract), applied to the creator and widened
    /// to the policy and the vault. Another asset's factory cannot claim what
    /// this factory's escrow credits it, and another asset's escrow, policy and
    /// vault have no path to claim from this one: any of them as creator loses
    /// every fee and the position for good. This factory's own contracts are
    /// refused above by name; they are in this list too once admitted, and
    /// asking twice costs nothing.
    ///
    /// AN UNREADABLE LAUNCHER IS SKIPPED, NOT REFUSED. The registry refuses one
    /// that will not name its escrow at admission, so this cannot happen through
    /// its own door - but if it did, refusing here would stop every launch on
    /// every factory for good, since nothing leaves that list, to protect only
    /// the one creator who named that address. A launcher with no policy or
    /// vault to name is the same unreadable case and is skipped the same way.
    function _refuseOtherLaunchers(address creator) private view {
        uint256 n = registry.launcherCount();
        for (uint256 i = 0; i < n; i++) {
            address other = registry.launcherAt(i);
            if (creator == other) {
                revert CreatorIsInfrastructure(creator);
            }
            uint256 want = uint256(uint160(creator));
            if (
                _answers(other, ILauncherFeeEscrow.feeEscrow.selector, want)
                    || _answers(other, ILauncherFeeEscrow.feePolicy.selector, want)
                    || _answers(other, ILauncherFeeEscrow.buybackVault.selector, want)
            ) revert CreatorIsInfrastructure(creator);
        }
    }

    /// @notice Takes a launch fee this contract could not deliver to you.
    ///
    /// @dev TO THE CALLER. A recipient that refused ether at launch time will
    ///      usually refuse it here too - that is withdrawLaunchFeesTo's case.
    function withdrawLaunchFees() external returns (uint256 amount) {
        return _withdrawLaunchFees(msg.sender);
    }

    /// @notice Takes a launch fee this contract could not deliver to you, and
    ///         sends it to `to`.
    ///
    /// @dev WHY IT EXISTS. The fees held here are exactly the ones the
    ///      recipient REFUSED, and withdrawLaunchFees pays the same address the
    ///      same way - so for a recipient with no payable receive (a splitter,
    ///      a contract that only moves tokens) the pull failed as surely as the
    ///      push, and every launch until a rotation added to a balance nobody
    ///      could ever take out. The "delay" launch() promises was a permanent
    ///      loss. Now the recipient names where the ether goes.
    ///
    ///      THE BALANCE IS STILL THE CALLER'S AND ONLY THE CALLER'S: it is keyed
    ///      by msg.sender, so naming a destination moves nobody else's money.
    ///      FeeHook.claim solves the same refusal by re-wrapping into WETH; this
    ///      factory has no WETH to wrap into on most assets, so it takes a
    ///      destination instead.
    ///
    ///      WHAT IT STILL CANNOT DO: help a recipient that can neither take
    ///      ether nor make a call. Nothing on chain can act for it; rotating the
    ///      hook's recipient stops the balance growing, and what it already
    ///      holds stays held for it.
    ///
    ///      AND NOT TO A CONTRACT THAT KEEPS THE ETHER. This factory would
    ///      credit nobody with it, WETH would mint it to this factory, which has
    ///      no way to move a token, and the quote asset has no way to hand ether
    ///      back. So all three are refused by name.
    function withdrawLaunchFeesTo(address to) external returns (uint256 amount) {
        if (to == address(0)) revert ZeroDestination();
        if (to == address(this) || to == quoteToken || to == BASE_WETH) revert DestinationKeepsNoEther(to);
        return _withdrawLaunchFees(to);
    }

    /// Written down before the transfer so a recipient that calls back finds
    /// nothing left. This is the only path by which ether leaves this contract,
    /// and the only reason it ever holds any.
    function _withdrawLaunchFees(address to) private returns (uint256 amount) {
        amount = unclaimedLaunchFees[msg.sender];
        if (amount == 0) revert NoUnclaimedFees(msg.sender);
        unclaimedLaunchFees[msg.sender] = 0;
        (bool sent,) = to.call{value: amount}("");
        if (!sent) revert LaunchFeeNotTaken(to, amount);
        emit LaunchFeeWithdrawn(msg.sender, to, amount);
    }
}
