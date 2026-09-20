"""Fitness statements that qualify who a product suits.

A direction tells a reader to do something.  A fitness statement tells a reader
whom the product is for.  Both mention the product and the skin, so the two are
told apart by structure, not by which adjective or verb was chosen:

1. the complement has to **name an audience** — a class of users, or a skin/hair
   substrate under a qualifier.  A tool, a place, a time, or an abstract noun
   carries the same particle and is not an audience;
2. the predicate has to stand in **fitness position** — the main predicate of
   the audience's own clause.  Any predicate there states fitness, so
   ``적합합니다``, ``알맞습니다``, ``무방합니다``, ``잘 맞습니다``, ``is ideal
   for`` and ``is gentle enough for`` are read alike and no predicate vocabulary
   is enumerated;
3. the sentence has to **assert** it.  A question asks whether a target
   qualifies, a negation excludes one, and a sentence whose predicate belongs to
   some other overt argument (``민감성 피부에는 자극이 나타날 수 있습니다``) is
   about that argument.  None of the three states fitness, and reading a caution
   as fitness inverts the audience it publishes.

This module owns no procedure grammar and imports nothing from ``usage``: the
usage contract consults it, so the dependency may only run in that direction.
"""

from __future__ import annotations

import re

from .sentence_form import KOREAN_CLAUSE_BOUNDARY as _KOREAN_CLAUSE_BOUNDARY
from .sentence_form import is_korean_complete_sentence, split_into_sentences

# What a cosmetic product can be suitable *for*.  This is domain identity — the
# entities that can hold the audience role — not a rule spelled out as keywords:
# the rules above are structural and apply to whatever fills this slot.  A
# substrate needs a qualifier because a segment, not a surface, is an audience:
# ``민감성 피부``/``dry skin`` names who, bare ``피부``/``skin`` names where.
_KOREAN_SUBSTRATE = r"피부(?:\s*(?:타입|톤|결|고민))?|모발|머릿결|두피|헤어|손톱|입술|부위"
# Named features a product can be made for.  Like a person class they carry the
# audience on their own, so they take no qualifier.
_KOREAN_NAMED_TARGET = r"속눈썹|눈썹"
_KOREAN_PERSON_CLASS = (
    r"신생아|영유아|유아|아기|어린이|아이들|청소년|성인|남성|여성|임산부|임신부|수유부|산모|"
    r"노년층|고령자|어르신|온\s*가족|가족|누구나"
)
_ENGLISH_SUBSTRATE = r"skin(?:\s+(?:types?|tones?|concerns?))?|hair|scalp|lips|nails|areas?"
_ENGLISH_PERSON_CLASS = (
    r"newborns?|infants?|babies|toddlers?|preschoolers?|children|kids|teens?|adults?|seniors?|elders|"
    r"men|women|mothers?|parents?|families|everyone|anyone|people|users?|customers?|"
    r"eyelashes|lashes|brows"
)
_ENGLISH_QUALIFIER_WORD = r"(?!for\b|on\b|with\b|to\b|by\b|from\b)[\w-]+[\s,-]+"
_ENGLISH_AUDIENCE = (
    rf"(?:(?:{_ENGLISH_QUALIFIER_WORD}){{1,4}}?(?:{_ENGLISH_SUBSTRATE})"
    rf"|(?:{_ENGLISH_QUALIFIER_WORD}){{0,4}}?(?:{_ENGLISH_PERSON_CLASS}))(?![\w-])"
)

# A case particle closes its own phrase, so the token before a substrate is a
# qualifier only when it carries none.  ``민감성 피부에`` qualifies; in ``제품은
# 피부에`` the substrate is bare and ``제품은`` belongs to another phrase.  The
# genitive is the exception: it builds one phrase (``아기의 피부에``).
_KOREAN_PHRASE_CLOSING_PARTICLE = re.compile(r"(?:은|는|이|가|을|를|에|도|로|와|과|만|께|서)$")
# A bound noun names a time, a place or a stage relative to what precedes it --
# ``세안 중 피부``, ``사용 후 피부``.  It stands in the qualifier's slot without
# naming a segment, so a substrate behind one is the surface being talked about
# and not the customer the product is for.
_KOREAN_BOUND_NOUN = re.compile(r"^(?:중|후|전|시|내|간|외|말|초|측|속)$")
_KOREAN_AUDIENCE_COMPLEMENT = re.compile(
    rf"(?:(?P<qualifier>[^\s]+)\s*(?:{_KOREAN_SUBSTRATE})|(?:{_KOREAN_PERSON_CLASS})|(?:{_KOREAN_NAMED_TARGET}))"
    # Only the inclusive markers.  ``-는`` is the contrastive topic: attached to
    # a locative it sets this target apart from the others, which is the shape of
    # a restriction (``민감성 피부에는 …``).  A fitness statement includes its
    # audience (``-에``, ``-에도``); it does not single it out.  A positive
    # statement written that way is lost, and that is the intended direction:
    # polarity that cannot be read structurally must fail closed.
    r"(?:에게도|에게|에도|에)(?!는)"
    # The predicate is read in a lookahead so one rejected complement cannot
    # swallow a qualifying one later in the same sentence.
    r"(?=(?P<rest>[^.!?。！？]*)(?:[.!?。！？]|$))"
)

