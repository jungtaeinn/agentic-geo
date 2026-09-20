"""Framework-neutral REST compatibility adapter for the PDP extractor."""

from __future__ import annotations

import asyncio
import inspect
import json
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlsplit

from ._json_types import as_list, as_mapping
from .models import ProductExtractionRun
from .rag.manifest import PRODUCT_EXTRACTOR_RAG_MANIFEST

SourceExtractor = Callable[..., Awaitable[dict[str, Any]] | dict[str, Any] | ProductExtractionRun]

_CONTENT_TYPE = "application/json; charset=utf-8"
_HEADER_VALIDATION_ERROR = "_restHeaderValidationError"
_STAGE_COPY: tuple[tuple[str, str, str], ...] = (
    ("input", "입력 정규화", "URL/REST API 주소를 검증하고 실행 단위를 분리"),
    ("fetch", "소스 수집", "페이지 HTML, 메타정보, JSON-LD, API 응답 수집"),
    ("extract", "상품정보 추출", "상품명, 가격, 설명, 옵션, FAQ 후보 정규화"),
    ("ocr", "OCR 문장/키워드 분석", "이미지/상세 영역의 효능, 효과, 성분 문장과 키워드 분류"),
    ("review", "리뷰 신호 추출", "평점, 리뷰본문, 대표 키워드, 고객 표현 정리"),
    ("rag", "RAG chunk 생성", "상품/리뷰/FAQ/OCR evidence를 RAG 데이터로 구성"),
    ("json", "JSON 결과 생성", "복사 가능한 최종 JSON 아티팩트 생성"),
)


class ExtractorRequestConfigurationError(ValueError):
    """A request changed an endpoint while retaining a server-managed key."""


@dataclass(frozen=True)
class ProductExtractorRestResponse:
    """Small framework-neutral response for HTTP integration layers."""

    payload: dict[str, Any]
    status: int
    headers: dict[str, str]

    @property
    def content_type(self) -> str:
        return self.headers["Content-Type"]


class ProductExtractorRestHandler:
    def __init__(self, config: Mapping[str, Any] | None = None, *, extract_one: SourceExtractor | None = None) -> None:
        self.config = dict(config or {})
        self.extract_one = extract_one or _default_extract_one

    async def __call__(self, method: str, body: object) -> ProductExtractorRestResponse:
        if method != "POST":
            return _response({"error": "Method not allowed. Use POST."}, 405)
        try:
            payload = _body_mapping(body)
            sources = _sources(payload)
            if not sources:
                return _response({"error": "At least one source is required."}, 400)
            source_type = _source_type(payload, self.config)
            runtime = _runtime_config(self.config, payload)
            _apply_request_headers(runtime, payload)
            result, status = await _run_sources(sources, source_type, runtime, self.extract_one)
            return _response(result, status)
        except ExtractorRequestConfigurationError as error:
            return _response({"error": str(error)}, 400)
        except Exception as error:  # exact TS boundary: malformed request/setup is a 500 envelope
            return _response({"error": str(error) or "Product extraction failed."}, 500)


def create_product_extractor_rest_handler(
    config: Mapping[str, Any] | None = None,
    *,
    extract_one: SourceExtractor | None = None,
) -> ProductExtractorRestHandler:
    """Create a transport-agnostic POST handler matching the TypeScript route."""

    return ProductExtractorRestHandler(config, extract_one=extract_one)


# Camel-case alias intentionally mirrors the TypeScript package's public API.
createProductExtractorRestHandler = create_product_extractor_rest_handler


async def extract_batch(
    payload: Mapping[str, Any],
    *,
    extract_one: SourceExtractor | None = None,
    config: Mapping[str, Any] | None = None,
) -> tuple[dict[str, Any], int]:
    """Run a batch without binding it to an HTTP framework."""

    settings = dict(config or {})
    sources = _sources(payload)
    if not sources:
        return {"error": "At least one source is required."}, 400
    runtime = _runtime_config(settings, payload)
    _apply_request_headers(runtime, payload)
    return await _run_sources(sources, _source_type(payload, settings), runtime, extract_one or _default_extract_one)


