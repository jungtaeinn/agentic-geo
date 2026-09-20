"""JSON serialization compatible with JavaScript's ``JSON.stringify``."""

import hashlib
import math
from collections.abc import Mapping, Sequence
from typing import Any, cast

_MAX_ARRAY_INDEX = 2**32 - 2
_MAX_ARRAY_INDEX_TEXT = str(_MAX_ARRAY_INDEX)


def js_json_dumps(value: Any, *, sort_keys: bool = False) -> str:
    """Serialize a JSON value with JavaScript property and number semantics.

    ``sort_keys=True`` mirrors the TypeScript result-hash canonicalizer: object
    keys are sorted by UTF-16 code units before JavaScript property enumeration
    moves array-index keys ahead of other properties.
    """
    return _serialize(value, canonicalize=sort_keys)


def js_json_bytes(value: Any) -> bytes:
    """Serialize a JSON value to the UTF-8 bytes from ``JSON.stringify``."""
    return js_json_dumps(value).encode("utf-8")


def js_json_pretty_dumps(value: Any, indent: int = 2) -> str:
    """Serialize a JSON value like ``JSON.stringify(value, null, indent)``.

    Numeric indentation follows ECMAScript's numeric-space behavior: nonpositive
    values are compact and values larger than ten are capped at ten spaces.
    """
    indentation = " " * min(max(indent, 0), 10)
    return _serialize(value, canonicalize=False, indentation=indentation or None)


def js_result_hash(value: Any) -> str:
    """Return the SHA-256 digest of TypeScript's canonical JSON representation."""
    return hashlib.sha256(js_json_dumps(value, sort_keys=True).encode("utf-8")).hexdigest()


def _serialize(value: Any, *, canonicalize: bool, indentation: str | None = None, depth: int = 0) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return _quote_string(value)
    if isinstance(value, int | float):
        return _serialize_number(value)
    if isinstance(value, Mapping):
        return _serialize_mapping(
            cast(Mapping[Any, Any], value), canonicalize=canonicalize, indentation=indentation, depth=depth
        )
    if isinstance(value, Sequence):
        sequence = cast(Sequence[Any], value)
        return _serialize_sequence(sequence, canonicalize=canonicalize, indentation=indentation, depth=depth)
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


def _serialize_mapping(value: Mapping[Any, Any], *, canonicalize: bool, indentation: str | None, depth: int) -> str:
    keys = list(value)
    if not all(isinstance(key, str) for key in keys):
        raise TypeError("JavaScript object keys must be strings")

    string_keys = keys
    if canonicalize:
        string_keys.sort(key=_utf16_sort_key)

    array_index_keys = [(array_index, key) for key in string_keys if (array_index := _array_index(key)) is not None]
    array_index_keys.sort()
    non_index_keys = [key for key in string_keys if _array_index(key) is None]
    ordered_keys = [key for _, key in array_index_keys] + non_index_keys
    if not indentation or not ordered_keys:
        return "{" + ",".join(
            _quote_string(key) + ":" + _serialize(value[key], canonicalize=canonicalize) for key in ordered_keys
        ) + "}"
    member_padding = indentation * (depth + 1)
    closing_padding = indentation * depth
    members = (
        member_padding
        + _quote_string(key)
        + ": "
        + _serialize(value[key], canonicalize=canonicalize, indentation=indentation, depth=depth + 1)
        for key in ordered_keys
    )
    return "{\n" + ",\n".join(members) + "\n" + closing_padding + "}"


def _serialize_sequence(value: Sequence[Any], *, canonicalize: bool, indentation: str | None, depth: int) -> str:
    if not indentation or not value:
        return "[" + ",".join(_serialize(item, canonicalize=canonicalize) for item in value) + "]"
    item_padding = indentation * (depth + 1)
    closing_padding = indentation * depth
    items = (
        item_padding + _serialize(item, canonicalize=canonicalize, indentation=indentation, depth=depth + 1)
        for item in value
    )
    return "[\n" + ",\n".join(items) + "\n" + closing_padding + "]"


def _array_index(key: str) -> int | None:
    if key == "0":
        return 0
    if not key or key[0] == "0" or not all("0" <= character <= "9" for character in key):
        return None
    if len(key) > len(_MAX_ARRAY_INDEX_TEXT):
        return None
    if len(key) == len(_MAX_ARRAY_INDEX_TEXT) and key > _MAX_ARRAY_INDEX_TEXT:
        return None
    return int(key)


def _utf16_sort_key(value: str) -> bytes:
    return value.encode("utf-16-be", "surrogatepass")


def _serialize_number(value: int | float) -> str:
    try:
        number = float(value)
    except OverflowError:
        return "null"
    if not math.isfinite(number):
        return "null"
    if number == 0.0:
        return "0"

    rendered = repr(number)
    sign = ""
    if rendered.startswith("-"):
        sign, rendered = "-", rendered[1:]

    if "e" in rendered:
        significand, exponent_text = rendered.split("e")
        exponent = int(exponent_text)
    else:
        significand, exponent = rendered, 0

    if 1e-6 <= abs(number) < 1e21:
        return sign + _fixed_notation(significand, exponent)
    return sign + _scientific_notation(significand, exponent)


def _fixed_notation(significand: str, exponent: int) -> str:
    whole, dot, fraction = significand.partition(".")
    digits = (whole + fraction).rstrip("0") if dot else whole
    decimal_position = len(whole) + exponent

    if decimal_position <= 0:
        rendered = "0." + "0" * -decimal_position + digits
    elif decimal_position >= len(digits):
        rendered = digits + "0" * (decimal_position - len(digits))
    else:
        rendered = digits[:decimal_position] + "." + digits[decimal_position:]

    return rendered


def _scientific_notation(significand: str, exponent: int) -> str:
    normalized = significand.rstrip("0").rstrip(".") if "." in significand else significand
    return f"{normalized}e{exponent:+d}"


def _quote_string(value: str) -> str:
    escaped: list[str] = ['"']
    index = 0
    while index < len(value):
        character = value[index]
        code_point = ord(character)
        if character == '"':
            escaped.append('\\"')
        elif character == "\\":
            escaped.append("\\\\")
        elif character == "\b":
            escaped.append("\\b")
        elif character == "\t":
            escaped.append("\\t")
        elif character == "\n":
            escaped.append("\\n")
        elif character == "\f":
            escaped.append("\\f")
        elif character == "\r":
            escaped.append("\\r")
        elif code_point < 0x20:
            escaped.append(f"\\u{code_point:04x}")
        elif 0xD800 <= code_point <= 0xDBFF and index + 1 < len(value):
            next_code_point = ord(value[index + 1])
            if 0xDC00 <= next_code_point <= 0xDFFF:
                escaped.append(chr(0x10000 + ((code_point - 0xD800) << 10) + next_code_point - 0xDC00))
                index += 1
            else:
                escaped.append(f"\\u{code_point:04x}")
        elif 0xD800 <= code_point <= 0xDFFF:
            escaped.append(f"\\u{code_point:04x}")
        else:
            escaped.append(character)
        index += 1
    escaped.append('"')
    return "".join(escaped)
