"""Typed JSON boundary helpers for the HTTP compatibility layer.

``Request.json`` and untrusted profile/provider payloads are intentionally
``object`` at the boundary.  These helpers retain that safety while giving the
service a concrete, string-keyed representation after validation.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, cast


def as_dict(value: Any) -> dict[str, Any]:
    """Copy a JSON object, retaining only string keys."""

    if not isinstance(value, Mapping):
        return {}
    raw = cast(Mapping[object, object], value)
    return {key: item for key, item in raw.items() if isinstance(key, str)}


def as_list(value: Any) -> list[Any]:
    """Copy a JSON array without accepting strings as sequences."""

    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return []
    return list(cast(Sequence[Any], value))


def omit_none(value: Any) -> object:
    """Mirror JSON.stringify's omission of undefined-shaped object fields."""

    if isinstance(value, Mapping):
        raw = cast(Mapping[object, object], value)
        return {key: omit_none(item) for key, item in raw.items() if isinstance(key, str) and item is not None}
    if isinstance(value, list):
        return [omit_none(item) for item in as_list(value)]
    return value
