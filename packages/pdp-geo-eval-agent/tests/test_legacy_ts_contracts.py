"""Cross-language evaluator contracts with a synthetic public benchmark overlay."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
from collections.abc import Mapping
from pathlib import Path
from typing import cast

import httpx
import pytest
from neo_js_compat import js_json_dumps

import pdp_geo_eval_agent as evaluator
import pdp_geo_eval_agent.benchmark as benchmark_api
import pdp_geo_eval_agent.benchmark.runner as benchmark_runner
import pdp_geo_eval_agent.rest as rest_api
import pdp_geo_eval_agent.types as types_api
from pdp_geo_eval_agent.benchmark import (
    aggregate_geo_scores,
    build_source_set,
    eval_products,
    geo_eval_distractors,
    geo_eval_goldens,
)
from pdp_geo_eval_agent.citation.engine import complete_with_provider
from pdp_geo_eval_agent.rest import create_pdp_geo_eval_asgi_app, evaluate_rest_body

_FIXTURES = Path(__file__).with_name("fixtures")
_CONTRACT = _FIXTURES / "legacy-ts-contracts-v1.json"
_DIGEST = _FIXTURES / "legacy-ts-contracts-v1.sha256"


def test_legacy_contract_fixture_is_integrity_pinned_before_python_assertions() -> None:
    """A changed capture must fail before a Python port can bless itself."""

    expected = _DIGEST.read_text(encoding="utf-8").strip()

    assert hashlib.sha256(_CONTRACT.read_bytes()).hexdigest() == expected
    fixture = _contract()
    provenance = _record(fixture["provenance"])
    assert {key: provenance[key] for key in (
        "legacySourceCommit", "legacySourceTreeSha256", "captureLocale", "node", "pnpm", "tsx", "vitest", "timestampNormalization"
    )} == {
        "legacySourceCommit": "6702158280ec7de675594af93c7c381eb2feae38",
        "legacySourceTreeSha256": "d64e965ad6331db09d55e037a845d99a5d8e91fb89b660b9e7a3061e3f5a9b93",
        "captureLocale": "en-US",
        "node": "v24.11.0",
        "pnpm": "11.24.0",
        "tsx": "tsx v4.23.1\nnode v24.11.0",
        "vitest": "vitest/4.1.10 darwin-arm64 node-v24.11.0",
        "timestampNormalization": "Only probe.probedAt is replaced with <legacy-capture-time>.",
    }
    assert _string(provenance["captureMethod"]) == (
        "Disposable detached checkout at legacySourceCommit; capture-legacy-contract.ts imported the historical "
        "TypeScript entrypoints and intercepted Request objects passed to its global fetch calls."
    )
    assert _string(provenance["benchmarkFixtureSanitization"]) == (
        "Benchmark fixtures, questions, distractors, and derived citation text were replaced with internally authored "
        "synthetic records for the public Python migration."
    )
    assert _string_mapping(provenance["sourceHashes"]) == {
        "package.json": "d214340565a695636a9d2e89458c7ede9bbf11538b16e2226af8634926c13c7d",
        "src/index.ts": "76f664608afda24279f663d1df433581155e1a58f14d638c4d59448cb3e40e19",
        "src/types.ts": "66fb89d2f64b918da2fecd5976b19db1718978d0020694da9cfdd97107593c94",
        "src/benchmark/index.ts": "3c98b20c52c0df6638a37c0aa63533e617aea6cf96a4a38ead88fdebcaef5cc1",
        "src/rest.ts": "69a9904875de13fcfe1e6d0511659d21cf98435fb9b1e242665284364bd77a86",
        "src/citation/engine.ts": "2cfada9b48d95725d3d130c2ae552a55feaa15302a6b16306e28bc14bc60382c",
    }
    assert _string_mapping(provenance["providerInputSha256"]) == {
        "openai-normal": "42586748beecc25f2fcf28e372468a7473771ac18e15cd658d776496266adca8",
        "gemini-normal": "a6276b1a4cb85243f82ea7c551d3f15a5c1653cbac5c561f2fc00c2e75eb46a1",
        "azure-retry-normal": "e732e49c61b45fdd6804390bba1aad0a6bb1510ef42fb854ae4657930b6cfb53",
        "aistudio-normal": "5b0a1541728b8f4315e1d7bbb6eee8b9cce7767329b0b9c1993d25e73293acec",
        "openai-unicode-negative-zero": "88c1c7394500632735d55615de779ef16d32af9783fcd0ea7c00c906fbc84488",
        "gemini-unicode-nan": "3964d006f48b8d13db5c5cfaf9a089205eb531801252b321631e78de3e70a709",
        "azure-retry-unicode-negative-zero": "4d03f20141c9989b71c363f95fcecbfc51d646f13b3669aa9e691a4cefaf8d51",
    }


def _contract() -> dict[str, object]:
    expected = _DIGEST.read_text(encoding="utf-8").strip()
    raw = _CONTRACT.read_bytes()
    assert hashlib.sha256(raw).hexdigest() == expected
    parsed = cast(object, json.loads(raw))
    return _record(parsed)


def _wire(value: object) -> object:
    return evaluator.to_wire(value)


def _compact(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _record(value: object) -> dict[str, object]:
    if not isinstance(value, Mapping):
        raise AssertionError(f"Expected frozen contract record, got {type(value).__name__}.")
    mapping = cast(Mapping[object, object], value)
    assert all(isinstance(key, str) for key in mapping)
    return dict(cast(Mapping[str, object], mapping))


def _records(value: object) -> list[dict[str, object]]:
    if not isinstance(value, list):
        raise AssertionError("Expected frozen contract array.")
    return [_record(item) for item in cast(list[object], value)]


def _string(value: object) -> str:
    assert isinstance(value, str)
    return value


def _integer(value: object) -> int:
    assert isinstance(value, int) and not isinstance(value, bool)
    return value


def _string_mapping(value: object) -> dict[str, str]:
    record = _record(value)
    assert all(isinstance(item, str) for item in record.values())
    return {key: _string(item) for key, item in record.items()}


def _strings(value: object) -> list[str]:
    assert isinstance(value, list)
    values = cast(list[object], value)
    assert all(isinstance(item, str) for item in values)
    return [cast(str, item) for item in values]


def _provider_config(value: object) -> dict[str, object]:
    config = _record(value)
    resolved: dict[str, object] = {}
    for name, raw in config.items():
        if isinstance(raw, Mapping):
            token = _string(_record(cast(object, raw)).get("numberToken", ""))
            if token == "-0":
                resolved[name] = -0.0
                continue
            if token == "NaN":
                resolved[name] = float("nan")
                continue
            if token == "Infinity":
                resolved[name] = float("inf")
                continue
            if token == "-Infinity":
                resolved[name] = float("-inf")
                continue
            raise AssertionError(f"Unknown captured number token for {name}: {token!r}")
        resolved[name] = raw
    return resolved


async def _post_evaluation(body: bytes) -> tuple[int, dict[str, str], bytes]:
    events: list[dict[str, object]] = []
    received = False

    async def receive() -> dict[str, object]:
        nonlocal received
        if received:
            return {"type": "http.disconnect"}
        received = True
        return {"type": "http.request", "body": body, "more_body": False}

    async def send(event: dict[str, object]) -> None:
        events.append(event)

    await create_pdp_geo_eval_asgi_app()({"type": "http", "method": "POST", "path": "/evaluation", "headers": []}, receive, send)
    start = next(event for event in events if event["type"] == "http.response.start")
    raw = b"".join(cast(bytes, event.get("body", b"")) for event in events if event["type"] == "http.response.body")
    return int(cast(int, start["status"])), {
        key.decode().lower(): value.decode()
        for key, value in cast(list[tuple[bytes, bytes]], start["headers"])
    }, raw


def test_frozen_provider_transport_contracts_match_legacy_typescript() -> None:
    """Replay every captured provider request, answer, and Azure retry boundary."""

    providers = _records(_record(_contract()["prompts"])["providers"])
    input_hashes = _string_mapping(_record(_contract()["provenance"])["providerInputSha256"])

    for provider_case in providers:
        expected_calls = _records(provider_case["calls"])
        case_id = _string(provider_case["id"])
        assert _string(provider_case["inputSha256"]) == input_hashes[case_id]
        observed_calls = 0
        config = _provider_config(provider_case["config"])
        provider = _string(config["provider"])

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal observed_calls
            expected = expected_calls[observed_calls]
            expected_headers = _string_mapping(expected["headers"])
            expected_body = base64.b64decode(_string(expected["bodyBase64"]))
            assert str(request.url) == _string(expected["url"])
            assert {name: request.headers[name] for name in expected_headers} == expected_headers
            assert request.content == expected_body
            assert hashlib.sha256(request.content).hexdigest() == _string(expected["bodySha256"])
            observed_calls += 1
            if provider == "openai":
                return httpx.Response(200, json={"output_text": _string(provider_case["answer"])})
            if provider == "gemini":
                return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": _string(provider_case["answer"])}]}}]})
            if provider == "azure-openai" and observed_calls == 1:
                return httpx.Response(400, text="unsupported value for temperature")
            return httpx.Response(200, json={"choices": [{"message": {"content": _string(provider_case["answer"])}}]})

        async def run() -> str:
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
                return await complete_with_provider(config, _string(provider_case["system"]), _string(provider_case["user"]), client=client)

        assert asyncio.run(run()) == _string(provider_case["answer"])
        assert observed_calls == len(expected_calls)


def test_frozen_benchmark_runner_contract_matches_legacy_fake_engine(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Lock paired source ordering, score aggregation, and gate behavior without a provider."""

    captured = _record(_record(_contract()["benchmark"])["run"])
    artifact = _record(captured["artifact"])

    async def fake_generate_engine_answer(
        _engine: dict[str, object], _query: str, sources: list[str]
    ) -> dict[str, str]:
        generated = _string(artifact["publicText"]) in sources
        return {
            "answer": "Generated barrier answer. [2]" if generated else "Competitor-only answer. [1]",
            "engineId": "openai:capture-model",
        }

    monkeypatch.setattr(benchmark_runner, "generate_engine_answer", fake_generate_engine_answer)
    actual = asyncio.run(
        benchmark_runner.run_geo_benchmark(
            {
                "engine": {"provider": "openai", "apiKey": "capture-key", "model": "capture-model"},
                "artifacts": {"byeolmorae-waterfold-toner": artifact},
                "goldenIds": ["WFT-NEED"],
                "cacheDir": str(tmp_path),
                "useCache": False,
            }
        )
    )
    assert actual == captured["result"]


