# -*- coding: utf-8 -*-
"""
WHAT ONE NAMED SPEC DID IN A PLAYWRIGHT JSON REPORT, SAID EXACTLY.

    python3 script/b20/e2e_report_status.py "<spec title>" <report.json>

It prints ONE word and nothing else:

    passed failed skipped timedOut interrupted
                        the spec's own status, verbatim from the report
    no-result           the spec is in the report with no result at all
    mixed:a+b           it ran more than once and disagreed with itself
    ambiguous           more than one spec carries that title
    missing             no spec carries that title
    unreadable          the report could not be parsed

WHY IT IS ITS OWN FILE AND ITS OWN VOCABULARY.
    The first version of this lived inside the mutation harness and collapsed
    everything that was not "failed" into "passed" as long as SOME result
    existed. A SKIPPED spec has a result, so it read as passed - and in serial
    mode every spec after a failure is skipped. A mutation that broke an
    earlier test would have had its target reported as "passed", which is the
    exact word the control and the reporter's-own-test cases expect. The
    harness would have agreed with itself about nothing.

    Skipping is not passing. A timeout is not passing. Neither is evidence
    that a mutation was caught, and neither is evidence that it was not. They
    are their own answers and the caller has to handle them.
"""
import json
import sys


def status_of(report, want):
    """The status of the one spec titled `want`, or a word saying why not."""
    found = []

    def walk(node):
        for spec in node.get("specs") or []:
            if spec.get("title") == want:
                statuses = []
                for t in spec.get("tests") or []:
                    for r in t.get("results") or []:
                        if r.get("status"):
                            statuses.append(r["status"])
                found.append(statuses)
        for child in node.get("suites") or []:
            walk(child)

    for top in report.get("suites") or []:
        walk(top)

    if not found:
        return "missing"
    if len(found) > 1:
        return "ambiguous"
    statuses = found[0]
    if not statuses:
        return "no-result"
    distinct = sorted(set(statuses))
    if len(distinct) > 1:
        return "mixed:" + "+".join(distinct)
    return distinct[0]


def main(argv):
    if len(argv) != 3:
        print("usage: e2e_report_status.py <spec title> <report.json>", file=sys.stderr)
        return 2
    try:
        with open(argv[2], encoding="utf-8") as f:
            report = json.load(f)
    except Exception:
        print("unreadable")
        return 0
    print(status_of(report, argv[1]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
