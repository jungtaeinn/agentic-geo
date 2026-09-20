"""The product a title names, apart from the SKU it is sold as."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import Any

from .._json import clean_text
from .sentence_form import (
    ENGLISH_FUNCTION_WORDS,
    KOREAN_CONTAINMENT_FRAME_FORMS,
    KOREAN_PHRASE_CLOSING_PARTICLE_ALTERNATION,
    korean_content_stem,
    strip_korean_particle,
)

_BRACKETED_QUALIFIER = re.compile(r"\[[^\]]{1,36}\]")
_TRAILING_MEASURE = re.compile(r"\s+\d+(?:\.\d+)?\s*(?:ml|mL|g|oz|fl\.?\s*oz|매|개|입)\s*$", re.IGNORECASE)
_MEASURE_ONWARDS = re.compile(r"\s+\d+(?:\.\d+)?\s*(?:ml|mL|g|oz|fl\.?\s*oz)\b.*$", re.IGNORECASE)


def product_title_without_sku_qualifier(value: str) -> str:
    """Return the product a title names, without the pack it is sold in.

    A page title carries the promotion brackets and the pack size of the SKU on
    sale, but the entity public copy is about is the product, not the pack.
    Copy therefore names the product without them, and provenance has to
    recognise the source title behind that name -- otherwise every frame that
    checks a sentence's subject against the recorded title fails for exactly
    the products whose title states a size.  Both sides read this definition.
    """

    text = re.sub(r"\s+", " ", _BRACKETED_QUALIFIER.sub(" ", value)).strip()
    text = _MEASURE_ONWARDS.sub("", _TRAILING_MEASURE.sub("", text)).strip()
    return text or re.sub(r"\s+", " ", value).strip()


# Words that name a kind of thing rather than any particular one.  A page may
# point at its own product with one of these instead of naming it, and no
# comparison of two entity references may treat them as the entity.
GENERIC_ENTITY_NOUNS = frozenset(
    {"product", "formula", "formulation", "item", "it", "this", "that", "제품", "상품", "제형", "포뮬러", "포뮬라", "처방", "이것"}
)

# The nouns that name the *kind* of thing the entity is, and nothing else.  A
# sentence that has already named the product may point back at it by its kind
# -- ``…을 완료한 제품입니다``, ``is a product that …`` -- and that word heads no
# claim of its own, so neither side of a comparison counts it.
#
# This is deliberately narrower than ``GENERIC_ENTITY_NOUNS`` above, which
# answers a different question: what a page may point at its own product
# *with*, which includes a demonstrative and the product's formula.  Taking
# that wider set out of a comparison took claims out with it.  ``SAMPLE_DERMA …는
# 피부과 처방입니다`` kept only ``피부과`` after the subtraction and bound to a
# record reading ``피부과 테스트 완료``, publishing a dermatology prescription
# the source never wrote: ``처방`` heads a claim, while ``제품`` heads nothing.
ENTITY_KIND_NOUNS = frozenset({"product", "item", "제품", "상품"})

_KOREAN_GENERIC_NOUN_ALTERNATION = "|".join(
    sorted((noun for noun in GENERIC_ENTITY_NOUNS if re.search(r"[가-힣]", noun)), key=len, reverse=True)
)
_KOREAN_DEICTIC_SELF_REFERENCE = re.compile(
    rf"^(?:이|본|해당|동|그)\s*(?:{_KOREAN_GENERIC_NOUN_ALTERNATION})(?:은|는|이|가)\s+"
)


def korean_deictic_self_reference(value: str) -> re.Match[str] | None:
    """Return a sentence-initial deictic reference to the product it is about.

    A product page can point at its own product ("이 제품은 …") instead of
    naming it.  Public copy is read away from that page, where the pointing
    lands on nothing, so the product is named there instead.  Substituting a
    coreferent subject states the same thing about the same entity, which is
    why provenance recognises the result as the source sentence it came from.
    """

    return _KOREAN_DEICTIC_SELF_REFERENCE.match(value.strip())


_ENGLISH_GENERIC_NOUN_ALTERNATION = "|".join(
    sorted((noun for noun in GENERIC_ENTITY_NOUNS if noun.isascii() and len(noun) > 2), key=len, reverse=True)
)
_ENGLISH_DEICTIC_SELF_REFERENCE = re.compile(
    rf"^(?:it|(?:this|that|the)\s+(?:{_ENGLISH_GENERIC_NOUN_ALTERNATION}))\s+(?=[a-z])",
    re.IGNORECASE,
)
_ENGLISH_SENTENCE_SUBJECT = re.compile(r"^\s*(?:[A-Za-z]+,\s+)?(?P<subject>[A-Za-z]+)\s+(?=[a-z])")
_ENGLISH_GROUP_PRONOUNS = frozenset({"they", "these", "those", "them", "both"})


def english_deictic_self_reference(value: str) -> re.Match[str] | None:
    """Return a sentence-initial reference standing in for the product itself.

    English points at the product with a pronoun or a demonstrative rather than
    repeating its name.  Published copy is read away from the page that
    supplied the referent, so the product is named in that slot instead.  The
    substitution is coreferent, which is why provenance still recognises the
    source sentence behind the result.
    """

    return _ENGLISH_DEICTIC_SELF_REFERENCE.match(value.strip())


def english_refers_to_an_unnamed_group(value: str) -> bool:
    """Return whether a sentence's subject is a group named only outside it.

    ``Together, they strengthen the skin barrier`` is about two ingredients a
    previous sentence named.  Nothing inside the sentence says which, and the
    published order is not the source's, so the reference cannot be resolved --
    unlike a singular reference to the product, which the page's own subject
    supplies.  Such a sentence is left out rather than published pointing at
    nothing.
    """

    match = _ENGLISH_SENTENCE_SUBJECT.match(value.strip())
    return match is not None and match.group("subject").casefold() in _ENGLISH_GROUP_PRONOUNS

def contains_entity_identity_phrase(value: str, entity: str) -> bool:
    """Return whether an entity is visible as an independent source phrase.

    Product and brand labels are citation identity, not character substrings.
    In particular, ``Glow`` is not an explicit brand reference inside
    ``Afterglow`` and ``로라`` is not one inside ``아로라``.  The Unicode-aware
    word boundaries deliberately allow ordinary punctuation and possessives,
    so ``Glow's Afterglow Serum`` and ``Afterglow Serum from Glow`` remain
    valid named references.
    """

    text, phrase = clean_text(value), clean_text(entity)
    if not text or not phrase:
        return False
    return re.search(
        rf"(?<!\w){re.escape(phrase)}(?=$|[^\w]|[은는이가을를와과의도만])",
        text,
        re.IGNORECASE,
    ) is not None


# A name in prose is closed by whatever particle its slot needs, and a particle
# is what comes *after* a name, so it has to close in turn.  ``크림에센스``
# therefore does not close ``크림``: there ``에`` opens a longer noun, and
# reading it as a particle would let a sibling product's name pass as this
# one's.
_KOREAN_PARTICLE_CLOSED_TAIL = rf"(?:{KOREAN_PHRASE_CLOSING_PARTICLE_ALTERNATION})(?:$|[^\w])"


def contains_entity_identity_phrase_in_prose(value: str, entity: str) -> bool:
    """Return whether a sentence names an entity in the slot its grammar gives it.

    Korean carries a noun's role on the noun, so a name written into prose is
    spelled with whatever particle its slot needs -- ``클렌징폼은`` as a topic,
    ``클렌징폼에`` inside the containment phrase this locale states what a
    product holds with, ``클렌징폼으로`` as a means.

    The reader beside this one closes a name on a boundary or on one of eleven
    subject and object particles, which is what a *title* needs and what the
    surfaces deciding a title need it to stay: ``_product_name`` reads it to
    decide whether Product.name needs its brand prefixed, and the description
    gate reads it to decide whether a model's own sentence is published instead
    of the deterministic one.  Prose needs every slot, so it is read here
    instead of by widening that one.
    """

    text, phrase = clean_text(value), clean_text(entity)
    if not text or not phrase:
        return False
    return (
        re.search(
            rf"(?<!\w){re.escape(phrase)}(?=$|[^\w]|{_KOREAN_PARTICLE_CLOSED_TAIL})",
            text,
            re.IGNORECASE,
        )
        is not None
    )


def korean_product_reference(name: str, brand: str) -> str:
    """Use the supplied brand as a compact, independently quotable entity label."""

    return f"{brand}의 {name}" if brand and not contains_entity_identity_phrase(name, brand) else name


def product_entity_reference(product: Mapping[str, Any], name: str, locale: str) -> str:
    """Name the product so a lifted sentence still says what it is about.

    Every surface that publishes a claim about the product -- customer
    feedback, a measured result -- needs the same entity label, so the label
    is defined once here rather than per surface.
    """

    brand = clean_text(product.get("brand"))
    if not brand or contains_entity_identity_phrase(name, brand):
        return name
    if locale in {"en-US", "en-GB"}:
        return f"{brand}'s {name}"
    return korean_product_reference(name, brand) if locale == "ko-KR" else f"{brand} {name}"


# How a market points back at an entity it has already named instead of naming
# it again.  These stand in a determiner's slot: they identify which entity the
# noun after them is, and say nothing about it, which is why a span built out of
# them plus the entity's own words names the entity and asserts nothing.
#
# This is the closed class of grammar that fills that slot, not a rule written
# as words -- the rule is that the span must be nothing but a reference.  Korean
# writes the back-pointing word as an adnominal and English as a determiner, and
# the inventory is per market for that reason alone; a possessive points at a
# holder the discourse already introduced, which on a product page is the page's
# own product.  The Korean deictic ``이`` is spelled like the nominative
# particle and comes off as one, so registering it here would add nothing.
_ENTITY_BACK_REFERENCE_FORMS = (
    "같은",
    "본",
    "해당",
    "동",
    "그",
    "same",
    "said",
    "our",
    "their",
    "his",
    "her",
    "my",
    "your",
)
_REFERENCE_WORD = re.compile(r"[A-Za-z가-힣][A-Za-z0-9가-힣-]*")
# The English possessive clitic marks who holds the thing after it and names
# nothing of its own, and it is written apart from the word it closes, so a
# reader that splits on letters alone leaves it standing as a word ("Morrow
# Lab's" -> ``lab``, ``s``) that no name can account for.
_ENGLISH_POSSESSIVE_CLITIC = re.compile(r"['’]s\b", re.IGNORECASE)
_KOREAN_CONTAINMENT_OWNER_TAIL = "|".join(KOREAN_CONTAINMENT_FRAME_FORMS)
# English fronts the owner in a prepositional phrase and closes it with a comma,
# which is the form the FAQ contract asks for ("In {product}, {ingredient} …").
# It is the same relation Korean marks with a particle and a containment
# adnominal, so both are read here as one frame.
_ENGLISH_CONTAINMENT_OWNER = re.compile(r"^(?:in|with)\s+(?P<owner>[^,]{1,80}),\s+(?=\S)", re.IGNORECASE)


def _reference_words(span: str) -> list[str]:
    """Return the words a span states, each in the one form all its spellings share.

    A word left standing where the product's name was removed is usually the
    marking that closed it -- a Korean particle, an English possessive clitic --
    and marking states nothing, so it is not one of the span's words at all.
    Everything else is reduced the way the contract reduces any Korean word,
    which is what lets a word be registered once rather than in each spelling it
    can arrive in.
    """

    words: list[str] = []
    for raw in _REFERENCE_WORD.findall(_ENGLISH_POSSESSIVE_CLITIC.sub(" ", span)):
        word = raw.casefold().strip("-")
        if not word:
            continue
        if re.search(r"[가-힣]", word):
            if not strip_korean_particle(word):
                continue
            word = korean_content_stem(word)
        words.append(word)
    return words


# Registered in the form ``_reference_words`` produces, so one entry covers
# every spelling of the word rather than the one it was written in.
_ENTITY_BACK_REFERENCE_WORDS = frozenset(
    word for form in _ENTITY_BACK_REFERENCE_FORMS for word in _reference_words(form)
)


def span_names_only_the_entity(span: str, names: Sequence[str]) -> bool:
    """Return whether a span refers to one product and states nothing about it.

    A record keeps the pack size the schema does not publish and prose calls the
    product by the published title, so both spellings are set aside; so is a
    word that names the kind of thing rather than a particular one, because a
    page points back at its own product with it ("the same serum", "같은 제품").
    What is left has to be grammar -- a function word, a back-pointing
    determiner, punctuation -- or the span states something of its own and is
    not a reference.

    An adjective the record never filed is exactly what that last clause keeps
    out: "in the gentle serum" leaves ``gentle`` standing, so the span is read
    as the clause's own words and nothing is taken off it.
    """

    remainder = clean_text(span)
    spellings = sorted(
        {
            spelling
            for value in names
            for spelling in (clean_text(value), product_title_without_sku_qualifier(clean_text(value)))
            if spelling
        },
        key=len,
        reverse=True,
    )
    for spelling in spellings:
        remainder = re.sub(re.escape(spelling), " ", remainder, flags=re.IGNORECASE)
    # A page points back at the product with a word its own name carries -- "the
    # same **serum**" for a product named "… Serum" -- so a word of the name is
    # the name, however much of it the writer repeated.
    name_words = {word for spelling in spellings for word in _reference_words(spelling)}
    for word in _reference_words(remainder):
        if (
            word in name_words
            or word in ENTITY_KIND_NOUNS
            or word in GENERIC_ENTITY_NOUNS
            or word in ENGLISH_FUNCTION_WORDS
            or word in _ENTITY_BACK_REFERENCE_WORDS
        ):
            continue
        return False
    return True


def clause_without_containment_owner(clause: str, names: Sequence[str]) -> str:
    """Return a clause without the phrase naming who holds what it is about.

    The containment phrase names the product the part belongs to, which every
    record of that part already says, so it states no fact of its own -- and it
    stands where the clause's own subject would.  Reading the clause with it
    still in front puts the product in the slot the source gave the ingredient,
    so the reader either finds the assertion attributed to something its source
    never predicated it of, or finds no subject to hold fixed at all.

    The phrase counts as the owner only when nothing but a reference to the
    product stands there.  Anything else in that span is the clause's own words,
    so the clause is returned untouched and read as it was written.

    Both stages read this one definition: the planner decides on it which claim
    a clause is about, and the final proofreader decides on it which source
    sentence that clause may rest on.  Two readings of one sentence would let a
    clause pass one stage as an ingredient's and the other as the product's.
    """

    text = clean_text(clause)
    english = _ENGLISH_CONTAINMENT_OWNER.match(text)
    if english is not None and span_names_only_the_entity(english.group("owner"), names):
        return text[english.end() :]
    match = re.search(rf"(?:{_KOREAN_CONTAINMENT_OWNER_TAIL})\s+", text)
    if match is None or match.start() == 0:
        return text
    if not span_names_only_the_entity(text[: match.start()], names):
        return text
    return text[match.end() :]
