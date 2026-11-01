#!/usr/bin/env python3
"""Run unittest tests and print one JSON summary line at the end of stdout.

Usage:
  unittest_json.py bowling_test.py            run the tests in one file
  unittest_json.py tests/hidden               discover test*.py in a folder
  unittest_json.py a_test.py tests/hidden     several targets

The current folder is put first on sys.path so the code under test imports.
Standard library only. Exit code 0 when every test passed, 1 otherwise,
2 when a target could not be loaded.
"""

import importlib.util
import io
import json
import os
import sys
import traceback
import unittest


def load_file(path, loader):
    name = os.path.splitext(os.path.basename(path))[0]
    folder = os.path.dirname(os.path.abspath(path))
    if folder not in sys.path:
        sys.path.insert(1, folder)
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return loader.loadTestsFromModule(module)


class Recorder(unittest.TextTestResult):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.records = []

    def addSuccess(self, test):
        super().addSuccess(test)
        self.records.append({"id": test.id(), "outcome": "passed"})

    def addFailure(self, test, err):
        super().addFailure(test, err)
        self.records.append({"id": test.id(), "outcome": "failed"})

    def addError(self, test, err):
        super().addError(test, err)
        self.records.append({"id": test.id(), "outcome": "errored"})

    def addSkip(self, test, reason):
        super().addSkip(test, reason)
        self.records.append({"id": test.id(), "outcome": "skipped"})

    def addExpectedFailure(self, test, err):
        super().addExpectedFailure(test, err)
        self.records.append({"id": test.id(), "outcome": "passed"})

    def addUnexpectedSuccess(self, test):
        super().addUnexpectedSuccess(test)
        self.records.append({"id": test.id(), "outcome": "failed"})

    def addSubTest(self, test, subtest, err):
        super().addSubTest(test, subtest, err)
        if err is not None:
            failed = issubclass(err[0], test.failureException)
            self.records.append({"id": subtest.id(), "outcome": "failed" if failed else "errored", "subtest": True})


def main(argv):
    targets = argv or ["."]
    cwd = os.getcwd()
    if cwd not in sys.path:
        sys.path.insert(0, cwd)
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()
    load_errors = []
    for target in targets:
        try:
            if os.path.isdir(target):
                suite.addTests(loader.discover(target, pattern="test*.py", top_level_dir=target))
            else:
                suite.addTests(load_file(target, loader))
        except Exception:
            load_errors.append({"target": target, "error": traceback.format_exc(limit=5)})
    for err in getattr(loader, "errors", []):
        load_errors.append({"target": "discover", "error": err})

    stream = io.StringIO()
    runner = unittest.TextTestRunner(stream=stream, verbosity=2, resultclass=Recorder)
    result = runner.run(suite)
    sys.stderr.write(stream.getvalue())
    for e in load_errors:
        sys.stderr.write(f"\nLOAD ERROR in {e['target']}:\n{e['error']}\n")

    records = result.records
    # a test whose subtests failed counts once, as failed
    failed_ids = {r["id"].split(" (")[0] for r in records if r.get("subtest")}
    final = {}
    for r in records:
        key = r["id"] if not r.get("subtest") else r["id"].split(" (")[0]
        if r.get("subtest"):
            final[key] = r["outcome"]
        elif key in failed_ids and r["outcome"] == "passed":
            continue
        else:
            final.setdefault(key, r["outcome"])
    counts = {"passed": 0, "failed": 0, "errored": 0, "skipped": 0}
    for outcome in final.values():
        counts[outcome] += 1
    summary = dict(counts)
    summary["total"] = counts["passed"] + counts["failed"] + counts["errored"]
    summary["load_errors"] = len(load_errors)
    summary["failing"] = sorted(k for k, v in final.items() if v in ("failed", "errored"))[:200]
    sys.stdout.write("\n" + json.dumps({"unittest_json": summary}) + "\n")
    sys.stdout.flush()
    if load_errors:
        return 2
    return 0 if counts["failed"] == 0 and counts["errored"] == 0 and summary["total"] > 0 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
