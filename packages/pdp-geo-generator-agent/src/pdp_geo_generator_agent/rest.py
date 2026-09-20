"""Framework-neutral REST adapter for the PDP GEO generator."""

from __future__ import annotations

import asyncio
import inspect
import json
import re
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from typing import Any, cast

from ada_url import URL
from pydantic import ValidationError

from ._json import as_dict, as_list, omit_none
from .service import generate_pdp_geo


class RestRequestConfigurationError(ValueError):
    """A client attempted a provider/endpoint override without credentials."""


class RestRequestBodyError(ValueError):
    """A syntactically valid JSON request was not an object payload."""


class RestMalformedJsonError(RuntimeError):
    """Keep ``Request.json()`` parse failures on the TypeScript 500 path."""


async def _request_json(request: object) -> object:
    data: object
    if isinstance(request, Mapping):
        request_mapping = cast(Mapping[str, object], request)
        data = request_mapping.get("json", request_mapping.get("body", {}))
        if callable(data):
            data = cast(Callable[[], object], data)()
    else:
        data = getattr(request, "json", None)
        if callable(data):
            data = cast(Callable[[], object], data)()
    if inspect.isawaitable(data):
        data = await data
    if isinstance(data, str | bytes | bytearray):
        raw = data.decode("utf-8") if isinstance(data, bytes | bytearray) else data
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as error:
            raise RestMalformedJsonError(_javascript_json_parse_error(raw, error)) from error
    return data


def _javascript_json_parse_error(raw: str, error: json.JSONDecodeError) -> str:
    """Approximate the retained Node ``Request.json`` error wording.

    The status is the observable contract.  Mirroring the familiar token form
    keeps framework-neutral callers from receiving Python's line/column-only
    decoder wording for the common raw-body path.
    """

    offset = error.pos
    if raw.startswith("n") and raw[:4] != "null":
        # V8 has consumed the initial ``n`` while matching ``null``.
        offset = 1
    token = raw[offset] if offset < len(raw) else "end of JSON input"
    if token == "end of JSON input":
        return "Unexpected end of JSON input"
    preview = json.dumps(raw[:200], ensure_ascii=False)
    return f"Unexpected token '{token}', {preview} is not valid JSON"


def _method(request: object) -> str:
    if isinstance(request, Mapping):
        return str(cast(Mapping[str, object], request).get("method", "GET")).upper()
    return str(getattr(request, "method", "GET")).upper()


def _response(body: Mapping[str, Any], status: int) -> dict[str, Any]:
    # JavaScript omits ``undefined`` properties during JSON serialization.
    # Python's ``None`` is otherwise emitted as JSON ``null``, so remove only
    # absent values recursively at the framework-neutral response boundary.
    return {
        "status": status,
        "body": as_dict(omit_none(body)),
        "headers": {"content-type": "application/json; charset=utf-8"},
    }


def _safe_runtime(config: Mapping[str, Any], body: Mapping[str, Any]) -> dict[str, Any]:
    llm = as_dict(body.get("llm"))
    _assert_provider_credential_pair(
        "llm.provider",
        llm.get("provider"),
        llm.get("apiKey"),
        config.get("provider"),
        config.get("apiKey"),
    )
    _assert_endpoint_credential_pair(
        "llm.endpoint",
        llm.get("endpoint"),
        llm.get("apiKey"),
        config.get("endpoint"),
        config.get("apiKey"),
    )
    _assert_safe_stage_overrides(config, body, llm)
    _assert_safe_managed_search_endpoint(config, body, llm)
    result = {**config, **llm, "rag": {**as_dict(config.get("rag")), **as_dict(body.get("rag"))}}
    for key in (
        "productNormalization",
        "keywordNormalization",
        "contentPlanning",
        "copyRefinement",
    ):
        configured = as_dict(config.get(key))
        nested = as_dict(llm.get(key))
        top_level = as_dict(body.get(key))
        merged = _merge_provider_stage_settings(config, body, configured, nested, top_level)
        if merged is not None:
            result[key] = merged
    final = _merge_final_proofreading_settings(config, body)
    if final is not None:
        result["finalProofreading"] = final
    return result


def _nullish(value: object, fallback: object) -> object:
    """Port JavaScript ``??`` without treating valid empty wire values as absent."""

    return fallback if value is None else value


