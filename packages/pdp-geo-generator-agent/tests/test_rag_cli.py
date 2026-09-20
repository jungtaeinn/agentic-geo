"""Offline utility contracts retained from the package's five Node scripts."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

import pytest
from pytest import CaptureFixture, MonkeyPatch
from test_frozen_legacy_contracts import load_frozen_rag_cli_contract

import pdp_geo_generator_agent.rag.cli as rag_cli
from pdp_geo_generator_agent.rag.cli import eval_main, generate_fallback_main, index_skeleton_main
from pdp_geo_generator_agent.rag.eval import find_pdp_geo_rag_baseline_regressions


def test_index_skeleton_cli_emits_machine_readable_rows(capsys: CaptureFixture[str]) -> None:
    assert index_skeleton_main(["--json"]) == 0
    output = capsys.readouterr().out
    rows = json.loads(output)
    assert rows
    assert {"document", "sections", "unindexedSectionCount"} <= set(rows[0])


def test_generate_fallback_cli_writes_exact_managed_document_mapping(tmp_path: Path) -> None:
    target = tmp_path / "fallback.json"
    assert generate_fallback_main(["--out", str(target)]) == 0
    payload = json.loads(target.read_text(encoding="utf-8"))
    assert payload["analysisPrompt"]
    assert "schema-org-product_v2.md" in payload["documents"]


def test_rag_eval_cli_runs_frozen_retrieval_goldens_and_writes_ts_shape(
    capsys: CaptureFixture[str], tmp_path: Path
) -> None:
    """The CLI is the retained golden/baseline benchmark, not an index-coverage proxy."""

    target = tmp_path / "baseline.json"
    assert eval_main(["--json", "--write", "--out", str(target)]) == 0
    payload: dict[str, Any] = json.loads(capsys.readouterr().out)

    assert payload["status"] == "ok"
    assert payload["aggregates"]["goldens"] == 24
    assert payload["baseline"]["goldens"] == 24
    assert set(payload["deltaVsBaseline"]) == {
        "claimRecall",
        "contextPrecision",
        "classification",
        "noiseChunkRate",
        "byTarget",
    }
    assert len(payload["scores"]) == 24
    assert {"ARC-FAQ", "CVM-WDESC"} <= {score["goldenId"] for score in payload["scores"]}
    assert find_pdp_geo_rag_baseline_regressions(payload["aggregates"], payload["baseline"]) == []
    assert json.loads(target.read_text(encoding="utf-8")) == {
        "generatedAt": payload["generatedAt"],
        "aggregates": payload["aggregates"],
    }


def test_rag_eval_cli_default_write_uses_caller_owned_state_directory(
    capsys: CaptureFixture[str], monkeypatch: MonkeyPatch, tmp_path: Path
) -> None:
    """The wheel's RAG resources are read-only; a default write belongs to its caller."""

    monkeypatch.chdir(tmp_path)
    assert eval_main(["--json", "--write"]) == 0
    assert (tmp_path / ".pdp-geo-generator-rag" / "baseline.json").is_file()
    machine_output = capsys.readouterr().out
    assert "evals/baseline.json" not in machine_output

    assert eval_main(["--write"]) == 0
    human_output = capsys.readouterr().out
    assert human_output.startswith("Per-golden scores:\n")
    assert "Baseline: .pdp-geo-generator-rag/baseline.json (generated 2026-09-20)" in human_output
    assert human_output.endswith("Baseline written to .pdp-geo-generator-rag/baseline.json\n")
    assert "evals/baseline.json" not in human_output


