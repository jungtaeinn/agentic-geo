import { describe, expect, it } from "vitest";
import { generatePdpGeo } from "../src/agent";
import { pdpGeoGenerationInputs } from "./fixtures/pdp-extractor-live-products";

/**
 * Regression tests for the ingredient-surface defects observed in the live
 * ExampleLuxe FCAS run (2026-08-11):
 *
 * 1. Alias duplication — "500-Hour Fermented Ginseng" (explicit ingredient)
 *    and "500-hour aged ginseng" (haystack-detected surface) are the same
 *    entity but carried different entity keys, so "Key ingredients" listed
 *    the hero ingredient twice.
 * 2. Truncated fragments — a candidate that only occurs in the source as a
 *    prefix of a longer word run ("SCUTELLARIA BAICALENS" from "SCUTELLARIA
 *    BAICALENSIS ROOT EXTRACT") surfaced as an ingredient list item.
 * 3. Article/interrogative-led fragments — sentence shards like "The changes"
 *    or "What" surfaced as ingredient list items.
 */

export const fcasLikeProduct = {
  name: "Essential Activating Serum",
  brand: "TestBrand",
  category: "Serum",
  description: "A lightweight serum for dryness, dullness, and visible fine lines.",
  benefits: ["Delivers immediate hydration while improving dryness, dullness, and overall tone."],
  effects: [],
  ingredients: ["500-Hour Fermented Ginseng", "Korean Herb Extract", "Vitamin C Derivative", "SCUTELLARIA BAICALENS", "The changes"],
  usage: ["Gently pat 2-3 pumps onto skin morning and night."],
  metrics: [],
  sourceTexts: [
    "KEY INGREDIENTS: 500-HOUR FERMENTED GINSENG: Supports a healthy skin barrier, helping visibly improve fine lines and wrinkles.",
    "500-HOUR AGED GINSENG Supports the skin barrier, helping improve visible fine lines and wrinkles KOREAN HERB EXTRACT Improves hydration, visibly firms, and addresses visible signs of aging",
    "INGREDIENTS: WATER / AQUA / EAU, ALCOHOL DENAT., BUTYLENE GLYCOL, BETAINE, SCUTELLARIA BAICALENSIS ROOT EXTRACT, ADENOSINE, TOCOPHEROL, CITRIC ACID",
    "The changes are evolutionary rather than a complete reformulation."
  ],
  semanticFacts: {
    ingredients: ["500-Hour Fermented Ginseng", "Korean Herb Extract", "500-Hour Aged Ginseng Extract (BOTANICAL EXTRACT™)", "SCUTELLARIA BAICALENS"],
    benefits: [],
    effects: [],
    skinTypes: ["dry skin"],
    usageSteps: ["Gently pat 2-3 pumps onto skin morning and night."],
    safetyTests: [],
    metricClaims: [],
    evidenceSentences: [],
    ingredientBenefitLinks: [],
    citations: []
  }
};

function ingredientSurfaces(run: Awaited<ReturnType<typeof generatePdpGeo>>): {
  keyIngredientValues: string[];
  sectionLines: string[];
  all: string;
} {
  const graph = (run.result.schemaMarkup.jsonLd["@graph"] ?? []) as Array<Record<string, unknown>>;
  const product = graph.find((node) => node["@type"] === "Product"
    || (Array.isArray(node["@type"]) && (node["@type"] as string[]).includes("Product")));
  const keyIngredientValues = ((product?.additionalProperty ?? []) as Array<Record<string, unknown>>)
    .filter((property) => typeof property.name === "string" && /^Key ingredients/i.test(property.name as string))
    .map((property) => String(property.value ?? ""));
  const sectionLines = run.result.content.sections.ingredients.split("\n");
  return {
    keyIngredientValues,
    sectionLines,
    all: `${keyIngredientValues.join("\n")}\n${run.result.content.sections.ingredients}`
  };
}

