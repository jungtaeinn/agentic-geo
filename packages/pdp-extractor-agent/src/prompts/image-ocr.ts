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
 * 왜 전사와 구조만 시키는가:
 * - 전사(OCR)와 의미 분류를 한 번의 호출에 합치면 누락과 환각(없는 문구 생성)이
 *   눈에 띄게 늘어납니다. 그래서 이 프롬프트는 "보이는 글자 복사"와 "눈에 보이는
 *   묶음 관계"만 담당하고, 의미 해석은 keyword-classification 프롬프트가 담당합니다.
 * - 관계를 함께 받는 이유: 절 제목과 항목, 나란한 패널, 차트의 값과 눈금, 각주가
 *   한정하는 대상은 레이아웃으로만 표현됩니다. 읽기순서 문자열로 눌러 담으면 그
 *   관계가 전사 시점에 소멸하고, 이후 어떤 코드도 복원할 수 없습니다.
 * - 관계도 "본 것"에 한정합니다. 무엇이 효능이고 무엇이 성분인지는 여기서 묻지
 *   않습니다 — 그건 상품마다 다른 판단이고, 계약에 템플릿을 넣으면 이미지 포맷이
 *   바뀔 때마다 깨집니다.
 *
 * @param request 이미지 URL 목록과 상품명/출처 등 라벨링 정보
 * @returns 모델에 전달할 단일 사용자 프롬프트 문자열
 */
export function createImageOcrPrompt(request: ImageTextExtractionRequest): string {
  return [
    "Transcribe visible text from product detail page images for a GEO product extraction pipeline.",
    "Return strict JSON only: {\"images\":[{\"index\":1,\"imageUrl\":\"\",\"text\":\"\",\"confidence\":0.0,\"groups\":[{\"id\":\"g1\",\"parentId\":null,\"title\":null,\"ordinal\":null,\"annotates\":null,\"lines\":[{\"text\":\"\",\"role\":\"body\",\"pairedLabel\":null}]}]}]}",
    "index is the 1-based image number exactly as labeled below. imageUrl is the labeled URL for that image. Never swap text between images.",
    "Transcribe every piece of readable text faithfully in natural reading order (top to bottom, left to right; finish one column before the next).",
    "Do not summarize, rewrite, translate, or infer claims. Keep the original language: Korean text stays Korean.",
    "Never complete text that is cut off, truncated, or hidden. Transcribe only what is actually visible; if a word is partially legible, transcribe the legible part only.",
    "Preserve visible line order, percentages, numeric values, units, footnote markers, row/column labels, and short headings as plain text lines.",
    "For tables, ingredient charts, clinical result images, and comparison blocks, keep each row's label and value together on one line.",
    "If an image has no readable product text, return an empty string for that image.",
    "Set confidence between 0 and 1 for each image: how legible and complete the transcription is (small, blurry, or partially cropped text lowers it).",
    "",
    "Also report the layout relations you can see, as groups. Report structure only — never interpret meaning, never classify marketing intent, never invent text.",
    "Every image is a set of groups of lines. Do not assume any template: images differ, and a group is simply text the layout visually keeps together (a titled block, a panel, a chart, a package shot, a footnote).",
    "Give each group a short id (g1, g2 ...). Use parentId when a group sits inside another, such as a numbered item under a titled section or a chart body under its caption.",
    "title: the group's own heading, only when the layout sets one apart (larger, bolder, or centered above its content). null otherwise.",
    "ordinal: only the number the layout actually printed for that group (1, 2, STEP 3). null otherwise. Never number groups yourself.",
    "annotates: for a footnote, disclaimer, or test-condition group, the id of the group it qualifies. null when it qualifies nothing in particular.",
    "lines[].role is the line's layout function: title (heading text), body (running prose), label (an axis tick, legend name, chart caption, package spec, before/after caption), value (a measured number or badge), footnote (fine print, asterisked note).",
    "lines[].pairedLabel: for a value line, the label it is printed against (its bar's tick, its badge caption). null when the layout does not pair it.",
    "Every line you place in a group must appear verbatim in that image's text.",
    `Source: ${request.source}`,
    `Product name: ${request.productName ?? "unknown"}`,
    ...request.imageUrls.map((imageUrl, index) => `Image ${index + 1}: ${imageUrl}`)
  ].join("\n");
}
