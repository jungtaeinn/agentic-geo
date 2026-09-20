"""Final-provenance contracts for admitted relationship-card FAQ copy.

These tests exercise the last trust boundary rather than admission.  The
relationship card is service-owned semantic context; public rows remain
model-authored and may not elevate a source atom into a new claim.
"""

from __future__ import annotations

import copy
from collections.abc import Mapping
from typing import Any

import pytest

from pdp_geo_generator_agent.final_proofreader import (
    _validated_faq_relationship_card_scope,
    create_pdp_geo_public_copy_provenance,
)
from pdp_geo_generator_agent.validation import validate_pdp_geo_artifacts


def _record(identifier: str, role: str, text: str, source_path: str, *, locale: str = "en-US") -> dict[str, Any]:
    return {
        "id": identifier,
        "role": role,
        "text": text,
        "sourcePath": source_path,
        "locale": locale,
        "productScope": "product",
        "confidence": 1,
    }


def _payload(
    rows: list[Mapping[str, Any]],
    cards: list[Mapping[str, Any]],
    ledger: list[Mapping[str, Any]],
) -> dict[str, Any]:
    return {
        "schemaMarkup": {
            "jsonLd": {
                "@context": "https://schema.org",
                "@graph": [
                    {
                        "@type": "FAQPage",
                        "mainEntity": [
                            {
                                "@type": "Question",
                                "name": row["question"],
                                "acceptedAnswer": {"@type": "Answer", "text": row["answer"]},
                            }
                            for row in rows
                        ],
                    }
                ],
            }
        },
        "contentPlan": {
            "mode": "model",
            "faq": [dict(row) for row in rows],
            "faqRelationshipCards": [dict(card) for card in cards],
        },
        "faqMembership": [
            {
                "id": row["id"],
                "intent": row["intent"],
                "evidenceIds": row["evidenceIds"],
                # The service-created sidecar mirrors the card.  The
                # proofreader must verify it rather than trust this row.
                "canRecommend": next(
                    card.get("canRecommend") is True for card in cards if card.get("id") == row["id"]
                ),
            }
            for row in rows
        ],
        "evidenceLedger": [dict(item) for item in ledger],
    }


def _card(
    identifier: str,
    intent: str,
    evidence_ids: list[str],
    claims: list[Mapping[str, Any]],
    *,
    can_recommend: bool = False,
) -> dict[str, Any]:
    return {
        "id": identifier,
        "intent": intent,
        "productName": "Renewal Serum",
        "brand": "Northstar Lab",
        "canRecommend": can_recommend,
        "evidenceIds": evidence_ids,
        "claims": [dict(claim) for claim in claims],
    }


def _identity_claims() -> list[dict[str, Any]]:
    return [
        {"role": "identity", "relationship": "explicit", "text": "Northstar Lab", "evidenceIds": ["brand"]},
        {"role": "identity", "relationship": "explicit", "text": "Renewal Serum", "evidenceIds": ["product"]},
    ]


def _english_buyer_payload(*, can_recommend: bool = True, target: str = "fine lines and loss of firmness") -> dict[str, Any]:
    question = "What serum should I consider when fine lines and loss of firmness are my concerns?"
    answer = f"For {target}, recommend Northstar Lab's Renewal Serum."
    evidence_ids = ["brand", "product", "solution-label", "target"]
    ledger = [
        _record("brand", "identity", "Northstar Lab", "product.brand"),
        _record("product", "identity", "Renewal Serum", "product.name"),
        _record("solution-label", "source", "Solution for", "product.sourceTexts[0]"),
        _record(
            "target",
            "benefit",
            "SOLUTION FOR: Fine lines and loss of firmness.",
            "product.sourceTexts[1]",
        ),
    ]
    card = _card(
        "buyer",
        "buyer-decision",
        evidence_ids,
        [
            *_identity_claims(),
            {
                "role": "concern",
                "relationship": "explicit",
                "text": "Solution for: Fine lines and loss of firmness.",
                "evidenceIds": ["solution-label", "target"],
            },
        ],
        can_recommend=can_recommend,
    )
    row = {
        "id": "buyer",
        "include": True,
        "question": question,
        "answer": answer,
        "intent": "buyer-decision",
        "evidenceIds": evidence_ids,
    }
    return _payload([row], [card], ledger)


