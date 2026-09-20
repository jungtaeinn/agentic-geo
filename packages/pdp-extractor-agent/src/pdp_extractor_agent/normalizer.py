"""Source-backed product-profile normalization and provider adapters."""

from __future__ import annotations

import inspect
import json
import math
import re
from collections.abc import Mapping, Sequence
from copy import deepcopy
from typing import Any, cast
from unicodedata import normalize

import httpx
from neo_js_compat import js_json_bytes, js_json_pretty_dumps

from ._json_types import as_list, as_mapping
from .providers.aistudio import AistudioProvider
from .providers.transport import model_timeout_seconds, temperature_body, timeout_label_seconds

_DEFAULT_MAX_SOURCE_CHARACTERS = 35_000
_DEFAULT_MAX_RAG_DOCUMENTS = 8
_PROFILE_STRING_FIELDS = ("name", "brand", "description", "price", "currency")
_PROFILE_ARRAY_FIELDS = ("images", "options", "benefits", "effects", "ingredients", "usage", "metrics")
_PROFILE_CONTENT_CATEGORIES = frozenset(
    {"benefit", "effect", "ingredient", "usage", "faq", "review", "rating", "metric", "unknown"}
)


def create_product_profile_normalization_prompt(
    request: Mapping[str, Any], max_source_characters: int = _DEFAULT_MAX_SOURCE_CHARACTERS
) -> dict[str, str]:
    """Build the frozen system/user prompt used by every model adapter."""

    system = "\n".join(
        [
            "You are a conservative product extraction normalization agent.",
            'Return strict JSON only: {"product":{},"warnings":[]}.',
            "Infer ProductProfile fields from raw source data, bootstrap ProductProfile, and RAG policy documents.",
            "Your job is source-backed field routing, not public copywriting.",
            "Keep brand as a separate ProductProfile.brand field when source data identifies a maker/brand; do not merge SKU option labels into brand.",
            "Use source product data only. Do not invent claims, ingredients, effects, prices, reviews, metrics, awards, or certifications.",
            "Prefer complete source-backed sentences over isolated tokens. Keep benefit, effect, ingredient, usage, FAQ, metric, option, and image fields separated.",
            "Use RAG policy to resolve overlaps: commerce UI, coupon, delivery, exchange, refund, return, legal, and page chrome text must not become product evidence.",
            "If the bootstrap value is safer or better supported than your inferred value, return the bootstrap value or omit the field.",
        ]
    )
    payload = {
        "task": "Infer a source-backed ProductProfile with fewer hardcoded field assumptions.",
        "source": request.get("source"),
        "sourceType": request.get("sourceType"),
        "bootstrapProduct": _json_value(request.get("bootstrapProduct", {})),
        "rawSource": _trim_json_for_prompt(request.get("rawSource"), max_source_characters),
        "ragPolicy": _rag_policy(request),
    }
    return {"system": system, "user": js_json_pretty_dumps(payload)}


