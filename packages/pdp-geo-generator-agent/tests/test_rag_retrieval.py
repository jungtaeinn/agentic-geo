from __future__ import annotations

import asyncio
import base64
import hashlib

import httpx
from pytest import MonkeyPatch

from pdp_geo_generator_agent.rag.retrieval import (
    DEFAULT_PDP_GEO_RAG_MAX_CHUNKS,
    LocalVersionedRagRetriever,
    OpenAiVectorStoreRetriever,
    create_pdp_geo_rag_query,
    create_pdp_geo_rag_query_plan,
    resolve_pdp_geo_rag_settings,
    retrieve_pdp_geo_rag_chunks,
)

PRODUCT = {
    "name": "Hydra Barrier Cream",
    "brand": "Example Beauty",
    "category": "Moisturizer",
    "benefits": ["hydration", "skin barrier support"],
    "ingredients": ["Ceramide", "Panthenol"],
    "usage": ["Apply after serum."],
    "reviews": {"keywords": ["lightweight"]},
}


def test_openai_vector_store_retriever_posts_pinned_node24_bytes(monkeypatch: MonkeyPatch) -> None:
    """The managed-vector-store boundary keeps the legacy compact UTF-8 wire.

    Captured with Node v24.11.0 ``JSON.stringify`` from the retained generator
    source baseline (origin/main, 6702158280ec7de675594af93c7c381eb2feae38).
    """

    calls: list[tuple[str, str | None, str | None, bytes]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        calls.append(
            (
                str(request.url),
                request.headers.get("authorization"),
                request.headers.get("content-type"),
                request.content,
            )
        )
        return httpx.Response(200, json={"data": []})

    transport = httpx.MockTransport(handler)
    original_client = httpx.AsyncClient

    def client_with_transport() -> httpx.AsyncClient:
        return original_client(transport=transport)

    monkeypatch.setattr(httpx, "AsyncClient", client_with_transport)
    result = asyncio.run(
        OpenAiVectorStoreRetriever("vector-key").retrieve(
            {
                "query": "x\ud800",
                "settings": {
                    "vectorStoreId": "store-id",
                    "managedSearchEndpoint": "https://vector.example.test/search",
                    "maxChunks": 4,
                    "rewriteQuery": True,
                },
            }
        )
    )

    expected = base64.b64decode("eyJxdWVyeSI6InhcdWQ4MDAiLCJtYXhfbnVtX3Jlc3VsdHMiOjQsInJld3JpdGVfcXVlcnkiOnRydWV9")
    assert result == []
    assert calls == [("https://vector.example.test/search", "Bearer vector-key", "application/json", expected)]
    assert hashlib.sha256(expected).hexdigest() == "5be4f1bc9e40a02e2809dab1c66b804f8773518abebe2deab1b52bcfe04543f7"


def test_query_keeps_contract_anchors_without_rule_shaped_language() -> None:
    query = create_pdp_geo_rag_query(PRODUCT, "en-US", "US")
    assert "description composition contract" in query
    assert "answer-ready FAQ intent" in query
    assert "must" not in query.lower()
    assert resolve_pdp_geo_rag_settings({})["maxChunks"] == DEFAULT_PDP_GEO_RAG_MAX_CHUNKS
    plan = create_pdp_geo_rag_query_plan(PRODUCT, "en-US", "US", {"queryPlanning": {"updateTargets": ["faq"]}})
    assert [item["target"] for item in plan["queries"]] == ["general", "faq"]


def test_local_retriever_uses_complete_provider_batch_or_hash_fallback() -> None:
    documents = [
        {"name": "partial-a.md", "content": "# Alpha\n\npartialalpha marker paragraph", "version": "v1"},
        {"name": "partial-b.md", "content": "# Beta\n\npartialbeta marker paragraph", "version": "v1"},
    ]
    request = {
        "query": "partial batch probe",
        "product": PRODUCT,
        "locale": "en-US",
        "market": "US",
        "documents": documents,
        "settings": resolve_pdp_geo_rag_settings({"maxChunks": 2, "scoreThreshold": 0}),
    }

    class PartialEmbedder:
        async def embed(self, texts: list[str]) -> list[list[float]]:
            return [[] if "partialbeta" in text else [1, 0] for text in texts]

    baseline = asyncio.run(LocalVersionedRagRetriever().retrieve(request))
    partial = asyncio.run(LocalVersionedRagRetriever(PartialEmbedder()).retrieve(request))
    assert {row["source"]: row["metadata"]["semanticScore"] for row in partial} == {
        row["source"]: row["metadata"]["semanticScore"] for row in baseline
    }


def test_local_retriever_retains_repeated_query_terms_without_terminology_expansion() -> None:
    """TS returns raw tokens when no terminology map exists; duplicates affect its hash vector."""

    rows = asyncio.run(
        LocalVersionedRagRetriever().retrieve(
            {
                "query": "ceramide ceramide hydration",
                "product": {"name": "Hydra"},
                "locale": "en-US",
                "documents": [{"name": "custom.md", "content": "# Signal\n\nCeramide hydration guidance.", "version": "v1"}],
                "settings": resolve_pdp_geo_rag_settings({"maxChunks": 1, "scoreThreshold": 0}),
            }
        )
    )

    # Frozen direct output from LocalVersionedRagRetriever in retrieval.ts.
    assert rows[0]["metadata"]["semanticScore"] == 0.5845


def test_local_retrieval_expands_referenced_urls_only_through_the_supplied_resolver() -> None:
    """URL-backed RAG material is opt-in and never fetched behind a custom resolver boundary."""

    calls: list[dict[str, object]] = []

    class Resolver:
        async def resolve(self, request: dict[str, object]) -> dict[str, object]:
            calls.append(request)
            return {
                "url": request["url"],
                "title": "Official study",
                "content": "Ceramide support is documented in this official study.",
                "sourceType": "article",
            }

    rows = asyncio.run(
        retrieve_pdp_geo_rag_chunks(
            {
                "query": "official ceramide study",
                "product": PRODUCT,
                "locale": "en-US",
                "market": "US",
                "documents": [
                    {
                        "name": "guidance.md",
                        "content": "See https://research.example.test/study for source context.",
                        "version": "v1",
                    }
                ],
                "settings": resolve_pdp_geo_rag_settings(
                    {"resolveUrls": True, "allowedUrlDomains": ["research.example.test"], "scoreThreshold": 0}
                ),
            },
            {"customUrlResolver": Resolver()},
        )
    )

    assert calls == [
        {
            "url": "https://research.example.test/study",
            "sourceDocumentName": "guidance.md",
            "sourceDocumentVersion": "v1",
        }
    ]
    assert any(row["source"] == "https://research.example.test/study" for row in rows)
