"""JavaScript runtime compatibility helpers used by Python agent packages."""

from .json import js_json_bytes, js_json_dumps, js_json_pretty_dumps, js_result_hash
from .numbers import js_number_to_string, js_parse_float, js_round, js_to_fixed
from .strings import js_has_whitespace, js_template_string, js_trim, js_whitespace_characters
from .utf16 import (
    js_code_unit_length,
    js_embedding_snapshot_key,
    js_fnv1a32,
    js_fnv1a32_unsigned,
    js_utf8_replacement_text,
    js_utf16_slice,
)

__all__ = [
    "js_code_unit_length",
    "js_embedding_snapshot_key",
    "js_fnv1a32",
    "js_fnv1a32_unsigned",
    "js_has_whitespace",
    "js_json_bytes",
    "js_json_dumps",
    "js_json_pretty_dumps",
    "js_number_to_string",
    "js_parse_float",
    "js_result_hash",
    "js_round",
    "js_to_fixed",
    "js_template_string",
    "js_trim",
    "js_utf16_slice",
    "js_utf8_replacement_text",
    "js_whitespace_characters",
]
