/** @fileoverview 승인된 공개 문안의 유창성만 최종 교정하는 프롬프트. */
import type { PdpGeoFinalProofreadingRequest } from "../types";

/**
 * 최종 유창성 교정용 system/user 프롬프트 쌍을 만듭니다.
 *
 * 무엇을 하는가:
 * - 이미 승인된 공개 문안(설명·FAQ·HowTo)을 필드 단위로 주고, "유창성만" 고친
 *   편집(edit) JSON을 돌려받습니다. 필드마다 정확히 하나의 edit이 같은 순서로
 *   돌아와야 하며, 고칠 것이 없으면 action=keep으로 원문을 그대로 반환합니다.
 *
 * 핵심 규칙(프롬프트가 강제하는 것):
 * - 사실 추가·삭제·강화·약화·번역 금지 — 허용 범위는 구두점/띄어쓰기,
 *   인접 중복 제거, 의미가 보존되는 좁은 문법 교정뿐입니다.
 * - 상품명·성분명·수치·단위·모집단·출처 표기는 그대로 보존합니다.
 * - HowTo는 구두점만 수정 가능하고, FAQ 항목의 추가·삭제·병합·순서 변경은 금지입니다.
 *
 * @param request 교정 대상 필드 목록(fieldPath/sourceHash 포함)과 로케일·상품 정보
 * @returns system(교정 규칙) / user(교정 대상 필드 JSON) 프롬프트 쌍
 */
export function createFinalProofreadingPrompt(request: PdpGeoFinalProofreadingRequest): { system: string; user: string } {
  return {
    system: [
      "You are the final fluency-only proofreader for already approved product schema copy.",
      "This is not a reasoning, fact-selection, SEO expansion, translation, or claim-writing task.",
      "Return exactly one edit for every input field, in the same order, with the exact fieldPath and sourceHash.",
      "Use action=keep and return the original text unchanged when no safe correction is necessary.",
      "You may automatically revise punctuation/spacing, remove an adjacent exact duplicate word or sentence, and make only narrow meaning-preserving grammar corrections.",
      "Allowed grammar corrections are: English a/an selection, same-tense subject-verb agreement, approved present-tense claim-verb agreement, and FAQ auxiliary inversion; Korean same-role particle allomorphs and approved sentence-final polite style inflections.",
      "Use issueCodes=[grammar] for those narrow grammar corrections. Do not add or remove articles/prepositions, change tense/voice/modality, reorder content words, or change Korean particle roles.",
      "If any other naturalness, grammar, or awkward word-order fix is needed, use action=keep with the original text and add a concise field-specific warning instead of rewriting it.",
      "Never add, remove, generalize, narrow, strengthen, weaken, translate, or reconnect any factual statement.",
      "Preserve product and brand names, ingredient and technology names, numbers, units, signs, periods, populations, test/review attribution, negation, uncertainty, and claim modality exactly.",
      "Never create an ingredient-to-benefit relationship, suitability claim, efficacy claim, comparison, routine order, review consensus, or market claim that the original field did not state.",
      "Product.description must keep its existing semantic role order. WebPage.description must remain page/brand/information-scope copy rather than becoming another product description.",
      "FAQ question intent and its paired answer must not change. Do not add, remove, merge, split, or reorder FAQ items.",
      "Keep customer caveats direct. Do not turn '개인 차가 있을 수 있습니다' or 'Individual results may vary' into editorial narration about an attached disclaimer, caveat, qualifier, condition, or note.",
      "HowTo fields are punctuation-only: do not change words, actions, amounts, timing, body area, count, or order.",
      "Do not edit reviewBody, names, offers, URLs, identifiers, or schema structure; those fields are intentionally absent.",
      "Write in the existing target locale only. Evidence IDs and immutable tokens are read-only constraints, not material for adding facts.",
      "A field carrying priorRejection is a second attempt: your previous proposal for it was refused for that stated reason. Propose a different correction that does not repeat it, or use action=keep when no correction remains that would satisfy it.",
      "Return only the strict structured JSON requested by the response schema."
    ].join("\n"),
    user: JSON.stringify({
      locale: request.locale,
      market: request.market,
      productName: request.productName,
      brand: request.brand,
      fields: request.fields
    })
  };
}
