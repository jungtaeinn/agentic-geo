"""Measured-result wording, scope, and atomicity contracts."""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from typing import Any

from .._json import clean_text, string
from .sentence_form import strip_korean_particle

KOREAN_METRIC_OUTCOME_PATTERN = "회복|개선|감소|증가|상승|향상|완화|잔존|지속"
_NUMERIC_TOKEN = re.compile(
    r"(?:[$€£₩]\s*)?[+\-−]?\d+(?:[.,]\d+)?\s*(?:%|％|배|x|회|명|인|주|일|시간|분|초|weeks?|days?|hours?|minutes?|seconds?|users?|participants?|subjects?|women|men|ml|mL|l|g|mg|µg|μg|kg|oz|ppm|mm|cm|°c|krw|usd|eur|gbp)?",
    re.IGNORECASE,
)
_WORD_TOKEN = re.compile(r"[\w가-힣ぁ-んァ-ン一-龯]+(?:[-\'][\w가-힣ぁ-んァ-ン一-龯]+)*")
_MEASUREMENT_FIGURE = re.compile(
    r"\d+(?:[.,]\d+)?\s*(?:[%％‰]|℃|℉|[°˚]\s*[CF]|배|점|등급|시간|ppm|ppb|㎛|μm|µm|㎚|nm|㎍|µg|μg|IU|kcal|Pa|g/m²h|g/m2h|points?|times|fold|degrees?)",
    re.IGNORECASE,
)
# A page states its test conditions in the grammar of the market that reads
# them.  A counted group of people is a sample in either language, and a
# period is a duration or a date range however it is labelled, so both slots
# read both -- a footnote reader that knows only one language leaves every
# measured result of the other unpublished.
_PERSON_COUNT = r"\d{1,4}\s+(?:women|men|users?|subjects?|participants?|panelists?|volunteers?|adults?|people)\b"
_SAMPLE = re.compile(
    r"(?:만\s*\d{1,3}\s*~\s*\d{1,3}\s*세[^/|,\n]{0,20})?\d{1,4}\s*(?:명|인(?![가-힣]))(?:\s*(?:대상|참여|이상))?"
    rf"|{_PERSON_COUNT}",
    re.IGNORECASE,
)
_QUALIFIED_SAMPLE = re.compile(
    r"(?:만\s*\d{1,3}\s*~\s*\d{1,3}\s*세[^/|,\n]{0,20})?\d{1,4}\s*(?:명|인(?![가-힣]))\s*(?:대상|참여|이상)"
    rf"|{_PERSON_COUNT}",
    re.IGNORECASE,
)
# A bare duration is not a period: a results panel prints durations inside the
# outcomes it measures.  What makes a duration the study's period is the
# preposition or the "of use" the page prints with it.
_PERIOD = re.compile(
    r"(?:시험|측정|조사|평가|사용)\s*기간\s*[:\s]*\d{2,4}[.\-/]\d{1,2}[.\-/]\d{1,2}\s*(?:~|-|–|—|부터|에서)\s*\d{2,4}[.\-/]\d{1,2}[.\-/]\d{1,2}"
    r"|(?:for|over|after|within|following)\s+\d+\s*(?:weeks?|days?|months?|hours?)(?:\s+of\s+use)?"
    r"|\d+\s*(?:weeks?|days?|months?|hours?)\s+of\s+use",
    re.IGNORECASE,
)
_STUDY_METHOD = re.compile(
    r"(?:인체\s*적용|자가\s*평가|소비자\s*평가|시험|테스트|clinical|study|self[-\s]?assessment|instrumental|survey|home\s+usage)",
    re.IGNORECASE,
)
_CAVEAT = re.compile(r"개인\s*차(?:가)?\s*(?:있음|있습니다|있을\s*수\s*있습니다|존재)")
_POSSESSIVE_SUFFIX = re.compile(r"['’]s$")



def word_tokens(value: str) -> list[str]:
    """Return the word-shaped tokens of a text, keeping hyphenated compounds whole."""
    return _WORD_TOKEN.findall(value)


