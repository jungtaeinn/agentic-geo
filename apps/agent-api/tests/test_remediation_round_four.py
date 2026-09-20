"""Round-four frozen API boundary regression contracts."""

from __future__ import annotations

import base64
import gzip
import json
import math
import os
import zlib
from collections.abc import Iterator, Mapping
from importlib import import_module
from pathlib import Path
from typing import Any, Protocol, TypedDict, cast

import httpx
import pytest
from conftest import AppFactory
from fastapi import FastAPI
from frozen_contracts import frozen_outcome
from neo_agent_api.api.json_request import parse_internal_json_body
from neo_agent_api.main import MAX_BODY_BYTES, ZlibBodyDecoder, create_app
from neo_agent_api.settings import Settings
from starlette.types import Message, Scope


class _BrotliModule(Protocol):
    def compress(self, data: bytes) -> bytes: ...


brotli = cast(_BrotliModule, import_module("brotli"))


class _CompressionCase(TypedDict):
    encoding: str
    body: str


class _EncodedCase(TypedDict):
    encoding: str
    contentType: str
    body: str


_VALID_ID = "550e8400-e29b-41d4-a716-446655440000"
_VALID_BODY: dict[str, object] = {"geoGenerationId": _VALID_ID, "locale": "ko-KR", "product": {}}
_ROOT = Path(__file__).resolve().parents[3]


class _ProcessingRepository:
    async def find_status(self, _generation_id: str) -> str:
        return "PROCESSING"


class _ResultRepository:
    async def persist_success(self, *_args: object) -> bool:
        return False


class _Queue:
    def __init__(self, waiting: int = 0) -> None:
        self.waiting = waiting

    def waiting_count(self) -> int:
        return self.waiting

    async def add(self, _data: Mapping[str, Any]) -> None:
        return None


def _app_for_queue(settings: Settings, *, waiting: int = 0) -> FastAPI:
    return create_app(
        settings=settings,
        generation_repository=_ProcessingRepository(),
        result_repository=_ResultRepository(),
        queue=_Queue(waiting),
    )


@pytest.mark.asyncio
async def test_compressed_parser_failures_match_frozen_contract(app_factory: AppFactory) -> None:
    """A parser regression must match retained body-parser, not a guessed Python error."""

    cases: list[_CompressionCase] = [
        {"encoding": "gzip", "body": base64.b64encode(b"\x1f\x8b").decode()},
        {"encoding": "deflate", "body": base64.b64encode(b"\x78\x9c").decode()},
        {"encoding": "gzip", "body": base64.b64encode(b"not a gzip stream").decode()},
        {"encoding": "br", "body": base64.b64encode(b"\x01\x02\x03").decode()},
        {
            "encoding": "gzip",
            "body": base64.b64encode(gzip.compress(b"x" * (MAX_BODY_BYTES + 1))).decode(),
        },
        {
            "encoding": "br",
            "body": base64.b64encode(brotli.compress(b"x" * (MAX_BODY_BYTES + 1))).decode(),
        },
    ]
    expected = frozen_outcome("round_four", "test_compressed_parser_failures_match_frozen_contract", cases)
    app = app_factory()
    actual: list[dict[str, object]] = []
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False), base_url="http://test"
    ) as client:
        for case in cases:
            response = await client.post(
                "/internal/v1/geo/generations",
                content=base64.b64decode(case["body"]),
                headers={"content-type": "application/json", "content-encoding": case["encoding"]},
            )
            actual.append({"status": response.status_code, "message": response.json().get("message")})

    assert actual == [{"status": item["status"], "message": item["body"]["message"]} for item in expected]


