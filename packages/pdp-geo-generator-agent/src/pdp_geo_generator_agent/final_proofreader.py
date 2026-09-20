"""Fail-closed final public-copy proofreading.

The optional model is deliberately restricted to an ordered list of hashed
public-copy fields.  It never receives authority to generate a graph or add a
fact: every proposed edit is checked before the JSON-LD is reserialized.
"""

from __future__ import annotations

import copy
import inspect
import re
import unicodedata
from collections.abc import Iterable, Mapping, Sequence
from typing import Any, Literal, TypedDict, cast

from neo_js_compat import js_fnv1a32_unsigned, js_json_dumps

from ._json import as_dict, as_list, clean_text
from .contracts.customer_situation import asks_what_the_source_recorded
from .contracts.metric_statement import (
    naming_identifier_numerics,
    numeric_tokens,
    states_naming_surface,
    word_tokens,
)
from .contracts.product_identity import (
    ENTITY_KIND_NOUNS,
    GENERIC_ENTITY_NOUNS,
    clause_without_containment_owner,
    contains_entity_identity_phrase,
    contains_entity_identity_phrase_in_prose,
    english_deictic_self_reference,
    korean_deictic_self_reference,
    product_title_without_sku_qualifier,
    span_names_only_the_entity,
)
from .contracts.sentence_form import (
    ENGLISH_CONTAINMENT_FRAME_FORMS,
    ENGLISH_FUNCTION_WORDS,
    KOREAN_CONTAINMENT_FRAME_FORMS,
    KOREAN_PHRASE_CLOSING_PARTICLE_ALTERNATION,
    KOREAN_POLITE_SENTENCE_ENDING,
    english_subjectless_predicate,
    is_complete_sentence,
    korean_reported_clause,
    korean_subject_noun,
    names_a_thing,
    publishable_stems,
    source_phrase_matches,
    split_into_clauses,
    states_its_own_subject,
    strip_korean_inflection,
    strip_korean_particle,
)
from .contracts.suitability import audience_designations
from .faq_relationships import CARD_CLAIM_CONTENT_FIELDS
from .review_sentiment import is_positive_aggregate_rating, is_positive_review_body, is_positive_review_keyword
from .token_usage import merge_token_usage
from .validation import serialize_schema_markup, validate_pdp_geo_artifacts

type IssueCode = Literal["awkward", "grammar", "duplicate-sentence", "duplicate-word", "punctuation"]
type ProvenanceDecisionPhase = Literal["initial", "afterProofreader", "afterSafeRepair", "correctedCandidate"]


class RenderedSentenceEvidence(TypedDict):
    evidenceIds: list[str]
    sentenceEvidenceIds: list[list[str]]


class _FinalProofreadingPrompt(TypedDict):
    system: str
    user: str
_ISSUE_CODES: frozenset[str] = frozenset({"awkward", "grammar", "duplicate-sentence", "duplicate-word", "punctuation"})
_DEFAULT_FINAL_PROOFREADING_MAX_OUTPUT_TOKENS = 6000
_FIELD_PATH = re.compile(
    r"^(?:Product\.description|WebPage\.description|FAQPage\.mainEntity\[\d+\]\.(?:name|acceptedAnswer\.text)|HowTo\.step\[\d+\]\.text)$"
)
_IDENTIFIER_TOKEN = re.compile(r"\b(?:[A-Z]{2,}[A-Z0-9-]*|[A-Za-z]+\d+[A-Za-z0-9-]*)\b")
_UNSAFE_UNICODE = re.compile(r"[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060\ufeff\ufe00-\ufe0f]")
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?。！？])\s+|\n+")
_INGREDIENT_RELATION = re.compile(
    r"\b(?:helps?|supports?|improves?|reduces?|increases?|causes?|strengthens?)\b|(?:도움|돕|지원|개선|감소|증가|강화|유발|통해)",
    re.I,
)
_CLAIM_NEGATION = re.compile(r"\b(?:not|no|never|cannot|can['’]t|without)\b|않|없|아니|못\s*하|불가|되지\s*않", re.I)
_CLAIM_MODALITIES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("uncertain", re.compile(r"\b(?:may|might|could|possibly|suggests?)\b|가능성|추정|수\s*있", re.I)),
    ("ability", re.compile(r"\b(?:can\s+(?:be\s+)?used|can\s+use)\b|사용(?:할|해도|하셔도)?\s*(?:수|가능)", re.I)),
    ("suitability", re.compile(r"\b(?:suitab\w*|appropriate)\b|적합", re.I)),
    ("recommendation", re.compile(r"\b(?:recommend\w*|advis\w*)\b|권장|추천", re.I)),
    ("safety", re.compile(r"\b(?:safe\w*|patch\s*test|consult\w*|dermatolog\w*)\b|패치\s*테스트|상담|전문가|안전", re.I)),
)
_STRICT_ASSERTION_MODALITIES = frozenset({"ability", "suitability", "recommendation", "safety"})
_ROLE_ENUMERATION_FRAME = re.compile(r"\b(?:benefits?|effects?)\b|효능|효과", re.I)
_CLAIM_RELATION = re.compile(
    r"\b(?:supports?|helps?|improves?|reduces?|increases?|strengthens?|calms?|soothes?|provides?|promotes?|offers?|"
    r"includes?|contains?|uses?|has|is|are|was|were|lists?|identifies?|documents?|mentions?|says?)\b|"
    r"지원|도움|개선|감소|증가|강화|완화|진정|제공|포함|함유|사용|적합|권장|추천|안전|표기|기재|언급|입니다|이다",
    re.I,
)
_FORMULA_RELATION = re.compile(r"\b(?:includes?|contains?|uses?|has|features?)\b|포함|함유", re.I)
_BENEFIT_RELATION = re.compile(
    r"\b(?:supports?|helps?|improves?|reduces?|increases?|strengthens?|calms?|soothes?|provides?|promotes?|offers?)\b|"
    r"지원|도움|돕|개선|감소|증가|강화|완화|진정|제공",
    re.I,
)
_REVIEW_REFERENCE = re.compile(r"\b(?:review|reviews|reviewer|customer feedback)\b|(?:고객\s*)?(?:리뷰|후기)", re.I)
_COMMERCE_RATING_REFERENCE = re.compile(
    r"\b(?:ratings?|rated|stars?|testimonials?|verified\s+(?:buyer|purchaser)|customer\s+(?:said|reported))\b|"
    r"(?:별점|평점|평가|星|評価)",
    re.I,
)
_REVIEW_KEYWORD_SOURCE_PATH = re.compile(r"^product\.reviews\.keywords\[\d+\]$")
_REVIEW_BODY_SOURCE_PATH = re.compile(r"^product\.reviews\.items\[\d+\]\.body$")
_REVIEW_SUMMARY_SOURCE_PATH = "product.reviews.summary"
_REVIEW_SUMMARY_VALUES = re.compile(
    r"^rating=(?P<rating>\d+(?:\.\d+)?);\s*reviewCount=(?P<count>\d+(?:\.\d+)?)$",
    re.IGNORECASE,
)
_ENGLISH_POSITIVE_REVIEW_KEYWORD_FRAME = re.compile(
    r"^Customers\s+who\s+reviewed\s+(?P<subject>.+?)\s+positively\s+noted\s+(?P<keyword>.+?)(?:[.!?。！？])?$",
    re.IGNORECASE,
)
_KOREAN_POSITIVE_REVIEW_KEYWORD_FRAME = re.compile(
    r"^(?P<subject>.+?)(?:을|를)\s*사용한\s*고객들은\s*(?P<keyword>.+?)(?:을|를)\s*긍정적으로\s*평가했습니다(?:[.!?。！？])?$"
)
_ENGLISH_POSITIVE_REVIEW_RATING_FRAME = re.compile(
    r"^(?P<subject>.+?)\s+received\s+(?P<rating>\d+(?:\.\d+)?)\s+out\s+of\s+(?P<scale>\d+(?:\.\d+)?)\s+from\s+(?P<count>\d+)\s+customer\s+ratings(?:[.!?。！？])?$",
    re.IGNORECASE,
)
_KOREAN_POSITIVE_REVIEW_RATING_FRAME = re.compile(
    r"^(?P<subject>.+?)(?:은|는)\s*(?P<count>\d+)건의\s*고객\s*평가에서\s*(?P<rating>\d+(?:\.\d+)?)\s*/\s*(?P<scale>\d+(?:\.\d+)?)\s*점을\s*받았습니다(?:[.!?。！？])?$"
)
_KOREAN_RENDERER_INGREDIENT_FRAME = re.compile(
    r"^(?P<subject>.+?)(?:은|는)\s+(?P<items>.+?)(?:을|를)\s+주요\s+성분·기술로\s+포함합니다(?:[.!?。！？])?$"
)
_KOREAN_ENTITY_INGREDIENT_FRAME = re.compile(
    r"^(?P<subject>.+?)(?:은|는)\s+(?P<items>.+?)(?:을|를)\s+포함합니다(?:[.!?。！？])?$"
)
_KOREAN_RENDERER_BENEFIT_FRAME = re.compile(
    r"^(?P<subject>.+?)에는\s+(?P<items>.+?)\s+관련\s+효능·효과도\s+별도로\s+표기되어\s+있습니다(?:[.!?。！？])?$"
)
_KOREAN_RENDERER_REVIEW_LEAD_FRAME = re.compile(
    r"^(?P<subject>.+?)(?:을|를)\s*사용한\s*고객들은\s*(?P<body>.+)$"
)
_KOREAN_RENDERER_REVIEW_TERMINAL_FRAME = re.compile(r"^라고\s+언급했습니다(?:[.!?。！？])?$")
_ENGLISH_PAGE_USAGE_SUMMARY_FRAME = re.compile(
    r"^The\s+page\s+also\s+outlines\s+how\s+to\s+use\s+(?P<subject>.+?)(?:[.!?。！？])?$",
    re.IGNORECASE,
)
_KOREAN_PAGE_USAGE_SUMMARY_FRAME = re.compile(
    r"^(?P<subject>.+?)의\s*사용\s*순서도\s*함께\s*확인할\s*수\s*있습니다(?:[.!?。！？])?$"
)
_KOREAN_NATURAL_PAGE_USAGE_SUMMARY_FRAME = re.compile(
    r"^(?P<subject>.+?)의\s*사용\s*단계도\s*함께\s*다룹니다(?:[.!?。！？])?$"
)
_ENGLISH_PAGE_OVERVIEW_FRAME = re.compile(
    r"^(?P<subject>.+?)\s+is\s+presented\s+with\s+product\s+details"
    r"(?:,\s+including\s+(?P<coverage>.+?))?(?:[.!?。！？])?$",
    re.IGNORECASE,
)
_ENGLISH_NATURAL_PAGE_OVERVIEW_FRAME = re.compile(
    r"^The\s+product\s+page\s+for\s+(?P<subject>.+?)"
    r"(?:\s+covers\s+(?P<coverage>.+?)|\s+offers\s+an\s+overview)(?:[.!?。！？])?$",
    re.IGNORECASE,
)
_KOREAN_PAGE_OVERVIEW_FRAME = re.compile(
    r"^(?P<subject>.+?)의\s*제품\s*소개"
    r"(?:와\s*(?P<coverage>.+?)\s*관련\s*정보)?를\s*(?:함께\s*)?확인할\s*수\s*있습니다(?:[.!?。！？])?$"
)
_KOREAN_NATURAL_PAGE_OVERVIEW_FRAME = re.compile(
    r"^(?P<subject>.+?)\s*(?:상품|제품)\s*페이지는\s+"
    r"(?:(?:제품의\s*)?(?:특징|내용)\s*(?:과|와)\s*)?"
    r"(?P<coverage>.+?)(?:을|를)?\s*"
    r"(?:(?:바탕으로\s*)?(?:제품의\s*)?(?:특징|내용)을\s*(?:소개|다루|설명)합니다|(?:함께\s*)?다룹니다)"
    r"(?:[.!?。！？])?$"
)
_ENGLISH_PAGE_OVERVIEW_ROLES: Mapping[str, tuple[str, ...]] = {
    "who it is for": ("audience", "description", "benefit", "effect", "faq", "source"),
    "skin concerns": ("concern", "description", "benefit", "effect", "faq", "source"),
    "formula details": ("ingredient", "formula"),
    "stated benefits": ("benefit", "effect"),
    "usage guidance": ("usage",),
    "reported results": ("metric",),
    "customer feedback": ("review",),
}
_KOREAN_PAGE_OVERVIEW_ROLES: Mapping[str, tuple[str, ...]] = {
    "대상 고객": ("audience", "description", "benefit", "effect", "faq", "source"),
    "성분·포뮬러": ("ingredient", "formula"),
    "효능·효과": ("benefit", "effect"),
    "사용법": ("usage",),
    "근거 지표": ("metric",),
    "고객 평가": ("review",),
}
_REVIEW_QUOTE = re.compile(r"[\"“”‘’]|(?:^|[\s(])'[^']+'(?=$|[\s.,!?。！？)])")
# The containment frame is grammar, not a fact: it is where this locale puts
# the product that holds the part a clause is about.  Read from the one
# definition the admission gate reads.
_CONTAINMENT_FRAME_STEMS = frozenset(
    stem for form in KOREAN_CONTAINMENT_FRAME_FORMS for stem in publishable_stems(form)
)
_GENERIC_ENTITY_TOKENS = GENERIC_ENTITY_NOUNS
_ENTITY_KIND_TOKENS = ENTITY_KIND_NOUNS
_PUBLIC_COPY_TEMPLATE_TOKENS = frozenset(
    {
        "best",
        "address",
        "addres",
        "audience",
        "benefit",
        "care",
        "component",
        "concern",
        "customer",
        "daily",
        "direction",
        "document",
        "element",
        "fit",
        "formula",
        "give",
        "highlight",
        "identify",
        "information",
        "ingredient",
        "introduce",
        "introduc",
        "intend",
        "key",
        "layer",
        "list",
        "page",
        "place",
        "present",
        "product",
        "reference",
        "routine",
        "serum",
        "essence",
        "toner",
        "select",
        "combination",
        "giv",
        "product-selection",
        "separately",
        "skincare",
        "suit",
        "can",
        "위한",
        "고객",
        "구성",
        "기능",
        "내용",
        "대상",
        "도움",
        "리스트",
        "사용",
        "방법",
        "성분",
        "안내",
        "요약",
        "정보",
        "제품",
        "주요",
        "추천",
        "페이지",
        "표기",
        "확인",
    }
)
_SOURCE_ROLE_QUESTION_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("ingredient", re.compile(r"\b(?:ingredient|ingredients|formula|component|components|technology|technologies)\b|성분|구성", re.I)),
    ("benefit", re.compile(r"\b(?:benefit|benefits|effect|effects)\b|효능|효과", re.I)),
    ("usage", re.compile(r"\b(?:how\s+(?:should|do)|use|used|apply|routine|direction|directions)\b|사용|바르|루틴", re.I)),
    ("metric", re.compile(r"\b(?:metric|metrics|result|results|measured|measurement|test|testing)\b|수치|결과|측정|시험", re.I)),
    ("review", re.compile(r"\b(?:review|reviews|feedback)\b|리뷰|후기", re.I)),
    ("audience", re.compile(r"\b(?:audience|customer|customers|concern|concerns|skin\s+type|skin\s+types)\b|피부|고객|대상", re.I)),
    ("commerce", re.compile(r"\b(?:option|options|variant|variants|size|sizes)\b|옵션|용량|구성", re.I)),
)
_SOURCE_ROLE_QUESTION_EVIDENCE: dict[str, frozenset[str]] = {
    "ingredient": frozenset({"ingredient"}),
    "benefit": frozenset({"benefit", "effect"}),
    "usage": frozenset({"usage"}),
    "metric": frozenset({"metric"}),
    "review": frozenset({"review"}),
    "audience": frozenset({"audience", "description", "source", "faq"}),
    "commerce": frozenset({"commerce"}),
}
# The headings a page writes over its own fields.  A heading is that heading
# wherever a question puts it, so this is not anchored to the start of one:
# anchoring it stopped 2 of 15 recorded analyst questions, because ``For dry
# skin, which ingredients are listed on the PDP?`` only had to put a customer
# in front of the words.  The functional reading in the customer-situation
# contract covers the headings nobody wrote down here.
_FAQ_RAW_HEADING_QUESTION = re.compile(
    r"(?:"
    r"(?:which|what)\s+(?:ingredients?|formula|directions?|how\s+to\s+use)|"
    r"(?:how\s+to\s+use|directions?)|"
    r"(?:what\s+(?:does|do).+?\s+say\s+about)|"
    r"(?:what(?:'s|\s+is)\s+.+?\s+(?:rating|score))|"
    r"(?:성분(?:은|이)?\s*무엇|사용\s*(?:방법|법)|평점(?:은|이)?\s*무엇)"
    r")",
    re.IGNORECASE,
)
# A shopper's question asks which one to take.  What makes it that question is
# the interrogative determiner standing on the thing being chosen, and the noun
# it stands on is the writer's -- "어떤 제품", "어떤 클렌징폼", "which cleanser".
# Listing the nouns instead recognized the goal only for the few categories
# written down, so a correctly composed question about any other product form
# read as a source heading and its row published nothing.  The raw-heading and
# analyst guards beside this one keep source-field questions out, so this one
# only has to read the choosing.
_FAQ_CUSTOMER_GOAL_QUESTION = re.compile(
    r"\b(?:"
    r"how\s+should\s+(?:customers?|people)|"
    r"what\s+(?:kind|makes)|"
    r"what\s+(?:\w+\s+){0,3}should\s+(?:i|customers?|people)|"
    r"what\s+changes?\s+might\s+(?:i|customers?|people)\s+notice|"
    r"which\s+(?:(?:\w+\s+){0,3})?\w+|"
    r"(?:customers?|people)\s+(?:with|who)|"
    r"looking\s+for|goal|concern|priority|care\s+goal|"
    r"what\s+(?:\w+\s+){0,2}(?:is\s+)?(?:good|best)"
    r")\b|(?:고객|사용자|피부\s*고민|관리\s*목표|(?:어떤|무슨|어느)\s*[가-힣A-Za-z0-9])",
    re.IGNORECASE,
)
_FAQ_FORMULA_CARRIER = re.compile(
    r"\b(?:lists?|includes?|contains?|features?|has)\b.{0,100}\b(?:ingredients?|formula|formulation)\b|"
    r"(?:성분|포뮬러).{0,80}(?:포함|함유)|(?:포함|함유).{0,80}(?:성분|포뮬러)",
    re.IGNORECASE,
)
_FAQ_USAGE_CARRIER = re.compile(
    r"\b(?:is|are|was|were)?\s*applied\b|\b(?:apply|use)\b|(?:사용|바르)",
    re.IGNORECASE,
)
_FAQ_RECOMMENDATION_CARRIER = re.compile(
    r"\b(?:worth\s+considering|a(?:n)?\s+(?:good\s+)?(?:choice|option)|consider(?:ed)?|recommend(?:ed|s|ation)?)\b|"
    r"(?:고려(?:할|해볼)|추천|선택)",
    re.IGNORECASE,
)
_FAQ_CAUSAL_CONNECTOR = re.compile(
    r"\b(?:because|therefore|thus|due\s+to|as\s+a\s+result\s+of|causes?|through)\b|"
    r"(?:때문|통해|유발)",
    re.IGNORECASE,
)
_FAQ_METRIC_REPORT_TOKEN_NORMALIZATION: Mapping[str, str] = {
    "agre": "agree",
    "agree": "agree",
    "report": "report",
    "show": "report",
    "measur": "measure",
    "measure": "measure",
    "improv": "improve",
    "improve": "improve",
    "find": "report",
    "found": "report",
}
_FAQ_USAGE_TOKEN_NORMALIZATION: Mapping[str, str] = {
    "appli": "apply",
    "apply": "apply",
    "use": "apply",
    "used": "apply",
    "using": "apply",
}
_FAQ_USAGE_ACTION_TOKENS = frozenset(
    {
        "apply",
        "dispense",
        "dot",
        "layer",
        "massage",
        "move",
        "pat",
        "press",
        "smooth",
        "spread",
        "tap",
        "warm",
    }
)
_FAQ_FORMULA_CARRIER_TOKENS = frozenset(
    {"list", "include", "includ", "contain", "feature", "featur", "has", "among", "ingredient", "formula", "formulation"}
)
_FAQ_RECOMMENDATION_CARRIER_TOKENS = frozenset({"worth", "consider", "choice", "option", "good", "recommend", "추천", "고려", "선택"})
_FAQ_CARD_PART_ROLES = frozenset({"ingredient", "ingredient-effect"})
_FAQ_CARD_PART_NAME_FIELD = "ingredient"
_FAQ_CARD_ENGLISH_SCAFFOLD_TOKENS = frozenset(
    {
        "after",
        "are",
        "can",
        "change",
        "concern",
        "consider",
        "could",
        "daily",
        "for",
        "focus",
        "from",
        "goal",
        "help",
        "in",
        "look",
        "may",
        "might",
        "my",
        "notice",
        "priority",
        "result",
        "routine",
        "serum",
        "should",
        "skincare",
        "the",
        "use",
        "when",
        "with",
    }
)
_PROVENANCE_DECISION_PHASES = frozenset({"initial", "afterProofreader", "afterSafeRepair", "correctedCandidate"})
_PROVENANCE_DIAGNOSTIC_ROLES = frozenset(
    {
        "identity",
        "description",
        "benefit",
        "effect",
        "ingredient",
        "audience",
        "usage",
        "metric",
        "faq",
        "review",
        "source",
        "commerce",
    }
)

_FINAL_PROOFREADING_SYSTEM_PROMPT = "\n".join(
    (
        "You are the final fluency-only proofreader for already approved product schema copy.",
        "This is not a reasoning, fact-selection, SEO expansion, translation, or claim-writing task.",
        "Return exactly one edit for every input field, in the same order, with the exact fieldPath and sourceHash.",
        "Use action=keep and return the original text unchanged when no safe correction is necessary.",
        "You may automatically revise punctuation/spacing, remove an adjacent exact duplicate word or sentence, and make only narrow meaning-preserving grammar corrections.",
        "Allowed grammar corrections are: English a/an selection, same-tense subject-verb agreement, approved present-tense claim-verb agreement, and FAQ auxiliary inversion; Korean same-role particle allomorphs and approved sentence-final polite style inflections.",
        "Use issueCodes=[grammar] for those narrow grammar corrections. Do not add or remove articles/prepositions, change tense/voice/modality, reorder content words, or change Korean particle roles.",
        "If any other naturalness, grammar, or awkward word-order fix is needed, use action=keep with the original text and add a concise field-specific warning instead of rewriting it.",
        "Never add, remove, generalize, narrow, strengthen, weaken, translate, or reconnect any factual statement.",
        "Preserve product and brand names, ingredient and technology names, numbers, units, signs, periods, populations, test/review attribution, negation, uncertainty, and claim modality exactly.",
        "Never create an ingredient-to-benefit relationship, suitability claim, efficacy claim, comparison, routine order, review consensus, or market claim that the original field did not state.",
        "Product.description must keep its existing semantic role order. WebPage.description must remain page/brand/information-scope copy rather than becoming another product description.",
        "FAQ question intent and its paired answer must not change. Do not add, remove, merge, split, or reorder FAQ items.",
        "Keep customer caveats direct. Do not turn '개인 차가 있을 수 있습니다' or 'Individual results may vary' into editorial narration about an attached disclaimer, caveat, qualifier, condition, or note.",
        "HowTo fields are punctuation-only: do not change words, actions, amounts, timing, body area, count, or order.",
        "Do not edit reviewBody, names, offers, URLs, identifiers, or schema structure; those fields are intentionally absent.",
        "Write in the existing target locale only. Evidence IDs and immutable tokens are read-only constraints, not material for adding facts.",
        "A field carrying priorRejection is a second attempt: your previous proposal for it was refused for that stated reason. Propose a different correction that does not repeat it, or use action=keep when no correction remains that would satisfy it.",
        "Return only the strict structured JSON requested by the response schema.",
    )
)


def clean_proposed_text(value: str) -> str:
    """Match the legacy public-copy normalization boundary."""

    value = unicodedata.normalize("NFC", value)
    value = re.sub(r"```(?:json)?", "", value, flags=re.IGNORECASE)
    value = re.sub(r"\s+([,.!?;:。！？])", r"\1", value)
    return re.sub(r"[ \t]+", " ", value).strip()


def stable_text_hash(value: str) -> str:
    """Return the exact unsigned JS UTF-16 FNV-1a identity used by TS."""

    return f"fnv1a-{js_fnv1a32_unsigned(value):08x}"


def create_pdp_geo_public_copy_provenance(input_: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Bind currently-rendered public fields to the supplied evidence ledger.

    This is intentionally conservative.  A field without an evidence ID can be
    published, but it is not eligible for a later model rewrite.
    """

    graph = _graph(as_dict(input_.get("schemaMarkup")))
    ledger = _records(input_.get("evidenceLedger"))
    plan = as_dict(input_.get("contentPlan"))
    faq_membership, faq_membership_supplied = _validated_faq_membership(input_, graph, plan, ledger)
    entries: list[dict[str, Any]] = []

    def add(
        path: str,
        text: str,
        ids: Sequence[str],
        origin: str,
        sentence_ids: Sequence[Sequence[str]] | None,
        *,
        faq_row_id: str | None = None,
        faq_can_recommend: bool = False,
        faq_card: Mapping[str, Any] | None = None,
        faq_scope_evidence: Sequence[Mapping[str, Any]] = (),
    ) -> None:
        valid_ids = _unique_strings(identifier for identifier in ids if any(row.get("id") == identifier for row in ledger))
        normalized = clean_proposed_text(text)
        if not normalized or not valid_ids:
            return
        normalized_sentence_ids = (
            [_unique_strings(identifier for identifier in row if any(item.get("id") == identifier for item in ledger)) for row in sentence_ids]
            if sentence_ids is not None
            else None
        )
        entry = _create_provenance_entry(
            path,
            normalized,
            valid_ids,
            origin,
            ledger,
            normalized_sentence_ids,
            faq_row_id=faq_row_id,
            faq_can_recommend=faq_can_recommend,
            faq_card=faq_card,
            faq_scope_evidence=faq_scope_evidence,
        )
        if entry is not None:
            entries.append(entry)

    product = _find_node(graph, "Product")
    product_description = clean_text(product.get("description")) if product else ""
    if product_description:
        planned_field = as_dict(plan.get("productDescription"))
        planned_ids = (
            [str(item) for item in as_list(planned_field.get("evidenceIds")) if isinstance(item, str)]
            if plan.get("mode") == "model"
            and planned_field.get("include") is True
            and clean_proposed_text(clean_text(planned_field.get("text"))) == clean_proposed_text(product_description)
            else []
        )
        roles = (
            "identity",
            "description",
            "benefit",
            "effect",
            "ingredient",
            "audience",
            "metric",
            "faq",
            "review",
            "source",
        )
        selected, model_plan_origin = _select_plan_scoped_sentence_evidence(
            product_description,
            ledger,
            roles,
            planned_ids,
        )
        add(
            "Product.description",
            product_description,
            selected["evidenceIds"],
            "model-plan" if model_plan_origin else "deterministic-renderer",
            selected["sentenceEvidenceIds"],
        )

    webpage = _find_node(graph, "WebPage")
    webpage_description = clean_text(webpage.get("description")) if webpage else ""
    if webpage_description:
        planned_field = as_dict(plan.get("webPageDescription"))
        planned_ids = (
            [str(item) for item in as_list(planned_field.get("evidenceIds")) if isinstance(item, str)]
            if plan.get("mode") == "model"
            and planned_field.get("include") is True
            and clean_proposed_text(clean_text(planned_field.get("text"))) == clean_proposed_text(webpage_description)
            else []
        )
        roles = (
            "identity",
            "description",
            "benefit",
            "effect",
            "ingredient",
            "audience",
            "usage",
            "metric",
            "faq",
            "review",
            "source",
            # A page-scope description states the offer standing on the page.
            "commerce",
        )
        selected, model_plan_origin = _select_plan_scoped_sentence_evidence(
            webpage_description,
            ledger,
            roles,
            planned_ids,
        )
        add(
            "WebPage.description",
            webpage_description,
            selected["evidenceIds"],
            "model-plan" if model_plan_origin else "deterministic-renderer",
            selected["sentenceEvidenceIds"],
        )

    faq_page = _find_node(graph, "FAQPage")
    for index, raw in enumerate(as_list(faq_page.get("mainEntity") if faq_page else None)):
        item = as_dict(raw)
        answer = as_dict(item.get("acceptedAnswer"))
        question, answer_text = clean_text(item.get("name")), clean_text(answer.get("text"))
        if not question or not answer_text:
            continue
        membership = faq_membership[index] if faq_membership is not None and index < len(faq_membership) else None
        if faq_membership_supplied:
            # A caller that supplied membership has opted out of the legacy
            # text-pair lookup.  A malformed sidecar must therefore leave this
            # row unbound rather than silently borrowing broad ledger evidence.
            if membership is None:
                continue
            planned = as_dict(membership.get("plan"))
            planned_ids = [str(item) for item in as_list(membership.get("evidenceIds")) if isinstance(item, str)]
            faq_row_id = clean_text(membership.get("id"))
            faq_can_recommend = membership.get("canRecommend") is True
            faq_card = as_dict(membership.get("card"))
            # The row's scope is widened here rather than at one reader, because
            # every reader below rebuilds it from this list: the selector, and
            # the direct-claim check that ``add`` runs against
            # ``faq_scope_evidence``.  Widening it at the selector alone let a
            # sentence be selected and then dropped one step later, which is
            # the same row publishing nothing by a different route.
            planned_ids = [
                *planned_ids,
                *sorted(_faq_row_identity_ids_from_its_card(faq_card, ledger, set(planned_ids))),
            ]
        else:
            planned = _planned_faq_entry_for_rendered_pair(plan, question, answer_text)
            planned_matches = bool(
                planned.get("include") is True
                and planned.get("_deterministicCoverage") is not True
                and clean_proposed_text(clean_text(planned.get("question"))) == clean_proposed_text(question)
                and clean_proposed_text(clean_text(planned.get("answer"))) == clean_proposed_text(answer_text)
            )
            planned_ids = [str(item) for item in as_list(planned.get("evidenceIds")) if isinstance(item, str)] if planned_matches else []
            faq_row_id = None
            faq_can_recommend = False
            faq_card = {}
        roles = (
            "identity",
            "description",
            "benefit",
            "effect",
            "ingredient",
            "audience",
            "usage",
            "metric",
            "faq",
            "review",
            "source",
            "commerce",
        )
        question_selected, question_model_plan_origin = _select_plan_scoped_sentence_evidence(
            question,
            ledger,
            roles,
            planned_ids,
            require_plan_scope=True,
            faq_card=faq_card,
        )
        if faq_row_id and not question_selected["evidenceIds"]:
            scoped_question_evidence = _faq_membership_question_evidence(
                question,
                [item for item in ledger if clean_text(item.get("id")) in set(planned_ids)],
                faq_card=faq_card,
            )
            if scoped_question_evidence:
                scoped_ids = _unique_strings(item.get("id") for item in scoped_question_evidence)
                question_selected = {
                    "evidenceIds": scoped_ids,
                    "sentenceEvidenceIds": [scoped_ids for _ in _sentences(question)],
                }
        question_selected = cast(RenderedSentenceEvidence, question_selected)
        answer_selected, answer_model_plan_origin = _select_plan_scoped_sentence_evidence(
            answer_text,
            ledger,
            roles,
            planned_ids,
            require_plan_scope=True,
            stable_faq_membership_answer=bool(faq_row_id),
            faq_can_recommend=faq_can_recommend,
            faq_card=faq_card,
        )
        add(
            f"FAQPage.mainEntity[{index}].name",
            question,
            question_selected["evidenceIds"],
            "model-plan" if question_model_plan_origin else "deterministic-renderer",
            question_selected["sentenceEvidenceIds"],
            faq_row_id=faq_row_id,
            faq_can_recommend=faq_can_recommend,
            faq_card=faq_card,
            faq_scope_evidence=[item for item in ledger if clean_text(item.get("id")) in set(planned_ids)],
        )
        add(
            f"FAQPage.mainEntity[{index}].acceptedAnswer.text",
            answer_text,
            answer_selected["evidenceIds"],
            "model-plan" if answer_model_plan_origin else "deterministic-renderer",
            answer_selected["sentenceEvidenceIds"],
            faq_row_id=faq_row_id,
            faq_can_recommend=faq_can_recommend,
            faq_card=faq_card,
            faq_scope_evidence=[item for item in ledger if clean_text(item.get("id")) in set(planned_ids)],
        )

    howto = _find_node(graph, "HowTo")
    for index, raw in enumerate(as_list(howto.get("step") if howto else None)):
        item = as_dict(raw)
        text = clean_text(item.get("text"))
        if not text:
            continue
        planned_steps = as_list(as_dict(plan.get("howTo")).get("steps"))
        planned = as_dict(planned_steps[index] if index < len(planned_steps) else {})
        planned_ids = [str(item) for item in as_list(planned.get("evidenceIds")) if isinstance(item, str)]
        planned_matches = bool(
            plan.get("mode") == "model"
            and planned_ids
            and clean_proposed_text(clean_text(planned.get("text"))) == clean_proposed_text(text)
        )
        selected, model_plan_origin = _select_plan_scoped_sentence_evidence(
            text,
            ledger,
            ("usage",),
            planned_ids if planned_matches else [],
        )
        add(
            f"HowTo.step[{index}].text",
            text,
            selected["evidenceIds"],
            "model-plan" if model_plan_origin else "deterministic-renderer",
            selected["sentenceEvidenceIds"],
        )
    return entries


def reconcile_pdp_geo_public_copy_provenance(input_: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Rebuild final bindings without discarding a validated proofreading result.

    The final safe-repair stage can normalize punctuation after the proofreader
    has already rebased a description's sentence evidence.  Fresh plan/ledger
    matching remains the preferred fallback, but it must not erase an existing
    binding merely because that matching pass cannot rediscover an otherwise
    valid final sentence.  Prior entries are therefore canonicalized and
    revalidated against the *current* text before they are retained.
    """

    graph = _graph(as_dict(input_.get("schemaMarkup")))
    current = dict(_public_field_values(graph))
    ledger = _records(input_.get("evidenceLedger"))
    plan = as_dict(input_.get("contentPlan"))
    membership, _membership_supplied = _validated_faq_membership(input_, graph, plan, ledger)
    faq_card_context = _faq_membership_card_context_by_row_id(membership, ledger)
    rebuilt = create_pdp_geo_public_copy_provenance(input_)
    rebuilt_by_path = _validated_provenance_by_path(rebuilt, current, ledger, faq_card_context)
    prior = _revalidated_prior_provenance(input_, current, ledger, faq_card_context)
    prior_by_path = _validated_provenance_by_path(prior, current, ledger, faq_card_context)

    candidates = [
        prior_by_path[path] if path in prior_by_path else rebuilt_by_path[path]
        for path in current
        if path in prior_by_path or path in rebuilt_by_path
    ]
    return _retain_membership_scoped_faq_provenance(candidates, input_, graph, plan, ledger)


def _revalidated_prior_provenance(
    input_: Mapping[str, Any],
    current: Mapping[str, str],
    ledger: Sequence[Mapping[str, Any]],
    faq_card_context: Mapping[str, tuple[Mapping[str, Any], Sequence[Mapping[str, Any]]] | None] | None = None,
) -> list[dict[str, Any]]:
    """Rebase only internally valid prior entries to current safe-repaired text."""

    supplied: dict[str, list[dict[str, Any]]] = {}
    for raw in as_list(input_.get("publicCopyProvenance")):
        entry = as_dict(raw)
        path = clean_text(entry.get("fieldPath"))
        if path:
            supplied.setdefault(path, []).append(entry)

    rebased: list[dict[str, Any]] = []
    for path, text in current.items():
        entries = supplied.get(path, [])
        if len(entries) != 1:
            continue
        prior = _canonical_provenance_entry(
            path, clean_text(entries[0].get("text")), entries[0], ledger, faq_card_context
        )
        if prior is None:
            continue
        candidate = _rebase_provenance_entry_to_current_text(prior, text, ledger, faq_card_context)
        if candidate is not None:
            rebased.append(candidate)
    return rebased


def _validated_provenance_by_path(
    entries: Sequence[Mapping[str, Any]],
    current: Mapping[str, str],
    ledger: Sequence[Mapping[str, Any]],
    faq_card_context: Mapping[str, tuple[Mapping[str, Any], Sequence[Mapping[str, Any]]] | None] | None = None,
) -> dict[str, dict[str, Any]]:
    """Keep exactly one complete, current binding for every public field path."""

    candidates: dict[str, list[dict[str, Any]]] = {}
    for raw in entries:
        entry = as_dict(raw)
        path = clean_text(entry.get("fieldPath"))
        text = current.get(path)
        if not path or text is None:
            continue
        canonical = _canonical_provenance_entry(path, text, entry, ledger, faq_card_context)
        if canonical is not None:
            candidates.setdefault(path, []).append(canonical)
    return {path: rows[0] for path, rows in candidates.items() if len(rows) == 1}


def _retain_membership_scoped_faq_provenance(
    entries: Sequence[Mapping[str, Any]],
    input_: Mapping[str, Any],
    graph: Sequence[Mapping[str, Any]],
    plan: Mapping[str, Any],
    ledger: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """Drop stale or cross-row FAQ provenance when an identity sidecar exists."""

    membership, supplied = _validated_faq_membership(input_, graph, plan, ledger)
    if not supplied:
        # ``faqCanRecommend`` is an internal reflection of a validated
        # relationship card, never an authority carried by a prior public
        # provenance entry.  Legacy rows can retain ordinary direct support,
        # but a recommendation carrier must not survive without that card.
        return [
            copy.deepcopy(as_dict(entry))
            for entry in entries
            if not (
                clean_text(as_dict(entry).get("fieldPath")).startswith("FAQPage.mainEntity")
                and as_dict(entry).get("faqCanRecommend") is True
            )
        ]
    retained: list[dict[str, Any]] = []
    for raw in entries:
        entry = as_dict(raw)
        path = clean_text(entry.get("fieldPath"))
        if not path.startswith("FAQPage.mainEntity"):
            retained.append(copy.deepcopy(entry))
            continue
        index = _path_index(path, "FAQPage.mainEntity")
        row = membership[index] if membership is not None and isinstance(index, int) and index < len(membership) else None
        ids = {clean_text(item) for item in as_list(entry.get("evidenceIds")) if clean_text(item)}
        allowed_ids: set[str] = set()
        if row:
            for raw_id in as_list(row.get("evidenceIds")):
                identifier = clean_text(raw_id)
                if identifier:
                    allowed_ids.add(identifier)
        if (
            row
            and clean_text(entry.get("faqRowId")) == clean_text(row.get("id"))
            and (entry.get("faqCanRecommend") is True) == (row.get("canRecommend") is True)
            and ids.issubset(allowed_ids)
        ):
            retained.append(copy.deepcopy(entry))
    return retained


def _canonical_provenance_entry(
    path: str,
    text: str,
    entry: Mapping[str, Any],
    ledger: Sequence[Mapping[str, Any]],
    faq_card_context: Mapping[str, tuple[Mapping[str, Any], Sequence[Mapping[str, Any]]] | None] | None = None,
) -> dict[str, Any] | None:
    """Validate one provenance entry and return its canonical current form."""

    normalized = clean_proposed_text(text)
    if not normalized or clean_proposed_text(clean_text(entry.get("text"))) != normalized:
        return None
    if entry.get("sourceHash") != stable_text_hash(f"{path}\n{normalized}"):
        return None

    evidence_by_id = {clean_text(item.get("id")): item for item in ledger if clean_text(item.get("id"))}
    expected_sentences = _sentences(normalized)
    supplied_sentences = _records(entry.get("sentences"))
    if len(supplied_sentences) != len(expected_sentences):
        return None

    sentence_ids: list[list[str]] = []
    faq_can_recommend = entry.get("faqCanRecommend") is True
    faq_row_id = clean_text(entry.get("faqRowId"))
    faq_card, faq_scope_evidence = _faq_card_scope_or_empty(faq_card_context, faq_row_id)
    inherited_identity: list[Mapping[str, Any]] = []
    for index, (sentence, supplied) in enumerate(zip(expected_sentences, supplied_sentences, strict=True)):
        raw_ids = as_list(supplied.get("evidenceIds"))
        ids = [identifier for identifier in raw_ids if isinstance(identifier, str) and identifier in evidence_by_id]
        if (
            len(ids) != len(raw_ids)
            or clean_proposed_text(clean_text(supplied.get("text"))) != sentence
            or supplied.get("sourceHash") != stable_text_hash(f"{path}#sentence[{index}]\n{sentence}")
        ):
            return None
        if supplied.get("protected") is True:
            if raw_ids or not sentence_provenance_has_verbatim_source_support(sentence, ledger):
                return None
        elif not ids or not _entry_sentence_has_direct_support(
            path,
            sentence,
            [evidence_by_id[identifier] for identifier in ids],
            ledger,
            entry.get("origin"),
            clean_text(entry.get("faqRowId")),
            faq_can_recommend=faq_can_recommend,
            faq_card=faq_card,
            faq_scope_evidence=faq_scope_evidence,
            inherited_identity=inherited_identity,
        ):
            return None
        sentence_ids.append(ids)
        visible_identity = _faq_answer_sentence_identity_evidence(
            sentence, faq_scope_evidence or [evidence_by_id[identifier] for identifier in ids]
        )
        inherited_identity = visible_identity if visible_identity else inherited_identity

    canonical = _create_provenance_entry(
        path,
        normalized,
        [str(identifier) for identifier in as_list(entry.get("evidenceIds")) if isinstance(identifier, str)],
        clean_text(entry.get("origin")) or "deterministic-renderer",
        ledger,
        sentence_ids,
        faq_row_id=clean_text(entry.get("faqRowId")) or None,
        faq_can_recommend=faq_can_recommend,
        faq_card=faq_card,
        faq_scope_evidence=faq_scope_evidence,
    )
    if canonical is None:
        return None
    supplied_field_ids = [identifier for identifier in as_list(entry.get("evidenceIds")) if isinstance(identifier, str)]
    return canonical if supplied_field_ids == canonical["evidenceIds"] else None


def _rebase_provenance_entry_to_current_text(
    entry: Mapping[str, Any],
    text: str,
    ledger: Sequence[Mapping[str, Any]],
    faq_card_context: Mapping[str, tuple[Mapping[str, Any], Sequence[Mapping[str, Any]]] | None] | None = None,
) -> dict[str, Any] | None:
    """Carry prior sentence IDs through deterministic safe text normalization only.

    `_create_provenance_entry` independently validates every carried ID against
    the changed sentence, so a changed fact or role cannot inherit an old
    binding.  It also recreates protected-source markers only for verbatim
    source sentences.
    """

    path = clean_text(entry.get("fieldPath"))
    normalized = clean_proposed_text(text)
    previous = _records(entry.get("sentences"))
    current = _sentences(normalized)
    if not path or not normalized:
        return None

    by_text: dict[str, list[dict[str, Any]]] = {}
    for sentence in previous:
        by_text.setdefault(clean_proposed_text(clean_text(sentence.get("text"))), []).append(sentence)

    sentence_ids: list[list[str]] = []
    for index, sentence in enumerate(current):
        previous_sentence = (
            previous[index]
            if len(current) == len(previous)
            else (by_text.get(clean_proposed_text(sentence)) or [{}]).pop(0)
        )
        sentence_ids.append(
            [identifier for identifier in as_list(previous_sentence.get("evidenceIds")) if isinstance(identifier, str)]
        )
    faq_row_id = clean_text(entry.get("faqRowId"))
    faq_card, faq_scope_evidence = _faq_card_scope_or_empty(faq_card_context, faq_row_id)
    return _create_provenance_entry(
        path,
        normalized,
        [str(identifier) for identifier in as_list(entry.get("evidenceIds")) if isinstance(identifier, str)],
        clean_text(entry.get("origin")) or "deterministic-renderer",
        ledger,
        sentence_ids,
        faq_row_id=faq_row_id or None,
        faq_can_recommend=entry.get("faqCanRecommend") is True,
        faq_card=faq_card,
        faq_scope_evidence=faq_scope_evidence,
    )


def _faq_card_scope_or_empty(
    context: Mapping[str, tuple[Mapping[str, Any], Sequence[Mapping[str, Any]]] | None] | None,
    row_id: str,
) -> tuple[Mapping[str, Any], Sequence[Mapping[str, Any]]]:
    """Return a typed immutable FAQ-card scope, including the absent-row case."""

    scope = (context or {}).get(row_id)
    return scope if scope is not None else ({}, ())


def _faq_row_identity_ids_from_its_card(
    faq_card: Mapping[str, Any] | None,
    ledger: Sequence[Mapping[str, Any]],
    cited: set[str],
) -> set[str]:
    """Return the identity atoms this row's own card cites, when the row cited none.

    A FAQ row may rest only on what it cited, so that it cannot launder an
    unrelated fact out of the ledger.  The product's own name is not such a
    fact.  What comes back here widens the row's scope, so the row's question
    reads it as well as its answer; neither can assert anything with it,
    because an identity atom carries no fact to assert.  Every answer names the product -- the renderer puts it
    at the citation anchors -- and the reader needs an identity atom to tell
    that name apart from the words the answer asserts, so a row that listed
    only its facts left every one of its sentences holding the brand and the
    product name as words no source carried.  Measured: a safety row whose
    answer was written exactly as its two atoms record it published nothing,
    and the same answer bound the moment the identity atom was present.

    The identity comes from the row's own relationship card, which is
    service-owned and names the same product the row is about, so this widens
    nothing: the card already cites these atoms, and they are admitted only
    when the row itself cites no identity at all.
    """

    identity_ids = {
        clean_text(identifier)
        for claim in _faq_card_claims(as_dict(faq_card))
        if clean_text(claim.get("role")) == "identity"
        for identifier in as_list(claim.get("evidenceIds"))
        if clean_text(identifier)
    }
    if not identity_ids:
        return set()
    # Whether the row already cites an identity is read off the same claims
    # that would supply one, and the ledger is only asked whether those atoms
    # exist.  Deciding it on the ledger's own roles instead would let the two
    # halves disagree: a row could cite an atom the ledger calls identity that
    # no claim of this card names, and the widening would fire anyway.
    known = {clean_text(item.get("id")) for item in ledger}
    cited_ids = {clean_text(identifier) for identifier in cited}
    if identity_ids & cited_ids:
        return set()
    return identity_ids & known


def _select_plan_scoped_sentence_evidence(
    text: str,
    ledger: Sequence[Mapping[str, Any]],
    roles: Sequence[str],
    planned_ids: Sequence[str],
    *,
    require_plan_scope: bool = False,
    stable_faq_membership_answer: bool = False,
    faq_can_recommend: bool = False,
    faq_card: Mapping[str, Any] | None = None,
) -> tuple[RenderedSentenceEvidence, bool]:
    """Use model-plan provenance only when its selected evidence supports the rendered text.

    A description can legitimately differ from a stale plan after a safe
    repair or deterministic rendering fallback, so it may rebind from the
    complete ledger.  A matched model FAQ is stricter: its answer may bind
    only to the cited IDs, avoiding broad-ledger provenance laundering.
    """

    if planned_ids:
        planned_id_set = set(planned_ids)
        planned_evidence = [item for item in ledger if str(item.get("id") or "") in planned_id_set]
        # A model description is already admitted sentence-by-sentence against
        # these exact IDs.  Preserve an explicitly cited source role (for
        # example, an option/price ``commerce`` fact) instead of making the
        # renderer-only role profile erase the whole otherwise-grounded field.
        # The direct-claim check below still runs for each final sentence; this
        # only widens the role *selection* to the plan's own evidence, not the
        # fallback scan across the complete ledger.
        planned_roles = _unique_strings([*roles, *(clean_text(item.get("role")) for item in planned_evidence)])
        planned = _rendered_sentence_evidence(text, planned_evidence, planned_roles)
        if stable_faq_membership_answer:
            planned = _stable_faq_membership_answer_sentence_evidence(
                text,
                planned,
                planned_evidence,
                faq_can_recommend=faq_can_recommend,
                faq_card=faq_card,
            )
        if planned["sentenceEvidenceIds"] and all(planned["sentenceEvidenceIds"]):
            return planned, True
        if require_plan_scope:
            return planned, True
    if require_plan_scope:
        # FAQ rows must never fall through to the whole ledger.  The model
        # supplied a row-specific relationship card; when that card cannot
        # support the rendered sentence, diagnostics should expose the gap
        # rather than make an unrelated fact look like its provenance.
        return {
            "evidenceIds": [],
            "sentenceEvidenceIds": [[] for _ in _sentences(text)],
        }, bool(planned_ids)
    return _rendered_sentence_evidence(text, ledger, roles), False


def create_pdp_geo_public_copy_provenance_decision_diagnostics(
    input_: Mapping[str, Any], *, phase: ProvenanceDecisionPhase
) -> list[dict[str, Any]]:
    """Describe final-copy binding decisions without returning copy or source material.

    This is deliberately a separate, read-only view from
    ``create_pdp_geo_public_copy_provenance``.  Operators need to distinguish a
    stale model-plan text match from a renderer sentence that failed semantic
    support, but the operational payload must not echo the candidate text,
    ledger values, evidence IDs, URLs, or hashes.
    """

    if phase not in _PROVENANCE_DECISION_PHASES:
        raise ValueError(f"Unsupported public-copy provenance diagnostic phase: {phase}")

    graph = _graph(as_dict(input_.get("schemaMarkup")))
    ledger = _records(input_.get("evidenceLedger"))
    plan = as_dict(input_.get("contentPlan"))
    faq_membership, faq_membership_supplied = _validated_faq_membership(input_, graph, plan, ledger)
    current = dict(_public_field_values(graph))
    retained = {
        clean_text(entry.get("fieldPath")): _records(entry.get("sentences"))
        for entry in _valid_current_provenance(input_)
        if clean_text(entry.get("fieldPath"))
    }
    # Which fields the binder wrote an entry for, which is a different question
    # from which entries still revalidate above: a description entry that
    # records one unprovable sentence with no evidence is rejected here as a
    # whole, and its proven sentences were still written.  A field absent from
    # what the caller supplied is the one that was never written at all.  When
    # nothing was supplied this view is the selector's own and has no entry to
    # read, so no field counts as unwritten.
    provenance_supplied = "publicCopyProvenance" in input_
    recorded_paths = {
        clean_text(as_dict(entry).get("fieldPath"))
        for entry in as_list(input_.get("publicCopyProvenance"))
        if clean_text(as_dict(entry).get("fieldPath"))
    }
    decisions: list[dict[str, Any]] = []

    # Product/WebPage descriptions are schema targets even when a renderer
    # omitted them entirely.  Represent that absence explicitly so a live run
    # does not conflate it with a sentence that the semantic binder rejected.
    for path in ("Product.description", "WebPage.description"):
        if path in current:
            continue
        roles, _planned_ids, plan_metadata = _provenance_decision_context(
            path, "", graph, plan, faq_membership, faq_membership_supplied
        )
        del roles
        decisions.append(
            {
                "fieldPath": path,
                "phase": phase,
                "sentenceIndex": None,
                "outcome": "notPresent",
                "reason": "notPresent",
                "plan": plan_metadata,
                "eligibleEvidenceCount": 0,
                "eligibleRoleCounts": {},
                "selectedEvidenceCount": 0,
            }
        )

    for path, text in _public_field_values(graph):
        roles, planned_ids, plan_metadata = _provenance_decision_context(
            path, text, graph, plan, faq_membership, faq_membership_supplied
        )
        faq_index = _path_index(path, "FAQPage.mainEntity")
        membership = (
            faq_membership[faq_index]
            if faq_membership is not None and isinstance(faq_index, int) and faq_index < len(faq_membership)
            else {}
        )
        faq_card = as_dict(membership.get("card"))
        if path.endswith(".acceptedAnswer.text") and plan_metadata.get("faqRowId"):
            # The same widening the provenance pass applies, so this view
            # counts the row's scope the way the pass that publishes it does.
            # Leaving it out made ``selectedEvidenceCount`` exceed
            # ``eligibleEvidenceCount`` and put the reason for a bound
            # sentence outside the evidence it was bound to.
            planned_ids = [
                *planned_ids,
                *sorted(_faq_row_identity_ids_from_its_card(faq_card, ledger, set(planned_ids))),
            ]
        selected, model_plan_origin = _select_plan_scoped_sentence_evidence(
            text,
            ledger,
            roles,
            planned_ids,
            require_plan_scope=path.startswith("FAQPage.mainEntity"),
            stable_faq_membership_answer=(
                path.endswith(".acceptedAnswer.text") and bool(plan_metadata.get("faqRowId"))
            ),
            faq_can_recommend=plan_metadata.get("faqCanRecommend") is True,
            faq_card=faq_card,
        )
        if path.endswith(".name") and membership and not selected["evidenceIds"]:
            scoped_question = _faq_membership_question_evidence(
                text,
                [item for item in ledger if clean_text(item.get("id")) in set(planned_ids)],
                faq_card=faq_card,
            )
            if scoped_question:
                scoped_ids = _unique_strings(item.get("id") for item in scoped_question)
                selected = {
                    "evidenceIds": scoped_ids,
                    "sentenceEvidenceIds": [scoped_ids for _ in _sentences(text)],
                }
        if model_plan_origin:
            planned_id_set = set(planned_ids)
            eligible = [item for item in ledger if str(item.get("id") or "") in planned_id_set]
        else:
            eligible = [item for item in ledger if clean_text(item.get("role")) in roles]
        retained_sentences = retained.get(path, [])
        field_has_no_entry = provenance_supplied and path not in recorded_paths
        selected_by_sentence = selected["sentenceEvidenceIds"]
        for index, sentence in enumerate(_sentences(text)):
            selected_ids = selected_by_sentence[index] if index < len(selected_by_sentence) else []
            retained_sentence = retained_sentences[index] if index < len(retained_sentences) else {}
            accepted_reason = (
                "explicitRelationAccepted"
                if (
                    _english_explicit_audience_relation_binding(sentence, eligible)
                    or _source_faq_identity_question_binding(sentence, eligible)
                    or _english_customer_concern_question_binding(sentence, eligible)
                    or _english_buyer_audience_question_binding(sentence, eligible)
                    or _english_generic_subject_source_description_binding(sentence, eligible)
                )
                else "directSupportAccepted"
            )
            if retained_sentence:
                protected = retained_sentence.get("protected") is True
                retained_ids = as_list(retained_sentence.get("evidenceIds"))
                # A retained row with neither evidence nor protection is the
                # entry saying this one sentence could not be proven.  Reading
                # it as bound -- because selection had offered IDs for it --
                # left the omission step unable to name the sentence, so it
                # removed the whole field instead of that sentence.
                outcome = "protected" if protected else "bound" if retained_ids else "unsupported"
                reason = (
                    "verbatimSource"
                    if protected
                    else _provenance_decision_unsupported_reason(sentence, eligible)
                    if not retained_ids
                    else "planTextMismatch"
                    if plan_metadata["textHashMatch"] is False
                    else accepted_reason
                )
                selected_count = len(retained_ids)
            elif field_has_no_entry and selected_ids:
                # No entry was written for this field, so nothing in it is
                # bound however much selection offered: an answer and a step
                # are each one unit, and one unprovable sentence leaves the
                # whole entry unwritten.  Calling the offer bound made every
                # sentence of a field that was being dropped look proven, so
                # the omission step found no cause to report and fell back to
                # naming an unresolved binding, which hides that there was no
                # entry to resolve.  This is not the sentence saying it could
                # not be proven -- that is what ``unsupported`` says, and it is
                # what decides which sentences a separable description drops --
                # so it is its own outcome.
                outcome = "unrecorded"
                reason = "noProvenanceEntry"
                selected_count = len(selected_ids)
            elif selected_ids:
                outcome = "bound"
                reason = "planTextMismatch" if plan_metadata["textHashMatch"] is False else accepted_reason
                selected_count = len(selected_ids)
            elif sentence_provenance_has_verbatim_source_support(sentence, ledger):
                outcome = "protected"
                reason = "verbatimSource"
                selected_count = 0
            else:
                outcome = "unsupported"
                reason = _provenance_decision_unsupported_reason(sentence, eligible)
                selected_count = 0
            decisions.append(
                {
                    "fieldPath": path,
                    "phase": phase,
                    "sentenceIndex": index,
                    "outcome": outcome,
                    "reason": reason,
                    "plan": plan_metadata,
                    "eligibleEvidenceCount": len(eligible),
                    "eligibleRoleCounts": _provenance_decision_role_counts(eligible),
                    "selectedEvidenceCount": selected_count,
                    **({"faqRowId": plan_metadata["faqRowId"]} if plan_metadata.get("faqRowId") else {}),
                }
            )
    return decisions


def _provenance_decision_context(
    path: str,
    text: str,
    graph: Sequence[Mapping[str, Any]],
    plan: Mapping[str, Any],
    faq_membership: Sequence[Mapping[str, Any]] | None = None,
    faq_membership_supplied: bool = False,
) -> tuple[tuple[str, ...], list[str], dict[str, str | bool | None]]:
    """Return only the plan state needed to explain a binder decision."""

    model_mode = plan.get("mode") == "model"
    default_metadata: dict[str, str | bool | None] = {
        "mode": "model" if model_mode else "nonModel",
        "fieldIncluded": None,
        "textHashMatch": None,
    }
    if path == "Product.description":
        field = as_dict(plan.get("productDescription"))
        included = field.get("include") if isinstance(field.get("include"), bool) else None
        text_hash_match = (
            clean_proposed_text(clean_text(field.get("text"))) == clean_proposed_text(text)
            if model_mode and included is True and text
            else None
        )
        planned_ids = (
            [str(item) for item in as_list(field.get("evidenceIds")) if isinstance(item, str)]
            if text_hash_match is True
            else []
        )
        return (
            (
                "identity",
                "description",
                "benefit",
                "effect",
                "ingredient",
                "audience",
                "metric",
                "faq",
                "review",
                "source",
            ),
            planned_ids,
            {**default_metadata, "fieldIncluded": included, "textHashMatch": text_hash_match},
        )
    if path == "WebPage.description":
        field = as_dict(plan.get("webPageDescription"))
        included = field.get("include") if isinstance(field.get("include"), bool) else None
        text_hash_match = (
            clean_proposed_text(clean_text(field.get("text"))) == clean_proposed_text(text)
            if model_mode and included is True and text
            else None
        )
        planned_ids = (
            [str(item) for item in as_list(field.get("evidenceIds")) if isinstance(item, str)]
            if text_hash_match is True
            else []
        )
        return (
            (
                "identity",
                "description",
                "benefit",
                "effect",
                "ingredient",
                "audience",
                "usage",
                "metric",
                "faq",
                "review",
                "source",
                # A page-scope description states the offer standing on the page.
                "commerce",
            ),
            planned_ids,
            {**default_metadata, "fieldIncluded": included, "textHashMatch": text_hash_match},
        )
    if path.startswith("FAQPage.mainEntity"):
        index = _path_index(path, "FAQPage.mainEntity")
        faq = _find_node(graph, "FAQPage")
        entities = _records(faq.get("mainEntity")) if faq else []
        entity = entities[index] if isinstance(index, int) and index < len(entities) else {}
        answer = as_dict(entity.get("acceptedAnswer"))
        question = clean_text(entity.get("name"))
        answer_text = clean_text(answer.get("text"))
        membership = (
            as_dict(faq_membership[index])
            if faq_membership is not None and isinstance(index, int) and index < len(faq_membership)
            else {}
        )
        field = (
            as_dict(membership.get("plan"))
            if faq_membership_supplied and membership
            else _planned_faq_entry_for_rendered_pair(plan, question, answer_text)
            if question and answer_text and not faq_membership_supplied
            else {}
        )
        included = field.get("include") if isinstance(field.get("include"), bool) else None
        question_match = clean_proposed_text(clean_text(field.get("question"))) == clean_proposed_text(question)
        answer_match = clean_proposed_text(clean_text(field.get("answer"))) == clean_proposed_text(answer_text)
        text_hash_match = (
            question_match if path.endswith(".name") else answer_match
        ) if model_mode and included is True and text else None
        planned_ids = (
            [str(item) for item in as_list(membership.get("evidenceIds")) if isinstance(item, str)]
            if faq_membership_supplied and membership and model_mode and included is True
            else [str(item) for item in as_list(field.get("evidenceIds")) if isinstance(item, str)]
            if model_mode
            and included is True
            and field.get("_deterministicCoverage") is not True
            and question_match
            and answer_match
            else []
        )
        return (
            (
                "identity",
                "description",
                "benefit",
                "effect",
                "ingredient",
                "audience",
                "usage",
                "metric",
                "faq",
                "review",
                "source",
                "commerce",
            ),
            planned_ids,
            {
                **default_metadata,
                "fieldIncluded": included,
                "textHashMatch": text_hash_match,
                **({"faqRowId": clean_text(membership.get("id"))} if membership else {}),
                **({"faqCanRecommend": membership.get("canRecommend") is True} if membership else {}),
                **({"membershipState": "invalid"} if faq_membership_supplied and not membership else {}),
            },
        )

    index = _path_index(path, "HowTo.step")
    how_to = as_dict(plan.get("howTo"))
    steps = as_list(how_to.get("steps"))
    field = as_dict(steps[index] if isinstance(index, int) and index < len(steps) else {})
    included = field.get("include") if isinstance(field.get("include"), bool) else None
    text_hash_match = (
        clean_proposed_text(clean_text(field.get("text"))) == clean_proposed_text(text)
        if model_mode and text and field
        else None
    )
    planned_ids = (
        [str(item) for item in as_list(field.get("evidenceIds")) if isinstance(item, str)]
        if text_hash_match is True
        else []
    )
    return (
        ("usage",),
        planned_ids,
        {**default_metadata, "fieldIncluded": included, "textHashMatch": text_hash_match},
    )


def _provenance_decision_unsupported_reason(sentence: str, eligible: Sequence[Mapping[str, Any]]) -> str:
    if not eligible:
        return "noEligibleEvidence"
    if not _sentence_assertion_frame_is_supported(sentence, eligible):
        return "assertionFrameRejected"
    return "directSupportRejected"


def _provenance_decision_role_counts(evidence: Sequence[Mapping[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for item in evidence:
        role = clean_text(item.get("role"))
        if role in _PROVENANCE_DIAGNOSTIC_ROLES:
            counts[role] = counts.get(role, 0) + 1
    return {role: counts[role] for role in sorted(counts)}


def _validated_faq_membership(
    input_: Mapping[str, Any],
    graph: Sequence[Mapping[str, Any]],
    plan: Mapping[str, Any],
    ledger: Sequence[Mapping[str, Any]],
) -> tuple[list[dict[str, Any]] | None, bool]:
    """Return the ordered FAQ row scope, or flag an invalid supplied sidecar.

    ``faqMembership`` is intentionally an internal identity/evidence sidecar,
    not public FAQ copy.  Its presence means later stages must use its stable
    row IDs instead of recovering ownership from mutable question/answer text.
    An invalid supplied sidecar is *not* compatible with the legacy path: that
    would turn a data-integrity failure into broad-ledger provenance.
    """

    if "faqMembership" not in input_:
        return None, False

    faq = _find_node(graph, "FAQPage")
    entities = _records(faq.get("mainEntity")) if faq else []
    supplied = [as_dict(item) for item in as_list(input_.get("faqMembership"))]
    if len(supplied) != len(entities) or plan.get("mode") != "model":
        return None, True

    approved_rows = [
        as_dict(raw)
        for raw in as_list(plan.get("faq"))
        if as_dict(raw).get("include") is True and as_dict(raw).get("_deterministicCoverage") is not True
    ]
    approved_by_id: dict[str, dict[str, Any]] = {}
    for row in approved_rows:
        row_id = clean_text(row.get("id"))
        if not row_id or row_id in approved_by_id:
            return None, True
        approved_by_id[row_id] = row
    cards_by_id: dict[str, dict[str, Any]] = {}
    duplicate_card_ids: set[str] = set()
    for raw in as_list(plan.get("faqRelationshipCards")):
        card = as_dict(raw)
        card_id = clean_text(card.get("id"))
        if not card_id:
            continue
        if card_id in cards_by_id:
            duplicate_card_ids.add(card_id)
            continue
        cards_by_id[card_id] = card

    known_ids = {clean_text(item.get("id")) for item in ledger if clean_text(item.get("id"))}
    resolved: list[dict[str, Any]] = []
    seen: set[str] = set()
    for member in supplied:
        row_id = clean_text(member.get("id"))
        member_ids = _unique_strings(clean_text(item) for item in as_list(member.get("evidenceIds")) if clean_text(item))
        plan_row = approved_by_id.get(row_id)
        plan_ids = (
            _unique_strings(clean_text(item) for item in as_list(plan_row.get("evidenceIds")) if clean_text(item))
            if plan_row
            else []
        )
        if (
            not row_id
            or row_id in seen
            or plan_row is None
            or not member_ids
            or member_ids != plan_ids
            or not all(identifier in known_ids for identifier in member_ids)
        ):
            return None, True
        card = cards_by_id.get(row_id) if row_id not in duplicate_card_ids else None
        card_can_recommend = card is not None and card.get("canRecommend") is True
        # Membership is a service-produced mirror of relationship-card
        # authority.  A caller may omit the newer mirror for compatibility,
        # but an explicitly supplied disagreement is an integrity failure,
        # not a reason to trust either public row.
        if "canRecommend" in member and (
            not isinstance(member.get("canRecommend"), bool)
            or member.get("canRecommend") is not card_can_recommend
        ):
            return None, True
        card_scope = _validated_faq_relationship_card_scope(
            card,
            row_id=row_id,
            intent=clean_text(plan_row.get("intent")),
            evidence_ids=member_ids,
            known_ids=known_ids,
        )
        seen.add(row_id)
        resolved.append(
            {
                "id": row_id,
                "intent": clean_text(member.get("intent")) or clean_text(plan_row.get("intent")),
                "evidenceIds": member_ids,
                "plan": plan_row,
                "canRecommend": card_can_recommend,
                **({"card": card_scope} if card_scope else {}),
            }
        )
    return resolved, True


def _validated_faq_relationship_card_scope(
    card: Mapping[str, Any] | None,
    *,
    row_id: str,
    intent: str,
    evidence_ids: Sequence[str],
    known_ids: set[str],
) -> dict[str, Any] | None:
    """Return a row-local immutable card scope only when every link is intact.

    Cards are service-owned admission context, but the final proofreader still
    validates their ID, intent, claim evidence, and relationship labels before
    using them to retain a natural FAQ rewrite.  A malformed or incomplete
    card merely loses this narrow exception; it cannot open a broad ledger
    fallback.

    A claim belongs to the card, and the row cites part of what the card
    covers -- the check above is what makes that true.  Measuring the claim
    against the row's own citations instead read the wider list as the error:
    nineteen non-identity claims were dropped across eleven live rows and
    three cards lost every claim they had, so a row whose card was perfectly
    intact was answered as though it had no card at all.  A claim therefore
    has to stay inside the card and touch the row, and touching the row is
    what makes it this row's claim.

    Identity is the exception, because it is not a claim of that kind.  It
    carries no fact to launder -- it names the product the card and the row are
    both about -- and a row cites the facts it answers with, not the product it
    is obviously for.  Holding it to the same test dropped it, and a card whose
    identity is gone fails the check below and is discarded whole, so a row
    that simply listed its two facts was read as having no card at all: every
    card-scoped reading went with it, and the answer, written exactly as its
    atoms record it, published nothing.  The identity still has to be one this
    card cites and the ledger knows, and the reader that consumes it admits
    those atoms only when the row cites no identity of its own.
    """

    raw = as_dict(card)
    if not raw or clean_text(raw.get("id")) != row_id or clean_text(raw.get("intent")) != intent:
        return None
    card_ids = _unique_strings(clean_text(value) for value in as_list(raw.get("evidenceIds")) if clean_text(value))
    membership_ids = set(evidence_ids)
    if not card_ids or not set(card_ids).issubset(known_ids) or not membership_ids.issubset(card_ids):
        return None
    claims: list[dict[str, Any]] = []
    for raw_claim in as_list(raw.get("claims")):
        claim = as_dict(raw_claim)
        role = clean_text(claim.get("role"))
        relationship = clean_text(claim.get("relationship"))
        claim_ids = _unique_strings(
            clean_text(value) for value in as_list(claim.get("evidenceIds")) if clean_text(value)
        )
        if (
            not role
            or relationship not in {"explicit", "independent"}
            or not clean_text(claim.get("text"))
            or not claim_ids
            or not set(claim_ids).issubset(card_ids)
            or (role != "identity" and not set(claim_ids).intersection(membership_ids))
            or not set(claim_ids).issubset(known_ids)
        ):
            continue
        claims.append({**claim, "role": role, "relationship": relationship, "evidenceIds": claim_ids})
    identities = [claim for claim in claims if claim["role"] == "identity"]
    if not claims or not identities or not any(claim["role"] != "identity" for claim in claims):
        return None
    return {
        "id": row_id,
        "intent": intent,
        "canRecommend": raw.get("canRecommend") is True,
        "claims": claims,
        "evidenceIds": card_ids,
    }


def _faq_membership_card_context_by_row_id(
    membership: Sequence[Mapping[str, Any]] | None,
    ledger: Sequence[Mapping[str, Any]],
) -> dict[str, tuple[dict[str, Any], list[Mapping[str, Any]]]]:
    """Index validated card/scope context without placing it in public output."""

    by_id = {clean_text(item.get("id")): item for item in ledger if clean_text(item.get("id"))}
    contexts: dict[str, tuple[dict[str, Any], list[Mapping[str, Any]]]] = {}
    for row in membership or []:
        row_id = clean_text(row.get("id"))
        if not row_id or row_id in contexts:
            continue
        scope = [
            by_id[identifier]
            for raw_identifier in as_list(row.get("evidenceIds"))
            if (identifier := clean_text(raw_identifier)) in by_id
        ]
        contexts[row_id] = (as_dict(row.get("card")), scope)
    return contexts


def _planned_faq_entry_for_rendered_pair(plan: Mapping[str, Any], question: str, answer: str) -> dict[str, Any]:
    """Find the approved FAQ row by its stable question/answer identity.

    JSON-LD consumers are allowed to reorder FAQ items.  Index-based plan
    lookup then makes otherwise-valid evidence appear to belong to a different
    question, so only a normalized pair (or an unambiguous question) can bind
    a rendered row to its model plan entry.
    """

    if plan.get("mode") != "model":
        return {}
    candidates = [
        as_dict(raw)
        for raw in as_list(plan.get("faq"))
        if as_dict(raw).get("include") is True
        and _faq_identity_part(clean_text(as_dict(raw).get("question")))
        and _faq_identity_part(clean_text(as_dict(raw).get("answer")))
    ]
    rendered_pair = _faq_pair_identity(question, answer)
    pair_matches = [item for item in candidates if _faq_pair_identity(clean_text(item.get("question")), clean_text(item.get("answer"))) == rendered_pair]
    if len(pair_matches) == 1:
        return pair_matches[0]
    rendered_question = _faq_identity_part(question)
    question_matches = [item for item in candidates if _faq_identity_part(clean_text(item.get("question"))) == rendered_question]
    return question_matches[0] if len(question_matches) == 1 else {}


def _faq_pair_identity(question: str, answer: str) -> str:
    return f"{_faq_identity_part(question)}\x1f{_faq_identity_part(answer)}"


def _faq_identity_part(value: str) -> str:
    return re.sub(r"[^\w가-힣ぁ-んァ-ン一-龯]+", "", clean_proposed_text(value).casefold())


async def final_proofread_pdp_geo_artifacts(
    input_: Mapping[str, Any], options: Mapping[str, Any] | None = None
) -> dict[str, Any]:
    """Run one bounded fluency pass, rejecting any unsafe proposal.

    A rejected initial proposal gets exactly one retry containing its reason.
    Any provider exception or malformed response preserves the original
    artifacts, so library callers can safely enable the optional stage.
    """

    runtime = as_dict(options)
    base = _base_application(input_)
    # Extraction is a diagnostics/provenance operation, not a provider-only
    # operation.  TypeScript records unavailable fields even when proofreading
    # is disabled or no model is configured, so operators can distinguish a
    # skipped field from a stage that simply was never asked to inspect it.
    bindings, skipped = _extract_bindings(input_)
    diagnostics = cast(dict[str, Any], base["diagnostics"])
    diagnostics["skippedFields"] = skipped
    diagnostics["warnings"].extend(
        f"{item['fieldPath']} was not sent to final proofreading: {item['reason']}" for item in skipped
    )
    if as_dict(runtime.get("finalProofreading")).get("enabled") is False:
        return base
    proofreader, warning = _resolve_proofreader(runtime)
    if proofreader is None:
        if warning:
            base["evidence"].append(
                {"field": "finalProofreading", "source": "llm", "value": f"Final proofreading skipped: {warning}"}
            )
            base["diagnostics"]["warnings"].append(warning)
        return base

    if not bindings:
        diagnostics["warnings"].append(
            "Final proofreading skipped because no eligible public-copy fields were present."
        )
        return base

    fields: list[dict[str, Any]] = [as_dict(binding.get("field")) for binding in bindings]
    request: dict[str, Any] = {
        "locale": str(input_.get("locale") or "en-US"),
        "market": input_.get("market"),
        "productName": clean_text(as_dict(input_.get("product")).get("name")),
        "brand": clean_text(as_dict(input_.get("product")).get("brand")) or None,
        "fields": fields,
        "evidenceLedger": [as_dict(item) for item in as_list(input_.get("evidenceLedger"))],
    }
    try:
        result = await _proofread(proofreader, request)
        envelope_error = _validate_envelope(request["fields"], as_list(result.get("edits")))
        if envelope_error:
            return _reject_whole_application(base, result, envelope_error)
        accepted, rejected = _gate_edits(bindings, as_list(result.get("edits")), input_)
        usage = result.get("usage")
        warnings = [*as_list(diagnostics.get("warnings")), *[str(item) for item in as_list(result.get("warnings"))]]

        retry_bindings: list[dict[str, Any]] = [
            binding
            for binding in bindings
            if any(item.get("fieldPath") == binding["field"]["fieldPath"] for item in rejected)
        ]
        if retry_bindings:
            retry_fields: list[dict[str, Any]] = []
            for binding in retry_bindings:
                field = dict(as_dict(binding.get("field")))
                rejection: dict[str, str] = next(
                    (item for item in rejected if item.get("fieldPath") == field.get("fieldPath")),
                    {"reason": "The prior edit was rejected by a deterministic invariant gate."},
                )
                field["priorRejection"] = rejection.get(
                    "reason", "The prior edit was rejected by a deterministic invariant gate."
                )
                retry_fields.append(field)
            retry_result = await _proofread(proofreader, {**request, "fields": retry_fields})
            retry_error = _validate_envelope(retry_fields, as_list(retry_result.get("edits")))
            if retry_error:
                warnings.append(f"Final proofreading retry was rejected: {retry_error}")
            else:
                retry_accepted, retry_rejected = _gate_edits(retry_bindings, as_list(retry_result.get("edits")), input_)
                retried_paths = {str(binding["field"]["fieldPath"]) for binding in retry_bindings}
                accepted.extend(retry_accepted)
                rejected = [item for item in rejected if item.get("fieldPath") not in retried_paths]
                rejected.extend(retry_rejected)
                warnings.extend(str(item) for item in as_list(retry_result.get("warnings")))
                usage = _merge_usage(usage, retry_result.get("usage"))

        applied = (
            _apply_accepted_edits(input_, bindings, accepted)
            if accepted
            else {
                "schemaMarkup": as_dict(input_.get("schemaMarkup")),
                "content": as_dict(input_.get("content")),
                "faqMembership": copy.deepcopy(as_list(input_.get("faqMembership"))),
            }
        )
        final_provenance = _rebase_provenance(input_, bindings, accepted) if accepted else _valid_current_provenance(input_)
        if _introduces_validation_findings(input_, applied, final_provenance):
            reason = "All proposed edits were reverted because read-only validation found new issues."
            return _reverted_application(base, result, rejected, reason, warnings)
        accepted_fields = [str(item["fieldPath"]) for item in accepted]
        diagnostics.update(
            {
                "status": "applied" if accepted_fields else "rejected" if rejected else "kept",
                "called": True,
                "applied": bool(accepted_fields),
                "acceptedFields": accepted_fields,
                "acceptedEdits": _accepted_edit_diagnostics(bindings, accepted),
                "rejectedEdits": rejected,
                "warnings": _unique_strings([*warnings, *[str(item.get("reason", "")) for item in rejected]]),
                "finalPublicCopyProvenance": final_provenance,
                "provenanceDecisionDiagnostics": create_pdp_geo_public_copy_provenance_decision_diagnostics(
                    {**input_, **applied, "publicCopyProvenance": final_provenance}, phase="afterProofreader"
                ),
            }
        )
        return {
            **applied,
            "evidence": [
                {
                    "field": "finalProofreading",
                    "source": "llm",
                    "value": (
                        f"Accepted fluency-only edits for: {', '.join(accepted_fields)}."
                        if accepted_fields
                        else "The final proofreader was called, but no proposed text changes passed the invariant gates."
                    ),
                },
                *[
                    {
                        "field": f"finalProofreading.{item.get('fieldPath', '')}",
                        "source": "llm",
                        "value": f"Rejected: {item['reason']}",
                    }
                    for item in rejected
                ],
            ],
            "usage": usage,
            "diagnostics": diagnostics,
            "finalPublicCopyProvenance": final_provenance,
            "faqMembership": copy.deepcopy(as_list(input_.get("faqMembership"))),
        }
    except Exception as error:  # provider failure is intentionally fail-closed
        message = str(error) or "Final proofreading provider failed."
        diagnostics.update(
            {
                "status": "failed",
                "called": True,
                "applied": False,
                "rejectedEdits": [{"reason": message}],
                "warnings": _unique_strings([*as_list(diagnostics.get("warnings")), message]),
            }
        )
        base["evidence"] = [
            {"field": "finalProofreading", "source": "llm", "value": f"Final proofreading failed closed: {message}"}
        ]
        return base


class ModelBackedFinalProofreader:
    """Provider-neutral adapter delegated to the package provider layer."""

    def __init__(self, config: Mapping[str, Any]) -> None:
        self.config = dict(config)

    async def proofread(self, request: Mapping[str, Any]) -> Mapping[str, Any]:
        from .providers import create_provider

        provider = create_provider(self.config)
        prompt = create_final_proofreading_prompt(request)
        return await provider.generate_json(
            stage="final-proofreading",
            system=prompt["system"],
            user=prompt["user"],
            json_schema=pdp_geo_final_proofreading_json_schema,
            max_output_tokens=(
                self.config["maxOutputTokens"]
                if self.config.get("maxOutputTokens") is not None
                else _DEFAULT_FINAL_PROOFREADING_MAX_OUTPUT_TOKENS
            ),
        )


def create_final_proofreading_prompt(request: Mapping[str, Any]) -> _FinalProofreadingPrompt:
    """Build the legacy proofreader's compact field-only provider prompt."""

    return {
        "system": _FINAL_PROOFREADING_SYSTEM_PROMPT,
        "user": js_json_dumps(
            {field: request[field] for field in ("locale", "market", "productName", "brand", "fields") if field in request}
        ),
    }


pdp_geo_final_proofreading_json_schema: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "edits": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "fieldPath": {"type": "string"},
                    "sourceHash": {"type": "string"},
                    "action": {"type": "string", "enum": ["keep", "revise"]},
                    "revisedText": {"type": "string"},
                    "issueCodes": {"type": "array", "items": {"type": "string", "enum": sorted(_ISSUE_CODES)}},
                },
                "required": ["fieldPath", "sourceHash", "action", "revisedText", "issueCodes"],
            },
        },
        "warnings": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["edits", "warnings"],
}


def _base_application(input_: Mapping[str, Any]) -> dict[str, Any]:
    markup = as_dict(input_.get("schemaMarkup"))
    content = as_dict(input_.get("content"))
    provenance = _valid_current_provenance(input_)
    return {
        "schemaMarkup": markup,
        "content": content,
        "faqMembership": copy.deepcopy(as_list(input_.get("faqMembership"))),
        "evidence": [],
        "finalPublicCopyProvenance": provenance,
        "diagnostics": {
            "status": "skipped",
            "called": False,
            "applied": False,
            "acceptedFields": [],
            "acceptedEdits": [],
            "rejectedEdits": [],
            "skippedFields": [],
            "warnings": [],
            "finalPublicCopyProvenance": provenance,
            "provenanceDecisionDiagnostics": create_pdp_geo_public_copy_provenance_decision_diagnostics(
                input_, phase="afterProofreader"
            ),
        },
    }


def _resolve_proofreader(runtime: Mapping[str, Any]) -> tuple[object | None, str | None]:
    custom = runtime.get("customFinalProofreader")
    if custom is not None:
        return custom, None
    settings = as_dict(runtime.get("finalProofreading"))
    if not settings:
        return None, None
    stage_provider = clean_text(settings.get("provider"))
    runtime_provider = clean_text(runtime.get("provider"))
    provider = stage_provider or runtime_provider or "mock"
    inherits_parent = not stage_provider or provider == runtime_provider

    def inherited_value(field: str) -> object:
        stage_value = settings.get(field)
        return stage_value if stage_value is not None else (runtime.get(field) if inherits_parent else None)

    def stage_or_runtime_value(field: str) -> object:
        stage_value = settings.get(field)
        return stage_value if stage_value is not None else runtime.get(field)

    api_key = inherited_value("apiKey")
    enabled = settings.get("enabled")
    if enabled is False:
        return None, None
    if enabled is not True and (provider in {"mock", "custom"} or not api_key):
        return None, None
    if provider in {"mock", "custom"}:
        return None, f"{provider} final proofreading requires customFinalProofreader."

    deployment = settings.get("deployment")
    if deployment is None and inherits_parent:
        deployments = as_dict(runtime.get("deployments"))
        deployment = deployments.get("proofreading")
        if deployment is None:
            deployment = deployments.get("reasoning")
        if deployment is None:
            deployment = runtime.get("deployment")

    timeout_seconds = stage_or_runtime_value("timeoutSeconds")
    if timeout_seconds is None:
        timeout_seconds = stage_or_runtime_value("timeout_seconds")
    api_version = inherited_value("apiVersion")
    if api_version is None:
        api_version = inherited_value("api_version")
    config = {
        "provider": provider,
        "apiKey": api_key,
        "model": inherited_value("model"),
        "endpoint": inherited_value("endpoint"),
        "deployment": deployment,
        "apiVersion": api_version,
        "temperature": stage_or_runtime_value("temperature"),
        "transport": stage_or_runtime_value("transport"),
        "timeoutSeconds": timeout_seconds,
        "maxOutputTokens": stage_or_runtime_value("maxOutputTokens"),
    }
    return ModelBackedFinalProofreader(config), None


async def _proofread(proofreader: object, request: Mapping[str, Any]) -> dict[str, Any]:
    method = getattr(proofreader, "proofread", None)
    if not callable(method):
        raise TypeError("customFinalProofreader must provide proofread(request).")
    response = method(request)
    if inspect.isawaitable(response):
        response = await response
    if not isinstance(response, Mapping):
        raise ValueError("Final proofreading response did not match the strict schema.")
    response_map = as_dict(cast(object, response))
    edits: object = response_map.get("edits")
    warnings: object = response_map.get("warnings")
    if (
        not isinstance(edits, list)
        or not isinstance(warnings, list)
        or not all(isinstance(item, str) for item in cast(list[object], warnings))
    ):
        raise ValueError("Final proofreading response did not match the strict schema.")
    return response_map


def _extract_bindings(input_: Mapping[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    markup = as_dict(input_.get("schemaMarkup"))
    graph = _graph(markup)
    sections = as_dict(as_dict(input_.get("content")).get("sections"))
    provenance = _valid_current_provenance(input_)
    by_path = {str(item.get("fieldPath")): item for item in provenance}
    bindings: list[dict[str, Any]] = []
    skipped: list[dict[str, str]] = []
    for path, text in _public_field_values(graph):
        if path == "Product.description" and clean_proposed_text(
            str(sections.get("description") or "")
        ) != clean_proposed_text(text):
            skipped.append(
                {"fieldPath": path, "reason": "schema and visible Product.description text were not identical"}
            )
            continue
        if path.startswith("FAQPage.") and text not in str(sections.get("faq") or ""):
            skipped.append({"fieldPath": path, "reason": "schema and visible FAQ pair text were not identical"})
            continue
        if path.startswith("HowTo.") and text not in str(sections.get("howToUse") or ""):
            skipped.append({"fieldPath": path, "reason": "schema and visible HowTo step text were not identical"})
            continue
        current = by_path.get(path)
        if not current:
            skipped.append(
                {
                    "fieldPath": path,
                    "reason": "no exact final-text, sentence-hash, and evidence-ID provenance binding was available",
                }
            )
            continue
        normalized = clean_proposed_text(text)
        expected_hash = stable_text_hash(f"{path}\n{normalized}")
        if (
            current.get("sourceHash") != expected_hash
            or clean_proposed_text(str(current.get("text") or "")) != normalized
        ):
            skipped.append(
                {
                    "fieldPath": path,
                    "reason": "no exact final-text, sentence-hash, and evidence-ID provenance binding was available",
                }
            )
            continue
        evidence_ids = [str(item) for item in as_list(current.get("evidenceIds")) if isinstance(item, str)]
        if not evidence_ids:
            skipped.append(
                {
                    "fieldPath": path,
                    "reason": "no exact final-text, sentence-hash, and evidence-ID provenance binding was available",
                }
            )
            continue
        kind = _kind_for_path(path)
        protected = [
            str(row.get("text"))
            for row in as_list(current.get("sentences"))
            if as_dict(row).get("protected") is True
        ]
        faq_row_id = clean_text(current.get("faqRowId"))
        bindings.append(
            {
                "kind": kind,
                "faqIndex": _path_index(path, "FAQPage.mainEntity"),
                "stepIndex": _path_index(path, "HowTo.step"),
                "protectedSentences": protected,
                "field": {
                    "fieldPath": path,
                    "sourceHash": expected_hash,
                    "text": normalized,
                    "constraint": "punctuation-only" if kind == "howto-step" else "fluency-only",
                    "evidenceIds": evidence_ids,
                    **({"faqRowId": faq_row_id} if faq_row_id else {}),
                    "immutableTokens": _immutable_tokens(
                        normalized, as_dict(input_.get("product")), clean_text(sections.get("productName"))
                    ),
                    **({"protectedSpans": protected} if protected else {}),
                },
            }
        )
    return bindings, skipped


def _valid_current_provenance(input_: Mapping[str, Any]) -> list[dict[str, Any]]:
    supplied = [as_dict(item) for item in as_list(input_.get("publicCopyProvenance"))]
    if not supplied:
        return []
    ledger = _records(input_.get("evidenceLedger"))
    evidence_by_id = {str(item.get("id")): item for item in ledger if item.get("id")}
    valid_ids = set(evidence_by_id)
    graph = _graph(as_dict(input_.get("schemaMarkup")))
    current = dict(_public_field_values(graph))
    plan = as_dict(input_.get("contentPlan"))
    faq_membership, faq_membership_supplied = _validated_faq_membership(input_, graph, plan, ledger)
    valid: list[dict[str, Any]] = []
    for entry in supplied:
        path = str(entry.get("fieldPath") or "")
        text = current.get(path)
        normalized = clean_proposed_text(text or "")
        if not text or not _FIELD_PATH.fullmatch(path):
            continue
        if clean_proposed_text(str(entry.get("text") or "")) != normalized:
            continue
        if entry.get("sourceHash") != stable_text_hash(f"{path}\n{normalized}"):
            continue
        ids = [str(item) for item in as_list(entry.get("evidenceIds")) if isinstance(item, str)]
        if not ids or not all(item in valid_ids for item in ids):
            continue
        faq_index = _path_index(path, "FAQPage.mainEntity")
        membership = (
            faq_membership[faq_index]
            if faq_membership is not None and isinstance(faq_index, int) and faq_index < len(faq_membership)
            else None
        )
        faq_card = as_dict(membership.get("card")) if membership else {}
        faq_scope_evidence = (
            [
                evidence_by_id[identifier]
                for raw_identifier in as_list(membership.get("evidenceIds"))
                if (identifier := clean_text(raw_identifier)) in evidence_by_id
            ]
            if membership
            else []
        )
        allowed_ids: set[str] = set()
        if faq_membership_supplied and path.startswith("FAQPage.mainEntity"):
            if membership:
                for raw_id in as_list(membership.get("evidenceIds")):
                    identifier = clean_text(raw_id)
                    if identifier:
                        allowed_ids.add(identifier)
            if (
                membership is None
                or clean_text(entry.get("faqRowId")) != clean_text(membership.get("id"))
                or (entry.get("faqCanRecommend") is True) != (membership.get("canRecommend") is True)
                or not set(ids).issubset(allowed_ids)
            ):
                continue
        expected_sentences = _sentences(normalized)
        supplied_sentences = _records(entry.get("sentences"))
        if len(supplied_sentences) != len(expected_sentences):
            continue
        valid_sentences = True
        sentence_union: list[str] = []
        inherited_identity: list[Mapping[str, Any]] = []
        for index, sentence in enumerate(supplied_sentences):
            raw_sentence_ids = as_list(sentence.get("evidenceIds"))
            sentence_ids = [
                identifier
                for identifier in raw_sentence_ids
                if isinstance(identifier, str) and identifier in valid_ids
            ]
            if membership is not None and not set(sentence_ids).issubset(allowed_ids):
                sentence_is_invalid = True
            else:
                sentence_is_invalid = False
            sentence_is_invalid = sentence_is_invalid or (
                clean_proposed_text(str(sentence.get("text") or "")) != expected_sentences[index]
                or sentence.get("sourceHash") != stable_text_hash(f"{path}#sentence[{index}]\n{expected_sentences[index]}")
            )
            if sentence.get("protected") is True:
                sentence_is_invalid = sentence_is_invalid or bool(raw_sentence_ids) or not sentence_provenance_has_verbatim_source_support(
                    expected_sentences[index], ledger
                )
            else:
                sentence_is_invalid = sentence_is_invalid or (
                    not sentence_ids
                    or len(sentence_ids) != len(raw_sentence_ids)
                    or not _entry_sentence_has_direct_support(
                        path,
                        expected_sentences[index],
                        [evidence_by_id[identifier] for identifier in sentence_ids],
                        ledger,
                        entry.get("origin"),
                        clean_text(entry.get("faqRowId")),
                        faq_can_recommend=(
                            faq_membership_supplied
                            and membership is not None
                            and membership.get("canRecommend") is True
                        ),
                        faq_card=faq_card,
                        faq_scope_evidence=faq_scope_evidence,
                        inherited_identity=inherited_identity,
                    )
                )
            if sentence_is_invalid:
                valid_sentences = False
                break
            for identifier in sentence_ids:
                if identifier not in sentence_union:
                    sentence_union.append(identifier)
            visible_identity = _faq_answer_sentence_identity_evidence(
                expected_sentences[index], faq_scope_evidence or [evidence_by_id[identifier] for identifier in sentence_ids]
            )
            inherited_identity = visible_identity if visible_identity else inherited_identity
        if not valid_sentences or ids != sentence_union:
            continue
        valid.append(copy.deepcopy(entry))
    return valid


def _validate_envelope(fields: Sequence[object], edits: Sequence[object]) -> str | None:
    if len(fields) != len(edits):
        return f"Expected {len(fields)} field edits but received {len(edits)}; the entire response was discarded."
    for index, (raw_field, raw_edit) in enumerate(zip(fields, edits, strict=True)):
        field, edit = as_dict(raw_field), as_dict(raw_edit)
        if edit.get("fieldPath") != field.get("fieldPath") or edit.get("sourceHash") != field.get("sourceHash"):
            return f"Field path/order/source hash mismatch at index {index}; the entire response was discarded."
        action = edit.get("action")
        issues = as_list(edit.get("issueCodes"))
        if action not in {"keep", "revise"} or not all(
            isinstance(item, str) and item in _ISSUE_CODES for item in issues
        ):
            return (
                f"{field.get('fieldPath')} used an invalid proofreading edit shape; the entire response was discarded."
            )
        if action == "keep" and (edit.get("revisedText") != field.get("text") or issues):
            return f"{field.get('fieldPath')} used action=keep but changed the text; the entire response was discarded."
        if action == "revise" and not issues:
            return f"{field.get('fieldPath')} proposed a revision without an allowed fluency issue code; the entire response was discarded."
    return None


def _gate_edits(
    bindings: Sequence[Mapping[str, Any]], edits: Sequence[object], input_: Mapping[str, Any]
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    accepted: list[dict[str, Any]] = []
    rejected: list[dict[str, str]] = []
    rejected_faqs: set[str | int] = set()
    candidates: list[tuple[Mapping[str, Any], dict[str, Any]]] = []
    for binding, raw_edit in zip(bindings, edits, strict=True):
        field = as_dict(binding.get("field"))
        edit = as_dict(raw_edit)
        if edit.get("action") == "keep" or edit.get("revisedText") == field.get("text"):
            continue
        reason = _rejection_reason(binding, edit, input_)
        if reason:
            rejected.append(
                {
                    "fieldPath": str(field.get("fieldPath") or ""),
                    "reason": reason,
                    "proposedText": str(edit.get("revisedText") or ""),
                }
            )
            faq_index = binding.get("faqIndex")
            faq_row_id = clean_text(field.get("faqRowId"))
            if faq_row_id:
                rejected_faqs.add(faq_row_id)
            elif isinstance(faq_index, int):
                rejected_faqs.add(faq_index)
        else:
            candidates.append((binding, edit))
    for binding, edit in candidates:
        faq_index = binding.get("faqIndex")
        faq_row_id = clean_text(as_dict(binding.get("field")).get("faqRowId"))
        faq_key: str | int | None = faq_row_id if faq_row_id else faq_index if isinstance(faq_index, int) else None
        path = str(as_dict(binding.get("field")).get("fieldPath") or "")
        if faq_key is not None and faq_key in rejected_faqs:
            rejected.append(
                {
                    "fieldPath": path,
                    "reason": "FAQ question and answer edits are atomic; both were reverted because one field failed an invariant gate.",
                    "proposedText": str(edit.get("revisedText") or ""),
                }
            )
        else:
            accepted.append(edit)
    return accepted, rejected


def _rejection_reason(binding: Mapping[str, Any], edit: Mapping[str, Any], input_: Mapping[str, Any]) -> str | None:
    field = as_dict(binding.get("field"))
    original = str(field.get("text") or "")
    candidate = clean_proposed_text(str(edit.get("revisedText") or ""))
    if not candidate:
        return "The proposed text was empty."
    if "```" in str(edit.get("revisedText") or "") or _UNSAFE_UNICODE.search(str(edit.get("revisedText") or "")):
        return "The proposal contained a Unicode control, bidi, or zero-width formatting character."
    if not _protected_spans_are_preserved_verbatim(candidate, as_list(binding.get("protectedSentences"))):
        return "A protected source-preserving sentence was edited; protected text is not rewritable, including punctuation."
    if not _locale_compatible(original, candidate, str(input_.get("locale") or "en-US")):
        return "The proposal changed or mixed the target locale."
    if len(candidate) > len(original) * 1.15 + 12 or len(candidate) < len(original) * _minimum_ratio(
        str(binding.get("kind") or "")
    ):
        return "The proposal changed too much public copy for a fluency-only edit."
    if str(field.get("constraint")) == "punctuation-only" and _strip_punctuation(candidate) != _strip_punctuation(
        original
    ):
        return "HowTo text may change punctuation or spacing only."
    for token in as_list(field.get("immutableTokens")):
        if isinstance(token, str) and token not in candidate:
            return f"Immutable token was removed or changed: {token}"
    if _numeric_tokens(original) != _numeric_tokens(candidate):
        return "A number, sign, unit, duration, population, or measured-value token changed."
    if _claim_modality(original) != _claim_modality(candidate):
        return "Negation, uncertainty, attribution, causality, or claim strength changed."
    if _review_scope_signature(original) != _review_scope_signature(candidate):
        return "Customer-review attribution or single-versus-aggregate review scope changed."
    if _introduces_ingredient_causality(original, candidate, as_dict(input_.get("product"))):
        return "The proposal introduced a new ingredient-to-benefit or causal relationship."
    if _speech_acts(original) != _speech_acts(candidate):
        return "A statement, question, command, or exclamation was changed into a different speech act."
    if _protected_punctuation(original) != _protected_punctuation(candidate):
        return "Quote, bracket, colon, semicolon, slash, or dash scope changed."
    allowed, required = _surface_only_change(original, candidate, str(binding.get("kind") or ""))
    if not allowed:
        return "The proposal was not explainable by the closed fluency allowlist; factual words and relations must remain unchanged."
    issue_codes = {str(item) for item in as_list(edit.get("issueCodes"))}
    missing = required - issue_codes
    if missing:
        return f"The proposal performed {sorted(missing)[0]} cleanup without declaring the matching issue code."
    kind = str(binding.get("kind") or "")
    if kind == "webpage-description" and _has_page_role(original) and not _has_page_role(candidate):
        return "WebPage.description lost its page-level role."
    if kind == "product-description" and not _has_page_role(original) and _has_page_role(candidate):
        return "Product.description was changed into page-level copy."
    if kind == "faq-question" and re.search(r"[?？]\s*$", original) and not re.search(r"[?？]\s*$", candidate):
        return "The FAQ question is no longer a question."
    if len(_sentences(candidate)) > len(_sentences(original)):
        return "The proposal added or split sentences instead of only proofreading them."
    if _removes_distinct_sentence(original, candidate):
        return "The proposal removed a distinct sentence rather than a proven duplicate sentence."
    return None


def _apply_accepted_edits(
    input_: Mapping[str, Any], bindings: Sequence[Mapping[str, Any]], edits: Sequence[Mapping[str, Any]]
) -> dict[str, Any]:
    markup = copy.deepcopy(as_dict(input_.get("schemaMarkup")))
    content = copy.deepcopy(as_dict(input_.get("content")))
    json_ld = as_dict(markup.get("jsonLd"))
    graph_value = json_ld.get("@graph")
    if not isinstance(graph_value, list):
        return {"schemaMarkup": markup, "content": content}
    graph = _records(cast(object, graph_value))
    json_ld["@graph"] = graph
    membership, membership_supplied = _validated_faq_membership(
        input_, graph, as_dict(input_.get("contentPlan")), _records(input_.get("evidenceLedger"))
    )
    faq_index_by_id = {
        clean_text(row.get("id")): index
        for index, row in enumerate(membership or [])
        if clean_text(row.get("id"))
    }
    by_path = {str(as_dict(binding.get("field")).get("fieldPath")): binding for binding in bindings}
    sections: dict[str, Any] = as_dict(content.get("sections"))
    content["sections"] = sections
    faq_changed = False
    for edit in edits:
        path = str(edit.get("fieldPath") or "")
        text = clean_proposed_text(str(edit.get("revisedText") or ""))
        binding = by_path.get(path)
        if binding is None:
            continue
        if path == "Product.description":
            node = _find_node(graph, "Product")
            if node is not None:
                node["description"] = text
                sections["description"] = text
        elif path == "WebPage.description":
            node = _find_node(graph, "WebPage")
            if node is not None:
                node["description"] = text
        elif path.startswith("FAQPage.mainEntity"):
            faq = _find_node(graph, "FAQPage")
            index = binding.get("faqIndex")
            faq_row_id = clean_text(as_dict(binding.get("field")).get("faqRowId"))
            if membership_supplied:
                if not faq_row_id or faq_row_id not in faq_index_by_id:
                    continue
                index = faq_index_by_id[faq_row_id]
            entities = _records(faq.get("mainEntity")) if faq else []
            if faq is not None:
                faq["mainEntity"] = entities
            if (
                isinstance(index, int)
                and 0 <= index < len(entities)
            ):
                entity = entities[index]
                if path.endswith(".name"):
                    entity["name"] = text
                elif isinstance(entity.get("acceptedAnswer"), dict):
                    entity["acceptedAnswer"]["text"] = text
                faq_changed = True
        elif path.startswith("HowTo.step"):
            howto = _find_node(graph, "HowTo")
            index = binding.get("stepIndex")
            steps = _records(howto.get("step")) if howto else []
            if howto is not None:
                howto["step"] = steps
            if (
                isinstance(index, int)
                and 0 <= index < len(steps)
            ):
                before = str(steps[index].get("text") or "")
                steps[index]["text"] = text
                sections["howToUse"] = str(sections.get("howToUse") or "").replace(before, text, 1)
    if faq_changed:
        faq = _find_node(graph, "FAQPage")
        entities = _records(faq.get("mainEntity")) if faq else []
        pairs: list[str] = []
        for row in entities:
            answer = as_dict(row.get("acceptedAnswer"))
            if clean_text(row.get("name")) and clean_text(answer.get("text")):
                pairs.append(f"Q. {row['name']}\nA. {answer['text']}")
        sections["faq"] = "\n\n".join(pairs)
    content["html"] = ""
    return {
        "schemaMarkup": serialize_schema_markup(json_ld),
        "content": content,
        "faqMembership": copy.deepcopy(as_list(input_.get("faqMembership"))),
    }


def _introduces_validation_findings(
    input_: Mapping[str, Any], candidate: Mapping[str, Any], candidate_provenance: Sequence[Mapping[str, Any]]
) -> bool:
    before = validate_pdp_geo_artifacts(input_)
    after = validate_pdp_geo_artifacts({**input_, **candidate, "publicCopyProvenance": list(candidate_provenance)})
    baseline = {
        f"{item.get('field')}:{item.get('issue')}"
        for item in _records(before.get("validationFindings"))
    }
    return any(
        f"{item.get('field')}:{item.get('issue')}" not in baseline
        for item in _records(after.get("validationFindings"))
    )


def _rebase_provenance(
    input_: Mapping[str, Any], bindings: Sequence[Mapping[str, Any]], edits: Sequence[Mapping[str, Any]]
) -> list[dict[str, Any]]:
    del bindings  # The accepted edit path/hash envelope was already gated.
    revisions = {str(edit.get("fieldPath") or ""): clean_proposed_text(str(edit.get("revisedText") or "")) for edit in edits}
    ledger = _records(input_.get("evidenceLedger"))
    rebased: list[dict[str, Any]] = []
    for entry in _valid_current_provenance(input_):
        revised = revisions.get(str(entry.get("fieldPath") or ""))
        if not revised:
            rebased.append(entry)
            continue
        path = str(entry["fieldPath"])
        original_sentences = _records(entry.get("sentences"))
        revised_sentences = _sentences(revised)
        by_normalized: dict[str, list[dict[str, Any]]] = {}
        for sentence in original_sentences:
            by_normalized.setdefault(clean_proposed_text(str(sentence.get("text") or "")), []).append(sentence)
        sentence_rows: list[dict[str, Any]] = []
        for index, sentence in enumerate(revised_sentences):
            original_sentence = (
                original_sentences[index]
                if len(revised_sentences) == len(original_sentences)
                else (by_normalized.get(clean_proposed_text(sentence)) or [{}]).pop(0)
            )
            ids = [
                str(identifier)
                for identifier in as_list(original_sentence.get("evidenceIds"))
                if isinstance(identifier, str)
            ]
            sentence_rows.append(
                {
                    "text": sentence,
                    "sourceHash": stable_text_hash(f"{path}#sentence[{index}]\n{sentence}"),
                    "evidenceIds": ids,
                    **_image_provenance(ids, ledger),
                    **({"protected": True} if original_sentence.get("protected") is True else {}),
                }
            )
        ids = _unique_strings(identifier for sentence in sentence_rows for identifier in sentence["evidenceIds"])
        rebased.append(
            {
                **entry,
                "text": revised,
                "sourceHash": stable_text_hash(f"{path}\n{revised}"),
                "evidenceIds": ids,
                "sentences": sentence_rows,
                **_image_provenance(ids, ledger),
            }
        )
    return rebased


def _accepted_edit_diagnostics(
    bindings: Sequence[Mapping[str, Any]], edits: Sequence[Mapping[str, Any]]
) -> list[dict[str, Any]]:
    by_path = {
        str(as_dict(binding.get("field")).get("fieldPath")): as_dict(binding.get("field")) for binding in bindings
    }
    rows: list[dict[str, Any]] = []
    for edit in edits:
        field = by_path.get(str(edit.get("fieldPath") or ""))
        if field:
            rows.append(
                {
                    "fieldPath": edit["fieldPath"],
                    "sourceHash": field["sourceHash"],
                    "before": field["text"],
                    "after": clean_proposed_text(str(edit.get("revisedText") or "")),
                    "evidenceIds": as_list(field.get("evidenceIds")),
                    "issueCodes": as_list(edit.get("issueCodes")),
                }
            )
    return rows


def _reject_whole_application(base: dict[str, Any], result: Mapping[str, Any], reason: str) -> dict[str, Any]:
    diagnostics = as_dict(base["diagnostics"])
    diagnostics.update(
        {
            "status": "rejected",
            "called": True,
            "rejectedEdits": [{"reason": reason}],
            "warnings": _unique_strings([*as_list(result.get("warnings")), reason]),
        }
    )
    base["evidence"] = [
        {
            "field": "finalProofreading",
            "source": "llm",
            "value": f"Final proofreading response rejected as a whole: {reason}",
        }
    ]
    return base


def _reverted_application(
    base: dict[str, Any],
    result: Mapping[str, Any],
    rejected: Sequence[Mapping[str, Any]],
    reason: str,
    warnings: Sequence[object],
) -> dict[str, Any]:
    diagnostics = as_dict(base["diagnostics"])
    diagnostics.update(
        {
            "status": "rejected",
            "called": True,
            "rejectedEdits": [*rejected, {"reason": reason}],
            "warnings": _unique_strings([*warnings, *as_list(result.get("warnings")), reason]),
        }
    )
    base["evidence"] = [{"field": "finalProofreading", "source": "llm", "value": reason}]
    return base


def _graph(markup: Mapping[str, Any]) -> list[dict[str, Any]]:
    json_ld = as_dict(markup.get("jsonLd"))
    return _records(json_ld.get("@graph"))


def _records(value: object) -> list[dict[str, Any]]:
    return [as_dict(item) for item in as_list(value) if as_dict(item)]


def _public_field_values(graph: Sequence[Mapping[str, Any]]) -> list[tuple[str, str]]:
    values: list[tuple[str, str]] = []
    for name, kind in (("Product", "Product.description"), ("WebPage", "WebPage.description")):
        node = _find_node(graph, name)
        if node and clean_text(node.get("description")):
            values.append((kind, clean_text(node["description"])))
    faq = _find_node(graph, "FAQPage")
    for index, raw in enumerate(as_list(faq.get("mainEntity") if faq else None)):
        row = as_dict(raw)
        answer = as_dict(row.get("acceptedAnswer"))
        if clean_text(row.get("name")):
            values.append((f"FAQPage.mainEntity[{index}].name", clean_text(row["name"])))
        if clean_text(answer.get("text")):
            values.append((f"FAQPage.mainEntity[{index}].acceptedAnswer.text", clean_text(answer["text"])))
    howto = _find_node(graph, "HowTo")
    for index, raw in enumerate(as_list(howto.get("step") if howto else None)):
        row = as_dict(raw)
        if clean_text(row.get("text")):
            values.append((f"HowTo.step[{index}].text", clean_text(row["text"])))
    return values


def _find_node(graph: Sequence[Mapping[str, Any]], kind: str) -> dict[str, Any] | None:
    for raw in graph:
        node = raw if isinstance(raw, dict) else as_dict(raw)
        types = as_list(node.get("@type")) if isinstance(node.get("@type"), list) else [node.get("@type")]
        if kind in types:
            return node
    return None


# The proofreading tokenizer drops the same closed class of function words the
# naming judgment reads, so both sides of publication share one vocabulary.
_ENGLISH_PROOFREADING_STOP_WORDS = ENGLISH_FUNCTION_WORDS


# A description is a paragraph: each sentence states one product fact, so one
# can be left out while the rest still reads as a description.  A procedure step
# or a FAQ answer is a single unit -- dropping a sentence from a step changes the
# instruction, and dropping one from an answer answers half the question -- so
# those remain all-or-nothing.
SENTENCE_SEPARABLE_PUBLIC_COPY_PATHS = frozenset({"Product.description", "WebPage.description"})


def _create_provenance_entry(
    path: str,
    text: str,
    evidence_ids: Sequence[str],
    origin: str,
    ledger: Sequence[Mapping[str, Any]],
    sentence_evidence_ids: Sequence[Sequence[str]] | None,
    *,
    faq_row_id: str | None = None,
    faq_can_recommend: bool = False,
    faq_card: Mapping[str, Any] | None = None,
    faq_scope_evidence: Sequence[Mapping[str, Any]] = (),
) -> dict[str, Any] | None:
    normalized = clean_proposed_text(text)
    sentences: list[dict[str, Any]] = []
    inherited_identity: list[Mapping[str, Any]] = []
    for index, sentence in enumerate(_sentences(normalized)):
        selected_ids = (
            list(sentence_evidence_ids[index])
            if sentence_evidence_ids and index < len(sentence_evidence_ids)
            else []
        )
        ids = list(selected_ids)
        selected_evidence = [item for item in ledger if item.get("id") in ids]
        selected_evidence = _narrow_sentence_provenance_evidence(sentence, selected_evidence, ledger, origin)
        ids = [clean_text(item.get("id")) for item in selected_evidence if clean_text(item.get("id"))]
        if not _entry_sentence_has_direct_support(
            path,
            sentence,
            selected_evidence,
            ledger,
            origin,
            faq_row_id,
            faq_can_recommend=faq_can_recommend,
            faq_card=faq_card,
            faq_scope_evidence=faq_scope_evidence,
            inherited_identity=inherited_identity,
        ):
            ids = []
        if not ids:
            protected = sentence_provenance_has_verbatim_source_support(sentence, ledger)
            if not protected and path not in SENTENCE_SEPARABLE_PUBLIC_COPY_PATHS:
                return None
            # In a description, one sentence whose binding cannot be shown is
            # one sentence to leave out.  Discarding the field's whole
            # provenance instead made the field unprovable, and the isolation
            # step then published nothing at all -- so a page with no customer
            # reviews lost its ingredients and its measured result along with
            # the review sentence.  The row is recorded with no evidence, which
            # is what lets that one sentence be dropped and the rest stand.
            sentences.append(
                {
                    "text": sentence,
                    "sourceHash": stable_text_hash(f"{path}#sentence[{index}]\n{sentence}"),
                    "evidenceIds": [],
                    **({"protected": True} if protected else {}),
                }
            )
            continue
        sentences.append(
            {
                "text": sentence,
                "sourceHash": stable_text_hash(f"{path}#sentence[{index}]\n{sentence}"),
                "evidenceIds": ids,
                **_image_provenance(ids, ledger),
            }
        )
        visible_identity = _faq_answer_sentence_identity_evidence(
            sentence, faq_scope_evidence or selected_evidence
        )
        inherited_identity = visible_identity if visible_identity else inherited_identity
    field_ids = _unique_strings(identifier for sentence in sentences for identifier in sentence["evidenceIds"])
    if not field_ids:
        return None
    return {
        "fieldPath": path,
        "text": normalized,
        "sourceHash": stable_text_hash(f"{path}\n{normalized}"),
        "origin": origin,
        "evidenceIds": field_ids,
        **_image_provenance(field_ids, ledger),
        "sentences": sentences,
        **({"faqRowId": faq_row_id} if faq_row_id else {}),
        **({"faqCanRecommend": True} if faq_row_id and faq_can_recommend else {}),
    }


def _faq_membership_question_has_scoped_support(
    question: str,
    evidence: Sequence[Mapping[str, Any]],
    *,
    faq_card: Mapping[str, Any] | None = None,
) -> bool:
    """Accept an admitted model FAQ question only inside its own relation card.

    Customer-decision questions are often a natural interrogative rewrite of
    the relationship card rather than a literal source sentence.  This helper
    does not invent that copy; it merely preserves its plan-level admission
    while requiring a customer-goal frame and a substantive overlap with a
    non-identity fact from that same card.  Product identity belongs in the
    paired answer, not necessarily in the customer's question.
    """

    return bool(_faq_membership_question_evidence(question, evidence, faq_card=faq_card))


def _faq_membership_question_evidence(
    question: str,
    evidence: Sequence[Mapping[str, Any]],
    *,
    faq_card: Mapping[str, Any] | None = None,
) -> list[Mapping[str, Any]]:
    """Return only relation-card atoms supporting a natural customer question.

    A model FAQ question need not repeat the product name when its paired
    answer identifies the product.  The question must still be a customer
    situation/goal rather than a source heading, and must map either direct
    terms or a product-fact category to this *one* immutable row.

    A digit the question carries has to be a measurement before it can be an
    unsourced one, and a digit inside the product's own name measures nothing
    ("SampleDerma BarrierCare365 클렌징폼").  Rejecting every digit rejected every
    question that called the product by name: three of the three Korean rows
    measured carried ``365`` and nothing else, so each lost its question
    binding while the paired answer kept its own.  The naming contract already
    draws that line, and the recommendation path below reads it the same way,
    so both reach one judgment.
    """

    normalized = clean_text(question)
    if (
        not normalized
        or not re.search(r"[?？]\s*$", normalized)
        or (_numeric_tokens(normalized) and not _numeric_tokens_are_ledger_identifiers(normalized, evidence))
        or _FAQ_RAW_HEADING_QUESTION.search(normalized)
        or asks_what_the_source_recorded(normalized)
    ):
        return []
    card_question = _faq_card_customer_question_evidence(normalized, evidence, faq_card)
    if card_question:
        return card_question
    identity = [
        item
        for item in evidence
        if clean_text(item.get("role")) == "identity" and clean_text(item.get("text"))
    ]
    product_identity = [
        item
        for item in identity
        if clean_text(item.get("sourcePath")).endswith(("product.name", "product.originalName"))
    ]
    question_has_product_identity = any(
        contains_entity_identity_phrase(normalized, clean_text(item.get("text"))) for item in product_identity
    )
    question_tokens = set(_substantive_tokens(normalized))
    matched_facts = [
        item
        for item in evidence
        if clean_text(item.get("role")) != "identity"
        and question_tokens & set(_substantive_tokens(clean_text(item.get("text"))))
    ]
    requested_roles = _source_role_question_roles(normalized)
    role_facts = [
        item
        for item in evidence
        if clean_text(item.get("role")) in requested_roles
        and clean_text(item.get("text"))
    ]
    # Direct source-term overlap can establish the substantive question part.
    # A category-only question ("formula and stated benefits", "test result")
    # needs an explicit customer-goal frame before its requested roles may
    # stand in for literal word overlap.  This keeps raw source inventory and
    # report narration out of public FAQ copy.
    if not matched_facts and not (requested_roles and role_facts and _FAQ_CUSTOMER_GOAL_QUESTION.search(normalized)):
        return []
    if not question_has_product_identity and not _FAQ_CUSTOMER_GOAL_QUESTION.search(normalized):
        return []
    brands = [
        item
        for item in identity
        if clean_text(item.get("sourcePath")).endswith("product.brand")
        and contains_entity_identity_phrase(normalized, clean_text(item.get("text")))
    ]
    identities = [*product_identity, *brands] if question_has_product_identity else []
    facts = matched_facts or role_facts
    return [*identities, *facts]


def _faq_card_claims(card: Mapping[str, Any] | None) -> list[dict[str, Any]]:
    """Return only the validated claims of one card, each already scoped to its row.

    Every claim but identity has to touch what the row cited, which is what
    makes it this row's claim.  Identity is scoped by the card instead: it
    names the product the card is for, carries no fact, and holding it to the
    row's citations dropped it and took the whole card with it.
    """

    return [as_dict(raw) for raw in as_list(as_dict(card).get("claims")) if as_dict(raw)]


def _faq_card_claim_evidence(
    claim: Mapping[str, Any], evidence: Sequence[Mapping[str, Any]]
) -> list[Mapping[str, Any]]:
    """Resolve a claim's immutable source IDs in card order."""

    by_id = {clean_text(item.get("id")): item for item in evidence if clean_text(item.get("id"))}
    return [
        by_id[identifier]
        for raw_id in as_list(claim.get("evidenceIds"))
        if (identifier := clean_text(raw_id)) and identifier in by_id
    ]


def _faq_card_claim_tokens(claim: Mapping[str, Any], *, metric: bool = False) -> set[str]:
    """Collect only text carried by an immutable relationship claim.

    What a claim carries is what its record filed, so the fields are read from
    the one list the card builder writes them to.  Naming them here instead let
    this reader and the admission gate disagree about the same claim -- the
    caveat of a measured result counted as card text in one stage and as an
    invented phrase in the other.
    """

    values = [clean_text(claim.get(field)) for field in CARD_CLAIM_CONTENT_FIELDS]
    normalize = _faq_metric_tokens if metric else _substantive_tokens
    # Customer questions often hyphenate a source target (``sensitive-skin``)
    # while the PDP writes it as two words.  This is surface normalization,
    # not a semantic expansion: the card still has to contain every resulting
    # source token before it can support the question.
    return {token for value in values for token in normalize(re.sub(r"-", " ", value))}


def _faq_card_is_scaffold_token(token: str) -> bool:
    """Recognize question/answer connective language, not product facts."""

    if token in _FAQ_CARD_ENGLISH_SCAFFOLD_TOKENS:
        return True
    if re.search(r"[가-힣]", token):
        return token.startswith(("고민", "관리", "어떤", "좋", "제품", "세럼", "크림", "추천", "고려", "피부"))
    return False


def _faq_card_claim_states_the_figures(
    sentence: str,
    claim: Mapping[str, Any],
    identity: Sequence[Mapping[str, Any]],
) -> bool:
    """Return whether every figure the sentence states is one the claim filed.

    A figure is the one thing a sentence cannot paraphrase its way into: only a
    record can license it.  The word readers cannot see one -- a substantive
    token is a word, and ``99%`` is not -- so an ingredient/effect claim that
    was read by words alone admitted a percentage no record carried, and the
    same claim's own words made the sentence look covered.

    The digits inside the product's own name are not a measurement.  They are
    part of what the entity is called (``BarrierCare365``), so they come off with
    the identity rather than being charged as a figure the claim must hold.
    """

    identity_figures = {
        figure for item in identity for figure in _numeric_tokens(clean_text(item.get("text")))
    }
    stated = set(_numeric_tokens(sentence)) - identity_figures
    return not stated - set(_numeric_tokens(clean_text(claim.get("text"))))


def _faq_card_claim_covers_sentence(
    sentence: str,
    claim: Mapping[str, Any],
    identity: Sequence[Mapping[str, Any]],
    *,
    carrier_tokens: frozenset[str] = frozenset(),
    metric: bool = False,
) -> bool:
    """Require every non-carrier term to remain within one card claim.

    A relationship card can license a natural word order, but not a new target
    or claim.  This check therefore permits only a small customer/grammar
    scaffold around claim tokens and rejects any remaining semantic term.

    The containment phrase comes off first, for the reason the row-local
    readers already take it off: it names who holds the part the sentence is
    about, which the record of that part already says, so it states no fact of
    its own.  Counting it charged the word that points back at the entity the
    sentence had just named -- ``In the same serum, Niacinamide helps improve
    skin radiance`` was refused over ``same`` while the same sentence written
    with the product's full name bound, and the answer it belonged to went
    unpublished.  Nothing else is exempted: every other word still has to sit
    inside the one claim.
    """

    identity_names = [clean_text(item.get("text")) for item in identity]
    normalize = _faq_metric_tokens if metric else _substantive_tokens
    identity_tokens = {token for item in identity for token in normalize(clean_text(item.get("text")))}
    candidate_tokens = (
        set(normalize(clause_without_containment_owner(sentence, identity_names)))
        - identity_tokens
        - _PUBLIC_COPY_TEMPLATE_TOKENS
        - carrier_tokens
    )
    claim_tokens = _faq_card_claim_tokens(claim, metric=metric)
    if not candidate_tokens or not claim_tokens or not candidate_tokens & claim_tokens:
        return False
    return all(token in claim_tokens or _faq_card_is_scaffold_token(token) for token in candidate_tokens)


def _faq_card_customer_question_evidence(
    question: str,
    evidence: Sequence[Mapping[str, Any]],
    faq_card: Mapping[str, Any] | None,
) -> list[Mapping[str, Any]]:
    """Bind a customer-oriented question to one explicit row-local card claim."""

    if not _FAQ_CUSTOMER_GOAL_QUESTION.search(question):
        return []
    claims = [claim for claim in _faq_card_claims(faq_card) if clean_text(claim.get("role")) != "identity"]
    for claim in claims:
        claim_evidence = _faq_card_claim_evidence(claim, evidence)
        if not claim_evidence or _faq_card_claim_covers_sentence(question, claim, []):
            continue
        return claim_evidence

    # A buyer question can naturally name both the source-stated customer
    # concern and the product benefit it is trying to address.  Those facts
    # may live in separate atomic claims, even though the relationship card
    # already records that they belong to the same customer-decision context.
    # Keep this exception narrow: it applies only to recommendation-capable
    # buyer cards, only to a customer-goal question, and only when every
    # non-scaffold term is covered by the union of direct card claims.  It
    # never grants a new causal or suitability statement.
    card = as_dict(faq_card)
    if clean_text(card.get("intent")) != "buyer-decision" or card.get("canRecommend") is not True:
        return []
    question_tokens = set(_substantive_tokens(re.sub(r"-", " ", question)))
    carrier_tokens = set(_FAQ_CARD_ENGLISH_SCAFFOLD_TOKENS)
    if carrier_match := re.match(
        r"^which\s+(?P<product_type>(?:[A-Za-z][A-Za-z-]*\s+){0,4}?)(?:may|might|can|could)\s+"
        r"(?:help|support|work)\b",
        question,
        re.IGNORECASE,
    ):
        # The noun after ``which`` is a shopper-facing product category, not
        # an evidence assertion.  Read it structurally so this works for a
        # lotion, eye treatment, cleanser, or future category without a
        # product-type allowlist.
        carrier_tokens.update(_substantive_tokens(carrier_match.group("product_type")))
    candidate_tokens = question_tokens - carrier_tokens - _PUBLIC_COPY_TEMPLATE_TOKENS
    matched: list[Mapping[str, Any]] = []
    covered: set[str] = set()
    for claim in claims:
        claim_tokens = _faq_card_claim_tokens(claim)
        if not claim_tokens or not candidate_tokens & claim_tokens:
            continue
        claim_evidence = _faq_card_claim_evidence(claim, evidence)
        if not claim_evidence:
            continue
        matched.extend(claim_evidence)
        covered.update(claim_tokens)
    if len(matched) < 2 or not candidate_tokens or not candidate_tokens <= covered:
        return []
    unique: list[Mapping[str, Any]] = []
    seen_ids: set[str] = set()
    for item in matched:
        identifier = clean_text(item.get("id"))
        if not identifier or identifier in seen_ids:
            continue
        seen_ids.add(identifier)
        unique.append(item)
    return unique


def _stable_faq_membership_answer_sentence_evidence(
    text: str,
    selected: RenderedSentenceEvidence,
    evidence: Sequence[Mapping[str, Any]],
    *,
    faq_can_recommend: bool = False,
    faq_card: Mapping[str, Any] | None = None,
) -> RenderedSentenceEvidence:
    """Prefer the narrowest immutable-card support for each model answer sentence.

    Renderer selection may retain overlapping card records.  A successful
    stable FAQ binding narrows that to the exact source atom (or one metric
    group) needed by the sentence; otherwise the existing renderer selection
    is left intact.  This does not combine evidence rows into a new claim.
    """

    sentence_ids: list[list[str]] = []
    inherited_identity: list[Mapping[str, Any]] = []
    for index, sentence in enumerate(_sentences(text)):
        current_ids = (
            list(selected["sentenceEvidenceIds"][index])
            if index < len(selected["sentenceEvidenceIds"])
            else []
        )
        scoped = _faq_membership_answer_evidence(
            sentence,
            evidence,
            faq_can_recommend=faq_can_recommend,
            faq_card=faq_card,
            inherited_identity=inherited_identity,
        )
        # The renderer may initially select every overlapping source fragment
        # in a relationship card.  Prefer a successful row-local answer
        # binding because it keeps a metric to one source group and an
        # ingredient listing to its exact atom; retain the ordinary renderer
        # selection only when no stable FAQ binding applies.
        sentence_ids.append(
            _unique_strings(item.get("id") for item in scoped) if scoped else current_ids
        )
        visible_identity = _faq_answer_sentence_identity_evidence(sentence, evidence)
        inherited_identity = visible_identity if scoped and visible_identity else ([] if not scoped else inherited_identity)
    return {
        "evidenceIds": _unique_strings(identifier for ids in sentence_ids for identifier in ids),
        "sentenceEvidenceIds": sentence_ids,
    }


def _faq_membership_answer_evidence(
    sentence: str,
    evidence: Sequence[Mapping[str, Any]],
    *,
    faq_can_recommend: bool = False,
    faq_card: Mapping[str, Any] | None = None,
    inherited_identity: Sequence[Mapping[str, Any]] = (),
) -> list[Mapping[str, Any]]:
    """Resolve one branded model FAQ answer sentence to a single explicit source claim.

    Stable FAQ membership is a scope constraint, not permission to compose a
    new relation.  The non-identity portion of the candidate therefore has to
    be completely present in one source sentence, with matching claim scope
    and assertion frame.  This permits an identity scaffold around a direct
    source claim while rejecting cross-row joins, invented causality, and
    altered metrics.
    """

    normalized = clean_proposed_text(sentence)
    if not normalized or re.search(r"[?？]\s*$", normalized):
        return []
    visible_identity = _faq_answer_sentence_identity_evidence(normalized, evidence)
    identity = visible_identity or list(inherited_identity)
    if not identity:
        return []

    def without_inherited_identity(binding: Sequence[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
        """Do not attach a prior sentence's identity IDs to a new fact sentence."""

        return list(binding) if visible_identity else [
            item for item in binding if clean_text(item.get("role")) != "identity"
        ]
    identity_tokens = {
        token for item in identity for token in _substantive_tokens(clean_text(item.get("text")))
    }
    # A sentence that has already named the product may refer to it again by
    # its kind -- "…을 완료한 제품입니다", "is a product that …".  That word
    # points back at the entity the sentence named, so it asserts nothing of
    # its own; counting it left a correctly composed answer holding one token
    # no source atom could ever carry, and the row published nothing.
    #
    # Only the kind noun does that.  Reading the wider set of words a page may
    # point at its own product with dropped the head of a neighbouring claim:
    # ``SAMPLE_DERMA …는 피부과 처방입니다`` kept nothing but ``피부과`` and bound to
    # ``피부과 테스트 완료``, publishing a prescription no record wrote.  And a
    # record names the kind as freely as an answer does (``제품 피부과 테스트
    # 완료``), so the same words come off both sides of the comparison rather
    # than off the answer alone.
    #
    # Words are counted on the sentence without its containment phrase.  That
    # phrase names who holds the part the sentence is about and states no fact
    # of its own, and each locale writes it differently -- Korean with a
    # particle and an adnominal, English with a fronted preposition -- so
    # counting the raw sentence charged one locale's owner words ("In the same
    # serum") as words no source carried.
    identity_names = [clean_text(entry.get("text")) for entry in identity]
    body = clause_without_containment_owner(normalized, identity_names)
    required_tokens = (
        set(_faq_words_that_assert(body))
        - identity_tokens
        - _ENTITY_KIND_TOKENS
        - _CONTAINMENT_FRAME_ANSWER_TOKENS
    )
    if not required_tokens:
        return []
    # The subtraction just above is what makes the two slots of a containment
    # unreadable further down, so the relation is judged here, while the frame
    # is still on the sentence.  Only a sentence that writes the relation is
    # asked: one that lists parts without saying the product holds them, or
    # attributes them some other way ("is described as", "is an ingredient",
    # "돕습니다"), reaches the ladder below exactly as it did before.
    if _faq_answer_states_containment(body) and not _faq_containment_relation_is_recorded(
        body, evidence, identity, faq_card=faq_card
    ):
        return []
    for item in evidence:
        if clean_text(item.get("role")) == "identity" or not clean_text(item.get("sourcePath")):
            continue
        for source in _sentences(clean_text(item.get("text"))) or [clean_text(item.get("text"))]:
            source_record = {**item, "text": source}
            if (
                not source
                or re.search(r"[?？]\s*$", source)
                or not _claim_scope_matches(normalized, source)
                or _evidence_scope_mismatch(normalized, source)
                # One run of the source has to state the whole of what the
                # answer asserts, and it has to be the run the answer's own
                # subject governs.  Measuring against the whole source sentence
                # let an answer take a name from one of its attributions and a
                # fact from the other.
                or not any(
                    required_tokens
                    <= (
                        (set(_faq_words_that_assert(span)) - _ENTITY_KIND_TOKENS)
                        | _faq_role_kind_tokens(item.get("role"), required_tokens, normalized)
                    )
                    for span in _source_spans_an_answer_may_rest_on(normalized, source, identity_names)
                )
                # The frame is read with the containment phrase taken off.
                # That phrase names who holds the part the sentence is about --
                # it is where this locale puts the product -- so leaving it in
                # front puts the product in the subject slot the source gave
                # the ingredient, and the reader then finds the assertion
                # attributed to something its source never predicated it of.
                or not _faq_answer_assertion_frame_is_supported(
                    clause_without_containment_owner(normalized, identity_names),
                    [*identity, source_record],
                )
            ):
                continue
            return without_inherited_identity([*identity, item])
    card_scoped = _faq_card_answer_evidence(
        normalized,
        evidence,
        identity,
        faq_card=faq_card,
        can_recommend=faq_can_recommend,
    )
    if card_scoped:
        return without_inherited_identity(card_scoped)
    formula_carrier = _faq_membership_formula_carrier_evidence(normalized, evidence, identity)
    if formula_carrier:
        return without_inherited_identity(formula_carrier)
    metric_result = _faq_membership_metric_result_evidence(normalized, evidence, identity)
    if metric_result:
        return without_inherited_identity(metric_result)
    usage_carrier = _faq_membership_usage_carrier_evidence(normalized, evidence, identity)
    if usage_carrier:
        return without_inherited_identity(usage_carrier)
    recommendation_carrier = _faq_membership_recommendation_evidence(
        normalized,
        evidence,
        identity,
        can_recommend=faq_can_recommend,
        faq_card=faq_card,
    )
    if recommendation_carrier:
        return without_inherited_identity(recommendation_carrier)
    clause_wise = _faq_clause_wise_answer_evidence(normalized, evidence, identity)
    if clause_wise:
        return without_inherited_identity(clause_wise)
    coordinated = _faq_sibling_fact_answer_evidence(normalized, evidence, identity, required_tokens)
    if coordinated:
        return without_inherited_identity(coordinated)
    listed_parts = _faq_card_listed_part_evidence(
        normalized, evidence, identity, required_tokens, faq_card=faq_card
    )
    if listed_parts:
        return without_inherited_identity(listed_parts)
    return []


def _source_spans_an_answer_may_rest_on(answer: str, source: str, names: Sequence[str]) -> list[str]:
    """Return the run of a source that states what this answer attributes to its subject.

    A source sentence routinely joins two attributions with a connective
    (``판테놀은 … 돕고, 베타인은 … 설명됩니다``).  Read as one bag of words
    it carries both facts and both names, so the sentence that puts one
    ingredient's name over the other's fact reads as a restatement of it:
    measured, the swap bound to that joined atom while the true sentence bound
    to its own.

    A source states as many attributions as it marks subjects, so the sentence
    is cut where a new subject is marked and nowhere else.  Cutting at every
    clause boundary instead would cut a modifier off the noun it modifies --
    ``features Ceramide Complex, which supports hydration`` states one fact,
    and neither half of it states that fact -- and a clause that marks no
    subject of its own goes on predicating of the one before it.  A source
    that marks none at all (``피부과 테스트 완료``, and every English sentence,
    which orders its subject rather than marking it) attributes to whatever
    named it, so there is nothing in it to move and it is read whole.

    The containment phrase comes off the answer first: it names the product the
    part belongs to, and leaving it in front puts the product where the source
    put the ingredient.  When the answer's subject is the product itself it
    attributes nothing to a part, and the identity scaffold already governs
    that.

    Both binders read this one definition: the row-local binder asks which run
    of a source carries a whole answer sentence, and the clause-wise binder
    asks which carries one clause of it.
    """

    subject = korean_subject_noun(clause_without_containment_owner(answer, names))
    if not subject or span_names_only_the_entity(subject, names):
        return [clean_text(source)]
    stated = publishable_stems(subject)
    spans: list[list[str]] = []
    governed = True
    for clause in split_into_clauses(source) or [clean_text(source)]:
        marked = korean_subject_noun(clause)
        if marked:
            governed = publishable_stems(marked) == stated
            spans.append([])
        elif not spans:
            spans.append([])
        if governed:
            spans[-1].append(clause)
    return [" ".join(span) for span in spans if span]


def _faq_answer_assertion_frame_is_supported(
    sentence: str, evidence: Sequence[Mapping[str, Any]]
) -> bool:
    """Read a FAQ answer's assertion frame, allowing a preposition that only places.

    The shared reader charges every word the source did not write, which is what
    a published description needs: there a word the page never used is a word
    the page never said.  A FAQ answer restates a recorded fact in the row's own
    prose, so it writes the relation in its own preposition -- a source filing
    the study group as ``(32 women)`` is restated as ``among 32 women`` -- and
    one such word made the whole sentence unsupported although every other word
    was the source's.

    Only prepositions that place without qualifying are set aside, and only
    here.  The shared class is what other surfaces decide with, so it stays as
    it is; a word that states a bound or a polarity is still charged, because
    that is a limit the source may never have written.
    """

    if _sentence_assertion_frame_is_supported(sentence, evidence):
        return True
    placed = _FAQ_PLACING_PREPOSITION.sub(" ", sentence)
    return placed != sentence and _sentence_assertion_frame_is_supported(placed, evidence)


# The word that joins two clauses, where this locale writes it as a word.
# The reader below already holds that "the join itself adds nothing -- a
# connective states no relation its clauses do not already have" -- Korean
# fuses the join into the predicate (``돕고``), so its stem reader absorbed it
# and the rule was never tested in the market that writes it separately.  Left
# standing at the head of the clause it was charged as a word no source wrote,
# and a sentence whose every clause matched a record verbatim published
# nothing.
#
# Only a join that asserts nothing is dropped.  A causal or inferential
# connective states that one clause follows from the other, which is a
# relation a record has to carry, so it stays on the clause and is charged.
_FAQ_CLAUSE_JOINING_CONNECTIVE = re.compile(
    r"^\s*(?:and|but|or|nor|yet|while|whilst|whereas)\s+", re.IGNORECASE
)


def _faq_clause_wise_answer_evidence(
    answer: str,
    evidence: Sequence[Mapping[str, Any]],
    identity: Sequence[Mapping[str, Any]],
) -> list[Mapping[str, Any]]:
    """Bind a joined answer one clause at a time, each clause by a source of its own.

    Both markets join two separately recorded facts with a connective
    (``…에 담긴 판테놀은 피부 장벽 개선을 돕고, 베타인은 …``), and neither source
    states the other's clause.  The reader beside this one asks the answer to
    account for every word each source wrote, which a joined sentence does not:
    it takes the fact and leaves the source's apposition behind.  So the unit
    read here is the clause, and what a clause may say is what one source says.

    A clause that adds a word no source carries fails, and the join itself adds
    nothing -- a connective states no relation its clauses do not already have,
    which is why the whole answer is still held to the modality its sources
    carry.  Comparing stems rather than spellings is what lets a clause re-end
    the source's own predicate (``돕습니다`` closing a sentence, ``돕고``
    continuing one) without that counting as a word the source never wrote.
    """

    names = tuple(clean_text(item.get("text")) for item in identity if clean_text(item.get("text")))
    clauses = [clause for clause in split_into_clauses(answer) if clean_text(clause)]
    if len(clauses) < 2:
        return []
    sources = [
        item
        for item in evidence
        if clean_text(item.get("role")) != "identity"
        and clean_text(item.get("sourcePath"))
        and clean_text(item.get("text"))
        and not re.search(r"[?？]\s*$", clean_text(item.get("text")))
    ]
    if not sources:
        return []
    used: list[Mapping[str, Any]] = []
    carried: list[str] = []
    for clause in clauses:
        # What the clause asserts is the clause without the word that joined
        # it, and every reader below is given that one reading.  Splitting the
        # two apart is what let the connective pass the word check and then be
        # charged again by the frame check one step later.
        asserted = _FAQ_CLAUSE_JOINING_CONNECTIVE.sub("", clause)
        stated = publishable_stems(asserted, without=names) - _CONTAINMENT_FRAME_STEMS
        if not stated:
            continue
        carrier = next(
            (
                item
                for item in sources
                if any(
                    stated <= publishable_stems(span)
                    for span in _source_spans_an_answer_may_rest_on(clause, clean_text(item.get("text")), names)
                )
                and not _evidence_scope_mismatch(clause, clean_text(item.get("text")))
            ),
            None,
        )
        if carrier is None:
            return []
        used.append(carrier)
        carried.append(asserted)
    if len(used) < 2:
        return []
    # The frame is read on the clause that asserts, with the containment phrase
    # taken off first.  That phrase names the owner of the part the clause is
    # about -- it is where this locale puts the product -- so leaving it in
    # front puts the product in the subject slot the source gave the
    # ingredient, and the reader then finds the assertion attributed to
    # something its source never predicated it of.  Measured: the clause
    # reads unsupported with ``{product}에 담긴`` in front of it and supported
    # without, against the same source.
    for clause, carrier in zip(carried, used, strict=True):
        if not _faq_answer_assertion_frame_is_supported(
            clause_without_containment_owner(clause, names), [*identity, carrier]
        ):
            return []
    return _unique_evidence_records([*identity, *used])


def _faq_sibling_fact_answer_evidence(
    answer: str,
    evidence: Sequence[Mapping[str, Any]],
    identity: Sequence[Mapping[str, Any]],
    required_tokens: set[str],
) -> list[Mapping[str, Any]]:
    """Resolve an answer that states several sibling facts of one kind at once.

    A page files each completed test, each listed ingredient, as its own atom,
    and an answer reads naturally only when it states them together: "피부과
    테스트와 인체 안자극 테스트를 완료했습니다".  Requiring one source sentence
    to carry the whole answer rejected that, so a row whose own card held every
    fact published nothing at all.

    Sibling facts of one role are a list, and coordinating a list asserts no
    relation that the list does not already contain.  Facts of different roles
    are not siblings -- an ingredient stated beside a measured result reads as
    its cause -- so the union is taken within one role, and it has to account
    for every word the answer asserts.

    Negation and claim modality are properties of the whole claim, so they are
    checked against the facts the answer rests on together: in a coordination
    one sibling carries the modality for both ("dermatologist tested and
    ophthalmologist tested" is a safety claim), and asking each atom to carry it
    alone rejected the coordination that made it true.
    """

    by_role: dict[str, list[Mapping[str, Any]]] = {}
    for item in evidence:
        role = clean_text(item.get("role"))
        if role == "identity" or not clean_text(item.get("sourcePath")) or not clean_text(item.get("text")):
            continue
        by_role.setdefault(role, []).append(item)
    for role_items in by_role.values():
        stated: list[Mapping[str, Any]] = []
        covered: set[str] = set()
        for item in role_items:
            source = clean_text(item.get("text"))
            # The atom supplies the kind word its own role names, and only as
            # far as the answer used it, so a list of recorded parts can say
            # what kind they are without that word coming free of any record.
            tokens = set(_faq_words_that_assert(source)) | _faq_role_kind_tokens(
                item.get("role"), required_tokens, answer
            )
            if (
                not tokens
                or not tokens <= required_tokens
                or re.search(r"[?？]\s*$", source)
                or _evidence_scope_mismatch(answer, source)
            ):
                continue
            stated.append(item)
            covered |= tokens
        if len(stated) < 2 or not required_tokens <= covered:
            continue
        if not _claim_scope_matches(answer, " ".join(clean_text(item.get("text")) for item in stated)):
            continue
        if not _faq_answer_assertion_frame_is_supported(answer, [*identity, *stated]):
            continue
        return [*identity, *stated]
    return []


def _faq_answer_asserted_tokens(value: str, identity_tokens: set[str]) -> set[str]:
    """Words a FAQ answer span states of its own (ported onto the working-tree R2a)."""

    return (
        set(_faq_words_that_assert(value))
        - identity_tokens
        - _ENTITY_KIND_TOKENS
        - _CONTAINMENT_FRAME_ANSWER_TOKENS
    )


def _faq_sentence_names_the_product(span: str, identity: Sequence[Mapping[str, Any]]) -> bool:
    """Return whether a span calls the product itself, not merely its maker.

    Both are identity records and both are named the same way, so the reader
    that only asks "is an identity named here" cannot tell a composition
    attributed to the product from one attributed to the brand.  Which record
    is the product is the path it came from, and either spelling of its title
    names it -- the recorded one, or the one the schema publishes -- exactly as
    the sentence-identity reader accepts either.
    """

    return any(
        clean_text(item.get("sourcePath")).endswith(("product.name", "product.originalName"))
        and (recorded := clean_text(item.get("text")))
        and (
            contains_entity_identity_phrase_in_prose(span, recorded)
            or contains_entity_identity_phrase_in_prose(
                span, product_title_without_sku_qualifier(recorded)
            )
        )
        for item in identity
    )


def _faq_card_claim_part_name(claim: Mapping[str, Any]) -> str:
    """Return the name the card filed for the part one claim is about.

    A relation has two sides and the card files them apart, so the name of the
    part is a field of its own -- written only after the builder has read it
    out of the source that states the relation, and only when it is a name at
    all.  Reading the claim's prose instead would take the fact with the name.

    A part filed on its own has no second side, so the card writes the record
    as the claim, and the record *is* the name.  Only when it is: a record that
    states something is a fact about the product, not one more thing it holds,
    and the naming contract is what tells the two apart -- the card builder
    reads that same contract to refuse ``It is designed to`` as an ingredient.
    """

    if clean_text(claim.get("role")) not in _FAQ_CARD_PART_ROLES:
        return ""
    if named := clean_text(claim.get(_FAQ_CARD_PART_NAME_FIELD)):
        return named
    recorded = clean_text(claim.get("text"))
    if not recorded or is_complete_sentence(recorded) or not names_a_thing(recorded):
        return ""
    return recorded


# What may stand between the items of a list, and nothing else may.  A list is
# written as its items joined by coordination; anything else standing there
# subordinates one item to another and states a relation the list never did.
# The markers are grammar, not vocabulary -- Korean's are already contracted as
# phrase-closing particles, and the English coordinators are their counterpart,
# named the way the containment frames beside them are.
# ``is formulated with`` states containment the way ``includes`` does, but it
# is read in position rather than as a word, because ``formulated`` alone also
# stands where an answer asserts ("formulated for sensitive skin").
_FAQ_COMPOSITION_FRAME = re.compile(r"\b(?:is|are|was|were)\s+formulated\s+with\b", re.IGNORECASE)
_FAQ_LIST_COORDINATION = re.compile(
    r"^(?:[\s,;、·/()\[\]]|and\b|"
    rf"(?:{KOREAN_PHRASE_CLOSING_PARTICLE_ALTERNATION})|"
    r"[.!?。！？])*$",
    re.IGNORECASE,
)
# Where the containment frame stands in a sentence.  The forms are the shared
# contract's, plus the bare Korean stem its inflected forms are built on
# (``함유합니다``), plus the composition frame read in position beside them.
# One definition, because two readers need the same answer off it: the listing
# reader, which refuses a second frame standing between two listed names, and
# the holder reader below, which reads the slot on the side of the frame this
# locale puts it on.
_FAQ_CONTAINMENT_FRAME = re.compile(
    "|".join(
        [
            *(
                re.escape(form)
                for form in (*ENGLISH_CONTAINMENT_FRAME_FORMS, *KOREAN_CONTAINMENT_FRAME_FORMS, "함유")
            ),
            _FAQ_COMPOSITION_FRAME.pattern,
        ]
    ),
    re.IGNORECASE,
)


def _faq_answer_states_containment(body: str) -> bool:
    """Whether a clause writes the relation "this entity holds this part".

    Read off words rather than off the frame's position, because that is what
    tells a stated containment from a word that merely spells one: ``무함유``
    says the product is free of the thing, and the tokenizer keeps it whole
    while a substring scan would find ``함유`` inside it.
    """

    return bool(
        _FAQ_COMPOSITION_FRAME.search(body)
        or set(_substantive_tokens(body)) & _CONTAINMENT_FRAME_ANSWER_TOKENS
    )


def _faq_containment_holder_span(body: str) -> str:
    """Return the run of a containment clause that names who does the holding.

    A containment relation has two sides, and each market writes the holder in
    its own place: Korean marks it with a subject particle and puts the verb
    last, English orders it in front of the verb that states the holding.  So
    the slot is read by position and by the mark this locale uses, never by any
    word standing in it -- the point of reading it at all is that whatever
    stands there may be the wrong entity.

    The marked noun is returned with the run in front of it, because a Korean
    subject particle attaches to the head of the phrase and the words that name
    the product come before that head (``SAMPLE_DERMA SampleDerma … 클렌징폼은``).
    Reading the head alone withheld the product's own name and refused every
    Korean containment sentence, which would have closed one market's answers
    while leaving the other's open.
    """

    if (subject := korean_subject_noun(body)) and (marked := re.search(re.escape(subject), body)):
        return body[: marked.end()]
    frame = _FAQ_CONTAINMENT_FRAME.search(body)
    return body[: frame.start()] if frame else ""


def _faq_recorded_part_names(
    evidence: Sequence[Mapping[str, Any]], faq_card: Mapping[str, Any] | None
) -> set[str]:
    """Return every name the record filed for a part of this product.

    A card files the part of a relation as a field of its own, and a page that
    lists a part on its own files the name as the record.  Both are read here
    through the one naming contract, so a record that states a fact about the
    product (``판테놀은 … 돕습니다``) is not mistaken for the name of a thing
    the product holds -- which is the whole difference this reader exists to
    keep.
    """

    names = {
        name
        for claim in _faq_card_claims(as_dict(faq_card))
        if (name := _faq_card_claim_part_name(claim))
    }
    for item in evidence:
        if clean_text(item.get("role")) not in _FAQ_CARD_PART_ROLES:
            continue
        recorded = clean_text(item.get("text"))
        if recorded and not is_complete_sentence(recorded) and names_a_thing(recorded):
            names.add(recorded)
    return names


def _faq_containment_relation_is_recorded(
    body: str,
    evidence: Sequence[Mapping[str, Any]],
    identity: Sequence[Mapping[str, Any]],
    *,
    faq_card: Mapping[str, Any] | None,
) -> bool:
    """Whether both slots of a stated containment hold what the record filed there.

    The frame word comes off the comparison every reader below makes, on the
    licence that the card already records the product holding the part.  Once
    it is off, ``X includes A and B`` is the same bag of words as the plain
    list ``A and B``, so no reader past that subtraction can see that a
    relation was written at all -- and a relation has two slots that a list
    does not.  Both are therefore read here, before the subtraction, and the
    licence is checked instead of assumed.

    Who holds: the product, not the brand that makes it and not one of the
    parts.  Both are named the same way in the same identity records, and a
    part reads as a holder in the same grammar, so the slot is checked against
    the record the name came from.  Measured on the live runs, leaving it
    unchecked published ``SampleBotanics includes Korean Herb Extract and Vitamin C
    Derivative`` (a composition the record states of one product and never of
    its maker), ``500-Hour Aged Ginseng Extract includes Korean Herb Extract``
    and ``판테놀은 베타인을 함유합니다`` (one part holding another).

    What is held: a name the record filed for a part, and nothing else.  A
    benefit, an effect or a completed test is something the product does or has
    been through, not something it holds, and with the frame gone those atoms
    cover the answer's words exactly as a list of ingredient names would.
    Measured: ``… includes firming, hydrating and radiance`` rested on three
    benefit atoms and ``…은 피부 장벽 개선을 함유합니다`` on an effect atom.

    Read as two slots rather than as a rung of its own: the rung that judges
    containment correctly is the last one, and the readers in front of it are
    written for other sentences entirely -- restatement and sibling listing --
    so they cannot be asked to know what a containment sentence is.  Answering
    here, at the dispatch, leaves every non-containment sentence on exactly the
    path it took before.
    """

    identity_names = [clean_text(entry.get("text")) for entry in identity if clean_text(entry.get("text"))]
    # One relation, because a second one is written between two of the names
    # the first one lists: ``includes Korean Herb Extract containing Vitamin C
    # Derivative`` and ``판테놀을 함유한 베타인을 함유합니다`` each put a part
    # in the holder slot of an inner containment, and the record states that
    # relation of neither part.  The reader at the foot of the ladder already
    # refuses a second frame for this reason; counted rather than parsed, the
    # rule reads the same in both markets, which a rule that had to find where
    # each locale ends its verb would not.
    frames = list(_FAQ_CONTAINMENT_FRAME.finditer(body))
    if len(frames) != 1:
        return False
    holder = _faq_containment_holder_span(body)
    if not _faq_sentence_names_the_product(holder, identity):
        return False
    # And nothing but the product: a holder slot that states anything of its
    # own is no longer a name in a slot, it is a claim in front of the frame.
    if not span_names_only_the_entity(holder, identity_names):
        return False
    identity_tokens = {token for name in identity_names for token in _substantive_tokens(name)}
    # The composition frame comes off by position, the way the listing reader
    # takes it off, because ``formulated`` is a word an answer may also assert
    # with ("formulated for sensitive skin") and only its position here says it
    # is the frame.
    held = _faq_answer_asserted_tokens(_FAQ_COMPOSITION_FRAME.sub(" ", body), identity_tokens)
    # Only a name the sentence wrote whole counts, read the way the listing
    # reader reads it.  Counting words alone let half a filed name stand for
    # the whole: measured, ``… includes Korean Herb`` accounted for every word
    # against ``Korean Herb Extract`` and bound to it, naming a part the record
    # never filed.
    written = [
        name
        for name in _faq_recorded_part_names(evidence, faq_card)
        if contains_entity_identity_phrase_in_prose(body, name)
    ]
    filed = {token for name in written for token in _faq_answer_asserted_tokens(name, identity_tokens)}
    if not held or not held <= filed:
        return False
    # Words alone still cannot tell a list from a relation written between its
    # items -- ``A with B``, ``A's B`` and ``A보다 B를 더`` account for exactly
    # the same words as ``A and B`` -- so what stands between the names is read
    # by position, the way the listing reader reads it.  The frame is blanked
    # over the whole word it sits in, because Korean writes the ending onto the
    # stem and blanking only the contracted stem would leave ``합니다`` standing
    # as residue in every Korean containment while English kept passing.
    start, end = frames[0].span()
    while end < len(body) and not body[end].isspace():
        end += 1
    spans = [
        match.span()
        for name in {*written, *identity_names, *(product_title_without_sku_qualifier(n) for n in identity_names)}
        if name
        for match in [re.search(rf"(?<!\w){re.escape(name)}", body, re.IGNORECASE)]
        if match
    ]
    return _faq_listing_has_no_residue(body, len(holder), [*spans, (start, end)], None)


def _faq_listing_has_no_residue(
    answer: str, head_end: int, spans: Sequence[tuple[int, int]], frame: re.Match[str] | None
) -> bool:
    """Whether the answer past its head is the listed names and nothing else.

    The reader above counts words, and a word count has no positions: ``A and
    B``, ``A with B``, ``A's B``, ``B in A`` and ``A, which contains B`` all
    reduce to the same two words once the frame and the entity come off, so a
    reader that only counts them cannot tell a list from a relation written
    between its items.  What tells them apart is what stands *between* the
    names, so that is read here: past the head, the answer has to be the name
    spans, the one containment frame, and coordination.
    """

    blanked = list(answer)
    for start, end in spans:
        for index in range(start, end):
            blanked[index] = " "
    if frame is not None and frame.end() > head_end:
        for index in range(frame.start(), frame.end()):
            blanked[index] = " "
    return bool(_FAQ_LIST_COORDINATION.match("".join(blanked[head_end:])))


def _faq_card_listed_part_evidence(
    answer: str,
    evidence: Sequence[Mapping[str, Any]],
    identity: Sequence[Mapping[str, Any]],
    required_tokens: set[str],
    *,
    faq_card: Mapping[str, Any] | None,
) -> list[Mapping[str, Any]]:
    """Rest a sentence that only names parts on the atoms that carry those names.

    A page files each part as ``{name} {what the part does}``, and the answer
    that opens a buyer-decision row names the parts and leaves their facts to
    the sentences after it: ``{product} includes Ginseng Peptide and
    Niacinamide.``  No single atom carries both names, so the row-local binder
    refuses it; and the sibling reader asks each atom's words to sit inside the
    answer, which an atom holding its own fact (``helps support skin firmness
    and elasticity``) never does.  Measured over the five live runs, the two
    answers written that way bound to nothing and their rows went unpublished
    although every word of them was a recorded name.

    What makes the union safe is that a list of names asserts only membership,
    and the card already holds that: each name here is one the card filed for a
    part of *this* product.  So the sentence may take the names and nothing
    else, and three separate things have to hold at once.

    First, the sentence states membership and only that.  Every word it asserts
    has to be a word of a filed name -- exactly, in both directions, so a name
    the answer wrote only half of covers nothing and a word no name accounts
    for refuses the sentence.  ``… includes A and B, which improve radiance``
    leaves ``improve`` and ``radiance`` standing; ``… includes A and Retinol``
    leaves ``retinol`` standing when no claim filed it; ``A improves radiance
    and B improves firmness`` leaves both facts standing, which is the point --
    pairing two facts is composing a relation, not listing names.

    Second, the entity is the one doing the holding.  Everything before the
    first name the sentence lists has to name the entity and state nothing
    else, so a sentence that puts a part in that slot is refused however well
    its words add up: ``Niacinamide includes Ginseng Peptide`` accounts for
    every word and is still a containment no record wrote.

    Third, each name has to come back from an atom the row cited that carries
    it.  That is what the sentence ends up resting on -- the union of the atoms
    holding the names -- and an answer that mixed one atom's name with
    another's fact never reaches here, because the fact was a word no name
    accounted for.

    Deliberately not here: a sentence with a figure the names do not carry, a
    modality, a causal connective, or a stated benefit.  Each of those is a
    claim beyond membership, and this reader has no evidence for one.
    """

    card = as_dict(faq_card)
    identity_names = [clean_text(item.get("text")) for item in identity if clean_text(item.get("text"))]
    if not card or not identity_names or not required_tokens:
        return []
    body = clause_without_containment_owner(answer, identity_names)
    if not _faq_answer_states_containment(body):
        # Naming parts beside the product without saying it holds them is not
        # this sentence; the relation has to be written for the card to cover
        # it.  Read through the one definition the dispatch reads, so a
        # sentence cannot be a containment there and a plain list here.
        return []
    if _FAQ_COMPOSITION_FRAME.search(answer):
        # The frame states containment and nothing else, so it is not charged
        # -- but only here, where the reader has already required the sentence
        # to be a list and nothing but a list.
        required_tokens = _faq_answer_asserted_tokens(
            _FAQ_COMPOSITION_FRAME.sub(" ", body),
            {token for name in identity_names for token in _substantive_tokens(name)},
        )
    if _claim_modalities(answer) or _FAQ_CAUSAL_CONNECTOR.search(answer) or _BENEFIT_RELATION.search(answer):
        return []

    identity_tokens = {
        token for name in identity_names for token in _substantive_tokens(name)
    }
    listed: list[tuple[str, Mapping[str, Any]]] = []
    covered: set[str] = set()
    for claim in _faq_card_claims(card):
        name = _faq_card_claim_part_name(claim)
        # The answer has to have written the name, as a phrase of its own: a
        # word count alone would let a name pass that the sentence never wrote
        # whole, and the identity contract already reads a name out of prose
        # in whichever slot this locale's grammar gives it.
        if not name or not contains_entity_identity_phrase_in_prose(answer, name):
            continue
        tokens = _faq_answer_asserted_tokens(name, identity_tokens)
        if not tokens or not tokens <= required_tokens:
            continue
        listed.append((name, claim))
        covered |= tokens
    # Two, because one name is what the single-claim card reader above already
    # covers; standing in front of it would move a binding it owns.
    if len({name.casefold() for name, _ in listed}) < 2 or covered != required_tokens:
        return []

    spans = [
        match.span()
        for name, _ in listed
        if (match := re.search(rf"(?<!\w){re.escape(name)}", answer, re.IGNORECASE))
    ]
    if len(spans) != len(listed):
        return []
    starts = [start for start, _ in spans]
    head = answer[: min(starts)]
    frames = list(_FAQ_CONTAINMENT_FRAME.finditer(answer))
    # One frame, because a second one frames one listed name with another.
    if len(frames) != 1:
        return []
    # The entity's own span comes out the same way, so a word that merely
    # happens to spell part of the product's name ("Concentrated ... includes
    # Concentrated Botanical Peptide") is residue like any other instead of
    # being waved through by the identity token subtraction.
    entity_spans = [
        match.span()
        for name in {n for n in identity_names} | {
            product_title_without_sku_qualifier(n) for n in identity_names
        }
        if name
        for match in [re.search(rf"(?<!\w){re.escape(name)}", answer, re.IGNORECASE)]
        if match
    ]
    if not _faq_listing_has_no_residue(answer, 0, [*spans, *entity_spans], frames[0]):
        return []
    # The product, not the brand.  A brand is named in the same identity
    # records and reads as a holder in the same grammar, so accepting either
    # let ``SampleBotanics includes Ginseng Peptide and Niacinamide`` stand -- a
    # composition the record states of one product and never of the maker.
    # Which record is the product is the sourcePath, read the way the identity
    # reader beside this one reads it.
    if not _faq_sentence_names_the_product(head, identity):
        return []
    if _faq_answer_asserted_tokens(_FAQ_COMPOSITION_FRAME.sub(" ", head), identity_tokens):
        return []

    allowed_figures = {
        figure
        for value in (*identity_names, *(name for name, _ in listed))
        for figure in _numeric_tokens(value)
    }
    if set(_numeric_tokens(answer)) - allowed_figures:
        return []

    atoms: list[Mapping[str, Any]] = []
    for name, claim in listed:
        carrying = [
            item
            for item in _faq_card_claim_evidence(claim, evidence)
            if (source := clean_text(item.get("text")))
            and not re.search(r"[?？]\s*$", source)
            and contains_entity_identity_phrase_in_prose(source, name)
            and not _evidence_scope_mismatch(answer, source)
        ]
        if not carrying:
            return []
        atoms.extend(carrying)
    if not _claim_scope_matches(answer, " ".join(clean_text(item.get("text")) for item in atoms)):
        return []
    if not _faq_answer_assertion_frame_is_supported(answer, [*identity, *atoms]):
        return []
    return _unique_evidence_records([*identity, *atoms])


def _faq_card_answer_evidence(
    sentence: str,
    evidence: Sequence[Mapping[str, Any]],
    identity: Sequence[Mapping[str, Any]],
    *,
    faq_card: Mapping[str, Any] | None,
    can_recommend: bool,
) -> list[Mapping[str, Any]]:
    """Bind a fluent answer only to one validated card claim.

    This is deliberately narrower than the ordinary row-local source binder:
    it is the sole path that joins separate ingredient and benefit ledger atoms,
    and only when the service-owned card recorded that exact relation as
    ``explicit``.  Independent claims remain one-fact sentences.
    """

    card = as_dict(faq_card)
    if not card or _FAQ_CAUSAL_CONNECTOR.search(sentence) or _claim_modalities(sentence) - {"recommendation"}:
        return []
    claims = _faq_card_claims(card)
    if not claims:
        return []

    if (
        can_recommend
        and card.get("canRecommend") is True
        and _FAQ_RECOMMENDATION_CARRIER.search(sentence)
        and not _numeric_tokens(sentence)
    ):
        for claim in claims:
            if (
                clean_text(claim.get("role")) not in {"audience", "concern"}
                or clean_text(claim.get("relationship")) != "explicit"
                or not _faq_card_claim_covers_sentence(
                    sentence,
                    claim,
                    identity,
                    carrier_tokens=_FAQ_RECOMMENDATION_CARRIER_TOKENS,
                )
            ):
                continue
            claim_evidence = _faq_card_claim_evidence(claim, evidence)
            if claim_evidence:
                return [*identity, *claim_evidence]

    formula_carrier = re.search(r"\b(?:lists?|includes?|contains?|features?|has)\b|(?:포함|함유)", sentence, re.I)
    if formula_carrier and not _claim_modalities(sentence):
        for claim in claims:
            role, relationship = clean_text(claim.get("role")), clean_text(claim.get("relationship"))
            if role == "ingredient-effect" and relationship == "explicit":
                if not _faq_card_claim_states_the_figures(sentence, claim, identity):
                    continue
                if not _faq_card_claim_covers_sentence(
                    sentence,
                    claim,
                    identity,
                    carrier_tokens=_FAQ_FORMULA_CARRIER_TOKENS,
                ):
                    continue
                claim_evidence = _faq_card_claim_evidence(claim, evidence)
                if claim_evidence:
                    return [*identity, *claim_evidence]
            elif role == "ingredient" and relationship == "independent" and not _BENEFIT_RELATION.search(sentence):
                if not _faq_card_claim_states_the_figures(sentence, claim, identity):
                    continue
                if not _faq_card_claim_covers_sentence(
                    sentence,
                    claim,
                    identity,
                    carrier_tokens=_FAQ_FORMULA_CARRIER_TOKENS,
                ):
                    continue
                claim_evidence = _faq_card_claim_evidence(claim, evidence)
                if claim_evidence:
                    return [*identity, *claim_evidence]

    # A card may record the ingredient/effect clause itself as explicit
    # source support.  In that case a following sentence can preserve that
    # relation without reintroducing a formula-listing lead (for example,
    # ``Its peptide helps support …`` after the preceding branded sentence).
    # This remains unavailable to independent ingredient and benefit cards.
    if _BENEFIT_RELATION.search(sentence):
        for claim in claims:
            if (
                clean_text(claim.get("role")) != "ingredient-effect"
                or clean_text(claim.get("relationship")) != "explicit"
                or not _faq_card_claim_states_the_figures(sentence, claim, identity)
                or not _faq_card_claim_covers_sentence(sentence, claim, identity)
            ):
                continue
            claim_evidence = _faq_card_claim_evidence(claim, evidence)
            if claim_evidence:
                return [*identity, *claim_evidence]

    if _numeric_tokens(sentence):
        for claim in claims:
            if clean_text(claim.get("role")) != "metric" or clean_text(claim.get("relationship")) != "explicit":
                continue
            claim_evidence = _faq_card_claim_evidence(claim, evidence)
            source = clean_text(claim.get("text"))
            if (
                not claim_evidence
                or set(_numeric_tokens(sentence)) - set(_numeric_tokens(source))
                or not _faq_card_claim_covers_sentence(sentence, claim, identity, metric=True)
                or not _faq_metric_result_keeps_context(sentence, source)
            ):
                continue
            return [*identity, *claim_evidence]
    return []


def _faq_membership_formula_carrier_evidence(
    sentence: str,
    evidence: Sequence[Mapping[str, Any]],
    identity: Sequence[Mapping[str, Any]],
) -> list[Mapping[str, Any]]:
    """Bind a named-product ingredient listing without inferring an effect.

    The only new words permitted around an ingredient atom are a neutral
    formula carrier such as ``lists … among its ingredients``.  An ingredient
    cannot become the subject or cause of an outcome through this exception.
    """

    if (
        not _FAQ_FORMULA_CARRIER.search(sentence)
        or _INGREDIENT_RELATION.search(sentence)
        or _BENEFIT_RELATION.search(sentence)
        or _FAQ_CAUSAL_CONNECTOR.search(sentence)
        or _claim_modalities(sentence)
    ):
        return []
    identity_tokens = {
        token for item in identity for token in _substantive_tokens(clean_text(item.get("text")))
    }
    candidate_tokens = (
        set(_substantive_tokens(sentence))
        - identity_tokens
        - _PUBLIC_COPY_TEMPLATE_TOKENS
        - _FAQ_FORMULA_CARRIER_TOKENS
    )
    if not candidate_tokens:
        return []
    for item in evidence:
        if clean_text(item.get("role")) not in {"ingredient", "formula"} or not clean_text(item.get("sourcePath")):
            continue
        source_tokens = set(_substantive_tokens(clean_text(item.get("text"))))
        if source_tokens and candidate_tokens <= source_tokens:
            return [*identity, item]
    return []


def _faq_metric_tokens(value: str) -> set[str]:
    """Normalize only neutral metric-report inflections for row-local matching.

    A preposition that places a fact without qualifying it is dropped here for
    the same reason the assertion-frame reader drops it: a source filing the
    study group as ``(32 women)`` is restated as ``among 32 women``, and the
    two say the same thing.  The admission gate already exempts that word as a
    claim frame, so charging it here let one stage publish a sentence the next
    one erased -- measured, a whole English recommendation answer was dropped
    over the single word ``among``.

    Korean states the same relation with a particle its own reader strips, so
    it was never charged there; this is the rule written for one language's
    morphology, not a difference between the languages.
    """

    return set(
        _faq_fold_inflection(
            _FAQ_METRIC_REPORT_TOKEN_NORMALIZATION.get(token, token)
            for token in _substantive_tokens(_FAQ_PLACING_PREPOSITION.sub(" ", value))
        )
    )


def _faq_membership_metric_result_evidence(
    sentence: str,
    evidence: Sequence[Mapping[str, Any]],
    identity: Sequence[Mapping[str, Any]],
) -> list[Mapping[str, Any]]:
    """Bind one naturally ordered metric result to one source metric group.

    This accepts neutral tense/order changes (for example ``agree`` to
    ``agreed``) and an identity suffix, but retains all rendered numbers and
    requires timing, sample, method, and outcome terms to come from a single
    metric record.  It never combines neighboring metric records.
    """

    if _FAQ_CAUSAL_CONNECTOR.search(sentence) or _claim_modalities(sentence):
        return []
    candidate_numbers = set(_numeric_tokens(sentence))
    if not candidate_numbers:
        return []
    identity_tokens = {
        token for item in identity for token in _faq_metric_tokens(clean_text(item.get("text")))
    }
    candidate_tokens = _faq_metric_tokens(sentence) - identity_tokens - _PUBLIC_COPY_TEMPLATE_TOKENS
    if not candidate_tokens:
        return []
    for item in evidence:
        if clean_text(item.get("role")) != "metric" or not clean_text(item.get("sourcePath")):
            continue
        source = clean_text(item.get("text"))
        source_numbers = set(_numeric_tokens(source))
        # All values shown to readers must be from this one source group.  A
        # source group may contain a sibling result that the answer omits;
        # requiring inverse equality would wrongly force that sibling into the
        # public sentence.
        if not candidate_numbers <= source_numbers:
            continue
        source_tokens = _faq_metric_tokens(source)
        if not candidate_tokens <= source_tokens:
            continue
        if not _faq_metric_result_keeps_context(sentence, source):
            continue
        return [*identity, item]
    return []


def _faq_metric_result_keeps_context(sentence: str, source: str) -> bool:
    """Require visible timing, participant, method, and outcome anchors."""

    candidate_numbers = set(_numeric_tokens(sentence))
    source_numbers = set(_numeric_tokens(source))
    timing = {item for item in source_numbers if re.search(r"(?:weeks?|days?|hours?|minutes?|seconds?|주|일|시간|분|초)$", item, re.I)}
    sample = {
        item
        for item in source_numbers
        if re.search(r"(?:users?|participants?|subjects?|women|men|명|인)$", item, re.I)
    }
    if timing and not timing & candidate_numbers:
        return False
    if sample and not sample & candidate_numbers:
        return False
    source_tokens = _faq_metric_tokens(source)
    candidate_tokens = _faq_metric_tokens(sentence)
    method_terms = {
        token
        for token in source_tokens
        if token in {"instrumental", "clinical", "test", "testing", "survey", "usage", "home", "consumer", "study", "measur", "measure", "시험", "측정", "조사"}
    }
    if method_terms and not method_terms & candidate_tokens:
        return False
    outcome_terms = source_tokens - {
        token
        for token in source_tokens
        if token in {"after", "before", "week", "weeks", "day", "days", "use", "daily", "with", "women", "men", "user", "users", "participant", "participants", "subject", "subjects"}
    } - method_terms - {"agree", "report", "show", "measure", "improve", "find"}
    return bool(outcome_terms & candidate_tokens)


def _faq_usage_tokens(value: str) -> list[str]:
    """Normalize only the passive ``applied`` form used by a neutral usage lead."""

    return [_FAQ_USAGE_TOKEN_NORMALIZATION.get(token, token) for token in _substantive_tokens(value)]


def _tokens_are_in_source_order(candidate: Sequence[str], source: Sequence[str]) -> bool:
    """Return whether the candidate retains the source action/detail order."""

    source_index = 0
    for token in candidate:
        while source_index < len(source) and source[source_index] != token:
            source_index += 1
        if source_index == len(source):
            return False
        source_index += 1
    return True


def _faq_usage_has_exact_single_action_coverage(candidate: Sequence[str], source: Sequence[str]) -> bool:
    """Allow only a neutral use/apply rewrite of one fully preserved source step.

    A single application instruction may move a temporal clause for natural
    FAQ syntax (``immediately after cleansing`` before ``as the first step``),
    but cannot add, drop, or exchange any source detail.  Multi-action steps
    retain the source order strictly so an FAQ never merges or rearranges a
    procedure.
    """

    source_content = [token for token in source if token not in _PUBLIC_COPY_TEMPLATE_TOKENS]
    source_actions = [token for token in source_content if token in _FAQ_USAGE_ACTION_TOKENS]
    candidate_actions = [token for token in candidate if token in _FAQ_USAGE_ACTION_TOKENS]
    return (
        len(source_actions) == 1
        and candidate_actions == source_actions
        and set(candidate) == set(source_content)
    )


def _faq_membership_usage_carrier_evidence(
    sentence: str,
    evidence: Sequence[Mapping[str, Any]],
    identity: Sequence[Mapping[str, Any]],
) -> list[Mapping[str, Any]]:
    """Bind one named-product usage sentence without compressing or reordering it."""

    if _FAQ_CAUSAL_CONNECTOR.search(sentence) or _claim_modalities(sentence) or not _FAQ_USAGE_CARRIER.search(sentence):
        return []
    identity_tokens = {
        token for item in identity for token in _faq_usage_tokens(clean_text(item.get("text")))
    }
    candidate = [
        token
        for token in _faq_usage_tokens(sentence)
        if token not in identity_tokens and token not in _PUBLIC_COPY_TEMPLATE_TOKENS
    ]
    if not candidate:
        return []
    candidate_numbers = set(_numeric_tokens(sentence))
    for item in evidence:
        if clean_text(item.get("role")) != "usage" or not clean_text(item.get("sourcePath")):
            continue
        source = clean_text(item.get("text"))
        source_numbers = set(_numeric_tokens(source))
        if source_numbers != candidate_numbers:
            continue
        source_tokens = _faq_usage_tokens(source)
        if _tokens_are_in_source_order(candidate, source_tokens) or _faq_usage_has_exact_single_action_coverage(
            candidate, source_tokens
        ):
            return [*identity, item]
    return []


# A recommendation is a speech act, and the hedging it is offered with -- "…을
# 추천할 수 있습니다", "worth considering" -- belongs to that act, not to a claim
# about the product.  Reading it as claim uncertainty rejected exactly the
# answer shape a buyer-decision card exists to produce, so the modality is read
# from what the sentence says once the offer is set aside.
_KOREAN_RECOMMENDATION_HEDGE = re.compile(r"(?:할|해볼|해\s*볼)?\s*수\s*있(?:습니다|어요|다)?")


# A recommendation answer states a customer's situation and then offers the
# product for it.  The boundary between the two is the conditional each locale
# marks: Korean on the predicate of the condition, English on a fronted clause.
_KOREAN_CONDITION_BOUNDARY = re.compile(r"[가-힣](?:다면|라면|려면|으면|면)\s|(?:경우|때)에?\s")
# English opens the situation with a subordinator and closes it with a comma,
# but the clause may list what it is about, and every item in that list is
# separated by a comma too.  So the boundary is not the first comma -- it is the
# last one before the offer begins, which is where the product is put forward.
_ENGLISH_CONDITION_OPENER = re.compile(r"^(?:if|when|whenever|for)\b", re.IGNORECASE)


def _faq_recommendation_clauses(sentence: str) -> tuple[str, str]:
    """Split a recommendation into the situation it names and the offer it makes."""

    if _ENGLISH_CONDITION_OPENER.match(sentence) is not None:
        offer = _FAQ_RECOMMENDATION_CARRIER.search(sentence)
        boundary = None
        for match in re.finditer(r",\s+", sentence):
            if offer is not None and match.end() > offer.start():
                break
            boundary = match
        if boundary is not None:
            return sentence[: boundary.end()], sentence[boundary.end() :]
    korean = _KOREAN_CONDITION_BOUNDARY.search(sentence)
    if korean is not None:
        return sentence[: korean.end()], sentence[korean.end() :]
    return "", sentence


def _faq_recommendation_offer_is_bare(
    offer: str,
    identity: Sequence[Mapping[str, Any]],
    recorded: Sequence[Mapping[str, Any]] = (),
) -> bool:
    """Return whether the offer clause states only the product and what is recorded of it.

    The offer is where an unsourced claim would ride along, so nothing may
    stand in it but the product's identity, the words that make the offer, and
    the customer the row's own atoms record.  Both markets write that customer
    on either side of the offer -- ``건조 피부라면 …을 추천합니다`` puts it in
    front, ``consider … for dry skin`` puts it after -- and requiring the offer
    to be bare accepted one and refused the other although each states the same
    recorded fact.  The situation clause is a hypothetical rather than an
    assertion, so it keeps the buyer's own phrasing.
    """

    offered = _KOREAN_RECOMMENDATION_HEDGE.sub(" ", _FAQ_RECOMMENDATION_CARRIER.sub(" ", offer))
    # What closes the sentence is grammar, not a fact it states.
    stripped = KOREAN_POLITE_SENTENCE_ENDING.sub(" ", offered.strip().rstrip(".。！？!?").strip())
    identity_stems = {
        stem for item in identity for stem in _audience_stems(clean_text(item.get("text")))
    }
    recorded_stems = {
        stem for item in recorded for stem in _audience_stems(clean_text(item.get("text")))
    }
    # A coordinator joins what is already recorded and states nothing itself,
    # so the source writing ``and`` and the answer writing ``or`` are the same
    # list.  The function-word class the sentence-form contract owns is read
    # here rather than kept again.
    remaining = (
        _audience_stems(stripped)
        - identity_stems
        - recorded_stems
        - _PUBLIC_COPY_TEMPLATE_TOKENS
        - ENGLISH_FUNCTION_WORDS
    )
    # A one-letter Latin stem is what a possessive or a contraction leaves
    # behind ("Lab's" -> "lab", "s"); it states nothing of the product.
    return not {stem for stem in remaining if len(stem) > 1 or re.search(r"[가-힣]", stem)}


def _faq_recommendation_claim_modalities(sentence: str) -> set[str]:
    """Return the modalities a recommendation sentence asserts of the product."""

    offered = _FAQ_RECOMMENDATION_CARRIER.sub(" ", sentence)
    return _claim_modalities(_KOREAN_RECOMMENDATION_HEDGE.sub(" ", offered)) - {"recommendation"}


def _faq_answer_sentence_identity_evidence(
    sentence: str, evidence: Sequence[Mapping[str, Any]]
) -> list[Mapping[str, Any]]:
    """Find the identity records one FAQ answer sentence names.

    Every surface that asks which entity an answer sentence called reads this
    one definition: the selector, the binder it feeds, and the three places
    that carry a named identity forward to the answer's next sentence.  The
    judgement used to be written out at each of them, and a later widening
    reached only two of the copies, so an answer that named the product the way
    the schema publishes it bound its first sentence, inherited nothing, and
    left the gate unable to read its second.  No provenance entry was written
    at all, and the row was dropped without any sentence being named.

    A record is named when the sentence carries the title the record holds or
    the title the schema publishes for it -- the same product without the pack
    size or promotion bracket the record's title states, which is how a
    relationship card and the published copy spell it.  Both spellings name one
    entity, so accepting either widens only which spelling proves identity;
    every rung that reads what the answer states beyond the name is unchanged.
    Brand and product must both be named, so an answer that mentions one of
    them alone still has no identity to stand on.
    """

    identities = [
        item
        for item in evidence
        if clean_text(item.get("role")) == "identity"
        and (recorded := clean_text(item.get("text")))
        and (
            contains_entity_identity_phrase_in_prose(sentence, recorded)
            or contains_entity_identity_phrase_in_prose(
                sentence, product_title_without_sku_qualifier(recorded)
            )
        )
    ]
    products = [
        item
        for item in identities
        if clean_text(item.get("sourcePath")).endswith(("product.name", "product.originalName"))
    ]
    brands = [item for item in identities if clean_text(item.get("sourcePath")).endswith("product.brand")]
    return [*brands, *products] if products and brands else []


def _faq_membership_recommendation_evidence(
    sentence: str,
    evidence: Sequence[Mapping[str, Any]],
    identity: Sequence[Mapping[str, Any]],
    *,
    can_recommend: bool,
    faq_card: Mapping[str, Any] | None = None,
) -> list[Mapping[str, Any]]:
    """Bind one customer-goal recommendation only when its card permits it.

    ``canRecommend`` comes from the immutable relationship card, not model
    prose.  The carrier therefore cannot turn a generic benefit or ingredient
    into a recommendation: an audience/concern source atom must cover the
    stated customer goal in the same sentence.
    """

    card_scoped = _faq_card_answer_evidence(
        sentence,
        evidence,
        identity,
        faq_card=faq_card,
        can_recommend=can_recommend,
    )
    if card_scoped:
        return card_scoped
    if (
        not can_recommend
        or not _FAQ_RECOMMENDATION_CARRIER.search(sentence)
        or _FAQ_CAUSAL_CONNECTOR.search(sentence)
        # A digit in the product's own name identifies it rather than measuring
        # anything ("BarrierCare365"), which is the distinction the naming
        # contract already draws.  Rejecting every digit rejected every
        # recommendation of a product whose name carries one.
        or not _numeric_tokens_are_ledger_identifiers(sentence, [*identity, *evidence])
        and _numeric_tokens(sentence)
        or _faq_recommendation_claim_modalities(sentence)
    ):
        return []
    situation, offer = _faq_recommendation_clauses(sentence)
    # Without a situation the sentence recommends the product to nobody, which
    # is a recommendation the card's audience atoms cannot cover.
    if not situation:
        return []
    # Which atom carries the customer relation is what the card recorded, not
    # what role the ledger happened to file the line under.  A page that prints
    # its audience inside an ordinary sentence files that line as ``source`` or
    # ``benefit`` while the card still records the claim as ``concern``, so
    # reading the ledger role alone found no customer atom at all and every
    # recommendation built on such a card went out unbound.
    customer_ids = {
        identifier
        for claim in as_list(as_dict(faq_card).get("claims"))
        if clean_text(as_dict(claim).get("role")) in {"audience", "concern"}
        for identifier in as_list(as_dict(claim).get("evidenceIds"))
        if clean_text(identifier)
    }
    customers = [
        item
        for item in evidence
        if (clean_text(item.get("role")) in {"audience", "concern"} or clean_text(item.get("id")) in customer_ids)
        and clean_text(item.get("sourcePath"))
        and clean_text(item.get("text"))
    ]
    # The offer is read against every customer atom this row cites, not only
    # the one the situation happens to name.  Both markets split the customer
    # across two recorded lines -- the concern in one, the skin types it works
    # best for in another -- and a recommendation naming both states no more
    # than the row already cites.
    if not _faq_recommendation_offer_is_bare(offer, identity, customers):
        return []
    # The situation is read against the row's customer atoms together, for the
    # same reason the offer is: a page records the concern on one line and the
    # skin types it works best for on another, and a buyer states both in one
    # breath ("If you have fine lines … and have normal, dry … skin").  Asking
    # one atom to account for the whole situation refused exactly the sentence
    # that cites them all, while naming a customer none of them records still
    # fails -- every designation has to come from some cited atom.
    if _recommendation_situation_rests_on_cited_customers(situation, customers):
        return _unique_evidence_records([*identity, *customers])
    for item in customers:
        source = clean_text(item.get("text"))
        if _evidence_scope_mismatch(sentence, source):
            continue
        # The customer this atom names has to be the customer the situation
        # names.  The buyer's own phrasing of that situation is theirs, so the
        # atom is what must be covered -- not the other way round.
        if not (
            _audience_clause_states_atom(situation, source)
            or _recommendation_situation_names_the_atoms_customer(situation, source)
        ):
            continue
        offered = _audience_stems(offer)
        supporting = [
            other
            for other in customers
            if other is item or (_audience_stems(clean_text(other.get("text"))) & offered)
        ]
        return _unique_evidence_records([*identity, *supporting])
    return []


def _audience_designation_stems(value: str) -> list[frozenset[str]]:
    """Return the words of each customer a text designates, without its grammar.

    A source lists what it is for with ``and`` and a buyer restates the same
    list with ``or``; one of them writes ``skin types`` where the other writes
    ``skin``.  Comparing the phrases as written counts those as different
    customers, so each designation is reduced to the words that name the
    customer and a stated one is covered when some recorded one holds all of
    them -- naming fewer is allowed, naming one no record holds is not.
    """

    return [
        stems
        for phrase in audience_designations(value)
        if phrase and (stems := frozenset(_audience_stems(phrase)) - ENGLISH_FUNCTION_WORDS)
    ]


def _recommendation_situation_rests_on_cited_customers(
    situation: str, customers: Sequence[Mapping[str, Any]]
) -> bool:
    """Return whether every customer a situation names is one some cited atom records.

    A recommendation may address the whole customer its row cites even when the
    page filed that customer across several lines.  What it may not do is name
    a customer no line records, so the designations the situation states have to
    be a subset of the ones the atoms state -- read as the suitability contract
    reads them, because each side writes the customer in its own grammar.
    """

    stated = _audience_designation_stems(situation)
    recorded = [
        designation for item in customers for designation in _audience_designation_stems(clean_text(item.get("text")))
    ]
    if not stated or not recorded:
        return False
    return all(any(one <= other for other in recorded) for one in stated)


def _recommendation_situation_names_the_atoms_customer(situation: str, atom: str) -> bool:
    """Return whether a recommendation's situation names the customer its atom names.

    A source files the customer inside its own framing -- ``건조 피부 또는 민감
    피부에 **추천하는** 클렌징 폼입니다`` -- and a buyer states the same customer
    inside theirs -- ``건조 피부 또는 민감 피부를 **위한** 클렌징 폼을
    **찾는다면**``.  Accounting for every word of one in the other therefore
    charges each side's framing verb to the other, and the sentence naming
    exactly the recorded customer failed on two words neither writer could
    avoid.  What has to match is the customer, and the suitability contract
    already reads who that is.

    Naming fewer customers than the atom is allowed, as it is in the reader
    beside this one: a recommendation may address one of the groups its source
    names.  Naming one the atom does not is refused, so the relation still
    comes from the record.  The reader beside this one stays as it is, because
    the page overview decides something else with it.
    """

    stated, recorded = _audience_designation_stems(situation), _audience_designation_stems(atom)
    if not stated or not recorded:
        return False
    return all(any(one <= other for other in recorded) for one in stated)


def _same_evidence_ids(left: Sequence[Mapping[str, Any]], right: Sequence[Mapping[str, Any]]) -> bool:
    """Compare a sentence binding by immutable ledger IDs, not mutable text."""

    left_ids = {clean_text(item.get("id")) for item in left if clean_text(item.get("id"))}
    right_ids = {clean_text(item.get("id")) for item in right if clean_text(item.get("id"))}
    return bool(left_ids) and left_ids == right_ids


def _entry_sentence_has_direct_support(
    path: str,
    sentence: str,
    evidence: Sequence[Mapping[str, Any]],
    ledger: Sequence[Mapping[str, Any]],
    origin: object,
    faq_row_id: str | None,
    *,
    faq_can_recommend: bool = False,
    faq_card: Mapping[str, Any] | None = None,
    faq_scope_evidence: Sequence[Mapping[str, Any]] = (),
    inherited_identity: Sequence[Mapping[str, Any]] = (),
) -> bool:
    """Apply stable-row FAQ exceptions only after ordinary provenance fails."""

    return sentence_provenance_has_direct_claim_support(sentence, evidence, ledger, origin) or (
        path.endswith(".name")
        and bool(faq_row_id)
        and origin == "model-plan"
        and _faq_membership_question_has_scoped_support(sentence, evidence, faq_card=faq_card)
    ) or (
        path.endswith(".acceptedAnswer.text")
        and bool(faq_row_id)
        and origin == "model-plan"
        and _same_evidence_ids(
            evidence,
            _faq_membership_answer_evidence(
                sentence,
                faq_scope_evidence or evidence,
                faq_can_recommend=faq_can_recommend,
                faq_card=faq_card,
                inherited_identity=inherited_identity,
            ),
        )
    )


def _narrow_sentence_provenance_evidence(
    sentence: str,
    evidence: Sequence[Mapping[str, Any]],
    ledger: Sequence[Mapping[str, Any]],
    origin: str,
) -> list[Mapping[str, Any]]:
    """Drop incidental IDs when a smaller direct source relation proves the sentence.

    Evidence selection may collect several overlapping product facts for one
    renderer sentence.  Provenance must retain only the exact relation that
    supports that sentence; otherwise a harmless extra ID can make a complete
    source-backed fallback description unavailable to the final proofreader.
    """

    selected = list(evidence)
    if not selected or sentence_provenance_has_direct_claim_support(sentence, selected, ledger, origin):
        return selected
    rewritten_description_binding = _entity_rewritten_source_description_binding(sentence, selected)
    if rewritten_description_binding and sentence_provenance_has_direct_claim_support(
        sentence, rewritten_description_binding, ledger, origin
    ):
        return rewritten_description_binding
    description_binding = _english_entity_prefixed_description_binding(sentence, selected)
    if description_binding and sentence_provenance_has_direct_claim_support(
        sentence, description_binding, ledger, origin
    ):
        return description_binding
    entity_subject_binding = _korean_entity_subject_binding(sentence, selected)
    if entity_subject_binding and sentence_provenance_has_direct_claim_support(
        sentence, entity_subject_binding, ledger, origin
    ):
        return entity_subject_binding
    korean_benefit_records = _korean_entity_prefixed_benefit_records(sentence, selected)
    if korean_benefit_records and sentence_provenance_has_direct_claim_support(
        sentence, korean_benefit_records, ledger, origin
    ):
        return korean_benefit_records
    page_offer_records = _renderer_page_offer_records(sentence, selected)
    if page_offer_records and sentence_provenance_has_direct_claim_support(
        sentence, page_offer_records, ledger, origin
    ):
        return page_offer_records
    direct = _direct_assertion_frame_relevant_evidence(sentence, selected)
    if direct and sentence_provenance_has_direct_claim_support(sentence, direct, ledger, origin):
        return direct
    return selected


def _rendered_sentence_evidence(
    text: str,
    ledger: Sequence[Mapping[str, Any]],
    roles: Sequence[str],
) -> RenderedSentenceEvidence:
    eligible = [item for item in ledger if item.get("role") in roles]
    sentence_ids: list[list[str]] = []
    rendered_sentences = _sentences(text)
    for index, sentence in enumerate(rendered_sentences):
        page_overview_records = _renderer_page_overview_records(sentence, eligible)
        if page_overview_records:
            sentence_ids.append(_unique_strings(item.get("id") for item in page_overview_records))
            continue
        page_usage_records = _renderer_page_usage_summary_records(sentence, eligible)
        if page_usage_records:
            sentence_ids.append(_unique_strings(item.get("id") for item in page_usage_records))
            continue
        source_faq_usage_records = _english_source_faq_usage_answer_binding(sentence, eligible)
        if source_faq_usage_records:
            sentence_ids.append(_unique_strings(item.get("id") for item in source_faq_usage_records))
            continue
        source_faq_identity_question = _source_faq_identity_question_binding(sentence, eligible)
        if source_faq_identity_question:
            sentence_ids.append(_unique_strings(item.get("id") for item in source_faq_identity_question))
            continue
        customer_concern_question = _english_customer_concern_question_binding(sentence, eligible)
        if customer_concern_question:
            sentence_ids.append(_unique_strings(item.get("id") for item in customer_concern_question))
            continue
        buyer_audience_question = _english_buyer_audience_question_binding(sentence, eligible)
        if buyer_audience_question:
            sentence_ids.append(_unique_strings(item.get("id") for item in buyer_audience_question))
            continue
        entity_prefixed_benefit = _english_entity_prefixed_benefit_binding(sentence, eligible)
        if entity_prefixed_benefit:
            sentence_ids.append(_unique_strings(item.get("id") for item in entity_prefixed_benefit))
            continue
        generic_subject_description = _english_generic_subject_source_description_binding(sentence, eligible)
        if generic_subject_description:
            sentence_ids.append(_unique_strings(item.get("id") for item in generic_subject_description))
            continue
        rewritten_description_binding = _entity_rewritten_source_description_binding(sentence, eligible)
        if rewritten_description_binding:
            sentence_ids.append(_unique_strings(item.get("id") for item in rewritten_description_binding))
            continue
        entity_subject_binding = _korean_entity_subject_binding(sentence, eligible)
        if entity_subject_binding:
            sentence_ids.append(_unique_strings(item.get("id") for item in entity_subject_binding))
            continue
        korean_benefit_records = _korean_entity_prefixed_benefit_records(sentence, eligible)
        if korean_benefit_records:
            sentence_ids.append(_unique_strings(item.get("id") for item in korean_benefit_records))
            continue
        page_offer_records = _renderer_page_offer_records(sentence, eligible)
        if page_offer_records:
            sentence_ids.append(_unique_strings(item.get("id") for item in page_offer_records))
            continue
        page_scope_product_records = _page_scope_product_sentence_records(sentence, eligible, roles)
        if page_scope_product_records:
            sentence_ids.append(_unique_strings(item.get("id") for item in page_scope_product_records))
            continue
        anchored_source_records = _product_anchored_source_records(sentence, eligible, roles)
        if anchored_source_records:
            sentence_ids.append(_unique_strings(item.get("id") for item in anchored_source_records))
            continue
        description_binding = _english_entity_prefixed_description_binding(sentence, eligible)
        if description_binding:
            sentence_ids.append(_unique_strings(item.get("id") for item in description_binding))
            continue
        audience_relation_records = _english_explicit_audience_relation_binding(sentence, eligible)
        if audience_relation_records:
            sentence_ids.append(_unique_strings(item.get("id") for item in audience_relation_records))
            continue
        korean_audience_relation_records = _korean_explicit_audience_relation_binding(sentence, eligible)
        if korean_audience_relation_records:
            sentence_ids.append(_unique_strings(item.get("id") for item in korean_audience_relation_records))
            continue
        korean_entity_ingredient_records = _korean_entity_prefixed_ingredient_records(sentence, eligible)
        if korean_entity_ingredient_records:
            sentence_ids.append(_unique_strings(item.get("id") for item in korean_entity_ingredient_records))
            continue
        solution_relation_records = _english_entity_prefixed_solution_relation_binding(sentence, eligible)
        if solution_relation_records:
            sentence_ids.append(_unique_strings(item.get("id") for item in solution_relation_records))
            continue
        source_role_records = _renderer_source_role_records(
            sentence,
            eligible,
            preceding_sentence=rendered_sentences[index - 1] if index else "",
        )
        if source_role_records:
            sentence_ids.append(_unique_strings(item.get("id") for item in source_role_records))
            continue
        normalized_sentence = _normalize_evidence(sentence)
        if not _sentence_assertion_frame_is_supported(sentence, eligible):
            sentence_ids.append([])
            continue
        matches: list[Mapping[str, Any]] = []
        for item in eligible:
            if _source_backed_positive_review_frame_record_is_relevant(sentence, item, eligible):
                matches.append(item)
                continue
            candidate_text = clean_text(item.get("text"))
            candidate = _normalize_evidence(candidate_text)
            minimum_length = 2 if re.search(r"[가-힣ぁ-んァ-ン一-龯]", candidate) else 3
            if len(candidate) < minimum_length:
                continue
            exact_sentence = any(_normalize_evidence(row) == normalized_sentence for row in _sentences(candidate_text))
            role = clean_text(item.get("role"))
            if _source_role_question_accepts_evidence(sentence, role):
                matches.append(item)
                continue
            if role in {"source", "description"}:
                if not exact_sentence:
                    if _english_entity_prefixed_audience_source_is_relevant(sentence, item, eligible):
                        matches.append(item)
                        continue
                    if _is_korean_entity_prefixed_description_suffix(sentence, item):
                        matches.append(item)
                        continue
                    if _evidence_record_supports_claim(sentence, item):
                        matches.append(item)
                        continue
                    if len(candidate) < 24 or _evidence_scope_mismatch(sentence, candidate_text):
                        continue
                    if not (
                        _evidence_token_coverage(candidate_text, sentence) >= 0.7
                        or _evidence_token_coverage(sentence, candidate_text) >= 0.7
                        or any(
                            len(_normalize_evidence(row)) >= 24
                            and not _evidence_scope_mismatch(sentence, row)
                            and _evidence_token_coverage(sentence, row) >= 0.7
                            for row in _sentences(candidate_text)
                        )
                    ):
                        continue
            elif role == "review" and not re.search(r"\b(?:review|reviews|customer feedback)\b|(?:고객\s*)?(?:리뷰|후기)", sentence, re.I):
                continue
            elif (
                candidate != normalized_sentence
                and not exact_sentence
                and candidate not in normalized_sentence
                and not _evidence_record_supports_claim(sentence, item)
                and not _commerce_listing_is_directly_source_backed(sentence, item)
            ):
                continue
            matches.append(item)
        relevant = [
            item
            for item in matches
            if _evidence_record_is_relevant_to_sentence(sentence, item)
            or _source_backed_positive_review_frame_record_is_relevant(sentence, item, matches)
        ]
        relevant.extend(
            item
            for item in matches
            if _english_entity_prefixed_audience_source_is_relevant(sentence, item, matches)
            and item not in relevant
        )
        relevant.extend(
            item
            for item in matches
            if _english_entity_prefixed_audience_identity_is_relevant(sentence, item, matches)
            and item not in relevant
        )
        relevant.extend(
            item
            for item in matches
            if _korean_description_suffix_identity_is_relevant(sentence, item, matches)
            and item not in relevant
        )
        relevant.extend(
            item
            for item in _direct_assertion_frame_relevant_evidence(sentence, matches)
            if item not in relevant
        )
        relevant.extend(
            item
            for item in matches
            if _neutral_review_bridge_identity_is_relevant(sentence, item, matches)
            and item not in relevant
        )
        relevant.extend(
            item for item in _sentence_named_identity_records(sentence, eligible) if item not in relevant
        )
        bound = (
            _unique_strings(item.get("id") for item in relevant)
            if sentence_evidence_has_direct_claim_support(sentence, relevant)
            else []
        )
        if not bound:
            # Every rung above recognizes a sentence by its shape, so a natural
            # sentence that no renderer was written to produce binds to nothing
            # and is then rejected for having no provenance -- not for having no
            # source.  What makes public copy publishable is the product's own
            # typed information: what it contains, what it does, who it is for,
            # what was measured, what customers said.  A sentence that states
            # those atoms is stating those product facts, in any locale and in
            # whatever shape reads naturally, and it is admitted here only if
            # the same direct-claim support that governs every rung above
            # accepts the atoms it states.
            typed = _typed_source_atom_records(sentence, eligible)
            if typed and sentence_evidence_has_direct_claim_support(sentence, typed):
                bound = _unique_strings(item.get("id") for item in typed)
        sentence_ids.append(bound)
    return {"evidenceIds": _unique_strings(identifier for ids in sentence_ids for identifier in ids), "sentenceEvidenceIds": sentence_ids}


# A role says what the product information called this atom, and an atom can
# carry a sentence only when the atom is itself the assertion.  A description,
# an audience, a concern, a measured result, an instruction, a customer's words
# -- each already states something about the product, so a sentence that states
# one is stating that.
#
# An ingredient or formula name is deliberately absent.  A name asserts
# nothing: what a sentence claims about an ingredient is a relation to some
# outcome, and that relation has its own admission -- the extracted
# ingredient/benefit link.  Letting a sentence bind on an ingredient name alone
# would let "Ginseng completely removes wrinkles" rest on the word ``Ginseng``,
# which is why the relation, and not the name, is what must be established.
#
# A review atom is absent for the same reason.  It holds a customer's words,
# and what public copy claims about them is their sentiment and their scope --
# that customers noted this *positively*, that one quoted sentence is one
# customer's whole sentence.  Neither is in the words themselves, so
# "positively noted sticky texture" would launder a negative keyword by
# quoting it.  The review frames establish the sentiment and the scope.
_SELF_ASSERTING_EVIDENCE_ROLES = frozenset(
    {
        "description",
        "audience",
        "concern",
        "benefit",
        "effect",
        "metric",
        "usage",
    }
)


def _typed_source_atom_records(
    sentence: str, evidence: Sequence[Mapping[str, Any]]
) -> list[Mapping[str, Any]]:
    """Return the typed source atoms a sentence states, when it states nothing more.

    An atom carries the role the product information gave it, so a sentence
    that states a self-asserting atom is stating that product fact whatever
    grammar it uses.  Two conditions keep this from becoming a route around the
    evidence: a sentence states nothing by naming a product or an ingredient,
    so names alone do not bind it; and a recommendation, safety, or uncertainty
    modality must come from an atom that carries it, never from the sentence
    that frames them.
    """

    rendered = clean_text(sentence)
    if not rendered:
        return []
    stated = [
        item
        for item in evidence
        if (atom := clean_text(item.get("text"))) and source_phrase_matches(rendered, atom)
    ]
    if not {clean_text(item.get("role")) for item in stated} & _SELF_ASSERTING_EVIDENCE_ROLES:
        return []
    if _claim_modalities(rendered) and not any(
        _claim_modalities(clean_text(item.get("text"))) for item in stated
    ):
        return []
    return stated


def _sentence_named_identity_records(
    sentence: str, evidence: Sequence[Mapping[str, Any]]
) -> list[Mapping[str, Any]]:
    """Return the identity atoms a sentence calls by name.

    Narrowing evidence sentence by sentence is what keeps one sentence's claim
    from resting on another sentence's support, but an identity asserts
    nothing — it designates.  Where a sentence calls a name, that name's atom
    is the sentence's own evidence, and dropping it leaves the sentence unable
    to account for its own subject: the digits a name carries then read as an
    unsourced measurement.  Only the identity the sentence actually writes
    returns, so no efficacy, metric, or review atom crosses a sentence border.
    """

    return [item for item in evidence if _sentence_named_identity_is_relevant(sentence, item)]


def _sentence_named_identity_is_relevant(sentence: str, item: Mapping[str, Any]) -> bool:
    """Return whether a record is an identity the sentence calls by name."""

    return clean_text(item.get("role")) == "identity" and states_naming_surface(
        sentence, clean_text(item.get("text"))
    )


def select_rendered_sentence_evidence(
    text: str,
    ledger: Sequence[Mapping[str, Any]],
    roles: Sequence[str],
) -> RenderedSentenceEvidence:
    """Select complete sentence-level evidence without exposing proofreader internals to renderers."""

    return _rendered_sentence_evidence(text, ledger, roles)


def _renderer_page_usage_summary_records(
    sentence: str, evidence: Sequence[Mapping[str, Any]]
) -> list[Mapping[str, Any]]:
    """Bind the renderer's narrow page-coverage usage frame.

    A WebPage description may say that the page explains how to use a named
    product.  This does not repeat, summarize, or extend the procedure; it is
    only publishable when the named subject is fully covered by identity atoms
    and at least one concrete source usage atom exists.  The closed grammar
    keeps this exception from becoming a route for arbitrary page prose.
    """

    rendered = clean_text(sentence)
    match = (
        _ENGLISH_PAGE_USAGE_SUMMARY_FRAME.fullmatch(rendered)
        or _KOREAN_PAGE_USAGE_SUMMARY_FRAME.fullmatch(rendered)
        or _KOREAN_NATURAL_PAGE_USAGE_SUMMARY_FRAME.fullmatch(rendered)
    )
    if match is None:
        return []
    subject = clean_text(match.group("subject"))
    identity = [item for item in evidence if clean_text(item.get("role")) == "identity" and clean_text(item.get("text"))]
    usage = [item for item in evidence if clean_text(item.get("role")) == "usage" and clean_text(item.get("text"))]
    if not subject or not identity or not usage or not _identity_clause_is_covered(
        subject, [clean_text(item.get("text")) for item in identity]
    ):
        return []
    subject_identity = [
        item
        for item in identity
        if _identity_text_is_in_assertion_subject(clean_text(item.get("text")), subject)
    ]
    return [*subject_identity, *usage] if subject_identity else []


def _english_source_faq_usage_answer_binding(
    sentence: str, evidence: Sequence[Mapping[str, Any]]
) -> list[Mapping[str, Any]]:
    """Bind the first source instruction after a neutral, named FAQ directions label.

    A generic source heading such as ``How to use`` is not sufficiently useful
    public FAQ copy on its own. The renderer may turn it into ``Directions for
    Brand's Product: <first exact instruction>``. This recognizer permits only
    that closed wrapper, the source pair's first instruction sentence, and the
    structured product identity; later instruction sentences remain verbatim.
    """

    rendered = clean_text(sentence)
    match = re.fullmatch(r"Directions\s+for\s+(?P<subject>.+?):\s*(?P<instruction>.+)", rendered, re.IGNORECASE)
    for item in evidence:
        if clean_text(item.get("role")) != "faq" or not clean_text(item.get("sourcePath")):
            continue
        source_question, source_answer = _source_faq_question_answer(clean_text(item.get("text")))
        source_sentences = _sentences(source_answer)
        if not _is_generic_source_usage_question(source_question) or not source_sentences:
            continue
        if match is None:
            if any(_normalize_evidence(source) == _normalize_evidence(rendered) for source in source_sentences):
                return [item]
            continue
        identities = _english_entity_prefixed_audience_identity_records(clean_text(match.group("subject")), evidence)
        instruction = _normalize_evidence(match.group("instruction"))
        if identities and _normalize_evidence(source_sentences[0]) == instruction:
            return [*identities, item]
    return []


def _english_buyer_audience_question_binding(
    sentence: str, evidence: Sequence[Mapping[str, Any]]
) -> list[Mapping[str, Any]]:
    """Bind the renderer's named audience question to one direct audience atom.

    This is intentionally narrower than the generic FAQ-role matcher.  A
    question such as ``What should people with dry skin know about Brand's
    Product?`` is useful decision copy, but accepting every ``source`` record
    for the word ``people`` would allow unrelated metric or formula evidence
    to become its provenance.  The closed grammar below accepts only the
    deterministic buyer-question frame, its exact structured identity, and a
    single source/description/audience record that names the same target.
    """

    rendered = clean_text(sentence)
    direct_relation = re.fullmatch(
        r"Who\s+(?:is|was)\s+(?P<subject>.+?)\s+(?P<relation>best\s+for|intended\s+for|"
        r"suitable\s+for|designed\s+for|formulated\s+for|developed\s+for|created\s+for|made\s+for|for)[?？]",
        rendered,
        re.IGNORECASE,
    )
    # The closed audience-question frame below verifies the exact source
    # relation before binding it.  ``suitable for`` is therefore safe to
    # preserve when it is directly stated, rather than being discarded merely
    # because it is a suitability modality.
    if direct_relation is not None and not _numeric_tokens(rendered):
        subject = clean_text(direct_relation.group("subject"))
        relation = clean_text(direct_relation.group("relation")).casefold()
        identities = _english_entity_prefixed_audience_identity_records(subject, evidence)
        if not identities:
            return []
        expected_source_relation = {
            "best for": "works best for",
            "intended for": "intended for",
            "suitable for": "suitable for",
            "designed for": "designed for",
            "formulated for": "formulated for",
            "developed for": "developed for",
            "created for": "created for",
            "made for": "made for",
            "for": "",
        }[relation]
        for role in ("audience", "description", "source", "faq"):
            for item in evidence:
                if clean_text(item.get("role")) != role:
                    continue
                source = clean_text(item.get("text"))
                direct_source_relation = bool(
                    re.search(
                        r"\b(?:works?\s+best|intended|suitable|designed|formulated|developed|created|made)\s+for\b|"
                        r"\b(?:is|are|was|were)\s+for\s+[A-Za-z]|"
                        r"^[A-Z][A-Za-z0-9'&/-]*(?:\s+[A-Z][A-Za-z0-9'&/-]*){0,8}\s+for\s+[a-z]",
                        source,
                        re.IGNORECASE,
                    )
                )
                if not (
                    direct_source_relation
                    if not expected_source_relation
                    else re.search(rf"\b{re.escape(expected_source_relation)}\b", source, re.IGNORECASE)
                ):
                    continue
                if role == "audience" or any(
                    contains_entity_identity_phrase(source, clean_text(identity.get("text")))
                    for identity in identities
                    if clean_text(identity.get("text"))
                ):
                    return [*identities, item]
        return []

    match = re.fullmatch(
        r"What\s+should\s+(?:people|customers)\s+with\s+(?P<target>[^?？]+?)\s+"
        r"(?:know|consider)\s+about\s+(?P<subject>.+?)[?？]",
        rendered,
        re.IGNORECASE,
    )
    if match is None or _numeric_tokens(rendered) or _claim_modalities(rendered):
        return []
    target = _normalized_audience_relation_target(match.group("target"))
    subject = clean_text(match.group("subject"))
    identities = _english_entity_prefixed_audience_identity_records(subject, evidence)
    if not target or not identities:
        return []

    role_order = ("audience", "description", "source", "faq")
    for role in role_order:
        for item in evidence:
            if clean_text(item.get("role")) != role:
                continue
            if _english_buyer_audience_target_is_directly_stated(clean_text(item.get("text")), target, role):
                return [*identities, item]
    return []


def _english_customer_concern_question_binding(
    sentence: str, evidence: Sequence[Mapping[str, Any]]
) -> list[Mapping[str, Any]]:
    """Bind the renderer's buyer-facing concern question to one direct concern atom.

    The fallback may restate a terse source fragment such as ``A solution for
    fine lines`` as ``What does Brand's Product offer for fine lines?``.  That
    is a question, not a new efficacy conclusion, but it still needs the exact
    structured identity and the original ``solution for`` relationship.  Keep
    the grammar closed so a nearby benefit or formula record cannot prove an
    unrelated customer question.
    """

    rendered = clean_text(sentence)
    match = re.fullmatch(
        r"What\s+does\s+(?P<subject>.+?)\s+offer\s+for\s+(?P<detail>[^?？]+?)[?？]",
        rendered,
        re.IGNORECASE,
    )
    if match is None or _numeric_tokens(rendered) or _claim_modalities(rendered):
        return []
    identities = _english_entity_prefixed_audience_identity_records(clean_text(match.group("subject")), evidence)
    detail = _normalized_audience_relation_target(match.group("detail"))
    if not identities or not detail:
        return []
    for role in ("audience", "description", "source", "benefit", "effect", "faq"):
        for item in evidence:
            if clean_text(item.get("role")) != role:
                continue
            source = clean_text(item.get("text"))
            source_match = re.fullmatch(
                r"(?:a\s+)?solution\s+for\s+(?P<detail>[^.!?。！？]+)[.!?。！？]?",
                source,
                re.IGNORECASE,
            )
            if source_match is not None and _normalized_audience_relation_target(source_match.group("detail")) == detail:
                return [*identities, item]
    return []


def _english_buyer_audience_target_is_directly_stated(source: str, target: str, role: str) -> bool:
    """Keep a buyer-question target tied to the exact source audience phrase."""

    rendered = clean_text(source)
    normalized_source = _normalized_audience_relation_target(rendered)
    if not rendered or not normalized_source:
        return False
    if role == "audience" and normalized_source == target:
        return True
    target_pattern = re.escape(target).replace(r"\ ", r"\s+")
    return re.search(
        rf"\b(?:for|with)\s+(?:customers?\s+with\s+)?{target_pattern}(?=\s|[,.;:!?。！？]|$)",
        rendered,
        re.IGNORECASE,
    ) is not None


def _english_entity_prefixed_benefit_binding(
    sentence: str,
    evidence: Sequence[Mapping[str, Any]],
) -> list[Mapping[str, Any]]:
    """Bind a product label to one typed source benefit without verb guessing.

    The renderer may make a subject-elliptical source fact independently
    quotable by adding only the structured brand/product label: ``Adds
    lightweight volume`` becomes ``Aero Comb from Neo adds lightweight
    volume``.  This is an identity-only transformation, not a new benefit
    inference, so compare the complete resulting sentence to the original
    typed benefit/effect atom instead of maintaining a fragile verb list.
    """

    rendered = clean_text(sentence)
    if not rendered or "?" in rendered or re.search(r"[가-힣]", rendered):
        return []
    label_match = re.fullmatch(
        r"The\s+stated\s+benefits\s+of\s+(?P<subject>.+?)\s+include\s+(?P<benefit>.+?)[.!?。！？]?",
        rendered,
        re.IGNORECASE,
    )
    if label_match is not None:
        identities = _english_entity_prefixed_audience_identity_records(
            clean_text(label_match.group("subject")), evidence
        )
        benefit = clean_text(label_match.group("benefit"))
        if identities and benefit:
            for item in evidence:
                if clean_text(item.get("role")) not in {"benefit", "effect"} or not clean_text(item.get("sourcePath")):
                    continue
                if any(
                    _normalize_evidence(source) == _normalize_evidence(benefit)
                    for source in _sentences(clean_text(item.get("text"))) or [clean_text(item.get("text"))]
                ):
                    return [*identities, item]
    identities = [item for item in evidence if clean_text(item.get("role")) == "identity" and clean_text(item.get("text"))]
    products = [
        item
        for item in identities
        if clean_text(item.get("sourcePath")).endswith(("product.name", "product.originalName"))
    ]
    brands = [item for item in identities if clean_text(item.get("sourcePath")).endswith("product.brand")]
    for item in evidence:
        if clean_text(item.get("role")) not in {"benefit", "effect"} or not clean_text(item.get("sourcePath")):
            continue
        for source in _sentences(clean_text(item.get("text"))) or [clean_text(item.get("text"))]:
            if not source:
                continue
            for product in products:
                product_text = clean_text(product.get("text"))
                candidates: list[tuple[str, list[Mapping[str, Any]]]] = [(product_text, [product])]
                for brand in brands:
                    brand_text = clean_text(brand.get("text"))
                    if not brand_text or contains_entity_identity_phrase(product_text, brand_text):
                        continue
                    candidates.extend(
                        (
                            (f"{product_text} from {brand_text}", [product, brand]),
                            (f"{brand_text}'s {product_text}", [brand, product]),
                            (f"{brand_text} {product_text}", [brand, product]),
                        )
                    )
                named_source = re.match(rf"{re.escape(product_text)}(?=\s|[,.;:!?]|$)", source, re.IGNORECASE)
                deictic = english_deictic_self_reference(source)
                for subject, subject_records in candidates:
                    expectations = [
                        f"{subject}{source[named_source.end():]}"
                        if named_source is not None
                        else f"{subject} {source[:1].lower()}{source[1:]}"
                    ]
                    if deictic is not None:
                        # The source points at its own product and the renderer
                        # names it.  Same claim, same entity, same atom.
                        expectations.append(f"{subject} {source[deictic.end():]}")
                    if any(
                        _normalize_evidence(expected) == _normalize_evidence(rendered)
                        for expected in expectations
                    ):
                        return [*subject_records, item]
    return []


# A page writes about its own product, and the roles below file sentences the
# page states about that product.  A review records a customer's words and a
# metric a measurement's, so neither may be restated with the product as its
# speaker; those roles stay out of this frame.
_KOREAN_ENTITY_SUBJECT_ROLES = frozenset({"description", "source", "benefit", "effect", "audience", "ingredient"})


# A price and the options it is sold in are one offer, so the renderer states
# them in one sentence when the page carries both, and in one clause each when
# it carries only one.  All three shapes bind to the same commerce atoms.
_KOREAN_PAGE_OFFER_FRAME = re.compile(
    r"^(?P<subject>.+?)(?:은|는)\s+(?P<price>[\d,]+)\s*(?:원|円|[A-Z]{3})에\s*판매되며,\s*"
    r"(?P<options>.+?)\s*옵션으로\s*구성되어\s*있습니다[.。！？!?]?$"
)
_ENGLISH_PAGE_OFFER_FRAME = re.compile(
    r"^(?P<subject>.+?)\s+is\s+listed\s+at\s+\D*(?P<price>[\d,.]+)\s*(?:[A-Z]{3})?"
    r"\s+and\s+offered\s+in\s+(?P<options>.+?)\.$",
    re.I,
)
_KOREAN_PAGE_PRICE_FRAME = re.compile(
    r"^(?P<subject>.+?)(?:은|는)\s+(?P<price>[\d,]+)\s*(?:원|円|[A-Z]{3})에\s*판매됩니다[.。！？!?]?$"
)
_ENGLISH_PAGE_PRICE_FRAME = re.compile(r"^(?P<subject>.+?)\s+is\s+listed\s+at\s+\D*(?P<price>[\d,.]+)\s*(?:[A-Z]{3})?\.$", re.I)
_KOREAN_PAGE_OPTIONS_FRAME = re.compile(
    r"^(?P<subject>.+?)(?:은|는)\s+(?P<options>.+?)\s*옵션으로\s*(?:구성되어\s*있습니다|판매됩니다)[.。！？!?]?$"
)
_ENGLISH_PAGE_OPTIONS_FRAME = re.compile(r"^(?P<subject>.+?)\s+is\s+offered\s+in\s+(?P<options>.+?)\.$", re.I)
_PRICE_SOURCE_PATH = "product.price.raw"
_OPTION_SOURCE_PATH = re.compile(r"^product\.options\[\d+\]$")


def _page_price_atom(price: str, evidence: Sequence[Mapping[str, Any]]) -> Mapping[str, Any] | None:
    """Return the recorded price atom a rendered figure equals."""

    amount = _review_frame_number(price.replace(",", ""))
    if amount is None:
        return None
    for item in evidence:
        if clean_text(item.get("role")) != "commerce" or clean_text(item.get("sourcePath")) != _PRICE_SOURCE_PATH:
            continue
        if _review_frame_number(clean_text(item.get("text"))) == amount:
            return item
    return None


def _page_option_atoms(options: str, evidence: Sequence[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    """Return the recorded option atoms a rendered list names, and nothing else."""

    listed = clean_text(options)
    if not listed:
        return []
    matched: list[Mapping[str, Any]] = []
    remaining = listed
    for item in sorted(
        (
            item
            for item in evidence
            if clean_text(item.get("role")) == "commerce"
            and _OPTION_SOURCE_PATH.fullmatch(clean_text(item.get("sourcePath"))) is not None
            and clean_text(item.get("text"))
        ),
        key=lambda item: len(clean_text(item.get("text"))),
        reverse=True,
    ):
        option = clean_text(item.get("text"))
        if option in remaining:
            remaining = remaining.replace(option, " ")
            matched.append(item)
    if not matched or _substantive_tokens(remaining):
        return []
    return matched


# A page description states who the product is for, what it carries, and what
# that does as one chained sentence.  Each clause is optional and they keep this
# order, and the frame requires at least one of the two chaining clauses so that
# an ordinary "{subject}은 {predicate}" sentence cannot match it.
_KOREAN_PAGE_SCOPE_PRODUCT_FRAME = re.compile(
    r"^(?P<subject>.+?)(?P<topic>은|는)\s+"
    r"(?:(?P<audience>.+?)(?P<audience_particle>을|를)\s*위한\s*(?P<type>[^\s,]+?)(?:으로|로),\s*)?"
    r"(?:(?P<items>.+?)\s*등을\s*주요\s*성분·기술로\s*포함하고\s*)?"
    r"(?P<closing>\S.*?)$"
)
# An ingredient list is itself comma-and-``and`` joined, so the composition
# group is read greedily and the closing is what the pattern anchors on: the
# last ``to support`` or the trailing verb phrase, not the list's own ``and``.
# The shapes are tried in order, longest closing first.
_ENGLISH_PAGE_SCOPE_PRODUCT_FRAMES = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"^(?P<subject>.+?)\s+is\s+a[n]?\s+(?P<type>.+?)(?:\s+for\s+(?P<audience>.+?))?"
        r",\s*formulated\s+with\s+(?P<items>.+)\s+to\s+support\s+(?P<benefit>.+?)\.$",
        r"^(?P<subject>.+?)\s+is\s+a[n]?\s+(?P<type>.+?)(?:\s+for\s+(?P<audience>.+?))?"
        r",\s*formulated\s+with\s+(?P<items>.+)\s+that\s+(?P<supports>[a-z]+s\b.+?)\.$",
        r"^(?P<subject>.+?)\s+is\s+a[n]?\s+(?P<type>.+?)(?:\s+for\s+(?P<audience>.+?))?"
        r",\s*formulated\s+with\s+(?P<items>.+?)\.$",
    )
)
# Where the audience is already published the chain opens on the composition,
# so the same sentence takes a second shape with no category clause in it.
_ENGLISH_PAGE_SCOPE_FORMULA_FRAMES = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"^(?P<subject>.+?)\s+is\s+formulated\s+with\s+(?P<items>.+)\s+to\s+support\s+(?P<benefit>.+?)\.$",
        r"^(?P<subject>.+?)\s+is\s+formulated\s+with\s+(?P<items>.+)\s+and\s+(?P<supports>[a-z]+s\b.+?)\.$",
        r"^(?P<subject>.+?)\s+is\s+formulated\s+with\s+(?P<items>.+?)\.$",
    )
)


def _first_frame_match(frames: Sequence[re.Pattern[str]], value: str) -> re.Match[str] | None:
    return next((match for frame in frames if (match := frame.fullmatch(value)) is not None), None)


def _optional_group(match: re.Match[str], name: str) -> str:
    return clean_text(match.groupdict().get(name) or "")


# An ingredient account can be published as the account of the product whose
# page prints it.  The product then sits in the slot each locale uses for where
# something is, and the rest of the sentence is the page's own.
_KOREAN_PRODUCT_ANCHORED_SOURCE_FRAME = re.compile(r"^(?P<subject>.+?)에\s*담긴\s+(?P<rest>\S.+)$")
_ENGLISH_PRODUCT_ANCHORED_SOURCE_FRAME = re.compile(r"^In\s+(?P<subject>[^,]+),\s+(?P<rest>\S.+)$")


def _product_anchored_source_records(
    sentence: str, evidence: Sequence[Mapping[str, Any]], roles: Sequence[str]
) -> list[Mapping[str, Any]]:
    """Bind an ingredient account published as this product's own.

    The anchor names the product and states nothing else, so the sentence
    proves no more than the identity that names it plus whatever the rest of
    the sentence proves on its own.  A rest that cannot be bound as a sentence
    fails the whole sentence, exactly as a chained clause does.
    """

    rendered = clean_text(sentence)
    match = _KOREAN_PRODUCT_ANCHORED_SOURCE_FRAME.fullmatch(
        rendered
    ) or _ENGLISH_PRODUCT_ANCHORED_SOURCE_FRAME.fullmatch(rendered)
    if match is None:
        return []
    identity = _review_frame_identity_records(
        clean_text(match.group("subject")), evidence, allow_brand_product=True
    )
    if not identity:
        return []
    selected = _rendered_sentence_evidence(clean_text(match.group("rest")), evidence, roles)
    ids = selected["sentenceEvidenceIds"][0] if selected["sentenceEvidenceIds"] else []
    if not ids:
        return []
    bound = set(ids)
    return _unique_evidence_records(
        [*identity, *[item for item in evidence if clean_text(item.get("id")) in bound]]
    )


def _page_scope_product_sentence_records(
    sentence: str,
    evidence: Sequence[Mapping[str, Any]],
    roles: Sequence[str],
) -> list[Mapping[str, Any]]:
    """Bind a chained page-scope sentence to exactly what its clauses bind to.

    The sentence is the standalone sentences for its facts joined into one, so
    its evidence is theirs: each clause is written back out as the sentence the
    renderer would otherwise have produced, that sentence is bound the way any
    sentence is, and the union is the chained sentence's provenance.  A clause
    that cannot be bound on its own fails the whole sentence, so chaining
    proves no more than stating the facts separately would.
    """

    clauses = _korean_page_scope_product_clauses(sentence) or _english_page_scope_product_clauses(sentence)
    if not clauses:
        return []
    records: list[Mapping[str, Any]] = []
    for candidates in clauses:
        # One fact has more than one sentence the renderer could have written
        # it as -- a benefit is stated as something the product does or as one
        # of its stated benefits -- so the clause is bound if any of those
        # sentences binds.  The clause still has to bind as some sentence, so
        # chaining proves no more than stating it separately would.
        bound: list[str] = []
        for candidate in candidates:
            selected = _rendered_sentence_evidence(candidate, evidence, roles)
            ids = selected["sentenceEvidenceIds"][0] if selected["sentenceEvidenceIds"] else []
            if ids:
                bound = list(ids)
                break
        if not bound:
            return []
        records.extend(item for item in evidence if clean_text(item.get("id")) in set(bound))
    return _unique_evidence_records(records)


def _unique_evidence_records(records: Sequence[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    seen: set[str] = set()
    unique: list[Mapping[str, Any]] = []
    for item in records:
        identifier = clean_text(item.get("id"))
        if identifier and identifier not in seen:
            seen.add(identifier)
            unique.append(item)
    return unique


def _korean_page_scope_product_clauses(sentence: str) -> list[list[str]]:
    """Write a chained Korean page sentence back out as its standalone sentences."""

    match = _KOREAN_PAGE_SCOPE_PRODUCT_FRAME.fullmatch(clean_text(sentence))
    if match is None or not (match.group("items") or (match.group("audience") and match.group("type"))):
        return []
    subject = f"{clean_text(match.group('subject'))}{match.group('topic')}"
    clauses: list[list[str]] = []
    if match.group("audience") and match.group("type"):
        audience = clean_text(match.group("audience"))
        clauses.append(
            [f"{subject} {audience}{match.group('audience_particle')} 위한 {clean_text(match.group('type'))}입니다."]
        )
    if match.group("items"):
        clauses.append([f"{subject} {clean_text(match.group('items'))} 등을 주요 성분·기술로 함유하고 있습니다."])
    closing = clean_text(match.group("closing"))
    if closing:
        clauses.append([f"{subject} {closing}"])
    return clauses


def _english_benefit_clause_candidates(subject: str, benefit: str) -> list[str]:
    """Return the sentences an English benefit fact is written as."""

    if not benefit:
        return []
    return [
        f"{subject} {benefit}.",
        f"{subject} supports {benefit}.",
        f"The stated benefits of {subject} include {benefit}.",
    ]


def _english_page_scope_product_clauses(sentence: str) -> list[list[str]]:
    """Write a chained English page sentence back out as its standalone sentences."""

    rendered = clean_text(sentence)
    formula_only = _first_frame_match(_ENGLISH_PAGE_SCOPE_FORMULA_FRAMES, rendered)
    if formula_only is not None:
        subject = clean_text(formula_only.group("subject"))
        clauses = [[f"{subject} includes {clean_text(formula_only.group('items'))}."]]
        benefit = _optional_group(formula_only, "benefit") or _optional_group(formula_only, "supports")
        candidates = _english_benefit_clause_candidates(subject, benefit)
        if candidates:
            clauses.append(candidates)
        return clauses
    # The composition clause is what makes this the chained sentence.  Without
    # it, "X is a serum for dry skin." is an ordinary sentence every rung above
    # already handles, and treating it as a chain would send it back through
    # binding as itself.
    match = _first_frame_match(_ENGLISH_PAGE_SCOPE_PRODUCT_FRAMES, rendered)
    if match is None:
        return []
    subject = clean_text(match.group("subject"))
    product_type = clean_text(match.group("type"))
    audience = _optional_group(match, "audience")
    clauses = [
        [f"{subject} is a {product_type} for {audience}." if audience else f"{subject} is a {product_type}."],
        [f"{subject} includes {clean_text(match.group('items'))}."],
    ]
    benefit = _optional_group(match, "benefit") or _optional_group(match, "supports")
    candidates = _english_benefit_clause_candidates(subject, benefit)
    if candidates:
        clauses.append(candidates)
    return clauses


def _renderer_page_offer_records(
    sentence: str,
    evidence: Sequence[Mapping[str, Any]],
) -> list[Mapping[str, Any]]:
    """Bind the page-scope offer frames to the commerce atoms they publish.

    A page description states what is on sale on the page: its price and the
    options it lists.  Both frames are closed -- the subject resolves to the
    product's identity records, the figure has to equal the recorded price, and
    every option named has to be one the page records, with nothing else in the
    list.  Neither frame can turn a commerce atom into a claim about the
    product, because neither says anything about the product but its offer.
    """

    rendered = clean_text(sentence)
    offer_match = _KOREAN_PAGE_OFFER_FRAME.fullmatch(rendered) or _ENGLISH_PAGE_OFFER_FRAME.fullmatch(rendered)
    if offer_match is not None:
        identity = _review_frame_identity_records(
            clean_text(offer_match.group("subject")), evidence, allow_brand_product=True
        )
        price_atom = _page_price_atom(offer_match.group("price"), evidence)
        option_atoms = _page_option_atoms(offer_match.group("options"), evidence)
        if not identity or price_atom is None or not option_atoms:
            return []
        return [*identity, price_atom, *option_atoms]
    price_match = _KOREAN_PAGE_PRICE_FRAME.fullmatch(rendered) or _ENGLISH_PAGE_PRICE_FRAME.fullmatch(rendered)
    if price_match is not None:
        identity = _review_frame_identity_records(
            clean_text(price_match.group("subject")), evidence, allow_brand_product=True
        )
        price_atom = _page_price_atom(price_match.group("price"), evidence)
        return [*identity, price_atom] if identity and price_atom is not None else []
    options_match = _KOREAN_PAGE_OPTIONS_FRAME.fullmatch(rendered) or _ENGLISH_PAGE_OPTIONS_FRAME.fullmatch(rendered)
    if options_match is None:
        return []
    identity = _review_frame_identity_records(
        clean_text(options_match.group("subject")), evidence, allow_brand_product=True
    )
    option_atoms = _page_option_atoms(options_match.group("options"), evidence)
    return [*identity, *option_atoms] if identity and option_atoms else []


# The renderer closes a benefit on whichever predicate the atom leaves open: an
# outcome the product helps with takes ``돕습니다``, an atom that already names
# an act of helping takes that noun's own light verb, and a nominalized
# predicate is conjugated.  All three state the same atom, so the frame reads
# the atom and not the ending.
_KOREAN_ENTITY_BENEFIT_FRAME = re.compile(
    r"^(?P<subject>.+?)(?:은|는)\s+(?P<benefit>.+?)\s*(?:(?:을|를)\s*(?:돕습니다|줍니다)|(?P<nominalized>합니다|됩니다))[.。！？!?]?$"
)


def _korean_entity_prefixed_benefit_records(
    sentence: str,
    evidence: Sequence[Mapping[str, Any]],
) -> list[Mapping[str, Any]]:
    """Bind the renderer's Korean benefit frame to one typed benefit atom.

    A catalog benefit is a bare noun phrase.  The renderer makes it quotable by
    naming the product it belongs to and stating it as something the product
    does for the reader.  That is an identity-only transformation of one atom,
    so the whole rendered sentence is compared back to that atom rather than to
    a list of verbs a benefit is allowed to take.
    """

    match = _KOREAN_ENTITY_BENEFIT_FRAME.fullmatch(clean_text(sentence))
    if match is None:
        return []
    identity = _review_frame_identity_records(
        clean_text(match.group("subject")), evidence, allow_brand_product=True
    )
    rendered = clean_text(match.group("benefit"))
    # A conjugated ending states the atom's own nominalized predicate, so the
    # atom is compared with that nominalizer restored rather than as if the
    # renderer had dropped a word.
    nominalizer = {"합니다": "함", "됩니다": "됨"}.get(clean_text(match.group("nominalized")), "")
    candidates = {_normalize_evidence(rendered)}
    if nominalizer:
        candidates.add(_normalize_evidence(f"{rendered} {nominalizer}"))
        candidates.add(_normalize_evidence(f"{rendered}{nominalizer}"))
    if not identity or not any(candidates):
        return []
    for item in evidence:
        if clean_text(item.get("role")) not in {"benefit", "effect"} or not clean_text(item.get("sourcePath")):
            continue
        if _normalize_evidence(clean_text(item.get("text"))) in candidates:
            return [*identity, item]
    return []


def _korean_entity_subject_binding(
    sentence: str,
    evidence: Sequence[Mapping[str, Any]],
) -> list[Mapping[str, Any]]:
    """Bind a subjectless source sentence published with the product as subject.

    Korean drops a subject that context supplies, and a product page supplies
    it: ``건조 피부 또는 민감 피부에 추천하는 클렌징 폼입니다`` states its
    predicate of the product whose page states it.  Naming the product makes
    that explicit and changes nothing else, so the published sentence binds to
    the same source record plus the identity records that supply the name.

    A source that names its own subject is excluded — prefixing a second
    subject there would assert of this product what the page asserted of
    something else.
    """

    rendered = clean_text(sentence)
    if not rendered or not re.search(r"[가-힣]", rendered):
        return []
    identities = [item for item in evidence if clean_text(item.get("role")) == "identity" and clean_text(item.get("text"))]
    products = [
        item
        for item in identities
        if clean_text(item.get("sourcePath")).endswith(("product.name", "product.originalName"))
    ]
    brands = [item for item in identities if clean_text(item.get("sourcePath")).endswith("product.brand")]
    for item in evidence:
        if clean_text(item.get("role")) not in _KOREAN_ENTITY_SUBJECT_ROLES or not clean_text(item.get("sourcePath")):
            continue
        for source in _sentences(clean_text(item.get("text"))) or [clean_text(item.get("text"))]:
            if not source:
                continue
            deictic = korean_deictic_self_reference(source)
            if deictic is not None:
                predicate = source[deictic.end() :]
            elif states_its_own_subject(source):
                continue
            else:
                predicate = source
            for product in products:
                candidates: list[tuple[str, list[Mapping[str, Any]]]] = []
                for product_text in _published_identity_surfaces(clean_text(product.get("text"))):
                    candidates.append((product_text, [product]))
                    for brand in brands:
                        brand_text = clean_text(brand.get("text"))
                        if not brand_text or contains_entity_identity_phrase(product_text, brand_text):
                            continue
                        candidates.append((f"{brand_text}의 {product_text}", [brand, product]))
                for subject, subject_records in candidates:
                    expected = f"{subject}{_korean_topic_particle(subject)} {predicate}"
                    if _normalize_evidence(expected) == _normalize_evidence(rendered):
                        return [*subject_records, item]
    return []


def _english_generic_subject_source_description_binding(
    sentence: str, evidence: Sequence[Mapping[str, Any]]
) -> list[Mapping[str, Any]]:
    """Bind a named entity to an exact source predicate with a generic product subject.

    Product pages often say ``This shampoo gently detangles wet hair`` or
    ``The cleanser is designed for swimmers``.  It also recognizes
    product-anaphoric ``formula`` and ``system`` subjects, including a small
    number of source modifiers such as ``This powerful formula``.  The
    renderer replaces only that generic subject with the structured
    brand/product label so an isolated schema sentence remains attributable.
    Keep the predicate byte-equivalent after the subject; this cannot approve
    a new benefit or suitability relation.
    """

    rendered = clean_text(sentence)
    if not rendered or _numeric_tokens(rendered):
        return []
    identities = [item for item in evidence if clean_text(item.get("role")) == "identity" and clean_text(item.get("text"))]
    category_records = [
        item for item in identities if clean_text(item.get("sourcePath")).endswith("product.category")
    ]
    products = [
        item
        for item in identities
        if clean_text(item.get("sourcePath")).endswith(("product.name", "product.originalName"))
    ]
    brands = [item for item in identities if clean_text(item.get("sourcePath")).endswith("product.brand")]
    category_heads = {
        _normalize_evidence(clean_text(item.get("text"))): [item]
        for item in category_records
        if _normalize_evidence(clean_text(item.get("text")))
    }
    generic_heads = {"product", "item", "formula", "system"}
    subject_heads = [*generic_heads, *category_heads]
    for source_record in evidence:
        if clean_text(source_record.get("role")) not in {"description", "source"} or not clean_text(
            source_record.get("sourcePath")
        ):
            continue
        for source in _sentences(clean_text(source_record.get("text"))) or [clean_text(source_record.get("text"))]:
            for source_head in subject_heads:
                match = re.match(
                    rf"(?:this|the)\s+(?:[A-Za-z0-9™®&+/'-]+\s+){{0,3}}{re.escape(source_head)}"
                    r"(?P<predicate>\s+.+)",
                    source,
                    re.IGNORECASE,
                )
                if match is None:
                    continue
                predicate = clean_text(match.group("predicate"))
                if not predicate:
                    continue
                matching_categories = category_heads.get(source_head, [])
                for product in products:
                    product_text = clean_text(product.get("text"))
                    candidates: list[tuple[str, list[Mapping[str, Any]]]] = [(product_text, [product])]
                    for brand in brands:
                        brand_text = clean_text(brand.get("text"))
                        if not brand_text or contains_entity_identity_phrase(product_text, brand_text):
                            continue
                        candidates.extend(
                            (
                                (f"{product_text} from {brand_text}", [product, brand]),
                                (f"{brand_text}'s {product_text}", [brand, product]),
                                (f"{brand_text} {product_text}", [brand, product]),
                            )
                        )
                    for subject, subject_ids in candidates:
                        if _normalize_evidence(f"{subject} {predicate}") == _normalize_evidence(rendered):
                            return [*subject_ids, *matching_categories, source_record]
    return []


def _source_faq_identity_question_binding(
    sentence: str, evidence: Sequence[Mapping[str, Any]]
) -> list[Mapping[str, Any]]:
    """Bind a source FAQ question after the renderer adds only product identity.

    Source FAQs often use a bare product name or a pronoun.  The renderer
    makes that question independently quotable by adding the structured brand
    and product name, while deliberately leaving the source answer unchanged.
    This recognizer admits only that identity-only transformation and returns
    the original FAQ pair plus the identity atoms; it never treats a nearby
    benefit, metric, or safety fact as proof of a rewritten question.
    """

    rendered = clean_text(sentence)
    if not rendered or _numeric_tokens(rendered):
        return []
    identity = [item for item in evidence if clean_text(item.get("role")) == "identity" and clean_text(item.get("text"))]
    brands = [item for item in identity if clean_text(item.get("sourcePath")).endswith("product.brand")]
    category_records = [
        item
        for item in identity
        if clean_text(item.get("sourcePath")).endswith("product.category") and clean_text(item.get("text"))
    ]
    category_names = tuple(clean_text(item.get("text")) for item in category_records)
    for faq in evidence:
        if clean_text(faq.get("role")) != "faq" or not clean_text(faq.get("sourcePath")):
            continue
        source_question = _source_faq_question_from_evidence_text(clean_text(faq.get("text")))
        if not source_question:
            continue
        products = [
            item
            for item in identity
            if clean_text(item.get("sourcePath")).endswith(("product.name", "product.originalName"))
        ]
        if not products:
            products = [
                item for item in identity if contains_entity_identity_phrase(source_question, clean_text(item.get("text")))
            ]
        for product in products:
            product_text = clean_text(product.get("text"))
            subjects: list[tuple[str, list[Mapping[str, Any]]]] = [(product_text, [product])]
            for brand in brands:
                brand_text = clean_text(brand.get("text"))
                if not brand_text or contains_entity_identity_phrase(product_text, brand_text):
                    continue
                subjects.insert(0, (f"{brand_text}'s {product_text}", [brand, product]))
                subjects.append((f"{brand_text} {product_text}", [brand, product]))
                subjects.append((f"{product_text} from {brand_text}", [brand, product]))
                subjects.append((f"{brand_text}의 {product_text}", [brand, product]))
            for subject, identities in subjects:
                category_binding = _source_faq_question_product_noun_binding(
                    source_question,
                    rendered,
                    subject,
                    category_records,
                )
                if category_binding:
                    return [*identities, *category_binding, faq]
                if _source_faq_question_has_identity_only_frame(
                    source_question,
                    rendered,
                    product_text,
                    subject,
                    category_names,
                ):
                    return [*identities, faq]
    return []


def _source_faq_question_from_evidence_text(value: str) -> str:
    """Recover only the source FAQ heading from a flattened ledger record."""

    text = clean_text(value)
    question_match = re.match(r"^(?P<question>.+?[?？])(?:\s+.*)?$", text)
    if question_match is not None:
        return clean_text(question_match.group("question"))
    question, answer = _source_faq_question_answer(text)
    return question if answer and _is_generic_source_usage_question(question) else ""


def _source_faq_question_has_identity_only_frame(
    source_question: str,
    rendered: str,
    product_name: str,
    subject: str,
    category_names: Sequence[str] = (),
) -> bool:
    """Accept a source question only when the change is its visible identity frame."""

    source = clean_text(source_question)
    if not source or not product_name or not subject or not contains_entity_identity_phrase(rendered, subject):
        return False
    normalized_rendered = _normalize_evidence(rendered)
    if _normalize_evidence(source) == normalized_rendered:
        return True
    if _is_generic_source_usage_question(source):
        return bool(
            re.fullmatch(rf"How\s+should\s+{re.escape(subject)}\s+be\s+used[?？]", rendered, re.IGNORECASE)
            or re.fullmatch(rf"{re.escape(subject)}(?:은|는)\s+어떻게\s+사용하나요[?？]", rendered)
        )
    replaced_product = re.sub(re.escape(product_name), subject, source, count=1, flags=re.IGNORECASE)
    if _normalize_evidence(replaced_product) == normalized_rendered:
        return True
    product_nouns = sorted(
        {clean_text(value) for value in (*category_names, "product", "item") if clean_text(value)},
        key=len,
        reverse=True,
    )
    if product_nouns:
        product_noun_pattern = "|".join(re.escape(value) for value in product_nouns)
        replaced_product_noun = re.sub(
            rf"^(?P<aux>(?:does|did|do|can|could|will|would|should|is|was|are|were)\s+)this\s+"
            rf"(?:(?:[A-Za-z][A-Za-z'-]*\s+){{0,3}})?(?:{product_noun_pattern})(?=\s|[,.;:!?]|$)",
            rf"\g<aux>{subject}",
            source,
            count=1,
            flags=re.IGNORECASE,
        )
        if _normalize_evidence(replaced_product_noun) == normalized_rendered:
            return True
    replaced_direct_question_pronoun = re.sub(
        r"^(?P<aux>(?:does|did|do|can|could|will|would|should|is|was|are|were)\s+)this\b",
        rf"\g<aux>{subject}",
        source,
        count=1,
        flags=re.IGNORECASE,
    )
    if _normalize_evidence(replaced_direct_question_pronoun) == normalized_rendered:
        return True
    replaced_pronoun = re.sub(
        r"\b(?:it|this\s+product|the\s+product|this(?=\s+(?:not\s+)?(?:reduce|improve|support|help|soothe|calm|provide|"
        r"offer|contain|include|work|address|target|protect|strengthen|restore|hydrate|moisturize)\b))\b",
        subject,
        source,
        count=1,
        flags=re.IGNORECASE,
    )
    if _normalize_evidence(replaced_pronoun) == normalized_rendered:
        return True
    source_field_question = re.fullmatch(
        r"What\s+does\s+.+?\s+(?:say|state|list|mention|show)\s+about\s+(?P<topic>.+?)[?？]",
        source,
        re.IGNORECASE,
    )
    if source_field_question is not None and re.search(re.escape(product_name), source, re.IGNORECASE):
        expected = f"What should customers know about {subject} in relation to {clean_text(source_field_question.group('topic'))}?"
        if _normalize_evidence(expected) == normalized_rendered:
            return True
    if re.search(r"[가-힣]", f"{source}{rendered}"):
        return re.fullmatch(rf"{re.escape(subject)}(?:은|는|이|가)\s+{re.escape(source)}", rendered) is not None
    return False


def _source_faq_question_product_noun_binding(
    source_question: str,
    rendered: str,
    subject: str,
    category_records: Sequence[Mapping[str, Any]],
) -> list[Mapping[str, Any]]:
    """Return the category atom when ``this <category>`` becomes an entity.

    This is deliberately separate from the general pronoun check because the
    category noun disappears from the rendered question.  Keeping that exact
    category record in provenance makes the transformation reproducible while
    still leaving a following verb (for example ``this detangle``) untouched.
    """

    source = clean_text(source_question)
    normalized_rendered = _normalize_evidence(rendered)
    for category in category_records:
        category_name = clean_text(category.get("text"))
        if not category_name:
            continue
        replaced = re.sub(
            rf"^(?P<aux>(?:does|did|do|can|could|will|would|should|is|was|are|were)\s+)this\s+"
            rf"(?:(?:[A-Za-z][A-Za-z'-]*\s+){{0,3}})?{re.escape(category_name)}(?=\s|[,.;:!?]|$)",
            rf"\g<aux>{subject}",
            source,
            count=1,
            flags=re.IGNORECASE,
        )
        if _normalize_evidence(replaced) == normalized_rendered:
            return [category]
    return []


def _source_faq_question_answer(value: str) -> tuple[str, str]:
    question, separator, answer = clean_text(value).partition("\n")
    if separator:
        return question, answer
    # Ledger text is normalized before it reaches the proofreader, so the
    # source FAQ pair's line break may already be a single space. Recover only
    # the fixed generic use headings used by the renderer's closed wrapper.
    inline = re.match(
        r"^(?P<question>how\s+to\s+use|how\s+do\s+i\s+use\s+it|directions?|usage)\s+(?P<answer>.+)$",
        question,
        re.IGNORECASE,
    )
    return (clean_text(inline.group("question")), clean_text(inline.group("answer"))) if inline is not None else (question, "")


def _is_generic_source_usage_question(value: str) -> bool:
    return " ".join(clean_text(value).casefold().split()) in {
        "how to use",
        "how do i use it",
        "directions",
        "direction",
        "usage",
    }


# A page overview can open on the customer the page is for instead of listing
# what the page contains.  It then states an audience and a product type, not a
# coverage list, so it binds to those atoms rather than to category labels.
_KOREAN_AUDIENCE_PAGE_OVERVIEW_FRAME = re.compile(
    r"^(?P<subject>.+?)\s*(?:상품|제품)\s*페이지는\s+"
    r"(?:(?P<brand>.+?)(?:이|가)\s*선보이는\s+)?"
    r"(?P<audience>.+?)(?:을|를)\s*위한\s*(?P<type>\S+?)\s*정보를\s*다룹니다[.!?。！？]?$"
)
_ENGLISH_AUDIENCE_PAGE_OVERVIEW_FRAME = re.compile(
    r"^The\s+product\s+page\s+for\s+(?P<subject>.+?)\s+introduces\s+an?\s+(?P<type>.+?)"
    r"\s+for\s+(?P<audience>.+?)\.$",
    re.IGNORECASE,
)
_PAGE_OVERVIEW_AUDIENCE_ROLES = frozenset({"audience", "concern", "description"})


def _audience_page_overview_records(
    sentence: str, evidence: Sequence[Mapping[str, Any]]
) -> list[Mapping[str, Any]]:
    """Bind an audience-led page overview to the identity and audience it names."""

    rendered = clean_text(sentence)
    match = _KOREAN_AUDIENCE_PAGE_OVERVIEW_FRAME.fullmatch(
        rendered
    ) or _ENGLISH_AUDIENCE_PAGE_OVERVIEW_FRAME.fullmatch(rendered)
    if match is None:
        return []
    subject = clean_text(match.group("subject"))
    brand = clean_text(match.groupdict().get("brand") or "")
    named = f"{brand} {subject}".strip() if brand else subject
    identity = [item for item in evidence if clean_text(item.get("role")) == "identity" and clean_text(item.get("text"))]
    if not named or not identity or not _identity_clause_is_covered(
        named, [clean_text(item.get("text")) for item in identity]
    ):
        return []
    selected = [
        item
        for item in identity
        if _identity_text_is_in_assertion_subject(clean_text(item.get("text")), named)
    ]
    audience = clean_text(match.group("audience"))
    stated = [
        item
        for item in evidence
        if clean_text(item.get("role")) in _PAGE_OVERVIEW_AUDIENCE_ROLES
        and (atom := clean_text(item.get("text")))
        and _audience_clause_states_atom(audience, atom)
    ]
    # A page need not have filed a typed audience for the customer it names.
    # Where the audience was read off the page's own sentence -- the only place
    # an English PDP often states it -- that sentence licenses the overview,
    # but only when it carries the customer contiguously, in the page's own
    # words.  Words merely scattered through a paragraph state no customer.
    if not stated:
        stated = [
            item
            for item in evidence
            if clean_text(item.get("role")) == "source"
            and (atom := clean_text(item.get("text")))
            and source_phrase_matches(atom, audience)
        ]
    return [*selected, *stated] if selected and stated else []


def _audience_stems(value: str) -> set[str]:
    return {
        strip_korean_inflection(token) if re.search(r"[가-힣]", token) else token.casefold()
        for token in re.findall(r"[A-Za-z]+|[가-힣]+", value)
    }


# The word the audience slot is headed by in this renderer's own frame, which a
# source sentence stating the same customer has no reason to carry.
_AUDIENCE_SLOT_HEADS = frozenset({"고객", "customer", "customers"})


def _audience_clause_states_atom(clause: str, atom: str) -> bool:
    """Return whether an audience clause names the customer this atom states.

    A page names the customer in the grammar its own sentence needs -- "건조
    피부 고객을 위한" -- where the source filed the adnominal it used, "건조한
    피부", or a whole sentence around it.  Comparing spellings counts an ending
    as a different customer, so the words are compared as the words they are,
    and either may be the shorter one: a filed audience phrase the clause names,
    or a source sentence that states what the clause names.  Every word has to
    be accounted for in the other, so neither can claim a customer the other
    never named.
    """

    if source_phrase_matches(clause, atom):
        return True
    clause_stems = _audience_stems(clause)
    atom_stems = _audience_stems(atom)
    if atom_stems and atom_stems <= clause_stems:
        return True
    named = clause_stems - _AUDIENCE_SLOT_HEADS
    return bool(named) and named <= atom_stems


def _renderer_page_overview_records(
    sentence: str, evidence: Sequence[Mapping[str, Any]]
) -> list[Mapping[str, Any]]:
    """Bind the renderer's closed page-scope overview to the named source categories."""

    rendered = clean_text(sentence)
    audience_led = _audience_page_overview_records(sentence, evidence)
    if audience_led:
        return audience_led
    english = _ENGLISH_PAGE_OVERVIEW_FRAME.fullmatch(rendered) or _ENGLISH_NATURAL_PAGE_OVERVIEW_FRAME.fullmatch(rendered)
    korean = _KOREAN_PAGE_OVERVIEW_FRAME.fullmatch(rendered) or _KOREAN_NATURAL_PAGE_OVERVIEW_FRAME.fullmatch(rendered)
    match = english or korean
    if match is None:
        return []
    role_map = _ENGLISH_PAGE_OVERVIEW_ROLES if english is not None else _KOREAN_PAGE_OVERVIEW_ROLES
    coverage = clean_text(match.group("coverage"))
    labels = _page_overview_labels(coverage, role_map, korean is not None)
    if labels is None:
        return []
    subject = clean_text(match.group("subject"))
    identity = [item for item in evidence if clean_text(item.get("role")) == "identity" and clean_text(item.get("text"))]
    if not subject or not identity or not _identity_clause_is_covered(
        subject, [clean_text(item.get("text")) for item in identity]
    ):
        return []
    selected = [
        item
        for item in identity
        if _identity_text_is_in_assertion_subject(clean_text(item.get("text")), subject)
    ]
    if not selected:
        return []
    selected_ids = {clean_text(item.get("id")) for item in selected}
    for label in labels:
        roles = role_map[label]
        record = next(
            (
                item
                for item in evidence
                if clean_text(item.get("role")) in roles
                and clean_text(item.get("text"))
                and _page_overview_label_has_direct_source_support(label, clean_text(item.get("text")), korean is not None)
            ),
            None,
        )
        if record is None:
            return []
        record_id = clean_text(record.get("id"))
        if record_id not in selected_ids:
            selected.append(record)
            selected_ids.add(record_id)
    return selected


def _page_overview_label_has_direct_source_support(label: str, source: str, korean: bool) -> bool:
    """Keep target/concern category labels tied to an explicit source relation, not role names alone."""

    if korean and label == "대상 고객":
        return re.search(
            r"(?:피부|고객).*(?:위한|대상|적합|특화|맞춤|추천|권장)|"
            r"(?:위한|대상|적합|특화|맞춤|추천|권장).*(?:피부|고객)",
            source,
        ) is not None
    if not korean and label == "who it is for":
        return re.search(
            r"\b(?:works?\s+best|intended|suitable|designed|formulated|developed|created|made)\s+for\b|"
            r"\b(?:for|with)\s+(?:[A-Za-z-]+\s+){1,4}skin(?:\s+types?)?\b",
            source,
            re.IGNORECASE,
        ) is not None
    if not korean and label == "skin concerns":
        return re.search(
            r"\b(?:a\s+)?solution\s+for\b|\b(?:fine\s+lines?|wrinkles?|loss\s+of\s+firmness|dryness)\b",
            source,
            re.IGNORECASE,
        ) is not None
    return True


def _page_overview_labels(
    coverage: str,
    role_map: Mapping[str, tuple[str, ...]],
    korean: bool,
) -> list[str] | None:
    """Accept only the renderer's fixed coverage labels, never arbitrary page prose."""

    if not coverage:
        return []
    separator = r"\s*,\s*|\s+및\s+" if korean else r"\s*,\s*(?:and\s+)?|\s+and\s+"
    labels = [clean_text(label).casefold() if not korean else clean_text(label) for label in re.split(separator, coverage)]
    if not labels or any(not label or label not in role_map for label in labels):
        return None
    return labels


def _substantive_tokens(value: str) -> list[str]:
    values: list[str] = []
    for raw in re.findall(r"[A-Za-z가-힣ぁ-んァ-ン一-龯][A-Za-z0-9가-힣ぁ-んァ-ン一-龯-]*", value):
        token = raw.casefold().strip("-")
        if not token:
            continue
        if re.search(r"[가-힣]", token):
            for suffix in (
                "이었습니다",
                "였습니다",
                "하였습니다",
                "되었습니다",
                "했습니다",
                "있습니다",
                "없습니다",
                "됩니다",
                "합니다",
                "입니다",
                "한다",
                "된다",
                "있다",
                "없다",
                "이다",
                "으로부터",
                "에게서는",
                "에서는",
                "으로",
                "에게",
                "께서",
                "까지",
                "부터",
                "처럼",
                "보다",
                "이라고",
                "라고",
                "이며",
                "이고",
                "하며",
                "하여",
                "하고",
                "되는",
                "하는",
                "된",
                "한",
                "에서",
                "에게",
                "으로",
                "은",
                "는",
                "이",
                "가",
                "을",
                "를",
                "와",
                "과",
                "의",
                "에",
                "로",
                "도",
                "만",
            ):
                if len(token) > len(suffix) + 1 and token.endswith(suffix):
                    token = token[: -len(suffix)]
                    break
            if len(token) < 2 or token in {"그리고", "또는", "하지만", "또한", "위"}:
                continue
        else:
            if token in _ENGLISH_PROOFREADING_STOP_WORDS:
                continue
            if len(token) > 5 and token.endswith("ies"):
                token = f"{token[:-3]}y"
            elif len(token) > 5 and token.endswith("ing"):
                token = token[:-3]
            elif len(token) > 4 and token.endswith("ed"):
                token = token[:-2]
            elif len(token) > 4 and token.endswith("es"):
                token = token[:-2]
            elif len(token) > 3 and token.endswith("s"):
                token = token[:-1]
            if len(token) < 2:
                continue
        if token not in values:
            values.append(token)
    return values


# The same frame, counted the way the answer readers count words.  A card
# records the ingredient as this product's, so an answer writing that
# containment states no fact the card does not already hold -- and charging
# it left the one shape the prompt asks for (``{product}에 담긴 {ingredient}은
# …``) unable to rest on the source that states the ingredient's own fact.
# Prepositions that place a fact without qualifying it.  A source writes the
# study group as ``among 32 women`` and an answer restating that group has to
# write the same relation, so charging the preposition itself left a sentence
# whose every other word the source carried unable to rest on it.
#
# This is read only where a FAQ answer is measured against the atoms its row
# cited.  The shared function-word class is what other surfaces decide with --
# ``names_a_thing`` reads it to tell a catalog name from a cut-off sentence --
# and widening it there changes what those publish, so the two stay separate.
# Only prepositions that add no limit belong here: ``over``, ``under``,
# ``within``, ``without``, ``about``, ``than``, ``between`` and ``per`` each
# state a bound or a polarity the source may not have, so they are charged.
_FAQ_PLACING_PREPOSITION = re.compile(
    r"\b(?:among|amongst|alongside|during|toward|towards|upon|via)\b", re.IGNORECASE
)
# The frame that attributes a term to the record itself.  ``is described as
# firming`` says the record carries ``firming``, which is what binding checks
# anyway, so the frame states nothing of its own while every word it
# introduces stays charged.
#
# It is read in position -- copula, participle, preposition -- and not as a
# word in a set.  A flat token set has no context: it would free ``described``
# wherever it stood, including where the answer uses it to assert.  And the
# shape may not be generalised to any participle either: ``tested as``,
# ``proven as`` and ``certified as`` each report that something was done to the
# product, and a record that files only the term (``저자극``,
# ``hypoallergenic``) never said anyone did it.
#
# ``formulated with`` is deliberately absent.  It reads as containment, but the
# one answer that uses it names two ingredients at once, which no reader here
# can rest on a single record -- freeing the word alone would change nothing,
# so it would be dead.
#
# There is no Korean counterpart, and the absence is not the asymmetry this
# file keeps correcting.  Korean extraction keeps the frame inside the record
# it files (``... 성분으로 설명됩니다`` is the atom's own wording, fifteen times
# over in the live corpus), so the answer restating it finds the word already
# there.  English is where the model supplies a frame the record did not
# write, which is the only place the exemption does any work.
_FAQ_ATTRIBUTION_FRAME = re.compile(r"\b(?:is|are|was|were)\s+described\s+as\b", re.IGNORECASE)
# How a record's own role is said, in each market.  A record files a part by
# naming it and by filing it under a role; an answer that says the name is an
# ingredient restates that filing and asserts nothing further.  Measured: three
# answers that named nothing but recorded ingredients were each refused over
# the one word ``ingredient``, and their row published nothing.
#
# It is the *record's* role that licenses the word, never the word on its own.
# Subtracting the kind noun from what the answer must account for would let an
# answer file a part under a kind the record never used -- calling a completed
# test or a measured figure an ingredient -- so the word is supplied by the
# atom the sentence rests on, and only as far as the answer actually used it.
_FAQ_ROLE_KIND_WORDS: dict[str, tuple[str, ...]] = {
    "ingredient": ("ingredient", "성분"),
}
# The adverb that marks one more item of a list already under way.  It is the
# additive counterpart of the clause connective above: it says that what
# follows belongs with what came before, which a list already says, so it
# states no fact.  ``Korean Herb Extract is also an ingredient`` was refused
# over ``also`` alone.
#
# ``too`` is not here, although it is the plainest additive word in the
# language, because the same spelling is a degree adverb and the two are told
# apart only by where they stand.  Freeing it without reading position would
# take ``too rich`` down to ``rich`` and let a record that filed the plain
# term carry the stronger claim -- exactly the limit-and-polarity class the
# shared function words deliberately keep charging.
#
# Korean writes its adverbs without spaces around them, so ``\b`` does not
# apply and a bare alternation would cut the same letters out of an unrelated
# word -- ``광역시`` and ``지역시장`` each lose their middle to ``역시``.  The
# Hangul boundary is written out instead.  ``또한`` is absent because the
# tokenizer already drops it, so naming it here would only add reach.
_FAQ_ADDITIVE_ADVERB = re.compile(
    r"\b(?:also|as\s+well|in\s+addition|additionally)\b"
    r"|(?<![가-힣])역시(?![가-힣])",
    re.IGNORECASE,
)
_CONTAINMENT_FRAME_ANSWER_TOKENS = frozenset(
    token
    for form in (*KOREAN_CONTAINMENT_FRAME_FORMS, *ENGLISH_CONTAINMENT_FRAME_FORMS)
    for token in _substantive_tokens(form)
)


def _faq_one_english_stem(token: str) -> str:
    """Return one stem for the inflections of an English verb, for FAQ comparison only.

    A record and an answer name the same act with different endings -- a page
    files ``after 6 weeks of use`` and an answer restating that group writes
    ``32 women using the serum daily``.  The shared tokenizer leaves the two
    apart twice over: it skips a suffix on a short word (``using`` and ``used``
    keep theirs, where ``uses`` loses its own), and where it does strip one it
    does not put back the silent ``e`` the ending replaced, so ``improves``
    becomes ``improv`` while ``improve`` stays whole.  Both halves of that are
    spelling, not meaning, and the answer was refused over it: measured, one
    English recommendation row was dropped for the single word ``using``.

    Folding the ending and the silent ``e`` together gives the four forms of a
    verb one spelling, and it is applied to the record and to the answer
    alike, so it can only bring a restatement back to the record it restates.
    It stays here rather than in the shared tokenizer because the readers of
    the other published surfaces count words against a different bar and
    widening their stems would change what they publish.
    """

    for suffix in ("ing", "ed", "es", "s"):
        if len(token) > len(suffix) + 1 and token.endswith(suffix):
            token = token[: -len(suffix)]
            break
    return token[:-1] if len(token) > 2 and token.endswith("e") else token


def _faq_fold_inflection(tokens: Iterable[str]) -> list[str]:
    """Fold English inflection across a FAQ token list, leaving other scripts alone."""

    folded: list[str] = []
    for token in tokens:
        value = token if re.search(r"[^a-z]", token) else _faq_one_english_stem(token)
        if len(value) >= 2 and value not in folded:
            folded.append(value)
    return folded


def _faq_words_that_assert(value: str) -> list[str]:
    """Tokenize a FAQ answer span without the words that carry no assertion.

    The additive adverb and the attribution frame are removed from *both*
    sides of every comparison below.  Taking them off the answer alone was an
    asymmetry of the same kind this file keeps finding: a record that writes
    the word too would then be unable to match the answer that writes it.
    """

    return _substantive_tokens(_FAQ_ADDITIVE_ADVERB.sub(" ", _FAQ_ATTRIBUTION_FRAME.sub(" ", value)))


def _faq_kind_noun_classifies_a_part(answer: str, kind_tokens: set[str]) -> bool:
    """Return whether the kind noun says what a named part is, rather than heading the sentence.

    Saying that a named thing is an ingredient restates the filing and asserts
    nothing further.  Making the kind the sentence's own topic is a different
    claim: ``{product}의 성분은 판테놀과 베타인입니다`` says those are *the*
    ingredients, which is a completeness no record filed -- a page files each
    part it lists and never says the list is closed.  Measured: that sentence
    bound against two ingredient atoms while the record holds six.

    The two are told apart by where the noun stands, not by any word beside
    it.  Korean marks its topic, so the marked subject is read; English orders
    the subject before the finite copula, so the run in front of it is.  In a
    classification the kind noun is on the far side of that boundary.
    """

    subject = korean_subject_noun(answer)
    if not subject:
        subject = re.split(r"\b(?:is|are|was|were)\b", answer, maxsplit=1, flags=re.IGNORECASE)[0]
    return not (set(_substantive_tokens(subject)) & kind_tokens)


def _faq_role_kind_tokens(role: str, used: set[str], answer: str) -> set[str]:
    """Return the kind words this record's own role licenses, as far as the answer used them."""

    licensed = {
        token
        for word in _FAQ_ROLE_KIND_WORDS.get(clean_text(role), ())
        for token in _substantive_tokens(word)
    } & used
    if not licensed or not _faq_kind_noun_classifies_a_part(answer, licensed):
        return set()
    return licensed


def _evidence_token_coverage(target: str, reference: str) -> float:
    target_tokens = _substantive_tokens(target)
    if not target_tokens:
        return 0
    reference_tokens = set(_substantive_tokens(reference))
    return sum(token in reference_tokens for token in target_tokens) / len(target_tokens)


def _evidence_scope_mismatch(sentence: str, evidence: str) -> bool:
    patterns = (
        r"\b(?:not|no|never|cannot|nor)\b|않|없|아니|못\s*하|불가|되지\s*않",
        r"\b(?:preliminary|suggests?|may|might|could|in\s+vitro|inconclusive)\b|시험관|가능성|예비\s*(?:연구|결과)|추정",
        r"\b(?:review|reviews|reviewer|customer|customers|consumer)\b|리뷰|후기|고객|소비자",
    )
    return any(bool(re.search(pattern, evidence, re.I)) and not re.search(pattern, sentence, re.I) for pattern in patterns)


def _sentence_assertion_frame_is_supported(sentence: str, evidence: Sequence[Mapping[str, Any]]) -> bool:
    """Require sensitive public-copy assertion frames to stay in one source atom.

    This runs before renderer role shortcuts and is shared with supplied
    provenance validation.  It intentionally keeps verbatim source sentences
    and neutral ingredient connections eligible while preventing a ledger from
    combining separate records into a stronger metric, review, or benefit
    assertion.
    """

    normalized = clean_proposed_text(sentence)
    source_sentences = _evidence_source_sentences(evidence)
    if not normalized or not source_sentences:
        return False
    if _renderer_source_role_records(normalized, evidence):
        return True
    if any(_normalize_evidence(source) == _normalize_evidence(normalized) for _, source in source_sentences):
        return True
    if _source_backed_positive_review_frame_records(normalized, evidence):
        return True
    if _source_role_question_roles(normalized):
        return True
    if (
        _numeric_tokens(normalized)
        and not _numeric_tokens_are_ledger_identifiers(normalized, evidence)
        and not _metric_assertion_frame_has_single_source_support(normalized, source_sentences, evidence)
    ):
        return False
    if _BENEFIT_RELATION.search(normalized) and not _benefit_assertion_frame_has_single_source_support(
        normalized, source_sentences, evidence
    ):
        return False
    return not _REVIEW_REFERENCE.search(normalized) or _review_assertion_frame_has_single_source_support(
        normalized, source_sentences, evidence
    )


def _has_neutral_review_attribution(sentence: str) -> bool:
    return _neutral_review_attribution_relation(sentence) is not None


def _neutral_review_attribution_relation(sentence: str) -> re.Match[str] | None:
    review_match = _REVIEW_REFERENCE.search(sentence)
    if review_match is None:
        return None
    if not re.search(r"[가-힣]", sentence):
        relation = _CLAIM_RELATION.search(sentence)
        return (
            relation
            if relation is not None
            and relation.start() > review_match.start()
            and re.fullmatch(r"mentions?|says?", relation.group(), re.I)
            else None
        )
    return next(
        (
            relation
            for relation in _CLAIM_RELATION.finditer(sentence)
            if relation.start() > review_match.start()
            and re.fullmatch(r"언급", relation.group(), re.I)
        ),
        None,
    )


def _neutral_review_bridge_identity_is_relevant(
    sentence: str,
    item: Mapping[str, Any],
    evidence: Sequence[Mapping[str, Any]],
) -> bool:
    """Bind an identity only to a neutral review report that names it."""

    identity = clean_text(item.get("text"))
    return bool(
        clean_text(item.get("role")) == "identity"
        and identity
        and _has_neutral_review_attribution(sentence)
        and any(clean_text(candidate.get("role")) == "review" for candidate in evidence)
        and re.search(
            rf"{re.escape(identity)}(?:['’]s|[은는이가을를와과의도만])?(?=\s|[,.;!?。！？]|$)",
            sentence,
            re.I,
        )
    )


def _evidence_source_sentences(evidence: Sequence[Mapping[str, Any]]) -> list[tuple[Mapping[str, Any], str]]:
    return [
        (item, source)
        for item in evidence
        for source in (_sentences(clean_text(item.get("text"))) or [clean_text(item.get("text"))])
        if source
    ]


def _renderer_source_role_records(
    sentence: str,
    evidence: Sequence[Mapping[str, Any]],
    *,
    preceding_sentence: str = "",
) -> list[Mapping[str, Any]]:
    """Return the closed ledger rows for the narrow deterministic renderer frames.

    These are source-role renderings, not a general prose fallback.  Each
    accepted formula/benefit list must reconstruct from original product-role
    rows, and the review path accepts only a non-negative item-body sentence
    produced by the renderer's fixed attribution frame.

    Every locale the renderer composes an ingredient list for needs a rung
    here.  Without one the list binds to nothing and the proofreader drops the
    sentence, which is how one locale silently lost its formula stage while
    the other kept it.
    """

    return (
        _korean_renderer_ingredient_records(sentence, evidence)
        or _english_renderer_ingredient_records(sentence, evidence)
        or _korean_renderer_benefit_records(sentence, evidence)
        or _korean_renderer_review_records(sentence, evidence, preceding_sentence=preceding_sentence)
    )


def _korean_renderer_ingredient_records(
    sentence: str, evidence: Sequence[Mapping[str, Any]]
) -> list[Mapping[str, Any]]:
    match = _KOREAN_RENDERER_INGREDIENT_FRAME.fullmatch(clean_proposed_text(sentence))
    if match is None:
        return []
    identity = _review_frame_identity_records(clean_text(match.group("subject")), evidence, allow_brand_product=True)
    ingredients = _renderer_comma_list_records(
        clean_text(match.group("items")),
        evidence,
        roles=frozenset({"ingredient"}),
        source_path=re.compile(r"^product\.ingredients\[\d+\]$"),
    )
    return [*identity, *ingredients] if identity and ingredients else []


_ENGLISH_RENDERER_INGREDIENT_FRAME = re.compile(
    r"^(?P<subject>.+?)\s+includes\s+(?P<items>.+?)[.!?]?$", re.IGNORECASE
)
_ENGLISH_LIST_SEPARATOR = re.compile(r",\s*(?:and\s+)?|\s+and\s+", re.IGNORECASE)


def _english_renderer_ingredient_records(
    sentence: str, evidence: Sequence[Mapping[str, Any]]
) -> list[Mapping[str, Any]]:
    """Bind a rendered English formula list to the atoms that name its members.

    The Korean rung reconstructs the serialized list out of whole atoms, which
    works where a page filed each ingredient as its own row.  A page that names
    its ingredients inside a KEY INGREDIENTS block files them as prose, and the
    renderer reads the names out of it, so no atom equals a list member.  What
    licenses the sentence is then the same thing either way: every member has to
    be a name the source wrote, in an atom typed as this product's ingredient.
    A member the source never wrote fails the whole sentence, so the list
    asserts nothing the page did not.

    Letter case is not identity in English.  A source block writes its names in
    title case or in capitals ("500-Hour Aged Ginseng"), and prose writes the
    same name the way a sentence does, so the names are compared as the names
    they are.  Word boundaries still hold, so a name is never found inside
    another word.
    """

    match = _ENGLISH_RENDERER_INGREDIENT_FRAME.fullmatch(clean_text(sentence))
    if match is None:
        return []
    identity = _review_frame_identity_records(
        clean_text(match.group("subject")), evidence, allow_brand_product=True
    )
    if not identity:
        return []
    members = [clean_text(part) for part in _ENGLISH_LIST_SEPARATOR.split(clean_text(match.group("items")))]
    if not all(members):
        return []
    named: list[Mapping[str, Any]] = []
    for member in members:
        atom = next(
            (
                item
                for item in evidence
                if clean_text(item.get("role")) == "ingredient"
                and (text := clean_text(item.get("text")))
                and source_phrase_matches(text.casefold(), member.casefold())
            ),
            None,
        )
        if atom is None:
            return []
        named.append(atom)
    return [*identity, *_unique_evidence_records(named)]


def _korean_renderer_benefit_records(sentence: str, evidence: Sequence[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    match = _KOREAN_RENDERER_BENEFIT_FRAME.fullmatch(clean_proposed_text(sentence))
    if match is None:
        return []
    rendered_items = clean_text(match.group("items"))
    # This is a source-listing frame, not an assertion shortcut.  Sensitive
    # target, recommendation, safety, or uncertainty wording stays on the
    # ordinary exact-source path rather than being aggregated here.
    if _claim_modalities(rendered_items):
        return []
    identity = _review_frame_identity_records(clean_text(match.group("subject")), evidence, allow_brand_product=True)
    benefits = _renderer_comma_list_records(
        rendered_items,
        evidence,
        roles=frozenset({"benefit", "effect"}),
        source_path=re.compile(r"^product\.(?:benefits|effects)\[\d+\]$"),
    )
    return [*identity, *benefits] if identity and benefits else []


def _renderer_comma_list_records(
    rendered: str,
    evidence: Sequence[Mapping[str, Any]],
    *,
    roles: frozenset[str],
    source_path: re.Pattern[str],
) -> list[Mapping[str, Any]]:
    """Reconstruct one renderer list from exact source-role atoms only.

    Matching the whole serialized comma list avoids a token-overlap fallback;
    it also handles an atom that itself contains a comma (for example a
    concentration) without treating that punctuation as a list boundary.
    """

    target = clean_proposed_text(rendered)
    candidates = [
        item
        for item in evidence
        if clean_text(item.get("role")) in roles
        and source_path.fullmatch(clean_text(item.get("sourcePath"))) is not None
        and clean_proposed_text(clean_text(item.get("text")))
    ]
    candidates.sort(key=lambda item: len(clean_proposed_text(clean_text(item.get("text")))), reverse=True)

    def consume(offset: int, used_ids: frozenset[str]) -> list[Mapping[str, Any]] | None:
        if offset == len(target):
            return []
        for item in candidates:
            identifier = clean_text(item.get("id"))
            source = clean_proposed_text(clean_text(item.get("text")))
            if not identifier or identifier in used_ids or not target.startswith(source, offset):
                continue
            next_offset = offset + len(source)
            if next_offset == len(target):
                return [item]
            if target.startswith(", ", next_offset):
                tail = consume(next_offset + 2, used_ids | {identifier})
                if tail is not None:
                    return [item, *tail]
        return None

    return consume(0, frozenset()) or []


def _korean_renderer_joined_list_records(
    rendered: str,
    evidence: Sequence[Mapping[str, Any]],
    *,
    roles: frozenset[str],
    source_path: re.Pattern[str],
) -> list[Mapping[str, Any]]:
    """Reconstruct a Korean conjunction list from complete source atoms only.

    Natural Korean composition frequently joins exact ingredient names with
    ``와``, ``과``, or ``및`` instead of a comma.  This parser still consumes
    the complete rendered string from known source atoms and fixed separators;
    it does not token-match an arbitrary phrase or infer a formula relation.
    """

    target = clean_proposed_text(rendered)
    candidates = [
        item
        for item in evidence
        if clean_text(item.get("role")) in roles
        and source_path.fullmatch(clean_text(item.get("sourcePath"))) is not None
        and clean_proposed_text(clean_text(item.get("text")))
    ]
    candidates.sort(key=lambda item: len(clean_proposed_text(clean_text(item.get("text")))), reverse=True)
    separators = (", ", ",", "와 ", "과 ", " 및 ")

    def consume(offset: int, used_ids: frozenset[str]) -> list[Mapping[str, Any]] | None:
        if offset == len(target):
            return []
        for item in candidates:
            identifier = clean_text(item.get("id"))
            source = clean_proposed_text(clean_text(item.get("text")))
            if not identifier or identifier in used_ids or not target.startswith(source, offset):
                continue
            next_offset = offset + len(source)
            if next_offset == len(target):
                return [item]
            for separator in separators:
                if target.startswith(separator, next_offset):
                    tail = consume(next_offset + len(separator), used_ids | {identifier})
                    if tail is not None:
                        return [item, *tail]
        return None

    return consume(0, frozenset()) or []


def _positive_review_body_records(evidence: Sequence[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    return [
        item
        for item in evidence
        if clean_text(item.get("role")) == "review"
        and _REVIEW_BODY_SOURCE_PATH.fullmatch(clean_text(item.get("sourcePath"))) is not None
        and is_positive_review_body(clean_text(item.get("text")))
    ]


def _korean_renderer_review_records(
    sentence: str,
    evidence: Sequence[Mapping[str, Any]],
    *,
    preceding_sentence: str,
) -> list[Mapping[str, Any]]:
    """Bind the renderer's branded positive item-body attribution, sentence by sentence."""

    normalized = clean_proposed_text(sentence)
    positive_bodies = _positive_review_body_records(evidence)
    lead = _KOREAN_RENDERER_REVIEW_LEAD_FRAME.fullmatch(normalized)
    if lead is not None:
        identity = _review_frame_identity_records(clean_text(lead.group("subject")), evidence, allow_brand_product=True)
        body = clean_proposed_text(lead.group("body"))
        records = [
            item
            for item in positive_bodies
            if _sentences(clean_text(item.get("text")))
            and clean_proposed_text(_sentences(clean_text(item.get("text")))[0]) == body
        ]
        return [*identity, *records] if identity and len(records) == 1 else []

    exact_body_records = [
        item
        for item in positive_bodies
        if normalized in {clean_proposed_text(part) for part in _sentences(clean_text(item.get("text")))}
    ]
    if exact_body_records:
        return exact_body_records

    if _KOREAN_RENDERER_REVIEW_TERMINAL_FRAME.fullmatch(normalized) is None:
        return []
    preceding_is_terminal = _KOREAN_RENDERER_REVIEW_TERMINAL_FRAME.fullmatch(
        clean_proposed_text(preceding_sentence)
    ) is not None
    preceding_lead_records = (
        _korean_renderer_review_records(preceding_sentence, evidence, preceding_sentence="")
        if preceding_sentence and not preceding_is_terminal
        else []
    )
    contextual = [
        item
        for item in positive_bodies
        if (
            _sentences(clean_text(item.get("text")))
            and clean_proposed_text(_sentences(clean_text(item.get("text")))[-1])
            == clean_proposed_text(preceding_sentence)
        )
        or any(
            _same_evidence_record(item, lead_item)
            for lead_item in preceding_lead_records
        )
    ]
    if contextual:
        return contextual if len(contextual) == 1 else []
    # Validation receives one finalized sentence at a time.  Its caller has
    # already selected the contextual source row above, so retain only that
    # closed positive body row rather than selecting a new review candidate.
    return positive_bodies if len(evidence) == 1 and len(positive_bodies) == 1 else []


def _has_exact_renderer_source_role_binding(sentence: str, evidence: Sequence[Mapping[str, Any]]) -> bool:
    selected = _renderer_source_role_records(sentence, evidence)
    return bool(selected) and _same_evidence_record_ids(selected, evidence)


def _same_evidence_record_ids(left: Sequence[Mapping[str, Any]], right: Sequence[Mapping[str, Any]]) -> bool:
    """Require a special-frame provenance row to carry exactly its closed evidence set."""

    def identifiers(records: Sequence[Mapping[str, Any]]) -> list[str]:
        return _unique_strings(clean_text(item.get("id")) for item in records if clean_text(item.get("id")))

    left_ids, right_ids = identifiers(left), identifiers(right)
    return len(left_ids) == len(right_ids) and set(left_ids) == set(right_ids)


def _source_backed_positive_review_frame_records(
    sentence: str,
    evidence: Sequence[Mapping[str, Any]],
) -> list[Mapping[str, Any]]:
    """Return the closed evidence set for one eligible review-summary sentence.

    These are deliberately presentation-specific exceptions to normal review
    body handling.  A keyword needs its explicit positive source atom; an
    aggregate rating needs the exact summary's rating and count.  Neither
    branch can turn a raw review, a mixed signal, or merely adjacent metadata
    into customer consensus.

    A quotation mark is foreign to a keyword or a rating, and each of those
    frames excludes one from the span it captures.  The attributed-body frame
    is the one whose grammar *is* a quotation -- marking a customer's own words
    is what keeps them from reading as the product's claim -- and it proves the
    quoted words against one whole sentence of one positive review body.  The
    exclusion therefore belongs to the frames that need it, not to the sentence.
    """

    return (
        _positive_review_keyword_frame_records(sentence, evidence)
        or _korean_attributed_review_body_records(sentence, evidence)
        or _positive_review_rating_frame_records(sentence, evidence)
    )


def _source_backed_positive_review_frame_record_is_relevant(
    sentence: str,
    item: Mapping[str, Any],
    evidence: Sequence[Mapping[str, Any]],
) -> bool:
    """Keep every selected ID tied to the exact positive review frame."""

    return any(
        _same_evidence_record(item, candidate)
        for candidate in _source_backed_positive_review_frame_records(sentence, evidence)
    )


# A description reports what customers assessed rather than quoting one of
# them, so the frame is the report: the customer's predicate moved to the plain
# declarative Korean reports in, and the sentence says it was an assessment.
_KOREAN_REPORTED_REVIEW_ASSESSMENT_FRAME = re.compile(
    r"^(?P<subject>.+?)(?:을|를)\s*사용한\s*고객들은\s+(?P<clause>.+?)\s*평가를\s*하였습니다[.。！？!?]?$"
)


def _korean_attributed_review_body_records(
    sentence: str,
    evidence: Sequence[Mapping[str, Any]],
) -> list[Mapping[str, Any]]:
    """Return the closed evidence set for one attributed Korean review quote.

    The renderer attributes a customer's own sentence to customers and names
    the product it is about.  The frame is closed on both sides: the subject
    must resolve to the product's identity records, and the quoted words must
    be one whole sentence of one positive review body -- never a paraphrase and
    never a span assembled from more than one review.
    """

    match = _KOREAN_REPORTED_REVIEW_ASSESSMENT_FRAME.fullmatch(clean_text(sentence))
    if match is None:
        return []
    identity = _review_frame_identity_records(
        clean_text(match.group("subject")), evidence, allow_brand_product=True
    )
    reported = _normalize_evidence(clean_text(match.group("clause")))
    if not identity or not reported:
        return []
    for item in evidence:
        source = clean_text(item.get("text"))
        if clean_text(item.get("role")) != "review":
            continue
        if _REVIEW_BODY_SOURCE_PATH.fullmatch(clean_text(item.get("sourcePath"))) is not None:
            if not is_positive_review_body(source):
                continue
            if any(_normalize_evidence(korean_reported_clause(row)) == reported for row in _sentences(source)):
                return [*identity, item]
            continue
        if (
            _REVIEW_KEYWORD_SOURCE_PATH.fullmatch(clean_text(item.get("sourcePath"))) is not None
            and is_positive_review_keyword(source)
            and _normalize_evidence(korean_reported_clause(source)) == reported
        ):
            return [*identity, item]
    return []


def _positive_review_keyword_frame_records(
    sentence: str,
    evidence: Sequence[Mapping[str, Any]],
) -> list[Mapping[str, Any]]:
    english = _ENGLISH_POSITIVE_REVIEW_KEYWORD_FRAME.fullmatch(sentence)
    korean = _KOREAN_POSITIVE_REVIEW_KEYWORD_FRAME.fullmatch(sentence)
    if english is None and korean is None:
        return []
    match = english or korean
    assert match is not None
    identity = _review_frame_identity_records(
        clean_text(match.group("subject")),
        evidence,
        allow_brand_product=True,
    )
    listed = clean_text(match.group("keyword"))
    if not identity or _REVIEW_QUOTE.search(listed):
        return []
    matched: list[Mapping[str, Any]] = []
    for keyword in _rendered_review_keywords(listed):
        atom = next(
            (
                item
                for item in evidence
                if clean_text(item.get("role")) == "review"
                and _REVIEW_KEYWORD_SOURCE_PATH.fullmatch(clean_text(item.get("sourcePath"))) is not None
                and not _REVIEW_QUOTE.search(source := clean_text(item.get("text")))
                and is_positive_review_keyword(source)
                and _review_keyword_matches_atom(keyword, source)
            ),
            None,
        )
        if atom is None:
            return []
        if atom not in matched:
            matched.append(atom)
    return [*identity, *matched] if matched else []


def _rendered_review_keywords(listed: str) -> list[str]:
    """Split the keywords a review-keyword frame names into the words it lists."""

    parts = re.split(r"[,、]\s*|\s+and\s+", clean_text(listed))
    return [keyword for part in parts if (keyword := clean_text(part))]


def _review_keyword_matches_atom(keyword: str, atom: str) -> bool:
    """Return whether a named keyword is this atom, ignoring only its role marking.

    Extraction keeps the particle the review sentence attached to the word, and
    naming the same word as what customers evaluated replaces that particle
    with the one this frame's own role takes.  Comparing the spellings would
    make the word look like a different word; comparing the words themselves
    is what the frame has to verify.
    """

    if _normalize_evidence(atom) == _normalize_evidence(keyword):
        return True
    return bool(re.search(r"[가-힣]", atom)) and _normalize_evidence(
        strip_korean_particle(atom)
    ) == _normalize_evidence(keyword)


def _positive_review_rating_frame_records(
    sentence: str,
    evidence: Sequence[Mapping[str, Any]],
) -> list[Mapping[str, Any]]:
    if _REVIEW_QUOTE.search(sentence):
        # A rating states counts and a scale; a quoted span is a customer's own
        # words, which this frame never verifies.
        return []
    english = _ENGLISH_POSITIVE_REVIEW_RATING_FRAME.fullmatch(sentence)
    korean = _KOREAN_POSITIVE_REVIEW_RATING_FRAME.fullmatch(sentence)
    if english is None and korean is None:
        return []
    match = english or korean
    assert match is not None
    identity = _review_frame_identity_records(
        clean_text(match.group("subject")),
        evidence,
        allow_brand_product=True,
    )
    if not identity:
        return []
    rendered_rating = _review_frame_number(match.group("rating"))
    rendered_count = _review_frame_number(match.group("count"))
    rendered_scale = _review_frame_number(match.group("scale"))
    if rendered_rating is None or rendered_count is None or rendered_scale is None or not rendered_count.is_integer():
        return []
    for item in evidence:
        values = _positive_aggregate_review_summary_values(item)
        if values is None:
            continue
        rating, count = values
        scale = 10.0 if rating > 5 else 5.0
        if rating == rendered_rating and count == rendered_count and scale == rendered_scale:
            return [*identity, item]
    return []


def _review_frame_identity_records(
    subject: str,
    evidence: Sequence[Mapping[str, Any]],
    *,
    allow_brand_product: bool,
) -> list[Mapping[str, Any]]:
    """Resolve a closed product identity phrase without accepting extra wording."""

    normalized_subject = _normalize_evidence(subject)
    products = [
        item
        for item in evidence
        if clean_text(item.get("role")) == "identity"
        and clean_text(item.get("sourcePath")) in {"product.name", "product.originalName"}
        and clean_text(item.get("text"))
    ]
    for item in products:
        if any(
            normalized_subject == _normalize_evidence(surface)
            for surface in _published_identity_surfaces(clean_text(item.get("text")))
        ):
            return [item]
    if not allow_brand_product:
        return []
    brands = [
        item
        for item in evidence
        if clean_text(item.get("role")) == "identity"
        and clean_text(item.get("sourcePath")) == "product.brand"
        and clean_text(item.get("text"))
    ]
    for brand in brands:
        for product in products:
            brand_text = clean_text(brand.get("text"))
            for product_text in _published_identity_surfaces(clean_text(product.get("text"))):
                # The renderer writes the same entity three ways depending on
                # the locale and the frame; all three name the same two records.
                for phrase in (
                    f"{brand_text}'s {product_text}",
                    f"{product_text} from {brand_text}",
                    f"{brand_text}의 {product_text}",
                ):
                    if normalized_subject == _normalize_evidence(phrase):
                        return [brand, product]
    return []


def _positive_aggregate_review_summary_values(item: Mapping[str, Any]) -> tuple[float, float] | None:
    """Read one exact generated review-summary atom, never generic review text."""

    if clean_text(item.get("role")) != "review" or clean_text(item.get("sourcePath")) != _REVIEW_SUMMARY_SOURCE_PATH:
        return None
    match = _REVIEW_SUMMARY_VALUES.fullmatch(clean_text(item.get("text")))
    if match is None:
        return None
    rating = _review_frame_number(match.group("rating"))
    count = _review_frame_number(match.group("count"))
    if rating is None or count is None or not count.is_integer() or not is_positive_aggregate_rating(rating, count):
        return None
    return rating, count


def _review_frame_number(value: str) -> float | None:
    try:
        return float(value)
    except ValueError:
        return None


def _same_evidence_record(left: Mapping[str, Any], right: Mapping[str, Any]) -> bool:
    """Compare selected ledger rows without treating equal text as equal evidence."""

    left_id, right_id = clean_text(left.get("id")), clean_text(right.get("id"))
    return bool(left_id and left_id == right_id) or left is right


def _assertion_frame_tokens(sentence: str, evidence: Sequence[Mapping[str, Any]]) -> set[str]:
    identity_tokens = {
        token
        for item in evidence
        if clean_text(item.get("role")) == "identity"
        for token in _substantive_tokens(clean_text(item.get("text")))
    }
    return set(_substantive_tokens(sentence)) - identity_tokens - _PUBLIC_COPY_TEMPLATE_TOKENS


def _metric_assertion_frame_has_single_source_support(
    sentence: str,
    source_sentences: Sequence[tuple[Mapping[str, Any], str]],
    evidence: Sequence[Mapping[str, Any]],
) -> bool:
    required = _assertion_frame_tokens(sentence, evidence)
    return any(
        _claim_scope_matches(sentence, source)
        and _numeric_tokens_match(sentence, source)
        and required <= set(_substantive_tokens(source))
        for _, source in source_sentences
    )


def _numeric_tokens_are_ledger_identifiers(sentence: str, evidence: Sequence[Mapping[str, Any]]) -> bool:
    """Keep the digits of a ledger name out of the metric-claim guard.

    A naming atom carries digits that identify a thing rather than measure it:
    ``BarrierCare365`` is what the product is called and ``500-Hour Aged Ginseng
    Extract`` is what an ingredient is called.  A number counts as an
    identifier only when the sentence writes it the way a naming atom does, in
    the very word of the name that carries it, so an unsourced value such as
    ``99.9%`` still requires the ordinary single-source metric check.  Matching
    the name word rather than the whole atom keeps a shortened rendering or an
    attached particle from turning a name back into a measurement.  The product
    identity names itself in any frame; an ingredient name reads as composition
    only inside an explicit inclusion frame.
    """

    numerics = set(_numeric_tokens(sentence))
    if not numerics:
        return False
    naming_roles = {"identity", "ingredient"} if _FORMULA_RELATION.search(sentence) else {"identity"}
    naming_texts = [
        clean_text(item.get("text")) for item in evidence if clean_text(item.get("role")) in naming_roles
    ]
    return numerics <= naming_identifier_numerics(sentence, naming_texts)


def _benefit_assertion_frame_has_single_source_support(
    sentence: str,
    source_sentences: Sequence[tuple[Mapping[str, Any], str]],
    evidence: Sequence[Mapping[str, Any]],
) -> bool:
    relation = _BENEFIT_RELATION.search(sentence)
    if relation is None:
        return True
    required = _assertion_frame_tokens(_benefit_assertion_frame(sentence, relation), evidence)
    required -= _unbound_entity_lead_tokens(sentence[: relation.start()])
    sentence_subject = _claim_subject_tokens(sentence[: relation.start()])
    relation_tokens = set(_substantive_tokens(relation.group()))
    for _, source in source_sentences:
        source_relation = _BENEFIT_RELATION.search(source)
        if source_relation is None or not _claim_scope_matches(sentence, source):
            continue
        if relation_tokens != set(_substantive_tokens(source_relation.group())):
            continue
        source_subject = _claim_subject_tokens(source[: source_relation.start()])
        if source_subject and sentence_subject and not (
            source_subject <= sentence_subject or sentence_subject <= source_subject
        ):
            continue
        if required <= set(_substantive_tokens(source)):
            return True
    return False


def _benefit_assertion_frame(sentence: str, relation: re.Match[str]) -> str:
    if re.search(r"[가-힣]", relation.group()):
        return sentence[: relation.end()]
    next_relation = next(
        (match for match in _CLAIM_RELATION.finditer(sentence) if match.start() > relation.start()), None
    )
    return sentence[: next_relation.start()] if next_relation is not None else sentence


def _unbound_entity_lead_tokens(value: str) -> set[str]:
    """Ignore a renderer-added product lead when its source atom is subjectless."""

    tokens = {
        token
        for match in re.finditer(r"\b[A-Z][A-Za-z0-9-]*\b", value)
        for token in _substantive_tokens(match.group())
    }
    korean_subject = re.match(r"^\s*([가-힣A-Za-z0-9 -]+?)(?:은|는|이|가)\s", value)
    if korean_subject is not None:
        tokens.update(_substantive_tokens(korean_subject.group(1)))
    return tokens


def _review_assertion_frame_has_single_source_support(
    sentence: str,
    source_sentences: Sequence[tuple[Mapping[str, Any], str]],
    evidence: Sequence[Mapping[str, Any]],
) -> bool:
    required = _assertion_frame_tokens(sentence, evidence)
    review_match = _REVIEW_REFERENCE.search(sentence)
    for match in _REVIEW_REFERENCE.finditer(sentence):
        required -= set(_substantive_tokens(match.group()))
    relation = _neutral_review_attribution_relation(sentence)
    if relation is not None:
        required -= set(_substantive_tokens(relation.group()))
        if review_match is not None:
            korean_required = _neutral_korean_review_attribution_required_tokens(sentence, evidence)
            if korean_required is not None:
                required = korean_required
            elif _english_neutral_review_prefix_is_identity_scaffold(sentence[: relation.start()], evidence):
                required -= set(_substantive_tokens(sentence[: relation.start()]))
    return any(
        (
            clean_text(item.get("role")) == "review" or _REVIEW_REFERENCE.search(source) is not None
        )
        and _claim_scope_matches(sentence, source)
        and required <= set(_substantive_tokens(source))
        for item, source in source_sentences
    )


def _neutral_korean_review_attribution_required_tokens(
    sentence: str,
    evidence: Sequence[Mapping[str, Any]],
) -> set[str] | None:
    """Return only the review atom required by a Korean neutral report.

    The renderer may wrap a review keyword with product identity and
    ``고객 리뷰에는 … 언급이 있습니다``.  Those words do not strengthen the
    review claim.  This deliberately does not strip sentiment, agreement, or
    recommendation language: any such escalation must still be present in one
    review source.
    """

    if not re.search(r"[가-힣]", sentence) or not _has_neutral_review_attribution(sentence):
        return None
    atom = re.sub(
        r"(?:관련\s*)?(?:고객\s*)?(?:리뷰|후기)(?:에는|에서는|에|은|는|이|가)?",
        " ",
        sentence,
    )
    atom = re.sub(r"언급(?:이|은|는)?\s*(?:있습니다|있다|됩니다|되다|되었습니다|되었다)?", " ", atom)
    identity_tokens = {
        token
        for item in evidence
        if clean_text(item.get("role")) == "identity"
        for token in _substantive_tokens(clean_text(item.get("text")))
    }
    return set(_substantive_tokens(atom)) - identity_tokens - _PUBLIC_COPY_TEMPLATE_TOKENS


def _english_neutral_review_prefix_is_identity_scaffold(
    prefix: str,
    evidence: Sequence[Mapping[str, Any]],
) -> bool:
    """Allow only review attribution grammar and exact identity before ``mention``.

    A neutral renderer can say ``Customer reviews for Glow Serum mention``.
    It cannot hide sentiment or consensus before a later neutral verb, so every
    other substantive prefix token must be absent.
    """

    remaining = _REVIEW_REFERENCE.sub(" ", prefix)
    remaining = re.sub(r"\b(?:for|from|about|of|the)\b", " ", remaining, flags=re.I)
    for identity in sorted(
        {
            clean_text(item.get("text"))
            for item in evidence
            if clean_text(item.get("role")) == "identity" and clean_text(item.get("text"))
        },
        key=len,
        reverse=True,
    ):
        remaining = re.sub(rf"{re.escape(identity)}(?:['’]s)?", " ", remaining, flags=re.I)
    return not _substantive_tokens(remaining)


def sentence_evidence_has_direct_claim_support(sentence: str, evidence: Sequence[Mapping[str, Any]]) -> bool:
    """Require a sentence-relevant evidence record with matching claim scope.

    Public-copy provenance is deliberately sentence-scoped: an identity or a
    broad source field cannot stand in for an efficacy, suitability, or other
    substantive assertion.  The comparison is semantic-role aware so a
    renderer may add the product name around an atom such as ``supports
    hydration`` without turning an ingredient/source relationship into a new
    product-level claim.
    """

    normalized = clean_proposed_text(sentence)
    if not normalized:
        return False
    if _renderer_page_overview_records(normalized, evidence):
        return True
    if _renderer_page_usage_summary_records(normalized, evidence):
        return True
    if _english_source_faq_usage_answer_binding(normalized, evidence):
        return True
    if _source_faq_identity_question_binding(normalized, evidence):
        return True
    if _english_customer_concern_question_binding(normalized, evidence):
        return True
    if _english_buyer_audience_question_binding(normalized, evidence):
        return True
    if _english_entity_prefixed_benefit_binding(normalized, evidence):
        return True
    if _english_generic_subject_source_description_binding(normalized, evidence):
        return True
    if _entity_rewritten_source_description_binding(normalized, evidence):
        return True
    if _english_entity_prefixed_description_binding(normalized, evidence):
        return True
    if _has_exact_renderer_source_role_binding(normalized, evidence):
        return True
    if _english_explicit_audience_relation_binding(normalized, evidence):
        return True
    if _korean_explicit_audience_relation_binding(normalized, evidence):
        return True
    if _korean_entity_prefixed_ingredient_records(normalized, evidence):
        return True
    if _english_entity_prefixed_solution_relation_binding(normalized, evidence):
        return True
    if not _sentence_assertion_frame_is_supported(normalized, evidence):
        return False
    if _source_backed_positive_review_frame_records(normalized, evidence):
        return True
    scoped = [
        item
        for item in evidence
        if clean_text(item.get("text"))
        and any(
            _claim_scope_matches(normalized, source)
            for source in (_sentences(clean_text(item.get("text"))) or [clean_text(item.get("text"))])
        )
    ]
    if any(_evidence_record_supports_claim(normalized, item) for item in scoped):
        return True
    if _direct_assertion_frame_relevant_evidence(normalized, scoped):
        return True
    requested_roles = _source_role_question_roles(normalized)
    if requested_roles:
        return all(
            any(
                clean_text(item.get("role")) in _SOURCE_ROLE_QUESTION_EVIDENCE[requested_role]
                and clean_text(item.get("text"))
                for item in evidence
            )
            for requested_role in requested_roles
        )
    return _evidence_combination_supports_claim(normalized, scoped)


def _source_role_question_roles(sentence: str) -> frozenset[str]:
    """Return fact roles explicitly requested by a non-assertive FAQ question.

    A question can cite a source category without asserting that category's
    answer.  This narrowly admits only product-role questions; safety,
    suitability, recommendation, and uncertain questions still require an
    exact direct source statement through the ordinary claim path.
    """

    if not re.search(r"[?？]\s*$", sentence) or _claim_modalities(sentence):
        return frozenset()
    return frozenset(role for role, pattern in _SOURCE_ROLE_QUESTION_PATTERNS if pattern.search(sentence))


def _source_role_question_accepts_evidence(sentence: str, role: str) -> bool:
    return any(
        role in _SOURCE_ROLE_QUESTION_EVIDENCE[requested_role]
        for requested_role in _source_role_question_roles(sentence)
    )


def sentence_evidence_has_direct_safety_support(sentence: str, evidence: Sequence[Mapping[str, Any]]) -> bool:
    """Backward-compatible name for the stronger sentence-level admission check."""

    return sentence_evidence_has_direct_claim_support(sentence, evidence)


def sentence_provenance_has_direct_claim_support(
    sentence: str,
    evidence: Sequence[Mapping[str, Any]],
    _ledger: Sequence[Mapping[str, Any]],
    _origin: object,
) -> bool:
    """Require every provenance ID to be relevant to its exact sentence."""

    page_overview_records = _renderer_page_overview_records(sentence, evidence)
    if page_overview_records:
        return {clean_text(item.get("id")) for item in evidence} == {
            clean_text(item.get("id")) for item in page_overview_records
        }
    page_usage_records = _renderer_page_usage_summary_records(sentence, evidence)
    if page_usage_records:
        return {clean_text(item.get("id")) for item in evidence} == {
            clean_text(item.get("id")) for item in page_usage_records
        }
    source_faq_usage_records = _english_source_faq_usage_answer_binding(sentence, evidence)
    if source_faq_usage_records:
        return {clean_text(item.get("id")) for item in evidence} == {
            clean_text(item.get("id")) for item in source_faq_usage_records
        }
    source_faq_identity_question = _source_faq_identity_question_binding(sentence, evidence)
    if source_faq_identity_question:
        return {clean_text(item.get("id")) for item in evidence} == {
            clean_text(item.get("id")) for item in source_faq_identity_question
        }
    customer_concern_question = _english_customer_concern_question_binding(sentence, evidence)
    if customer_concern_question:
        return {clean_text(item.get("id")) for item in evidence} == {
            clean_text(item.get("id")) for item in customer_concern_question
        }
    buyer_audience_question = _english_buyer_audience_question_binding(sentence, evidence)
    if buyer_audience_question:
        return {clean_text(item.get("id")) for item in evidence} == {
            clean_text(item.get("id")) for item in buyer_audience_question
        }
    entity_prefixed_benefit = _english_entity_prefixed_benefit_binding(sentence, evidence)
    if entity_prefixed_benefit:
        return {clean_text(item.get("id")) for item in evidence} == {
            clean_text(item.get("id")) for item in entity_prefixed_benefit
        }
    generic_subject_description = _english_generic_subject_source_description_binding(sentence, evidence)
    if generic_subject_description:
        return {clean_text(item.get("id")) for item in evidence} == {
            clean_text(item.get("id")) for item in generic_subject_description
        }
    page_offer_records = _renderer_page_offer_records(sentence, evidence)
    if page_offer_records:
        return {clean_text(item.get("id")) for item in evidence} == {
            clean_text(item.get("id")) for item in page_offer_records
        }
    korean_benefit_records = _korean_entity_prefixed_benefit_records(sentence, evidence)
    if korean_benefit_records:
        return {clean_text(item.get("id")) for item in evidence} == {
            clean_text(item.get("id")) for item in korean_benefit_records
        }
    entity_subject_binding = _korean_entity_subject_binding(sentence, evidence)
    if entity_subject_binding:
        return {clean_text(item.get("id")) for item in evidence} == {
            clean_text(item.get("id")) for item in entity_subject_binding
        }
    rewritten_description_binding = _entity_rewritten_source_description_binding(sentence, evidence)
    if rewritten_description_binding:
        return {clean_text(item.get("id")) for item in evidence} == {
            clean_text(item.get("id")) for item in rewritten_description_binding
        }
    description_binding = _english_entity_prefixed_description_binding(sentence, evidence)
    if description_binding:
        return {clean_text(item.get("id")) for item in evidence} == {
            clean_text(item.get("id")) for item in description_binding
        }
    if _has_exact_renderer_source_role_binding(sentence, evidence):
        return True
    audience_relation = _english_explicit_audience_relation_binding(sentence, evidence)
    if audience_relation:
        return {clean_text(item.get("id")) for item in evidence} == {
            clean_text(item.get("id")) for item in audience_relation
        }
    korean_audience_relation = _korean_explicit_audience_relation_binding(sentence, evidence)
    if korean_audience_relation:
        return {clean_text(item.get("id")) for item in evidence} == {
            clean_text(item.get("id")) for item in korean_audience_relation
        }
    korean_ingredient_relation = _korean_entity_prefixed_ingredient_records(sentence, evidence)
    if korean_ingredient_relation:
        return {clean_text(item.get("id")) for item in evidence} == {
            clean_text(item.get("id")) for item in korean_ingredient_relation
        }
    solution_relation = _english_entity_prefixed_solution_relation_binding(sentence, evidence)
    if solution_relation:
        return {clean_text(item.get("id")) for item in evidence} == {
            clean_text(item.get("id")) for item in solution_relation
        }
    if (
        bool(evidence)
        and all(
            _evidence_record_is_relevant_to_sentence(sentence, item)
            or _english_entity_prefixed_audience_source_is_relevant(sentence, item, evidence)
            or _english_entity_prefixed_audience_identity_is_relevant(sentence, item, evidence)
            or _korean_description_suffix_identity_is_relevant(sentence, item, evidence)
            or item in _direct_assertion_frame_relevant_evidence(sentence, evidence)
            or _neutral_review_bridge_identity_is_relevant(sentence, item, evidence)
            or _source_backed_positive_review_frame_record_is_relevant(sentence, item, evidence)
            or _sentence_named_identity_is_relevant(sentence, item)
            for item in evidence
        )
        and sentence_evidence_has_direct_claim_support(sentence, evidence)
    ):
        return True
    page_scope_product = _page_scope_product_sentence_records(
        sentence, evidence, _unique_strings(clean_text(item.get("role")) for item in evidence)
    )
    if page_scope_product:
        return {clean_text(item.get("id")) for item in evidence} == {
            clean_text(item.get("id")) for item in page_scope_product
        }
    # Selection binds a sentence of any shape to the typed source atoms it
    # states, and does so only after every rung above it has declined.
    # Verification asks the same question in the same place.  Leaving this rung
    # out of one ladder and not the other made the two disagree -- a sentence
    # was bound and then its binding could not be proven, which discarded the
    # provenance of the whole field it sat in.
    typed_source_atoms = _typed_source_atom_records(sentence, evidence)
    return (
        bool(typed_source_atoms)
        and {clean_text(item.get("id")) for item in evidence}
        == {clean_text(item.get("id")) for item in typed_source_atoms}
        and sentence_evidence_has_direct_claim_support(sentence, typed_source_atoms)
    )


def sentence_provenance_has_verbatim_source_support(
    sentence: str,
    ledger: Sequence[Mapping[str, Any]],
) -> bool:
    """Allow an explicit protected sentence only when it is exact source text.

    Protected spans deliberately do not contribute an evidence ID to the
    field-level union: unlike grounded claims, they are retained because the
    caller has declared their source wording immutable. Requiring the exact
    sentence from a source-role ledger record keeps the marker from becoming a
    way to publish arbitrary unbound generated text.
    """

    normalized = clean_proposed_text(sentence)
    return bool(normalized) and any(
        clean_text(item.get("role")) == "source"
        and clean_text(item.get("sourcePath"))
        and normalized in {clean_proposed_text(source) for source in _sentences(clean_text(item.get("text")))}
        for item in ledger
    )


def _evidence_record_supports_claim(sentence: str, item: Mapping[str, Any]) -> bool:
    source_text = clean_text(item.get("text"))
    if not source_text:
        return False

    # A ledger record may preserve several source sentences.  Scope each one
    # independently: a negated sibling fact must not erase a later, directly
    # stated safety, audience, or benefit sentence from the same source text.
    return any(
        _single_source_sentence_supports_claim(sentence, source, item)
        for source in (_sentences(source_text) or [source_text])
    )


def _evidence_record_is_relevant_to_sentence(sentence: str, item: Mapping[str, Any]) -> bool:
    """Check one provenance record without letting a neighboring ID launder it."""

    if _evidence_record_supports_claim(sentence, item):
        return True
    if _commerce_listing_is_directly_source_backed(sentence, item):
        return True
    if _is_korean_entity_prefixed_description_suffix(sentence, item):
        # The description supplies the predicate/type suffix while separate
        # identity evidence supplies the branded product subject.  The
        # combination is checked below with complete token coverage.
        return True
    requested_roles = _source_role_question_roles(sentence)
    if requested_roles and _source_role_question_accepts_evidence(sentence, clean_text(item.get("role"))):
        return True
    if clean_text(item.get("role")) != "identity":
        return False
    sentence_tokens = set(_substantive_tokens(sentence))
    identity_tokens = set(_substantive_tokens(clean_text(item.get("text"))))
    relation = _CLAIM_RELATION.search(sentence)
    subject_tokens: set[str] = _claim_subject_tokens(sentence[: relation.start()]) if relation is not None else set()
    complement_tokens: set[str] = set(_substantive_tokens(sentence[relation.end() :])) if relation is not None else set()
    return bool(
        relation is not None
        and relation.group().casefold() in {"is", "are", "was", "were", "입니다", "이다"}
        and identity_tokens
        and sentence_tokens
        and (identity_tokens <= subject_tokens or identity_tokens <= complement_tokens)
    )


def _commerce_listing_is_directly_source_backed(sentence: str, item: Mapping[str, Any]) -> bool:
    """Allow a neutral page/product wrapper around a cited commerce source atom.

    Model-plan admission permits a natural page lead such as ``This product
    page lists …`` when the cited option/price text supports it.  The final
    provenance pass must retain that exact sentence-level link, but may not
    turn a commerce record into a benefit, suitability, or recommendation.
    """

    if clean_text(item.get("role")) != "commerce":
        return False
    source = clean_text(item.get("text"))
    if not source or _evidence_scope_mismatch(sentence, source):
        return False
    if (
        _claim_modalities(sentence)
        or _BENEFIT_RELATION.search(sentence)
        or _REVIEW_REFERENCE.search(sentence)
        or _COMMERCE_RATING_REFERENCE.search(sentence)
    ):
        return False
    if not re.search(
        r"\b(?:list(?:s|ed)?|available|offer(?:s|ed)?|include(?:s|d)?|contain(?:s|ed)?|has|price)\b|"
        r"(?:표기|목록|제공|판매|구성|옵션|용량|가격|포함)",
        sentence,
        re.IGNORECASE,
    ):
        return False
    source_tokens = set(_substantive_tokens(source))
    required = set(_substantive_tokens(sentence)) - _PUBLIC_COPY_TEMPLATE_TOKENS
    return bool(required and source_tokens and required <= source_tokens)


def _single_source_sentence_supports_claim(sentence: str, source: str, item: Mapping[str, Any]) -> bool:
    if not _claim_scope_matches(sentence, source):
        return False
    if _normalize_evidence(source) == _normalize_evidence(sentence):
        return True

    role = clean_text(item.get("role"))
    if role == "identity":
        # A product name identifies the entity, but never proves a separate
        # public assertion about it.
        return False

    sentence_tokens = set(_substantive_tokens(sentence))
    source_tokens = set(_substantive_tokens(source))
    if not sentence_tokens or not source_tokens:
        return False
    relation = _CLAIM_RELATION.search(sentence)

    # These renderer frames only expose the direct source atom as an
    # ingredient or review signal; they do not infer a product benefit,
    # audience, or recommendation from it.  Keep the source atom publishable
    # even when Korean grammar places its neutral frame after the atom.
    if role == "ingredient" and _FORMULA_RELATION.search(sentence) and source_tokens <= sentence_tokens:
        return True
    if role == "review" and _REVIEW_REFERENCE.search(sentence) and source_tokens <= sentence_tokens:
        return True

    if (
        relation is not None
        and not _ROLE_ENUMERATION_FRAME.search(sentence)
        and _assertion_tail_adds_unsupported_source_tokens(sentence, source, relation)
    ):
        return False
    if _requires_direct_assertion_frame(sentence):
        return (
            relation is not None
            and _relation_has_direct_source_support(sentence, source, relation)
        )

    if role in {"benefit", "effect"} and _BENEFIT_RELATION.search(sentence) and source_tokens <= sentence_tokens:
        return True
    if role in {"benefit", "effect"} and _ROLE_ENUMERATION_FRAME.search(sentence) and source_tokens <= sentence_tokens:
        return True
    if role == "usage" and source_tokens <= sentence_tokens:
        return True
    if role == "metric" and _numeric_tokens_match(sentence, source) and _evidence_token_coverage(sentence, source) >= 0.5:
        return True

    if relation is not None and _relation_has_direct_source_support(sentence, source, relation):
        return True
    return _evidence_token_coverage(sentence, source) >= 0.7


def _evidence_combination_supports_claim(sentence: str, evidence: Sequence[Mapping[str, Any]]) -> bool:
    """Admit deterministic multi-role enumeration without laundering an assertion.

    Some retained renderer sentences name the product around separately sourced
    identity, ingredient, audience, benefit, and usage atoms.  They are valid
    only when every non-template factual token is present in the matching-
    polarity source atoms.  Identity records can establish an entity/type lead,
    but cannot by themselves establish efficacy, suitability, or any other
    substantive relation.
    """

    identity = [item for item in evidence if clean_text(item.get("role")) == "identity"]
    nonidentity = [item for item in evidence if clean_text(item.get("role")) != "identity"]
    sentence_tokens = set(_substantive_tokens(sentence))
    identity_tokens = {
        token for item in identity for token in _substantive_tokens(clean_text(item.get("text")))
    }
    if not nonidentity:
        return _identity_records_support_entity_assertion(
            sentence,
            sentence_tokens,
            identity_tokens,
            [clean_text(item.get("text")) for item in identity],
        )

    source_tokens = {
        token for item in nonidentity for token in _substantive_tokens(clean_text(item.get("text")))
    }
    required = sentence_tokens - identity_tokens - _PUBLIC_COPY_TEMPLATE_TOKENS
    if not required:
        return _renderer_scope_has_nonidentity_evidence(sentence, nonidentity)
    # Safety/suitability/recommendation and direct efficacy relations retain
    # their complete assertion frame.  Adjacent source facts cannot be joined
    # to make a new group claim or an ingredient-to-benefit relationship.
    if _claim_modalities(sentence) & {"uncertain", "suitability", "recommendation", "safety"}:
        return required <= source_tokens
    if _BENEFIT_RELATION.search(sentence):
        return False
    if any(_is_korean_entity_prefixed_description_suffix(sentence, item) for item in nonidentity):
        # A Korean page lead may put an evidenced brand/product subject before
        # a direct description suffix.  Unlike ordinary renderer connective
        # prose, every remaining factual token must be covered: this keeps an
        # added audience or target qualifier from entering via the suffix.
        return required <= source_tokens
    # Renderer-owned page/FAQ prose may add a non-factual connective around
    # one or more source atoms.  It still needs at least one factual anchor;
    # otherwise the fallback would let a broad identity field stand alone.
    return bool(required & source_tokens)


def _identity_records_support_entity_assertion(
    sentence: str,
    sentence_tokens: set[str],
    identity_tokens: set[str],
    identity_texts: Sequence[str],
) -> bool:
    relation = _CLAIM_RELATION.search(sentence)
    if relation is None or relation.group().casefold() not in {"is", "are", "was", "were", "입니다", "이다"}:
        return False
    # Token comparison intentionally remains the fast path.  Korean
    # possessive particles can attach to a one-syllable brand word (for
    # example, ``랩의``), though, so retain a clause-local literal check for
    # actual identity phrases.  Both the subject and complement must be fully
    # made of identity/type records; a name alone can never cover an efficacy
    # complement.
    subject = sentence[: relation.start()]
    complement = sentence[relation.end() :]
    return bool(sentence_tokens) and (
        sentence_tokens <= identity_tokens
        or (
            _identity_clause_is_covered(subject, identity_texts)
            and _identity_clause_is_covered(complement, identity_texts)
        )
    )


def _published_identity_surfaces(identity: str) -> list[str]:
    """Return the surface forms public copy may name one recorded title under.

    Copy names the product rather than the SKU it is sold as, so the recorded
    title and that title without its pack qualifier are the same entity here.
    """

    text = clean_text(identity)
    if not text:
        return []
    without_sku = product_title_without_sku_qualifier(text)
    return [text] if without_sku == text else [text, without_sku]


def _identity_clause_is_covered(clause: str, identity_texts: Sequence[str]) -> bool:
    """Return whether a copular clause contains only direct identity phrases."""

    remaining = clean_text(clause)
    if not _substantive_tokens(remaining):
        return True
    matched = False
    surfaces = {surface for item in identity_texts for surface in _published_identity_surfaces(item)}
    for identity in sorted(surfaces, key=len, reverse=True):
        pattern = re.compile(rf"{re.escape(identity)}(?:['’]s|[은는이가을를와과의도만])?", re.I)
        remaining, count = pattern.subn(" ", remaining)
        matched = matched or bool(count)
    return matched and not _substantive_tokens(remaining)


def _renderer_scope_has_nonidentity_evidence(sentence: str, evidence: Sequence[Mapping[str, Any]]) -> bool:
    if any(clean_text(item.get("role")) == "usage" for item in evidence):
        return bool(re.search(r"\b(?:direction|routine|apply|use)\b|사용|루틴|바르", sentence, re.I))
    return any(clean_text(item.get("role")) in {"description", "benefit", "effect", "ingredient", "review", "faq", "source"} for item in evidence)


def _claim_scope_matches(sentence: str, source: str) -> bool:
    if bool(_CLAIM_NEGATION.search(sentence)) != bool(_CLAIM_NEGATION.search(source)):
        return False
    sentence_modalities = _claim_modalities(sentence)
    source_modalities = _claim_modalities(source)
    if not sentence_modalities <= source_modalities:
        return False
    # A source caveat/modality may not be silently dropped from public copy.
    return not ("uncertain" in source_modalities and "uncertain" not in sentence_modalities)


def _requires_direct_assertion_frame(value: str) -> bool:
    """Recognize sensitive assertion modalities without word lists."""

    return bool(_claim_modalities(value) & _STRICT_ASSERTION_MODALITIES)


def _assertion_tail_adds_unsupported_source_tokens(sentence: str, source: str, relation: re.Match[str]) -> bool:
    """Reject an assertion frame that adds a source-independent fact.

    Compare the complete assertion frame, including material before the
    entity and predicate.  This preserves a direct source sentence verbatim
    while keeping a population, body site, life-stage, or other added target
    from passing through lexical overlap at either edge of the assertion.
    """

    source_relation = _CLAIM_RELATION.search(source)
    if source_relation is None:
        # Renderer-owned ingredient, review, and usage frames may introduce a
        # neutral verb around a source atom.  The atom must remain the terminal
        # fact in the sentence, so no ungrounded qualifier can be appended to
        # it through lexical overlap.
        return not _normalize_evidence(sentence).endswith(_normalize_evidence(source))
    sentence_tokens = _substantive_tokens(sentence)
    source_tokens = set(_substantive_tokens(source))
    if not source_tokens:
        return True
    return bool(set(sentence_tokens) - source_tokens)


def _direct_assertion_frame_relevant_evidence(
    sentence: str,
    evidence: Sequence[Mapping[str, Any]],
) -> list[Mapping[str, Any]]:
    """Return the exact source and identity records covering one assertion frame.

    A direct benefit atom may omit the product subject (for example, ``supports
    hydration``).  It can be rendered with a product or brand only when the
    sentence subject is fully covered by exact identity records.  This is not
    a broad ledger fallback: a target introduced before or beside that entity
    remains an uncovered source-independent token and is rejected.
    """

    relation = _CLAIM_RELATION.search(sentence)
    if relation is None or _ROLE_ENUMERATION_FRAME.search(sentence):
        return []
    identity = [item for item in evidence if clean_text(item.get("role")) == "identity"]
    identity_tokens = {
        token for item in identity for token in _substantive_tokens(clean_text(item.get("text")))
    }
    sentence_tokens = set(_substantive_tokens(sentence))
    sentence_subject = sentence[: relation.start()]
    if not sentence_tokens:
        return []

    for item in evidence:
        role = clean_text(item.get("role"))
        if role == "identity" or (role == "ingredient" and _BENEFIT_RELATION.search(sentence)):
            continue
        for source in _sentences(clean_text(item.get("text"))) or [clean_text(item.get("text"))]:
            if role == "usage" and _source_suffix_has_identity_framed_usage_prefix(sentence, source, identity):
                relevant = [item]
                relevant.extend(
                    identity_item
                    for identity_item in identity
                    if _identity_text_is_in_assertion_subject(clean_text(identity_item.get("text")), sentence[: -len(source)])
                )
                return relevant
            source_relation = _CLAIM_RELATION.search(source)
            if not source_relation or not _claim_scope_matches(sentence, source):
                continue
            if not _relation_has_direct_source_support(sentence, source, relation):
                continue
            source_tokens = set(_substantive_tokens(source))
            required = sentence_tokens - identity_tokens - _PUBLIC_COPY_TEMPLATE_TOKENS
            if not required <= source_tokens:
                continue
            if not _assertion_subject_is_covered_by_source_and_identity(
                sentence_subject,
                source[: source_relation.start()],
                identity,
            ):
                continue
            relevant = [item]
            relevant.extend(
                identity_item
                for identity_item in identity
                if _identity_text_is_in_assertion_subject(clean_text(identity_item.get("text")), sentence_subject)
            )
            return relevant
    return []


def _source_suffix_has_identity_framed_usage_prefix(
    sentence: str,
    source: str,
    identity: Sequence[Mapping[str, Any]],
) -> bool:
    """Allow a neutral usage label only around the exact source instruction."""

    normalized_source = _normalize_evidence(source)
    normalized_sentence = _normalize_evidence(sentence)
    if not normalized_source or not normalized_sentence.endswith(normalized_source):
        return False
    prefix = clean_text(sentence[: -len(source)])
    if not prefix:
        return False
    identity_tokens = {
        token for item in identity for token in _substantive_tokens(clean_text(item.get("text")))
    }
    prefix_tokens = set(_substantive_tokens(prefix))
    return bool(prefix_tokens) and prefix_tokens <= identity_tokens | _PUBLIC_COPY_TEMPLATE_TOKENS


def _assertion_subject_is_covered_by_source_and_identity(
    sentence_subject: str,
    source_subject: str,
    identity: Sequence[Mapping[str, Any]],
) -> bool:
    """Require every substantive subject token to be a source or identity phrase."""

    remaining = clean_text(sentence_subject)
    supported_phrases = [source_subject, *(clean_text(item.get("text")) for item in identity)]
    matched = False
    for phrase in sorted({clean_text(value) for value in supported_phrases if clean_text(value)}, key=len, reverse=True):
        pattern = re.compile(rf"{re.escape(phrase)}(?:['’]s|[은는이가을를와과의도만])?", re.I)
        remaining, count = pattern.subn(" ", remaining)
        matched = matched or bool(count)
    return matched and not _substantive_tokens(remaining)


def _identity_text_is_in_assertion_subject(identity: str, subject: str) -> bool:
    return any(
        re.search(
            rf"{re.escape(surface)}(?:['’]s|[은는이가을를와과의도만])?(?=\s|[,.;!?。！？]|$)",
            subject,
            re.I,
        )
        for surface in _published_identity_surfaces(identity)
    )


def _entity_rewritten_source_description_binding(
    sentence: str,
    evidence: Sequence[Mapping[str, Any]],
) -> list[Mapping[str, Any]]:
    """Bind an identity-only source-subject expansion without changing its predicate."""

    return _english_rewritten_source_description_binding(
        sentence, evidence
    ) or _korean_rewritten_source_description_binding(sentence, evidence)


def _english_rewritten_source_description_binding(
    sentence: str,
    evidence: Sequence[Mapping[str, Any]],
) -> list[Mapping[str, Any]]:
    rendered = clean_text(sentence)
    if not rendered or "?" in rendered:
        return []
    identities = [item for item in evidence if clean_text(item.get("role")) == "identity"]
    products = [
        item
        for item in identities
        if clean_text(item.get("sourcePath")).endswith(("product.name", "product.originalName"))
    ]
    brands = [item for item in identities if clean_text(item.get("sourcePath")).endswith("product.brand")]
    for item in evidence:
        if clean_text(item.get("role")) not in {"description", "source"} or not clean_text(item.get("sourcePath")):
            continue
        for source in _sentences(clean_text(item.get("text"))) or [clean_text(item.get("text"))]:
            for product in products:
                product_text = clean_text(product.get("text"))
                source_subject = re.match(
                    rf"{re.escape(product_text)}(?=\s|[,.;:!?]|$)", source, re.IGNORECASE
                )
                if source_subject is None:
                    continue
                predicate = source[source_subject.end() :]
                for brand in brands:
                    brand_text = clean_text(brand.get("text"))
                    for subject in (
                        f"{product_text} from {brand_text}",
                        f"{brand_text}'s {product_text}",
                        f"{brand_text} {product_text}",
                    ):
                        expected = f"{subject}{predicate}"
                        if _normalize_evidence(expected) == _normalize_evidence(rendered):
                            return [brand, product, item]
    return []


def _korean_rewritten_source_description_binding(
    sentence: str,
    evidence: Sequence[Mapping[str, Any]],
) -> list[Mapping[str, Any]]:
    rendered = clean_text(sentence)
    if not rendered or not re.search(r"[가-힣]", rendered):
        return []
    identities = [item for item in evidence if clean_text(item.get("role")) == "identity"]
    products = [
        item
        for item in identities
        if clean_text(item.get("sourcePath")).endswith(("product.name", "product.originalName"))
    ]
    brands = [item for item in identities if clean_text(item.get("sourcePath")).endswith("product.brand")]
    for item in evidence:
        if clean_text(item.get("role")) not in {"description", "source"} or not clean_text(item.get("sourcePath")):
            continue
        for source in _sentences(clean_text(item.get("text"))) or [clean_text(item.get("text"))]:
            for product in products:
                product_text = clean_text(product.get("text"))
                source_subject = re.match(rf"^{re.escape(product_text)}(?:은|는|이|가)(?P<predicate>.+)$", source)
                if source_subject is None:
                    continue
                predicate = source_subject.group("predicate")
                for brand in brands:
                    entity = f"{clean_text(brand.get('text'))}의 {product_text}"
                    expected = f"{entity}{_korean_topic_particle(entity)}{predicate}"
                    if _normalize_evidence(expected) == _normalize_evidence(rendered):
                        return [brand, product, item]
    return []


def _korean_topic_particle(value: str) -> str:
    stem = re.sub(r"\s*\([^)]*\)\s*$", "", value).rstrip()
    last = stem[-1] if stem else ""
    if not ("가" <= last <= "힣"):
        return "은"
    return "은" if (ord(last) - ord("가")) % 28 else "는"


def _english_entity_prefixed_description_binding(
    sentence: str,
    evidence: Sequence[Mapping[str, Any]],
) -> list[Mapping[str, Any]]:
    """Bind a named product to one exact, terse source description.

    Sparse PDPs sometimes provide only a noun phrase such as ``Daily hydration
    cream for dry skin.``  The deterministic renderer may introduce that
    phrase with a complete brand/product subject, but the source phrase itself
    must remain intact (apart from an initial article).  This closed frame
    avoids treating an adjacent source record as support for a new benefit,
    suitability, or recommendation claim.
    """

    rendered = clean_text(sentence)
    source_predicate_binding = _english_entity_prefixed_source_predicate_binding(rendered, evidence)
    if source_predicate_binding:
        return source_predicate_binding
    match = re.fullmatch(
        r"(?P<prefix>.+?)\s+(?:is\s+(?:described\s+as\s+)?|offers\s+)(?P<description>.+?)[.!?。！？]?",
        rendered,
        re.IGNORECASE,
    )
    if match is None or _numeric_tokens(rendered):
        return []
    identities = _english_entity_prefixed_audience_identity_records(
        clean_text(match.group("prefix")), evidence
    )
    description = clean_text(match.group("description"))
    if not identities or not description or "?" in description:
        return []
    for item in evidence:
        if clean_text(item.get("role")) not in {"description", "source"} or not clean_text(item.get("sourcePath")):
            continue
        for source in _sentences(clean_text(item.get("text"))) or [clean_text(item.get("text"))]:
            if _english_description_predicate_matches(description, source):
                return [*identities, item]
    return []


def _english_entity_prefixed_source_predicate_binding(
    sentence: str,
    evidence: Sequence[Mapping[str, Any]],
) -> list[Mapping[str, Any]]:
    """Bind an identity-only subject added to an exact source predicate.

    A source description may be a complete predicate with its subject omitted,
    for example ``Detangles wet hair.``.  The renderer can make that sentence
    citation-ready by adding only a structured product/brand subject.  This
    closed comparison retains the exact predicate and object, so it cannot
    turn a nearby source record into a new benefit or recommendation claim.
    """

    rendered = clean_text(sentence)
    if not rendered or "?" in rendered or _numeric_tokens(rendered):
        return []
    identities = [item for item in evidence if clean_text(item.get("role")) == "identity"]
    products = [
        item
        for item in identities
        if clean_text(item.get("sourcePath")).endswith(("product.name", "product.originalName"))
    ]
    brands = [item for item in identities if clean_text(item.get("sourcePath")).endswith("product.brand")]
    if not products:
        return []
    for item in evidence:
        if clean_text(item.get("role")) not in {"description", "source"} or not clean_text(item.get("sourcePath")):
            continue
        for source in _sentences(clean_text(item.get("text"))) or [clean_text(item.get("text"))]:
            if not source or "?" in source or not english_subjectless_predicate(source):
                continue
            for product in products:
                product_text = clean_text(product.get("text"))
                subjects: list[tuple[str, list[Mapping[str, Any]]]] = [(product_text, [product])]
                for brand in brands:
                    brand_text = clean_text(brand.get("text"))
                    subjects.extend(
                        (
                            (f"{product_text} from {brand_text}", [product, brand]),
                            (f"{brand_text}'s {product_text}", [brand, product]),
                            (f"{brand_text} {product_text}", [brand, product]),
                        )
                    )
                for subject, identity_records in subjects:
                    if _normalize_evidence(f"{subject} {source}") == _normalize_evidence(rendered):
                        return [*identity_records, item]
    return []


def _english_description_predicate_matches(rendered: str, source: str) -> bool:
    """Compare a source noun phrase after the renderer adds only its article."""

    candidate = _normalize_evidence(rendered)
    original = _normalize_evidence(source)
    if not candidate or not original:
        return False
    return _without_english_leading_article(candidate) == _without_english_leading_article(original)


def _without_english_leading_article(value: str) -> str:
    return re.sub(r"^(?:a|an|the)\s+", "", value, flags=re.IGNORECASE)


def _english_entity_prefixed_audience_source_is_relevant(
    sentence: str,
    item: Mapping[str, Any],
    evidence: Sequence[Mapping[str, Any]],
) -> bool:
    """Return whether this source row is part of a closed audience binding."""

    return item in _english_explicit_audience_relation_binding(sentence, evidence)


def _english_entity_prefixed_audience_identity_is_relevant(
    sentence: str,
    item: Mapping[str, Any],
    evidence: Sequence[Mapping[str, Any]],
) -> bool:
    """Return whether this identity row is part of a closed audience binding."""

    return item in _english_explicit_audience_relation_binding(sentence, evidence)


def _english_explicit_audience_relation_binding(
    sentence: str,
    evidence: Sequence[Mapping[str, Any]],
) -> list[Mapping[str, Any]]:
    """Bind a natural product subject to one explicit, source-stated audience relation.

    The connector deliberately recognizes only a small closed grammar.  It
    preserves the source relation (for example, ``works best for`` stays
    ``works best for``) and exact target list, then attaches only the identity
    atoms that form the named subject.  It cannot turn an audience fact into a
    new recommendation, benefit, safety, or causal claim.
    """

    rendered = clean_text(sentence)
    rendered_match = re.fullmatch(
        r"(?P<prefix>.+?)\s+(?P<relation>works\s+best\s+for|is\s+intended\s+for|"
        r"is\s+suitable\s+for|is\s+designed\s+for|is\s+formulated\s+for|is\s+for)\s+"
        r"(?P<target>[^.!?。！？]+)[.!?。！？]?",
        rendered,
        re.IGNORECASE,
    )
    if rendered_match is None or _numeric_tokens(rendered):
        return []
    prefix = clean_text(rendered_match.group("prefix"))
    identities = _english_entity_prefixed_audience_identity_records(prefix, evidence)
    if not identities:
        return []
    rendered_relation = re.sub(r"^is\s+", "", rendered_match.group("relation"), flags=re.IGNORECASE)
    rendered_target = _normalized_audience_relation_target(rendered_match.group("target"))
    if not rendered_target:
        return []
    for item in evidence:
        if clean_text(item.get("role")) not in {"source", "audience"} or not clean_text(item.get("sourcePath")):
            continue
        source_match = re.fullmatch(
            r"(?P<relation>works\s+best\s+for|intended\s+for|suitable\s+for|designed\s+for|formulated\s+for)"
            r"\s*:?\s*(?P<target>[^.!?。！？]+)[.!?。！？]?",
            clean_text(item.get("text")),
            re.IGNORECASE,
        )
        if source_match is None:
            continue
        source_relation = clean_text(source_match.group("relation")).casefold()
        relation_is_preserved = source_relation == clean_text(rendered_relation).casefold()
        relation_is_audience_summary = (
            clean_text(rendered_relation).casefold() == "for"
            and source_relation
            in {"works best for", "intended for", "suitable for", "designed for", "formulated for"}
        )
        if (
            not (relation_is_preserved or relation_is_audience_summary)
            or _normalized_audience_relation_target(source_match.group("target")) != rendered_target
        ):
            continue
        return [*identities, item]
    return []


def _korean_explicit_audience_relation_binding(
    sentence: str,
    evidence: Sequence[Mapping[str, Any]],
) -> list[Mapping[str, Any]]:
    """Bind a named Korean product to one source-stated recommendation target.

    This is intentionally a closed relation-preserving frame: it only adds
    structured product/brand identity before the exact target and source verb.
    It cannot turn a nearby skin-type label into a new suitability, benefit,
    safety, or causal conclusion.
    """

    rendered = clean_text(sentence)
    rendered_match = re.fullmatch(
        r"(?P<prefix>.+?)(?:은|는|이|가)\s+(?P<target>.+?)(?:에|에게)\s*"
        r"(?P<relation>추천(?:됩니다|되었(?:습니다|다)?|합니다)?|권장(?:됩니다|되었(?:습니다|다)?|합니다)?)[.!?。！？]?",
        rendered,
    )
    if rendered_match is None:
        return []
    prefix = clean_text(rendered_match.group("prefix"))
    identities = _korean_entity_prefixed_audience_identity_records(prefix, evidence)
    if not identities:
        return []
    target = _normalized_audience_relation_target(rendered_match.group("target"))
    relation = clean_text(rendered_match.group("relation"))
    if not target or not relation:
        return []
    for item in evidence:
        if clean_text(item.get("role")) not in {"source", "audience"} or not clean_text(item.get("sourcePath")):
            continue
        source_match = re.fullmatch(
            r"(?P<target>.+?)(?:에|에게)\s*(?P<relation>추천(?:됩니다|되었(?:습니다|다)?|합니다)?|권장(?:됩니다|되었(?:습니다|다)?|합니다)?)[.!?。！？]?",
            clean_text(item.get("text")),
        )
        if source_match is None:
            continue
        if (
            _normalized_audience_relation_target(source_match.group("target")) == target
            and clean_text(source_match.group("relation")) == relation
        ):
            return [*identities, item]
    return []


def _korean_entity_prefixed_audience_identity_records(
    prefix: str,
    evidence: Sequence[Mapping[str, Any]],
) -> list[Mapping[str, Any]]:
    """Resolve only exact Korean product or brand-plus-product subjects."""

    identities = [item for item in evidence if clean_text(item.get("role")) == "identity" and clean_text(item.get("text"))]
    products = [
        item
        for item in identities
        if clean_text(item.get("sourcePath")).endswith(("product.name", "product.originalName"))
    ]
    brands = [item for item in identities if clean_text(item.get("sourcePath")).endswith("product.brand")]
    for product in products:
        if prefix == clean_text(product.get("text")):
            return [product]
    for brand in brands:
        for product in products:
            if prefix == f"{clean_text(brand.get('text'))}의 {clean_text(product.get('text'))}":
                return [brand, product]
    return []


def _korean_entity_prefixed_ingredient_records(
    sentence: str,
    evidence: Sequence[Mapping[str, Any]],
) -> list[Mapping[str, Any]]:
    """Bind a named Korean product to an exact, neutral ingredient list.

    This is intentionally narrower than a general composition paraphrase:
    the only inserted language is the product/brand subject and ``포함합니다``.
    It also keeps a numeric SKU token, such as ``BarrierCare365``, from being
    mistaken for a measurement before the exact ingredient atoms are checked.
    """

    match = _KOREAN_ENTITY_INGREDIENT_FRAME.fullmatch(clean_proposed_text(sentence))
    if match is None:
        return []
    identity = _review_frame_identity_records(
        clean_text(match.group("subject")), evidence, allow_brand_product=True
    )
    ingredients = _renderer_comma_list_records(
        clean_text(match.group("items")),
        evidence,
        roles=frozenset({"ingredient"}),
        source_path=re.compile(r"^product\.ingredients\[\d+\]$"),
    ) or _korean_renderer_joined_list_records(
        clean_text(match.group("items")),
        evidence,
        roles=frozenset({"ingredient"}),
        source_path=re.compile(r"^product\.ingredients\[\d+\]$"),
    )
    return [*identity, *ingredients] if identity and ingredients else []


def _english_entity_prefixed_solution_relation_binding(
    sentence: str,
    evidence: Sequence[Mapping[str, Any]],
) -> list[Mapping[str, Any]]:
    """Bind a named-product attribution to one exact, source-stated solution phrase.

    The renderer may attach the structured product identity to a terse source
    sentence such as ``A solution for fine lines``.  This closed grammar keeps
    the source's ``solution for`` relation and its exact concern list intact;
    it does not turn nearby benefits or ingredients into a recommendation or
    a causal claim.
    """

    rendered = clean_text(sentence)
    rendered_match = re.fullmatch(
        r"(?P<prefix>.+?)\s+is\s+(?:described\s+as\s+)?(?P<relation>(?:a\s+)?solution\s+for)\s+"
        r"(?P<detail>[^.!?。！？]+)[.!?。！？]?",
        rendered,
        re.IGNORECASE,
    )
    if rendered_match is None or _numeric_tokens(rendered):
        return []
    identities = _english_entity_prefixed_audience_identity_records(
        clean_text(rendered_match.group("prefix")), evidence
    )
    detail = _normalized_audience_relation_target(rendered_match.group("detail"))
    if not identities or not detail:
        return []
    for item in evidence:
        if clean_text(item.get("role")) not in {"benefit", "effect", "source"} or not clean_text(item.get("sourcePath")):
            continue
        source_match = re.fullmatch(
            r"(?:a\s+)?solution\s+for\s+(?P<detail>[^.!?。！？]+)[.!?。！？]?",
            clean_text(item.get("text")),
            re.IGNORECASE,
        )
        if source_match is not None and _normalized_audience_relation_target(source_match.group("detail")) == detail:
            return [*identities, item]
    return []


def _normalized_audience_relation_target(value: str) -> str:
    """Compare an audience tail without changing the set, order, or meaning."""

    return re.sub(r"\s+", " ", clean_text(value).rstrip(".!?。！？")).casefold()


def _english_entity_prefixed_audience_identity_records(
    prefix: str,
    evidence: Sequence[Mapping[str, Any]],
) -> list[Mapping[str, Any]]:
    """Resolve an exact product identity subject, with no editorial filler."""

    identities = [item for item in evidence if clean_text(item.get("role")) == "identity" and clean_text(item.get("text"))]
    for product in identities:
        if prefix == clean_text(product.get("text")):
            return [product]
    for brand in identities:
        for product in identities:
            if brand is product:
                continue
            brand_text = clean_text(brand.get("text"))
            product_text = clean_text(product.get("text"))
            if prefix in {
                f"{brand_text}'s {product_text}",
                f"{brand_text} {product_text}",
                f"{product_text} from {brand_text}",
            }:
                return [brand, product]
    return []


def _is_korean_entity_prefixed_description_suffix(sentence: str, item: Mapping[str, Any]) -> bool:
    """Recognize a direct Korean description following an identity subject.

    The model-free page renderer can make a sparse source description into a
    fluent page lead such as ``브랜드의 제품은 <source description>``.  The
    source record is relevant only for that exact predicate suffix; it does
    not independently establish the leading entity.  Callers therefore pair
    it with identity evidence and require full non-identity token coverage.
    """

    if clean_text(item.get("role")) != "description":
        return False
    source = clean_text(item.get("text"))
    rendered = clean_text(sentence)
    if not source or not rendered.endswith(source) or rendered == source:
        return False
    if not re.search(r"[가-힣]", source):
        return False
    prefix = rendered[: -len(source)]
    return bool(_substantive_tokens(prefix)) and _claim_scope_matches(rendered, source)


def _korean_description_suffix_identity_is_relevant(
    sentence: str,
    item: Mapping[str, Any],
    evidence: Sequence[Mapping[str, Any]],
) -> bool:
    """Bind an identity only when it appears in a direct Korean description lead."""

    if clean_text(item.get("role")) != "identity":
        return False
    identity = clean_text(item.get("text"))
    if not identity:
        return False
    for source_item in evidence:
        if not _is_korean_entity_prefixed_description_suffix(sentence, source_item):
            continue
        source = clean_text(source_item.get("text"))
        prefix = clean_text(sentence)[: -len(source)]
        if re.search(
            rf"{re.escape(identity)}(?:['’]s|[은는이가을를와과의도만])?(?=\s|[,.;!?。！？]|$)",
            prefix,
            re.I,
        ):
            return True
    return False


def _claim_modalities(value: str) -> set[str]:
    return {label for label, pattern in _CLAIM_MODALITIES if pattern.search(value)}


def _numeric_tokens_match(sentence: str, source: str) -> bool:
    numeric = {item.casefold() for item in _numeric_tokens(sentence)}
    return bool(numeric) and numeric <= {item.casefold() for item in _numeric_tokens(source)}


def _relation_has_direct_source_support(sentence: str, source: str, relation: re.Match[str]) -> bool:
    source_relation = _CLAIM_RELATION.search(source)
    if source_relation is None:
        return False
    sentence_subject = _claim_subject_tokens(sentence[: relation.start()])
    source_subject = _claim_subject_tokens(source[: source_relation.start()])
    if source_subject and sentence_subject and not (source_subject <= sentence_subject or sentence_subject <= source_subject):
        return False
    relation_tokens = set(_substantive_tokens(sentence[relation.start() :]))
    source_tokens = set(_substantive_tokens(source))
    return bool(relation_tokens) and relation_tokens <= source_tokens


def _claim_subject_tokens(value: str) -> set[str]:
    return {token for token in _substantive_tokens(value) if token not in _GENERIC_ENTITY_TOKENS}


def _image_provenance(ids: Sequence[str], ledger: Sequence[Mapping[str, Any]]) -> dict[str, list[str]]:
    images: list[str] = []
    by_id = {str(item.get("id")): item for item in ledger if item.get("id")}
    for identifier in ids:
        images.extend(
            str(item) for item in as_list(as_dict(by_id.get(identifier)).get("imageUrls")) if isinstance(item, str)
        )
    return {"imageUrls": _unique_strings(images)} if images else {}


def _kind_for_path(path: str) -> str:
    if path == "Product.description":
        return "product-description"
    if path == "WebPage.description":
        return "webpage-description"
    if path.endswith(".name"):
        return "faq-question"
    if path.startswith("FAQPage."):
        return "faq-answer"
    return "howto-step"


def _path_index(path: str, prefix: str) -> int | None:
    matched = re.match(rf"^{re.escape(prefix)}\[(\d+)]", path)
    return int(matched.group(1)) if matched else None


def _immutable_tokens(text: str, product: Mapping[str, Any], public_name: str) -> list[str]:
    candidates = [
        public_name,
        clean_text(product.get("name")),
        clean_text(product.get("originalName")),
        clean_text(product.get("brand")),
        *[clean_text(item) for item in as_list(product.get("ingredients"))],
        *[clean_text(item) for item in as_list(as_dict(product.get("semanticFacts")).get("ingredients"))],
        *_numeric_tokens(text),
        *[item.group(0) for item in _IDENTIFIER_TOKEN.finditer(text)],
    ]
    return sorted({item for item in candidates if item and _normalized_includes(text, item)}, key=len, reverse=True)


def _minimum_ratio(kind: str) -> float:
    return 0.55 if kind == "faq-question" else 0.35


def _locale_compatible(original: str, candidate: str, locale: str) -> bool:
    patterns = {"ko-KR": r"[가-힣]", "ja-JP": r"[ぁ-んァ-ン一-龯]", "en-US": r"[A-Za-z]", "en-GB": r"[A-Za-z]"}
    pattern = patterns.get(locale)
    if not pattern:
        return True
    original_letters = len(re.findall(r"[\w가-힣ぁ-んァ-ン一-龯]", original))
    original_target = len(re.findall(pattern, original))
    candidate_letters = len(re.findall(r"[\w가-힣ぁ-んァ-ン一-龯]", candidate))
    candidate_target = len(re.findall(pattern, candidate))
    if original_letters == 0 or original_target / original_letters < 0.35:
        return True
    return candidate_letters > 0 and candidate_target / candidate_letters >= 0.3


def _numeric_tokens(value: str) -> list[str]:
    return numeric_tokens(value)


def _claim_modality(value: str) -> list[str]:
    patterns = {
        "not": r"\b(?:not|no|never|without)\b|않|없|아니|못",
        "may": r"\b(?:may|might|could)\b|가능성|도울\s*수",
        "review": r"\b(?:review|reviews|customer)\b|리뷰|후기|고객",
        "measure": r"\b(?:reported|measured|tested|study|result|proven)\b|측정|시험|연구|결과|입증",
        "cause": r"\b(?:because|therefore|causes?|due\s+to|through)\b|때문|통해|효과",
    }
    lowered = value.casefold()
    return [name for name, pattern in patterns.items() if re.search(pattern, lowered, re.IGNORECASE)]


def _review_scope_signature(value: str) -> tuple[bool, bool, bool, bool]:
    return (
        bool(re.search(r"\b(?:review|reviews|customer feedback)\b|(?:고객\s*)?(?:리뷰|후기)", value, re.I)),
        bool(re.search(r"\b(?:one|a single)\s+(?:customer\s+)?review\b|(?:한|1명의?)\s*(?:고객\s*)?(?:리뷰|후기)", value, re.I)),
        bool(re.search(r"\b(?:customers|reviewers|reviews\s+(?:show|mention|indicate))\b|(?:고객들|여러\s*(?:고객|리뷰)|공통\s*(?:경향|반응)|고객\s*리뷰에서는)", value, re.I)),
        bool(re.search(r"\bpositive\s+reviews?\b|긍정(?:적인)?\s*(?:리뷰|후기)", value, re.I)),
    )


def _introduces_ingredient_causality(original: str, candidate: str, product: Mapping[str, Any]) -> bool:
    ingredients = [clean_text(value) for value in as_list(product.get("ingredients"))]
    ingredients.extend(clean_text(value) for value in as_list(as_dict(product.get("semanticFacts")).get("ingredients")))
    candidate_normalized = _normalize_evidence(candidate)
    for ingredient in _unique_strings(ingredients):
        normalized = _normalize_evidence(ingredient)
        if not normalized or normalized not in candidate_normalized:
            continue
        candidate_relation = any(
            normalized in _normalize_evidence(sentence) and _INGREDIENT_RELATION.search(sentence)
            for sentence in _sentences(candidate)
        )
        original_relation = any(
            normalized in _normalize_evidence(sentence) and _INGREDIENT_RELATION.search(sentence)
            for sentence in _sentences(original)
        )
        if candidate_relation and not original_relation:
            return True
    return False


def _has_page_role(value: str) -> bool:
    return bool(re.search(r"\b(?:official\s+)?(?:product\s+)?page\b|제품\s*페이지|상품\s*페이지", value, re.I))


def _removes_distinct_sentence(original: str, candidate: str) -> bool:
    candidate_sentences = {_normalize_evidence(sentence) for sentence in _sentences(candidate)}
    original_sentences = [_normalize_evidence(sentence) for sentence in _sentences(original)]
    for sentence in dict.fromkeys(original_sentences):
        if sentence and sentence not in candidate_sentences and original_sentences.count(sentence) == 1:
            return True
    return False


def _speech_acts(value: str) -> list[str]:
    result: list[str] = []
    for sentence in _sentences(value):
        result.append(
            "question"
            if re.search(r"[?？]\s*$", sentence)
            else "exclamation"
            if re.search(r"[!！]\s*$", sentence)
            else "statement"
        )
    return _collapse_adjacent(result)


def _protected_punctuation(value: str) -> str:
    return "".join(character for character in value if character in "\"'“”‘’()[]{}:;/—–-")


def _surface_only_change(original: str, candidate: str, kind: str) -> tuple[bool, set[IssueCode]]:
    original_sentences = _sentences(original)
    candidate_sentences = _sentences(candidate)
    original_tokens = [_normal_tokens(sentence) for sentence in original_sentences]
    candidate_tokens = [_normal_tokens(sentence) for sentence in candidate_sentences]
    collapsed_original = _collapse_adjacent(original_tokens)
    collapsed_candidate = _collapse_adjacent(candidate_tokens)
    if collapsed_original == collapsed_candidate:
        required: set[IssueCode] = set()
        if len(candidate_sentences) < len(original_sentences):
            required.add("duplicate-sentence")
        if _collapse_adjacent(_tokens(original)) == _collapse_adjacent(_tokens(candidate)) and len(
            _tokens(candidate)
        ) < len(_tokens(original)):
            required.add("duplicate-word")
        if not required:
            required.add("punctuation")
        return True, required
    if kind != "howto-step" and _simple_grammar_change(original, candidate):
        return True, {"grammar"}
    return False, set()


def _simple_grammar_change(original: str, candidate: str) -> bool:
    pairs = ((" are ", " is "), (" is ", " are "), (" a ", " an "), (" an ", " a "), ("는 ", "은 "), ("은 ", "는 "))
    left, right = f" {original.casefold()} ", f" {candidate.casefold()} "
    for old, new in pairs:
        if old in left and left.replace(old, new, 1) == right:
            return True
    return False


def _strip_punctuation(value: str) -> str:
    return re.sub(r"[^\w가-힣ぁ-んァ-ン一-龯%]+", "", value).casefold()


def _normal_tokens(value: str) -> list[str]:
    return [item.casefold() for item in _tokens(value)]




def _normalize_evidence(value: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w%]+", " ", unicodedata.normalize("NFC", value).casefold())).strip()


def _tokens(value: str) -> list[str]:
    return word_tokens(value)


def _normalized_includes(value: str, candidate: str) -> bool:
    return " ".join(_normal_tokens(candidate)) in " ".join(_normal_tokens(value))


def _protected_spans_are_preserved_verbatim(candidate: str, protected: Sequence[object]) -> bool:
    """Check every protected source sentence without normalizing punctuation."""

    remaining = _sentences(candidate)
    for raw_sentence in protected:
        sentence = str(raw_sentence)
        try:
            remaining.remove(sentence)
        except ValueError:
            return False
    return True


def _sentences(value: str) -> list[str]:
    return [item.strip() for item in _SENTENCE_SPLIT.split(value) if item.strip()]


def _collapse_adjacent[T](values: Sequence[T]) -> list[T]:
    return [item for index, item in enumerate(values) if index == 0 or item != values[index - 1]]


def _unique_strings(values: Iterable[object]) -> list[str]:
    result: list[str] = []
    for value in values:
        text = str(value).strip()
        if text and text not in result:
            result.append(text)
    return result


def _merge_usage(first: object, second: object) -> object:
    return merge_token_usage(first, second)


createPdpGeoPublicCopyProvenance = create_pdp_geo_public_copy_provenance
finalProofreadPdpGeoArtifacts = final_proofread_pdp_geo_artifacts
stableTextHash = stable_text_hash
pdpGeoFinalProofreadingJsonSchema = pdp_geo_final_proofreading_json_schema

__all__ = [
    "ModelBackedFinalProofreader",
    "clean_proposed_text",
    "create_pdp_geo_public_copy_provenance",
    "createPdpGeoPublicCopyProvenance",
    "final_proofread_pdp_geo_artifacts",
    "finalProofreadPdpGeoArtifacts",
    "pdp_geo_final_proofreading_json_schema",
    "pdpGeoFinalProofreadingJsonSchema",
    "stable_text_hash",
    "stableTextHash",
]
