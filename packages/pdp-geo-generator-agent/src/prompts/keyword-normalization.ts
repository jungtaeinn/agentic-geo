/** @fileoverview 리뷰 키워드의 명백한 오타만 교정하는 프롬프트. */
import type { PdpGeoKeywordNormalizationRequest } from "../types";

/**
 * 리뷰 키워드 오타 교정용 system/user 프롬프트 쌍을 만듭니다.
 *
 * 무엇을 하는가:
 * - 고객 리뷰에서 뽑은 키워드 목록을 모델에 주고, 명백한 오타·OCR 오류·
 *   자판 인접 오타·띄어쓰기 실수만 고친 교정(corrections) JSON을 돌려받습니다.
 * - 번역·확장·마케팅 문구화는 금지되며, 확신이 없으면 교정하지 않고 건너뜁니다.
 *   (유효한 키워드는 corrections에 포함되지 않는 것이 정상 동작입니다.)
 *
 * @param request 리뷰 키워드와 판단 문맥(리뷰 본문, 효능/효과, 소스 텍스트)
 * @returns system(교정 규칙) / user(키워드·문맥 JSON) 프롬프트 쌍
 */
export function createKeywordNormalizationPrompt(request: PdpGeoKeywordNormalizationRequest): { system: string; user: string } {
  return {
    system: [
      "You are a conservative typo-normalization agent for product review keywords.",
      "Return strict JSON only: {\"corrections\":[{\"original\":\"\",\"normalized\":\"\",\"confidence\":0.0,\"reason\":\"\"}],\"warnings\":[]}.",
      "Only correct obvious typos, OCR mistakes, keyboard-adjacent mistakes, or spacing mistakes in the original keyword language.",
      "Do not translate, expand, summarize, add new claims, add new benefits, or rewrite a keyword into marketing copy.",
      "If uncertain, omit the correction. Keep normalized keywords concise and source-backed."
    ].join("\n"),
    user: JSON.stringify({
      task: "Normalize only misspelled review keywords. Leave valid keywords unchanged by omitting them from corrections.",
      productName: request.productName,
      locale: request.locale,
      market: request.market,
      reviewKeywords: request.reviewKeywords,
      context: {
        reviewBodies: request.reviewBodies,
        benefits: request.benefits,
        effects: request.effects,
        sourceTexts: request.sourceTexts
      }
    }, null, 2)
  };
}
