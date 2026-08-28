/**
 * @fileoverview pdp-extractor-agent가 LLM에 보내는 모든 프롬프트의 단일 진입점입니다.
 *
 * 이 패키지의 프롬프트는 파이프라인 단계별로 한 파일씩 관리합니다.
 * - image-ocr: 상품 상세 이미지의 보이는 텍스트를 원문 그대로 전사(OCR)
 * - keyword-classification: 전사된 텍스트를 상품 근거(효능/성분/사용법 등)로 분류
 * - product-profile-normalization: 추출된 상품 프로필의 필드 배치를 보수적으로 정규화
 *
 * 규칙: 프롬프트 문자열을 수정할 때는 다운스트림 파서·평가 기준(quality gate)에
 * 영향이 없는지 반드시 확인하세요. 데이터 선별·후처리 로직은 이 폴더가 아니라
 * 각 파이프라인 모듈에 둡니다(프롬프트 모듈은 "데이터를 받아 문자열을 만드는" 역할만).
 */
export { createImageOcrPrompt } from "./image-ocr";
export {
  createKeywordClassificationPrompt,
  createKeywordClassificationPromptParts,
  type KeywordClassificationPromptParts
} from "./keyword-classification";
export { createProductProfileNormalizationPrompt } from "./product-profile-normalization";
