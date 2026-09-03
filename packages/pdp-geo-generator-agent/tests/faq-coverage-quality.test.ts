import { describe, expect, it } from "vitest";
import { generatePdpGeo } from "../src";
import { ensurePdpGeoFaqPlanCoverage } from "../src/generate";
import { normalizePdpProduct } from "../src/normalize";
import type { PdpGeoContentPlan, PdpGeoPlannedFaqItem } from "../src/types";
import { graphOf, nodeOf } from "./support/graph";

/**
 * The coverage charger (ensurePdpGeoFaqPlanCoverage) fills gaps left by a
 * planner gate with deterministic, source-backed candidates. Two quality
 * failures showed up in production once that gate started rejecting more
 * planner questions (2026-09-01 real-traffic review):
 *
 *  - it reused the same small evidence pool across several fallback
 *    questions, publishing three near-identical answers under different
 *    headings;
 *  - it forwarded a raw review keyword whose transcription was corrupted
 *    (a lone jamo character stranded between two complete syllables) into
 *    a customer-facing FAQ answer.
 *
 * Every check here is structural/lexical, never a list of known-bad words
 * or a specific product's wording.
 */

function emptyFaqPlan(overrides: Partial<PdpGeoContentPlan> = {}): PdpGeoContentPlan {
  return {
    mode: "model",
    locale: "ko-KR",
    productDescription: { include: false, text: "", intent: "", evidenceIds: [], confidence: 0, omitReason: "" },
    webPageDescription: { include: false, text: "", intent: "", evidenceIds: [], confidence: 0, omitReason: "" },
    faq: [],
    howTo: { eligible: false, ordered: false, goal: "", steps: [], evidenceIds: [], confidence: 0, omitReason: "" },
    cep: [],
    warnings: [],
    ...overrides
  };
}

function plannedFaqItem(question: string, answer: string): PdpGeoPlannedFaqItem {
  return {
    include: true,
    question,
    answer,
    intent: "product-question",
    cep: "",
    evidenceIds: [],
    confidence: 0.9,
    omitReason: ""
  };
}

const sparseProduct = normalizePdpProduct({
  name: "하이드라 세럼",
  description: "건조한 피부에 수분을 공급하는 세럼입니다.",
  category: "세럼",
  ingredients: ["세라마이드"],
  benefits: ["수분 공급"],
  usage: ["아침과 저녁 세안 후 적당량을 얼굴에 고르게 발라줍니다."]
}, { hints: { locale: "ko-KR" } }).product;

describe("4a: corrupted review keyword exclusion", () => {
  async function faqText(keywords: string[]): Promise<string> {
    const run = await generatePdpGeo({
      product: {
        name: "배리어 크림",
        description: "건조하고 민감한 피부를 위한 보습 크림입니다.",
        category: "크림",
        benefits: ["보습"],
        reviews: {
          rating: 4.8,
          reviewCount: 40,
          items: [],
          keywords
        }
      },
      hints: { locale: "ko-KR", market: "KR" }
    });
    const faqPage = nodeOf(graphOf(run), "FAQPage");
    return JSON.stringify(faqPage?.mainEntity ?? []);
  }

  it("drops a review keyword with a lone jamo stranded mid-syllable-string", async () => {
    // "장벽에" + lone "ㅜ" + "미세보습막" -- the isolated vowel jamo sits
    // between two runs of complete Hangul syllables, which is the
    // structural signature of a split-apart syllable, not a word choice.
    const text = await faqText(["장벽에ㅜ미세보습막을", "촉촉한 사용감"]);
    expect(text).not.toContain("ㅜ");
    expect(text).not.toContain("장벽에ㅜ미세보습막");
    expect(text).toContain("촉촉한 사용감");
  });

  it("keeps an intact review keyword untouched", async () => {
    const text = await faqText(["촉촉한 사용감", "끈적임이 적은 마무리"]);
    expect(text).toContain("촉촉한 사용감");
    expect(text).toContain("끈적임이 적은 마무리");
  });

  it("omits the review-keyword sentence entirely when every candidate keyword is corrupted", async () => {
    const withOnlyBroken = await faqText(["장벽에ㅜ미세보습막을"]);
    const withIntact = await faqText(["촉촉한 사용감"]);
    expect(withOnlyBroken).not.toContain("고객 리뷰에서는");
    expect(withIntact).toContain("고객 리뷰에서는");
  });

  it("keeps a keyword that carries a run of repeated jamo used as an emotive marker, not a split syllable", async () => {
    // Same shape as the corruption fixture above ("장벽에" + jamo + "미세보습막을")
    // except the isolated "ㅜ" is replaced with a "ㅎㅎ" run. "ㅎㅎ"/"ㅠㅠ"/"ㅋㅋ"
    // runs are ordinary Korean emotive punctuation, not a syllable that
    // OCR/transcription split apart. Corruption is a *lone* jamo directly
    // between two complete syllables -- a run of two or more adjacent jamo
    // is a different shape entirely and must not be excluded.
    const text = await faqText(["장벽에ㅎㅎ미세보습막을"]);
    expect(text).toContain("장벽에ㅎㅎ미세보습막");
  });
});

