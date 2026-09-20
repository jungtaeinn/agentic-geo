"""Regression coverage for source-faithful deterministic description rendering."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import Any, cast

from pdp_geo_generator_agent.content_planning import create_conservative_content_plan, create_pdp_geo_evidence_ledger
from pdp_geo_generator_agent.final_proofreader import create_pdp_geo_public_copy_provenance
from pdp_geo_generator_agent.generation import generate_pdp_geo_artifacts
from pdp_geo_generator_agent.service import generate_pdp_geo
from pdp_geo_generator_agent.validation import validate_pdp_geo_artifacts

_ENGLISH_METRIC_SOURCE = (
    "100% showed improvement in hydration after 6 weeks in an instrumental test. Individual results may vary."
)
_KOREAN_METRIC_SOURCE = "6주 후 기기 평가에서 100%가 수분 개선을 보였습니다."
_EXPLICIT_AUDIENCE_SOURCE = "WORKS BEST FOR: Normal, dry, combination, and oily skin types."


def _sample_botanics_like_english_product() -> dict[str, Any]:
    """Keep distinct source roles while making the unsupported normal-skin inference observable."""

    return {
        "name": "SampleBotanics Essential Care Activating Serum",
        "brand": "SampleBotanics",
        "category": "serum",
        "description": "SampleBotanics Essential Care Activating Serum is a serum for dry skin.",
        "ingredients": ["Ginseng Extract"],
        "benefits": ["supports hydration"],
        "effects": ["helps soothe dry skin"],
        "usage": ["Dispense two pumps and smooth over face and neck."],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": ["lightweight finish"]},
        "sourceTexts": [
            "SampleBotanics Essential Care Activating Serum is a serum for dry skin.",
            "Ginseng Extract supports hydration.",
            _ENGLISH_METRIC_SOURCE,
        ],
        "semanticFacts": {
            # This normalized label is not, by itself, a suitability relation.
            "skinTypes": ["normal"],
            "usageSteps": ["Dispense two pumps and smooth over face and neck."],
            "metricClaims": [
                {
                    # The normalized label intentionally differs from the source
                    # predicate, so a renderer must retain the original sentence
                    # rather than invent an "improvement rate" assertion frame.
                    "metric": "improvement rate",
                    "value": "100",
                    "unit": "%",
                    "timing": "after 6 weeks",
                    "method": "instrumental test",
                    "caveat": "Individual results may vary.",
                    "sourceText": _ENGLISH_METRIC_SOURCE,
                }
            ],
        },
    }


def _sample_botanics_like_korean_product() -> dict[str, Any]:
    """Exercise the shared metric renderer without changing Korean audience copy."""

    return {
        "name": "SampleBotanics 퍼스트케어 세럼",
        "brand": "SampleBotanics",
        "category": "세럼",
        "description": "SampleBotanics 퍼스트케어 세럼은 세럼입니다.",
        "ingredients": [],
        "benefits": [],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": ["SampleBotanics 퍼스트케어 세럼은 세럼입니다.", _KOREAN_METRIC_SOURCE],
        "semanticFacts": {
            "skinTypes": ["중성"],
            "metricClaims": [
                {
                    "metric": "개선율",
                    "value": "100",
                    "unit": "%",
                    "timing": "6주 후",
                    "method": "기기 평가",
                    "sourceText": _KOREAN_METRIC_SOURCE,
                }
            ],
        },
    }


def _node(schema_markup: Mapping[str, Any], kind: str) -> dict[str, Any]:
    graph = cast(list[dict[str, Any]], cast(Mapping[str, Any], schema_markup["jsonLd"])["@graph"])
    return next(
        item for item in graph if kind in (item["@type"] if isinstance(item["@type"], list) else [item["@type"]])
    )


def _render_then_collect_final_provenance(
    product: Mapping[str, Any], locale: str
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Exercise the local renderer, proofreader, safe repair, and provenance reconciliation path."""

    run = asyncio.run(
        generate_pdp_geo(
            {"product": product, "hints": {"locale": locale}},
            {"qualityGate": {"enabled": False}},
        )
    )
    return cast(dict[str, Any], run["result"]), cast(dict[str, Any], run["diagnostics"])


def _assert_complete_description_bindings(artifact: Mapping[str, Any], diagnostics: Mapping[str, Any]) -> None:
    entries = {
        str(entry["fieldPath"]): entry for entry in cast(list[dict[str, Any]], diagnostics["finalPublicCopyProvenance"])
    }
    for path, node_kind in (("Product.description", "Product"), ("WebPage.description", "WebPage")):
        expected_text = str(_node(cast(Mapping[str, Any], artifact["schemaMarkup"]), node_kind)["description"])
        entry = entries[path]
        assert entry["text"] == expected_text
        assert entry["evidenceIds"]
        assert entry["sentences"]
        assert all(sentence["evidenceIds"] for sentence in entry["sentences"])
    assert not any(
        finding["source"] == "public-copy-provenance"
        and finding["field"] in {"Product.description", "WebPage.description"}
        for finding in cast(list[dict[str, Any]], diagnostics["validationFindings"])
    )


