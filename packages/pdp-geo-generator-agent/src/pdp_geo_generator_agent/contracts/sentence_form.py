"""Sentence, phrase-shape, and Korean noun-slot grammar contracts."""

from __future__ import annotations

import re

from neo_js_compat import js_code_unit_length

KOREAN_COPULA_POLITE_PRESENT_ENDINGS = ("이에요", "예요")
KOREAN_COPULA_ENDING_FORMS = (
    "이었습니다",
    "였습니다",
    "입니다",
    "이었다",
    "였다",
    "이다",
    *KOREAN_COPULA_POLITE_PRESENT_ENDINGS,
)


# The closed class of endings Korean closes a polite sentence with.  An ending
# is grammar rather than content, so a caller comparing what a sentence states
# against a source reads this one definition instead of keeping its own copy.
KOREAN_POLITE_SENTENCE_ENDING = re.compile(
    r"(?:습니다|합니다|됩니다|입니다|니다|어요|이에요|예요|돼요|세요|주세요|십시오)$"
)


def is_korean_polite_sentence_ending(value: str) -> bool:
    return KOREAN_POLITE_SENTENCE_ENDING.search(value.strip()) is not None


def _is_hangul(char: str) -> bool:
    return len(char) == 1 and 0xAC00 <= ord(char) <= 0xD7A3


def _is_korean_plain_declarative_ending(text: str) -> bool:
    if not text.endswith("다") or re.search(r"(?:마다|보다)$", text):
        return False
    return len(text) >= 2 and _is_hangul(text[-2])


def is_korean_complete_sentence(value: str) -> bool:
    text = re.sub(r"[.!?。！？]+$", "", value.strip()).strip()
    return is_korean_polite_sentence_ending(text) or _is_korean_plain_declarative_ending(text)


def korean_classifies_its_subject(value: str) -> bool:
    """Return whether a Korean sentence predicates a category of its subject.

    A copula puts a noun in the predicate slot, so the sentence says what its
    subject *is* rather than what it does or what was measured about it.  That
    is the shape of an identity statement, which is how a source sentence that
    can open a description is told from one that reports an action.
    """
    text = re.sub(r"[.!?。！？]+$", "", value.strip()).strip()
    return text.endswith(KOREAN_COPULA_ENDING_FORMS)


def is_complete_sentence(value: str) -> bool:
    """Return whether a text asserts something rather than naming it.

    Ledger role lists mix catalog names with whole extracted sentences, and a
    Korean-only ending test reads English prose as a name.  A sentence is
    recognised by a Korean finite ending or by the terminal punctuation every
    locale writes, so the judgment holds wherever the ledger was extracted.
    """
    text = value.strip()
    if not text:
        return False
    return (
        is_korean_complete_sentence(text)
        or re.search(r"[.!?。！？]\s*$", text) is not None
        or re.search(r"[.!?。！？]\s+\S", text) is not None
    )


# The closed class of English words that cannot stand at the end of a noun
# phrase.  A catalog value that breaks off on one of them is the front of a
# sentence an extractor cut, not the name of a thing.  This is domain identity
# -- the words the language reserves for joining things rather than for naming
# one -- so a member missing from it is a gap to fill, not a rule to widen.
#
# Every reader of the set also subtracts it before comparing a published phrase
# against the source that has to hold it, so a member must carry no meaning of
# its own.  A missing plain preposition rejected a fully sourced sentence:
# ``… with daily use among 32 women, 100% showed improvement …`` left ``among``
# as its single unmatched token while the other thirteen stood in the recorded
# result.  Filling it in restores the comparison because ``among`` relates two
# things and asserts nothing about either.
#
# The prepositions that state a bound or a polarity stay out for that same
# reason: ``over``, ``under``, ``within``, ``without``, ``about``, ``than``,
# ``between`` and ``per`` each say something the source would have to have
# written, and dropping one would let a limit or a negation pass unsourced.
ENGLISH_FUNCTION_WORDS = frozenset(
    {
        "a", "an", "the", "and", "or", "but", "nor", "so", "yet", "of", "for", "to", "in", "on", "at",
        "by", "with", "from", "as", "into", "onto", "this", "that", "these", "those", "it", "its",
        "they", "their", "them", "is", "are", "was", "were", "be", "been", "being", "do", "does",
        "did", "has", "have", "had", "how", "what", "which", "who", "whom",
    }
)

_MEASURED_QUANTITY = re.compile(
    r"[+\-\u2212]?\d[\d,.]*\s*(?:%|\uff05|ppm|mg|kg|g|ml|mL|oz|fl\.?\s*oz|\ub9e4|\uac1c|\uc785)?",
    re.IGNORECASE,
)


