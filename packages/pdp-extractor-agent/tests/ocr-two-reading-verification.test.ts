import { describe, expect, it } from "vitest";
import { reconcileOcrReadings } from "../src/agent";

/**
 * The EXAMPLEDERMA 모이베리어 365 크림 미스트 detail image reads "대학병원 피부과에서".
 * A transcription returned "휘경보건 피부과에서" and reported 0.91 confidence, so
 * a clinic that does not exist entered the pipeline and was published as a
 * statement about a real third party.
 *
 * Confidence is the model's opinion of its own reading and it was wrong here,
 * so verification cannot come from the reading itself. Two independent readings
 * disagree at exactly the place one of them invented something, and keeping
 * only the agreed tokens turns an invented name into an absent one — the
 * failure this pipeline can afford.
 */
const FIRST = "철저히 검증한 피부 안전성 테스트 피부과 테스트 휘경보건 피부과에서 48시간 패치를 활용한 자극여부 확인 22.12.19-22.12.22, 32명 대상";
const SECOND = "철저히 검증한 피부 안전성 테스트 피부과 테스트 대학병원 피부과에서 48시간 패치를 활용한 자극여부 확인 22.12.19-22.12.22, 32명 대상";

describe("two-reading OCR verification", () => {
  it("drops a proper noun the two readings disagree on", () => {
    const { text, droppedTokens } = reconcileOcrReadings(FIRST, SECOND);

    expect(text).not.toContain("휘경보건");
    // The disagreement is reported so an operator can see what was withheld.
    expect(droppedTokens.join(" ")).toContain("휘경보건");
  });

  it("keeps everything the two readings agree on", () => {
    const { text } = reconcileOcrReadings(FIRST, SECOND);

    expect(text).toContain("피부과 테스트");
    expect(text).toContain("48시간 패치를 활용한 자극여부 확인");
    expect(text).toContain("32명 대상");
  });

  it("keeps an identical reading untouched", () => {
    const { text, droppedTokens } = reconcileOcrReadings(SECOND, SECOND);

    expect(text).toBe(SECOND);
    expect(droppedTokens).toHaveLength(0);
  });

  it("tolerates harmless spacing and line-break differences", () => {
    // Two readings of the same block differ in layout all the time; discarding
    // real text over that would lose more than it protects.
    const spaced = "피부과  테스트\n대학병원 피부과에서 48시간 패치";
    const plain = "피부과 테스트 대학병원 피부과에서 48시간 패치";
    const { text, droppedTokens } = reconcileOcrReadings(spaced, plain);

    expect(droppedTokens).toHaveLength(0);
    expect(text).toContain("대학병원");
    expect(text).toContain("48시간 패치");
  });

  it("keeps the first reading whole when the two readings are not of the same content", () => {
    // Intersecting broadly different readings would shred both into a text
    // neither reported. Removing invented words is the goal; assembling a
    // third version out of two disagreements is not.
    const other = "전혀 다른 구간의 성분 설명과 사용법 안내가 담긴 문장입니다";
    const { text, droppedTokens } = reconcileOcrReadings(FIRST, other);

    expect(text).toBe(FIRST);
    expect(droppedTokens).toHaveLength(0);
  });

  it("keeps a repeated token only as often as both readings repeat it", () => {
    // A reading that duplicates a line must not have the duplicate confirmed
    // by a single occurrence in the other reading.
    const { text } = reconcileOcrReadings("세라마이드 세라마이드 캡슐", "세라마이드 캡슐");

    expect(text).toBe("세라마이드 캡슐");
  });
});
