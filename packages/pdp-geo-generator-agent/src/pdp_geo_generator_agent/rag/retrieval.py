"""Local versioned PDP GEO RAG retrieval.

The implementation retains the TypeScript pipeline's deterministic hybrid
ranking: lexical similarity, hash/provider semantic similarity, reciprocal
rank fusion, typed routing boosts, and per-source diversity caps.
"""

from __future__ import annotations

import inspect
import ipaddress
import json
import math
import re
import weakref
from collections.abc import Callable, Iterable, Mapping, Sequence
from typing import Any, cast

import httpx
from ada_url import URL
from neo_js_compat import js_code_unit_length, js_fnv1a32, js_json_bytes, js_round, js_utf16_slice

from .._json import as_dict, as_list, as_mapping, clean_text, strings
from .index import find_pdp_geo_rag_index_entry, find_pdp_geo_rag_section_entry

DEFAULT_PDP_GEO_RAG_MAX_CHUNKS = 14
_MAX_URL_REDIRECTS = 4
_MAX_URL_RESPONSE_CHARACTERS = 180_000
_MAX_URL_CONTENT_CHARACTERS = 40_000
_EMBEDDING_CACHE: dict[str, list[float]] = {}
_EMBEDDER_NAMESPACES: weakref.WeakKeyDictionary[object, str] = weakref.WeakKeyDictionary()
_embedder_sequence = 0


def resolve_pdp_geo_rag_settings(settings: Mapping[str, object] | None = None) -> dict[str, Any]:
    value = dict(settings or {})
    mode = value.get("mode") if value.get("mode") is not None else "local-versioned-rag"
    provider = (
        value.get("provider")
        if value.get("provider") is not None
        else ("openai" if mode == "managed-vector-store-rag" else "local")
    )
    value.update(
        {
            "mode": mode,
            "provider": provider,
            "embeddingProvider": value.get("embeddingProvider")
            if value.get("embeddingProvider") is not None
            else (
                provider
                if mode == "managed-vector-store-rag" and provider == "openai"
                else "custom"
                if mode == "managed-vector-store-rag"
                else "local"
            ),
            "rerankerProvider": value.get("rerankerProvider")
            if value.get("rerankerProvider") is not None
            else (
                "openai-file-search" if mode == "managed-vector-store-rag" and provider == "openai" else "local-hybrid"
            ),
            "maxChunks": value.get("maxChunks")
            if value.get("maxChunks") is not None
            else DEFAULT_PDP_GEO_RAG_MAX_CHUNKS,
            "scoreThreshold": value.get("scoreThreshold") if value.get("scoreThreshold") is not None else 0.08,
            "rewriteQuery": value.get("rewriteQuery") if value.get("rewriteQuery") is not None else True,
        }
    )
    return value


async def retrieve_pdp_geo_rag_chunks(
    request: Mapping[str, object], options: Mapping[str, object] | None = None
) -> list[dict[str, Any]]:
    settings = as_dict(request.get("settings"))
    runtime = dict(options or {})
    if settings.get("mode") == "managed-vector-store-rag" and settings.get("provider") == "custom":
        custom = runtime.get("customRetriever")
        if custom is None:
            raise ValueError("A customRetriever is required when rag.provider is custom.")
        return await _retrieve_with(custom, request)
    if settings.get("mode") == "managed-vector-store-rag" and settings.get("provider") == "openai":
        return await OpenAiVectorStoreRetriever(str(runtime.get("apiKey") or "")).retrieve(request)
    documents = [
        dict(cast(Mapping[str, Any], item)) for item in as_list(request.get("documents")) if isinstance(item, Mapping)
    ]
    resolved_documents = await _resolve_referenced_url_documents(
        documents, settings, runtime.get("customUrlResolver")
    )
    return await LocalVersionedRagRetriever(runtime.get("customEmbedder")).retrieve(
        {**request, "documents": resolved_documents}
    )


def create_pdp_geo_rag_query(product: Mapping[str, object], locale: str, market: str | None = None) -> str:
    reviews = as_mapping(product.get("reviews")) or {}
    parts: list[str | None] = [
        f"Generate PDP GEO schema and content for {clean_text(product.get('name'))}.",
        f"Brand: {clean_text(product.get('brand'))}." if clean_text(product.get("brand")) else None,
        f"Category: {clean_text(product.get('category'))}." if clean_text(product.get("category")) else None,
        f"Locale: {locale}. Market: {market or 'unknown'}.",
        _listed("Benefits", strings(product.get("benefits")), 5),
        _listed("Ingredients", strings(product.get("ingredients")), 5),
        _listed("Usage", strings(product.get("usage")), 3),
        _listed("Review keywords", strings(reviews.get("keywords")), 6),
        "Need schema.org Product FAQPage HowTo BreadcrumbList WebPage, E-E-A-T, CEP, GEO, locale terminology, additionalProperty.",
        "Need the description composition contract, description separation contract, FAQ contract, HowTo contract, schema safety contract, public wording contract, and evidence routing contract governing Product.description, WebPage.description, FAQPage.mainEntity, HowTo.step, and Product.additionalProperty.",
        "Need CEP field mapping, OCR sentence diagnostics, answer-ready FAQ intent, review-intent FAQ context, claim safety, and locale expression guidance.",
        "Use official OpenAI, Google Search Central, Gemini, and Perplexity docs for retrieval mode, embeddings, grounding, structured data, and answer-ready source support guidance.",
    ]
    return "\n".join(part for part in parts if part)


def create_pdp_geo_rag_query_plan(
    product: Mapping[str, object],
    locale: str,
    market: str | None,
    settings: Mapping[str, object] | None = None,
    hint_update_targets: Sequence[str] | None = None,
) -> dict[str, Any]:
    settings = settings or {}
    planning = as_mapping(settings.get("queryPlanning")) or {}
    targets = _unique([*list(hint_update_targets or []), *strings(planning.get("updateTargets"))])
    base = create_pdp_geo_rag_query(product, locale, market)
    if planning.get("enabled") is False:
        return {"mode": "single-query", "updateTargets": ["general"], "queries": [_general_subquery(base)]}
    if not targets:
        targets = ["productDescription", "webPageDescription", "faq", "howToUse", "schema"]
    include_base = planning.get("includeBaseQuery") is not False
    maximum = int(planning.get("maxSubqueries") or 6)
    queries = ([_general_subquery(base)] if include_base else []) + [
        item for target in targets for item in _target_subquery(target, product, locale, market)
    ]
    queries = queries[:maximum]
    return {
        "mode": "agentic-subquery-planning",
        "updateTargets": [item["target"] for item in queries],
        "queries": queries or [_general_subquery(base)],
    }


def _general_subquery(query: str) -> dict[str, Any]:
    return {
        "id": "general",
        "target": "general",
        "query": query,
        "intents": ["schema", "evidence", "retrieval", "general"],
        "fieldTargets": ["Product.description", "WebPage.description", "PDP.content", "diagnostics"],
        "reason": "Full GEO generation requires broad schema, evidence, locale, and public wording context.",
    }