describe("ingredient surface quality (live-run defects)", () => {
  it("collapses ingredient aliases that share a numeric spec and head noun", async () => {
    const run = await generatePdpGeo({
      product: fcasLikeProduct,
      hints: { locale: "en-US", market: "US" }
    });
    const { keyIngredientValues, sectionLines } = ingredientSurfaces(run);
    const alias = /500[-\s]?hour[^,\n(]*ginseng/gi;

    // Each Key ingredients property may carry at most one surface form of the
    // same numeric-spec + head-noun entity.
    for (const value of keyIngredientValues) {
      expect((value.match(alias) ?? []).length).toBeLessThanOrEqual(1);
    }
    // The ingredients section's short name-only list items must not list the
    // same entity twice (detail sentences may still reference it).
    const nameOnlyItems = sectionLines
      .map((line) => line.trim())
      .filter((line) => /^- /.test(line) && line.length <= 60 && !/:/.test(line));
    expect(nameOnlyItems.filter((line) => alias.test(line)).length).toBeLessThanOrEqual(1);
  });

  it("drops candidates that only occur as a truncated prefix of a longer source word", async () => {
    const run = await generatePdpGeo({
      product: fcasLikeProduct,
      hints: { locale: "en-US", market: "US" }
    });
    const { all } = ingredientSurfaces(run);

    // "SCUTELLARIA BAICALENS" only appears in the source inside "SCUTELLARIA
    // BAICALENSIS ROOT EXTRACT" — a truncation artifact, not an ingredient.
    // The full INCI statement line legitimately contains the full form.
    expect(all).not.toMatch(/SCUTELLARIA BAICALENS(?!I)/i);
  });

  it("drops article-led sentence shards from ingredient surfaces", async () => {
    const run = await generatePdpGeo({
      product: fcasLikeProduct,
      hints: { locale: "en-US", market: "US" }
    });
    const { all } = ingredientSurfaces(run);

    expect(all).not.toMatch(/^-?\s*The changes\s*$/im);
    expect(all).not.toMatch(/(?:^|, )The changes(?:,|$)/im);
  });

  it("keeps thousands separators inside ingredient names when normalizing comma lists", async () => {
    // Live examplederma run (2026-08-11): "세라마이드(10,000ppm 고함량)" was split at
    // the thousands-separator comma and rejoined as "세라마이드(10, 000ppm 고함량)"
    // in "Key ingredients" and in the Korean ingredient-link sentence.
    const run = await generatePdpGeo(pdpGeoGenerationInputs["examplederma-cream-mist"]);
    const graph = (run.result.schemaMarkup.jsonLd["@graph"] ?? []) as Array<Record<string, unknown>>;
    const product = graph.find((node) => node["@type"] === "Product"
      || (Array.isArray(node["@type"]) && (node["@type"] as string[]).includes("Product"))) as Record<string, unknown>;
    const properties = (product.additionalProperty ?? []) as Array<{ name: string; value: string }>;

    const keyIngredients = properties.find((property) => property.name === "Key ingredients")?.value ?? "";
    expect(keyIngredients).toContain("10,000ppm");

    for (const property of properties) {
      expect(property.value, `additionalProperty "${property.name}"`).not.toMatch(/\d, \d{3}/);
    }
    expect(JSON.stringify(run.result.schemaMarkup.jsonLd)).not.toMatch(/\d, \d{3}(?:ppm|\s*ppm)/);
  });
});

/**
 * 측정 대상은 함유 성분이 아니다.
 *
 * 예시더마 클렌징폼(prdSeq=1145) 기술서의 차트 항목명은 "피부 각질층 내
 * 세라마이드 함량 분석"이다 — 피부 각질층에서 그 물질의 함량을 재었다는
 * 말이지, 제품이 그것을 함유한다는 말이 아니다. 그런데 성분명이 문장에
 * 들어 있다는 사실만으로 함유 근거로 읽혀, 캡션 전문과 "세라마이드"가
 * `Key ingredients`로 발행됐다.
 */
const CHART_CAPTION = "피부 각질층 내 세라마이드 함량 분석 +84.3% 자사 알칼리 폼 예시더마 클렌징폼 사용 2주 후 In vitro 시험 결과";

function cleansingFoamInput(sourceTexts: string[], semanticFacts?: Record<string, unknown>) {
  return {
    product: {
      geoProduct: {
        name: "예시더마 모이베리어365 클렌징폼",
        description: "건조하고 민감한 피부를 위한 약산성 클렌징 폼입니다.",
        brand: "EXAMPLEDERMA",
        category: "클렌징폼",
        benefits: ["피부 장벽"],
        ingredients: ["판테놀", "베타인", "보타온"],
        usage: [],
        sourceTexts,
        ...(semanticFacts ? { semanticFacts } : {})
      }
    },
    source: { type: "pdp-extractor" as const, url: "https://shop.example.com/web/product/view.do?prdSeq=1145" },
    hints: { locale: "ko-KR" as const, market: "KR" as const }
  };
}

function keyIngredientsOf(result: Awaited<ReturnType<typeof generatePdpGeo>>["result"]): string {
  const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, unknown>>;
  const product = graph.find((node) => node["@type"] === "Product") as Record<string, unknown>;
  const properties = product.additionalProperty as Array<{ name: string; value: string }>;
  return properties.find((property) => property.name === "Key ingredients")?.value ?? "";
}

describe("측정 대상과 함유 성분", () => {
  it("does not publish a measured substance as a product ingredient", async () => {
    const { result } = await generatePdpGeo(cleansingFoamInput([CHART_CAPTION]) as never);

    const keyIngredients = keyIngredientsOf(result);
    expect(keyIngredients).not.toContain("함량 분석");
    expect(keyIngredients).not.toContain("세라마이드");
  });

  it("does not publish it even when the measured claim also arrives as a semantic fact", async () => {
    const { result } = await generatePdpGeo(cleansingFoamInput([CHART_CAPTION], {
      metricClaims: [{
        value: "+84.3",
        unit: "%",
        metric: "피부 각질층 내 세라마이드 함량 분석",
        timing: "사용 2주 후",
        subject: "예시더마 클렌징폼",
        comparator: "자사 알칼리 폼"
      }]
    }) as never);

    const keyIngredients = keyIngredientsOf(result);
    expect(keyIngredients).not.toContain("함량 분석");
    expect(keyIngredients).not.toContain("세라마이드");
  });

  it("still publishes the ingredients the source says the product contains", async () => {
    const { result } = await generatePdpGeo(cleansingFoamInput([CHART_CAPTION]) as never);

    const keyIngredients = keyIngredientsOf(result);
    expect(keyIngredients).toContain("판테놀");
    expect(keyIngredients).toContain("베타인");
    expect(keyIngredients).toContain("보타온");
  });

  it("keeps a containment statement that carries a measured amount", async () => {
    // "세라마이드 10,000ppm 함유"는 함유 진술이다. 수치가 붙었다는 이유로
    // 측정 문장으로 오해하면 진짜 성분 근거를 잃는다.
    const { result } = await generatePdpGeo(cleansingFoamInput([
      "고함량 세라마이드 10,000ppm 함유로 피부 장벽을 채웁니다",
      CHART_CAPTION
    ]) as never);

    expect(keyIngredientsOf(result)).toContain("세라마이드");
  });
});

/**
 * 성분 어휘가 문장에 있다는 사실은 제품이 그것을 함유한다는 근거가 아니다.
 *
 * 실측(2026-09-03)에서 `Key ingredients`는 이렇게 발행됐다.
 *
 * - "세라마이드 대신 콜레스테롤을 쓰는 제품과 달리" → `콜레스테롤, 세라마이드`
 * - "레티놀은 넣지 않았습니다" → 그 문장이 성분으로
 * - "같은 라인의 크림에는 나이아신아마이드가" → `나이아신아마이드`
 *
 * 부재 진술이 성분 목록에 실리는 것은 사실과 반대되는 발행이고, 마지막 줄은
 * 다른 제품의 성분을 이 제품 성분으로 발행한다.
 */
describe("성분 귀속", () => {
  const attributionCases: Array<[string, string, RegExp]> = [
    ["부재 진술은 성분이 아니다", "레티놀은 넣지 않았습니다", /레티놀|넣지\s*않/],
    ["무첨가 진술은 성분이 아니다", "인공 향료 무첨가로 순하게 만들었습니다", /향료/],
    ["비교 대상은 이 제품의 성분이 아니다", "세라마이드 대신 콜레스테롤을 쓰는 제품과 달리 순한 세정에 집중했습니다", /세라마이드|콜레스테롤/],
    ["질문은 사실 진술이 아니다", "히알루론산이 들어 있냐는 질문을 많이 받습니다", /히알루론산|질문/],
    ["다른 제품에 귀속된 성분은 이 제품 성분이 아니다", "같은 라인의 크림에는 나이아신아마이드가 들어 있습니다", /나이아신아마이드|크림에는/]
  ];

  for (const [label, sourceText, forbidden] of attributionCases) {
    it(label, async () => {
      const { result } = await generatePdpGeo(cleansingFoamInput([sourceText]) as never);

      expect(keyIngredientsOf(result)).not.toMatch(forbidden);
    });
  }

  it("still reads an ingredient the source attributes to this product", async () => {
    const { result } = await generatePdpGeo(cleansingFoamInput([
      "고밀도 세라마이드 캡슐을 담아 무너진 피부 장벽을 채웁니다"
    ]) as never);

    expect(keyIngredientsOf(result)).toContain("세라마이드");
  });

  it("never publishes a whole sentence as an ingredient surface", async () => {
    // 성분 표면은 명사구다. 마침표가 없다는 이유로 문장이 표면으로 통과하면
    // 성분 목록에 서술문이 실린다.
    const { result } = await generatePdpGeo(cleansingFoamInput([
      "판테놀과 베타인이 피부 장벽을 편안하게 지켜줍니다"
    ]) as never);

    const keyIngredients = keyIngredientsOf(result);
    expect(keyIngredients).not.toContain("지켜줍니다");
    expect(keyIngredients).not.toContain("편안하게");
  });
});

/**
 * 미국 대상 페이지에서도 같은 판정이 서야 한다. 부재·비교·질문·타 제품 귀속은
 * 문장의 기능이고, 그 기능은 언어가 바뀌어도 그대로 있다.
 */
describe("성분 귀속 — 영문", () => {
  function serumInput(sourceTexts: string[]) {
    return {
      product: {
        geoProduct: {
          name: "BarrierCare365 Cleansing Foam",
          description: "A mildly acidic cleansing foam for dry and sensitive skin.",
          brand: "EXAMPLEDERMA",
          category: "Cleanser",
          benefits: ["skin barrier"],
          ingredients: ["Panthenol"],
          usage: [],
          sourceTexts
        }
      },
      source: { type: "pdp-extractor" as const, url: "https://shop.example.com/products/barriercare365-cleansing-foam" },
      hints: { locale: "en-US" as const, market: "US" as const }
    };
  }

  const cases: Array<[string, string, RegExp]> = [
    ["absence is not an ingredient", "Formulated without retinol", /retinol/i],
    ["free-of is not an ingredient", "This cleanser is free of artificial fragrance", /fragrance/i],
    ["a comparison target is not this product's ingredient", "Unlike products that use cholesterol instead of ceramide, it focuses on mild cleansing", /cholesterol|ceramide/i],
    ["a question is not a statement of fact", "Does it contain hyaluronic acid?", /hyaluronic/i],
    ["another product's ingredient is not this product's", "The cream in the same line contains niacinamide", /niacinamide/i]
  ];

  for (const [label, sourceText, forbidden] of cases) {
    it(label, async () => {
      const { result } = await generatePdpGeo(serumInput([sourceText]) as never);

      expect(keyIngredientsOf(result)).not.toMatch(forbidden);
    });
  }

  it("still reads an ingredient the English source attributes to the product", async () => {
    const { result } = await generatePdpGeo(serumInput([
      "Contains High-density Ceramide Capsule to refill a weakened skin barrier"
    ]) as never);

    expect(keyIngredientsOf(result)).toMatch(/ceramide/i);
  });
});

/**
 * 성분 표면은 명사구다.
 *
 * 복합 성분명 판정이 "성분명이 있고 두 낱말 이상"이라, 서술문이 복합 성분명으로
 * 인정됐다. `고밀도 세라마이드 캡슐`(수식어 + 머리명사)과 `Contains Panthenol to
 * soothe`(동사 + 목적어 + 목적)를 낱말 수로는 가를 수 없다. 그렇게 들어온 문장은
 * 자기 안의 성분명보다 길어서, 같은 성분을 가리키는 대표 표면 자리를 차지했다.
 */
describe("성분 표면의 형태", () => {
  it("does not publish an English sentence as a compound ingredient name", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "BarrierCare365 Cleansing Foam",
          description: "A mildly acidic cleansing foam for dry and sensitive skin.",
          brand: "EXAMPLEDERMA",
          category: "Cleanser",
          benefits: ["skin barrier"],
          ingredients: ["Panthenol"],
          usage: [],
          sourceTexts: ["Contains Panthenol to soothe"]
        }
      },
      source: { type: "pdp-extractor" as const, url: "https://shop.example.com/products/foam" },
      hints: { locale: "en-US" as const, market: "US" as const }
    } as never);

    const keyIngredients = keyIngredientsOf(result);
    expect(keyIngredients).toBe("Panthenol");
  });

  it("keeps a compound ingredient name that is a noun phrase", async () => {
    const { result } = await generatePdpGeo(cleansingFoamInput([
      "고밀도 세라마이드 캡슐"
    ]) as never);

    expect(keyIngredientsOf(result)).toContain("고밀도 세라마이드 캡슐");
  });
});

