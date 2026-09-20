"""Provider validation wire contract retained from the Next console routes.

The console has historically used this endpoint to validate user-supplied
configuration before it is persisted locally. Keep its Korean copy, check
order, and response shapes aligned with the retained TypeScript route: callers
display these strings directly.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from importlib import import_module
from typing import Any, Protocol, cast
from urllib.parse import quote

import httpx
from neo_js_compat import js_json_bytes, js_template_string, js_trim, js_whitespace_characters

from neo_agent_api._json import as_dict, as_list


class _IcuCollator(Protocol):
    def getSortKey(self, value: str) -> bytes: ...


class _IcuFactory(Protocol):
    @staticmethod
    def createInstance(locale: object) -> _IcuCollator: ...


class _IcuLocaleFactory(Protocol):
    def __call__(self, name: str) -> object: ...


class _IcuModule(Protocol):
    """The exact runtime surface consumed from PyICU's untyped extension."""

    Collator: _IcuFactory
    Locale: _IcuLocaleFactory


# ``String.prototype.localeCompare`` in the retained browser route uses ICU,
# not a frozen Unicode-10 UCA table.  Use the same en-US default collation as
# Node's server runtime; newer emoji and CJK ordering otherwise diverge.
_ICU_MODULE = cast(_IcuModule, import_module("icu"))
_ICU = _ICU_MODULE.Collator.createInstance(_ICU_MODULE.Locale("en_US"))
_JS_WHITESPACE_CHARACTERS = re.escape(js_whitespace_characters())
_JS_WHITESPACE = f"[{_JS_WHITESPACE_CHARACTERS}]"
_JS_NOT_WHITESPACE = f"[^{_JS_WHITESPACE_CHARACTERS}]"
_JS_DOT = r"[^\n\r\u2028\u2029]"
# Python's Unicode-aware IGNORECASE expands ASCII ranges (for example, to
# Kelvin sign). ECMAScript's non-Unicode ``/i`` source regexes here do not.
_JS_IGNORECASE = re.IGNORECASE | re.ASCII


def _js_truthy(value: object) -> bool:
    if value is None or value is False:
        return False
    if isinstance(value, str):
        return value != ""
    if isinstance(value, int | float) and not isinstance(value, bool):
        return value != 0 and value == value
    return True


def _trimmed(value: object, expression: str = "value") -> str | None:
    # ``value?.trim()`` short-circuits only null/undefined.  A non-string
    # JSON value still reaches a JavaScript property call and throws; silently
    # coercing it here changed the outer Next route's 500 wire behavior.
    if value is None:
        return None
    if not isinstance(value, str):
        raise TypeError(f"{expression}?.trim is not a function")
    return js_trim(value)


def _mapping(value: object) -> Mapping[str, object]:
    return as_dict(value)


def _secret(value: object) -> str:
    """Mirror ``normalizeSecretInput`` from the two retained Next routes."""

    trimmed = _trimmed(value) or ""
    without_export = re.sub(rf"^export{_JS_WHITESPACE}+", "", trimmed, flags=_JS_IGNORECASE)
    assignment = re.match(
        rf"^[A-Z0-9_]+{_JS_WHITESPACE}*={_JS_WHITESPACE}*({_JS_DOT}+)$",
        without_export,
        flags=_JS_IGNORECASE,
    )
    raw = assignment.group(1) if assignment else without_export
    return re.sub(r"^[\"']|[\"']$", "", js_trim(raw))


