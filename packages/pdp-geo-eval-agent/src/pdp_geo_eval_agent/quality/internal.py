"""Pure schema, validation, and lint helpers behind the quality rubric."""

from __future__ import annotations

import math
import re
from collections.abc import Mapping, Sequence
from typing import cast

from neo_js_compat import js_round

from ..contracts.serialized_metadata import find_serialized_metadata_artifact
from .copy import GeoQualityCopy, get_geo_quality_copy


def get_schema_graph(json_ld: object) -> list[object]:
    """Return JSON-LD graph records in the same order as the JavaScript API."""
    # The legacy ``isRecord`` helper is deliberately only ``typeof value ===
    # "object"``. JSON arrays therefore enter the non-``@graph`` branch as
    # an array node. Keep that node, rather than collapsing it to ``{}``, so
    # recursive text readers retain objects contained by root/nested arrays.
    if isinstance(json_ld, list):
        return [json_ld]
    if not isinstance(json_ld, Mapping):
        return []
    record = _record(cast(object, json_ld))
    graph = record.get("@graph")
    if isinstance(graph, list):
        # ``Array.isArray`` has already selected the graph container. Its
        # TypeScript ``filter(isRecord)`` retains nested arrays too because
        # arrays are objects there. Retain arrays recursively for downstream
        # text readers while mapping-only readers naturally see no fields.
        return [_record(cast(object, node)) if isinstance(node, Mapping) else node for node in _objects(cast(object, graph)) if isinstance(node, Mapping | list)]
    return [record]


def get_schema_node_types(node: object) -> list[str]:
    value = _record(node).get("@type")
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [item for item in _objects(cast(object, value)) if isinstance(item, str)]
    return []


def find_schema_node(graph: Sequence[object], type_name: str) -> dict[str, object] | None:
    return next((_record(cast(object, node)) for node in graph if isinstance(node, Mapping) and type_name in get_schema_node_types(_record(cast(object, node)))), None)


def get_record_string(record: object, key: str) -> str:
    value = _record(record).get(key)
    return value if isinstance(value, str) else ""


def count_schema_items(value: object) -> int:
    if isinstance(value, list):
        return sum(1 for item in _objects(cast(object, value)) if _js_truthy(item))
    if isinstance(value, Mapping):
        record = _record(cast(object, value))
        for key in ("itemListElement", "mainEntity", "step"):
            nested = record.get(key)
            if isinstance(nested, list):
                return sum(1 for item in _objects(cast(object, nested)) if _js_truthy(item))
        return 1
    return int(isinstance(value, str) and bool(value.strip()))


def collect_text_values(value: object, depth: int = 0) -> list[str]:
    if depth > 5:
        return []
    if isinstance(value, str):
        return [value] if value.strip() else []
    if isinstance(value, list):
        return [text for item in _objects(cast(object, value)) for text in collect_text_values(item, depth + 1)]
    if isinstance(value, Mapping):
        return [text for item in _record(cast(object, value)).values() for text in collect_text_values(item, depth + 1)]
    return []


def collect_schema_faq_questions(faq_node: Mapping[str, object] | None) -> list[str]:
    entities = faq_node.get("mainEntity") if faq_node else None
    return [name.strip() for item in _objects(entities) if isinstance((name := _record(item).get("name")), str) and name.strip()]


def count_valid_schema_faq_items(faq_node: Mapping[str, object]) -> int:
    entities = faq_node.get("mainEntity")
    return sum(
        1
        for entity in _objects(entities)
        if "Question" in get_schema_node_types(_record(entity))
        and bool(get_record_string(_record(entity), "name").strip())
        and isinstance((answer := _record(entity).get("acceptedAnswer")), Mapping)
        and "Answer" in get_schema_node_types(_record(cast(object, answer)))
        and bool(get_record_string(_record(cast(object, answer)), "text").strip())
    )


def count_valid_how_to_steps(how_to_node: Mapping[str, object]) -> int:
    steps = how_to_node.get("step")
    return sum(
        1
        for step in _objects(steps)
        if "HowToStep" in get_schema_node_types(step)
        and bool(get_record_string(step, "name").strip())
        and bool(get_record_string(step, "text").strip())
    )


