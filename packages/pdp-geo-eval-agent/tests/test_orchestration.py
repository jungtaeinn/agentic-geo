"""Async behavior contracts for utility judges, inline probe, and benchmark cache."""

from __future__ import annotations

import asyncio
import importlib
from collections.abc import Mapping, Sequence
from pathlib import Path

import pytest


def _utility():
    return importlib.import_module("pdp_geo_eval_agent.citation.utility")


def _probe():
    return importlib.import_module("pdp_geo_eval_agent.citation.probe")


def _runner():
    return importlib.import_module("pdp_geo_eval_agent.benchmark.runner")


def test_judge_keypoint_coverage_uses_shared_provider_prompt_and_strict_parser(monkeypatch: pytest.MonkeyPatch) -> None:
    utility = _utility()
    calls: list[tuple[str, str]] = []

    async def complete(_config: Mapping[str, object], system: str, user: str) -> str:
        calls.append((system, user))
        return '{"ev-1":{"label":"Supported","justification":"present"}}'

    monkeypatch.setattr(utility, "complete_with_provider", complete)
    result = asyncio.run(utility.judge_keypoint_coverage({"provider": "openai"}, [{"id": "ev-1", "role": "benefit", "text": "firming"}], "Firming copy."))
    assert result["score"].kpr == 1
    assert result["judgments"]["ev-1"].justification == "present"
    assert "Key Points" in calls[0][1]


def test_judge_citation_quality_skips_out_of_range_sources_and_scores_real_support(monkeypatch: pytest.MonkeyPatch) -> None:
    utility = _utility()
    replies = iter([
        '{"claims":[{"claimId":1,"claim":"Claim","sourceIndices":[0,9]}]}',
        '{"support":"full_support","justification":"matches"}',
    ])

    async def complete(*_args: object) -> str:
        return next(replies)

    monkeypatch.setattr(utility, "complete_with_provider", complete)
    score = asyncio.run(utility.judge_citation_quality({"provider": "openai"}, "answer", ["source 0"]))
    assert score.precision == 1
    assert score.weak_claims == []


def test_inline_probe_pairs_fixed_target_sources_and_degrades_one_failed_query(monkeypatch: pytest.MonkeyPatch) -> None:
    probe = _probe()
    calls: list[tuple[str, list[str]]] = []

    async def generate(_config: Mapping[str, object], query: str, sources: list[str]) -> dict[str, str]:
        calls.append((query, sources))
        if query == "bad query":
            raise RuntimeError("provider down")
        target = sources[2]
        answer = "Generated source gives a detailed answer with supporting facts [2]." if target == "generated" else "Vanilla answer [2]."
        return {"answer": answer, "engineId": "openai:test"}

    monkeypatch.setattr(probe, "generate_engine_answer", generate)
    result = asyncio.run(probe.run_citation_probe(
        {"generatedText": "generated", "vanillaText": "vanilla", "locale": "en-US", "category": "serum", "queries": ["good query", "bad query"], "generatedSections": [{"id": "description", "text": "Generated source gives a detailed answer with supporting facts."}]},
        {"engine": {"provider": "openai", "model": "test"}, "maxQueries": 2, "includeUtility": True},
    ))
    assert len(result["queries"]) == 1
    assert all(len(sources) == 5 and sources[probe.GEO_EVAL_TARGET_SLOT] in {"vanilla", "generated"} for _, sources in calls)
    assert result["warnings"] == ['Query "bad query" failed: provider down', "Utility judge skipped: evidence ledger is empty."]
    assert result["queries"][0]["sectionAttribution"][0]["sectionId"] == "description"
    assert result["interpretation"] == probe.CITATION_PROBE_INTERPRETATION


def test_inline_probe_uses_an_empty_judge_config_without_falling_back_to_engine(monkeypatch: pytest.MonkeyPatch) -> None:
    """``??`` keeps an explicitly supplied empty object; Python ``or`` must not."""
    probe = _probe()
    seen_configs: list[object] = []

    async def generate(_config: Mapping[str, object], _query: str, _sources: list[str]) -> dict[str, str]:
        return {"answer": "A detailed answer from the target source [2].", "engineId": "openai:engine"}

    async def judge(config: Mapping[str, object], _ledger: Sequence[Mapping[str, object]], _text: str) -> dict[str, object]:
        seen_configs.append(config)
        score = importlib.import_module("pdp_geo_eval_agent.models").KeypointCoverageScore(
            kpr=1.0, kpc=0.0, supported=1, omitted=0, contradicted=0, total=1, contradictions=[]
        )
        return {"score": score}

    monkeypatch.setattr(probe, "generate_engine_answer", generate)
    monkeypatch.setattr(probe, "judge_keypoint_coverage", judge)
    asyncio.run(
        probe.run_citation_probe(
            {
                "generatedText": "generated",
                "vanillaText": "vanilla",
                "locale": "en-US",
                "queries": ["Which serum works for dry skin?"],
                "evidenceLedger": [{"id": "ev-1", "role": "benefit", "text": "hydration"}],
            },
            {"engine": {"provider": "openai", "model": "engine"}, "judge": {}, "includeUtility": True},
        )
    )

    assert seen_configs == [{}]


def test_benchmark_runner_caches_engine_answers_and_marks_second_run_cached(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    runner = _runner()
    calls: list[str] = []

    async def generate(_config: Mapping[str, object], query: str, sources: list[str]) -> dict[str, str]:
        calls.append(query)
        target = sources[2]
        return {"answer": f"{'Generated content has detail' if 'generated' in target else 'Vanilla content'} [2].", "engineId": "openai:test"}

    monkeypatch.setattr(runner, "generate_engine_answer", generate)
    options: dict[str, object] = {"engine": {"provider": "openai", "model": "test"}, "artifacts": {"fieldnote-arcwell-night-serum": {"publicText": "generated artifact", "evidenceLedger": []}}, "goldenIds": ["ARC-NEED"], "cacheDir": str(tmp_path), "useCache": True}
    first = asyncio.run(runner.run_geo_benchmark(options))
    second = asyncio.run(runner.run_geo_benchmark(options))
    assert len(calls) == 2
    assert first["scores"][0]["vanilla"]["cachedAnswer"] is False
    assert second["scores"][0]["vanilla"]["cachedAnswer"] is True
    assert second["aggregates"]["goldens"] == 1


def test_benchmark_cache_uses_javascript_truthiness_for_empty_cached_answer(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    runner = _runner()
    calls: list[str] = []
    engine = {"provider": "openai", "model": "test"}
    sources = ["a", "b"]
    key = runner._cache_key("answer", {"engineId": "openai:test", "query": "q", "sources": sources})
    (tmp_path / f"{key}.json").write_text('{"answer":""}')

    async def generate(_config: Mapping[str, object], query: str, _sources: list[str]) -> dict[str, str]:
        calls.append(query)
        return {"answer": "fresh answer", "engineId": "openai:test"}

    monkeypatch.setattr(runner, "generate_engine_answer", generate)
    result = asyncio.run(runner._cached_engine_answer(engine, "q", sources, tmp_path, True))

    assert calls == ["q"]
    assert result == {"answer": "fresh answer", "cached": False}
