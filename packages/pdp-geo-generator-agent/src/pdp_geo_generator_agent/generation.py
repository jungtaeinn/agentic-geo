"""Deterministic PDP GEO artifact renderer.

The renderer deliberately has no provider dependency: RAG and optional model
stages may choose/approve source facts, but this module preserves their order
and emits one stable JSON-LD graph from them.
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Mapping, Sequence
from typing import Any, Literal, cast
from urllib.parse import parse_qsl, quote, unquote, urlencode, urljoin, urlparse, urlsplit, urlunparse, urlunsplit

from ._json import as_dict, as_list, clean_text
from .content_planning import (
    ADJACENT_MEASURED_QUANTITIES,
    create_conservative_content_plan,
    create_pdp_geo_evidence_ledger,
    is_raw_metric_table_fragment,
    render_merged_measured_result_metric,
    render_structured_table_metric_sentence,
)
from .contracts.image_source import is_publishable_image_url
from .contracts.ingredient_vocabulary import ingredient_surfaces_present_in
from .contracts.metric_statement import (
    naming_identifier_numerics,
    numeric_tokens,
    product_naming_surfaces,
    word_tokens,
)
from .contracts.product_identity import (
    contains_entity_identity_phrase,
    contains_entity_identity_phrase_in_prose,
    english_deictic_self_reference,
    english_refers_to_an_unnamed_group,
    korean_deictic_self_reference,
    korean_product_reference,
    product_entity_reference,
    product_title_without_sku_qualifier,
)
from .contracts.product_type import (
    localize_product_type_for_locale,
    name_product_type_supersedes_category,
    product_type_from_name,
)
from .contracts.publication import (
    is_merchant_or_review_copy,
    is_publishable_description_text,
    publishable_public_copy,
    retain_publishable_description_sentences,
)
from .contracts.sentence_form import (
    ENGLISH_FUNCTION_WORDS,
    PUBLIC_COPY_TAG_MARKER,
    english_subjectless_predicate,
    is_atomic_fact_phrase,
    is_complete_sentence,
    is_korean_complete_sentence,
    korean_classifies_its_subject,
    korean_plain_declarative,
    korean_reported_clause,
    korean_reported_clause_misreads_a_verb,
    korean_sentence_opens_with_a_constituent,
    names_a_thing,
    publishable_stems,
    states_its_own_subject,
    states_only_what_the_source_states,
    strip_korean_particle,
)
from .contracts.usage import is_procedural_usage_instruction, is_raw_page_text_block
from .faq_relationships import build_faq_relationship_cards
from .final_proofreader import sentence_evidence_has_direct_claim_support
from .normalization import korean_clause_predicates_an_outcome_of
from .review_sentiment import is_positive_aggregate_rating, is_positive_review_item, is_positive_review_keyword
from .schema_graph import create_schema_markup
from .schema_values import (
    gtin_property_name,
    normalize_availability_token,
    normalize_item_condition_token,
    normalize_monetary_amount_for_currency,
    sanitize_gtin_value,
    sanitize_sku_value,
    schema_enum_url,
)

_DEFAULT_TARGETS = ["WebPage", "Product", "FAQPage", "BreadcrumbList"]
_TRACKING = re.compile(
    r"^(?:variant|variant_?id|selected_?variant|option_?id|utm_[a-z0-9_]+|gclid|fbclid|igshid|msclkid|mc_[ce]id|ref|ref_src|srsltid)$",
    re.I,
)
_PRICE_CURRENCY_SYMBOLS = {"$": "USD", "US$": "USD", "£": "GBP", "¥": "JPY", "₩": "KRW", "€": "EUR"}
_MARKET_CURRENCIES = {"KR": "KRW", "JP": "JPY", "US": "USD", "GB": "GBP", "UK": "GBP"}
_GENERIC_CATEGORY = re.compile(
    r"^(?:usage|use|how to use|direction|directions|review|reviews|rating|ratings|benefit|benefits|"
    r"effect|effects|ingredient|ingredients|content|section|product|item|type)$",
    re.IGNORECASE,
)
_FAQ_ENTITY_TYPE_QUESTION = re.compile(
    r"^\s*(?:what\s+(?:kind|type|category)(?:\s+of)?\s+(?:product|item)\s+is|"
    r"what\s+(?:kind|type|category)\s+is)\b",
    re.IGNORECASE,
)
_FAQ_SOURCE_META = re.compile(
    r"\b(?:source(?:\s+(?:text|field|copy|material))?|metadata|field|section|heading|"
    r"attribute|product(?:[- ]detail)?\s+page|pdp)\b",
    re.IGNORECASE,
)
_FAQ_SOURCE_META_PREDICATE = re.compile(
    r"\b(?:say|state|list|mention|show|describe|contain|include)\b",
    re.IGNORECASE,
)
_FAQ_SAFETY_QUESTION = re.compile(
    r"\b(?:safe(?:ty)?|pregnan\w*|expectant\w*|newborns?|infants?|children|"
    r"patch[-\s]*test(?:ed)?|allerg(?:y|ies)|irritat\w*|contraindicat\w*)\b|"
    r"(?:임신|영아|신생아|어린이|안전|주의)",
    re.IGNORECASE,
)
_METRIC_DURATION_UNIT = re.compile(
    r"^(?:ms|msec|milliseconds?|seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|"
    r"초|분|시간|일|주|개월|년)$",
    re.IGNORECASE,
)
_METRIC_SPECULATIVE_OUTCOME = re.compile(
    r"\b(?:may|might|could|can|likely|possibly|potentially)\s+"
    r"(?:appear|seem|show|feel|look|improve|reduce|increase|decrease|become|provide|deliver)\b|"
    r"\bas\s+soon\s+as\b|(?:보일|느껴질|개선될|나타날)\s*수\s*있",
    re.IGNORECASE,
)


def generate_pdp_geo_artifacts(input_: Mapping[str, Any]) -> dict[str, Any]:
    product = as_dict(input_.get("product"))
    locale = str(input_.get("locale") or "en-US")
    market = clean_text(input_.get("market"))
    hints = as_dict(input_.get("hints"))
    source_url = _canonical_url(clean_text(input_.get("sourceUrl")))
    plan = as_dict(input_.get("contentPlan"))
    name = _product_name(product, locale, hints)
    planned_how_to = _canonical_how_to(product, locale, plan)
    usage = _usage_steps(planned_how_to)
    faq = _faq_items(product, plan, locale=locale, name=name, usage=usage)
    card_recommendation_by_id = _faq_card_recommendation_by_id(
        as_list(plan.get("faqRelationshipCards"))
    )
    faq_membership = [
        {
            "id": clean_text(item.get("id")),
            "intent": clean_text(item.get("intent")),
            "evidenceIds": [clean_text(identifier) for identifier in as_list(item.get("evidenceIds")) if clean_text(identifier)],
            "canRecommend": card_recommendation_by_id.get(clean_text(item.get("id")), False),
        }
        for item in faq
    ]
    product_description = publishable_public_copy(_description(product, name, locale, plan, "product"))
    webpage_description = publishable_public_copy(
        _description(product, name, locale, plan, "webpage", canonical_usage=usage)
    )
    sections = {
        "productName": name,
        "description": product_description,
        "quickFacts": _quick_facts(product, locale),
        "benefits": _benefits_section(product, locale),
        "ingredients": _ingredients_section(product, locale),
        "howToUse": _usage_text(usage),
        "faq": _faq_text(faq),
    }
    # The approved canonical procedure is the one public HowTo source.  Both
    # the visible section and JSON-LD consume it, so raw usage fragments cannot
    # change source-step count or order after planning.  An explicitly
    # unordered collection remains useful visible guidance, but is not emitted
    # as Schema.org HowTo because that vocabulary asserts an ordered procedure.
    schema_usage = (
        usage
        if planned_how_to.get("eligible") is True and planned_how_to.get("ordered") is not False
        else []
    )
    graph = _build_graph(
        product, name, product_description, webpage_description, faq, schema_usage, locale, market, source_url, hints
    )
    markup = create_schema_markup(graph)
    json_ld = {"@context": "https://schema.org", "@graph": markup["graph"]}
    # `create_schema_markup` retains graph/script convenience fields for
    # internal callers. The public agent result has always exposed only this
    # wire envelope (the TypeScript object relies on the same distinction).
    schema_markup = {"jsonLd": json_ld, "scriptTag": markup["script"]}
    selected = [as_dict(item) for item in as_list(input_.get("ragChunks"))]
    terminology_concepts = _read_terminology_concepts(as_list(input_.get("ragDocuments")))
    detected_concepts = _detect_terminology_concepts(product, terminology_concepts)
    localized_terms = [
        term
        for concept in detected_concepts
        for term in _preferred_terms(concept, locale)[:1]
    ]
    terminology: dict[str, Any] = {
        "locale": locale,
        "market": market or None,
        "appliedTerms": [],
        "avoidedTerms": [],
        "suggestions": [],
    }
    for term in localized_terms:
        concept = next((item for item in detected_concepts if term in _preferred_terms(item, locale)), None)
        terminology["appliedTerms"].append(
            {"concept": clean_text(as_dict(concept).get("concept")) or "locale-term", "term": term, "field": "description"}
        )
    reasoning = as_dict(input_.get("reasoning"))
    guidance_sources = _guidance_sources(reasoning, selected)
    inferred_search_queries = _inferred_search_queries(product, name, locale, plan)
    recommendations = _recommendations(product, sections, detected_concepts, locale, guidance_sources)
    evidence = [
        {"field": "content.productName", "source": "input", "value": str(product.get("name") or name)},
        {
            "field": "content.description",
            "source": "renderer",
            "value": "Deterministic source-backed renderer produced the public description from the normalized product record.",
        },
    ]
    if plan.get("mode") == "model":
        planned_faq = [item for item in as_list(plan.get("faq")) if as_dict(item).get("include")]
        if planned_faq:
            evidence.append(
                {
                    "field": "content.faq",
                    "source": "input",
                    "value": (
                        f"Rendered exactly {len(planned_faq)} FAQ item(s) approved by the evidence-bound model content plan "
                        "without fallback replenishment."
                    ),
                }
            )
    if inferred_search_queries:
        evidence.append(
            {
                "field": "diagnostics.inferredSearchQueries",
                "source": "rag",
                "value": " / ".join(
                    f"{query['kind']}: {query['question']} [{', '.join(query['keywords'])}]"
                    for query in inferred_search_queries
                ),
            }
        )
    if guidance_sources:
        evidence.append(
            {
                "field": "rag.geoOptimizationGuidance",
                "source": "rag",
                "value": (
                    "Reconstructed HowTo, FAQ, and benefit content with GEO guidance from: "
                    f"{', '.join(guidance_sources)}"
                ),
            }
        )
    enabled_reasoning = [item for item in as_list(reasoning.get("decisions")) if as_dict(item).get("enabled") is True]
    if enabled_reasoning:
        evidence.append(
            {
                "field": "rag.reasoning",
                "source": "rag",
                "value": " / ".join(
                    f"{as_dict(item).get('principle', '')}: "
                    f"{', '.join(str(source) for source in as_list(as_dict(item).get('ragSources')))} + "
                    f"{len(as_list(as_dict(item).get('productEvidence')))} product evidence item(s)"
                    for item in enabled_reasoning
                ),
            }
        )
    # The derived attributes that are not published stay available as
    # diagnostics: they are what the renderer read to compose the fields that
    # own those facts, and a reader of this artifact can still audit them.
    for attribute in internal_product_attributes(_additional_properties(product, schema_usage, locale)):
        evidence.append(
            {
                "field": f"diagnostics.productAttribute.{clean_text(attribute.get('name'))}",
                "source": "renderer",
                "value": clean_text(attribute.get("value")),
            }
        )
    official_doc_sources = _selected_official_doc_sources(selected)
    if official_doc_sources:
        recommendations.append(
            {
                "field": "schema",
                "message": ", ".join(official_doc_sources),
                "reason": (
                    "Official AI/search platform docs were selected to guide retrieval, structured data, grounding, "
                    "and answer eligibility constraints."
                ),
            }
        )
        evidence.append(
            {
                "field": "rag.officialPlatformDocs",
                "source": "rag",
                "value": f"Selected official platform docs: {', '.join(official_doc_sources)}",
            }
        )
    return {
        "schemaMarkup": schema_markup,
        "content": {"html": "", "sections": sections},
        "recommendations": recommendations,
        "evidence": evidence,
        "terminology": terminology,
        "inferredSearchQueries": inferred_search_queries,
        "faqMembership": faq_membership,
    }


def collect_pdp_geo_plan_render_shortfalls(
    plan: Mapping[str, Any], schema_markup: Mapping[str, Any], content: Mapping[str, Any]
) -> list[str]:
    """Return deterministic FAQ/HowTo plan-to-artifact coverage shortfalls.

    This is intentionally a pure structural check: it compares approved row
    counts with the finished schema and visible sections without revisiting
    claim wording.  HowTo wording may legitimately be canonical source text
    rather than a planner's paraphrase, but its source-step cardinality,
    positions, and schema-to-visible order must remain intact.
    """

    graph = [as_dict(item) for item in as_list(as_dict(as_dict(schema_markup).get("jsonLd")).get("@graph"))]
    sections = as_dict(content.get("sections"))
    shortfalls: list[str] = []

    def nodes(type_name: str) -> list[dict[str, Any]]:
        return [
            item
            for item in graph
            if type_name in (
                [clean_text(item.get("@type"))]
                if isinstance(item.get("@type"), str)
                else [clean_text(value) for value in as_list(item.get("@type"))]
            )
        ]

    if plan.get("mode") == "model":
        expected_faq = [item for item in as_list(plan.get("faq")) if as_dict(item).get("include") is True]
        if expected_faq:
            rendered_faq = [
                item
                for node in nodes("FAQPage")
                for item in as_list(node.get("mainEntity"))
                if as_dict(item)
            ]
            visible_faq = len(re.findall(r"(?m)^Q\.\s+", str(sections.get("faq") or "")))
            if len(rendered_faq) != len(expected_faq) or visible_faq != len(expected_faq):
                shortfalls.append(
                    "FAQ plan/render structural coverage shortfall: "
                    f"expected {len(expected_faq)} approved row(s), rendered {len(rendered_faq)} schema row(s) "
                    f"and {visible_faq} visible row(s)."
                )

    planned_how_to = as_dict(plan.get("howTo"))
    expected_how_to = as_list(planned_how_to.get("steps")) if planned_how_to.get("eligible") is True else []
    how_to_is_ordered = planned_how_to.get("ordered") is not False
    if expected_how_to:
        expected_how_to_rows = [as_dict(item) for item in expected_how_to if clean_text(as_dict(item).get("text"))]
        rendered_how_to_rows = [
            as_dict(item)
            for node in nodes("HowTo")
            for item in as_list(node.get("step"))
            if clean_text(as_dict(item).get("text"))
        ]
        visible_how_to = [clean_text(line) for line in str(sections.get("howToUse") or "").splitlines() if clean_text(line)]
        expected_how_to_positions = [row.get("position") for row in expected_how_to_rows]
        rendered_how_to_positions = [row.get("position") for row in rendered_how_to_rows]
        rendered_how_to_texts = [clean_text(row.get("text")) for row in rendered_how_to_rows]
        schema_matches = (
            len(rendered_how_to_rows) == len(expected_how_to_rows)
            and rendered_how_to_positions == expected_how_to_positions
            and visible_how_to == rendered_how_to_texts
        )
        unordered_matches = not rendered_how_to_rows and visible_how_to == [
            clean_text(row.get("text")) for row in expected_how_to_rows
        ]
        if not (
            unordered_matches
            if not how_to_is_ordered
            else schema_matches and len(visible_how_to) == len(expected_how_to_rows)
        ):
            shortfalls.append(
                "HowTo plan/render structural coverage shortfall: "
                f"expected {len(expected_how_to_rows)} approved row(s), rendered {len(rendered_how_to_rows)} schema row(s) "
                f"and {len(visible_how_to)} visible row(s)."
            )
    return shortfalls


def ensure_pdp_geo_faq_plan_coverage(input_: Mapping[str, Any]) -> dict[str, Any]:
    """Finalize only evidence-admitted, model-authored FAQ membership.

    This boundary intentionally has no source-pair recovery and no copy
    rewrite. Relationship cards may describe missing rows for diagnostics, but
    only the model can turn those facts into public customer Q&A.
    """

    plan, product = dict(as_dict(input_.get("plan"))), as_dict(input_.get("product"))
    if plan.get("mode") != "model":
        return plan

    ledger = [as_dict(item) for item in as_list(input_.get("evidenceLedger"))]
    known_evidence_ids = {clean_text(item.get("id")) for item in ledger if clean_text(item.get("id"))}
    locale = clean_text(input_.get("locale")) or "en-US"
    name = _product_name(product, locale, {})
    cards = [as_dict(item) for item in as_list(plan.get("faqRelationshipCards")) if as_dict(item)]
    if not cards:
        cards = [as_dict(item) for item in as_list(input_.get("faqRelationshipCards")) if as_dict(item)]
    if not cards:
        cards = build_faq_relationship_cards(product, ledger, locale)
    cards_by_id = {
        identifier: card
        for card in cards
        if (identifier := clean_text(card.get("id")))
    }
    card_recommendation_by_id = _faq_card_recommendation_by_id(cards)

    retained: list[dict[str, Any]] = []
    warnings = [clean_text(item) for item in as_list(plan.get("warnings")) if clean_text(item)]
    coverage_diagnostics: list[dict[str, str]] = []
    seen_ids: set[str] = set()
    seen_questions: set[str] = set()
    seen_answers: set[str] = set()

    def record(index: int, row_id: str, outcome: str, reason: str) -> None:
        coverage_diagnostics.append(
            {
                "field": f"FAQ[{index}]",
                **({"rowId": row_id} if row_id else {}),
                "outcome": outcome,
                "reason": reason,
            }
        )

    for index, raw_row in enumerate(as_list(plan.get("faq"))):
        row = as_dict(raw_row)
        if row.get("include") is not True:
            continue
        row_id = clean_text(row.get("id"))
        question, answer = clean_text(row.get("question")), clean_text(row.get("answer"))
        evidence_ids = list(
            dict.fromkeys(
                identifier
                for identifier in (clean_text(item) for item in as_list(row.get("evidenceIds")))
                if identifier and identifier in known_evidence_ids
            )
        )
        if not row_id:
            warnings.append(f"FAQ[{index}] was omitted because a finalized model FAQ requires a stable relationship-card ID.")
            record(index, row_id, "rejected", "missingRelationshipCardId")
            continue
        if row_id not in cards_by_id:
            warnings.append(f"FAQ[{index}] was omitted because its relationship-card ID was not supplied to the planner.")
            record(index, row_id, "rejected", "unknownRelationshipCardId")
            continue
        if row_id in seen_ids:
            warnings.append(f"FAQ[{index}] was omitted because its relationship-card ID was duplicated.")
            record(index, row_id, "rejected", "duplicateRelationshipCardId")
            continue
        if not _faq_plan_row_is_admitted(plan, index, row_id=row_id):
            warnings.append(f"FAQ[{index}] was omitted because field-local admission rejected the row.")
            record(index, row_id, "rejected", "fieldLocalAdmission")
            continue
        if not question or not answer or not evidence_ids:
            warnings.append(f"FAQ[{index}] was omitted because its finalized model row was incomplete or lacked ledger evidence.")
            record(index, row_id, "rejected", "incompleteModelRow")
            continue
        if not _is_customer_ready_faq_question(question, locale):
            warnings.append(f"FAQ[{index}] was omitted because it was a source-field question rather than a customer decision question.")
            record(index, row_id, "rejected", "customerDecisionQuestion")
            continue
        if not _faq_has_citation_ready_entity_pair(question, answer, product, name):
            warnings.append(f"FAQ[{index}] was omitted because its question/answer pair lacks a natural brand/product reference.")
            record(index, row_id, "rejected", "entityIdentity")
            continue
        question_key, answer_key = _faq_intent_key(question), _faq_intent_key(answer)
        if not question_key or question_key in seen_questions or answer_key in seen_answers:
            warnings.append(f"FAQ[{index}] was omitted because it duplicated another finalized FAQ row.")
            record(index, row_id, "rejected", "duplicateCustomerIntent")
            continue
        seen_ids.add(row_id)
        seen_questions.add(question_key)
        seen_answers.add(answer_key)
        retained.append(
            {
                **row,
                "id": row_id,
                "include": True,
                "question": question,
                "answer": answer,
                "evidenceIds": evidence_ids,
                "omitReason": "",
            }
        )
        record(index, row_id, "accepted", "finalizedModelMembership")
        if len(retained) == 3:
            break

    membership = [
        {
            "id": clean_text(row.get("id")),
            "intent": clean_text(row.get("intent")),
            "evidenceIds": list(as_list(row.get("evidenceIds"))),
            "canRecommend": card_recommendation_by_id.get(clean_text(row.get("id")), False),
        }
        for row in retained
    ]
    selected_ids = {clean_text(item["id"]) for item in membership}
    remaining_cards = [
        card
        for card in cards
        if clean_text(card.get("id")) and clean_text(card.get("id")) not in selected_ids
    ]
    recovery = (
        {
            "required": True,
            "reason": "insufficientAdmittedCustomerDecisionFaq",
            "relationshipCards": remaining_cards,
            "acceptedRowCount": len(retained),
        }
        if remaining_cards and len(retained) < 2
        else {}
    )
    admission_diagnostics = as_dict(plan.get("admissionDiagnostics"))
    finalized_plan = {
        **{key: value for key, value in plan.items() if key not in {"faq", "faqRecovery", "faqMembership", "admissionDiagnostics", "warnings"}},
        "faq": retained,
        "faqMembership": membership,
        "admissionDiagnostics": {
            **admission_diagnostics,
            "faqCoverage": coverage_diagnostics,
            "faqMembership": membership,
        },
        **({"faqRecovery": recovery} if recovery else {}),
        **({"warnings": _unique_texts(warnings)} if warnings else {}),
    }
    return finalized_plan


def _faq_card_recommendation_by_id(cards: Sequence[object]) -> dict[str, bool]:
    """Resolve recommendation authority from immutable relationship cards only.

    FAQ rows are model-authored public copy, so their ``canRecommend`` value
    is not an authority.  A duplicate card ID is equally ambiguous and fails
    closed to ``False`` rather than allowing either card to elevate the row.
    """

    values: dict[str, bool] = {}
    duplicate_ids: set[str] = set()
    for raw in cards:
        card = as_dict(raw)
        identifier = clean_text(card.get("id"))
        if not identifier:
            continue
        if identifier in values:
            duplicate_ids.add(identifier)
            continue
        values[identifier] = card.get("canRecommend") is True
    return {
        identifier: False if identifier in duplicate_ids else value
        for identifier, value in values.items()
    }




def _faq_plan_row_is_admitted(plan: Mapping[str, Any], index: int, *, row_id: str = "") -> bool:
    """Respect the field decision for one model FAQ row when it is available.

    Service plans carry per-row diagnostics before renderer-only coverage is
    added. Direct callers can mark a hand-assembled plan as admitted without
    those diagnostics, in which case its explicit ``include`` flags remain
    the only membership signal.
    """

    diagnostics = as_dict(plan.get("admissionDiagnostics"))
    fields = [as_dict(raw) for raw in as_list(diagnostics.get("fields")) if as_dict(raw)]
    if row_id:
        id_outcomes = [
            clean_text(item.get("outcome")).casefold()
            for item in fields
            if clean_text(item.get("rowId")) == row_id
        ]
        if id_outcomes:
            return any(outcome in {"accepted", "admitted"} for outcome in id_outcomes)
    target = f"faq[{index}]"
    outcomes = [
        clean_text(item.get("outcome")).casefold()
        for item in fields
        if clean_text(item.get("field")).casefold() == target
    ]
    if outcomes:
        return any(outcome in {"accepted", "admitted"} for outcome in outcomes)
    return plan.get("_admittedContentPlan") is True




def select_schema_images(
    product: Mapping[str, Any], product_name: str, source_url: str | None = None, limit: int = 8
) -> list[str]:
    """Select canonical product images with evidence used as a rank-only boost.

    This mirrors retained ``selectSchemaImages``: responsive URL variants and
    obvious UI artifacts are removed before scores are considered; OCR/semantic
    citations never make an otherwise ineligible image publishable.
    """

    evidence_keys = _evidence_backed_schema_image_keys(product, source_url)
    candidates: list[tuple[str, int, int]] = []
    for index, raw in enumerate(as_list(product.get("images"))):
        canonical = _canonical_schema_image_url(clean_text(raw), source_url)
        if canonical is None or _is_low_quality_schema_image_url(canonical):
            continue
        candidates.append((canonical, index, _score_schema_image_url(canonical, product_name, source_url, index)))

    deduped: list[tuple[str, int, int]] = []
    seen: set[str] = set()
    for candidate in candidates:
        key = _schema_image_dedupe_key(candidate[0])
        if key not in seen:
            seen.add(key)
            deduped.append(candidate)

    has_high_confidence = any(score >= 35 for _, _, score in deduped)
    scoped = (
        [candidate for candidate in deduped if candidate[2] >= 20]
        if has_high_confidence
        else [candidate for candidate in deduped if candidate[2] >= 0][: min(limit, 4)]
    )
    ranked = sorted(
        scoped,
        key=lambda candidate: (
            -(candidate[2] + (15 if _schema_image_dedupe_key(candidate[0]) in evidence_keys else 0)),
            candidate[1],
        ),
    )
    return [url for url, _, _ in ranked[:limit]]


def _evidence_backed_schema_image_keys(product: Mapping[str, Any], source_url: str | None) -> set[str]:
    raw_urls: list[str] = []
    for meta in as_dict(product.get("sourceTextMeta")).values():
        raw_urls.extend(clean_text(value) for value in as_list(as_dict(meta).get("imageUrls")) if clean_text(value))
    facts = as_dict(product.get("semanticFacts"))
    for field in ("metricClaims", "ingredientBenefitLinks", "citations"):
        for claim in as_list(facts.get(field)):
            raw_urls.extend(clean_text(value) for value in as_list(as_dict(claim).get("imageUrls")) if clean_text(value))
    return {
        _schema_image_dedupe_key(canonical)
        for raw in raw_urls
        if (canonical := _canonical_schema_image_url(raw, source_url)) is not None
    }


def _canonical_schema_image_url(image_url: str, source_url: str | None) -> str | None:
    raw = image_url.strip()
    if not raw or re.match(r"^data:", raw, re.I) or re.search(r"\.svg(?:\?|$)", raw, re.I):
        return None
    parsed = urlparse(urljoin(source_url or "", raw))
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.netloc:
        return None
    query = urlencode(
        [
            (key, value)
            for key, value in parse_qsl(parsed.query, keep_blank_values=True)
            if not re.fullmatch(r"(?:width|height|w|h|fit|crop|format|fm|q|quality|v|_pos|variant|sw|sh)", key, re.I)
        ]
    )
    scheme = "https" if parsed.scheme.lower() == "http" else parsed.scheme.lower()
    return urlunparse(parsed._replace(scheme=scheme, query=query, fragment=""))


def _schema_image_dedupe_key(image_url: str) -> str:
    parsed = urlparse(image_url)
    if not parsed.hostname:
        return image_url.lower()
    path = re.sub(
        r"(?:[_-])?(?:\d{2,5}x\d{2,5}|x\d{2,5}|\d{2,5}x)(?=\.[a-z]{3,4}$)",
        "",
        parsed.path.lower(),
        flags=re.I,
    )
    path = re.sub(r"@(?:2x|3x)(?=\.[a-z]{3,4}$)", "", path, flags=re.I)
    return f"{parsed.hostname.lower()}{path}"


def _score_schema_image_url(image_url: str, product_name: str, source_url: str | None, index: int) -> int:
    text = unquote(image_url).lower()
    slug = _schema_image_slug(source_url) if source_url else ""
    product_tokens = _meaningful_entity_tokens(" ".join(value for value in (product_name, slug) if value))
    image_tokens = _meaningful_entity_tokens(text)
    overlap = [token for token in image_tokens if token in product_tokens]
    score = max(0, 24 - index * 2)
    if len(overlap) >= 3:
        score += 45
    elif len(overlap) >= 2:
        score += 35
    elif len(overlap) == 1:
        score += 10
    if source_url and _same_schema_image_host(image_url, source_url):
        score += 6
    if re.search(r"\b(?:pdp|product|detail|main|hero|carousel|gallery|packshot|pack-shot|thumbnail|thumb)\b", text, re.I):
        score += 8
    if _has_conflicting_commerce_type_token(text, product_name) and len(overlap) < 2:
        score -= 45
    if _is_likely_commerce_tile_image_url(text):
        score -= 30
    return score


def _is_low_quality_schema_image_url(image_url: str) -> bool:
    text = unquote(image_url).lower()
    sizes = [
        int(value)
        for match in re.finditer(r"(?:width|height|[?&]w|[?&]h)=([0-9]{1,4})|[_-]([0-9]{1,4})x([0-9]{1,4})(?=[_.-]|$)", text, re.I)
        for value in match.groups()
        if value is not None
    ]
    if any(0 < value <= 96 for value in sizes):
        return True
    return bool(
        re.search(
            r"\b(?:icons?|logos?|sprite|badge|star|rating|review|avatar|profile|swatch|payment|reward|loyalty|placeholder|spinner)\b",
            text,
            re.I,
        )
    )


def _is_likely_commerce_tile_image_url(value: str) -> bool:
    return bool(re.search(r"\b(?:related|recommend|you-may-also-like|upsell|cross-sell|collection|tile|card|grid)\b", value, re.I))


def _has_conflicting_commerce_type_token(value: str, product_name: str) -> bool:
    product_types = _commerce_type_tokens(product_name)
    return any(token not in product_types for token in _commerce_type_tokens(value))


def _commerce_type_tokens(value: str) -> list[str]:
    normalized = value.lower()
    patterns = (
        ("serum", r"\bserums?\b|세럼|美容液|セラム"),
        ("cream", r"\bcreams?\b|크림|クリーム"),
        ("cleanser", r"\bcleansers?\b|\bfoams?\b|클렌저|フォーム|クレンザー"),
        ("toner", r"\btoners?\b|\bwaters?\b|토너|化粧水"),
        ("essence", r"\bessences?\b|에센스"),
        ("mask", r"\bmasks?\b|마스크"),
        ("oil", r"\boils?\b|오일"),
        ("lotion", r"\blotions?\b|로션"),
    )
    return [name for name, pattern in patterns if re.search(pattern, normalized, re.I)]


def _meaningful_entity_tokens(value: str) -> list[str]:
    ignored = {
        "cdn", "shop", "files", "products", "product", "image", "images", "photo", "photos", "main", "detail",
        "hero", "gallery", "thumbnail", "thumb", "packshot", "pack", "shot", "webp", "jpeg", "jpg", "png", "format",
        "width", "height", "variant", "brand", "commerce", "asset", "assets", "static", "media", "original", "desktop",
        "mobile", "large", "small", "mini", "new", "the", "and", "with", "for",
    }
    tokens: list[str] = []
    for raw in re.sub(r"https?://|[/?#=&_.-]+", " ", value.lower()).split():
        token = re.sub(r"[^a-z0-9가-힣ぁ-んァ-ン一-龯]", "", raw, flags=re.I)
        if len(token) >= 4 and token not in ignored and token not in tokens:
            tokens.append(token)
    return tokens


def _schema_image_slug(value: str) -> str:
    parsed = urlparse(value)
    return next((part for part in reversed(parsed.path.split("/")) if part), "")


def _same_schema_image_host(left: str, right: str) -> bool:
    left_host, right_host = urlparse(left).hostname, urlparse(right).hostname
    return bool(left_host and right_host and left_host.removeprefix("www.") == right_host.removeprefix("www."))


def create_pdp_geo_content_html(sections: Mapping[str, Any], locale: str) -> str:
    # Retained API, while public HTML remains intentionally disabled in result artifacts.
    import html

    labels = {
        "ko-KR": ["상품명", "상품 설명", "핵심 정보", "효능/효과", "성분", "사용법", "FAQ"],
        "ja-JP": ["商品名", "商品説明", "主な情報", "ベネフィット", "成分", "使い方", "FAQ"],
    }.get(locale, ["Product name", "Product details", "Quick facts", "Benefits", "Ingredients", "How to use", "FAQ"])
    keys = ["productName", "description", "quickFacts", "benefits", "ingredients", "howToUse", "faq"]
    items: list[str] = []
    for index, (key, label) in enumerate(zip(keys, labels, strict=True)):
        value = clean_text(sections.get(key))
        if key in {"howToUse", "faq"} and not value:
            continue
        body = (
            "<ul>"
            + "".join(f"<li>{html.escape(line.lstrip('- ').strip())}</li>" for line in str(value).splitlines() if line)
            + "</ul>"
            if "\n" in str(value)
            else f"<p>{html.escape(str(value))}</p>"
        )
        items.append(
            f'\n    <div class="geo-content-accordion__item">\n      <button class="geo-content-accordion__trigger" type="button" aria-expanded="{"true" if index == 0 else "false"}">{html.escape(label)}</button>\n      <div class="geo-content-accordion__panel">{body}</div>\n    </div>'
        )
    return f'<div class="geo-content-accordion" data-locale="{locale}">' + "\n".join(items) + "\n</div>"


def is_citation_ready_prose(value: str) -> bool:
    text = clean_text(value)
    if not text or re.match(r"^(?:this|that|these|those|it|they|이|그|저)\b", text, re.I):
        return False
    if len(re.findall(r"(?:^|\s)[^\s:：]{1,16}\s*[:：]", text)) >= 2:
        return False
    return not bool(re.search(r"(?:사용\s*(?:전|후)|세정\s*(?:전|후))\s+(?:사용\s*(?:전|후)|세정\s*(?:전|후))", text))


def _build_graph(
    product: Mapping[str, Any],
    name: str,
    product_description: str,
    webpage_description: str,
    faq: Sequence[Mapping[str, Any]],
    usage: Sequence[str],
    locale: str,
    market: str,
    source_url: str | None,
    hints: Mapping[str, Any],
) -> list[dict[str, Any]]:
    base = source_url or f"urn:agentic-geo:pdp:{_slug(name)}"
    product_id, page_id, faq_id, howto_id, crumb_id = (
        f"{base}#{suffix}" for suffix in ("product", "webpage", "faq", "how-to-use", "breadcrumb")
    )
    targets = [item for item in as_list(hints.get("schemaTargets")) if isinstance(item, str)] or _DEFAULT_TARGETS
    if usage and "HowTo" not in targets and not as_list(hints.get("schemaTargets")):
        targets.append("HowTo")
    graph: list[dict[str, Any]] = []
    organization = _organization_schema(as_dict(hints.get("organization")))
    organization_id = clean_text(organization.get("@id")) if organization else ""
    if organization:
        graph.append(organization)
    breadcrumbs = [as_dict(item) for item in as_list(product.get("breadcrumbs"))]
    page_type = clean_text(hints.get("pageType")) or "ItemPage"
    if "WebPage" in targets:
        page: dict[str, Any] = {
            "@type": "WebPage" if page_type == "WebPage" else ["WebPage", page_type],
            "@id": page_id,
            "name": name,
            "description": webpage_description,
            "inLanguage": locale,
            "about": {"@id": product_id},
            "mainEntity": {"@id": product_id},
        }
        if source_url:
            page["url"] = source_url
        if clean_text(product.get("dateModified")):
            page["dateModified"] = clean_text(product.get("dateModified"))
        if breadcrumbs and "BreadcrumbList" in targets:
            page["breadcrumb"] = {"@id": crumb_id}
        parts = ([{"@id": faq_id}] if faq and "FAQPage" in targets else []) + (
            [{"@id": howto_id}] if usage and "HowTo" in targets else []
        )
        if parts:
            page["hasPart"] = parts
        graph.append(page)
    if "Product" in targets:
        # Insertion order is part of the public scriptTag wire artifact. Keep
        # this aligned with the retained createSchemaMarkup object literal:
        # identity, optional page linkage/identifiers, then description.
        item: dict[str, Any] = {"@type": "Product", "@id": product_id, "name": name}
        if clean_text(product.get("originalName")) and clean_text(product.get("originalName")) != name:
            item["alternateName"] = clean_text(product.get("originalName"))
        if source_url:
            item["url"] = source_url
        if "WebPage" in targets:
            item["mainEntityOfPage"] = {"@id": page_id}
        elif source_url:
            item["mainEntityOfPage"] = source_url
        for key in ("sku", "gtin"):
            if clean_text(product.get(key)):
                item[key] = clean_text(product.get(key))
        gtin = clean_text(product.get("gtin"))
        gtin_key = gtin_property_name(gtin) if gtin else None
        if gtin_key:
            item[gtin_key] = gtin
        item["description"] = product_description
        if clean_text(product.get("brand")):
            brand: dict[str, Any] = {"@type": "Brand", "name": clean_text(product.get("brand"))}
            # ``generate.ts`` uses nullish precedence: an explicit (including
            # empty) caller list controls the field, otherwise a first-party
            # PDP origin can ground the Brand identity without guessing a
            # retailer's identity.
            raw_same_as = hints.get("brandSameAs")
            same_as = (
                _valid_urls(as_list(raw_same_as))
                if raw_same_as is not None
                else _derive_brand_same_as_from_source_url(clean_text(product.get("brand")), source_url)
            )
            if same_as:
                brand["sameAs"] = same_as
            item["brand"] = brand
        category = _resolved_product_type(product)
        if category:
            item["category"] = _localized_category(category, locale)
        images = select_schema_images(product, name, source_url)
        if images:
            item["image"] = images
        offer = _variant_offers(product, locale, market, source_url) or _offer(product, locale, market, source_url, hints)
        if offer:
            for offer_node in offer if isinstance(offer, list) else [offer]:
                if organization_id:
                    offer_node["seller"] = {"@id": organization_id}
            item["offers"] = offer
        aggregate = _aggregate_rating(product)
        if aggregate:
            item["aggregateRating"] = aggregate
        reviews = _reviews(product)
        if reviews:
            item["review"] = reviews
        properties = published_product_attributes(_additional_properties(product, usage, locale))
        if properties:
            item["additionalProperty"] = properties
        graph.append(item)
    if faq and "FAQPage" in targets:
        graph.append(
            {
                "@type": "FAQPage",
                "@id": faq_id,
                "inLanguage": locale,
                "isPartOf": {"@id": page_id} if "WebPage" in targets else None,
                "about": {"@id": product_id},
                "mainEntity": [
                    {
                        "@type": "Question",
                        # A tag marker and a quotation mark are page typography,
                        # not words of the claim.  Every published surface drops
                        # them, so a question and an answer drop them too.
                        "name": publishable_public_copy(item["question"]),
                        "acceptedAnswer": {
                            "@type": "Answer",
                            "text": publishable_public_copy(item["answer"]),
                        },
                    }
                    for item in faq
                ],
            }
        )
    if usage and "HowTo" in targets:
        graph.append(
            {
                "@type": "HowTo",
                "@id": howto_id,
                "name": _howto_name(name, locale),
                "inLanguage": locale,
                "isPartOf": {"@id": page_id} if "WebPage" in targets else None,
                "about": {"@id": product_id},
                "step": [
                    {
                        "@type": "HowToStep",
                        "position": index + 1,
                        "name": _step_name(index, locale),
                        "text": publishable_public_copy(text),
                    }
                    for index, text in enumerate(usage)
                ],
            }
        )
    if breadcrumbs and "BreadcrumbList" in targets:
        graph.append(
            {
                "@type": "BreadcrumbList",
                "@id": crumb_id,
                "itemListElement": [
                    {
                        "@type": "ListItem",
                        "position": index + 1,
                        "name": clean_text(item.get("name")),
                        **({"item": clean_text(item.get("url"))} if clean_text(item.get("url")) else {}),
                    }
                    for index, item in enumerate(breadcrumbs)
                    if clean_text(item.get("name"))
                ],
            }
        )
    return _clean_json(graph)


def _product_name(product: Mapping[str, Any], _locale: str, _hints: Mapping[str, Any]) -> str:
    """Return the representative source entity, never a selected SKU label."""

    source_name = clean_text(product.get("name"))
    if not source_name:
        return "Untitled product"
    bracket_tokens = [
        clean_text(match.group(1))
        for match in re.finditer(r"\[([^\]]{1,36})\]", source_name)
        if clean_text(match.group(1))
    ]
    brand = clean_text(product.get("brand"))
    source_backed_brand = brand if any(_same_entity_token(token, brand) for token in bracket_tokens) else ""
    has_sku_qualifier = (
        any(_is_variant_or_commerce_token(token) for token in bracket_tokens)
        or bool(as_list(product.get("options")))
        or re.search(r"\b\d+(?:\.\d+)?\s*(?:ml|mL|g|oz|fl\.?\s*oz|매|개|입)\b", source_name) is not None
    )
    name = re.sub(r"\s+", " ", re.sub(r"\[[^\]]{1,36}\]", " ", source_name)).strip()
    if has_sku_qualifier:
        name = product_title_without_sku_qualifier(name)
    if not name:
        return source_name
    if source_backed_brand and not contains_entity_identity_phrase(name, source_backed_brand):
        name = f"{source_backed_brand} {name}"
    return clean_text(name)


def _is_variant_or_commerce_token(value: str) -> bool:
    return re.search(
        r"\d+(?:\.\d+)?\s*(?:ml|mL|g|oz|fl\.?\s*oz|매|개|입)|%|\+|[₩$€£¥]|"
        r"(?:^|[\s-])(?:set|kit|bundle|refill|mini|trial|sample|gift|limited|special|online|exclusive|new|best|sale)(?:$|[\s-])",
        value,
        re.IGNORECASE,
    ) is not None


def _entity_token(value: str) -> str:
    return "".join(character for character in clean_text(value).casefold() if character.isalnum())


def _same_entity_token(left: str, right: str) -> bool:
    return bool(_entity_token(left) and _entity_token(left) == _entity_token(right))




def _safe_product_category(value: object) -> str:
    category = clean_text(value)
    return category if category and len(category) <= 60 and _GENERIC_CATEGORY.fullmatch(category) is None else ""


def _resolved_product_type(product: Mapping[str, Any]) -> str:
    """Port the TypeScript category resolver without publishing generic labels."""

    category = _safe_product_category(product.get("category"))
    name_type = product_type_from_name(clean_text(product.get("name"))) or product_type_from_name(
        clean_text(product.get("originalName"))
    )
    if category and name_type and name_product_type_supersedes_category(category, name_type):
        return name_type
    return category or name_type or ""


def _is_rich_source_backed_product(product: Mapping[str, Any]) -> bool:
    """Whether the source provides enough separate facts for rich templates.

    The renderer keeps the compact fallback for sparse merchant feeds.  A
    labelled ingredient/full-INCI source or three independently supplied
    ingredients is enough to use the evidence-led selection layer below; this
    is deliberately a data shape gate, never an identity or fixture gate.
    """

    ingredients = [clean_text(value) for value in as_list(product.get("ingredients")) if clean_text(value)]
    source_texts = [clean_text(value) for value in as_list(product.get("sourceTexts")) if clean_text(value)]
    return len(ingredients) >= 3 or any(re.match(r"^(?:key\s+ingredients|전성분)\s*[:：]", value, re.I) for value in source_texts)


def _source_texts(product: Mapping[str, Any]) -> list[str]:
    """Return source prose while excluding normalizer's scalar echo values."""

    scalar_values = {
        clean_text(value).casefold()
        for value in (
            product.get("name"),
            product.get("originalName"),
            product.get("brand"),
            product.get("category"),
            *as_list(product.get("benefits")),
            *as_list(product.get("effects")),
            *as_list(product.get("ingredients")),
            *as_list(product.get("usage")),
            *as_list(product.get("options")),
        )
        if clean_text(value)
    }
    return [
        value
        for raw in as_list(product.get("sourceTexts"))
        if (value := clean_text(raw)) and value.casefold() not in scalar_values
    ]


