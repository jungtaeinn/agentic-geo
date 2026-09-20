"""Prompt for the optional LLM concept-embodiment assessment."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import TypedDict, cast

from ..quality.internal import find_schema_node, get_record_string, get_schema_graph


class _PublicSections(TypedDict):
    product_description: str
    web_page_description: str
    faq: list[dict[str, str]]
    how_to_steps: list[dict[str, str]]
    additional_properties: list[dict[str, str]]


def build_concept_embodiment_prompt(input: Mapping[str, object], language: str) -> dict[str, str]:
    """Build the strict system/user pair used by the independent concept judge."""
    sections = _extract_public_sections(input.get("jsonLd"))
    diagnostics = _mapping(input.get("diagnostics"))
    source_signals = _summarize_source_signals(diagnostics)
    language_label = "Korean" if language == "ko" else "English"
    system = f'''You are a strict content auditor for e-commerce product pages. Your job is to judge whether three optimization CONCEPTS are actually embodied in the given public copy — not whether the copy merely exists, and not whether the underlying source data happens to be rich. Score each concept independently, 0-100.

1. GEO concept = self-contained answer coverage. A generative search engine, using ONLY this copy, must be able to answer each of: what the product is; who it is for; how to use it; which key ingredients/technology drive it; what real users experienced. Each answer must exist as one citable, self-contained sentence — not scattered fragments requiring outside inference.

2. CEP concept = closed causal purchase path. The copy must connect, in order: the customer's entry situation -> their need -> how the product's composition addresses it -> the resulting outcome -> why this makes the product the right fit. Ingredients and benefits merely listed side by side, with no causal link between them, do NOT satisfy this concept even when both are present.

3. EEAT concept = four elements, judged independently:
   - Experience: a first-person or attributed account of real usage, not just a benefit claim.
   - Expertise: ingredients/technology explained by FUNCTION (why it works), not just named.
   - Authoritativeness: consistent brand/product identity and terminology, no internal contradictions.
   - Trust: any numeric claim carries its sample size, time period, and measurement method, without overstated wording.

FAIRNESS RULES — you must follow these:
- Judge only whether each concept is embodied IN THE GIVEN COPY. Never penalize the copy for a source signal that was absent to begin with (see "Source signals" in the user message) — if the source has no review data, the absence of an attributed usage account is expected, not a defect.
- Never propose an improvement that would add information not present in the source. Every improvement must be phrased as surfacing, connecting, or restructuring EXISTING content ("surface the existing X", "connect Y to Z"), never "add W".
- Every "missing" entry must point to a concrete source signal that WAS available (per the source-signal summary) but did not make it into the copy. If a concept element has no supporting source signal at all, do not list it as missing.
- Every "embodied"/"missing" entry must quote or closely paraphrase the specific wording it refers to.

Respond with strict JSON only, no prose outside the JSON object, in exactly this shape:
{{
  "dimensions": {{
    "geo": {{ "score": 0-100, "embodied": string[], "missing": string[], "improvements": string[] }},
    "cep": {{ "score": 0-100, "embodied": string[], "missing": string[], "improvements": string[] }},
    "eeat": {{ "score": 0-100, "embodied": string[], "missing": string[], "improvements": string[] }}
  }},
  "summary": string
}}
Write every string value in {language_label}.'''
    faq_text = "\n".join(f"{index + 1}. Q: {item['question']}\n   A: {item['answer']}" for index, item in enumerate(sections["faq"])) or "(none)"
    how_to_text = "\n".join(f"{index + 1}. {f'{item['name']}: ' if item['name'] else ''}{item['text']}" for index, item in enumerate(sections["how_to_steps"])) or "(none)"
    properties_text = "\n".join(f"- {item['name']}: {item['value']}" for item in sections["additional_properties"]) or "(none)"
    user = f'''Public copy to judge:

### Product description
{sections["product_description"] or "(none)"}

### WebPage description
{sections["web_page_description"] or "(none)"}

### FAQ
{faq_text}

### How-to steps
{how_to_text}

### Additional properties
{properties_text}

---
Source signals (for fairness only — never penalize the absence of a signal below, and never invent content beyond what these imply):
{json.dumps(source_signals, ensure_ascii=False, indent=2)}

Return the JSON object and nothing else.'''
    return {"system": system, "user": user}


def _extract_public_sections(json_ld: object) -> _PublicSections:
    graph = get_schema_graph(json_ld)
    product = find_schema_node(graph, "Product")
    web_page = find_schema_node(graph, "WebPage")
    faq = find_schema_node(graph, "FAQPage")
    how_to = find_schema_node(graph, "HowTo")
    return {
        "product_description": get_record_string(product, "description").strip(),
        "web_page_description": get_record_string(web_page, "description").strip(),
        "faq": _extract_faq_pairs(faq),
        "how_to_steps": _extract_how_to_steps(how_to),
        "additional_properties": _extract_additional_properties(product),
    }


def _extract_faq_pairs(faq: Mapping[str, object] | None) -> list[dict[str, str]]:
    entities = faq.get("mainEntity") if faq else None
    result: list[dict[str, str]] = []
    for entity in _list(entities):
        record = _mapping(entity)
        if not record:
            continue
        question = get_record_string(record, "name").strip()
        answer = record.get("acceptedAnswer")
        answer_text = get_record_string(answer, "text").strip()
        if question and answer_text:
            result.append({"question": question, "answer": answer_text})
    return result


def _extract_how_to_steps(how_to: Mapping[str, object] | None) -> list[dict[str, str]]:
    steps = how_to.get("step") if how_to else None
    result: list[dict[str, str]] = []
    for step in _list(steps):
        record = _mapping(step)
        if not record:
            continue
        text = get_record_string(record, "text").strip()
        if text:
            result.append({"name": get_record_string(record, "name").strip(), "text": text})
    return result


def _extract_additional_properties(product: Mapping[str, object] | None) -> list[dict[str, str]]:
    raw = product.get("additionalProperty") if product else None
    values = list(cast(list[object], raw)) if isinstance(raw, list) else [raw] if raw else []
    result: list[dict[str, str]] = []
    for entry in values:
        record = _mapping(entry)
        if not record:
            continue
        name = get_record_string(record, "name").strip()
        raw_value = record.get("value")
        value = raw_value.strip() if isinstance(raw_value, str) else str(raw_value) if isinstance(raw_value, (int, float)) and not isinstance(raw_value, bool) else ""
        if name and value:
            result.append({"name": name, "value": value})
    return result


def _summarize_source_signals(diagnostics: Mapping[str, object]) -> dict[str, bool | int]:
    product = _mapping(diagnostics.get("normalizedProduct"))
    reviews = _mapping(product.get("reviews"))
    return {
        "hasReviewSignal": bool(_list(reviews.get("keywords"))),
        "sourceIngredientCount": len(_list(product.get("ingredients"))),
        "sourceUsageStepCount": len(_list(product.get("usage"))),
        "sourceBenefitCount": len(_list(product.get("benefits"))) + len(_list(product.get("effects"))),
        "sourceFaqCount": len(_list(product.get("faq"))),
    }


def _mapping(value: object) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        return {}
    return {str(key): item for key, item in cast(Mapping[object, object], value).items()}


def _list(value: object) -> list[object]:
    return list(cast(list[object], value)) if isinstance(value, list) else []
