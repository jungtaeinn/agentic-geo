import { randomUUID } from "node:crypto";
import type { PdpGeoContentSections } from "@agentic-geo/pdp-geo-generator-agent/types";
import { GenerationService } from "../../../src/geo/generation.service";
import { buildGeneratorOptions } from "../../../src/config/generator-options.factory";
import type { RegressionCase, RunMeta } from "./types";

/**
 * 실행 모드 두 가지를 한 인터페이스로 감춘다.
 *
 * - `local`: NestJS 앱을 띄우지 않고 `GenerationService`를 직접 호출한다. DB·큐에 의존하지 않는
 *   순수 호출이라 서버 없이 돌고, 생성기 진단이 전량 그대로 손에 들어온다.
 * - `http`: 이미 떠 있는 agent-api의 동기 테스트 엔드포인트를 때린다. 환경(로컬/개발/스테이지)별
 *   실제 배포본을 검증할 때 쓴다.
 *
 * 두 모드의 산출물이 같은 모양이어야 점수 비교가 성립하므로, http 모드는 반드시
 * `includeDiagnostics: true`로 요청해 local 모드와 동일한 평가 입력을 확보한다.
 */
export interface GenerationOutcome {
  geoGenerationId?: string;
  resultStatus: string;
  jsonLd: Record<string, unknown>;
  schemaTypes: string[];
  resultHash: string;
  ragProfile: string;
  validationWarnings: string[];
  diagnostics: Record<string, unknown>;
  contentSections: PdpGeoContentSections;
  generatedAt: string;
}

export interface Runner {
  readonly mode: "local" | "http";
  readonly baseUrl?: string;
  run(testCase: RegressionCase): Promise<GenerationOutcome>;
}

/** 환경 별칭 → base URL. 새 환경이 생기면 여기만 늘리면 된다. */
const ENV_BASE_URLS: Record<string, string> = {
  local: "http://localhost:3000",
  // TODO: 개발/스테이지 배포 URL이 확정되면 채운다. 그전까지는 GEO_REGRESSION_BASE_URL로 직접 지정한다.
  // dev: "https://...",
  // stage: "https://...",
};

export function resolveMode(): "local" | "http" {
  const raw = (process.env.GEO_REGRESSION_MODE ?? "local").trim().toLowerCase();
  if (raw !== "local" && raw !== "http") {
    throw new Error(`GEO_REGRESSION_MODE는 local 또는 http여야 합니다 (받은 값: ${raw})`);
  }
  return raw;
}

export function resolveBaseUrl(): string {
  const explicit = process.env.GEO_REGRESSION_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const envAlias = (process.env.GEO_REGRESSION_ENV ?? "local").trim().toLowerCase();
  const mapped = ENV_BASE_URLS[envAlias];
  if (!mapped) {
    throw new Error(
      `GEO_REGRESSION_ENV=${envAlias}에 대응하는 URL이 없습니다. ` +
        `등록된 환경: ${Object.keys(ENV_BASE_URLS).join(", ")}. ` +
        `GEO_REGRESSION_BASE_URL로 직접 지정할 수 있습니다.`,
    );
  }
  return mapped;
}

export function createRunner(): Runner {
  return resolveMode() === "http" ? new HttpRunner() : new LocalRunner();
}

/** 서버를 띄우지 않고 생성 서비스를 그대로 호출한다. */
class LocalRunner implements Runner {
  readonly mode = "local" as const;
  private readonly generation = new GenerationService();

  async run(testCase: RegressionCase): Promise<GenerationOutcome> {
    const geoGenerationId = randomUUID();
    const artifact = await this.generation.generate({
      geoGenerationId,
      locale: testCase.request.locale,
      product: testCase.request.product,
    });
    const diagnostics = artifact.diagnostics;
    return {
      geoGenerationId,
      resultStatus: artifact.resultStatus,
      jsonLd: artifact.jsonLd,
      schemaTypes: artifact.schemaTypes,
      resultHash: artifact.resultHash,
      ragProfile: artifact.ragProfile,
      validationWarnings: (diagnostics.validationWarnings as string[] | undefined) ?? [],
      diagnostics,
      contentSections: artifact.contentSections,
      generatedAt: artifact.generatedAt,
    };
  }
}

