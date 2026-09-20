"""Regression coverage for source-isolated console generation failures."""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from types import SimpleNamespace
from typing import cast

import pytest
from neo_agent_api.services import console_orchestration

type _AsyncProgressEmitter = Callable[[dict[str, object]], Awaitable[None]]


def _required_async_progress_emitter(options: object) -> _AsyncProgressEmitter:
    """Narrow the console's dynamic options payload for a progress-aware double."""

    if not isinstance(options, dict):
        raise AssertionError("Expected generator/extractor options to be an object")
    raw_options = cast(dict[str, object], options)
    candidate = raw_options.get("onProgress")
    if not callable(candidate):
        raise AssertionError("Expected generator/extractor options to include an async onProgress callback")
    return cast(_AsyncProgressEmitter, candidate)


async def _raise_empty_exception(*_args: object, **_kwargs: object) -> None:
    raise TimeoutError()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("body", "dependency", "expected_failure"),
    [
        (
            {"product": {"name": "Serum"}},
            "generate_pdp_geo",
            {
                "source": "manual-json-1",
                "sourceType": "manual-json",
                "error": "GEO generation failed (TimeoutError).",
            },
        ),
        (
            {"sources": ["https://example.com/product"]},
            "extract_product",
            {
                "source": "https://example.com/product",
                "sourceType": "url",
                "error": "PDP GEO orchestration failed (TimeoutError).",
            },
        ),
    ],
)
async def test_run_generate_identifies_empty_manual_and_source_failures(
    monkeypatch: pytest.MonkeyPatch,
    body: dict[str, object],
    dependency: str,
    expected_failure: dict[str, str],
) -> None:
    """A blank provider exception must retain a safe, actionable stage identity."""

    monkeypatch.setattr(console_orchestration, dependency, _raise_empty_exception)

    result = await console_orchestration.run_generate(body, runtime={"provider": "mock"})

    assert result == {"results": [], "logs": [], "failures": [expected_failure]}


async def _raise_descriptive_exception(*_args: object, **_kwargs: object) -> None:
    raise RuntimeError("upstream model rejected the request")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("body", "dependency"),
    [
        ({"product": {"name": "Serum"}}, "generate_pdp_geo"),
        ({"sources": ["https://example.com/product"]}, "extract_product"),
    ],
)
async def test_run_generate_preserves_nonempty_manual_and_source_failure_messages(
    monkeypatch: pytest.MonkeyPatch,
    body: dict[str, object],
    dependency: str,
) -> None:
    """The safe fallback must not replace useful dependency diagnostics."""

    monkeypatch.setattr(console_orchestration, dependency, _raise_descriptive_exception)

    result = await console_orchestration.run_generate(body, runtime={"provider": "mock"})

    assert result["failures"][0]["error"] == "upstream model rejected the request"


async def _completed_extractor(*_args: object, **_kwargs: object) -> SimpleNamespace:
    return SimpleNamespace(
        result={"geoProduct": {"name": "Barrier Serum"}},
        diagnostics={
            "process": [
                {"id": "input", "status": "done", "message": "Do not expose source text."},
                {"id": "ocr", "status": "done", "metrics": {"ocrImageCandidateCount": 3}},
                {"id": "review", "status": "done", "metrics": {"reviewItemCount": 1}},
            ],
            "warnings": [{"message": "Do not expose raw warning."}],
            "evidence": [{"value": "Do not expose raw evidence."}],
            "runtimeUsage": {
                "steps": [
                    {"stage": "ocr", "called": True, "endpoint": "https://private.example.test"},
                    {"stage": "apiKey-must-not-escape", "called": True},
                ]
            },
        },
    )


async def _raise_transport_timeout(*_args: object, **_kwargs: object) -> None:
    raise TimeoutError()


