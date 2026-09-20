import base64
import hashlib
from dataclasses import dataclass
from typing import Any

import pytest
from neo_js_compat import js_json_bytes, js_json_pretty_dumps
from neo_js_compat.json import js_json_dumps, js_result_hash


@dataclass(frozen=True)
class NodeJsonGolden:
    """A literal captured from Node's canonicalize() plus JSON.stringify()."""

    value: Any
    serialized: str
    result_hash: str


# These values were captured from Node v24.11.0 using the canonicalize() and
# computeResultHash() implementations in apps/agent-api/src/geo/schema-types.util.ts.
NODE_RESULT_HASH_GOLDENS = (
    NodeJsonGolden(
        value={"value": 1.0},
        serialized='{"value":1}',
        result_hash="48208f9428d64634bd8e28ff345bf0eab60d53c18fa2fbdb0b9bc1e84df2b5f6",
    ),
    NodeJsonGolden(
        value={"value": 1e-7},
        serialized='{"value":1e-7}',
        result_hash="910750038eb30a40d06da88009b6259aabaf3751b3cb212c616d51abb6b008a4",
    ),
    NodeJsonGolden(
        value={"value": 1.28e18},
        serialized='{"value":1280000000000000000}',
        result_hash="09748b153923e96e051825493fdcb77d88c5db4027b206674a210fa4497cb6c4",
    ),
    NodeJsonGolden(
        value={"\ue000": "bmp", "😀": "astral"},
        serialized='{"😀":"astral","":"bmp"}',
        result_hash="f205ab885ec5c0369796b58c5555bbc1cfb850bf95ea87acee1cfb667b2ef40f",
    ),
    NodeJsonGolden(
        value={
            "10": "ten",
            "2": "two",
            "01": "leading",
            "4294967294": "last-index",
            "4294967295": "not-index",
            "a": "alpha",
        },
        serialized='{"2":"two","10":"ten","4294967294":"last-index","01":"leading","4294967295":"not-index","a":"alpha"}',
        result_hash="8a226d3f305dea25689375edf788e46ba55db1de1638de24d19611836c551075",
    ),
    NodeJsonGolden(
        value={"nan": float("nan"), "positive": float("inf"), "negative": float("-inf"), "finite": 1.0},
        serialized='{"finite":1,"nan":null,"negative":null,"positive":null}',
        result_hash="0176abc71c3e2f3dd97733b1334801e457d5b3cde93b6f48180221fc32b3a274",
    ),
)


# Captured from Node v24.11.0 using canonicalize() and computeResultHash() in
# apps/agent-api/src/geo/schema-types.util.ts.  JavaScript treats this as an
# ordinary property: it is too large to be an array-index property.
LONG_DIGIT_PROPERTY_KEY = "9" * 5000
LONG_DIGIT_PROPERTY_SERIALIZED = f'{{"{LONG_DIGIT_PROPERTY_KEY}":"long-key"}}'
LONG_DIGIT_PROPERTY_RESULT_HASH = "2dc781a2d236f4489b705848ec36f99aec3b89fec8639718b7f969f53980aac3"


