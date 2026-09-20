"""OCR reading reconciliation and lightweight pipeline helpers."""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Mapping, MutableMapping, Sequence
from typing import Any, cast

from .._json_types import as_list, as_mapping
from .blocks import normalize_ocr_comparison_text, parse_ocr_block_sections, section_heading_category
from .relations import ocr_layout_sections, stitch_sliced_layout_groups, verify_ocr_layout_groups


def reconcile_ocr_readings(first: str, second: str) -> tuple[str, list[str]]:
    """Keep only shared token multiplicities when two readings describe one block.

    Broadly unrelated documents are deliberately not intersected: constructing a
    third text from unrelated content is more misleading than retaining the
    first transcription with its original uncertainty.
    """

    normalized_first = _normalize_ocr_text(first)
    normalized_second = _normalize_ocr_text(second)
    first_tokens = re.split(r"(\s+)", normalized_first)
    second_tokens = [
        normalize_ocr_comparison_text(token)
        for token in re.split(r"\s+", normalized_second)
        if token
    ]
    content_tokens = [token for token in first_tokens if not token.isspace()]
    if len(content_tokens) >= 12 and _agreement_ratio(first_tokens, second_tokens) < 0.8:
        return normalized_first, []
    remaining = Counter(second_tokens)
    kept: list[str] = []
    dropped: list[str] = []
    for token in first_tokens:
        if token.isspace():
            kept.append(token)
            continue
        key = normalize_ocr_comparison_text(token)
        if remaining[key] > 0:
            kept.append(token)
            remaining[key] -= 1
        else:
            dropped.append(token)
    return _normalize_ocr_text(re.sub(r"[ \t]{2,}", " ", "".join(kept))), dropped


