"""Recover section and ordinal relationships from OCR reading-order lines."""

from __future__ import annotations

import re
from typing import Any

_ORDINAL = re.compile(r"^(?:step\s*)?(\d+)\s*(?:단계|段階)?[.):、]?$", re.IGNORECASE)
_SENTENCE_END = re.compile(r"[.!?。！？]$")
_KOREAN_MULTI_SYLLABLE_TAIL = re.compile(
    r"(?:으로|로서|로써|에서|에게|또는|이나|까지|부터|보다|처럼|같이|하여|면서|지만|든지|이며|이고)$"
)
_KOREAN_SINGLE_SYLLABLE_TAIL = re.compile(r"(?:으|로|에|의|와|과|을|를|이|가|은|는|도|만|나|며|고|한|인|된|랑)$")
_KOREAN_SENTENCE_ENDING = re.compile(r"(?:습니다|입니다|합니다|니다|세요|해요|이에요|예요|이다|한다|된다|없다|있다|임|함)$")
_ENGLISH_CLAUSE_FUNCTION = re.compile(
    r"(?:^|\s)(?:to|with|for|from|in|on|onto|into|over|after|before|and|or|then|until|while|that|which|as|by|of)\s+\S",
    re.IGNORECASE,
)
_EXPLICIT_SECTION_HEADING = re.compile(
    r"^(?:benefits?|why you'?ll love it|good for|ingredients?|key ingredients?|formula|formulated without|"
    r"how to use|how-to-use|directions|application|ritual|routine|clinical results?|results?|efficacy|faq|reviews?|"
    r"caution|warnings?|precautions?|safety(?: information)?|"
    r"성분|주요 성분|전성분|원료|효능|효과|결과|개선|사용법|사용 ?방법|사용방법|사용|도포|장점|피부 ?고민|"
    r"주의(?:사항)?|경고|안전(?:성)?|리뷰|후기|평점|별점)$",
    re.IGNORECASE,
)
_MEASUREMENT_AXIS = re.compile(
    r"(?:^|\s)(?:전|후|뒤|직후|중)(?:$|\s)|\d+(?:\.\d+)?\s*(?:주|일|개월|시간|년)|"
    r"\b(?:before|after|baseline|initial|later|weeks?|days?|months?|hours?)\b",
    re.IGNORECASE,
)
_METRIC_DIRECTION = re.compile(
    r"(?:개선|증가|감소|상승|향상|회복|완화|잔존|지속)|\b(?:improv|increas|decreas|reduc|recover)",
    re.IGNORECASE,
)
_SAFETY_OR_CAUTION_VALUE = re.compile(
    r"\b(?:caution|warning|precaution|patch\s*test|irritation\s*test|safety\s*(?:test(?:ing|ed)?|assessment|check)?|"
    r"(?:clinically|dermatologically|dermatologist)[ -]?tested|hypoallergenic|non[-\s]?comedogenic|"
    r"avoid\s+(?:use|contact)|do\s+not\s+(?:use|swallow)|not\s+(?:recommended|suitable|intended)|"
    r"for\s+external\s+use\s+only|discontinue\s+use|consult\s+(?:a|your)\s+(?:doctor|physician))\b|"
    r"(?:주의(?:사항)?|경고|안전(?:성)?\s*(?:테스트|시험|검사|평가)|패치\s*테스트|첩포\s*(?:테스트|시험)|"
    r"저자극\s*(?:테스트|시험|검사|평가)?|피부과\s*(?:테스트|시험)|알레르기\s*(?:테스트|시험)|"
    r"논코메도제닉|사용(?:할)?\s*수\s*없|사용하지|권장하지|피해야|외용으로만|"
    r"눈에\s*들어가지\s*않도록|먹지\s*마십시오|사용을\s*중지)",
    re.IGNORECASE,
)