def _target_subquery(
    target: str, product: Mapping[str, object], locale: str, market: str | None
) -> list[dict[str, Any]]:
    facts = " ".join(
        item
        for item in [
            f"Product: {clean_text(product.get('name'))}.",
            f"Brand: {clean_text(product.get('brand'))}." if clean_text(product.get("brand")) else "",
            f"Category: {clean_text(product.get('category'))}." if clean_text(product.get("category")) else "",
            f"Locale: {locale}. Market: {market or 'unknown'}.",
        ]
        if item
    )
    reviews = as_mapping(product.get("reviews")) or {}
    review = _listed("Review keywords", strings(reviews.get("keywords")), 8) or ""
    usage = _listed("Usage evidence", strings(product.get("usage")), 5, separator=" / ") or ""
    ingredients = _listed("Ingredients", strings(product.get("ingredients")), 8) or ""
    benefits = _listed("Benefits", strings(product.get("benefits")), 8) or ""
    specs: dict[str, tuple[str, list[str], list[str], str]] = {
        "productDescription": (
            f"{facts} Update only Product.description as the product-entity narrative. Need the description composition contract and description separation contract, CEP guidance for the target customer and their concrete concern, ingredient and formula composition, supported finished-product benefit and effect wording, causal path completeness for ingredient-to-outcome relations, E-E-A-T trust-first claim safety for source-stated research and measured results, and attributed customer-review keywords. {benefits} {ingredients} {review}",
            ["claims", "evidence", "customer", "schema"],
            ["Product.description", "Product.additionalProperty"],
            "Product description changed or needs regeneration without broad FAQ/HowTo updates.",
        ),
        "webPageDescription": (
            f"{facts} Update only WebPage.description as the page-scope counterpart of the product-entity narrative. Need the content field contracts for description separation, PDP field mapping for schema fields, CEP guidance for the supported target customer, customer situation, and review preference, page-scope wording for the product page and source-backed brand, schema role separation between the page resource and the product entity, and public wording safety. {benefits} {ingredients} {review}",
            ["customer", "claims", "schema"],
            ["WebPage.description", "PDP.content"],
            "Page-level description changed or needs regeneration while preserving product facts.",
        ),
        "quickFacts": (
            f"{facts} Update quick facts and Product.additionalProperty from source-backed product attributes only. {benefits} {ingredients} {usage}",
            ["claims", "evidence", "schema"],
            ["Product.additionalProperty", "PDP.content"],
            "Only factual attribute blocks need refresh.",
        ),
        "benefits": (
            f"{facts} Update benefit/effect PDP sections and Product.additionalProperty benefit fields with source-backed claim wording and overclaim filtering. {benefits}",
            ["claims", "evidence", "customer"],
            ["PDP.content", "Product.description"],
            "Benefit/effect copy changed and should not force unrelated FAQ/HowTo regeneration.",
        ),
        "ingredients": (
            f"{facts} Update ingredient, formula, additionalProperty, and ingredient-related FAQ context only. {ingredients}",
            ["claims", "evidence", "faq", "schema"],
            ["Product.additionalProperty", "FAQPage.mainEntity", "PDP.content"],
            "Ingredient information changed and downstream ingredient sections need targeted support.",
        ),
        "howToUse": (
            f"{facts} Update only HowTo.step and how-to-use PDP content from direct source usage. Need the HowTo contract, source-faithful step eligibility, direct source action versus routine note or review anecdote, step count and order fidelity, routine CEP field mapping, and schema.org HowTo node compatibility. {usage}",
            ["howTo", "schema", "evidence"],
            ["HowTo.step", "PDP.content"],
            "Usage instructions changed, so HowTo-specific RAG should be retrieved without broad regeneration.",
        ),
        "faq": (
            f"{facts} Update only FAQPage.mainEntity and FAQ PDP content. Need source-backed answers, ingredient/usage/customer intent, metric evidence, positive or neutral review use-feel FAQ intent, negative review exclusion, and FAQ schema compatibility. {benefits} {ingredients} {usage} {review}",
            ["faq", "customer", "review", "schema", "evidence"],
            ["FAQPage.mainEntity", "PDP.content"],
            "FAQ content changed or needs a targeted refresh.",
        ),
        "schema": (
            f"{facts} Update JSON-LD schema graph fields only: Product, WebPage, FAQPage, HowTo, BreadcrumbList, additionalProperty, offer/review compatibility, and validation constraints.",
            ["schema", "evidence"],
            [
                "Product.description",
                "WebPage.description",
                "FAQPage.mainEntity",
                "HowTo.step",
                "BreadcrumbList",
                "Product.additionalProperty",
            ],
            "Schema markup changed independently from public copy.",
        ),
        "breadcrumbs": (
            f"{facts} Update only BreadcrumbList and page hierarchy schema using source URL, brand, category, and product hierarchy evidence.",
            ["schema"],
            ["BreadcrumbList"],
            "Navigation or hierarchy changed and only breadcrumb schema needs refresh.",
        ),
        "reviews": (
            f"{facts} Update review-led product copy, review-intent FAQ use-feel answers, review summaries, and review-backed points routed to Product.additionalProperty. Need the evidence routing contract for review signals, review sentiment boundaries for public FAQ intent, attribution requirements for customer experience, and the separation between rating metadata and reviewer wording. {review}",
            ["review", "faq", "customer", "evidence"],
            ["FAQPage.mainEntity", "Product.description", "PDP.content"],
            "Review signals changed and should update review-dependent GEO content while keeping negative reviews out of public FAQ intent.",
        ),
    }
    if target not in specs:
        return []
    query, intents, targets, reason = specs[target]
    identifier = {
        "productDescription": "target-product-description",
        "webPageDescription": "target-webpage-description",
        "howToUse": "target-howto",
    }.get(target, f"target-{_kebab(target)}")
    return [
        {
            "id": identifier,
            "target": target,
            "query": query,
            "intents": intents,
            "fieldTargets": targets,
            "reason": reason,
        }
    ]


