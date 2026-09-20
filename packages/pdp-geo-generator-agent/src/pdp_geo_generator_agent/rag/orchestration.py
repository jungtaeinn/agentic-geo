"""Generation-level RAG orchestration shared by the service and eval callers.

The local retriever intentionally stays small and provider-neutral.  This
module owns the TypeScript generator's second layer: brand scoping, per-query
candidate expansion, protected coverage seats, controlled full-document
hydration, and safe optional reranking.  Keeping that layer outside the
renderer makes its prompt context inspectable and deterministic.
"""

from __future__ import annotations

import asyncio
import inspect
import math
import re
import unicodedata
from collections.abc import Mapping, Sequence
from typing import Any, cast

from .._json import as_dict, as_list, clean_text, strings
from .manifest import PDP_GEO_GENERATOR_RAG_MANIFEST

_STRATEGIC_KINDS = {"field-contracts", "geo-research", "cep", "eeat"}
_COVERAGE_KIND_ORDER = (
    "field-contracts",
    "geo-research",
    "evidence-cards",
    "eeat",
    "cep",
    "schema",
    "best-practice",
    "locale",
    "terminology",
    "official-docs",
)
_STRATEGIC_COVERAGE_DOCUMENTS: tuple[dict[str, str], ...] = (
    {
        "kind": "field-contracts",
        "document": "content-field-contracts_v1.md",
        "query": (
            "Canonical PDP field contracts for description composition and separation, FAQ, HowTo, schema safety, "
            "public wording, and evidence routing."
        ),
        "reason": "Ensure the canonical field contracts are present when the documents that explain them rank higher.",
    },
    {
        "kind": "schema",
        "document": "schema-org-product_v2.md",
        "query": (
            "Schema.org Product FAQPage HowTo WebPage BreadcrumbList compatibility, field requirements, JSON-LD graph "
            "constraints, and structured data validation."
        ),
        "reason": "Ensure schema.org field compatibility is present when strategy chunks rank higher.",
    },
    {
        "kind": "geo-research",
        "document": "geo-research_v3.md",
        "query": (
            "GEO research guidance for answer-ready product facts, schema/content alignment, retrieval and query planning, "
            "FAQ and HowTo answerability."
        ),
        "reason": "Ensure GEO research strategy is present when general retrieval ranks operational chunks higher.",
    },
    {
        "kind": "cep",
        "document": "cep_v1.md",
        "query": (
            "Category Entry Point guidance for customer needs, routine moments, review questions, FAQ updates, HowToUse "
            "updates, and PDP field mapping."
        ),
        "reason": "Ensure CEP customer-entry strategy is present when general retrieval ranks operational chunks higher.",
    },
    {
        "kind": "eeat",
        "document": "eeat_v1.md",
        "query": (
            "E-E-A-T trust-first claim safety, evidence hierarchy, customer experience, expertise, authoritativeness, "
            "and partial update query planning."
        ),
        "reason": "Ensure E-E-A-T claim-safety strategy is present when general retrieval ranks operational chunks higher.",
    },
    {
        "kind": "evidence-cards",
        "document": "evidence/geo-research-cards_v1.md",
        "query": (
            "Research evidence cards recording each study's finding, sample size, publication status, and provenance for "
            "claim support and E-E-A-T evidence hierarchy."
        ),
        "reason": "Ensure the canonical research-evidence source is present when the documents that cite it rank higher.",
    },
    {
        "kind": "official-docs",
        "document": "official-ai-search-platform-docs_v1.md",
        "query": (
            "Official AI search platform guidance for retrieval, hybrid search, reranking, embeddings, grounding, "
            "structured data eligibility, and helpful product content."
        ),
        "reason": "Ensure official provider/search guidance is present when local policy chunks rank higher.",
    },
    {
        "kind": "best-practice",
        "document": "best-practice_v1.md",
        "query": (
            "PDP GEO best practice for customer-facing sentence tone, vocabulary, cadence, natural evidence transitions, "
            "field evidence contracts, Product and WebPage description separation, FAQ, HowTo, and schema alignment."
        ),
        "reason": "Ensure the active BestPractice public-copy voice and field-contract guidance are present when strategy chunks rank higher.",
    },
    {
        "kind": "locale",
        "document": "locale-expression-guidelines_v1.md",
        "query": (
            "Locale expression guidance for natural market wording, public copy quality, terminology preservation, and "
            "unsupported wording avoidance."
        ),
        "reason": "Ensure locale expression guidance is present when strategy chunks rank higher.",
    },
    {
        "kind": "terminology",
        "document": "locale-terminology-map_v1.json",
        "query": "Locale terminology map for benefit, ingredient, product type, and market-natural public wording.",
        "reason": "Ensure terminology mapping is present when strategy chunks rank higher.",
    },
)
_BRAND_IDENTITY_COVERAGE_REASON = (
    "Ensure the matched target-brand identity document is available to generation without adding other brand identity documents."
)
_BRAND_BEST_PRACTICE_COVERAGE_REASON = (
    "Ensure the matched target-brand best practice overlay reaches generation alongside the default best practice document."
)


