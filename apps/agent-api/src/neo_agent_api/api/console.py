"""Unauthenticated console-business routes retained from Next handlers."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator, Mapping
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import Response, StreamingResponse
from neo_js_compat import js_json_dumps
from pdp_extractor_agent import refine_geo_product_result, run_mock_product_extraction
from pdp_geo_eval_agent import evaluate_geo_quality, to_wire

from neo_agent_api._json import as_dict, as_list
from neo_agent_api.services.console_orchestration import (
    RequestConfigurationError,
    extract_console,
    generator_console,
    js_truthy,
    run_generate,
    runtime_config,
)
from neo_agent_api.services.provider_validation import validate_provider

from .json_request import parse_console_json_body

router = APIRouter()
STREAM_HEARTBEAT_INTERVAL_SECONDS = 15


def console_json(payload: object, status_code: int = 200, *, headers: Mapping[str, str] | None = None) -> Response:
    """Return the same UTF-8 bytes as the retained ``JSON.stringify`` routes."""

    return Response(
        js_json_dumps(payload).encode("utf-8"),
        status_code=status_code,
        media_type="application/json; charset=utf-8",
        headers=dict(headers) if headers is not None else None,
    )


async def _body(request: Request) -> object:
    return parse_console_json_body(await request.body())


async def _read_profile(request: Request, name: str) -> Mapping[str, Any] | None:
    """Keep Next's ``read…().catch(() => undefined)`` profile behavior."""

    try:
        profile = await getattr(request.app.state.profiles, name)()
    except Exception:
        return None
    return as_dict(profile)


