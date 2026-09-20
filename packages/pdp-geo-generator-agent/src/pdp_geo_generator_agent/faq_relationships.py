"""Relationship evidence cards for model-authored PDP FAQ composition.

This module deliberately does not render public questions or answers.  It
turns normalized product facts and ledger records into compact, traceable
cards so an LLM can reason about a customer's decision without being handed
raw FAQ headings or Python-owned prose templates.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import Any

from neo_js_compat import js_fnv1a32_unsigned

from ._json import as_dict, as_list, clean_text
from .contracts.enumeration import has_unpredicated_enumeration
from .contracts.product_identity import product_title_without_sku_qualifier
from .contracts.sentence_form import (
    names_a_thing,
    source_statement_matches,
    split_into_sentences,
    strip_korean_inflection,
)
from .contracts.suitability import is_suitability_statement
from .contracts.usage import (
    has_routine_placement_cue,
    is_raw_page_text_block,
    is_safety_or_test_claim_usage,
    usage_text_without_step_marker,
)
from .normalization import infer_pdp_evidence_roles

_CARD_MAX_CLAIM_LENGTH = 320
_CARD_STRUCTURAL_ARTIFACT = re.compile(r"[☑□■]|(?:\||\t)")

# The fields a card claim records its content in.  A claim is a record rather
# than a sentence: extraction files the ingredient, the outcome, the measured
# value and the conditions it was measured under into fields of their own, and
# ``text`` is only the source line the record was cut from.  Asking "what does
# this claim say?" therefore means reading all of them.
#
# Two stages ask it -- card admission in planning and the final proofreader --
# and they read this one list so that a field cannot say something to one stage
# and nothing to the other.  Admission read ``text`` alone, which made the
# metric path impossible to satisfy: it required the recorded method and study
# group to appear in the sentence while measuring that same sentence against a
# ``text`` that need not contain either.
CARD_CLAIM_CONTENT_FIELDS: tuple[str, ...] = (
    "text",
    "ingredient",
    "benefit",
    "effect",
    "metric",
    "outcome",
    "value",
    "unit",
    "timing",
    "method",
    "sample",
    "caveat",
)


def build_faq_relationship_cards(
    product: Mapping[str, Any], ledger: Sequence[Mapping[str, Any]], locale: str
) -> list[dict[str, Any]]:
    """Build ranked, non-public evidence cards for a model FAQ-planning pass.

    A card groups only source-backed claims.  ``relationship`` tells the
    model whether two facts may be connected in one sentence (``explicit``)
    or must remain independently stated (``independent``).  The model owns
    question choice, CEP reasoning, and all public prose.
    """

    records = [as_dict(record) for record in ledger if as_dict(record)]
    # Copy names the product, not the pack it is sold in.  The rendered
    # ``Product.name`` is already the title without its size or option suffix,
    # so a card that hands the model the recorded title teaches it to write a
    # SKU label the published entity does not carry.  The evidence id still
    # points at the recorded title; only the surface the model reads changes.
    product_name = product_title_without_sku_qualifier(clean_text(product.get("name")))
    brand = clean_text(product.get("brand"))
    identity = [
        {**claim, "text": product_title_without_sku_qualifier(clean_text(claim.get("text")))}
        for claim in _claims_from_records(
            [
                record
                for record in records
                if clean_text(record.get("role")) == "identity"
                and clean_text(record.get("sourcePath")) in {"product.name", "product.originalName", "product.brand"}
            ],
            role="identity",
            relationship="explicit",
        )
    ]
    if not product_name or not identity:
        return []

    semantic = as_dict(product.get("semanticFacts"))
    audience = _select_card_claims(_audience_claims(records, semantic), 2, locale=locale, prioritize_fit=True)
    concern = _select_card_claims(_concern_claims(records, locale), 2, locale=locale, prioritize_fit=True)
    links = _select_card_claims(_explicit_formula_effect_claims(records, semantic), 2)
    # One fact is offered once, under the role it is.  A record already offered
    # as the audience, or as the source of an explicit formula/effect link, is
    # not also offered as a buyer concern: the model cites the claim it read,
    # and two claims carrying one fact leave the citation ambiguous about which
    # fact it supports -- which is what made an admitted answer fail its own
    # source-support check.
    concern = _drop_claims_offered_elsewhere(concern, audience, semantic)
    ingredients = _select_card_claims(
        _claims_from_records(
            [record for record in records if clean_text(record.get("role")) == "ingredient"],
            role="ingredient",
            relationship="independent",
        ),
        3,
    )
    benefits = _select_card_claims(
        _claims_from_records(
            [record for record in records if clean_text(record.get("role")) in {"benefit", "effect"}],
            role="benefit",
            relationship="independent",
        ),
        3,
    )
    # A card shows the step the published HowTo shows.  Handing the model the
    # printed step number taught it to cite one surface and write another, and
    # a FAQ answer may bind only to what it cited -- so the step went out
    # unbindable.  The evidence id still points at the recorded step; only the
    # surface the model reads changes.
    usage = [
        {**claim, "text": usage_text_without_step_marker(clean_text(claim.get("text")))}
        for claim in _select_card_claims(
            _claims_from_records(
                _schema_published_usage_records(records),
                role="usage",
                relationship="explicit",
            ),
            3,
        )
    ]
    safety = _select_card_claims(
        _claims_from_records(
            [
                record
                for record in records
                if clean_text(record.get("role")) == "safety"
                or (
                    clean_text(record.get("role")) == "source"
                    and is_safety_or_test_claim_usage(clean_text(record.get("text")))
                )
            ],
            role="safety",
            relationship="explicit",
        ),
        2,
    )
    metrics = _select_card_claims(_metric_claims(records, semantic), 2)

    cards: list[dict[str, Any]] = []
    # A shopper deciding on a product reads the recorded result as part of the
    # same answer: the concern, the choice, the formula's role, and what the
    # source measured.  Splitting the measurement into a card of its own left
    # the decision answer unable to carry it at all, so the metric records this
    # card may cite travel with it.  Admission still validates a published
    # measurement against its own value, group, timing and method.
    decision_claims = _unique_claims([*identity, *concern, *audience, *links, *metrics])
    # A recommendation needs an actual explanation.  An explicit formula/effect
    # link can carry that reason in one sentence; independently sourced formula
    # and benefit atoms are still useful, but only together and only as separate
    # answer sentences.  A target plus an ingredient list alone is not enough.
    if (concern or audience) and (links or (ingredients and benefits)):
        cards.append(
            _card(
                "buyer-decision",
                decision_claims
                if links
                else _unique_claims([*identity, *concern, *audience, *ingredients, *benefits, *metrics]),
                product_name,
                brand,
                can_recommend=_has_explicit_fit_relation([*concern, *audience], locale),
            )
        )
    if links:
        cards.append(_card("formula-effect", _unique_claims([*identity, *links]), product_name, brand))
    elif ingredients and benefits:
        cards.append(
            _card(
                "formula-and-benefit",
                _unique_claims([*identity, *ingredients, *benefits]),
                product_name,
                brand,
            )
        )
    # A procedure is not a buying decision.  "거품을 냅니다" answers no question a
    # buyer asked -- every product of the form is used that way -- and the
    # ordered procedure is published as HowTo, so a FAQ row built from it both
    # repeats that field and asks a question nobody searched for.  What a buyer
    # does decide on is where the product sits in their routine, so a usage
    # card is offered only for the usage facts that state that.  The procedural
    # steps stay in the ledger, and HowTo keeps publishing them.
    routine_usage = [
        claim for claim in usage if has_routine_placement_cue(clean_text(claim.get("text")))
    ]
    if routine_usage:
        cards.append(_card("usage", _unique_claims([*identity, *routine_usage]), product_name, brand))
    if safety:
        cards.append(_card("safety", _unique_claims([*identity, *safety]), product_name, brand))
    if metrics:
        cards.append(_card("evidence-result", _unique_claims([*identity, *metrics]), product_name, brand))
    return _dedupe_cards(cards)


_PUBLISHED_USAGE_SOURCE_PATH = re.compile(r"^product\.usage\[\d+\]$")


def _schema_published_usage_records(records: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Return the usage records the published procedure is rendered from.

    One step reaches the ledger under more than one surface: the recorded
    instruction and a reconstruction of it filed as an evidence sentence.
    Offering both teaches the model to cite one and write the other, and a FAQ
    answer may bind only to what it cited.  The procedure HowTo publishes is
    rendered from the recorded instructions, so those are the ones a card
    offers; the reconstructions remain in the ledger for every other reader.
    """

    usage = [record for record in records if clean_text(record.get("role")) == "usage"]
    recorded = [
        record
        for record in usage
        if _PUBLISHED_USAGE_SOURCE_PATH.fullmatch(clean_text(record.get("sourcePath"))) is not None
    ]
    return [dict(record) for record in (recorded or usage)]


