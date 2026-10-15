#!/usr/bin/env bash
# THE ESCROW'S CHECKS, BROKEN ON PURPOSE.
#
#   bash script/b20/start-node.sh          (in another terminal)
#   RPC=http://127.0.0.1:8546 bash script/b20/mutate-escrow.sh
#
# A test that passes proves nothing on its own. Each mutation below removes one
# thing the escrow does and the matching test has to fail - and the FAILURE has
# to be about that thing, not about something incidental.
# -e, so a mutation whose anchor stopped matching STOPS the run. Without it,
# mutations 5 and 6 failed their asserts inside the heredoc - their anchor
# occurs twice in FeeEscrow.sol - and the tests ran against unmutated source
# and printed PASS where a working mutation must print FAIL.
set -euo pipefail
# READ BEFORE THE cd, so the baseline below can be taken from this very file.
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")/../.."
export PATH="$HOME/.foundry/bin:$PATH"
RPC="${RPC:-http://127.0.0.1:8546}"
E=src/curb/FeeEscrow.sol

# RESTORE FROM A SNAPSHOT OF THE WORKING TREE, NEVER FROM GIT. `git checkout --`
# restores from the INDEX, and with a stale index that silently reverts the
# contract under test to HEAD - which has happened here before and cost an
# hour's work.
# Its own snapshot, so a run in another checkout at the same time cannot
# restore this one from theirs.
SNAP="$(mktemp -d /tmp/curb-escrow-snapshot.XXXXXX)"
cp "$E" "$SNAP/escrow.sol"
restore() { cp "$SNAP/escrow.sol" "$E"; }
trap restore EXIT


