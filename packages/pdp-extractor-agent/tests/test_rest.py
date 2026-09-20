"""Behavioral compatibility checks for the extractor REST batch adapter."""

from __future__ import annotations

import json

import pytest

from pdp_extractor_agent.rest import create_product_extractor_rest_handler


@pytest.mark.asyncio
async def test_batch_returns_exact_200_or_207_and_keeps_success_logs_before_failures() -> None:
    """A failed source must not discard a successful sibling result."""

    async def scripted_extract(source: str, source_type: str, **_: object) -> dict[str, object]:
        if source == "https://bad.test/pdp":
            raise RuntimeError("upstream returned 403")
        return {
            "source": source,
            "sourceType": source_type,
            "geoProduct": {"name": "Good PDP"},
            "diagnostics": {"source": source, "process": [{"id": "json", "status": "done"}]},
        }

    handler = create_product_extractor_rest_handler(extract_one=scripted_extract)
    all_good = await handler("POST", {"sources": ["https://good.test/pdp"]})
    assert all_good.status == 200 and all_good.headers == {"Content-Type": "application/json; charset=utf-8"}
    assert all_good.payload["results"] == [
        {
            "source": "https://good.test/pdp",
            "sourceType": "url",
            "geoProduct": {"name": "Good PDP"},
        }
    ]
    partial = await handler("POST", {"sources": ["https://good.test/pdp", "https://bad.test/pdp"]})
    assert partial.status == 207
    assert partial.payload["results"] == all_good.payload["results"]
    assert partial.payload["failures"] == [
        {
            "source": "https://bad.test/pdp",
            "sourceType": "url",
            "error": "upstream returned 403",
        }
    ]
    assert partial.payload["logs"][0]["source"] == "https://good.test/pdp"
    assert partial.payload["logs"][1]["source"] == "https://bad.test/pdp"
    assert partial.payload["logs"][1]["process"][1]["status"] == "error"
    failure_log = partial.payload["logs"][1]
    assert failure_log["ragProfile"] == "pdp-extractor-default"
    assert all(
        step.get("startedAt") and step.get("completedAt")
        for step in failure_log["process"][:2]
    )
    assert all("startedAt" not in step and "completedAt" not in step for step in failure_log["process"][2:])
    all_failed = await handler("POST", {"sources": ["https://bad.test/pdp"]})
    assert all_failed.status == 207 and all_failed.payload["results"] == [] and len(all_failed.payload["failures"]) == 1


@pytest.mark.asyncio
async def test_framework_neutral_handler_covers_400_405_500_and_runtime_config_precedence() -> None:
    calls: list[dict[str, object]] = []

    async def scripted_extract(source: str, source_type: str, **options: object) -> dict[str, object]:
        calls.append({"source": source, "sourceType": source_type, **options})
        return {
            "source": source,
            "sourceType": source_type,
            "geoProduct": {"name": "API Cream"},
            "diagnostics": {"source": source, "sourceType": source_type, "process": []},
        }

    handler = create_product_extractor_rest_handler(
        {
            "defaultSourceType": "restApi",
            "provider": "config",
            "analysisPrompt": "config prompt",
            "ragDocuments": [{"name": "config.md", "content": "config"}],
            "productNormalization": {"enabled": True, "model": "config-model"},
        },
        extract_one=scripted_extract,
    )
    assert (await handler("GET", {})).status == 405
    invalid = await handler("POST", {"sources": [""]})
    assert invalid.status == 400 and invalid.payload == {"error": "At least one source is required."}
    malformed = await handler("POST", "not-json")
    assert malformed.status == 500 and malformed.payload["error"]
    success = await handler(
        "POST",
        {
            "sources": ["https://example.test/products"],
            "llm": {"provider": "gemini", "productNormalization": {"model": "llm-model"}},
            "productNormalization": {"enabled": False},
            "rag": {"analysisPrompt": "request prompt", "documents": [{"name": "request.md", "content": "request"}]},
        },
    )
    assert success.status == 200 and calls == [
        {
            "source": "https://example.test/products",
            "sourceType": "restApi",
            "defaultSourceType": "restApi",
            "provider": "gemini",
            "analysisPrompt": "request prompt",
            "ragDocuments": [{"name": "request.md", "content": "request"}],
            "productNormalization": {"enabled": False, "model": "llm-model"},
        }
    ]