describe("4b: coverage-fill near-duplicate blocking", () => {
  it("does not admit a coverage candidate whose answer nearly duplicates an already-included answer", () => {
    const baseline = ensurePdpGeoFaqPlanCoverage({
      plan: emptyFaqPlan(),
      product: sparseProduct,
      locale: "ko-KR",
      ragChunks: [],
      evidenceLedger: []
    });
    // The first two entries are the contractually-required target-customer
    // and composition-benefit anchors; anything beyond that is ordinary
    // coverage fill and is exactly what this rule targets.
    expect(baseline.faq.length).toBeGreaterThan(2);
    const reusedAnswer = baseline.faq[2]!.answer;
    const reusedQuestion = baseline.faq[2]!.question;

    const plan = emptyFaqPlan({
      faq: [plannedFaqItem("이 제품에 대해 추가로 궁금한 점이 있나요?", reusedAnswer)]
    });
    const result = ensurePdpGeoFaqPlanCoverage({
      plan,
      product: sparseProduct,
      locale: "ko-KR",
      ragChunks: [],
      evidenceLedger: []
    });
    const questions = result.faq.map((item) => item.question);

    expect(questions).toContain("이 제품에 대해 추가로 궁금한 점이 있나요?");
    // The coverage renderer would otherwise regenerate the exact same
    // question with the exact same (now-duplicate) answer; it must be
    // dropped instead of publishing the same content twice.
    expect(questions).not.toContain(reusedQuestion);
  });

  it("still admits a coverage candidate whose answer is genuinely different", () => {
    const plan = emptyFaqPlan({
      faq: [plannedFaqItem(
        "이 제품에 대해 추가로 궁금한 점이 있나요?",
        "이것은 완전히 다른 내용의 답변 문장입니다. 다른 후보와 겹치지 않습니다."
      )]
    });
    const baseline = ensurePdpGeoFaqPlanCoverage({
      plan: emptyFaqPlan(),
      product: sparseProduct,
      locale: "ko-KR",
      ragChunks: [],
      evidenceLedger: []
    });
    const result = ensurePdpGeoFaqPlanCoverage({
      plan,
      product: sparseProduct,
      locale: "ko-KR",
      ragChunks: [],
      evidenceLedger: []
    });
    const questions = result.faq.map((item) => item.question);

    expect(questions).toContain("이 제품에 대해 추가로 궁금한 점이 있나요?");
    expect(questions).toContain(baseline.faq[2]!.question);
  });
});