def normalize_pdp_geo_rag_path(name: str) -> str:
    return name.replace("\\", "/")


def infer_pdp_geo_brand_rag_scope(
    product: Mapping[str, object], hints: Mapping[str, object] | None = None
) -> dict[str, Any]:
    """Identify the sole brand overlay family allowed into a generation run."""

    value = " ".join(
        part
        for part in (
            clean_text(as_dict(hints).get("brand")),
            clean_text(product.get("brand")),
            clean_text(product.get("name")),
        )
        if part
    )
    signal = re.sub(r"\s+", "", unicodedata.normalize("NFKC", value).lower())
    slug = (
        "sample_botanics"
        if re.search(r"(?:sample[_-]?botanics|fieldnote(?:examplelabs)?|demobotanica)", signal)
        else "sample_derma"
        if re.search(r"(?:sample[_-]?derma|별모래테스트랩|byeolmorae|demoderma)", signal)
        else None
    )
    if not slug:
        return {"overlayDocuments": []}
    identities = _manifest_names("brandIdentities")
    practices = _manifest_names("brandBestPractices")
    locale_guides = _manifest_names("brandLocaleExpressionGuidelines")
    terminology = _manifest_names("brandLocaleTerminologyMaps")
    return {
        "slug": slug,
        "identityDocument": identities.get(slug),
        "bestPracticeDocument": practices.get(slug),
        "overlayDocuments": [
            name
            for name in (practices.get(slug), locale_guides.get(slug), terminology.get(slug))
            if name
        ],
    }


def infer_pdp_geo_brand_overlay_documents(
    product: Mapping[str, object], hints: Mapping[str, object] | None = None
) -> list[str]:
    return list(cast(list[str], infer_pdp_geo_brand_rag_scope(product, hints)["overlayDocuments"]))


def scope_pdp_geo_brand_rag_documents(
    documents: Sequence[Mapping[str, Any]], product: Mapping[str, object], hints: Mapping[str, object] | None = None
) -> list[dict[str, Any]]:
    """Retain common corpus documents plus the one brand selected by product signals."""

    scope = infer_pdp_geo_brand_rag_scope(product, hints)
    slug = scope.get("slug")
    result: list[dict[str, Any]] = []
    for document in documents:
        name = normalize_pdp_geo_rag_path(clean_text(document.get("name")))
        if name.startswith("brands/"):
            parts = name.split("/")
            if not slug or len(parts) < 3 or parts[1] != slug:
                continue
        result.append(dict(document))
    return result