async def _run_sources(
    sources: list[Any], source_type: str, runtime: Mapping[str, Any], runner: SourceExtractor
) -> tuple[dict[str, Any], int]:
    outcomes = await asyncio.gather(*[_run_one(source, source_type, runtime, runner) for source in sources])
    successes = [outcome for outcome in outcomes if outcome["kind"] == "success"]
    failures = [outcome for outcome in outcomes if outcome["kind"] == "failure"]
    # The legacy handler explicitly emits all successful logs first, followed
    # by failure logs, even though extraction itself runs concurrently.
    results = [outcome["result"] for outcome in successes]
    logs = [outcome["diagnostics"] for outcome in successes] + [outcome["diagnostics"] for outcome in failures]
    failure_rows = [outcome["failure"] for outcome in failures]
    return {"results": results, "logs": logs, "failures": failure_rows}, 207 if failures else 200


async def _run_one(
    source: Any, source_type: str, runtime: Mapping[str, Any], runner: SourceExtractor
) -> dict[str, Any]:
    try:
        # Input-schema validation is intentionally evaluated for every source,
        # just like the TypeScript route's call to ``extractProduct``.  It is
        # therefore a 207 data failure rather than a route-level 500 and must
        # occur before any source fetch or custom runner invocation.
        if (header_error := runtime.get(_HEADER_VALIDATION_ERROR)) is not None:
            raise ValueError(str(header_error))
        value = runner(source, source_type, **runtime)
        value = await value if inspect.isawaitable(value) else value
        result = _result_mapping(value)
    except Exception as error:  # source-level failures are data, never route failures
        message = str(error) or "Product extraction failed."
        return {
            "kind": "failure",
            "failure": {"source": source, "sourceType": source_type, "error": message},
            "diagnostics": _failure_diagnostics(source, source_type, message),
        }
    diagnostics: dict[str, Any] | object = result.pop("diagnostics", None)
    if not isinstance(diagnostics, dict):
        diagnostics = {"source": source, "sourceType": source_type, "process": [], "evidence": [], "warnings": []}
    return {"kind": "success", "result": _omit_absent(result), "diagnostics": _omit_absent(diagnostics)}


async def _default_extract_one(source: Any, source_type: str, **options: Any) -> dict[str, Any]:
    from .service import extract_product

    input_: dict[str, Any] = {"source": source, "sourceType": source_type, "aiProvider": _provider_from_options(options)}
    headers = as_mapping(options.get("headers"))
    if headers is not None:
        input_["headers"] = {key: value for key, value in headers.items() if isinstance(value, str)}
    run = await extract_product(
        input_,
        options,
    )
    return {**run.result, "diagnostics": run.diagnostics}


def _body_mapping(body: object) -> Mapping[str, Any]:
    mapping = as_mapping(body)
    if mapping is not None:
        return mapping
    if isinstance(body, (str, bytes, bytearray)):
        parsed: object = json.loads(body)
        parsed_mapping = as_mapping(parsed)
        if parsed_mapping is not None:
            return parsed_mapping
    raise ValueError("Request body must be a JSON object.")


def _sources(payload: Mapping[str, Any]) -> list[Any]:
    raw = as_list(payload.get("sources"))
    # Retain JavaScript ``.filter(Boolean)`` exactly: malformed but truthy
    # entries become source-level schema failures (207), not a route 400.
    return [source for source in raw if _js_truthy(source)] if raw is not None else []


def _js_truthy(value: object) -> bool:
    """JavaScript truthiness at the REST JSON boundary.

    Empty Python containers are falsey but JSON arrays/objects are objects in
    JavaScript and survive ``filter(Boolean)`` for source-level validation.
    """

    if value is None or value is False:
        return False
    if isinstance(value, str):
        return bool(value)
    if isinstance(value, int | float) and not isinstance(value, bool):
        return value != 0 and value == value  # NaN is the sole non-reflexive number.
    return True


