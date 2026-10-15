// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";

import {PonsV2BondingCurve} from "../src/vendor/PonsV2BondingCurve.sol";
import {PonsV2BuybackVault} from "../src/vendor/PonsV2BuybackVault.sol";
import {FeePolicySnapshot, IPonsV2FeeEscrow, IPonsV2FeePolicy} from "../src/vendor/interfaces/ILaunchpadV2.sol";

import {LaunchRegistry} from "../src/curb/LaunchRegistry.sol";
import {SharingCatalog} from "../src/curb/SharingCatalog.sol";
import {ISharingCatalog} from "../src/curb/sharing/ICurbSharing.sol";
import {Graduator, IPermit2Minimal} from "../src/curb/Graduator.sol";
import {CurbLaunchFactory} from "../src/curb/CurbLaunchFactory.sol";
import {CurbLaunchToken} from "../src/curb/CurbLaunchToken.sol";
import {LaunchLens} from "../src/curb/LaunchLens.sol";
import {FeeHook} from "../src/curb/FeeHook.sol";
import {FeeEscrow} from "../src/curb/FeeEscrow.sol";
import {FeePolicy} from "../src/curb/FeePolicy.sol";
import {IPositionManagerMinimal} from "../src/curb/PositionLock.sol";
import {HolderDistributorFactory} from "../src/curb/sharing/HolderDistributorFactory.sol";
import {HolderFeeDistributor} from "../src/curb/sharing/HolderFeeDistributor.sol";

/// The two contracts this script asks about a market. Deliberately minimal:
/// the quoter is asked one question and the factory one.
interface IV3Factory {
    function getPool(address a, address b, uint24 fee) external view returns (address);
}

interface IQuoterV2 {
    /// @dev NOT a view: it simulates the swap and reverts with the result,
    ///      which the caller catches. A script may call it; a contract may not
    ///      treat it as free.
    function quoteExactOutput(bytes memory path, uint256 amountOut)
        external
        returns (uint256 amountIn, uint160[] memory, uint32[] memory, uint256);
}

/// The one thing the first launch asks of WETH beyond ERC-20: wrapping the
/// deployer's ether for $CURB's dev buy.
interface IWETH9 {
    function deposit() external payable;
}


/**
 * @title DeployCurb
 * @notice Deploys the whole stack: the shared contracts (registry, sharing
 *         catalog, graduator, hook, holder distributor factory, lens) and one
 *         factory, escrow, policy and buyback vault per quote asset. A demo
 *         launch is created ONLY when CURB_DEMO_LAUNCH is set, which a real
 *         run never does.
 *
 * THE ORDER: registry; SharingCatalog (owner = the policy owner,
 * bootstrapper = the deployer); Graduator with the catalog; the hook, mined
 * against the Graduator; the HolderDistributorFactory with its publisher,
 * keeper payee and vetoers; catalog.admitInitial(that factory), by the
 * deployer, inside the catalog's one-day bootstrap window; the lens with the
 * Graduator; then one stack per quote asset, EVERY ONE BUILT BEFORE ANY IS
 * ADMITTED; $CURB's dev buy wrapped and approved; the WETH factory wire()d,
 * the first admission of the run, and $CURB launched straight after it, when
 * CURB_FIRST_LAUNCH=1 (FirstLaunch below); then every other factory
 * addLauncher()ed (admissionOrder); the registry handed to the policy owner,
 * when that is not the deployer (requireRegistryHandover). Then every link
 * between them is read back.
 *
 * THE SHARED CONTRACTS COME FIRST NOW, admitInitial among them. It used to run
 * after every stack, some fifty transactions in, so a broadcast that died
 * part way put the catalog's one-day clock on the recovery; it is the sixth
 * transaction now. And no factory is admitted until $CURB's own is: launch()
 * is open to anyone from a factory's admission, so a launch on any factory
 * admitted before $CURB's would take launch 0. The WETH factory used to be
 * wired first with fifty-five transactions behind it, and then admitted last
 * with every other factory open for those same transactions.
 *
 * THE HOLDER SHARING ROLES COME FROM THE ENVIRONMENT, and a real run names
 * all three (sharingRoles below):
 *   CURB_SHARING_PUBLISHER     the key that proposes holder payouts
 *   CURB_SHARING_KEEPER_PAYEE  where the keeper's gas fee (at most 2%) goes
 *   CURB_SHARING_VETOERS       comma-separated vetoers besides the policy
 *                              owner, which is always one; none may be the
 *                              publisher
 * A demo run may leave them unset: the publisher and the keeper payee are then
 * the deployer, and the policy owner is the only vetoer.
 *
 * THE CONTRACTS CORE V2 LEAVES UNCHANGED ARE CHECKED BEFORE ANYTHING IS SENT.
 * The bonding curve, the fee escrow, the launch token, the fee policy and the
 * buyback vault must build to the code identities pinned below (IDENTITY_*),
 * or the run stops (requireUnchangedCode). script/b20/size-gate.sh checks the
 * same constants against the build, with the size budgets.
 *
 * NOTHING HERE COMES OUT OF test/ ANY MORE. The fee escrow and the fee policy
 * were mocks - the escrow took tokens it could never pay back - and both are
 * real contracts now.
 *
 * THIS IS THE SCRIPT THE MAINNET RUNBOOK SIGNS. script/b20/preflight-mainnet.sh
 * simulates it against Base (chain 8453) and prints the one command to
 * broadcast it, with --verify. What is still missing is outside this file: no
 * address book exists until that broadcast is made (PRE_MAINNET A1), and the
 * platform recipient is the one value it refuses to run without. This header
 * used to call it a fork-only script that always created a demo launch; both
 * stopped being true.
 *
 * A REHEARSAL ON A FORK:
 *   RPC_PORT=<a free port, not 8546> bash script/b20/start-node.sh
 * BROADCAST IT ONTO A NODE OF ITS OWN, NEVER THE SUITE'S. (The line above
 * used to start the suite's own node on its default port, one line before
 * this said not to use it.)
 * This mines transactions. A rehearsal broadcast onto the pinned node the
 * fork tests use moves that node off its block, and every fork suite then
 * fails at once in a way that looks like the code - it is not the code, it
 * is the node. Start a separate one, or stop and restart the pinned one
 * afterwards.
 *
 *   ACCOUNT=<an unlocked anvil account>
 *   NODE=http://127.0.0.1:<that port>
 *   FOUNDRY_BROADCAST=broadcast/local \
 *   CURB_PLATFORM_RECIPIENT=$ACCOUNT CURB_ALLOW_EOA_RECIPIENT=true \
 *   CURB_ALLOW_EOA_POLICY_OWNER=true CURB_ALLOW_SAME_RECIPIENT_AND_OWNER=true \
 *   CURB_DEMO_LAUNCH=true \
 *     base-forge script script/DeployCurb.s.sol --rpc-url $NODE \
 *       --broadcast --unlocked --sender $ACCOUNT
 *
 * $CURB, ON A REHEARSAL TOO: add CURB_FIRST_LAUNCH=1 and the CURB_FIRST_*
 * variables (FirstLaunch says each), and it is launch 0, before the demo. A
 * creator that is one key - any anvil account - needs
 * CURB_ALLOW_EOA_CREATOR=true besides.
 * script/b20/check-deployment.sh --rehearse does all of this on a scratch
 * fork and reads the result back.
 *
 * EVERY VARIABLE ABOVE IS NEEDED. The command used to be written with none,
 * and it reverted at once: the platform recipient is required, and an anvil
 * account is one key, which is refused unless said - as recipient and as
 * policy owner (which defaults to the sender). The runner scripts in
 * script/b20/ pass the same set.
 *
 * FOUNDRY_BROADCAST KEEPS THE REHEARSAL OUT OF THE MAINNET RECORD'S DIRECTORY.
 * A fork of Base serves chain 8453, so without it forge writes
 * broadcast/DeployCurb.s.sol/8453/run-latest.json - the directory the mainnet
 * run records into, which the preflight therefore refuses to find occupied.
 * If a rehearsal did land there, move that directory aside before the
 * preflight. CURB_DEMO_LAUNCH is for the fork only (see run()).
 * WRITTEN AS A PREFIX ABOVE, NOT EXPORTED: left exported in the shell that
 * signs, it would file the mainnet record under broadcast/local/ too, which
 * is why the mainnet command's --recheck refuses any FOUNDRY_* variable
 * (script/b20/preflight-mainnet.sh).
 *
 * IT MOVES ONLY HALF OF WHAT forge KEEPS. The endpoint of every transaction
 * goes to cache/DeployCurb.s.sol/<chain>/run-latest.json whatever
 * FOUNDRY_BROADCAST says, so a rehearsal on a node serving 8453 rewrites the
 * cache half a mainnet --resume reads. Moving it too (FOUNDRY_CACHE_PATH)
 * moves forge's compiler cache with it, and every rehearsal would rebuild
 * the project from nothing; instead the resume's recheck refuses a cache
 * half that is not the mainnet record's (records_resumable), and DEPLOY.txt,
 * A PARTIAL DEPLOYMENT, keeps a private copy of it.
 *
 * THE HOOK'S SALT IS MINED FOR THE CREATE2 DEPLOYER PROXY, not for this
 * script's address. Under --broadcast, `new X{salt:}` goes through
 * 0x4e59b44847b379578588920cA78FbF26c0B4956C, and mining against the wrong
 * deployer produces an address the hook can never occupy - a mistake this
 * project has already made once, in a test.
 */