def names_a_thing(value: str) -> bool:
    """Return whether a text names something rather than saying something about it.

    An ingredient, a technology, or an option is a name: every word in it
    belongs to the thing's label.  Three shapes are not names, and each reaches
    a catalog field the same way -- as a span cut out of the page's prose.  A
    complete sentence asserts something instead of naming it.  A run of digits
    and units measures something instead of naming it.  And a phrase that
    breaks off on a word that cannot end one -- ``Together, they``, ``It is
    designed to``, a Korean bare particle -- is the front of a sentence.
    """

    text = value.strip().rstrip(":\uff1a")
    if not text or is_complete_sentence(text):
        return False
    if not re.search(r"[A-Za-z\uac00-\ud7a3\u3041-\u3093\u30a1-\u30f3\u4e00-\u9fef]", _MEASURED_QUANTITY.sub(" ", text)):
        return False
    words = re.sub(r"[.,;:!?()\[\]]+$", "", text).split()
    if not words:
        return False
    last = words[-1].strip(".,;:!?")
    if not last:
        return False
    if re.search(r"[\uac00-\ud7a3]$", last):
        return strip_korean_particle(last) != ""
    return last.casefold() not in ENGLISH_FUNCTION_WORDS


# Terminal punctuation closes a sentence, and so does a line break: PDP source
# text arrives as blocks whose lines were separate statements on the page.  Every
# contract that reads a block one statement at a time reads the same boundary.
_SENTENCE_BOUNDARY = re.compile(r"(?<=[.!?。！？])\s+|\n+")


def split_into_sentences(value: str) -> list[str]:
    """Return a block's statements, one per sentence."""
    return [sentence for part in _SENTENCE_BOUNDARY.split(value.strip()) if (sentence := part.strip())]


# A connective joins two clauses and each states its own fact.  Korean marks the
# join on the predicate (the boundary the suitability contract also reads);
# English marks it with a semicolon, or with a coordinator or subordinator after
# a comma.  A caller that must judge one stated fact at a time reads this unit.
_ENGLISH_CLAUSE_BOUNDARY = re.compile(
    r"\s*;\s*|\s*,\s+(?=(?:and|but|or|while|whereas|which|though|whose)\b)", re.IGNORECASE
)


# The endings that close a clause.  One definition, read both by the boundary
# the suitability contract scopes an audience with and by the splitter here; a
# comma may stand between the ending and the next clause.
_KOREAN_CLAUSE_CONNECTIVES = "며|고|지만|면서|거나|든지|어서|아서|여서|는데|은데|니까|으나"
_KOREAN_CLAUSE_ENDING = rf"[가-힣](?:{_KOREAN_CLAUSE_CONNECTIVES})"
_KOREAN_TRAILING_CONNECTIVE = re.compile(rf"(?<=[가-힣])(?:{_KOREAN_CLAUSE_CONNECTIVES})$")


def korean_predicate_stem(value: str) -> str:
    """Return a predicate without the ending that joins or closes its clause.

    The same predicate appears as "돕고" inside a run of clauses and as
    "돕습니다" once it closes a sentence of its own.  A comparison that reads
    those as different words cannot tell a reconstruction that only re-ended a
    clause from one that added a fact, so both are reduced to the predicate
    they share -- using the same closed class of connectives the clause
    splitter reads.
    """

    stem = strip_korean_inflection(value)
    return _KOREAN_TRAILING_CONNECTIVE.sub("", stem) or stem
_KOREAN_CLAUSE_SPLIT = re.compile(rf"{_KOREAN_CLAUSE_ENDING}[,、]?\s")


def split_into_clauses(value: str) -> list[str]:
    """Return a sentence's clauses, one per stated fact.

    A lexicalized adverb can end in a connective's syllables (``언제든지``) and
    this package has no morphology to tell the two apart, so a sentence is
    sometimes cut where no clause ends.  Every caller here judges each piece
    against the same sources as the whole, so an extra cut costs precision in
    the caller's favour and never admits a word the sources do not carry.
    """

    text = re.sub(r"\s+", " ", value).strip()
    if not text:
        return []
    spans: list[str] = []
    start = 0
    for match in _KOREAN_CLAUSE_SPLIT.finditer(text):
        spans.append(text[start : match.end()])
        start = match.end()
    spans.append(text[start:])
    clauses: list[str] = []
    for span in spans:
        clauses.extend(part.strip() for part in _ENGLISH_CLAUSE_BOUNDARY.split(span) if part.strip())
    return clauses


