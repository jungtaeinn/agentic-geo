"""Transport-neutral primitives shared by PDP GEO model adapters.

The generator intentionally speaks each provider's native HTTP protocol.  This
module only owns the common mechanics: finite temperature handling, response
envelope parsing, stable errors/timeouts, and the one compatibility retry used
when a deployment rejects an explicitly supplied temperature.
"""

from __future__ import annotations

import asyncio
import json
import math
import re
from collections.abc import Awaitable, Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, cast

import httpx
from neo_js_compat import js_json_bytes, js_json_dumps

type JsonObject = dict[str, Any]
type Usage = dict[str, int | float]
type ResponseFactory = Callable[[httpx.Request], httpx.Response | Awaitable[httpx.Response]]

DEFAULT_MODEL_TIMEOUT_SECONDS = 900.0


def model_timeout_seconds(value: object) -> float:
    """Keep model requests long enough for complete structured generation."""

    if (
        isinstance(value, int | float)
        and not isinstance(value, bool)
        and math.isfinite(value)
        and value >= DEFAULT_MODEL_TIMEOUT_SECONDS
    ):
        return float(value)
    return DEFAULT_MODEL_TIMEOUT_SECONDS


class ProviderTransportError(RuntimeError):
    """A provider returned an unusable response or the network request failed."""


@dataclass(frozen=True)
class ProviderResult(Mapping[str, Any]):
    """Provider-neutral parsed response used by model-backed generator stages."""

    text: str
    payload: Mapping[str, Any]
    usage: Usage | None
    data: JsonObject | None

    def __getitem__(self, key: str) -> Any:
        return self._public_data()[key]

    def __iter__(self) -> Iterator[str]:
        return iter(self._public_data())

    def __len__(self) -> int:
        return len(self._public_data())

    def _public_data(self) -> JsonObject:
        """Expose parsed stage output as a mapping for retained model hooks."""

        value = dict(self.data or {})
        if self.usage is not None:
            value["usage"] = dict(self.usage)
        return value


@dataclass(frozen=True)
class ProviderGenerationRequest:
    """Canonical stage request shared by the concrete provider adapters."""

    system: str
    user: str
    schema: Mapping[str, Any] | None
    schema_name: str
    label: str


def resolve_generation_request(
    provider_name: str,
    system: str | None,
    user: str | None,
    schema: Mapping[str, Any] | None,
    schema_name: str | None,
    *,
    stage: str | None = None,
    payload: Mapping[str, Any] | None = None,
    json_schema: Mapping[str, Any] | None = None,
    label: str | None = None,
) -> ProviderGenerationRequest:
    """Accept both direct prompt calls and retained stage/payload hook calls.

    Stage hooks use a Python-friendly payload object.  It is serialized with
    JavaScript-compatible compact JSON before it crosses any provider boundary.
    """

    resolved_schema = json_schema if json_schema is not None else schema
    resolved_stage = stage or "generation"
    # A native stage builder owns the complete model-visible prompt, including
    # whether its nested JSON is pretty or compact.  Retain payload as the
    # compact compatibility path for older hooks only; it must never erase an
    # explicitly constructed user string.
    resolved_user = user if user is not None else (js_json_dumps(dict(payload)) if payload is not None else "")
    resolved_schema_name = schema_name or _schema_name_for_stage(resolved_stage)
    resolved_label = label or f"{provider_name} {_display_stage(resolved_stage)}"
    return ProviderGenerationRequest(
        system=system or "",
        user=resolved_user,
        schema=resolved_schema,
        schema_name=resolved_schema_name,
        label=resolved_label,
    )


def stage_required_message(provider: str, stage: str | None) -> str | None:
    """Return the retained per-stage credential error text when it is specific."""

    if stage in {"product-normalization", "keyword-normalization", "copy-refinement"}:
        operation = (stage or "").replace("-", " ")
        if provider == "openai":
            return f"OPENAI_API_KEY and OPENAI_MODEL are required for {operation}."
        if provider == "gemini":
            return f"GEMINI_API_KEY and GEMINI_MODEL are required for {operation}."
        if provider == "azure-openai":
            return (
                "AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT, and AZURE_OPENAI_DEPLOYMENT "
                f"are required for {operation}."
            )
        if provider == "aistudio" and stage == "product-normalization":
            return "AI Studio endpoint, API key, and reasoning model id are required for product normalization."
        if provider == "aistudio" and stage == "copy-refinement":
            return "AI Studio endpoint, API key, and a reasoning model id are required for copy refinement."
    if stage == "content-planning":
        if provider in {"openai", "gemini"}:
            return f"{provider.title() if provider == 'openai' else 'Gemini'} API key and model are required for content planning."
        if provider in {"azure-openai", "aistudio"}:
            return f"{provider} API key, endpoint, and reasoning deployment are required for content planning."
    if stage == "final-proofreading":
        if provider in {"openai", "gemini"}:
            return f"{'OpenAI' if provider == 'openai' else 'Gemini'} API key and model are required for final proofreading."
        if provider in {"azure-openai", "aistudio"}:
            return f"{provider} endpoint, API key, and deployment are required for final proofreading."
    return None


