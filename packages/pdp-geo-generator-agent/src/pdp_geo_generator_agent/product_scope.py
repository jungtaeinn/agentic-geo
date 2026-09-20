"""Keep generated usage and evidence scoped to the current PDP product."""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Final, TypeGuard, cast

_GENERIC_STOP_TOKENS: Final[frozenset[str]] = frozenset(
    {
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "by",
        "for",
        "from",
        "in",
        "into",
        "is",
        "it",
        "its",
        "of",
        "on",
        "onto",
        "or",
        "our",
        "the",
        "this",
        "to",
        "with",
        "your",
        "product",
        "item",
        "set",
        "mini",
        "full",
        "size",
        "ml",
        "oz",
        "apply",
        "dispense",
        "lather",
        "layer",
        "massage",
        "mist",
        "pat",
        "pump",
        "rub",
        "scoop",
        "smooth",
        "spray",
        "spread",
        "take",
        "use",
        "using",
        "warm",
    }
)
_ROUTINE_ONLY_TOKENS: Final[frozenset[str]] = frozenset(
    {
        "amount",
        "appropriate",
        "before",
        "clean",
        "damp",
        "dry",
        "evenly",
        "face",
        "gently",
        "hands",
        "layer",
        "morning",
        "night",
        "palms",
        "pea",
        "routine",
        "skin",
        "small",
        "step",
        "thin",
        "twice",
        "until",
        "water",
        "wet",
    }
)
_PRODUCT_FORM_TOKENS: Final[frozenset[str]] = frozenset(
    {
        "ampoule",
        "balm",
        "cleanser",
        "cream",
        "essence",
        "foam",
        "gel",
        "lotion",
        "mask",
        "mist",
        "moisturizer",
        "oil",
        "serum",
        "toner",
        "wash",
        "앰플",
        "밤",
        "클렌저",
        "크림",
        "에센스",
        "폼",
        "젤",
        "로션",
        "마스크",
        "미스트",
        "오일",
        "세럼",
        "토너",
    }
)
_ACTION_TARGET = re.compile(
    r"\b(?:apply|dispense|take|pump|scoop|spray|mist|spread|massage|lather|rub|warm|layer|pat|smooth)\s+([^.;\n]{2,120})",
    re.IGNORECASE,
)
_CURRENT_PRODUCT_ACTION = re.compile(
    r"\b(?:apply|dispense|use|using|take|pump|scoop|spray|mist|spread|massage|lather|rub|warm|layer|pat|smooth|rinse)\b|"
    r"(?:사용|도포|바르|덜어|펴\s*바르|마사지|흡수|거품\s*내|거품내|헹구|미온수|분사|뿌려|뿌리|스프레이)|塗布|なじませ|吹きかけ|噴射",
    re.IGNORECASE,
)
_SOURCE_ORDER_MARKER = re.compile(r"^\s*(?:step\s*)?\d+\s*(?:단계|段階)?[.):、]", re.IGNORECASE)


@dataclass(frozen=True)
class _ProductScope:
    product_phrases: tuple[tuple[str, ...], ...]
    name_tokens: tuple[str, ...]
    category_tokens: tuple[str, ...]
    form_tokens: tuple[str, ...]
    primary_form_token: str | None
    family_tokens: tuple[str, ...]
    ingredient_tokens: tuple[str, ...]


@dataclass(frozen=True)
class _ProductCandidate:
    source: str
    raw: str
    tokens: tuple[str, ...]


def _is_record(value: object) -> TypeGuard[Mapping[str, object]]:
    return isinstance(value, Mapping)


def _field(product: object, key: str, default: object = None) -> object:
    if _is_record(product):
        return product.get(key, default)
    return getattr(product, key, default)


def _strings(value: object) -> list[str]:
    if not isinstance(value, Sequence) or isinstance(value, str | bytes | bytearray):
        return []
    return [item for item in cast(Sequence[object], value) if isinstance(item, str)]


def _clean(value: object) -> str:
    return value if isinstance(value, str) else ""


