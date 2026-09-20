"""Regression coverage for structured console quality-gate failures."""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from neo_agent_api.api import console as console_api
from neo_agent_api.services import console_orchestration

_DiagnosticsFixture = dict[str, object]


_SAFE_GATE_DIAGNOSTICS: _DiagnosticsFixture = {
    "process": [
        {"id": "input", "status": "done"},
        {"id": "quality-gate", "status": "error"},
    ],
    "qualityGate": {
        "attempted": True,
        "adopted": False,
        "reason": "Quality gate blocked final artifact after corrective refinement.",
        "shortfalls": ["2 unresolved public-copy provenance warning(s)"],
        "blockingShortfalls": ["2 unresolved public-copy provenance warning(s)"],
        "scores": {"initial": {"overall": 80, "geo": 80, "cep": 100, "eeat": 100}},
    },
    "validationFindings": [
        {
            "field": "Product.description",
            "source": "public-copy-provenance",
            "reason": "Final public-copy provenance binding is missing.",
        }
    ],
    "finalPublicCopyProvenance": {"count": 0, "fieldPaths": []},
    "runtimeStages": {"copyRefinement": {"called": True, "applied": False}},
    "apiKey": "must-not-escape",
    "endpoint": "https://private.example.test/must-not-escape",
    "prompt": "must-not-escape",
}


class _QualityGateBlocked(RuntimeError):
    def __init__(self) -> None:
        super().__init__("Quality gate blocked final artifact after corrective refinement.")
        self.diagnostics = _SAFE_GATE_DIAGNOSTICS


async def _raise_quality_gate_block(*_args: object, **_kwargs: object) -> dict[str, Any]:
    raise _QualityGateBlocked()


@pytest.mark.asyncio
async def test_run_generate_preserves_safe_gate_diagnostics_for_manual_products(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(console_orchestration, "generate_pdp_geo", _raise_quality_gate_block)

    payload = await console_orchestration.run_generate(
        {"product": {"name": "Barrier Serum"}}, runtime={"provider": "mock"}
    )

    failure = payload["failures"][0]
    diagnostics = failure["diagnostics"]
    assert failure["error"] == "Quality gate blocked final artifact after corrective refinement."
    assert diagnostics["qualityGate"]["attempted"] is True
    assert diagnostics["qualityGate"]["adopted"] is False
    assert diagnostics["validationFindings"] == [
        {
            "field": "Product.description",
            "source": "public-copy-provenance",
            "reason": "Final public-copy provenance binding is missing.",
        }
    ]
    assert diagnostics["process"][-1] == {"id": "quality-gate", "status": "error"}
    assert "apiKey" not in diagnostics
    assert "endpoint" not in diagnostics
    assert "prompt" not in diagnostics


@pytest.mark.asyncio
async def test_run_generate_keeps_extractor_process_and_safe_summary_when_generator_blocks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def extracted(*_args: object, **_kwargs: object) -> SimpleNamespace:
        return SimpleNamespace(
            result={"geoProduct": {"name": "Barrier Serum"}},
            diagnostics={
                "process": [
                    {"id": "input", "status": "done", "message": "Do not expose source body."},
                    {
                        "id": "ocr",
                        "status": "done",
                        "metrics": {"ocrImageCandidateCount": 17, "privateTextLength": 999},
                    },
                    {"id": "review", "status": "done", "metrics": {"reviewItemCount": 0}},
                    {"id": "rag", "status": "done", "metrics": {"ragChunkCount": 62}},
                    {"id": "json", "status": "done"},
                ],
                "warnings": [{"code": "PARTIAL", "message": "Do not expose raw warning."}],
                "evidence": [{"value": "Do not expose raw evidence."}],
                "runtimeUsage": {
                    "steps": [
                        {"stage": "fetch", "called": True, "endpoint": "https://private.example.test"},
                    ]
                },
            },
        )

    monkeypatch.setattr(console_orchestration, "extract_product", extracted)
    monkeypatch.setattr(console_orchestration, "generate_pdp_geo", _raise_quality_gate_block)

    payload = await console_orchestration.run_generate(
        {"sources": ["https://example.test/pdp"]}, runtime={"provider": "mock"}
    )

    diagnostics = payload["failures"][0]["diagnostics"]
    assert diagnostics["qualityGate"]["blockingShortfalls"]
    assert diagnostics["extractor"] == {
        "process": [
            {"id": "input", "status": "done"},
            {"id": "ocr", "status": "done", "metrics": {"ocrImageCandidateCount": 17}},
            {"id": "review", "status": "done", "metrics": {"reviewItemCount": 0}},
            {"id": "rag", "status": "done", "metrics": {"ragChunkCount": 62}},
            {"id": "json", "status": "done"},
        ],
        "diagnostics": {
            "warningCount": 1,
            "evidenceCount": 1,
            "runtimeStages": [{"stage": "fetch", "called": True}],
        },
    }
    assert "private.example.test" not in json.dumps(diagnostics)


@pytest.mark.asyncio
async def test_generate_json_and_ndjson_return_terminal_failure_diagnostics(
    monkeypatch: pytest.MonkeyPatch,
    app_factory: Any,
) -> None:
    safe_diagnostics: _DiagnosticsFixture = {
        key: value for key, value in _SAFE_GATE_DIAGNOSTICS.items() if key not in {"apiKey", "endpoint", "prompt"}
    }
    terminal_payload: dict[str, object] = {
        "results": [],
        "logs": [],
        "failures": [
            {
                "source": "manual-json-1",
                "sourceType": "manual-json",
                "error": "Quality gate blocked final artifact after corrective refinement.",
                "diagnostics": safe_diagnostics,
            }
        ],
    }

    async def failed_run(*_args: object, **_kwargs: object) -> dict[str, Any]:
        return terminal_payload

    monkeypatch.setattr(console_api, "run_generate", failed_run)
    app = app_factory()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
        json_response = await client.post("/generate", json={"product": {"name": "Barrier Serum"}})
        stream_response = await client.post("/generate", json={"stream": True, "product": {"name": "Barrier Serum"}})

    assert json_response.status_code == 207
    assert json_response.json() == terminal_payload
    events = [json.loads(line) for line in stream_response.text.splitlines()]
    assert stream_response.status_code == 200
    assert events == [{"type": "result", "payload": terminal_payload}]
