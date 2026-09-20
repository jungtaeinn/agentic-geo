"""Behavioral port of suite-level image-attribution label tests."""

from __future__ import annotations

import importlib

import pytest


def _suite():
    return importlib.import_module("pdp_geo_eval_agent.quality.suite")


@pytest.mark.parametrize("language", ["ko", "en"])
def test_localizes_image_other_sentinel_instead_of_leaking_raw_id(language: str) -> None:
    suite_module = _suite()
    suite = suite_module.get_evaluation_suite_copy(language)
    assert suite_module.format_image_section_id("other", suite) == suite.image_other_label
    assert suite_module.format_image_section_id("other", suite) != "other"


def test_formats_real_image_id_as_url_basename_without_query_string() -> None:
    suite_module = _suite()
    suite = suite_module.get_evaluation_suite_copy("ko")
    assert suite_module.format_image_section_id("https://cdn.example.com/products/abc/detail-01.jpg?v=2", suite) == "detail-01.jpg"


def test_truncate_quote_counts_astral_characters_as_javascript_utf16_units() -> None:
    suite_module = _suite()

    assert suite_module.truncate_quote("a" * 109 + "😀", 110) == "a" * 109 + "…"
