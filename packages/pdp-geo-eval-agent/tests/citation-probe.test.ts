import { describe, expect, it } from "vitest";
import { buildProbeDistractors, deriveProbeQueries, type CitationProbeContext } from "../src/citation/probe";

/**
 * Deterministic tests for the inline citation probe's query derivation and
 * distractor templates. The engine-calling path is covered by the shared
 * metrics/gate tests plus the opt-in probe run itself.
 */

const baseContext: CitationProbeContext = {
  generatedText: "generated",
  vanillaText: "vanilla",
  locale: "ko-KR",
  category: "토너",
  benefits: ["장벽 보습"]
};

describe("deriveProbeQueries", () => {
  it("prefers included content-plan FAQ questions over templates", () => {
    const queries = deriveProbeQueries({
      ...baseContext,
      contentPlan: {
        faq: [
          { include: true, question: "여드름성 피부도 사용할 수 있나요?" },
          { include: false, question: "제외된 질문인가요?" }
        ],
        cep: []
      }
    }, 3);

    expect(queries[0]).toEqual({ query: "여드름성 피부도 사용할 수 있나요?", source: "content-plan-faq" });
    expect(queries.some((query) => query.query === "제외된 질문인가요?")).toBe(false);
    expect(queries).toHaveLength(3);
    expect(queries.slice(1).every((query) => query.source === "template")).toBe(true);
  });

  it("converts CEP entries into locale-matching questions", () => {
    const queries = deriveProbeQueries({
      ...baseContext,
      contentPlan: {
        faq: [],
        cep: [{ situation: "세안 직후", need: "속당김 완화" }]
      }
    }, 2);

    expect(queries[0]?.source).toBe("content-plan-cep");
    expect(queries[0]?.query).toContain("속당김 완화");
    expect(queries[0]?.query).toContain("토너");
  });

  it("falls back to category/benefit templates in English for en locales", () => {
    const queries = deriveProbeQueries({
      ...baseContext,
      locale: "en-US",
      category: "serum",
      benefits: ["firming"]
    }, 3);

    expect(queries).toHaveLength(3);
    expect(queries.every((query) => query.source === "template")).toBe(true);
    expect(queries[0]?.query).toBe("What serum is good for firming?");
  });

  it("deduplicates repeated questions and respects maxQueries", () => {
    const queries = deriveProbeQueries({
      ...baseContext,
      contentPlan: {
        faq: [
          { include: true, question: "같은 질문인가요?" },
          { include: true, question: "같은 질문인가요?" }
        ],
        cep: []
      }
    }, 2);

    expect(queries).toHaveLength(2);
    expect(queries.filter((query) => query.query === "같은 질문인가요?")).toHaveLength(1);
  });

  it("uses a generic product noun when category is missing", () => {
    const queries = deriveProbeQueries({ ...baseContext, category: undefined, benefits: [] }, 1);
    expect(queries[0]?.query).toContain("제품");
  });
});

describe("buildProbeDistractors", () => {
  it("returns four locale-matching documents parameterized by category", () => {
    const korean = buildProbeDistractors("ko-KR", "토너");
    const english = buildProbeDistractors("en-US", "serum");

    expect(korean).toHaveLength(4);
    expect(english).toHaveLength(4);
    expect(korean.every((doc) => doc.includes("토너"))).toBe(true);
    expect(english.every((doc) => doc.includes("serum"))).toBe(true);
  });

  it("is deterministic for identical inputs (paired-run precondition)", () => {
    expect(buildProbeDistractors("ko-KR", "토너")).toEqual(buildProbeDistractors("ko-KR", "토너"));
  });

  it("keeps fictional competitor branding only", () => {
    const docs = [...buildProbeDistractors("ko-KR", "크림"), ...buildProbeDistractors("en-US", "cream")];
    const text = docs.join("\n").toLowerCase();
    for (const realBrand of ["exampleluxe", "examplederma", "예시럭셔리", "예시더마"]) {
      expect(text).not.toContain(realBrand);
    }
  });
});
