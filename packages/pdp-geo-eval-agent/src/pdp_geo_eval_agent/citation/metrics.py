"""Deterministic AutoGEO-compatible citation visibility metrics."""

from __future__ import annotations

import math
import re
import unicodedata
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import cast

from neo_js_compat import js_code_unit_length, js_round

from ..models import CitationSectionAttribution, CitationSentence, CitationVisibilityScore, ImpressionShares

_CITATION_INDEX_LIST = r"[0-9]+(?:\s*[,;]\s*[0-9]+)*"
_CITATION_GROUP = rf"\[\s*(?:{_CITATION_INDEX_LIST})\s*\]"
_CITATION_GROUP_RE = re.compile(rf"\[\s*({_CITATION_INDEX_LIST})\s*\]")
_TERMINAL_PUNCTUATION = frozenset(".!?…。？！")
_WHITESPACE_RE = re.compile(r"\s+")


@dataclass(slots=True)
class _SectionBucket:
    weight: int
    count: int
    sentences: list[str]


def extract_citation_sentences(answer: str) -> list[CitationSentence]:
    """Split an engine answer while retaining post-terminal citation runs."""
    sentences: list[CitationSentence] = []
    sentence_index = 0
    for paragraph_index, paragraph in enumerate(re.split(r"\n{2,}", answer)):
        for line in paragraph.split("\n"):
            for sentence in _split_sentences(line):
                text = sentence.strip()
                if not text:
                    continue
                sentences.append(
                    CitationSentence(
                        text=text,
                        paragraph_index=paragraph_index,
                        sentence_index=sentence_index,
                        word_count=_count_content_words(text),
                        citations=_extract_citation_indices(text),
                    )
                )
                sentence_index += 1
    return sentences


def score_impression_shares(sentences: Sequence[CitationSentence], source_count: int) -> ImpressionShares:
    """Calculate word, position, and word-position source shares."""
    if source_count < 0:
        raise ValueError("source_count must be non-negative")
    wordpos = [0.0] * source_count
    word = [0.0] * source_count
    pos = [0.0] * source_count
    hallucinated: set[int] = set()
    cited_sentence_count = 0
    total = len(sentences)

    for sentence in sentences:
        if not sentence.citations:
            continue
        position_decay = math.exp(-sentence.sentence_index / (total - 1)) if total > 1 else 1.0
        citation_split = len(sentence.citations)
        cited_in_range = False
        for citation in sentence.citations:
            if citation < 0 or citation >= source_count:
                hallucinated.add(citation)
                continue
            cited_in_range = True
            word[citation] += sentence.word_count / citation_split
            pos[citation] += position_decay / citation_split
            wordpos[citation] += (sentence.word_count * position_decay) / citation_split
        if cited_in_range:
            cited_sentence_count += 1

    return ImpressionShares(
        wordpos=_normalize_shares(wordpos),
        word=_normalize_shares(word),
        pos=_normalize_shares(pos),
        hallucinated_citations=sorted(hallucinated),
        cited_sentence_count=cited_sentence_count,
        sentence_count=total,
    )


def score_citation_visibility(answer: str, source_count: int, target_index: int) -> CitationVisibilityScore:
    """Return the target document's share across all citation metrics."""
    if target_index < 0 or target_index >= source_count:
        raise ValueError(f"targetIndex {target_index} is outside the source range [0, {source_count}).")
    shares = score_impression_shares(extract_citation_sentences(answer), source_count)
    return CitationVisibilityScore(
        wordpos=shares.wordpos[target_index] if target_index < len(shares.wordpos) else 0.0,
        word=shares.word[target_index] if target_index < len(shares.word) else 0.0,
        pos=shares.pos[target_index] if target_index < len(shares.pos) else 0.0,
        shares=shares,
    )


def attribute_citations_to_sections(
    answer: str, target_index: int, sections: Sequence[object]
) -> list[CitationSectionAttribution]:
    """Attribute target-cited answer sentences using deterministic lexical overlap."""
    cited_sentences = [sentence for sentence in extract_citation_sentences(answer) if target_index in sentence.citations]
    if not cited_sentences or not sections:
        return []

    haystacks: list[tuple[str, str]] = []
    for section in sections:
        section_id = _field(section, "id")
        text = _field(section, "text")
        if isinstance(section_id, str) and isinstance(text, str) and text.strip():
            haystacks.append((section_id, _normalize_for_match(text)))

    buckets: dict[str, _SectionBucket] = {}
    total_weight = 0
    for sentence in cited_sentences:
        weight = max(1, sentence.word_count)
        total_weight += weight
        tokens = _extract_match_tokens(sentence.text)
        best_id = "other"
        best_score = 0.0
        for section_id, haystack in haystacks:
            score = _section_overlap_score(tokens, haystack)
            if score > best_score:
                best_score = score
                best_id = section_id
        if not tokens or best_score < 0.2:
            best_id = "other"

        bucket = buckets.setdefault(best_id, _SectionBucket(weight=0, count=0, sentences=[]))
        bucket.weight += weight
        bucket.count += 1
        bucket.sentences.append(_strip_citation_markers(sentence.text))

    values = [
        CitationSectionAttribution(
            section_id=section_id,
            share=_round(bucket.weight / total_weight),
            cited_sentences=bucket.count,
            sentences=bucket.sentences,
        )
        for section_id, bucket in buckets.items()
    ]
    return sorted(values, key=lambda value: value.share, reverse=True)