@pytest.mark.asyncio
async def test_rest_handler_rejects_untrusted_extractor_endpoints_before_calling_runner() -> None:
    calls: list[dict[str, object]] = []

    async def scripted_extract(source: str, source_type: str, **options: object) -> dict[str, object]:
        calls.append({"source": source, "sourceType": source_type, **options})
        return {"source": source, "sourceType": source_type, "geoProduct": {"name": "unexpected"}}

    handler = create_product_extractor_rest_handler(
        {
            "provider": "azure-openai",
            "apiKey": "server-managed-key",
            "endpoint": "https://configured.example.com",
            "productNormalization": {"enabled": True},
        },
        extract_one=scripted_extract,
    )
    untrusted_requests = [
        {"sources": ["https://example.com"], "llm": {"endpoint": "https://attacker.example"}},
        {
            "sources": ["https://example.com"],
            "llm": {"productNormalization": {"endpoint": "https://attacker.example"}},
        },
    ]

    for body in untrusted_requests:
        response = await handler("POST", body)
        assert response.status == 400
        assert "server-managed API key" in response.payload["error"]

    assert calls == []


@pytest.mark.asyncio
async def test_rest_handler_allows_configured_and_caller_owned_extractor_endpoints() -> None:
    calls: list[dict[str, object]] = []

    async def scripted_extract(source: str, source_type: str, **options: object) -> dict[str, object]:
        calls.append({"source": source, "sourceType": source_type, **options})
        return {"source": source, "sourceType": source_type, "geoProduct": {"name": "Serum"}}

    handler = create_product_extractor_rest_handler(
        {
            "provider": "azure-openai",
            "apiKey": "server-managed-key",
            "endpoint": "https://configured.example.com",
            "productNormalization": {"enabled": True},
        },
        extract_one=scripted_extract,
    )
    allowed_requests = [
        {
            "sources": ["https://example.com"],
            "llm": {"endpoint": "https://configured.example.com/"},
        },
        {
            "sources": ["https://example.com"],
            "llm": {"productNormalization": {"endpoint": "https://configured.example.com/"}},
        },
        {
            "sources": ["https://example.com"],
            "llm": {"apiKey": "caller-key", "endpoint": "https://attacker.example"},
        },
        {
            "sources": ["https://example.com"],
            "llm": {"productNormalization": {"apiKey": "caller-key", "endpoint": "https://attacker.example"}},
        },
    ]

    for body in allowed_requests:
        response = await handler("POST", body)
        assert response.status == 200

    assert len(calls) == len(allowed_requests)


@pytest.mark.asyncio
async def test_default_rest_route_forwards_headers_into_the_real_extraction_input() -> None:
    observed: dict[str, str] = {}

    async def fetcher(_: str, headers: dict[str, str]) -> tuple[int, str, str]:
        observed.update(headers)
        return 200, "text/html", "<h1>Header Cream</h1>"

    handler = create_product_extractor_rest_handler({"fetcher": fetcher})
    response = await handler(
        "POST",
        {
            "sources": ["https://example.test/products/header-cream"],
            "headers": {"Authorization": "Bearer customer-token", "Accept": "application/json"},
        },
    )

    assert response.status == 200
    assert observed["Authorization"] == "Bearer customer-token"
    assert "text/html" in observed["Accept"]


@pytest.mark.asyncio
async def test_empty_source_type_is_not_truthy_coerced_and_becomes_a_per_source_failure() -> None:
    observed: list[str] = []

    async def extract_one(source: str, source_type: str, **_: object) -> dict[str, object]:
        observed.append(source_type)
        if source_type == "":
            raise ValueError("invalid sourceType")
        return {"source": source, "sourceType": source_type, "geoProduct": {"name": "wrong branch"}}

    response = await create_product_extractor_rest_handler(extract_one=extract_one)(
        "POST", {"sources": ["https://example.test/products/empty-type"], "sourceType": ""}
    )

    assert observed == [""]
    assert response.status == 207
    assert response.payload["results"] == []
    assert response.payload["failures"] == [
        {
            "source": "https://example.test/products/empty-type",
            "sourceType": "",
            "error": "invalid sourceType",
        }
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("config", "body"),
    [({"provider": ""}, {"sources": ["https://example.test/products/empty-provider"]}),
     ({}, {"sources": ["https://example.test/products/empty-provider"], "llm": {"provider": ""}})],
)
async def test_explicit_empty_provider_is_not_defaulted_to_mock(
    config: dict[str, object], body: dict[str, object]
) -> None:
    """Only absent/None provider defaults to mock; an empty value reaches schema validation."""

    async def fetcher(_: str, _headers: dict[str, str]) -> tuple[int, str, str]:
        return 200, "text/html", "<main><h1>Should not fetch</h1></main>"

    response = await create_product_extractor_rest_handler({**config, "fetcher": fetcher})("POST", body)

    assert response.status == 207
    assert response.payload["results"] == []
    assert response.payload["failures"][0]["sourceType"] == "url"


@pytest.mark.asyncio
async def test_truthy_non_string_source_reaches_per_source_schema_failure() -> None:
    """The TS ``filter(Boolean)`` keeps malformed truthy batch entries for 207 reporting."""

    response = await create_product_extractor_rest_handler()("POST", {"sources": [42]})

    assert response.status == 207
    assert response.payload["results"] == []
    assert response.payload["failures"][0]["source"] == 42
    assert response.payload["failures"][0]["sourceType"] == "url"


