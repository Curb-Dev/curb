#!/usr/bin/env bash
# Puts the CURB router on a fork of Base, through the same script the real
# deployment uses (script/DeployRouter.s.sol), and prints where it landed.
#
# WHY THE SCRIPT AND NOT anvil_setCode. The script deploys through the
# deterministic proxy with CREATE2 and refuses to broadcast when the router as
# built would land anywhere but EXPECTED_ROUTER or hash to anything but
# EXPECTED_RUNTIME_CODEHASH - so a fork prepared this way proves the address and
# the code hash the page pins (web/app.js CURB_ROUTER), instead of assuming them.
#
# NEVER ONTO THE SUITE'S PINNED NODE OR A WALLET'S FORK: a broadcast mines a
# block. The browser suite runs it against the node of its own run.
set -euo pipefail
cd "$(dirname "$0")/../.."

RPC="${RPC:?RPC must name the node to deploy to}"
# ANVIL'S ACCOUNT 8, NOT 0. The demo scripts deploy the stacks from account 0;
# the router's address does not depend on its sender at all, so a sender of its
# own keeps every nonce the other scripts rely on where it was.
SENDER="${ROUTER_SENDER:-0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f}"
OUT=${OUT:-$(mktemp /tmp/curb-deploy-router.XXXXXX)}

die() { echo "FAIL: $*" >&2; exit 1; }
export PATH="$HOME/.foundry/bin:$PATH"

# FOUNDRY_BROADCAST=broadcast/local, as the demo scripts do: this node serves
# chain 8453, and broadcast/<script>/8453 is where a mainnet run records itself.
FOUNDRY_BROADCAST=broadcast/local base-forge script script/DeployRouter.s.sol --rpc-url "$RPC" \
  --broadcast --unlocked --sender "$SENDER" > "$OUT" 2>&1 \
  || { tail -30 "$OUT"; die "DeployRouter did not run"; }
ROUTER=$(grep -m1 -E "CurbRouter (already deployed at )?0x" "$OUT" | grep -oE '0x[0-9a-fA-F]{40}' | head -1)
[ -n "$ROUTER" ] || { tail -30 "$OUT"; die "could not read the router's address out of DeployRouter's output"; }
[ "$(base-cast codesize "$ROUTER" --rpc-url "$RPC")" -gt 0 ] || die "the router at $ROUTER has no code on $RPC"
HASH=$(base-cast keccak "$(base-cast code "$ROUTER" --rpc-url "$RPC")")
echo "router    $ROUTER"
echo "codehash  $HASH"
