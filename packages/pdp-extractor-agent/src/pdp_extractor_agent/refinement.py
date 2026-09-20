"""Deterministic, inspectable refinement of a completed GEO artifact."""

from __future__ import annotations

import json
import math
import re
import time
from collections.abc import Mapping
from copy import deepcopy
from typing import Any

from ._json_types import as_list, as_mapping
from .normalization import omit_evidence_internals

_INGREDIENT_PATTERN = re.compile(
    r"ginseng|panax|niacinamide|retinol|peptide|hyaluronic|ceramide|vitamin|collagen|ingredient|성분|인삼|펩타이드|레티놀|나이아신아마이드|히알루론산|세라마이드|콜라겐|비타민|병풀|시카",
    re.IGNORECASE,
)
_BENEFIT_PATTERN = re.compile(
    r"hydration|moisture|moisturizing|soothing|brightening|firming|anti-aging|radiance|elasticity|resilience|barrier|보습|수분|진정|미백|탄력|광채|장벽|영양",
    re.IGNORECASE,
)
_EFFECT_PATTERN = re.compile(
    r"effect|improve|improvement|reduce|diminish|care|wrinkle|wrinkles|fine lines|firmness|texture|lift|효과|개선|완화|케어|주름|잔주름|피부결|리프팅",
    re.IGNORECASE,
)
_USAGE_PATTERN = re.compile(
    r"use|apply|morning|night|ritual|pump|face|neck|daily use|사용|도포|아침|저녁|루틴|펌프|얼굴|목|매일",
    re.IGNORECASE,
)
_REVIEW_PATTERN = re.compile(
    r"review|rating|customer|stars|repurchase|satisfied|smooth|absorption|리뷰|평점|고객|만족|재구매|흡수|촉촉|산뜻",
    re.IGNORECASE,
)
_KOREAN_PARTICLES = re.compile(r"에|을|를|으로|로|추가|수정|반영|넣어|넣어줘|해주세요|해줘|json|객체|데이터|필드|정보|해주세요")
_QUOTED_VALUE = re.compile(r"[\"'“”‘’`]([^\"'“”‘’`]+)[\"'“”‘’`]")


def refine_geo_product_result(request: Mapping[str, Any]) -> dict[str, Any]:
    """Apply legacy inline patches and focused natural-language edits.

    The original implementation intentionally applies the natural-language
    matcher after a JSON patch; retaining that ordering is part of its public
    console behavior, including the displayed change summary.
    """

    raw_result = as_mapping(request.get("result"))
    if raw_result is None:
        raise ValueError("result is required")
    result: dict[str, Any] = deepcopy(dict(raw_result))
    product_mapping = as_mapping(result.get("geoProduct"))
    if product_mapping is None:
        raise ValueError("result.geoProduct is required")
    product: dict[str, Any] = deepcopy(dict(product_mapping))
    instruction = str(request.get("instruction") or "").strip()
    changes: list[str] = []
    patch = _read_inline_json_patch(instruction)
    if patch is not None:
        nested_product = as_mapping(patch.get("geoProduct"))
        _merge_geo_product_patch(product, nested_product if nested_product is not None else patch, changes)
    _apply_natural_language_patch(product, instruction, changes)
    result["geoProduct"] = product
    summary = (
        f"{len(changes)}개 GEO RAW JSON 필드를 수정했습니다: {', '.join(changes)}."
        if changes
        else "요청을 해석했지만 변경할 상품 RAW JSON 필드를 찾지 못했습니다. 필드명과 값을 더 구체적으로 입력해주세요."
    )
    return {"result": omit_evidence_internals(result), "changes": changes, "summary": summary}


