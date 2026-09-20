"""Optional review-keyword typo normalization with conservative correction gates."""

from __future__ import annotations

import inspect
import math
import re
from collections.abc import Mapping, Sequence
from typing import Any, TypedDict

from neo_js_compat import js_json_pretty_dumps

from ._json import as_dict, as_list, clean_text

_DEFAULT_CONFIDENCE_THRESHOLD = 0.78
_DEFAULT_MAX_KEYWORDS = 16


class _KeywordNormalizationPrompt(TypedDict):
    system: str
    user: str


_KEYWORD_NORMALIZATION_SYSTEM_PROMPT = "\n".join(
    (
        "You are a conservative typo-normalization agent for product review keywords.",
        'Return strict JSON only: {"corrections":[{"original":"","normalized":"","confidence":0.0,"reason":""}],"warnings":[]}.',
        "Only correct obvious typos, OCR mistakes, keyboard-adjacent mistakes, or spacing mistakes in the original keyword language.",
        "Do not translate, expand, summarize, add new claims, add new benefits, or rewrite a keyword into marketing copy.",
        "If uncertain, omit the correction. Keep normalized keywords concise and source-backed.",
    )
)


async def normalize_product_review_keywords(
    product: Mapping[str, Any], locale: str, market: str | None, options: Mapping[str, Any] | None = None
) -> dict[str, Any]:
    """Normalize only high-confidence spelling-level review keyword corrections."""

    runtime = as_dict(options)
    evidence: list[dict[str, str]] = []
    warnings: list[str] = []
    normalized_product = _clone_product(product)
    normalizer, resolution_warning = _resolve_keyword_normalizer(runtime)
    settings = as_dict(runtime.get("keywordNormalization"))
    if normalizer is None:
        if settings.get("enabled") is True and resolution_warning:
            warnings.append(resolution_warning)
            evidence.append({"field": "reviews.keywords", "source": "llm", "value": resolution_warning})
        return {"product": normalized_product, "evidence": evidence, "warnings": warnings, "called": False, "applied": False}

    request = _create_request(normalized_product, locale, market, settings)
    if not request["reviewKeywords"]:
        return {"product": normalized_product, "evidence": evidence, "warnings": warnings, "called": False, "applied": False}
    try:
        result = await _call_keyword_normalizer(normalizer, request)
        accepted = select_safe_keyword_corrections(
            request["reviewKeywords"],
            [as_dict(item) for item in as_list(result.get("corrections"))],
            locale,
            _finite_number(settings.get("confidenceThreshold"), _DEFAULT_CONFIDENCE_THRESHOLD),
        )
        if accepted:
            normalized_product = _apply_corrections(normalized_product, accepted)
            evidence.append(
                {
                    "field": "reviews.keywords",
                    "source": "llm",
                    "value": "Accepted model-backed keyword corrections: "
                    + ", ".join(f"{item['original']} -> {item['normalized']}" for item in accepted),
                }
            )
        warnings.extend(clean_text(item) for item in as_list(result.get("warnings")) if clean_text(item))
        evidence.extend({"field": "reviews.keywords", "source": "llm", "value": warning} for warning in warnings)
        return {
            "product": normalized_product,
            "evidence": evidence,
            "warnings": _unique(warnings),
            "called": True,
            "applied": bool(accepted),
            **({"usage": result["usage"]} if result.get("usage") is not None else {}),
        }
    except Exception as error:  # a keyword typo model must never make generation fail
        message = str(error) or "Keyword normalization provider failed."
        warnings.append(message)
        evidence.append(
            {"field": "reviews.keywords", "source": "llm", "value": f"Keyword normalization skipped: {message}"}
        )
        return {"product": normalized_product, "evidence": evidence, "warnings": warnings, "called": True, "applied": False}


class ModelBackedKeywordNormalizer:
    """Provider-neutral bridge for the optional keyword-normalization stage."""

    def __init__(self, config: Mapping[str, Any]) -> None:
        self.config = dict(config)

    async def normalize_keywords(self, request: Mapping[str, Any]) -> Mapping[str, Any]:
        provider_name = clean_text(self.config.get("provider"))
        if provider_name in {"aistudio", "custom", "mock"}:
            return {
                "corrections": [],
                "warnings": [f"{provider_name} keyword normalization provider has no model-backed adapter."],
            }
        from .providers import create_provider

        provider = create_provider(self.config)
        prompt = create_keyword_normalization_prompt(request)
        return await provider.generate_json(
            stage="keyword-normalization",
            system=prompt["system"],
            user=prompt["user"],
        )

    async def normalizeKeywords(self, request: Mapping[str, Any]) -> Mapping[str, Any]:
        return await self.normalize_keywords(request)


