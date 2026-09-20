"""Round-three retained-runtime boundary regressions.

Each case in this module was captured from the installed Nest/Next runtime
before changing the FastAPI implementation.  Keep these at the HTTP boundary:
the compatibility layer is intentionally observable, not an implementation
detail.
"""

from __future__ import annotations

import base64
import gzip
import json
import zlib
from collections.abc import Mapping
from contextlib import suppress
from pathlib import Path
from typing import Any

import httpx
import pytest
from conftest import AppFactory
from fastapi import FastAPI
from neo_agent_api.main import RagProfiles, create_app, runtime_from_settings
from neo_agent_api.persistence.database import create_database
from neo_agent_api.services.console_orchestration import runtime_config
from neo_agent_api.services.provider_validation import validate_provider
from neo_agent_api.settings import Settings
from sqlalchemy.exc import OperationalError

VALID_ID = "550e8400-e29b-41d4-a716-446655440000"
_VALID_BODY: dict[str, object] = {"geoGenerationId": VALID_ID, "locale": "ko-KR", "product": {}}
# Generated with Node's zlib.brotliCompressSync for the exact JSON above.
_BROTLI_VALID_BODY = base64.b64decode(
    "G1cAqKwK7DZrr8NcMX2f3XsQtEklsqdzS53+7bCD2qIOsqlDs5Q1Z2vNklT2pqT6YAMOWBMOgCKZ6Ex1hKn+JrrahuRskZg4D3kLd3lBqsqUSNIAZsZjoKkH"
)
_MISSING_SUBMIT = [
    "geoGenerationId must be a UUID",
    "locale should not be empty",
    "locale must be a string",
    "product must be an object",
]


@pytest.mark.asyncio
async def test_internal_body_parser_order_before_auth(app_factory: AppFactory) -> None:
    """Match Nest's body-parser ordering, including raw decoder outcomes."""

    app = app_factory(api_key="server-secret")
    raw = json.dumps(_VALID_BODY, separators=(",", ":")).encode()
    oversized_latin1 = b"x" * (2 * 1024 * 1024 + 1)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        whitespace = await client.post(
            "/internal/v1/geo/generations", content=b" \r\n\t", headers={"content-type": "application/json"}
        )
        compressed = [
            await client.post(
                "/internal/v1/geo/generations",
                content=payload,
                headers={
                    "content-type": "application/json",
                    "content-encoding": encoding,
                    "x-api-key": "server-secret",
                },
            )
            for encoding, payload in (
                ("gzip", gzip.compress(raw)),
                ("deflate", zlib.compress(raw)),
                ("br", _BROTLI_VALID_BODY),
            )
        ]
        unsupported = await client.post(
            "/internal/v1/geo/generations",
            content=raw,
            headers={"content-type": "application/json", "content-encoding": "zstd"},
        )
        latin1_before_limit = await client.post(
            "/internal/v1/geo/generations",
            content=oversized_latin1,
            headers={"content-type": "application/json; charset=latin1"},
        )

    assert whitespace.status_code == 400
    assert whitespace.json() == {
        "message": "Unexpected end of JSON input",
        "error": "Bad Request",
        "statusCode": 400,
    }
    assert [(response.status_code, response.json()) for response in compressed] == [
        (202, {"accepted": True, "geoGenerationId": VALID_ID}),
        (202, {"accepted": True, "geoGenerationId": VALID_ID}),
        (202, {"accepted": True, "geoGenerationId": VALID_ID}),
    ]
    assert unsupported.status_code == 415
    assert unsupported.json() == {"statusCode": 415, "message": 'unsupported content encoding "zstd"'}
    assert latin1_before_limit.status_code == 415
    assert latin1_before_limit.json() == {"statusCode": 415, "message": 'unsupported charset "LATIN1"'}


@pytest.mark.asyncio
async def test_internal_body_parser_defaults_for_falsey_inputs(app_factory: AppFactory) -> None:
    app = app_factory(api_key="server-secret")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post(
            "/internal/v1/geo/generations",
            content=json.dumps(_VALID_BODY),
            headers={
                "content-type": 'application/json; charset=""',
                "content-encoding": "",
                "x-api-key": "server-secret",
            },
        )

    assert response.status_code == 202
    assert response.json() == {"accepted": True, "geoGenerationId": VALID_ID}


