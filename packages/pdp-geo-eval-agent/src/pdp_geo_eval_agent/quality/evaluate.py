"""Deterministic GEO/CEP/E-E-A-T quality evaluation over a schema.org graph."""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import cast

from neo_js_compat import js_round

from ..models import GeoQualityDimension, GeoQualityEvaluation
from .copy import get_geo_quality_copy
from .internal import (
    clamp_quality_score,
    collect_metric_integrity_issues,
    collect_public_artifact_hits,
    collect_schema_faq_questions,
    collect_text_values,
    collect_validation_detail_lines,
    collect_validation_improvement_lines,
    count_dangling_local_schema_references,
    count_schema_items,
    count_valid_how_to_steps,
    count_valid_schema_faq_items,
    ensure_quality_items,
    find_schema_node,
    get_record_string,
    get_schema_graph,
    get_schema_node_types,
    has_customer_choice_cue,
    has_ingredient_benefit_choice_bridge,
    has_reported_sample_scope_disclosure,
    has_selection_criteria_cue,
    is_disabled_html_content_validation_scope,
    partition_validation_warnings,
    unique_quality_items,
)


def evaluate_geo_quality(input: Mapping[str, object], language: str) -> GeoQualityEvaluation:
    """Evaluate arbitrary JSON-LD plus optional generator diagnostics.

    Inputs intentionally remain structural instead of importing generator
    package types.  Missing optional diagnostic fields default exactly as a
    sparse JavaScript caller would expect, while explicit falsy JSON-LD input
    remains visible to the structural evaluator.
    """
    copy = get_geo_quality_copy(language)
    diagnostics = _mapping(input.get("diagnostics"))
    normalized_product = _mapping(diagnostics.get("normalizedProduct"))
    graph = get_schema_graph(input.get("jsonLd"))
    schema_types: list[str] = []
    for node in graph:
        for type_name in get_schema_node_types(node):
            if type_name not in schema_types:
                schema_types.append(type_name)
    product_node = find_schema_node(graph, "Product")
    web_page_node = find_schema_node(graph, "WebPage")
    faq_node = find_schema_node(graph, "FAQPage")
    how_to_node = find_schema_node(graph, "HowTo")
    breadcrumb_node = find_schema_node(graph, "BreadcrumbList")
    schema_type_list = ", ".join(schema_types) or copy.none
    product_text = "\n".join([
        " ".join(collect_text_values(product_node)) if product_node else "",
        " ".join(collect_text_values(web_page_node)) if web_page_node else "",
    ])
    public_text = "\n".join(text for node in graph for text in collect_text_values(node))
    faq_questions = collect_schema_faq_questions(faq_node)
    schema_faq_count = count_schema_items(faq_node.get("mainEntity") if faq_node else None)
    schema_how_to_count = count_schema_items(how_to_node.get("step") if how_to_node else None)
    faq_structure_valid = faq_node is None or (count_valid_schema_faq_items(faq_node) == schema_faq_count and schema_faq_count > 0)
    how_to_structure_valid = how_to_node is None or (
        bool(get_record_string(how_to_node, "name").strip())
        and count_valid_how_to_steps(how_to_node) == schema_how_to_count
        and schema_how_to_count >= 1
    )
    dangling_local_references = count_dangling_local_schema_references(graph)
    image_count = max(count_schema_items(product_node.get("image") if product_node else None), len(_list(normalized_product.get("images"))))
    offer_count = count_schema_items(product_node.get("offers") if product_node else None)
    breadcrumb_count = max(count_schema_items(breadcrumb_node.get("itemListElement") if breadcrumb_node else None), len(_list(normalized_product.get("breadcrumbs"))))
    additional_property_count = count_schema_items(product_node.get("additionalProperty") if product_node else None)
    scored_validation_repairs = [repair for repair in _mappings(diagnostics.get("validationRepairs")) if not is_disabled_html_content_validation_scope(_string(repair.get("field")))]
    validation_repairs = len(scored_validation_repairs)
    scored_validation_warnings = [warning for warning in _strings(diagnostics.get("validationWarnings")) if not is_disabled_html_content_validation_scope(warning)]
    validation_warnings = len(partition_validation_warnings(scored_validation_warnings, scored_validation_repairs)["unresolvedWarnings"])
    has_clean_validation = validation_warnings == 0 and validation_repairs == 0
    validation_detail_lines = collect_validation_detail_lines(diagnostics, copy)
    validation_improvement_directions = collect_validation_improvement_lines(diagnostics, copy) if validation_warnings > 0 else []
    artifact_hits = collect_public_artifact_hits(public_text, faq_questions, language)
    metric_issues = collect_metric_integrity_issues(public_text, language)
    ingredient_count = len(_list(normalized_product.get("ingredients")))
    benefit_count = len(_list(normalized_product.get("benefits"))) + len(_list(normalized_product.get("effects")))
    ingredient_benefit_bridge = has_ingredient_benefit_choice_bridge(product_text)
    customer_cue = has_customer_choice_cue(product_text)
    selection_cue = has_selection_criteria_cue(product_text)
    rag_usage = _mappings(diagnostics.get("ragUsage"))
    cep_rag_usage = sum(
        1
        for usage in rag_usage
        if usage.get("principle") == "target customer context"
        or any(reference.get("kind") == "cep" for reference in _mappings(usage.get("references")))
    )
    evidence_backed_usage = any(bool(usage.get("enabled")) and usage.get("principle") == "evidence-backed claims" for usage in rag_usage)
    source_evidence = [
        item
        for item in _mappings(diagnostics.get("evidence"))
        if item.get("source") in {"input", "fieldMapping", "rag", "terminology"}
    ]
    source_evidence_types = len({item.get("source") for item in source_evidence})
    evidence_ledger = _mappings(diagnostics.get("evidenceLedger"))
    evidence_ledger_ids = {_string(item.get("id")) for item in evidence_ledger}
    content_plan = _mapping_or_none(diagnostics.get("contentPlan"))
    model_content_plan = content_plan if content_plan and content_plan.get("mode") == "model" else None
    planned_evidence_units = _planned_evidence_units(model_content_plan)
    atomically_covered_plan_units = sum(
        1 for evidence_ids in planned_evidence_units if evidence_ids and all(identifier in evidence_ledger_ids for identifier in evidence_ids)
    )
    invalid_planned_evidence_refs = len({identifier for unit in planned_evidence_units for identifier in unit if identifier not in evidence_ledger_ids})
    has_atomic_evidence_coverage = bool(evidence_ledger) and bool(planned_evidence_units)
    planned_faq_count = (
        sum(1 for item in _mappings(model_content_plan.get("faq")) if bool(item.get("include")))
        if model_content_plan is not None
        else None
    )
    faq_plan_consistent = model_content_plan is None or schema_faq_count == planned_faq_count
    model_how_to = _mapping_or_none(model_content_plan.get("howTo")) if model_content_plan else None
    how_to_plan_consistent = model_content_plan is None or (
        bool(how_to_node) and schema_how_to_count == len(_list(model_how_to.get("steps")))
        if model_how_to and bool(model_how_to.get("eligible"))
        else how_to_node is None
    )
    has_claim_metrics = bool(re.search(r"(?:\+?\d+(?:\.\d+)?\s*[%％])", public_text))
    has_study_sample = bool(
        re.search(r"\b\d{2,4}\s+(?:women|men|participants|subjects|users|respondents|people)\b", public_text, re.I)
        or re.search(r"(?:^|[^\d])\d{2,4}\s*(?:명|인|참여자|대상|사용자|응답자|여성|남성)(?!\d)", public_text)
    )
    has_sample_scope = has_study_sample or has_reported_sample_scope_disclosure(public_text)
    has_time_scope = _has_time_scope(public_text)
    has_reported_details = bool(
        re.search(r"\b(?:reported details|clinical|instrumental|home usage|survey|self-assessment|participants|subjects)\b", public_text, re.I)
        or re.search(r"(?:확인 지표|임상|인체\s*적용|자가\s*평가|테스트|시험|참여자|대상|사용자)", public_text)
    )
    has_product_description = bool(product_node and get_record_string(product_node, "description").strip())
    has_product_identity = bool(product_node and get_record_string(product_node, "@id").strip() and get_record_string(product_node, "name").strip())
    has_web_page_identity = bool(web_page_node and get_record_string(web_page_node, "@id").strip() and get_record_string(web_page_node, "name").strip())
    ingredient_benefit_bridge_applicable = ingredient_count > 0 and benefit_count > 0
    has_offer_price = _has_explicit_offer_price(product_node)
    has_freshness_signal = _has_freshness_timestamp(graph, web_page_node)
    content_plan_cep = _mappings(content_plan.get("cep")) if content_plan else []
    customer_cue_satisfied = customer_cue or len(content_plan_cep) > 0
    selection_cue_satisfied = selection_cue or len(content_plan_cep) > 0
    grounded_cep_plan = bool(content_plan) and bool(content_plan_cep) and all(bool(_list(item.get("evidenceIds"))) for item in content_plan_cep)

    geo_score = clamp_quality_score(
        90
        + (5 if has_offer_price else 0)
        + (5 if has_freshness_signal else 0)
        - (18 if not has_product_identity else 0)
        - (14 if not has_web_page_identity else 0)
        - (10 if not has_product_description else 0)
        - min(16, dangling_local_references * 8)
        - (8 if not faq_structure_valid else 0)
        - (8 if not how_to_structure_valid else 0)
        - (10 if not faq_plan_consistent else 0)
        - (10 if not how_to_plan_consistent else 0)
        - min(16, len(artifact_hits) * 8)
        - min(15, validation_warnings * 3)
        - min(10, validation_repairs * 2)
    )
    ungrounded_cep_plan_count = sum(1 for item in content_plan_cep if not _list(item.get("evidenceIds")))
    cep_score = clamp_quality_score(
        85
        + (8 if ingredient_benefit_bridge_applicable and ingredient_benefit_bridge else 0)
        + (4 if cep_rag_usage > 0 else 0)
        + (3 if grounded_cep_plan else 0)
        - (12 if not customer_cue_satisfied else 0)
        - (10 if not selection_cue_satisfied else 0)
        - (12 if ingredient_benefit_bridge_applicable and not ingredient_benefit_bridge else 0)
        - (12 if ingredient_count == 0 and benefit_count == 0 else 0)
        - min(16, ungrounded_cep_plan_count * 8)
        - min(12, len(artifact_hits) * 6)
    )
    eeat_score = clamp_quality_score(
        90
        + (5 if has_atomic_evidence_coverage and atomically_covered_plan_units == len(planned_evidence_units) else 0)
        + (3 if evidence_backed_usage else 0)
        + (2 if has_claim_metrics and has_reported_details else 0)
        - (30 if not evidence_ledger and not source_evidence else 0)
        - min(24, max(0, len(planned_evidence_units) - atomically_covered_plan_units) * 8)
        - min(20, invalid_planned_evidence_refs * 5)
        - (12 if has_claim_metrics and not has_sample_scope else 0)
        - (10 if has_claim_metrics and not has_time_scope else 0)
        - (8 if has_claim_metrics and not has_reported_details else 0)
        - min(24, len(metric_issues) * 12)
        - min(12, len(artifact_hits) * 4)
    )

    geo_evidence = unique_quality_items([
        copy.geo_schema_evidence(len(graph), schema_type_list),
        copy.gatekeeper_price_evidence if has_offer_price else copy.gatekeeper_price_missing_evidence,
        copy.gatekeeper_freshness_evidence if has_freshness_signal else copy.gatekeeper_freshness_missing_evidence,
        copy.geo_entity_evidence(schema_faq_count, schema_how_to_count, breadcrumb_count),
        copy.geo_commerce_evidence(image_count, offer_count, additional_property_count),
        copy.schema_reference_evidence(dangling_local_references),
        copy.plan_applicability_evidence(faq_plan_consistent, how_to_plan_consistent, bool(model_content_plan)),
        copy.clean_validation_evidence if has_clean_validation else copy.warning_evidence(validation_warnings) if validation_warnings > 0 else None,
        copy.repair_evidence(validation_repairs) if validation_repairs > 0 else None,
    ])
    cep_evidence = unique_quality_items([
        copy.cep_signal_evidence(ingredient_count, benefit_count),
        copy.cep_bridge_evidence if ingredient_benefit_bridge else copy.cep_bridge_missing_evidence,
        copy.cep_choice_evidence if selection_cue_satisfied or customer_cue_satisfied else copy.cep_choice_missing_evidence,
        copy.cep_rag_evidence(cep_rag_usage) if cep_rag_usage > 0 else None,
    ])
    eeat_evidence = unique_quality_items([
        copy.atomic_evidence_count(len(evidence_ledger), len({_string(item.get("role")) for item in evidence_ledger})) if evidence_ledger else copy.eeat_evidence_count(len(source_evidence), source_evidence_types),
        copy.eeat_metric_evidence if has_claim_metrics else copy.eeat_metric_missing_evidence,
        copy.eeat_study_evidence(has_sample_scope, has_time_scope) if has_claim_metrics and (has_sample_scope or has_time_scope) else copy.eeat_study_missing_evidence if has_claim_metrics else None,
        copy.eeat_rag_evidence if evidence_backed_usage else None,
        copy.atomic_evidence_coverage(atomically_covered_plan_units, len(planned_evidence_units), invalid_planned_evidence_refs) if has_atomic_evidence_coverage else copy.atomic_evidence_unavailable,
    ])
    geo_improvements = ensure_quality_items([
        *artifact_hits,
        None if has_freshness_signal else copy.gatekeeper_freshness_improvement,
        None if has_offer_price else copy.gatekeeper_price_improvement,
        None if product_node else copy.missing_product_schema,
        None if web_page_node else copy.missing_web_page_schema,
        None if faq_structure_valid else copy.faq_applicability_improvement,
        None if how_to_structure_valid else copy.how_to_applicability_improvement,
        None if faq_plan_consistent else copy.faq_plan_improvement,
        None if how_to_plan_consistent else copy.how_to_plan_improvement,
        copy.schema_reference_improvement(dangling_local_references) if dangling_local_references > 0 else None,
        copy.repair_stability_improvement(validation_repairs) if validation_repairs > 0 else None,
        copy.validation_improvement(validation_warnings) if validation_warnings > 0 else None,
        *validation_improvement_directions,
    ], copy.geo_fallback_improvement)
    cep_improvements = ensure_quality_items([
        copy.cep_bridge_improvement if ingredient_benefit_bridge_applicable and not ingredient_benefit_bridge else None,
        copy.cep_choice_improvement if not selection_cue_satisfied else None,
        copy.cep_ingredient_improvement if ingredient_count == 0 else None,
        copy.cep_benefit_improvement if benefit_count == 0 else None,
        *artifact_hits,
    ], copy.cep_fallback_improvement)
    eeat_improvements = ensure_quality_items([
        *metric_issues,
        copy.eeat_sample_improvement if has_claim_metrics and not has_sample_scope else None,
        copy.eeat_time_improvement if has_claim_metrics and not has_time_scope else None,
        copy.eeat_rag_improvement if not evidence_backed_usage else None,
        copy.atomic_evidence_improvement(len(planned_evidence_units) - atomically_covered_plan_units) if has_atomic_evidence_coverage and atomically_covered_plan_units < len(planned_evidence_units) else None,
        copy.repair_stability_improvement(validation_repairs) if validation_repairs > 0 else None,
        copy.validation_improvement(validation_warnings) if validation_warnings > 0 else None,
        *validation_improvement_directions,
    ], copy.eeat_fallback_improvement)
    geo_issue_count = (
        len(artifact_hits) + validation_warnings + validation_repairs + dangling_local_references
        + int(not has_product_identity) + int(not has_web_page_identity) + int(not has_product_description)
        + int(not faq_structure_valid) + int(not how_to_structure_valid) + int(not faq_plan_consistent)
        + int(not how_to_plan_consistent) + int(not has_offer_price) + int(not has_freshness_signal)
    )
    cep_issue_count = (
        len(artifact_hits) + int(not customer_cue_satisfied) + int(not selection_cue_satisfied)
        + int(ingredient_benefit_bridge_applicable and not ingredient_benefit_bridge)
        + int(ingredient_count == 0 and benefit_count == 0) + ungrounded_cep_plan_count
    )
    eeat_issue_count = (
        len(metric_issues) + int(not evidence_ledger and not source_evidence)
        + int(has_claim_metrics and not has_sample_scope) + int(has_claim_metrics and not has_time_scope)
        + int(has_claim_metrics and not has_reported_details)
        + max(0, len(planned_evidence_units) - atomically_covered_plan_units) + invalid_planned_evidence_refs
    )
    dimensions = [
        GeoQualityDimension("geo", "GEO", geo_score, copy.geo_criteria, copy.score_summary(geo_score, geo_issue_count), geo_evidence, geo_improvements),
        GeoQualityDimension("cep", "CEP", cep_score, copy.cep_criteria, copy.score_summary(cep_score, cep_issue_count), cep_evidence, cep_improvements),
        GeoQualityDimension("eeat", "E-E-A-T", eeat_score, copy.eeat_criteria, copy.score_summary(eeat_score, eeat_issue_count), eeat_evidence, eeat_improvements),
    ]
    return GeoQualityEvaluation(
        overall_score=int(js_round(sum(dimension.score for dimension in dimensions) / len(dimensions))),
        dimensions=dimensions,
        validation_details=validation_detail_lines,
        validation_improvements=validation_improvement_directions,
    )