def create_keyword_normalization_prompt(request: Mapping[str, Any]) -> _KeywordNormalizationPrompt:
    """Build the source-selected conservative keyword-normalization prompt."""

    context: dict[str, Any] = {
        field: request[field]
        for field in ("reviewBodies", "benefits", "effects", "sourceTexts")
        if field in request
    }
    payload: dict[str, Any] = {
        "task": "Normalize only misspelled review keywords. Leave valid keywords unchanged by omitting them from corrections.",
        **{field: request[field] for field in ("productName", "locale", "market", "reviewKeywords") if field in request},
        "context": context,
    }
    return {
        "system": _KEYWORD_NORMALIZATION_SYSTEM_PROMPT,
        "user": js_json_pretty_dumps(payload),
    }


PDP_GEO_KEYWORD_NORMALIZATION_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "corrections": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "original": {"type": "string"},
                    "normalized": {"type": "string"},
                    "confidence": {"type": "number"},
                    "reason": {"type": "string"},
                },
            },
        },
        "warnings": {"type": "array", "items": {"type": "string"}},
    },
}


def select_safe_keyword_corrections(
    source_keywords: Sequence[str], corrections: Sequence[Mapping[str, Any]], locale: str, confidence_threshold: float
) -> list[dict[str, Any]]:
    source = {_key(value): value for value in source_keywords if _clean_keyword(value)}
    accepted: list[dict[str, Any]] = []
    for correction in corrections:
        original = source.get(_key(clean_text(correction.get("original"))))
        normalized = _clean_keyword(clean_text(correction.get("normalized")))
        confidence = _finite_number(correction.get("confidence"), -1)
        if not original or not normalized or confidence < confidence_threshold:
            continue
        if _key(original) == _key(normalized) or not _is_safe_correction(original, normalized, locale):
            continue
        accepted.append(
            {
                "original": original,
                "normalized": normalized,
                "confidence": confidence,
                **({"reason": clean_text(correction.get("reason"))} if clean_text(correction.get("reason")) else {}),
            }
        )
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for correction in accepted:
        key = f"{_key(correction['original'])}:{_key(correction['normalized'])}"
        if key not in seen:
            seen.add(key)
            result.append(correction)
    return result


async def _call_keyword_normalizer(normalizer: object, request: Mapping[str, Any]) -> dict[str, Any]:
    method = getattr(normalizer, "normalize_keywords", None) or getattr(normalizer, "normalizeKeywords", None)
    if not callable(method):
        raise TypeError(
            "customKeywordNormalizer must provide normalize_keywords(request) or normalizeKeywords(request)."
        )
    result = method(dict(request))
    if inspect.isawaitable(result):
        result = await result
    return as_dict(result)


def _resolve_keyword_normalizer(runtime: Mapping[str, Any]) -> tuple[object | None, str | None]:
    custom = runtime.get("customKeywordNormalizer")
    if custom is not None:
        return custom, None
    settings = as_dict(runtime.get("keywordNormalization"))
    if settings.get("enabled") is not True:
        return None, None
    provider = clean_text(settings.get("provider") or runtime.get("provider") or "mock")
    if provider in {"mock", "custom"}:
        return None, f"{provider} keyword normalization requires customKeywordNormalizer."
    # The retained implementation has no AI Studio keyword adapter.  Keep this
    # explicit rather than silently posting a chat-completions request under a
    # stage that TypeScript would report as unavailable.
    if provider == "aistudio":
        return None, "aistudio keyword normalization provider has no model-backed adapter."
    inherits = not settings.get("provider") or settings.get("provider") == runtime.get("provider")
    return (
        ModelBackedKeywordNormalizer(
            {
                "provider": provider,
                "apiKey": settings.get("apiKey") or (runtime.get("apiKey") if inherits else None),
                "model": settings.get("model") or (runtime.get("model") if inherits else None),
                "endpoint": settings.get("endpoint") or (runtime.get("endpoint") if inherits else None),
                "deployment": settings.get("deployment") or (runtime.get("deployment") if inherits else None),
                "apiVersion": settings.get("apiVersion") or (runtime.get("apiVersion") if inherits else None),
                "temperature": runtime.get("temperature"),
            }
        ),
        None,
    )


def _create_request(
    product: Mapping[str, Any], locale: str, market: str | None, settings: Mapping[str, Any]
) -> dict[str, Any]:
    reviews = as_dict(product.get("reviews"))
    max_keywords = max(0, _integer(settings.get("maxKeywords"), _DEFAULT_MAX_KEYWORDS))
    return {
        "productName": clean_text(product.get("name")),
        "locale": locale,
        **({"market": market} if market else {}),
        "reviewKeywords": _unique(clean_text(item) for item in as_list(reviews.get("keywords")))[:max_keywords],
        "reviewBodies": _unique(clean_text(as_dict(item).get("body")) for item in as_list(reviews.get("items")))[:6],
        "benefits": _unique(clean_text(item) for item in as_list(product.get("benefits")))[:8],
        "effects": _unique(clean_text(item) for item in as_list(product.get("effects")))[:8],
        "sourceTexts": _unique(clean_text(item) for item in as_list(product.get("sourceTexts")))[:10],
    }