def is_atomic_fact_phrase(value: str) -> bool:
    """Return whether a text is one catalog phrase rather than a run of prose."""
    return js_code_unit_length(value) <= 72 and len([part for part in re.split(r"\s+", value) if part]) <= 9


# A hashtag marks a word for a feed and a double quotation mark fences someone
# else's words.  Neither states anything, which is why published copy drops
# them -- and why a source comparison must not require them either: the same
# fact is the same fact whether the page tagged it or not.  A single quote is
# left alone because English writes an apostrophe with it.
PUBLIC_COPY_TAG_MARKER = re.compile(r"(?<![^\W_])#(?=[^\s#])")
PUBLIC_COPY_QUOTATION = re.compile(r"[\u201c\u201d\u301d\u301e\u300c\u300d\"]")


def without_tagging_markup(value: str) -> str:
    """Return a text without the markup that tags or quotes it."""

    return PUBLIC_COPY_QUOTATION.sub("", PUBLIC_COPY_TAG_MARKER.sub("", value))


# Korean states the same predicate in the politeness the situation calls for,
# and reports it in the plain declarative regardless: a customer writes
# "만족스러워요" and a page reporting that writes "만족스럽다는 평가".  These are
# the closed-class sentence-final endings and their plain form -- the
# counterpart of the inflection stripping above, which removes an ending where
# this one exchanges it.  Longer endings come first so a shorter one cannot cut
# into them, and the ㅂ-irregular is listed because its stem changes shape.
_KOREAN_PLAIN_DECLARATIVE_ENDINGS: tuple[tuple[str, str], ...] = (
    ("하였습니다", "하였다"),
    ("되었습니다", "되었다"),
    ("이었습니다", "이었다"),
    ("했습니다", "했다"),
    ("됐습니다", "됐다"),
    ("습니다", "다"),
    ("이에요", "이다"),
    ("예요", "이다"),
    ("이라", "이다"),
    ("러워요", "럽다"),
    ("스러워요", "스럽다"),
    ("워요", "ㅂ다"),
    ("해요", "하다"),
    ("돼요", "되다"),
    ("네요", "다"),
    ("아요", "다"),
    ("어요", "다"),
    ("여요", "다"),
    ("합니다", "하다"),
    ("됩니다", "되다"),
    ("입니다", "이다"),
)
KOREAN_COPULA_PLAIN_FORM = "이다"


def korean_plain_declarative(value: str) -> str:
    """Return a Korean predicate in the plain declarative a report would use.

    Only the ending is exchanged; the stem and every word before it stay as the
    source wrote them.  A text that carries no sentence-final ending is
    returned unchanged, which is how a caller tells that it has nothing to
    report.
    """

    text = value.strip().rstrip(".。！？!?")
    if not text:
        return ""
    for ending, plain in _KOREAN_PLAIN_DECLARATIVE_ENDINGS:
        if text.endswith(ending):
            stem = text[: -len(ending)]
            if plain == "ㅂ다":
                return f"{stem}\uc6b0\ub2e4"
            # The copula's own syllable can already stand in the stem when the
            # source wrote the ending that carries it ("대만족이예요"), and
            # attaching the plain copula whole would double it.
            if plain.startswith("이") and stem.endswith("이"):
                return f"{stem}{plain[1:]}"
            return f"{stem}{plain}"
    return text if text.endswith("다") else ""


_KOREAN_LIGHT_VERB_PLAIN_FORM = re.compile(r"^(?P<stem>.+)하다$")


def korean_reported_clause_misreads_a_verb(plain: str, corpus: str) -> bool:
    """Return whether reporting this predicate with ``-다는`` would misread it.

    Korean reports an adjective with ``-다는`` and a verb with ``-ㄴ다는``, and a
    noun+하다 predicate can be either ("촉촉하다" is an adjective, "만족하다" a
    verb), so the ending alone cannot tell them apart.  The source settles it:
    only a verb takes the present adnominal ``-는``, so a text that writes
    "{stem}하는" has written a verb, and ``-다는`` would be ungrammatical there.

    This reads one closed-class ending, not a vocabulary: any predicate the
    source inflects that way is a verb, whatever the stem happens to be.
    """

    match = _KOREAN_LIGHT_VERB_PLAIN_FORM.fullmatch(plain.strip())
    if match is None:
        return False
    return f"{match.group('stem')}하는" in corpus


def korean_reported_clause(value: str) -> str:
    """Return a plain declarative marked as the content of a report.

    Korean attaches ``-다는`` to a predicate and ``-라는`` to the copula, so the
    marker follows the predicate rather than being chosen by the caller.
    """

    plain = korean_plain_declarative(value)
    if not plain:
        return ""
    return f"{plain[:-1]}라는" if plain.endswith(KOREAN_COPULA_PLAIN_FORM) else f"{plain}는"


