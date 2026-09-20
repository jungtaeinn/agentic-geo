from __future__ import annotations

import asyncio
import hashlib
import json
import re
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any, cast

import pytest
from pydantic import ValidationError
from pytest import MonkeyPatch

import pdp_geo_generator_agent.rest as rest_module
from pdp_geo_generator_agent.rest import create_pdp_geo_generator_rest_handler
from pdp_geo_generator_agent.service import generate_pdp_geo

_ENDPOINT_IDENTITY_FIXTURE = Path(__file__).parent / "fixtures" / "generator-rest-endpoint-identity-contract-v1.json"
_ENDPOINT_IDENTITY_DIGEST = "bc912307882e07f6f8acb9c68a2dd6f715704dd0413330a277d0595597fcbc6f"


def _none_paths(value: object, path: str = "") -> list[str]:
    if value is None:
        return [path]
    if isinstance(value, Mapping):
        mapping = cast(Mapping[object, object], value)
        return [
            nested
            for key, item in mapping.items()
            for nested in _none_paths(item, f"{path}.{key}" if path else str(key))
        ]
    if isinstance(value, list):
        items = cast(list[object], value)
        return [nested for index, item in enumerate(items) for nested in _none_paths(item, f"{path}[{index}]")]
    return []


def test_rest_handler_preserves_405_400_200_and_207_contracts() -> None:
    handler = create_pdp_geo_generator_rest_handler()
    assert asyncio.run(handler({"method": "GET"}))["status"] == 405
    assert asyncio.run(handler({"method": "POST", "json": {}}))["status"] == 400
    good = {"name": "Serum", "description": "Hydration serum."}
    assert asyncio.run(handler({"method": "POST", "json": {"product": good}}))["status"] == 200

    async def selective_retriever(request: dict[str, Any]) -> list[dict[str, Any]]:
        product = cast(dict[str, Any], request["product"])
        if product["name"] == "Broken":
            raise RuntimeError("retrieval failed")
        return []

    partial_handler = create_pdp_geo_generator_rest_handler(
        {"rag": {"mode": "managed-vector-store-rag", "provider": "custom"}, "customRetriever": selective_retriever}
    )
    partial = asyncio.run(partial_handler({"method": "POST", "json": {"products": [good, {"name": "Broken"}]}}))
    assert partial["status"] == 207
    assert partial["body"]["failures"][0]["index"] == 1


def test_rest_handler_keeps_malformed_json_on_the_typescript_500_path() -> None:
    """Raw JSON parse failure is not the same as a valid non-object payload."""

    handler = create_pdp_geo_generator_rest_handler()
    malformed = asyncio.run(handler({"method": "POST", "body": "not-json"}))
    assert malformed["status"] == 500
    assert malformed["body"]["error"].startswith("Unexpected token")

    valid_non_object = asyncio.run(handler({"method": "POST", "body": '"not-json"'}))
    assert valid_non_object["status"] == 400
    assert valid_non_object["body"] == {"error": "At least one product JSON payload is required."}


@pytest.mark.parametrize(
    ("value", "status", "message"),
    [
        ("x", 400, "At least one product JSON payload is required."),
        ([], 400, "At least one product JSON payload is required."),
        (7, 400, "At least one product JSON payload is required."),
        (None, 500, "Cannot read properties of null (reading 'llm')"),
    ],
)
def test_rest_handler_preserves_legacy_primitive_json_request_boundaries(
    value: object, status: int, message: str
) -> None:
    """Valid JSON primitives reach the same TypeScript property-access boundary."""

    response = asyncio.run(
        create_pdp_geo_generator_rest_handler()(
            {"method": "POST", "body": json.dumps(value, ensure_ascii=False, separators=(",", ":"))}
        )
    )

    assert response == {
        "status": status,
        "body": {"error": message},
        "headers": {"content-type": "application/json; charset=utf-8"},
    }


