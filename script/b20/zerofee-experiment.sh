#!/usr/bin/env bash
# DID THE FEE TESTS CATCH A ZERO FEE, OR DID THEY NOT?
#
# The commit that fixed `charged = platformAmount + creatorAmount` claimed
# "every fee test still passed" while the pool charged nothing. That was an
# INFERENCE, not an observation: the bug and the partial-fill guard arrived in
# the same patch, so the only run that ever happened had both, and the failures
# it produced all came from the guard.
#
# This runs the two states apart.
set -uo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.foundry/bin:$PATH"
RPC="${RPC:-http://127.0.0.1:8551}"
H=src/curb/FeeHook.sol
SNAP=/tmp/curb-zerofee-snapshot
rm -rf "$SNAP"; mkdir -p "$SNAP"
cp "$H" "$SNAP/hook.sol"
restore() { cp "$SNAP/hook.sol" "$H"; }

run() {
  B20_FORK=true base-forge test --match-path "test/fork/*" \
    --match-test 'aBuyIsCharged|aSellIsCharged|PlatformIsPaidTheSame|PlatformsShareIsTheSame|poolTax_aBuy|poolTax_aSell|FullLifecycle|fullLifecycle|ethBuysAToken|aTokenSellsBackToEth' \
    --fork-url "$RPC" 2>&1 | grep -E "^\[(PASS|FAIL)" | sed 's/ (gas.*//' | sort
}

drop_charged() {
python3 - <<'EOF'
import io
p="src/curb/FeeHook.sol"; s=io.open(p,encoding="utf-8").read()
old="        charged = platformAmount + creatorAmount;\n"
assert s.count(old)==1
io.open(p,"w",encoding="utf-8").write(s.replace(old,"",1))
EOF
}

drop_guard() {
python3 - <<'EOF'
import io
p="src/curb/FeeHook.sol"; s=io.open(p,encoding="utf-8").read()
old="            if (spent != offered) revert PartialFillNotSupported(offered, spent);"
assert s.count(old)==1
io.open(p,"w",encoding="utf-8").write(s.replace(old,"            spent; offered;",1))
EOF
}

echo "########## 0. UNMUTATED"
run

echo
echo "########## A. the summing line removed, the fill guard LEFT IN"
echo "##########    (this is the state the bug was actually in)"
drop_charged
run
restore

echo
echo "########## B. the summing line removed AND the fill guard removed"
echo "##########    (does the fee arithmetic alone catch a zero fee?)"
drop_charged
drop_guard
run
restore

echo
echo "########## restored:"
diff -q "$SNAP/hook.sol" "$H" && echo "  the hook is byte-identical to the snapshot"