/**
 * 함유 진술의 주체는 제품이다.
 *
 * 1027 실측(2026-09-03)에서 `Key ingredients`에 `콜레스테롤, 지방산`이 실렸다.
 * 근거를 따라가면 FAQ의 이 문장이다.
 *
 *   "이 지질은 세라마이드/콜레스테롤/지방산이라는 성분으로 이루어져있고
 *    층층이 쌓인 층판형 구조를 가지고 있습니다."
 *
 * 피부 지질이 무엇으로 이루어져 있는지 설명하는 문장이고, 이 제품이 그것을
 * 함유한다는 말이 아니다. 결과가 우연히 맞을 수 있어도 근거가 틀렸다.
 */
describe("함유 진술의 주체", () => {
  const SKIN_LIPID_SENTENCE = "이 지질은 세라마이드/콜레스테롤/지방산이라는 성분으로 이루어져있고 층층이 쌓인 층판형 구조를 가지고 있습니다.";

  it("does not read a skin-composition explanation as the product's ingredients", async () => {
    const { result } = await generatePdpGeo(cleansingFoamInput([SKIN_LIPID_SENTENCE]) as never);

    const keyIngredients = keyIngredientsOf(result);
    expect(keyIngredients).not.toContain("콜레스테롤");
    expect(keyIngredients).not.toContain("지방산");
  });

  it("still reads a composition statement about the product's own formula", async () => {
    // 무엇으로 이루어졌다는 진술이라도 그 대상이 제품의 포뮬러이면 함유 근거다.
    const { result } = await generatePdpGeo(cleansingFoamInput([
      "고밀도 세라마이드 캡슐로 구성된 포뮬러"
    ]) as never);

    expect(keyIngredientsOf(result)).toContain("세라마이드");
  });

  it("still reads a containment statement that also explains skin", async () => {
    // 피부를 설명하면서 제품 함유도 밝히는 문장은 함유 근거다.
    const { result } = await generatePdpGeo(cleansingFoamInput([
      "피부 지질과 유사한 세라마이드를 10,000ppm 함유했습니다"
    ]) as never);

    expect(keyIngredientsOf(result)).toContain("세라마이드");
  });
});