describe("4c: final near-duplicate diagnostic pass", () => {
  it("removes one of two planner-approved items whose answers nearly duplicate each other and logs a diagnostic", () => {
    const duplicateAnswer = "동일한 첫 문장입니다. 동일한 두 번째 문장도 있습니다.";
    const plan = emptyFaqPlan({
      faq: [
        plannedFaqItem("포장은 어떻게 되어 있나요?", duplicateAnswer),
        plannedFaqItem("배송은 얼마나 걸리나요?", duplicateAnswer)
      ]
    });
    const result = ensurePdpGeoFaqPlanCoverage({
      plan,
      product: sparseProduct,
      locale: "ko-KR",
      ragChunks: [],
      evidenceLedger: []
    });
    const questions = result.faq.map((item) => item.question);

    expect(questions).toContain("포장은 어떻게 되어 있나요?");
    // Same priority score for both synthetic questions -> the later one is
    // the one removed.
    expect(questions).not.toContain("배송은 얼마나 걸리나요?");
    expect(result.warnings.some((warning) =>
      warning.includes("FAQ item removed because its answer nearly duplicated another item's answer")
      && warning.includes("포장은 어떻게 되어 있나요?")
      && warning.includes("배송은 얼마나 걸리나요?")
    )).toBe(true);
  });

  it("keeps two planner-approved items with distinct answers and logs no diagnostic", () => {
    const plan = emptyFaqPlan({
      faq: [
        plannedFaqItem("포장은 어떻게 되어 있나요?", "포장은 종이 상자에 담겨 있습니다."),
        plannedFaqItem("배송은 얼마나 걸리나요?", "배송은 영업일 기준 2~3일 소요됩니다.")
      ]
    });
    const result = ensurePdpGeoFaqPlanCoverage({
      plan,
      product: sparseProduct,
      locale: "ko-KR",
      ragChunks: [],
      evidenceLedger: []
    });
    const questions = result.faq.map((item) => item.question);

    expect(questions).toContain("포장은 어떻게 되어 있나요?");
    expect(questions).toContain("배송은 얼마나 걸리나요?");
    expect(result.warnings.some((warning) => warning.includes("nearly duplicated"))).toBe(false);
  });

  it("catches a real-world duplicate shape: two 2-sentence answers sharing exactly one sentence", () => {
    // The observed production duplicate was two short answers, each with
    // one sentence of its own and one shared evidence sentence -- 1 of 2
    // sentences shared on both sides, which is a majority (>= half) for a
    // 2-sentence answer even though it is not a strict >50% majority.
    const shared = "10,000ppm 세라마이드를 담아 보습막을 형성합니다.";
    const plan = emptyFaqPlan({
      faq: [
        plannedFaqItem("포장은 어떻게 되어 있나요?", `포장은 유리병입니다. ${shared}`),
        plannedFaqItem("배송은 얼마나 걸리나요?", `배송은 2일 이내입니다. ${shared}`)
      ]
    });
    const result = ensurePdpGeoFaqPlanCoverage({
      plan,
      product: sparseProduct,
      locale: "ko-KR",
      ragChunks: [],
      evidenceLedger: []
    });
    const questions = result.faq.map((item) => item.question);

    expect(questions).toContain("포장은 어떻게 되어 있나요?");
    expect(questions).not.toContain("배송은 얼마나 걸리나요?");
    expect(result.warnings.some((warning) => warning.includes("nearly duplicated another item's answer"))).toBe(true);
  });

  it("does not flag a short answer that legitimately cites one sentence of a much longer, distinct answer", () => {
    const shared = "개인에 따라 결과는 다를 수 있습니다.";
    const plan = emptyFaqPlan({
      faq: [
        plannedFaqItem("포장은 어떻게 되어 있나요?", shared),
        plannedFaqItem(
          "교환은 가능한가요?",
          `첫 번째 근거 문장입니다. ${shared} 세 번째 근거 문장입니다.`
        )
      ]
    });
    const result = ensurePdpGeoFaqPlanCoverage({
      plan,
      product: sparseProduct,
      locale: "ko-KR",
      ragChunks: [],
      evidenceLedger: []
    });
    const questions = result.faq.map((item) => item.question);

    expect(questions).toContain("포장은 어떻게 되어 있나요?");
    expect(questions).toContain("교환은 가능한가요?");
  });

  it("does not flag two 3-sentence answers that only happen to share one sentence", () => {
    const shared = "개인에 따라 결과는 다를 수 있습니다.";
    const plan = emptyFaqPlan({
      faq: [
        plannedFaqItem("포장은 어떻게 되어 있나요?", `문장 A입니다. ${shared} 문장 B입니다.`),
        plannedFaqItem("교환은 가능한가요?", `문장 C입니다. ${shared} 문장 D입니다.`)
      ]
    });
    const result = ensurePdpGeoFaqPlanCoverage({
      plan,
      product: sparseProduct,
      locale: "ko-KR",
      ragChunks: [],
      evidenceLedger: []
    });
    const questions = result.faq.map((item) => item.question);

    expect(questions).toContain("포장은 어떻게 되어 있나요?");
    expect(questions).toContain("교환은 가능한가요?");
  });

  it("keeps both required target-customer and composition-benefit anchors even when their answers are near-duplicate, but still logs a diagnostic", () => {
    const plan = emptyFaqPlan({
      faq: [
        plannedFaqItem(
          "이 제품은 건조한 피부에 적합한가요?",
          "공유 근거 문장입니다. 타겟 고객 전용 문장입니다."
        ),
        plannedFaqItem(
          "이 제품의 주요 성분과 효능은 무엇인가요?",
          "공유 근거 문장입니다. 성분 전용 문장입니다."
        )
      ]
    });
    const result = ensurePdpGeoFaqPlanCoverage({
      plan,
      product: sparseProduct,
      locale: "ko-KR",
      ragChunks: [],
      evidenceLedger: []
    });
    const questions = result.faq.map((item) => item.question);

    // Both are contractually required anchors; neither may be dropped even
    // though their answers would otherwise be flagged as near-duplicate.
    expect(questions).toContain("이 제품은 건조한 피부에 적합한가요?");
    expect(questions).toContain("이 제품의 주요 성분과 효능은 무엇인가요?");
    expect(result.warnings.some((warning) =>
      warning.includes("FAQ items kept despite near-duplicate answers because both are required anchors")
      && warning.includes("이 제품은 건조한 피부에 적합한가요?")
      && warning.includes("이 제품의 주요 성분과 효능은 무엇인가요?")
    )).toBe(true);
  });
});