def test_rest_endpoint_identity_uses_whatwg_default_port_and_path_canonicalization(monkeypatch: MonkeyPatch) -> None:
    """A default port and redundant trailing slashes do not make an endpoint foreign."""

    observed: list[dict[str, Any]] = []

    async def generated(_input: dict[str, Any], runtime: dict[str, Any]) -> dict[str, Any]:
        observed.append(runtime)
        return {"result": {}, "diagnostics": {}, "process": []}

    monkeypatch.setattr(rest_module, "generate_pdp_geo", generated)
    response = asyncio.run(
        create_pdp_geo_generator_rest_handler(
            {"provider": "openai", "apiKey": "server-key", "endpoint": "https://EXAMPLE.com:443/tenant///"}
        )(
            {
                "method": "POST",
                "json": {"product": {"name": "Serum"}, "llm": {"endpoint": "https://example.com/tenant"}},
            }
        )
    )

    assert response["status"] == 200
    assert response["headers"] == {"content-type": "application/json; charset=utf-8"}
    assert observed == [
        {
            "provider": "openai",
            "apiKey": "server-key",
            "endpoint": "https://example.com/tenant",
            "rag": {},
        }
    ]


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("https://EXAMPLE.com:443/a/../tenant///", "https://example.com/tenant"),
        ("http:example.com", "http://example.com/"),
        ("https://bücher.example:443/guide", "https://xn--bcher-kva.example/guide"),
        ("https://faß.de/v1", "https://xn--fa-hia.de/v1"),
        ("https://fass.de/v1", "https://fass.de/v1"),
        ("https://0x7f.1/v1", "https://127.0.0.1/v1"),
        ("https://0177.0.0.1/v1", "https://127.0.0.1/v1"),
        ("https://%31%32%37.0.0.1/v1", "https://127.0.0.1/v1"),
        ("https://[2001:db8::1]:443/a/../v1///", "https://[2001:db8::1]/v1"),
        ("https://example.com/a%2Fb/v1", "https://example.com/a%2Fb/v1"),
        ("https://example.com\\v1", "https://example.com/v1"),
        ("https://example.com/%2e%2e/v1", "https://example.com/v1"),
        ("https:////EXAMPLE.com:443/../v1", "https://example.com/v1"),
        ("mailto:foo", "mailto://foo"),
        ("file:///tmp/profile", "file:///tmp/profile"),
        ("http:/example.com", "http://example.com/"),
    ],
)
def test_rest_endpoint_identity_matches_whatwg_canonical_url_forms(value: str, expected: str) -> None:
    """These are the deletion-time ``new URL`` identity forms used by the credential guard."""

    endpoint_identity = cast(Callable[[str], str], getattr(rest_module, "_endpoint_identity"))
    assert endpoint_identity(value) == expected


