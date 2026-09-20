"""Console REST adapters and retained extractor-to-generator orchestration.

This module is deliberately close to the two Next route handlers.  The
console is a user-facing compatibility surface, so source ordering, per-item
failure isolation, profile injection, and NDJSON progress events are part of
the public contract rather than implementation details.
"""

from __future__ import annotations

import inspect
import re
from collections.abc import Awaitable, Callable, Mapping
from typing import Any
from urllib.parse import urlsplit

from pdp_extractor_agent import create_product_extractor_rest_handler, extract_product
from pdp_geo_eval_agent import (
    build_generated_source_text,
    build_image_attributable_sections,
    build_vanilla_source_text,
    run_citation_probe,
)
from pdp_geo_generator_agent import create_pdp_geo_generator_rest_handler, generate_pdp_geo

from neo_agent_api._json import as_dict, as_list, omit_none

ProgressEmitter = Callable[[dict[str, Any]], Awaitable[None] | None]
_SENSITIVE_FAILURE_MESSAGE = re.compile(
    r"\b(?:api[_ -]?key|authorization|bearer|(?:access|refresh)[_ -]?token|secret|password|credential)\b",
    re.IGNORECASE,
)
_CREDENTIAL_URL = re.compile(r"[a-z][a-z0-9+.-]*://[^\s/@:]+:[^\s/@]+@", re.IGNORECASE)


class RequestConfigurationError(ValueError):
    """A request tried to use a server-managed key with another endpoint."""


def js_truthy(value: object) -> bool:
    if value is None or value is False:
        return False
    if isinstance(value, str):
        return value != ""
    if isinstance(value, int | float) and not isinstance(value, bool):
        return value != 0 and value == value
    return True


def _string(value: object) -> str | None:
    return value if isinstance(value, str) else None


def _nullish(value: object, fallback: object) -> object:
    return fallback if value is None else value