/**
 * FAQ 유래 근거도 같은 게이트를 지나야 한다.
 *
 * 1027 실측에서 여러 주제가 한 덩어리로 붙은 FAQ 블롭이 성분 근거로 그대로
 * 들어왔다. 그 안의 피부 구성 설명("이 지질은 세라마이드/콜레스테롤/지방산이라는
 * 성분으로 이루어져있고")에서 콜레스테롤·지방산이 이 제품의 성분으로 발행됐다.
 */
describe("FAQ 유래 성분 근거", () => {
  it("does not read a multi-topic FAQ blob as this product's ingredients", async () => {
    const { result } = await generatePdpGeo(cleansingFoamInput([
      "피부장벽에서도 지질의 역할이 매우 중요한데, 이 지질은 세라마이드/콜레스테롤/지방산이라는 성분으로 이루어져있고 층층이 쌓인 층판형 구조를 가지고 있습니다. 크림을 평상시 루틴으로 사용하는 경우 사용 순서는 어떻게 되나요? 세안 후 에센스 다음에 사용하세요."
    ]) as never);

    const keyIngredients = keyIngredientsOf(result);
    expect(keyIngredients).not.toContain("콜레스테롤");
    expect(keyIngredients).not.toContain("지방산");
  });
});

/**
 * 성분 표면은 명사구다 — 한국어에서도.
 *
 * 1027 실측에서 `Key ingredients`에 `10,000ppm 세라마이드로 가득 채운 미세촘촘
 * 안개미스트`가 실렸다. 마케팅 문구이고, `가득 채운`은 뒤 명사를 수식하는
 * 관형형 서술이다. 절 판정이 영문 기능어와 한국어 종결어미만 보아 관형형
 * 서술을 놓쳤다.
 */