def _failed(provider: str, message: str, details: str | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {"ok": False, "provider": provider, "message": message}
    if details is not None:
        result["details"] = details
    return result


def _connected(provider: str, message: str, models: list[str] | None = None) -> dict[str, Any]:
    return {"ok": True, "provider": provider, "message": message, "models": models or []}


def _model_ids(values: object) -> list[str]:
    # ``Array.from(new Set(values)).sort((a, b) => a.localeCompare(b))`` keeps
    # first-seen values and uses browser UCA collation.
    unique = list(dict.fromkeys(value for value in as_list(values) if isinstance(value, str) and value))
    return sorted(unique, key=_ICU.getSortKey)


def _unique_nonempty_trimmed(values: Sequence[object]) -> list[str]:
    result: list[str] = []
    for value in values:
        normalized = _trimmed(value)
        if normalized and normalized not in result:
            result.append(normalized)
    return result


def _encoded(value: str) -> str:
    # JavaScript's encodeURIComponent leaves these punctuation characters intact.
    return quote(value, safe="-_.!~*'()")


def _response_ok(response: object) -> bool:
    """Fetch ``Response.ok`` means exactly HTTP 200 through 299."""

    return 200 <= int(getattr(response, "status_code")) < 300


def _property(value: object, key: str) -> object | None:
    """Read a direct JavaScript property from parsed JSON data.

    Optional chaining in the retained handlers begins *after* several of
    these reads.  A null upstream payload/item must therefore retain V8's
    direct-property error while numbers, strings, and arrays simply expose an
    absent named property.
    """

    if value is None:
        raise TypeError(f"Cannot read properties of null (reading '{key}')")
    return as_dict(value).get(key) if isinstance(value, Mapping) else None


def _optional_property(value: object | None, key: str) -> object | None:
    """Mirror a property access guarded by JavaScript optional chaining."""

    return as_dict(value).get(key) if isinstance(value, Mapping) else None


def _nullish(value: object | None, fallback: object | None) -> object | None:
    return fallback if value is None else value


def _array_for_method(value: object | None, expression: str, method: str) -> list[object]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise TypeError(f"{expression}?.{method} is not a function")
    return list(cast(list[object], value))


async def validate_provider(config: Mapping[str, Any]) -> dict[str, Any]:
    configured = _mapping(config)
    raw_provider = configured.get("provider")
    # The route uses ``body.provider ?? "mock"``.  Do not turn falsey or
    # non-string values into mock: at runtime TypeScript carries those values
    # through its named branches and then reaches the Azure fallback.
    provider = raw_provider if raw_provider is not None else "mock"
    if provider == "mock":
        return {"ok": True, "provider": "mock", "message": "Mock provider는 별도 API Key 없이 사용할 수 있습니다."}
    if provider == "openai":
        return await _openai(configured)
    if provider == "gemini":
        return await _gemini(configured)
    if provider == "aistudio":
        return await _aistudio(configured)
    return await _azure(configured)


async def _openai(config: Mapping[str, object]) -> dict[str, Any]:
    api_key = _secret(config.get("apiKey"))
    if not api_key:
        return _failed("openai", "OpenAI API Key가 필요합니다.")

    # Deliberately do not catch network failures. The Next route catches them
    # at its outer HTTP boundary and returns the established 500 envelope.
    # Next's server-side ``fetch`` follows redirects by default.
    async with httpx.AsyncClient(follow_redirects=True) as client:
        response = await client.get("https://api.openai.com/v1/models", headers={"Authorization": f"Bearer {api_key}"})
    if not _response_ok(response):
        return _failed("openai", f"OpenAI 연결 확인 실패: {response.status_code}", _provider_error(response))

    payload = response.json()
    data = _property(payload, "data")
    models = _model_ids([_property(item, "id") for item in _array_for_method(data, "payload.data", "map")])
    model = _trimmed(config.get("model"), "config.model")
    if model and not _js_truthy(config.get("listOnly")) and model not in models:
        return _failed(
            "openai",
            f"OpenAI API Key는 유효하지만 '{model}' 모델 접근을 확인하지 못했습니다.",
            "모델명을 비우거나 API Dashboard에서 사용 가능한 모델 ID를 입력해주세요.",
        )
    return _connected("openai", "OpenAI API Key와 모델 접근을 확인했습니다.", models)


async def _gemini(config: Mapping[str, object]) -> dict[str, Any]:
    api_key = _secret(config.get("apiKey"))
    if not api_key:
        return _failed("gemini", "Gemini API Key가 필요합니다.")

    # See ``_openai`` for why this deliberately propagates transport errors.
    async with httpx.AsyncClient(follow_redirects=True) as client:
        response = await client.get(
            "https://generativelanguage.googleapis.com/v1beta/models", headers={"x-goog-api-key": api_key}
        )
    if not _response_ok(response):
        return _failed("gemini", f"Gemini 연결 확인 실패: {response.status_code}", _provider_error(response))

    payload = response.json()
    raw_models = _property(payload, "models")
    model_ids: list[object] = []
    for raw_item in _array_for_method(raw_models, "payload.models", "filter"):
        methods = _property(raw_item, "supportedGenerationMethods")
        if methods is not None:
            if isinstance(methods, str):
                if "generateContent" not in methods:
                    continue
            elif not isinstance(methods, list):
                raise TypeError("item.supportedGenerationMethods.includes is not a function")
            elif "generateContent" not in methods:
                continue
        name = _property(raw_item, "name")
        if name is not None:
            if not isinstance(name, str):
                raise TypeError("item.name?.replace is not a function")
            model_ids.append(name.removeprefix("models/"))
    models = _model_ids(model_ids)
    model = _trimmed(config.get("model"), "config.model")
    if model and not _js_truthy(config.get("listOnly")) and model not in models:
        return _failed(
            "gemini",
            f"Gemini API Key는 유효하지만 '{model}' 모델 접근을 확인하지 못했습니다.",
            "모델명을 비우거나 Google AI Studio에서 사용 가능한 모델 ID를 입력해주세요.",
        )
    return _connected("gemini", "Gemini API Key와 모델 접근을 확인했습니다.", models)


async def _azure(config: Mapping[str, object]) -> dict[str, Any]:
    api_key = _secret(config.get("apiKey"))
    endpoint = _trimmed(config.get("endpoint"), "config.endpoint")
    if endpoint and endpoint.endswith("/"):
        # The source uses ``replace(/\/$/, "")``, rather than stripping every slash.
        endpoint = endpoint[:-1]
    api_version = _trimmed(config.get("apiVersion"), "config.apiVersion") or "2024-10-21"
    if not api_key or not endpoint:
        return _failed("azure-openai", "Azure API Key와 Endpoint가 필요합니다.")

    async with httpx.AsyncClient(follow_redirects=True) as client:
        response = await client.get(
            f"{endpoint}/openai/deployments?api-version={_encoded(api_version)}",
            headers={"api-key": api_key},
        )
    if not _response_ok(response):
        return _failed("azure-openai", f"Azure API 연결 확인 실패: {response.status_code}", _provider_error(response))

    payload = response.json()
    data = _property(payload, "data")
    deployments = _model_ids(
        [
            _nullish(_property(item, "id"), _property(item, "model"))
            for item in _array_for_method(data, "payload.data", "map")
        ]
    )
    if _js_truthy(config.get("listOnly")):
        return _connected("azure-openai", "Azure 배포 목록을 불러왔습니다.", deployments)

    roles = _mapping(config.get("deployments"))
    embedding = _mapping(config.get("embedding"))
    requested = _unique_nonempty_trimmed(
        [
            roles.get("ocr"),
            roles.get("reasoning"),
            roles.get("embedding"),
            embedding.get("deployment"),
            config.get("deployment"),
        ]
    )
    ocr = _trimmed(roles.get("ocr"), "config.deployments?.ocr") or _trimmed(
        config.get("deployment"), "config.deployment"
    )
    reasoning = _trimmed(roles.get("reasoning"), "config.deployments?.reasoning") or _trimmed(
        config.get("deployment"), "config.deployment"
    )
    embedding_deployment = _trimmed(roles.get("embedding"), "config.deployments?.embedding") or _trimmed(
        embedding.get("deployment"), "config.embedding?.deployment"
    )
    if not ocr or not reasoning:
        return _failed(
            "azure-openai",
            "Azure OCR/Reasoning Deployment를 입력해주세요.",
            "OCR/structure extraction과 최종 분류/분석 추론에 사용할 Azure 배포가 필요합니다.",
        )
    for deployment in requested:
        if deployment not in deployments:
            return _failed(
                "azure-openai",
                f"Azure API 연결은 되었지만 '{deployment}' 배포를 확인하지 못했습니다.",
                (
                    "Azure AI Foundry 또는 Azure Portal에서 역할별 deployment 이름을 "
                    "확인하거나 모델 목록에서 선택해주세요."
                ),
            )
    if not embedding_deployment:
        return _failed(
            "azure-openai",
            "Azure Embedding Deployment를 입력해주세요.",
            "RAG embedding에는 text-embedding-3-small deployment가 필요합니다.",
        )

    reranker = _mapping(config.get("reranker"))
    reranker_provider = reranker.get("provider") if reranker.get("provider") is not None else "cohere"
    if reranker_provider == "cohere" and (
        not _secret(reranker.get("apiKey")) or not _trimmed(reranker.get("endpoint"), "config.reranker?.endpoint")
    ):
        return _failed(
            "azure-openai",
            "Cohere Rerank는 Cohere/Foundry Key와 Endpoint가 필요합니다.",
            (
                "OCR, Embedding, Final reasoning은 Azure API Key와 Endpoint를 공유하지만 "
                "Cohere Rerank는 별도 reranking endpoint로 호출됩니다."
            ),
        )
    if reranker_provider == "azure-ai-search-semantic" and (
        not _trimmed(reranker.get("endpoint"), "config.reranker?.endpoint")
        or not _secret(reranker.get("apiKey"))
        or not _trimmed(reranker.get("indexName"), "config.reranker?.indexName")
    ):
        return _failed(
            "azure-openai",
            "Azure AI Search semantic ranker 설정을 입력해주세요.",
            "Azure AI Search는 별도 Search 서비스이므로 Search Endpoint, API Key, Index name이 필요합니다.",
        )
    return _connected("azure-openai", "Azure API 공통 인증과 선택한 reranking 서비스 설정이 유효합니다.", deployments)


def _aistudio_status_message(status: int) -> str:
    if status == 401:
        return "API Key가 없거나 올바르지 않습니다 (401). API Key 값을 확인하세요."
    if status == 403:
        return "토큰 할당량을 초과했습니다 (403). 관리자에게 할당량 관련 문의가 필요합니다."
    if status == 404:
        return "모델 ID 또는 Endpoint 경로 오류입니다 (404). 모델 ID가 프로젝트에 등록되어 있는지 확인하세요."
    if status in {502, 503}:
        return f"AI Studio 게이트웨이 또는 upstream 모델 서비스를 사용할 수 없습니다 ({status}). 잠시 후 재시도하세요."
    if status >= 500:
        return f"AI Studio 게이트웨이 내부 오류입니다 ({status}). 요청 파라미터를 확인하고 담당자에게 문의하세요."
    return f"AI Studio 연결 확인 실패: {status}"


async def _aistudio(config: Mapping[str, object]) -> dict[str, Any]:
    api_key = _secret(config.get("apiKey"))
    endpoint = _trimmed(config.get("endpoint"), "config.endpoint")
    if endpoint and endpoint.endswith("/"):
        endpoint = endpoint[:-1]
    if not api_key or not endpoint:
        return _failed("aistudio", "AI Studio Endpoint와 API Key가 필요합니다.")

    deployments = _mapping(config.get("deployments"))
    embedding = _mapping(config.get("embedding"))
    embedding_model = _trimmed(embedding.get("deployment"), "config.embedding?.deployment") or _trimmed(
        deployments.get("embedding"), "config.deployments?.embedding"
    )
    chat_models = _unique_nonempty_trimmed(
        [deployments.get("ocr"), deployments.get("reasoning"), config.get("deployment")]
    )
    api_version = _trimmed(config.get("apiVersion"), "config.apiVersion")
    suffix = f"?api-version={_encoded(api_version)}" if api_version else ""
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}
    checks: list[tuple[str, str, dict[str, object]]] = []
    if embedding_model:
        checks.append(
            (
                f"Embedding model '{embedding_model}'",
                f"{endpoint}/openai/deployments/{_encoded(embedding_model)}/embeddings{suffix}",
                {"input": "ping"},
            )
        )
    checks.extend(
        (
            f"OCR/Reasoning model '{model}'",
            f"{endpoint}/openai/deployments/{_encoded(model)}/chat/completions{suffix}",
            {"messages": [{"role": "user", "content": "ping"}]},
        )
        for model in chat_models
    )
    if not checks:
        return _failed(
            "aistudio",
            "확인할 모델 ID를 입력해주세요.",
            "embedding 또는 OCR/reasoning 모델 ID 중 하나가 필요합니다.",
        )

    try:
        async with httpx.AsyncClient(follow_redirects=True) as client:
            for label, url, body in checks:
                response = await client.post(url, headers=headers, content=js_json_bytes(body))
                if not _response_ok(response):
                    return _failed(
                        "aistudio",
                        f"{label} 확인 실패. {_aistudio_status_message(response.status_code)}",
                        _provider_error(response),
                    )
    except Exception as exc:
        return _failed(
            "aistudio",
            "AI Studio Endpoint에 연결하지 못했습니다.",
            f"Endpoint URL이 정확한지, 네트워크 연결을 확인하세요.\n{exc}",
        )
    return _connected("aistudio", f"AI Studio Endpoint, API Key, {len(checks)}개 모델 호출을 확인했습니다.")


