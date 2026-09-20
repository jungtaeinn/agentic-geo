"""Small direct-Python API for embedding the standalone evaluation endpoint."""

from __future__ import annotations

from collections.abc import Mapping

from .rest import evaluate_rest_body


def create_geo_eval_response(payload: Mapping[str, object]) -> dict[str, object]:
    """Return the successful REST wire payload or raise its input/error message.

    This lets in-process Python callers use precisely the same normalization,
    nullish-field semantics, wire serialization, and report construction as the
    ASGI endpoint without reconstructing its response contract themselves.
    """
    status, response = evaluate_rest_body(payload)
    if status != 200:
        raise ValueError(str(response.get("error") or "Evaluation failed."))
    return response


__all__ = ["create_geo_eval_response"]