def _rich_ingredients(product: Mapping[str, Any], locale: str) -> list[str]:
    """Keep source ingredient names in their supplied order for every category.

    Rich rendering is a data-density choice, never permission to rewrite a
    formula around a known product family, and never permission to publish as
    a formula what is not a name.  A short distinct selection keeps the schema
    readable while retaining source terminology.
    """

    return _named_source_ingredients(product, 5)


def _rich_benefits(product: Mapping[str, Any], locale: str) -> list[str]:
    """Keep source-stated outcomes instead of mapping them to skin-care labels.

    A source sentence such as ``Supports hair softness`` is a valid product
    fact. Mapping only known skin terms discarded it and encouraged unrelated
    category assumptions in downstream public fields.
    """

    semantic = as_dict(product.get("semanticFacts"))
    semantic_values = [
        *as_list(semantic.get("benefits")),
        *as_list(semantic.get("effects")),
    ]
    # Structured semantic roles are the normalized, provenance-preserving
    # channel.  Top-level effects may include a section heading or OCR-derived
    # echo, so use them only when the extractor did not provide any semantic
    # benefit/effect facts at all.
    values = semantic_values or [*as_list(product.get("benefits")), *as_list(product.get("effects"))]
    outcomes = _public_outcome_values(values, locale)
    if locale in {"en-US", "en-GB"}:
        product_type = _english_product_type(product, clean_text(product.get("name")))
        outcomes = [
            value for value in outcomes if not _english_benefit_is_product_descriptor(value, product_type)
        ]
    # Extraction commonly keeps both a short visual label and a fully
    # punctuated source sentence for the same Korean outcome.  They carry one
    # fact, not two fields' worth of content.  Collapse only terminal
    # presentational variants here; different benefits remain separate.
    selected: list[str] = []
    seen: set[str] = set()
    for outcome in outcomes:
        key = _benefit_content_key(outcome, locale)
        if not key or key in seen:
            continue
        seen.add(key)
        selected.append(outcome)
    return selected[:5]


def _benefit_content_key(value: str, locale: str) -> str:
    """Compare equivalent outcome labels without merging distinct source facts."""

    text = clean_text(value).rstrip(".。！？!?")
    if locale == "ko-KR":
        # OCR headings often omit a polite predicate while normalized source
        # prose adds ``제시합니다`` or ``합니다``.  Strip that display-only
        # ending so one benefit is not repeated as both a label and sentence.
        text = re.sub(
            r"(?:을|를|이|가)?\s*(?:제시|표방|제공|지원|도움)(?:합니다|됩니다|했습니다|한다)?$",
            "",
            text,
        )
        text = re.sub(r"(?:합니다|됩니다|입니다)$", "", text)
        # A visual heading may drop a Korean particle (``건조함 케어``)
        # while the normalized sentence retains it (``건조함을 케어``).
        # This is the same fact, so normalize only those terminal particles.
        return "".join(
            _normalize_description_match_token(token)
            for token in re.findall(r"[A-Za-z0-9]+|[가-힣]+", text.casefold())
        )
    return re.sub(r"[\W_]+", "", text).casefold()


def _secondary_rich_benefits(benefits: Sequence[str], primary: str, locale: str) -> list[str]:
    """Keep extra efficacy facts without restating the primary benefit verbatim."""

    primary_key = _benefit_content_key(primary, locale)
    return [
        benefit
        for benefit in benefits
        if _benefit_content_key(benefit, locale) and _benefit_content_key(benefit, locale) != primary_key
    ]


def _rich_public_benefit_sentences(product: Mapping[str, Any], locale: str) -> list[str]:
    """Give English source-benefit clauses a citation-ready product subject at every public field."""

    benefits = _rich_benefits(product, locale)
    if locale not in {"en-US", "en-GB"}:
        return benefits
    name = _product_name(product, locale, {})
    entity = _english_product_reference(name, clean_text(product.get("brand")))
    return _english_entity_benefit_sentences(entity, benefits, name, _english_product_type(product, name))


def _primary_rich_benefit(product: Mapping[str, Any], locale: str) -> str:
    values = _rich_public_benefit_sentences(product, locale)
    return values[0] if values else ""


def _rich_reported_details(product: Mapping[str, Any], locale: str) -> list[str]:
    if locale not in {"en-US", "en-GB"}:
        return []
    metrics = [clean_text(value) for value in as_list(product.get("metrics")) if clean_text(value)]
    claims = [as_dict(value) for value in as_list(as_dict(product.get("semanticFacts")).get("metricClaims"))]
    sources = [
        *metrics,
        *[
            clean_text(claim.get("sourceText")) or clean_text(claim.get("sentence"))
            for claim in claims
        ],
    ]
    values = [
        rendered
        for source in sources
        if source and (rendered := _published_metric_source_text(source, claims, locale))
    ]
    return _unique_texts(values)[:2]


def _is_safety_or_negative_audience_context(value: str) -> bool:
    """Keep direct cautions as safety facts, never reinterpret them as a customer target."""

    text = clean_text(value)
    return bool(
        re.search(
            r"\b(?:not\s+(?:recommended|suitable|intended)\s+for|avoid\s+(?:use|contact)|do\s+not\s+(?:use|swallow)|"
            r"keep\s+out\s+of\s+reach\s+of\s+children|patch\s*test|for\s+external\s+use\s+only|safety\s+test|"
            r"(?:clinically|dermatologically)\s+tested|irritation\s+test|discontinue\s+use|consult\s+(?:a|your)\s+"
            r"(?:doctor|physician))\b|"
            r"(?:사용(?:할)?\s*수\s*없|사용하지|권장하지|피해야|주의사항|외용으로만|패치\s*테스트|"
            r"피부\s*자극\s*(?:테스트|시험)|안전성\s*(?:테스트|시험)|피부과\s*테스트|임상\s*(?:테스트|시험)|"
            r"(?:논[-\s]?코메도제닉|non[-\s]?comedogenic)|사용\s*적합\s*테스트|"
            r"어린이의\s*손이\s*닿지\s*않는\s*곳|눈에\s*들어가지\s*않도록|먹지\s*마십시오|사용을\s*중지)",
            text,
            re.I,
        )
    )


def _has_explicit_korean_audience_relation(value: str, subject_pattern: str) -> bool:
    """Recognize an affirmative Korean audience relation, excluding a test's participant label."""

    text = clean_text(value)
    if not text or _is_safety_or_negative_audience_context(text):
        return False
    relation = r"(?:위한|적합(?:한)?|특화(?:된)?|맞춤(?:형)?|피부용|추천(?:됩니다|되|하는)?|권장(?:됩니다|되|하는)?)"
    return bool(
        re.search(rf"(?:{subject_pattern}).{{0,24}}{relation}", text)
        or re.search(rf"{relation}.{{0,24}}(?:{subject_pattern})", text)
        or re.search(rf"(?:{subject_pattern}).{{0,24}}대상\s*(?:고객|사용자|소비자)", text)
        or re.search(rf"(?:{subject_pattern}).{{0,24}}대상(?:으로)?\s*(?:개발|설계|제작|출시)", text)
    )


def _rich_target_customer(product: Mapping[str, Any], locale: str) -> str:
    if locale == "ko-KR":
        semantic_targets = [
            clean_text(value)
            for value in as_list(as_dict(product.get("semanticFacts")).get("skinTypes"))
            if clean_text(value) and not _is_safety_or_negative_audience_context(clean_text(value))
        ]
        source_values = [
            *(
                clean_text(value)
                for item in as_list(product.get("faq"))
                for value in (as_dict(item).get("question"), as_dict(item).get("answer"))
                if clean_text(value)
            ),
            *_source_texts(product),
            *semantic_targets,
        ]
        source = " ".join(value for value in source_values if not _is_safety_or_negative_audience_context(value))

        # OCR/source normalization can describe arbitrary audiences (for
        # example, dyed hair) rather than one of a small skin-care taxonomy.
        # Prefer typed values only when the page directly links them to an
        # affirmative target relation; preserve multiple directly paired
        # targets instead of silently dropping the second one.
        explicit_targets = [
            target
            for target in semantic_targets
            if _has_explicit_korean_audience_relation(source, re.escape(target))
        ]
        if len(explicit_targets) >= 2:
            return f"{' 또는 '.join(explicit_targets[:2])} 고객"
        if explicit_targets:
            return explicit_targets[0]

        def has_explicit_target(pattern: str) -> bool:
            return _has_explicit_korean_audience_relation(source, pattern)

        has_sensitive = has_explicit_target(r"민감(?:한|성)?(?:\s*피부)?")
        has_dry = has_explicit_target(r"건조(?:한|성)?\s*피부")
        if has_sensitive and has_dry:
            return "민감 피부 또는 건조 피부 고객"
        if has_sensitive:
            return "민감 피부 고객"
        if has_dry:
            return "건조 피부 고객"
        return ""
    return _english_target_customer(product)


def _rich_skin_type(product: Mapping[str, Any], locale: str) -> str:
    target = _rich_target_customer(product, locale)
    if locale == "ko-KR":
        return target.removesuffix(" 고객") if "피부" in target else ""
    return _english_recommended_skin_type(product)


def _description(
    product: Mapping[str, Any],
    name: str,
    locale: str,
    plan: Mapping[str, Any],
    kind: str,
    *,
    canonical_usage: Sequence[str] = (),
) -> str:
    plan_key = "productDescription" if kind == "product" else "webPageDescription"
    planned = as_dict(plan.get(plan_key))
    planned_text = clean_text(planned.get("text"))
    admitted_model_plan = plan.get("_admittedContentPlan") is True
    page_coverage_prose = (
        kind == "webpage"
        and _is_declarative_page_coverage_prose(planned_text, canonical_usage)
    )
    if (
        plan.get("mode") == "model"
        and planned.get("include") is True
        and (is_publishable_description_text(planned_text, locale) or page_coverage_prose)
        and not _description_contains_question(planned_text)
        and not (kind == "webpage" and _webpage_description_copies_how_to(planned_text, canonical_usage))
        and _description_has_citation_ready_entity_anchors(planned_text, product, name)
        and (
            admitted_model_plan
            or _is_source_bound_model_description(planned_text, product, name, kind)
        )
    ):
        # The planner's text has already passed source/evidence admission.  It
        # is the primary renderer input; deterministic role-ordered prose is a
        # fallback for a missing or rejected plan, not a second copy editor.
        return planned_text
    # A rejected or omitted model field is not authority to erase a public
    # schema surface.  Both Product and WebPage fall through to the same
    # source-backed deterministic renderer, which is the Python counterpart
    # to TypeScript's plannedDescriptionOrSource fallback.
    if locale in {"en-US", "en-GB", "ko-KR"}:
        source_grounded = (
            _source_grounded_webpage_description(product, name, locale)
            if kind == "webpage"
            else _source_grounded_product_description(product, name, locale)
        )
        if source_grounded:
            return source_grounded
    source = retain_publishable_description_sentences(product.get("description"), locale)
    benefit = next(
        (
            clean_text(item)
            for item in [*as_list(product.get("benefits")), *as_list(product.get("effects"))]
            if clean_text(item)
        ),
        "",
    )
    if source:
        return source
    if locale == "ko-KR":
        return f"{name} 제품입니다" + (f". {benefit}" if benefit else ".")
    if locale == "ja-JP":
        return f"{name}の商品です。" + benefit
    return f"{name} is a product." + (f" {benefit}" if benefit else "")


def _is_declarative_page_coverage_prose(text: str, canonical_usage: Sequence[str]) -> bool:
    """Allow admitted page-role prose without admitting a copied procedure.

    The usage classifier intentionally flags action words, but a model may use
    those words while declaring what the page covers.  This narrow exception
    is only for an evidence-admitted WebPage field, requires an explicit page
    role, and still rejects any sentence equivalent to a canonical HowTo row.
    """

    value = clean_text(text)
    if not value or _webpage_description_copies_how_to(value, canonical_usage):
        return False
    return bool(
        re.search(
            r"\b(?:page|PDP)\b[^.!?]{0,160}\b(?:covers?|details?|guidance|information)\b|"
            r"\b(?:product\s+details?|usage\s+guidance|application\s+guidance)\b",
            value,
            re.IGNORECASE,
        )
        or re.search(r"(?:페이지|제품\s*소개).{0,120}(?:안내|정보|사용법|순서)", value)
    )


def _description_has_citation_ready_entity_anchors(
    text: str,
    product: Mapping[str, Any],
    name: str,
) -> bool:
    """Require an approved narrative to establish its entity before pronouns.

    The opening sentence is the meaningful citation boundary for a coherent
    multi-sentence model narrative.  Once it names the product and brand, a
    following natural ``The formula`` sentence can retain the plan's fluent
    wording; requiring mechanical entity repetition around every ingredient
    would unnecessarily discard an evidence-admitted description.
    """

    sentences = [clean_text(sentence) for sentence in re.split(r"(?<=[.!?。！？])\s+|\n+", text) if clean_text(sentence)]
    if not sentences or not name:
        return False
    opening = sentences[0]
    if not contains_entity_identity_phrase(opening, name):
        return False
    brand = clean_text(product.get("brand"))
    return not brand or contains_entity_identity_phrase(name, brand) or contains_entity_identity_phrase(opening, brand)


def _webpage_description_copies_how_to(text: str, canonical_usage: Sequence[str]) -> bool:
    """Keep an approved HowTo instruction out of a page-level description.

    The WebPage field may state that a page covers application guidance, but
    it must not duplicate an imperative HowTo row.  Compare whole rendered
    sentences so a source-backed product narrative that merely mentions use
    is not discarded.
    """

    usage_keys = {
        re.sub(r"[^\w]+", " ", clean_text(step).casefold()).strip()
        for step in canonical_usage
        if clean_text(step)
    }
    if not usage_keys:
        return False
    for sentence in re.split(r"(?<=[.!?。！？])\s+|\n+", text):
        normalized = re.sub(r"[^\w]+", " ", clean_text(sentence).casefold()).strip()
        if normalized and any(
            normalized == usage or normalized in usage or usage in normalized for usage in usage_keys
        ) and is_procedural_usage_instruction(sentence):
            return True
    return False


def _description_contains_question(text: str) -> bool:
    """Keep a plan's FAQ-shaped source prompt out of declarative descriptions."""

    return any(
        sentence.rstrip().endswith(("?", "？"))
        or re.match(r"^(?:is|are|was|were|do|does|did|can|could|should|would|will|has|have)\b", sentence, re.I)
        for sentence in re.split(r"(?<=[.!?。！？])\s+|\n+", text)
        if clean_text(sentence)
    )


def _is_source_bound_model_description(text: str, product: Mapping[str, Any], name: str, kind: str) -> bool:
    """Accept natural plan prose only when it retains source-role anchors.

    ``generate_pdp_geo_artifacts`` is also a public direct-rendering helper,
    so it can receive a hand-assembled ``mode=model`` mapping that never went
    through the planner's evidence gate.  This small defensive check preserves
    the existing source fallback for those mappings without rewriting a plan
    that demonstrably covers source roles in their natural narrative form.
    """

    positions = _model_description_role_positions(text, product, name)
    if not positions:
        return False
    # Product descriptions are entity narratives.  Their source roles must
    # remain in the source order, while a WebPage description may add a page
    # framing phrase around the same ordered coverage.
    return kind != "product" or positions == sorted(positions)


def _model_description_role_positions(text: str, product: Mapping[str, Any], name: str) -> list[int]:
    identities = set(_description_match_tokens(name)) | set(_description_match_tokens(clean_text(product.get("brand"))))
    semantic = as_dict(product.get("semanticFacts"))
    metrics: list[object] = [
        *as_list(product.get("metrics")),
        *(
            value
            for value in as_list(product.get("sourceTexts"))
            if re.search(r"\d", clean_text(value))
        ),
    ]
    for raw in as_list(semantic.get("metricClaims")):
        claim = as_dict(raw)
        metrics.extend(
            value
            for value in (claim.get("sourceText"), claim.get("sentence"))
            if clean_text(value)
        )
    reviews = as_dict(product.get("reviews"))
    review_values: list[object] = [
        *as_list(reviews.get("keywords")),
        *(as_dict(item).get("body") for item in as_list(reviews.get("items"))),
    ]
    roles = (
        ("description", [product.get("description")]),
        ("formula", as_list(product.get("ingredients"))),
        ("benefit", [*as_list(product.get("benefits")), *as_list(product.get("effects"))]),
        ("usage", as_list(product.get("usage"))),
        ("metric", metrics),
        ("review", review_values),
    )
    return [
        position
        for _, values in roles
        if (position := _source_role_position(text, values, identities)) is not None
    ]


