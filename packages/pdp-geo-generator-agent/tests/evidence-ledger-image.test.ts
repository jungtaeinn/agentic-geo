import { describe, expect, it } from "vitest";
import { createPdpGeoEvidenceLedger, numericClaimTokens, numericRelationshipsAreSupported, numericTokensHaveConfidentSupport } from "../src/content-planner";
import { normalizePdpProduct } from "../src/normalize";
import { filterCurrentProductUsageInstructions } from "../src/product-scope";
import type { PdpGeoAtomicEvidence, PdpProductSignal } from "../src/types";

const IMG_A = "https://cdn.example.com/ingredient.png";
const IMG_B = "https://cdn.example.com/usage.png";

const FOREIGN_USAGE_TEXT = "Apply Hydro Essence Toner to damp skin before the next step.";
const OCR_SOURCE_TEXT = "Ceramide 10,000ppm reinforces the skin barrier.";
const NON_OCR_SOURCE_TEXT = "BarrierCare 365 Cream product name text";

const product = {
  name: "모이베리어 365 크림",
  sourceExtraction: {
    ocr: {
      imageTexts: [
        { imageUrl: IMG_A, imageUrls: [IMG_A], text: "세라마이드 10,000ppm이 피부 장벽을 강화합니다", confidence: 0.9 },
        { imageUrl: IMG_B, imageUrls: [IMG_B], text: "아침 저녁 세안 후 얼굴에 도포합니다", confidence: 0.4 }
      ],
      textBlocks: [],
      sentenceInsights: [
        { imageUrl: IMG_A, imageUrls: [IMG_A], text: "세라마이드 10,000ppm이 피부 장벽을 강화합니다", category: "ingredient", keywords: ["세라마이드"] },
        { imageUrl: IMG_B, imageUrls: [IMG_B], text: "아침 저녁 세안 후 얼굴에 도포합니다", category: "usage", keywords: [] }
      ],
      semanticFacts: {
        ingredients: [], benefits: [], effects: [], skinTypes: [], usageSteps: [], evidenceSentences: [],
        metricClaims: [{
          sentence: "10,000ppm",
          // The bare "10,000ppm" wording fails sanitizePdpSemanticFacts' metric-coherence
          // gate, so this sourceText adds an outcome + evidence frame to survive it.
          sourceText: "모이베리어 365 크림에 세라마이드 10,000ppm을 배합해 4주간 사용한 시험에서 피부 장벽 기능이 32% 개선되었습니다",
          imageUrls: [IMG_A]
        }],
        ingredientBenefitLinks: [], citations: []
      }
    }
  }
};

function minimalProduct(overrides: Partial<PdpProductSignal>): PdpProductSignal {
  return {
    name: "테스트 제품",
    images: [],
    options: [],
    benefits: [],
    effects: [],
    ingredients: [],
    usage: [],
    metrics: [],
    faq: [],
    reviews: { items: [], keywords: [] },
    breadcrumbs: [],
    sourceTexts: [],
    ...overrides
  };
}