def merge_pdp_geo_rag_documents(documents: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Apply the legacy last-write-wins document merge without changing order."""

    values: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for raw in documents:
        document = dict(raw)
        name, content = clean_text(document.get("name")), clean_text(document.get("content"))
        if not name or not content:
            continue
        if name not in values:
            order.append(name)
        values[name] = document
    return [values[name] for name in order]


async def assemble_pdp_geo_rag_chunks(input_: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Retrieve expanded per-subquery candidates and fill strategic coverage gaps."""

    from .retrieval import retrieve_pdp_geo_rag_chunks

    query_plan = as_dict(input_.get("queryPlan"))
    product = as_dict(input_.get("product"))
    locale, market = clean_text(input_.get("locale")) or "en-US", clean_text(input_.get("market")) or None
    settings = dict(as_dict(input_.get("settings")))
    documents = [as_dict(item) for item in as_list(input_.get("documents")) if as_dict(item)]
    runtime = {
        "apiKey": input_.get("apiKey"),
        "customRetriever": input_.get("customRetriever"),
        "customUrlResolver": input_.get("customUrlResolver"),
        "customEmbedder": input_.get("customEmbedder"),
    }
    candidates_settings = dict(settings)
    candidates_settings["maxChunks"] = max(_positive_int(settings.get("maxChunks"), 14), 24)

    async def retrieve_query(raw: Mapping[str, Any]) -> list[dict[str, Any]]:
        query = as_dict(raw)
        chunks = await retrieve_pdp_geo_rag_chunks(
            {
                "query": clean_text(query.get("query")),
                "queryIntents": as_list(query.get("intents")),
                "queryFieldTargets": as_list(query.get("fieldTargets")),
                "product": product,
                "locale": locale,
                "market": market,
                "documents": documents,
                "settings": candidates_settings,
            },
            runtime,
        )
        return [
            {
                **chunk,
                "metadata": {
                    **as_dict(chunk.get("metadata")),
                    "queryPlanTarget": clean_text(query.get("target")),
                    "queryPlanReason": clean_text(query.get("reason")),
                },
                "score": boost_chunk_for_subquery(
                    chunk,
                    [str(item) for item in as_list(query.get("fieldTargets")) if isinstance(item, str)],
                    [str(item) for item in as_list(query.get("intents")) if isinstance(item, str)],
                ),
            }
            for chunk in chunks
        ]

    primary_groups = await asyncio.gather(
        *(retrieve_query(as_dict(raw)) for raw in as_list(query_plan.get("queries")) if as_dict(raw))
    )
    primary = _merge_chunks([chunk for group in primary_groups for chunk in group])
    scope = infer_pdp_geo_brand_rag_scope(product)
    # ``infer_pdp_geo_brand_rag_scope`` deliberately uses an internal
    # ``overlayDocuments`` name.  The final-context selector's public option
    # is ``brandOverlayDocuments`` (as in retained ``agent.ts``); map it here
    # before coverage checks so an already-retrieved brand overlay is protected
    # instead of retrieved a second time as artificial coverage.
    preliminary = select_final_rag_chunks(
        primary,
        _positive_int(settings.get("maxChunks"), 14),
        {"brandOverlayDocuments": as_list(scope.get("overlayDocuments"))},
    )
    coverage = await _retrieve_coverage_chunks(
        preliminary,
        product,
        locale,
        market,
        documents,
        settings,
        runtime,
        scope,
    )
    merged = _merge_chunks([*primary, *coverage])
    identity = clean_text(scope.get("identityDocument"))
    if identity:
        merged = [_mark_brand_identity(chunk, identity) for chunk in merged]
    return merged


async def _retrieve_coverage_chunks(
    existing: Sequence[Mapping[str, Any]],
    product: Mapping[str, Any],
    locale: str,
    market: str | None,
    documents: Sequence[Mapping[str, Any]],
    settings: Mapping[str, Any],
    runtime: Mapping[str, Any],
    scope: Mapping[str, Any],
) -> list[dict[str, Any]]:
    from .retrieval import retrieve_pdp_geo_rag_chunks

    existing_sources = {normalize_pdp_geo_rag_path(clean_text(chunk.get("source"))) for chunk in existing}
    by_name = {normalize_pdp_geo_rag_path(clean_text(document.get("name"))): document for document in documents}

    async def retrieve_strategic(entry: Mapping[str, str]) -> list[dict[str, Any]]:
        name = entry["document"]
        if normalize_pdp_geo_rag_path(name) in existing_sources:
            return []
        document = _resolve_strategic_coverage_document(entry, documents, by_name)
        if not document:
            return []
        chunks = await retrieve_pdp_geo_rag_chunks(
            {
                "query": _strategic_coverage_query(entry["query"], product),
                "product": product,
                "locale": locale,
                "market": market,
                "documents": [document],
                "settings": {**settings, "maxChunks": 3, "scoreThreshold": 0},
            },
            runtime,
        )
        return [
            {
                **chunk,
                "kind": entry["kind"],
                "metadata": {
                    **as_dict(chunk.get("metadata")),
                    "queryPlanTarget": "strategicCoverage",
                    "queryPlanReason": entry["reason"],
                },
                "score": _score(chunk),
            }
            for chunk in chunks
            if normalize_pdp_geo_rag_path(clean_text(chunk.get("source"))) == normalize_pdp_geo_rag_path(name)
        ]

    async def retrieve_brand_coverage(
        name: str, target: str, query: str, reason: str
    ) -> list[dict[str, Any]]:
        if not name or normalize_pdp_geo_rag_path(name) in existing_sources:
            return []
        document = by_name.get(normalize_pdp_geo_rag_path(name))
        if not document:
            return []
        chunks = await retrieve_pdp_geo_rag_chunks(
            {
                "query": query,
                "product": product,
                "locale": locale,
                "market": market,
                "documents": [document],
                "settings": {**settings, "maxChunks": 3, "scoreThreshold": 0},
            },
            runtime,
        )
        return [
            {
                **chunk,
                "metadata": {
                    **as_dict(chunk.get("metadata")),
                    "queryPlanTarget": target,
                    "queryPlanReason": reason,
                },
                "score": max(_score(chunk), 0.93),
            }
            for chunk in chunks
            if normalize_pdp_geo_rag_path(clean_text(chunk.get("source"))) == normalize_pdp_geo_rag_path(name)
        ]

    identity = clean_text(scope.get("identityDocument"))
    best_practice = clean_text(scope.get("bestPracticeDocument"))
    groups = await asyncio.gather(
        *(retrieve_strategic(entry) for entry in _STRATEGIC_COVERAGE_DOCUMENTS),
        retrieve_brand_coverage(
            identity,
            "brandIdentityCoverage",
            _brand_identity_coverage_query(product),
            _BRAND_IDENTITY_COVERAGE_REASON,
        ),
        retrieve_brand_coverage(
            best_practice,
            "brandBestPracticeCoverage",
            _brand_best_practice_coverage_query(product),
            _BRAND_BEST_PRACTICE_COVERAGE_REASON,
        ),
    )
    return [chunk for group in groups for chunk in group]


def _strategic_coverage_query(strategy: str, product: Mapping[str, Any]) -> str:
    """Build the source-retained strategic coverage request (agent.ts:1002-1010)."""

    reviews = as_dict(product.get("reviews"))
    parts = [
        strategy,
        f"Product: {clean_text(product.get('name'))}.",
        _coverage_line("Category", [clean_text(product.get("category"))]),
        _coverage_line("Benefits", strings(product.get("benefits"))[:4]),
        _coverage_line("Ingredients", strings(product.get("ingredients"))[:4]),
        _coverage_line("Usage", strings(product.get("usage"))[:2], trailing_period=False, separator=" "),
        _coverage_line("Review keywords", strings(reviews.get("keywords"))[:4]),
    ]
    return " ".join(part for part in parts if part)


def _brand_identity_coverage_query(product: Mapping[str, Any]) -> str:
    """Build the source-retained identity-only coverage request (agent.ts:1066-1075)."""

    reviews = as_dict(product.get("reviews"))
    parts = [
        (
            "Target brand identity for PDP GEO generation: brand image, tone, vocabulary, mood, personality, customer "
            "entry points, and claim-safety boundaries. Use official articles, patents, or research papers from this "
            "document only as brand-level context, not product evidence."
        ),
        f"Product: {clean_text(product.get('name'))}.",
        _coverage_line("Brand", [clean_text(product.get("brand"))]),
        _coverage_line("Category", [clean_text(product.get("category"))]),
        _coverage_line("Benefits", strings(product.get("benefits"))[:4]),
        _coverage_line("Ingredients", strings(product.get("ingredients"))[:4]),
        _coverage_line("Review keywords", strings(reviews.get("keywords"))[:4]),
    ]
    return " ".join(part for part in parts if part)


def _brand_best_practice_coverage_query(product: Mapping[str, Any]) -> str:
    """Build the source-retained brand-overlay request (agent.ts:1151-1161)."""

    reviews = as_dict(product.get("reviews"))
    parts = [
        (
            "Brand-specific best practice overlay for PDP GEO generation: brand-unique public copy tone, description "
            "composition adjustments, claim wording boundaries, FAQ and HowTo question patterns, and locale phrasing "
            "that extend the default best practice document."
        ),
        f"Product: {clean_text(product.get('name'))}.",
        _coverage_line("Brand", [clean_text(product.get("brand"))]),
        _coverage_line("Category", [clean_text(product.get("category"))]),
        _coverage_line("Benefits", strings(product.get("benefits"))[:4]),
        _coverage_line("Ingredients", strings(product.get("ingredients"))[:4]),
        _coverage_line("Usage", strings(product.get("usage"))[:2], trailing_period=False, separator=" "),
        _coverage_line("Review keywords", strings(reviews.get("keywords"))[:4]),
    ]
    return " ".join(part for part in parts if part)


def _coverage_line(label: str, values: Sequence[str], *, trailing_period: bool = True, separator: str = ", ") -> str:
    filtered = [value for value in values if value]
    if not filtered:
        return ""
    suffix = "." if trailing_period else ""
    return f"{label}: {separator.join(filtered)}{suffix}"


def _resolve_strategic_coverage_document(
    entry: Mapping[str, str],
    documents: Sequence[Mapping[str, Any]],
    by_name: Mapping[str, Mapping[str, Any]],
) -> Mapping[str, Any] | None:
    """Mirror TS fallback to a matching scoped policy overlay when needed."""

    document_name = entry["document"]
    exact = by_name.get(normalize_pdp_geo_rag_path(document_name))
    if exact is not None:
        return exact
    replacements = set(_brand_scoped_replacement_document_names(document_name))
    return next(
        (
            document
            for document in documents
            if normalize_pdp_geo_rag_path(clean_text(document.get("name"))) in replacements
        ),
        None,
    )


def _brand_scoped_replacement_document_names(default_document_name: str) -> list[str]:
    names = _manifest_names("documents")
    if default_document_name == names.get("bestPractice"):
        return list(_manifest_names("brandBestPractices").values())
    if default_document_name == names.get("localeExpressionGuidelines"):
        return list(_manifest_names("brandLocaleExpressionGuidelines").values())
    if default_document_name == names.get("localeTerminologyMap"):
        return list(_manifest_names("brandLocaleTerminologyMaps").values())
    return []


async def apply_custom_pdp_geo_rerank(
    chunks: Sequence[Mapping[str, Any]], query: str, reranker: object | None
) -> list[dict[str, Any]]:
    """Use a custom reranker only when it returns a non-empty usable sequence."""

    baseline = [dict(chunk) for chunk in chunks]
    if reranker is None or not baseline:
        return baseline
    method = getattr(reranker, "rerank", None)
    if not callable(method):
        return baseline
    try:
        value = method({"query": query, "chunks": baseline})
        result = await value if inspect.isawaitable(value) else value
    except Exception:
        return baseline
    if not isinstance(result, Sequence) or isinstance(result, str | bytes | bytearray):
        return baseline
    rows: list[dict[str, Any]] = [
        dict(cast(Mapping[str, Any], item)) for item in cast(Sequence[object], result) if isinstance(item, Mapping)
    ]
    if not rows:
        return baseline
    return [{**row, "metadata": {**as_dict(row.get("metadata")), "reranker": "custom"}} for row in rows]


def hydrate_selected_pdp_geo_rag_documents(
    selected: Sequence[Mapping[str, Any]], documents: Sequence[Mapping[str, Any]], settings: Mapping[str, Any]
) -> list[dict[str, Any]]:
    hydration = as_dict(settings.get("fullDocumentHydration"))
    if hydration.get("enabled") is False:
        return []
    strategic_only = hydration.get("strategicOnly") is not False
    maximum = _positive_int(hydration.get("maxDocuments"), 4)
    by_name = {normalize_pdp_geo_rag_path(clean_text(row.get("name"))): row for row in documents}
    grouped: dict[str, list[Mapping[str, Any]]] = {}
    for chunk in selected:
        if strategic_only and clean_text(chunk.get("kind")) not in _STRATEGIC_KINDS:
            continue
        source = normalize_pdp_geo_rag_path(clean_text(chunk.get("source")))
        if source:
            grouped.setdefault(source, []).append(chunk)
    result: list[dict[str, Any]] = []
    for source, chunks in grouped.items():
        document = by_name.get(source)
        if not document:
            continue
        first = chunks[0]
        titles = _unique_strings(clean_text(chunk.get("title")) for chunk in chunks)
        result.append(
            {
                "source": source,
                "version": document.get("version"),
                "kind": first.get("kind"),
                "hydrationMode": "controlled-full-document",
                "selectedChunkTitles": titles,
                "content": document.get("content"),
            }
        )
        if len(result) >= maximum:
            break
    return result


def select_final_rag_chunks(
    chunks: Sequence[Mapping[str, Any]], maximum: int, options: Mapping[str, Any] | None = None
) -> list[dict[str, Any]]:
    """Port the coverage-aware, diversity-aware final context selection rule."""

    limit = max(1, maximum)
    sorted_chunks = sorted((dict(chunk) for chunk in chunks), key=_score, reverse=True)
    overlays = {
        normalize_pdp_geo_rag_path(str(item))
        for item in as_list(as_dict(options).get("brandOverlayDocuments"))
        if isinstance(item, str)
    }
    protected: list[dict[str, Any]] = []
    protected_sources: set[str] = set()
    for chunk in sorted_chunks:
        source = normalize_pdp_geo_rag_path(clean_text(chunk.get("source")))
        target = clean_text(as_dict(chunk.get("metadata")).get("queryPlanTarget"))
        if source and source not in protected_sources and (source in overlays or target in {"brandIdentityCoverage", "brandBestPracticeCoverage"}):
            protected.append(chunk)
            protected_sources.add(source)
    selected = list(protected)
    keys = {_chunk_key(chunk) for chunk in selected}
    effective_limit = limit + len(protected)
    for kind in _COVERAGE_KIND_ORDER:
        if len(selected) >= effective_limit:
            break
        canonical = _canonical_document_for_kind(kind)
        choices = [
            chunk
            for chunk in sorted_chunks
            if _chunk_key(chunk) not in keys and clean_text(chunk.get("kind")) == kind and _carries_content_guidance(chunk)
        ]
        candidate = next(
            (
                chunk
                for chunk in choices
                if canonical and normalize_pdp_geo_rag_path(clean_text(chunk.get("source"))) == canonical
            ),
            None,
        ) or (choices[0] if choices else None)
        if candidate is None:
            candidate = next(
                (
                    chunk
                    for chunk in sorted_chunks
                    if _chunk_key(chunk) not in keys and clean_text(chunk.get("kind")) == kind
                ),
                None,
            )
        if candidate is not None:
            selected.append(candidate)
            keys.add(_chunk_key(candidate))
    while len(selected) < effective_limit:
        candidate = _select_next_diverse_chunk(sorted_chunks, selected, keys)
        if candidate is None:
            break
        selected.append(candidate)
        keys.add(_chunk_key(candidate))
    return sorted(selected, key=_score, reverse=True)


def boost_chunk_for_subquery(chunk: Mapping[str, Any], field_targets: Sequence[str], intents: Sequence[str]) -> float:
    chunk_targets = set(_chunk_values(chunk, "fieldTargets"))
    chunk_intents = set(_chunk_values(chunk, "intents", "sectionIntents"))
    return min(1.0, _score(chunk) + (0.08 if any(value in chunk_targets for value in field_targets) else 0) + (0.04 if any(value in chunk_intents for value in intents) else 0))


def create_pdp_geo_rag_usage_diagnostics(
    chunks: Sequence[Mapping[str, Any]], reasoning: Mapping[str, Any]
) -> list[dict[str, Any]]:
    by_source: dict[str, Mapping[str, Any]] = {}
    for chunk in chunks:
        source, title = clean_text(chunk.get("source")), clean_text(chunk.get("title"))
        # Preserve the TypeScript lookup priority: a title-qualified source
        # resolves before the document-level fallback when one document has
        # several selected sections.
        for key in (f"{source}#{title}" if source and title else "", source):
            if key and key not in by_source:
                by_source[key] = chunk
    output: list[dict[str, Any]] = []
    for raw in as_list(reasoning.get("decisions")):
        decision = as_dict(raw)
        references: list[dict[str, Any]] = []
        for source in (clean_text(item) for item in as_list(decision.get("ragSources"))):
            chunk = by_source.get(source)
            if not chunk:
                continue
            fields = _chunk_values(chunk, "fieldTargets")
            references.append(
                {
                    "source": chunk.get("source"),
                    "title": chunk.get("title"),
                    "kind": chunk.get("kind"),
                    "intents": _chunk_values(chunk, "intents", "sectionIntents"),
                    "fieldTargets": fields,
                    "score": _wire_number(chunk.get("score")),
                    "usage": _describe_rag_usage(clean_text(decision.get("principle")), fields),
                    "excerpt": _compact_excerpt(clean_text(chunk.get("text"))),
                }
            )
        if decision.get("enabled") is True or references:
            output.append(
                {
                    "principle": decision.get("principle"),
                    "enabled": decision.get("enabled") is True,
                    "confidence": decision.get("confidence"),
                    "rationale": decision.get("rationale"),
                    "ragSources": [clean_text(item) for item in as_list(decision.get("ragSources")) if clean_text(item)],
                    "productEvidenceCount": len(as_list(decision.get("productEvidence"))),
                    "references": references,
                }
            )
    return output


def _manifest_names(key: str) -> dict[str, str]:
    return {str(name): str(value) for name, value in as_dict(PDP_GEO_GENERATOR_RAG_MANIFEST.get(key)).items()}


def _canonical_document_for_kind(kind: str) -> str | None:
    documents = _manifest_names("documents")
    key = {
        "field-contracts": "contentFieldContracts",
        "geo-research": "geoResearch",
        "evidence-cards": "geoResearchEvidenceCards",
        "eeat": "eeat",
        "cep": "cep",
        "schema": "schemaOrgProduct",
        "best-practice": "bestPractice",
        "locale": "localeExpressionGuidelines",
        "terminology": "localeTerminologyMap",
        "official-docs": "officialAiSearchPlatformDocs",
    }.get(kind)
    return documents.get(key) if key else None


def _mark_brand_identity(chunk: Mapping[str, Any], identity: str) -> dict[str, Any]:
    row = dict(chunk)
    if normalize_pdp_geo_rag_path(clean_text(row.get("source"))) != normalize_pdp_geo_rag_path(identity):
        return row
    metadata = as_dict(row.get("metadata"))
    row["metadata"] = {
        **metadata,
        "queryPlanTarget": "brandIdentityCoverage",
        "queryPlanReason": metadata.get("queryPlanReason") or "Ensure the matched target-brand identity document reaches generation.",
    }
    row["score"] = max(_score(row), 0.93)
    return row


def _merge_chunks(chunks: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    selected: dict[str, dict[str, Any]] = {}
    for raw in chunks:
        row = dict(raw)
        key = _chunk_key(row)
        if key not in selected or _score(row) > _score(selected[key]):
            selected[key] = row
    return sorted(selected.values(), key=_score, reverse=True)


def _carries_content_guidance(chunk: Mapping[str, Any]) -> bool:
    targets = _chunk_values(chunk, "fieldTargets")
    return not targets or any(target not in {"retrieval", "diagnostics"} for target in targets)


def _select_next_diverse_chunk(
    candidates: Sequence[Mapping[str, Any]], selected: Sequence[Mapping[str, Any]], keys: set[str]
) -> dict[str, Any] | None:
    best: dict[str, Any] | None = None
    best_score = -math.inf
    for raw in candidates:
        candidate = dict(raw)
        if _chunk_key(candidate) in keys:
            continue
        score = _score(candidate) - _chunk_redundancy_penalty(candidate, selected)
        if best is None or score > best_score:
            best, best_score = candidate, score
    return best


def _chunk_redundancy_penalty(candidate: Mapping[str, Any], selected: Sequence[Mapping[str, Any]]) -> float:
    total = 0.0
    for chunk in selected:
        total += 0.06 if clean_text(chunk.get("source")) == clean_text(candidate.get("source")) else 0
        total += 0.04 if clean_text(chunk.get("kind")) == clean_text(candidate.get("kind")) else 0
        total += _overlap_ratio(_chunk_values(candidate, "fieldTargets"), _chunk_values(chunk, "fieldTargets")) * 0.06
        total += _overlap_ratio(_chunk_values(candidate, "intents", "sectionIntents"), _chunk_values(chunk, "intents", "sectionIntents")) * 0.04
    return total


def _chunk_values(chunk: Mapping[str, Any], key: str, metadata_key: str | None = None) -> list[str]:
    direct = [clean_text(item) for item in as_list(chunk.get(key)) if clean_text(item)]
    if direct:
        return direct
    metadata = as_dict(chunk.get("metadata"))
    return [item.strip() for item in clean_text(metadata.get(metadata_key or key)).split(",") if item.strip()]


def _chunk_key(chunk: Mapping[str, Any]) -> str:
    return f"{clean_text(chunk.get('source'))}:{clean_text(chunk.get('title'))}:{clean_text(chunk.get('id'))}"


def _score(chunk: Mapping[str, Any]) -> float:
    value = chunk.get("score")
    return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else 0.0


def _overlap_ratio(left: Sequence[str], right: Sequence[str]) -> float:
    if not left or not right:
        return 0.0
    common = len(set(left).intersection(right))
    return common / math.sqrt(len(left) * len(right))


def _positive_int(value: object, default: int) -> int:
    return int(value) if isinstance(value, int) and value > 0 else default


def _unique_strings(values: Sequence[str] | Any) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        if value and value not in seen:
            seen.add(value)
            result.append(value)
    return result


def _describe_rag_usage(principle: str, fields: Sequence[str]) -> str:
    base = {
        "answer-ready FAQ": "FAQ 질문/답변 구성 근거",
        "stepwise HowTo": "HowTo 원문 단계의 적합성·보존 근거",
        "evidence-backed claims": "효능/성분 주장 근거와 과장 방지 기준",
        "target customer context": "고객 맥락과 PDP 설명 문장 구성 근거",
        "review-intent FAQ": "긍정/중립 리뷰 언어를 FAQ 사용감 의도로 재구성하는 근거",
    }
    targets = list(fields)[:4]
    suffix = f" · 대상: {', '.join(targets)}" if targets else ""
    return f"{base.get(principle, 'RAG reasoning')}{suffix}"


def _wire_number(value: object) -> int | float:
    """Serialize whole JavaScript numbers as JSON integers, like JSON.stringify."""

    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else 0


def _compact_excerpt(value: str) -> str:
    compact = re.sub(r"\s+", " ", value).strip()
    return f"{compact[:257]}..." if len(compact) > 260 else compact


inferPdpGeoBrandOverlayDocuments = infer_pdp_geo_brand_overlay_documents
scopePdpGeoBrandRagDocuments = scope_pdp_geo_brand_rag_documents
selectFinalRagChunks = select_final_rag_chunks
assemblePdpGeoRagChunks = assemble_pdp_geo_rag_chunks
hydrateSelectedPdpGeoRagDocuments = hydrate_selected_pdp_geo_rag_documents
applyCustomPdpGeoRerank = apply_custom_pdp_geo_rerank
createPdpGeoRagUsageDiagnostics = create_pdp_geo_rag_usage_diagnostics
