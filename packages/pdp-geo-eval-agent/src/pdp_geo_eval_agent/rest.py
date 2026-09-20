"""ASGI REST adapter for structural GEO quality evaluation."""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable, Mapping
from typing import cast

from .models import to_wire
from .prompts.improvement import format_quality_llm_prompt
from .quality.evaluate import evaluate_geo_quality, format_geo_quality_evaluation_text

_EMPTY_SECTIONS = {"productName": "", "description": "", "quickFacts": "", "benefits": "", "ingredients": "", "howToUse": "", "faq": ""}
_ASGIMessage = dict[str, object]
_ASGIReceive = Callable[[], Awaitable[_ASGIMessage]]
_ASGISend = Callable[[_ASGIMessage], Awaitable[None]]
_ASGIApp = Callable[[_ASGIMessage, _ASGIReceive, _ASGISend], Awaitable[None]]


def evaluate_rest_body(body: object) -> tuple[int, dict[str, object]]:
    """Evaluate one decoded REST payload using the TypeScript nullish contract."""
    request = _record(body)
    # JavaScript's check is exactly ``=== undefined || === null``: false, 0,
    # empty string, and {} remain valid structural input and must reach the
    # evaluator instead of being rejected by Python truthiness.
    if "jsonLd" not in request or request.get("jsonLd") is None:
        return 400, {"error": '"jsonLd" is required: the schema.org graph to evaluate.'}
    language = "en" if request.get("language") == "en" else "ko"
    raw_diagnostics = request.get("diagnostics")
    diagnostics_input = _record(raw_diagnostics)
    diagnostics: dict[str, object] = {
        "normalizedProduct": diagnostics_input.get("normalizedProduct") if diagnostics_input.get("normalizedProduct") is not None else {},
        "validationWarnings": diagnostics_input.get("validationWarnings") if diagnostics_input.get("validationWarnings") is not None else [],
        "validationRepairs": diagnostics_input.get("validationRepairs"),
        "ragUsage": diagnostics_input.get("ragUsage"),
        "evidence": diagnostics_input.get("evidence"),
        "evidenceLedger": diagnostics_input.get("evidenceLedger"),
        "contentPlan": diagnostics_input.get("contentPlan"),
    }
    try:
        evaluation = evaluate_geo_quality({"jsonLd": request.get("jsonLd"), "diagnostics": diagnostics}, language)
        normalized_product = _record(diagnostics["normalizedProduct"])
        raw_sections = request.get("contentSections")
        product_name = _first_non_nullish(request.get("productName"), normalized_product.get("name"), _record(raw_sections).get("productName", ""))
        product_name = product_name if isinstance(product_name, str) else str(product_name)
        report = format_geo_quality_evaluation_text(product_name, evaluation, language)
        result: dict[str, object] = {"evaluation": to_wire(evaluation), "report": report}
        if _js_truthy(raw_sections):
            sections = {**_EMPTY_SECTIONS, **_record(raw_sections)}
            result["improvementPrompt"] = format_quality_llm_prompt({"productName": product_name, "contentSections": sections, "jsonLd": request.get("jsonLd")}, evaluation, language)
        return 200, result
    except Exception as error:
        return 500, {"error": str(error) or "Evaluation failed."}


def create_pdp_geo_eval_asgi_app() -> _ASGIApp:
    """Create a dependency-free ASGI endpoint for POST quality evaluation."""
    async def app(scope: _ASGIMessage, receive: _ASGIReceive, send: _ASGISend) -> None:
        if scope.get("type") != "http":
            return
        if scope.get("method") != "POST":
            await _send_json(send, 405, {"error": "Method not allowed."}, [(b"allow", b"POST")])
            return
        chunks: list[bytes] = []
        while True:
            event = await receive()
            if event.get("type") == "http.disconnect":
                return
            if event.get("type") != "http.request":
                continue
            body_chunk = event.get("body", b"")
            if isinstance(body_chunk, bytes):
                chunks.append(body_chunk)
            if not event.get("more_body", False):
                break
        try:
            body = json.loads(b"".join(chunks))
        except (TypeError, UnicodeDecodeError, json.JSONDecodeError):
            await _send_json(send, 400, {"error": "Request body must be valid JSON."})
            return
        status, payload = evaluate_rest_body(body)
        await _send_json(send, status, payload)
    return app


def create_pdp_geo_eval_rest_handler():
    """Compatibility name for consumers that want the evaluator ASGI handler."""
    return create_pdp_geo_eval_asgi_app()


async def _send_json(send: _ASGISend, status: int, payload: Mapping[str, object], extra_headers: list[tuple[bytes, bytes]] | None = None) -> None:
    # JavaScript's well-formed JSON.stringify escapes a lone UTF-16 surrogate
    # produced by ``slice``. Keep ordinary Unicode unescaped, but encode any
    # such surrogate as its JSON ``\\udxxx`` escape instead of emitting invalid
    # UTF-8 or raising at the ASGI boundary.
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8", errors="backslashreplace")
    headers = [(b"content-type", b"application/json"), *(extra_headers or [])]
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": body})


def _first_non_nullish(*values: object) -> object:
    return next((value for value in values if value is not None), "")


def _js_truthy(value: object) -> bool:
    if value is None or value is False:
        return False
    if isinstance(value, (int, float)) and not isinstance(value, bool) and value == 0:
        return False
    if isinstance(value, str):
        return bool(value)
    return True


def _record(value: object) -> dict[str, object]:
    if not isinstance(value, Mapping):
        return {}
    return {str(key): item for key, item in cast(Mapping[object, object], value).items()}