def _apply_natural_language_patch(product: dict[str, Any], instruction: str, changes: list[str]) -> None:
    if _matches_any(instruction, (re.compile(r"상품명|product\s*name|name", re.IGNORECASE),)):
        name = _first_quoted_value(instruction) or _value_after_colon(instruction)
        if name:
            product["name"] = name
            _push_change(changes, "name")
    if _matches_any(instruction, (re.compile(r"설명|description", re.IGNORECASE),)):
        description = _first_quoted_value(instruction) or _value_after_colon(instruction)
        if description:
            product["description"] = description
            _push_change(changes, "description")
    if _matches_any(instruction, (re.compile(r"가격|price", re.IGNORECASE),)):
        match = re.search(r"(?:\$|₩)\s*[\d,.]+|[\d,]+(?:\.\d+)?\s*(?:원|usd|krw|달러)?", instruction, re.IGNORECASE)
        if match is not None:
            raw = match.group(0)
            previous = as_mapping(product.get("price"))
            price: dict[str, Any] = {"raw": raw}
            amount = _price_amount(raw)
            if amount is not None:
                price["amount"] = amount
            currency = _string_value(previous.get("currency")) if previous is not None else None
            if currency is not None:
                price["currency"] = currency
            product["price"] = price
            _push_change(changes, "price")
    metric_values = _extract_metric_phrases(instruction)
    if metric_values:
        product["metrics"] = _merge_strings(_string_array(product.get("metrics")), metric_values)
        _append_ocr_keywords(product, "metric", metric_values)
        _push_change(changes, "metrics")
    ingredient_values = _values_for_field(instruction, re.compile(r"성분|ingredient", re.IGNORECASE), _INGREDIENT_PATTERN)
    if ingredient_values:
        product["ingredients"] = _merge_strings(_string_array(product.get("ingredients")), ingredient_values)
        _append_ocr_keywords(product, "ingredient", ingredient_values)
        _push_change(changes, "ingredients")
    benefit_values = _values_for_field(instruction, re.compile(r"효능|benefit|장점|고객 가치", re.IGNORECASE), _BENEFIT_PATTERN)
    if benefit_values:
        product["benefits"] = _merge_strings(_string_array(product.get("benefits")), benefit_values)
        _append_ocr_keywords(product, "benefit", benefit_values)
        _push_change(changes, "benefits")
    effect_values = _values_for_field(instruction, re.compile(r"효과|effect|개선|결과", re.IGNORECASE), _EFFECT_PATTERN)
    if effect_values:
        product["effects"] = _merge_strings(_string_array(product.get("effects")), effect_values)
        _append_ocr_keywords(product, "effect", effect_values)
        _push_change(changes, "effects")
    usage_values = _values_for_field(instruction, re.compile(r"사용|usage|how to use|루틴", re.IGNORECASE), _USAGE_PATTERN)
    if usage_values:
        product["usage"] = _merge_strings(_string_array(product.get("usage")), usage_values)
        _append_ocr_keywords(product, "usage", usage_values)
        _push_change(changes, "usage")
    review_values = _values_for_field(instruction, re.compile(r"리뷰|review|고객|평점", re.IGNORECASE), _REVIEW_PATTERN)
    if review_values:
        reviews = dict(as_mapping(product.get("reviews")) or {})
        reviews["keywords"] = _merge_strings(_string_array(reviews.get("keywords")), review_values)
        product["reviews"] = reviews
        _append_ocr_keywords(product, "review", review_values)
        _push_change(changes, "reviews.keywords")
    if _matches_any(instruction, (re.compile(r"ocr|텍스트\s*블록|원문|근거", re.IGNORECASE),)):
        text_blocks = [value for value in _quoted_values(instruction) if len(value) >= 4]
        if text_blocks:
            ocr = dict(as_mapping(product.get("ocr")) or {})
            ocr["textBlocks"] = _merge_strings(_string_array(ocr.get("textBlocks")), text_blocks)
            product["ocr"] = ocr
            _push_change(changes, "ocr.textBlocks")


