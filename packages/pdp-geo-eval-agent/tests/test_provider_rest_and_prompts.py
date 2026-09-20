"""Contract tests beyond the legacy unit suite: HTTP, ASGI, prompt, and CLI wires."""

from __future__ import annotations

import asyncio
import importlib
import json
from collections.abc import Awaitable, Callable
from typing import cast

import httpx
import pytest


def _engine():
    return importlib.import_module("pdp_geo_eval_agent.citation.engine")


def _prompts():
    return importlib.import_module("pdp_geo_eval_agent.prompts")


def _rest():
    return importlib.import_module("pdp_geo_eval_agent.rest")


def _cli():
    return importlib.import_module("pdp_geo_eval_agent.citation.cli")


def test_citation_answer_and_utility_prompt_wires_preserve_source_order_and_json_contract() -> None:
    prompts = _prompts()
    answer = prompts.build_citation_answer_prompt("What works?", ["first source", "second source"])
    assert answer["system"] == prompts.CITATION_ANSWER_INSTRUCTIONS
    assert "Every sentence" in answer["system"]
    assert answer["user"] == "Question: What works?\n\nSearch Results:\n### Source 0:\nfirst source\n\n### Source 1:\nsecond source"
    keypoints = prompts.build_keypoint_judge_prompt([{"id": "ev-1", "role": "benefit", "text": "firming"}], "public copy")
    assert '"content": "firming"' in keypoints["user"]
    assert '"Supported"' in keypoints["user"]
    claims = prompts.build_claim_extraction_prompt("Answer [2].")
    assert "claimId" in claims["user"] and "Answer [2]." in claims["user"]
    support = prompts.build_citation_support_prompt("Claim", "Source")
    assert 'Statement: "Claim"' in support["user"] and "Source Text:" in support["user"]


def test_keypoint_prompt_omits_absent_object_fields_like_json_stringify() -> None:
    prompts = _prompts()

    prompt = prompts.build_keypoint_judge_prompt([{"id": "ev-1"}], "public copy")

    assert '"id": "ev-1"' in prompt["user"]
    assert '"role": null' not in prompt["user"]
    assert '"content": null' not in prompt["user"]


def test_improvement_prompt_omits_empty_sections_and_preserves_json_ld_wire() -> None:
    prompts = _prompts()
    sections = {"productName": "Cream", "description": "  Good cream. ", "quickFacts": "", "benefits": "Firming", "ingredients": "", "howToUse": "", "faq": ""}
    assert prompts.format_content_sections_for_prompt(sections, "en") == "### Product name\nCream\n\n### Description\nGood cream.\n\n### Benefits\nFirming"
    evaluation = importlib.import_module("pdp_geo_eval_agent.quality.evaluate").evaluate_geo_quality({"jsonLd": {"@type": "Product", "@id": "p", "name": "Cream", "description": "Good cream"}, "diagnostics": {"normalizedProduct": {}, "validationWarnings": []}}, "en")
    prompt = prompts.format_quality_llm_prompt({"productName": "Cream", "contentSections": sections, "jsonLd": {"@type": "Product"}}, evaluation, "en")
    assert "Good cream." in prompt
    assert '"@type": "Product"' in prompt
    assert "Hard rule: never invent" in prompt


def test_improvement_prompt_preserves_raw_jsonld_unknown_keys_and_nulls() -> None:
    prompts = _prompts()
    evaluation = importlib.import_module("pdp_geo_eval_agent.quality.evaluate").evaluate_geo_quality(
        {"jsonLd": {"@type": "Product"}, "diagnostics": {"normalizedProduct": {}, "validationWarnings": []}},
        "en",
    )

    prompt = prompts.format_quality_llm_prompt(
        {
            "productName": "Cream",
            "contentSections": {},
            "jsonLd": {"custom_key": None, "snake_key": "v"},
        },
        evaluation,
        "en",
    )

    assert '"custom_key": null' in prompt
    assert '"snake_key": "v"' in prompt
    assert '"customKey"' not in prompt
    assert '"snakeKey"' not in prompt


def test_openai_provider_request_and_output_text_contract() -> None:
    engine = _engine()
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["headers"] = dict(request.headers)
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"output_text": "Cited answer [0]."})

    async def run() -> str:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await engine.complete_with_provider({"provider": "openai", "apiKey": "secret", "model": "gpt-test", "temperature": 0.2}, "system", "user", client=client)

    assert asyncio.run(run()) == "Cited answer [0]."
    assert seen["url"] == "https://api.openai.com/v1/responses"
    assert cast(dict[str, str], seen["headers"])["authorization"] == "Bearer secret"
    assert seen["body"] == {"model": "gpt-test", "instructions": "system", "input": "user", "temperature": 0.2}