def numeric_tokens(value: str) -> list[str]:
    """Return the distinct numeric tokens a text carries, with any unit attached."""
    seen: list[str] = []
    for match in _NUMERIC_TOKEN.finditer(value):
        token = match.group(0).replace("−", "-").replace("％", "%").replace(" ", "").casefold()
        if token and token not in seen:
            seen.append(token)
    return seen


def product_naming_surfaces(product: Mapping[str, Any]) -> list[str]:
    """Return the designations a product is called by, in ledger order."""
    seen: list[str] = []
    for key in ("name", "originalName", "alternateName", "brand"):
        value = clean_text(product.get(key))
        if value and value not in seen:
            seen.append(value)
    return seen


def naming_identifier_numerics(text: str, naming_texts: Iterable[str]) -> set[str]:
    """Return the numerics ``text`` carries inside a naming surface's own word.

    A naming atom carries digits that identify a thing rather than measure it:
    ``BarrierCare365`` is what a product is called, the ``200g`` of a registered
    name completes that name, and ``500-Hour Aged Ginseng Extract`` is what an
    ingredient is called.  A numeric counts as an identifier only where the text
    writes it the way the name does, in the very word of the name that carries
    it, so an unsourced ``99.9%`` is never read as a name.  Matching the name
    word rather than the whole atom keeps a shortened rendering or an attached
    particle from turning a name back into a measurement.
    """

    return {
        numeric
        for naming in naming_texts
        for word in _naming_words_the_text_writes(text, naming)
        for numeric in numeric_tokens(word)
    }


def states_naming_surface(text: str, naming: str) -> bool:
    """Return whether a text calls a naming surface by the words that identify it.

    Calling a name asserts nothing; it points at the thing the name
    designates.  A text calls a name where it writes every word that tells the
    name apart, as a word of its own, so ``베타`` never borrows what the ledger
    linked to ``베타인``, while the grammar a locale attaches to a word — a
    Korean particle, an English possessive — still leaves that word written.
    A registered name also carries the quantity the thing is sold in, and
    public copy names the same thing without it, so a word that is nothing but
    a measure is not one of the words that tell the name apart.
    """

    naming_words = [
        word for word in (token.casefold() for token in word_tokens(naming)) if numeric_tokens(word) != [word]
    ]
    text_words = {
        form
        for token in word_tokens(text)
        for word in (token.casefold(),)
        for form in (word, strip_korean_particle(_POSSESSIVE_SUFFIX.sub("", word)))
    }
    return bool(naming_words) and all(word in text_words for word in naming_words)


def _naming_words_the_text_writes(text: str, naming: str) -> list[str]:
    """Return the words of a naming surface that a text writes in its own word."""
    text_words = [token.casefold() for token in word_tokens(text)]
    return [
        word
        for word in (token.casefold() for token in word_tokens(naming))
        if any(text_word.startswith(word) for text_word in text_words)
    ]


def korean_improvement_direction(value: str) -> bool:
    return bool(re.fullmatch(r"(?:개선|증가|향상|회복|상승)", value))


def metric_direction(value: str) -> bool:
    return bool(
        re.search(
            rf"(?:{KOREAN_METRIC_OUTCOME_PATTERN}|충전|charge|reach|improv|recover|increase|decrease|reduc|last)",
            value,
            re.I,
        )
    )


def states_study_method(text: str) -> bool:
    return _STUDY_METHOD.search(text) is not None


def states_study_population(text: str) -> bool:
    return bool(
        re.search(
            r"(?:\d+\s*명|\d+\s*(?:women|men|users?|subjects?|participants?)|대상|참여자|사용자|participants?|subjects?)",
            text,
            re.I,
        )
    )


def states_evidence_context(text: str) -> bool:
    return bool(
        re.search(
            r"(?:인체\s*적용|자가\s*평가|소비자\s*평가|시험|테스트|측정|평가|임상|in\s*vitro|ex\s*vivo|clinical|study|test|assessment|instrumental|survey|home\s+usage|\d+\s*명|\d+\s*(?:women|men|users?|subjects?|participants?)|대상|참여자|사용자|표본|sample|participants?|subjects?|사용\s*(?:직후|전|후)|도포\s*(?:직후|전|후)|\d+(?:\.\d+)?\s*(?:분|시간|일|주|개월|minutes?|weeks?|days?|hours?|months?)\s*(?:후|동안|만에)?|비교|대비|versus|\bvs\.?\b|(?:before|after)\s+(?:use|application)|after\s+\d)",
            text,
            re.I,
        )
    )


