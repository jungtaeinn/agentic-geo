import { describe, expect, it } from "vitest";
import { hasUnpredicatedEnumeration } from "../src/contracts/enumeration-contract";
import { validatePdpGeoArtifacts } from "../src/validate";
import { normalizePdpProduct } from "../src/normalize";

/**
 * The live 1145 run published `…클렌저로, 피부 장벽, 세정력, 저자극 세안을
 * 돕습니다.` — three benefits under one predicate, none of them explained. That
 * is the sentence shape this contract names.
 */
describe("an un-predicated enumeration in Korean prose", () => {
  it("flags three or more bare items sharing one predicate", () => {
    expect(hasUnpredicatedEnumeration(
      "예시더마 모이베리어365 클렌징폼은 건조하고 민감한 피부 고객을 위한 클렌저로, 피부 장벽, 세정력, 저자극 세안을 돕습니다."
    )).toBe(true);
    expect(hasUnpredicatedEnumeration(
      "보타온, 판테놀, 베타인을 함유합니다."
    )).toBe(true);
  });

  it("does not flag two items", () => {
    // Two coordinate items read as a pair, not as a list, and the composers
    // already join them with 와/과 rather than a comma.
    expect(hasUnpredicatedEnumeration("보타온과 판테놀을 함유합니다.")).toBe(false);
    expect(hasUnpredicatedEnumeration("보타온, 판테놀을 함유합니다.")).toBe(false);
  });

  it("does not flag items that each carry a role", () => {
    expect(hasUnpredicatedEnumeration(
      "판테놀이 장벽 개선을 돕고, 베타인이 수분을 잡아주며, 보타온이 세라마이드를 전달합니다."
    )).toBe(false);
  });

  // The cleanser run flagged `…판테놀, 베타인, 보타온의 3종 장벽 보호 성분을
  // 함유한 Barrier Protective Formula를 적용했습니다` in both Product.description
  // and a FAQ answer. The three names are not bare there: the genitive head
  // immediately after the run says what they are, which is the role this
  // contract asks for. The source itself writes them that way, so flagging cost
  // two warnings and would have narrowed a sentence that was already correct.
  it("does not flag a run closed by a genitive head that classifies it", () => {
    expect(hasUnpredicatedEnumeration(
      "예시더마 모이베리어365 클렌징폼은 아미노산 유래 세정 성분을 담은 약산성 포뮬라와 판테놀, 베타인, 보타온의 3종 장벽 보호 성분을 함유한 Barrier Protective Formula를 적용했습니다."
    )).toBe(false);
    expect(hasUnpredicatedEnumeration(
      "세안 중 발생하는 장벽 손상을 줄이기 위한 Barrier Protective Formula에 판테놀, 베타인, 보타온의 3종 장벽 보호 성분을 함유했습니다."
    )).toBe(false);
  });

  it("still flags a run whose last item only takes an object particle", () => {
    expect(hasUnpredicatedEnumeration(
      "예시더마 모이베리어365 클렌징폼은 피부 장벽, 세정력, 저자극 세안을 돕습니다."
    )).toBe(true);
  });

  it("does not flag a property value, which is a list by design", () => {
    // No sentence-final ending, so it is an attribute value rather than prose.
    expect(hasUnpredicatedEnumeration("피부 장벽, 세정력, 저자극 세안")).toBe(false);
    expect(hasUnpredicatedEnumeration("보타온, 판테놀, 베타인, 세라마이드")).toBe(false);
  });

  it("does not read a thousands separator or a chemical locant as a list", () => {
    expect(hasUnpredicatedEnumeration("세라마이드 10,000ppm을 함유합니다.")).toBe(false);
    expect(hasUnpredicatedEnumeration("1,2-헥산디올을 사용합니다.")).toBe(false);
  });

  it("does not flag a sentence with no coordination at all", () => {
    expect(hasUnpredicatedEnumeration(
      "아미노산 유래 세정 성분을 담은 약산성 포뮬라로 일상 속 노폐물을 세정합니다."
    )).toBe(false);
  });
});