def _source_role_position(text: str, values: Sequence[object], identities: set[str]) -> int | None:
    text_tokens = _description_tokens_with_positions(text)
    if not text_tokens:
        return None
    positions_by_token: dict[str, list[int]] = {}
    for token, position in text_tokens:
        positions_by_token.setdefault(token, []).append(position)
    candidates: list[tuple[float, int, int]] = []
    for raw in values:
        source_tokens = [token for token in _description_match_tokens(clean_text(raw)) if token not in identities]
        if not source_tokens:
            continue
        distinct_source_tokens = set(source_tokens)
        matched_tokens = distinct_source_tokens & set(positions_by_token)
        # One-token source atoms (for example, ``Ceramide``) are valid facts;
        # longer facts need two distinct anchors so a product name alone does
        # not make arbitrary prose look evidence-bound.
        if len(matched_tokens) < min(2, len(distinct_source_tokens)):
            continue
        earliest = min(position for token in matched_tokens for position in positions_by_token[token])
        # A role can have multiple source values. Prefer the candidate with
        # the strongest token coverage rather than an incidental earlier
        # overlap (for example, ``dry skin`` from an effect over the plan's
        # complete ``supports hydration`` benefit phrase).
        candidates.append((len(matched_tokens) / len(distinct_source_tokens), len(matched_tokens), -earliest))
    return -max(candidates)[2] if candidates else None


def _description_match_tokens(value: str) -> list[str]:
    return [token for token, _ in _description_tokens_with_positions(value)]


def _description_tokens_with_positions(value: str) -> list[tuple[str, int]]:
    tokens: list[tuple[str, int]] = []
    for match in re.finditer(r"[A-Za-z0-9]+|[가-힣]+", value.casefold()):
        token = _normalize_description_match_token(match.group())
        if token and token not in {"a", "an", "and", "for", "from", "is", "of", "or", "the", "to", "with"}:
            tokens.append((token, match.start()))
    return tokens


def _normalize_description_match_token(token: str) -> str:
    if re.fullmatch(r"[a-z0-9]+", token):
        if len(token) > 5 and token.endswith("ies"):
            return f"{token[:-3]}y"
        if len(token) > 5 and token.endswith("ing"):
            return token[:-3]
        if len(token) > 4 and token.endswith("es"):
            return token[:-2]
        if len(token) > 3 and token.endswith("s"):
            return token[:-1]
        return token
    for suffix in ("으로부터", "에게서는", "에서는", "으로", "에게", "입니다", "합니다", "습니다", "은", "는", "이", "가", "을", "를", "와", "과", "의", "에", "로", "도"):
        if len(token) > len(suffix) + 1 and token.endswith(suffix):
            return token[: -len(suffix)]
    return token


def _source_grounded_product_description(product: Mapping[str, Any], name: str, locale: str) -> str:
    """Compose an approved Product narrative from source-role buckets only.

    The content plan controls publication, while this deterministic renderer
    controls the role order.  A missing role simply contributes no sentence;
    it is never padded with inferred copy.
    """

    if locale in {"en-US", "en-GB"}:
        return _english_source_grounded_product_description(product, name, locale)
    if locale == "ko-KR":
        return _korean_source_grounded_product_description(product, name)
    return ""


def _source_grounded_webpage_description(product: Mapping[str, Any], name: str, locale: str) -> str:
    """Render approved page-level coverage from the same source-role buckets.

    Page copy describes what a visitor can learn on the page; it is intentionally
    complete when source facts exist, while Product copy describes the item
    itself.  Both routes are deterministic so an approved plan cannot turn a
    missing source bucket into invented explanatory prose.

    Usage is not part of either description.  The HowTo node carries the source
    procedure, and a description that also announces the steps spends a sentence
    to say that another node exists.
    """

    if locale in {"en-US", "en-GB"}:
        return _english_source_grounded_webpage_description(product, name, locale)
    if locale == "ko-KR":
        return _korean_source_grounded_webpage_description(product, name)
    return ""


def _english_source_description_supplies_identity(source_description: str, entity: str, product_type: str) -> bool:
    """Recognize a direct source identity before adding the same generic lead.

    The entity must be present exactly as the renderer would name it.  That
    keeps the structured brand/name visible when a source only names the
    product incompletely, while avoiding a repeated ``is a <type>`` sentence
    when the source already supplies the complete identity fact.
    """

    if not source_description or not entity or not product_type:
        return False
    identity_pattern = (
        rf"\b{re.escape(entity)}\s+(?:is|was|are|were)\s+(?:an?|the)\s+"
        rf"(?:[A-Za-z][A-Za-z'-]*\s+){{0,3}}{re.escape(product_type)}\b"
    )
    return re.search(identity_pattern, source_description, re.I) is not None


def _publishable_english_source_description(value: str) -> str:
    """Keep source facts while withholding command-style marketing copy from public prose."""

    return retain_publishable_description_sentences(value, "en-US")


def _english_identity_lead(
    entity: str, product_type: str, customer_context: Sequence[str]
) -> str:
    """Name the product form; audience facts remain separate, source-preserving sentences."""

    return f"{entity} is {_indefinite_article(product_type)} {product_type}."


def _english_named_source_description(
    entity: str,
    name: str,
    source_description: str,
    product_type: str,
) -> str:
    """Turn a terse, sourced descriptor into a useful named product sentence.

    A sparse PDP often supplies a noun phrase such as ``Daily hydration cream
    for dry skin.``  Repeating only ``<product> is a cream`` discards that
    useful context and reads as a category tautology.  Keep an already named
    source sentence verbatim; otherwise, introduce only a direct noun-phrase
    descriptor with the structured product identity.  Other source wording is
    left untouched rather than being forced into an ungrammatical frame.
    """

    source = clean_text(source_description)
    if not source:
        return ""
    if _is_safety_or_negative_audience_context(source):
        if re.match(r"^not\s+recommended\s+for\s+", source, re.I):
            return f"{entity} is {source[:1].lower()}{source[1:]}"
        if re.match(r"^for\s+external\s+use\s+only", source, re.I):
            return f"{entity} is {source[:1].lower()}{source[1:]}"
        if name and re.search(re.escape(name), source, re.I):
            return _english_source_description_with_entity_subject(entity, name, source) or source
        return f"Safety information for {entity}: {source}"
    if _english_source_description_supplies_identity(source, entity, product_type):
        return source
    generic_subject = _english_source_description_with_generic_subject(entity, source, product_type)
    if generic_subject:
        return generic_subject
    named_source = _english_source_description_with_entity_subject(entity, name, source)
    if named_source:
        return named_source
    if name and contains_entity_identity_phrase(source, name):
        return source
    phrase = source.rstrip(".。！？!? ")
    # A direct source predicate may omit the product subject (for example,
    # ``Detangles wet hair``). Adding only the structured entity keeps that
    # source fact grammatically complete and citation-ready without creating
    # a new ingredient/effect relationship or recommendation.  This checks
    # grammatical shape rather than maintaining a marketing-verb allowlist.
    if english_subjectless_predicate(phrase):
        return f"{entity} {_lowercase_initial(phrase)}."
    solution = re.match(r"(?:a\s+)?solution\s+for\s+(?P<detail>.+)", phrase, re.IGNORECASE)
    if solution is not None:
        return f"{entity} is a solution for {clean_text(solution.group('detail'))}."
    if _english_description_is_nominal_service_phrase(phrase):
        return f"{entity} offers {_lowercase_initial(phrase)}."
    if not _english_description_is_noun_phrase(phrase, product_type):
        # A direct clause is retained verbatim unless we can safely attach the
        # product as its grammatical subject.  Never force arbitrary prose
        # into ``is described with <clause>``, which produces malformed copy.
        return source
    if phrase[:1].isupper() and not phrase[:2].isupper():
        phrase = f"{phrase[:1].lower()}{phrase[1:]}"
    if re.match(r"^(?:a|an)\b", phrase, re.IGNORECASE):
        # A source-led noun phrase becomes a natural product sentence once its
        # structured identity is supplied.  ``is described as A …`` is both
        # grammatically awkward and needlessly distances the reader from the
        # source statement.
        return f"{entity} is {_lowercase_initial(phrase)}."
    if not re.match(r"^(?:a|an|the)\b", phrase, re.IGNORECASE):
        phrase = f"{_indefinite_article(phrase)} {phrase}"
    return f"{entity} is described as {phrase}."


def _english_source_description_with_entity_subject(entity: str, name: str, source: str) -> str:
    """Add a structured brand only to the leading source product subject."""

    if not entity or not name or entity.casefold() == name.casefold():
        return ""
    subject = re.match(rf"{re.escape(name)}(?=\s|[,.;:!?]|$)", source, re.IGNORECASE)
    if subject is None:
        return ""
    return f"{entity}{source[subject.end():]}"


def _english_source_description_with_generic_subject(entity: str, source: str, product_type: str) -> str:
    """Replace a source's generic product subject with the citation-ready entity.

    The pattern is driven by the resolved input product type rather than a
    category allowlist.  It also recognizes product-anaphoric formula and
    system subjects, so a source opening such as ``This powerful formula``
    can introduce the named product without first adding a tautological
    ``<product> is a serum`` sentence.
    """

    if not entity or not product_type or product_type == "product":
        return ""
    subject = re.match(
        rf"(?:this|the)\s+(?:[A-Za-z0-9™®&+/'-]+\s+){{0,3}}(?:{re.escape(product_type)}|product|item|formula|system)(?=\s|[,.;:!?])",
        source,
        re.IGNORECASE,
    )
    return f"{entity}{source[subject.end():]}" if subject is not None else ""


def _english_description_is_noun_phrase(value: str, product_type: str) -> bool:
    """Accept only a short source noun phrase that names the resolved product form."""

    if not value or not product_type or product_type == "product":
        return False
    return re.fullmatch(
        rf"(?:(?:an?|the)\s+)?(?:[A-Za-z0-9™®&+/'-]+\s+){{0,7}}{re.escape(product_type)}"
        r"(?:\s+(?:(?:for|with|of|that|which)\s+|"
        r"[A-Za-z][A-Za-z'/-]*(?:ed|ing)\s+(?:by|with|for|from|of|in|to)\s+)[^.!?。！？]+)?",
        value,
        re.IGNORECASE,
    ) is not None


def _english_description_is_nominal_service_phrase(value: str) -> bool:
    """Recognize a short non-clausal descriptor such as ``Gentle cleansing for dry hair``.

    This is a grammatical shape, not a product-category allowlist: a compact
    nominal or gerund phrase with an explicit complement can safely follow
    ``<brand> <product> offers``.  Complete clauses and imperatives stay on
    their existing source-faithful paths instead of receiving a fabricated
    subject frame.
    """

    if english_subjectless_predicate(value):
        return False
    return re.fullmatch(
        r"(?:[A-Za-z][A-Za-z'/-]*\s+){0,6}[A-Za-z][A-Za-z'/-]*"
        r"(?:ing|tion|ment|ness|ity|ance|ence|ship|hood)\s+(?:for|with|without|of)\s+[^.!?。！？]+",
        clean_text(value),
        re.IGNORECASE,
    ) is not None




def _english_entity_customer_context(entity: str, sentence: str) -> str:
    """Give a direct source audience/concern sentence its product subject without adding a new claim."""

    value = clean_text(sentence).rstrip(".。！？")
    audience = re.match(r"works?\s+best\s+for\s+(?P<target>.+)", value, re.IGNORECASE)
    if audience is not None:
        return f"{entity} works best for {clean_text(audience.group('target'))}."
    concern = re.match(r"(?:a\s+)?solution\s+for\s+(?P<concern>.+)", value, re.IGNORECASE)
    if concern is not None:
        return f"{entity} is a solution for {clean_text(concern.group('concern'))}."
    return sentence


def _english_benefit_restates_published_copy(sentence: str, entity: str, published: Sequence[str]) -> bool:
    """Return whether a composed benefit repeats an outcome the copy already states.

    The composition stage attributes each outcome to the ingredient that
    produces it.  Restating one of those outcomes afterwards as a bare product
    claim tells the reader the same thing twice, and the second telling carries
    less, because it has dropped the ingredient that explained it.  What decides
    is the outcome a sentence names rather than the verb carrying it: a page
    that says an ingredient supports the skin barrier has already answered
    whether the product strengthens it.

    Only the renderer's own ``<product> <predicate> <outcome>`` frame is read
    this way.  A source sentence keeps its own subject and says something the
    page states in its own words, so it is never the restatement.
    """

    prefix = f"{entity} "
    if not sentence.startswith(prefix):
        return False
    tokens = [token.casefold() for token in word_tokens(sentence[len(prefix) :])]
    outcome = [token for token in tokens[1:] if token not in ENGLISH_FUNCTION_WORDS]
    if not outcome:
        return False
    stated = {token.casefold() for text in published for token in word_tokens(text)}
    return all(token in stated for token in outcome)


def _english_source_grounded_product_description(product: Mapping[str, Any], name: str, locale: str) -> str:
    product_type = _english_product_type(product, name)
    entity = _english_product_reference(name, clean_text(product.get("brand")))
    source_description = _publishable_english_source_description(clean_text(product.get("description")))
    customer_context = _english_customer_context_sentences(product)
    ingredients = _source_copy_ingredients(product)
    linked_formula = _source_grounded_ingredient_effect_sentences(product, entity, locale)
    benefits = _source_copy_benefits(product, locale)
    metrics = _qualified_metric_sentences(product, locale)
    review_sentence = _public_review_sentence(product, name, locale)
    parts: list[str] = []
    named_source_description = _english_named_source_description(entity, name, source_description, product_type)
    if not contains_entity_identity_phrase(named_source_description, entity):
        parts.append(_english_identity_lead(entity, product_type, customer_context))
    _append_distinct_source_sentence(parts, named_source_description)
    for sentence in customer_context:
        if _same_source_sentence(sentence, source_description):
            continue
        _append_distinct_source_sentence(parts, _english_entity_customer_context(entity, sentence))
    # The English chain states the formula as the outcome's purpose ("formulated
    # with X to support Y"), which attributes the outcome to the ingredients.
    # A page that lists an ingredient and states a benefit separately has not
    # said that, so the Product description keeps them as the separate facts
    # they are and lets the source's own linking sentences carry any relation.
    # Korean joins the same two facts by coordination ("...을 포함하고 ...을
    # 돕습니다"), which asserts both of the product without attributing either
    # to the other, so that locale composes the joined sentence.
    if ingredients:
        # Reuse the resolved brand/product entity for the composition anchor.
        # This is identity-only context around an independently sourced list;
        # it lets a citation retain the product and brand without changing a
        # formula fact into an ingredient-to-benefit claim.
        parts.append(f"{entity} includes {_format_list(ingredients, locale)}.")
    for sentence in linked_formula:
        _append_distinct_source_sentence(parts, sentence)
    for sentence in _english_entity_benefit_sentences(entity, benefits, name, product_type):
        if _english_benefit_restates_published_copy(sentence, entity, parts):
            continue
        _append_distinct_source_sentence(parts, sentence)
    for statement in _public_safety_statements(product, locale):
        _append_distinct_source_sentence(parts, statement)
    parts.extend(metrics)
    if review_sentence:
        parts.append(review_sentence)
    return " ".join(_shorten_repeated_entity_mentions(parts, entity, name))


def _english_source_grounded_webpage_description(product: Mapping[str, Any], name: str, locale: str) -> str:
    product_type = _english_product_type(product, name)
    entity = _english_product_reference(name, clean_text(product.get("brand")))
    source_description = _publishable_english_source_description(clean_text(product.get("description")))
    customer_context = _english_customer_context_sentences(product)
    ingredients = _source_copy_ingredients(product)
    benefits = _source_copy_benefits(product, locale)
    metrics = _qualified_metric_sentences(product, locale)
    metric = metrics[0] if metrics else ""
    review_sentence = _public_review_sentence(product, name, locale)
    overview = _english_page_coverage_overview(
        product, entity, product_type, customer_context, ingredients, benefits, metric, review_sentence, locale
    )
    parts: list[str] = []
    if not source_description:
        parts.append(_english_identity_lead(entity, product_type, customer_context))
    _append_distinct_source_sentence(
        parts,
        _english_named_source_description(entity, name, source_description, product_type),
    )
    # A source sentence about the customer is what the page itself says, and it
    # is published as the page wrote it.
    audience_published = False
    for sentence in customer_context:
        if _same_source_sentence(sentence, source_description):
            continue
        before = len(parts)
        _append_distinct_source_sentence(parts, _english_entity_customer_context(entity, sentence))
        audience_published = audience_published or len(parts) > before
    # Only a bare outcome can close a chain: a benefit the source states as a
    # whole sentence has its own predicate and stays a sentence of its own.
    chain_benefit = next(
        (
            value
            for raw in benefits
            if (value := clean_text(raw).rstrip(".")) and not is_complete_sentence(clean_text(raw))
        ),
        "",
    )
    # A page states its audience once, in the words the source used.  Where a
    # source sentence already published it, the chain opens on the composition
    # instead -- a typed audience atom is often narrower than the sentence
    # ("normal skin" beside "normal, dry, combination, and oily skin types"),
    # and stating the narrower one beside it would assert a different audience.
    chain_audience = "" if audience_published else _rich_target_customer(product, locale)
    # The source description can state the audience too.  Either way a page
    # states it once, so the chain opens on the composition when it is already
    # on the page.
    if chain_audience and any(chain_audience.casefold() in part.casefold() for part in [overview, *parts]):
        chain_audience = ""
    chained = _english_page_scope_product_sentence(
        entity, product_type, chain_audience, ingredients, chain_benefit, locale
    )
    if chained and not _english_benefit_restates_published_copy(chained, entity, [overview, *parts]):
        _append_distinct_source_sentence(parts, chained)
        remaining = [raw for raw in benefits if clean_text(raw).rstrip(".") != chain_benefit]
    else:
        if ingredients:
            parts.append(f"{entity} includes {_format_list(ingredients, locale)}.")
        remaining = list(benefits)
    for sentence in _english_entity_benefit_sentences(entity, remaining, name, product_type):
        if _english_benefit_restates_published_copy(sentence, entity, [overview, *parts]):
            continue
        _append_distinct_source_sentence(parts, sentence)
    parts.extend(metrics)
    # The offer closes the page's own facts, before the reader is handed the
    # words of other customers.  A review is the last thing a description says
    # because nothing the page states follows it.
    offer_sentence = _page_offer_sentence(entity, product, locale)
    if offer_sentence:
        parts.append(offer_sentence)
    if review_sentence:
        parts.append(review_sentence)
    if parts and _names_a_specific_target_customer(_page_overview_audience(product, locale), locale):
        if _page_overview_already_states(overview, parts[0], entity, name):
            parts.pop(0)
    return " ".join([overview, *_shorten_repeated_entity_mentions(parts, entity, name)])


def _korean_source_grounded_product_description(product: Mapping[str, Any], name: str) -> str:
    product_type = _localized_category(_resolved_product_type(product), "ko-KR") or "제품"
    entity = korean_product_reference(name, clean_text(product.get("brand")))
    source_description = retain_publishable_description_sentences(product.get("description"), "ko-KR")
    named_source_description = _korean_named_source_description(entity, name, source_description, product_type)
    target_sentence = _direct_target_source_sentence(product, "ko-KR")
    ingredients = _source_copy_ingredients(product)
    linked_formula = _source_grounded_ingredient_effect_sentences(product, entity, "ko-KR")
    benefits = _source_copy_benefits(product, "ko-KR")
    metrics = _qualified_metric_sentences(product, "ko-KR")
    review_sentence = _public_review_sentence(product, name, "ko-KR")
    opening, opening_states_audience = _korean_identity_opening(
        product, entity, product_type, named_source_description
    )
    parts: list[str] = []
    # A product description opens on who the product is for.  The source's own
    # marketing line ("클렌징 중에도 … #터치리스클렌저") says the same thing in the
    # page's voice, so publishing both gives the reader the same fact twice and
    # spends the opening -- the sentence an answer engine is most likely to
    # lift -- on the page's phrasing instead of the buyer's question.  Where no
    # audience is stated, the source line is what the product has to open on.
    direct_audience = _korean_direct_audience_sentence(product, entity, product_type)
    # A line the page tagged is a slogan, and a slogan is not the product's own
    # statement of what it is: it repeats the customer in the page's phrasing
    # ("클렌징 중에도 자극 받는 민감피부엔 … #터치리스클렌저") and then the audience
    # has to be stated again below.  Opening on the typed audience says it once,
    # in the product's voice, and spends the sentence an answer engine is most
    # likely to lift on the buyer's own question.  A plain source statement is
    # not a slogan and keeps its place.
    source_is_a_tagged_slogan = bool(
        PUBLIC_COPY_TAG_MARKER.search(clean_text(product.get("description")))
    )
    if not (source_is_a_tagged_slogan and direct_audience):
        _append_distinct_source_sentence(parts, opening)
        if not _same_source_sentence(named_source_description, opening):
            _append_distinct_source_sentence(parts, named_source_description)
        if not opening_states_audience and not _same_source_sentence(target_sentence, source_description):
            # A product entity states who it is for.  Where the page only
            # reports that it is recommended -- "…추천된다고 안내합니다" -- the
            # product description would be quoting the page about itself, which
            # is the page's own voice and belongs to WebPage.description.  The
            # typed audience the same page recorded says it directly instead.
            if direct_audience and _korean_attributes_rather_than_states(target_sentence):
                target_sentence = direct_audience
            _append_distinct_source_sentence(
                parts, _korean_source_sentence_about_the_entity(entity, target_sentence)
            )
    else:
        # The source's line is a marketing headline, not a statement of the
        # customer ("클렌징 중에도 … #터치리스클렌저").  Opening on it spends the
        # sentence an answer engine is most likely to lift on the page's
        # phrasing, and then the audience has to be said again below.  The
        # typed audience the same page recorded opens instead, and the headline
        # is not published as a second sentence saying the same thing.
        _append_distinct_source_sentence(parts, direct_audience)
    # What the product is made of and what it does for the customer are one
    # thought, not two: a buyer reads the formula in order to learn the
    # outcome.  Stating the ingredients and then the outcome as unconnected
    # sentences makes the reader supply the connection, and it spends two
    # sentences on one fact.  The relation published here is the product's, not
    # any single ingredient's -- the page states both of this product, so the
    # sentence says the product carries these ingredients and does this, which
    # is exactly what the page states and no more.
    chain_benefit = next(
        (
            value
            for raw in benefits
            if (value := clean_text(raw).rstrip(".。！？")) and not is_korean_complete_sentence(clean_text(raw))
        ),
        "",
    )
    chained = (
        _korean_page_scope_product_sentence(entity, product_type, "", ingredients, chain_benefit)
        if ingredients and chain_benefit
        else ""
    )
    if chained and not _korean_benefit_restates_published_copy(chained, entity, parts):
        parts.append(chained)
        remaining = [raw for raw in benefits if clean_text(raw).rstrip(".。！？") != chain_benefit]
    else:
        if ingredients:
            parts.append(_korean_formula_sentence(entity, ingredients))
        remaining = list(benefits)
    for sentence in linked_formula:
        _append_distinct_source_sentence(parts, sentence)
    # An account of each ingredient is what the benefit that follows rests on,
    # so the benefit closes the account rather than opening a new topic.
    connective = "이처럼 " if linked_formula or chained else ""
    for sentence in _korean_entity_benefit_sentences(entity, remaining, _korean_source_corpus(product)):
        if _korean_benefit_restates_published_copy(sentence, entity, parts):
            continue
        _append_distinct_source_sentence(parts, f"{connective}{sentence}")
        connective = ""
    for statement in _public_safety_statements(product, "ko-KR"):
        _append_distinct_source_sentence(parts, statement)
    parts.extend(metrics)
    if review_sentence:
        parts.append(review_sentence)
    return " ".join(_shorten_repeated_entity_mentions(parts, entity, name))


def _korean_source_grounded_webpage_description(product: Mapping[str, Any], name: str) -> str:
    entity = korean_product_reference(name, clean_text(product.get("brand")))
    product_type = _localized_category(_resolved_product_type(product), "ko-KR") or "제품"
    source_description = retain_publishable_description_sentences(product.get("description"), "ko-KR")
    named_source_description = _korean_named_source_description(
        entity, name, source_description, product_type
    )
    target_sentence = _direct_target_source_sentence(product, "ko-KR")
    ingredients = _source_copy_ingredients(product)
    benefits = _source_copy_benefits(product, "ko-KR")
    metrics = _qualified_metric_sentences(product, "ko-KR")
    metric = metrics[0] if metrics else ""
    review_sentence = _public_review_sentence(product, name, "ko-KR")
    overview = _korean_page_coverage_overview(
        product,
        entity,
        name,
        product_type,
        target_sentence,
        ingredients,
        benefits,
        metric,
        _has_attributed_public_review_content(product),
    )
    opening, opening_states_audience = _korean_identity_opening(
        product, entity, product_type, named_source_description
    )
    parts: list[str] = []
    _append_distinct_source_sentence(parts, opening)
    if not _same_source_sentence(named_source_description, opening):
        _append_distinct_source_sentence(parts, named_source_description)
    # A page summarises, so who it is for, what it carries, and what that does
    # are one account rather than three field summaries in a row.  The product
    # description states them separately because it is the detailed one.
    # Only a bare outcome can close the chain.  A benefit the source already
    # states as a whole sentence has its own predicate, and folding it into a
    # clause would give the sentence two -- so it stays a sentence of its own.
    audience_published = opening_states_audience
    if not opening_states_audience and not _same_source_sentence(target_sentence, source_description):
        audience_sentence = _korean_source_sentence_about_the_entity(entity, target_sentence)
        if audience_sentence:
            _append_distinct_source_sentence(parts, audience_sentence)
            audience_published = True
    chain_benefit = next(
        (
            value
            for raw in benefits
            if (value := clean_text(raw).rstrip(".。！？"))
            and not _looks_like_korean_benefit_clause(value)
            # A benefit an already-published sentence states is not restated in
            # the chain; the reader would be told one thing twice.
            and not any(value in published for published in [overview, *parts])
        ),
        "",
    )
    chained = _korean_page_scope_product_sentence(
        entity,
        product_type,
        "" if audience_published else _rich_target_customer(product, "ko-KR"),
        ingredients,
        chain_benefit,
    )
    if chained and not _korean_benefit_restates_published_copy(chained, entity, [overview, *parts]):
        _append_distinct_source_sentence(parts, chained)
        remaining = [raw for raw in benefits if clean_text(raw).rstrip(".。！？") != chain_benefit]
    else:
        if ingredients:
            parts.append(_korean_formula_sentence(entity, ingredients))
        remaining = list(benefits)
    for sentence in _korean_entity_benefit_sentences(entity, remaining, _korean_source_corpus(product)):
        if _korean_benefit_restates_published_copy(sentence, entity, [overview, *parts]):
            continue
        _append_distinct_source_sentence(parts, sentence)
    # Usage belongs to HowTo, which carries the source's own count and order.
    # A page description that announced the steps again would state the
    # procedure twice, in a shape that is no longer ordered -- so the page
    # closes on its own facts: what was measured, what it costs, and last what
    # other customers said, because nothing the page states follows a review.
    parts.extend(metrics)
    offer_sentence = _page_offer_sentence(entity, product, "ko-KR")
    if offer_sentence:
        parts.append(offer_sentence)
    if review_sentence:
        parts.append(review_sentence)
    if parts and _names_a_specific_target_customer(_page_overview_audience(product, "ko-KR"), "ko-KR"):
        if _page_overview_already_states(overview, parts[0], entity, name):
            parts.pop(0)
    return " ".join([overview, *_shorten_repeated_entity_mentions(parts, entity, name)])


def _shorten_repeated_entity_mentions(sentences: Sequence[str], entity: str, name: str) -> list[str]:
    """Name the brand once, then let the product name carry the rest.

    A reader meets the product under its full name and knows it after that.
    Repeating the brand in front of every sentence reads as a filled-in
    template rather than as prose, and it spends on repetition the room a
    description has for what the page actually says.  Every later mention still
    names the product, so no sentence loses the entity it asserts something of.
    """

    if not entity or not name or entity == name:
        return list(sentences)
    # An attribution frame is not shortened here.  A measured result and a
    # customer review are the sentences an answer engine lifts on their own, so
    # each names the brand as well as the product: the spelling those frames
    # use is theirs, and collapsing it would leave a lifted sentence without
    # the brand it attributes.
    introduced = False
    rendered: list[str] = []
    for sentence in sentences:
        rendered.append(sentence.replace(entity, name) if introduced else sentence)
        introduced = introduced or entity in sentence
    return rendered


def _korean_identity_opening(
    product: Mapping[str, Any], entity: str, product_type: str, named_source_description: str
) -> tuple[str, bool]:
    """Open with what the product is, and who the page says it is for.

    A buyer's first question is whether the product is for them, so the opening
    sentence names the product's type and carries the audience inside it rather
    than leaving the audience to a second, subjectless sentence.

    A source sentence that already predicates a category of the product states
    both in the page's own words, so it is preferred over wording composed
    here, and one that also names its audience is preferred over one that does
    not.  Composing an opening out of a source fragment is what produced
    ungrammatical copy: a page writes its summary as a noun phrase, and a
    copula bolted onto its final noun asserts that the product *is* that noun.
    Only when the page states no classifying sentence at all is an opening
    composed, and then from the audience atom and the resolved type alone.

    Returns the sentence and whether it already states the audience, so the
    caller does not follow it with a redundant second audience sentence.
    """

    audience_subject = r"[가-힣A-Za-z0-9][가-힣A-Za-z0-9\s·ㆍ-]{0,42}"
    if (
        named_source_description
        and is_korean_complete_sentence(named_source_description)
        and korean_classifies_its_subject(named_source_description)
    ):
        # The page's own summary already says what the product is, and the
        # renderer has already put the full entity in its subject slot.
        return named_source_description, _has_explicit_korean_audience_relation(
            named_source_description, audience_subject
        )

    values = [
        *(
            clean_text(value)
            for value in as_list(as_dict(product.get("semanticFacts")).get("evidenceSentences"))
        ),
        *(clean_text(value) for value in as_list(product.get("benefits"))),
        *_source_texts(product),
    ]
    candidates: list[str] = []
    for value in values:
        for raw in re.split(r"(?<=[.!?。！？])\s+|\n+", value):
            sentence = clean_text(raw)
            if (
                sentence
                and sentence not in candidates
                and is_korean_complete_sentence(sentence)
                and korean_classifies_its_subject(sentence)
                and not is_raw_page_text_block(sentence)
                and not _is_safety_or_negative_audience_context(sentence)
            ):
                candidates.append(sentence)

    stating_audience = [
        sentence
        for sentence in candidates
        if _has_explicit_korean_audience_relation(sentence, audience_subject)
    ]
    chosen = stating_audience[0] if stating_audience else (candidates[0] if candidates else "")
    if chosen:
        rendered = chosen if states_its_own_subject(chosen) else f"{_korean_topic_phrase(entity)} {chosen}"
        return rendered, bool(stating_audience)

    concern = _rich_skin_type(product, "ko-KR")
    if concern:
        return (
            f"{_korean_topic_phrase(entity)} {concern} 고민이 있는 고객을 위한 {product_type}입니다.",
            True,
        )
    return f"{_korean_topic_phrase(entity)} {product_type}입니다.", False