# Telling a reader to avoid the product, or to be careful with it, cannot be done
# in the same sentence as recommending it to that audience.  This test reads the
# *whole sentence* rather than the audience's clause, for the same reason the
# assertion test does: a directive revokes the recommendation whichever clause
# carries it.  It stops at the sentence, though — a caution standing beside a
# fitness sentence is its neighbour's, exactly as a procedure's cues are.
#
# It is read from the grammar of directing, not from a list of cautions.  Korean
# marks obligation with ``-아/어/여야 하-``/``-되-`` — read at the ``야`` that closes
# the construction, because both sides contract: ``피하 + 어야`` surfaces as ``피해야``
# and the following ``하-``/``되-`` surfaces as ``합니다``/``됩니다``
# — prohibition with ``-지 마-``,
# and necessity of caution with ``주의 … 필요``; English uses its obligation modals
# under a reader subject, and its negative
# imperative.  The one domain term is the act this contract regulates: a clause
# that opens on a word governing the bare noun ``use`` (``discontinue use``,
# ``avoid use``) directs the reader about using the product.
_AVOIDANCE_DIRECTIVE = re.compile(
    r"야\s*[하해합했한할되돼됩됐된될]|지\s*마|주의[가는를]?\s*필요"
    # An obligation modal directs only when its subject is the reader.  ``This
    # should suit sensitive skin`` predicts fitness of the product; ``sensitive
    # skin users should patch test`` tells a person what to do.
    rf"|\b(?:you|{_ENGLISH_PERSON_CLASS})\b[^.;]{{0,40}}?\b(?:should|must|needs?\s+to|ha(?:s|ve)\s+to)\b"
    r"|\bdo\s+not\b|\bdon['’]?t\b"
    # A clause opening on a word that governs the bare noun ``use`` directs the
    # reader about using the product.  A comma coordinates clauses as ``;`` does,
    # so it opens one too.  When ``use`` heads its own predication instead
    # (``daily use is enough``) it is the subject, not the thing directed.
    r"|(?:^|[;.,]\s*)[A-Za-z]+\s+use\b"
    # An appositive set off by commas may stand between that subject and its
    # predicate (``daily use, twice a day, is suitable``).  Requiring the
    # predicate to be adjacent would let one comma decide the reading, and
    # capping the appositive's length would let its word count decide it; both
    # measure typography rather than grammar.  The commas delimit it.
    r"(?!(?:\s*,[^;.]*?,)?\s+(?:is|are|was|were|can|may|might|could|will|would|should|must|has|have))",
    re.IGNORECASE,
)
# The passive puts the directed reader after the verb: ``should be avoided by
# pregnant women`` directs a group as plainly as ``pregnant women should avoid``.
# Which participle the agent belongs to is grammar, and is read below rather than
# guessed from punctuation or distance.
_ENGLISH_OBLIGATION_PASSIVE = re.compile(
    r"\b(?:should|must|needs?\s+to|ha(?:s|ve)\s+to)\s+(?:not\s+)?(?:\w+ly\s+)?(?:be|been)\s+(?:\w+ly\s+)?",
    re.IGNORECASE,
)
_ENGLISH_PARTICIPLE = re.compile(r"\b[A-Za-z]{2,}(?:ed|en)\b", re.IGNORECASE)
# A modal governs its own participle and every participle coordinated with it.
_ENGLISH_COORDINATED_PARTICIPLES = re.compile(
    r"[A-Za-z]{2,}(?:ed|en)\b"
    r"(?:\s*,\s*(?:(?:and|or)\s+)?(?:\w+ly\s+)?[A-Za-z]{2,}(?:ed|en)\b"
    r"|\s+(?:and|or)\s+(?:\w+ly\s+)?[A-Za-z]{2,}(?:ed|en)\b)*",
    re.IGNORECASE,
)
_ENGLISH_BY_AGENT = re.compile(
    rf"\bby\s+(?:{_ENGLISH_QUALIFIER_WORD}){{0,3}}?(?:{_ENGLISH_PERSON_CLASS})(?![\w-])", re.IGNORECASE
)