@pytest.mark.asyncio
async def test_two_mebibyte_parser_limit_is_internal_only(app_factory: AppFactory) -> None:
    """Next Request.json has no inherited Nest body-parser size policy."""

    app = app_factory()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post(
            "/provider/validate", content=b" " * (2 * 1024 * 1024 + 1), headers={"content-type": "application/json"}
        )

    assert response.status_code == 500
    assert response.json() == {
        "ok": False,
        "provider": "mock",
        "message": "Unexpected end of JSON input",
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("url", "accepted"),
    [
        ("http:user@example.com", False),
        ("http://:@example.com", False),
        ("http://💩.com", True),
    ],
)
async def test_internal_url_dto_uses_input_contract_js_protocol_auth_and_utf16_rules(
    app_factory: AppFactory, url: str, accepted: bool
) -> None:
    app = app_factory()
    body: dict[str, object] = {**_VALID_BODY, "brandSameAs": [url]}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/internal/v1/geo/generations", json=body)

    if accepted:
        assert response.status_code == 202
        assert response.json() == {"accepted": True, "geoGenerationId": VALID_ID}
    else:
        assert response.status_code == 400
        assert response.json() == {
            "message": ["each value in brandSameAs must be a URL address"],
            "error": "Bad Request",
            "statusCode": 400,
        }


@pytest.mark.asyncio
async def test_real_async_engine_and_app_lifespan_get_to_connection_failure_not_missing_greenlet() -> None:
    """Mac arm64 needs greenlet for the actual SQLAlchemy async path."""

    url = "postgresql+psycopg://unused:unused@127.0.0.1:1/unused?connect_timeout=1"
    database = create_database(url)
    try:
        with pytest.raises(OperationalError):
            await database.ensure_ready()
    finally:
        with suppress(Exception):
            await database.dispose()

    app = create_app(settings=Settings(database_url=url))
    with pytest.raises(OperationalError):
        async with app.router.lifespan_context(app):
            raise AssertionError("unreachable database must not start the service")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("raw", "message"),
    [
        (b'{"x":1,}', "Expected double-quoted property name in JSON at position 7 (line 1 column 8)"),
        (b'{"x" 1}', "Expected ':' after property name in JSON at position 5 (line 1 column 6)"),
        (b'{"x": 1 "z":2}', "Expected ',' or '}' after property value in JSON at position 8 (line 1 column 9)"),
        (
            b'{"p":"012345678901234567890123456789012345678901234567890","x":?}',
            'Unexpected token \'?\', ..."7890","x":?}" is not valid JSON',
        ),
    ],
)
async def test_console_request_json_exposes_retained_v8_syntax_messages(
    app_factory: AppFactory, raw: bytes, message: str
) -> None:
    app = app_factory()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/provider/validate", content=raw, headers={"content-type": "application/json"})

    assert response.status_code == 500
    assert response.json() == {"ok": False, "provider": "mock", "message": message}


@pytest.mark.asyncio
async def test_console_request_json_uses_javascript_ieee754_number_values_before_generation(
    monkeypatch: pytest.MonkeyPatch, app_factory: AppFactory
) -> None:
    captured: dict[str, Any] = {}

    async def generated(body: dict[str, Any], **_kwargs: object) -> dict[str, Any]:
        captured.update(body)
        return {"results": [{"id": "ok"}], "logs": [], "failures": []}

    monkeypatch.setattr("neo_agent_api.api.console.run_generate", generated)
    app = app_factory()
    raw = b'{"product":{"large":9007199254740993,"negativeZero":-0,"exponent":1e400}}'
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/generate", content=raw, headers={"content-type": "application/json"})

    product = captured["product"]
    assert isinstance(product["large"], float)
    assert product["large"] == 9007199254740992
    assert product["negativeZero"] == 0 and str(product["negativeZero"]).startswith("-")
    assert product["exponent"] == float("inf")
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_provider_non_string_secret_preserves_the_next_property_call_failure(app_factory: AppFactory) -> None:
    app = app_factory()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/provider/validate", json={"provider": "openai", "apiKey": 42})

    assert response.status_code == 500
    assert response.json() == {
        "ok": False,
        "provider": "mock",
        "message": "value?.trim is not a function",
    }