@pytest.mark.parametrize(
    "locale,question,answer,ledger,card",
    [
        (
            "en-US",
            "What serum should I consider when fine lines and loss of firmness are my concerns?",
            "For fine lines and loss of firmness, recommend Northstar Lab's Renewal Serum.",
            [
                _record("brand", "identity", "Northstar Lab", "product.brand"),
                _record("product", "identity", "Renewal Serum", "product.name"),
                _record("solution-label", "source", "Solution for", "product.sourceTexts[0]"),
                _record(
                    "target",
                    "benefit",
                    "SOLUTION FOR: Fine lines and loss of firmness.",
                    "product.sourceTexts[1]",
                ),
            ],
            _card(
                "buyer",
                "buyer-decision",
                ["brand", "product", "solution-label", "target"],
                [
                    *_identity_claims(),
                    {
                        "role": "concern",
                        "relationship": "explicit",
                        "text": "Solution for: Fine lines and loss of firmness.",
                        "evidenceIds": ["solution-label", "target"],
                    },
                ],
                can_recommend=True,
            ),
        ),
        (
            "ko-KR",
            "탄력 저하와 건조함이 고민인 피부에는 어떤 세럼이 좋을까요?",
            "탄력 저하와 건조함이 고민이라면 노스스타 랩 리뉴얼 세럼을 추천합니다.",
            [
                _record("brand", "identity", "노스스타 랩", "product.brand", locale="ko-KR"),
                _record("product", "identity", "리뉴얼 세럼", "product.name", locale="ko-KR"),
                _record(
                    "target",
                    "benefit",
                    "탄력 저하와 건조함이 고민인 피부를 위한 제품입니다.",
                    "product.sourceTexts[0]",
                    locale="ko-KR",
                ),
            ],
            {
                "id": "buyer",
                "intent": "buyer-decision",
                "productName": "리뉴얼 세럼",
                "brand": "노스스타 랩",
                "canRecommend": True,
                "evidenceIds": ["brand", "product", "target"],
                "claims": [
                    {"role": "identity", "relationship": "explicit", "text": "노스스타 랩", "evidenceIds": ["brand"]},
                    {"role": "identity", "relationship": "explicit", "text": "리뉴얼 세럼", "evidenceIds": ["product"]},
                    {
                        "role": "concern",
                        "relationship": "explicit",
                        "text": "탄력 저하와 건조함이 고민인 피부를 위한 제품입니다.",
                        "evidenceIds": ["target"],
                    },
                ],
            },
        ),
    ],
)
def test_explicit_card_claims_bind_natural_customer_recommendations_in_both_locales(
    locale: str,
    question: str,
    answer: str,
    ledger: list[Mapping[str, Any]],
    card: Mapping[str, Any],
) -> None:
    """Customer-first recommendation prose needs a matching explicit concern card."""

    row = {
        "id": "buyer",
        "include": True,
        "question": question,
        "answer": answer,
        "intent": "buyer-decision",
        "evidenceIds": card["evidenceIds"],
    }
    entries = {
        entry["fieldPath"]: entry
        for entry in create_pdp_geo_public_copy_provenance(_payload([row], [card], ledger))
    }

    assert {"FAQPage.mainEntity[0].name", "FAQPage.mainEntity[0].acceptedAnswer.text"} <= set(entries)
    assert entries["FAQPage.mainEntity[0].acceptedAnswer.text"]["sentences"][0]["evidenceIds"][-1] == "target"


