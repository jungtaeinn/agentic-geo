import { Injectable } from "@nestjs/common";
import { generatePdpGeo } from "@agentic-geo/pdp-geo-generator-agent";
import type { PdpGeoContentSections, PdpGeoLocale } from "@agentic-geo/pdp-geo-generator-agent/types";
import { buildGeneratorOptions } from "../config/generator-options.factory";
import { sanitizeProductHtml } from "./product-sanitizer";
import { deriveSchemaTypes, computeResultHash } from "./schema-types.util";
import { OcrEnrichmentService } from "./ocr-enrichment.service";

export function resolveResultStatus(
  warnings: readonly string[],
): "SUCCEEDED" | "SUCCEEDED_WITH_WARNINGS" {
  return warnings.length > 0 ? "SUCCEEDED_WITH_WARNINGS" : "SUCCEEDED";
}

/**
 * GEO 입력 계약(GEO-128)의 canonicalUrl(없으면 offerUrl)을 생성기 source.url로 추출한다.
 * 이 값이 있어야 JSON-LD의 @id가 urn 대신 실제 URL 앵커가 되고 WebPage.url/Offer.url이 출력된다.
 */
export function extractSourceUrl(product: unknown): string | undefined {
  if (typeof product !== "object" || product === null) return undefined;
  const record = product as Record<string, unknown>;
  for (const key of ["canonicalUrl", "offerUrl"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

export interface GenerationInput {
  geoGenerationId: string;
  locale: string;
  product: unknown;
  /** Official brand entity URLs; see SubmitGenerationDto.brandSameAs. */
  brandSameAs?: string[];
}

export interface GeneratedArtifact {
  resultStatus: "SUCCEEDED" | "SUCCEEDED_WITH_WARNINGS";
  jsonLd: Record<string, unknown>;
  scriptTag: string;
  schemaTypes: string[];
  resultHash: string;
  ragProfile: string;
  diagnostics: Record<string, unknown>;
  /**
   * 생성기가 스키마 필드를 조립할 때 쓴 내부 카피. 저장 경로는 쓰지 않고(리포지토리가
   * 필드를 명시적으로 고른다) 동기 테스트 응답의 opt-in 페이로드에만 실린다 —
   * 평가 에이전트의 개선 프롬프트가 "현재 콘텐츠"로 요구하는 입력이다.
   */
  contentSections: PdpGeoContentSections;
  generatedAt: string;
}

/**
 * 생성기에 넘길 요청을 조립한다. product는 마크업 노이즈를 걷어낸 사본을 넘기고
 * (GEO-228 — 근거로 쓸 수 없는 style/script/주석이 900자 프롬프트 창을 잡아먹는다),
 * source.url은 원본에서 읽는다. URL 필드에는 HTML이 없으므로 정제 전후가 같지만,
 * 계약 필드를 읽는 주체는 원본이라는 점을 코드에 남겨둔다.
 */
export function buildGeneratorRequest(input: GenerationInput): {
  product: unknown;
  source: { type: "manual-json"; url: string | undefined };
  hints: { locale: PdpGeoLocale; brandSameAs?: string[] };
} {
  const brandSameAs = input.brandSameAs?.filter((url) => url.trim() !== "");
  return {
    product: sanitizeProductHtml(input.product),
    source: { type: "manual-json", url: extractSourceUrl(input.product) },
    // The hint is omitted rather than sent empty: the generator treats an empty
    // sameAs as nothing to emit, and an absent key keeps the request identical
    // to what callers that do not supply brand identity have always sent.
    hints: { locale: input.locale as PdpGeoLocale, ...(brandSameAs?.length ? { brandSameAs } : {}) },
  };
}

@Injectable()
export class GenerationService {
  constructor(private readonly ocrEnrichment: OcrEnrichmentService) {}

  async generate(input: GenerationInput): Promise<GeneratedArtifact> {
    // source.url은 원본 product 기준(위 buildGeneratorRequest 설명과 동일한 원칙) — OCR 보강은
    // canonicalUrl/offerUrl을 건드리지 않으므로 결과는 같지만, 원본에서 읽는다는 의도를 명시해 둔다.
    const enrichment = await this.ocrEnrichment.enrich(input.product, extractSourceUrl(input.product));
    const run = await generatePdpGeo(
      buildGeneratorRequest({ ...input, product: enrichment.product }),
      buildGeneratorOptions(),
    );

    const jsonLd = run.result.schemaMarkup.jsonLd as Record<string, unknown>;
    const warnings = [...(run.result.diagnostics.validationWarnings ?? []), ...enrichment.warnings];
    return {
      resultStatus: resolveResultStatus(warnings),
      jsonLd,
      scriptTag: run.result.schemaMarkup.scriptTag,
      schemaTypes: deriveSchemaTypes(jsonLd),
      resultHash: computeResultHash(jsonLd),
      ragProfile: run.result.ragProfile,
      diagnostics: {
        ...run.result.diagnostics,
        ocrEnrichment: enrichment.diagnostics,
      } as unknown as Record<string, unknown>,
      contentSections: run.result.content.sections,
      generatedAt: run.result.generatedAt,
    };
  }
}