class LocalVersionedRagRetriever:
    def __init__(self, embedder: object | None = None) -> None:
        self.embedder = embedder

    async def retrieve(self, request: Mapping[str, object]) -> list[dict[str, Any]]:
        documents: list[Mapping[str, Any]] = [
            cast(Mapping[str, Any], item) for item in as_list(request.get("documents")) if isinstance(item, Mapping)
        ]
        chunks = [
            chunk
            for document in documents
            for chunk in chunk_pdp_geo_rag_document(
                str(document.get("name") or ""),
                str(document.get("content") or ""),
                str(document.get("version") or "v1"),
            )
        ]
        terminology = _terminology_expansions(documents)
        query_terms = _expand_tokens(tokenize(str(request.get("query") or "")), terminology)
        contextual = [create_pdp_geo_contextual_retrieval_text(chunk) for chunk in chunks]
        semantic = await self._semantic_scores(str(request.get("query") or ""), " ".join(query_terms), contextual)
        locale, market = str(request.get("locale") or "en-US"), str(request.get("market") or "")
        candidates: list[dict[str, Any]] = []
        for index, chunk in enumerate(chunks):
            lexical = lexical_similarity(query_terms, _expand_tokens(tokenize(contextual[index]), terminology))
            candidates.append(
                {
                    "chunk": chunk,
                    "lexical": lexical,
                    "semantic": semantic[index] if index < len(semantic) else 0.0,
                    "boost": _retrieval_boost(chunk, locale, market),
                }
            )
        lexical_ranks = _ranks(candidates, "lexical")
        semantic_ranks = _ranks(candidates, "semantic")
        scored: list[dict[str, Any]] = []
        for index, candidate in enumerate(candidates):
            rrf = _rrf([lexical_ranks[index], semantic_ranks[index]])
            score = _clamp(
                candidate["lexical"] * 0.38 + candidate["semantic"] * 0.34 + rrf * 0.16 + candidate["boost"], 0, 1
            )
            chunk = dict(candidate["chunk"])
            metadata = dict(chunk["metadata"])
            metadata.update(
                {
                    "contextualRetrieval": True,
                    "lexicalScore": _round(candidate["lexical"]),
                    "semanticScore": _round(candidate["semantic"]),
                    "rrfHybridScore": _round(rrf),
                    "retrievalBoost": _round(candidate["boost"]),
                }
            )
            chunk.update({"metadata": metadata, "score": score})
            scored.append(chunk)
        reranked = _rerank(scored, request)
        settings = as_mapping(request.get("settings")) or {}
        eligible = [
            chunk for chunk in reranked if float(chunk["score"]) >= float(settings.get("scoreThreshold") or 0.08)
        ]
        max_chunks = int(settings.get("maxChunks") or DEFAULT_PDP_GEO_RAG_MAX_CHUNKS)
        sources = {str(chunk["source"]) for chunk in eligible}
        cap = math.inf if len(sources) <= 1 else max(4, math.ceil(max_chunks / len(sources)))
        counts: dict[str, int] = {}
        selected: list[dict[str, Any]] = []
        for chunk in eligible:
            source = str(chunk["source"])
            if counts.get(source, 0) >= cap:
                continue
            counts[source] = counts.get(source, 0) + 1
            selected.append(chunk)
            if len(selected) >= max_chunks:
                break
        return selected

    async def _semantic_scores(self, query: str, lexical_query: str, candidates: list[str]) -> list[float]:
        if self.embedder is None:
            query_vector = _embed_hash(lexical_query)
            return [_cosine_score(query_vector, _embed_hash(candidate)) for candidate in candidates]
        try:
            vectors = await _embed_with_cache(self.embedder, [query, *candidates])
            if not vectors:
                raise ValueError("empty query embedding")
            return [_cosine_score(vectors[0], vector) for vector in vectors[1:]]
        except Exception:
            query_vector = _embed_hash(lexical_query)
            return [_cosine_score(query_vector, _embed_hash(candidate)) for candidate in candidates]


async def _resolve_referenced_url_documents(
    documents: Sequence[Mapping[str, Any]], settings: Mapping[str, Any], resolver: object | None
) -> list[dict[str, Any]]:
    """Expand opt-in URL citations into locally attributable RAG documents.

    A supplied resolver is the capability boundary: it receives each unique
    URL and decides how to fetch/extract it.  Without one, the conservative
    built-in HTTP resolver accepts only public HTTP(S) destinations.
    """

    result = [dict(document) for document in documents]
    if settings.get("resolveUrls") is not True:
        return result
    references: list[tuple[str, Mapping[str, Any]]] = []
    seen: set[str] = set()
    maximum = _positive_int(settings.get("maxResolvedUrlDocuments"), 16)
    for document in documents:
        for url in _extract_urls(clean_text(document.get("content"))):
            if url in seen:
                continue
            seen.add(url)
            references.append((url, document))
            if len(references) >= maximum:
                break
        if len(references) >= maximum:
            break
    if not references:
        return result
    active_resolver: object = resolver if resolver is not None else FetchRagUrlResolver(settings)
    for url, document in references:
        try:
            resolved = await _resolve_url_document(
                active_resolver,
                {
                    "url": url,
                    "sourceDocumentName": clean_text(document.get("name")),
                    "sourceDocumentVersion": clean_text(document.get("version")),
                },
            )
        except Exception:
            continue
        if not resolved:
            continue
        content = _preserve_markdown_text(resolved.get("content"))
        resolved_url = clean_text(resolved.get("url")) or url
        if not content or not resolved_url:
            continue
        title = clean_text(resolved.get("title")) or resolved_url
        source_type = _classify_resolved_url_source(resolved_url, title)
        extraction = _extract_geo_relevant_url_content(content, source_type)
        if not extraction:
            continue
        reason = clean_text(resolved.get("reason")) or _extraction_reason(source_type)
        result.append(
            {
                "name": resolved_url,
                "content": "\n".join(
                    (
                        f"# {title}",
                        "",
                        f"Source URL: {resolved_url}",
                        f"Referenced from: {clean_text(document.get('name'))}",
                        f"Source type: {source_type}",
                        f"Extraction reason: {reason}",
                        "",
                        extraction,
                    )
                ),
                "version": clean_text(document.get("version")) or "url",
            }
        )
    return result


async def _resolve_url_document(resolver: object, request: Mapping[str, object]) -> dict[str, Any]:
    method = getattr(resolver, "resolve", resolver)
    if not callable(method):
        raise TypeError("customUrlResolver must provide resolve(request).")
    value = cast(Callable[[Mapping[str, object]], object], method)(request)
    result = await value if inspect.isawaitable(value) else value
    return as_dict(result)


