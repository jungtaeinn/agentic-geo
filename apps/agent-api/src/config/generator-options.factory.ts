import type { PdpGeoGeneratorOptions } from "@agentic-geo/pdp-geo-generator-agent/types";
import { optionalNumber, optionalString, selectSharedLlmEnv } from "./llm-env-selection";

export function buildGeneratorOptions(env: NodeJS.ProcessEnv = process.env): PdpGeoGeneratorOptions {
  const shared = selectSharedLlmEnv(env);
  const { provider, apiKey } = shared;

  return {
    ...shared,
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
