import type { PdpGeoGeneratorOptions } from "@agentic-geo/pdp-geo-generator-agent/types";

type Provider = "mock" | "openai" | "gemini" | "azure-openai" | "aistudio";

function optionalNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function buildGeneratorOptions(env: NodeJS.ProcessEnv = process.env): PdpGeoGeneratorOptions {
  const provider = (env.AGENTIC_GEO_PROVIDER ?? "mock") as Provider;
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
    // 임베딩은 리전이 달라 reasoning과 별도 리소스를 쓸 수 있다(엔드포인트·api-version 분리).
    embedding: optionalString(env.AZURE_OPENAI_EMBEDDING_ENDPOINT)
      ? {
          provider: "azure-openai" as const,
          apiKey: optionalString(env.AZURE_OPENAI_EMBEDDING_API_KEY) ?? env.AZURE_OPENAI_API_KEY,
          endpoint: env.AZURE_OPENAI_EMBEDDING_ENDPOINT,
          deployment: env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT,
          apiVersion: optionalString(env.AZURE_OPENAI_EMBEDDING_API_VERSION),
        }
      : undefined,
    temperature: optionalNumber(env.AZURE_OPENAI_TEMPERATURE),
    // 상품 신호 정규화(semanticFacts 원자화)는 산출 품질의 단방향 개선이라
    // 운영 경로에서도 기본 활성한다. 근거 없는 값은 적용 필터가 기각하고
    // (fail-closed) 호출 실패 시 bootstrap을 유지하므로(fail-safe) 최악의
    // 결과가 비활성 상태와 같다. 비용 통제가 필요하면 env로만 끈다.
    productNormalization: {
      enabled: provider !== "mock"
        && Boolean(apiKey)
        && env.AGENTIC_GEO_PRODUCT_NORMALIZATION?.trim().toLowerCase() !== "false",
    },
    finalProofreading: {
      enabled: provider !== "mock" && Boolean(apiKey),
      provider,
      apiKey,
    },
  };
}
