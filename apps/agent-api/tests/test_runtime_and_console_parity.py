from __future__ import annotations

import math

import httpx
import pytest
from conftest import AppFactory, object_mapping
from fastapi import FastAPI
from neo_agent_api.main import runtime_from_settings
from neo_agent_api.services.console_orchestration import build_extractor_options, runtime_config
from neo_agent_api.services.queue import GeoQueue
from neo_agent_api.settings import Settings


async def _client(app: FastAPI) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver")


def test_settings_exposes_the_retained_provider_runtime_surface() -> None:
    settings = Settings.from_env(
        {
            "AGENTIC_GEO_PROVIDER": "azure-openai",
            "AZURE_OPENAI_API_KEY": "azure-key",
            "AZURE_OPENAI_ENDPOINT": "https://example.openai.azure.com",
            "AZURE_OPENAI_REASONING_DEPLOYMENT": "reasoning",
            "AZURE_OPENAI_OCR_DEPLOYMENT": "vision",
            "AZURE_OPENAI_EMBEDDING_DEPLOYMENT": "embedding",
            "AZURE_OPENAI_EMBEDDING_ENDPOINT": "https://embeddings.openai.azure.com",
            "AZURE_OPENAI_EMBEDDING_API_KEY": "embedding-key",
            "AZURE_OPENAI_EMBEDDING_API_VERSION": "2025-04-01-preview",
            "AZURE_OPENAI_PROOFREADING_DEPLOYMENT": "proofread",
            "AZURE_OPENAI_API_VERSION": "2025-04-01-preview",
            "AZURE_OPENAI_TEMPERATURE": "0.3",
            "AGENTIC_GEO_PRODUCT_NORMALIZATION": "false",
            "AGENTIC_GEO_RERANKER_PROVIDER": "cohere",
            "AZURE_COHERE_RERANK_API_KEY": "reranker-key",
            "AZURE_COHERE_RERANK_ENDPOINT": "https://rerank.example.com",
            "AZURE_COHERE_RERANK_MODEL": "rerank-v3",
        }
    )

    generator = settings.generator_runtime()
    extractor = settings.extractor_runtime()

    assert generator["provider"] == "azure-openai"
    assert generator["apiKey"] == "azure-key"
    assert generator["deployment"] == "reasoning"
    assert generator["deployments"] == {
        "ocr": "vision",
        "reasoning": "reasoning",
        "embedding": "embedding",
        "proofreading": "proofread",
    }
    assert generator["embedding"] == {
        "provider": "azure-openai",
        "apiKey": "embedding-key",
        "endpoint": "https://embeddings.openai.azure.com",
        "deployment": "embedding",
        "apiVersion": "2025-04-01-preview",
    }
    reranker = generator["reranker"]
    assert object_mapping(reranker)["model"] == "rerank-v3"
    assert generator["temperature"] == 0.3
    product_normalization = generator["productNormalization"]
    assert object_mapping(product_normalization)["enabled"] is False
    final_proofreading = generator["finalProofreading"]
    assert object_mapping(final_proofreading)["deployment"] == "proofread"
    assert extractor["deployments"] == {"ocr": "vision", "reasoning": "reasoning", "embedding": "embedding"}


def test_generate_runtime_uses_the_selected_provider_env_defaults_not_the_active_provider_key() -> None:
    settings = Settings.from_env(
        {
            "AGENTIC_GEO_PROVIDER": "azure-openai",
            "AZURE_OPENAI_API_KEY": "azure-key",
            "AZURE_OPENAI_ENDPOINT": "https://azure.example.com",
            "AZURE_OPENAI_DEPLOYMENT": "azure-chat",
            "OPENAI_API_KEY": "openai-key",
            "OPENAI_MODEL": "gpt-5",
            "GEMINI_API_KEY": "gemini-key",
            "GEMINI_MODEL": "gemini-3-pro",
        }
    )

    runtime = runtime_from_settings(settings)
    resolved = runtime_config({"llm": {"provider": "gemini"}}, runtime)

    provider_defaults = runtime["_providerDefaults"]
    openai_defaults = object_mapping(provider_defaults)["openai"]
    assert object_mapping(openai_defaults)["apiKey"] == "openai-key"
    assert resolved["provider"] == "gemini"
    assert resolved["apiKey"] == "gemini-key"
    assert resolved["model"] == "gemini-3-pro"


