"""Behavioral port of deterministic citation-probe query and distractor tests."""

from __future__ import annotations

import importlib


def _probe():
    return importlib.import_module("pdp_geo_eval_agent.citation.probe")


BASE_CONTEXT = {
    "generatedText": "generated",
    "vanillaText": "vanilla",
    "locale": "ko-KR",
    "category": "토너",
    "benefits": ["장벽 보습"],
}


def test_flattens_generated_sections_while_dropping_empty_values() -> None:
    probe = _probe()

    text = probe.build_generated_source_text(
        {
            "productName": "Name",
            "description": "Description body.",
            "quickFacts": "",
            "benefits": "Benefit line.",
            "ingredients": "",
            "howToUse": "",
            "faq": "",
        }
    )

    assert text == "Name\n\nDescription body.\n\nBenefit line."


def test_prefers_included_content_plan_faq_questions_over_templates() -> None:
    probe = _probe()

    queries = probe.derive_probe_queries(
        BASE_CONTEXT
        | {
            "contentPlan": {
                "faq": [
                    {"include": True, "question": "여드름성 피부도 사용할 수 있나요?"},
                    {"include": False, "question": "제외된 질문인가요?"},
                ],
                "cep": [],
            }
        },
        3,
    )

    assert (queries[0].query, queries[0].source) == ("여드름성 피부도 사용할 수 있나요?", "content-plan-faq")
    assert all(query.query != "제외된 질문인가요?" for query in queries)
    assert len(queries) == 3
    assert all(query.source == "template" for query in queries[1:])


def test_converts_cep_entries_into_locale_matching_questions() -> None:
    probe = _probe()

    queries = probe.derive_probe_queries(
        BASE_CONTEXT | {"contentPlan": {"faq": [], "cep": [{"situation": "세안 직후", "need": "속당김 완화"}]}}, 2
    )

    assert queries[0].source == "content-plan-cep"
    assert "속당김 완화" in queries[0].query
    assert "토너" in queries[0].query


def test_falls_back_to_english_category_and_benefit_templates() -> None:
    probe = _probe()

    queries = probe.derive_probe_queries(BASE_CONTEXT | {"locale": "en-US", "category": "serum", "benefits": ["firming"]}, 3)

    assert len(queries) == 3
    assert all(query.source == "template" for query in queries)
    assert queries[0].query == "What serum is good for firming?"


def test_deduplicates_repeated_questions_and_obeys_max_queries() -> None:
    probe = _probe()

    queries = probe.derive_probe_queries(
        BASE_CONTEXT
        | {
            "contentPlan": {
                "faq": [
                    {"include": True, "question": "같은 질문인가요?"},
                    {"include": True, "question": "같은 질문인가요?"},
                ],
                "cep": [],
            }
        },
        2,
    )

    assert len(queries) == 2
    assert sum(query.query == "같은 질문인가요?" for query in queries) == 1


def test_uses_generic_product_noun_when_category_is_missing() -> None:
    probe = _probe()

    queries = probe.derive_probe_queries(BASE_CONTEXT | {"category": None, "benefits": []}, 1)

    assert "제품" in queries[0].query


def test_returns_four_locale_matching_distractors_parameterized_by_category() -> None:
    probe = _probe()

    korean = probe.build_probe_distractors("ko-KR", "토너")
    english = probe.build_probe_distractors("en-US", "serum")

    assert len(korean) == 4
    assert len(english) == 4
    assert all("토너" in document for document in korean)
    assert all("serum" in document for document in english)


def test_distractors_are_deterministic_and_keep_only_fictional_competitor_brands() -> None:
    probe = _probe()

    assert probe.build_probe_distractors("ko-KR", "토너") == probe.build_probe_distractors("ko-KR", "토너")
    text = "\n".join(probe.build_probe_distractors("ko-KR", "크림") + probe.build_probe_distractors("en-US", "cream")).lower()
    for fixture_brand in ("fieldnote example labs", "별모래 테스트 랩"):
        assert fixture_brand not in text
