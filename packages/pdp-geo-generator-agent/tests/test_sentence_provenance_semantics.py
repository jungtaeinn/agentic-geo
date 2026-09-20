"""Regression coverage for sentence-level public-copy provenance frames."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from pdp_geo_generator_agent.final_proofreader import (
    create_pdp_geo_public_copy_provenance,
    final_proofread_pdp_geo_artifacts,
    stable_text_hash,
)


def _payload(
    description: str,
    evidence: dict[str, Any],
    *,
    locale: str,
    ingredients: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "product": {"name": "Glow Serum" if locale == "en-US" else "글로우 세럼", "ingredients": ingredients or []},
        "locale": locale,
        "schemaMarkup": {
            "jsonLd": {
                "@context": "https://schema.org",
                "@graph": [
                    {
                        "@type": "Product",
                        "name": "Glow Serum" if locale == "en-US" else "글로우 세럼",
                        "description": description,
                    }
                ],
            }
        },
        "content": {
            "sections": {
                "productName": "Glow Serum" if locale == "en-US" else "글로우 세럼",
                "description": description,
            }
        },
        "evidenceLedger": [evidence],
    }


def _hash_valid_product_provenance(description: str, evidence_ids: list[str]) -> dict[str, Any]:
    path = "Product.description"
    return {
        "fieldPath": path,
        "text": description,
        "sourceHash": stable_text_hash(f"{path}\n{description}"),
        "origin": "deterministic-renderer",
        "evidenceIds": evidence_ids,
        "sentences": [
            {
                "text": description,
                "sourceHash": stable_text_hash(f"{path}#sentence[0]\n{description}"),
                "evidenceIds": evidence_ids,
            }
        ],
    }


@pytest.mark.parametrize(
    ("locale", "description", "role", "source", "ingredients"),
    [
        (
            "en-US",
            "Clinically proven 1.3x hydration after 2 weeks.",
            "source",
            "Instrumental testing found 1.3x hydration after 2 weeks.",
            [],
        ),
        (
            "ko-KR",
            "임상적으로 입증된 2주 후 수분 1.3배 증가.",
            "source",
            "기기 테스트에서 2주 후 수분이 1.3배 증가한 것으로 확인되었습니다.",
            [],
        ),
        (
            "en-US",
            "Customer reviews praise a lightweight finish.",
            "review",
            "Customer reviews mention a lightweight finish.",
            [],
        ),
        (
            "en-US",
            "Customer reviews praise a lightweight finish and mention a lightweight finish.",
            "review",
            "lightweight finish",
            [],
        ),
        (
            "ko-KR",
            "고객 리뷰는 가벼운 마무리감을 칭찬합니다.",
            "review",
            "고객 리뷰에는 가벼운 마무리감이 언급됩니다.",
            [],
        ),
        (
            "en-US",
            "Glow Serum supports hydration and includes Ceramide.",
            "ingredient",
            "Ceramide",
            ["Ceramide"],
        ),
        (
            "ko-KR",
            "글로우 세럼은 수분 보습을 돕고 세라마이드를 함유합니다.",
            "ingredient",
            "세라마이드",
            ["세라마이드"],
        ),
    ],
    ids=(
        "metric-en",
        "metric-ko",
        "review-en",
        "review-en-neutral-tail",
        "review-ko",
        "ingredient-en",
        "ingredient-ko",
    ),
)
def test_unsupported_sentence_assertion_frames_receive_no_generated_or_hash_valid_provenance(
    locale: str,
    description: str,
    role: str,
    source: str,
    ingredients: list[str],
) -> None:
    evidence = {
        "id": "ev-claim",
        "role": role,
        "text": source,
        "sourcePath": "product.description",
        "locale": locale,
        "productScope": "product",
        "confidence": 1,
    }
    payload = _payload(description, evidence, locale=locale, ingredients=ingredients)
    evidence_ids = ["ev-claim"]
    if role == "ingredient":
        payload["evidenceLedger"].insert(
            0,
            {
                "id": "ev-identity",
                "role": "identity",
                "text": "Glow Serum" if locale == "en-US" else "글로우 세럼",
                "sourcePath": "product.name",
                "locale": locale,
                "productScope": "product",
                "confidence": 1,
            },
        )
        evidence_ids.insert(0, "ev-identity")

    assert create_pdp_geo_public_copy_provenance(payload) == []

    payload["publicCopyProvenance"] = [_hash_valid_product_provenance(description, evidence_ids)]
    result = asyncio.run(final_proofread_pdp_geo_artifacts(payload, {"finalProofreading": {"enabled": False}}))

    assert result["finalPublicCopyProvenance"] == []
    assert result["diagnostics"]["skippedFields"] == [
        {
            "fieldPath": "Product.description",
            "reason": "no exact final-text, sentence-hash, and evidence-ID provenance binding was available",
        }
    ]


@pytest.mark.parametrize(
    ("description", "evidence"),
    [
        (
            "Instrumental testing found 1.3x hydration after 2 weeks.",
            {
                "id": "ev-direct",
                "role": "source",
                "text": "Instrumental testing found 1.3x hydration after 2 weeks.",
                "sourcePath": "product.description",
                "locale": "en-US",
                "productScope": "product",
                "confidence": 1,
            },
        ),
        (
            "Customer reviews mention a lightweight finish.",
            {
                "id": "ev-direct",
                "role": "review",
                "text": "Customer reviews mention a lightweight finish.",
                "sourcePath": "product.description",
                "locale": "en-US",
                "productScope": "product",
                "confidence": 1,
            },
        ),
    ],
    ids=("direct-metric-fact", "direct-review-fact"),
)
def test_direct_source_facts_remain_eligible_for_provenance(description: str, evidence: dict[str, Any]) -> None:
    provenance = create_pdp_geo_public_copy_provenance(_payload(description, evidence, locale="en-US"))

    assert provenance[0]["fieldPath"] == "Product.description"
    assert provenance[0]["evidenceIds"] == ["ev-direct"]


def test_non_assertive_identity_and_ingredient_connection_remains_eligible_for_provenance() -> None:
    """The sentence cites the ingredient it connects and the name it calls.

    An identity asserts nothing, so it cannot stand in for the ingredient
    relation; it is still the record the sentence's own subject comes from.
    """

    description = "Glow Serum includes Ceramide."
    payload = _payload(
        description,
        {
            "id": "ev-identity",
            "role": "identity",
            "text": "Glow Serum",
            "sourcePath": "product.name",
            "locale": "en-US",
            "productScope": "product",
            "confidence": 1,
        },
        locale="en-US",
        ingredients=["Ceramide"],
    )
    payload["evidenceLedger"].append(
        {
            "id": "ev-ingredient",
            "role": "ingredient",
            "text": "Ceramide",
            "sourcePath": "product.ingredients[0]",
            "locale": "en-US",
            "productScope": "product",
            "confidence": 1,
        }
    )

    provenance = create_pdp_geo_public_copy_provenance(payload)

    assert provenance[0]["fieldPath"] == "Product.description"
    assert provenance[0]["evidenceIds"] == ["ev-identity", "ev-ingredient"]


@pytest.mark.parametrize(
    ("locale", "description", "role", "source"),
    [
        (
            "en-US",
            "Glow Serum customer reviews mention a lightweight finish.",
            "review",
            "lightweight finish",
        ),
        (
            "ko-KR",
            "글로우 세럼 관련 고객 리뷰에는 촉촉한 사용감 언급이 있습니다.",
            "review",
            "촉촉한 사용감",
        ),
        ("en-US", "Glow Serum supports hydration.", "benefit", "supports hydration"),
        ("ko-KR", "글로우 세럼은 수분 보습을 돕습니다.", "benefit", "수분 보습을 돕습니다."),
    ],
    ids=("review-en", "review-ko", "benefit-en", "benefit-ko"),
)
def test_renderer_identity_connections_keep_their_direct_source_atoms(
    locale: str,
    description: str,
    role: str,
    source: str,
) -> None:
    """A renderer may name the product around one direct review or benefit atom."""

    identity = "Glow Serum" if locale == "en-US" else "글로우 세럼"
    payload = _payload(
        description,
        {
            "id": "ev-identity",
            "role": "identity",
            "text": identity,
            "sourcePath": "product.name",
            "locale": locale,
            "productScope": "product",
            "confidence": 1,
        },
        locale=locale,
    )
    payload["evidenceLedger"].append(
        {
            "id": "ev-atom",
            "role": role,
            "text": source,
            "sourcePath": f"product.{role}s[0]",
            "locale": locale,
            "productScope": "product",
            "confidence": 1,
        }
    )

    provenance = create_pdp_geo_public_copy_provenance(payload)

    assert provenance[0]["fieldPath"] == "Product.description"
    assert "ev-atom" in provenance[0]["evidenceIds"]


def test_cross_atom_causal_subject_and_benefit_cannot_be_combined_into_provenance() -> None:
    description = "Glow Serum reduces redness."
    payload = _payload(
        description,
        {
            "id": "ev-identity",
            "role": "identity",
            "text": "Glow Serum",
            "sourcePath": "product.name",
            "locale": "en-US",
            "productScope": "product",
            "confidence": 1,
        },
        locale="en-US",
    )
    payload["evidenceLedger"].extend(
        [
            {
                "id": "ev-dryness",
                "role": "source",
                "text": "Glow Serum reduces dryness.",
                "sourcePath": "product.description",
                "locale": "en-US",
                "productScope": "product",
                "confidence": 1,
            },
            {
                "id": "ev-redness",
                "role": "effect",
                "text": "redness",
                "sourcePath": "product.effects[0]",
                "locale": "en-US",
                "productScope": "product",
                "confidence": 1,
            },
        ]
    )

    assert create_pdp_geo_public_copy_provenance(payload) == []

    evidence_ids = ["ev-identity", "ev-dryness", "ev-redness"]
    payload["publicCopyProvenance"] = [_hash_valid_product_provenance(description, evidence_ids)]
    result = asyncio.run(final_proofread_pdp_geo_artifacts(payload, {"finalProofreading": {"enabled": False}}))

    assert result["finalPublicCopyProvenance"] == []
    assert result["diagnostics"]["skippedFields"] == [
        {
            "fieldPath": "Product.description",
            "reason": "no exact final-text, sentence-hash, and evidence-ID provenance binding was available",
        }
    ]


def _review_frame_payload(
    description: str,
    *,
    locale: str,
    review_text: str,
    review_path: str,
    brand: str = "",
) -> dict[str, Any]:
    """Build a ledger whose review atom is intentionally separate from identity."""

    name = "Glow Serum" if locale == "en-US" else "글로우 세럼"
    payload = _payload(
        description,
        {
            "id": "ev-name",
            "role": "identity",
            "text": name,
            "sourcePath": "product.name",
            "locale": locale,
            "productScope": "product",
            "confidence": 1,
        },
        locale=locale,
    )
    payload["product"]["brand"] = brand
    if brand:
        payload["evidenceLedger"].insert(
            0,
            {
                "id": "ev-brand",
                "role": "identity",
                "text": brand,
                "sourcePath": "product.brand",
                "locale": locale,
                "productScope": "product",
                "confidence": 1,
            },
        )
    payload["evidenceLedger"].append(
        {
            "id": "ev-review",
            "role": "review",
            "text": review_text,
            "sourcePath": review_path,
            "locale": locale,
            "productScope": "product",
            "confidence": 1,
        }
    )
    return payload


@pytest.mark.parametrize(
    ("locale", "description", "review_text", "review_path", "brand", "expected_ids"),
    [
        (
            "en-US",
            "Customers who reviewed Example Lab's Glow Serum positively noted lightweight finish.",
            "lightweight finish",
            "product.reviews.keywords[0]",
            "Example Lab",
            ["ev-brand", "ev-name", "ev-review"],
        ),
        (
            "ko-KR",
            "글로우 세럼을 사용한 고객들은 가벼운 마무리감을 긍정적으로 평가했습니다.",
            "가벼운 마무리감",
            "product.reviews.keywords[0]",
            "",
            ["ev-name", "ev-review"],
        ),
        (
            "en-US",
            "Glow Serum received 4.8 out of 5 from 120 customer ratings.",
            "rating=4.8; reviewCount=120",
            "product.reviews.summary",
            "",
            ["ev-name", "ev-review"],
        ),
        (
            "ko-KR",
            "글로우 세럼은 120건의 고객 평가에서 4.8/5점을 받았습니다.",
            "rating=4.8; reviewCount=120",
            "product.reviews.summary",
            "",
            ["ev-name", "ev-review"],
        ),
    ],
    ids=("keyword-en", "keyword-ko", "rating-en", "rating-ko"),
)
def test_source_backed_positive_review_summary_frames_bind_to_exact_review_atoms(
    locale: str,
    description: str,
    review_text: str,
    review_path: str,
    brand: str,
    expected_ids: list[str],
) -> None:
    """Keyword and aggregate frames are factual attribution, not review quotes."""

    provenance = create_pdp_geo_public_copy_provenance(
        _review_frame_payload(
            description,
            locale=locale,
            review_text=review_text,
            review_path=review_path,
            brand=brand,
        )
    )

    assert len(provenance) == 1
    assert provenance[0]["fieldPath"] == "Product.description"
    assert provenance[0]["evidenceIds"] == expected_ids


@pytest.mark.parametrize(
    ("locale", "description", "review_text", "review_path", "brand"),
    [
        (
            "en-US",
            "Customers who reviewed Glow Serum positively noted sticky texture.",
            "sticky texture",
            "product.reviews.keywords[0]",
            "",
        ),
        (
            "ko-KR",
            "글로우 세럼을 사용한 고객들은 촉촉하지 않음, 산뜻한 마무리감을 긍정적으로 평가했습니다.",
            "촉촉하지 않음, 산뜻한 마무리감",
            "product.reviews.keywords[0]",
            "",
        ),
        (
            "en-US",
            'Customers who reviewed Glow Serum positively noted "lightweight finish".',
            "lightweight finish",
            "product.reviews.keywords[0]",
            "",
        ),
        (
            "en-US",
            "Glow Serum received 4.9 out of 5 from 120 customer ratings.",
            "rating=4.8; reviewCount=120",
            "product.reviews.summary",
            "",
        ),
        (
            "ko-KR",
            "글로우 세럼은 12건의 고객 평가에서 3.0/5점을 받았습니다.",
            "rating=3.0; reviewCount=12",
            "product.reviews.summary",
            "",
        ),
    ],
    ids=("negative-keyword", "mixed-keyword", "quoted-keyword", "invented-rating", "nonpositive-rating"),
)
def test_review_summary_frames_reject_negative_mixed_quoted_or_unmatched_sources(
    locale: str,
    description: str,
    review_text: str,
    review_path: str,
    brand: str,
) -> None:
    """A customer-feedback frame cannot launder sentiment or fabricate rating facts."""

    assert (
        create_pdp_geo_public_copy_provenance(
            _review_frame_payload(
                description,
                locale=locale,
                review_text=review_text,
                review_path=review_path,
                brand=brand,
            )
        )
        == []
    )
