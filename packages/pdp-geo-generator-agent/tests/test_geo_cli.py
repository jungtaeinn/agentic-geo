"""Behavioral contracts for the generator-owned operational console commands."""

from __future__ import annotations

import base64
import json
import math
import os
import subprocess
import tokenize
import tomllib
from collections.abc import Mapping
from io import StringIO
from pathlib import Path
from typing import Any

import httpx
import pytest
from pdp_geo_eval_agent import complete_with_provider as evaluator_complete_with_provider
from pytest import CaptureFixture, MonkeyPatch

import pdp_geo_generator_agent.geo_cli as geo_cli
import pdp_geo_generator_agent.rag.cli as rag_cli


def _provider_env() -> dict[str, str]:
    return {"OPENAI_API_KEY": "test-key", "OPENAI_MODEL": "test-model"}


def test_rag_embedding_precompute_posts_pinned_node24_bytes(monkeypatch: MonkeyPatch, tmp_path: Path) -> None:
    """Offline embedding precompute retains the legacy OpenAI body bytes.

    Captured with Node v24.11.0 ``JSON.stringify`` from the retained generator
    source baseline (origin/main, 6702158280ec7de675594af93c7c381eb2feae38).
    """

    requests: list[tuple[str, str | None, str | None, bytes]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(
            (
                str(request.url),
                request.headers.get("authorization"),
                request.headers.get("content-type"),
                request.content,
            )
        )
        return httpx.Response(200, json={"data": [{"index": 0, "embedding": [0.5]}]})

    async def profile() -> dict[str, object]:
        return {"documents": [{"name": "source.md", "content": "ignored", "version": "v1"}]}

    def chunks(_name: str, _content: str, _version: str) -> list[dict[str, object]]:
        return [{"id": "source-1"}]

    def contextual_text(_chunk: Mapping[str, object]) -> str:
        return "x\ud800"

    transport = httpx.MockTransport(handler)
    original_client = httpx.Client

    def client_with_transport(*, timeout: float) -> httpx.Client:
        return original_client(timeout=timeout, transport=transport)

    monkeypatch.setenv("OPENAI_API_KEY", "embedding-key")
    monkeypatch.setattr(rag_cli, "read_pdp_geo_generator_rag_profile", profile)
    monkeypatch.setattr(rag_cli, "chunk_pdp_geo_rag_document", chunks)
    monkeypatch.setattr(rag_cli, "create_pdp_geo_contextual_retrieval_text", contextual_text)
    monkeypatch.setattr(httpx, "Client", client_with_transport)

    assert rag_cli.precompute_embeddings_main(["--model", "embed-test", "--out", str(tmp_path / "snapshot.json")]) == 0
    assert requests == [
        (
            "https://api.openai.com/v1/embeddings",
            "Bearer embedding-key",
            "application/json",
            base64.b64decode("eyJtb2RlbCI6ImVtYmVkLXRlc3QiLCJpbnB1dCI6WyJ4XHVkODAwIl19"),
        )
    ]


def _write_results(path: Path, scores: list[dict[str, Any]], *, engine_id: str | None = "openai:test-model") -> None:
    payload: dict[str, Any] = {"scores": scores}
    if engine_id is not None:
        payload["engineId"] = engine_id
    path.write_text(json.dumps(payload), encoding="utf-8")


def _golden(identifier: str, product_id: str = "one") -> dict[str, str]:
    return {
        "id": identifier,
        "productId": product_id,
        "query": f"Question for {identifier}?",
        "locale": "en-US",
        "market": "US",
        "cepFocus": "need",
    }


def _score(identifier: str, wordpos: float) -> dict[str, Any]:
    return {"goldenId": identifier, "delta": {"wordpos": wordpos}}


async def _generated_artifact(
    input_: Mapping[str, Mapping[str, object]], _options: Mapping[str, Any] | None = None
) -> dict[str, Any]:
    product = input_["product"]
    product_name = product["name"]
    assert isinstance(product_name, str)
    return {
        "result": {"content": {"sections": {"productName": product_name, "description": "Generated copy."}}},
        "diagnostics": {"evidenceLedger": [{"id": "e-1", "role": "product", "text": "evidence"}]},
    }


def _install_extract_fixtures(monkeypatch: MonkeyPatch, goldens: list[dict[str, str]]) -> None:
    monkeypatch.setattr(geo_cli, "geo_eval_goldens", goldens)
    monkeypatch.setattr(geo_cli, "eval_products", {"one": {"name": "One", "brand": "Neo", "category": "Serum"}})
    monkeypatch.setattr(geo_cli, "generate_pdp_geo", _generated_artifact)


def test_extract_rules_requires_provider_and_results(capsys: CaptureFixture[str], tmp_path: Path) -> None:
    assert geo_cli.extract_rules_main([], environ={}) == 1
    assert "Usage: pdp-geo-extract-rules" in capsys.readouterr().err

    assert geo_cli.extract_rules_main(["--provider", "openai"], environ=_provider_env()) == 1
    assert "Usage: pdp-geo-extract-rules" in capsys.readouterr().err

    results = tmp_path / "scores.json"
    _write_results(results, [])
    assert geo_cli.extract_rules_main(["--results", str(results)], environ={}) == 1
    assert "Usage: pdp-geo-extract-rules" in capsys.readouterr().err


def test_extract_rules_uses_input_order_cutoff_sign_and_skips_unknown_goldens(
    capsys: CaptureFixture[str], monkeypatch: MonkeyPatch, tmp_path: Path
) -> None:
    _install_extract_fixtures(monkeypatch, [_golden("ZERO"), _golden("NEGATIVE"), _golden("POSITIVE")])
    results = tmp_path / "scores.json"
    _write_results(
        results,
        [_score("ZERO", 0), _score("NEGATIVE", -0.2), _score("UNKNOWN", 0.4), _score("POSITIVE", 0.3)],
    )

    calls: list[tuple[str, str, dict[str, object]]] = []

    async def complete(config: Mapping[str, Any], system: str, user: str) -> str:
        calls.append((system, user, dict(config)))
        if system == geo_cli.EXTRACTOR_SYSTEM:
            return '["  keep this rule  ", "", 7]'
        if system == geo_cli.FILTER_SYSTEM:
            return '{"modifiedRule":"filtered rule"}'
        return '["merged rule"]' if system == geo_cli.MERGER_SYSTEM else "Detailed explanation."

    monkeypatch.setattr(geo_cli, "complete_with_provider", complete)
    output = tmp_path / "out"
    assert geo_cli.extract_rules_main(
        ["--results", str(results), "--out", str(output), "--threshold", "0", "--temperature", "0.4", "--model", "chosen"],
        environ={**_provider_env(), "GEO_EVAL_PROVIDER": "openai"},
    ) == 0

    captured = capsys.readouterr()
    assert captured.out == ""
    assert "golden UNKNOWN not found" in captured.err
    assert [json.loads((output / "pairs" / f"{identifier}.json").read_text())["winnerVariant"] for identifier in ("ZERO", "NEGATIVE", "POSITIVE")] == [
        "vanilla",
        "vanilla",
        "generated",
    ]
    assert [json.loads((output / "pairs" / f"{identifier}.json").read_text())["wordposDelta"] for identifier in ("ZERO", "NEGATIVE", "POSITIVE")] == [0, -0.2, 0.3]
    assert calls[0][2]["temperature"] == 0.4
    assert calls[0][2]["model"] == "chosen"


def test_extract_rules_uses_javascript_to_fixed_for_half_wordpos_explainer_prompts(
    monkeypatch: MonkeyPatch, tmp_path: Path
) -> None:
    _install_extract_fixtures(monkeypatch, [_golden("POSITIVE-HALF"), _golden("NEGATIVE-HALF")])
    results = tmp_path / "scores.json"
    _write_results(results, [_score("POSITIVE-HALF", 0.0625), _score("NEGATIVE-HALF", -0.0625)])
    explainer_prompts: list[str] = []

    async def complete(_config: Mapping[str, Any], system: str, user: str) -> str:
        if system == geo_cli.EXPLAINER_SYSTEM:
            explainer_prompts.append(user)
            return "explanation"
        if system == geo_cli.EXTRACTOR_SYSTEM:
            return "[]"
        raise AssertionError(f"unexpected provider system prompt: {system}")

    monkeypatch.setattr(geo_cli, "complete_with_provider", complete)
    assert geo_cli.extract_rules_main(
        ["--provider", "openai", "--results", str(results), "--out", str(tmp_path / "out")], environ=_provider_env()
    ) == 0

    assert "citation share difference: 0.063)." in explainer_prompts[0]
    assert "citation share difference: -0.063)." in explainer_prompts[1]


def test_extract_rules_parses_fenced_json_and_trusts_existing_pair_checkpoint(
    capsys: CaptureFixture[str], monkeypatch: MonkeyPatch, tmp_path: Path
) -> None:
    _install_extract_fixtures(monkeypatch, [_golden("RESUME")])
    results = tmp_path / "scores.json"
    _write_results(results, [_score("RESUME", 0.3)], engine_id=None)
    output = tmp_path / "out"
    pairs = output / "pairs"
    pairs.mkdir(parents=True)
    (pairs / "RESUME.json").write_text(
        json.dumps(
            {
                "goldenId": "RESUME",
                "winnerVariant": "vanilla",
                "wordposDelta": 0.001,
                "explanation": "old explanation",
                "rules": ["checkpoint rule"],
                "unexpected": "trusted without schema validation",
            }
        ),
        encoding="utf-8",
    )
    systems: list[str] = []

    async def complete(_config: Mapping[str, Any], system: str, _user: str) -> str:
        systems.append(system)
        if system == geo_cli.MERGER_SYSTEM:
            return "```json\n[\"merged rule\", \"\"]\n```"
        if system == geo_cli.FILTER_SYSTEM:
            return "```json\n{\"modifiedRule\": \"filtered rule\"}\n```"
        raise AssertionError("a checkpointed pair must not invoke explainer/extractor")

    monkeypatch.setattr(geo_cli, "complete_with_provider", complete)
    assert geo_cli.extract_rules_main(["--provider", "openai", "--results", str(results), "--out", str(output)], environ=_provider_env()) == 0

    payload = json.loads((output / "merged-rules.json").read_text(encoding="utf-8"))
    assert list(payload) == ["extractionModel", "threshold", "pairCount", "extractedRuleCount", "mergedRules", "filteredRules"]
    assert payload["pairCount"] == 1
    assert payload["mergedRules"] == ["merged rule"]
    assert payload["filteredRules"] == ["filtered rule"]
    assert systems == [geo_cli.MERGER_SYSTEM, geo_cli.FILTER_SYSTEM]
    draft = (output / "engine-preference-rules_draft.md").read_text(encoding="utf-8")
    assert "RESUME: winner=vanilla, Δwordpos=0.001, rules=1" in draft
    assert "- filtered rule" in draft
    assert "[skip] RESUME (checkpoint exists)" in capsys.readouterr().err


def test_extract_rules_warns_for_malformed_extractor_output(
    capsys: CaptureFixture[str], monkeypatch: MonkeyPatch, tmp_path: Path
) -> None:
    _install_extract_fixtures(monkeypatch, [_golden("MALFORMED")])
    results = tmp_path / "scores.json"
    _write_results(results, [_score("MALFORMED", 0.3)])
    systems: list[str] = []

    async def complete(_config: Mapping[str, Any], system: str, _user: str) -> str:
        systems.append(system)
        if system == geo_cli.EXTRACTOR_SYSTEM:
            return "not an array"
        if system == geo_cli.MERGER_SYSTEM:
            return "[]"
        return "not an object"

    monkeypatch.setattr(geo_cli, "complete_with_provider", complete)
    output = tmp_path / "out"
    assert geo_cli.extract_rules_main(["--provider", "openai", "--results", str(results), "--out", str(output)], environ=_provider_env()) == 0

    payload = json.loads((output / "merged-rules.json").read_text(encoding="utf-8"))
    assert payload["extractedRuleCount"] == 0
    assert payload["mergedRules"] == []
    assert payload["filteredRules"] == []
    assert systems == [geo_cli.EXPLAINER_SYSTEM, geo_cli.EXTRACTOR_SYSTEM]
    assert "no JSON array in response" in capsys.readouterr().err


def test_extract_rules_keeps_pre_final_candidates_when_final_merge_is_empty(
    monkeypatch: MonkeyPatch, tmp_path: Path
) -> None:
    _install_extract_fixtures(monkeypatch, [_golden("FALLBACK")])
    results = tmp_path / "scores.json"
    _write_results(results, [_score("FALLBACK", 0.3)])

    async def complete(_config: Mapping[str, Any], system: str, _user: str) -> str:
        if system == geo_cli.EXTRACTOR_SYSTEM:
            return '["candidate rule"]'
        if system == geo_cli.MERGER_SYSTEM:
            return "[]"
        if system == geo_cli.FILTER_SYSTEM:
            return '{"modifiedRule":"candidate rule"}'
        return "explanation"

    monkeypatch.setattr(geo_cli, "complete_with_provider", complete)
    output = tmp_path / "out"
    assert geo_cli.extract_rules_main(["--provider", "openai", "--results", str(results), "--out", str(output)], environ=_provider_env()) == 0

    payload = json.loads((output / "merged-rules.json").read_text(encoding="utf-8"))
    assert payload["mergedRules"] == ["candidate rule"]
    assert payload["filteredRules"] == ["candidate rule"]


def test_extract_rules_hierarchical_merge_is_utf16_budgeted_sorted_and_filtered_in_order(
    monkeypatch: MonkeyPatch, tmp_path: Path
) -> None:
    _install_extract_fixtures(monkeypatch, [_golden("A"), _golden("B")])
    results = tmp_path / "scores.json"
    _write_results(results, [_score("A", 0.3), _score("B", 0.3)])
    output = tmp_path / "out"
    pairs = output / "pairs"
    pairs.mkdir(parents=True)
    for identifier, rule in (("A", "a" * 12_000), ("B", "😀" * 6_001)):
        (pairs / f"{identifier}.json").write_text(
            json.dumps(
                {
                    "goldenId": identifier,
                    "winnerVariant": "generated",
                    "wordposDelta": 0.3,
                    "explanation": "saved",
                    "rules": [rule],
                }
            ),
            encoding="utf-8",
        )
    merger_inputs: list[list[str]] = []
    filter_inputs: list[str] = []

    async def complete(_config: Mapping[str, Any], system: str, user: str) -> str:
        if system == geo_cli.MERGER_SYSTEM:
            rules_section = user.split("[Original Rules]\n", 1)[1].split("\n\n[Merged Rules JSON]", 1)[0]
            rules = [line.removeprefix("- ") for line in rules_section.split("\n") if line]
            merger_inputs.append(rules)
            return '["chunk-z"]' if len(merger_inputs) == 1 else '["chunk-a"]' if len(merger_inputs) == 2 else '["final-z", "final-a", "final-z"]'
        if system == geo_cli.FILTER_SYSTEM:
            filter_inputs.append(user.split("[Input Rule]\n\"", 1)[1].removesuffix("\"\n\n[Output JSON]"))
            return '{"modifiedRule":"' + filter_inputs[-1] + '"}'
        raise AssertionError("checkpointed pairs only perform merge/filter calls")

    monkeypatch.setattr(geo_cli, "complete_with_provider", complete)
    assert geo_cli.extract_rules_main(["--provider", "openai", "--results", str(results), "--out", str(output)], environ=_provider_env()) == 0

    payload = json.loads((output / "merged-rules.json").read_text(encoding="utf-8"))
    # 12,000 BMP code units plus 6,001 astral characters (12,002 JS code
    # units) must split at 24,000. Python's code-point ``len`` would not.
    assert [len(chunk) for chunk in merger_inputs[:2]] == [1, 1]
    assert merger_inputs[2] == ["chunk-a", "chunk-z"]
    assert payload["mergedRules"] == ["final-a", "final-z"]
    assert filter_inputs == ["final-a", "final-z"]
    assert payload["filteredRules"] == ["final-a", "final-z"]


def test_extract_rules_creates_checkpoint_directory_and_succeeds_for_zero_pairs(
    capsys: CaptureFixture[str], monkeypatch: MonkeyPatch, tmp_path: Path
) -> None:
    _install_extract_fixtures(monkeypatch, [_golden("LOW")])
    results = tmp_path / "scores.json"
    _write_results(results, [_score("LOW", 0.049)])
    output = tmp_path / "out"

    assert geo_cli.extract_rules_main(["--provider", "openai", "--results", str(results), "--out", str(output)], environ=_provider_env()) == 0

    assert (output / "pairs").is_dir()
    assert not (output / "merged-rules.json").exists()
    assert "Nothing to extract." in capsys.readouterr().err


def test_extract_rules_fails_no_score_input_after_creating_checkpoint_directory(
    capsys: CaptureFixture[str], tmp_path: Path
) -> None:
    results = tmp_path / "scores.json"
    results.write_text("{}", encoding="utf-8")
    output = tmp_path / "out"

    assert geo_cli.extract_rules_main(["--provider", "openai", "--results", str(results), "--out", str(output)], environ=_provider_env()) == 1

    assert (output / "pairs").is_dir()
    assert "No scores found" in capsys.readouterr().err


def _benchmark_result() -> dict[str, Any]:
    aggregates = {
        "goldens": 1,
        "engineId": "openai:test-model",
        "vanilla": {"wordpos": 0.1, "word": 0.1, "pos": 0.1},
        "generated": {"wordpos": 0.3, "word": 0.3, "pos": 0.3},
        "delta": {"wordpos": 0.2, "word": 0.2, "pos": 0.2},
        "byLocale": {},
        "byCepFocus": {},
        "gate": {"evaluated": 1, "passed": 1},
    }
    return {"engineId": "openai:test-model", "aggregates": aggregates, "scores": [{"goldenId": "ONLY"}]}


def test_benchmark_generates_every_artifact_before_filter_and_uses_script_adjacent_baseline(
    capsys: CaptureFixture[str], monkeypatch: MonkeyPatch, tmp_path: Path
) -> None:
    caller = tmp_path / "elsewhere"
    caller.mkdir()
    baseline = tmp_path / "apps" / "geo-generator" / "scripts" / "geo-benchmark-baseline.json"
    baseline.parent.mkdir(parents=True)
    baseline.write_text("{broken", encoding="utf-8")
    monkeypatch.setattr(
        geo_cli,
        "eval_products",
        {
            "sample_botanics-one": {"name": "English", "brand": "SampleBotanics", "category": "Serum"},
            "sample_derma-two": {"name": "Korean", "brand": "SampleDerma", "category": "Toner"},
        },
    )
    generated: list[dict[str, Any]] = []

    async def generate(input_: Mapping[str, Any], _options: Mapping[str, Any] | None = None) -> dict[str, Any]:
        generated.append(dict(input_))
        return await _generated_artifact(input_)

    options_seen: dict[str, Any] = {}

    async def run(options: Mapping[str, Any]) -> dict[str, Any]:
        options_seen.update(options)
        assert set(options["artifacts"]) == {"sample_botanics-one", "sample_derma-two"}
        return _benchmark_result()

    monkeypatch.setattr(geo_cli, "generate_pdp_geo", generate)
    monkeypatch.setattr(geo_cli, "run_geo_benchmark", run)
    monkeypatch.chdir(caller)

    assert geo_cli.benchmark_main(
        ["--provider", "openai", "--json", "--write", "--utility", "--golden", "ONLY", "--no-cache"],
        environ={**_provider_env(), "PDP_GEO_BENCHMARK_BASELINE_PATH": str(baseline)},
    ) == 0

    payload = json.loads(capsys.readouterr().out)
    assert list(payload) == ["status", "engineId", "aggregates", "scores"]
    assert [item["hints"] for item in generated] == [
        {"locale": "en-US", "market": "US", "brand": "SampleBotanics", "category": "Serum"},
        {"locale": "ko-KR", "market": "KR", "brand": "SampleDerma", "category": "Toner"},
    ]
    assert options_seen["goldenIds"] == ["ONLY"]
    assert options_seen["includeUtility"] is True
    assert options_seen["useCache"] is False
    assert not (caller / "geo-benchmark-baseline.json").exists()
    assert list(json.loads(baseline.read_text(encoding="utf-8"))) == ["generatedAt", "engineId", "aggregates"]


def test_benchmark_serializes_matching_baseline_fields_in_legacy_order(
    capsys: CaptureFixture[str], monkeypatch: MonkeyPatch, tmp_path: Path
) -> None:
    baseline = tmp_path / "geo-benchmark-baseline.json"
    prior = _benchmark_result()["aggregates"]
    prior = {
        **prior,
        "generated": {"wordpos": 0.1, "word": 0.1, "pos": 0.1},
        "delta": {"wordpos": 0.0, "word": 0.0, "pos": 0.0},
    }
    baseline.write_text(json.dumps({"generatedAt": "2026-01-02", "engineId": "openai:test-model", "aggregates": prior}), encoding="utf-8")
    monkeypatch.setattr(geo_cli, "eval_products", {"one": {"name": "One", "brand": "Neo", "category": "Serum"}})
    monkeypatch.setattr(geo_cli, "generate_pdp_geo", _generated_artifact)

    async def run(_options: Mapping[str, Any]) -> dict[str, Any]:
        return _benchmark_result()

    monkeypatch.setattr(geo_cli, "run_geo_benchmark", run)
    assert geo_cli.benchmark_main(
        ["--provider", "openai", "--json"], environ={**_provider_env(), "PDP_GEO_BENCHMARK_BASELINE_PATH": str(baseline)}
    ) == 0

    payload = json.loads(capsys.readouterr().out)
    assert list(payload) == [
        "status",
        "engineId",
        "aggregates",
        "baseline",
        "baselineEngineId",
        "baselineGeneratedAt",
        "deltaVsBaseline",
        "scores",
    ]
    assert payload["deltaVsBaseline"] == {"deltaWordpos": 0.2, "generatedWordpos": 0.2}


def test_console_entry_points_are_registered() -> None:
    package = Path(__file__).resolve().parents[1]
    with (package / "pyproject.toml").open("rb") as stream:
        scripts = tomllib.load(stream)["project"]["scripts"]
    assert scripts["pdp-geo-extract-rules"] == "pdp_geo_generator_agent.geo_cli:extract_rules_main"
    assert scripts["pdp-geo-benchmark"] == "pdp_geo_generator_agent.geo_cli:benchmark_main"


def test_extract_rules_sorts_every_boundary_like_default_javascript_sort(
    monkeypatch: MonkeyPatch, tmp_path: Path
) -> None:
    """Rule order must be UTF-16 code-unit order before every model/output boundary."""
    astral = "😀"
    private_use = "\ue000"
    long_rule = "a" * 23_998
    _install_extract_fixtures(monkeypatch, [_golden("A"), _golden("B")])
    results = tmp_path / "scores.json"
    _write_results(results, [_score("A", 0.3), _score("B", 0.3)])
    output = tmp_path / "out"
    pairs = output / "pairs"
    pairs.mkdir(parents=True)
    for identifier, rules in (("A", [private_use, long_rule, astral, astral]), ("B", [private_use])):
        (pairs / f"{identifier}.json").write_text(
            json.dumps(
                {
                    "goldenId": identifier,
                    "winnerVariant": "generated",
                    "wordposDelta": 0.3,
                    "explanation": "saved",
                    "rules": rules,
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

    merger_inputs: list[list[str]] = []
    filter_inputs: list[str] = []

    async def complete(_config: Mapping[str, Any], system: str, user: str) -> str:
        if system == geo_cli.MERGER_SYSTEM:
            rules_section = user.split("[Original Rules]\n", 1)[1].split("\n\n[Merged Rules JSON]", 1)[0]
            merger_inputs.append([line.removeprefix("- ") for line in rules_section.splitlines() if line])
            if len(merger_inputs) == 1:
                return json.dumps([astral, private_use, astral], ensure_ascii=False)
            if len(merger_inputs) == 2:
                return json.dumps([private_use], ensure_ascii=False)
            return json.dumps([private_use, astral, private_use], ensure_ascii=False)
        if system == geo_cli.FILTER_SYSTEM:
            rule = user.split('[Input Rule]\n"', 1)[1].removesuffix('"\n\n[Output JSON]')
            filter_inputs.append(rule)
            return json.dumps({"modifiedRule": rule}, ensure_ascii=False)
        raise AssertionError("checkpointed inputs should not explain or extract")

    monkeypatch.setattr(geo_cli, "complete_with_provider", complete)
    assert geo_cli.extract_rules_main(
        ["--provider", "openai", "--results", str(results), "--out", str(output)], environ=_provider_env()
    ) == 0

    # ``😀`` starts with D83D in UTF-16, which sorts before BMP private-use
    # E000.  It also must sit in the first 24,000-unit chunk with the long
    # ASCII rule; the duplicate is eliminated at each boundary.
    assert merger_inputs == [[long_rule, astral], [private_use], [astral, private_use]]
    assert filter_inputs == [astral, private_use]
    payload = json.loads((output / "merged-rules.json").read_text(encoding="utf-8"))
    assert payload["mergedRules"] == [astral, private_use]
    assert payload["filteredRules"] == [astral, private_use]
    assert "## Observed rules (filtered)\n\n- 😀\n- \ue000\n" in (output / "engine-preference-rules_draft.md").read_text(
        encoding="utf-8"
    )


@pytest.mark.parametrize(
    ("threshold", "score", "expected_pairs"),
    [
        ("0.05junk", 0.01, 0),
        ("1_0", 2.0, 1),
        ("\ufeff0junk", -0.0, 1),
        ("", 0.01, 1),
        ("١", 0.01, 1),
    ],
)
def test_extract_rules_uses_javascript_parse_float_prefixes(
    capsys: CaptureFixture[str], monkeypatch: MonkeyPatch, tmp_path: Path, threshold: str, score: float, expected_pairs: int
) -> None:
    _install_extract_fixtures(monkeypatch, [_golden("NUMBER")])
    results = tmp_path / "scores.json"
    _write_results(results, [_score("NUMBER", score)])

    async def complete(_config: Mapping[str, Any], system: str, _user: str) -> str:
        if system == geo_cli.EXTRACTOR_SYSTEM:
            return "[]"
        if system == geo_cli.MERGER_SYSTEM:
            return "[]"
        return "explanation"

    monkeypatch.setattr(geo_cli, "complete_with_provider", complete)
    assert geo_cli.extract_rules_main(
        ["--provider", "openai", "--results", str(results), "--out", str(tmp_path / "out"), "--threshold", threshold],
        environ=_provider_env(),
    ) == 0
    assert f"Found {expected_pairs} preference pair(s)" in capsys.readouterr().err


def test_extract_rules_delegates_empty_threshold_to_shared_parse_float(
    capsys: CaptureFixture[str], monkeypatch: MonkeyPatch, tmp_path: Path
) -> None:
    _install_extract_fixtures(monkeypatch, [_golden("SHARED-PARSE")])
    results = tmp_path / "scores.json"
    _write_results(results, [_score("SHARED-PARSE", 0.01)])
    parsed: list[str] = []

    def parse_float(value: str) -> float:
        parsed.append(value)
        return math.nan

    async def complete(_config: Mapping[str, Any], system: str, _user: str) -> str:
        return "[]" if system in {geo_cli.EXTRACTOR_SYSTEM, geo_cli.MERGER_SYSTEM} else "explanation"

    monkeypatch.setattr(geo_cli, "js_parse_float", parse_float, raising=False)
    monkeypatch.setattr(geo_cli, "complete_with_provider", complete)
    assert geo_cli.extract_rules_main(
        ["--provider", "openai", "--results", str(results), "--out", str(tmp_path / "out"), "--threshold", ""],
        environ=_provider_env(),
    ) == 0

    assert parsed == [""]
    assert "Found 1 preference pair(s)" in capsys.readouterr().err


def test_extract_rules_carries_lone_surrogate_between_real_provider_calls(
    monkeypatch: MonkeyPatch, tmp_path: Path
) -> None:
    _install_extract_fixtures(monkeypatch, [_golden("PROVIDER-SURROGATE")])
    results = tmp_path / "scores.json"
    _write_results(results, [_score("PROVIDER-SURROGATE", 0.3)])
    output = tmp_path / "out"
    requests: list[bytes] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request.content)
        if len(requests) == 1:
            return httpx.Response(200, content=b'{"output_text":"explanation \\ud800"}')
        return httpx.Response(200, content=b'{"output_text":"[\\"extracted rule\\"]"}')

    transport = httpx.MockTransport(handler)

    async def complete(config: Mapping[str, Any], system: str, user: str) -> str:
        if system in {geo_cli.EXPLAINER_SYSTEM, geo_cli.EXTRACTOR_SYSTEM}:
            async with httpx.AsyncClient(transport=transport) as client:
                return await evaluator_complete_with_provider(config, system, user, client=client)
        if system == geo_cli.MERGER_SYSTEM:
            return '["merged rule"]'
        if system == geo_cli.FILTER_SYSTEM:
            return '{"modifiedRule":"filtered rule"}'
        raise AssertionError(f"unexpected provider system prompt: {system}")

    monkeypatch.setattr(geo_cli, "complete_with_provider", complete)
    assert geo_cli.extract_rules_main(
        ["--provider", "openai", "--results", str(results), "--out", str(output)], environ=_provider_env()
    ) == 0

    assert len(requests) == 2
    assert b"\\ud800" not in requests[0]
    assert b"[Explanation]\\nexplanation \\ud800" in requests[1]
    assert requests[1].count(b"\\ud800") == 1
    assert b"\xed\xa0\x80" not in requests[1]
    assert json.loads((output / "merged-rules.json").read_text(encoding="utf-8"))["filteredRules"] == ["filtered rule"]


def test_extract_rules_keeps_checkpoint_rules_verbatim_for_merge_and_draft_count(
    capsys: CaptureFixture[str], monkeypatch: MonkeyPatch, tmp_path: Path
) -> None:
    _install_extract_fixtures(monkeypatch, [_golden("VERBATIM")])
    results = tmp_path / "scores.json"
    _write_results(results, [_score("VERBATIM", 0.3)])
    output = tmp_path / "out"
    pairs = output / "pairs"
    pairs.mkdir(parents=True)
    (pairs / "VERBATIM.json").write_text(
        json.dumps(
            {
                "goldenId": "VERBATIM",
                "winnerVariant": "generated",
                "wordposDelta": 0.3,
                "explanation": "saved",
                "rules": ["\ufeffkept verbatim\ufeff", "\ufeff", ""],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    merger_prompts: list[str] = []

    async def complete(_config: Mapping[str, Any], system: str, user: str) -> str:
        if system == geo_cli.MERGER_SYSTEM:
            merger_prompts.append(user)
            return '["merged"]'
        if system == geo_cli.FILTER_SYSTEM:
            return '{"modifiedRule":"filtered"}'
        raise AssertionError("a checkpointed pair must not invoke explainer or extractor")

    monkeypatch.setattr(geo_cli, "complete_with_provider", complete)
    assert geo_cli.extract_rules_main(
        ["--provider", "openai", "--results", str(results), "--out", str(output)], environ=_provider_env()
    ) == 0

    assert len(merger_prompts) == 1
    merged_input = merger_prompts[0].split("[Original Rules]\n", 1)[1].split("\n\n[Merged Rules JSON]", 1)[0]
    assert merged_input == "- \n- \ufeff\n- \ufeffkept verbatim\ufeff"
    captured = capsys.readouterr().err
    assert "Merging 3 unique rule candidate(s)" in captured
    assert "VERBATIM: winner=generated, Δwordpos=0.3, rules=3" in (
        output / "engine-preference-rules_draft.md"
    ).read_text(encoding="utf-8")


@pytest.mark.parametrize(
    ("threshold", "score", "threshold_text", "delta_text"),
    [
        ("1e-7", 1.0, "1e-7", "1"),
        ("1e-6", 1.0, "0.000001", "1"),
        ("1e21", 1e22, "1e+21", "1e+22"),
        ("1.0000000000000001e18", 1e19, "1000000000000000100", "10000000000000000000"),
        ("1", 2.0, "1", "2"),
    ],
)
def test_extract_rules_uses_shared_javascript_number_text_at_public_boundaries(
    capsys: CaptureFixture[str], monkeypatch: MonkeyPatch, tmp_path: Path, threshold: str, score: float, threshold_text: str, delta_text: str
) -> None:
    _install_extract_fixtures(monkeypatch, [_golden("NUMBER-TEXT")])
    results = tmp_path / "scores.json"
    _write_results(results, [_score("NUMBER-TEXT", score)])
    output = tmp_path / "out"

    async def complete(_config: Mapping[str, Any], system: str, _user: str) -> str:
        return "[]" if system == geo_cli.EXTRACTOR_SYSTEM else "explanation"

    monkeypatch.setattr(geo_cli, "complete_with_provider", complete)
    assert geo_cli.extract_rules_main(
        ["--provider", "openai", "--results", str(results), "--out", str(output), "--threshold", threshold],
        environ=_provider_env(),
    ) == 0

    checkpoint = (output / "pairs" / "NUMBER-TEXT.json").read_text(encoding="utf-8")
    merged = (output / "merged-rules.json").read_text(encoding="utf-8")
    draft = (output / "engine-preference-rules_draft.md").read_text(encoding="utf-8")
    assert f'"wordposDelta": {delta_text}' in checkpoint
    assert f'"threshold": {threshold_text}' in merged
    assert f"|Δwordpos| >= {threshold_text}" in draft
    assert f"|Δwordpos| >= {threshold_text}" in capsys.readouterr().err


def test_extract_rules_rejects_unicode_casefolded_json_fence_label(
    capsys: CaptureFixture[str], monkeypatch: MonkeyPatch, tmp_path: Path
) -> None:
    _install_extract_fixtures(monkeypatch, [_golden("FENCE")])
    results = tmp_path / "scores.json"
    _write_results(results, [_score("FENCE", 0.3)])

    async def complete(_config: Mapping[str, Any], system: str, _user: str) -> str:
        if system == geo_cli.EXTRACTOR_SYSTEM:
            return "```jſonBROKEN```"
        return "explanation"

    monkeypatch.setattr(geo_cli, "complete_with_provider", complete)
    assert geo_cli.extract_rules_main(
        ["--provider", "openai", "--results", str(results), "--out", str(tmp_path / "out")], environ=_provider_env()
    ) == 0
    assert "preview: jſonBROKEN…" in capsys.readouterr().err


def test_extract_rules_matches_js_fences_trim_json_and_utf16_preview_at_file_boundaries(
    capsys: CaptureFixture[str], monkeypatch: MonkeyPatch, tmp_path: Path
) -> None:
    _install_extract_fixtures(monkeypatch, [_golden("TEXT")])
    results = tmp_path / "scores.json"
    _write_results(results, [_score("TEXT", -0.0)])
    output = tmp_path / "out"
    responses = iter(
        [
            "explanation",
            '```JsOn["\\ufeffkeep\\ufeff", "\\u0085", "\\ud800"]```',
            '```JSON["\\ud800", "\\u0085", "keep"]```',
            '```json{"modifiedRule":"\\ud800"}```',
            '```JSON{"modifiedRule":"\\u0085"}```',
            '```json{"modifiedRule":"\\ufeffkeep\\ufeff"}```',
        ]
    )

    async def complete(_config: Mapping[str, Any], _system: str, _user: str) -> str:
        return next(responses)

    monkeypatch.setattr(geo_cli, "complete_with_provider", complete)
    assert geo_cli.extract_rules_main(
        ["--provider", "openai", "--results", str(results), "--out", str(output), "--threshold", "\ufeff0junk"],
        environ=_provider_env(),
    ) == 0

    checkpoint = (output / "pairs" / "TEXT.json").read_text(encoding="utf-8")
    merged = (output / "merged-rules.json").read_text(encoding="utf-8")
    draft = (output / "engine-preference-rules_draft.md").read_text(encoding="utf-8")
    assert '"wordposDelta": 0' in checkpoint
    assert '"threshold": 0' in merged
    assert "\\ud800" in checkpoint and "\\ud800" in merged
    assert '"rules": [\n    "keep",\n    "\u0085",\n    "\\ud800"' in checkpoint
    assert '"mergedRules": [\n    "keep",\n    "\u0085",\n    "\\ud800"' in merged
    # Node's UTF-8 write replaces a lone surrogate in the Markdown template.
    assert "- keep\n- \u0085\n- �\n" in draft

    malformed = "a" + ("😀" * 60)

    async def malformed_completion(_config: Mapping[str, Any], _system: str, _user: str) -> str:
        return malformed

    monkeypatch.setattr(geo_cli, "complete_with_provider", malformed_completion)
    _install_extract_fixtures(monkeypatch, [_golden("PREVIEW")])
    _write_results(results, [_score("PREVIEW", 0.3)])
    assert geo_cli.extract_rules_main(
        ["--provider", "openai", "--results", str(results), "--out", str(tmp_path / "preview")], environ=_provider_env()
    ) == 0
    expected_preview = "a" + ("😀" * 59) + "�"
    assert f"preview: {expected_preview}…" in capsys.readouterr().err


def _valid_baseline(*, engine_id: str = "openai:test-model") -> dict[str, object]:
    return {"generatedAt": "2026-01-02", "engineId": engine_id, "aggregates": _benchmark_result()["aggregates"]}


def _install_benchmark_fakes(monkeypatch: MonkeyPatch, result: Mapping[str, object] | None = None) -> None:
    monkeypatch.setattr(geo_cli, "eval_products", {"one": {"name": "One", "brand": "Neo", "category": "Serum"}})
    monkeypatch.setattr(geo_cli, "generate_pdp_geo", _generated_artifact)

    async def run(_options: Mapping[str, Any]) -> dict[str, Any]:
        return dict(_benchmark_result() if result is None else result)

    monkeypatch.setattr(geo_cli, "run_geo_benchmark", run)


@pytest.mark.parametrize(
    "raw_baseline",
    [
        b"\xff\xfe",
        b'{"generatedAt":"2026-01-02","engineId":"openai:test-model","aggregates":{"goldens":NaN}}',
        b'{"generatedAt":"2026-01-02","engineId":"openai:test-model","aggregates":{"goldens":Infinity}}',
        b"[]",
        b'{"engineId":"openai:test-model"}',
        b'{"generatedAt":1,"engineId":"openai:test-model","aggregates":{}}',
        b'{"generatedAt":"2026-01-02","engineId":"openai:test-model","aggregates":{"goldens":"1"}}',
        json.dumps(
            {
                "generatedAt": "2026-01-02",
                "engineId": "openai:test-model",
                "aggregates": {**_benchmark_result()["aggregates"], "byLocale": []},
            }
        ).encode(),
        json.dumps(
            {
                "generatedAt": "2026-01-02",
                "engineId": "openai:test-model",
                "aggregates": {**_benchmark_result()["aggregates"], "utility": {}},
            }
        ).encode(),
    ],
)
def test_benchmark_treats_all_malformed_baselines_as_absent(
    capsys: CaptureFixture[str], monkeypatch: MonkeyPatch, tmp_path: Path, raw_baseline: bytes
) -> None:
    baseline = tmp_path / "configured" / "geo-benchmark-baseline.json"
    baseline.parent.mkdir()
    baseline.write_bytes(raw_baseline)
    _install_benchmark_fakes(monkeypatch)

    assert geo_cli.benchmark_main(
        ["--provider", "openai", "--json"],
        environ={**_provider_env(), "PDP_GEO_BENCHMARK_BASELINE_PATH": str(baseline)},
    ) == 0
    payload = json.loads(capsys.readouterr().out)
    assert list(payload) == ["status", "engineId", "aggregates", "scores"]


def test_benchmark_resolves_real_source_target_or_explicit_standalone_target(tmp_path: Path) -> None:
    package = Path(__file__).resolve().parents[1]
    expected_source_target = package.parents[1] / "apps" / "geo-generator" / "scripts" / "geo-benchmark-baseline.json"
    assert geo_cli.resolve_benchmark_baseline_path({}) == expected_source_target
    configured = tmp_path / "retained" / "apps" / "geo-generator" / "scripts" / "geo-benchmark-baseline.json"
    assert geo_cli.resolve_benchmark_baseline_path({"PDP_GEO_BENCHMARK_BASELINE_PATH": str(configured)}) == configured


def test_fresh_wheel_console_command_reads_and_writes_explicit_baseline_from_another_cwd(tmp_path: Path) -> None:
    """A wheel must not guess a repository; its configured target is portable."""
    package = Path(__file__).resolve().parents[1]
    repository = package.parents[1]
    wheel_dir = tmp_path / "wheels"
    venv = tmp_path / "venv"
    subprocess.run(
        ["uv", "build", "--package", "pdp-geo-generator-agent", "--wheel", "--out-dir", str(wheel_dir)],
        cwd=repository,
        check=True,
        capture_output=True,
        text=True,
    )
    wheel = next(wheel_dir.glob("pdp_geo_generator_agent-*.whl"))
    subprocess.run(["uv", "venv", str(venv)], check=True, capture_output=True, text=True)
    python = venv / "bin" / "python"
    subprocess.run(["uv", "pip", "install", "--python", str(python), "--no-deps", str(wheel)], check=True, capture_output=True, text=True)
    subprocess.run(
        [
            "uv",
            "pip",
            "install",
            "--python",
            str(python),
            str(repository / "packages" / "neo-js-compat"),
            str(repository / "packages" / "pdp-geo-eval-agent"),
            "pydantic",
            "PyICU",
            "ada-url==4.0.0",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    support = tmp_path / "support"
    support.mkdir()
    (support / "sitecustomize.py").write_text(
        """import pdp_geo_generator_agent.geo_cli as cli

async def generate(input_, _options=None):
    product = input_[\"product\"]
    return {\"result\": {\"content\": {\"sections\": {\"productName\": product[\"name\"], \"description\": \"generated\"}}}, \"diagnostics\": {\"evidenceLedger\": []}}

async def run(_options):
    aggregates = {\"goldens\": 1, \"engineId\": \"openai:wheel-model\", \"vanilla\": {\"wordpos\": 0.1, \"word\": 0.1, \"pos\": 0.1}, \"generated\": {\"wordpos\": 0.3, \"word\": 0.3, \"pos\": 0.3}, \"delta\": {\"wordpos\": 0.2, \"word\": 0.2, \"pos\": 0.2}, \"byLocale\": {}, \"byCepFocus\": {}, \"gate\": {\"evaluated\": 1, \"passed\": 1}}
    return {\"engineId\": \"openai:wheel-model\", \"aggregates\": aggregates, \"scores\": []}

cli.eval_products = {\"one\": {\"name\": \"Wheel product\", \"brand\": \"Neo\", \"category\": \"Serum\"}}
cli.generate_pdp_geo = generate
cli.run_geo_benchmark = run
""",
        encoding="utf-8",
    )
    baseline = tmp_path / "retained" / "apps" / "geo-generator" / "scripts" / "geo-benchmark-baseline.json"
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    environment = {
        **os.environ,
        "PYTHONPATH": str(support),
        "OPENAI_API_KEY": "test-key",
        "OPENAI_MODEL": "wheel-model",
        "PDP_GEO_BENCHMARK_BASELINE_PATH": str(baseline),
    }
    command = [str(venv / "bin" / "pdp-geo-benchmark"), "--provider", "openai", "--json"]
    first = subprocess.run([*command, "--write"], cwd=elsewhere, env=environment, check=True, capture_output=True, text=True)
    second = subprocess.run(command, cwd=elsewhere, env=environment, check=True, capture_output=True, text=True)
    assert json.loads(first.stdout)["status"] == "ok"
    assert json.loads(baseline.read_text(encoding="utf-8"))["engineId"] == "openai:wheel-model"
    assert json.loads(second.stdout)["baselineEngineId"] == "openai:wheel-model"
    assert not (elsewhere / "geo-benchmark-baseline.json").exists()


def test_benchmark_json_and_write_use_json_stringify_safe_numbers(
    monkeypatch: MonkeyPatch, tmp_path: Path
) -> None:
    result = _benchmark_result()
    aggregates = result["aggregates"]
    aggregates["vanilla"] = {"wordpos": -0.0, "word": math.nan, "pos": math.inf}
    baseline = tmp_path / "configured" / "geo-benchmark-baseline.json"
    _install_benchmark_fakes(monkeypatch, result)
    stdout = StringIO()
    assert geo_cli.benchmark_main(
        ["--provider", "openai", "--json", "--write"],
        environ={**_provider_env(), "PDP_GEO_BENCHMARK_BASELINE_PATH": str(baseline)},
        stdout=stdout,
    ) == 0
    assert '"wordpos": 0' in stdout.getvalue()
    assert '"word": null' in stdout.getvalue()
    assert '"pos": null' in stdout.getvalue()
    assert "NaN" not in stdout.getvalue() and "Infinity" not in stdout.getvalue()
    written = baseline.read_text(encoding="utf-8")
    assert '"wordpos": 0' in written and '"word": null' in written and '"pos": null' in written


def test_benchmark_json_uses_json_stringify_two_space_layout_for_literals_and_numbers(
    monkeypatch: MonkeyPatch, tmp_path: Path
) -> None:
    result = _benchmark_result()
    aggregates = result["aggregates"]
    result["engineId"] = "openai:literal,[]{}"
    aggregates["engineId"] = "openai:literal,[]{}"
    aggregates["vanilla"] = {"wordpos": 1e-6, "word": 0.1, "pos": 0.1}
    _install_benchmark_fakes(monkeypatch, result)
    stdout = StringIO()

    assert geo_cli.benchmark_main(
        ["--provider", "openai", "--json"],
        environ={**_provider_env(), "PDP_GEO_BENCHMARK_BASELINE_PATH": str(tmp_path / "baseline.json")},
        stdout=stdout,
    ) == 0

    assert stdout.getvalue().startswith("{\n  \"status\": \"ok\",\n  \"engineId\": \"openai:literal,[]{}\",\n")
    assert '\n      "wordpos": 0.000001,\n' in stdout.getvalue()


def test_benchmark_human_stdout_uses_javascript_numbers_and_all_report_branches(
    monkeypatch: MonkeyPatch, tmp_path: Path
) -> None:
    result: dict[str, object] = {
        "engineId": "openai:test-model",
        "scores": [
            {
                "goldenId": "ONLY",
                "cepFocus": "need",
                "vanilla": {"wordpos": 0.0, "cachedAnswer": True, "hallucinatedCitations": [1, 2]},
                "generated": {"wordpos": 0.5, "cachedAnswer": True, "hallucinatedCitations": [2, 3]},
                "delta": {"wordpos": 0.5},
                "gate": {"pass": False, "failures": ["citation evidence"]},
            }
        ],
        "aggregates": {
            "goldens": 1,
            "engineId": "openai:test-model",
            "vanilla": {"wordpos": 0.0, "word": 1.0, "pos": 0.5},
            "generated": {"wordpos": 1.0, "word": 0.0, "pos": 0.25},
            "delta": {"wordpos": 1.0, "word": -1.0, "pos": -0.25},
            "gate": {"passed": 0, "evaluated": 1},
            "utility": {"meanKpr": 0.0, "meanKpc": 1.0, "meanCitationPrecision": 0.5, "meanCitationRecall": None},
            "byLocale": {
                "en-US": {
                    "goldens": 1,
                    "vanilla": {"wordpos": 0.0},
                    "generated": {"wordpos": 1.0},
                    "delta": {"wordpos": 1.0},
                }
            },
            "byCepFocus": {"need": {"goldens": 1, "delta": {"wordpos": -0.25}}},
        },
    }
    baseline = tmp_path / "configured" / "geo-benchmark-baseline.json"
    baseline.parent.mkdir()
    matching = _valid_baseline()
    matching["aggregates"] = {
        **_benchmark_result()["aggregates"],
        "generated": {"wordpos": 0.0, "word": 0.3, "pos": 0.3},
        "delta": {"wordpos": 0.0, "word": 0.2, "pos": 0.2},
    }
    baseline.write_text(json.dumps(matching), encoding="utf-8")
    _install_benchmark_fakes(monkeypatch, result)
    stdout = StringIO()
    assert geo_cli.benchmark_main(
        ["--provider", "openai"],
        environ={**_provider_env(), "PDP_GEO_BENCHMARK_BASELINE_PATH": str(baseline)},
        stdout=stdout,
    ) == 0
    assert stdout.getvalue() == """Engine: openai:test-model

Per-golden citation share (wordpos, vanilla → generated):
  ONLY           need       0.000 → 0.500  Δ=+0.500 (cached)  GATE FAIL
      fail: citation evidence
      hallucinated citations ignored: [1, 2, 3]

Aggregates (mean share-of-voice across goldens):
  vanilla    wordpos=0 word=1 pos=0.5
  generated  wordpos=1 word=0 pos=0.25
  delta      wordpos=+1.000 word=-1.000 pos=-0.250
  gate       0/1 passed
  utility    KPR=0 KPC=1 citationP=0.5 citationR=-
  by locale:
    en-US    Δwordpos=+1.000 (vanilla 0 → generated 1, n=1)
  by CEP focus:
    need       Δwordpos=-0.250 (n=1)

Baseline: geo-benchmark-baseline.json (2026-01-02, openai:test-model)
  Δ(delta.wordpos) vs baseline: +1.000
  Δ(generated.wordpos) vs baseline: +1.000
"""

    baseline.write_text(json.dumps(_valid_baseline(engine_id="other-engine")), encoding="utf-8")
    other_stdout = StringIO()
    assert geo_cli.benchmark_main(
        ["--provider", "openai"],
        environ={**_provider_env(), "PDP_GEO_BENCHMARK_BASELINE_PATH": str(baseline)},
        stdout=other_stdout,
    ) == 0
    assert other_stdout.getvalue().endswith("\nBaseline exists for a different engine (other-engine); no comparison shown.\n")


def test_benchmark_human_report_uses_javascript_to_fixed_for_edge_values(
    monkeypatch: MonkeyPatch, tmp_path: Path
) -> None:
    result: dict[str, object] = {
        "engineId": "openai:test-model",
        "scores": [
            {
                "goldenId": "POSITIVE",
                "cepFocus": "half",
                "vanilla": {"wordpos": 0.0, "hallucinatedCitations": []},
                "generated": {"wordpos": 0.0625, "hallucinatedCitations": []},
                "delta": {"wordpos": 0.0625},
                "gate": {"pass": True, "failures": []},
            },
            {
                "goldenId": "NEGATIVE",
                "cepFocus": "half",
                "vanilla": {"wordpos": 0.0625, "hallucinatedCitations": []},
                "generated": {"wordpos": -0.0, "hallucinatedCitations": []},
                "delta": {"wordpos": -0.0625},
                "gate": {"pass": True, "failures": []},
            },
            {
                "goldenId": "SMALL",
                "cepFocus": "edge",
                "vanilla": {"wordpos": math.nan, "hallucinatedCitations": []},
                "generated": {"wordpos": math.inf, "hallucinatedCitations": []},
                "delta": {"wordpos": -0.0004},
                "gate": {"pass": True, "failures": []},
            },
            {
                "goldenId": "HIGH",
                "cepFocus": "edge",
                "vanilla": {"wordpos": 1e21, "hallucinatedCitations": []},
                "generated": {"wordpos": 1e21, "hallucinatedCitations": []},
                "delta": {"wordpos": 1e21},
                "gate": {"pass": True, "failures": []},
            },
        ],
        "aggregates": {
            "goldens": 4,
            "engineId": "openai:test-model",
            "vanilla": {"wordpos": 0.0, "word": 0.0, "pos": 0.0},
            "generated": {"wordpos": 0.0, "word": 0.0, "pos": 0.0},
            "delta": {"wordpos": 0.0, "word": 0.0, "pos": 0.0},
            "gate": {"passed": 4, "evaluated": 4},
            "byLocale": {},
            "byCepFocus": {},
        },
    }
    _install_benchmark_fakes(monkeypatch, result)
    stdout = StringIO()

    assert geo_cli.benchmark_main(
        ["--provider", "openai"],
        environ={**_provider_env(), "PDP_GEO_BENCHMARK_BASELINE_PATH": str(tmp_path / "baseline.json")},
        stdout=stdout,
    ) == 0

    report = stdout.getvalue()
    assert "0.000 → 0.063  Δ=+0.063" in report
    assert "0.063 → 0.000  Δ=-0.063" in report
    assert "NaN → Infinity  Δ=-0.000" in report
    assert "1e+21 → 1e+21  Δ=+1e+21" in report


def _type_suppression_comments(source: str) -> list[str]:
    return [
        token.string
        for token in tokenize.generate_tokens(StringIO(source).readline)
        if token.type == tokenize.COMMENT and ("type: ignore" in token.string or "pyright:" in token.string)
    ]


@pytest.mark.parametrize(
    "source",
    [
        "value = 1  " + "#" + " type: ignore[assignment]\\n",
        "value = 1  " + "#" + " pyright: ignore[reportGeneralTypeIssues]\\n",
    ],
)
def test_type_suppression_comment_scan_rejects_inline_forms(source: str) -> None:
    assert _type_suppression_comments(source)


def test_geo_cli_has_no_pyright_suppressions() -> None:
    package = Path(__file__).resolve().parents[1]
    for path in (package / "src" / "pdp_geo_generator_agent" / "geo_cli.py", Path(__file__)):
        source = path.read_text(encoding="utf-8")
        assert not _type_suppression_comments(source)
