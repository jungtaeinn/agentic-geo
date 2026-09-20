"""Shared publication gates for source prose that is not safe public description copy."""

from __future__ import annotations

import re

from .._json import clean_text
from .sentence_form import without_tagging_markup
from .usage import is_procedural_usage_instruction, is_raw_page_text_block

_ENGLISH_MARKETING_IMPERATIVE = re.compile(
    r"^(?:hydrate|restore|discover|experience|indulge|awaken|recharge|transform|reveal|unlock|revive|save|"
    r"elevate|unveil|treat|boost|give)\b",
    re.IGNORECASE,
)
_KOREAN_MARKETING_IMPERATIVE = re.compile(r"(?:하세요|하십시오|해\s*주세요|바르세요|사용하세요|적용하세요)[.!。！？]?$")
_JAPANESE_MARKETING_IMPERATIVE = re.compile(r"(?:してください|して下さい|塗ってください|使ってください)[。！？]?$")
_COMMERCE_OR_REVIEW_COPY = re.compile(
    r"(?:\b(?:cart|checkout|coupon|shipping|ships?|refund|purchase|purchasers?|orders?|buy\s+now|sale|"
    r"discount|subscribe|subscription)\b|"
    r"\b(?:free|fast|same[-\s]?day|express)\s+(?:shipping|delivery)\b|"
    r"\b(?:shipping|delivery)\s+(?:fee|cost|date|time|address|option|status)\b|"
    r"\b(?:return|exchange)\s+(?:policy|window|period|request|label)\b|"
    r"\breturns?\s+(?:are\s+)?(?:available|accepted|offered)\b|"
    r"\b(?:loyalty|reward|earn|redeem)\s+points?\b|\b\d+(?:\.\d+)?%\s+off\b|"
    r"\b(?:save\s+(?:\$|\d)|off\s+(?:sale|your))\b|"
    r"\b(?:customers?|buyers?)\s+(?:say|says|said|report(?:s|ed)?|love(?:s|d)?|hate(?:s|d)?|"
    r"dislike(?:s|d)?|recommend(?:s|ed)?)\b|"
    r"\b(?:reviews?|reviewer|verified\s+buyers?|rating|five\s+stars?|customer\s+rated|rated\s+\d)\b|"
    r"장바구니|구매하기|배송(?:비)?|무료\s*배송|교환|반품|환불|할인|쿠폰|정기\s*구독|포인트|적립|"
    r"고객\s*리뷰|구매\s*후기|리뷰에서|후기에서|"
    r"고객(?:들은|이|은)?\s*[^.!?。！？]{0,60}(?:말했|말합니다|평가했|평가합니다|리뷰했|리뷰합니다|"
    r"좋아했|싫어했|별로였|만족했))",
    re.IGNORECASE,
)


def is_publishable_description_text(value: object, locale: str) -> bool:
    """Accept factual description prose while retaining calls-to-action as source evidence only.

    Product descriptions can be extracted from meta, JSON-LD, or page copy. Those
    sources are evidence, not an instruction to publish their marketing voice. A
    source sentence is withheld when it is a question, a real procedure, or an
    action-led call to action. The raw text remains in ``sourceTexts`` for
    diagnostics and provenance.
    """

    text = clean_text(value)
    if not text:
        return False
    sentences = [clean_text(sentence) for sentence in re.split(r"(?<=[.!?。！？])\s+|\n+", text) if clean_text(sentence)]
    return bool(sentences) and all(_is_publishable_description_sentence(sentence, locale) for sentence in sentences)


def retain_publishable_description_sentences(value: object, locale: str) -> str:
    """Keep factual source sentences when adjacent source prose is merchant/UI copy.

    A PDP field can contain a valid product descriptor followed by a volatile
    shipping or promotion sentence.  The latter is withheld from public copy,
    but it must not erase the directly supported descriptor beside it.
    """

    text = clean_text(value)
    if not text:
        return ""
    sentences = [clean_text(sentence) for sentence in re.split(r"(?<=[.!?。！？])\s+|\n+", text) if clean_text(sentence)]
    return " ".join(sentence for sentence in sentences if _is_publishable_description_sentence(sentence, locale))


def is_merchant_or_review_copy(value: object) -> bool:
    """Identify volatile commerce and customer-commentary source copy.

    This is intentionally separate from the description gate because a typed
    safety fact can be a valid public statement even when it looks like an
    instruction.  Callers that preserve typed facts still use this predicate
    to prevent a shipping offer or review fragment from borrowing that role.
    """

    return _COMMERCE_OR_REVIEW_COPY.search(clean_text(value)) is not None


def _is_publishable_description_sentence(sentence: str, locale: str) -> bool:
    text = clean_text(sentence)
    if not text or text.rstrip().endswith(("?", "？")) or is_procedural_usage_instruction(text):
        return False
    # A page captured whole -- headings, chart axes, step lists and all -- ends
    # on a sentence ending like any other sentence, so nothing downstream can
    # tell it apart once it is treated as description prose.  It is the page,
    # not a description of the product, and publishing it puts the whole page
    # inside the field meant to summarise it.
    if is_raw_page_text_block(text):
        return False
    # Merchant offers and customer commentary are valid source evidence, but
    # they are not a product description. Keeping them out here prevents a
    # raw metadata field from publishing a shipping promise or review as the
    # item itself.
    if is_merchant_or_review_copy(text):
        return False
    if locale in {"en-US", "en-GB"}:
        return _ENGLISH_MARKETING_IMPERATIVE.search(text) is None
    if locale == "ko-KR":
        return _KOREAN_MARKETING_IMPERATIVE.search(text) is None
    if locale == "ja-JP":
        return _JAPANESE_MARKETING_IMPERATIVE.search(text) is None
    return True


def publishable_public_copy(value: object) -> str:
    """Return public copy without the markup that tags or quotes it.

    An answer engine lifts a sentence, and a hashtag or a quotation mark lifted
    with it means nothing where it lands.  Only the markers are removed; every
    word stays exactly as it was, and source comparison shares this one
    definition of what markup to ignore, so nothing a sentence is bound to
    changes.
    """

    text = clean_text(value)
    if not text:
        return ""
    return clean_text(without_tagging_markup(text))


__all__ = [
    "is_merchant_or_review_copy",
    "is_publishable_description_text",
    "publishable_public_copy",
    "retain_publishable_description_sentences",
]
