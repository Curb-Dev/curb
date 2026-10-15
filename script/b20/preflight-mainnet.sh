#!/usr/bin/env bash
# EVERYTHING BEFORE THE SIGNATURE, DONE IN ONE GO.
#
#   CURB_PLATFORM_RECIPIENT=0x... CURB_POLICY_OWNER=0x... CURB_DEPLOYER=0x... \
#   CURB_SHARING_PUBLISHER=0x... CURB_SHARING_KEEPER_PAYEE=0x... \
#   CURB_SHARING_VETOERS=0x...[,0x...] \
#   CURB_FIRST_LAUNCH=1 CURB_FIRST_NAME=... CURB_FIRST_SYMBOL=... CURB_FIRST_URI=... \
#   CURB_FIRST_TAX_BPS=... CURB_FIRST_CREATOR=0x... CURB_FIRST_DEV_BUY=<wei> CURB_FIRST_SHARE=1 \
#   CURB_WALLET_OPTION=--ledger \
#     bash script/b20/preflight-mainnet.sh
#
#   RUN IT IN WSL, where base-forge and base-cast are (B20_ENVIRONMENT.txt).
#   A Ledger or Trezor is attached to WSL with usbipd before it starts: the
#   preflight asks the device for the deployer's address (signer_check).
#
#   bash script/b20/preflight-mainnet.sh --selftest
#     checks this file's own parsing against fixed inputs, and runs DEPLOY.txt
#     STEP 6's by-hand command - no chain, no forge, no key. Run it after
#     editing anything below, or STEP 6.
#
#   bash script/b20/preflight-mainnet.sh --recheck-resume <commit> <deployer> <endpoint>
#     the start of the RESUME command this prints, for a broadcast that died
#     part way: recheck's questions, a record to resume with nothing reverted,
#     its copy kept and its cache half naming that endpoint
#     (records_resumable), and the commit or one that only adds that copy.
#
#   CURB_DEPLOYER=0x... CURB_REGISTRY=0x... CURB_WALLET_OPTION=--ledger \
#     bash script/b20/preflight-mainnet.sh --asset <label>
#     the same before an asset is added after launch (asset_run): section 1,
#     script/DeployAssetStack.s.sol simulated against live Base, that asset's
#     dollar start and graduation at Chainlink's price, the funding, and the
#     command to sign behind --recheck-asset <commit> <label>, with the Safe's
#     call and its dollars printed beside each other (DEPLOY.txt, ADDING A
#     QUOTE ASSET AFTER LAUNCH).
#
#   bash script/b20/preflight-mainnet.sh --recheck <commit>
#     the start of the command this prints (recheck below says why). It
#     repeats section 1's checks in the shell that signs, and nothing else. Its
#     messages go to stderr; its stdout is one line, "recheck passed <commit>",
#     printed once every check has passed, and the command starts forge only
#     on that line (print_command says why).
#
# A1 is one irreversible transaction set and six decisions, some of which
# cannot be corrected afterwards for launches already made (DEPLOY.txt). This runs every check that can be made WITHOUT a key -
# the suites, a simulation against live Base, and a read-back of what the
# deployment would actually be - and then prints the one command you sign.
#
# IT NEVER BROADCASTS AND NEVER TOUCHES A KEY. It takes ADDRESSES, not secrets.
# If it ever asks you for a private key or a seed phrase, something is wrong
# and you should stop. The one credential it looks at is BASESCAN_API_KEY - an
# explorer key, not a signing key - and only to see that it is set, because the
# printed command verifies with it. Its value is never printed.
#
# THE DEMO FLAG IS NOT PASSED AND MUST NOT BE. A demo launch on a real chain is
# written into the registry as launch number one, permanently.
set -uo pipefail
# EVERY PATH BELOW IS RELATIVE TO THE REPOSITORY ROOT, and so is the .env that
# forge would load. Run from anywhere, it used to read whatever directory the
# shell happened to be in.
#
# WHERE IT WAS STARTED FROM IS KEPT, for --recheck: the command it prints runs
# forge with relative paths from the shell's own directory, and forge loads a
# .env from there too.
#
# CDPATH IS DROPPED FIRST. The cd below names a relative path, which bash looks
# up in an exported CDPATH: CDPATH=/another/checkout sent the run into that
# checkout (the recheck then stopped a clean tree, finding its root elsewhere),
# and CDPATH=.: made cd print the directory on stdout, where --recheck's one
# line has to be the only thing.
unset CDPATH
CALLER_DIR="$(pwd -P)"
cd "$(dirname "$0")/../.." || { echo "cannot enter the repository root"; exit 1; }
SELF="$PWD/script/b20/$(basename "$0")"   # the selftest copies this file

RPC="${CURB_MAINNET_RPC:-https://mainnet.base.org}"
FORGE="${FORGE_BIN:-$HOME/.foundry/bin/base-forge}"
CAST="${CAST_BIN:-$HOME/.foundry/bin/base-cast}"
fail() { printf '\n  STOP: %s\n' "$1"; exit 1; }
ok()   { printf '  ok    %s\n' "$1"; }

# ============================================================================
# THE PARSING, AS FUNCTIONS, so --selftest can put fixed inputs through the
# same code the real run uses. Every one of these was wrong once in a way no
# run showed: it printed a plausible number or a clean tree.
# ============================================================================

# HOW MANY TESTS WERE SKIPPED, counted ONCE. forge prints the count twice - on
# each suite's line ("1 passed; 0 failed; 1 skipped; finished") and again in the
# run's summary ("1 tests passed, 0 failed, 1 skipped (2 total tests)") - and
# summing every "N skipped" reported twice as many as were skipped. Only the
# per-suite lines end the count with a semicolon.
skipped_count() { # log file
  grep -Eo '[0-9]+ skipped;' "$1" | grep -Eo '[0-9]+' | awk '{s+=$1} END {print s+0}'
}

# WHICH STATUS ENTRIES MAKE THE TREE UNFIT TO RECORD. Reads `git status
# --porcelain -z` on stdin and prints one entry per line.
#
# -z, BECAUSE GIT QUOTES. Without it a path with a space or a non-ASCII
# character comes out as ?? "src/a b.sol", which the pattern below did not
# match - so an untracked source with a quoted name, compiled into the
# deployment, left the tree reading as clean.
#
# UNTRACKED FILES COUNT WHERE THEY CAN BE COMPILED: src/, script/, lib/.
# Untracked files elsewhere (audit notes, scratch) do not. Every tracked change
# counts. A rename's second record (its old path) is kept too, which is
# harmless: the rename itself already made the tree dirty. The NULs become
# newlines for awk (mawk has no NUL record separator); a path that itself holds
# a newline then splits into a record without the ?? prefix, which counts as
# dirty - the safe direction.
#
# IGNORED FILES (git's !! entries, tree_status says why they are asked for)
# COUNT WHERE forge CAN READ THEM: any .sol file in the gate's paths, whatever
# the case of its extension, and anything at all under src/, script/ or lib/,
# whatever its name - an import names a path, not a kind of file, and lib/ is
# where forge looks for vendored libraries when it works out remappings. Two
# kinds of file that the runbook's own tools write there and that no build
# reads are left out: Python bytecode (.pyc, which python drops into
# script/b20/__pycache__/) and script/b20/.wallet-session.json - the founder's
# checkout holds both, and a gate that every correct tree fails trains people
# to ignore it. The build's own output - out/, cache/ and broadcast/ at the
# repository root - is outside the paths, so git never lists it here.
dirty_entries() {
  tr '\0' '\n' | awk '
    !NF { next }
    /^!! / {
      p = substr($0, 4)
      if (tolower(p) ~ /\.sol$/ || (p ~ /^(src|script|lib)\// && p !~ /\.pyc$/ && p != "script/b20/.wallet-session.json"))
        print $0 "  <- ignored by git, but forge would compile it or an import could reach it: remove it, or commit it (git check-ignore -v names the rule that hides it)"
      next
    }
    !/^\?\? / || /^\?\? (src|script|lib)\// { print }'
}

# SETTINGS OUTSIDE THE TREE THAT CHANGE WHAT forge BUILDS. foundry.toml is
# checked by git; these are not. A FOUNDRY_* (or legacy DAPP_*) variable in the
# shell overrides foundry.toml - FOUNDRY_OPTIMIZER_RUNS, FOUNDRY_VIA_IR,
# FOUNDRY_PROFILE - and forge loads a .env in the project root by itself, which
# .gitignore hides from git. Either way the recorded commit would not
# reproduce the bytecode that went on chain, which is exactly what the tree
# check exists to prevent. Prints one line per setting found.
#
# IN ANY CASE. forge reads FOUNDRY_ and DAPP_ through figment, which matches
# either prefix whatever its case: with base-forge 1.6.0,
# foundry_optimizer_runs=1, foundry_broadcast=elsewhere and
# Foundry_Bytecode_Hash=none each change what `forge config` reports, and so
# do DAPP_OPTIMIZER_RUNS=7, dapp_optimizer_runs=7 and Dapp_Optimizer_Runs=7
# (optimizer_runs 200 -> 7). The pattern here, matching capitals only, let the
# lower- and mixed-case ones through; both families are now refused whatever
# their case.
#
# AND THE GLOBAL CONFIG. forge merges ~/.foundry/foundry.toml under the
# project's, so any key foundry.toml does not set - bytecode_hash,
# cbor_metadata, revert_strings, optimizer_details, remappings - comes from
# there, outside the repository, where no commit records it.
build_overrides() { # repo root, foundry home (~/.foundry)
  env | grep -Eio '^(FOUNDRY|DAPP)_[A-Za-z0-9_]*' | sort -u | sed 's/^/environment variable /'
  [ -e "$1/.env" ] && echo "$1/.env (forge loads it without being asked)"
  [ -n "${2:-}" ] && [ -e "$2/foundry.toml" ] && echo "$2/foundry.toml (forge merges it under the project's)"
  return 0
}

# SETTINGS IN THE SHELL THAT CHANGE WHAT forge SENDS, not what it builds. SOME
# flags of forge script that the command leaves out are read from the
# environment instead (base-forge script --help marks them "[env: ...]").
# ETH_GAS_PRICE and ETH_PRIORITY_GAS_PRICE price every transaction of the
# broadcast: one left at 1gwei pays about a hundred times the simulated price,
# and a deployer funded for the simulation runs dry partway, leaving a
# half-wired deployment. VERIFIER_URL and VERIFIER_API_KEY send the sources,
# and a key, to another verifier, and the hook stays unverified on Basescan.
# ETH_KEYSTORE, ETH_KEYSTORE_ACCOUNT and ETH_PASSWORD add a keystore signer
# beside the wallet option.
#
# THE WHOLE FAMILIES ARE REFUSED, NOT ONLY THE NAMES forge READS. Others -
# ETH_RPC_URL and ETH_FROM, which cast users export, are two - forge script
# does not read at all, and they are refused all the same: a read that a later
# forge adds is then refused too, and the shell that signs has no reason to
# hold any of them. The refusals say exactly that, and no more: they once
# claimed that forge read every one of them in place of a flag. Prints one
# line per variable found.
#
# EXCEPT ETHERSCAN_API_KEY, WHICH THE COMMAND SETS ITSELF from
# BASESCAN_API_KEY (print_command), so what the shell exports under that name
# never reaches forge.
send_overrides() {
  env | grep -Eo '^(ETH|ETHERSCAN|VERIFIER)_[A-Za-z0-9_]*' | grep -vx ETHERSCAN_API_KEY | sort -u \
    | sed 's/^/environment variable /'
  return 0
}

# THE SIX OPT-INS, EACH EXACTLY true OR false, OR UNSET (CURB_ALLOW_EOA_CREATOR,
# the sixth, says $CURB's creator may be one key). The deploy script
# reads them with vm.envOr(name, false), and base-forge 1.6.0 reads more than
# those two words: TRUE, True and 1 as true, 0 as false, and whatever it
# cannot parse at all - yes, ' true', 'false;', an empty value - as false,
# without a word. So a value other than true or false decided an opt-in in a
# way nobody chose to write down - while the printed command wrote the same
# value bare, where a trailing ;, & or newline ended the "--recheck ... &&"
# command early and forge then ran whether or not the recheck had passed. A
# value that is set but empty is refused too: unset it.
# Prints one line per value refused, shell-quoted, since the value is exactly
# what may hold a character the terminal would not show.
ALLOW_NAMES=(CURB_ALLOW_EOA_RECIPIENT CURB_ALLOW_NON_SAFE_RECIPIENT CURB_ALLOW_EOA_POLICY_OWNER
  CURB_ALLOW_NON_SAFE_POLICY_OWNER CURB_ALLOW_SAME_RECIPIENT_AND_OWNER CURB_ALLOW_EOA_CREATOR)
allow_values_bad() {
  local name
  for name in "${ALLOW_NAMES[@]}"; do
    [ -n "${!name+set}" ] || continue
    case "${!name}" in
      true|false) ;;
      *) printf '%s=%q\n' "$name" "${!name}" ;;
    esac
  done
  return 0
}

