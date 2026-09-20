"""Shared deterministic judgments for product usage text."""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Sequence

from neo_js_compat import js_code_unit_length

from .sentence_form import split_into_sentences
from .suitability import is_suitability_statement

_CONTROL_CHARACTERS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")
_SOURCE_SECTION_HEADING_PREFIX = re.compile(r"^\s*(?:[A-Z][A-Z0-9&'’/\-]*\s+){0,4}[A-Z][A-Z0-9&'’/\-]*\s*:\s*")
_WASH_ACTION_CUE = re.compile(
    r"(?:씻어(?:내|낸|주|줍|냅|서|요)|씻습니다|씻으(?:세요|십시오)|씻고|씻은\s*(?:뒤|후)|세안(?:하고|하며|해|하세요|하십시오|합니다|한\s*(?:뒤|후))|닦아(?:\s*내|\s*주|서)|wash\s+(?:off|away|with|your|the)|洗い流)",
    re.IGNORECASE,
)
_PROCEDURE_ACTION_CUE = re.compile(
    r"(?:덜어|적셔|올려두|펴\s*바르|펴\s*바릅|펴\s*발라|바르(?:고|며|듯|세요|십시오|기|면|는|도록)|바릅|바른\s*후|발라(?:주|주세요|줍니다|서|가며)|두드려|흡수(?!감)|마사지|문지르|헹구|헹굽|거품|도포(?!감)|분사(?!력)|뿌려|뿌리(?:세요|십시오|고)|스프레이|마무리(?:해|하세요|합니다|하십시오)|사용(?:해|하세요|합니다|하십시오)|apply|dispense|spread|smooth|pat|press|absorb|massage|lather|rinse|pump|take|spray|spritz|dot|tap|use\s+as|なじませ|塗布|すすぎ|マッサージ|吹きかけ|噴射)",
    re.IGNORECASE,
)
_ROUTINE_PLACEMENT_CUE = re.compile(
    r"(?:아침|저녁|매일|데일리|스킨케어|샤워\s*후|세안\s*후|마지막\s*단계|첫\s*단계|루틴|morning|night|daily|routine|after\s+(?:cleansing|shower)|last\s+step|first\s+step|朝|夜|毎日|スキンケア|洗顔後|最後のステップ)",
    re.IGNORECASE,
)
_USAGE_AMOUNT_OR_TOOL = re.compile(
    r"(?:적당량|소량|충분량|손바닥|손에|화장솜|얼굴|눈가|손가락|피부결|미온수|물과\s*함께|appropriate amount|small amount|palm|hands?|fingers?|fingertips?|cotton pad|face|skin|neck|eyes?|under-eye|water|適量|手のひら|顔|目元|指|肌|コットン)",
    re.IGNORECASE,
)
_USAGE_ORDER = re.compile(
    r"(?:후|뒤|다음|먼저|마지막|단계|순서|때는|\bthen\b|\bafter\b|\bbefore\b|\bnext\b|\bfinally\b|\bstep\b|\bwhen\b|後|次|最後)",
    re.IGNORECASE,
)
_USAGE_IMPERATIVE = re.compile(
    r"(?:주세요|줍니다|합니다|하세요|하십시오|바릅니다|흡수시킵니다|헹굽니다|\buse\b|\bapply\b|\bdispense\b|ます|してください)",
    re.IGNORECASE,
)
_USAGE_CADENCE = re.compile(r"(?:아침|저녁|매일|데일리|morning|night|daily|twice|once|朝|夜|毎日)", re.IGNORECASE)
_DESCRIPTIVE_APPLICATION_FRAME = re.compile(
    r"(?:바르는\s*순간|사용(?:할\s*때마다|하는\s*순간)|도포\s*직후|on\s+application|upon\s+application|when\s+(?:used|applied)|with\s+each\s+use|塗った瞬間|使用(?:時|する瞬間)|使うたび)",
    re.IGNORECASE,
)
_SENSORY_EVALUATION_FRAME = re.compile(
    r"(?:테스트|시험|사용감|마무리감|수분감|보습감|흡수감|끈적임|산뜻|촉촉|느껴지는|진정되는|피부가\s*진정|부드러운|피부결이\s*부드러운|use[-\s]?feel|finish(?:es)?|non[-\s]?sticky|stickiness|fresh\s+feel|dewy|soothing|skin\s+feels?\s+smooth|tested?|sensory|使用感|仕上がり|べたつき|さっぱり|しっとり|うるおい感|なめらか|落ち着|テスト|試験|感じられる)",
    re.IGNORECASE,
)
_DESCRIPTION_BENEFIT = re.compile(
    r"(?:케어|개선|도움|효과|효능|추천|위한|민감|건조|보습|수분|장벽|care|benefit|helps?|supports?|improves?|recommended|for\s+\w+|効果|ケア|改善|おすすめ|向け)",
    re.IGNORECASE,
)
_DESCRIPTION_INGREDIENT = re.compile(
    r"(?:성분|원료|캡슐|포뮬러|기술|ingredient|formula|technology|capsule|成分|処方|技術|カプセル)", re.IGNORECASE
)
_DESCRIPTION_PRODUCT = re.compile(
    r"(?:제품|상품|토너|크림|세럼|로션|클렌저|product|toner|cream|serum|lotion|cleanser|商品|製品|化粧水|クリーム|美容液)",
    re.IGNORECASE,
)
_CONCISE_IMPERATIVE = re.compile(
    r"^(?:apply|dispense|massage|lather|rinse|pat|press|spread|smooth|warm|pump|remove|leave|spray|spritz|dot|tap)\b",
    re.IGNORECASE,
)
_ACTIONABLE_ENGLISH = re.compile(
    r"\b(?:apply|dispense|massage|lather|rinse|pat|press|spread|smooth|warm|pump|spray|spritz|dot|tap)\b|なじませ|塗布|吹きかけ",
    re.IGNORECASE,
)
_ACTIONABLE_KOREAN = re.compile(
    r"(?:적당량|손에|물과\s*함께|거품\s*내|거품내|얼굴에|문지르|미온수|헹구|화장솜|덜어|펴\s*바르|펴\s*바릅|펴\s*발라|바르(?:고|며|듯|세요|십시오|기|면|는|도록)|바릅|바른\s*후|발라(?:주|주세요|줍니다|서|가며)|마사지(?:하듯|하[고여]|한\s*후|해|하세요|하며)|흡수(?:시켜|시키|될\s*때까지|되도록|해\s*주세요|시킵)|마무리(?:해|하세요|합니다|하십시오)|도포(?:해|하세요|합니다|하십시오|한\s*(?:뒤|후))|분사(?:를)?\s*(?:합니다|하세요|하십시오|해\s*주|한\s*후)|뿌려\s*주|뿌려줍|뿌리세요|뿌리십시오|스프레이(?:를)?\s*(?:합니다|하세요|해))"
)
_ACTIONABLE_KOREAN_WITHOUT_GENERIC_APPLY = re.compile(
    r"(?:적당량|손에|물과\s*함께|거품\s*내|거품내|얼굴에|문지르|미온수|헹구|화장솜|덜어|펴\s*바르|펴\s*바릅|펴\s*발라|발라(?:주|주세요|줍니다|서|가며)|마사지(?:하듯|하[고여]|한\s*후|해|하세요|하며)|흡수(?:시켜|시키|될\s*때까지|되도록|해\s*주세요|시킵)|마무리(?:해|하세요|합니다|하십시오)|도포(?:해|하세요|합니다|하십시오|한\s*(?:뒤|후))|분사(?:를)?\s*(?:합니다|하세요|하십시오|해\s*주|한\s*후)|뿌려\s*주|뿌려줍|뿌리세요|뿌리십시오|스프레이(?:를)?\s*(?:합니다|하세요|해))"
)
_KOREAN_INSTRUCTION_VERB = re.compile(
    r"(?:적당량|손에|물과\s*함께|거품\s*내|거품내|얼굴에|문지르|미온수|헹구|화장솜|덜어|펴\s*바르|펴\s*바릅|펴\s*발라|바르(?:고|며|듯|세요|십시오|기|면|는|도록)|바릅|바른\s*후|발라(?:주|주세요|줍니다|서|가며)|마사지(?:하듯|하[고여]|한\s*후|해|하세요|하며)|흡수(?:시켜|시키|될\s*때까지|되도록|해\s*주세요|시킵)|마무리(?:해|하세요|합니다|하십시오)|도포(?:해|하세요|합니다|하십시오|한\s*(?:뒤|후))|분사(?:를)?\s*(?:합니다|하세요|하십시오|해\s*주|하고|한\s*후)|뿌려\s*주|뿌려줍|뿌리세요|뿌리십시오|스프레이(?:를)?\s*(?:합니다|하세요|해)|사용\s*(?:해|하세요|합니다|하십시오|한다|하시|할\s*때)|(?:샤워|세안|토너|스킨케어|아침|저녁|매일|데일리)[^.!?。！？\n]{0,40}사용(?:합니다|하세요|해\s*주세요|해|$))"
)
_SAFETY_OR_TEST_KOREAN = re.compile(
    r"(?:테스트|시험)\s*완료|사용성\s*테스트|피부\s*자극\s*테스트|피부\s*테스트|안자극|하이포알러지|논코메도제닉|민감\s*피부\s*대상|소아와?\s*피부\s*테스트|소아\s*피부\s*테스트",
    re.IGNORECASE,
)
_SAFETY_OR_TEST_ENGLISH = re.compile(
    r"(?:patch\s*test|patch\s*testing|dermatologist[-\s]?tested|hypoallergenic|non[-\s]?comedogenic|safety\s+test|sensitive\s+skin\s+(?:users?\s+)?should|test\s+on\s+a\s+small\s+area)",
    re.IGNORECASE,
)
_CONCRETE_DISQUALIFYING_SUITABILITY = re.compile(
    r"(?:suitable\s+for|for\s+external\s+use|can\s+be\s+used|daily\s+use|사용할\s*수|사용\s*가능|외용|적합|おすすめ|使用できます)",
    re.IGNORECASE,
)
_CONCRETE_EVIDENCE = re.compile(
    r"(?:%|％|\d+(?:\.\d+)?\s*배|임상|인체\s*적용|자가\s*평가|실험|시험|테스트|측정|평가|결과|대비|\bvs\.?\b|clinical|instrumental|study|test(?:ed)?|result|versus)",
    re.IGNORECASE,
)
_CONCRETE_OUTCOME = re.compile(
    r"(?:개선|증가|감소|높|낮|잔존|효과|효능|improv|increase|decrease|higher|lower|retention|effect)", re.IGNORECASE
)
_CONCRETE_ACTION = re.compile(
    r"\b(?:apply|spread|massage|rinse|press|pat|dispense|mix|remove|leave|warm|spray|spritz|dot|tap|wash\s+(?:off|with|the|your|face|skin|hands?|product))\b|(?:바르|바릅|발라|도포|펴\s*바르|마사지|헹구|씻|세안|닦|두드|흡수|덜어|섞|제거|분사(?:를)?\s*(?:합니다|하세요|하십시오|해\s*주|하고|한\s*후)|뿌려\s*주|뿌려줍|뿌리세요|뿌리십시오|스프레이(?:를)?\s*(?:합니다|하세요|해))|(?:塗|なじませ|洗|すす|押さえ|取って|混ぜ|落と|吹きかけ|噴射)",
    re.IGNORECASE,
)
_CONCRETE_ROUTINE_ACTION = re.compile(
    r"(?:after\s+(?:cleansing|shower|toner)[^.!?]{0,50}\buse|(?:샤워|세안|토너)\s*후[^.!?。！？]{0,50}사용|(?:洗顔|シャワー|化粧水)後[^.!?。！？]{0,50}使用)",
    re.IGNORECASE,
)
_CONTEXT_FREE_FIGURE_RUN = re.compile(
    r"\d+(?:\.\d+)?\s*[%％]\s*[+\-−±*＊※·•]?\s*\d+(?:\.\d+)?\s*[%％]\s*[+\-−±*＊※·•]?\s*\d+(?:\.\d+)?\s*[%％]"
)
_MARKETING_STEP = re.compile(r"(?:\bStep|단계)\s*\d", re.IGNORECASE)
_YEAR = re.compile(r"\b(?:19|20)\d{2}\b")
_NUMBERED_SOURCE_USAGE_MARKER = re.compile(
    r"(?<!\S)(?:step\s*)?(\d+)\s*(?:단계|段階)?(?P<delimiter>[.):、:]?)\s+", re.IGNORECASE
)
_SOURCE_USAGE_SENTENCE_END = re.compile(r"[.!?。！？](?=\s|$)")
_TRAILING_SOURCE_LABEL = re.compile(r"[A-Z0-9][A-Z0-9&'’/.\-]*(?:\s+[A-Z0-9][A-Z0-9&'’/.\-]*){0,7}$")
_EXPLICIT_SOURCE_APPLICATION_CONTEXT = re.compile(
    r"\b(?:cream|serum|cleanser|toner|lotion|mist|skin|face|neck|eye|under-eye|palm|hands?|fingertips?)\b|"
    r"(?:피부|얼굴|목|눈가|손바닥|손끝|크림|세럼|토너|로션|미스트|제품|化粧水|クリーム|美容液|肌|顔)",
    re.IGNORECASE,
)
_EXPLICIT_SOURCE_ENGLISH_APPLICATION_IMPERATIVE = re.compile(
    r"^[A-Za-z][A-Za-z'’\-]*(?:\s+(?:the|a|an|your|this|it|gently|evenly|slowly|directly|onto|across|over|around|with|from))\b",
    re.IGNORECASE,
)
_EXPLICIT_SOURCE_MEASURED_RESULT = re.compile(
    r"(?:\b\d+(?:[.,]\d+)?\s*(?:%|percent)\s+(?:of\s+)?(?:the\s+)?"
    r"(?:users?|participants?|subjects?|women|men|respondents?|reviewers?)\b|"
    r"\b(?:users?|participants?|subjects?|women|men|respondents?)\b[^.!?。！？]{0,80}"
    r"\b(?:reported|saw|noticed|experienced|showed|agreed)\b|"
    r"(?:사용자|참여자|피험자|대상자)[^.!?。！？]{0,80}(?:응답|평가|개선|확인))",
    re.IGNORECASE,
)
_EXPLICIT_SOURCE_STORAGE_OR_DISPOSAL = re.compile(
    r"(?:\b(?:keep|store|recycle|dispose|ship|return)\b[^.!?。！？]{0,100}"
    r"\b(?:packaging|package|carton|box|container|bottle|cap|label|storage|refrigerat\w*)\b|"
    r"(?:보관|재활용|폐기)[^.!?。！？]{0,100}(?:포장|용기|상자|박스|라벨|냉장))",
    re.IGNORECASE,
)