/** 떠 있는 agent-api의 동기 테스트 엔드포인트를 호출한다. */
class HttpRunner implements Runner {
  readonly mode = "http" as const;
  readonly baseUrl = resolveBaseUrl();
  private readonly apiKey = process.env.GEO_REGRESSION_API_KEY ?? process.env.AGENT_API_KEY ?? "";
  private readonly timeoutMs = Number(process.env.GEO_REGRESSION_TIMEOUT_MS ?? 600_000);

  async run(testCase: RegressionCase): Promise<GenerationOutcome> {
    const url = `${this.baseUrl}/internal/v1/geo/test-generations`;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers["x-api-key"] = this.apiKey;

    const response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          locale: testCase.request.locale,
          product: testCase.request.product,
          // 평가 루브릭과 개선 프롬프트의 입력을 확보한다. 이게 없으면 local 모드와 점수가 어긋난다.
          includeDiagnostics: true,
        }),
      },
      this.timeoutMs,
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `동기 생성 엔드포인트가 ${response.status}를 반환했습니다 (${url})` +
          (response.status === 404
            ? " — 대상 서버에 GEO_TEST_SYNC_ENDPOINT=true가 설정되어 있는지 확인하세요."
            : "") +
          (body ? `\n${body.slice(0, 500)}` : ""),
      );
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const diagnostics = payload.diagnostics as Record<string, unknown> | undefined;
    if (!diagnostics) {
      throw new Error(
        `응답에 diagnostics가 없습니다 (${url}). ` +
          `대상 서버가 includeDiagnostics를 지원하는 버전인지 확인하세요 — 이게 없으면 품질 루브릭을 산출할 수 없습니다.`,
      );
    }

    return {
      geoGenerationId: payload.geoGenerationId as string | undefined,
      resultStatus: String(payload.resultStatus ?? ""),
      jsonLd: (payload.jsonLd as Record<string, unknown>) ?? {},
      schemaTypes: (payload.schemaTypes as string[] | undefined) ?? [],
      resultHash: String(payload.resultHash ?? ""),
      ragProfile: String(payload.ragProfile ?? ""),
      validationWarnings: (payload.validationWarnings as string[] | undefined) ?? [],
      diagnostics,
      contentSections: payload.contentSections as PdpGeoContentSections,
      generatedAt: String(payload.generatedAt ?? ""),
    };
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`요청이 ${timeoutMs}ms 안에 끝나지 않았습니다 (${url})`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 실행 메타데이터를 만든다. 파이프라인 단계 on/off를 여기서 찍어 두는 이유:
 * 같은 케이스가 콘솔과 다른 점수를 낼 때 "어떤 단계가 꺼져 있었나"를 리포트에서 바로 읽기 위해서다.
 */
export function buildRunMeta(runId: string, runner: Runner): RunMeta {
  const options = buildGeneratorOptions();
  return {
    runId,
    startedAt: new Date().toISOString(),
    mode: runner.mode,
    env: process.env.GEO_REGRESSION_BASE_URL ? undefined : process.env.GEO_REGRESSION_ENV ?? "local",
    baseUrl: runner.baseUrl,
    provider: options.provider ?? "mock",
    pipeline: {
      // buildGeneratorOptions가 productNormalization을 넘기지 않으면 생성기 기본값은 '꺼짐'이다
      // (product-normalizer.ts의 resolveProductNormalizer는 명시 활성화를 요구한다).
      productNormalization: options.productNormalization?.enabled === true,
      finalProofreading: options.finalProofreading?.enabled === true,
      reasoningDeployment: options.deployments?.reasoning ?? options.deployment,
      embeddingDeployment: options.deployments?.embedding,
    },
    llmJudge: /^true$/i.test(process.env.GEO_REGRESSION_LLM_JUDGE ?? ""),
    // v1 미구현 — 플래그와 리포트 자리만 잡아 둔다.
    citationProbe: false,
    caseFilter: process.env.CASES?.trim() || undefined,
  };
}