@pytest.mark.asyncio
async def test_decoded_bom_rules_match_frozen_contract(app_factory: AppFactory) -> None:
    """The Web and body-parser boundaries have distinct, observable BOM rules."""

    bom = b"\xef\xbb\xbf"
    console_bodies = [bom + b"{}", bom * 2 + b"{}", bom * 3 + b"{}"]
    console_expected = frozen_outcome("round_four", "decoded_bom_console_bytes", console_bodies)
    assert [outcome["ok"] for outcome in console_expected] == [True, True, False]

    serialized = json.dumps(_VALID_BODY, separators=(",", ":")).encode()
    cases: list[_EncodedCase] = [
        {
            "encoding": "identity",
            "contentType": "application/json",
            "body": base64.b64encode(bom + serialized).decode(),
        },
        {
            "encoding": "identity",
            "contentType": "application/json",
            "body": base64.b64encode(bom * 2 + serialized).decode(),
        },
        {
            "encoding": "identity",
            "contentType": "application/json; charset=utf-16le",
            "body": base64.b64encode(b"\xff\xfe" + serialized.decode().encode("utf-16le")).decode(),
        },
        {
            "encoding": "identity",
            "contentType": "application/json; charset=utf-16be",
            "body": base64.b64encode(b"\xfe\xff" + serialized.decode().encode("utf-16be")).decode(),
        },
    ]
    expected = frozen_outcome("round_four", "test_decoded_bom_rules_match_frozen_contract", cases)
    app = app_factory()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        console = [
            await client.post("/provider/validate", content=body, headers={"content-type": "application/json"})
            for body in console_bodies
        ]
        internal = [
            await client.post(
                "/internal/v1/geo/generations",
                content=base64.b64decode(case["body"]),
                headers={"content-type": case["contentType"], "content-encoding": case["encoding"]},
            )
            for case in cases
        ]

    assert [response.status_code for response in console] == [200, 200, 500]
    assert console[-1].json()["message"] == console_expected[-1]["message"]
    assert [response.status_code for response in internal] == [item["status"] for item in expected]
    assert internal[1].json()["message"] == expected[1]["body"]["message"]


@pytest.mark.asyncio
async def test_internal_utf_fixed_width_decoding_matches_iconv_partial_and_auto_endianness(
    app_factory: AppFactory,
) -> None:
    """iconv drops incomplete units and chooses UTF-16/32 endianness from data."""

    serialized = json.dumps(_VALID_BODY, separators=(",", ":"))
    cases = [
        {
            "encoding": "identity",
            "contentType": "application/json; charset=utf-16le",
            "body": base64.b64encode(b"{").decode(),
        },
        {
            "encoding": "identity",
            "contentType": "application/json; charset=utf-32le",
            "body": base64.b64encode(b"{}").decode(),
        },
        {
            "encoding": "identity",
            "contentType": "application/json; charset=utf-16",
            "body": base64.b64encode(serialized.encode("utf-16be")).decode(),
        },
        {
            "encoding": "identity",
            "contentType": "application/json; charset=utf-32",
            "body": base64.b64encode(serialized.encode("utf-32be")).decode(),
        },
    ]
    expected = frozen_outcome(
        "round_four", "test_internal_utf_fixed_width_decoding_matches_iconv_partial_and_auto_endianness", cases
    )
    app = app_factory(api_key="secret")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        actual = [
            await client.post(
                "/internal/v1/geo/generations",
                content=base64.b64decode(case["body"]),
                headers={
                    "content-type": case["contentType"],
                    **({"x-api-key": "secret"} if index >= 2 else {}),
                },
            )
            for index, case in enumerate(cases)
        ]

    assert [item["status"] for item in expected] == [202, 202, 202, 202]
    assert [response.status_code for response in actual] == [401, 401, 202, 202]


def test_fixed_width_json_decoding_preserves_iconv_unpaired_surrogates() -> None:
    """iconv keeps UTF surrogate code units that JavaScript later serializes."""

    surrogate = "\ud800"
    text = '{"x":"' + surrogate + '"}'
    cases = [
        {
            "encoding": "identity",
            "contentType": "application/json; charset=utf-16le",
            "body": base64.b64encode(text.encode("utf-16le", errors="surrogatepass")).decode(),
            "echo": "true",
        },
        {
            "encoding": "identity",
            "contentType": "application/json; charset=utf-32le",
            "body": base64.b64encode(text.encode("utf-32le", errors="surrogatepass")).decode(),
            "echo": "true",
        },
    ]
    expected = frozen_outcome("round_four", "test_fixed_width_json_decoding_preserves_iconv_unpaired_surrogates", cases)

    actual = [
        parse_internal_json_body(base64.b64decode(case["body"]), case["contentType"].split("=", 1)[1]) for case in cases
    ]

    assert actual == [item["body"] for item in expected]


@pytest.mark.asyncio
async def test_console_json_parser_accepts_runtime_depth_without_python_recursion(app_factory: AppFactory) -> None:
    """A valid nested JSON value must not become a Python recursion-limit 500."""

    depth = 2_000
    expected = frozen_outcome(
        "round_four", "test_console_json_parser_accepts_runtime_depth_without_python_recursion", {"depth": depth}
    )
    assert expected == {"ok": True}
    raw = ("[" * depth + "0" + "]" * depth).encode()
    app = app_factory()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/provider/validate", content=raw, headers={"content-type": "application/json"})

    assert response.status_code == 200