def clean_usage_text(value: str) -> str:
    """Strip transport noise and normalize a candidate usage instruction."""
    text = re.sub(r"```(?:json)?", "", value, flags=re.IGNORECASE)
    text = _CONTROL_CHARACTERS.sub(" ", text)
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"\s+([,.!?;:])", r"\1", text)
    text = re.sub(r"^\s*[-*•]\s*", "", text)
    text = re.sub(r"^\s*\d+[.)]\s*", "", text)
    # OCR/PDP section labels sometimes remain attached to the first procedure
    # sentence (``RITUAL: Warm two drops …``).  The label is structural, not
    # part of the action, so remove only an all-caps heading before evaluating
    # the grammar.  This keeps the original source text available elsewhere
    # while preventing a routed usage block from being mistaken for a benefit.
    text = _SOURCE_SECTION_HEADING_PREFIX.sub("", text)
    return re.sub(r"^\s*(?:Q|A)[.:]\s*", "", text, flags=re.IGNORECASE).strip()


def has_wash_action_cue(value: str) -> bool:
    return _WASH_ACTION_CUE.search(value) is not None


def has_procedure_action_cue(value: str) -> bool:
    return has_wash_action_cue(value) or _PROCEDURE_ACTION_CUE.search(value) is not None


def has_routine_placement_cue(value: str) -> bool:
    return _ROUTINE_PLACEMENT_CUE.search(value) is not None


