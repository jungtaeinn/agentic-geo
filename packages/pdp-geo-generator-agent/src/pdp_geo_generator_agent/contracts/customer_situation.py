"""Whose situation a text states, and whose question it asks.

A FAQ question belongs to a customer rather than to an analyst when it says
something about the reader -- who they are, what they are trying to do, or when
they need it -- and then asks for a product for that.  Two different things can
carry that, and they are different in kind:

1. **what the situation is about** is domain identity -- an audience, or a
   concern the category exists to address.  Like the substrates the suitability
   contract owns, these are the entities allowed to fill the slot, so they are
   named here rather than derived;
2. **that a situation is stated at all** is a rule, so it is read off
   structure.  A purpose, a condition, a wish and an occasion are each marked by
   closed-class morphology -- Korean's nominalizer in front of an adnominal
   predicate, its benefactive, intent, conditional and desire endings, the
   adnominal ending its bound occasion nouns take, English's subordinators, its
   temporal prepositions and its gerund purpose complement -- and no evaluative
   or domain word is enumerated: whatever the writer put in the purpose slot
   reads the same, in either market.

Reading only (1) rejected every question whose reader was described in words
the list did not hold.  ``색조 메이크업을 세정하기 좋은 추천 제품이 있을까요?``
states its purpose plainly and carries no concern noun, so a metric a page had
measured could never become the situation a customer asks about.

The other half of the same distinction is the analyst's question, and it is
read by what the question asks *about* rather than by where it puts the words.
The guard that used to keep source headings out was anchored to the start of a
sentence, so it stopped 2 of 15 recorded analyst questions and let the rest
bind: ``For dry skin, which ingredients are listed on the PDP?`` only had to
put a customer in front of the heading.  A question is the source's wherever it
stands, so it is read wherever it stands.  It was then read by its predicate
alone, which is the first list problem again: the recording acts are identity,
but which of them is the record's own is structure -- an act nobody is said to
have performed is the page's, and an act with a subject is that subject's.

This module decides nothing about answers being supported or recommendations
being licensed; it only reads whose voice a text is in.
"""

from __future__ import annotations

import re

from .suitability import audience_designations

# The concerns a cosmetic customer's situation can be about, and the words that
# name the reader outright.  This is domain identity, not a rule: the rule is
# structural and lives below.
_KOREAN_SITUATION_SUBJECT = re.compile(
    r"(?:고민|피부|관리|루틴|케어|건조|당김|보습|수분|탄력|장벽|민감|노화|주름|결|광채|"
    r"목표|원하|필요|고객|사용자)",
)
_JAPANESE_SITUATION_SUBJECT = re.compile(
    r"(?:悩み|肌|ケア|ルーティン|乾燥|うるおい|保湿|ハリ|弾力|バリア|敏感|エイジング|"
    r"しわ|目的|求め|必要|人|使用者)",
)
_ENGLISH_SITUATION_SUBJECT = re.compile(
    r"\b(?:skin|concerns?|goals?|routine|care|dry(?:ness)?|tightness|hydration|moisture|"
    r"firm(?:ness)?|elasticity|fine\s+lines?|wrinkles?|radiance|barrier|sensitive|"
    r"dull(?:ness)?|aging|texture|looking\s+for|want(?:ing)?|need(?:ing)?|people|customers?|those)\b",
    re.IGNORECASE,
)

