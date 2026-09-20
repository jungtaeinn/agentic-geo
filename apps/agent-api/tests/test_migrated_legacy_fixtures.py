"""Regression tests for data retained from the retired API test tree."""

from __future__ import annotations

import json
from urllib.parse import urlparse

import httpx
import pytest
from frozen_contracts import object_mapping
from legacy_fixtures import GEO_SCHEMA_FIXTURE, load_geo_regression_cases
from neo_agent_api.main import create_app
from neo_agent_api.settings import Settings


class _CapturingGeneration:
    """Keep the ASGI route and DTO real while retaining each generation input."""

    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    async def generate(self, data: dict[str, object]) -> dict[str, object]:
        self.calls.append(data)
        return {
            "resultStatus": "SUCCEEDED",
            "jsonLd": {"@type": "Product"},
            "scriptTag": '<script type="application/ld+json">{}</script>',
            "schemaTypes": ["Product", "WebPage"],
            "resultHash": "a" * 64,
            "ragProfile": "pdp-geo-generator-default",
            "diagnostics": {"validationWarnings": []},
        }


def test_postgres_schema_fixture_is_owned_by_python_tests() -> None:
    """Catch an integration fixture left behind in the retired test tree."""

    assert GEO_SCHEMA_FIXTURE.is_file()
    assert "create table neo.geo_generation" in GEO_SCHEMA_FIXTURE.read_text().lower()


def test_geo_regression_cases_remain_usable_migration_input() -> None:
    """Catch dropped or unreadable migration examples before regressions consume them."""

    cases = load_geo_regression_cases()

    assert [case["id"] for case in cases] == ["GEO-001", "GEO-002", "GEO-003", "GEO-004"]
    assert all(bool(object_mapping(case["request"])["locale"]) for case in cases)


def test_geo_regression_cases_are_self_contained_synthetic_records() -> None:
    """Prevent a future fixture update from restoring a scraped product record."""

    cases = load_geo_regression_cases()
    products = [object_mapping(object_mapping(case["request"])["product"])["geoProduct"] for case in cases]
    product_records = [object_mapping(product) for product in products]

    for case in cases:
        request_product = object_mapping(object_mapping(case["request"])["product"])
        for key in ("canonicalUrl", "offerUrl"):
            assert urlparse(str(request_product[key])).hostname == "catalog.example.test"
    assert [product["sku"] for product in product_records] == [
        "EX-ARC-001",
        "EX-DAY-002",
        "EX-WFT-003",
        "EX-CVM-004",
    ]
    assert [product["gtin"] for product in product_records] == [
        "0000000000017",
        "0000000000024",
        "0000000000031",
        "0000000000048",
    ]
    serialized = json.dumps(cases, ensure_ascii=False).lower()
    for leaked_token in ("external-commerce.invalid", "legacy-domain-probe", "legacy-catalog-token"):
        assert leaked_token not in serialized


@pytest.mark.asyncio
async def test_geo_regression_cases_survive_the_sync_generation_boundary_with_products() -> None:
    """Dropping top-level products must fail before retained generation inputs regress."""

    cases = load_geo_regression_cases()
    generation = _CapturingGeneration()
    app = create_app(
        settings=Settings(geo_test_sync_endpoint=True),
        generation_repository=object(),
        result_repository=object(),
        queue=object(),
        generation_service=generation,
    )
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        responses = [await client.post("/internal/v1/geo/test-generations", json=case["request"]) for case in cases]

    assert [response.status_code for response in responses] == [200, 200, 200, 200]
    assert [response.json()["resultStatus"] for response in responses] == [
        case["expect"]["resultStatus"] for case in cases
    ]
    assert [response.json()["schemaTypes"] for response in responses] == [
        case["expect"]["schemaTypes"] for case in cases
    ]
    assert [call["locale"] for call in generation.calls] == [case["request"]["locale"] for case in cases]
    assert [call["product"] for call in generation.calls] == [case["request"]["product"] for case in cases]
