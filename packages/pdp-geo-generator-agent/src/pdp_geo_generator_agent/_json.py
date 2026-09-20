"""Small JSON-boundary helpers shared by the generator modules."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import Any, cast


def as_mapping(value: object) -> Mapping[str, Any] | None:
    return cast(Mapping[str, Any], value) if isinstance(value, Mapping) else None


def as_dict(value: object) -> dict[str, Any]:
    return dict(cast(Mapping[str, Any], value)) if isinstance(value, Mapping) else {}


def as_list(value: object) -> list[Any]:
    return (
        list(cast(Sequence[Any], value))
        if isinstance(value, Sequence) and not isinstance(value, str | bytes | bytearray)
        else []
    )


def strings(value: object) -> list[str]:
    return [item for item in as_list(value) if isinstance(item, str)]


def string(value: object) -> str:
    return value if isinstance(value, str) else ""


def clean_text(value: object) -> str:
    """Mirror the normal whitespace cleanup used by the TS source."""
    return re.sub(r"\s+", " ", string(value)).strip()


def js_truthy(value: object) -> bool:
    """JavaScript truthiness for decoded JSON values, including empty objects."""
    if value is None or value is False:
        return False
    if isinstance(value, str):
        return value != ""
    if isinstance(value, int | float) and not isinstance(value, bool):
        return value != 0 and value == value
    return True


def omit_none(value: object) -> object:
    if isinstance(value, Mapping):
        mapping = cast(Mapping[str, object], value)
        return {key: omit_none(item) for key, item in mapping.items() if item is not None}
    if isinstance(value, list):
        return [omit_none(item) for item in cast(list[object], value)]
    return value
