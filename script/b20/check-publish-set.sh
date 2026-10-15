#!/usr/bin/env bash
# WHAT THE HOST WOULD SERVE FROM web/, CHECKED BEFORE IT IS PUBLISHED.
#
#   bash script/b20/check-publish-set.sh
#     the publish set as it stands: no test page in it, the hosts' rules in
#     place, and the response headers naming every inline script.
#
#   bash script/b20/check-publish-set.sh --addresses ADDRESSES.txt
#     the same, and deploy day's (DEPLOY.txt STEP 5): web/config.js names an
#     https endpoint, the lens and the registry ADDRESSES.txt records and every
#     factory it records, on chain 8453; and web/sharing.js CODE_AT names the
#     public code repository at a commit.
#
#   bash script/b20/check-publish-set.sh --selftest
#     every refusal below, made to happen on a copy, and the clean copy passing.
#     Run it after editing anything here.
#
#   --web DIR checks another folder instead of web/ (the selftest uses it).
#
# WHY. web/ is the site and also where the browser tests live: tests.html and
# wallet-setup.html take ?rpc= and talk to a wallet, and served from the
# production origin a crafted link to one runs with that origin's storage and
# wallet. Vercel leaves out what web/.vercelignore names; Netlify uploads the
# folder whole, so web/_redirects answers the same paths with a 404 (the !
# makes a rule win over a file that exists). Either missing a line, or a new
# test file that neither names, ships it - and only a check says so.
#
# THE PUBLISH SET IS THE FOLDER ON DISK, not git's list: a host's CLI uploads
# what is there, run output and node_modules included, less what the ignore
# file names. (A Git-connected deploy sees only what is committed, which is
# never more.)
#
# Exits non-zero on any failure, naming each one.
set -uo pipefail
unset CDPATH
cd "$(dirname "$0")/../.." || exit 2

WEB="web"
ADDRESSES=""
SELFTEST=0
while [ $# -gt 0 ]; do
  case "$1" in
    --web) WEB="${2:-}"; shift 2 ;;
    --addresses) ADDRESSES="${2:-}"; shift 2 ;;
    --selftest) SELFTEST=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# NEVER IN THE PUBLISH SET, wherever they sit: the test pages and their wallet,
# the runbook for the real-wallet run, the folder's own notes, the browser
# tests and everything they write.
FORBIDDEN_FILES="tests.html wallet-setup.html wallet-stub.js REAL_WALLET_TEST.txt README.txt"
FORBIDDEN_DIRS="e2e test-results playwright-report node_modules"
# ALWAYS IN IT: the root's page and the 404, the config every page reads first,
# the bar, the two rewritten pages, and the hosts' own files.
REQUIRED="browse.html 404.html config.js topbar.js app.html sharing.html vercel.json _headers _redirects og.png"

fails=0
fail() { echo "FAIL  $*"; fails=$((fails + 1)); }
ok() { echo "ok    $*"; }

