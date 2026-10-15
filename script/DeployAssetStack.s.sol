// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {console} from "forge-std/Script.sol";

import {DeployCurb} from "./DeployCurb.s.sol";
import {LaunchRegistry} from "../src/curb/LaunchRegistry.sol";
import {Graduator} from "../src/curb/Graduator.sol";
import {FeeHook} from "../src/curb/FeeHook.sol";
import {FeeEscrow} from "../src/curb/FeeEscrow.sol";
import {FeePolicy} from "../src/curb/FeePolicy.sol";
import {CurbLaunchFactory} from "../src/curb/CurbLaunchFactory.sol";

/**
 * @title DeployAssetStack
 * @notice ONE MORE QUOTE ASSET, AFTER LAUNCH: its escrow, fee policy, buyback
 *         vault and factory, built against the LIVE registry, Graduator and
 *         hook - and the policy Safe's addLauncher call, printed for it to sign.
 *
 *   CURB_DEPLOYER=<the deployer> CURB_REGISTRY=<the live LaunchRegistry> \
 *   CURB_WALLET_OPTION=<one wallet option> \
 *     bash script/b20/preflight-mainnet.sh --asset <a label in DeployCurb.quoteAssets()>
 *
 *   (DEPLOY.txt, ADDING A QUOTE ASSET AFTER LAUNCH, step 2.) THE PREFLIGHT
 *   PRINTS THE COMMAND THAT RUNS THIS, and it is the only way this is run on
 *   Base: it asks the full run's section 1 in the shell that signs - the tree
 *   hashed against its commit, no FOUNDRY_*, ETH_* or VERIFIER_* setting -
 *   simulates this against live Base, prices the asset's start and graduation
 *   at Chainlink's answer (within 5% of $4,000 and $55,000, as the full run's
 *   section 6), checks the funding, and prints the Safe's call with those
 *   dollars beside it. The command used to be typed by hand from here, with
 *   none of that: a stale or uncommitted price passed every automated check,
 *   and the Safe's signers saw only addLauncher(<address>). --verify needs the
 *   explorer key, read in with read -rs BASESCAN_API_KEY as for the full run.
 *
 * WHY A SCRIPT. A factory's asset, phantom, threshold, decimals, pool and hook
 * are immutable, a launcher once admitted can never be removed, and the
 * registry holds at most 32 (LaunchRegistry.MAX_LAUNCHERS). A stack built by
 * hand with one wrong immutable is permanent the moment the Safe admits it, and
 * uses a slot for good. This builds it with DeployCurb's own _deployAssetStack -
 * the same constructor arguments and the same cross-checks the full run makes -
 * against the contracts already on chain, read off the chain rather than typed:
 * the hook is the registry's requiredHook(), the Graduator is the hook's
 * poolOpener(), and each is asked to point back at the registry.
 *
 * THE ASSET COMES FROM DeployCurb.quoteAssets(), BY LABEL, so the list stays
 * the one place an asset's terms are written and the address book and
 * check-deployment.sh can keep reading them there. Adding one is a commit of
 * its own BEFORE this runs: the line in quoteAssets() (priced as that function
 * says, at the day's prices), its fixture in B20MultiAsset, its row in the docs
 * table. This refuses a label the list does not hold, and an asset the
 * registry already has a factory for.
 *
 * IT ADMITS NOTHING. The registry's owner is the policy Safe once it has
 * accepted the handover, and only the owner admits. What this prints is the
 * Safe's transaction - to the registry, value 0, data addLauncher(<factory>) -
 * after showing, in the simulation and as the owner, that the call would pass
 * the registry's own loop check against the stack just built. The registry is
 * not touched outside the simulation.
 *
 * ITS CHECKS ARE THE FULL RUN'S, against the chain it runs on: the five
 * unchanged contracts' code identities (requireUnchangedCode), and the file's
 * depth claim for the asset (requireDepthMatchesClaim) - never skipped, since
 * there is no demo here.
 *
 * AFTER THE BROADCAST, before the Safe signs: verify the four contracts on the
 * explorer (--verify does it), run size-gate.sh --deployed on the escrow, the
 * policy and the vault, bump the holder-sharing rules version with the new
 * factory, escrow, policy and vault excluded and the asset's feeds added
 * (RUNBOOK part 7), and record the factory in web/config.js factories and the
 * docs table. The Safe's addLauncher is the last step: from that moment the
 * site can offer the asset.
 *
 * AFTER addLauncher: check-deployment.sh <rpc> deployments/base-mainnet/run.json
 * deployments/base-mainnet/asset-<label>.json --accepted (DEPLOY.txt ADDING A
 * QUOTE ASSET step 7). Not before it: the check expects one launcher per stack
 * in the records, so until the Safe admits the factory it fails on
 * registry.launcherCount(), one short.
 */
