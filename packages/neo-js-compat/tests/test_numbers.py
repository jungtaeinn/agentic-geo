import math

import pytest
from neo_js_compat import js_parse_float, js_to_fixed
from neo_js_compat.numbers import js_round

# Node 24: every character below is accepted before a valid decimal prefix.
_NODE_ECMASCRIPT_WHITESPACE = (
    "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680"
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000\ufeff"
)


@pytest.mark.parametrize("leading", _NODE_ECMASCRIPT_WHITESPACE)
def test_js_parse_float_accepts_every_ecmascript_whitespace_prefix(leading: str) -> None:
    assert js_parse_float(f"{leading}42tail") == 42.0


@pytest.mark.parametrize("value", ["\u001c42", "\u008542", "١٢.٥", "１２.５"])
def test_js_parse_float_rejects_non_ecmascript_whitespace_and_unicode_digits(value: str) -> None:
    assert math.isnan(js_parse_float(value))


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("1e", 1.0),
        ("1e+", 1.0),
        ("0x10", 0.0),
        (".5e+2tail", 50.0),
        ("4.trailing", 4.0),
        ("+.5", 0.5),
    ],
)
def test_js_parse_float_returns_the_longest_valid_decimal_prefix(value: str, expected: float) -> None:
    assert js_parse_float(value) == expected


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("Infinity and beyond", math.inf),
        ("-Infinity!", -math.inf),
        ("+Infinity?", math.inf),
        ("1e309", math.inf),
    ],
)
def test_js_parse_float_parses_signed_infinity_and_overflow(value: str, expected: float) -> None:
    assert js_parse_float(value) == expected


def test_js_parse_float_preserves_negative_zero() -> None:
    result = js_parse_float("-0ignored")
    assert result == 0.0
    assert math.copysign(1.0, result) == -1.0


@pytest.mark.parametrize("value", ["", "   ", "foo", "+.", "infinity"])
def test_js_parse_float_returns_nan_when_no_valid_prefix_exists(value: str) -> None:
    assert math.isnan(js_parse_float(value))


# Node 24.11.0: this matrix covers exact binary ties and adjacent non-ties.
_NODE_TO_FIXED_GOLDENS = [
    (0.0, 0, "0"),
    (0.0, 1, "0.0"),
    (0.0, 3, "0.000"),
    (-0.0, 3, "0.000"),
    (2.0, 0, "2"),
    (2.0, 1, "2.0"),
    (2.0, 3, "2.000"),
    (0.1, 3, "0.100"),
    (0.0625, 3, "0.063"),
    (-0.0625, 3, "-0.063"),
    (1.2345, 3, "1.234"),
    (-1.2345, 3, "-1.234"),
    (2.5, 0, "3"),
    (-2.5, 0, "-3"),
    (0.5, 0, "1"),
    (-0.5, 0, "-1"),
    (1.125, 2, "1.13"),
    (-1.125, 2, "-1.13"),
    (1.005, 2, "1.00"),
    (-1.005, 2, "-1.00"),
    (2.675, 2, "2.67"),
    (-2.675, 2, "-2.67"),
    (-0.0001, 3, "-0.000"),
    (-0.0005, 3, "-0.001"),
    (-0.00051, 3, "-0.001"),
    (999.9995, 3, "1000.000"),
    (999.9995, 2, "1000.00"),
    (1e20, 3, "100000000000000000000.000"),
    (1e21, 0, "1e+21"),
    (1e21, 3, "1e+21"),
    (-1e21, 3, "-1e+21"),
    (0.1, 20, "0.10000000000000000555"),
    (
        0.1,
        100,
        "0.1000000000000000055511151231257827021181583404541015625000000000000000000000000000000000000000000000",
    ),
    (math.pi, 6, "3.141593"),
    (math.pi, 15, "3.141592653589793"),
    (5e-324, 3, "0.000"),
    (1.7976931348623157e308, 3, "1.7976931348623157e+308"),
]


@pytest.mark.parametrize(("value", "digits", "expected"), _NODE_TO_FIXED_GOLDENS)
def test_js_to_fixed_matches_node_binary64_differential_cases(value: float, digits: int, expected: str) -> None:
    assert js_to_fixed(value, digits) == expected


@pytest.mark.parametrize(
    ("value", "expected"),
    [(math.nan, "NaN"), (math.inf, "Infinity"), (-math.inf, "-Infinity")],
)
def test_js_to_fixed_spells_non_finite_numbers_like_node(value: float, expected: str) -> None:
    assert js_to_fixed(value, 3) == expected


@pytest.mark.parametrize(
    ("value", "expected"),
    [(10**309, "Infinity"), (-(10**309), "-Infinity")],
)
def test_js_to_fixed_coerces_unbounded_python_integers_to_javascript_infinity(value: int, expected: str) -> None:
    assert js_to_fixed(value, 3) == expected


@pytest.mark.parametrize("digits", [-1, 101])
def test_js_to_fixed_rejects_digits_outside_the_ecmascript_range(digits: int) -> None:
    with pytest.raises(ValueError, match="between 0 and 100"):
        js_to_fixed(1.5, digits)


def test_js_round_uses_javascript_ties() -> None:
    assert js_round(1.5) == 2
    assert js_round(-1.5) == -1


def test_js_round_does_not_round_a_representable_value_below_half_up() -> None:
    assert js_round(0.49999999999999994) == 0


@pytest.mark.parametrize("value", [-0.1, -0.5])
def test_js_round_preserves_javascript_negative_zero(value: float) -> None:
    result = js_round(value)
    assert result == 0
    assert math.copysign(1.0, result) == -1.0


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
def test_js_round_preserves_non_finite_javascript_numbers(value: float) -> None:
    result = js_round(value)
    if math.isnan(value):
        assert math.isnan(result)
    else:
        assert result == value
