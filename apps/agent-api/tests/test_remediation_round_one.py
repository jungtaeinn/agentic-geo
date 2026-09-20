from __future__ import annotations

import asyncio
import io
import json
import logging
import math
from collections.abc import Callable, Mapping
from contextlib import contextmanager
from pathlib import Path
from typing import Any, cast

import httpx
import pytest
from conftest import object_mapping
from fastapi import FastAPI
from neo_agent_api.api.console import console_json
from neo_agent_api.main import RagProfiles, RagProfileStore, create_app, runtime_from_settings
from neo_agent_api.observability.logging import configure_logging
from neo_agent_api.observability.tracing import create_tracer
from neo_agent_api.persistence.geo_generation_repository import utf16_prefix as repository_utf16_prefix
from neo_agent_api.persistence.geo_result_repository import json_stringify as result_json
from neo_agent_api.services.console_orchestration import (
    build_extractor_options,
    build_generator_options,
    runtime_config,
)
from neo_agent_api.services.generation import GeoProcessor
from neo_agent_api.services.generation import utf16_prefix as generation_utf16_prefix
from neo_agent_api.services.ocr_enrichment import OcrEnrichmentService
from neo_agent_api.services.provider_validation import utf16_slice, validate_provider
from neo_agent_api.services.queue import GeoQueue
from neo_agent_api.settings import Settings

VALID_ID = "550e8400-e29b-41d4-a716-446655440000"
_NEST_MISSING_SUBMIT_MESSAGES = [
    "geoGenerationId must be a UUID",
    "locale should not be empty",
    "locale must be a string",
    "product must be an object",
]


class _ProcessingRepository:
    async def find_status(self, _generation_id: str) -> str:
        return "PROCESSING"

    async def transition_to_failed(self, *_args: object) -> bool:
        return True


class _Queue:
    def __init__(self) -> None:
        self.added: list[dict[str, Any]] = []

    def waiting_count(self) -> int:
        return 0

    async def add(self, data: Mapping[str, Any]) -> None:
        self.added.append(dict(data))


class _Results:
    async def persist_success(self, *_args: object) -> bool:
        return True


