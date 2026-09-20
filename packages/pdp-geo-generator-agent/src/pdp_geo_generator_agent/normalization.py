"""Deterministic intake normalization for arbitrary PDP-shaped JSON.

This is intentionally a data-boundary module: callers can hand it raw REST
payloads, the extractor's ``geoProduct`` envelope, or a manually assembled
product.  It keeps the source order of useful facts because that order becomes
the provenance order used by content planning and JSON-LD rendering.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime, timedelta
from typing import Any, Literal, cast
from urllib.parse import urljoin, urlparse

from ._json import as_dict, as_list, clean_text
from .contracts.image_source import is_publishable_image_url
from .contracts.metric_statement import measured_figure_claims
from .contracts.product_type import (
    localize_product_type_for_locale,
    name_product_type_supersedes_category,
    product_type_from_name,
)
from .contracts.publication import retain_publishable_description_sentences
from .contracts.sentence_form import source_phrase_matches, source_statement_matches
from .contracts.usage import extract_explicit_numbered_usage_steps
from .schema_values import (
    normalize_availability_token,
    normalize_item_condition_token,
    normalize_return_fees_token,
    normalize_return_method_token,
    normalize_return_policy_category_token,
    sanitize_country_code_value,
    sanitize_day_count_value,
    sanitize_gtin_value,
    sanitize_sku_value,
)

PdpGeoLocale = Literal["ko-KR", "ja-JP", "en-US", "en-GB"]

_FIELD_CANDIDATES: dict[str, tuple[str, ...]] = {
    "name": (
        "geoProduct.name",
        "product.name",
        "product.title",
        "product.productName",
        "name",
        "title",
        "productName",
        "onlineProdName",
        "item.name",
        "item.title",
    ),
    "description": (
        "geoProduct.description",
        "product.description",
        "product.body_html",
        "product.bodyHtml",
        "description",
        "body_html",
        "bodyHtml",
        "linePromoDesc",
        "detailDescription",
        "item.description",
        "summary",
    ),
    "brand": ("geoProduct.brand", "product.brand", "brand", "brand.name", "manufacturer.name", "maker", "vendor"),
    "category": (
        "geoProduct.category",
        "product.category",
        "category",
        "category.name",
        "productType",
        "product_type",
        "item.category",
    ),
    "price": (
        "geoProduct.price.raw",
        "geoProduct.price",
        "product.price",
        "price",
        "salePrice",
        "discountedPrice",
        "onlinePriceInfo.priceInfo.discountedPrice",
        "variants.0.price",
        "product.variants.0.price",
    ),
    "currency": (
        "geoProduct.price.currency",
        "currency",
        "priceCurrency",
        "product.currency",
        "offers.priceCurrency",
        "onlinePriceInfo.currencyInfo.currencyCode",
    ),
    "images": ("geoProduct.images", "product.images", "images", "image", "onlineImages", "media", "photos"),
    "options": ("geoProduct.options", "product.options", "options", "sizes"),
    "benefits": (
        "geoProduct.benefits",
        "benefits",
        "product.benefits",
        "categorizedProductInfo.benefits",
        "sections.BENEFITS",
        "sections.benefits",
    ),
    "effects": (
        "geoProduct.effects",
        "effects",
        "product.effects",
        "categorizedProductInfo.effects",
        "sections.EFFECTS",
        "sections.effects",
        "clinicalResults",
    ),
    "ingredients": (
        "geoProduct.ingredients",
        "ingredients",
        "keyIngredients",
        "ingredientHighlights",
        "categorizedProductInfo.ingredients",
        "sections.INGREDIENTS",
        "sections.ingredients",
    ),
    "usage": (
        "geoProduct.usage",
        "usage",
        "howToUse",
        "how_to_use",
        "directions",
        "categorizedProductInfo.usage",
        "sections.HOW TO USE",
        "sections.howToUse",
    ),
    "faq": ("geoProduct.faq", "faq", "faqs", "product.faq", "categorizedProductInfo.faq"),
    "reviews": (
        "geoProduct.reviews.items",
        "reviews.items",
        "reviewItems",
        "reviews",
        "customerReviewAnalysis.items",
        "reviewInfo.items",
    ),
    "rating": (
        "geoProduct.reviews.rating",
        "reviews.rating",
        "rating",
        "aggregateRating.ratingValue",
        "reviewInfo.reviewScope",
        "customerReviewAnalysis.rating",
    ),
    "reviewCount": (
        "geoProduct.reviews.reviewCount",
        "reviews.reviewCount",
        "reviewCount",
        "aggregateRating.reviewCount",
        "reviewInfo.reviewCount",
        "customerReviewAnalysis.reviewCount",
    ),
    "breadcrumbs": ("breadcrumbs", "breadcrumb", "breadcrumbList", "categoryPath"),
    "dateModified": (
        "geoProduct.dateModified",
        "product.dateModified",
        "product.updatedAt",
        "product.updated_at",
        "dateModified",
        "updatedAt",
        "updated_at",
        "modifiedAt",
        "lastModified",
    ),
}
_AVAILABILITY = {
    "backorder": "BackOrder",
    "back order": "BackOrder",
    "discontinued": "Discontinued",
    "instock": "InStock",
    "in stock": "InStock",
    "available": "InStock",
    "instoreonly": "InStoreOnly",
    "limitedavailability": "LimitedAvailability",
    "madetoorder": "MadeToOrder",
    "onlineonly": "OnlineOnly",
    "outofstock": "OutOfStock",
    "out of stock": "OutOfStock",
    "preorder": "PreOrder",
    "pre-order": "PreOrder",
    "presale": "PreSale",
    "reserved": "Reserved",
    "soldout": "SoldOut",
    "sold out": "SoldOut",
    "품절": "SoldOut",
    "판매중": "InStock",
    "재고있음": "InStock",
}
_CONDITIONS = {
    "new": "NewCondition",
    "newcondition": "NewCondition",
    "refurbished": "RefurbishedCondition",
    "used": "UsedCondition",
    "damaged": "DamagedCondition",
}
_METRIC = re.compile(
    r"(?:\b\d+(?:\.\d+)?\s?%|\b\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?\s?(?:ml|mL|oz|fl\.?\s?oz|weeks?|days?|hours?|stars?|drops?|pumps?|times?)\b|\b\d+(?:\.\d+)?\s?(?:점|개|명|회|주|일|시간|퍼센트)\b)",
    re.I,
)
_URL = re.compile(r"^https?://\S+$", re.I)
_COMMERCE = re.compile(
    r"(?:cart|checkout|coupon|point|shipping|delivery|exchange|return|refund|purchase|buy now|장바구니|구매하기|배송비|교환|반품|환불|레이어)",
    re.I,
)
# English review labels must be bounded.  The former bare ``rating`` branch
# classified ``hydrating`` as a review because it contains those six letters,
# which then prevented the trusted mapped-benefit recovery used by the source
# normalizer.
_REVIEW = re.compile(
    r"(?:\b(?:reviews?|reviewer|ratings?|customer\s+review|customer\s+(?:said|reported)|verified\s+buyer|stars?)\b|"
    r"리뷰|후기|평점|고객\s*리뷰|구매\s*후기|리뷰에서|후기에서|レビュー|評価)",
    re.I,
)


def normalize_pdp_product(
    input_: object,
    context: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Normalize raw source data into the legacy ``PdpProductSignal`` wire shape."""

    runtime = dict(context or {})
    source = _unwrap_product_payload(input_)
    hints = as_dict(runtime.get("hints"))
    mapping = as_dict(runtime.get("fieldMapping"))
    source_url = _text(runtime.get("sourceUrl"))
    evidence: list[dict[str, str]] = []
    reader = _MappedReader(source, mapping, evidence)

    name = (
        _first(
            reader.strings("name")
            + _text_candidates_by_key(source, re.compile(r"name|title|상품명|prodName|onlineProdName", re.I))
        )
        or "Untitled product"
    )
    description = _first(reader.strings("description")) or _first_long(
        _text_candidates_by_key_outside_review(source, re.compile(r"description|desc|summary|linePromo", re.I))
    )
    explicit_brand = _first(
        reader.strings("brand") + _text_candidates_by_key(source, re.compile(r"brand|vendor|maker|manufacturer", re.I))
    )
    brand = _text(hints.get("brand")) or _normalize_machine_prefixed_brand(explicit_brand, name, source, source_url)
    locale = _as_locale(_text(hints.get("locale"))) or _infer_locale(
        "\n".join([name, description or "", *_all_strings(source)[:120]])
    )
    market = _text(hints.get("market")) or _default_market(locale)
    category = _text(hints.get("category")) or _first(
        [
            candidate
            for candidate in reader.strings("category")
            + _text_candidates_by_key(
                source, re.compile(r"categoryName|categoryPath|taxonomy|productType|product_type", re.I)
            )
            if _is_category_signal(candidate)
        ]
    )
    raw_type = product_type_from_name(name)
    if category and raw_type and name_product_type_supersedes_category(category, raw_type):
        category = localize_product_type_for_locale(raw_type, locale)
    elif not category:
        category = localize_product_type_for_locale(raw_type, locale) if raw_type else None
    if description:
        description = retain_publishable_description_sentences(description, locale) or None

    ocr_insights = _ocr_sentence_insights(source)
    normalization_warnings: list[str] = []
    semantic = _normalize_semantic_facts_from_source(source, ocr_insights, name, normalization_warnings)
    relation_ingredients = _semantic_relation_values(semantic["ingredientBenefitLinks"], "ingredient")
    ocr_confidence_by_image_url = _ocr_image_confidence_by_url(source)
    benefit_backing_sources = _explicit_benefit_backing_sources(source, ocr_insights, semantic, reader)
    source_texts, source_text_meta = _unique_source_text_entries(
        [
            *[
                (item["text"], _ocr_source_text_meta(item, ocr_confidence_by_image_url))
                for item in ocr_insights
                if _useful_source_text(item["text"])
            ],
            *[(value, None) for value in _string_list(_get_path(source, "sourceTexts"))],
            *[(value, None) for value in _string_list(_get_path(source, "geoProduct.sourceTexts"))],
            *[(value, None) for value in _metafield_texts(source)],
            *[(value, None) for value in _string_list(_get_path(source, "sourceExtraction.ocr.textBlocks"))],
            *[(value, None) for value in _string_list(_get_path(source, "geoProduct.sourceExtraction.ocr.textBlocks"))],
            *[(value, None) for value in _all_strings(source) if _useful_source_text(value)][:80],
            *[(value, None) for value in reader.strings("description")],
            *[(value, None) for value in reader.strings("benefits")],
            *[(value, None) for value in reader.strings("effects")],
            *[(value, None) for value in reader.strings("ingredients")],
            *[(value, None) for value in reader.strings("usage")],
        ]
    )

    # Keep explicit product fields and inferred source sections on the same
    # role-aware admission path.  A coarse concatenation let dimensions,
    # commerce values, and whole page paragraphs become public benefits or
    # ingredients; the retained normalizer first splits source units then
    # applies the field's evidence-role gate.
    benefits = _unique(
        [
            *_source_grounded_declarative_benefits(reader.strings("benefits"), benefit_backing_sources),
            *_select_role_signals(
                semantic["benefits"],
                reader.strings("benefits"),
                _section_texts(
                    source,
                    re.compile(
                        r"benefit|장점|효능|고민|보습|수분|탄력|진정|광채|hydration|moisture|firm|barrier|bright|保湿|うるおい|ハリ|バリア",
                        re.I,
                    ),
                ),
                "benefit",
            ),
        ]
    )
    effects = _unique(
        [
            *_select_role_signals(
                semantic["effects"],
                reader.strings("effects"),
                _section_texts(
                    source,
                    re.compile(r"effect|clinical|result|개선|효과|주름|피부결|firmness|wrinkle|elasticity|結果|効果|キメ", re.I),
                ),
                "effect",
            ),
        ]
    )
    ingredients = _unique(
        [
            # Structured source relations are already ordered OCR assertions;
            # keep their named ingredients in that order before generic role
            # inference, which otherwise pulls familiar vocabulary ahead of
            # an earlier arbitrary ingredient.
            *relation_ingredients,
            *_select_role_signals(
                semantic["ingredients"],
                reader.strings("ingredients"),
                _section_texts(
                    source,
                    re.compile(
                        r"ingredient|성분|원료|전성분|ginseng|retinol|peptide|niacinamide|ceramide|hyaluronic|成分|原料",
                        re.I,
                    ),
                ),
                "ingredient",
            ),
        ]
    )
    usage_candidates = _unique(
        [
            *semantic["usageSteps"],
            *reader.strings("usage"),
            *_section_texts(
                source,
                re.compile(
                    r"usage|how to use|direction|사용|도포|아침|저녁|apply|morning|night|使い方|使用方法", re.I
                ),
            ),
        ]
    )
    explicit_usage_procedure = extract_explicit_numbered_usage_steps(usage_candidates)
    usage = dedupe_pdp_usage_instructions(explicit_usage_procedure or usage_candidates)
    faq = _unique_faq(
        [
            *reader.faq(),
            *_faq_from_unknown(_get_path(source, "geoProduct.faq")),
            *_faq_from_unknown(_get_path(source, "faq")),
            *_faq_from_loose_texts(source),
        ]
    )[:16]
    reviews = _normalize_reviews(source, reader)
    variants = _parse_variants(source, source_url)
    images = _unique(
        [
            _absolute_url(value, source_url)
            for raw in reader.strings("images")
            for value in _split_potential_list(raw)
            if is_publishable_image_url(_absolute_url(value, source_url))
        ]
    )[:80]
    options = _unique(
        [
            *reader.strings("options"),
            *[
                value
                for variant in variants
                for value in ([variant.get("title")] if variant.get("title") else []) + variant["options"]
            ],
        ]
    )[:16]
    price_raw = _first(reader.strings("price") + [str(v["price"]) for v in variants if v.get("price")])
    currency = _first(reader.strings("currency"))
    metrics = _unique(
        [
            *_metric_claim_texts(semantic["metricClaims"]),
            *[text for text in source_texts if _is_atomic_metric_evidence(text)],
        ]
    )[:20]
    breadcrumbs = _normalize_breadcrumbs(
        reader.values("breadcrumbs"), {"brand": brand, "category": category, "name": name, "url": source_url}
    )
    commerce = _extract_commerce_identity(source)
    trust = _extract_commerce_trust(source)
    date_modified = _extract_date_modified(source, reader.strings("dateModified"))
    price = None
    if price_raw:
        amount = _price_amount(price_raw)
        price = {
            "raw": price_raw,
            **({"amount": amount} if amount is not None else {}),
            **({"currency": currency} if currency else {}),
        }
    product: dict[str, Any] = {
        "name": name,
        "originalName": name,
        **({"description": description} if description else {}),
        **({"brand": brand} if brand else {}),
        **({"category": category} if category else {}),
        **commerce,
        **trust,
        **({"dateModified": date_modified} if date_modified else {}),
        **({"variants": variants} if variants else {}),
        **({"price": price} if price else {}),
        "images": images,
        "options": options,
        "benefits": benefits,
        "effects": effects,
        "ingredients": ingredients,
        "usage": usage,
        "metrics": metrics,
        "faq": faq,
        "reviews": reviews,
        "breadcrumbs": breadcrumbs,
        "sourceTexts": source_texts,
        # The TypeScript normalizer always exposes this stable object, even
        # when no OCR/source annotations were found.  Its position is part of
        # the diagnostics wire order and downstream model prompts rely on the
        # empty-map distinction from an omitted property.
        "sourceTextMeta": source_text_meta,
        "semanticFacts": semantic,
    }
    evidence.append({"field": "product.name", "source": "input", "value": name})
    if description:
        evidence.append({"field": "product.description", "source": "input", "value": description})
    if commerce.get("sku"):
        evidence.append({"field": "product.sku", "source": "input", "value": str(commerce["sku"])})
    if commerce.get("gtin"):
        evidence.append({"field": "product.gtin", "source": "input", "value": str(commerce["gtin"])})
    if reviews["keywords"]:
        evidence.append({"field": "reviews.keywords", "source": "input", "value": ", ".join(reviews["keywords"][:8])})
    evidence.extend(
        {
            "field": "product.semanticFacts.ingredientBenefitLinks",
            "source": "normalizer",
            "value": warning,
        }
        for warning in _unique(normalization_warnings)
    )
    return {
        "product": product,
        "locale": locale,
        "market": market,
        "evidence": evidence,
        "ocrSentences": _ocr_sentence_diagnostics(ocr_insights, locale),
    }