describe("한국어 성분 표면의 형태", () => {
  it("does not publish a Korean marketing phrase as a compound ingredient name", async () => {
    const { result } = await generatePdpGeo(cleansingFoamInput([
      "10,000ppm 세라마이드로 가득 채운 미세촘촘 안개미스트"
    ]) as never);

    const keyIngredients = keyIngredientsOf(result);
    expect(keyIngredients).not.toContain("가득 채운");
    expect(keyIngredients).not.toContain("안개미스트");
  });

  it("keeps a Korean compound ingredient name", async () => {
    const { result } = await generatePdpGeo(cleansingFoamInput([
      "고밀도 세라마이드 캡슐"
    ]) as never);

    expect(keyIngredientsOf(result)).toContain("고밀도 세라마이드 캡슐");
  });
});

/**
 * 같은 성분은 한 번만 실린다.
 *
 * 1027 실측에서 `Key ingredients`가 `Ceramide, 세라마이드 10,000ppm`이었다.
 * 로케일이 ko-KR인데 같은 성분의 영문 표면과 한글 표면이 함께 실렸다 — 읽는
 * 사람에게는 두 가지 성분처럼 보인다.
 */
describe("성분 표면의 언어", () => {
  it("does not list one ingredient under two language surfaces", async () => {
    const { result } = await generatePdpGeo(cleansingFoamInput([
      "Ceramide 10,000 ppm",
      "세라마이드 10,000ppm 함유"
    ]) as never);

    const keyIngredients = keyIngredientsOf(result);
    const listsBoth = /Ceramide/i.test(keyIngredients) && keyIngredients.includes("세라마이드");
    expect(listsBoth).toBe(false);
  });

  it("keeps the Korean surface for a Korean page", async () => {
    const { result } = await generatePdpGeo(cleansingFoamInput([
      "Ceramide 10,000 ppm",
      "세라마이드 10,000ppm 함유"
    ]) as never);

    expect(keyIngredientsOf(result)).toContain("세라마이드");
  });
});

