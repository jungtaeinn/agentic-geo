"""Optional, source-gated product normalization model stage.

The deterministic normalizer remains the authority for arbitrary PDP JSON.
This module mirrors the legacy second pass: a custom/provider model may make a
compact patch, but every published field must be recoverable from the raw PDP
corpus.  That deliberately makes an unavailable or over-eager model a
degraded-mode diagnostic rather than a content regression.
"""

from __future__ import annotations

import inspect
import json
import math
import re
import unicodedata
from collections.abc import Callable, Mapping, Sequence
from typing import Any, cast

from neo_js_compat import js_code_unit_length, js_json_pretty_dumps, js_utf16_slice

from ._json import as_dict, as_list, clean_text
from .contracts.usage import extract_explicit_numbered_usage_steps
from .normalization import (
    dedupe_pdp_usage_instructions,
    infer_pdp_evidence_roles,
    sanitize_pdp_semantic_facts,
)
from .product_scope import filter_current_product_usage_instructions, is_conflicting_product_usage_instruction
from .token_usage import merge_token_usage

_DEFAULT_MAX_RAG_DOCUMENTS = 8
_DEFAULT_MAX_SOURCE_CHARACTERS = 35_000
_PATCH_FIELDS = (
    "name",
    "originalName",
    "description",
    "brand",
    "category",
    "images",
    "options",
    "benefits",
    "effects",
    "ingredients",
    "usage",
    "metrics",
    "breadcrumbs",
    "sourceTexts",
)
_ARRAY_FIELDS = frozenset(
    {"images", "options", "benefits", "effects", "ingredients", "usage", "metrics", "sourceTexts"}
)
_DERIVED_KEYS = frozenset({"keyword", "keywords", "chunk", "chunks", "derived", "embedding", "vector"})


async def normalize_pdp_product_with_agent(
    request: Mapping[str, Any], options: Mapping[str, Any] | None = None
) -> dict[str, Any]:
    """Apply an optional source-backed patch to a bootstrap product.

    The return shape intentionally follows the TypeScript ``Application``
    object so service orchestration can retain token accounting and evidence
    ordering.  Locale/market are returned for direct callers; the service
    retains caller control-plane values when it incorporates this result.
    """

    runtime = as_dict(options)
    bootstrap = as_dict(request.get("bootstrapProduct"))
    base_evidence: list[dict[str, str]] = []
    base_warnings: list[str] = []
    base: dict[str, Any] = {
        "product": _clone_product(bootstrap),
        "locale": clean_text(request.get("locale")) or "en-US",
        "market": clean_text(request.get("market")) or None,
        "evidence": base_evidence,
        "warnings": base_warnings,
        "called": False,
        "applied": False,
    }
    normalizer, resolution_warning = _resolve_product_normalizer(runtime)
    if normalizer is None:
        if resolution_warning:
            base_warnings.append(resolution_warning)
            base_evidence.append(
                {
                    "field": "product.normalization",
                    "source": "llm",
                    "value": f"Product normalization skipped: {resolution_warning}",
                }
            )
        return base

    normalized_request = dict(request)
    settings = as_dict(runtime.get("productNormalization"))
    normalized_request["ragDocuments"] = select_product_normalization_rag_documents(
        [as_dict(item) for item in as_list(request.get("ragDocuments"))],
        _integer(settings.get("maxRagDocuments"), _DEFAULT_MAX_RAG_DOCUMENTS),
    )
    try:
        result = await _call_product_normalizer(normalizer, normalized_request)
        retry_warning = ""
        if isinstance(normalizer, ModelBackedProductNormalizer) and _needs_corrective_retry(result):
            corrective_request = dict(normalized_request)
            corrective_request["analysisPrompt"] = "\n".join(
                item
                for item in (
                    clean_text(normalized_request.get("analysisPrompt")),
                    "CORRECTIVE_STRUCTURED_RETRY: Return only the compact schema-conformant JSON patch; use null for unchanged fields and preserve atomic evidence roles.",
                )
                if item
            )
            retry = await _call_product_normalizer(normalizer, corrective_request)
            retry["usage"] = _merge_usage(result.get("usage"), retry.get("usage"))
            if not _needs_corrective_retry(retry):
                retry["warnings"] = [
                    *[str(item) for item in as_list(retry.get("warnings"))],
                    "Product normalization recovered after one corrective structured retry.",
                ]
            else:
                retry_warning = (
                    "DEGRADED_MODE: Product normalization remained invalid after one corrective structured retry; "
                    "source-backed deterministic classification was used and incomplete clinical atoms were kept out of clinical summaries."
                )
                retry["warnings"] = [
                    *[str(item) for item in as_list(result.get("warnings"))],
                    *[str(item) for item in as_list(retry.get("warnings"))],
                ]
            result = retry

        applied = _apply_product_normalization(bootstrap, result, request.get("rawProduct"))
        warnings = [
            *[str(item) for item in as_list(result.get("warnings")) if clean_text(item)],
            *applied["warnings"],
            *([retry_warning] if retry_warning else []),
        ]
        evidence = [*applied["evidence"]]
        if applied["applied"]:
            evidence.append(
                {
                    "field": "product.normalization",
                    "source": "llm",
                    "value": "Model-backed product normalization updated: " + ", ".join(applied["changedFields"]),
                }
            )
        else:
            evidence.append(
                {
                    "field": "product.normalization",
                    "source": "llm",
                    "value": "Model-backed product normalization returned no accepted source-backed field changes.",
                }
            )
        evidence.extend(
            {"field": "product.normalization.warning", "source": "llm", "value": warning}
            for warning in _unique(warnings)
        )
        return {
            "product": applied["product"],
            "locale": clean_text(result.get("locale")) or base["locale"],
            "market": clean_text(result.get("market")) or base["market"],
            "evidence": evidence,
            "warnings": _unique(warnings),
            "called": True,
            "applied": applied["applied"],
            **({"usage": result["usage"]} if result.get("usage") is not None else {}),
        }
    except Exception as error:  # explicit degraded-mode compatibility path
        message = str(error) or "Product normalization provider failed."
        return {
            **base,
            "called": True,
            "warnings": [message],
            "evidence": [
                {
                    "field": "product.normalization",
                    "source": "llm",
                    "value": f"Product normalization skipped: {message}",
                }
            ],
        }


def select_product_normalization_rag_documents(
    documents: Sequence[Mapping[str, Any]], max_documents: int
) -> list[dict[str, Any]]:
    """Select a representative normalization context in legacy stable order."""

    limit = max(0, max_documents)
    if limit == 0:
        return []
    ranked = sorted(
        ((dict(document), index) for index, document in enumerate(documents)),
        key=lambda item: (-product_normalization_rag_priority(clean_text(item[0].get("name"))), item[1]),
    )
    selected: list[dict[str, Any]] = []
    names: set[str] = set()
    families: set[str] = set()

    def add(document: dict[str, Any] | None, allow_same_family: bool = False) -> None:
        if document is None or len(selected) >= limit:
            return
        name = clean_text(document.get("name"))
        family = _rag_family(name)
        if not name or name in names or (not allow_same_family and family in families):
            return
        selected.append(document)
        names.add(name)
        families.add(family)

    def family_slot(family: str) -> dict[str, Any] | None:
        members = [document for document, _ in ranked if _rag_family(clean_text(document.get("name"))) == family]
        return next(
            (item for item in members if not _is_brand_overlay(clean_text(item.get("name")))),
            members[0] if members else None,
        )

    for family in ("geo", "eeat", "cep"):
        add(family_slot(family))
    for document, _ in ranked:
        add(family_slot(_rag_family(clean_text(document.get("name")))))
    for document, _ in ranked:
        add(document, allow_same_family=True)
    return selected


def product_normalization_rag_priority(name: str) -> int:
    path = name.casefold().replace("\\", "/")
    if re.search(r"brands/[^/]+/brand-identity", path):
        return 120
    recognized = (
        "analysis-prompt",
        "schema-org",
        "geo-research",
        "eeat",
        "cep",
        "best-practice",
        "official-ai-search",
        "locale-expression",
        "locale-terminology",
        "content-field-contracts",
    )
    if not any(token in path for token in recognized):
        return 115
    if "analysis-prompt" in path:
        return 110
    if "geo-research" in path:
        return 108
    if re.search(r"(?:^|/)eeat", path):
        return 107
    if re.search(r"(?:^|/)cep", path):
        return 106
    if re.search(r"brands/[^/]+/best-practice", path):
        return 105
    if "best-practice" in path:
        return 102
    if "schema-org" in path:
        return 100
    if "locale-expression" in path:
        return 96
    if "locale-terminology" in path:
        return 95
    if "official-ai-search" in path:
        return 80
    if "content-field-contracts" in path:
        return 79
    return 70


class ModelBackedProductNormalizer:
    """Provider bridge retained for direct normalizer consumers."""

    def __init__(self, config: Mapping[str, Any]) -> None:
        self.config = dict(config)

    async def normalize_product(self, request: Mapping[str, Any]) -> Mapping[str, Any]:
        from .providers import create_provider

        provider = create_provider(self.config)
        prompt = create_product_normalization_prompt(
            request,
            _integer(self.config.get("maxSourceCharacters"), _DEFAULT_MAX_SOURCE_CHARACTERS),
        )
        response = await provider.generate_json(
            stage="product-normalization",
            system=prompt["system"],
            user=prompt["user"],
            json_schema=PDP_PRODUCT_NORMALIZATION_JSON_SCHEMA,
        )
        # ProviderResult intentionally exposes malformed JSON as an empty
        # mapping for ordinary generation callers.  That would turn an
        # unparseable product-normalization response into a silent no-op,
        # though.  TypeScript parses this stage's raw response before its
        # patch coercion so its corrective retry can distinguish malformed
        # text from a valid empty patch; retain that boundary here.
        return _parse_product_normalization_provider_response(response)

    async def normalizeProduct(self, request: Mapping[str, Any]) -> Mapping[str, Any]:
        return await self.normalize_product(request)


def _nullable(schema: Mapping[str, Any]) -> dict[str, Any]:
    """Mirror Zod's JSON-schema representation for nullable fields."""

    return {"anyOf": [dict(schema), {"type": "null"}]}


