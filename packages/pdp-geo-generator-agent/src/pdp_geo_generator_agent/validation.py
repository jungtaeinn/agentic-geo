"""Read-only validation and narrowly safe public-copy repairs."""

from __future__ import annotations

import copy
import json
import re
from collections.abc import Mapping, Sequence
from typing import Any, cast

from neo_js_compat import js_code_unit_length, js_json_pretty_dumps

from ._json import as_dict, as_list, as_mapping, clean_text
from .contracts.image_source import is_publishable_image_url
from .contracts.usage import (
    extract_explicit_numbered_usage_steps,
    has_actionable_application_verb,
    has_actionable_application_verb_without_generic_apply,
    has_korean_instruction_verb,
    has_procedure_action_cue,
    has_routine_placement_cue,
    is_procedural_usage_instruction,
    is_safety_or_test_claim_usage,
    usage_description_signal_score,
    usage_text_without_step_marker,
)
from .graph_integrity import (
    capture_structured_content_snapshot,
    repair_pdp_schema_graph_integrity,
    synchronize_structured_content_with_graph,
)

_ALLOWED_GRAPH_TYPES = {
    "WebPage",
    "ItemPage",
    "CollectionPage",
    "AboutPage",
    "Product",
    "FAQPage",
    "HowTo",
    "BreadcrumbList",
    "Question",
    "Answer",
    "HowToStep",
    "Offer",
    "AggregateRating",
    "Review",
    "Rating",
    "PropertyValue",
    "ItemList",
    "ListItem",
    "Brand",
    "Person",
}


def escape_script_json(value: str) -> str:
    return value.replace("<", "\\u003c")