/**
 * 영문 패키지 라벨 전문은 성분명이 아니다.
 *
 * 1027 최종 실행에서 `Key ingredients`에 `Ceramide 1000 ppm Moisturizing &
 * strengthening for dry & sensitive skin`이 실렸다. 패키지에 인쇄된 라벨 블록
 * 전체이고, 성분명 하나가 아니다. 절 판정의 영문 기능어 목록에 전치사가 빠져
 * 이 문장이 명사구로 통과했다.
 */
describe("영문 라벨 블록", () => {
  function mistInput(sourceTexts: string[]) {
    return {
      product: {
        geoProduct: {
          name: "모이베리어 365 크림 미스트",
          description: "건조하고 민감한 피부를 위한 크림 미스트입니다.",
          brand: "EXAMPLEDERMA",
          category: "미스트",
          benefits: ["보습"],
          ingredients: [],
          usage: [],
          sourceTexts
        }
      },
      source: { type: "pdp-extractor" as const, url: "https://shop.example.com/web/product/view.do?prdSeq=1027" },
      hints: { locale: "ko-KR" as const, market: "KR" as const }
    };
  }

  it("does not publish an English label block as an ingredient name", async () => {
    const { result } = await generatePdpGeo(mistInput([
      "Ceramide 1000 ppm Moisturizing & strengthening for dry & sensitive skin"
    ]) as never);

    const keyIngredients = keyIngredientsOf(result);
    expect(keyIngredients).not.toContain("Moisturizing");
    expect(keyIngredients).not.toContain("for dry");
  });

  it("keeps a名 that carries only its amount", async () => {
    const { result } = await generatePdpGeo(mistInput([
      "Ceramide 10,000 ppm 함유"
    ]) as never);

    expect(keyIngredientsOf(result)).toMatch(/ceramide|세라마이드/i);
  });

  it("keeps an English compound ingredient name", async () => {
    const { result } = await generatePdpGeo(mistInput([
      "Contains High-density Ceramide Capsule"
    ]) as never);

    expect(keyIngredientsOf(result)).toMatch(/ceramide/i);
  });
});