async def normalize_extractor_product_profile_with_agent(
    request: Mapping[str, Any], options: Mapping[str, Any]
) -> dict[str, Any]:
    """Run an injected/configured normalizer and accept only source-backed edits."""

    bootstrap_raw = as_mapping(request.get("bootstrapProduct"))
    bootstrap = deepcopy(dict(bootstrap_raw)) if bootstrap_raw is not None else {}
    custom = _nullish(options.get("customProductNormalizer"), options.get("custom_product_normalizer"))
    settings_value = _nullish(options.get("productNormalization"), options.get("product_normalization"))
    settings_mapping = as_mapping(settings_value)
    settings = dict(settings_mapping) if settings_mapping is not None else {}
    normalizer: Any = custom
    warning: str | None = None
    if normalizer is None and settings.get("enabled"):
        # Match the retained TS resolver's ``??`` behavior.  In particular, an
        # explicit empty provider/deployment/apiVersion is meaningful and must
        # not quietly select a different model route.
        provider = _nullish(settings.get("provider"), options.get("provider"), "mock")
        if provider == "mock":
            warning = "mock product profile normalization requires customProductNormalizer."
        else:
            option_deployments = as_mapping(options.get("deployments"))
            normalizer_config = dict(options)
            normalizer_config.update(
                {
                    "provider": provider,
                    "apiKey": _nullish(settings.get("apiKey"), options.get("apiKey")),
                    "model": _nullish(settings.get("model"), options.get("model")),
                    "endpoint": _nullish(settings.get("endpoint"), options.get("endpoint")),
                    "deployment": _nullish(
                        settings.get("deployment"),
                        option_deployments.get("reasoning") if option_deployments is not None else None,
                        options.get("deployment"),
                    ),
                    "apiVersion": _nullish(settings.get("apiVersion"), options.get("apiVersion")),
                    # Product-normalization settings do not own temperature;
                    # the outer runtime does in the legacy public contract.
                    "temperature": options.get("temperature"),
                    "timeoutSeconds": _nullish(
                        settings.get("timeoutSeconds"),
                        settings.get("timeout_seconds"),
                        options.get("timeoutSeconds"),
                        options.get("timeout_seconds"),
                    ),
                    "maxSourceCharacters": settings.get("maxSourceCharacters"),
                }
            )
            normalizer = ModelBackedProductProfileNormalizer(normalizer_config)
    base: dict[str, Any] = {"product": bootstrap, "evidence": [], "warnings": [], "called": False, "applied": False}
    if normalizer is None:
        if warning:
            base["warnings"] = [warning]
            base["evidence"] = [
                {
                    "field": "product.normalization",
                    "source": "llm",
                    "value": f"Product profile normalization skipped: {warning}",
                }
            ]
        return base
    method = getattr(normalizer, "normalize_product_profile", None) or getattr(
        normalizer, "normalizeProductProfile", None
    )
    if not callable(method):
        message = "Configured product profile normalizer does not provide normalize_product_profile."
        return {
            **base,
            "warnings": [message],
            "evidence": [
                {
                    "field": "product.normalization",
                    "source": "llm",
                    "value": f"Product profile normalization skipped: {message}",
                }
            ],
        }
    provider_request = dict(request)
    documents = as_list(provider_request.get("ragDocuments"))
    if documents is not None:
        maximum = settings.get("maxRagDocuments")
        # ``??`` rather than ``||`` in the retained TypeScript: an explicit
        # zero deliberately removes policy documents from this model call.
        try:
            limit = int(maximum) if maximum is not None else _DEFAULT_MAX_RAG_DOCUMENTS
        except (TypeError, ValueError, OverflowError):
            limit = 0
        provider_request["ragDocuments"] = documents[:limit]
    try:
        value = method(provider_request)
        response = await value if inspect.isawaitable(value) else value
    except Exception as error:
        message = str(error) or "Product profile normalization provider failed."
        return {
            **base,
            "called": True,
            "warnings": [message],
            "evidence": [
                {
                    "field": "product.normalization",
                    "source": "llm",
                    "value": f"Product profile normalization skipped: {message}",
                }
            ],
        }
    response_mapping = as_mapping(response)
    mapping = dict(response_mapping) if response_mapping is not None else {}
    product, evidence, rejected = _apply_source_backed_profile(
        bootstrap, mapping.get("product"), request.get("rawSource")
    )
    warnings = _warnings(mapping.get("warnings")) + rejected
    applied = product != bootstrap
    evidence.append(
        {
            "field": "product.normalization",
            "source": "llm",
            "value": (
                "Model-backed product profile normalization updated: " + ", ".join(_changed_fields(evidence))
                if applied
                else "Model-backed product profile normalization returned no accepted source-backed field changes."
            ),
        }
    )
    evidence.extend({"field": "product.normalization.warning", "source": "llm", "value": item} for item in warnings)
    result: dict[str, Any] = {
        "product": product,
        "evidence": evidence,
        "warnings": warnings,
        "called": True,
        "applied": applied,
    }
    usage = as_mapping(mapping.get("usage"))
    if usage is not None:
        result["usage"] = dict(usage)
    return result