def _card(
    intent: str, claims: Sequence[Mapping[str, Any]], product_name: str, brand: str, *, can_recommend: bool = False
) -> dict[str, Any]:
    evidence_ids = _unique_strings(
        identifier for claim in claims for identifier in as_list(claim.get("evidenceIds")) if clean_text(identifier)
    )
    stable_key = "|".join([intent, product_name, *evidence_ids])
    return {
        "id": f"faq-{intent}-{_base36(js_fnv1a32_unsigned(stable_key))}",
        "intent": intent,
        "productName": product_name,
        **({"brand": brand} if brand else {}),
        "canRecommend": can_recommend,
        "claims": [dict(claim) for claim in claims],
        "evidenceIds": evidence_ids,
    }


def _claims_from_records(records: Sequence[Mapping[str, Any]], *, role: str, relationship: str) -> list[dict[str, Any]]:
    claims: list[dict[str, Any]] = []
    for record in records:
        text, identifier = clean_text(record.get("text")), clean_text(record.get("id"))
        if text and identifier and _is_card_claim_text_ready(text):
            claims.append({"role": role, "relationship": relationship, "text": text, "evidenceIds": [identifier]})
    return _unique_claims(claims)


def _audience_claims(records: Sequence[Mapping[str, Any]], semantic: Mapping[str, Any]) -> list[dict[str, Any]]:
    claims = _claims_from_records(
        [
            record
            for record in records
            if clean_text(record.get("role")) == "audience"
            and _is_card_claim_text_ready(clean_text(record.get("text")))
        ],
        role="audience",
        relationship="explicit",
    )
    # The ledger assigns the audience role per source field, so a sentence that
    # names whom the product suits is typed as audience only when extraction
    # recorded the audience as a field of its own.  When it recorded none, the
    # sentence is still in the ledger under whichever array carried it -- a
    # usage list, an FAQ answer, a page source -- and the card would otherwise
    # have no customer to answer for at all.  Reading the suitability contract
    # recovers exactly that case; where the role is populated the ledger's own
    # typing stands, so a card that already names its audience is unchanged.
    #
    # A review is excluded whichever way it was typed: it states one customer's
    # own experience, and turning a shopper's "perfect for my skin" into the
    # product's claim about whom it suits is a different assertion.
    if not claims:
        claims = _claims_from_records(
            [
                record
                for record in records
                if clean_text(record.get("role")) != "review"
                and _is_card_claim_text_ready(clean_text(record.get("text")))
                and is_suitability_statement(clean_text(record.get("text")))
            ],
            role="audience",
            relationship="explicit",
        )
    known = {clean_text(claim.get("text")).casefold() for claim in claims}
    for value in as_list(semantic.get("evidenceSentences")):
        text = clean_text(value)
        roles = set(as_list(as_dict(infer_pdp_evidence_roles(text)).get("roles")))
        if text and _is_card_claim_text_ready(text) and "audience" in roles and text.casefold() not in known:
            evidence_ids = _matching_evidence_ids(text, records)
            if evidence_ids:
                claims.append(
                    {"role": "audience", "relationship": "explicit", "text": text, "evidenceIds": evidence_ids}
                )
                known.add(text.casefold())
    return _unique_claims(claims)


