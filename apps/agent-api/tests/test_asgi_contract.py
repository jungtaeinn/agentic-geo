from __future__ import annotations

import asyncio
import json
import re

import httpx
import pytest
from conftest import AppFactory, capturing_queue
from fastapi import FastAPI
from neo_agent_api.api import console as console_api

VALID_ID = "550e8400-e29b-41d4-a716-446655440000"


async def request_client(app: FastAPI) -> httpx.AsyncClient:
    """Construct a client without hiding the ASGI app under test."""

    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver")


@pytest.mark.asyncio
async def test_health_is_unauthenticated_and_echoes_request_id(app_factory: AppFactory) -> None:
    app = app_factory(api_key="server-secret")
    async with await request_client(app) as client:
        response = await client.get("/health", headers={"x-request-id": "request-123"})

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    assert response.headers["x-request-id"] == "request-123"


@pytest.mark.asyncio
async def test_internal_auth_precedes_validation_and_uses_legacy_401_envelope(app_factory: AppFactory) -> None:
    app = app_factory(api_key="server-secret")
    async with await request_client(app) as client:
        response = await client.post("/internal/v1/geo/generations", json={"geoGenerationId": "not-a-uuid"})

    assert response.status_code == 401
    assert response.json() == {
        "message": "invalid x-api-key",
        "error": "Unauthorized",
        "statusCode": 401,
    }


@pytest.mark.asyncio
async def test_invalid_internal_generation_returns_400_not_422(client: httpx.AsyncClient) -> None:
    response = await client.post("/internal/v1/geo/generations", json={})

    assert response.status_code == 400
    assert response.json()["statusCode"] == 400
    assert response.json()["error"] == "Bad Request"


@pytest.mark.asyncio
async def test_malformed_json_is_legacy_400_not_fastapi_422(client: httpx.AsyncClient) -> None:
    response = await client.post(
        "/internal/v1/geo/generations",
        content=b'{"geoGenerationId":',
        headers={"content-type": "application/json"},
    )

    assert response.status_code == 400
    assert response.json()["statusCode"] == 400
    assert response.json()["error"] == "Bad Request"


@pytest.mark.asyncio
async def test_internal_dto_strips_unknown_top_level_fields_before_acceptance(app_factory: AppFactory) -> None:
    app = app_factory()
    async with await request_client(app) as client:
        response = await client.post(
            "/internal/v1/geo/generations",
            json={
                "geoGenerationId": VALID_ID,
                "locale": "ko-KR",
                "product": {"name": "Serum"},
                "brandSameAs": ["https://example.com/brand"],
                "unexpected": "must not reach acceptance",
            },
        )

    assert response.status_code == 202
    queue = capturing_queue(app)
    assert queue.added == [
        {
            "geoGenerationId": VALID_ID,
            "locale": "ko-KR",
            "product": {"name": "Serum"},
            "brandSameAs": ["https://example.com/brand"],
        }
    ]


@pytest.mark.asyncio
async def test_internal_capacity_is_checked_before_queue_dedup_and_preserves_429_envelope(
    app_factory: AppFactory,
) -> None:
    app = app_factory(queue_waiting=1)
    async with await request_client(app) as client:
        response = await client.post(
            "/internal/v1/geo/generations",
            json={"geoGenerationId": VALID_ID, "locale": "ko-KR", "product": {}},
        )

    assert response.status_code == 429
    assert response.json() == {"statusCode": 429, "message": "queue saturated"}


@pytest.mark.asyncio
async def test_internal_database_failure_uses_legacy_503_envelope(app_factory: AppFactory) -> None:
    app = app_factory(repository_fails=True)
    async with await request_client(app) as client:
        response = await client.post(
            "/internal/v1/geo/generations",
            json={"geoGenerationId": VALID_ID, "locale": "ko-KR", "product": {}},
        )

    assert response.status_code == 503
    assert response.json() == {
        "message": "db unavailable",
        "error": "Service Unavailable",
        "statusCode": 503,
    }


@pytest.mark.asyncio
async def test_console_body_over_2_mib_is_not_subject_to_internal_parser_limit(client: httpx.AsyncClient) -> None:
    payload = b'{"product":"' + (b"x" * (2 * 1024 * 1024)) + b'"}'
    response = await client.post("/extract", content=payload, headers={"content-type": "application/json"})

    # Nest attaches its body-parser limit only to internal job routes. The
    # retained Next handler receives this whole console body, then reports the
    # source-level missing-sources error.
    assert response.status_code == 400
    assert response.json() == {"error": "At least one source is required."}


@pytest.mark.asyncio
async def test_disabled_sync_endpoint_validates_before_returning_404(app_factory: AppFactory) -> None:
    app = app_factory(sync_enabled=False)
    async with await request_client(app) as client:
        malformed = await client.post("/internal/v1/geo/test-generations", json={"locale": "", "product": "wrong"})
        disabled = await client.post("/internal/v1/geo/test-generations", json={"locale": "ko-KR", "product": {}})

    assert malformed.status_code == 400
    assert disabled.status_code == 404