def test_zlib_decoder_never_retains_an_arbitrary_asgi_frame_tail() -> None:
    """A 2 MiB output cap must not retain a multi-megabyte compressed frame."""

    decoder = ZlibBodyDecoder(16 + zlib.MAX_WBITS)
    compressed = gzip.compress(os.urandom(MAX_BODY_BYTES * 2))
    try:
        assert len(decoder.feed(compressed, MAX_BODY_BYTES + 1)) == MAX_BODY_BYTES + 1
        assert decoder.unconsumed_tail_size <= 64 * 1024
    finally:
        decoder.close()


@pytest.mark.asyncio
async def test_internal_disconnect_is_the_frozen_body_parser_read_failure(app_factory: AppFactory) -> None:
    """An ASGI disconnect must not turn a partial body into auth/DTO processing."""

    expected = frozen_outcome(
        "round_four", "test_internal_disconnect_is_the_frozen_body_parser_read_failure", {"disconnect": True}
    )
    app = app_factory(api_key="secret")
    messages: list[Message] = []
    incoming: Iterator[Message] = iter(
        [
            {"type": "http.request", "body": b'{"geoGenerationId":', "more_body": True},
            {"type": "http.disconnect"},
        ]
    )

    async def receive() -> Message:
        return next(incoming)

    async def send(message: Message) -> None:
        messages.append(message)

    scope: Scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/internal/v1/geo/generations",
        "raw_path": b"/internal/v1/geo/generations",
        "query_string": b"",
        "root_path": "",
        "headers": [(b"content-type", b"application/json"), (b"content-length", b"100")],
        "client": ("127.0.0.1", 12345),
        "server": ("test", 80),
        "app": app,
    }
    await app(
        scope,
        receive,
        send,
    )

    start = next(message for message in messages if message["type"] == "http.response.start")
    body_chunks: list[bytes] = []
    for message in messages:
        if message["type"] == "http.response.body":
            chunk = message.get("body", b"")
            assert isinstance(chunk, bytes)
            body_chunks.append(chunk)
    body = b"".join(body_chunks)
    parsed = json.loads(body)
    assert {"status": start["status"], "message": parsed["message"]} == expected
    assert parsed == {"message": "request aborted", "error": "Bad Request", "statusCode": 400}


@pytest.mark.asyncio
async def test_console_and_internal_json_boundaries_match_frozen_contract(app_factory: AppFactory) -> None:
    """The lexer must preserve V8 grammar, messages, and UTF-16 locations."""

    cases = [
        "[1,]",
        '{"a":tru}',
        "-Infinity",
        r'{"a":"\x"}',
        '{"a":"unterminated}',
        "01",
        "😀😀😀😀😀😀😀😀😀😀😀? ",
        '{"😀":?}',
        "{",
        '{"x":1,}',
        '{"x" 1}',
        '{"x":1 "z":2}',
        "[1 2]",
        "1.",
        "1e+",
        "1x",
        '{"x":"line\n"}',
        "t1",
        'f"hi"',
        '"\\😀"',
        '"\\Ā"',
        "t-1",
        "undefined",
    ]
    expected = frozen_outcome("round_four", "test_console_and_internal_json_boundaries_match_frozen_contract", cases)
    app = app_factory()
    console_messages: list[str] = []
    internal_messages: list[str] = []
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        for raw in cases:
            console = await client.post(
                "/provider/validate", content=raw.encode(), headers={"content-type": "application/json"}
            )
            assert console.status_code == 500
            console_messages.append(str(console.json()["message"]))

        internal_indices = (0, 1, 3, 4, 7)
        for index in internal_indices:
            raw = cases[index]
            expected_message = expected[index]
            internal = await client.post(
                "/internal/v1/geo/generations", content=raw.encode(), headers={"content-type": "application/json"}
            )
            assert internal.status_code == 400
            internal_messages.append(str(internal.json()["message"]))
            assert internal_messages[-1] == expected_message

    assert console_messages == expected