def _strict_object(properties: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": dict(properties),
        "required": list(properties),
        "additionalProperties": False,
    }


_NULLABLE_TEXT = _nullable({"type": "string"})
_NULLABLE_NUMBER = _nullable({"type": "number"})
_NULLABLE_STRING_ARRAY = _nullable({"type": "array", "items": {"type": "string"}})

_METRIC_CLAIM_OUTPUT_SCHEMA = _strict_object(
    {
        "label": _NULLABLE_TEXT,
        "subject": _NULLABLE_TEXT,
        "value": _NULLABLE_TEXT,
        "unit": _NULLABLE_TEXT,
        "metric": _NULLABLE_TEXT,
        "direction": _NULLABLE_TEXT,
        "timing": _NULLABLE_TEXT,
        "baseline": _NULLABLE_TEXT,
        "comparator": _NULLABLE_TEXT,
        "period": _NULLABLE_TEXT,
        "sample": _NULLABLE_TEXT,
        "method": _NULLABLE_TEXT,
        "institution": _NULLABLE_TEXT,
        "evidenceGroup": _NULLABLE_TEXT,
        "caveat": _NULLABLE_TEXT,
        "sentence": _NULLABLE_TEXT,
        "sourceText": _NULLABLE_TEXT,
        "imageUrls": _NULLABLE_STRING_ARRAY,
    }
)
_INGREDIENT_BENEFIT_LINK_OUTPUT_SCHEMA = _strict_object(
    {
        "ingredient": _NULLABLE_TEXT,
        "benefit": _NULLABLE_TEXT,
        "effect": _NULLABLE_TEXT,
        "sentence": _NULLABLE_TEXT,
        "sourceText": _NULLABLE_TEXT,
        "imageUrls": _NULLABLE_STRING_ARRAY,
    }
)
_SEMANTIC_CITATION_OUTPUT_SCHEMA = _strict_object(
    {
        "type": _nullable({"type": "string", "enum": ["research", "article"]}),
        "title": _NULLABLE_TEXT,
        "publisher": _NULLABLE_TEXT,
        "author": _NULLABLE_TEXT,
        "publishedAt": _NULLABLE_TEXT,
        "url": _NULLABLE_TEXT,
        "finding": _NULLABLE_TEXT,
        "sourceText": _NULLABLE_TEXT,
    }
)
_SEMANTIC_FACTS_OUTPUT_SCHEMA = _strict_object(
    {
        "ingredients": {"type": "array", "items": {"type": "string"}},
        "benefits": {"type": "array", "items": {"type": "string"}},
        "effects": {"type": "array", "items": {"type": "string"}},
        "skinTypes": {"type": "array", "items": {"type": "string"}},
        "usageSteps": {"type": "array", "items": {"type": "string"}},
        "safetyTests": {"type": "array", "items": {"type": "string"}},
        "metricClaims": {"type": "array", "items": _METRIC_CLAIM_OUTPUT_SCHEMA},
        "evidenceSentences": {"type": "array", "items": {"type": "string"}},
        "ingredientBenefitLinks": {"type": "array", "items": _INGREDIENT_BENEFIT_LINK_OUTPUT_SCHEMA},
        "citations": {"type": "array", "items": _SEMANTIC_CITATION_OUTPUT_SCHEMA},
    }
)
_FAQ_OUTPUT_SCHEMA = _strict_object({"question": {"type": "string"}, "answer": {"type": "string"}})
_REVIEW_ITEM_OUTPUT_SCHEMA = _strict_object(
    {
        "body": {"type": "string"},
        "author": _NULLABLE_TEXT,
        "rating": _NULLABLE_NUMBER,
        "datePublished": _NULLABLE_TEXT,
    }
)
_REVIEWS_OUTPUT_SCHEMA = _strict_object(
    {
        "rating": _NULLABLE_NUMBER,
        "reviewCount": _NULLABLE_NUMBER,
        "items": {"type": "array", "items": _REVIEW_ITEM_OUTPUT_SCHEMA},
        "keywords": {"type": "array", "items": {"type": "string"}},
    }
)
_BREADCRUMB_OUTPUT_SCHEMA = _strict_object({"name": {"type": "string"}, "url": _NULLABLE_TEXT})
_PRICE_OUTPUT_SCHEMA = _strict_object(
    {"raw": {"type": "string"}, "amount": _NULLABLE_NUMBER, "currency": _NULLABLE_TEXT}
)
_PRODUCT_PATCH_OUTPUT_SCHEMA = _strict_object(
    {
        "name": _NULLABLE_TEXT,
        "originalName": _NULLABLE_TEXT,
        "description": _NULLABLE_TEXT,
        "brand": _NULLABLE_TEXT,
        "category": _NULLABLE_TEXT,
        "price": _nullable(_PRICE_OUTPUT_SCHEMA),
        "images": _NULLABLE_STRING_ARRAY,
        "options": _NULLABLE_STRING_ARRAY,
        "benefits": _NULLABLE_STRING_ARRAY,
        "effects": _NULLABLE_STRING_ARRAY,
        "ingredients": _NULLABLE_STRING_ARRAY,
        "usage": _NULLABLE_STRING_ARRAY,
        "metrics": _NULLABLE_STRING_ARRAY,
        "faq": _nullable({"type": "array", "items": _FAQ_OUTPUT_SCHEMA}),
        "reviews": _nullable(_REVIEWS_OUTPUT_SCHEMA),
        "breadcrumbs": _nullable({"type": "array", "items": _BREADCRUMB_OUTPUT_SCHEMA}),
        "sourceTexts": _NULLABLE_STRING_ARRAY,
        "semanticFacts": _nullable(_SEMANTIC_FACTS_OUTPUT_SCHEMA),
    }
)

# Direct source-port of ``product-normalizer.ts``'s Zod strict patch schema.
# Keep its field order and nullable ``anyOf`` shape stable: provider adapters
# expose this object as a wire artifact, not merely as local validation hints.
PDP_PRODUCT_NORMALIZATION_JSON_SCHEMA: dict[str, Any] = _strict_object(
    {
        "product": _PRODUCT_PATCH_OUTPUT_SCHEMA,
        "locale": {"type": "string", "enum": ["ko-KR", "ja-JP", "en-US", "en-GB"]},
        "market": _NULLABLE_TEXT,
        "warnings": {"type": "array", "items": {"type": "string"}},
    }
)


_PRODUCT_NORMALIZATION_SYSTEM_RULES = (
    "You are a conservative product-data normalization agent for PDP GEO generation.",
    "Return only the strict product-normalization patch JSON required by the response schema.",
    "The product object is a patch, not a full echo of the input. Return null for every unchanged scalar/object/array field. When an array is changed, return the complete audited replacement array; when semanticFacts is changed, return its complete classified arrays. This keeps the response compact and prevents truncation.",
    "Infer the normalized ProductSignal from the raw product JSON, bootstrap ProductSignal, fieldMapping, hints, and RAG policy documents.",
    "Your job is field routing and evidence-preserving normalization, not public copywriting.",
    "Use source product data only. Do not invent claims, ingredients, effects, prices, reviews, metrics, awards, or certifications.",
    "Prefer complete source-backed sentences over isolated tokens. Keep ingredient, benefit, effect, usage, FAQ, review, metric, and sourceTexts fields separated.",
    "Route fields by evidence role before returning ProductSignal: usage must be actionable customer directions, ingredients must be ingredient/formula/full-INCI evidence, benefits/effects must be outcomes or supported results, reviews must be customer language, and metrics must be measured or countable evidence.",
    "Preserve usage structure from bootstrapProduct. If bootstrap usage already contains actionable directions, leave product.usage null instead of splitting, merging, reordering, paraphrasing, or replacing those items. semanticFacts.usageSteps must keep the same source boundaries; one source instruction remains one item and an explicit source sequence keeps its count and order.",
    "An ingredient is a named substance, INCI entry, identifiable complex, or proprietary formula/technology. Do not classify attributes or outcomes such as absorption, retention, persistence, texture, skin type, efficacy, or a research duration as ingredients.",
    "Do not put a product-result sentence, clinical metric, review summary, or ingredient explanation into usage just because it mentions timing, application, use, or the current product. Test application and measured post-application results are evidence, not customer directions.",
    "Normalize product identity into a representative product entity and a SKU/variant layer: preserve source-backed bracketed names, small-size labels, volume, option names, and SKU names in originalName/options/sourceTexts; keep the main product name concise when the source clearly separates brand, representative product, and variant.",
    "For prices, preserve the price that is closest to the current SKU/volume/option evidence. Do not mix a full-size offer price into a small-size SKU when the source contains a nearer option-specific price.",
    "For FAQ, keep complete source-backed question/answer pairs across benefit, ingredient/technology, usage, review, suitability, evidence, variant comparison, routine synergy, renewal, and purchase context when those intents appear in the raw PDP.",
    "Use RAG policy to resolve overlaps: commerce UI, coupon, delivery, exchange, refund, return, legal, and page chrome text must not become product benefits.",
    "If the bootstrap value is safer or better supported than your inferred value, return the bootstrap value or omit the field.",
    "Keep arrays concise and semantically deduplicated: paraphrases of the same usage action or the same skin type in another language count as one fact. Keep product facts close to source wording.",
    "Classify each atomic evidence unit before routing it. Use one primary role among ingredient, benefit, effect, audience, usage, safety, review, metric, FAQ, commerce, or source; add a secondary role only when the same sentence explicitly supports it. Do not infer a role from a nearby heading alone.",
    "Separate source assertions, source-backed synthesis, and query hypotheses before normalization. ProductSignal fields and semanticFacts may contain only source assertions or lossless normalization of them. A plausible customer question, common category convention, seasonal/weather association, time-of-day assumption, occasion, or general market belief is a non-evidentiary query hypothesis; if it is useful, put it only in warnings prefixed QUERY_HYPOTHESIS_ONLY and never route it into product facts.",
    "Do not create a causal or suitability relationship from co-occurrence. Two facts appearing on the same page, in neighboring sections, or in separate array entries do not prove that one causes, supports, is recommended for, or is used during the other. Record a relation only when one source sentence or structured source fact explicitly connects the current product, context, and outcome.",
    "When a sentence explicitly links a named ingredient or technology to an outcome, keep the named entity in ingredients and record the source-backed relation in semanticFacts.ingredientBenefitLinks. Do not copy that ingredient outcome into product benefits/effects unless a separate source assertion explicitly makes it a finished-product claim. Do not place the full explanatory sentence or the outcome phrase in the ingredient-name list.",
    "Classify completed safety, dermatology, sensitive-skin, allergy, eye-irritation, paediatric, non-comedogenic, and similar product tests into semanticFacts.safetyTests as separate atomic source-backed test names. Do not merge them into efficacy metrics, ingredients, benefits, or usage, and do not infer an unlisted test from a related certification label.",
    "Treat outcome-like words inside a standalone proper ingredient, complex, blend, technology, or formula name as part of that name, not as a benefit/effect or causal relation. Require an explicit source assertion outside the name before adding an outcome role.",
    "Review bodies, review keywords, ratings, testimonials, and customer-experience sections have review provenance. Do not promote terms found only in those sources into product benefits, effects, ingredients, or ingredient-outcome relations; a non-review product-fact source must independently support that role.",
    "Return benefits, effects, and ingredients as complete audited arrays, including an empty array when every bootstrap value is misrouted. An explicit empty array clears that role; omitting a field preserves the bootstrap value.",
    "A metric must remain an atomic claim with its measured outcome and available period, sample, method, comparison, or caveat. A bare percentage, duration, volume, option size, or price is not a result metric. Product volume and SKU size belong to options/sourceTexts.",
    "When OCR or extracted copy compresses multiple measurements and a footnote into one run-on block, infer the evidence atoms before routing: create one semanticFacts.metricClaims item per independently measured endpoint and retain its label/subject, value/unit, direction, timing, baseline/comparator, sample, period, method, and caveat when the source supports them. Keep the original block only as sourceText/evidenceSentences provenance; never return that whole block as one public metric, effect, review, or usage item.",
    "When the source explicitly cites a research paper or editorial article, preserve it as one semanticFacts.citations item. Parse only source-stated type, title, publisher, author, publication date, URL, and finding; preserve exact dates and numbers, keep sourceText provenance, and never invent missing bibliographic metadata or treat customer reviews and commerce copy as citations.",
    "Share institution, study dates, population/sample, method, or baseline across metricClaims only when the source groups those outcomes under the same footnote, study marker, or explicit study statement. Depth/delivery, formulation retention, duration, customer skin outcome, and review satisfaction are different evidence roles unless the source explicitly connects them. Do not attach an ambiguous percentage or comparison to a clinical study merely because it appears nearby in OCR order.",
    "Safety and suitability cautions such as patch testing are not HowTo steps. A skin type mentioned only in a caution is not automatically the recommended skin type. FAQ answers must be answer statements, never another question or a shopper's question fragment.",
    "Use the requested locale as the output-language contract: Korean PDP evidence produces ko-KR normalized public-language fields, and US PDP evidence produces en-US normalized public-language fields. Preserve source-language proper nouns and INCI names where translation would change identity.",
)


