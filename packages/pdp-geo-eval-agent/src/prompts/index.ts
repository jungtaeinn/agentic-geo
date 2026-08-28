/**
 * @fileoverview pdp-geo-eval-agent가 LLM에 보내는 프롬프트의 단일 진입점입니다.
 *
 * 이 패키지의 프롬프트는 평가 역할별로 한 파일씩 관리합니다.
 * - citation-answer: 생성형 검색 엔진을 흉내 내 인용 강제 답변을 생성(가시성 벤치마크)
 * - citation-utility: 근거 왜곡 방지용 3종 심판(키포인트 커버리지/클레임 추출/인용 지지)
 * - concept-embodiment: GEO·CEP·E-E-A-T 컨셉이 문안에 체화되었는지 심사
 * - improvement: 평가 결과를 근거로 한 복붙용 개선 프롬프트 생성
 *
 * 규칙: 프롬프트 문자열을 수정할 때는 대응 파서(utility/concept-judge의 parse*)와
 * 벤치마크 채점 로직이 같은 형식을 기대하는지 반드시 함께 확인하세요.
 */
export { CITATION_ANSWER_INSTRUCTIONS, buildCitationAnswerPrompt } from "./citation-answer";
export {
  buildKeypointJudgePrompt,
  buildClaimExtractionPrompt,
  buildCitationSupportPrompt
} from "./citation-utility";
export { buildConceptEmbodimentPrompt } from "./concept-embodiment";
export * from "./improvement";