# WHAT KIND OF ADDRESS, FROM WHAT `cast code` RETURNED. Refuses anything that is
# not hex: a failed read used to be substituted with 0x and printed as "ONE KEY
# (no code)", which is the one answer that looks like information.
code_kind() { # code
  local code="$1" size
  [[ "$code" =~ ^0x([0-9a-fA-F]{2})*$ ]] || return 1
  size=$(( (${#code} - 2) / 2 ))
  if [ "$size" -eq 0 ]; then echo "ONE KEY (no code)"; return 0; fi
  # AN EIP-7702 DELEGATION IS STILL ONE KEY: 23 bytes, 0xef0100 || delegate.
  case "$code" in
    0xef0100*|0xEF0100*) [ "$size" -eq 23 ] && { echo "ONE KEY (an EOA with an EIP-7702 delegation)"; return 0; } ;;
  esac
  echo "a contract, $size bytes"
}

# AN ADDRESS, AS THE SHELL HOLDS IT: 0x and forty hex digits, nothing else -
# AND, WRITTEN IN MIXED CASE, ITS EIP-55 CHECKSUM. Mixed case is a checksum,
# and one mistyped digit in a checksummed address used to pass every gate here
# as another valid address nobody holds: section 3 read it as "ONE KEY (no
# code), balance 0", exactly like an unused real one. An address in one case
# carries no checksum and is taken as written (DEPLOY.txt asks for every role
# address checksummed; section 3 notes one that is not). The keccak is
# python's, written out below, since hashlib's sha3_256 is not Keccak-256; the
# letters are matched as lists, not ranges, so no locale reads [a-f] as more.
EIP55_PY='
import sys
def keccak256(data):
    M = (1 << 64) - 1
    rate, s = 136, [0] * 25
    data = bytearray(data) + b"\x01"
    data += b"\x00" * (-len(data) % rate)
    data[-1] |= 0x80
    for off in range(0, len(data), rate):
        for i in range(rate // 8):
            s[i] ^= int.from_bytes(data[off + 8 * i:off + 8 * i + 8], "little")
        r = 1
        for _ in range(24):
            c = [s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20] for x in range(5)]
            for x in range(5):
                d = c[(x + 4) % 5] ^ (((c[(x + 1) % 5] << 1) | (c[(x + 1) % 5] >> 63)) & M)
                for y in range(0, 25, 5):
                    s[x + y] ^= d
            x, y, cur = 1, 0, s[1]
            for t in range(24):
                x, y = y, (2 * x + 3 * y) % 5
                n = ((t + 1) * (t + 2) // 2) % 64
                cur, s[x + 5 * y] = s[x + 5 * y], ((cur << n) | (cur >> (64 - n))) & M
            for y in range(0, 25, 5):
                row = s[y:y + 5]
                for x in range(5):
                    s[x + y] = row[x] ^ (~row[(x + 1) % 5] & row[(x + 2) % 5])
            for j in range(7):
                r = ((r << 1) ^ ((r >> 7) * 0x71)) % 256
                if r & 2:
                    s[0] ^= 1 << ((1 << j) - 1)
    return b"".join(v.to_bytes(8, "little") for v in s)[:32]
a = sys.argv[1][2:]
h = keccak256(a.lower().encode()).hex()
want = "".join(ch.upper() if int(h[i], 16) >= 8 else ch for i, ch in enumerate(a.lower()))
sys.exit(0 if want == a else 1)
'
address_ok() {
  [[ "$1" =~ ^0x[0-9a-fA-F]{40}$ ]] || return 1
  [[ "${1:2}" == *[abcdef]* && "${1:2}" == *[ABCDEF]* ]] || return 0
  python3 -c "$EIP55_PY" "$1" 2>/dev/null
}

# ONE ADDRESS THE RUN NEEDS, from the shell: set, and an address (address_ok,
# its checksum included). Stops otherwise.
need() {
  local name="$1" val="${!1:-}"
  [ -n "$val" ] || fail "$name is not set. See DEPLOY.txt - it is one of the six decisions (or, for an asset run, ADDING A QUOTE ASSET)."
  address_ok "$val" \
    || fail "$name is not an address, or it is written in mixed case and that is not its EIP-55 checksum - one mistyped character reads like this; copy it again: $val"
}

# A LIST OF ADDRESSES, comma-separated with no spaces, at least one - the form
# DeployCurb reads CURB_SHARING_VETOERS in (vm.envOr with ","). An empty
# entry, a space or another separator is refused here rather than read by
# forge some other way.
address_list_ok() {
  local IFS=, a
  [ -n "$1" ] || return 1
  [[ "$1" != *, && "$1" != ,* && "$1" != *,,* ]] || return 1
  for a in $1; do address_ok "$a" || return 1; done
}

# THE HOLDER SHARING ROLES, ASKED BEFORE THE SUITES' TIME IS SPENT. DeployCurb
# refuses the same (checkSharingRoles) and is what decides; this says so first.
# A vetoer is there to stop the publisher, so none may be the publisher; the
# policy owner is a vetoer already and in the list would read as a separate
# one; and no vetoer twice. Case-insensitive: one address in checksum form and
# in lower case is one address. Prints one line per problem.
sharing_roles_bad() { # publisher, policy owner, vetoer list (already address_list_ok)
  local IFS=, v seen=","
  for v in $3; do
    [ "${v,,}" != "${1,,}" ] || echo "the vetoer $v is the sharing publisher: a vetoer is there to stop the publisher's payouts"
    [ "${v,,}" != "${2,,}" ] || echo "the vetoer $v is the policy owner, which is a vetoer already: list only the separate vetoers"
    [[ "$seen" != *",${v,,},"* ]] || echo "the vetoer $v is listed twice"
    seen+="${v,,},"
  done
  return 0
}

# THE SIMULATION RAN THE SCRIPT THAT CHECKS THE UNCHANGED CODE. DeployCurb
# refuses to send anything when the five contracts core v2 leaves unchanged
# do not build to their pinned identities, and says so in one line when they
# do; a run without that line is a script that did not check.
sim_checked_code() { # sim log
  grep -q "code identities match the pinned ones" "$1"
}

# THE WALLET OPTION, ONE OF THE FOUR THE RUNBOOK LISTS. The printed command used
# to end in --ledger whatever the operator used, while the text said to pick
# one and DEPLOY.txt said to run it exactly - so a keystore or Trezor user
# following both would pass two wallet options at the one irreversible step.
#
# A HARDWARE WALLET MAY NAME ITS ACCOUNT. Alone, --ledger and --trezor derive
# only the device's first account, so a deployer that is its second account, or
# sits on a legacy path, matched no signer and the only way through was the
# hand edit STEP 4 forbids. So either may be followed by exactly one of the two
# selectors this forge takes for hardware wallets (base-forge script --help):
# --mnemonic-indexes <one index> or --mnemonic-derivation-paths <one path>.
# One account, never a list: the command signs as one --sender. The path is
# digits, slashes and hardened marks only, which is also what makes it safe to
# print inside double quotes (wallet_words).
wallet_option_ok() { # option
  [[ "$1" =~ ^(--ledger|--trezor)(\ --mnemonic-indexes\ [0-9]+|\ --mnemonic-derivation-paths\ m(/[0-9]+\'?)+)?$ ]] \
    || [[ "$1" =~ ^(--account\ [A-Za-z0-9._-]+|--interactives\ 1)$ ]]
}

# THE WALLET OPTION AS SHELL WORDS. A derivation path carries hardened marks
# (m/44'/60'/0'/0/1), and printed bare the shell would read each ' as a quote
# and the command would not run - or run as something else. Quoted, it reaches
# forge as the one argument it is.
wallet_words() { # option (already accepted by wallet_option_ok, or empty)
  if [[ "$1" =~ ^(--ledger|--trezor)\ --mnemonic-derivation-paths\ (.+)$ ]]; then
    printf '%s --mnemonic-derivation-paths "%s"' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
  else
    printf '%s' "$1"
  fi
}

# THE EXPLORER KEY THE COMMAND VERIFIES WITH: set, and one word. Only the
# answer is printed, never the value. Unset, the command's --etherscan-api-key
# (as it then was) swallowed the next flag and forge refused it at the
# irreversible step, which pushed the operator to edit the command by hand;
# now it would reach forge empty, and --verify would fail only after the
# broadcast (print_command). Whether the key is VALID is
# not knowable without sending it to the explorer, which this does not do; a
# wrong key shows only after the broadcast, and DEPLOY.txt STEP 6 is the
# by-hand route then.
explorer_key_ok() {
  [[ "${BASESCAN_API_KEY:-}" =~ ^[^[:space:]]+$ ]]
}

# THE FIRST LAUNCH, $CURB (DeployCurb's FirstLaunch), AS THE SHELL HOLDS IT.
# CURB_FIRST_LAUNCH MUST BE SAID, 1 OR 0. $CURB is decided to be the WETH
# factory's first launch, and the Launches hero features the registry's first
# ETH pair for good: 1 launches it inside the broadcast, in the transaction
# right after the WETH factory's admission, which is the run's first - every
# stack is built before it and every other factory admitted after $CURB, so
# one receipt is open to anybody else and only on the WETH factory, where
# wiring the WETH factory first used to leave some fifty-five and admitting it
# last left every other factory open; 0 leaves it to a launch made by hand
# afterwards, which races everybody watching the chain once the factories are
# admitted. Unset is refused rather than read as either.
#
# THE TEXTS ARE PRINTABLE ASCII. They go into the printed command shell-quoted
# (first_words), and printf %q writes anything else in a form only some shells
# read back; they are written into the token for good, so a character the
# terminal does not show is refused too. DeployCurb asks the rest - and the
# factory decides the tax band and the dev buy's cap, in the simulation.
FIRST_NAMES=(CURB_FIRST_NAME CURB_FIRST_SYMBOL CURB_FIRST_URI CURB_FIRST_TAX_BPS CURB_FIRST_CREATOR
  CURB_FIRST_DEV_BUY CURB_FIRST_SHARE)
first_launch_bad() { # deployer; prints one line per problem
  local dep="$1" v
  case "${CURB_FIRST_LAUNCH-}" in
    1) ;;
    0) return 0 ;;
    *) printf 'CURB_FIRST_LAUNCH must be exactly 1 or 0, not %q. 1 launches $CURB as the WETH factory'"'"'s first launch inside the broadcast (DEPLOY.txt decision 6); 0 leaves it to be made by hand.\n' \
         "${CURB_FIRST_LAUNCH-(unset)}"; return 0 ;;
  esac
  for v in "${FIRST_NAMES[@]}"; do
    [ -n "${!v+set}" ] || echo "$v is not set: CURB_FIRST_LAUNCH=1 needs every CURB_FIRST_* variable"
  done
  for v in CURB_FIRST_NAME CURB_FIRST_SYMBOL; do
    [ -n "${!v-}" ] || echo "$v is empty: it is written into \$CURB for good"
  done
  for v in CURB_FIRST_NAME CURB_FIRST_SYMBOL CURB_FIRST_URI; do
    LC_ALL=C bash -c '[[ "$1" =~ ^[[:print:]]*$ ]]' _ "${!v-}" \
      || echo "$v holds a character that is not printable ASCII: it is written into \$CURB for good, and printed into the command"
    # forge trims the spaces around a value before the script reads it, so
    # the token would not hold what was checked here.
    case "${!v-}" in " "*|*" ") echo "$v starts or ends with a space, which forge drops before the script reads it" ;; esac
  done
  [[ "${CURB_FIRST_TAX_BPS-}" =~ ^[0-9]{1,5}$ ]] && [ "${CURB_FIRST_TAX_BPS}" -ge 100 ] && [ "${CURB_FIRST_TAX_BPS}" -le 500 ] \
    || echo "CURB_FIRST_TAX_BPS must be plain digits from 100 to 500, the factory's band"
  if address_ok "${CURB_FIRST_CREATOR-}"; then
    [ "${CURB_FIRST_CREATOR,,}" != "0x0000000000000000000000000000000000000000" ] \
      || echo "CURB_FIRST_CREATOR is the zero address, which would make the deployer \$CURB's creator for good"
    [ "${CURB_FIRST_CREATOR,,}" != "${dep,,}" ] \
      || echo "CURB_FIRST_CREATOR is the deployer: a hot key would be \$CURB's creator and own its locked position for good"
  else
    echo "CURB_FIRST_CREATOR is not an address"
  fi
  [[ "${CURB_FIRST_DEV_BUY-}" =~ ^[0-9]{1,30}$ ]] || echo "CURB_FIRST_DEV_BUY must be plain digits: wei of ether, 0 for none"
  case "${CURB_FIRST_SHARE-}" in 0|1) ;; *) echo "CURB_FIRST_SHARE must be exactly 1 or 0" ;; esac
  return 0
}

# ONE AMOUNT OF WEI BELOW ANOTHER, both plain digits, compared in bash alone:
# a dev buy may run past 64 bits (first_launch_bad allows 30 digits), and the
# selftest's main run stands in a python3 that does nothing.
wei_below() { # a, b (plain digits); true when a < b
  local a="${1#"${1%%[!0]*}"}" b="${2#"${2%%[!0]*}"}"
  [ "${#a}" -eq "${#b}" ] || { [ "${#a}" -lt "${#b}" ]; return; }
  [[ "$a" < "$b" ]]
}

# THE FIRST LAUNCH'S LINES OF THE COMMAND, each a shell word (printf %q), so a
# name with a space or a quote reaches forge as it was checked.
first_words() {
  printf '   CURB_FIRST_LAUNCH=%q \\\n' "${CURB_FIRST_LAUNCH-}"
  [ "${CURB_FIRST_LAUNCH-}" = 1 ] || return 0
  local v
  for v in "${FIRST_NAMES[@]}"; do printf '   %s=%q \\\n' "$v" "${!v-}"; done
}

# THE SIGNER, ASKED - for a hardware wallet, which answers with its address
# and asks for nothing secret. The deployer used to be checked only by forge,
# at the one irreversible step: a device not attached to WSL (it needs
# usbipd), locked, or on another account stalled the launch day there.
#
# THE SAME ACCOUNT AS THE COMMAND: forge script takes --mnemonic-indexes and
# --mnemonic-derivation-paths, cast wallet address the singular forms, and both
# derive the same path from them. A keystore (--account) would ask for its
# password and --interactives for the key itself, so those are not asked here;
# the by-hand line is printed instead.
signer_args() { # wallet option (already wallet_option_ok); prints cast's arguments, one per line, or nothing
  if [[ "$1" =~ ^(--ledger|--trezor)$ ]]; then
    printf '%s\n' "$1"
  elif [[ "$1" =~ ^(--ledger|--trezor)\ --mnemonic-indexes\ ([0-9]+)$ ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}" --mnemonic-index "${BASH_REMATCH[2]}"
  elif [[ "$1" =~ ^(--ledger|--trezor)\ --mnemonic-derivation-paths\ (.+)$ ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}" --mnemonic-derivation-path "${BASH_REMATCH[2]}"
  fi
}
signer_check() { # wallet option, deployer
  local args=() got
  mapfile -t args < <(signer_args "$1")
  if [ "${#args[@]}" -eq 0 ]; then
    echo "  note  the signer is NOT asked here: $1 would ask for a password or a key, which this never does."
    case "$1" in
      --account\ *) echo "        Before STEP 4 run  $CAST wallet address $1  yourself and see that it prints $2." ;;
      *) echo "        Before STEP 4 run  $CAST wallet address --interactive  yourself and see that it prints $2." ;;
    esac
    return 0
  fi
  got="$("$CAST" wallet address "${args[@]}" 2>/dev/null | tr -d '\r' | tail -1)"
  address_ok "$got" \
    || fail "the hardware wallet ($1) did not answer with its address. Run this in WSL, where base-forge is; attach the device to WSL first (from an administrator PowerShell: usbipd list, then usbipd attach --wsl --busid <its bus id>), unlock it and open its Ethereum app. Nothing was signed."
  [ "${got,,}" = "${2,,}" ] \
    || fail "the wallet option $1 signs as $got, not as CURB_DEPLOYER $2. Pick the device account that is the deployer (--mnemonic-indexes <n> or --mnemonic-derivation-paths <path> in CURB_WALLET_OPTION), or correct CURB_DEPLOYER."
  ok "the wallet option $1 signs as CURB_DEPLOYER $2"
}

# THE DOLLAR SHAPE AT TODAY'S PRICES. Every asset's phantom and threshold are
# written in its own units at the prices they were sized at (DeployCurb's
# quoteAssets()), and both are immutable per factory: a price that has moved
# since takes every launch on that asset, $CURB included, off the decided
# shape - start about $4,000, graduate about $55,000 - for good. So each
# asset's start (the phantom) and graduation ((phantom + threshold)^2 /
# phantom), as the simulation printed them, are priced at Chainlink's answer
# now, and the preflight stops when either is more than USD_TOLERANCE_PCT off.
# The cure is re-pricing quoteAssets() (script/b20/measure-thresholds.js) in a
# commit of its own, not widening the band.
#
# THE FEED FOR EACH ASSET IS THE ONE THE SITE PRICES IT BY (web/prices.js
# USD_FEEDS) AND THE KEEPER TOO (services/sharer/deploy/sharer.example.json):
# the two must name the same feed, the feed must name itself on chain as the
# site expects, and its answer must be under FEED_MAX_AGE_H hours old (the
# equity feeds keep US market hours, so a weekend's answer is Friday's close).
#
# IN BOTH DIRECTIONS. feed_table only refused a feed the keeper named and the
# site did not, so an asset the site already prices (TSLAc, MSTRc and the other
# equities prices.js holds ahead of any listing) passed section 6 listed with no
# keeper feed at all - and the keeper config generated from the example then
# priced that asset's keeper fee at 0 ("A price is missing") and held its
# epochs for the seven-day rule. Each line now says whether the keeper's copy
# names the asset too (keeper, or site-only), and feed_of refuses site-only.
USD_START=4000
USD_GRADUATION=55000
USD_TOLERANCE_PCT=5
FEED_MAX_AGE_H=96
feed_table() { # prices.js, sharer.example.json; prints "asset feed keeper|site-only description" lines, or PROBLEM lines and exits 1
  python3 - "$1" "$2" <<'PY'
import json, re, sys
js = open(sys.argv[1], encoding="utf-8").read()
weth = re.search(r'const WETH = "(0x[0-9a-fA-F]{40})"', js)
body = re.search(r"const USD_FEEDS = \{(.*?)\n\};", js, re.S)
problems = []
if not weth or not body:
    print("PROBLEM web/prices.js holds no WETH constant or USD_FEEDS table to read")
    sys.exit(1)
site = {}
for key, feed, desc in re.findall(r'(\[WETH\]|"0x[0-9a-fA-F]{40}")\s*:\s*\[\s*"(0x[0-9a-fA-F]{40})"\s*,\s*"([^"]+)"\s*\]', body.group(1)):
    asset = weth.group(1) if key == "[WETH]" else key.strip('"')
    site[asset.lower()] = (feed.lower(), desc)
cfg = json.load(open(sys.argv[2], encoding="utf-8"))
eth = (cfg.get("ethUsdFeed") or "").lower()
w = weth.group(1).lower()
if w not in site:
    problems.append("web/prices.js names no feed for WETH")
elif site[w][0] != eth:
    problems.append(f"WETH: web/prices.js names the feed {site[w][0]}, sharer.example.json's ethUsdFeed {eth}")
for asset, f in (cfg.get("sharing", {}).get("feeds") or {}).items():
    a = asset.lower()
    if (f.get("ethUsd") or "").lower() != eth:
        problems.append(f"{a}: sharer.example.json's ethUsd is not its ethUsdFeed")
    if a not in site:
        problems.append(f"{a}: sharer.example.json names a feed and web/prices.js none")
    elif site[a][0] != (f.get("quoteUsd") or "").lower():
        problems.append(f"{a}: web/prices.js names the feed {site[a][0]}, sharer.example.json {f.get('quoteUsd')}")
for p in problems:
    print("PROBLEM " + p)
if problems:
    sys.exit(1)
# WHAT THE KEEPER'S COPY NAMES: every sharing.feeds asset (each checked above
# against the site's feed), and WETH, which it prices by ethUsdFeed.
kept = {w} | {a.lower() for a in (cfg.get("sharing", {}).get("feeds") or {})}
for a, (feed, desc) in sorted(site.items()):
    print(a, feed, "keeper" if a in kept else "site-only", desc)
PY
}

# ONE LISTED ASSET'S FEED, OUT OF feed_table's lines: "feed description", or a
# PROBLEM line when web/prices.js names no feed for it, or when it does and
# sharer.example.json's sharing.feeds does not (WETH aside, which the keeper
# prices by ethUsdFeed, and feed_table checks that).
feed_of() { # feed_table's lines, label, quote
  local line
  line="$(printf '%s\n' "$1" | awk -v q="${3,,}" '$1 == q')"
  if [ -z "$line" ]; then
    echo "PROBLEM $2 ($3) has no Chainlink feed in web/prices.js and sharer.example.json. Add the asset's feed to both (the site and the keeper price by it) before deploying it."
  elif [ "$(awk '{print $3}' <<<"$line")" != keeper ]; then
    echo "PROBLEM $2 ($3) has no feed in services/sharer/deploy/sharer.example.json sharing.feeds; add the same feed web/prices.js names. The keeper's config is generated from that file, and without it the asset's keeper fee prices to 0 and its epochs wait for the seven-day rule."
  else
    cut -d' ' -f2,4- <<<"$line"
  fi
}

# THE ARITHMETIC, PURE: one line per asset in, on stdin -
#   label decimals phantom threshold feed-decimals answer updated-at description expected-description
# - and the now it is judged at as the argument (seconds). Prints a table line
# per asset, and a PROBLEM line for each figure out of the band, each stale or
# unnamed feed and each answer that is not a price. Exact decimals, no floats.
usd_shape_bad() { # now
  python3 -c '
import sys
from decimal import Decimal, getcontext
getcontext().prec = 60
now = int(sys.argv[1]); start, grad, tol, age_h = (Decimal(sys.argv[i]) for i in range(2, 6))
for line in sys.stdin:
    f = line.rstrip("\n").split("\t")
    if len(f) != 9:
        print("PROBLEM a line the dollar check cannot read: " + line.strip()); continue
    label, dec, ph, th, fdec, ans, upd, desc, want = f
    if desc != want:
        print(f"PROBLEM {label}: its feed calls itself {desc!r}, not {want!r} - not the feed the site prices it by"); continue
    if int(ans) <= 0:
        print(f"PROBLEM {label}: its feed answers {ans}, which is not a price"); continue
    age = (now - int(upd)) / 3600
    if age > float(age_h):
        print(f"PROBLEM {label}: its feed last answered {age:.0f} hours ago, more than {age_h} - too stale to size by"); continue
    price = Decimal(int(ans)) / Decimal(10) ** int(fdec)
    unit = Decimal(10) ** int(dec)
    v, t = Decimal(int(ph)) / unit, Decimal(int(th)) / unit
    s = v * price
    g = (v + t) * (v + t) / v * price
    print(f"        {label:<8} ${price:,.4f}  starts at ${s:,.0f}  graduates at ${g:,.0f}  (feed {age:.0f} h old)")
    for what, got, aim in (("starts", s, start), ("graduates", g, grad)):
        off = (got - aim) / aim * 100
        if abs(off) > tol:
            print(f"PROBLEM {label}: {what} at ${got:,.0f} at today'"'"'s price, {off:+.1f}% from ${aim:,.0f} - more than {tol}% off. Re-price it in DeployCurb.quoteAssets() (measure-thresholds.js) in a commit of its own")
' "$1" "$USD_START" "$USD_GRADUATION" "$USD_TOLERANCE_PCT" "$FEED_MAX_AGE_H"
}

# A WORD READ RAW (cast call with no return type), decoded by the caller.
feed_read() { # feed, signature
  local out
  out="$("$CAST" call "$1" "$2" --rpc-url "$RPC" 2>/dev/null)" || return 1
  [[ "$out" =~ ^0x[0-9a-fA-F]+$ ]] || return 1
  printf '%s' "$out"
}

# THE RECORD A RESUME CONTINUES, asked before forge resumes it. forge script
# --resume sends what broadcast/DeployCurb.s.sol/8453/run-latest.json says was
# not confirmed, and rewrites that file as it goes, so: the file must exist and
# be the mainnet run's - every transaction from CURB_DEPLOYER - with something
# left to send; and its copy must already be at deployments/base-mainnet/run.json,
# byte for byte, so that what landed before the resume is kept whatever the
# resume does (DEPLOY.txt, A PARTIAL DEPLOYMENT).
#
# NO TRANSACTION OF IT MAY HAVE REVERTED. One that did - admitInitial past the
# catalog's day, a nonce taken by something else - still leaves receipts
# short of transactions, which read as "something left to send", and forge
# would send the rest into a state that moved. DEPLOY.txt said a reverted
# transaction is not resumed; nothing asked it.
#
# AND THE RECORD'S OTHER HALF MUST BE THIS RUN'S. forge keeps the endpoint of
# each transaction apart from the record, in
# cache/DeployCurb.s.sol/8453/run-latest.json, and --resume reads both: the
# transactions from the record, where to send them from the cache half.
# FOUNDRY_BROADCAST moves only the record, so any later run against a node
# serving chain 8453 - a fork, the browser suite's runners - rewrote the cache
# half with its own endpoint (one checkout held 63 transactions, every one
# naming http://127.0.0.1:8549), and the resume then panicked, sent to a dead
# local node, or to a fork whose receipts made the run look complete. So the
# cache half must exist, hold exactly the record's number of transactions, and
# name only the endpoint the resume command uses.
records_resumable() { # repo root, deployer, the resume's endpoint
  local run="$1/broadcast/DeployCurb.s.sol/8453/run-latest.json" copy="$1/deployments/base-mainnet/run.json" why
  local half="$1/cache/DeployCurb.s.sol/8453/run-latest.json"
  [ -s "$run" ] || fail "there is no $run to resume: nothing was broadcast from this checkout, or the record was moved."
  [ -s "$copy" ] || fail "deployments/base-mainnet/run.json does not exist. Copy the record there first (cp $run $copy), then resume: the resume rewrites the record."
  cmp -s "$run" "$copy" || fail "deployments/base-mainnet/run.json is not the record as it stands. Copy it again (cp $run $copy) so the copy holds what landed before this resume."
  [ -n "${3:-}" ] || fail "--recheck-resume needs the endpoint the resume sends to, after the deployer: the record's cache half has to name it."
  [ -s "$half" ] || fail "there is no $half - the record's other half, which says where each transaction is sent. Put back the private copy DEPLOY.txt, A PARTIAL DEPLOYMENT, says to keep, or write it again as that section says, then resume."
  why="$(python3 -c '
import json, sys
j = json.load(open(sys.argv[1]))
t = j.get("transactions") or []
froms = {((x.get("transaction") or {}).get("from") or "").lower() for x in t}
if not t:
    print("the record holds no transactions"); sys.exit()
if froms != {sys.argv[2].lower()}:
    print("the record was sent by " + ", ".join(sorted(froms)) + ", not CURB_DEPLOYER " + sys.argv[2] + " - a rehearsal record, or another run"); sys.exit()
bad = [r.get("transactionHash") or "?" for r in j.get("receipts") or [] if r.get("status") != "0x1"]
if bad:
    print(f"{len(bad)} transaction(s) of the record REVERTED on chain ({bad[0]}): forge would send the rest into a state that moved. Do not resume - DEPLOY.txt, A PARTIAL DEPLOYMENT, step 3"); sys.exit()
if len(j.get("receipts") or []) >= len(t) and not j.get("pending"):
    print("every transaction of the record has its receipt: there is nothing to resume - read the deployment back (check-deployment.sh) instead"); sys.exit()
try:
    h = json.load(open(sys.argv[3])).get("transactions") or []
except (OSError, ValueError, AttributeError):
    print("the record'"'"'s cache half " + sys.argv[3] + " cannot be read as forge writes it"); sys.exit()
rpcs = sorted({(x or {}).get("rpc") or "(none)" for x in h})
if len(h) != len(t):
    print(f"the record'"'"'s cache half {sys.argv[3]} holds {len(h)} transactions and the record {len(t)}: it is another run'"'"'s, written since (DEPLOY.txt, A PARTIAL DEPLOYMENT, says how to put it back)"); sys.exit()
if rpcs != [sys.argv[4]]:
    print("the record'"'"'s cache half " + sys.argv[3] + " sends to " + ", ".join(rpcs) + ", not to the resume'"'"'s endpoint " + sys.argv[4] + ": forge would resume against that. Put back the private copy, or write it again for this endpoint (DEPLOY.txt, A PARTIAL DEPLOYMENT)")
' "$run" "$2" "$half" "$3" 2>&1)"
  [ -z "$why" ] || fail "$why"
  return 0
}

# A RESUME RUNS ON THE COMMIT THAT BROADCAST, or on a commit after it that only
# adds the record's copy: committing deployments/base-mainnet/run.json moves
# HEAD, and nothing else may move.
head_extends_with_records() { # commit checked, HEAD
  local moved
  [ "$1" = "$2" ] && return 0
  gate_git merge-base --is-ancestor "$1" "$2" 2>/dev/null || return 1
  moved="$(gate_git diff --name-only "$1" "$2" -- . ':(exclude)deployments/' 2>/dev/null)" || return 1
  [ -z "$moved" ]
}

# SECTION 1, AGAIN, IN THE SHELL THAT SIGNS. Stops (exit 1) on the first
# failure, prints one ok line otherwise.
#
# THE PREFLIGHT'S OWN THREAT MODEL IS A SECOND SHELL - it writes
# CURB_DEMO_LAUNCH=false into the command for exactly that reason - and section
# 1 used to run only in the preflight's. Between the two, a git pull or an edit
# would broadcast code no suite had run under the preflight's commit; an
# exported FOUNDRY_OPTIMIZER_RUNS or FOUNDRY_PROFILE, or a .env created since,
# would compile other bytecode (and --verify would still pass, compiling the
# same way); FOUNDRY_BROADCAST left over from a rehearsal would file the
# mainnet record under broadcast/local/, where STEP 5 and records_clear never
# look; and an exported ETH_GAS_PRICE or VERIFIER_URL would price or verify the
# broadcast in a way the simulation never did (send_overrides). The printed
# command runs this first and forge only if it passes.
#
# THE OPT-INS ARE ASKED HERE TOO (allow_values_bad), though the command writes
# its own: the command's values were checked when the preflight printed them,
# and these are the shell's, which reach forge the moment a line of the
# command is lost.
recheck() { # commit, repo root, caller's directory, foundry home[, deployer, endpoint: a resume][, label: an asset run]
  local want="$1" root="$2" caller="$3" home="$4" resume="${5:-}" endpoint="${6:-}" asset="${7:-}" head dirty overrides
  # AN ASSET RUN IS SAID BY A SEVENTH ARGUMENT, even an empty one, and never by
  # the environment: what a shell exports must not turn the full run's recheck
  # into one that skips records_clear.
  local asset_run=""
  [ "$#" -ge 7 ] && asset_run=1
  [ -z "$asset_run" ] || label_ok "$asset" || fail "--recheck-asset needs the asset's label after the commit, letters and digits only, not '$asset'."
  [ -z "$resume" ] || address_ok "$resume" || fail "--recheck-resume needs the deployer's address after the commit, not '$resume'."
  [[ "$want" =~ ^[0-9a-f]{40}$ ]] || fail "--recheck needs the full commit the preflight printed, not '$want'."
  [ "$caller" = "$root" ] \
    || fail "run the command from the repository root ($root), not $caller. forge resolves script/ and loads .env from the directory it starts in."
  # BEFORE ANY git CALL, what would steer git (git_env_bad), then which
  # checkout it reads (git_root_problem).
  overrides="$(git_env_bad)"
  [ -z "$overrides" ] || {
    printf '%s\n' "$overrides" | sed 's/^/        /'
    fail "this shell exports GIT_* variables (above) that point git elsewhere or change how it compares - another work tree, settings given only in the shell. The shell that signs should hold none of them (an editor's GIT_ASKPASS, GIT_EDITOR and the like aside). Unset them and run the command again."
  }
  head="$(gate_git rev-parse --verify HEAD 2>/dev/null)" \
    || fail "git cannot read this checkout, so the commit being deployed is unknown."
  overrides="$(git_root_problem "$root")"
  [ -z "$overrides" ] || {
    printf '%s\n' "$overrides" | sed 's/^/        /'
    fail "git would compare another directory than the one forge builds (above). Fix it and run the command again."
  }
  if [ -z "$resume" ]; then
    [ "$head" = "$want" ] \
      || fail "HEAD is $head, and the preflight checked $want. Run the preflight again on this commit; nothing it checked covers this one."
  else
    head_extends_with_records "$want" "$head" \
      || fail "HEAD is $head. A resume runs on $want, the commit that broadcast, or on a commit after it that adds only deployments/ (the record's copy)."
  fi
  # pipefail (set above) makes a failing git status fail the substitution.
  dirty="$(tree_status | dirty_entries)" \
    || fail "git status failed, so whether the tree is clean is unknown."
  [ -z "$dirty" ] || {
    printf '%s\n' "$dirty" | sed 's/^/        /'
    fail "the tree is not the commit the preflight checked (above): changed since, or hidden from git. Deal with each entry as its note says, and run the preflight again."
  }
  overrides="$(build_overrides "$root" "$home")"
  [ -z "$overrides" ] || {
    printf '%s\n' "$overrides" | sed 's/^/        /'
    fail "this shell would build or record differently from the preflight's (above). Unset them, move .env and a global foundry.toml aside, and run the command again."
  }
  overrides="$(send_overrides)"
  [ -z "$overrides" ] || {
    printf '%s\n' "$overrides" | sed 's/^/        /'
    fail "this shell exports ETH_*, ETHERSCAN_* or VERIFIER_* variables (above), and those families are refused as a whole: forge reads some of them in place of flags the command leaves out - the gas price, the verifier, a signer - and the shell that signs should hold none of them. Unset them and run the command again."
  }
  overrides="$(allow_values_bad)"
  [ -z "$overrides" ] || {
    printf '%s\n' "$overrides" | sed 's/^/        /'
    fail "each CURB_ALLOW_* opt-in must be exactly true or false, or unset (above). Fix it in this shell and run the command again."
  }
  if [ -n "$asset_run" ]; then asset_records_clear "$root" "$asset"
  elif [ -z "$resume" ]; then records_clear "$root"; else records_resumable "$root" "$resume" "$endpoint"; fi
  explorer_key_ok \
    || fail "BASESCAN_API_KEY is not exported in this shell, or holds whitespace. --verify needs it; export it and run the command again."
  if [ -n "$asset_run" ]; then
    ok "asset recheck: $want, clean tree (each of its files hashed, git's work tree the root, no GIT_* steering it), no build or send overrides, opt-ins true or false, the deployment's record here and nothing of $asset's, explorer key set"
  elif [ -z "$resume" ]; then
    ok "recheck: $want, clean tree (each of its files hashed, git's work tree the root, no GIT_* steering it), no build or send overrides, opt-ins true or false, no earlier record, explorer key set"
  else
    ok "resume recheck: $want, clean tree, no build or send overrides, opt-ins true or false, a record from $resume left to resume with nothing reverted, its copy kept and its cache half this endpoint's, explorer key set"
  fi
}

# EVERYTHING THE SCRIPT SAID, NOT A FILTERED FEW LINES. The filter used to keep
# only lines matching WARNING and a few headings, and the script prints the
# recipient's address, and a Safe's threshold and owners, on lines that matched
# none of them - the very lines the runbook tells the operator to compare. So
# the whole == Logs == section is shown, up to forge's own next heading.
sim_logs() { # sim log
  awk '/^== Logs ==/ { f = 1; next } f && /^[^ ]/ { exit } f' "$1"
}

# THE ONE COMMAND TO SIGN. Printed with the operator's own wallet option, or
# with a placeholder that cannot run, never with a guessed one.
#
# CURB_DEMO_LAUNCH=false IS WRITTEN INTO IT. The simulation inherits the
# shell and stops if a demo launch was created, but the command is signed
# later, perhaps in another shell; an exported CURB_DEMO_LAUNCH=true there
# would make launch number one on mainnet "Curb Demo", for good.
#
# AND IT STARTS WITH --recheck <the commit checked>, for the same reason: the
# tree, the commit, the build overrides, the record's directory and the
# explorer key are asked again in the shell that signs, and forge does not
# start unless every answer is the preflight's (recheck says what each one
# prevents).
#
# forge STARTS ON THE LINE A COMPLETED RECHECK PRINTS, NOT ON ITS EXIT STATUS.
# The command was `bash ... --recheck <commit> && ... forge`, so any bash that
# exited 0 counted as a pass, and the signing shell's environment can make
# that bash run nothing at all and exit 0: SHELLOPTS=noexec (an interactive
# bash rewrites it, but dash, zsh and fish pass an exported one on
# unchanged), a BASH_ENV file ending in exit 0, an exported function named
# after the first builtin the script calls. The recheck's stdout is now one
# line, printed after its last check, and the command compares it with
# "recheck passed <commit>"; a recheck that ran nothing printed nothing.
# SHELLOPTS, BASHOPTS, BASH_ENV and ENV are dropped from its environment
# besides (env -u), so that such a shell has the recheck run rather than
# refused - a BASH_ENV sourcing a .bashrc that prints would otherwise put its
# output before the line.
#
# THE EXPLORER KEY REACHES forge IN ITS ENVIRONMENT, as ETHERSCAN_API_KEY - the
# variable forge reads for --etherscan-api-key - expanded from BASESCAN_API_KEY
# at signing time, quoted. As the flag's value it sat in forge's argv, which
# every user of the machine can read in the process list for the whole
# broadcast; a process's environment only its owner can read. The command
# holds the variable's name, never its value, so the value is not in this
# output or in shell history either. (Expanded unquoted, an unset key once
# vanished and --etherscan-api-key took the next flag as its value; there is
# no flag left for it to swallow.)
#
# forge AND THE ENDPOINT ARE PRINTED SHELL-QUOTED (printf %q), as the
# simulation passes them. Bare, an endpoint holding & sent forge to the
# background with no wallet and ran the rest of the URL as a command, a ? could
# match a file name, and a forge path holding a space was cut at the space - at
# the irreversible step, after every check had passed. endpoint_note says what
# printing the endpoint at all means for a key inside its URL.
#
# SO ARE THE OPT-INS. Section 1 lets through only true and false
# (allow_values_bad), which quoting leaves as they are; quoted, a value that
# ever got past it would still be one word, and could not end the command
# before forge.
#
# --slow, SO ONE TRANSACTION IS SENT AT A TIME, each after the last one's
# receipt. Without it forge sends the eighty-odd in a burst, and one that an
# endpoint drops or rate-limits strands every one after it behind a nonce gap.
#
# AND A SECOND COMMAND, TO RESUME (print_command ... resume): the same lines,
# --resume added, behind --recheck-resume - which asks section 1 again, wants a
# record to resume from CURB_DEPLOYER with something left to send and nothing
# reverted, its copy already kept at deployments/base-mainnet/run.json, and its
# cache half naming the command's own endpoint (records_resumable). It is for
# one case only: the broadcast died part way and nothing else has been done
# since. A record holding a reverted transaction is refused; DEPLOY.txt says
# what then.
opt_in_word() { # name
  printf '%q' "${!1:-false}"
}
print_command() { # wallet option (may be empty), commit[, resume]
  local wallet="${1:-<ONE WALLET OPTION FROM THE LIST ABOVE>}" forge rpc gate pass resume=""
  [ -n "${1:-}" ] && wallet="$(wallet_words "$1")"
  forge="$(printf '%q' "$FORGE")"
  rpc="$(printf '%q' "$RPC")"
  gate="--recheck $2" pass="recheck passed $2"
  if [ "${3:-}" = resume ]; then
    # THE ENDPOINT TOO, shell-quoted as forge's own: the record's cache half
    # must name it (records_resumable).
    gate="--recheck-resume $2 $CURB_DEPLOYER $rpc" pass="resume recheck passed $2" resume=$'\n     --resume \\'
  fi
  cat <<CMD
   [ "\$(env -u SHELLOPTS -u BASHOPTS -u BASH_ENV -u ENV bash script/b20/preflight-mainnet.sh $gate)" \\
     = "$pass" ] && \\
   CURB_PLATFORM_RECIPIENT=$CURB_PLATFORM_RECIPIENT \\
   CURB_POLICY_OWNER=$CURB_POLICY_OWNER \\
   CURB_SHARING_PUBLISHER=$CURB_SHARING_PUBLISHER \\
   CURB_SHARING_KEEPER_PAYEE=$CURB_SHARING_KEEPER_PAYEE \\
   CURB_SHARING_VETOERS=$CURB_SHARING_VETOERS \\
   CURB_ALLOW_EOA_RECIPIENT=$(opt_in_word CURB_ALLOW_EOA_RECIPIENT) \\
   CURB_ALLOW_NON_SAFE_RECIPIENT=$(opt_in_word CURB_ALLOW_NON_SAFE_RECIPIENT) \\
   CURB_ALLOW_EOA_POLICY_OWNER=$(opt_in_word CURB_ALLOW_EOA_POLICY_OWNER) \\
   CURB_ALLOW_NON_SAFE_POLICY_OWNER=$(opt_in_word CURB_ALLOW_NON_SAFE_POLICY_OWNER) \\
   CURB_ALLOW_SAME_RECIPIENT_AND_OWNER=$(opt_in_word CURB_ALLOW_SAME_RECIPIENT_AND_OWNER) \\
   CURB_ALLOW_EOA_CREATOR=$(opt_in_word CURB_ALLOW_EOA_CREATOR) \\
   CURB_DEMO_LAUNCH=false \\
$(first_words)
   ETHERSCAN_API_KEY="\$BASESCAN_API_KEY" \\
   $forge script script/DeployCurb.s.sol \\
     --rpc-url $rpc \\
     --sender $CURB_DEPLOYER \\
     --broadcast \\
     --slow \\$resume
     --verify \\
     $wallet
CMD
}

# AN ENDPOINT OF THE OPERATOR'S OWN IS PRINTED INTO THE COMMAND AS GIVEN, and a
# provider's URL often carries its API key (.../v2/<key>). Said beside the
# command, so the key is not put into shell history unawares. The public
# default holds no key and gets no note.
endpoint_note() {
  if [ "$RPC" = "https://mainnet.base.org" ]; then
    echo
    echo " THE COMMAND USES THE PUBLIC ENDPOINT, which rate-limits. Eighty-odd"
    echo " transactions, one at a time, are what it limits: for the broadcast, use"
    echo " an endpoint of your own with a key (CURB_MAINNET_RPC=..., then run this"
    echo " again so the command carries it)."
    return 0
  fi
  echo
  echo " THE COMMAND CARRIES YOUR ENDPOINT, exactly as CURB_MAINNET_RPC gave it."
  echo " If that URL holds an API key, running the command puts the key in your"
  echo " shell history, and in the process list while forge runs. Use a key you"
  echo " can revoke, and revoke it afterwards if that matters."
}

# CAN python3 ACTUALLY RUN - asked by running it, not by looking it up. On
# Windows the App Installer alias answers `command -v python3` and then fails
# to run, which let the gas gate reach its arithmetic with no interpreter behind
# it and blame the deployer's balance for the empty answer.
python_runs() {
  python3 -c 'import decimal' >/dev/null 2>&1
}

# GIT, ASKED SO THAT WHAT IT SHOWS IS WHAT IS THERE. Two settings let
# something other than the files answer for it. core.fsmonitor hands "what
# changed?" to a file watcher, and a watcher that missed an edit left the
# edited source out of git status. A refs/replace entry makes git read another
# object wherever it reads the one named, so HEAD's commit was compared with a
# replacement's files and the tree read as clean. Every git command of the
# gate runs with the watcher off and replacements ignored - and tree_status
# lists each replacement besides, since git log and git show, everywhere else,
# still show the replacement under the commit being recorded.
#
# AND WITH NONE OF THE SHELL'S GIT_* VARIABLES, which git_env_bad says why it
# refuses besides: the directory the command runs in decides which checkout
# the gate's git reads, as it decides what forge builds.
gate_git() {
  local strip=() name
  for name in $(env | grep -Eio '^GIT_[A-Za-z0-9_]*' | sort -u); do strip+=(-u "$name"); done
  env ${strip[@]+"${strip[@]}"} GIT_NO_REPLACE_OBJECTS=1 git -c core.fsmonitor=false "$@"
}

# GIT, TOLD BY THE SHELL WHERE AND HOW TO LOOK. Several of git's GIT_*
# variables point it away from the checkout forge builds. GIT_WORK_TREE,
# alone or with GIT_DIR, made every git command of the gate compare another
# checkout - a clean copy, a `git worktree add` of the same commit - and the
# recheck printed ok while forge compiled the edited source in the directory
# the command ran from. GIT_CONFIG_COUNT (or GIT_CONFIG_PARAMETERS) hands git
# any setting with no line of config on disk: a clean filter and an
# attributes file naming it, or a stat check that trusts more. The gate's own
# git sees none of them (gate_git); they are refused besides, as the ETH_
# families are, because DEPLOY.txt STEP 0's by-hand checks run in the same
# shell and forge may run git itself. Matched in any case: Git for Windows
# reads the Windows environment, whose names match without regard to case.
# Prints one line per variable found.
#
# EXCEPT WHAT AN EDITOR OR A TERMINAL EXPORTS TO TALK TO THE USER OR TO A
# REMOTE: GIT_ASKPASS (VS Code's terminal exports it), GIT_EDITOR,
# GIT_SEQUENCE_EDITOR, GIT_PAGER, GIT_TERMINAL_PROMPT, GIT_SSH,
# GIT_SSH_COMMAND, GIT_SSH_VARIANT and the author and committer names and
# dates. None changes what git compares, the gate's git does not see them, and
# a gate that refuses the founder's ordinary terminal trains people to ignore
# it.
git_env_bad() {
  env | grep -Eio '^GIT_[A-Za-z0-9_]*' | sort -u \
    | grep -Evx 'GIT_(ASKPASS|EDITOR|SEQUENCE_EDITOR|PAGER|TERMINAL_PROMPT|SSH|SSH_COMMAND|SSH_VARIANT|AUTHOR_(NAME|EMAIL|DATE)|COMMITTER_(NAME|EMAIL|DATE))' \
    | sed 's/^/environment variable /'
  return 0
}

# THE CHECKOUT git COMPARES IS THE ONE forge BUILDS: the repository root, as
# the directory it is, whatever path reached it. core.worktree in git's config
# points git at another checkout with nothing exported - a clean copy of the
# same commit read clean while the root's edited source was the one compiled
# - and git rev-parse --show-toplevel then names that other checkout. Both are
# asked. Prints one line per problem, nothing when there is none.
git_root_problem() { # repository root
  local root top wt
  root="$(cd "$1" 2>/dev/null && pwd -P)" || { echo "cannot enter $1"; return 0; }
  top="$(gate_git rev-parse --show-toplevel 2>/dev/null)" && top="$(cd "$top" 2>/dev/null && pwd -P)" \
    || { echo "git names no work tree for $root"; return 0; }
  [ "$top" = "$root" ] || echo "git's work tree is $top, not $root, where forge builds"
  wt="$(gate_git config --get core.worktree)"
  [ -z "$wt" ] || echo "core.worktree is set (to $wt): git compares that directory, not the one forge builds (git config --unset core.worktree)"
  return 0
}

# THE TREE'S STATUS, -z (dirty_entries says why). The pathspec is the one a
# deployment and its record depend on; see section 1.
#
# GIT'S OWN SETTINGS DO NOT DECIDE WHAT IT SHOWS. status.showUntrackedFiles=no
# left out every untracked file, and a submodule's ignore setting left out its
# changes, so the gate read a clean tree around an untracked source that
# committed code imports. The flags ask for all of them whatever the
# configuration says.
#
# AND WHAT GIT IS TOLD NOT TO LOOK AT IS LISTED. A file marked assume-unchanged
# or skip-worktree (git update-index) is not compared with the index at all, so
# its edits never showed in git status. git ls-files -v tags such a file with a
# lowercase letter (assume-unchanged) or S (skip-worktree); each becomes one
# more entry, which dirty_entries counts like any tracked change. Since git
# does not compare such a file, whether it was edited is not known here, so it
# is listed even when it matches the commit, and its note says so and how to
# clear the mark.
#
# AND WHAT GIT IGNORES (--ignored). .gitignore's cache/, out/ and broadcast/
# are unanchored, so they match inside src/ and lib/ too, and .git/info/exclude
# or a global core.excludesFile can ignore anything: an ignored
# src/curb/cache/X.sol that committed code imports was compiled into the
# deployment, and git status, asked without --ignored, never listed it.
# dirty_entries decides which ignored files count.
#
# AND WHAT git READS IN PLACE OF AN OBJECT (gate_git). A replacement is listed
# as one more entry, which dirty_entries counts.
#
# AND EVERY FILE OF THE COMMIT, HASHED FROM ITS BYTES (tree_content). git
# status is kept for what only it sees - untracked, ignored and staged files,
# submodules - but not trusted to say that a tracked file is unchanged.
tree_status() {
  local paths=(src test script web lib foundry.toml remappings.txt ':(glob)*.txt') rec
  gate_git status --porcelain -z --untracked-files=all --ignored --ignore-submodules=none -- "${paths[@]}" \
    || return 1
  # pipefail (set above) makes a failing ls-files fail the pipeline.
  gate_git ls-files -z -v -- "${paths[@]}" | while IFS= read -r -d '' rec; do
    case "$rec" in
      [[:lower:]]\ *|S\ *) printf '%s  <- marked assume-unchanged or skip-worktree: git does not compare it with the commit, so it is listed whether or not it was edited (git update-index --no-assume-unchanged, or --no-skip-worktree, clears the mark)\0' "$rec" ;;
    esac
  done || return 1
  gate_git replace -l | while IFS= read -r rec; do
    printf 'replaced %s  <- git replace: git reads another object wherever this one is named, so what git log and git show call this commit is not what it holds (git replace -d %s removes it)\0' "$rec" "$rec"
  done || return 1
  tree_content
}

# EACH FILE OF THE COMMIT, HASHED AGAIN FROM ITS BYTES ON DISK and compared
# with the commit's own blob id (git ls-tree HEAD). git status decides that a
# tracked file is unchanged from two things other than its bytes:
# - THE STAT DATA IN THE INDEX. Under core.trustctime=false (or
#   core.checkStat=minimal), set in .git/config or only in the shell, a
#   same-size edit written in place whose mtime was put back - one address
#   constant for another - was never read, and the tree read as clean.
# - A CLEAN FILTER, which git reads the file through whenever it does read
#   it. Named in .git/info/attributes, in an uncommitted root .gitattributes
#   (outside the paths, so not listed either) or in a core.attributesFile, and
#   defined in any git config, it handed git the committed bytes for an edited
#   source of the same size.
# No stat data is used here and no assume-unchanged or skip-worktree mark is
# obeyed: every file is read. Prints one entry per file, NUL-terminated, for
# dirty_entries.
#
# A FILE git WOULD CONVERT BY MORE THAN ITS LINE ENDINGS IS LISTED, NOT HASHED:
# one with a filter, ident or working-tree-encoding attribute, from wherever
# git reads attributes (check-attr asks the same sources the hashing uses).
# Each rewrites content, so hashing through it compares whatever the
# conversion hands back.
#
# THE LINE ENDINGS ARE CONVERTED AS git STORES THEM (* text=auto eol=lf), so a
# CRLF checkout of LF blobs reads as the commit, as git status reads it too.
# The founder's checkout holds lib/ that way (Windows git wrote it), and a gate
# that every correct tree fails trains people to ignore it. What then differs
# is CRs alone: no code, though solc's metadata hash, which covers each
# source's bytes, is not an LF checkout's.
#
# HASHED IN EIGHT SLICES AT ONCE. Over WSL's /mnt/c a file's read is slow: one
# git hash-object took 35 s for the 4,100-odd files, eight took 5.
tree_content() {
  local dir rec meta path mode oid k a ap an av cv i j lo hi n
  local paths=() want=() skip=() hp=() hw=() pids=() got=()
  dir="$(mktemp -d)" || return 1
  gate_git ls-tree -r -z --full-tree HEAD >"$dir/tree" || { rm -rf "$dir"; return 1; }
  # HEAD's files in tree_status's paths, with its glob written as a pattern.
  while IFS= read -r -d '' rec; do
    meta="${rec%%$'\t'*}" path="${rec#*$'\t'}"
    case "$path" in
      src/*|test/*|script/*|web/*|lib/*|foundry.toml|remappings.txt) ;;
      */*) continue ;;
      *.txt) ;;
      *) continue ;;
    esac
    mode="${meta%% *}" oid="${meta##* }"
    case "$mode" in
      100644|100755) ;;
      160000) continue ;;  # a submodule: git status compares its commit (--ignore-submodules=none)
      *) printf 'not a file %s  <- in the commit as mode %s, not as a regular file: this compares files, so it is listed\0' \
           "$path" "$mode"; continue ;;
    esac
    case "$path" in
      *$'\n'*|*$'\r'*|\"*) printf 'unnamed %s  <- git cannot be handed this name on a line of its own, so its bytes were not compared with the commit: rename it\0' \
           "$path"; continue ;;
    esac
    paths+=("$path") want+=("$oid")
  done <"$dir/tree"
  n=${#paths[@]}
  [ "$n" -gt 0 ] || { rm -rf "$dir"; return 0; }
  # WHAT git WOULD DO TO EACH FILE BEFORE HASHING IT: three records per
  # attribute (path, name, value), in the order asked.
  printf '%s\0' "${paths[@]}" | gate_git check-attr -z --stdin filter ident working-tree-encoding >"$dir/attr" \
    || { rm -rf "$dir"; return 1; }
  for ((k = 0; k < n; k++)); do
    cv=""
    for a in 1 2 3; do
      IFS= read -r -d '' ap && IFS= read -r -d '' an && IFS= read -r -d '' av && [ "$ap" = "${paths[k]}" ] \
        || { rm -rf "$dir"; return 1; }
      case "$av" in unspecified|unset) ;; *) cv+="${cv:+, }$an: $av" ;; esac
    done
    if [ -n "$cv" ]; then
      printf 'converted %s  <- git would rewrite its bytes before comparing them (%s), so they were not compared with the commit: remove the attribute (git check-attr -a -- <path> names it; .git/info/attributes, a .gitattributes or a core.attributesFile holds it)\0' \
        "${paths[k]}" "$cv"
      skip[k]=1
    fi
  done <"$dir/attr"
  for ((k = 0; k < n; k++)); do
    [ -n "${skip[k]:-}" ] || { hp+=("${paths[k]}"); hw+=("${want[k]}"); }
  done
  n=${#hp[@]}
  for ((i = 0; i < 8; i++)); do
    lo=$((n * i / 8)) hi=$((n * (i + 1) / 8))
    [ "$lo" -lt "$hi" ] || continue
    printf '%s\n' "${hp[@]:lo:hi-lo}" >"$dir/in.$i"
    gate_git hash-object --stdin-paths <"$dir/in.$i" >"$dir/out.$i" 2>"$dir/err.$i" &
    pids[i]=$!
  done
  for i in "${!pids[@]}"; do
    lo=$((n * i / 8)) hi=$((n * (i + 1) / 8)) got=()
    wait "${pids[i]}" && mapfile -t got <"$dir/out.$i"
    if [ "${#got[@]}" -ne $((hi - lo)) ]; then
      printf "unread  <- git could not hash every file of the commit in the gate's paths (%s), so not all of their bytes were compared with the commit: a missing file shows above as deleted\0" \
        "$(head -1 "$dir/err.$i" 2>/dev/null)"
      continue
    fi
    for ((j = 0; j < hi - lo; j++)); do
      [ "${got[j]}" = "${hw[lo + j]}" ] \
        || printf "differs %s  <- its bytes are not the commit's, hashed afresh here rather than taken from git status, whose stat data or a clean filter can pass an edited file as unchanged: commit or undo the edit\0" \
             "${hp[lo + j]}"
    done
  done
  rm -rf "$dir"
}