def usage_procedure_signal_score(value: str) -> int:
    text = clean_usage_text(value)
    return sum(
        (
            _USAGE_AMOUNT_OR_TOOL.search(text) is not None,
            has_procedure_action_cue(text),
            _USAGE_ORDER.search(text) is not None,
            _USAGE_IMPERATIVE.search(text) is not None,
            _USAGE_CADENCE.search(text) is not None,
        )
    )


def usage_description_signal_score(value: str) -> int:
    text = clean_usage_text(value)
    return sum(
        (
            2 if has_descriptive_application_frame(text) else 0,
            2 if has_sensory_evaluation_frame(text) else 0,
            _DESCRIPTION_BENEFIT.search(text) is not None,
            _DESCRIPTION_INGREDIENT.search(text) is not None,
            _DESCRIPTION_PRODUCT.search(text) is not None,
        )
    )


def has_descriptive_application_frame(value: str) -> bool:
    return _DESCRIPTIVE_APPLICATION_FRAME.search(value) is not None


def has_sensory_evaluation_frame(value: str) -> bool:
    return _SENSORY_EVALUATION_FRAME.search(value) is not None


def is_procedural_usage_instruction(value: str) -> bool:
    """Return whether a text is a usage instruction, reading one sentence at a time.

    A source block can put one real instruction next to product copy.  Cues
    scattered over such a block are not a procedure: the copy would inherit an
    action it never states from its neighbour.  A block therefore has to read as
    directions *and* contain a sentence that is itself directions, and it is not
    directions at all when one of its sentences names whom the product suits —
    that block is routed as one unit, so filing it as a procedure buries the
    audience fact it carries.  Both extra conditions only withhold the verdict,
    never grant it, and the instruction inside such a block keeps its own
    verdict when a caller evaluates that sentence alone.
    """

    text = clean_usage_text(value)
    if not text:
        return False
    sentences = [sentence for part in split_into_sentences(text) if (sentence := clean_usage_text(part))]
    if len(sentences) > 1:
        if any(_states_an_audience_without_directing(sentence) for sentence in sentences):
            return False
        if not any(_is_procedural_usage_sentence(sentence) for sentence in sentences):
            return False
    return _is_procedural_usage_sentence(text)