const ENUMERATING_DESCRIPTION =
  "예시더마 모이베리어365 클렌징폼은 건조하고 민감한 피부 고객을 위한 클렌저로, 피부 장벽, 세정력, 저자극 세안을 돕습니다.";

describe("the validator reports an enumeration it finds in published prose", () => {
  /**
   * A warning rather than a repair. Narrowing the list deterministically means
   * rewriting Korean — re-attaching particles to a different final item — and a
   * wrong rewrite ships as published copy. Naming the defect lets the quality
   * gate's correction pass and the model fix it, which is where sentence
   * writing belongs.
   */
  function validateDescription(description: string) {
    const normalized = normalizePdpProduct({
      name: "예시더마 모이베리어365 클렌징폼",
      description,
      benefits: ["피부 장벽", "세정력", "저자극 세안"]
    } as never, { hints: { locale: "ko-KR" } }).product;
    const jsonLd = {
      "@context": "https://schema.org",
      "@graph": [{ "@type": "Product", name: "예시더마 모이베리어365 클렌징폼", description }]
    };
    return validatePdpGeoArtifacts({
      schemaMarkup: {
        jsonLd,
        scriptTag: `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`
      },
      content: {
        sections: {
          productName: "예시더마 모이베리어365 클렌징폼",
          description,
          quickFacts: "",
          benefits: "",
          ingredients: "",
          howToUse: "",
          faq: ""
        },
        html: `<div>${description}</div>`
      },
      fallbackProductName: "예시더마 모이베리어365 클렌징폼",
      fallbackDescription: description,
      locale: "ko-KR",
      sourceProduct: normalized
    });
  }

  it("warns when Product.description lists three bare items under one predicate", () => {
    const result = validateDescription(ENUMERATING_DESCRIPTION);
    expect(result.validationWarnings.join("\n")).toContain("listed three or more items");
  });

  it("stays silent on prose that gives its items a role", () => {
    const result = validateDescription(
      "예시더마 모이베리어365 클렌징폼은 아미노산 유래 세정 성분을 담은 약산성 포뮬라로 일상 속 노폐물을 세정합니다."
    );
    expect(result.validationWarnings.join("\n")).not.toContain("listed three or more items");
  });
});

describe("the rule is per sentence, not per field", () => {
  /**
   * A description is several sentences. Reading the field whole let commas from
   * different sentences join into one phantom list, which flagged perfectly
   * ordinary copy.
   */
  it("does not join commas from separate sentences into one list", () => {
    expect(hasUnpredicatedEnumeration(
      "예시더마 캡슐 토너 상품 페이지는 토너의 특징과 제품 선택에 필요한 정보를 담고 있습니다. "
      + "예시더마 캡슐 토너는 고밀도 세라마이드 캡슐, 콜레스테롤을 주요 성분·기술로 포함하고 피부 장벽 케어와 수분 케어를 돕습니다. "
      + "예시더마 캡슐 토너는 300ml 옵션으로 구성되어 있습니다."
    )).toBe(false);
  });

  it("still flags the enumerating sentence inside a multi-sentence field", () => {
    expect(hasUnpredicatedEnumeration(
      "이 제품은 민감 피부를 위해 설계됐습니다. 고밀도 세라마이드 캡슐, 콜레스테롤, 글루코노락톤을 주요 성분·기술로 구성한 토너입니다."
    )).toBe(true);
  });
});

describe("a comma that closes a clause is not a list separator", () => {
  it("reads the target clause as a clause, leaving a two-item pair", () => {
    // `…제품으로,` closes an adverbial clause; only 콜레스테롤 and 지방산 are
    // coordinate, and two items are a pair rather than a list.
    expect(hasUnpredicatedEnumeration(
      "모이베리어 365 크림 미스트는 건조하고 민감한 피부 고객을 위한 제품으로, 콜레스테롤, 지방산을 주요 성분·기술로 포함하고 수분 케어와 피부 장벽 케어를 돕습니다."
    )).toBe(false);
  });

  it("still flags three coordinate items after such a clause", () => {
    expect(hasUnpredicatedEnumeration(
      "모이베리어 365 크림 미스트는 건조하고 민감한 피부 고객을 위한 제품으로, 콜레스테롤, 지방산, 세라마이드를 주요 성분·기술로 포함합니다."
    )).toBe(true);
  });
});

