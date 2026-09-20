"""Frozen, provenance-aware TypeScript replacement-oracle helpers."""

from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path
from typing import Any, cast

from pdp_geo_eval_agent.benchmark import eval_products

from pdp_geo_generator_agent.rest import create_pdp_geo_generator_rest_handler
from pdp_geo_generator_agent.service import generate_pdp_geo

_FIXTURES = Path(__file__).parent / "fixtures"
_RUNTIME_FIXTURE = _FIXTURES / "generator-runtime-contract-v1.json"
_RUNTIME_WHOLE_CONTRACT_SHA256 = "7c48fa5ff29db8d1af6e52abac5968daf6295553e90c0553acf54d505b17c9dd"
_RAG_PROFILE_FIXTURE = _FIXTURES / "generator-rag-profile-contract-v1.json"
_RAG_PROFILE_WHOLE_CONTRACT_SHA256 = "6d6331b12c43b5ec86cad261825a24bd129bb7888db42e02534d84b818311cc7"
_RAG_CLI_FIXTURE = _FIXTURES / "generator-rag-cli-contract-v1.json"
_RAG_CLI_WHOLE_CONTRACT_SHA256 = "54363ae64f547fdad5a8063c66900e7665d05ba528d0b8762c4a1e3762e9e161"
_PUBLIC_SURFACE_FIXTURE = _FIXTURES / "generator-public-surface-contract-v1.json"
_PUBLIC_SURFACE_WHOLE_CONTRACT_SHA256 = "ad7c736a09ecf35d27df62ec86858dee98527e09fcb956dbe19aa29beaace067"
_TIMESTAMP_KEYS = {"generatedAt", "startedAt", "completedAt"}
_TIMESTAMP_SENTINEL = "<legacy-capture-timestamp>"


def load_frozen_runtime_contract() -> dict[str, Any]:
    """Load a deletion-time legacy capture without consulting Python output."""

    payload = cast(dict[str, Any], json.loads(_RUNTIME_FIXTURE.read_text(encoding="utf-8")))
    whole_contract = {key: value for key, value in payload.items() if key != "wholeContractSha256"}
    encoded = json.dumps(whole_contract, ensure_ascii=False, separators=(",", ":")).encode()
    assert hashlib.sha256(encoded).hexdigest() == _RUNTIME_WHOLE_CONTRACT_SHA256
    assert payload["wholeContractSha256"] == _RUNTIME_WHOLE_CONTRACT_SHA256
    return payload


def load_frozen_rag_profile_contract() -> dict[str, Any]:
    """Load the legacy profile capture, including persistence failure order."""

    payload = cast(dict[str, Any], json.loads(_RAG_PROFILE_FIXTURE.read_text(encoding="utf-8")))
    whole_contract = {key: value for key, value in payload.items() if key != "wholeContractSha256"}
    encoded = json.dumps(whole_contract, ensure_ascii=False, separators=(",", ":")).encode()
    assert hashlib.sha256(encoded).hexdigest() == _RAG_PROFILE_WHOLE_CONTRACT_SHA256
    assert payload["wholeContractSha256"] == _RAG_PROFILE_WHOLE_CONTRACT_SHA256
    return payload


def load_frozen_rag_cli_contract() -> dict[str, Any]:
    """Load the exact machine-readable legacy RAG CLI contract."""

    payload = cast(dict[str, Any], json.loads(_RAG_CLI_FIXTURE.read_text(encoding="utf-8")))
    whole_contract = {key: value for key, value in payload.items() if key != "wholeContractSha256"}
    encoded = json.dumps(whole_contract, ensure_ascii=False, separators=(",", ":")).encode()
    assert hashlib.sha256(encoded).hexdigest() == _RAG_CLI_WHOLE_CONTRACT_SHA256
    assert payload["wholeContractSha256"] == _RAG_CLI_WHOLE_CONTRACT_SHA256
    return payload


def load_frozen_public_surface_contract() -> dict[str, Any]:
    """Load the static legacy root runtime-export capture."""

    payload = cast(dict[str, Any], json.loads(_PUBLIC_SURFACE_FIXTURE.read_text(encoding="utf-8")))
    whole_contract = {key: value for key, value in payload.items() if key != "wholeContractSha256"}
    encoded = json.dumps(whole_contract, ensure_ascii=False, separators=(",", ":")).encode()
    assert hashlib.sha256(encoded).hexdigest() == _PUBLIC_SURFACE_WHOLE_CONTRACT_SHA256
    assert payload["wholeContractSha256"] == _PUBLIC_SURFACE_WHOLE_CONTRACT_SHA256
    return payload


def test_runtime_fixture_is_present_and_is_externally_digest_pinned() -> None:
    """Catch an absent or locally-rewritten captured legacy contract."""

    contract = load_frozen_runtime_contract()
    assert contract["provenance"]["capture"] == "agentic-geo-public-synthetic-runtime-v1"


_SPARSE_HYDRA_REQUEST: dict[str, object] = {
    "product": {
        "name": "Hydra Barrier Cream",
        "description": "Daily hydration cream for dry skin.",
        "brand": "Neo",
        "benefits": ["Supports hydration"],
        "ingredients": ["Ceramide"],
        "usage": ["Apply after serum."],
    },
    "hints": {"locale": "en-US", "market": "US", "brand": "Neo"},
}


def _normalise_captured_wire(value: object) -> object:
    if isinstance(value, dict):
        mapping = cast(dict[str, object], value)
        return {
            key: _TIMESTAMP_SENTINEL if key in _TIMESTAMP_KEYS and isinstance(item, str) else _normalise_captured_wire(item)
            for key, item in mapping.items()
        }
    if isinstance(value, list):
        return [_normalise_captured_wire(item) for item in cast(list[object], value)]
    return value


