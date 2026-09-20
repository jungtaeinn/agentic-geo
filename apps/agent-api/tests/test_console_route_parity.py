from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from neo_agent_api.main import create_app
from neo_agent_api.settings import Settings


class _ProcessingRepository:
    async def find_status(self, _generation_id: str) -> str:
        return "PROCESSING"


class _Queue:
    def waiting_count(self) -> int:
        return 0

    async def add(self, _data: Mapping[str, Any]) -> None:
        return None


class _Generation:
    async def generate(self, _data: Mapping[str, Any]) -> dict[str, Any]:
        return {}


class _Profiles:
    async def read_extractor(self) -> dict[str, Any]:
        return {
            "analysisPrompt": "extractor profile prompt",
            "documents": [{"name": "extract.md", "version": "v1", "content": "extract context"}],
        }

    async def read_generator(self) -> dict[str, Any]:
        return {
            "analysisPrompt": "generator profile prompt",
            "documents": [{"name": "generator.md", "version": "v2", "content": "generator context"}],
        }

    async def write_extractor(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        return dict(payload)

    async def write_generator(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        return dict(payload)

    async def reset_extractor(self) -> dict[str, Any]:
        return {}

    async def reset_generator(self) -> dict[str, Any]:
        return {}


def _app(*, settings: Settings | None = None) -> FastAPI:
    return create_app(
        settings=settings or Settings(database_url="postgresql+psycopg://unused:unused@localhost:1/unused"),
        generation_repository=_ProcessingRepository(),
        queue=_Queue(),
        generation_service=_Generation(),
        profiles=_Profiles(),
    )


@pytest.mark.asyncio
async def test_console_rest_routes_inject_the_saved_profile_before_calling_python_agents(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: list[dict[str, Any]] = []

    def extractor_handler(config: dict[str, Any]):
        captured.append(config)

        async def handle(_method: str, _body: object) -> dict[str, Any]:
            return {
                "status": 200,
                "payload": {"ok": True},
                "headers": {"content-type": "application/json; charset=utf-8"},
            }

        return handle

    def generator_handler(config: dict[str, Any]):
        captured.append(config)

        async def handle(_request: object) -> dict[str, Any]:
            return {"status": 200, "body": {"ok": True}, "headers": {"content-type": "application/json; charset=utf-8"}}

        return handle

    monkeypatch.setattr(
        "neo_agent_api.services.console_orchestration.create_product_extractor_rest_handler", extractor_handler
    )
    monkeypatch.setattr(
        "neo_agent_api.services.console_orchestration.create_pdp_geo_generator_rest_handler", generator_handler
    )
    app = _app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
        assert (await client.post("/extract", json={"source": "https://example.com"})).status_code == 200
        assert (await client.post("/generator", json={"product": {"name": "Serum"}})).status_code == 200

    assert captured[0]["analysisPrompt"] == "extractor profile prompt"
    assert captured[0]["ragDocuments"] == [{"name": "extract.md", "content": "extract context"}]
    assert captured[1]["analysisPrompt"] == "generator profile prompt"
    assert captured[1]["ragDocuments"] == [{"name": "generator.md", "content": "generator context", "version": "v2"}]


@pytest.mark.asyncio
async def test_console_adapters_keep_their_distinct_retained_next_environment_mappings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The standalone extractor and generator routes intentionally resolve env values differently."""

    captured: list[dict[str, Any]] = []

    def extractor_handler(config: dict[str, Any]):
        captured.append(config)

        async def handle(_method: str, _body: object) -> dict[str, Any]:
            return {"status": 200, "payload": {"ok": True}, "headers": {}}

        return handle

    def generator_handler(config: dict[str, Any]):
        captured.append(config)

        async def handle(_request: object) -> dict[str, Any]:
            return {"status": 200, "body": {"ok": True}, "headers": {}}

        return handle

    monkeypatch.setattr(
        "neo_agent_api.services.console_orchestration.create_product_extractor_rest_handler", extractor_handler
    )
    monkeypatch.setattr(
        "neo_agent_api.services.console_orchestration.create_pdp_geo_generator_rest_handler", generator_handler
    )
    app = _app(
        settings=Settings(
            provider="azure-openai",
            openai_api_key="openai-first-key",
            openai_model="openai-first-model",
            gemini_api_key="gemini-key",
            gemini_model="gemini-model",
            azure_openai_api_key="azure-key",
            azure_openai_endpoint="https://azure.example.com",
            azure_openai_deployment="azure-default",
            azure_openai_reasoning_deployment="azure-reasoning",
            azure_openai_ocr_deployment="azure-ocr",
            azure_openai_embedding_deployment="azure-embedding",
            azure_openai_api_version="2025-04-01-preview",
            database_url="postgresql+psycopg://unused:unused@localhost:1/unused",
        )
    )
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
        assert (await client.post("/extract", json={"sources": ["https://example.com"]})).status_code == 200
        assert (await client.post("/generator", json={"product": {"name": "Serum"}})).status_code == 200

    # The extractor source route deliberately uses the first configured shared key/model,
    # while the generator source route resolves the selected provider.
    assert captured[0]["apiKey"] == "openai-first-key"
    assert captured[0]["model"] == "openai-first-model"
    assert captured[0]["deployment"] == "azure-default"
    assert captured[1]["apiKey"] == "azure-key"
    assert captured[1]["model"] == "azure-reasoning"
    assert captured[1]["deployment"] == "azure-reasoning"


@pytest.mark.asyncio
async def test_generate_rejects_untrusted_endpoint_override_with_the_next_route_400_status() -> None:
    app = _app(
        settings=Settings(
            provider="azure-openai",
            azure_openai_api_key="server-managed-key",
            azure_openai_endpoint="https://configured.example.com",
            database_url="postgresql+psycopg://unused:unused@localhost:1/unused",
        )
    )
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
        response = await client.post(
            "/generate",
            json={"product": {"name": "Serum"}, "llm": {"endpoint": "https://untrusted.example.com"}},
        )

    assert response.status_code == 400
    assert response.json() == {
        "error": (
            "llm.endpoint cannot override the configured provider endpoint while using a server-managed API key. "
            "Supply the matching request API key or use the configured endpoint."
        )
    }


@pytest.mark.asyncio
async def test_extract_rejects_untrusted_endpoint_overrides_before_creating_agent_handler(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    created_handlers: list[dict[str, Any]] = []

    def extractor_handler(config: dict[str, Any]):
        created_handlers.append(config)

        async def handle(_method: str, _body: object) -> dict[str, Any]:
            return {"status": 200, "payload": {"ok": True}, "headers": {}}

        return handle

    monkeypatch.setattr(
        "neo_agent_api.services.console_orchestration.create_product_extractor_rest_handler", extractor_handler
    )
    app = _app(
        settings=Settings(
            provider="azure-openai",
            azure_openai_api_key="server-managed-key",
            azure_openai_endpoint="https://configured.example.com",
            database_url="postgresql+psycopg://unused:unused@localhost:1/unused",
        )
    )
    untrusted_requests = [
        {"sources": ["https://example.com"], "llm": {"endpoint": "https://attacker.example"}},
        {
            "sources": ["https://example.com"],
            "llm": {"productNormalization": {"endpoint": "https://attacker.example"}},
        },
    ]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
        for body in untrusted_requests:
            response = await client.post("/extract", json=body)
            assert response.status_code == 400
            assert "server-managed API key" in response.json()["error"]

    assert created_handlers == []


@pytest.mark.asyncio
async def test_extract_allows_configured_and_caller_owned_endpoint_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    created_handlers: list[dict[str, Any]] = []

    def extractor_handler(config: dict[str, Any]):
        created_handlers.append(config)

        async def handle(_method: str, _body: object) -> dict[str, Any]:
            return {"status": 200, "payload": {"ok": True}, "headers": {}}

        return handle

    monkeypatch.setattr(
        "neo_agent_api.services.console_orchestration.create_product_extractor_rest_handler", extractor_handler
    )
    app = _app(
        settings=Settings(
            provider="azure-openai",
            azure_openai_api_key="server-managed-key",
            azure_openai_endpoint="https://configured.example.com",
            database_url="postgresql+psycopg://unused:unused@localhost:1/unused",
        )
    )
    allowed_requests = [
        {
            "sources": ["https://example.com"],
            "llm": {"endpoint": "https://configured.example.com/"},
        },
        {
            "sources": ["https://example.com"],
            "llm": {"productNormalization": {"endpoint": "https://configured.example.com/"}},
        },
        {
            "sources": ["https://example.com"],
            "llm": {"apiKey": "caller-key", "endpoint": "https://attacker.example"},
        },
        {
            "sources": ["https://example.com"],
            "llm": {"productNormalization": {"apiKey": "caller-key", "endpoint": "https://attacker.example"}},
        },
    ]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
        for body in allowed_requests:
            response = await client.post("/extract", json=body)
            assert response.status_code == 200

    assert len(created_handlers) == len(allowed_requests)


@pytest.mark.asyncio
async def test_generate_rejects_untrusted_managed_search_endpoint_before_orchestration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    generated: list[dict[str, Any]] = []

    async def run_generate_stub(_body: Mapping[str, Any], **_: object) -> dict[str, Any]:
        generated.append({})
        return {"results": [{"name": "unexpected"}], "logs": [], "failures": []}

    monkeypatch.setattr("neo_agent_api.api.console.run_generate", run_generate_stub)
    app = _app(
        settings=Settings(
            provider="openai",
            openai_api_key="server-managed-key",
            openai_model="gpt-test",
            openai_vector_store_id="configured-store",
            database_url="postgresql+psycopg://unused:unused@localhost:1/unused",
        )
    )
    body = {
        "product": {"name": "Serum"},
        "rag": {
            "mode": "managed-vector-store-rag",
            "provider": "openai",
            "managedSearchEndpoint": "https://attacker.example/search",
        },
    }

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
        response = await client.post("/generate", json=body)

    assert response.status_code == 400
    assert "rag.managedSearchEndpoint" in response.json()["error"]
    assert generated == []


@pytest.mark.asyncio
async def test_generator_rejects_untrusted_managed_search_endpoint_before_generation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    generated: list[dict[str, Any]] = []

    async def generate_stub(input_: dict[str, Any], runtime: dict[str, Any]) -> dict[str, Any]:
        generated.append({"input": input_, "runtime": runtime})
        return {"result": {}, "diagnostics": {}, "process": []}

    monkeypatch.setattr("pdp_geo_generator_agent.rest.generate_pdp_geo", generate_stub)
    app = _app(
        settings=Settings(
            provider="openai",
            openai_api_key="server-managed-key",
            openai_model="gpt-test",
            openai_vector_store_id="configured-store",
            database_url="postgresql+psycopg://unused:unused@localhost:1/unused",
        )
    )
    body = {
        "product": {"name": "Serum"},
        "rag": {
            "mode": "managed-vector-store-rag",
            "provider": "openai",
            "managedSearchEndpoint": "https://attacker.example/search",
        },
    }

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
        response = await client.post("/generator", json=body)

    assert response.status_code == 400
    assert "rag.managedSearchEndpoint" in response.json()["error"]
    assert generated == []


@pytest.mark.asyncio
async def test_generate_allows_default_managed_search_and_caller_owned_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtimes: list[dict[str, Any]] = []

    async def run_generate_stub(_body: Mapping[str, Any], *, runtime: Mapping[str, Any], **_: object) -> dict[str, Any]:
        runtimes.append(dict(runtime))
        return {"results": [{"name": "Serum"}], "logs": [], "failures": []}

    monkeypatch.setattr("neo_agent_api.api.console.run_generate", run_generate_stub)
    app = _app(
        settings=Settings(
            provider="openai",
            openai_api_key="server-managed-key",
            openai_model="gpt-test",
            openai_vector_store_id="configured-store",
            database_url="postgresql+psycopg://unused:unused@localhost:1/unused",
        )
    )
    allowed_requests = [
        {
            "product": {"name": "Serum"},
            "rag": {
                "mode": "managed-vector-store-rag",
                "provider": "openai",
                "managedSearchEndpoint": "https://api.openai.com/v1/vector_stores/configured-store/search/",
            },
        },
        {
            "product": {"name": "Serum"},
            "llm": {"apiKey": "caller-key"},
            "rag": {
                "mode": "managed-vector-store-rag",
                "provider": "openai",
                "managedSearchEndpoint": "https://attacker.example/search",
            },
        },
    ]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
        for body in allowed_requests:
            response = await client.post("/generate", json=body)
            assert response.status_code == 200

    assert [runtime["apiKey"] for runtime in runtimes] == ["server-managed-key", "caller-key"]


@pytest.mark.asyncio
async def test_extract_keeps_the_python_agent_rest_adapter_400_payload_and_content_type() -> None:
    app = _app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
        response = await client.post("/extract", json={})

    assert response.status_code == 400
    assert response.headers["content-type"] == "application/json; charset=utf-8"
    assert response.json() == {"error": "At least one source is required."}


@pytest.mark.asyncio
async def test_generator_keeps_the_python_agent_rest_adapter_400_payload_and_content_type() -> None:
    app = _app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
        response = await client.post("/generator", json={})

    assert response.status_code == 400
    assert response.headers["content-type"] == "application/json; charset=utf-8"
    assert response.json() == {"error": "At least one product JSON payload is required."}


@pytest.mark.asyncio
async def test_console_rest_routes_keep_the_source_adapter_405_response() -> None:
    app = _app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
        extract = await client.get("/extract")
        generator = await client.get("/generator")

    assert extract.status_code == generator.status_code == 405
    assert extract.headers["content-type"] == generator.headers["content-type"] == "application/json; charset=utf-8"
    assert extract.json() == generator.json() == {"error": "Method not allowed. Use POST."}


@pytest.mark.asyncio
async def test_pages_cors_preflight_enforces_configured_origin_allowlist() -> None:
    allowed_origin = "https://console.example"
    settings = Settings.from_env(
        {
            "AGENTIC_GEO_CORS_ALLOWED_ORIGINS": f" {allowed_origin} , https://other-console.example ",
            "DATABASE_URL": "postgresql+psycopg://unused:unused@localhost:1/unused",
        }
    )
    app = _app(settings=settings)

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
        preflight = await client.options(
            "/generate",
            headers={
                "Origin": allowed_origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type, x-request-id, x-neo-console, cache-control",
            },
        )
        actual = await client.get("/health", headers={"Origin": allowed_origin, "X-Neo-Console": "extractor"})
        untrusted = await client.options(
            "/generate",
            headers={
                "Origin": "https://untrusted.example",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )

    assert preflight.status_code == 200
    assert preflight.headers["access-control-allow-origin"] == allowed_origin
    assert "POST" in preflight.headers["access-control-allow-methods"]
    allowed_headers = {
        header.strip().casefold() for header in preflight.headers["access-control-allow-headers"].split(",")
    }
    assert {"content-type", "x-request-id", "x-neo-console", "cache-control"} <= allowed_headers
    assert preflight.headers.get("access-control-allow-credentials") != "true"
    assert actual.status_code == 200
    assert actual.headers["access-control-allow-origin"] == allowed_origin
    exposed_headers = {
        header.strip().casefold() for header in actual.headers["access-control-expose-headers"].split(",")
    }
    assert "x-request-id" in exposed_headers
    assert untrusted.status_code == 400
    assert untrusted.headers.get("access-control-allow-origin") is None
    assert untrusted.headers.get("access-control-allow-credentials") != "true"
