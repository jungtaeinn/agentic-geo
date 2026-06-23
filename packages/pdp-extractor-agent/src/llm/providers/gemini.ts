import { createKeywordClassificationPromptParts } from "../prompt";
import type {
  KeywordClassificationRequest,
  KeywordClassificationResponse,
  KeywordClassifier,
  LlmProviderConfig
} from "../types";
import type { AiTokenUsage } from "../../types";

/** Gemini generateContent adapter for OCR keyword classification. */
export class GeminiKeywordClassifier implements KeywordClassifier {
  constructor(private readonly config: LlmProviderConfig) {}

  async classifyKeywords(request: KeywordClassificationRequest): Promise<KeywordClassificationResponse> {
    if (!this.config.apiKey) {
      throw new Error("GEMINI_API_KEY is required for the Gemini keyword classifier.");
    }
    if (!this.config.model) {
      throw new Error("GEMINI_MODEL is required for the Gemini keyword classifier.");
    }

    const prompt = createKeywordClassificationPromptParts(request);
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${this.config.model}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": this.config.apiKey
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: prompt.system }] },
        contents: [{ role: "user", parts: [{ text: prompt.user }] }]
      })
    });

    if (!response.ok) {
      throw new Error(`Gemini keyword classification failed: ${response.status}`);
    }

    const payload = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: unknown;
    };
    const rawText = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("\n") ?? "";
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    const result = jsonMatch ? JSON.parse(jsonMatch[0]) as KeywordClassificationResponse : { keywords: [], summary: "No parseable JSON returned.", rawText };
    return {
      ...result,
      usage: tokenUsageFromGemini(payload.usageMetadata)
    };
  }
}

function tokenUsageFromGemini(value: unknown): AiTokenUsage | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const usage = value as Record<string, unknown>;
  const result: AiTokenUsage = {
    inputTokens: numberField(usage.promptTokenCount),
    outputTokens: numberField(usage.candidatesTokenCount),
    totalTokens: numberField(usage.totalTokenCount)
  };
  return result.inputTokens !== undefined || result.outputTokens !== undefined || result.totalTokens !== undefined ? result : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
