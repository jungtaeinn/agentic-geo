"""An attribute slot takes the specific label a source states, not the prose beside it.

A measured-result block labels what was measured, and extraction keeps those
labels beside the paragraph.  The labels are the specific, source-backed wording
an attribute wants.  Where a source states none, the existing wording stands:
this prefers the specific, it does not invent one, and it does not reduce a
specific term to a generic concept.
"""

from __future__ import annotations

import json
import pathlib
from typing import Any, cast

import pytest

from pdp_geo_generator_agent.generation import generate_pdp_geo_artifacts
from pdp_geo_generator_agent.normalization import normalize_pdp_product

_SOURCE_PRODUCTS = pathlib.Path(__file__).parent / "fixtures" / "source-products"
_FIXTURE = {"ko-KR": "sample-derma-cleansing-foam.json", "en-US": "sample-botanics-serum.json"}


def _properties(locale: str) -> dict[str, str]:
    raw = json.loads((_SOURCE_PRODUCTS / _FIXTURE[locale]).read_text(encoding="utf-8"))
    product = normalize_pdp_product(raw, {"hints": {"locale": locale}})["product"]
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": locale})
    graph = cast(list[dict[str, Any]], artifact["schemaMarkup"]["jsonLd"]["@graph"])
    node = next(
        item for item in graph if "Product" in (item["@type"] if isinstance(item["@type"], list) else [item["@type"]])
    )
    return {item["name"]: item["value"] for item in cast(list[dict[str, str]], node["additionalProperty"])}


def test_a_labeled_source_fills_the_attribute_slot_instead_of_a_paragraph() -> None:
    """A source label occupies the attribute slot instead of neighboring prose."""
    properties = _properties("en-US")

    assert properties["Key benefit"] == "Elasticity"
    assert properties["Key efficacy"] == "Moisture & Hydration"


def test_a_source_label_is_published_in_publishable_case() -> None:
    """An all-caps source label is published in readable case."""
    properties = _properties("en-US")

    assert not any(value.isupper() for value in properties.values())


def test_a_ledger_that_already_states_attributes_is_not_touched() -> None:
    """Specific Korean attribute atoms remain unchanged."""
    properties = _properties("ko-KR")

    assert properties["Key benefit"] == "일상 노폐물 세정"
    assert properties["Key efficacy"] == "피부 장벽 보호"


@pytest.mark.parametrize("locale", ["ko-KR", "en-US"])
def test_no_two_properties_publish_the_same_value(locale: str) -> None:
    values = list(_properties(locale).values())

    assert len(values) == len(set(values))


def test_a_source_that_labels_nothing_keeps_the_wording_it_has() -> None:
    """라벨이 없으면 지어내지 않는다 — 기존 문구가 그대로 선다."""
    product: dict[str, Any] = {
        "name": "Cloud Firm Serum",
        "brand": "Northstar Lab",
        "category": "serum",
        "description": "Cloud Firm Serum is a serum.",
        "ingredients": ["Peptide Complex"],
        "benefits": ["Improves the look of skin firmness."],
        "effects": [],
        "usage": [],
        "metrics": [],
        "options": [],
        "faq": [],
        "reviews": {"items": [], "keywords": []},
        "sourceTexts": ["Cloud Firm Serum is a serum.", "Improves the look of skin firmness."],
    }
    artifact = generate_pdp_geo_artifacts({"product": product, "locale": "en-US"})
    graph = cast(list[dict[str, Any]], artifact["schemaMarkup"]["jsonLd"]["@graph"])
    node = next(
        item for item in graph if "Product" in (item["@type"] if isinstance(item["@type"], list) else [item["@type"]])
    )
    properties = {item["name"]: item["value"] for item in cast(list[dict[str, str]], node["additionalProperty"])}

    assert properties["Key benefit"] == "Improves the look of skin firmness"
