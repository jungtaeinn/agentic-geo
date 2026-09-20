"""Azure deployment-scoped chat-completions provider compatibility adapter."""

from __future__ import annotations

import json
import math
from collections.abc import Awaitable, Callable, Mapping
from typing import Any, cast

import httpx
from neo_js_compat import js_json_bytes

from .._json_types import as_list, as_mapping
from ..ocr.layout import parse_image_ocr_payload_text
from ..ocr.prompt import create_image_ocr_prompt, create_keyword_classification_prompt_parts
from ..schemas import (
    CHAT_COMPLETIONS_IMAGE_OCR_RESPONSE_FORMAT,
    CHAT_COMPLETIONS_KEYWORD_CLASSIFICATION_RESPONSE_FORMAT,
)
from .shared import data_url
from .transport import (
    DEFAULT_MODEL_TIMEOUT_SECONDS,
    is_unsupported_structured_output_error,
    model_timeout_seconds,
    resolve_image_inputs,
    response_json_object,
    temperature_body,
    timeout_label_seconds,
)

ImageFetcher = Callable[[str], Awaitable[tuple[str, bytes]]]


class AzureOpenAIProvider:
    """Deployment-addressed Azure chat/OCR adapter with legacy retries."""

    def __init__(
        self,
        *,
        api_key: object,
        endpoint: object,
        deployment: object | None = None,
        deployments: Mapping[str, object] | None = None,
        api_version: object | None = None,
        temperature: object = None,
        transport: object = None,
        image_fetcher: object = None,
        timeout_seconds: object = DEFAULT_MODEL_TIMEOUT_SECONDS,
    ) -> None:
        # Do not validate or normalize these injected values at construction
        # time. The factory historically passed application adapters through
        # untouched; request construction is the first meaningful boundary.
        self.api_key = api_key
        self.endpoint = endpoint
        self.deployment = deployment
        self.deployments = dict(deployments or {})
        self.api_version = api_version
        self.temperature = temperature
        self.transport = transport
        self.image_fetcher = image_fetcher
        self.timeout_seconds = model_timeout_seconds(timeout_seconds)

    def chat_completions_url(self, deployment: object) -> str:
        version = self.api_version if self.api_version is not None else "2025-04-01-preview"
        # Base Azure preserves the legacy direct interpolation contract.  AI
        # Studio intentionally has separate trimming/component-encoding rules.
        endpoint = _text(self.endpoint).removesuffix("/")
        return f"{endpoint}/openai/deployments/{deployment}/chat/completions?api-version={version}"

    def auth_headers(self) -> dict[str, str]:
        return {"api-key": _text(self.api_key)}

    async def classify_keywords(self, request: Mapping[str, Any]) -> dict[str, Any]:
        deployment = _nullish(self.deployments.get("reasoning"), self.deployment)
        self._require(deployment, "reasoning")
        prompt = create_keyword_classification_prompt_parts(request)
        payload = await self._request_chat_completions_json(
            self.chat_completions_url(deployment),
            {
                "messages": [
                    {"role": "system", "content": prompt["system"]},
                    {"role": "user", "content": prompt["user"]},
                ],
                "response_format": CHAT_COMPLETIONS_KEYWORD_CLASSIFICATION_RESPONSE_FORMAT,
                **temperature_body(self.temperature),
            },
            "Azure keyword classification",
        )
        raw_text = _chat_content(payload)
        result = _parse_keyword_payload(raw_text)
        usage = _token_usage(as_mapping(payload.get("usage")))
        if usage is not None:
            result["usage"] = usage
        return result

    async def classifyKeywords(self, request: Mapping[str, Any]) -> dict[str, Any]:
        return await self.classify_keywords(request)

    async def extract_image_text(self, request: Mapping[str, Any]) -> dict[str, Any]:
        deployment = _nullish(self.deployments.get("ocr"), self.deployment)
        self._require(deployment, "OCR", image=True)
        inputs = resolve_image_inputs(request)
        try:
            direct = await self._request_image_ocr(request, inputs, deployment)
            missing = [item for item in inputs if item["displayUrl"] not in _extracted_urls(direct)]
            if not missing:
                return direct
            fallback = await self._downloaded_fallback(
                {**dict(request), "imageUrls": [item["displayUrl"] for item in missing], "imageInputs": missing},
                deployment,
                RuntimeError(f"{len(missing)} remote image OCR result(s) returned no readable text."),
            )
            return _merge_image_responses(direct, fallback) if _has_image_text(fallback) else direct
        except Exception as direct_error:
            fallback = await self._downloaded_fallback(request, deployment, direct_error)
            if _has_image_text(fallback):
                return fallback
            raise

    async def extractImageTexts(self, request: Mapping[str, Any]) -> dict[str, Any]:
        return await self.extract_image_text(request)

    async def _request_image_ocr(
        self, request: Mapping[str, Any], inputs: list[dict[str, str]], deployment: object
    ) -> dict[str, Any]:
        content: list[dict[str, Any]] = [
            {
                "type": "text",
                "text": create_image_ocr_prompt({**dict(request), "imageUrls": [item["displayUrl"] for item in inputs]}),
            }
        ]
        for index, item in enumerate(inputs, start=1):
            content.extend(
                [
                    {"type": "text", "text": f"Image {index}: {item['displayUrl']}"},
                    {"type": "image_url", "image_url": {"url": item["inputUrl"], "detail": "high"}},
                ]
            )
        payload = await self._request_chat_completions_json(
            self.chat_completions_url(deployment),
            {
                "messages": [{"role": "user", "content": content}],
                "response_format": CHAT_COMPLETIONS_IMAGE_OCR_RESPONSE_FORMAT,
                **temperature_body(self.temperature),
            },
            "Azure image OCR",
        )
        raw_text = _chat_content(payload)
        result = parse_image_ocr_payload_text(raw_text, [item["displayUrl"] for item in inputs])
        usage = _token_usage(as_mapping(payload.get("usage")))
        if usage is not None:
            result["usage"] = usage
        return result

    async def _downloaded_fallback(
        self, request: Mapping[str, Any], deployment: object, direct_error: BaseException
    ) -> dict[str, Any]:
        images: list[dict[str, Any]] = []
        errors: list[str] = []
        usages: list[Mapping[str, Any]] = []
        for input_ in resolve_image_inputs(request):
            try:
                input_url = input_["inputUrl"]
                data_input = input_url if input_url.startswith("data:") else await self._download_image_as_data_url(input_url)
                extracted = await self._request_image_ocr(
                    request, [{"displayUrl": input_["displayUrl"], "inputUrl": data_input}], deployment
                )
                images.extend(_image_rows(extracted))
                usage = as_mapping(extracted.get("usage"))
                if usage is not None:
                    usages.append(usage)
            except Exception as error:
                errors.append(str(error))
        result: dict[str, Any] = {
            "images": images,
            "rawText": "\n".join([str(direct_error), *errors]),
        }
        merged_usage = _merge_usages(usages)
        if merged_usage is not None:
            result["usage"] = merged_usage
        return result

    async def _request_chat_completions_json(
        self, url: str, body: Mapping[str, Any], label: str
    ) -> Mapping[str, Any]:
        current = dict(body)
        response = await self._post(url, current, label)
        if not response.is_success:
            suffix = _response_error_suffix(response)
            if "response_format" in current and is_unsupported_structured_output_error(suffix):
                current.pop("response_format", None)
                response = await self._post(url, current, label)
            elif "temperature" in current and _unsupported_temperature(suffix):
                current.pop("temperature", None)
                response = await self._post(url, current, label)
            else:
                raise RuntimeError(f"{label} failed: {response.status_code}{suffix}")
        if not response.is_success:
            suffix = _response_error_suffix(response)
            if "temperature" in current and _unsupported_temperature(suffix):
                retry = dict(current)
                retry.pop("temperature", None)
                response = await self._post(url, retry, label)
                if response.is_success:
                    return response_json_object(response, label)
                raise RuntimeError(f"{label} failed: {response.status_code}{_response_error_suffix(response)}")
            raise RuntimeError(f"{label} failed: {response.status_code}{suffix}")
        return response_json_object(response, label)

    async def _post(self, url: str, body: Mapping[str, Any], label: str) -> httpx.Response:
        headers = {"Content-Type": "application/json", **self.auth_headers()}
        async with httpx.AsyncClient(
            transport=cast(httpx.AsyncBaseTransport | None, self.transport),
            timeout=self.timeout_seconds,
            follow_redirects=True,
        ) as client:
            try:
                return await client.post(url, headers=headers, content=js_json_bytes(body))
            except httpx.TimeoutException as error:
                raise RuntimeError(f"{label} timed out after {timeout_label_seconds(self.timeout_seconds)}s.") from error

    async def _download_image_as_data_url(self, image_url: str) -> str:
        if callable(self.image_fetcher):
            fetched = cast(ImageFetcher, self.image_fetcher)(image_url)
            mime_type, content = await fetched
            return data_url(mime_type, content)
        async with httpx.AsyncClient(
            transport=cast(httpx.AsyncBaseTransport | None, self.transport), timeout=60.0, follow_redirects=True
        ) as client:
            try:
                response = await client.get(
                    image_url,
                    headers={
                        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
                        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
                    },
                )
            except httpx.TimeoutException as error:
                raise RuntimeError("Image download for OCR timed out after 60s.") from error
        if not response.is_success:
            raise RuntimeError(f"Image download failed: {response.status_code}{_response_error_suffix(response)}")
        mime_type = response.headers.get("content-type", "image/jpeg").split(";", 1)[0].strip() or "image/jpeg"
        if not mime_type.startswith("image/"):
            raise RuntimeError(f"Image download returned non-image content-type: {mime_type}")
        if len(response.content) > 10 * 1024 * 1024:
            raise RuntimeError(f"Image is too large for OCR fallback: {len(response.content)} bytes")
        return data_url(mime_type, response.content)

    def _require(self, deployment: object, role: str, *, image: bool = False) -> None:
        if not self.api_key or not self.endpoint or not deployment:
            suffix = " are required for image OCR." if image else " are required."
            article = "an" if role == "OCR" else "a"
            raise ValueError(f"API key, endpoint, and {article} {role} deployment/model id{suffix}")


