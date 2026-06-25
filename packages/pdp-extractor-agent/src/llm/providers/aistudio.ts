import { AzureApiKeywordClassifier } from "./azure-openai";

/**
 * AI Studio external-agent adapter.
 *
 * The gateway proxies Azure OpenAI for chat/OCR models, so it speaks the same
 * deployment-scoped chat completions contract as Azure. Only two things differ:
 * authentication uses a Bearer token instead of the api-key header, and the
 * api-version query parameter is optional (appended only when explicitly set).
 */
export class AistudioKeywordClassifier extends AzureApiKeywordClassifier {
  protected override chatCompletionsUrl(deployment: string): string {
    const endpoint = this.config.endpoint?.replace(/\/$/, "");
    const apiVersion = this.config.apiVersion?.trim();
    const query = apiVersion ? `?api-version=${encodeURIComponent(apiVersion)}` : "";
    return `${endpoint}/openai/deployments/${deployment}/chat/completions${query}`;
  }

  protected override authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.config.apiKey ?? ""}` };
  }
}