@pytest.mark.asyncio
async def test_js_truthy_object_and_array_sources_become_per_source_207_failures() -> None:
    """JSON objects and arrays are truthy in the retained ``filter(Boolean)`` route."""

    async def extract_one(source: object, _source_type: str, **_: object) -> dict[str, object]:
        raise ValueError(f"unsupported source {type(source).__name__}")

    sources: list[object] = [dict[str, object](), list[object]()]
    response = await create_product_extractor_rest_handler(extract_one=extract_one)(
        "POST", {"sources": sources}
    )

    assert response.status == 207
    assert response.payload["results"] == []
    assert [failure["source"] for failure in response.payload["failures"]] == [{}, []]


@pytest.mark.asyncio
async def test_rest_rag_nulls_preserve_configured_prompt_documents_and_retrieval() -> None:
    """Route RAG values use JS nullish fallback rather than Python falsey replacement."""

    calls: list[dict[str, object]] = []

    async def extract_one(source: str, source_type: str, **options: object) -> dict[str, object]:
        calls.append({"source": source, "sourceType": source_type, **options})
        return {"source": source, "sourceType": source_type, "geoProduct": {"name": "Barrier Serum"}}

    response = await create_product_extractor_rest_handler(
        {
            "analysisPrompt": "configured policy",
            "ragDocuments": [{"name": "configured.md", "content": "configured document"}],
            "rag": {"maxResults": 4},
        },
        extract_one=extract_one,
    )(
        "POST",
        {
            "sources": ["https://example.test/products/barrier"],
            "rag": {"analysisPrompt": None, "documents": None, "retrieval": None},
        },
    )

    assert response.status == 200
    assert calls[0]["analysisPrompt"] == "configured policy"
    assert calls[0]["ragDocuments"] == [{"name": "configured.md", "content": "configured document"}]
    assert calls[0]["rag"] == {"maxResults": 4}


@pytest.mark.asyncio
async def test_rest_success_recursively_omits_absent_nested_wire_values() -> None:
    async def extract_one(source: str, source_type: str, **_: object) -> dict[str, object]:
        return {
            "source": source,
            "sourceType": source_type,
            "geoProduct": {
                "name": "Sparse Cream",
                "description": None,
                "customerReviewAnalysis": {"ratingSummary": None, "reviewSignals": []},
            },
            "diagnostics": {"source": source, "ocr": {"provider": None}},
        }

    response = await create_product_extractor_rest_handler(extract_one=extract_one)(
        "POST", {"sources": ["https://example.test/products/sparse"]}
    )

    assert response.status == 200
    assert response.payload["results"] == [
        {
            "source": "https://example.test/products/sparse",
            "sourceType": "url",
            "geoProduct": {"name": "Sparse Cream", "customerReviewAnalysis": {"reviewSignals": []}},
        }
    ]
    assert response.payload["logs"] == [
        {"source": "https://example.test/products/sparse", "ocr": {}}
    ]


@pytest.mark.asyncio
async def test_rest_source_failure_with_utf16_boundary_is_utf8_serializable() -> None:
    """A JS-style prefix may split an emoji, but Python's JSON wire must not."""

    async def fetcher(_: str, _headers: dict[str, str]) -> tuple[int, str, str]:
        return 502, "text/plain", ("x" * 179) + "😀 trailing upstream body"

    response = await create_product_extractor_rest_handler({"fetcher": fetcher})(
        "POST", {"sources": ["https://example.test/products/broken"]}
    )

    assert response.status == 207
    assert response.payload["failures"][0]["error"].startswith("Failed to fetch https://example.test/products/broken: 502 - ")
    json.dumps(response.payload, ensure_ascii=False).encode("utf-8")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("headers", "expected_message"),
    [
        ({"Authorization": 42}, "Invalid input: expected string, received number"),
        ([], "Invalid input: expected record, received array"),
        (None, "Invalid input: expected record, received null"),
    ],
)
async def test_invalid_rest_headers_are_source_local_207_failures_before_fetch(
    headers: object, expected_message: str
) -> None:
    """Mirror Zod header validation: malformed values never reach a source fetch."""

    fetches = 0

    async def fetcher(_: str, _headers: dict[str, str]) -> tuple[int, str, str]:
        nonlocal fetches
        fetches += 1
        return 200, "text/html", "<h1>Should not fetch</h1>"

    response = await create_product_extractor_rest_handler({"fetcher": fetcher})(
        "POST",
        {"sources": ["https://example.test/products/invalid-headers"], "headers": headers},
    )

    assert response.status == 207 and response.payload["results"] == [] and fetches == 0
    failure = response.payload["failures"]
    assert failure[0]["source"] == "https://example.test/products/invalid-headers"
    assert failure[0]["sourceType"] == "url"
    assert expected_message in failure[0]["error"]
