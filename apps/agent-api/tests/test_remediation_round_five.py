"""Round-five frozen API boundary regression contracts."""

from __future__ import annotations

import base64
import gzip
import json
import zlib
from typing import cast

import httpx
import pytest
from conftest import AppFactory
from fastapi import FastAPI
from frozen_contracts import frozen_outcome, object_mapping

_VALID_ID = "550e8400-e29b-41d4-a716-446655440000"
_VALID_BODY: dict[str, object] = {"geoGenerationId": _VALID_ID, "locale": "ko-KR", "product": {}}


def _response_message(response: httpx.Response) -> object | None:
    payload: object = response.json()
    if not isinstance(payload, dict):
        return None
    return object_mapping(cast(dict[object, object], payload)).get("message")


@pytest.mark.asyncio
async def test_completed_zlib_streams_match_frozen_member_and_trailing_rules(app_factory: AppFactory) -> None:
    """Gunzip concatenates members, while Inflate ignores bytes after stream one."""

    raw = json.dumps(_VALID_BODY, separators=(",", ":")).encode()
    split_at = len(raw) // 2
    cases = [
        {
            "encoding": "gzip",
            "contentType": "application/json",
            "body": base64.b64encode(gzip.compress(raw) + b"\0").decode(),
        },
        {
            # Once Gunzip encounters padding, it treats that marker as
            # terminal even if a later ASGI frame supplies another member.
            "encoding": "gzip",
            "contentType": "application/json",
            "body": base64.b64encode(gzip.compress(raw) + b"\0" + gzip.compress(b'{"ignored":true}')).decode(),
        },
        {
            "encoding": "deflate",
            "contentType": "application/json",
            "body": base64.b64encode(zlib.compress(raw) + b"trailing bytes").decode(),
        },
        {
            "encoding": "deflate",
            "contentType": "application/json",
            "body": base64.b64encode(zlib.compress(raw[:split_at]) + zlib.compress(raw[split_at:])).decode(),
        },
        {
            "encoding": "deflate",
            "contentType": "application/json",
            "body": base64.b64encode(zlib.compress(raw) + zlib.compress(b'{"ignored":true}')).decode(),
        },
        {
            "encoding": "gzip",
            "contentType": "application/json",
            "body": base64.b64encode(gzip.compress(raw[:split_at]) + gzip.compress(raw[split_at:])).decode(),
        },
    ]
    expected = frozen_outcome("round_five", "test_completed_zlib_streams_match_frozen_member_and_trailing_rules", cases)
    app = app_factory()
    actual: list[dict[str, object | None]] = []
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        for case in cases:
            response = await client.post(
                "/internal/v1/geo/generations",
                content=base64.b64decode(case["body"]),
                headers={"content-type": case["contentType"], "content-encoding": case["encoding"]},
            )
            actual.append({"status": response.status_code, "message": _response_message(response)})

    assert actual == [{"status": item["status"], "message": item["body"].get("message")} for item in expected]


@pytest.mark.asyncio
async def test_content_type_and_iconv_charset_boundary_match_frozen_before_auth(app_factory: AppFactory) -> None:
    """Quoted parameters and iconv labels are parsed before API-key auth."""

    raw = json.dumps(_VALID_BODY, separators=(",", ":")).encode()
    cases = [
        {
            "encoding": "identity",
            "contentType": "application/json; charset=utf-8-sig",
            "body": base64.b64encode(b"\xef\xbb\xbf" + raw).decode(),
        },
        {
            "encoding": "identity",
            "contentType": 'application/json; charset="utf-8;foo"',
            "body": base64.b64encode(raw).decode(),
        },
        {
            "encoding": "identity",
            "contentType": 'application/json; charset="utf\\-8"',
            "body": base64.b64encode(raw).decode(),
        },
        {
            "encoding": "identity",
            "contentType": 'application/json; note="x;y"; charset=utf-8',
            "body": base64.b64encode(raw).decode(),
        },
        {
            "encoding": "identity",
            "contentType": "application/json; charset=utf-16le",
            "body": base64.b64encode(raw.decode().encode("utf-16le")).decode(),
        },
        {
            "encoding": "identity",
            "contentType": "application/json; charset=utf-8; charset=latin1",
            "body": base64.b64encode(raw).decode(),
        },
        {
            "encoding": "identity",
            "contentType": "application/json; charset=latin1; charset=utf-8",
            "body": base64.b64encode(raw).decode(),
        },
        {
            "encoding": "identity",
            "contentType": "application/json; ignored; charset=latin1",
            "body": base64.b64encode(raw).decode(),
        },
    ]
    expected = frozen_outcome(
        "round_five", "test_content_type_and_iconv_charset_boundary_match_frozen_before_auth", cases
    )
    assert [item["status"] for item in expected] == [415, 415, 202, 202, 202, 202, 415, 415]

    async def call(app: FastAPI) -> list[httpx.Response]:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            return [
                await client.post(
                    "/internal/v1/geo/generations",
                    content=base64.b64decode(case["body"]),
                    headers={"content-type": case["contentType"], "content-encoding": case["encoding"]},
                )
                for case in cases
            ]

    direct = await call(app_factory())
    assert [{"status": response.status_code, "message": _response_message(response)} for response in direct] == [
        {"status": item["status"], "message": item["body"].get("message")} for item in expected
    ]

    authenticated = await call(app_factory(api_key="secret"))
    assert [response.status_code for response in authenticated] == [415, 415, 401, 401, 401, 401, 415, 415]
    assert [_response_message(response) for response in authenticated[:2]] == [
        item["body"]["message"] for item in expected[:2]
    ]


