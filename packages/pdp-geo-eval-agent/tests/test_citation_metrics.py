"""Behavioral compatibility tests for the legacy citation metrics suite.

Every expectation below is derived from the TypeScript evaluator's public
behavior.  These tests deliberately import the Python module at call time so
the first red run is a test failure caused by the absent port, rather than a
collection-time fixture error.
"""

from __future__ import annotations

import importlib

import pytest


def _metrics():
    return importlib.import_module("pdp_geo_eval_agent.citation.metrics")


def test_splits_paragraphs_and_sentences_with_global_ordering() -> None:
    metrics = _metrics()

    sentences = metrics.extract_citation_sentences(
        "First sentence here. Second sentence follows [0].\n\nNew paragraph statement [1][2]."
    )

    assert len(sentences) == 3
    assert sentences[0].paragraph_index == 0
    assert sentences[0].citations == []
    assert sentences[1].citations == [0]
    assert sentences[2].paragraph_index == 1
    assert sentences[2].sentence_index == 2
    assert sentences[2].citations == [1, 2]


def test_parses_grouped_chained_and_repeated_citations_once_in_answer_order() -> None:
    metrics = _metrics()

    sentence = metrics.extract_citation_sentences("Supported by several sources [0][1] and more [1, 3].")[0]

    assert sentence.citations == [0, 1, 3]


def test_counts_hangul_tokens_as_content_words_and_drops_citation_markers() -> None:
    metrics = _metrics()

    sentence = metrics.extract_citation_sentences("세안 후 즉시 수분 공급 [0].")[0]

    assert sentence.word_count == 5


def test_does_not_split_korean_sentence_internal_decimals() -> None:
    metrics = _metrics()

    sentences = metrics.extract_citation_sentences("평점은 4.9점입니다 [0]. 리뷰가 많습니다 [1].")

    assert len(sentences) == 2
    assert sentences[0].citations == [0]


def test_keeps_terminal_citation_marker_with_the_sentence_it_supports() -> None:
    metrics = _metrics()

    sentences = metrics.extract_citation_sentences(
        "클라우드베일 크림 미스트는 약 20cm 거리에서 가볍게 분사하는 합성 사용 예시를 제공합니다. [0]"
    )

    assert len(sentences) == 1
    assert sentences[0].citations == [0]
    assert sentences[0].word_count > 0


def test_separates_following_sentence_when_terminal_marker_sits_between_them() -> None:
    metrics = _metrics()

    sentences = metrics.extract_citation_sentences("첫 문장입니다. [0] 둘째 문장입니다. [1][2]")

    assert len(sentences) == 2
    assert sentences[0].citations == [0]
    assert sentences[1].citations == [1, 2]
    assert sentences[1].text.startswith("둘째")


@pytest.mark.parametrize("spaces", [2, 4])
def test_keeps_terminal_marker_with_sentence_across_multiple_spaces(spaces: int) -> None:
    metrics = _metrics()

    sentences = metrics.extract_citation_sentences(f"첫 문장입니다.{' ' * spaces}[0] 둘째 문장입니다.")

    assert len(sentences) == 2
    assert sentences[0].citations == [0]
    assert sentences[0].word_count > 0
    assert sentences[1].citations == []
    assert sentences[1].text.startswith("둘째")


def test_keeps_space_separated_marker_run_with_the_sentence_it_cites() -> None:
    metrics = _metrics()

    sentences = metrics.extract_citation_sentences("첫 문장입니다. [0] [1] 둘째 문장입니다.")

    assert len(sentences) == 2
    assert sentences[0].citations == [0, 1]
    assert sentences[1].citations == []


def test_ignores_malformed_marker_without_treating_it_as_a_citation() -> None:
    metrics = _metrics()

    sentence = metrics.extract_citation_sentences("Malformed marker [0,] stays ordinary text.")[0]

    assert sentence.citations == []


def test_ignores_non_ascii_decimal_digits_in_citation_markers_like_javascript() -> None:
    metrics = _metrics()

    sentence = metrics.extract_citation_sentences("claim [١]")[0]

    assert sentence.citations == []