def _korean_attributes_rather_than_states(value: str) -> str | None:
    """Return whether a clause reports that a page says something, rather than saying it.

    ``안내합니다``, ``소개됩니다``, ``제시됩니다`` put the page between the
    reader and the fact: the sentence asserts that the page states it, not the
    fact itself.  That framing belongs to the page's own description; a product
    entity states what it is.  The brand's locale overlay names the same
    endings as wording to avoid in public copy.
    """

    text = clean_text(value).rstrip(".。！？!?")
    return re.search(r"(?:안내|소개|제시|설명|기재|표기)(?:합니다|됩니다|하였습니다|되었습니다|해요|돼요|한다|된다)$", text)


def _korean_direct_audience_sentence(product: Mapping[str, Any], entity: str, product_type: str) -> str:
    """State the audience the source records, as something the product is for."""

    audience = _rich_target_customer(product, "ko-KR")
    if not audience or not product_type:
        return ""
    return f"{_korean_topic_phrase(entity)} {_korean_object_phrase(audience)} 위한 {product_type}입니다."


def _korean_source_sentence_about_the_entity(entity: str, sentence: str) -> str:
    """Give a retained source sentence the product as its named subject.

    A page may point at its own product ("이 제품은 …") because the product is
    standing on the page.  The same sentence is read away from that page, where
    the pointing lands on nothing, so the product is named in its place.  A
    clause that states no subject at all receives the product as its topic; one
    that already names its own subject is kept whole, because a second
    topic-marked subject in front of it is not Korean.
    """

    text = clean_text(sentence)
    if not text or not entity:
        return text
    deictic = korean_deictic_self_reference(text)
    if deictic is not None:
        return f"{_korean_topic_phrase(entity)} {text[deictic.end():]}"
    if states_its_own_subject(text):
        return text
    return f"{_korean_topic_phrase(entity)} {text}"


def _korean_named_source_description(
    entity: str, name: str, source_description: str, product_type: str = ""
) -> str:
    """Attach the structured product identity to a direct Korean description only."""

    source = clean_text(source_description)
    if not source:
        return ""
    if entity and entity in source:
        return source
    if name:
        subject = re.match(rf"^{re.escape(name)}(?:은|는|이|가)(?P<predicate>.+)$", source)
        if subject is not None:
            rendered = f"{_korean_topic_phrase(entity)}{subject.group('predicate')}"
            predicate = clean_text(subject.group("predicate")).rstrip(".。！？!?")
            is_complete_predicate = re.search(r"(?:입니다|합니다|됩니다|한다|했다|어요|아요|돼요|됨|함)$", predicate)
            is_open_clause = re.search(r"(?:고|며|어|아|해|하여|하면서)$", predicate)
            if not is_complete_predicate and not is_open_clause and (
                not product_type or predicate.endswith(product_type) or len(predicate) >= 8
            ):
                return f"{rendered.rstrip('.。！？!?')}입니다."
            return rendered
        if name in source:
            return source
    if source.endswith(("?", "？")):
        return source
    rendered = f"{_korean_topic_phrase(entity)} {source}"
    source_stem = source.rstrip(".。！？!?")
    if (
        not re.search(r"(?:입니다|합니다|됩니다|한다|했다|어요|아요|돼요|됨|함)$", source_stem)
        and not re.search(r"(?:고|며|어|아|해|하여|하면서)$", source_stem)
        and len(source_stem) >= 8
    ):
        # A copula predicates the noun it attaches to.  Pages write their
        # summary as a noun phrase whose final noun is the object of an elided
        # verb ("노폐물을 말끔하게 세정"), and a copula there asserts that the
        # product *is* that object.  Only a phrase that ends on the product's
        # own type states an identity, so only that one becomes a sentence.
        if not product_type or source_stem.endswith(product_type):
            return f"{rendered.rstrip('.。！？!?')}입니다."
        return ""
    return rendered


def _unique_concrete_source_usage(product: Mapping[str, Any]) -> list[str]:
    """Return the source's own usage instructions, as the page states them."""

    semantic = as_dict(product.get("semanticFacts"))
    values = as_list(semantic.get("usageSteps")) or as_list(product.get("usage"))
    return [text for value in values if (text := clean_text(value))]


def _page_usage_summary_sentence(entity: str, usage: Sequence[str], locale: str) -> str:
    """Say that the page covers how the product is used, without restating the steps.

    A page description describes the page, and a reader deciding whether to
    read on wants to know the routine is answered here.  The steps themselves
    belong to HowTo, where their count and order are the source's; repeating
    them in prose would state a procedure twice and in a shape that is no
    longer ordered.  So the page says the routine is covered, and nothing about
    what it is.
    """

    if not [value for value in usage if clean_text(value)]:
        return ""
    if locale == "ko-KR":
        return f"{entity}의 사용 단계도 함께 다룹니다."
    if locale in {"en-US", "en-GB"}:
        return f"The page also outlines how to use {entity}."
    return ""


def _korean_instrumental_phrase(value: str) -> str:
    """Attach 로/으로, which Korean chooses by whether the noun ends in a consonant."""

    if not value:
        return value
    # ``ㄹ`` is the one final consonant ``로`` still follows directly.
    coda_takes_bare_ro = value[-1] != "\u3131" and (ord(value[-1]) - 0xAC00) % 28 == 8 if "\uac00" <= value[-1] <= "\ud7a3" else False
    return f"{value}{'로' if not _korean_has_final_consonant(value) or coda_takes_bare_ro else '으로'}"


def _korean_page_scope_product_sentence(
    entity: str,
    product_type: str,
    audience: str,
    ingredients: Sequence[str],
    benefit: str,
) -> str:
    """State a page's product facts as one sentence a reader can follow.

    A page description summarises; stating who the product is for, what it is
    made of, and what that does as three sentences in a row makes the summary
    read as a list of fields, and each sentence has to name the product again
    to start.  Chained, the same facts become one account in which each answers
    the next question: it is for these customers, so it carries these
    ingredients, so it does this.

    Every clause is optional.  A missing fact drops its clause and the sentence
    closes on whichever remains, because a summary with a gap in it is still a
    summary; only when nothing remains is there no sentence.
    """

    clauses: list[str] = []
    if audience and product_type:
        clauses.append(f"{_korean_object_phrase(audience)} 위한 {_korean_instrumental_phrase(product_type)},")
    if ingredients:
        clauses.append(f"{_format_list(ingredients, 'ko-KR')} 등을 주요 성분·기술로 포함하고")
    if not clauses:
        return ""
    closing = _korean_benefit_predicate(benefit) if benefit else ""
    if not closing:
        # Nothing follows the composition, so the last clause has to close the
        # sentence itself rather than lead into an outcome that is not there.
        if ingredients:
            return f"{_korean_topic_phrase(entity)} {_format_list(ingredients, 'ko-KR')} 등을 주요 성분·기술로 포함하고 있습니다."
        return f"{_korean_topic_phrase(entity)} {_korean_object_phrase(audience)} 위한 {product_type}입니다."
    return f"{_korean_topic_phrase(entity)} {' '.join(clauses)} {closing}"


def _english_page_scope_product_sentence(
    entity: str,
    product_type: str,
    audience: str,
    ingredients: Sequence[str],
    benefit: str,
    locale: str,
) -> str:
    """State a page's product facts as one sentence, in English's own chaining."""

    listed = _format_list(list(ingredients), locale)
    if not audience:
        # Without an audience there is nothing for the chain to open on: "is a
        # serum" restates the category the page already named.  The composition
        # opens it instead, and with no composition either there is no sentence
        # -- the benefit already has one of its own.
        if not listed:
            return ""
        closing = (
            f" and {benefit[:1].lower()}{benefit[1:]}"
            if benefit and _looks_like_english_benefit_clause(benefit)
            else f" to support {benefit}"
            if benefit
            else ""
        )
        return f"{entity} is formulated with {listed}{closing}."
    opening = f"{entity} is a {product_type} for {audience}" if product_type else f"{entity} is for {audience}"
    # A benefit atom that is already a verb phrase carries its own predicate, so
    # the chain relates it with ``that`` rather than wrapping a second one
    # around it; a bare outcome is what the product supports.
    closing = (
        f"that {benefit[:1].lower()}{benefit[1:]}"
        if benefit and _looks_like_english_benefit_clause(benefit)
        else f"to support {benefit}"
        if benefit
        else ""
    )
    if listed and closing:
        return f"{opening}, formulated with {listed} {closing}."
    if listed:
        return f"{opening}, formulated with {listed}."
    if closing:
        return f"{opening} {closing}."
    return f"{opening}." if audience and product_type else ""


def _korean_formula_sentence(entity: str, ingredients: Sequence[str]) -> str:
    """State a sourced formula list as something the product itself carries.

    The subject is the product, marked as the sentence topic, because the
    sentence is about the product rather than about what a page records.  A
    locative subject (``…에는``) reads as an inventory note; a topic subject
    reads as the product speaking about its own formula.
    """

    values = _format_list(ingredients, "ko-KR")
    return f"{_korean_topic_phrase(entity)} {values} 등을 주요 성분·기술로 함유하고 있습니다."


def _named_source_ingredients(product: Mapping[str, Any], limit: int) -> list[str]:
    """Return the ingredient names the source gives, never a span of its prose.

    An extraction that finds no formula list falls back to cutting the page's
    prose, and the cuts land in this field: a measurement, a whole sentence, a
    phrase that breaks off mid-clause.  Published as a formula they read as
    nonsense and they bind to nothing.  A page that describes its formula only
    in prose still names substances inside it, so the shared ingredient
    vocabulary reads those names rather than the prose around them.
    """

    values = [text for value in as_list(product.get("ingredients")) if (text := clean_text(value))]
    surfaces = _unique_texts(surface for value in values for surface in ingredient_surfaces_present_in(value))
    named = [
        value
        for value in values
        if names_a_thing(value)
        and is_atomic_fact_phrase(value)
        # A one-word cut of a fuller name the same page gives ("Ginseng" beside
        # "500-Hour Aged Ginseng") names the same substance less completely.
        and not any(
            value.casefold() != surface.casefold() and value.casefold() in surface.casefold()
            for surface in surfaces
        )
    ]
    if named:
        return _unique_texts(named)[:limit]
    return surfaces[:limit]


def _source_copy_ingredients(product: Mapping[str, Any]) -> list[str]:
    return _named_source_ingredients(product, 3)


def _source_safety_sentences(
    product: Mapping[str, Any], *, include_label_fallback: bool = True
) -> list[str]:
    """Return atomic safety facts, never a stitched OCR safety panel.

    A safety label is useful when it is the only source fact available, but a
    prose description must not turn a cluster of visual labels into a run-on
    paragraph.  Prefer a direct, customer-readable safety statement from the
    source; only PropertyValue-style consumers may fall back to short labels.
    """

    semantic = as_dict(product.get("semanticFacts"))
    inferred_candidates = [
        clean_text(product.get("description")),
        *_source_texts(product),
    ]
    typed_candidates = [clean_text(value) for value in as_list(semantic.get("safetyTests")) if clean_text(value)]

    def atomic_fragments(value: str) -> list[str]:
        """Separate an adjacent merchant fragment without breaking a standalone safety statement."""

        if is_raw_page_text_block(value):
            return []
        result: list[str] = []
        for sentence in re.split(r"(?<=[.!?。！？])\s+|\n+", value):
            sentence = clean_text(sentence)
            if not sentence or is_raw_page_text_block(sentence):
                continue
            # A semicolon is only split when the containing source sentence
            # has merchant/review language.  This retains a complete direct
            # caution such as "If irritation occurs; stop use" while allowing
            # "Free shipping; avoid eye contact" to retain just the caution.
            fragments = re.split(r"\s*[;；]\s*", sentence) if is_merchant_or_review_copy(sentence) else [sentence]
            result.extend(clean_text(fragment) for fragment in fragments if clean_text(fragment))
        return result

    def publishable(fragment: str) -> bool:
        return not is_merchant_or_review_copy(fragment) and (
            _is_safety_or_negative_audience_context(fragment) or not is_procedural_usage_instruction(fragment)
        )

    def direct_statement(fragment: str) -> bool:
        """Require sentence-shaped safety copy before it can enter a narrative."""

        if not publishable(fragment) or not _is_safety_or_negative_audience_context(fragment):
            return False
        if len(fragment) > 320 or is_raw_page_text_block(fragment):
            return False
        # A title-case/all-caps certification label remains valid structured
        # data, but reads as a stitched fragment in a description.
        latin_words = re.findall(r"[A-Za-z]{2,}", fragment)
        if len(latin_words) >= 2 and sum(word.isupper() for word in latin_words) / len(latin_words) >= 0.8:
            return False
        # ``… 테스트 완료`` is usually an OCR label.  If the normalized
        # extraction also has a complete sentence (``테스트를 완료했습니다``),
        # the label must not become a duplicate safety fact in public schema.
        if re.fullmatch(r".{1,160}(?:테스트|시험)\s*완료[.!?。！？]?", fragment):
            return False
        return bool(re.search(r"[.!?。！？]$|(?:완료|통과|적합|tested|test)\b", fragment, re.IGNORECASE))

    # A source-backed semantic safety role is authoritative about the role;
    # it must not depend on a second, incomplete cue vocabulary at rendering
    # time.  We still atomize and exclude merchant/review or ordinary usage
    # fragments so a malformed mixed source field cannot borrow that role.
    inferred = [
        fragment
        for value in inferred_candidates
        for fragment in atomic_fragments(value)
        if direct_statement(fragment)
    ]
    if inferred:
        return _unique_texts(inferred)[:2]
    if not include_label_fallback:
        return []
    typed = [
        fragment
        for value in typed_candidates
        for fragment in atomic_fragments(value)
        if publishable(fragment) and len(fragment) <= 160
    ]
    return _unique_texts(typed)[:3]


def _safety_property_name(locale: str) -> str:
    if locale == "ko-KR":
        return "안전성 안내"
    if locale == "ja-JP":
        return "安全性情報"
    return "Safety information"


def _direct_target_source_sentence(product: Mapping[str, Any], locale: str) -> str:
    """Keep the actual audience/concern statement instead of paraphrasing it."""

    if locale in {"en-US", "en-GB"}:
        contexts = _english_customer_context_sentences(product)
        return contexts[0] if contexts else ""

    values = [
        clean_text(product.get("description")),
        *(clean_text(value) for value in as_list(product.get("sourceTexts"))),
        *(
            clean_text(value)
            for item in as_list(product.get("faq"))
            for value in (as_dict(item).get("question"), as_dict(item).get("answer"))
        ),
        *(clean_text(value) for value in as_list(as_dict(product.get("semanticFacts")).get("evidenceSentences"))),
    ]
    korean_subject = r"[가-힣A-Za-z0-9][가-힣A-Za-z0-9\s·ㆍ-]{0,42}"
    pattern = r"\b(?:for|intended\s+for|best\s+for|suitable\s+for)\b.*\b(?:skin|customer|customers|people)\b"
    candidates: list[str] = []
    for value in values:
        for sentence in re.split(r"(?<=[.!?。！？])\s+|\n+", value):
            has_direct_audience_relation = (
                _has_explicit_korean_audience_relation(sentence, korean_subject)
                if locale == "ko-KR"
                else re.search(pattern, sentence, re.I) is not None
            )
            if not _is_safety_or_negative_audience_context(sentence) and has_direct_audience_relation:
                candidates.append(clean_text(sentence))
    if not candidates:
        return ""
    if locale == "ko-KR":
        # This stage is published as prose, so it has to be prose.  A relation
        # word can also occur inside a stitched run of page text -- a formula
        # panel, a badge row, a caption -- and such a run is not a sentence
        # about anybody.  The opening sentence of the same description is
        # already held to that standard; this one asserts a fact about the same
        # product and is held to it too.  When nothing publishable states the
        # audience, the stage is omitted rather than filled with a page dump.
        publishable = [
            candidate
            for candidate in candidates
            if is_korean_complete_sentence(candidate) and not is_raw_page_text_block(candidate)
        ]
        # Prefer the normalized standalone audience atom over an OCR sentence
        # that joins it to a benefit clause.  That preserves the source's
        # audience claim without duplicating the same benefit later in the
        # role-ordered description.
        standalone = next(
            (
                candidate
                for candidate in publishable
                if re.search(
                    r"(?:추천|권장|적합)(?:됩니다|합니다|한\s*제품입니다)[.!?。！？]?$",
                    candidate,
                )
            ),
            "",
        )
        # Failing that, a relation word does not by itself make an audience: a
        # page writes "데일리 클렌징을 위한" about a routine and "피부 친화적인"
        # about a formula.  The audiences this product actually has are the
        # typed audience atoms its own extraction recorded, so a sentence that
        # states the relation about one of those is preferred over one that
        # states it about something else.
        audiences = [
            text
            for value in as_list(as_dict(product.get("semanticFacts")).get("skinTypes"))
            if (text := clean_text(value))
        ]
        about_an_audience = next(
            (
                candidate
                for candidate in publishable
                if any(audience in candidate for audience in audiences)
            ),
            "",
        )
        return standalone or about_an_audience or next(iter(publishable), "")
    if locale in {"en-US", "en-GB"}:
        direct_label = next(
            (
                candidate
                for candidate in candidates
                if re.search(r"\bworks\s+best\s+for\s*:", candidate, re.I)
            ),
            "",
        )
        if direct_label:
            # Preserve the documented audience relation, changing only the
            # all-caps label to normal sentence casing for public copy.
            return re.sub(r"\bworks\s+best\s+for(?=\s*:)", "Works best for", direct_label, count=1, flags=re.I)
    return candidates[0]


def _english_customer_context_sentences(product: Mapping[str, Any]) -> list[str]:
    """Select explicit audience and concern facts without promoting formula prose.

    OCR sometimes joins a heading to its value (``WORKS BEST FORNormal``).
    Structured semantic evidence is the safer source when available; otherwise
    only the heading join itself is repaired.  A formula sentence mentioning
    healthy-looking skin is not an audience statement and must never win this
    selection merely because it contains ``for … skin``.
    """

    semantic = as_dict(product.get("semanticFacts"))
    skin_types = [clean_text(value).casefold() for value in as_list(semantic.get("skinTypes")) if clean_text(value)]
    structured = [clean_text(value) for value in as_list(semantic.get("evidenceSentences")) if clean_text(value)]
    raw = [
        clean_text(product.get("description")),
        *(clean_text(value) for item in as_list(product.get("faq")) for value in (as_dict(item).get("question"), as_dict(item).get("answer"))),
        *_source_texts(product),
    ]
    audience = ""
    concern = ""
    product_identity = sorted(
        {
            candidate
            for raw in (product.get("name"), product.get("originalName"))
            if (candidate := clean_text(raw))
        },
        key=len,
        reverse=True,
    )
    for value in [*structured, *raw]:
        for sentence in re.split(r"(?<=[.!?。！？])\s+|\n+", value):
            candidate = _repair_english_heading_join(clean_text(sentence))
            audience_candidate = candidate
            for identity in product_identity:
                audience_candidate = re.sub(re.escape(identity), "", audience_candidate, flags=re.IGNORECASE)
            audience_candidate = clean_text(audience_candidate)
            if (
                not candidate
                or not _publishable_english_source_description(candidate)
                or _is_safety_or_negative_audience_context(candidate)
                or (
                    _looks_like_formula_context(audience_candidate)
                    and not _has_direct_english_audience_relation(audience_candidate)
                )
                or _is_english_question(candidate)
            ):
                continue
            # ``A solution for brittle hair`` is a concern statement, not a
            # customer-audience label.  Keep one role so the FAQ does not
            # repeat the same source sentence as both target and rationale.
            is_concern = _is_explicit_english_concern_context(candidate)
            if not concern and is_concern:
                concern = candidate
            if is_concern:
                continue
            is_named_product_audience_label = bool(re.match(r"^for\s+\S", audience_candidate, re.IGNORECASE))
            if (is_named_product_audience_label or _is_explicit_english_audience_context(candidate, skin_types)) and (
                not audience or _english_audience_context_priority(candidate) > _english_audience_context_priority(audience)
            ):
                audience = candidate
    return _unique_texts([audience, concern])


def _is_english_question(value: str) -> bool:
    """Keep a PDP FAQ prompt from becoming a declaration in public prose."""

    text = clean_text(value)
    return bool(
        text.endswith(("?", "？"))
        or re.match(r"^(?:is|are|was|were|do|does|did|can|could|should|would|will|has|have)\b", text, re.I)
    )


def _english_page_coverage_overview(
    product: Mapping[str, Any],
    entity: str,
    product_type: str,
    customer_context: Sequence[str],
    ingredients: Sequence[str],
    benefits: Sequence[str],
    metric: str,
    review_sentence: str,
    locale: str,
) -> str:
    """Open an English page description on the customer the page answers.

    A page description carries the page, and that role is carried by naming
    the page and the buyer it is for -- not by listing what the page contains.
    A contents list ("covers who it is for, formula details, ...") states
    nothing a buyer searched for, while the audience is the one thing a query
    and this page have in common.  The same reasoning governs the Korean lead,
    so both locales open the same way and the English page is not the poorer
    of the two.

    The contents phrasing stays as the fallback for a product whose source
    states no audience a buyer would recognize as theirs.
    """

    audience = _page_overview_audience(product, locale)
    if product_type and _names_a_specific_target_customer(audience, locale):
        return (
            f"The product page for {entity} introduces "
            f"{_indefinite_article(product_type)} {product_type} for {audience}."
        )
    labels: list[str] = []
    if any(_is_explicit_english_audience_context(sentence, []) for sentence in customer_context):
        labels.append("who it is for")
    if any(_is_explicit_english_concern_context(sentence) for sentence in customer_context):
        labels.append("skin concerns")
    if ingredients or _source_grounded_ingredient_effect_sentences(product):
        labels.append("formula details")
    if benefits:
        labels.append("stated benefits")
    if metric:
        labels.append("reported results")
    if _has_attributed_public_review_content(product):
        labels.append("customer feedback")
    if labels:
        return f"The product page for {entity} covers {_format_list(labels, 'en-US')}."
    return f"The product page for {entity} offers an overview."


def _page_offer_sentence(entity: str, product: Mapping[str, Any], locale: str) -> str:
    """State the offer the page carries: its price, and the options it lists.

    A page-scope description describes the page, and what a product page adds
    over the product itself is the offer standing on it.  Price and options
    belong there and nowhere else -- which is also what keeps the page's
    description from repeating the product's own narrative back at the reader.

    Price and options are one offer, so they are one sentence.  Split across
    two, each repeats the product as its own subject and the reader meets the
    same entity twice to learn one thing; and the predicate that fits a price
    ("판매됩니다") does not fit an option, which is how the page is *composed*
    rather than sold.  Naming both in one sentence also keeps the price inside
    the same clause a reader quotes when they quote the option.
    """

    price = as_dict(product.get("price"))
    amount = price.get("amount")
    # Normalization keeps the amount and drops the currency when the page never
    # spelled one out, and the Offer node resolves it from the market the same
    # way.  The prose has to name the same currency the Offer publishes.
    currency = _normalize_price_currency(price.get("currency")) or _MARKET_CURRENCIES.get(
        locale.split("-")[-1].upper(), ""
    )
    options = _unique_texts(text for value in as_list(product.get("options")) if (text := clean_text(value)))
    rendered_price = (
        _offer_price_text(amount, currency, locale)
        if isinstance(amount, int | float) and currency
        else ""
    )
    rendered_options = _format_list(options[:4], locale) if options else ""
    if locale == "ko-KR":
        topic = _korean_topic_phrase(entity)
        if rendered_price and rendered_options:
            return f"{topic} {rendered_price}에 판매되며, {rendered_options} 옵션으로 구성되어 있습니다."
        if rendered_price:
            return f"{topic} {rendered_price}에 판매됩니다."
        if rendered_options:
            return f"{topic} {rendered_options} 옵션으로 구성되어 있습니다."
        return ""
    if locale in {"en-US", "en-GB"}:
        if rendered_price and rendered_options:
            return f"{entity} is listed at {rendered_price} and offered in {rendered_options}."
        if rendered_price:
            return f"{entity} is listed at {rendered_price}."
        if rendered_options:
            return f"{entity} is offered in {rendered_options}."
    return ""


def _offer_price_text(amount: float, currency: str, locale: str) -> str:
    """Write a price the way its currency is written, without converting it."""

    whole = int(amount) if float(amount).is_integer() else amount
    if currency == "KRW":
        return f"{whole:,}원"
    if currency == "USD":
        return f"${whole:,}"
    if currency == "JPY":
        return f"{whole:,}円"
    return f"{whole:,} {currency}"


# A generic stand-in for the audience names no one: it is what the extractor
# writes when the page stated no audience, so it cannot lead a page overview.
_GENERIC_TARGET_CUSTOMER = {
    "ko-KR": re.compile(r"^(?:고객|상품의\s*핵심\s*효능|사용법을\s*빠르게\s*확인)$"),
    "en-US": re.compile(r"^(?:customers|key benefits and routine fit|product's key benefits)$", re.IGNORECASE),
    "en-GB": re.compile(r"^(?:customers|key benefits and routine fit|product's key benefits)$", re.IGNORECASE),
    "ja-JP": re.compile(r"^(?:お客様|商品の主な特徴)$"),
}


def _page_overview_audience(product: Mapping[str, Any], locale: str) -> str:
    """Name the customer a page is for, whole.

    An overview that names one of several customers claims a narrower page
    than the one it describes, and a buyer among the customers it dropped
    reads that the page is not for them -- worse than naming no customer at
    all.  So the phrase has to account for every customer the source filed.

    The page's own phrasing is preferred over a list composed here: a page
    that writes "normal, combination, and dry skin" has already merged what
    three filed rows say, and a composed list repeats the head noun three
    times to say the same thing.  Where neither the page's phrase nor the
    resolved audience accounts for them all, the rows are named as they were
    filed, and an audience that cannot be named whole yields the lead to the
    coverage phrasing.
    """

    typed = [
        text
        for value in as_list(as_dict(product.get("semanticFacts")).get("skinTypes"))
        if (text := clean_text(value)) and not _is_safety_or_negative_audience_context(text)
    ]

    def names_every_filed_customer(candidate: str) -> bool:
        words = _publishable_words(candidate)
        return all(_publishable_words(atom) <= words for atom in typed)

    page_phrase = next(
        (
            target
            for sentence in _english_customer_context_sentences(product)
            if (target := _english_direct_audience_target(sentence))
        ),
        "",
    ) if locale in {"en-US", "en-GB"} else ""
    for candidate in (page_phrase, _rich_target_customer(product, locale)):
        if candidate and names_every_filed_customer(candidate):
            return candidate
    return _format_list(typed, locale) if len(typed) > 1 else ""


def _names_a_specific_target_customer(value: str, locale: str) -> bool:
    """Return whether this audience is one a buyer could recognize as theirs."""

    text = clean_text(value)
    generic = _GENERIC_TARGET_CUSTOMER.get(locale)
    return bool(text) and (generic is None or generic.match(text) is None)


def _korean_page_coverage_overview(
    product: Mapping[str, Any],
    entity: str,
    name: str,
    product_type: str,
    target_sentence: str,
    ingredients: Sequence[str],
    benefits: Sequence[str],
    metric: str,
    has_attributed_review_content: bool,
) -> str:
    """Open a Korean page description on the concern the page answers.

    The field describes the page, and that role is carried by naming the page
    -- not by listing what the page contains.  A contents list ("제품의 특징과
    대상 고객, 성분·포뮬러 …") states nothing a buyer searched for, and what
    earns a citation is topical match between the query and the page, not a
    table of contents.  So the lead names the page and then the customer it is
    for, which is the one thing a buyer's query and this page have in common.

    The contents phrasing stays as the fallback for a product whose source
    states no audience a buyer would recognize as theirs.
    """

    brand = clean_text(product.get("brand"))
    # The page's subject is the product's own name; the brand belongs in the
    # clause that says who offers it, so the reader is not given the brand
    # twice in one breath.
    page_subject = clean_text(name) or entity
    brand_subject = (
        f"{_korean_subject_phrase(brand)} 선보이는 "
        if brand and brand.casefold() not in page_subject.casefold()
        else ""
    )
    audience = _page_overview_audience(product, "ko-KR")
    if _names_a_specific_target_customer(audience, "ko-KR"):
        return (
            f"{page_subject} 상품 페이지는 {brand_subject}{_korean_object_phrase(audience)} 위한 "
            f"{product_type} 정보를 다룹니다."
        )
    labels = [
        *(["대상 고객"] if target_sentence else []),
        *(["성분·포뮬러"] if ingredients else []),
        *(["효능·효과"] if benefits else []),
        *(["근거 지표"] if metric else []),
        *(["고객 평가"] if has_attributed_review_content else []),
    ]
    if not labels:
        return f"{entity} 상품 페이지는 제품의 특징을 소개합니다."
    return f"{entity} 상품 페이지는 제품의 특징과 {_korean_object_phrase(_format_list(labels, 'ko-KR'))} 함께 다룹니다."


