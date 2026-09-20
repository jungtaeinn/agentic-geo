"""Behavior tests for the installable, injection-based benchmark command."""

from __future__ import annotations

import io
import json
import tomllib
from collections.abc import Mapping
from pathlib import Path

import pytest

from pdp_geo_eval_agent.benchmark import cli as benchmark_cli


def test_project_registers_an_installable_geo_benchmark_command() -> None:
    pyproject = tomllib.loads((Path(__file__).parents[1] / "pyproject.toml").read_text())

    assert pyproject["project"]["scripts"]["pdp-geo-eval-benchmark"] == "pdp_geo_eval_agent.benchmark.cli:main"
    assert "neo-js-compat>=0.1.0" in pyproject["project"]["dependencies"]
    assert pyproject["tool"]["uv"]["sources"]["neo-js-compat"] == {"workspace": True}


def test_benchmark_cli_requires_the_same_provider_surface_before_running() -> None:
    cli = benchmark_cli
    stdout = io.StringIO()
    stderr = io.StringIO()

    code = cli.main([], environ={}, stdout=stdout, stderr=stderr)

    assert code == 1
    assert stdout.getvalue() == ""
    assert stderr.getvalue() == "Missing --provider (openai | gemini | azure-openai | aistudio). See packages/pdp-geo-eval-agent.\n"


def test_json_cli_forwards_ts_flags_and_environment_and_preserves_baseline_wire(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cli = benchmark_cli
    artifacts_path = tmp_path / "artifacts.json"
    artifacts: dict[str, object] = {"byeolmorae-waterfold-toner": {"publicText": "generated", "evidenceLedger": []}}
    artifacts_path.write_text(json.dumps(artifacts))
    baseline_path = tmp_path / "geo-benchmark-baseline.json"
    baseline = {
        "generatedAt": "2026-09-01",
        "engineId": "openai:cli-model",
        "aggregates": {
            "delta": {"wordpos": 0.1, "word": 0.1, "pos": 0.1},
            "generated": {"wordpos": 0.2, "word": 0.2, "pos": 0.2},
        },
    }
    baseline_path.write_text(json.dumps(baseline))
    observed: dict[str, object] = {}
    result: dict[str, object] = {
        "engineId": "openai:cli-model",
        "aggregates": {
            "delta": {"wordpos": 0.3, "word": 0.3, "pos": 0.3},
            "generated": {"wordpos": 0.4, "word": 0.4, "pos": 0.4},
        },
        "scores": [{"goldenId": "WFT-NEED"}],
    }

    async def fake_run(options: Mapping[str, object]) -> dict[str, object]:
        observed.update(options)
        return result

    monkeypatch.setattr(cli, "run_geo_benchmark", fake_run)
    stdout = io.StringIO()
    stderr = io.StringIO()

    code = cli.main(
        [
            "--provider", "openai", "--model", "cli-model", "--json", "--utility", "--no-cache",
            "--golden", "WFT-NEED, CVM-ROUTINE", "--artifacts", str(artifacts_path),
            "--baseline", str(baseline_path), "--write",
        ],
        environ={"OPENAI_API_KEY": "key"},
        stdout=stdout,
        stderr=stderr,
    )

    assert code == 0
    assert stderr.getvalue() == ""
    assert observed == {
        "engine": {"provider": "openai", "apiKey": "key", "model": "cli-model", "temperature": 0.5},
        "artifacts": artifacts,
        "includeUtility": True,
        "goldenIds": ["WFT-NEED", "CVM-ROUTINE"],
        "useCache": False,
    }
    output = json.loads(stdout.getvalue())
    assert list(output) == [
        "status", "engineId", "aggregates", "baseline", "baselineEngineId",
        "baselineGeneratedAt", "deltaVsBaseline", "scores",
    ]
    assert output == {
        "status": "ok",
        "engineId": "openai:cli-model",
        "aggregates": result["aggregates"],
        "baseline": baseline["aggregates"],
        "baselineEngineId": "openai:cli-model",
        "baselineGeneratedAt": "2026-09-01",
        "deltaVsBaseline": {"deltaWordpos": 0.2, "generatedWordpos": 0.2},
        "scores": result["scores"],
    }
    written = json.loads(baseline_path.read_text())
    assert written["engineId"] == "openai:cli-model"
    assert written["aggregates"] == result["aggregates"]
    assert len(written["generatedAt"]) == 10