def test_normalizes_each_impression_share_to_one() -> None:
    metrics = _metrics()

    shares = metrics.score_impression_shares(
        metrics.extract_citation_sentences(
            "Alpha claim with many supporting words in it [0]. Beta short claim [1]. "
            "Gamma trailing claim also cited [1]."
        ),
        3,
    )

    for values in (shares.wordpos, shares.word, shares.pos):
        assert len(values) == 3
        assert sum(values) == pytest.approx(1.0)
    assert shares.wordpos[2] == 0
    assert shares.cited_sentence_count == 3
    assert shares.sentence_count == 3


def test_weights_earlier_citations_more_in_position_metric() -> None:
    metrics = _metrics()

    shares = metrics.score_impression_shares(
        metrics.extract_citation_sentences(
            "Early cited sentence [0]. Middle filler sentence without citation. Late cited sentence [1]."
        ),
        2,
    )

    assert shares.pos[0] > shares.pos[1]


def test_splits_sentence_credit_evenly_across_multiple_citations() -> None:
    metrics = _metrics()

    shares = metrics.score_impression_shares(
        metrics.extract_citation_sentences("Shared support statement with several words [0][1]."), 2
    )

    assert shares.word[0] == pytest.approx(shares.word[1])
    assert shares.word[0] == pytest.approx(0.5)


def test_ignores_hallucinated_indices_but_reports_them() -> None:
    metrics = _metrics()

    shares = metrics.score_impression_shares(
        metrics.extract_citation_sentences("Real support [0]. Hallucinated support [7]."), 2
    )

    assert shares.hallucinated_citations == [7]
    assert shares.word[0] == pytest.approx(1.0)
    assert shares.cited_sentence_count == 1


def test_uses_uniform_share_when_nothing_is_cited() -> None:
    metrics = _metrics()

    shares = metrics.score_impression_shares(metrics.extract_citation_sentences("No citations at all here. Still nothing."), 4)

    assert shares.wordpos == [0.25, 0.25, 0.25, 0.25]
    assert shares.cited_sentence_count == 0


def test_returns_target_source_share_for_all_visibility_metrics() -> None:
    metrics = _metrics()

    score = metrics.score_citation_visibility(
        "Target source carries this long detailed sentence [1]. Rival gets a short one [0].", 2, 1
    )

    assert score.wordpos > 0.5
    assert score.word > 0.5
    assert score.shares.sentence_count == 2


def test_visibility_score_is_deterministic() -> None:
    metrics = _metrics()

    answer = "Repeatable statement [0]. Another one [1][2]."

    assert metrics.score_citation_visibility(answer, 3, 2) == metrics.score_citation_visibility(answer, 3, 2)


def test_rejects_target_index_outside_source_range() -> None:
    metrics = _metrics()

    with pytest.raises(ValueError, match="outside the source range"):
        metrics.score_citation_visibility("Text [0].", 2, 5)


def test_z_normalizes_scores_to_zero_mean_and_unit_variance() -> None:
    metrics = _metrics()

    normalized = metrics.z_normalize_scores([1, 2, 3, 4])

    assert sum(normalized) / len(normalized) == pytest.approx(0.0)
    assert max(normalized) > 0


def test_z_normalization_maps_zero_variance_to_zeros() -> None:
    metrics = _metrics()

    assert metrics.z_normalize_scores([2, 2, 2]) == [0, 0, 0]


def test_z_normalization_handles_empty_input() -> None:
    metrics = _metrics()

    assert metrics.z_normalize_scores([]) == []


SECTIONS = [
    {
        "id": "description",
        "text": "Arcwell Night Renewal Serum is a fictional evening serum with a synthetic capsule-style formula for dry-feeling texture.",
    },
    {"id": "howToUse", "text": "Apply one pump in the evening after a water-based toner, then follow with moisturizer."},
    {
        "id": "faq",
        "text": "Q: Who is this serum best suited for? A: It suits dry and combination skin seeking a comfortable evening routine.",
    },
    {"id": "ingredients", "text": ""},
]


