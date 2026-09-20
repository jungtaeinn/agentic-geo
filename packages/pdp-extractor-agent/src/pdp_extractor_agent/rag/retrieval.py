"""Deterministic local-hybrid RAG retrieval matching the legacy extractor."""

from __future__ import annotations

import inspect
import math
import re
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, Protocol, cast
from urllib.parse import quote

import httpx
from neo_js_compat import js_code_unit_length, js_embedding_snapshot_key, js_fnv1a32, js_json_bytes

from .._json_types import as_list, as_mapping
from .index import find_product_extractor_rag_index_entry, find_product_extractor_rag_section_entry
from .profile_store import read_profile

_MAX_LOCAL_VECTOR_SIZE = 96
_COHERE_PROVIDERS = {"cohere", "aistudio-bedrock-cohere"}
_ENCODE_COMPONENT_SAFE = "~()*!.'-"


class _ModelDumpable(Protocol):
    def model_dump(self, *, by_alias: bool, exclude_none: bool) -> object: ...


def create_product_extractor_rag_query(input_: Mapping[str, Any]) -> str:
    """Build the policy query used before OCR classification."""

    if "source" in input_ or "imageTexts" in input_:
        evidence = as_list(input_.get("imageTexts"))
        evidence_text = (
            "\n".join(
                str(item_mapping.get("text", ""))
                for item in evidence[:12]
                if (item_mapping := as_mapping(item)) is not None
            )
            if evidence is not None
            else ""
        )
        parts = [
            "Classify PDP OCR and long-scroll evidence into product, benefit, effect, ingredient, usage, FAQ, review, price, and metric fields.",
            f"Source: {input_.get('source', '')}.",
            f"Product name: {input_['productName']}." if input_.get("productName") else "",
            evidence_text,
            "Need policy for excluding cart, coupon, delivery, exchange, refund, legal, and page chrome text.",
            "Need sentence-level OCR reconstruction, source-backed claims, complete product evidence, review signals, FAQ evidence, and schema-ready RAG chunks.",
        ]
        return "\n".join(part for part in parts if part)
    values: list[str] = []
    for key in ("productName", "name", "description", "benefits", "effects", "ingredients", "usage", "faq"):
        value = input_.get(key)
        if isinstance(value, str):
            values.append(value)
        elif (items := as_list(value)) is not None:
            values.extend(str(item) for item in items)
    return " ".join(values)


def retrieve_product_extractor_rag_documents(
    query: str, *, state_dir: Path | str | None = None, limit: int = 8
) -> list[dict[str, Any]]:
    """Keep the synchronous managed-profile helper used by existing Python callers.

    The TypeScript-shaped runtime API is ``retrieve_product_extractor_rag_documents_with_runtime``;
    this helper intentionally retains its profile-state fallback and ``analysisPrompt`` row.
    """

    profile = _mapping(read_profile(state_dir=state_dir)) or {}
    query_tokens = set(_tokens(query))
    candidates: list[tuple[int, int, dict[str, Any]]] = []
    documents = as_list(profile.get("documents")) or []
    for index, raw_document in enumerate(documents):
        document = _mapping(raw_document) or {}
        content = str(document.get("content") or "")
        score = len(query_tokens & set(_tokens(content)))
        index_entry = _mapping(find_product_extractor_rag_index_entry(str(document.get("name") or ""))) or {}
        candidates.append(
            (
                score,
                index,
                {
                    "id": f"rag-document-{index + 1}",
                    "kind": index_entry.get("kind", "custom"),
                    "sourceDocument": document.get("name") or "",
                    "intents": index_entry.get("intents", ["general"]),
                    "fieldTargets": index_entry.get("fieldTargets", []),
                    "embeddingSnapshotKey": js_embedding_snapshot_key(content),
                    **document,
                    "text": content,
                },
            )
        )
    candidates.sort(key=lambda item: (-item[0], item[1]))
    selected = [item[2] for item in candidates if item[0] > 0][:limit]
    if len(selected) < limit and not selected:
        selected = [item[2] for item in candidates[:limit]]
    policy = {
        "id": "rag-profile-analysis-prompt",
        "kind": "analysisPrompt",
        "name": "analysis-prompt",
        "version": "v1",
        "sourceDocument": "analysis-prompt",
        "intents": ["orchestration"],
        "fieldTargets": ["geoProduct", "diagnostics"],
        "embeddingSnapshotKey": js_embedding_snapshot_key(str(profile.get("analysisPrompt") or "")),
        "text": str(profile.get("analysisPrompt") or ""),
    }
    return (selected + [policy])[:limit]