check_set() {
  local web="$1" addresses="$2"
  fails=0
  if [ ! -d "$web" ]; then fail "no folder at $web"; return; fi

  # ---- web/.vercelignore: one literal path per line, from web/, leading slash.
  # A wildcard or a relative line is refused rather than guessed at: a check
  # that reads the file differently from Vercel says nothing about Vercel.
  local ignore="$web/.vercelignore" rules=() line
  if [ ! -f "$ignore" ]; then
    fail ".vercelignore is missing: Vercel would upload every test page"
  else
    while IFS= read -r line || [ -n "$line" ]; do
      line="${line%$'\r'}"
      line="${line#"${line%%[![:space:]]*}"}"; line="${line%"${line##*[![:space:]]}"}"
      [ -z "$line" ] && continue
      case "$line" in \#*) continue ;; esac
      if ! printf '%s' "$line" | grep -Eq '^/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*/?$'; then
        fail ".vercelignore line '$line' is not one literal path with a leading slash - this check cannot read it as Vercel does"
        continue
      fi
      line="${line#/}"; line="${line%/}"
      rules+=("$line")
    done < "$ignore"
  fi

  # ---- the publish set: every file on disk, less the ignored paths.
  local prune=() r
  for r in "${rules[@]+"${rules[@]}"}"; do prune+=( -path "$web/$r" -prune -o ); done
  local set
  set="$(find "$web" "${prune[@]+"${prune[@]}"}" -type f -print 2>/dev/null | sed "s|^$web/||" | sort)"
  # A file a rule names exactly is out too (find prunes it before -type f, but
  # say it plainly for a file rule).
  local f bad=0 name d
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    name="${f##*/}"
    for d in $FORBIDDEN_FILES; do
      if [ "$name" = "$d" ]; then fail "$f would be published - a test file (.vercelignore must name /$f)"; bad=1; fi
    done
    for d in $FORBIDDEN_DIRS; do
      case "/$f" in */"$d"/*) fail "$f would be published - it is under $d/ (.vercelignore must name its folder)"; bad=1 ;; esac
    done
    case "$name" in *.spec.js|.state.json|.run.json) fail "$f would be published - test output"; bad=1 ;; esac
  done <<< "$set"
  [ "$bad" = 0 ] && ok "no test file in the publish set ($(printf '%s\n' "$set" | grep -c .) files)"

  for f in $REQUIRED; do
    if ! printf '%s\n' "$set" | grep -qxF "$f"; then fail "$f is not in the publish set"; fi
  done

  # ---- web/_redirects: every ignored path answered with the site's 404,
  # forced, for Netlify; and the root is the launches page.
  local redirects="$web/_redirects" want
  if [ ! -f "$redirects" ]; then
    fail "_redirects is missing"
  else
    for r in "${rules[@]+"${rules[@]}"}"; do
      if [ -d "$web/$r" ] || [ "${r##*.}" = "$r" ]; then want="/$r/*"; else want="/$r"; fi
      if ! grep -Eq "^[[:space:]]*$(printf '%s' "$want" | sed 's/[.*]/\\&/g')[[:space:]]+/404\.html[[:space:]]+404![[:space:]]*$" "$redirects"; then
        fail "_redirects does not answer $want with '/404.html 404!' - Netlify would serve it"
      fi
    done
    grep -Eq '^[[:space:]]*/[[:space:]]+/browse\.html[[:space:]]+200[[:space:]]*$' "$redirects" \
      || fail "_redirects does not serve / as /browse.html"
  fi
  if [ -f "$web/vercel.json" ]; then
    grep -Eq '"source": *"/", *"destination": *"/browse\.html"' "$web/vercel.json" \
      || fail "vercel.json does not rewrite / to /browse.html"
  fi

  # ---- the headers: the same policy for both hosts, and it names every
  # inline script a published page carries.
  local csp_n csp_v hdr
  csp_n="$(grep -E '^[[:space:]]+Content-Security-Policy:' "$web/_headers" 2>/dev/null | head -1 | sed -E 's/^[[:space:]]+Content-Security-Policy:[[:space:]]*//; s/[[:space:]]+$//')"
  csp_v="$(grep -oE '"key": *"Content-Security-Policy", *"value": *"[^"]*"' "$web/vercel.json" 2>/dev/null | head -1 | sed -E 's/.*"value": *"//; s/"$//')"
  if [ -z "$csp_n" ]; then fail "_headers has no Content-Security-Policy"; fi
  if [ -z "$csp_v" ]; then fail "vercel.json has no Content-Security-Policy"; fi
  if [ -n "$csp_n" ] && [ "$csp_n" != "$csp_v" ]; then fail "the policy in _headers and the one in vercel.json differ"; fi
  # The other four, value for value in each host's file - so the two cannot
  # differ. Matched as literal text (\Q..\E): Permissions-Policy's "()" is an
  # empty group to a regex, and "camera=, microphone=" would then pass.
  for hdr in "X-Frame-Options: DENY" "X-Content-Type-Options: nosniff" "Referrer-Policy: strict-origin-when-cross-origin" \
             "Permissions-Policy: camera=(), microphone=(), geolocation=()"; do
    perl -ne 'BEGIN { $h = shift; $f = 1 } $f = 0 if /^\s+\Q$h\E\s*$/; END { exit $f }' \
      "$hdr" "$web/_headers" 2>/dev/null || fail "_headers does not send $hdr"
    perl -ne 'BEGIN { ($k, $v) = (shift, shift); $f = 1 } $f = 0 if /"key": *"\Q$k\E", *"value": *"\Q$v\E"/; END { exit $f }' \
      "${hdr%%:*}" "${hdr#*: }" "$web/vercel.json" 2>/dev/null || fail "vercel.json does not send $hdr"
  done
  case "$csp_n" in *"frame-ancestors 'none'"*) ;; *) fail "the policy does not forbid framing (frame-ancestors 'none')" ;; esac
  local hashes h page n_inline=0
  while IFS= read -r page; do
    case "$page" in *.html) ;; *) continue ;; esac
    hashes="$(perl -MDigest::SHA=sha256_base64 -0777 -ne '
      while (/<script(?![^>]*\bsrc=)[^>]*>(.*?)<\/script>/gs) {
        my $h = sha256_base64($1); $h .= "=" while length($h) % 4; print "sha256-$h\n";
      }' "$web/$page")"
    for h in $hashes; do
      n_inline=$((n_inline + 1))
      case "$csp_n" in *"'$h'"*) ;; *) fail "$page has an inline script ($h) the policy does not name - the browser would refuse it" ;; esac
    done
  done <<< "$set"
  ok "headers checked; $n_inline inline script(s) named by the policy"

  # ---- deploy day: config.js names the deployment ADDRESSES.txt records.
  if [ -n "$addresses" ]; then
    if [ ! -f "$addresses" ]; then fail "no address book at $addresses"; else
      local cfg="$web/config.js" rpc lens registry chain factories book_lens book_registry book_factories
      rpc="$(perl -0777 -ne 'print $1 if /\brpc:\s*"([^"]*)"/' "$cfg")"
      lens="$(perl -0777 -ne 'print lc $1 if /\blens:\s*"([^"]*)"/' "$cfg")"
      registry="$(perl -0777 -ne 'print lc $1 if /\bregistry:\s*"([^"]*)"/' "$cfg")"
      chain="$(perl -0777 -ne 'print $1 if /\bchainId:\s*(\d+)/' "$cfg")"
      factories="$(perl -0777 -ne 'if (/\bfactories:\s*\[([^\]]*)\]/) { my $l = $1; print lc("$1\n") while $l =~ /"(0x[0-9a-fA-F]{40})"/g }' "$cfg" | sort -u)"
      book_lens="$(perl -ne 'print lc $1 if /^\s*LaunchLens\s+(0x[0-9a-fA-F]{40})\s*$/' "$addresses" | head -1)"
      book_registry="$(perl -ne 'print lc $1 if /^\s*LaunchRegistry\s+(0x[0-9a-fA-F]{40})\s*$/' "$addresses" | head -1)"
      book_factories="$(perl -ne 'print lc("$1\n") if /^\s*CurbLaunchFactory\s+(0x[0-9a-fA-F]{40})\s*$/' "$addresses" | sort -u)"
      [ "$chain" = "8453" ] || fail "config.js chainId is '$chain', not 8453"
      case "$rpc" in
        https://*) case "$rpc" in *127.0.0.1*|*localhost*) fail "config.js rpc is a local endpoint: $rpc" ;; esac ;;
        *) fail "config.js rpc is '$rpc' - deploy day sets the site's https endpoint (DEPLOY.txt STEP 5)" ;;
      esac
      if [ -z "$book_lens" ]; then fail "$addresses records no LaunchLens address - fill it in first (STEP 5)"
      elif [ "$lens" != "$book_lens" ]; then fail "config.js lens '$lens' is not the LaunchLens $addresses records ($book_lens)"; fi
      # THE REGISTRY TOO. On chain 8453 the pages send nothing to a factory whose
      # registry is not this one (web/app.js canonicalRefusal), so an empty or a
      # wrong one here would stop every buy, sale, create and claim on the site.
      if [ -z "$book_registry" ]; then fail "$addresses records no LaunchRegistry address - fill it in first (STEP 5)"
      elif [ "$registry" != "$book_registry" ]; then fail "config.js registry '$registry' is not the LaunchRegistry $addresses records ($book_registry)"; fi
      if [ -z "$book_factories" ]; then fail "$addresses records no CurbLaunchFactory address - fill it in first (STEP 5)"
      elif [ "$factories" != "$book_factories" ]; then
        fail "config.js factories are not the CurbLaunchFactory addresses $addresses records:"
        diff <(printf '%s\n' "$book_factories") <(printf '%s\n' "$factories") | sed 's/^/        /'
      fi
      [ "$fails" = 0 ] && ok "config.js names the deployment $addresses records"
    fi
    # The verify panel's repository, pinned to a commit: a branch moves on, and
    # the reader must run the code that made the files (web/sharing.js CODE_AT).
    local code_at commit
    code_at="$(perl -0777 -ne 'print $1 if /\bconst CODE_AT = "([^"]*)"/' "$web/sharing.js")"
    if printf '%s' "$code_at" | grep -Eq '^https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/tree/[0-9a-f]{40}/services/sharer$'; then
      commit="${code_at#*/tree/}"
      ok "sharing.js names the code repository at commit ${commit%%/*}"
    else
      fail "sharing.js CODE_AT is '$code_at' - deploy day sets https://github.com/<org>/<repo>/tree/<the deployed commit>/services/sharer (DEPLOY.txt STEP 5)"
    fi
  fi
}

# ---------------------------------------------------------------- selftest
selftest() {
  local t pass=0 total=0 out
  t="$(mktemp -d)" || exit 2
  trap 'rm -rf "$t"' RETURN
  # A COPY OF THE TOP OF web/ - its files, no folders (e2e/ holds a junction to
  # node_modules on some machines) - and a stand-in e2e/ and test-results/.
  fresh() {
    rm -rf "$t/w" && mkdir -p "$t/w/e2e" "$t/w/test-results" "$t/w/assets"
    find web -maxdepth 1 -type f -exec cp {} "$t/w/" \;
    echo "x" > "$t/w/e2e/site.spec.js"
    echo "{}" > "$t/w/test-results/.last-run.json"
    echo "x" > "$t/w/assets/weth.svg"
  }
  expect() {   # expect <pass|fail> <what> [grep for in the output]
    local want="$1" what="$2" needle="${3:-}" got
    total=$((total + 1))
    out="$(check_set "$t/w" "${ADDR_FILE:-}"; echo "fails=$fails")"
    got=pass; printf '%s\n' "$out" | grep -q '^fails=0$' || got=fail
    if [ "$got" = "$want" ] && { [ -z "$needle" ] || printf '%s\n' "$out" | grep -qF "$needle"; }; then
      pass=$((pass + 1)); echo "ok    $what"
    else
      echo "FAIL  $what (wanted $want${needle:+ naming \"$needle\"}, got $got)"; printf '%s\n' "$out" | sed 's/^/        /'
    fi
  }
  ADDR_FILE=""

  fresh; expect pass "the folder as committed passes"

  fresh; sed -i '/^\/tests\.html$/d' "$t/w/.vercelignore"
  expect fail "a test page .vercelignore does not name is refused" "tests.html would be published"

  fresh; sed -i '/^\/e2e$/d' "$t/w/.vercelignore"
  expect fail "the browser tests' folder, not ignored, is refused" "under e2e/"

  fresh; echo "x" > "$t/w/test-results/trace.zip"; sed -i '/^\/test-results$/d' "$t/w/.vercelignore"
  expect fail "run output, not ignored, is refused" "under test-results/"

  fresh; mkdir -p "$t/w/sub"; echo x > "$t/w/sub/wallet-stub.js"
  expect fail "a test file in a subfolder is refused" "sub/wallet-stub.js"

  fresh; echo "/*.html" >> "$t/w/.vercelignore"
  expect fail "a wildcard in .vercelignore is refused, not guessed at" "cannot read it as Vercel does"

  fresh; sed -i '/^\/wallet-setup\.html /d' "$t/w/_redirects"
  expect fail "a test page _redirects does not 404 is refused" "/wallet-setup.html"

  fresh; sed -i 's|^/e2e/\*  /404.html  404!$|/e2e/*  /404.html  404|' "$t/w/_redirects"
  expect fail "a 404 rule without the ! (a file would win over it) is refused" "/e2e/*"

  fresh; sed -i '/^\/  \/browse\.html  200$/d' "$t/w/_redirects"
  expect fail "the root not served as the launches page is refused" "does not serve / as /browse.html"

  fresh; sed -i 's|"source": "/", "destination": "/browse.html"|"source": "/home", "destination": "/browse.html"|' "$t/w/vercel.json"
  expect fail "vercel.json without the root's rewrite is refused" "does not rewrite /"

  fresh; rm "$t/w/404.html"
  expect fail "no 404 page is refused" "404.html is not in the publish set"

  fresh; perl -0777 -pi -e 's/(<script>\s*\n\s*\/\/ ONE PAGE)/$1 (edited)/' "$t/w/app.html"
  expect fail "an inline script edited without its hash in the policy is refused" "app.html has an inline script"

  fresh; perl -0777 -pi -e "s/frame-ancestors 'none'/frame-ancestors 'self'/" "$t/w/vercel.json"
  expect fail "the two hosts' policies differing is refused" "differ"

  fresh; perl -0777 -pi -e "s/frame-ancestors 'none'/frame-ancestors */g" "$t/w/vercel.json" "$t/w/_headers"
  expect fail "a policy that allows framing is refused" "frame-ancestors"

  fresh; sed -i '/X-Content-Type-Options/d' "$t/w/_headers"
  expect fail "a missing nosniff is refused" "X-Content-Type-Options"

  fresh; perl -0777 -pi -e 's/geolocation=\(\)/geolocation=(self)/' "$t/w/vercel.json"
  expect fail "a Permissions-Policy in vercel.json other than the one in _headers is refused" "vercel.json does not send Permissions-Policy"

  fresh; perl -pi -e 's/=\(\)/=/g if /^\s+Permissions-Policy:/' "$t/w/_headers"
  expect fail "a Permissions-Policy with its () left out is refused (read as text: to a regex they are empty groups)" "_headers does not send Permissions-Policy"

  # ---- deploy day
  local L="0x00000000000000000000000000000000000000aa" F1="0x00000000000000000000000000000000000000bb" F2="0x00000000000000000000000000000000000000Cc"
  local R="0x00000000000000000000000000000000000000dD"
  ADDR_FILE="$t/ADDRESSES.txt"
  printf '  LaunchRegistry        %s\n  LaunchLens            %s\n    CurbLaunchFactory   %s\n    CurbLaunchFactory   %s\n' "$R" "$L" "$F1" "$F2" > "$ADDR_FILE"
  fresh; expect fail "deploy day with config.js as committed (no endpoint, no lens) is refused" "rpc is ''"
  # setcfg <rpc> <lens> <factories> [<registry>]: the registry is the recorded
  # one unless a fourth argument (empty included) names another.
  setcfg() { perl -0777 -pi -e "s|rpc: \"[^\"]*\"|rpc: \"$1\"|; s|lens: \"[^\"]*\"|lens: \"$2\"|; s|registry: \"[^\"]*\"|registry: \"${4-$R}\"|; s|factories: \[[^\]]*\]|factories: [$3]|" "$t/w/config.js"; }
  setcode() { perl -0777 -pi -e "s|const CODE_AT = \"[^\"]*\"|const CODE_AT = \"$1\"|" "$t/w/sharing.js"; }
  local REPO="https://github.com/curb-org/curb/tree/0123456789abcdef0123456789abcdef01234567/services/sharer"
  fresh; setcfg "https://base.example/v1/key" "$L" "\"$F1\", \"0x00000000000000000000000000000000000000cc\""
  expect fail "deploy day with sharing.js's repository as committed (empty) is refused" "CODE_AT is ''"
  setcode "$REPO"
  expect pass "deploy day with the recorded lens and factories, and the repository at a commit, passes"
  setcode "https://github.com/curb-org/curb/tree/main/services/sharer"
  expect fail "a repository address on a branch, not a commit, is refused" "CODE_AT is"
  fresh; setcfg "https://base.example/v1/key" "0x00000000000000000000000000000000000000ab" "\"$F1\", \"$F2\""
  expect fail "a lens that is not the recorded one is refused" "is not the LaunchLens"
  fresh; setcfg "https://base.example/v1/key" "$L" "\"$F1\""
  expect fail "a factory missing from config.js is refused" "factories are not"
  fresh; setcfg "https://base.example/v1/key" "$L" "\"$F1\", \"$F2\"" ""; setcode "$REPO"
  expect fail "config.js with no registry is refused" "registry '' is not the LaunchRegistry"
  fresh; setcfg "https://base.example/v1/key" "$L" "\"$F1\", \"$F2\"" "0x00000000000000000000000000000000000000de"; setcode "$REPO"
  expect fail "a registry that is not the recorded one is refused" "is not the LaunchRegistry"
  fresh; setcfg "http://127.0.0.1:8546" "$L" "\"$F1\", \"$F2\""
  expect fail "a local endpoint on deploy day is refused" "rpc is"
  printf '  LaunchLens            0x............................................\n' > "$ADDR_FILE"
  fresh; setcfg "https://base.example/v1/key" "$L" "\"$F1\", \"$F2\""
  expect fail "an address book not filled in is refused" "records no LaunchLens"
  ADDR_FILE=""

  echo
  echo "$pass of $total selftest cases behaved"
  [ "$pass" = "$total" ]
}

if [ "$SELFTEST" = 1 ]; then
  selftest
  exit $?
fi
check_set "$WEB" "$ADDRESSES"
echo
if [ "$fails" = 0 ]; then echo "publish set ok"; exit 0; fi
echo "$fails problem(s) - fix them before publishing"
exit 1