def test_attributes_target_cited_sentences_to_highest_lexical_overlap_section() -> None:
    metrics = _metrics()

    attribution = metrics.attribute_citations_to_sections(
        "This fictional serum suits dry and combination skin seeking a comfortable evening routine [2]. "
        "Apply one pump in the evening after a water-based toner, then follow with moisturizer [2]. "
        "Competitor products cost less [0].",
        2,
        SECTIONS,
    )

    ids = [item.section_id for item in attribution]
    assert "faq" in ids
    assert "howToUse" in ids
    assert "ingredients" not in ids
    assert sum(item.share for item in attribution) > 0.99
    assert sum(item.cited_sentences for item in attribution) == 2


def test_attributes_engine_shaped_terminal_markers_without_empty_quotes() -> None:
    metrics = _metrics()

    attribution = metrics.attribute_citations_to_sections(
        "This fictional serum suits dry and combination skin seeking a comfortable evening routine. [2]  "
        "Apply one pump in the evening after a water-based toner, then follow with moisturizer. [2]",
        2,
        SECTIONS,
    )

    assert sorted(item.section_id for item in attribution) == ["faq", "howToUse"]
    assert all(sentence.strip() for item in attribution for sentence in item.sentences)
    assert sum(item.cited_sentences for item in attribution) == 2


def test_returns_empty_attribution_for_other_source_or_empty_sections() -> None:
    metrics = _metrics()

    assert metrics.attribute_citations_to_sections("Only competitor content here [0]. And another rival claim [1].", 2, SECTIONS) == []
    assert metrics.attribute_citations_to_sections("Claim [2].", 2, []) == []


def test_buckets_unmatchable_target_citation_as_other() -> None:
    metrics = _metrics()

    attribution = metrics.attribute_citations_to_sections(
        "Completely unrelated financial market commentary about interest rates [2].", 2, SECTIONS
    )

    assert len(attribution) == 1
    assert attribution[0].section_id == "other"
    assert attribution[0].share == 1


def test_returns_attributed_sentence_without_citation_marker() -> None:
    metrics = _metrics()

    attribution = metrics.attribute_citations_to_sections(
        "Apply it morning and night after toner, pressing gently until absorbed [2].", 2, SECTIONS
    )

    assert attribution[0].section_id == "howToUse"
    assert attribution[0].sentences == ["Apply it morning and night after toner, pressing gently until absorbed."]


def test_matches_korean_tokens_after_trailing_particles_are_trimmed() -> None:
    metrics = _metrics()
    sections = [
        {"id": "ingredients", "text": "고밀도 세라마이드 캡슐, 콜레스테롤, 소듐하이알루로네이트"},
        {"id": "howToUse", "text": "세안 후 스킨케어 첫 단계에 사용해 피부결을 정돈합니다."},
    ]

    attribution = metrics.attribute_citations_to_sections(
        "세라마이드가 함유되어 콜레스테롤과 함께 장벽을 돕습니다 [2]. "
        "세안 직후 첫 단계로 사용하면 피부결이 정돈됩니다 [2].",
        2,
        sections,
    )

    ids = [item.section_id for item in attribution]
    assert "ingredients" in ids
    assert "howToUse" in ids


def test_weights_section_shares_by_sentence_length() -> None:
    metrics = _metrics()

    attribution = metrics.attribute_citations_to_sections(
        "This anti-aging serum with capsule technology improves firmness and reduces the look of fine lines over time [2]. "
        "Apply after toner [2].",
        2,
        SECTIONS,
    )

    by_id = {item.section_id: item for item in attribution}
    assert by_id["description"].share > by_id["howToUse"].share


def test_treats_astral_han_as_a_cjk_content_and_match_token_using_js_utf16_length() -> None:
    metrics = _metrics()

    sentence = metrics.extract_citation_sentences("\U00020000 [0]")[0]
    attribution = metrics.attribute_citations_to_sections(
        "\U00020000 [0]",
        0,
        [{"id": "astral-han", "text": "\U00020000"}],
    )

    assert sentence.word_count == 1
    assert attribution[0].section_id == "astral-han"
