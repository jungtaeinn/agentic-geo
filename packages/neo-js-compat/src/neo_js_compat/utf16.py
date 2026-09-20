"""UTF-16 code-unit helpers for JavaScript-compatible string behavior."""

from collections.abc import Iterator

_FNV1A_OFFSET_BASIS = 0x811C9DC5
_FNV1A_PRIME = 0x01000193
_UINT32_MASK = 0xFFFFFFFF
_INT32_SIGN_BIT = 0x80000000


def _iter_utf16_code_units(text: str) -> Iterator[int]:
    encoded = text.encode("utf-16-le", "surrogatepass")
    for offset in range(0, len(encoded), 2):
        yield encoded[offset] | (encoded[offset + 1] << 8)


def js_code_unit_length(text: str) -> int:
    """Return the number of UTF-16 code units in a JavaScript string."""
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def js_utf16_slice(text: str, start: int = 0, end: int | None = None) -> str:
    """Apply ``String.prototype.slice`` offsets measured in UTF-16 units."""

    length = js_code_unit_length(text)

    def offset(value: int) -> int:
        return max(length + value, 0) if value < 0 else min(value, length)

    start_offset = offset(start)
    end_offset = length if end is None else offset(end)
    if end_offset <= start_offset:
        return ""
    encoded = text.encode("utf-16-le", "surrogatepass")
    return encoded[start_offset * 2 : end_offset * 2].decode("utf-16-le", "surrogatepass")


def js_utf8_replacement_text(text: str) -> str:
    """Mirror Node UTF-8 encoding of JavaScript strings with lone surrogates.

    Node's filesystem APIs encode an unmatched UTF-16 surrogate as U+FFFD.
    Python paths/text reject such a code point, so normalize only at the
    storage boundary while retaining the original code-unit string in caller
    state (for example, a JavaScript ``Set`` used during cleanup).
    """

    return text.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "replace")


def js_fnv1a32(text: str) -> int:
    """Return the non-negative signed FNV state used by embedding snapshots."""
    return abs(_fnv1a_signed_state(text))


def js_fnv1a32_unsigned(text: str) -> int:
    """Return the unsigned 32-bit FNV-1a hash for callers that need raw bits."""
    return _fnv1a_signed_state(text) & _UINT32_MASK


def js_embedding_snapshot_key(text: str) -> str:
    """Return the exact ``Math.abs(hash):text.length`` TypeScript snapshot key."""
    return f"{js_fnv1a32(text)}:{js_code_unit_length(text)}"


def _fnv1a_signed_state(text: str) -> int:
    hash_value = _FNV1A_OFFSET_BASIS
    for code_unit in _iter_utf16_code_units(text):
        hash_value ^= code_unit
        hash_value = _to_signed_int32(hash_value * _FNV1A_PRIME)
    return hash_value


def _to_signed_int32(value: int) -> int:
    value &= _UINT32_MASK
    return value if value < _INT32_SIGN_BIT else value - (_UINT32_MASK + 1)
