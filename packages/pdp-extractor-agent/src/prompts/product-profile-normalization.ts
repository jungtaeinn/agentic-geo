/** @fileoverview 추출된 상품 프로필의 필드 배치를 보수적으로 정규화하는 프롬프트. */
import type { ProductExtractorProductNormalizationRequest } from "../types";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

const defaultMaxSourceCharacters = 35_000;

/**
 * 추출된 상품 프로필(ProductProfile)을 보수적으로 정규화하는 system/user
 * 프롬프트 쌍을 만듭니다.
 *
 * 무엇을 하는가:
 * - 원본 소스 데이터(rawSource), 규칙 기반으로 먼저 만든 부트스트랩 상품 프로필,
 *   RAG 정책 문서를 함께 주고, 필드가 올바른 자리에 배치된(source-backed)
 *   ProductProfile JSON을 돌려받습니다.
 * - "필드 라우팅과 근거 보존"이 목적이며, 공개용 카피라이팅은 하지 않습니다.
 *
 * 핵심 규칙(프롬프트가 강제하는 것):
 * - 소스에 없는 클레임·성분·효능·가격·리뷰·수치·인증을 만들어내지 않습니다.
 * - 부트스트랩 값이 더 안전하거나 근거가 확실하면 부트스트랩 값을 유지합니다.
 * - 커머스 UI/쿠폰/배송/환불/법적 고지 텍스트는 상품 근거가 될 수 없습니다.
 *
 * @param request 원본 소스, 부트스트랩 상품 프로필, RAG 정책 문서
 * @param maxSourceCharacters user 페이로드에 넣을 원본 JSON의 최대 길이(초과 시 잘라냄)
 * @returns system(정규화 규칙) / user(원본·부트스트랩·정책 JSON) 프롬프트 쌍
 */
export function createProductProfileNormalizationPrompt(
  request: ProductExtractorProductNormalizationRequest,
  maxSourceCharacters = defaultMaxSourceCharacters
): { system: string; user: string } {
  return {
    system: [
      "You are a conservative product extraction normalization agent.",
      "Return strict JSON only: {\"product\":{},\"warnings\":[]}.",
      "Infer ProductProfile fields from raw source data, bootstrap ProductProfile, and RAG policy documents.",
      "Your job is source-backed field routing, not public copywriting.",
      "Keep brand as a separate ProductProfile.brand field when source data identifies a maker/brand; do not merge SKU option labels into brand.",
      "Use source product data only. Do not invent claims, ingredients, effects, prices, reviews, metrics, awards, or certifications.",
      "Prefer complete source-backed sentences over isolated tokens. Keep benefit, effect, ingredient, usage, FAQ, metric, option, and image fields separated.",
      "Use RAG policy to resolve overlaps: commerce UI, coupon, delivery, exchange, refund, return, legal, and page chrome text must not become product evidence.",
      "If the bootstrap value is safer or better supported than your inferred value, return the bootstrap value or omit the field."
    ].join("\n"),
    user: JSON.stringify(createProductProfileNormalizationPayload(request, maxSourceCharacters), null, 2)
  };
}

/** user 메시지에 실을 페이로드(원본·부트스트랩·RAG 정책)를 JSON 값으로 조립합니다. */
function createProductProfileNormalizationPayload(
  request: ProductExtractorProductNormalizationRequest,
  maxSourceCharacters: number
): JsonValue {
  return {
    task: "Infer a source-backed ProductProfile with fewer hardcoded field assumptions.",
    source: request.source,
    sourceType: request.sourceType,
    bootstrapProduct: toJsonValue(request.bootstrapProduct),
    rawSource: trimJsonForPrompt(request.rawSource, maxSourceCharacters),
    ragPolicy: [
      request.analysisPrompt ? { name: "analysis-prompt", content: request.analysisPrompt.slice(0, 2400) } : undefined,
      ...(request.ragDocuments ?? []).map((document) => ({
        name: document.name,
        version: document.version ?? null,
        content: document.content.slice(0, 2400)
      }))
    ].filter(Boolean) as JsonValue
  };
}

/** 원본 JSON이 상한을 넘으면 프롬프트용으로 잘라내고 truncated 표시를 남깁니다. */
function trimJsonForPrompt(value: unknown, maxCharacters: number): JsonValue {
  const text = JSON.stringify(toJsonValue(value), null, 2);
  if (text.length <= maxCharacters) {
    return toJsonValue(value);
  }
  return {
    truncated: true,
    text: text.slice(0, maxCharacters)
  };
}

/** 임의 값을 프롬프트에 안전한 JSON 값으로 변환합니다(배열 80개·키 200개 상한). */
function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 80).map(toJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 200).map(([key, item]) => [key, toJsonValue(item)]));
  }
  return String(value ?? "");
}
