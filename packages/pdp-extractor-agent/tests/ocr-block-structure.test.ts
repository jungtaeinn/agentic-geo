import { describe, expect, it } from "vitest";
import { parseOcrBlockSections } from "../src/ocr-block-structure";

/**
 * OCR 블록은 "절(헤딩) → 항목(서수)" 관계를 눈으로 표현한 레이아웃이다.
 * 파서는 그 관계를 구조로 복원해야 하며, 도메인 단어 목록에 의존하지 않는다.
 */
describe("parseOcrBlockSections", () => {
  it("splits a three-section summary image into its headings and items", () => {
    const sections = parseOcrBlockSections([
      "효능",
      "1",
      "약산성 아미노산 유래 세정 성분으로",
      "장벽 손상 방어",
      "2",
      "가벼운 메이크업 세정력",
      "핵심 성분",
      "Barrier Protective Formula",
      "(판테놀, 베타인, 보타온)",
      "추천 피부 타입",
      "건조 피부 또는 민감 피부"
    ].join("\n"));

    expect(sections).toEqual([
      {
        heading: "효능",
        items: [
          { ordinal: 1, text: "약산성 아미노산 유래 세정 성분으로 장벽 손상 방어" },
          { ordinal: 2, text: "가벼운 메이크업 세정력" }
        ]
      },
      {
        heading: "핵심 성분",
        items: [{ text: "Barrier Protective Formula (판테놀, 베타인, 보타온)" }]
      },
      {
        heading: "추천 피부 타입",
        items: [{ text: "건조 피부 또는 민감 피부" }]
      }
    ]);
  });

  it("keeps each numbered usage step separate while joining its wrapped lines", () => {
    const sections = parseOcrBlockSections([
      "사용법",
      "1",
      "클렌징 단계에서 젖은 손에 적당량을 덜어",
      "충분히 거품을 내주세요.",
      "2",
      "얼굴에 부드럽게 롤링하여",
      "노폐물을 녹여낸 후",
      "미온수로 깨끗이 씻어줍니다."
    ].join("\n"));

    expect(sections).toEqual([
      {
        heading: "사용법",
        items: [
          { ordinal: 1, text: "클렌징 단계에서 젖은 손에 적당량을 덜어 충분히 거품을 내주세요." },
          { ordinal: 2, text: "얼굴에 부드럽게 롤링하여 노폐물을 녹여낸 후 미온수로 깨끗이 씻어줍니다." }
        ]
      }
    ]);
  });

  it("treats any heading-shaped line as a section boundary so a label never becomes a value", () => {
    const sections = parseOcrBlockSections(["핵심 성분", "Barrier Protective Formula", "추천 피부 타입", "건조 피부 또는 민감 피부"].join("\n"));

    expect(sections).toEqual([
      { heading: "핵심 성분", items: [{ text: "Barrier Protective Formula" }] },
      { heading: "추천 피부 타입", items: [{ text: "건조 피부 또는 민감 피부" }] }
    ]);
  });

  it("resumes a numbered section when peripheral lines interrupt its ordinals", () => {
    const sections = parseOcrBlockSections([
      "사용법",
      "1",
      "클렌징 단계에서 젖은 손에 적당량을 덜어",
      "충분히 거품을 내주세요.",
      "EXAMPLEDERMA",
      "BARRIERCARE 365",
      "CLEANSING FOAM",
      "2",
      "얼굴에 부드럽게 롤링하여",
      "미온수로 깨끗이 씻어줍니다."
    ].join("\n"));

    const usageSection = sections.find((section) => section.heading === "사용법");
    expect(usageSection?.items).toEqual([
      { ordinal: 1, text: "클렌징 단계에서 젖은 손에 적당량을 덜어 충분히 거품을 내주세요." },
      { ordinal: 2, text: "얼굴에 부드럽게 롤링하여 미온수로 깨끗이 씻어줍니다." }
    ]);
    // 주변 텍스트는 사용법 절의 항목이 아니다.
    expect(usageSection?.items.some((item) => /EXAMPLEDERMA|CLEANSING/.test(item.text))).toBe(false);
  });
});

/**
 * 영문 PDP도 같은 관계를 갖는다. 다만 같은 뜻의 제목이 훨씬 길다 — `핵심 성분`은
 * 다섯 자인데 `KEY INGREDIENTS`는 열다섯 자다. 제목의 구조적 성질은 "짧다"이고,
 * 짧음의 척도는 문자 체계마다 다르다.
 */
describe("parseOcrBlockSections — 영문 레이아웃", () => {
  it("splits an English three-section summary into its headings and items", () => {
    const sections = parseOcrBlockSections([
      "BENEFITS",
      "1",
      "Mildly acidic amino-acid derived",
      "cleansing agents guard the barrier",
      "2",
      "Light makeup cleansing power",
      "KEY INGREDIENTS",
      "Barrier Protective Formula",
      "(Panthenol, Betaine, BotanON)",
      "RECOMMENDED FOR",
      "Dry or sensitive skin"
    ].join("\n"));

    expect(sections).toEqual([
      {
        heading: "BENEFITS",
        items: [
          { ordinal: 1, text: "Mildly acidic amino-acid derived cleansing agents guard the barrier" },
          { ordinal: 2, text: "Light makeup cleansing power" }
        ]
      },
      {
        heading: "KEY INGREDIENTS",
        items: [{ text: "Barrier Protective Formula (Panthenol, Betaine, BotanON)" }]
      },
      {
        heading: "RECOMMENDED FOR",
        items: [{ text: "Dry or sensitive skin" }]
      }
    ]);
  });

  it("keeps each numbered English usage step separate", () => {
    const sections = parseOcrBlockSections([
      "HOW TO USE",
      "1",
      "Dispense an appropriate amount",
      "onto wet hands and lather.",
      "2",
      "Gently roll over the face",
      "then rinse with lukewarm water."
    ].join("\n"));

    expect(sections).toEqual([
      {
        heading: "HOW TO USE",
        items: [
          { ordinal: 1, text: "Dispense an appropriate amount onto wet hands and lather." },
          { ordinal: 2, text: "Gently roll over the face then rinse with lukewarm water." }
        ]
      }
    ]);
  });

  it("does not read a running English sentence as a heading", () => {
    // 라틴 문턱을 넓히더라도 문장이 제목이 되면 안 된다.
    const sections = parseOcrBlockSections([
      "Clinically tested for sensitive skin",
      "Dermatologist tested"
    ].join("\n"));

    expect(sections[0]?.heading).toBeUndefined();
  });
});