def format_geo_quality_evaluation_text(product_name: str, evaluation: GeoQualityEvaluation, language: str) -> str:
    """Render the exact human-readable deterministic rubric report."""
    copy = get_geo_quality_copy(language)
    lines = [copy.title, f"{copy.product_label}: {product_name}", f"{copy.overall_score_label}: {evaluation.overall_score}/100", ""]
    for dimension in evaluation.dimensions:
        lines.extend([
            f"{dimension.label}: {dimension.score}/100",
            f"{copy.criteria_label}: {dimension.criteria}",
            f"{copy.summary_label}: {dimension.summary}",
            f"{copy.evidence_label}:",
            *(f"- {item}" for item in dimension.evidence),
            f"{copy.improvement_label}:",
            *(f"- {item}" for item in dimension.improvements),
            "",
        ])
    if evaluation.validation_details or evaluation.validation_improvements:
        lines.append(copy.validation_detail_label)
        if evaluation.validation_details:
            lines.extend([f"{copy.validation_issue_label}:", *(f"- {item}" for item in evaluation.validation_details)])
        if evaluation.validation_improvements:
            lines.extend([f"{copy.validation_direction_label}:", *(f"- {item}" for item in evaluation.validation_improvements)])
    return "\n".join(lines).strip()


def _planned_evidence_units(model_content_plan: Mapping[str, object] | None) -> list[list[str]]:
    if not model_content_plan:
        return []
    units: list[list[str]] = []
    product_description = _mapping_or_none(model_content_plan.get("productDescription"))
    if product_description and bool(product_description.get("include")):
        units.append(_strings(product_description.get("evidenceIds")))
    web_page_description = _mapping_or_none(model_content_plan.get("webPageDescription"))
    if web_page_description and bool(web_page_description.get("include")):
        units.append(_strings(web_page_description.get("evidenceIds")))
    units.extend(_strings(item.get("evidenceIds")) for item in _mappings(model_content_plan.get("faq")) if bool(item.get("include")))
    how_to = _mapping_or_none(model_content_plan.get("howTo"))
    if how_to and bool(how_to.get("eligible")):
        units.extend(_strings(step.get("evidenceIds")) for step in _mappings(how_to.get("steps")))
    units.extend(_strings(item.get("evidenceIds")) for item in _mappings(model_content_plan.get("cep")))
    return units