def _repair_english_heading_join(value: str) -> str:
    """Repair only a documented OCR heading boundary, retaining the source fact."""

    text = clean_text(value)
    text = re.sub(r"\bWORKS\s+BEST\s+FOR(?=[A-Z])", "Works best for ", text, flags=re.IGNORECASE)
    text = re.sub(r"\bSOLUTION\s+FOR(?=[A-Z])", "A solution for ", text, flags=re.IGNORECASE)
    return re.sub(r"\bWORKS\s+BEST\s+FOR(?=\s*:)", "Works best for", text, count=1, flags=re.IGNORECASE)


def _looks_like_formula_context(value: str) -> bool:
    """Detect an actual composition assertion, not incidental formula vocabulary in a product title."""

    return re.search(
        r"\b(?:ingredients?|formula|composition)\s*(?::|(?:that\s+)?(?:contains?|includes?|uses?)\b)|"
        r"\b(?:contains?|includes?|formulated\s+with|made\s+with)\b",
        value,
        re.IGNORECASE,
    ) is not None


def _has_direct_english_audience_relation(value: str) -> bool:
    return re.search(
        r"\b(?:works?\s+best|intended|suitable|designed|formulated|developed|created|made)\s+for\b|"
        r"\b(?:is|are|was|were)\s+for\s+[A-Za-z]",
        value,
        re.IGNORECASE,
    ) is not None


def _is_explicit_english_audience_context(value: str, skin_types: Sequence[str]) -> bool:
    if _is_safety_or_negative_audience_context(value):
        return False
    normalized = value.casefold()
    if _has_direct_english_audience_relation(value):
        return True
    # A PDP can state its audience directly in its product sentence (for
    # example, ``a serum for dry skin``) without duplicating that value in
    # semanticFacts.skinTypes.  The caller already rejects formula prose, and
    # requiring a descriptor before ``skin`` avoids mistaking a broad phrase
    # such as ``helps with skin hydration`` for a customer target.
    if re.search(r"\b(?:for|with)\s+(?:[A-Za-z-]+\s+){1,4}skin(?:\s+types?)?\b", value, re.IGNORECASE):
        return True
    known_type = any(
        candidate
        and (
            candidate in normalized
            or (candidate_without_skin := re.sub(r"\bskin\b", "", candidate).strip())
            and candidate_without_skin in normalized
        )
        for candidate in skin_types
    )
    # A standalone PDP label such as ``For normal, dry, and oily skin
    # types`` is a direct audience statement when it overlaps a typed target.
    # Do not treat an arbitrary product-benefit clause containing ``for``
    # (for example, ``Controls shine for a balanced finish``) as suitability.
    return bool(
        known_type
        and (
            re.match(r"^for\s+", value, re.IGNORECASE)
            or re.search(r"\b(?:for|with)\b", value, re.IGNORECASE)
        )
    )


def _english_audience_context_priority(value: str) -> int:
    """Prefer an explicit PDP audience label over a generic product sentence."""

    if re.search(
        r"\b(?:works?\s+best|intended|suitable|designed|formulated|developed|created|made)\s+for\b|"
        r"\b(?:is|are|was|were)\s+for\s+[A-Za-z]",
        value,
        re.IGNORECASE,
    ):
        return 2
    return 1


def _is_explicit_english_concern_context(value: str) -> bool:
    """Recognize a source-stated concern relation, not a bare outcome word.

    A PDP formula sentence can truthfully say that Retinol improves wrinkles,
    but that does not establish that wrinkles are the customer's stated
    concern.  Buyer FAQ copy needs an explicit product-to-concern frame such
    as ``solution for`` or ``designed to address`` before it can ask a
    suitability-style question.
    """

    return re.search(
        r"\b(?:a\s+)?solution\s+for\b|"
        r"\b(?:formulated|designed|developed|created|made)\s+(?:to\s+)?(?:address|target)\b|"
        r"\b(?:addresses?|targets?)\s+(?:fine\s+lines?|wrinkles?|loss\s+of\s+firmness|dryness)\b",
        value,
        re.IGNORECASE,
    ) is not None


def _public_outcome_values(values: Sequence[object], locale: str) -> list[str]:
    """Admit only factual outcome sentences at every public rendering boundary."""

    return _unique_texts(
        sentence
        for value in values
        for sentence in re.split(r"(?<=[.!?。！？])\s+|\n+", clean_text(value))
        if clean_text(sentence)
        and not is_procedural_usage_instruction(sentence)
        and not _is_safety_or_negative_audience_context(sentence)
        and is_publishable_description_text(sentence, locale)
    )


def _source_copy_benefits(product: Mapping[str, Any], locale: str) -> list[str]:
    values = _public_outcome_values(
        [*as_list(product.get("benefits")), *as_list(product.get("effects"))], locale
    )
    if locale in {"en-US", "en-GB"}:
        product_type = _english_product_type(product, clean_text(product.get("name")))
        values = [value for value in values if not _english_benefit_is_product_descriptor(value, product_type)]
    return values[:4]


def _english_benefit_is_product_descriptor(value: str, product_type: str) -> bool:
    """Do not turn a product-form noun phrase into an outcome claim."""

    normalized = re.sub(r"[,;:]+", " ", clean_text(value)).rstrip(".。！？!? ").strip()
    if re.match(
        rf"^(?:this|the)\s+(?:[A-Za-z0-9™®&+/'-]+\s+){{0,3}}{re.escape(product_type)}\s+(?:is|was|are|were)\b",
        normalized,
        re.IGNORECASE,
    ):
        return False
    return bool(
        normalized
        and product_type
        and product_type != "product"
        and _english_description_is_noun_phrase(normalized, product_type)
    )




def _source_copy_review(product: Mapping[str, Any]) -> str:
    """Return one quotable sentence from a non-negative customer body.

    An attribution frame has to wrap exactly the words it attributes.  A review
    body runs to several sentences, and published copy is read back one
    sentence at a time, so a whole body splices the frame's opening and its
    closing into different sentences and leaves the customer's middle sentences
    standing as if the product had written them.  One sentence keeps the
    attribution attached to what it attributes.
    """

    body = _positive_review_body(product)
    for raw in re.split(r"(?<=[.!?。！？])\s+|\n+", body):
        sentence = clean_text(raw).rstrip(".。！？!?").strip()
        if (
            sentence
            and is_complete_sentence(clean_text(raw))
            and korean_sentence_opens_with_a_constituent(sentence)
        ):
            return sentence
    return ""


def _positive_review_body(product: Mapping[str, Any]) -> str:
    """Return a non-negative customer body when one is available."""

    reviews = as_dict(product.get("reviews"))
    return next(
        (
            body
            for item in as_list(reviews.get("items"))
            if (record := as_dict(item))
            and (body := clean_text(record.get("body")))
            and is_positive_review_item(record)
        ),
        "",
    )


def _positive_review_keywords(product: Mapping[str, Any]) -> list[str]:
    """Return the customer-readable positive keywords, as the copy can name them.

    A keyword is extracted as it appeared in a sentence, so a Korean one still
    carries the particle that gave it a role there ("촉촉함이").  Naming it as
    what customers evaluated means giving it the particle that role takes, and
    the two particles cannot both stand -- so the extracted marking comes off
    and the sentence supplies its own.  The word itself is unchanged.

    A bare English third-person verb (for example ``absorbs``) is a useful
    extraction signal but not enough context for a grammatical attributed
    review sentence, and a Korean form that does not name a thing cannot be
    the object of an evaluation.  Both stay in diagnostics.
    """

    reviews = as_dict(product.get("reviews"))
    bodies = " ".join(
        clean_text(as_dict(item).get("body")) for item in as_list(reviews.get("items"))
    )
    keywords: list[str] = []
    for value in as_list(reviews.get("keywords")):
        raw = clean_text(value)
        if not is_positive_review_keyword(raw) or re.fullmatch(r"[a-z]+s", raw, re.IGNORECASE):
            continue
        keyword = strip_korean_particle(raw) if re.search(r"[가-힣]", raw) else raw
        if not keyword or keyword in keywords:
            continue
        if not re.search(r"[가-힣]", keyword):
            if names_a_thing(keyword):
                keywords.append(keyword)
            continue
        if names_a_thing(keyword) and _korean_review_keyword_names_a_thing(keyword, bodies):
            keywords.append(keyword)
    return keywords[:3]


def _korean_reported_review_keyword(product: Mapping[str, Any]) -> str:
    """Return one positive keyword the copy can report as an assessment.

    A keyword cut from a review can be the predicate the customer ended on
    ("만족스러워요") rather than a thing they named.  That is still what they
    assessed, so it is reported as an assessment instead of being dropped --
    which is what ``-다는 평가`` says in Korean.  A keyword that breaks off on a
    connective is not a sentence and reports nothing.
    """

    reviews = as_dict(product.get("reviews"))
    # The reviews themselves are the evidence for whether a 하다 predicate is a
    # verb or an adjective, so the corpus this keyword was cut from is what
    # settles its ending.
    corpus = " ".join(
        [
            *(clean_text(value) for value in as_list(reviews.get("keywords"))),
            *(clean_text(as_dict(item).get("body")) for item in as_list(reviews.get("items"))),
        ]
    )
    return next(
        (
            reported
            for value in as_list(reviews.get("keywords"))
            if is_positive_review_keyword(keyword := clean_text(value))
            and re.search(r"[가-힣]", keyword)
            and (reported := korean_reported_clause(keyword))
            and not korean_reported_clause_misreads_a_verb(korean_plain_declarative(keyword), corpus)
        ),
        "",
    )


_KOREAN_CASE_PARTICLE_AFTER_NOUN = "이가은는을를도의에와과"


def _korean_review_keyword_names_a_thing(keyword: str, reviews: str) -> bool:
    """Return whether the reviews use this keyword as a thing rather than a statement.

    Extraction cuts keywords out of review sentences, so a cut can land on a
    predicate ("만족스러워요") as easily as on a noun ("촉촉함").  The frame names
    what customers evaluated, which needs a thing, and Korean marks a thing by
    attaching a case particle to it.  Where the reviews put a case particle
    after the word they were using it as a thing; where they ended a sentence
    on it they were saying something.  That is the source's own grammar
    deciding, not a list of endings.

    Where the word does not appear in the review bodies at all, the reviews say
    nothing either way -- a summarized keyword need not be a span of any one
    review -- and the ordinary phrase judgement stands.
    """

    if not re.search(re.escape(keyword), reviews):
        return True
    return re.search(rf"{re.escape(keyword)}[{_KOREAN_CASE_PARTICLE_AFTER_NOUN}]", reviews) is not None


def _positive_review_keyword(product: Mapping[str, Any]) -> str:
    """Return the first customer-readable positive keyword."""

    return next(iter(_positive_review_keywords(product)), "")


def _positive_review_rating(product: Mapping[str, Any]) -> tuple[str, str, str] | None:
    """Return source-exact positive aggregate values for a neutral attribution sentence."""

    reviews = as_dict(product.get("reviews"))
    rating, review_count = reviews.get("rating"), reviews.get("reviewCount")
    if not is_positive_aggregate_rating(rating, review_count):
        return None
    scale = 10 if cast(int | float, rating) > 5 else 5
    return str(rating), str(review_count), str(scale)


def _has_attributed_public_review_content(product: Mapping[str, Any]) -> bool:
    """Distinguish written review coverage from a factual aggregate rating."""

    return bool(_source_copy_review(product) or _positive_review_keyword(product))




def _public_review_sentence(product: Mapping[str, Any], name: str, locale: str) -> str:
    """Render one source-exact review or aggregate-rating sentence.

    The precedence is intentional: a non-negative customer body is strongest
    evidence; otherwise only an explicitly positive keyword may be rendered.
    A complete positive aggregate can be rendered as a factual rating, but it
    never becomes written-review or customer-feedback prose. Negative or mixed
    keyword signals are retained for diagnostics but never reach a public
    description, FAQ, property, or schema Review node.
    """

    entity = product_entity_reference(product, name, locale)
    # What customers said is worth stating; one customer's whole sentence is
    # not the way to state it.  Lifted into a description it reads as one
    # person's words standing in for everyone's, and its specific wording
    # answers no question a buyer asked.  The keywords are the same reviews
    # summarized across customers, which is what a reader wants here, so they
    # lead; a body quote is what remains when the source supports no
    # publishable keyword.
    keywords = _positive_review_keywords(product)
    if keywords:
        listed = _format_list(keywords, locale)
        if locale in {"en-US", "en-GB"}:
            return f"Customers who reviewed {entity} positively noted {listed}."
        if locale == "ko-KR":
            return f"{_korean_object_phrase(entity)} 사용한 고객들은 {_korean_object_phrase(listed)} 긍정적으로 평가했습니다."
        return listed
    if locale == "ko-KR" and (reported_keyword := _korean_reported_review_keyword(product)):
        return f"{_korean_object_phrase(entity)} 사용한 고객들은 {reported_keyword} 평가를 하였습니다."
    body = _source_copy_review(product)
    if body:
        if locale in {"en-US", "en-GB"}:
            return f"Customers who reviewed {entity} noted {body}."
        if locale == "ko-KR":
            # Reporting a customer's words as speech puts their politeness and
            # their exclamations into the product's own copy.  What the page is
            # reporting is their assessment, so the words are stated as the
            # assessment they are: the predicate moves to the plain declarative
            # Korean reports in, and the frame says it was an assessment.
            reported = korean_reported_clause(body)
            if reported:
                return f"{_korean_object_phrase(entity)} 사용한 고객들은 {reported} 평가를 하였습니다."
        return body
    rating = _positive_review_rating(product)
    if rating:
        value, count, scale = rating
        if locale in {"en-US", "en-GB"}:
            return f"{entity} received {value} out of {scale} from {count} customer ratings."
        if locale == "ko-KR":
            return f"{_korean_topic_phrase(entity)} {count}건의 고객 평가에서 {value}/{scale}점을 받았습니다."
    return ""




def _diagnostic_review_signal(product: Mapping[str, Any]) -> str:
    """Keep raw review keywords for diagnostics/CEP, never for public copy."""

    reviews = as_dict(product.get("reviews"))
    return next((keyword for value in as_list(reviews.get("keywords")) if (keyword := clean_text(value))), "")


_ENGLISH_OUTCOME_VERB_STEMS = {
    "adds": "add",
    "boosts": "boost",
    "calms": "calm",
    "contributes": "contribute",
    "delivers": "deliver",
    "detangles": "detangle",
    "enhances": "enhance",
    "helps": "help",
    "improves": "improve",
    "increases": "increase",
    "keeps": "keep",
    "maintains": "maintain",
    "nourishes": "nourish",
    "offers": "offer",
    "promotes": "promote",
    "protects": "protect",
    "provides": "provide",
    "reduces": "reduce",
    "repels": "repel",
    "restores": "restore",
    "soothes": "soothe",
    "strengthens": "strengthen",
    "supports": "support",
}


def _english_outcome_key(value: str) -> str:
    """Return a narrow semantic key for an already explicit English outcome clause.

    This only removes a repeated outcome when a formula relation and a
    separately supplied product benefit say the same thing. It does not join
    adjacent facts or infer a new ingredient-to-benefit relationship.
    """

    text = clean_text(value).rstrip(".。！？")
    match = re.search(
        rf"\b(?P<verb>{'|'.join(_ENGLISH_OUTCOME_VERB_STEMS)})\s+(?P<tail>.+)$",
        text,
        re.IGNORECASE,
    )
    if match is None:
        return ""
    verb = _ENGLISH_OUTCOME_VERB_STEMS[match.group("verb").casefold()]
    tail = re.sub(r"^to\s+", "", clean_text(match.group("tail")), flags=re.IGNORECASE)
    nested = re.match(r"(?P<verb>maintains?|supports?|helps?|improves?|reduces?|adds?|keeps?)\s+(?P<tail>.+)", tail, re.I)
    if verb in {"help", "support"} and nested is not None:
        nested_verb = nested.group("verb").casefold()
        verb = _ENGLISH_OUTCOME_VERB_STEMS.get(nested_verb, nested_verb.rstrip("s"))
        tail = clean_text(nested.group("tail"))
    normalized_tail = re.sub(r"\W+", " ", tail).casefold().strip()
    return f"{verb} {normalized_tail}" if normalized_tail else ""


def _publishable_words(value: str, *, without: Sequence[str] = ()) -> set[str]:
    """Return the words a sentence carries, as the words they are.

    An ending is not a different word, and neither is letter case, so a Korean
    particle is stripped and a Latin word is folded.  Function words carry no
    fact, and the entity is named by every sentence that asserts anything of
    it, so neither counts toward what a sentence states.
    """

    excluded = {
        token.casefold()
        for name in without
        for token in re.findall(r"[A-Za-z0-9%]+|[가-힣]+", name)
    }
    words: set[str] = set()
    for token in re.findall(r"[A-Za-z0-9%]+|[가-힣]+", value):
        if token.casefold() in excluded:
            continue
        word = strip_korean_particle(token) if re.search(r"[가-힣]", token) else token.casefold()
        if word and word not in ENGLISH_FUNCTION_WORDS:
            words.add(word)
    return words


def _page_overview_already_states(overview: str, sentence: str, entity: str, name: str) -> bool:
    """Return whether an audience-led overview already states this whole sentence.

    The overview names the page, the product's type and the customer it is for.
    A sentence that names only those states one of them a second time, and a
    description has no room to say the same thing twice.  Coverage is decided
    on the words each sentence carries rather than on its shape, so the rule
    holds in either locale, and a sentence carrying one word the overview does
    not have is stating something new and stays.
    """

    stated = _publishable_words(sentence, without=[entity, name])
    return bool(stated) and stated <= _publishable_words(overview, without=[entity, name])


def _append_distinct_source_sentence(parts: list[str], source_description: str) -> None:
    if not source_description:
        return
    normalized = re.sub(r"\W+", "", source_description).casefold()
    if any(normalized == re.sub(r"\W+", "", part).casefold() for part in parts):
        return
    outcome_key = _english_outcome_key(source_description)
    if outcome_key and any(outcome_key == _english_outcome_key(part) for part in parts):
        return
    parts.append(source_description if re.search(r"[.!?。！？]$", source_description) else f"{source_description}.")


def _same_source_sentence(left: str, right: str) -> bool:
    """Compare source rows without treating a named renderer frame as a second fact."""

    return bool(left and right) and re.sub(r"\W+", "", left).casefold() == re.sub(r"\W+", "", right).casefold()


def _qualified_metric_sentence(product: Mapping[str, Any], locale: str = "en-US") -> str:
    """Return the strongest source-backed metric sentence, if the source has one."""

    sentences = _qualified_metric_sentences(product, locale)
    return sentences[0] if sentences else ""


_PUBLISHED_METRIC_LIMIT = 3


def _qualified_metric_sentences(
    product: Mapping[str, Any], locale: str = "en-US", limit: int = _PUBLISHED_METRIC_LIMIT
) -> list[str]:
    """Return every measured result the source qualifies, strongest first.

    A page that ran one study on two things reports two results, and a page
    with a chart reports one per timepoint.  Publishing only the strongest
    spent the description's evidence stage on a single figure and left the
    rest of the page's own measurements unpublished, which is the opposite of
    what a measured claim is for.

    Each sentence still qualifies on its own -- it carries the population,
    period, or method the same row states -- so this widens how many results
    are published, not what counts as one.
    """

    semantic = as_dict(product.get("semanticFacts"))
    # The ledger renders this same claim to bind the published sentence to it,
    # so both must name the product the same way: a description names it by its
    # title without the SKU size, and a subject carrying "200g" would render a
    # sentence no ledger atom matches.
    subject = product_entity_reference(
        product, product_title_without_sku_qualifier(clean_text(product.get("name"))), locale
    )
    candidates = [
        (index, claim, rendered)
        for index, raw in enumerate(as_list(semantic.get("metricClaims")))
        if (rendered := _public_metric_sentence(claim := as_dict(raw), locale, subject=subject))
    ]
    if not candidates:
        return ""
    keyed = sorted(
        ((_metric_claim_selection_key(product, *candidate), candidate[1], candidate[2]) for candidate in candidates),
        key=lambda item: item[0],
    )
    # A page can qualify two results equally -- one study measured on two
    # things, or one chart measured at several timepoints -- and publishing
    # only the first spends the evidence stage on one figure while the page's
    # other measurements go unpublished.  A result the page qualified *less*
    # is a different matter: it stands behind the stronger one, so it is not
    # published beside it.  Standing is the selection key minus the tie-break
    # on filing order, so peers publish together and a weaker result waits.
    best = keyed[0][0][:-1]
    peers = [(claim, rendered) for key, claim, rendered in keyed if key[:-1] == best]
    # The merged sentence is proved against a ledger atom rendered from every
    # measured claim, so it is published only when the peers are exactly those
    # claims.  A narrower peer set keeps its results as separate sentences.
    measured = [
        record
        for raw in as_list(as_dict(product.get("semanticFacts")).get("metricClaims"))
        if (record := as_dict(raw)) and clean_text(record.get("value"))
    ]
    if len(peers) == len(measured):
        merged = render_merged_measured_result_metric(
            [claim for claim, _ in peers],
            locale,
            subject=product_entity_reference(
                product, product_title_without_sku_qualifier(clean_text(product.get("name"))), locale
            ),
        )
        if merged:
            return [merged]
    return _unique_texts([rendered for _, rendered in peers])[:limit]


def _metric_claim_selection_key(product: Mapping[str, Any], index: int, claim: Mapping[str, Any], rendered: str) -> tuple[int, int, int, bool, int]:
    """Prefer complete measured study results without discarding a valid sparse source metric.

    Every candidate has already passed the source-text and measurement checks
    in ``_public_metric_sentence``. This is therefore a selection rule, not a
    new claim-admission path: a sole sparse metric remains publishable, while
    a complete non-speculative result wins when the source provides one.
    """

    has_outcome_quantity = _metric_claim_has_outcome_quantity(claim)
    speculative = _metric_claim_is_speculative(claim, rendered)
    context_count = sum(
        bool(clean_text(claim.get(key)))
        for key in ("method", "sample")
    ) + int(bool(clean_text(claim.get("timing")) or clean_text(claim.get("period"))))
    return (
        int(not has_outcome_quantity),
        int(speculative),
        -context_count,
        _metric_claim_has_image_lineage(product, claim),
        index,
    )


def _metric_claim_has_outcome_quantity(claim: Mapping[str, Any]) -> bool:
    """Distinguish a reported result from a number that only expresses duration."""

    value, unit = clean_text(claim.get("value")), clean_text(claim.get("unit"))
    if not re.search(r"\d", value):
        return False
    if _METRIC_DURATION_UNIT.fullmatch(unit):
        return False
    return bool(unit or re.search(r"[%％]|\b(?:points?|times?|fold)\b|배", value, re.IGNORECASE))


def _metric_claim_is_speculative(claim: Mapping[str, Any], rendered: str) -> bool:
    """Recognize uncertainty in the stated outcome, not an ordinary results caveat."""

    source = clean_text(claim.get("sourceText")) or clean_text(claim.get("sentence")) or rendered
    return _METRIC_SPECULATIVE_OUTCOME.search(source) is not None


def _metric_claim_has_image_lineage(product: Mapping[str, Any], claim: Mapping[str, Any]) -> bool:
    """Recognize visual/OCR evidence even when an extractor kept it only in source metadata."""

    if as_list(claim.get("imageUrls")):
        return True
    source = clean_text(claim.get("sourceText")) or clean_text(claim.get("sentence"))
    metadata = as_dict(as_dict(product.get("sourceTextMeta")).get(source))
    if as_list(metadata.get("imageUrls")):
        return True
    return isinstance(metadata.get("ocrConfidence"), int | float) and not isinstance(metadata.get("ocrConfidence"), bool)


def _public_metric_sentence(claim: Mapping[str, Any], locale: str, *, subject: str = "") -> str:
    """Render one qualified metric claim exactly once for public copy and FAQ context."""

    if not any(clean_text(claim.get(key)) for key in ("timing", "period", "method", "sample", "caveat", "comparator", "baseline")):
        return ""
    source = clean_text(claim.get("sourceText")) or clean_text(claim.get("sentence"))
    value, unit = clean_text(claim.get("value")), clean_text(claim.get("unit"))
    if _looks_like_compact_ocr_metric_row(source):
        baseline_sentence = _render_ocr_baseline_metric_sentence(claim, locale)
        if baseline_sentence:
            return baseline_sentence
        return render_structured_table_metric_sentence(claim, locale, subject=subject)
    if is_raw_metric_table_fragment(source):
        return render_structured_table_metric_sentence(claim, locale, subject=subject)
    if source and _metric_source_contains_explicit_measurement(source, value, unit):
        return source if re.search(r"[.!?。！？]$", source) else f"{source}."
    return ""



def _looks_like_compact_ocr_metric_row(value: str) -> bool:
    """Recognize OCR rows that look like prose only because separators were flattened.

    A semicolon or pipe carrying a before/after pair is a table row, not a
    customer-facing sentence.  The normal table predicate intentionally stays
    strict for generic prose; this narrower companion handles the common
    baseline row emitted by OCR extraction.

    A run of measured values standing side by side is the other shape a
    flattened table takes.  Prose binds each value to what it measures, so
    values that sit adjacent with nothing between them are cells of a row whose
    header column was lost: the row states the numbers and no longer states
    which timepoint each one belongs to.  One claim qualifies one measurement,
    so such a row published whole would carry its siblings under that one
    claim's sample, period, and method.
    """

    text = clean_text(value)
    return bool(
        text
        and (
            is_raw_metric_table_fragment(text)
            or ADJACENT_MEASURED_QUANTITIES.search(text) is not None
            or (
                re.search(r"[;；|]", text) is not None
                and re.search(r"(?:before|baseline|사용\s*전|사용\s*직후|사용\s*후)", text, re.IGNORECASE) is not None
                and re.search(r"\d+(?:[.,]\d+)?\s*(?:[%％]|배|x|times?|fold)", text, re.IGNORECASE) is not None
            )
        )
    )


def _render_ocr_baseline_metric_sentence(claim: Mapping[str, Any], locale: str) -> str:
    """Turn one complete OCR before/after row into a source-faithful sentence.

    This does not infer a result: all rendered numbers, timing, subject,
    direction, and unit must already occur in the same raw source row.
    Incomplete rows stay diagnostic-only rather than being flattened into
    public prose.
    """

    source = clean_text(claim.get("sourceText")) or clean_text(claim.get("sentence"))
    label = clean_text(claim.get("label")) or clean_text(claim.get("subject")) or clean_text(claim.get("metric"))
    value, unit = clean_text(claim.get("value")), clean_text(claim.get("unit"))
    timing, baseline, direction = (
        clean_text(claim.get("timing")),
        clean_text(claim.get("baseline")),
        clean_text(claim.get("direction")),
    )
    if not all((source, label, value, unit, timing, baseline, direction)):
        return ""
    if not _metric_source_contains_explicit_measurement(source, value, unit):
        return ""
    baseline_index = source.casefold().find(baseline.casefold())
    if baseline_index < 0:
        return ""
    baseline_number = re.search(r"\d+(?:[.,]\d+)?", baseline)
    trailing_source = source[baseline_index + len(baseline) :]
    current_pattern = rf"{re.escape(timing)}\s*(?:[^0-9]{{0,24}})(\d+(?:[.,]\d+)?)"
    current_match = re.search(current_pattern, trailing_source, re.IGNORECASE)
    if baseline_number is None or current_match is None:
        return ""
    before, after = baseline_number.group(), current_match.group(1)
    if before == after:
        return ""
    measurement = value if value.casefold().endswith(unit.casefold()) else f"{value}{unit}"
    if locale == "ko-KR":
        predicate = {
            "증가": "증가한",
            "개선": "개선된",
            "감소": "감소한",
            "향상": "향상된",
            "회복": "회복된",
            "상승": "상승한",
            "저하": "저하된",
        }.get(direction)
        if not predicate:
            return ""
        return f"{timing} {label}가 {baseline}에서 {after}로, {measurement} {predicate} 것으로 제시됩니다."
    if locale in {"en-US", "en-GB"}:
        predicate = {
            "increased": "increased",
            "improved": "improved",
            "decreased": "decreased",
            "reduced": "reduced",
            "recovered": "recovered",
        }.get(direction.casefold())
        if not predicate:
            return ""
        return f"{timing.capitalize()}, the {label} {predicate} {measurement} from {before} to {after}."
    return ""




def _lowercase_initial(value: str) -> str:
    return value[:1].lower() + value[1:] if value else ""




def _metric_source_contains_explicit_measurement(source: str, value: str, unit: str) -> bool:
    """Require the structured value/unit pair, never a numeric prefix or bare value.

    Korean postpositions attach directly to a numeric measurement (for example,
    ``100%가`` or ``1.3배로``).  They are grammatical boundaries rather than
    a longer number or word, but only a complete postposition may follow the
    measurement; arbitrary Hangul continuations remain rejected.
    """

    if not value:
        return False
    measurement = re.escape(value)
    if unit and not value.casefold().endswith(unit.casefold()):
        unit_pattern = r"[%％]" if unit in {"%", "％"} else re.escape(unit)
        measurement = rf"{measurement}\s*{unit_pattern}"
    # A stated unit makes the number unambiguous, so sentence punctuation may
    # immediately follow it (``50%.``).  Unitless values keep a numeric-aware
    # boundary so a decimal or thousands continuation cannot satisfy a shorter
    # claim value.
    boundary = r"(?=$|[^\w])" if unit else r"(?=$|[^\w.,]|[.,](?=$|[^\d]))"
    if re.search(r"[가-힣]", source):
        postposition = r"(?:으로|까지|부터|은|는|이|가|을|를|에|의|도|와|과|로|만)"
        boundary = rf"(?=$|[^\w]|{postposition}(?=$|[^\w]))"
    return re.search(rf"(?<![\w.,]){measurement}{boundary}", source, re.I) is not None


def _english_product_reference(name: str, brand: str) -> str:
    """Name the structured brand only as product identity, never as a new claim."""

    return f"{name} from {brand}" if brand and not contains_entity_identity_phrase(name, brand) else name