def source_phrase_matches(value: str, phrase: str) -> list[re.Match[str]]:
    """Return where a text states a source phrase, ignoring only role marking.

    A noun cannot be restated without whatever its language attaches to it: a
    Korean noun takes a case particle, and an English one stands on a word
    boundary.  Matching the bare spelling would both miss the restatement and
    match inside a longer word, so the boundary is what is relaxed -- never the
    phrase.  Callers that compare a source atom against published prose share
    this one definition.
    """

    if not phrase:
        return []
    value, phrase = without_tagging_markup(value), without_tagging_markup(phrase)
    if not phrase:
        return []
    # Korean marks the role with a particle attached to the noun; English marks
    # it with position, so what may follow is anything that is not more of the
    # same word.  Punctuation ends a sentence, not a phrase, so a phrase that
    # closes one still states it.
    # A case particle marks the noun's role; the copula turns the same noun
    # into the sentence's predicate ("…#터치리스클렌저" beside
    # "…#터치리스클렌저입니다").  Both attach directly to the noun, so both end
    # the phrase rather than extending it.
    korean_boundary = r"(?=\s|$|[은는이가을를에의와과]|입니다|입니까|이었|였)"
    right_boundary = korean_boundary if re.search(r"[가-힣]", phrase) else r"(?![\w-])"
    return list(re.finditer(rf"(?<![\w-]){re.escape(phrase)}{right_boundary}", value))


# A particle and an ending, which is all Korean inserts between a label's own
# words when prose states that label as a clause.  Widening this to hold a
# coordinated sibling was measured to match across unrelated words -- "피부
# 장벽 개선" inside "피부에 수분을 주며 장벽 손상 없이 개선된 사용감" -- so a
# label whose predicate coordination pushes further away stays unmatched here.
_LABEL_MARKER_WIDTH = 12


def source_statement_matches(value: str, phrase: str) -> list[re.Match[str]]:
    """Return where a text states a source phrase, including as a clause of a sentence.

    A page files a fact as a label -- "피부과 테스트 완료", "피부 장벽 개선" --
    and natural prose states that same fact as a clause: it merges the label
    with its siblings, marks its words with particles, and conjugates the
    predicate the label left nominalized ("피부과 테스트와 인체 안자극 테스트를
    완료했습니다").  Nothing is added and nothing is reordered, so every word
    still appears, in the label's own order, inside one sentence; only what
    Korean puts between them differs.  Reading the label's spelling alone made
    the page's own fact look like a claim from somewhere else, which is the one
    thing a source check must never conclude.

    Requiring every word, in order, within one sentence and across no more than
    a particle and an ending is what keeps this from admitting a fact the clause
    never states.
    """

    matches = source_phrase_matches(value, phrase)
    if matches or not re.search(r"[가-힣]", phrase):
        return matches
    words = [stem for word in re.findall(r"\w+", phrase) if (stem := re.sub(r"(?:함|음|기|됨|임)$", "", word))]
    if len(words) < 2:
        return []
    joined = rf"[^.!?。！？]{{0,{_LABEL_MARKER_WIDTH}}}?".join(re.escape(word) for word in words)
    return list(re.finditer(rf"(?<!\S){joined}", value))


_KOREAN_PARTICLE_SUFFIX = re.compile(r"(?:에게|에서|으로|에는|부터|까지|으로는|로|을|를|이|가|은|는|의|에|와|과|도)$")


def strip_korean_particle(value: str) -> str:
    """Return a word without the particle Korean attaches to it."""
    return _KOREAN_PARTICLE_SUFFIX.sub("", value)


