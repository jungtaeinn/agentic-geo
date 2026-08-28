/**
 * @fileoverview 하위 호환용 re-export 셤(shim)입니다.
 *
 * 프롬프트 구현은 `src/prompts/` 폴더로 이동했습니다(파이프라인 단계별 한 파일).
 * 기존 import 경로(`./llm/prompt`)를 쓰는 프로바이더 어댑터와 테스트가 수정 없이
 * 동작하도록 이 파일이 새 위치를 그대로 다시 내보냅니다.
 * 새 코드는 `../prompts`에서 직접 import 하세요.
 */
export { createImageOcrPrompt } from "../prompts/image-ocr";
export {
  createKeywordClassificationPrompt,
  createKeywordClassificationPromptParts,
  type KeywordClassificationPromptParts
} from "../prompts/keyword-classification";