class FetchRagUrlResolver:
    def __init__(self, settings: Mapping[str, Any]) -> None:
        self.settings = dict(settings)

    async def resolve(self, request: Mapping[str, object]) -> dict[str, Any] | None:
        current = _canonical_public_url(clean_text(request.get("url")), strings(self.settings.get("allowedUrlDomains")))
        if current is None:
            return None

        timeout_ms = _positive_int(self.settings.get("urlFetchTimeoutMs"), 5000)
        headers = {
            "Accept": "text/html,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.1",
            "Accept-Language": "en-US,en;q=0.9",
            "User-Agent": "agentic-geo-rag-url-resolver/0.1",
        }
        async with httpx.AsyncClient(timeout=timeout_ms / 1000, follow_redirects=False) as client:
            for redirect_count in range(_MAX_URL_REDIRECTS + 1):
                async with client.stream("GET", current.href, headers=headers) as response:
                    if 300 <= response.status_code < 400:
                        location = response.headers.get("location")
                        if not location or redirect_count == _MAX_URL_REDIRECTS:
                            return None
                        next_url = _canonical_public_url(
                            location,
                            strings(self.settings.get("allowedUrlDomains")),
                            base_url=current.href,
                        )
                        if next_url is None:
                            return None
                        current = next_url
                        continue
                    if response.status_code < 200 or response.status_code >= 300:
                        return None
                    content_type = response.headers.get("content-type", "")
                    if not _is_supported_url_content_type(content_type):
                        return None
                    content = await _read_response_text(response, _MAX_URL_RESPONSE_CHARACTERS)

                content = content.strip()
                if not content:
                    return None
                title_match = re.search(r"<title[^>]*>(.*?)</title>", content, re.I | re.S)
                title = re.sub(r"\s+", " ", title_match.group(1)).strip() if title_match else current.href
                text = re.sub(r"<[^>]+>", " ", content) if "<" in content else content
                if "<" in content:
                    text = re.sub(r"[ \t]+", " ", text)
                return {
                    "url": current.href,
                    "title": title,
                    "content": js_utf16_slice(_preserve_markdown_text(text), 0, _MAX_URL_CONTENT_CHARACTERS),
                    "sourceType": "web-page",
                }
        return None


def _preserve_markdown_text(value: object) -> str:
    """Normalize line endings without flattening Markdown section boundaries."""

    if not isinstance(value, str):
        return ""
    return re.sub(r"\n{3,}", "\n\n", value.replace("\r\n", "\n")).strip()


def _classify_resolved_url_source(url: str, title: str) -> str:
    key = f"{url} {title}".lower()
    if re.search(r"generative-engines\.com|arxiv\.org|doi\.org|paper|research|proceedings", key):
        return "official-paper"
    if "schema.org" in key:
        return "schema-reference"
    if re.search(r"developers\.openai\.com|platform\.openai\.com|ai\.google\.dev|docs\.perplexity\.ai", key):
        return "provider-doc"
    if re.search(r"developers\.google\.com|search central|official", key):
        return "official-doc"
    return "other"


def _extract_geo_relevant_url_content(content: str, source_type: str) -> str:
    sections = _split_resolved_text_sections(content)
    ranked = [
        (index, section, _geo_relevance_score(section, source_type))
        for index, section in enumerate(sections)
        if not _is_resolved_url_boilerplate(section)
    ]
    selected = [item for item in ranked if item[2] > 0]
    selected.sort(key=lambda item: (-item[2], item[0]))
    selected = selected[:_max_url_sections(source_type)]
    selected.sort(key=lambda item: item[0])
    if selected:
        output = "\n\n".join(item[1] for item in selected)
    else:
        output = "\n\n".join(item.strip() for item in re.split(r"\n{2,}", content) if item.strip()[:1])
        output = "\n\n".join(output.split("\n\n")[:2])
    return output[:_max_url_content_length(source_type)].strip()


def _split_resolved_text_sections(content: str) -> list[str]:
    normalized = _preserve_markdown_text(content)
    if not normalized:
        return []
    markdown = [section["text"] for section in _split_sections(normalized)]
    if len(markdown) > 1:
        return markdown
    return [item.strip() for item in re.split(r"\n{2,}", normalized) if len(item.strip()) > 80]


def _geo_relevance_score(section: str, source_type: str) -> int:
    text = section.lower()
    score = _keyword_score(
        text,
        (
            "generative engine", "generative engines", "answer engine", "citation", "cite", "visibility", "source",
            "grounding", "retrieval", "structured data", "schema.org", "product structured data", "product snippet",
            "merchant listing", "faqpage", "howto", "breadcrumblist", "webpage", "product", "review", "rating",
            "offer", "claim", "evidence", "attribute", "property", "entity", "content optimization", "domain-specific",
        ),
    )
    score -= _keyword_score(
        text,
        (
            "install", "npm", "pip install", "curl", "api key", "authentication", "rate limit", "billing", "pricing",
            "sdk", "sdks", "quickstart", "navigation", "get started overview", "sdk and cli", "node reference",
            "prompt guide", "early adopters program", "package tracking", "structured data carousels", "profile page q&a recipe",
            "software app", "vacation rental", "title links", "cookie", "terms and conditions", "login", "dashboard",
        ),
    )
    if source_type == "official-paper" and re.search(r"experiment|benchmark|dataset|method|visibility|citation|domain-specific|generative engine", text):
        score += 4
    if source_type == "schema-reference" and re.search(r"property|expected type|used on these types|values expected|examples|faqpage|howto|product|webpage|breadcrumblist", text):
        score += 4
    if source_type == "provider-doc" and re.search(r"retrieval|embedding|grounding|search result|file search|vector|citation|source", text):
        score += 4
    if source_type == "official-doc" and re.search(r"structured data|product|review|rating|offer|eligibility|required|recommended", text):
        score += 4
    if len(text) < 120:
        score -= 2
    return score


def _keyword_score(text: str, keywords: Sequence[str]) -> int:
    return sum(keyword in text for keyword in keywords)


def _is_resolved_url_boilerplate(section: str) -> bool:
    text = re.sub(r"\s+", " ", section.lower())
    return any(
        phrase in text
        for phrase in (
            "get started overview quickstart models pricing",
            "openai sdk agents sdk openai cli",
            "early adopters program package tracking",
            "profile page q&a recipe review snippet software app",
            "speakable subscription and paywalled content vacation rental",
            "debug drops in search traffic",
            "terms and conditions schema.org",
            "skip to main content",
        )
    )


def _max_url_sections(source_type: str) -> int:
    return {"official-paper": 8, "schema-reference": 6, "provider-doc": 5, "official-doc": 5}.get(source_type, 3)


def _max_url_content_length(source_type: str) -> int:
    return {"official-paper": 9000, "schema-reference": 7000, "provider-doc": 6000, "official-doc": 6000}.get(source_type, 3500)


def _extraction_reason(source_type: str) -> str:
    return {
        "official-paper": "GEO research signals such as citation readiness, visibility, source attribution, answer synthesis, and domain-specific optimization.",
        "schema-reference": "Schema.org type/property compatibility for Product, WebPage, FAQPage, HowTo, and BreadcrumbList generation.",
        "provider-doc": "Provider retrieval, embedding, search, grounding, and source-evidence mechanics relevant to RAG diagnostics.",
        "official-doc": "Official structured data eligibility and product evidence guidance relevant to schema and claim generation.",
    }.get(source_type, "General GEO-relevant excerpts selected by deterministic relevance scoring.")


def _extract_urls(value: str) -> list[str]:
    return [match.rstrip(".,;:!?)]}\"'") for match in re.findall(r"https?://[^\s<>'\"]+", value, re.I)]