# ONE ADDRESS, READ OFF THE CHAIN: what kind it is and what it holds. Prints the
# two lines section 3 shows, or stops.
#
# A FAILED READ IS A FAILED READ. Both reads used to fall back - `|| echo 0x`,
# `|| echo 0` - so an unreachable endpoint printed "ONE KEY (no code), balance
# 0 wei", the most ordinary-looking answer there is, for the policy owner the
# runbook most wants a human to look at.
read_address() { # what who
  local what="$1" who="$2" code kind bal
  code="$("$CAST" code "$who" --rpc-url "$RPC" 2>/dev/null)" \
    || fail "could not read the code at the $what $who from $RPC. What kind of address it is is unknown."
  kind="$(code_kind "$code")" \
    || fail "the code read for the $what $who is not hex ('$code'). What kind of address it is is unknown."
  bal="$("$CAST" balance "$who" --rpc-url "$RPC" 2>/dev/null)" \
    || fail "could not read the balance of the $what $who from $RPC."
  bal="$(printf '%s' "$bal" | tr -d '\r\n')"
  [[ "$bal" =~ ^[0-9]+$ ]] || fail "the balance read for the $what $who is not a number: '$bal'."
  printf '        %-19s %s\n' "$what" "$who"
  printf '        %-19s %s, balance %s wei\n' "" "$kind" "$bal"
  # AN ADDRESS WITH LETTERS ALL IN ONE CASE CARRIES NO CHECKSUM, so a typo in
  # it passed address_ok and reads here like any unused address: said.
  [[ "${who:2}" == *[abcdefABCDEF]* ]] && ! [[ "${who:2}" == *[abcdef]* && "${who:2}" == *[ABCDEF]* ]] \
    && printf '        %-19s written without its EIP-55 checksum, so a typo in it could not be caught: copy it checksummed (DEPLOY.txt STEP 2)\n' ""
  # WHAT KIND, KEPT for the caller (the $CURB creator's opt-in, below).
  READ_KIND="$kind"
}

# THE MAINNET RECORD MUST BE THE ONLY ONE IN ITS DIRECTORY. forge writes every
# run on a chain-8453 node there, and a fork of Base serves 8453 too. The local
# runner scripts now write under broadcast/local/ instead (FOUNDRY_BROADCAST),
# so the runbook's own STEP 1 no longer lands here - but an older run, a
# hand-typed rehearsal, or AN EARLIER MAINNET RUN may have. Any run-*.json
# counts, not only run-latest.json: timestamped copies are records too.
#
# WHAT IS THERE IS NOT KNOWN, SO THIS DOES NOT GUESS. It used to call the file
# "a local rehearsal, since nothing is deployed" - false exactly when the
# preflight is re-run after a partial or completed mainnet broadcast, when
# that file is the only record of what landed.
records_clear() { # repo root
  if ls "$1"/broadcast/DeployCurb.s.sol/8453/run-*.json >/dev/null 2>&1; then
    fail "broadcast/DeployCurb.s.sol/8453/ already holds a run. It is EITHER a local rehearsal OR the record of an earlier mainnet broadcast - look at the transactions' \"from\" (anvil's 0xf39f... is a rehearsal). A rehearsal: move the directory aside. A mainnet record: copy it to deployments/base-mainnet/run.json at once and do not deploy again - see DEPLOY.txt, IF SOMETHING GOES WRONG."
  fi
  if [ -e "$1/deployments/base-mainnet/run.json" ]; then
    fail "deployments/base-mainnet/run.json exists: a mainnet deployment is already recorded. A second full run would deploy a second everything."
  fi
  return 0
}

# SECTION 1, AS THE RUN AND THE ASSET RUN (--asset) BOTH ASK IT: the tree, the
# settings that change what forge builds or sends, and the opt-ins - all but
# the records, which differ (records_clear, asset_records_clear). Stops on the
# first failure.
#
# SCOPED TO WHAT IS ACTUALLY DEPLOYED AND RECORDED, which is also what makes
# this portable. `git status` over the whole tree reports reference/ponsfamily
# as modified under WSL and clean under Windows git - it is a nested repository
# read with different settings - and neither answer is about our code. The
# paths are the ones a deployment and its record depend on - lib/ included: it
# is vendored, tracked source that every contract imports.
#
# UNTRACKED FILES COUNT WHERE THEY CAN BE COMPILED, IGNORED ONES INCLUDED
# (dirty_entries and tree_status above). forge builds the working tree, not
# HEAD, so an untracked .sol under src/ or script/ - or a changed optimizer
# setting - produces bytecode the recorded commit does not reproduce -
# verification would still pass against the working tree, but the commit
# written into ADDRESSES.txt would not describe what is on chain.
# GIT ITSELF MUST ANSWER. The pipeline used to end in `|| true`, so a git that
# refused (no .git, WSL's "dubious ownership", a broken index) left `dirty`
# empty and the gate printed "clean tree at" an empty commit.
#
# AND BEFORE ANY git CALL, NOTHING IN THE SHELL STEERS IT (git_env_bad), and
# then git's work tree is this directory (git_root_problem).
tree_gate() {
  local overrides dirty
  overrides="$(git_env_bad)"
  [ -z "$overrides" ] || {
    printf '%s\n' "$overrides" | sed 's/^/        /'
    fail "the shell exports GIT_* variables (above) that point git elsewhere or change how it compares - another work tree, settings given only in the shell - so what git says about this tree would not be about the files forge builds. Unset them (an editor's GIT_ASKPASS, GIT_EDITOR and the like may stay)."
  }
  gate_git rev-parse --verify HEAD >/dev/null 2>&1 || fail "git cannot read this checkout, so the commit being deployed is unknown."
  overrides="$(git_root_problem "$PWD")"
  [ -z "$overrides" ] || {
    printf '%s\n' "$overrides" | sed 's/^/        /'
    fail "git would compare another directory than the one forge builds (above)."
  }
  tree_status >/tmp/curb-preflight-status.z \
    || fail "git status failed, so whether the tree is clean is unknown."
  dirty="$(dirty_entries </tmp/curb-preflight-status.z)"
  [ -z "$dirty" ] || {
    printf '%s\n' "$dirty" | sed 's/^/        /'
    fail "the tree is not the commit (above): uncommitted changes, or something git would not have shown - an ignored file forge would compile, a marked file, a replaced object, a file whose bytes are not the commit's, a file git filters. Deal with each entry as its note says (commit or undo a change) - ADDRESSES.txt records a commit, and it has to mean something."
  }
  # AND NOTHING OUTSIDE THE TREE CHANGES THE BUILD (build_overrides above).
  overrides="$(build_overrides "$PWD" "$HOME/.foundry")"
  [ -z "$overrides" ] || {
    printf '%s\n' "$overrides" | sed 's/^/        /'
    fail "the build would read the settings above, which the recorded commit does not contain. Unset them (and move .env and a global foundry.toml aside) so the repository's foundry.toml is the only source."
  }
  # NOR ANYTHING THAT CHANGES WHAT forge SENDS (send_overrides above). Asked
  # here as well as in the shell that signs, so the simulation runs as the
  # command will.
  overrides="$(send_overrides)"
  [ -z "$overrides" ] || {
    printf '%s\n' "$overrides" | sed 's/^/        /'
    fail "the shell exports ETH_*, ETHERSCAN_* or VERIFIER_* variables (above), and those families are refused as a whole: forge reads some of them in place of flags the command leaves out - the gas price, the verifier, a signer - and the shell that signs should hold none of them. Unset them (ETHERSCAN_API_KEY may stay; the command sets its own)."
  }
  # AND EACH OPT-IN IS true, false OR UNSET (allow_values_bad above), before
  # the simulation reads them and the command is printed with them.
  overrides="$(allow_values_bad)"
  [ -z "$overrides" ] || {
    printf '%s\n' "$overrides" | sed 's/^/        /'
    fail "each CURB_ALLOW_* opt-in must be exactly true or false, or unset (above). forge reads some other spellings as true (TRUE, 1) and anything it cannot parse as false, so only the exact words are accepted; the printed command would carry the value as given."
  }
  return 0
}

# THE DOLLAR CHECK OF A SIMULATION'S TERMS (usd_shape_bad says why), for the run
# - every listed asset - and for the asset run - the one asset it builds. Reads
# the terms the script printed (DeployCurb.logTerms) out of the simulation's
# log, prices each at its Chainlink feed, prints a table line per asset (kept
# in USD_TABLE for the caller) and stops on any problem.
# THE TERMS A SIMULATION PRINTED (DeployCurb.logTerms, which the run and
# DeployAssetStack both call): the lines under the heading, to the empty line.
sim_terms() { # sim log; prints "label asset decimals phantom threshold" lines
  awk '/^ *=== each asset.s terms: label asset decimals phantom threshold ===/{f=1;next} f&&NF==0{exit} f' "$1"
}
# THE SAFE'S CALL AN ASSET RUN PRINTED (DeployAssetStack: "data 0x..." after
# "NOTHING IS ADMITTED YET"), or nothing.
sim_safe_data() { # sim log
  awk '/NOTHING IS ADMITTED YET/ { f = 1 } f && $1 == "data" { print $2; exit }' "$1"
}
usd_gate() { # sim log
  local feeds terms usd_in="" line feed want round fdec fdesc shape problems label quote decimals phantom threshold
  feeds="$(feed_table web/prices.js services/sharer/deploy/sharer.example.json)" || {
    printf '%s\n' "$feeds" | sed 's/^/        /'
    fail "the feed tables disagree or cannot be read (above). The site and the keeper must price each asset by the same feed."
  }
  terms="$(sim_terms "$1")"
  [ -n "$terms" ] || fail "the simulation printed no asset terms to price. Do not broadcast. Full log: $1"
  while read -r label quote decimals phantom threshold; do
    [ -n "$label" ] || continue
    line="$(feed_of "$feeds" "$label" "$quote")"
    [ "${line#PROBLEM }" = "$line" ] || fail "${line#PROBLEM }"
    feed="${line%% *}" want="${line#* }"
    round="$(feed_read "$feed" "latestRoundData()")" && fdec="$(feed_read "$feed" "decimals()")" \
      && fdesc="$(feed_read "$feed" "description()")" \
      || fail "could not read $label's feed $feed from $RPC. Whether its terms still fit is unknown."
    usd_in+="$(python3 -c '
import sys
r, d, s = (x[2:] for x in sys.argv[1:4])
w = [r[i:i + 64] for i in range(0, len(r), 64)]
ans = int(w[1], 16); ans -= (1 << 256) if ans >> 255 else 0
off = int(s[:64], 16) * 2; n = int(s[off:off + 64], 16)
desc = bytes.fromhex(s[off + 64:off + 64 + 2 * n]).decode("utf-8", "replace")
print("\t".join([sys.argv[4], sys.argv[5], sys.argv[6], sys.argv[7], str(int(d[:64], 16)), str(ans), str(int(w[3], 16)), desc, sys.argv[8]]))
' "$round" "$fdec" "$fdesc" "$label" "$decimals" "$phantom" "$threshold" "$want")"$'\n'
  done <<<"$terms"
  shape="$(printf '%s' "$usd_in" | usd_shape_bad "$(date +%s)")"
  USD_TABLE="$(printf '%s\n' "$shape" | grep -v '^PROBLEM ')"
  printf '%s\n' "$USD_TABLE"
  problems="$(printf '%s\n' "$shape" | grep '^PROBLEM ' | sed 's/^PROBLEM /        /')"
  [ -z "$problems" ] || {
    printf '%s\n' "$problems"
    fail "the listed terms no longer give the decided shape at today's prices (above). Phantom and threshold are permanent per factory: re-price DeployCurb.quoteAssets() (script/b20/measure-thresholds.js, then the fixtures and docs that pin them) and run this again."
  }
  return 0
}

# CAN THE DEPLOYER PAY - three times the simulation's estimate, and never under
# 0.001 ETH, plus any ether the run sends besides gas. A broadcast of some
# eighty transactions (fourteen assets since 2026-10-15: seven shared
# contracts, four per asset, fourteen admissions, $CURB and the handover)
# that runs dry in the middle leaves a half-wired deployment; the margin is
# cheap and the estimate moves with gas.
funding_gate() { # sim log, wei sent besides gas, the deployer's balance
  local est_eth need_wei
  est_eth="$(grep -Eo 'Estimated amount required: *[0-9.]+ ETH' "$1" | grep -Eo '[0-9.]+' | tail -1)"
  [ -n "$est_eth" ] || fail "the simulation printed no cost estimate, so whether the deployer can pay is unknown."
  need_wei="$(python3 -c 'import sys,decimal; e=decimal.Decimal(sys.argv[1])*10**18; print(int(max(e*3, decimal.Decimal(10**15))) + int(sys.argv[2]))' "$est_eth" "$2")"
  [[ "$need_wei" =~ ^[0-9]+$ ]] || fail "the funding arithmetic produced no number ('$need_wei'), so whether the deployer can pay is unknown."
  # UNDERFUNDED IS THE EXPECTED FIRST RESULT of the full run, and the message
  # says what to do next: the estimate only exists once the simulation has
  # run, so DEPLOY.txt funds the gas after the first preflight and then runs
  # it again.
  python3 -c 'import sys; sys.exit(0 if int(sys.argv[1]) >= int(sys.argv[2]) else 1)' "$3" "$need_wei" \
    || fail "the deployer holds $3 wei; the simulation estimates $est_eth ETH and this asks for $need_wei wei (3x, floor 0.001 ETH, plus the dev buy's $2 wei). Fund it to at least that, then run this preflight again - it prints the command only once the deployer can pay (DEPLOY.txt STEP 3)."
  ok "the deployer holds $3 wei, at least three times the simulated $est_eth ETH, plus the dev buy's $2 wei"
}

# ============================================================================
# --asset <label>: ONE QUOTE ASSET ADDED AFTER LAUNCH (DEPLOY.txt, ADDING A
# QUOTE ASSET AFTER LAUNCH). script/DeployAssetStack.s.sol builds the asset's
# stack against the live deployment and prints the policy Safe's addLauncher;
# its command used to be typed by hand, with no tree recheck, no refusal of
# FOUNDRY_*, ETH_* or VERIFIER_* settings and no Chainlink dollar check of
# the phantom and threshold, so a stale or uncommitted price passed every
# automated check and the Safe's signers saw only addLauncher(<address>) - for
# a launcher that can never be removed. This asks section 1, simulates the
# script against live Base, prices that one asset's start and graduation at
# Chainlink's answer, checks the funding, prints the Safe's call with the
# dollars beside it, and the one command to sign behind --recheck-asset.
# ============================================================================

# AN ASSET'S LABEL, as DeployCurb.quoteAssets() writes them: letters and
# digits. It goes into the printed command bare and into a file name.
label_ok() { [[ "$1" =~ ^[A-Za-z0-9]{1,16}$ ]]; }

# THE RECORDS AN ASSET RUN MAY FIND. Unlike the full run's (records_clear), the
# deployment's own record must be there - an asset is added to a recorded
# deployment - and this asset's must not. And whatever forge left in the asset
# script's own directory must already be kept as some asset's record, byte for
# byte: the next run overwrites run-latest.json, and an earlier asset's record
# not yet copied would be lost.
asset_records_clear() { # repo root, label
  local f k kept
  [ -e "$1/deployments/base-mainnet/run.json" ] \
    || fail "deployments/base-mainnet/run.json does not exist: an asset is added to a deployment that is recorded, and that is its record (DEPLOY.txt STEP 5). Run this from the checkout that holds it."
  [ ! -e "$1/deployments/base-mainnet/asset-$2.json" ] \
    || fail "deployments/base-mainnet/asset-$2.json exists: $2's stack is already recorded. A second run would build a second stack, which the registry refuses to admit for the same asset - with its gas spent."
  for f in "$1"/broadcast/DeployAssetStack.s.sol/8453/run-*.json; do
    [ -e "$f" ] || continue
    kept=""
    for k in "$1"/deployments/base-mainnet/asset-*.json; do
      [ -e "$k" ] && cmp -s "$f" "$k" && { kept=1; break; }
    done
    [ -n "$kept" ] || fail "${f#"$1"/} is not kept as any deployments/base-mainnet/asset-<label>.json. It is EITHER a rehearsal on a node serving chain 8453 OR the record of an earlier asset run on mainnet - look at its transactions' \"from\". A rehearsal: move it aside. A mainnet record: copy it to deployments/base-mainnet/asset-<its label>.json and commit it first (DEPLOY.txt, ADDING A QUOTE ASSET, step 3) - the next run overwrites run-latest.json."
  done
  return 0
}

# THE ONE COMMAND TO SIGN FOR AN ASSET, as print_command for the run: behind
# --recheck-asset, the explorer key by name, forge and the endpoint
# shell-quoted, --slow, --verify, one wallet option.
print_asset_command() { # wallet option (may be empty), commit, label
  local wallet="${1:-<ONE WALLET OPTION FROM THE LIST ABOVE>}" forge rpc
  [ -n "${1:-}" ] && wallet="$(wallet_words "$1")"
  forge="$(printf '%q' "$FORGE")"
  rpc="$(printf '%q' "$RPC")"
  cat <<CMD
   [ "\$(env -u SHELLOPTS -u BASHOPTS -u BASH_ENV -u ENV bash script/b20/preflight-mainnet.sh --recheck-asset $2 $3)" \\
     = "asset recheck passed $2 $3" ] && \\
   CURB_REGISTRY=$CURB_REGISTRY \\
   CURB_ASSET_LABEL=$3 \\
   ETHERSCAN_API_KEY="\$BASESCAN_API_KEY" \\
   $forge script script/DeployAssetStack.s.sol \\
     --rpc-url $rpc \\
     --sender $CURB_DEPLOYER \\
     --broadcast \\
     --slow \\
     --verify \\
     $wallet
CMD
}

asset_run() { # label
  local label="$1" sim=/tmp/curb-preflight-asset-sim.log rc balw data
  label_ok "$label" || fail "--asset needs the asset's label in DeployCurb.quoteAssets() - letters and digits only - not '$label'."
  python_runs || fail "python3 is required and did not run (the addresses' checksums, the dollar check and the funding check are worked out with it)."
  need CURB_DEPLOYER
  need CURB_REGISTRY
  [ -x "$FORGE" ] || fail "base-forge is not at $FORGE. Run the preflight in WSL, where B20_ENVIRONMENT.txt installs it (or point FORGE_BIN at it)."
  [ -x "$CAST" ] || command -v "$CAST" >/dev/null 2>&1 \
    || fail "base-cast is not at $CAST. Run the preflight in WSL, where B20_ENVIRONMENT.txt installs it (or point CAST_BIN at it)."
  if [ -n "${CURB_WALLET_OPTION:-}" ]; then
    wallet_option_ok "$CURB_WALLET_OPTION" \
      || fail "CURB_WALLET_OPTION matches none of the allowed forms. Its value is not shown here, because it may hold a key or a seed phrase. Use exactly one of: --ledger, --trezor (either optionally followed by --mnemonic-indexes <n> or --mnemonic-derivation-paths <path>), --account <name>, --interactives 1. Never --private-key."
  fi
  explorer_key_ok \
    || fail "BASESCAN_API_KEY is not set, or holds whitespace. The printed command verifies the four contracts on the explorer with it; its value is never printed."
  [ -z "${CURB_WALLET_OPTION:-}" ] || signer_check "$CURB_WALLET_OPTION" "$CURB_DEPLOYER"

  echo "================================================================"
  echo " CURB ASSET PREFLIGHT, $label - nothing here sends a transaction"
  echo "================================================================"
  echo
  echo "1. THE COMMIT YOU WOULD BE DEPLOYING FROM"
  tree_gate
  asset_records_clear "$PWD" "$label"
  COMMIT="$(gate_git rev-parse HEAD)"
  ok "clean tree at $COMMIT (each of its files hashed, git's work tree this directory, no GIT_* steering it); no FOUNDRY_*/DAPP_*, ETH_*/ETHERSCAN_*/VERIFIER_* variable or .env overrides it; the deployment's record is here, and nothing of $label's"

  echo
  echo "2. $label'S STACK, SIMULATED AGAINST LIVE BASE"
  CURB_REGISTRY="$CURB_REGISTRY" CURB_ASSET_LABEL="$label" \
    "$FORGE" script script/DeployAssetStack.s.sol --rpc-url "$RPC" --sender "$CURB_DEPLOYER" >"$sim" 2>&1
  rc=$?
  grep -qi "SIMULATION COMPLETE" "$sim" || { tail -25 "$sim"; fail "the simulation did not complete (exit $rc). Do not broadcast. Full log: $sim"; }
  echo "        WHAT THE SCRIPT SAID - all of it:"
  sim_logs "$sim" | sed 's/^/      /'
  grep -q "chain id         8453" "$sim" || fail "that was not chain 8453."
  sim_checked_code "$sim" \
    || fail "the simulation never said it checked the unchanged contracts' code (requireUnchangedCode). Do not broadcast a script that does not check it."
  data="$(sim_safe_data "$sim")"
  [[ "$data" =~ ^0x[0-9a-fA-F]{72}$ ]] \
    || fail "the simulation printed no addLauncher call for the Safe (data ...). Do not broadcast. Full log: $sim"
  ok "the simulation built $label's stack against the live registry, admitted nothing, and printed the Safe's call"

  echo
  echo "3. $label'S START AND GRADUATION AT TODAY'S CHAINLINK PRICE"
  echo "        within ${USD_TOLERANCE_PCT}% of \$$USD_START and \$$USD_GRADUATION, as the full run's section 6"
  usd_gate "$sim"
  ok "$label starts within ${USD_TOLERANCE_PCT}% of \$$USD_START and graduates within ${USD_TOLERANCE_PCT}% of \$$USD_GRADUATION at today's price"

  echo
  echo "4. CAN THE DEPLOYER PAY"
  balw="$("$CAST" balance "$CURB_DEPLOYER" --rpc-url "$RPC" 2>/dev/null)" \
    || fail "could not read the deployer's balance from $RPC."
  balw="$(printf '%s' "$balw" | tr -d '\r\n')"
  [[ "$balw" =~ ^[0-9]+$ ]] || fail "the deployer's balance read is not a number: '$balw'."
  funding_gate "$sim" 0 "$balw"

  echo
  echo "================================================================"
  echo " EVERYTHING CHECKABLE WITHOUT A KEY HAS PASSED."
  echo "================================================================"
  echo
  echo " THE SAFE'S CALL, LAST OF ALL (DEPLOY.txt, ADDING A QUOTE ASSET, step 6),"
  echo " AND WHAT IT ADMITS FOR GOOD - a launcher is never removed:"
  echo "     to     $CURB_REGISTRY"
  echo "     value  0"
  echo "     data   $data"
  printf '%s\n' "$USD_TABLE" | sed 's/^ *//; s/^/     /'
  echo " The signers compare the data and these dollars on their devices."
  echo
  echo " THE ONE COMMAND LEFT IS YOURS TO SIGN, from the repository root, BASESCAN_API_KEY"
  echo " exported. Its first two lines re-run section 1 in that shell and start forge only"
  echo " on the line \"asset recheck passed <commit> <label>\":"
  echo
  print_asset_command "${CURB_WALLET_OPTION:-}" "$COMMIT" "$label"
  echo
  echo " THE MOMENT IT LANDS: cp broadcast/DeployAssetStack.s.sol/8453/run-latest.json"
  echo " deployments/base-mainnet/asset-$label.json (DEPLOY.txt, ADDING A QUOTE ASSET, step 3)."
}