class ModelBackedProductProfileNormalizer:
    """Transport-injectable OpenAI, Gemini, Azure, and AI Studio normalizer adapter."""

    def __init__(self, config: Mapping[str, Any]) -> None:
        self.config = dict(config)
        self.timeout_seconds = model_timeout_seconds(
            _nullish(self.config.get("timeoutSeconds"), self.config.get("timeout_seconds"))
        )

    async def normalize_product_profile(self, request: Mapping[str, Any]) -> dict[str, Any]:
        provider = _nullish(self.config.get("provider"), "mock")
        if provider == "mock":
            return {"warnings": [f"{provider} product profile normalization provider has no model-backed adapter."]}
        max_source_characters = _positive_or_zero_int(
            _nullish(self.config.get("maxSourceCharacters"), _DEFAULT_MAX_SOURCE_CHARACTERS),
            _DEFAULT_MAX_SOURCE_CHARACTERS,
        )
        prompt = create_product_profile_normalization_prompt(
            request, max_source_characters
        )
        if provider == "openai":
            return await self._normalize_openai(prompt)
        if provider == "gemini":
            return await self._normalize_gemini(prompt)
        if provider == "azure-openai":
            return await self._normalize_azure(prompt)
        if provider == "aistudio":
            return await self._normalize_aistudio(prompt)
        return {"warnings": [f"{provider} product profile normalization provider has no model-backed adapter."]}

    async def normalizeProductProfile(self, request: Mapping[str, Any]) -> dict[str, Any]:
        return await self.normalize_product_profile(request)

    async def _normalize_openai(self, prompt: Mapping[str, str]) -> dict[str, Any]:
        api_key, model = self.config.get("apiKey"), self.config.get("model")
        if not api_key or not model:
            raise ValueError("OPENAI_API_KEY and OPENAI_MODEL are required for product profile normalization.")
        async with httpx.AsyncClient(
            transport=self.config.get("transport"), timeout=self.timeout_seconds, follow_redirects=True
        ) as client:
            try:
                response = await client.post(
                    "https://api.openai.com/v1/responses",
                    headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                    content=js_json_bytes({"model": model, "instructions": prompt["system"], "input": prompt["user"]}),
                )
            except httpx.TimeoutException as error:
                raise RuntimeError(
                    f"OpenAI product profile normalization timed out after {timeout_label_seconds(self.timeout_seconds)}s."
                ) from error
        if response.status_code >= 400:
            raise RuntimeError(f"OpenAI product profile normalization failed: {response.status_code}")
        # The TypeScript adapter parses a possible ``output_text`` envelope,
        # but deliberately publishes the original response text as ``rawText``
        # for diagnostics.  Passing only the nested text loses that public
        # provider boundary and makes output-array envelopes unobservable.
        raw = response.text
        payload = as_mapping(response.json())
        return _normalization_result(raw, _openai_usage(payload.get("usage") if payload is not None else None))

    async def _normalize_gemini(self, prompt: Mapping[str, str]) -> dict[str, Any]:
        api_key, model = self.config.get("apiKey"), self.config.get("model")
        if not api_key or not model:
            raise ValueError("GEMINI_API_KEY and GEMINI_MODEL are required for product profile normalization.")
        body: dict[str, Any] = {
            "systemInstruction": {"parts": [{"text": prompt["system"]}]},
            "contents": [{"role": "user", "parts": [{"text": prompt["user"]}]}],
        }
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        async with httpx.AsyncClient(
            transport=self.config.get("transport"), timeout=self.timeout_seconds, follow_redirects=True
        ) as client:
            try:
                response = await client.post(
                    url,
                    headers={"Content-Type": "application/json", "x-goog-api-key": str(api_key)},
                    content=js_json_bytes(body),
                )
            except httpx.TimeoutException as error:
                raise RuntimeError(
                    f"Gemini product profile normalization timed out after {timeout_label_seconds(self.timeout_seconds)}s."
                ) from error
        if response.status_code >= 400:
            raise RuntimeError(f"Gemini product profile normalization failed: {response.status_code}")
        payload = as_mapping(response.json())
        candidates = (as_list(payload.get("candidates")) or []) if payload is not None else []
        first_candidate = as_mapping(candidates[0]) if candidates else None
        content = as_mapping(first_candidate.get("content")) if first_candidate is not None else None
        parts = (as_list(content.get("parts")) or []) if content is not None else []
        raw = "\n".join(
            str(part_mapping.get("text") or "")
            for part in parts
            if (part_mapping := as_mapping(part)) is not None
        )
        return _normalization_result(
            raw, _gemini_usage(payload.get("usageMetadata") if payload is not None else None)
        )

    async def _normalize_azure(self, prompt: Mapping[str, str]) -> dict[str, Any]:
        api_key, endpoint = self.config.get("apiKey"), self.config.get("endpoint")
        deployment = self.config.get("deployment")
        if not api_key or not endpoint or not deployment:
            raise ValueError(
                "AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT, and AZURE_OPENAI_DEPLOYMENT are required for product profile normalization."
            )
        api_version = _nullish(self.config.get("apiVersion"), "2025-04-01-preview")
        url = (
            f"{str(endpoint).removesuffix('/')}/openai/deployments/{deployment}/chat/completions?api-version={api_version}"
        )
        headers = {"Content-Type": "application/json", "api-key": str(api_key)}
        body: dict[str, Any] = {
            "messages": [{"role": "system", "content": prompt["system"]}, {"role": "user", "content": prompt["user"]}]
        }
        body.update(temperature_body(self.config.get("temperature")))
        async with httpx.AsyncClient(
            transport=self.config.get("transport"), timeout=self.timeout_seconds, follow_redirects=True
        ) as client:
            try:
                response = await client.post(url, headers=headers, content=js_json_bytes(body))
            except httpx.TimeoutException as error:
                raise RuntimeError(
                    f"Azure product profile normalization timed out after {timeout_label_seconds(self.timeout_seconds)}s."
                ) from error
        if response.status_code >= 400:
            raise RuntimeError(f"Azure product profile normalization failed: {response.status_code}")
        payload = as_mapping(response.json())
        choices = (as_list(payload.get("choices")) or []) if payload is not None else []
        first_choice = as_mapping(choices[0]) if choices else None
        message = as_mapping(first_choice.get("message")) if first_choice is not None else None
        raw = (
            str(message.get("content") or "")
            if message is not None
            else ""
        )
        return _normalization_result(raw, _chat_usage(payload.get("usage") if payload is not None else None))

    async def _normalize_aistudio(self, prompt: Mapping[str, str]) -> dict[str, Any]:
        api_key, endpoint, deployment = self.config.get("apiKey"), self.config.get("endpoint"), self.config.get("deployment")
        if not api_key or not endpoint or not deployment:
            raise ValueError(
                "AI Studio API key, endpoint, and deployment are required for product profile normalization."
            )
        provider = AistudioProvider(
            api_key=api_key,
            endpoint=endpoint,
            deployment=deployment,
            api_version=self.config.get("apiVersion"),
            temperature=self.config.get("temperature"),
            transport=self.config.get("transport"),
            timeout_seconds=self.timeout_seconds,
        )
        body = {
            "messages": [
                {"role": "system", "content": prompt["system"]},
                {"role": "user", "content": prompt["user"]},
            ],
            **temperature_body(self.config.get("temperature")),
        }
        async with httpx.AsyncClient(
            transport=self.config.get("transport"), timeout=self.timeout_seconds, follow_redirects=True
        ) as client:
            try:
                payload = await client.post(
                    provider.chat_completions_url(deployment),
                    headers={"Content-Type": "application/json", **provider.auth_headers()},
                    content=js_json_bytes(body),
                )
            except httpx.TimeoutException as error:
                raise RuntimeError(
                    f"AI Studio product profile normalization timed out after {timeout_label_seconds(self.timeout_seconds)}s."
                ) from error
        if payload.status_code >= 400:
            raise RuntimeError(f"AI Studio product profile normalization failed: {payload.status_code}")
        response = as_mapping(payload.json())
        choices = (as_list(response.get("choices")) or []) if response is not None else []
        first_choice = as_mapping(choices[0]) if choices else None
        message = as_mapping(first_choice.get("message")) if first_choice is not None else None
        raw = str(message.get("content") or "") if message is not None else ""
        return _normalization_result(raw, _chat_usage(response.get("usage") if response is not None else None))