def _drop_claims_offered_elsewhere(
    concern: Sequence[Mapping[str, Any]],
    audience: Sequence[Mapping[str, Any]],
    semantic: Mapping[str, Any],
) -> list[dict[str, Any]]:
    """Return the concerns that no other role already offers.

    A concern is what the buyer is trying to solve.  An audience record states
    who the product is for, and a formula/effect link states what an ingredient
    does -- each is offered as the role it is, and offering it a second time as
    a concern gives the model two claims for one fact.
    """

    audience_texts = {clean_text(claim.get("text")) for claim in audience}
    link_sources = {
        text
        for raw in as_list(semantic.get("ingredientBenefitLinks"))
        for field in ("sourceText", "sentence")
        if (text := clean_text(as_dict(raw).get(field)))
    }
    return [
        dict(claim)
        for claim in concern
        if (text := clean_text(claim.get("text"))) and text not in audience_texts and text not in link_sources
    ]


def _concern_claims(records: Sequence[Mapping[str, Any]], locale: str) -> list[dict[str, Any]]:
    claims: list[dict[str, Any]] = []
    for record in records:
        text = clean_text(record.get("text"))
        if (
            not text
            or not _is_card_claim_text_ready(text)
            or is_safety_or_test_claim_usage(text)
            or _is_measurement_or_result_record(record)
            or clean_text(record.get("role")) not in {"source", "description", "audience", "concern"}
        ):
            continue
        # A short heading such as "Solution for" is not a usable claim by
        # itself.  It is paired with its nearby substantive source value
        # below, so it cannot accidentally admit a question about facts that
        # the selected card never recorded.
        if _looks_like_concern_heading(text, locale):
            continue
        if not _looks_like_explicit_concern(text, locale):
            continue
        evidence_ids = _matching_evidence_ids(text, records)
        if evidence_ids:
            claims.append({"role": "concern", "relationship": "explicit", "text": text, "evidenceIds": evidence_ids})
    # PDP extraction often preserves a short concern heading and its substantive
    # value as adjacent source records.  Keep that source-local pairing as an
    # internal semantic fact; it gives the model a useful target without
    # exposing a raw heading as a public FAQ template.
    claims.extend(_paired_concern_claims(records, locale))
    return _unique_claims(claims)


