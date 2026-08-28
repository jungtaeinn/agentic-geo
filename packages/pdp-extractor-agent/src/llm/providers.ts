import { AistudioKeywordClassifier } from "./providers/aistudio";
import { AzureApiKeywordClassifier } from "./providers/azure-openai";
import { GeminiKeywordClassifier } from "./providers/gemini";
import { MockKeywordClassifier } from "./providers/mock";
import { OpenAIKeywordClassifier } from "./providers/openai";
import type { KeywordClassifier, LlmProviderConfig } from "./types";

/** Resolves the configured keyword classifier while keeping provider code package-local. */
export function createKeywordClassifier(config: LlmProviderConfig): KeywordClassifier {
  switch (config.provider) {
    case "openai":
      return new OpenAIKeywordClassifier(config);
    case "gemini":
      return new GeminiKeywordClassifier(config);
    case "azure-openai":
      return new AzureApiKeywordClassifier(config);
    case "aistudio":
      return new AistudioKeywordClassifier(config);
    case "mock":
    default:
      return new MockKeywordClassifier();
  }
}
