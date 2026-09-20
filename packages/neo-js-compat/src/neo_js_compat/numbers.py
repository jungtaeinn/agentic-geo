"""JavaScript numeric compatibility helpers."""

import math
import re

from ._whitespace import ECMASCRIPT_TRIM

_SMALLEST_DOUBLE_WITHOUT_FRACTION = 2**52
_TO_FIXED_MAX_DIGITS = 100
_TO_FIXED_EXPONENTIAL_CUTOFF = 1e21
_JS_PARSE_FLOAT_PREFIX = re.compile(
    r"[+-]?(?:Infinity|(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)"
)


def js_round(value: float) -> float:
    """Return ``Math.round(value)`` while preserving JavaScript's ``-0``."""
    if not math.isfinite(value) or value == 0.0 or abs(value) >= _SMALLEST_DOUBLE_WITHOUT_FRACTION:
        return value

    lower = math.floor(value)
    rounded = lower if value - lower < 0.5 else lower + 1
    if rounded == 0 and value < 0.0:
        return -0.0
    return float(rounded)


def js_parse_float(value: str) -> float:
    """Return ``Number.parseFloat(value)`` for its valid numeric prefix."""
    start = 0
    while start < len(value) and value[start] in ECMASCRIPT_TRIM:
        start += 1

    match = _JS_PARSE_FLOAT_PREFIX.match(value, start)
    if match is None:
        return math.nan
    return float(match.group())


def js_to_fixed(value: int | float, digits: int) -> str:
    """Return ``Number.prototype.toFixed(digits)`` for a Python number.

    ``digits`` is limited to the ECMAScript range of zero through 100.
    """
    if not 0 <= digits <= _TO_FIXED_MAX_DIGITS:
        raise ValueError("digits must be between 0 and 100")

    try:
        number = float(value)
    except OverflowError:
        # JavaScript number coercion saturates unbounded Python integers.
        number = math.inf if value > 0 else -math.inf
    if not math.isfinite(number) or abs(number) >= _TO_FIXED_EXPONENTIAL_CUTOFF:
        return js_number_to_string(number)

    sign = "-" if number < 0 else ""
    numerator, denominator = abs(number).as_integer_ratio()
    scaled, remainder = divmod(numerator * 10**digits, denominator)
    if remainder * 2 >= denominator:
        scaled += 1

    rendered = str(scaled)
    if digits == 0:
        return sign + rendered
    padded = rendered.zfill(digits + 1)
    return sign + padded[:-digits] + "." + padded[-digits:]


def js_number_to_string(value: int | float) -> str:
    """Return the decimal spelling produced by JavaScript ``String(number)``.

    Python's shortest-double spelling uses a different fixed/scientific
    threshold (notably ``1e-06``).  RAG file names are template literals in
    the retained writers, so their version segment needs JavaScript's spelling
    rather than ``repr`` or ``str``.
    """

    number = float(value)
    if math.isnan(number):
        return "NaN"
    if math.isinf(number):
        return "Infinity" if number > 0 else "-Infinity"
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
        return sign + _fixed_number_notation(significand, exponent)
    return sign + _scientific_number_notation(significand, exponent)


def _fixed_number_notation(significand: str, exponent: int) -> str:
    whole, dot, fraction = significand.partition(".")
    digits = (whole + fraction).rstrip("0") if dot else whole
    decimal_position = len(whole) + exponent
    if decimal_position <= 0:
        return "0." + "0" * -decimal_position + digits
    if decimal_position >= len(digits):
        return digits + "0" * (decimal_position - len(digits))
    return digits[:decimal_position] + "." + digits[decimal_position:]


def _scientific_number_notation(significand: str, exponent: int) -> str:
    normalized = significand.rstrip("0").rstrip(".") if "." in significand else significand
    return f"{normalized}e{exponent:+d}"