def _normalize(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


_USAGE_SEQUENCE_HEADING = re.compile(
    r"\b(?:how\s*to\s*use|directions?|application|ritual|routine)\b|사용\s*방법|사용법|使い方|使用方法",
    re.IGNORECASE,
)
_USAGE_SEQUENCE_ORDINAL = re.compile(
    r"(?<!\S)(?:step\s*)?(?P<ordinal>\d+)\s*(?:단계|段階)?(?P<delimiter>[.):、:]?)\s+",
    re.IGNORECASE,
)
# A trailing name plate is only recognised as one when it runs long enough to
# be a plate.  One or two full-caps tokens also occur inside an instruction
# (``SPF 50``), and losing them would shorten the source's own step.
_MINIMUM_SEQUENCE_LABEL_TOKENS = 3
_SEQUENCE_SENTENCE_END = re.compile(r"[.!?。！？](?=\s|$)")
_NON_PRODUCT_ROUTINE_HEADING = re.compile(
    r"\b(?:(?:your|complete|full|personalized|custom)\s+){1,3}\d+\s*[-–—]?\s*"
    r"(?:step|steps)\s+(?:routine|regimen|system)\b",
    re.IGNORECASE,
)
_SEQUENCE_COMMERCE_ACTION = re.compile(
    r"\b(?:shop(?:\s+(?:the|our|all|now))?|buy|purchase|"
    r"add\b[^.!?。！？]{0,60}\b(?:bag|cart)\b|"
    r"(?:build|complete|curate)\b[^.!?。！？]{0,60}\b(?:routine|ritual|regimen|set|collection)\b)",
    re.IGNORECASE,
)
_SEQUENCE_PACKAGING_OR_STORAGE = re.compile(
    r"(?:\b(?:carton|packag(?:e|ing)|container|box|label|bottle|cap)\b[^.!?。！？]{0,100}"
    r"\b(?:keep|store|recycle|dispose|return|ship|seal)\b|"
    r"\b(?:keep|store|recycle|dispose|return|ship|seal)\b[^.!?。！？]{0,100}"
    r"\b(?:carton|packag(?:e|ing)|container|box|label|bottle|cap)\b|"
    r"(?:보관|재활용|폐기)[^.!?。！？]{0,100}(?:포장|용기|상자|라벨))",
    re.IGNORECASE,
)
_SEQUENCE_MEASUREMENT_OR_STUDY = re.compile(
    r"(?:\b\d+(?:[.,]\d+)?\s*(?:%|percent)\s+(?:of\s+)?(?:the\s+)?"
    r"(?:participants?|users?|subjects?|respondents?|women|men)\b|"
    r"\b(?:participants?|users?|subjects?|respondents?|women|men)\b[^.!?。！？]{0,100}"
    r"\b(?:reported|saw|noticed|experienced|showed|agreed)\b|"
    r"(?:사용자|참여자|피험자|대상자)[^.!?。！？]{0,100}(?:응답|평가|개선|확인))",
    re.IGNORECASE,
)


def _normalize_ocr_text(value: str) -> str:
    """Match TS OCR normalization: compact each visual line, retain line boundaries."""

    return "\n".join(
        line
        for raw_line in value.replace("\r\n", "\n").replace("\r", "\n").split("\n")
        if (line := re.sub(r"\s+", " ", raw_line).strip())
    ).strip()


def _agreement_ratio(first_tokens: Sequence[str], second_tokens: Sequence[str]) -> float:
    available = Counter(second_tokens)
    total = 0
    matched = 0
    for token in first_tokens:
        if token.isspace():
            continue
        total += 1
        key = normalize_ocr_comparison_text(token)
        if available[key] > 0:
            available[key] -= 1
            matched += 1
    return matched / total if total else 1.0


def combine_ocr_candidates(
    candidates: Sequence[Mapping[str, Any]],
    stats: MutableMapping[str, Any] | None = None,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    """Deduplicate equivalent OCR text without making an image URL a key.

    One PDP image may yield a genuine vision reading *and* a deterministic
    ``data-ocr-*``/page-text candidate.  The TypeScript pipeline preserves
    both unless their normalized text is equal or one contains the other;
    using only ``imageUrl`` as a key silently threw that fallback away.
    """

    ordered: list[dict[str, Any]] = []
    for raw in candidates:
        image_url = _text(raw.get("imageUrl"))
        text = _text(raw.get("text"))
        if not image_url or not text:
            continue
        confidence = _confidence(raw.get("confidence"))
        raw_urls = as_list(raw.get("imageUrls")) or []
        source_urls = _unique_urls([*raw_urls, image_url])
        fingerprint = _normalize(text).casefold()
        matched = False
        for index, current in enumerate(ordered):
            current_text = _text(current.get("text"))
            current_fingerprint = _normalize(current_text or "").casefold()
            if not current_fingerprint:
                continue
            union_image_urls = _unique_urls([*current["imageUrls"], *source_urls])
            old_confidence = _confidence(current.get("confidence"))
            merged_confidence = _min_defined_confidence(old_confidence, confidence)
            if current_fingerprint == fingerprint or current_fingerprint in fingerprint or fingerprint in current_fingerprint:
                # The more complete transcription wins; ties retain the first
                # evidence reading to preserve page order.  Confidence is the
                # lower of either reading: a merged transcription is only as
                # reliable as its least-legible source, matching minDefinedConfidence
                # in the retained TypeScript pipeline.
                if len(fingerprint) > len(current_fingerprint):
                    # The first candidate owns the public primary image URL even
                    # when a later candidate supplies the longer transcription.
                    replacement = {**current, "imageUrls": union_image_urls, "text": text}
                    _apply_confidence(replacement, merged_confidence)
                    _clear_merged_slice_index(replacement, current, raw)
                    ordered[index] = replacement
                else:
                    current["imageUrls"] = union_image_urls
                    _apply_confidence(current, merged_confidence)
                    _clear_merged_slice_index(current, current, raw)
                matched = True
                _increment_stat(stats, "duplicatesAbsorbed")
                break
            joined, _consumed_lines, unmatched = _join_slice_overlap(current_text or "", text)
            if unmatched:
                joined, _consumed_lines, unmatched = _join_slice_overlap(text, current_text or "")
            if unmatched:
                continue
            replacement = {**current, "imageUrls": union_image_urls, "text": joined}
            _apply_confidence(replacement, merged_confidence)
            _clear_merged_slice_index(replacement, current, raw)
            # Different source-image layouts cannot stay valid after a
            # boundary join.  Retained TS intentionally falls back to the
            # line parser rather than publishing either stale group graph.
            replacement.pop("groups", None)
            ordered[index] = replacement
            matched = True
            _increment_stat(stats, "overlapJoins")
            break
        if not matched:
            current: dict[str, Any] = {"imageUrl": image_url, "imageUrls": source_urls, "text": text}
            for key in ("groups", "sliceIndex", "sliceCount", "sourceOrder"):
                if key in raw:
                    current[key] = raw[key]
            _apply_confidence(current, confidence)
            ordered.append(current)
    if limit is None:
        return ordered
    # The retained runtime ranks only to decide which evidence survives the
    # cap, then restores source order for semantic classification.  Keeping
    # this distinction avoids a late high-value clinical panel being crowded
    # out by an unbounded gallery while preserving reading order in the prompt.
    ranked = sorted(
        enumerate(ordered),
        key=lambda entry: (
            -_product_text_score(_text(entry[1].get("text")) or ""),
            -_utf16_length(_text(entry[1].get("text")) or ""),
            entry[0],
        ),
    )[: max(0, limit)]
    return [
        candidate
        for _index, candidate in sorted(
            ranked,
            key=lambda entry: (_source_order_or_position(entry[1], entry[0]), entry[0]),
        )
    ]


def join_slice_candidates(
    candidates: Sequence[Mapping[str, Any]], stats: MutableMapping[str, Any] | None = None
) -> list[dict[str, Any]]:
    """Join vertically sliced image transcriptions, eliminating boundary overlap."""

    groups: dict[str, list[tuple[int, int, Mapping[str, Any]]]] = {}
    passthrough: list[tuple[int, Mapping[str, Any]]] = []
    order: list[str] = []
    for position, raw in enumerate(candidates):
        url = _text(raw.get("imageUrl"))
        if not url:
            continue
        slice_index, _slice_count = _slice_metadata(raw, url)
        if slice_index is None:
            passthrough.append((position, raw))
            continue
        base = re.sub(r"#ocr-slice-\d+of\d+$", "", url)
        if base not in groups:
            groups[base] = []
            order.append(base)
        groups[base].append((slice_index, position, raw))
    output: list[tuple[int, dict[str, Any]]] = [
        (
            _source_order_or_position(raw, position),
            dict(raw),
        )
        for position, raw in passthrough
    ]
    for base in order:
        entries = sorted(groups[base], key=lambda entry: entry[0])
        texts = [_text(item.get("text")) for _, _, item in entries]
        joined = ""
        readings: list[dict[str, Any]] = []
        for offset, text in enumerate(texts):
            if not text:
                continue
            slice_index, _slice_count = _slice_metadata(entries[offset][2], str(entries[offset][2].get("imageUrl") or ""))
            reading: dict[str, Any] = {"sliceIndex": slice_index if slice_index is not None else offset + 1}
            groups_value = as_list(entries[offset][2].get("groups"))
            if groups_value is not None:
                reading["groups"] = groups_value
            if not joined:
                joined = _normalize_ocr_text(text)
            else:
                joined, consumed_lines, overlap_unmatched = _join_slice_overlap(
                    joined, text, tolerate_dropped_tokens=True
                )
                if consumed_lines:
                    reading["consumedLines"] = consumed_lines
                    _increment_stat(stats, "overlapJoins")
                if overlap_unmatched:
                    reading["overlapUnmatched"] = True
                    _stat_list(stats, "unmatchedBoundaries").append(
                        {
                            "imageUrl": base,
                            "sliceIndex": slice_index if slice_index is not None else offset + 1,
                            "tailPreview": " ⏎ ".join(_normalize_ocr_text(joined).split("\n")[-3:])[:160],
                            "headPreview": " ⏎ ".join(_normalize_ocr_text(text).split("\n")[:3])[:160],
                        }
                    )
            readings.append(reading)
        # A tall-image public candidate represents its canonical original,
        # never the provider-only ``#ocr-slice-*`` display fragments.
        urls = [base]
        confidences = [_confidence(item.get("confidence")) for _, _, item in entries]
        first = entries[0][2]
        source_order = _source_order_or_position(first, entries[0][1])
        result: dict[str, Any] = {
            "imageUrl": base,
            "imageUrls": urls,
            "text": joined,
            "sourceOrder": source_order,
        }
        _first_slice_index, first_slice_count = _slice_metadata(first, str(first.get("imageUrl") or ""))
        if first_slice_count is not None:
            result["sliceCount"] = first_slice_count
        stitched = stitch_sliced_layout_groups(readings)
        reported_groups = sum(len(as_list(reading.get("groups")) or []) for reading in readings)
        if stitched is not None:
            result["groups"] = stitched
            _increment_stat(stats, "layoutSliceStitches", max(0, reported_groups - len(stitched)))
        elif reported_groups:
            _stat_list(stats, "layoutDiscarded").append(
                {
                    "imageUrl": base,
                    "reason": "overlap-unmatched" if any(reading.get("overlapUnmatched") for reading in readings) else "slice-partial",
                }
            )
        _apply_confidence(result, _minimum(confidences))
        output.append((source_order, result))
    return [item for _, item in sorted(output, key=lambda entry: entry[0])]


def _slice_metadata(raw: Mapping[str, Any], image_url: str) -> tuple[int | None, int | None]:
    index = raw.get("sliceIndex")
    count = raw.get("sliceCount")
    if isinstance(index, int) and not isinstance(index, bool):
        return index, count if isinstance(count, int) and not isinstance(count, bool) else None
    matched = re.search(r"#ocr-slice-(\d+)of(\d+)$", image_url)
    return (int(matched.group(1)), int(matched.group(2))) if matched is not None else (None, None)


def _source_order_or_position(raw: Mapping[str, Any], position: int) -> int:
    order = raw.get("sourceOrder")
    return order if isinstance(order, int) and not isinstance(order, bool) else position


def _increment_stat(stats: MutableMapping[str, Any] | None, key: str, amount: int = 1) -> None:
    if stats is None or amount <= 0:
        return
    current = stats.get(key)
    stats[key] = (current if isinstance(current, int) and not isinstance(current, bool) else 0) + amount


def _stat_list(stats: MutableMapping[str, Any] | None, key: str) -> list[dict[str, Any]]:
    if stats is None:
        return []
    current = stats.get(key)
    if isinstance(current, list):
        return cast(list[dict[str, Any]], current)
    result: list[dict[str, Any]] = []
    stats[key] = result
    return result


def _utf16_length(value: str) -> int:
    return len(value.encode("utf-16-le", "surrogatepass")) // 2


def _product_text_score(text: str) -> int:
    """Port the retained cap-selection score without inventing a product-name boost."""

    signal_patterns = (
        r"benefit|ingredient|how to use|how-to-use|directions|ritual|faq|result|clinical|review|summary|formulated without|key ingredients",
        r"skin|serum|cream|ginseng|retinol|niacinamide|peptide|wrinkle|firm|elastic|moistur|texture|radiance|anti-aging|apply|water|aqua|glycol|extract",
        r"피부|보습|수분|진정|탄력|장벽|주름|효능|효과|성분|사용|리뷰|자생력|고밀도|영양|인삼|펩타이드|스킨케어",
    )
    signal_score = 4 * sum(bool(re.search(pattern, text, re.IGNORECASE)) for pattern in signal_patterns)
    commerce_penalty = 12 if re.search(r"cart|checkout|shipping|returns?|refund|subscribe|newsletter", text, re.IGNORECASE) else 0
    return signal_score + min(_utf16_length(text) // 120, 6) - commerce_penalty


def _minimum(values: Sequence[float | None]) -> float | None:
    usable = [value for value in values if value is not None]
    return min(usable) if usable else None


def _min_defined_confidence(left: float | None, right: float | None) -> float | None:
    if left is None:
        return right
    if right is None:
        return left
    return min(left, right)


def _apply_confidence(candidate: dict[str, Any], confidence: float | None) -> None:
    if confidence is None:
        candidate.pop("confidence", None)
    else:
        candidate["confidence"] = confidence


def _clear_merged_slice_index(
    target: dict[str, Any], existing: Mapping[str, Any], candidate: Mapping[str, Any]
) -> None:
    """A merged row no longer denotes one individual tall-image slice."""

    target.pop("sliceIndex", None)
    existing_url, candidate_url = _text(existing.get("imageUrl")), _text(candidate.get("imageUrl"))
    if existing_url != candidate_url:
        target.pop("sliceCount", None)


def relation_backed_lines(text: str, groups: Sequence[Mapping[str, Any]]) -> list[str]:
    """Return only provider relation lines that the final transcription proves."""

    verified = verify_ocr_layout_groups(text, groups) or []
    return [
        str(line_mapping["text"])
        for group in verified
        if (group_mapping := as_mapping(group)) is not None
        for line in as_list(group_mapping.get("lines")) or []
        if (line_mapping := as_mapping(line)) is not None and isinstance(line_mapping.get("text"), str)
    ]


def layout_sections_from_groups(groups: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Public wrapper for deterministic parent/child layout section reconstruction."""

    return ocr_layout_sections(groups)


def layout_field_facts(groups: Sequence[Mapping[str, Any]], _product_name: str) -> dict[str, list[str]]:
    """Route explicit layout headings to product fields; do not re-guess roles."""

    facts: dict[str, list[str]] = {
        "benefits": [],
        "effects": [],
        "ingredients": [],
        "usage": [],
        "safety": [],
        "metrics": [],
    }
    # A caution heading owns every visible child row, including storage or
    # handling language that has no safety cue of its own. Keep the physical
    # OCR rows atomic rather than letting generic layout reconstruction join
    # them into one combined provider-style sentence.
    facts["safety"] = _safety_layout_rows(groups)
    for raw_section in ocr_layout_sections(groups):
        section = as_mapping(raw_section)
        if section is None:
            continue
        heading = str(section.get("heading") or "").casefold()
        target = _heading_target(heading)
        if target == "safety":
            continue
        if target:
            for item in as_list(section.get("items")) or []:
                item_mapping = as_mapping(item)
                if item_mapping is not None and (text := _text(item_mapping.get("text"))) and text not in facts[target]:
                    facts[target].append(text)
    # Chart tick rows are not standalone product facts.  Structured metrics
    # are emitted exclusively by ``metric_claims_from_ocr_layout`` where the
    # value retains its heading, timing, labels, and footnote context.
    return facts


def _safety_layout_rows(groups: Sequence[Mapping[str, Any]]) -> list[str]:
    children: dict[str, list[Mapping[str, Any]]] = {}
    for group in groups:
        parent_id = _text(group.get("parentId"))
        if parent_id:
            children.setdefault(parent_id, []).append(group)

    rows: list[str] = []

    def append_rows(group: Mapping[str, Any]) -> None:
        heading = _text(group.get("title")) or ""
        heading_key = normalize_ocr_comparison_text(heading)
        for raw_line in as_list(group.get("lines")) or []:
            line = as_mapping(raw_line)
            text = _text(line.get("text")) if line is not None and line.get("role") == "body" else None
            if text and normalize_ocr_comparison_text(text) != heading_key and text not in rows:
                rows.append(text)
        identifier = _text(group.get("id"))
        if identifier:
            for child in children.get(identifier, []):
                append_rows(child)

    for group in groups:
        heading = _text(group.get("title"))
        if heading and _heading_target(heading.casefold()) == "safety":
            append_rows(group)
    return rows


def split_numbered_usage_steps(text: str) -> tuple[list[str], str]:
    """Recover source-owned ordinals and leave non-procedure text available.

    A source heading and contiguous ordinal positions are structural evidence:
    they do not need a product-specific verb allowlist.  The selector scans
    every declared usage heading instead of stopping at the first generic
    ``How to use`` label, so a compressed summary cannot hide a later ritual.
    """

    steps, decisions = select_numbered_usage_sequence([text])
    if not steps:
        return [], _normalize(text)
    accepted = cast(list[Mapping[str, Any]], decisions.get("accepted", []))
    selected: Mapping[str, Any] | None = accepted[0] if accepted else None
    if selected is not None:
        source_start = selected.get("sourceStart")
        source_end = selected.get("sourceEnd")
        if isinstance(source_start, int) and isinstance(source_end, int):
            return steps, _normalize(f"{text[:source_start]} {text[source_end:]}")
    return steps, ""


def extract_numbered_usage_steps(text: str) -> list[str]:
    """Return a complete source-owned procedure without lexical action guesses."""

    steps, _decisions = select_numbered_usage_sequence([text])
    return steps


def has_explicit_numbered_usage_marker(value: str) -> bool:
    """Return whether a source value carries a visible ordinal marker."""

    return any(
        _is_explicit_usage_ordinal_marker(value, marker)
        for marker in _USAGE_SEQUENCE_ORDINAL.finditer(value)
    )


def select_numbered_usage_sequence(values: Sequence[str]) -> tuple[list[str], dict[str, Any]]:
    """Choose one complete source sequence and explain its structural decision.

    Multiple OCR/DOM readings often duplicate one procedure.  They may also
    contain a page-level summary, a cross-sell routine, or an orphaned ordinal.
    Grouping by semantic heading lets duplicate source readings corroborate a
    procedure while an explicit ``Step 2`` remains incomplete rather than
    silently becoming public position one.
    """

    candidates: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    for source_index, raw in enumerate(values):
        if not raw.strip():
            continue
        for candidate in _numbered_usage_sequence_candidates(raw, source_index):
            reason = candidate.get("reason")
            if isinstance(reason, str) and reason:
                rejected.append(_public_usage_sequence_decision(candidate, reason))
            elif candidate["steps"]:
                candidates.append(candidate)

    grouped: dict[str, dict[str, Any]] = {}
    for candidate in candidates:
        key = str(candidate["headingKey"])
        group = grouped.setdefault(
            key,
            {
                "heading": candidate["heading"],
                "positions": {},
                "sourceIndexes": [],
                "sourceStart": candidate["sourceStart"],
                "sourceEnd": candidate["sourceEnd"],
                "firstSourceIndex": candidate["sourceIndex"],
            },
        )
        group["sourceIndexes"].append(candidate["sourceIndex"])
        group["sourceStart"] = min(int(group["sourceStart"]), int(candidate["sourceStart"]))
        group["sourceEnd"] = max(int(group["sourceEnd"]), int(candidate["sourceEnd"]))
        group["firstSourceIndex"] = min(int(group["firstSourceIndex"]), int(candidate["sourceIndex"]))
        positions = cast(dict[int, str], group["positions"])
        conflicting = False
        for ordinal, step in cast(list[tuple[int, str]], candidate["steps"]):
            existing = positions.get(ordinal)
            if existing is None:
                positions[ordinal] = step
                continue
            reconciled = _reconcile_sequence_step_reading(existing, step)
            if reconciled is None:
                conflicting = True
                break
            positions[ordinal] = reconciled
        if conflicting:
            group["conflict"] = True

    accepted: list[dict[str, Any]] = []
    for group in grouped.values():
        positions = cast(dict[int, str], group["positions"])
        ordinals = sorted(positions)
        if group.get("conflict"):
            rejected.append(_public_usage_sequence_decision(group, "conflicting-source-ordinal"))
            continue
        if not ordinals:
            continue
        if ordinals[0] != 1:
            rejected.append(_public_usage_sequence_decision(group, "orphan-ordinal-start"))
            continue
        if ordinals != list(range(1, len(ordinals) + 1)):
            rejected.append(_public_usage_sequence_decision(group, "non-contiguous-ordinals"))
            continue
        accepted.append(
            {
                **group,
                "ordinals": ordinals,
                "steps": [positions[ordinal] for ordinal in ordinals],
            }
        )

    selected: dict[str, Any] | None = None
    if accepted:
        selected = max(accepted, key=_usage_sequence_selection_key)
        for candidate in accepted:
            if candidate is not selected:
                rejected.append(_public_usage_sequence_decision(candidate, "lower-priority-source-sequence"))

    accepted_decisions = [_public_usage_sequence_decision(selected, "accepted-contiguous-ordinals")] if selected else []
    diagnostics = {
        "accepted": accepted_decisions,
        "rejected": rejected,
        "acceptedCount": len(accepted_decisions),
        "rejectedCount": len(rejected),
    }
    return (
        [f"{ordinal}. {step}" for ordinal, step in zip(cast(list[int], selected["ordinals"]), cast(list[str], selected["steps"]), strict=True)]
        if selected
        else []
    ), diagnostics


def _numbered_usage_sequence_candidates(value: str, source_index: int) -> list[dict[str, Any]]:
    # Visual OCR line groups carry a stronger section boundary than flattened
    # text. In particular, an unpunctuated final ordinal must stop before the
    # next semantic heading instead of swallowing its body into the last step.
    parsed_candidates: list[dict[str, Any]] = []
    for section in parse_ocr_block_sections(value):
        heading = _text(section.get("heading")) or ""
        if section_heading_category(heading) != "usage":
            continue
        parsed_steps = [
            (ordinal, item_text)
            for raw_item in as_list(section.get("items")) or []
            if (item := as_mapping(raw_item)) is not None
            and isinstance(ordinal := item.get("ordinal"), int)
            and (item_text := _text(item.get("text")))
        ]
        if parsed_steps:
            parsed_candidates.append(
                _numbered_usage_sequence_candidate(
                    heading,
                    parsed_steps,
                    source_index,
                    source_start=0,
                    source_end=len(value),
                )
            )
    if parsed_candidates:
        return parsed_candidates

    headings = _usage_sequence_headings(value)
    candidates: list[dict[str, Any]] = []
    for heading_index, heading in enumerate(headings):
        body_end = headings[heading_index + 1]["start"] if heading_index + 1 < len(headings) else len(value)
        body = value[int(heading["end"]) : int(body_end)]
        markers = _usage_sequence_ordinal_markers(body)
        if not markers:
            continue
        ordinals = [int(marker.group("ordinal")) for marker in markers]
        steps: list[tuple[int, str]] = []
        reason: str | None = None
        for position, marker in enumerate(markers):
            end = markers[position + 1].start() if position + 1 < len(markers) else len(body)
            step = _normalize_sequence_step(body[marker.end() : end])
            if reason := _sequence_step_rejection_reason(step):
                break
            steps.append((int(marker.group("ordinal")), step))
        candidates.append(
            _numbered_usage_sequence_candidate(
                str(heading["label"]),
                steps,
                source_index,
                source_start=int(heading["start"]),
                source_end=int(body_end),
                ordinals=ordinals,
                reason=reason,
            )
        )
    return candidates


def _numbered_usage_sequence_candidate(
    heading: str,
    steps: Sequence[tuple[int, str]],
    source_index: int,
    *,
    source_start: int,
    source_end: int,
    ordinals: Sequence[int] | None = None,
    reason: str | None = None,
) -> dict[str, Any]:
    candidate: dict[str, Any] = {
        "heading": heading,
        "headingKey": _sequence_heading_key(heading),
        "sourceIndex": source_index,
        "sourceStart": source_start,
        "sourceEnd": source_end,
        "ordinals": list(ordinals if ordinals is not None else (ordinal for ordinal, _step in steps)),
        "steps": [],
    }
    if _NON_PRODUCT_ROUTINE_HEADING.search(heading):
        candidate["reason"] = "non-product-routine-heading"
        return candidate
    if _is_commerce_cross_sell_sequence(steps):
        candidate["reason"] = "commerce-cross-sell-sequence"
        return candidate
    if reason:
        candidate["reason"] = reason
        return candidate
    accepted_steps: list[tuple[int, str]] = []
    for ordinal, step in steps:
        if step_reason := _sequence_step_rejection_reason(step):
            candidate["reason"] = step_reason
            return candidate
        accepted_steps.append((ordinal, step))
    candidate["steps"] = accepted_steps
    return candidate


def _is_commerce_cross_sell_sequence(steps: Sequence[tuple[int, str]]) -> bool:
    """Keep commerce actions from impersonating product application.

    Merchant OCR often uses a generic ``RITUAL`` heading for a cross-sell,
    so heading wording is not reliable routing evidence. Require an explicit
    commerce action or a clear cart/routine-composition context; relational
    words such as ``matching`` and ``companion`` also occur in valid product
    procedures and are not sufficient on their own.
    """

    return any(_SEQUENCE_COMMERCE_ACTION.search(step) for _ordinal, step in steps)


def _usage_sequence_headings(value: str) -> list[dict[str, int | str]]:
    headings: list[dict[str, int | str]] = []
    for marker in _USAGE_SEQUENCE_HEADING.finditer(value):
        if not _looks_like_usage_sequence_heading(value, marker):
            continue
        label = _usage_sequence_heading_label(value, marker)
        headings.append({"label": label, "start": marker.start(), "end": marker.end()})
    return headings


def _looks_like_usage_sequence_heading(value: str, marker: re.Match[str]) -> bool:
    token = marker.group().strip()
    if not re.fullmatch(r"ritual|routine", token, re.IGNORECASE):
        return True
    prefix = value[: marker.start()]
    suffix = value[marker.end() :]
    return bool(
        token.isupper()
        or not prefix.strip()
        or prefix[-1:] in {"\n", "\r", ".", "!", "?", "。", "！", "？", ":", "："}
        or re.match(r"\s*(?::|：|(?:step\s*)?\d+)", suffix, re.IGNORECASE)
    )


def _usage_sequence_heading_label(value: str, marker: re.Match[str]) -> str:
    prefix = value[max(value.rfind("\n", 0, marker.start()) + 1, marker.start() - 64) : marker.start()]
    uppercase_prefix = re.search(r"(?:(?:[A-Z0-9][A-Z0-9&'’/\-]*\s+){0,4})$", prefix)
    if uppercase_prefix is not None:
        label = f"{uppercase_prefix.group()}{marker.group()}".strip()
        if label:
            return label
    return marker.group().strip()


def _usage_sequence_ordinal_markers(body: str) -> list[re.Match[str]]:
    """Select the positions a usage section lists, not every number it prints.

    A list position is recognised by the run it belongs to.  The run opens at
    one, and each number after it either opens the next position or repeats a
    position already open, because OCR reads the same visual line more than
    once.  A number that does neither measures something -- a volume, a weight,
    a count -- and stays inside the step whose text it belongs to; a weight can
    never be the next position in a two-step procedure.

    A position the page marks itself -- with a delimiter, or after a sentence
    boundary -- is always read, including one that starts at two and belongs to
    no run.  Such a position is the evidence that the page's list is incomplete,
    and the caller needs to see it to leave the procedure unpublished rather
    than renumber a ``Step 2`` into position one.

    The run is what the *unmarked* positions are read by, and reading them is
    what keeps a procedure whole: a flattened OCR line ends without
    punctuation, so the ordinal printed after it was invisible and its step was
    swallowed by the step before it.  The run's own opening still needs the
    page's own marking, because nothing precedes it to continue.
    """

    markers: list[re.Match[str]] = []
    opened: dict[int, re.Match[str]] = {}
    for marker in _USAGE_SEQUENCE_ORDINAL.finditer(body):
        ordinal = int(marker.group("ordinal"))
        if not _is_explicit_usage_ordinal_marker(body, marker) and not _continues_usage_sequence_run(
            body, marker, ordinal, markers, opened
        ):
            continue
        markers.append(marker)
        opened.setdefault(ordinal, marker)
    return markers


def _continues_usage_sequence_run(
    body: str,
    marker: re.Match[str],
    ordinal: int,
    markers: Sequence[re.Match[str]],
    opened: Mapping[int, re.Match[str]],
) -> bool:
    """Return whether an unmarked number is the run's next position or a re-reading.

    Two kinds of number sit inside a usage section without the page marking
    either: the position of a step whose visual line lost its punctuation, and
    a quantity inside a step's own wording.  Telling them apart is what decides
    whether a procedure survives whole, and the run's shape tells them apart
    without a lexicon of units or verbs.

    A repeated position is the same instruction transcribed a second time -- a
    heading run and a photograph caption carry the same step -- so it begins
    where that instruction begins.  A number inside a step's wording continues
    that step instead, and reads on into different words.

    A new position can only open once the position now open has closed.  A
    quantity never can: it stands mid-clause, and the step it belongs to has
    not ended where it appears.
    """

    if not markers:
        # Nothing precedes this number, so there is no run for it to continue.
        return False
    first = opened.get(ordinal)
    if first is not None:
        return _sequence_step_opening(body[marker.end() :]) == _sequence_step_opening(body[first.end() :])
    if ordinal != len(opened) + 1:
        return False
    return _SEQUENCE_SENTENCE_END.search(body[markers[-1].end() : marker.start()]) is not None


def _sequence_step_opening(value: str) -> str:
    """Return the words a step reading starts on, for comparing two readings."""

    return " ".join(re.findall(r"\w+", value)[:3]).casefold()


def _is_explicit_usage_ordinal_marker(value: str, marker: re.Match[str]) -> bool:
    if marker.group("delimiter"):
        return True
    prefix = value[: marker.start()].rstrip()
    return not prefix or bool(re.search(r"[.!?。！？:：]$", prefix))


def _normalize_sequence_step(value: str) -> str:
    """Return one step's instruction without the page furniture printed beside it.

    A flattened OCR step carries whatever the page printed next to it: the
    product's own name plate, its package copy, a badge row, the slogan under
    the last photograph.  None of that is part of the instruction, and left in
    place it also makes two readings of one step look like two different steps.

    Sentence boundaries are read from the first, not only the last, because the
    name plate sits between the instruction and whatever the page printed after
    it rather than after everything.  A step whose OCR line lost its
    punctuation has no boundary to read, so it ends at the furniture itself --
    a run of full-caps tokens is a name plate, never a clause.
    """

    text = _normalize(value)
    for sentence_end in re.finditer(r"[.!?。！？](?=\s|$)", text):
        trailing = text[sentence_end.end() :].strip()
        if trailing and _looks_like_sequence_footer_label(trailing):
            return _normalize(text[: sentence_end.end()])
    tokens = text.split(" ")
    for index in range(1, max(len(tokens) - _MINIMUM_SEQUENCE_LABEL_TOKENS + 1, 1)):
        if _looks_like_sequence_footer_label(" ".join(tokens[index:])):
            return _normalize(" ".join(tokens[:index]))
    return text


def _looks_like_sequence_footer_label(value: str) -> bool:
    """Remove an OCR product tag without shortening a source instruction."""

    if not value:
        return False
    if len(value) <= 80 and re.fullmatch(r"[A-Z0-9][A-Z0-9&'’/.\-]*(?:\s+[A-Z0-9][A-Z0-9&'’/.\-]*){0,7}", value):
        return True
    return bool(
        len(value) > 80
        and re.search(r"\b\d+(?:[.,]\d+)?\s*(?:ppm|fl\.?\s*oz|m[lL]|oz|g)\b", value, re.IGNORECASE)
        and re.search(r"(?:\b[A-Z][A-Z0-9&'’/\-]{1,}\b\s*){2,}", value)
    )


def _sequence_step_rejection_reason(value: str) -> str | None:
    if len(value) < 8:
        return "empty-or-truncated-ordinal-step"
    if re.search(r"[?？]", value):
        return "non-instruction-ordinal-step"
    if _SEQUENCE_PACKAGING_OR_STORAGE.search(value):
        return "packaging-or-storage-step"
    if _SEQUENCE_MEASUREMENT_OR_STUDY.search(value):
        return "measurement-or-study-step"
    return None


def _sequence_heading_key(value: str) -> str:
    return re.sub(r"[^\w가-힣ぁ-んァ-ン]+", " ", value.casefold()).strip()


def _sequence_step_key(value: str) -> str:
    return re.sub(r"[^\w가-힣ぁ-んァ-ン]+", " ", value.casefold()).strip()


def _reconcile_sequence_step_reading(existing: str, candidate: str) -> str | None:
    """Reconcile two readings of one position, or report that they disagree.

    A page's procedure is read more than once -- a heading run and the caption
    under each photograph transcribe the same instruction -- and a slice
    boundary can cut one of those readings short.  A reading the other contains
    is the same instruction read less completely, so the fuller one stands and
    the pair corroborates the position rather than contradicting it.

    Readings that diverge are still a conflict.  There the page states two
    different instructions at one position, and which one it means is not
    something this stage can decide, so the procedure is left unpublished.
    """

    existing_key, candidate_key = _sequence_step_key(existing), _sequence_step_key(candidate)
    if existing_key == candidate_key or candidate_key in existing_key:
        return existing
    if existing_key in candidate_key:
        return candidate
    return None


def _usage_sequence_selection_key(candidate: Mapping[str, Any]) -> tuple[int, int, int]:
    heading = str(candidate.get("heading") or "")
    return (
        1 if re.search(r"ritual", heading, re.IGNORECASE) else 0,
        len(cast(list[str], candidate.get("steps") or [])),
        -int(candidate.get("firstSourceIndex") or 0),
    )


def _public_usage_sequence_decision(candidate: Mapping[str, Any] | None, reason: str) -> dict[str, Any]:
    if candidate is None:
        return {"heading": "", "ordinals": [], "count": 0, "reason": reason}
    raw_ordinals = candidate.get("ordinals")
    if isinstance(raw_ordinals, list):
        ordinals = cast(list[object], raw_ordinals)
    else:
        positions = candidate.get("positions")
        ordinals = sorted(cast(Mapping[int, str], positions).keys()) if isinstance(positions, Mapping) else []
    integer_ordinals = [value for value in ordinals if isinstance(value, int)]
    return {
        "heading": str(candidate.get("heading") or ""),
        "ordinals": integer_ordinals,
        "count": len(ordinals),
        "reason": reason,
        "sourceStart": candidate.get("sourceStart", 0),
        "sourceEnd": candidate.get("sourceEnd", 0),
    }


def _heading_target(heading: str) -> str | None:
    if section_heading_category(heading) == "safety":
        return "safety"
    if any(token in heading for token in ("ingredient", "성분")):
        return "ingredients"
    if any(token in heading for token in ("how to", "usage", "direction", "사용")):
        return "usage"
    if any(token in heading for token in ("benefit", "효능")):
        return "benefits"
    if any(token in heading for token in ("effect", "효과")):
        return "effects"
    return None


def _join_slice_overlap(
    first: str, second: str, *, tolerate_dropped_tokens: bool = False
) -> tuple[str, list[str], bool]:
    """Join only distinctive visual-line overlap, otherwise retain a newline boundary.

    A non-overlap boundary has no trustworthy layout ownership.  The caller
    therefore marks it for the layout stitcher to discard rather than letting
    duplicate/ambiguous groups turn into product facts.
    """

    first_lines = _normalize_ocr_text(first).split("\n")
    second_lines = _normalize_ocr_text(second).split("\n")
    maximum = min(12, len(first_lines), len(second_lines))
    for width in range(maximum, 0, -1):
        tail_lines = first_lines[-width:]
        head_lines = second_lines[:width]
        tail = "\n".join(tail_lines)
        tail_fingerprint = normalize_ocr_comparison_text(tail)
        if len(tail_fingerprint) < _distinctive_overlap_length(tail_fingerprint):
            continue
        head = "\n".join(head_lines)
        agrees = tail_fingerprint == normalize_ocr_comparison_text(head) or (
            tolerate_dropped_tokens and _overlap_readings_agree(tail_lines, head_lines)
        )
        if agrees:
            return "\n".join([*first_lines, *second_lines[width:]]), head_lines, False
    return "\n".join([*first_lines, *second_lines]), [], True


def _distinctive_overlap_length(fingerprint: str) -> int:
    hangul = len(re.findall(r"[가-힣]", fingerprint))
    return 10 if hangul * 2 >= len(fingerprint) else 20


def _overlap_readings_agree(tail_lines: Sequence[str], head_lines: Sequence[str]) -> bool:
    if len(tail_lines) != len(head_lines) or not tail_lines:
        return False
    agreements = [_line_readings_agree(tail, head) for tail, head in zip(tail_lines, head_lines, strict=True)]
    return all(agrees for agrees, _tokens in agreements) and any(tokens >= 3 for _agrees, tokens in agreements)


def _line_readings_agree(tail: str, head: str) -> tuple[bool, int]:
    tail_tokens = re.findall(r"[^\W_]+", tail.casefold(), re.UNICODE)
    head_tokens = re.findall(r"[^\W_]+", head.casefold(), re.UNICODE)
    shorter, longer = (tail_tokens, head_tokens) if len(tail_tokens) <= len(head_tokens) else (head_tokens, tail_tokens)
    if len(shorter) < 2:
        return shorter == longer, len(shorter)
    cursor = 0
    matched = 0
    for token in shorter:
        try:
            found = longer.index(token, cursor)
        except ValueError:
            continue
        cursor = found + 1
        matched += 1
    return matched / len(shorter) >= 0.8, len(shorter)


def _unique_urls(values: Sequence[object] | Any) -> list[str]:
    output: list[str] = []
    for value in values:
        text = _text(value)
        if text and text not in output:
            output.append(text)
    return output


def _confidence(value: object) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _text(value: object) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None