# Captured from Node v24.11.0's JSON.stringify(value) and
# JSON.stringify(value, null, 2), using the pinned legacy source commit
# 6702158280ec7de675594af93c7c381eb2feae38.  These literals are an external
# oracle: tests must never execute Node or calculate expected wire data through
# the production serializer.
NODE_JSON_WIRE_UTF8_BASE64 = (
    "eyIyIjoidHdvIiwiMTAiOiJ0ZW4iLCJ6ZXJvIjowLCJzbWFsbCI6MC4wMDAwMDEsImxhcmdlIjoxMDAwMDAwMDAwMDAwMDAwMDAwMDAs"
    "ImludGVncmFsIjo3LCJuYW4iOm51bGwsInBvc2l0aXZlIjpudWxsLCJuZWdhdGl2ZSI6bnVsbCwidGV4dCI6Iu2VnOq4gPCfmIB4XHVkODAw"
    "IiwibmVzdGVkIjpbeyIyIjoiY2hpbGQgdHdvIiwiMTAiOiJjaGlsZCB0ZW4iLCJ2YWx1ZSI6MH0sWzAuMDAwMDAxLG51bGwsIuuBnSJdXX0="
)
NODE_JSON_WIRE_SHA256 = "9f58c30711f19a6a3bcc707d9a0fd379fe65e2a7698c415dacb22a0375d438f1"
NODE_JSON_PRETTY_UTF8_BASE64 = (
    "ewogICIyIjogInR3byIsCiAgIjEwIjogInRlbiIsCiAgInplcm8iOiAwLAogICJzbWFsbCI6IDAuMDAwMDAxLAogICJsYXJnZSI6IDEwMDAw"
    "MDAwMDAwMDAwMDAwMDAwMCwKICAiaW50ZWdyYWwiOiA3LAogICJuYW4iOiBudWxsLAogICJwb3NpdGl2ZSI6IG51bGwsCiAgIm5lZ2F0aXZl"
    "IjogbnVsbCwKICAidGV4dCI6ICLtlZzquIDwn5iAeFx1ZDgwMCIsCiAgIm5lc3RlZCI6IFsKICAgIHsKICAgICAgIjIiOiAiY2hpbGQgdHdv"
    "IiwKICAgICAgIjEwIjogImNoaWxkIHRlbiIsCiAgICAgICJ2YWx1ZSI6IDAKICAgIH0sCiAgICBbCiAgICAgIDAuMDAwMDAxLAogICAgICBudWxs"
    "LAogICAgICAi64GdIgogICAgXQogIF0KfQ=="
)
NODE_JSON_PRETTY_SHA256 = "f2388c39e0dd4e6c8164866e61f2dfe49c60b2ed1904d703610290957df04304"


def _node_json_wire_value() -> dict[str, object]:
    return {
        "10": "ten",
        "2": "two",
        "zero": -0.0,
        "small": 1e-6,
        "large": 1e20,
        "integral": 7.0,
        "nan": float("nan"),
        "positive": float("inf"),
        "negative": float("-inf"),
        "text": "한글😀x\ud800",
        "nested": [
            {"10": "child ten", "2": "child two", "value": -0.0},
            [1e-6, float("nan"), "끝"],
        ],
    }


def test_result_hash_sorts_keys_without_ascii_escaping() -> None:
    assert js_json_dumps({"b": "한글", "a": 1}, sort_keys=True) == '{"a":1,"b":"한글"}'
    assert js_result_hash({"b": "한글", "a": 1}) == js_result_hash({"a": 1, "b": "한글"})


def test_result_hash_keeps_a_5000_digit_property_key_as_non_index() -> None:
    value = {LONG_DIGIT_PROPERTY_KEY: "long-key"}

    assert js_json_dumps(value, sort_keys=True) == LONG_DIGIT_PROPERTY_SERIALIZED
    assert js_result_hash(value) == LONG_DIGIT_PROPERTY_RESULT_HASH


def test_js_json_bytes_match_pinned_node_utf8_contract() -> None:
    expected = base64.b64decode(NODE_JSON_WIRE_UTF8_BASE64)

    actual = js_json_bytes(_node_json_wire_value())

    assert actual == expected
    assert hashlib.sha256(actual).hexdigest() == NODE_JSON_WIRE_SHA256


def test_js_json_pretty_dumps_match_pinned_node_two_space_contract() -> None:
    expected = base64.b64decode(NODE_JSON_PRETTY_UTF8_BASE64)

    actual = js_json_pretty_dumps(_node_json_wire_value())

    assert actual.encode("utf-8") == expected
    assert hashlib.sha256(actual.encode("utf-8")).hexdigest() == NODE_JSON_PRETTY_SHA256


@pytest.mark.parametrize("golden", NODE_RESULT_HASH_GOLDENS)
def test_result_hash_matches_node_canonicalization_golden(golden: NodeJsonGolden) -> None:
    assert js_json_dumps(golden.value, sort_keys=True) == golden.serialized
    assert js_result_hash(golden.value) == golden.result_hash
