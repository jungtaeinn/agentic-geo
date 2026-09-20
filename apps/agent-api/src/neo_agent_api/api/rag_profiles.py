"""Combined GEO-console and extractor-only RAG profile compatibility route."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import Any, Protocol, cast

from fastapi import APIRouter, Request

from neo_agent_api._json import as_dict, as_list

from .console import console_json
from .json_request import parse_console_json_body

router = APIRouter()


class _RagProfileStore(Protocol):
    async def read_extractor(self) -> dict[str, Any]: ...

    async def write_extractor(self, payload: Mapping[str, Any]) -> dict[str, Any]: ...

    async def reset_extractor(self) -> dict[str, Any]: ...

    async def read_generator(self) -> dict[str, Any]: ...

    async def write_generator(self, payload: Mapping[str, Any]) -> dict[str, Any]: ...

    async def reset_generator(self) -> dict[str, Any]: ...


def _profiles(request: Request) -> _RagProfileStore:
    return cast(_RagProfileStore, request.app.state.profiles)


def _extractor_view(request: Request) -> bool:
    return request.headers.get("x-neo-console", "").casefold() == "extractor"


def _profile_payload(body: object) -> dict[str, Any]:
    if body is None:
        raise TypeError("Cannot read properties of null (reading 'analysisPrompt')")
    record = as_dict(body)
    analysis_prompt = record.get("analysisPrompt")
    # The retained writer applies ``profile.analysisPrompt || default`` and
    # then calls ``value.endsWith``.  Truthy non-strings reach that method and
    # fail before either package's Python storage adapter could coerce them.
    if not isinstance(analysis_prompt, str) and _js_truthy(analysis_prompt):
        raise TypeError("value.endsWith is not a function")
    documents_value = record.get("documents")
    documents = [] if documents_value is None else as_list(documents_value)
    if documents_value is not None and not isinstance(documents_value, list):
        # The source invokes ``(body.documents ?? []).filter`` directly.
        raise TypeError("(body.documents ?? []).filter is not a function")
    documents_payload: list[dict[str, Any]] = []
    for item in documents:
        if item is None:
            raise TypeError("Cannot read properties of null (reading 'name')")
        document = as_dict(item)
        name = document.get("name")
        if not _js_truthy(name) or not isinstance(document.get("content"), str):
            continue
        documents_payload.append(
            {
                "name": name,
                "version": document.get("version") if document.get("version") is not None else "v1",
                "content": document.get("content") if document.get("content") is not None else "",
            }
        )
    return {
        "analysisPrompt": "" if analysis_prompt is None else analysis_prompt,
        "documents": documents_payload,
    }


def _js_truthy(value: object) -> bool:
    if value is None or value is False:
        return False
    if isinstance(value, str):
        return value != ""
    if isinstance(value, int | float) and not isinstance(value, bool):
        return value != 0 and value == value
    return True


@router.get("/rag-profile")
async def get_rag_profile(request: Request):
    try:
        profiles = _profiles(request)
        if _extractor_view(request):
            return console_json(await profiles.read_extractor())
        # The combined generator console calls both package stores through
        # Promise.all.  Starting both before awaiting also preserves its error
        # and side-effect behavior when one backing store fails.
        extractor, generator = await asyncio.gather(
            profiles.read_extractor(),
            profiles.read_generator(),
        )
        return console_json({"extractor": extractor, "generator": generator})
    except Exception as exc:
        return console_json({"error": str(exc) or "RAG profile load failed."}, 500)


@router.put("/rag-profile")
async def put_rag_profile(request: Request):
    try:
        profiles = _profiles(request)
        body = parse_console_json_body(await request.body())
        payload = _profile_payload(body)
        if _extractor_view(request):
            return console_json(await profiles.write_extractor(payload))
        target = as_dict(body).get("target")
        if target == "generator":
            return console_json({"generator": await profiles.write_generator(payload)})
        return console_json({"extractor": await profiles.write_extractor(payload)})
    except Exception as exc:
        return console_json({"error": str(exc) or "RAG profile save failed."}, 500)


@router.delete("/rag-profile")
async def delete_rag_profile(request: Request):
    try:
        profiles = _profiles(request)
        if _extractor_view(request):
            return console_json(await profiles.reset_extractor())
        target = request.query_params.get("target")
        if target == "extractor":
            return console_json({"extractor": await profiles.reset_extractor()})
        if target == "generator":
            return console_json({"generator": await profiles.reset_generator()})
        extractor, generator = await asyncio.gather(
            profiles.reset_extractor(),
            profiles.reset_generator(),
        )
        return console_json({"extractor": extractor, "generator": generator})
    except Exception as exc:
        return console_json({"error": str(exc) or "RAG profile reset failed."}, 500)