def _apply_corrections(product: Mapping[str, Any], corrections: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    result = dict(product)
    reviews = dict(as_dict(product.get("reviews")))
    changes = {_key(clean_text(item.get("original"))): clean_text(item.get("normalized")) for item in corrections}
    reviews["keywords"] = _unique(
        changes.get(_key(clean_text(keyword)), clean_text(keyword)) for keyword in as_list(reviews.get("keywords"))
    )
    result["reviews"] = reviews
    return result


def _is_safe_correction(original: str, normalized: str, locale: str) -> bool:
    if (
        len(normalized) < 2
        or len(normalized) > 32
        or re.search(r"[,/|;:()[\]{}<>]", normalized)
        or re.search(r"https?://", normalized, re.I)
        or len(normalized.split()) > 4
        or _mixed_language_expansion(original, normalized)
    ):
        return False
    source, target = _fingerprint(original), _fingerprint(normalized)
    return _levenshtein(source, target) <= _distance_limit(original, normalized, locale)


def _distance_limit(original: str, normalized: str, locale: str) -> int:
    length = max(len(_fingerprint(original)), len(_fingerprint(normalized)))
    if locale == "ko-KR" or re.search(r"[가-힣]", f"{original}{normalized}"):
        return 2 if length <= 4 else max(2, int(length * 0.35))
    return 2 if length <= 8 else max(2, int(length * 0.25))


def _mixed_language_expansion(original: str, normalized: str) -> bool:
    source_korean, target_korean = bool(re.search(r"[가-힣]", original)), bool(re.search(r"[가-힣]", normalized))
    source_latin, target_latin = bool(re.search(r"[A-Za-z]", original)), bool(re.search(r"[A-Za-z]", normalized))
    return (source_korean and target_latin and not source_latin) or (
        source_latin and target_korean and not source_korean
    )


def _fingerprint(value: str) -> str:
    return re.sub(r"[^a-z0-9가-힣ぁ-んァ-ン一-龯]+", "", _clean_keyword(value).casefold())


def _key(value: str) -> str:
    return _clean_keyword(value).casefold()


def _clean_keyword(value: str) -> str:
    return re.sub(r"\s+([,.!?。！？])", r"\1", re.sub(r"\s+", " ", value)).strip()


def _levenshtein(left: str, right: str) -> int:
    if left == right:
        return 0
    if not left:
        return len(right)
    if not right:
        return len(left)
    previous = list(range(len(right) + 1))
    for left_index, left_character in enumerate(left, 1):
        current = [left_index]
        for right_index, right_character in enumerate(right, 1):
            current.append(
                min(
                    current[-1] + 1,
                    previous[right_index] + 1,
                    previous[right_index - 1] + (left_character != right_character),
                )
            )
        previous = current
    return previous[-1]


def _clone_product(product: Mapping[str, Any]) -> dict[str, Any]:
    result = dict(product)
    if isinstance(result.get("reviews"), Mapping):
        reviews = dict(as_dict(result["reviews"]))
        reviews["keywords"] = list(as_list(reviews.get("keywords")))
        reviews["items"] = [dict(as_dict(item)) for item in as_list(reviews.get("items"))]
        result["reviews"] = reviews
    return result


def _finite_number(value: object, default: float) -> float:
    if isinstance(value, bool):
        return default
    if isinstance(value, int | float | str):
        try:
            number = float(value)
        except ValueError:
            return default
        return number if math.isfinite(number) else default
    return default


def _integer(value: object, default: int) -> int:
    return int(value) if isinstance(value, int | float) and not isinstance(value, bool) else default


def _unique(values: Sequence[str] | Any) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for raw in values:
        value = _clean_keyword(clean_text(raw))
        if value and value.casefold() not in seen:
            seen.add(value.casefold())
            result.append(value)
    return result


normalizeProductReviewKeywords = normalize_product_review_keywords
selectSafeKeywordCorrections = select_safe_keyword_corrections

__all__ = [
    "ModelBackedKeywordNormalizer",
    "PDP_GEO_KEYWORD_NORMALIZATION_JSON_SCHEMA",
    "normalize_product_review_keywords",
    "normalizeProductReviewKeywords",
    "select_safe_keyword_corrections",
    "selectSafeKeywordCorrections",
]
