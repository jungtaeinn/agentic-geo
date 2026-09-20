"""Review-polarity guards shared by generation and final validation."""

from __future__ import annotations

import math
import re
from collections.abc import Mapping
from typing import TypeGuard

_NEGATIVE_SIGNAL = re.compile(
    r"(?:약품\s*냄새|냄새|향(?:이|은)?[^.。！？]{0,24}(?:아쉬|별로|강하|불편)|"
    r"아쉬|별로|불편|따가|화끈|자극(?!\s*(?:이|은|는)?\s*(?:없|없이|적))|"
    r"트러블(?!\s*(?:없|안|올라오지|올라오지\s*않))|건조하|당김이\s*심|"
    r"끈적(?!임?(?:이)?\s*(?:없|없이|적))|답답|무거|뻑뻑|실망|문제|최악|싫어|돈\s*이?\s*아깝|"
    r"다시는\s*구매하지|품질\s*(?:이|가)?\s*나쁘|"
    r"(?:촉촉|보습|수분감|산뜻|가벼|부드럽|매끈|윤기|광채|흡수|편안|순하|탄력)"
    r"[^.。！？]{0,16}(?:지\s*않|않음|못)|"
    r"(?:효과|개선)(?:를|가|은)?\s*(?:느끼|보|확인)지\s*못|"
    r"(?:효과|도움)(?:이|가)?\s*(?:없|미미|되지\s*않)|"
    r"bad|worse|worst|terrible|awful|hate|useless|poor\s+quality|smell|odor|scent|fragrance|irritat|breakout|sticky|greasy|heavy|drying|"
    r"disappoint|complain|(?:did\s+not|didn't|does\s+not|doesn't)\s+(?:notice|see|feel|help)|"
    r"no\s+(?:visible\s+)?(?:effect|improvement)|not\s+effective|never\s+buy|"
    r"regret(?:\s+(?:the|this|my))?\s+purchase|waste\s+of\s+money|money\s+back)",
    re.IGNORECASE,
)
_COMPLAINT_CUES = re.compile(
    r"(?:아쉬|별로|불편|따가|화끈|자극|트러블|건조|당김|끈적|답답|무거|뻑뻑|실망|냄새|붉어|가렵|간지럽|"
    r"최악|싫어|돈\s*이?\s*아깝|다시는\s*구매하지|품질\s*(?:이|가)?\s*나쁘)|"
    r"(?:촉촉|보습|수분|산뜻|가벼|부드럽|매끈|윤기|광채|흡수|편안|순하|탄력)"
    r"[^.。！？]{0,16}(?:지\s*않|않음|못)|"
    r"\b(?:irritat|sticky|greasy|heavy|drying|disappoint|breakout|burn|itch|smell|odou?r|terrible|awful|hate|useless|poor\s+quality)"
    r"|\b(?:never\s+buy|regret(?:\s+(?:the|this|my))?\s+purchase|waste\s+of\s+money|money\s+back)",
    re.IGNORECASE,
)
_POSITIVE_KEYWORD = re.compile(
    r"(?:\b(?:lightweight|comfortable|hydrating|moisturi[sz]ing|soft|smooth|radiant|glow(?:ing)?|"
    r"sooth(?:ing)?|refreshing|gentle|absorb(?:s|ed|ing)?|quick(?:ly)?[-\s]?absorbing|"
    r"non[-\s]?sticky|velvety|silky|plump(?:ing)?|firm(?:ing)?|love(?:d|s)?|amazing|excellent|great|recommend(?:ed|s)?|satisfied)\b|"
    r"촉촉(?:한|함|해)|보습감|수분감|산뜻(?:한|함|해)|가벼(?:운|움|워)|부드럽(?:게|고|한|움)|"
    r"매끈(?:한|함|해)|윤기|광채|흡수(?:가|력|도)?\s*(?:좋|빠르)|편안(?:한|함|해)|"
    r"순하(?:게|고|한|움)|좋아|만족|추천|자극(?:이|은|는)?\s*(?:없|없이|적)|끈적임?\s*(?:없|없이|적))",
    re.IGNORECASE,
)
_TRAILING_NEGATION = re.compile(
    r"^[^.!?。！？]{0,14}?(?:없|않|안\s|덜|적(?:은|게|어)|잡아주|개선|완화|해결|줄여|줄이|보완|방지|케어|なく|ない|ません|防|改善)"
)
_LEADING_NEGATION = re.compile(
    r"(?:\b(?:no|not|never|without|free\s+of|less|isn'?t|wasn'?t|does\s?n'?t|did\s?n'?t|"
    r"reduces?|prevents?|relieves?|soothes?|solves?|targets?|tackles?|fights?|combats?)\b|\bnon-)"
    r"[^.!?]{0,20}$",
    re.IGNORECASE,
)