def z_normalize_scores(values: Sequence[float]) -> list[float]:
    """Z-normalize heterogeneous score lists with AutoGEO's zero-variance rule."""
    if not values:
        return []
    mean = sum(values) / len(values)
    variance = sum((value - mean) ** 2 for value in values) / len(values)
    standard_deviation = math.sqrt(variance)
    if standard_deviation == 0:
        return [0.0 for _ in values]
    return [(value - mean) / standard_deviation for value in values]


def _split_sentences(line: str) -> list[str]:
    """Mirror the TypeScript boundary rule without variable-length lookbehind."""
    result: list[str] = []
    start = 0
    index = 0
    length = len(line)
    while index < length:
        if line[index] not in _TERMINAL_PUNCTUATION:
            index += 1
            continue

        whitespace_start = index + 1
        cursor = whitespace_start
        while cursor < length and line[cursor].isspace():
            cursor += 1
        if cursor == whitespace_start:
            index += 1
            continue

        first_group = _CITATION_GROUP_RE.match(line, cursor)
        if first_group is None:
            result.append(line[start : index + 1])
            start = cursor
            index = cursor
            continue

        group_end = first_group.end()
        while True:
            possible_start = group_end
            while possible_start < length and line[possible_start].isspace():
                possible_start += 1
            next_group = _CITATION_GROUP_RE.match(line, possible_start)
            if next_group is None:
                break
            group_end = next_group.end()

        next_start = group_end
        while next_start < length and line[next_start].isspace():
            next_start += 1
        if next_start > group_end and _CITATION_GROUP_RE.match(line, next_start) is None:
            result.append(line[start:group_end])
            start = next_start
            index = next_start
        else:
            index = group_end

    result.append(line[start:])
    return result


def _extract_citation_indices(sentence: str) -> list[int]:
    indices: list[int] = []
    seen: set[int] = set()
    for match in _CITATION_GROUP_RE.finditer(sentence):
        for token in match.group(1).split(","):
            for split_token in token.split(";"):
                number = int(split_token.strip())
                if number not in seen:
                    seen.add(number)
                    indices.append(number)
    return indices


def _count_content_words(sentence: str) -> int:
    without_citations = _CITATION_GROUP_RE.sub(" ", sentence)
    return sum(1 for token in without_citations.split() if _is_content_word(_trim_non_alphanumeric(token)))


def _normalize_shares(scores: Sequence[float]) -> list[float]:
    total = sum(scores)
    if total == 0:
        return [0.0 if not scores else 1.0 / len(scores) for _ in scores]
    return [score / total for score in scores]


def _normalize_for_match(value: str) -> str:
    return _WHITESPACE_RE.sub(" ", value.lower())


def _extract_match_tokens(sentence: str) -> list[str]:
    without_citations = _CITATION_GROUP_RE.sub(" ", sentence)
    return [
        token
        for token in (_trim_non_alphanumeric(part.lower()) for part in without_citations.split())
        if _is_match_token(token)
    ]


def _is_match_token(token: str) -> bool:
    if not token:
        return False
    if _contains_cjk_or_hangul(token):
        return js_code_unit_length(token) >= 2
    return js_code_unit_length(token) > 2


def _is_content_word(token: str) -> bool:
    if not token:
        return False
    return _contains_cjk_or_hangul(token) or len(token) > 2


def _contains_cjk_or_hangul(value: str) -> bool:
    return any(
        0xAC00 <= ord(character) <= 0xD7AF
        or 0x1100 <= ord(character) <= 0x11FF
        or 0x3130 <= ord(character) <= 0x318F
        or 0xA960 <= ord(character) <= 0xA97F
        or 0xD7B0 <= ord(character) <= 0xD7FF
        or 0x3400 <= ord(character) <= 0x4DBF
        or 0x4E00 <= ord(character) <= 0x9FFF
        or 0xF900 <= ord(character) <= 0xFAFF
        or 0x20000 <= ord(character) <= 0x2FA1F
        or 0x3040 <= ord(character) <= 0x309F
        or 0x30A0 <= ord(character) <= 0x30FF
        for character in value
    )


def _trim_non_alphanumeric(value: str) -> str:
    start = 0
    end = len(value)
    while start < end and not _is_unicode_letter_or_number(value[start]):
        start += 1
    while end > start and not _is_unicode_letter_or_number(value[end - 1]):
        end -= 1
    return value[start:end]


def _is_unicode_letter_or_number(value: str) -> bool:
    return unicodedata.category(value)[0] in {"L", "N"}


def _section_overlap_score(tokens: Sequence[str], haystack: str) -> float:
    if not tokens:
        return 0.0
    return sum(1 for token in tokens if _haystack_includes_token(haystack, token)) / len(tokens)


def _haystack_includes_token(haystack: str, token: str) -> bool:
    if token in haystack:
        return True
    if any(0xAC00 <= ord(character) <= 0xD7AF for character in token):
        for trim in (1, 2):
            stem = token[:-trim]
            if len(stem) >= 2 and stem in haystack:
                return True
    return False


def _strip_citation_markers(sentence: str) -> str:
    without_markers = _CITATION_GROUP_RE.sub("", sentence)
    compact = _WHITESPACE_RE.sub(" ", without_markers)
    return re.sub(r"\s+([.,!?…。])", r"\1", compact).strip()


def _field(value: object, key: str) -> object:
    if isinstance(value, Mapping):
        return cast(Mapping[str, object], value).get(key)
    return getattr(value, key, None)


def _round(value: float) -> float:
    return js_round(value * 1000) / 1000