@router.api_route("/extract", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"])
async def extract(request: Request) -> Response:
    try:
        body: object = await _body(request) if request.method == "POST" else {}
        status, payload, headers = await extract_console(
            body,
            method=request.method,
            runtime=request.app.state.extractor_console_runtime,
            profile=await _read_profile(request, "read_extractor"),
        )
        return console_json(payload, status, headers=headers)
    except RequestConfigurationError as exc:
        return console_json({"error": str(exc)}, 400)
    except Exception as exc:
        return console_json({"error": str(exc) or "Product extraction failed."}, 500)


@router.api_route("/generator", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"])
async def generator(request: Request) -> Response:
    try:
        body: object = await _body(request) if request.method == "POST" else {}
        status, payload, headers = await generator_console(
            body,
            method=request.method,
            runtime=request.app.state.generator_console_runtime,
            profile=await _read_profile(request, "read_generator"),
        )
        return console_json(payload, status, headers=headers)
    except Exception as exc:
        return console_json({"error": str(exc) or "PDP GEO generation failed."}, 500)


async def _stream_events(
    body: Mapping[str, Any],
    runtime: Mapping[str, Any],
    extractor_profile: Mapping[str, Any] | None,
    generator_profile: Mapping[str, Any] | None,
) -> AsyncGenerator[bytes]:
    events: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()

    async def emit(event: dict[str, Any]) -> None:
        await events.put(event)

    async def execute() -> None:
        try:
            payload = await run_generate(
                body,
                runtime=runtime,
                progress=emit,
                extractor_profile=extractor_profile,
                generator_profile=generator_profile,
            )
            if not payload["results"] and not payload["failures"]:
                await events.put(
                    {
                        "type": "error",
                        "error": "At least one URL, REST API source, or product JSON payload is required.",
                    }
                )
            else:
                await events.put({"type": "result", "payload": payload})
        except Exception as exc:
            await events.put({"type": "error", "error": str(exc) or "PDP GEO generation failed."})
        finally:
            await events.put(None)

    task = asyncio.create_task(execute())
    try:
        while True:
            try:
                event = await asyncio.wait_for(events.get(), timeout=STREAM_HEARTBEAT_INTERVAL_SECONDS)
            except TimeoutError:
                yield b'{"type":"heartbeat"}\n'
                continue
            if event is None:
                break
            try:
                yield (js_json_dumps(event) + "\n").encode("utf-8")
            except Exception as exc:
                # A ReadableStream write can fail after its 200 response has started.
                # Preserve the retained terminal-error event rather than silently ending
                # the stream with an invalid UTF-8 / serialization exception.
                error = str(exc) or "PDP GEO generation failed."
                yield (js_json_dumps({"type": "error", "error": error}) + "\n").encode("utf-8")
                break
    finally:
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@router.post("/generate")
async def generate(request: Request) -> Response:
    try:
        decoded = await _body(request)
        if not isinstance(decoded, Mapping):
            raise ValueError("Request body must be a JSON object.")
        body = as_dict(decoded)
        runtime = runtime_config(body, request.app.state.runtime)
        extractor_profile, generator_profile = await asyncio.gather(
            _read_profile(request, "read_extractor"), _read_profile(request, "read_generator")
        )
        if js_truthy(body.get("stream")):
            return StreamingResponse(
                _stream_events(body, runtime, extractor_profile, generator_profile),
                media_type="application/x-ndjson; charset=utf-8",
                headers={"Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no"},
            )
        payload = await run_generate(
            body,
            runtime=runtime,
            extractor_profile=extractor_profile,
            generator_profile=generator_profile,
        )
        if not payload["results"] and not payload["failures"]:
            return console_json(
                {"error": "At least one URL, REST API source, or product JSON payload is required."}, 400
            )
        return console_json(payload, 207 if payload["failures"] else 200)
    except RequestConfigurationError as exc:
        return console_json({"error": str(exc)}, 400)
    except Exception as exc:
        return console_json({"error": str(exc) or "PDP GEO generation failed."}, 500)


@router.post("/provider/validate")
async def provider_validate(request: Request) -> Response:
    try:
        body = await _body(request)
        # The retained route reads ``body.provider`` before spreading it.  A
        # JSON ``null`` therefore throws instead of being normalized to an
        # empty configuration object.
        if body is None:
            raise TypeError("Cannot read properties of null (reading 'provider')")
        result = await validate_provider(as_dict(body))
        return console_json(result, 200 if result["ok"] else 400)
    except Exception as exc:
        return console_json(
            {"ok": False, "provider": "mock", "message": str(exc) or "Provider validation failed."}, 500
        )


@router.post("/refine")
async def refine(request: Request) -> Response:
    try:
        body = await _body(request)
        if not isinstance(body, Mapping):
            raise ValueError("Request body must be a JSON object.")
        return console_json(refine_geo_product_result(as_dict(body)))
    except Exception as exc:
        return console_json({"error": str(exc) or "GEO RAW JSON refinement failed."}, 400)


@router.post("/mock")
async def mock(request: Request) -> Response:
    try:
        body = await _body(request)
        # The browser import is ``runMockProductExtraction(sources: string[])``.
        # Accept its literal input/output shape rather than inventing a BFF DTO.
        sources = as_list(body) if isinstance(body, list) else as_dict(body).get("sources")
        source_list = as_list(sources)
        if not isinstance(sources, list) or not all(isinstance(source, str) for source in source_list):
            raise ValueError("sources must be a string array")
        typed_sources = [source for source in source_list if isinstance(source, str)]
        runs = await run_mock_product_extraction(typed_sources)
        wire = [run.to_wire() for run in runs]
        # Preserve both response shapes: object-wrapper callers get a results
        # object, while the direct import-compatible path keeps raw arrays.
        return console_json(wire if isinstance(body, list) else {"results": wire})
    except Exception as exc:
        return console_json({"error": str(exc) or "Mock extraction failed."}, 400)


@router.post("/evaluation")
async def evaluation(request: Request) -> Response:
    try:
        body = await _body(request)
        if not isinstance(body, Mapping):
            raise ValueError("Request body must be a JSON object.")
        # ``evaluateGeoQuality(input, uiLanguage)`` is directly imported by
        # the browser, so the request keeps its first argument as-is and puts
        # the second argument beside it for HTTP transport.
        record = as_dict(body)
        input_payload = as_dict(record.get("input")) if isinstance(record.get("input"), Mapping) else record
        language = "en" if record.get("language") == "en" else "ko"
        return console_json(to_wire(evaluate_geo_quality(input_payload, language)))
    except Exception as exc:
        return console_json({"error": str(exc) or "Evaluation failed."}, 400)