def measurement_figures(value: str) -> set[str]:
    return {re.sub(r"\s+", "", item) for item in _MEASUREMENT_FIGURE.findall(value)}


def states_only_figures_of(candidate: str | set[str], owner: str | set[str]) -> bool:
    stated = candidate if isinstance(candidate, set) else measurement_figures(candidate)
    owned = owner if isinstance(owner, set) else measurement_figures(owner)
    return bool(stated and owned) and stated.issubset(owned)


def read_reported_study_scope(segment: str) -> dict[str, str] | None:
    match = _QUALIFIED_SAMPLE.search(segment) or _SAMPLE.search(segment)
    sample = match.group(0).strip() if match else ""
    match = _PERIOD.search(segment)
    period = match.group(0).strip() if match else ""
    match = _CAVEAT.search(segment)
    caveat = match.group(0).strip() if match else ""
    result = {key: value for key, value in {"sample": sample, "period": period, "caveat": caveat}.items() if value}
    return result or None


_FOOTNOTE_MARKER_TAIL = re.compile(r"(?:[\s,;:·•*＊※]|(?<!\d)\d{1,2}(?!\d)|[+\-−±])+$")
_FOOTNOTE_MARKER_HEAD = re.compile(r"^(?:[\s,;:·•*＊※]|(?<!\d)\d{1,2}(?!\d))+")
_MIN_PANEL_ROWS = 2


def measured_figure_claims(block: str) -> list[dict[str, str]]:
    """Read a flattened results panel back as the rows it was printed as.

    OCR flattens a results panel -- a column of figures, each printed against
    the outcome it measures, under one line of test conditions -- into a single
    line.  Published whole, that line reads as one claim carrying every figure
    under one sample and one period; rejected, the strongest evidence a page
    has goes unpublished and the description loses its measured stage.

    The panel has not lost its relations, only its line breaks.  A figure is
    printed immediately before the words that say what it measures, and the
    test conditions are printed once, after the last figure.  So each row is
    recovered by position: the figure, the words up to the next figure, and the
    conditions the whole panel shares.  Nothing is inferred -- a row whose
    words the page did not print is not returned.

    This reads structure, not meaning.  Which row is worth publishing, and
    whether it may be published at all, stay with the callers that decide that.
    """

    text = re.sub(r"\s+", " ", block).strip()
    figures = list(_MEASUREMENT_FIGURE.finditer(text))
    if len(figures) < _MIN_PANEL_ROWS:
        return []
    # Reading a row as "the figure, then the words after it" holds only for a
    # panel whose figures lead their rows.  A page can instead print the figure
    # inside the phrase it measures -- "색조 메이크업 97.1% 세정" -- and there
    # the words before a figure belong to it too, so splitting after each figure
    # would hand one row's subject to the row above.  A panel that opens on
    # words is left to the structure its extractor already carries.
    if re.search(r"[A-Za-z]{2,}|[가-힣]{2,}", text[: figures[0].start()]):
        return []
    last_figure_end = figures[-1].end()
    footnote_start = min(
        (
            match.start()
            for pattern in (_STUDY_METHOD, _QUALIFIED_SAMPLE, _SAMPLE, _PERIOD)
            for match in pattern.finditer(text)
            if match.start() >= last_figure_end
        ),
        default=len(text),
    )
    scope = read_reported_study_scope(text[footnote_start:]) or {}
    method = text[footnote_start:].strip()
    if scope:
        for value in scope.values():
            method = method.replace(value, " ", 1)
    method = clean_text(_FOOTNOTE_MARKER_HEAD.sub("", _FOOTNOTE_MARKER_TAIL.sub("", method)))
    claims: list[dict[str, str]] = []
    for index, figure in enumerate(figures):
        end = figures[index + 1].start() if index + 1 < len(figures) else footnote_start
        if end <= figure.end():
            return []
        printed = clean_text(
            _FOOTNOTE_MARKER_HEAD.sub("", _FOOTNOTE_MARKER_TAIL.sub("", text[figure.end() : end]))
        )
        if not re.search(r"[A-Za-z]{2,}|[가-힣]{2,}", printed):
            return []
        measured = re.fullmatch(r"(\d+(?:[.,]\d+)?)\s*(.+)", figure.group().strip())
        if measured is None:
            return []
        sign = text[figure.start() - 1] if figure.start() and text[figure.start() - 1] in "+-−" else ""
        claim = {
            "value": measured.group(1),
            "unit": measured.group(2),
            "label": printed,
            "metric": printed,
            "sentence": f"{sign}{figure.group().strip()} {printed}",
            "sourceText": block,
        }
        if method and _STUDY_METHOD.search(method) is not None:
            claim["method"] = method
        claim.update(scope)
        claims.append(claim)
    return claims