@pytest.mark.asyncio
async def test_utf7_variants_discard_iconv_incomplete_utf16_tail_before_json_parse(app_factory: AppFactory) -> None:
    """iconv-lite emits complete UTF-16BE units and drops a shifted final byte."""

    prefix = b'{"geoGenerationId":"550e8400-e29b-41d4-a716-446655440000","locale":"ko-KR","product":{},"x":'
    cases = [
        {
            "encoding": "identity",
            "contentType": "application/json; charset=utf-7-imap",
            "body": base64.b64encode(prefix + b'&ACIA-"}').decode(),
        },
        {
            "encoding": "identity",
            "contentType": "application/json; charset=utf-7",
            "body": base64.b64encode(prefix + b'+ACIA-"}').decode(),
        },
        {
            "encoding": "identity",
            "contentType": "application/json; charset=utf-7-imap",
            "body": base64.b64encode(prefix + b'&ACIAA-"}').decode(),
        },
        {
            "encoding": "identity",
            "contentType": "application/json; charset=utf-7",
            "body": base64.b64encode(prefix + b'+ACIAA-"}').decode(),
        },
    ]
    expected = frozen_outcome(
        "round_five", "test_utf7_variants_discard_iconv_incomplete_utf16_tail_before_json_parse", cases
    )
    assert [item["status"] for item in expected] == [202, 202, 202, 202]

    app = app_factory()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        actual = [
            await client.post(
                "/internal/v1/geo/generations",
                content=base64.b64decode(case["body"]),
                headers={"content-type": case["contentType"]},
            )
            for case in cases
        ]

    assert [{"status": response.status_code, "message": _response_message(response)} for response in actual] == [
        {"status": item["status"], "message": item["body"].get("message")} for item in expected
    ]


@pytest.mark.asyncio
async def test_internal_url_whitespace_uses_retained_ecmascript_set(app_factory: AppFactory) -> None:
    """U+0085 and U+FEFF differ between Python and ECMAScript ``\\s``."""

    cases = [
        "https://example.com/path\u0085segment",
        "https://example.com/path\ufeffsegment",
        "https://exa\u0085mple.com",
        "https://exa\ufeffmple.com",
    ]
    expected = frozen_outcome("round_five", "test_internal_url_whitespace_uses_retained_ecmascript_set", cases)
    app = app_factory()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        actual = [
            (
                await client.post(
                    "/internal/v1/geo/generations",
                    json={**_VALID_BODY, "brandSameAs": [url]},
                )
            ).status_code
            == 202
            for url in cases
        ]

    assert actual == expected