def _managed_rag_uses_openai(requested: Mapping[str, Any], configured: Mapping[str, Any]) -> bool:
    mode = _nullish(requested.get("mode"), configured.get("mode"))
    provider = _nullish(requested.get("provider"), configured.get("provider"))
    return mode == "managed-vector-store-rag" and _nullish(provider, "openai") == "openai"


def _configured_managed_search_endpoints(
    requested: Mapping[str, Any], configured: Mapping[str, Any]
) -> list[object]:
    endpoints: list[object] = []
    configured_endpoint = configured.get("managedSearchEndpoint")
    if configured_endpoint:
        endpoints.append(configured_endpoint)
    vector_store = _nullish(requested.get("vectorStoreId"), configured.get("vectorStoreId"))
    if vector_store:
        endpoints.append(f"https://api.openai.com/v1/vector_stores/{vector_store}/search")
    return endpoints


def _assert_safe_managed_search_endpoint(
    config: Mapping[str, Any], body: Mapping[str, Any], llm: Mapping[str, Any]
) -> None:
    requested = as_dict(body.get("rag"))
    endpoint = requested.get("managedSearchEndpoint")
    configured = as_dict(config.get("rag"))
    if not endpoint or not _managed_rag_uses_openai(requested, configured):
        return
    if llm.get("apiKey") or not config.get("apiKey"):
        return
    if any(_endpoint_identity(str(candidate)) == _endpoint_identity(str(endpoint)) for candidate in _configured_managed_search_endpoints(requested, configured)):
        return
    raise RestRequestConfigurationError(
        "rag.managedSearchEndpoint cannot override the configured/default managed RAG endpoint while using a "
        "server-managed API key. Supply the matching request API key or use the configured/default managed RAG endpoint."
    )


def _assert_safe_stage_overrides(config: Mapping[str, Any], body: Mapping[str, Any], llm: Mapping[str, Any]) -> None:
    """Keep scoped request credentials from being sent to another provider.

    This is the direct framework-neutral equivalent of the TypeScript REST
    preflight.  It must run before merge so an inherited configured key cannot
    survive a request provider or endpoint change.
    """

    for key in ("productNormalization", "keywordNormalization", "contentPlanning", "copyRefinement"):
        configured, requested = as_dict(config.get(key)), {**as_dict(llm.get(key)), **as_dict(body.get(key))}
        server_endpoint = _nullish(configured.get("endpoint"), config.get("endpoint"))
        server_key = _nullish(configured.get("apiKey"), config.get("apiKey"))
        request_key = _provider_stage_request_api_key(config, body, requested, configured)
        parent_provider = _nullish(llm.get("provider"), config.get("provider"))
        if (
            requested.get("provider")
            and llm.get("apiKey")
            and requested.get("provider") != parent_provider
            and not requested.get("apiKey")
        ):
            raise RestRequestConfigurationError(
                f"{key}.provider requires its own API key when it differs from llm.provider; llm.apiKey is scoped to the parent provider."
            )
        _assert_provider_credential_pair(
            f"{key}.provider",
            requested.get("provider"),
            request_key,
            _nullish(configured.get("provider"), config.get("provider")),
            server_key,
        )
        _assert_endpoint_credential_pair(
            f"{key}.endpoint", requested.get("endpoint"), request_key, server_endpoint, server_key
        )

    configured = as_dict(config.get("finalProofreading"))
    requested = {**as_dict(llm.get("finalProofreading")), **as_dict(body.get("finalProofreading"))}
    parent_provider = _nullish(llm.get("provider"), config.get("provider"))
    if (
        requested.get("provider")
        and llm.get("apiKey")
        and requested.get("provider") != parent_provider
        and not requested.get("apiKey")
    ):
        raise RestRequestConfigurationError(
            "finalProofreading.provider requires its own API key when it differs from llm.provider; llm.apiKey is scoped to the parent provider."
        )
    request_key = _final_proofreading_request_api_key(config, body, requested)
    _assert_provider_credential_pair(
        "finalProofreading.provider",
        requested.get("provider"),
        request_key,
        _nullish(configured.get("provider"), config.get("provider")),
        _nullish(configured.get("apiKey"), config.get("apiKey")),
    )
    _assert_endpoint_credential_pair(
        "finalProofreading.endpoint",
        requested.get("endpoint"),
        request_key,
        _nullish(configured.get("endpoint"), config.get("endpoint")),
        _nullish(configured.get("apiKey"), config.get("apiKey")),
    )