def create_product_normalization_prompt(
    request: Mapping[str, Any], max_source_characters: int = _DEFAULT_MAX_SOURCE_CHARACTERS
) -> dict[str, Any]:
    """Create the bounded, field-separated provider prompt from the TS oracle."""

    return {
        "system": "\n".join(_PRODUCT_NORMALIZATION_SYSTEM_RULES),
        "user": js_json_pretty_dumps(create_product_normalization_payload(request, max_source_characters)),
    }


def create_product_normalization_payload(
    request: Mapping[str, Any], max_source_characters: int = _DEFAULT_MAX_SOURCE_CHARACTERS
) -> dict[str, Any]:
    """Keep raw PDP input, bootstrap fields, and strategic RAG distinct."""

    rag_policy: list[dict[str, Any]] = []
    analysis_prompt = request.get("analysisPrompt")
    if isinstance(analysis_prompt, str) and analysis_prompt:
        rag_policy.append({"name": "analysis-prompt", "content": js_utf16_slice(analysis_prompt, 0, 2400)})
    for raw in as_list(request.get("ragDocuments")):
        document = as_dict(raw)
        name = document.get("name")
        if not isinstance(name, str) or not name:
            continue
        raw_content = document.get("content")
        content = raw_content if isinstance(raw_content, str) else ""
        item: dict[str, Any] = {
            "name": name,
            "version": _prompt_json_value(document.get("version")),
            "content": js_utf16_slice(content, 0, 2400),
        }
        rag_policy.append(item)
    return {
        "task": "Infer a source-backed normalized ProductSignal with fewer hardcoded field assumptions.",
        "inferenceBoundary": {
            "factualOutput": "Only source assertions or lossless normalization of source assertions may enter ProductSignal and semanticFacts.",
            "queryHypothesis": "Unsupported seasonal, weather, occasion, time-of-day, demographic, or general category associations belong only in warnings prefixed QUERY_HYPOTHESIS_ONLY.",
        },
        "source": _prompt_json_value(request.get("source")),
        "hints": _prompt_json_value(request.get("hints")),
        "fieldMapping": _prompt_json_value(request.get("fieldMapping")),
        **({"locale": _prompt_json_value(request["locale"])} if "locale" in request else {}),
        "market": _prompt_json_value(request.get("market")),
        **({"bootstrapProduct": _prompt_json_value(request["bootstrapProduct"])} if "bootstrapProduct" in request else {}),
        **(
            {
                "rawProduct": _trim_json_for_product_normalization_prompt(
                    request["rawProduct"], max(0, max_source_characters)
                )
            }
            if "rawProduct" in request
            else {}
        ),
        "ragPolicy": rag_policy,
    }


def _trim_json_for_product_normalization_prompt(value: object, max_characters: int) -> object:
    normalized = _prompt_json_value(value)
    text = js_json_pretty_dumps(normalized)
    return (
        normalized
        if js_code_unit_length(text) <= max_characters
        else {"truncated": True, "text": js_utf16_slice(text, 0, max_characters)}
    )


def _prompt_json_value(value: object, depth: int = 0) -> Any:
    """Port the TS prompt serializer's array/key bounds without repr leakage."""

    if depth > 24:
        return ""
    if value is None or isinstance(value, str | int | float | bool):
        return value
    if isinstance(value, Mapping):
        mapping = cast(Mapping[object, object], value)
        return {
            str(key): _prompt_json_value(item, depth + 1)
            for key, item in list(mapping.items())[:200]
        }
    if isinstance(value, Sequence) and not isinstance(value, str | bytes | bytearray):
        sequence = cast(Sequence[object], value)
        return [_prompt_json_value(item, depth + 1) for item in sequence[:80]]
    return str(value)


async def _call_product_normalizer(normalizer: object, request: Mapping[str, Any]) -> dict[str, Any]:
    method = getattr(normalizer, "normalize_product", None) or getattr(normalizer, "normalizeProduct", None)
    if not callable(method):
        raise TypeError("customProductNormalizer must provide normalize_product(request) or normalizeProduct(request).")
    result = method(dict(request))
    if inspect.isawaitable(result):
        result = await result
    return as_dict(result)


_NORMALIZATION_LOCALES = frozenset({"ko-KR", "ja-JP", "en-US", "en-GB"})
_PRODUCT_PATCH_TEXT_FIELDS = frozenset({"name", "originalName", "description", "brand", "category"})
_PRODUCT_PATCH_STRING_ARRAY_FIELDS = frozenset(
    {"images", "options", "benefits", "effects", "ingredients", "usage", "metrics", "sourceTexts"}
)
_PRODUCT_PATCH_FIELDS = frozenset(
    {
        *_PRODUCT_PATCH_TEXT_FIELDS,
        "price",
        *_PRODUCT_PATCH_STRING_ARRAY_FIELDS,
        "faq",
        "reviews",
        "breadcrumbs",
        "semanticFacts",
    }
)
_SEMANTIC_FACT_PATCH_FIELDS = frozenset(
    {
        "ingredients",
        "benefits",
        "effects",
        "skinTypes",
        "usageSteps",
        "safetyTests",
        "metricClaims",
        "evidenceSentences",
        "ingredientBenefitLinks",
        "citations",
    }
)


class _ProductNormalizationSchemaError(ValueError):
    """Internal marker for the flexible TypeScript normalization envelope."""


def _parse_product_normalization_provider_response(response: object) -> dict[str, Any]:
    """Parse the model response using the TS flexible patch-envelope rules.

    The provider adapters deliberately retain raw text, rather than raising on
    malformed JSON.  This stage must preserve that signal as a warning so the
    bounded corrective retry in ``normalize_pdp_product_with_agent`` can act.
    """

    raw_text = getattr(response, "text", "")
    raw_text = raw_text if isinstance(raw_text, str) else ""
    usage = getattr(response, "usage", None)
    usage_value: dict[object, object] | None = (
        dict(cast(Mapping[object, object], usage)) if isinstance(usage, Mapping) else None
    )
    common: dict[str, Any] = {"rawText": raw_text}
    if usage_value is not None:
        common["usage"] = usage_value
    if not raw_text.strip():
        return {"warnings": ["No parseable product normalization JSON returned."], **common}
    try:
        decoded = json.loads(raw_text)
    except (TypeError, json.JSONDecodeError):
        return {"warnings": ["Product normalization JSON could not be parsed."], **common}
    if not isinstance(decoded, Mapping):
        return {
            "warnings": ["Product normalization JSON failed schema validation: root: Expected object."],
            **common,
        }
    try:
        parsed = _validate_flexible_product_normalization_envelope(cast(Mapping[object, object], decoded))
    except _ProductNormalizationSchemaError as error:
        return {"warnings": [f"Product normalization JSON failed schema validation: {error}"], **common}

    result: dict[str, Any] = {"warnings": list(parsed.get("warnings", [])), **common}
    if "product" in parsed:
        result["product"] = _compact_nullish_patch(parsed["product"])
    if "locale" in parsed:
        result["locale"] = parsed["locale"]
    if "market" in parsed:
        result["market"] = parsed["market"]
    return result