describe("the same rule reads English serial lists", () => {
  /**
   * English marks coordination with the serial comma and a coordinator before
   * the final item, so the rule reads that rather than Korean morphology. The
   * live English benchmark published all three of these.
   */
  it("flags three or more bare items closed by and/or", () => {
    expect(hasUnpredicatedEnumeration(
      "Botanical Ginseng Rejuvenating Serum includes Ginseng Peptide, Korean Ginseng Actives, Retinol, and Niacinamide."
    )).toBe(true);
    expect(hasUnpredicatedEnumeration(
      "The product's documented benefit is firmness, anti-aging care, and hydration."
    )).toBe(true);
    expect(hasUnpredicatedEnumeration(
      "Essential Activating Serum includes 500-hour aged ginseng, Korean herb extract, and Vitamin C Derivative."
    )).toBe(true);
  });

  it("does not flag a pair", () => {
    expect(hasUnpredicatedEnumeration("The formula includes Ginseng Peptide and Korean Ginseng Actives.")).toBe(false);
  });

  it("does not flag commas that punctuate a clause rather than close a list", () => {
    expect(hasUnpredicatedEnumeration(
      "Apply morning and night after toner, gently pressing into skin until absorbed."
    )).toBe(false);
    expect(hasUnpredicatedEnumeration(
      "This serum, which was tested on 32 participants, supports firmness."
    )).toBe(false);
  });

  it("does not flag items that each carry a clause", () => {
    expect(hasUnpredicatedEnumeration(
      "Niacinamide is a brightening active, Retinol is a renewal active, and Ginseng Peptide is a firming active."
    )).toBe(false);
  });

  it("leaves a thousands separator alone", () => {
    expect(hasUnpredicatedEnumeration("The formula contains 10,000 ppm of ceramide.")).toBe(false);
  });
});

describe("a measured outcome may name every endpoint it covered", () => {
  /**
   * Narrowing a study's endpoint list would drop measured facts, which this
   * reconstruction forbids outright. The figure is what separates a reported
   * result from a benefit list, and it is read without any content word.
   */
  it("does not flag endpoints listed inside a reported result", () => {
    expect(hasUnpredicatedEnumeration(
      "The page reports that in an instrumental assessment of 32 women, 100% of participants showed improvement in fine lines, wrinkles, elasticity, and firmness after 6 weeks of use."
    )).toBe(false);
    expect(hasUnpredicatedEnumeration(
      "인체적용시험에서 피부 장벽, 수분, 탄력 지표가 4주 후 32% 개선됐습니다."
    )).toBe(false);
  });

  it("still flags a figure-free list in either language", () => {
    expect(hasUnpredicatedEnumeration(
      "Essential Activating Serum includes 500-hour aged ginseng, Korean herb extract, and Vitamin C Derivative."
    )).toBe(true);
    expect(hasUnpredicatedEnumeration("보타온, 판테놀, 베타인을 함유합니다.")).toBe(true);
  });
});

describe("narrowing keeps the surface the source actually wrote", () => {
  /**
   * The extractor canonicalizes an ingredient name and keeps the source-stated
   * one, so both `Hyaluronic Acid` and `Compressed Hyaluronic Acid` reached the
   * selector under different family keys — the family key only groups aliases
   * carrying a figure. With the canonical form ordered first, narrowing prose to
   * a pair dropped the specific name, which is the one an answer engine can
   * attribute.
   */
  it("keeps the specific ingredient surface, in the source's order", async () => {
    const { generatePdpGeo } = await import("../src");
    const run = await generatePdpGeo({
      product: {
        name: "Barrier Hydro Soothing Cream",
        ingredients: ["Compressed Hyaluronic Acid", "Ceramide"],
        benefits: ["hydration"],
        skinTypes: ["dry skin"]
      } as never,
      hints: { locale: "en-US", market: "US" }
    });
    const product = (run.result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, unknown>>)
      .find((node) => node["@type"] === "Product");
    const keyIngredients = ((product?.additionalProperty ?? []) as Array<{ name: string; value: string }>)
      .find((property) => property.name === "Key ingredients")?.value ?? "";

    expect(keyIngredients).toBe("Compressed Hyaluronic Acid, Ceramide");
    expect(String(product?.description)).toContain("Compressed Hyaluronic Acid");
  });
});

