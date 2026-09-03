import { describe, expect, it } from "vitest";
import { buildImageAttributableSections } from "../src/citation/image-sections";

describe("buildImageAttributableSections", () => {
  it("groups published sentences by image URL (sentence-level provenance wins)", () => {
    const sections = buildImageAttributableSections([
      {
        fieldPath: "HowTo.step[0].text",
        text: "세안 후 얼굴 전체에 분사합니다. 건조할 때 수시로 사용합니다.",
        imageUrls: ["https://cdn.example.com/usage.png"],
        sentences: [
          { text: "세안 후 얼굴 전체에 분사합니다.", imageUrls: ["https://cdn.example.com/usage.png"] },
          { text: "건조할 때 수시로 사용합니다." }
        ]
      },
      {
        fieldPath: "Product.description",
        sentences: [
          { text: "세라마이드 10,000ppm을 함유했습니다.", imageUrls: ["https://cdn.example.com/metric.png"] },
          { text: "48시간 패치 테스트를 완료했습니다.", imageUrls: ["https://cdn.example.com/metric.png"] }
        ]
      }
    ]);

    expect(sections.map((s) => s.id)).toEqual([
      "https://cdn.example.com/usage.png",
      "https://cdn.example.com/metric.png"
    ]);
    expect(sections[0]!.text).toBe("세안 후 얼굴 전체에 분사합니다.");
    expect(sections[1]!.text).toContain("세라마이드 10,000ppm");
    expect(sections[1]!.text).toContain("48시간 패치");
  });

  it("falls back to entry-level imageUrls when sentences carry none", () => {
    const sections = buildImageAttributableSections([
      {
        fieldPath: "HowTo.step[1].text",
        text: "흔들지 않고 사용합니다.",
        imageUrls: ["https://cdn.example.com/usage.png"]
      }
    ]);
    expect(sections).toEqual([
      { id: "https://cdn.example.com/usage.png", text: "흔들지 않고 사용합니다." }
    ]);
  });

  it("dedupes repeated sentences and skips entries without images", () => {
    const sections = buildImageAttributableSections([
      { fieldPath: "Product.description", text: "이미지 근거 없음 문장." },
      {
        fieldPath: "FAQPage.mainEntity[0].acceptedAnswer.text",
        sentences: [
          { text: "동일 문장.", imageUrls: ["https://cdn.example.com/a.png"] },
          { text: "동일 문장.", imageUrls: ["https://cdn.example.com/a.png"] }
        ]
      }
    ]);
    expect(sections).toEqual([{ id: "https://cdn.example.com/a.png", text: "동일 문장." }]);
  });
});
