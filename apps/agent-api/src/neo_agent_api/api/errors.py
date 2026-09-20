"""Nest-shaped exception envelopes used by the retained internal contract."""

from __future__ import annotations

from typing import Any

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import Response
from neo_js_compat import js_json_dumps

from neo_agent_api._json import as_dict


class LegacyHttpError(Exception):
    def __init__(self, status_code: int, message: str, error: str | None = None) -> None:
        self.status_code = status_code
        self.message = message
        self.error = error
        super().__init__(message)


def _json_response(payload: object, status_code: int) -> Response:
    return Response(
        js_json_dumps(payload).encode("utf-8"), status_code=status_code, media_type="application/json; charset=utf-8"
    )


def legacy_validation_error(message: object) -> Response:
    return _json_response({"message": message, "error": "Bad Request", "statusCode": 400}, 400)


def legacy_error(status_code: int, message: str, error: str | None = None) -> Response:
    payload: dict[str, Any] = {"statusCode": status_code, "message": message}
    if error is not None:
        # Nest's built-in subclass errors place message/error/statusCode in this order.
        payload = {"message": message, "error": error, "statusCode": status_code}
    return _json_response(payload, status_code)


async def legacy_http_exception_handler(_: Request, exc: Exception) -> Response:
    if isinstance(exc, LegacyHttpError):
        return legacy_error(exc.status_code, exc.message, exc.error)
    return legacy_error(500, str(exc) or "Internal server error")


async def legacy_request_validation_handler(_: Request, exc: Exception) -> Response:
    # The original Nest ValidationPipe did not expose framework-specific issue arrays.
    if not isinstance(exc, RequestValidationError):
        return legacy_validation_error("Bad Request")
    errors = exc.errors()
    first = as_dict(errors[0]) if errors else {}
    message = str(first.get("msg") or "Bad Request")
    return legacy_validation_error(message)