@pytest.mark.asyncio
async def test_provider_uses_fetch_ok_and_nullish_error_fields(
    monkeypatch: pytest.MonkeyPatch, app_factory: AppFactory
) -> None:
    asgi_client = httpx.AsyncClient

    class Response:
        status_code = 304

        @staticmethod
        def json() -> object:
            return {"error": {"message": ""}, "error_description": "must not replace an empty message"}

    class Client:
        def __init__(self, **_kwargs: object) -> None:
            pass

        async def __aenter__(self) -> Client:
            return self

        async def __aexit__(self, *_args: object) -> bool:
            return False

        async def get(self, *_args: object, **_kwargs: object) -> Response:
            return Response()

    monkeypatch.setattr("neo_agent_api.services.provider_validation.httpx.AsyncClient", Client)
    app = app_factory()
    async with asgi_client(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/provider/validate", json={"provider": "openai", "apiKey": "key"})

    assert response.status_code == 400
    assert response.json() == {"ok": False, "provider": "openai", "message": "OpenAI 연결 확인 실패: 304"}


@pytest.mark.asyncio
async def test_provider_success_payload_keeps_javascript_map_type_failure(
    monkeypatch: pytest.MonkeyPatch, app_factory: AppFactory
) -> None:
    asgi_client = httpx.AsyncClient

    class Response:
        status_code = 200

        @staticmethod
        def json() -> object:
            return {"data": {"id": "not-an-array"}}

    class Client:
        def __init__(self, **_kwargs: object) -> None:
            pass

        async def __aenter__(self) -> Client:
            return self

        async def __aexit__(self, *_args: object) -> bool:
            return False

        async def get(self, *_args: object, **_kwargs: object) -> Response:
            return Response()

    monkeypatch.setattr("neo_agent_api.services.provider_validation.httpx.AsyncClient", Client)
    app = app_factory()
    async with asgi_client(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/provider/validate", json={"provider": "openai", "apiKey": "key"})

    assert response.status_code == 500
    assert response.json() == {
        "ok": False,
        "provider": "mock",
        "message": "payload.data?.map is not a function",
    }


def test_generate_and_internal_embedding_factories_keep_their_distinct_env_rules() -> None:
    settings = Settings.from_env(
        {
            "AGENTIC_GEO_PROVIDER": "azure-openai",
            "AZURE_OPENAI_API_KEY": "primary-key",
            "AZURE_OPENAI_ENDPOINT": "https://primary.example.test",
            "AZURE_OPENAI_DEPLOYMENT": "primary-chat",
            "AZURE_OPENAI_EMBEDDING_DEPLOYMENT": "primary-embedding",
            "AZURE_OPENAI_API_VERSION": "2025-01-01",
            "AZURE_OPENAI_EMBEDDING_ENDPOINT": "https://dedicated.example.test",
            "AZURE_OPENAI_EMBEDDING_API_KEY": "dedicated-key",
            "AZURE_OPENAI_EMBEDDING_API_VERSION": "  ",
        }
    )

    internal = settings.internal_generator_runtime()
    generate = runtime_from_settings(settings)

    assert internal["embedding"] == {
        "provider": "azure-openai",
        "apiKey": "dedicated-key",
        "endpoint": "https://dedicated.example.test",
        "deployment": "primary-embedding",
    }
    assert generate["embedding"] == {
        "provider": "azure-openai",
        "apiKey": "primary-key",
        "endpoint": "https://primary.example.test",
        "deployment": "primary-embedding",
        "apiVersion": "2025-01-01",
    }


def test_generate_stage_boolean_and_empty_endpoint_follow_javascript_truthiness() -> None:
    base = {
        "provider": "openai",
        "apiKey": "server-key",
        "endpoint": "https://server.example.test",
        "_providerDefaults": {
            "openai": {"provider": "openai", "apiKey": "server-key", "endpoint": "https://server.example.test"}
        },
    }

    array_key = runtime_config({"llm": {"apiKey": []}}, base)
    empty_endpoint = runtime_config({"llm": {"endpoint": ""}}, base)

    assert array_key["productNormalization"]["enabled"] is True
    assert array_key["contentPlanning"]["enabled"] is True
    assert array_key["finalProofreading"]["enabled"] is True
    assert empty_endpoint["endpoint"] == ""


@pytest.mark.asyncio
async def test_rag_profile_real_writer_preserves_javascript_empty_and_numeric_versions(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, app_factory: AppFactory
) -> None:
    """The route's `??` payload reaches the real writer without Python defaults."""

    from pdp_extractor_agent import (
        read_product_extractor_rag_profile,
        reset_product_extractor_rag_profile,
        write_product_extractor_rag_profile,
    )

    state_dir = tmp_path / "extractor"

    def write_at_state(payload: Mapping[str, Any]) -> dict[str, Any]:
        return write_product_extractor_rag_profile(payload, state_dir=state_dir)

    monkeypatch.setattr(
        "neo_agent_api.main.read_product_extractor_rag_profile",
        lambda: read_product_extractor_rag_profile(state_dir=state_dir),
    )
    monkeypatch.setattr(
        "neo_agent_api.main.write_product_extractor_rag_profile",
        write_at_state,
    )
    monkeypatch.setattr(
        "neo_agent_api.main.reset_product_extractor_rag_profile",
        lambda: reset_product_extractor_rag_profile(state_dir=state_dir),
    )
    app = app_factory()
    app.state.profiles = RagProfiles()
    headers = {"x-neo-console": "extractor"}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        empty_version = await client.put(
            "/rag-profile",
            json={"documents": [{"name": "empty.md", "version": "", "content": "empty"}]},
            headers=headers,
        )
        assert empty_version.status_code == 200
        assert (state_dir / "custom" / "empty_.md").read_text(encoding="utf-8") == "empty\n"
        numeric_version = await client.put(
            "/rag-profile",
            json={"documents": [{"name": "numeric.md", "version": 42, "content": "numeric"}]},
            headers=headers,
        )
        assert numeric_version.status_code == 200
        assert (state_dir / "custom" / "numeric_42.md").read_text(encoding="utf-8") == "numeric\n"
        object_version = await client.put(
            "/rag-profile",
            json={"documents": [{"name": "object.md", "version": {"kind": "custom"}, "content": "object"}]},
            headers=headers,
        )
        numeric_name = await client.put(
            "/rag-profile", json={"documents": [{"name": 42, "version": "v1", "content": "bad"}]}, headers=headers
        )

    assert object_version.status_code == 200
    assert (state_dir / "custom" / "object_[object Object].md").read_text(encoding="utf-8") == "object\n"
    assert numeric_name.status_code == 500
    assert numeric_name.json() == {"error": 'The "path" argument must be of type string. Received type number (42)'}


@pytest.mark.asyncio
async def test_cross_package_profile_stores_keep_javascript_empty_and_numeric_version_filenames(tmp_path: Path) -> None:
    from pdp_extractor_agent import write_product_extractor_rag_profile
    from pdp_geo_generator_agent import write_pdp_geo_generator_rag_profile

    extractor = tmp_path / "extractor"
    generator = tmp_path / "generator"
    awaitable = write_pdp_geo_generator_rag_profile(
        {"analysisPrompt": "", "documents": [{"name": "empty.md", "version": "", "content": "body"}]}, generator
    )
    write_product_extractor_rag_profile(
        {"analysisPrompt": "", "documents": [{"name": "numeric.md", "version": 42, "content": "body"}]},
        state_dir=extractor,
    )
    await awaitable

    assert (extractor / "custom" / "numeric_42.md").read_text(encoding="utf-8") == "body\n"
    assert (generator / "custom" / "empty_.md").read_text(encoding="utf-8") == "body\n"

    write_product_extractor_rag_profile(
        {"analysisPrompt": "", "documents": [{"name": "object.md", "version": {"kind": "custom"}, "content": "body"}]},
        state_dir=extractor,
    )
    await write_pdp_geo_generator_rag_profile(
        {"analysisPrompt": "", "documents": [{"name": "object.md", "version": {"kind": "custom"}, "content": "body"}]},
        generator,
    )

    assert (extractor / "custom" / "object_[object Object].md").read_text(encoding="utf-8") == "body\n"
    assert (generator / "custom" / "object_[object Object].md").read_text(encoding="utf-8") == "body\n"


@pytest.mark.asyncio
async def test_cross_package_profile_stores_preserve_numeric_name_writer_failure(tmp_path: Path) -> None:
    from pdp_extractor_agent import write_product_extractor_rag_profile
    from pdp_geo_generator_agent import write_pdp_geo_generator_rag_profile

    with pytest.raises(TypeError) as extractor_error:
        write_product_extractor_rag_profile(
            {"analysisPrompt": "", "documents": [{"name": 42, "version": "v1", "content": "body"}]},
            state_dir=tmp_path / "extractor",
        )
    assert str(extractor_error.value) == 'The "path" argument must be of type string. Received type number (42)'
    with pytest.raises(TypeError, match="name.replace is not a function"):
        await write_pdp_geo_generator_rag_profile(
            {"analysisPrompt": "", "documents": [{"name": 42, "version": "v1", "content": "body"}]},
            tmp_path / "generator",
        )


class _IdleGenerationRepository:
    async def find_status(self, _generation_id: str) -> str | None:
        return None


class _IdleResultRepository:
    async def persist_success(self, *_args: object) -> bool:
        return False


def _queue_app(settings: Settings) -> FastAPI:
    return create_app(
        settings=settings,
        generation_repository=_IdleGenerationRepository(),
        result_repository=_IdleResultRepository(),
    )


def test_internal_queue_keeps_fixed_retry_values_and_number_constructor_startup_validation() -> None:
    fixed = _queue_app(
        Settings.from_env(
            {
                "GEO_QUEUE_MAX_ATTEMPTS": "99",
                "GEO_QUEUE_BACKOFF_MS": "1",
                "DATABASE_URL": "postgresql+psycopg://unused:unused@127.0.0.1:1/unused",
            }
        )
    )

    assert fixed.state.queue.max_attempts == 2
    assert fixed.state.queue.backoff_ms == 5000
    malformed = Settings.from_env(
        {
            "GEO_WORKER_CONCURRENCY": "not-a-number",
            "DATABASE_URL": "postgresql+psycopg://unused:unused@127.0.0.1:1/unused",
        }
    )
    with pytest.raises(ValueError, match="GeoQueue concurrency"):
        _queue_app(malformed)


@pytest.mark.asyncio
async def test_provider_model_ids_use_the_retained_icu_order_for_newer_emoji_and_cjk(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Exercise the route boundary with a corpus pyuca's old table misses.

    Captured from Node's retained ``localeCompare`` (ICU 77, ``en-US``): the
    test tube sorts between pile-of-poo and grinning-face, rather than at the
    end as Unicode-10 pyuca does.
    """

    class Response:
        status_code = 200

        @staticmethod
        def json() -> object:
            return {
                "data": [
                    {"id": "😀"},
                    {"id": "😃"},
                    {"id": "💩"},
                    {"id": "🍎"},
                    {"id": "🧪"},
                    {"id": "가"},
                    {"id": "각"},
                    {"id": "한"},
                    {"id": "ㅎ"},
                    {"id": "あ"},
                    {"id": "ア"},
                    {"id": "亜"},
                    {"id": "阿"},
                ]
            }

    class Client:
        def __init__(self, **_kwargs: object) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args: object) -> bool:
            return False

        async def get(self, *_args: object, **_kwargs: object) -> Response:
            return Response()

    monkeypatch.setattr("neo_agent_api.services.provider_validation.httpx.AsyncClient", Client)
    response = await validate_provider({"provider": "openai", "apiKey": "key", "listOnly": True})

    assert response["models"] == [
        "🍎",
        "💩",
        "🧪",
        "😀",
        "😃",
        "가",
        "각",
        "ㅎ",
        "한",
        "あ",
        "ア",
        "亜",
        "阿",
    ]