def _states_an_audience_without_directing(sentence: str) -> bool:
    return is_suitability_statement(sentence) and not _is_procedural_usage_sentence(sentence)


def _is_procedural_usage_sentence(text: str) -> bool:
    # ``정상, 건성, 복합성 피부에 사용할 수 있습니다`` and ``Can be used daily on
    # dry skin`` name the skin a product qualifies for.  They instruct nobody, so
    # they are read before any action or ending is scored: naming an audience is
    # audience evidence, and scoring it as a direction both invents a HowTo step
    # and removes the audience fact the sentence actually carries.  An
    # application action anywhere in the sentence keeps that reading out: a
    # sentence can name an audience and still tell the reader what to do
    # (``민감성 피부에 펴 바릅니다``), and this contract owns that grammar.
    if is_suitability_statement(text) and not has_procedure_action_cue(text):
        return False
    if _CONCISE_IMPERATIVE.search(text) is not None and js_code_unit_length(text) <= 180:
        return True
    procedural_score = usage_procedure_signal_score(text)
    descriptive_score = usage_description_signal_score(text)
    if (has_descriptive_application_frame(text) or has_sensory_evaluation_frame(text)) and procedural_score < 3:
        return False
    # ``세안 후 건조함을 케어합니다`` describes the product result after
    # cleansing; it is not an instruction to cleanse or apply the product.
    # A routine-placement cue alone must therefore not turn a benefit clause
    # into a HowTo candidate merely because its Korean polite ending is also
    # used by real directions.  Concrete application/cleansing verbs remain
    # required for that route.
    if (
        not has_procedure_action_cue(text)
        and has_routine_placement_cue(text)
        and _DESCRIPTION_BENEFIT.search(text) is not None
    ):
        return False
    # A product sentence such as "Daily hydration cream for dry skin" has a
    # cadence word and a skin noun, but no application action.  Treating that
    # shape as a procedure would remove an otherwise usable audience/product
    # description from generation and OCR-derived customer context.
    if (
        not has_procedure_action_cue(text)
        and has_routine_placement_cue(text)
        and _DESCRIPTION_PRODUCT.search(text) is not None
        and descriptive_score >= procedural_score
    ):
        return False
    return (
        (has_procedure_action_cue(text) or has_routine_placement_cue(text))
        and procedural_score >= 2
        and procedural_score >= descriptive_score
    )