def _validate_flexible_product_normalization_envelope(value: Mapping[object, object]) -> dict[str, Any]:
    allowed = {"product", "locale", "market", "warnings"}
    _require_no_unknown_keys(value, allowed, "root")
    parsed: dict[str, Any] = {}
    if "product" in value:
        product = value["product"]
        if not isinstance(product, Mapping):
            raise _ProductNormalizationSchemaError("product: Expected object.")
        parsed["product"] = _validate_product_patch(cast(Mapping[object, object], product))
    if "locale" in value:
        locale = value["locale"]
        if not isinstance(locale, str) or locale not in _NORMALIZATION_LOCALES:
            raise _ProductNormalizationSchemaError("locale: Invalid enum value.")
        parsed["locale"] = locale
    if "market" in value:
        market = value["market"]
        if market is not None and not isinstance(market, str):
            raise _ProductNormalizationSchemaError("market: Expected string.")
        parsed["market"] = market
    if "warnings" in value:
        parsed["warnings"] = _validate_string_array(value["warnings"], "warnings", nullable=False)
    return parsed


def _validate_product_patch(value: Mapping[object, object]) -> dict[str, Any]:
    _require_no_unknown_keys(value, _PRODUCT_PATCH_FIELDS, "product")
    parsed = dict(cast(Mapping[str, Any], value))
    for key in _PRODUCT_PATCH_TEXT_FIELDS:
        if key in parsed and parsed[key] is not None and not isinstance(parsed[key], str):
            raise _ProductNormalizationSchemaError(f"product.{key}: Expected string.")
    for key in _PRODUCT_PATCH_STRING_ARRAY_FIELDS:
        if key in parsed:
            parsed[key] = _validate_string_array(parsed[key], f"product.{key}")
    if "price" in parsed:
        parsed["price"] = _validate_price_patch(parsed["price"])
    if "faq" in parsed:
        parsed["faq"] = _validate_faq_patch(parsed["faq"])
    if "reviews" in parsed:
        parsed["reviews"] = _validate_reviews_patch(parsed["reviews"])
    if "breadcrumbs" in parsed:
        parsed["breadcrumbs"] = _validate_breadcrumb_patch(parsed["breadcrumbs"])
    if "semanticFacts" in parsed:
        parsed["semanticFacts"] = _validate_semantic_facts_patch(parsed["semanticFacts"])
    return parsed


def _validate_price_patch(value: object) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise _ProductNormalizationSchemaError("product.price: Expected object.")
    record = cast(Mapping[object, object], value)
    _require_no_unknown_keys(record, {"raw", "amount", "currency"}, "product.price")
    raw: object | None = record.get("raw")
    if not isinstance(raw, str):
        raise _ProductNormalizationSchemaError("product.price.raw: Expected string.")
    amount: object | None = record.get("amount")
    if amount is not None and not _is_finite_number(amount):
        raise _ProductNormalizationSchemaError("product.price.amount: Expected finite number.")
    currency: object | None = record.get("currency")
    if currency is not None and not isinstance(currency, str):
        raise _ProductNormalizationSchemaError("product.price.currency: Expected string.")
    return {"raw": raw, **({"amount": amount} if "amount" in record else {}), **({"currency": currency} if "currency" in record else {})}


def _validate_faq_patch(value: object) -> list[dict[str, str]] | None:
    if value is None:
        return None
    if not isinstance(value, list):
        raise _ProductNormalizationSchemaError("product.faq: Expected array.")
    parsed: list[dict[str, str]] = []
    for index, item in enumerate(cast(list[object], value)):
        if not isinstance(item, Mapping):
            raise _ProductNormalizationSchemaError(f"product.faq.{index}: Expected object.")
        record = cast(Mapping[object, object], item)
        _require_no_unknown_keys(record, {"question", "answer"}, f"product.faq.{index}")
        question, answer = record.get("question"), record.get("answer")
        if not isinstance(question, str) or not isinstance(answer, str):
            raise _ProductNormalizationSchemaError(f"product.faq.{index}: Expected question and answer strings.")
        parsed.append({"question": question, "answer": answer})
    return parsed


def _validate_reviews_patch(value: object) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise _ProductNormalizationSchemaError("product.reviews: Expected object.")
    record = cast(Mapping[object, object], value)
    _require_no_unknown_keys(record, {"rating", "reviewCount", "items", "keywords"}, "product.reviews")
    parsed = dict(cast(Mapping[str, Any], record))
    for key in ("rating", "reviewCount"):
        if key in parsed and parsed[key] is not None and not _is_finite_number(parsed[key]):
            raise _ProductNormalizationSchemaError(f"product.reviews.{key}: Expected finite number.")
    if "keywords" in parsed:
        parsed["keywords"] = _validate_string_array(parsed["keywords"], "product.reviews.keywords", nullable=False)
    if "items" in parsed:
        raw_items = parsed["items"]
        if not isinstance(raw_items, list):
            raise _ProductNormalizationSchemaError("product.reviews.items: Expected array.")
        items: list[dict[str, Any]] = []
        for index, item in enumerate(cast(list[object], raw_items)):
            if not isinstance(item, Mapping):
                raise _ProductNormalizationSchemaError(f"product.reviews.items.{index}: Expected object.")
            item_record = cast(Mapping[object, object], item)
            _require_no_unknown_keys(item_record, {"body", "author", "rating", "datePublished"}, f"product.reviews.items.{index}")
            body = item_record.get("body")
            if not isinstance(body, str):
                raise _ProductNormalizationSchemaError(f"product.reviews.items.{index}.body: Expected string.")
            author = item_record.get("author")
            if author is not None and not isinstance(author, str):
                raise _ProductNormalizationSchemaError(f"product.reviews.items.{index}.author: Expected string.")
            rating = item_record.get("rating")
            if rating is not None and not _is_finite_number(rating):
                raise _ProductNormalizationSchemaError(f"product.reviews.items.{index}.rating: Expected finite number.")
            date_published = item_record.get("datePublished")
            if date_published is not None and not isinstance(date_published, str):
                raise _ProductNormalizationSchemaError(f"product.reviews.items.{index}.datePublished: Expected string.")
            items.append(dict(cast(Mapping[str, Any], item_record)))
        parsed["items"] = items
    return parsed


def _validate_breadcrumb_patch(value: object) -> list[dict[str, Any]] | None:
    if value is None:
        return None
    if not isinstance(value, list):
        raise _ProductNormalizationSchemaError("product.breadcrumbs: Expected array.")
    parsed: list[dict[str, Any]] = []
    for index, item in enumerate(cast(list[object], value)):
        if not isinstance(item, Mapping):
            raise _ProductNormalizationSchemaError(f"product.breadcrumbs.{index}: Expected object.")
        record = cast(Mapping[object, object], item)
        _require_no_unknown_keys(record, {"name", "url"}, f"product.breadcrumbs.{index}")
        name = record.get("name")
        if not isinstance(name, str):
            raise _ProductNormalizationSchemaError(f"product.breadcrumbs.{index}.name: Expected string.")
        url = record.get("url")
        if url is not None and not isinstance(url, str):
            raise _ProductNormalizationSchemaError(f"product.breadcrumbs.{index}.url: Expected string.")
        parsed.append(dict(cast(Mapping[str, Any], record)))
    return parsed


def _validate_semantic_facts_patch(value: object) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise _ProductNormalizationSchemaError("product.semanticFacts: Expected object.")
    record = cast(Mapping[object, object], value)
    _require_no_unknown_keys(record, _SEMANTIC_FACT_PATCH_FIELDS, "product.semanticFacts")
    parsed = dict(cast(Mapping[str, Any], record))
    for key in ("ingredients", "benefits", "effects", "skinTypes", "usageSteps", "safetyTests", "evidenceSentences"):
        if key in parsed:
            parsed[key] = _validate_string_array(parsed[key], f"product.semanticFacts.{key}", nullable=False)
    for key in ("metricClaims", "ingredientBenefitLinks", "citations"):
        if key in parsed and not isinstance(parsed[key], list):
            raise _ProductNormalizationSchemaError(f"product.semanticFacts.{key}: Expected array.")
    return parsed


def _validate_string_array(value: object, path: str, *, nullable: bool = True) -> list[str] | None:
    if value is None and nullable:
        return None
    if not isinstance(value, list):
        raise _ProductNormalizationSchemaError(f"{path}: Expected string array.")
    values = cast(list[object], value)
    if not all(isinstance(item, str) for item in values):
        raise _ProductNormalizationSchemaError(f"{path}: Expected string array.")
    return list(cast(list[str], values))


def _require_no_unknown_keys(value: Mapping[object, object], allowed: set[str] | frozenset[str], path: str) -> None:
    extra = next((str(key) for key in value if not isinstance(key, str) or key not in allowed), None)
    if extra is not None:
        raise _ProductNormalizationSchemaError(f"{path}.{extra}: Unrecognized key.")


def _is_finite_number(value: object) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(float(value))


def _compact_nullish_patch(value: object) -> Any:
    if isinstance(value, list):
        values = cast(list[object], value)
        return [compacted for item in values if (compacted := _compact_nullish_patch(item)) is not None]
    if isinstance(value, Mapping):
        mapping = cast(Mapping[object, object], value)
        return {
            str(key): compacted
            for key, item in mapping.items()
            if (compacted := _compact_nullish_patch(item)) is not None
        }
    return value