def test_english_source_faithful_description_keeps_product_and_webpage_provenance() -> None:
    """A skin-type label and source metric cannot become unsupported template assertions."""

    artifact, diagnostics = _render_then_collect_final_provenance(_sample_botanics_like_english_product(), "en-US")
    product_description = _node(artifact["schemaMarkup"], "Product")["description"]
    webpage_description = _node(artifact["schemaMarkup"], "WebPage")["description"]

    for description in (product_description, webpage_description):
        assert "SampleBotanics Essential Care Activating Serum is a serum." not in description
        assert not description.startswith(
            "SampleBotanics Essential Care Activating Serum is a serum. "
            "SampleBotanics Essential Care Activating Serum is a serum for dry skin."
        )
        assert "is intended for customers with normal" not in description
        assert "Reported improvement rate" not in description
        assert _ENGLISH_METRIC_SOURCE in description
        assert "Ginseng Extract" in description
        assert "supports hydration" in description
        assert "helps soothe dry skin" in description
        # An explicitly positive review keyword can be published only through
        # the exact branded, review-attributed frame.
        assert (
            "Customers who reviewed SampleBotanics Essential Care Activating Serum positively noted lightweight finish."
            in description
        )
    _assert_complete_description_bindings(artifact, diagnostics)


def test_explicit_source_audience_line_is_natural_and_bound_before_formula_copy() -> None:
    """A source target relation survives without an inferred customer-suitability template."""

    product = _sample_botanics_like_english_product()
    product["sourceTexts"].append(_EXPLICIT_AUDIENCE_SOURCE)
    artifact, diagnostics = _render_then_collect_final_provenance(product, "en-US")
    expected_audience = "Works best for: Normal, dry, combination, and oily skin types."

    for node_kind in ("Product", "WebPage"):
        description = _node(artifact["schemaMarkup"], node_kind)["description"]
        assert expected_audience in description
        assert _EXPLICIT_AUDIENCE_SOURCE not in description
        assert "is intended for customers with normal" not in description
        assert description.index(expected_audience) < description.index("Ginseng Extract")
    _assert_complete_description_bindings(artifact, diagnostics)


def test_korean_source_metric_keeps_product_and_webpage_provenance() -> None:
    """The shared metric path preserves Korean source wording instead of a synthetic label."""

    artifact, diagnostics = _render_then_collect_final_provenance(_sample_botanics_like_korean_product(), "ko-KR")
    for node_kind in ("Product", "WebPage"):
        description = _node(artifact["schemaMarkup"], node_kind)["description"]
        assert "확인된 개선율" not in description
        assert _KOREAN_METRIC_SOURCE in description
    webpage_description = _node(artifact["schemaMarkup"], "WebPage")["description"]
    assert "SampleBotanics 퍼스트케어 세럼입니다." not in webpage_description
    assert not webpage_description.startswith("SampleBotanics 퍼스트케어 세럼입니다. SampleBotanics 퍼스트케어 세럼은 세럼입니다.")
    _assert_complete_description_bindings(artifact, diagnostics)


def test_korean_metric_source_does_not_match_an_embedded_numeric_value() -> None:
    """A Korean particle may follow 100%, but it cannot make 1000% satisfy a 100% claim."""

    product = _sample_botanics_like_korean_product()
    claim = cast(dict[str, Any], cast(dict[str, Any], product["semanticFacts"])["metricClaims"][0])
    claim["sourceText"] = "6주 후 기기 평가에서 1000%가 수분 개선을 보였습니다."

    artifact, diagnostics = _render_then_collect_final_provenance(product, "ko-KR")
    for node_kind in ("Product", "WebPage"):
        description = _node(artifact["schemaMarkup"], node_kind)["description"]
        assert "1000%" not in description
        assert "확인된 개선율" not in description
    _assert_complete_description_bindings(artifact, diagnostics)


def test_omitted_model_descriptions_do_not_recast_procedural_benefits() -> None:
    """A stray source RITUAL block must not become a description-level benefit claim."""

    ritual = "RITUAL: Warm 2–3 drops between your palms. Press into clean skin, then massage until absorbed."
    usage = "Dispense two pumps and smooth over face and neck."
    product: dict[str, Any] = {
        "name": "Ritual Oil",
        "brand": "Example Lab",
        "category": "face oil",
        "description": "Ritual Oil is a facial oil.",
        "ingredients": [],
        # Simulate an upstream field-routing error that reaches the generator.
        "benefits": [ritual],
        "effects": [],
        "usage": [usage],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": ["Ritual Oil is a facial oil.", ritual, usage],
        "semanticFacts": {"usageSteps": [usage]},
    }
    ledger = create_pdp_geo_evidence_ledger(product, "en-US")
    plan = create_conservative_content_plan({"product": product, "locale": "en-US", "evidenceLedger": ledger})
    plan["mode"] = "model"  # Model-shaped plan with both description fields omitted.

    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US", "contentPlan": plan})
    product_description = cast(str, _node(artifact["schemaMarkup"], "Product")["description"])
    webpage_description = cast(str, _node(artifact["schemaMarkup"], "WebPage")["description"])
    provenance = create_pdp_geo_public_copy_provenance(
        {"schemaMarkup": artifact["schemaMarkup"], "evidenceLedger": ledger, "contentPlan": plan}
    )
    report = validate_pdp_geo_artifacts(
        {
            "schemaMarkup": artifact["schemaMarkup"],
            "content": artifact["content"],
            "evidenceLedger": ledger,
            "publicCopyProvenance": provenance,
        }
    )
    provenance_fields = [
        finding["field"]
        for finding in cast(list[dict[str, Any]], report["validationFindings"])
        if finding["source"] == "public-copy-provenance"
        and finding["field"] in {"Product.description", "WebPage.description"}
    ]

    how_to = _node(artifact["schemaMarkup"], "HowTo")
    assert [step["text"] for step in cast(list[dict[str, str]], how_to["step"])] == [usage]
    descriptions = (product_description, webpage_description)
    assert not any("as a stated product benefit" in description for description in descriptions), (
        "The procedural benefit leaked into deterministic description prose; "
        f"strict provenance findings: {provenance_fields!r}."
    )
    assert ritual.rstrip(".") not in product_description and ritual.rstrip(".") not in webpage_description
    assert not provenance_fields