def _has_time_scope(public_text: str) -> bool:
    return bool(
        re.search(r"\b(?:after\s+)?\d+\s*(?:day|days|week|weeks|hour|hours)\b", public_text, re.I)
        or re.search(r"\d+(?:\.\d+)?\s*(?:시간|일|주)\s*(?:후|동안|뒤)", public_text)
        or re.search(r"\d+(?:\.\d+)?\s*시간\s*(?:패치|첩포)", public_text)
        or re.search(r"\d+(?:\.\d+)?\s*(?:일|주|개월)\s*(?:간|동안)", public_text)
        or re.search(r"(?:사용|도포|세정)\s*(?:직후|전|\d+(?:\.\d+)?\s*(?:시간|일|주)\s*후)", public_text)
        or re.search(r"(?:시험|측정|조사|평가)?\s*기간(?:은|:)?\s*20\d{2}[./-]\d{1,2}[./-]\d{1,2}\s*(?:~|-|–|—|부터|에서)\s*20\d{2}[./-]\d{1,2}[./-]\d{1,2}", public_text)
        or re.search(r"20\d{2}년\s*\d{1,2}월\s*\d{1,2}일\s*(?:부터|~|-|–|—)\s*(?:\d{1,2}월\s*)?\d{1,2}일\s*(?:까지)?", public_text)
        or re.search(r"\d{2}[./-]\d{1,2}[./-]\d{1,2}\s*(?:~|-|–|—)\s*\d{2}[./-]\d{1,2}[./-]\d{1,2}", public_text)
    )