def test_frozen_quality_wires_reports_and_falsy_json_ld_match_legacy_typescript() -> None:
    """Catch score, ordering, locale, nullish, or report drift in the Python rubric."""

    for case in _records(_contract()["quality"]):
        input_ = _record(case["input"])
        assert hashlib.sha256(_compact(input_).encode()).hexdigest() == case["inputHash"]
        actual = evaluator.evaluate_geo_quality(input_, _string(case["language"]))
        assert _wire(actual) == case["evaluation"]
        assert evaluator.format_geo_quality_evaluation_text(_string(case["productName"]), actual, _string(case["language"])) == case["report"]


def test_frozen_citation_probe_utility_and_presentation_contracts_match_legacy_typescript() -> None:
    """Catch deterministic scoring, attribution, prompt-helper, or asset-order drift."""

    fixture = _contract()
    citation = _record(fixture["citation"])
    metric_input = _record(citation["metricInput"])
    sentences = evaluator.extract_citation_sentences(_string(metric_input["answer"]))
    assert _wire(sentences) == citation["sentences"]
    assert _wire(evaluator.score_impression_shares(sentences, _integer(metric_input["sourceCount"]))) == citation["shares"]
    assert _wire(evaluator.score_citation_visibility(_string(metric_input["answer"]), _integer(metric_input["sourceCount"]), _integer(metric_input["targetIndex"]))) == citation["visibility"]
    assert _wire(evaluator.attribute_citations_to_sections(_string(metric_input["answer"]), _integer(metric_input["targetIndex"]), _records(metric_input["sections"]))) == citation["attribution"]
    assert evaluator.z_normalize_scores([1, 2, 4]) == citation["normalized"]
    assert _wire(evaluator.build_image_attributable_sections(_records(citation["imageInput"]))) == citation["imageSections"]
    assert _wire(evaluator.derive_probe_queries(citation["probeContext"], 3)) == citation["queries"]
    assert evaluator.build_probe_distractors("en-US", "cream") == citation["distractors"]
    assert evaluator.build_generated_source_text({"productName": "Name", "description": "Description", "quickFacts": "", "benefits": "Benefit", "ingredients": "", "howToUse": "", "faq": ""}) == citation["generatedText"]
    assert evaluator.build_vanilla_source_text(eval_products["byeolmorae-waterfold-toner"]) == citation["vanillaText"]
    metadata = _record(citation["metadata"])
    assert evaluator.contains_serialized_metadata("platform.meta.value: x") is metadata["contains"]
    assert evaluator.find_serialized_metadata_artifact("platform.meta.value: x") == metadata["artifact"]

    utility = _record(fixture["utility"])
    judgments = evaluator.parse_keypoint_judgments(_string(utility["keypointRaw"]), ["ev-1"])
    claims = evaluator.parse_extracted_claims(_string(utility["claimRaw"]))
    support = evaluator.parse_citation_support(_string(utility["supportRaw"]))
    assert _wire(judgments) == utility["keypoints"]
    assert _wire(claims) == utility["claims"]
    assert _wire(support) == utility["support"]
    coverage = evaluator.score_keypoint_coverage(judgments)
    quality = evaluator.score_citation_quality(claims, {1: [support]})
    assert _wire(coverage) == utility["coverage"]
    assert _wire(quality) == utility["citationQuality"]
    assert _wire(evaluator.evaluate_utility_gate({"visibilityDelta": 0.2, "keypointCoverage": coverage, "citationQuality": quality})) == utility["gate"]

    suite = _record(fixture["suite"])
    copy = evaluator.get_geo_quality_copy("en")
    assert copy.title == _string(_record(suite["copy"])["title"])
    assert copy.validation_detail_label == _string(_record(suite["copy"])["validationDetailLabel"])
    evaluation_suite = evaluator.get_evaluation_suite_copy("en")
    evaluation_suite_wire = _record(suite["evaluationSuite"])
    assert evaluation_suite.title == _string(evaluation_suite_wire["title"])
    assert evaluation_suite.interpretation == _string(evaluation_suite_wire["interpretation"])
    assert evaluator.share_to_pct(0.126) == suite["share"]
    assert evaluator.format_pct_delta(-0.126) == suite["delta"]
    assert evaluator.probe_query_outcome(0.06) == suite["outcome"]
    assert evaluator.format_image_section_id("https://images.example/a.jpg?x=1", evaluation_suite) == suite["imageId"]
    assert evaluator.format_section_attribution([{"sectionId": "description", "share": 0.7, "citedSentences": 1, "sentences": ["x"]}], evaluation_suite) == suite["attribution"]
    assert evaluator.format_query_source_breakdown({"queries": [{"querySource": "template"}, {"querySource": "template"}]}, evaluation_suite) == suite["breakdown"]
    populated = evaluator.evaluate_geo_quality(_record(_records(fixture["quality"])[0]["input"]), "en")
    assert _wire(evaluator.build_easy_improvement_summary(populated, evaluation_suite, "")) == suite["easy"]
    assert evaluator.build_probe_safety_notes({"mean": {"delta": {"wordpos": 0.2}}, "gate": {"pass": True}}, evaluation_suite) == suite["safety"]
    assert evaluator.build_probe_narrative_why({"queries": []}, evaluation_suite, 0) == suite["narrative"]