contract DeployCurb is Script {
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    IPoolManager internal constant POOL_MANAGER = IPoolManager(0x498581fF718922c3f8e6A244956aF099B2652b2b);
    address internal constant POSM = 0x7C5f5A4bBd8fD63184577525326123B519429bDc;
    IPermit2Minimal internal constant PERMIT2 = IPermit2Minimal(0x000000000022D473030F116dDEE9F6B43aC78BA3);

    address internal constant NVDAC = 0xb20000000000000000000078ee7ce2fE4908108C;
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant V3_FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    address internal constant QUOTER_V2 = 0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a;

    /// HOW MANY THRESHOLDS THE MARKET MUST BE ABLE TO SUPPLY for an asset that
    /// this file CLAIMS is fillable. One, because one is the bar the list has
    /// always been sorted by - "Fillable today: the deepest pool covers a
    /// threshold". A constant so that raising it is a decision somebody makes
    /// rather than a number that drifts in a diff.
    uint256 internal constant DEPTH_BAR_THRESHOLDS = 1;
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    /// Holds ~5,797 NVDAc at the pinned block. Used only to fund the demo buyer.
    address internal constant NVDAC_WHALE = 0x853F5f1B92b16714Fe6CDA67CAad0856B83C7ab9;

    // The threshold and the phantom are PER ASSET now - see quoteAssets(). The
    // two constants that used to hold them are gone rather than left behind:
    // a constant nothing reads is a second place to take for the live value.
    uint256 internal constant SUPPLY = 1_000_000_000e18;

    /*//////////////////////////////////////////////////////////////
                  THE CODE CORE V2 LEAVES UNCHANGED, PINNED
    //////////////////////////////////////////////////////////////*/

    /// THE CODE IDENTITY of each contract core v2 does not change: keccak256 of
    /// its runtime code as built, with the immutables as the compiler leaves
    /// them in the artifact (zero) and the metadata trailer cut off. The trailer
    /// is a hash of source paths and comments, which move with the checkout
    /// without moving a byte of code; the immutables are what each deployment
    /// fills in. What is left is the code, and these are its values in master's
    /// build (b7156632), the build these five were reviewed in.
    ///
    /// A deliberate change to one of them changes its constant here in the same
    /// commit; script/b20/size-gate.sh --identity prints the new value.
    bytes32 internal constant IDENTITY_BONDING_CURVE =
        0x20a4b0db2f5a483d6bc56a729c6bcc9606eec0ede523922a9d8a0b5f487ba753;
    bytes32 internal constant IDENTITY_FEE_ESCROW =
        0xbdea563259fb8a3bacd90780441f1ae18942886c0eee5ea904cee45ce16b3240;
    bytes32 internal constant IDENTITY_LAUNCH_TOKEN =
        0x941252cd890353b704e6992d76a6bb83dcd4c0688a6ebd7d03361e5a28c48e82;
    bytes32 internal constant IDENTITY_FEE_POLICY =
        0xcaf726aec0c005f8279119ef10430e629286d52bcccb27fdaaabaeeee5bb5690;
    bytes32 internal constant IDENTITY_BUYBACK_VAULT =
        0xaf0c18f83cf78b1c082b2a9d552a709e7267795c2c8868e968b75ce3bd806750;

    /*//////////////////////////////////////////////////////////////
                        THE QUOTE ASSETS, AND WHY THESE
    //////////////////////////////////////////////////////////////*/

    /// One entry per quote asset this deployment stands up. Each gets its own
    /// escrow, policy, buyback vault and factory, because the asset and the
    /// numbers that go with it are IMMUTABLE on a factory. The registry, the
    /// graduator, the hook and the lens are shared, so discovery stays one
    /// place.
    struct Asset {
        address quote;
        string label;
        /// THE CURVE'S VIRTUAL QUOTE RESERVE, and with it the opening price:
        /// a launch starts at a market cap of exactly this, because the whole
        /// supply sits on the curve against it. Its own field since the
        /// 2026-10-03 shape (about $4K to $55K); it was the threshold before.
        uint256 phantomQuote;
        /// WHAT THE CURVE MUST TAKE IN TO GRADUATE. With the phantom it fixes
        /// everything else: T/(V+T) of the supply is sold, the graduation
        /// market cap is (V+T)^2/V, T*V/(V+T)^2 of the supply opens the pool
        /// and the rest of the reserve, (V/(V+T))^2, is burned.
        uint256 threshold;
        /// WHETHER THIS FILE CLAIMS THE MARKET CAN SUPPLY A THRESHOLD.
        ///
        /// Not a number - a claim, and one the deployment checks against the
        /// chain it is deploying to. The file has always sorted the list into
        /// these two groups by hand; this is the same sorting, said in a way
        /// that can be wrong out loud.
        ///
        /// A `false` here is not a warning. Listing a thin asset is a
        /// deliberate choice - the page says so at the moment of choosing, and
        /// holders can sell back to the curve the whole time a launch waits.
        bool fillable;
        /// THE SCALE `phantomQuote` AND `threshold` ARE WRITTEN IN. The factory refuses to deploy
        /// unless the asset itself reports this, which is the only check that
        /// can catch a figure sized for a different token: 8400e6 is 8,400
        /// cbXRP at six decimals and 84 of them at eight, and both are
        /// plausible numbers to see in this list.
        uint8 decimals;
    }

    /// THE ENABLED LIST AND THE THRESHOLDS - FOURTEEN ASSETS, CHOSEN AND PRICED
    /// 2026-10-15 (PRE_MAINNET decision 1a). The list was first decided on
    /// 2026-09-20 (F1) as seven equities, grew to eleven with WETH and three
    /// Coinbase-wrapped coins, and to fourteen with USDC, VIRTUAL and AERO.
    ///
    /// TWO FORCES PULL AGAINST EACH OTHER AND BOTH ARE MEASURED.
    ///   A BIGGER THRESHOLD MAKES THE GRADUATED POOL CHEAPER TO TRADE. D1
    ///   measured 10/20/60 NVDAc: at a $100 buy, Q=60 costs 2.13% all-in and
    ///   Q=20 costs 3.61%; at $500 it is 5.14% against 11.72%. That is why 60
    ///   was chosen, and it is why shrinking the threshold is not free - and
    ///   the 2026-10-03 shape below does shrink it, to about $10.8K, and puts
    ///   less of the supply in the pool, so a graduated pool is thinner than
    ///   D1's. That was the owner's trade for a $4K start.
    ///   A BIGGER THRESHOLD IS HARDER TO FILL. The curve has to TAKE IN that
    ///   many units, so the asset has to be obtainable in that size, and
    ///   MULTI_RWA.txt 2.2 measured how little of most of these exists.
    ///
    /// THE RULE, taken from PONS because theirs is the better-stated one
    /// [PonsV2LaunchFactory.sol:182-187]: size the pair from ONE TARGET VALUE
    /// at each asset's own rate. Only phantom and threshold TOGETHER decide
    /// the shape, so scaling both by one rate leaves it untouched and every
    /// launch starts, raises and graduates at the same dollar figures.
    ///
    /// THE SHAPE, DECIDED 2026-10-03: START AT ABOUT $4K, GRADUATE AT ABOUT
    /// $55K. With V the phantom and T the threshold in the same unit and the
    /// supply S = 1e9 sitting on the curve against V:
    ///   start market cap        V
    ///   share sold on the curve T/(V+T)
    ///   graduation market cap   (V+T)^2/V        (on the full 1e9)
    ///   tokens into the pool    S*T*V/(V+T)^2
    ///   tokens burned           S*(V/(V+T))^2    the rest of the reserve
    /// V = $4,000 and (V+T)^2/V = $55,000 give V+T = $14,832 and T = $10,832.
    /// So r = V/(V+T) is about 0.27: about 73% of the supply sells on the
    /// curve, about 19.7% opens the pool, about 7.3% is burned, and the price
    /// runs about 13.75 times from the first buyer to the last. This replaces
    /// D1's r = 0.5 (phantom == threshold == $13,231: start ~$13K, graduation
    /// ~$53K, half sold, a quarter pooled, a quarter burned).
    ///
    /// THE PRICES ARE CHAINLINK'S, READ ON LIVE BASE ON 2026-10-15 (block
    /// 52,646,580, 16:41 UTC, US market open), each asset's feed the one the
    /// site and the keeper price it by and each feed's description() read back
    /// as theirs, and every one CROSS-CHECKED against its deepest pool's own
    /// slot0 price (script/b20/measure-thresholds.js, the same hour): the
    /// widest gap was SPCXc's, 0.93%, against DEPLOY.txt PREP 1's 3%. Both
    /// figures are rounded to three significant figures, which keeps every
    /// start within 0.5% of $4,000 and every graduation within 0.5% of $55,000
    /// at those prices - the per-asset figures are beside each entry. They are
    /// a day's prices: the preflight's section 6 prices them again at
    /// Chainlink when it runs, and stops past 5%.
    ///
    /// THE BAR, and it is the same one B20MultiAsset's E1 test uses: THE
    /// LARGEST MEASURED POOL MUST HOLD AT LEAST ONE THRESHOLD. A pool that
    /// cannot supply one threshold cannot fill a launch, and picking any
    /// tighter fraction would be choosing a number nobody measured. Measured on
    /// live Base on 2026-10-15 (measure-thresholds.js; Uniswap v3 pools against
    /// WETH and USDC):
    ///
    ///   asset    threshold  largest pool holds   (pool)       thresholds  claim
    ///   WETH          4.47          35,865.25    USDC/0.3%         8,024  fillable
    ///   USDC        10,800      58,833,186.30    WETH/0.3%         5,448  fillable
    ///   cbBTC        0.132              50.39    WETH/0.3%           382  fillable
    ///   VIRTUAL     16,100         799,714.72    USDC/0.3%          49.7  fillable
    ///   AERO        12,200         552,191.37    WETH/0.3%          45.3  fillable
    ///   cbZEC         9.20              68.67    WETH/1%            7.46  fillable
    ///   cbXRP        8,150          38,735.89    USDC/1%            4.75  fillable
    ///   GOOGLc        31.1              73.51    USDC/1%            2.36  fillable
    ///   AMZNc         42.9              41.80    USDC/1%            0.97  thin
    ///   NVDAc         50.0              32.56    WETH/0.3%          0.65  thin
    ///   SPCXc         74.5              39.66    USDC/1%            0.53  thin
    ///   AAPLc         31.5              11.68    USDC/0.3%          0.37  thin
    ///   MSFTc         20.1               4.80    USDC/1%            0.24  thin
    ///   METAc         14.7               1.99    USDC/0.3%          0.14  thin
    ///
    /// NVDAc LOST ITS FLAG ON 2026-10-15. Its WETH/0.3% pool held 284 NVDAc
    /// when the list was first sorted and holds 32.56 now, two thirds of one
    /// threshold. It was the asset the depth check was written against; the
    /// check is why the flag had to move rather than stay a stale claim.
    ///
    /// THE SIX THIN ONES ARE LISTED ANYWAY, AND THAT IS THE OWNER'S DECISION
    /// (2026-10-15: "liquidity comes and goes"), as it was for the equities
    /// held on 2026-09-22. A launch against them may sit unfilled until their
    /// liquidity arrives. Hiding them would not make that untrue, it would
    /// only mean a creator could not see the choice - and a curve holds no one
    /// hostage while it waits, because sell() stays open until graduation. The
    /// mechanism takes any asset and the lifecycle passes for every one of the
    /// fourteen on the fork [B20MultiAsset.t.sol, B20NewQuoteAssets.t.sol].
    ///
    /// THE WARNING IS IN THE PAGE, AND IT IS LIVE. The quote picker reads the
    /// asset's own pool at render time and says when it cannot cover a
    /// threshold, which a constant in this file could never do: the day an
    /// equity's liquidity arrives the warning goes away by itself, and nobody
    /// has to remember to edit a list.
    ///
    /// LEFT OUT, ONE LINE EACH TO ADD LATER: TSLAc, COINc, MSTRc, CRCLc and
    /// INTCc. Each has a Chainlink feed on Base and no Uniswap pool at all on
    /// 2026-10-15, so no ETH route reaches them; once one has a market it is
    /// added after launch with script/DeployAssetStack.s.sol and the Safe's
    /// addLauncher (DEPLOY.txt, ADDING A QUOTE ASSET AFTER LAUNCH).
    ///
    /// THE PRICES BEFORE THESE were D1's of 2026-09-20 for the equities and the
    /// coins' of 2026-09-22/23 (WETH at $2,746.87), carried through the
    /// 2026-10-03 shape change unre-taken; a quick re-derivation on 2026-09-22
    /// had disagreed with D1's table at the same block and nobody resolved it.
    /// Chainlink and the pools agreeing within 1% is what resolved it here.
    /// The factory quoting a named asset. Reverts rather than falling back to
    /// a position, because a demo pointed at the wrong asset fails in ways
    /// that look like the product is broken.
    function _factoryFor(Asset[] memory assets, address[] memory factories, string memory label)
        internal
        pure
        returns (address)
    {
        for (uint256 i = 0; i < assets.length; i++) {
            if (keccak256(bytes(assets[i].label)) == keccak256(bytes(label))) return factories[i];
        }
        revert(string.concat("no factory quotes ", label));
    }

    /// WHAT ONE THRESHOLD OF THIS ASSET WOULD COST TO BUY, IN WETH, or zero if
    /// no route can supply it.
    ///
    /// @dev THE SAME QUESTION THE PAGE ASKS, THE SAME WAY - quoteLiquidityNote
    ///      in web/app.js puts exactly this to the same quoter. Two answers to
    ///      one question by two methods is two chances to be wrong.
    ///
    ///      EXACT OUTPUT, SO THE PATH RUNS BACKWARDS: from the asset being
    ///      bought to the WETH being spent. Direct tiers first, then through
    ///      USDC, which is the same shape as the route builder on the page.
    ///
    ///      A QUOTER CALL IS NOT A VIEW. It simulates the swap and reverts with
    ///      the answer; a script may do this, and `try` is how the refusal - a
    ///      market that cannot supply the size - arrives as a value.
    function costToBuyOneThreshold(address asset, uint256 threshold) internal returns (uint256) {
        // A QUOTER THAT IS NOT THERE IS NOT A MARKET THAT CANNOT SUPPLY. On
        // another chain, or against a node missing the contract, every call
        // below would revert and this would report a fact about liquidity it
        // never learned. Checked once, here, rather than inferred from silence.
        require(QUOTER_V2.code.length > 0, "no v3 quoter at the expected address on this chain");
        uint24[4] memory tiers = [uint24(100), uint24(500), uint24(3000), uint24(10_000)];
        uint256 want = threshold * DEPTH_BAR_THRESHOLDS;

        for (uint256 i = 0; i < tiers.length; i++) {
            if (IV3Factory(V3_FACTORY).getPool(WETH, asset, tiers[i]) == address(0)) continue;
            try IQuoterV2(QUOTER_V2).quoteExactOutput(abi.encodePacked(asset, tiers[i], WETH), want)
            returns (uint256 amountIn, uint160[] memory, uint32[] memory, uint256) {
                if (amountIn != 0) return amountIn;
            } catch { /* this tier cannot, another may */ }
        }
        for (uint256 a = 0; a < tiers.length; a++) {
            if (IV3Factory(V3_FACTORY).getPool(USDC, asset, tiers[a]) == address(0)) continue;
            for (uint256 b = 0; b < tiers.length; b++) {
                if (IV3Factory(V3_FACTORY).getPool(WETH, USDC, tiers[b]) == address(0)) continue;
                try IQuoterV2(QUOTER_V2).quoteExactOutput(
                    abi.encodePacked(asset, tiers[a], USDC, tiers[b], WETH), want
                ) returns (uint256 amountIn, uint160[] memory, uint32[] memory, uint256) {
                    if (amountIn != 0) return amountIn;
                } catch { /* likewise */ }
            }
        }
        return 0;
    }

    /// THE FILE'S CLAIM ABOUT THIS ASSET, PUT TO THE CHAIN IT IS DEPLOYING TO.
    ///
    /// @dev The list has always been sorted into "fillable today" and "listed,
    ///      and short of liquidity" by hand, against measurements taken on the
    ///      day. SPCXc moved between the two on 2026-09-22 and its note says
    ///      what that proved: "It passed the bar when the table was written and
    ///      does not now, which is the whole argument for measuring at
    ///      deployment rather than trusting a number in a file."
    ///
    ///      SKIPPED ON A DEMO, REFUSES ON A DEPLOYMENT. CURB_DEMO_LAUNCH already
    ///      means "not a real chain" here, and a pinned fork is a different
    ///      market from the one a deployment meets - at the pin, cbZEC cannot
    ///      supply a threshold and SPCXc can, which is the reverse of live.
    ///
    ///      A FALSE CLAIM IS NOT CHECKED. Listing a thin asset is a deliberate
    ///      choice and the page says so when somebody chooses it; what this
    ///      refuses to let pass is the file saying an asset is fillable when
    ///      the market disagrees.
    function requireDepthMatchesClaim(Asset memory asset, bool demo) internal {
        if (asset.quote == WETH) return;         // nothing to buy WETH with but WETH
        // A CLAIM IS CHECKED; A LIST IS NOT SURVEYED. An asset this file does
        // not call fillable is making no claim to test, and pricing it anyway
        // costs a quoter simulation per tier per hop against a forked node -
        // which on the assets that cannot be priced means exhausting every
        // combination to learn what the list already said.
        if (!asset.fillable) return;
        // A DEMO IS NOT THE CHAIN THIS IS ABOUT, so it does not pay for the
        // answer. Every quoter call is a simulation and on a cold fork each
        // one fetches state upstream; with this running, the browser fixture's
        // two deployments took the setup from two minutes to over ten. And the
        // answer would be about the wrong market anyway - at the pin, cbZEC
        // cannot supply a threshold and SPCXc can, which is the reverse of
        // live. The check is exercised directly by tests instead.
        if (demo) {
            console.log("   depth check skipped (demo: this is not the chain being deployed to)");
            return;
        }
        uint256 cost = costToBuyOneThreshold(asset.quote, asset.threshold);
        if (cost != 0) {
            console.log("   one threshold costs (wei of WETH)", cost, asset.label);
        } else {
            console.log("   NO ROUTE can price one threshold of", asset.label);
            console.log("   (the quoter answered; this is the market, not the endpoint)");
        }
        if (cost != 0) return;
        revert(
            string.concat(
                asset.label,
                ": this file calls it fillable and no route can price one threshold on this chain"
            )
        );
    }

    function quoteAssets() internal pure returns (Asset[] memory list) {
        list = new Asset[](14);
        // EVERY FIGURE BELOW WAS PRICED ON 2026-10-15 at Chainlink's answer on
        // live Base (block 52,646,580), and every depth is the largest Uniswap
        // v3 pool's holding that day - the table above quoteAssets() says how.
        // The dollars beside each pair are what it gives at that day's price.
        //
        // ---- COINS. ETH is the primary pair, decided 2026-09-22.
        //
        // WETH, NOT NATIVE ETH. The curve supports a native quote -
        // isNativeQuote() is pairToken == address(0) - but this factory refuses
        // address(0) in its constructor and reads decimals() off the quote, so
        // a native launch cannot be made through it. The Graduator, the hook
        // and the pool key were written and tested against an ERC-20 quote
        // too. WETH is a line; native ETH is a project.
        //
        // WETH at $2,426.06: 1.65 phantom / 4.47 threshold, $4,003 to $55,071.
        // Its deepest pool holds 35,865 WETH, about 8,000 thresholds deep, so
        // this is the one asset where filling is not a question. $CURB launches
        // on it, so its dev buy is priced off this phantom.
        list[0] = Asset(WETH, "WETH", 1.65e18, 4.47e18, true, 18);
        // USDC, ADDED 2026-10-15, at $0.9999 (USDC / USD): 4,000 / 10,800,
        // $3,999 to $54,753. SIX DECIMALS. Circle's FiatToken proxy - the same
        // contract family as cbBTC and cbXRP, with a blacklist its blacklister
        // keeps, which the router asks of the caller, the recipient and itself
        // (CurbRouter._notBlacklisted). Its WETH/0.3% pool holds 58.8 million,
        // about 5,400 thresholds deep, and the ETH route to it is that one hop.
        list[1] = Asset(USDC, "USDC", 4000e6, 10800e6, true, 6);
        // COINBASE-WRAPPED COINS, added 2026-09-23. Addresses read back off
        // the chain - symbol(), decimals(), codesize - rather than copied from
        // the survey file.
        //
        // cbBTC at $82,134.62: 0.0487 / 0.132, $4,000 to $55,070. Its deepest
        // pool (WETH/0.3%) holds 50.39, about 380 thresholds deep.
        list[2] = Asset(0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf, "cbBTC", 0.0487e8, 0.132e8, true, 8);
        // cbXRP at $1.3298, and SIX DECIMALS, not eight. 3,010 / 8,150, $4,003
        // to $55,024.
        //
        // THE THINNEST OF THE FILLABLE COINS. Its deepest pool (USDC/1%)
        // holds 38,736, under five thresholds; it held 9,177 on 2026-09-23.
        // It clears the bar today and could stop at any time; the page
        // measures depth when a creator chooses, so it will say so rather
        // than this file pretending to know.
        list[3] = Asset(0xcb585250f852C6c6bf90434AB21A00f02833a4af, "cbXRP", 3010e6, 8150e6, true, 6);
        // cbZEC at $1,177.59 (ZEC / USD): 3.40 / 9.20, $4,004 to $54,987,
        // against 68.67 held (WETH/1%), seven and a half thresholds. Note the
        // address - it is in the 0xb2 family with the equities, not the 0xcb
        // family with the other wrapped coins.
        list[4] = Asset(0xB2000000000000000000008501b13360000cb2EC, "cbZEC", 3.4e8, 9.2e8, true, 8);
        // VIRTUAL AND AERO, ADDED 2026-10-15: plain eighteen-decimal ERC-20s -
        // no issuer policy, no blacklist (the router's isBlacklisted question
        // reverts on both, and a token without the function keeps no list).
        //
        // VIRTUAL at $0.67395: 5,940 / 16,100, $4,003 to $55,115. Its deepest
        // pool (USDC/0.3%) holds 799,715, about fifty thresholds; its WETH/0.05%
        // pool holds 542,987 besides, so the ETH route is one hop.
        list[5] = Asset(0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b, "VIRTUAL", 5940e18, 16100e18, true, 18);
        // AERO at $0.88598: 4,510 / 12,200, $3,996 to $54,853. Its deepest
        // pool (WETH/0.3%) holds 552,191, about forty-five thresholds, and the
        // ETH route is that one hop.
        list[6] = Asset(0x940181a94A35A4569E4529A3CDfB74e38FD98631, "AERO", 4510e18, 12200e18, true, 18);
        // ---- STOCKS. Fillable today: the deepest pool covers a threshold.
        // GOOGLc at $348.67: 11.5 / 31.1, $4,010 to $55,022, against 73.51
        // held (USDC/1%), 2.4 thresholds.
        list[7] = Asset(0xb2000000000000000000002D0BA3164cc74f58B7, "GOOGLc", 11.5e8, 31.1e8, true, 8);
        // Listed, and short of liquidity. The page says so at the moment of
        // choosing, read from the chain rather than from this list.
        //
        // NVDAc MOVED HERE ON 2026-10-15, as SPCXc did on 2026-09-22. Its
        // WETH/0.3% pool held 284 NVDAc when the list was first sorted and 154
        // at the pinned fork block; live it holds 32.56 against today's 50.0.
        // It passed the bar when the table was written and does not now, which
        // is the whole argument for measuring at deployment rather than
        // trusting a number in a file. NVDAc stays the demo's asset and the
        // fork suites' own (_factoryFor resolves it by name), thin or not.
        //
        // NVDAc at $216.53: 18.5 / 50.0, $4,006 to $54,919 (32.56 held, 0.65
        // of a threshold). SPCXc at $145.39: 27.5 / 74.5, $3,998 to $55,006
        // (39.66 held, 0.53). AMZNc at $252.55: 15.8 / 42.9, $3,990 to $55,075
        // (41.80 held, 0.97 - one good day from the bar). MSFTc at $539.06:
        // 7.42 / 20.1, $4,000 to $55,021 (4.80 held, 0.24). AAPLc at $343.43:
        // 11.6 / 31.5, $3,984 to $54,996 (11.68 held, 0.37). METAc at $735.93:
        // 5.44 / 14.7, $4,003 to $54,872 (1.99 held, 0.14).
        list[8] = Asset(NVDAC, "NVDAc", 18.5e8, 50e8, false, 8);
        list[9] = Asset(0xb2000000000000000000007b9fcbd005511aCBd5, "SPCXc", 27.5e8, 74.5e8, false, 8);
        list[10] = Asset(0xb200000000000000000000d9192b6B456483C2E8, "AMZNc", 15.8e8, 42.9e8, false, 8);
        list[11] = Asset(0xB200000000000000000000Ab99cFa739E253872B, "MSFTc", 7.42e8, 20.1e8, false, 8);
        list[12] = Asset(0xb200000000000000000000C2e324d24d7eEcd1fb, "AAPLc", 11.6e8, 31.5e8, false, 8);
        list[13] = Asset(0xb2000000000000000000008bC8786B856E61707C, "METAc", 5.44e8, 14.7e8, false, 8);
    }

    // THE POOL TIER IS A DECISION NOW, NOT THE DEMO'S LEFTOVER.
    //
    // 0.05%, chosen 2026-09-16 after measuring both candidates at the same
    // sizes - DEPTH.txt 3.4 and 3.7. It is worth 15 to 24 bps to a trader
    // across the scenario cells, most of it at the small sizes where the total
    // is smallest, and it comes out of the creator's income rather than from
    // nowhere: our LP is the locked position and its fees are the creator's.
    // The tick spacing is the one Uniswap pairs with this tier.
    uint24 internal constant POOL_FEE = 500;
    int24 internal constant TICK_SPACING = 10;
    /// The demo launch's own choice, inside the 100..500 band. The platform's
    /// share in force comes out of this - 50 bps at deployment, read off the
    /// hook - and the creator takes the rest: 250 while the share is 50.
    uint16 internal constant DEMO_TOTAL_TAX_BPS = 300;
    /// Only ever read through the buyback path, which is off for every launch
    /// this factory creates - but the curve refuses a zero, so it is a real
    /// value rather than a placeholder, and the policy publishes the same one.
    uint16 internal constant MAX_INTERNAL_PRICE_IMPACT_BPS = 500;

    /// A ROLE'S ADDRESS FROM THE ENVIRONMENT, READ AS THE TEXT IT WAS WRITTEN
    /// IN, AND REFUSED WHEN THAT TEXT CARRIES AN EIP-55 CHECKSUM THAT IS WRONG.
    ///
    /// vm.envAddress takes any forty hex digits and drops their case. So a
    /// checksummed address with one digit mistyped - the shape a typo takes
    /// in an address copied by hand - read as another valid address, one
    /// nobody holds, and every check after it classified THAT address: one
    /// key, balance 0, exactly like an unused real one. Mixed case is a
    /// checksum, and is held to it here (checksumHolds). An address written
    /// all in one case carries no checksum and is taken as written; DEPLOY.txt
    /// asks for every role address checksummed, as Basescan and the Safe app
    /// show it.
    function envAddressChecked(string memory name) internal view returns (address a) {
        string memory raw = vm.envString(name);
        a = vm.parseAddress(raw);
        requireChecksum(name, raw, a);
    }

    /// The same for a variable that may be unset, which reads as `otherwise`
    /// (and so does one set to nothing).
    function envAddressOr(string memory name, address otherwise) internal view returns (address) {
        if (!vm.envExists(name) || bytes(vm.envString(name)).length == 0) return otherwise;
        return envAddressChecked(name);
    }

    /// A comma-separated list of addresses, each held to its checksum; unset
    /// (or empty) is no address at all.
    function envAddressesOr(string memory name) internal view returns (address[] memory list) {
        if (!vm.envExists(name) || bytes(vm.envString(name)).length == 0) return new address[](0);
        string[] memory raw = vm.envString(name, ",");
        list = new address[](raw.length);
        for (uint256 i = 0; i < raw.length; i++) {
            list[i] = vm.parseAddress(raw[i]);
            requireChecksum(name, raw[i], list[i]);
        }
    }

    /// The refusal, naming the variable. It does not print the checksummed
    /// form of what was written: that is the mistyped address, correctly
    /// checksummed, and copying it from here would make the typo pass.
    function requireChecksum(string memory name, string memory raw, address a) internal pure {
        require(
            checksumHolds(raw, a),
            string.concat(
                name,
                " is written in mixed case and that is not its EIP-55 checksum: one mistyped character reads like this. Copy the address again from where it is kept; never correct it by hand."
            )
        );
    }

    /// Whether `raw`, the text `a` was parsed from, is either in one case -
    /// no checksum to hold - or exactly a's EIP-55 form (vm.toString writes
    /// an address checksummed).
    function checksumHolds(string memory raw, address a) internal pure returns (bool) {
        bytes memory r = bytes(raw);
        bool lower;
        bool upper;
        for (uint256 i = 2; i < r.length; i++) {
            if (r[i] >= "a" && r[i] <= "f") lower = true;
            else if (r[i] >= "A" && r[i] <= "F") upper = true;
        }
        if (!(lower && upper)) return true;
        return keccak256(r) == keccak256(bytes(vm.toString(a)));
    }

    /// WHO THE PLATFORM'S FEES GO TO. REQUIRED, never inferred.
    ///
    /// This used to be the deployer, silently. That is a convenient default and
    /// a dangerous one: the address becomes the hook's starting recipient and
    /// every launch created while it is in force freezes it into its own
    /// record, so a deployment that guessed it wrong leaves those launches
    /// paying the wrong address forever. The hook's own copy can be moved
    /// later, behind the 24-hour announcement, for launches after the move -
    /// this comment used to call it an immutable, which it has not been since
    /// the announce/execute policy.
    ///
    /// So it has to be said out loud. On the local fork the runner scripts set
    /// it to anvil's account 0 explicitly, which is test configuration written
    /// where a reader can see it rather than a default hiding in this file.
    ///
    ///   CURB_PLATFORM_RECIPIENT=0x... base-forge script script/DeployCurb.s.sol ...
    function platformRecipient() internal view returns (address who) {
        who = envAddressChecked("CURB_PLATFORM_RECIPIENT");
        require(who != address(0), "CURB_PLATFORM_RECIPIENT must not be the zero address");
        checkRecipientKind(
            who, vm.envOr("CURB_ALLOW_EOA_RECIPIENT", false), vm.envOr("CURB_ALLOW_NON_SAFE_RECIPIENT", false)
        );
    }

    /// The classification, apart from the environment so a test can drive it
    /// without racing other tests over process-wide variables.
    ///
    /// AND WHAT KIND OF ADDRESS IS IT. A6 asked for this check by name: the
    /// script "cannot know whether the address it was given is the right kind
    /// of address", and a hex string taken on trust becomes the hook's
    /// recipient and a frozen field in every launch made before anyone notices.
    /// A typo is not a failed run; for those launches it is a permanent mistake.
    function checkRecipientKind(address who, bool allowEoa, bool allowNonSafe) internal view {
        _checkKind(
            who,
            "platform recipient",
            "CURB_PLATFORM_RECIPIENT",
            "A6",
            "CURB_ALLOW_EOA_RECIPIENT",
            "CURB_ALLOW_NON_SAFE_RECIPIENT",
            allowEoa,
            allowNonSafe
        );
    }

    /// THE POLICY OWNER GETS THE SAME QUESTIONS AS THE RECIPIENT, and one more.
    ///
    /// It used to be checked only for zero and for being the recipient, while
    /// the recipient went through the classification below. That left the
    /// worse mistake unguarded: the hook is Ownable2Step(policyOwner), so only
    /// this address can ever announce a new share or recipient, or hand the
    /// role on. A typo, or a Safe that exists on another chain but was never
    /// deployed on Base, is a code-less address nobody controls - and it
    /// passed silently, freezing the platform's policy for good. The recipient
    /// could not reach that state without an opt-in; the owner reached it with
    /// none. DEPLOY.txt decision 3 says MAKE IT A SAFE; this is where that is
    /// asked rather than hoped for.
    ///
    /// Apart from the environment for the same reason as checkRecipientKind:
    /// a test drives it with plain arguments.
    function checkPolicyOwner(
        address owner_,
        address platform,
        bool allowSameAsRecipient,
        bool allowEoa,
        bool allowNonSafe
    ) internal view {
        require(owner_ != address(0), "CURB_POLICY_OWNER must not be the zero address");
        // THE KEY THAT HOLDS REVENUE IS NOT THE KEY THAT DECIDES WHERE IT GOES,
        // unless that is said out loud. The preflight asked this; the script
        // did not, so a run straight from the runbook skipped it.
        require(
            owner_ != platform || allowSameAsRecipient,
            "CURB_POLICY_OWNER is the platform recipient. Set CURB_ALLOW_SAME_RECIPIENT_AND_OWNER=true if intended."
        );
        _checkKind(
            owner_,
            "policy owner",
            "CURB_POLICY_OWNER",
            "DEPLOY.txt decision 3",
            "CURB_ALLOW_EOA_POLICY_OWNER",
            "CURB_ALLOW_NON_SAFE_POLICY_OWNER",
            allowEoa,
            allowNonSafe
        );
    }

    /// ONE CLASSIFICATION FOR BOTH ROLES, so the two cannot drift apart. Every
    /// line it prints NAMES THE ADDRESS ON THE SAME LINE: the preflight shows
    /// the operator these lines, and the address used to sit on a line of its
    /// own that the preflight's filter dropped - the one thing the runbook asks
    /// the operator to compare.
    function _checkKind(
        address who,
        string memory role,
        string memory envName,
        string memory asker,
        string memory eoaFlag,
        string memory nonSafeFlag,
        bool allowEoa,
        bool allowNonSafe
    ) internal view {
        uint256 size;
        assembly { size := extcodesize(who) }
        // AN EIP-7702 DELEGATION IS STILL ONE KEY. Since Pectra an EOA can carry
        // 23 bytes of code - 0xef0100 followed by the delegate - and it is still
        // whoever holds that key. It used to pass here as "a contract".
        if (size == 23) {
            bytes memory c = new bytes(3);
            assembly { extcodecopy(who, add(c, 32), 0, 3) }
            if (c[0] == 0xef && c[1] == 0x01 && c[2] == 0x00) size = 0;
        }

        if (size == 0) {
            // ONE KEY: no code lives here, or only a 7702 delegation designator
            // (0xef0100 || delegate), which is still one key. Whoever holds it
            // holds the whole role, and losing it loses the role. An address
            // with no code is also indistinguishable from a CONTRACT THAT HAS
            // NOT BEEN DEPLOYED YET, which is a different mistake with the same
            // shape.
            //
            // Refused by default, and the override has to be written out, so
            // that accepting it is a deliberate act and not a default nobody
            // read. The local runners set it because anvil's account 0 is what
            // they mean.
            if (!allowEoa) {
                revert(
                    string.concat(
                        envName,
                        " is one key (no code, or only an EIP-7702 delegation). ",
                        asker,
                        " asks for a Safe. If that is really intended, set ",
                        eoaFlag,
                        "=true."
                    )
                );
            }
            // SAID THE SAME WAY AS THE REFUSAL. This line read "has NO CODE"
            // after the 7702 branch was added, so a delegated EOA - 23 bytes of
            // code, which the preflight's own read reports - was described two
            // contradicting ways on one screen.
            console.log(
                string.concat(
                    "WARNING: the ", role, " is one key (no code, or only an EIP-7702 delegation), not a multisig:"
                ),
                who
            );
            return;
        }

        // IT HAS CODE. Say what it answers rather than assuming it is a Safe:
        // a contract that cannot be asked for its owners is not one, and a
        // deployer staring at the output is the last check before this becomes
        // permanent.
        (bool okT, bytes memory thr) = who.staticcall(abi.encodeWithSignature("getThreshold()"));
        (bool okO, bytes memory own) = who.staticcall(abi.encodeWithSignature("getOwners()"));
        if (okT && thr.length == 32 && okO && own.length >= 64) {
            address[] memory owners = abi.decode(own, (address[]));
            console.log(string.concat(role, " is a Safe-shaped contract:"), who);
            console.log("   threshold", abi.decode(thr, (uint256)), "of", owners.length);
            for (uint256 i = 0; i < owners.length; i++) console.log("   owner", owners[i]);
        } else {
            // NOT SAFE-SHAPED: a pasted token, a Safe singleton, anything. It
            // used to be a WARNING that nothing enforced. Refused unless said.
            if (!allowNonSafe) {
                revert(
                    string.concat(
                        envName,
                        " has code but does not answer getOwners/getThreshold. If that contract is really intended, set ",
                        nonSafeFlag,
                        "=true."
                    )
                );
            }
            console.log(
                string.concat("WARNING: the ", role, " has code but does not answer getOwners/getThreshold:"), who
            );
        }
    }

    /// keccak256 of runtime code with its metadata trailer cut off: the last two
    /// bytes give the trailer's length, and the trailer and those two bytes go.
    /// A length that runs past the code is refused rather than read as zero.
    function codeIdentity(bytes memory runtime) internal pure returns (bytes32 id) {
        uint256 n = runtime.length;
        require(n >= 2, "no runtime code to identify");
        uint256 trailer = (uint256(uint8(runtime[n - 2])) << 8) | uint256(uint8(runtime[n - 1]));
        require(trailer + 2 <= n, "the metadata length runs past the code");
        uint256 len = n - trailer - 2;
        assembly { id := keccak256(add(runtime, 32), len) }
    }

    /// One unchanged contract's build against its pinned identity.
    function requireIdentity(string memory artifact, bytes32 want) internal view {
        bytes32 got = codeIdentity(vm.getDeployedCode(artifact));
        if (got != want) {
            revert(
                string.concat(
                    artifact,
                    " builds to code identity ",
                    vm.toString(got),
                    ", not the pinned ",
                    vm.toString(want),
                    ": its code changed. Core v2 leaves it unchanged; if the change is meant, update its IDENTITY_ constant."
                )
            );
        }
    }

    /// THE FIVE CONTRACTS CORE V2 LEAVES BYTE-IDENTICAL, each artifact beside
    /// its pinned identity. Virtual only so a test can hand run() a wrong pin
    /// and see it refused; nothing here overrides it.
    function pinnedCode() internal view virtual returns (string[5] memory artifacts, bytes32[5] memory ids) {
        artifacts[0] = "PonsV2BondingCurve.sol:PonsV2BondingCurve";
        ids[0] = IDENTITY_BONDING_CURVE;
        artifacts[1] = "FeeEscrow.sol:FeeEscrow";
        ids[1] = IDENTITY_FEE_ESCROW;
        artifacts[2] = "CurbLaunchToken.sol:CurbLaunchToken";
        ids[2] = IDENTITY_LAUNCH_TOKEN;
        artifacts[3] = "FeePolicy.sol:FeePolicy";
        ids[3] = IDENTITY_FEE_POLICY;
        artifacts[4] = "PonsV2BuybackVault.sol:PonsV2BuybackVault";
        ids[4] = IDENTITY_BUYBACK_VAULT;
    }

    /// The five, as this build would deploy them, against their pins. Asked
    /// before the broadcast, so a build that differs from the reviewed one
    /// deploys nothing at all - even when the preflight's size gate was never
    /// run.
    function requireUnchangedCode() internal view {
        (string[5] memory artifacts, bytes32[5] memory ids) = pinnedCode();
        for (uint256 i = 0; i < 5; i++) {
            requireIdentity(artifacts[i], ids[i]);
        }
        console.log("code identities match the pinned ones: curve, escrow, launch token, fee policy, buyback vault");
    }

    /// THE HOLDER DISTRIBUTOR FACTORY'S ROLES. vetoers is everything the factory
    /// is built with: the separate vetoers first, the policy owner last.
    struct SharingRoles {
        address publisher;
        address keeperPayee;
        address[] vetoers;
    }

    /// The shared contracts run() deploys, kept in one memory record.
    struct Shared {
        LaunchRegistry registry;
        SharingCatalog catalog;
        Graduator graduator;
        FeeHook hook;
        bytes32 hookSalt;
        HolderDistributorFactory distributorFactory;
        LaunchLens lens;
    }

    /// The sharing lines of the output. None starts with a name the runner
    /// scripts take the first line of (LaunchLens, Graduator, LaunchRegistry,
    /// CurbLaunchFactory, FeeHook).
    function _logSharing(Shared memory s, SharingRoles memory roles) internal view {
        console.log("SharingCatalog  ", address(s.catalog));
        console.log("HolderDistributorFactory", address(s.distributorFactory));
        console.log("HolderFeeDistributor implementation", s.distributorFactory.implementation());
        console.log("sharing publisher", roles.publisher);
        console.log("sharing keeper payee", roles.keeperPayee);
        for (uint256 i = 0; i < roles.vetoers.length; i++) {
            console.log("sharing vetoer  ", roles.vetoers[i]);
        }
    }

    /// The roles from the environment. A demo run fills an unset publisher and
    /// keeper payee with the deployer and needs no separate vetoer; a real run
    /// names all three (checkSharingRoles says what it refuses).
    function sharingRoles(bool demo, address deployer, address policyOwner)
        internal
        view
        returns (SharingRoles memory)
    {
        return checkSharingRoles(
            envAddressOr("CURB_SHARING_PUBLISHER", address(0)),
            envAddressOr("CURB_SHARING_KEEPER_PAYEE", address(0)),
            envAddressesOr("CURB_SHARING_VETOERS"),
            policyOwner,
            demo,
            deployer
        );
    }

    /// The checks, apart from the environment so a test can drive them with
    /// plain arguments. Zero is what an unset variable reads as.
    ///
    /// A DEMO'S DEFAULTS ARE FILLED FIRST AND CHECKED AFTER: an unset publisher
    /// or keeper payee is the deployer on a demo, and stays a refusal on a real
    /// run.
    ///
    /// A VETOER IS THERE TO STOP THE PUBLISHER, so no separate vetoer may be the
    /// publisher, and a real run must name at least one: the policy owner is a
    /// vetoer too, but it is the same platform Safe that can rotate the
    /// publisher, and the design asks for a vetoer held apart from both. The
    /// policy owner is added here, once, and refused in the list, where it would
    /// read as a separate vetoer while being the same one.
    function checkSharingRoles(
        address publisher,
        address keeperPayee,
        address[] memory vetoers,
        address policyOwner,
        bool demo,
        address deployer
    ) internal pure returns (SharingRoles memory r) {
        if (demo && publisher == address(0)) publisher = deployer;
        if (demo && keeperPayee == address(0)) keeperPayee = deployer;
        require(
            publisher != address(0),
            "CURB_SHARING_PUBLISHER is not set (or is the zero address). It is the key that proposes holder payouts; a real deployment names it."
        );
        require(
            keeperPayee != address(0),
            "CURB_SHARING_KEEPER_PAYEE is not set (or is the zero address). It receives the keeper's gas fee; a real deployment names it."
        );
        require(
            demo || vetoers.length > 0,
            "CURB_SHARING_VETOERS is not set. A real deployment names at least one vetoer besides the policy owner, held apart from the publisher."
        );
        r.publisher = publisher;
        r.keeperPayee = keeperPayee;
        r.vetoers = new address[](vetoers.length + 1);
        for (uint256 i = 0; i < vetoers.length; i++) {
            address v = vetoers[i];
            require(v != address(0), "a CURB_SHARING_VETOERS entry is the zero address");
            require(
                v != publisher,
                "a CURB_SHARING_VETOERS entry is the publisher. A vetoer is there to stop the publisher's payouts."
            );
            require(
                v != policyOwner,
                "a CURB_SHARING_VETOERS entry is the policy owner, which is a vetoer already. Name the separate vetoers there."
            );
            for (uint256 j = 0; j < i; j++) {
                require(vetoers[j] != v, "CURB_SHARING_VETOERS names one address twice");
            }
            r.vetoers[i] = v;
        }
        r.vetoers[vetoers.length] = policyOwner;
    }

    /// WHAT THE DEPLOY ORDER MADE, READ BACK. Each contract is asked what it
    /// was built on, rather than trusting the variables that built it: the
    /// Graduator for its catalog, the catalog for its owner, its bootstrapper
    /// and the version it approves and recommends, the distributor factory for
    /// its registry, Graduator, owner and roles, its implementation for the
    /// factory and Graduator it answers to, and the lens for its registry and
    /// Graduator.
    function requireSharingWiring(
        LaunchRegistry registry,
        SharingCatalog catalog,
        Graduator graduator,
        HolderDistributorFactory distributorFactory,
        LaunchLens lens,
        address deployer,
        address policyOwner,
        SharingRoles memory roles
    ) internal view {
        require(address(graduator.registry()) == address(registry), "the Graduator reads another registry");
        require(address(graduator.sharingCatalog()) == address(catalog), "the Graduator asks another sharing catalog");
        require(catalog.owner() == policyOwner, "the sharing catalog's owner is not CURB_POLICY_OWNER");
        require(catalog.bootstrapper() == deployer, "the sharing catalog's bootstrapper is not the deployer");
        require(catalog.bootstrapped(), "the sharing catalog's bootstrap was not used");
        require(catalog.isApproved(address(distributorFactory)), "the sharing catalog does not approve the distributor factory");
        require(
            catalog.recommended() == address(distributorFactory),
            "the sharing catalog does not recommend the distributor factory"
        );
        require(distributorFactory.registry() == address(registry), "the distributor factory reads another registry");
        require(distributorFactory.graduator() == address(graduator), "the distributor factory reads another Graduator");
        require(distributorFactory.owner() == policyOwner, "the distributor factory's owner is not CURB_POLICY_OWNER");
        require(distributorFactory.publisher() == roles.publisher, "the distributor factory's publisher is not the one named");
        require(
            distributorFactory.keeperPayee() == roles.keeperPayee,
            "the distributor factory's keeper payee is not the one named"
        );
        for (uint256 i = 0; i < roles.vetoers.length; i++) {
            require(distributorFactory.isVetoer(roles.vetoers[i]), "a vetoer named is not a vetoer of the distributor factory");
        }
        require(!distributorFactory.frozen(), "the distributor factory starts frozen");
        HolderFeeDistributor implementation = HolderFeeDistributor(payable(distributorFactory.implementation()));
        require(address(implementation).code.length != 0, "the distributor implementation has no code");
        require(implementation.factory() == address(distributorFactory), "the distributor implementation answers to another factory");
        require(implementation.graduator() == address(graduator), "the distributor implementation reads another Graduator");
        require(address(lens.registry()) == address(registry), "the lens reads another registry");
        require(address(lens.graduator()) == address(graduator), "the lens reads another Graduator");
    }

    /*//////////////////////////////////////////////////////////////
                  THE FIRST LAUNCH: $CURB, ON THE WETH FACTORY
    //////////////////////////////////////////////////////////////*/

    /// $CURB, LAUNCHED IN THE TRANSACTION RIGHT AFTER THE WETH FACTORY IS
    /// ADMITTED, WHICH IS THE FIRST ADMISSION OF THE RUN.
    ///
    /// The Launches page's hero features the registry's first launch paired
    /// with ETH, and the registry is append-only: whichever launch lands first
    /// is launch 0 for good. launch() on a factory is open to anyone from the
    /// receipt of that factory's admission. So every stack is built first,
    /// none of them admitted - a factory's constructor needs nothing of the
    /// registry - then the dev buy's WETH is wrapped and approved, the WETH
    /// factory is wire()d, $CURB's launch is the very next transaction, and
    /// only after it are the other factories addLauncher()ed (admissionOrder,
    /// deploy). A launch on any of them can no longer come before $CURB, however
    /// long the run's other transactions take or wherever a broadcast dies:
    /// nothing is admitted until $CURB's own factory is. It is after the
    /// catalog admits the distributor factory too, so it may share with its
    /// holders from the start.
    ///
    /// ONE RECEIPT IS LEFT OPEN, NOT NONE, AND ONLY ON THE WETH FACTORY.
    /// Between the wire()'s receipt and $CURB's own - the time it takes the
    /// signer to sign and send one more transaction under --slow - a watcher
    /// who reads the wiring could launch on the WETH factory first; it is the
    /// only factory then admitted. One is what a run of separate transactions
    /// cannot get below. The run asserts that $CURB is registry.launchAt(0),
    /// but only in its simulation: on chain, check-deployment.sh reads which
    /// launch $CURB is - and that no factory was admitted before it - and
    /// DEPLOY.txt ($CURB IS NOT LAUNCH ZERO) says what to do if it is not.
    ///
    /// AN OPT-IN, LIKE THE DEMO, read from the environment:
    ///   CURB_FIRST_LAUNCH    1 to launch it; 0 or unset launches nothing
    ///   CURB_FIRST_NAME      the token's name, written into it for good
    ///   CURB_FIRST_SYMBOL    its symbol, likewise
    ///   CURB_FIRST_URI       its metadata URI (set, though it may be empty)
    ///   CURB_FIRST_TAX_BPS   the one tax, inside the factory's band
    ///   CURB_FIRST_CREATOR   who it pays and whose locked position it is:
    ///                        never zero and never the deployer
    ///   CURB_FIRST_DEV_BUY   wei of ether the deployer wraps into WETH and
    ///                        spends as the creator's first buy; 0 for none
    ///   CURB_FIRST_SHARE     1: its creator income goes to its holders from
    ///                        the first trade; 0: to the creator
    /// With CURB_FIRST_LAUNCH=1 every other one must be set, and set exactly:
    /// the flags 0 or 1, the numbers plain decimal digits. forge reads a flag
    /// it cannot parse as false without a word, and a misspelt number as a
    /// revert nobody can read; each is said here instead. And one opt-in:
    ///   CURB_ALLOW_EOA_CREATOR  true when the creator is meant to be one key
    ///
    /// THE CREATOR IS NEVER ZERO AND NEVER THE DEPLOYER. Zero means the caller
    /// to launch(), so either would make the key that signs this run - a hot
    /// key, by the runbook's own account - $CURB's creator-fee recipient and
    /// the beneficiary of its locked position, for good: no setter moves it.
    ///
    /// AND NOT ONE KEY UNLESS SAID. Decision 6 asks for a treasury Safe, and
    /// an address with no code is also what a mistyped address looks like:
    /// $CURB's dev-buy tokens, its refund, its locked position and its LP
    /// fees would go to it for good. It used to be classified and never
    /// refused; now a code-less creator needs CURB_ALLOW_EOA_CREATOR=true, as
    /// a one-key recipient or policy owner needs its own opt-in.
    struct FirstLaunch {
        bool on;
        string name;
        string symbol;
        string uri;
        uint16 taxBps;
        address creator;
        uint256 devBuy;
        bool share;
        bool allowEoaCreator;
    }

    /// $CURB's token salt. Any constant would do; this one is named so that
    /// the token's address is a function of the run alone.
    bytes32 internal constant FIRST_LAUNCH_SALT = keccak256("CURB first launch");

    /// A flag of the first launch: exactly "1" or "0". Unset reads as 0, or is
    /// refused when `required`.
    function _envFlag01(string memory name, bool required) internal view returns (bool) {
        if (!vm.envExists(name)) {
            require(!required, string.concat(name, " is not set. CURB_FIRST_LAUNCH=1 needs it: 1 or 0."));
            return false;
        }
        bytes32 v = keccak256(bytes(vm.envString(name)));
        if (v == keccak256("1")) return true;
        if (v == keccak256("0")) return false;
        revert(string.concat(name, " must be exactly 1 or 0, not '", vm.envString(name), "'."));
    }

    /// A number of the first launch: set, and plain decimal digits - no sign,
    /// no 0x, no exponent, no space.
    function _envDigits(string memory name) internal view returns (uint256) {
        require(vm.envExists(name), string.concat(name, " is not set. CURB_FIRST_LAUNCH=1 needs it."));
        bytes memory raw = bytes(vm.envString(name));
        require(raw.length > 0 && raw.length <= 78, string.concat(name, " must be plain decimal digits."));
        for (uint256 i = 0; i < raw.length; i++) {
            require(raw[i] >= "0" && raw[i] <= "9", string.concat(name, " must be plain decimal digits."));
        }
        return vm.parseUint(string(raw));
    }

    /// A text of the first launch: set, and nothing a terminal would not show.
    function _envText(string memory name, bool mayBeEmpty) internal view returns (string memory text) {
        require(vm.envExists(name), string.concat(name, " is not set. CURB_FIRST_LAUNCH=1 needs it."));
        text = vm.envString(name);
        bytes memory raw = bytes(text);
        require(mayBeEmpty || raw.length > 0, string.concat(name, " is empty. It is written into $CURB for good."));
        for (uint256 i = 0; i < raw.length; i++) {
            require(
                uint8(raw[i]) >= 0x20 && uint8(raw[i]) != 0x7f,
                string.concat(name, " holds a control character (a newline, a tab). It is written into $CURB for good.")
            );
        }
    }

    /// THE FIRST LAUNCH, FROM THE ENVIRONMENT (FirstLaunch above says what
    /// each variable is). Nothing is read past CURB_FIRST_LAUNCH unless it is 1.
    function firstLaunchFromEnv(address deployer) internal view virtual returns (FirstLaunch memory f) {
        f.on = _envFlag01("CURB_FIRST_LAUNCH", false);
        if (!f.on) return f;
        f.name = _envText("CURB_FIRST_NAME", false);
        f.symbol = _envText("CURB_FIRST_SYMBOL", false);
        f.uri = _envText("CURB_FIRST_URI", true);
        uint256 tax = _envDigits("CURB_FIRST_TAX_BPS");
        require(tax <= type(uint16).max, "CURB_FIRST_TAX_BPS is out of range. The factory takes 100 to 500.");
        f.taxBps = uint16(tax);
        require(vm.envExists("CURB_FIRST_CREATOR"), "CURB_FIRST_CREATOR is not set. CURB_FIRST_LAUNCH=1 needs it.");
        f.creator = envAddressChecked("CURB_FIRST_CREATOR");
        f.devBuy = _envDigits("CURB_FIRST_DEV_BUY");
        f.share = _envFlag01("CURB_FIRST_SHARE", true);
        f.allowEoaCreator = vm.envOr("CURB_ALLOW_EOA_CREATOR", false);
        checkFirstLaunch(f, deployer);
    }

    /// The first launch's own rules, apart from the environment so a test can
    /// drive them with plain arguments. The factory refuses the rest - a tax
    /// outside its band, a dev buy past a fifth of the supply or at the
    /// threshold - inside the run, which then sends nothing.
    function checkFirstLaunch(FirstLaunch memory f, address deployer) internal view {
        if (!f.on) return;
        require(
            f.creator != address(0),
            "CURB_FIRST_CREATOR is the zero address. Zero would make the deployer $CURB's creator for good."
        );
        require(
            f.creator != deployer,
            "CURB_FIRST_CREATOR is the deployer. A hot key would be $CURB's creator and the owner of its locked position for good."
        );
        // WHAT KIND OF ADDRESS IT IS, said out loud - the line printed here is
        // what the operator compares - and one key refused unless said
        // (FirstLaunch). A contract that is not Safe-shaped (a splitter, a
        // vesting contract) is the treasury policy's to choose, and passes.
        _checkKind(
            f.creator,
            "$CURB creator",
            "CURB_FIRST_CREATOR",
            "DEPLOY.txt decision 6",
            "CURB_ALLOW_EOA_CREATOR",
            "",
            f.allowEoaCreator,
            true
        );
    }

    /// $CURB'S DEV BUY, WRAPPED AND APPROVED BEFORE THE WETH FACTORY IS
    /// WIRED, so that nothing of the run stands between that admission and
    /// $CURB's launch (FirstLaunch says why).
    function _fundFirst(address wethFactory, FirstLaunch memory f) internal {
        require(CurbLaunchFactory(wethFactory).quoteToken() == WETH, "the first launch's factory does not quote WETH");
        if (f.devBuy != 0) {
            IWETH9(WETH).deposit{value: f.devBuy}();
            IERC20(WETH).approve(wethFactory, f.devBuy);
        }
    }

    /// $CURB ITSELF, inside the broadcast: launch on the WETH factory, the
    /// dev buy already approved (_fundFirst), and see that it is the
    /// registry's only launch.
    function _launchFirst(Shared memory s, address wethFactory, FirstLaunch memory f)
        internal
        returns (address token, address curve)
    {
        CurbLaunchFactory factory = CurbLaunchFactory(wethFactory);
        require(factory.quoteToken() == WETH, "the first launch's factory does not quote WETH");
        require(s.registry.launchCount() == 0, "the registry already holds a launch, so $CURB would not be the first");
        // THE TERMS, READ BACK OFF THE HOOK AND THE FACTORY THIS RUN BUILT -
        // the launch fee (zero) and the platform pair launch() checks against.
        (CurbLaunchToken t, PonsV2BondingCurve c) = factory.launch{value: factory.launchFee()}(
            CurbLaunchFactory.LaunchConfig({
                name: f.name,
                symbol: f.symbol,
                tokenUri: f.uri,
                salt: FIRST_LAUNCH_SALT,
                // LEFTOVER WETH AT GRADUATION GOES TO THE CREATOR TOO, not to
                // the deployer: no hot key is owed anything by $CURB.
                quoteRefundTo: f.creator,
                totalTaxBps: f.taxBps,
                devBuy: f.devBuy,
                creatorWallet: f.creator,
                expectedPlatformBps: s.hook.platformFeeBps(),
                expectedPlatformRecipient: s.hook.platformRecipient(),
                holderShareFactory: f.share ? address(s.distributorFactory) : address(0)
            })
        );
        require(s.registry.launchCount() == 1, "registry.launchCount() is not 1 after $CURB");
        require(s.registry.launchAt(0) == address(t), "registry.launchAt(0) is not $CURB");
        return (address(t), address(c));
    }

    /// WHAT THE FIRST LAUNCH MADE, READ BACK. The record the registry keeps,
    /// the token's own words, the sharing switch and the dev buy, each against
    /// what was asked - and no allowance left standing on the deployer.
    function requireFirstLaunch(
        Shared memory s,
        address wethFactory,
        address deployer,
        address token,
        address curve,
        FirstLaunch memory f
    ) internal view {
        require(s.registry.launchAt(0) == token, "registry.launchAt(0) is not $CURB");
        LaunchRegistry.Launch memory rec = s.registry.launchOf(token);
        require(rec.curve == curve, "$CURB's record names another curve");
        require(rec.quoteToken == WETH, "$CURB's record is not paired with WETH");
        require(rec.beneficiary == f.creator, "$CURB's beneficiary is not CURB_FIRST_CREATOR");
        require(rec.refundTo == f.creator, "$CURB's refund address is not CURB_FIRST_CREATOR");
        require(rec.totalTaxBps == f.taxBps, "$CURB's tax is not CURB_FIRST_TAX_BPS");
        CurbLaunchToken t = CurbLaunchToken(token);
        require(keccak256(bytes(t.name())) == keccak256(bytes(f.name)), "$CURB's name is not CURB_FIRST_NAME");
        require(keccak256(bytes(t.symbol())) == keccak256(bytes(f.symbol)), "$CURB's symbol is not CURB_FIRST_SYMBOL");
        require(keccak256(bytes(t.tokenURI())) == keccak256(bytes(f.uri)), "$CURB's URI is not CURB_FIRST_URI");
        require(
            (s.graduator.holderDistributorOf(token) != address(0)) == f.share,
            f.share ? "$CURB does not share with its holders" : "$CURB shares with its holders, and CURB_FIRST_SHARE is 0"
        );
        require(
            (t.balanceOf(f.creator) != 0) == (f.devBuy != 0),
            f.devBuy != 0 ? "$CURB's creator received nothing from the dev buy" : "$CURB's creator holds tokens without a dev buy"
        );
        require(t.balanceOf(deployer) == 0, "the deployer holds $CURB");
        require(IERC20(WETH).allowance(deployer, wethFactory) == 0, "the deployer left a WETH allowance on the factory");
    }

    /*//////////////////////////////////////////////////////////////
                      THE REGISTRY, HANDED TO THE POLICY OWNER
    //////////////////////////////////////////////////////////////*/

    /// THE REGISTRY IS BORN OWNED BY THE DEPLOYER AND OFFERED TO THE POLICY
    /// OWNER BEFORE THE RUN ENDS.
    ///
    /// Its owner is the one key that can admit launchers - at once, up to 32,
    /// none removable - while the catalog, the hook and the distributor
    /// factory are born owned by the policy owner. The handover used to be
    /// prose in DEPLOY.txt; forgotten, it left the deployer's single key able
    /// to fill the launcher list for good. LaunchRegistry is Ownable2Step, so
    /// this only offers it: the deployer stays the owner until the policy Safe
    /// calls acceptOwnership(), which is the runbook's step after this run.
    /// When the policy owner IS the deployer (a one-key rehearsal) there is
    /// nobody to offer it to, and nothing is sent.
    function requireRegistryHandover(LaunchRegistry registry, address deployer, address policyOwner) internal view {
        require(registry.owner() == deployer, "the registry's owner is not the deployer");
        if (policyOwner == deployer) {
            require(registry.pendingOwner() == address(0), "the registry is offered to someone, and the policy owner is the deployer");
        } else {
            require(
                registry.pendingOwner() == policyOwner,
                "the registry was not offered to CURB_POLICY_OWNER (pendingOwner() reads otherwise)"
            );
        }
    }

    /*//////////////////////////////////////////////////////////////
                                  THE RUN
    //////////////////////////////////////////////////////////////*/

    /// WHAT run() HAS ASKED AND CHECKED, handed to deploy() in one record.
    struct Plan {
        address deployer;
        address platform;
        address policyOwner;
        SharingRoles roles;
        bool demo;
        Asset[] assets;
        FirstLaunch first;
    }

    /// WHAT deploy() LEFT ON CHAIN.
    struct Deployed {
        Shared s;
        address[] factories;
        address firstToken;
        address firstCurve;
        address demoToken;
        address demoCurve;
    }

    /// Where WETH is in the list, or the list's length when it is not there.
    function _wethIndex(Asset[] memory assets) internal pure returns (uint256 i) {
        while (i < assets.length && assets[i].quote != WETH) i++;
    }

    /// THE ORDER THE STACKS ARE ADMITTED IN, ONCE EVERY ONE IS BUILT: WETH
    /// FIRST - wire()d, with $CURB launched on it in the very next transaction
    /// - then every other asset in the list's order, each addLauncher()ed
    /// after $CURB. No factory but $CURB's own is open before $CURB exists
    /// (FirstLaunch says why). A list without WETH keeps its own order. The
    /// stacks are BUILT in the list's order, all before the first admission,
    /// so the registry's launchers read WETH's first and then the list's.
    function admissionOrder(Asset[] memory assets) internal pure returns (uint256[] memory order) {
        uint256 w = _wethIndex(assets);
        order = new uint256[](assets.length);
        uint256 k;
        if (w < assets.length) order[k++] = w;
        for (uint256 i = 0; i < assets.length; i++) {
            if (i != w) order[k++] = i;
        }
    }

    /// EACH ASSET'S TERMS ON ONE LINE: label, asset, decimals, phantom,
    /// threshold, in raw units, under a heading and ended by an empty line.
    /// The preflight prices these against Chainlink to see that every launch
    /// still starts near $4K and graduates near $55K at today's prices
    /// (script/b20/preflight-mainnet.sh, usd_gate). One function for the run
    /// and for DeployAssetStack, so the preflight reads both the same way.
    function logTerms(Asset[] memory assets) internal pure {
        console.log("=== each asset's terms: label asset decimals phantom threshold ===");
        for (uint256 i = 0; i < assets.length; i++) {
            console.log(
                string.concat(
                    assets[i].label,
                    " ",
                    vm.toString(assets[i].quote),
                    " ",
                    vm.toString(uint256(assets[i].decimals)),
                    " ",
                    vm.toString(assets[i].phantomQuote),
                    " ",
                    vm.toString(assets[i].threshold)
                )
            );
        }
        console.log("");
    }

    /// Whether the list holds an asset under this label.
    function _lists(Asset[] memory assets, string memory label) internal pure returns (bool) {
        for (uint256 i = 0; i < assets.length; i++) {
            if (keccak256(bytes(assets[i].label)) == keccak256(bytes(label))) return true;
        }
        return false;
    }

    function run() external virtual {
        address deployer = msg.sender;
        address platform = platformRecipient();

        // THE HOOK IS THE FEE POLICY, so it has an owner. That owner is a
        // SEPARATE role from the deployer's and from the recipient's: the
        // recipient holds money, the deployer holds a wiring privilege, and
        // this one can move the platform's cut FOR FUTURE LAUNCHES. It can
        // redirect nothing that exists: the share and the recipient are taken
        // once when a launch is created and read from its record by both the
        // curve and the pool.
        //
        // IT DEFAULTS TO THE DEPLOYER, WHICH IS ONE KEY, AND ONE KEY NOW HAS TO
        // BE SAID. The default used to keep a one-key run working silently;
        // now it is classified like any other value (checkPolicyOwner), before
        // anything is broadcast, and CURB_POLICY_OWNER is how it becomes a Safe.
        address policyOwner = envAddressOr("CURB_POLICY_OWNER", deployer);
        checkPolicyOwner(
            policyOwner,
            platform,
            vm.envOr("CURB_ALLOW_SAME_RECIPIENT_AND_OWNER", false),
            vm.envOr("CURB_ALLOW_EOA_POLICY_OWNER", false),
            vm.envOr("CURB_ALLOW_NON_SAFE_POLICY_OWNER", false)
        );

        // THE HOLDER SHARING ROLES, asked here with the other roles, before
        // anything is priced or sent. A demo may leave them to the deployer.
        bool demoRun = vm.envOr("CURB_DEMO_LAUNCH", false);
        SharingRoles memory roles = sharingRoles(demoRun, deployer, policyOwner);

        // AND THE CODE THAT MUST NOT HAVE CHANGED (requireUnchangedCode).
        requireUnchangedCode();

        // THE DEPTH CHECKS COME FIRST, OUTSIDE THE BROADCAST. They used to run
        // inside it, one per asset just before its stack. QuoterV2's quote is
        // not a view - it simulates the swap and reverts with the answer - so
        // under a broadcast every attempt was RECORDED AS A TRANSACTION: a tier
        // that cannot fill, which is the normal case for most tiers, made the
        // run die at re-simulation with "Simulated execution failed", and a
        // tier that could fill was actually sent to Base, costing gas and
        // deploying nothing. The mainnet path is the only one that asks the
        // quoter, so no rehearsal had ever run it. Nothing here writes state,
        // so doing all fourteen before anything exists changes only that.
        //
        // AND STILL BEFORE THE STACK, because a factory whose asset cannot
        // supply a threshold is a factory whose launches cannot graduate, and
        // the cheapest moment to learn that is before it exists.
        Asset[] memory assets = quoteAssets();
        for (uint256 i = 0; i < assets.length; i++) {
            requireDepthMatchesClaim(assets[i], demoRun);
        }

        // THE FIRST LAUNCH, READ AFTER EVERYTHING ABOVE IS ASKED AND BEFORE
        // ANYTHING IS SENT. After the depth checks in particular: the
        // environment is one per process, the run() test in B20MultiAsset sets
        // it and stops run() at the depth check, and so a CURB_FIRST_* value
        // another test sets on the same process never reaches that test.
        FirstLaunch memory first = firstLaunchFromEnv(deployer);

        deploy(
            Plan({
                deployer: deployer,
                platform: platform,
                policyOwner: policyOwner,
                roles: roles,
                demo: demoRun,
                assets: assets,
                first: first
            })
        );
    }

    /// EVERYTHING run() SENDS, AND THE READ-BACK OF IT, from a plan every
    /// check in run() has passed. Its own function so a test can run the whole
    /// deployment from plain arguments rather than from the environment, which
    /// forge's side-by-side test contracts share.
    function deploy(Plan memory p) internal returns (Deployed memory d) {
        address deployer = p.deployer;
        address platform = p.platform;
        address policyOwner = p.policyOwner;
        SharingRoles memory roles = p.roles;
        Asset[] memory assets = p.assets;
        bool wantDemo = p.demo;
        // $CURB NEEDS WETH IN THE LIST, found by its address rather than its
        // place, for the reason the demo's factory is found by name below.
        require(!p.first.on || _wethIndex(assets) < assets.length, "the first launch needs WETH in the list");
        // AND A LIST AT ALL: the first admission is a wire() of one of them.
        require(assets.length != 0, "no quote asset to deploy a factory for");
        // THE DEMO NEEDS NVDAc AND NOTHING ELSE DOES. The demo's factory was
        // resolved unconditionally, and its line printed, so a list without
        // NVDAc - the mainnet list is decided later - reverted a real run at
        // a lookup only the fork uses.
        require(!wantDemo || _lists(assets, "NVDAc"), "a demo launch needs NVDAc in the list");

        vm.startBroadcast();

        // THE SHARED CONTRACTS, in one record: the deploy order holds more of
        // them than a function's stack does.
        Shared memory s;
        s.registry = new LaunchRegistry(deployer);
        // THE LIST OF HOLDER-DISTRIBUTOR VERSIONS, owned with the fee policy;
        // the deployer may admit the first version once, within a day.
        s.catalog = new SharingCatalog(policyOwner, deployer);
        s.graduator = new Graduator(
            POOL_MANAGER, IPositionManagerMinimal(POSM), PERMIT2, s.registry, ISharingCatalog(address(s.catalog))
        );

        // THE HOOK'S RATE IS NOT AN ARGUMENT ANY MORE. It charges each pool
        // the tax its own launch recorded, read from the registry, so what it
        // needs at construction is the registry - not a number. Its owner was
        // classified above, before the broadcast began.
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
                | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        (address hookAddress, bytes32 salt) = HookMiner.find(
            CREATE2_DEPLOYER,
            flags,
            type(FeeHook).creationCode,
            abi.encode(POOL_MANAGER, platform, s.registry, address(s.graduator), policyOwner)
        );
        s.hookSalt = salt;
        s.hook = new FeeHook{salt: salt}(POOL_MANAGER, platform, s.registry, address(s.graduator), policyOwner);
        require(address(s.hook) == hookAddress, "hook did not deploy to the mined address");
        // THE KEY THAT MOVES THE PLATFORM'S CUT FOR EVERY FUTURE LAUNCH is the
        // one intended. The constructor sets it; this reads it back, because
        // ADDRESSES.txt tells the operator it was checked.
        require(s.hook.owner() == policyOwner, "the hook's owner is not CURB_POLICY_OWNER");

        // THE HOLDER DISTRIBUTOR FACTORY, v1, owned by the policy owner (the
        // platform Safe) like the catalog. Its roles take effect at once; every
        // later change goes through its own 48-hour announcement. BEFORE THE
        // STACKS: it needs only the registry and the Graduator, and every
        // stack built after it is one transaction less between the catalog's
        // creation and admitInitial below.
        s.distributorFactory = new HolderDistributorFactory(
            address(s.registry), address(s.graduator), policyOwner, roles.publisher, roles.keeperPayee, roles.vetoers
        );
        // THE FIRST VERSION IS ADMITTED NOW, by the deployer, inside the
        // catalog's one-day bootstrap window. Every later version waits out the
        // catalog's seven days in public.
        s.catalog.admitInitial(address(s.distributorFactory));

        s.lens = new LaunchLens(s.registry, s.graduator);

        // ONE STACK PER QUOTE ASSET, every one built before any is admitted,
        // then the admissions with $CURB among them (_stacksThenCurb).
        address[] memory factories = _stacksThenCurb(s, p, d);

        // THE DEMO LAUNCH IS AN OPT-IN, AND THE DIRECTION OF THAT IS THE POINT.
        //
        // This used to run unconditionally, which is right for a fork and wrong
        // for a chain: a registry record is write-once and the list is
        // append-only, so a "Curb Demo" created on mainnet would be launch
        // number one, for good, with no way to remove or rename it - the first
        // thing anybody browsing the product would see.
        //
        // Requiring the flag to CREATE it fails in the safe direction. Forget
        // it on the fork and the runner scripts break immediately and loudly,
        // because they parse the lines below by name. Forget it on mainnet and
        // nothing happens at all.
        //
        // Found by simulating this script against LIVE Base rather than the
        // pinned fork, which is the only place the difference shows.
        //
        // THE DEMO'S FACTORY IS CHOSEN BY NAME, NOT BY POSITION. It was
        // factories[0], and adding WETH to the front of the list silently
        // pointed every demo and the whole browser fixture at a factory
        // quoting a different asset with a threshold three orders of magnitude
        // away - they funded NVDAc, spent NVDAc and never crossed. The list is
        // a product decision and its order should not be load-bearing.
        if (wantDemo) {
            CurbLaunchFactory factory = CurbLaunchFactory(_factoryFor(assets, factories, "NVDAc"));
            // creatorWallet zero: the creator is msg.sender - here, the deployer.
            // THE FEE, READ BACK OFF THE FACTORY THIS SCRIPT JUST BUILT -
            // zero today. launch() takes an exact amount and refuses anything
            // else, so a figure repeated here would have to be kept in step
            // with the terms above by hand.
            (CurbLaunchToken token, PonsV2BondingCurve curve) = factory.launch{value: factory.launchFee()}(
                CurbLaunchFactory.LaunchConfig({
                    name: "Curb Demo",
                    symbol: "DEMO",
                    tokenUri: "",
                    salt: bytes32(uint256(1)),
                    quoteRefundTo: deployer,
                    totalTaxBps: DEMO_TOTAL_TAX_BPS,
                    devBuy: 0,
                    creatorWallet: address(0),
                    expectedPlatformBps: s.hook.platformFeeBps(),
                    expectedPlatformRecipient: s.hook.platformRecipient(),
                    holderShareFactory: address(0)
                })
            );
            (d.demoToken, d.demoCurve) = (address(token), address(curve));
        }

        // THE REGISTRY IS OFFERED TO THE POLICY OWNER, LAST (requireRegistryHandover
        // says why). Last, because the run itself needs the deployer to own it
        // for wire() and addLauncher() above.
        if (policyOwner != deployer) s.registry.transferOwnership(policyOwner);

        vm.stopBroadcast();

        // EVERY LINK THE ORDER ABOVE MADE, READ BACK OFF THE CONTRACTS.
        requireSharingWiring(
            s.registry, s.catalog, s.graduator, s.distributorFactory, s.lens, deployer, policyOwner, roles
        );
        if (p.first.on) {
            requireFirstLaunch(s, factories[_wethIndex(assets)], deployer, d.firstToken, d.firstCurve, p.first);
        }
        requireRegistryHandover(s.registry, deployer, policyOwner);
        d.s = s;
        d.factories = factories;

        console.log("");
        // NAMED BY WHAT WAS ACTUALLY RUN. It said "local fork" on every run,
        // including a real one against chain 8453.
        console.log(wantDemo ? "=== CURB, with a demo launch ===" : "=== CURB ===");
        console.log("chain id        ", block.chainid);
        console.log("LaunchLens      ", address(s.lens));
        console.log("Graduator       ", address(s.graduator));
        console.log("LaunchRegistry  ", address(s.registry));
        _logSharing(s, roles);
        // THE DEMO'S OWN FACTORY, UNDER ITS OLD LABEL. The runner scripts read
        // this line by name; dropping it when the list below was added broke
        // every one of them, and the browser suite with them. A list without
        // NVDAc - never a demo's - prints the first factory under it.
        console.log(
            "CurbLaunchFactory", _lists(assets, "NVDAc") ? _factoryFor(assets, factories, "NVDAc") : factories[0]
        );
        console.log("FeeHook         ", address(s.hook));
        // EVERYTHING ADDRESSES.txt ASKS FOR IS PRINTED HERE, so it can be taken
        // from this output as the address book says. It asked for the salt, the
        // roles and every contract of every stack while the script printed one
        // line per asset; the rest had to be reconstructed from the broadcast
        // file by transaction order - fourteen identical FeeEscrow creations -
        // which is the hand transcription the address book exists to prevent.
        // These lines come AFTER the ones above because the runner scripts take
        // the first line starting with a name, and none of these starts with
        // one of theirs.
        console.log("hook salt       ", vm.toString(s.hookSalt));
        console.log("deployer        ", deployer);
        console.log("platform recipient", platform);
        console.log("policy owner    ", policyOwner);
        // THE REGISTRY'S HANDOVER, as it stands when the run ends.
        console.log("registry owner  ", s.registry.owner());
        console.log("registry pending owner", s.registry.pendingOwner());
        // THE OPT-INS THE RUN WAS MADE WITH, from the same variables the checks
        // read. Each one is a recorded decision, and ADDRESSES.txt records it.
        console.log("opt-in CURB_ALLOW_EOA_RECIPIENT           ", vm.envOr("CURB_ALLOW_EOA_RECIPIENT", false));
        console.log("opt-in CURB_ALLOW_NON_SAFE_RECIPIENT      ", vm.envOr("CURB_ALLOW_NON_SAFE_RECIPIENT", false));
        console.log("opt-in CURB_ALLOW_EOA_POLICY_OWNER        ", vm.envOr("CURB_ALLOW_EOA_POLICY_OWNER", false));
        console.log("opt-in CURB_ALLOW_NON_SAFE_POLICY_OWNER   ", vm.envOr("CURB_ALLOW_NON_SAFE_POLICY_OWNER", false));
        console.log("opt-in CURB_ALLOW_SAME_RECIPIENT_AND_OWNER", vm.envOr("CURB_ALLOW_SAME_RECIPIENT_AND_OWNER", false));
        console.log("opt-in CURB_ALLOW_EOA_CREATOR             ", p.first.allowEoaCreator);
        console.log("");
        console.log("=== one factory per quote asset ===");
        for (uint256 i = 0; i < assets.length; i++) {
            console.log(assets[i].label, factories[i], assets[i].phantomQuote, assets[i].threshold);
        }
        console.log("");
        logTerms(assets);
        // READ BACK OFF EACH FACTORY, not remembered from the deployment above:
        // the factory's immutables are what its launches will actually use.
        console.log("=== each asset's stack, read back from its factory ===");
        for (uint256 i = 0; i < assets.length; i++) {
            CurbLaunchFactory f = CurbLaunchFactory(factories[i]);
            console.log(assets[i].label);
            console.log("   CurbLaunchFactory ", factories[i]);
            console.log("   FeeEscrow         ", address(f.feeEscrow()));
            console.log("   FeePolicy         ", address(f.feePolicy()));
            console.log("   PonsV2BuybackVault", address(f.buybackVault()));
        }
        console.log("");
        if (p.first.on) {
            // AS SIMULATED. On chain one receipt stays open before $CURB's
            // launch (FirstLaunch), and a launch that lands in it moves $CURB's
            // place, token and curve; check-deployment.sh prints what landed,
            // from the launch's own receipt, and ADDRESSES.txt takes those.
            console.log("=== $CURB, the first launch, as simulated (registry.launchAt(0)) ===");
            console.log("$CURB token      ", d.firstToken);
            console.log("$CURB curve      ", d.firstCurve);
            console.log("$CURB factory    ", factories[_wethIndex(assets)]);
            console.log("$CURB creator    ", p.first.creator);
            console.log("$CURB tax bps    ", uint256(p.first.taxBps));
            console.log("$CURB dev buy wei", p.first.devBuy);
            console.log("$CURB shares with its holders", p.first.share);
            console.log("");
        }
        if (wantDemo) {
            console.log("demo launch token", d.demoToken);
            console.log("demo curve       ", d.demoCurve);
            console.log("demo quote asset ", "NVDAc");
            console.log("");
            // THE GRADUATOR IS NOT TYPED. launch.html reads it from the lens
            // into a read-only field; this line used to ask for it.
            console.log("Put the LaunchLens and token addresses into web/launch.html (it reads the Graduator from the lens).");
            console.log("To drive the demo curve towards its threshold, send it NVDAc and call buy().");
            console.log("NVDAc whale on this fork:", NVDAC_WHALE);
        } else {
            // THE FIRST WORDS ARE WHAT THE PREFLIGHT LOOKS FOR; what follows
            // says what the registry holds.
            console.log(
                p.first.on
                    ? "NO DEMO LAUNCH WAS CREATED. The registry holds $CURB alone, as launch 0."
                    : "NO DEMO LAUNCH WAS CREATED. The registry is empty."
            );
            if (p.first.on) {
                // SAID, because the line above is the SIMULATION's: on chain
                // one receipt stays open before $CURB (FirstLaunch says why).
                console.log("   (in this run's simulation; on chain, check-deployment.sh reads which launch $CURB is)");
            }
            console.log("Set CURB_DEMO_LAUNCH=true to create one - never on a real chain.");
        }
        if (policyOwner != deployer) {
            console.log("");
            console.log("THE REGISTRY IS OFFERED, NOT HANDED OVER. Until the policy owner calls");
            console.log("registry.acceptOwnership(), the deployer still admits launchers alone.");
            console.log("   to   ", address(s.registry));
            console.log("   data ", vm.toString(abi.encodeWithSignature("acceptOwnership()")));
        }
    }

    /// EVERY STACK, THEN THE ADMISSIONS WITH $CURB AMONG THEM. Writes $CURB's
    /// token and curve into `d` and returns the factories, by list index.
    ///
    /// ONE STACK PER QUOTE ASSET. The escrow refuses every token but its own,
    /// the policy names one escrow and the factory's asset is immutable, so
    /// these four go together and there is one set per asset. Everything
    /// deploy() sends before this is shared and deployed once.
    ///
    /// EVERY STACK IS BUILT BEFORE ANY IS ADMITTED. A factory's constructor
    /// asks nothing of the registry, so an unadmitted factory is complete and
    /// inert: launch() refuses until the registry lists it. THEN IN
    /// admissionOrder: WETH's factory wire()d, the run's first admission, with
    /// nothing between it and $CURB's launch - the dev buy is wrapped and
    /// approved before it - and every other factory added only after $CURB
    /// (FirstLaunch says why). The wire() fixes the hook; the rest are
    /// admitted against it, through the same loop check.
    function _stacksThenCurb(Shared memory s, Plan memory p, Deployed memory d)
        internal
        returns (address[] memory factories)
    {
        factories = new address[](p.assets.length);
        for (uint256 i = 0; i < p.assets.length; i++) {
            factories[i] = _deployAssetStack(s.registry, s.graduator, s.hook, p.platform, p.deployer, p.assets[i]);
        }
        uint256[] memory order = admissionOrder(p.assets);
        if (p.first.on) _fundFirst(factories[order[0]], p.first);
        s.registry.wire(factories[order[0]], address(s.hook));
        // $CURB, THE FIRST LAUNCH, ON THE WETH FACTORY, in the transaction
        // after that factory's admission. order[0] is the WETH factory whenever
        // the first launch is on: deploy() refuses a list without WETH then.
        if (p.first.on) (d.firstToken, d.firstCurve) = _launchFirst(s, factories[order[0]], p.first);
        for (uint256 k = 1; k < order.length; k++) {
            s.registry.addLauncher(factories[order[k]]);
        }
    }

    /// ONE ASSET'S STACK. Deployed per quote asset because the escrow refuses
    /// every token but its own, the policy names one escrow, and the factory's
    /// asset and terms are immutable. Everything the registry, graduator, hook
    /// and lens do is shared and happens once, in run().
    ///
    /// THE CROSS-CHECKS RUN FOR EVERY ASSET, not just the first. They are what
    /// catches a deployment whose two sources of one set of terms have come
    /// apart, and a second factory is exactly where that could newly happen.
    function _deployAssetStack(
        LaunchRegistry registry,
        Graduator graduator,
        FeeHook hook,
        address platform,
        address vaultOwner,
        Asset memory asset
    ) internal returns (address) {
        // A MISTYPED ADDRESS OTHERWISE DEPLOYS A WHOLE STACK AROUND NOTHING,
        // and the first sign of it is a launch nobody can buy into. decimals()
        // is the cheapest question only a real token answers.
        (bool live, bytes memory dec) = asset.quote.staticcall(abi.encodeWithSignature("decimals()"));
        require(live && dec.length == 32, string.concat(asset.label, ": no token answers at that address"));
        require(asset.threshold > 0, string.concat(asset.label, ": the threshold is zero"));

        FeeEscrow escrow = new FeeEscrow(asset.quote);

        // THREE ARGUMENTS, BECAUSE THREE IS WHAT A DEPLOYMENT DECIDES. The
        // share, the buyback burn, the hook's unused rate and the sweep
        // operator are constants inside FeePolicy - they are what the product
        // IS, not what this deployment picks - so there is nothing here to get
        // wrong about them and nothing to compare afterwards.
        FeePolicy policy =
            new FeePolicy(platform, IPonsV2FeeEscrow(address(escrow)), MAX_INTERNAL_PRICE_IMPACT_BPS);
        PonsV2BuybackVault vault =
            new PonsV2BuybackVault(vaultOwner, IPonsV2FeePolicy(address(policy)), IPonsV2FeeEscrow(address(escrow)));

        // EVERY TERM A CALLER COULD ABUSE IS FIXED HERE, not at launch.
        // launch() is open to anyone, so the supply, the curve's shape, the
        // lock, the pool and the hook are decided once, in this constructor.
        // WHO THE PLATFORM PAYS IS NOT: launch() reads the share and recipient
        // off the hook and freezes them into each launch's record.
        //
        // THE SHAPE IS THE SAME FOR EVERY ASSET - start about $4K, graduate
        // about $55K, r = phantom/(phantom+threshold) about 0.27 - and what
        // differs per asset is only the UNIT it is written in. See quoteAssets.
        CurbLaunchFactory factory = new CurbLaunchFactory(
            registry,
            graduator,
            asset.quote,
            IPonsV2FeePolicy(address(policy)),
            IPonsV2FeeEscrow(address(escrow)),
            vault,
            CurbLaunchFactory.Terms({
                supply: SUPPLY,
                quoteDecimals: asset.decimals,
                phantomQuote: asset.phantomQuote,
                graduationThreshold: asset.threshold,
                poolFee: POOL_FEE,
                tickSpacing: TICK_SPACING,
                hooks: IHooks(address(hook)),
                protocolFeeRecipient: platform,
                maxInternalPriceImpactBps: MAX_INTERNAL_PRICE_IMPACT_BPS,
            // LAUNCHING COSTS GAS ONLY. The factory can still charge a fee,
            // and refuses any ether when it is zero; this deployment charges
            // none on any factory.
            launchFee: 0
            })
        );

        // THE TWO SOURCES OF ONE SET OF TERMS, CHECKED AGAINST EACH OTHER.
        // The policy publishes them; the factory writes them into each launch -
        // all but the platform recipient, which launch() reads off the hook.
        // The recipient comparison below is therefore between two published
        // copies AT DEPLOYMENT, not between what the curve and the pool will
        // pay: those agree by construction, from the same hook read.
        require(
            policy.protocolFeeRecipient() == factory.protocolFeeRecipient(),
            "the policy and the factory publish different platform recipients at deployment"
        );
        require(
            policy.protocolFeeShareBps() == factory.PROTOCOL_FEE_SHARE_BPS(),
            "the policy and the factory disagree on the protocol share"
        );
        require(
            policy.maxInternalPriceImpactBps() == factory.maxInternalPriceImpactBps(),
            "the policy and the factory disagree on the price-impact ceiling"
        );
        require(address(policy.feeEscrow()) == address(escrow), "the policy points at another escrow");
        // AND THE ESCROW MUST BE THE ONE FOR THIS ASSET. A second asset makes
        // this newly possible to get wrong: an escrow built for another token
        // would refuse every credit this factory's launches ever make, and the
        // failure would arrive at the first sweep rather than here.
        require(escrow.quoteToken() == asset.quote, "the escrow is for another asset");
        require(factory.quoteToken() == asset.quote, "the factory is for another asset");

        // A SANITY CHECK ON TWO PUBLISHED COPIES, AT DEPLOYMENT - nothing more.
        // What the curve and the pool of a launch pay is decided by launch()
        // reading the hook once and writing the record both of them charge;
        // the factory's copy is never read by launch(). This used to be
        // captioned as the guarantee that the two places a trader is charged
        // pay the same person, which it is not.
        require(
            hook.platformRecipient() == factory.protocolFeeRecipient(),
            "the hook and the factory name different platform recipients at deployment"
        );
        return address(factory);
    }

}
