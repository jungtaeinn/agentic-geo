"""Post-validation JSON-LD graph cleanup and visible-content parity."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Final, TypeGuard, cast

_LOCALIZED_CREATIVE_WORK_TYPES: Final[frozenset[str]] = frozenset(
    {"WebPage", "ItemPage", "CollectionPage", "AboutPage", "FAQPage", "HowTo"}
)
_UNDEFINED: Final[object] = object()


def _is_record(value: object) -> TypeGuard[Mapping[str, object]]:
    return isinstance(value, Mapping)


def _node(value: Mapping[str, object]) -> dict[str, object]:
    return dict(value)


def _string_value(value: object) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _node_type_values(node: Mapping[str, object]) -> list[str]:
    value = node.get("@type")
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [item for item in cast(list[object], value) if isinstance(item, str)]
    return []


def _collection_items(value: object) -> list[dict[str, object]]:
    if isinstance(value, list):
        return [_node(item) for item in cast(list[object], value) if _is_record(item)]
    return [_node(value)] if _is_record(value) else []


def _to_json_value(value: object) -> object:
    if value is None or isinstance(value, str | int | float | bool):
        return value
    if isinstance(value, list):
        return [_to_json_value(item) for item in cast(list[object], value)]
    if _is_record(value):
        return {key: _to_json_value(item) for key, item in value.items()}
    return str(value)


def _repair(
    field: str, source: str, issue: str, action: str, before: object, after: object, evidence: list[str]
) -> dict[str, object]:
    repair: dict[str, object] = {"field": field, "source": source, "issue": issue, "action": action}
    if before is not _UNDEFINED:
        repair["before"] = _to_json_value(before)
    if after is not _UNDEFINED:
        repair["after"] = _to_json_value(after)
    repair["evidence"] = evidence
    return repair


def capture_structured_content_snapshot(graph: Sequence[Mapping[str, object]]) -> dict[str, bool]:
    """Capture optional nodes before field validation may remove them."""
    return {"faqNodePresent": any(node.get("@type") == "FAQPage" for node in graph)}


def _has_valid_faq_items(value: object) -> bool:
    for item in _collection_items(value):
        accepted_answer = item.get("acceptedAnswer")
        if (
            _string_value(item.get("name"))
            and _is_record(accepted_answer)
            and _string_value(accepted_answer.get("text"))
        ):
            return True
    return False


def _js_number(value: object) -> float:
    if isinstance(value, bool) or value is None:
        return float("nan")
    if isinstance(value, int | float):
        return float(value)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return 0.0
        try:
            return float(text)
        except ValueError:
            return float("nan")
    return float("nan")


def _has_valid_how_to(node: Mapping[str, object]) -> bool:
    if not _string_value(node.get("name")):
        return False
    steps = [item for item in _collection_items(node.get("step")) if _string_value(item.get("text"))]
    return bool(steps) and all(_js_number(step.get("position")) == index + 1 for index, step in enumerate(steps))


def _document_id(value: str) -> str:
    return value.split("#", 1)[0]


def _is_dangling_local_reference(
    value: object, webpage_id: str | None, defined_ids: set[str], removed_ids: set[str]
) -> bool:
    if not _is_record(value):
        return False
    reference_id = _string_value(value.get("@id"))
    if not reference_id or reference_id in defined_ids:
        return False
    if reference_id in removed_ids or reference_id.startswith("#"):
        return True
    return bool(webpage_id and _document_id(reference_id) == _document_id(webpage_id))


def repair_pdp_schema_graph_integrity(graph: Sequence[Mapping[str, object]], locale: str) -> dict[str, object]:
    """Prune invalid FAQ/HowTo nodes, local dangling links, and wrong locales."""
    repairs: list[dict[str, object]] = []
    removed_ids: set[str] = set()
    retained: list[dict[str, object]] = []
    for input_node in graph:
        node = _node(input_node)
        type_ = _string_value(node.get("@type"))
        empty_collection_field = "mainEntity" if type_ == "FAQPage" else "step" if type_ == "HowTo" else None
        has_valid_public_items = (
            _has_valid_faq_items(node.get("mainEntity"))
            if type_ == "FAQPage"
            else _has_valid_how_to(node)
            if type_ == "HowTo"
            else True
        )
        if empty_collection_field and not has_valid_public_items:
            identifier = _string_value(node.get("@id"))
            if identifier:
                removed_ids.add(identifier)
            issue = (
                "HowTo had no valid ordered step items after field validation."
                if type_ == "HowTo" and _string_value(node.get("name"))
                else "HowTo was missing a concrete goal name after field validation."
                if type_ == "HowTo"
                else f"{type_} had no valid {empty_collection_field} items after field validation."
            )
            action = (
                "Removed the inapplicable HowTo node while retaining source-backed directions as ordinary visible usage guidance."
                if type_ == "HowTo"
                else f"Removed the empty {type_} node instead of publishing an inapplicable structured-data entity."
            )
            repairs.append(
                _repair(
                    type_ or "@graph",
                    "schema-validator",
                    issue,
                    action,
                    node,
                    None,
                    [f"{type_}.{empty_collection_field}", "post-validation graph integrity"],
                )
            )
            continue
        retained.append(node)
    defined_ids = {identifier for node in retained if (identifier := _string_value(node.get("@id")))}
    repaired_graph: list[dict[str, object]] = []
    for node in retained:
        next_node = node
        types = _node_type_values(node)
        type_ = types[0] if types else None
        if any(item in _LOCALIZED_CREATIVE_WORK_TYPES for item in types) and node.get("inLanguage") != locale:
            language_before = node["inLanguage"] if "inLanguage" in node else _UNDEFINED
            next_node = dict(next_node)
            next_node["inLanguage"] = locale
            repairs.append(
                _repair(
                    f"{type_}.inLanguage",
                    "schema-validator",
                    f"{type_}.inLanguage was missing or did not match the requested output locale.",
                    f"Set {type_}.inLanguage to the validated artifact locale.",
                    language_before,
                    locale,
                    ["requested output locale", f"{type_}.inLanguage"],
                )
            )
        if "WebPage" in _node_type_values(next_node) and "hasPart" in next_node:
            has_part_before: object = next_node["hasPart"]
            parts: list[object] = (
                cast(list[object], has_part_before) if isinstance(has_part_before, list) else [has_part_before]
            )
            webpage_id = _string_value(next_node.get("@id"))
            after: list[object] = [
                part for part in parts if not _is_dangling_local_reference(part, webpage_id, defined_ids, removed_ids)
            ]
            if len(after) != len(parts):
                next_node = dict(next_node)
                if after:
                    next_node["hasPart"] = after if isinstance(has_part_before, list) else after[0]
                else:
                    next_node.pop("hasPart", None)
                repairs.append(
                    _repair(
                        "WebPage.hasPart",
                        "schema-validator",
                        "WebPage.hasPart referenced schema nodes that were removed or were missing from the page graph.",
                        "Removed dangling local references while preserving valid graph and external references.",
                        cast(object, has_part_before),
                        after if after else None,
                        ["@graph @id index", "WebPage.hasPart", "post-validation graph integrity"],
                    )
                )
        repaired_graph.append(next_node)
    return {"graph": repaired_graph, "repairs": repairs}


def _render_faq_text(graph: Sequence[Mapping[str, object]]) -> str:
    pairs: list[str] = []
    for node in graph:
        if node.get("@type") != "FAQPage":
            continue
        for item in _collection_items(node.get("mainEntity")):
            question = _string_value(item.get("name"))
            answer_source = item.get("acceptedAnswer")
            answer = _string_value(answer_source.get("text")) if _is_record(answer_source) else None
            if question and answer:
                pairs.append(f"Q. {question}\nA. {answer}")
    return "\n\n".join(pairs)


def _render_how_to_text(graph: Sequence[Mapping[str, object]]) -> str:
    steps = [
        text
        for node in graph
        if node.get("@type") == "HowTo"
        for item in _collection_items(node.get("step"))
        if (text := _string_value(item.get("text")))
    ]
    if len(steps) == 1:
        return steps[0]
    return "\n".join(f"{index}. {text}" for index, text in enumerate(steps, start=1))


def synchronize_structured_content_with_graph(input_: Mapping[str, object]) -> dict[str, object]:
    """Rebuild visible FAQ/HowTo text from retained structured-data entities."""
    source_sections = input_.get("sections")
    sections: dict[str, object] = dict(source_sections) if _is_record(source_sections) else {}
    graph_source = input_.get("graph")
    graph_items = (
        cast(Sequence[object], graph_source)
        if isinstance(graph_source, Sequence) and not isinstance(graph_source, str | bytes | bytearray)
        else ()
    )
    graph = [_node(node) for node in graph_items if _is_record(node)]
    snapshot = input_.get("snapshot")
    faq_was_present = bool(snapshot.get("faqNodePresent")) if _is_record(snapshot) else False
    repairs: list[dict[str, object]] = []
    faq_text = _render_faq_text(graph)
    final_faq_present = any(node.get("@type") == "FAQPage" for node in graph)
    if final_faq_present and sections.get("faq") != faq_text:
        before = sections.get("faq")
        sections["faq"] = faq_text
        repairs.append(
            _repair(
                "content.sections.faq",
                "field-contract-validator",
                "Visible FAQ copy did not match the final validated FAQPage.mainEntity items.",
                "Rebuilt visible FAQ copy from the final validated FAQPage node.",
                before,
                faq_text,
                ["FAQPage.mainEntity", "structured-data and visible-content parity"],
            )
        )
    if faq_was_present and not final_faq_present and sections.get("faq") != "":
        before = sections.get("faq")
        sections["faq"] = ""
        repairs.append(
            _repair(
                "content.sections.faq",
                "field-contract-validator",
                "Visible FAQ copy remained after its invalid FAQPage node was removed.",
                "Cleared stale FAQ copy after the invalid FAQPage node was pruned.",
                before,
                "",
                ["FAQPage.mainEntity", "structured-data and visible-content parity"],
            )
        )
    how_to_text = _render_how_to_text(graph)
    final_how_to_present = any(node.get("@type") == "HowTo" for node in graph)
    if final_how_to_present and sections.get("howToUse") != how_to_text:
        before = sections.get("howToUse")
        sections["howToUse"] = how_to_text
        repairs.append(
            _repair(
                "content.sections.howToUse",
                "field-contract-validator",
                "Visible usage copy did not match the final validated HowTo.step items.",
                "Rebuilt visible usage copy from the final validated HowTo node.",
                before,
                how_to_text,
                ["HowTo.step", "structured-data and visible-content parity"],
            )
        )
    return {"sections": sections, "repairs": repairs}


captureStructuredContentSnapshot = capture_structured_content_snapshot
repairPdpSchemaGraphIntegrity = repair_pdp_schema_graph_integrity
synchronizeStructuredContentWithGraph = synchronize_structured_content_with_graph
