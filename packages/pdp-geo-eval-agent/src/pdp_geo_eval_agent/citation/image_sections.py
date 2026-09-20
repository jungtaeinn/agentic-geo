"""Image-lineage citation attribution sections."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import cast

from ..models import AttributableSection


def build_image_attributable_sections(entries: Sequence[object]) -> list[AttributableSection]:
    """Group published sentences by image URL in first-seen order.

    Sentence-level provenance wins over entry-level provenance exactly as in
    the TypeScript evaluator.  An entry without image lineage intentionally
    contributes no section.
    """
    sentences_by_image: dict[str, list[str]] = {}

    def add(image_urls: object, text: object) -> None:
        trimmed = text.strip() if isinstance(text, str) else ""
        if not trimmed or not isinstance(image_urls, Sequence) or isinstance(image_urls, str):
            return
        for raw_url in cast(Sequence[object], image_urls):
            if not isinstance(raw_url, str) or not raw_url.strip():
                continue
            bucket = sentences_by_image.setdefault(raw_url, [])
            if trimmed not in bucket:
                bucket.append(trimmed)

    for entry in entries:
        sentences = _field(entry, "sentences")
        sentence_entries = _sequence(sentences)
        sentences_with_images = [
            sentence
            for sentence in sentence_entries
            if _nonempty_image_urls(_field(sentence, "imageUrls", "image_urls"))
        ]
        if sentences_with_images:
            for sentence in sentences_with_images:
                add(_field(sentence, "imageUrls", "image_urls"), _field(sentence, "text"))
            continue
        add(_field(entry, "imageUrls", "image_urls"), _field(entry, "text"))

    return [AttributableSection(id=image_url, text="\n".join(texts)) for image_url, texts in sentences_by_image.items()]


def _nonempty_image_urls(value: object) -> bool:
    return bool(_sequence(value))


def _field(value: object, *names: str) -> object:
    for name in names:
        if isinstance(value, Mapping):
            record = cast(Mapping[str, object], value)
            if name in record:
                return record[name]
        elif hasattr(value, name):
            return cast(object, getattr(value, name))
    return None


def _sequence(value: object) -> list[object]:
    if not isinstance(value, Sequence) or isinstance(value, str):
        return []
    return list(cast(Sequence[object], value))