@pytest.mark.asyncio
async def test_run_generate_keeps_safe_extractor_execution_evidence_for_transport_failure_after_extraction(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A generator transport error must not erase completed extractor diagnostics."""

    monkeypatch.setattr(console_orchestration, "extract_product", _completed_extractor)
    monkeypatch.setattr(console_orchestration, "generate_pdp_geo", _raise_transport_timeout)

    payload = await console_orchestration.run_generate(
        {"sources": ["https://example.test/pdp"]}, runtime={"provider": "mock"}
    )

    failure = payload["failures"][0]
    assert failure["error"] == "PDP GEO orchestration failed (TimeoutError)."
    assert failure["diagnostics"] == {
        "process": [{"id": "generator", "status": "error"}],
        "runtimeStages": {},
        "extractor": {
            "process": [
                {"id": "input", "status": "done"},
                {"id": "ocr", "status": "done", "metrics": {"ocrImageCandidateCount": 3}},
                {"id": "review", "status": "done", "metrics": {"reviewItemCount": 1}},
            ],
            "diagnostics": {
                "warningCount": 1,
                "evidenceCount": 1,
                "runtimeStages": [{"stage": "ocr", "called": True}],
            },
        },
    }


class _GeneratorProviderFailure(RuntimeError):
    def __init__(self) -> None:
        super().__init__("upstream provider rejected the request")
        self.diagnostics = {
            "process": [
                {"id": "https://private.example.test?apiKey=must-not-escape", "status": "error"},
                {"id": "generate", "status": "running", "message": "Do not expose prompt text."},
            ],
            "runtimeStages": {
                "productNormalization": {
                    "called": True,
                    "applied": False,
                    "endpoint": "https://private.example.test",
                    "apiKey": "must-not-escape",
                },
                "copyRefinement": {"called": True, "applied": False, "prompt": "must-not-escape"},
            },
        }


async def _raise_provider_failure(*_args: object, **_kwargs: object) -> None:
    raise _GeneratorProviderFailure()


@pytest.mark.asyncio
async def test_run_generate_sanitizes_non_quality_provider_runtime_diagnostics(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A generic provider failure preserves only known stage state and runtime flags."""

    monkeypatch.setattr(console_orchestration, "extract_product", _completed_extractor)
    monkeypatch.setattr(console_orchestration, "generate_pdp_geo", _raise_provider_failure)

    payload = await console_orchestration.run_generate(
        {"sources": ["https://example.test/pdp"]}, runtime={"provider": "mock"}
    )

    diagnostics = payload["failures"][0]["diagnostics"]
    assert diagnostics["process"] == [
        {"id": "generate", "status": "running"},
        {"id": "generator", "status": "error"},
    ]
    assert diagnostics["runtimeStages"] == {
        "productNormalization": {"called": True, "applied": False},
        "copyRefinement": {"called": True, "applied": False},
    }
    serialized = json.dumps(diagnostics)
    assert "private.example.test" not in serialized
    assert "must-not-escape" not in serialized
    assert "prompt text" not in serialized


async def _report_generator_progress_then_timeout(*args: object, **_kwargs: object) -> None:
    on_progress = _required_async_progress_emitter(args[1])
    await on_progress({"id": "input", "status": "done", "message": "Do not expose input text."})
    await on_progress({"id": "normalize", "status": "running", "message": "Do not expose prompt text."})
    raise TimeoutError()


@pytest.mark.asyncio
async def test_run_generate_retains_observed_generator_stages_when_transport_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Progress already emitted before a transport error remains visible in diagnostics."""

    monkeypatch.setattr(console_orchestration, "extract_product", _completed_extractor)
    monkeypatch.setattr(console_orchestration, "generate_pdp_geo", _report_generator_progress_then_timeout)

    payload = await console_orchestration.run_generate(
        {"sources": ["https://example.test/pdp"]}, runtime={"provider": "mock"}
    )

    assert payload["failures"][0]["diagnostics"]["process"] == [
        {"id": "input", "status": "done"},
        {"id": "normalize", "status": "running"},
        {"id": "generator", "status": "error"},
    ]


@pytest.mark.asyncio
async def test_run_generate_retains_manual_generator_progress_when_transport_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Manual JSON generation keeps model-stage progress when no extractor ran."""

    monkeypatch.setattr(console_orchestration, "generate_pdp_geo", _report_generator_progress_then_timeout)

    payload = await console_orchestration.run_generate(
        {"product": {"name": "Barrier Serum"}}, runtime={"provider": "mock"}
    )

    failure = payload["failures"][0]
    assert failure["error"] == "GEO generation failed (TimeoutError)."
    assert failure["diagnostics"] == {
        "process": [
            {"id": "input", "status": "done"},
            {"id": "normalize", "status": "running"},
            {"id": "generator", "status": "error"},
        ],
        "runtimeStages": {},
    }


class _ExtractorConnectionFailure(RuntimeError):
    def __init__(self) -> None:
        super().__init__("connection reset by peer")
        self.diagnostics = {
            "warnings": [{"message": "Do not expose raw extraction warning."}],
            "evidence": [{"value": "Do not expose source evidence."}],
            "runtimeUsage": {
                "steps": [
                    {"stage": "fetch", "called": True, "endpoint": "https://private.example.test"},
                ]
            },
        }


async def _report_extractor_progress_then_connection_failure(*args: object, **_kwargs: object) -> None:
    on_progress = _required_async_progress_emitter(args[1])
    await on_progress({"id": "input", "status": "done", "message": "Do not expose source input."})
    await on_progress({"id": "fetch", "status": "running", "message": "Do not expose source URL."})
    raise _ExtractorConnectionFailure()


@pytest.mark.asyncio
async def test_run_generate_preserves_sanitized_extractor_progress_when_extraction_connection_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A failed source retains its observed extractor stage rather than losing diagnostics."""

    monkeypatch.setattr(
        console_orchestration, "extract_product", _report_extractor_progress_then_connection_failure
    )

    payload = await console_orchestration.run_generate(
        {"sources": ["https://example.test/unreachable"]}, runtime={"provider": "mock"}
    )

    failure = payload["failures"][0]
    assert failure["error"] == "connection reset by peer"
    assert failure["diagnostics"] == {
        "process": [
            {"id": "input", "status": "done"},
            {"id": "fetch", "status": "error"},
        ],
        "runtimeStages": {},
        "extractor": {
            "process": [
                {"id": "input", "status": "done"},
                {"id": "fetch", "status": "error"},
            ],
            "diagnostics": {
                "warningCount": 1,
                "evidenceCount": 1,
                "runtimeStages": [{"stage": "fetch", "called": True}],
            },
        },
    }
    serialized = json.dumps(failure["diagnostics"])
    for private_value in ("private.example.test", "source input", "source URL", "source evidence"):
        assert private_value not in serialized


async def _raise_credential_bearing_provider_error(*_args: object, **_kwargs: object) -> None:
    raise RuntimeError("Provider request failed with apiKey=must-not-escape")


@pytest.mark.asyncio
async def test_run_generate_replaces_credential_bearing_provider_error_with_safe_stage_message(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A provider error must never make request credentials part of public failure text."""

    monkeypatch.setattr(console_orchestration, "generate_pdp_geo", _raise_credential_bearing_provider_error)

    payload = await console_orchestration.run_generate(
        {"product": {"name": "Barrier Serum"}}, runtime={"provider": "mock"}
    )

    assert payload["failures"] == [
        {
            "source": "manual-json-1",
            "sourceType": "manual-json",
            "error": "GEO generation failed (RuntimeError).",
        }
    ]
