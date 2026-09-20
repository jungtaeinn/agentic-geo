"""Regression guard for the Task 4 canonical Python test command."""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path


def test_plan_path_collects_the_package_python_suite() -> None:
    """The documented ``.../tests`` path must never silently collect zero tests."""

    test_root = Path(__file__).resolve().parent
    repository_root = test_root.parents[2]
    completed = subprocess.run(
        [sys.executable, "-m", "pytest", str(test_root), "--collect-only", "-q"],
        cwd=repository_root,
        check=False,
        capture_output=True,
        text=True,
    )
    output = completed.stdout + completed.stderr
    match = re.search(r"(\d+) tests collected", output)
    assert completed.returncode == 0, output
    assert match is not None, output
    # This is deliberately a floor rather than a brittle exact total: future
    # source-backed ports may add tests, but the plan path must retain the full
    # substantive suite rather than one accidental smoke test.
    assert int(match.group(1)) >= 100