def _resolve_product_normalizer(runtime: Mapping[str, Any]) -> tuple[object | None, str | None]:
    custom = runtime.get("customProductNormalizer")
    if custom is not None:
        return custom, None
    settings = as_dict(runtime.get("productNormalization"))
    if settings.get("enabled") is not True:
        return None, None
    provider = clean_text(settings.get("provider") or runtime.get("provider") or "mock")
    if provider in {"mock", "custom"}:
        return None, f"{provider} product normalization requires customProductNormalizer."
    inherits = not settings.get("provider") or settings.get("provider") == runtime.get("provider")
    config = {
        "provider": provider,
        "apiKey": settings.get("apiKey") or (runtime.get("apiKey") if inherits else None),
        "model": settings.get("model") or (runtime.get("model") if inherits else None),
        "endpoint": settings.get("endpoint") or (runtime.get("endpoint") if inherits else None),
        "deployment": settings.get("deployment")
        or (as_dict(runtime.get("deployments")).get("reasoning") if inherits else None)
        or (runtime.get("deployment") if inherits else None),
        "apiVersion": settings.get("apiVersion") or (runtime.get("apiVersion") if inherits else None),
        "temperature": runtime.get("temperature"),
        # Transport injection is a test/runtime adapter detail; it is not part
        # of the public control plane, but must follow the selected provider
        # config so model-backed retries exercise the same connection.
        "transport": settings.get("transport") or (runtime.get("transport") if inherits else None),
        "timeoutSeconds": settings.get("timeoutSeconds") or (runtime.get("timeoutSeconds") if inherits else None),
    }
    return ModelBackedProductNormalizer(config), None


def _needs_corrective_retry(result: Mapping[str, Any]) -> bool:
    # JavaScript treats `{}` as truthy.  A valid-but-empty patch must not spend
    # the one corrective provider call; only a genuinely absent patch can.
    product = result.get("product")
    warnings = "\n".join(str(item) for item in as_list(result.get("warnings")))
    return product is None and bool(re.search(r"no parseable|could not be parsed|schema validation", warnings, re.I))


def _apply_product_normalization(
    bootstrap: Mapping[str, Any], result: Mapping[str, Any], raw_product: object
) -> dict[str, Any]:
    next_product = _clone_product(bootstrap)
    incoming = as_dict(result.get("product"))
    corpus = _source_corpus(raw_product, bootstrap)
    product_fact_corpus = _product_fact_corpus(raw_product, bootstrap)
    identity_sources = _identity_source_values(raw_product, bootstrap)
    source_faq_pairs = _source_faq_pairs(raw_product, bootstrap)
    warnings: list[str] = []
    evidence: list[dict[str, str]] = []
    changed: list[str] = []

    for field in ("name", "originalName", "description", "brand", "category"):
        if field not in incoming or incoming[field] is None:
            continue
        candidate = clean_text(incoming.get(field))
        source_backed = (
            _source_backed_identity(candidate, identity_sources) if field == "name" else _source_backed(candidate, corpus)
        )
        if candidate and source_backed:
            if candidate != clean_text(next_product.get(field)):
                next_product[field] = candidate
                changed.append(field)
        elif candidate:
            warnings.append(f"Model {field} normalization was rejected because it was not source-backed.")

    for field in ("images", "options", "benefits", "effects", "ingredients", "metrics", "sourceTexts"):
        if field not in incoming or incoming[field] is None:
            continue
        candidates = _unique(clean_text(item) for item in as_list(incoming.get(field)))
        field_corpus = product_fact_corpus if field in {"benefits", "effects", "ingredients"} else corpus
        accepted = _source_backed_values(candidates, field_corpus, allow_url_like=field == "images")
        if accepted:
            next_product[field] = accepted
            changed.append(field)
        elif candidates:
            warnings.append(f"Model {field} normalization was rejected because no values were source-backed.")

    bootstrap_usage_values = [clean_text(item) for item in as_list(bootstrap.get("usage"))]
    bootstrap_usage = dedupe_pdp_usage_instructions(
        extract_explicit_numbered_usage_steps(bootstrap_usage_values)
        or _filter_values_by_evidence_role(bootstrap_usage_values, "usage")
    )
    if bootstrap_usage:
        next_product["usage"] = bootstrap_usage
        if "usage" in incoming and incoming["usage"] is not None:
            accepted_usage = _source_backed_values(
                _unique(clean_text(item) for item in as_list(incoming.get("usage"))), corpus
            )
            if _normalize_evidence("\n".join(accepted_usage)) != _normalize_evidence("\n".join(bootstrap_usage)):
                warnings.append("Model usage normalization was ignored to preserve source instruction boundaries and order.")
    elif "usage" in incoming and incoming["usage"] is not None:
        candidates = _unique(clean_text(item) for item in as_list(incoming.get("usage")))
        accepted = _source_backed_values(candidates, corpus)
        if accepted:
            next_product["usage"] = accepted
            changed.append("usage")
        elif candidates:
            warnings.append("Model usage normalization was rejected because no values were source-backed.")

    next_product["benefits"] = _filter_values_by_evidence_role(
        [clean_text(item) for item in as_list(next_product.get("benefits"))], "benefit"
    )
    next_product["effects"] = _filter_values_by_evidence_role(
        [clean_text(item) for item in as_list(next_product.get("effects"))], "effect"
    )
    next_product["ingredients"] = _filter_values_by_evidence_role(
        [clean_text(item) for item in as_list(next_product.get("ingredients"))], "ingredient"
    )
    next_usage_values = [clean_text(item) for item in as_list(next_product.get("usage"))]
    next_product["usage"] = dedupe_pdp_usage_instructions(
        extract_explicit_numbered_usage_steps(next_usage_values)
        or _filter_values_by_evidence_role(next_usage_values, "usage")
    )
    next_product["metrics"] = _filter_values_by_evidence_role(
        [clean_text(item) for item in as_list(next_product.get("metrics"))], "metric"
    )

    # Array fields are first checked for source overlap, then routed through
    # their semantic role gate.  Report an update only after both phases: an
    # incoming shipping line that is source-backed but later removed as a
    # non-benefit must not produce an "accepted benefits" diagnostic.
    for field in ("benefits", "effects", "ingredients", "usage", "metrics"):
        current_values = [clean_text(item) for item in as_list(next_product.get(field)) if clean_text(item)]
        bootstrap_values = [clean_text(item) for item in as_list(bootstrap.get(field)) if clean_text(item)]
        changed_before_filter = field in changed
        same_as_bootstrap = _normalize_evidence("\n".join(current_values)) == _normalize_evidence(
            "\n".join(bootstrap_values)
        )
        if same_as_bootstrap:
            changed = [item for item in changed if item != field]
        elif field in incoming and not changed_before_filter:
            changed.append(field)
        if field in {"benefits", "effects"} and field in incoming:
            incoming_values = [clean_text(item) for item in as_list(incoming.get(field)) if clean_text(item)]
            if incoming_values and not current_values:
                warnings.append(
                    f"Model {field} normalization was rejected because no role-coherent source-backed values remained."
                )

    price = as_dict(incoming.get("price"))
    if price:
        raw = clean_text(price.get("raw"))
        if raw and _source_backed(raw, corpus):
            next_price: dict[str, Any] = {"raw": raw}
            amount = price.get("amount")
            if isinstance(amount, int | float) and not isinstance(amount, bool):
                next_price["amount"] = amount
            elif as_dict(bootstrap.get("price")).get("amount") is not None:
                next_price["amount"] = as_dict(bootstrap.get("price")).get("amount")
            currency = clean_text(price.get("currency")) or clean_text(as_dict(bootstrap.get("price")).get("currency"))
            if currency:
                next_price["currency"] = currency
            next_product["price"] = next_price
            changed.append("price")
        elif raw:
            warnings.append("Model price normalization was rejected because it was not source-backed.")

    faq = as_list(incoming.get("faq"))
    if "faq" in incoming and incoming["faq"] is not None:
        accepted_faq: list[dict[str, str]] = []
        for item in faq:
            item_mapping = as_dict(item)
            accepted_pair = _source_backed_faq_pair(
                item_mapping.get("question"), item_mapping.get("answer"), source_faq_pairs
            )
            if accepted_pair is not None:
                question, answer = accepted_pair
                accepted_faq.append({"question": question, "answer": answer})
        if accepted_faq:
            next_product["faq"] = _unique_records(accepted_faq, lambda item: f"{item['question']}\n{item['answer']}")[
                :10
            ]
            changed.append("faq")
        elif faq:
            warnings.append(
                "Model FAQ normalization was rejected because question/answer evidence was not source-backed."
            )

    breadcrumbs = as_list(incoming.get("breadcrumbs"))
    if "breadcrumbs" in incoming and incoming["breadcrumbs"] is not None:
        accepted_breadcrumbs: list[dict[str, str]] = []
        for raw in breadcrumbs:
            item = as_dict(raw)
            name = clean_text(item.get("name"))
            if not name or not _source_backed(name, corpus):
                continue
            url = clean_text(item.get("url"))
            accepted_breadcrumbs.append({"name": name, **({"url": url} if url else {})})
        if accepted_breadcrumbs:
            next_product["breadcrumbs"] = accepted_breadcrumbs[:8]
            changed.append("breadcrumbs")

    reviews = as_dict(incoming.get("reviews"))
    if reviews:
        next_reviews = dict(as_dict(next_product.get("reviews")))
        items = [
            dict(item)
            for raw in as_list(reviews.get("items"))
            if (item := as_dict(raw))
            and (body := clean_text(item.get("body")))
            and len(body) >= 16
            and _source_backed(body, corpus)
            and not _identity_echo(body, bootstrap)
        ]
        has_keywords = isinstance(reviews.get("keywords"), Sequence) and not isinstance(
            reviews.get("keywords"), str | bytes | bytearray
        )
        keywords = _source_backed_values(
            _unique(clean_text(item) for item in as_list(reviews.get("keywords"))), corpus, allow_short_overlap=True
        )[:18]
        has_rating = isinstance(reviews.get("rating"), int | float) and not isinstance(reviews.get("rating"), bool)
        has_review_count = isinstance(reviews.get("reviewCount"), int | float) and not isinstance(
            reviews.get("reviewCount"), bool
        )
        if items or keywords or has_rating or has_review_count:
            next_reviews["rating"] = reviews.get("rating") if has_rating else as_dict(bootstrap.get("reviews")).get("rating")
            next_reviews["reviewCount"] = (
                reviews.get("reviewCount") if has_review_count else as_dict(bootstrap.get("reviews")).get("reviewCount")
            )
            next_reviews["items"] = _unique_records(items, lambda item: clean_text(item.get("body")))[:12] or [
                dict(as_dict(item)) for item in as_list(as_dict(bootstrap.get("reviews")).get("items"))
            ]
            next_reviews["keywords"] = (
                keywords if has_keywords else list(as_list(as_dict(bootstrap.get("reviews")).get("keywords")))
            )
            next_product["reviews"] = next_reviews
            changed.append("reviews")

    semantic = as_dict(incoming.get("semanticFacts"))
    if semantic:
        accepted_semantic = _source_backed_semantic_facts(semantic, corpus, product_fact_corpus, next_product)
        if _semantic_count(accepted_semantic):
            next_product["semanticFacts"] = accepted_semantic
            changed.append("semanticFacts")
        elif _semantic_input_count(semantic):
            warnings.append(
                "Model semanticFacts normalization was rejected because no role-coherent source-backed facts remained."
            )

    for field in _unique(changed):
        evidence.append({"field": f"product.{field}", "source": "llm", "value": "Accepted source-backed model normalization."})

    scoped = dict(filter_current_product_usage_instructions(next_product))
    source_usage = [clean_text(item) for item in as_list(next_product.get("usage")) if clean_text(item)]
    if not any(is_conflicting_product_usage_instruction(item, next_product) for item in source_usage):
        # Product scoping splits ordinary "then" clauses while looking for a
        # foreign-product reference.  Preserve a source-owned instruction as
        # one item when there is no conflicting product to remove.
        scoped["usage"] = source_usage
    if len(as_list(scoped.get("usage"))) != len(as_list(next_product.get("usage"))):
        changed.append("usage")
        evidence.append(
            {
                "field": "product.usage",
                "source": "llm",
                "value": "Removed usage instructions that matched a related but different product in the same routine.",
            }
        )
    changed = _unique(changed)
    return {
        "product": scoped,
        "evidence": evidence,
        "warnings": warnings,
        "changedFields": changed,
        "applied": bool(changed),
    }


