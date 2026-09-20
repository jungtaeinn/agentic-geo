"""Public benchmark-report regressions for JavaScript ``toFixed(3)`` output."""

from __future__ import annotations

import io
import json
import math
from collections.abc import Mapping
from pathlib import Path

import pytest

from pdp_geo_eval_agent.benchmark import cli


def test_human_benchmark_report_uses_javascript_to_fixed_for_visible_shares_and_deltas(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Python's banker's formatting and non-finite spellings would alter the public benchmark report."""
    artifacts_path = tmp_path / "artifacts.json"
    artifacts_path.write_text(json.dumps({"byeolmorae-waterfold-toner": {"publicText": "generated", "evidenceLedger": []}}))
    result: dict[str, object] = {
        "engineId": "openai:human",
        "scores": [
            {
                "goldenId": "TIE-POS",
                "cepFocus": "need",
                "vanilla": {"wordpos": 0.0625, "cachedAnswer": False, "hallucinatedCitations": []},
                "generated": {"wordpos": -0.0625, "cachedAnswer": False, "hallucinatedCitations": []},
                "delta": {"wordpos": 0.0625},
                "gate": {"pass": True, "failures": []},
            },
            {
                "goldenId": "SMALL-NEG",
                "cepFocus": "routine",
                "vanilla": {"wordpos": -0.0625, "cachedAnswer": False, "hallucinatedCitations": []},
                "generated": {"wordpos": 0.0625, "cachedAnswer": False, "hallucinatedCitations": []},
                "delta": {"wordpos": -0.0001},
                "gate": {"pass": True, "failures": []},
            },
        ],
        "aggregates": {
            "vanilla": {"wordpos": 0.0625, "word": -0.0625, "pos": -0.0001},
            "generated": {"wordpos": -0.0625, "word": 0.0625, "pos": 0.0001},
            "delta": {"wordpos": math.nan, "word": math.inf, "pos": -math.inf},
            "gate": {"passed": 2, "evaluated": 2},
            "byLocale": {
                "large": {
                    "delta": {"wordpos": 1e21},
                    "vanilla": {"wordpos": 1e21},
                    "generated": {"wordpos": -1e21},
                    "goldens": 1,
                }
            },
            "byCepFocus": {"large-negative": {"delta": {"wordpos": -1e21}, "goldens": 1}},
        },
    }

    async def fake_run(_options: Mapping[str, object]) -> dict[str, object]:
        return result

    monkeypatch.setattr(cli, "run_geo_benchmark", fake_run)
    stdout = io.StringIO()
    stderr = io.StringIO()

    code = cli.main(
        ["--provider", "openai", "--model", "human", "--artifacts", str(artifacts_path)],
        environ={"OPENAI_API_KEY": "secret"},
        stdout=stdout,
        stderr=stderr,
    )

    assert code == 0
    assert stderr.getvalue() == ""
    assert stdout.getvalue() == (
        "Engine: openai:human\n\n"
        "Per-golden citation share (wordpos, vanilla → generated):\n"
        "  TIE-POS        need       0.063 → -0.063  Δ=+0.063\n"
        "  SMALL-NEG      routine    -0.063 → 0.063  Δ=-0.000\n"
        "\nAggregates (mean share-of-voice across goldens):\n"
        "  vanilla    wordpos=0.0625 word=-0.0625 pos=-0.0001\n"
        "  generated  wordpos=-0.0625 word=0.0625 pos=0.0001\n"
        "  delta      wordpos=NaN word=+Infinity pos=-Infinity\n"
        "  gate       2/2 passed\n"
        "  by locale:\n"
        "    large    Δwordpos=+1e+21 (vanilla 1e+21 → -1e+21, n=1)\n"
        "  by CEP focus:\n"
        "    large-negative Δwordpos=-1e+21 (n=1)\n"
        "\nNo committed baseline found. Run with --write to create one.\n"
    )