# ============================================================================
# --selftest: fixed inputs through the functions above. Each case names the
# mistake it would have caught.
# ============================================================================
selftest() {
  local t n=0 bad=0 got rc v
  # THE SCRATCH REPOSITORIES BELOW ARE READ BY git AS THEY ARE, whatever this
  # shell exports for it (a hook's GIT_DIR, say); recheck, called directly
  # further down, would refuse such variables anyway.
  for v in $(env | grep -Eio '^GIT_[A-Za-z0-9_]*'); do unset "$v"; done
  t="$(mktemp -d)" || exit 1
  check() { # name expected actual
    n=$((n + 1))
    if [ "$2" = "$3" ]; then printf '  ok    %s\n' "$1"
    else printf '  FAIL  %s\n        expected: %s\n        got:      %s\n' "$1" "$2" "$3"; bad=$((bad + 1)); fi
  }

  # forge 1.x output with one vm.skip test: the suite line and the summary.
  printf '%s\n' \
    'Ran 2 tests for test/A.t.sol:A' \
    'Suite result: ok. 1 passed; 0 failed; 1 skipped; finished in 1.2ms (0.9ms CPU time)' \
    'Ran 1 tests for test/B.t.sol:B' \
    'Suite result: ok. 1 passed; 0 failed; 2 skipped; finished in 1.0ms (0.8ms CPU time)' \
    'Ran 2 test suites in 5ms (1.7ms CPU time): 2 tests passed, 0 failed, 3 skipped (5 total tests)' >"$t/tests.log"
  check "a skipped test is counted once, not once per suite line and again in the summary" \
    "3" "$(skipped_count "$t/tests.log")"
  printf '%s\n' 'Suite result: ok. 4 passed; 0 failed; 0 skipped; finished in 1ms' \
    'Ran 1 test suite in 2ms: 4 tests passed, 0 failed, 0 skipped (4 total tests)' >"$t/clean.log"
  check "nothing skipped reads as 0" "0" "$(skipped_count "$t/clean.log")"

  got="$(printf '?? src/a b.sol\0?? notes.md\0?? web/x.js\0' | dirty_entries)"
  check "an untracked source whose name git would quote still makes the tree dirty" "?? src/a b.sol" "$got"
  got="$(printf '?? lib/ğ.sol\0?? script/new.s.sol\0' | dirty_entries | wc -l | tr -d ' ')"
  check "untracked files under lib/ and script/ count, non-ASCII names included" "2" "$got"
  got="$(printf ' M DEPLOY.txt\0?? AUDIT-notes.txt\0' | dirty_entries)"
  check "a tracked change counts; an untracked note outside src/script/lib does not" " M DEPLOY.txt" "$got"
  got="$(printf '' | dirty_entries)"
  check "a clean status is clean" "" "$got"
  # WHAT GIT IGNORES, as git status --ignored reports it (!!): the unanchored
  # cache/, out/ and broadcast/ of .gitignore, matching inside src/, lib/ and
  # script/, and a .sol wherever the gate looks.
  got="$(printf '!! src/curb/cache/QuoteCache.sol\0!! lib/newdep/out/N.sol\0!! script/broadcast/B.sol\0' | dirty_entries \
    | grep -c '  <- ignored by git, but forge would compile it')"
  check "ignored files under src/, lib/ and script/ make the tree dirty, each with its note" "3" "$got"
  got="$(printf '!! web/e2e/Helper.sol\0!! test/cache/T.SOL\0!! lib/solady/remappings.txt\0' | dirty_entries | wc -l | tr -d ' ')"
  check "an ignored .sol anywhere in the paths, in any case, and any ignored file under lib/ count" "3" "$got"
  # Outside src/, script/ and lib/, so the .sol rule alone decides them: in a
  # directory python writes its bytecode to, and in any case.
  got="$(printf '!! test/__pycache__/X.Sol\0!! web/e2e/__pycache__/x.sol\0' | dirty_entries | wc -l | tr -d ' ')"
  check "a .sol is never excused, even in python's __pycache__, whatever the case of its extension" "2" "$got"
  # The control: what the founder's own checkout holds, ignored, in those paths.
  got="$(printf '%s\0' '!! script/b20/__pycache__/depth_probe.cpython-312.pyc' '!! script/b20/.wallet-session.json' \
    '!! web/e2e/.state.json' '!! web/e2e/test-results/.last-run.json' '!! web/test-results/.last-run.json' \
    '!! web/e2e/node_modules/@playwright/test/index.js' | dirty_entries)"
  check "python's bytecode, the wallet session and the browser suite's files do not count (the control)" "" "$got"

  mkdir -p "$t/repo"
  got="$(env -i PATH="$PATH" FOUNDRY_OPTIMIZER_RUNS=1 bash -c "$(declare -f build_overrides); build_overrides '$t/repo'")"
  check "a FOUNDRY_* variable in the environment is reported" "environment variable FOUNDRY_OPTIMIZER_RUNS" "$got"
  : >"$t/repo/.env"
  got="$(env -i PATH="$PATH" bash -c "$(declare -f build_overrides); build_overrides '$t/repo'")"
  check "a .env in the repository root is reported" "$t/repo/.env (forge loads it without being asked)" "$got"
  rm -f "$t/repo/.env"
  got="$(env -i PATH="$PATH" bash -c "$(declare -f build_overrides); build_overrides '$t/repo' '$t/home-foundry'")"
  check "no overrides reads as none" "" "$got"
  mkdir -p "$t/home-foundry" && : >"$t/home-foundry/foundry.toml"
  got="$(env -i PATH="$PATH" bash -c "$(declare -f build_overrides); build_overrides '$t/repo' '$t/home-foundry'")"
  check "a global ~/.foundry/foundry.toml is reported" "$t/home-foundry/foundry.toml (forge merges it under the project's)" "$got"
  # IN ANY CASE: forge's figment matches FOUNDRY_ whatever its case.
  got="$(env -i PATH="$PATH" foundry_optimizer_runs=1 Foundry_Bytecode_Hash=none dapp_libraries=x \
    bash -c "$(declare -f build_overrides); build_overrides '$t/repo'" | tr '\n' '|')"
  check "FOUNDRY_ and DAPP_ variables are reported whatever their case" \
    "environment variable Foundry_Bytecode_Hash|environment variable dapp_libraries|environment variable foundry_optimizer_runs|" \
    "$got"
  got="$(env -i PATH="$PATH" foundryish=1 my_foundry_runs=1 dapps=1 PATH_FOUNDRY_X=1 \
    bash -c "$(declare -f build_overrides); build_overrides '$t/repo'")"
  check "lower-case names that do not start with foundry_ or dapp_ are not reported (the control)" "" "$got"
  # WHAT forge WOULD SEND DIFFERENTLY: the price, the verifier, a signer.
  got="$(env -i PATH="$PATH" ETH_GAS_PRICE=1gwei VERIFIER_URL=https://verifier.invalid/api \
    bash -c "$(declare -f send_overrides); send_overrides" | tr '\n' '|')"
  check "an exported gas price and verifier URL are reported" \
    "environment variable ETH_GAS_PRICE|environment variable VERIFIER_URL|" "$got"
  got="$(env -i PATH="$PATH" ETHERSCAN_API_KEY=k NOT_ETH_X=1 ETHERSCAN_API_VERSION=v1 ETH_KEYSTORE_ACCOUNT=x \
    bash -c "$(declare -f send_overrides); send_overrides" | tr '\n' '|')"
  check "the whole families are reported, but not the key the command sets itself or a name that only contains ETH_" \
    "environment variable ETHERSCAN_API_VERSION|environment variable ETH_KEYSTORE_ACCOUNT|" "$got"
  got="$(env -i PATH="$PATH" ETH_RPC_URL=https://rpc.invalid ETH_FROM=0x1111111111111111111111111111111111111111 \
    bash -c "$(declare -f send_overrides); send_overrides" | tr '\n' '|')"
  check "ETH_RPC_URL and ETH_FROM, which forge script does not read, are refused with their family" \
    "environment variable ETH_FROM|environment variable ETH_RPC_URL|" "$got"
  # THE OPT-INS: exactly true or false, or unset. Each case starts from none set.
  allow_case() { # assignments NAME=VALUE...; prints what allow_values_bad refused, joined by |
    ( for v in "${ALLOW_NAMES[@]}"; do unset "$v"; done
      for v in "$@"; do printf -v "${v%%=*}" '%s' "${v#*=}"; done
      allow_values_bad | tr '\n' '|' )
  }
  check "no opt-in set, and each set to true or false, pass (the control)" "|" \
    "|$(allow_case)$(allow_case CURB_ALLOW_EOA_RECIPIENT=true CURB_ALLOW_NON_SAFE_RECIPIENT=false \
      CURB_ALLOW_EOA_POLICY_OWNER=true CURB_ALLOW_NON_SAFE_POLICY_OWNER=false CURB_ALLOW_SAME_RECIPIENT_AND_OWNER=true)"
  check "an opt-in ending in ; is refused, shell-quoted" 'CURB_ALLOW_SAME_RECIPIENT_AND_OWNER=false\;|' \
    "$(allow_case 'CURB_ALLOW_SAME_RECIPIENT_AND_OWNER=false;')"
  check "an opt-in ending in & or a newline is refused" "2" \
    "$(allow_case 'CURB_ALLOW_EOA_RECIPIENT=true&' "CURB_ALLOW_EOA_POLICY_OWNER=true"$'\n' | tr '|' '\n' | grep -c .)"
  for v in TRUE 1 yes ' true' ''; do
    check "the opt-in value '$v', neither exactly true nor exactly false, is refused" "1" \
      "$(allow_case "CURB_ALLOW_NON_SAFE_POLICY_OWNER=$v" | tr '|' '\n' | grep -c '^CURB_ALLOW_NON_SAFE_POLICY_OWNER=')"
  done

  check "no code is one key" "ONE KEY (no code)" "$(code_kind 0x)"
  check "a 23-byte 0xef0100 designator is one key" "ONE KEY (an EOA with an EIP-7702 delegation)" \
    "$(code_kind 0xef0100000000000000000000000000000000000000beef)"
  check "real code is a contract" "a contract, 3 bytes" "$(code_kind 0x600000)"
  code_kind "" >/dev/null && got=accepted || got=refused
  check "an empty answer (a failed read) is refused, not printed as one key" "refused" "$got"
  code_kind "Error: error sending request" >/dev/null && got=accepted || got=refused
  check "an error message instead of code is refused" "refused" "$got"

  for w in "--ledger" "--trezor" "--account deployer" "--interactives 1" \
           "--ledger --mnemonic-indexes 1" "--trezor --mnemonic-derivation-paths m/44'/60'/0'/0/1"; do
    wallet_option_ok "$w" && got=accepted || got=refused
    check "the wallet option '$w' is accepted" "accepted" "$got"
  done
  for w in "--private-key 0xabc" "--ledger --trezor" "--ledger --account x" "" \
           "--ledger --mnemonic-indexes 1,2" "--ledger --mnemonic-indexes 1 --mnemonic-indexes 2" \
           "--ledger --mnemonic-indexes" "--account x --mnemonic-indexes 1" "--interactives 1 --mnemonic-indexes 1" \
           "--ledger --mnemonic-derivation-paths m/44'/60'/0'/0/1;id" "--ledger --mnemonic-derivation-paths \"m/44'/60'\"" \
           "--mnemonic-indexes 1"; do
    wallet_option_ok "$w" && got=accepted || got=refused
    check "the wallet option '$w' is refused" "refused" "$got"
  done

  CURB_PLATFORM_RECIPIENT=0x1111111111111111111111111111111111111111 \
  CURB_POLICY_OWNER=0x2222222222222222222222222222222222222222 \
  CURB_DEPLOYER=0x3333333333333333333333333333333333333333 \
  CURB_SHARING_PUBLISHER=0x4444444444444444444444444444444444444444 \
  CURB_SHARING_KEEPER_PAYEE=0x5555555555555555555555555555555555555555 \
  CURB_SHARING_VETOERS=0x6666666666666666666666666666666666666666,0x7777777777777777777777777777777777777777
  CURB_FIRST_LAUNCH=0
  local c=0123456789abcdef0123456789abcdef01234567
  # THE HOLDER SHARING ROLES REACH THE COMMAND, each as given.
  got="$(print_command "--ledger" "$c" | grep -c '^ *CURB_SHARING_PUBLISHER=0x4444444444444444444444444444444444444444 \\$')|$(print_command "--ledger" "$c" | grep -c '^ *CURB_SHARING_KEEPER_PAYEE=0x5555555555555555555555555555555555555555 \\$')|$(print_command "--ledger" "$c" | grep -c '^ *CURB_SHARING_VETOERS=0x6666666666666666666666666666666666666666,0x7777777777777777777777777777777777777777 \\$')"
  check "the command carries the sharing publisher, keeper payee and vetoers it was checked with" "1|1|1" "$got"
  # THE ADDRESS FORMS (address_ok, address_list_ok).
  for v in 0x6666666666666666666666666666666666666666 \
           0x6666666666666666666666666666666666666666,0xabCDeF0123456789AbcdEf0123456789aBCDEF01; do
    address_list_ok "$v" && got=accepted || got=refused
    check "the vetoer list '$v' is accepted" "accepted" "$got"
  done
  # THE EIP-55 CHECKSUM (address_ok): A6's recorded recipient as written, and
  # with one letter's case flipped - the shape of a typo, which the forty hex
  # digits alone let through. The same address in one case carries none.
  for v in 0x52483b53c8C08Ece00932A65DaE70487dcCD21E0 0x52483b53c8c08ece00932a65dae70487dccd21e0 \
           0x52483B53C8C08ECE00932A65DAE70487DCCD21E0 0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed; do
    address_ok "$v" && got=accepted || got=refused
    check "the address '$v' (checksummed, or in one case) is accepted" "accepted" "$got"
  done
  for v in 0x52483b53c8c08Ece00932A65DaE70487dcCD21E0 0x52483b53c8C08Ece00932A65DaE70487dcCD21e0 \
           0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD; do
    address_ok "$v" && got=accepted || got=refused
    check "the mixed-case address '$v', one letter's case wrong, is refused" "refused" "$got"
  done
  address_list_ok 0x6666666666666666666666666666666666666666,0xAbCdEf0123456789abcdef0123456789ABCDEF01 \
    && got=accepted || got=refused
  check "a vetoer list holding a mixed-case address with a wrong checksum is refused" "refused" "$got"
  for v in "" "," "0x6666666666666666666666666666666666666666," ",0x6666666666666666666666666666666666666666" \
           "0x6666666666666666666666666666666666666666,,0x7777777777777777777777777777777777777777" \
           "0x6666666666666666666666666666666666666666, 0x7777777777777777777777777777777777777777" \
           "0x6666666666666666666666666666666666666666;0x7777777777777777777777777777777777777777" \
           "0x666666666666666666666666666666666666666" "6666666666666666666666666666666666666666aa"; do
    address_list_ok "$v" && got=accepted || got=refused
    check "the vetoer list '$v' is refused" "refused" "$got"
  done
  address_ok 0x6666666666666666666666666666666666666666 && got=accepted || got=refused
  check "an address is accepted (the control)" "accepted" "$got"
  address_ok "0x6666666666666666666666666666666666666666 " && got=accepted || got=refused
  check "an address with a trailing space is refused" "refused" "$got"
  # THE ROLES AGAINST EACH OTHER (sharing_roles_bad), in any case.
  got="$(sharing_roles_bad 0xaaaaAAAAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 0x2222222222222222222222222222222222222222 \
    0x6666666666666666666666666666666666666666,0x7777777777777777777777777777777777777777)"
  check "separate vetoers, none the publisher or the policy owner, pass (the control)" "" "$got"
  got="$(sharing_roles_bad 0xaaaaAAAAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 0x2222222222222222222222222222222222222222 \
    0x6666666666666666666666666666666666666666,0xAAAAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | grep -c 'is the sharing publisher')"
  check "a vetoer that is the publisher, in another case, is refused" "1" "$got"
  got="$(sharing_roles_bad 0xaaaaAAAAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 0x2222222222222222222222222222222222222222 \
    0x2222222222222222222222222222222222222222 | grep -c 'is the policy owner')"
  check "a vetoer that is the policy owner is refused" "1" "$got"
  got="$(sharing_roles_bad 0xaaaaAAAAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 0x2222222222222222222222222222222222222222 \
    0x6666666666666666666666666666666666666666,0x7777777777777777777777777777777777777777,0x6666666666666666666666666666666666666666 | grep -c 'listed twice')"
  check "a vetoer listed twice is refused" "1" "$got"
  # THE SIMULATION'S CODE CHECK (sim_checked_code).
  printf '%s\n' '== Logs ==' '  code identities match the pinned ones: curve, escrow, launch token, fee policy, buyback vault' >"$t/sim-code.log"
  sim_checked_code "$t/sim-code.log" && got=checked || got=unchecked
  check "a simulation that says it checked the unchanged code passes" "checked" "$got"
  printf '%s\n' '== Logs ==' '  === CURB ===' >"$t/sim-nocode.log"
  sim_checked_code "$t/sim-nocode.log" && got=checked || got=unchecked
  check "a simulation that never checked the unchanged code is refused" "unchecked" "$got"
  got="$(print_command "--trezor" "$c" | grep -c -- '--ledger')"
  check "a Trezor operator's command carries no --ledger" "0" "$got"
  got="$(print_command "--trezor" "$c" | tail -1 | tr -d ' ')"
  check "the command ends in the operator's own wallet option" "--trezor" "$got"
  got="$(print_command "" "$c" | grep -c -- '--ledger')"
  check "with no option chosen, the command guesses none" "0" "$got"
  got="$(print_command "" "$c" | grep -c 'CURB_ALLOW_EOA_POLICY_OWNER=')"
  check "the command carries the policy-owner opt-in the simulation ran with" "1" "$got"
  got="$(CURB_ALLOW_EOA_CREATOR=true; print_command "" "$c" | grep -c '^ *CURB_ALLOW_EOA_CREATOR=true \\$')"
  check "the command carries the \$CURB creator's opt-in the simulation ran with" "1" "$got"
  # $CURB, THE FIRST LAUNCH (first_launch_bad, first_words). Each case starts
  # from a good set and breaks one thing.
  first_case() { # assignments NAME=VALUE...; prints how many problems first_launch_bad found
    ( CURB_FIRST_LAUNCH=1 CURB_FIRST_NAME="Curb" CURB_FIRST_SYMBOL=CURB CURB_FIRST_URI="ipfs://x" CURB_FIRST_TAX_BPS=300
      CURB_FIRST_CREATOR=0x8888888888888888888888888888888888888888 CURB_FIRST_DEV_BUY=0 CURB_FIRST_SHARE=1
      for v in "$@"; do
        case "$v" in -*) unset "${v#-}" ;; *) printf -v "${v%%=*}" '%s' "${v#*=}" ;; esac
      done
      first_launch_bad 0x3333333333333333333333333333333333333333 | grep -c . )
  }
  check "a whole first launch passes (the control)" "0" "$(first_case)"
  check "CURB_FIRST_LAUNCH=0 asks nothing more (the control)" "0" "$(first_case CURB_FIRST_LAUNCH=0 -CURB_FIRST_NAME)"
  for v in -CURB_FIRST_LAUNCH CURB_FIRST_LAUNCH=true CURB_FIRST_LAUNCH= -CURB_FIRST_NAME CURB_FIRST_SYMBOL= -CURB_FIRST_URI \
           CURB_FIRST_TAX_BPS=99 CURB_FIRST_TAX_BPS=501 "CURB_FIRST_TAX_BPS=300 " CURB_FIRST_TAX_BPS=3e2 \
           CURB_FIRST_CREATOR=0x3333333333333333333333333333333333333333 \
           CURB_FIRST_CREATOR=0x0000000000000000000000000000000000000000 CURB_FIRST_CREATOR=0x88 \
           CURB_FIRST_DEV_BUY=1e17 CURB_FIRST_DEV_BUY=-1 CURB_FIRST_SHARE=yes -CURB_FIRST_SHARE \
           "CURB_FIRST_NAME=Curb"$'\n'"Coin" "CURB_FIRST_URI=ipfs://"$'\t'"x" "CURB_FIRST_NAME=Cürb" \
           "CURB_FIRST_NAME=Curb " "CURB_FIRST_SYMBOL= CURB"; do
    check "the first launch with ${v%%$'\n'*} is refused" "refused" "$( [ "$(first_case "$v")" -ge 1 ] && echo refused || echo passed)"
  done
  check "an empty URI is allowed (the control)" "0" "$(first_case CURB_FIRST_URI=)"
  check "the creator in another case than the deployer is still the deployer" "1" \
    "$(first_case CURB_FIRST_CREATOR=0x3333333333333333333333333333333333333333)"
  # THE DEPLOYER'S BALANCE AGAINST THE DEV BUY (wei_below), past 64 bits and
  # with leading zeros.
  got=""
  for v in 6:7 7:7 8:7 0:0 0:1 1:0 007:7 006:7 99999999999999999999:100000000000000000000 \
           100000000000000000000:99999999999999999999 18446744073709551615:18446744073709551616; do
    got+="$(wei_below "${v%%:*}" "${v#*:}" && echo below || echo not)|"
  done
  check "wei_below compares by value, not by length or as text alone" \
    "below|not|not|not|below|not|not|below|below|not|below|" "$got"
  # THE COMMAND CARRIES IT, each value one word as checked - a space and a
  # quote included - and nothing past CURB_FIRST_LAUNCH=0.
  got="$(CURB_FIRST_LAUNCH=1 CURB_FIRST_NAME="Curb's Coin" CURB_FIRST_SYMBOL=CURB CURB_FIRST_URI="ipfs://a b&c" \
    CURB_FIRST_TAX_BPS=300 CURB_FIRST_CREATOR=0x8888888888888888888888888888888888888888 CURB_FIRST_DEV_BUY=7 \
    CURB_FIRST_SHARE=1; eval "set -- $(print_command "--ledger" "$c" | grep '^ *CURB_FIRST_' | sed 's/ *\\$//' | tr '\n' ' ')"
    printf '%s|' "$@")"
  check "the command carries every CURB_FIRST_* as one word each" \
    "CURB_FIRST_LAUNCH=1|CURB_FIRST_NAME=Curb's Coin|CURB_FIRST_SYMBOL=CURB|CURB_FIRST_URI=ipfs://a b&c|CURB_FIRST_TAX_BPS=300|CURB_FIRST_CREATOR=0x8888888888888888888888888888888888888888|CURB_FIRST_DEV_BUY=7|CURB_FIRST_SHARE=1|" \
    "$got"
  check "with CURB_FIRST_LAUNCH=0 the command carries that alone" "CURB_FIRST_LAUNCH=0 \\" \
    "$(CURB_FIRST_NAME=x; print_command "--ledger" "$c" | grep '^ *CURB_FIRST_' | sed 's/^ *//')"
  check "the command still ends in the wallet option after the first launch's lines" "--ledger" \
    "$(CURB_FIRST_LAUNCH=1 CURB_FIRST_NAME=C CURB_FIRST_SYMBOL=C CURB_FIRST_URI= CURB_FIRST_TAX_BPS=300 \
       CURB_FIRST_CREATOR=0x8888888888888888888888888888888888888888 CURB_FIRST_DEV_BUY=0 CURB_FIRST_SHARE=0;
       print_command "--ledger" "$c" | tail -1 | tr -d ' ')"

  # THE SIGNER (signer_args, signer_check): forge's account selectors in cast's
  # singular forms, and the device's answer against CURB_DEPLOYER.
  check "--ledger asks cast for --ledger" "--ledger|" "$(signer_args --ledger | tr '\n' '|')"
  check "an account index is cast's --mnemonic-index" "--trezor|--mnemonic-index|2|" \
    "$(signer_args "--trezor --mnemonic-indexes 2" | tr '\n' '|')"
  check "a derivation path is cast's --mnemonic-derivation-path, whole" "--ledger|--mnemonic-derivation-path|m/44'/60'/1'/0/0|" \
    "$(signer_args "--ledger --mnemonic-derivation-paths m/44'/60'/1'/0/0" | tr '\n' '|')"
  check "a keystore and a pasted key ask cast nothing" "|" "$(signer_args "--account deployer")|$(signer_args "--interactives 1")"
  printf '#!/usr/bin/env bash\n: >"%s/cast-asked"\n[ "$1 $2" = "wallet address" ] && echo 0x3333333333333333333333333333333333333333\n' "$t" \
    >"$t/cast-device" && chmod +x "$t/cast-device"
  printf '#!/usr/bin/env bash\necho "Error: hidapi: device not found" >&2; exit 1\n' >"$t/cast-nodevice" && chmod +x "$t/cast-nodevice"
  ( CAST="$t/cast-device"; signer_check --ledger 0x3333333333333333333333333333333333333333 ) >/dev/null 2>&1 \
    && got=passed || got=stopped
  check "a device that answers with the deployer passes (the control)" "passed" "$got"
  ( CAST="$t/cast-device"; signer_check --ledger 0x4444444444444444444444444444444444444444 ) >/dev/null 2>&1 \
    && got=passed || got=stopped
  check "a device that answers with another address stops the preflight" "stopped" "$got"
  got="$( (CAST="$t/cast-nodevice"; signer_check --ledger 0x3333333333333333333333333333333333333333) 2>&1 )" && got=passed
  check "a device that does not answer stops it, saying how to attach one to WSL" "1" "$(grep -c 'usbipd attach --wsl' <<<"$got")"
  rm -f "$t/cast-asked"
  got="$( (CAST="$t/cast-device"; signer_check "--account deployer" 0x3333333333333333333333333333333333333333) 2>&1 )"
  check "a keystore is not asked - no password is ever asked for - and the by-hand line is printed" "0|1" \
    "$([ -e "$t/cast-asked" ] && echo 1 || echo 0)|$(grep -c 'wallet address --account deployer' <<<"$got")"

  # THE DOLLARS (usd_shape_bad): label decimals phantom threshold feed-decimals
  # answer updated-at description expected. WETH's own figures at $2,746.87.
  local now=1800000000 T=$'\t'
  usd_line() { printf '%s\n' "WETH${T}18${T}1460000000000000000${T}3940000000000000000${T}8${T}$1${T}$2${T}${3:-ETH / USD}${T}ETH / USD"; }
  check "WETH at the price it was sized at passes" "0" "$(usd_line 274687000000 $now | usd_shape_bad $now | grep -c '^PROBLEM')"
  check "and the table line says where it starts and graduates" "1" \
    "$(usd_line 274687000000 $now | usd_shape_bad $now | grep -c 'starts at \$4,010  graduates at \$54,862')"
  check "4.9% higher still passes" "0" "$(usd_line 287400000000 $now | usd_shape_bad $now | grep -c '^PROBLEM')"
  check "6% lower fails both the start and the graduation" "2" \
    "$(usd_line 258200000000 $now | usd_shape_bad $now | grep -c '^PROBLEM')"
  check "a feed a day older than allowed fails" "1" \
    "$(usd_line 274687000000 $((now - 97 * 3600)) | usd_shape_bad $now | grep -c 'too stale')"
  check "a feed that names itself otherwise fails" "1" \
    "$(usd_line 274687000000 $now "BTC / USD" | usd_shape_bad $now | grep -c 'not the feed the site prices it by')"
  check "an answer that is not a price fails" "1" "$(usd_line -1 $now | usd_shape_bad $now | grep -c 'not a price')"
  # THE FEED TABLES (feed_table): the repository's own agree; one feed moved in
  # the keeper's copy is refused.
  feed_table "${SELF%/script/b20/*}/web/prices.js" "${SELF%/script/b20/*}/services/sharer/deploy/sharer.example.json" \
    >"$t/feeds" 2>&1 && got=agree || got=disagree
  check "the site's and the keeper's feed tables agree (the control)" "agree" "$got"
  check "and WETH is priced by ETH / USD, which the keeper names too" "1" \
    "$(grep -c '^0x4200000000000000000000000000000000000006 0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70 keeper ETH / USD$' "$t/feeds")"
  # A LISTED ASSET, LOOKED UP (feed_of): the site's feed and the description it
  # expects when both copies name it; a stop when the keeper's copy does not -
  # TSLAc, which web/prices.js prices ahead of any listing and the keeper's
  # example does not name, is the repository's own case of it; and a stop when
  # neither does.
  got="$(feed_of "$(cat "$t/feeds")" NVDAc 0xb20000000000000000000078ee7ce2fE4908108C)"
  check "a listed asset both copies name gives the site's feed and description (the control)" \
    "0x04689a41629776563e6822f76f2e57d148d28513 Coinbase NVDA" "$got"
  got="$(feed_of "$(cat "$t/feeds")" TSLAc 0xb2000000000000000000001e800a7f5189430cd0)"
  check "a listed asset the site prices and the keeper's sharer.example.json does not stops, naming that file" "1" \
    "$(grep -c '^PROBLEM TSLAc (0xb2000000000000000000001e800a7f5189430cd0) has no feed in services/sharer/deploy/sharer.example.json sharing.feeds' <<<"$got")"
  sed '/"0xb20000000000000000000078ee7ce2fe4908108c": {/d' \
    "${SELF%/script/b20/*}/services/sharer/deploy/sharer.example.json" >"$t/sharer-short.json"
  feed_table "${SELF%/script/b20/*}/web/prices.js" "$t/sharer-short.json" >"$t/feeds-short" 2>&1 && got=agree || got=disagree
  check "a keeper copy that drops a listed asset still agrees feed by feed" "agree" "$got"
  check "and the asset it dropped then stops section 6" "1" \
    "$(feed_of "$(cat "$t/feeds-short")" NVDAc 0xb20000000000000000000078ee7ce2fE4908108C | grep -c '^PROBLEM NVDAc .* has no feed in services/sharer/deploy/sharer.example.json')"
  check "an asset neither copy names stops, naming web/prices.js" "1" \
    "$(feed_of "$(cat "$t/feeds")" DOGE 0x1111111111111111111111111111111111111111 | grep -c '^PROBLEM DOGE (0x1111111111111111111111111111111111111111) has no Chainlink feed in web/prices.js')"
  sed 's/0x07da0e54543a844a80abe69c8a12f22b3aa59f9d/0x07da0e54543a844a80abe69c8a12f22b3aa59f9e/' \
    "${SELF%/script/b20/*}/services/sharer/deploy/sharer.example.json" >"$t/sharer-moved.json"
  feed_table "${SELF%/script/b20/*}/web/prices.js" "$t/sharer-moved.json" >"$t/feeds" 2>&1 && got=agree || got=disagree
  check "a feed the keeper names and the site does not stops it, naming the asset" "disagree 1" \
    "$got $(grep -c '^PROBLEM 0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf' "$t/feeds")"
  # THE OPT-INS ARE PRINTED SHELL-QUOTED: true and false as they are, and a
  # value that ever got past section 1 as one word, read back by the shell.
  got="$(CURB_ALLOW_EOA_RECIPIENT=true; print_command "--ledger" "$c" | grep -c '^ *CURB_ALLOW_EOA_RECIPIENT=true \\$')"
  check "an opt-in set to true is printed as true (the control)" "1" "$got"
  got="$(CURB_ALLOW_SAME_RECIPIENT_AND_OWNER='false;'; eval "set -- $(print_command "--ledger" "$c" \
    | grep 'CURB_ALLOW_SAME_RECIPIENT_AND_OWNER=' | sed 's/ *\\$//')"; printf '%s|' "$#" "$@")"
  check "an opt-in holding ; is printed so the shell reads it as one word, ; included" \
    "1|CURB_ALLOW_SAME_RECIPIENT_AND_OWNER=false;|" "$got"
  got="$(CURB_DEMO_LAUNCH=true print_command "--ledger" "$c" | grep -c '^ *CURB_DEMO_LAUNCH=false \\$')"
  check "the command turns the demo launch off even when the shell has it on" "1" "$got"
  got="$(print_command "--ledger" "$c" | head -2 | sed 's/^ *//' | tr '\n' '|')"
  check "the command starts by re-running section 1 on the commit checked, and goes on only on its pass line" \
    "[ \"\$(env -u SHELLOPTS -u BASHOPTS -u BASH_ENV -u ENV bash script/b20/preflight-mainnet.sh --recheck $c)\" \\|= \"recheck passed $c\" ] && \\|" \
    "$got"
  # THE EXPLORER KEY GOES TO forge IN ITS ENVIRONMENT, named, expanded quoted
  # at signing time - never on its command line.
  got="$(print_command "--ledger" "$c" | grep -c '^ *ETHERSCAN_API_KEY="\$BASESCAN_API_KEY" \\$')"
  check "the explorer key is handed to forge as ETHERSCAN_API_KEY, expanded quoted at signing time" "1" "$got"
  got="$(print_command "--ledger" "$c" | grep -c -- '--etherscan-api-key')"
  check "the command puts no explorer key on forge's command line" "0" "$got"
  # THE PATH REACHES forge AS ONE ARGUMENT: the shell reads the printed line.
  got="$(eval "set -- $(print_command "--ledger --mnemonic-derivation-paths m/44'/60'/1'/0/0" "$c" | tail -1)"; printf '%s|' "$#" "$@")"
  check "a derivation path is printed so the shell passes it whole" \
    "3|--ledger|--mnemonic-derivation-paths|m/44'/60'/1'/0/0|" "$got"
  got="$(print_command "--ledger --mnemonic-indexes 2" "$c" | tail -1 | sed 's/^ *//')"
  check "an account index is printed as given" "--ledger --mnemonic-indexes 2" "$got"
  # THE ENDPOINT REACHES forge AS ONE ARGUMENT TOO: bare, the & would end the
  # command there, and set would run in the background.
  got="$(RPC='https://base.example.invalid/v2/k3y?a=1&b=2'; eval "set -- $(print_command "--ledger" "$c" \
    | grep -e '--rpc-url' | sed 's/ *\\$//')"; printf '%s|' "$#" "$@")"
  check "an endpoint holding ? and & is printed so the shell passes it whole" \
    "2|--rpc-url|https://base.example.invalid/v2/k3y?a=1&b=2|" "$got"
  got="$(RPC=https://mainnet.base.org; endpoint_note 2>/dev/null)"
  check "the public endpoint gets no note about a key in its URL, and one about its rate limit" "0|1" \
    "$(grep -c 'shell history' <<<"$got")|$(grep -c 'rate-limits' <<<"$got")"
  got="$(RPC='https://base.example.invalid/v2/k3y'; endpoint_note 2>/dev/null | grep -c 'shell history')"
  check "an endpoint of the operator's own is flagged: its URL, key and all, is in the command" "1" "$got"

  ( BASESCAN_API_KEY=""; explorer_key_ok ) && got=accepted || got=refused
  check "an empty explorer key is refused" "refused" "$got"
  ( unset BASESCAN_API_KEY; explorer_key_ok ) && got=accepted || got=refused
  check "an unset explorer key is refused" "refused" "$got"
  ( BASESCAN_API_KEY="AB CD"; explorer_key_ok ) && got=accepted || got=refused
  check "an explorer key with whitespace is refused" "refused" "$got"
  ( BASESCAN_API_KEY="ABC123"; explorer_key_ok ) && got=accepted || got=refused
  check "a one-word explorer key is accepted" "accepted" "$got"

  # THE PRINTED COMMAND, RUN, in a scratch checkout holding this file, with a
  # forge that only records that it was started. Each case is one thing that
  # changed between the preflight and the signature; forge must not start.
  #
  # IT HOLDS THE REPOSITORY'S OWN .gitignore, since what that file hides is
  # part of what the gate must see through (its unanchored cache/, out/ and
  # broadcast/), and part of what the founder's ordinary checkout holds.
  #
  # ITS SOURCE HOLDS AN ADDRESS CONSTANT, so that one address can be swapped
  # for another in an edit of the same size (the stat-data cases below).
  mkdir -p "$t/sign/script/b20" "$t/sign/src" "$t/home" && cp "$SELF" "$t/sign/script/b20/preflight-mainnet.sh" \
    && cp "${SELF%/script/b20/*}/.gitignore" "$t/sign/.gitignore" && (
    cd "$t/sign" && git init -q && printf 'address constant R = 0x1111111111111111111111111111111111111111;\n' >src/t.sol \
      && printf '#!/usr/bin/env bash\necho "size gate (the selftest stand-in)"\nexit "$(cat "%s/gate-rc" 2>/dev/null || echo 0)"\n' \
           "$t" >script/b20/size-gate.sh \
      && git add . && git -c user.email=selftest@invalid -c user.name=selftest commit -qm init
  ) >/dev/null 2>&1
  cp "$t/sign/src/t.sol" "$t/orig-t.sol"
  local sc cmd ov key=(BASESCAN_API_KEY=selftest-secret-value)
  sc="$(cd "$t/sign" && git rev-parse HEAD)"
  # THE FAKE forge ALSO KEEPS ITS ARGUMENTS AND THE EXPLORER KEY IT WAS HANDED,
  # so what reached forge, and by which road, can be asked afterwards.
  cat >"$t/fake-forge" <<FORGE && chmod +x "$t/fake-forge"