# Korean marks a purpose by nominalizing the act with ``-기`` and letting an
# adnominal predicate modify what is being asked for, so the slot after the
# nominalizer is read structurally: ``세정하기 좋은``, ``세정하기 편한`` and
# ``세정하기에 알맞은`` are one form with three of the writer's words in it.
_KOREAN_NOMINALIZED_PURPOSE = re.compile(r"[가-힣]기(?:에)?\s+(?P<modifier>[가-힣]+)(?=\s)")
# An adnominal ending is not a letter of its own -- ``-(으)ㄴ`` and ``-(으)ㄹ``
# fuse into the syllable they close, so ``좋은``, ``편한``, ``쉬운`` and ``쓸``
# are one ending written four ways.  Reading the spelling instead of the coda
# recognized only the stems that happen to keep ``은`` visible, which is the
# same as enumerating the writer's word.
_KOREAN_ADNOMINAL_CODA = frozenset({4, 8})
_HANGUL_SYLLABLE_BASE = 0xAC00
_HANGUL_FINAL_COUNT = 28
# The remaining situation markers are endings, not words: a benefactive, an
# intent, a conditional, and a wish.
_KOREAN_SITUATION_FRAME = re.compile(
    r"[가-힣](?:기|을|를|이|가)?\s*위(?:한|해|하여)(?=\s|$)"
    r"|(?:으?려면|으?려고|고자)"
    r"|(?:다면|라면|으면|시면|하면|되면)(?=\s)"
    r"|고\s*싶",
)
# An occasion is the fifth, and it is marked the same structural way.  ``때``
# and ``경우`` are bound nouns: they take an adnominal clause, so what states
# the occasion is the ending that closes that clause and not the verb carrying
# it.  Writing the verbs out recognized ``쓰는 때`` and ``할 때`` while refusing
# ``고를 때`` -- one ending on the writer's own word -- and requiring something
# after the bound noun refused it again at the end of a phrase, which is
# exactly where a CEP label puts it (``아침저녁 매일 쓰는 세안제를 고를 때``).
_KOREAN_OCCASION = re.compile(r"(?P<predicate>[가-힣])\s*(?:때|경우)(?=\s|$|[,.에은는의])")
# English marks the same relations with subordinators, with a temporal
# preposition, and with a gerund purpose complement.  All three are function
# words, so the act or moment being named stays the writer's: "for removing
# makeup" and "for softening the beard" read alike, and so do "after
# cleansing" and "before bed".
#
# The occasion prepositions were missing while Korean's ``때``/``경우`` were
# read, which is the asymmetry this module exists to avoid: ``immediately
# after cleansing`` states exactly the occasion ``세안 후`` states, and only
# one of the two was the customer speaking.
_ENGLISH_SITUATION_FRAME = re.compile(
    r"\b(?:if|when|whenever|while|unless|once|after|before|during|in\s+case)\b"
    r"|\bfor\s+[a-z]+ing\b",
    re.IGNORECASE,
)


# What an analyst's question asks about.  Two things can stand where a shopper
# would put the thing they are choosing, and neither is something anyone buys:
#
# 1. a part of the page or of the record -- the page, its source, a field, a
#    section, a label, a caption, a bookkeeping entry such as a rating.  These
#    are the page's own furniture, so choosing among them is choosing where to
#    read rather than what to use;
# 2. nothing at all, because the question reports an act of inscription that
#    nobody is said to have performed.  Writing something down is what a page
#    does and never what a product does, so ``어떤 효과가 표기되어 있나요?``
#    asks after the record even though the effect it names is the product's
#    own.
#
# Both classes are named for the reason the situation subjects above are
# named: which entities may fill a slot is domain identity.  A page has a fixed
# set of parts, and a fixed set of acts it performs on them.
#
# What is *not* identity is who is performing the act, and reading the
# predicate without that was the defect.  A verb on the list decided the
# question on its own, so every ordinary product question that happened to use
# one became the source's -- all eight of the predicate-only matches measured
# on a live row were shoppers asking what a product does (``which serum
# provides that support?``, ``피부 타입을 표시하고 제품을 고를 때 ...``) -- while the
# five analyst questions whose act the list omitted bound as customers'.  That
# is the enumeration failing in both directions at once.
#
# So the act counts only in the record's own voice, which is the voice with no
# agent in it: English's passive and Korean's ``-되어/돼`` resultative.  Nothing
# but a page can have written what nobody is said to have written.  An active
# predicate reports its own subject's act instead, and when that subject really
# is the record, (1) has already named it -- ``Which source field lists the
# rating?`` is read there, not here.
_PAGE_RECORD_OBJECT = re.compile(
    r"\b(?:pages?|sources?|PDP|fields?|sections?|listings?|labels?|captions?|descriptions?"
    r"|ratings?|scores?)\b"
    r"|(?:페이지|원문|출처|상품정보|섹션|항목|필드|평점|라벨)",
    re.IGNORECASE,
)
# The acts a record performs on its own parts, read only where no one is said
# to perform them.  English suppresses the agent with the passive; Korean does
# it with the ``-되-`` passive the act's verbal noun takes.
_INSCRIPTION_IN_THE_RECORDS_VOICE = re.compile(
    r"\b(?:is|are|was|were|been|being)\s+(?:listed|stated|shown|displayed|mentioned|noted"
    r"|described|written|printed|indicated|recorded|declared|disclosed|specified|documented)\b"
    r"|(?:표기|기재|명시|나열|표시|기록|수록|게재|기술|고지|안내|공지|소개|적혀|쓰여)(?:되어|되었|돼|된|되)",
    re.IGNORECASE,
)