def _is_measurement_or_result_record(record: Mapping[str, Any]) -> bool:
    """Keep quantified result evidence on a result card, not as a buyer need."""

    path = clean_text(record.get("sourcePath"))
    if "semanticFacts.metricClaims" in path or clean_text(record.get("role")) == "metric":
        return True
    text = clean_text(record.get("text"))
    measurement = re.search(r"\d+(?:[.,]\d+)?\s*(?:[%％]|배|x\b|times?\b|fold\b|points?\b)", text, re.IGNORECASE)
    result_context = re.search(
        r"(?:after|within|over|day|week|month|usage?|use|improv|increas|decreas|reduc|recover|"
        r"사용\s*\d|\d\s*일|개선|증가|감소|회복|평가|시험|테스트|測定|改善|増加|減少)",
        text,
        re.IGNORECASE,
    )
    return bool(measurement and result_context)


def _paired_concern_claims(records: Sequence[Mapping[str, Any]], locale: str) -> list[dict[str, Any]]:
    indexed = sorted(
        [
            (position, record)
            for position, record in enumerate(records)
            if clean_text(record.get("text")) and _source_array_index(clean_text(record.get("sourcePath"))) is not None
        ],
        key=lambda item: (_source_array_index(clean_text(item[1].get("sourcePath"))) or 0, item[0]),
    )
    claims: list[dict[str, Any]] = []
    for index, (_, heading) in enumerate(indexed):
        heading_text = clean_text(heading.get("text"))
        heading_index = _source_array_index(clean_text(heading.get("sourcePath")))
        if (
            heading_index is None
            or _is_measurement_or_result_record(heading)
            or not _looks_like_concern_heading(heading_text, locale)
        ):
            continue
        for _, detail in indexed[index + 1 :]:
            detail_index = _source_array_index(clean_text(detail.get("sourcePath")))
            if detail_index is None or detail_index > heading_index + 4:
                break
            detail_text = clean_text(detail.get("text"))
            detail_id = clean_text(detail.get("id"))
            heading_id = clean_text(heading.get("id"))
            if (
                not detail_id
                or not heading_id
                or not _is_card_claim_text_ready(detail_text)
                or is_safety_or_test_claim_usage(detail_text)
                or _is_measurement_or_result_record(detail)
                or _looks_like_concern_heading(detail_text, locale)
            ):
                continue
            if len(_meaningful_tokens(detail_text)) < 2:
                continue
            claims.append(
                {
                    "role": "concern",
                    "relationship": "explicit",
                    "text": f"{heading_text}: {detail_text}",
                    "evidenceIds": [heading_id, detail_id],
                }
            )
            break
    return _unique_claims(claims)


