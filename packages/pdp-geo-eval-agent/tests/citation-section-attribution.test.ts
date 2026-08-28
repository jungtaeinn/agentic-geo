import { describe, expect, it } from "vitest";
import { attributeCitationsToSections, type AttributableSection } from "../src/citation/metrics";

const sections: AttributableSection[] = [
  { id: "description", text: "Botanical Renewal Serum is an anti-aging serum with capsule technology for firmness and fine lines." },
  { id: "howToUse", text: "Apply morning and night after toner, gently pressing into skin until absorbed." },
  { id: "faq", text: "Q: Who is this serum best suited for? A: It suits dry and combination skin concerned with loss of firmness and early wrinkles." },
  { id: "ingredients", text: "" }
];

describe("attributeCitationsToSections", () => {
  it("attributes cited sentences to the section with the highest lexical overlap", () => {
    const answer = [
      "This serum best suits dry and combination skin concerned with firmness [2].",
      "Apply it morning and night after toner, pressing gently until absorbed [2].",
      "Competitor products cost less [0]."
    ].join(" ");

    const attribution = attributeCitationsToSections(answer, 2, sections);
    const ids = attribution.map((item) => item.sectionId);

    expect(ids).toContain("faq");
    expect(ids).toContain("howToUse");
    expect(ids).not.toContain("ingredients");
    const total = attribution.reduce((sum, item) => sum + item.share, 0);
    expect(total).toBeGreaterThan(0.99);
    expect(attribution.reduce((sum, item) => sum + item.citedSentences, 0)).toBe(2);
  });

  it("ignores sentences that cite other sources", () => {
    const answer = "Only competitor content here [0]. And another rival claim [1].";
    expect(attributeCitationsToSections(answer, 2, sections)).toEqual([]);
  });

  it("buckets unmatchable cited sentences into \"other\"", () => {
    const answer = "Completely unrelated financial market commentary about interest rates [2].";
    const attribution = attributeCitationsToSections(answer, 2, sections);
    expect(attribution).toHaveLength(1);
    expect(attribution[0]!.sectionId).toBe("other");
    expect(attribution[0]!.share).toBe(1);
  });

  it("returns the attributed sentences with citation markers stripped", () => {
    const answer = "Apply it morning and night after toner, pressing gently until absorbed [2].";
    const attribution = attributeCitationsToSections(answer, 2, sections);
    expect(attribution[0]!.sectionId).toBe("howToUse");
    expect(attribution[0]!.sentences).toEqual([
      "Apply it morning and night after toner, pressing gently until absorbed."
    ]);
  });

  it("matches Korean tokens despite trailing particles", () => {
    const koreanSections: AttributableSection[] = [
      { id: "ingredients", text: "고밀도 세라마이드 캡슐, 콜레스테롤, 소듐하이알루로네이트" },
      { id: "howToUse", text: "세안 후 스킨케어 첫 단계에 사용해 피부결을 정돈합니다." }
    ];
    const answer = "세라마이드가 함유되어 콜레스테롤과 함께 장벽을 돕습니다 [2]. 세안 직후 첫 단계로 사용하면 피부결이 정돈됩니다 [2].";
    const attribution = attributeCitationsToSections(answer, 2, koreanSections);
    const ids = attribution.map((item) => item.sectionId);
    expect(ids[0]).toBeDefined();
    expect(ids).toContain("ingredients");
    expect(ids).toContain("howToUse");
  });

  it("weights shares by sentence length (word impression parity)", () => {
    const answer = [
      "This anti-aging serum with capsule technology improves firmness and reduces the look of fine lines over time [2].",
      "Apply after toner [2]."
    ].join(" ");
    const attribution = attributeCitationsToSections(answer, 2, sections);
    const description = attribution.find((item) => item.sectionId === "description");
    const howToUse = attribution.find((item) => item.sectionId === "howToUse");
    expect(description).toBeDefined();
    expect(howToUse).toBeDefined();
    expect(description!.share).toBeGreaterThan(howToUse!.share);
  });

  it("returns empty for empty sections or uncited answers", () => {
    expect(attributeCitationsToSections("No citations at all.", 2, sections)).toEqual([]);
    expect(attributeCitationsToSections("Claim [2].", 2, [])).toEqual([]);
  });
});