def asks_what_the_source_recorded(value: str) -> bool:
    """Return whether a question asks what the page wrote down rather than what to use.

    A shopper's question puts the thing they are choosing in the interrogative
    slot and asks the product to do something.  An analyst's question puts the
    record there instead, or asks after the act of recording, and it does that
    wherever in the sentence it happens to stand: ``For dry skin, which
    ingredients are listed on the PDP?`` is the same heading as ``Which
    ingredients are listed?`` with a customer in front of it, and a guard tied
    to the start of the sentence read the first as a customer's.

    A question that chooses a product form and asks what the product itself has
    done -- ``Which cleansing foam has completed a dermatologist test?``,
    ``which serum provides that support?`` -- is not this.  Neither a test a
    product completed nor a benefit it provides is an act of inscription, and
    the product is the one performing it.
    """

    text = value.strip()
    if not text or not re.search(r"[?\uff1f]\s*$", text):
        return False
    return (
        _PAGE_RECORD_OBJECT.search(text) is not None
        or _INSCRIPTION_IN_THE_RECORDS_VOICE.search(text) is not None
    )


def _states_a_korean_nominalized_purpose(value: str) -> bool:
    """Return whether an act nominalized with ``-기`` is modifying what is asked for."""

    for match in _KOREAN_NOMINALIZED_PURPOSE.finditer(value):
        modifier = match.group("modifier")
        if (ord(modifier[-1]) - _HANGUL_SYLLABLE_BASE) % _HANGUL_FINAL_COUNT in _KOREAN_ADNOMINAL_CODA:
            return True
    return False


def _states_a_korean_occasion(value: str) -> bool:
    """Return whether a bound occasion noun is closing an adnominal clause."""

    return any(
        (ord(match.group("predicate")) - _HANGUL_SYLLABLE_BASE) % _HANGUL_FINAL_COUNT in _KOREAN_ADNOMINAL_CODA
        for match in _KOREAN_OCCASION.finditer(value)
    )


def states_a_customer_situation(value: str, locale: str) -> bool:
    """Return whether a text speaks of the reader's own situation.

    It does when it names who the situation is about, or when it states a
    purpose, condition, wish or occasion the reader holds.  Either alone is
    enough: a question may describe the reader ("건조한 피부에 쓸 제품") or state
    only the goal ("세정하기 좋은 제품"), and both are the customer speaking.
    """

    text = value.strip()
    if not text:
        return False
    if audience_designations(text):
        return True
    if locale == "ko-KR":
        return (
            _KOREAN_SITUATION_SUBJECT.search(text) is not None
            or _states_a_korean_nominalized_purpose(text)
            or _states_a_korean_occasion(text)
            or _KOREAN_SITUATION_FRAME.search(text) is not None
        )
    if locale == "ja-JP":
        return _JAPANESE_SITUATION_SUBJECT.search(text) is not None
    return (
        _ENGLISH_SITUATION_SUBJECT.search(text) is not None
        or _ENGLISH_SITUATION_FRAME.search(text) is not None
    )
