"""Request-scoped compatibility dependencies."""

from __future__ import annotations

import contextvars
import secrets
import uuid

from fastapi import Request

from .errors import LegacyHttpError

request_id_context: contextvars.ContextVar[str | None] = contextvars.ContextVar("neo_request_id", default=None)


def request_id_from(request: Request) -> str:
    value = request.headers.get("x-request-id", "")
    return value or str(uuid.uuid4())


def require_internal_api_key(request: Request) -> None:
    expected = str(request.app.state.settings.api_key)
    if not expected:
        return
    provided = request.headers.get("x-api-key", "")
    provided_bytes = provided.encode("utf-8")
    expected_bytes = expected.encode("utf-8")
    # Match the retained Buffer-based guard: compare equal-size UTF-8 bytes in constant time.
    if len(provided_bytes) != len(expected_bytes) or not secrets.compare_digest(provided_bytes, expected_bytes):
        raise LegacyHttpError(401, "invalid x-api-key", "Unauthorized")
