"""Detect machine-serialized metadata accidentally emitted as public prose."""

from __future__ import annotations

import re

_WHITESPACE = re.compile(r"\s+")
_KEY_VALUE = re.compile(r"(?<![A-Za-z0-9_])[A-Za-z0-9_-]+(?:[._][A-Za-z0-9_-]+)+\s*:")
_ORPHAN_COLON = re.compile(r"(?:^|\s):")
_DOUBLE_COLON = re.compile(r":\s*:")
_PIPE_CHAIN = re.compile(r"\s\|\s")
_ARTIFACT_PATTERNS = (
    re.compile(r"(?<![A-Za-z0-9_])[A-Za-z0-9_-]+(?:[._][A-Za-z0-9_-]+)+\s*:\s*\S{0,24}"),
    re.compile(r"(?:^|\s)(:{1,2}\s*\S{1,24})"),
    re.compile(r"\S{1,24}\s*:\s*:\s*\S{0,24}"),
    re.compile(r"\S[^|\n]{0,32}\s\|\s[^|\n]{0,48}"),
)


def contains_serialized_metadata(value: str) -> bool:
    """Identify structural metadata shapes while leaving ordinary URLs alone."""
    text = _WHITESPACE.sub(" ", value).strip()
    return bool(_KEY_VALUE.search(text) or _ORPHAN_COLON.search(text) or _DOUBLE_COLON.search(text) or _PIPE_CHAIN.search(text))


def find_serialized_metadata_artifact(text: str) -> str | None:
    """Return the first short metadata-shaped excerpt, if any."""
    normalized = _WHITESPACE.sub(" ", text).strip()
    for pattern in _ARTIFACT_PATTERNS:
        match = pattern.search(normalized)
        if match:
            return (match.group(1) if match.lastindex else match.group(0)).strip()[:60]
    return None
