#!/usr/bin/env bash
# Puts the stack on the pinned fork and funds the demo account, so web/app.html
# has a chain to work against. It does NOT create a launch: creating one is the
# first thing the demo is meant to show.
#
# It prints the addresses the page needs, and reads every one of them back out
# of the chain first. A second deployment onto the same node moves the sender's
# nonce and every address with it, so a value copied from an earlier run points
# at nothing - that has happened here, and cost a session.
set -euo pipefail
cd "$(dirname "$0")/../.."

RPC="${RPC:-http://127.0.0.1:8546}"
# ACCOUNT 0. launch() is open to anyone now, so this is no longer forced - but
# the deployment's sender is the account funded with NVDAc and is the protocol's
# fee recipient, so the page uses it to keep one funded identity across the
# demo. Any other account could create a launch here.
SENDER="${SENDER:-0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266}"
# ACCOUNT 1, AND A DIFFERENT ONE ON PURPOSE. The deployer is also the fee
# hook's fee recipient, so a trade made from it lands the swap output and the
# hook's fee in the same balance and the two cannot be told apart - which is
# exactly what made a first reading of the pool quote look wrong. Trading from
# an account that collects no fees keeps the measurement clean, and it shows
# that trading needs no privilege of any kind.
TRADER="${TRADER:-0x70997970c51812dc3a010c7d01b50e0d17dc79c8}"
NVDAC=0xb20000000000000000000078ee7ce2fE4908108C
WHALE=0x853F5f1B92b16714Fe6CDA67CAad0856B83C7ab9
# 2,000 NVDAc: enough to take a 50-threshold launch past graduation several
# times over and still have a balance to trade the pool with.
FUND="${FUND:-200000000000}"
# A LOG OF ITS OWN FOR EACH RUN. It was one fixed /tmp path, and two runs at
# once - a test run and a mutation run in another checkout - wrote into the
# same file; the address grep below then read the other run's deployment, or
# a half-written file ("binary file matches"), and the setup failed.
OUT=${OUT:-$(mktemp /tmp/curb-demo-app.XXXXXX)}

die() { echo "FAIL: $*" >&2; exit 1; }
field() { grep -m1 "^  $1" "$OUT" | grep -oE '0x[0-9a-fA-F]{40}' | head -1; }
has_code() { [ "$(base-cast codesize "$1" --rpc-url "$RPC")" -gt 0 ]; }

export PATH="$HOME/.foundry/bin:$PATH"

# Same reasoning as demo-waiting.sh: answering is not evidence of being the
# pinned fork, and the node verified must be the node deployed to.
bash "$(dirname "$0")/verify-fork.sh" --rpc "$RPC" --identity >/dev/null \
  || { bash "$(dirname "$0")/verify-fork.sh" --rpc "$RPC" --identity || true; die "the node is not the pinned fork"; }

echo "deploying..."
# THE PLATFORM'S FEE RECIPIENT IS SET HERE, DELIBERATELY. DeployCurb requires
# it rather than defaulting to the deployer: every launch freezes the recipient
# in force into its own record, so a deployment that guessed it leaves those
# launches paying the guess for good (the hook's own copy can be moved later,
# for later launches only). This is TEST CONFIGURATION - anvil's own account,
# one key, as recipient and as policy owner - written where a reader can see
# it, with the opt-ins DeployCurb refuses to run without.
#
# FOUNDRY_BROADCAST=broadcast/local, BECAUSE THIS NODE SERVES CHAIN 8453. forge
# files a broadcast under broadcast/<script>/<chain id>/, and 8453 is where the
# mainnet run records itself - the preflight refuses to find a run there. The
# browser suite runs this script, so the runbook's own STEP 1 used to fill that
# directory and trip the gate of STEP 2 every time.
#
# THE HOLDER SHARING ROLES ARE NAMED HERE TOO, as a real deployment names them
# (DeployCurb would fill a demo's with the deployer): anvil's accounts 5, 6
# and 7, none of them the deployer or the trader, so a keeper rehearsal on this
# node publishes with a key it holds. Test configuration, like the rest.
SHARING_PUBLISHER="${SHARING_PUBLISHER:-0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc}"
SHARING_KEEPER_PAYEE="${SHARING_KEEPER_PAYEE:-0x976EA74026E726554dB657fA54763abd0C3a0aa9}"
SHARING_VETOER="${SHARING_VETOER:-0x14dC79964da2C08b23698B3D3cc7Ca32193d9955}"
FOUNDRY_BROADCAST=broadcast/local CURB_DEMO_LAUNCH=true CURB_ALLOW_EOA_RECIPIENT=true CURB_ALLOW_EOA_POLICY_OWNER=true CURB_ALLOW_SAME_RECIPIENT_AND_OWNER=true CURB_PLATFORM_RECIPIENT="$SENDER" CURB_SHARING_PUBLISHER="$SHARING_PUBLISHER" CURB_SHARING_KEEPER_PAYEE="$SHARING_KEEPER_PAYEE" CURB_SHARING_VETOERS="$SHARING_VETOER" base-forge script script/DeployCurb.s.sol --rpc-url "$RPC" --broadcast --unlocked --sender "$SENDER" > "$OUT" 2>&1 \
  || { tail -30 "$OUT"; die "the deployment did not run"; }
