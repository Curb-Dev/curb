#!/usr/bin/env bash
# THE CONTRACT SUITE, AS TWO COMMANDS, BECAUSE ONE DID NOT COMPLETE (IT DOES NOW).
#
# Running the whole repository with --fork-url did not finish in this
# environment: no output for an hour, forge alive, the node answering, ten of
# fifteen suites done and the rest never arriving. Splitting the fork tests from
# the rest finished both halves in about half a minute.
#
#   THE CAUSE, MEASURED 2026-10-02: the three invariant suites outside
#   test/fork (CurveInvariants, CrossLaunchInvariants, DistributorInvariants)
#   let the fuzzer pick a new msg.sender for every call, and on a fork every
#   new address is a round trip to the fork's upstream. Each one alone timed
#   out at 900 s in fork mode. With one fixed sender (targetSender; their
#   handlers prank whoever they need, so the sender meant nothing) each takes
#   about a minute, and the whole repository with --fork-url ran 676 tests,
#   all passing, in 96 s. The split stays: the first half needs no node.
#
# This script keeps the two halves; the combined command now completes too.
# Before them it runs the selftests of the scripts the runbook signs from and
# checks with, the site's publish set, and the keeper's own suite
# (services/sharer), which need no node.
#
#   bash script/b20/start-node.sh     (in another terminal, for the fork half)
#   bash script/b20/test-all.sh
#
# A node on another port: RPC_PORT=8551 bash script/b20/test-all.sh (or RPC=...).
#
# It stops at the first failing half and exits non-zero.
set -euo pipefail
cd "$(dirname "$0")/../.."
source script/b20/env.sh

RPC="${RPC:-$FORK_RPC}"

# NO NODE IS SAID FIRST, AND AS THAT. The fork half used to find out after the
# whole first half had run, and then said "the node is not the pinned fork" -
# about a node that was not there at all.
$CAST chain-id --rpc-url "$RPC" >/dev/null 2>&1 \
  || die "no node answers at $RPC - start one with 'bash script/b20/start-node.sh' (port 8546), or point this at a running one with RPC_PORT=... or RPC=..."

echo "=== 0/2  the deploy scripts' selftests, and the publish set ==="
# NO NODE, NO forge, NO KEY - fixed inputs through the functions the mainnet
# preflight gates on (skipped counts, the tree filter, the address reads, the
# printed command). Here so the suite the runbook runs covers the script the
# runbook signs from; it had no test at all.
bash script/b20/preflight-mainnet.sh --selftest   || die "the preflight's selftest failed"
# AND THE SIZE AND CODE GATE'S, on fixed artifacts, and the sharing
# read-back's, against fixed answers.
bash script/b20/size-gate.sh --selftest          || die "the size gate's selftest failed"
bash script/b20/check-sharing.sh --selftest      || die "the sharing read-back's selftest failed"
# AND THE TWO DEPLOY DAY RUNS AFTER THE BROADCAST (DEPLOY.txt STEP 5): the
# whole deployment's read-back, against a stand-in for cast and a made-up
# record, and the site's publish set, on copies of web/ - then the publish set
# as it stands, which must hold no test page and name every inline script.
# Called plainly, never behind a test for the file: a missing script fails here.
bash script/b20/check-deployment.sh --selftest   || die "the deployment read-back's selftest failed"
bash script/b20/check-publish-set.sh --selftest  || die "the publish set check's selftest failed"
bash script/b20/check-publish-set.sh             || die "the publish set is not ready (script/b20/check-publish-set.sh)"

echo
echo "=== 0b     the keeper's own suite (services/sharer) ==="
# HOLDER PAYOUTS ARE MADE BY THE KEEPER, AND ITS TESTS WERE IN NO GATE. The
# calculator against the golden vectors, and the keeper, the verifier and the
# guardian on a simulated chain, ran only when someone remembered to: a
# regression in the fee or root logic would have shipped, to be caught by a
# guardian veto after publishing. No node, no key; exactly the lockfile.
command -v npm >/dev/null 2>&1 \
  || die "npm is not on PATH: the keeper's suite needs Node 22.18 or later (services/sharer/package.json engines)"
(cd services/sharer && npm ci --no-audit --no-fund && npm run check) \
  || die "the keeper's suite failed (services/sharer: npm run check)"

echo
echo "=== 1/2  everything that does not need a fork ==="
# NO --fork-url HERE, deliberately. These are our own contracts' arithmetic and
# giving them a fork is what the split exists to avoid.
base-forge test --no-match-path "test/fork/*" \
  || die "the non-fork suites failed"

# THE SIZE AND CODE GATE, over the build the line above just made: every
# contract within its runtime budget, the contracts core v2 leaves unchanged at
# their pinned code identities, the router at its pinned code hash.
bash script/b20/size-gate.sh --no-build || die "the size and code gate failed"

echo
echo "=== 2/2  the fork suites, against $RPC ==="
# THE NODE HAS TO BE THE PINNED ONE. Every measured constant in test/fork
# depends on the fork point, and a test that runs against some other node fails
# in ways that look like our code being wrong.
bash script/b20/verify-fork.sh --rpc "$RPC" --identity >/dev/null \
  || { bash script/b20/verify-fork.sh --rpc "$RPC" --identity || true; die "the node is not the pinned fork"; }

# B20_FORK=true, so a test that finds itself off the fork FAILS instead of
# skipping. Without it, a node served under another chain id passed identity
# and every fork test vm.skip'd - and "both halves passed" meant nothing ran.
B20_FORK=true base-forge test --match-path "test/fork/*" --fork-url "$RPC" \
  || die "the fork suites failed"

echo
echo "both halves passed."