def _canonical_public_url(
    value: str, allowed_domains: Sequence[str], *, base_url: str | None = None
) -> URL | None:
    """Return a canonical WHATWG HTTP(S) URL only when its host policy permits it.

    This validates URL syntax and textual IP aliases before each outbound
    request.  It deliberately does not perform DNS pre-resolution, so it does
    not claim protection against a hostname rebinding after this validation.
    """

    try:
        parsed = URL(value, base_url) if base_url is not None else URL(value)
    except (UnicodeError, ValueError):
        return None
    if parsed.protocol not in {"http:", "https:"} or parsed.username or parsed.password or parsed.port:
        return None
    host = parsed.hostname.casefold().rstrip(".")
    if not host or host in {"localhost", "localhost.localdomain"} or host.endswith(".localhost"):
        return None
    try:
        address = ipaddress.ip_address(host.removeprefix("[").removesuffix("]"))
    except ValueError:
        address = None
    if address is not None and not address.is_global:
        return None
    allowed = [_canonical_allowed_domain(domain) for domain in allowed_domains]
    permitted_domains = [domain for domain in allowed if domain]
    if permitted_domains and not any(host == domain or host.endswith(f".{domain}") for domain in permitted_domains):
        return None
    try:
        parsed.hostname = host
    except ValueError:
        return None
    return parsed


def _canonical_allowed_domain(value: str) -> str:
    return value.casefold().strip().lstrip(".").rstrip(".")


def _is_supported_url_content_type(content_type: str) -> bool:
    normalized = content_type.casefold()
    return (
        "text/html" in normalized
        or "text/plain" in normalized
        or "text/markdown" in normalized
        or "application/json" in normalized
        or "application/xhtml+xml" in normalized
        or not normalized
    )


async def _read_response_text(response: httpx.Response, maximum_characters: int) -> str:
    """Read no more than the retained resolver's bounded response size."""

    parts: list[str] = []
    remaining = maximum_characters
    async for chunk in response.aiter_text():
        if not chunk:
            continue
        chunk_length = js_code_unit_length(chunk)
        if chunk_length <= remaining:
            parts.append(chunk)
            remaining -= chunk_length
            continue
        parts.append(js_utf16_slice(chunk, 0, remaining))
        remaining = 0
        if remaining <= 0:
            break
    return "".join(parts)


def _positive_int(value: object, default: int) -> int:
    return int(value) if isinstance(value, int) and value > 0 else default


async def _retrieve_with(retriever: object, request: Mapping[str, object]) -> list[dict[str, Any]]:
    method = getattr(retriever, "retrieve", retriever)
    if not callable(method):
        raise TypeError("customRetriever must provide retrieve(request).")
    value = cast(Callable[[Mapping[str, object]], object], method)(request)
    output = await value if inspect.isawaitable(value) else value
    if not isinstance(output, Sequence) or isinstance(output, str | bytes | bytearray):
        raise TypeError("customRetriever must return a sequence of retrieved chunks.")
    return [
        dict(cast(Mapping[str, Any], item)) for item in cast(Sequence[object], output) if isinstance(item, Mapping)
    ]


class OpenAiVectorStoreRetriever:
    """Minimal HTTP adapter kept separate from deterministic local retrieval."""

    def __init__(self, api_key: str = "") -> None:
        self.api_key = api_key

    async def retrieve(self, request: Mapping[str, object]) -> list[dict[str, Any]]:
        if not self.api_key:
            raise ValueError("OPENAI_API_KEY is required for managed-vector-store-rag with the OpenAI provider.")
        settings = as_dict(request.get("settings"))
        vector_store = settings.get("vectorStoreId")
        if not vector_store:
            raise ValueError("rag.vectorStoreId is required for managed-vector-store-rag with the OpenAI provider.")
        import httpx

        endpoint = str(
            settings.get("managedSearchEndpoint") or f"https://api.openai.com/v1/vector_stores/{vector_store}/search"
        )
        async with httpx.AsyncClient() as client:
            response = await client.post(
                endpoint,
                headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
                content=js_json_bytes(
                    {
                        "query": str(request.get("query") or ""),
                        "max_num_results": int(settings.get("maxChunks") or DEFAULT_PDP_GEO_RAG_MAX_CHUNKS),
                        "rewrite_query": bool(settings.get("rewriteQuery", True)),
                    }
                ),
            )
        if response.status_code < 200 or response.status_code >= 300:
            detail = re.sub(r"\s+", " ", response.text).strip()[:500]
            raise ValueError(
                f"OpenAI vector store search failed: {response.status_code}{f' - {detail}' if detail else ''}"
            )
        payload = as_dict(response.json())
        result: list[dict[str, Any]] = []
        for index, item in enumerate(as_list(payload.get("data"))):
            row = as_dict(item)
            text = "\n".join(
                clean_text(as_dict(content).get("text"))
                for content in as_list(row.get("content"))
            ).strip()
            if not text:
                continue
            source = str(row.get("filename") or "openai-vector-store")
            kind = _kind_from_name(source)
            intents, targets = _infer_routing(kind, source, None, text)
            result.append(
                {
                    "id": f"openai-vector-{index + 1}",
                    "source": source,
                    "text": text,
                    "kind": kind,
                    "intents": intents,
                    "fieldTargets": targets,
                    "metadata": {
                        **as_dict(row.get("attributes")),
                        "sectionIntents": ",".join(intents),
                        "fieldTargets": ",".join(targets),
                    },
                    "score": row.get("score") if isinstance(row.get("score"), int | float) else 0,
                }
            )
        return result


def chunk_pdp_geo_rag_document(name: str, content: str, version: str = "v1") -> list[dict[str, Any]]:
    sections = _split_sections(content)
    document_index = find_pdp_geo_rag_index_entry(name)
    kind = str(document_index.get("kind")) if document_index else _kind_from_name(name)
    rows: list[dict[str, Any]] = []
    for index, section in enumerate(sections):
        indexed_section = find_pdp_geo_rag_section_entry(name, section.get("title"), section.get("headingPath"))
        intents, targets = _infer_routing(kind, name, section.get("title"), str(section["text"]))
        if document_index:
            indexed_intents = as_list(
                indexed_section.get("intents") if indexed_section else document_index.get("intents")
            )
            indexed_targets = as_list(
                indexed_section.get("fieldTargets") if indexed_section else document_index.get("fieldTargets")
            )
            intents = [str(item) for item in indexed_intents if isinstance(item, str)] or intents
            targets = [str(item) for item in indexed_targets if isinstance(item, str)] or targets
        slug = re.sub(r"^-+|-+$", "", re.sub(r"[^a-z0-9]+", "-", name.lower()))
        rows.append(
            {
                "id": f"{slug}-{index + 1}",
                "source": name,
                "title": section.get("title"),
                "text": section["text"],
                "kind": kind,
                "intents": intents,
                "fieldTargets": targets,
                "metadata": {
                    "version": version,
                    "index": index,
                    "managed": True,
                    "sourceRole": document_index.get("sourceRole") if document_index else "custom",
                    "checkedAt": document_index.get("checkedAt") if document_index else "",
                    "headingPath": section.get("headingPath") or section.get("title") or "",
                    "routingPriority": (indexed_section or document_index or {}).get("priority", 0),
                    "sectionIntents": ",".join(intents),
                    "fieldTargets": ",".join(targets),
                },
            }
        )
    return rows