/**
 * 이름의 일부인 범주어는 떼어내지 않는다.
 *
 * 1144 실측에서 `Product.description`에 `주요 성분은 세라마이드와 Barrier
 * Protective이며`가 실렸다. 원문의 이름은 `Barrier Protective Formula`인데
 * 끝의 `Formula`가 범주어로 읽혀 떨어졌다. 남은 `Barrier Protective`는
 * 형용사구여서 `~가 포함된`도 어색해진다.
 *
 * 범주어를 떼는 것 자체는 맞다 — `고밀도 세라마이드 성분`에서 `성분`은 이름이
 * 아니다. 두 경우를 가르는 것은 **떼고 남은 말이 여전히 성분을 가리키는가**다.
 */
describe("이름 속 범주어", () => {
  function cleanserInput(sourceTexts: string[]) {
    return {
      product: {
        geoProduct: {
          name: "예시더마 모이베리어365 젠틀 포밍클렌저",
          description: "건조하고 민감한 피부를 위한 포밍 클렌저입니다.",
          brand: "EXAMPLEDERMA",
          category: "클렌저",
          benefits: ["피부 장벽"],
          ingredients: ["Barrier Protective Formula", "세라마이드"],
          usage: [],
          sourceTexts
        }
      },
      source: { type: "pdp-extractor" as const, url: "https://shop.example.com/web/product/view.do?prdSeq=1144" },
      hints: { locale: "ko-KR" as const, market: "KR" as const }
    };
  }

  it("keeps Formula when it is part of the name", async () => {
    const { result } = await generatePdpGeo(cleanserInput([
      "Barrier Protective Formula는 세안 중 발생할 수 있는 피부 장벽 손상을 줄이도록 설계된 포뮬러입니다."
    ]) as never);

    const published = JSON.stringify(result.schemaMarkup.jsonLd) + JSON.stringify(result.content.sections);
    expect(published).not.toMatch(/Barrier Protective(?!\s+Formula)/u);
  });

  it("still drops a trailing category word that is not part of a name", async () => {
    const { result } = await generatePdpGeo(cleanserInput([
      "고밀도 세라마이드 성분은 피부 장벽을 채우는 데 도움을 줍니다."
    ]) as never);

    const published = JSON.stringify(result.schemaMarkup.jsonLd);
    expect(published).toContain("세라마이드");
  });
});

/**
 * 형태가 깨진 조각은 성분명이 될 수 없다 — 성분 어휘가 들어 있어도 마찬가지다.
 *
 * 1144 실측에서 `content.sections.ingredients`에 이런 항목들이 실렸다.
 *
 *   - 세안 중 발생하                          ← 용언 어간에서 잘린 절
 *   - Barrier-Protective Formula cleansing.   ← 마침표까지 붙은 라벨 전사 조각
 *
 * 조각 판정이 성분 어휘(`Formula`)를 먼저 보고 "이름이다"라고 단정해, 그 뒤의
 * 형태 검사에 닿지 못했다. 형태 결함을 먼저 본다.
 */
/**
 * 영문 서술 동사는 닫힌 부류가 아니다.
 *
 * 절 판정이 `helps`·`contains`를 열거해 두었더니 목록 밖의 동사로 쓴 마케팅
 * 절이 명사구로 통과해 성분명 자리를 차지했다. 굴절로 잡아야 닫힌다.
 */
