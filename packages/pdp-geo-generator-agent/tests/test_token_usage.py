"""Token-accounting contracts shared by generator model stages."""

from __future__ import annotations

from pdp_geo_generator_agent.token_usage import merge_token_usage, normalize_token_usage


def test_token_usage_preserves_reported_zero_without_inventing_absent_fields() -> None:
    assert normalize_token_usage({"inputTokens": 0}) == {"inputTokens": 0}
    assert normalize_token_usage({}) is None

    merged = merge_token_usage({"inputTokens": 3}, {"outputTokens": 5}, {"inputTokens": 0})

    assert merged is not None
    assert merged == {"inputTokens": 3, "outputTokens": 5}
    assert "totalTokens" not in merged


def test_token_usage_accepts_legacy_names_but_returns_canonical_wire_keys() -> None:
    assert merge_token_usage(
        {"promptTokens": 2, "completionTokens": 4}, {"input_tokens": 3, "total_tokens": 9}
    ) == {"inputTokens": 5, "outputTokens": 4, "totalTokens": 9}