def _obligation_directs_a_person_class(value: str) -> bool:
    """Return whether a modal's passive names the group of people it directs.

    The agent belongs to the participle nearest before it, so the sentence
    directs only when that participle is one the modal governs -- its own, or one
    coordinated with it (``must be washed, rinsed, and avoided by pregnant
    women``).  A participle inside a noun phrase the modal does not govern
    carries its own agent (``must be the top pick, loved by mothers``), and
    reading that as a direction revokes an unrelated fitness statement.
    """

    for head in _ENGLISH_OBLIGATION_PASSIVE.finditer(value):
        governed = _ENGLISH_COORDINATED_PARTICIPLES.match(value, head.end())
        if governed is None:
            continue
        governed_starts = {match.start() for match in _ENGLISH_PARTICIPLE.finditer(governed.group())}
        governed_starts = {governed.start() + start for start in governed_starts}
        for agent in _ENGLISH_BY_AGENT.finditer(value, head.end()):
            nearest = max(
                (match.start() for match in _ENGLISH_PARTICIPLE.finditer(value[: agent.start()])), default=None
            )
            if nearest is not None and nearest in governed_starts:
                return True
    return False


# Mood.  An instruction and a question are not assertions of fitness.
_KOREAN_DIRECTIVE_ENDING = re.compile(r"(?:세요|십시오|시오|해라|하라|자)\s*$")
_INTERROGATIVE = re.compile(r"(?:[?？]|나요|까요|습니까)[?？]?\s*$")
# The usage contract owns its own copy of this boundary; it consults this module,
# so the two cannot share one without a cycle.
# Polarity, read structurally and failing closed.  Nothing in the grammar marks
# an adverse predicate as adverse, so a fitness reading is withheld wherever the
# shape of the sentence leaves polarity undecided.  A genuine positive statement
# written in one of these shapes is lost; publishing a caution as a
# recommendation target is not a comparable cost.
#
# Syntactic negation: it reaches the modality through the stem it governs
# (``적합하지 않을 수 있``), so the long form is read wherever it sits.
_KOREAN_NEGATION = re.compile(r"지\s*(?:않|못)|(?:^|\s)(?:안|못)\s|수\s*없")
# Morphological negation: the Sino prefixes 부/불/비/무/미 turn their root into
# its own denial, and they attach to a ``하다`` predicate (``부적합하다``,
# ``부족하다``).  Native adjectives that merely start with the same syllable
# (``부드럽다``, ``무겁다``) take no ``하``, so the shape tells them apart.
_KOREAN_MORPHOLOGICAL_NEGATION = re.compile(r"(?:부|불|비|무|미)[가-힣]{1,2}(?:하|할|한|함|합|해|했)")
# ``-ㄹ 수 있다`` over a *descriptive* stem is epistemic hedging about a state
# (``자극적일``, ``따가울``), not the ability reading a fitness statement carries.
# The copula and the ㅂ-irregular endings mark that stem class.  ``되다`` is not
# in it: it is the ordinary passive, and ``사용될 수 있다`` says exactly what
# ``사용할 수 있다`` says.  An adverse ``되다`` predicate takes its patient as the
# subject (``민감성 피부는 자극될 수 있습니다``), which names no audience here.
_KOREAN_DESCRIPTIVE_POSSIBILITY = re.compile(r"(?:일|울|로울|스러울|려울|꺼울)\s*수\s*있")
# The audience's own clause ends at the first connective ending (연결어미).  What a
# later coordinated clause says belongs to that clause: ``민감성 피부에 적합하며
# 향료는 넣지 않았습니다`` states fitness and then a separate positive claim, and
# reading its negation as the fitness predicate's would deny the fitness because
# of it.  This is the Korean form of reading polarity where the predicate is.

# An overt nominative or accusative argument owns the predicate.  ``자극이 나타날
# 수 있습니다`` predicates of the irritation and ``사용을 피할 수 있습니다``
# predicates of the use; neither predicates fitness of the audience.
_KOREAN_COMPETING_ARGUMENT = re.compile(r"[가-힣]+(?:이|가|을|를)(?=\s)")

