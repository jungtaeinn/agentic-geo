"""Manual, opt-in PDP quality smoke command with deliberately narrow output.

The command has no network/client code of its own.  Its only execution seam is
the existing console orchestration, and that seam is unreachable unless the
operator sets ``RUN_LIVE_PDP_EVAL=1`` in the process environment.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sys
from collections.abc import Mapping, Sequence
from typing import Any, TextIO
from urllib.parse import urlsplit, urlunsplit

from neo_agent_api._json import as_dict, as_list
from neo_agent_api.services.console_orchestration import run_generate, runtime_config

LIVE_CASES: dict[str, dict[str, str]] = {
    "en-US": {
        "locale": "en-US",
        "market": "US",
        "url": "https://catalog.example/products/evidence-serum",
    },
    "ko-KR": {
        "locale": "ko-KR",
        "market": "KR",
        "url": "https://catalog.example/kr/products/evidence-toner",
    },
}

_REQUIRED_RUNTIME_KEYS = (
    "AISTUDIO_API_KEY",
    "AISTUDIO_ENDPOINT",
    "AISTUDIO_MODEL",
    "AISTUDIO_API_VERSION",
)
_SENSITIVE_KEY = re.compile(r"(?:api[_-]?key|authorization|credential|password|secret|token)", re.IGNORECASE)


def _nonempty_string(value: object) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _safe_url_identity(value: str) -> str:
    """Retain only a URL's scheme, host, optional port, and path.

    This is intentionally suitable for console output: it never includes
    credentials, query strings, or fragments.  It also avoids propagating a
    malformed URL value into an error message.
    """

    try:
        parsed = urlsplit(value)
        host = parsed.hostname
        port = parsed.port
    except ValueError:
        return "[redacted-url]"
    if not parsed.scheme or not host:
        return "[redacted-url]"
    rendered_host = f"[{host}]" if ":" in host and not host.startswith("[") else host
    netloc = f"{rendered_host}:{port}" if port is not None else rendered_host
    return urlunsplit((parsed.scheme.lower(), netloc, parsed.path or "/", "", ""))


def _valid_provider_endpoint(value: str) -> bool:
    """Accept only the endpoint shape used by the retained console runtime."""

    try:
        parsed = urlsplit(value)
        _ = parsed.port
    except ValueError:
        return False
    return bool(
        parsed.scheme
        and parsed.hostname
        and parsed.username is None
        and parsed.password is None
        and not parsed.query
        and not parsed.fragment
    )


def build_live_config(environment: Mapping[str, str]) -> dict[str, object] | None:
    """Build the minimum AI Studio runtime only from an execution environment.

    Missing or malformed values deliberately collapse to ``None``.  The CLI
    reports that state generically, without revealing which value was supplied
    or what it contained.
    """

    values = {key: _nonempty_string(environment.get(key)) for key in _REQUIRED_RUNTIME_KEYS}
    if any(value is None for value in values.values()):
        return None
    api_key = values["AISTUDIO_API_KEY"]
    endpoint = values["AISTUDIO_ENDPOINT"]
    model = values["AISTUDIO_MODEL"]
    api_version = values["AISTUDIO_API_VERSION"]
    if (
        api_key is None
        or endpoint is None
        or model is None
        or api_version is None
        or not _valid_provider_endpoint(endpoint)
    ):
        return None
    return {
        "provider": "aistudio",
        "apiKey": api_key,
        "endpoint": endpoint,
        "model": model,
        "deployment": model,
        "deployments": {"reasoning": model},
        "apiVersion": api_version,
    }


def redact_runtime_config(value: object) -> object:
    """Return a diagnostic-safe structural view without secrets or URL query data."""

    if isinstance(value, Mapping):
        redacted: dict[str, object] = {}
        for key, item in as_dict(value).items():
            if key.casefold() == "headers" or _SENSITIVE_KEY.search(key):
                redacted[key] = "[redacted]"
            elif isinstance(item, str) and "://" in item:
                redacted[key] = _safe_url_identity(item)
            else:
                redacted[key] = redact_runtime_config(item)
        return redacted
    if isinstance(value, Sequence) and not isinstance(value, str | bytes | bytearray):
        return [redact_runtime_config(item) for item in as_list(value)]
    return value


def _live_runtime(config: Mapping[str, object]) -> dict[str, Any]:
    """Resolve the existing console DTO rather than creating another pipeline."""

    provider_defaults = dict(config)
    base_runtime: dict[str, Any] = {
        **provider_defaults,
        "citationProbeEnabled": False,
        "_providerDefaults": {"aistudio": provider_defaults},
    }
    return runtime_config(
        {
            "llm": {"provider": "aistudio"},
            # The smoke command must not add the optional corrective model run.
            "qualityGate": {"enabled": False},
        },
        base_runtime,
    )


def _case_request(case: Mapping[str, str]) -> dict[str, object]:
    return {
        "sources": [case["url"]],
        "sourceType": "url",
        "hints": {"locale": case["locale"], "market": case["market"]},
        # Never run the optional citation/provider probe from this manual smoke.
        "citationProbe": {"enabled": False},
        "qualityGate": {"enabled": False},
    }


def _as_mapping(value: object) -> Mapping[str, Any]:
    return as_dict(value)


def _records(value: object) -> list[Mapping[str, Any]]:
    return [record for item in as_list(value) if (record := _as_mapping(item))]


def _has_type(node: Mapping[str, Any], expected: str) -> bool:
    raw = node.get("@type")
    return raw == expected or expected in [item for item in as_list(raw) if isinstance(item, str)]


def _quality_checks(generated: Mapping[str, Any]) -> dict[str, bool]:
    markup = _as_mapping(generated.get("schemaMarkup"))
    json_ld = _as_mapping(markup.get("jsonLd"))
    graph = _records(json_ld.get("@graph"))
    page = next((node for node in graph if _has_type(node, "WebPage")), None)
    product = next((node for node in graph if _has_type(node, "Product")), None)
    return {
        "webPageDescription": bool(page and _nonempty_string(page.get("description"))),
        "productIdentity": bool(product and _nonempty_string(product.get("name"))),
        "productDescription": bool(product and _nonempty_string(product.get("description"))),
    }


def _case_summary(case: Mapping[str, str], response: Mapping[str, Any]) -> dict[str, object]:
    source = case["url"]
    result = next((item for item in _records(response.get("results")) if item.get("source") == source), None)
    generated = _as_mapping(result.get("generator") if result is not None else None)
    checks = _quality_checks(generated)
    pipeline_failed = bool(_records(response.get("failures"))) or result is None
    quality_failed = not all(checks.values())
    error_category = "pipeline-failure" if pipeline_failed else "artifact-quality-shortfall" if quality_failed else None
    summary: dict[str, object] = {
        "locale": case["locale"],
        "source": _safe_url_identity(source),
        "status": "failed" if error_category else "passed",
        "qualityChecks": checks,
    }
    if error_category:
        summary["errorCategory"] = error_category
    return summary


async def run_live_smoke(config: Mapping[str, object]) -> list[dict[str, object]]:
    """Run exactly the two fixed cases through the existing console service."""

    runtime = _live_runtime(config)
    summaries: list[dict[str, object]] = []
    for case in LIVE_CASES.values():
        try:
            response = await run_generate(_case_request(case), runtime=runtime)
        except Exception:
            response = {"results": [], "failures": [{"source": case["url"]}]}
        summaries.append(_case_summary(case, _as_mapping(response)))
    return summaries


def _write_summary(stream: TextIO, payload: Mapping[str, object]) -> None:
    stream.write(json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n")


def main(*, environ: Mapping[str, str] | None = None, stdout: TextIO | None = None) -> int:
    """Run only with an exact operator opt-in; otherwise make no provider call."""

    environment = os.environ if environ is None else environ
    output = sys.stdout if stdout is None else stdout
    if environment.get("RUN_LIVE_PDP_EVAL") != "1":
        _write_summary(output, {"status": "skipped", "reason": "manual-opt-in-required"})
        return 0
    config = build_live_config(environment)
    if config is None:
        _write_summary(output, {"status": "blocked", "reason": "missing-or-invalid-aistudio-runtime"})
        return 2
    try:
        cases = asyncio.run(run_live_smoke(config))
    except Exception:
        _write_summary(output, {"status": "failed", "errorCategory": "runtime-setup-failure"})
        return 1
    status = "passed" if all(case["status"] == "passed" for case in cases) else "failed"
    _write_summary(output, {"status": status, "cases": cases})
    return 0 if status == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