def parse_ocr_block_sections(text: str) -> list[dict[str, Any]]:
    """Return visible headings and their text/ordinal children.

    A number printed alone is a hard visual item boundary.  Within that item,
    OCR line wrapping is joined until a terminal mark or the next ordinal.
    """

    lines = [re.sub(r"\s+", " ", line).strip() for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    lines = [line for line in lines if line]
    sections: list[dict[str, Any]] = []
    section: dict[str, Any] | None = None
    item: dict[str, Any] | None = None
    emitted: set[int] = set()
    previous_line = ""
    previous_was_heading = False
    item_holds_remaining_lines = False
    numbered: tuple[dict[str, Any], int] | None = None

    def ensure_section() -> dict[str, Any]:
        nonlocal section
        if section is None:
            section = {"items": []}
        return section

    def emit(value: dict[str, Any] | None) -> None:
        if value is None or id(value) in emitted or ("heading" not in value and not value["items"]):
            return
        sections.append(value)
        emitted.add(id(value))

    def flush_item() -> None:
        nonlocal item, item_holds_remaining_lines, numbered
        item_holds_remaining_lines = False
        if item and item.get("text"):
            current = ensure_section()
            current["items"].append(item)
            if "ordinal" in item:
                numbered = (current, int(item["ordinal"]) + 1)
        item = None

    def flush_section() -> None:
        nonlocal section
        flush_item()
        emit(section)
        section = None

    for index, line in enumerate(lines):
        ordinal = _ordinal(line)
        if ordinal is not None:
            flush_item()
            if numbered is not None and numbered[1] == ordinal and numbered[0] is not section:
                emit(section)
                section = numbered[0]
            item = {"ordinal": ordinal, "text": ""}
            item_holds_remaining_lines = True
            previous_line = line
            previous_was_heading = False
            continue
        opens_item = item is not None and not item["text"]
        if (
            not opens_item
            and not previous_was_heading
            and not _continues_previous_line(previous_line, line)
            and _heading(line, index, len(lines))
        ):
            flush_section()
            section = {"heading": line, "items": []}
            previous_line = line
            previous_was_heading = True
            continue
        if item is not None and (item_holds_remaining_lines or _continues_previous_line(previous_line, line)):
            item["text"] = f"{item['text']} {line}".strip()
            if item_holds_remaining_lines and _SENTENCE_END.search(item["text"]):
                flush_item()
        else:
            flush_item()
            item = {"text": line}
        previous_line = line
        previous_was_heading = False
    flush_section()
    return sections


def section_heading_category(heading: str) -> str | None:
    """Return the retained TS role for a source-declared OCR section heading.

    OCR ingress and later semantic publishing must consult this one predicate;
    otherwise a valid source role such as ``FORMULA`` can be discarded before
    the classifier gets a chance to preserve it.
    """

    label = re.sub(r"\s+", " ", heading).strip().casefold()
    if not label:
        return None
    if (
        len(label.split()) <= 4
        and _MEASUREMENT_AXIS.search(label)
        and not ("%" in label or _METRIC_DIRECTION.search(label))
    ):
        return None
    if re.fullmatch(r"caution|warnings?|precautions?|safety(?: information)?|주의(?:사항)?|경고|안전(?:성)?", label, re.I):
        return "safety"
    if re.fullmatch(r"ingredients?|key ingredients?|formula|formulated without|성분|주요 성분|전성분|원료", label, re.I):
        return "ingredient"
    if re.fullmatch(r"how to use|how-to-use|directions|application|ritual|routine|사용법|사용 ?방법|사용방법|사용|도포", label, re.I):
        return "usage"
    if re.fullmatch(r"benefits?|why you'?ll love it|good for|장점|효능|피부\s?고민", label, re.I):
        return "benefit"
    if re.fullmatch(r"clinical results?|results?|efficacy|효과|결과|개선", label, re.I):
        return "effect"
    if re.search(r"rating|stars?|평점|별점", label, re.I):
        # TS's ``sectionHeadingCategory`` deliberately suppresses rating
        # headings: they are review evidence, not a declared product role.
        return None
    if re.search(r"review|customer|리뷰|후기", label, re.I):
        return "review"
    if re.search(r"faq|question|answer|q&a|자주|질문|답변", label, re.I):
        return "faq"
    if re.search(r"ingredient|formula|formulated without|성분|원료|전성분", label, re.I):
        return "ingredient"
    if re.search(r"how to use|how-to-use|directions|application|ritual|routine|사용법|사용 ?방법|사용방법|사용|도포", label, re.I):
        return "usage"
    if re.search(r"benefit|why you|good for|helps|장점|효능|피부\s?고민|보습|수분|탄력|장벽|광채|자생력|고밀도", label, re.I):
        return "benefit"
    if re.search(r"clinical|result|efficacy|improvement|improved|diminish|diminished|firmer|elastic|wrinkles?|fine lines|효과|결과|개선", label, re.I):
        return "effect"
    return None


def is_ocr_safety_or_caution_value(value: str) -> bool:
    """Recognize explicit source safety tests and cautions without product-type heuristics."""

    return bool(_SAFETY_OR_CAUTION_VALUE.search(value))


def segment_item_sentences(value: str) -> list[str]:
    cleaned = re.sub(r"\s+", " ", value).strip()
    pieces = [
        part.strip()
        for part in re.split(r"(?<=[.!?。！？])\s+(?=[A-Z0-9\"'가-힣])", cleaned)
        if len(part.strip()) >= 12
    ]
    return pieces or ([cleaned] if cleaned else [])


def normalize_ocr_figure_boundaries(value: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^0-9a-z가-힣ぁ-んァ-ン]+", " ", value.casefold())).strip()


def normalize_ocr_comparison_text(value: str) -> str:
    return re.sub(r"[^\w가-힣ぁ-んァ-ン]+", "", re.sub(r"\s+", " ", value).casefold(), flags=re.UNICODE)


def _ordinal(line: str) -> int | None:
    match = _ORDINAL.fullmatch(line)
    if not match:
        return None
    value = int(match.group(1))
    return value if value >= 1 else None


def _heading(line: str, index: int, total: int) -> bool:
    if index >= total - 1 or _SENTENCE_END.search(line) or _KOREAN_SENTENCE_ENDING.search(line):
        return False
    words = line.split()
    if len(words) > 3:
        return False
    # The retained explicit vocabulary wins over Korean-tail morphology:
    # ``효과`` ends in ``과`` (a grammatical particle in other contexts), but
    # here it is a one-word source heading that must establish the boundary.
    if _EXPLICIT_SECTION_HEADING.fullmatch(line):
        return True
    hangul = len(re.findall(r"[가-힣]", line))
    latin = len(re.findall(r"[A-Za-z]", line))
    if hangul:
        # Korean content phrases are commonly as short as their headings.  The
        # source's explicit section vocabulary is the reliable distinction.
        return (
            len(line) <= 14
            and not _korean_continuation_tail(words[-1])
            and any(marker in line for marker in ("효능", "효과", "성분", "사용", "피부 타입", "전성분", "고객"))
        )
    if not latin:
        return False
    maximum = 32 if line == line.upper() else 24
    if len(line) > maximum:
        return False
    # The retained extractor has an explicit short-label vocabulary in
    # addition to shape recognition.  It prevents title-case ``How to Use``
    # from being mistaken for a running English clause.
    if line != line.upper() and _ENGLISH_CLAUSE_FUNCTION.search(line):
        return False
    return True


def _continues_previous_line(previous: str, following: str) -> bool:
    """Port the layout parser's visual-line continuation rule."""

    if not previous or _SENTENCE_END.search(previous):
        return False
    if previous.endswith("-") or re.match(r"^[a-z(\[,]", following):
        return True
    if re.match(
        r"^(?:and|or|with|that|which|while|to|for|of|in|by|as|from|into|plus|including|containing)\b",
        following,
        re.I,
    ):
        return True
    return _korean_continuation_tail(previous.split()[-1])


def _korean_continuation_tail(value: str) -> bool:
    return bool(
        _KOREAN_MULTI_SYLLABLE_TAIL.search(value)
        or (len(value) >= 3 and _KOREAN_SINGLE_SYLLABLE_TAIL.search(value))
    )
