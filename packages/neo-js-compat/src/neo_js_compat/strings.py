"""String helpers whose observable semantics follow ECMAScript."""

from collections.abc import Mapping
from typing import cast

from ._whitespace import ECMASCRIPT_TRIM, ECMASCRIPT_WHITESPACE
from .numbers import js_number_to_string


def js_whitespace_characters() -> str:
    """Return the code points matched by ECMAScript's non-Unicode ``\\s``."""

    return ECMASCRIPT_WHITESPACE


def js_has_whitespace(value: str) -> bool:
    """Whether ECMAScript's ``/\\s/`` would find a character in ``value``."""

    return any(character in ECMASCRIPT_TRIM for character in value)


def js_trim(value: str) -> str:
    """Mirror ``String.prototype.trim`` without Python-only whitespace."""

    start = 0
    end = len(value)
    while start < end and value[start] in ECMASCRIPT_TRIM:
        start += 1
    while end > start and value[end - 1] in ECMASCRIPT_TRIM:
        end -= 1
    return value[start:end]


def js_template_string(value: object) -> str:
    """Mirror template-literal coercion for JSON-representable values."""

    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return value
    if isinstance(value, int | float):
        return js_number_to_string(value)
    if isinstance(value, list):
        # Array#toString delegates to join, whose nullish entries are empty.
        return ",".join("" if item is None else js_template_string(item) for item in cast(list[object], value))
    if isinstance(value, Mapping):
        return "[object Object]"
    return str(value)