def _runtime_without_private_defaults(base: Mapping[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in as_dict(base).items() if key != "_providerDefaults"}


def _agent_runtime_options(base: Mapping[str, Any]) -> dict[str, Any]:
    """Return only options understood by the extractor/generator packages.

    ``rag`` and ``citationProbeEnabled`` are orchestration concerns.  The
    browser route passes RAG as part of each generation input and consumes the
    citation toggle itself; exposing either as an agent option changes the
    package's public input surface.
    """

    return {
        key: value
        for key, value in _runtime_without_private_defaults(base).items()
        if key not in {"rag", "citationProbeEnabled"}
    }


def _provider_defaults(base: Mapping[str, Any], provider: object) -> dict[str, Any]:
    root = as_dict(base)
    all_defaults = as_dict(root.get("_providerDefaults"))
    selected = as_dict(all_defaults.get(provider)) if isinstance(provider, str) else {}
    if selected:
        return selected
    configured_provider = root.get("provider")
    return _runtime_without_private_defaults(root) if provider == configured_provider else {"provider": provider}


def _provider_name(value: object, fallback: object = "mock") -> object:
    """Apply JavaScript ``??`` without a Python string-coercion shortcut."""

    return _nullish(value, fallback)


def _stage_settings(
    body: Mapping[str, Any],
    llm: Mapping[str, Any],
    base: Mapping[str, Any],
    runtime: Mapping[str, Any],
    key: str,
    *,
    final_proofreading: bool = False,
) -> dict[str, Any]:
    """Port the Next ``resolve*`` helpers with top-level precedence."""

    nested = as_dict(llm.get(key))
    top_level = as_dict(body.get(key))
    merged = {**nested, **top_level}
    provider = _provider_name(merged.get("provider"), runtime.get("provider"))
    provider_defaults = _provider_defaults(base, provider)
    api_key = _nullish(
        merged.get("apiKey"),
        runtime.get("apiKey") if provider == runtime.get("provider") else provider_defaults.get("apiKey"),
    )
    explicit_enabled = _nullish(top_level.get("enabled"), nested.get("enabled"))
    enabled = _nullish(explicit_enabled, provider != "mock" and provider != "custom" and js_truthy(api_key))
    deployment_default: object = provider_defaults.get("deployment")
    if provider == "aistudio":
        deployment_default = _nullish(merged.get("model"), deployment_default)
    if final_proofreading and provider == "azure-openai":
        deployments = as_dict(llm.get("deployments"))
        deployment_default = _nullish(
            deployments.get("proofreading"),
            _nullish(as_dict(provider_defaults.get("deployments")).get("proofreading"), deployment_default),
        )
    model_default = provider_defaults.get("model")
    if final_proofreading and provider == "azure-openai":
        model_default = _nullish(deployment_default, model_default)
    return {
        **merged,
        "enabled": enabled,
        "provider": provider,
        "apiKey": api_key,
        "model": _nullish(merged.get("model"), model_default),
        "endpoint": _nullish(merged.get("endpoint"), provider_defaults.get("endpoint")),
        "deployment": _nullish(merged.get("deployment"), deployment_default),
        "apiVersion": _nullish(merged.get("apiVersion"), provider_defaults.get("apiVersion")),
        "timeoutSeconds": _nullish(merged.get("timeoutSeconds"), runtime.get("timeoutSeconds")),
    }


def runtime_config(body: Mapping[str, Any], base: Mapping[str, Any]) -> dict[str, Any]:
    """Resolve ``/generate`` runtime values exactly like the Next route.

    ``_providerDefaults`` is an app-private table populated from the same env
    surface. It lets a request select another configured provider without
    accidentally inheriting the active provider's credential.
    """

    assert_safe_request_endpoints(body, base)
    llm = as_dict(body.get("llm"))
    base_runtime = _runtime_without_private_defaults(base)
    provider = _provider_name(llm.get("provider"), base_runtime.get("provider"))
    defaults = _provider_defaults(base, provider)
    deployment_roles = as_dict(llm.get("deployments"))
    selected_deployments = llm.get("deployments")
    fallback_deployments = as_dict(defaults.get("deployments"))
    if selected_deployments is None:
        deployments: dict[str, Any]
        if provider == "aistudio" and js_truthy(llm.get("model")):
            deployments = {"reasoning": llm.get("model")}
        else:
            deployments = fallback_deployments
    else:
        deployments = deployment_roles
    deployment = _nullish(
        deployment_roles.get("reasoning"),
        _nullish(
            llm.get("deployment"),
            _nullish(llm.get("model"), defaults.get("deployment"))
            if provider == "aistudio"
            else defaults.get("deployment"),
        ),
    )
    runtime: dict[str, Any] = {
        "provider": provider,
        "apiKey": _nullish(llm.get("apiKey"), defaults.get("apiKey")),
        "model": _nullish(llm.get("model"), defaults.get("model")),
        "endpoint": _nullish(llm.get("endpoint"), defaults.get("endpoint")),
        "deployment": deployment,
        "deployments": deployments,
        "apiVersion": _nullish(llm.get("apiVersion"), defaults.get("apiVersion")),
        "temperature": _nullish(llm.get("temperature"), defaults.get("temperature")),
        "timeoutSeconds": _nullish(llm.get("timeoutSeconds"), defaults.get("timeoutSeconds")),
        "embedding": _nullish(llm.get("embedding"), defaults.get("embedding")),
        "reranker": _nullish(llm.get("reranker"), defaults.get("reranker")),
        # These are runtime-only defaults for the orchestration layer. They
        # must survive the request merge so managed RAG and env citation probes
        # observe the same settings as the retained Next route.
        "rag": base_runtime.get("rag"),
        "citationProbeEnabled": base_runtime.get("citationProbeEnabled", False),
    }
    if "qualityGate" in body:
        runtime["qualityGate"] = body.get("qualityGate")
    runtime["productNormalization"] = _stage_settings(body, llm, base, runtime, "productNormalization")
    runtime["contentPlanning"] = _stage_settings(body, llm, base, runtime, "contentPlanning")
    runtime["copyRefinement"] = _stage_settings(body, llm, base, runtime, "copyRefinement")
    runtime["finalProofreading"] = _stage_settings(
        body, llm, base, runtime, "finalProofreading", final_proofreading=True
    )
    # Private state is intentionally never sent to an agent package.
    return as_dict(omit_none(runtime))


def _endpoint_identity(value: object) -> str:
    raw = _string(value)
    if not raw:
        raise RequestConfigurationError(f"Invalid provider endpoint URL: {value}")
    parsed = urlsplit(raw)
    if (
        not parsed.scheme
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise RequestConfigurationError(f"Invalid provider endpoint URL: {raw}")
    pathname = parsed.path.rstrip("/") or "/"
    return f"{parsed.scheme.lower()}://{parsed.netloc.lower()}{pathname}"


def _assert_endpoint_credential_pair(
    *, label: str, provider: object, endpoint: object, request_api_key: object, base: Mapping[str, Any]
) -> None:
    configured = _provider_defaults(base, provider)
    _assert_endpoint_uses_server_credential(
        label=label,
        endpoint=endpoint,
        request_api_key=request_api_key,
        configured_endpoint=configured.get("endpoint"),
        server_api_key=configured.get("apiKey"),
    )


def _assert_endpoint_uses_server_credential(
    *,
    label: str,
    endpoint: object,
    request_api_key: object,
    configured_endpoint: object,
    server_api_key: object,
) -> None:
    if not js_truthy(endpoint) or js_truthy(request_api_key) or not js_truthy(server_api_key):
        return
    if configured_endpoint is not None and _endpoint_identity(configured_endpoint) == _endpoint_identity(endpoint):
        return
    raise RequestConfigurationError(
        f"{label} cannot override the configured provider endpoint while using a server-managed API key. "
        "Supply the matching request API key or use the configured endpoint."
    )


def assert_safe_request_endpoints(body: Mapping[str, Any], base: Mapping[str, Any]) -> None:
    """Mirror the direct console route's endpoint/key safety preflight."""

    llm = as_dict(body.get("llm"))
    provider = _provider_name(llm.get("provider"), as_dict(base).get("provider"))
    _assert_endpoint_credential_pair(
        label="llm.endpoint",
        provider=provider,
        endpoint=llm.get("endpoint"),
        request_api_key=llm.get("apiKey"),
        base=base,
    )
    for key in ("productNormalization", "contentPlanning", "copyRefinement", "finalProofreading"):
        requested = {**as_dict(llm.get(key)), **as_dict(body.get(key))}
        stage_provider = _provider_name(requested.get("provider"), provider)
        request_key = _nullish(requested.get("apiKey"), llm.get("apiKey") if stage_provider == provider else None)
        _assert_endpoint_credential_pair(
            label=f"{key}.endpoint",
            provider=stage_provider,
            endpoint=requested.get("endpoint"),
            request_api_key=request_key,
            base=base,
        )
    _assert_safe_managed_search_endpoint(body, base)


def _managed_rag_uses_openai(requested: Mapping[str, Any], configured: Mapping[str, Any]) -> bool:
    mode = _nullish(requested.get("mode"), configured.get("mode"))
    provider = _nullish(requested.get("provider"), configured.get("provider"))
    return mode == "managed-vector-store-rag" and _nullish(provider, "openai") == "openai"


def _configured_managed_search_endpoints(requested: Mapping[str, Any], configured: Mapping[str, Any]) -> list[object]:
    endpoints: list[object] = []
    configured_endpoint = configured.get("managedSearchEndpoint")
    if js_truthy(configured_endpoint):
        endpoints.append(configured_endpoint)
    vector_store = _nullish(requested.get("vectorStoreId"), configured.get("vectorStoreId"))
    if js_truthy(vector_store):
        endpoints.append(f"https://api.openai.com/v1/vector_stores/{vector_store}/search")
    return endpoints


def _assert_safe_managed_search_endpoint(body: Mapping[str, Any], base: Mapping[str, Any]) -> None:
    requested_rag = as_dict(body.get("rag"))
    endpoint = requested_rag.get("managedSearchEndpoint")
    configured_rag = as_dict(base.get("rag"))
    if not js_truthy(endpoint) or not _managed_rag_uses_openai(requested_rag, configured_rag):
        return
    llm = as_dict(body.get("llm"))
    provider = _provider_name(llm.get("provider"), as_dict(base).get("provider"))
    server_api_key = _provider_defaults(base, provider).get("apiKey")
    if js_truthy(llm.get("apiKey")) or not js_truthy(server_api_key):
        return
    trusted_endpoints = _configured_managed_search_endpoints(requested_rag, configured_rag)
    if any(_endpoint_identity(configured) == _endpoint_identity(endpoint) for configured in trusted_endpoints):
        return
    raise RequestConfigurationError(
        "rag.managedSearchEndpoint cannot override the configured/default managed RAG endpoint while using a "
        "server-managed API key. Supply the matching request API key or use the configured/default managed "
        "RAG endpoint."
    )


def assert_safe_extractor_request_endpoints(body: Mapping[str, Any], base: Mapping[str, Any]) -> None:
    """Protect the extractor's shallow request merge from retaining a server key."""

    llm = as_dict(body.get("llm"))
    _assert_endpoint_uses_server_credential(
        label="llm.endpoint",
        endpoint=llm.get("endpoint"),
        request_api_key=llm.get("apiKey"),
        configured_endpoint=base.get("endpoint"),
        server_api_key=base.get("apiKey"),
    )
    configured_stage = as_dict(base.get("productNormalization"))
    requested_stage = {**as_dict(llm.get("productNormalization")), **as_dict(body.get("productNormalization"))}
    stage_endpoint = requested_stage.get("endpoint")
    if stage_endpoint is None and configured_stage.get("endpoint") is None:
        stage_endpoint = llm.get("endpoint")
    stage_request_key = requested_stage.get("apiKey")
    if stage_request_key is None and configured_stage.get("apiKey") is None:
        stage_request_key = llm.get("apiKey")
    _assert_endpoint_uses_server_credential(
        label="productNormalization.endpoint",
        endpoint=stage_endpoint,
        request_api_key=stage_request_key,
        configured_endpoint=_nullish(configured_stage.get("endpoint"), base.get("endpoint")),
        server_api_key=_nullish(configured_stage.get("apiKey"), base.get("apiKey")),
    )


def _wire_rag_documents(raw_documents: object, *, include_version: bool) -> list[dict[str, Any]]:
    """Apply the browser route's document-to-wire mapping at the API boundary."""

    documents: list[dict[str, Any]] = []
    for raw_document in as_list(raw_documents):
        document = as_dict(raw_document)
        if not document:
            continue
        wire = {"name": document.get("name"), "content": document.get("content")}
        if include_version:
            wire["version"] = document.get("version")
        documents.append(wire)
    return documents


def _profile_options(profile: Mapping[str, Any] | None, *, include_version: bool) -> dict[str, Any]:
    record = as_dict(profile)
    documents = _wire_rag_documents(record.get("documents"), include_version=include_version)
    result: dict[str, Any] = {}
    if "analysisPrompt" in record:
        result["analysisPrompt"] = record.get("analysisPrompt")
    if "documents" in record:
        result["ragDocuments"] = documents
    return result


def _extractor_response_parts(response: object) -> tuple[int, dict[str, Any], dict[str, str]]:
    """Accept the extractor package's public response dataclass as-is."""

    if isinstance(response, Mapping):
        record = as_dict(response)
        return (
            int(record.get("status", 500)),
            as_dict(record.get("payload")),
            {key.lower(): str(value) for key, value in as_dict(record.get("headers")).items()},
        )
    return (
        int(getattr(response, "status", 500)),
        as_dict(getattr(response, "payload", {})),
        {key.lower(): str(value) for key, value in as_dict(getattr(response, "headers", {})).items()},
    )


async def extract_console(
    body: object,
    *,
    method: str,
    runtime: Mapping[str, Any],
    profile: Mapping[str, Any] | None = None,
) -> tuple[int, dict[str, Any], dict[str, str]]:
    assert_safe_extractor_request_endpoints(as_dict(body), runtime)
    handler = create_product_extractor_rest_handler(
        {**_runtime_without_private_defaults(runtime), **_profile_options(profile, include_version=False)}
    )
    return _extractor_response_parts(await handler(method, body))


async def generator_console(
    body: object,
    *,
    method: str,
    runtime: Mapping[str, Any],
    profile: Mapping[str, Any] | None = None,
) -> tuple[int, dict[str, Any], dict[str, str]]:
    handler = create_pdp_geo_generator_rest_handler(
        {**_runtime_without_private_defaults(runtime), **_profile_options(profile, include_version=True)}
    )
    response = as_dict(await handler({"method": method, "body": body}))
    return (
        int(response.get("status", 500)),
        as_dict(response.get("body")),
        {key.lower(): str(value) for key, value in as_dict(response.get("headers")).items()},
    )


async def _emit(emitter: ProgressEmitter | None, event: dict[str, Any]) -> None:
    if emitter is None:
        return
    outcome = emitter(event)
    if inspect.isawaitable(outcome):
        await outcome


def _request_date(product: object, date_modified: object) -> object:
    supplied = _string(date_modified)
    if not supplied or not supplied.strip():
        return product
    record = as_dict(product)
    if not record:
        return product
    existing = _string(record.get("dateModified"))
    if existing and existing.strip():
        return product
    return {**record, "dateModified": supplied.strip()}


def _with_runtime_rag_defaults(rag: object, runtime: Mapping[str, Any]) -> object:
    record = as_dict(rag)
    if record.get("mode") != "managed-vector-store-rag":
        return rag
    defaults = as_dict(runtime.get("rag"))
    return {**record, "vectorStoreId": _nullish(record.get("vectorStoreId"), defaults.get("vectorStoreId"))}


def _citation_engine(runtime: Mapping[str, Any]) -> dict[str, Any] | None:
    provider = _provider_name(runtime.get("provider"))
    api_key = runtime.get("apiKey")
    model = runtime.get("model")
    endpoint = runtime.get("endpoint")
    deployment = runtime.get("deployment")
    temperature = runtime.get("temperature")
    if not js_truthy(api_key):
        return None
    if provider in ("openai", "gemini") and js_truthy(model):
        return {"provider": provider, "apiKey": api_key, "model": model, "temperature": temperature}
    if provider in ("azure-openai", "aistudio") and js_truthy(endpoint) and js_truthy(deployment):
        return {
            "provider": provider,
            "apiKey": api_key,
            "endpoint": endpoint,
            "deployment": deployment,
            "apiVersion": runtime.get("apiVersion"),
            "temperature": temperature,
        }
    return None


def _json_ld_description(json_ld: object, schema_type: str) -> str | None:
    root = as_dict(json_ld)
    if not root:
        return None
    graph = root.get("@graph")
    nodes = as_list(graph) if isinstance(graph, list) else [root]
    for raw_node in nodes:
        node = as_dict(raw_node)
        raw_type = node.get("@type")
        node_types = as_list(raw_type) if isinstance(raw_type, list) else [raw_type]
        if schema_type not in node_types:
            continue
        description = _string(node.get("description"))
        if description and description.strip():
            return description.strip()
    return None


def _attributable_sections(sections: Mapping[str, Any], json_ld: object) -> list[dict[str, str]]:
    product_description = _json_ld_description(json_ld, "Product")
    webpage_description = _json_ld_description(json_ld, "WebPage")
    result: list[dict[str, str]] = []
    for identifier, raw_text in sections.items():
        text = _string(raw_text)
        if not text or not text.strip():
            continue
        if identifier == "description" and (product_description or webpage_description):
            if product_description:
                result.append({"id": "productDescription", "text": product_description})
            if webpage_description and webpage_description != product_description:
                result.append({"id": "webPageDescription", "text": webpage_description})
            continue
        result.append({"id": identifier, "text": text})
    return result


async def _execute_citation_probe(
    run: Mapping[str, Any], engine: Mapping[str, Any], settings: Mapping[str, Any]
) -> tuple[dict[str, Any] | None, str | None]:
    try:
        result = as_dict(run.get("result"))
        diagnostics = as_dict(run.get("diagnostics"))
        normalized = as_dict(diagnostics.get("normalizedProduct"))
        sections = as_dict(as_dict(result.get("content")).get("sections"))
        probe = await run_citation_probe(
            {
                "generatedText": build_generated_source_text(sections),
                "vanillaText": build_vanilla_source_text(normalized),
                "locale": result.get("locale"),
                "category": normalized.get("category"),
                "brand": normalized.get("brand"),
                "productName": normalized.get("name"),
                "benefits": normalized.get("benefits"),
                "contentPlan": diagnostics.get("contentPlan"),
                "evidenceLedger": diagnostics.get("evidenceLedger"),
                "generatedSections": _attributable_sections(
                    sections, as_dict(result.get("schemaMarkup")).get("jsonLd")
                ),
                "imageSections": build_image_attributable_sections(
                    as_list(diagnostics.get("finalPublicCopyProvenance"))
                ),
            },
            {
                "engine": dict(engine),
                "maxQueries": settings.get("maxQueries"),
                "includeUtility": _nullish(settings.get("includeUtility"), False),
            },
        )
        return as_dict(probe), None
    except Exception as exc:
        return None, str(exc) or "Citation probe failed."


def _generator_options(
    body: Mapping[str, Any],
    runtime: Mapping[str, Any],
    profile: Mapping[str, Any] | None,
    progress: Callable[[dict[str, Any]], Awaitable[None]],
) -> dict[str, Any]:
    options = _agent_runtime_options(runtime)
    options.update(_profile_options(profile, include_version=True))
    options["qualityGate"] = body.get("qualityGate")
    options["onProgress"] = progress
    return options


# Public narrow seam for the retained generator-console option DTO.
build_generator_options = _generator_options


def _extractor_options(
    body: Mapping[str, Any],
    runtime: Mapping[str, Any],
    profile: Mapping[str, Any] | None,
    progress: Callable[[dict[str, Any]], Awaitable[None]],
) -> dict[str, Any]:
    extractor_rag = as_dict(body.get("extractorRag"))
    fallback = _profile_options(profile, include_version=False)
    request_documents = extractor_rag.get("documents")
    options = _agent_runtime_options(runtime)
    options.update(
        {
            "analysisPrompt": _nullish(extractor_rag.get("analysisPrompt"), fallback.get("analysisPrompt")),
            "ragDocuments": (
                _wire_rag_documents(request_documents, include_version=False)
                if request_documents is not None
                else fallback.get("ragDocuments", [])
            ),
            "onProgress": progress,
        }
    )
    return options


# Public narrow seam for the retained extractor-console option DTO.
build_extractor_options = _extractor_options


def _failure_message(exc: Exception, fallback: str) -> str:
    """Keep dependency diagnostics, or identify a blank exception safely."""

    message = str(exc).strip()
    if not message or _SENSITIVE_FAILURE_MESSAGE.search(message) or _CREDENTIAL_URL.search(message):
        return f"{fallback} ({type(exc).__name__})."
    return message


def _safe_failure_process(value: object) -> list[dict[str, Any]]:
    """Keep execution state and allowlisted count metrics, never progress/source text."""

    allowed_statuses = {"pending", "running", "done", "error"}
    allowed_identifiers = {
        "input",
        "fetch",
        "extract",
        "ocr",
        "review",
        "rag",
        "json",
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
        "generator",
    }
    extractor_metric_by_step = {
        "ocr": "ocrImageCandidateCount",
        "review": "reviewItemCount",
        "rag": "ragChunkCount",
    }
    process: list[dict[str, Any]] = []
    process_index: dict[str, int] = {}
    for raw in as_list(value):
        step = as_dict(raw)
        identifier, status = step.get("id"), step.get("status")
        if (
            not isinstance(identifier, str)
            or identifier not in allowed_identifiers
            or not isinstance(status, str)
            or status not in allowed_statuses
        ):
            continue
        safe_step: dict[str, Any] = {"id": identifier, "status": status}
        if metric_name := extractor_metric_by_step.get(identifier):
            metric = as_dict(step.get("metrics")).get(metric_name)
            if isinstance(metric, int) and not isinstance(metric, bool) and metric >= 0:
                safe_step["metrics"] = {metric_name: metric}
        if identifier in process_index:
            process[process_index[identifier]] = safe_step
        else:
            process_index[identifier] = len(process)
            process.append(safe_step)
    return process


def _safe_shortfall_list(value: object) -> list[str]:
    """Bound gate labels while excluding arbitrary provider/generated payloads."""

    return list(dict.fromkeys(item[:240] for item in as_list(value) if isinstance(item, str) and item.strip()))


def _safe_score_map(value: object) -> dict[str, int | float]:
    values = as_dict(value)
    return {
        key: score
        for key in ("overall", "geo", "cep", "eeat")
        if isinstance(score := values.get(key), int | float) and not isinstance(score, bool)
    }


def _safe_public_copy_finding_reason(value: object) -> str:
    reason = str(value).casefold()
    if "missing" in reason:
        return "Final public-copy provenance binding is missing."
    if "ambiguous" in reason:
        return "Final public-copy provenance binding is ambiguous."
    if "does not correspond" in reason:
        return "Final public-copy provenance binding does not match a published field."
    if "hash" in reason or "evidence" in reason or "text does not match" in reason:
        return "Final public-copy provenance binding does not match finalized evidence."
    return "Final public-copy provenance did not validate."


def _safe_public_copy_findings(value: object) -> list[dict[str, str]]:
    findings: list[dict[str, str]] = []
    for raw in as_list(value):
        finding = as_dict(raw)
        field = finding.get("field")
        if finding.get("source") != "public-copy-provenance" or not isinstance(field, str) or not field:
            continue
        findings.append(
            {
                "field": field[:240],
                "source": "public-copy-provenance",
                "reason": _safe_public_copy_finding_reason(finding.get("reason") or finding.get("issue")),
            }
        )
    return findings


def _safe_provenance_summary(value: object) -> dict[str, Any]:
    data = as_dict(value)
    paths = list(
        dict.fromkeys(path[:240] for path in as_list(data.get("fieldPaths")) if isinstance(path, str) and path)
    )
    count = data.get("count")
    return {
        "count": count if isinstance(count, int) and not isinstance(count, bool) and count >= 0 else len(paths),
        "fieldPaths": paths,
    }


def _safe_public_copy_field_path(value: object) -> str | None:
    """Allow only renderer-generated public field paths, never arbitrary strings."""

    if not isinstance(value, str):
        return None
    if value in {"Product.description", "WebPage.description"}:
        return value
    if re.fullmatch(r"FAQPage\.mainEntity\[\d+\]\.(?:name|acceptedAnswer\.text)", value):
        return value
    if re.fullmatch(r"HowTo\.step\[\d+\]\.text", value):
        return value
    return None


def _safe_nonnegative_count(value: object) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


def _safe_corrective_diagnostics(value: object) -> dict[str, Any]:
    """Forward only count/path corrective metadata from a terminal generator error."""

    data = as_dict(value)
    reasons = {
        "notNeeded",
        "noCorrectiveRuntime",
        "correctiveNotApplied",
        "adopted",
        "provenanceRegression",
        "structuralShortfall",
        "notImproved",
    }
    corrected_missing_paths = list(
        dict.fromkeys(
            path
            for raw in as_list(data.get("correctedMissingPaths"))
            if (path := _safe_public_copy_field_path(raw)) is not None
        )
    )
    reason = data.get("adoptionReason")
    return {
        "correctiveApplied": data.get("correctiveApplied") is True,
        "correctedMissingPaths": corrected_missing_paths,
        "adoptionReason": reason if isinstance(reason, str) and reason in reasons else "notNeeded",
        "structuralShortfallCount": _safe_nonnegative_count(data.get("structuralShortfallCount")),
        "provenanceRegressionDelta": _safe_nonnegative_count(data.get("provenanceRegressionDelta")),
    }


def _safe_public_copy_provenance_decision_diagnostics(value: object) -> list[dict[str, Any]]:
    """Forward a fixed provenance-decision schema without copy, evidence, or source data."""

    phases = {"initial", "afterProofreader", "afterSafeRepair", "correctedCandidate"}
    outcomes = {"bound", "protected", "unsupported", "notPresent"}
    reasons = {
        "noEligibleEvidence",
        "assertionFrameRejected",
        "directSupportRejected",
        "planTextMismatch",
        "notPresent",
        "directSupportAccepted",
        "verbatimSource",
    }
    roles = {
        "identity",
        "description",
        "benefit",
        "effect",
        "ingredient",
        "audience",
        "usage",
        "metric",
        "faq",
        "review",
        "source",
        "commerce",
    }
    safe: list[dict[str, Any]] = []
    for raw in as_list(value):
        item = as_dict(raw)
        field_path = _safe_public_copy_field_path(item.get("fieldPath"))
        phase = item.get("phase")
        outcome = item.get("outcome")
        reason = item.get("reason")
        sentence_index = item.get("sentenceIndex")
        if (
            field_path is None
            or not isinstance(phase, str)
            or phase not in phases
            or not isinstance(outcome, str)
            or outcome not in outcomes
            or not isinstance(reason, str)
            or reason not in reasons
            or not (
                sentence_index is None
                or isinstance(sentence_index, int)
                and not isinstance(sentence_index, bool)
                and sentence_index >= 0
            )
        ):
            continue
        plan = as_dict(item.get("plan"))
        plan_mode = plan.get("mode")
        safe.append(
            {
                "fieldPath": field_path,
                "phase": phase,
                "sentenceIndex": sentence_index,
                "outcome": outcome,
                "reason": reason,
                "plan": {
                    "mode": (
                        plan_mode
                        if isinstance(plan_mode, str) and plan_mode in {"model", "nonModel"}
                        else "nonModel"
                    ),
                    "fieldIncluded": plan.get("fieldIncluded")
                    if isinstance(plan.get("fieldIncluded"), bool)
                    else None,
                    "textHashMatch": plan.get("textHashMatch")
                    if isinstance(plan.get("textHashMatch"), bool)
                    else None,
                },
                "eligibleEvidenceCount": _safe_nonnegative_count(item.get("eligibleEvidenceCount")),
                "eligibleRoleCounts": {
                    role: count
                    for role, count in as_dict(item.get("eligibleRoleCounts")).items()
                    if role in roles
                    if isinstance(count, int) and not isinstance(count, bool) and count >= 0
                },
                "selectedEvidenceCount": _safe_nonnegative_count(item.get("selectedEvidenceCount")),
            }
        )
    return safe


def _safe_runtime_stages(value: object) -> dict[str, Any]:
    stages = as_dict(value)
    result: dict[str, Any] = {}
    for key in (
        "productNormalization",
        "keywordNormalization",
        "contentPlanning",
        "copyRefinement",
        "finalProofreading",
    ):
        stage = as_dict(stages.get(key))
        if stage:
            result[key] = {"called": stage.get("called") is True, "applied": stage.get("applied") is True}
    rag = as_dict(stages.get("rag"))
    if rag:
        result["rag"] = {
            key: count
            for key in ("retrievedCount", "selectedRagCount")
            if isinstance(count := rag.get(key), int) and not isinstance(count, bool) and count >= 0
        }
    return result


def _safe_quality_gate_failure_diagnostics(exc: Exception) -> dict[str, Any] | None:
    """Copy only the structured, public failure carrier emitted by the generator."""

    raw = as_dict(getattr(exc, "diagnostics", None))
    if not raw:
        return None
    quality = as_dict(raw.get("qualityGate"))
    if not quality:
        return None
    scores: dict[str, dict[str, int | float]] = {}
    raw_scores = as_dict(quality.get("scores"))
    for key in ("initial", "corrected"):
        if score_map := _safe_score_map(raw_scores.get(key)):
            scores[key] = score_map
    output: dict[str, Any] = {
        "process": _safe_failure_process(raw.get("process")),
        "qualityGate": {
            "attempted": quality.get("attempted") is True,
            "adopted": quality.get("adopted") is True,
            "reason": str(quality.get("reason") or "Quality gate blocked final artifact.")[:240],
            "shortfalls": _safe_shortfall_list(quality.get("shortfalls")),
            "blockingShortfalls": _safe_shortfall_list(quality.get("blockingShortfalls")),
            "scores": scores,
        },
        "validationFindings": _safe_public_copy_findings(raw.get("validationFindings")),
        "finalPublicCopyProvenance": _safe_provenance_summary(raw.get("finalPublicCopyProvenance")),
        "runtimeStages": _safe_runtime_stages(raw.get("runtimeStages")),
    }
    if quality.get("enabled") is True:
        output["qualityGate"]["enabled"] = True
    if "correctiveDiagnostics" in quality:
        output["qualityGate"]["correctiveDiagnostics"] = _safe_corrective_diagnostics(
            quality.get("correctiveDiagnostics")
        )
    if "publicCopyProvenanceDecisionDiagnostics" in raw:
        output["publicCopyProvenanceDecisionDiagnostics"] = _safe_public_copy_provenance_decision_diagnostics(
            raw.get("publicCopyProvenanceDecisionDiagnostics")
        )
    return output


def _safe_extractor_runtime_stages(diagnostics: Mapping[str, Any]) -> list[dict[str, Any]]:
    runtime_usage = as_dict(diagnostics.get("runtimeUsage"))
    allowed_runtime_stages = {"fetch", "ocr", "final", "embedding", "retrieval", "reranking"}
    return [
        {"stage": stage, "called": item.get("called") is True}
        for raw in as_list(runtime_usage.get("steps"))
        if isinstance(stage := as_dict(raw).get("stage"), str) and stage in allowed_runtime_stages
        for item in (as_dict(raw),)
    ]


def _safe_extractor_diagnostic_count(diagnostics: Mapping[str, Any], *, count_key: str, entries_key: str) -> int:
    count = diagnostics.get(count_key)
    if isinstance(count, int) and not isinstance(count, bool) and count >= 0:
        return count
    return len(as_list(diagnostics.get(entries_key)))


def _safe_extractor_diagnostics(process: object, diagnostics: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "process": _safe_failure_process(process),
        "diagnostics": {
            "warningCount": _safe_extractor_diagnostic_count(
                diagnostics, count_key="warningCount", entries_key="warnings"
            ),
            "evidenceCount": _safe_extractor_diagnostic_count(
                diagnostics, count_key="evidenceCount", entries_key="evidence"
            ),
            "runtimeStages": _safe_extractor_runtime_stages(diagnostics),
        },
    }


def _safe_extractor_failure_diagnostics(extracted: object) -> dict[str, Any]:
    """Attach the completed extractor's execution summary without raw extraction data."""

    diagnostics = as_dict(getattr(extracted, "diagnostics", None))
    return _safe_extractor_diagnostics(diagnostics.get("process"), diagnostics)


def _terminal_extractor_failure_process(value: object) -> list[dict[str, Any]]:
    """Mark an observed in-flight extractor step as failed, like the REST adapter."""

    process = _safe_failure_process(value)
    if any(step["status"] == "error" for step in process):
        return process
    for index in range(len(process) - 1, -1, -1):
        if process[index]["status"] == "running":
            process[index] = {**process[index], "status": "error"}
            return process
    return process


def _safe_observed_extractor_failure_diagnostics(
    exc: Exception, *, observed_extractor_process: object
) -> dict[str, Any] | None:
    """Keep safe extractor progress when a source fails before it returns a run."""

    diagnostics = as_dict(getattr(exc, "diagnostics", None))
    process = _terminal_extractor_failure_process(diagnostics.get("process"))
    if not process:
        process = _terminal_extractor_failure_process(observed_extractor_process)
    if not process and not diagnostics:
        return None
    extractor = _safe_extractor_diagnostics(process, diagnostics)
    return {"process": process, "runtimeStages": {}, "extractor": extractor}


def _safe_generator_failure_diagnostics(
    exc: Exception, *, observed_generator_process: object, fallback_to_generator_error: bool
) -> dict[str, Any] | None:
    """Expose only observed or allowlisted generator state from a failed run."""

    raw = as_dict(getattr(exc, "diagnostics", None))
    process = _safe_failure_process(raw.get("process")) or _safe_failure_process(observed_generator_process)
    if not process:
        if not raw and not fallback_to_generator_error:
            return None
        process = [{"id": "generator", "status": "error"}]
    elif not any(step["status"] == "error" for step in process):
        process.append({"id": "generator", "status": "error"})
    return {
        "process": process,
        "runtimeStages": _safe_runtime_stages(raw.get("runtimeStages")),
    }


def _safe_runtime_failure_diagnostics(
    exc: Exception, extracted: object, *, observed_generator_process: object
) -> dict[str, Any]:
    """Attach a completed extractor summary when generation fails after extraction."""

    generator = _safe_generator_failure_diagnostics(
        exc, observed_generator_process=observed_generator_process, fallback_to_generator_error=True
    )
    assert generator is not None
    return {
        **generator,
        "extractor": _safe_extractor_failure_diagnostics(extracted),
    }


async def run_generate(
    body: Mapping[str, Any],
    *,
    runtime: Mapping[str, Any],
    progress: ProgressEmitter | None = None,
    extractor_profile: Mapping[str, Any] | None = None,
    generator_profile: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    direct_products = (
        as_list(body.get("products"))
        if isinstance(body.get("products"), list)
        else [body["product"]]
        if "product" in body
        else []
    )
    sources = (
        [source for source in as_list(body.get("sources")) if js_truthy(source)]
        if isinstance(body.get("sources"), list)
        else []
    )
    source_count = max(len(direct_products) + len(sources), 1)
    results: list[dict[str, Any]] = []
    logs: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    source_type = _nullish(body.get("sourceType"), "url")
    citation_settings = as_dict(body.get("citationProbe"))
    citation_requested = _nullish(citation_settings.get("enabled"), runtime.get("citationProbeEnabled", False))
    citation_enabled = js_truthy(citation_requested)
    citation_engine = _citation_engine(runtime) if citation_enabled else None
    citation_config_error = (
        "Citation probe skipped: it requires a non-mock provider with credentials "
        "(and endpoint/deployment for Azure/AI Studio)."
        if citation_enabled and citation_engine is None
        else None
    )

    for index, product in enumerate(direct_products):
        source = f"manual-json-{index + 1}"
        generator_progress_steps: list[dict[str, Any]] = []

        async def generator_progress(
            step: dict[str, Any], *, item_index: int = index, item_source: str = source
        ) -> None:
            generator_progress_steps.append(dict(step))
            await _emit(
                progress,
                {
                    "type": "progress",
                    "group": "generator",
                    "source": item_source,
                    "sourceType": "manual-json",
                    "sourceIndex": item_index,
                    "sourceCount": source_count,
                    "step": step,
                },
            )

        try:
            run = as_dict(
                await generate_pdp_geo(
                    {
                        "product": _request_date(product, body.get("dateModified")),
                        "source": {"type": "manual-json"},
                        "hints": body.get("hints"),
                        "fieldMapping": body.get("fieldMapping"),
                        "rag": _with_runtime_rag_defaults(body.get("rag"), runtime),
                    },
                    _generator_options(body, runtime, generator_profile, generator_progress),
                )
            )
            generated = as_dict(run.get("result"))
            probe, probe_error = (
                await _execute_citation_probe(run, citation_engine, citation_settings)
                if citation_engine is not None
                else (None, citation_config_error)
            )
            results.append(
                as_dict(
                    omit_none(
                        {
                            "id": f"{source}-{generated.get('generatedAt')}",
                            "source": source,
                            "sourceType": "manual-json",
                            "generator": generated,
                            "citationProbe": probe,
                            "citationProbeError": probe_error,
                        }
                    )
                )
            )
            logs.append(
                {
                    "source": source,
                    "generator": run.get("diagnostics"),
                    "generatorProcess": run.get("process"),
                }
            )
        except Exception as exc:
            failure: dict[str, Any] = {
                "source": source,
                "sourceType": "manual-json",
                "error": _failure_message(exc, "GEO generation failed"),
            }
            if diagnostics := _safe_quality_gate_failure_diagnostics(exc):
                failure["diagnostics"] = diagnostics
            elif diagnostics := _safe_generator_failure_diagnostics(
                exc, observed_generator_process=generator_progress_steps, fallback_to_generator_error=False
            ):
                failure["diagnostics"] = diagnostics
            failures.append(failure)

    for source_offset, source in enumerate(sources):
        source_index = len(direct_products) + source_offset
        extractor_progress_steps: list[dict[str, Any]] = []
        generator_progress_steps: list[dict[str, Any]] = []

        async def extractor_progress(
            step: dict[str, Any], *, item_source: object = source, item_index: int = source_index
        ) -> None:
            extractor_progress_steps.append(dict(step))
            await _emit(
                progress,
                {
                    "type": "progress",
                    "group": "extractor",
                    "source": item_source,
                    "sourceType": source_type,
                    "sourceIndex": item_index,
                    "sourceCount": source_count,
                    "step": step,
                },
            )

        async def source_generator_progress(
            step: dict[str, Any], *, item_source: object = source, item_index: int = source_index
        ) -> None:
            generator_progress_steps.append(dict(step))
            await _emit(
                progress,
                {
                    "type": "progress",
                    "group": "generator",
                    "source": item_source,
                    "sourceType": source_type,
                    "sourceIndex": item_index,
                    "sourceCount": source_count,
                    "step": step,
                },
            )

        extracted: object | None = None
        try:
            extracted = await extract_product(
                {
                    "source": source,
                    "sourceType": source_type,
                    "headers": body.get("headers"),
                    "aiProvider": runtime.get("provider"),
                },
                _extractor_options(body, runtime, extractor_profile, extractor_progress),
            )
            extracted_result = as_dict(extracted.result)
            run = as_dict(
                await generate_pdp_geo(
                    {
                        "product": _request_date(extracted_result.get("geoProduct"), body.get("dateModified")),
                        "source": {"type": "pdp-extractor", "url": source},
                        "hints": body.get("hints"),
                        "fieldMapping": body.get("fieldMapping"),
                        "rag": _with_runtime_rag_defaults(body.get("rag"), runtime),
                    },
                    _generator_options(body, runtime, generator_profile, source_generator_progress),
                )
            )
            generated = as_dict(run.get("result"))
            probe, probe_error = (
                await _execute_citation_probe(run, citation_engine, citation_settings)
                if citation_engine is not None
                else (None, citation_config_error)
            )
            results.append(
                as_dict(
                    omit_none(
                        {
                            "id": f"{source}-{generated.get('generatedAt')}",
                            "source": source,
                            "sourceType": source_type,
                            "extractor": extracted_result,
                            "generator": generated,
                            "citationProbe": probe,
                            "citationProbeError": probe_error,
                        }
                    )
                )
            )
            logs.append(
                {
                    "source": source,
                    "extractor": extracted.diagnostics,
                    "generator": run.get("diagnostics"),
                    "generatorProcess": run.get("process"),
                }
            )
        except Exception as exc:
            failure = {
                "source": source,
                "sourceType": source_type,
                "error": _failure_message(exc, "PDP GEO orchestration failed"),
            }
            diagnostics = _safe_quality_gate_failure_diagnostics(exc)
            if diagnostics is not None:
                if extracted is not None:
                    diagnostics["extractor"] = _safe_extractor_failure_diagnostics(extracted)
                elif observed_extractor := _safe_observed_extractor_failure_diagnostics(
                    exc, observed_extractor_process=extractor_progress_steps
                ):
                    diagnostics["extractor"] = observed_extractor["extractor"]
                failure["diagnostics"] = diagnostics
            elif extracted is not None:
                failure["diagnostics"] = _safe_runtime_failure_diagnostics(
                    exc, extracted, observed_generator_process=generator_progress_steps
                )
            elif observed_extractor := _safe_observed_extractor_failure_diagnostics(
                exc, observed_extractor_process=extractor_progress_steps
            ):
                failure["diagnostics"] = observed_extractor
            failures.append(failure)
    return {"results": results, "logs": logs, "failures": failures}