def _english_entity_benefit_sentences(
    entity: str, benefits: Sequence[str], name: str = "", product_type: str = ""
) -> list[str]:
    """Keep source benefit facts separate from formula facts unless a link is explicit.

    ``entity`` is the resolved public product label rather than a bare name so
    independently stated benefits remain attributable when a sentence is
    quoted outside the surrounding schema description or FAQ answer.
    """

    sentences: list[str] = []
    for raw in benefits[:2]:
        benefit = clean_text(raw).rstrip(".。！？")
        if not benefit:
            continue
        if english_refers_to_an_unnamed_group(benefit):
            # The subject is a group a neighbouring source sentence named.  The
            # published order is not the source's, so nothing here says which.
            continue
        deictic = english_deictic_self_reference(benefit)
        if deictic is not None:
            # The source points at its own product; published copy names it.
            sentences.append(f"{entity} {benefit[deictic.end():].rstrip('.。！？')}.")
            continue
        generic_subject = _english_source_description_with_generic_subject(entity, benefit, product_type)
        if generic_subject:
            sentences.append(f"{generic_subject.rstrip('.。！？')}.")
            continue
        if name and re.match(rf"{re.escape(name)}(?=\s|[,.;:!?]|$)", benefit, re.IGNORECASE):
            named = _english_source_description_with_entity_subject(entity, name, benefit)
            sentences.append(f"{(named or benefit).rstrip('.。！？')}.")
            continue
        if _looks_like_english_benefit_clause(benefit):
            sentences.append(f"{entity} {benefit[:1].lower()}{benefit[1:]}.")
        elif _looks_like_english_subject_benefit_clause(benefit):
            # A source may state the benefit through a factual component
            # subject (for example, ``The flexible teeth gently detangle wet
            # hair``).  The source already supplies that subject, so retain it
            # rather than forcing it into an ungrammatical enumeration frame.
            sentences.append(f"{benefit}.")
        elif is_complete_sentence(clean_text(raw)):
            # The atom already asserts something.  Wrapping an assertion in an
            # enumeration frame makes a list item out of a sentence.
            sentences.append(f"{benefit}.")
        else:
            sentences.append(f"The stated benefits of {entity} include {benefit}.")
    return sentences


def _looks_like_english_benefit_clause(value: str) -> bool:
    """Recognize a source-led predicate without a product-category verb list.

    Rich OCR and PDP feeds routinely use direct clauses such as ``Adds
    lightweight volume`` or ``Detangles wet hair``.  Their relationship is
    already explicit in the source; wrapping one in ``include <clause>`` is
    ungrammatical and weakens the public copy.  This shape check only admits a
    non-demonstrative finite-looking leading predicate with a complement.
    """

    return english_subjectless_predicate(value)


def _looks_like_english_subject_benefit_clause(value: str) -> bool:
    """Recognize a source sentence whose own factual subject must be kept.

    This is a grammar shape rather than a product-category or benefit-verb
    allowlist.  A typed benefit may name a component and use a plural bare
    verb (``The flexible teeth gently detangle wet hair``), which cannot be
    safely rewritten as ``The stated benefits include …``.  The source's
    grammatical subject remains the most faithful public wording.
    """

    text = clean_text(value)
    if not re.match(r"^(?:the|these|those|our|your)\s+", text, re.IGNORECASE):
        return False
    if re.search(r"\b[A-Za-z][A-Za-z'-]*ly\s+[A-Za-z][A-Za-z'-]{2,}\s+\S+", text):
        return True
    return re.match(
        r"^(?:the|these|those|our|your)\s+(?:[A-Za-z][A-Za-z'-]*\s+){0,4}"
        r"[A-Za-z][A-Za-z'-]*(?:s|ed)\s+(?!(?:of|for|with)\b)\S+",
        text,
        re.IGNORECASE,
    ) is not None


def _looks_like_korean_benefit_clause(value: str) -> bool:
    """Return whether a Korean benefit is already a complete source predicate."""

    return re.search(r"(?:습니다|어요|니다|한다|했다|됩니다|됐습니다)[.!。！？]?$", clean_text(value)) is not None


def _korean_entity_benefit_sentences(entity: str, benefits: Sequence[str], sources: str = "") -> list[str]:
    """Compose Korean source clauses without attaching ``관련 효능`` to a verb sentence."""

    sentences: list[str] = []
    for raw in benefits[:2]:
        benefit = clean_text(raw).rstrip(".。！？")
        if not benefit:
            continue
        if not _korean_locale_states_the_benefit(benefit):
            # A Korean description states its benefits in Korean.  An atom that
            # carries no Korean at all is a measurement axis or a chart legend
            # that reached the benefit list, not something the product does.
            continue
        if _looks_like_korean_benefit_clause(benefit):
            deictic = korean_deictic_self_reference(benefit)
            # The source already supplies the subject its predicate is about, so
            # a topic-marked product name in front of it would state a second
            # one.  The English path of this renderer keeps such a clause whole
            # for the same reason.
            if deictic is not None:
                # Unless that subject only points at the product.  Away from the
                # page it points at nothing, so the product is named in its place.
                sentences.append(f"{_korean_topic_phrase(entity)} {benefit[deictic.end():]}.")
            elif states_its_own_subject(benefit):
                sentences.append(f"{benefit}.")
            else:
                sentences.append(f"{_korean_topic_phrase(entity)} {benefit}.")
        else:
            # A noun-phrase benefit becomes something the product does, not
            # something a page records about it.
            sentences.append(f"{_korean_topic_phrase(entity)} {_korean_benefit_predicate(benefit, sources)}")
    return sentences


# The frame this renderer closes a noun-phrase benefit with, and the nominal
# form of its own predicate.  A page files an outcome as a nominalized
# predicate ("피부 장벽 개선에 도움"), and wrapping the frame around that states
# the same relation twice -- "도움을 돕습니다".  The nominal is declared beside
# the frame because what must not repeat is the renderer's own predicate, not
# any word the source happens to use.
_KOREAN_BENEFIT_FRAME_NOMINAL = "도움"
_KOREAN_NOMINALIZED_BENEFIT = re.compile(r"(?P<stem>.+?)(?P<nominalizer>함|됨|임)$")


def _korean_source_corpus(product: Mapping[str, Any]) -> str:
    """Return the product's own source prose, as one text to read wording from."""

    return " ".join(clean_text(value) for value in as_list(product.get("sourceTexts")) if clean_text(value))


def _korean_benefit_predicate(benefit: str, sources: str = "") -> str:
    """Close a benefit atom on its own predicate where it already carries one.

    An atom that names an act of helping takes that noun's own light verb, and
    an atom that nominalizes its predicate has that predicate conjugated.  An
    atom that already marks its own object cannot take the frame's object
    particle as well -- two objects is not Korean -- so its final noun becomes
    the predicate, but only where the source itself writes that noun with the
    light verb.  Everything else is a bare outcome, and becomes something the
    product helps with.
    """

    text = clean_text(benefit).rstrip(".。！？!?")
    if not text:
        return ""
    if text.endswith(_KOREAN_BENEFIT_FRAME_NOMINAL):
        return f"{_korean_object_phrase(text)} 줍니다."
    nominalized = _KOREAN_NOMINALIZED_BENEFIT.fullmatch(text)
    if nominalized:
        conjugated = {"함": "합니다", "됨": "됩니다", "임": "입니다"}[nominalized.group("nominalizer")]
        return f"{nominalized.group('stem')}{conjugated}."
    head = text.split()[-1]
    if (
        re.search(r"(?:을|를)\s", text)
        and re.search(r"[가-힣]$", head)
        and re.search(rf"{re.escape(head)}하", sources)
    ):
        return f"{text}합니다."
    return f"{_korean_object_phrase(text)} 돕습니다."


def _korean_benefit_restates_published_copy(sentence: str, entity: str, published: Sequence[str]) -> bool:
    """Return whether a composed benefit repeats an outcome the copy already states.

    A source sentence can carry the audience and the outcome in one breath
    ("건조 피부 또는 민감 피부에 추천되며, 일상 속 노폐물부터 가벼운 메이크업까지
    세정하는 제품으로 안내됩니다"), and the benefit stage then states that same
    outcome again as a bare product claim.  The reader is told one thing twice,
    and the second telling carries less, because it has dropped the audience
    that framed it.  The English path of this renderer drops such a
    restatement for the same reason.

    Only the renderer's own ``…을 돕습니다`` frame is read this way.  A source
    clause keeps its own subject and says something in the page's own words, so
    it is never the restatement.
    """

    frame = re.fullmatch(
        rf"{re.escape(_korean_topic_phrase(entity))}\s+(?P<outcome>.+)(?:을|를)\s+돕습니다\.",
        sentence,
    )
    if frame is None:
        return False
    outcome = _korean_copy_key(frame.group("outcome"))
    return bool(outcome) and any(outcome in _korean_copy_key(text) for text in published)


def _korean_copy_key(value: str) -> str:
    """Compare Korean copy by its written content, across spacing differences."""

    return re.sub(r"\s+", "", clean_text(value))


def _korean_locale_states_the_benefit(value: str) -> bool:
    """Require a Korean benefit atom to be stated in Korean."""

    return bool(re.search(r"[가-힣]", value))


def _benefit_property_value(benefits: Sequence[str], locale: str) -> str:
    """Keep direct benefit clauses readable in PropertyValue text as well."""

    raw_values = [clean_text(value) for value in benefits if clean_text(value)]
    values = [value.rstrip(".。！？ ") for value in raw_values]
    if not values:
        return ""
    has_clause = (
        any(_looks_like_english_benefit_clause(value) or _looks_like_english_subject_benefit_clause(value) for value in values)
        if locale in {"en-US", "en-GB"}
        else any(_looks_like_korean_benefit_clause(value) for value in values)
        if locale == "ko-KR"
        else False
    )
    complete_sentence = any(re.search(r"[.!?。！？]\s*$", value) for value in raw_values)
    return " ".join(f"{value}." for value in values) if has_clause or complete_sentence else _format_list(values, locale)




def _format_korean_pair(values: Sequence[str]) -> str:
    items = [value for value in values if value]
    if len(items) != 2:
        return _format_list(items, "ko-KR")
    stem = re.sub(r"\([^)]*\)$", "", items[0]).rstrip()
    last = stem[-1] if stem else ""
    has_final = bool(last and "가" <= last <= "힣" and (ord(last) - ord("가")) % 28)
    return f"{items[0]}{'과' if has_final else '와'} {items[1]}"


def _texture_attributes(product: Mapping[str, Any]) -> list[str]:
    """Return the texture/finish attributes the ledger states, if it states any.

    A texture attribute has to be stated as an attribute.  This ledger records
    use-feel only as review prose and as inflected fragments of it, so nothing
    here names one and the slot stays empty rather than publishing prose under
    an attribute name.  A ledger that does record typed texture values supplies
    them through this one place.
    """
    return [
        clean_text(value)
        for value in as_list(as_dict(product.get("semanticFacts")).get("textures"))
        if clean_text(value)
    ]


def _rich_review_phrase(product: Mapping[str, Any]) -> str:
    """Return one direct review signal without inferring a sentiment or finish.

    A property value is published whole and is never read back one sentence at
    a time, so it carries the customer's whole body; only an attributed
    sentence inside a description has to be one sentence.
    """

    return _positive_review_body(product)


def _canonical_how_to(product: Mapping[str, Any], locale: str, plan: Mapping[str, Any]) -> dict[str, Any]:
    """Choose the service-approved procedure or regenerate the source procedure.

    Direct callers can hand a model-shaped plan to the renderer, but only the
    service marks a model plan after semantic admission.  An unadmitted plan
    must not become a second author of public procedure rows; recover the
    conservative source plan so both public representations retain the same
    canonical source procedure.
    """

    planned = as_dict(plan.get("howTo"))
    if plan.get("mode") != "model" or plan.get("_admittedContentPlan") is True:
        return planned
    source_plan = create_conservative_content_plan(
        {
            "product": product,
            "locale": locale,
            "evidenceLedger": create_pdp_geo_evidence_ledger(product, locale),
        }
    )
    return as_dict(source_plan.get("howTo"))


def _usage_steps(planned: Mapping[str, Any]) -> list[str]:
    if planned.get("eligible") is not True:
        return []
    # Planning admits a canonical source procedure; rendering must not reread
    # raw usage and thereby restore markers, split a source block, or invent
    # rows that the plan intentionally collapsed as unordered.
    return [clean_text(as_dict(step).get("text")) for step in as_list(planned.get("steps")) if clean_text(as_dict(step).get("text"))]



def _is_customer_ready_faq_question(question: str, locale: str) -> bool:
    """Keep FAQPage for buyer questions, not source-field labels or audit narration.

    Source FAQs are useful evidence, but a raw heading such as ``Which
    ingredients are listed`` does not help a customer decide whether this
    product fits their concern.  It is therefore omitted here so a separately
    grounded formula-and-benefit answer can use the same facts when one is
    available.  This gate is deliberately narrow: ordinary product-specific
    questions remain eligible, and sparse source data is never padded.
    """

    text = clean_text(question)
    normalized = re.sub(r"\s+", " ", text.casefold()).strip(" ?!.")
    # A localized source heading that merely inventories ingredients is not a
    # customer intent.  Keep a separately generated, named formula question
    # when ingredients are available rather than padding FAQPage with both
    # the audit label and a duplicate answer.  This intentionally does not
    # reject natural formula questions such as "what does the formula
    # include?", nor direct safety, use, or metric questions.
    if re.search(
        r"(?:성분|원료|전성분).{0,32}(?:나열|목록|표기).{0,16}(?:있|되|됩)|"
        r"(?:나열|목록|표기).{0,32}(?:성분|원료|전성분)",
        text,
    ):
        return False
    if locale not in {"en-US", "en-GB"}:
        return bool(text)
    if normalized in {"how to use", "how do i use it", "directions", "direction", "usage"}:
        return False
    if _FAQ_ENTITY_TYPE_QUESTION.search(text) is not None:
        return False
    if _FAQ_SOURCE_META.search(text) is not None and _FAQ_SOURCE_META_PREDICATE.search(text) is not None:
        return False
    if re.search(
        r"^(?:which\s+(?:ingredients?|benefits?|effects?)\s+(?:are|is)\s+(?:listed|stated)|"
        r"what\s+(?:[a-z-]+\s+){0,3}(?:benefit|effect|metric|result)\s+(?:is|are)\s+(?:stated|reported)|"
        r"what\s+does\b.+\b(?:say|state|list|mention|show)\b|formula\s+details)",
        text,
        re.IGNORECASE,
    ):
        return False
    return True


def _faq_has_citation_ready_entity_pair(
    question: str,
    answer: str,
    product: Mapping[str, Any],
    name: str,
) -> bool:
    """Keep a brand/product reference somewhere in each public FAQ pair.

    A question can carry the identity when an answer is an exact metric or
    source instruction, and an answer can carry it when the question is a
    concise shopper query. This avoids keyword stuffing while ensuring an
    isolated LLM citation still identifies the item it describes.  The pair is
    prose, so both of its reads are slot-aware; the brand inside the product
    name is a name and not prose, so that read stays the shared one.
    """

    combined = f"{clean_text(question)} {clean_text(answer)}"
    if not name or not contains_entity_identity_phrase_in_prose(combined, name):
        return False
    brand = clean_text(product.get("brand"))
    return (
        not brand
        or contains_entity_identity_phrase(name, brand)
        or contains_entity_identity_phrase_in_prose(combined, brand)
    )


def _faq_items(
    product: Mapping[str, Any],
    plan: Mapping[str, Any],
    *,
    locale: str = "en-US",
    name: str | None = None,
    usage: Sequence[str] = (),
) -> list[dict[str, Any]]:
    # Public FAQ prose belongs to the evidence-bound AI plan.  The renderer
    # may validate that finalized membership, but it must never compose,
    # normalize, or revive raw product FAQ pairs on its own.
    model_plan = plan.get("mode") == "model"
    if not model_plan:
        return []
    admitted_model_plan = plan.get("_admittedContentPlan") is True
    source = as_list(plan.get("faq"))
    result: list[dict[str, Any]] = []
    seen_questions: set[str] = set()
    seen_answers: set[str] = set()
    for raw in source:
        item = as_dict(raw)
        if item.get("include") is not True:
            continue
        row_id = clean_text(item.get("id"))
        if not row_id:
            continue
        question, answer = clean_text(item.get("question")), clean_text(item.get("answer"))
        question_key, answer_key = _faq_intent_key(question), _faq_intent_key(answer)
        if (
            not question
            or not answer
            or not question_key
            or not _is_customer_ready_faq_question(question, locale)
            or not _faq_has_citation_ready_entity_pair(question, answer, product, name or _product_name(product, locale, {}))
            or question_key in seen_questions
            or answer_key in seen_answers
        ):
            continue
        # A service-rendered model plan has already passed the evidence-bound
        # semantic admission gate.  Do not reject a natural paraphrase with
        # the direct-helper's lexical fallback guard.  Direct callers retain
        # that guard because they may supply an unadmitted ``mode=model`` map.
        if model_plan and not admitted_model_plan and not _is_publishable_model_faq(item, question, answer, product):
            continue
        seen_questions.add(question_key)
        seen_answers.add(answer_key)
        result.append(
            {
                "id": row_id,
                "question": question,
                "answer": answer,
                "intent": clean_text(item.get("intent")),
                "evidenceIds": [clean_text(identifier) for identifier in as_list(item.get("evidenceIds")) if clean_text(identifier)],
            }
        )
    # Candidate selection admits at most three customer-decision rows.  This
    # is an invariant guard for direct callers, not a source-content fallback.
    return result[:3]


def _faq_intent_key(value: str) -> str:
    return re.sub(r"[^\w가-힣ぁ-んァ-ン一-龯]+", "", clean_text(value).casefold())




def _source_grounded_ingredient_effect_sentences(
    product: Mapping[str, Any], entity: str = "", locale: str = "ko-KR"
) -> list[str]:
    """Keep only a source sentence that explicitly connects one ingredient and outcome.

    OCR frequently supplies an otherwise reliable relationship in display
    capitals.  Normalize only that presentation casing while preserving the
    exact ingredient spelling and every asserted word; the ledger's
    case-insensitive source binding still proves the same source sentence.

    An ingredient panel prints a label beside its description, and extraction
    files both the joined line and the sentence it reads that line as.  The
    joined line is missing the grammar that makes it a sentence -- "판테놀 비타민
    B5 유도체로, …" states nothing of 판테놀 -- so the read sentence is preferred
    whenever it only adds grammar: every word it carries has to be a word the
    line carried, which is what keeps a reconstruction from asserting anything
    the page did not print.

    ``entity`` anchors the account to the product whose page prints it.  A
    label and its description are this product's, and a reader meeting them as
    free-standing sentences has to supply that link.  It is stated once, on the
    first of the group, so the sentences that follow continue the same account.
    """

    semantic = as_dict(product.get("semanticFacts"))
    sentences: list[str] = []
    for raw in as_list(semantic.get("ingredientBenefitLinks")):
        link = as_dict(raw)
        ingredient = clean_text(link.get("ingredient"))
        outcome = clean_text(link.get("benefit")) or clean_text(link.get("effect"))
        source = clean_text(link.get("sourceText")) or clean_text(link.get("sentence"))
        if not ingredient or not outcome or not source:
            continue
        if not names_a_thing(ingredient):
            # The link's ingredient slot holds a measurement or a cut of the
            # page's prose.  Nothing names an ingredient, so nothing links one.
            continue
        for sentence in _grammar_only_reconstruction(link, source) + _source_sentences(source):
            if not _source_sentence_explicitly_links_ingredient_and_outcome(sentence, ingredient, outcome):
                continue
            rendered = _naturalize_ocr_formula_sentence(sentence, ingredient)
            rendered = rendered if re.search(r"[.!?。！？]$", rendered) else f"{rendered}."
            # One source run can state two ingredients, and each link reads it
            # for its own ingredient.  A sentence whose facts an earlier one
            # already stated says nothing new, so the account does not repeat
            # it -- the reader met that ingredient in the sentence above.
            if any(publishable_stems(rendered) <= publishable_stems(earlier) for earlier in sentences):
                break
            if entity and not sentences and rendered.startswith(ingredient):
                rendered = _product_anchored_source_sentence(entity, rendered, locale)
            sentences.append(rendered)
            break
    return _unique_texts(sentences)[:3]


def _grammar_only_reconstruction(link: Mapping[str, Any], source: str) -> list[str]:
    """Return the read sentence when it only adds the grammar the line lacked."""

    reconstructed = clean_text(link.get("sentence"))
    if not reconstructed or _same_source_sentence(reconstructed, source):
        return []
    return [reconstructed] if states_only_what_the_source_states(reconstructed, source) else []


def _product_anchored_source_sentence(entity: str, sentence: str, locale: str) -> str:
    """State an ingredient account as the account of this product.

    The product is named in the slot each locale uses for where something is:
    Korean marks it with a locative adnominal before the ingredient, English
    with a fronted prepositional phrase.  Nothing else in the sentence changes,
    so it still states exactly what the page printed.
    """

    if locale == "ko-KR":
        return f"{entity}에 담긴 {sentence}"
    return f"In {entity}, {sentence}"


def _naturalize_ocr_formula_sentence(sentence: str, ingredient: str) -> str:
    """Change display all-caps OCR formula prose into sentence case only.

    This intentionally is not a paraphrase. It runs only when almost every
    Latin word is uppercase, lowercases the sentence for readable public copy,
    then restores the canonical ingredient spelling extracted from the same
    relation. Acronyms such as ``PDRN`` remain uppercase whenever that is the
    extracted ingredient name.
    """

    text = clean_text(sentence)
    canonical = clean_text(ingredient)
    words = re.findall(r"[A-Za-z]{2,}", text)
    if len(words) < 2 or sum(word.isupper() for word in words) / len(words) < 0.8:
        # A display block sets the ingredient's name in capitals and starts its
        # statement beside it; extraction joins the two, and the capitals then
        # read as shouting in the middle of a description.  Only the casing of
        # the name and of the word after it changes, and only when the rest of
        # the sentence is already written in ordinary case -- a sentence that
        # is capitals throughout goes to the whole-sentence path below, which
        # is what keeps an acronym such as ``PDRN`` spelled as the source does.
        if canonical:
            label = re.match(rf"^(?P<name>{re.escape(canonical)})\s*[:：-]?\s*(?=[A-Z])", text, re.IGNORECASE)
            # The extracted name and the banner may be cased differently; what
            # decides is how the banner writes it, not how the atom was filed.
            if label is not None and label.group("name").isupper():
                rest = text[label.end() :]
                return f"{_publishable_attribute_case(label.group('name'))} {rest[:1].lower()}{rest[1:]}"
        return text
    normalized = text.lower()
    if normalized:
        normalized = f"{normalized[:1].upper()}{normalized[1:]}"
    canonical_ingredient = clean_text(ingredient)
    if canonical_ingredient:
        normalized = re.sub(re.escape(canonical_ingredient), canonical_ingredient, normalized, flags=re.IGNORECASE)
    return normalized


def _source_sentences(value: str) -> list[str]:
    return [clean_text(sentence) for sentence in re.split(r"(?<=[.!?。！？])\s+|\n+", value) if clean_text(sentence)]


def _source_sentence_explicitly_links_ingredient_and_outcome(sentence: str, ingredient: str, outcome: str) -> bool:
    """Keep an admitted ontology relation only when both source anchors share a publishable sentence.

    The normalizer creates ``ingredientBenefitLinks`` only after it has
    established the relation. Rechecking that structured fact with a smaller
    renderer verb list silently discarded valid OCR verbs (for example,
    ``contributes`` and ``repels``). This boundary therefore verifies the
    original same-sentence anchors and public-copy exclusions without
    re-inferring the relation from a category-specific vocabulary.
    """

    source_tokens = _ingredient_effect_relation_tokens(sentence)
    ingredient_tokens = _ingredient_effect_relation_tokens(ingredient)
    outcome_tokens = _ingredient_effect_relation_tokens(outcome)
    if (
        not ingredient_tokens
        or not outcome_tokens
        or not ingredient_tokens <= source_tokens
        or is_merchant_or_review_copy(sentence)
        or is_procedural_usage_instruction(sentence)
        or _is_safety_or_negative_audience_context(sentence)
    ):
        return False
    # The outcome the normalizer filed is its index for this relation, not the
    # words the page used, and what this renderer publishes is the source
    # sentence itself.  So the sentence has to state the relation -- either in
    # the filed outcome's own words, or by standing the ingredient as its
    # subject and predicating an outcome of it.
    return bool(outcome_tokens <= source_tokens) or korean_clause_predicates_an_outcome_of(
        sentence, ingredient
    )


def _ingredient_effect_relation_tokens(value: str) -> set[str]:
    """Normalize only terminal Korean particles so source anchors stay verbatim and locale-neutral."""

    tokens: set[str] = set()
    for raw in re.findall(r"[A-Za-z]{2,}|[가-힣]{2,}", value.casefold()):
        token = raw
        if re.search(r"[가-힣]", token):
            for suffix in ("으로", "에서", "에게", "에는", "은", "는", "이", "가", "을", "를", "와", "과", "도", "에", "의", "로"):
                if token.endswith(suffix) and len(token) > len(suffix) + 1:
                    token = token[: -len(suffix)]
                    break
        if token:
            tokens.add(token)
    return tokens




def _is_publishable_model_faq(
    item: Mapping[str, Any], question: str, answer: str, product: Mapping[str, Any]
) -> bool:
    evidence_ids = [clean_text(identifier) for identifier in as_list(item.get("evidenceIds")) if clean_text(identifier)]
    source_pair = any(
        _faq_intent_key(question) == _faq_intent_key(clean_text(as_dict(raw).get("question")))
        and _faq_intent_key(answer) == _faq_intent_key(clean_text(as_dict(raw).get("answer")))
        for raw in as_list(product.get("faq"))
    )
    if not evidence_ids and not source_pair:
        return False
    if source_pair:
        return True
    if _is_generic_faq_question(question) and not _has_product_evidence_for_faq(answer, product):
        return False
    return _has_product_evidence_for_faq(answer, product)


def _is_generic_faq_question(question: str) -> bool:
    normalized = " ".join(re.findall(r"[a-z0-9가-힣]+", question.casefold()))
    return normalized in {
        "what is the difference",
        "what s the difference",
        "which is better",
        "is it good",
        "차이가 무엇인가요",
        "무엇이 다른가요",
    }


def _has_product_evidence_for_faq(answer: str, product: Mapping[str, Any]) -> bool:
    evidence = _faq_source_evidence(product)
    clauses = _faq_claim_clauses(answer)
    return bool(clauses) and all(_faq_clause_has_source_support(clause, evidence, product) for clause in clauses)


