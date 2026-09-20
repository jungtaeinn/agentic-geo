"""Counterfactual vanilla PDP source-text builder."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import cast


def build_vanilla_source_text(product: object) -> str:
    """Flatten normalized product signals in the legacy raw-PDP order."""
    lines: list[str] = []
    brand = _field(product, "brand")
    name = _field(product, "name")
    identity = " ".join(part for part in (brand, name) if isinstance(part, str) and part)
    lines.append(identity)
    category = _field(product, "category")
    if isinstance(category, str) and category:
        lines.append(f"Category: {category}")
    source_texts = _string_list(_field(product, "sourceTexts", "source_texts"))
    if source_texts:
        lines.extend(source_texts)
    benefits = _string_list(_field(product, "benefits"))
    if benefits:
        lines.append(f"Benefits: {', '.join(benefits)}")
    effects = _string_list(_field(product, "effects"))
    if effects:
        lines.append(f"Effects: {', '.join(effects)}")
    ingredients = _string_list(_field(product, "ingredients"))
    if ingredients:
        lines.append(f"Key ingredients: {', '.join(ingredients)}")
    usage = _string_list(_field(product, "usage"))
    if usage:
        lines.append(f"How to use: {' '.join(usage)}")
    faq = _field(product, "faq")
    if _sequence(faq):
        for item in _sequence(faq):
            question = _field(item, "question")
            answer = _field(item, "answer")
            lines.append(f"Q: {question} A: {answer}")
    reviews = _field(product, "reviews")
    keywords = _string_list(_field(reviews, "keywords")) if reviews is not None else []
    if keywords:
        lines.append(f"Review keywords: {', '.join(keywords)}")
    return "\n".join(line for line in lines if line.strip())


def _string_list(value: object) -> list[str]:
    return [item for item in _sequence(value) if isinstance(item, str)]


def _field(value: object, *names: str) -> object:
    for name in names:
        if isinstance(value, Mapping) and name in cast(Mapping[str, object], value):
            return cast(Mapping[str, object], value)[name]
        if not isinstance(value, Mapping) and hasattr(value, name):
            return cast(object, getattr(value, name))
    return None


def _sequence(value: object) -> list[object]:
    if not isinstance(value, Sequence) or isinstance(value, str):
        return []
    return list(cast(Sequence[object], value))