@pytest.mark.asyncio
async def test_sync_generation_omits_optional_fields_unless_diagnostics_are_requested(app_factory: AppFactory) -> None:
    app = app_factory(sync_enabled=True)
    async with await request_client(app) as client:
        basic = await client.post(
            "/internal/v1/geo/test-generations", json={"locale": "ko-KR", "product": {"name": "Serum"}}
        )
        detailed = await client.post(
            "/internal/v1/geo/test-generations",
            json={"locale": "ko-KR", "product": {"name": "Serum"}, "includeDiagnostics": True},
        )

    assert basic.status_code == 200
    assert re.fullmatch(r"[0-9a-f-]{36}", basic.json()["geoGenerationId"])
    assert "diagnostics" not in basic.json()
    assert "contentSections" not in basic.json()
    assert "runtimeUsage" not in basic.json()
    assert detailed.json()["diagnostics"] == {"validationWarnings": []}
    assert detailed.json()["contentSections"] == {"productName": "Serum"}


@pytest.mark.asyncio
async def test_console_routes_remain_unauthenticated_when_internal_key_is_configured(app_factory: AppFactory) -> None:
    app = app_factory(api_key="server-secret")
    async with await request_client(app) as client:
        response = await client.post("/provider/validate", json={"provider": "mock"})

    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "provider": "mock",
        "message": "Mock provider는 별도 API Key 없이 사용할 수 있습니다.",
    }


@pytest.mark.asyncio
async def test_generate_stream_is_ndjson(client: httpx.AsyncClient) -> None:
    response = await client.post("/generate", json={"stream": True, "product": {"title": "serum"}})

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/x-ndjson; charset=utf-8"
    assert response.headers["cache-control"] == "no-store, no-transform"
    assert response.headers["x-accel-buffering"] == "no"
    events = [json.loads(line) for line in response.text.splitlines()]
    assert events[-1]["type"] == "result"
    assert events[-1]["payload"]["results"][0]["source"] == "manual-json-1"


@pytest.mark.asyncio
async def test_generate_stream_reports_terminal_error_in_a_200_ndjson_response(client: httpx.AsyncClient) -> None:
    response = await client.post("/generate", json={"stream": True})

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/x-ndjson; charset=utf-8"
    assert (
        response.text
        == '{"type":"error","error":"At least one URL, REST API source, or product JSON payload is required."}\n'
    )


@pytest.mark.asyncio
async def test_generate_stream_emits_a_keepalive_while_orchestration_is_pending(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A long model stage must not leave the BFF-facing NDJSON body idle."""

    release = asyncio.Event()

    async def pending_generation(*_: object, **__: object) -> dict[str, object]:
        await release.wait()
        return {"results": [], "failures": []}

    monkeypatch.setattr(console_api, "run_generate", pending_generation)
    monkeypatch.setattr(console_api, "STREAM_HEARTBEAT_INTERVAL_SECONDS", 0.01, raising=False)
    stream = console_api._stream_events({}, {}, None, None)  # pyright: ignore[reportPrivateUsage]
    try:
        event = json.loads((await asyncio.wait_for(anext(stream), timeout=0.1)).decode("utf-8"))
    finally:
        release.set()
        await stream.aclose()

    assert event == {"type": "heartbeat"}


@pytest.mark.asyncio
async def test_rag_profile_defaults_to_combined_shape_and_extract_header_selects_raw_shape(
    client: httpx.AsyncClient,
) -> None:
    combined = await client.get("/rag-profile")
    raw = await client.get("/rag-profile", headers={"X-Neo-Console": "extractor"})

    assert combined.status_code == 200
    assert set(combined.json()) == {"extractor", "generator"}
    assert raw.status_code == 200
    assert "analysisPrompt" in raw.json()
    assert "extractor" not in raw.json()


@pytest.mark.asyncio
async def test_refine_mock_and_evaluation_keep_the_browser_import_payload_shapes(client: httpx.AsyncClient) -> None:
    mock = await client.post("/mock", json={"sources": ["https://example.com/pdp"]})
    refine = await client.post(
        "/refine",
        json={
            "result": mock.json()["results"][0]["result"],
            "instruction": '{"geoProduct":{"images":["https://example.com/changed.jpg"]}}',
        },
    )
    evaluation = await client.post("/evaluation", json={"jsonLd": {"@type": "Product"}, "diagnostics": {}})

    assert mock.status_code == 200
    assert list(mock.json()) == ["results"]
    assert refine.status_code == 200
    assert refine.json()["result"]["geoProduct"]["images"][-1] == "https://example.com/changed.jpg"
    assert evaluation.status_code == 200
    assert "overallScore" in evaluation.json()
