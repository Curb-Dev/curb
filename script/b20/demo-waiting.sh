#!/usr/bin/env bash
# Deploys the stack to the local fork and drives the demo launch into the
# WAITING state, then prints the addresses web/tests.html needs.
#
# EVERY ADDRESS IS READ BACK FROM THE CHAIN, NEVER ASSUMED. Deploying a second
# time onto the same node gives entirely different addresses - the sender's
# nonce moved - so a value copied from an earlier run points at nothing. That
# happened, and cost a debugging session; hence the codesize check below.
#
# The waiting state is reached by A REAL FAILED ATTEMPT, with NOTHING INJECTED:
# the crossing buy is sent on a tight limit, the curve catches its own failed
# attempt and the buy stands. The curve keeps no reason for that failure - its
# catch takes no data - so the event and the receipt say an attempt failed and
# not why. The check below is on the STATE that results, which is what the page
# reads.
set -euo pipefail

cd "$(dirname "$0")/../.."
export PATH="$HOME/.foundry/bin:$PATH"

RPC="${RPC:-http://127.0.0.1:8546}"
SENDER="${SENDER:-0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266}"
BUYER="${BUYER:-0x70997970c51812dc3a010c7d01b50e0d17dc79c8}"
NVDAC=0xb20000000000000000000078ee7ce2fE4908108C
WHALE=0x853F5f1B92b16714Fe6CDA67CAad0856B83C7ab9
MAXU=115792089237316195423570985008687907853269984665640564039457584007913129639935
# A LOG OF ITS OWN FOR EACH RUN. It was one fixed /tmp path, and two runs at
# once - a test run and a mutation run in another checkout - wrote into the
# same file; the address grep below then read the other run's deployment, or
# a half-written file ("binary file matches"), and the setup failed.
OUT=${OUT:-$(mktemp /tmp/curb-deploy.XXXXXX)}

die() { echo "FAIL: $*" >&2; exit 1; }
field() { grep -m1 "^  $1" "$OUT" | grep -oE '0x[0-9a-fA-F]{40}' | head -1; }
has_code() { [ "$(base-cast codesize "$1" --rpc-url "$RPC")" -gt 0 ]; }

# THE NODE HAS TO BE THE PINNED FORK, AND ANSWERING IS NOT EVIDENCE OF THAT.
# A node forked from any other block answers block-number perfectly well, and
# every value measured downstream would then be about a chain nobody chose.
# verify-fork.sh reads the node's OWN fork metadata - origin chain, fork block
# AND fork block hash - and fails if any of it is not what is pinned here.
#
# IT DOES NOT REQUIRE A FRESH NODE, on purpose. This script deploys its own
# stack, so it works at any height at or above the fork block; demanding an
# untouched node would reject the correct node the moment anything had been
# sent to it. Set REQUIRE_FRESH=1 when the caller does need one - the Solidity
# fork tests do, because they assert on constants measured from the starting
# state.
# == 1, not "is set". ${REQUIRE_FRESH:+--fresh} turned REQUIRE_FRESH=0 into a
# demand for a fresh node, which is the opposite of what setting it to 0 means.
if [ "${REQUIRE_FRESH:-0}" = "1" ]; then MODE=--fresh; else MODE=--identity; fi

# --rpc "$RPC": THE NODE THAT IS VERIFIED MUST BE THE NODE THAT IS DEPLOYED TO.
# Without it the verifier read FORK_RPC out of env.sh - always 127.0.0.1:8546 -
# so pointing RPC at another node checked one and deployed to the other.
bash "$(dirname "$0")/verify-fork.sh" --rpc "$RPC" "$MODE" || die "the node is not the pinned fork"

# Verify and stop. Lets the gate's own behaviour be tested - which node it
# checks, which mode it picks - without a deployment as the price of asking.
if [ "${CHECK_ONLY:-0}" = "1" ]; then
  echo "node verified; CHECK_ONLY is set, so nothing was deployed"
  exit 0