def has_actionable_application_verb(value: str) -> bool:
    text = clean_usage_text(value)
    return (
        has_wash_action_cue(text)
        or _ACTIONABLE_ENGLISH.search(text) is not None
        or _ACTIONABLE_KOREAN.search(text) is not None
    )


def has_actionable_application_verb_without_generic_apply(value: str) -> bool:
    text = clean_usage_text(value)
    return (
        has_wash_action_cue(text)
        or _ACTIONABLE_ENGLISH.search(text) is not None
        or _ACTIONABLE_KOREAN_WITHOUT_GENERIC_APPLY.search(text) is not None
    )


def has_korean_instruction_verb(value: str) -> bool:
    text = clean_usage_text(value)
    return has_wash_action_cue(text) or _KOREAN_INSTRUCTION_VERB.search(text) is not None


def has_concrete_korean_usage_action(value: str) -> bool:
    return has_korean_instruction_verb(value)


def is_safety_or_test_claim_usage(value: str) -> bool:
    text = clean_usage_text(value)
    return _SAFETY_OR_TEST_KOREAN.search(text) is not None or _SAFETY_OR_TEST_ENGLISH.search(text) is not None


def is_concrete_usage_action(value: str) -> bool:
    text = clean_usage_text(value)
    if (
        not text
        or js_code_unit_length(text) < 8
        or re.search(r"\s", text) is None
        or _CONCRETE_DISQUALIFYING_SUITABILITY.search(text) is not None
    ):
        return False
    if _CONCRETE_EVIDENCE.search(text) is not None and _CONCRETE_OUTCOME.search(text) is not None:
        return False
    return _CONCRETE_ACTION.search(text) is not None or _CONCRETE_ROUTINE_ACTION.search(text) is not None