def count_dangling_local_schema_references(graph: Sequence[object]) -> int:
    node_ids = {get_record_string(node, "@id").strip() for node in graph if get_record_string(node, "@id").strip()}
    local_bases = {re.sub(r"#[^#]*$", "", identifier) for identifier in node_ids}
    relation_keys = ("about", "mainEntity", "mainEntityOfPage", "breadcrumb", "hasPart", "isPartOf")
    references = [reference for node in graph for key in relation_keys for reference in _collect_schema_id_references(_record(node).get(key))]
    dangling = {
        reference
        for reference in references
        if "#" in reference and reference not in node_ids and re.sub(r"#[^#]*$", "", reference) in local_bases
    }
    return len(dangling)


def count_schema_nodes(json_ld: object) -> int:
    if isinstance(json_ld, list):
        return 1
    if not isinstance(json_ld, Mapping):
        return 0
    graph = _record(cast(object, json_ld)).get("@graph")
    return len(_objects(cast(object, graph))) if isinstance(graph, list) else 1


def unique_quality_items(items: Sequence[str | None]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for item in items:
        if not isinstance(item, str) or not item.strip() or item in seen:
            continue
        seen.add(item)
        result.append(item)
    return result


def ensure_quality_items(items: Sequence[str | None], fallback: str) -> list[str]:
    unique_items = unique_quality_items(items)
    return unique_items or [fallback]


def clamp_quality_score(score: float) -> int:
    # Rubric scores are clamped to [0, 100], so JavaScript's observable -0
    # edge case cannot survive this boundary.  Store a Python int so report
    # interpolation mirrors JavaScript's ``90`` rather than ``90.0``.
    return int(max(0, min(100, js_round(score))))


def compact_quality_text(value: str, max_length: int = 180) -> str:
    compacted = re.sub(r"\s+", " ", value).strip()
    if _js_code_unit_length(compacted) <= max_length:
        return compacted
    return f"{_js_slice_units(compacted, max(0, max_length - 3)).strip()}..."


def limit_quality_validation_lines(items: list[str], copy: GeoQualityCopy) -> list[str]:
    max_items = 24
    return items if len(items) <= max_items else [*items[:max_items], copy.validation_more_details(len(items) - max_items)]


def is_disabled_html_content_validation_scope(value: str) -> bool:
    return bool(re.search(r"^content(?:\.|\b)", value.strip(), re.I) or re.search(r"(?:generated\s+html|html\s+content|accordion\s+html)", value, re.I))


def collect_public_artifact_hits(public_text: str, faq_questions: Sequence[str], language: str) -> list[str]:
    copy = get_geo_quality_copy(language)
    hits: list[str] = []
    source_heading_question = next((question for question in faq_questions if re.fullmatch(r"(?:key ingredients|ingredients|benefits|how to use|summary)", question.strip(), re.I)), None)
    ocr_noise = _search_group(r"\b(?:3Home|SÉRUM|SERUM\s+ACTIVATEUR|ACTIVATEUR)\b", public_text, re.I)
    internal_label = _search_group(r"\b(?:fallbackDescription|sentence QA|RAG chunk|schema-validator|html-validator)\b", public_text, re.I)
    serialized_metadata = find_serialized_metadata_artifact(public_text)
    if source_heading_question:
        hits.append(copy.faq_heading_artifact(source_heading_question))
    if ocr_noise:
        hits.append(copy.ocr_noise_artifact(ocr_noise))
    if internal_label:
        hits.append(copy.internal_artifact(internal_label))
    if serialized_metadata:
        hits.append(copy.serialized_metadata_artifact(serialized_metadata))
    return unique_quality_items(hits)


def collect_metric_integrity_issues(public_text: str, language: str) -> list[str]:
    copy = get_geo_quality_copy(language)
    split_metrics = re.findall(r"\+\d+\.\s+\d%", public_text)
    low_agreement_metrics = re.findall(r"\b[1-9]%\s+agreed\b", public_text, re.I)
    duplicated_unit = _search_group(r"\d+(?:\.\d+)?%%", public_text)
    duplicated_word = _search_group(r"\b(supports|helps|improves|reduces|provides)\s+\1\b", public_text, re.I)
    implausible_magnitude = _search_group(r"\b[a-z][a-z\s&,-]{2,60}\s(?:decreased|reduced|improved|increased)\sby\s(?:9[5-9]|100)\s?%", public_text, re.I)
    self_assessment_upgrade = _search_group(
        r"(?:self[-\s]?assessment|자가\s*평가)(?:(?!instrumental|기기\s*측정|임상|clinical\s+stud)[^.!?;]){0,120}(?:\b(?:showed|demonstrated|confirmed|proved|saw|exhibited)\b[^.!?;]{0,60}\bimprovement|\bimproved\s+by\b|개선(?:을|이)?\s*(?:확인|입증|보였))",
        public_text,
        re.I,
    )
    contradictory_modality = _search_group(
        r"clinical\s+self[-\s]?assessment|self[-\s]?assessment\s+(?:from|of|via|in)\s+(?:a\s+)?clinical|임상\s*(?:시험)?\s*(?:기반|의)?\s*자가\s*평가",
        public_text,
        re.I,
    )
    duplicated_stem = _search_group(
        r"\b(improvement|reduction|increase|decrease)\s+(?:in|of)\s+(?:(?!and\b|or\b)[A-Za-z-]+\s+){0,3}\1\s+(?:in|of)\b",
        public_text,
        re.I,
    )
    spliced_clause = _search_group(
        r"[a-z],? (?:After|Before|During|Within) (?:one|two|three|a |an |the |\d|use|using|daily|application|cleansing)",
        public_text,
    )
    return unique_quality_items([
        *(copy.metric_split_issue(value) for value in split_metrics),
        *(copy.low_agreement_issue(value) for value in low_agreement_metrics),
        copy.duplicated_unit_issue(duplicated_unit) if duplicated_unit else None,
        copy.duplicated_word_issue(duplicated_word) if duplicated_word else None,
        copy.implausible_magnitude_issue(implausible_magnitude.strip()) if implausible_magnitude else None,
        copy.self_assessment_upgrade_issue(compact_quality_text(self_assessment_upgrade.strip(), 120)) if self_assessment_upgrade else None,
        copy.contradictory_modality_issue(compact_quality_text(contradictory_modality.strip(), 120)) if contradictory_modality else None,
        copy.duplicated_stem_issue(compact_quality_text(duplicated_stem.strip(), 120)) if duplicated_stem else None,
        copy.spliced_clause_issue(compact_quality_text(spliced_clause.strip(), 120)) if spliced_clause else None,
    ])


def has_ingredient_benefit_choice_bridge(text: str) -> bool:
    return bool(re.search(r"(?:ingredient|active|extract|formula|formulated|contains|powered by|with|ceramide|capsule|technology|성분|함유|포함|포뮬러|캡슐|세라마이드|기술).{0,180}(?:help|support|improv|target|benefit|elastic|firm|wrinkle|barrier|hydration|moistur|radiance|texture|효능|효과|개선|강화|제공|도움|보습|수분|장벽|진정|선택|추천)", text, re.I | re.S))


def has_customer_choice_cue(text: str) -> bool:
    return bool(re.search(r"(?:skin type|works best for|solution for|ideal for|for customers|for users|concern|wrinkle|elasticity|dry|oily|combination|sensitive|피부|고민|선택|추천|적합)", text, re.I))


def has_selection_criteria_cue(text: str) -> bool:
    return bool(re.search(r"(?:choose|choice|selection|works best|solution for|skin type|customer|고객|선택|추천|적합)", text, re.I))


def has_reported_sample_scope_disclosure(public_text: str) -> bool:
    return bool(re.search(
        r"(?:시험\s*대상|조사\s*대상|표본|대상자|sample|test\s+audience|study\s+audience|participants?|subjects?).{0,48}(?:확인되지|확인\s*불가|미공개|명시되지|not\s+disclosed|not\s+stated|not\s+specified)",
        public_text,
        re.I,
    ) or re.search(
        r"(?:원문|공개\s*범위|public\s+source).{0,64}(?:시험\s*대상|조사\s*대상|표본|sample|audience).{0,48}(?:확인되지|확인\s*불가|미공개|명시되지|not\s+disclosed|not\s+stated|not\s+specified)",
        public_text,
        re.I,
    ))


def partition_validation_warnings(warnings: Sequence[str], repairs: Sequence[Mapping[str, object]]) -> dict[str, list[str]]:
    unresolved_warnings = list(warnings)
    resolved_warnings: list[str] = []
    for repair in repairs:
        field = _string(repair.get("field")).strip().lower()
        if not field:
            continue
        index = next((index for index, warning in enumerate(unresolved_warnings) if field in warning.lower()), -1)
        if index >= 0:
            resolved_warnings.append(unresolved_warnings.pop(index))
    return {"resolvedWarnings": resolved_warnings, "unresolvedWarnings": unresolved_warnings}


def collect_validation_detail_lines(diagnostics: Mapping[str, object], copy: GeoQualityCopy) -> list[str]:
    repairs = _repairs(diagnostics)
    repair_lines = [
        copy.validation_repair_detail(
            index + 1,
            compact_quality_text(_string(repair.get("field"))),
            compact_quality_text(_string(repair.get("source"))),
            compact_quality_text(_string(repair.get("issue"))),
            compact_quality_text(_string(repair.get("action"))),
        )
        for index, repair in enumerate(repairs)
    ]
    warnings = [warning for warning in _strings(diagnostics.get("validationWarnings")) if not is_disabled_html_content_validation_scope(warning)]
    unresolved_warnings = partition_validation_warnings(warnings, repairs)["unresolvedWarnings"]
    warning_lines = [copy.validation_warning_detail(len(repair_lines) + index + 1, compact_quality_text(warning)) for index, warning in enumerate(unresolved_warnings)]
    return limit_quality_validation_lines(unique_quality_items([*repair_lines, *warning_lines]), copy)


def collect_validation_improvement_lines(diagnostics: Mapping[str, object], copy: GeoQualityCopy) -> list[str]:
    repairs = _repairs(diagnostics)
    warnings = [warning for warning in _strings(diagnostics.get("validationWarnings")) if not is_disabled_html_content_validation_scope(warning)]
    unresolved_warnings = partition_validation_warnings(warnings, repairs)["unresolvedWarnings"]
    scopes = unresolved_warnings if unresolved_warnings else warnings
    directions = unique_quality_items([infer_validation_direction(scope, copy) for scope in scopes])
    return directions if directions else ([copy.validation_generic_direction] if warnings else [])


def infer_validation_direction(value: str, copy: GeoQualityCopy) -> str | None:
    scope = value.lower()
    if re.search(r"(?:additionalproperty|propertyvalue|additional property|property value)", scope):
        return copy.property_validation_direction
    if re.search(r"(?:howto|how-to|how_to|howtouse|how to use|\bstep\b|사용\s*방법)", scope):
        return copy.how_to_validation_direction
    if re.search(r"(?:faq|question|answer|mainentity|acceptedanswer|질문|답변)", scope):
        return copy.faq_validation_direction
    if re.search(r"(?:description|webpage|product\.description|페이지\s*설명|상품\s*설명)", scope):
        return copy.description_validation_direction
    if re.search(r"(?:html|markup|script|style|dom|마크업)", scope):
        return copy.html_validation_direction
    if re.search(r"(?:metric|claim|evidence|sample|period|agreement|percent|%|수치|표본|기간|측정)", scope):
        return copy.claim_validation_direction
    if re.search(r"(?:ingredient|benefit|positive|effect|efficacy|성분|효능|효과|피부\s*타입)", scope):
        return copy.fact_validation_direction
    if re.search(r"(?:korean|spacing|particle|grammar|copy|awkward|문법|띄어쓰기|조사|어색)", scope):
        return copy.copy_validation_direction
    return None


def _collect_schema_id_references(value: object) -> list[str]:
    if isinstance(value, list):
        return [reference for item in _objects(cast(object, value)) for reference in _collect_schema_id_references(item)]
    if not isinstance(value, Mapping):
        return []
    identifier = get_record_string(_record(cast(object, value)), "@id").strip()
    return [identifier] if identifier else []


def _js_truthy(value: object) -> bool:
    if value is None or value is False:
        return False
    if isinstance(value, (int, float)) and (value == 0 or (isinstance(value, float) and math.isnan(value))):
        return False
    if isinstance(value, str):
        return bool(value)
    return True


def _js_code_unit_length(value: str) -> int:
    return len(value.encode("utf-16-le", errors="surrogatepass")) // 2


def _js_slice_units(value: str, end: int) -> str:
    return value.encode("utf-16-le", errors="surrogatepass")[: end * 2].decode("utf-16-le", errors="surrogatepass")


def _search_group(pattern: str, value: str, flags: re.RegexFlag = re.NOFLAG) -> str | None:
    match = re.search(pattern, value, flags)
    return match.group(0) if match else None


def _strings(value: object) -> list[str]:
    return [item for item in _objects(value) if isinstance(item, str)]


def _repairs(diagnostics: Mapping[str, object]) -> list[Mapping[str, object]]:
    repairs = diagnostics.get("validationRepairs")
    return [record for repair in _objects(repairs) if (record := _record(repair)) and not is_disabled_html_content_validation_scope(_string(record.get("field")))]


def _string(value: object) -> str:
    return value if isinstance(value, str) else ""


def _objects(value: object) -> list[object]:
    return list(cast(list[object], value)) if isinstance(value, list) else []


def _record(value: object) -> dict[str, object]:
    if not isinstance(value, Mapping):
        return {}
    return {str(key): item for key, item in cast(Mapping[object, object], value).items()}
