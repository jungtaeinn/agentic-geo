"""Provider-neutral strict JSON schemas and provider dialect projections.

The dictionaries deliberately remain JSON-shaped rather than becoming Pydantic
models: OpenAI/Azure and Gemini each require a different schema dialect on the
wire, and consumers need to inspect the frozen payloads directly.
"""

from __future__ import annotations

from typing import Any

from ._json_types import as_list, as_mapping
from .ocr.layout import IMAGE_OCR_JSON_SCHEMA as _image_ocr_json_schema

KEYWORD_CATEGORY_ENUM = [
    "benefit",
    "effect",
    "ingredient",
    "usage",
    "faq",
    "review",
    "product",
    "price",
    "metric",
    "unknown",
]

# The strict image schema lives with the OCR parser so both provider payload
# parsing and schema construction share the same five layout roles.
IMAGE_OCR_JSON_SCHEMA = _image_ocr_json_schema


def _array(items: dict[str, Any]) -> dict[str, Any]:
    return {"type": "array", "items": items}


def _strict_object(properties: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": properties,
        "required": list(properties),
    }


_KEYWORD = _strict_object(
    {
        "keyword": {"type": "string"},
        "category": {"type": "string", "enum": KEYWORD_CATEGORY_ENUM},
        "confidence": {"type": "number"},
    }
)
_SENTENCE_INSIGHT = _strict_object(
    {
        "text": {"type": "string"},
        "category": {"type": "string", "enum": KEYWORD_CATEGORY_ENUM},
        "keywords": _array({"type": "string"}),
        "confidence": {"type": "number"},
        "evidenceIndex": {
            "type": "integer",
            "description": "1-based Evidence number in this request that this insight was derived from. 0 when unknown.",
        },
    }
)
_METRIC_CLAIM = _strict_object(
    {
        "label": {"type": "string"},
        "subject": {"type": "string"},
        "value": {"type": "string"},
        "unit": {"type": "string"},
        "timing": {"type": "string"},
        "period": {"type": "string"},
        "sample": {"type": "string"},
        "method": {"type": "string"},
        "caveat": {"type": "string"},
        "sentence": {"type": "string"},
        "sourceText": {"type": "string"},
        "evidenceIndex": {
            "type": "integer",
            "description": "1-based Evidence number in this request that this claim was derived from. 0 when unknown.",
        },
    }
)
_INGREDIENT_BENEFIT_LINK = _strict_object(
    {
        "ingredient": {"type": "string"},
        "benefit": {"type": "string"},
        "effect": {"type": "string"},
        "sentence": {"type": "string"},
        "sourceText": {"type": "string"},
        "evidenceIndex": {
            "type": "integer",
            "description": "1-based Evidence number in this request that this link was derived from. 0 when unknown.",
        },
    }
)
_CITATION = _strict_object(
    {
        "type": {"type": "string", "enum": ["research", "article"]},
        "title": {"type": "string"},
        "publisher": {"type": "string"},
        "author": {"type": "string"},
        "publishedAt": {"type": "string"},
        "url": {"type": "string"},
        "finding": {"type": "string"},
        "sourceText": {"type": "string"},
        "evidenceIndex": {
            "type": "integer",
            "description": "1-based Evidence number in this request that this citation was derived from. 0 when unknown.",
        },
    }
)

KEYWORD_CLASSIFICATION_JSON_SCHEMA: dict[str, Any] = _strict_object(
    {
        "keywords": _array(_KEYWORD),
        "sentenceInsights": _array(_SENTENCE_INSIGHT),
        "semanticFacts": _strict_object(
            {
                "ingredients": _array({"type": "string"}),
                "benefits": _array({"type": "string"}),
                "effects": _array({"type": "string"}),
                "skinTypes": _array({"type": "string"}),
                "usageSteps": _array({"type": "string"}),
                "safetyTests": _array({"type": "string"}),
                "metricClaims": _array(_METRIC_CLAIM),
                "evidenceSentences": _array({"type": "string"}),
                "ingredientBenefitLinks": _array(_INGREDIENT_BENEFIT_LINK),
                "citations": _array(_CITATION),
            }
        ),
        "summary": {"type": "string"},
    }
)