def _explicit_formula_effect_claims(
    records: Sequence[Mapping[str, Any]], semantic: Mapping[str, Any]
) -> list[dict[str, Any]]:
    claims: list[dict[str, Any]] = []
    for raw in as_list(semantic.get("ingredientBenefitLinks")):
        link = as_dict(raw)
        ingredient = clean_text(link.get("ingredient"))
        benefit = clean_text(link.get("benefit"))
        effect = clean_text(link.get("effect"))
        if not ingredient or not (benefit or effect):
            continue
        # Extraction cuts its ingredient field out of page prose, so it
        # sometimes records the front of a sentence (``It is designed to``) as
        # the ingredient.  A relation whose one side is not a name is not a
        # relation, and the naming contract already tells the two apart.
        if not names_a_thing(ingredient):
            continue
        for source in _link_source_texts(link):
            if not _is_card_claim_text_ready(source):
                continue
            if not _source_supports_explicit_formula_effect(source, ingredient, benefit, effect):
                continue
            evidence_ids = _matching_evidence_ids(source, records)
            if not evidence_ids:
                continue
            supported_benefit = benefit if benefit and _source_supports_term(source, benefit) else ""
            supported_effect = effect if effect and _source_supports_term(source, effect) else ""
            claims.append(
                {
                    "role": "ingredient-effect",
                    "relationship": "explicit",
                    "ingredient": ingredient,
                    **({"benefit": supported_benefit} if supported_benefit else {}),
                    **({"effect": supported_effect} if supported_effect else {}),
                    "text": source,
                    "evidenceIds": evidence_ids,
                }
            )
            break
    return _unique_claims(claims)


def _metric_claims(records: Sequence[Mapping[str, Any]], semantic: Mapping[str, Any]) -> list[dict[str, Any]]:
    claims: list[dict[str, Any]] = []
    for raw in as_list(semantic.get("metricClaims")):
        metric = as_dict(raw)
        source = clean_text(metric.get("sourceText"))
        value, unit = clean_text(metric.get("value")), clean_text(metric.get("unit"))
        if not source or not value:
            continue
        if not _metric_source_supports_declared_context(metric, source):
            continue
        evidence_ids = _matching_evidence_ids(source, records)
        if not evidence_ids:
            continue
        claims.append(
            {
                "role": "metric",
                "relationship": "explicit",
                "text": source,
                "evidenceIds": evidence_ids,
                "metric": clean_text(metric.get("metric")),
                **(
                    {"outcome": outcome}
                    if (
                        outcome := next(
                            (
                                clean_text(metric.get(key))
                                for key in ("label", "subject", "outcome")
                                if clean_text(metric.get(key))
                            ),
                            "",
                        )
                    )
                    else {}
                ),
                "value": value,
                **({"unit": unit} if unit else {}),
                **({"timing": clean_text(metric.get("timing"))} if clean_text(metric.get("timing")) else {}),
                **({"method": clean_text(metric.get("method"))} if clean_text(metric.get("method")) else {}),
                **({"sample": clean_text(metric.get("sample"))} if clean_text(metric.get("sample")) else {}),
                **({"caveat": clean_text(metric.get("caveat"))} if clean_text(metric.get("caveat")) else {}),
            }
        )
    return _unique_claims(claims)


def _is_card_claim_text_ready(value: str) -> bool:
    """Keep relationship cards compact enough for model reasoning and public prose.

    A ledger may intentionally retain an OCR/page dump for traceability.  That
    record remains available to other stages, but it is not a single atomic
    formula, audience, or benefit claim a customer FAQ can safely explain.
    """

    text = clean_text(value)
    return bool(
        text
        and len(text) <= _CARD_MAX_CLAIM_LENGTH
        and _CARD_STRUCTURAL_ARTIFACT.search(text) is None
        and not is_raw_page_text_block(text)
    )


def _select_card_claims(
    claims: Sequence[Mapping[str, Any]], maximum: int, *, locale: str = "", prioritize_fit: bool = False
) -> list[dict[str, Any]]:
    """Bound one card to its clearest evidence without changing source meaning."""

    ranked = sorted(
        enumerate(_unique_claims(claims)),
        key=lambda item: (
            -int(prioritize_fit and _has_explicit_fit_relation([item[1]], locale)),
            item[0],
        ),
    )
    return [claim for _, claim in ranked[:maximum]]


def _matching_evidence_ids(text: str, records: Sequence[Mapping[str, Any]]) -> list[str]:
    normalized = _text_key(text)
    return _unique_strings(
        clean_text(record.get("id"))
        for record in records
        if clean_text(record.get("id"))
        and normalized
        and (record_text := _text_key(clean_text(record.get("text"))))
        and (normalized == record_text or normalized in record_text or record_text in normalized)
    )