def test_rag_eval_cli_human_wire_matches_legacy_except_intentional_caller_owned_path(
    capsys: CaptureFixture[str], monkeypatch: MonkeyPatch, tmp_path: Path
) -> None:
    """Freeze every readable-report byte, with only the approved baseline relocation changed."""

    fixture = load_frozen_rag_cli_contract()
    human = fixture["humanContract"]
    assert hashlib.sha256(json.dumps(human["args"], ensure_ascii=False, separators=(",", ":")).encode()).hexdigest() == human[
        "inputSha256"
    ]
    assert eval_main([]) == 0
    assert hashlib.sha256(capsys.readouterr().out.encode()).hexdigest() == human["callerOwnedOutputSha256"]

    monkeypatch.chdir(tmp_path)
    write = fixture["humanWriteContract"]
    assert hashlib.sha256(json.dumps(write["args"], ensure_ascii=False, separators=(",", ":")).encode()).hexdigest() == write[
        "inputSha256"
    ]
    assert eval_main(["--write"]) == 0
    assert hashlib.sha256(capsys.readouterr().out.encode()).hexdigest() == write["callerOwnedOutputSha256"]
    assert (tmp_path / ".pdp-geo-generator-rag" / "baseline.json").is_file()


def test_rag_eval_cli_reports_before_a_write_failure(capsys: CaptureFixture[str], tmp_path: Path) -> None:
    """Legacy stdout is complete before its trailing baseline persistence attempt fails."""

    target = tmp_path / "existing-directory"
    target.mkdir()

    with pytest.raises(IsADirectoryError):
        eval_main(["--write", "--out", str(target)])

    output = capsys.readouterr().out
    assert output.startswith("Per-golden scores:\n")
    assert "Baseline written to" not in output
    assert "Baseline:" in output


def test_rag_eval_human_score_fields_use_javascript_to_fixed_ties_and_signed_zero(
    capsys: CaptureFixture[str],
) -> None:
    """The deleted CLI prints score fields through ``Number.prototype.toFixed(2)``."""

    printer = getattr(rag_cli, "_print_rag_eval_report")
    printer(
        [
            {
                "goldenId": "tie",
                "target": "faq",
                "claimRecall": 0.125,
                "classification": {"precision": -0.125, "recall": -0.0, "accuracy": 0.125, "tp": 1, "fp": 2, "fn": 3, "tn": 4},
                "noiseChunkRate": -0.0,
                "retrievedCount": 5,
                "missedAnchors": [],
            }
        ],
        {},
        {},
        {},
        ".pdp-geo-generator-rag/baseline.json",
    )

    score_line = capsys.readouterr().out.splitlines()[1]
    assert (
        score_line
        == "  tie                target=faq                claimR=0.13 clsP=-0.13 clsR=0.00 acc=0.13 "
        "cm=1/2/3/4 noise=0.00 selected=5 *"
    )


def test_rag_eval_cli_json_wire_matches_the_frozen_typescript_contract(capsys: CaptureFixture[str]) -> None:
    """Keep the deletion-time Node JSON order and number spelling contract."""

    fixture = load_frozen_rag_cli_contract()
    contract = fixture["contract"]
    args = contract["args"]
    assert hashlib.sha256(json.dumps(args, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest() == contract[
        "inputSha256"
    ]
    assert eval_main(args) == 0
    raw_wire = capsys.readouterr().out
    payload = json.loads(raw_wire)
    normalised_wire = re.sub(
        r'("generatedAt": )"\d{4}-\d{2}-\d{2}"', r'\1"<normalized-current-date>"', raw_wire, count=1
    )

    assert list(payload) == contract["topLevelKeys"]
    assert len(payload["scores"]) == contract["scoreCount"]
    assert payload["baselineGeneratedAt"] == contract["baselineGeneratedAt"]
    assert hashlib.sha256(normalised_wire.encode()).hexdigest() == contract["normalizedOutputSha256"]


def test_rag_eval_cli_fails_nonzero_for_unresolvable_frozen_anchor(
    capsys: CaptureFixture[str], monkeypatch: MonkeyPatch
) -> None:
    """Broken frozen anchors are source-data errors, never silent recall loss."""

    async def broken_eval() -> dict[str, object]:
        return {"scores": [], "aggregates": {}, "unresolvableAnchors": ["ARC-FAQ: missing document gone.md"]}

    monkeypatch.setattr(rag_cli, "run_pdp_geo_rag_eval", broken_eval, raising=False)
    assert eval_main(["--json"]) == 1
    assert json.loads(capsys.readouterr().out) == {
        "status": "error",
        "unresolvableAnchors": ["ARC-FAQ: missing document gone.md"],
    }