def test_frozen_prompt_provider_benchmark_rest_and_public_contracts_match_legacy_typescript() -> None:
    """Catch byte-level adapter, asset, REST, or public-alias compatibility regressions."""

    fixture = _contract()
    prompts = _record(fixture["prompts"])
    assert evaluator.build_citation_answer_prompt("What supports comfort?", ["first", "second"]) == prompts["citationAnswer"]
    quality_input = _record(_records(fixture["quality"])[0]["input"])
    assert evaluator.build_concept_embodiment_prompt(quality_input, "en") == prompts["concept"]
    assert _wire(evaluator.parse_concept_embodiment_response('{"dimensions":{"geo":{"score":90,"embodied":["A"],"missing":[],"improvements":[]},"cep":{"score":80,"embodied":[],"missing":["B"],"improvements":["C"]},"eeat":{"score":70,"embodied":[],"missing":[],"improvements":[]}},"summary":"Summary"}')) == prompts["conceptParsed"]
    sections = {"productName": "Cream", "description": " Good cream ", "quickFacts": "", "benefits": "Firming", "ingredients": "", "howToUse": "", "faq": ""}
    assert evaluator.format_content_sections_for_prompt(sections, "en") == prompts["contentSections"]
    quality = evaluator.evaluate_geo_quality(quality_input, "en")
    quality_context = {"productName": "Barrier Cream", "contentSections": {"productName": "Barrier Cream", "description": "A cream", "quickFacts": "", "benefits": "Barrier support", "ingredients": "", "howToUse": "", "faq": ""}, "jsonLd": quality_input["jsonLd"]}
    assert evaluator.format_quality_llm_prompt(quality_context, quality, "en") == prompts["qualityPrompt"]
    probe_context: dict[str, object] = {"productName": "Barrier Cream", "contentSections": quality_context["contentSections"]}
    probe: dict[str, object] = {"engineId": "openai:test", "probedAt": "2026-01-01", "queries": [], "mean": {"vanilla": {"wordpos": 0.2}, "generated": {"wordpos": 0.4}, "delta": {"wordpos": 0.2}}, "gate": {"pass": True}, "warnings": [], "interpretation": "fixture"}
    assert evaluator.format_probe_llm_prompt(probe_context, probe, "en") == prompts["probePrompt"]

    benchmark = _record(fixture["benchmark"])
    assert _wire(eval_products) == benchmark["fixtures"]
    assert _wire(geo_eval_goldens) == benchmark["goldens"]
    assert _wire(geo_eval_distractors) == benchmark["distractors"]
    assert _string(benchmark["fixtureHash"]) == hashlib.sha256(js_json_dumps(_wire(eval_products)).encode()).hexdigest()
    assert _string(benchmark["goldenHash"]) == hashlib.sha256(js_json_dumps(_wire(geo_eval_goldens)).encode()).hexdigest()
    assert _string(benchmark["distractorHash"]) == hashlib.sha256(js_json_dumps(_wire(geo_eval_distractors)).encode()).hexdigest()
    assert build_source_set("byeolmorae-waterfold-toner", "TARGET") == benchmark["sourceSet"]
    scores: list[dict[str, object]] = [
        {"goldenId": "A", "productId": "byeolmorae-waterfold-toner", "locale": "ko-KR", "cepFocus": "need", "query": "q", "vanilla": {"wordpos": 0.2, "word": 0.2, "pos": 0.2, "citedSentenceCount": 1, "sentenceCount": 2, "hallucinatedCitations": [], "cachedAnswer": False}, "generated": {"wordpos": 0.4, "word": 0.3, "pos": 0.5, "citedSentenceCount": 2, "sentenceCount": 2, "hallucinatedCitations": [], "cachedAnswer": False}, "delta": {"wordpos": 0.2, "word": 0.1, "pos": 0.3}, "gate": {"pass": True, "failures": [], "skippedChecks": []}},
        {"goldenId": "B", "productId": "byeolmorae-waterfold-toner", "locale": "en-US", "cepFocus": "routine", "query": "q", "vanilla": {"wordpos": 0.1, "word": 0.1, "pos": 0.1, "citedSentenceCount": 1, "sentenceCount": 1, "hallucinatedCitations": [], "cachedAnswer": False}, "generated": {"wordpos": 0.1, "word": 0.1, "pos": 0.1, "citedSentenceCount": 1, "sentenceCount": 1, "hallucinatedCitations": [], "cachedAnswer": False}, "delta": {"wordpos": 0, "word": 0, "pos": 0}, "gate": {"pass": False, "failures": ["x"], "skippedChecks": []}}
    ]
    assert aggregate_geo_scores(scores, "openai:test") == benchmark["aggregate"]

    for case in _records(fixture["rest"]):
        request_body = _string(case["requestBody"])
        assert hashlib.sha256(_compact(request_body).encode()).hexdigest() == case["inputHash"]
        status, headers, body = asyncio.run(_post_evaluation(request_body.encode()))
        assert status == case["status"]
        assert headers["content-type"] == _string(_record(case["headers"])["contentType"])
        assert body.decode() == case["body"]

        try:
            decoded = json.loads(request_body)
        except json.JSONDecodeError:
            continue
        direct_status, direct_payload = evaluate_rest_body(decoded)
        assert direct_status == status
        assert _compact(direct_payload) == body.decode()

    surface = _record(fixture["publicSurface"])
    assert _string_mapping(surface["packageExports"]) == {
        ".": "./src/index.ts",
        "./types": "./src/types.ts",
        "./benchmark": "./src/benchmark/index.ts",
        "./rest": "./src/rest.ts",
    }
    entrypoints = _record(surface["entrypoints"])
    assert set(entrypoints) == {".", "./types", "./benchmark", "./rest"}

    root_surface = _record(entrypoints["."])
    root_runtime = _string_mapping(root_surface["runtime"])
    root_values = _record(root_surface["runtimeValues"])
    root_types = set(_strings(root_surface["typeOnly"]))
    assert len(root_runtime) == 52
    assert len(root_types) == 47
    assert set(root_values) <= set(root_runtime)
    assert set(root_runtime.values()) <= set(evaluator.__all__)
    assert root_types <= set(evaluator.__all__)
    for legacy_name, python_alias in root_runtime.items():
        value = getattr(evaluator, python_alias)
        if legacy_name in root_values:
            assert _wire(value) == root_values[legacy_name]
        else:
            assert callable(value)
    assert all(hasattr(evaluator, type_name) for type_name in root_types)

    types_surface = _record(entrypoints["./types"])
    assert _string_mapping(types_surface["runtime"]) == {}
    types_only = set(_strings(types_surface["typeOnly"]))
    assert len(types_only) == 10
    assert types_only <= set(types_api.__all__)
    assert all(hasattr(types_api, type_name) for type_name in types_only)

    benchmark_surface = _record(entrypoints["./benchmark"])
    benchmark_runtime = _string_mapping(benchmark_surface["runtime"])
    benchmark_values = _record(benchmark_surface["runtimeValues"])
    benchmark_types = set(_strings(benchmark_surface["typeOnly"]))
    assert len(benchmark_runtime) == 7
    assert len(benchmark_types) == 10
    assert set(benchmark_values) <= set(benchmark_runtime)
    assert set(benchmark_runtime.values()) <= set(benchmark_api.__all__)
    assert benchmark_types <= set(benchmark_api.__all__)
    for legacy_name, python_alias in benchmark_runtime.items():
        value = getattr(benchmark_api, python_alias)
        if legacy_name in benchmark_values:
            assert _wire(value) == benchmark_values[legacy_name]
        else:
            assert callable(value) or python_alias in {"eval_products", "geo_eval_distractors", "geo_eval_goldens"}
    assert all(hasattr(benchmark_api, type_name) for type_name in benchmark_types)

    rest_surface = _record(entrypoints["./rest"])
    rest_runtime = _string_mapping(rest_surface["runtime"])
    assert set(rest_runtime) == {"createPdpGeoEvalRestHandler"}
    assert _strings(rest_surface["typeOnly"]) == []
    assert callable(getattr(rest_api, rest_runtime["createPdpGeoEvalRestHandler"]))
    assert benchmark_api.eval_products is eval_products
    assert benchmark_api.geo_eval_goldens is geo_eval_goldens
    assert benchmark_api.geo_eval_distractors is geo_eval_distractors