def _clone_product(value: Mapping[str, Any]) -> dict[str, Any]:
    copied = dict(value)
    for field in _ARRAY_FIELDS | {"faq", "breadcrumbs"}:
        if field in copied:
            copied[field] = [as_dict(cast(object, item)) if isinstance(item, Mapping) else item for item in as_list(copied[field])]
    if isinstance(copied.get("price"), Mapping):
        copied["price"] = dict(as_dict(copied["price"]))
    if isinstance(copied.get("reviews"), Mapping):
        reviews = dict(as_dict(copied["reviews"]))
        reviews["items"] = [dict(as_dict(item)) for item in as_list(reviews.get("items"))]
        reviews["keywords"] = list(as_list(reviews.get("keywords")))
        copied["reviews"] = reviews
    return copied


def _source_corpus(raw_product: object, bootstrap: Mapping[str, Any]) -> str:
    """Return the raw legacy source corpus (normalization happens at lookup).

    TypeScript deliberately uses all raw scalar source values plus a defined
    set of bootstrap fields.  Keeping the corpus raw is important for the
    citation URL exact-match rule, while ``_source_backed`` supplies the NFKC
    comparison normalization used for ordinary text.
    """

    reviews = as_dict(bootstrap.get("reviews"))
    values = [
        *_flatten_text_values(raw_product),
        *(
            clean_text(value)
            for value in (
                bootstrap.get("name"),
                bootstrap.get("originalName"),
                bootstrap.get("description"),
                bootstrap.get("brand"),
                bootstrap.get("category"),
                as_dict(bootstrap.get("price")).get("raw"),
                as_dict(bootstrap.get("price")).get("currency"),
            )
        ),
        *[clean_text(value) for value in as_list(bootstrap.get("images"))],
        *[clean_text(value) for value in as_list(bootstrap.get("options"))],
        *[clean_text(value) for value in as_list(bootstrap.get("benefits"))],
        *[clean_text(value) for value in as_list(bootstrap.get("effects"))],
        *[clean_text(value) for value in as_list(bootstrap.get("ingredients"))],
        *[clean_text(value) for value in as_list(bootstrap.get("usage"))],
        *[clean_text(value) for value in as_list(bootstrap.get("metrics"))],
        *[clean_text(value) for value in as_list(bootstrap.get("sourceTexts"))],
        *[
            clean_text(part)
            for item in as_list(bootstrap.get("faq"))
            for part in (as_dict(item).get("question"), as_dict(item).get("answer"))
        ],
        *[clean_text(as_dict(item).get("body")) for item in as_list(reviews.get("items"))],
        *[clean_text(value) for value in as_list(reviews.get("keywords"))],
        *[
            clean_text(part)
            for item in as_list(bootstrap.get("breadcrumbs"))
            for part in (as_dict(item).get("name"), as_dict(item).get("url"))
        ],
    ]
    return "\n".join(_unique(values))


def _identity_source_values(raw_product: object, bootstrap: Mapping[str, Any]) -> list[str]:
    """Return source-declared identity values, never a fuzzy page-wide token bag."""

    values = [
        clean_text(bootstrap.get("name")),
        clean_text(bootstrap.get("originalName")),
        *_identity_values_from_source(raw_product, isinstance(raw_product, str)),
    ]
    return _unique(value for value in values if value)


def _identity_values_from_source(value: object, identity_context: bool = False) -> list[str]:
    if isinstance(value, str):
        return [clean_text(value)] if identity_context and clean_text(value) else []
    if isinstance(value, Mapping):
        mapping = cast(Mapping[str, object], value)
        return [
            identity
            for key, child in mapping.items()
            for identity in _identity_values_from_source(
                child, identity_context or _is_identity_source_key(str(key))
            )
        ]
    if isinstance(value, Sequence) and not isinstance(value, str | bytes | bytearray):
        values = cast(Sequence[object], value)
        return [identity for child in values for identity in _identity_values_from_source(child, identity_context)]
    return []


def _is_identity_source_key(value: str) -> bool:
    normalized = _normalize_evidence(value).replace(" ", "")
    return (
        bool(normalized)
        and "category" not in normalized
        and "type" not in normalized
        and (normalized == "displaylabel" or normalized.endswith(("name", "title", "sku", "variant")))
    )


def _source_backed_identity(value: str, sources: Sequence[str]) -> bool:
    normalized_value = _normalize_evidence(value)
    return bool(normalized_value) and any(_normalize_evidence(source) == normalized_value for source in sources)


def _source_faq_pairs(raw_product: object, bootstrap: Mapping[str, Any]) -> list[tuple[str, str]]:
    return [*_faq_pairs_from_source(raw_product), *_faq_pairs_from_source(bootstrap)]


def _faq_pairs_from_source(value: object) -> list[tuple[str, str]]:
    if isinstance(value, Mapping):
        mapping = cast(Mapping[str, object], value)
        question = clean_text(mapping.get("question"))
        answer = clean_text(mapping.get("answer"))
        accepted_answer = as_dict(mapping.get("acceptedAnswer"))
        if not answer and accepted_answer:
            question = question or clean_text(mapping.get("name"))
            answer = clean_text(accepted_answer.get("text"))
        direct = [(question, answer)] if question and answer else []
        return [*direct, *[pair for child in mapping.values() for pair in _faq_pairs_from_source(child)]]
    if isinstance(value, Sequence) and not isinstance(value, str | bytes | bytearray):
        values = cast(Sequence[object], value)
        return [pair for child in values for pair in _faq_pairs_from_source(child)]
    return []


def _source_backed_faq_pair(
    question: object, answer: object, source_pairs: Sequence[tuple[str, str]]
) -> tuple[str, str] | None:
    cleaned_question, cleaned_answer = clean_text(question), clean_text(answer)
    if not cleaned_question or not cleaned_answer:
        return None
    normalized_pair = (_normalize_evidence(cleaned_question), _normalize_evidence(cleaned_answer))
    return (
        (cleaned_question, cleaned_answer)
        if any((_normalize_evidence(source_question), _normalize_evidence(source_answer)) == normalized_pair for source_question, source_answer in source_pairs)
        else None
    )


def _product_fact_corpus(raw_product: object, bootstrap: Mapping[str, Any]) -> str:
    """Exclude review/derived provenance before product-fact source checks."""

    bootstrap_reviews = as_dict(bootstrap.get("reviews"))
    review_texts = _unique(
        [
            *_flatten_review_provenance_text_values(raw_product),
            *[clean_text(as_dict(item).get("body")) for item in as_list(bootstrap_reviews.get("items"))],
            *[clean_text(item) for item in as_list(bootstrap_reviews.get("keywords"))],
        ]
    )
    review_keys = [_normalize_evidence(value) for value in review_texts if _normalize_evidence(value)]
    non_review_raw = [
        value
        for value in _flatten_non_review_text_values(raw_product)
        if not _is_review_backed_source_unit(value, review_keys)
    ]
    semantic = as_dict(bootstrap.get("semanticFacts"))
    link_values = [
        clean_text(part)
        for item in as_list(semantic.get("ingredientBenefitLinks"))
        for part in (
            as_dict(item).get("ingredient"),
            as_dict(item).get("benefit"),
            as_dict(item).get("effect"),
            as_dict(item).get("sentence"),
            as_dict(item).get("sourceText"),
        )
    ]
    values = [
        *non_review_raw,
        *[clean_text(item) for item in as_list(bootstrap.get("benefits"))],
        *[clean_text(item) for item in as_list(bootstrap.get("effects"))],
        *[clean_text(item) for item in as_list(bootstrap.get("ingredients"))],
        *[clean_text(item) for item in as_list(semantic.get("ingredients"))],
        *[clean_text(item) for item in as_list(semantic.get("benefits"))],
        *[clean_text(item) for item in as_list(semantic.get("effects"))],
        *link_values,
    ]
    return "\n".join(_unique(values))


def _flatten_text_values(value: object, depth: int = 0) -> list[str]:
    if depth > 12:
        return []
    if isinstance(value, str):
        return [clean_text(value)] if clean_text(value) else []
    if isinstance(value, int | float | bool):
        return [_scalar_text(value)]
    if isinstance(value, Mapping):
        return [
            item
            for child in as_dict(cast(object, value)).values()
            for item in _flatten_text_values(child, depth + 1)
        ]
    if isinstance(value, Sequence) and not isinstance(value, str | bytes | bytearray):
        return [item for child in as_list(cast(object, value)) for item in _flatten_text_values(child, depth + 1)]
    return []


