import { generatePdpGeo } from "./agent";
import { pdpGeoGeneratorRagManifest } from "./rag/manifest";
import type {
  PdpGeoDiagnostics,
  PdpGeoGenerationInput,
  PdpGeoGenerationStageId,
  PdpGeoGenerationStep,
  PdpGeoGeneratorOptions
} from "./types";

/** REST request contract for calling the PDP GEO generator agent from another service. */
export interface PdpGeoGeneratorRestRequest extends Omit<PdpGeoGenerationInput, "product"> {
  product?: unknown;
  products?: unknown[];
  llm?: Partial<Pick<PdpGeoGeneratorRestConfig, "provider" | "apiKey" | "model" | "endpoint" | "deployment" | "deployments" | "apiVersion" | "temperature" | "embedding" | "reranker" | "productNormalization" | "keywordNormalization" | "contentPlanning" | "copyRefinement" | "finalProofreading">>;
  productNormalization?: PdpGeoGeneratorRestConfig["productNormalization"];
  keywordNormalization?: PdpGeoGeneratorRestConfig["keywordNormalization"];
  contentPlanning?: PdpGeoGeneratorRestConfig["contentPlanning"];
  copyRefinement?: PdpGeoGeneratorRestConfig["copyRefinement"];
  finalProofreading?: PdpGeoGeneratorRestConfig["finalProofreading"];
}

export interface PdpGeoGeneratorRestFailure {
  index: number;
  error: string;
}

/** Runtime config used by REST adapters without leaking provider details into UI code. */
export interface PdpGeoGeneratorRestConfig extends PdpGeoGeneratorOptions {}

/** Creates a Web API compatible REST handler for this package-local agent. */
export function createPdpGeoGeneratorRestHandler(config: PdpGeoGeneratorRestConfig = {}) {
  return async function pdpGeoGeneratorRestHandler(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed. Use POST." }, 405);
    }

    try {
      const body = await request.json() as PdpGeoGeneratorRestRequest;
      assertSafeRestEndpointOverrides(config, body);
      const products = Array.isArray(body.products) ? body.products : body.product !== undefined ? [body.product] : [];
      const productNormalization = mergeRestProviderStageSettings(config, body, config.productNormalization, body.llm?.productNormalization, body.productNormalization);
      const keywordNormalization = mergeRestProviderStageSettings(config, body, config.keywordNormalization, body.llm?.keywordNormalization, body.keywordNormalization);
      const contentPlanning = mergeRestProviderStageSettings(config, body, config.contentPlanning, body.llm?.contentPlanning, body.contentPlanning);
      const copyRefinement = mergeRestProviderStageSettings(config, body, config.copyRefinement, body.llm?.copyRefinement, body.copyRefinement);
      const finalProofreading = mergeRestFinalProofreadingSettings(config, body);
      const runtimeConfig: PdpGeoGeneratorRestConfig = {
        ...config,
        ...body.llm,
        rag: {
          ...config.rag,
          ...body.rag
        },
        productNormalization,
        keywordNormalization,
        contentPlanning,
        copyRefinement,
        finalProofreading
      };

      if (products.length === 0) {
        return jsonResponse({ error: "At least one product JSON payload is required." }, 400);
      }

      const runs = await Promise.all(products.map(async (product, index) => {
        try {
          return {
            status: "fulfilled" as const,
            run: await generatePdpGeo(
              {
                product,
                source: body.source,
                hints: body.hints,
                fieldMapping: body.fieldMapping,
                rag: body.rag
              },
              runtimeConfig
            )
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : "PDP GEO generation failed.";
          return {
            status: "rejected" as const,
            failure: {
              index,
              error: message
            },
            diagnostics: createFailureDiagnostics(message)
          };
        }
      }));
      const succeeded = runs.filter((run) => run.status === "fulfilled");
      const failed = runs.filter((run) => run.status === "rejected");

      return jsonResponse(
        {
          results: succeeded.map((run) => run.run.result),
          logs: [
            ...succeeded.map((run) => ({
              diagnostics: run.run.diagnostics,
              process: run.run.process
            })),
            ...failed.map((run) => ({
              diagnostics: run.diagnostics,
              process: createFailureProcess(run.failure.error)
            }))
          ],
          failures: failed.map((run) => run.failure)
        },
        failed.length > 0 ? 207 : 200
      );
    } catch (error) {
      return jsonResponse(
        {
          error: error instanceof Error ? error.message : "PDP GEO generation failed."
        },
        error instanceof RestRequestConfigurationError ? 400 : 500
      );
    }
  };
}

