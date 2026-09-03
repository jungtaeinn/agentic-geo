/**
 * Env selection shared by the generator and extractor option factories. Both
 * read the same AGENTIC_GEO_PROVIDER / OPENAI_ / GEMINI_ / AZURE_OPENAI_ /
 * AISTUDIO_ env surface, so the provider/apiKey/model/endpoint/deployment/
 * apiVersion selection lives here once instead of being copy-pasted.
 */

export type LlmProvider = "mock" | "openai" | "gemini" | "azure-openai" | "aistudio";

export interface SharedLlmDeployments {
  ocr?: string;
  reasoning?: string;
  embedding?: string;
  proofreading?: string;
}

export interface SharedLlmEnvSelection {
  provider: LlmProvider;
  apiKey?: string;
  model?: string;
  endpoint?: string;
  deployment?: string;
  deployments: SharedLlmDeployments;
  apiVersion?: string;
}

export function optionalNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function selectSharedLlmEnv(env: NodeJS.ProcessEnv): SharedLlmEnvSelection {
  const provider = (env.AGENTIC_GEO_PROVIDER ?? "mock") as LlmProvider;
  const apiKey =
    provider === "openai" ? env.OPENAI_API_KEY
    : provider === "gemini" ? env.GEMINI_API_KEY
    : provider === "azure-openai" ? env.AZURE_OPENAI_API_KEY
    : provider === "aistudio" ? env.AISTUDIO_API_KEY
    : undefined;
  const model =
    provider === "openai" ? env.OPENAI_MODEL
    : provider === "gemini" ? env.GEMINI_MODEL
    : provider === "aistudio" ? env.AISTUDIO_MODEL
    : undefined;
  // AI Studio는 Azure 스타일 chat completions를 프록시하며 모델 id가 곧 deployment id다.
  const aistudioDeployment = provider === "aistudio" ? optionalString(env.AISTUDIO_MODEL) : undefined;
  const reasoningDeployment =
    aistudioDeployment ?? env.AZURE_OPENAI_REASONING_DEPLOYMENT ?? env.AZURE_OPENAI_DEPLOYMENT;

  return {
    provider,
    apiKey,
    model,
    endpoint: provider === "aistudio" ? env.AISTUDIO_ENDPOINT : env.AZURE_OPENAI_ENDPOINT,
    deployment: reasoningDeployment,
    deployments: {
      ocr: aistudioDeployment ?? env.AZURE_OPENAI_OCR_DEPLOYMENT ?? env.AZURE_OPENAI_DEPLOYMENT,
      reasoning: reasoningDeployment,
      embedding: env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT,
      proofreading: aistudioDeployment ?? env.AZURE_OPENAI_PROOFREADING_DEPLOYMENT,
    },
    apiVersion:
      provider === "aistudio" ? optionalString(env.AISTUDIO_API_VERSION) : env.AZURE_OPENAI_API_VERSION,
  };
}