def _scalar_text(value: int | float | bool) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _normalized_provenance_key(value: str) -> str:
    return re.sub(r"[^\w]+", "", value.casefold())


def _is_review_provenance_key(value: str) -> bool:
    normalized = _normalized_provenance_key(value)
    return bool(
        re.search(
            r"review|reviewer|customerfeedback|testimonial|rating|feedback|리뷰|후기|평점|レビュー|口コミ|評価",
            normalized,
            re.I,
        )
    )


def _is_derived_key(value: str) -> bool:
    normalized = _normalized_provenance_key(value)
    return normalized in _DERIVED_KEYS or bool(re.search(r"(?:keyword|chunk|derived|embedding|vector)", normalized, re.I))


def _is_review_provenance_record(value: Mapping[str, Any]) -> bool:
    keys = [str(key) for key in value]
    return any(_is_review_provenance_key(key) for key in keys) or (
        "body" in value and any(key in value for key in ("author", "rating", "datePublished"))
    )


def _flatten_non_review_text_values(value: object, depth: int = 0) -> list[str]:
    if depth > 12:
        return []
    if isinstance(value, str):
        return [clean_text(value)] if clean_text(value) else []
    if isinstance(value, int | float | bool):
        return [_scalar_text(value)]
    if isinstance(value, Sequence) and not isinstance(value, str | bytes | bytearray):
        return [
            item
            for child in as_list(cast(object, value))
            for item in _flatten_non_review_text_values(child, depth + 1)
        ]
    if not isinstance(value, Mapping):
        return []
    record = as_dict(cast(object, value))
    if _is_review_provenance_record(record):
        return []
    return [
        nested
        for key, child in record.items()
        if not _is_review_provenance_key(key) and not _is_derived_key(key)
        for nested in _flatten_non_review_text_values(child, depth + 1)
    ]


def _flatten_review_provenance_text_values(value: object, review_scope: bool = False, depth: int = 0) -> list[str]:
    if depth > 12:
        return []
    if isinstance(value, str):
        text = clean_text(value)
        return [text] if review_scope and text else []
    if isinstance(value, int | float | bool):
        return [_scalar_text(value)] if review_scope else []
    if isinstance(value, Sequence) and not isinstance(value, str | bytes | bytearray):
        return [
            item
            for child in as_list(cast(object, value))
            for item in _flatten_review_provenance_text_values(child, review_scope, depth + 1)
        ]
    if not isinstance(value, Mapping):
        return []
    record = as_dict(cast(object, value))
    record_review_scope = review_scope or _is_review_provenance_record(record)
    return [
        nested
        for key, child in record.items()
        for nested in _flatten_review_provenance_text_values(
            child, record_review_scope or _is_review_provenance_key(key), depth + 1
        )
    ]


def _is_review_backed_source_unit(value: str, review_keys: Sequence[str]) -> bool:
    normalized = _normalize_evidence(value)
    if not normalized:
        return False
    return any(
        review == normalized
        or (len(normalized) >= 12 and review.find(normalized) >= 0)
        or (len(review) >= 12 and normalized.find(review) >= 0)
        for review in review_keys
    )


def _source_backed(
    value: str,
    corpus: str,
    *,
    allow_url_like: bool = False,
    allow_short_overlap: bool = False,
) -> bool:
    text = clean_text(value)
    if not text:
        return False
    if allow_url_like and re.match(r"^https?://", text, re.I):
        return True
    normalized_corpus = _normalize_evidence(corpus)
    normalized_text = _normalize_evidence(text)
    if normalized_text in normalized_corpus:
        return True
    return (allow_short_overlap or len(text) >= 12) and _token_overlap_ratio(text, corpus) >= 0.66


def _source_backed_values(
    values: Sequence[str], corpus: str, *, allow_url_like: bool = False, allow_short_overlap: bool = False
) -> list[str]:
    return _unique(
        value
        for value in values
        if _source_backed(
            value, corpus, allow_url_like=allow_url_like, allow_short_overlap=allow_short_overlap
        )
    )