def create_pdp_geo_contextual_retrieval_text(chunk: Mapping[str, object]) -> str:
    metadata = as_mapping(chunk.get("metadata")) or {}
    fields = [
        f"Document: {chunk.get('source', '')}",
        f"Section: {chunk['title']}" if chunk.get("title") else "",
        f"Heading path: {metadata['headingPath']}" if metadata.get("headingPath") else "",
        f"RAG kind: {chunk.get('kind', '')}",
        f"Source role: {metadata['sourceRole']}" if metadata.get("sourceRole") else "",
        f"Checked at: {metadata['checkedAt']}" if metadata.get("checkedAt") else "",
        f"Generation intents: {', '.join(strings(chunk.get('intents')))}" if strings(chunk.get("intents")) else "",
        f"Schema and content fields: {', '.join(strings(chunk.get('fieldTargets')))}"
        if strings(chunk.get("fieldTargets"))
        else "",
        str(chunk.get("text") or ""),
    ]
    return "\n".join(field for field in fields if field)


def tokenize(text: str) -> list[str]:
    lowered = text.lower()
    normalized = "".join(
        char if char.isalpha() or char.isnumeric() or char.isspace() or char == "-" else " " for char in lowered
    )
    return [token for token in normalized.split() if len(token) >= 2]


def lexical_similarity(query_terms: Sequence[str], candidate_terms: Sequence[str]) -> float:
    if not query_terms or not candidate_terms:
        return 0.0
    candidate = set(candidate_terms)
    return len(set(term for term in query_terms if term in candidate)) / math.sqrt(len(query_terms) * len(candidate))


def _split_sections(content: str) -> list[dict[str, str]]:
    normalized = content.replace("\r\n", "\n").strip()
    if not normalized:
        return []
    if normalized.startswith("{"):
        return [{"title": "JSON terminology map", "headingPath": "JSON terminology map", "text": normalized}]
    sections: list[dict[str, str]] = []
    title, path = "", ""
    trail: list[str] = []
    buffer: list[str] = []
    for line in normalized.split("\n"):
        heading = re.match(r"^(#{1,3})\s+(.+)$", line)
        if heading:
            _push_section(sections, title, path, buffer)
            level, title = len(heading.group(1)), heading.group(2).strip()
            trail = trail[: level - 1]
            if len(trail) < level:
                trail.extend([""] * (level - len(trail)))
            trail[level - 1] = title
            path = " > ".join(item for item in trail if item)
            buffer = [line]
        else:
            buffer.append(line)
    _push_section(sections, title, path, buffer)
    return [piece for section in sections for piece in _split_long_section(section)]


def _push_section(output: list[dict[str, str]], title: str, path: str, buffer: list[str]) -> None:
    text = "\n".join(buffer).strip()
    if text and re.sub(r"^#{1,3}\s+.+$", "", text, flags=re.MULTILINE).strip():
        output.append({"title": title, "headingPath": path, "text": text})


def _split_long_section(section: Mapping[str, str]) -> list[dict[str, str]]:
    maximum = 1100
    text = section["text"]
    if len(text) <= maximum:
        return [dict(section)]
    chunks: list[dict[str, str]] = []
    current = ""
    for paragraph in text.split("\n\n"):
        # Match ``splitLongSection`` in the retained TypeScript source: a
        # paragraph that needs splitting flushes any accumulated sibling and
        # each split fragment becomes its own chunk.  Combining a tail
        # fragment with the following paragraph changes deterministic chunk
        # IDs and therefore the RAG benchmark candidate pool.
        if len(paragraph) > maximum:
            if current.strip():
                chunks.append({**section, "text": current.strip()})
                current = ""
            chunks.extend({**section, "text": piece} for piece in _split_long_paragraph(paragraph, maximum))
            continue
        if current.strip() and len(f"{current}\n\n{paragraph}") > maximum:
            chunks.append({**section, "text": current.strip()})
            current = paragraph
        else:
            current = "\n\n".join(item for item in (current, paragraph) if item)
    if current:
        chunks.append({**section, "text": current.strip()})
    return chunks


def _split_long_paragraph(paragraph: str, maximum: int) -> list[str]:
    output: list[str] = []
    remaining = paragraph.strip()
    while len(remaining) > maximum:
        # ``String.lastIndexOf(marker, maxLength)`` is inclusive.  Python's
        # end offset is exclusive, so include ``maximum`` to retain the exact
        # TS split point and stable chunk numbering.
        candidates = [remaining.rfind(marker, 0, maximum + 1) for marker in (" ", ",", "}", "]")]
        boundary = max(candidates)
        split = boundary + 1 if boundary >= math.floor(maximum * 0.6) else maximum
        output.append(remaining[:split].strip())
        remaining = remaining[split:].strip()
    if remaining:
        output.append(remaining)
    return output


def _kind_from_name(name: str) -> str:
    if re.search(r"orchestrat|rag-map|manifest|analysis-prompt", name, re.I):
        return "orchestration"
    if re.search(r"field-contract|content-field", name, re.I):
        return "field-contracts"
    if re.search(r"schema", name, re.I):
        return "schema"
    if re.search(r"eeat|e-e-a-t", name, re.I):
        return "eeat"
    if re.search(r"cep", name, re.I):
        return "cep"
    if re.search(r"best", name, re.I):
        return "best-practice"
    if re.search(r"geo-research|geo-paper|generative", name, re.I):
        return "geo-research"
    if re.search(
        r"official|openai|google|gemini|perplexity|platform|docs|search-api|embedding|file-search|vector-store",
        name,
        re.I,
    ):
        return "official-docs"
    if re.search(r"terminology", name, re.I):
        return "terminology"
    if re.search(r"locale", name, re.I):
        return "locale"
    return "custom"


