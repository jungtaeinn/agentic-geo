import assert from "node:assert/strict";
import test from "node:test";

import { localizeProcessStep } from "../src/app/components/GeoGeneratorConsole";

test("GEO Progress renders structured extractor counts in each UI language", () => {
  const step = {
    id: "ocr" as const,
    title: "OCR 문장/키워드 분석",
    description: "이미지/상세 영역의 효능, 효과, 성분 문장과 키워드 분류",
    status: "done" as const,
    message: "Korean backend text must not be reused as the English description.",
    metrics: { ocrImageCandidateCount: 3 }
  };

  assert.deepEqual(localizeProcessStep(step, "extractor", "en"), {
    title: "Classify OCR keywords",
    description: "Classify benefit, effect, and ingredient keywords from images/detail areas · 3 OCR image candidates"
  });
  assert.deepEqual(localizeProcessStep(step, "extractor", "ko"), {
    title: "OCR 키워드 분류",
    description: "이미지/상세 영역의 효능, 효과, 성분 키워드 분류 · OCR 이미지 후보 3개"
  });
});

test("GEO Progress keeps its static copy for older or invalid extractor metrics", () => {
  const legacyStep = {
    id: "review" as const,
    title: "리뷰 신호 추출",
    description: "평점, 리뷰본문, 대표 키워드, 고객 표현 정리",
    status: "done" as const,
    message: "리뷰 본문 2개와 리뷰 키워드 5개를 정리했습니다."
  };
  const malformedStep = {
    ...legacyStep,
    metrics: { reviewItemCount: -1 }
  };

  assert.deepEqual(localizeProcessStep(legacyStep, "extractor", "en"), {
    title: "Extract review signals",
    description: "Summarize ratings, review text, keywords, and customer phrases"
  });
  assert.deepEqual(localizeProcessStep(malformedStep, "extractor", "ko"), {
    title: "리뷰 신호 추출",
    description: "평점, 리뷰본문, 대표 키워드, 고객 표현 정리"
  });
});