#!/usr/bin/env bash
: >"$t/forge-ran"
printf '%s\n' "\$@" >"$t/forge-argv"
printf '%s' "\${ETHERSCAN_API_KEY-(unset)}" >"$t/forge-key"
FORGE
  cmd="$(FORGE="$t/fake-forge"; print_command "--ledger" "$sc")"
  signing_in() { # shell, env assignments for the signing shell; prints whether forge started
    local sh="$1"; shift
    rm -f "$t/forge-ran" "$t/forge-argv" "$t/forge-key"
    # ${key[@]+...}: an emptied key array (the unset case) expands to nothing
    # under set -u, rather than to an error.
    (cd "$t/sign" && env -i PATH="$PATH" HOME="$t/home" ${key[@]+"${key[@]}"} "$@" "$sh" -c "$cmd") \
      >"$t/sign.log" 2>&1
    [ -e "$t/forge-ran" ] && echo "forge started" || echo "forge did not start"
  }
  signing() { signing_in bash "$@"; }
  check "a signing shell the preflight would pass starts forge (the control)" "forge started" "$(signing)"
  check "forge was started with --verify (the control)" "1" "$(grep -cx -- '--verify' "$t/forge-argv" 2>/dev/null)"
  check "the explorer key's value is not on forge's command line" "0" \
    "$(grep -c selftest-secret-value "$t/forge-argv" 2>/dev/null)"
  check "forge finds the explorer key in its environment, as ETHERSCAN_API_KEY" "selftest-secret-value" \
    "$(cat "$t/forge-key" 2>/dev/null)"
  check "an ETHERSCAN_API_KEY already exported does not stop it: the command sets its own" "forge started" \
    "$(signing ETHERSCAN_API_KEY=selftest-other-key)"
  check "and forge is handed BASESCAN_API_KEY's value under that name, not the exported one" "selftest-secret-value" \
    "$(cat "$t/forge-key" 2>/dev/null)"
  # A forge PATH WITH A SPACE: bare, the shell ran the path up to the space.
  mkdir -p "$t/forge dir" && cp "$t/fake-forge" "$t/forge dir/forge"
  cmd="$(FORGE="$t/forge dir/forge"; print_command "--ledger" "$sc")"
  check "a forge whose path holds a space is still the forge started" "forge started" "$(signing)"
  cmd="$(FORGE="$t/fake-forge"; print_command "--ledger" "$sc")"
  check "an exported FOUNDRY_PROFILE stops the command before forge" "forge did not start" "$(signing FOUNDRY_PROFILE=x)"
  check "a FOUNDRY_BROADCAST left from a rehearsal stops it" "forge did not start" \
    "$(signing FOUNDRY_BROADCAST=broadcast/local)"
  # IN ANY CASE (build_overrides): forge reads these as it reads the capitals.
  check "an exported foundry_broadcast, in lower case, stops it" "forge did not start" \
    "$(signing foundry_broadcast=elsewhere)"
  check "an exported Foundry_Bytecode_Hash stops it" "forge did not start" "$(signing Foundry_Bytecode_Hash=none)"
  check "an exported dapp_optimizer_runs, in lower case, stops it (forge reads it: optimizer_runs 200 -> 7)" \
    "forge did not start" "$(signing dapp_optimizer_runs=7)"
  check "lower-case names that do not start with foundry_ or dapp_ do not stop it (the control)" "forge started" \
    "$(signing foundryish=1 my_foundry_runs=1 dapps=1)"
  # WHAT forge READS IN PLACE OF A FLAG THE COMMAND LEAVES OUT (send_overrides).
  for ov in ETH_GAS_PRICE=1gwei ETH_PRIORITY_GAS_PRICE=1gwei VERIFIER_URL=https://verifier.invalid/api \
            VERIFIER_API_KEY=selftest-verifier-key ETH_KEYSTORE_ACCOUNT=other; do
    check "an exported ${ov%%=*} stops it" "forge did not start" "$(signing "$ov")"
  done
  signing ETH_GAS_PRICE=1gwei >/dev/null
  check "that refusal names the variable (the control)" "1" \
    "$(grep -c 'environment variable ETH_GAS_PRICE' "$t/sign.log")"
  # AND WHAT IT DOES NOT READ, REFUSED WITH ITS FAMILY - and the refusal says
  # so, rather than that forge reads it in place of a flag.
  for ov in ETH_RPC_URL=https://rpc.invalid ETH_FROM=0x1111111111111111111111111111111111111111; do
    check "an exported ${ov%%=*}, which forge script does not read, stops it too" "forge did not start" "$(signing "$ov")"
  done
  check "and the refusal says the family is refused as a whole, not that forge reads each one" \
    "named 1, as a whole 1, reads each 0" \
    "named $(grep -c 'environment variable ETH_FROM' "$t/sign.log"), as a whole $(grep -c 'refused as a whole' "$t/sign.log"), reads each $(grep -c 'reads each of these' "$t/sign.log")"
  # THE OPT-INS IN THE SIGNING SHELL (allow_values_bad), each true, false or
  # unset, and the command's own, printed from a value that ends in ;: bare,
  # the ; ended the command there and forge ran whether or not the recheck
  # had passed. The tree is dirty for that case, so the recheck must stop.
  check "an opt-in exported as yes in the signing shell stops it" "forge did not start" \
    "$(signing CURB_ALLOW_EOA_RECIPIENT=yes)"
  check "opt-ins exported as true and false do not (the control)" "forge started" \
    "$(signing CURB_ALLOW_EOA_RECIPIENT=true CURB_ALLOW_NON_SAFE_POLICY_OWNER=false)"
  cmd="$(FORGE="$t/fake-forge"; CURB_ALLOW_SAME_RECIPIENT_AND_OWNER='false;'; print_command "--ledger" "$sc")"
  echo edited >"$t/sign/src/t.sol"
  check "a command printed from an opt-in ending in ; still starts forge only if the recheck passes" \
    "forge did not start" "$(signing)"
  (cd "$t/sign" && git checkout -q -- src/t.sol) >/dev/null 2>&1
  cmd="$(FORGE="$t/fake-forge"; print_command "--ledger" "$sc")"
  check "an empty explorer key stops it" "forge did not start" "$(signing BASESCAN_API_KEY=)"
  key=()
  check "an unset explorer key stops it" "forge did not start" "$(signing)"
  key=(BASESCAN_API_KEY=selftest-secret-value)
  signing FOUNDRY_OPTIMIZER_RUNS=1 >/dev/null
  check "the refusal's own output is what the log caught (the control)" "1" \
    "$(grep -c 'environment variable FOUNDRY_OPTIMIZER_RUNS' "$t/sign.log")"
  # THE KEY'S VALUE, LOOKED FOR WHERE IT COULD SHOW: the ok line of a recheck
  # that passes, and the refusal of a key that holds whitespace. Each log is
  # first shown to hold that line, so a 0 below is about the value, not about
  # a log that caught nothing.
  signing >/dev/null
  check "a passing recheck's ok line is what the log caught (the control)" "1" \
    "$(grep -c 'recheck: .*explorer key set' "$t/sign.log")"
  check "the explorer key's value is not printed when the recheck passes" "0" \
    "$(grep -c selftest-secret-value "$t/sign.log")"
  signing BASESCAN_API_KEY="selftest-secret-value with-space" >/dev/null
  check "a refused explorer key's refusal is what the log caught (the control)" "1" \
    "$(grep -c 'BASESCAN_API_KEY is not exported in this shell, or holds whitespace' "$t/sign.log")"
  check "the explorer key's value is never printed" "0" "$(grep -c selftest-secret-value "$t/sign.log")"
  : >"$t/sign/.env"
  check "a .env created since the preflight stops it" "forge did not start" "$(signing)"
  rm -f "$t/sign/.env"
  mkdir -p "$t/home/.foundry" && : >"$t/home/.foundry/foundry.toml"
  check "a global foundry.toml stops it" "forge did not start" "$(signing)"
  rm -rf "$t/home/.foundry"
  : >"$t/sign/src/new.sol"
  check "an untracked source added since the preflight stops it" "forge did not start" "$(signing)"
  git -C "$t/sign" config status.showUntrackedFiles no
  check "and still stops it with status.showUntrackedFiles=no" "forge did not start" "$(signing)"
  git -C "$t/sign" config --unset status.showUntrackedFiles
  rm -f "$t/sign/src/new.sol"
  (cd "$t/sign" && git update-index --skip-worktree src/t.sol && echo edited >src/t.sol) >/dev/null 2>&1
  check "a source edited under skip-worktree since the preflight stops it" "forge did not start" "$(signing)"
  (cd "$t/sign" && git update-index --no-skip-worktree src/t.sol && git checkout -q -- src/t.sol) >/dev/null 2>&1
  (cd "$t/sign" && : >src/t2.sol && git add . && git -c user.email=selftest@invalid -c user.name=selftest commit -qm moved) \
    >/dev/null 2>&1
  check "a commit other than the one checked stops it" "forge did not start" "$(signing)"
  (cd "$t/sign" && git reset -q --hard "$sc") >/dev/null 2>&1
  mkdir -p "$t/sign/broadcast/DeployCurb.s.sol/8453" && : >"$t/sign/broadcast/DeployCurb.s.sol/8453/run-latest.json"
  check "an earlier run's record stops it" "forge did not start" "$(signing)"
  rm -rf "$t/sign/broadcast"
  # WHAT GIT WOULD NOT HAVE SHOWN, each undone before the next: a source that an
  # ignore rule hides, an edit a file watcher missed, a replaced commit.
  mkdir -p "$t/sign/src/curb/cache" && : >"$t/sign/src/curb/cache/QuoteCache.sol"
  check "a source the repository's own .gitignore hides (its unanchored cache/) stops it" "forge did not start" \
    "$(signing)"
  check "and the refusal names it as ignored (the control)" "1" \
    "$(grep -c 'src/curb/cache/QuoteCache.sol  <- ignored by git' "$t/sign.log")"
  rm -rf "$t/sign/src/curb"
  : >"$t/sign/src/Helper.sol" && echo 'src/Helper.sol' >>"$t/sign/.git/info/exclude"
  check "a source hidden by .git/info/exclude stops it" "forge did not start" "$(signing)"
  rm -f "$t/sign/src/Helper.sol"
  mkdir -p "$t/sign/lib/solady/src" && : >"$t/sign/lib/solady/src/S.sol" && printf 'lib/\n' >"$t/xignore" \
    && git -C "$t/sign" config core.excludesFile "$t/xignore"
  check "a new library hidden by a core.excludesFile stops it" "forge did not start" "$(signing)"
  git -C "$t/sign" config --unset core.excludesFile
  rm -rf "$t/sign/lib"
  # A WATCHER THAT ANSWERS "NOTHING CHANGED" (fsmonitor protocol 2: a token, a
  # NUL, no paths), given two runs of git status to mark every entry valid.
  printf '#!/usr/bin/env bash\nprintf "tok\\0"\n' >"$t/sign/.git/fsmon" && chmod +x "$t/sign/.git/fsmon"
  (cd "$t/sign" && git config core.fsmonitor .git/fsmon && git status >/dev/null && git status >/dev/null \
    && echo 'contract Evil {}' >>src/t.sol) >/dev/null 2>&1
  check "(the precondition) plain git status misses that edit" "" "$(cd "$t/sign" && git status --porcelain 2>&1)"
  check "a source edit that a file watcher (core.fsmonitor) missed stops it" "forge did not start" "$(signing)"
  (cd "$t/sign" && git config --unset core.fsmonitor && git checkout -q -- src/t.sol) >/dev/null 2>&1
  # A REPLACED COMMIT: HEAD still names the commit checked, and git reads
  # another commit's files in its place.
  (cd "$t/sign" && git checkout -q -b other && echo 'contract Other {}' >src/t.sol \
    && git -c user.email=selftest@invalid -c user.name=selftest commit -qam other \
    && git checkout -q - && git replace "$sc" other && git reset -q --hard HEAD) >/dev/null 2>&1
  check "(the precondition) HEAD is the commit checked, its replacement's files are out, plain git status is clean" \
    "$sc|contract Other {}|" \
    "$(cd "$t/sign" && git rev-parse HEAD)|$(cat "$t/sign/src/t.sol")|$(cd "$t/sign" && git status --porcelain)"
  check "a commit replaced (git replace) since the preflight stops it" "forge did not start" "$(signing)"
  (cd "$t/sign" && git replace -d "$sc" && git reset -q --hard "$sc" && git branch -q -D other) >/dev/null 2>&1
  # WHAT STEERS git ITSELF, from the shell or from its own config: which
  # checkout it compares, which attributes it applies, which stat data it
  # trusts. In each case src/t.sol is edited in the root, where forge builds.
  #
  # restore_t PUTS IT BACK AS git WRITES IT - removed first, since git checkout
  # skips a file whose stat data it still trusts - and refreshes the index.
  # Copying the committed bytes back is not the same: under Windows git's
  # core.autocrlf the checkout holds CRLF, and a size unlike the index's reads
  # as modified without git reading a byte. The same-size edits below are made
  # from the file as checked out, for the same reason, and written in place
  # (1<>), so the size stays the index's even where sed drops a CR (MSYS).
  local keep="sh -c 'cat >/dev/null; cat \"$t/orig-t.sol\"'"
  restore_t() {
    rm -f "$t/sign/src/t.sol" && git -C "$t/sign" checkout -q -- src/t.sol && git -C "$t/sign" status >/dev/null 2>&1
  }
  cp -a "$t/sign" "$t/sign-copy" && echo 'contract Evil {}' >"$t/sign/src/t.sol"
  check "(the precondition) git pointed at a clean copy of the checkout reads a clean tree" "" \
    "$(cd "$t/sign" && GIT_WORK_TREE="$t/sign-copy" git status --porcelain 2>&1)"
  check "a work tree elsewhere (GIT_WORK_TREE, a clean copy) stops it: forge builds the root's edited source" \
    "forge did not start" "$(signing GIT_WORK_TREE="$t/sign-copy")"
  check "and the refusal names the variable (the control)" "1" "$(grep -c 'environment variable GIT_WORK_TREE' "$t/sign.log")"
  check "GIT_DIR and GIT_WORK_TREE naming the copy stop it" "forge did not start" \
    "$(signing GIT_DIR="$t/sign-copy/.git" GIT_WORK_TREE="$t/sign-copy")"
  git -C "$t/sign" config core.worktree "$t/sign-copy"
  check "(the precondition) with core.worktree naming the copy, plain git status reads a clean tree" "" \
    "$(cd "$t/sign" && git status --porcelain 2>&1)"
  check "core.worktree naming a clean copy, with nothing exported, stops it" "forge did not start" "$(signing)"
  check "and the refusal says git's work tree is the copy, and that core.worktree is set (the control)" "1|1" \
    "$(grep -c "git's work tree is .*sign-copy, not " "$t/sign.log")|$(grep -c 'core.worktree is set' "$t/sign.log")"
  git -C "$t/sign" config --unset core.worktree
  restore_t
  # A CLEAN FILTER that hands git the committed bytes whatever the file holds.
  # git re-reads a file - through the filter - when its size is unchanged and
  # its mtime is not, so the edit is one of the same size: one address
  # constant for another. (A size change it calls modified without reading.)
  echo 'src/t.sol filter=keep' >"$t/sign/.git/info/attributes" && git -C "$t/sign" config filter.keep.clean "$keep" \
    && sed 's/1111/2222/g' "$t/sign/src/t.sol" >"$t/edit" && cat "$t/edit" 1<>"$t/sign/src/t.sol"
  check "(the precondition) a clean filter named in .git/info/attributes makes plain git status miss the edit" "" \
    "$(cd "$t/sign" && git status --porcelain 2>&1)"
  check "a source edit that a clean filter (.git/info/attributes) hides stops it" "forge did not start" "$(signing)"
  check "and the refusal names the file and its filter (the control)" "1" \
    "$(grep -c 'converted src/t\.sol  <- .*filter: keep' "$t/sign.log")"
  rm -f "$t/sign/.git/info/attributes" && echo 'src/t.sol filter=keep' >"$t/sign/.gitattributes"
  check "(the precondition) so does one named in an untracked root .gitattributes, outside the gate's paths" "" \
    "$(cd "$t/sign" && git status --porcelain -- src 2>&1)"
  check "a source edit hidden by a filter in an untracked root .gitattributes stops it" "forge did not start" "$(signing)"
  rm -f "$t/sign/.gitattributes" && git -C "$t/sign" config --unset filter.keep.clean
  printf 'src/** filter=keep\n' >"$t/attrs"
  check "a filter and an attributes file given only in the shell (GIT_CONFIG_COUNT) stop it" "forge did not start" \
    "$(signing GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=core.attributesFile GIT_CONFIG_VALUE_0="$t/attrs" \
      GIT_CONFIG_KEY_1=filter.keep.clean GIT_CONFIG_VALUE_1="$keep")"
  check "and the refusal names GIT_CONFIG_COUNT (the control)" "1" \
    "$(grep -c 'environment variable GIT_CONFIG_COUNT' "$t/sign.log")"
  # A SAME-SIZE EDIT WRITTEN IN PLACE, ITS MTIME PUT BACK. The committed bytes
  # get an mtime in the past, and git status then stores it: a file written in
  # the same second as the index is one git re-reads every time (racy git),
  # which would hide what this case is about.
  restore_t && touch -t 202601010000 "$t/sign/src/t.sol" && git -C "$t/sign" status >/dev/null 2>&1
  sed 's/1111/2222/g' "$t/sign/src/t.sol" >"$t/edit" && cat "$t/edit" 1<>"$t/sign/src/t.sol" \
    && touch -t 202601010000 "$t/sign/src/t.sol"
  git -C "$t/sign" config core.trustctime false
  check "(the precondition) under core.trustctime=false plain git status misses that edit" "0x2222|" \
    "$(grep -o '0x2222' "$t/sign/src/t.sol" | head -1)|$(cd "$t/sign" && git status --porcelain 2>&1)"
  check "a same-size edit with its mtime put back, under core.trustctime=false, stops it" "forge did not start" \
    "$(signing)"
  check "and the refusal names the file whose bytes differ (the control)" "1" \
    "$(grep -c 'differs src/t\.sol  <- ' "$t/sign.log")"
  git -C "$t/sign" config --unset core.trustctime
  check "and under core.trustctime=false given only in the shell (GIT_CONFIG_COUNT)" "forge did not start" \
    "$(signing GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.trustctime GIT_CONFIG_VALUE_0=false)"
  restore_t
  # THE CONTROL: what an editor's terminal exports (VS Code: GIT_ASKPASS) and a
  # clean tree.
  check "GIT_ASKPASS, GIT_EDITOR, GIT_PAGER and GIT_TERMINAL_PROMPT do not stop it (the control)" "forge started" \
    "$(signing GIT_ASKPASS=/usr/bin/true GIT_EDITOR=vi GIT_PAGER=less GIT_TERMINAL_PROMPT=0)"
  # A RECHECK THAT RAN NOTHING AND EXITED 0. The signing shell's environment
  # can do that to the bash the command starts: SHELLOPTS=noexec, which dash,
  # zsh and fish pass on unchanged (bash itself would obey it first, so those
  # cases run the command in dash), a BASH_ENV file ending in exit 0, an
  # exported function named after the builtin the script calls first. The
  # tree is dirty in each, so a recheck that ran would stop forge.
  echo 'contract Evil {}' >"$t/sign/src/t.sol"
  check "an exported function that makes the recheck's bash exit 0 at once does not start forge" "forge did not start" \
    "$(signing 'BASH_FUNC_set%%=() { exit 0; }')"
  printf 'exit 0\n' >"$t/bashenv-exit" && printf 'echo "hello from BASH_ENV"\n' >"$t/bashenv-chatty"
  # IN dash, WITH A FAKE forge THAT IS A dash SCRIPT: the bash one would obey
  # SHELLOPTS=noexec and BASH_ENV itself, and "forge did not start" would say
  # nothing about the recheck.
  local dash cmd_bash="$cmd"; dash="$(command -v dash 2>/dev/null)"
  if [ -n "$dash" ]; then
    printf '#!%s\n: >"%s"\n' "$dash" "$t/forge-ran" >"$t/fake-forge-dash" && chmod +x "$t/fake-forge-dash"
    cmd="$(FORGE="$t/fake-forge-dash"; print_command "--ledger" "$sc")"
    rm -f "$t/forge-ran" && env -i PATH="$PATH" SHELLOPTS=noexec BASH_ENV="$t/bashenv-exit" "$t/fake-forge-dash"
    check "(the precondition) the dash fake forge runs under SHELLOPTS=noexec and a BASH_ENV ending in exit 0" "yes" \
      "$([ -e "$t/forge-ran" ] && echo yes || echo no)"
    check "SHELLOPTS=noexec, passed on by dash, does not start forge" "forge did not start" \
      "$(signing_in "$dash" SHELLOPTS=noexec)"
    check "a BASH_ENV ending in exit 0, passed on by dash, does not start forge" "forge did not start" \
      "$(signing_in "$dash" BASH_ENV="$t/bashenv-exit")"
  else
    printf '  skip  SHELLOPTS=noexec and BASH_ENV cases: no dash on this machine to pass them on\n'
  fi
  restore_t
  # THE CONTROLS: the same environment and a clean tree - the recheck runs,
  # passes and forge starts - and an exported CDPATH, which cd consults for the
  # relative path at the script's top: CDPATH=.: printed the directory on
  # stdout, and a CDPATH naming the clean copy sent the recheck there.
  if [ -n "$dash" ]; then
    check "SHELLOPTS=noexec and a chatty BASH_ENV, passed on by dash, with a clean tree, start forge (the control)" \
      "forge started" "$(signing_in "$dash" SHELLOPTS=noexec BASH_ENV="$t/bashenv-chatty")"
  fi
  cmd="$cmd_bash"
  check "an exported CDPATH=.: does not stop it (the control)" "forge started" "$(signing CDPATH=.:)"
  # THE LINE ITSELF: a passing recheck prints exactly it on stdout, everything
  # else on stderr; a stopping one prints nothing there.
  got="$(cd "$t/sign" && env -i PATH="$PATH" HOME="$t/home" BASESCAN_API_KEY=k \
    bash script/b20/preflight-mainnet.sh --recheck "$sc" 2>/dev/null)"
  check "a passing recheck's stdout is the one line \"recheck passed <commit>\"" "recheck passed $sc" "$got"
  echo 'contract Evil {}' >"$t/sign/src/t.sol"
  got="$(cd "$t/sign" && env -i PATH="$PATH" HOME="$t/home" BASESCAN_API_KEY=k \
    bash script/b20/preflight-mainnet.sh --recheck "$sc" 2>/dev/null)"
  check "a stopping recheck's stdout is empty" "" "$got"
  restore_t
  check "an exported CDPATH naming another checkout does not send the recheck there (the control)" "forge started" \
    "$(signing CDPATH="$t/sign-copy")"
  # THE FOUNDER'S ORDINARY CHECKOUT: the build's own output at the root, and
  # the files the runbook's tools leave, all ignored. None of it may stop forge.
  mkdir -p "$t/sign/out/T.sol" "$t/sign/cache" "$t/sign/broadcast/local/DeployCurb.s.sol/31337" \
      "$t/sign/script/b20/__pycache__" "$t/sign/web/e2e/test-results" "$t/sign/web/e2e/node_modules/x" \
    && : >"$t/sign/out/T.sol/T.json" && : >"$t/sign/cache/solidity-files-cache.json" \
    && : >"$t/sign/broadcast/local/DeployCurb.s.sol/31337/run-latest.json" \
    && : >"$t/sign/script/b20/__pycache__/depth_probe.cpython-312.pyc" && : >"$t/sign/script/b20/.wallet-session.json" \
    && : >"$t/sign/web/e2e/test-results/.last-run.json" && : >"$t/sign/web/e2e/node_modules/x/index.js"
  check "root out/, cache/ and broadcast/, python's bytecode and the wallet session do not stop it (the control)" \
    "forge started" "$(signing)"
  rm -rf "$t/sign/out" "$t/sign/cache" "$t/sign/broadcast" "$t/sign/script/b20/__pycache__" \
    "$t/sign/script/b20/.wallet-session.json" "$t/sign/web"
  check "and with everything put back, forge starts again" "forge started" "$(signing)"
  # THE RESUME COMMAND, RUN, in the same scratch checkout. A record to resume
  # is CURB_DEPLOYER's, has a transaction with no receipt, and is kept at
  # deployments/base-mainnet/run.json byte for byte; HEAD is the commit
  # checked, or one after it that adds only that copy.
  local rcmd run_dir="$t/sign/broadcast/DeployCurb.s.sol/8453"
  rcmd="$(FORGE="$t/fake-forge"; print_command "--ledger" "$sc" resume)"
  check "the resume command starts with --recheck-resume, the commit, the deployer and the endpoint" \
    "[ \"\$(env -u SHELLOPTS -u BASHOPTS -u BASH_ENV -u ENV bash script/b20/preflight-mainnet.sh --recheck-resume $sc $CURB_DEPLOYER $RPC)\" \\|= \"resume recheck passed $sc\" ] && \\|" \
    "$(printf '%s\n' "$rcmd" | head -2 | sed 's/^ *//' | tr '\n' '|')"
  check "and resumes, slowly: --resume and --slow both reach forge" "1|1" \
    "$(printf '%s\n' "$rcmd" | grep -c -- '^ *--resume \\$')|$(printf '%s\n' "$rcmd" | grep -c -- '^ *--slow \\$')"
  check "the broadcast command carries --slow and no --resume" "1|0" \
    "$(print_command "--ledger" "$sc" | grep -c -- '^ *--slow \\$')|$(print_command "--ledger" "$sc" | grep -c -- '--resume')"
  resume_record() { # sender, receipts (of two transactions)[, status of the first, cache half's tx count, its endpoint]
    mkdir -p "$run_dir" "$t/sign/deployments/base-mainnet" "$t/sign/cache/DeployCurb.s.sol/8453"
    python3 -c '
import json, sys
t = [{"hash": "0x01", "transaction": {"from": sys.argv[2]}}, {"hash": "0x02", "transaction": {"from": sys.argv[2]}}]
r = [{"transactionHash": "0x0" + str(i + 1), "status": "0x1"} for i in range(int(sys.argv[3]))]
if r:
    r[0]["status"] = sys.argv[4]
json.dump({"transactions": t, "receipts": r, "pending": []}, open(sys.argv[1], "w"))
json.dump({"transactions": [{"rpc": sys.argv[7]}] * int(sys.argv[6])}, open(sys.argv[5], "w"))
' "$run_dir/run-latest.json" "$1" "$2" "${3:-0x1}" "$t/sign/cache/DeployCurb.s.sol/8453/run-latest.json" \
      "${4:-2}" "${5:-$RPC}"
    cp "$run_dir/run-latest.json" "$t/sign/deployments/base-mainnet/run.json"
  }
  resuming() { local keep="$cmd"; cmd="$rcmd"; signing "$@"; cmd="$keep"; }
  check "with no record, the resume command does not start forge" "forge did not start" "$(resuming)"
  resume_record "$CURB_DEPLOYER" 1
  check "a record of the deployer's with a transaction left, its copy kept and its cache half the command's endpoint's, starts forge (the control)" \
    "forge started" "$(resuming)"
  check "and forge is handed --resume" "1" "$(grep -cx -- '--resume' "$t/forge-argv" 2>/dev/null)"
  # THE RECORD'S OTHER HALF (records_resumable): a fork run since rewrote it.
  resume_record "$CURB_DEPLOYER" 1 0x1 2 http://127.0.0.1:8549
  check "a cache half naming another endpoint (a fork run since) stops the resume, naming both" "forge did not start 1" \
    "$(resuming) $(grep -c 'sends to http://127.0.0.1:8549, not to the resume.s endpoint' "$t/sign.log")"
  resume_record "$CURB_DEPLOYER" 1 0x1 63
  check "a cache half holding another number of transactions stops it" "forge did not start 1" \
    "$(resuming) $(grep -c 'holds 63 transactions and the record 2' "$t/sign.log")"
  resume_record "$CURB_DEPLOYER" 1 && rm -f "$t/sign/cache/DeployCurb.s.sol/8453/run-latest.json"
  check "no cache half at all stops it" "forge did not start 1" \
    "$(resuming) $(grep -c 'the record.s other half' "$t/sign.log")"
  # A TRANSACTION THAT REVERTED: receipts still short of transactions, which
  # read as something left to send.
  resume_record "$CURB_DEPLOYER" 1 0x0
  check "a record whose sent transaction reverted stops the resume, pointing to step 3" "forge did not start 1" \
    "$(resuming) $(grep -c 'REVERTED on chain .*A PARTIAL DEPLOYMENT, step 3' "$t/sign.log")"
  ( for v in $(env | grep -Eio '^(FOUNDRY|DAPP|ETH|ETHERSCAN|VERIFIER)_[A-Za-z0-9_]*') "${ALLOW_NAMES[@]}"; do unset "$v"; done
    cd "$t/sign" && BASESCAN_API_KEY=k && recheck "$sc" "$t/sign" "$t/sign" "$t/home" "$CURB_DEPLOYER" ) >"$t/sign.log" 2>&1 \
    && got=passed || got=stopped
  check "a resume recheck given no endpoint stops, saying it needs one" "stopped 1" \
    "$got $(grep -c 'needs the endpoint the resume sends to' "$t/sign.log")"
  printf ' ' >>"$t/sign/deployments/base-mainnet/run.json"
  check "a copy that is not the record as it stands stops it" "forge did not start" "$(resuming)"
  rm -f "$t/sign/deployments/base-mainnet/run.json"
  check "no copy at all stops it" "forge did not start" "$(resuming)"
  resume_record 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266 1
  check "a record from another sender (a rehearsal) stops it" "forge did not start" "$(resuming)"
  resume_record "$CURB_DEPLOYER" 2
  check "a record with nothing left to send stops it" "forge did not start" "$(resuming)"
  check "and says there is nothing to resume" "1" "$(grep -c 'there is nothing to resume' "$t/sign.log")"
  resume_record "$CURB_DEPLOYER" 1
  (cd "$t/sign" && git add -f deployments/base-mainnet/run.json \
    && git -c user.email=selftest@invalid -c user.name=selftest commit -qm record) >/dev/null 2>&1
  check "a commit after the one checked that adds only the record's copy still resumes" "forge started" "$(resuming)"
  check "the broadcast command, on that commit, does not start (the control: a record exists)" "forge did not start" \
    "$(signing)"
  (cd "$t/sign" && echo 'contract Moved {}' >src/t2.sol && git add src/t2.sol \
    && git -c user.email=selftest@invalid -c user.name=selftest commit -qm moved) >/dev/null 2>&1
  check "a commit that changes a source after the one checked stops the resume" "forge did not start" "$(resuming)"
  (cd "$t/sign" && git reset -q --hard "$sc") >/dev/null 2>&1
  rm -rf "$t/sign/broadcast" "$t/sign/deployments" "$t/sign/cache"
  check "and with the record gone, the broadcast command starts again (the control)" "forge started" "$(signing)"
  # AN ASSET ADDED AFTER LAUNCH (--asset, --recheck-asset): the label as the
  # list writes it, the records an asset run may find, and its printed
  # command, run in the same scratch checkout.
  for v in SPCXc cbBTC WETH; do
    label_ok "$v" && got=accepted || got=refused
    check "the asset label '$v' is accepted" "accepted" "$got"
  done
  for v in "" "SPCX c" 'SPCXc;id' 'SPCXc$(id)' "../x" "ABCDEFGHIJKLMNOPQ"; do
    label_ok "$v" && got=accepted || got=refused
    check "the asset label '$v' is refused" "refused" "$got"
  done
  local acmd
  CURB_REGISTRY=0x9999999999999999999999999999999999999999
  acmd="$(FORGE="$t/fake-forge"; print_asset_command "--ledger" "$sc" SPCXc)"
  check "the asset command starts with --recheck-asset, the commit and the label, and goes on only on its pass line" \
    "[ \"\$(env -u SHELLOPTS -u BASHOPTS -u BASH_ENV -u ENV bash script/b20/preflight-mainnet.sh --recheck-asset $sc SPCXc)\" \\|= \"asset recheck passed $sc SPCXc\" ] && \\|" \
    "$(printf '%s\n' "$acmd" | head -2 | sed 's/^ *//' | tr '\n' '|')"
  check "and carries the registry, the label, --broadcast, --slow and --verify, ending in the wallet option" "1|1|1|1|1|--ledger" \
    "$(grep -c '^ *CURB_REGISTRY=0x9999999999999999999999999999999999999999 \\$' <<<"$acmd")|$(grep -c '^ *CURB_ASSET_LABEL=SPCXc \\$' <<<"$acmd")|$(grep -c -- '^ *--broadcast \\$' <<<"$acmd")|$(grep -c -- '^ *--slow \\$' <<<"$acmd")|$(grep -c -- '^ *--verify \\$' <<<"$acmd")|$(tail -1 <<<"$acmd" | tr -d ' ')"
  asseting() { local keep="$cmd"; cmd="$acmd"; signing "$@"; cmd="$keep"; }
  check "with no deployment record, the asset command does not start forge" "forge did not start 1" \
    "$(asseting) $(grep -c 'deployments/base-mainnet/run.json does not exist: an asset is added' "$t/sign.log")"
  mkdir -p "$t/sign/deployments/base-mainnet" && echo '{}' >"$t/sign/deployments/base-mainnet/run.json"
  check "with the deployment's record and nothing of the asset's, it starts forge (the control)" "forge started" "$(asseting)"
  check "and forge runs DeployAssetStack, broadcasting slowly with --verify" "1|1|1|1" \
    "$(grep -cx 'script/DeployAssetStack.s.sol' "$t/forge-argv")|$(grep -cx -- '--broadcast' "$t/forge-argv")|$(grep -cx -- '--slow' "$t/forge-argv")|$(grep -cx -- '--verify' "$t/forge-argv")"
  check "an exported FOUNDRY_PROFILE stops it" "forge did not start" "$(asseting FOUNDRY_PROFILE=x)"
  check "an exported ETH_GAS_PRICE stops it" "forge did not start" "$(asseting ETH_GAS_PRICE=1gwei)"
  echo 'contract Evil {}' >"$t/sign/src/t.sol"
  check "a source changed since the preflight stops it" "forge did not start" "$(asseting)"
  restore_t
  echo '{}' >"$t/sign/deployments/base-mainnet/asset-SPCXc.json"
  check "the asset already recorded stops it, naming the record" "forge did not start 1" \
    "$(asseting) $(grep -c 'asset-SPCXc.json exists' "$t/sign.log")"
  rm -f "$t/sign/deployments/base-mainnet/asset-SPCXc.json"
  mkdir -p "$t/sign/broadcast/DeployAssetStack.s.sol/8453" \
    && echo '{"an earlier asset run":1}' >"$t/sign/broadcast/DeployAssetStack.s.sol/8453/run-latest.json"
  check "an earlier asset run's record not yet kept stops it" "forge did not start 1" \
    "$(asseting) $(grep -c 'is not kept as any deployments/base-mainnet/asset-' "$t/sign.log")"
  cp "$t/sign/broadcast/DeployAssetStack.s.sol/8453/run-latest.json" "$t/sign/deployments/base-mainnet/asset-cbBTC.json"
  check "and kept as that asset's record, it goes on (the control)" "forge started" "$(asseting)"
  check "the full run's command stops in the same checkout: a deployment is recorded (the control)" "forge did not start" \
    "$(signing)"
  rm -rf "$t/sign/broadcast" "$t/sign/deployments"
  ( for v in $(env | grep -Eio '^(FOUNDRY|DAPP|ETH|ETHERSCAN|VERIFIER)_[A-Za-z0-9_]*') "${ALLOW_NAMES[@]}"; do unset "$v"; done
    cd "$t/sign" && BASESCAN_API_KEY=k && recheck "$sc" "$t/sign" "$t/sign" "$t/home" "" "" "" ) >"$t/sign.log" 2>&1 \
    && got=passed || got=stopped
  check "an asset recheck with an empty label stops, with nothing recorded at all" "stopped 1" \
    "$got $(grep -c 'needs the asset.s label after the commit' "$t/sign.log")"
  # WHAT THE ASSET RUN READS OUT OF DeployAssetStack's LOG (sim_terms,
  # sim_safe_data), in the shape it prints.
  printf '%s\n' '== Logs ==' '  === a new quote asset, built against the live deployment ===' '  chain id         8453' \
    "  === each asset's terms: label asset decimals phantom threshold ===" \
    '  SPCXc 0xb2000000000000000000007b9fcbd005511aCBd5 8 2680000000 7270000000' '  ' \
    '  NOTHING IS ADMITTED YET. The registry'"'"'s owner sends, last of all:' \
    '     owner 0x2222222222222222222222222222222222222222' '     to    0x9999999999999999999999999999999999999999' \
    '     value 0' '     data  0x84b5408f000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' '' \
    '## Setting up 1 EVM.' >"$t/asset-sim.log"
  check "the asset run reads the one asset's terms the script printed" \
    "SPCXc 0xb2000000000000000000007b9fcbd005511aCBd5 8 2680000000 7270000000" "$(sim_terms "$t/asset-sim.log" | sed 's/^ *//')"
  check "and the Safe's call" "0x84b5408f000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
    "$(sim_safe_data "$t/asset-sim.log")"
  # DEPLOY.txt STEP 6'S BY-HAND COMMAND, RUN AS WRITTEN, with the fake forge
  # where it names base-forge and each <placeholder> filled in. STEP 6 is the
  # route when STEP 4's --verify failed, often on the network. By default
  # verify-contract first asks the explorer whether the contract is verified,
  # with a GET whose URL holds the key (apikey=...), and a failed request
  # prints that URL: the key on the screen and in any log of the session. The
  # command must skip that GET and hand forge the key in its environment.
  local step6 vcmd
  step6="$(awk '/^  STEP 6 /{f=1} /^  STEP 7 /{f=0} f' "${SELF%/script/b20/*}/DEPLOY.txt" 2>/dev/null)"
  vcmd="$(printf '%s\n' "$step6" | awk '/base-forge verify-contract/{f=1} f{print; if (!/\\$/) exit}' | sed 's/<[^>]*>/X/g')"
  mkdir -p "$t/vhome/.foundry/bin" && cp "$t/fake-forge" "$t/vhome/.foundry/bin/base-forge"
  rm -f "$t/forge-ran" "$t/forge-argv" "$t/forge-key"
  (cd "$t/sign" && env -i PATH="$PATH" HOME="$t/vhome" BASESCAN_API_KEY=selftest-secret-value bash -c "$vcmd") \
    >/dev/null 2>&1
  check "DEPLOY.txt STEP 6's command, run as written, starts forge verify-contract (the control)" "verify-contract" \
    "$(head -1 "$t/forge-argv" 2>/dev/null)"
  check "it skips the is-verified GET, whose URL carries the key" "1" \
    "$(grep -cx -- '--skip-is-verified-check' "$t/forge-argv" 2>/dev/null)"
  check "it hands forge the key as ETHERSCAN_API_KEY" "selftest-secret-value" "$(cat "$t/forge-key" 2>/dev/null)"
  check "and not on forge's command line" "0" "$(grep -c selftest-secret-value "$t/forge-argv" 2>/dev/null)"
  check "STEP 6 says not to tee the output" "1" "$(printf '%s\n' "$step6" | grep -cw tee)"
  check "and to revoke the key if a line printed holds apikey=" "1" "$(printf '%s\n' "$step6" | grep -c 'apikey=.*revoke')"
  # DEPLOY.txt STEP 0'S BY-HAND LINES, RUN AS WRITTEN: the FOUNDRY/DAPP line in
  # a shell that holds them in lower and mixed case, and the ignored-files line
  # in the scratch checkout, with an ignored source and with only what the
  # founder's ordinary checkout holds.
  local step0 line0
  step0="$(awk '/^  STEP 0 /{f=1} /^  STEP 1 /{f=0} f' "${SELF%/script/b20/*}/DEPLOY.txt" 2>/dev/null)"
  line0="$(printf '%s\n' "$step0" | grep -m1 'env | grep .*FOUNDRY|DAPP')"
  check "DEPLOY.txt STEP 0's FOUNDRY/DAPP line, run as written, prints them whatever their case" "2" \
    "$(env -i PATH="$PATH" foundry_optimizer_runs=1 Dapp_Libraries=x bash -c "$line0" 2>/dev/null | grep -c .)"
  line0="$(printf '%s\n' "$step0" | awk '/ls-files .*--others --ignored/{f=1} f{print; if (!/\\$/) exit}')"
  mkdir -p "$t/sign/src/curb/cache" "$t/sign/out" "$t/sign/script/b20/__pycache__" \
    && : >"$t/sign/src/curb/cache/QuoteCache.sol" && : >"$t/sign/out/x.json" \
    && : >"$t/sign/script/b20/__pycache__/m.cpython-313.pyc" && : >"$t/sign/script/b20/.wallet-session.json"
  check "STEP 0's ignored-files line, run as written, prints an ignored source" "src/curb/cache/QuoteCache.sol" \
    "$(cd "$t/sign" && bash -c "$line0" 2>&1)"
  # A NAME GIT WOULD QUOTE ("src/curb/cache/\303\226deme.sol", quotes and all),
  # which neither pattern of the line matched: it printed nothing.
  rm -f "$t/sign/src/curb/cache/QuoteCache.sol" && : >"$t/sign/src/curb/cache/Ödeme.sol"
  check "and prints one whose non-ASCII name git would quote" "src/curb/cache/Ödeme.sol" \
    "$(cd "$t/sign" && bash -c "$line0" 2>&1)"
  rm -rf "$t/sign/src/curb"
  check "and nothing for the build's output, python's bytecode and the wallet session (the control)" "" \
    "$(cd "$t/sign" && bash -c "$line0" 2>&1)"
  rm -rf "$t/sign/out" "$t/sign/script/b20/__pycache__" "$t/sign/script/b20/.wallet-session.json"
  has() { printf '%s\n' "$step0" | grep -q -- "$1" && echo yes || echo no; }
  check "STEP 0 lists the replace refs and turns the file watcher off" "yes|yes" \
    "$(has '^ *git replace -l ')|$(has 'git -c core.fsmonitor=false status')"
  check "STEP 0 says the ETH/ETHERSCAN/VERIFIER families are refused as a whole, some not read by forge at all" "yes|yes" \
    "$(has 'refused as a whole')|$(has 'ETH_RPC_URL')"
  # THE STATUS LINE, RUN AS WRITTEN, in a checkout with a change under
  # reference/ - where WSL's git reads the nested reference/ponsfamily as
  # modified on a Windows (CRLF) checkout, so the whole-tree line stopped every
  # correct tree - and one outside the build's paths, which it must still list.
  line0="$(printf '%s\n' "$step0" | awk '/fsmonitor=false status --porcelain --untracked-files=all/{f=1} f{print; if (!/\\$/) exit}')"
  mkdir -p "$t/whole/reference" "$t/whole/services" && (
    cd "$t/whole" && git init -q && echo a >reference/r.txt && echo a >services/s.ts && git add . \
      && git -c user.email=selftest@invalid -c user.name=selftest commit -qm init \
      && echo b >reference/r.txt && echo b >services/s.ts
  ) >/dev/null 2>&1
  check "(the precondition) plain git status lists the change under reference/" "1" \
    "$(cd "$t/whole" && git status --porcelain | grep -c '^ M reference/r\.txt$')"
  check "STEP 0's status line, run as written, lists a change outside the build's paths and none under reference/" \
    " M services/s.ts" "$(cd "$t/whole" && bash -c "$line0" 2>&1)"
  # WHAT STEERS git, BY HAND: the GIT_ line in a shell holding a work tree
  # elsewhere, a lower-case name and what an editor's terminal exports; the
  # top level and core.worktree asked.
  line0="$(printf '%s\n' "$step0" | awk '/env \| grep -Ei .\^GIT_/{f=1} f{print; if (!/\\$/) exit}')"
  check "STEP 0's GIT_ line, run as written, prints GIT_WORK_TREE and git_dir, not an editor's variables" \
    "GIT_WORK_TREE=/x|git_dir=/y|" \
    "$(env -i PATH="$PATH" GIT_WORK_TREE=/x git_dir=/y GIT_ASKPASS=/a GIT_EDITOR=vi GIT_PAGER=less bash -c "$line0" 2>/dev/null \
      | LC_ALL=C sort | tr '\n' '|')"
  check "STEP 0 asks for git's top level and for core.worktree" "yes|yes" \
    "$(has '^ *git rev-parse --show-toplevel ')|$(has '^ *git config --get core.worktree ')"
  # THE COMMIT'S FILES READ IN AN INDEX OF THEIR OWN, BY HAND: a same-size
  # edit with its mtime put back, under core.trustctime=false (set up as in
  # the signing case above), and the committed bytes as the control.
  line0="$(printf '%s\n' "$step0" | awk '/GIT_INDEX_FILE=/{f=1} f{print; if (!/\\$/) exit}')"
  restore_t && touch -t 202601010000 "$t/sign/src/t.sol" && git -C "$t/sign" status >/dev/null 2>&1 \
    && sed 's/1111/2222/g' "$t/sign/src/t.sol" >"$t/edit" && cat "$t/edit" 1<>"$t/sign/src/t.sol" \
    && touch -t 202601010000 "$t/sign/src/t.sol" && git -C "$t/sign" config core.trustctime false
  check "(the precondition) plain git status misses that edit" "" "$(cd "$t/sign" && git status --porcelain 2>&1)"
  check "STEP 0's GIT_INDEX_FILE line, run as written, prints the edit git status misses" " M src/t.sol" \
    "$(cd "$t/sign" && bash -c "$line0" 2>&1)"
  git -C "$t/sign" config --unset core.trustctime && restore_t
  check "and nothing for the commit's own bytes (the control)" "" "$(cd "$t/sign" && bash -c "$line0" 2>&1)"
  # A FILE git WOULD FILTER, BY HAND: the check-attr line.
  line0="$(printf '%s\n' "$step0" | awk '/git ls-files -- src lib/{f=1} f{print; if (!/\\$/) exit}')"
  echo 'src/t.sol filter=keep' >"$t/sign/.git/info/attributes"
  check "STEP 0's check-attr line, run as written, prints a file a filter would rewrite" "src/t.sol: filter: keep" \
    "$(cd "$t/sign" && bash -c "$line0" 2>&1)"
  rm -f "$t/sign/.git/info/attributes"
  check "and nothing when no attribute rewrites a file (the control)" "" "$(cd "$t/sign" && bash -c "$line0" 2>&1)"
  # THE STARTING DIRECTORY, asked of recheck directly: the printed command's
  # relative path cannot even be found from elsewhere. The same call from the
  # root is the control. Whatever this shell holds that the recheck refuses is
  # unset first - the families in any case, and the opt-ins.
  local v
  for v in $(env | grep -Eio '^(FOUNDRY|DAPP|ETH|ETHERSCAN|VERIFIER)_[A-Za-z0-9_]*') "${ALLOW_NAMES[@]}"; do unset "$v"; done
  ( cd "$t/sign" && BASESCAN_API_KEY=k && recheck "$sc" "$t/sign" "$t/sign" "$t/home" ) >/dev/null 2>&1 \
    && got=passed || got=stopped
  check "recheck from the repository root passes (the control)" "passed" "$got"
  ( cd "$t/sign" && BASESCAN_API_KEY=k && recheck "$sc" "$t/sign" "$t/sign/src" "$t/home" ) >/dev/null 2>&1 \
    && got=passed || got=stopped
  check "a command started outside the repository root is stopped" "stopped" "$got"

  # THE MAIN RUN ASKS FOR THE KEY AND THE WALLET OPTION BEFORE SECTION 1, run
  # for real in the same scratch checkout: a python3 that runs, the suites
  # skipped, and a cast that cannot reach the chain, so a run that gets past
  # the early checks stops at section 3 having read nothing. The run with
  # everything given is the control: it must reach section 1.
  mkdir -p "$t/py-ok" && printf '#!/usr/bin/env bash\nexit 0\n' >"$t/py-ok/python3" \
    && printf '#!/usr/bin/env bash\nexit 1\n' >"$t/cast-none" && chmod +x "$t/py-ok/python3" "$t/cast-none"
  printf '#!/usr/bin/env bash\n[ "$1 $2" = "wallet address" ] && { echo 0x3333333333333333333333333333333333333333; exit 0; }\nexit 1\n' \
    >"$t/cast-signer" && chmod +x "$t/cast-signer"
  mainrun() { # env assignments; prints what the early checks and section 1 said
    (cd "$t/sign" && env -i PATH="$t/py-ok:$PATH" HOME="$t/home" CURB_SKIP_TESTS=1 \
      CAST_BIN="$t/cast-signer" FORGE_BIN="$t/fake-forge" CURB_FIRST_LAUNCH=0 \
      CURB_PLATFORM_RECIPIENT=0x1111111111111111111111111111111111111111 \
      CURB_POLICY_OWNER=0x2222222222222222222222222222222222222222 \
      CURB_DEPLOYER=0x3333333333333333333333333333333333333333 \
      CURB_SHARING_PUBLISHER=0x4444444444444444444444444444444444444444 \
      CURB_SHARING_KEEPER_PAYEE=0x5555555555555555555555555555555555555555 \
      CURB_SHARING_VETOERS=0x6666666666666666666666666666666666666666 \
      ${key[@]+"${key[@]}"} "$@" bash script/b20/preflight-mainnet.sh) >"$t/main.log" 2>&1
    printf 'section 1 %s, key refused %s, wallet refused %s' \
      "$(grep -c '^1\. THE COMMIT YOU WOULD BE DEPLOYING' "$t/main.log")" \
      "$(grep -c 'BASESCAN_API_KEY is not set, or holds whitespace' "$t/main.log")" \
      "$(grep -c 'CURB_WALLET_OPTION matches none of the allowed forms' "$t/main.log")"
  }
  check "the main run with a key and a good wallet option reaches section 1 (the control)" \
    "section 1 1, key refused 0, wallet refused 0" "$(mainrun CURB_WALLET_OPTION="--ledger --mnemonic-indexes 1")"
  check "a main run that took the key and went on never prints its value" "0" \
    "$(grep -c selftest-secret-value "$t/main.log")"
  check "and it gets past section 1, to the chain (the control)" "1" \
    "$(grep -c '^3\. WHAT LIVE BASE' "$t/main.log")"
  check "and through the size and code gate on its way (the control)" "1" \
    "$(grep -c 'ok    the size and code gate passed' "$t/main.log")"
  # THE HOLDER SHARING ROLES, each refused where the run starts.
  mainrun CURB_WALLET_OPTION=--ledger CURB_SHARING_PUBLISHER= >/dev/null
  check "the main run with no sharing publisher stops before section 1, naming it" "named 1, section 1 0" \
    "named $(grep -c 'CURB_SHARING_PUBLISHER is not set' "$t/main.log"), section 1 $(grep -c '^1\. THE COMMIT' "$t/main.log")"
  mainrun CURB_WALLET_OPTION=--ledger CURB_SHARING_KEEPER_PAYEE=0x55 >/dev/null
  check "the main run with a keeper payee that is not an address stops before section 1" "named 1, section 1 0" \
    "named $(grep -c 'CURB_SHARING_KEEPER_PAYEE is not an address' "$t/main.log"), section 1 $(grep -c '^1\. THE COMMIT' "$t/main.log")"
  mainrun CURB_WALLET_OPTION=--ledger "CURB_SHARING_VETOERS=0x6666666666666666666666666666666666666666, 0x7777777777777777777777777777777777777777" >/dev/null
  check "the main run with a vetoer list holding a space stops before section 1" "named 1, section 1 0" \
    "named $(grep -c 'CURB_SHARING_VETOERS is not set, or is not' "$t/main.log"), section 1 $(grep -c '^1\. THE COMMIT' "$t/main.log")"
  mainrun CURB_WALLET_OPTION=--ledger CURB_SHARING_VETOERS=0x4444444444444444444444444444444444444444 >/dev/null
  check "the main run with the publisher as a vetoer stops before section 1, saying why" "named 1, section 1 0" \
    "named $(grep -c 'is the sharing publisher' "$t/main.log"), section 1 $(grep -c '^1\. THE COMMIT' "$t/main.log")"
  # A RECIPIENT WITH ONE LETTER'S CASE MISTYPED, with the real python3 (the
  # stand-in answers every question yes): stopped before section 1, naming
  # the checksum. The same address checksummed is the control.
  mainrun CURB_WALLET_OPTION=--ledger PATH="$PATH" CURB_PLATFORM_RECIPIENT=0x52483b53c8c08Ece00932A65DaE70487dcCD21E0 >/dev/null
  check "the main run with a recipient whose EIP-55 checksum is wrong stops before section 1, naming it" "named 1, section 1 0" \
    "named $(grep -c 'CURB_PLATFORM_RECIPIENT is not an address, or it is written in mixed case and that is not its EIP-55 checksum' "$t/main.log"), section 1 $(grep -c '^1\. THE COMMIT' "$t/main.log")"
  mainrun CURB_WALLET_OPTION=--ledger PATH="$PATH" CURB_PLATFORM_RECIPIENT=0x52483b53c8C08Ece00932A65DaE70487dcCD21E0 >/dev/null
  check "and the same recipient checksummed reaches section 1 (the control)" "1" \
    "$(grep -c '^1\. THE COMMIT YOU WOULD BE DEPLOYING' "$t/main.log")"
  # THE SIZE AND CODE GATE: a gate that fails stops section 2, before the chain.
  echo 1 >"$t/gate-rc"
  mainrun CURB_WALLET_OPTION=--ledger >/dev/null
  check "a size and code gate that fails stops the main run before the chain, naming it" "named 1, section 3 0" \
    "named $(grep -c 'the size and code gate did not pass' "$t/main.log"), section 3 $(grep -c '^3\. WHAT LIVE BASE' "$t/main.log")"
  rm -f "$t/gate-rc"
  mainrun CURB_WALLET_OPTION=--ledger ETH_GAS_PRICE=1gwei >/dev/null
  check "the main run with a gas price exported stops in section 1, naming it" "named 1, section 3 0" \
    "named $(grep -c 'environment variable ETH_GAS_PRICE' "$t/main.log"), section 3 $(grep -c '^3\. WHAT LIVE BASE' "$t/main.log")"
  # SECTION 1'S OWN ANSWERS TO THIS ROUND'S GAPS, each named where it stops.
  mainrun CURB_WALLET_OPTION=--ledger ETH_FROM=0x1111111111111111111111111111111111111111 >/dev/null
  check "the main run with ETH_FROM exported stops in section 1, saying the family is refused, not that forge reads it" \
    "named 1, as a whole 1, would read 0, section 3 0" \
    "named $(grep -c 'environment variable ETH_FROM' "$t/main.log"), as a whole $(grep -c 'refused as a whole' "$t/main.log"), would read $(grep -c 'would read the settings above' "$t/main.log"), section 3 $(grep -c '^3\. WHAT LIVE BASE' "$t/main.log")"
  mainrun CURB_WALLET_OPTION=--ledger foundry_optimizer_runs=1 >/dev/null
  check "the main run with foundry_optimizer_runs exported, in lower case, stops in section 1, naming it" \
    "named 1, section 3 0" \
    "named $(grep -c 'environment variable foundry_optimizer_runs' "$t/main.log"), section 3 $(grep -c '^3\. WHAT LIVE BASE' "$t/main.log")"
  mainrun CURB_WALLET_OPTION=--ledger 'CURB_ALLOW_EOA_RECIPIENT=false;' >/dev/null
  check "the main run with an opt-in ending in ; stops in section 1, naming it shell-quoted" "named 1, section 3 0" \
    "named $(grep -cF 'CURB_ALLOW_EOA_RECIPIENT=false\;' "$t/main.log"), section 3 $(grep -c '^3\. WHAT LIVE BASE' "$t/main.log")"
  mainrun CURB_WALLET_OPTION=--ledger CURB_ALLOW_EOA_RECIPIENT=true CURB_ALLOW_NON_SAFE_RECIPIENT=false \
    CURB_ALLOW_EOA_POLICY_OWNER=true CURB_ALLOW_NON_SAFE_POLICY_OWNER=false CURB_ALLOW_SAME_RECIPIENT_AND_OWNER=true >/dev/null
  check "the main run with every opt-in true or false gets past section 1 (the control)" "1" \
    "$(grep -c '^3\. WHAT LIVE BASE' "$t/main.log")"
  # AN OPT-IN OF 1 IS REFUSED, AND FOR THE TRUE REASON: forge reads 1 (and TRUE)
  # as true. The refusal used to say forge reads any other value as false.
  mainrun CURB_WALLET_OPTION=--ledger CURB_ALLOW_EOA_RECIPIENT=1 >/dev/null
  check "the main run with an opt-in of 1 stops in section 1, saying forge reads such spellings as true" \
    "named 1, read as true 1, any other value false 0, section 3 0" \
    "named $(grep -c '^ *CURB_ALLOW_EOA_RECIPIENT=1$' "$t/main.log"), read as true $(grep -c 'some other spellings as true (TRUE, 1)' "$t/main.log"), any other value false $(grep -c 'any other value as false' "$t/main.log"), section 3 $(grep -c '^3\. WHAT LIVE BASE' "$t/main.log")"
  # SECTION 1'S OK LINE, WITH ETHERSCAN_API_KEY EXPORTED: it passes, and the
  # line says why, rather than that no ETHERSCAN_* variable is exported.
  mainrun CURB_WALLET_OPTION=--ledger ETHERSCAN_API_KEY=selftest-other-key >/dev/null
  check "with ETHERSCAN_API_KEY exported, section 1 passes and its ok line names that one exception" \
    "ok 1, aside 1, section 3 1" \
    "ok $(grep -c '^  ok    clean tree at' "$t/main.log"), aside $(grep -c 'ETHERSCAN_API_KEY aside' "$t/main.log"), section 3 $(grep -c '^3\. WHAT LIVE BASE' "$t/main.log")"
  mkdir -p "$t/sign/src/curb/cache" && : >"$t/sign/src/curb/cache/QuoteCache.sol"
  mainrun CURB_WALLET_OPTION=--ledger >/dev/null
  check "the main run with an ignored source stops in section 1, naming it" "named 1, section 3 0" \
    "named $(grep -c 'src/curb/cache/QuoteCache.sol  <- ignored by git' "$t/main.log"), section 3 $(grep -c '^3\. WHAT LIVE BASE' "$t/main.log")"
  rm -rf "$t/sign/src/curb"
  # A REFUSED WALLET OPTION IS THE ONE THAT MAY BE A SECRET, so it is refused
  # without being repeated: a private key, and a seed phrase.
  for ov in "--private-key 0xselftestwalletsecret" "selftestwalletsecret seed phrase words"; do
    check "the main run with a secret for a wallet option stops before section 1" \
      "section 1 0, key refused 0, wallet refused 1" "$(mainrun CURB_WALLET_OPTION="$ov")"
    check "and never prints the refused value" "0" "$(grep -c selftestwalletsecret "$t/main.log")"
  done
  # THE FIRST LAUNCH, THE TOOLS AND THE SIGNER, each refused where the run starts.
  mainrun CURB_WALLET_OPTION=--ledger CURB_FIRST_LAUNCH= >/dev/null
  check "the main run with CURB_FIRST_LAUNCH set to nothing stops before section 1, naming it" "named 1, section 1 0" \
    "named $(grep -c 'CURB_FIRST_LAUNCH must be exactly 1 or 0' "$t/main.log"), section 1 $(grep -c '^1\. THE COMMIT' "$t/main.log")"
  mainrun CURB_WALLET_OPTION=--ledger CURB_FIRST_LAUNCH=1 CURB_FIRST_NAME=Curb CURB_FIRST_SYMBOL=CURB CURB_FIRST_URI= \
    CURB_FIRST_TAX_BPS=300 CURB_FIRST_CREATOR=0x3333333333333333333333333333333333333333 CURB_FIRST_DEV_BUY=0 \
    CURB_FIRST_SHARE=1 >/dev/null
  check "the main run with the deployer as \$CURB's creator stops before section 1, naming it" "named 1, section 1 0" \
    "named $(grep -c 'CURB_FIRST_CREATOR is the deployer' "$t/main.log"), section 1 $(grep -c '^1\. THE COMMIT' "$t/main.log")"
  mainrun CURB_WALLET_OPTION=--ledger CURB_FIRST_LAUNCH=1 CURB_FIRST_NAME=Curb CURB_FIRST_SYMBOL=CURB CURB_FIRST_URI= \
    CURB_FIRST_TAX_BPS=300 CURB_FIRST_CREATOR=0x8888888888888888888888888888888888888888 CURB_FIRST_DEV_BUY=0 \
    CURB_FIRST_SHARE=1 >/dev/null
  check "the main run with a whole first launch reaches the chain (the control)" "1" "$(grep -c '^3\. WHAT LIVE BASE' "$t/main.log")"
  # THE DEV BUY IS ASKED OF THE DEPLOYER'S BALANCE IN SECTION 4, BEFORE THE
  # SIMULATION SPENDS IT. forge funds only its own default sender; run as
  # --sender CURB_DEPLOYER, the simulation wraps $CURB's dev buy out of the
  # deployer's real balance, and a deployer short of it reverted OutOfFunds in
  # section 5 - having priced nothing and named no amount to send. A cast that
  # answers the chain's reads takes these runs past section 3; the fake forge
  # then stops section 5, which is how the controls show they got there.
  cat >"$t/cast-chain" <<CAST && chmod +x "$t/cast-chain"
#!/usr/bin/env bash
case "\$1 \$2" in
  "wallet address") echo 0x3333333333333333333333333333333333333333 ;;
  "code "*) echo 0x ;;
  "balance 0x3333333333333333333333333333333333333333") cat "$t/deployer-wei" ;;
  "balance "*) echo 0 ;;
  *) exit 1 ;;
esac
CAST
  # (THIS cast ANSWERS EVERY ADDRESS WITH NO CODE, so the creator is one key,
  # and said to be: CURB_ALLOW_EOA_CREATOR=true. Without it, section 3 stops.)
  local firstl=(CAST_BIN="$t/cast-chain" CURB_WALLET_OPTION=--ledger CURB_FIRST_LAUNCH=1 CURB_FIRST_NAME=Curb
    CURB_FIRST_SYMBOL=CURB CURB_FIRST_URI= CURB_FIRST_TAX_BPS=300 CURB_FIRST_CREATOR=0x8888888888888888888888888888888888888888
    CURB_FIRST_DEV_BUY=7 CURB_FIRST_SHARE=1 CURB_ALLOW_EOA_CREATOR=true)
  echo 7 >"$t/deployer-wei"
  mainrun "${firstl[@]}" CURB_ALLOW_EOA_CREATOR=false >/dev/null
  check "a \$CURB creator that is one key, not said to be, stops in section 3, naming the opt-in" "named 1, section 4 0" \
    "named $(grep -c 'CURB_FIRST_CREATOR is one key .*set CURB_ALLOW_EOA_CREATOR=true' "$t/main.log"), section 4 $(grep -c '^4\. WHAT THE DEPLOYER HOLDS' "$t/main.log")"
  mainrun "${firstl[@]}" >/dev/null
  check "and said to be, it goes on to section 4 (the control)" "section 4 1" \
    "section 4 $(grep -c '^4\. WHAT THE DEPLOYER HOLDS' "$t/main.log")"
  echo 6 >"$t/deployer-wei"
  mainrun "${firstl[@]}" >/dev/null
  check "a deployer holding less than \$CURB's dev buy stops in section 4, naming both, before the simulation" \
    "named 1, section 5 0" \
    "named $(grep -c 'the deployer holds 6 wei, less than .CURB.s dev buy of 7 wei' "$t/main.log"), section 5 $(grep -c '^5\. THE WHOLE DEPLOYMENT' "$t/main.log")"
  echo 7 >"$t/deployer-wei"
  mainrun "${firstl[@]}" >/dev/null
  check "a deployer holding exactly the dev buy goes on to the simulation (the control)" "named 0, section 5 1" \
    "named $(grep -c 'less than .CURB.s dev buy' "$t/main.log"), section 5 $(grep -c '^5\. THE WHOLE DEPLOYMENT' "$t/main.log")"
  echo 0 >"$t/deployer-wei"
  mainrun "${firstl[@]}" CURB_FIRST_DEV_BUY=0 >/dev/null
  check "with no dev buy, a deployer holding nothing goes on to the simulation, told section 7 names the amount" \
    "cost in 7 1, amount in 7 1, section 5 1" \
    "cost in 7 $(grep -c 'checked against the simulated cost in section 7$' "$t/main.log"), amount in 7 $(grep -c 'holds NOTHING. Section 7 will say how much it needs' "$t/main.log"), section 5 $(grep -c '^5\. THE WHOLE DEPLOYMENT' "$t/main.log")"
  mainrun "${firstl[@]}" CURB_FIRST_LAUNCH=0 >/dev/null
  check "with no first launch, a dev buy left in the shell asks the deployer for nothing (the control)" "section 5 1" \
    "section 5 $(grep -c '^5\. THE WHOLE DEPLOYMENT' "$t/main.log")"
  mainrun CURB_WALLET_OPTION=--ledger FORGE_BIN="$t/no-such-forge" >/dev/null
  check "the main run with no base-forge where it looks stops before section 1, saying to run in WSL" "named 1, section 1 0" \
    "named $(grep -c 'Run the preflight in WSL' "$t/main.log"), section 1 $(grep -c '^1\. THE COMMIT' "$t/main.log")"
  mainrun CURB_WALLET_OPTION=--ledger CURB_DEPLOYER=0x4444444444444444444444444444444444444444 >/dev/null
  check "the main run whose device signs as another address stops before section 1, naming both" "named 1, section 1 0" \
    "named $(grep -c 'signs as 0x3333333333333333333333333333333333333333, not as CURB_DEPLOYER' "$t/main.log"), section 1 $(grep -c '^1\. THE COMMIT' "$t/main.log")"
  mainrun CURB_WALLET_OPTION="--account deployer" >/dev/null
  check "the main run with a keystore is not asked for its password, and goes on" "noted 1, section 1 1" \
    "noted $(grep -c 'the signer is NOT asked here' "$t/main.log"), section 1 $(grep -c '^1\. THE COMMIT' "$t/main.log")"
  key=()
  check "the main run without an explorer key stops before section 1" \
    "section 1 0, key refused 1, wallet refused 0" "$(mainrun)"
  key=(BASESCAN_API_KEY=selftest-secret-value)
  check "the main run with a malformed wallet option stops before section 1" \
    "section 1 0, key refused 0, wallet refused 1" "$(mainrun CURB_WALLET_OPTION="--ledger --mnemonic-indexes 1,2")"
  # THE ASSET RUN (--asset), run for real in the same checkout as far as the
  # fake forge lets it: section 1 asked, and the simulation that does not
  # complete stops it there. A label that is not one stops it before anything.
  assetrun() { # label, env assignments; prints what it reached
    local label="$1"; shift
    (cd "$t/sign" && env -i PATH="$t/py-ok:$PATH" HOME="$t/home" CAST_BIN="$t/cast-signer" FORGE_BIN="$t/fake-forge" \
      CURB_DEPLOYER=0x3333333333333333333333333333333333333333 CURB_REGISTRY=0x9999999999999999999999999999999999999999 \
      CURB_WALLET_OPTION=--ledger ${key[@]+"${key[@]}"} "$@" bash script/b20/preflight-mainnet.sh --asset "$label") >"$t/asset.log" 2>&1
    printf 'section 1 %s, simulation stopped %s' "$(grep -c '^1\. THE COMMIT YOU WOULD BE DEPLOYING FROM' "$t/asset.log")" \
      "$(grep -c 'the simulation did not complete' "$t/asset.log")"
  }
  mkdir -p "$t/sign/deployments/base-mainnet" && echo '{}' >"$t/sign/deployments/base-mainnet/run.json"
  check "the asset run asks section 1, then simulates DeployAssetStack, and a simulation that does not complete stops it (the control)" \
    "section 1 1, simulation stopped 1" "$(assetrun SPCXc)"
  check "and it simulated DeployAssetStack, for that label and registry" "1|1" \
    "$(grep -cx 'script/DeployAssetStack.s.sol' "$t/forge-argv")|$(grep -c 'ok    clean tree at .*nothing of SPCXc' "$t/asset.log")"
  check "an asset run with a label that is not one stops before section 1" "section 1 0, simulation stopped 0" \
    "$(assetrun 'SPCXc;id')"
  check "an asset run with a registry whose checksum is wrong stops before section 1, naming it" "section 1 0, simulation stopped 0 1" \
    "$(assetrun SPCXc PATH="$PATH" CURB_REGISTRY=0x52483b53c8c08Ece00932A65DaE70487dcCD21E0) $(grep -c 'CURB_REGISTRY is not an address, or' "$t/asset.log")"
  check "an asset run with a FOUNDRY_* setting exported stops in section 1" "section 1 1, simulation stopped 0" \
    "$(assetrun SPCXc FOUNDRY_PROFILE=x)"
  rm -rf "$t/sign/deployments"
  check "an asset run without the deployment's record stops in section 1" "section 1 1, simulation stopped 0" \
    "$(assetrun SPCXc)"

  # THE SIMULATION'S OWN SHAPE: an EOA recipient's warning, a Safe owner's
  # owners, an empty console.log line, then forge's next heading.
  printf '%s\n' \
    'Script ran successfully.' \
    '== Logs ==' \
    '  WARNING: the platform recipient is one key (no code, or only an EIP-7702 delegation), not a multisig: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' \
    '  policy owner is a Safe-shaped contract: 0x4444444444444444444444444444444444444444' \
    '     threshold 2 of 3' \
    '     owner 0x5555555555555555555555555555555555555555' \
    '  ' \
    '  === CURB ===' \
    '' \
    '## Setting up 1 EVM.' \
    'Estimated amount required: 0.0011 ETH' >"$t/sim.log"
  got="$(sim_logs "$t/sim.log" | grep -c '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')"
  check "the recipient's address reaches the output" "1" "$got"
  got="$(sim_logs "$t/sim.log" | grep -c 'threshold 2 of 3\|owner 0x5555')"
  check "a Safe's threshold and owners reach the output" "2" "$got"
  got="$(sim_logs "$t/sim.log" | grep -c '=== CURB ===')"
  check "the section runs past an empty console.log line" "1" "$got"
  got="$(sim_logs "$t/sim.log" | grep -c 'Setting up')"
  check "the section stops at forge's next heading" "0" "$got"

  # THE REAL git, ON A SCRATCH REPOSITORY: the quoting happens in git, so only
  # git can show that tree_status asks for the unquoted form.
  mkdir -p "$t/git/src" && (
    cd "$t/git" && git init -q && : >src/t.sol && git add . \
      && git -c user.email=selftest@invalid -c user.name=selftest commit -qm init \
      && : >"src/a b.sol" && : >notes.md
  ) >/dev/null 2>&1
  got="$(cd "$t/git" && tree_status | dirty_entries)"
  check "git's own status of an untracked 'src/a b.sol' reaches the gate unquoted" "?? src/a b.sol" "$got"
  # AND GIT'S OWN SETTINGS, each of which once hid from the gate what it is
  # there to see. Each mark is undone before the next.
  git -C "$t/git" config status.showUntrackedFiles no
  got="$(cd "$t/git" && tree_status | dirty_entries)"
  check "status.showUntrackedFiles=no does not hide an untracked source" "?? src/a b.sol" "$got"
  git -C "$t/git" config --unset status.showUntrackedFiles
  rm -f "$t/git/src/a b.sol" "$t/git/notes.md"
  (cd "$t/git" && git update-index --assume-unchanged src/t.sol && echo edited >src/t.sol) >/dev/null 2>&1
  got="$(cd "$t/git" && tree_status | dirty_entries | grep -c '^h src/t\.sol ')"
  check "an edited source marked assume-unchanged still makes the tree dirty" "1" "$got"
  (cd "$t/git" && git update-index --no-assume-unchanged src/t.sol && git checkout -q -- src/t.sol \
    && git update-index --skip-worktree src/t.sol && echo edited >src/t.sol) >/dev/null 2>&1
  got="$(cd "$t/git" && tree_status | dirty_entries | grep -c '^S src/t\.sol ')"
  check "an edited source marked skip-worktree still makes the tree dirty" "1" "$got"
  (cd "$t/git" && git update-index --no-skip-worktree src/t.sol && git checkout -q -- src/t.sol) >/dev/null 2>&1
  # A MARK ON A FILE THAT WAS NOT EDITED IS STILL LISTED - git does not compare
  # it, so nothing here knows - and the note says so, and how to clear it.
  (cd "$t/git" && git update-index --assume-unchanged src/t.sol) >/dev/null 2>&1
  got="$(cd "$t/git" && tree_status | dirty_entries)"
  check "an unedited file marked assume-unchanged is listed, its note saying why and how to clear the mark" \
    "listed 1, why 1, how 1" \
    "listed $(printf '%s\n' "$got" | grep -c '^h src/t\.sol '), why $(printf '%s\n' "$got" | grep -c 'listed whether or not it was edited'), how $(printf '%s\n' "$got" | grep -c 'no-assume-unchanged.*clears the mark')"
  (cd "$t/git" && git update-index --no-assume-unchanged src/t.sol) >/dev/null 2>&1
  got="$(cd "$t/git" && tree_status | dirty_entries)"
  check "with every mark undone the tree reads as clean (the control)" "" "$got"
  # A REPLACED COMMIT, asked of tree_status directly, so that each of its two
  # answers is seen on its own: the status against the commit's own files,
  # and the listing of the replacement.
  mkdir -p "$t/rep/src" && (
    cd "$t/rep" && git init -q && echo 'contract Reviewed {}' >src/t.sol && git add . \
      && git -c user.email=selftest@invalid -c user.name=selftest commit -qm reviewed \
      && git checkout -q -b other && echo 'contract Other {}' >src/t.sol \
      && git -c user.email=selftest@invalid -c user.name=selftest commit -qam other \
      && git checkout -q - && git replace "$(git rev-parse HEAD)" other && git reset -q --hard HEAD
  ) >/dev/null 2>&1
  check "(the precondition) the replacement's files are out and plain git status is clean" "contract Other {}|" \
    "$(cat "$t/rep/src/t.sol")|$(cd "$t/rep" && git status --porcelain)"
  got="$(cd "$t/rep" && tree_status | dirty_entries)"
  check "the gate compares the commit's own files, not its replacement's" "1" \
    "$(printf '%s\n' "$got" | grep -c '^M  src/t\.sol$')"
  check "and lists the replacement itself" "1" "$(printf '%s\n' "$got" | grep -c '^replaced [0-9a-f]\{40\}  <- git replace')"
  # WHAT THE SHELL EXPORTS FOR git (git_env_bad): refused whatever its case,
  # except what an editor or a terminal exports.
  got="$(env -i PATH="$PATH" GIT_DIR=/x git_work_tree=/y GIT_CONFIG_COUNT=1 GIT_ASKPASS=/a GIT_EDITOR=vi \
    GIT_SEQUENCE_EDITOR=vi GIT_PAGER=less GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND=ssh GIT_AUTHOR_NAME=a \
    GIT_COMMITTER_EMAIL=b bash -c "$(declare -f git_env_bad); git_env_bad" | tr '\n' '|')"
  check "GIT_* variables are reported whatever their case, except an editor's, a terminal's and an author's" \
    "environment variable GIT_CONFIG_COUNT|environment variable GIT_DIR|environment variable git_work_tree|" "$got"
  # THE GATE'S git READS THE CHECKOUT IT RUNS IN (gate_git), asked of
  # tree_status with a clean copy exported as GIT_DIR and GIT_WORK_TREE.
  mkdir -p "$t/steer/src" && (
    cd "$t/steer" && git init -q && printf 'contract A {}\n' >src/A.sol && git add . \
      && git -c user.email=selftest@invalid -c user.name=selftest commit -qm a
  ) >/dev/null 2>&1
  cp -a "$t/steer" "$t/steer-copy" && printf 'contract B {}\n' >"$t/steer/src/A.sol"
  got="$(cd "$t/steer" && export GIT_DIR="$t/steer-copy/.git" GIT_WORK_TREE="$t/steer-copy" \
    && tree_status | dirty_entries | grep -c '^ M src/A\.sol$')"
  check "the gate's git reads the checkout it runs in, whatever GIT_DIR and GIT_WORK_TREE the shell exports" "1" "$got"
  # WHICH CHECKOUT git READS (git_root_problem), asked of a directory below the
  # top of its repository; the top itself is the control.
  mkdir -p "$t/steer/sub"
  got="$(cd "$t/steer/sub" && git_root_problem "$t/steer/sub")"
  check "a directory below the top of its repository is not taken for the root" "1" \
    "$(printf '%s\n' "$got" | grep -c "git's work tree is .*/steer, not .*/steer/sub, where forge builds")"
  check "the top of the repository, with no core.worktree, is the root (the control)" "" \
    "$(cd "$t/steer" && git_root_problem "$t/steer")"
  # A CRLF CHECKOUT OF LF BLOBS, as Windows git wrote the founder's lib/: git
  # add then stores the same blob, and the index the CRLF file's stat data.
  (cd "$t/steer" && printf 'contract A {}\n' >src/A.sol && printf '* text=auto eol=lf\n' >.gitattributes \
    && git add . && git -c user.email=selftest@invalid -c user.name=selftest commit -qm lf \
    && printf 'contract A {}\r\n' >src/A.sol && git add src/A.sol) >/dev/null 2>&1
  check "(the precondition) the file holds CRLF, and git status and the index read as the commit" "1|" \
    "$(grep -c $'\r' "$t/steer/src/A.sol")|$(cd "$t/steer" && git status --porcelain && git diff --cached --name-only HEAD)"
  check "a CRLF checkout of LF blobs reads as the commit, as git status reads it (the control)" "" \
    "$(cd "$t/steer" && tree_status | dirty_entries)"
  # AN ATTRIBUTE THAT REWRITES CONTENT: the file is listed, not hashed.
  echo 'src/A.sol ident' >"$t/steer/.git/info/attributes"
  check "a file with the ident attribute is listed as converted, the attribute named" "1" \
    "$(cd "$t/steer" && tree_status | dirty_entries | grep -c '^converted src/A\.sol  <- .*(ident: set)')"
  rm -f "$t/steer/.git/info/attributes"
  # A DELETED FILE: git status says so, and the comparison, which cannot read
  # it, says so too without failing the gate's git.
  rm -f "$t/steer/src/A.sol"
  got="$(cd "$t/steer" && tree_status | dirty_entries)" && rc=0 || rc=1
  check "a deleted tracked file is listed as deleted and as unread, and the gate still answers" "deleted 1, unread 1, status 0" \
    "deleted $(printf '%s\n' "$got" | grep -c '^ D src/A\.sol$'), unread $(printf '%s\n' "$got" | grep -c '^unread  <- git could not hash'), status $rc"
  mkdir -p "$t/subsrc" && (
    cd "$t/subsrc" && git init -q && git -c user.email=selftest@invalid -c user.name=selftest commit -q --allow-empty -m one
  ) >/dev/null 2>&1
  (cd "$t/git" && git -c protocol.file.allow=always submodule add -q "$t/subsrc" lib/sub \
    && git -c user.email=selftest@invalid -c user.name=selftest commit -qm sub \
    && git config submodule.lib/sub.ignore all \
    && git -C lib/sub -c user.email=selftest@invalid -c user.name=selftest commit -q --allow-empty -m two) >/dev/null 2>&1
  got="$(cd "$t/git" && tree_status | dirty_entries)"
  check "a submodule moved to another commit makes the tree dirty, even one set to be ignored" " M lib/sub" "$got"

  # A CAST THAT CANNOT REACH THE CHAIN, and one that can.
  printf '#!/usr/bin/env bash\nexit 1\n' >"$t/cast-down"
  printf '#!/usr/bin/env bash\ncase "$1" in code) echo 0x;; balance) echo 5;; esac\n' >"$t/cast-eoa"
  printf '#!/usr/bin/env bash\ncase "$1" in code) echo;; balance) echo 5;; esac\n' >"$t/cast-empty"
  chmod +x "$t/cast-down" "$t/cast-eoa" "$t/cast-empty"
  got="$( (CAST="$t/cast-down"; read_address "policy owner" 0x2222222222222222222222222222222222222222) 2>&1 )" \
    && got="passed: $got" || true
  case "$got" in
    passed:*|*"ONE KEY"*) got="printed an answer" ;;
    *"could not read the code"*) got="stopped" ;;
  esac
  check "an unreachable endpoint stops the preflight instead of printing ONE KEY" "stopped" "$got"
  got="$( (CAST="$t/cast-empty"; read_address "policy owner" 0x2222222222222222222222222222222222222222) 2>&1 )" \
    && got="passed" || got="stopped"
  check "an empty code answer stops the preflight" "stopped" "$got"
  got="$( (CAST="$t/cast-eoa"; read_address "policy owner" 0x2222222222222222222222222222222222222222) 2>&1 | tail -1 | sed 's/^ *//')"
  check "a real answer is printed" "ONE KEY (no code), balance 5 wei" "$got"

  mkdir -p "$t/rec/broadcast/DeployCurb.s.sol/8453"
  ( records_clear "$t/rec" ) >/dev/null 2>&1 && got=passed || got=stopped
  check "an empty 8453 broadcast directory passes" "passed" "$got"
  : >"$t/rec/broadcast/DeployCurb.s.sol/8453/run-1700000000.json"
  ( records_clear "$t/rec" ) >/dev/null 2>&1 && got=passed || got=stopped
  check "a timestamped run file alone still stops it, not only run-latest.json" "stopped" "$got"
  got="$( (records_clear "$t/rec") 2>&1 | grep -c 'local rehearsal, since nothing is deployed')"
  check "an unknown record is not described as a rehearsal" "0" "$got"
  rm -f "$t/rec/broadcast/DeployCurb.s.sol/8453/run-1700000000.json"
  mkdir -p "$t/rec/deployments/base-mainnet" && : >"$t/rec/deployments/base-mainnet/run.json"
  ( records_clear "$t/rec" ) >/dev/null 2>&1 && got=passed || got=stopped
  check "a recorded mainnet deployment stops a second one" "stopped" "$got"

  # A python3 THAT IS FOUND BUT DOES NOT RUN - the shape of the Windows alias.
  mkdir -p "$t/fakepy"
  printf '#!/usr/bin/env bash\necho "Python was not found" >&2\nexit 9009\n' >"$t/fakepy/python3"
  chmod +x "$t/fakepy/python3"
  ( PATH="$t/fakepy:$PATH"; python_runs ) && got=accepted || got=refused
  check "a python3 that is on PATH but cannot run is refused" "refused" "$got"

  rm -rf "$t"
  echo
  if [ "$bad" -eq 0 ]; then echo "selftest: all $n checks passed"; exit 0; fi
  echo "selftest: $bad of $n checks FAILED"; exit 1
}
if [ "${1:-}" = "--selftest" ]; then selftest; fi
# --recheck: every message to stderr, and on stdout the one line the printed
# command starts forge on, only once recheck has returned (print_command).
if [ "${1:-}" = "--recheck" ]; then
  recheck "${2:-}" "$(pwd -P)" "$CALLER_DIR" "$HOME/.foundry" >&2 || exit 1
  printf 'recheck passed %s\n' "${2:-}"
  exit 0