def _infer_routing(kind: str, source: str, title: str | None, text: str) -> tuple[list[str], list[str]]:
    haystack = f"{source} {title or ''} {text}".lower()
    intents: list[str] = []
    fields: list[str] = []

    def add(items: list[str], value: str) -> None:
        if value not in items:
            items.append(value)

    if kind in {"terminology", "locale"} or re.search(
        r"\blocale\b|terminology|market wording|locali[sz]e|금칙|표현|wording", haystack
    ):
        add(intents, "locale")
        add(fields, "PDP.content")
    if kind == "orchestration" or re.search(
        r"orchestration|routing|rag index|rag-index|overlap|conflict|missing|coverage|content unit|문서 단위|내용 단위|누락|충돌|중복",
        haystack,
    ):
        add(intents, "retrieval")
        add(intents, "general")
        add(fields, "retrieval")
        add(fields, "diagnostics")
    if kind == "official-docs" or re.search(
        r"retrieval|embedding|vector|search api|grounding|provider|openai|gemini|perplexity", haystack
    ):
        add(intents, "retrieval")
        add(fields, "retrieval")
        add(fields, "diagnostics")
    if re.search(r"faq|question|answer|mainentity|customer question|q&a", haystack):
        add(intents, "faq")
        add(fields, "FAQPage.mainEntity")
    if re.search(
        r"howto|how to use|stepwise|\bstep\b|usage|routine|direction|apply|application|사용법|사용\s*순서", haystack
    ):
        add(intents, "howTo")
        add(fields, "HowTo.step")
    if re.search(
        r"claim|evidence|source-supported|reported result|clinical|metric|award|certification|trust|trustworthiness|expertise|authoritativeness|additionalproperty|propertyvalue|효능|효과|근거",
        haystack,
    ):
        add(intents, "claims")
        add(intents, "evidence")
        add(fields, "Product.description")
        add(fields, "Product.additionalProperty")
    if re.search(
        r"customer|target customer|audience|entry point|cep|concern|skin type|use occasion|routine timing|buying|discovery|review-backed preference",
        haystack,
    ):
        add(intents, "customer")
        add(fields, "WebPage.description")
        add(fields, "Product.description")
    if re.search(
        r"review|rating|experience|texture|absorption|comfort|satisfaction|customer language|사용감|흡수감|리뷰",
        haystack,
    ):
        add(intents, "review")
        add(fields, "FAQPage.mainEntity")
        add(fields, "Product.description")
    if re.search(
        r"schema|json-ld|webpage|product\.description|webpage\.description|product entity|breadcrumb|offer|brand|manufacturer|graph|structured data",
        haystack,
    ):
        add(intents, "schema")
        add(fields, "Product.description")
        add(fields, "WebPage.description")
    if "breadcrumb" in haystack:
        add(fields, "BreadcrumbList")
    if re.search(r"ocr|sentence diagnostics|classified sentence|diagnostic", haystack):
        add(intents, "evidence")
        add(fields, "diagnostics")
    if kind == "geo-research" and not intents:
        add(intents, "general")
        add(fields, "PDP.content")
    if kind == "eeat" and not intents:
        add(intents, "evidence")
        add(intents, "claims")
    if kind == "cep" and not intents:
        add(intents, "customer")
    return intents or ["general"], fields or ["PDP.content"]


def _retrieval_boost(chunk: Mapping[str, object], locale: str, market: str) -> float:
    metadata = as_mapping(chunk.get("metadata")) or {}
    indexed_doc = find_pdp_geo_rag_index_entry(str(chunk.get("source") or ""))
    indexed_section = find_pdp_geo_rag_section_entry(
        str(chunk.get("source") or ""), str(chunk.get("title") or ""), str(metadata.get("headingPath") or "")
    )
    boost = float((indexed_section or indexed_doc or {}).get("priority", 0)) * 0.08
    kind = str(chunk.get("kind") or "")
    boost += {
        "schema": 0.05,
        "orchestration": 0.07,
        "terminology": 0.07,
        "locale": 0.07,
        "official-docs": 0.06,
        "field-contracts": 0.08,
        "best-practice": 0.08,
        "geo-research": 0.08,
        "eeat": 0.04,
        "cep": 0.04,
    }.get(kind, 0)
    text = f"{chunk.get('source', '')} {chunk.get('title', '')} {chunk.get('text', '')}"
    if re.search(
        r"ocr|sentence diagnostics|sentence intent|classified sentence|citation|cite|quotable|answer-ready|faqpage|mainentity|review|customer|webpage\.description|product\.description|claim support|evidence hierarchy|public wording",
        text,
        re.I,
    ):
        boost += 0.04
    if locale in text:
        boost += 0.05
    if market and market in text:
        boost += 0.03
    return boost


def _ranks(candidates: list[dict[str, Any]], key: str) -> dict[int, int]:
    return {
        item[0]: index + 1
        for index, item in enumerate(sorted(enumerate(candidates), key=lambda item: (-float(item[1][key]), item[0])))
    }


def _rrf(ranks: Sequence[int]) -> float:
    return _clamp(_js_float_sum(1 / (60 + rank) for rank in ranks) * 30, 0, 1)


def _js_float_sum(values: Iterable[float]) -> float:
    """Mirror V8 ``Array.prototype.reduce`` instead of Python's compensated ``sum``."""

    total = 0.0
    for value in values:
        total += value
    return total


def _rerank(chunks: list[dict[str, Any]], request: Mapping[str, object]) -> list[dict[str, Any]]:
    query = str(request.get("query") or "").lower()
    intents, fields = strings(request.get("queryIntents")), strings(request.get("queryFieldTargets"))
    product = as_mapping(request.get("product")) or {}
    reviews = as_mapping(product.get("reviews")) or {}
    product_terms = tokenize(
        " ".join(
            [
                clean_text(product.get("name")),
                clean_text(product.get("brand")),
                clean_text(product.get("category")),
                *strings(product.get("benefits")),
                *strings(product.get("ingredients")),
                *strings(product.get("usage")),
                *strings(reviews.get("keywords")),
            ]
        )
    )
    output: list[dict[str, Any]] = []
    for chunk in chunks:
        contextual = create_pdp_geo_contextual_retrieval_text(chunk).lower()
        boost = 0.0
        if intents and any(item in intents for item in strings(chunk.get("intents"))):
            boost += 0.06
        if fields and any(item in fields for item in strings(chunk.get("fieldTargets"))):
            boost += 0.05
        if any(item.lower() in query for item in strings(chunk.get("fieldTargets"))):
            boost += 0.05
        if any(item.lower() in query for item in strings(chunk.get("intents"))):
            boost += 0.03
        kind = str(chunk.get("kind") or "")
        if kind == "geo-research" and re.search(r"geo|generative|answer-ready|retrieval|query planning", query):
            boost += 0.04
        if kind == "cep" and re.search(r"cep|customer|entry point|routine|review|faq", query):
            boost += 0.04
        if kind == "eeat" and re.search(r"e-e-a-t|eeat|trust|evidence|claim|safety", query):
            boost += 0.04
        boost += min(0.05, lexical_similarity(product_terms, tokenize(contextual)) * 0.12)
        metadata = dict(as_mapping(chunk.get("metadata")) or {})
        metadata.update(
            {
                "baseScore": _round(float(chunk["score"])),
                "rerankBoost": _round(boost),
                "reranker": "local-contextual-hybrid",
            }
        )
        output.append({**chunk, "metadata": metadata, "score": _clamp(float(chunk["score"]) + boost, 0, 1)})
    return sorted(output, key=lambda item: -float(item["score"]))