def _looks_like_explicit_concern(text: str, locale: str) -> bool:
    """Return whether a sentence directs the product at a customer state.

    What decides is the fit relation a sentence draws and what it draws that
    relation to, never which concern words happen to appear.  Enumerating the
    concern nouns let English admit only six of them, so a page that wrote its
    concern any other way had none; Korean meanwhile admitted every sentence
    carrying ``적합`` -- including one saying the product suits a time of day,
    and one saying a test on it is finished.  Neither is the customer state a
    buyer chooses against, and both are already typed elsewhere.
    """

    if not _states_a_fit_relation(text, locale):
        return False
    return not is_safety_or_test_claim_usage(text) and not has_routine_placement_cue(text)


# Whom or what a product is *for* is carried by an adposition -- English ``for``,
# Korean ``위한``/``대상``/``맞춤``, Japanese ``ため``/``対象``/``向け`` -- and what
# it *does* about a concern is carried by a predicate.  Both relate the product
# to a customer, so both mark a concern; only the first can stand behind a
# recommendation, which is why the two halves are named apart here.
_PURPOSE_RELATION = {
    "ko-KR": re.compile(r"(?:위한|대상|맞춤)"),
    "ja-JP": re.compile(r"(?:ため|対象|向け)"),
}
_ENGLISH_PURPOSE_RELATION = re.compile(
    r"\b(?:solution|care|support|designed|formulated|intended|made|ideal|suitable|recommended|best|works)"
    r"\s+for\b"
    r"|\bfor\s+(?:skin|hair|scalp|lips|eyes|nails|those|people|customers|anyone)\b",
    re.IGNORECASE,
)
_OUTCOME_FOR_A_CONCERN = {
    "ko-KR": re.compile(r"(?:고민|개선|완화|적합|도움|추천|권장)"),
    "ja-JP": re.compile(r"(?:悩み|適し|助け|おすすめ)"),
}
_ENGLISH_OUTCOME_FOR_A_CONCERN = re.compile(
    r"\bconcerned\s+with\b|\bconcerns?\b"
    r"|\bhelps?\s+(?:with|improve|reduce|prevent|minimi[sz]e|soothe|calm|address)\b"
    r"|\b(?:address|addresses|target|targets)\b",
    re.IGNORECASE,
)


def states_a_customer_relation(text: str) -> bool:
    """Return whether a text draws a relation between the product and a customer.

    A customer relation is stated as a fit (``is suitable for dry skin``) or as
    a purpose (``a solution for dryness``, ``건조 피부를 위한``).  Reporting an
    outcome is not one: ``피부 장벽을 개선합니다`` says what the formula does,
    and reading that as a relation to a customer would let a formula sentence
    stand in for the target of a recommendation.  PDP source text routinely
    mixes scripts, so every market's grammar is read rather than only the one
    the locale names.
    """

    return is_suitability_statement(text) or any(
        _states_a_purpose_relation(text, locale) for locale in ("ko-KR", "ja-JP", "en-US")
    )


def _states_a_purpose_relation(text: str, locale: str) -> bool:
    """Return whether a sentence binds the product to whom or what it is for."""

    pattern = _PURPOSE_RELATION.get(locale, _ENGLISH_PURPOSE_RELATION)
    return pattern.search(text) is not None


def _states_a_fit_relation(text: str, locale: str) -> bool:
    """Return whether a sentence says the product is for, suits, or answers something."""

    if _states_a_purpose_relation(text, locale):
        return True
    pattern = _OUTCOME_FOR_A_CONCERN.get(locale, _ENGLISH_OUTCOME_FOR_A_CONCERN)
    return pattern.search(text) is not None


def _looks_like_concern_heading(text: str, locale: str) -> bool:
    value = clean_text(text)
    if not value or len(_meaningful_tokens(value)) > 5:
        return False
    if locale == "ko-KR":
        return bool(re.search(r"(?:고민|해결|개선|대상|추천|위한)", value))
    if locale == "ja-JP":
        return bool(re.search(r"(?:悩み|対策|対象|ため|おすすめ)", value))
    # A full concern sentence can be short ("A solution for dryness and
    # tightness.").  English labels are terse fragments without sentence
    # punctuation, while their paired source value is a substantive sentence.
    return bool(
        not re.search(r"[.!?]", value)
        and len(_meaningful_tokens(value)) <= 2
        and re.search(r"\b(?:solution|concerns?|targets?|ideal|suitable|best)\s+for\b", value, re.IGNORECASE)
    )