def extract_explicit_numbered_usage_steps(values: Sequence[object]) -> list[str]:
    """Recover one complete source-owned numbered procedure without inventing steps.

    OCR and source parsers may emit one numbered action per list item or pack
    several adjacent actions into one text block.  This list-level gate reads
    those markers before per-row vocabulary heuristics run, then accepts a
    contiguous ``1..N`` procedure after rejecting known non-procedural source
    classes.  Explicit source order is stronger evidence than a
    category-specific action vocabulary: a valid instruction can say to shake,
    wait, style, mix, or use an otherwise unfamiliar verb.  It never
    manufactures a position for unordered directions or packaging/page-copy
    fragments.
    """

    by_position: dict[int, str] = {}
    for raw in values:
        if not isinstance(raw, str):
            continue
        text = raw.strip()
        markers = [
            marker
            for marker in _NUMBERED_SOURCE_USAGE_MARKER.finditer(text)
            if _is_explicit_numbered_source_marker(text, marker)
        ]
        if not markers:
            continue
        for index, marker in enumerate(markers):
            end = markers[index + 1].start() if index + 1 < len(markers) else None
            if not _add_explicit_numbered_source_step(by_position, int(marker.group(1)), text[marker.end() : end]):
                return []

    positions = sorted(by_position)
    if not positions or positions != list(range(1, len(positions) + 1)):
        return []
    return [f"{position}. {by_position[position]}" for position in positions]