fi
# --recheck-resume: the same, for the resume command, with the deployer.
if [ "${1:-}" = "--recheck-resume" ]; then
  recheck "${2:-}" "$(pwd -P)" "$CALLER_DIR" "$HOME/.foundry" "${3:-}" "${4:-}" >&2 || exit 1
  printf 'resume recheck passed %s\n' "${2:-}"
  exit 0
fi
# --recheck-asset: the same, for an asset run's command (print_asset_command),
# with the asset's label.
if [ "${1:-}" = "--recheck-asset" ]; then
  recheck "${2:-}" "$(pwd -P)" "$CALLER_DIR" "$HOME/.foundry" "" "" "${3:-}" >&2 || exit 1
  printf 'asset recheck passed %s %s\n' "${2:-}" "${3:-}"
  exit 0
fi
# --asset <label>: an asset added after launch (asset_run).
if [ "${1:-}" = "--asset" ]; then
  asset_run "${2:-}"
  exit 0
fi

# ============================================================================
# THE RUN
# ============================================================================
# THE CHECKSUM CHECK BELOW RUNS IN python3 (address_ok), so whether python3
# runs at all is asked first: a Windows alias that cannot run would otherwise
# make every checksummed address read as "not an address".
python_runs \
  || fail "python3 is required and did not run (the addresses' checksums and the funding check are worked out with it)."