def test_card_scoped_formula_and_metric_carriers_preserve_relation_and_one_metric_group() -> None:
    """Explicit links can be fluent; independent facts and metric groups cannot be merged."""

    formula_question = "What serum should I look for when firmness and elasticity are skincare goals?"
    formula_answer = (
        "Northstar Lab's Renewal Serum features Ginseng Peptide, which helps support firmness and elasticity."
    )
    metric_question = "What changes might I notice in firmness with a daily serum routine?"
    metric_answer = (
        "After 6 weeks of use, an instrumental result with 32 women found that 100% showed improvement in firmness "
        "for Northstar Lab's Renewal Serum."
    )
    independent_question = "What serum should I look for when radiance is a skincare goal?"
    independent_answer = (
        "Northstar Lab's Renewal Serum includes Luma Complex. The serum supports radiance."
    )
    ledger = [
        _record("brand", "identity", "Northstar Lab", "product.brand"),
        _record("product", "identity", "Renewal Serum", "product.name"),
        _record("peptide", "ingredient", "Ginseng Peptide", "product.ingredients[0]"),
        _record("firmness", "benefit", "Helps support firmness and elasticity.", "product.benefits[0]"),
        _record(
            "metric",
            "metric",
            "After 6 weeks of use, an instrumental result with 32 women showed that 100% showed improvement in firmness.",
            "product.semanticFacts.metricClaims[0]",
        ),
        _record("luma", "ingredient", "Luma Complex", "product.ingredients[1]"),
        _record("radiance", "benefit", "Supports radiance.", "product.benefits[1]"),
    ]
    formula_card = _card(
        "formula",
        "formula-effect",
        ["brand", "product", "peptide", "firmness"],
        [
            *_identity_claims(),
            {
                "role": "ingredient-effect",
                "relationship": "explicit",
                "text": "Ginseng Peptide helps support firmness and elasticity.",
                "evidenceIds": ["peptide", "firmness"],
            },
        ],
    )
    metric_card = _card(
        "metric",
        "evidence-result",
        ["brand", "product", "metric"],
        [
            *_identity_claims(),
            {
                "role": "metric",
                "relationship": "explicit",
                "text": ledger[4]["text"],
                "evidenceIds": ["metric"],
                "value": "100%",
                "timing": "After 6 weeks of use",
                "method": "instrumental result",
                "sample": "32 women",
                "outcome": "firmness",
            },
        ],
    )
    independent_card = _card(
        "independent",
        "formula-and-benefit",
        ["brand", "product", "luma", "radiance"],
        [
            *_identity_claims(),
            {"role": "ingredient", "relationship": "independent", "text": "Luma Complex", "evidenceIds": ["luma"]},
            {"role": "benefit", "relationship": "independent", "text": "Supports radiance.", "evidenceIds": ["radiance"]},
        ],
    )
    rows = [
        {"id": "formula", "include": True, "question": formula_question, "answer": formula_answer, "intent": "formula-effect", "evidenceIds": formula_card["evidenceIds"]},
        {"id": "metric", "include": True, "question": metric_question, "answer": metric_answer, "intent": "evidence-result", "evidenceIds": metric_card["evidenceIds"]},
        {"id": "independent", "include": True, "question": independent_question, "answer": independent_answer, "intent": "formula-and-benefit", "evidenceIds": independent_card["evidenceIds"]},
    ]

    entries = {
        entry["fieldPath"]: entry
        for entry in create_pdp_geo_public_copy_provenance(_payload(rows, [formula_card, metric_card, independent_card], ledger))
    }

    assert entries["FAQPage.mainEntity[0].acceptedAnswer.text"]["sentences"][0]["evidenceIds"] == [
        "brand",
        "product",
        "peptide",
        "firmness",
    ]
    assert entries["FAQPage.mainEntity[1].acceptedAnswer.text"]["sentences"][0]["evidenceIds"] == [
        "brand",
        "product",
        "metric",
    ]
    assert [sentence["evidenceIds"] for sentence in entries["FAQPage.mainEntity[2].acceptedAnswer.text"]["sentences"]] == [
        ["brand", "product", "luma"],
        ["radiance"],
    ]

    causal = _payload(
        [{**rows[2], "answer": "Northstar Lab's Renewal Serum improves radiance through Luma Complex."}],
        [independent_card],
        ledger,
    )
    altered_metric = _payload(
        [{**rows[1], "answer": metric_answer.replace("100%", "99%")}],
        [metric_card],
        ledger,
    )

    assert "FAQPage.mainEntity[0].acceptedAnswer.text" not in {
        entry["fieldPath"] for entry in create_pdp_geo_public_copy_provenance(causal)
    }
    assert "FAQPage.mainEntity[0].acceptedAnswer.text" not in {
        entry["fieldPath"] for entry in create_pdp_geo_public_copy_provenance(altered_metric)
    }


def test_recommendation_needs_a_recommendable_explicit_target_card() -> None:
    """No model row can elevate an unsupported target or non-recommendable card."""

    unsupported_target = {
        entry["fieldPath"]
        for entry in create_pdp_geo_public_copy_provenance(
            _english_buyer_payload(target="redness-prone skin")
        )
    }
    disabled = _english_buyer_payload(can_recommend=False)
    disabled["faqMembership"][0]["canRecommend"] = False
    disabled_paths = {
        entry["fieldPath"] for entry in create_pdp_geo_public_copy_provenance(disabled)
    }

    assert "FAQPage.mainEntity[0].acceptedAnswer.text" not in unsupported_target
    assert "FAQPage.mainEntity[0].acceptedAnswer.text" not in disabled_paths