class RestRequestConfigurationError extends Error {}

function assertSafeRestEndpointOverrides(
  config: PdpGeoGeneratorRestConfig,
  body: PdpGeoGeneratorRestRequest
): void {
  assertRestProviderCredentialPair(
    "llm.provider",
    body.llm?.provider,
    body.llm?.apiKey,
    config.provider,
    config.apiKey
  );
  assertRestEndpointPair("llm.endpoint", body.llm?.endpoint, body.llm?.apiKey, config.endpoint, config.apiKey);
  const checks = [
    {
      label: "productNormalization.endpoint",
      requested: { ...body.llm?.productNormalization, ...body.productNormalization },
      configured: config.productNormalization
    },
    {
      label: "keywordNormalization.endpoint",
      requested: { ...body.llm?.keywordNormalization, ...body.keywordNormalization },
      configured: config.keywordNormalization
    },
    {
      label: "contentPlanning.endpoint",
      requested: { ...body.llm?.contentPlanning, ...body.contentPlanning },
      configured: config.contentPlanning
    },
    {
      label: "copyRefinement.endpoint",
      requested: { ...body.llm?.copyRefinement, ...body.copyRefinement },
      configured: config.copyRefinement
    },
    {
      label: "finalProofreading.endpoint",
      requested: { ...body.llm?.finalProofreading, ...body.finalProofreading },
      configured: config.finalProofreading
    }
  ];
  for (const check of checks) {
    const serverEndpoint = check.configured?.endpoint ?? config.endpoint;
    const serverApiKey = check.configured?.apiKey ?? config.apiKey;
    const requestApiKey = check.label === "finalProofreading.endpoint"
      ? finalProofreadingRequestApiKey(config, body, check.requested)
      : providerStageRequestApiKey(config, body, check.requested, check.configured);
    const parentRequestProvider = body.llm?.provider ?? config.provider;
    if (check.label !== "finalProofreading.endpoint"
      && check.requested.provider
      && body.llm?.apiKey
      && check.requested.provider !== parentRequestProvider
      && !check.requested.apiKey) {
      throw new RestRequestConfigurationError(
        `${check.label.replace(/\.endpoint$/, ".provider")} requires its own API key when it differs from llm.provider; llm.apiKey is scoped to the parent provider.`
      );
    }
    if (check.label !== "finalProofreading.endpoint") {
      assertRestProviderCredentialPair(
        check.label.replace(/\.endpoint$/, ".provider"),
        check.requested.provider,
        requestApiKey,
        check.configured?.provider ?? config.provider,
        serverApiKey
      );
    }
    assertRestEndpointPair(check.label, check.requested.endpoint, requestApiKey, serverEndpoint, serverApiKey);
  }
  const requestedFinal = { ...body.llm?.finalProofreading, ...body.finalProofreading };
  const parentRequestProvider = body.llm?.provider ?? config.provider;
  if (requestedFinal.provider
    && body.llm?.apiKey
    && requestedFinal.provider !== parentRequestProvider
    && !requestedFinal.apiKey) {
    throw new RestRequestConfigurationError(
      "finalProofreading.provider requires its own API key when it differs from llm.provider; llm.apiKey is scoped to the parent provider."
    );
  }
  assertRestProviderCredentialPair(
    "finalProofreading.provider",
    requestedFinal.provider,
    finalProofreadingRequestApiKey(config, body, requestedFinal),
    config.finalProofreading?.provider ?? config.provider,
    config.finalProofreading?.apiKey ?? config.apiKey
  );
}

function providerStageRequestApiKey(
  config: PdpGeoGeneratorRestConfig,
  body: PdpGeoGeneratorRestRequest,
  requested: RestProviderStageSettings,
  configured: RestProviderStageSettings | undefined
): string | undefined {
  if (requested.apiKey) return requested.apiKey;
  if (!body.llm?.apiKey) return undefined;
  const parentProvider = body.llm.provider ?? config.provider;
  const stageProvider = requested.provider
    ?? (configured ? configured.provider ?? config.provider : undefined)
    ?? parentProvider;
  return stageProvider === parentProvider ? body.llm.apiKey : undefined;
}

interface RestProviderStageSettings {
  enabled?: boolean;
  provider?: PdpGeoGeneratorOptions["provider"];
  apiKey?: string;
  model?: string;
  endpoint?: string;
  deployment?: string;
  apiVersion?: string;
}