def _rag_policy(request: Mapping[str, Any]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    analysis_prompt = request.get("analysisPrompt")
    if isinstance(analysis_prompt, str) and analysis_prompt:
        output.append({"name": "analysis-prompt", "content": _utf16_prefix(analysis_prompt, 2400)})
    documents = as_list(request.get("ragDocuments"))
    if documents is not None:
        for document in documents:
            document_mapping = as_mapping(document)
            if document_mapping is None:
                continue
            output.append(
                {
                    "name": str(document_mapping.get("name") or ""),
                    "version": document_mapping.get("version"),
                    "content": _utf16_prefix(str(document_mapping.get("content") or ""), 2400),
                }
            )
    return output


def _trim_json_for_prompt(value: Any, maximum: int) -> Any:
    safe = _json_value(value)
    text = js_json_pretty_dumps(safe)
    return safe if _utf16_length(text) <= maximum else {"truncated": True, "text": _utf16_prefix(text, maximum)}


def _utf16_length(value: str) -> int:
    return len(value.encode("utf-16-le", "surrogatepass")) // 2


def _utf16_prefix(value: str, maximum: int) -> str:
    """Mirror JavaScript ``String#slice(0, maximum)`` code-unit semantics."""

    if maximum <= 0:
        return ""
    encoded = value.encode("utf-16-le", "surrogatepass")[: maximum * 2]
    # Python normally refuses an unpaired unit whereas JS ``slice`` exposes
    # one.  ``create_product_profile_normalization_prompt`` escapes it back
    # into well-formed JSON via UTF-8 ``backslashreplace`` at the boundary.
    return encoded.decode("utf-16-le", "surrogatepass")


def _json_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    items = as_list(value)
    if items is not None:
        return [_json_value(item) for item in items[:80]]
    mapping = as_mapping(value)
    if mapping is not None:
        return {str(key): _json_value(item) for key, item in list(mapping.items())[:200]}
    return str(value) if value is not None else ""


def _apply_source_backed_profile(
    bootstrap: Mapping[str, Any], incoming: Any, raw_source: Any
) -> tuple[dict[str, Any], list[dict[str, str]], list[str]]:
    product = deepcopy(dict(bootstrap))
    incoming_mapping = as_mapping(incoming)
    if incoming_mapping is None:
        return product, [], []
    corpus = _source_corpus(raw_source, bootstrap)
    identity_sources = _identity_source_values(raw_source, bootstrap)
    source_faq_pairs = _source_faq_pairs(raw_source, bootstrap)
    evidence: list[dict[str, str]] = []
    warnings: list[str] = []
    for field in _PROFILE_STRING_FIELDS:
        if field not in incoming_mapping:
            continue
        accepted = (
            _source_backed_identity(incoming_mapping.get(field), identity_sources)
            if field == "name"
            else _source_backed_string(incoming_mapping.get(field), corpus)
        )
        if accepted:
            if product.get(field) != accepted:
                product[field] = accepted
                evidence.append(
                    {
                        "field": f"product.{field}",
                        "source": "llm",
                        "value": "Accepted source-backed model normalization.",
                    }
                )
        elif isinstance(incoming_mapping.get(field), str) and str(incoming_mapping[field]).strip():
            warnings.append(f"Model {field} normalization was rejected because it was not source-backed.")
    for field in _PROFILE_ARRAY_FIELDS:
        value = as_list(incoming_mapping.get(field))
        if value is None:
            continue
        source_backed = _unique(
            [
                candidate
                for item in value
                if (
                    candidate := _source_backed_string(
                        item,
                        corpus,
                        allow_url_like=field == "images",
                        allow_short_overlap=field == "metrics",
                    )
                )
            ]
        )
        accepted = (
            [candidate for candidate in source_backed if _is_role_coherent_product_outcome(candidate)]
            if field in {"benefits", "effects"}
            else source_backed
        )
        if accepted:
            if product.get(field) != accepted:
                product[field] = accepted
                evidence.append(
                    {
                        "field": f"product.{field}",
                        "source": "llm",
                        "value": "Accepted source-backed model normalization.",
                    }
                )
        elif value:
            if source_backed and field in {"benefits", "effects"}:
                warnings.append(
                    f"Model {field} normalization was rejected because source-backed values did not match product-evidence roles."
                )
            else:
                warnings.append(f"Model {field} normalization was rejected because no values were source-backed.")
    faq_items = as_list(incoming_mapping.get("faq"))
    if faq_items is not None:
        faq: list[dict[str, str]] = []
        for item in faq_items:
            item_mapping = as_mapping(item)
            if item_mapping is None:
                continue
            accepted_pair = _source_backed_faq_pair(
                item_mapping.get("question"), item_mapping.get("answer"), source_faq_pairs
            )
            if accepted_pair is not None:
                question, answer = accepted_pair
                faq.append({"question": question, "answer": answer})
        if faq:
            product["faq"] = _unique_mappings(faq, ("question", "answer"))[:12]
            evidence.append(
                {"field": "product.faq", "source": "llm", "value": "Accepted source-backed model normalization."}
            )
        elif faq_items:
            warnings.append(
                "Model FAQ normalization was rejected because question/answer evidence was not source-backed."
            )
    content_sections = as_list(incoming_mapping.get("contentSections"))
    if content_sections is not None:
        accepted_sections: list[dict[str, Any]] = []
        for item in content_sections:
            item_mapping = as_mapping(item)
            if item_mapping is None:
                continue
            title = _source_backed_string(item_mapping.get("title"), corpus) or _clean_string(item_mapping.get("title"))
            text = _source_backed_string(item_mapping.get("text"), corpus)
            category_value = _clean_string(item_mapping.get("category"))
            category = category_value if category_value in _PROFILE_CONTENT_CATEGORIES else "unknown"
            bullets = as_list(item_mapping.get("bullets"))
            accepted_bullets = _unique(
                [candidate for value in bullets or [] if (candidate := _source_backed_string(value, corpus))]
            )
            if title and text:
                accepted_sections.append(
                    {"title": title, "category": category, "text": text, "bullets": accepted_bullets}
                )
        if accepted_sections:
            product["contentSections"] = _unique_mappings(accepted_sections, ("category", "title", "text"))[:24]
            evidence.append(
                {
                    "field": "product.contentSections",
                    "source": "llm",
                    "value": "Accepted source-backed model normalization.",
                }
            )
        elif content_sections:
            warnings.append("Model contentSections normalization was rejected because section text evidence was not source-backed.")
    return product, evidence, warnings


def _source_corpus(raw_source: Any, bootstrap: Mapping[str, Any]) -> str:
    return "\n".join(_flatten_text(raw_source) + _flatten_text(bootstrap))


def _identity_source_values(raw_source: Any, bootstrap: Mapping[str, Any]) -> list[str]:
    """Return source-declared identity values, never a fuzzy page-wide token bag."""

    values = [
        _clean_string(bootstrap.get("name")),
        _clean_string(bootstrap.get("originalName")),
        *_identity_values_from_source(raw_source, isinstance(raw_source, str)),
    ]
    return _unique([value for value in values if value])


def _identity_values_from_source(value: Any, identity_context: bool = False) -> list[str]:
    if isinstance(value, str):
        return [value] if identity_context and value.strip() else []
    mapping = as_mapping(value)
    if mapping is not None:
        return [
            identity
            for key, child in mapping.items()
            for identity in _identity_values_from_source(
                child, identity_context or _is_identity_source_key(str(key))
            )
        ]
    values = as_list(value)
    if values is not None:
        return [identity for child in values for identity in _identity_values_from_source(child, identity_context)]
    return []


def _is_identity_source_key(value: str) -> bool:
    normalized = _normalize_evidence(value).replace(" ", "")
    return (
        bool(normalized)
        and "category" not in normalized
        and "type" not in normalized
        and (normalized == "displaylabel" or normalized.endswith(("name", "title", "sku", "variant")))
    )


def _source_backed_identity(value: Any, sources: Sequence[str]) -> str | None:
    text = _clean_string(value)
    normalized_text = _normalize_evidence(text or "")
    if not text or not normalized_text:
        return None
    return text if any(_normalize_evidence(source) == normalized_text for source in sources) else None


def _source_faq_pairs(raw_source: Any, bootstrap: Mapping[str, Any]) -> list[tuple[str, str]]:
    return [*_faq_pairs_from_source(raw_source), *_faq_pairs_from_source(bootstrap)]


def _faq_pairs_from_source(value: Any) -> list[tuple[str, str]]:
    mapping = as_mapping(value)
    if mapping is not None:
        question = _clean_string(mapping.get("question"))
        answer = _clean_string(mapping.get("answer"))
        accepted_answer = as_mapping(mapping.get("acceptedAnswer"))
        if answer is None and accepted_answer is not None:
            question = question or _clean_string(mapping.get("name"))
            answer = _clean_string(accepted_answer.get("text"))
        direct = [(question, answer)] if question and answer else []
        return [*direct, *[pair for child in mapping.values() for pair in _faq_pairs_from_source(child)]]
    values = as_list(value)
    return [pair for child in values or [] for pair in _faq_pairs_from_source(child)]


def _source_backed_faq_pair(
    question: Any, answer: Any, source_pairs: Sequence[tuple[str, str]]
) -> tuple[str, str] | None:
    cleaned_question, cleaned_answer = _clean_string(question), _clean_string(answer)
    if not cleaned_question or not cleaned_answer:
        return None
    normalized_pair = (_normalize_evidence(cleaned_question), _normalize_evidence(cleaned_answer))
    return (
        (cleaned_question, cleaned_answer)
        if any((_normalize_evidence(source_question), _normalize_evidence(source_answer)) == normalized_pair for source_question, source_answer in source_pairs)
        else None
    )


def _flatten_text(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value] if value.strip() else []
    if isinstance(value, (int, float, bool)):
        return [str(value)]
    items = as_list(value)
    if items is not None:
        return [item for child in items for item in _flatten_text(child)]
    mapping = as_mapping(value)
    if mapping is not None:
        return [item for child in mapping.values() for item in _flatten_text(child)]
    return []


def _source_backed_string(
    value: Any, corpus: str, *, allow_url_like: bool = False, allow_short_overlap: bool = False
) -> str | None:
    text = _clean_string(value) or ""
    if not text:
        return None
    if allow_url_like and re.match(r"https?://", text, re.IGNORECASE):
        return text
    normalized_corpus, normalized_text = _normalize_evidence(corpus), _normalize_evidence(text)
    if normalized_text and normalized_text in normalized_corpus:
        return text
    tokens = [token for token in normalized_text.split() if len(token) >= 2]
    corpus_tokens = set(_normalize_evidence(corpus).split())
    if (
        # JavaScript's ``String#length`` measures UTF-16 code units.  This
        # threshold is part of the source-backed acceptance boundary, so a
        # non-BMP character must count as two units here as it does in TS.
        (allow_short_overlap or _utf16_length(text) >= 12)
        and tokens
        and sum(token in corpus_tokens for token in tokens) / len(tokens) >= 0.66
    ):
        return text
    return None


def _is_role_coherent_product_outcome(value: str) -> bool:
    """Reject source-backed page chrome before a model can route it into efficacy fields.

    The normalizer intentionally keeps category-agnostic outcomes such as
    ``Supports hair softness``.  The boundary is therefore contextual rather
    than a skin-care dictionary: commerce, customer commentary, procedures,
    and safety instructions stay source evidence/diagnostics, not benefits or
    effects.
    """

    text = _clean_string(value) or ""
    if not text:
        return False
    return not bool(
        re.search(
            r"\b(?:cart|checkout|coupon|shipping|delivery|ships?|exchange|returns?|refund|purchase|buy\s+now|"
            r"price|discount|offer)\b|"
            r"\b(?:customers?|buyers?|purchasers?)\s+(?:say|said|report(?:s|ed)?|love(?:s|d)?)\b|"
            r"\b(?:review|reviews|rating|rated|stars?)\b|"
            r"\b(?:apply|dispense|massage|rinse|lather|spray|use)\b|\b(?:daily|morning|evening|nightly)\b|"
            r"\b(?:patch\s*test|avoid\s+use|do\s+not\s+use|not\s+(?:recommended|suitable|intended)|"
            r"for\s+external\s+use\s+only)\b|"
            r"(?:장바구니|쿠폰|배송|교환|반품|환불|구매|고객\s*리뷰|구매\s*후기|리뷰|후기|평점|"
            r"적당량|덜어|바르|문지르|사용\s*(?:후|시|하면|법)|패치\s*테스트|사용\s*전\s*테스트|"
            r"사용(?:할)?\s*수\s*없|권장하지)",
            text,
            re.I,
        )
    )


def _clean_string(value: object) -> str | None:
    """Match the TS ``cleanString`` whitespace normalization at public boundaries."""

    if not isinstance(value, str):
        return None
    cleaned = re.sub(r"\s+", " ", value).strip()
    return cleaned or None


def _normalize_evidence(value: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w]+", " ", normalize("NFKC", value).casefold())).strip()


def _normalization_result(raw: str, usage: dict[str, int] | None) -> dict[str, Any]:
    """Port ``parseProductProfileNormalizationJson`` without discarding rawText."""

    json_text = _normalization_json_text(raw)
    if not json_text:
        result: dict[str, Any] = {"warnings": ["No parseable product profile normalization JSON returned."], "rawText": raw}
    else:
        try:
            parsed = as_mapping(json.loads(json_text))
        except json.JSONDecodeError:
            parsed = None
            result = {"warnings": ["Product profile normalization JSON could not be parsed."], "rawText": raw}
        else:
            if parsed is None:
                result = {"warnings": [], "rawText": raw}
            else:
                product = as_mapping(parsed.get("product"))
                result = {"warnings": _warnings(parsed.get("warnings")), "rawText": raw}
                if product is not None:
                    result["product"] = dict(product)
    if usage:
        result["usage"] = usage
    return result


def _normalization_json_text(raw: str) -> str | None:
    """Extract a direct/provider-enveloped JSON object exactly like the TS parser."""

    trimmed = raw.strip()
    if not trimmed:
        return None
    try:
        payload = as_mapping(json.loads(trimmed))
        if payload is not None:
            output_text = payload.get("output_text")
            if isinstance(output_text, str):
                return output_text
            output = as_list(payload.get("output")) or []
            texts: list[str] = []
            for item in output:
                item_mapping = as_mapping(item)
                if item_mapping is None or "content" not in item_mapping:
                    continue
                contents = as_list(item_mapping.get("content"))
                for content in contents if contents is not None else [item_mapping.get("content")]:
                    content_mapping = as_mapping(content)
                    if content_mapping is None or "text" not in content_mapping:
                        texts.append("")
                    else:
                        value = content_mapping.get("text")
                        texts.append("" if value is None else str(value))
            text = "\n".join(texts)
            if text.strip():
                return text
    except json.JSONDecodeError:
        # A direct model response can be prose plus a braced JSON object.
        pass
    matched = re.search(r"\{[\s\S]*\}", trimmed)
    return matched.group(0) if matched is not None else None


def _openai_usage(value: Any) -> dict[str, int] | None:
    return _usage(
        value,
        (
            ("inputTokens", "input_tokens", "prompt_tokens"),
            ("outputTokens", "output_tokens", "completion_tokens"),
            ("totalTokens", "total_tokens"),
        ),
    )


def _gemini_usage(value: Any) -> dict[str, int] | None:
    return _usage(
        value,
        (
            ("inputTokens", "promptTokenCount"),
            ("outputTokens", "candidatesTokenCount"),
            ("totalTokens", "totalTokenCount"),
        ),
    )


def _chat_usage(value: Any) -> dict[str, int] | None:
    result = _usage(
        value,
        (
            ("inputTokens", "prompt_tokens", "input_tokens"),
            ("outputTokens", "completion_tokens", "output_tokens"),
            ("totalTokens", "total_tokens"),
        ),
    )
    if result and "totalTokens" not in result:
        result["totalTokens"] = result.get("inputTokens", 0) + result.get("outputTokens", 0)
    return result


def _usage(value: Any, fields: tuple[tuple[str, ...], ...]) -> dict[str, int] | None:
    mapping = as_mapping(value)
    if mapping is None:
        return None
    result: dict[str, int] = {}
    for output, *names in fields:
        number = next(
            (
                mapping.get(name)
                for name in names
                if isinstance(mapping.get(name), int) and not isinstance(mapping.get(name), bool)
            ),
            None,
        )
        if isinstance(number, int):
            result[output] = number
    return result or None


def _nullish(*values: object) -> object:
    """Return the first non-``None`` value (the JavaScript ``??`` operator)."""

    return next((value for value in values if value is not None), None)


def _positive_or_zero_int(value: object, fallback: int) -> int:
    """Keep explicit zero while retaining a safe compatibility fallback."""

    try:
        # This is an intentionally permissive public JSON/configuration
        # boundary.  The cast preserves TS ``Number``-style coercion without
        # spreading an untyped value beyond the one conversion point.
        return int(cast(Any, value))
    except (TypeError, ValueError, OverflowError):
        return fallback


def _warnings(value: Any) -> list[str]:
    items = as_list(value)
    return [cleaned for item in items or [] if (cleaned := _clean_string(item))]


def _changed_fields(evidence: Sequence[Mapping[str, str]]) -> list[str]:
    return [item["field"].removeprefix("product.") for item in evidence if item["field"].startswith("product.")]


def _unique(values: list[str]) -> list[str]:
    return list(dict.fromkeys(values))


def _unique_mappings(values: list[dict[str, str]], keys: tuple[str, ...]) -> list[dict[str, str]]:
    output: list[dict[str, str]] = []
    seen: set[tuple[str, ...]] = set()
    for value in values:
        key = tuple(value[item] for item in keys)
        if key not in seen:
            seen.add(key)
            output.append(value)
    return output


# Camel-case aliases match the legacy public surface.
normalizeExtractorProductProfileWithAgent = normalize_extractor_product_profile_with_agent
createProductProfileNormalizationPrompt = create_product_profile_normalization_prompt