describe("evidence ledger carries OCR image provenance", () => {
  it("stamps sourceTexts atoms and metric claim atoms with image provenance without disturbing atom identity", () => {
    const { product: normalized } = normalizePdpProduct(product);
    const ledger = createPdpGeoEvidenceLedger(normalized, "ko-KR");
    const sourceAtom = ledger.find((atom) => atom.text.includes("장벽을 강화") && atom.imageUrls !== undefined);
    expect(sourceAtom?.imageUrls).toEqual([IMG_A]);
    expect(sourceAtom?.ocrConfidence).toBe(0.9);
    // Merging provenance must not rewrite the recorded atom's sourcePath: it is a
    // ranking key (planningEvidenceSpecificity) and a regex target
    // (selectPlanningReviewSituations), not just a label.
    expect(sourceAtom?.sourcePath).not.toMatch(/^product\.sourceTexts\[/);
    const metricAtom = ledger.find((atom) => atom.sourcePath.startsWith("product.semanticFacts.metricClaims[0]"));
    expect(metricAtom?.imageUrls).toEqual([IMG_A]);
    const identityAtom = ledger.find((atom) => atom.sourcePath === "product.name");
    expect(identityAtom?.imageUrls).toBeUndefined();
  });

  it("unions imageUrls and keeps the weaker ocrConfidence when a duplicate atom merges in", () => {
    // 원자 중복 판정은 대소문자를 무시하므로, 표기만 다른 두 sourceTexts 항목이
    // 원장에서 한 원자로 합쳐진다 — 텍스트 키잉된 메타에서도 각자의 계보를
    // 들고 들어와 합쳐지는지 확인한다.
    const text = "Ceramide 10,000ppm reinforces the skin barrier";
    const shouted = text.toLocaleUpperCase();
    const duplicated = minimalProduct({
      sourceTexts: [text, shouted],
      sourceTextMeta: {
        [text]: { imageUrls: [IMG_A], ocrConfidence: 0.9 },
        [shouted]: { imageUrls: [IMG_B], ocrConfidence: 0.4 }
      }
    });
    const ledger = createPdpGeoEvidenceLedger(duplicated, "ko-KR");
    const matches = ledger.filter((atom) => atom.text.toLocaleLowerCase() === text.toLocaleLowerCase());
    expect(matches).toHaveLength(1);
    expect(matches[0]?.imageUrls).toEqual([IMG_A, IMG_B]);
    expect(matches[0]?.ocrConfidence).toBe(0.4);
  });

  it("keeps each text's provenance when a foreign-only sourceText is filtered out of the array", () => {
    // 회귀 핀: sourceTextMeta가 sourceTexts와 인덱스 정렬된 배열이던 시절,
    // filterCurrentProductUsageInstructions가 항목 하나를 떨어뜨리면 이후 모든
    // 계보가 한 칸씩 밀려 OCR 이미지·신뢰도가 엉뚱한 문장에 붙었다.
    const scoped = filterCurrentProductUsageInstructions(minimalProduct({
      name: "BarrierCare 365 Cream",
      usage: ["Apply the cream to clean skin morning and night."],
      sourceTexts: [FOREIGN_USAGE_TEXT, OCR_SOURCE_TEXT, NON_OCR_SOURCE_TEXT],
      sourceTextMeta: { [OCR_SOURCE_TEXT]: { imageUrls: [IMG_A], ocrConfidence: 0.9 } }
    }));
    expect(scoped.sourceTexts).not.toContain(FOREIGN_USAGE_TEXT);

    const ledger = createPdpGeoEvidenceLedger(scoped, "en-US");
    const ocrAtom = ledger.find((atom) => atom.text.includes("10,000ppm"));
    expect(ocrAtom?.imageUrls).toEqual([IMG_A]);
    expect(ocrAtom?.ocrConfidence).toBe(0.9);
    const nonOcrAtom = ledger.find((atom) => atom.text === NON_OCR_SOURCE_TEXT);
    expect(nonOcrAtom).toBeDefined();
    expect(nonOcrAtom?.imageUrls).toBeUndefined();
    expect(nonOcrAtom?.ocrConfidence).toBeUndefined();
  });
});

describe("numeric relationship gate accepts image-grouped evidence", () => {
  function atom(id: string, text: string, imageUrls?: string[]): PdpGeoAtomicEvidence {
    return {
      id,
      role: "metric",
      text,
      sourcePath: `product.sourceTexts[${id}]`,
      locale: "ko-KR",
      productScope: "product",
      confidence: 0.9,
      ...(imageUrls ? { imageUrls } : {})
    };
  }

  it("accepts a multi-number claim whose numbers co-occur within one image", () => {
    const atoms = [atom("a", "만족도 94%", [IMG_A]), atom("b", "지속력 93%", [IMG_A])];
    const byId = new Map(atoms.map((item) => [item.id, item]));
    expect(numericRelationshipsAreSupported(
      // Two numbers, one clause (no ;/。/comma-before-non-digit/conjunction
      // splitter).
      "만족도 94% 지속력 93% 수준을 보였습니다",
      atoms.map((item) => item.text).join(". "),
      ["a", "b"],
      byId
    )).toBe(true);
  });

  it("still rejects numbers scattered across different images", () => {
    const atoms = [atom("a", "만족도 94%", [IMG_A]), atom("b", "지속력 93%", ["https://cdn.example.com/other.png"])];
    const byId = new Map(atoms.map((item) => [item.id, item]));
    expect(numericRelationshipsAreSupported(
      "만족도 94% 지속력 93% 수준을 보였습니다",
      atoms.map((item) => item.text).join(". "),
      ["a", "b"],
      byId
    )).toBe(false);
  });

  function ocrAtom(id: string, text: string, ocrConfidence: number): PdpGeoAtomicEvidence {
    return { ...atom(id, text, [IMG_B]), ocrConfidence };
  }

  it("blocks a numeric token supported only by low-confidence OCR", () => {
    const atoms = [ocrAtom("low", "보습 지속 48시간", 0.42)];
    const byId = new Map(atoms.map((item) => [item.id, item]));
    expect(numericTokensHaveConfidentSupport("보습이 48시간 지속됩니다", ["low"], byId)).toBe(false);
  });

  it("passes when the same number also appears in confident evidence", () => {
    const atoms = [ocrAtom("low", "보습 지속 48시간", 0.42), atom("high", "48시간 보습 지속 테스트 완료", [IMG_A])];
    const byId = new Map(atoms.map((item) => [item.id, item]));
    expect(numericTokensHaveConfidentSupport("보습이 48시간 지속됩니다", ["low", "high"], byId)).toBe(true);
  });
});

describe("commerce numeric claims are not pooled across variants", () => {
  function commerceAtom(id: string, text: string): PdpGeoAtomicEvidence {
    return {
      id,
      role: "commerce",
      text,
      sourcePath: `product.commerce[${id}]`,
      locale: "ko-KR",
      productScope: "product",
      confidence: 0.9
    };
  }

  it("rejects a fabricated price stitched together from a different variant's cited atom", () => {
    // Pooling every cited commerce atom's numeric tokens together (as a prior
    // version of this gate did) would let "80ml" (from the refill atom) and
    // "33000" (the main product's price) pass as if they co-occurred, even
    // though no single cited atom ever states that pairing.
    const atoms = [
      commerceAtom("main", "본품 120ml 33,000원"),
      commerceAtom("refill", "리필 80ml 23,000원"),
      commerceAtom("price", "33000.0")
    ];
    const byId = new Map(atoms.map((item) => [item.id, item]));
    expect(numericRelationshipsAreSupported(
      "리필 80ml 제품은 33,000원에 판매되고 있습니다",
      atoms.map((item) => item.text).join(". "),
      ["main", "refill", "price"],
      byId
    )).toBe(false);
  });

  it("still accepts a price and size stated together in one cited atom", () => {
    const atoms = [commerceAtom("main", "본품 120ml 33,000원")];
    const byId = new Map(atoms.map((item) => [item.id, item]));
    expect(numericRelationshipsAreSupported(
      "본품 120ml 제품은 33,000원에 판매되고 있습니다",
      atoms.map((item) => item.text).join(". "),
      ["main"],
      byId
    )).toBe(true);
  });
});

describe("enumeration markers are not measurements", () => {
  it("ignores clause-initial ordinal markers in routine instructions", () => {
    expect(numericClaimTokens("1) 세안 직후 크림 미스트를 뿌린 후 하이드로 에센스 순서로 사용")).toEqual([]);
    expect(numericClaimTokens("2 피부에 건조함이 느껴질 때 수시로 뿌려줍니다")).toEqual([]);
  });

  it("ignores a trailing step-label ordinal with no unit", () => {
    expect(numericClaimTokens("사용법 1")).toEqual([]);
  });

  it("keeps unit-bearing measurements intact", () => {
    expect(numericClaimTokens("보습 지속 48시간")).toContain("48시간");
    expect(numericClaimTokens("보습 만족도 94%")).toContain("94%");
  });

  it("keeps a clause-initial number that carries a unit", () => {
    expect(numericClaimTokens("48시간 보습 지속 테스트 완료")).toContain("48시간");
  });
});

describe("numeric tokenizer keeps a unit followed by an attached Korean particle", () => {
  it("keeps the unit when a case particle glues directly onto it (no space)", () => {
    const tokens = numericClaimTokens("보습 만족도 94%와 진정 93%를 보였습니다");
    expect(tokens).toContain("94%");
    expect(tokens).toContain("93%");
    expect(tokens).not.toContain("94");
    expect(tokens).not.toContain("93");
  });

  it("keeps an hour unit followed by a topic particle", () => {
    expect(numericClaimTokens("48시간이 지속됩니다")).toContain("48시간");
  });

  it("keeps a unit followed by the resultative particle 로/으로", () => {
    expect(numericClaimTokens("94%로 개선되었습니다")).toContain("94%");
    expect(numericClaimTokens("33,000원으로 판매되고 있습니다")).toContain("33000");
  });
});

describe("trailing-mask does not swallow a Latin-designator graded value", () => {
  it("keeps a scale value stated as '<DESIGNATOR> <number>' at a clause end", () => {
    expect(numericClaimTokens("자외선 차단지수 SPF 50")).toContain("50");
  });

  it("leaves an already-unaffected glued designator form untouched", () => {
    expect(numericClaimTokens("SPF50")).toEqual([]);
  });

  it("leaves an already-unaffected designator-plus-suffix form untouched", () => {
    expect(numericClaimTokens("SPF 50+")).toContain("50");
  });

  it("keeps a decimal graded value after a Latin designator", () => {
    expect(numericClaimTokens("pH 5.5")).toContain("5.5");
  });

  it("still masks a single-digit Latin-labeled ordinal (list marker, not a grade)", () => {
    // "STEP 2" / "DAY 3" are ordinal step labels, not graded scale values
    // (SPF/pH). The Latin-designator exemption above only protects a
    // multi-digit, decimal, or "+"-suffixed number — a single bare digit
    // still falls back to the enumeration-marker mask.
    expect(numericClaimTokens("STEP 2")).toEqual([]);
    expect(numericClaimTokens("DAY 3")).toEqual([]);
  });

  it("keeps a two-digit Latin-labeled ordinal (accepted conservative tradeoff)", () => {
    // "STEP 25" is genuinely ambiguous — a 2-digit ordinal label reads the
    // same as a graded value under this structural rule, so the exemption
    // keeps it as a token. That is the safe side: `numbersAreSupported`
    // tokenizes the OUTPUT, so a masked number is exempted from evidence
    // matching altogether, while an unmasked one must be found in the cited
    // evidence. Masking therefore permits fabrication rather than costing a
    // false negative. The accepted risk runs the other way — an unverified
    // single-digit ordinal ("STEP 2", masked above) can reach the output —
    // and is bounded because the mask only ever reaches a bare 1–2 digit
    // integer with no unit at a clause edge: any figure carrying a unit, a
    // decimal, or a "+" suffix is still verified against the evidence.
    expect(numericClaimTokens("STEP 25")).toContain("25");
  });
});
