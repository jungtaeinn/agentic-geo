"""Offline contracts for the manually opt-in PDP quality smoke command."""

from __future__ import annotations

import io
import json
from collections.abc import Mapping
from typing import Any

from neo_agent_api.tools import live_pdp_quality_smoke as smoke


def _runtime_environment(*, flag: str | None = "1") -> dict[str, str]:
    environment = {
        "AISTUDIO_API_KEY": "secret-value",
        "AISTUDIO_ENDPOINT": "https://studio.example.test/v1",
        "AISTUDIO_MODEL": "test-model",
        "AISTUDIO_API_VERSION": "2026-01-01",
    }
    if flag is not None:
        environment["RUN_LIVE_PDP_EVAL"] = flag
    return environment


def _generated_artifact() -> dict[str, Any]:
    return {
        "schemaMarkup": {
            "jsonLd": {
                "@context": "https://schema.org",
                "@graph": [
                    {
                        "@type": ["WebPage", "ItemPage"],
                        "description": "This product page explains the formula and use.",
                    },
                    {
                        "@type": "Product",
                        "name": "Test serum",
                        "description": "Test serum is described with source-backed product details.",
                    },
                ],
            }
        }
    }


def test_live_config_and_redaction_are_safe_pure_contracts() -> None:
    assert smoke.build_live_config({}) is None
    assert set(smoke.LIVE_CASES) == {"en-US", "ko-KR"}

    redacted = smoke.redact_runtime_config(
        {
            "apiKey": "secret-value",
            "headers": {"authorization": "Bearer secret-value"},
            "endpoint": "https://studio.example.test/v1?api_key=secret-value#fragment",
        }
    )

    rendered = json.dumps(redacted, sort_keys=True)
    assert "secret-value" not in rendered
    assert "Bearer" not in rendered
    assert "?" not in rendered
    assert "#" not in rendered


def test_main_never_invokes_orchestration_without_exact_opt_in(monkeypatch: Any) -> None:
    calls: list[object] = []

    async def unexpected_call(*args: object, **kwargs: object) -> dict[str, object]:
        calls.append((args, kwargs))
        raise AssertionError("the opt-in guard must run before any orchestration")

    monkeypatch.setattr(smoke, "run_generate", unexpected_call)

    for flag in (None, "", "0", "true", "1 "):
        output = io.StringIO()
        assert smoke.main(environ=_runtime_environment(flag=flag), stdout=output) == 0
        assert json.loads(output.getvalue()) == {
            "reason": "manual-opt-in-required",
            "status": "skipped",
        }

    assert calls == []


def test_opted_in_run_uses_only_fixed_cases_and_emits_redacted_summary(monkeypatch: Any) -> None:
    calls: list[Mapping[str, Any]] = []

    async def generated(
        body: Mapping[str, Any], *, runtime: Mapping[str, Any], **_kwargs: object
    ) -> dict[str, object]:
        calls.append(body)
        source = body["sources"][0]
        assert isinstance(source, str)
        assert runtime["provider"] == "aistudio"
        return {"results": [{"source": source, "generator": _generated_artifact()}], "failures": [], "logs": []}

    monkeypatch.setattr(smoke, "run_generate", generated)
    output = io.StringIO()

    assert smoke.main(environ=_runtime_environment(), stdout=output) == 0

    summary = json.loads(output.getvalue())
    assert summary["status"] == "passed"
    assert [case["locale"] for case in summary["cases"]] == ["en-US", "ko-KR"]
    assert {body["sources"][0] for body in calls} == {case["url"] for case in smoke.LIVE_CASES.values()}
    assert all(body["citationProbe"] == {"enabled": False} for body in calls)
    assert all(body["qualityGate"] == {"enabled": False} for body in calls)
    assert "secret-value" not in output.getvalue()
    assert "?variant=" not in output.getvalue()
    assert "generator" not in output.getvalue()


def test_opted_in_failure_is_nonzero_and_does_not_render_provider_error(monkeypatch: Any) -> None:
    async def failed(
        body: Mapping[str, Any], *, runtime: Mapping[str, Any], **_kwargs: object
    ) -> dict[str, object]:
        return {
            "results": [],
            "failures": [
                {
                    "source": body["sources"][0],
                    "error": "Authorization: Bearer secret-value at https://studio.example.test/?key=secret-value",
                }
            ],
            "logs": [],
        }

    monkeypatch.setattr(smoke, "run_generate", failed)
    output = io.StringIO()

    assert smoke.main(environ=_runtime_environment(), stdout=output) == 1

    summary = json.loads(output.getvalue())
    assert summary["status"] == "failed"
    assert {case["errorCategory"] for case in summary["cases"]} == {"pipeline-failure"}
    assert "secret-value" not in output.getvalue()
    assert "Authorization" not in output.getvalue()
    assert "?key=" not in output.getvalue()