def test_final_validation_accepts_only_validated_card_scoped_faq_provenance() -> None:
    """The last quality gate must preserve a valid natural recommendation FAQ.

    Validation receives only the service-owned plan/card and membership sidecar;
    it must not trust the public row or a forged membership recommendation bit.
    """

    payload = _english_buyer_payload()
    provenance = create_pdp_geo_public_copy_provenance(payload)
    validation = validate_pdp_geo_artifacts({**payload, "publicCopyProvenance": provenance})

    assert not [
        finding
        for finding in validation["validationFindings"]
        if finding["source"] == "public-copy-provenance"
    ]

    forged = copy.deepcopy(payload)
    forged["faqMembership"][0]["canRecommend"] = False
    forged_validation = validate_pdp_geo_artifacts({**forged, "publicCopyProvenance": provenance})

    assert any(
        finding["field"] == "FAQPage.mainEntity[0].acceptedAnswer.text"
        for finding in forged_validation["validationFindings"]
        if finding["source"] == "public-copy-provenance"
    )


def test_a_source_joining_two_attributions_binds_neither_one_to_the_other() -> None:
    """A swapped attribution may not rest on the sentence that states both of them.

    Extraction files the page line whole, so one atom carries ``판테놀은 … 돕고,
    베타인은 … 합니다``.  Read as one bag of words it holds both names and both
    facts, and the answer that gives one ingredient the other's outcome was
    binding to it -- measured, the swap bound to that joined atom while the true
    sentence bound to its own.  A source states as many attributions as it marks
    subjects, and an answer may rest only on the run its own subject governs.
    """

    brand, name = "노스스타 랩", "리뉴얼 클렌징폼"
    question = "세안 후 피부 장벽을 생각해 클렌저를 고를 때 무엇을 확인할 수 있나요?"
    panthenol, betaine = "판테놀은 피부 장벽 개선을 돕습니다.", "베타인은 피부 장벽을 더욱 견고하게 합니다."
    ledger = [
        _record("brand", "identity", brand, "product.brand", locale="ko-KR"),
        _record("product", "identity", name, "product.name", locale="ko-KR"),
        _record(
            "joined",
            "benefit",
            "판테놀은 피부 장벽 개선을 돕고, 베타인은 피부 장벽을 더욱 견고하게 합니다.",
            "product.sourceTexts[0]",
            locale="ko-KR",
        ),
        _record("panthenol", "source", panthenol, "product.sourceTexts[1]", locale="ko-KR"),
        _record("betaine", "source", betaine, "product.sourceTexts[2]", locale="ko-KR"),
    ]
    evidence_ids = ["brand", "product", "joined", "panthenol", "betaine"]
    card = {
        "id": "formula",
        "intent": "formula-effect",
        "productName": name,
        "brand": brand,
        "canRecommend": False,
        "evidenceIds": evidence_ids,
        "claims": [
            {"role": "identity", "relationship": "explicit", "text": brand, "evidenceIds": ["brand"]},
            {"role": "identity", "relationship": "explicit", "text": name, "evidenceIds": ["product"]},
            {
                "role": "ingredient-effect",
                "relationship": "explicit",
                "ingredient": "판테놀",
                "benefit": "피부 장벽 개선",
                "text": panthenol,
                "evidenceIds": ["panthenol", "joined"],
            },
            {
                "role": "ingredient-effect",
                "relationship": "explicit",
                "ingredient": "베타인",
                "benefit": "피부 장벽을 더욱 견고하게 함",
                "text": betaine,
                "evidenceIds": ["betaine", "joined"],
            },
        ],
    }

    def entries_for(answer: str) -> dict[str, Any]:
        row = {
            "id": "formula",
            "include": True,
            "question": question,
            "answer": answer,
            "intent": "formula-effect",
            "evidenceIds": evidence_ids,
        }
        return {
            entry["fieldPath"]: entry
            for entry in create_pdp_geo_public_copy_provenance(_payload([row], [card], ledger))
        }

    stated = entries_for(f"{brand} {name}에 담긴 판테놀은 피부 장벽 개선을 돕습니다.")
    swapped = entries_for(f"{brand} {name}에 담긴 판테놀은 피부 장벽을 더욱 견고하게 합니다.")
    # The join the source itself is written in still rests on it, and the join
    # with its two attributions exchanged does not.
    joined = entries_for(
        f"{brand} {name}에 담긴 판테놀은 피부 장벽 개선을 돕고, 베타인은 피부 장벽을 더욱 견고하게 합니다."
    )
    joined_swap = entries_for(
        f"{brand} {name}에 담긴 판테놀은 피부 장벽을 더욱 견고하게 하고, 베타인은 피부 장벽 개선을 돕습니다."
    )
    answer_path = "FAQPage.mainEntity[0].acceptedAnswer.text"

    assert stated[answer_path]["sentences"][0]["evidenceIds"] == ["brand", "product", "panthenol"]
    assert answer_path not in swapped
    assert joined[answer_path]["sentences"][0]["evidenceIds"] == ["brand", "product", "joined"]
    assert answer_path not in joined_swap