def _provider_stage_request_api_key(
    config: Mapping[str, Any], body: Mapping[str, Any], requested: Mapping[str, Any], configured: Mapping[str, Any]
) -> object:
    if requested.get("apiKey"):
        return requested.get("apiKey")
    llm = as_dict(body.get("llm"))
    if not llm.get("apiKey"):
        return None
    parent_provider = _nullish(llm.get("provider"), config.get("provider"))
    configured_provider = _nullish(configured.get("provider"), config.get("provider")) if configured else None
    stage_provider = _nullish(_nullish(requested.get("provider"), configured_provider), parent_provider)
    return llm.get("apiKey") if stage_provider == parent_provider else None


def _merge_provider_stage_settings(
    config: Mapping[str, Any],
    body: Mapping[str, Any],
    configured: Mapping[str, Any],
    nested: Mapping[str, Any],
    top_level: Mapping[str, Any],
) -> dict[str, Any] | None:
    if not configured and not nested and not top_level:
        return None
    requested = {**nested, **top_level}
    llm = as_dict(body.get("llm"))
    configured_provider = _nullish(configured.get("provider"), config.get("provider")) if configured else None
    provider_changed = bool(
        requested.get("provider") and configured_provider and requested.get("provider") != configured_provider
    )
    inherited = {"enabled": configured.get("enabled")} if provider_changed else dict(configured)
    effective_provider = _nullish(
        _nullish(_nullish(requested.get("provider"), configured_provider), llm.get("provider")), config.get("provider")
    )
    return {**inherited, **requested, **({"provider": effective_provider} if effective_provider else {})}


def _effective_final_proofreading_provider(
    config: Mapping[str, Any], body: Mapping[str, Any], requested: Mapping[str, Any]
) -> object:
    configured = as_dict(config.get("finalProofreading"))
    llm = as_dict(body.get("llm"))
    configured_provider = _nullish(configured.get("provider"), config.get("provider")) if configured else None
    return _nullish(
        _nullish(_nullish(requested.get("provider"), configured_provider), llm.get("provider")), config.get("provider")
    )


def _final_proofreading_request_api_key(
    config: Mapping[str, Any], body: Mapping[str, Any], requested: Mapping[str, Any]
) -> object:
    if requested.get("apiKey"):
        return requested.get("apiKey")
    llm = as_dict(body.get("llm"))
    if not llm.get("apiKey"):
        return None
    return (
        llm.get("apiKey")
        if _effective_final_proofreading_provider(config, body, requested)
        == _nullish(llm.get("provider"), config.get("provider"))
        else None
    )


def _merge_final_proofreading_settings(config: Mapping[str, Any], body: Mapping[str, Any]) -> dict[str, Any] | None:
    configured = as_dict(config.get("finalProofreading"))
    llm = as_dict(body.get("llm"))
    requested = {**as_dict(llm.get("finalProofreading")), **as_dict(body.get("finalProofreading"))}
    if not configured and not requested:
        return None
    configured_provider = _nullish(configured.get("provider"), config.get("provider")) if configured else None
    provider = _effective_final_proofreading_provider(config, body, requested)
    provider_changed = bool(requested.get("provider") and requested.get("provider") != configured_provider)
    inherited = {"enabled": configured.get("enabled")} if provider_changed else dict(configured)
    merged = {**inherited, **requested}
    configured_endpoint = _nullish(configured.get("endpoint"), config.get("endpoint"))
    parent_provider = _nullish(llm.get("provider"), config.get("provider"))
    inherits_parent = provider == parent_provider
    parent_matches_config = parent_provider == config.get("provider")
    inherited_endpoint = _nullish(llm.get("endpoint"), config.get("endpoint") if parent_matches_config else None)
    endpoint = _nullish(merged.get("endpoint"), inherited_endpoint if inherits_parent else None)
    server_key = _nullish(configured.get("apiKey"), config.get("apiKey"))
    endpoint_changed = bool(
        server_key
        and endpoint
        and (
            not configured_endpoint or _endpoint_identity(str(endpoint)) != _endpoint_identity(str(configured_endpoint))
        )
    )
    request_key = _final_proofreading_request_api_key(config, body, requested)
    result: dict[str, Any] = {
        **merged,
        "provider": provider,
        "apiKey": request_key if provider_changed or endpoint_changed else _nullish(merged.get("apiKey"), request_key),
        "model": _nullish(
            merged.get("model"),
            _nullish(llm.get("model"), config.get("model") if parent_matches_config else None) if inherits_parent else None,
        ),
        "endpoint": endpoint,
        "deployment": _nullish(
            merged.get("deployment"),
            _nullish(
                as_dict(llm.get("deployments")).get("proofreading"),
                _nullish(
                    llm.get("deployment"),
                    _nullish(
                        as_dict(config.get("deployments")).get("proofreading"), config.get("deployment")
                    )
                    if parent_matches_config
                    else None,
                ),
            )
            if inherits_parent
            else None,
        ),
        "apiVersion": _nullish(
            merged.get("apiVersion"),
            _nullish(llm.get("apiVersion"), config.get("apiVersion") if parent_matches_config else None)
            if inherits_parent
            else None,
        ),
    }
    return result