def has_explicit_numbered_usage_marker(value: object) -> bool:
    """Identify a visible source ordinal before a fallback can renumber it."""

    if not isinstance(value, str):
        return False
    return any(
        _is_explicit_numbered_source_marker(value, marker) for marker in _NUMBERED_SOURCE_USAGE_MARKER.finditer(value)
    )


def _is_explicit_numbered_source_marker(value: str, marker: re.Match[str]) -> bool:
    if marker.group("delimiter"):
        return True
    prefix = value[: marker.start()].rstrip()
    return not prefix or bool(
        re.search(r"(?:[.!?。！？]|사용\s*방법|사용법|how\s*to\s*use|directions?|使用方法)$", prefix, re.IGNORECASE)
    )


def _add_explicit_numbered_source_step(by_position: dict[int, str], position: int, value: str) -> bool:
    text = clean_usage_text(value)
    sentence_ends = list(_SOURCE_USAGE_SENTENCE_END.finditer(text))
    if sentence_ends:
        last_sentence = sentence_ends[-1]
        trailing = text[last_sentence.end() :].strip()
        if len(trailing) <= 80 and _TRAILING_SOURCE_LABEL.fullmatch(trailing):
            text = clean_usage_text(text[: last_sentence.end()])
    if not _is_explicit_numbered_source_usage_step(text):
        return False
    prior = by_position.get(position)
    if prior is not None and _usage_step_key(prior) != _usage_step_key(text):
        return False
    by_position[position] = text
    return True


def _is_explicit_numbered_source_usage_step(value: str) -> bool:
    text = clean_usage_text(value)
    if (
        not text
        or js_code_unit_length(text) < 8
        or re.search(r"[?？]", text) is not None
        or is_safety_or_test_claim_usage(text)
        # A parsed ordinal sequence supplies a real source-row boundary.  The
        # generic repeated-token heuristic detects unsegmented page copy, so
        # it cannot by itself reject one compact source-owned instruction.
        or _has_structural_raw_page_dump(text)
        or is_stitched_marketing_page_dump(text)
        or _EXPLICIT_SOURCE_MEASURED_RESULT.search(text) is not None
        or _EXPLICIT_SOURCE_STORAGE_OR_DISPOSAL.search(text) is not None
    ):
        return False
    if _CONCRETE_EVIDENCE.search(text) is not None and _CONCRETE_OUTCOME.search(text) is not None:
        return False
    # The enclosing extractor has already proved this is a complete,
    # contiguous numbered source sequence.  Do not require a fixed skincare
    # verb here: it would drop legitimate source instructions such as
    # ``Shake``, ``Wait``, and ``Style`` while the same exact sequence is
    # present in the product instructions.
    return True


def _usage_step_key(value: str) -> str:
    return re.sub(r"[^\w]+", " ", clean_usage_text(value).casefold()).strip()


def _uppercase_runs(text: str) -> list[str]:
    words = re.findall(r"[^\W\d_][^\W\d_'’\-–]*", text)
    return [
        word
        for word in words
        if len(word) >= 4
        and word[0].isupper()
        and all(
            character.isupper() or unicodedata.category(character).startswith("M") or character in "'’-"
            for character in word
        )
    ]


def has_context_free_figure_run(value: str) -> bool:
    return _CONTEXT_FREE_FIGURE_RUN.search(clean_usage_text(value)) is not None


def is_stitched_marketing_page_dump(value: str) -> bool:
    text = clean_usage_text(value)
    if not text:
        return False
    return (
        len(_uppercase_runs(text)) >= 6 or len(_MARKETING_STEP.findall(text)) >= 3 or has_context_free_figure_run(text)
    )


def _has_structural_raw_page_dump(value: str) -> bool:
    text = clean_usage_text(value)
    return len(_uppercase_runs(text)) >= 6 or len(_YEAR.findall(text)) >= 3