# Korean carries a noun's role on the noun, so an entity named in a sentence is
# spelled with whatever particle its slot needs -- ``클렌징폼은`` as a topic,
# ``클렌징폼에`` inside a containment phrase, ``클렌징폼으로`` as a means.  A
# reader that knows only some of those spellings reads a named entity as unnamed
# in the slots it left out, and every such list drifts apart from the others, so
# this is the one closed class of particles that may close a noun phrase.
#
# It is wider than the inventory ``strip_korean_particle`` removes, and for a
# reason: a stripper must not cut a syllable that could belong to the stem
# (``보다`` is also a verb, ``만`` opens ``만족``), while a reader that only needs
# to know where the noun ends may accept them all.
# How Korean attaches a part to the whole that holds it.  ``제품에 담긴 판테놀``
# and ``판테놀을 함유해`` say that the product contains the ingredient, which is
# the relation a card already records, so the word states no fact beyond it --
# it is only where this locale puts the owner.  Both the admission gate and the
# final proofreader read this one definition; each keeping its own left a
# containment written one way exempt and the same containment written another
# way charged as a word no source carried.
KOREAN_CONTAINMENT_FRAME_FORMS = ("담긴", "담은", "담아", "함유된", "함유한", "함유해")
# The same frame in the other market.  English states containment with a verb
# where Korean states it with a particle and an adnominal, and reading only the
# Korean forms charged the English verb as a word no record carried -- measured,
# ``{product} includes {ingredient} and {ingredient}`` was dropped over the one
# word ``includes`` while the admission gate had already exempted it.  The verb
# says the product holds the part, which is the relation a card records, so it
# states no fact beyond the claim.
# Only the verbs that state containment and nothing else belong here.  To
# feature a part is to single it out and to hold one is to keep it, and a
# record that filed the part states neither, so exempting those would let an
# answer assert a prominence or a retention its source never wrote.
ENGLISH_CONTAINMENT_FRAME_FORMS = (
    "includes", "include", "including", "contains", "contain", "containing",
)


KOREAN_PHRASE_CLOSING_PARTICLES = (
    "에게서",
    "에게",
    "에서",
    "으로",
    "에는",
    "부터",
    "까지",
    "처럼",
    "보다",
    "한테",
    "께서",
    "조차",
    "마저",
    "라도",
    "이나",
    "로",
    "을",
    "를",
    "이",
    "가",
    "은",
    "는",
    "의",
    "에",
    "와",
    "과",
    "도",
    "만",
    "께",
)
KOREAN_PHRASE_CLOSING_PARTICLE_ALTERNATION = "|".join(
    sorted(KOREAN_PHRASE_CLOSING_PARTICLES, key=len, reverse=True)
)


# A Korean word carries its grammatical role on its own stem: a noun takes a case
# particle, a predicate takes an inflection.  The same fact is therefore spelled
# differently wherever it stands -- ``세정`` in a source phrase and ``세정합니다``
# in a sentence, ``클렌징폼`` in a name and ``클렌징폼은`` as a topic.  A
# comparison that reads those as different words makes every natural Korean
# sentence look like it asserts something its source never said, because Korean
# cannot restate a noun without a particle or a predicate without an ending.
# These are closed-class endings -- the counterpart of the English suffix
# normalization that sits beside such comparisons -- not a vocabulary of verbs.
_KOREAN_PREDICATE_INFLECTION = re.compile(
    r"(?:하였습니다|되었습니다|했습니다|됐습니다|합니다|됩니다|입니다|습니다|"
    r"했다|됐다|한다|된다|이다|"
    r"하거나|되거나|하는|되는|하고|되고|하며|되며|하여|되어|해서|되어서|"
    # The adnominal ending turns a predicate into a modifier, so the same fact
    # appears as ``민감한 피부`` beside ``민감 피부``.
    r"한|된)$"
)


def strip_korean_inflection(value: str) -> str:
    """Return a Korean word without the particle or ending that marks its role."""
    stem = _KOREAN_PREDICATE_INFLECTION.sub("", value)
    stem = strip_korean_particle(stem or value)
    return stem or value


# A case particle agrees with the coda of the syllable it follows: ``을``/``를``,
# ``은``/``는``, ``이``/``가``, ``과``/``와``, ``으로``/``로``.  Reading that
# agreement is what decides whether a final syllable is a particle at all --
# coordination after the open syllable ``효`` would have been written ``효와``,
# so the ``과`` of ``효과`` belongs to the noun, as it does in ``피부과``.  A
# coordinating particle also joins two noun phrases, so it may only close one
# long enough to be a phrase; a single syllable left behind means the reader cut
# into ``결과`` or ``성과``.  Every particle a native noun ends its own last
# syllable with needs that same floor, for the same reason: ``주의`` reduced to
# ``주``, ``회의`` to ``회``, ``용도`` to ``용``.  Measured: ``주의``, the safety
# caution, came out as the benefactive auxiliary's stem, which an answer reader
# sets aside as grammar -- so a warning of a risk no record filed was erased
# before the comparison and the answer read as stating nothing its record did
# not.  Agreement is unreadable after a Latin letter -- ``Panthenol은`` takes the
# particle its Korean reading calls for -- so there the spelling is accepted as
# written.
#
# Where agreement already answers the question the floor stays at one syllable:
# a one-syllable native stem takes ``을``/``를``, ``은``/``는``, ``으로``/``로``
# in the spelling its own coda calls for, and a noun ending in one of those
# syllables fails that agreement instead.
#
# Each entry is a particle, the coda its preceding syllable must carry (``True``
# closed, ``False`` open, ``None`` where the particle has a single spelling), and
# the shortest stem it may close.
_KOREAN_CASE_PARTICLES: tuple[tuple[str, bool | None, int], ...] = (
    ("에게서", None, 1),
    ("에게", None, 1),
    ("에서", None, 1),
    ("부터", None, 1),
    ("까지", None, 1),
    ("으로", True, 1),
    ("로", False, 1),
    ("을", True, 1),
    ("를", False, 1),
    ("은", True, 1),
    ("는", False, 1),
    ("이", True, 2),
    ("가", False, 2),
    ("과", True, 2),
    ("와", False, 2),
    ("의", None, 2),
    ("에", None, 2),
    ("도", None, 2),
)

