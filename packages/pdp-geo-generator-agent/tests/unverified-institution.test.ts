import { describe, expect, it } from "vitest";
import { generatePdpGeoArtifacts } from "../src/generate";
import { normalizePdpProduct } from "../src/normalize";
import { restatesTypedFieldAsRawTranscription } from "../src/contracts/certification-contract";
import { graphOf, nodeOf } from "./support/graph";
import type { PdpGeoReasoningResult } from "../src/types";

/**
 * A named institution that reached published schema without existing.
 *
 * The EXAMPLEDERMA 모이베리어 365 크림 미스트 PDP image reads "대학병원 피부과에서". The
 * extractor's OCR returned "휘경보건 피부과에서" at 0.91 confidence, and that
 * invented clinic was published in `WebPage.description` and in
 * `Product.additionalProperty[Reported details]`.
 *
 * The transcription error itself belongs to the extractor. What the generator
 * owns is the decision to print a third-party medical institution on the
 * strength of transcribed prose alone. A safety test with no measured outcome
 * has nothing to cite; the completed test is the fact buyers need, and the
 * institution is provenance that must come from a typed field to be published.
 */
const reasoning = {
  mode: "explicit-rag-product-reasoning",
  queryIntents: [],
  selectedSources: [],
  productEvidence: { benefits: [], effects: [], ingredients: [], usage: [], reviews: [], faq: [], sourceBackedClaims: [] },
  principles: ["answer-ready FAQ", "evidence-backed claims", "target customer context"],
  decisions: ["answer-ready FAQ", "evidence-backed claims", "target customer context"].map((principle) => ({
    principle, enabled: true, confidence: 0.95, ragSources: [], productEvidence: [], rationale: "test"
  }))
} as unknown as PdpGeoReasoningResult;

function mistProduct(evidenceSentence: string) {
  const { product } = normalizePdpProduct({
    name: "모이베리어 365 크림 미스트",
    description: "10,000ppm 함유된 고함량 세라마이드 미세분사로 피부장벽을 보호하는 크림 미스트입니다.",
    brand: "EXAMPLEDERMA",
    category: "크림 미스트",
    benefits: ["수분 충전과 동시에 보습막을 형성합니다."],
    ingredients: ["세라마이드 10,000ppm"],
    usage: ["피부에 건조함이 느껴질 때 수시로 뿌려 사용합니다."],
    sourceTexts: [evidenceSentence]
  }, { hints: { locale: "ko-KR" } });
  return {
    ...product,
    semanticFacts: {
      ingredients: ["세라마이드 10,000ppm"],
      benefits: ["수분 충전과 동시에 보습막을 형성합니다."],
      effects: [],
      skinTypes: ["건조 피부"],
      usageSteps: ["피부에 건조함이 느껴질 때 수시로 뿌려 사용합니다."],
      safetyTests: ["피부과 테스트", "하이포알러제닉 테스트"],
      // The real run carried no structured metric claim: the institution
      // existed only inside the transcribed sentence.
      metricClaims: [],
      evidenceSentences: [evidenceSentence],
      ingredientBenefitLinks: [],
      citations: []
    }
  } as typeof product;
}

const OCR_SENTENCE = "DERMATOLOGIST TESTED 피부과 테스트 휘경보건 피부과에서 48시간 패치를 활용한 자극여부 확인 22.12.19-22.12.22, 32명 대상";

describe("unverified testing organization", () => {
  const typedSafetyTests = ["피부과 테스트", "하이포알러제닉 테스트"];

  it("recognizes a transcription that only restates a typed fact", () => {
    expect(restatesTypedFieldAsRawTranscription(OCR_SENTENCE, typedSafetyTests)).toBe(true);
  });

  it("keeps a sentence whose measurement no typed field carries", () => {
    // The numbers are the fact here, and the study context qualifies them.
    expect(restatesTypedFieldAsRawTranscription(
      "(주)엘리드가 성인 32명을 대상으로 진행한 인체적용시험에서 보습량이 2배 증가했습니다.",
      typedSafetyTests
    )).toBe(false);
  });

  it("keeps a sentence the extractor never reduced to a typed fact", () => {
    // Nothing typed covers it, so dropping it would lose information.
    expect(restatesTypedFieldAsRawTranscription("세라마이드가 피부 표면에 보습막을 형성합니다.", typedSafetyTests)).toBe(false);
  });

  it("keeps the typed fact itself", () => {
    expect(restatesTypedFieldAsRawTranscription("피부과 테스트", typedSafetyTests)).toBe(false);
  });

  it("keeps the invented clinic out of every published field", () => {
    const artifacts = generatePdpGeoArtifacts({
      product: mistProduct(OCR_SENTENCE),
      locale: "ko-KR",
      market: "KR",
      ragChunks: [],
      ragDocuments: [],
      reasoning
    });

    const published = JSON.stringify(artifacts.schemaMarkup.jsonLd) + JSON.stringify(artifacts.content);
    expect(published).not.toContain("휘경보건");
    // The completed tests are the part a buyer needs, and they stay.
    expect(published).toMatch(/피부과 테스트/u);
  });

  it("still publishes provenance the extractor committed as a typed field", () => {
    const base = mistProduct("(주)엘리드가 2023년 2월 2일부터 3월 23일까지 성인 32명을 대상으로 진행한 인체적용시험입니다.");
    const product = {
      ...base,
      metrics: ["사용 직후 보습량 2배 증가"],
      semanticFacts: {
        ...base.semanticFacts!,
        metricClaims: [{
          label: "보습량",
          subject: "보습량",
          value: "2",
          unit: "배",
          metric: "보습량",
          direction: "증가",
          timing: "사용 직후",
          sample: "성인 32명",
          period: "2023.02.02-2023.03.23",
          method: "인체적용시험",
          institution: "(주)엘리드",
          sentence: "사용 직후 보습량 2배 증가",
          sourceText: "(주)엘리드, 2023.02.02-2023.03.23, 성인 32명 대상 인체적용시험"
        }]
      }
    } as typeof base;

    const artifacts = generatePdpGeoArtifacts({
      product,
      locale: "ko-KR",
      market: "KR",
      ragChunks: [],
      ragDocuments: [],
      reasoning
    });

    expect(JSON.stringify(artifacts.schemaMarkup.jsonLd)).toContain("엘리드");
  });
});