def test_rest_endpoint_identity_replays_the_curated_public_credential_fixture() -> None:
    """The credential guard consumes a frozen public URL-identity fixture."""

    fixture = json.loads(_ENDPOINT_IDENTITY_FIXTURE.read_text(encoding="utf-8"))
    contract = {key: value for key, value in fixture.items() if key != "wholeContractSha256"}
    assert hashlib.sha256(json.dumps(contract, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest() == _ENDPOINT_IDENTITY_DIGEST
    assert fixture["wholeContractSha256"] == _ENDPOINT_IDENTITY_DIGEST
    endpoint_identity = cast(Callable[[str], str], getattr(rest_module, "_endpoint_identity"))
    for case in cast(list[dict[str, str]], fixture["cases"]):
        assert endpoint_identity(case["input"]) == case["identity"], case["id"]
    for value in cast(list[str], fixture["invalidInputs"]):
        with pytest.raises(rest_module.RestRequestConfigurationError, match=rf"Invalid provider endpoint URL: {re.escape(value)}"):
            endpoint_identity(value)


def test_rest_credential_guard_keeps_uts46_idna_hosts_distinct(monkeypatch: MonkeyPatch) -> None:
    """A server key must not cross from WHATWG ``faß.de`` to ``fass.de``."""

    observed: list[dict[str, Any]] = []

    async def generated(_input: dict[str, Any], runtime: dict[str, Any]) -> dict[str, Any]:
        observed.append(runtime)
        return {"result": {}, "diagnostics": {}, "process": []}

    monkeypatch.setattr(rest_module, "generate_pdp_geo", generated)
    response = asyncio.run(
        create_pdp_geo_generator_rest_handler(
            {"provider": "openai", "apiKey": "server-key", "endpoint": "https://faß.de/v1"}
        )(
            {
                "method": "POST",
                "json": {"product": {"name": "Serum"}, "llm": {"endpoint": "https://fass.de/v1"}},
            }
        )
    )

    assert response == {
        "status": 400,
        "body": {
            "error": "llm.endpoint cannot override the configured provider endpoint while using a server-managed API key."
        },
        "headers": {"content-type": "application/json; charset=utf-8"},
    }
    assert observed == []


def test_rest_credential_guard_rejects_whatwg_distinct_repeated_slash_dot_path(monkeypatch: MonkeyPatch) -> None:
    """A source-normalized request path must not inherit a key for its distinct configured path."""

    observed: list[dict[str, Any]] = []

    async def generated(_input: dict[str, Any], runtime: dict[str, Any]) -> dict[str, Any]:
        observed.append(runtime)
        return {"result": {}, "diagnostics": {}, "process": []}

    monkeypatch.setattr(rest_module, "generate_pdp_geo", generated)
    response = asyncio.run(
        create_pdp_geo_generator_rest_handler(
            {"provider": "openai", "apiKey": "server-key", "endpoint": "https://trusted.example/a//b"}
        )(
            {
                "method": "POST",
                "json": {"product": {"name": "Serum"}, "llm": {"endpoint": "https://trusted.example/a//../b"}},
            }
        )
    )

    assert response["status"] == 400
    assert response["body"] == {
        "error": "llm.endpoint cannot override the configured provider endpoint while using a server-managed API key."
    }
    assert observed == []


@pytest.mark.parametrize(
    "request_endpoint",
    [
        "https://a‌b.example/v1",
        "https://1.2.3.4.5/v1",
        "https://1..2/v1",
        "https://.1/v1",
    ],
)
def test_rest_credential_guard_rejects_node_invalid_hosts_before_a_server_key_reaches_generation(
    monkeypatch: MonkeyPatch, request_endpoint: str
) -> None:
    """A Node-invalid endpoint must fail before any configured credential is forwarded.

    Removing the URL validation at the credential boundary would turn the
    ZWNJ case into a successful request against ``ab.example``; accepting any
    listed numeric form would instead report an endpoint override.  Both are
    distinct from the source's exact invalid-URL behavior.
    """

    observed: list[dict[str, Any]] = []

    async def generated(_input: dict[str, Any], runtime: dict[str, Any]) -> dict[str, Any]:
        observed.append(runtime)
        return {"result": {}, "diagnostics": {}, "process": []}

    monkeypatch.setattr(rest_module, "generate_pdp_geo", generated)
    response = asyncio.run(
        create_pdp_geo_generator_rest_handler(
            {"provider": "openai", "apiKey": "server-key", "endpoint": "https://ab.example/v1"}
        )(
            {
                "method": "POST",
                "json": {"product": {"name": "Serum"}, "llm": {"endpoint": request_endpoint}},
            }
        )
    )

    assert response == {
        "status": 400,
        "body": {"error": f"Invalid provider endpoint URL: {request_endpoint}"},
        "headers": {"content-type": "application/json; charset=utf-8"},
    }
    assert observed == []


def test_rest_credential_guard_treats_raw_and_encoded_caret_paths_as_one_node_endpoint(monkeypatch: MonkeyPatch) -> None:
    """Escaping ``^`` must not block a key for the same Node URL endpoint."""

    observed: list[dict[str, Any]] = []

    async def generated(_input: dict[str, Any], runtime: dict[str, Any]) -> dict[str, Any]:
        observed.append(runtime)
        return {"result": {}, "diagnostics": {}, "process": []}

    monkeypatch.setattr(rest_module, "generate_pdp_geo", generated)
    response = asyncio.run(
        create_pdp_geo_generator_rest_handler(
            {"provider": "openai", "apiKey": "server-key", "endpoint": "https://trusted.example/a%5Eb"}
        )(
            {
                "method": "POST",
                "json": {"product": {"name": "Serum"}, "llm": {"endpoint": "https://trusted.example/a^b"}},
            }
        )
    )

    assert response["status"] == 200
    assert observed == [
        {
            "provider": "openai",
            "apiKey": "server-key",
            "endpoint": "https://trusted.example/a^b",
            "rag": {},
        }
    ]


def test_rest_final_proofreading_preserves_empty_string_overrides_with_nullish_merging(monkeypatch: MonkeyPatch) -> None:
    """TypeScript ``??`` retains empty endpoint/model values instead of falling back."""

    observed: list[dict[str, Any]] = []

    async def generated(_input: dict[str, Any], runtime: dict[str, Any]) -> dict[str, Any]:
        observed.append(runtime)
        return {"result": {}, "diagnostics": {}, "process": []}

    monkeypatch.setattr(rest_module, "generate_pdp_geo", generated)
    response = asyncio.run(
        create_pdp_geo_generator_rest_handler(
            {
                "finalProofreading": {
                    "enabled": True,
                    "endpoint": "https://configured.example/proofread",
                    "model": "configured-model",
                }
            }
        )(
            {
                "method": "POST",
                "json": {
                    "product": {"name": "Serum"},
                    "finalProofreading": {"endpoint": "", "model": ""},
                },
            }
        )
    )

    assert response["status"] == 200
    assert observed[0]["finalProofreading"] == {
        "enabled": True,
        "endpoint": "",
        "model": "",
        "provider": None,
        "apiKey": None,
        "deployment": None,
        "apiVersion": None,
    }


def test_rest_final_proofreading_inherits_a_provider_different_request_parent(monkeypatch: MonkeyPatch) -> None:
    """Legacy final-proofreading settings retain request-parent fields before config fallbacks."""

    observed: list[dict[str, Any]] = []

    async def generated(_input: dict[str, Any], runtime: dict[str, Any]) -> dict[str, Any]:
        observed.append(runtime)
        return {"result": {}, "diagnostics": {}, "process": []}

    monkeypatch.setattr(rest_module, "generate_pdp_geo", generated)
    response = asyncio.run(
        create_pdp_geo_generator_rest_handler(
            {
                "provider": "openai",
                "apiKey": "server-key",
                "model": "server-model",
                "endpoint": "https://server.example/v1",
                "deployment": "server-deployment",
                "apiVersion": "server-version",
            }
        )(
            {
                "method": "POST",
                "json": {
                    "product": {"name": "Serum"},
                    "llm": {
                        "provider": "azure-openai",
                        "apiKey": "request-key",
                        "model": "request-model",
                        "endpoint": "https://request.example/v1",
                        "deployment": "request-deployment",
                        "deployments": {"proofreading": "request-proofreading-deployment"},
                        "apiVersion": "request-version",
                    },
                    "finalProofreading": {"enabled": True},
                },
            }
        )
    )

    assert response["status"] == 200
    assert observed[0]["finalProofreading"] == {
        "enabled": True,
        "provider": "azure-openai",
        "apiKey": "request-key",
        "model": "request-model",
        "endpoint": "https://request.example/v1",
        "deployment": "request-proofreading-deployment",
        "apiVersion": "request-version",
    }


def test_rest_final_proofreading_does_not_inherit_configured_deployment_for_a_different_request_parent(
    monkeypatch: MonkeyPatch,
) -> None:
    """The configured deployment fallback is unavailable unless the request parent matches config."""

    observed: list[dict[str, Any]] = []

    async def generated(_input: dict[str, Any], runtime: dict[str, Any]) -> dict[str, Any]:
        observed.append(runtime)
        return {"result": {}, "diagnostics": {}, "process": []}

    monkeypatch.setattr(rest_module, "generate_pdp_geo", generated)
    response = asyncio.run(
        create_pdp_geo_generator_rest_handler(
            {
                "provider": "openai",
                "apiKey": "server-key",
                "deployments": {"proofreading": "server-proof"},
                "deployment": "server-deployment",
            }
        )(
            {
                "method": "POST",
                "json": {
                    "product": {"name": "Serum"},
                    "llm": {"provider": "azure-openai", "apiKey": "request-key"},
                    "finalProofreading": {"enabled": True},
                },
            }
        )
    )

    assert response["status"] == 200
    assert observed[0]["finalProofreading"]["deployment"] is None


def test_schema_target_enum_rejection_matches_direct_and_rest_failure_semantics() -> None:
    """A bogus schema target must fail at the control-plane boundary.

    Without this validation, the Python renderer treats the unknown target as
    an empty graph request and returns a successful-but-useless artifact.  The
    retained Zod schema rejects it directly and REST reports the per-product
    failure as a 207 response.
    """

    invalid = {
        "product": {"name": "Validation Probe"},
        "hints": {"locale": "en-US", "schemaTargets": ["Bogus"]},
    }

    with pytest.raises(ValidationError, match="schemaTargets"):
        asyncio.run(generate_pdp_geo(invalid))

    response = asyncio.run(
        create_pdp_geo_generator_rest_handler()({"method": "POST", "json": invalid})
    )
    assert response["status"] == 207
    assert response["body"]["results"] == []
    assert response["body"]["failures"] == [{"index": 0, "error": response["body"]["failures"][0]["error"]}]
    expected_error = """[
  {
    "code": "invalid_value",
    "values": [
      "WebPage",
      "Product",
      "FAQPage",
      "HowTo",
      "BreadcrumbList"
    ],
    "path": [
      "hints",
      "schemaTargets",
      0
    ],
    "message": "Invalid option: expected one of \\\"WebPage\\\"|\\\"Product\\\"|\\\"FAQPage\\\"|\\\"HowTo\\\"|\\\"BreadcrumbList\\\""
  }
]"""
    assert response["body"]["failures"][0]["error"] == expected_error
    assert response["body"]["logs"][0]["diagnostics"]["evidence"][0]["value"] == expected_error


@pytest.mark.parametrize(
    ("label", "controls"),
    [
        ("schema target enum", {"hints": {"schemaTargets": ["Bogus"]}}),
        ("update target enum", {"hints": {"updateTargets": ["Bogus"]}}),
        ("brand identity URL", {"hints": {"brandSameAs": ["not-a-url"]}}),
        ("organization URL", {"hints": {"organization": {"name": "NEO", "url": "not-a-url"}}}),
        ("reranker enum", {"rag": {"rerankerProvider": "not-a-reranker"}}),
        ("positive max chunks", {"rag": {"maxChunks": 0}}),
        ("score threshold range", {"rag": {"scoreThreshold": 1.01}}),
        ("nested query planning", {"rag": {"queryPlanning": {"updateTargets": ["Bogus"]}}}),
        ("nested hydration", {"rag": {"fullDocumentHydration": {"maxDocuments": 0}}}),
        ("RAG document object", {"rag": {"documents": [{"name": "source.md"}]}}),
    ],
)
def test_control_plane_rejects_the_typescript_zod_invalid_cases_directly_and_over_rest(
    label: str, controls: dict[str, Any]
) -> None:
    """Port the retained input schema rather than silently normalizing bad controls.

    Each value here is rejected by ``PdpGeoGenerationInputSchema``.  The REST
    adapter intentionally catches direct per-product validation errors and
    returns its existing partial-success (207) envelope.
    """

    invalid = {"product": {"name": "Validation Probe"}, **controls}

    with pytest.raises(ValidationError):
        asyncio.run(generate_pdp_geo(invalid))

    response = asyncio.run(
        create_pdp_geo_generator_rest_handler()({"method": "POST", "json": invalid})
    )
    assert response["status"] == 207, label
    assert response["body"]["results"] == [], label
    assert response["body"]["failures"][0]["index"] == 0, label


@pytest.mark.parametrize(
    "url",
    [
        "http:example.com",
        "https:example.com",
        "https://example.com/a b",
    ],
)
def test_url_controls_accept_the_same_url_can_parse_forms_as_typescript(url: str) -> None:
    """Zod's URL validator delegates to the WHATWG parser, not urllib's host rules."""

    request = {"product": {"name": "URL Probe"}, "hints": {"brandSameAs": [url]}}
    assert asyncio.run(generate_pdp_geo(request))["result"]["locale"] == "en-US"
    response = asyncio.run(create_pdp_geo_generator_rest_handler()({"method": "POST", "json": request}))
    assert response["status"] == 200


@pytest.mark.parametrize("url", ["//example.com", "http://"])
def test_url_controls_reject_non_absolute_or_incomplete_urls_like_typescript(url: str) -> None:
    request = {"product": {"name": "URL Probe"}, "hints": {"brandSameAs": [url]}}
    with pytest.raises(ValidationError):
        asyncio.run(generate_pdp_geo(request))
    response = asyncio.run(create_pdp_geo_generator_rest_handler()({"method": "POST", "json": request}))
    assert response["status"] == 207


def test_source_url_keeps_the_ts_whatwg_canonical_id_shape_directly_and_over_rest() -> None:
    request = {"product": {"name": "URL Probe"}, "source": {"url": "http:example.com"}}
    direct = asyncio.run(generate_pdp_geo(request))["result"]
    rest = asyncio.run(create_pdp_geo_generator_rest_handler()({"method": "POST", "json": request}))
    assert rest["status"] == 200

    for result in (direct, rest["body"]["results"][0]):
        graph = result["schemaMarkup"]["jsonLd"]["@graph"]
        webpage = next(item for item in graph if "WebPage" in item["@type"])
        product = next(item for item in graph if item["@type"] == "Product")
        assert webpage["@id"] == "http://example.com/#webpage"
        assert webpage["url"] == "http://example.com/"
        assert product["@id"] == "http://example.com/#product"
        assert product["mainEntityOfPage"] == {"@id": "http://example.com/#webpage"}


def test_rest_serialization_omits_absent_values_but_preserves_json_values(monkeypatch: MonkeyPatch) -> None:
    """Port the JS JSON.stringify boundary: omit undefined, retain false/0/empty."""

    handler = create_pdp_geo_generator_rest_handler()
    real = asyncio.run(handler({"method": "POST", "json": {"product": {"name": "Serum"}}}))
    assert real["status"] == 200
    assert _none_paths(real["body"]) == []

    async def generated(_input: dict[str, Any], _runtime: dict[str, Any]) -> dict[str, Any]:
        return {
            "result": {"presentFalse": False, "presentZero": 0, "presentEmpty": "", "absent": None},
            "diagnostics": {"presentFalse": False, "presentZero": 0, "presentEmpty": "", "absent": None},
            "process": [],
        }

    monkeypatch.setattr(rest_module, "generate_pdp_geo", generated)
    synthetic = asyncio.run(handler({"method": "POST", "json": {"product": {"name": "Serum"}}}))["body"]
    assert synthetic["results"] == [{"presentFalse": False, "presentZero": 0, "presentEmpty": ""}]
    assert synthetic["logs"][0]["diagnostics"] == {"presentFalse": False, "presentZero": 0, "presentEmpty": ""}
    assert _none_paths(synthetic) == []


def test_rest_sparse_hydra_artifact_matches_ts_public_schema_shape_and_optional_omission() -> None:
    """Freeze the retained TS 200 response for the sparse public artifact.

    The REST layer must expose the same wire-facing schema fields as direct
    generation: no Python-only graph/script mirrors, a complete one-line
    source instruction is retained as HowTo, no nullable source, and no
    inactive copy-refinement diagnostics.
    """

    handler = create_pdp_geo_generator_rest_handler()
    response = asyncio.run(
        handler(
            {
                "method": "POST",
                "json": {
                    "product": {
                        "name": "Hydra Barrier Cream",
                        "description": "Daily hydration cream for dry skin.",
                        "brand": "Neo",
                        "benefits": ["Supports hydration"],
                        "ingredients": ["Ceramide"],
                        "usage": ["Apply after serum."],
                    },
                    "hints": {"locale": "en-US"},
                },
            }
        )
    )

    assert response["status"] == 200
    assert _none_paths(response["body"]) == []
    result = response["body"]["results"][0]
    graph = result["schemaMarkup"]["jsonLd"]["@graph"]
    product = next(item for item in graph if item["@type"] == "Product")
    assert list(result["schemaMarkup"]) == ["jsonLd", "scriptTag"]
    assert [item["@type"] for item in graph] == [["WebPage", "ItemPage"], "Product", "FAQPage", "HowTo", "BreadcrumbList"]
    assert [item["name"] for item in product["additionalProperty"]] == [
        "Target customer",
        "Recommended skin type",
        "Key benefit",
        "Key ingredients",
        "Ingredient/effect detail",
    ]
    howto = next(item for item in graph if item["@type"] == "HowTo")
    assert howto["step"] == [
        {"@type": "HowToStep", "position": 1, "name": "Step 1", "text": "Apply after serum."}
    ]
    assert result["content"]["sections"]["howToUse"] == "Apply after serum."
    assert "source" not in result
    assert "copyRefinement" not in response["body"]["logs"][0]["diagnostics"]


def test_rest_handler_does_not_leak_a_server_managed_key_to_foreign_stage_endpoints() -> None:
    handler = create_pdp_geo_generator_rest_handler(
        {
            "provider": "azure-openai",
            "apiKey": "server-secret",
            "endpoint": "https://trusted.openai.azure.com/tenant-a",
            "copyRefinement": {"enabled": True, "provider": "azure-openai"},
        }
    )
    foreign_parent = asyncio.run(
        handler(
            {"method": "POST", "json": {"product": {"name": "Serum"}, "llm": {"endpoint": "https://attacker.example"}}}
        )
    )
    assert foreign_parent["status"] == 400
    assert "server-managed API key" in foreign_parent["body"]["error"]

    foreign_stage = asyncio.run(
        handler(
            {
                "method": "POST",
                "json": {
                    "product": {"name": "Serum"},
                    "copyRefinement": {"provider": "gemini", "model": "gemini-test"},
                },
            }
        )
    )
    assert foreign_stage["status"] == 400
    assert "server-managed API key" in foreign_stage["body"]["error"]


def test_rest_handler_rejects_untrusted_managed_search_endpoint_before_generation(monkeypatch: MonkeyPatch) -> None:
    generated: list[dict[str, Any]] = []

    async def generate_stub(input_: dict[str, Any], runtime: dict[str, Any]) -> dict[str, Any]:
        generated.append({"input": input_, "runtime": runtime})
        return {"result": {}, "diagnostics": {}, "process": []}

    monkeypatch.setattr(rest_module, "generate_pdp_geo", generate_stub)
    handler = create_pdp_geo_generator_rest_handler(
        {
            "provider": "openai",
            "apiKey": "server-managed-key",
            "rag": {
                "mode": "managed-vector-store-rag",
                "provider": "openai",
                "vectorStoreId": "configured-store",
                "managedSearchEndpoint": "https://configured-search.example/search",
            },
        }
    )

    response = asyncio.run(
        handler(
            {
                "method": "POST",
                "json": {
                    "product": {"name": "Serum"},
                    "rag": {"managedSearchEndpoint": "https://attacker.example/search"},
                },
            }
        )
    )

    assert response["status"] == 400
    assert "rag.managedSearchEndpoint" in response["body"]["error"]
    assert generated == []


def test_rest_handler_allows_default_managed_search_and_caller_owned_key(monkeypatch: MonkeyPatch) -> None:
    generated: list[dict[str, Any]] = []

    async def generate_stub(input_: dict[str, Any], runtime: dict[str, Any]) -> dict[str, Any]:
        generated.append({"input": input_, "runtime": runtime})
        return {"result": {}, "diagnostics": {}, "process": []}

    monkeypatch.setattr(rest_module, "generate_pdp_geo", generate_stub)
    handler = create_pdp_geo_generator_rest_handler(
        {
            "provider": "openai",
            "apiKey": "server-managed-key",
            "rag": {
                "mode": "managed-vector-store-rag",
                "provider": "openai",
                "vectorStoreId": "configured-store",
                "managedSearchEndpoint": "https://configured-search.example/search",
            },
        }
    )
    allowed_requests = [
        {
            "method": "POST",
            "json": {
                "product": {"name": "Serum"},
                "rag": {
                    "managedSearchEndpoint": "https://configured-search.example/search/"
                },
            },
        },
        {
            "method": "POST",
            "json": {
                "product": {"name": "Serum"},
                "rag": {
                    "managedSearchEndpoint": "https://api.openai.com/v1/vector_stores/configured-store/search/"
                },
            },
        },
        {
            "method": "POST",
            "json": {
                "product": {"name": "Serum"},
                "llm": {"apiKey": "caller-key"},
                "rag": {"managedSearchEndpoint": "https://attacker.example/search"},
            },
        },
    ]

    for request in allowed_requests:
        response = asyncio.run(handler(request))
        assert response["status"] == 200

    assert [item["runtime"]["apiKey"] for item in generated] == [
        "server-managed-key",
        "server-managed-key",
        "caller-key",
    ]


def test_rest_handler_returns_500_for_unexpected_request_reader_failure() -> None:
    handler = create_pdp_geo_generator_rest_handler()

    def explode() -> object:
        raise RuntimeError("unparseable request")

    response = asyncio.run(handler({"method": "POST", "json": explode}))
    assert response["status"] == 500
    assert response["body"]["error"] == "unparseable request"


def test_rest_batch_is_concurrent_and_orders_success_logs_before_failure_logs(monkeypatch: MonkeyPatch) -> None:
    entered: list[str] = []
    release = asyncio.Event()

    async def fake_generate(input_: dict[str, Any], _runtime: dict[str, Any]) -> dict[str, Any]:
        product = cast(dict[str, Any], input_["product"])
        name = cast(str, product["name"])
        entered.append(name)
        if len(entered) == 2:
            release.set()
        await release.wait()
        if name == "Broken":
            raise RuntimeError("broken product")
        return {"result": {"name": name}, "diagnostics": {"name": name}, "process": [{"id": "artifact"}]}

    monkeypatch.setattr(rest_module, "generate_pdp_geo", fake_generate)
    handler = create_pdp_geo_generator_rest_handler()
    response = asyncio.run(
        asyncio.wait_for(
            handler({"method": "POST", "json": {"products": [{"name": "Broken"}, {"name": "Good"}]}}),
            timeout=0.5,
        )
    )
    assert response["status"] == 207
    assert response["headers"] == {"content-type": "application/json; charset=utf-8"}
    assert response["body"]["results"] == [{"name": "Good"}]
    assert response["body"]["failures"] == [{"index": 0, "error": "broken product"}]
    assert response["body"]["logs"] == [
        {"diagnostics": {"name": "Good"}, "process": [{"id": "artifact"}]},
        {
            "diagnostics": response["body"]["logs"][1]["diagnostics"],
            "process": response["body"]["logs"][1]["process"],
        },
    ]
    assert [step["id"] for step in response["body"]["logs"][1]["process"]] == [
        "input",
        "normalize",
        "rag-load",
        "chunk",
        "embed",
        "retrieve",
        "rerank",
        "generate",
        "validate",
        "repair",
        "quality-gate",
        "artifact",
    ]
    failure_diagnostics = response["body"]["logs"][1]["diagnostics"]
    assert list(failure_diagnostics) == [
        "recommendations",
        "evidence",
        "selectedRagChunks",
        "ragUsage",
        "validationWarnings",
        "ragMode",
        "generatedAt",
    ]
    assert failure_diagnostics["evidence"] == [{"field": "generation", "source": "repair", "value": "broken product"}]
    assert failure_diagnostics["validationWarnings"] == ["broken product"]
    failure_process = response["body"]["logs"][1]["process"]
    assert [step["status"] for step in failure_process] == ["done", "error", *["pending"] * 10]
    assert failure_process[0]["message"] == "입력을 수신했습니다."
    assert failure_process[1]["message"] == "broken product"
    assert failure_process[0]["startedAt"] == failure_process[0]["completedAt"]
    assert failure_process[1]["startedAt"] == failure_process[1]["completedAt"]
    assert all("startedAt" not in step and "completedAt" not in step for step in failure_process[2:])


def test_rest_stage_with_different_provider_cannot_borrow_parent_request_key() -> None:
    handler = create_pdp_geo_generator_rest_handler()
    response = asyncio.run(
        handler(
            {
                "method": "POST",
                "json": {
                    "product": {"name": "Serum"},
                    "llm": {"provider": "azure-openai", "apiKey": "azure-request-key"},
                    "finalProofreading": {"enabled": True, "provider": "gemini", "model": "gemini-test"},
                },
            }
        )
    )
    assert response["status"] == 400
    assert "requires its own API key" in response["body"]["error"]
