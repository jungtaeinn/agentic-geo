"""OpenAI Responses API provider compatibility adapter."""

from __future__ import annotations

import base64
import json
import math
import re
from collections.abc import Awaitable, Callable, Mapping
from typing import Any, cast

import httpx
from neo_js_compat import js_json_bytes

from .._json_types import as_list, as_mapping
from ..ocr.layout import parse_image_ocr_payload_text
from ..ocr.prompt import create_image_ocr_prompt, create_keyword_classification_prompt_parts
from ..schemas import OPENAI_IMAGE_OCR_TEXT_FORMAT, OPENAI_KEYWORD_CLASSIFICATION_TEXT_FORMAT
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


class OpenAIProvider:
    """Responses API adapter for OCR keyword classification and vision OCR."""

    def __init__(
        self,
        *,
        api_key: object,
        model: object,
        temperature: object = None,
        transport: object = None,
        image_fetcher: object = None,
        timeout_seconds: object = DEFAULT_MODEL_TIMEOUT_SECONDS,
    ) -> None:
        self.api_key = api_key
        self.model = model
        self.temperature = temperature
        self.transport = transport
        self.image_fetcher = image_fetcher
        self.timeout_seconds = model_timeout_seconds(timeout_seconds)

    async def classify_keywords(self, request: Mapping[str, Any]) -> dict[str, Any]:
        self._require("keyword classifier")
        prompt = create_keyword_classification_prompt_parts(request)
        payload = await self._request_responses_json(
            {
                "model": _text(self.model),
                "instructions": prompt["system"],
                "input": prompt["user"],
                **temperature_body(self.temperature),
                "text": OPENAI_KEYWORD_CLASSIFICATION_TEXT_FORMAT,
            },
            "OpenAI keyword classification",
        )
        result = _parse_keyword_payload(_responses_output_text(payload))
        usage = _token_usage(as_mapping(payload.get("usage")))
        if usage is not None:
            result["usage"] = usage
        return result

    async def classifyKeywords(self, request: Mapping[str, Any]) -> dict[str, Any]:
        return await self.classify_keywords(request)

    async def extract_image_text(self, request: Mapping[str, Any]) -> dict[str, Any]:
        self._require("image OCR")
        inputs = resolve_image_inputs(request)
        try:
            direct = await self._request_image_ocr(request, inputs)
            missing = [item for item in inputs if item["displayUrl"] not in _extracted_urls(direct)]
            if not missing:
                return direct
            fallback = await self._downloaded_fallback(
                {**dict(request), "imageUrls": [item["displayUrl"] for item in missing], "imageInputs": missing},
                RuntimeError(f"{len(missing)} remote image OCR result(s) returned no readable text."),
            )
            return _merge_image_responses(direct, fallback) if _has_image_text(fallback) else direct
        except Exception as direct_error:
            if _is_quota_or_billing_error(str(direct_error)):
                raise
            fallback = await self._downloaded_fallback(request, direct_error)
            if _has_image_text(fallback):
                return fallback
            raise

    async def extractImageTexts(self, request: Mapping[str, Any]) -> dict[str, Any]:
        return await self.extract_image_text(request)

    async def _request_image_ocr(self, request: Mapping[str, Any], inputs: list[dict[str, str]]) -> dict[str, Any]:
        content: list[dict[str, Any]] = [
            {
                "type": "input_text",
                "text": create_image_ocr_prompt({**dict(request), "imageUrls": [item["displayUrl"] for item in inputs]}),
            }
        ]
        for index, item in enumerate(inputs, start=1):
            content.extend(
                [
                    {"type": "input_text", "text": f"Image {index}: {item['displayUrl']}"},
                    {"type": "input_image", "image_url": item["inputUrl"], "detail": "high"},
                ]
            )
        payload = await self._request_responses_json(
            {
                "model": _text(self.model),
                "input": [{"role": "user", "content": content}],
                **temperature_body(self.temperature),
                "text": OPENAI_IMAGE_OCR_TEXT_FORMAT,
            },
            "OpenAI image OCR",
        )
        result = parse_image_ocr_payload_text(_responses_output_text(payload), [item["displayUrl"] for item in inputs])
        usage = _token_usage(as_mapping(payload.get("usage")))
        if usage is not None:
            result["usage"] = usage
        return result

    async def _downloaded_fallback(self, request: Mapping[str, Any], direct_error: BaseException) -> dict[str, Any]:
        images: list[dict[str, Any]] = []
        errors: list[str] = []
        usages: list[Mapping[str, Any]] = []
        for input_ in resolve_image_inputs(request):
            try:
                data_input = input_["inputUrl"] if input_["inputUrl"].startswith("data:") else await self._download_image_as_data_url(input_["inputUrl"])
                extracted = await self._request_image_ocr(
                    request, [{"displayUrl": input_["displayUrl"], "inputUrl": data_input}]
                )
                images.extend(_image_rows(extracted))
                usage = as_mapping(extracted.get("usage"))
                if usage is not None:
                    usages.append(usage)
                if not _has_image_text(extracted):
                    raw_text = extracted.get("rawText")
                    errors.append(
                        f"Inline image OCR returned no readable text: {str(raw_text)[:240]}"
                        if isinstance(raw_text, str) and raw_text
                        else "Inline image OCR returned no readable text."
                    )
            except Exception as error:
                if _is_quota_or_billing_error(str(error)):
                    raise
                errors.append(str(error))
        result: dict[str, Any] = {"images": images, "rawText": "\n".join([str(direct_error), *errors])}
        usage = _merge_usages(usages)
        if usage is not None:
            result["usage"] = usage
        return result

    async def _request_responses_json(self, body: Mapping[str, Any], label: str) -> Mapping[str, Any]:
        current = dict(body)
        response = await self._post(current, label)
        if not response.is_success:
            suffix = _response_error_suffix(response)
            if "text" in current and is_unsupported_structured_output_error(suffix):
                current.pop("text", None)
                response = await self._post(current, label)
            elif "temperature" in current and _unsupported_temperature(suffix):
                current.pop("temperature", None)
                response = await self._post(current, label)
            else:
                raise RuntimeError(f"{label} failed: {response.status_code}{suffix}")
        if not response.is_success:
            suffix = _response_error_suffix(response)
            raise RuntimeError(f"{label} failed: {response.status_code}{suffix}")
        return response_json_object(response, label)

    async def _post(self, body: Mapping[str, Any], label: str) -> httpx.Response:
        try:
            async with httpx.AsyncClient(
                transport=cast(httpx.AsyncBaseTransport | None, self.transport),
                timeout=self.timeout_seconds,
                follow_redirects=True,
            ) as client:
                return await client.post(
                    "https://api.openai.com/v1/responses",
                    headers={"Authorization": f"Bearer {_text(self.api_key)}", "Content-Type": "application/json"},
                    content=js_json_bytes(body),
                )
        except httpx.TimeoutException as error:
            raise RuntimeError(f"{label} timed out after {timeout_label_seconds(self.timeout_seconds)}s.") from error

    async def _download_image_as_data_url(self, image_url: str) -> str:
        if callable(self.image_fetcher):
            mime_type, content = await cast(ImageFetcher, self.image_fetcher)(image_url)
            return _data_url(mime_type, content)
        try:
            async with httpx.AsyncClient(
                transport=cast(httpx.AsyncBaseTransport | None, self.transport), timeout=60.0, follow_redirects=True
            ) as client:
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
        return _data_url(mime_type, response.content)

    def _require(self, label: str) -> None:
        if not self.api_key:
            raise ValueError(
                "OPENAI_API_KEY is required for OpenAI image OCR."
                if label == "image OCR"
                else "OPENAI_API_KEY is required for the OpenAI keyword classifier."
            )
        if not self.model:
            raise ValueError(
                "OPENAI_MODEL is required for OpenAI image OCR."
                if label == "image OCR"
                else "OPENAI_MODEL is required for the OpenAI keyword classifier."
            )


