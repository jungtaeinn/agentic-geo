import { describe, expect, it } from "vitest";
import { ocrLayoutSections, verifyOcrLayoutGroups } from "../src/ocr-layout-relations";
import { chartProbeGroups, clinicalPanelProbeGroups, summaryProbeGroups } from "./fixtures/ocr-layout-probe";

/**
 * 모델이 보고한 관계는 전사가 뒷받침할 때만 관계다. 뒷받침하지 않는 것은
 * 환각이므로, 검증은 최종 전사를 기준으로 한다.
 *
 * 다만 "하나라도 어긋나면 전부 폐기"로 만들면 안 된다. 라인이 정상적으로
 * 사라지는 경로가 둘 있다 — 2회 판독 대조가 불일치 토큰을 덜어내고, 슬라이스
 * 오버랩 제거가 앞 슬라이스 소유의 줄을 걷어낸다.
 */
describe("verifyOcrLayoutGroups", () => {
  it("keeps groups whose lines all appear in the transcription", () => {
    const groups = [{ id: "g1", title: "효능", lines: [{ text: "효능", role: "title" as const }] }];

    expect(verifyOcrLayoutGroups("효능\n1\n장벽 손상 방어", groups)).toEqual(groups);
  });

  it("drops only the line the transcription does not back", () => {
    const verified = verifyOcrLayoutGroups("효능\n장벽 손상 방어", [{
      id: "g1",
      lines: [
        { text: "장벽 손상 방어", role: "body" as const },
        { text: "휘경보건 피부과에서", role: "body" as const }
      ]
    }]);

    expect(verified?.[0]?.lines).toEqual([{ text: "장벽 손상 방어", role: "body" }]);
  });

  it("discards the whole structure when most lines are unbacked", () => {
    const verified = verifyOcrLayoutGroups("효능", [{
      id: "g1",
      lines: [
        { text: "효능", role: "title" as const },
        { text: "없는 문장 하나", role: "body" as const },
        { text: "없는 문장 둘", role: "body" as const }
      ]
    }]);

    expect(verified).toBeUndefined();
  });

  it("drops a title the transcription does not back", () => {
    const verified = verifyOcrLayoutGroups("장벽 손상 방어", [{
      id: "g1",
      title: "핵심 성분",
      lines: [{ text: "장벽 손상 방어", role: "body" as const }]
    }]);

    expect(verified?.[0]?.title).toBeUndefined();
  });

  it("ignores a dangling reference without discarding the structure", () => {
    const verified = verifyOcrLayoutGroups("각주 문장입니다", [{
      id: "g1",
      parentId: "nope",
      annotates: "gone",
      lines: [{ text: "각주 문장입니다", role: "footnote" as const }]
    }]);

    expect(verified).toEqual([{ id: "g1", lines: [{ text: "각주 문장입니다", role: "footnote" }] }]);
  });

  it("ignores a self reference", () => {
    const verified = verifyOcrLayoutGroups("각주 문장입니다", [{
      id: "g1",
      parentId: "g1",
      lines: [{ text: "각주 문장입니다", role: "footnote" as const }]
    }]);

    expect(verified?.[0]?.parentId).toBeUndefined();
  });

  it("compares on normalized whitespace so a wrapped label still matches", () => {
    const verified = verifyOcrLayoutGroups("자사\n일반제품", [{
      id: "g1",
      lines: [{ text: "자사 일반제품", role: "label" as const }]
    }]);

    expect(verified?.[0]?.lines).toHaveLength(1);
  });

  it("reports nothing when the model reported no groups", () => {
    expect(verifyOcrLayoutGroups("효능", [])).toBeUndefined();
  });
});

/**
 * 구조는 줄 파서와 같은 내부 모델로 수렴해야 한다. 그래야 다운스트림이
 * 생산자를 구분하지 않고 그대로 돌아간다.
 */
