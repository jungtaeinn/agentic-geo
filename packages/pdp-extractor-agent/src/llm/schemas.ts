/**
 * JSON schemas shared by provider adapters to enforce structured model output.
 *
 * OpenAI Responses (`text.format`) and Azure/AIStudio chat completions
 * (`response_format`) use the strict draft schemas. Gemini uses the OpenAPI
 * subset variants because `generationConfig.responseSchema` does not accept
 * `additionalProperties`.
 */

const KEYWORD_CATEGORY_ENUM = [
  "benefit",
  "effect",
  "ingredient",
  "usage",
  "faq",
  "review",
  "product",
  "price",
  "metric",
  "unknown"
] as const;

/** Strict schema for vision OCR transcription responses. */
export const imageOcrJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    images: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          index: {
            type: "integer",
            description: "1-based number of the image as labeled in the prompt."
          },
          imageUrl: {
            type: "string",
            description: "Image URL exactly as labeled in the prompt."
          },
          text: {
            type: "string",
            description: "Faithful transcription of all visible text in reading order. Empty string when no readable product text."
          },
          confidence: {
            type: "number",
            description: "0-1 legibility/completeness confidence for this transcription."
          }
        },
        required: ["index", "imageUrl", "text", "confidence"]
      }
    }
  },
  required: ["images"]
} as const;

/** Strict schema for OCR keyword/sentence classification responses. */
export const keywordClassificationJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    keywords: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          keyword: { type: "string" },
          category: { type: "string", enum: [...KEYWORD_CATEGORY_ENUM] },
          confidence: { type: "number" }
        },
        required: ["keyword", "category", "confidence"]
      }
    },
    sentenceInsights: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string" },
          category: { type: "string", enum: [...KEYWORD_CATEGORY_ENUM] },
          keywords: { type: "array", items: { type: "string" } },
          confidence: { type: "number" }
        },
        required: ["text", "category", "keywords", "confidence"]
      }
    },
    semanticFacts: {
      type: "object",
      additionalProperties: false,
      properties: {
        ingredients: { type: "array", items: { type: "string" } },
        benefits: { type: "array", items: { type: "string" } },
        effects: { type: "array", items: { type: "string" } },
        skinTypes: { type: "array", items: { type: "string" } },
        usageSteps: { type: "array", items: { type: "string" } },
        metricClaims: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              label: { type: "string" },
              subject: { type: "string" },
              value: { type: "string" },
              unit: { type: "string" },
              timing: { type: "string" },
              period: { type: "string" },
              sample: { type: "string" },
              method: { type: "string" },
              caveat: { type: "string" },
              sentence: { type: "string" },
              sourceText: { type: "string" }
            },
            required: ["label", "subject", "value", "unit", "timing", "period", "sample", "method", "caveat", "sentence", "sourceText"]
          }
        },
        evidenceSentences: { type: "array", items: { type: "string" } },
        ingredientBenefitLinks: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              ingredient: { type: "string" },
              benefit: { type: "string" },
              effect: { type: "string" },
              sentence: { type: "string" },
              sourceText: { type: "string" }
            },
            required: ["ingredient", "benefit", "effect", "sentence", "sourceText"]
          }
        }
      },
      required: ["ingredients", "benefits", "effects", "skinTypes", "usageSteps", "metricClaims", "evidenceSentences", "ingredientBenefitLinks"]
    },
    summary: { type: "string" }
  },
  required: ["keywords", "sentenceInsights", "semanticFacts", "summary"]
} as const;

/** OpenAI Responses `text.format` payload for image OCR. */
export const openAiImageOcrTextFormat = {
  format: {
    type: "json_schema",
    name: "pdp_image_ocr",
    strict: true,
    schema: imageOcrJsonSchema
  }
} as const;

/** OpenAI Responses `text.format` payload for keyword classification. */
export const openAiKeywordClassificationTextFormat = {
  format: {
    type: "json_schema",
    name: "pdp_keyword_classification",
    strict: true,
    schema: keywordClassificationJsonSchema
  }
} as const;

/** Chat-completions `response_format` payload for image OCR. */
export const chatCompletionsImageOcrResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "pdp_image_ocr",
    strict: true,
    schema: imageOcrJsonSchema
  }
} as const;

/** Chat-completions `response_format` payload for keyword classification. */
export const chatCompletionsKeywordClassificationResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "pdp_keyword_classification",
    strict: true,
    schema: keywordClassificationJsonSchema
  }
} as const;

type GeminiSchema = Record<string, unknown>;

/** Converts a strict draft schema into the Gemini responseSchema OpenAPI subset. */
function toGeminiSchema(schema: unknown): GeminiSchema {
  if (Array.isArray(schema)) {
    return schema.map(toGeminiSchema) as unknown as GeminiSchema;
  }
  if (typeof schema !== "object" || schema === null) {
    return schema as GeminiSchema;
  }

  const source = schema as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    if (key === "additionalProperties" || key === "description") {
      continue;
    }
    if (key === "type" && typeof value === "string") {
      result.type = value.toUpperCase();
      continue;
    }
    if (key === "properties" && typeof value === "object" && value !== null) {
      result.properties = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([name, child]) => [name, toGeminiSchema(child)])
      );
      continue;
    }
    if (key === "items") {
      result.items = toGeminiSchema(value);
      continue;
    }
    result[key] = value;
  }

  return result;
}

/** Gemini responseSchema for image OCR. */
export const geminiImageOcrResponseSchema = toGeminiSchema(imageOcrJsonSchema);

/** Gemini responseSchema for keyword classification. */
export const geminiKeywordClassificationResponseSchema = toGeminiSchema(keywordClassificationJsonSchema);