class _Profiles:
    def __init__(self) -> None:
        self.extractor: dict[str, Any] = {"analysisPrompt": "", "documents": []}
        self.generator: dict[str, Any] = {"analysisPrompt": "", "documents": []}

    async def read_extractor(self) -> dict[str, Any]:
        return self.extractor

    async def read_generator(self) -> dict[str, Any]:
        return self.generator

    async def write_extractor(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        self.extractor = dict(payload)
        return self.extractor

    async def write_generator(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        self.generator = dict(payload)
        return self.generator

    async def reset_extractor(self) -> dict[str, Any]:
        return self.extractor

    async def reset_generator(self) -> dict[str, Any]:
        return self.generator


_DEFAULT = object()


def _app(
    *,
    settings: Settings | None = None,
    generation: object = _DEFAULT,
    profiles: RagProfileStore | None = None,
) -> FastAPI:
    kwargs: dict[str, Any] = {
        "settings": settings or Settings(database_url="postgresql+psycopg://unused:unused@localhost:1/unused"),
        "generation_repository": _ProcessingRepository(),
        "result_repository": _Results(),
        "queue": _Queue(),
        "profiles": profiles or _Profiles(),
    }
    if generation is not _DEFAULT:
        kwargs["generation_service"] = generation
    return create_app(
        **kwargs,
    )


@pytest.mark.asyncio
async def test_whatwg_ipv4_spellings_are_excluded_before_ocr_outbound_use() -> None:
    captured: list[dict[str, Any]] = []

    async def extractor(request: Mapping[str, Any], _options: Mapping[str, Any]) -> Mapping[str, Any]:
        captured.append(dict(request))
        return {
            "ocr": {"imageTexts": [{"text": "seen"}], "textBlocks": [], "sentenceInsights": []},
            "diagnostics": {"warnings": []},
        }

    blocked = [
        "http://127.1/private.png",
        "http://0177.0.0.1/private.png",
        "http://0x7f000001/private.png",
        "http://2130706433/private.png",
        "http://127%2e0%2e0%2e1/private.png",
        "http://[::ffff:127.0.0.1]/private.png",
        "http://127.0.0.1./private.png",
        "http://user:pass@127.0.0.1/private.png",
    ]
    service = OcrEnrichmentService(extract_image_ocr_evidence=extractor)

    outcome = await service.enrich({"ocrImages": [*blocked, "https://cdn.example.com/public.png"]}, None)

    assert outcome["performed"] is True
    assert captured == [
        {
            "source": "agent-api:manual-json",
            "productName": None,
            "imageUrls": ["https://cdn.example.com/public.png"],
        }
    ]
    assert outcome["diagnostics"]["excludedTargets"] == [
        {"url": url, "reason": "private-or-local-address"} for url in blocked
    ]


@pytest.mark.asyncio
async def test_ocr_uts46_unicode_dot_loopbacks_are_excluded_before_outbound_use() -> None:
    captured: list[dict[str, Any]] = []

    async def extractor(request: Mapping[str, Any], _options: Mapping[str, Any]) -> Mapping[str, Any]:
        captured.append(dict(request))
        return {
            "ocr": {"imageTexts": [{"text": "seen"}], "textBlocks": [], "sentenceInsights": []},
            "diagnostics": {"warnings": []},
        }

    blocked = [
        "http://127。0。0。1/private.png",
        "http://127．0．0．1/private.png",
        "http://127｡0｡0｡1/private.png",
        "http://127%E3%80%820%E3%80%820%E3%80%821/private.png",
    ]
    service = OcrEnrichmentService(extract_image_ocr_evidence=extractor)

    outcome = await service.enrich({"ocrImages": [*blocked, "https://cdn.example.com/public.png"]}, None)

    assert captured == [
        {
            "source": "agent-api:manual-json",
            "productName": None,
            "imageUrls": ["https://cdn.example.com/public.png"],
        }
    ]
    assert outcome["diagnostics"]["excludedTargets"] == [
        {"url": url, "reason": "private-or-local-address"} for url in blocked
    ]


@pytest.mark.asyncio
async def test_existing_ocr_requires_a_nonempty_array_like_the_typescript_predicate() -> None:
    async def extractor(_request: Mapping[str, Any], _options: Mapping[str, Any]) -> Mapping[str, Any]:
        return {
            "ocr": {"imageTexts": [{"text": "new"}], "textBlocks": [], "sentenceInsights": []},
            "diagnostics": {"warnings": []},
        }

    outcome = await OcrEnrichmentService(extract_image_ocr_evidence=extractor).enrich(
        {"ocrImages": ["https://cdn.example.com/public.png"], "ocr": {"imageTexts": "not-an-array"}},
        None,
    )

    assert outcome["performed"] is True
    assert outcome.get("skippedReason") is None


def test_console_json_bytes_match_node_json_stringify_numbers_key_order_and_lone_surrogates() -> None:
    response = console_json(
        {"10": "ten", "2": "two", "value": 1.0, "negative": -0.0, "nan": math.nan, "lone": "\ud83d"}
    )

    assert response.body == (b'{"2":"two","10":"ten","value":1,"negative":0,"nan":null,"lone":"\\ud83d"}')


@pytest.mark.asyncio
async def test_ndjson_uses_node_json_bytes_for_lone_surrogate_results(monkeypatch: pytest.MonkeyPatch) -> None:
    async def generated(*_args: object, **_kwargs: object) -> dict[str, Any]:
        return {"results": [{"value": "\ud83d"}], "logs": [], "failures": []}

    monkeypatch.setattr("neo_agent_api.api.console.run_generate", generated)
    app = _app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/generate", json={"stream": True, "product": {}})

    assert response.status_code == 200
    assert response.content == (
        b'{"type":"result","payload":{"results":[{"value":"\\ud83d"}],"logs":[],"failures":[]}}\n'
    )


@pytest.mark.asyncio
async def test_ndjson_serialization_failure_ends_with_a_terminal_error_event(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def generated(*_args: object, **_kwargs: object) -> dict[str, Any]:
        return {"results": [{"value": {"not-json"}}], "logs": [], "failures": []}

    monkeypatch.setattr("neo_agent_api.api.console.run_generate", generated)
    app = _app()
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post("/generate", json={"stream": True, "product": {}})

    assert response.status_code == 200
    assert response.content == b'{"type":"error","error":"Object of type set is not JSON serializable"}\n'


@pytest.mark.asyncio
async def test_console_request_json_rejects_nonstandard_nan_like_next_request_json() -> None:
    app = _app()
    raw = b'{"provider":"mock","x":NaN}'
    expected = 'Unexpected token \'N\', ..."mock","x":NaN}" is not valid JSON'
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        provider = await client.post("/provider/validate", content=raw, headers={"content-type": "application/json"})
        generate = await client.post("/generate", content=raw, headers={"content-type": "application/json"})
        profile = await client.put("/rag-profile", content=raw, headers={"content-type": "application/json"})

    assert provider.status_code == 500
    assert provider.json() == {"ok": False, "provider": "mock", "message": expected}
    assert generate.status_code == 500
    assert generate.json() == {"error": expected}
    assert profile.status_code == 500
    assert profile.json() == {"error": expected}


@pytest.mark.asyncio
async def test_malformed_internal_json_is_parsed_before_the_api_key_guard() -> None:
    app = _app(
        settings=Settings(api_key="server-secret", database_url="postgresql+psycopg://unused:unused@localhost:1/unused")
    )
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post(
            "/internal/v1/geo/generations",
            content=b'{"geoGenerationId":',
            headers={"content-type": "application/json"},
        )
        bare_object = await client.post(
            "/internal/v1/geo/generations",
            content=b"{",
            headers={"content-type": "application/json"},
        )

    assert response.status_code == 400
    assert response.json() == {
        "message": "Unexpected end of JSON input",
        "error": "Bad Request",
        "statusCode": 400,
    }
    assert bare_object.status_code == 400
    assert bare_object.json() == {
        "message": "Expected property name or '}' in JSON at position 1 (line 1 column 2)",
        "error": "Bad Request",
        "statusCode": 400,
    }


@pytest.mark.asyncio
async def test_internal_empty_dto_uses_nest_validation_message_array_and_order() -> None:
    app = _app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/internal/v1/geo/generations", json={})

    assert response.status_code == 400
    assert response.json() == {"message": _NEST_MISSING_SUBMIT_MESSAGES, "error": "Bad Request", "statusCode": 400}


@pytest.mark.asyncio
async def test_internal_uuid_validation_rejects_compact_and_braced_values_like_class_input_contract() -> None:
    app = _app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        compact = await client.post(
            "/internal/v1/geo/generations",
            json={"geoGenerationId": VALID_ID.replace("-", ""), "locale": "ko-KR", "product": {}},
        )
        braced = await client.post(
            "/internal/v1/geo/generations",
            json={"geoGenerationId": f"{{{VALID_ID}}}", "locale": "ko-KR", "product": {}},
        )

    expected = {"message": ["geoGenerationId must be a UUID"], "error": "Bad Request", "statusCode": 400}
    assert compact.json() == expected
    assert braced.json() == expected


@pytest.mark.asyncio
async def test_internal_json_parser_does_not_treat_text_plain_as_a_valid_dto() -> None:
    app = _app()
    body = json.dumps({"geoGenerationId": VALID_ID, "locale": "ko-KR", "product": {}})
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post(
            "/internal/v1/geo/generations", content=body, headers={"content-type": "text/plain"}
        )

    assert response.status_code == 400
    assert response.json() == {"message": _NEST_MISSING_SUBMIT_MESSAGES, "error": "Bad Request", "statusCode": 400}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("url", "valid"),
    [
        ("http://localhost", False),
        ("http://a", False),
        ("http://exa mple.com", False),
        ("http://example.com:99999", False),
        ("http://foo_bar.example.com", False),
        ("http://example.com", True),
        ("https://127.0.0.1/path", True),
        ("http://[::1]/", True),
        ("http://例え.テスト", True),
    ],
)
async def test_internal_brand_same_as_uses_retained_input_contract_js_url_rules(url: str, valid: bool) -> None:
    app = _app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post(
            "/internal/v1/geo/generations",
            json={"geoGenerationId": VALID_ID, "locale": "ko-KR", "product": {}, "brandSameAs": [url]},
        )

    if valid:
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
async def test_internal_json_parser_matches_legacy_parser_type_charset_strictness_and_limit_ordering() -> None:
    app = _app(
        settings=Settings(api_key="server-secret", database_url="postgresql+psycopg://unused:unused@localhost:1/unused")
    )
    valid: dict[str, object] = {"geoGenerationId": VALID_ID, "locale": "ko-KR", "product": {}}
    oversized_json = b'{"payload":"' + (b"x" * (2 * 1024 * 1024)) + b'"}'
    oversized_text = b"x" * (2 * 1024 * 1024 + 1)
    replacement_locale = b'{"geoGenerationId":"' + VALID_ID.encode() + b'","locale":"\xff","product":{}}'
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        skipped_type = await client.post(
            "/internal/v1/geo/generations",
            json=valid,
            headers={"content-type": "application/problem+json", "x-api-key": "server-secret"},
        )
        unsupported_charset = await client.post(
            "/internal/v1/geo/generations",
            content=json.dumps(valid),
            headers={"content-type": "application/json; charset=latin1"},
        )
        primitive = await client.post(
            "/internal/v1/geo/generations", content=b"null", headers={"content-type": "application/json"}
        )
        ignored_text_limit = await client.post(
            "/internal/v1/geo/generations",
            content=oversized_text,
            headers={"content-type": "text/plain", "x-api-key": "server-secret"},
        )
        json_limit = await client.post(
            "/internal/v1/geo/generations", content=oversized_json, headers={"content-type": "application/json"}
        )
        empty = await client.post(
            "/internal/v1/geo/generations",
            content=b"",
            headers={"content-type": "application/json", "x-api-key": "server-secret"},
        )
        invalid_utf8 = await client.post(
            "/internal/v1/geo/generations", content=b"\xff", headers={"content-type": "application/json"}
        )
        replacement_utf8 = await client.post(
            "/internal/v1/geo/generations",
            content=replacement_locale,
            headers={"content-type": "application/json", "x-api-key": "server-secret"},
        )

    assert skipped_type.status_code == 400
    assert skipped_type.json() == {
        "message": _NEST_MISSING_SUBMIT_MESSAGES,
        "error": "Bad Request",
        "statusCode": 400,
    }
    assert unsupported_charset.status_code == 415
    assert unsupported_charset.json() == {
        "message": 'unsupported charset "LATIN1"',
        "statusCode": 415,
    }
    assert primitive.status_code == 400
    assert primitive.json() == {
        "message": "Unexpected token 'n', \"null\" is not valid JSON",
        "error": "Bad Request",
        "statusCode": 400,
    }
    assert ignored_text_limit.status_code == 400
    assert ignored_text_limit.json() == {
        "message": _NEST_MISSING_SUBMIT_MESSAGES,
        "error": "Bad Request",
        "statusCode": 400,
    }
    assert json_limit.status_code == 413
    assert json_limit.json() == {"statusCode": 413, "message": "request entity too large"}
    assert empty.status_code == 400
    assert empty.json() == {"message": _NEST_MISSING_SUBMIT_MESSAGES, "error": "Bad Request", "statusCode": 400}
    assert invalid_utf8.status_code == 400
    assert invalid_utf8.json() == {
        "message": "Unexpected token '�', \"�\" is not valid JSON",
        "error": "Bad Request",
        "statusCode": 400,
    }
    assert replacement_utf8.status_code == 202


def test_generate_runtime_preserves_env_citation_and_managed_vector_store_defaults() -> None:
    runtime = runtime_from_settings(Settings(openai_vector_store_id="vs-env-default", citation_probe_enabled=True))

    resolved = runtime_config({}, runtime)

    assert resolved["citationProbeEnabled"] is True
    assert resolved["rag"] == {"vectorStoreId": "vs-env-default"}


@pytest.mark.asyncio
async def test_env_rag_and_citation_defaults_stay_in_orchestration_not_agent_options() -> None:
    async def progress(_event: dict[str, Any]) -> None:
        return None

    runtime = runtime_config(
        {},
        runtime_from_settings(Settings(openai_vector_store_id="vs-env-default", citation_probe_enabled=True)),
    )

    generator_options = build_generator_options({}, runtime, None, progress)
    extractor_options = build_extractor_options({}, runtime, None, progress)

    assert runtime["rag"] == {"vectorStoreId": "vs-env-default"}
    assert runtime["citationProbeEnabled"] is True
    assert "rag" not in generator_options
    assert "citationProbeEnabled" not in generator_options
    assert "rag" not in extractor_options
    assert "citationProbeEnabled" not in extractor_options


@pytest.mark.asyncio
async def test_provider_validation_uses_javascript_truthiness_for_list_only(monkeypatch: pytest.MonkeyPatch) -> None:
    class Response:
        status_code = 200

        @staticmethod
        def json() -> object:
            return {"data": [{"id": "available-model"}]}

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
    result = await validate_provider({"provider": "openai", "apiKey": "key", "model": "missing-model", "listOnly": []})

    assert result["ok"] is True
    assert result["models"] == ["available-model"]


@pytest.mark.asyncio
async def test_provider_validation_uses_nullish_fallback_for_reranker_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Response:
        status_code = 200

        @staticmethod
        def json() -> object:
            return {"data": [{"id": "ocr"}, {"id": "reasoning"}, {"id": "embedding"}]}

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
    result = await validate_provider(
        {
            "provider": "azure-openai",
            "apiKey": "key",
            "endpoint": "https://azure.example.com",
            "deployments": {"ocr": "ocr", "reasoning": "reasoning", "embedding": "embedding"},
            "reranker": {"provider": None},
        }
    )

    assert result == {
        "ok": False,
        "provider": "azure-openai",
        "message": "Cohere Rerank는 Cohere/Foundry Key와 Endpoint가 필요합니다.",
        "details": (
            "OCR, Embedding, Final reasoning은 Azure API Key와 Endpoint를 공유하지만 "
            "Cohere Rerank는 별도 reranking endpoint로 호출됩니다."
        ),
    }


@pytest.mark.asyncio
async def test_provider_model_ids_use_the_retained_locale_compare_order(monkeypatch: pytest.MonkeyPatch) -> None:
    class Response:
        status_code = 200

        @staticmethod
        def json() -> object:
            return {
                "data": [
                    {"id": "Zebra"},
                    {"id": "alpha"},
                    {"id": "Álpha"},
                    {"id": "beta-10"},
                    {"id": "beta-2"},
                    {"id": "모델"},
                    {"id": "apple"},
                    {"id": "alpha"},
                    {"id": "_alpha"},
                    {"id": "-alpha"},
                    {"id": "alpha-1"},
                    {"id": "alpha_1"},
                    {"id": "Alpha"},
                    {"id": "áLpha"},
                    {"id": "a!pha"},
                    {"id": "a pha"},
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
    result = await validate_provider({"provider": "openai", "apiKey": "key", "listOnly": True})

    # Captured from the retained route's
    # ``Array.from(new Set(models)).sort((a, b) => a.localeCompare(b))``.
    # Punctuation and case make this a useful boundary: a hand-rolled
    # casefold key puts '-' before '_' whereas the browser's UCA collation
    # does not.
    assert result["models"] == [
        "_alpha",
        "-alpha",
        "a pha",
        "a!pha",
        "alpha",
        "Alpha",
        "áLpha",
        "Álpha",
        "alpha_1",
        "alpha-1",
        "apple",
        "beta-10",
        "beta-2",
        "Zebra",
        "모델",
    ]


@pytest.mark.asyncio
async def test_provider_validation_follows_redirects_like_next_fetch(monkeypatch: pytest.MonkeyPatch) -> None:
    client_options: dict[str, object] = {}

    class Response:
        status_code = 200

        @staticmethod
        def json() -> object:
            return {"data": [{"id": "available-model"}]}

    class Client:
        def __init__(self, **kwargs: object) -> None:
            client_options.update(kwargs)

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args: object) -> bool:
            return False

        async def get(self, *_args: object, **_kwargs: object) -> Response:
            return Response()

    monkeypatch.setattr("neo_agent_api.services.provider_validation.httpx.AsyncClient", Client)

    assert (await validate_provider({"provider": "openai", "apiKey": "key"}))["ok"] is True
    assert client_options == {"follow_redirects": True}


def test_internal_agent_options_do_not_inherit_console_rag_reranker_or_local_embedding_defaults() -> None:
    settings = Settings(
        provider="azure-openai",
        azure_openai_api_key="azure-key",
        azure_openai_endpoint="https://azure.example.com",
        azure_openai_reasoning_deployment="reasoning",
        azure_openai_ocr_deployment="ocr",
        azure_openai_embedding_deployment="embedding",
        azure_openai_proofreading_deployment="proofread",
        azure_openai_api_version="2025-04-01-preview",
        openai_vector_store_id="console-only-vector-store",
        cohere_rerank_api_key="console-only-reranker-key",
        cohere_rerank_endpoint="https://rerank.example.com",
        database_url="postgresql+psycopg://unused:unused@localhost:1/unused",
    )
    app = _app(settings=settings, generation=None)
    generation_runtime = app.state.generation_service.runtime
    extractor_runtime = app.state.generation_service.ocr_enrichment._options

    assert generation_runtime["deployment"] == "reasoning"
    assert generation_runtime["deployments"] == {
        "ocr": "ocr",
        "reasoning": "reasoning",
        "embedding": "embedding",
        "proofreading": "proofread",
    }
    assert generation_runtime["finalProofreading"] == {
        "enabled": True,
        "provider": "azure-openai",
        "apiKey": "azure-key",
    }
    assert "embedding" not in generation_runtime
    assert "reranker" not in generation_runtime
    assert "rag" not in generation_runtime
    assert "embedding" not in extractor_runtime
    assert "reranker" not in extractor_runtime
    assert "rag" not in extractor_runtime


@pytest.mark.parametrize(
    ("prefix", "units"),
    [
        (generation_utf16_prefix, 2000),
        (repository_utf16_prefix, 2000),
    ],
)
def test_database_utf16_truncation_never_leaves_an_unencodable_lone_surrogate(
    prefix: Callable[[str, int], str], units: int
) -> None:
    value = "a" * (units - 1) + "😀"

    actual = prefix(value, units)

    assert actual == "a" * (units - 1) + "\ufffd"
    assert actual.encode("utf-8").endswith(b"\xef\xbf\xbd")


@pytest.mark.asyncio
async def test_provider_detail_utf16_slice_keeps_javascript_split_surrogate_on_the_wire(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    value = "a" * 359 + "😀"

    class Response:
        status_code = 400

        def json(self) -> object:
            return {"error": {"message": value}}

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
    result = await validate_provider({"provider": "openai", "apiKey": "key"})

    assert utf16_slice(value, 360) == "a" * 359 + "\ud83d"
    assert result["details"] == "a" * 359 + "\ud83d"
    assert b"\\ud83d" in console_json(result, 400).body


def test_jsonb_values_use_javascript_json_stringify_semantics() -> None:
    assert result_json({"finite": 1.0, "nan": math.nan, "negative": -0.0, "lone": "\ud83d"}) == (
        '{"finite":1,"nan":null,"negative":0,"lone":"\\ud83d"}'
    )


@pytest.mark.asyncio
async def test_unexpected_internal_failure_uses_nest_generic_500_without_leaking_details() -> None:
    class ExplodingGeneration:
        async def generate(self, _data: Mapping[str, Any]) -> dict[str, Any]:
            raise RuntimeError("provider secret: do-not-return-this")

    app = _app(
        settings=Settings(
            geo_test_sync_endpoint=True,
            database_url="postgresql+psycopg://unused:unused@localhost:1/unused",
        ),
        generation=ExplodingGeneration(),
    )
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post("/internal/v1/geo/test-generations", json={"locale": "ko-KR", "product": {}})

    assert response.status_code == 500
    assert response.json() == {"statusCode": 500, "message": "Internal server error"}
    assert "do-not-return-this" not in response.text


@pytest.mark.asyncio
async def test_internal_success_envelope_uses_javascript_json_bytes() -> None:
    class Generation:
        async def generate(self, _data: Mapping[str, Any]) -> dict[str, Any]:
            return {
                "resultStatus": "SUCCEEDED",
                "jsonLd": {"value": 1.0, "negative": -0.0, "nan": math.nan, "lone": "\ud83d"},
                "scriptTag": "<script/>",
                "schemaTypes": ["Product"],
                "resultHash": "a" * 64,
                "ragProfile": "profile@1",
                "diagnostics": {"validationWarnings": []},
                "generatedAt": "2026-09-10T00:00:00.000Z",
            }

    app = _app(
        settings=Settings(
            geo_test_sync_endpoint=True,
            database_url="postgresql+psycopg://unused:unused@localhost:1/unused",
        ),
        generation=Generation(),
    )
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/internal/v1/geo/test-generations", json={"locale": "ko-KR", "product": {}})

    assert response.status_code == 200
    assert b'"value":1,"negative":0,"nan":null,"lone":"\\ud83d"' in response.content


@pytest.mark.asyncio
async def test_configured_tracer_creates_scoped_langfuse_generation_and_flushes() -> None:
    class Span:
        def __init__(self) -> None:
            self.updates: list[dict[str, Any]] = []

        def update(self, **kwargs: Any) -> None:
            self.updates.append(kwargs)

    class Client:
        def __init__(self) -> None:
            self.started: list[dict[str, Any]] = []
            self.children: list[dict[str, Any]] = []
            self.span = Span()
            self.flushed = False

        @contextmanager
        def start_as_current_observation(self, **kwargs: Any):
            self.started.append(kwargs)
            yield self.span

        def start_observation(self, **kwargs: Any):
            self.children.append(kwargs)

            class Child:
                def end(self) -> None:
                    return None

            return Child()

        def flush(self) -> None:
            self.flushed = True

    client = Client()
    factory_args: list[dict[str, Any]] = []
    propagated: list[dict[str, Any]] = []

    def factory(**kwargs: Any) -> Client:
        factory_args.append(kwargs)
        return client

    @contextmanager
    def propagate(**kwargs: Any):
        propagated.append(kwargs)
        yield None

    tracer = create_tracer(
        "pk-test",
        "sk-test",
        "https://langfuse.example.test",
        client_factory=factory,
        propagate_attributes_factory=propagate,
    )
    result = await tracer.run_sync_generation(
        lambda: _resolved({"ok": True}),
        geo_generation_id="trace-id",
        input_payload={"locale": "ko-KR", "product": {"name": "Serum"}},
        runtime_usage=lambda: {
            "steps": [
                {
                    "called": True,
                    "label": "embedding-call",
                    "stage": "embedding",
                    "provider": "azure-openai",
                    "service": "embeddings",
                    "mode": "vector",
                    "details": "retrieval",
                    "model": "embed-v1",
                    "tokenUsage": {"inputTokens": 4, "totalTokens": 4},
                },
                {
                    "called": True,
                    "label": "reasoning-call",
                    "stage": "reasoning",
                    "provider": "azure-openai",
                    "service": "chat",
                    "mode": "analysis",
                    "details": "final",
                    "deployment": "reasoning-deployment",
                    "tokenUsage": {"inputTokens": 5, "outputTokens": 6, "totalTokens": 11},
                },
                {"called": False, "label": "skipped"},
            ]
        },
    )
    await tracer.flush()

    assert result == {"ok": True}
    assert factory_args == [
        {"public_key": "pk-test", "secret_key": "sk-test", "base_url": "https://langfuse.example.test"}
    ]
    assert propagated == [{"session_id": "trace-id", "tags": ["geo-test-sync"]}]
    assert client.started == [{"name": "geo-test-generation", "as_type": "generation"}]
    assert client.span.updates == [
        {
            "input": {"locale": "ko-KR", "product": {"name": "Serum"}},
            "metadata": {"geoGenerationId": "trace-id"},
        },
        {"output": {"ok": True}},
    ]
    assert client.children == [
        {
            "name": "embedding-call",
            "as_type": "embedding",
            "model": "embed-v1",
            "metadata": {
                "stage": "embedding",
                "provider": "azure-openai",
                "service": "embeddings",
                "mode": "vector",
                "details": "retrieval",
            },
            "usage_details": {"input": 4, "total": 4},
        },
        {
            "name": "reasoning-call",
            "as_type": "generation",
            "model": "reasoning-deployment",
            "metadata": {
                "stage": "reasoning",
                "provider": "azure-openai",
                "service": "chat",
                "mode": "analysis",
                "details": "final",
            },
            "usage_details": {"input": 5, "output": 6, "total": 11},
        },
    ]
    assert client.flushed is True


async def _resolved(value: dict[str, Any]) -> dict[str, Any]:
    return value


@pytest.mark.asyncio
async def test_request_json_log_is_scoped_redacted_and_uses_the_request_id() -> None:
    app = _app(
        settings=Settings(api_key="secret-key", database_url="postgresql+psycopg://unused:unused@localhost:1/unused")
    )
    logger = app.state.logger
    stream = io.StringIO()
    for handler in logger.handlers:
        if isinstance(handler, logging.StreamHandler):
            cast(logging.StreamHandler[io.StringIO], handler).setStream(stream)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post(
            "/internal/v1/geo/generations",
            json={"geoGenerationId": VALID_ID, "locale": "ko-KR", "product": {}},
            headers={"x-api-key": "secret-key", "x-request-id": "req-123"},
        )

    assert response.status_code == 202
    records = [json.loads(line) for line in stream.getvalue().splitlines() if line]
    record = next(item for item in records if item["event"] == "http.request")
    assert record["level"] == "info"
    assert record["req"] == {"id": "req-123", "method": "POST", "url": "/internal/v1/geo/generations"}
    assert record["res"] == {"statusCode": 202}
    assert isinstance(record["time"], str)
    assert "secret-key" not in stream.getvalue()


@pytest.mark.asyncio
async def test_request_id_preserves_nonempty_header_whitespace_like_nest_pino() -> None:
    app = _app()
    supplied = "  browser-request-id  "
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/health", headers={"x-request-id": supplied})

    # ``typeof existing === \"string\" && existing !== \"\"`` does not trim.
    assert response.headers["x-request-id"] == supplied


@pytest.mark.asyncio
async def test_queue_and_processor_emit_job_context_json_events() -> None:
    logger = configure_logging("info")
    stream = io.StringIO()
    for handler in logger.handlers:
        if isinstance(handler, logging.StreamHandler):
            cast(logging.StreamHandler[io.StringIO], handler).setStream(stream)
    completed = asyncio.Event()

    async def handle(_job: Any) -> None:
        completed.set()

    queue = GeoQueue(concurrency=1, logger=logger)
    queue.set_handler(handle)
    await queue.add({"geoGenerationId": "job-1"})
    await asyncio.wait_for(completed.wait(), timeout=1)
    await asyncio.sleep(0)

    class ExplodingGeneration:
        async def generate(self, data: Mapping[str, Any]) -> dict[str, Any]:
            del data
            raise RuntimeError("generation failed")

    class Results:
        async def persist_success(self, geo_generation_id: str, artifact: Mapping[str, Any]) -> bool:
            del geo_generation_id, artifact
            return True

    class Generations:
        async def transition_to_failed(self, geo_generation_id: str, code: str, detail: str) -> bool:
            del geo_generation_id, code, detail
            raise RuntimeError("transition unavailable")

    processor = GeoProcessor(ExplodingGeneration(), Results(), Generations(), max_attempts=1, logger=logger)
    with pytest.raises(RuntimeError, match="generation failed"):
        await processor.process(type("Job", (), {"data": {"geoGenerationId": "job-2"}, "attempts_made": 0})())

    records = [json.loads(line) for line in stream.getvalue().splitlines()]
    started = next(item for item in records if item["event"] == "job.started")
    assert started["geoGenerationId"] == "job-1"
    assert started["attempt"] == 1
    assert any(item["event"] == "job.completed" for item in records)
    assert any(item["event"] == "geo.transition_failed" for item in records)


@pytest.mark.asyncio
async def test_lifespan_checks_database_readiness_before_serving(monkeypatch: pytest.MonkeyPatch) -> None:
    class Database:
        schema = "neo"

        def __init__(self) -> None:
            self.ready = False
            self.disposed = False

        async def ensure_ready(self) -> None:
            self.ready = True

        async def dispose(self) -> None:
            self.disposed = True

    database = Database()

    def create_test_database(_url: str, *, schema: str) -> Database:
        del schema
        return database

    monkeypatch.setattr("neo_agent_api.main.create_database", create_test_database)
    app = create_app(settings=Settings(database_url="postgresql+psycopg://unused:unused@localhost:1/unused"))

    async with app.router.lifespan_context(app):
        assert database.ready is True
    assert database.disposed is True


@pytest.mark.asyncio
async def test_lifespan_fails_before_queue_start_when_database_is_unreachable(monkeypatch: pytest.MonkeyPatch) -> None:
    class Database:
        schema = "neo"

        def __init__(self) -> None:
            self.disposed = False

        async def ensure_ready(self) -> None:
            raise ConnectionError("database unavailable")

        async def dispose(self) -> None:
            self.disposed = True

    database = Database()

    def create_test_database(_url: str, *, schema: str) -> Database:
        del schema
        return database

    monkeypatch.setattr("neo_agent_api.main.create_database", create_test_database)
    app = create_app(settings=Settings(database_url="postgresql+psycopg://unused:unused@localhost:1/unused"))

    with pytest.raises(ConnectionError, match="database unavailable"):
        async with app.router.lifespan_context(app):
            pass
    assert database.disposed is True


@pytest.mark.asyncio
async def test_combined_rag_profile_operations_start_both_stores_like_promise_all() -> None:
    class Profiles:
        def __init__(self) -> None:
            self.started: list[str] = []

        async def _call(self, name: str) -> dict[str, Any]:
            self.started.append(name)
            # Both Promise.all inputs are invoked before either awaits.  A
            # sequential implementation reaches this assertion with only one.
            await asyncio.sleep(0)
            if len(self.started) != 2:
                raise RuntimeError("profiles were not started together")
            return {"analysisPrompt": name, "documents": []}

        async def read_extractor(self) -> dict[str, Any]:
            return await self._call("read-extractor")

        async def read_generator(self) -> dict[str, Any]:
            return await self._call("read-generator")

        async def reset_extractor(self) -> dict[str, Any]:
            return await self._call("reset-extractor")

        async def reset_generator(self) -> dict[str, Any]:
            return await self._call("reset-generator")

        async def write_extractor(self, payload: Mapping[str, Any]) -> dict[str, Any]:
            del payload
            return {}

        async def write_generator(self, payload: Mapping[str, Any]) -> dict[str, Any]:
            del payload
            return {}

    profiles = Profiles()
    app = _app(profiles=profiles)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        read = await client.get("/rag-profile")
        assert read.status_code == 200
        assert profiles.started == ["read-extractor", "read-generator"]

        profiles.started.clear()
        reset = await client.delete("/rag-profile")

    assert reset.status_code == 200
    assert profiles.started == ["reset-extractor", "reset-generator"]


@pytest.mark.asyncio
async def test_combined_rag_profile_read_starts_generator_when_extractor_fails() -> None:
    class Profiles:
        def __init__(self) -> None:
            self.generator_started = False

        async def read_extractor(self) -> dict[str, Any]:
            await asyncio.sleep(0)
            raise RuntimeError("extractor read failed")

        async def read_generator(self) -> dict[str, Any]:
            self.generator_started = True
            await asyncio.sleep(0)
            return {"analysisPrompt": "", "documents": []}

        async def write_extractor(self, payload: Mapping[str, Any]) -> dict[str, Any]:
            del payload
            return {}

        async def write_generator(self, payload: Mapping[str, Any]) -> dict[str, Any]:
            del payload
            return {}

        async def reset_extractor(self) -> dict[str, Any]:
            return {}

        async def reset_generator(self) -> dict[str, Any]:
            return {}

    profiles = Profiles()
    app = _app(profiles=profiles)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/rag-profile")

    assert response.status_code == 500
    assert response.json() == {"error": "extractor read failed"}
    assert profiles.generator_started is True


@pytest.mark.asyncio
async def test_rag_profile_route_uses_real_store_writers_and_preserves_writer_type_failures(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from pdp_extractor_agent import (
        read_product_extractor_rag_profile,
        reset_product_extractor_rag_profile,
        write_product_extractor_rag_profile,
    )
    from pdp_geo_generator_agent import (
        read_pdp_geo_generator_rag_profile,
        reset_pdp_geo_generator_rag_profile,
        write_pdp_geo_generator_rag_profile,
    )

    extractor_state = tmp_path / "extractor"
    generator_state = tmp_path / "generator"

    def write_extractor_at_state(payload: Mapping[str, Any]) -> dict[str, Any]:
        return write_product_extractor_rag_profile(payload, state_dir=extractor_state)

    async def write_generator_at_state(payload: Mapping[str, object]) -> dict[str, Any]:
        return await write_pdp_geo_generator_rag_profile(payload, generator_state)

    monkeypatch.setattr(
        "neo_agent_api.main.read_product_extractor_rag_profile",
        lambda: read_product_extractor_rag_profile(state_dir=extractor_state),
    )
    monkeypatch.setattr(
        "neo_agent_api.main.write_product_extractor_rag_profile",
        write_extractor_at_state,
    )
    monkeypatch.setattr(
        "neo_agent_api.main.reset_product_extractor_rag_profile",
        lambda: reset_product_extractor_rag_profile(state_dir=extractor_state),
    )
    monkeypatch.setattr(
        "neo_agent_api.main.read_pdp_geo_generator_rag_profile",
        lambda: read_pdp_geo_generator_rag_profile(generator_state),
    )
    monkeypatch.setattr(
        "neo_agent_api.main.write_pdp_geo_generator_rag_profile",
        write_generator_at_state,
    )
    monkeypatch.setattr(
        "neo_agent_api.main.reset_pdp_geo_generator_rag_profile",
        lambda: reset_pdp_geo_generator_rag_profile(generator_state),
    )

    app = _app(profiles=RagProfiles())
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        extractor = await client.put(
            "/rag-profile",
            json={
                "analysisPrompt": "real extractor policy",
                "documents": [{"name": "profile.md", "version": "", "content": "body"}],
            },
            headers={"x-neo-console": "extractor"},
        )
        generator = await client.put(
            "/rag-profile",
            json={"target": "generator", "analysisPrompt": "real generator policy", "documents": []},
        )
        assert extractor.status_code == 200
        assert extractor.json()["analysisPrompt"] == "real extractor policy\n"
        assert (extractor_state / "custom" / "profile_.md").read_text(encoding="utf-8") == "body\n"
        assert generator.status_code == 200
        assert generator.json()["generator"]["analysisPrompt"] == "real generator policy\n"
        assert (generator_state / "analysis-prompt_v1.md").exists()
        bad_prompt = await client.put("/rag-profile", json={"analysisPrompt": 42})
        bad_documents = await client.put("/rag-profile", json={"documents": 42})

    assert bad_prompt.status_code == 500
    assert bad_prompt.json() == {"error": "value.endsWith is not a function"}
    assert bad_documents.status_code == 500
    assert bad_documents.json() == {"error": "(body.documents ?? []).filter is not a function"}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("payload", "message"),
    [
        (None, "Cannot read properties of null (reading 'analysisPrompt')"),
        ({"documents": [None]}, "Cannot read properties of null (reading 'name')"),
    ],
)
async def test_rag_profile_preserves_next_null_property_failures(payload: object, message: str) -> None:
    app = _app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = (
            await client.put("/rag-profile", content=b"null", headers={"content-type": "application/json"})
            if payload is None
            else await client.put("/rag-profile", json=payload)
        )

    assert response.status_code == 500
    assert response.json() == {"error": message}


def test_fastapi_container_runs_as_a_non_root_application_user() -> None:
    dockerfile = (Path(__file__).parents[1] / "Dockerfile").read_text()

    assert "USER neo-agent-api" in dockerfile
    assert 'CMD ["/app/.venv/bin/uvicorn", "neo_agent_api.main:app"' in dockerfile
    assert 'CMD ["uv", "run"' not in dockerfile


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", [42, False, {}, []])
async def test_provider_uses_javascript_nullish_selection_for_non_string_values(provider: object) -> None:
    app = _app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/provider/validate", json={"provider": provider})

    # The retained route only defaults null/undefined. Other runtime values
    # miss the named-provider branches and reach the Azure fallback.
    assert response.status_code == 400
    assert response.json() == {
        "ok": False,
        "provider": "azure-openai",
        "message": "Azure API Key와 Endpoint가 필요합니다.",
    }


@pytest.mark.asyncio
async def test_provider_uses_mock_only_for_nullish_value() -> None:
    app = _app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/provider/validate", json={"provider": None})

    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "provider": "mock",
        "message": "Mock provider는 별도 API Key 없이 사용할 수 있습니다.",
    }


@pytest.mark.parametrize("provider", [42, False, {}, []])
def test_generate_runtime_preserves_non_nullish_provider_values(provider: object) -> None:
    resolved = runtime_config({"llm": {"provider": provider}}, {"provider": "mock", "_providerDefaults": {}})

    assert resolved["provider"] == provider


def test_internal_option_factories_keep_each_retained_raw_env_semantic() -> None:
    settings = Settings.from_env(
        {
            "AGENTIC_GEO_PROVIDER": "azure-openai",
            "AZURE_OPENAI_API_KEY": "  shared-key  ",
            "AZURE_OPENAI_ENDPOINT": " https://azure.example.test/ ",
            "AZURE_OPENAI_DEPLOYMENT": "fallback",
            # ``??`` preserves an explicitly empty reasoning deployment.
            "AZURE_OPENAI_REASONING_DEPLOYMENT": "",
            "AZURE_OPENAI_EMBEDDING_ENDPOINT": " https://embedding.example.test/ ",
            # optionalString() removes this one before it falls back with ??.
            "AZURE_OPENAI_EMBEDDING_API_KEY": "  ",
            "AGENTIC_GEO_PRODUCT_NORMALIZATION": " FALSE ",
        }
    )

    generator = settings.internal_generator_runtime()
    extractor = settings.internal_extractor_runtime()

    assert generator["apiKey"] == "  shared-key  "
    assert generator["endpoint"] == " https://azure.example.test/ "
    assert generator["deployment"] == ""
    assert generator["deployments"] == {"ocr": "fallback", "reasoning": ""}
    assert generator["embedding"] == {
        "provider": "azure-openai",
        "apiKey": "  shared-key  ",
        "endpoint": " https://embedding.example.test/ ",
    }
    assert generator["productNormalization"] == {"enabled": False}
    assert extractor["apiKey"] == "  shared-key  "
    assert extractor["endpoint"] == " https://azure.example.test/ "
    assert extractor["deployment"] == ""
    assert extractor["deployments"] == {"ocr": "fallback", "reasoning": ""}


def test_aistudio_internal_factory_uses_optional_string_only_where_oracle_does() -> None:
    settings = Settings.from_env(
        {
            "AGENTIC_GEO_PROVIDER": "aistudio",
            "AISTUDIO_API_KEY": " key-with-spaces ",
            "AISTUDIO_ENDPOINT": " https://studio.example.test/ ",
            # Deployment/api-version use optionalString(), while model does not.
            "AISTUDIO_MODEL": "  ",
            "AISTUDIO_API_VERSION": "  ",
            "AZURE_OPENAI_DEPLOYMENT": "azure-fallback",
        }
    )

    runtime = settings.internal_generator_runtime()

    assert runtime["apiKey"] == " key-with-spaces "
    assert runtime["model"] == "  "
    assert runtime["endpoint"] == " https://studio.example.test/ "
    assert runtime["deployment"] == "azure-fallback"
    assert "apiVersion" not in runtime


def test_console_factory_uses_raw_nullish_env_precedence_not_python_truthiness() -> None:
    settings = Settings.from_env(
        {
            "AGENTIC_GEO_PROVIDER": "azure-openai",
            # The extractor route uses OPENAI ?? GEMINI ?? Azure, so this
            # deliberately empty first value still wins.
            "OPENAI_API_KEY": "",
            "GEMINI_API_KEY": "gemini-key",
            "AZURE_OPENAI_API_KEY": "azure-key",
            "OPENAI_MODEL": "",
            "GEMINI_MODEL": "gemini-model",
            "AZURE_OPENAI_DEPLOYMENT": "fallback",
            "AZURE_OPENAI_REASONING_DEPLOYMENT": "",
            "AZURE_OPENAI_PROOFREADING_DEPLOYMENT": "",
        }
    )

    extractor = settings.extractor_console_runtime()
    generator = settings.generator_console_runtime()

    assert extractor["apiKey"] == ""
    assert extractor["model"] == ""
    assert generator["deployment"] == ""
    assert object_mapping(generator["finalProofreading"])["model"] == ""
