#!/usr/bin/env bash
# CURBROUTER'S GUARDS, BROKEN ON PURPOSE.
#
#   bash script/b20/start-node.sh          (in another terminal)
#   RPC=http://127.0.0.1:8546 bash script/b20/mutate-router.sh
#   MUT_ONLY="m1 r2" ...   run only these mutants (and the baseline)
#
# A green router suite proves nothing on its own. Each mutant below takes one
# thing src/curb/CurbRouter.sol does - a minimum, a measured delta, the check
# that every hop took all it was given, an allowance taken back, a refund, a
# recipient refused, the issuer asked - and the test named beside it, in
# test/fork/B20Router.t.sol, has to FAIL against it. A test that stays green
# against a broken guard is not testing that guard.
#
# Same shape as mutate-integration.sh: -e so a stale anchor stops the run, a
# snapshot of the router restored on exit (never `git checkout`, which restores
# from the index), a baseline that must be green target by target, and a
# verdict per mutant with an exit code that means something. Every failing
# line is printed with forge's reason, so WHY a mutant was caught can be read,
# not only that it was.
#
# THE ROUTER ALONE RECOMPILES. B20Router.t.sol talks to the router through
# ICurbRouter and deploys it from its artifact, so a mutant rebuilds one file
# and the suite reads the new artifact. The mutants also change the router's
# code hash, so test_theDeployScript_* (which pin it) are never targets here.
#
# A FEW GUARDS STAND IN FRONT OF ANOTHER, and their mutants are caught by the
# error the test names, not by a trade going through. Read on the run of
# 2026-10-08, eight of them: without a path check (p2, p4, p5) the tests'
# calls, which pass a zero minimum, are refused by NoQuoteMinimum or
# NoEthMinimum - and with a minimum named, a route that ends elsewhere
# delivers none of the asset and ends in QuoteBelowMinimum or EthBelowMinimum;
# without the length floor (p3) an empty path underflows. Without NoEthSent
# (e2) the curve refuses a zero buy (ZeroAmount); without NotALaunch (e4) the
# registry refuses the token (NotRegistered); without the router's own issuer
# or blacklist question (i3, i6) the pool reverts with Uniswap's "TF". Those
# tests pin that the router names the real fault, first, before anything
# moves. Every other mutant fails its test outright: a call that went through,
# a balance or allowance that moved, an answer that changed. The
# zero-recipient and router-as-recipient sales name an ETH minimum of one for
# that reason: with zero, NoEthMinimum refused them as well, and their mutants
# were caught by the error's name alone.
set -euo pipefail
# READ BEFORE THE cd, so the baseline below can be taken from this very file.
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")/../.."
export PATH="$HOME/.foundry/bin:$PATH"
RPC="${RPC:-http://127.0.0.1:8546}"
MUT_ONLY="${MUT_ONLY:-}"
R=src/curb/CurbRouter.sol
SUITE=test/fork/B20Router.t.sol

# ITS OWN SNAPSHOT, so a run in another checkout at the same time cannot
# restore this one from theirs.
SNAP="$(mktemp -d /tmp/curb-router-snapshot.XXXXXX)"
cp "$R" "$SNAP/router.sol"
restore() { cp "$SNAP/router.sol" "$R"; }
trap restore EXIT

