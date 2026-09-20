"""Provider adapter for the evaluator's simulated generative engine."""

from __future__ import annotations

import asyncio
import math
import re
from collections.abc import Mapping
from typing import cast
from urllib.parse import quote

import httpx
from neo_js_compat import js_json_dumps, js_round

from ..prompts.citation_answer import build_citation_answer_prompt

DEFAULT_MAX_RETRIES = 3
DEFAULT_RETRY_DELAY_MS = 5000
# Quality evaluation uses the same model-backed path as the generator.  A
# shorter legacy evaluator timeout can make a healthy long-running pipeline
# appear to fail after the artifact itself was already produced.
DEFAULT_TIMEOUT_MS = 900000


def geo_eval_engine_id(config: Mapping[str, object]) -> str:
    model = _first_non_nullish(_field(config, "model"), _field(config, "deployment"), "unknown-model")
    return f"{_field(config, 'provider')}:{model}"


async def generate_engine_answer(
    config: Mapping[str, object], query: str, sources: list[str], *, client: httpx.AsyncClient | None = None
) -> dict[str, str]:
    """Generate a cited answer with the legacy retry/backoff behavior."""
    prompt = build_citation_answer_prompt(query, sources)
    max_retries = _number(config, "maxRetries", DEFAULT_MAX_RETRIES)
    retry_delay_ms = _number(config, "retryDelayMs", DEFAULT_RETRY_DELAY_MS)
    last_error: Exception | None = None
    for attempt in range(max_retries):
        try:
            answer = await complete_with_provider(config, prompt["system"], prompt["user"], client=client)
            return {"answer": answer, "engineId": geo_eval_engine_id(config)}
        except Exception as error:  # preserve provider error wording in final aggregate error
            last_error = error
            if attempt < max_retries - 1:
                await asyncio.sleep(retry_delay_ms * (attempt + 1) / 1000)
    message = str(last_error) if last_error else "undefined"
    raise RuntimeError(f"Simulated engine {geo_eval_engine_id(config)} failed after {max_retries} attempts: {message}")


async def complete_with_provider(
    config: Mapping[str, object], system: str, user: str, *, client: httpx.AsyncClient | None = None
) -> str:
    """Run one text completion against OpenAI, Gemini, Azure, or AI Studio."""
    owns_client = client is None
    if client is None:
        client = httpx.AsyncClient()
    try:
        provider = _field(config, "provider")
        if provider == "openai":
            return await _complete_openai(config, system, user, client)
        if provider == "gemini":
            return await _complete_gemini(config, system, user, client)
        if provider in {"azure-openai", "aistudio"}:
            return await _complete_chat_completions(config, system, user, client)
        raise ValueError(f"Unsupported geo-eval provider: {provider}")
    finally:
        if owns_client:
            await client.aclose()


async def _complete_openai(config: Mapping[str, object], system: str, user: str, client: httpx.AsyncClient) -> str:
    model = _field(config, "model")
    if not isinstance(model, str) or not model:
        raise ValueError("geo-eval openai provider requires a model id.")
    body: dict[str, object] = {"model": model, "instructions": system, "input": user}
    body.update(_temperature_body(_field(config, "temperature")))
    response = await _post(client, "https://api.openai.com/v1/responses", {"Authorization": f"Bearer {_field(config, 'apiKey')}", "Content-Type": "application/json"}, body, config, "geo-eval OpenAI call")
    await _assert_ok(response, "geo-eval OpenAI call")
    payload = _response_mapping(response)
    output_text = payload.get("output_text") if payload is not None else None
    if isinstance(output_text, str) and output_text.strip():
        return output_text
    output = payload.get("output") if payload is not None else None
    texts: list[str] = []
    output_items = _object_list(output)
    if output_items is not None:
        for item in output_items:
            item_mapping = _object_mapping(item)
            if item_mapping is None:
                continue
            content_parts = _object_list(item_mapping.get("content"))
            if content_parts is None:
                continue
            for part in content_parts:
                part_mapping = _object_mapping(part)
                if part_mapping is None or part_mapping.get("type") != "output_text":
                    continue
                part_text = part_mapping.get("text")
                if isinstance(part_text, str):
                    texts.append(part_text)
    text = "\n".join(texts)
    if not text.strip():
        raise RuntimeError("geo-eval OpenAI call returned an empty answer.")
    return text