def test_provider_completion_clamps_a_short_configured_timeout_to_the_fifteen_minute_floor() -> None:
    """A slow model stage must not inherit a legacy two-minute evaluator timeout."""

    engine = _engine()

    class RecordingClient:
        timeout: float | None = None

        async def post(self, *_args: object, **kwargs: object) -> httpx.Response:
            timeout = kwargs.get("timeout")
            assert isinstance(timeout, float)
            self.timeout = timeout
            return httpx.Response(200, json={"output_text": "Cited answer [0]."})

    client = RecordingClient()
    answer = asyncio.run(
        engine.complete_with_provider(
            {
                "provider": "openai",
                "apiKey": "secret",
                "model": "gpt-test",
                "timeoutMs": 120_000,
            },
            "system",
            "user",
            client=cast(httpx.AsyncClient, client),
        )
    )

    assert answer == "Cited answer [0]."
    assert client.timeout == 900.0


def test_gemini_provider_request_and_nested_response_contract() -> None:
    engine = _engine()
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["headers"] = dict(request.headers)
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": "one"}, {"text": "two"}]}}]})

    async def run() -> str:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await engine.complete_with_provider({"provider": "gemini", "apiKey": "gem-key", "model": "gemini-x"}, "system", "user", client=client)

    assert asyncio.run(run()) == "one\ntwo"
    assert seen["url"] == "https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent"
    assert cast(dict[str, str], seen["headers"])["x-goog-api-key"] == "gem-key"
    assert seen["body"] == {"systemInstruction": {"parts": [{"text": "system"}]}, "contents": [{"role": "user", "parts": [{"text": "user"}]}]}


def test_azure_retries_once_without_temperature_only_for_unsupported_temperature_response() -> None:
    engine = _engine()
    bodies: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        if len(bodies) == 1:
            return httpx.Response(400, text="unsupported value for temperature")
        return httpx.Response(200, json={"choices": [{"message": {"content": "retry answer"}}]})

    async def run() -> str:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await engine.complete_with_provider({"provider": "azure-openai", "apiKey": "azure-key", "endpoint": "https://azure.example/", "deployment": "prod", "apiVersion": "2025-01-01", "temperature": 0.4}, "system", "user", client=client)

    assert asyncio.run(run()) == "retry answer"
    assert len(bodies) == 2
    assert bodies[0]["temperature"] == 0.4
    assert "temperature" not in bodies[1]
    assert engine.geo_eval_engine_id({"provider": "azure-openai", "apiKey": "x", "deployment": "prod"}) == "azure-openai:prod"


def test_aistudio_trims_api_version_before_encoding_the_query_string() -> None:
    """The JavaScript adapter uses ``config.apiVersion?.trim()``."""
    engine = _engine()
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        return httpx.Response(200, json={"choices": [{"message": {"content": "answer"}}]})

    async def run() -> str:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await engine.complete_with_provider(
                {
                    "provider": "aistudio",
                    "apiKey": "ai-key",
                    "endpoint": "https://aistudio.example/",
                    "deployment": "prod",
                    "apiVersion": " 2025-01-01 ",
                },
                "system",
                "user",
                client=client,
            )

    assert asyncio.run(run()) == "answer"
    assert seen["url"] == "https://aistudio.example/openai/deployments/prod/chat/completions?api-version=2025-01-01"


def test_cli_argument_and_environment_provider_contracts(monkeypatch: pytest.MonkeyPatch) -> None:
    cli = _cli()
    assert cli.arg_value(["--model", "gpt-test", "--temperature"], "--model") == "gpt-test"
    assert cli.arg_value(["--model"], "--model") is None
    monkeypatch.setenv("OPENAI_API_KEY", "key")
    monkeypatch.setenv("OPENAI_MODEL", "env-model")
    assert cli.resolve_engine_config_from_env("openai", [], environ={"OPENAI_API_KEY": "key", "OPENAI_MODEL": "env-model"}) == {"provider": "openai", "apiKey": "key", "model": "env-model", "temperature": 0.5}


@pytest.mark.parametrize(
    ("provider", "args", "environ", "expected"),
    [
        ("openai", ["--model", "cli-openai"], {"OPENAI_API_KEY": "key"}, {"provider": "openai", "apiKey": "key", "model": "cli-openai", "temperature": 0.5}),
        ("gemini", ["--model", "cli-gemini"], {"GEMINI_API_KEY": "key"}, {"provider": "gemini", "apiKey": "key", "model": "cli-gemini", "temperature": 0.5}),
        ("azure-openai", ["--endpoint", "https://cli.azure", "--deployment", "cli-deployment"], {"AZURE_OPENAI_API_KEY": "key"}, {"provider": "azure-openai", "apiKey": "key", "endpoint": "https://cli.azure", "deployment": "cli-deployment", "temperature": 0.5}),
        ("aistudio", ["--endpoint", "https://cli.aistudio", "--deployment", "cli-deployment"], {"AISTUDIO_API_KEY": "key"}, {"provider": "aistudio", "apiKey": "key", "endpoint": "https://cli.aistudio", "deployment": "cli-deployment", "temperature": 0.5}),
    ],
)
def test_cli_flags_short_circuit_environment_fallback_requirements(provider: str, args: list[str], environ: dict[str, str], expected: dict[str, object]) -> None:
    cli = _cli()

    assert cli.resolve_engine_config_from_env(provider, args, environ=environ) == expected