# ``하``/``되`` make a predicate out of a noun, and the endings that predicate
# takes to carry a sentence forward are not finite forms, so an inventory of
# sentence endings does not list them.  Prose is what the prompt asks for, and
# prose writes ``장벽을 개선해 …``, ``함께 활용할 수 있습니다``, ``오래
# 사용하실 수 있습니다``: the light verb plus a connective, a prospective
# adnominal, or its honorific.  Each is grammar the prompt itself asked for,
# laid over content the source already states.
#
# A noun may end in the same syllable (``이해``, ``오해``, ``역할``, ``분할``),
# and there only one syllable is left behind, while the nominal stem a light
# verb stands on is two or more; requiring that is what keeps this from cutting
# a noun in half.  The finite endings need no such guard, because their stem may
# be a one-syllable native predicate (``있습니다`` -> ``있``).
_KOREAN_LIGHT_VERB_CONTINUATION = re.compile(r"(?:하실|되실|해|할|될)$")
_KOREAN_LIGHT_VERB_NOMINAL_STEM = 2


def _strip_korean_light_verb_continuation(word: str) -> str:
    match = _KOREAN_LIGHT_VERB_CONTINUATION.search(word)
    if not match or match.start() < _KOREAN_LIGHT_VERB_NOMINAL_STEM:
        return word
    return word[: match.start()]


def _strip_korean_case_particle(word: str) -> str:
    for particle, needs_coda, minimum in _KOREAN_CASE_PARTICLES:
        if not word.endswith(particle):
            continue
        stem = word[: -len(particle)]
        if len(stem) < minimum:
            continue
        if needs_coda is not None and _is_hangul(stem[-1]) and _has_coda(stem[-1]) != needs_coda:
            continue
        return stem
    return word


def korean_content_stem(value: str) -> str:
    """Return the stem that every form of one Korean word shares.

    Counting how many distinct words two sentences state is not the question
    ``strip_korean_inflection`` answers.  That reader locates where a word's
    role marking ends, which is what a caller needs to find the boundary of a
    noun, and reading this question off the same inventory miscounts in both
    directions.  It cut ``효과`` down to ``효`` and ``피부과`` down to ``피부``,
    because a noun may end in the syllable a particle is spelled with, so a
    dermatology test and any skin claim counted as one word and a word written
    down as grammar was never the word a comparison saw.  And it kept
    ``개선해`` and ``활용할`` whole, because a predicate carrying a sentence
    forward is not a finite form, so the prose a prompt asks for counted as
    words its source never stated.  Either way a sentence that restated its
    source exactly was read as asserting something the source never said.

    Reduction runs to a fixed point, so a word carrying several markers
    (``피부에서는``) reaches the stem the bare noun does, and the result is
    idempotent: reducing a stem again returns that stem.  That is what lets a
    list of words be registered once, in the form this comparison reads, rather
    than in every spelling the word might arrive in.

    Only role marking is removed -- a case particle, a finite ending, a light
    verb's continuation -- so what remains is the noun or predicate stem that
    states the fact, and a caller comparing stems still has to find that fact
    in its source.
    """

    stem = value
    while True:
        reduced = _KOREAN_PREDICATE_INFLECTION.sub("", stem) or stem
        if reduced == stem:
            reduced = _strip_korean_light_verb_continuation(stem)
        if reduced == stem:
            reduced = _strip_korean_case_particle(stem)
        if not reduced or reduced == stem:
            return stem
        stem = reduced


