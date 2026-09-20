"""Non-fabricating mock LLM provider used by UI and isolated tests."""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from typing import Any

from .._json_types import as_list, as_mapping
from ..ocr.blocks import is_ocr_safety_or_caution_value, parse_ocr_block_sections, segment_item_sentences
from ..ocr.pipeline import extract_numbered_usage_steps


class MockKeywordClassifier:
    async def classify_keywords(self, request: Mapping[str, Any]) -> dict[str, Any]:
        """Port the deterministic TypeScript mock classifier.

        Mock mode is still a real semantic stage: it must classify supplied
        DOM/OCR evidence rather than turning the service path into a different
        lexical-only product.  It never fabricates image transcriptions.
        """

        keyword_rows: list[dict[str, Any]] = []
        insights: list[dict[str, Any]] = []
        safety_tests: list[str] = []
        for index, raw in enumerate(as_list(request.get("imageTexts")) or [], start=1):
            item = as_mapping(raw)
            text = item.get("text") if item is not None else None
            if not isinstance(text, str) or not text.strip():
                continue
            keyword_rows.extend(_classify_text(text))
            for value in _source_sentence_values(text):
                if is_ocr_safety_or_caution_value(value):
                    safety_tests.append(value)
                    continue
                sentence = _classify_sentence(value)
                if sentence is None:
                    continue
                sentence["evidenceIndex"] = index
                insights.append(sentence)
        facts = _semantic_facts_from_insights(insights, safety_tests)
        return {
            "keywords": keyword_rows,
            "sentenceInsights": insights,
            "semanticFacts": facts,
            "summary": "Mock OCR keyword classification completed." if keyword_rows else "No OCR keywords found.",
        }

    async def extract_image_text(self, _request: Mapping[str, Any]) -> dict[str, Any]:
        return {"images": [], "rawText": ""}


setattr(MockKeywordClassifier, "classifyKeywords", MockKeywordClassifier.classify_keywords)
setattr(MockKeywordClassifier, "extractImageTexts", MockKeywordClassifier.extract_image_text)


_CATEGORY_RULES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("ingredient", re.compile(r"ginseng|panax|niacinamide|retinol|peptide|hyaluronic|ceramide|vitamin|collagen|ingredient|성분|원료|인삼|펩타이드|레티놀|나이아신아마이드", re.I)),
    ("benefit", re.compile(r"hydration|moisture|moisturizing|soothing|brightening|firming|anti-aging|radiance|elasticity|resilience|barrier|보습|수분|진정|미백|탄력|광채|장벽|영양|고밀도|자생력|피부", re.I)),
    ("effect", re.compile(r"effect|improve|improvement|enhance|reduce|diminish|care|wrinkle|firmness|firmer|elasticity|resilience|texture|lift|효과|개선|완화|케어|주름|피부결", re.I)),
    ("usage", re.compile(r"use|apply|morning|night|ritual|pump|face|neck|spray|rinse|사용|도포|아침|저녁|루틴|펌프|분사|뿌려|바르", re.I)),
    ("faq", re.compile(r"\?|faq|question|answer|what|how|can|자주|질문|답변", re.I)),
    ("review", re.compile(r"review|rating|customer|stars|agreed|showed|리뷰|평점|고객|만족", re.I)),
    ("metric", re.compile(r"\b\d+(?:\.\d+)?\s?%|\b\d+(?:\.\d+)?\s?(?:ml|mL|oz|fl\.?\s?oz|weeks?|days?|hours?|stars?|점|개|명|회|주|일|시간|ppm)\b", re.I)),
    ("price", re.compile(r"₩|원|\$|price|sale|discount|가격|할인", re.I)),
)


def _classify_text(text: str) -> list[dict[str, Any]]:
    terms: list[str] = []
    for term in re.split(r"[\s,./|·()\[\]{}<>:;!]+", text):
        value = term.strip()
        if len(value) >= 2 and value not in terms:
            terms.append(value)
    return [
        {
            "keyword": term,
            "category": next((category for category, pattern in _CATEGORY_RULES if pattern.search(term)), "unknown"),
            "confidence": 0.72,
            "source": "ocr",
        }
        for term in terms[:18]
    ]


def _source_sentence_values(text: str) -> list[str]:
    # Explicitly printed numbering is an ownership/order signal even when an
    # upstream OCR implementation flattened it into one long line.
    values: list[str] = extract_numbered_usage_steps(text)
    if not values:
        values = []
        for section in parse_ocr_block_sections(re.sub(r"\[[^\]]+\]\s*", "", text)):
            for item in as_list(section.get("items")) or []:
                item_mapping = as_mapping(item)
                if item_mapping is not None:
                    values.extend(segment_item_sentences(str(item_mapping.get("text") or "")))
    return values


def _classify_sentence(value: str) -> dict[str, Any] | None:
    rows = [row for row in _classify_text(value) if row["category"] != "unknown"]
    category = _dominant_category(rows)
    if category is None:
        return None
    return {
        "text": value,
        "category": category,
        "keywords": _unique([str(row["keyword"]) for row in rows])[:8],
        "confidence": 0.72,
        "source": "mock",
    }


def _dominant_category(rows: Sequence[Mapping[str, Any]]) -> str | None:
    scores: dict[str, float] = {}
    for row in rows:
        category = row.get("category")
        if isinstance(category, str):
            scores[category] = scores.get(category, 0.0) + float(row.get("confidence") or 0.0)
    return max(scores, key=scores.__getitem__) if scores else None


def _semantic_facts_from_insights(
    insights: Sequence[Mapping[str, Any]], safety_tests: Iterable[str] = ()
) -> dict[str, Any]:
    def texts(category: str) -> list[str]:
        return _unique([str(item["text"]) for item in insights if item.get("category") == category])

    usage = texts("usage")
    metrics = [
        {"sentence": str(item["text"]), "sourceText": str(item["text"]), "evidenceIndex": item["evidenceIndex"]}
        for item in insights
        if item.get("category") == "metric" or re.search(r"\d+(?:\.\d+)?\s*%", str(item.get("text") or ""))
    ]
    return {
        "ingredients": _unique(
            keyword
            for item in insights
            if item.get("category") == "ingredient"
            for keyword in as_list(item.get("keywords")) or []
            if isinstance(keyword, str)
        ),
        "benefits": texts("benefit"),
        "effects": texts("effect"),
        "skinTypes": [],
        "usageSteps": usage,
        "safetyTests": _unique(safety_tests),
        "metricClaims": metrics,
        "evidenceSentences": _unique(str(item["text"]) for item in insights),
        "ingredientBenefitLinks": [],
        "citations": [],
    }


def _unique(values: Iterable[object]) -> list[str]:
    output: list[str] = []
    for value in values:
        if isinstance(value, str) and value.strip() and value not in output:
            output.append(value)
    return output
