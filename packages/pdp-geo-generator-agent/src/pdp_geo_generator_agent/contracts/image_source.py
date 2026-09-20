"""Image-source eligibility shared by intake and schema validation."""

from __future__ import annotations

import re


def is_publishable_image_url(url: str) -> bool:
    return bool(re.fullmatch(r"https?://\S+", url, re.IGNORECASE)) and not bool(re.search(r"[.,;:]$", url))


# Stable camel-case alias for callers ported mechanically from the JS API.
isPublishableImageUrl = is_publishable_image_url