def korean_word_is_role_marking_only(value: str) -> bool:
    """Return whether a Korean word spells a role and states nothing.

    A stem states a fact and the ending on it only marks how the clause uses
    that stem, so a word that is *nothing but* an ending has no fact in it.
    Korean writes several such words -- the light verb standing alone as
    ``합니다``, ``됩니다``, ``하는``, ``하고`` -- where English writes a separate
    auxiliary.  A comparison that counts them as words read a sentence
    restating its source exactly ("…견고하게 합니다" beside "…견고하게 하는") as
    asserting a word the source never used, because the ending it re-spelled
    was the only difference.

    A one-syllable word is never read this way: it may be a numeral (``한``) or
    a noun, and there the ending's spelling is the whole word by coincidence
    rather than because the word is an ending.
    """

    word = value.strip()
    return len(word) > 1 and not _KOREAN_PREDICATE_INFLECTION.sub("", word)


# A coordinating or subordinating connective closes the clause it ends.  The
# suitability contract reads the same boundary to scope an audience's clause, so
# the two share this one definition; it lives here because that contract imports
# this module and not the other way around.
KOREAN_CLAUSE_BOUNDARY = re.compile(rf"{_KOREAN_CLAUSE_ENDING}\s")
_KOREAN_SUBJECT_MARKER = re.compile(r"(?:은|는|이|가)$")
_KOREAN_LIGHT_VERB_STEM = re.compile(r"(?:하|되)$")


def states_its_own_subject(value: str) -> bool:
    """Return whether a Korean clause names the subject its predicate is about.

    Prepending a topic-marked product name to such a clause gives one sentence
    two subjects, which is not Korean.  Whether a clause marks one and which
    noun it marks are the same reading, so this answers the first from the
    second.
    """

    return bool(korean_subject_noun(value))


def korean_subject_noun(value: str) -> str:
    """Return the noun a Korean clause marks as the subject of what it states.

    A clause attributes what it says to one argument, and two clauses built from
    the same words differ only in which argument that is: a source joining two
    attributions (``판테놀은 … 돕고, 베타인은 …``) carries both sets of words,
    so a reader that only asks which words a source states cannot tell a
    restatement from a swap.  Holding the marked noun fixed is what tells them
    apart, and Korean marks it on the noun itself, so it can be read wherever
    the noun stands.

    The first marked noun is the one the clause predicates of; the scan that
    asks *whether* a clause marks any reads the same words for the same reasons,
    so both answers come from here.  A market that orders its subject instead of
    marking it leaves nothing here to read, and a caller comparing two clauses
    word for word already has the subject among those words there.

    Stopping at the first particle would read only the opening phrase, and a
    subject may be modified by a relative clause that puts its own object first
    (``피부장벽을 강화하는 세라마이드가 …``).  The scan there would end on
    ``피부장벽을`` and never reach ``세라마이드가``.

    A particle attaches to a noun phrase, so the head it attaches to carries the
    weight of a noun.  ``젖은 모발`` is a verb form modifying the noun after it,
    not a subject, and a single-syllable head before 은/는 is that form rather
    than a noun.  A longer verb form read as a subject only withholds the
    product name, which leaves the source clause standing on its own and
    grammatical; missing a real subject is what produces two of them.

    The scan reads the whole sentence.  Bounding it at a connective would need
    to tell a connective ending from a lexicalized adverb that ends in the same
    syllables (``언제든지``, ``무엇이든지``), and this package has no morphology
    to do that; cutting on the shared substring instead loses the real subject
    and puts a second one in front of it.  A coordinate clause's subject is
    therefore still counted as this clause's -- a tracked gap, recorded in
    ``test_renderer_subject_collision`` -- which only withholds the product name
    and leaves the source clause grammatical.  A caller that reads one clause at
    a time hands this reader that clause and sees only its own subject.
    """

    for word in value.split():
        stem = re.sub(r"[.,;:!?)\]]+$", "", word.strip())
        marker = _KOREAN_SUBJECT_MARKER.search(stem)
        head = stem[: marker.start()] if marker is not None else ""
        if marker is None or len(head) < 2:
            continue
        # 하다/되다 turn a noun into a verb, and the 은/는 that follows such a
        # stem is the ending that makes it modify the noun after it, not a
        # topic marker on a subject.  ``추천하는 클렌징 폼입니다`` names no
        # subject; reading one there withholds the product name from a
        # sentence that needs it.
        if _KOREAN_LIGHT_VERB_STEM.search(head):
            continue
        return head
    return ""


def korean_sentence_opens_with_a_constituent(value: str) -> bool:
    """Return whether a Korean sentence starts a phrase rather than continuing one.

    A particle attaches to the phrase before it, so a sentence whose first word
    is nothing but a particle is the tail of a sentence that was split, not one
    that can stand on its own.  Quoting such a tail strands the particle at the
    front of published copy.
    """
    words = value.strip().split()
    return bool(words) and strip_korean_particle(words[0]) != ""