async def _complete_gemini(config: Mapping[str, object], system: str, user: str, client: httpx.AsyncClient) -> str:
    model = _field(config, "model")
    if not isinstance(model, str) or not model:
        raise ValueError("geo-eval gemini provider requires a model id.")
    body: dict[str, object] = {"systemInstruction": {"parts": [{"text": system}]}, "contents": [{"role": "user", "parts": [{"text": user}]}]}
    temperature = _gemini_temperature_body(_field(config, "temperature"))
    if temperature:
        body["generationConfig"] = temperature
    response = await _post(client, f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent", {"Content-Type": "application/json", "x-goog-api-key": _string(_field(config, "apiKey"))}, body, config, "geo-eval Gemini call")
    await _assert_ok(response, "geo-eval Gemini call")
    payload = _response_mapping(response)
    candidates = _object_list(payload.get("candidates")) if payload is not None else None
    first = _object_mapping(candidates[0]) if candidates else None
    content = _object_mapping(first.get("content")) if first is not None else None
    parts = _object_list(content.get("parts")) if content is not None else None
    text = "\n".join(
        _string(part_mapping.get("text"))
        for part in parts or []
        if (part_mapping := _object_mapping(part)) is not None
    )
    if not text.strip():
        raise RuntimeError("geo-eval Gemini call returned an empty answer.")
    return text


async def _complete_chat_completions(config: Mapping[str, object], system: str, user: str, client: httpx.AsyncClient) -> str:
    provider = _string(_field(config, "provider"))
    endpoint = _field(config, "endpoint")
    deployment = _field(config, "deployment")
    if not isinstance(endpoint, str) or not endpoint or not isinstance(deployment, str) or not deployment:
        raise ValueError(f"geo-eval {provider} provider requires endpoint and deployment.")
    endpoint = endpoint.removesuffix("/")
    configured_version = _field(config, "apiVersion")
    # AI Studio trims an optional version before URI encoding; Azure preserves
    # its nullish value verbatim and falls back only when it is absent.
    api_version = (
        configured_version.strip() if isinstance(configured_version, str) and configured_version.strip() else None
    ) if provider == "aistudio" else (
        configured_version if isinstance(configured_version, str) else "2025-04-01-preview"
    )
    query = f"?api-version={quote(api_version, safe='')}" if api_version else ""
    url = f"{endpoint}/openai/deployments/{deployment}/chat/completions{query}"
    auth_headers = {"api-key": _string(_field(config, "apiKey"))} if provider == "azure-openai" else {"Authorization": f"Bearer {_field(config, 'apiKey')}"}
    body: dict[str, object] = {"messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
    body.update(_temperature_body(_field(config, "temperature")))
    response = await _post(client, url, auth_headers, body, config, f"geo-eval {provider} call")
    if not response.is_success and "temperature" in body:
        suffix = await _response_error_suffix(response)
        if re.search(r"unsupported value.*temperature|temperature.*(?:unsupported|only the default)", suffix, re.I | re.S):
            retry_body = {key: value for key, value in body.items() if key != "temperature"}
            response = await _post(client, url, auth_headers, retry_body, config, f"geo-eval {provider} call")
        else:
            raise RuntimeError(f"geo-eval {provider} call failed: {response.status_code}{suffix}")
    await _assert_ok(response, f"geo-eval {provider} call")
    payload = _response_mapping(response)
    choices = _object_list(payload.get("choices")) if payload is not None else None
    first = _object_mapping(choices[0]) if choices else None
    message = _object_mapping(first.get("message")) if first is not None else None
    text = _string(message.get("content")) if message is not None else ""
    if not text.strip():
        raise RuntimeError(f"geo-eval {provider} call returned an empty answer.")
    return text


async def _post(
    client: httpx.AsyncClient,
    url: str,
    headers: Mapping[str, str],
    body: Mapping[str, object],
    config: Mapping[str, object],
    label: str,
) -> httpx.Response:
    timeout_ms = _model_timeout_ms(config)
    try:
        return await client.post(
            url,
            headers={"Content-Type": "application/json", **headers},
            content=js_json_dumps(body).encode("utf-8"),
            timeout=timeout_ms / 1000,
        )
    except httpx.TimeoutException as error:
        raise RuntimeError(f"{label} timed out after {int(js_round(timeout_ms / 1000))}s.") from error


async def _assert_ok(response: httpx.Response, label: str) -> None:
    if not response.is_success:
        raise RuntimeError(f"{label} failed: {response.status_code}{await _response_error_suffix(response)}")


async def _response_error_suffix(response: httpx.Response) -> str:
    text = re.sub(r"\s+", " ", response.text).strip()
    return f" - {text[:500]}" if text else ""


def _temperature_body(value: object) -> dict[str, float]:
    return {"temperature": float(value)} if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else {}


def _gemini_temperature_body(value: object) -> dict[str, float]:
    return {"temperature": float(value)} if isinstance(value, (int, float)) and not isinstance(value, bool) else {}


def _field(value: Mapping[str, object], name: str) -> object:
    return value.get(name)


def _first_non_nullish(*values: object) -> object:
    return next((value for value in values if value is not None), None)


def _number(value: Mapping[str, object], name: str, default: int) -> int:
    raw = value.get(name)
    return int(raw) if isinstance(raw, (int, float)) and not isinstance(raw, bool) else default


def _model_timeout_ms(config: Mapping[str, object]) -> int:
    """Keep every model-backed evaluator call within the shared 15-minute floor."""

    configured = _field(config, "timeoutMs")
    if not isinstance(configured, (int, float)) or isinstance(configured, bool) or not math.isfinite(configured):
        return DEFAULT_TIMEOUT_MS
    return max(int(configured), DEFAULT_TIMEOUT_MS)


def _string(value: object) -> str:
    return value if isinstance(value, str) else ""


def _response_mapping(response: httpx.Response) -> Mapping[str, object] | None:
    return _object_mapping(cast(object, response.json()))


def _object_mapping(value: object) -> Mapping[str, object] | None:
    if not isinstance(value, Mapping):
        return None
    mapping = cast(Mapping[object, object], value)
    if not all(isinstance(key, str) for key in mapping):
        return None
    return cast(Mapping[str, object], mapping)


def _object_list(value: object) -> list[object] | None:
    return cast(list[object], value) if isinstance(value, list) else None
