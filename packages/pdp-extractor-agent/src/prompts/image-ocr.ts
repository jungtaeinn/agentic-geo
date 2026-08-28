/** @fileoverview PDP 이미지의 보이는 텍스트를 전사하는 비전 OCR 프롬프트. */
import type { ImageTextExtractionRequest } from "../llm/types";

/**
 * 상품 상세 이미지의 "보이는 텍스트"를 원문 그대로 옮겨 적게 하는 프롬프트를 만듭니다.
 *
 * 무엇을 하는가:
 * - 상품 상세 이미지 여러 장을 번호로 라벨링해 주고, 각 이미지에 실제로 보이는
 *   글자를 요약·번역·추측 없이 전사(transcribe)한 JSON을 돌려받습니다.
 * - 이 결과는 다음 단계인 keyword-classification 프롬프트의 근거 입력이 됩니다.
 *
 * 왜 전사만 시키는가:
 * - 전사(OCR)와 의미 분류를 한 번의 호출에 합치면 누락과 환각(없는 문구 생성)이
 *   눈에 띄게 늘어납니다. 그래서 이 프롬프트는 "보이는 글자 복사"만 담당하고,
 *   의미 해석은 keyword-classification 프롬프트가 담당합니다.
 *
 * @param request 이미지 URL 목록과 상품명/출처 등 라벨링 정보
 * @returns 모델에 전달할 단일 사용자 프롬프트 문자열
 */
export function createImageOcrPrompt(request: ImageTextExtractionRequest): string {
  return [
    "Transcribe visible text from product detail page images for a GEO product extraction pipeline.",
    "Return strict JSON only: {\"images\":[{\"index\":1,\"imageUrl\":\"\",\"text\":\"\",\"confidence\":0.0}]}",
    "index is the 1-based image number exactly as labeled below. imageUrl is the labeled URL for that image. Never swap text between images.",
    "Transcribe every piece of readable text faithfully in natural reading order (top to bottom, left to right; finish one column before the next).",
    "Do not summarize, rewrite, translate, or infer claims. Keep the original language: Korean text stays Korean.",
    "Never complete text that is cut off, truncated, or hidden. Transcribe only what is actually visible; if a word is partially legible, transcribe the legible part only.",
    "Preserve visible line order, percentages, numeric values, units, footnote markers, row/column labels, and short headings as plain text lines.",
    "For tables, ingredient charts, clinical result images, and comparison blocks, keep each row's label and value together on one line.",
    "If an image has no readable product text, return an empty string for that image.",
    "Set confidence between 0 and 1 for each image: how legible and complete the transcription is (small, blurry, or partially cropped text lowers it).",
    `Source: ${request.source}`,
    `Product name: ${request.productName ?? "unknown"}`,
    ...request.imageUrls.map((imageUrl, index) => `Image ${index + 1}: ${imageUrl}`)
  ].join("\n");
}
