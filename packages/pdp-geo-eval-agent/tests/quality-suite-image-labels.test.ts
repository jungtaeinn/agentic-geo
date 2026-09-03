import { describe, expect, it } from "vitest";
import { formatImageSectionId, getEvaluationSuiteCopy } from "../src/quality/suite";

// 리뷰 결함(2026-09-01, final-review-opus): 이미지 인용 기여에서 근거
// 없음을 뜻하는 센티넬 "other"가 그대로 노출되어 한국어 콘솔에
// "other 78%" 같은 원문 문자열이 떴다. 이미지 차원에서는 보통 "other"가
// 최대 지분을 차지해 첫 줄에 노출되므로 반드시 현지화 라벨을 써야 한다.
describe("formatImageSectionId", () => {
  it("localizes the \"other\" sentinel instead of leaking the raw id (ko)", () => {
    const suite = getEvaluationSuiteCopy("ko");
    expect(formatImageSectionId("other", suite)).toBe(suite.imageOtherLabel);
    expect(formatImageSectionId("other", suite)).not.toBe("other");
  });

  it("localizes the \"other\" sentinel instead of leaking the raw id (en)", () => {
    const suite = getEvaluationSuiteCopy("en");
    expect(formatImageSectionId("other", suite)).toBe(suite.imageOtherLabel);
    expect(formatImageSectionId("other", suite)).not.toBe("other");
  });

  it("still shows the URL basename for a real image id", () => {
    const suite = getEvaluationSuiteCopy("ko");
    expect(formatImageSectionId("https://cdn.example.com/products/abc/detail-01.jpg?v=2", suite)).toBe("detail-01.jpg");
  });
});