def temperature_body(temperature: object) -> dict[str, int | float]:
    """Return a request field only for explicit finite numeric temperatures."""

    if isinstance(temperature, int | float) and not isinstance(temperature, bool) and math.isfinite(temperature):
        return {"temperature": temperature}
    return {}


def to_gemini_schema(value: object) -> object:
    """Translate the strict JSON Schema subset accepted by Gemini.

    The retained content planner removes unsupported descriptive/open-object
    keywords and uppercases primitive type names before posting a schema.
    """

    if isinstance(value, list):
        return [to_gemini_schema(item) for item in cast(list[object], value)]
    mapping = _mapping(value)
    if mapping is None:
        return value
    alternatives = mapping.get("anyOf")
    nullable_pair = cast(list[object], alternatives) if isinstance(alternatives, list) else None
    if nullable_pair is not None and len(nullable_pair) == 2:
        non_null = next(
            (
                item
                for item in nullable_pair
                if (item_mapping := _mapping(item)) is not None and item_mapping.get("type") != "null"
            ),
            None,
        )
        nullable = any(
            (item_mapping := _mapping(item)) is not None and item_mapping.get("type") == "null"
            for item in nullable_pair
        )
        if non_null is not None and nullable:
            converted_non_null = _mapping(to_gemini_schema(non_null))
            if converted_non_null is not None:
                return {**converted_non_null, "nullable": True}
    converted: JsonObject = {}
    for key, child in mapping.items():
        if key in {"additionalProperties", "description"}:
            continue
        if key == "type" and isinstance(child, str):
            converted[key] = child.upper()
        else:
            converted[key] = to_gemini_schema(child)
    return converted


def response_json_object(response: httpx.Response, label: str) -> Mapping[str, Any]:
    """Read a successful response as the object envelope expected by adapters."""

    try:
        payload: object = response.json()
    except (TypeError, ValueError, json.JSONDecodeError) as error:
        raise ProviderTransportError(f"{label} returned an invalid JSON object.") from error
    if not isinstance(payload, Mapping):
        raise ProviderTransportError(f"{label} returned an invalid JSON object.")
    return cast(Mapping[str, Any], payload)


def response_error_suffix(response: httpx.Response) -> str:
    """Mirror the concise TypeScript body suffix used in provider errors."""

    try:
        text = response.text
    except (RuntimeError, ValueError):
        text = ""
    cleaned = " ".join(text.split())
    return f" - {cleaned[:500]}" if cleaned else ""


def is_unsupported_temperature_error(message: str) -> bool:
    """Identify the only request error eligible for a one-time retry."""

    return re.search(
        r"unsupported value[\s\S]*temperature|temperature[\s\S]*(?:unsupported|only the default)",
        message,
        re.IGNORECASE,
    ) is not None


def is_transient_transport_error(error: BaseException) -> bool:
    """Classify fast failures that callers may choose to retry once.

    Generator planning owns the policy decision; this helper deliberately does
    not make every model stage retry a long-running request.
    """

    if isinstance(error, (asyncio.TimeoutError, httpx.TimeoutException)):
        return False
    message = f"{type(error).__name__} {error}"
    if re.search(r"abort|timed?\s*out|timeout", message, re.IGNORECASE):
        return False
    return re.search(
        r"fetch failed|network|socket|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR|"
        r"too many requests|rate limit|status\s*(?:429|5\d\d)|(?:^|[^\d])(?:429|502|503|504)(?:[^\d]|$)|"
        r"server error|service unavailable|bad gateway",
        message,
        re.IGNORECASE,
    ) is not None