def _source_array_index(path: str) -> int | None:
    match = re.fullmatch(r"product\.sourceTexts\[(\d+)\]", path)
    return int(match.group(1)) if match is not None else None


def _link_source_texts(link: Mapping[str, Any]) -> list[str]:
    return _unique_strings([clean_text(link.get("sentence")), clean_text(link.get("sourceText"))])


def _source_supports_explicit_formula_effect(source: str, ingredient: str, benefit: str, effect: str) -> bool:
    """Require one recorded source to name both sides of an ingredient relation."""

    if not _source_names_term(source, ingredient):
        return False
    outcomes = [value for value in (benefit, effect) if value]
    if not any(_source_supports_term(source, outcome) for outcome in outcomes):
        return False
    # What makes a sentence state the relation is that both sides stand in one
    # predicated clause -- not which verb was chosen.  Listing relation verbs
    # splits the judgment by market instead of by grammar: the English list
    # carried ``deliver`` and ``reduce`` while the Korean page writes
    # ``보습을 전달합니다`` and ``손상을 줄이는``, so the same relation counted
    # on one page and not on the other.  A source that merely lists the
    # ingredient beside the outcome states no relation, and the enumeration
    # contract already tells that apart from a sentence that predicates one.
    for sentence in split_into_sentences(source):
        if not _source_names_term(sentence, ingredient):
            continue
        if not any(_source_supports_term(sentence, outcome) for outcome in outcomes):
            continue
        if has_unpredicated_enumeration(sentence):
            continue
        return True
    return False


def _source_names_term(source: str, term: str) -> bool:
    source_key, term_key = _text_key(source), _text_key(term)
    return bool(source_key and term_key and term_key in source_key)


def _source_supports_term(source: str, term: str) -> bool:
    if _source_names_term(source, term):
        return True
    # A page writes its footnote as a nominalized predicate ("개인차 있음") and
    # its prose conjugates the same predicate ("개인차가 있을 수 있습니다").  A
    # declared term is supported when the source states it, whichever of those
    # two forms each wrote, so the shared statement contract decides -- the one
    # the description binder already reads source statements with.
    if source_statement_matches(source, term):
        return True
    source_tokens = {_stem_token(token) for token in _meaningful_tokens(source)}
    term_tokens = {_stem_token(token) for token in _meaningful_tokens(term)}
    overlap = source_tokens & term_tokens
    required = 1 if len(term_tokens) == 1 else min(2, len(term_tokens))
    return bool(term_tokens and len(overlap) >= required)


def _metric_source_supports_declared_context(metric: Mapping[str, Any], source: str) -> bool:
    value, unit = clean_text(metric.get("value")), clean_text(metric.get("unit"))
    if not _source_names_measurement(source, value, unit):
        return False
    for key in ("label", "subject", "outcome", "timing", "method", "sample", "caveat"):
        context = clean_text(metric.get(key))
        if context and not _source_supports_term(source, context):
            return False
    return True


def _source_names_measurement(source: str, value: str, unit: str) -> bool:
    if not value:
        return False
    measurement = re.escape(value[: -len(unit)] if unit and value.casefold().endswith(unit.casefold()) else value)
    unit_pattern = r"[%％]" if unit in {"%", "％"} else re.escape(unit)
    suffix = unit_pattern if unit else r"(?:%|％|\b)"
    # A terminal period after a percentage is ordinary sentence punctuation,
    # not part of a larger decimal.  Reject only a following digit or decimal
    # separator that actually continues into a digit (for example ``25.5%``).
    return re.search(rf"(?<![\w.,]){measurement}\s*{suffix}(?!\d|[.,]\d)", source, re.IGNORECASE) is not None


def _meaningful_tokens(value: str) -> list[str]:
    stop_words = {
        "a",
        "an",
        "and",
        "as",
        "at",
        "be",
        "by",
        "for",
        "from",
        "in",
        "is",
        "it",
        "of",
        "on",
        "or",
        "the",
        "this",
        "that",
        "to",
        "with",
        "after",
        "before",
        "daily",
        "use",
        "skin",
        "product",
        "formula",
    }
    return [
        token
        for token in re.findall(r"[A-Za-z0-9가-힣ぁ-んァ-ン一-龯]+", clean_text(value).casefold())
        if token not in stop_words and (len(token) >= 3 or re.search(r"[가-힣ぁ-んァ-ン一-龯]", token))
    ]