@pytest.mark.asyncio
async def test_provider_credentials_use_retained_ecmascript_regex_whitespace(
    monkeypatch: pytest.MonkeyPatch, app_factory: AppFactory
) -> None:
    """Credential headers expose the retained ``export`` and assignment regex grammar."""

    cases: list[dict[str, object]] = [
        {
            "body": {"provider": "openai", "apiKey": "export\u0085key", "listOnly": True},
            "upstreamStatus": 200,
            "upstream": {"data": []},
        },
        {
            "body": {"provider": "openai", "apiKey": "export\ufeffkey", "listOnly": True},
            "upstreamStatus": 200,
            "upstream": {"data": []},
        },
        {
            "body": {"provider": "openai", "apiKey": "X\u0085=\u0085key", "listOnly": True},
            "upstreamStatus": 200,
            "upstream": {"data": []},
        },
        {
            "body": {"provider": "openai", "apiKey": "X\ufeff=\ufeffkey", "listOnly": True},
            "upstreamStatus": 200,
            "upstream": {"data": []},
        },
        {
            "body": {"provider": "openai", "apiKey": "X=key\u2028tail", "listOnly": True},
            "upstreamStatus": 200,
            "upstream": {"data": []},
        },
        {
            "body": {"provider": "openai", "apiKey": "X=key\rtail", "listOnly": True},
            "upstreamStatus": 200,
            "upstream": {"data": []},
        },
        *[
            {
                "body": {"provider": "openai", "apiKey": f"{prefix}EY=secret", "listOnly": True},
                "upstreamStatus": 200,
                "upstream": {"data": []},
            }
            for prefix in ("K", "ſ", "İ", "ı")
        ],
    ]
    expected = frozen_outcome("round_five", "test_provider_credentials_use_retained_ecmascript_regex_whitespace", cases)
    seen: list[dict[str, str]] = []

    class Response:
        status_code = 200

        @staticmethod
        def json() -> object:
            return {"data": []}

    class Client:
        def __init__(self, **_kwargs: object) -> None:
            pass

        async def __aenter__(self) -> Client:
            return self

        async def __aexit__(self, *_args: object) -> bool:
            return False

        async def get(self, _url: str, *, headers: dict[str, str]) -> Response:
            seen.append(headers)
            return Response()

    asgi_client = httpx.AsyncClient
    monkeypatch.setattr("neo_agent_api.services.provider_validation.httpx.AsyncClient", Client)
    app = app_factory()
    async with asgi_client(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        actual = [await client.post("/provider/validate", json=case["body"]) for case in cases]

    assert [{"status": response.status_code, "body": response.json()} for response in actual] == [
        {"status": item["status"], "body": item["body"]} for item in expected
    ]
    assert seen == [item["headers"][0] for item in expected]


@pytest.mark.asyncio
async def test_provider_error_codes_and_whitespace_use_retained_js_coercion(
    monkeypatch: pytest.MonkeyPatch, app_factory: AppFactory
) -> None:
    """Provider error bytes use template-string conversion and ECMAScript whitespace."""

    cases: list[dict[str, object]] = [
        {
            "body": {"provider": "openai", "apiKey": "key", "listOnly": True},
            "upstreamStatus": 401,
            "upstream": {"error": {"message": "failure", "code": True}},
        },
        {
            "body": {"provider": "openai", "apiKey": "key", "listOnly": True},
            "upstreamStatus": 401,
            "upstream": {"error": {"message": "failure", "code": ["a", None, 2]}},
        },
        {
            "body": {"provider": "openai", "apiKey": "key", "listOnly": True},
            "upstreamStatus": 401,
            "upstream": {"error": {"message": "failure", "code": {"kind": "x"}}},
        },
        {
            "body": {"provider": "openai", "apiKey": "key", "listOnly": True},
            "upstreamStatus": 401,
            "upstream": {"error": {"message": "before\u0085after"}},
        },
        {
            "body": {"provider": "openai", "apiKey": "key", "listOnly": True},
            "upstreamStatus": 401,
            "upstream": {"error": {"message": "before\ufeffafter"}},
        },
        {
            "body": {"provider": "openai", "apiKey": "key", "listOnly": True},
            "upstreamStatus": 401,
            "upstream": {"error": {"message": "sk-proj-ABCDEFGK"}},
        },
        {
            "body": {"provider": "openai", "apiKey": "key", "listOnly": True},
            "upstreamStatus": 401,
            "upstream": {"error": {"message": "incorrect api Key"}},
        },
    ]
    expected = frozen_outcome("round_five", "test_provider_error_codes_and_whitespace_use_retained_js_coercion", cases)
    responses: list[tuple[int, object]] = []
    for case in cases:
        status = case["upstreamStatus"]
        assert isinstance(status, int)
        responses.append((status, case["upstream"]))

    class Response:
        def __init__(self, status: int, payload: object) -> None:
            self.status_code = status
            self._payload = payload

        def json(self) -> object:
            return self._payload

    class Client:
        def __init__(self, **_kwargs: object) -> None:
            pass

        async def __aenter__(self) -> Client:
            return self

        async def __aexit__(self, *_args: object) -> bool:
            return False

        async def get(self, *_args: object, **_kwargs: object) -> Response:
            status, payload = responses.pop(0)
            return Response(status, payload)

    asgi_client = httpx.AsyncClient
    monkeypatch.setattr("neo_agent_api.services.provider_validation.httpx.AsyncClient", Client)
    app = app_factory()
    async with asgi_client(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        actual = [await client.post("/provider/validate", json=case["body"]) for case in cases]

    assert [{"status": response.status_code, "body": response.json()} for response in actual] == [
        {"status": item["status"], "body": item["body"]} for item in expected
    ]