def _assert_provider_credential_pair(
    label: str, request_provider: object, request_api_key: object, server_provider: object, server_api_key: object
) -> None:
    if not request_provider or not server_api_key or request_provider == server_provider or request_api_key:
        return
    raise RestRequestConfigurationError(
        f"{label} cannot change the configured provider while inheriting a server-managed API key. "
        "Supply an API key for the requested provider."
    )


def _assert_endpoint_credential_pair(
    label: str, request_endpoint: object, request_api_key: object, server_endpoint: object, server_api_key: object
) -> None:
    if not request_endpoint or request_api_key or not server_api_key:
        return
    request_identity = _endpoint_identity(str(request_endpoint))
    if server_endpoint and request_identity == _endpoint_identity(str(server_endpoint)):
        return
    raise RestRequestConfigurationError(
        f"{label} cannot override the configured provider endpoint while using a server-managed API key."
    )


def _endpoint_identity(value: str) -> str:
    """Return the canonical identity produced by legacy ``new URL`` handling."""

    try:
        parsed = URL(value)
        if parsed.username or parsed.password or parsed.search or parsed.hash:
            raise ValueError
        path = parsed.pathname.rstrip("/") or "/"
        return f"{parsed.protocol}//{parsed.host}{path}"
    except (ValueError, TypeError):
        raise RestRequestConfigurationError(f"Invalid provider endpoint URL: {value}") from None


def create_pdp_geo_generator_rest_handler(config: Mapping[str, Any] | None = None):
    """Return an async handler with legacy 200/207/400/405/500 semantics."""
    configuration = dict(config or {})

    async def handler(request: object) -> dict[str, Any]:
        if _method(request) != "POST":
            return _response({"error": "Method not allowed. Use POST."}, 405)
        try:
            body = await _request_json(request)
            if body is None:
                raise RuntimeError("Cannot read properties of null (reading 'llm')")
            if not isinstance(body, Mapping):
                return _response({"error": "At least one product JSON payload is required."}, 400)
            body = cast(Mapping[str, Any], body)
            runtime = _safe_runtime(configuration, body)
            products = (
                as_list(body.get("products"))
                if isinstance(body.get("products"), list)
                else [body["product"]]
                if "product" in body
                else []
            )
            if not products:
                return _response({"error": "At least one product JSON payload is required."}, 400)

            async def generate_one(index: int, product: object) -> dict[str, Any]:
                try:
                    run = await generate_pdp_geo(
                        {
                            "product": product,
                            "source": body.get("source"),
                            "hints": body.get("hints"),
                            "fieldMapping": body.get("fieldMapping"),
                            "rag": body.get("rag"),
                        },
                        runtime,
                )
                    return {"status": "fulfilled", "run": run}
                except Exception as error:
                    message = _legacy_rest_failure_message(error) or "PDP GEO generation failed."
                    return {
                        "status": "rejected",
                        "failure": {"index": index, "error": message},
                        "diagnostics": _failure_diagnostics(message),
                    }

            runs = await asyncio.gather(*(generate_one(index, product) for index, product in enumerate(products)))
            successful = [run for run in runs if run["status"] == "fulfilled"]
            failed = [run for run in runs if run["status"] == "rejected"]
            return _response(
                {
                    "results": [as_dict(run.get("run")).get("result") for run in successful],
                    "logs": [
                        *[
                            {
                                "diagnostics": as_dict(run.get("run")).get("diagnostics"),
                                "process": as_dict(run.get("run")).get("process"),
                            }
                            for run in successful
                        ],
                        *[
                            {
                                "diagnostics": run.get("diagnostics"),
                                "process": _failure_process(str(as_dict(run.get("failure")).get("error") or "")),
                            }
                            for run in failed
                        ],
                    ],
                    "failures": [as_dict(run.get("failure")) for run in failed],
                },
                207 if failed else 200,
            )
        except (RestRequestConfigurationError, RestRequestBodyError) as error:
            return _response({"error": str(error)}, 400)
        except Exception as error:
            return _response({"error": str(error) or "PDP GEO generation failed."}, 500)

    return handler