def _source_type(payload: Mapping[str, Any], config: Mapping[str, Any]) -> str:
    # Match JavaScript ``??``: an explicitly empty string is forwarded to the
    # input schema and becomes that source's 207 failure rather than URL mode.
    if "sourceType" in payload and payload["sourceType"] is not None:
        return str(payload["sourceType"])
    if "defaultSourceType" in config and config["defaultSourceType"] is not None:
        return str(config["defaultSourceType"])
    return "url"


def _apply_request_headers(runtime: dict[str, Any], payload: Mapping[str, Any]) -> None:
    """Validate request headers at the transport boundary without coercion.

    The prior port turned arbitrary JSON into strings (or quietly ignored
    non-mappings), bypassing Zod's ``record(string, string)`` input schema.
    Preserve the exact source-local failure shape by deferring the formatted
    schema error to ``_run_one`` for each requested source.
    """

    if "headers" not in payload:
        return
    raw_headers = payload.get("headers")
    headers = as_mapping(raw_headers)
    if headers is None:
        runtime[_HEADER_VALIDATION_ERROR] = _zod_invalid_type("record", _zod_type_name(raw_headers), ("headers",))
        return
    for key, value in headers.items():
        if not isinstance(value, str):
            runtime[_HEADER_VALIDATION_ERROR] = _zod_invalid_type(
                "string", _zod_type_name(value), ("headers", str(key))
            )
            return
    runtime["headers"] = dict(headers)


def _zod_invalid_type(expected: str, received: str, path: tuple[str, ...]) -> str:
    message = f"Invalid input: expected {expected}, received {received}"
    return json.dumps(
        [{"expected": expected, "code": "invalid_type", "path": list(path), "message": message}], indent=2
    )


def _zod_type_name(value: object) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int | float):
        return "number"
    if isinstance(value, str):
        return "string"
    if as_list(value) is not None:
        return "array"
    return "object"


def _runtime_config(config: Mapping[str, Any], payload: Mapping[str, Any]) -> dict[str, Any]:
    _assert_safe_request_endpoints(config, payload)
    runtime = dict(config)
    llm = as_mapping(payload.get("llm"))
    llm_mapping: dict[str, Any] = dict(llm) if llm is not None else {}
    runtime.update(llm_mapping)
    config_normalization = config.get("productNormalization")
    llm_normalization = llm_mapping.get("productNormalization")
    request_normalization = payload.get("productNormalization")
    normalization_values = [
        mapping
        for value in (config_normalization, llm_normalization, request_normalization)
        if (mapping := as_mapping(value)) is not None
    ]
    if normalization_values:
        merged: dict[str, Any] = {}
        for value in normalization_values:
            merged.update(value)
        runtime["productNormalization"] = merged
    rag = as_mapping(payload.get("rag"))
    if rag is not None:
        if "analysisPrompt" in rag and rag["analysisPrompt"] is not None:
            runtime["analysisPrompt"] = rag["analysisPrompt"]
        if "documents" in rag and rag["documents"] is not None:
            runtime["ragDocuments"] = rag["documents"]
        if "retrieval" in rag and rag["retrieval"] is not None:
            runtime["rag"] = rag["retrieval"]
    return {key: value for key, value in runtime.items() if value is not None}


def _assert_safe_request_endpoints(config: Mapping[str, Any], payload: Mapping[str, Any]) -> None:
    llm = as_mapping(payload.get("llm")) or {}
    _assert_endpoint_uses_server_credential(
        label="llm.endpoint",
        endpoint=llm.get("endpoint"),
        request_api_key=llm.get("apiKey"),
        configured_endpoint=config.get("endpoint"),
        server_api_key=config.get("apiKey"),
    )
    configured_stage = as_mapping(config.get("productNormalization")) or {}
    requested_stage = {
        **(as_mapping(llm.get("productNormalization")) or {}),
        **(as_mapping(payload.get("productNormalization")) or {}),
    }
    stage_endpoint = requested_stage.get("endpoint")
    if stage_endpoint is None and configured_stage.get("endpoint") is None:
        stage_endpoint = llm.get("endpoint")
    stage_request_key = requested_stage.get("apiKey")
    if stage_request_key is None and configured_stage.get("apiKey") is None:
        stage_request_key = llm.get("apiKey")
    _assert_endpoint_uses_server_credential(
        label="productNormalization.endpoint",
        endpoint=stage_endpoint,
        request_api_key=stage_request_key,
        configured_endpoint=_nullish(configured_stage.get("endpoint"), config.get("endpoint")),
        server_api_key=_nullish(configured_stage.get("apiKey"), config.get("apiKey")),
    )