def korean_phrase_head_token(value: str) -> str:
    text = re.sub(r"[.!?。！？,，·;:]+$", "", value.strip()).strip()
    return text.split()[-1] if text.split() else ""


def is_separator_joined_list(value: str) -> bool:
    text = value.strip()
    return bool(re.search(r"(?<!\d)\s*[,;、·／]|[,;、·／]\s*(?!\d)", text))


def _has_coda(syllable: str) -> bool:
    return _is_hangul(syllable) and (ord(syllable) - 0xAC00) % 28 != 0


def korean_object_slot_phrase(value: str) -> str | None:
    text = re.sub(r"[.!?。！？]+$", "", value.strip()).strip()
    if not text:
        return None

    def nominalize(match: re.Match[str]) -> str:
        tail = match.group(1)
        if tail is None:
            return "" if match.end() == len(text) else match.group(0)
        connective = tail.strip()
        if connective not in {"와", "과"}:
            return tail
        prior = text[: match.start()].rstrip()
        return "과" if prior and _has_coda(prior[-1]) else "와"

    result = re.sub(r"(?:해\s*줍니다|합니다)(\s*(?:와|과|및|,))?", nominalize, text)
    result = re.sub(r"\s{2,}", " ", result).strip()
    return result if result and not is_korean_complete_sentence(result) else None


isKoreanPoliteSentenceEnding = is_korean_polite_sentence_ending
isKoreanCompleteSentence = is_korean_complete_sentence
isCompleteSentence = is_complete_sentence
isAtomicFactPhrase = is_atomic_fact_phrase
stripKoreanParticle = strip_korean_particle
koreanClauseBoundary = KOREAN_CLAUSE_BOUNDARY
statesItsOwnSubject = states_its_own_subject
koreanPhraseHeadToken = korean_phrase_head_token
isSeparatorJoinedList = is_separator_joined_list
koreanObjectSlotPhrase = korean_object_slot_phrase

def english_subjectless_predicate(value: str) -> bool:
    """Recognize a finite English predicate that has no visible subject.

    A product feed and an OCR results panel both write a claim as a bare
    predicate -- ``Detangles wet hair``, ``IMPROVES THE LOOK OF SKIN
    ELASTICITY``.  The only safe rewrite is to supply the already structured
    product entity as its subject.  A conservative inflection check avoids
    treating a benefit label such as ``Dryness relief`` or ``Glass skin glow``
    as a predicate merely because a later word looks descriptive.
    """

    match = re.match(
        r"^(?:[A-Za-z][A-Za-z'-]*ly\s+)?(?P<predicate>[A-Za-z][A-Za-z'-]{2,})\s+\S+",
        re.sub(r"\s+", " ", value).strip(),
        re.IGNORECASE,
    )
    if match is None:
        return False
    predicate = match.group("predicate").casefold()
    if predicate.endswith(("ss", "us", "is", "ness", "ity", "ment", "tion", "sion")):
        return False
    return predicate.endswith("s")

def publishable_stems(value: str, *, without: tuple[str, ...] = ()) -> set[str]:
    """Return what a text carries, reduced to the stems its words sit on.

    An ending is not a different word: the same predicate closes a clause as
    "돕고" and a sentence as "돕습니다".  Function words carry no fact, and a
    name the caller excludes is named by every sentence that asserts anything
    of it, so neither counts toward what a text states.
    """

    def stem_of(token: str) -> str:
        return korean_predicate_stem(token) if re.search(r"[가-힣]", token) else token.casefold()

    # The excluded names are compared as stems too.  Comparing a raw token
    # against a stemmed one left every inflected mention of an excluded name
    # standing ("클렌징폼은" beside the excluded "클렌징폼"), which then read as
    # a word the text states of its own.
    excluded = {
        stem_of(token) for name in without for token in re.findall(r"[A-Za-z0-9%]+|[가-힣]+", name)
    }
    stems: set[str] = set()
    for token in re.findall(r"[A-Za-z0-9%]+|[가-힣]+", value):
        stem = stem_of(token)
        if stem and stem not in excluded and stem not in ENGLISH_FUNCTION_WORDS:
            stems.add(stem)
    return stems


def states_only_what_the_source_states(candidate: str, source: str) -> bool:
    """Return whether a rewrite adds no word the source did not carry.

    An extractor files both the line a page printed and the sentence it reads
    that line as.  The read sentence is publishable exactly when it only
    supplies the grammar the line lacked -- every word it carries is a word the
    line carried.  One word more is a fact the page did not state.
    """

    if not candidate or not source:
        return False
    return publishable_stems(candidate) <= publishable_stems(source)