fi

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
FOUNDRY_BROADCAST=broadcast/local CURB_DEMO_LAUNCH=true CURB_ALLOW_EOA_RECIPIENT=true CURB_ALLOW_EOA_POLICY_OWNER=true CURB_ALLOW_SAME_RECIPIENT_AND_OWNER=true CURB_PLATFORM_RECIPIENT="$SENDER" base-forge script script/DeployCurb.s.sol --rpc-url "$RPC" --broadcast --unlocked --sender "$SENDER" > "$OUT" 2>&1 \
  || { tail -30 "$OUT"; die "the deployment did not run"; }
grep -q "ONCHAIN EXECUTION COMPLETE" "$OUT" || { tail -30 "$OUT"; die "the deployment did not complete"; }

LENS=$(field "LaunchLens")
GRADUATOR=$(field "Graduator")
# Reported because the tests need a SECOND deployment to compare against: a
# stale cached value and a freshly read one are only distinguishable when the
# two deployments actually differ.
FACTORY=$(field "CurbLaunchFactory")
TOKEN=$(field "demo launch token")
CURVE=$(field "demo curve")
CATALOG=$(field "SharingCatalog")
DISTRIBUTOR_FACTORY=$(field "HolderDistributorFactory")
for n in LENS GRADUATOR TOKEN CURVE FACTORY CATALOG DISTRIBUTOR_FACTORY; do
  v=${!n}
  [ -n "$v" ] || die "could not read $n out of the deployment output"
  # The printed address is the simulation's. Proving there is code at it on the
  # node is what makes it the deployed one.
  has_code "$v" || die "$n $v has no code on $RPC - the run did not land where it said"
done
# NO SHARING ROLE WAS NAMED ABOVE, so this deployment is the one that shows a
# demo's defaults: the deployer publishes and is paid the keeper's fee, and the
# policy owner - the deployer again - is the only vetoer. demo-app.sh names
# all three instead.
bash "$(dirname "$0")/check-sharing.sh" "$RPC" "$GRADUATOR" "$CATALOG" "$DISTRIBUTOR_FACTORY" \
  "$SENDER" "$SENDER" "$SENDER" \
  || die "the holder sharing contracts are not a demo's defaults"

echo "funding the buyer..."
base-cast rpc anvil_setBalance "$WHALE" 0xde0b6b3a7640000 --rpc-url "$RPC" >/dev/null
base-cast rpc anvil_impersonateAccount "$WHALE" --rpc-url "$RPC" >/dev/null
base-cast send "$NVDAC" "transfer(address,uint256)" "$BUYER" 6600000000 --from "$WHALE" --unlocked --rpc-url "$RPC" >/dev/null
base-cast rpc anvil_stopImpersonatingAccount "$WHALE" --rpc-url "$RPC" >/dev/null
base-cast send "$NVDAC" "approve(address,uint256)" "$CURVE" "$MAXU" --from "$BUYER" --unlocked --rpc-url "$RPC" >/dev/null

echo "crossing the threshold on a tight gas limit..."
base-cast send "$CURVE" "buy(uint256,uint256,address)" 6600000000 0 "$BUYER" \
  --from "$BUYER" --unlocked --gas-limit 900000 --rpc-url "$RPC" >/dev/null

READY=$(base-cast call "$CURVE" "readyToGraduate()(bool)" --rpc-url "$RPC")
GRADUATED=$(base-cast call "$CURVE" "graduated()(bool)" --rpc-url "$RPC")
[ "$READY" = "true" ] || die "the curve is not ready (ready=$READY graduated=$GRADUATED)"
[ "$GRADUATED" = "false" ] || die "it graduated anyway - the gas limit was not tight enough"
# 2 = Waiting, as LaunchLens reports it. The page reads this, so this is the
# value that has to be right, not the curve's two booleans.
STATUS=$(base-cast call "$LENS" "launchState(address)" "$TOKEN" --rpc-url "$RPC" | cut -c 3-66 | tail -c 3)
echo "the lens reports status word $STATUS (expect 02 = Waiting)"

echo
echo "WAITING. Open:"
echo "  http://127.0.0.1:8777/tests.html?lens=$LENS&token=$TOKEN&rpc=$RPC&auto=1"
echo
echo "  rpc       $RPC"
echo "  lens      $LENS"
echo "  factory   $FACTORY"
echo "  graduator $GRADUATOR"
echo "  token     $TOKEN"
echo "  curve     $CURVE"
echo "  catalog   $CATALOG"
echo "  sharing   $DISTRIBUTOR_FACTORY"