need CURB_PLATFORM_RECIPIENT
need CURB_POLICY_OWNER
need CURB_DEPLOYER
# THE HOLDER SHARING ROLES (DEPLOY.txt decision 5). DeployCurb refuses to run
# without them on a real chain; asked here before twenty minutes of suites.
need CURB_SHARING_PUBLISHER
need CURB_SHARING_KEEPER_PAYEE
address_list_ok "${CURB_SHARING_VETOERS:-}" \
  || fail "CURB_SHARING_VETOERS is not set, or is not a comma-separated list of addresses with no spaces. It names the vetoers besides the policy owner - at least one, held apart from the publisher (DEPLOY.txt decision 5)."
overrides="$(sharing_roles_bad "$CURB_SHARING_PUBLISHER" "$CURB_POLICY_OWNER" "$CURB_SHARING_VETOERS")"
[ -z "$overrides" ] || {
  printf '%s\n' "$overrides" | sed 's/^/        /'
  fail "the holder sharing roles overlap (above). DeployCurb refuses the same; fix them before the suites run."
}
# $CURB, THE FIRST LAUNCH (first_launch_bad), asked before the suites as well.
overrides="$(first_launch_bad "$CURB_DEPLOYER")"
[ -z "$overrides" ] || {
  printf '%s\n' "$overrides" | sed 's/^/        /'
  fail "the first launch is not said, or not said right (above). DeployCurb refuses the same; fix it before the suites run."
}
# base-forge AND base-cast ARE WSL's (B20_ENVIRONMENT.txt installs them there,
# and Windows holds only stock forge and cast). Asked here, so that the wrong
# shell is found now and not at the simulation or the signature.
[ -x "$FORGE" ] || fail "base-forge is not at $FORGE. Run the preflight in WSL, where B20_ENVIRONMENT.txt installs it (or point FORGE_BIN at it)."
[ -x "$CAST" ] || command -v "$CAST" >/dev/null 2>&1 \
  || fail "base-cast is not at $CAST. Run the preflight in WSL, where B20_ENVIRONMENT.txt installs it (or point CAST_BIN at it)."