def _utf16_slice(value: str, units: int) -> str:
    encoded = value.encode("utf-16-le", "surrogatepass")[: units * 2]
    # This is a response-only mirror of JavaScript ``String.prototype.slice``.
    # A split pair is intentionally preserved so JSON.stringify emits its
    # ``\\ud83d`` escape; database error fields use their own safe helper.
    return encoded.decode("utf-16-le", "surrogatepass")


# Public narrow seam for response-only JavaScript slice parity.
utf16_slice = _utf16_slice


def _provider_error(response: object) -> str | None:
    try:
        payload = getattr(response, "json")()
        error = _property(payload, "error")
        raw = _nullish(
            _optional_property(error, "message"),
            _nullish(_property(payload, "error_description"), _property(payload, "message")),
        )
        message_detail = _format_provider_error_detail(raw)
        code = _nullish(_optional_property(error, "code"), _optional_property(error, "status"))
        code_detail = f"code: {js_template_string(code)}" if _js_truthy(code) else None
        return "\n".join(part for part in (message_detail, code_detail) if part) or None
    except TypeError, ValueError:
        return None


def _format_provider_error_detail(message: object) -> str | None:
    if not _js_truthy(message):
        return None
    # Retained formatProviderErrorDetail short-circuits falsy values, then
    # calls .replace directly. A truthy nonstring aborts the whole assembly.
    if not isinstance(message, str):
        raise TypeError("message.replace is not a function")
    sanitized = re.sub(
        r"sk-(?:proj|live|test|admin|svcacct)?-[A-Za-z0-9_*=-]{8,}",
        "sk-...[숨김]",
        message,
        flags=_JS_IGNORECASE,
    )
    sanitized = re.sub(r"AIza[A-Za-z0-9_-]{8,}", "AIza...[숨김]", sanitized)
    sanitized = re.sub(r"[A-Za-z0-9_-]*\*{12,}[A-Za-z0-9_*=.-]*", "[키 숨김]", sanitized)
    sanitized = re.sub(r"\*{12,}", "********", sanitized)
    sanitized = js_trim(re.sub(rf"{_JS_WHITESPACE}+", " ", sanitized))
    if re.search(r"incorrect api key", sanitized, flags=_JS_IGNORECASE):
        message_detail = "API Key가 올바르지 않습니다.\n키를 다시 입력하거나 provider 콘솔에서 새 키를 발급해주세요."
    else:
        message_detail = re.sub(rf"{_JS_WHITESPACE}+(https?://{_JS_NOT_WHITESPACE}+)", r"\n\1", sanitized)
        message_detail = re.sub(
            rf"{_JS_WHITESPACE}+code:{_JS_WHITESPACE}*", "\ncode: ", message_detail, flags=_JS_IGNORECASE
        )
        message_detail = js_trim(_utf16_slice(message_detail, 360))
    return message_detail