def _embed_hash(text: str) -> list[float]:
    vector = [0.0] * 384
    for token in tokenize(text):
        vector[js_fnv1a32(token) % len(vector)] += 1 / math.sqrt(max(len(token), 1))
    magnitude = math.sqrt(_js_float_sum(value * value for value in vector)) or 1
    return [value / magnitude for value in vector]


def _cosine_score(left: Sequence[float], right: Sequence[float]) -> float:
    return _clamp(
        (_js_float_sum(value * (right[index] if index < len(right) else 0) for index, value in enumerate(left)) + 1)
        / 2,
        0,
        1,
    )


async def _embed_with_cache(embedder: object, texts: list[str]) -> list[list[float]]:
    namespace = _embedder_namespace(embedder)
    result: list[list[float] | None] = []
    missing: list[tuple[int, str, str]] = []
    for index, text in enumerate(texts):
        key = f"{namespace}|{js_fnv1a32(text)}:{len(text.encode('utf-16-le', 'surrogatepass')) // 2}"
        vector = _EMBEDDING_CACHE.get(key)
        result.append(vector)
        if vector is None:
            missing.append((index, text, key))
    if missing:
        method = getattr(embedder, "embed", embedder)
        if not callable(method):
            raise TypeError("customEmbedder must provide embed(texts).")
        value = cast(Callable[[list[str]], object], method)([item[1] for item in missing])
        embedded = await value if inspect.isawaitable(value) else value
        vectors = cast(list[object], as_list(embedded))
        for position, (index, _, key) in enumerate(missing):
            vector: object = vectors[position] if position < len(vectors) else []
            if isinstance(vector, Sequence) and not isinstance(vector, str | bytes | bytearray) and vector:
                values = cast(Sequence[object], vector)
                if all(isinstance(item, int | float) and not isinstance(item, bool) for item in values):
                    result[index] = [float(cast(int | float, item)) for item in values]
                    if len(_EMBEDDING_CACHE) < 4096:
                        _EMBEDDING_CACHE[key] = result[index] or []
    if any(not vector for vector in result):
        missing_count = sum(1 for vector in result if not vector)
        raise ValueError(
            f"Embedder returned {missing_count}/{len(texts)} empty vector(s); falling back to deterministic local embeddings."
        )
    return [vector for vector in result if vector is not None]


def _embedder_namespace(embedder: object) -> str:
    global _embedder_sequence
    model = getattr(embedder, "model", None)
    if isinstance(model, str) and model:
        return f"model:{model}"
    try:
        existing = _EMBEDDER_NAMESPACES.get(embedder)
        if existing:
            return existing
        _embedder_sequence += 1
        namespace = f"instance:{_embedder_sequence}"
        _EMBEDDER_NAMESPACES[embedder] = namespace
        return namespace
    except TypeError:
        _embedder_sequence += 1
        return f"instance:{_embedder_sequence}"


def _terminology_expansions(documents: Sequence[Mapping[str, object]]) -> dict[str, set[str]]:
    expansions: dict[str, set[str]] = {}
    for document in documents:
        if "terminology" not in str(document.get("name") or "").lower() or not str(
            document.get("content") or ""
        ).strip().startswith("{"):
            continue
        try:
            parsed = json.loads(str(document.get("content")))
        except json.JSONDecodeError:
            continue
        for concept in as_list(as_dict(parsed).get("concepts")):
            row = as_dict(concept)
            group = set(tokenize(str(row.get("concept") or "")))
            for terms in (as_mapping(row.get("preferred")) or {}).values():
                for term in strings(terms):
                    group.update(tokenize(term))
            if len(group) >= 2:
                for token in group:
                    expansions.setdefault(token, set()).update(group)
    return expansions


def _expand_tokens(tokens: Sequence[str], expansions: Mapping[str, set[str]]) -> list[str]:
    # ``expandTokensWithTerminology`` returns the original array unchanged
    # when no terminology map is present.  That preserves repeated query
    # terms in the local hash vector and lexical denominator.  Once a map is
    # present it uses JS ``Set`` insertion order to deduplicate while adding
    # synonyms.
    if not expansions:
        return list(tokens)
    output = dict.fromkeys(tokens)
    for token in tokens:
        for synonym in expansions.get(token, set()):
            output.setdefault(synonym, None)
    return list(output)


def _listed(label: str, values: Sequence[str], limit: int, *, separator: str = ", ") -> str | None:
    return f"{label}: {separator.join(values[:limit])}." if values else None


def _unique(values: Sequence[str]) -> list[str]:
    return list(dict.fromkeys(value for value in values if value))


def _kebab(value: str) -> str:
    return re.sub(r"^-+|-+$", "", re.sub(r"([a-z])([A-Z])", r"\1-\2", value).replace("_", "-").lower())


def _round(value: float) -> float:
    return js_round(value * 10000) / 10000


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return min(maximum, max(minimum, value))


resolvePdpGeoRagSettings = resolve_pdp_geo_rag_settings
retrievePdpGeoRagChunks = retrieve_pdp_geo_rag_chunks
createPdpGeoRagQuery = create_pdp_geo_rag_query
createPdpGeoRagQueryPlan = create_pdp_geo_rag_query_plan
chunkPdpGeoRagDocument = chunk_pdp_geo_rag_document
createPdpGeoContextualRetrievalText = create_pdp_geo_contextual_retrieval_text

# Generation-level selection lives in ``rag.orchestration`` to keep local
# retrieval independently reusable; retain these imports here for the direct
# port surface used by existing callers and evals.
from .orchestration import (  # noqa: E402
    apply_custom_pdp_geo_rerank,
    assemble_pdp_geo_rag_chunks,
    boost_chunk_for_subquery,
    create_pdp_geo_rag_usage_diagnostics,
    hydrate_selected_pdp_geo_rag_documents,
    infer_pdp_geo_brand_overlay_documents,
    infer_pdp_geo_brand_rag_scope,
    merge_pdp_geo_rag_documents,
    scope_pdp_geo_brand_rag_documents,
    select_final_rag_chunks,
)

__all__ = [
    "DEFAULT_PDP_GEO_RAG_MAX_CHUNKS",
    "LocalVersionedRagRetriever",
    "OpenAiVectorStoreRetriever",
    "apply_custom_pdp_geo_rerank",
    "assemble_pdp_geo_rag_chunks",
    "boost_chunk_for_subquery",
    "chunk_pdp_geo_rag_document",
    "create_pdp_geo_contextual_retrieval_text",
    "create_pdp_geo_rag_query",
    "create_pdp_geo_rag_query_plan",
    "create_pdp_geo_rag_usage_diagnostics",
    "hydrate_selected_pdp_geo_rag_documents",
    "infer_pdp_geo_brand_overlay_documents",
    "infer_pdp_geo_brand_rag_scope",
    "merge_pdp_geo_rag_documents",
    "resolve_pdp_geo_rag_settings",
    "retrieve_pdp_geo_rag_chunks",
    "scope_pdp_geo_brand_rag_documents",
    "select_final_rag_chunks",
]