def test_an_answer_naming_the_published_title_carries_that_identity_to_its_next_sentence() -> None:
    """발행 제목으로 상품을 부른 문장도 다음 문장에 정체성을 물려준다.

    기록 제목은 판매하는 포장까지 적지만 카드와 발행 문구는 상품만 부르므로,
    올바로 쓰인 답변은 그 접미사를 되풀이하지 않는다.  '이 문장이 어떤 정체성을
    불렀는가'를 자리마다 따로 적어 두었더니 선택기만 두 철자를 읽고 상속 세
    자리는 기록 제목만 읽었고, 그래서 첫 문장은 결속되는데 둘째 문장은 기댈
    정체성 없이 관문에 닿아 엔트리가 아예 쓰이지 않았다 -- 행 전체가 사라졌다.
    """

    brand, published, recorded = "노스스타 랩", "리뉴얼 클렌징폼", "리뉴얼 클렌징폼 200g"
    question = "세안 후 피부 장벽을 생각해 클렌저를 고를 때 무엇을 확인할 수 있나요?"
    panthenol, betaine = "판테놀은 피부 장벽 개선을 돕습니다.", "베타인은 피부 장벽을 더욱 견고하게 합니다."
    ledger = [
        _record("brand", "identity", brand, "product.brand", locale="ko-KR"),
        _record("product", "identity", recorded, "product.name", locale="ko-KR"),
        _record("panthenol", "source", panthenol, "product.sourceTexts[0]", locale="ko-KR"),
        _record("betaine", "source", betaine, "product.sourceTexts[1]", locale="ko-KR"),
    ]
    evidence_ids = ["brand", "product", "panthenol", "betaine"]
    card = _card(
        "formula",
        "formula-effect",
        evidence_ids,
        [
            {"role": "identity", "relationship": "explicit", "text": brand, "evidenceIds": ["brand"]},
            {"role": "identity", "relationship": "explicit", "text": published, "evidenceIds": ["product"]},
            {
                "role": "ingredient-effect",
                "relationship": "explicit",
                "ingredient": "판테놀",
                "benefit": "피부 장벽 개선",
                "text": panthenol,
                "evidenceIds": ["panthenol"],
            },
            {
                "role": "ingredient-effect",
                "relationship": "explicit",
                "ingredient": "베타인",
                "benefit": "피부 장벽을 더욱 견고하게 함",
                "text": betaine,
                "evidenceIds": ["betaine"],
            },
        ],
    )
    card["productName"] = published

    def entries_for(answer: str) -> dict[str, Any]:
        row = {
            "id": "formula",
            "include": True,
            "question": question,
            "answer": answer,
            "intent": "formula-effect",
            "evidenceIds": evidence_ids,
        }
        return {
            entry["fieldPath"]: entry
            for entry in create_pdp_geo_public_copy_provenance(_payload([row], [card], ledger))
        }

    answer_path = "FAQPage.mainEntity[0].acceptedAnswer.text"
    named = entries_for(
        f"{brand} {published}에 담긴 판테놀은 피부 장벽 개선을 돕습니다."
        f" {published}에 담긴 베타인은 피부 장벽을 더욱 견고하게 합니다."
    )

    assert answer_path in named
    assert named[answer_path]["sentences"][0]["evidenceIds"] == ["brand", "product", "panthenol"]
    # 상속은 뒤 문장이 기댈 발판일 뿐이므로, 스스로 상품을 부르지 않은 문장에는
    # 정체성 근거가 붙지 않는다.  붙이면 그 문장이 상품을 말했다고 기록된다.
    assert named[answer_path]["sentences"][1]["evidenceIds"] == ["betaine"]

    # 기록 제목 그대로 부른 답변도 같은 정의를 지나 같은 결속에 이른다.
    as_recorded = entries_for(
        f"{brand} {recorded}에 담긴 판테놀은 피부 장벽 개선을 돕습니다."
        f" {recorded}에 담긴 베타인은 피부 장벽을 더욱 견고하게 합니다."
    )
    assert [row["evidenceIds"] for row in as_recorded[answer_path]["sentences"]] == [
        row["evidenceIds"] for row in named[answer_path]["sentences"]
    ]

    # 넓어진 것은 어떤 철자가 정체성을 증명하는가뿐이다.  브랜드와 상품을 함께
    # 부르지 않았거나 이 상품이 아닌 이름을 부른 답변은 여전히 기댈 정체성이
    # 없어 물려줄 것도 없다.
    assert answer_path not in entries_for(
        f"{published}에 담긴 판테놀은 피부 장벽 개선을 돕습니다."
        f" {published}에 담긴 베타인은 피부 장벽을 더욱 견고하게 합니다."
    )
    assert answer_path not in entries_for(
        f"{brand} 리뉴얼 세럼에 담긴 판테놀은 피부 장벽 개선을 돕습니다."
        " 리뉴얼 세럼에 담긴 베타인은 피부 장벽을 더욱 견고하게 합니다."
    )