async def retrieve_product_extractor_rag_documents_with_runtime(input_: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Retrieve typed RAG chunks through local, Azure, and reranker boundaries."""

    query = str(input_.get("query") or "")
    raw_documents = as_list(input_.get("documents")) or []
    documents = [dict(item_mapping) for item in raw_documents if (item_mapping := _mapping(item)) is not None]
    if not documents:
        return []
    settings = _mapping(input_.get("settings")) or {}
    max_chunks = _integer(settings.get("maxChunks"), 6)
    score_threshold = _number(settings.get("scoreThreshold"), 0.06)
    chunks = [chunk for document in documents for chunk in _chunk_document(document)]
    if not chunks:
        return []
    callback = input_.get("onRuntimeStep") or input_.get("on_runtime_step")
    embedding = _mapping(input_.get("embedding"))
    scored = await _score_retrieved_chunks(query, chunks, embedding, callback)
    retrieved = [_retrieved_document(chunk) for chunk in scored]
    retrieved = [row for row in retrieved if float(row["score"]) >= score_threshold]
    retrieved.sort(key=lambda row: -float(row["score"]))
    retrieved = retrieved[: max(max_chunks * 3, max_chunks)]
    return await _rerank_retrieved_chunks(
        query,
        retrieved,
        _mapping(input_.get("reranker")),
        max_chunks,
        callback,
    )


async def retrieveProductExtractorRagDocuments(input_: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Camel-case async API matching ``retrieveProductExtractorRagDocuments``."""

    return await retrieve_product_extractor_rag_documents_with_runtime(input_)


async def _score_retrieved_chunks(
    query: str,
    chunks: list[dict[str, Any]],
    embedding: Mapping[str, Any] | None,
    callback: object,
) -> list[dict[str, Any]]:
    query_terms = _tokens(query)
    remote: tuple[list[list[float]], dict[str, int] | None] | None = None
    try:
        remote = await _create_azure_embeddings([query, *[str(chunk["content"]) for chunk in chunks]], embedding)
    except Exception:  # Provider transport failure intentionally falls back to local hybrid scoring.
        remote = None
    if remote:
        _vectors, usage = remote
        await _runtime_step(
            callback,
            {
                "stage": "embedding",
                "label": "Embedding",
                "provider": "aistudio" if embedding and embedding.get("provider") == "aistudio" else "azure-api",
                "service": "AI Studio model deployment" if embedding and embedding.get("provider") == "aistudio" else "Azure model deployment",
                **({"deployment": embedding["deployment"]} if embedding and embedding.get("deployment") else {}),
                **({"model": embedding["model"]} if embedding and embedding.get("model") else {}),
                "called": True,
                **({"tokenUsage": usage} if usage is not None else {}),
                "details": f"{len(chunks) + 1} texts embedded for extractor RAG retrieval.",
            },
        )
    remote_vectors = remote[0] if remote else None
    query_embedding = remote_vectors[0] if remote_vectors else _embed_text(query)
    scored: list[dict[str, Any]] = []
    for index, chunk in enumerate(chunks):
        lexical_score = _lexical_similarity(
            query_terms,
            _tokens(f"{chunk['sourceDocument']} {chunk.get('title') or ''} {chunk['content']}"),
        )
        semantic_embedding = remote_vectors[index + 1] if remote_vectors else _embed_text(str(chunk["content"]))
        semantic_score = _cosine_similarity(query_embedding, semantic_embedding)
        row = dict(chunk)
        row["score"] = _clamp((lexical_score * 0.5) + (semantic_score * 0.42) + _retrieval_boost(chunk), 0, 1)
        scored.append(row)
    return scored


def _retrieved_document(chunk: Mapping[str, Any]) -> dict[str, Any]:
    content = "\n".join(
        item
        for item in (
            f"Retrieved RAG policy chunk from {chunk['sourceDocument']}.",
            f"Section: {chunk['title']}" if chunk.get("title") else "",
            f"Kind: {chunk['kind']}.",
            f"Intents: {', '.join(chunk['intents'])}.",
            f"Field targets: {', '.join(chunk['fieldTargets'])}.",
            str(chunk["content"]),
        )
        if item
    )
    result: dict[str, Any] = {
        "name": f"{chunk['sourceDocument']}#{int(chunk['chunkIndex']) + 1}",
        "content": content,
        "score": chunk["score"],
        "sourceDocument": chunk["sourceDocument"],
        "chunkId": chunk["id"],
        "kind": chunk["kind"],
        "intents": chunk["intents"],
        "fieldTargets": chunk["fieldTargets"],
    }
    if chunk.get("version") is not None:
        result["version"] = chunk["version"]
    return result


def _chunk_document(document: Mapping[str, Any]) -> list[dict[str, Any]]:
    name = str(document.get("name", ""))
    version = document.get("version")
    chunks: list[dict[str, Any]] = []
    indexed_document = find_product_extractor_rag_index_entry(name)
    for index, section in enumerate(_split_markdown_sections(str(document.get("content", "")))):
        indexed_section = find_product_extractor_rag_section_entry(name, section.get("title"))
        kind = (indexed_document or {}).get("kind") or _kind_from_name(name)
        inferred = _infer_chunk_routing(kind, name, section.get("title"), section["text"])
        chunks.append(
            {
                "id": f"{_slug(name)}-{index + 1}",
                "sourceDocument": name,
                **({"title": section["title"]} if section.get("title") else {}),
                "content": section["text"],
                **({"version": version} if version is not None else {}),
                "chunkIndex": index,
                "kind": kind,
                "intents": (indexed_section or {}).get("intents") or (indexed_document or {}).get("intents") or inferred["intents"],
                "fieldTargets": (indexed_section or {}).get("fieldTargets")
                or (indexed_document or {}).get("fieldTargets")
                or inferred["fieldTargets"],
            }
        )
    return chunks


def _split_markdown_sections(content: str) -> list[dict[str, str]]:
    normalized = content.replace("\r\n", "\n").strip()
    if not normalized:
        return []
    sections: list[dict[str, str]] = []
    title: str | None = None
    buffer: list[str] = []
    for line in normalized.split("\n"):
        heading = re.match(r"^#{1,3}\s+(.+)$", line)
        if heading:
            text = "\n".join(buffer).strip()
            if text:
                sections.append({**({"title": title} if title else {}), "text": text})
            title = heading.group(1).strip()
            buffer = [line]
        else:
            buffer.append(line)
    text = "\n".join(buffer).strip()
    if text:
        sections.append({**({"title": title} if title else {}), "text": text})
    return [piece for section in sections for piece in _split_long_section(section)]


def _split_long_section(section: Mapping[str, str]) -> list[dict[str, str]]:
    if js_code_unit_length(section["text"]) <= 1100:
        return [dict(section)]
    paragraphs = re.split(r"\n{2,}", section["text"])
    chunks: list[dict[str, str]] = []
    current = ""
    for paragraph in paragraphs:
        if js_code_unit_length(f"{current}\n\n{paragraph}") > 1100 and current.strip():
            chunks.append({**({"title": section["title"]} if section.get("title") else {}), "text": current.strip()})
            current = paragraph
        else:
            current = "\n\n".join(item for item in (current, paragraph) if item)
    if current.strip():
        chunks.append({**({"title": section["title"]} if section.get("title") else {}), "text": current.strip()})
    return chunks


def _kind_from_name(name: str) -> str:
    if re.search(r"orchestrat|manifest|rag-index|rag-map", name, re.IGNORECASE):
        return "orchestration"
    if re.search(r"analysis-prompt", name, re.IGNORECASE):
        return "analysis-prompt"
    if re.search(r"product-normalization|normalization", name, re.IGNORECASE):
        return "product-normalization"
    if re.search(r"ocr|classification|keyword", name, re.IGNORECASE):
        return "ocr-classification"
    if re.search(r"review", name, re.IGNORECASE):
        return "review-extraction"
    if re.search(r"faq", name, re.IGNORECASE):
        return "faq-extraction"
    return "custom"


def _infer_chunk_routing(kind: str, source_document: str, title: str | None, content: str) -> dict[str, list[str]]:
    haystack = f"{source_document} {title or ''} {content}".lower()
    intents: list[str] = []
    targets: list[str] = []

    def add(values: list[str], value: str) -> None:
        if value not in values:
            values.append(value)

    if kind == "orchestration" or re.search(r"orchestration|routing|rag index|rag-index|coverage|conflict|overlap|missing|누락|충돌|중복", haystack):
        add(intents, "orchestration")
        add(intents, "diagnostics")
        add(targets, "diagnostics")
        add(targets, "rag.chunks")
    if kind == "analysis-prompt" or re.search(r"analysis prompt|base instruction|evidence-only|근거|정책", haystack):
        add(intents, "evidence")
        add(intents, "diagnostics")
        add(targets, "geoProduct")
        add(targets, "diagnostics")
    if kind == "product-normalization" or re.search(
        r"normalize|normalization|geoproduct|contentanalysis|section|field|schema-ready|정규화|분류", haystack
    ):
        add(intents, "normalization")
        add(intents, "schema-ready")
        add(targets, "geoProduct")
        add(targets, "contentAnalysis.sections")
        add(targets, "rag.chunks")
    if kind == "ocr-classification" or re.search(
        r"ocr|sentence|keyword|classification|benefit|effect|ingredient|usage|효능|효과|성분|사용법", haystack
    ):
        add(intents, "classification")
        add(intents, "evidence")
        add(targets, "ocr.sentenceInsights")
        add(targets, "benefits")
        add(targets, "effects")
        add(targets, "ingredients")
        add(targets, "usage")
    if re.search(r"exclude|cart|coupon|delivery|refund|legal|chrome|purchase|혜택|배송|교환|반품|환불|법적|장바구니", haystack):
        add(intents, "exclusion")
        add(targets, "diagnostics")
    if kind == "review-extraction" or re.search(r"review|rating|customer|texture|absorption|satisfaction|리뷰|평점|사용감|흡수감", haystack):
        add(intents, "review")
        add(intents, "evidence")
        add(targets, "reviews")
    if kind == "faq-extraction" or re.search(r"faq|question|answer|mainentity|q&a|질문|답변", haystack):
        add(intents, "faq")
        add(intents, "evidence")
        add(targets, "faq")
    if re.search(r"metric|clinical|survey|rating|count|\b\d+(?:\.\d+)?\s?%|임상|수치|만족도", haystack):
        add(intents, "evidence")
        add(targets, "metrics")
    if not intents:
        add(intents, "general")
    if not targets:
        add(targets, "geoProduct")
    return {"intents": intents, "fieldTargets": targets}


def _retrieval_boost(chunk: Mapping[str, Any]) -> float:
    text = f"{chunk['sourceDocument']} {chunk.get('title') or ''} {chunk['content']}"
    indexed_document = find_product_extractor_rag_index_entry(str(chunk["sourceDocument"]))
    indexed_section = find_product_extractor_rag_section_entry(str(chunk["sourceDocument"]), chunk.get("title"))
    boost = _number((indexed_section or {}).get("priority"), _number((indexed_document or {}).get("priority"), 0)) * 0.08
    if chunk["kind"] == "orchestration" or "orchestration" in chunk["intents"]:
        boost += 0.07
    if "classification" in chunk["intents"] or "ocr.sentenceInsights" in chunk["fieldTargets"]:
        boost += 0.06
    if "normalization" in chunk["intents"] or "geoProduct" in chunk["fieldTargets"]:
        boost += 0.04
    if "exclusion" in chunk["intents"]:
        boost += 0.06
    if re.search(r"ocr|sentence|classification|keyword", text, re.IGNORECASE):
        boost += 0.08
    if re.search(r"product|normalization|field|schema", text, re.IGNORECASE):
        boost += 0.05
    if re.search(r"review|faq|question|answer", text, re.IGNORECASE):
        boost += 0.04
    if re.search(r"exclude|cart|coupon|delivery|refund|legal|chrome|혜택|배송|반품", text, re.IGNORECASE):
        boost += 0.06
    return boost


def _tokens(text: str) -> list[str]:
    normalized = "".join(character if character.isalnum() or character.isspace() or character == "-" else " " for character in text.lower())
    return [token.strip() for token in re.split(r"\s+", normalized) if js_code_unit_length(token.strip()) >= 2]


def _embed_text(text: str) -> list[float]:
    vector = [0.0] * _MAX_LOCAL_VECTOR_SIZE
    for token in _tokens(text):
        index = js_fnv1a32(token) % len(vector)
        vector[index] += 1 / math.sqrt(max(js_code_unit_length(token), 1))
    magnitude = math.sqrt(sum(value * value for value in vector)) or 1
    return [value / magnitude for value in vector]


def _lexical_similarity(query_terms: Sequence[str], candidate_terms: Sequence[str]) -> float:
    if not query_terms or not candidate_terms:
        return 0
    candidate = set(candidate_terms)
    overlap = set(term for term in query_terms if term in candidate)
    return len(overlap) / math.sqrt(len(query_terms) * len(candidate))


def _cosine_similarity(left: Sequence[float], right: Sequence[float]) -> float:
    dot = sum(value * (right[index] if index < len(right) else 0) for index, value in enumerate(left))
    return _clamp((dot + 1) / 2, 0, 1)


async def _create_azure_embeddings(
    texts: list[str], embedding: Mapping[str, Any] | None
) -> tuple[list[list[float]], dict[str, int] | None] | None:
    provider = str((embedding or {}).get("provider") or "")
    is_aistudio = provider == "aistudio"
    if (
        provider not in {"azure-openai", "aistudio"}
        or not embedding
        or not embedding.get("apiKey")
        or not embedding.get("endpoint")
        or not embedding.get("deployment")
        or not texts
    ):
        return None
    endpoint = str(embedding["endpoint"]).rstrip("/")
    api_version = str(embedding.get("apiVersion") or "").strip()
    version_query = (
        f"?api-version={quote(api_version, safe=_ENCODE_COMPONENT_SAFE)}"
        if is_aistudio and api_version
        else ("" if is_aistudio else f"?api-version={quote(api_version or '2025-04-01-preview', safe=_ENCODE_COMPONENT_SAFE)}")
    )
    headers = {"Authorization": f"Bearer {embedding['apiKey']}"} if is_aistudio else {"api-key": str(embedding["apiKey"])}
    response = await _post_json(
        f"{endpoint}/openai/deployments/{quote(str(embedding['deployment']), safe=_ENCODE_COMPONENT_SAFE)}/embeddings{version_query}",
        headers={"Content-Type": "application/json", **headers},
        payload={"input": texts},
        transport=embedding.get("transport"),
    )
    if response is None or response.status_code >= 400:
        return None
    payload = _mapping(response.json())
    if payload is None:
        return None
    data = as_list(payload.get("data")) or []
    indexed: list[Mapping[str, Any]] = []
    for item in data:
        item_mapping = _mapping(item)
        if (
            item_mapping is not None
            and isinstance(item_mapping.get("index"), int)
            and not isinstance(item_mapping.get("index"), bool)
            and as_list(item_mapping.get("embedding")) is not None
        ):
            indexed.append(item_mapping)
    indexed.sort(key=lambda item: int(item["index"]))
    vectors = [
        [
            float(value)
            for value in (as_list(item.get("embedding")) or [])
            if isinstance(value, int | float) and not isinstance(value, bool)
        ]
        for item in indexed
    ]
    if len(vectors) != len(texts) or any(not vector for vector in vectors):
        return None
    usage = _token_usage(payload.get("usage"))
    return vectors, usage


async def _rerank_retrieved_chunks(
    query: str,
    retrieved: list[dict[str, Any]],
    reranker: Mapping[str, Any] | None,
    max_chunks: int,
    callback: object,
) -> list[dict[str, Any]]:
    initial = retrieved[:max_chunks]
    if not reranker or reranker.get("provider") == "local-hybrid":
        return initial
    provider = str(reranker.get("provider") or "")
    if provider in _COHERE_PROVIDERS and (
        not reranker.get("endpoint") or not reranker.get("apiKey") or len(retrieved) <= 1
    ):
        return initial
    if provider == "azure-ai-search-semantic" and (
        not reranker.get("endpoint") or not reranker.get("apiKey") or not reranker.get("indexName")
    ):
        return initial
    try:
        if provider == "azure-ai-search-semantic":
            reranked = await _retrieve_with_azure_ai_search_semantic(query, reranker, max_chunks)
        elif provider == "aistudio-bedrock-cohere":
            reranked = await _rerank_with_aistudio_bedrock(query, retrieved, reranker, max_chunks)
        else:
            reranked = await _rerank_with_cohere(query, retrieved, reranker, max_chunks)
    except Exception:  # Provider errors are deliberately non-fatal to local retrieval.
        reranked = None
    if reranked:
        service = (
            "Azure AI Search semantic ranker"
            if provider == "azure-ai-search-semantic"
            else ("AI Studio Bedrock Cohere Rerank" if provider == "aistudio-bedrock-cohere" else "Cohere Rerank")
        )
        await _runtime_step(
            callback,
            {
                "stage": "reranking",
                "label": "Reranking",
                "provider": provider,
                "service": service,
                **({"model": reranker["model"]} if provider in _COHERE_PROVIDERS and reranker.get("model") else {}),
                "called": True,
                "details": f"{len(retrieved)} candidates reranked to {min(max_chunks, len(reranked))} results.",
            },
        )
        return reranked
    return initial


async def _rerank_with_cohere(
    query: str, retrieved: list[dict[str, Any]], reranker: Mapping[str, Any], max_chunks: int
) -> list[dict[str, Any]] | None:
    endpoint = _normalize_cohere_endpoint(str(reranker.get("endpoint") or ""))
    response = await _post_json(
        endpoint,
        headers={
            "Authorization": f"Bearer {reranker.get('apiKey')}",
            "Content-Type": "application/json",
            "api-key": str(reranker.get("apiKey") or ""),
        },
        payload={
            **({"model": model} if (model := _string_field(reranker, ["model"])) else {}),
            "query": query,
            "documents": [document["content"] for document in retrieved],
            "top_n": max_chunks,
        },
        transport=reranker.get("transport"),
    )
    if response is None or response.status_code >= 400:
        return None
    payload = _mapping(response.json())
    results = as_list(payload.get("results")) if payload is not None else None
    output: list[dict[str, Any]] = []
    if results is not None:
        for result in results:
            result_mapping = _mapping(result)
            if result_mapping is None or not isinstance(result_mapping.get("index"), int) or isinstance(result_mapping.get("index"), bool):
                continue
            index = int(result_mapping["index"])
            if not (0 <= index < len(retrieved)):
                continue
            row = dict(retrieved[index])
            if isinstance(result_mapping.get("relevance_score"), int | float) and not isinstance(result_mapping.get("relevance_score"), bool):
                row["score"] = result_mapping["relevance_score"]
            output.append(row)
    output.sort(key=lambda row: -float(row["score"]))
    return output[:max_chunks]


async def _rerank_with_aistudio_bedrock(
    query: str, retrieved: list[dict[str, Any]], reranker: Mapping[str, Any], max_chunks: int
) -> list[dict[str, Any]] | None:
    endpoint = str(reranker.get("endpoint") or "").strip().rstrip("/")
    model = str(reranker.get("model") or "").strip() or "cohere.rerank-v3-5:0"
    response = await _post_json(
        f"{endpoint}/model/{quote(model, safe=_ENCODE_COMPONENT_SAFE)}/invoke",
        headers={"Authorization": f"Bearer {reranker.get('apiKey') or ''}", "Content-Type": "application/json"},
        payload={"query": query, "documents": [document["content"] for document in retrieved], "top_n": max_chunks, "api_version": 2},
        transport=reranker.get("transport"),
    )
    if response is None or response.status_code >= 400:
        return None
    return _rows_from_rerank_results(response.json(), retrieved, max_chunks)


async def _retrieve_with_azure_ai_search_semantic(
    query: str, reranker: Mapping[str, Any], max_chunks: int
) -> list[dict[str, Any]] | None:
    endpoint = str(reranker.get("endpoint") or "").rstrip("/")
    index_name = str(reranker.get("indexName") or "")
    response = await _post_json(
        f"{endpoint}/indexes/{quote(index_name, safe=_ENCODE_COMPONENT_SAFE)}/docs/search?api-version=2024-07-01",
        headers={"Content-Type": "application/json", "api-key": str(reranker.get("apiKey") or "")},
        payload={
            "search": query,
            "queryType": "semantic",
            "semanticConfiguration": reranker.get("semanticConfiguration") or "default",
            "queryLanguage": reranker.get("queryLanguage") or "ko-kr",
            "top": max_chunks,
        },
        transport=reranker.get("transport"),
    )
    if response is None or response.status_code >= 400:
        return None
    payload = _mapping(response.json())
    values = as_list(payload.get("value")) if payload is not None else None
    output: list[dict[str, Any]] = []
    if values is not None:
        for index, item in enumerate(values):
            item_mapping = _mapping(item)
            if item_mapping is None:
                continue
            content = _string_field(item_mapping, ["content", "text", "chunk", "chunkText", "body", "description"]) or _longest_string_field(item_mapping)
            if not content:
                continue
            source_document = _string_field(item_mapping, ["sourceDocument", "source", "filename", "title", "id"]) or "azure-ai-search"
            kind = _kind_from_name(source_document)
            inferred = _infer_chunk_routing(kind, source_document, None, content)
            output.append(
                {
                    "name": f"{source_document}#{index + 1}",
                    "content": content,
                    "score": _number_field(item_mapping, ["@search.rerankerScore", "@search.score"]) or 0,
                    "sourceDocument": source_document,
                    "chunkId": _string_field(item, ["chunkId", "id", "key"]) or f"azure-ai-search-{index + 1}",
                    "kind": kind,
                    **inferred,
                }
            )
    return output[:max_chunks]


def _rows_from_rerank_results(payload: object, retrieved: list[dict[str, Any]], max_chunks: int) -> list[dict[str, Any]] | None:
    payload_mapping = _mapping(payload)
    results = as_list(payload_mapping.get("results")) if payload_mapping is not None else None
    output: list[dict[str, Any]] = []
    if results is not None:
        for result in results:
            result_mapping = _mapping(result)
            if result_mapping is None or not isinstance(result_mapping.get("index"), int) or isinstance(result_mapping.get("index"), bool):
                continue
            index = int(result_mapping["index"])
            if not (0 <= index < len(retrieved)):
                continue
            row = dict(retrieved[index])
            if isinstance(result_mapping.get("relevance_score"), int | float) and not isinstance(result_mapping.get("relevance_score"), bool):
                row["score"] = result_mapping["relevance_score"]
            output.append(row)
    output.sort(key=lambda row: -float(row["score"]))
    return output[:max_chunks]


def _normalize_cohere_endpoint(endpoint: str) -> str:
    trimmed = endpoint.strip().rstrip("/")
    return trimmed if re.search(r"/rerank(?:\?|$)", trimmed, re.IGNORECASE) else f"{trimmed}/v2/rerank"


async def _post_json(
    url: str, *, headers: Mapping[str, str], payload: Mapping[str, Any], transport: object
) -> httpx.Response | None:
    # JavaScript fetch follows HTTP redirects by default.  The remote RAG
    # adapters use the same wire behavior for Azure embeddings and Cohere
    # reranking endpoints, including endpoints that front a deployment URL.
    kwargs: dict[str, Any] = {"timeout": 60.0, "follow_redirects": True}
    if isinstance(transport, httpx.AsyncBaseTransport):
        kwargs["transport"] = transport
    async with httpx.AsyncClient(**kwargs) as client:
        return await client.post(url, headers=dict(headers), content=js_json_bytes(dict(payload)))


async def _runtime_step(callback: object, step: dict[str, Any]) -> None:
    if not callable(callback):
        return
    value = callback(step)
    if inspect.isawaitable(value):
        await value


def _mapping(value: object) -> Mapping[str, Any] | None:
    mapping = as_mapping(value)
    if mapping is not None:
        return mapping
    if not hasattr(value, "model_dump"):
        return None
    dumped = cast(_ModelDumpable, value).model_dump(by_alias=True, exclude_none=True)
    return as_mapping(dumped)


def _number(value: object, default: float) -> float:
    return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else default


def _integer(value: object, default: int) -> int:
    return int(value) if isinstance(value, int | float) and not isinstance(value, bool) else default


def _token_usage(value: object) -> dict[str, int] | None:
    mapping = _mapping(value)
    if mapping is None:
        return None
    usage: dict[str, int] = {}
    if isinstance(mapping.get("prompt_tokens"), int | float) and not isinstance(mapping.get("prompt_tokens"), bool):
        usage["inputTokens"] = int(mapping["prompt_tokens"])
    if isinstance(mapping.get("total_tokens"), int | float) and not isinstance(mapping.get("total_tokens"), bool):
        usage["totalTokens"] = int(mapping["total_tokens"])
    return usage or None


def _string_field(item: Mapping[str, Any], keys: Sequence[str]) -> str | None:
    for key in keys:
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _number_field(item: Mapping[str, Any], keys: Sequence[str]) -> float | None:
    for key in keys:
        value = item.get(key)
        if isinstance(value, int | float) and not isinstance(value, bool):
            return float(value)
    return None


def _longest_string_field(item: Mapping[str, Any]) -> str | None:
    values = [
        value.strip()
        for key, value in item.items()
        if not str(key).startswith("@search.") and isinstance(value, str) and value.strip()
    ]
    return sorted(values, key=len, reverse=True)[0] if values else None


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return min(maximum, max(minimum, value))


def _slug(value: str) -> str:
    return re.sub(r"^-+|-+$", "", re.sub(r"[^a-z0-9]+", "-", value.lower())) or "rag"