function mergeRestProviderStageSettings<T extends RestProviderStageSettings>(
  config: PdpGeoGeneratorRestConfig,
  body: PdpGeoGeneratorRestRequest,
  configured: T | undefined,
  nested: T | undefined,
  topLevel: T | undefined
): T | undefined {
  if (!configured && !nested && !topLevel) return undefined;
  const requested = { ...nested, ...topLevel } as T;
  const configuredProvider = configured ? configured.provider ?? config.provider : undefined;
  const providerChanged = Boolean(requested.provider && configuredProvider && requested.provider !== configuredProvider);
  const inherited = providerChanged ? { enabled: configured?.enabled } : { ...configured };
  const effectiveProvider = requested.provider
    ?? configuredProvider
    ?? body.llm?.provider
    ?? config.provider;
  return {
    ...inherited,
    ...requested,
    ...(effectiveProvider ? { provider: effectiveProvider } : {})
  } as T;
}

function mergeRestFinalProofreadingSettings(
  config: PdpGeoGeneratorRestConfig,
  body: PdpGeoGeneratorRestRequest
): PdpGeoGeneratorRestConfig["finalProofreading"] {
  const requested = { ...body.llm?.finalProofreading, ...body.finalProofreading };
  if (!config.finalProofreading && !body.llm?.finalProofreading && !body.finalProofreading) return undefined;
  const configuredProvider = config.finalProofreading
    ? config.finalProofreading.provider ?? config.provider
    : undefined;
  const effectiveProvider = effectiveFinalProofreadingProvider(config, body, requested);
  const providerChanged = Boolean(requested.provider && requested.provider !== configuredProvider);
  const inherited = providerChanged
    ? { enabled: config.finalProofreading?.enabled }
    : { ...config.finalProofreading };
  const merged = { ...inherited, ...requested };
  const configuredEndpoint = config.finalProofreading?.endpoint ?? config.endpoint;
  const parentProvider = body.llm?.provider ?? config.provider;
  const mayInheritParent = effectiveProvider === parentProvider;
  const parentMatchesConfiguredProvider = parentProvider === config.provider;
  const effectiveEndpoint = merged.endpoint
    ?? (mayInheritParent ? body.llm?.endpoint ?? (parentMatchesConfiguredProvider ? config.endpoint : undefined) : undefined);
  const serverApiKey = config.finalProofreading?.apiKey ?? config.apiKey;
  const endpointChanged = Boolean(serverApiKey && effectiveEndpoint && (
    !configuredEndpoint || restEndpointIdentity(effectiveEndpoint) !== restEndpointIdentity(configuredEndpoint)
  ));
  const requestApiKey = finalProofreadingRequestApiKey(config, body, requested);
  return {
    ...merged,
    provider: effectiveProvider,
    apiKey: providerChanged || endpointChanged ? requestApiKey : merged.apiKey ?? requestApiKey,
    model: merged.model ?? (mayInheritParent ? body.llm?.model ?? (parentMatchesConfiguredProvider ? config.model : undefined) : undefined),
    endpoint: effectiveEndpoint,
    deployment: merged.deployment ?? (mayInheritParent
      ? body.llm?.deployments?.proofreading
        ?? body.llm?.deployment
        ?? (parentMatchesConfiguredProvider ? config.deployments?.proofreading ?? config.deployment : undefined)
      : undefined),
    apiVersion: merged.apiVersion ?? (mayInheritParent
      ? body.llm?.apiVersion ?? (parentMatchesConfiguredProvider ? config.apiVersion : undefined)
      : undefined)
  };
}

function finalProofreadingRequestApiKey(
  config: PdpGeoGeneratorRestConfig,
  body: PdpGeoGeneratorRestRequest,
  requested: NonNullable<PdpGeoGeneratorRestConfig["finalProofreading"]>
): string | undefined {
  if (requested.apiKey) return requested.apiKey;
  if (!body.llm?.apiKey) return undefined;
  const parentProvider = body.llm.provider ?? config.provider;
  const finalProvider = effectiveFinalProofreadingProvider(config, body, requested);
  return finalProvider === parentProvider ? body.llm.apiKey : undefined;
}

function effectiveFinalProofreadingProvider(
  config: PdpGeoGeneratorRestConfig,
  body: PdpGeoGeneratorRestRequest,
  requested: NonNullable<PdpGeoGeneratorRestConfig["finalProofreading"]>
): PdpGeoGeneratorOptions["provider"] {
  return requested.provider
    ?? (config.finalProofreading ? config.finalProofreading.provider ?? config.provider : undefined)
    ?? body.llm?.provider
    ?? config.provider;
}

