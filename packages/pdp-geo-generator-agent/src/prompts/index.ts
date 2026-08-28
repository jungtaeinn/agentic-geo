/**
 * @fileoverview pdp-geo-generator-agent가 LLM에 보내는 프롬프트의 단일 진입점입니다.
 *
 * 이 패키지의 프롬프트는 생성 파이프라인 단계별로 한 파일씩 관리합니다.
 * - product-normalization: 원본 상품 데이터를 역할별 필드로 보수적으로 정규화
 * - keyword-normalization: 리뷰 키워드의 명백한 오타만 교정
 * - content-planning: 근거 원장 기반으로 공개 문안 계획(plan) 수립
 * - copy-refinement: 계획된 문안을 인용되기 좋은 공개 카피로 정제(system 지시문)
 * - final-proofreading: 승인된 문안의 유창성만 최종 교정
 *
 * 규칙: 프롬프트 문자열을 수정할 때는 다운스트림 파서·품질 게이트 기준에 영향이
 * 없는지 반드시 확인하세요. 데이터 선별·후처리 로직은 이 폴더가 아니라 각
 * 파이프라인 모듈에 둡니다(프롬프트 모듈은 "데이터를 받아 문자열을 만드는" 역할만).
 */
export { createPlanningPrompt } from "./content-planning";
export { createCopyRefinementSystemPrompt } from "./copy-refinement";
export { createProductNormalizationPrompt } from "./product-normalization";
export { createKeywordNormalizationPrompt } from "./keyword-normalization";
export { createFinalProofreadingPrompt } from "./final-proofreading";
