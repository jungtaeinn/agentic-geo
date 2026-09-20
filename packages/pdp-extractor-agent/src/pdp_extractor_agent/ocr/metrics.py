"""Turn layout-paired chart values into attributable metric claims."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import Any

_MAX_RESOLVABLE_SERIES = 2
_FOOTNOTE_SEGMENT = re.compile(r"(?<!\d)\s*[/;·]\s*(?!\d)|\s*[/;·]\s+|\s+[/;·]\s*")
_PERIOD_PHRASE = re.compile(
    r"\d{4}\s*[.\-/]\s*\d{1,2}\s*[.\-/]\s*\d{1,2}(?:\s*[~\-–]\s*\d{4}\s*[.\-/]\s*\d{1,2}\s*[.\-/]\s*\d{1,2})?|\d+\s*(?:주|일|개월)\s*(?:간|동안)?|\d+\s*(?:weeks?|days?|months?)",
    re.IGNORECASE,
)
_SAMPLE_PHRASE = re.compile(
    r"[^\s,;/·]*\s*\d+\s*명|\d+\s+(?:women|men|subjects?|participants?|panelists?|volunteers?|adults?|people)",
    re.IGNORECASE,
)
_SAMPLE_SEGMENT = re.compile(
    r"\d+\s*명|\d+\s+(?:women|men|subjects?|participants?|panelists?|volunteers?|adults?|people)\b",
    re.IGNORECASE,
)
_PERIOD_SEGMENT = re.compile(
    r"\d{4}\s*[.\-/]\s*\d{1,2}\s*[.\-/]\s*\d{1,2}|\d+\s*(?:주|일|개월)\s*(?:간|동안)?|\d+\s*(?:weeks?|days?|months?)\b",
    re.IGNORECASE,
)
_VALUE_WITH_UNIT = re.compile(r"^([+\-−]?\d+(?:[.,]\d+)?)\s*([^\s\d]{1,4})?$")
# A footnote that names how the study was run states the method, not a
# disclaimer.  Filing it as a caveat left the method slot empty, and a renderer
# that needs the method to attribute a result then had nothing to attribute to.
_METHOD_SEGMENT = re.compile(
    r"(?:in\s*vitro|ex\s*vivo|clinical|instrumental|self[-\s]?assessment|survey|home\s+usage"
    r"|인체\s*적용|자가\s*평가|소비자\s*평가|기기\s*평가|시험|테스트|임상)",
    re.IGNORECASE,
)


def metric_claims_from_ocr_layout(groups: Sequence[Mapping[str, Any]], product_name: str) -> list[dict[str, str]]:
    """Port ``metricClaimsFromOcrLayout`` without flattening layout boundaries.

    A child chart owns its own series labels; parent titles and attached footnotes
    supply only missing context. Processing descendants as one group turns paired
    timepoint labels into additional series and suppresses valid claims.
    """

    by_id = {str(group["id"]): group for group in groups if group.get("id") is not None}
    footnotes: dict[str, list[str]] = {}
    for group in groups:
        target = group.get("annotates")
        if not isinstance(target, str):
            continue
        values = [
            _normalize_line(line.get("text", ""))
            for line in _lines(group)
            if line.get("role") == "footnote" and _normalize_line(line.get("text", ""))
        ]
        if values:
            footnotes.setdefault(target, []).extend(values)

    claims: list[dict[str, str]] = []
    for group in groups:
        parent_id = group.get("parentId")
        parent = by_id.get(parent_id) if isinstance(parent_id, str) else None
        raw_metric = group.get("title") if group.get("title") is not None else (parent or {}).get("title", "")
        metric = _normalize_line(raw_metric)
        if not metric:
            continue

        lines = _lines(group)
        paired_labels = {
            _normalize_line(line.get("pairedLabel", ""))
            for line in lines
            if line.get("role") == "value"
        }
        series_labels = [
            _normalize_line(line.get("text", ""))
            for line in lines
            if line.get("role") == "label" and _normalize_line(line.get("text", "")) not in paired_labels
        ]
        if len(series_labels) > _MAX_RESOLVABLE_SERIES:
            continue
        subject = next((label for label in series_labels if _names_the_product(label, product_name)), None)
        comparator = next((label for label in series_labels if label != subject), None) if subject else None

        group_id = group.get("id")
        footnote_values = footnotes.get(str(group_id))
        if footnote_values is None and isinstance(parent_id, str):
            footnote_values = footnotes.get(parent_id)
        scope = _split_footnote(" / ".join(footnote_values)) if footnote_values else {}

        for line in lines:
            paired_label = line.get("pairedLabel")
            if line.get("role") != "value" or paired_label is None:
                continue
            text = _normalize_line(line.get("text", ""))
            measured = _VALUE_WITH_UNIT.fullmatch(text)
            value = measured.group(1) if measured and measured.group(2) else text
            claim: dict[str, str] = {
                "value": value,
                "metric": metric,
                "timing": _normalize_line(paired_label),
            }
            if measured and measured.group(2):
                claim["unit"] = measured.group(2)
            if subject:
                claim["subject"] = subject
            if comparator:
                claim["comparator"] = comparator
            claim.update(scope)
            claims.append(claim)
    return claims


def _lines(group: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    return [line for line in group.get("lines", []) if isinstance(line, Mapping)]


def _normalize_line(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value)).strip()


def _names_the_product(label: str, product_name: str) -> bool:
    words = ["".join(char for char in word if char.isalnum()) for word in product_name.split()]
    words = [word for word in words if len(word) >= 2]
    distinctive = words[:-1] if len(words) > 1 else words
    normalized = re.sub(r"\s+", "", label)
    return any(word in normalized for word in distinctive)


def _split_footnote(footnote: str) -> dict[str, str]:
    segments = [_normalize_line(segment) for segment in _FOOTNOTE_SEGMENT.split(footnote) if _normalize_line(segment)]
    if len(segments) <= 1:
        return _slots_within_one_segment(_normalize_line(footnote))
    sample = next((segment for segment in segments if _SAMPLE_SEGMENT.search(segment)), None)
    period = next(
        (segment for segment in segments if segment != sample and _PERIOD_SEGMENT.search(segment)),
        None,
    )
    result: dict[str, str] = {}
    if sample:
        result["sample"] = sample
    if period:
        result["period"] = period
    rest = [segment for segment in segments if segment != sample and segment != period]
    method = next((segment for segment in rest if _METHOD_SEGMENT.search(segment)), None)
    if method:
        result["method"] = method
        rest = [segment for segment in rest if segment != method]
    if rest:
        result["caveat"] = " / ".join(rest)
    return result


def _slots_within_one_segment(segment: str) -> dict[str, str]:
    sample_match = _SAMPLE_PHRASE.search(segment)
    period_match = _PERIOD_PHRASE.search(segment)
    sample = sample_match.group(0) if sample_match else None
    period = period_match.group(0) if period_match else None
    if sample is None and period is None:
        return {"caveat": segment}
    rest = segment
    for phrase in (sample, period):
        if phrase:
            rest = rest.replace(phrase, "", 1)
    result: dict[str, str] = {}
    if sample:
        result["sample"] = _normalize_line(sample)
    if period:
        result["period"] = _normalize_line(period)
    rest = _normalize_line(rest)
    if len(rest) >= 2:
        if _METHOD_SEGMENT.search(rest):
            result["method"] = rest
        else:
            result["caveat"] = rest
    return result