function assertRestProviderCredentialPair(
  label: string,
  requestProvider: PdpGeoGeneratorOptions["provider"] | undefined,
  requestApiKey: string | undefined,
  serverProvider: PdpGeoGeneratorOptions["provider"] | undefined,
  serverApiKey: string | undefined
): void {
  if (!requestProvider || !serverApiKey || requestProvider === serverProvider || requestApiKey) return;
  throw new RestRequestConfigurationError(
    `${label} cannot change the configured provider while inheriting a server-managed API key. Supply an API key for the requested provider.`
  );
}

function assertRestEndpointPair(
  label: string,
  requestEndpoint: string | undefined,
  requestApiKey: string | undefined,
  serverEndpoint: string | undefined,
  serverApiKey: string | undefined
): void {
  if (!requestEndpoint || requestApiKey || !serverApiKey) return;
  if (serverEndpoint && restEndpointIdentity(serverEndpoint) === restEndpointIdentity(requestEndpoint)) return;
  throw new RestRequestConfigurationError(
    `${label} cannot override the configured provider endpoint while using a server-managed API key.`
  );
}

function restEndpointIdentity(value: string): string {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) throw new Error("unsafe endpoint components");
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    return `${url.protocol}//${url.host}${pathname}`;
  } catch {
    throw new RestRequestConfigurationError(`Invalid provider endpoint URL: ${value}`);
  }
}

function createFailureDiagnostics(error: string): Partial<PdpGeoDiagnostics> {
  const generatedAt = new Date().toISOString();
  return {
    recommendations: [],
    evidence: [
      {
        field: "generation",
        source: "repair",
        value: error
      }
    ],
    selectedRagChunks: [],
    ragUsage: [],
    validationWarnings: [error],
    ragMode: "local-versioned-rag",
    generatedAt
  };
}

const failureStepMessages: Record<PdpGeoGenerationStageId, Pick<PdpGeoGenerationStep, "title" | "description">> = {
  input: {
    title: "입력 검증",
    description: "임의 상품 JSON과 옵션을 검증"
  },
  normalize: {
    title: "상품 신호 정규화",
    description: "REST/API/PDP JSON을 내부 ProductSignal로 변환"
  },
  "rag-load": {
    title: "RAG 프로필 로드",
    description: "schema.org, E-E-A-T, CEP, GEO, BestPractice, locale 용어집 로드"
  },
  chunk: {
    title: "RAG chunk 구성",
    description: "버전 문서와 상품 컨텍스트를 검색 가능한 chunk로 준비"
  },
  embed: {
    title: "임베딩 구성",
    description: "로컬 또는 managed vector store 임베딩 전략 적용"
  },
  retrieve: {
    title: "RAG 검색",
    description: "상품/locale/schema 목표에 맞는 관련 문서 검색"
  },
  rerank: {
    title: "리랭킹",
    description: "schema, locale, terminology, GEO 관련성을 기준으로 재정렬"
  },
  generate: {
    title: "GEO 산출물 생성 및 최종 교정",
    description: "JSON-LD 생성 후 선택적으로 별도 fluency-only proofreading 모델 호출"
  },
  validate: {
    title: "문법 검증",
    description: "JSON-LD 구조와 공개 문구 검증"
  },
  repair: {
    title: "검증 결과 기록",
    description: "자동 수정 없이 validation findings를 diagnostics에 기록"
  },
  artifact: {
    title: "최종 아티팩트 생성",
    description: "복사 가능한 schemaMarkup과 content 결과 생성"
  }
};

function createFailureProcess(error: string): PdpGeoGenerationStep[] {
  const generatedAt = new Date().toISOString();
  const order: PdpGeoGenerationStageId[] = ["input", "normalize", "rag-load", "chunk", "embed", "retrieve", "rerank", "generate", "validate", "repair", "artifact"];

  return order.map((id, index) => ({
    id,
    ...failureStepMessages[id],
    status: index === 0 ? "done" : index === 1 ? "error" : "pending",
    message: index === 0 ? "입력을 수신했습니다." : index === 1 ? error : failureStepMessages[id].description,
    startedAt: index <= 1 ? generatedAt : undefined,
    completedAt: index <= 1 ? generatedAt : undefined
  }));
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

export { pdpGeoGeneratorRagManifest };