def _normalized(value: object) -> str:
    return re.sub(r"\s+", " ", value).strip() if isinstance(value, str) else ""


def is_negative_review_signal_text(value: str) -> bool:
    """Return whether a short review signal is an uncancelled complaint."""
    text = _normalized(value).lower()
    return bool(text and _NEGATIVE_SIGNAL.search(text))


def _has_uncancelled_complaint(clause: str) -> bool:
    for match in _COMPLAINT_CUES.finditer(clause):
        before, after = clause[: match.start()], clause[match.end() :]
        if (
            _TRAILING_NEGATION.search(after)
            or _LEADING_NEGATION.search(before)
            or re.match(r"\s*(?:이|은|는)?\s*(?:없|없이|적)", after)
        ):
            continue
        return True
    return False


def is_positive_review_body(value: str) -> bool:
    """Publish only explicitly positive review bodies with no uncancelled complaint."""
    text = _normalized(value)
    if not text:
        return False
    clauses = [clause for clause in re.split(r"[.!?。！？\n]+", text) if clause.strip()]
    return bool(clauses and all(not _has_uncancelled_complaint(clause) for clause in clauses) and _POSITIVE_KEYWORD.search(text))


def is_positive_review_keyword(value: str) -> bool:
    """Recognize an explicitly positive short review signal conservatively.

    A keyword is not a customer quotation, so public copy may use it only
    when it has an affirmative sensory or experience cue and contains no
    complaint.  Unclassified or mixed terms remain diagnostics-only.
    """

    text = _normalized(value)
    return bool(text and not is_negative_review_signal_text(text) and _POSITIVE_KEYWORD.search(text))


def is_positive_aggregate_rating(rating: object, review_count: object) -> bool:
    """Return whether an aggregate score is complete and clearly positive.

    The source schema permits a 5- or 10-point scale.  This guard keeps the
    public narrative threshold aligned with positive item ratings while
    preserving all valid aggregate metadata in JSON-LD independently.
    """

    if (
        not isinstance(rating, int | float)
        or isinstance(rating, bool)
        or not math.isfinite(rating)
        or not isinstance(review_count, int | float)
        or isinstance(review_count, bool)
        or not math.isfinite(review_count)
        or review_count < 1
    ):
        return False
    scale_max = 10 if rating > 5 else 5
    return rating > 0 and rating / scale_max >= 0.8


def _is_record(value: object) -> TypeGuard[Mapping[str, object]]:
    return isinstance(value, Mapping)


def _item_value(item: Mapping[str, object] | object, key: str) -> object:
    if _is_record(item):
        return item.get(key)
    return getattr(item, key, None)


def is_positive_review_item(item: Mapping[str, object] | object) -> bool:
    """Use a positive rating only when the accompanying body is not a complaint."""
    rating = _item_value(item, "rating")
    body = _item_value(item, "body")
    body_text = body if isinstance(body, str) else ""
    if body_text and any(_has_uncancelled_complaint(clause) for clause in re.split(r"[.!?。！？\n]+", body_text)):
        return False
    if isinstance(rating, int | float) and not isinstance(rating, bool) and math.isfinite(rating):
        if 0 < rating <= 5:
            return rating / 5 >= 0.8
        # An invalid rating is withheld from schema markup, but it must not
        # erase a substantive, explicitly positive review body beside it.
        return len(body_text) >= 20 and is_positive_review_body(body_text)
    return is_positive_review_body(body_text)


isNegativeReviewSignalText = is_negative_review_signal_text
isPositiveReviewBody = is_positive_review_body
isPositiveReviewKeyword = is_positive_review_keyword
isPositiveAggregateRating = is_positive_aggregate_rating
isPositiveReviewItem = is_positive_review_item