def _merge_geo_product_patch(product: dict[str, Any], patch: Mapping[str, Any], changes: list[str]) -> None:
    name = patch.get("name")
    if isinstance(name, str):
        product["name"] = name
        _push_change(changes, "name")
    description = patch.get("description")
    if isinstance(description, str):
        product["description"] = description
        _push_change(changes, "description")
    price = patch.get("price")
    if isinstance(price, str):
        _set_price(product, price, _price_amount(price), None)
        _push_change(changes, "price")
    else:
        price_mapping = as_mapping(price)
        if price_mapping is not None:
            existing_price = as_mapping(product.get("price"))
            raw = _string_value(price_mapping.get("raw")) or (
                _string_value(existing_price.get("raw")) if existing_price is not None else None
            )
            if raw is not None:
                supplied_amount = _number_value(price_mapping.get("amount"))
                currency = _string_value(price_mapping.get("currency")) or (
                    _string_value(existing_price.get("currency")) if existing_price is not None else None
                )
                _set_price(product, raw, supplied_amount if supplied_amount is not None else _price_amount(raw), currency)
                _push_change(changes, "price")
    for key in ("images", "options", "benefits", "effects", "ingredients", "usage", "metrics"):
        values = _array_values(patch.get(key))
        if values:
            product[key] = _merge_strings(_string_array(product.get(key)), values)
            _push_change(changes, key)
    faq_items = as_list(patch.get("faq"))
    if faq_items is not None:
        existing_faq = as_list(product.get("faq")) or []
        faq = [*existing_faq]
        for item in faq_items:
            entry = as_mapping(item)
            if entry is None:
                continue
            question, answer = _string_value(entry.get("question")), _string_value(entry.get("answer"))
            if question and answer:
                faq.append({"question": question, "answer": answer})
        product["faq"] = faq
        _push_change(changes, "faq")
    reviews_patch = as_mapping(patch.get("reviews"))
    if reviews_patch is not None:
        reviews = dict(as_mapping(product.get("reviews")) or {})
        rating = _number_value(reviews_patch.get("rating"))
        review_count = _number_value(reviews_patch.get("reviewCount"))
        if rating is not None:
            reviews["rating"] = rating
        if review_count is not None:
            reviews["reviewCount"] = review_count
        items = as_list(reviews_patch.get("items"))
        if items is not None:
            reviews["items"] = _merge_review_items(as_list(reviews.get("items")) or [], items)
        reviews["keywords"] = _merge_strings(_string_array(reviews.get("keywords")), _array_values(reviews_patch.get("keywords")))
        product["reviews"] = reviews
        _push_change(changes, "reviews")
    ocr_patch = as_mapping(patch.get("ocr"))
    if ocr_patch is not None:
        ocr = dict(as_mapping(product.get("ocr")) or {})
        ocr["textBlocks"] = _merge_strings(_string_array(ocr.get("textBlocks")), _array_values(ocr_patch.get("textBlocks")))
        keywords_patch = as_mapping(ocr_patch.get("keywords"))
        if keywords_patch is not None:
            keywords = dict(as_mapping(ocr.get("keywords")) or {})
            for category in list(keywords):
                keywords[category] = _merge_strings(_string_array(keywords.get(category)), _array_values(keywords_patch.get(category)))
            ocr["keywords"] = keywords
        product["ocr"] = ocr
        _push_change(changes, "ocr")
    rag_patch = as_mapping(patch.get("rag"))
    chunks_patch = as_list(rag_patch.get("chunks")) if rag_patch is not None else None
    if chunks_patch is not None:
        rag = dict(as_mapping(product.get("rag")) or {})
        existing_chunks = as_list(rag.get("chunks")) or []
        chunks = [*existing_chunks]
        for index, candidate in enumerate(chunks_patch):
            chunk = as_mapping(candidate)
            if chunk is None:
                continue
            text = _string_value(chunk.get("text"))
            if text is None:
                continue
            identifier = _string_value(chunk.get("id")) or f"manual-rag-{int(time.time() * 1000)}-{index}"
            chunks.append({"id": identifier, "kind": _rag_chunk_kind(chunk.get("kind")), "text": text})
        rag["chunks"] = chunks
        product["rag"] = rag
        _push_change(changes, "rag.chunks")


def _set_price(product: dict[str, Any], raw: str, amount: int | float | None, currency: str | None) -> None:
    price: dict[str, Any] = {"raw": raw}
    if amount is not None:
        price["amount"] = amount
    if currency is None:
        prior_price = as_mapping(product.get("price"))
        currency = _string_value(prior_price.get("currency")) if prior_price is not None else None
    if currency is not None:
        price["currency"] = currency
    product["price"] = price


def _read_inline_json_patch(instruction: str) -> Mapping[str, Any] | None:
    match = re.search(r"\{[\s\S]*\}", instruction)
    if match is None:
        return None
    try:
        return as_mapping(json.loads(match.group(0)))
    except json.JSONDecodeError:
        return None


def _values_for_field(instruction: str, field_pattern: re.Pattern[str], known_pattern: re.Pattern[str]) -> list[str]:
    if field_pattern.search(instruction) is None:
        return []
    return _merge_strings(
        [],
        [*_quoted_values(instruction), *(match.group(0) for match in known_pattern.finditer(instruction)), *_values_after_field_word(instruction, field_pattern)],
    )


def _values_after_field_word(instruction: str, field_pattern: re.Pattern[str]) -> list[str]:
    match = field_pattern.search(instruction)
    if match is None:
        return []
    trailing = _KOREAN_PARTICLES.sub(" ", instruction[match.end() :])
    return [
        value
        for value in (_clean_value(piece) for piece in re.split(r"[,/\n]", trailing))
        if value is not None and 2 <= len(value) <= 40
    ]


