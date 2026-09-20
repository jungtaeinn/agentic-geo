"""Provider-neutral token accounting with JavaScript-compatible missing-field semantics."""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence

from ._json import as_dict

type TokenNumber = int | float
TokenUsage = dict[str, TokenNumber]

_TOKEN_ALIASES: dict[str, tuple[str, ...]] = {
    "inputTokens": ("inputTokens", "promptTokens", "input_tokens", "prompt_tokens"),
    "outputTokens": ("outputTokens", "completionTokens", "output_tokens", "completion_tokens"),
    "totalTokens": ("totalTokens", "total_tokens"),
}


def normalize_token_usage(value: object) -> TokenUsage | None:
    """Return canonical wire keys without turning an unreported field into zero."""

    data = as_dict(value)
    if not data:
        return None
    result: TokenUsage = {}
    for canonical, aliases in _TOKEN_ALIASES.items():
        number = _first_reported_number(data, aliases)
        if number is not None:
            result[canonical] = number
    return result or None


def merge_token_usage(*values: object) -> TokenUsage | None:
    """Sum reported fields while preserving absence as absence and reported zero as zero."""

    rows = [row for value in values if (row := normalize_token_usage(value)) is not None]
    if not rows:
        return None
    result: TokenUsage = {}
    for key in _TOKEN_ALIASES:
        reported = [row[key] for row in rows if key in row]
        if reported:
            result[key] = sum(reported)
    return result or None


def merge_token_usages(values: Sequence[object]) -> TokenUsage | None:
    return merge_token_usage(*values)


def _first_reported_number(data: Mapping[str, object], aliases: Sequence[str]) -> TokenNumber | None:
    for key in aliases:
        if key not in data:
            continue
        value = data[key]
        if isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value):
            return value
    return None


normalizeTokenUsage = normalize_token_usage
mergeTokenUsage = merge_token_usage
mergeTokenUsages = merge_token_usages

__all__ = [
    "TokenUsage",
    "merge_token_usage",
    "merge_token_usages",
    "mergeTokenUsage",
    "mergeTokenUsages",
    "normalize_token_usage",
    "normalizeTokenUsage",
]