contract DeployAssetStack is DeployCurb {
    /// WHAT THE LAST run() BUILT AND WHAT THE SAFE IS TO SEND, kept for a test
    /// to read; a broadcast has no use for them.
    address public builtFactory;
    bytes public safeCalldata;

    function run() external override {
        // THE ONLY VARIABLES READ, and no other script reads them.
        // HELD TO ITS EIP-55 CHECKSUM when written in mixed case
        // (DeployCurb.envAddressChecked).
        LaunchRegistry registry = LaunchRegistry(envAddressChecked("CURB_REGISTRY"));
        string memory label = vm.envString("CURB_ASSET_LABEL");
        (builtFactory, safeCalldata) = admit(registry, label, msg.sender);
    }

    /// THE ASSET, BY LABEL, FROM THE ONE LIST.
    function assetNamed(string memory label) internal pure returns (Asset memory) {
        Asset[] memory list = quoteAssets();
        for (uint256 i = 0; i < list.length; i++) {
            if (keccak256(bytes(list[i].label)) == keccak256(bytes(label))) return list[i];
        }
        revert(
            string.concat(
                "CURB_ASSET_LABEL '",
                label,
                "' names no asset in DeployCurb.quoteAssets(). Add it there first, in a commit of its own."
            )
        );
    }

    /// THE LIVE CONTRACTS THE STACK IS BUILT AGAINST, read off the chain and
    /// asked to point back at each other - the loop the registry checks again
    /// when the Safe admits the factory, asked here before anything is sent.
    function liveWiring(LaunchRegistry registry) internal view returns (Graduator graduator, FeeHook hook) {
        require(address(registry).code.length != 0, "CURB_REGISTRY has no code on this chain");
        require(registry.wired(), "the registry was never wired: this is not a finished deployment");
        hook = FeeHook(payable(registry.requiredHook()));
        graduator = Graduator(hook.poolOpener());
        require(address(hook.registry()) == address(registry), "the registry's hook reads another registry");
        require(address(graduator.registry()) == address(registry), "the hook's Graduator reads another registry");
        // A HANDOVER IN FLIGHT IS FINISHED FIRST. While an offer stands, who
        // admits is about to change, and the call printed below is the Safe's.
        require(
            registry.pendingOwner() == address(0),
            "the registry's handover is still pending: the policy Safe accepts it (acceptOwnership) before an asset is added"
        );
    }

    /// NO SECOND FACTORY FOR AN ASSET, AND ROOM FOR ONE MORE.
    function requireRoomFor(LaunchRegistry registry, address quote) internal view {
        uint256 n = registry.launcherCount();
        require(n < registry.MAX_LAUNCHERS(), "the registry is full: MAX_LAUNCHERS launchers are admitted");
        for (uint256 i = 0; i < n; i++) {
            (bool ok, bytes memory raw) = registry.launcherAt(i).staticcall(abi.encodeWithSignature("quoteToken()"));
            require(
                !(ok && raw.length == 32 && abi.decode(raw, (address)) == quote),
                "the registry already admits a factory for this asset"
            );
        }
    }

    /// THE STACK, READ BACK OFF THE FACTORY THIS RUN BUILT: every term it will
    /// write into a launch, against the list, and every link against the live
    /// contracts.
    function requireStackMatches(
        CurbLaunchFactory factory,
        Asset memory asset,
        LaunchRegistry registry,
        Graduator graduator,
        FeeHook hook,
        address vaultOwner
    ) internal view {
        require(factory.quoteToken() == asset.quote, "the factory is for another asset");
        require(factory.declaredQuoteDecimals() == asset.decimals, "the factory declares other decimals");
        require(factory.phantomQuote() == asset.phantomQuote, "the factory's phantom is not the list's");
        require(factory.graduationThreshold() == asset.threshold, "the factory's threshold is not the list's");
        require(factory.supply() == SUPPLY, "the factory's supply is not the product's");
        require(factory.poolFee() == POOL_FEE && factory.tickSpacing() == TICK_SPACING, "the factory's pool is not the product's");
        require(factory.launchFee() == 0, "the factory charges a launch fee");
        require(address(factory.hooks()) == address(hook), "the factory names another hook");
        require(address(factory.registry()) == address(registry), "the factory reads another registry");
        require(address(factory.graduator()) == address(graduator), "the factory reads another Graduator");
        require(FeeEscrow(payable(address(factory.feeEscrow()))).quoteToken() == asset.quote, "the escrow is for another asset");
        require(
            address(FeePolicy(address(factory.feePolicy())).feeEscrow()) == address(factory.feeEscrow()),
            "the policy names another escrow"
        );
        require(factory.buybackVault().owner() == vaultOwner, "the buyback vault's owner is not the deployer");
    }

    /// EVERYTHING ABOVE, IN ORDER, AND THE SAFE'S CALL. Returns the factory
    /// built and the calldata the Safe sends to the registry.
    function admit(LaunchRegistry registry, string memory label, address deployer)
        internal
        returns (address factory, bytes memory data)
    {
        Asset memory asset = assetNamed(label);
        (Graduator graduator, FeeHook hook) = liveWiring(registry);
        requireRoomFor(registry, asset.quote);
        requireUnchangedCode();
        requireDepthMatchesClaim(asset, false);

        // WHO THE PLATFORM PAYS IS THE HOOK'S, NOW: _deployAssetStack checks
        // the factory against it. A change already announced lands for new
        // launches on every factory alike; said here so it is not a surprise.
        address platform = hook.platformRecipient();
        if (hook.pendingRecipient() != address(0)) {
            console.log("NOTE: the hook has a platform recipient change pending:", hook.pendingRecipient());
        }

        vm.startBroadcast();
        factory = _deployAssetStack(registry, graduator, hook, platform, deployer, asset);
        vm.stopBroadcast();

        requireStackMatches(CurbLaunchFactory(factory), asset, registry, graduator, hook, deployer);
        data = abi.encodeCall(LaunchRegistry.addLauncher, (factory));

        // THE SAFE'S CALL, MADE IN THE SIMULATION AS THE OWNER AND UNDONE: the
        // registry's loop check passes against this stack, or nothing is
        // printed for anyone to sign.
        address owner_ = registry.owner();
        uint256 before = registry.launcherCount();
        uint256 snap = vm.snapshotState();
        vm.prank(owner_);
        (bool ok, bytes memory why) = address(registry).call(data);
        require(ok && registry.isLauncher(factory) && registry.launcherCount() == before + 1, _whyNot(why));
        vm.revertToState(snap);
        require(!registry.isLauncher(factory), "the simulated admission was not undone");

        console.log("");
        console.log("=== a new quote asset, built against the live deployment ===");
        console.log("chain id        ", block.chainid);
        console.log("asset           ", asset.label, asset.quote);
        console.log("phantom, threshold", asset.phantomQuote, asset.threshold);
        // THE TERMS AS THE FULL RUN PRINTS THEM (logTerms), read back off the
        // factory just built: the preflight's --asset mode prices them at
        // Chainlink's answer and prints the dollars beside the Safe's call.
        Asset[] memory built = new Asset[](1);
        built[0] = Asset(
            asset.quote,
            asset.label,
            CurbLaunchFactory(factory).phantomQuote(),
            CurbLaunchFactory(factory).graduationThreshold(),
            asset.fillable,
            asset.decimals
        );
        logTerms(built);
        console.log("LaunchRegistry  ", address(registry));
        console.log("Graduator       ", address(graduator));
        console.log("FeeHook         ", address(hook));
        console.log("   CurbLaunchFactory ", factory);
        console.log("   FeeEscrow         ", address(CurbLaunchFactory(factory).feeEscrow()));
        console.log("   FeePolicy         ", address(CurbLaunchFactory(factory).feePolicy()));
        console.log("   PonsV2BuybackVault", address(CurbLaunchFactory(factory).buybackVault()));
        console.log("");
        console.log("NOTHING IS ADMITTED YET. The registry's owner sends, last of all:");
        console.log("   owner", owner_);
        console.log("   to   ", address(registry));
        console.log("   value 0");
        console.log("   data ", vm.toString(data));
        if (owner_.code.length == 0) {
            console.log("WARNING: the registry's owner is one key, not the policy Safe. DEPLOY.txt hands it to the Safe.");
        }
        console.log("Before it does: verify the four contracts, size-gate.sh --deployed on the escrow, policy and");
        console.log("vault, the sharing rules bump (exclusions and feeds), web/config.js factories and the docs");
        console.log("table. From addLauncher on, the site can offer the asset.");
        console.log("After addLauncher: check-deployment.sh <rpc> deployments/base-mainnet/run.json");
        console.log(
            string.concat(
                "   deployments/base-mainnet/asset-", asset.label, ".json --accepted (DEPLOY.txt ADDING A QUOTE ASSET"
            )
        );
        console.log("   step 7; before it, the check fails on registry.launcherCount()).");
    }

    /// The registry's refusal, as text where it is an Error(string), and its
    /// raw bytes otherwise.
    function _whyNot(bytes memory why) private pure returns (string memory) {
        return string.concat("the registry would refuse the Safe's addLauncher: ", vm.toString(why));
    }
}