async def retry_transient_once(
    operation: Callable[[], Awaitable[ProviderResult]],
    *,
    delay_seconds: float = 0.75,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> tuple[ProviderResult, str | None]:
    """Run one retry after a fast transient failure, never after a timeout."""

    try:
        return await operation(), None
    except BaseException as error:
        if not is_transient_transport_error(error):
            raise
        first_message = str(error)
        await sleep(delay_seconds)
        return await operation(), first_message


async def post_json_with_temperature_fallback(
    url: str,
    headers: Mapping[str, str],
    body: Mapping[str, Any],
    label: str,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
    timeout_seconds: float = DEFAULT_MODEL_TIMEOUT_SECONDS,
) -> Mapping[str, Any]:
    """POST a JSON body and retry once if only temperature is rejected.

    This mirrors the retained adapters: the retry is scoped to an explicit
    temperature rejection, it removes that field only, and a second failure is
    reported without any further post.
    """

    resolved_timeout_seconds = model_timeout_seconds(timeout_seconds)
    initial_body = dict(body)
    response = await _post_json(
        url, headers, initial_body, label, transport=transport, timeout_seconds=resolved_timeout_seconds
    )
    if response.is_success:
        return response_json_object(response, label)

    suffix = response_error_suffix(response)
    if "temperature" in initial_body and is_unsupported_temperature_error(suffix):
        retry_body = dict(initial_body)
        retry_body.pop("temperature", None)
        retry = await _post_json(
            url, headers, retry_body, label, transport=transport, timeout_seconds=resolved_timeout_seconds
        )
        if retry.is_success:
            return response_json_object(retry, label)
        raise ProviderTransportError(f"{label} failed: {retry.status_code}{response_error_suffix(retry)}")

    raise ProviderTransportError(f"{label} failed: {response.status_code}{suffix}")


async def _post_json(
    url: str,
    headers: Mapping[str, str],
    body: Mapping[str, Any],
    label: str,
    *,
    transport: httpx.AsyncBaseTransport | None,
    timeout_seconds: float,
) -> httpx.Response:
    try:
        async with httpx.AsyncClient(transport=transport, timeout=timeout_seconds, follow_redirects=True) as client:
            return await client.post(
                url,
                headers={"Content-Type": "application/json", **headers},
                content=js_json_bytes(body),
            )
    except (TimeoutError, httpx.TimeoutException) as error:
        raise ProviderTransportError(f"{label} timed out after {_round_seconds(timeout_seconds)}s.") from error


def openai_output_text(payload: Mapping[str, Any]) -> str:
    """Extract text from both current and nested OpenAI Responses envelopes."""

    output_text = payload.get("output_text")
    if isinstance(output_text, str):
        return output_text
    parts: list[str] = []
    output = _sequence(payload.get("output"))
    if output is None:
        return ""
    for raw_item in output:
        item = _mapping(raw_item)
        if item is None:
            continue
        contents = _sequence(item.get("content"))
        if contents is None:
            continue
        for raw_content in contents:
            content = _mapping(raw_content)
            text = content.get("text") if content is not None else None
            if isinstance(text, str):
                parts.append(text)
    return "\n".join(parts)


def gemini_output_text(payload: Mapping[str, Any]) -> str:
    """Extract the first Gemini candidate's joined text parts."""

    candidates = _sequence(payload.get("candidates"))
    if not candidates:
        return ""
    first = _mapping(candidates[0])
    if first is None:
        return ""
    content = _mapping(first.get("content"))
    if content is None:
        return ""
    parts = _sequence(content.get("parts"))
    if parts is None:
        return ""
    texts: list[str] = []
    for raw_part in parts:
        part = _mapping(raw_part)
        text = part.get("text") if part is not None else None
        if isinstance(text, str):
            texts.append(text)
    return "\n".join(texts)


def chat_completions_output_text(payload: Mapping[str, Any]) -> str:
    """Extract Chat Completions text without treating malformed output as data."""

    choices = _sequence(payload.get("choices"))
    if not choices:
        return ""
    first = _mapping(choices[0])
    if first is None:
        return ""
    message = _mapping(first.get("message"))
    if message is None:
        return ""
    content = message.get("content")
    return content if isinstance(content, str) else ""


def token_usage_from_openai(value: object) -> Usage | None:
    """Normalize OpenAI Responses usage names without inventing a total."""

    usage = _mapping(value)
    if usage is None:
        return None
    return _compact_usage(
        usage.get("input_tokens") if _number(usage.get("input_tokens")) is not None else usage.get("prompt_tokens"),
        usage.get("output_tokens") if _number(usage.get("output_tokens")) is not None else usage.get("completion_tokens"),
        usage.get("total_tokens"),
    )


def token_usage_from_gemini(value: object) -> Usage | None:
    """Normalize Gemini usage metadata names."""

    usage = _mapping(value)
    if usage is None:
        return None
    return _compact_usage(usage.get("promptTokenCount"), usage.get("candidatesTokenCount"), usage.get("totalTokenCount"))


def token_usage_from_chat_completions(value: object) -> Usage | None:
    """Normalize Azure/AI Studio usage, adding a total only when derivable."""

    usage = _mapping(value)
    if usage is None:
        return None
    input_tokens = usage.get("prompt_tokens") if _number(usage.get("prompt_tokens")) is not None else usage.get("input_tokens")
    output_tokens = (
        usage.get("completion_tokens") if _number(usage.get("completion_tokens")) is not None else usage.get("output_tokens")
    )
    total_tokens = usage.get("total_tokens")
    if _number(total_tokens) is None and (_number(input_tokens) is not None or _number(output_tokens) is not None):
        total_tokens = (_number(input_tokens) or 0) + (_number(output_tokens) or 0)
    return _compact_usage(input_tokens, output_tokens, total_tokens)


def result_from_payload(text: str, payload: Mapping[str, Any], usage: Usage | None) -> ProviderResult:
    """Build the stable result object and keep malformed model JSON observable."""

    return ProviderResult(text=text, payload=dict(payload), usage=usage, data=parse_json_object_text(text))


def parse_json_object_text(text: str) -> JsonObject | None:
    """Parse a bare/fenced/braced JSON object without claiming prose is JSON."""

    candidate = extract_json_object_text(text)
    if candidate is None:
        return None
    try:
        parsed: object = json.loads(candidate)
    except json.JSONDecodeError:
        return None
    mapping = _mapping(parsed)
    return dict(mapping) if mapping is not None else None


def extract_json_object_text(text: str) -> str | None:
    """Retain the tolerant extraction shape used by generation stage parsers."""

    trimmed = text.strip()
    if trimmed.startswith("```"):
        trimmed = re.sub(r"^```(?:json)?\s*", "", trimmed, flags=re.IGNORECASE)
        trimmed = re.sub(r"\s*```$", "", trimmed)
    if trimmed.startswith("{") and trimmed.endswith("}"):
        return trimmed
    start, end = trimmed.find("{"), trimmed.rfind("}")
    return trimmed[start : end + 1] if start >= 0 and end > start else None


class DeterministicMockTransport(httpx.AsyncBaseTransport):
    """A queue-backed HTTP transport for exact provider fixture tests."""

    def __init__(self, responses: Sequence[httpx.Response | ResponseFactory]) -> None:
        self._responses = list(responses)
        self.requests: list[httpx.Request] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if not self._responses:
            raise AssertionError(f"Unexpected provider request: {request.method} {request.url}")
        next_response = self._responses.pop(0)
        if isinstance(next_response, httpx.Response):
            return next_response
        response = next_response(request)
        return await response if isinstance(response, Awaitable) else response


def _compact_usage(input_tokens: object, output_tokens: object, total_tokens: object) -> Usage | None:
    result: Usage = {}
    for key, value in (
        ("inputTokens", _number(input_tokens)),
        ("outputTokens", _number(output_tokens)),
        ("totalTokens", _number(total_tokens)),
    ):
        if value is not None:
            result[key] = value
    return result or None


def _number(value: object) -> int | float | None:
    return value if isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value) else None