describe("the assembly cap covers every composer that writes prose", () => {
  /**
   * 실측(2026-09-02, 예시더마 1145)에서 마지막까지 남은 나열 경고.
   * `createReviewDerivedIndirectSearchQueries`가 항목 수를 자체 상수 3으로
   * 세고 있었고, 그 구절이 FAQ 질문과 답변 문장에 그대로 들어가 세 항목이 한
   * 서술을 공유하는 문장이 발행됐다 — 판정은 정상 발화했고, Task 7a의 조립
   * 상한이 이 조립기에만 적용되지 않은 것이 원인이다.
   */
  it("does not publish a three-item benefit run in a review-derived FAQ", async () => {
    const { generatePdpGeo } = await import("../src");
    const run = await generatePdpGeo({
      product: {
        name: "예시더마 모이베리어365 클렌징폼",
        brand: "EXAMPLEDERMA",
        category: "클렌저",
        benefits: ["피부 장벽", "세정력", "저자극 세안"],
        effects: ["모공 속 노폐물 세정", "색조 메이크업 세정"],
        ingredients: ["보타온", "판테놀", "베타인", "Barrier Protective Formula"],
        skinTypes: ["건조 피부", "민감 피부"],
        usage: ["젖은 손에 적당량을 덜어 충분히 거품을 낸 뒤 얼굴에 부드럽게 롤링하고 미온수로 씻어냅니다."],
        reviews: {
          keywords: ["촉촉한 사용감", "부드러운 거품", "당김 없음"],
          items: [
            { body: "거품이 부드럽고 풍성해서 자극 없이 깔끔하게 세안할 수 있어요. 세안 후에도 당김이 적고 촉촉함이 남아 만족스러웠어요." },
            { body: "순하고 좋아요 거품도 부드럽게 잘 나서 얼굴에 자극없이 세안가능하고 세안후에도 피부 당김이 없어서 만족스럽습니다." },
            { body: "건조하고 민감한 피부인데 아침에 가볍게 쓰기 좋아요 촉촉하고 편안합니다." }
          ]
        },
        semanticFacts: {
          ingredients: ["보타온", "판테놀", "베타인", "Barrier Protective Formula"],
          benefits: ["세안 중 발생하는 장벽 손상을 줄이는", "피부 장벽"],
          effects: ["모공 속 노폐물 세정"],
          skinTypes: ["건조 피부", "민감 피부"],
          usageSteps: [],
          safetyTests: [],
          metricClaims: [],
          evidenceSentences: ["판테놀은 비타민 B5 유도체로 피부 장벽 개선에 도움을 주는 성분으로 소개됩니다."],
          ingredientBenefitLinks: [{ ingredient: "판테놀", benefit: "피부 장벽 개선" }],
          citations: []
        }
      } as never,
      hints: { locale: "ko-KR", market: "KR" }
    });

    const faq = (run.result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>)
      .find((node) => node["@type"] === "FAQPage");
    const items = (faq?.mainEntity ?? []) as Array<Record<string, any>>;
    // 이 조립기가 만드는 항목이 실제로 발행됐는지 먼저 확인한다 — 항목이 없으면
    // 아래 어서션은 아무것도 검사하지 않는다.
    expect(items.map((item) => String(item.name ?? "")).some((question) => /돕는 .*는 무엇인가요\?$/u.test(question))).toBe(true);

    for (const sentence of items.flatMap((item) => [String(item.name ?? ""), String(item.acceptedAnswer?.text ?? "")])) {
      expect(hasUnpredicatedEnumeration(sentence), sentence).toBe(false);
    }
    expect(run.result.diagnostics.validationWarnings.join("\n"))
      .not.toContain("without giving any of them a role");
  });
});