# English polarity is read on the predicative head — the word that actually takes
# ``for <audience>`` — not anywhere in the text.  ``non-comedogenic``,
# ``non-greasy`` and ``unscented`` are positive claims that sit beside a fitness
# statement constantly, and reading the whole text would deny the fitness because
# of them.  ``in``/``im`` are deliberately absent: they also open ``intended
# for``, a live positive.  No participle rule: ``be irritating``/``be hydrating``
# share one construction, so it carries no polarity at all.
_ENGLISH_ADVERSE_HEAD = re.compile(r"^(?:un|non|dis)[a-z-]+$", re.IGNORECASE)
# ``too X for Y`` states that the product overshoots its target rather than fits
# it.  The degree word governs the head, so the pair is read together.
_ENGLISH_DEGREE_EXCESS = re.compile(r"\btoo\s+[\w-]+\s*$", re.IGNORECASE)
# ``for``/``on``/``with`` mark what the product suits; ``by`` opens the passive
# agent, so what follows it performs the action instead of receiving it and is
# not the audience being qualified.
# A predicative slot may be a coordination (``non-comedogenic and suitable``);
# the head is its last word, because that is the one ``for`` attaches to.
_ENGLISH_FITNESS_POSITION = re.compile(
    rf"(?:(?:^|[.;:]\s*)(?!not\b|never\b)(?P<opening>(?:[\w-]+\s+){{0,2}})"
    # Only after a copula may the slot be a coordination of predicatives.  At the
    # opening of a sentence the same shape is a coordination of verbs, and
    # ``help rejuvenate and strengthen for healthy skin`` states a purpose, not
    # whom the product suits.
    rf"|\b(?:is|are|was|were|be|been|being)\s+(?!not\b|never\b)"
    rf"(?P<predicative>(?:[\w-]+\s+){{0,2}}(?:(?:and|or)\s+[\w-]+\s+)?))"
    rf"for\s+(?:the\s+|all\s+)?{_ENGLISH_AUDIENCE}"
    rf"|\b(?:can|may|could|might)\s+(?!not\b|never\b)(?:\w+\s+){{0,2}}be\s+(?P<participle>\w+(?:ed|n))\b"
    rf"(?:\s+(?!by\b|to\b|from\b)\w+){{0,2}}\s+(?:on|for|with)\s+(?:the\s+|all\s+)?{_ENGLISH_AUDIENCE}",
    re.IGNORECASE,
)


# The audience read on its own, without the predicate that would make the text a
# statement about it.  ``is_suitability_statement`` answers whether a sentence
# says someone suits the product; this reads the narrower question of which
# customers a sentence names at all, which is what a caller comparing a
# recommendation against its source needs.
_KOREAN_AUDIENCE_DESIGNATION = re.compile(
    rf"(?:(?P<qualifier>[^\s]+)\s*(?:{_KOREAN_SUBSTRATE})|(?:{_KOREAN_PERSON_CLASS})|(?:{_KOREAN_NAMED_TARGET}))"
)
_ENGLISH_AUDIENCE_DESIGNATION = re.compile(rf"\b(?:{_ENGLISH_AUDIENCE})", re.IGNORECASE)


def audience_designations(value: str) -> list[str]:
    """Return the phrases in a text that name a customer the product can be for.

    A qualified substrate is returned whether the qualifier names a segment or a
    state (``dry skin``, ``damp skin``); which of the two a sentence is about is
    what the fitness predicate decides, and this function deliberately stops
    before it.  A coordinate modifier likewise shares the head noun it precedes
    (``지성이거나 민감한 피부``), and this package has no morphology to split that
    coordination, so only the modifier adjacent to the substrate is returned.
    Both limits are recorded in ``test_suitability_vs_procedure``: each one
    narrows what a caller comparing a recommendation against its source can
    check, and neither invents a designation that is not there.
    """

    text = re.sub(r"\s+", " ", value).strip()
    designations: list[str] = []
    for match in _KOREAN_AUDIENCE_DESIGNATION.finditer(text):
        qualifier = match.group("qualifier")
        if qualifier is not None and (
            _KOREAN_PHRASE_CLOSING_PARTICLE.search(qualifier) is not None
            or _KOREAN_BOUND_NOUN.match(qualifier) is not None
        ):
            continue
        designations.append(match.group(0).strip())
    designations.extend(match.group(0).strip() for match in _ENGLISH_AUDIENCE_DESIGNATION.finditer(text))
    return designations


def is_suitability_statement(value: str) -> bool:
    """Return whether a sentence states that a named audience suits the product.

    The predicate reads every market grammar rather than one locale's: PDP source
    text routinely mixes scripts, and an English fitness sentence on a Korean page
    states the same fact about the same product.
    """

    text = re.sub(r"\s+", " ", value).strip()
    return any(_sentence_states_fitness(sentence) for sentence in split_into_sentences(text))