def _parse_keyword_payload(raw_text: str) -> dict[str, Any]:
    json_text = _extract_json_object_text(raw_text)
    if json_text is None:
        return {"keywords": [], "summary": "No parseable JSON returned.", "rawText": raw_text}
    parsed = json.loads(json_text)
    return dict(as_mapping(parsed) or {})


def _extract_json_object_text(raw_text: str) -> str | None:
    text = raw_text.strip()
    if text.startswith("{") and text.endswith("}"):
        return text
    fenced = re_search_fenced_json(text)
    if fenced is not None and fenced.startswith("{"):
        return fenced
    match = __import__("re").search(r"\{[\s\S]*\}", text)
    return match.group(0) if match is not None else None


def re_search_fenced_json(text: str) -> str | None:
    match = __import__("re").search(r"```(?:json)?\s*([\s\S]*?)\s*```", text, __import__("re").IGNORECASE)
    return match.group(1).strip() if match is not None else None


def _chat_content(payload: Mapping[str, Any]) -> str:
    choices = as_list(payload.get("choices")) or []
    first = as_mapping(choices[0]) if choices else None
    message = as_mapping(first.get("message")) if first is not None else None
    content = message.get("content") if message is not None else ""
    return content if isinstance(content, str) else ""


def _token_usage(value: Mapping[str, Any] | None) -> dict[str, int | float] | None:
    if value is None:
        return None
    input_tokens = _number_field(value.get("prompt_tokens"))
    if input_tokens is None:
        input_tokens = _number_field(value.get("input_tokens"))
    output_tokens = _number_field(value.get("completion_tokens"))
    if output_tokens is None:
        output_tokens = _number_field(value.get("output_tokens"))
    total_tokens = _number_field(value.get("total_tokens"))
    if total_tokens is None and (input_tokens is not None or output_tokens is not None):
        total_tokens = (input_tokens or 0) + (output_tokens or 0)
    result: dict[str, int | float] = {}
    if input_tokens is not None:
        result["inputTokens"] = input_tokens
    if output_tokens is not None:
        result["outputTokens"] = output_tokens
    if total_tokens is not None:
        result["totalTokens"] = total_tokens
    return result or None