FAILED=0
SKIPPED=0
CAUGHT=0
judge() { # judge <name> <output>
  local name="$1" out="$2" pass fail
  # EACH TEST ONCE: forge prints a failing test again in its summary, which
  # made one failing test read as "2 of 2".
  pass=$( { printf '%s\n' "$out" | grep '^\[PASS' || true; } | sort -u | grep -c . || true)
  fail=$( { printf '%s\n' "$out" | grep '^\[FAIL' || true; } | sort -u | grep -c . || true)
  if [[ "$name" == baseline* ]]; then
    if [ "$pass" -gt 0 ] && [ "$fail" = 0 ]; then
      echo "  VERDICT $name: green, as it must be ($pass passed)"
    else
      echo "  VERDICT $name: NOT GREEN ($pass passed, $fail failed)"; FAILED=$((FAILED + 1))
    fi
  elif [ "$fail" -gt 0 ]; then
    echo "  VERDICT $name: caught ($fail of $((pass + fail)) named tests failed)"; CAUGHT=$((CAUGHT + 1))
  else
    echo "  VERDICT $name: SURVIVED ($pass passed, 0 failed)$([ "$pass" = 0 ] && echo ' - nothing ran; did the mutant compile?')"
    FAILED=$((FAILED + 1))
  fi
}
LAST_OUT=""
run() { # run <name> <match-test>
  local out
  out="$(B20_FORK=true base-forge test --match-path "$SUITE" --match-test "$2" --fork-url "$RPC" 2>&1 \
    | grep -E "^\[(PASS|FAIL)|Suite result|^Error|^Compiler run failed" | sed 's/ (gas.*//' || true)"
  printf '%s\n' "$out"
  LAST_OUT="$out"
  judge "$1" "$out"
}
mutate() { # reads OLD and NEW from the environment; with CHECK=1 only asserts
  CHECK="$CHECK" python3 - "$R" <<'EOF'
import io, os, sys
p = sys.argv[1]
s = io.open(p, encoding="utf-8").read()
old = os.environ["OLD"]; new = os.environ["NEW"]
assert s.count(old) == 1, "stale anchor in %s (found %d times): %r" % (p, s.count(old), old[:90])
assert new != old, "a mutant that changes nothing"
if os.environ.get("CHECK") != "1":
    io.open(p, "w", encoding="utf-8", newline="\n").write(s.replace(old, new, 1))
EOF
}
# one mutant: m <name> <match-test>, OLD and NEW exported
CHECK=0
m() {
  if [ "$CHECK" = 1 ]; then mutate; return 0; fi
  echo
  echo "############ $1"
  if [ -n "$MUT_ONLY" ] && [[ " $MUT_ONLY " != *" $1 "* ]]; then
    echo "  skipped $1 (not in MUT_ONLY)"; SKIPPED=$((SKIPPED + 1)); return 0
  fi
  mutate
  run "$1" "$2"
  restore
}

# EVERY MUTANT, as one list: run twice, first only to check that each anchor
# still matches exactly once (seconds), then for real.
mutants() {
# ============================================================ the minimums
# The bounds that may not be zero, the bounds themselves, and the curve's own
# bounds passed through unchanged.
OLD=$'        if (minEthOut == 0) revert NoEthMinimum();\n' NEW='' \
  m m1 'test_aSaleWithNoEthMinimum_isRefused'
OLD=$'        if (quote != WETH && minQuoteOut == 0) revert NoQuoteMinimum();\n' NEW='' \
  m m2 'test_aSwapBuyWithNoQuoteMinimum_isRefused'
OLD=$'        if (quoteIn < minQuoteOut) revert QuoteBelowMinimum(quoteIn, minQuoteOut);\n' NEW='' \
  m m3 'test_buy_minQuoteOut_boundsWhatTheSwapDelivered|test_buy_minQuoteOut_bindsOnTheWethPairToo'
OLD=$'        if (ethOut < minEthOut) revert EthBelowMinimum(ethOut, minEthOut);\n' NEW='' \
  m m4 'test_sell_minEthOut_boundsWhatArrives|test_sell_minEthOut_bindsOnTheWethPairToo'
OLD=$'        tokensOut = ILaunchCurve(curve).buy(quoteIn, minTokensOut, recipient);' \
NEW=$'        tokensOut = ILaunchCurve(curve).buy(quoteIn, 0, recipient);' \
  m m5 'test_buy_minTokensOut_isTheCurvesOwnBound'
OLD=$'        ILaunchCurve(curve).sell(tokensIn, minQuoteOut, address(this));' \
NEW=$'        ILaunchCurve(curve).sell(tokensIn, 0, address(this));' \
  m m6 'test_sell_minQuoteOut_isTheCurvesOwnBound'

# ============================================================ what is left over
# Every hop takes all it is given, and every amount is a measured delta.
OLD=$'            if (unspent != 0) revert RouteLeftInput(unspent);\n' NEW='' \
  m l1 'test_aRouteThatCannotTakeTheWholeSale_isRefused'
OLD=$'            _checkMidway(path, midway);\n            quoteIn = ' NEW=$'            quoteIn = ' \
  m l2 'test_aLaterHopThatStopsShort_revertsTheBuy'
OLD=$'            _checkMidway(path, midway);\n            ethOut = ' NEW=$'            ethOut = ' \
  m l3 'test_aLaterHopThatStopsShort_revertsTheSale'
OLD=$'            if (holds > held[i]) revert RouteStoppedMidway(asset, holds - held[i]);' \
NEW=$'            if (holds > held[i] + 1) revert RouteStoppedMidway(asset, holds - held[i]);' \
  m l4 'test_oneUnitLeftMidway_isRefused'
OLD=$'        if (asset == WETH) amount += SWAP_ROUTER.balance;\n' NEW='' \
  m l5 'test_strayEthOnSwapRouter02_aWethLegMidwayIsNotALeftover'
OLD=$'        uint256 at = (i + 1) * HOP;' NEW=$'        uint256 at = i * HOP;' \
  m l6 'test_aLaterHopThatStopsShort_revertsTheBuy_usdcMidway'
OLD=$'            quoteIn = IERC20(quote).balanceOf(address(this)) - quoteStart;' \
NEW=$'            quoteIn = IERC20(quote).balanceOf(address(this));' \
  m l7 'test_aBalanceAlreadyInTheRouter_isNeitherSpentNorHandedOut'
OLD=$'        uint256 ethRefund = IERC20(WETH).balanceOf(address(this)) - wethStart;' \
NEW=$'        uint256 ethRefund = IERC20(WETH).balanceOf(address(this));' \
  m l8 'test_aBalanceAlreadyInTheRouter_isNeitherSpentNorHandedOut|test_aBalanceAlreadyInTheRouter_wethPair'
OLD=$'            quoteRefund = IERC20(quote).balanceOf(address(this)) - quoteStart;' \
NEW=$'            quoteRefund = IERC20(quote).balanceOf(address(this));' \
  m l9 'test_aBalanceAlreadyInTheRouter_isNeitherSpentNorHandedOut'
OLD=$'        uint256 quoteOut = IERC20(quote).balanceOf(address(this)) - quoteStart;' \
NEW=$'        uint256 quoteOut = IERC20(quote).balanceOf(address(this));' \
  m l10 'test_aBalanceAlreadyInTheRouter_isNeitherSpentNorHandedOut|test_aBalanceAlreadyInTheRouter_wethPair'
OLD=$'            ethOut = IERC20(WETH).balanceOf(address(this)) - wethStart;' \
NEW=$'            ethOut = IERC20(WETH).balanceOf(address(this));' \
  m l11 'test_aBalanceAlreadyInTheRouter_isNeitherSpentNorHandedOut'
OLD=$'            uint256 unspent = IERC20(quote).balanceOf(address(this)) - quoteStart;' \
NEW=$'            uint256 unspent = IERC20(quote).balanceOf(address(this));' \
  m l12 'test_aBalanceAlreadyInTheRouter_isNeitherSpentNorHandedOut'

# ============================================================ what comes back
OLD=$'        if (ethRefund != 0) _payEth(msg.sender, ethRefund);\n' NEW='' \
  m f1 'test_buyPastTheThreshold_wethLaunch_refundsEthToTheCaller|test_strayEthOnSwapRouter02_leavesNoAllowanceAndTheEthComesBack|test_aRouteThatCannotTakeTheWholeBuy_refundsTheRest'
OLD=$'            if (quoteRefund != 0) IERC20(quote).safeTransfer(msg.sender, quoteRefund);\n' NEW='' \
  m f2 'test_buyPastTheThreshold_stockLaunch_refundsTheAssetToTheCaller'
OLD=$'        if (ethRefund != 0) _payEth(msg.sender, ethRefund);' \
NEW=$'        if (ethRefund != 0) _payEth(recipient, ethRefund);' \
  m f3 'test_buyPastTheThreshold_wethLaunch_refundsEthToTheCaller'
OLD=$'            if (quoteRefund != 0) IERC20(quote).safeTransfer(msg.sender, quoteRefund);' \
NEW=$'            if (quoteRefund != 0) IERC20(quote).safeTransfer(recipient, quoteRefund);' \
  m f4 'test_buyPastTheThreshold_stockLaunch_refundsTheAssetToTheCaller'
OLD=$'        if (sent) return false;\n' NEW=$'        require(sent, "refused");\n        return false;\n' \
  m f5 'test_sell_aRecipientThatRefusesEth_isPaidInWeth|test_buyPastTheThreshold_aCallerThatRefusesEth_isRefundedInWeth'
OLD=$'        (bool sent,) = to.call{value: amount}("");' NEW=$'        (bool sent,) = to.call{value: amount, gas: 2300}("");' \
  m f6 'test_sell_aRecipientWithAHeavyReceive_isPaidInEth|test_buyPastTheThreshold_aCallerWithAHeavyReceive_isRefundedInEth'

# ============================================================ no allowance left standing
OLD=$'            _clearAllowance(WETH, SWAP_ROUTER);\n' NEW='' \
  m a1 'test_strayEthOnSwapRouter02_leavesNoAllowanceAndTheEthComesBack'
OLD=$'        _clearAllowance(quote, curve);\n' NEW='' \
  m a2 'test_aRegistryThatLies_leavesNoAllowanceStanding'
OLD=$'        _clearAllowance(token, curve);\n' NEW='' \
  m a3 'test_aRegistryThatLies_leavesNoAllowanceStanding'
OLD=$'        if (IERC20(asset).allowance(address(this), spender) != 0) IERC20(asset).forceApprove(spender, 0);' \
NEW=$'        if (IERC20(asset).allowance(address(this), spender) == 0) IERC20(asset).forceApprove(spender, 0);' \
  m a4 'test_aRegistryThatLies_leavesNoAllowanceStanding|test_strayEthOnSwapRouter02_leavesNoAllowanceAndTheEthComesBack'

# ============================================================ recipients that cannot be paid
OLD=$'        if (recipient == address(0)) revert ZeroRecipient();\n' NEW='' \
  m r1 'test_aZeroRecipient_isRefused'
OLD=$'        if (recipient == address(this)) revert RecipientIsTheRouter();\n' NEW='' \
  m r2 'test_theRouterAsRecipient_isRefused'
OLD=$'        if (recipient == WETH || recipient == SWAP_ROUTER) revert RecipientCannotBePaid(recipient);' \
NEW=$'        if (recipient == SWAP_ROUTER) revert RecipientCannotBePaid(recipient);' \
  m r3 'test_recipientsThatCannotBePaid_areRefused'
OLD=$'        if (recipient == WETH || recipient == SWAP_ROUTER) revert RecipientCannotBePaid(recipient);' \
NEW=$'        if (recipient == WETH) revert RecipientCannotBePaid(recipient);' \
  m r4 'test_recipientsThatCannotBePaid_areRefused'
OLD=$'        if (recipient == curve || recipient == token || recipient == quote) revert RecipientCannotBePaid(recipient);' \
NEW=$'        if (recipient == token || recipient == quote) revert RecipientCannotBePaid(recipient);' \
  m r5 'test_recipientsThatCannotBePaid_areRefused'
OLD=$'        if (recipient == curve || recipient == token || recipient == quote) revert RecipientCannotBePaid(recipient);' \
NEW=$'        if (recipient == curve || recipient == quote) revert RecipientCannotBePaid(recipient);' \
  m r6 'test_recipientsThatCannotBePaid_areRefused'
OLD=$'        if (recipient == curve || recipient == token || recipient == quote) revert RecipientCannotBePaid(recipient);' \
NEW=$'        if (recipient == curve || recipient == token) revert RecipientCannotBePaid(recipient);' \
  m r7 'test_recipientsThatCannotBePaid_areRefused'

# ============================================================ the call itself
OLD=$'        if (block.timestamp > deadline) revert Expired(deadline, block.timestamp);\n' NEW='' \
  m e1 'test_anExpiredDeadline_isRefused'
OLD=$'        if (msg.value == 0) revert NoEthSent();\n' NEW='' \
  m e2 'test_noEthAndStrayEth_areRefused'
OLD=$'        if (msg.sender != WETH) revert UnexpectedEth(msg.sender);\n' NEW='' \
  m e3 'test_noEthAndStrayEth_areRefused'
OLD=$'        if (!ILaunchBook(registry).isRegistered(token)) revert NotALaunch(registry, token);\n' NEW='' \
  m e4 'test_aTokenTheRegistryDoesNotKnow_isRefused'
OLD=$'    ) external payable nonReentrant returns (uint256 tokensOut) {' \
NEW=$'    ) external payable returns (uint256 tokensOut) {' \
  m e5 'test_reentryDuringThePayout_isRefused'
OLD=$'    ) external nonReentrant returns (uint256 ethOut) {' NEW=$'    ) external returns (uint256 ethOut) {' \
  m e6 'test_reentryDuringThePayout_isRefused'

# ============================================================ the route's shape
OLD=$'            if (path.length != 0) revert PathOnWethLaunch();\n' NEW='' \
  m p1 'test_aPathOnAWethLaunch_isRefused'
OLD=$'        if (path.length < ADDR + HOP || (path.length - ADDR) % HOP != 0) revert MalformedPath(path.length);' \
NEW=$'        if (path.length < ADDR + HOP) revert MalformedPath(path.length);' \
  m p2 'test_aPathOfTheWrongShape_isRefused'
OLD=$'        if (path.length < ADDR + HOP || (path.length - ADDR) % HOP != 0) revert MalformedPath(path.length);' \
NEW=$'        if ((path.length - ADDR) % HOP != 0) revert MalformedPath(path.length);' \
  m p3 'test_aPathOfTheWrongShape_isRefused'
OLD=$'        if (from != first) revert PathStartsElsewhere(from, first);\n' NEW='' \
  m p4 'test_buy_aPathThatDoesNotStartAtWeth_isRefused|test_sell_aPathThatDoesNotStartAtTheQuote_isRefused'
OLD=$'        if (to != last) revert PathEndsElsewhere(to, last);\n' NEW='' \
  m p5 'test_buy_aPathThatDoesNotEndAtTheQuote_isRefused|test_sell_aPathThatDoesNotEndAtWeth_isRefused'

# ============================================================ the issuer, asked first
OLD=$'            _notBlacklisted(quote, msg.sender);\n' NEW='' \
  m i1 'test_aCallerCbBtcBlacklists_cannotBuyOrSellForEth|test_aCallerCbXrpBlacklists_cannotBuyOrSellForEth'
OLD=$'            _notBlacklisted(quote, recipient);\n' NEW='' \
  m i2 'test_aRecipientTheCoinBlacklists_isRefused'
OLD=$'            _notBlacklisted(quote, address(this));\n' NEW='' \
  m i3 'test_aRouterTheCoinBlacklists_refusesByName_andNothingMoves'
OLD=$'        _admitted(msg.sender, sendScope, sendPolicy, receiveScope, receivePolicy);\n' NEW='' \
  m i4 'test_aCallerTheIssuerBlocks_cannotBuyWithEth|test_aCallerTheIssuerBlocks_cannotSellForEth|test_googlc_anAccountTheIssuerBlocks_isRefusedAsCallerAndRecipient'
OLD=$'        _admitted(recipient, sendScope, sendPolicy, receiveScope, receivePolicy);\n' NEW='' \
  m i5 'test_aRecipientTheIssuerBlocks_isRefused|test_googlc_anAccountTheIssuerBlocks_isRefusedAsCallerAndRecipient'
OLD=$'        _admitted(address(this), sendScope, sendPolicy, receiveScope, receivePolicy);\n' NEW='' \
  m i6 'test_aRouterTheIssuerBlocks_refusesByName_andNothingMoves'
OLD=$'        if (!IPolicyLookup(POLICY_REGISTRY).isAuthorized(sendPolicy, account)) {\n            revert IssuerForbids(account, sendScope, sendPolicy);\n        }\n' NEW='' \
  m i7 'test_eachDirectionOfTheIssuersPolicyIsAsked'
OLD=$'        if (!IPolicyLookup(POLICY_REGISTRY).isAuthorized(receivePolicy, account)) {\n            revert IssuerForbids(account, receiveScope, receivePolicy);\n        }\n' NEW='' \
  m i8 'test_eachDirectionOfTheIssuersPolicyIsAsked'
OLD=$'        if (quote == WETH) return;\n        if (!IB20Lookup' NEW=$'        if (!IB20Lookup' \
  m i9 'test_theWethAndB20Pairs_askNoBlacklist'
OLD=$'        if (!IB20Lookup(B20_FACTORY).isB20(quote)) {' NEW=$'        if (true) {' \
  m i10 'test_aCallerTheIssuerBlocks_cannotSellForEth|test_theWethAndB20Pairs_askNoBlacklist'
OLD=$'        if (!IB20Lookup(B20_FACTORY).isB20(quote)) {' NEW=$'        if (false) {' \
  m i11 'test_buy_cbBtcLaunch_oneHop_sameAsTheLongWay|test_aCallerCbBtcBlacklists_cannotBuyOrSellForEth'
OLD=$'            let ok := staticcall(PROBE_GAS, asset, 0x00, 0x24, 0x00, 0x20)' \
NEW=$'            let ok := staticcall(gas(), asset, 0x00, 0x24, 0x00, 0x20)' \
  m i12 'test_aBlacklistQuestionThatBurnsItsGas_costsAtMostTheCap'
OLD=$'            listed := and(and(ok, gt(returndatasize(), 0x1f)), eq(mload(0x00), 1))' \
NEW=$'            listed := and(ok, eq(mload(0x00), 1))' \
  m i13 'test_whenTheBlacklistQuestionFails_theTradeGoesThrough'
OLD=$'            listed := and(and(ok, gt(returndatasize(), 0x1f)), eq(mload(0x00), 1))' \
NEW=$'            listed := and(and(ok, gt(returndatasize(), 0x1f)), and(mload(0x00), 1))' \
  m i14 'test_whenTheBlacklistQuestionFails_theTradeGoesThrough'
OLD=$'            listed := and(and(ok, gt(returndatasize(), 0x1f)), eq(mload(0x00), 1))' \
NEW=$'            listed := and(gt(returndatasize(), 0x1f), eq(mload(0x00), 1))' \
  m i15 'test_whenTheBlacklistQuestionFails_theTradeGoesThrough'
OLD=$'    uint256 private constant PROBE_GAS = 100_000;' NEW=$'    uint256 private constant PROBE_GAS = 5_000;' \
  m i16 'test_aColdBlacklistQuestion_stillAnswers'
}

# THE ANCHORS FIRST. A stale anchor stops the run here, in seconds, instead of
# after the baseline's minutes. MUT_CHECK_ONLY=1 stops after this.
CHECK=1
mutants
CHECK=0
echo "  every mutant's anchor matches exactly once"
if [ -n "${MUT_CHECK_ONLY:-}" ]; then trap - EXIT; exit 0; fi

# THE BASELINE IS EVERY TARGET ABOVE, READ OUT OF THIS FILE, and each target
# must show a PASS of its own - so a pattern that matches nothing, or only a
# failing test, stops the run here rather than turning into a mutant reported
# as caught.
TARGETS=()
while IFS= read -r t; do TARGETS+=("$t"); done \
  < <(grep -E "^  m [a-z0-9]+ '[^']+'$" "$SELF" | sed -E "s/^  m [a-z0-9]+ '([^']+)'$/\1/" | sort -u)
[ "${#TARGETS[@]}" -gt 0 ] || { echo "  no mutation targets found in $SELF"; exit 1; }
BASELINE="$(IFS='|'; echo "${TARGETS[*]}")"

echo "############ 0. UNMUTATED (${#TARGETS[@]} target patterns)"
run baseline "$BASELINE"
for t in "${TARGETS[@]}"; do
  IFS='|' read -ra names <<< "$t"
  for n in "${names[@]}"; do
    if ! printf '%s\n' "$LAST_OUT" | grep -qE "^\[PASS\] [A-Za-z0-9_]*${n}"; then
      echo "  VERDICT baseline: target '$n' has no passing test"; FAILED=$((FAILED + 1))
    fi
  done
done
[ "$FAILED" = 0 ] || { echo "  THE BASELINE IS NOT GREEN - no verdict below would mean anything"; exit 1; }

mutants

echo
echo "############ restored:"
trap - EXIT
restore
diff -q "$SNAP/router.sol" "$R" && echo "  the router is byte-identical to the snapshot"
echo "  $CAUGHT caught, $SKIPPED skipped"
[ "$FAILED" = 0 ] || { echo "  $FAILED VERDICT(S) FAILED - read them above"; exit 1; }
echo "  every mutant that ran was caught"