def test_cli_and_engine_id_use_javascript_nullish_not_python_truthiness() -> None:
    cli = _cli()
    engine = _engine()

    config = cli.resolve_engine_config_from_env(
        "openai",
        ["--model", "", "--temperature", "12.5ignored"],
        environ={"OPENAI_API_KEY": "key", "OPENAI_MODEL": "env-model"},
    )

    assert config["model"] == ""
    assert config["temperature"] == 12.5
    assert engine.geo_eval_engine_id({"provider": "openai", "model": "", "deployment": "fallback"}) == "openai:"


def test_azure_preserves_an_explicit_empty_api_version_without_a_query_string() -> None:
    engine = _engine()
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        return httpx.Response(200, json={"choices": [{"message": {"content": "answer"}}]})

    async def run() -> str:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await engine.complete_with_provider(
                {
                    "provider": "azure-openai",
                    "apiKey": "azure-key",
                    "endpoint": "https://azure.example/",
                    "deployment": "prod",
                    "apiVersion": "",
                },
                "system",
                "user",
                client=client,
            )

    assert asyncio.run(run()) == "answer"
    assert seen["url"] == "https://azure.example/openai/deployments/prod/chat/completions"


async def _asgi_call(app: Callable[..., Awaitable[None]], method: str, body: bytes) -> tuple[int, dict[str, str], bytes]:
    events: list[dict[str, object]] = []
    received = False

    async def receive() -> dict[str, object]:
        nonlocal received
        if received:
            return {"type": "http.disconnect"}
        received = True
        return {"type": "http.request", "body": body, "more_body": False}

    async def send(event: dict[str, object]) -> None:
        events.append(event)

    await app({"type": "http", "method": method, "path": "/evaluate", "headers": []}, receive, send)
    start = next(event for event in events if event["type"] == "http.response.start")
    data = b"".join(cast(bytes, event.get("body", b"")) for event in events if event["type"] == "http.response.body")
    return int(cast(int, start["status"])), {
        key.decode().lower(): value.decode()
        for key, value in cast(list[tuple[bytes, bytes]], start["headers"])
    }, data


@pytest.mark.parametrize("json_ld", [False, {}, 0, ""])
def test_asgi_rest_contract_accepts_falsy_non_nullish_jsonld_and_emits_wire_fields(json_ld: object) -> None:
    app = _rest().create_pdp_geo_eval_asgi_app()
    status, headers, body = asyncio.run(_asgi_call(app, "POST", json.dumps({"jsonLd": json_ld, "language": "en"}).encode()))
    payload = json.loads(body)
    assert status == 200
    assert headers["content-type"] == "application/json"
    assert set(payload) == {"evaluation", "report"}
    assert "overallScore" in payload["evaluation"]
    assert "validationDetails" in payload["evaluation"]


@pytest.mark.parametrize("payload", [b"{", json.dumps({"jsonLd": None}).encode(), b"{}"])
def test_asgi_rest_contract_rejects_invalid_json_or_nullish_required_jsonld(payload: bytes) -> None:
    app = _rest().create_pdp_geo_eval_asgi_app()
    status, _headers, body = asyncio.run(_asgi_call(app, "POST", payload))
    assert status == 400
    assert "error" in json.loads(body)


def test_asgi_rest_contract_rejects_non_post_with_405() -> None:
    status, headers, _body = asyncio.run(_asgi_call(_rest().create_pdp_geo_eval_asgi_app(), "GET", b""))
    assert status == 405
    assert headers["allow"] == "POST"


def test_asgi_rest_escapes_lone_utf16_surrogate_from_truncated_validation_warning() -> None:
    app = _rest().create_pdp_geo_eval_asgi_app()
    warning = "x" * 176 + "😀" + "tail"

    status, _headers, body = asyncio.run(
        _asgi_call(
            app,
            "POST",
            json.dumps(
                {
                    "jsonLd": {"@type": "Product"},
                    "language": "en",
                    "diagnostics": {"normalizedProduct": {}, "validationWarnings": [warning]},
                }
            ).encode(),
        )
    )

    payload = json.loads(body)
    assert status == 200
    assert b"\\ud83d" in body
    assert any("\ud83d..." in detail for detail in payload["evaluation"]["validationDetails"])
