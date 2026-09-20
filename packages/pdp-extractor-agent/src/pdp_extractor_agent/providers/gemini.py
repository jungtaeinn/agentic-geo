"""Gemini GenerateContent provider compatibility adapter."""

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
from ..schemas import GEMINI_IMAGE_OCR_RESPONSE_SCHEMA, GEMINI_KEYWORD_CLASSIFICATION_RESPONSE_SCHEMA
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


class GeminiProvider:
    """Google GenerateContent OCR/classification adapter with schema fallback."""

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
        payload = await self._request_generate_content(
            {
                "systemInstruction": {"parts": [{"text": prompt["system"]}]},
                "contents": [{"role": "user", "parts": [{"text": prompt["user"]}]}],
                "generationConfig": _generation_config(GEMINI_KEYWORD_CLASSIFICATION_RESPONSE_SCHEMA, self.temperature),
            },
            "Gemini keyword classification",
        )
        raw_text = _gemini_output_text(payload)
        result = _parse_keyword_payload(raw_text)
        usage = _token_usage(as_mapping(payload.get("usageMetadata")))
        if usage is not None:
            result["usage"] = usage
        return result

    async def classifyKeywords(self, request: Mapping[str, Any]) -> dict[str, Any]:
        return await self.classify_keywords(request)

    async def extract_image_text(self, request: Mapping[str, Any]) -> dict[str, Any]:
        self._require("image OCR")
        inline_images: list[dict[str, str]] = []
        errors: list[str] = []
        for input_ in resolve_image_inputs(request):
            try:
                parsed = _parse_data_url(input_["inputUrl"])
                if parsed is None:
                    mime_type, encoded = await self._download_image_as_base64(input_["inputUrl"])
                else:
                    mime_type, encoded = parsed
                inline_images.append({"imageUrl": input_["displayUrl"], "mimeType": mime_type, "base64": encoded})
            except Exception as error:
                errors.append(str(error))
        if not inline_images:
            detail = " | ".join(errors[:2]) or "no images"
            raise RuntimeError(f"Gemini image OCR could not download any image: {detail}")
        display_urls = [image["imageUrl"] for image in inline_images]
        parts: list[dict[str, Any]] = [
            {"text": create_image_ocr_prompt({**dict(request), "imageUrls": display_urls})}
        ]
        for index, image in enumerate(inline_images, start=1):
            parts.extend(
                [
                    {"text": f"Image {index}: {image['imageUrl']}"},
                    {"inline_data": {"mime_type": image["mimeType"], "data": image["base64"]}},
                ]
            )
        payload = await self._request_generate_content(
            {
                "contents": [{"role": "user", "parts": parts}],
                "generationConfig": _generation_config(GEMINI_IMAGE_OCR_RESPONSE_SCHEMA, self.temperature),
            },
            "Gemini image OCR",
        )
        raw_text = _gemini_output_text(payload)
        result = parse_image_ocr_payload_text(raw_text, display_urls)
        if errors:
            result["rawText"] = "\n".join(value for value in [str(result.get("rawText") or ""), *errors] if value)
        usage = _token_usage(as_mapping(payload.get("usageMetadata")))
        if usage is not None:
            result["usage"] = usage
        return result

    async def extractImageTexts(self, request: Mapping[str, Any]) -> dict[str, Any]:
        return await self.extract_image_text(request)

    async def _request_generate_content(self, body: Mapping[str, Any], label: str) -> Mapping[str, Any]:
        current = dict(body)
        response = await self._post(current, label)
        if not response.is_success:
            suffix = _response_error_suffix(response)
            generation_config = as_mapping(current.get("generationConfig"))
            if generation_config is not None and "responseSchema" in generation_config and is_unsupported_structured_output_error(suffix):
                retry_config = dict(generation_config)
                retry_config.pop("responseSchema", None)
                current["generationConfig"] = retry_config
                response = await self._post(current, label)
            else:
                raise RuntimeError(f"{label} failed: {response.status_code}{suffix}")
        if not response.is_success:
            raise RuntimeError(f"{label} failed: {response.status_code}{_response_error_suffix(response)}")
        return response_json_object(response, label)

    async def _post(self, body: Mapping[str, Any], label: str) -> httpx.Response:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{_text(self.model)}:generateContent"
        async with httpx.AsyncClient(
            transport=cast(httpx.AsyncBaseTransport | None, self.transport),
            timeout=self.timeout_seconds,
            follow_redirects=True,
        ) as client:
            try:
                return await client.post(
                    url,
                    headers={"Content-Type": "application/json", "x-goog-api-key": _text(self.api_key)},
                    content=js_json_bytes(body),
                )
            except httpx.TimeoutException as error:
                raise RuntimeError(f"{label} timed out after {timeout_label_seconds(self.timeout_seconds)}s.") from error

    async def _download_image_as_base64(self, image_url: str) -> tuple[str, str]:
        if callable(self.image_fetcher):
            mime_type, content = await cast(ImageFetcher, self.image_fetcher)(image_url)
            return mime_type, base64.b64encode(content).decode("ascii")
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
        return mime_type, base64.b64encode(response.content).decode("ascii")

    def _require(self, label: str) -> None:
        if not self.api_key:
            raise ValueError(
                "GEMINI_API_KEY is required for Gemini image OCR."
                if label == "image OCR"
                else "GEMINI_API_KEY is required for the Gemini keyword classifier."
            )
        if not self.model:
            raise ValueError(
                "GEMINI_MODEL is required for Gemini image OCR."
                if label == "image OCR"
                else "GEMINI_MODEL is required for the Gemini keyword classifier."
            )


def _generation_config(schema: Mapping[str, Any], temperature: object) -> dict[str, Any]:
    return {"responseMimeType": "application/json", "responseSchema": dict(schema), **temperature_body(temperature)}


def _gemini_output_text(payload: Mapping[str, Any]) -> str:
    candidates = as_list(payload.get("candidates")) or []
    first_candidate = as_mapping(candidates[0]) if candidates else None
    content = as_mapping(first_candidate.get("content")) if first_candidate is not None else None
    return "\n".join(
        text
        for raw in (as_list(content.get("parts")) if content is not None else []) or []
        if (part := as_mapping(raw)) is not None and isinstance((text := part.get("text")), str)
    )


def _parse_keyword_payload(raw_text: str) -> dict[str, Any]:
    json_text = _extract_json_object_text(raw_text)
    if json_text is None:
        return {"keywords": [], "summary": "No parseable JSON returned.", "rawText": raw_text}
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


def _parse_data_url(value: str) -> tuple[str, str] | None:
    match = re.fullmatch(r"data:([^;,]+);base64,(.+)", value, re.DOTALL)
    return (match.group(1), match.group(2)) if match is not None else None


def _token_usage(value: Mapping[str, Any] | None) -> dict[str, int | float] | None:
    if value is None:
        return None
    input_tokens = _number_field(value.get("promptTokenCount"))
    output_tokens = _number_field(value.get("candidatesTokenCount"))
    total_tokens = _number_field(value.get("totalTokenCount"))
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


def _response_error_suffix(response: httpx.Response) -> str:
    cleaned = " ".join(response.text.split())
    return f" - {cleaned[:500]}" if cleaned else ""


def _text(value: object) -> str:
    return value if isinstance(value, str) else str(value or "")


GeminiKeywordClassifier = GeminiProvider