grep -q "ONCHAIN EXECUTION COMPLETE" "$OUT" || { tail -30 "$OUT"; die "the deployment did not complete"; }

FACTORY=$(field "CurbLaunchFactory")
LENS=$(field "LaunchLens")
GRADUATOR=$(field "Graduator")
HOOK=$(field "FeeHook")
CATALOG=$(field "SharingCatalog")
DISTRIBUTOR_FACTORY=$(field "HolderDistributorFactory")
for n in FACTORY LENS GRADUATOR HOOK CATALOG DISTRIBUTOR_FACTORY; do
  v=${!n}
  [ -n "$v" ] || die "could not read $n out of the deployment output"
  has_code "$v" || die "$n $v has no code on $RPC"
done
# THE ROLES AS THEY LANDED, against the ones passed above. The policy owner
# (the deployer, here) is a vetoer as well as the one named.
bash "$(dirname "$0")/check-sharing.sh" "$RPC" "$GRADUATOR" "$CATALOG" "$DISTRIBUTOR_FACTORY" \
  "$SHARING_PUBLISHER" "$SHARING_KEEPER_PAYEE" "$SHARING_VETOER" "$SENDER" \
  || die "the holder sharing contracts are not what this script asked for"

echo "funding ${SENDER} and ${TRADER}..."
base-cast rpc anvil_setBalance "$WHALE" 0xde0b6b3a7640000 --rpc-url "$RPC" > /dev/null
base-cast rpc anvil_impersonateAccount "$WHALE" --rpc-url "$RPC" > /dev/null
base-cast send "$NVDAC" "transfer(address,uint256)" "$SENDER" "$FUND" --from "$WHALE" --unlocked --rpc-url "$RPC" > /dev/null
base-cast send "$NVDAC" "transfer(address,uint256)" "$TRADER" "$FUND" --from "$WHALE" --unlocked --rpc-url "$RPC" > /dev/null
base-cast rpc anvil_stopImpersonatingAccount "$WHALE" --rpc-url "$RPC" > /dev/null

# WETH TOO, BECAUSE ETH IS THE PRIMARY PAIR AND NOTHING TESTED IT.
#
# The browser suite could only ever reach an equity-quoted launch, so the pair
# this product puts first - and the wrap-only route that serves it - had no
# coverage at all. The holder is the WETH/USDC 0.3%% pool, borrowed from as a
# balance; nothing here trades against it.
WETH_TOKEN=0x4200000000000000000000000000000000000006
WETH_HOLDER=0x6c561B446416E1A00E8E93E221854d6eA4171372
WETH_FUND="${WETH_FUND:-40000000000000000000}"
base-cast rpc anvil_setBalance "$WETH_HOLDER" 0xde0b6b3a7640000 --rpc-url "$RPC" > /dev/null
base-cast rpc anvil_impersonateAccount "$WETH_HOLDER" --rpc-url "$RPC" > /dev/null
base-cast send "$WETH_TOKEN" "transfer(address,uint256)" "$SENDER" "$WETH_FUND" --from "$WETH_HOLDER" --unlocked --rpc-url "$RPC" > /dev/null
base-cast send "$WETH_TOKEN" "transfer(address,uint256)" "$TRADER" "$WETH_FUND" --from "$WETH_HOLDER" --unlocked --rpc-url "$RPC" > /dev/null
base-cast rpc anvil_stopImpersonatingAccount "$WETH_HOLDER" --rpc-url "$RPC" > /dev/null

BAL=$(base-cast call "$NVDAC" "balanceOf(address)(uint256)" "$SENDER" --rpc-url "$RPC" | awk '{print $1}')
TBAL=$(base-cast call "$NVDAC" "balanceOf(address)(uint256)" "$TRADER" --rpc-url "$RPC" | awk '{print $1}')
[ "$BAL" -ge "$FUND" ] || die "the deployer account holds $BAL, expected at least $FUND"
[ "$TBAL" -ge "$FUND" ] || die "the trader account holds $TBAL, expected at least $FUND"

echo
echo "READY. Open:"
echo "  http://127.0.0.1:8777/app.html?factory=$FACTORY&lens=$LENS&rpc=$RPC"
echo
echo "  rpc       $RPC"
echo "  factory   $FACTORY"
echo "  lens      $LENS"
echo "  graduator $GRADUATOR"
echo "  hook      $HOOK"
echo "  catalog   $CATALOG"
echo "  sharing   $DISTRIBUTOR_FACTORY"
echo "  publisher $SHARING_PUBLISHER"
echo "  deployer  $SENDER   ($BAL raw NVDAc) - collects the protocol and hook fees"
echo "  trader    $TRADER   ($TBAL raw NVDAc) - no privileges, collects nothing"