@pytest.mark.asyncio
async def test_internal_url_dto_matches_frozen_ip_and_zone_matrix(app_factory: AppFactory) -> None:
    cases = [
        "http://127.0.0.1",
        "https://[::1]",
        "http://[fe80::1%eth0]",
        "http://[fe80::1%eth-0]",
        "http://[2001:db8::1]:443",
        "http://[2001:db8::1]:65536",
    ]
    expected = frozen_outcome("round_four", "test_internal_url_dto_matches_frozen_ip_and_zone_matrix", cases)
    app = app_factory()
    actual: list[bool] = []
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        for url in cases:
            response = await client.post("/internal/v1/geo/generations", json={**_VALID_BODY, "brandSameAs": [url]})
            actual.append(response.status_code == 202)

    assert actual == expected


@pytest.mark.asyncio
async def test_provider_route_preserves_retained_property_and_malformed_payload_errors(
    monkeypatch: pytest.MonkeyPatch, app_factory: AppFactory
) -> None:
    cases: list[dict[str, object]] = [
        {"body": None, "upstream": {"data": []}},
        {"body": {"provider": "openai", "apiKey": "key"}, "upstream": {"data": None}},
        {"body": {"provider": "openai", "apiKey": "key"}, "upstream": {"data": [None]}},
        {"body": {"provider": "openai", "apiKey": "key", "model": 42}, "upstream": {"data": []}},
        {"body": {"provider": "gemini", "apiKey": "key"}, "upstream": {"models": [{"name": 42}]}},
        {
            "body": {"provider": "gemini", "apiKey": "key", "listOnly": True},
            "upstream": {"models": [{"name": "models/gemini-test", "supportedGenerationMethods": "generateContent"}]},
        },
        {
            "body": {"provider": "azure-openai", "apiKey": "key", "endpoint": "https://example.test", "listOnly": True},
            "upstream": {"data": [None]},
        },
    ]
    frozen = frozen_outcome(
        "round_four", "test_provider_route_preserves_retained_property_and_malformed_payload_errors", cases
    )
    expected = [{"status": item["status"], "body": item["body"]} for item in frozen]

    class Response:
        status_code = 200

        def __init__(self, payload: object) -> None:
            self.payload = payload

        def json(self) -> object:
            return self.payload

    class Client:
        def __init__(self, **_kwargs: object) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args: object) -> bool:
            return False

        async def get(self, *_args: object, **_kwargs: object) -> Response:
            return Response(upstreams.pop(0))

    asgi_client = httpx.AsyncClient
    upstreams: list[object] = [case["upstream"] for case in cases if case["body"] is not None]
    monkeypatch.setattr("neo_agent_api.services.provider_validation.httpx.AsyncClient", Client)
    app = app_factory()
    actual: list[dict[str, object]] = []
    async with asgi_client(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        for case in cases:
            response = await client.post(
                "/provider/validate", content=json.dumps(case["body"]), headers={"content-type": "application/json"}
            )
            actual.append({"status": response.status_code, "body": response.json()})

    assert actual == expected


@pytest.mark.asyncio
async def test_provider_trim_uses_ecmascript_whitespace_not_python_strip(monkeypatch: pytest.MonkeyPatch) -> None:
    from neo_agent_api.services.provider_validation import validate_provider

    seen: list[dict[str, str]] = []

    class Response:
        status_code = 200

        @staticmethod
        def json() -> object:
            return {"data": []}

    class Client:
        def __init__(self, **_kwargs: object) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args: object) -> bool:
            return False

        async def get(self, _url: str, *, headers: dict[str, str]) -> Response:
            seen.append(headers)
            return Response()

    monkeypatch.setattr("neo_agent_api.services.provider_validation.httpx.AsyncClient", Client)
    await validate_provider({"provider": "openai", "apiKey": "\ufeffkey\ufeff", "listOnly": True})
    await validate_provider({"provider": "openai", "apiKey": "\u0085key\u0085", "listOnly": True})

    assert seen == [{"Authorization": "Bearer key"}, {"Authorization": "Bearer \u0085key\u0085"}]


