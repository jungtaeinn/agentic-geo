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

const OCR_LAYOUT_LINE_ROLE_ENUM = ["title", "body", "label", "value", "footnote"] as const;

/**
 * 레이아웃 관계 스키마. 중첩 대신 `parentId`로 평면을 유지하고, 선택 필드는
 * nullable 합집합으로 표현한다 — strict 모드는 모든 속성을 `required`에 요구하므로
 * "없음"을 표현할 다른 방법이 없다.
 */
const ocrLayoutGroupsSchema = {
  type: "array",
  description: "Layout relations visible in the image: groups of lines. No template is assumed.",
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: {
        type: "string",
        description: "Short id unique within this image, e.g. g1."
      },
      parentId: {
        type: ["string", "null"],
        description: "Id of the enclosing group, or null at top level."
      },
      title: {
        type: ["string", "null"],
        description: "The group's own heading text when the layout sets one apart, or null."
      },
      ordinal: {
        type: ["integer", "null"],
        description: "Number the layout actually printed for this group, or null. Never number groups yourself."
      },
      annotates: {
        type: ["string", "null"],
        description: "For a footnote, disclaimer, or test-condition group, the id of the group it qualifies. Otherwise null."
      },
      lines: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string" },
            role: {
              type: "string",
              enum: [...OCR_LAYOUT_LINE_ROLE_ENUM],
              description: "Layout function of the line, not its meaning: title, body, label (axis tick, legend name, caption, package spec), value (a measured number or badge), footnote."
            },
            pairedLabel: {
              type: ["string", "null"],
              description: "For a value line, the label it is printed against (its bar's tick, its badge caption). null when the layout does not pair it."
            }
          },
          required: ["text", "role", "pairedLabel"]
        }
      }
    },
    required: ["id", "parentId", "title", "ordinal", "annotates", "lines"]
  }
} as const;

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
          },
          groups: ocrLayoutGroupsSchema
        },
        required: ["index", "imageUrl", "text", "confidence", "groups"]
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
          confidence: { type: "number" },
          evidenceIndex: {
            type: "integer",
            description: "1-based Evidence number in this request that this insight was derived from. 0 when unknown."
          }
        },
        required: ["text", "category", "keywords", "confidence", "evidenceIndex"]
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
              sourceText: { type: "string" },
              evidenceIndex: {
                type: "integer",
                description: "1-based Evidence number in this request that this claim was derived from. 0 when unknown."
              }
            },
            required: ["label", "subject", "value", "unit", "timing", "period", "sample", "method", "caveat", "sentence", "sourceText", "evidenceIndex"]
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
              sourceText: { type: "string" },
              evidenceIndex: {
                type: "integer",
                description: "1-based Evidence number in this request that this link was derived from. 0 when unknown."
              }
            },
            required: ["ingredient", "benefit", "effect", "sentence", "sourceText", "evidenceIndex"]
          }
        },
        citations: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              type: { type: "string", enum: ["research", "article"] },
              title: { type: "string" },
              publisher: { type: "string" },
              author: { type: "string" },
              publishedAt: { type: "string" },
              url: { type: "string" },
              finding: { type: "string" },
              sourceText: { type: "string" },
              evidenceIndex: {
                type: "integer",
                description: "1-based Evidence number in this request that this citation was derived from. 0 when unknown."
              }
            },
            required: ["type", "title", "publisher", "author", "publishedAt", "url", "finding", "sourceText", "evidenceIndex"]
          }
        }
      },
      required: ["ingredients", "benefits", "effects", "skinTypes", "usageSteps", "metricClaims", "evidenceSentences", "ingredientBenefitLinks", "citations"]
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
    // Gemini OpenAPI 서브셋은 type 배열을 받지 않는다. strict 스키마가 "없음"을
    // 표현하려고 쓴 nullable 합집합을 이 방언의 nullable 표기로 옮긴다.
    if (key === "type" && Array.isArray(value)) {
      const concrete = value.find((item): item is string => typeof item === "string" && item !== "null");
      if (concrete) {
        result.type = concrete.toUpperCase();
      }
      if (value.includes("null")) {
        result.nullable = true;
      }
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