def _normalize_evidence(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return re.sub(r"\s+", " ", re.sub(r"[\W_]", " ", normalized, flags=re.UNICODE)).strip()


def _identity_echo(body: str, bootstrap: Mapping[str, Any]) -> bool:
    normalized = " ".join(body.casefold().split())
    return any(
        normalized == " ".join(clean_text(bootstrap.get(key)).casefold().split())
        for key in ("name", "originalName", "brand")
    )


def _evidence_tokens(value: str) -> list[str]:
    return [token for token in _normalize_evidence(value).split() if len(token) >= 2]


def _token_overlap_ratio(value: str, corpus: str) -> float:
    tokens = _evidence_tokens(value)
    if not tokens:
        return 0.0
    corpus_tokens = set(_evidence_tokens(corpus))
    return sum(token in corpus_tokens for token in tokens) / len(tokens)


def _filter_values_by_evidence_role(values: Sequence[str], role: str) -> list[str]:
    return _unique(value for value in values if _evidence_role_accepts(value, role))


def _evidence_role_accepts(value: str, role: str) -> bool:
    inference = as_dict(infer_pdp_evidence_roles(value))
    roles = {clean_text(item) for item in as_list(inference.get("roles"))}
    actionable_instruction = _is_actionable_customer_instruction(value)
    if role == "usage":
        return actionable_instruction
    if actionable_instruction:
        return False
    if role in roles:
        return True
    if role == "ingredient":
        return _safe_model_routed_ingredient(value, roles)
    if role in {"benefit", "effect"}:
        return _safe_model_routed_outcome(value, roles)
    return False


def _is_actionable_customer_instruction(value: str) -> bool:
    """Require an imperative customer action, not a formula or test-use mention."""

    text = clean_text(value)
    if not text or len(text) > 320 or re.search(r"[?？]", text):
        return False
    return bool(
        re.search(
            r"\b(?:apply|dispense|smooth|press|massage|rinse|pat|spread|lather|spray|spritz|dot|tap)\b|"
            r"\buse\s+(?:morning|night|daily|twice|once|after|before|with|on|to)\b|"
            r"적당량|덜어|펴\s*발|바르|바릅|문지르|눌러|두드려|흡수시켜|흡수시킵|분사|뿌려",
            text,
            re.I,
        )
    )


def _safe_model_routed_ingredient(value: str, inferred_roles: set[str]) -> bool:
    text = clean_text(value)
    conflicting = {"audience", "benefit", "effect", "usage", "safety", "review", "metric", "faq", "commerce"}
    if (
        not text
        or len(text) > 120
        or inferred_roles & conflicting
        or _is_actionable_customer_instruction(text)
        or re.search(r"[?？]", text)
    ):
        return False
    return not bool(
        re.fullmatch(
            r"(?:absorption|absorbency|retention|persistence|texture|finish|efficacy|effect|duration|hydration|moisture|firmness|"
            r"흡수력|흡수성|잔존|유지력|지속력|제형|질감|사용감|효능|효과|기간|보습력|수분감|탄력|피부\s*타입|"
            r"\d+(?:[.,]\d+)?\s*(?:%|％|배|hours?|days?|weeks?|시간|일|주)?)",
            text,
            re.I,
        )
    )


def _safe_model_routed_outcome(value: str, inferred_roles: set[str]) -> bool:
    text = clean_text(value)
    return bool(text) and len(text) <= 320 and not (inferred_roles & {"usage", "safety", "review", "metric", "faq", "commerce"}) and not bool(re.search(r"[?？]", text))


def _source_backed_semantic_facts(
    value: Mapping[str, Any], source_corpus: str, product_fact_corpus: str, bootstrap_product: Mapping[str, Any]
) -> dict[str, Any]:
    bootstrap_semantic = sanitize_pdp_semantic_facts(bootstrap_product.get("semanticFacts"))
    source_backed_usage_steps = _source_backed_values(
        _strings(value.get("usageSteps")), source_corpus, allow_short_overlap=True
    )
    explicit_usage_procedure = extract_explicit_numbered_usage_steps(source_backed_usage_steps)
    candidate: dict[str, Any] = {
        "ingredients": _filter_values_by_evidence_role(
            _source_backed_values(_strings(value.get("ingredients")), product_fact_corpus, allow_short_overlap=True),
            "ingredient",
        ),
        "benefits": _source_backed_values(
            _strings(value.get("benefits")), product_fact_corpus, allow_short_overlap=True
        ),
        "effects": _source_backed_values(
            _strings(value.get("effects")), product_fact_corpus, allow_short_overlap=True
        ),
        "skinTypes": _source_backed_values(_strings(value.get("skinTypes")), source_corpus, allow_short_overlap=True),
        "usageSteps": explicit_usage_procedure
        or _filter_values_by_evidence_role(source_backed_usage_steps, "usage"),
        "safetyTests": _source_backed_values(
            _strings(value.get("safetyTests")), source_corpus, allow_short_overlap=True
        ),
        "evidenceSentences": _source_backed_values(_strings(value.get("evidenceSentences")), source_corpus),
        "metricClaims": [
            accepted
            for item in as_list(value.get("metricClaims"))
            if (accepted := _source_backed_metric_claim(as_dict(item), source_corpus)) is not None
        ],
        "ingredientBenefitLinks": [
            accepted
            for item in as_list(value.get("ingredientBenefitLinks"))
            if (accepted := _source_backed_ingredient_benefit_link(as_dict(item), product_fact_corpus)) is not None
        ],
        "citations": [
            accepted
            for item in as_list(value.get("citations"))
            if (accepted := _source_backed_semantic_citation(as_dict(item), source_corpus)) is not None
        ],
    }
    # Flexible provider envelopes permit a partial semanticFacts patch.  A
    # vetted explicit role replaces its bootstrap role; an omitted role keeps
    # the bootstrap OCR fact instead of being materialized as an empty array.
    sanitized = sanitize_pdp_semantic_facts(
        {
            **bootstrap_semantic,
            **{key: candidate[key] for key in value if key in candidate},
        }
    )
    vetted_links: list[dict[str, Any]] = [as_dict(item) for item in as_list(candidate["ingredientBenefitLinks"])]
    link_outcomes = {
        _normalize_evidence(clean_text(part))
        for item in vetted_links
        for part in (item.get("benefit"), item.get("effect"))
        if clean_text(part)
    }
    bootstrap_outcomes = {
        _normalize_evidence(clean_text(item))
        for values in (
            as_list(bootstrap_product.get("benefits")),
            as_list(bootstrap_product.get("effects")),
            as_list(bootstrap_semantic.get("benefits")),
            as_list(bootstrap_semantic.get("effects")),
        )
        for item in values
        if clean_text(item)
    }
    def independently_finished(item: str) -> bool:
        key = _normalize_evidence(item)
        return key not in link_outcomes or key in bootstrap_outcomes

    sanitized["ingredients"] = _unique(
        [*_strings(sanitized.get("ingredients")), *[clean_text(item.get("ingredient")) for item in vetted_links]]
    )
    sanitized["benefits"] = _unique(
        [item for item in _strings(sanitized.get("benefits")) if independently_finished(item)]
    )
    sanitized["effects"] = _unique(
        [item for item in _strings(sanitized.get("effects")) if independently_finished(item)]
    )
    sanitized["ingredientBenefitLinks"] = _unique_records(
        [*[as_dict(item) for item in as_list(sanitized.get("ingredientBenefitLinks"))], *vetted_links],
        lambda item: _normalize_evidence(
            " ".join(clean_text(item.get(key)) for key in ("ingredient", "benefit", "effect", "sourceText", "sentence"))
        ),
    )
    return sanitized


def _strings(value: object) -> list[str]:
    return [clean_text(item) for item in as_list(value) if clean_text(item)]


def _source_backed_image_urls(value: object, source_corpus: str) -> list[str]:
    return _unique(
        url
        for raw in as_list(value)
        if (url := clean_text(raw)) and re.match(r"^https?://", url, re.I) and url in source_corpus
    )


def _source_backed_metric_claim(value: Mapping[str, Any], source_corpus: str) -> dict[str, Any] | None:
    sentence = clean_text(value.get("sentence"))
    source_text = clean_text(value.get("sourceText"))
    accepted_sentence = sentence if _source_backed(sentence, source_corpus) else ""
    accepted_source_text = source_text if _source_backed(source_text, source_corpus) else ""
    result: dict[str, Any] = {}
    for key in (
        "label",
        "subject",
        "value",
        "unit",
        "metric",
        "direction",
        "timing",
        "baseline",
        "comparator",
        "period",
        "sample",
        "method",
        "institution",
        "caveat",
    ):
        text = clean_text(value.get(key))
        if text and _source_backed(text, source_corpus, allow_short_overlap=True):
            result[key] = text
    evidence_group = clean_text(value.get("evidenceGroup"))
    if evidence_group:
        result["evidenceGroup"] = evidence_group
    image_urls = _source_backed_image_urls(value.get("imageUrls"), source_corpus)
    structured_layout_metric = bool(
        result.get("value")
        and result.get("metric")
        and (result.get("timing") or result.get("period") or result.get("sample") or result.get("method") or result.get("caveat"))
        and image_urls
    )
    if not accepted_sentence and not accepted_source_text and not structured_layout_metric:
        return None
    if accepted_sentence:
        result["sentence"] = accepted_sentence
    if accepted_source_text:
        result["sourceText"] = accepted_source_text
    if image_urls:
        result["imageUrls"] = image_urls
    return result


def _source_backed_ingredient_benefit_link(value: Mapping[str, Any], source_corpus: str) -> dict[str, Any] | None:
    sentence = clean_text(value.get("sentence"))
    source_text = clean_text(value.get("sourceText"))
    accepted_sentence = sentence if _source_backed(sentence, source_corpus) else ""
    accepted_source_text = source_text if _source_backed(source_text, source_corpus) else ""
    ingredient = clean_text(value.get("ingredient"))
    benefit = clean_text(value.get("benefit"))
    effect = clean_text(value.get("effect"))
    accepted_ingredient = ingredient if _source_backed(ingredient, source_corpus, allow_short_overlap=True) else ""
    accepted_benefit = benefit if _source_backed(benefit, source_corpus, allow_short_overlap=True) else ""
    accepted_effect = effect if _source_backed(effect, source_corpus, allow_short_overlap=True) else ""
    outcome = accepted_benefit or accepted_effect
    relation_evidence = _unique([accepted_source_text, accepted_sentence])
    if not accepted_ingredient or not outcome or not relation_evidence:
        return None
    if not any(
        _has_explicit_relationship_language(evidence)
        and _relation_evidence_contains_term(evidence, accepted_ingredient)
        and _relation_evidence_contains_term(evidence, outcome)
        for evidence in relation_evidence
    ):
        return None
    image_urls = _source_backed_image_urls(value.get("imageUrls"), source_corpus)
    return {
        "ingredient": accepted_ingredient,
        **({"benefit": accepted_benefit} if accepted_benefit else {}),
        **({"effect": accepted_effect} if accepted_effect else {}),
        **({"sentence": accepted_sentence} if accepted_sentence else {}),
        **({"sourceText": accepted_source_text} if accepted_source_text else {}),
        **({"imageUrls": image_urls} if image_urls else {}),
    }


def _has_explicit_relationship_language(value: str) -> bool:
    return bool(
        re.search(
            r"\b(?:helps?|supports?|improves?|contributes?\s+to|designed\s+for|formulated\s+for|for)\b|"
            r"(?:도와|돕|지원|개선|강화|기여|위한|바탕|기반)|(?:助け|支え|改善|寄与|ため|向け|もと)",
            value,
            re.I,
        )
    )


def _relation_evidence_contains_term(evidence: str, term: str) -> bool:
    normalized_evidence = _normalize_evidence(evidence)
    normalized_term = _normalize_evidence(term)
    return (
        normalized_term in normalized_evidence
        or normalized_evidence in normalized_term
        or _token_overlap_ratio(term, evidence) >= 0.6
    )


def _source_backed_semantic_citation(value: Mapping[str, Any], source_corpus: str) -> dict[str, Any] | None:
    source_text = clean_text(value.get("sourceText"))
    finding = clean_text(value.get("finding"))
    title = clean_text(value.get("title"))
    accepted_source_text = source_text if _source_backed(source_text, source_corpus) else ""
    accepted_finding = finding if _source_backed(finding, source_corpus, allow_short_overlap=True) else ""
    accepted_title = title if _source_backed(title, source_corpus, allow_short_overlap=True) else ""
    if not accepted_source_text or not (accepted_finding or accepted_title):
        return None
    result: dict[str, Any] = {
        **({"type": value["type"]} if value.get("type") in {"article", "research"} else {}),
        **({"title": accepted_title} if accepted_title else {}),
        "sourceText": accepted_source_text,
        **({"finding": accepted_finding} if accepted_finding else {}),
    }
    for key in ("publisher", "author", "publishedAt"):
        text = clean_text(value.get(key))
        if text and _source_backed(text, source_corpus, allow_short_overlap=True):
            result[key] = text
    raw_url = clean_text(value.get("url"))
    if raw_url and raw_url in source_corpus:
        result["url"] = raw_url
    return result


def _semantic_count(value: Mapping[str, Any]) -> int:
    return sum(
        len(as_list(value.get(field)))
        for field in (
            "ingredients",
            "benefits",
            "effects",
            "skinTypes",
            "usageSteps",
            "safetyTests",
            "metricClaims",
            "ingredientBenefitLinks",
            "citations",
        )
    )


def _semantic_input_count(value: Mapping[str, Any]) -> int:
    return sum(
        len(as_list(value.get(field)))
        for field in (
            "ingredients",
            "benefits",
            "effects",
            "skinTypes",
            "usageSteps",
            "safetyTests",
            "metricClaims",
            "evidenceSentences",
            "ingredientBenefitLinks",
            "citations",
        )
    )


def _rag_family(name: str) -> str:
    path = name.casefold().replace("\\", "/")
    if re.search(r"brands/[^/]+/brand-identity", path):
        return "brand-identity"
    if "analysis-prompt" in path:
        return "orchestration"
    if "geo-research" in path:
        return "geo"
    if re.search(r"(?:^|/)eeat", path):
        return "eeat"
    if re.search(r"(?:^|/)cep", path):
        return "cep"
    if "best-practice" in path:
        return "best-practice"
    if "schema-org" in path:
        return "schema"
    if "locale-expression" in path:
        return "locale-expression"
    if "locale-terminology" in path:
        return "terminology"
    if "official-ai-search" in path:
        return "official-docs"
    return f"custom:{path}"


def _is_brand_overlay(name: str) -> bool:
    return re.search(r"(?:^|/)brands/[^/]+/", name.casefold().replace("\\", "/")) is not None


def _integer(value: object, default: int) -> int:
    return int(value) if isinstance(value, int | float) and not isinstance(value, bool) else default


def _merge_usage(first: object, second: object) -> dict[str, int | float] | None:
    return merge_token_usage(first, second)


def _unique(values: Sequence[str] | Any) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for raw in values:
        value = clean_text(raw)
        if value and value.casefold() not in seen:
            seen.add(value.casefold())
            result.append(value)
    return result


def _unique_records(
    values: Sequence[dict[str, Any]], key: Callable[[dict[str, Any]], object]
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for value in values:
        identifier = str(key(value))
        if identifier not in seen:
            seen.add(identifier)
            result.append(value)
    return result


normalizePdpProductWithAgent = normalize_pdp_product_with_agent
selectProductNormalizationRagDocuments = select_product_normalization_rag_documents
productNormalizationRagPriority = product_normalization_rag_priority

__all__ = [
    "ModelBackedProductNormalizer",
    "PDP_PRODUCT_NORMALIZATION_JSON_SCHEMA",
    "normalize_pdp_product_with_agent",
    "normalizePdpProductWithAgent",
    "product_normalization_rag_priority",
    "productNormalizationRagPriority",
    "select_product_normalization_rag_documents",
    "selectProductNormalizationRagDocuments",
]