# A VERDICT PER RUN, AND AN EXIT CODE THAT MEANS SOMETHING. This used to print
# the forge lines and nothing else: a surviving mutant printed [PASS], a mutant
# that no longer compiled printed nothing at all (the grep hid the error), a
# broken baseline did not stop anything - and the script exited 0 every time.
FAILED=0
judge() { # judge <name> <output> [expect-green]
  local name="$1" out="$2" want="${3:-red}" pass fail
  pass=$(printf '%s\n' "$out" | grep -c '^\[PASS' || true)
  fail=$(printf '%s\n' "$out" | grep -c '^\[FAIL' || true)
  if [ "$name" = baseline ] || [ "$want" = green ]; then
    if [ "$pass" -gt 0 ] && [ "$fail" = 0 ]; then
      echo "  VERDICT $name: green, as it must be ($pass passed)"
    else
      echo "  VERDICT $name: NOT GREEN ($pass passed, $fail failed)"; FAILED=$((FAILED + 1))
    fi
  elif [ "$fail" -gt 0 ]; then
    echo "  VERDICT $name: caught"
  else
    echo "  VERDICT $name: SURVIVED ($pass passed, 0 failed)$([ "$pass" = 0 ] && echo ' - nothing ran; did the mutant compile?')"
    FAILED=$((FAILED + 1))
  fi
}
LAST_OUT=""
run() { # run <match-pattern> [name] [expect-green]
  local out
  out="$(B20_FORK=true base-forge test --match-path "test/fork/B20{FeeEscrow,Graduation}*" \
    --match-test "$1" --fork-url "$RPC" 2>&1 \
    | grep -E "^\[(PASS|FAIL)|Suite result" | sed 's/ (gas.*//' || true)"
  printf '%s\n' "$out"
  LAST_OUT="$out"
  judge "${2:-$1}" "$out" "${3:-red}"
}

# THE BASELINE IS EVERY TARGET BELOW, READ OUT OF THIS FILE, plus the tests
# the typed list always carried that no mutation here targets. The typed list
# alone had drifted: mutation 10's target, aBalanceCreditedToTheEscrowItself,
# was never in it. Each target must also show a PASS of its own, so a pattern
# that matches nothing, or only a failing test, stops the run here rather than
# turning into a mutant reported as "caught".
TARGETS=()
while IFS= read -r t; do TARGETS+=("$t"); done \
  < <(grep -E "^run '[^']+'" "$SELF" | grep -v " baseline$" | sed -E "s/^run '([^']+)'.*$/\1/")
[ "${#TARGETS[@]}" -gt 0 ] || { echo "  no mutation targets found in $SELF"; exit 1; }
EXTRA='aRecipientThatForwards|aStrangerCannotReach|escrow_curveFees'
BASELINE="$(IFS='|'; echo "${TARGETS[*]}")|$EXTRA"

echo "############ 0. UNMUTATED (${#TARGETS[@]} targets)"
run "$BASELINE" baseline
for t in "${TARGETS[@]}"; do
  if ! printf '%s\n' "$LAST_OUT" | grep -qE "^\[PASS\] [A-Za-z0-9_]*($t)"; then
    echo "  VERDICT baseline: target '$t' has no passing test"; FAILED=$((FAILED + 1))
  fi
done
[ "$FAILED" = 0 ] || { echo "  THE BASELINE IS NOT GREEN - no verdict below would mean anything"; exit 1; }

echo
echo "############ 1. the over-claim check goes away"
python3 - <<'EOF'
import io
p="src/curb/FeeEscrow.sol"; s=io.open(p,encoding="utf-8").read()
old="        if (amount > available) revert ClaimExceedsBalance(amount, available);"
assert s.count(old)==1
io.open(p,"w",encoding="utf-8").write(s.replace(old,"",1))
EOF
run 'overClaimingIsRefused'
restore

echo
echo "############ 2. a credit is taken on trust instead of measured"
python3 - <<'EOF'
import io
p="src/curb/FeeEscrow.sol"; s=io.open(p,encoding="utf-8").read()
old="        if (delivered != amount) revert DeliveryMismatch(token, amount, delivered);"
assert s.count(old)==1
io.open(p,"w",encoding="utf-8").write(s.replace(old,"        delivered = amount;",1))
EOF
run 'aShortDeliveryIsRefused'
restore

echo
echo "############ 3. any token is accepted"
python3 - <<'EOF'
import io
p="src/curb/FeeEscrow.sol"; s=io.open(p,encoding="utf-8").read()
old="""        if (token != quoteToken) revert UnsupportedToken(token);
        if (recipient == address(0)) revert ZeroRecipient();"""
new="""        if (recipient == address(0)) revert ZeroRecipient();"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8").write(s.replace(old,new,1))
EOF
run 'anUnsupportedTokenIsRefused'
restore

echo
echo "############ 4. native ETH is swallowed instead of refused"
python3 - <<'EOF'
import io
p="src/curb/FeeEscrow.sol"; s=io.open(p,encoding="utf-8").read()
old="""    function credit(address) external payable {
        revert NativeNotSupported();
    }"""
new="""    function credit(address) external payable {}"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8").write(s.replace(old,new,1))
EOF
run 'nativeEthIsRefused'
restore

echo
echo "############ 5. the balance is written down AFTER the transfer"
echo "##########     (the guard alone still covers it - see 6)"
python3 - <<'EOF'
import io
p="src/curb/FeeEscrow.sol"; s=io.open(p,encoding="utf-8").read()
old="""        _credited[msg.sender][token] = available - amount;"""
assert s.count(old)==1
s=s.replace(old,"",1)
# THE END-OF-FUNCTION EMIT, BY THE LINE AFTER IT. The one-line form also
# matches the 16-space emit inside the ETH branch, so it counted twice.
old2="""        emit Claimed(msg.sender, token, amount);
        if (refused) emit ClaimedAsWrapped(msg.sender, amount);"""
assert s.count(old2)==1, s.count(old2)
io.open(p,"w",encoding="utf-8").write(s.replace(old2,"        _credited[msg.sender][token] = available - amount;\n"+old2,1))
EOF
run 'aReentrantRecipient|aFailedTransferLeaves' m5 green
restore