def is_raw_page_text_block(value: str) -> bool:
    text = clean_usage_text(value)
    if not text:
        return False
    if _has_structural_raw_page_dump(text):
        return True
    token_counts: dict[str, int] = {}
    for token in re.findall(r"[^\W_]{4,}", text.lower()):
        token_counts[token] = token_counts.get(token, 0) + 1
    return any(count >= 3 for count in token_counts.values())


cleanUsageText = clean_usage_text
hasWashActionCue = has_wash_action_cue
hasProcedureActionCue = has_procedure_action_cue
hasRoutinePlacementCue = has_routine_placement_cue
usageProcedureSignalScore = usage_procedure_signal_score
usageDescriptionSignalScore = usage_description_signal_score
hasDescriptiveApplicationFrame = has_descriptive_application_frame
hasSensoryEvaluationFrame = has_sensory_evaluation_frame
isProceduralUsageInstruction = is_procedural_usage_instruction
hasActionableApplicationVerb = has_actionable_application_verb
hasActionableApplicationVerbWithoutGenericApply = has_actionable_application_verb_without_generic_apply
hasKoreanInstructionVerb = has_korean_instruction_verb
hasConcreteKoreanUsageAction = has_concrete_korean_usage_action
isSafetyOrTestClaimUsage = is_safety_or_test_claim_usage
isConcreteUsageAction = is_concrete_usage_action
extractExplicitNumberedUsageSteps = extract_explicit_numbered_usage_steps
hasExplicitNumberedUsageMarker = has_explicit_numbered_usage_marker
isStitchedMarketingPageDump = is_stitched_marketing_page_dump
hasContextFreeFigureRun = has_context_free_figure_run
isRawPageTextBlock = is_raw_page_text_block


__all__ = [
    "clean_usage_text",
    "cleanUsageText",
    "has_actionable_application_verb",
    "has_actionable_application_verb_without_generic_apply",
    "has_concrete_korean_usage_action",
    "has_context_free_figure_run",
    "has_descriptive_application_frame",
    "has_korean_instruction_verb",
    "has_procedure_action_cue",
    "has_routine_placement_cue",
    "has_sensory_evaluation_frame",
    "has_wash_action_cue",
    "hasActionableApplicationVerb",
    "hasActionableApplicationVerbWithoutGenericApply",
    "hasConcreteKoreanUsageAction",
    "hasContextFreeFigureRun",
    "hasDescriptiveApplicationFrame",
    "hasKoreanInstructionVerb",
    "hasProcedureActionCue",
    "hasRoutinePlacementCue",
    "hasSensoryEvaluationFrame",
    "hasWashActionCue",
    "is_concrete_usage_action",
    "extract_explicit_numbered_usage_steps",
    "has_explicit_numbered_usage_marker",
    "is_procedural_usage_instruction",
    "is_raw_page_text_block",
    "is_safety_or_test_claim_usage",
    "is_stitched_marketing_page_dump",
    "isConcreteUsageAction",
    "extractExplicitNumberedUsageSteps",
    "hasExplicitNumberedUsageMarker",
    "isProceduralUsageInstruction",
    "isRawPageTextBlock",
    "isSafetyOrTestClaimUsage",
    "isStitchedMarketingPageDump",
    "usage_description_signal_score",
    "usage_procedure_signal_score",
    "usageDescriptionSignalScore",
    "usageProcedureSignalScore",
]

def usage_text_without_step_marker(value: str) -> str:
    """Return a usage step without the number the layout printed for it.

    A page numbers its steps for the reader's eye, and the published HowTo
    prints the instruction without that number.  Every surface that hands the
    same step to a consumer -- the published step, an evidence card the model
    reads -- therefore shows the same text, so a citation and the sentence
    written from it cannot disagree about which words the page used.
    """

    result = value.strip()
    for _ in range(4):
        previous = result
        result = re.sub(r"^\s*(?:[.;:·-]+\s*)+", "", result)
        result = re.sub(r"^\s*(?:step\s*)?\d+\s*(?:단계|段階)?\s*[:.)-]*\s*", "", result, flags=re.IGNORECASE)
        if result == previous:
            return result
    return result
