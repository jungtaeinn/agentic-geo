/**
 * @fileoverview GEU 유틸리티 가드레일(품질 심판) 3종 프롬프트 모듈.
 * 인용 가시성 점수가 "근거 왜곡" 위에서 오르는 것을 막습니다(AutoGEO geu_score.py 이식).
 * 세 빌더 모두 순수 함수이며, 응답 파서와 채점기는 citation/utility.ts에 있습니다.
 */
import type { EvalEvidenceItem } from "../types";

/**
 * 키포인트 커버리지 심판 프롬프트를 만듭니다.
 *
 * 무엇을 하는가:
 * - 근거 원장(evidence ledger)의 각 항목(Key Point)에 대해, 생성된 공개 문안이
 *   그 항목을 지지(Supported)/누락(Omitted)/모순(Contradicted) 중 무엇으로
 *   다루는지 근거 문구 인용과 함께 판정하게 합니다.
 * - 수치·단위·성분·클레임 강도·출처가 다르면 모순으로 판정합니다. 화장품 도메인의
 *   릴리즈 게이트: 가시성 향상이 근거의 의미 왜곡 위에서 이뤄지면 안 됩니다.
 *
 * @param evidence 근거 원장 항목 목록(키포인트로 사용)
 * @param publicText 심사 대상 공개 문안 전문
 * @returns system(판정 지시) / user(키포인트+문안) 프롬프트 쌍
 */
export function buildKeypointJudgePrompt(
  evidence: EvalEvidenceItem[],
  publicText: string
): { system: string; user: string } {
  const keypoints = evidence.map((item) => ({ id: item.id, role: item.role, content: item.text }));
  return {
    system: "You are a meticulous fact-checker for product content. Respond strictly with the requested JSON object and nothing else.",
    user: `You are given a JSON array of Key Points (atomic product evidence) and a Document (public product copy).
For EACH Key Point, determine if the Document:
- "Supported": contains information consistent with and supporting the Key Point.
- "Omitted": does not mention or cover the Key Point.
- "Contradicted": states something that disagrees with the Key Point (different numbers, units, ingredients, claim strength, or attribution count as contradictions).

Return a single JSON object. The keys must be the Key Point "id" values. Each value must be an object with:
- "label": one of "Supported", "Omitted", "Contradicted"
- "justification": a brief, specific explanation citing the relevant document wording

Respond ONLY with the JSON object.

---
Key Points:
${JSON.stringify(keypoints, null, 2)}

---
Document:
${publicText}`
  };
}

/**
 * 클레임 추출 프롬프트를 만듭니다.
 *
 * 무엇을 하는가:
 * - 시뮬레이션 엔진이 생성한 답변에서 "사실 클레임"만 골라내고, 각 클레임이
 *   인용한 소스 인덱스([0], [1][2] 등)를 정수 배열로 추출하게 합니다.
 * - 추출된 클레임은 buildCitationSupportPrompt로 소스 지지 여부를 검증합니다.
 *
 * @param answer 시뮬레이션 엔진이 생성한 인용 포함 답변
 * @returns system(추출 지시) / user(답변 본문) 프롬프트 쌍
 */
export function buildClaimExtractionPrompt(answer: string): { system: string; user: string } {
  return {
    system: "You are an information extraction expert. Respond strictly with the requested JSON object and nothing else.",
    user: `Given a report, extract all distinct factual claims. For each claim, identify the source indices it cites (e.g., [0], [1], [2][3]).

Return a JSON object with a "claims" list, where each entry has:
- "claimId": a sequential integer starting from 1.
- "claim": a concise, complete sentence of the claim.
- "sourceIndices": a list of integer indices cited for this claim. If no source is cited, return an empty list [].

IMPORTANT:
- Only extract factual claims, not opinions or summaries.
- The source indices must be integers extracted directly from citations like [0] or [1][2].

Report to process:
"""
${answer}
"""

Return the JSON object and nothing else.`
  };
}

/**
 * 인용 지지(citation support) 판정 프롬프트를 만듭니다.
 *
 * 무엇을 하는가:
 * - 클레임 한 문장이 해당 소스 텍스트로 뒷받침되는지를
 *   full_support / partial_support / no_support 3단계와 판정 사유로 답하게 합니다.
 * - 클레임 단위 정밀도(precision) 채점의 재료가 됩니다.
 *
 * @param claim 검증할 사실 클레임 한 문장
 * @param sourceText 그 클레임이 인용한 소스 텍스트
 * @returns system(판정 지시) / user(클레임+소스) 프롬프트 쌍
 */
export function buildCitationSupportPrompt(claim: string, sourceText: string): { system: string; user: string } {
  return {
    system: "You are a meticulous fact-checker. Respond strictly with the requested JSON object and nothing else.",
    user: `Evaluate if a "Statement" is supported by the "Source Text".
Respond strictly in JSON format with "support" ('full_support', 'partial_support', or 'no_support') and a brief "justification".

- "full_support": all information in the statement is directly supported by the source text.
- "partial_support": some parts are supported, but other parts are not.
- "no_support": the source text does not support the statement.

Statement: "${claim}"

Source Text:
"""
${sourceText}
"""

Your JSON response:`
  };
}