def _number_field(value: object) -> int | float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return value


def _image_rows(result: Mapping[str, Any]) -> list[dict[str, Any]]:
    return [dict(item) for raw in as_list(result.get("images")) or [] if (item := as_mapping(raw)) is not None]


def _extracted_urls(result: Mapping[str, Any]) -> set[str]:
    return {
        str(item.get("imageUrl"))
        for item in _image_rows(result)
        if isinstance(item.get("text"), str) and item["text"].strip()
    }


def _has_image_text(result: Mapping[str, Any]) -> bool:
    return any(isinstance(item.get("text"), str) and item["text"].strip() for item in _image_rows(result))


def _merge_image_responses(primary: Mapping[str, Any], fallback: Mapping[str, Any]) -> dict[str, Any]:
    seen: set[str] = set()
    images: list[dict[str, Any]] = []
    for item in [*_image_rows(primary), *_image_rows(fallback)]:
        image_url, text = item.get("imageUrl"), item.get("text")
        if isinstance(image_url, str) and isinstance(text, str) and text.strip() and image_url not in seen:
            seen.add(image_url)
            images.append(item)
    result: dict[str, Any] = {
        "images": images,
        "rawText": "\n".join(
            value for value in (primary.get("rawText"), fallback.get("rawText")) if isinstance(value, str) and value
        ),
    }
    usage = _merge_usages([usage for candidate in (primary, fallback) if (usage := as_mapping(candidate.get("usage"))) is not None])
    if usage is not None:
        result["usage"] = usage
    return result


def _merge_usages(usages: list[Mapping[str, Any]]) -> dict[str, int | float] | None:
    totals: dict[str, int | float] = {}
    for usage in usages:
        for key in ("inputTokens", "outputTokens", "totalTokens"):
            number = _number_field(usage.get(key))
            if number is not None:
                totals[key] = totals.get(key, 0) + number
    return totals or None


def _response_error_suffix(response: httpx.Response) -> str:
    cleaned = " ".join(response.text.split())
    return f" - {cleaned[:500]}" if cleaned else ""


def _unsupported_temperature(message: str) -> bool:
    lowered = message.casefold()
    return "temperature" in lowered and ("unsupported" in lowered or "only the default" in lowered)


def _nullish(value: object | None, fallback: object | None) -> object | None:
    return fallback if value is None else value


def _text(value: object) -> str:
    return value if isinstance(value, str) else str(value or "")


AzureApiKeywordClassifier = AzureOpenAIProvider