def _unique_strings(values: Sequence[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if value.strip() and value not in seen:
            seen.add(value)
            result.append(value)
    return result


def _tokenize(value: str) -> list[str]:
    normalized = unicodedata.normalize("NFKC", value).lower().replace("’", "").replace("'", "")
    chunks: list[str] = []
    current: list[str] = []
    for char in normalized:
        if char.isalnum():
            current.append(char)
        elif current:
            chunks.append("".join(current))
            current = []
    if current:
        chunks.append("".join(current))
    return chunks


def _significant_tokens(tokens: Sequence[str]) -> list[str]:
    return [token for token in tokens if len(token) > 1 and token not in _GENERIC_STOP_TOKENS]


def _tokens_match(left: str, right: str) -> bool:
    if left == right:
        return True
    if min(len(left), len(right)) < 5 or abs(len(left) - len(right)) > 1:
        return False
    return _has_edit_distance_within_one(left, right)


def _has_edit_distance_within_one(left: str, right: str) -> bool:
    left_index = right_index = edits = 0
    while left_index < len(left) and right_index < len(right):
        if left[left_index] == right[right_index]:
            left_index += 1
            right_index += 1
            continue
        edits += 1
        if edits > 1:
            return False
        if len(left) > len(right):
            left_index += 1
        elif len(right) > len(left):
            right_index += 1
        else:
            left_index += 1
            right_index += 1
    return edits + (len(left) - left_index) + (len(right) - right_index) <= 1


def _contains_matching_token(tokens: Sequence[str], token: str) -> bool:
    return any(_tokens_match(candidate, token) for candidate in tokens)


def _overlap_count(left: Sequence[str], right: Sequence[str]) -> int:
    matched: set[int] = set()
    for token in left:
        index = next(
            (
                index
                for index, candidate in enumerate(right)
                if index not in matched and _tokens_match(candidate, token)
            ),
            None,
        )
        if index is not None:
            matched.add(index)
    return len(matched)


def _contains_token_sequence(tokens: Sequence[str], phrase_tokens: Sequence[str]) -> bool:
    if not phrase_tokens or len(phrase_tokens) > len(tokens):
        return False
    return any(
        all(_tokens_match(tokens[index + offset], token) for offset, token in enumerate(phrase_tokens))
        for index in range(len(tokens) - len(phrase_tokens) + 1)
    )


def _unique_phrases(values: Sequence[Sequence[str]]) -> tuple[tuple[str, ...], ...]:
    seen: set[str] = set()
    result: list[tuple[str, ...]] = []
    for value in values:
        phrase = tuple(value)
        key = " ".join(phrase)
        if key and key not in seen:
            seen.add(key)
            result.append(phrase)
    return tuple(result)


def _create_product_scope(product: object) -> _ProductScope:
    name_tokens = _unique_strings(
        _significant_tokens(
            [*_tokenize(_clean(_field(product, "name", ""))), *_tokenize(_clean(_field(product, "originalName", "")))]
        )
    )
    category_tokens = _unique_strings(_significant_tokens(_tokenize(_clean(_field(product, "category", "")))))
    category_forms = [token for token in category_tokens if token in _PRODUCT_FORM_TOKENS]
    named_forms = [token for token in name_tokens if token in _PRODUCT_FORM_TOKENS]
    if category_forms:
        form_tokens = _unique_strings([*category_forms, *named_forms])
    elif named_forms:
        form_tokens = named_forms
    elif len(name_tokens) > 1:
        form_tokens = [name_tokens[-1]]
    else:
        form_tokens = name_tokens
    family_tokens = _unique_strings(
        [token for token in name_tokens if not _contains_matching_token(form_tokens, token)]
    )[:4]
    product_phrases = _unique_phrases(
        [
            _significant_tokens(_tokenize(_clean(_field(product, "name", "")))),
            _significant_tokens(_tokenize(_clean(_field(product, "originalName", "")))),
            _significant_tokens(_tokenize(_clean(_field(product, "category", "")))),
        ]
    )
    ingredient_tokens = _unique_strings(
        [
            token
            for ingredient in _strings(_field(product, "ingredients", []))
            for token in _significant_tokens(_tokenize(ingredient))
        ]
    )
    return _ProductScope(
        product_phrases=product_phrases,
        name_tokens=tuple(name_tokens),
        category_tokens=tuple(category_tokens),
        form_tokens=tuple(form_tokens),
        primary_form_token=form_tokens[-1] if form_tokens else None,
        family_tokens=tuple(family_tokens),
        ingredient_tokens=tuple(ingredient_tokens),
    )


def _has_current_product_action(value: str) -> bool:
    return bool(_CURRENT_PRODUCT_ACTION.search(value))


def _candidate_contains_primary_form(tokens: Sequence[str], scope: _ProductScope) -> bool:
    return any(_contains_matching_token(tokens, form_token) for form_token in scope.form_tokens)


def _has_current_product_anchor(segment: str, scope: _ProductScope) -> bool:
    tokens = _significant_tokens(_tokenize(segment))
    if not tokens:
        return False
    if any(phrase and _contains_token_sequence(tokens, phrase) for phrase in scope.product_phrases):
        return True
    if _candidate_contains_primary_form(tokens, scope) and _has_current_product_action(segment):
        return True
    if scope.category_tokens and _overlap_count(tokens, scope.category_tokens) == len(scope.category_tokens):
        return True
    return bool(scope.name_tokens and _overlap_count(tokens, scope.name_tokens) >= min(3, len(scope.name_tokens)))


def _trim_candidate_phrase(value: str) -> str:
    before_connector = re.sub(
        r"\b(?:to|onto|on|into|with|after|before|until|for|from|then|and)\b[\s\S]*$", "", value, flags=re.IGNORECASE
    ).strip()
    match = re.search(r"\bof\s+(.+)$", before_connector, re.IGNORECASE)
    after_of = match.group(1) if match else before_connector
    return re.sub(
        r"^\s*(?:a|an|the|your|this|one|two|three|four|five|\d+(?:-\d+)?|dime-sized|pea-sized|small|generous|appropriate|amount|pumps?|drops?|scoops?)\s+",
        "",
        after_of,
        flags=re.IGNORECASE,
    ).strip()


def _candidate_tokens(value: str) -> tuple[str, ...]:
    return tuple(token for token in _significant_tokens(_tokenize(value)) if token not in _ROUTINE_ONLY_TOKENS)


def _extract_capitalized_candidates(segment: str) -> list[_ProductCandidate]:
    candidates: list[_ProductCandidate] = []
    patterns = (
        re.compile(r"\b(?:[A-Z][A-Z0-9'&-]{2,}\s+){1,}[A-Z][A-Z0-9'&-]{2,}\b"),
        re.compile(r"\b(?:[A-Z][a-z0-9'&-]{2,}\s+){1,}[A-Z][a-z0-9'&-]{2,}\b"),
    )
    for pattern in patterns:
        for match in pattern.finditer(segment):
            raw = _trim_candidate_phrase(match.group(0))
            tokens = _candidate_tokens(raw)
            if len(tokens) >= 2:
                candidates.append(_ProductCandidate("capitalized", raw, tokens))
    return candidates


def _extract_action_target_candidates(segment: str) -> list[_ProductCandidate]:
    candidates: list[_ProductCandidate] = []
    for match in _ACTION_TARGET.finditer(segment):
        raw = _trim_candidate_phrase(match.group(1))
        tokens = _candidate_tokens(raw)
        if tokens:
            candidates.append(_ProductCandidate("action-target", raw, tokens))
    return candidates


def _extract_family_context_candidates(segment: str, scope: _ProductScope) -> list[_ProductCandidate]:
    if not scope.family_tokens:
        return []
    tokens = _significant_tokens(_tokenize(segment))
    candidates: list[_ProductCandidate] = []
    for index, token in enumerate(tokens):
        if _contains_matching_token(scope.family_tokens, token):
            window = tuple(tokens[index : index + 4])
            if len(window) >= 2:
                candidates.append(_ProductCandidate("family-context", " ".join(window), window))
    return candidates


def _unique_candidates(values: Sequence[_ProductCandidate]) -> list[_ProductCandidate]:
    seen: set[str] = set()
    result: list[_ProductCandidate] = []
    for value in values:
        key = f"{value.source}:{' '.join(value.tokens)}"
        if key not in seen:
            seen.add(key)
            result.append(value)
    return result


def _extract_product_candidates(segment: str, scope: _ProductScope) -> list[_ProductCandidate]:
    return _unique_candidates(
        [
            *_extract_capitalized_candidates(segment),
            *_extract_action_target_candidates(segment),
            *_extract_family_context_candidates(segment, scope),
        ]
    )


def _is_current_product_candidate(tokens: Sequence[str], scope: _ProductScope) -> bool:
    if not tokens:
        return False
    if any(phrase and _contains_token_sequence(tokens, phrase) for phrase in scope.product_phrases):
        return True
    if _candidate_contains_primary_form(tokens, scope):
        return (
            not scope.family_tokens
            or _overlap_count(tokens, scope.family_tokens) > 0
            or _overlap_count(tokens, scope.category_tokens) > 0
        )
    return not scope.primary_form_token and _overlap_count(tokens, scope.name_tokens) >= min(2, len(scope.name_tokens))


def _is_ingredient_candidate(tokens: Sequence[str], scope: _ProductScope) -> bool:
    return (
        len(tokens) >= 2
        and bool(scope.ingredient_tokens)
        and _overlap_count(tokens, scope.ingredient_tokens) >= min(len(tokens), 3)
    )


def _is_routine_only_candidate(tokens: Sequence[str]) -> bool:
    return all(token in _ROUTINE_ONLY_TOKENS or token in _GENERIC_STOP_TOKENS or token.isdigit() for token in tokens)


def _looks_like_named_target(value: str) -> bool:
    words = [word for word in re.split(r"\s+", value) if word]
    return len(words) >= 2 and any(
        word[0].isupper() and all(char.isalnum() or char in "'&-" for char in word[1:]) for word in words
    )


def _is_different_product_candidate(candidate: _ProductCandidate, scope: _ProductScope) -> bool:
    if _is_current_product_candidate(candidate.tokens, scope) or _is_ingredient_candidate(candidate.tokens, scope):
        return False
    if candidate.source == "family-context":
        names_another_form = any(
            token in _PRODUCT_FORM_TOKENS for token in candidate.tokens
        ) and not _candidate_contains_primary_form(candidate.tokens, scope)
        return _overlap_count(candidate.tokens, scope.family_tokens) > 0 and names_another_form
    if candidate.source == "capitalized":
        return len(candidate.tokens) >= 2 and not _is_routine_only_candidate(candidate.tokens)
    if _is_routine_only_candidate(candidate.tokens):
        return False
    return len(candidate.tokens) >= 2 and _looks_like_named_target(candidate.raw)


def _has_foreign_product_reference(segment: str, scope: _ProductScope, actionable_only: bool = False) -> bool:
    return any(
        candidate.source != "capitalized" or not actionable_only
        for candidate in _extract_product_candidates(segment, scope)
        if _is_different_product_candidate(candidate, scope)
    )


def _classify_usage_segment(segment: str, scope: _ProductScope) -> str:
    if _has_current_product_anchor(segment, scope):
        return "current"
    if _has_foreign_product_reference(segment, scope):
        return "foreign"
    return "orphan"


def _clean_usage_segment(value: str) -> str:
    cleaned = re.sub(
        r"^\s*(?:how\s*to\s*use|directions?|usage|사용\s*방법|사용법|使い方|使用方法)\s*:?\s*",
        "",
        value,
        flags=re.IGNORECASE,
    )
    cleaned = re.sub(r"^\s*Step\s+\d+\s*[:.-]?\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"^\s*\d+\.\s*", "", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned)
    cleaned = re.sub(r"\s+\.", ".", cleaned).strip()
    return re.sub(r"[.;,\s]+$", "", cleaned).strip()


def _split_usage_segments(value: str) -> list[str]:
    separated = re.sub(r"\s+(?=Step\s+\d+\b)", "\n", value, flags=re.IGNORECASE)
    separated = re.sub(r"\s*;\s*", "\n", separated)
    separated = re.sub(r",\s*then\b", "\nThen", separated, flags=re.IGNORECASE)
    separated = re.sub(r"\bthen\b", "\nThen", separated, flags=re.IGNORECASE)
    separated = re.sub(r"\.\s+", "\n", separated)
    return [cleaned for segment in re.split(r"\n+", separated) if (cleaned := _clean_usage_segment(segment))]


def _join_usage_segments(segments: Sequence[str]) -> str:
    cleaned = _unique_strings([_clean_usage_segment(segment) for segment in segments if _clean_usage_segment(segment)])
    return ". ".join(cleaned)


def _is_foreign_only_signal(value: str, scope: _ProductScope) -> bool:
    segments = _split_usage_segments(value)
    if not segments:
        return False
    has_foreign = has_current = False
    for segment in segments:
        has_foreign = has_foreign or _has_foreign_product_reference(segment, scope, actionable_only=True)
        has_current = has_current or _classify_usage_segment(segment, scope) == "current"
    return has_foreign and not has_current


def _filter_foreign_only_signals(values: Sequence[str], scope: _ProductScope) -> list[str]:
    return [value for value in values if not _is_foreign_only_signal(value, scope)]


def filter_current_product_usage_instructions(product: Mapping[str, object]) -> Mapping[str, object]:
    """Remove instructions/evidence that point only to another named product."""
    original_usage = _strings(product.get("usage", []))
    if not original_usage:
        return product
    scope = _create_product_scope(product)
    if not scope.name_tokens and not scope.category_tokens:
        return product
    usage: list[str] = []
    last_context: str | None = None
    for instruction in original_usage:
        segments = _split_usage_segments(instruction)
        if _SOURCE_ORDER_MARKER.search(instruction) and not any(
            _classify_usage_segment(segment, scope) == "foreign" for segment in segments
        ):
            usage.append(instruction.strip())
            if any(_classify_usage_segment(segment, scope) == "current" for segment in segments):
                last_context = "current"
            continue
        kept: list[str] = []
        dropped_segment = False
        for segment in segments:
            kind = _classify_usage_segment(segment, scope)
            if kind == "foreign":
                last_context = "foreign"
                dropped_segment = True
                continue
            if kind == "current":
                kept.append(_clean_usage_segment(segment))
                last_context = "current"
                continue
            if last_context == "foreign":
                dropped_segment = True
                continue
            if last_context == "current" or kept or not usage or _has_current_product_action(segment):
                kept.append(_clean_usage_segment(segment))
                last_context = last_context or "orphan"
        scoped_instruction = (
            instruction.strip()
            if not dropped_segment and len(segments) == 1 and len(kept) == 1
            else _join_usage_segments(kept)
        )
        if scoped_instruction:
            usage.append(scoped_instruction)
    scoped_usage = _unique_strings(usage)
    benefits = _filter_foreign_only_signals(_strings(product.get("benefits", [])), scope)
    effects = _filter_foreign_only_signals(_strings(product.get("effects", [])), scope)
    metrics = _filter_foreign_only_signals(_strings(product.get("metrics", [])), scope)
    source_texts = _filter_foreign_only_signals(_strings(product.get("sourceTexts", [])), scope)
    if (
        scoped_usage == original_usage
        and benefits == _strings(product.get("benefits", []))
        and effects == _strings(product.get("effects", []))
        and metrics == _strings(product.get("metrics", []))
        and source_texts == _strings(product.get("sourceTexts", []))
    ):
        return product
    scoped = dict(product)
    scoped.update(
        {
            "usage": scoped_usage,
            "benefits": benefits,
            "effects": effects,
            "metrics": metrics,
            "sourceTexts": source_texts,
        }
    )
    return scoped


def is_conflicting_product_usage_instruction(value: str, product: Mapping[str, object]) -> bool:
    scope = _create_product_scope(product)
    if not scope.name_tokens and not scope.category_tokens:
        return False
    return any(_classify_usage_segment(segment, scope) == "foreign" for segment in _split_usage_segments(value))


filterCurrentProductUsageInstructions = filter_current_product_usage_instructions
isConflictingProductUsageInstruction = is_conflicting_product_usage_instruction