describe("ocrLayoutSections", () => {
  it("turns a titled group with numbered children into a section with ordered items", () => {
    expect(ocrLayoutSections(summaryProbeGroups)).toEqual([
      {
        heading: "효능",
        items: [
          { ordinal: 1, text: "약산성 아미노산 유래 세정 성분으로 장벽 손상 방어" },
          { ordinal: 2, text: "가벼운 메이크업 세정력" }
        ]
      },
      { heading: "핵심 성분", items: [{ text: "Barrier Protective Formula (판테놀, 베타인, 보타온)" }] },
      { heading: "추천 피부 타입", items: [{ text: "건조 피부 또는 민감 피부" }] }
    ]);
  });

  it("never turns a label, value, or footnote line into an item", () => {
    const items = ocrLayoutSections(chartProbeGroups).flatMap((section) => section.items.map((item) => item.text));

    expect(items).toEqual([]);
  });

  it("keeps a chart title as its section heading even when the chart has no prose", () => {
    expect(ocrLayoutSections(chartProbeGroups)[0]?.heading).toBe("피부 각질층 내 세라마이드 함량 분석");
  });

  it("keeps a headless panel's prose as one item", () => {
    // 각주만 담은 그룹은 절을 만들지 않는다. 제목도 본문도 없으므로 실을 값이
    // 없고, 빈 절을 내보내면 다운스트림에 잡음만 남는다.
    expect(ocrLayoutSections(clinicalPanelProbeGroups)).toEqual([
      { items: [{ text: "집앞 나갈때 가볍게 하는 색조 메이크업 97.1% 세정" }] }
    ]);
  });

  it("normalizes a line break inside one line", () => {
    const sections = ocrLayoutSections([{
      id: "g1",
      title: "핵심 성분",
      lines: [{ text: "Barrier\nProtective Formula", role: "body" }]
    }]);

    expect(sections[0]?.items).toEqual([{ text: "Barrier Protective Formula" }]);
  });
});

/**
 * 프롬프트가 중첩을 적극 유도한다("a chart body under its caption"). 손자
 * 그룹까지 훑지 않으면 그 이미지의 유일한 산문이 아무 필드에도 도달하지 못하고,
 * 정족수를 통과했으므로 줄 파서로 되돌아가지도 않는다.
 */
describe("ocrLayoutSections의 중첩", () => {
  it("carries a grandchild group's prose into its top-level section", () => {
    const sections = ocrLayoutSections([
      { id: "g1", title: "CLINICAL RESULTS", lines: [{ text: "CLINICAL RESULTS", role: "title" as const }] },
      {
        id: "g2",
        parentId: "g1",
        title: "Skin barrier recovery",
        lines: [{ text: "Skin barrier recovery", role: "title" as const }]
      },
      {
        id: "g3",
        parentId: "g2",
        lines: [{ text: "Improved after 4 weeks of use in a clinical study.", role: "body" as const }]
      }
    ]);

    expect(sections).toEqual([{
      heading: "CLINICAL RESULTS",
      items: [{ text: "Improved after 4 weeks of use in a clinical study." }]
    }]);
  });
});

/**
 * 값 라인의 뒷받침 검사가 가장 약한 자리다. 정규화가 부호와 공백을 다 지우므로
 * `+63.6%`는 `636`이 되고, 전사 어디든 그 숫자열이 들어 있으면 통과했다 —
 * 다른 수치의 일부여도 마찬가지다. 값 라인이 곧 발행되는 수치이므로, 환각
 * 방어가 가장 필요한 지점이었다.
 */
describe("값 라인의 뒷받침", () => {
  it("does not accept a value backed only by digits inside another figure", () => {
    const verified = verifyOcrLayoutGroups("각질층 수분\n1636 ppm 함유\n측정 결과", [{
      id: "g1",
      title: "각질층 수분",
      lines: [
        { text: "각질층 수분", role: "title" as const },
        { text: "+63.6%", role: "value" as const, pairedLabel: "4주 후" }
      ]
    }]);

    expect(verified?.[0]?.lines.some((line) => line.role === "value")).toBe(false);
  });

  it("still accepts a value the transcription states", () => {
    const verified = verifyOcrLayoutGroups("각질층 수분\n+63.6%\n4주 후", [{
      id: "g1",
      title: "각질층 수분",
      lines: [
        { text: "각질층 수분", role: "title" as const },
        { text: "+63.6%", role: "value" as const, pairedLabel: "4주 후" }
      ]
    }]);

    expect(verified?.[0]?.lines.some((line) => line.role === "value")).toBe(true);
  });
});