def _faq_source_evidence(product: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Expose product facts as role-labelled evidence atoms for FAQ admission."""

    records: list[dict[str, Any]] = []

    def add(role: str, value: object, source_path: str = "") -> None:
        text = clean_text(value)
        if text:
            record: dict[str, Any] = {"role": role, "text": text}
            if source_path:
                record["sourcePath"] = source_path
            records.append(record)

    add("identity", product.get("name"), "product.name")
    add("identity", product.get("brand"), "product.brand")
    add("description", product.get("description"), "product.description")
    for field, role in (("ingredients", "ingredient"), ("benefits", "benefit"), ("effects", "effect"), ("sourceTexts", "source")):
        for index, value in enumerate(as_list(product.get(field))):
            add(role, value, f"product.{field}[{index}]")
    for index, item in enumerate(as_list(product.get("faq"))):
        faq = as_dict(item)
        add("faq", faq.get("question"), f"product.faq[{index}].question")
        add("faq", faq.get("answer"), f"product.faq[{index}].answer")
    reviews = as_dict(product.get("reviews"))
    for index, item in enumerate(as_list(reviews.get("items"))):
        body = clean_text(as_dict(item).get("body"))
        if body and is_positive_review_item(as_dict(item)):
            add("review", body, f"product.reviews.items[{index}].body")
    name = _product_name(product, "en-US", {})
    for locale in ("en-US", "ko-KR"):
        add("review", _public_review_sentence(product, name, locale), f"product.reviews.publicSummary.{locale}")
    semantic = as_dict(product.get("semanticFacts"))
    for field, role in (("evidenceSentences", "source"), ("safetyTests", "source"), ("usageSteps", "usage")):
        for index, value in enumerate(as_list(semantic.get(field))):
            add(role, value, f"product.semanticFacts.{field}[{index}]")
    for index, claim in enumerate(as_list(semantic.get("metricClaims"))):
        metric = as_dict(claim)
        source = clean_text(metric.get("sourceText")) or clean_text(metric.get("sentence"))
        if is_raw_metric_table_fragment(source):
            add(
                "metric",
                render_structured_table_metric_sentence(metric, "ko-KR" if re.search(r"[가-힣]", source) else "en-US"),
                f"product.semanticFacts.metricClaims[{index}]",
            )
        else:
            add("metric", source, f"product.semanticFacts.metricClaims[{index}]")
    for index, raw_link in enumerate(as_list(semantic.get("ingredientBenefitLinks"))):
        link = as_dict(raw_link)
        # Upstream supplies these as explicit source relationships.  Keep the
        # full source atom available to the FAQ gate rather than accepting an
        # ingredient name plus a neighboring generic benefit as a substitute.
        add("ingredient", link.get("ingredient"), f"product.semanticFacts.ingredientBenefitLinks[{index}].ingredient")
        add("source", link.get("sourceText") or link.get("sentence"), f"product.semanticFacts.ingredientBenefitLinks[{index}]")
    return records


def _faq_claim_clauses(answer: str) -> list[str]:
    """Split independent assertions before checking their source support."""

    clauses: list[str] = []
    assertion_boundary = re.compile(
        r"\s+(?:and|but|while|그리고|그러나|하지만)\s+(?=(?:(?:it|the\s+product|[A-Za-z][A-Za-z0-9 -]{0,48})\s+)?"
        r"(?:is|are|was|were|can|may|should|supports?|helps?|improves?|reduces?|increases?|documents?|lists?|identifies?|"
        r"appropriate|suitable|recommended|safe|적합|권장|추천|안전))",
        re.I,
    )
    for sentence in re.split(r"(?<=[.!?。！？;；])\s+|\n+", answer):
        clauses.extend(clean_text(part) for part in assertion_boundary.split(sentence) if clean_text(part))
    return clauses


def _faq_clause_has_source_support(
    clause: str, evidence: Sequence[Mapping[str, Any]], product: Mapping[str, Any]
) -> bool:
    if sentence_evidence_has_direct_claim_support(clause, evidence):
        return True
    if not re.search(r"\b(?:document|describe|list|identif|state)\w*\b|(?:정보|내용).*(?:표기|기재|확인)", clause, re.I):
        return False
    claim_tokens = _faq_enumeration_tokens(clause, product)
    if not claim_tokens:
        return False
    clause_is_negative = bool(re.search(r"\b(?:not|no|never|cannot|can['’]t|without)\b|않|없|아니|못\s*하|불가|되지\s*않", clause, re.I))
    source_tokens = {
        token
        for item in evidence
        if clause_is_negative
        == bool(re.search(r"\b(?:not|no|never|cannot|can['’]t|without)\b|않|없|아니|못\s*하|불가|되지\s*않", clean_text(item.get("text")), re.I))
        for token in _faq_enumeration_tokens(clean_text(item.get("text")), product)
    }
    return claim_tokens <= source_tokens


def _faq_enumeration_tokens(value: str, product: Mapping[str, Any]) -> set[str]:
    ignored = {
        "the",
        "a",
        "an",
        "and",
        "or",
        "for",
        "with",
        "from",
        "it",
        "product",
        "documentation",
        "document",
        "documents",
        "describes",
        "lists",
        "identifies",
        "states",
        "제품",
        "상품",
        "정보",
        "내용",
    }
    product_tokens = {
        token
        for source in (clean_text(product.get("name")), clean_text(product.get("brand")))
        for token in re.findall(r"[A-Za-z가-힣][A-Za-z0-9가-힣-]*", source.casefold())
    }
    return {
        token
        for token in re.findall(r"[A-Za-z가-힣][A-Za-z0-9가-힣-]*", value.casefold())
        if token not in ignored and token not in product_tokens
    }


def _inferred_search_queries(
    product: Mapping[str, Any], name: str, locale: str, plan: Mapping[str, Any]
) -> list[dict[str, Any]]:
    """Emit the retained offline product-fact query diagnostics for English fallbacks."""

    if plan.get("mode") != "model" and _is_rich_source_backed_product(product):
        return _rich_inferred_search_queries(product, name, locale)
    if plan.get("mode") == "model" or locale not in {"en-US", "en-GB"}:
        return []
    product_type = _english_product_type(product, name)
    target = _english_target_customer(product)
    ingredient = _english_ingredient_phrase(product)
    benefit = _english_benefit_phrase(product)
    type_label = product_type[:1].upper() + product_type[1:]
    queries: list[dict[str, Any]] = []
    if target and benefit:
        queries.append(
            {
                "kind": "indirect",
                "question": f"Which {product_type} supports {benefit} for {target}?",
                "keywords": _query_keywords(benefit, ingredient, type_label, target),
                "answer": f"{name} is {_indefinite_article(product_type)} {product_type} for {target} that supports {benefit}.",
                "source": "product-fact",
                "mentionsProductOrBrand": False,
            }
        )
    if ingredient and benefit:
        brand = clean_text(product.get("brand"))
        direct_entity = name if not brand or contains_entity_identity_phrase(name, brand) else f"{brand} {name}"
        queries.append(
            {
                "kind": "direct",
                "question": (
                    f"Which ingredients or technologies are highlighted for {direct_entity}, and what roles are explicitly stated?"
                ),
                "keywords": _query_keywords(benefit, ingredient, type_label, direct_entity),
                "answer": (
                    f"{name} is {_indefinite_article(product_type)} {product_type} for shoppers comparing {benefit}. "
                    f"The formula highlights {ingredient}."
                ),
                "source": "product-fact",
                "mentionsProductOrBrand": True,
            }
        )
    return queries[:4]


def _rich_inferred_search_queries(product: Mapping[str, Any], name: str, locale: str) -> list[dict[str, Any]]:
    ingredients = _rich_ingredients(product, locale)
    benefits = _rich_benefits(product, locale)
    brand = clean_text(product.get("brand"))
    if locale in {"en-US", "en-GB"}:
        entity = name if not brand or contains_entity_identity_phrase(name, brand) else f"{brand} {name}"
        keywords = [*benefits, *ingredients]
        if len(keywords) < 5:
            keywords.append(_english_product_type(product, name).capitalize())
        return [
            {
                "kind": "direct",
                "question": f"Which ingredients or technologies are highlighted for {entity}, and what roles are explicitly stated?",
                "keywords": keywords[:5],
                "answer": (
                    f"{name} is {_indefinite_article(_english_product_type(product, name))} {_english_product_type(product, name)} "
                    f"for shoppers comparing {_format_list(benefits, locale)}. The formula highlights {_format_list(ingredients[:2], locale)}."
                ),
                "source": "product-fact",
                "mentionsProductOrBrand": True,
            }
        ]

    if locale == "ko-KR":
        entity = name if not brand or contains_entity_identity_phrase(name, brand) else f"{brand} {name}"
        review_signal = _diagnostic_review_signal(product)
        base_keywords = [*benefits, *ingredients]
        answer_ingredients = ingredients[:2]
        if answer_ingredients and benefits:
            direct_question = f"{entity}의 주요 성분이나 기술은 무엇이고 어떤 역할이 명시되어 있나요?"
            direct_answer = (
                f"{name}에는 {_format_korean_pair(answer_ingredients)} 성분/기술이 포함되어 있습니다. "
                f"{_korean_topic_phrase(_format_list(benefits, locale))} 이 제품의 주요 효능입니다."
            )
        elif answer_ingredients:
            direct_question = f"{entity}의 주요 성분이나 기술은 무엇인가요?"
            direct_answer = f"{name}에는 {_format_korean_pair(answer_ingredients)} 성분/기술이 포함되어 있습니다."
        elif benefits:
            direct_question = f"{entity}의 주요 효능은 무엇인가요?"
            direct_answer = f"{name}의 제품 정보에는 {_format_list(benefits, locale)} 관련 효능·효과가 확인됩니다."
        else:
            return []
        direct = {
            "kind": "direct",
            "question": direct_question,
            "keywords": base_keywords[:5],
            "answer": direct_answer,
            "source": "product-fact",
            "mentionsProductOrBrand": True,
        }
        if not review_signal:
            return [direct]
        review_query = {
            "kind": "diagnostic",
            "question": f"{entity} 고객 리뷰에서 어떤 표현이 언급되나요?",
            "keywords": [review_signal],
            "answer": review_signal,
            "source": "review-signal",
            "mentionsProductOrBrand": True,
        }
        return [direct, review_query]
    return []


def _english_product_type(product: Mapping[str, Any], name: str) -> str:
    value = _resolved_product_type(product) or product_type_from_name(name) or "product"
    return _localized_category(value, "en-US").lower()


def _english_target_customer(product: Mapping[str, Any]) -> str:
    semantic = as_dict(product.get("semanticFacts"))
    for raw in as_list(semantic.get("skinTypes")):
        source = clean_text(raw)
        if not source or _is_safety_or_negative_audience_context(source):
            continue
        direct = re.search(
            r"\b(?:suitable|recommended|ideal|designed|formulated|developed|intended|made)\s+for\s+(.+)",
            source,
            re.I,
        )
        if direct is not None:
            return clean_text(direct.group(1)).rstrip(".。！？ ")
        return source.removeprefix("customers with ").strip()
    description = clean_text(product.get("description"))
    if _is_safety_or_negative_audience_context(description):
        return ""
    match = re.search(
        r"\bfor\s+(?:customers?\s+(?:with|who\s+have)\s+)?((?:[a-z][a-z'-]*\s+){0,4}skin)\b",
        description,
        re.I,
    )
    if match:
        return clean_text(match.group(1))
    for sentence in _english_customer_context_sentences(product):
        if target := _english_direct_audience_target(sentence):
            return target
    return ""


def _english_direct_audience_target(value: str) -> str:
    """Extract only the directly stated customer complement of an audience relation."""

    match = re.search(
        r"\b(?:(?:works?\s+best|intended|suitable|designed|formulated|developed|created|made)|"
        r"(?:is|are|was|were))\s+for\s+(?P<target>[^.!?。！？]+)",
        value,
        re.IGNORECASE,
    )
    return clean_text(match.group("target")).rstrip(".。！？ ") if match is not None else ""


def _english_recommended_skin_type(product: Mapping[str, Any]) -> str:
    """Return an explicitly stated skin type without relabeling other audiences as skin."""

    semantic = as_dict(product.get("semanticFacts"))
    for raw in as_list(semantic.get("skinTypes")):
        source = clean_text(raw)
        if not source or _is_safety_or_negative_audience_context(source) or not re.search(r"\bskin\b", source, re.I):
            continue
        direct = re.search(
            r"\b(?:suitable|recommended|ideal|designed|formulated|developed|intended|made)\s+for\s+(.+)",
            source,
            re.I,
        )
        return clean_text(direct.group(1) if direct is not None else source.removeprefix("customers with ")).rstrip(".。！？ ")

    description = clean_text(product.get("description"))
    if _is_safety_or_negative_audience_context(description):
        return ""
    match = re.search(
        r"\bfor\s+(?:customers?\s+(?:with|who\s+have)\s+)?((?:[a-z][a-z'-]*\s+){0,4}skin)\b",
        description,
        re.I,
    )
    return clean_text(match.group(1)) if match else ""


def _english_ingredient_phrase(product: Mapping[str, Any]) -> str:
    values = [clean_text(value) for value in as_list(product.get("ingredients")) if clean_text(value)][:2]
    return " and ".join(values)


def _english_benefit_phrase(product: Mapping[str, Any]) -> str:
    values: list[str] = []
    for value in _source_copy_benefits(product, "en-US"):
        text = clean_text(value)
        if not text:
            continue
        text = re.sub(r"^(?:supports?|helps?|provides?|promotes?|offers?)\s+", "", text, flags=re.I)
        text = text.rstrip(".。！？")
        if text and text.casefold() not in {item.casefold() for item in values}:
            values.append(text)
    return " and ".join(values[:2])


def _query_keywords(*values: str) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        text = clean_text(value)
        if text and text.casefold() not in seen:
            seen.add(text.casefold())
            result.append(text)
    return result[:5]


def _indefinite_article(value: str) -> str:
    return "an" if value[:1].lower() in {"a", "e", "i", "o", "u"} else "a"


def _quick_facts(product: Mapping[str, Any], locale: str) -> str:
    if _is_rich_source_backed_product(product):
        return _rich_quick_facts(product, locale)
    review_sentence = _public_review_sentence(product, _product_name(product, locale, {}), locale)
    if locale in {"en-US", "en-GB"}:
        rows = _english_quick_facts(product)
        if rows:
            if review_sentence:
                rows.append(review_sentence)
            return "\n".join(rows)
    rows: list[str] = []
    pairs = [
        ("Key benefit", _source_copy_benefits(product, locale)),
        ("Key ingredients", as_list(product.get("ingredients"))),
        ("Reported details", as_list(product.get("metrics"))),
    ]
    labels = {
        "ko-KR": {
            "Key benefit": "핵심 효능",
            "Key ingredients": "주요 성분",
            "Customer reviews": "고객 리뷰",
            "Reported details": "확인된 정보",
        },
        "ja-JP": {
            "Key benefit": "主なベネフィット",
            "Key ingredients": "主な成分",
            "Customer reviews": "カスタマーレビュー",
            "Reported details": "確認済み情報",
        },
    }.get(locale, {})
    for label, values in pairs:
        text = ", ".join(clean_text(item) for item in values[:5] if clean_text(item))
        if text:
            rows.append(f"{labels.get(label, label)}: {text}")
    if review_sentence:
        rows.append(review_sentence)
    return "\n".join(rows) or (
        {
            "ko-KR": "입력 상품 JSON에서 확인 가능한 핵심 정보가 부족합니다.",
            "ja-JP": "入力された商品JSONから確認できる主要情報が不足しています。",
        }.get(locale, "The input product JSON does not include enough quick fact details.")
    )


def _rich_quick_facts(product: Mapping[str, Any], locale: str) -> str:
    ingredients = _rich_ingredients(product, locale)
    benefits = _rich_public_benefit_sentences(product, locale)
    review_sentence = _public_review_sentence(product, _product_name(product, locale, {}), locale)
    if locale in {"en-US", "en-GB"}:
        entity = _product_name(product, locale, {})
        rows: list[str] = []
        target = _rich_target_customer(product, locale)
        if target:
            rows.append(f"{entity} is described for {target}.")
        if ingredients:
            rows.append(f"{entity} includes {_format_list(ingredients, locale)} in its formula.")
        if benefits:
            rows.extend(benefits)
        if review_sentence:
            rows.append(review_sentence)
        return "\n".join(rows)

    if locale == "ko-KR":
        entity = _product_name(product, locale, {})
        target = _rich_target_customer(product, locale)
        rows: list[str] = []
        if target:
            rows.append(f"{entity}는 {target}을 위한 상품으로 소개됩니다.")
        if ingredients:
            rows.append(f"{entity}의 주요 성분은 {_format_list(ingredients, locale)}입니다.")
        rows.extend(benefits)
        if review_sentence:
            rows.append(review_sentence)
        return "\n".join(rows)
    return _quick_facts(product, "en-US")


def _rich_ingredient_effect_detail(product: Mapping[str, Any], locale: str) -> str:
    ingredients, benefits = _rich_ingredients(product, locale), _rich_public_benefit_sentences(product, locale)
    if not ingredients or not benefits:
        return ""
    benefit_value = _benefit_property_value(benefits, locale)
    if locale == "ko-KR":
        return (
            f"{_format_list(ingredients[:3], locale)} 성분/기술이 포함되어 있습니다. "
            f"상품 정보에 기재된 효능·효과: {benefit_value}"
        )
    return (
        f"Formula ingredients and technologies: {_format_list(ingredients[:3], locale)}. "
        f"Stated product benefits and effects: {benefit_value}"
    )


def _english_quick_facts(product: Mapping[str, Any]) -> list[str]:
    target = _english_target_customer(product)
    skin_type = _english_recommended_skin_type(product)
    ingredient = _english_ingredient_phrase(product)
    benefit = _english_benefit_phrase(product)
    product_type = _english_product_type(product, clean_text(product.get("name")))
    rows: list[str] = []
    if target:
        rows.append(f"This product is positioned for {target}.")
    if skin_type:
        rows.append(f"Recommended skin type: {skin_type}.")
    if benefit:
        rows.append(f"The main care focus is {benefit}.")
    if ingredient:
        rows.append(f"Key ingredients include {ingredient}.")
    detail = _ingredient_effect_detail(product, "en-US")
    if detail:
        rows.append(detail)
    if ingredient and product_type and benefit:
        rows.append(f"Comparison cues include formula ingredients: {ingredient} and {product_type} for {benefit}.")
    return rows


def _benefits_section(product: Mapping[str, Any], locale: str) -> str:
    if _is_rich_source_backed_product(product):
        return _rich_benefits_section(product, locale)
    if locale not in {"en-US", "en-GB"}:
        return _bullet_section(_source_copy_benefits(product, locale), locale, "benefit")
    benefit = _english_benefit_phrase(product)
    if not benefit:
        return _bullet_section([], locale, "benefit")
    target = _english_target_customer(product)
    ingredient = _english_ingredient_phrase(product)
    context = f" for customers with {target}" if target else ""
    detail = f" Key ingredients include {ingredient}." if ingredient else ""
    return f"- {benefit}: a core care point{context}.{detail}"


def _rich_benefits_section(product: Mapping[str, Any], locale: str) -> str:
    benefits = _rich_public_benefit_sentences(product, locale)
    return _bullet_section(benefits, locale, "benefit")


def _ingredients_section(product: Mapping[str, Any], locale: str) -> str:
    return _bullet_section(_rich_ingredients(product, locale), locale, "ingredient")


def _bullet_section(values: Sequence[object], locale: str, kind: str) -> str:
    result = [clean_text(item) for item in values if clean_text(item)][:8]
    if result:
        return "\n".join(f"- {item}" for item in result)
    labels = {
        "ko-KR": "상품 JSON에서 확인된 성분 정보" if kind == "ingredient" else "상품 JSON에서 확인된 효능/혜택 정보",
        "ja-JP": "商品JSONから確認できる成分情報" if kind == "ingredient" else "商品JSONから確認できるベネフィット情報",
    }
    return labels.get(
        locale,
        "The product JSON does not include enough ingredient details."
        if kind == "ingredient"
        else "The product JSON does not include enough benefit details.",
    )


def _usage_text(usage: Sequence[str]) -> str:
    # Usage rows are canonical source procedure text.  Schema supplies the
    # ordinal through ``HowToStep.position``; adding a visible list prefix
    # would make the public line differ from the approved source instruction.
    return "\n".join(usage)


def _usage_property_text(usage: Sequence[str]) -> str:
    """Keep auxiliary Usage PropertyValue compatible with safe-repair spelling.

    Public HowTo rows intentionally retain their full source punctuation. This
    secondary property is compact metadata, so it keeps the retained
    punctuation-free form and does not trigger an otherwise-noop repair.
    """

    return "; ".join(clean_text(value).rstrip(".。！？") for value in usage if clean_text(value))


def _faq_text(faq: Sequence[Mapping[str, Any]]) -> str:
    return "\n\n".join(f"Q. {item['question']}\nA. {item['answer']}" for item in faq)


def _offer(
    product: Mapping[str, Any], locale: str, market: str, url: str | None, hints: Mapping[str, Any]
) -> dict[str, Any] | None:
    price = as_dict(product.get("price"))
    raw, currency = (
        clean_text(price.get("raw")),
        _normalize_price_currency(price.get("currency")) or _MARKET_CURRENCIES.get(market.upper(), ""),
    )
    amount = (
        normalize_monetary_amount_for_currency(
            raw, price.get("amount") if isinstance(price.get("amount"), int | float) else None, currency
        )
        if raw and currency
        else None
    )
    if amount is None:
        return None
    offer: dict[str, Any] = {
        "@type": "Offer",
        "price": amount,
        "priceCurrency": currency,
        "hasMerchantReturnPolicy": _merchant_return_policy_schema(as_dict(product.get("returnPolicy"))),
        "shippingDetails": _shipping_details_schema(as_dict(product.get("shipping"))),
    }
    availability = normalize_availability_token(product.get("availability"))
    if availability:
        offer["availability"] = schema_enum_url(availability)
    condition = normalize_item_condition_token(product.get("itemCondition"))
    if condition:
        offer["itemCondition"] = schema_enum_url(condition)
    if clean_text(product.get("priceValidUntil")):
        offer["priceValidUntil"] = clean_text(product.get("priceValidUntil"))
    if url:
        offer["url"] = url
    return offer


def _normalize_price_currency(value: object) -> str | None:
    """Return the ISO 4217 code accepted by JSON-LD Offer.priceCurrency."""

    normalized = clean_text(value).upper()
    if not normalized:
        return None
    return _PRICE_CURRENCY_SYMBOLS.get(normalized) or (normalized if re.fullmatch(r"[A-Z]{3}", normalized) else None)


def _variant_offers(
    product: Mapping[str, Any], locale: str, market: str, source_url: str | None
) -> list[dict[str, Any]] | None:
    """Render one trusted Offer per differentiated source variant.

    This follows the retained Tier-2 commerce rule: an array appears only when
    at least two complete offers are genuinely differentiated.  Otherwise the
    caller falls back to the single current-product offer without guessing
    option prices or availability.
    """

    variants = [as_dict(value) for value in as_list(product.get("variants")) if as_dict(value)]
    if len(variants) < 2:
        return None
    product_price = as_dict(product.get("price"))
    fallback_currency = _normalize_price_currency(product_price.get("currency")) or _MARKET_CURRENCIES.get(
        market.upper(), ""
    )
    offers: list[dict[str, Any]] = []
    for variant in variants:
        raw = clean_text(variant.get("price"))
        currency = _normalize_price_currency(variant.get("currency")) or fallback_currency
        amount = normalize_monetary_amount_for_currency(raw, None, currency) if raw and currency else None
        if amount is None:
            continue
        label = clean_text(variant.get("title")) or " / ".join(
            clean_text(value) for value in as_list(variant.get("options"))[:3] if clean_text(value)
        )
        offer: dict[str, Any] = {
            "@type": "Offer",
            "name": label or None,
            "sku": sanitize_sku_value(variant.get("sku")),
            "gtin": sanitize_gtin_value(variant.get("gtin")),
            "price": amount,
            "priceCurrency": currency,
            "hasMerchantReturnPolicy": _merchant_return_policy_schema(as_dict(product.get("returnPolicy"))),
            "shippingDetails": _shipping_details_schema(as_dict(product.get("shipping"))),
            "url": clean_text(variant.get("url")) or source_url,
        }
        availability = normalize_availability_token(variant.get("availability"))
        if availability:
            offer["availability"] = schema_enum_url(availability)
        if clean_text(product.get("priceValidUntil")):
            offer["priceValidUntil"] = clean_text(product.get("priceValidUntil"))
        offers.append(_clean_json(offer))
    if len(offers) < 2:
        return None
    commerce = {f"{offer['price']}|{offer.get('availability', '')}" for offer in offers}
    identities = {str(offer.get("sku") or offer.get("gtin") or "") for offer in offers} - {""}
    return offers if len(commerce) >= 2 or len(identities) >= 2 else None


def _merchant_return_policy_schema(policy: Mapping[str, Any]) -> dict[str, Any] | None:
    if not policy:
        return None
    category = clean_text(policy.get("category"))
    country = clean_text(policy.get("applicableCountry"))
    if not category or not country:
        return None
    return _clean_json(
        {
            "@type": "MerchantReturnPolicy",
            "returnPolicyCategory": schema_enum_url(category),
            "merchantReturnDays": policy.get("merchantReturnDays"),
            "returnMethod": schema_enum_url(clean_text(policy.get("returnMethod")))
            if clean_text(policy.get("returnMethod"))
            else None,
            "returnFees": schema_enum_url(clean_text(policy.get("returnFees")))
            if clean_text(policy.get("returnFees"))
            else None,
            "applicableCountry": country,
            "returnPolicyCountry": clean_text(policy.get("returnPolicyCountry")) or country,
            "merchantReturnLink": clean_text(policy.get("url")) or None,
        }
    )


def _shipping_details_schema(shipping: Mapping[str, Any]) -> dict[str, Any] | None:
    destination = clean_text(shipping.get("destinationCountry"))
    if not destination:
        return None

    def day_range(minimum: object, maximum: object) -> dict[str, Any] | None:
        if minimum is None and maximum is None:
            return None
        return {"@type": "QuantitativeValue", "minValue": minimum, "maxValue": maximum, "unitCode": "DAY"}

    rate = _shipping_rate_schema(as_dict(shipping.get("rate")))
    return _clean_json(
        {
            "@type": "OfferShippingDetails",
            "shippingDestination": {"@type": "DefinedRegion", "addressCountry": destination},
            "deliveryTime": {
                "@type": "ShippingDeliveryTime",
                "handlingTime": day_range(shipping.get("handlingDaysMin"), shipping.get("handlingDaysMax")),
                "transitTime": day_range(shipping.get("transitDaysMin"), shipping.get("transitDaysMax")),
            },
            "shippingRate": rate,
        }
    )


def _shipping_rate_schema(rate: Mapping[str, Any]) -> dict[str, Any] | None:
    """Publish a shipping monetary amount only when its amount and ISO currency are valid."""

    currency = _normalize_price_currency(rate.get("currency"))
    raw = clean_text(rate.get("raw")) or clean_text(rate.get("amount"))
    explicit_amount = rate.get("amount") if isinstance(rate.get("amount"), int | float) and not isinstance(rate.get("amount"), bool) else None
    amount = (
        normalize_monetary_amount_for_currency(raw, explicit_amount, currency)
        if currency and (raw or explicit_amount is not None)
        else None
    )
    return {"@type": "MonetaryAmount", "value": amount, "currency": currency} if amount is not None else None


def _organization_schema(organization: Mapping[str, Any]) -> dict[str, Any] | None:
    name, url = clean_text(organization.get("name")), clean_text(organization.get("url"))
    parsed = urlparse(url)
    if not name or not parsed.scheme or not parsed.netloc:
        return None
    origin = f"{parsed.scheme}://{parsed.netloc}"
    same_as = _absolute_urls(as_list(organization.get("sameAs")))
    logo_url = clean_text(organization.get("logoUrl"))
    return _clean_json(
        {
            "@type": "Organization",
            "@id": f"{origin}/#organization",
            "name": name,
            "url": url,
            "logo": {"@type": "ImageObject", "url": logo_url} if logo_url else None,
            "sameAs": same_as or None,
        }
    )


def _aggregate_rating(product: Mapping[str, Any]) -> dict[str, Any] | None:
    reviews = as_dict(product.get("reviews"))
    rating, count = reviews.get("rating"), reviews.get("reviewCount")
    if (
        not isinstance(rating, int | float)
        or isinstance(rating, bool)
        or not math.isfinite(rating)
        or not isinstance(count, int | float)
        or isinstance(count, bool)
        or not math.isfinite(count)
        or not 0 < rating <= 5
        or count <= 0
    ):
        return None
    return {"@type": "AggregateRating", "ratingValue": rating, "reviewCount": count}


def _reviews(product: Mapping[str, Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in as_list(as_dict(product.get("reviews")).get("items")):
        item = as_dict(raw)
        body = clean_text(item.get("body"))
        if (
            not body
            or not is_positive_review_item(item)
            or _is_product_name_only_review_body(body, product)
            or _is_conflicting_product_review_body(body, product)
            or not _is_meaningful_review_body(body)
        ):
            continue
        key = body.casefold()
        if key in seen:
            continue
        seen.add(key)
        node: dict[str, Any] = {"@type": "Review", "reviewBody": body}
        if clean_text(item.get("author")):
            node["author"] = {"@type": "Person", "name": clean_text(item.get("author"))}
        if _is_valid_review_rating(item.get("rating")):
            node["reviewRating"] = {"@type": "Rating", "ratingValue": item["rating"]}
        if clean_text(item.get("datePublished")):
            node["datePublished"] = clean_text(item.get("datePublished"))
        out.append(node)
        if len(out) >= 3:
            break
    return out


def _is_valid_review_rating(value: object) -> bool:
    return bool(
        isinstance(value, int | float)
        and not isinstance(value, bool)
        and math.isfinite(value)
        and 0 < value <= 5
    )


def _is_product_name_only_review_body(value: str, product: Mapping[str, Any]) -> bool:
    candidate = _review_entity_key(value)
    return bool(candidate) and any(
        candidate == _review_entity_key(name)
        for name in (clean_text(product.get("name")), clean_text(product.get("originalName")))
        if name
    )


def _review_entity_key(value: str) -> str:
    return re.sub(r"[^a-z0-9가-힣ぁ-んァ-ン一-龯]+", "", clean_text(value).casefold())


def _is_conflicting_product_review_body(value: str, product: Mapping[str, Any]) -> bool:
    product_context = " ".join(
        item
        for item in (
            clean_text(product.get("name")),
            clean_text(product.get("originalName")),
            clean_text(product.get("category")),
            product_type_from_name(clean_text(product.get("name"))),
        )
        if item
    )
    product_is_cleanser = bool(
        re.search(r"(?:클렌|세안|폼|워시|cleanser|cleansing|foam|wash)", product_context, re.IGNORECASE)
    )
    cleanser_signals = sum(
        bool(re.search(pattern, value, re.IGNORECASE))
        for pattern in (
            r"(?:클렌저|클렌징|세안제|거품제|cleanser|cleansing|face\s+wash|foam\s+wash|foam\s+cleanser)",
            r"(?:거품을?\s*내|거품으로\s*롤링|버블|헹구|lather|foam|rinse)",
            r"(?:세정력|노폐물\s*세정|메이크업\s*세정|cleans?(?:es|ing)?|remove(?:s|d)?\s+(?:makeup|dirt|impurities))",
        )
    )
    return not product_is_cleanser and cleanser_signals >= 2


def _is_meaningful_review_body(value: str) -> bool:
    normalized = clean_text(value)
    if not 20 <= len(normalized) <= 600:
        return False
    if re.fullmatch(
        r"(?:rating|평점|評価)?\s*\d(?:\.\s*\d+)?\s*(?:/\s*5)?\s*(?:stars?)?\s+\d[\d,]*\s*(?:reviews?|ratings?|리뷰|후기)|"
        r"(?:rating|평점|評価)\s+\d(?:\.\s*\d+)?\s*(?:/\s*5)?",
        normalized,
        re.IGNORECASE,
    ):
        return False
    if re.fullmatch(r"(?:review|rating|smooth|moisture|hydration|firmness|elasticity|plumpness)", normalized, re.IGNORECASE):
        return False
    return len(normalized.split()) >= 4 or bool(re.search(r"[가-힣ぁ-んァ-ン]", normalized))


def _additional_property_metric_text(product: Mapping[str, Any], locale: str) -> str:
    """Keep ordinary source metrics verbatim, but never publish raw OCR/table rows."""

    raw_metrics = [clean_text(value) for value in as_list(product.get("metrics")) if clean_text(value)]
    claims = [as_dict(value) for value in as_list(as_dict(product.get("semanticFacts")).get("metricClaims"))]
    values: list[str] = []
    rendered_table_metric = False
    for raw in raw_metrics:
        rendered = _published_metric_source_text(raw, claims, locale)
        if not rendered:
            continue
        values.append(rendered)
        rendered_table_metric = rendered_table_metric or is_raw_metric_table_fragment(raw)
    return (" ".join(values) if rendered_table_metric else ", ".join(values)).strip()


def _metric_source_key(value: str) -> str:
    return re.sub(r"[\W_]+", "", clean_text(value)).casefold()


def _published_metric_source_text(
    source: str, claims: Sequence[Mapping[str, Any]], locale: str
) -> str:
    """Keep ordinary source prose, but require a complete structured claim for an OCR/table row."""

    if not is_raw_metric_table_fragment(source):
        return source
    source_key = _metric_source_key(source)
    for claim in claims:
        claim_source = clean_text(claim.get("sourceText")) or clean_text(claim.get("sentence"))
        if source_key and source_key == _metric_source_key(claim_source):
            return render_structured_table_metric_sentence(claim, locale)
    return ""


# A published product attribute answers "what is this product, in a word":
# who it is for, what is in it, and what it does.  Those are the attributes a
# consumer of structured data can act on, and each is a keyword or a short list
# of keywords.  Everything else the renderer derives -- a relation sentence, a
# usage step, a measured result, a review paragraph, a safety statement, an
# option list -- is either published in the field that owns it (the
# descriptions, HowTo, Offer) or is working material for composing those
# fields.  Publishing it here a second time puts prose under an attribute name
# and repeats, under a label, what the schema already states properly.
_PUBLISHED_PRODUCT_ATTRIBUTES = ("Target customer", "Key ingredients", "Key benefit", "Key efficacy")


def _product_attribute_is_keyword_valued(value: str) -> bool:
    """Return whether an attribute value is keywords rather than prose.

    An attribute names a thing; a sentence asserts something.  A value that
    reads as a sentence belongs to a description, so it is not published under
    an attribute name even when its own label is one of the published ones.
    """

    items = [item for raw in re.split(r",\s*", clean_text(value)) if (item := raw.strip())]
    if not items:
        return False
    return not any(
        is_korean_complete_sentence(item) if re.search(r"[가-힣]", item) else is_complete_sentence(item)
        for item in items
    )


def published_product_attributes(properties: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Keep the keyword attributes a structured-data consumer can act on."""

    return [
        dict(item)
        for raw in properties
        if (item := as_dict(raw))
        and clean_text(item.get("name")) in _PUBLISHED_PRODUCT_ATTRIBUTES
        and _product_attribute_is_keyword_valued(clean_text(item.get("value")))
    ]


def internal_product_attributes(properties: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Return the derived attributes that stay out of the published markup."""

    published = {id(item) for item in properties} - {
        id(raw)
        for raw in properties
        if (item := as_dict(raw))
        and clean_text(item.get("name")) in _PUBLISHED_PRODUCT_ATTRIBUTES
        and _product_attribute_is_keyword_valued(clean_text(item.get("value")))
    }
    return [dict(as_dict(raw)) for raw in properties if id(raw) in published and as_dict(raw)]


def _additional_properties(product: Mapping[str, Any], usage: Sequence[str], locale: str) -> list[dict[str, Any]]:
    if _is_rich_source_backed_product(product):
        return _rich_additional_properties(product, usage, locale)
    if locale in {"en-US", "en-GB"}:
        return _english_additional_properties(product, locale)
    props: list[dict[str, Any]] = []
    ingredient_effect_detail = _ingredient_effect_detail(product, locale)
    for name, values in (
        ("Key ingredients", as_list(product.get("ingredients"))),
        ("Ingredient/effect detail", [ingredient_effect_detail] if ingredient_effect_detail else []),
        ("Benefits", _source_copy_benefits(product, locale)),
        ("Effects", []),
        ("Usage", [_usage_property_text(usage)] if usage else []),
        ("Reported details", [_additional_property_metric_text(product, locale)]),
    ):
        value = ", ".join(clean_text(item) for item in values[:8] if clean_text(item))
        if value:
            props.append({"@type": "PropertyValue", "name": name, "value": publishable_public_copy(value)})
    safety = _source_safety_sentences(product)
    if safety:
        props.append(
            {
                "@type": "PropertyValue",
                "name": _safety_property_name(locale),
                "value": publishable_public_copy(" ".join(safety)),
            }
        )
    return props


_KOREAN_REPORTED_SAFETY_FRAME = re.compile(r"다고\s*안내합니다[.。！？!?]?$")


def _public_safety_statements(product: Mapping[str, Any], locale: str) -> list[str]:
    """Return the safety a source states, as the product's own statement.

    A page reports its completed tests in its own voice -- "…를 완료했다고
    안내합니다" -- which is the page speaking about the product.  A product
    description is the product speaking, where that frame reads as a hedge, so
    the reporting frame is dropped and the clause keeps its own ending.  No
    word of the clause changes: what the page said was completed is what the
    sentence says was completed.

    A buyer weighing a product for sensitive skin is deciding on exactly this,
    so it belongs in the description rather than only under an attribute name.
    """

    statements: list[str] = []
    for sentence in _source_safety_sentences(product):
        rendered = clean_text(sentence)
        if locale == "ko-KR" and _KOREAN_REPORTED_SAFETY_FRAME.search(rendered):
            rendered = _KOREAN_REPORTED_SAFETY_FRAME.sub("습니다.", rendered)
        if rendered and (
            is_korean_complete_sentence(rendered) if re.search(r"[가-힣]", rendered) else is_complete_sentence(rendered)
        ):
            statements.append(rendered)
    return statements[:1]


def _labeled_benefit_attributes(product: Mapping[str, Any], naming: Sequence[str]) -> list[str]:
    """Return the benefit attributes a source states as labels rather than prose.

    A measured-result block labels what was measured (``+5.9% IMPROVES THE LOOK
    OF SKIN ELASTICITY``), and extraction keeps those labels beside the prose.
    They are the specific, source-backed wording an attribute slot wants; the
    prose beside them is a paragraph.  Reading the labels needs no vocabulary,
    only the shape they already have.
    """
    # Benefits are read before effects rather than merged with them: a source
    # that labels its benefits has already said what the product is for, and the
    # effect list of the same source carries the truncated remains of the label
    # block beside it.  Falling through only when benefits state nothing keeps
    # this a source order, not a choice of words.
    for field in ("benefits", "effects"):
        labeled = [
            _publishable_attribute_case(value) for value in _attribute_atoms(as_list(product.get(field)), naming)
        ]
        if labeled:
            return labeled
    return []


def _publishable_attribute_case(value: str) -> str:
    """Return a source label in publishable case.

    Public copy may not carry raw all-caps image text, and a label block is
    written that way.  Only the casing changes; the source word does not.
    """
    return value.title() if value.isupper() else value


def _attribute_atoms(values: Sequence[str], naming: Sequence[str]) -> list[str]:
    """Keep the entries that name a thing, so a property value carries attributes.

    The atom lists the renderer reads also hold whole sentences and reported
    figures.  An attribute names a thing: it does not assert a sentence, it is
    not a run of prose, and a measured figure belongs to a reported result
    rather than to an attribute.  A product's own name keeps the digits that
    identify it, which is why the naming surfaces are read alongside.
    """
    return [
        value
        for raw in values
        if (value := clean_text(raw))
        and not is_complete_sentence(value)
        and is_atomic_fact_phrase(value)
        and names_a_thing(value)
        and not _states_a_measurement(value, naming)
    ]


def _states_a_measurement(value: str, naming: Sequence[str]) -> bool:
    return bool(set(numeric_tokens(value)) - naming_identifier_numerics(value, naming))


def _prefer_labeled_attributes(
    product: Mapping[str, Any], naming: Sequence[str], primary: str, secondary: Sequence[str]
) -> tuple[str, list[str]]:
    """Fill an attribute slot from a source label rather than from prose.

    Only a selection that is not attribute-shaped is replaced, so a ledger whose
    benefits are already atoms keeps exactly what it publishes today.  Where the
    source states nothing in that shape the existing wording stands: this
    prefers the specific, it does not invent one.
    """
    labels = _labeled_benefit_attributes(product, naming)
    if not labels:
        return primary, list(secondary)
    if not _attribute_atoms([primary], naming):
        primary, labels = labels[0], labels[1:]
    if not _attribute_atoms(list(secondary), naming) and labels:
        return primary, labels
    return primary, list(secondary)


def _rich_additional_properties(
    product: Mapping[str, Any], usage: Sequence[str], locale: str
) -> list[dict[str, Any]]:
    ingredients = _rich_ingredients(product, locale)
    benefits = _rich_public_benefit_sentences(product, locale)
    target = _rich_target_customer(product, locale)
    naming = product_naming_surfaces(product)
    props: list[dict[str, Any]] = []

    published: set[str] = set()

    def add(name: str, value: str, property_id: str | None = None) -> None:
        # Two properties carrying one string publish the same fact twice under
        # different names, which reads as two independent facts.
        if not value or value in published:
            return
        published.add(value)
        node: dict[str, Any] = {"@type": "PropertyValue", "name": name, "value": publishable_public_copy(value)}
        if property_id:
            node["propertyID"] = property_id
        props.append(node)

    if locale in {"en-US", "en-GB"}:
        primary = _primary_rich_benefit(product, locale)
        secondary_benefits = _secondary_rich_benefits(benefits, primary, locale)
        primary, secondary_benefits = _prefer_labeled_attributes(product, naming, primary, secondary_benefits)
        ingredient_value = ", ".join(ingredients)
        skin_type = _english_recommended_skin_type(product)
        add("Target customer", target)
        add("Recommended skin type", skin_type)
        # An attribute names a thing.  A composed benefit sentence states one,
        # which belongs to a description, so the attribute publishes the atoms
        # the source filed and the sentence stays where sentences go.
        benefit_atoms = _attribute_atoms([primary, *secondary_benefits], naming)
        add("Key benefit", benefit_atoms[0] if benefit_atoms else "")
        # Rich sources retain the complete efficacy set only when it is
        # independently surfaced; sparse feeds keep the older compact form.
        benefit_value = _benefit_property_value(benefits, locale)
        if len(benefit_atoms) > 1:
            add("Key efficacy", _benefit_property_value(benefit_atoms[1:], locale))
        add("Key ingredients", ingredient_value)
        if ingredients and benefits:
            add(
                "Key ingredients and technologies",
                f"Formula ingredients and technologies: {_format_list(ingredients, locale)}. "
                f"Stated product benefits and effects: {benefit_value}",
            )
        detail = _rich_ingredient_effect_detail(product, locale).rstrip(".。！？ ")
        add("Ingredient/effect detail", detail)
        if usage:
            add("Usage", _usage_property_text(usage))
        reported = _rich_reported_details(product, locale)
        add("Reported details", " ".join(reported))
        option_values = [clean_text(value) for value in as_list(product.get("options")) if clean_text(value)]
        if len(option_values) > 1:
            add("Variant comparison", _format_list(option_values, locale))
        add("Options", ", ".join(option_values))
        add(_safety_property_name(locale), " ".join(_source_safety_sentences(product)))
        return props

    if locale == "ko-KR":
        skin_type = _rich_skin_type(product, locale)
        if target:
            add("Target customer", target)
        if skin_type:
            add("Recommended skin type", skin_type)
        primary = _primary_rich_benefit(product, locale)
        secondary_benefits = _secondary_rich_benefits(benefits, primary, locale)
        primary, secondary_benefits = _prefer_labeled_attributes(product, naming, primary, secondary_benefits)
        benefit_atoms = _attribute_atoms([primary, *secondary_benefits], naming)
        add("Key benefit", benefit_atoms[0] if benefit_atoms else "")
        if len(benefit_atoms) > 1:
            add("Key efficacy", _benefit_property_value(benefit_atoms[1:], locale))
        add("Key ingredients", _format_list(ingredients, locale))
        explicit_formula_relations = _source_grounded_ingredient_effect_sentences(product)
        if explicit_formula_relations:
            add("Ingredient/effect detail", explicit_formula_relations[0])
        review = _rich_review_phrase(product)
        # ``Texture and finish`` is an attribute slot.  A review paragraph is
        # evidence rather than an attribute, and the review keywords this ledger
        # carries are inflected fragments of that paragraph, not attribute names.
        # Publishing either would put a sentence, or noise, under an attribute
        # name; the paragraph keeps its own slot as a review signal below.
        add("Texture and finish", _format_list(_attribute_atoms(_texture_attributes(product), naming), locale))
        if usage:
            add("Usage", _usage_property_text(usage))
        if review:
            add("Customer review signal", review)
        add("Reported details", _qualified_metric_sentence(product, locale))
        option_values = [clean_text(value) for value in as_list(product.get("options")) if clean_text(value)]
        add("Options", ", ".join(option_values))
        add(_safety_property_name(locale), " ".join(_source_safety_sentences(product)))
        return props

    return props


def _english_additional_properties(product: Mapping[str, Any], locale: str) -> list[dict[str, Any]]:
    """Emit the field-separated Product property order used by the TS renderer.

    Benefits and a verbatim usage fragment do not get flattened into schema
    properties: the former is covered by Key benefit and the latter needs a
    substantive public instruction before it becomes HowTo.
    """

    target = _english_target_customer(product)
    skin_type = _english_recommended_skin_type(product)
    benefit = _english_benefit_phrase(product)
    ingredients = _english_ingredient_phrase(product)
    detail = _ingredient_effect_detail(product, locale).rstrip(".。！？ ")
    props: list[dict[str, Any]] = []

    def add(name: str, value: str) -> None:
        if value:
            props.append({"@type": "PropertyValue", "name": name, "value": publishable_public_copy(value)})

    add("Target customer", target)
    add("Recommended skin type", skin_type)
    add("Key benefit", benefit)
    add("Key ingredients", ingredients)
    add("Ingredient/effect detail", detail)
    add(_safety_property_name(locale), " ".join(_source_safety_sentences(product)))
    return props


def _ingredient_effect_detail(product: Mapping[str, Any], locale: str) -> str:
    """Port the source-backed ``Ingredient/effect detail`` schema property.

    The TypeScript renderer deliberately gives composition and the finished
    product's documented benefits a single, field-separated home.  It is not
    a claim that an ingredient *causes* a benefit: in the absence of an
    explicit ingredient-benefit link the wording keeps the relationship at
    product-information level while retaining the customer-selection context.
    """

    ingredients = [clean_text(value) for value in as_list(product.get("ingredients")) if clean_text(value)][:3]
    benefits = _public_benefit_signals(product, locale)[:4]
    if not ingredients or not benefits:
        return ""
    ingredient_phrase = _format_list(ingredients, locale)
    benefit_phrase = _format_list(benefits, locale)
    customer = _target_customer_context(product, locale)
    if locale == "ko-KR":
        return (
            f"{ingredient_phrase} 성분/기술이 포함되어 있습니다. "
            f"{_korean_subject_phrase(benefit_phrase)} 필요한 {customer}의 제품 선택에 참고할 수 있습니다"
        )
    if locale == "ja-JP":
        return f"{ingredient_phrase}を配合し、商品情報では{benefit_phrase}が確認できます。{customer}が比較する際の参考になります"
    return f"The formula includes {ingredient_phrase}. Product information identifies {benefit_phrase} as care benefits for {customer}."


def _public_benefit_signals(product: Mapping[str, Any], locale: str) -> list[str]:
    """Select compact public benefit labels without promoting ingredient roles."""

    values: list[str] = []
    source_values = _public_outcome_values(
        [*as_list(as_dict(product.get("semanticFacts")).get("benefits")), *as_list(product.get("benefits"))], locale
    )
    for text in source_values:
        if locale == "ko-KR":
            mapped = _localized_korean_benefit_signals(text)
        elif locale in {"en-US", "en-GB"}:
            mapped = _localized_english_benefit_signals(text)
        else:
            mapped = [text]
        for value in mapped:
            if value.casefold() not in {item.casefold() for item in values}:
                values.append(value)
    return values


def _localized_english_benefit_signals(value: str) -> list[str]:
    text = value.casefold()
    labels: list[str] = []
    if re.search(r"anti[- ]?aging|ageing", text):
        labels.append("anti-aging care")
    if re.search(r"firm", text):
        labels.append("firmness")
    if re.search(r"hydrat|moistur", text):
        labels.append("hydration")
    if re.search(r"radiance|glow", text):
        labels.append("radiance")
    if re.search(r"texture", text):
        labels.append("skin texture")
    return labels or [clean_text(value)]


def _localized_korean_benefit_signals(value: str) -> list[str]:
    labels: list[str] = []
    if re.search(r"장벽", value):
        labels.append("피부 장벽")
    if re.search(r"보습|수분|건조", value):
        labels.append("수분감")
    if re.search(r"피부결", value):
        labels.append("피부결")
    if re.search(r"탄력", value):
        labels.append("탄력")
    return labels or [clean_text(value)]


def _target_customer_context(product: Mapping[str, Any], locale: str) -> str:
    """Use an explicit skin-type signal when the source supplies one.

    Generic customer wording is the retained fallback.  It is intentionally
    not inferred from a lone review: only semantic facts, product copy, FAQ,
    and suitability-marked source text participate.
    """

    semantic = as_dict(product.get("semanticFacts"))
    candidates = [
        clean_text(value)
        for value in as_list(semantic.get("skinTypes"))
        if clean_text(value) and not _is_safety_or_negative_audience_context(clean_text(value))
    ]
    candidates.extend(
        clean_text(value)
        for value in [product.get("description"), *as_list(product.get("benefits")), *as_list(product.get("effects"))]
        if clean_text(value) and not _is_safety_or_negative_audience_context(clean_text(value))
    )
    for item in as_list(product.get("faq")):
        faq = as_dict(item)
        candidates.extend(
            clean_text(value)
            for value in (faq.get("question"), faq.get("answer"))
            if clean_text(value) and not _is_safety_or_negative_audience_context(clean_text(value))
        )
    candidates.extend(
        text
        for value in as_list(product.get("sourceTexts"))
        if (text := clean_text(value))
        and not _is_safety_or_negative_audience_context(text)
        and re.search(r"suitable\s+for|recommended\s+for|ideal\s+for|designed\s+for|formulated\s+for|developed\s+for|speciali[sz]ed\s+for|적합|추천|위한|특화|맞춤", text, re.I)
    )
    source = " ".join(candidates)
    if locale == "ko-KR":
        types: list[str] = []
        for pattern, label in ((r"민감", "민감 피부"), (r"건조|건성", "건조 피부"), (r"지성", "지성 피부"), (r"복합", "복합성 피부"), (r"중성", "중성 피부")):
            if re.search(pattern, source) and label not in types:
                types.append(label)
        return (" 또는 ".join(types[:3]) + " 고객") if types else "고객"
    if locale in {"en-US", "en-GB"}:
        types: list[str] = []
        for token in ("sensitive", "dry", "oily", "combination", "normal", "mature"):
            if re.search(rf"\b{token}(?:-feeling)?\s+skin\b", source, re.I) and token not in types:
                types.append(token)
        if types:
            descriptor = _format_list([f"{item} skin" for item in types[:3]], locale)
            return f"customers with {descriptor}"
        return "customers"
    return "お客様"


def _format_list(values: Sequence[str], locale: str) -> str:
    items = [value for value in values if value]
    if len(items) <= 1:
        return items[0] if items else ""
    if locale == "ja-JP":
        return "、".join(items)
    if locale == "ko-KR":
        return ", ".join(items)
    return f"{', '.join(items[:-1])}, and {items[-1]}" if len(items) > 2 else f"{items[0]} and {items[1]}"


def _korean_subject_phrase(value: str) -> str:
    """Attach a minimal subject particle for the schema-only detail sentence."""

    if not value:
        return value
    return f"{value}{'이' if _korean_has_final_consonant(value) else '가'}"


def _korean_topic_phrase(value: str) -> str:
    """Attach 은/는 using the visible Korean stem, ignoring parenthetical qualifiers."""

    if not value:
        return value
    return f"{value}{'은' if _korean_has_final_consonant(value) else '는'}"


def _korean_object_phrase(value: str) -> str:
    """Attach 을/를 without letting a parenthetical qualifier choose the particle."""

    if not value:
        return value
    return f"{value}{'을' if _korean_has_final_consonant(value) else '를'}"


def _korean_has_final_consonant(value: str) -> bool:
    stem = re.sub(r"\s*\([^)]*\)\s*$", "", value).rstrip()
    last = stem[-1] if stem else ""
    if re.fullmatch(r"[A-Za-z]", last):
        # Korean PDPs frequently retain an INCI or trademark spelling (for
        # example, ``Ceramide``).  A blanket consonant choice makes visible
        # copy read as ``Ceramide을``.  Use a modest ending heuristic for full
        # Latin words, and the Korean reading of a short all-caps initialism
        # (``Vitamin C를``, ``PDRN을``) when it is unambiguous.
        latin_word = re.search(r"([A-Za-z]+)$", stem)
        if latin_word is not None and latin_word.group(1).isupper() and len(latin_word.group(1)) <= 4:
            return last.casefold() in {"l", "m", "n", "r", "s", "x", "z"}
        return last.casefold() not in {"a", "e", "i", "o", "u", "y"}
    if not ("가" <= last <= "힣"):
        return True
    return bool((ord(last) - ord("가")) % 28)


def _recommendations(
    product: Mapping[str, Any],
    sections: Mapping[str, Any],
    concepts: Sequence[Mapping[str, Any]],
    locale: str,
    guidance_sources: Sequence[str],
) -> list[dict[str, str]]:
    output = [
        {
            "field": "description",
            "message": str(sections["description"]),
            "reason": (
                "Structured the description for generative engines: target customer, product identity, "
                "ingredient/technology, benefit or citation-ready metric, then usage/comparison/review context."
            ),
        }
    ]
    if concepts:
        output.append(
            {
                "field": "terminology",
                "message": " / ".join(
                    f"{clean_text(concept.get('concept'))}: {', '.join(_preferred_terms(concept, locale))}"
                    for concept in concepts
                ),
                "reason": "Applied locale terminology mapping so the same product can use market-natural wording.",
            }
        )
    if as_list(as_dict(product.get("reviews")).get("keywords")):
        output.append(
            {
                "field": "review",
                "message": ", ".join(
                    clean_text(value) for value in as_list(as_dict(product.get("reviews")).get("keywords"))[:5]
                ),
                "reason": "Direct review phrases were retained as search-ready product signals without inferred sentiment.",
            }
        )
    if not product.get("availability"):
        output.append(
            {
                "field": "offers.availability",
                "message": "Offer.availability was omitted because the source did not provide a mappable stock status.",
                "reason": (
                    "Provide availability in the input contract (for example InStock, SoldOut, or a boolean soldOut flag). "
                    "Commerce surfaces treat price and availability as primary eligibility signals, and this generator never "
                    "guesses stock state."
                ),
            }
        )
    if guidance_sources:
        output.extend(
            [
                {
                    "field": "howToUse",
                    "message": str(sections["howToUse"]),
                    "reason": (
                        "Reconstructed usage instructions into answer-ready steps using selected GEO RAG guidance: "
                        f"{', '.join(guidance_sources)}."
                    ),
                },
                {
                    "field": "faq",
                    "message": str(sections["faq"]),
                    "reason": (
                        "Reframed FAQ around GEO question intent, product benefit, ingredient/technology, usage context, "
                        "suitability, and evidence signals so generated answers stay grounded and reusable."
                    ),
                },
            ]
        )
    return output


def _read_terminology_concepts(documents: Sequence[object]) -> list[dict[str, Any]]:
    """Load the same ordered terminology-map set as the retained TS renderer."""

    rows = [as_dict(item) for item in documents]
    default_name = "locale-terminology-map_v1.json"
    # Brand maps are uncommon in the standalone Python package.  Preserve the
    # TypeScript precedence when runtime callers name one, then use the default
    # map and other terminology documents in their provided order.
    brand = [row for row in rows if "brand" in clean_text(row.get("name")).lower() and "terminology" in clean_text(row.get("name")).lower()]
    default = [row for row in rows if clean_text(row.get("name")).replace("\\", "/") == default_name]
    other = [
        row
        for row in rows
        if row not in brand and row not in default and "terminology" in clean_text(row.get("name")).lower()
    ]
    merged: dict[str, dict[str, Any]] = {}
    for row in [*brand, *default, *other]:
        try:
            decoded = json.loads(clean_text(row.get("content")))
        except (TypeError, ValueError):
            continue
        for raw in as_list(as_dict(decoded).get("concepts")):
            concept = as_dict(raw)
            name = clean_text(concept.get("concept"))
            if name and name not in merged:
                merged[name] = concept
    return list(merged.values())


def _detect_terminology_concepts(product: Mapping[str, Any], concepts: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    reviews = as_dict(product.get("reviews"))
    haystack = " ".join(
        clean_text(value)
        for value in [
            product.get("name"),
            product.get("description"),
            *as_list(product.get("benefits")),
            *as_list(product.get("effects")),
            *as_list(product.get("ingredients")),
            *as_list(product.get("usage")),
            *as_list(reviews.get("keywords")),
            *as_list(product.get("sourceTexts"))[:20],
        ]
        if clean_text(value)
    ).lower()
    detected: list[dict[str, Any]] = []
    for raw in concepts:
        concept = as_dict(raw)
        preferred = as_dict(concept.get("preferred"))
        avoid = as_dict(concept.get("avoid"))
        terms = [
            clean_text(concept.get("concept")),
            *[clean_text(term) for values in preferred.values() for term in as_list(values)],
            *[clean_text(term) for values in avoid.values() for term in as_list(values)],
        ]
        if any(term.lower() in haystack for term in terms if term):
            detected.append(concept)
    return detected


def _preferred_terms(concept: Mapping[str, Any], locale: str) -> list[str]:
    preferred = as_dict(concept.get("preferred"))
    return [clean_text(item) for item in as_list(preferred.get(locale) or preferred.get("en-US")) if clean_text(item)]


def _guidance_sources(reasoning: Mapping[str, Any], chunks: Sequence[Mapping[str, Any]]) -> list[str]:
    values = [
        *[clean_text(item) for item in as_list(reasoning.get("selectedSources"))],
        *[
            f"{clean_text(chunk.get('source'))}#{clean_text(chunk.get('title'))}"
            if clean_text(chunk.get("title"))
            else clean_text(chunk.get("source"))
            for chunk in chunks
        ],
    ]
    return _unique_texts(values)[:8]


def _selected_official_doc_sources(chunks: Sequence[Mapping[str, Any]]) -> list[str]:
    return _unique_texts(
        clean_text(chunk.get("source"))
        for chunk in chunks
        if chunk.get("kind") == "official-docs"
        or re.search(r"official|openai|google|gemini|perplexity", f"{chunk.get('source', '')} {chunk.get('title', '')}", re.I)
    )[:4]


def _unique_texts(values: Sequence[object] | Any) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for raw in values:
        value = clean_text(raw)
        if value and value not in seen:
            seen.add(value)
            result.append(value)
    return result


def _canonical_url(value: str) -> str | None:
    if not value:
        return None
    parsed = urlsplit(value)
    scheme = parsed.scheme.lower()
    # ``new URL('http:example.com')`` is an absolute HTTP URL under WHATWG
    # rules even though urllib exposes ``example.com`` as its path.  Source
    # URLs are intentionally unvalidated at input, so only canonicalize forms
    # the JavaScript parser can resolve and preserve malformed inputs as-is.
    if scheme in {"http", "https"} and not parsed.netloc and parsed.path and not parsed.path.startswith("/"):
        parsed = urlsplit(f"{scheme}://{value[len(parsed.scheme) + 1:]}")
    if not parsed.scheme or not parsed.netloc:
        return value
    query = urlencode(
        [(key, val) for key, val in parse_qsl(parsed.query, keep_blank_values=True) if not _TRACKING.match(key)]
    )
    # WHATWG serializes a bare HTTP(S) origin with '/', lower-cases its host,
    # and percent-encodes spaces in a path.  The result becomes JSON-LD IDs,
    # so retain those byte-visible details instead of relying on urllib's more
    # literal rendering.
    hostname = parsed.hostname
    if hostname is None:
        return value
    host = hostname.lower()
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    if parsed.port is not None:
        host = f"{host}:{parsed.port}"
    if parsed.username is not None:
        credentials = quote(parsed.username, safe="")
        if parsed.password is not None:
            credentials = f"{credentials}:{quote(parsed.password, safe='')}"
        host = f"{credentials}@{host}"
    path = quote(parsed.path or "/", safe="/%:@!$&'()*+,;=-._~")
    return urlunsplit((scheme, host, path, query, ""))


def _derive_brand_same_as_from_source_url(brand: str, source_url: str | None) -> list[str] | None:
    """Ground a brand at a supplied first-party PDP origin, never a retailer.

    This is the direct Python port of ``deriveBrandSameAsFromSourceUrl``.  A
    host must contain a sufficiently specific ASCII brand token; otherwise the
    source address says nothing safe about the brand's official identity.
    """

    if not brand or not source_url:
        return None
    brand_token = re.sub(r"[^a-z0-9]", "", brand.lower())
    if len(brand_token) < 3:
        return None
    parsed = urlparse(source_url)
    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"} or not parsed.hostname:
        return None
    try:
        host = parsed.hostname.lower()
        if parsed.port is not None:
            host = f"{host}:{parsed.port}"
    except ValueError:
        return None
    host_token = re.sub(r"[^a-z0-9]", "", host.lower())
    return [f"{scheme}://{host}/"] if brand_token in host_token else None


def _valid_urls(values: Sequence[object]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for raw in values:
        value = clean_text(raw)
        parsed = urlparse(value)
        if is_publishable_image_url(value) and parsed.scheme.lower() in {"http", "https"} and parsed.netloc and value not in seen:
            seen.add(value)
            out.append(value)
    return out[:8]


def _absolute_urls(values: Sequence[object]) -> list[str]:
    """Keep dereferenceable organization identity links in source order."""

    result: list[str] = []
    for raw in values:
        value = clean_text(raw)
        parsed = urlparse(value)
        if value and parsed.scheme and parsed.netloc and value not in result:
            result.append(value)
    return result


def _slug(value: str) -> str:
    return re.sub(r"^-+|-+$", "", re.sub(r"[^a-z0-9가-힣ぁ-んァ-ン一-龯]+", "-", value.lower())) or "product"


def _howto_name(name: str, locale: str) -> str:
    return {"ko-KR": f"{name} 사용 방법", "ja-JP": f"{name}の使い方"}.get(locale, f"How to use {name}")


def _step_name(index: int, locale: str) -> str:
    return {"ko-KR": f"{index + 1}단계", "ja-JP": f"ステップ{index + 1}"}.get(locale, f"Step {index + 1}")


def _clean_json(value: Any) -> Any:
    if isinstance(value, Mapping):
        mapping = cast(Mapping[str, Any], value)
        return {key: _clean_json(item) for key, item in mapping.items() if item is not None and item != "" and item != []}
    if isinstance(value, list):
        return [_clean_json(item) for item in cast(list[Any], value) if item is not None and item != []]
    return value


def _localized_category(category: str, locale: str) -> str:
    known_locale = cast(Literal["ko-KR", "ja-JP", "en-US", "en-GB"], locale)
    return localize_product_type_for_locale(category, known_locale) if locale in {"ko-KR", "ja-JP", "en-US", "en-GB"} else category


generatePdpGeoArtifacts = generate_pdp_geo_artifacts
ensurePdpGeoFaqPlanCoverage = ensure_pdp_geo_faq_plan_coverage
selectSchemaImages = select_schema_images
createPdpGeoContentHtml = create_pdp_geo_content_html
isCitationReadyProse = is_citation_ready_prose