def _wire_sha256(value: object) -> str:
    encoded = json.dumps(_normalise_captured_wire(value), ensure_ascii=False, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def test_runtime_wire_normalization_keeps_timestamp_shape_and_full_binary64_values() -> None:
    """Only timestamp values vary between captures; ordering and floats remain observable."""

    assert _normalise_captured_wire(
        {"generatedAt": "2026-09-11T00:00:00.000Z", "score": 0.12345678901234567}
    ) == {"generatedAt": "<legacy-capture-timestamp>", "score": 0.12345678901234567}


def test_sparse_hydra_keeps_public_shape_and_complete_source_grounded_provenance() -> None:
    """A legacy input keeps its public schema while quality evolves past hashes."""

    run = asyncio.run(generate_pdp_geo(_SPARSE_HYDRA_REQUEST))
    result = run["result"]
    graph = result["schemaMarkup"]["jsonLd"]["@graph"]
    product = next(item for item in graph if item["@type"] == "Product")
    webpage = next(item for item in graph if "WebPage" in item["@type"])
    faq = next(item for item in graph if item["@type"] == "FAQPage")["mainEntity"]

    assert set(result["schemaMarkup"]) == {"jsonLd", "scriptTag"}
    assert set(result["content"]) == {"html", "sections"}
    assert result["content"]["sections"]["howToUse"] == "Apply after serum."
    assert product["description"] != webpage["description"]
    assert "The page also outlines how to use Hydra Barrier Cream from Neo." in webpage["description"]
    assert "Apply after serum." not in webpage["description"]
    for fact in ("Hydra Barrier Cream", "Neo", "Daily hydration cream for dry skin.", "Ceramide", "Supports hydration"):
        assert fact.casefold() in product["description"].casefold()
    assert 2 <= len(faq) <= 3
    rendered_faq = "\n".join(f"{item['name']}\n{item['acceptedAnswer']['text']}" for item in faq)
    for fact in ("Ceramide", "Supports hydration", "Apply after serum."):
        assert fact.casefold() in rendered_faq.casefold()

    provenance = run["diagnostics"]["finalPublicCopyProvenance"]
    assert all(item["evidenceIds"] for item in provenance)
    assert all(sentence["evidenceIds"] for item in provenance for sentence in item["sentences"])
    assert not any(finding["source"] == "public-copy-provenance" for finding in run["diagnostics"]["validationFindings"])
    assert run["diagnostics"]["finalProofreading"]["skippedFields"] == []
    assert run["diagnostics"]["finalProofreading"]["warnings"] == []


def _benchmark_request(product_id: str) -> dict[str, object]:
    product = eval_products[product_id]
    locale = "ko-KR" if product_id.startswith(("sample_derma-", "byeolmorae-")) else "en-US"
    return {
        "product": product,
        "hints": {
            "locale": locale,
            "market": "KR" if locale == "ko-KR" else "US",
            "brand": product.get("brand"),
            "category": product.get("category"),
        },
    }


def _captured_runtime_requests() -> dict[str, dict[str, object]]:
    return {
        "sparse-hydra": _SPARSE_HYDRA_REQUEST,
        **{product_id: _benchmark_request(product_id) for product_id in eval_products},
    }


def test_frozen_runtime_requests_keep_direct_and_rest_public_shapes() -> None:
    """Captured inputs retain schema compatibility without freezing copy bytes."""

    contract = load_frozen_runtime_contract()
    requests = _captured_runtime_requests()
    handler = create_pdp_geo_generator_rest_handler()

    for expected in cast(list[dict[str, str]], contract["contracts"]):
        request = requests[expected["id"]]
        assert _wire_sha256(request) == expected["inputSha256"]

        direct = asyncio.run(generate_pdp_geo(request))
        rest = asyncio.run(handler({"method": "POST", "json": request}))

        assert set(direct) == {"result", "diagnostics", "process"}
        assert set(direct["result"]) == {
            "locale",
            "market",
            "schemaMarkup",
            "content",
            "diagnostics",
            "generatedAt",
            "ragProfile",
        }
        assert rest["status"] == 200
        assert set(rest["body"]) == {"results", "logs", "failures"}
        assert len(rest["body"]["results"]) == 1
        assert rest["body"]["failures"] == []
        assert _normalise_captured_wire(direct["result"]) == _normalise_captured_wire(rest["body"]["results"][0])
        assert not any(
            finding["source"] == "public-copy-provenance"
            for finding in direct["diagnostics"]["validationFindings"]
        )


def test_frozen_runtime_contract_replays_rest_primitive_json_boundaries() -> None:
    """The deleted Fetch handler did not reject valid primitives uniformly."""

    contract = load_frozen_runtime_contract()
    values: dict[str, object] = {"string": "x", "array": [], "number": 7, "null": None}
    handler = create_pdp_geo_generator_rest_handler()

    for expected in cast(list[dict[str, str]], contract["restEdgeCases"]):
        value = values[expected["id"]]
        response = asyncio.run(
            handler({"method": "POST", "body": json.dumps(value, ensure_ascii=False, separators=(",", ":"))})
        )
        captured_wire = {
            "status": response["status"],
            "headers": [[key, item] for key, item in response["headers"].items()],
            "body": response["body"],
        }
        assert _wire_sha256(value) == expected["inputSha256"]
        assert _wire_sha256(captured_wire) == expected["responseSha256"]