describe("영문 서술 절", () => {
  function usInput(ingredients: string[]) {
    return {
      product: {
        geoProduct: {
          name: "Gentle Cleansing Foam",
          description: "A gentle foaming cleanser for dry and sensitive skin.",
          brand: "EXAMPLEDERMA",
          category: "cleanser",
          benefits: ["barrier care"],
          ingredients,
          usage: [],
          sourceTexts: []
        }
      },
      source: { type: "pdp-extractor" as const, url: "https://example.com/product/1" },
      hints: { locale: "en-US" as const, market: "US" as const }
    };
  }

  it("does not publish a marketing clause as an ingredient name", async () => {
    const { result } = await generatePdpGeo(usInput([
      "Barrier Protective Formula",
      "Ceramide Complex soothes dryness"
    ]) as never);

    // 성분명 자리만 본다. 같은 절이 `Brand science` 프로퍼티로도 나가는 것은
    // 별건이다 — 그 경로는 en-US에서 형태 검사를 전혀 하지 않는다.
    const graph = ((result.schemaMarkup.jsonLd as Record<string, unknown>)["@graph"] ?? []) as Array<Record<string, unknown>>;
    const ingredientSurfaces = [
      result.content.sections.ingredients,
      ...graph
        .flatMap((node) => (node.additionalProperty ?? []) as Array<{ name: string; value: string }>)
        .filter((property) => /ingredient/i.test(property.name))
        .map((property) => property.value)
    ].join(" | ");

    expect(ingredientSurfaces).not.toContain("soothes dryness");
    expect(ingredientSurfaces).toContain("Barrier Protective Formula");
  });

  it("still publishes a name whose head noun is plural", async () => {
    // `Amino Acids Complex`의 `Acids`는 동사가 아니다 — 이름은 대문자로 쓴다.
    const { result } = await generatePdpGeo(usInput([
      "Amino Acids Complex"
    ]) as never);

    expect(JSON.stringify(result.schemaMarkup.jsonLd) + JSON.stringify(result.content.sections))
      .toContain("Amino Acids Complex");
  });
});

describe("깨진 조각", () => {
  function foamInput(ingredients: string[]) {
    return {
      product: {
        geoProduct: {
          name: "예시더마 모이베리어365 젠틀 포밍클렌저",
          description: "건조하고 민감한 피부를 위한 포밍 클렌저입니다.",
          brand: "EXAMPLEDERMA",
          category: "클렌저",
          benefits: ["피부 장벽"],
          ingredients,
          usage: [],
          sourceTexts: []
        }
      },
      source: { type: "pdp-extractor" as const, url: "https://shop.example.com/web/product/view.do?prdSeq=1144" },
      hints: { locale: "ko-KR" as const, market: "KR" as const }
    };
  }

  it("does not publish a clause cut at a verb stem", async () => {
    const { result } = await generatePdpGeo(foamInput([
      "Barrier Protective Formula",
      "세안 중 발생하"
    ]) as never);

    const published = JSON.stringify(result.schemaMarkup.jsonLd) + JSON.stringify(result.content.sections);
    expect(published).not.toContain("세안 중 발생하");
  });

  it("does not publish a transcription fragment that ends in punctuation", async () => {
    const { result } = await generatePdpGeo(foamInput([
      "Barrier Protective Formula",
      "Barrier-Protective Formula cleansing."
    ]) as never);

    const published = JSON.stringify(result.schemaMarkup.jsonLd) + JSON.stringify(result.content.sections);
    expect(published).not.toContain("cleansing.");
  });

  it("does not publish a clause whose argument carries a case particle", async () => {
    // `피부에 닿는`의 `는`을 주제 조사로 읽어 `피부에 닿`이 성분명으로 남았다.
    // 어간을 열거해 막을 수 없다 — 성분명은 명사구이고, 격조사로 표시된 논항을
    // 품은 줄은 절이라는 형태 사실로 막는다.
    const { result } = await generatePdpGeo(foamInput([
      "Barrier Protective Formula",
      "피부에 닿"
    ]) as never);

    const published = JSON.stringify(result.schemaMarkup.jsonLd) + JSON.stringify(result.content.sections);
    expect(published).not.toContain("피부에 닿");
  });

  it("still publishes a name whose noun happens to end in a particle syllable", async () => {
    // `알로에`는 `알로` + 격조사 `에`가 아니다. 격조사 규칙이 낱말 내부의 음절을
    // 조사로 읽으면 실제 성분이 발행물에서 사라진다.
    const { result } = await generatePdpGeo(foamInput([
      "알로에 베라 추출물",
      "판테놀"
    ]) as never);

    expect(JSON.stringify(result.schemaMarkup.jsonLd) + JSON.stringify(result.content.sections))
      .toContain("알로에 베라 추출물");
  });

  it("still publishes the intact name", async () => {
    const { result } = await generatePdpGeo(foamInput([
      "Barrier Protective Formula",
      "세안 중 발생하"
    ]) as never);

    expect(JSON.stringify(result.schemaMarkup.jsonLd)).toContain("Barrier Protective Formula");
  });
});
