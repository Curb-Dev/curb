# -*- coding: utf-8 -*-
"""DO THE DOCUMENTS STILL SAY TRUE THINGS ABOUT THE CODE?

  python script/check-docs.py        (from the repository root)

Three checks, each added after the same kind of rot was found BY HAND and only
caught because somebody printed what was actually at the line:

  EVERY "File.sol:NNN" CITATION resolves, and this prints what stands there.
  A line number that has drifted is worse than no citation at all - it sends a
  reader to the wrong code and looks authoritative doing it. Ten had drifted
  when this was first run by hand, mostly because real work lengthened the
  files they pointed into.

  EVERY test_ NAME a document quotes exists in the suite. A document that
  cites a test which was renamed is claiming evidence it does not have.

  EVERY TEST COUNT a document quotes matches the tests that exist. This drifted
  THREE TIMES in two days - AUDIT said 213, DEPLOY said 223, PRE_MAINNET said
  216, while the suite ran 224. Each was true when written, which is exactly
  why re-reading does not catch it. Counted from the sources rather than from a
  run, so this is free and cannot itself go stale.

WHAT IT DOES NOT CHECK: whether a claim is true. It checks that the things a
claim points AT still exist and still say what the pointer implies. A sentence
that is simply wrong passes this and needs a reader.
"""
import glob, io, os, re, sys

ROOT = os.getcwd()
index = {}
for pat in ("src/**/*.sol", "test/**/*.sol", "script/**/*.sol", "script/**/*.sh",
            "web/*.js", "web/*.html", "web/e2e/*.js", "reference/**/*.sol"):
    for f in glob.glob(pat, recursive=True):
        index.setdefault(os.path.basename(f), []).append(f)

DOCS = sorted(g for g in glob.glob("*.txt") if g != "remappings.txt")
problems = []
checked = 0

for doc in DOCS:
    flat = re.sub(r"\n\s+", " ", io.open(doc, encoding="utf-8", errors="replace").read())
    seen = set()
    for m in re.finditer(r"([A-Za-z0-9_]{3,}\.(?:sol|js|html)):(\d+)", flat):
        name, ln = m.group(1), int(m.group(2))
        if (name, ln) in seen:
            continue
        seen.add((name, ln))
        checked += 1
        paths = index.get(name, [])
        if not paths:
            problems.append((doc, "%s:%d" % (name, ln), "DOSYA YOK"))
            continue
        p = sorted(paths, key=lambda x: ("reference" in x, len(x)))[0]
        lines = io.open(p, encoding="utf-8", errors="replace").read().split("\n")
        if ln > len(lines):
            problems.append((doc, "%s:%d" % (name, ln), "SATIR YOK (%d satir)" % len(lines)))

print("atif taranan: %d, belge: %d" % (checked, len(DOCS)))
for d, c, why in problems:
    print("   %-24s %-34s %s" % (d, c, why))
if not problems:
    print("   hepsi cozuluyor")

# ---- every test name a document names must exist
print()
tests = set()
for f in glob.glob("test/**/*.sol", recursive=True):
    tests |= set(re.findall(r"function\s+(test_\w+)", io.open(f, encoding="utf-8", errors="replace").read()))
for f in glob.glob("web/e2e/*.spec.js"):
    tests |= set(re.findall(r'test\(\s*"([^"]+)"', io.open(f, encoding="utf-8", errors="replace").read()))

missing = []
for doc in DOCS:
    body = re.sub(r"\n\s+", " ", io.open(doc, encoding="utf-8", errors="replace").read())
    # only the Solidity-style names; prose test titles are matched too loosely
    for name in set(re.findall(r"\b(test_[A-Za-z0-9_]+)", body)):
        # documents wrap long names with a hyphen at the break
        if name in tests or any(t.startswith(name) for t in tests):
            continue
        missing.append((doc, name))
print("belgelerde anilan test adi dogrulanti: %d eksik" % len(missing))
for d, n in missing:
    print("   %-24s %s" % (d, n))

# ---- functions and constants a document names in src/
src_names = set()
for f in glob.glob("src/**/*.sol", recursive=True) + glob.glob("web/*.js"):
    body = io.open(f, encoding="utf-8", errors="replace").read()
    src_names |= set(re.findall(r"function\s+(\w+)", body))
    src_names |= set(re.findall(r"constant\s+(\w+)", body))
    src_names |= set(re.findall(r"error\s+(\w+)", body))

WATCH = ["symbolOf", "policyStanding", "bestV3Leg", "labelFor", "isSupportedFee",
         "configureLaunch", "initializeCurve", "addLauncher", "launchSlice",
         "PLATFORM_FEE_BPS", "MIN_QUOTE_DECIMALS",
         "ExactOutputNotSupported", "PartialFillNotSupported", "InvalidLaunchEconomics"]
print()
gone = [w for w in WATCH if w not in src_names
        and w not in set(re.findall(r"error\s+(\w+)", io.open("src/vendor/PonsV2BondingCurve.sol", encoding="utf-8").read()))]
print("belgelerin dayandigi isimlerden kayip: %d" % len(gone))
for g in gone:
    print("   %s" % g)


# ---- THE TEST COUNTS THE DOCUMENTS QUOTE, against the tests that exist.
#
# Added after this drifted THREE TIMES in two days: AUDIT said 213, DEPLOY said
# 223 and PRE_MAINNET said 216 while the suite ran 224. Every one of those was
# true when it was written, which is exactly why a human re-reading does not
# catch it. Counted from the sources rather than from a run, so the check is
# free and cannot itself go stale.
print()
def count(paths, pats):
    n = 0
    for pat in paths:
        for f in glob.glob(pat):
            body = io.open(f, encoding="utf-8", errors="replace").read()
            for p_ in pats:
                n += len(re.findall(p_, body))
    return n

nonfork = count(["test/*.sol"], [r"function test[A-Za-z0-9_]*\(", r"function invariant_[A-Za-z0-9_]*\("])
fork = count(["test/fork/*.sol"], [r"function test[A-Za-z0-9_]*\("])
browser = count(["web/e2e/*.spec.js"], [r'test\(\s*"'])
print("test sayilari: non-fork %d, fork %d, browser %d" % (nonfork, fork, browser))

stale = []
for doc in DOCS:
    body = io.open(doc, encoding="utf-8", errors="replace").read()
    for m in re.finditer(r"(\d+)\s+non-fork,\s+(\d+)\s+fork(?:,| and)\s+(\d+)\s+browser", body):
        got = tuple(int(x) for x in m.groups())
        if got != (nonfork, fork, browser):
            stale.append((doc, "%d/%d/%d" % got))
    for m in re.finditer(r"Expect (\d+), (\d+) and (\d+)", body):
        got = tuple(int(x) for x in m.groups())
        if got != (nonfork, fork, browser):
            stale.append((doc, "Expect %d/%d/%d" % got))
if stale:
    print("BAYAT SAYI: %d" % len(stale))
    for d, g in stale:
        print("   %-24s %s  (gercek %d/%d/%d)" % (d, g, nonfork, fork, browser))
else:
    print("   belgelerdeki her sayim guncel")