echo
echo "############ 6. the ordering AND the reentrancy guard both go"
echo "##########     (either one alone is enough, which is why both are removed)"
python3 - <<'EOF'
import io
p="src/curb/FeeEscrow.sol"; s=io.open(p,encoding="utf-8").read()
old="""        _credited[msg.sender][token] = available - amount;"""
assert s.count(old)==1
s=s.replace(old,"",1)
# THE END-OF-FUNCTION EMIT, BY THE LINE AFTER IT. The one-line form also
# matches the 16-space emit inside the ETH branch, so it counted twice.
old2="""        emit Claimed(msg.sender, token, amount);
        if (refused) emit ClaimedAsWrapped(msg.sender, amount);"""
assert s.count(old2)==1, s.count(old2)
s=s.replace(old2,"        _credited[msg.sender][token] = available - amount;\n"+old2,1)
old3="""    function _claim(address token, uint256 amount) private nonReentrant returns (uint256) {"""
assert s.count(old3)==1
s=s.replace(old3,"""    function _claim(address token, uint256 amount) private returns (uint256) {""",1)
io.open(p,"w",encoding="utf-8").write(s)
EOF
run 'aReentrantRecipient'
restore

echo
echo "############ 7. the payment on the way OUT is taken on trust"
# The asymmetry the escrow shipped with: the way IN was measured and the way
# OUT was not, so a token that returned true and paid less cost the claimant
# the difference AND wiped their balance. Measured before the fix: 4e18 owed,
# 3.96e18 paid, balance zero.
python3 - <<'EOF'
import io
p="src/curb/FeeEscrow.sol"; s=io.open(p,encoding="utf-8").read()
old="        if (paid < amount) revert ShortPayment(token, amount, paid);"
assert s.count(old)==1
io.open(p,"w",encoding="utf-8").write(s.replace(old,"        paid;",1))
EOF
run 'aShortPaid|aClaimThatShortPays'
restore

echo
echo "############ 8. SafeERC20 is replaced by a bare transfer on the way out"
python3 - <<'EOF'
import io
p="src/curb/FeeEscrow.sol"; s=io.open(p,encoding="utf-8").read()
old="        IERC20(token).safeTransfer(msg.sender, amount);"
assert s.count(old)==1
io.open(p,"w",encoding="utf-8").write(s.replace(old,"        IERC20(token).transfer(msg.sender, amount);",1))
EOF
run 'aClaimThatReturnsFalse'
restore

echo
echo "############ 9. the escrow's own outflow is not bounded"
# The half the recipient check cannot cover: a token that pays the claimant in
# full and takes more from the escrow. The surplus comes out of what backs
# everybody else's balance, so a shared vault has to be bounded on both sides.
python3 - <<'EOF'
import io
p="src/curb/FeeEscrow.sol"; s=io.open(p,encoding="utf-8").read()
old="        if (taken > amount) revert OverDrawn(token, amount, taken);"
assert s.count(old)==1
io.open(p,"w",encoding="utf-8").write(s.replace(old,"        taken;",1))
EOF
run 'aClaimThatOverDrains'
restore

echo
echo "############ 10. a balance may be credited to the escrow itself"
python3 - <<'EOF'
import io
p="src/curb/FeeEscrow.sol"; s=io.open(p,encoding="utf-8").read()
old="        if (recipient == address(this)) revert RecipientIsTheEscrow();"
assert s.count(old)==1
io.open(p,"w",encoding="utf-8").write(s.replace(old,"",1))
EOF
run 'aBalanceCreditedToTheEscrowItself'
restore

echo
echo "############ restored:"
trap - EXIT
diff -q "$SNAP/escrow.sol" "$E" && echo "  the escrow is byte-identical to the snapshot"
[ "$FAILED" = 0 ] || { echo "  $FAILED VERDICT(S) FAILED - read them above"; exit 1; }
echo "  every mutant was caught (and mutation 5, covered by the guard alone, stayed green)"
