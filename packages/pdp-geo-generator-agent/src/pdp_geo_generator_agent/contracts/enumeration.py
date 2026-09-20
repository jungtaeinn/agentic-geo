"""Grammar-based detection of unpredicated prose enumerations."""

from __future__ import annotations

import re
from collections.abc import Callable

from .sentence_form import is_korean_complete_sentence, split_into_sentences

SentenceExemption = Callable[[str, int], bool]
PROSE_COORDINATE_ITEM_LIMIT = 2

_COORDINATE_SEPARATOR_PATTERN = re.compile(r"(?<!\d)\s*[,、／]\s*|\s*[,、／]\s*(?!\d)")
_KOREAN_CONJUNCTIVE_ENDING_PATTERN = re.compile(r"(?:고|며|면서|지만|어서|아서|므로|는데|은데|하여|해서)$")
_KOREAN_ADVERBIAL_PARTICLE_PATTERN = re.compile(r"(?:으로|로|에서|에게|에|까지|부터|처럼|보다)$")
_MEASURED_OUTCOME_PATTERN = re.compile(r"\d[\d,.]*\s*%")
_HANGUL_PATTERN = re.compile(r"[가-힣]")
_ENGLISH_CLAUSE_MARKER_PATTERN = re.compile(
    r"\b(?:is|are|was|were|has|have|had|that|which|because|while|when|after|before)\b", re.IGNORECASE
)
_ENGLISH_SERIAL_COORDINATOR_PATTERN = re.compile(r"^(?:and|or)\s+", re.IGNORECASE)
_ENGLISH_COORDINATE_ITEM_MAX_LENGTH = 60


def has_unpredicated_enumeration(value: str, is_exempt_sentence: SentenceExemption | None = None) -> bool:
    """Return whether any sentence has three or more bare coordinate items."""
    return unpredicated_enumeration_sentence(value, is_exempt_sentence) is not None


def unpredicated_enumeration_sentence(value: str, is_exempt_sentence: SentenceExemption | None = None) -> str | None:
    """Return the first offending sentence, preserving its original punctuation."""
    for index, sentence in enumerate(split_into_sentences(value)):
        if is_exempt_sentence is not None and is_exempt_sentence(sentence, index):
            continue
        if _reports_a_measured_outcome(sentence):
            continue
        if _korean_sentence_enumerates_without_roles(sentence) or _english_sentence_enumerates_without_roles(sentence):
            return sentence
    return None


def _reports_a_measured_outcome(sentence: str) -> bool:
    return _MEASURED_OUTCOME_PATTERN.search(sentence) is not None


def _coordinate_items(sentence: str) -> list[str]:
    return [item.strip() for item in _COORDINATE_SEPARATOR_PATTERN.split(sentence) if item.strip()]


def _korean_sentence_enumerates_without_roles(sentence: str) -> bool:
    if not is_korean_complete_sentence(sentence):
        return False

    items = _coordinate_items(re.sub(r"[.!?。！？]+$", "", sentence))
    if len(items) < 3:
        return False
    if re.search(r"^\S+의\s+\S", items[-1]):
        return False

    coordinate_run = 1
    for index in range(len(items) - 2, -1, -1):
        if not _is_bare_korean_coordinate_item(items[index]):
            break
        coordinate_run += 1
    return coordinate_run >= 3


def _is_bare_korean_coordinate_item(item: str) -> bool:
    return (
        not is_korean_complete_sentence(item)
        and _KOREAN_CONJUNCTIVE_ENDING_PATTERN.search(item) is None
        and _KOREAN_ADVERBIAL_PARTICLE_PATTERN.search(item) is None
    )


def _english_sentence_enumerates_without_roles(sentence: str) -> bool:
    if _HANGUL_PATTERN.search(sentence) is not None:
        return False
    text = sentence.strip()
    if not re.search(r"[.!?]$", text):
        return False

    items = _coordinate_items(re.sub(r"[.!?]+$", "", text))
    if len(items) < 3 or _ENGLISH_SERIAL_COORDINATOR_PATTERN.search(items[-1]) is None:
        return False

    bare_middle_items = 0
    for index in range(len(items) - 2, 0, -1):
        if not _is_bare_english_coordinate_item(items[index]):
            break
        bare_middle_items += 1
    return bare_middle_items >= 1


def _is_bare_english_coordinate_item(item: str) -> bool:
    return len(item) <= _ENGLISH_COORDINATE_ITEM_MAX_LENGTH and _ENGLISH_CLAUSE_MARKER_PATTERN.search(item) is None


hasUnpredicatedEnumeration = has_unpredicated_enumeration
unpredicatedEnumerationSentence = unpredicated_enumeration_sentence


__all__ = [
    "PROSE_COORDINATE_ITEM_LIMIT",
    "SentenceExemption",
    "has_unpredicated_enumeration",
    "hasUnpredicatedEnumeration",
    "unpredicated_enumeration_sentence",
    "unpredicatedEnumerationSentence",
]
