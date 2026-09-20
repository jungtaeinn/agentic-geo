"""Post-terminal frozen API boundary regression contracts."""

from __future__ import annotations

import base64
from functools import partial
from typing import TypedDict

import httpx
import pytest
from conftest import AppFactory, capturing_queue
from frozen_contracts import frozen_outcome, integer_value, object_list, object_mapping, string_value
from neo_js_compat import js_json_dumps


class _MediaCase(TypedDict):
    contentType: str
    body: str
    framed: bool
    auth: bool


@pytest.mark.asyncio
async def test_media_type_validity_preserves_nest_parser_before_auth_boundary(app_factory: AppFactory) -> None:
    cases: list[_MediaCase] = [
        {"contentType": ";n", "body": body, "framed": True, "auth": auth}
        for body in ["{}", ""]
        for auth in [True, False]
    ]
    cases.extend(
        {"contentType": value, "body": "{}", "framed": True, "auth": True}
        for value in [
            "",
            ";",
            " \t;n",
            "application/json;n",
            ".application/json",
            "application*/json",
            "application/+json",
            "application/json*",
            "application/json/extra",
            "application/ json",
        ]
    )
    cases.append({"contentType": ";n", "body": "", "framed": False, "auth": True})
    retained = object_list(
        frozen_outcome("post_terminal", "test_media_type_validity_preserves_nest_parser_before_auth_boundary", cases)
    )
    assert all(
        integer_value(object_mapping(item)["authCalls"]) == 0 and integer_value(object_mapping(item)["status"]) == 500
        for item in retained[:4]
    )
    actual: list[tuple[int, bytes, str]] = []
    for case in cases:
        app = app_factory(api_key="secret" if case["auth"] else "")
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            request = client.build_request(
                "POST",
                "/internal/v1/geo/generations",
                content=case["body"],
                headers={"content-type": case["contentType"]},
            )
            if not case["framed"]:
                request.headers.pop("content-length", None)
                request.headers.pop("transfer-encoding", None)
            response = await client.send(request)
            actual.append((response.status_code, response.content, response.headers["content-type"]))
        assert capturing_queue(app).added == []

    assert actual == [
        (
            integer_value(object_mapping(item)["status"]),
            string_value(object_mapping(item)["raw"]).encode(),
            string_value(object_mapping(item)["contentType"]),
        )
        for item in retained
    ]


@pytest.mark.asyncio
async def test_utf7_imap_slash_stays_in_retained_shifted_alphabet_before_auth(app_factory: AppFactory) -> None:
    bodies = [b'"&/"', b'"&//"', b'"&///"', b'"&,/"', b'{"x":"&//8-"}', b'{"x":"&,,8-"}']
    cases = [
        {
            "encoding": "identity",
            "contentType": "application/json; charset=utf-7-imap",
            "body": base64.b64encode(body).decode(),
        }
        for body in bodies
    ]
    retained = object_list(
        frozen_outcome("post_terminal", "test_utf7_imap_slash_stays_in_retained_shifted_alphabet_before_auth", cases)
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app_factory(api_key="secret")), base_url="http://test"
    ) as client:
        actual = [
            await client.post(
                "/internal/v1/geo/generations",
                content=body,
                headers={"content-type": case["contentType"]},
            )
            for body, case in zip(bodies, cases, strict=True)
        ]

    expected = [
        (
            401,
            b'{"message":"invalid x-api-key","error":"Unauthorized","statusCode":401}',
        )
        if integer_value(object_mapping(item)["status"]) == 202
        else (
            integer_value(object_mapping(item)["status"]),
            js_json_dumps(
                {
                    "message": object_mapping(object_mapping(item)["body"])["message"],
                    "error": "Bad Request",
                    "statusCode": 400,
                }
            ).encode(),
        )
        for item in retained
    ]
    assert [(response.status_code, response.content) for response in actual] == expected


@pytest.mark.asyncio
async def test_provider_error_components_match_retained_filter_boolean_join(
    monkeypatch: pytest.MonkeyPatch, app_factory: AppFactory
) -> None:
    # Absent/falsy messages still permit codes, but truthy nonstrings fail at
    # .replace. Whitespace disappears from messages but is preserved in codes.
    message_values: list[object] = [None, "", False, 0, " \t\n", "failure", True, [], {}]
    code_values: list[object] = [None, "", False, 0, "E1", " \t ", True, [], {}]
    messages: list[dict[str, object]] = [{}, *[{"message": value} for value in message_values]]
    codes: list[dict[str, object]] = [{}, *[{"code": value} for value in code_values]]
    cases: list[dict[str, object]] = [
        {
            "body": {"provider": "openai", "apiKey": "key", "listOnly": True},
            "upstreamStatus": 401,
            "upstream": {"error": {**message, **code}},
        }
        for message in messages
        for code in codes
    ]
    cases.extend(
        {
            "body": {"provider": "openai", "apiKey": "key", "listOnly": True},
            "upstreamStatus": 401,
            "upstream": {
                "error": {**message, **code, "status": "FALLBACK"},
                "error_description": "fallback message",
            },
        }
        for message in messages[:6]
        for code in codes[:5]
    )
    retained = object_list(
        frozen_outcome("post_terminal", "test_provider_error_components_match_retained_filter_boolean_join", cases)
    )
    pending = iter(cases)

    def upstream(request: httpx.Request) -> httpx.Response:
        assert request.url == "https://api.openai.com/v1/models"
        assert request.headers["authorization"] == "Bearer key"
        return httpx.Response(401, json=next(pending)["upstream"])

    asgi_client = httpx.AsyncClient
    monkeypatch.setattr(
        "neo_agent_api.services.provider_validation.httpx.AsyncClient",
        partial(asgi_client, transport=httpx.MockTransport(upstream)),
    )
    async with asgi_client(transport=httpx.ASGITransport(app=app_factory()), base_url="http://test") as client:
        actual = [await client.post("/provider/validate", json=case["body"]) for case in cases]

    assert [(response.status_code, response.content) for response in actual] == [
        (integer_value(object_mapping(item)["status"]), string_value(object_mapping(item)["rawBody"]).encode())
        for item in retained
    ]
    assert next(pending, None) is None