def _wide_card() -> dict[str, Any]:
    """A card whose claims cover more of the ledger than this one row cites."""

    return {
        "id": "faq-formula-effect-1",
        "intent": "formula-effect",
        "canRecommend": False,
        "evidenceIds": ["ev-brand", "ev-identity", "ev-panthenol", "ev-betaine", "ev-other"],
        "claims": [
            {
                "role": "identity",
                "relationship": "explicit",
                "text": "Barrier Cleansing Foam",
                "evidenceIds": ["ev-identity"],
            },
            {
                "role": "ingredient-effect",
                "relationship": "explicit",
                "text": "Panthenol helps improve the skin barrier.",
                "evidenceIds": ["ev-panthenol", "ev-other"],
            },
        ],
    }


def test_a_claim_reaching_past_the_row_keeps_the_part_the_row_cites() -> None:
    """카드 주장이 행보다 넓다고 버리면 온전한 카드가 통째로 사라진다. 교집합이 이 행의 몫이다."""

    scope = _validated_faq_relationship_card_scope(
        _wide_card(),
        row_id="faq-formula-effect-1",
        intent="formula-effect",
        evidence_ids=["ev-brand", "ev-identity", "ev-panthenol"],
        known_ids={"ev-brand", "ev-identity", "ev-panthenol", "ev-betaine", "ev-other"},
    )

    assert scope is not None
    assert [claim["role"] for claim in scope["claims"]] == ["identity", "ingredient-effect"]


def test_a_claim_touching_no_atom_the_row_cites_is_not_this_rows_claim() -> None:
    """행이 인용하지 않은 원자만 가진 주장은 이 행의 주장이 아니다."""

    card = _wide_card()
    card["claims"][1]["evidenceIds"] = ["ev-betaine", "ev-other"]

    scope = _validated_faq_relationship_card_scope(
        card,
        row_id="faq-formula-effect-1",
        intent="formula-effect",
        evidence_ids=["ev-brand", "ev-identity", "ev-panthenol"],
        known_ids={"ev-brand", "ev-identity", "ev-panthenol", "ev-betaine", "ev-other"},
    )

    assert scope is None


def test_a_claim_leaving_the_card_is_still_refused() -> None:
    """카드 밖을 인용한 주장은 여전히 거부된다. 넓어진 것은 카드 안쪽뿐이다."""

    card = _wide_card()
    card["claims"][1]["evidenceIds"] = ["ev-panthenol", "ev-outside"]

    scope = _validated_faq_relationship_card_scope(
        card,
        row_id="faq-formula-effect-1",
        intent="formula-effect",
        evidence_ids=["ev-brand", "ev-identity", "ev-panthenol"],
        known_ids={"ev-brand", "ev-identity", "ev-panthenol", "ev-betaine", "ev-other", "ev-outside"},
    )

    assert scope is None
