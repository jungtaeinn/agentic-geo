"""Review-derived Category Entry Point (CEP) situation extraction.

The recognizers intentionally use grammatical context markers instead of a
fixed vocabulary of life situations.  That lets unseen contexts such as a
night shift or a newborn appear in CEP planning while keeping sensory wording
out of public FAQ prompts.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import Final, TypeGuard, cast

from .review_sentiment import is_negative_review_signal_text, is_positive_review_item

_ENGLISH_MARKERS: Final[tuple[re.Pattern[str], ...]] = (
    re.compile(
        r"\bwith\s+(?:my|our)\s+([a-z][a-z\s]{2,28}?)(?=\s+(?:and|but|so|because|which|that|when)\b|[,.;]|$)",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:when|while|after|before|during)\s+([a-z][a-z\s]{2,28}?)(?=\s+(?:and|but|so|because|which|that)\b|[,.;]|$)",
        re.IGNORECASE,
    ),
    re.compile(r"\b(?:as|for)\s+(?:a\s+)?(gift|present|[a-z]+\s+gift)\b", re.IGNORECASE),
    re.compile(
        r"\bfor\s+(?:my|our)\s+([a-z][a-z\s]{2,28}?)(?=\s+(?:and|but|so|because|which|that|when)\b|[,.;]|$)",
        re.IGNORECASE,
    ),
)
_KOREAN_MARKERS: Final[tuple[re.Pattern[str], ...]] = (
    re.compile(r"([가-힣A-Za-z0-9]{1,12})(?:과|와|랑|이랑)\s*(?:함께|같이)"),
    re.compile(r"([가-힣A-Za-z0-9]{2,10})\s*(?:다\s*)?같이\s*(?:쓰|사용|바르|발라)"),
    re.compile(r"([가-힣A-Za-z0-9]{1,12})(?:에게|께)(?=\s|$)"),
    re.compile(r"([가-힣A-Za-z0-9]{1,12})\s*용으로"),
    re.compile(r"([가-힣A-Za-z0-9]{1,10}?)(?:할|하는|일|인|았을|었을|였을)?\s*때"),
    re.compile(r"([가-힣A-Za-z0-9]{1,12})\s*(?:전|후|중)(?:에|에는)?(?=\s|$)"),
    re.compile(r"([가-힣A-Za-z0-9]{1,10})에(?:는)?\s*(?:쓰|사용|바르|발라)"),
)
_JAPANESE_CHARS = r"\u3400-\u9fff\u3040-\u30ffA-Za-z0-9"
_JAPANESE_MARKERS: Final[tuple[re.Pattern[str], ...]] = (
    re.compile(rf"([{_JAPANESE_CHARS}]{{1,12}})(?:と|や)\s*(?:一緒に|ともに)"),
    re.compile(rf"([{_JAPANESE_CHARS}]{{1,12}})\s*用に"),
    re.compile(rf"([{_JAPANESE_CHARS}]{{1,12}})\s*(?:のとき|の時|するとき|する時)"),
    re.compile(rf"([{_JAPANESE_CHARS}]{{1,12}})\s*(?:の前|の後|前に|後に)"),
)
_MARKERS: Final[dict[str, tuple[re.Pattern[str], ...]]] = {
    "ko-KR": _KOREAN_MARKERS,
    "ja-JP": _JAPANESE_MARKERS,
    "en-US": _ENGLISH_MARKERS,
    "en-GB": _ENGLISH_MARKERS,
}
_CONTENTLESS: Final[dict[str, re.Pattern[str]]] = {
    "ko-KR": re.compile(
        r"(?:이|그|저|것|거|수|때|점|더|좀|잘|또|매우|정말|너무|진짜|계속|그냥|약간|조금|같이|함께|제|내|나|저희|우리|사용|제품|상품|하나|여러|다시|처음|번째|정도|생각|느낌|여기|거기|고객|고객님|사람|사람들|분|분들|피부|얼굴|경우|부분|단계|테스트|시험|직후|이상|이하|기준)"
    ),
    "ja-JP": re.compile(r"(?:これ|それ|あれ|もの|こと|とても|すごく|少し|また|使用|製品|商品|私|自分)"),
    "en-US": re.compile(
        r"(?:it|this|that|them|thing|things|use|using|product|skin|me|myself|day|days|time|times|bit|lot)",
        re.IGNORECASE,
    ),
    "en-GB": re.compile(
        r"(?:it|this|that|them|thing|things|use|using|product|skin|me|myself|day|days|time|times|bit|lot)",
        re.IGNORECASE,
    ),
}
_CLAUSE_SPLIT = re.compile(r"[.!?。！？\n]+|(?:[,、]\s*)")
_QUANTITY = re.compile(r"\d\s*(?:%|시간|분|초|일|주|주일|개월|년|회|번|배|층|명|mL|ml|g|kg|oz)", re.IGNORECASE)


def _is_record(value: object) -> TypeGuard[Mapping[str, object]]:
    return isinstance(value, Mapping)


def _field(value: object, key: str, default: object = None) -> object:
    if _is_record(value):
        return value.get(key, default)
    return getattr(value, key, default)


def _strings(value: object) -> list[str]:
    if not isinstance(value, Sequence) or isinstance(value, str | bytes | bytearray):
        return []
    return [item for item in cast(Sequence[object], value) if isinstance(item, str)]


def _normalize_whitespace(value: object) -> str:
    return re.sub(r"\s+", " ", value).strip() if isinstance(value, str) else ""


def _markers(locale: str) -> tuple[re.Pattern[str], ...]:
    return _MARKERS.get(locale, _ENGLISH_MARKERS)


def _contentless(locale: str) -> re.Pattern[str]:
    return _CONTENTLESS.get(locale, _CONTENTLESS["en-US"])


def _review_items(product: object) -> list[object]:
    reviews = _field(product, "reviews", {})
    return list(_as_sequence(_field(reviews, "items", [])))


def _as_sequence(value: object) -> Sequence[object]:
    return (
        cast(Sequence[object], value)
        if isinstance(value, Sequence) and not isinstance(value, str | bytes | bytearray)
        else ()
    )


def _situation_sources(product: object, origin: str) -> list[str]:
    items = _review_items(product)
    if origin == "review":
        return [_normalize_whitespace(_field(item, "body", "")) for item in items if is_positive_review_item(item)]
    review_text = [_normalize_whitespace(_field(item, "body", "")) for item in items]
    review_text = [body for body in review_text if body]
    official_source_texts = [
        text
        for text in _strings(_field(product, "sourceTexts", []))
        if (normalized := _normalize_whitespace(text))
        and not any(body in normalized or normalized in body for body in review_text)
    ]
    semantic_facts = _field(product, "semanticFacts", {})
    return [
        _normalize_whitespace(_field(product, "description", "")),
        *_strings(_field(product, "benefits", [])),
        *_strings(_field(product, "effects", [])),
        *official_source_texts,
        *_strings(_field(semantic_facts, "evidenceSentences", [])),
    ]


def _product_vocabulary(product: object) -> list[str]:
    values = [
        _field(product, "name", ""),
        _field(product, "originalName", ""),
        _field(product, "brand", ""),
        _field(product, "category", ""),
        *_strings(_field(product, "ingredients", [])),
        *_strings(_field(product, "benefits", [])),
        *_strings(_field(product, "effects", [])),
    ]
    result: list[str] = []
    for value in values:
        result.extend(token.lower() for token in re.split(r"[\s/·,]+", _normalize_whitespace(value)) if len(token) >= 2)
    return result


def _span_names_product(span: str, vocabulary: Sequence[str]) -> bool:
    normalized = span.lower()
    return any(token in normalized or normalized in token for token in vocabulary)


def _names_quantity(span: str) -> bool:
    return bool(re.match(r"\d", span) or _QUANTITY.search(span))


def _trim_situation_surface(value: str, locale: str) -> str:
    text = _normalize_whitespace(value)
    if locale == "ko-KR":
        return _normalize_whitespace(re.sub(r"\s*(?:쓰|사용|바르|발라)\S*$", "", text))
    if locale == "ja-JP":
        return _normalize_whitespace(re.sub(r"\s*(?:使|塗)\S*$", "", text))
    return text


def _situation_key(span: str, locale: str) -> str:
    base = re.sub(r"\s+", "", span.lower())
    if locale != "ko-KR":
        singular = re.sub(r"(?:es|s)$", "", base)
        chosen = singular if len(singular) >= 2 else base
        return chosen if len(chosen) >= 2 else ""
    without_plural = re.sub(r"들$", "", base)
    stem = without_plural if len(without_plural) >= 2 else base
    without_particle = re.sub(r"(?:이|가|은|는|을|를|의)$", "", stem)
    key = without_particle if len(without_particle) >= 2 else stem
    return key if len(key) >= 2 else ""


def extract_situation_signals(product: object, locale: str, origin: str) -> list[dict[str, object]]:
    """Read source-backed use/purchase contexts, grouped by normalized key."""
    vocabulary = _product_vocabulary(product)
    grouped: dict[str, tuple[dict[str, object], set[int]]] = {}
    for source_index, body in enumerate(_situation_sources(product, origin)):
        text0 = _normalize_whitespace(body)
        if not text0:
            continue
        for raw_clause in _CLAUSE_SPLIT.split(text0):
            clause = _normalize_whitespace(raw_clause)
            if len(clause) < 4:
                continue
            for marker in _markers(locale):
                for match in marker.finditer(clause):
                    span = _normalize_whitespace(match.group(1) or "")
                    if not span or _contentless(locale).fullmatch(span):
                        continue
                    if (
                        _names_quantity(span)
                        or is_negative_review_signal_text(span)
                        or _span_names_product(span, vocabulary)
                    ):
                        continue
                    key = _situation_key(span, locale)
                    if not key:
                        continue
                    existing = grouped.get(key)
                    if existing is not None:
                        existing[1].add(source_index)
                        continue
                    grouped[key] = (
                        {
                            "origin": origin,
                            "clause": clause,
                            "situation": _trim_situation_surface(match.group(0), locale),
                            "support": 0,
                            "reviewIndexes": [],
                            "key": key,
                        },
                        {source_index},
                    )
    result: list[dict[str, object]] = []
    for signal, sources in grouped.values():
        next_signal = dict(signal)
        next_signal["support"] = len(sources)
        next_signal["reviewIndexes"] = sorted(sources) if origin == "review" else []
        result.append(next_signal)
    return sorted(result, key=lambda signal: (-_support_value(signal.get("support")), str(signal.get("key", ""))))


def _support_value(value: object) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def extract_review_situation_signals(product: object, locale: str) -> list[dict[str, object]]:
    return extract_situation_signals(product, locale, "review")


def names_use_situation(text: str, locale: str) -> bool:
    """Distinguish use/purchase contexts from audience suitability wording."""
    normalized = _normalize_whitespace(text)
    contentless = _contentless(locale)
    for marker in _markers(locale):
        for match in marker.finditer(normalized):
            span = _normalize_whitespace(match.group(1) or "")
            if span and not contentless.fullmatch(span):
                return True
    return False


def _strip_non_alnum(value: str) -> str:
    start, end = 0, len(value)
    while start < end and not value[start].isalnum():
        start += 1
    while end > start and not value[end - 1].isalnum():
        end -= 1
    return value[start:end]


def _routine_vocabulary(product: object) -> list[str]:
    semantic_facts = _field(product, "semanticFacts", {})
    values = [*_strings(_field(product, "usage", [])), *_strings(_field(semantic_facts, "usageSteps", []))]
    result: list[str] = []
    for value in values:
        for token in re.split(r"[\s/·,]+", _normalize_whitespace(value)):
            cleaned = re.sub(r"(?:후|전|중|에|을|를|은|는|이|가)$", "", _strip_non_alnum(token.lower()))
            if len(cleaned) >= 2:
                result.append(cleaned)
    return result


def _input_value(input_: Mapping[str, object] | object, key: str, default: object = None) -> object:
    return _field(input_, key, default)


def derive_cep_candidates(input_: Mapping[str, object] | object) -> list[dict[str, object]]:
    """Pair an official need with source-backed product/review situations."""
    product = _input_value(input_, "product", {})
    locale_value = _input_value(input_, "locale", "en-US")
    locale = locale_value if isinstance(locale_value, str) else "en-US"
    needs = [need for need in _strings(_input_value(input_, "needs", [])) if need]
    need = _normalize_whitespace(", ".join(needs))
    if not need:
        return []
    routine_vocabulary = _routine_vocabulary(product)
    seen: set[str] = set()
    signals: list[dict[str, object]] = []
    for signal in [
        *extract_situation_signals(product, locale, "product"),
        *extract_situation_signals(product, locale, "review"),
    ]:
        key = str(signal["key"])
        if any(token in key for token in routine_vocabulary) or key in seen:
            continue
        seen.add(key)
        signals.append(signal)
    limit_value = _input_value(input_, "limit", 6)
    limit = limit_value if isinstance(limit_value, int) and not isinstance(limit_value, bool) else 6
    constraint = _normalize_whitespace(_input_value(input_, "constraint", ""))
    return [
        {
            "situation": signal["situation"],
            "need": need,
            "constraint": constraint,
            "supportingClauses": [signal["clause"]],
            "support": signal["support"],
            "reviewIndexes": signal["reviewIndexes"],
            "origin": signal["origin"],
            "key": signal["key"],
        }
        for signal in signals[:limit]
    ]


def derive_review_cep_candidates(input_: Mapping[str, object] | object) -> list[dict[str, object]]:
    return [candidate for candidate in derive_cep_candidates(input_) if candidate["origin"] == "review"]


def derive_cep_situations_for_planning(product: object, locale: str) -> list[dict[str, object]]:
    """Return de-duplicated non-routine situations for downstream planner prompts."""
    routine_vocabulary = _routine_vocabulary(product)
    seen: set[str] = set()
    result: list[dict[str, object]] = []
    for signal in [
        *extract_situation_signals(product, locale, "product"),
        *extract_situation_signals(product, locale, "review"),
    ]:
        key = str(signal["key"])
        if any(token in key for token in routine_vocabulary) or key in seen:
            continue
        seen.add(key)
        result.append(signal)
    return result


extractSituationSignals = extract_situation_signals
extractReviewSituationSignals = extract_review_situation_signals
namesUseSituation = names_use_situation
deriveCepCandidates = derive_cep_candidates
deriveReviewCepCandidates = derive_review_cep_candidates
deriveCepSituationsForPlanning = derive_cep_situations_for_planning