def _has_explicit_offer_price(product_node: Mapping[str, object] | None) -> bool:
    if not product_node:
        return False
    offers = product_node.get("offers")
    candidates: list[object] = list(cast(list[object], offers)) if isinstance(offers, list) else [offers] if _js_truthy(offers) else []
    for offer in candidates:
        if not isinstance(offer, Mapping):
            continue
        price = _mapping(cast(object, offer)).get("price")
        if (isinstance(price, (int, float)) and not isinstance(price, bool)) or (isinstance(price, str) and bool(price.strip())):
            return True
    return False


def _has_freshness_timestamp(graph: list[object], web_page_node: Mapping[str, object] | None) -> bool:
    nodes = [web_page_node, *graph] if web_page_node else graph
    return any(
        isinstance(_mapping(node).get(key), str)
        and bool(cast(str, _mapping(node).get(key)).strip())
        for node in nodes
        for key in ("dateModified", "datePublished", "dateCreated")
    )


def _mapping(value: object) -> dict[str, object]:
    return dict(cast(Mapping[str, object], value)) if isinstance(value, Mapping) else {}


def _mapping_or_none(value: object) -> dict[str, object] | None:
    return dict(cast(Mapping[str, object], value)) if isinstance(value, Mapping) else None


def _mappings(value: object) -> list[Mapping[str, object]]:
    return [cast(Mapping[str, object], item) for item in cast(list[object], value) if isinstance(item, Mapping)] if isinstance(value, list) else []


def _list(value: object) -> list[object]:
    return cast(list[object], value) if isinstance(value, list) else []


def _strings(value: object) -> list[str]:
    return [item for item in cast(list[object], value) if isinstance(item, str)] if isinstance(value, list) else []


def _string(value: object) -> str:
    return value if isinstance(value, str) else ""


def _js_truthy(value: object) -> bool:
    if value is None or value is False:
        return False
    if isinstance(value, (int, float)) and not isinstance(value, bool) and value == 0:
        return False
    if isinstance(value, str):
        return bool(value)
    return True