def _quoted_values(value: str) -> list[str]:
    return [cleaned for match in _QUOTED_VALUE.finditer(value) if (cleaned := _clean_value(match.group(1))) is not None]


def _first_quoted_value(value: str) -> str | None:
    values = _quoted_values(value)
    return values[0] if values else None


def _value_after_colon(value: str) -> str | None:
    match = re.search(r"[:：]\s*(.+)$", value)
    return _clean_value(match.group(1)) if match is not None else None


def _extract_metric_phrases(value: str) -> list[str]:
    # JavaScript's ``\b`` is ASCII-word based. Python's Unicode boundary
    # would miss ``6 weeks와`` because Hangul is a Python word character.
    js_word_before = r"(?<![A-Za-z0-9_])"
    js_word_after = r"(?![A-Za-z0-9_])"
    first_pattern = (
        js_word_before
        + r"\d+(?:\.\d+)?\s?%|"
        + js_word_before
        + r"\d+(?:\.\d+)?\s?(?:ml|mL|oz|fl\.?\s?oz|weeks?|days?|hours?|stars?)"
        + js_word_after
    )
    metric_values = [
        *(match.group(0) for match in re.finditer(first_pattern, value, re.IGNORECASE)),
        *(match.group(0) for match in re.finditer(js_word_before + r"(?:after|in)\s+\d+(?:\.\d+)?\s?(?:weeks?|days?|hours?)" + js_word_after, value, re.IGNORECASE)),
        *(match.group(0) for match in re.finditer(js_word_before + r"\d+(?:\.\d+)?\s?(?:점|개|명|회|주|일|시간|퍼센트)" + js_word_after, value)),
    ]
    return _merge_strings([], metric_values)


def _append_ocr_keywords(product: dict[str, Any], category: str, values: list[str]) -> None:
    ocr = dict(as_mapping(product.get("ocr")) or {})
    keywords = dict(as_mapping(ocr.get("keywords")) or {})
    keywords[category] = _merge_strings(_string_array(keywords.get(category)), values)
    ocr["keywords"] = keywords
    product["ocr"] = ocr


def _merge_review_items(current: list[Any], incoming: list[Any]) -> list[Any]:
    output = [*current]
    for candidate in incoming:
        item = as_mapping(candidate)
        if item is None:
            continue
        body = _string_value(item.get("body"))
        if body is None:
            continue
        review: dict[str, Any] = {"body": body}
        author = _string_value(item.get("author"))
        rating = _number_value(item.get("rating"))
        date_published = _string_value(item.get("datePublished"))
        if author is not None:
            review["author"] = author
        if rating is not None:
            review["rating"] = rating
        if date_published is not None:
            review["datePublished"] = date_published
        output.append(review)
    return output


def _rag_chunk_kind(value: object) -> str:
    kind = _string_value(value)
    return kind if kind in {"review", "faq", "ocr", "source"} else "product"


def _matches_any(value: str, patterns: tuple[re.Pattern[str], ...]) -> bool:
    return any(pattern.search(value) is not None for pattern in patterns)


def _push_change(changes: list[str], field: str) -> None:
    if field not in changes:
        changes.append(field)


def _merge_strings(current: list[str], incoming: list[str]) -> list[str]:
    output = [*current]
    for value in incoming:
        cleaned = _clean_value(value)
        if cleaned is not None and cleaned not in output:
            output.append(cleaned)
    return output


def _clean_value(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = re.sub(r"\s+", " ", value.strip())
    if cleaned.endswith((".", "。")):
        cleaned = cleaned[:-1]
    return cleaned or None


def _price_amount(value: str) -> int | float | None:
    normalized = re.sub(r"[^\d.]", "", value)
    return _number_value(normalized) if normalized else None


def _array_values(value: object) -> list[str]:
    items = as_list(value)
    if items is not None:
        return [entry for item in items for entry in _array_values(item)]
    text = _string_value(value)
    return [text] if text is not None else []


def _string_array(value: object) -> list[str]:
    values = as_list(value)
    return [item for item in values if isinstance(item, str)] if values is not None else []


def _string_value(value: object) -> str | None:
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        return None
    return _clean_value(str(value))


def _number_value(value: object) -> int | float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
    elif isinstance(value, str):
        try:
            number = float(value)
        except ValueError:
            return None
    else:
        return None
    if not math.isfinite(number):
        return None
    return int(number) if number.is_integer() else number