def test_route_specific_environment_rules_keep_strict_probe_and_number_conversion() -> None:
    true_settings = Settings.from_env({"AGENTIC_GEO_CITATION_PROBE": "true", "AZURE_OPENAI_TEMPERATURE": "0x10"})
    upper_settings = Settings.from_env({"AGENTIC_GEO_CITATION_PROBE": "TRUE"})
    negative_zero = Settings.from_env({"AZURE_OPENAI_TEMPERATURE": "-0"})

    assert true_settings.citation_probe_enabled is True
    assert upper_settings.citation_probe_enabled is False
    assert true_settings.azure_openai_temperature == 16
    assert negative_zero.azure_openai_temperature is not None
    assert math.copysign(1.0, negative_zero.azure_openai_temperature) == -1.0

    bom_false = Settings.from_env(
        {
            "AGENTIC_GEO_PROVIDER": "openai",
            "OPENAI_API_KEY": "key",
            "AGENTIC_GEO_PRODUCT_NORMALIZATION": "\ufefffalse\ufeff",
        }
    )
    nel_false = Settings.from_env(
        {
            "AGENTIC_GEO_PROVIDER": "openai",
            "OPENAI_API_KEY": "key",
            "AGENTIC_GEO_PRODUCT_NORMALIZATION": "\u0085false\u0085",
        }
    )
    assert bom_false.internal_generator_runtime()["productNormalization"] == {"enabled": False}
    assert nel_false.internal_generator_runtime()["productNormalization"] == {"enabled": True}


def test_js_number_matches_frozen_non_ascii_and_ecmascript_cases() -> None:
    from neo_agent_api.settings import js_number

    cases = ["١", "１２", "42", "0x10", "-0", "\ufeff 42 \ufeff"]
    expected = frozen_outcome("round_four", "test_js_number_matches_frozen_non_ascii_and_ecmascript_cases", cases)
    actual: list[str] = []
    for raw in cases:
        value = js_number(raw)
        if math.isnan(value):
            actual.append("NaN")
        elif math.copysign(1.0, value) < 0 and value == 0:
            actual.append("-0")
        else:
            actual.append(str(int(value)) if value.is_integer() else str(value))

    assert actual == expected


@pytest.mark.asyncio
@pytest.mark.parametrize(("raw", "limit"), [("20.0", 20), ("0x10", 16)])
async def test_queue_waiting_capacity_uses_number_then_number_is_integer(raw: str, limit: int) -> None:
    settings = Settings.from_env(
        {"GEO_QUEUE_MAX_WAITING": raw, "DATABASE_URL": "postgresql+psycopg://unused:unused@localhost:1/unused"}
    )
    app = _app_for_queue(settings, waiting=limit)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/internal/v1/geo/generations", json=_VALID_BODY)

    assert response.status_code == 429
    assert response.json() == {"statusCode": 429, "message": "queue saturated"}


@pytest.mark.asyncio
async def test_real_rag_writers_keep_target_order_nullish_versions_and_js_fraction_strings(tmp_path: Path) -> None:
    from pdp_extractor_agent import write_product_extractor_rag_profile
    from pdp_geo_generator_agent import write_pdp_geo_generator_rag_profile

    extractor = tmp_path / "extractor"
    generator = tmp_path / "generator"
    with pytest.raises(TypeError) as extractor_error:
        write_product_extractor_rag_profile(
            {"analysisPrompt": "", "documents": [{"name": 42, "version": "v1", "content": "bad"}]},
            state_dir=extractor,
        )
    assert str(extractor_error.value) == 'The "path" argument must be of type string. Received type number (42)'

    await write_pdp_geo_generator_rag_profile(
        {
            "analysisPrompt": "",
            "documents": [
                {"name": "brands/acme/voice.md", "version": "", "content": "brand"},
                {"name": "fraction.md", "version": 1e-6, "content": "fraction"},
            ],
        },
        generator,
    )
    write_product_extractor_rag_profile(
        {"analysisPrompt": "", "documents": [{"name": "fraction.md", "version": 1e-6, "content": "fraction"}]},
        state_dir=extractor,
    )

    assert (generator / "brands" / "acme" / "voice_.md").read_text(encoding="utf-8") == "brand\n"
    assert (generator / "custom" / "fraction_0.000001.md").read_text(encoding="utf-8") == "fraction\n"
    assert (extractor / "custom" / "fraction_0.000001.md").read_text(encoding="utf-8") == "fraction\n"


def test_dockerfile_keeps_build_tools_out_of_the_runtime_stage() -> None:
    """The image-stage boundary is the only available no-daemon hygiene proof."""

    dockerfile = (_ROOT / "apps" / "agent-api" / "Dockerfile").read_text(encoding="utf-8")
    assert "FROM python:3.14.7-slim AS runtime" in dockerfile
    builder, runtime = dockerfile.split("FROM python:3.14.7-slim AS runtime", 1)
    assert "AS builder" in builder
    assert "build-essential" in builder
    assert "build-essential" not in runtime
    assert "pkg-config" not in runtime
    assert "libicu-dev" not in runtime
    assert "USER neo-agent-api" in runtime
    assert '"/app/.venv/bin/uvicorn"' in runtime