def _mapping(value: object) -> Mapping[str, Any] | None:
    return cast(Mapping[str, Any], value) if isinstance(value, Mapping) else None


def _sequence(value: object) -> Sequence[Any] | None:
    if isinstance(value, Sequence) and not isinstance(value, str | bytes | bytearray):
        return cast(Sequence[Any], value)
    return None


def _round_seconds(value: float) -> int:
    """Use JavaScript-style half-up rounding for user-visible timeout labels."""

    return math.floor(value + 0.5)


def _schema_name_for_stage(stage: str) -> str:
    names = {
        "content-planning": "pdp_geo_content_plan",
        "copy-refinement": "pdp_geo_copy_refinement",
        "final-proofreading": "pdp_geo_final_proofreading",
        "product-normalization": "pdp_product_normalization_patch",
        "keyword-normalization": "pdp_geo_keyword_normalization",
    }
    return names.get(stage, f"pdp_geo_{stage.replace('-', '_')}")


def _display_stage(stage: str) -> str:
    return stage.replace("-", " ").strip() or "generation"


# Camel-case aliases preserve the TypeScript naming at the Python package seam.
temperatureBody = temperature_body
toGeminiSchema = to_gemini_schema
responseJsonObject = response_json_object
responseErrorSuffix = response_error_suffix
isUnsupportedTemperatureError = is_unsupported_temperature_error
isTransientTransportError = is_transient_transport_error
retryTransientOnce = retry_transient_once
postJsonWithTemperatureFallback = post_json_with_temperature_fallback
openaiOutputText = openai_output_text
geminiOutputText = gemini_output_text
chatCompletionsOutputText = chat_completions_output_text
tokenUsageFromOpenAi = token_usage_from_openai
tokenUsageFromGemini = token_usage_from_gemini
tokenUsageFromChatCompletions = token_usage_from_chat_completions
parseJsonObjectText = parse_json_object_text
extractJsonObjectText = extract_json_object_text
resolveGenerationRequest = resolve_generation_request