def annotated_figure_scopes(block: str) -> list[dict[str, Any]]:
    marks = sorted(
        [(match.start(), match.end()) for pattern in (_SAMPLE, _PERIOD, _CAVEAT) for match in pattern.finditer(block)]
    )
    footnotes: list[list[int]] = []
    for start, end in marks:
        if footnotes and start >= footnotes[-1][1] and not measurement_figures(block[footnotes[-1][1] : start]):
            footnotes[-1][1] = max(footnotes[-1][1], end)
        elif footnotes and start < footnotes[-1][1]:
            footnotes[-1][1] = max(footnotes[-1][1], end)
        else:
            footnotes.append([start, end])
    previous_end = 0
    result: list[dict[str, Any]] = []
    for start, end in footnotes:
        scope = read_reported_study_scope(block[start:end])
        figures = measurement_figures(block[previous_end:start])
        previous_end = end
        if scope and figures:
            result.append({"scope": scope, "figures": figures})
    return result


def _join_value_unit(value: object, unit: object) -> str:
    raw = clean_text(value)
    suffix = clean_text(unit)
    return raw if not suffix or raw.endswith(suffix) else f"{raw}{suffix}"


def _commerce_value(value: str) -> bool:
    return bool(re.search(r"(?:\b(?:ml|mL|g|kg|oz|fl\.\s*oz|개|set|pack)\b|₩|\$|€|£|원)", value, re.I))


def is_structured_atomic_metric_claim(claim: Mapping[str, object]) -> bool:
    """Return whether extractor-provided metric fields form one publishable atom.

    This is deliberately field-based: a structured ``timing`` is context even
    if no vocabulary matcher recognizes its wording, matching the TS local
    predicate in ``normalize.ts``.
    """
    value = _join_value_unit(claim.get("value"), claim.get("unit"))
    outcome = clean_text(claim.get("metric") or claim.get("label") or claim.get("subject"))
    context = clean_text(
        " ".join(
            string(claim.get(key))
            for key in ("sample", "period", "timing", "baseline", "comparator", "method", "institution", "caveat")
            if claim.get(key)
        )
    )
    public_text = clean_text(claim.get("sourceText") or claim.get("sentence"))
    if not value or not outcome or not context or _commerce_value(value):
        return False
    if re.search(r"\b1\s+(?:weeks|days|hours)\b", f"{context} {public_text}", re.I) or re.search(
        r"[\"']\s*$", public_text
    ):
        return False
    return bool(re.search(r"\d", value)) and any(char.isalpha() for char in outcome)


productNamingSurfaces = product_naming_surfaces
wordTokens = word_tokens
numericTokens = numeric_tokens
namingIdentifierNumerics = naming_identifier_numerics
statesNamingSurface = states_naming_surface
statesStudyMethod = states_study_method
statesStudyPopulation = states_study_population
statesEvidenceContext = states_evidence_context
measurementFigures = measurement_figures
statesOnlyFiguresOf = states_only_figures_of
readReportedStudyScope = read_reported_study_scope
annotatedFigureScopes = annotated_figure_scopes
measuredFigureClaims = measured_figure_claims
isStructuredAtomicMetricClaim = is_structured_atomic_metric_claim