# THE GAS GATE DOES ITS ARITHMETIC IN python3 TOO. Without it the gate used to
# stop with a message blaming the deployer's balance; python_runs is asked
# before the first address, above, and says why it runs python rather than
# looking it up.
# THE WALLET OPTION IS CHECKED NOW, not after twenty minutes of suites.
#
# A REFUSED OPTION IS NOT REPEATED. The refused value is exactly the one that
# may be a secret - --private-key 0x..., or a seed phrase pasted into the wrong
# variable - and it used to be echoed back into the terminal and into any log
# the run was piped to. Only the allowed forms are named.
if [ -n "${CURB_WALLET_OPTION:-}" ]; then
  wallet_option_ok "$CURB_WALLET_OPTION" \
    || fail "CURB_WALLET_OPTION matches none of the allowed forms. Its value is not shown here, because it may hold a key or a seed phrase. Use exactly one of: --ledger, --trezor (either optionally followed by --mnemonic-indexes <n> or --mnemonic-derivation-paths <path>), --account <name>, --interactives 1. Never --private-key."
fi
# THE EXPLORER KEY IS ASKED NOW TOO (explorer_key_ok says why), and again by
# the command itself in the shell that signs (recheck).
explorer_key_ok \
  || fail "BASESCAN_API_KEY is not set, or holds whitespace. The printed command verifies on the explorer with it (DEPLOY.txt STEP 2); its value is never printed."
# THE SIGNER, ASKED NOW TOO (signer_check): a hardware wallet that is not
# attached, locked, or on another account is found here, not at STEP 4.
[ -z "${CURB_WALLET_OPTION:-}" ] || signer_check "$CURB_WALLET_OPTION" "$CURB_DEPLOYER"

echo "================================================================"
echo " CURB A1 PREFLIGHT - nothing here sends a transaction"
echo "================================================================"

# ---------------------------------------------------------------- 1. the tree
echo
echo "1. THE COMMIT YOU WOULD BE DEPLOYING"
# THE TREE, THE BUILD AND SEND SETTINGS AND THE OPT-INS (tree_gate says what
# each is asked for), as the asset run asks them too.
tree_gate
# THE MAINNET RECORD MUST BE THE ONLY ONE IN ITS DIRECTORY (records_clear).
# Asked here, before the suites, because it is free to ask: it used to be
# asked after twenty minutes of tests.
records_clear "$PWD"
COMMIT="$(gate_git rev-parse HEAD)"
ok "clean tree at $COMMIT (each of its files hashed, git's work tree this directory, no GIT_* steering it); no FOUNDRY_*/DAPP_* variable in any case, .env or global foundry.toml overrides it, no ETH_*/ETHERSCAN_*/VERIFIER_* variable is exported (ETHERSCAN_API_KEY aside; the command sets its own), and every CURB_ALLOW_* opt-in is true, false or unset"
echo "        write that down; it goes in ADDRESSES.txt"

# ---------------------------------------------------------------- 2. suites
echo
echo "2. THE SUITES, ON THAT COMMIT"
if [ "${CURB_SKIP_TESTS:-}" = "1" ]; then
  echo "  SKIPPED by CURB_SKIP_TESTS=1 - only do this if you just ran them."
else
  bash script/b20/test-all.sh >/tmp/curb-preflight-tests.log 2>&1 \
    && ok "contract suites passed" \
    || { tail -20 /tmp/curb-preflight-tests.log; fail "the suites did not pass. Nothing below matters until they do."; }
  grep -E "tests passed" /tmp/curb-preflight-tests.log | sed 's/^/        /'
  # NOTHING SKIPPED. DEPLOY.txt asks for 0 skipped; a skipped fork test is one
  # that did not run, and "passed" said nothing about it.
  skipped="$(skipped_count /tmp/curb-preflight-tests.log)"
  [ "$skipped" = "0" ] || fail "$skipped tests were SKIPPED. A skipped test did not run; fix the node or the environment and run again."
  ok "nothing was skipped"
  echo '        the browser suite is separate, from a Windows PowerShell in this checkout:  cd web\e2e; npx playwright test  (DEPLOY.txt STEP 1)'
fi
# THE SIZE AND CODE GATE (script/b20/size-gate.sh): every contract within its
# runtime budget and EIP-170, the five contracts core v2 leaves unchanged at
# their pinned code identities, the router at its pinned code hash. Over the
# build the suites just made, or its own build when they were skipped. Run
# whether or not the suites were: it is what the deployment would put on chain.
if [ "${CURB_SKIP_TESTS:-}" = "1" ]; then gate_args=(); else gate_args=(--no-build); fi
bash script/b20/size-gate.sh ${gate_args[@]+"${gate_args[@]}"} >/tmp/curb-preflight-gate.log 2>&1 \
  || { tail -25 /tmp/curb-preflight-gate.log; fail "the size and code gate did not pass (above): a contract over its budget, an unchanged contract whose code moved, or a router that does not hash to its pinned code hash. Nothing is deployed until it passes."; }
ok "the size and code gate passed: every contract within its budget, the unchanged contracts at their pinned identities, the router at its pinned code hash"

# ---------------------------------------------------------------- 3. the chain
echo
echo "3. WHAT LIVE BASE SAYS ABOUT YOUR ADDRESSES"
for pair in "platform recipient:$CURB_PLATFORM_RECIPIENT" \
            "policy owner:$CURB_POLICY_OWNER" \
            "deployer:$CURB_DEPLOYER" \
            "sharing publisher:$CURB_SHARING_PUBLISHER" \
            "sharing keeper payee:$CURB_SHARING_KEEPER_PAYEE"; do
  read_address "${pair%%:*}" "${pair##*:}"
done
IFS=, read -r -a vetoers <<<"$CURB_SHARING_VETOERS"
for v in "${vetoers[@]}"; do read_address "sharing vetoer" "$v"; done
if [ "$CURB_FIRST_LAUNCH" = 1 ]; then
  read_address "\$CURB creator" "$CURB_FIRST_CREATOR"
  # ONE KEY IS REFUSED UNLESS SAID, as DeployCurb's checkFirstLaunch refuses
  # it: decision 6 asks for a treasury Safe, and a code-less address is also
  # what a mistyped one looks like. Asked here, before the simulation.
  case "$READ_KIND" in
    "ONE KEY"*) [ "${CURB_ALLOW_EOA_CREATOR:-}" = true ] \
      || fail "CURB_FIRST_CREATOR is one key (no code, or only an EIP-7702 delegation). DEPLOY.txt decision 6 asks for a treasury Safe; \$CURB's dev-buy tokens, refund and locked position go to it for good. If one key is really intended, set CURB_ALLOW_EOA_CREATOR=true." ;;
  esac
  echo
  echo "        \$CURB, THE FIRST LAUNCH, made on the WETH factory inside the broadcast:"
  printf '          name %q, symbol %q, URI %q\n' "$CURB_FIRST_NAME" "$CURB_FIRST_SYMBOL" "$CURB_FIRST_URI"
  echo "          tax $CURB_FIRST_TAX_BPS bps, dev buy $CURB_FIRST_DEV_BUY wei of ether wrapped into WETH,"
  echo "          shared with its holders from the start: $([ "$CURB_FIRST_SHARE" = 1 ] && echo yes || echo no)"
  echo "        The creator above is \$CURB's creator-fee recipient and the owner of its"
  echo "        locked position for good - no setter moves either. Check it is the"
  echo "        treasury you mean."
else
  echo
  echo "        CURB_FIRST_LAUNCH=0: THE RUN LAUNCHES NOTHING. \$CURB is decided to be the"
  echo "        WETH factory's first launch, and the Launches hero shows the registry's"
  echo "        first ETH pair for good; made by hand after the run, it races everyone"
  echo "        watching the chain from the moment the factories are admitted."
fi
echo
echo "        THE SHARING ROLES: the publisher proposes holder payouts, the keeper"
echo "        payee receives the keeper's gas fee (at most 2% of each payout), and"
echo "        each vetoer - with the policy owner, which is one too - can stop a"
echo "        payout inside its hour, or freeze them all. The policy owner can rotate"
echo "        the publisher and the payee, remove a vetoer or end a freeze only"
echo "        behind a 48-hour announcement."
echo
echo "        READ THE FIRST THREE LINES. Every launch freezes the recipient in force"
echo "        when it is created, for good. The hook's recipient can be changed"
echo "        later - by the policy owner, behind a 24-hour announcement - but"
echo "        only for launches created after the change."
echo "        The deploy script refuses a recipient or a policy owner that is one"
echo "        key, or a contract that is not Safe-shaped, and a \$CURB creator that"
echo "        is one key, unless the matching CURB_ALLOW_* opt-in is set (DEPLOY.txt"
echo "        STEP 2)."
# THE SAME ADDRESS FOR BOTH IS REFUSED UNLESS SAID. One holds revenue and the
# other decides where revenue goes; DEPLOY.txt says they should NOT be the same.
# The deploy script refuses it too (checkPolicyOwner); this says so before the
# suites' time is spent.
# CASE-INSENSITIVE: one address in checksum form and in lowercase is one address.
if [ "${CURB_PLATFORM_RECIPIENT,,}" != "${CURB_POLICY_OWNER,,}" ]; then
  ok "the recipient and the policy owner are different addresses"
else
  [ "${CURB_ALLOW_SAME_RECIPIENT_AND_OWNER:-}" = "true" ] \
    || fail "the recipient and the policy owner are the SAME address. DEPLOY.txt argues against it; set CURB_ALLOW_SAME_RECIPIENT_AND_OWNER=true if it is really intended."
  echo "        NOTE: recipient and policy owner are the SAME address, by explicit choice."
fi

# ---------------------------------------------------------------- 4. gas
echo
echo "4. WHAT THE DEPLOYER HOLDS"
balw="$("$CAST" balance "$CURB_DEPLOYER" --rpc-url "$RPC" 2>/dev/null)" \
  || fail "could not read the deployer's balance from $RPC."
balw="$(printf '%s' "$balw" | tr -d '\n')"
[[ "$balw" =~ ^[0-9]+$ ]] || fail "the deployer's balance read is not a number: '$balw'."
# COMPARED AFTER THE SIMULATION, against the simulation's own estimate. This
# used to print ok for any non-zero balance - 1 wei included - and the banner
# below then said everything checkable had passed.
echo "        $balw wei; checked against the simulated cost in section 7"
# EXCEPT $CURB'S DEV BUY, WHICH THE SIMULATION ITSELF SPENDS. forge gives a
# balance only to its own default sender; run as --sender CURB_DEPLOYER, the
# simulation keeps the deployer's real Base balance, and DeployCurb wraps the
# dev buy out of it inside the broadcast (_fundFirst). A deployer holding
# less reverted OutOfFunds, and the run stopped in section 5 as "the
# simulation did not complete" - before the dollar check, and before the
# funding check could name an amount to send. The simulation charges no gas,
# so the dev buy alone is what it needs; asked here, with the amount.
if [ "$CURB_FIRST_LAUNCH" = 1 ] && wei_below "$balw" "$CURB_FIRST_DEV_BUY"; then
  fail "the deployer holds $balw wei, less than \$CURB's dev buy of $CURB_FIRST_DEV_BUY wei. The simulation below sends as the deployer, from its real Base balance (forge funds only its own default sender), and wraps the dev buy out of it, so it would revert OutOfFunds before anything is priced. Send the deployer at least $CURB_FIRST_DEV_BUY wei in all, then run this again; section 7 then names what the whole run needs (DEPLOY.txt STEP 2)."
fi
[ "$CURB_FIRST_LAUNCH" = 1 ] && wei_below 0 "$CURB_FIRST_DEV_BUY" \
  && echo "        that covers \$CURB's dev buy of $CURB_FIRST_DEV_BUY wei, which the simulation wraps out of it"
[ "$balw" = "0" ] && echo "        the deployer holds NOTHING. Section 7 will say how much it needs."

# ---------------------------------------------------------------- 5. simulate
echo
echo "5. THE WHOLE DEPLOYMENT, SIMULATED AGAINST LIVE BASE"
SIM=/tmp/curb-preflight-sim.log
# THE DEPLOY SCRIPT REFUSES A NO-CODE PLATFORM RECIPIENT OR POLICY OWNER, and
# this once turned that off: the override defaulted to true here and in the
# broadcast command printed below, so the one layer whose job is to protect
# the real deployment reversed the safe default. Opt-in now: set each
# explicitly if it is genuinely intended, and see it in the log when you do.
# (A COMMENT ONCE SAT INSIDE THE CONTINUED COMMAND BELOW, which ended it early
# and cut the first two assignments off forge's environment.)
CURB_PLATFORM_RECIPIENT="$CURB_PLATFORM_RECIPIENT" \
CURB_POLICY_OWNER="$CURB_POLICY_OWNER" \
CURB_SHARING_PUBLISHER="$CURB_SHARING_PUBLISHER" \
CURB_SHARING_KEEPER_PAYEE="$CURB_SHARING_KEEPER_PAYEE" \
CURB_SHARING_VETOERS="$CURB_SHARING_VETOERS" \
CURB_ALLOW_EOA_RECIPIENT="${CURB_ALLOW_EOA_RECIPIENT:-false}" \
CURB_ALLOW_NON_SAFE_RECIPIENT="${CURB_ALLOW_NON_SAFE_RECIPIENT:-false}" \
CURB_ALLOW_EOA_POLICY_OWNER="${CURB_ALLOW_EOA_POLICY_OWNER:-false}" \
CURB_ALLOW_NON_SAFE_POLICY_OWNER="${CURB_ALLOW_NON_SAFE_POLICY_OWNER:-false}" \
CURB_ALLOW_SAME_RECIPIENT_AND_OWNER="${CURB_ALLOW_SAME_RECIPIENT_AND_OWNER:-false}" \
CURB_ALLOW_EOA_CREATOR="${CURB_ALLOW_EOA_CREATOR:-false}" \
CURB_FIRST_LAUNCH="$CURB_FIRST_LAUNCH" \
"$FORGE" script script/DeployCurb.s.sol --rpc-url "$RPC" --sender "$CURB_DEPLOYER" >"$SIM" 2>&1
rc=$?
grep -qi "SIMULATION COMPLETE" "$SIM" || { tail -25 "$SIM"; fail "the simulation did not complete (exit $rc). Do not broadcast. Full log: $SIM"; }
# THE COUNT COMES OUT OF THE RUN. Seven shared contracts - registry, sharing
# catalog, graduator, hook, holder distributor factory and the distributor
# implementation its constructor builds, lens - and four per asset: factory,
# escrow, policy, buyback vault.
ASSETS=$(awk '/=== one factory per quote asset ===/{f=1;next} f&&NF==0{exit} f' "$SIM" | grep -c .)
[ "${ASSETS:-0}" -gt 0 ] || fail "the simulation listed no quote assets at all. Do not broadcast."
ok "$ASSETS quote assets, $((7 + ASSETS * 4)) contracts, no reverts, against live Base"
echo
echo "        WHAT THE SCRIPT SAID - all of it (sim_logs above says why):"
sim_logs "$SIM" | sed 's/^/      /'
grep -E "Estimated amount" "$SIM" | sed 's/^/        /'
echo "        the full simulation log is $SIM"
grep -q "NO DEMO LAUNCH WAS CREATED" "$SIM" \
  || fail "the simulation CREATED A DEMO LAUNCH. CURB_DEMO_LAUNCH must not be set for a real chain."
grep -q "chain id         8453" "$SIM" || fail "that was not chain 8453."
sim_checked_code "$SIM" \
  || fail "the simulation never said it checked the unchanged contracts' code (DeployCurb's requireUnchangedCode). Do not broadcast a script that does not check it."
ok "the simulation checked the five unchanged contracts' code against their pinned identities"
# $CURB, AS THE SIMULATION MADE IT - or nothing, as asked.
if [ "$CURB_FIRST_LAUNCH" = 1 ]; then
  grep -q 'NO DEMO LAUNCH WAS CREATED. The registry holds \$CURB alone, as launch 0.' "$SIM" \
    || fail "the simulation did not make \$CURB the registry's only launch. Do not broadcast. Full log: $SIM"
  ok "the simulation made \$CURB registry.launchAt(0), on the WETH factory, and nothing else"
  echo "        on chain one receipt stays open before it on the WETH factory - its admission,"
  echo "        the run's first; every other factory is admitted after \$CURB - so"
  echo "        check-deployment.sh (STEP 5) reads which launch \$CURB is, and its token and"
  echo "        curve, from its launch's receipt"
else
  grep -q "NO DEMO LAUNCH WAS CREATED. The registry is empty." "$SIM" \
    || fail "the simulation launched something, and CURB_FIRST_LAUNCH is 0. Do not broadcast. Full log: $SIM"
fi
# THE REGISTRY, OFFERED TO THE POLICY OWNER IN THE RUN (DeployCurb's
# requireRegistryHandover) - the Safe accepts it after.
if [ "${CURB_POLICY_OWNER,,}" != "${CURB_DEPLOYER,,}" ]; then
  grep -q "THE REGISTRY IS OFFERED, NOT HANDED OVER" "$SIM" \
    || fail "the simulation did not offer the registry to the policy owner. Do not broadcast. Full log: $SIM"
  ok "the simulation offers the registry to the policy owner, who accepts it after the run"
fi

# ---------------------------------------------------------------- 6. the dollars
echo
echo "6. EVERY ASSET'S START AND GRADUATION AT TODAY'S CHAINLINK PRICES"
echo "        each within ${USD_TOLERANCE_PCT}% of \$$USD_START and \$$USD_GRADUATION (usd_shape_bad says why)"
usd_gate "$SIM"
ok "every listed asset starts within ${USD_TOLERANCE_PCT}% of \$$USD_START and graduates within ${USD_TOLERANCE_PCT}% of \$$USD_GRADUATION at today's prices"

# ---------------------------------------------------------------- 7. funding
echo
echo "7. CAN THE DEPLOYER PAY"
# THREE TIMES THE ESTIMATE, AND THE DEV BUY ON TOP (funding_gate), which is
# ether the run sends (wrapped into WETH), not gas: forge's estimate does not
# count it. That first run's deployer already holds the dev buy, which
# section 4 asks for because the simulation spends it.
devbuy_wei=0
[ "$CURB_FIRST_LAUNCH" = 1 ] && devbuy_wei="$CURB_FIRST_DEV_BUY"
funding_gate "$SIM" "$devbuy_wei" "$balw"

# ---------------------------------------------------------------- 8. the command
echo
echo "================================================================"
echo " EVERYTHING CHECKABLE WITHOUT A KEY HAS PASSED."
echo "================================================================"
echo
echo " THE ONE COMMAND LEFT IS YOURS TO SIGN. It uses ONE wallet option:"
echo "     --ledger              a Ledger, which is the one to prefer"
echo "     --trezor              a Trezor"
echo "     --account <name>      a keystore you made with:  cast wallet import"
echo "     --interactives 1      pastes the key at a prompt, not into history"
echo " A Ledger or Trezor signs as its FIRST account unless told otherwise. If the"
echo " deployer is another one, add exactly one of these to CURB_WALLET_OPTION:"
echo "     --mnemonic-indexes <n>                 the device's account number n"
echo "     --mnemonic-derivation-paths <path>     a full path, e.g. a legacy one"
if [ -n "${CURB_WALLET_OPTION:-}" ]; then
  echo " Printed below with yours, CURB_WALLET_OPTION=$CURB_WALLET_OPTION. Run it exactly."
else
  echo " CURB_WALLET_OPTION is not set, so the last line is a placeholder that will"
  echo " not run. Set CURB_WALLET_OPTION and run the preflight again to have it"
  echo " printed in place, rather than editing the command by hand."
fi
echo
echo " DO NOT use --private-key. It puts the key in your shell history, in your"
echo " process list, and in any log that captures the command."
echo
print_command "${CURB_WALLET_OPTION:-}" "$COMMIT"
echo
echo " --slow SENDS ONE TRANSACTION AT A TIME, each after the last one's receipt, so"
echo " a send that is dropped or rate-limited stops the run there instead of"
echo " stranding everything after it behind a nonce gap."
echo
echo " ITS FIRST TWO LINES RE-RUN SECTION 1 IN THE SHELL YOU SIGN FROM - the commit"
echo " ($COMMIT), a clean tree (each file hashed, ignored files forge would compile"
echo " included, git's work tree the root, no GIT_* variable steering git), no"
echo " FOUNDRY_*/DAPP_* variable in any case, .env or global foundry.toml, no ETH_*,"
echo " ETHERSCAN_* or VERIFIER_* variable (refused as families; ETHERSCAN_API_KEY"
echo " aside, which the command sets from BASESCAN_API_KEY), every CURB_ALLOW_*"
echo " true, false or unset, no earlier record, BASESCAN_API_KEY exported - and forge"
echo " starts only on the line \"recheck passed <commit>\", which the recheck prints"
echo " once all of it holds. Run it from the repository root."
echo " The explorer key reaches forge in its environment, never on its command"
echo " line; the command holds only its name."
endpoint_note
echo
echo " --verify does step 6 of DEPLOY.txt in the same run, which is better than"
echo " doing it afterwards: the constructor arguments come from the deployment"
echo " itself rather than from retyping. The Uniswap hook allowlist REQUIRES a"
echo " verified hook, so this is not optional."
echo
echo " IF THE BROADCAST DIES PART WAY - forge stops, the endpoint drops, the"
echo " machine sleeps - DO NOT run the command above again: wire() is callable once,"
echo " and a second full run deploys a second everything. First copy"
echo " broadcast/DeployCurb.s.sol/8453/run-latest.json to deployments/base-mainnet/run.json"
echo " (and commit it), copy cache/DeployCurb.s.sol/8453/run-latest.json somewhere private"
echo " outside the repository (it names the endpoint, key and all; never commit it),"
echo " then run this, which resumes what the record says was not confirmed - and starts"
echo " forge only if the record is CURB_DEPLOYER's, has something left to send and no"
echo " reverted transaction, its copy is kept, and its cache half names this endpoint:"
echo
print_command "${CURB_WALLET_OPTION:-}" "$COMMIT" resume
echo
echo " RESUME WITHIN THE DAY. The catalog lets the deployer admit the first"
echo " distributor factory only within one day of the catalog's creation"
echo " (SharingCatalog.BOOTSTRAP_PERIOD). The run does it in its sixth transaction,"
echo " before any stack, so this binds only a broadcast that died before it; past"
echo " that day, the first version needs the policy Safe's seven-day proposal."
echo " A record holding a transaction that REVERTED is not resumed - the command"
echo " refuses it: read the record, and see DEPLOY.txt, IF SOMETHING GOES WRONG."
echo
echo " AFTER IT LANDS, in DEPLOY.txt's order:"
echo "   - at once: copy broadcast/DeployCurb.s.sol/8453/run-latest.json to"
echo "     deployments/base-mainnet/run.json (STEP 4; STEP 5 commits it)"
echo "   - then, within the hour and before STEP 4A, the head of STEP 5:"
echo "     services/sharer/deploy/sharer.json from the record (npm run config-from-run) and"
echo "     the guardian started from it on its own machine (services/sharer/RUNBOOK.md part"
echo "     10) - holder sharing is live from the broadcast, and until a guardian runs"
echo "     nothing watches a root (DEPLOY.txt STEP 5 says what if it cannot run)"
echo "   - STEP 4A: the router - script/DeployRouter.s.sol, from the same key, verified"
echo "     by hand with --compilation-profile router, its code hash read back"
if [ "${CURB_POLICY_OWNER,,}" != "${CURB_DEPLOYER,,}" ]; then
  echo "   - STEP 4B: the policy Safe accepts the registry - to the LaunchRegistry, value 0,"
  echo "     data 0x79ba5097 (acceptOwnership()). Until it does, the deployer's key alone"
  echo "     can admit launchers. Propose it now; STEP 5 can be done while it waits."
fi
echo "   - STEP 5, the rest: fill in ADDRESSES.txt from the output, with commit $COMMIT;"
echo "     web/config.js (rpc, lens, every factory - the only file the pages read addresses"
echo "     from); web/sharing.js CODE_AT; web/docs.md's contract table and verify repository;"
echo "     services/sharer/deploy/sharer.json (npm run config-from-run, services/sharer/RUNBOOK.md"
echo "     part 7) and the /sharing/<chain>/ rewrite in web/vercel.json and web/_redirects."
echo "     Commit them by name with deployments/base-mainnet/run.json, and router-run.json if"
echo "     STEP 4A sent the router (never git add -A: the rewritten out/ stays out), then"
echo "       bash script/b20/check-publish-set.sh --addresses ADDRESSES.txt    must print 'publish set ok'"
echo "       bash script/b20/check-deployment.sh <rpc> deployments/base-mainnet/run.json"
echo "     in this shell, with the variables above still exported: it must end 'ok'"
if [ "${CURB_POLICY_OWNER,,}" != "${CURB_DEPLOYER,,}" ]; then
  echo "     (a registry still waiting for the Safe is said as PENDING, and passes), and once"
  echo "     STEP 4B is executed, again with --accepted, which must end 'ok' before STEP 8"
fi
if [ "$CURB_FIRST_LAUNCH" = 1 ]; then
  echo "   - \$CURB is registry.launchAt(0) on the WETH factory: check-deployment.sh reads which launch"
  echo "     it is and prints its token and curve from its launch's receipt - ADDRESSES.txt takes"
  echo "     those, not the simulation's \$CURB lines (DEPLOY.txt, \$CURB IS NOT LAUNCH ZERO, if not 0)"
fi
echo "   - then DEPLOY.txt STEP 6 to STEP 9, and its 'IMMEDIATELY AFTER' list"