def to_gemini_schema(schema: object) -> Any:
    """Project strict JSON Schema into Gemini's OpenAPI-like subset."""

    items = as_list(schema)
    if items is not None:
        return [to_gemini_schema(item) for item in items]
    mapping = as_mapping(schema)
    if mapping is None:
        return schema
    result: dict[str, Any] = {}
    for key, value in mapping.items():
        if key in {"additionalProperties", "description"}:
            continue
        if key == "type" and isinstance(value, str):
            result[key] = value.upper()
            continue
        value_items = as_list(value)
        if key == "type" and value_items is not None:
            concrete = next((item for item in value_items if isinstance(item, str) and item != "null"), None)
            if concrete:
                result[key] = concrete.upper()
            if "null" in value_items:
                result["nullable"] = True
            continue
        properties = as_mapping(value)
        if key == "properties" and properties is not None:
            result[key] = {name: to_gemini_schema(child) for name, child in properties.items()}
            continue
        if key == "items":
            result[key] = to_gemini_schema(value)
            continue
        result[key] = to_gemini_schema(value)
    return result


GEMINI_IMAGE_OCR_RESPONSE_SCHEMA: dict[str, Any] = to_gemini_schema(IMAGE_OCR_JSON_SCHEMA)
GEMINI_KEYWORD_CLASSIFICATION_RESPONSE_SCHEMA: dict[str, Any] = to_gemini_schema(KEYWORD_CLASSIFICATION_JSON_SCHEMA)

OPENAI_IMAGE_OCR_TEXT_FORMAT = {
    "format": {"type": "json_schema", "name": "pdp_image_ocr", "strict": True, "schema": IMAGE_OCR_JSON_SCHEMA}
}
OPENAI_KEYWORD_CLASSIFICATION_TEXT_FORMAT = {
    "format": {
        "type": "json_schema",
        "name": "pdp_keyword_classification",
        "strict": True,
        "schema": KEYWORD_CLASSIFICATION_JSON_SCHEMA,
    }
}
CHAT_COMPLETIONS_IMAGE_OCR_RESPONSE_FORMAT = {
    "type": "json_schema",
    "json_schema": {"name": "pdp_image_ocr", "strict": True, "schema": IMAGE_OCR_JSON_SCHEMA},
}
CHAT_COMPLETIONS_KEYWORD_CLASSIFICATION_RESPONSE_FORMAT = {
    "type": "json_schema",
    "json_schema": {"name": "pdp_keyword_classification", "strict": True, "schema": KEYWORD_CLASSIFICATION_JSON_SCHEMA},
}

# Existing JavaScript consumers use these exact spellings. Keeping aliases is
# cheap and avoids forcing Tasks 5/6 to translate shared configuration names.
imageOcrJsonSchema = IMAGE_OCR_JSON_SCHEMA
keywordClassificationJsonSchema = KEYWORD_CLASSIFICATION_JSON_SCHEMA
geminiImageOcrResponseSchema = GEMINI_IMAGE_OCR_RESPONSE_SCHEMA
geminiKeywordClassificationResponseSchema = GEMINI_KEYWORD_CLASSIFICATION_RESPONSE_SCHEMA
openAiImageOcrTextFormat = OPENAI_IMAGE_OCR_TEXT_FORMAT
openAiKeywordClassificationTextFormat = OPENAI_KEYWORD_CLASSIFICATION_TEXT_FORMAT
chatCompletionsImageOcrResponseFormat = CHAT_COMPLETIONS_IMAGE_OCR_RESPONSE_FORMAT
chatCompletionsKeywordClassificationResponseFormat = CHAT_COMPLETIONS_KEYWORD_CLASSIFICATION_RESPONSE_FORMAT
toGeminiSchema = to_gemini_schema