def serialize_schema_markup(graph_or_jsonld: Mapping[str, Any] | Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    if isinstance(graph_or_jsonld, Mapping) and "@graph" in graph_or_jsonld:
        json_ld = dict(graph_or_jsonld)
    elif isinstance(graph_or_jsonld, Mapping) and "graph" in graph_or_jsonld:
        json_ld = dict(
            as_dict(graph_or_jsonld.get("jsonLd"))
            or {"@context": "https://schema.org", "@graph": as_list(graph_or_jsonld.get("graph"))}
        )
    else:
        json_ld = {"@context": "https://schema.org", "@graph": list(graph_or_jsonld)}
    json_ld.setdefault("@context", "https://schema.org")
    json_ld.setdefault("@graph", [])
    script = f'<script type="application/ld+json">{escape_script_json(js_json_pretty_dumps(json_ld))}</script>'
    # Keep the public schema-markup contract aligned with the retained
    # JavaScript result. Internal graph/script conveniences belong to
    # schema_graph.create_schema_markup, not to the API envelope.
    return {"jsonLd": json_ld, "scriptTag": script}


def validate_pdp_geo_artifacts(input_: Mapping[str, Any]) -> dict[str, Any]:
    """Report a complete repair candidate without mutating public artifacts."""
    markup = as_dict(input_.get("schemaMarkup"))
    json_ld = as_dict(markup.get("jsonLd")) or as_dict(input_.get("jsonLd"))
    isolated = copy.deepcopy(dict(input_))
    dry_run = validate_and_repair_pdp_geo_artifacts(isolated)
    findings = [
        {
            "field": repair["field"],
            "source": repair["source"],
            "issue": repair["issue"],
            "suggestedAction": f"Not applied; suggested only: {repair['action']}",
            **({"before": copy.deepcopy(repair["before"])} if "before" in repair else {}),
            **({"suggestedAfter": copy.deepcopy(repair["after"])} if "after" in repair else {}),
            "evidence": copy.deepcopy(repair.get("evidence", [])),
        }
        for repair in dry_run["validationRepairs"]
        if not str(repair["field"]).startswith("content")
    ]
    actual = clean_text(markup.get("scriptTag") if "scriptTag" in markup else markup.get("script"))
    if not _script_tag_matches_json_ld(actual, json_ld):
        findings.append(
            {
                "field": "schemaMarkup.scriptTag",
                "source": "schema-validator",
                "issue": "schemaMarkup.scriptTag does not serialize the same JSON-LD object as schemaMarkup.jsonLd.",
                "suggestedAction": "Re-serialize scriptTag deterministically from schemaMarkup.jsonLd before publishing.",
                "before": actual,
                "evidence": ["schemaMarkup.jsonLd", "schemaMarkup.scriptTag"],
            }
        )
    findings.extend(_collect_public_wording_findings(json_ld, input_.get("sourceProduct")))
    findings.extend(_collect_public_copy_provenance_findings(json_ld, input_))
    warnings = _unique(
        [f"{item['field']}: {item['issue']}" for item in findings if item["field"] != "schemaMarkup.scriptTag"]
        + [item["issue"] for item in findings if item["field"] == "schemaMarkup.scriptTag"]
    )
    return {"validationWarnings": warnings, "validationFindings": findings}


def _collect_public_copy_provenance_findings(
    json_ld: Mapping[str, Any], input_: Mapping[str, Any]
) -> list[dict[str, Any]]:
    """Report missing or stale provenance only when this final-stage contract is supplied.

    Legacy callers may validate an isolated JSON-LD document without a ledger.
    The orchestration path always supplies this contract after the last mutating
    stage, where every non-empty public field needs its current text/hash and
    evidence binding checked together.
    """

    if "publicCopyProvenance" not in input_:
        return []
    # Imported lazily because final_proofreader imports this module's public
    # validation helpers.  At validation time both modules are fully loaded.
    from .final_proofreader import (
        _valid_current_provenance,
        clean_proposed_text,
        sentence_provenance_has_direct_claim_support,
        sentence_provenance_has_verbatim_source_support,
        stable_text_hash,
    )

    evidence_by_id = {
        clean_text(as_dict(raw).get("id")): as_dict(raw)
        for raw in as_list(input_.get("evidenceLedger"))
        if clean_text(as_dict(raw).get("id"))
    }
    ledger_ids = set(evidence_by_id)
    supplied: dict[str, list[dict[str, Any]]] = {}
    for raw in as_list(input_.get("publicCopyProvenance")):
        entry = as_dict(raw)
        path = clean_text(entry.get("fieldPath"))
        if path:
            supplied.setdefault(path, []).append(entry)

    # The final proofreader is the sole owner of relationship-card semantics.
    # Its validated view resolves a FAQ row ID through the immutable service
    # plan and membership sidecar; it never trusts public FAQ prose or embeds
    # cards in public provenance.  Reuse that view only as a narrow fallback
    # for an otherwise-valid FAQ entry, so this read-only validator does not
    # erase a natural, card-backed relation that the final proofreader already
    # proved sentence-by-sentence.
    validated_card_scoped_faq_paths = {
        clean_text(entry.get("fieldPath"))
        for entry in _valid_current_provenance(input_)
        if clean_text(entry.get("fieldPath")).startswith("FAQPage.mainEntity")
    }

    findings: list[dict[str, Any]] = []
    current = _public_copy_field_values(json_ld)
    current_paths = {path for path, _ in current}
    for path, text in current:
        entries = supplied.get(path, [])
        if len(entries) != 1:
            findings.append(
                _public_copy_provenance_finding(
                    path,
                    "is missing" if not entries else "is ambiguous because multiple bindings were supplied",
                    [path, "finalPublicCopyProvenance", "evidenceLedger"],
                )
            )
            continue
        entry = entries[0]
        card_scoped_entry_is_valid = path in validated_card_scoped_faq_paths
        normalized = clean_proposed_text(text)
        issues: list[str] = []
        if clean_proposed_text(clean_text(entry.get("text"))) != normalized:
            issues.append("text does not match the finalized field")
        if entry.get("sourceHash") != stable_text_hash(f"{path}\n{normalized}"):
            issues.append("sourceHash does not match the finalized field")
        evidence_ids = [clean_text(identifier) for identifier in as_list(entry.get("evidenceIds")) if clean_text(identifier)]
        if not evidence_ids or any(identifier not in ledger_ids for identifier in evidence_ids):
            issues.append("evidenceIds are missing or do not resolve in the evidence ledger")
        sentence_rows = [as_dict(raw) for raw in as_list(entry.get("sentences")) if as_dict(raw)]
        expected_sentences = _public_copy_provenance_sentences(normalized)
        if len(sentence_rows) != len(expected_sentences):
            issues.append("sentence bindings do not cover the finalized field")
        else:
            sentence_union: list[str] = []
            for index, sentence in enumerate(expected_sentences):
                row = sentence_rows[index]
                raw_sentence_ids = as_list(row.get("evidenceIds"))
                sentence_ids = [clean_text(identifier) for identifier in raw_sentence_ids if clean_text(identifier)]
                sentence_is_invalid = (
                    clean_proposed_text(clean_text(row.get("text"))) != sentence
                    or row.get("sourceHash") != stable_text_hash(f"{path}#sentence[{index}]\n{sentence}")
                )
                if row.get("protected") is True:
                    sentence_is_invalid = sentence_is_invalid or bool(raw_sentence_ids) or not sentence_provenance_has_verbatim_source_support(
                        sentence, list(evidence_by_id.values())
                    )
                else:
                    sentence_is_invalid = sentence_is_invalid or (
                        not sentence_ids
                        or any(identifier not in ledger_ids for identifier in sentence_ids)
                        or len(sentence_ids) != len(raw_sentence_ids)
                        or not sentence_provenance_has_direct_claim_support(
                            sentence,
                            [evidence_by_id[identifier] for identifier in sentence_ids if identifier in evidence_by_id],
                            list(evidence_by_id.values()),
                            entry.get("origin"),
                        )
                        and not card_scoped_entry_is_valid
                    )
                if sentence_is_invalid:
                    issues.append("sentence bindings do not match the finalized text/hash/evidence IDs")
                    break
                for identifier in sentence_ids:
                    if identifier not in sentence_union:
                        sentence_union.append(identifier)
            if not issues and evidence_ids != sentence_union:
                issues.append("evidenceIds are not the exact union of the valid sentence evidence IDs")
        if issues:
            findings.append(
                _public_copy_provenance_finding(
                    path,
                    "; ".join(issues),
                    [path, "finalPublicCopyProvenance", "evidenceLedger", *evidence_ids],
                )
            )

    for path in supplied:
        if path not in current_paths:
            findings.append(
                _public_copy_provenance_finding(
                    path,
                    "does not correspond to a currently published public-copy field",
                    [path, "finalPublicCopyProvenance"],
                )
            )
    return findings


def _public_copy_provenance_finding(path: str, issue: str, evidence: Sequence[str]) -> dict[str, Any]:
    return {
        "field": path,
        "source": "public-copy-provenance",
        "issue": f"Final public-copy provenance {issue}.",
        "suggestedAction": "Regenerate finalPublicCopyProvenance from finalized schema fields and the evidence ledger before publishing.",
        "evidence": list(dict.fromkeys(evidence)),
    }


def _public_copy_field_values(json_ld: Mapping[str, Any]) -> list[tuple[str, str]]:
    graph = as_list(json_ld.get("@graph"))
    values: list[tuple[str, str]] = []
    for kind, path in (("Product", "Product.description"), ("WebPage", "WebPage.description")):
        node = next((as_dict(raw) for raw in graph if _has_type(as_dict(raw), kind)), None)
        text = clean_text(node.get("description")) if node is not None else ""
        if text:
            values.append((path, text))
    faq = next((as_dict(raw) for raw in graph if _has_type(as_dict(raw), "FAQPage")), None)
    for index, raw in enumerate(as_list(faq.get("mainEntity") if faq is not None else None)):
        item, answer = as_dict(raw), as_dict(as_dict(raw).get("acceptedAnswer"))
        question, text = clean_text(item.get("name")), clean_text(answer.get("text"))
        if question:
            values.append((f"FAQPage.mainEntity[{index}].name", question))
        if text:
            values.append((f"FAQPage.mainEntity[{index}].acceptedAnswer.text", text))
    how_to = next((as_dict(raw) for raw in graph if _has_type(as_dict(raw), "HowTo")), None)
    for index, raw in enumerate(as_list(how_to.get("step") if how_to is not None else None)):
        text = clean_text(as_dict(raw).get("text"))
        if text:
            values.append((f"HowTo.step[{index}].text", text))
    return values


def _public_copy_provenance_sentences(value: str) -> list[str]:
    return [part for part in re.split(r"(?<=[.!?。！？])\s+|\n+", value) if part]


def apply_safe_public_copy_repairs(input_: Mapping[str, Any]) -> dict[str, Any]:
    """Apply only deterministic text repair; preserve caller-rendered HTML."""
    markup = copy.deepcopy(as_dict(input_.get("schemaMarkup")))
    content = copy.deepcopy(as_dict(input_.get("content")))
    repairs: list[dict[str, Any]] = []
    json_ld = as_dict(markup.get("jsonLd"))
    if not json_ld:
        json_ld = {"@context": "https://schema.org", "@graph": as_list(markup.get("graph"))}
    graph = as_list(json_ld.get("@graph"))
    for index, raw in enumerate(graph):
        record = as_mapping(raw)
        if record is None:
            continue
        # A safe repair may update a schema record, but must retain every
        # scalar or empty object carried in the caller's JSON-LD array.
        node = copy.deepcopy(dict(record))
        graph[index] = node
        is_product = _has_type(node, "Product")
        if isinstance(node.get("description"), str) and (is_product or _has_type(node, "WebPage")):
            field = "Product.description" if is_product else "WebPage.description"
            node["description"] = _repair_generated_text(str(node["description"]), field, repairs)
        if is_product and isinstance(node.get("additionalProperty"), list):
            node["additionalProperty"] = _repair_safe_properties(
                cast(list[object], node["additionalProperty"]), repairs
            )
        if _has_type(node, "FAQPage") and isinstance(node.get("mainEntity"), list):
            node["mainEntity"] = _repair_safe_faq_items(cast(list[object], node["mainEntity"]), repairs)
        if _has_type(node, "HowTo") and isinstance(node.get("step"), list):
            node["step"] = _repair_safe_howto_steps(cast(list[object], node["step"]), repairs)
    json_ld["@graph"] = graph
    sections = as_dict(content.get("sections"))
    for key, value in list(sections.items()):
        if isinstance(value, str):
            sections[key] = _repair_multiline_generated_text(value, f"content.sections.{key}", repairs)
    content["sections"] = sections
    schema = serialize_schema_markup(json_ld)
    return {"schemaMarkup": schema, "content": content, "appliedRepairs": repairs}


def validate_and_repair_pdp_geo_artifacts(input_: Mapping[str, Any]) -> dict[str, Any]:
    """Run the legacy full mutator, including graph/trust repair and HTML clear."""
    markup = copy.deepcopy(as_dict(input_.get("schemaMarkup")))
    root = copy.deepcopy(as_dict(markup.get("jsonLd")) or as_dict(input_.get("jsonLd")))
    repairs: list[dict[str, Any]] = []
    if root.get("@context") != "https://schema.org":
        _add_repair(
            repairs,
            "@context",
            "schema-validator",
            "JSON-LD context was missing or not schema.org.",
            "Set @context to https://schema.org.",
            root.get("@context"),
            "https://schema.org",
            ["schema.org JSON-LD requirement"],
        )
        root["@context"] = "https://schema.org"
    locale = clean_text(input_.get("locale")) or "en-US"
    fallback_name = clean_text(input_.get("fallbackProductName")) or "Product"
    fallback_description = clean_text(input_.get("fallbackDescription"))
    canonical_source_procedure_keys = _explicit_source_procedure_keys(input_.get("sourceProduct"), locale)
    graph = [copy.deepcopy(as_dict(raw)) for raw in as_list(root.get("@graph")) if as_dict(raw)]
    snapshot = capture_structured_content_snapshot(cast(list[Mapping[str, object]], graph))
    graph = [
        _repair_full_graph_node(node, locale, repairs, canonical_source_procedure_keys)
        for node in graph
    ]
    product = next((node for node in graph if _has_type(node, "Product")), None)
    if product is None:
        product = {
            "@type": "Product",
            "@id": f"urn:agentic-geo:pdp:{_slug(fallback_name)}#product",
            "name": fallback_name,
            "description": fallback_description,
        }
        graph.append(product)
        _add_repair(
            repairs,
            "@graph.Product",
            "schema-validator",
            "Product node was missing from JSON-LD graph.",
            "Added a Product node from fallback product name and description.",
            None,
            product,
            ["fallbackProductName", "fallbackDescription"],
        )
    else:
        if not clean_text(product.get("name")):
            _add_repair(
                repairs,
                "Product.name",
                "schema-validator",
                "Product.name was missing or blank.",
                "Filled Product.name with fallback product name.",
                product.get("name"),
                fallback_name,
                ["fallbackProductName"],
            )
            product["name"] = fallback_name
        if not clean_text(product.get("description")):
            _add_repair(
                repairs,
                "Product.description",
                "schema-validator",
                "Product.description was missing or blank.",
                "Filled Product.description with fallback description.",
                product.get("description"),
                fallback_description,
                ["fallbackDescription"],
            )
            product["description"] = fallback_description
    integrity = repair_pdp_schema_graph_integrity(cast(list[Mapping[str, object]], graph), locale)
    graph = [copy.deepcopy(as_dict(node)) for node in cast(list[object], integrity["graph"])]
    repairs.extend(copy.deepcopy(cast(list[dict[str, Any]], integrity["repairs"])))
    root["@graph"] = _clean_json(graph)
    cleaned_root: dict[str, Any] = {}
    for key, value in root.items():
        cleaned_value = _clean_json(value)
        if cleaned_value not in (None, "", []):
            cleaned_root[key] = cleaned_value
    schema = serialize_schema_markup(cleaned_root)
    content = copy.deepcopy(as_dict(input_.get("content")))
    sections = _repair_full_content_sections(as_dict(content.get("sections")), repairs)
    parity = synchronize_structured_content_with_graph(
        {"sections": sections, "graph": cast(list[Mapping[str, object]], graph), "snapshot": snapshot}
    )
    repairs.extend(copy.deepcopy(cast(list[dict[str, Any]], parity["repairs"])))
    content["sections"] = copy.deepcopy(cast(dict[str, Any], parity["sections"]))
    content["html"] = ""
    warnings = _unique([_repair_warning(repair) for repair in repairs])
    return {"schemaMarkup": schema, "content": content, "validationWarnings": warnings, "validationRepairs": repairs}


_MISSING = object()


def _has_type(node: Mapping[str, object], type_: str) -> bool:
    return type_ in _node_types(cast(Mapping[str, Any], node))


def _add_repair(
    repairs: list[dict[str, Any]],
    field: str,
    source: str,
    issue: str,
    action: str,
    before: object = _MISSING,
    after: object = _MISSING,
    evidence: Sequence[str] = (),
) -> None:
    repair: dict[str, Any] = {"field": field, "source": source, "issue": issue, "action": action}
    if before is not _MISSING:
        repair["before"] = copy.deepcopy(before)
    if after is not _MISSING:
        repair["after"] = copy.deepcopy(after)
    repair["evidence"] = list(evidence)
    repairs.append(repair)


def _repair_warning(repair: Mapping[str, object]) -> str:
    issue = clean_text(repair.get("issue"))
    source_warnings = {
        "Product.image contained malformed or truncated image URLs.": "Malformed Product.image URL was removed during schema validation.",
        "FAQ answer opened with a non-answer (cannot-confirm) sentence instead of a supported product fact.": "Non-answer FAQ lead sentence was removed during final sentence QA.",
        "FAQ answer was only a non-answer (cannot-confirm) statement with no supported product fact.": "Non-answer FAQ item was removed during final sentence QA.",
        "HowTo.step text did not satisfy the RAG field evidence contract for actionable usage directions.": "HowTo step was removed because it was not actionable usage content.",
    }
    if issue in source_warnings:
        return source_warnings[issue]
    field = clean_text(repair.get("field"))
    if issue == "Public content section contained lines that did not match the RAG field evidence contract.":
        return f"Content section {field} was repaired by field evidence contract validation."
    action = clean_text(repair.get("action"))
    return action or clean_text(repair.get("issue"))


def _record_sentence_repair(repairs: list[dict[str, Any]], field: str, before: str, after: str) -> None:
    if before == after:
        return
    issue = "URL/image artifact leaked into public copy" if "http" in before and "http" not in after else "escaping or spacing artifact was present"
    _add_repair(
        repairs,
        field,
        "sentence-qa",
        issue,
        "Normalized public copy by removing artifacts, fixing particles/spacing, dropping truncated fragments, and rewriting internal generation phrasing.",
        before.strip(),
        after,
        ["generated schema/content text", "locale sentence QA"],
    )


def _repair_generated_text(value: str, field: str, repairs: list[dict[str, Any]]) -> str:
    next_value = value
    next_value = re.sub(r"^(?:(?:-{1,2}|=)>|→|⇒|➜|➔)\s*", "", next_value)
    next_value = next_value.replace(r'\"', '"').replace(r"\n", " ").replace(r"\r", " ").replace("\u00a0", " ")
    next_value = re.sub(r"https?://[^\s<>'\"]+", "", next_value, flags=re.IGNORECASE)
    next_value = re.sub(r"([?!])\s*\.(?=\s|$)", r"\1", next_value)
    next_value = re.sub(r",\s*\.\s*$", ".", next_value)
    next_value = re.sub(r",\s*\.\s*", ", ", next_value)
    next_value = re.sub(r"\bKEY INGREDIENTS\s*:\s*", "", next_value, flags=re.IGNORECASE)
    next_value = re.sub(r"([+\-−]?\d+)\.\s+(\d+%)", r"\1.\2", next_value)
    next_value = re.sub(r"\s+([,.!?。！？])", r"\1", next_value)
    next_value = re.sub(r"([.。！？?])(?!\d)(?=\S)", r"\1 ", next_value)
    next_value = re.sub(r"\s+", " ", next_value).strip()
    next_value = re.sub(r"([.!?。！？])(?:\s*\1)+", r"\1", next_value).strip()
    _record_sentence_repair(repairs, field, value, next_value)
    return next_value


def _repair_multiline_generated_text(value: str, field: str, repairs: list[dict[str, Any]]) -> str:
    if "\n" not in value:
        return _repair_generated_text(value, field, repairs)
    lines: list[str] = []
    for line in value.split("\n"):
        if not line.strip():
            lines.append("")
            continue
        match = re.match(r"^(\s*(?:[-*]|\d+[.)]|[QA][.:])\s+)(.+)$", line, re.IGNORECASE | re.DOTALL)
        if match is None:
            lines.append(_repair_generated_text(line, field, repairs))
        else:
            lines.append(f"{match.group(1)}{_repair_generated_text(match.group(2), field, repairs)}")
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def _usage_step_key(value: str) -> str:
    return re.sub(
        r"\b(?:the|a|an|your|this|it|of|serum|cream|toner|product)\b",
        " ",
        re.sub(r"[^\w]+", " ", value.casefold()),
    ).strip()


def _explicit_source_procedure_keys(value: object, locale: str) -> tuple[str, ...]:
    """Return the exact source-owned procedure shape available to legacy validation.

    The full validator is also used in read-only diagnostics.  A complete
    numbered source routine may include an unfamiliar but valid application
    verb, so it must not be rejected only because the validator's older
    per-sentence vocabulary is narrower.  We accept that exception solely
    when the whole rendered HowTo still matches the complete, source-gated
    sequence in both count and order.
    """

    product = as_dict(value)
    semantic = as_dict(product.get("semanticFacts"))
    candidates = [
        *[clean_text(item) for item in as_list(product.get("usage")) if clean_text(item)],
        *[clean_text(item) for item in as_list(semantic.get("usageSteps")) if clean_text(item)],
    ]
    return tuple(
        _semantic_how_to_key(usage_text_without_step_marker(step), locale)
        for step in extract_explicit_numbered_usage_steps(candidates)
    )


def _how_to_matches_source_procedure(
    items: Sequence[object], locale: str, canonical_source_procedure_keys: Sequence[str]
) -> bool:
    if not canonical_source_procedure_keys:
        return False
    rendered_keys: list[str] = []
    for raw in items:
        text = clean_text(as_dict(raw).get("text"))
        if not text:
            return False
        rendered_keys.append(_semantic_how_to_key(_normalize_how_to_step(usage_text_without_step_marker(text), locale), locale))
    return tuple(rendered_keys) == tuple(canonical_source_procedure_keys)


def _repair_usage_property(value: str) -> str:
    steps: list[str] = []
    seen: list[str] = []
    for raw in re.split(r"\s*;\s*|\n+", value):
        step = _repair_generated_text(raw, "Product.additionalProperty.Usage", [])
        step = usage_text_without_step_marker(step).rstrip(".。 ").strip()
        key = _usage_step_key(step)
        if len(step) < 8 or not key or any(key in previous or previous in key for previous in seen):
            continue
        seen.append(key)
        steps.append(step)
    if not steps:
        return ""
    if len(steps) == 1:
        return steps[0]
    # ``Usage`` is compact metadata, not a second HowTo representation.  Keep
    # its source order in one line without inventing English step labels.
    return "; ".join(steps)


def _repair_safe_properties(properties: list[object], repairs: list[dict[str, Any]]) -> list[object]:
    repaired: list[object] = []
    for index, raw in enumerate(properties):
        record = as_mapping(raw)
        if record is None:
            repaired.append(copy.deepcopy(raw))
            continue
        property_ = copy.deepcopy(dict(record))
        name = property_.get("name")
        value = property_.get("value")
        if not isinstance(name, str) or not isinstance(value, str):
            repaired.append(property_)
            continue
        field = f"Product.additionalProperty[{index}].value"
        next_value = _repair_generated_text(value, field, repairs)
        if name == "Usage":
            deduped = _repair_usage_property(next_value)
            if deduped != next_value:
                _add_repair(
                    repairs,
                    "Product.additionalProperty.Usage",
                    "sentence-qa",
                    "Usage PropertyValue contained duplicated step text or leading OCR step markers.",
                    "Deduplicated usage directions and removed leading step-number artifacts.",
                    next_value,
                    deduped,
                    ["Product.additionalProperty.Usage", "actionable usage contract", "en-US"],
                )
                next_value = deduped
        if not next_value:
            _add_repair(
                repairs,
                f"Product.additionalProperty.{name}",
                "sentence-qa",
                "PropertyValue text was empty after artifact-only content was removed.",
                "Removed the additionalProperty entry instead of publishing an empty value.",
                value,
                None,
                [f"Product.additionalProperty.{name}", "PropertyValue content contract", "en-US"],
            )
            continue
        property_["value"] = next_value
        repaired.append(property_)
    return repaired


def _repair_safe_faq_items(items: list[object], repairs: list[dict[str, Any]]) -> list[object]:
    repaired: list[object] = []
    for raw in items:
        record = as_mapping(raw)
        if record is None:
            repaired.append(copy.deepcopy(raw))
            continue
        item = copy.deepcopy(dict(record))
        if isinstance(item.get("name"), str):
            item["name"] = _repair_generated_text(str(item["name"]), "FAQPage.mainEntity.name", repairs)
        answer = copy.deepcopy(as_dict(item.get("acceptedAnswer")))
        if answer and isinstance(answer.get("text"), str):
            answer["text"] = _repair_generated_text(
                str(answer["text"]), "FAQPage.mainEntity.acceptedAnswer.text", repairs
            )
            item["acceptedAnswer"] = answer
        repaired.append(item)
    return repaired


def _repair_safe_howto_steps(items: list[object], repairs: list[dict[str, Any]]) -> list[object]:
    repaired: list[object] = []
    for raw in items:
        record = as_mapping(raw)
        if record is None:
            repaired.append(copy.deepcopy(raw))
            continue
        item = copy.deepcopy(dict(record))
        if isinstance(item.get("text"), str):
            item["text"] = usage_text_without_step_marker(
                _repair_generated_text(str(item["text"]), "HowTo.step.text", repairs)
            )
        repaired.append(item)
    return repaired


def _repair_full_graph_node(
    node: dict[str, Any],
    locale: str,
    repairs: list[dict[str, Any]],
    canonical_source_procedure_keys: Sequence[str] = (),
) -> dict[str, Any]:
    next_node = copy.deepcopy(node)
    for unsupported in (type_ for type_ in _node_types(next_node) if type_ not in _ALLOWED_GRAPH_TYPES):
        _add_repair(
            repairs,
            f"{unsupported}.@type",
            "schema-validator",
            f'Unsupported schema.org node type "{unsupported}" was detected.',
            "Flagged the unsupported type for review; the node was preserved.",
            unsupported,
            _MISSING,
            ["allowedGraphTypes"],
        )
    if _has_type(next_node, "FAQPage") and isinstance(next_node.get("mainEntity"), list):
        retained: list[dict[str, Any]] = []
        seen_questions: set[str] = set()
        for raw in cast(list[object], next_node["mainEntity"]):
            item = as_dict(raw)
            name = clean_text(item.get("name"))
            answer = as_dict(item.get("acceptedAnswer"))
            text = clean_text(answer.get("text"))
            if not name or not text:
                _add_repair(
                    repairs,
                    "FAQPage.mainEntity",
                    "schema-validator",
                    "FAQ question was missing a question name or accepted answer text.",
                    "Removed the invalid FAQ item from mainEntity.",
                    item,
                    None,
                    ["FAQPage.mainEntity.name", "FAQPage.mainEntity.acceptedAnswer.text"],
                )
                continue
            repaired_name = _repair_generated_text(name, "FAQPage.mainEntity.name", repairs)
            repaired_answer = _repair_generated_text(text, "FAQPage.mainEntity.acceptedAnswer.text", repairs)
            answer_after_non_answer_repair = _repair_faq_non_answer_lead(repaired_answer, item, repairs)
            if answer_after_non_answer_repair is None:
                _add_repair(
                    repairs,
                    "FAQPage.mainEntity",
                    "field-contract-validator",
                    "FAQ answer was only a non-answer (cannot-confirm) statement with no supported product fact.",
                    "Removed the non-answer FAQ item because answer engines cannot cite an answer that answers nothing.",
                    item,
                    None,
                    ["FAQPage.mainEntity.acceptedAnswer.text", "answer-ready FAQ contract"],
                )
                continue
            question_key = _semantic_faq_key(repaired_name)
            if question_key in seen_questions:
                _add_repair(
                    repairs,
                    "FAQPage.mainEntity",
                    "field-contract-validator",
                    "FAQ question duplicated the same answer-ready intent with different surface wording.",
                    "Removed the duplicate FAQ item so answer-ready questions remain concise and non-repetitive.",
                    item,
                    None,
                    ["FAQPage.mainEntity", "answer-ready FAQ semantic dedupe"],
                )
                continue
            seen_questions.add(question_key)
            retained.append(
                {
                    "@type": "Question",
                    "name": repaired_name,
                    "acceptedAnswer": {"@type": "Answer", "text": answer_after_non_answer_repair},
                }
            )
        next_node["mainEntity"] = retained
    if _has_type(next_node, "HowTo") and isinstance(next_node.get("step"), list):
        steps: list[dict[str, Any]] = []
        seen_steps: set[str] = set()
        source_procedure_matches_node = _how_to_matches_source_procedure(
            cast(list[object], next_node["step"]), locale, canonical_source_procedure_keys
        )
        for raw in cast(list[object], next_node["step"]):
            item = as_dict(raw)
            text = clean_text(item.get("text"))
            if not text:
                _add_repair(
                    repairs,
                    "HowTo.step",
                    "schema-validator",
                    "HowTo step was missing text.",
                    "Removed the invalid HowTo step.",
                    item,
                    None,
                    ["HowTo.step.text"],
                )
                continue
            repaired_text = _normalize_how_to_step(
                usage_text_without_step_marker(_repair_generated_text(text, "HowTo.step.text", repairs)), locale
            )
            if not source_procedure_matches_node and not _is_actionable_how_to_step(repaired_text, locale):
                _add_repair(
                    repairs,
                    "HowTo.step.text",
                    "field-contract-validator",
                    "HowTo.step text did not satisfy the RAG field evidence contract for actionable usage directions.",
                    "Removed the invalid HowTo step so benefit, evidence, ingredient, or review copy does not appear as a usage action.",
                    item,
                    None,
                    ["RAG Field Evidence Contract", "HowTo.step requires actionable usage evidence"],
                )
                continue
            step_key = _semantic_how_to_key(repaired_text, locale)
            if step_key in seen_steps:
                _add_repair(
                    repairs,
                    "HowTo.step.text",
                    "field-contract-validator",
                    "HowTo.step duplicated the same actionable usage direction with different surface wording.",
                    "Removed the duplicate HowTo step so usage directions remain concise and non-repetitive.",
                    item,
                    None,
                    ["HowTo.step", "actionable usage dedupe"],
                )
                continue
            seen_steps.add(step_key)
            if repaired_text:
                position = len(steps) + 1
                step_name = f"{position}단계" if locale == "ko-KR" else f"{position}段階" if locale == "ja-JP" else f"Step {position}"
                steps.append({"@type": "HowToStep", "position": position, "name": step_name, "text": repaired_text})
        next_node["step"] = steps
    if _has_type(next_node, "Product"):
        _repair_product_trust_fields(next_node, repairs)
        _prune_invalid_product_images(next_node, repairs)
    if _has_type(next_node, "BreadcrumbList"):
        _repair_breadcrumb_list(next_node, repairs)
    return next_node


def _semantic_faq_key(value: str) -> str:
    return re.sub(r"[^\w가-힣]+", "", value.casefold())


def _normalize_how_to_step(value: str, locale: str) -> str:
    if locale == "ko-KR":
        return re.sub(r"거품내어\s*줍니다", "거품을 냅니다", value).strip()
    return value.strip()


def _is_actionable_how_to_step(value: str, locale: str) -> bool:
    del locale
    text = usage_text_without_step_marker(value)
    if _is_non_instruction_usage_text(text):
        return False
    if _is_non_procedural_usage_candidate(text):
        return False
    if _is_evidence_only_usage_text(text):
        return False
    if _is_sensory_only_usage_text(text):
        return False
    if _is_ingredient_technology_usage_leak(text):
        return False
    return is_procedural_usage_instruction(text)


_FAQ_NON_ANSWER_LEAD = re.compile(
    r"(?:확인하기\s*어렵|확인이\s*어렵|확인되지\s*않|확인할\s*수\s*없|알\s*수\s*없|알기\s*어렵|"
    r"판단하기\s*어렵|정보만으로는|정보가\s*없|공개되지\s*않|미공개입니다|"
    r"cannot\s+be\s+(?:confirmed|verified|determined)|is\s+unclear|"
    r"is\s+not\s+(?:confirmed|specified|available)|no\s+information\s+is\s+available)",
    re.IGNORECASE,
)


def _repair_faq_non_answer_lead(answer: str, item: Mapping[str, Any], repairs: list[dict[str, Any]]) -> str | None:
    sentences = [sentence for sentence in re.split(r"(?<=[.。!?？])\s+", answer) if sentence]
    lead = sentences[0] if sentences else ""
    if not lead or _FAQ_NON_ANSWER_LEAD.search(lead) is None:
        return answer
    remainder = " ".join(sentences[1:]).strip()
    if js_code_unit_length(remainder) < 20 or _FAQ_NON_ANSWER_LEAD.search(remainder) is not None:
        return None
    _add_repair(
        repairs,
        "FAQPage.mainEntity.acceptedAnswer.text",
        "field-contract-validator",
        "FAQ answer opened with a non-answer (cannot-confirm) sentence instead of a supported product fact.",
        "Removed the non-answer lead sentence so the answer starts with the citable supported fact.",
        answer,
        remainder,
        ["FAQPage.mainEntity.acceptedAnswer.text", "answer-ready FAQ contract"],
    )
    return remainder


def _is_sensory_only_usage_text(value: str) -> bool:
    return bool(re.search(r"\b(?:take\s+a\s+deep\s+breath|inhale|scent|fragrance|aroma)\b", value, re.I)) and not bool(
        re.search(r"\b(?:apply|dispense|massage|lather|rinse|pat|press|spread|smooth|warm|pump|skin|face|neck)\b", value, re.I)
    )


def _has_usage_action_verb(value: str) -> bool:
    return bool(
        re.search(r"\b(?:apply|dispense|massage|lather|rinse|pat|press|spread|smooth|warm|take|pump)\b|なじませ|塗布|使(?:う|い)", value, re.I)
        or has_korean_instruction_verb(value)
        or re.search(r"^\s*use\b", value, re.I)
        or re.search(r"(?:^|[.;,]\s*)then\s+use\b", value, re.I)
        or re.search(r"\buse\s+(?:morning|night|daily|twice|once|after|before|as|with|on|to)\b", value, re.I)
    )


def _is_evidence_only_usage_text(value: str) -> bool:
    text = value.strip()
    if is_safety_or_test_claim_usage(text):
        return True
    if re.search(
        r"(?:%|％|\d+(?:\.\d+)?\s*배|임상|인체\s*적용|자가\s*평가|실험|시험|테스트|측정|평가|결과|대비|\bvs\.?\b|clinical|instrumental|study|test(?:ed)?|result|versus)",
        text,
        re.I,
    ) and re.search(r"(?:개선|증가|감소|높|낮|잔존|효과|효능|improv|increase|decrease|higher|lower|retention|effect)", text, re.I):
        return True
    has_raw_metric_evidence = bool(
        re.search(
            r"%|\b\d+(?:\.\d+)?\s*(?:weeks?|days?|hours?|users?|participants?|women|men|subjects?|reviews?)\b|"
            r"임상|인체\s*적용|자가\s*평가|사용자|참여자|대상|clinical|study|self-assess|instrumental|agreed|showed|rating",
            text,
            re.I,
        )
    ) and len(re.split(r"\s+", text)) >= 8
    looks_like_evidence = has_raw_metric_evidence or bool(
        re.search(r"\b(?:delivers?|helps?|supports?|improves?|boosts?|strengthens?|leaves?|leaving|visible|visibly|clinical|instrumental|self[-\s]?assessment|test(?:ed)?|agreed|showed)\b", text, re.I)
    )
    return looks_like_evidence and not _has_usage_action_verb(text)


def _is_review_like_usage_text(value: str) -> bool:
    text = value.strip()
    if not re.search(r"[가-힣]", text):
        return False
    customer_review_leak = bool(
        re.search(r"(?:아직\s*본격적으로|워낙\s*평|평이\s*좋|기대가\s*많|기대되|고객\s*리뷰|후기|리뷰)", text)
        or re.search(r"(?:구매했|구매\s*했|구매했어요|필요해서\s*구매|배송|포장|도착했|득템|저렴한\s*가격|쓰기\s*전부터|쓰기도\s*전부터|기분이\s*정말\s*좋)", text)
        or re.search(r"(?:초등학생|딸|아들|남편|어머니|엄마|가족)[^.!?。！？]{0,80}(?:구매|필요|사용|쓰|선크림)", text)
        or bool(re.search(r"(?:느낌이네요|느낌입니다|좋습니다|좋네요|좋아요|같아요|같습니다)\s*$", text))
        and not has_actionable_application_verb_without_generic_apply(text)
    )
    if customer_review_leak:
        return True
    has_review_voice = bool(
        re.search(r"(?:아직|본격적으로|워낙\s*평|평이\s*좋|기대(?:가|되|하)|타\s*제품|사용해\s*보|사용해보|사용해\s*봤|사용해봤|사용했|썼는데|써\s*보|써보|했었|더라구|더라고|구요|네요|어요|좋아요|괜찮겠지|마음으로|시간이\s*조금\s*지나)", text, re.I)
    )
    return has_review_voice and not has_actionable_application_verb(text)


def _is_non_instruction_usage_text(value: str) -> bool:
    return _is_review_like_usage_text(value) or is_safety_or_test_claim_usage(value)


def _is_ingredient_technology_usage_leak(value: str) -> bool:
    text = usage_text_without_step_marker(value).strip()
    has_formula_or_technology = bool(
        re.search(r"(?:성분|기술|포뮬러|복합체|캡슐|세라마이드|히알루론산|레티놀|나이아신아마이드|펩타이드|formula|technology|complex|capsule|ceramide|hyaluronic|retinol|niacinamide|peptide|成分|技術|処方|フォーミュラ|複合体|カプセル|セラミド|ヒアルロン酸|レチノール|ナイアシンアミド|ペプチド)", text, re.I)
    )
    has_instruction_cue = bool(
        re.search(r"(?:사용\s*방법|사용법|\bhow\s+to\s+use\b|\bdirections?\b|使い方|使用方法|適量|手のひら|顔全体|肌になじませ|塗布|すすぎ|マッサージ|적당량|손에|얼굴에|피부결|펴\s*바르|발라|흡수|도포|massage|apply|dispense|pat|press|spread|smooth|rinse|lather)", text, re.I)
    )
    has_only_descriptive_use = bool(re.search(r"(?:사용할\s*때마다|사용\s*시|when\s+used|with\s+each\s+use|使用時|使うたび)", text, re.I)) and not has_instruction_cue
    has_technology_use_frame = bool(
        re.search(r"(?:성분|기술|포뮬러|복합체|캡슐)[^.!?。！？]{0,60}(?:사용|적용|쓰(?:인|이는)|활용)|(?:uses?|using|applies?)[^.!?]{0,60}(?:ingredient|formula|technology|complex|capsule)|(?:成分|技術|処方|フォーミュラ|複合体|カプセル)[^.!?。！？]{0,60}(?:使用|採用|配合|活用)", text, re.I)
    )
    has_reporting_frame = bool(
        re.search(r"(?:적용|설계|제공|도출|방출|설명|특징|구성|함유|담(?:긴|은)|녹지\s*않|patent|proprietary|designed|delivers?|provides?|contains?|features?|採用|設計|提供|説明|特徴|構成|配合|含有|特許|独自)", text, re.I)
    )
    return has_formula_or_technology and (has_only_descriptive_use or has_technology_use_frame or has_reporting_frame) and not has_actionable_application_verb(text)


def _is_non_procedural_usage_candidate(value: str) -> bool:
    text = usage_text_without_step_marker(value).strip()
    if not text or (not has_procedure_action_cue(text) and not has_routine_placement_cue(text)):
        return False
    return not is_procedural_usage_instruction(text) and usage_description_signal_score(text) > 0


def _semantic_how_to_key(value: str, locale: str) -> str:
    if locale == "ko-KR":
        if "거품" in value:
            return "foam"
        if "헹" in value:
            return "rinse"
        if "마사지" in value or "문지" in value:
            return "massage"
    return re.sub(r"[^\w가-힣ぁ-んァ-ン一-龯]+", "", value.casefold())


def _repair_breadcrumb_list(node: dict[str, Any], repairs: list[dict[str, Any]]) -> None:
    raw_items = node.get("itemListElement")
    if not isinstance(raw_items, list):
        return
    typed_raw_items = cast(list[object], raw_items)
    before = copy.deepcopy(typed_raw_items)
    items: list[dict[str, Any]] = []
    for index, raw in enumerate(typed_raw_items, start=1):
        item = as_dict(raw)
        name = clean_text(item.get("name"))
        if not name:
            continue
        position = item.get("position")
        number = _positive_number(position)
        items.append({**item, "@type": "ListItem", "position": int(number) if number is not None else index, "name": name})
    node["itemListElement"] = [{**item, "position": index} for index, item in enumerate(items, start=1)]
    if len(items) < 2:
        _add_repair(
            repairs,
            "BreadcrumbList.itemListElement",
            "trust-field-validator",
            "BreadcrumbList has fewer than two valid hierarchy items.",
            "Kept the breadcrumb node but flagged it because stronger hierarchy evidence is needed.",
            before,
            node["itemListElement"],
            ["BreadcrumbList.itemListElement", "schema hierarchy quality gate"],
        )
    elif before != node["itemListElement"]:
        _add_repair(
            repairs,
            "BreadcrumbList.itemListElement",
            "schema-validator",
            "BreadcrumbList item positions or names were invalid.",
            "Removed invalid breadcrumb items and renumbered positions.",
            before,
            node["itemListElement"],
            ["BreadcrumbList.itemListElement"],
        )


def _normalise_images(value: object) -> list[str]:
    values = cast(list[object], value) if isinstance(value, list) else [value]
    result: list[str] = []
    for item in values:
        mapping = as_dict(item)
        candidates = [item] if isinstance(item, str) else [mapping.get("url"), mapping.get("contentUrl")]
        for candidate in candidates:
            if not isinstance(candidate, str):
                continue
            url = candidate.strip()
            if re.match(r"^https?://[^\s]+$", url, re.IGNORECASE) and not re.search(r"\.(?:svg)(?:\?|$)", url, re.IGNORECASE):
                if url not in result:
                    result.append(url)
    return result[:8]


def _positive_number(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(cast(str | int | float, value))
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _repair_product_trust_fields(product: dict[str, Any], repairs: list[dict[str, Any]]) -> None:
    if "image" in product:
        before = copy.deepcopy(product["image"])
        images = _normalise_images(product["image"])
        if images:
            product["image"] = images
        else:
            product.pop("image")
        if before != product.get("image"):
            _add_repair(
                repairs,
                "Product.image",
                "trust-field-validator",
                "Product.image included duplicate, low-quality, icon-like, or non-canonical image URLs.",
                "Canonicalized and deduplicated Product.image URLs." if images else "Removed Product.image because no schema-safe image URL remained.",
                before,
                product.get("image", _MISSING),
                ["Product.image", "schema image quality gate"],
            )
    if "offers" in product:
        before = copy.deepcopy(product["offers"])
        offer = as_dict(product["offers"])
        price = _positive_number(offer.get("price"))
        currency = clean_text(offer.get("priceCurrency")).upper()
        if price is None or not re.fullmatch(r"[A-Z]{3}", currency):
            product.pop("offers")
            _add_repair(
                repairs,
                "Product.offers",
                "trust-field-validator",
                "Product.offers lacked a trustworthy positive price and ISO currency.",
                "Removed Offer because price/currency evidence was insufficient.",
                before,
                _MISSING,
                ["Offer.price", "Offer.priceCurrency", "E-E-A-T trust-sensitive field policy"],
            )
    if "aggregateRating" in product:
        before = copy.deepcopy(product["aggregateRating"])
        rating = as_dict(product["aggregateRating"])
        value = _positive_number(rating.get("ratingValue"))
        count = _positive_number(rating.get("reviewCount"))
        if value is None or value > 5 or count is None:
            product.pop("aggregateRating")
            _add_repair(
                repairs,
                "Product.aggregateRating",
                "trust-field-validator",
                "AggregateRating lacked a valid rating value and positive review count.",
                "Removed AggregateRating because rating evidence was insufficient.",
                before,
                _MISSING,
                ["AggregateRating.ratingValue", "AggregateRating.reviewCount", "E-E-A-T review evidence policy"],
            )
    if "review" in product:
        before = copy.deepcopy(product["review"])
        raw_reviews = cast(list[object], product["review"]) if isinstance(product["review"], list) else [product["review"]]
        reviews = [copy.deepcopy(as_dict(item)) for item in raw_reviews if clean_text(as_dict(item).get("reviewBody"))]
        if reviews:
            product["review"] = reviews
        else:
            product.pop("review")
        if before != product.get("review"):
            _add_repair(
                repairs,
                "Product.review",
                "trust-field-validator",
                "Review schema lacked meaningful customer review body evidence or reused product/rating summary text.",
                "Kept only meaningful customer reviews." if reviews else "Removed Review schema because no valid review body remained.",
                before,
                product.get("review", _MISSING),
                ["Review.reviewBody", "E-E-A-T review evidence policy"],
            )


def _prune_invalid_product_images(product: dict[str, Any], repairs: list[dict[str, Any]]) -> None:
    """Apply the legacy late URL syntax prune after trust-field normalization."""

    original_images = product.get("image")
    if not isinstance(original_images, list):
        return
    image_values = cast(list[object], original_images)
    filtered_images: list[object] = [
        image for image in image_values if not isinstance(image, str) or is_publishable_image_url(image)
    ]
    if len(filtered_images) == len(image_values):
        return
    _add_repair(
        repairs,
        "Product.image",
        "schema-validator",
        "Product.image contained malformed or truncated image URLs.",
        "Removed malformed image URLs from Product.image.",
        [image for image in image_values if isinstance(image, str) and not is_publishable_image_url(image)],
        None,
        ["Product.image", "URL syntax check"],
    )
    product["image"] = filtered_images


def _repair_full_content_sections(sections: dict[str, Any], repairs: list[dict[str, Any]]) -> dict[str, Any]:
    repaired = copy.deepcopy(sections)
    for key, value in list(repaired.items()):
        if isinstance(value, str):
            repaired[key] = _repair_multiline_generated_text(value, f"content.sections.{key}", repairs)
    faq = repaired.get("faq")
    if isinstance(faq, str):
        matched = re.match(r"^(Q\.\s*.+?\?)\s+(A\.\s*.+)$", faq.strip(), re.DOTALL)
        if matched is not None:
            next_faq = f"{matched.group(1)}\n{matched.group(2)}"
            if next_faq != faq:
                _add_repair(
                    repairs,
                    "content.sections.faq",
                    "sentence-qa",
                    "FAQ Q/A markers were merged into adjacent answer text or contained spacing artifacts.",
                    "Restored Q/A line breaks and normalized answer spacing so FAQ content remains parseable in section HTML.",
                    faq,
                    next_faq,
                    ["content.sections.faq", "FAQ Q/A markers", "en-US"],
                )
                repaired["faq"] = next_faq
    how_to_use = repaired.get("howToUse")
    if isinstance(how_to_use, str):
        repaired["howToUse"] = _repair_how_to_use_section(how_to_use, repairs)
    return repaired


def _repair_how_to_use_section(value: str, repairs: list[dict[str, Any]]) -> str:
    lines = [line.strip() for line in re.split(r"\n+", value) if line.strip()]
    if not lines:
        return value
    kept = [line for line in lines if _is_actionable_how_to_step(usage_text_without_step_marker(line), "en-US")]
    repaired_lines = [usage_text_without_step_marker(line) for line in kept]
    if len(repaired_lines) == len(lines) and repaired_lines == lines:
        return value
    next_value = "\n".join(repaired_lines) if repaired_lines else ""
    _add_repair(
        repairs,
        "content.sections.howToUse",
        "field-contract-validator",
        "Public content section contained lines that did not match the RAG field evidence contract.",
        "Removed misrouted lines so usage, ingredient, and benefit content stay separated after generation.",
        value,
        next_value,
        ["RAG Field Evidence Contract", "content.sections.howToUse"],
    )
    return next_value


def _script_tag_matches_json_ld(script_tag: str, json_ld: Mapping[str, Any]) -> bool:
    match = re.fullmatch(r"\s*<script\s+type=[\"']application/ld\+json[\"']\s*>([\s\S]*)</script>\s*", script_tag, re.IGNORECASE)
    if match is None or not match.group(1):
        return False
    try:
        return json.loads(match.group(1)) == json_ld
    except json.JSONDecodeError:
        return False


def _collect_public_wording_findings(json_ld: Mapping[str, Any], source_product: object) -> list[dict[str, Any]]:
    graph = [as_dict(raw) for raw in as_list(json_ld.get("@graph")) if as_dict(raw)]
    findings: list[dict[str, Any]] = []
    source = as_dict(source_product)
    reviews = as_dict(source.get("reviews"))
    has_review_evidence = any(len(clean_text(as_dict(item).get("body"))) >= 20 for item in as_list(reviews.get("items"))) or any(
        len(clean_text(value)) >= 3 for value in as_list(reviews.get("keywords"))
    )
    qualitative_pattern = re.compile(r"(?:customer|positive)\s+reviews?\s+(?:mention|highlight|use|describe)|customers?\s+highlight", re.IGNORECASE)
    for node in graph:
        type_ = _node_types(node)[0] if _node_types(node) else "node"
        description = node.get("description")
        if source and isinstance(description, str) and not has_review_evidence and qualitative_pattern.search(description):
            findings.append(
                {
                    "field": f"{type_}.description",
                    "source": "trust-field-validator",
                    "issue": "Qualitative review wording was published without review-body or review-keyword evidence.",
                    "suggestedAction": "Keep AggregateRating, but omit qualitative review claims until source-scoped review evidence exists.",
                    "before": description,
                    "evidence": ["product.reviews.items", "product.reviews.keywords"],
                }
            )
        if _has_type(node, "Product") and isinstance(node.get("additionalProperty"), list):
            for index, raw in enumerate(cast(list[object], node["additionalProperty"])):
                property_ = as_dict(raw)
                if property_.get("name") != "Key ingredients" or not isinstance(property_.get("value"), str):
                    continue
                value = str(property_["value"])
                for token in (item.strip() for item in value.split(",")):
                    if token.casefold() in {"what", "which", "how", "why", "when", "where", "who", "it", "this", "that", "these", "those", "other", "others", "etc", "and", "or", "more", "misc", "unknown", "n/a"}:
                        findings.append(
                            {
                                "field": f"Product.additionalProperty[{index}].value",
                                "source": "trust-field-validator",
                                "issue": f'Key ingredients contained a non-ingredient token ("{token}").',
                                "suggestedAction": "Remove broken extraction tokens; list only named substances, INCI entries, or proprietary ingredient technologies.",
                                "before": value,
                                "evidence": ["Key ingredients token contract"],
                            }
                        )
    return findings


def _clean_json(value: object) -> object:
    if isinstance(value, list):
        cleaned_items: list[object] = []
        for item in cast(list[object], value):
            cleaned_item = _clean_json(item)
            if cleaned_item not in (None, "", []):
                cleaned_items.append(cleaned_item)
        return cleaned_items
    if isinstance(value, Mapping):
        cleaned_mapping: dict[str, object] = {}
        for key, item in cast(Mapping[str, object], value).items():
            cleaned_item = _clean_json(item)
            if cleaned_item not in (None, "", []):
                cleaned_mapping[key] = cleaned_item
        return cleaned_mapping
    return value


def _slug(value: str) -> str:
    return re.sub(r"^-+|-+$", "", re.sub(r"[^a-z0-9가-힣ぁ-んァ-ン一-龯]+", "-", value.casefold())) or "product"


def _node_types(node: Mapping[str, Any]) -> list[str]:
    value = node.get("@type")
    return [value] if isinstance(value, str) else [str(item) for item in as_list(value) if isinstance(item, str)]


def _unique(values: Sequence[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        if value not in seen:
            seen.add(value)
            result.append(value)
    return result


escapeScriptJson = escape_script_json
serializeSchemaMarkup = serialize_schema_markup
validatePdpGeoArtifacts = validate_pdp_geo_artifacts
applySafePublicCopyRepairs = apply_safe_public_copy_repairs
validateAndRepairPdpGeoArtifacts = validate_and_repair_pdp_geo_artifacts