@pytest.mark.parametrize("value", [math.inf, -math.inf, math.nan])
def test_queue_rejects_non_finite_backoff(value: float) -> None:
    with pytest.raises(ValueError, match="finite"):
        GeoQueue(backoff_ms=value)


@pytest.mark.asyncio
async def test_disabled_sync_endpoint_uses_the_nest_not_found_envelope(app_factory: AppFactory) -> None:
    app = app_factory(sync_enabled=False)
    async with await _client(app) as client:
        response = await client.post("/internal/v1/geo/test-generations", json={"locale": "ko-KR", "product": {}})

    assert response.status_code == 404
    assert response.json() == {"message": "Not Found", "error": "Not Found", "statusCode": 404}


@pytest.mark.asyncio
async def test_rag_profile_uses_the_next_json_content_type(client: httpx.AsyncClient) -> None:
    response = await client.get("/rag-profile")

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/json; charset=utf-8"


@pytest.mark.asyncio
async def test_browser_function_seams_accept_and_return_the_direct_function_shapes(client: httpx.AsyncClient) -> None:
    mock = await client.post("/mock", json=["https://example.com/pdp"])
    evaluation = await client.post(
        "/evaluation",
        json={"jsonLd": {"@type": "Product"}, "diagnostics": {}, "language": "ko"},
    )

    assert mock.status_code == 200
    assert isinstance(mock.json(), list)
    assert set(mock.json()[0]) == {"result", "diagnostics"}
    assert evaluation.status_code == 200
    assert "overallScore" in evaluation.json()
    assert "report" not in evaluation.json()


@pytest.mark.asyncio
async def test_citation_probe_request_keeps_the_next_per_result_skip_diagnostic(client: httpx.AsyncClient) -> None:
    response = await client.post(
        "/generate",
        json={"product": {"name": "Serum"}, "citationProbe": {"enabled": True}},
    )

    assert response.status_code == 200
    assert response.json()["results"][0]["citationProbeError"] == (
        "Citation probe skipped: it requires a non-mock provider with credentials "
        "(and endpoint/deployment for Azure/AI Studio)."
    )


@pytest.mark.asyncio
async def test_citation_probe_enablement_uses_javascript_truthiness(client: httpx.AsyncClient) -> None:
    """An empty array is truthy in the retained Next handler, unlike Python."""

    response = await client.post(
        "/generate",
        json={"product": {"name": "Serum"}, "citationProbe": {"enabled": []}},
    )

    assert response.status_code == 200
    assert response.json()["results"][0]["citationProbeError"] == (
        "Citation probe skipped: it requires a non-mock provider with credentials "
        "(and endpoint/deployment for Azure/AI Studio)."
    )


@pytest.mark.asyncio
async def test_generate_stream_selection_uses_javascript_truthiness(client: httpx.AsyncClient) -> None:
    """A JSON array is truthy in the retained Next route even though Python treats it as false."""

    response = await client.post("/generate", json={"stream": [], "product": {"name": "Serum"}})

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/x-ndjson; charset=utf-8"
    assert response.text.splitlines()[-1].startswith('{"type":"result"')


def test_source_extractor_rag_documents_keep_only_the_console_wire_fields() -> None:
    """The source route maps extractorRag documents before giving them to the agent."""

    async def progress(_event: dict[str, object]) -> None:
        return None

    options = build_extractor_options(
        {
            "extractorRag": {
                "documents": [
                    {"name": "extract.md", "content": "context", "version": "private-version", "ignored": True}
                ]
            }
        },
        {},
        None,
        progress,
    )

    assert options["ragDocuments"] == [{"name": "extract.md", "content": "context"}]
