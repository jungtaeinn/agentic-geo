"""Behavioral port of the benchmark corpus and assembly integrity suite."""

from __future__ import annotations

import importlib

import pytest


def _source_text():
    return importlib.import_module("pdp_geo_eval_agent.citation.source_text")


def test_builds_nonempty_vanilla_text_from_normalized_product_signals() -> None:
    source_text = _source_text()
    product = {
        "brand": "별모래 테스트 랩",
        "name": "워터폴드 캡슐 토너",
        "category": "토너",
        "sourceTexts": ["세안 뒤 첫 단계에서 피부결을 편안하게 정돈하는 합성 보습 토너 예시입니다."],
        "benefits": ["장벽 보습", "피부결 정돈"],
        "effects": ["세안 뒤 당김이 덜 느껴지는 사용감"],
        "ingredients": ["수분결 리포좀"],
        "usage": ["세안 직후 손바닥에 덜어 가볍게 눌러 흡수시킵니다."],
        "faq": [{"question": "토너 안의 리포좀 입자는 어떻게 사용하나요?", "answer": "사용 전 가볍게 흔든 뒤 손바닥에 덜어 사용하는 합성 안내입니다."}],
        "reviews": {"keywords": ["촉촉함"]},
    }

    text = source_text.build_vanilla_source_text(product)

    assert "별모래 테스트 랩 워터폴드 캡슐 토너" in text
    assert "Category: 토너" in text
    assert "Benefits: 장벽 보습, 피부결 정돈" in text
    assert "Q: 토너 안의 리포좀 입자는 어떻게 사용하나요? A: 사용 전 가볍게 흔든 뒤 손바닥에 덜어 사용하는 합성 안내입니다." in text


def _benchmark():
    return importlib.import_module("pdp_geo_eval_agent.benchmark")


def _probe():
    return importlib.import_module("pdp_geo_eval_agent.citation.probe")


def test_benchmark_goldens_cover_every_fixture_with_all_cep_focuses() -> None:
    benchmark = _benchmark()
    for product_id in benchmark.eval_products:
        focuses = sorted(golden["cepFocus"] for golden in benchmark.geo_eval_goldens if golden["productId"] == product_id)
        assert focuses == ["concern", "need", "routine", "selection"]


def test_benchmark_goldens_have_unique_ids_and_locale_market_consistency() -> None:
    benchmark = _benchmark()
    identifiers = [golden["id"] for golden in benchmark.geo_eval_goldens]
    assert len(set(identifiers)) == len(identifiers)
    for golden in benchmark.geo_eval_goldens:
        assert golden["market"] == ("KR" if golden["locale"] == "ko-KR" else "US")


def test_frozen_distractors_are_four_per_product_and_do_not_name_target() -> None:
    benchmark = _benchmark()
    for product_id, product in benchmark.eval_products.items():
        distractors = benchmark.geo_eval_distractors[product_id]
        assert len(distractors) == 4
        for document in distractors:
            assert len(document.strip()) > 100
            assert product["name"].lower() not in document.lower()


def test_build_source_set_keeps_target_in_fixed_slot_and_preserves_distractor_order() -> None:
    benchmark = _benchmark()
    sources = benchmark.build_source_set("byeolmorae-waterfold-toner", "TARGET-DOC")
    assert len(sources) == 5
    assert sources[benchmark.GEO_EVAL_TARGET_SLOT] == "TARGET-DOC"
    assert [source for index, source in enumerate(sources) if index != benchmark.GEO_EVAL_TARGET_SLOT] == benchmark.geo_eval_distractors["byeolmorae-waterfold-toner"]


def test_vanilla_source_is_non_empty_and_names_each_fixture_product() -> None:
    benchmark = _benchmark()
    source_text = _source_text()
    for product in benchmark.eval_products.values():
        text = source_text.build_vanilla_source_text(product)
        assert len(text) > 200
        assert product["name"] in text


def test_benchmark_generated_section_flattening_drops_empty_sections() -> None:
    probe = _probe()
    assert probe.build_generated_source_text({"productName": "Name", "description": "Description body.", "quickFacts": "", "benefits": "Benefit line.", "ingredients": "", "howToUse": "", "faq": ""}) == "Name\n\nDescription body.\n\nBenefit line."


def test_aggregate_geo_scores_averages_pairs_and_groups_locale_and_cep_focus() -> None:
    benchmark = _benchmark()

    def score(**overrides: object) -> dict[str, object]:
        result: dict[str, object] = {
            "goldenId": "X", "productId": "byeolmorae-waterfold-toner", "locale": "ko-KR", "cepFocus": "need", "query": "q",
            "vanilla": {"wordpos": 0.2, "word": 0.2, "pos": 0.2, "citedSentenceCount": 3, "sentenceCount": 4, "hallucinatedCitations": [], "cachedAnswer": False},
            "generated": {"wordpos": 0.4, "word": 0.3, "pos": 0.5, "citedSentenceCount": 4, "sentenceCount": 4, "hallucinatedCitations": [], "cachedAnswer": False},
            "delta": {"wordpos": 0.2, "word": 0.1, "pos": 0.3},
            "gate": {"pass": True, "failures": [], "skippedChecks": []},
        }
        return result | overrides

    aggregates = benchmark.aggregate_geo_scores([
        score(goldenId="A"),
        score(goldenId="B", locale="en-US", cepFocus="routine", delta={"wordpos": 0, "word": 0, "pos": 0}, gate={"pass": False, "failures": ["x"], "skippedChecks": []}),
    ], "azure-openai:test")
    assert aggregates["goldens"] == 2
    assert aggregates["delta"]["wordpos"] == pytest.approx(0.1)
    assert aggregates["byLocale"]["ko-KR"]["goldens"] == 1
    assert aggregates["gate"] == {"evaluated": 2, "passed": 1}