def _responses_output_text(payload: Mapping[str, Any]) -> str:
    output_text = payload.get("output_text")
    if isinstance(output_text, str):
        return output_text
    parts: list[str] = []
    for raw in as_list(payload.get("output")) or []:
        item = as_mapping(raw)
        contents = as_list(item.get("content")) if item is not None else None
        for raw_content in contents or []:
            content = as_mapping(raw_content)
            text = content.get("text") if content is not None else None
            if isinstance(text, str):
                parts.append(text)
    return "\n".join(parts)


def _parse_keyword_payload(raw_text: str) -> dict[str, Any]:
    json_text = _extract_json_object_text(raw_text)
    if json_text is None:
        return {"keywords": [], "summary": "No parseable JSON returned.", "rawText": raw_text}
    # A braced candidate is an attempted structured response.  The retained
    # adapter lets JSON.parse fail here; only prose/no-object output receives
    # the tolerant empty envelope above.
    return dict(as_mapping(json.loads(json_text)) or {})


def _extract_json_object_text(raw_text: str) -> str | None:
    text = raw_text.strip()
    if text.startswith("{") and text.endswith("}"):
        return text
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", text, re.IGNORECASE)
    if fenced is not None and fenced.group(1).strip().startswith("{"):
        return fenced.group(1).strip()
    match = re.search(r"\{[\s\S]*\}", text)
    return match.group(0) if match is not None else None


def _token_usage(value: Mapping[str, Any] | None) -> dict[str, int | float] | None:
    if value is None:
        return None
    input_tokens = _number_field(value.get("input_tokens"))
    if input_tokens is None:
        input_tokens = _number_field(value.get("prompt_tokens"))
    output_tokens = _number_field(value.get("output_tokens"))
    if output_tokens is None:
        output_tokens = _number_field(value.get("completion_tokens"))
    total_tokens = _number_field(value.get("total_tokens"))
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


def _data_url(mime_type: str, content: bytes) -> str:
    return f"data:{mime_type};base64,{base64.b64encode(content).decode('ascii')}"


def _response_error_suffix(response: httpx.Response) -> str:
    cleaned = " ".join(response.text.split())
    return f" - {cleaned[:500]}" if cleaned else ""


def _unsupported_temperature(message: str) -> bool:
    return re.search(r"unsupported value[\s\S]*temperature|temperature[\s\S]*(?:unsupported|only the default)", message, re.IGNORECASE) is not None


def _is_quota_or_billing_error(message: str) -> bool:
    return re.search(
        r"exceeded your current quota|insufficient_quota|billing|check your plan|rate limit|too many requests",
        message,
        re.IGNORECASE,
    ) is not None


def _text(value: object) -> str:
    return value if isinstance(value, str) else str(value or "")


OpenAIKeywordClassifier = OpenAIProvider
