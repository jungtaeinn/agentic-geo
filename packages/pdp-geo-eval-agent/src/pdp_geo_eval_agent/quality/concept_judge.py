"""Strict parser and opt-in orchestration for concept embodiment judging."""

from __future__ import annotations

import inspect
import json
import math
import re
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import cast

from neo_js_compat import js_round

from ..prompts.concept_embodiment import build_concept_embodiment_prompt


@dataclass(slots=True)
class ConceptEmbodimentDimension:
    id: str
    score: int
    embodied: list[str]
    missing: list[str]
    improvements: list[str]

    def to_wire(self) -> dict[str, object]:
        return {"id": self.id, "score": self.score, "embodied": self.embodied, "missing": self.missing, "improvements": self.improvements}


@dataclass(slots=True)
class ConceptEmbodimentAssessment:
    overall_score: int
    dimensions: list[ConceptEmbodimentDimension]
    summary: str

    def to_wire(self) -> dict[str, object]:
        return {"overallScore": self.overall_score, "dimensions": [dimension.to_wire() for dimension in self.dimensions], "summary": self.summary}


_DIMENSION_IDS = ("geo", "cep", "eeat")
Completion = Callable[[Mapping[str, object], str, str], Awaitable[str] | str]


def parse_concept_embodiment_response(raw: str) -> ConceptEmbodimentAssessment:
    parsed = _parse_json_object(raw)
    dimensions_raw = parsed.get("dimensions")
    if not isinstance(dimensions_raw, Mapping):
        raise ValueError('Concept embodiment response has no "dimensions" object.')
    dimensions = [_parse_dimension(identifier, _record(cast(object, dimensions_raw)).get(identifier)) for identifier in _DIMENSION_IDS]
    summary = parsed.get("summary")
    if not isinstance(summary, str) or not summary.strip():
        raise ValueError('Concept embodiment response has no "summary" text.')
    return ConceptEmbodimentAssessment(
        overall_score=int(js_round(sum(dimension.score for dimension in dimensions) / len(dimensions))),
        dimensions=dimensions,
        summary=summary.strip(),
    )


async def judge_concept_embodiment(
    input: Mapping[str, object],
    config: Mapping[str, object],
    language: str,
    complete: Completion | None = None,
) -> ConceptEmbodimentAssessment:
    """Ask the injected/shared provider then strictly parse its assessment."""
    prompt = build_concept_embodiment_prompt(input, language)
    if complete is None:
        from ..citation.engine import complete_with_provider

        complete = complete_with_provider
    raw = complete(config, prompt["system"], prompt["user"])
    if inspect.isawaitable(raw):
        raw = await raw
    return parse_concept_embodiment_response(raw)


def _parse_dimension(identifier: str, raw: object) -> ConceptEmbodimentDimension:
    if not isinstance(raw, Mapping):
        raise ValueError(f'Concept embodiment response is missing the "{identifier}" dimension.')
    record = _record(cast(object, raw))
    score = record.get("score")
    if isinstance(score, bool) or not isinstance(score, (int, float)) or not math.isfinite(score) or score < 0 or score > 100:
        raise ValueError(f'Concept embodiment response has an out-of-range score for "{identifier}": {score}')
    return ConceptEmbodimentDimension(
        id=identifier,
        score=int(js_round(score)),
        embodied=_parse_string_array(record.get("embodied"), identifier, "embodied"),
        missing=_parse_string_array(record.get("missing"), identifier, "missing"),
        improvements=_parse_string_array(record.get("improvements"), identifier, "improvements"),
    )


def _parse_string_array(value: object, identifier: str, field: str) -> list[str]:
    if not isinstance(value, list):
        raise ValueError(f'Concept embodiment response has a non-array "{field}" for "{identifier}".')
    return [item.strip() for item in cast(list[object], value) if isinstance(item, str) and item.strip()]


def _parse_json_object(raw: str) -> dict[str, object]:
    text = re.sub(r"^```(?:json)?\s*", "", raw.strip(), flags=re.I)
    text = re.sub(r"```\s*$", "", text)
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end < start:
        raise ValueError("Concept embodiment judge response contains no JSON object.")
    parsed = json.loads(text[start : end + 1])
    if not isinstance(parsed, dict):
        raise ValueError("Concept embodiment judge response is not a JSON object.")
    return _record(cast(object, parsed))


def _record(value: object) -> dict[str, object]:
    if not isinstance(value, Mapping):
        return {}
    return {str(key): item for key, item in cast(Mapping[object, object], value).items()}
