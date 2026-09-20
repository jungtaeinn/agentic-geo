"""Copy-on-write removal of markup noise before prompt construction."""

from __future__ import annotations

import re
from typing import Any

from neo_agent_api._json import as_dict, as_list

_NOISE = (
    re.compile(r"<style\b[^>]*>[\s\S]*?</style\s*>", re.IGNORECASE),
    re.compile(r"<script\b[^>]*>[\s\S]*?</script\s*>", re.IGNORECASE),
    re.compile(r"<!--[\s\S]*?-->"),
)


def strip_markup_noise(value: str) -> str:
    for pattern in _NOISE:
        value = pattern.sub("", value)
    return value


def sanitize_product_html(product: object) -> Any:
    if isinstance(product, str):
        return strip_markup_noise(product)
    if isinstance(product, list):
        return [sanitize_product_html(item) for item in as_list(product)]
    if isinstance(product, dict):
        return {key: sanitize_product_html(value) for key, value in as_dict(product).items()}
    return product