def _stem_token(token: str) -> str:
    value = token.casefold()
    # A Korean word carries its role on its own stem, so a declared outcome
    # (``피부 장벽 개선``) and the sentence stating it (``피부 장벽을
    # 개선합니다``) share no surface form.  Comparing them unstemmed loses the
    # relation the source actually states.
    if re.search(r"[가-힣]", value):
        return strip_korean_inflection(value)
    for suffix in ("ments", "ment", "ness", "ingly", "ing", "ied", "ies", "ed", "es", "s"):
        if len(value) > len(suffix) + 2 and value.endswith(suffix):
            return value[: -len(suffix)] + ("y" if suffix in {"ied", "ies"} else "")
    return value


def _has_explicit_fit_relation(claims: Sequence[Mapping[str, Any]], locale: str) -> bool:
    """Return whether a card may recommend the product to the customer it names.

    A recommendation rests on a relation the source draws to the customer: the
    product suits someone (``is suitable for dry skin``) or is meant for a
    named audience or concern (``a solution for dryness``).  Reporting what the
    product does -- ``addresses the look of fine lines`` -- is an outcome, and
    an outcome alone cannot lift ``can be used`` to ``is recommended``.

    A completed test is neither.  ``여드름성 피부 사용 적합 테스트를 완료했다``
    names a test, and counting the fitness word inside its name turns a
    certificate into a recommendation, so a safety or test report is passed
    over before either relation is read.  The suitability contract carries the
    rest: it already tells a fitness statement from a caution, a question and a
    negation, so no second vocabulary of predicates is kept here.

    A retained claim is often a block of several statements, and the caution a
    page prints after a fitness statement (``… is suitable for dry skin. …
    Sensitive skin users should patch test …``) does not retract it.  Both
    tests therefore read one sentence at a time, the unit the suitability
    contract already reads: a caution disqualifies its own sentence, not the
    statement standing beside it.
    """

    for claim in claims:
        for sentence in split_into_sentences(clean_text(claim.get("text"))):
            if is_safety_or_test_claim_usage(sentence):
                continue
            if is_suitability_statement(sentence) or _states_a_purpose_relation(sentence, locale):
                return True
    return False


def _unique_claims(claims: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Keep one claim per stated fact, carrying every record that states it.

    PDP extraction routinely retains the same sentence under more than one
    source path -- a usage list and the page source, an FAQ answer and the
    record it was drawn from -- so it arrives here as claims that differ only
    by evidence id.  A card holds a fixed number of claims, so keeping those
    apart spends the card's room on one fact twice and leaves a second fact
    out.  Merging their ids costs no provenance: every record that states the
    fact stays citable from the one claim.
    """

    unique: list[dict[str, Any]] = []
    position_of: dict[tuple[str, str], int] = {}
    for raw in claims:
        claim = dict(raw)
        text = clean_text(claim.get("text"))
        evidence_ids = _unique_strings(as_list(claim.get("evidenceIds")))
        if not text or not evidence_ids:
            continue
        key = (clean_text(claim.get("role")), text.casefold())
        position = position_of.get(key)
        if position is None:
            position_of[key] = len(unique)
            unique.append({**claim, "text": text, "evidenceIds": list(evidence_ids)})
            continue
        merged = unique[position]
        merged["evidenceIds"] = _unique_strings([*merged["evidenceIds"], *evidence_ids])
    return unique


def _dedupe_cards(cards: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in cards:
        card = dict(raw)
        identifier = clean_text(card.get("id"))
        if identifier and identifier not in seen and as_list(card.get("claims")):
            seen.add(identifier)
            result.append(card)
    return result


def _unique_strings(values: Sequence[object] | Any) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        text = clean_text(value)
        if text and text not in seen:
            seen.add(text)
            result.append(text)
    return result


def _text_key(value: str) -> str:
    return re.sub(r"[^\w가-힣]+", " ", clean_text(value).casefold()).strip()


def _base36(value: int) -> str:
    alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
    if value == 0:
        return "0"
    result = ""
    while value:
        value, remainder = divmod(value, 36)
        result = alphabet[remainder] + result
    return result


__all__ = ["CARD_CLAIM_CONTENT_FIELDS", "build_faq_relationship_cards"]