def _failure_diagnostics(message: str) -> dict[str, Any]:
    return {
        "recommendations": [],
        "evidence": [{"field": "generation", "source": "repair", "value": message}],
        "selectedRagChunks": [],
        "ragUsage": [],
        "validationWarnings": [message],
        "ragMode": "local-versioned-rag",
        "generatedAt": _timestamp(),
    }


def _legacy_rest_failure_message(error: Exception) -> str:
    """Render Pydantic literal errors as the deleted Zod error-message wire."""

    if not isinstance(error, ValidationError):
        return str(error)
    issues: list[dict[str, object]] = []
    for issue in error.errors(include_url=False):
        if issue.get("type") != "literal_error":
            return str(error)
        values = re.findall(r"'([^']+)'", str(as_dict(issue.get("ctx")).get("expected")))
        if not values:
            return str(error)
        quoted = "|".join(f'"{value}"' for value in values)
        issues.append(
            {
                "code": "invalid_value",
                "values": values,
                "path": list(cast(tuple[object, ...], issue.get("loc", ()))),
                "message": f"Invalid option: expected one of {quoted}",
            }
        )
    return json.dumps(issues, ensure_ascii=False, indent=2)


def _failure_process(message: str) -> list[dict[str, str]]:
    timestamp = _timestamp()
    steps = (
        ("input", "입력 검증", "임의 상품 JSON과 옵션을 검증"),
        ("normalize", "상품 신호 정규화", "REST/API/PDP JSON을 내부 ProductSignal로 변환"),
        ("rag-load", "RAG 프로필 로드", "schema.org, E-E-A-T, CEP, GEO, BestPractice, locale 용어집 로드"),
        ("chunk", "RAG chunk 구성", "버전 문서와 상품 컨텍스트를 검색 가능한 chunk로 준비"),
        ("embed", "임베딩 구성", "로컬 또는 managed vector store 임베딩 전략 적용"),
        ("retrieve", "RAG 검색", "상품/locale/schema 목표에 맞는 관련 문서 검색"),
        ("rerank", "리랭킹", "schema, locale, terminology, GEO 관련성을 기준으로 재정렬"),
        (
            "generate",
            "GEO 산출물 생성 및 최종 교정",
            "JSON-LD 생성 후 선택적으로 별도 fluency-only proofreading 모델 호출",
        ),
        ("validate", "문법 검증", "JSON-LD 구조와 공개 문구 검증"),
        ("repair", "검증 결과 기록", "자동 수정 없이 validation findings를 diagnostics에 기록"),
        ("quality-gate", "품질 게이트 자가 보정", "GEO/CEP/E-E-A-T 루브릭으로 자가 평가 후 미달 시 표적 보정 1회"),
        ("artifact", "최종 아티팩트 생성", "복사 가능한 schemaMarkup과 content 결과 생성"),
    )
    return [
        {
            "id": identifier,
            "title": title,
            "description": description,
            "status": "done" if index == 0 else "error" if index == 1 else "pending",
            "message": "입력을 수신했습니다." if index == 0 else message if index == 1 else description,
            **({"startedAt": timestamp, "completedAt": timestamp} if index <= 1 else {}),
        }
        for index, (identifier, title, description) in enumerate(steps)
    ]


def _timestamp() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


createPdpGeoGeneratorRestHandler = create_pdp_geo_generator_rest_handler