class _MappedReader:
    def __init__(self, source: object, mapping: Mapping[str, Any], evidence: list[dict[str, str]]) -> None:
        self.source = source
        self.mapping = mapping
        self.evidence = evidence

    def _paths(self, field: str) -> list[str]:
        configured = self.mapping.get(field)
        custom = (
            [configured]
            if isinstance(configured, str)
            else [item for item in as_list(configured) if isinstance(item, str)]
        )
        return [*custom, *_FIELD_CANDIDATES.get(field, ())]

    def values(self, field: str) -> list[object]:
        result: list[object] = []
        custom = self.mapping.get(field)
        custom_paths = (
            [custom] if isinstance(custom, str) else [item for item in as_list(custom) if isinstance(item, str)]
        )
        for path in self._paths(field):
            value = _get_path(self.source, path)
            if value is not _MISSING:
                result.append(value)
                if path in custom_paths:
                    self.evidence.append({"field": field, "source": "fieldMapping", "value": path})
        return result

    def strings(self, field: str) -> list[str]:
        return _unique(
            [_clean(value) for raw in self.values(field) for value in _flatten_text_values(raw) if _clean(value)]
        )

    def faq(self) -> list[dict[str, str]]:
        return [item for raw in self.values("faq") for item in _faq_from_unknown(raw)]


_MISSING = object()


def _unwrap_product_payload(value: object) -> object:
    record = as_dict(value)
    # Extractor returns an artifact envelope and deliberately publishes
    # ``geoProduct``.  Prefer it over surrounding fetch diagnostics.
    result = as_dict(record.get("result"))
    if isinstance(result.get("geoProduct"), Mapping):
        return result["geoProduct"]
    if isinstance(record.get("geoProduct"), Mapping):
        return record["geoProduct"]
    product = as_dict(record.get("product"))
    if product:
        return {**record, **product}
    if isinstance(result.get("product"), Mapping):
        return {**result, **as_dict(result.get("product"))}
    return value


_OCR_INTENTS = ("ingredient", "benefit", "effect", "usage", "review", "metric")
_SEMANTIC_STRING_FIELDS = (
    "ingredients",
    "benefits",
    "effects",
    "skinTypes",
    "usageSteps",
    "safetyTests",
    "evidenceSentences",
)
_SEMANTIC_RECORD_FIELDS = ("metricClaims", "ingredientBenefitLinks", "citations")


def _normalize_semantic_facts_from_source(
    source: object,
    insights: Sequence[Mapping[str, Any]],
    product_name: str,
    normalization_warnings: list[str] | None = None,
) -> dict[str, Any]:
    """Merge OCR facts at the same intake boundary as the TS normalizer.

    The extractor deliberately keeps its fully structured OCR analysis below
    ``sourceExtraction.ocr``.  Flattening only OCR text blocks turns a
    measured claim or ingredient relationship back into unrelated tokens, so
    OCR-origin records pass the stricter source-backed gate before joining
    ordinary product semantic facts.
    """

    source_facts: list[tuple[object, bool]] = [
        (_get_path(source, "semanticFacts"), False),
        (_get_path(source, "geoProduct.semanticFacts"), False),
        (_get_path(source, "sourceExtraction.ocr.semanticFacts"), True),
        (_get_path(source, "geoProduct.sourceExtraction.ocr.semanticFacts"), True),
        (_get_path(source, "ocr.semanticFacts"), True),
        (_get_path(source, "geoProduct.ocr.semanticFacts"), True),
        (_get_path(source, "aiAnalysis.semanticFacts"), True),
        (_get_path(source, "geoProduct.aiAnalysis.semanticFacts"), True),
    ]
    source_facts.extend(
        (value, True)
        for insight in insights
        for value in (_semantic_facts_from_ocr_insight(insight), insight.get("semanticFacts"))
    )

    warnings = normalization_warnings if normalization_warnings is not None else []
    merged: dict[str, list[Any]] = {field: [] for field in (*_SEMANTIC_STRING_FIELDS, *_SEMANTIC_RECORD_FIELDS)}
    for value, is_ocr in source_facts:
        facts = (
            _sanitize_ocr_semantic_facts(value, product_name, warnings)
            if is_ocr
            else sanitize_pdp_semantic_facts(value)
        )
        for field in _SEMANTIC_STRING_FIELDS:
            merged[field].extend(_string_list(facts.get(field)))
        for field in _SEMANTIC_RECORD_FIELDS:
            merged[field].extend(_record_list(facts.get(field)))

    merged_usage_steps = dedupe_pdp_usage_instructions(_unique(merged["usageSteps"]))
    explicit_usage_procedure = extract_explicit_numbered_usage_steps(merged_usage_steps)
    result: dict[str, Any] = {
        "ingredients": _unique(merged["ingredients"]),
        "benefits": _unique(merged["benefits"]),
        "effects": _unique(merged["effects"]),
        "skinTypes": _unique(merged["skinTypes"]),
        "usageSteps": explicit_usage_procedure or merged_usage_steps,
        "safetyTests": _unique(merged["safetyTests"]),
        "evidenceSentences": _unique(merged["evidenceSentences"]),
        "metricClaims": _unique_semantic_records(merged["metricClaims"], "metric"),
        "ingredientBenefitLinks": _unique_semantic_records(merged["ingredientBenefitLinks"], "relation"),
        "citations": _unique_semantic_records(merged["citations"]),
    }
    return sanitize_pdp_semantic_facts(result)


def _semantic_relation_values(records: Sequence[Mapping[str, Any]], field: str) -> list[str]:
    return _unique([_clean(record.get(field)) for record in records if _clean(record.get(field))])


def _semantic_facts_from_ocr_insight(insight: Mapping[str, Any]) -> dict[str, Any]:
    text = _clean(insight.get("text"))
    # A sentence may receive several inferred diagnostic intents.  Only its
    # extractor-declared category is a fact projection; otherwise a formula
    # sentence would be copied into ingredients, benefits, and effects as
    # three separate public facts.
    category = _clean(insight.get("declaredCategory")).casefold()
    image_urls = _string_list(insight.get("imageUrls"))
    keywords = _string_list(insight.get("keywords"))[:10]
    ingredients = keywords if category == "ingredient" else []
    if category == "ingredient" and not ingredients and (_is_named_biochemical_or_formula(text) or _is_full_ingredient_list(text)):
        ingredients = [text]
    return {
        "ingredients": ingredients,
        "benefits": [text] if category == "benefit" else [],
        "effects": [text] if category == "effect" else [],
        "skinTypes": [],
        "usageSteps": [text] if category == "usage" else [],
        "safetyTests": [text] if "safety" in infer_pdp_evidence_roles(text).get("roles", []) else [],
        "metricClaims": [
            {"sentence": text, "sourceText": text, "imageUrls": image_urls}
        ]
        if category == "metric"
        else [],
        "evidenceSentences": [text] if text else [],
        # A sentence insight may identify ingredients and effects separately,
        # but only the extractor's structured relation record can assert a
        # causal ingredient-to-outcome connection.
        "ingredientBenefitLinks": [],
        "citations": [],
    }


def _sanitize_ocr_semantic_facts(
    value: object, product_name: str, normalization_warnings: list[str] | None = None
) -> dict[str, Any]:
    """Accept only OCR facts that remain explicit, qualified source evidence."""

    record = as_dict(value)
    raw_usage_steps = _string_list(record.get("usageSteps"))
    normalized_usage_steps = _normalize_ocr_usage_steps(raw_usage_steps)
    explicit_usage_procedure = extract_explicit_numbered_usage_steps(normalized_usage_steps)
    relation_records = [as_dict(item) for item in as_list(record.get("ingredientBenefitLinks"))]
    outcome_evidence = _unique(
        [
            *_string_list(record.get("evidenceSentences")),
            *[
                _clean(item.get("sourceText")) or _clean(item.get("sentence"))
                for item in relation_records
            ],
        ]
    )
    warnings = normalization_warnings if normalization_warnings is not None else []
    accepted_links: list[dict[str, Any]] = []
    for item in relation_records:
        accepted = _normalize_ocr_ingredient_benefit_link(item, product_name)
        if accepted is not None:
            accepted_links.append(accepted)
            rejected_outcomes = [
                _clean(item.get(field))
                for field in ("benefit", "effect")
                if _clean(item.get(field)) and field not in accepted
            ]
            if rejected_outcomes:
                warnings.append(
                    _ocr_ingredient_benefit_link_rejection_warning(item, product_name, rejected_outcomes)
                )
        elif _is_explicit_ocr_ingredient_benefit_link(item):
            warnings.append(_ocr_ingredient_benefit_link_rejection_warning(item, product_name))

    relation_sources = {
        _normalize_ocr_evidence_entity(_clean(item.get("sourceText")) or _clean(item.get("sentence")))
        for item in relation_records
        if _is_explicit_ocr_ingredient_benefit_link(item)
    }
    rejected_product_subject_ingredients = {
        _normalize_ocr_evidence_entity(_clean(item.get("ingredient")))
        for item in relation_records
        if _is_product_relation_subject(_clean(item.get("ingredient")), product_name)
    }
    rejected_negative_outcomes = {
        _normalize_ocr_evidence_entity(_clean(item.get("benefit")) or _clean(item.get("effect")))
        for item in relation_records
        if _has_negative_or_adverse_relation_polarity(_clean(item.get("sourceText")) or _clean(item.get("sentence")))
    }
    accepted_outcomes = {
        _normalize_ocr_evidence_entity(_clean(item.get("benefit")) or _clean(item.get("effect")))
        for item in accepted_links
    }
    blocked_negative_outcomes = rejected_negative_outcomes - accepted_outcomes
    independent_outcome_evidence = [
        source
        for source in _string_list(record.get("evidenceSentences"))
        if _normalize_ocr_evidence_entity(source) not in relation_sources
    ]

    def is_relation_source_projection(item: str) -> bool:
        return _normalize_ocr_evidence_entity(item) in relation_sources

    def is_product_subject_projection(item: str) -> bool:
        return _normalize_ocr_evidence_entity(item) in rejected_product_subject_ingredients

    def is_blocked_negative_outcome(item: str) -> bool:
        outcome_key = _normalize_ocr_evidence_entity(item)
        if outcome_key not in blocked_negative_outcomes:
            return False
        # A rejected negative/adverse relation cannot seed a positive atom.
        # Preserve the atom only when another source sentence independently
        # predicates the same outcome for the finished product.
        return not any(
            outcome_key in _normalize_ocr_evidence_entity(source)
            and _source_declares_ocr_outcome(source, item)
            for source in independent_outcome_evidence
        )

    return {
        "ingredients": _unique([
            item
            for item in _string_list(record.get("ingredients"))
            if _useful_source_text(item)
            and not _is_question_like_source_text(item)
            and not _is_commerce_quantity_or_offer_text(item)
            and not _is_safety_or_suitability_caution(item)
            and not is_relation_source_projection(item)
            and not is_product_subject_projection(item)
        ] + [
            _clean(item.get("ingredient"))
            for item in accepted_links
            if _clean(item.get("ingredient"))
        ]),
        "benefits": _unique([
            item
            for item in _string_list(record.get("benefits"))
            if _is_product_scoped_ocr_outcome(item, product_name, outcome_evidence)
            and not is_relation_source_projection(item)
            and not is_blocked_negative_outcome(item)
        ]),
        "effects": _unique([
            item
            for item in _string_list(record.get("effects"))
            if _is_product_scoped_ocr_outcome(item, product_name, outcome_evidence)
            and not is_relation_source_projection(item)
            and not is_blocked_negative_outcome(item)
        ]),
        "skinTypes": _unique([
            item
            for item in _string_list(record.get("skinTypes"))
            if _is_audience_evidence(item)
        ]),
        "usageSteps": explicit_usage_procedure or normalized_usage_steps,
        "safetyTests": _unique([
            item for item in _string_list(record.get("safetyTests")) if _is_safety_or_suitability_caution(item)
        ]),
        "metricClaims": [
            accepted
            for item in as_list(record.get("metricClaims"))
            for accepted in _normalize_ocr_metric_claims(as_dict(item))
        ],
        "evidenceSentences": _unique([
            item
            for item in _string_list(record.get("evidenceSentences"))
            if _useful_source_text(item) and not _is_question_like_source_text(item)
        ]),
        "ingredientBenefitLinks": accepted_links,
        "citations": _record_list(record.get("citations")),
    }


def _normalize_ocr_usage_steps(values: Sequence[str]) -> list[str]:
    """Preserve a complete numbered OCR procedure before generic verb filtering.

    A numbered source procedure has already supplied its own boundaries and
    order.  It still passes the shared safety/page-dump guard, but it must not
    lose a legitimate step merely because an uncommon application verb is not
    present in a broad, locale-neutral action vocabulary.
    """

    if explicit := extract_explicit_numbered_usage_steps(values):
        return dedupe_pdp_usage_instructions(explicit)
    return dedupe_pdp_usage_instructions(
        [
            item
            for item in values
            if not _is_question_like_source_text(item) and _is_usage_instruction_evidence(item)
        ]
    )


def _is_product_scoped_ocr_outcome(
    value: str,
    _product_name: str,
    evidence_sentences: Sequence[str] = (),
) -> bool:
    text = _clean_source_signal_text(value)
    if (
        not text
        or _is_question_like_source_text(text)
        or _is_commerce_quantity_or_offer_text(text)
        or _is_safety_or_suitability_caution(text)
        or _is_customer_experience_evidence(text)
        or _is_usage_instruction_evidence(text)
        or _is_metric_evidence_text(text)
    ):
        return False
    if _has_direct_source_benefit_predicate(text) or _is_benefit_evidence_role(text) or _is_effect_signal(text):
        return True
    outcome_key = _normalize_ocr_evidence_entity(text)
    return any(
        outcome_key in _normalize_ocr_evidence_entity(source)
        and _source_declares_ocr_outcome(source, text)
        for source in evidence_sentences
    )


def _normalize_ocr_evidence_entity(value: str) -> str:
    normalized = re.sub(r"[^\w가-힣]+", " ", _clean(value).casefold())
    # Korean particles often attach directly to a Latin INCI/proprietary
    # name (for example, ``Panthenol은``).  Split that script boundary so
    # exact source-term matching still treats the named ingredient as the
    # grammatical subject rather than a partial substring.
    return re.sub(r"(?<=[a-z0-9])(?=[가-힣])|(?<=[가-힣])(?=[a-z0-9])", " ", normalized).strip()