def _sentence_states_fitness(sentence: str) -> bool:
    text = sentence.strip()
    if (
        _INTERROGATIVE.search(text) is not None
        or _AVOIDANCE_DIRECTIVE.search(text) is not None
        or _obligation_directs_a_person_class(text)
    ):
        return False
    # A Korean directive ending closes the sentence even when the fitness claim
    # sits in an earlier clause, so it is read here as well as inside the clause.
    if _KOREAN_DIRECTIVE_ENDING.search(text.rstrip(" .!?。！？")) is not None:
        return False
    if any(_states_english_fitness(match) for match in _ENGLISH_FITNESS_POSITION.finditer(text)):
        return True
    return any(_states_korean_fitness(match) for match in _KOREAN_AUDIENCE_COMPLEMENT.finditer(text))


def _states_english_fitness(match: re.Match[str]) -> bool:
    predicative = match.group("opening") or match.group("predicative")
    if predicative is None:
        # The modal-passive branch carries no predicative slot.  Its participle is
        # the head the audience hangs off, so it is read by the same rule rather
        # than left unread: ``can be unsuited for …`` denies its stem exactly as
        # ``is unsuitable for …`` does.
        participle = match.group("participle")
        return participle is None or _ENGLISH_ADVERSE_HEAD.match(participle) is None
    if _ENGLISH_DEGREE_EXCESS.search(predicative) is not None:
        return False
    head = predicative.split()
    return not head or _ENGLISH_ADVERSE_HEAD.match(head[-1]) is None


def _states_korean_fitness(match: re.Match[str]) -> bool:
    qualifier, predicate = match.group("qualifier"), match.group("rest").strip()
    if qualifier is not None and _KOREAN_PHRASE_CLOSING_PARTICLE.search(qualifier) is not None:
        return False
    # Assertion is a property of the sentence: a clause ending in a connective is
    # never complete on its own.  Everything about the predicate is then read in
    # the audience's own clause.
    if not is_korean_complete_sentence(predicate):
        return False
    if _negation_denies_the_fitness_predicate(predicate):
        return False
    clause = _audience_clause(predicate)
    if (
        _KOREAN_NEGATION.search(clause) is not None
        or _KOREAN_MORPHOLOGICAL_NEGATION.search(clause) is not None
        or _KOREAN_DESCRIPTIVE_POSSIBILITY.search(clause) is not None
    ):
        return False
    return _KOREAN_COMPETING_ARGUMENT.search(clause + " ") is None


# A negation is bound to the stem before it, so which predicate it denies can be
# read from that stem's position rather than from a clause boundary.  Another
# clause announces itself either with its own argument or with a derived
# predicate closing on a connective; the ``하``/``되`` suffix is the same
# productive morpheme the morphological-negation test above already reads.
_KOREAN_BOUND_NEGATION = re.compile(r"지\s*(?:않|못)|수\s*없")
# Only a case-marked argument brings a predicate of its own: ``자극이 생기지
# 않습니다`` denies the irritation, not the fitness.  The topic marker brings
# none.  ``-은/는`` marks what the sentence is about, and Korean lets the topic
# stand after the audience it is being judged against -- in ``민감성 피부에 이
# 제품은 적합하지 않습니다`` the negated stem is still the fitness predicate, and
# reading the topic as another clause publishes an exclusion as a recommendation.
_KOREAN_ARGUMENT_MARK = re.compile(r"[가-힣](?:을|를|이|가)(?=\s)")
_KOREAN_DERIVED_PREDICATE_CONNECTIVE = re.compile(
    r"(?:하|되)(?:며|고|지만|면서|거나|어서|아서|여서|는데|은데|니까|으나)(?=\s)"
)


def _negation_denies_the_fitness_predicate(predicate: str) -> bool:
    """Return whether a negation denies the predicate the audience's clause states.

    The clause detector stops at a connective's syllables, which also end
    lexicalized adverbs (``언제든지``), and a negation past that point is then
    never read -- publishing ``적합하지 않습니다`` as a recommendation.  Reading the
    negation's own attachment does not need that boundary: nothing between the
    audience and the negated stem means the negation denies fitness itself.
    """

    negation = _KOREAN_BOUND_NEGATION.search(predicate)
    if negation is None:
        return False
    preceding = predicate[: negation.start()]
    return (
        _KOREAN_ARGUMENT_MARK.search(preceding) is None
        and _KOREAN_DERIVED_PREDICATE_CONNECTIVE.search(preceding) is None
    )


def _audience_clause(predicate: str) -> str:
    boundary = _KOREAN_CLAUSE_BOUNDARY.search(predicate)
    return predicate[: boundary.end()] if boundary is not None else predicate


__all__ = ["audience_designations", "is_suitability_statement"]
