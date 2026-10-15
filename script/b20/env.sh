#!/usr/bin/env bash
# Shared settings for the B20 native test environment.
# See B20_ENVIRONMENT.txt for why each of these is what it is.
set -euo pipefail

export PATH="$HOME/.foundry/bin:$PATH"

# Overridable so the checks themselves can be tested with wrong values.
FORK_BLOCK="${FORK_BLOCK:-51171034}"
FORK_HASH="${FORK_HASH:-0x7bfea0b62586ce94188b32d84f6037333fc6a0ac2d826f4bd2c3d7987075b35f}"

# THE CHAIN ID THE NODE SERVES, which is not the chain it forked FROM. It
# defaults to Base's own, because that is what a fork of Base reports and what
# every existing check expects.
#
# A REAL WALLET CANNOT TELL 8453 FROM 8453. It shows the fork as Base, prices
# gas in dollars, and - the part that actually costs something - runs its own
# hosted transaction simulation against the PUBLIC chain, where a contract
# deployed here does not exist. Every confirmation then carries "this
# transaction is likely to fail", and a wallet that cries wolf on all ten steps
# is a wallet whose warnings cannot be read. Serving a different id makes it a
# custom network: no fiat pricing, no hosted simulation, no chance of taking the
# public chain for this one.
SERVE_CHAIN_ID="${SERVE_CHAIN_ID:-8453}"
export SERVE_CHAIN_ID
# OVERRIDABLE, so a test run can have a node of its own and leave a hand-driven
# session on the default port alone.
RPC_PORT="${RPC_PORT:-8546}"
FORK_RPC="http://127.0.0.1:${RPC_PORT}"
MAINNET_RPC="https://mainnet.base.org"
UPSTREAM_RPC="${UPSTREAM_RPC:-$MAINNET_RPC}"

NVDAC=0xb20000000000000000000078ee7ce2fE4908108C
AAPLC=0xb200000000000000000000C2e324d24d7eEcd1fb

# base-cast, not cast. Stock cast 1.8.1 fails every `cast call` against this
# node with "unsupported network family `base`".
CAST=base-cast

die() { echo "FAIL: $*" >&2; exit 1; }
