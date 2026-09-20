"""Validation and relationship reconstruction for provider-reported OCR layout."""

from __future__ import annotations

import re
from collections import defaultdict, deque
from collections.abc import Mapping, Sequence
from typing import Any

from .._json_types import as_list, as_mapping
from .blocks import normalize_ocr_comparison_text, normalize_ocr_figure_boundaries


def verify_ocr_layout_groups(text: str, groups: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]] | None:
    """Retain only layout lines visibly backed by the final transcription."""

    if not groups:
        return None
    comparison = normalize_ocr_comparison_text(text)
    figure_comparison = normalize_ocr_figure_boundaries(text)
    identifiers = {str(group.get("id")) for group in groups if group.get("id")}
    lines_seen = 0
    lines_kept = 0
    output: list[dict[str, Any]] = []
    for raw in groups:
        group = dict(raw)
        identifier = str(group.get("id", ""))
        kept_lines: list[dict[str, Any]] = []
        for line_raw in group.get("lines", []):
            line = dict(cast_mapping(line_raw))
            line_text = str(line.get("text", ""))
            lines_seen += 1
            backed = normalize_ocr_comparison_text(line_text) in comparison
            if line.get("role") == "value":
                backed = backed and _figure_backed(line_text, figure_comparison)
            if backed:
                kept_lines.append(line)
                lines_kept += 1
        item: dict[str, Any] = {"id": identifier, "lines": kept_lines}
        title = group.get("title")
        if isinstance(title, str) and normalize_ocr_comparison_text(title) in comparison:
            item["title"] = title
        if isinstance(group.get("ordinal"), int):
            item["ordinal"] = group["ordinal"]
        for reference in ("parentId", "annotates"):
            value = group.get(reference)
            if isinstance(value, str) and value != identifier and value in identifiers:
                item[reference] = value
        output.append(item)
    if lines_seen == 0 or lines_kept / lines_seen < 0.5:
        return None
    return output


def ocr_layout_sections(groups: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Converge a layout group tree onto the OCR block-section representation."""

    children: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    roots: list[Mapping[str, Any]] = []
    for group in groups:
        if isinstance(group.get("parentId"), str):
            children[str(group["parentId"])].append(group)
        else:
            roots.append(group)
    output: list[dict[str, Any]] = []
    for root in roots:
        root_id = str(root.get("id", ""))
        items: list[dict[str, Any]] = []
        if body := _body_text(root):
            items.append({"text": body})
        seen = {root_id}
        pending: deque[Mapping[str, Any]] = deque(children[root_id])
        while pending:
            group = pending.popleft()
            identifier = str(group.get("id", ""))
            if identifier in seen:
                continue
            seen.add(identifier)
            pending.extendleft(reversed(children[identifier]))
            if body := _body_text(group):
                item: dict[str, Any] = {"text": body}
                if isinstance(group.get("ordinal"), int):
                    item["ordinal"] = group["ordinal"]
                items.append(item)
        if root.get("title") is not None or items:
            section: dict[str, Any] = {"items": items}
            if isinstance(root.get("title"), str):
                section["heading"] = root["title"]
            output.append(section)
    return output


def stitch_sliced_layout_groups(readings: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]] | None:
    """Rebase per-slice IDs and preserve parent ownership across a joined boundary."""

    if not readings or any(not reading.get("groups") for reading in readings):
        return None
    if any(reading.get("overlapUnmatched") for reading in readings):
        return None
    ordered = sorted(readings, key=lambda item: int(item.get("sliceIndex", 0)))
    output: list[dict[str, Any]] = []
    ordered_section: tuple[str, int] | None = None
    for reading in ordered:
        slice_index = int(reading.get("sliceIndex", 0))
        prefix = f"s{slice_index}:"
        consumed = {normalize_ocr_comparison_text(str(value)) for value in reading.get("consumedLines", [])}
        groups = [dict(cast_mapping(group)) for group in reading.get("groups", [])]
        for position, group in enumerate(groups):
            lines = [
                dict(cast_mapping(line))
                for line in group.get("lines", [])
                if normalize_ocr_comparison_text(str(cast_mapping(line).get("text", ""))) not in consumed
            ]
            # A wholly consumed overlap group belongs to the prior slice even
            # if the model redundantly repeated its title.
            if not lines:
                continue
            identifier = str(group.get("id", ""))
            rebased: dict[str, Any] = {"id": f"{prefix}{identifier}", "lines": lines}
            for key in ("parentId", "title", "annotates"):
                value = group.get(key)
                if isinstance(value, str):
                    rebased[key] = f"{prefix}{value}" if key in {"parentId", "annotates"} else value
            ordinal = group.get("ordinal")
            if isinstance(ordinal, int) and not isinstance(ordinal, bool):
                rebased["ordinal"] = ordinal
            is_boundary_group = position == 0 and slice_index != int(ordered[0].get("sliceIndex", 0))
            if (
                isinstance(rebased.get("ordinal"), int)
                and "parentId" not in rebased
                and ordered_section is not None
                and ordered_section[1] == rebased["ordinal"]
            ):
                rebased["parentId"] = ordered_section[0]
            previous = output[-1] if output else None
            if (
                is_boundary_group
                and "title" not in rebased
                and "ordinal" not in rebased
                and "parentId" not in rebased
                and previous is not None
                and "title" not in previous
                and "ordinal" not in previous
            ):
                previous["lines"] = [*(as_list(previous.get("lines")) or []), *lines]
                continue
            output.append(rebased)
            if isinstance(rebased.get("ordinal"), int) and not isinstance(rebased["ordinal"], bool):
                ordered_section = (str(rebased.get("parentId") or rebased["id"]), rebased["ordinal"] + 1)
    return output or None


def _body_text(group: Mapping[str, Any]) -> str:
    title_key = normalize_ocr_comparison_text(str(group.get("title", "")))
    values: list[str] = []
    for raw in as_list(group.get("lines")) or []:
        line = cast_mapping(raw)
        if line.get("role") != "body":
            continue
        value = re.sub(r"\s+", " ", str(line.get("text", ""))).strip()
        if value and normalize_ocr_comparison_text(value) != title_key:
            values.append(value)
    return " ".join(values)


def _figure_backed(value: str, transcription: str) -> bool:
    figure = normalize_ocr_figure_boundaries(value)
    if not figure:
        return True
    return re.search(rf"(?<!\d){re.escape(figure)}(?!\d)", transcription) is not None


def cast_mapping(value: object) -> Mapping[str, Any]:
    return as_mapping(value) or {}