def _normalize_ocr_metric_claims(value: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Return every claim one filed record states -- a panel states several.

    A classifier can file a whole results panel as one record because OCR gave
    it one line.  One record then carries several figures under one sample and
    one period, which is not a claim any renderer may publish: it would state
    one figure and silently borrow the panel's conditions for the rest.  Read
    back as the rows the page printed, each figure keeps the words printed
    against it and the conditions the panel states for all of them.

    A record that already carries its own measurement is left exactly as filed.
    """

    text = _clean(value.get("sourceText")) or _clean(value.get("sentence"))
    already_measured = bool(_clean(value.get("value")) and _clean(value.get("unit")))
    if text and not already_measured and is_compressed_multi_claim_metric_block(text):
        rows = measured_figure_claims(text)
        if rows:
            expanded = [_normalize_ocr_metric_claim({**dict(value), **row}) for row in rows]
            if any(row is not None for row in expanded):
                return [row for row in expanded if row is not None]
    accepted = _normalize_ocr_metric_claim(value)
    return [accepted] if accepted is not None else []


def _normalize_ocr_metric_claim(value: Mapping[str, Any]) -> dict[str, Any] | None:
    fields = (
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
        "evidenceGroup",
        "caveat",
        "sentence",
        "sourceText",
    )
    claim: dict[str, Any] = {field: _clean(value.get(field)) for field in fields if _clean(value.get(field))}
    image_urls = _ocr_image_urls(value)
    if image_urls:
        claim["imageUrls"] = image_urls

    outcome = next((claim[field] for field in ("metric", "label", "subject") if claim.get(field)), "")
    measured = _join_ocr_metric_value(claim.get("value", ""), claim.get("unit", ""))
    context = " ".join(
        claim[field]
        for field in ("sample", "period", "timing", "baseline", "comparator", "method", "institution", "caveat")
        if claim.get(field)
    )
    direct = claim.get("sourceText") or claim.get("sentence") or ""
    structured = bool(
        outcome
        and measured
        and context
        and _has_ocr_measured_magnitude(measured)
        and not _is_commerce_quantity_or_offer_text(measured)
    )
    if not structured and not _is_atomic_metric_evidence(direct):
        return None
    return claim


def _join_ocr_metric_value(value: str, unit: str) -> str:
    if not value:
        return unit
    if not unit or value.endswith(unit):
        return value
    return f"{value}{unit}"


def _has_ocr_measured_magnitude(value: str) -> bool:
    return bool(
        re.search(
            r"\d[\d,]*(?:\.\d+)?\s*(?:%|％|배|ppm|ppb|mg|㎎|ml|mL|g|oz|weeks?|days?|hours?|minutes?|months?|years?|주|일|시간|분|개월|년|명|점)",
            value,
            re.I,
        )
    )


def _normalize_ocr_ingredient_benefit_link(value: Mapping[str, Any], product_name: str) -> dict[str, Any] | None:
    ingredient = _clean(value.get("ingredient"))
    benefit = _clean(value.get("benefit"))
    effect = _clean(value.get("effect"))
    source = _clean(value.get("sourceText")) or _clean(value.get("sentence"))
    if (
        not source
        or not ingredient
        or not (benefit or effect)
        or _is_product_relation_subject(ingredient, product_name)
        or _has_negative_or_adverse_relation_polarity(source)
    ):
        return None
    accepted_outcomes = {
        field: outcome
        for field, outcome in (("benefit", benefit), ("effect", effect))
        if outcome and _has_explicit_ocr_ingredient_relation(source, ingredient, outcome)
    }
    if not accepted_outcomes and _source_predicates_an_outcome_of(source, ingredient):
        # No slot is spelled the way the page spelled it, and the page still
        # states an outcome of this ingredient: the slots are the extractor's
        # index for that relation.  This applies only when no slot matched --
        # where one did, the page's own wording decides, and a slot it never
        # stated stays out.
        accepted_outcomes = {
            field: outcome for field, outcome in (("benefit", benefit), ("effect", effect)) if outcome
        }
    if not accepted_outcomes:
        return None
    link: dict[str, Any] = {
        key: item
        for key, item in {
            "ingredient": ingredient,
            **accepted_outcomes,
            "sentence": _clean(value.get("sentence")),
            "sourceText": _clean(value.get("sourceText")),
        }.items()
        if item
    }
    image_urls = _ocr_image_urls(value)
    if image_urls:
        link["imageUrls"] = image_urls
    return link


def _is_explicit_ocr_ingredient_benefit_link(value: Mapping[str, Any]) -> bool:
    ingredient = _clean(value.get("ingredient"))
    outcome = _clean(value.get("benefit")) or _clean(value.get("effect"))
    source = _clean(value.get("sourceText")) or _clean(value.get("sentence"))
    return bool(ingredient and outcome and source)


def _ocr_ingredient_benefit_link_rejection_warning(
    value: Mapping[str, Any], product_name: str, rejected_outcomes: Sequence[str] = ()
) -> str:
    ingredient = _clean(value.get("ingredient"))
    outcome = " / ".join(rejected_outcomes) or _clean(value.get("benefit")) or _clean(value.get("effect"))
    source = _clean(value.get("sourceText")) or _clean(value.get("sentence"))
    if _is_product_relation_subject(ingredient, product_name):
        reason = "the asserted subject is a finished product, not an ingredient or formula"
    elif _has_negative_or_adverse_relation_polarity(source):
        reason = "the source negates the outcome or describes an adverse effect"
    else:
        reason = "the source did not establish a direct affirmative relation"
    return (
        f"Rejected explicit OCR ingredient-to-outcome relation because {reason}: "
        f"{ingredient} -> {outcome} ({source})"
    )


def _is_product_relation_subject(subject: str, product_name: str) -> bool:
    """Keep a finished product subject out of ingredient/formula slots."""

    normalized = _normalize_ocr_evidence_entity(subject)
    if not normalized:
        return True
    normalized_name = _normalize_ocr_evidence_entity(product_name)
    without_article = re.sub(r"^(?:an?|the|this|that|these|those|our|your)\s+", "", normalized)
    if normalized_name and without_article == normalized_name:
        return True
    if re.match(r"^(?:an?|the|this|that|these|those|our|your)\b", normalized, re.I):
        return True
    return bool(
        re.search(
            r"(?:^|\s)(?:product|item|serum|cream|lotion|essence|toner|shampoo|conditioner|cleanser|wash|mask|oil|"
            r"mist|gel|balm|foam|primer|foundation|concealer|sunscreen|sunblock|spray|styler|treatment|"
            r"moisturizer|makeup|soap|제품|상품|세럼|크림|로션|에센스|토너|샴푸|컨디셔너|클렌저|"
            r"워시|마스크|오일|미스트|젤|밤|폼|프라이머|파운데이션|선크림|스프레이|트리트먼트)$",
            normalized,
            re.I,
        )
    )


def _has_negative_or_adverse_relation_polarity(value: str) -> bool:
    """Reject a source clause that negates efficacy or states an adverse effect."""

    text = _clean_source_signal_text(value)
    return bool(
        re.search(
            r"\b(?:does?\s+not|did\s+not|is\s+not|are\s+not|was\s+not|were\s+not|"
            r"do(?:es)?n['’]?t|didn['’]?t|cannot|can['’]?t|never|lacks?|lacking|fails?(?:ed)?\s+to|"
            r"without\s+(?:any\s+)?(?:support|benefit|improvement|hydration))\b|"
            r"\b(?:causes?|triggers?|induces?|worsens?|irritates?|damages?|harms?|aggravates?|sensitizes?)\b|"
            r"(?:"
            r"(?:도움|지원|개선|향상|효과|효능).{0,12}(?:주지|되지|하지|않)|"
            r"(?:효과|효능|보습|수분).{0,12}부족(?:합니다|하다|해요|함)|"
            r"(?:효과|효능).{0,12}없(?:습니다|어요|다)|"
            r"(?:자극|손상|트러블|붉은기|알레르기).{0,12}(?:유발|악화|초래|일으키)|"
            r"악화(?:하지|시키지).{0,8}않"
            r")",
            text,
            re.I,
        )
    )


def _has_explicit_ocr_ingredient_relation(source: str, ingredient: str, outcome: str) -> bool:
    """Require a single source clause to state the ingredient-outcome relation."""

    if _has_negative_or_adverse_relation_polarity(source):
        return False
    source_clauses = [item for item in re.split(r"(?<=[.!?。！？])\s*", _clean_source_signal_text(source)) if item]
    return any(
        _is_safe_ocr_relation_clause(clause)
        and _clause_explicitly_relates_ingredient_to_outcome(clause, ingredient, outcome)
        for clause in source_clauses
    )


def _source_predicates_an_outcome_of(source: str, ingredient: str) -> bool:
    """Read the source's own ingredient-to-outcome relation, clause by clause.

    This passes the same clause gates an outcome match does -- polarity,
    commerce and usage copy, safety context -- because what changes when the
    filed outcome is the extractor's index is only which words prove the
    relation, never which source text is allowed to prove one.
    """

    if _has_negative_or_adverse_relation_polarity(source):
        return False
    clauses = re.split(r"(?<=[.!?。！？])\s*", _clean_source_signal_text(source))
    return any(
        _is_safe_ocr_relation_clause(clause)
        and not _is_usage_instruction_evidence(clause)
        and clause_predicates_an_outcome_of(clause, ingredient)
        for clause in clauses
        if clause
    )


def _source_declares_ocr_outcome(source: str, outcome: str) -> bool:
    """Accept an OCR outcome only when its own source clause predicates it."""

    if _has_negative_or_adverse_relation_polarity(source):
        return False
    return any(
        _is_safe_ocr_relation_clause(clause)
        and not _is_usage_instruction_evidence(clause)
        and _clause_explicitly_declares_outcome(clause, outcome)
        for clause in re.split(r"(?<=[.!?。！？])\s*", _clean_source_signal_text(source))
        if clause
    )


def _is_safe_ocr_relation_clause(value: str) -> bool:
    return not (
        _is_question_like_source_text(value)
        or _is_commerce_quantity_or_offer_text(value)
        or _is_safety_or_suitability_caution(value)
        or _is_customer_experience_evidence(value)
        or _is_metric_evidence_text(value)
    )


def _clause_explicitly_relates_ingredient_to_outcome(clause: str, ingredient: str, outcome: str) -> bool:
    normalized = _normalize_ocr_evidence_entity(clause)
    ingredient_key = _normalize_ocr_evidence_entity(ingredient)
    outcome_key = _normalize_ocr_evidence_entity(outcome)
    if not normalized or not ingredient_key or not outcome_key:
        return False

    for ingredient_match in _normalized_phrase_matches(normalized, ingredient_key):
        for outcome_match in _normalized_outcome_matches(normalized, outcome_key):
            if ingredient_match.end() > outcome_match.start():
                continue
            prefix = normalized[: ingredient_match.start()].strip()
            bridge = normalized[ingredient_match.end() : outcome_match.start()].strip()
            if _has_english_ingredient_subject_relation(prefix, bridge):
                return True
            if _has_korean_ingredient_subject_relation(
                bridge, normalized[outcome_match.end() :].strip(), subject_is_clause_initial=not prefix
            ):
                return True
    return False


def clause_predicates_an_outcome_of(clause: str, ingredient: str) -> bool:
    """Return whether the clause stands this ingredient as its subject and predicates an outcome.

    The filed outcome is the extractor's index for a relation, not the words
    the page used: a sentence that says "피부 장벽을 개선합니다" can be filed
    under "피부장벽 관리", and reading the index's spelling then makes the page's
    own relation look absent.  What reaches a reader is the source sentence
    itself -- the renderer publishes it and nothing else -- so the relation is
    read where it is stated: the ingredient standing as the clause's subject,
    and a predicate that states an outcome rather than the ingredient's mere
    presence.  An ingredient that is only the head of a modifier phrase is not
    a subject, so nothing is predicated of it here.

    Each language decides this by its own grammar, and both are read the same
    way -- the index is no more the source's wording in English than in Korean.
    """

    normalized = _normalize_ocr_evidence_entity(clause)
    ingredient_key = _normalize_ocr_evidence_entity(ingredient)
    if not normalized or not ingredient_key:
        return False
    korean = bool(re.search(r"[가-힣]", normalized))
    for match in _normalized_phrase_matches(normalized, ingredient_key):
        prefix = normalized[: match.start()].strip()
        suffix = normalized[match.end() :].strip()
        if not suffix:
            continue
        if korean:
            if not prefix and _has_korean_ingredient_subject_relation(
                "", suffix, subject_is_clause_initial=True
            ):
                return True
            continue
        if _has_english_ingredient_subject_relation(prefix, suffix):
            return True
    return False


korean_clause_predicates_an_outcome_of = clause_predicates_an_outcome_of


def _normalized_outcome_matches(value: str, outcome: str) -> list[re.Match[str]]:
    """Find an outcome the clause states, across the markers Korean attaches.

    A label names an outcome as a noun phrase ("피부 장벽 개선"); a clause states
    it as grammar ("피부 장벽을 개선합니다").  The words are the same and in the
    same order, and only the particle between them and the ending after them
    differ, so reading the label as one literal string made an outcome the
    clause plainly states look absent.  Requiring every word, in the label's
    own order, keeps that from admitting an outcome the clause never states.
    """

    return source_statement_matches(value, outcome)


def _clause_explicitly_declares_outcome(clause: str, outcome: str) -> bool:
    normalized = _normalize_ocr_evidence_entity(clause)
    outcome_key = _normalize_ocr_evidence_entity(outcome)
    if not normalized or not outcome_key:
        return False
    for outcome_match in _normalized_phrase_matches(normalized, outcome_key):
        prefix = normalized[: outcome_match.start()].strip()
        if _has_english_outcome_predicate(prefix) or _has_direct_source_benefit_predicate(clause):
            return True
    return False


def _normalized_phrase_matches(value: str, phrase: str) -> list[re.Match[str]]:
    return source_phrase_matches(value, phrase)


def _has_english_ingredient_subject_relation(prefix: str, bridge: str) -> bool:
    if re.search(r"[가-힣]", f"{prefix} {bridge}"):
        return False
    if prefix and not re.fullmatch(r"(?:the|this|our|an?|a)", prefix, re.I):
        return False
    return _has_english_outcome_predicate(bridge)


_ENGLISH_NON_RELATION_PREDICATES = frozenset(
    {
        "be",
        "been",
        "being",
        "is",
        "are",
        "was",
        "were",
        "contain",
        "contains",
        "contained",
        "include",
        "includes",
        "included",
        "list",
        "lists",
        "listed",
        "mention",
        "mentions",
        "mentioned",
        "discuss",
        "discusses",
        "discussed",
        "describe",
        "describes",
        "described",
        "show",
        "shows",
        "shown",
        "feature",
        "features",
        "featured",
        "present",
        "presents",
        "presented",
        "appear",
        "appears",
        "appeared",
        "refer",
        "refers",
        "referred",
        "define",
        "defines",
        "defined",
        "state",
        "states",
        "stated",
        "note",
        "notes",
        "noted",
    }
)


def _has_english_outcome_predicate(value: str) -> bool:
    """Recognize an asserted English predicate without an outcome vocabulary list.

    The relation record already supplies the ingredient and outcome terms.  We
    therefore inspect their grammar, rejecting only verbs that introduce a
    list, mention, or definition rather than requiring a skincare verb list.
    """

    words = re.findall(r"[a-z]+", value.casefold())
    if not words:
        return False
    for index, word in enumerate(words):
        if word in _ENGLISH_NON_RELATION_PREDICATES:
            continue
        if re.fullmatch(r"[a-z]{3,}(?:s|ed|ing)", word):
            return True
        if word in {"can", "could", "may", "might", "will", "would", "do", "does", "did"}:
            following = next((candidate for candidate in words[index + 1 :] if candidate not in {"also", "visibly"}), "")
            if following and following not in _ENGLISH_NON_RELATION_PREDICATES and len(following) >= 3:
                return True
    return False


def _has_korean_ingredient_subject_relation(bridge: str, suffix: str, *, subject_is_clause_initial: bool = False) -> bool:
    """Keep Korean relation admission grammatical and reject mere co-mentions.

    A subject particle marks the ingredient as what the clause is about.  A PDP
    prints an ingredient card as a name on one line and its account on the
    next, and OCR flattens the two into one clause with the particle gone; the
    ingredient still stands where the clause begins, with nothing before it, so
    it is still what the clause is about.  A name inside a list is preceded by
    the list, which is what keeps a co-mention out.
    """

    if not re.match(r"^(?:은|는|이|가)\b", bridge) and not subject_is_clause_initial:
        return False
    relation = f"{bridge} {suffix}".strip()
    # Presence is not a relation: a clause that only records the ingredient as
    # contained, listed, or written down says nothing about what it does.  A
    # clause that attributes an account of it -- the page introducing it *as*
    # something -- does, and that is how a source states an ingredient's role.
    if re.search(r"(?:포함|함유|나열|표기|기재|존재|보유|있(?:습니다|다)|없(?:습니다|다)).*(?:다|요)$", relation):
        return False
    # The clause has to close on a finite predicate.  The outcome itself can
    # carry the stem the ending attaches to ("견고하게 합니다"), so the ending
    # may stand as its own word rather than always as a suffix on the word
    # before it.
    return bool(
        re.search(
            r"(?:[가-힣]*(?:습니다|합니다|됩니다|한다|된다|했다|됐다|해요|돼요|아요|어요)|"
            r"(?:도움을?\s*)?(?:줍니다|줘요|줌)|돕습니다|도와줍니다|기여합니다)$",
            relation,
        )
    )


def _unique_semantic_records(values: Sequence[Mapping[str, Any]], kind: str = "") -> list[dict[str, Any]]:
    seen: set[str] = set()
    result: list[dict[str, Any]] = []
    for value in values:
        record = as_dict(value)
        if not record:
            continue
        source = _clean(record.get("sourceText")) or _clean(record.get("sentence"))
        if kind == "metric" and source:
            # One OCR line can state more than one measured result: a results
            # panel prints a figure per outcome under one set of test
            # conditions.  Keying on the source alone dropped every row after
            # the first, which is the same defect the relation key below
            # already fixes.  The measurement and the outcome it measures are
            # part of a metric's identity, so two parses of one sentence still
            # collapse while two rows of one panel both survive.
            key = ":".join(
                [
                    "metric",
                    source.casefold(),
                    _clean(record.get("value")).casefold(),
                    _clean(record.get("unit")).casefold(),
                    (_clean(record.get("label")) or _clean(record.get("metric"))).casefold(),
                ]
            )
        elif kind == "relation" and source:
            # One OCR sentence can explicitly state more than one formula
            # relationship.  Deduplicating by source alone silently drops
            # every relation after the first; the relation identity includes
            # its parsed subject and outcome while retaining identical-record
            # deduplication.
            key = ":".join(
                [
                    "relation",
                    source.casefold(),
                    _clean(record.get("ingredient")).casefold(),
                    _clean(record.get("benefit")).casefold(),
                    _clean(record.get("effect")).casefold(),
                ]
            )
        else:
            key = json.dumps(record, ensure_ascii=False, sort_keys=True, default=str)
        if key not in seen:
            seen.add(key)
            result.append(record)
    return result


def _ocr_sentence_insights(source: object) -> list[dict[str, Any]]:
    paths = (
        "sourceExtraction.ocr.sentenceInsights",
        "geoProduct.sourceExtraction.ocr.sentenceInsights",
        "ocr.sentenceInsights",
        "geoProduct.ocr.sentenceInsights",
        "aiAnalysis.sentenceInsights",
        "geoProduct.aiAnalysis.sentenceInsights",
    )
    explicit = [
        insight
        for path in paths
        for insight in _read_ocr_sentence_insights(_get_path(source, path))
    ]
    declared_keys = {
        f"{_clean(item.get('category')).casefold()}:{_clean(item.get('text')).casefold()}" for item in explicit
    }
    fallback = [
        item
        for item in _read_ocr_text_insights(source)
        if f"{_clean(item.get('category')).casefold()}:{_clean(item.get('text')).casefold()}" not in declared_keys
    ]
    return _unique_ocr_sentence_insights([*explicit, *fallback])


def _read_ocr_sentence_insights(value: object) -> list[dict[str, Any]]:
    insights: list[dict[str, Any]] = []
    for raw in as_list(value):
        record = as_dict(raw)
        text = _clean(record.get("text"))
        if not text:
            continue
        image_urls = _ocr_image_urls(record)
        keywords = _string_list(record.get("keywords"))[:10]
        declared_category = _normalize_ocr_category(_clean(record.get("category")))
        for category in _infer_ocr_sentence_categories(text, keywords, _clean(record.get("category"))):
            insights.append(
                {
                    "text": text,
                    "category": category,
                    "keywords": keywords,
                    "imageUrls": image_urls,
                    **({"declaredCategory": declared_category} if declared_category else {}),
                    **({"imageUrl": image_urls[0]} if image_urls else {}),
                    **({"semanticFacts": as_dict(record.get("semanticFacts"))} if as_dict(record.get("semanticFacts")) else {}),
                }
            )
    return insights


def _read_ocr_text_insights(source: object) -> list[dict[str, Any]]:
    roots = [
        _get_path(source, path)
        for path in (
            "sourceExtraction.ocr",
            "geoProduct.sourceExtraction.ocr",
            "sourceExtraction.images",
            "geoProduct.sourceExtraction.images",
            "ocr",
            "geoProduct.ocr",
            "images",
            "aiAnalysis.ocr",
            "geoProduct.aiAnalysis.ocr",
        )
    ]
    insights: list[dict[str, Any]] = []
    for root in roots:
        record = as_dict(root)
        if not record:
            continue
        for field in ("textBlocks", "imageTexts"):
            for raw in as_list(record.get(field)):
                item = as_dict(raw)
                text = _clean(item.get("text")) if item else _clean(raw)
                image_urls = _ocr_image_urls(item) if item else []
                for sentence in _split_ocr_text_into_sentences(text):
                    for category in _infer_ocr_sentence_categories(sentence, [], ""):
                        insights.append(
                            {
                                "text": sentence,
                                "category": category,
                                "keywords": [],
                                "imageUrls": image_urls,
                                "origin": "raw",
                                **({"imageUrl": image_urls[0]} if image_urls else {}),
                            }
                        )
    return insights[:80]


def _split_ocr_text_into_sentences(value: str) -> list[str]:
    lines = [_clean(item) for item in re.split(r"\r?\n+", value) if _clean(item)]
    values = lines if len(lines) > 1 else re.split(r"(?<=[.!?。！？])\s+", value)
    return [item for item in (_clean(value) for value in values) if _useful_source_text(item)]


def _unique_ocr_sentence_insights(values: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    result: list[dict[str, Any]] = []
    for value in values:
        text = _clean(value.get("text"))
        category = _clean(value.get("category")).casefold()
        image_url = _first(_string_list(value.get("imageUrls"))) or _clean(value.get("imageUrl"))
        key = f"{category}:{text.casefold()}:{image_url}"
        if text and category in _OCR_INTENTS and key not in seen:
            seen.add(key)
            result.append(dict(value))
    return result


def _normalize_ocr_category(value: str) -> str | None:
    category = value.casefold()
    if re.search(r"ingredient|active|formula|technology|성분|원료", category):
        return "ingredient"
    if re.search(r"effect|efficacy|result|효능|효과", category):
        return "effect"
    if re.search(r"benefit|concern|target|장점|고민|피부", category):
        return "benefit"
    if re.search(r"usage|direction|how|사용", category):
        return "usage"
    if re.search(r"review|rating|customer|리뷰|후기", category):
        return "review"
    if re.search(r"metric|claim|수치|지표|결과", category):
        return "metric"
    return None


def _infer_ocr_sentence_categories(text: str, _keywords: Sequence[str], explicit_value: str) -> list[str]:
    explicit = _normalize_ocr_category(explicit_value)
    categories = [explicit] if explicit and _ocr_category_allowed(text, explicit) else []
    if explicit == "review":
        return ["review"]
    roles = set(cast(list[str], infer_pdp_evidence_roles(text).get("roles", [])))
    categories.extend(category for category in _OCR_INTENTS if category in roles)
    return _unique(categories)


def _ocr_category_allowed(text: str, category: str) -> bool:
    if category == "ingredient":
        return _is_ingredient_signal(text)
    if category == "benefit":
        return _is_benefit_evidence_role(text)
    if category == "effect":
        return _is_effect_signal(text)
    if category == "usage":
        return _is_usage_instruction_evidence(text)
    return True


def _ocr_image_urls(value: Mapping[str, Any]) -> list[str]:
    raw_urls = _string_list(value.get("imageUrls"))
    if not raw_urls:
        raw_urls = [
            _clean(value.get(key))
            for key in ("imageUrl", "sourceImage", "sourceImageUrl", "sourceUrl", "src", "url")
            if _clean(value.get(key))
        ]
    return _unique([item for item in raw_urls if _is_valid_ocr_image_url(item)])


def _is_valid_ocr_image_url(value: str) -> bool:
    return bool(value and not value.startswith("data:") and (re.match(r"^https?://", value, re.I) or "#" in value))


def _ocr_image_confidence_by_url(source: object) -> dict[str, float]:
    confidence_by_url: dict[str, float] = {}
    for path in ("sourceExtraction.ocr.imageTexts", "geoProduct.sourceExtraction.ocr.imageTexts"):
        for raw in as_list(_get_path(source, path)):
            record = as_dict(raw)
            confidence = record.get("confidence")
            if not isinstance(confidence, int | float) or isinstance(confidence, bool):
                continue
            for image_url in _ocr_image_urls(record):
                confidence_by_url[image_url] = float(confidence)
    return confidence_by_url


def _ocr_source_text_meta(insight: Mapping[str, Any], confidence_by_url: Mapping[str, float]) -> dict[str, Any]:
    image_urls = _string_list(insight.get("imageUrls"))
    if not image_urls:
        image_urls = _string_list(insight.get("imageUrl"))
    meta: dict[str, Any] = {}
    if image_urls:
        meta["imageUrls"] = image_urls
        confidence = [confidence_by_url[url] for url in image_urls if url in confidence_by_url]
        if confidence:
            meta["ocrConfidence"] = min(confidence)
    return meta


def _unique_source_text_entries(
    values: Sequence[tuple[str, Mapping[str, Any] | None]], limit: int = 120
) -> tuple[list[str], dict[str, dict[str, Any]]]:
    texts: list[str] = []
    metadata: dict[str, dict[str, Any]] = {}
    seen: set[str] = set()
    for value, meta in values:
        text = _clean(value)
        key = text.casefold()
        if not text or key in seen:
            continue
        seen.add(key)
        texts.append(text)
        if meta:
            compact = as_dict(meta)
            image_urls = _unique(_string_list(compact.get("imageUrls")))
            entry: dict[str, Any] = {"imageUrls": image_urls} if image_urls else {}
            confidence = compact.get("ocrConfidence")
            if isinstance(confidence, int | float) and not isinstance(confidence, bool):
                entry["ocrConfidence"] = confidence
            if entry:
                metadata[text] = entry
        if len(texts) >= limit:
            break
    return texts, metadata


def _ocr_sentence_diagnostics(insights: Sequence[Mapping[str, Any]], _locale: PdpGeoLocale) -> list[dict[str, Any]]:
    grouped: dict[str, dict[str, Any]] = {}
    for insight in insights:
        text = _clean(insight.get("text"))
        category = _clean(insight.get("category")).casefold()
        if not text or category not in _OCR_INTENTS:
            continue
        entry = grouped.setdefault(text.casefold(), {"text": text, "imageUrls": [], "intents": []})
        entry["imageUrls"] = _unique([*entry["imageUrls"], *_string_list(insight.get("imageUrls"))])
        entry["intents"] = _unique([*entry["intents"], category])
    diagnostics: list[dict[str, Any]] = []
    for entry in grouped.values():
        intents = entry["intents"]
        schema_fields = _schema_fields_for_ocr_intents(intents)
        if not schema_fields:
            continue
        diagnostics.append(
            {
                "text": entry["text"],
                **({"imageUrls": entry["imageUrls"]} if entry["imageUrls"] else {}),
                "intents": intents,
                "schemaFields": schema_fields,
                "geoUse": _geo_use_for_ocr_sentence(intents),
            }
        )
    return diagnostics[:80]


def _schema_fields_for_ocr_intents(intents: Sequence[str]) -> list[str]:
    fields: list[str] = []
    if "ingredient" in intents:
        fields.extend(["Product.additionalProperty[Key ingredients]", "Product.description", "content.sections.ingredients"])
    if "effect" in intents or "benefit" in intents:
        fields.extend(["Product.description", "WebPage.description", "content.sections.benefits", "FAQPage.mainEntity"])
    if "usage" in intents:
        fields.extend(["HowTo.step", "content.sections.howToUse"])
    if "review" in intents:
        fields.extend(["Review.reviewBody", "Product.additionalProperty", "FAQPage.mainEntity"])
    if "metric" in intents:
        fields.extend(["Product.additionalProperty[Reported details]", "Product.description", "FAQPage.mainEntity"])
    return _unique(fields)


def _geo_use_for_ocr_sentence(intents: Sequence[str]) -> str:
    has_ingredient = "ingredient" in intents
    has_benefit = "benefit" in intents or "effect" in intents
    if "metric" in intents and has_ingredient:
        return "ingredient_metric_evidence"
    if "metric" in intents:
        return "metric_evidence"
    if has_ingredient and has_benefit:
        return "ingredient_effect_evidence"
    if has_ingredient:
        return "ingredient_evidence"
    if has_benefit:
        return "benefit_effect_evidence"
    if "usage" in intents:
        return "usage_routine_evidence"
    if "review" in intents:
        return "review_experience_evidence"
    return "semantic_ocr_evidence"


def _get_path(value: object, path: str) -> object:
    current = value
    for part in path.split("."):
        if isinstance(current, Mapping):
            record = cast(Mapping[str, object], current)
            if part not in record:
                return _MISSING
            current = record[part]
        elif isinstance(current, Sequence) and not isinstance(current, str | bytes | bytearray) and part.isdigit():
            items = cast(Sequence[object], current)
            index = int(part)
            if index >= len(items):
                return _MISSING
            current = items[index]
        else:
            return _MISSING
    return current


def _text(value: object) -> str:
    return clean_text(value)


def _clean(value: object) -> str:
    return re.sub(r"\s+", " ", _text(value)).strip()


def _first(values: Sequence[str | None]) -> str | None:
    return next((value for value in values if value), None)


def _first_long(values: Sequence[str]) -> str | None:
    return next((value for value in values if len(value) >= 12), _first(values))


def _unique(values: Sequence[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        cleaned = _clean(value)
        key = cleaned.casefold()
        if cleaned and key not in seen:
            seen.add(key)
            result.append(cleaned)
    return result


def _flatten_text_values(value: object) -> list[str]:
    if isinstance(value, str | int | float) and not isinstance(value, bool):
        return [str(value)]
    if isinstance(value, Mapping):
        record = cast(Mapping[str, object], value)
        preferred = [record.get(key) for key in ("text", "value", "name", "title", "body", "content", "description")]
        result = [text for item in preferred for text in _flatten_text_values(item)]
        return result or [text for item in record.values() for text in _flatten_text_values(item)]
    if isinstance(value, Sequence) and not isinstance(value, str | bytes | bytearray):
        return [text for item in cast(Sequence[object], value) for text in _flatten_text_values(item)]
    return []


def _string_list(value: object) -> list[str]:
    return [_clean(item) for item in as_list(value) if isinstance(item, str) and _clean(item)]


def _all_strings(value: object, key: str | None = None, depth: int = 0) -> list[str]:
    """Collect source text without re-ingesting derived keyword/chunk output.

    Search terms and retrieval chunks are produced from the PDP rather than
    attested by it.  They must not re-enter the normalizer through the broad
    source-text fallback; TypeScript applies the same key/depth guard here.
    """

    if depth > 8 or (key is not None and _is_derived_keyword_or_chunk_key(key)):
        return []
    if isinstance(value, str):
        return [_clean(value)] if _clean(value) else []
    if isinstance(value, Mapping):
        return [
            text
            for child_key, child in cast(Mapping[str, object], value).items()
            for text in _all_strings(child, str(child_key), depth + 1)
        ]
    if isinstance(value, Sequence) and not isinstance(value, str | bytes | bytearray):
        return [
            text
            for index, child in enumerate(cast(Sequence[object], value))
            for text in _all_strings(child, str(index), depth + 1)
        ]
    return []


def _text_candidates_by_key(value: object, key_pattern: re.Pattern[str], *, in_review: bool | None = None) -> list[str]:
    results: list[str] = []

    def visit(current: object, reviewing: bool) -> None:
        if isinstance(current, Mapping):
            for key, child in cast(Mapping[str, object], current).items():
                child_review = reviewing or bool(_REVIEW.search(str(key)))
                if key_pattern.search(str(key)) and (in_review is None or child_review == in_review):
                    results.extend(_flatten_text_values(child))
                visit(child, child_review)
        elif isinstance(current, Sequence) and not isinstance(current, str | bytes | bytearray):
            for child in cast(Sequence[object], current):
                visit(child, reviewing)

    visit(value, False)
    return _unique(results)


def _text_candidates_by_key_outside_review(value: object, pattern: re.Pattern[str]) -> list[str]:
    return _text_candidates_by_key(value, pattern, in_review=False)


def _useful_source_text(value: str) -> bool:
    text = _clean(value)
    return (
        2 <= len(text) <= 2000
        and bool(re.search(r"[A-Za-z가-힣]", text))
        and not _URL.fullmatch(text)
        and not _COMMERCE.fullmatch(text)
    )


def _is_derived_keyword_or_chunk_key(key: str) -> bool:
    normalized = re.sub(r"[^\w가-힣]+", "", key.casefold())
    return bool(re.search(r"keyword|chunk|키워드|청크", normalized, re.I))


def _select_role_signals(
    semantic_values: Sequence[str],
    mapped_values: Sequence[str],
    inferred_values: Sequence[str],
    field: str,
) -> list[str]:
    """Keep the retained normalizer's role-first, trusted-mapping order.

    ``normalize.ts`` does not admit mapped values merely because they were
    named by a field.  It first takes values whose inferred role matches the
    destination, then recovers concise conflict-free mapped vocabulary, and
    only then adds inferred page evidence.  That order makes the role gate a
    deterministic semantic sort key rather than an arbitrary list reorder.
    """

    return _unique(
        [
            *_normalize_field_signals([*semantic_values, *mapped_values], field),
            *_trusted_mapped_role_signals(mapped_values, field),
            *_normalize_field_signals(inferred_values, field),
        ]
    )


def _explicit_benefit_backing_sources(
    source: object,
    ocr_insights: Sequence[Mapping[str, Any]],
    semantic: Mapping[str, Any],
    reader: _MappedReader,
) -> list[str]:
    """Return source channels that can independently substantiate a benefit field.

    Do not use ``reader.strings("benefits")`` here: that would make an
    arbitrary mapped benefit self-authenticating.  A declarative benefit that
    falls outside the historical vocabulary needs a matching independently
    supplied source sentence, OCR unit, description, or semantic evidence
    sentence.
    """

    return _unique(
        [
            *_string_list(_get_path(source, "sourceTexts")),
            *_string_list(_get_path(source, "geoProduct.sourceTexts")),
            *_metafield_texts(source),
            *_string_list(_get_path(source, "sourceExtraction.ocr.textBlocks")),
            *_string_list(_get_path(source, "geoProduct.sourceExtraction.ocr.textBlocks")),
            *[_clean(item.get("text")) for item in ocr_insights if _clean(item.get("text"))],
            *_string_list(semantic.get("evidenceSentences")),
            *reader.strings("description"),
        ]
    )


def _source_grounded_declarative_benefits(values: Sequence[str], source_texts: Sequence[str]) -> list[str]:
    """Retain a mapped product-benefit clause when a separate source states it.

    The generic grammar check deliberately does not infer ingredient links or
    category-specific efficacy.  It only restores a complete, source-backed
    product statement after the role guards reject commerce, review, safety,
    usage, and metric text.
    """

    return _unique(
        [
            value
            for value in values
            if _is_declarative_product_benefit(value)
            and any(_source_contains_declared_fact(source, value) for source in source_texts)
        ]
    )


def _source_contains_declared_fact(source: str, fact: str) -> bool:
    source_key = _normalize_ocr_evidence_entity(source)
    fact_key = _normalize_ocr_evidence_entity(fact)
    return bool(fact_key and len(fact_key) >= 6 and fact_key in source_key)


def _is_declarative_product_benefit(value: str) -> bool:
    """Recognize a complete product-benefit assertion without a benefit vocabulary.

    This gate is used only for a field explicitly mapped as ``benefits`` and
    only after a separate source text has matched it.  The predicate test is
    therefore grammatical rather than a hidden skincare/hair-care allowlist.
    """

    text = _clean_source_signal_text(value)
    if (
        not text
        or len(text) < 8
        or len(text) > 320
        or _is_question_like_source_text(text)
        or _is_broken_source_fragment(text)
        or _is_commerce_quantity_or_offer_text(text)
        or _is_safety_or_suitability_caution(text)
        or _is_customer_experience_evidence(text)
        or (_is_usage_instruction_evidence(text) and not _is_nonprocedural_english_benefit_clause(text))
        or _is_metric_evidence_text(text)
        or _has_negative_or_adverse_relation_polarity(text)
        or _is_non_product_benefit_context(text)
        or _is_review_or_safety_context(text)
    ):
        return False
    if _has_direct_source_benefit_predicate(text):
        return True
    if re.search(r"[가-힣]", text):
        return bool(
            re.search(
                r"[가-힣]+(?:습니다|합니다|됩니다|한다|된다|했다|됐다|해요|돼요|아요|어요)$",
                text.rstrip(".。！？!? "),
            )
        )
    return _has_generic_english_declarative_predicate(text)


def _has_generic_english_declarative_predicate(value: str) -> bool:
    """Use finite-verb morphology, with an adverb+bare-verb fallback.

    Most English product assertions expose a finite ``-s``/``-ed`` predicate
    (``Adds …``, ``Repels …``).  A plural feature subject can use a bare verb
    instead (``The flexible teeth gently detangle …``), which the adverb
    bridge identifies without naming that verb or a product category.
    """

    words = re.findall(r"[a-z]+", value.casefold())
    if len(words) < 2:
        return False
    if any(
        re.fullmatch(r"[a-z]{3,}(?:s|ed)", word) and word not in _ENGLISH_NON_RELATION_PREDICATES
        for word in words
    ):
        return True
    excluded_predicates = "|".join(re.escape(word) for word in sorted(_ENGLISH_NON_RELATION_PREDICATES))
    return bool(
        re.search(
            r"^(?:the|these|those|our|your)\s+(?:[a-z-]+\s+){0,4}[a-z]{3,}ly\s+"
            rf"(?!(?:{excluded_predicates})\b)[a-z]{{3,}}\b",
            value,
            re.I,
        )
    )


def _is_nonprocedural_english_benefit_clause(value: str) -> bool:
    """Avoid treating a result adjective such as ``smooth`` as a HowTo verb."""

    text = _clean_source_signal_text(value)
    if re.search(
        r"^\s*(?:apply|dispense|massage|lather|rinse|pat|press|spread|smooth|warm|take|pump|spray|spritz|dot|tap)\b|"
        r"\b(?:use|used|usage|daily|morning|night|after|before)\b",
        text,
        re.I,
    ):
        return False
    return _has_generic_english_declarative_predicate(text)


def _is_non_product_benefit_context(value: str) -> bool:
    """Keep suitability prompts and commerce UI out of a product-benefit field."""

    return bool(
        re.search(
            r"\b(?:right|suitable|ideal|best|recommended)\s+for\s+you\b|"
            r"(?:무료\s*배송|배송|반품|환불|쿠폰|적합(?:한|성)|추천(?:할|하는)?)",
            value,
            re.I,
        )
    )


def _is_review_or_safety_context(value: str) -> bool:
    """Keep customer testimony and incomplete safety statements out of benefits."""

    return bool(
        re.search(r"\b(?:customers?|users?)\b", value, re.I)
        or re.search(r"\b(?:not|never)\s+tested\b|\btested\s+on\s+animals?\b", value, re.I)
    )


def _normalize_field_signals(values: Sequence[str], field: str) -> list[str]:
    """Port the source-unit/role admission boundary used by ``normalize.ts``.

    This is the strict role-admission phase.  The separate trusted-mapping
    phase below may retain a concise novel name, but it must not bypass this
    phase's ordering.
    """

    units = [unit for value in values for unit in _split_field_signal_units(value, field)]
    accepted: list[str] = []
    for unit in units:
        text = _clean(unit)
        if not text or not _useful_source_text(text) or _is_question_like_source_text(text):
            continue
        roles = set(cast(list[str], infer_pdp_evidence_roles(text).get("roles", [])))
        if field in roles:
            accepted.append(text)
    return _unique(accepted)


def _trusted_mapped_role_signals(values: Sequence[str], field: str) -> list[str]:
    return _unique(
        [
            text
            for value in values
            for unit in _split_field_signal_units(value, field)
            if (text := _clean(unit))
            and _is_trusted_mapped_role_signal(
                text,
                field,
                set(cast(list[str], infer_pdp_evidence_roles(text).get("roles", []))),
            )
        ]
    )


def _split_field_signal_units(value: str, field: str) -> list[str]:
    text = _clean(value)
    if not text:
        return []
    if field == "usage":
        return [text]
    if field in {"benefit", "effect"}:
        parts = [_clean(part) for part in re.split(r"\s*,\s*", text)]
        if (
            len(parts) >= 3
            and all(
                2 <= len(part) <= 24
                and len(part.split()) <= 3
                and not re.search(r"[.!?。！？():;：；]", part)
                for part in parts
            )
        ):
            return parts
    return [_clean(part) for part in re.split(r"(?:\r?\n|\s*[•●▪■]\s*|(?<=[.!?。！？])\s+(?=[\w가-힣]))", text) if _clean(part)]


def _is_trusted_mapped_role_signal(value: str, field: str, roles: set[str]) -> bool:
    if (
        not _useful_source_text(value)
        or _is_question_like_source_text(value)
        or _is_commerce_quantity_or_offer_text(value)
    ):
        return False
    if field == "ingredient" and re.fullmatch(r"(?:ingredients?|actives?|formula|성분|원료|전성분|成分|原料)", value, re.I):
        return False
    if field in {"benefit", "effect"} and re.fullmatch(
        r"(?:benefits?|effects?|results?|claims?|효능|효과|장점|결과|効果|ベネフィット)", value, re.I
    ):
        return False
    if field in roles:
        return True
    conflicts = roles - {"source"}
    if field == "ingredient":
        if conflicts or (len(value) > 120 or bool(re.search(r"[.!?。！？]", value))):
            return False
        return not bool(
            re.fullmatch(
                r"(?:absorption|absorbency|retention|persistence|texture|finish|efficacy|effect|duration|hydration|"
                r"moisture|firmness|흡수력|흡수성|잔존|유지력|지속력|제형|질감|사용감|효능|효과|기간|보습력|수분감|탄력|피부\s*타입)",
                value,
                re.I,
            )
            or re.fullmatch(r"\d+(?:[.,]\d+)?\s*(?:%|％|배|hours?|days?|weeks?|시간|일|주)?", value, re.I)
        )
    if conflicts & {"usage", "safety", "review", "metric", "faq", "commerce", "ingredient"}:
        return False
    if len(value) > 100 or re.search(r"[.!?。！？]", value):
        return False
    return bool(re.search(r"[A-Za-z가-힣]", value))


def _is_question_like_source_text(value: str) -> bool:
    return bool(
        re.search(r"[?？]\s*$", value)
        or re.match(r"^(?:what|how|why|when|where|who|which|can|does|do|is|are)\b", value, re.I)
        or re.search(r"(?:무엇|뭐|어떤|어떻게|왜|언제|어디|누가|가능|괜찮|되나|되나요|인가요|있나요|할까요|좋나요)\s*[.!。]?$", value)
    )


def _section_texts(source: object, category_pattern: re.Pattern[str]) -> list[str]:
    # Structured semantic facts already travel through the role-aware
    # ``semantic`` path above.  Recursing into them here would treat a
    # relation record's ``benefit`` key as a page section and flatten its
    # source sentence into the public benefit/ingredient lists.
    out: list[str] = []

    def visit(current: object) -> None:
        if isinstance(current, Mapping):
            for key, child in cast(Mapping[str, object], current).items():
                if str(key) == "semanticFacts":
                    continue
                if category_pattern.search(str(key)):
                    out.extend(_flatten_text_values(child))
                visit(child)
        elif isinstance(current, Sequence) and not isinstance(current, str | bytes | bytearray):
            for child in cast(Sequence[object], current):
                visit(child)

    visit(source)
    return [text for text in _unique(out) if _useful_source_text(text)]


def _is_category_signal(value: str) -> bool:
    return len(_clean(value)) >= 2 and not bool(_COMMERCE.search(value))


def _as_locale(value: str) -> PdpGeoLocale | None:
    if value == "ko-KR":
        return "ko-KR"
    if value == "ja-JP":
        return "ja-JP"
    if value == "en-US":
        return "en-US"
    if value == "en-GB":
        return "en-GB"
    return None


def _infer_locale(value: str) -> PdpGeoLocale:
    if re.search(r"[가-힣]", value):
        return "ko-KR"
    if re.search(r"[ぁ-んァ-ン一-龯]", value):
        return "ja-JP"
    return "en-US"


def _default_market(locale: PdpGeoLocale) -> str:
    return {"ko-KR": "KR", "ja-JP": "JP", "en-US": "US", "en-GB": "GB"}[locale]


def _absolute_url(value: str, base: str) -> str:
    return urljoin(base, value) if base else value


def _split_potential_list(value: str) -> list[str]:
    return [_clean(item) for item in re.split(r"\s*[,|]\s*", value) if _clean(item)]


def _faq_from_unknown(value: object) -> list[dict[str, str]]:
    if isinstance(value, Mapping) and isinstance(cast(Mapping[str, object], value).get("items"), Sequence):
        candidates = as_list(cast(Mapping[str, object], value).get("items"))
    elif isinstance(value, Mapping):
        candidates = list(cast(Mapping[str, object], value).values())
    else:
        candidates = as_list(value)
    output: list[dict[str, str]] = []
    for item in candidates:
        record = as_dict(item)
        question = _first([_text(record.get(key)) for key in ("question", "q", "name", "title")])
        accepted = record.get("acceptedAnswer")
        answer = _first([_text(record.get(key)) for key in ("answer", "a", "text")] + _accepted_answer_values(accepted))
        if question and answer:
            output.append({"question": question, "answer": answer})
    return output


def _accepted_answer_values(value: object) -> list[str]:
    record = as_dict(value)
    return [_text(record.get("text")), _text(record.get("answer"))]


def _faq_from_loose_texts(source: object) -> list[dict[str, str]]:
    # Keep this intentionally conservative: a question must be adjacent to an
    # answer-like sentence, so ordinary OCR questions do not become a FAQ.
    texts = [text for text in _all_strings(source) if len(text) <= 500]
    items: list[dict[str, str]] = []
    for index, text in enumerate(texts[:-1]):
        if re.search(r"[?？]$", text.strip()):
            answer = _clean(texts[index + 1])
            if len(answer) >= 4 and not answer.endswith(("?", "？")):
                items.append({"question": _clean(text), "answer": answer})
    return items


def _unique_faq(values: Sequence[dict[str, str]]) -> list[dict[str, str]]:
    seen: set[str] = set()
    result: list[dict[str, str]] = []
    for item in values:
        question, answer = _clean(item.get("question")), _clean(item.get("answer"))
        key = question.casefold()
        if question and answer and key not in seen:
            seen.add(key)
            result.append({"question": question, "answer": answer})
    return result


def _normalize_reviews(source: object, reader: _MappedReader) -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    for raw in [*reader.values("reviews"), _get_path(source, "customerReviewAnalysis.items")]:
        items.extend(_read_review_items(raw))
    deduped: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in items:
        key = item["body"].casefold()
        if key not in seen:
            seen.add(key)
            deduped.append(item)
    keyword_candidates = [
        *_text_candidates_by_key(source, re.compile(r"^(?:keywords?|키워드)$", re.I), in_review=True),
        *[keyword for item in deduped for keyword in _extract_review_keywords(str(item["body"]))],
        *_string_list(_get_path(source, "geoProduct.reviews.keywords")),
        *_string_list(_get_path(source, "reviews.keywords")),
        *_string_list(_get_path(source, "customerReviewAnalysis.keywords")),
    ]
    keywords = _unique([item for item in keyword_candidates if _is_review_keyword(item)])[:16]
    rating = _first_number([*reader.values("rating"), _get_path(source, "reviews.rating")])
    count = _first_number([*reader.values("reviewCount"), _get_path(source, "reviews.reviewCount")])
    return {
        **({"rating": rating} if rating is not None else {}),
        **({"reviewCount": count} if count is not None else {}),
        "items": deduped[:12],
        "keywords": keywords,
    }


def _is_review_keyword(value: str) -> bool:
    text = _clean(value)
    if not text or text.casefold() in {"review", "reviews", "rating", "ratings", "star", "stars", "customer", "keyword", "keywords", "ingredient", "ingredients"}:
        return False
    if 3 <= len(text) <= 32 and re.search(
        r"보습|흡수|탄력|피부결|순한|만족|촉촉|매끄|광채|texture|smooth|hydration|moist|moisture|firm|elastic|lightweight|rich|absorbs|glow|plump|うるおい|保湿|ハリ|なじみ|満足",
        text,
        re.I,
    ):
        return True
    return (
        3 <= len(text) <= 12
        and bool(re.fullmatch(r"[가-힣\s]+", text))
        and text.casefold() not in {"리뷰", "후기", "평점", "별점", "고객", "키워드", "성분", "제품", "상품", "옵션"}
        and len(text.split()) <= 3
    )


def _read_review_items(value: object) -> list[dict[str, Any]]:
    records = as_list(as_dict(cast(Mapping[str, object], value)).get("items")) if isinstance(value, Mapping) else as_list(value)
    result: list[dict[str, Any]] = []
    for item in records:
        if isinstance(item, str) and _clean(item):
            result.append({"body": _clean(item)})
            continue
        record = as_dict(item)
        body = _first(
            [
                _text(record.get(key))
                for key in ("body", "reviewBody", "text", "content", "comment", "longSummary", "shortSummary")
            ]
        )
        if body:
            author_object = as_dict(record.get("author"))
            item_out: dict[str, Any] = {"body": body}
            author = _text(record.get("author")) or _text(author_object.get("name"))
            rating = _number(record.get("rating")) or _number(as_dict(record.get("reviewRating")).get("ratingValue"))
            date = _text(record.get("datePublished")) or _text(record.get("createdAt"))
            if author:
                item_out["author"] = author
            if rating is not None:
                item_out["rating"] = rating
            if date:
                item_out["datePublished"] = date
            result.append(item_out)
    return result


def _extract_review_keywords(value: str) -> list[str]:
    """Extract compact review use-feel terms, not whole testimonial clauses."""

    terms: list[str] = []
    for clause in re.split(r"(?<=[.!?。！？])\s*|[,，]", value):
        for term in re.split(r"[\s./|·()[\]{}<>:;!?]+", clause):
            cleaned = _clean(term)
            if len(cleaned) >= 2 and re.search(
                r"보습|흡수|탄력|피부결|순한|만족|촉촉|texture|hydration|moisture|firm|"
                r"lightweight|rich|absorbs|うるおい|保湿|ハリ|なじみ|満足",
                cleaned,
                re.I,
            ):
                terms.append(cleaned)
    return _unique(terms)


def _number(value: object) -> float | int | None:
    if isinstance(value, int | float) and not isinstance(value, bool):
        return value
    if isinstance(value, str):
        try:
            parsed = float(value.replace(",", "").strip())
            return int(parsed) if parsed.is_integer() else parsed
        except ValueError:
            return None
    return None


def _first_number(values: Sequence[object]) -> float | int | None:
    return next((number for value in values if (number := _number(value)) is not None), None)


def _parse_variants(source: object, source_url: str) -> list[dict[str, Any]]:
    raw: object = []
    for path in ("variants", "geoProduct.variants", "product.variants"):
        candidate = _get_path(source, path)
        if candidate is not _MISSING:
            raw = candidate
            break
    variants: list[dict[str, Any]] = []
    for item in as_list(raw):
        record = as_dict(item)
        if not record and isinstance(item, str):
            try:
                record = as_dict(json.loads(item))
            except (TypeError, ValueError, json.JSONDecodeError):
                record = {}
        if not record:
            continue
        options = _unique(
            [*_string_list(record.get("options")), _text(record.get("option")), _text(record.get("title"))]
        )
        variant: dict[str, Any] = {"options": options}
        for key, value in (
            ("id", record.get("id") or record.get("variantId") or record.get("variant_id")),
            ("sku", sanitize_sku_value(record.get("sku") or record.get("skuId") or record.get("sku_id"))),
            (
                "gtin",
                sanitize_gtin_value(
                    record.get("gtin")
                    or record.get("gtin13")
                    or record.get("gtin14")
                    or record.get("barcode")
                    or record.get("ean")
                ),
            ),
            ("title", record.get("title")),
            ("price", record.get("price")),
            ("currency", record.get("currency") or record.get("priceCurrency") or record.get("price_currency")),
        ):
            text = _text(value)
            if text:
                variant[key] = text
        sold_out = record.get("soldOut") if isinstance(record.get("soldOut"), bool) else record.get("sold_out")
        availability = (
            normalize_availability_token(record.get("availability"))
            or normalize_availability_token(record.get("stockStatus") or record.get("stock_status"))
            or ("SoldOut" if sold_out is True else "InStock" if sold_out is False else None)
            or normalize_availability_token(record.get("available") or record.get("isAvailable"))
        )
        if availability:
            variant["availability"] = availability
        image = _text(record.get("image") or record.get("imageUrl") or record.get("image_url"))
        url = _text(record.get("url") or record.get("link"))
        if image and is_publishable_image_url(_absolute_url(image, source_url)):
            variant["image"] = _absolute_url(image, source_url)
        if url and _URL.fullmatch(_absolute_url(url, source_url)):
            variant["url"] = _absolute_url(url, source_url)
        if options or variant.get("sku") or variant.get("title"):
            variants.append(variant)
    return variants[:32]


def _extract_commerce_identity(source: object) -> dict[str, Any]:
    output: dict[str, Any] = {}
    sku_paths = ("skuId", "sku", "productCode", "prodCode", "goodsNo", "geoProduct.skuId", "geoProduct.sku", "product.skuId", "product.sku", "product.productCode")
    gtin_paths = ("gtin", "gtin13", "gtin14", "gtin12", "gtin8", "barcode", "ean", "upc", "jan", "geoProduct.gtin", "geoProduct.barcode", "product.gtin", "product.barcode")
    availability_paths = ("availability", "stockStatus", "stock_status", "geoProduct.availability", "geoProduct.stockStatus", "product.availability", "product.stockStatus")
    condition_paths = ("itemCondition", "condition", "geoProduct.itemCondition", "product.itemCondition")
    sku = next((value for path in sku_paths if (value := sanitize_sku_value(_get_path(source, path))) is not None), None)
    gtin = next((value for path in gtin_paths if (value := sanitize_gtin_value(_get_path(source, path))) is not None), None)
    availability = next((value for path in availability_paths if (value := normalize_availability_token(_get_path(source, path))) is not None), None)
    condition = next((value for path in condition_paths if (value := normalize_item_condition_token(_get_path(source, path))) is not None), None)
    if sku:
        output["sku"] = sku
    if gtin:
        output["gtin"] = gtin
    if availability:
        output["availability"] = availability
    if condition:
        output["itemCondition"] = condition
    return output


def _extract_commerce_trust(source: object) -> dict[str, Any]:
    output: dict[str, Any] = {}
    until = next(
        (
            value
            for path in ("priceValidUntil", "geoProduct.priceValidUntil", "product.priceValidUntil", "offers.priceValidUntil")
            if (value := _sanitize_date(_get_path(source, path), allow_future=True))
        ),
        None,
    )
    if until:
        output["priceValidUntil"] = until
    return_policy: dict[str, Any] = {}
    for path in ("returnPolicy", "geoProduct.returnPolicy", "product.returnPolicy"):
        value = _get_path(source, path)
        candidate = as_dict(value)
        if value is not _MISSING and candidate:
            return_policy = candidate
            break
    if return_policy:
        category = normalize_return_policy_category_token(return_policy.get("category") or return_policy.get("returnPolicyCategory"))
        country = sanitize_country_code_value(return_policy.get("applicableCountry") or return_policy.get("country"))
        days = sanitize_day_count_value(return_policy.get("merchantReturnDays") or return_policy.get("returnDays") or return_policy.get("days"))
        if category and country and (category != "MerchantReturnFiniteReturnWindow" or days is not None):
            policy: dict[str, Any] = {"category": category, "applicableCountry": country}
            if days is not None:
                policy["merchantReturnDays"] = days
            method = normalize_return_method_token(return_policy.get("returnMethod") or return_policy.get("method"))
            fees = normalize_return_fees_token(return_policy.get("returnFees") or return_policy.get("fees"))
            if method:
                policy["returnMethod"] = method
            if fees:
                policy["returnFees"] = fees
            policy_country = sanitize_country_code_value(return_policy.get("returnPolicyCountry"))
            if policy_country:
                policy["returnPolicyCountry"] = policy_country
            policy_url = _text(return_policy.get("url") or return_policy.get("link") or return_policy.get("merchantReturnLink"))
            if _URL.fullmatch(policy_url):
                policy["url"] = policy_url
            output["returnPolicy"] = policy
    shipping: dict[str, Any] = {}
    for path in ("shipping", "geoProduct.shipping", "product.shipping"):
        value = _get_path(source, path)
        candidate = as_dict(value)
        if value is not _MISSING and candidate:
            shipping = candidate
            break
    if shipping:
        destination = sanitize_country_code_value(shipping.get("destinationCountry") or shipping.get("country"))
        handling_min = sanitize_day_count_value(shipping.get("handlingDaysMin"))
        handling_max = sanitize_day_count_value(shipping.get("handlingDaysMax"))
        transit_min = sanitize_day_count_value(shipping.get("transitDaysMin"))
        transit_max = sanitize_day_count_value(shipping.get("transitDaysMax"))
        has_delivery_range = any(value is not None for value in (handling_min, handling_max, transit_min, transit_max))
        if destination and has_delivery_range:
            parsed_shipping: dict[str, Any] = {"destinationCountry": destination}
            for key, value in (
                ("handlingDaysMin", handling_min),
                ("handlingDaysMax", handling_max),
                ("transitDaysMin", transit_min),
                ("transitDaysMax", transit_max),
            ):
                if value is not None:
                    parsed_shipping[key] = value
            raw_rate = shipping.get("rate")
            rate = as_dict(raw_rate)
            rate_amount = raw_rate if isinstance(raw_rate, int | float) and not isinstance(raw_rate, bool) else rate.get("amount")
            rate_currency = _text(rate.get("currency")) if rate else _text(shipping.get("rateCurrency"))
            if isinstance(rate_amount, int | float) and not isinstance(rate_amount, bool) and rate_amount >= 0 and rate_currency:
                parsed_shipping["rate"] = {"amount": rate_amount, "currency": rate_currency}
            output["shipping"] = parsed_shipping
    return output


def _extract_date_modified(source: object, mapped: Sequence[str]) -> str | None:
    candidates: list[object] = [
        *mapped,
        *[
            _get_path(source, path)
            for path in (
                "dateModified",
                "geoProduct.dateModified",
                "geoProduct.updatedAt",
                "product.dateModified",
                "product.updatedAt",
            )
        ],
    ]
    return next((_sanitize_date(value) for value in candidates if _sanitize_date(value)), None)


def _sanitize_date(value: object, *, allow_future: bool = False) -> str | None:
    if not isinstance(value, str):
        return None
    match = re.fullmatch(r"(\d{4})[-./](\d{1,2})[-./](\d{1,2})([Tt\s].*)?", value.strip())
    if not match:
        return None
    try:
        date = datetime(int(match.group(1)), int(match.group(2)), int(match.group(3)), tzinfo=UTC)
    except ValueError:
        return None
    if not allow_future and date > datetime.now(UTC) + timedelta(hours=48):
        return None
    normalized = date.strftime("%Y-%m-%d")
    tail = (match.group(4) or "").strip()
    if tail:
        candidate = f"{normalized}T{tail[1:]}"
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?", candidate):
            return candidate
    return normalized


def _price_amount(raw: str) -> float | int | None:
    match = re.search(r"-?\d[\d,]*(?:\.\d+)?", raw)
    return _number(match.group(0)) if match else None


def _normalize_breadcrumbs(values: Sequence[object], fallback: Mapping[str, str | None]) -> list[dict[str, str]]:
    items = [item for raw in values for item in _read_breadcrumb(raw)]
    if len(items) < 2:
        url = fallback.get("url") or ""
        home = []
        if url:
            parsed = urlparse(url)
            if parsed.scheme and parsed.netloc:
                home = [{"name": "Home", "url": f"{parsed.scheme}://{parsed.netloc}"}]
        items = [
            *home,
            *([{"name": str(fallback["category"])}] if fallback.get("category") else []),
            *items,
            {"name": str(fallback["name"]), **({"url": url} if url else {})},
        ]
    result: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in items:
        name = _clean(item.get("name"))
        if name and name.casefold() not in seen:
            seen.add(name.casefold())
            result.append({"name": name, **({"url": item["url"]} if item.get("url") else {})})
    return result[:6]


def _read_breadcrumb(value: object) -> list[dict[str, str]]:
    if isinstance(value, str):
        return [{"name": _clean(part)} for part in re.split(r"[>/|]", value) if _clean(part)]
    record = as_dict(value)
    if isinstance(value, Sequence) and not isinstance(value, str | bytes | bytearray):
        return [item for child in cast(Sequence[object], value) for item in _read_breadcrumb(child)]
    name = _first([_text(record.get(key)) for key in ("name", "title", "label")])
    if not name:
        return []
    url = _first([_text(record.get(key)) for key in ("url", "href", "item")])
    return [{"name": name, **({"url": url} if url else {})}]


def _metafield_texts(source: object) -> list[str]:
    for path in ("metafields", "geoProduct.metafields", "product.metafields"):
        record = as_dict(_get_path(source, path))
        if record:
            return [f"{key}: {_text(value)}" for key, value in record.items() if _text(value)]
    return []


def _normalize_machine_prefixed_brand(candidate: str | None, name: str, source: object, source_url: str) -> str | None:
    # The conservative part matters: hyphenated real brands must remain intact.
    if (
        not candidate
        or not source_url
        or candidate != candidate.lower()
        or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)+", candidate)
    ):
        return candidate
    hostname = urlparse(source_url).hostname
    labels = hostname.lower().split(".") if hostname else []
    suffix = candidate.split("-")[-1]
    if len(labels) < 2 or suffix != labels[-2]:
        return candidate
    for text in [name, *_all_strings(source)]:
        if (
            re.search(rf"(?<![\w-]){re.escape(suffix)}(?![\w-])", text, re.I)
            and candidate.casefold() not in text.casefold()
        ):
            return suffix[:1].upper() + suffix[1:]
    return candidate


def _metric_claim_texts(claims: Sequence[object]) -> list[str]:
    result: list[str] = []
    for raw in claims:
        record = as_dict(raw)
        sentence = _text(record.get("sentence")) or _text(record.get("sourceText"))
        if sentence:
            result.append(sentence)
        elif record.get("value") and record.get("metric"):
            result.append(
                " ".join(
                    value
                    for value in [
                        _text(record.get("value")),
                        _text(record.get("unit")),
                        _text(record.get("metric")),
                        _text(record.get("timing")),
                    ]
                    if value
                )
            )
    return result


def _is_atomic_metric_evidence(value: str) -> bool:
    """Admit a complete attributed measurement, not a size/price token.

    The old broad unit regex promoted ``50 mL`` and ``120ml`` to metrics.  A
    publishable metric needs a measurable magnitude governed by a sentence
    predicate or a Korean attributed measurement context.
    """

    text = _clean(value)
    if (
        len(text) < 12
        or len(text) > 700
        or _is_question_like_source_text(text)
        or _is_commerce_quantity_or_offer_text(text)
        or is_compressed_multi_claim_metric_block(text)
        or re.fullmatch(r"(?:after|before|during)\s+\d+(?:\.\d+)?\s*(?:weeks?|days?|hours?)\.?", text, re.I)
        or re.fullmatch(r"\d+(?:\.\d+)?\s*(?:%|배|weeks?|days?|hours?|주|일|시간)\.?", text, re.I)
    ):
        return False
    # English measurements require a numeric magnitude with a nearby finite
    # predicate.  Korean uses its own sentence morphology and attribution
    # marker because subjects are frequently omitted.
    has_magnitude = bool(
        re.search(
            r"\d[\d,]*(?:\.\d+)?\s*(?:%|％|배|ppm|ppb|mg|㎎|ml|mL|g|oz|"
            r"weeks?|days?|hours?|minutes?|months?|years?|주|일|시간|분|개월|년|명|점)",
            text,
            re.I,
        )
    )
    if not has_magnitude:
        return False
    if re.search(r"[가-힣]", text):
        attributed = bool(
            re.search(r"\d[\d,]*(?:\.\d+)?\s*(?:분|시간|일|주|개월|년).{0,8}(?:직후|직전|후|뒤|전|동안|만에|차)", text)
            or re.search(r"\d[\d,]*\s*명", text)
        )
        return attributed and bool(re.search(r"(?:습니다|했다|되었습니다|확인되|개선|증가|감소|회복|향상)", text))
    predicate = re.compile(
        r"\b(?:is|are|was|were|be|been|being|has|have|had|does|did|can|could|will|would|shall|should|may|might|must|[a-z]{3,}ed)\b",
        re.I,
    )
    # A direct source result label such as "Instrumental results reported"
    # is a predicate even when its numeric timing appears later in the clause.
    return bool(predicate.search(text) and re.search(r"(?:result|report|improv|reduc|increase|decrease|hydrated|firm)", text, re.I))


def _is_commerce_quantity_or_offer_text(value: str) -> bool:
    text = _clean(value)
    without_label = re.sub(r"^(?:size|volume|capacity|용량|중량|사이즈)\s*[:：]?\s*", "", text, flags=re.I)
    return bool(
        re.fullmatch(r"\d+(?:\.\d+)?\s*(?:ml|mL|l|g|kg|oz|fl\.?\s*oz|개입|매|정)\.?", without_label, re.I)
        or re.fullmatch(r"(?:[$€£¥₩]\s*\d[\d,.]*|\d[\d,.]*\s*(?:원|usd|krw|jpy|eur|gbp))", without_label, re.I)
        or _COMMERCE.search(text)
    )


def dedupe_pdp_usage_instructions(values: Sequence[str]) -> list[str]:
    return _unique([value for value in values if _clean(value) and not _COMMERCE.search(value)])


def sanitize_pdp_semantic_facts(value: object) -> dict[str, Any]:
    """Retain only JSON-compatible source-backed semantic facts in stable order."""
    record = as_dict(value)
    result: dict[str, Any] = {
        "ingredients": _unique(_string_list(record.get("ingredients"))),
        "benefits": _unique(_string_list(record.get("benefits"))),
        "effects": _unique(_string_list(record.get("effects"))),
        # ``skinTypes`` feeds public audience and recommended-skin-type
        # fields.  Preserve only an affirmative, explicit audience fact;
        # cautions such as "Not recommended for sensitive skin" must never
        # become an endorsement merely because they mention a skin type.
        "skinTypes": _unique(
            [item for item in _string_list(record.get("skinTypes")) if _is_audience_evidence(item)]
        ),
        "usageSteps": _unique(_string_list(record.get("usageSteps"))),
        "safetyTests": _unique(_string_list(record.get("safetyTests"))),
        "metricClaims": _record_list(record.get("metricClaims")),
        "evidenceSentences": _unique(_string_list(record.get("evidenceSentences"))),
        "ingredientBenefitLinks": _record_list(record.get("ingredientBenefitLinks")),
        "citations": _record_list(record.get("citations")),
    }
    return result


def _record_list(value: object) -> list[dict[str, Any]]:
    return [
        {
            key: item
            for key, item in as_dict(raw).items()
            if isinstance(item, str | int | float | bool | list | dict)
        }
        for raw in as_list(value)
        if as_dict(raw)
    ]


def _clean_source_signal_text(value: object) -> str:
    """Mirror ``normalize.ts`` source-signal cleanup for role admission."""

    text = _clean(value)
    if re.match(r"^(?:https?://|data:image/|/)", text, re.I):
        return text
    return re.sub(r"\s+([,.!?。！？])", r"\1", re.sub(r"([.!?。！？])(?=[가-힣A-Z])", r"\1 ", text)).strip()


def _is_broken_source_fragment(value: str) -> bool:
    text = _clean_source_signal_text(value)
    return (
        text.count("(") != text.count(")")
        or bool(re.search(r"(?:…|\.\.\.)\s*$", text))
        or bool(re.search(r"리뉴얼\s*전\s*제품에서\s*고객님들이\s*만족|고객님들이\s*만족하셨던\s*속성|속성\s*\(", text))
    )


def _is_full_ingredient_list(value: str) -> bool:
    text = _clean_source_signal_text(value)
    if re.match(r"^(?:ingredients?|전성분|全成分)\s*[:：]?\s*", text, re.I):
        return len(re.sub(r"^(?:ingredients?|전성분|全成分)\s*[:：]?\s*", "", text, flags=re.I)) >= 12
    if text.count(",") < 8:
        return False
    matches = re.findall(
        r"water|aqua|eau|glycerin|glycol|sodium|potassium|cocoyl|cocoate|betaine|acrylates?|peg-\d+|"
        r"chloride|edta|extract|fragrance|parfum|limonene|benzoate|hydroxide|caprylyl|capryl|citrus|"
        r"niacinamide|retinol|panthenol|ceramide|hyaluronic|butylene|정제수|글리세린|글라이콜|다이올|"
        r"오일|추출물|애씨드|알코올|세라마이드|판테놀|콜레스테롤|카보머|토코페롤|레시틴|왁스|"
        r"폴리머|크로스폴리머|글루코|스쿠알란|실리카|이디티에이|트로메타민|잔탄검|하이드로|"
        r"메티콘|스테아레이트|카프릴|팔미|라우릭|미리스틱|올레익|만니톨|소듐|포스페이트|락톤",
        text,
        re.I,
    )
    return len({match.casefold() for match in matches}) >= 5


def _is_named_biochemical_or_formula(value: str) -> bool:
    text = _clean_source_signal_text(value)
    if not text or len(text) > 80 or re.search(r"[.!?。！？]", text) or re.match(r"^(?:skin|피부)\b", text, re.I):
        return False
    return bool(
        re.search(
            r"(?:acid|glucan|glycan|vitamin|enzyme|protein|lipid|sterol|alcohol|oxide|filtrate|ferment|"
            r"complex|blend|extract|oil|butter|peptide|ceramide|retinoid|technology|formula)(?:[™®])?$",
            text,
            re.I,
        )
        or re.search(r"(?:추출물|발효물|여과물|복합체|펩타이드|세라마이드|비타민|아미노산|지질|오일|버터|기술|포뮬러)(?:[™®])?$", text)
    )


def _is_ingredient_signal(value: str) -> bool:
    text = _clean_source_signal_text(value)
    if _is_broken_source_fragment(text):
        return False
    if _is_full_ingredient_list(text):
        return len(text) <= 4000
    if _is_atomic_metric_evidence(text) or len(text) > 360 or re.fullmatch(r"(?:성분|원료|ingredient|ingredients)", text, re.I):
        return False
    return bool(
        re.search(
            r"ingredients?|active|actives?|formula|technology|tech|complex|blend|ferment|extract|herb|전성분|성분표|"
            r"히알루론산|하이알루론산|세라마이드|징크|zinc|ha\b|캡슐|복합체|ceramide|hyaluronic|retinol|"
            r"niacinamide|peptide|ginseng|panthenol|aqua|glycerin",
            text,
            re.I,
        )
        or _is_named_biochemical_or_formula(text)
    )


def _is_role_coherent_ingredient_evidence(value: str) -> bool:
    text = _clean_source_signal_text(value)
    if not text or _is_broken_source_fragment(text):
        return False
    if _is_full_ingredient_list(text) or (not re.search(r"[.!?。！？]", text) and len(text) <= 80):
        return True
    if re.match(r"^(?:helps?|supports?|improves?|boosts?|strengthens?|leaves?|delivers?|addresses?|this\s+(?:unique\s+)?(?:compound|product)|이러한?\s*(?:성분|복합체|제품))", text, re.I):
        return False
    if re.match(r"^this\s+(?:advanced\s+|unique\s+)?formula\b", text, re.I) and not re.match(
        r"^this\s+(?:advanced\s+|unique\s+)?formula\s+(?:contains?|includes?|combines?|uses?)\b", text, re.I
    ):
        return False
    first_clause = re.split(r"[.!?。！？]", text)[0][:100]
    return bool(
        re.search(
            r"ingredient|active|formula|technology|complex|blend|extract|ferment|peptide|ceramide|hyaluronic|"
            r"retinol|niacinamide|ginseng|성분|원료|기술|포뮬러|복합체|추출|발효|펩타이드|세라마이드|"
            r"히알루론산|레티놀|나이아신아마이드|인삼|캡슐",
            first_clause,
            re.I,
        )
        or bool(re.match(r"^(?:this|the)\s+(?:formula|blend|complex|technology)\s+(?:contains?|includes?|combines?|uses?)\b", text, re.I))
    )


def _is_safety_or_suitability_caution(value: str) -> bool:
    text = _clean_source_signal_text(value)
    return bool(
        re.search(
            r"patch\s*test|patch\s*testing|test\s+on\s+a\s+small\s+area|discontinue\s+use|avoid\s+(?:contact|use)|"
            r"for\s+external\s+use|consult\s+(?:a|your)\s+(?:doctor|physician)|caution|warning|"
            r"not\s+(?:recommended|suitable|intended)\s+for|"
            r"(?:clinically|dermatologically)\s+tested\s+for\s+(?:[a-z-]+\s+){0,2}skin|"
            r"hypoallergenic(?:ally)?[-\s]?test(?:ed|ing|s)?\b|non[-\s]?comedogenic(?:ally)?[-\s]?test(?:ed|ing|s)?\b|"
            r"dermatologist[-\s]?tested|safety\s+test|sensitive\s+skin\s+(?:users?\s+)?should",
            text,
            re.I,
        )
        or bool(
            re.search(
                r"국소\s*부위|팔\s*안쪽|귀\s*뒤|패치\s*테스트|사용\s*전\s*테스트|이상\s*증상|사용을\s*중지|"
                r"전문의와\s*상담|주의사항|외용으로만|극민감\s*(?:피부\s*)?테스트|민감\s*피부\s*(?:대상\s*)?(?:피부\s*)?자극\s*테스트|"
                r"피부\s*자극\s*테스트|피부과\s*테스트|여드름성\s*피부\s*사용\s*적합\s*테스트|알러지\s*테스트|"
                r"인체\s*안자극\s*테스트|소아과\s*피부\s*테스트|하이포알러(?:지|제닉)\s*테스트|논코메도제닉\s*테스트",
                text,
            )
        )
    )


def _is_customer_experience_evidence(value: str) -> bool:
    text = _clean_source_signal_text(value)
    if re.search(
        r"\b(?:review|reviews|reviewer|customers?\s+(?:say|says|said|report(?:s|ed)?)|verified\s+buyer|stars?)\b|"
        r"고객\s*리뷰|구매\s*후기|리뷰에서|후기에서|평점|재구매|구매했|사용해\s*봤|써\s*봤",
        text,
        re.I,
    ):
        return True
    return bool(
        re.search(r"\bI\s+(?:bought|used|tried|love|liked|recommend)\b", text, re.I)
        or re.search(r"(?:직접|저는|제가|구매(?:해|했)|사용해\s*보)[^.!?。！？]{0,160}(?:촉촉|편안|만족|좋(?:아|았|습니))", text)
        or re.search(r"(?:좋아요|좋았습니다|마음에\s*들|만족(?:해|했|합니다)|느낌이네요|같아요)\s*[.!。]?$", text)
    )


def _has_ledger_explicit_usage_action(value: str) -> bool:
    """Match the planner's directive/action boundary, not mere timing words."""

    return bool(
        re.search(
            r"\b(?:apply|dispense|massage|lather|rinse|pat|press|spread|smooth|warm|take|pump|spray|spritz|dot|tap)\b|"
            r"(?:^|[.;,]\s*)then\s+use\b|\buse\s+(?:morning|night|daily|twice|once|after|before|as|with|on|to)\b|"
            r"^\s*use\b",
            value,
            re.I,
        )
        or bool(
            re.search(
                r"적당량|손에|물과\s*함께|거품\s*내|거품내|얼굴에|문지르|미온수|헹구|화장솜|덜어|"
                r"펴\s*바르|펴\s*바릅|펴\s*발라|바르(?:고|며|듯|세요|십시오|기|면|는|도록)|바릅|"
                r"발라(?:주|주세요|줍니다|서|가며)|마사지(?:하듯|하[고여]|한\s*후|해|하세요|하며)|"
                r"흡수(?:시켜|시키|될\s*때까지|되도록|해\s*주세요|시킵)|마무리(?:해|하세요|합니다|하십시오)|"
                r"도포(?:해|하세요|합니다|하십시오|한\s*(?:뒤|후))|분사(?:를)?\s*(?:합니다|하세요|하십시오|해\s*주|한\s*후)|"
                r"뿌려\s*주|뿌려줍|뿌리세요|뿌리십시오|스프레이(?:를)?\s*(?:합니다|하세요|해)|"
                r"사용\s*(?:해|하세요|합니다|하십시오|할\s*때|하고|한\s*(?:뒤|후)|할\s*수)",
                value,
            )
        )
    )


def _is_metric_evidence_text(value: str) -> bool:
    """Port the broad metric-context guard used before benefit admission."""

    text = _clean_source_signal_text(value)
    has_metric = bool(
        re.search(
            r"%|\b\d+(?:\.\d+)?\s*(?:weeks?|days?|hours?|users?|participants?|women|men|subjects?|reviews?)\b|"
            r"\d+(?:\.\d+)?\s*배|임상|인체\s*적용|자가\s*평가|사용자|참여자|대상|clinical|study|"
            r"self-assess|instrumental|agreed|showed|改善|評価",
            text,
            re.I,
        )
    )
    starts_with_timing = bool(re.match(r"^(?:after|before|during)\s+\d+(?:\.\d+)?\s*(?:weeks?|days?|hours?)\b", text, re.I))
    korean_metric = bool(
        re.search(r"[가-힣]", text)
        and re.search(r"%|\d+(?:\.\d+)?\s*배", text)
        and (
            re.search(r"(?:\d+(?:\.\d+)?\s*(?:%|배).{0,40}(?:회복|개선|감소|증가)|(?:회복|개선|감소|증가).{0,40}\d+(?:\.\d+)?\s*(?:%|배))", text)
            or (
                re.search(r"(?:사용|도포|세정)\s*(?:전|직후|\d+(?:\.\d+)?\s*(?:시간|일|주)\s*후)|(?:\d+(?:\.\d+)?\s*(?:시간|일|주).{0,20})?(?:\d+\s*회\s*)?(?:사용|도포|측정)\s*후|\d+(?:\.\d+)?\s*(?:시간|일|주)\s*(?:후|동안|뒤)", text)
                and re.search(r"(?:임상|인체\s*적용|시험|테스트|결과|ex\s*vivo|in\s*vitro|Tape\s*Stripping|외부자극)", text, re.I)
            )
        )
    )
    return has_metric and (starts_with_timing or korean_metric or not _has_ledger_explicit_usage_action(text))


def _is_usage_instruction_evidence(value: str) -> bool:
    text = _clean_source_signal_text(value)
    if (
        len(text) < 8
        or len(text) > 260
        or _is_question_like_source_text(text)
        or _is_safety_or_suitability_caution(text)
        or re.search(r"사용\s*적합|테스트를\s*완료|임산부|영유아|어린이|논코메도제닉", text, re.I)
    ):
        return False
    return _has_ledger_explicit_usage_action(text)


def _is_benefit_evidence_role(value: str) -> bool:
    text = _clean_source_signal_text(value)
    concise = bool(
        text
        and len(text) <= 90
        and not re.search(r"[.。]", text)
        and not _is_broken_source_fragment(text)
        and not _is_metric_evidence_text(text)
        and not re.fullmatch(r"(?:benefits?|효능|효과|장점|ベネフィット)", text, re.I)
        and re.search(
            r"benefit|hydration|moisture|firm|elastic|barrier|bright|soothing|comfort|wrinkle|fine lines?|plump|lifting|"
            r"hypoallergenic|low[-\s]?irritation|수분|보습|장벽|탄력|진정|피부결|쿨링|붉은기|저자극|속수분|유수분|保湿|うるおい|ハリ|バリア",
            text,
            re.I,
        )
    )
    if concise:
        return True
    if (
        not text
        or len(text) > 320
        or _is_full_ingredient_list(text)
        or _is_broken_source_fragment(text)
        or re.fullmatch(r"(?:benefits?|효능|효과|장점|ベネフィット)", text, re.I)
    ):
        return False
    if _has_direct_source_benefit_predicate(text):
        return True
    return bool(
        re.search(
            r"benefit|effect|support|help|improve|care|hydration|moisture|barrier|firm|elastic|texture|"
            r"효능|효과|개선|케어|보습|수분|장벽|탄력|피부결",
            text,
            re.I,
        )
    )


def _has_direct_source_benefit_predicate(value: str) -> bool:
    """Recognize a source-stated benefit without assuming a skin-care category.

    The intake can receive hair, body, and other PDPs alongside skin care.
    A complete declarative predicate (rather than a category keyword) is the
    safe common admission rule: it retains a source statement such as
    ``Supports hair softness.`` while the caller's role guards still exclude
    instructions, reviews, commerce, safety, and metrics.
    """

    text = _clean_source_signal_text(value)
    if (
        not text
        or _is_question_like_source_text(text)
        or _is_broken_source_fragment(text)
        or _is_commerce_quantity_or_offer_text(text)
        or _is_safety_or_suitability_caution(text)
        or _is_customer_experience_evidence(text)
        or _is_usage_instruction_evidence(text)
        or _is_metric_evidence_text(text)
        or re.search(
            r"\b(?:right|suitable|ideal|best|recommended)\s+for\s+you\b|"
            r"(?:무료\s*배송|배송|반품|환불|쿠폰|적합(?:한|성)|추천(?:할|하는)?)",
            text,
            re.I,
        )
        or re.search(r"(?:매일|아침|저녁)\s*(?:사용|도포|바르)|사용하면|사용\s*(?:후|시|할\s*때)", text)
    ):
        return False
    english = re.search(
        r"(?:^|\b)(?:(?:does\s+not|doesn't)\s+)?(?:supports?|helps?|improves?|reduces?|reduce|provides?|promotes?|offers?|maintains?|restores?|"
        r"protects?|strengthens?|soothes?|calms?|enhances?)\s+[a-z0-9]",
        text,
        re.I,
    )
    korean = re.search(
        r"(?:도움을?\s*(?:줍니다|줘요|줌)|돕습니다|개선(?:에|을)?\s*도움|향상(?:에|을)?\s*도움|"
        r"완화(?:에|를)?\s*도움|보호(?:에|를)?\s*도움|유지하도록\s*돕)",
        text,
    )
    return bool(english or korean)


def _is_effect_signal(value: str) -> bool:
    text = _clean_source_signal_text(value)
    return bool(
        len(text) <= 320
        and not _is_commerce_quantity_or_offer_text(text)
        and not _is_safety_or_suitability_caution(text)
        and not _is_customer_experience_evidence(text)
        and not _is_usage_instruction_evidence(text)
        and not re.fullmatch(r"(?:effect|effects|result|results|benefit|benefits|효과|효능|개선|결과)", text, re.I)
        and bool(
            re.search(
                r"effect|result|improve|supports?|hydration|moisture|barrier|soothing|firm|elastic|texture|"
                r"cooling|sebum|효과|효능|개선|수분|보습|장벽|진정|탄력|피부결|쿨링|피지|유분|속수분|유수분|保湿|効果|キメ",
                text,
                re.I,
            )
        )
    )


def _is_audience_evidence(value: str) -> bool:
    text = _clean_source_signal_text(value)
    if (
        not text
        or _is_safety_or_suitability_caution(text)
        or _is_commerce_quantity_or_offer_text(text)
        or _is_customer_experience_evidence(text)
        or _is_usage_instruction_evidence(text)
        or re.search(r"\b(?:not|never|avoid|do\s+not)\b", text, re.I)
    ):
        return False
    if re.fullmatch(r"(?:sensitive|dry|oily|combination|normal|mature|all)\s+skin(?:\s+types?)?", text, re.I):
        return True
    if re.fullmatch(r"(?:민감|건조|건성|지성|복합성?|중성|성숙)\s*피부", text):
        return True
    return bool(
        re.fullmatch(
            r"(?:(?:sensitive|dry|oily|combination|normal|mature)\s*(?:or|and|,)\s*)+(?:sensitive|dry|oily|combination|normal|mature)\s+skin(?:\s+types?)?",
            text,
            re.I,
        )
        or re.search(
            r"suitable\s+for|recommended\s+for|ideal\s+for|designed\s+for|formulated\s+for|developed\s+for|"
            r"intended\s+for|made\s+for|for\s+(?:people|customers|skin)|"
            r"all\s+skin\s+types|normal\s+and\s+combination\s+skin|"
            r"(?:(?:고객|피부)에?게\s*(?:적합|추천)|(?:위한|고려한)\s*(?:제품|포뮬러|케어)|(?:민감|건조|건성|지성|복합성?|중성)\s*피부)",
            text,
            re.I,
        )
    )


def infer_pdp_evidence_roles_for_ledger(value: str) -> dict[str, Any]:
    """Classify a source unit with the retained TypeScript role precedence.

    This drives both source-field routing and the public evidence ledger.  In
    particular, a word such as ``use`` is not enough to turn a clinical or
    safety statement into a HowTo instruction, and a size/price token is
    commerce rather than an untyped source atom.
    """

    text = _clean_source_signal_text(value)
    if not text:
        return {"primaryRole": "source", "roles": ["source"], "canLinkIngredientToOutcome": False}
    if _is_question_like_source_text(text) or re.search(r"[?？]", text):
        return {"primaryRole": "faq", "roles": ["faq"], "canLinkIngredientToOutcome": False}

    commerce_only = _is_commerce_quantity_or_offer_text(text)
    safety = _is_safety_or_suitability_caution(text)
    review = _is_customer_experience_evidence(text)
    usage = not safety and not review and not commerce_only and _is_usage_instruction_evidence(text)
    metric = not commerce_only and _is_atomic_metric_evidence(text)
    ingredient = not commerce_only and not review and _is_ingredient_signal(text) and _is_role_coherent_ingredient_evidence(text)
    standalone_named_ingredient = ingredient and _is_named_biochemical_or_formula(text)
    benefit = (
        not standalone_named_ingredient
        and not safety
        and not review
        and not usage
        and not commerce_only
        and not metric
        and _is_benefit_evidence_role(text)
    )
    effect = (
        not standalone_named_ingredient
        and not safety
        and not review
        and not usage
        and not commerce_only
        and _is_effect_signal(text)
    )
    audience = _is_audience_evidence(text)

    roles = [
        *( ["commerce"] if commerce_only else []),
        *( ["safety"] if safety else []),
        *( ["review"] if review else []),
        *( ["usage"] if usage else []),
        *( ["metric"] if metric else []),
        *( ["ingredient"] if ingredient else []),
        *( ["benefit"] if benefit else []),
        *( ["effect"] if effect else []),
        *( ["audience"] if audience else []),
    ]
    can_link_ingredient_to_outcome = ingredient and (benefit or effect) and not metric and not review and not safety
    primary_order = (
        "faq",
        "review",
        "safety",
        "usage",
        "commerce",
        "metric",
        *( ("ingredient",) if can_link_ingredient_to_outcome else ()),
        "audience",
        "benefit",
        "effect",
        "ingredient",
    )
    primary = next((role for role in primary_order if role in roles), "source")
    return {
        "primaryRole": primary,
        "roles": roles or ["source"],
        "canLinkIngredientToOutcome": can_link_ingredient_to_outcome,
    }


def infer_pdp_evidence_roles(value: str) -> dict[str, Any]:
    """Return the normalizer's existing role-routing assessment.

    The normalizer retains its conservative admission classifier while content
    planning uses the fuller retained-runtime classifier above for atomic
    public evidence.  Keeping these phases separate avoids changing the
    already-canonical normalized product merely to improve ledger provenance.
    """

    text = _clean(value)
    if not text:
        return {"primaryRole": "source", "roles": ["source"], "canLinkIngredientToOutcome": False}
    roles: list[str] = []
    if "?" in text or "？" in text:
        roles.append("faq")
    if _COMMERCE.search(text):
        roles.append("commerce")
    if _REVIEW.search(text):
        roles.append("review")
    if _is_atomic_metric_evidence(text) and "review" not in roles:
        roles.append("metric")
    if (
        re.search(
            r"ingredient|active|formula|technology|complex|blend|extract|herb|"
            r"전성분|성분표|세라마이드|캡슐|글루코노락톤|pha|"
            r"retinol|niacinamide|ceramide|peptide|hyaluronic|ginseng|panthenol",
            text,
            re.I,
        )
        and "review" not in roles
    ):
        roles.append("ingredient")
    if re.search(r"apply|use|direction|usage|도포|사용|바르", text, re.I) and "review" not in roles:
        roles.append("usage")
    if (
        _has_direct_source_benefit_predicate(text)
        or re.search(
        r"benefit|hydration|moisture|firm|elastic|barrier|bright|soothing|comfort|wrinkle|fine lines?|plump|lifting|"
        r"hypoallergenic|low[-\s]?irritation|수분|보습|장벽|탄력|진정|피부결|쿨링|붉은기|저자극|속수분|유수분|保湿|うるおい|ハリ|バリア",
        text,
        re.I,
        )
    ) and not {"review", "commerce", "usage", "metric"}.intersection(roles) and not _is_safety_or_suitability_caution(text):
        roles.append("benefit")
    if (
        _is_effect_signal(text)
        and not {"review", "commerce", "usage", "metric"}.intersection(roles)
        and not _is_safety_or_suitability_caution(text)
    ):
        roles.append("effect")
    if re.search(r"sensitive|dry skin|oily skin|민감|건성|지성", text, re.I):
        roles.append("audience")
    if not roles:
        roles.append("source")
    primary_order = (
        "faq",
        "commerce",
        "review",
        "usage",
        "metric",
        "ingredient",
        "benefit",
        "effect",
        "audience",
        "source",
    )
    primary = next(role for role in primary_order if role in roles)
    return {
        "primaryRole": primary,
        "roles": roles,
        "canLinkIngredientToOutcome": "ingredient" in roles and any(role in roles for role in ("benefit", "effect")),
    }


def is_attributed_measurement_statement(text: str) -> bool:
    return _is_atomic_metric_evidence(text) and bool(
        re.search(r"(?:test|study|clinical|participants?|after|weeks?|시험|임상|사용 후|주 후)", text, re.I)
    )


def is_compressed_multi_claim_metric_block(value: str) -> bool:
    """Recognize several measured claims flattened into one unpunctuated run.

    A decimal point is not the end of a sentence.  Counting it as one made
    every panel of decimal figures -- the common shape of a clinical results
    image -- read as many sentences and slip past this check, so the block was
    neither rejected as one atomic metric nor read back as the rows it states.
    """

    return (
        len(re.findall(r"(?:\d+(?:\.\d+)?\s?%|\d+\s?(?:주|일|weeks?|days?))", value, re.I)) >= 3
        and len(re.split(r"(?<!\d)[.!?。！？]|[.!?。！？](?!\d)", value)) <= 2
    )


# Public aliases retain the Node naming convention for direct ports.
normalizePdpProduct = normalize_pdp_product
sanitizePdpSemanticFacts = sanitize_pdp_semantic_facts
inferPdpEvidenceRoles = infer_pdp_evidence_roles
dedupePdpUsageInstructions = dedupe_pdp_usage_instructions
isAttributedMeasurementStatement = is_attributed_measurement_statement
isCompressedMultiClaimMetricBlock = is_compressed_multi_claim_metric_block


__all__ = [
    "dedupe_pdp_usage_instructions",
    "dedupePdpUsageInstructions",
    "infer_pdp_evidence_roles",
    "inferPdpEvidenceRoles",
    "is_attributed_measurement_statement",
    "isAttributedMeasurementStatement",
    "is_compressed_multi_claim_metric_block",
    "isCompressedMultiClaimMetricBlock",
    "normalize_pdp_product",
    "normalizePdpProduct",
    "sanitize_pdp_semantic_facts",
    "sanitizePdpSemanticFacts",
]