def _assert_endpoint_uses_server_credential(
    *,
    label: str,
    endpoint: object,
    request_api_key: object,
    configured_endpoint: object,
    server_api_key: object,
) -> None:
    if not _js_truthy(endpoint) or _js_truthy(request_api_key) or not _js_truthy(server_api_key):
        return
    if configured_endpoint is not None and _endpoint_identity(configured_endpoint) == _endpoint_identity(endpoint):
        return
    raise ExtractorRequestConfigurationError(
        f"{label} cannot override the configured provider endpoint while using a server-managed API key. "
        "Supply the matching request API key or use the configured endpoint."
    )


def _endpoint_identity(value: object) -> str:
    raw = value if isinstance(value, str) else None
    if not raw:
        raise ExtractorRequestConfigurationError(f"Invalid provider endpoint URL: {value}")
    parsed = urlsplit(raw)
    if (
        not parsed.scheme
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise ExtractorRequestConfigurationError(f"Invalid provider endpoint URL: {raw}")
    pathname = parsed.path.rstrip("/") or "/"
    return f"{parsed.scheme.lower()}://{parsed.netloc.lower()}{pathname}"


def _nullish(value: object, fallback: object) -> object:
    return fallback if value is None else value


def _provider_from_options(options: Mapping[str, Any]) -> str:
    provider = options.get("provider")
    # JavaScript's ``??`` distinguishes an explicitly supplied empty provider
    # from an absent one.  The former must reach ProductExtractionInput and
    # become a per-source validation failure, not silently turn into mock.
    return str(provider) if provider is not None else "mock"


def _result_mapping(value: Any) -> dict[str, Any]:
    if isinstance(value, ProductExtractionRun):
        return {**value.result, "diagnostics": value.diagnostics}
    mapping = as_mapping(value)
    if mapping is not None:
        return dict(mapping)
    raise TypeError("extract_one must return a mapping or ProductExtractionRun")


def _failure_diagnostics(source: Any, source_type: str, error: str) -> dict[str, Any]:
    generated_at = datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    process: list[dict[str, Any]] = []
    for identifier, title, description in _STAGE_COPY:
        if identifier == "input":
            status, message = (
                "done",
                "REST API 입력으로 정규화했습니다."
                if source_type == "restApi"
                else "상품 URL 입력으로 정규화했습니다.",
            )
        elif identifier == "fetch":
            status, message = "error", error
        else:
            status, message = "pending", description
        step = {"id": identifier, "title": title, "description": description, "status": status, "message": message}
        if identifier in {"input", "fetch"}:
            step["startedAt"] = generated_at
            step["completedAt"] = generated_at
        process.append(step)
    return {
        "source": source,
        "sourceType": source_type,
        "process": process,
        "evidence": [],
        "warnings": [{"code": "SOURCE_COLLECTION_FAILED", "message": error}],
        "generatedAt": generated_at,
        "ragProfile": PRODUCT_EXTRACTOR_RAG_MANIFEST["profile"],
    }


def _response(payload: dict[str, Any], status: int) -> ProductExtractorRestResponse:
    return ProductExtractorRestResponse(payload=_omit_absent(payload), status=status, headers={"Content-Type": _CONTENT_TYPE})


def _omit_absent(value: Any) -> Any:
    mapping = as_mapping(value)
    if mapping is not None:
        return {key: _omit_absent(item) for key, item in mapping.items() if item is not None}
    items = as_list(value)
    if items is not None:
        return [_omit_absent(item) for item in items]
    return value
