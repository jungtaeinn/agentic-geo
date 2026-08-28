import type { PdpGeoGenerationInput, PdpGeoLocale } from "../../src/types";

/**
 * pdp-extractor-agent 결과물 형태(GeoProductRawData)로 구성한 라이브 PDP 목업 픽스처.
 *
 * 원본 PDP (2026-07-31 수집):
 * - https://example.com/products/botanical-renewal-serum?variant=example-variant-1
 * - https://example.com/products/essential-activating-serum?variant=example-variant-2
 * - https://example.com/web/product/view.do?prdSeq=1149
 * - https://example.com/web/product/view.do?prdSeq=1027
 *
 * 데이터 출처:
 * - ExampleLuxe: Shopify product JSON(`/products/<handle>.js`) + 상세 인포그래픽 이미지 OCR
 *   (ingredient/clinical infographic — 정량 클레임 원문 그대로 전사).
 * - EXAMPLEDERMA: 상품 상세 페이지 HTML(FAQ/전성분/리뷰) + editor 상세 이미지 OCR
 *   (효능/정량 테스트 수치/사용법/안전성 테스트 원문 전사).
 *
 * 구조 계약:
 * - `geoProduct`는 packages/pdp-extractor-agent/src/types.ts 의 `GeoProductRawData`를
 *   구조적으로 미러링한다(이 패키지는 extractor에 의존하지 않으므로 타입을 복제).
 * - `sku`/`gtin`/`availability`/`variants`/`canonicalUrl`/`offerUrl`은 commerce contract
 *   확장 GEO 입력 계약 필드로, agent-api(external dispatcher) 경로에서 함께 전달된다.
 * - `agentApiSubmitPayloads`는 apps/agent-api `SubmitGenerationDto`
 *   (`{ geoGenerationId, locale, product }`) 계약을 그대로 따른다.
 *   `product.canonicalUrl`은 agent-api `extractSourceUrl()`이 JSON-LD @id 앵커로 사용한다.
 *
 * 이 픽스처는 frozen mock 이다. 생성 품질 점수를 올리기 위해 값을 "개선"하지 말 것 —
 * 원본 PDP와 달라지는 순간 회귀 비교 기준이 무너진다.
 */

// ---------------------------------------------------------------------------
// pdp-extractor-agent output contract mirror (GeoProductRawData 구조 복제)
// ---------------------------------------------------------------------------

export interface ExtractorFaqItem {
  question: string;
  answer: string;
}

export interface ExtractorReviewItem {
  body: string;
  author?: string;
  rating?: number;
  datePublished?: string;
}

export type ExtractorContentCategory =
  | "benefit"
  | "effect"
  | "ingredient"
  | "usage"
  | "faq"
  | "review"
  | "rating"
  | "metric"
  | "unknown";

export interface ExtractorContentSection {
  title: string;
  category: ExtractorContentCategory;
  text: string;
  bullets: string[];
}

export type ExtractorKeywordCategory =
  | "product"
  | "price"
  | "benefit"
  | "effect"
  | "ingredient"
  | "usage"
  | "faq"
  | "review"
  | "metric"
  | "trend"
  | "unknown";

export interface ExtractorKeywordGroups {
  product: string[];
  price: string[];
  benefit: string[];
  effect: string[];
  ingredient: string[];
  usage: string[];
  faq: string[];
  review: string[];
  metric: string[];
  trend: string[];
  unknown: string[];
}

export interface ExtractorSemanticMetricClaim {
  label?: string;
  subject?: string;
  value?: string;
  unit?: string;
  metric?: string;
  direction?: string;
  timing?: string;
  period?: string;
  sample?: string;
  method?: string;
  caveat?: string;
  sentence?: string;
  sourceText?: string;
}

export interface ExtractorSemanticIngredientBenefitLink {
  ingredient?: string;
  benefit?: string;
  effect?: string;
  sentence?: string;
  sourceText?: string;
}

export interface ExtractorSemanticFacts {
  ingredients: string[];
  benefits: string[];
  effects: string[];
  skinTypes: string[];
  usageSteps: string[];
  metricClaims: ExtractorSemanticMetricClaim[];
  evidenceSentences: string[];
  ingredientBenefitLinks: ExtractorSemanticIngredientBenefitLink[];
}

export interface ExtractorSentenceInsight {
  imageUrl?: string;
  text: string;
  category: ExtractorKeywordCategory;
  keywords: string[];
  semanticFacts?: Partial<ExtractorSemanticFacts>;
}

export interface ExtractorRagChunk {
  id: string;
  kind: "product" | "review" | "faq" | "ocr" | "source";
  text: string;
}

/** GeoProductRawData 미러 + commerce contract 확장 필드(sku/gtin/availability/variants). */
export interface ExtractorGeoProductRawData {
  name: string;
  brand?: string;
  price?: {
    raw: string;
    amount?: number;
    currency?: string;
  };
  description?: string;
  images: string[];
  options: string[];
  benefits: string[];
  effects: string[];
  ingredients: string[];
  usage: string[];
  metrics: string[];
  faq: ExtractorFaqItem[];
  reviews: {
    rating?: number;
    reviewCount?: number;
    items: ExtractorReviewItem[];
    keywords: string[];
  };
  sourceExtraction: {
    html: {
      description?: string;
      sections: ExtractorContentSection[];
      faq: ExtractorFaqItem[];
    };
    ocr: {
      imageTexts: Array<{
        imageUrl: string;
        text: string;
      }>;
      textBlocks: string[];
      sentenceInsights: ExtractorSentenceInsight[];
      semanticFacts?: ExtractorSemanticFacts;
    };
  };
  aiAnalysis: {
    keywords: ExtractorKeywordGroups;
    categorizedSections: ExtractorContentSection[];
    summary?: string;
    semanticFacts?: ExtractorSemanticFacts;
  };
  semanticFacts?: ExtractorSemanticFacts;
  categorizedProductInfo: {
    benefits: string[];
    effects: string[];
    ingredients: string[];
    usage: string[];
    metrics: string[];
    faq: ExtractorFaqItem[];
  };
  customerReviewAnalysis: {
    rating?: number;
    reviewCount?: number;
    items: ExtractorReviewItem[];
    keywords: string[];
    reviewSignals: string[];
    ratingSummary?: string;
  };
  contentAnalysis: {
    sections: ExtractorContentSection[];
    reviewSignals: string[];
    ratingSummary?: string;
  };
  ocr: {
    textBlocks: string[];
    keywords: ExtractorKeywordGroups;
    sentenceInsights: ExtractorSentenceInsight[];
  };
  rag: {
    chunks: ExtractorRagChunk[];
  };
  /** commerce contract 확장 GEO 입력 계약 필드 (extractor 자체 산출물엔 없고 커머스 원천에서 병합됨). */
  sku?: string;
  gtin?: string;
  availability?: string;
  variants?: string[];
  tags?: string[];
}

/** ProductExtractionResult 미러 (extractor의 최종 아티팩트 shape). */
export interface ExtractorRunResultMock {
  source: string;
  sourceType: "url";
  geoProduct: ExtractorGeoProductRawData;
  generatedAt: string;
  ragProfile: string;
}

/** apps/agent-api SubmitGenerationDto 계약 미러 (`POST /internal/v1/geo/generations`). */
export interface AgentApiSubmitGenerationPayload {
  geoGenerationId: string;
  locale: string;
  product: Record<string, unknown>;
}

const EXTRACTED_AT = "2026-07-31T09:00:00.000Z";
const EXTRACTOR_RAG_PROFILE = "pdp-extractor-default";

function keywordGroups(partial: Partial<ExtractorKeywordGroups>): ExtractorKeywordGroups {
  return {
    product: [],
    price: [],
    benefit: [],
    effect: [],
    ingredient: [],
    usage: [],
    faq: [],
    review: [],
    metric: [],
    trend: [],
    unknown: [],
    ...partial
  };
}

interface ExtractorProductDefinition {
  slug: string;
  name: string;
  brand: string;
  description: string;
  price?: { raw: string; amount?: number; currency?: string };
  images: string[];
  options: string[];
  benefits: string[];
  effects: string[];
  ingredients: string[];
  usage: string[];
  metrics: string[];
  faq: ExtractorFaqItem[];
  reviews: {
    rating?: number;
    reviewCount?: number;
    items: ExtractorReviewItem[];
    keywords: string[];
  };
  htmlSections: ExtractorContentSection[];
  ocrImageTexts: Array<{ imageUrl: string; text: string }>;
  sentenceInsights: ExtractorSentenceInsight[];
  keywords: Partial<ExtractorKeywordGroups>;
  summary: string;
  semanticFacts: ExtractorSemanticFacts;
  reviewSignals: string[];
  ratingSummary?: string;
  sku?: string;
  gtin?: string;
  availability?: string;
  variants?: string[];
  tags?: string[];
}

/**
 * extractor 파이프라인이 보장하는 미러링 불변식을 그대로 재현한다:
 * categorizedProductInfo == 최상위 목록, ocr == sourceExtraction.ocr,
 * customerReviewAnalysis == reviews + 신호, rag.chunks는 product/faq/review/ocr에서 파생.
 */
function buildExtractorGeoProduct(def: ExtractorProductDefinition): ExtractorGeoProductRawData {
  const textBlocks = def.ocrImageTexts.map((item) => item.text);
  const keywords = keywordGroups(def.keywords);
  const ratingSummary =
    def.ratingSummary ??
    (def.reviews.rating !== undefined && def.reviews.reviewCount !== undefined
      ? `Rating ${def.reviews.rating} · ${def.reviews.reviewCount} reviews`
      : undefined);
  const contentSections: ExtractorContentSection[] = [
    ...def.htmlSections,
    ...(ratingSummary
      ? [{ title: "Customer rating", category: "rating" as const, text: ratingSummary, bullets: [ratingSummary] }]
      : [])
  ];

  return {
    name: def.name,
    brand: def.brand,
    price: def.price,
    description: def.description,
    images: def.images,
    options: def.options,
    benefits: def.benefits,
    effects: def.effects,
    ingredients: def.ingredients,
    usage: def.usage,
    metrics: def.metrics,
    faq: def.faq,
    reviews: def.reviews,
    sourceExtraction: {
      html: {
        description: def.description,
        sections: def.htmlSections,
        faq: def.faq
      },
      ocr: {
        imageTexts: def.ocrImageTexts,
        textBlocks,
        sentenceInsights: def.sentenceInsights,
        semanticFacts: def.semanticFacts
      }
    },
    aiAnalysis: {
      keywords,
      categorizedSections: def.htmlSections,
      summary: def.summary,
      semanticFacts: def.semanticFacts
    },
    semanticFacts: def.semanticFacts,
    categorizedProductInfo: {
      benefits: def.benefits,
      effects: def.effects,
      ingredients: def.ingredients,
      usage: def.usage,
      metrics: def.metrics,
      faq: def.faq
    },
    customerReviewAnalysis: {
      rating: def.reviews.rating,
      reviewCount: def.reviews.reviewCount,
      items: def.reviews.items,
      keywords: def.reviews.keywords,
      reviewSignals: def.reviewSignals,
      ratingSummary
    },
    contentAnalysis: {
      sections: contentSections,
      reviewSignals: def.reviewSignals,
      ratingSummary
    },
    ocr: {
      textBlocks,
      keywords,
      sentenceInsights: def.sentenceInsights
    },
    rag: {
      chunks: [
        {
          id: `${def.slug}-product-1`,
          kind: "product",
          text: [def.name, def.description, ...def.benefits, ...def.effects].join("\n")
        },
        ...def.faq.map((item, index) => ({
          id: `${def.slug}-faq-${index + 1}`,
          kind: "faq" as const,
          text: `Q. ${item.question}\nA. ${item.answer}`
        })),
        ...def.reviews.items.map((item, index) => ({
          id: `${def.slug}-review-${index + 1}`,
          kind: "review" as const,
          text: item.body
        })),
        ...textBlocks.map((text, index) => ({
          id: `${def.slug}-ocr-${index + 1}`,
          kind: "ocr" as const,
          text
        }))
      ]
    },
    sku: def.sku,
    gtin: def.gtin,
    availability: def.availability,
    variants: def.variants,
    tags: def.tags
  };
}

// ---------------------------------------------------------------------------
// 1) ExampleLuxe — Botanical Renewal Serum (en-US)
// ---------------------------------------------------------------------------

const CGR_URL =
  "https://example.com/products/botanical-renewal-serum?variant=example-variant-1";

const CGR_INGREDIENT_INFOGRAPHIC_IMAGE =
  "https://cdn.example.com/products/BRAND.COM_1080x1080_NewCGRSerum_05.IngredientInfographic_4f97acea-b35d-4f31-906a-568f186a978f.jpg";
const CGR_CLINICAL_INFOGRAPHIC_IMAGE =
  "https://cdn.example.com/products/CGR_Serum_02._Clinical_Infographic_Brand.com__1080px_1_1_ratio.jpg";

const CGR_OCR_INGREDIENT_TEXT =
  "GINSENG ACTIVES. Help rejuvenate and strengthen for healthy, youthful-looking skin. " +
  "GINSENG PEPTIDE(TM). Helps support skin firmness and elasticity. " +
  "GINSENG CAPSULES WITH RETINOL. Bursts upon application to deliver powerful anti-aging benefits and enhance absorption. " +
  "NIACINAMIDE. Helps improve skin radiance.";

const CGR_OCR_CLINICAL_TEXT =
  "AFTER 6 WEEKS OF USE, 100% SHOWED IMPROVEMENT IN FINE LINES, WRINKLES, ELASTICITY, FIRMNESS. " +
  "*Instrumental result, 32 women, with daily use.";

export const exampleluxeRenewalSerumGeoProduct = buildExtractorGeoProduct({
  slug: "exampleluxe-renewal-serum",
  name: "Botanical Renewal Serum",
  brand: "ExampleLuxe",
  description:
    "Unlock your skin's youthful radiance with our Botanical Renewal Serum. " +
    "This powerful formula is enhanced with our advanced capsule technology for optimal absorption. " +
    "Retinol-infused capsules melt into skin on contact to visibly reduce fine lines and improve firmness. " +
    "This advanced system improves moisturization, rejuvenates, and refines the look of skin texture.",
  price: { raw: "$215.00", amount: 215, currency: "USD" },
  images: [
    "https://cdn.example.com/products/BRAND.COM_1080x1080_NewCGRSerum_01.Packshot_50ml.jpg",
    "https://cdn.example.com/products/CGR_Serum_01._Texture_Brand.com_1080px_1_1_ratio.jpg",
    CGR_INGREDIENT_INFOGRAPHIC_IMAGE,
    CGR_CLINICAL_INFOGRAPHIC_IMAGE
  ],
  options: ["50 mL"],
  benefits: ["anti-aging", "firming", "moisturizing"],
  effects: [
    "visibly reduced fine lines",
    "improved firmness and elasticity",
    "refined skin texture",
    "improved moisturization"
  ],
  ingredients: [
    "Botanical Actives",
    "Ginseng Peptide",
    "Ginseng Capsules with Retinol",
    "Niacinamide"
  ],
  usage: ["Apply morning and night after toner, gently pressing into skin until absorbed."],
  metrics: [
    "100% showed improvement in fine lines, wrinkles, elasticity and firmness after 6 weeks of use (instrumental result, 32 women, with daily use)."
  ],
  faq: [],
  reviews: { items: [], keywords: [] },
  htmlSections: [
    {
      title: "Key ingredients",
      category: "ingredient",
      text: "KEY INGREDIENTS: Botanical Actives, Ginseng Peptide, Ginseng Capsules with Retinol, Niacinamide.",
      bullets: ["Botanical Actives", "Ginseng Peptide", "Ginseng Capsules with Retinol", "Niacinamide"]
    },
    {
      title: "Solution for",
      category: "benefit",
      text: "SOLUTION FOR: Fine lines and wrinkles, loss of firmness and elasticity, and uneven texture.",
      bullets: ["fine lines and wrinkles", "loss of firmness and elasticity", "uneven texture"]
    },
    {
      title: "Works best for",
      category: "usage",
      text: "WORKS BEST FOR: Normal, dry, combination, and oily skin types.",
      bullets: ["normal", "dry", "combination", "oily"]
    }
  ],
  ocrImageTexts: [
    { imageUrl: CGR_INGREDIENT_INFOGRAPHIC_IMAGE, text: CGR_OCR_INGREDIENT_TEXT },
    { imageUrl: CGR_CLINICAL_INFOGRAPHIC_IMAGE, text: CGR_OCR_CLINICAL_TEXT }
  ],
  sentenceInsights: [
    {
      imageUrl: CGR_INGREDIENT_INFOGRAPHIC_IMAGE,
      text: "Ginseng Capsules with Retinol bursts upon application to deliver powerful anti-aging benefits and enhance absorption.",
      category: "ingredient",
      keywords: ["Ginseng Capsules with Retinol", "anti-aging", "absorption"]
    },
    {
      imageUrl: CGR_INGREDIENT_INFOGRAPHIC_IMAGE,
      text: "Niacinamide helps improve skin radiance.",
      category: "ingredient",
      keywords: ["Niacinamide", "radiance"]
    },
    {
      imageUrl: CGR_CLINICAL_INFOGRAPHIC_IMAGE,
      text: "After 6 weeks of use, 100% showed improvement in fine lines, wrinkles, elasticity, firmness (instrumental result, 32 women, with daily use).",
      category: "metric",
      keywords: ["100%", "6 weeks", "fine lines", "firmness", "instrumental result"]
    }
  ],
  keywords: {
    product: ["Botanical Renewal Serum", "ExampleLuxe", "serum"],
    price: ["$215.00"],
    benefit: ["anti-aging", "firming", "moisturizing"],
    effect: ["visibly reduced fine lines", "improved firmness and elasticity", "refined skin texture"],
    ingredient: ["Botanical Actives", "Ginseng Peptide", "Ginseng Capsules with Retinol", "Niacinamide"],
    usage: ["apply morning and night after toner"],
    metric: ["100% improvement after 6 weeks", "instrumental result, 32 women"],
    trend: ["best seller"]
  },
  summary:
    "ExampleLuxe anti-aging serum evidence: retinol-infused ginseng capsules, instrumental 6-week improvement claims, and skin-type coverage were categorized into product fields.",
  semanticFacts: {
    ingredients: ["Botanical Actives", "Ginseng Peptide", "Ginseng Capsules with Retinol", "Niacinamide"],
    benefits: ["anti-aging", "firming", "moisturizing"],
    effects: ["visibly reduced fine lines", "improved firmness and elasticity", "refined skin texture", "improved moisturization"],
    skinTypes: ["normal", "dry", "combination", "oily"],
    usageSteps: ["Apply morning and night after toner, gently pressing into skin until absorbed."],
    metricClaims: [
      {
        label: "improvement in fine lines, wrinkles, elasticity and firmness",
        subject: "fine lines, wrinkles, elasticity, firmness",
        value: "100",
        unit: "%",
        metric: "improvement rate",
        direction: "improve",
        timing: "after 6 weeks of use",
        sample: "32 women",
        method: "instrumental result, with daily use",
        sentence: CGR_OCR_CLINICAL_TEXT,
        sourceText: CGR_OCR_CLINICAL_TEXT
      }
    ],
    evidenceSentences: [CGR_OCR_CLINICAL_TEXT],
    ingredientBenefitLinks: [
      {
        ingredient: "Ginseng Capsules with Retinol",
        effect: "visibly reduced fine lines",
        sentence: "Retinol-infused capsules melt into skin on contact to visibly reduce fine lines and improve firmness.",
        sourceText: CGR_OCR_INGREDIENT_TEXT
      },
      {
        ingredient: "Ginseng Peptide",
        benefit: "firming",
        effect: "improved firmness and elasticity",
        sentence: "Ginseng Peptide helps support skin firmness and elasticity.",
        sourceText: CGR_OCR_INGREDIENT_TEXT
      },
      {
        ingredient: "Niacinamide",
        benefit: "radiance",
        sentence: "Niacinamide helps improve skin radiance.",
        sourceText: CGR_OCR_INGREDIENT_TEXT
      }
    ]
  },
  reviewSignals: [],
  sku: "270320853",
  gtin: "8809925175266",
  availability: "InStock",
  tags: ["anti-aging", "best seller", "serum", "fine lines & wrinkles"]
});

// ---------------------------------------------------------------------------
// 2) ExampleLuxe — Essential Activating Serum (en-US)
// ---------------------------------------------------------------------------

const ACTIVATING_SERUM_URL =
  "https://example.com/products/essential-activating-serum?variant=example-variant-2";

const ACTIVATING_SERUM_CLINICAL_IMAGE =
  "https://cdn.example.com/products/02.activating-serumRe-PushThumbnailRefresh_CLINICAL__Brand.com_1080px1_1ratio.jpg";
const ACTIVATING_SERUM_INSTRUMENTAL_IMAGE =
  "https://cdn.example.com/products/ACTIVATING_SERUM_Brand.com_1080_10801.jpg";
const ACTIVATING_SERUM_SALESDATA_IMAGE =
  "https://cdn.example.com/products/05.activating-serumRe-PushThumbnailRefresh_SALESDATA__Brand.com_1080px1_1ratio.jpg";

const ACTIVATING_SERUM_OCR_CLINICAL_TEXT =
  "AFTER 4 WEEKS OF USE, 92% AGREE SKIN LOOKS CLEAR AND BRIGHT. 86% AGREE FINE LINES LOOK REDUCED. " +
  "*Home usage test survey, 600 women, with daily use.";

const ACTIVATING_SERUM_OCR_INSTRUMENTAL_TEXT =
  "AFTER ONE BOTTLE OF DAILY USE, 100% users had visible improvement in FINE LINES, SKIN ELASTICITY, DULLNESS. " +
  "*Instrumental result, 30 subjects, after 8 weeks of daily use.";

const ACTIVATING_SERUM_OCR_SALESDATA_TEXT =
  "ExampleLuxe Essential Activating Serum, Korea's number one anti-aging serum (sales data).";

export const exampleluxeActivatingSerumGeoProduct = buildExtractorGeoProduct({
  slug: "exampleluxe-activating-serum",
  name: "Essential Activating Serum",
  brand: "ExampleLuxe",
  description:
    "A powerhouse serum that addresses the look of existing fine lines while strengthening skin to help prevent future visible signs of aging.",
  price: { raw: "$89.00", amount: 89, currency: "USD" },
  images: [
    "https://cdn.example.com/products/2023activating-serum6thGeneration-60ml-1_270320590_Brand.com_1080px1_1ratio.jpg",
    ACTIVATING_SERUM_CLINICAL_IMAGE,
    ACTIVATING_SERUM_INSTRUMENTAL_IMAGE,
    ACTIVATING_SERUM_SALESDATA_IMAGE,
    "https://cdn.example.com/products/03.activating-serum90ml_Brand.com_1080px1_1ratio.jpg"
  ],
  options: ["60 mL", "90 mL"],
  benefits: ["firming", "hydrating", "radiance"],
  effects: [
    "visible reduction of fine lines after 4 weeks",
    "hydrated, more even-toned skin after 4 weeks",
    "strengthened skin to help prevent future visible signs of aging"
  ],
  ingredients: ["500-Hour Aged Ginseng Extract", "Korean Herb Extract", "Vitamin C Derivative"],
  usage: ["Apply as the first step of your skincare ritual immediately after cleansing."],
  metrics: [
    "92% agree skin looks clear and bright after 4 weeks of use (home usage test survey, 600 women, with daily use).",
    "86% agree fine lines look reduced after 4 weeks of use (home usage test survey, 600 women, with daily use).",
    "100% users had visible improvement in fine lines, skin elasticity and dullness after one bottle of daily use (instrumental result, 30 subjects, after 8 weeks)."
  ],
  faq: [],
  reviews: { items: [], keywords: [] },
  htmlSections: [
    {
      title: "Key ingredients",
      category: "ingredient",
      text: "KEY INGREDIENTS: 500-Hour Aged Ginseng Extract, Korean Herb Extract, Vitamin C Derivative.",
      bullets: ["500-Hour Aged Ginseng Extract", "Korean Herb Extract", "Vitamin C Derivative"]
    },
    {
      title: "Solution for",
      category: "benefit",
      text: "SOLUTION FOR: Fine Lines and Wrinkles, Dullness, Dryness, Redness, Uneven Texture, Oiliness and Loss of Firmness and Elasticity.",
      bullets: [
        "fine lines and wrinkles",
        "dullness",
        "dryness",
        "redness",
        "uneven texture",
        "oiliness",
        "loss of firmness and elasticity"
      ]
    },
    {
      title: "Works best for",
      category: "usage",
      text: "WORKS BEST FOR: Normal, dry, combination, and oily skin types.",
      bullets: ["normal", "dry", "combination", "oily"]
    }
  ],
  ocrImageTexts: [
    { imageUrl: ACTIVATING_SERUM_CLINICAL_IMAGE, text: ACTIVATING_SERUM_OCR_CLINICAL_TEXT },
    { imageUrl: ACTIVATING_SERUM_INSTRUMENTAL_IMAGE, text: ACTIVATING_SERUM_OCR_INSTRUMENTAL_TEXT },
    { imageUrl: ACTIVATING_SERUM_SALESDATA_IMAGE, text: ACTIVATING_SERUM_OCR_SALESDATA_TEXT }
  ],
  sentenceInsights: [
    {
      imageUrl: ACTIVATING_SERUM_CLINICAL_IMAGE,
      text: "After 4 weeks of use, 92% agree skin looks clear and bright (home usage test survey, 600 women).",
      category: "metric",
      keywords: ["92%", "4 weeks", "clear and bright", "home usage test"]
    },
    {
      imageUrl: ACTIVATING_SERUM_INSTRUMENTAL_IMAGE,
      text: "After one bottle of daily use, 100% users had visible improvement in fine lines, skin elasticity, dullness (instrumental result, 30 subjects, 8 weeks).",
      category: "metric",
      keywords: ["100%", "8 weeks", "fine lines", "elasticity", "dullness"]
    },
    {
      imageUrl: ACTIVATING_SERUM_SALESDATA_IMAGE,
      text: "Korea's number one anti-aging serum (sales data).",
      category: "trend",
      keywords: ["Korea's number one", "anti-aging serum", "sales data"]
    }
  ],
  keywords: {
    product: ["Essential Activating Serum", "ExampleLuxe", "first serum"],
    price: ["$89.00", "$110.00"],
    benefit: ["firming", "hydrating", "radiance"],
    effect: ["visible reduction of fine lines", "hydrated, more even-toned skin"],
    ingredient: ["500-Hour Aged Ginseng Extract", "Korean Herb Extract", "Vitamin C Derivative"],
    usage: ["first step of skincare ritual", "immediately after cleansing"],
    metric: ["92% agree", "86% agree", "100% visible improvement", "home usage test survey 600 women"],
    trend: ["Korea's number one anti-aging serum (sales data)", "best seller"]
  },
  summary:
    "ExampleLuxe first-step serum evidence: 4-week home usage survey scores, 8-week instrumental results, and a trust-sensitive sales-data claim were categorized into product fields.",
  semanticFacts: {
    ingredients: ["500-Hour Aged Ginseng Extract", "Korean Herb Extract", "Vitamin C Derivative"],
    benefits: ["firming", "hydrating", "radiance"],
    effects: [
      "visible reduction of fine lines after 4 weeks",
      "hydrated, more even-toned skin after 4 weeks",
      "strengthened skin to help prevent future visible signs of aging"
    ],
    skinTypes: ["normal", "dry", "combination", "oily"],
    usageSteps: ["Apply as the first step of your skincare ritual immediately after cleansing."],
    metricClaims: [
      {
        label: "skin looks clear and bright",
        value: "92",
        unit: "%",
        metric: "agreement rate",
        direction: "improve",
        timing: "after 4 weeks of use",
        sample: "600 women",
        method: "home usage test survey, with daily use",
        sentence: ACTIVATING_SERUM_OCR_CLINICAL_TEXT,
        sourceText: ACTIVATING_SERUM_OCR_CLINICAL_TEXT
      },
      {
        label: "fine lines look reduced",
        value: "86",
        unit: "%",
        metric: "agreement rate",
        direction: "improve",
        timing: "after 4 weeks of use",
        sample: "600 women",
        method: "home usage test survey, with daily use",
        sentence: ACTIVATING_SERUM_OCR_CLINICAL_TEXT,
        sourceText: ACTIVATING_SERUM_OCR_CLINICAL_TEXT
      },
      {
        label: "visible improvement in fine lines, skin elasticity, dullness",
        value: "100",
        unit: "%",
        metric: "improvement rate",
        direction: "improve",
        timing: "after one bottle / 8 weeks of daily use",
        sample: "30 subjects",
        method: "instrumental result",
        sentence: ACTIVATING_SERUM_OCR_INSTRUMENTAL_TEXT,
        sourceText: ACTIVATING_SERUM_OCR_INSTRUMENTAL_TEXT
      },
      {
        label: "Korea's number one anti-aging serum",
        metric: "sales rank",
        method: "sales data",
        caveat:
          "Trust-sensitive marketing claim. Do not reuse in generated public copy without verifiable evidence.",
        sentence: ACTIVATING_SERUM_OCR_SALESDATA_TEXT,
        sourceText: ACTIVATING_SERUM_OCR_SALESDATA_TEXT
      }
    ],
    evidenceSentences: [ACTIVATING_SERUM_OCR_CLINICAL_TEXT, ACTIVATING_SERUM_OCR_INSTRUMENTAL_TEXT],
    ingredientBenefitLinks: [
      {
        ingredient: "500-Hour Aged Ginseng Extract",
        benefit: "firming",
        effect: "strengthened skin to help prevent future visible signs of aging",
        sentence: "A powerhouse serum that strengthens skin to help prevent future visible signs of aging."
      },
      {
        ingredient: "Vitamin C Derivative",
        benefit: "radiance",
        effect: "hydrated, more even-toned skin after 4 weeks",
        sentence: "92% agree skin looks clear and bright after 4 weeks of use.",
        sourceText: ACTIVATING_SERUM_OCR_CLINICAL_TEXT
      }
    ]
  },
  reviewSignals: [],
  sku: "270321066",
  gtin: "8809803584777",
  availability: "InStock",
  variants: [
    JSON.stringify({
      sku: "270321066",
      gtin: "8809803584777",
      title: "60 mL",
      options: ["Size: 60 mL"],
      price: "89.00",
      availability: "InStock"
    }),
    JSON.stringify({
      sku: "270321067",
      gtin: "8809803584852",
      title: "90 mL",
      options: ["Size: 90 mL"],
      price: "110.00",
      availability: "InStock"
    })
  ],
  tags: ["firming", "hydrating", "radiance", "best seller", "essential care", "serum"]
});

// ---------------------------------------------------------------------------
// 3) EXAMPLEDERMA — 배리어케어365 캡슐 토너 (ko-KR)
// ---------------------------------------------------------------------------

const TONER_URL = "https://example.com/web/product/view.do?prdSeq=1149";
const TONER_DETAIL_IMAGE = "https://example.com/upload/editor/cf0c5cf0-c72d-4898-b094-c45a9f9dd612.png";

const TONER_OCR_INTRO =
  "배리어케어365 캡슐토너. 세안 후 약해진 피부장벽을 강화하고 피부결을 정돈해 촉촉하고 건강한 피부 바탕을 만들어주는 장벽보습 캡슐 토너. " +
  "EXAMPLEDERMA BARRIERCARE365 CAPSULE TONER. Ceramide Matrix + PHA WATER. Barrier-strengthening hydration for smoother skin. For dry & sensitive skin. 10.14 fl. oz. / 300 mL.";

const TONER_OCR_INGREDIENT =
  "PHA: 민감피부에도 자극 없는 PHA 워터가 각질은 잠재우고 피부결은 정돈하는 효과. " +
  "고밀도 세라마이드 캡슐: 길이가 긴 롱체인 세라마이드와 연결고리를 조여주는 링커 세라마이드로 민감피부의 짧고 부족한 세라마이드를 보완해 보다 촘촘하고 견고한 구조의 캡슐로 장벽 보습.";

const TONER_OCR_FORMULA =
  "PHA 워터에 띄워진 고밀도 세라마이드 캡슐. 물에 녹지 않는 세라마이드를 캡슐 형태로 워터에 띄워놓은 하이드로겔 플로팅 포뮬러 기술. " +
  "특허 출원 포뮬러 (특허 출원 번호: KR10-2023-0133775). 하이드로겔 서스펜션 고밀도 세라마이드 캡슐 토너. " +
  "사용할 때마다 필요한 만큼만 적절하게 토출되어 피부에 효과적으로 세라마이드 장벽 보습을 제공. " +
  "즉각적인 수분 공급 & 결케어 이후 첫 단계 장벽 코팅으로 수분x장벽 시너지 효과.";

const TONER_OCR_CAPSULE =
  "피부장벽의 빈틈을 촘촘하게, 특허 받은 고밀도 세라마이드 캡슐. 피부지질 구성성분(세라마이드/콜레스테롤/지방산) + 피부지질 유사구조(층판형 구조). " +
  "1회 도포 후 18시간 장벽에서 잔존하는 세라마이드 (원료적 특성에 한함, ex vivo 테스트 결과). " +
  "캡슐 제형일 때 190% 높은 잔존 효과 (캡슐 vs 비캡슐 세정 실험, 원료적 특성에 한함, in vitro 테스트 결과). " +
  "핵심 성분: PHA, 고밀도 세라마이드 캡슐. 추천 피부 타입: 건조 피부 또는 민감 피부. " +
  "효능: 세안 후 약해진 피부장벽과 건조함 즉시 케어, 캡슐로 더 오래 지속되는 토너의 보습력.";

const TONER_OCR_METRICS =
  "세안 후 첫 단계 민감 건조 피부 급속 수분 충전. 사용 직후 수분량 1.3배 증가 (피부 수분량 인덱스 54.6 → 72.8). " +
  "3일/7일 사용 후 얼굴 3대 부위(뺨, 이마, 턱) 기초 수분량 증가. 세정에 의한 장벽 손상 93% 즉시 회복. " +
  "외부자극(Tape Stripping)에 의한 장벽 손상 즉시 회복: 사용 직후 60.5% 회복, 사용 7일 후 87.3% 회복. " +
  "사용 직후 각질량 82% 즉시 감소, 12시간 후까지도 잠재우는 피부 각질. " +
  "사용할수록 매끈해지는 피부결 & 투명해지는 피부: 사용 7일 후 피부결 7.9%, 투명도 6.0% 개선.";

const TONER_OCR_USAGE =
  "사용법: 1. 아침, 저녁 세안 후, 적당량의 내용물을 덜어줍니다. 2. 캡슐을 부드럽게 녹이듯 골고루 펴 바른 후 가볍게 두드려 흡수시켜줍니다.";

const TONER_OCR_SAFETY =
  "철저히 검증한 피부 안전성 테스트: 극민감 테스트 완료, 민감 피부 자극 테스트 완료, 피부과 테스트 완료, 알러지 테스트 완료, " +
  "여드름성 피부 사용 적합 테스트 완료(논코메도제닉), 독일 더마 테스트 EXCELLENT 등급.";

const TONER_FULL_INGREDIENTS =
  "전성분: 정제수, 부틸렌글라이콜, 글리세린, 프로필렌글라이콜, 1,2-헥산다이올, 글루코노락톤, 에틸헥실글리세린, 칼슘클로라이드, 만니톨, 셀룰로오스, " +
  "셀룰로오스검, 트로메타민, 세틸-피지하이드록시에틸팔미타마이드, 스테아릭애씨드, 젤란검, 소듐시트레이트, 소듐글루코네이트, 벤조익애씨드, 세라마이드엔피, " +
  "하이드로제네이티드레시틴, 소듐벤조에이트, 실리카, 콜레스테롤, 스핑고리피드, 소듐하이알루로네이트, 하이드록시프로필메틸셀룰로오스, 토코페롤";

export const exampledermaCapsuleTonerGeoProduct = buildExtractorGeoProduct({
  slug: "examplederma-capsule-toner",
  name: "예시더마 배리어케어365 캡슐 토너",
  brand: "EXAMPLEDERMA",
  description:
    "세안 후 약해진 피부장벽을 강화하고 피부결을 정돈해 촉촉하고 건강한 피부 바탕을 만들어주는 장벽보습 캡슐 토너. 세안 후 즉각 수분공급 장벽보습 캡슐토너.",
  images: [
    "https://example.com/upload/product/1149_1098_DSPIMG_S.png",
    "https://example.com/upload/product/1149_1099_DSPIMG_S.png",
    "https://example.com/upload/product/1149_1100_DSPIMG_S.png",
    "https://example.com/upload/product/1149_1101_DSPIMG_S.png",
    TONER_DETAIL_IMAGE
  ],
  options: ["300ml"],
  benefits: ["장벽 보습", "피부결 정돈", "세안 후 즉각 수분 공급"],
  effects: ["세안 후 약해진 피부장벽 강화", "촉촉하고 건강한 피부 바탕", "각질 진정과 피부결 정돈"],
  ingredients: [
    "고밀도 세라마이드 캡슐",
    "PHA(글루코노락톤)",
    "세라마이드엔피",
    "스핑고리피드",
    "콜레스테롤",
    "소듐하이알루로네이트"
  ],
  usage: [
    "아침, 저녁 세안 후 적당량의 내용물을 덜어줍니다.",
    "캡슐을 부드럽게 녹이듯 골고루 펴 바른 후 가볍게 두드려 흡수시켜줍니다."
  ],
  metrics: [
    "사용 직후 수분량 1.3배 증가 (피부 수분량 인덱스 54.6 → 72.8).",
    "세정에 의한 장벽 손상 93% 즉시 회복.",
    "외부자극(Tape Stripping)에 의한 장벽 손상: 사용 직후 60.5% 회복, 사용 7일 후 87.3% 회복.",
    "사용 직후 각질량 82% 즉시 감소.",
    "사용 7일 후 피부결 7.9%, 투명도 6.0% 개선.",
    "1회 도포 후 18시간 장벽에서 잔존하는 세라마이드 (원료적 특성에 한함, ex vivo 테스트 결과).",
    "캡슐 제형일 때 190% 높은 잔존 효과 (캡슐 vs 비캡슐 세정 실험, 원료적 특성에 한함, in vitro 테스트 결과).",
    "여드름성 피부 사용 적합(논코메도제닉) 테스트 완료, 독일 더마 테스트 EXCELLENT 등급."
  ],
  faq: [
    {
      question: "캡슐이 워터 안에 떠있는 것이 왜 중요한가요?",
      answer:
        "피부장벽 개선/강화에 가장 효과적인 성분 중 하나인 세라마이드는 물에 녹지 않습니다. 이 때문에 토너 또는 수분 세럼같이 수분 함량이 높은 스킨케어 앞 단계 제품들에서는 세라마이드를 통한 장벽 개선 효과를 얻기 어렵습니다. 배리어케어365 캡슐 토너에는 고밀도 세라마이드 캡슐이 그대로 PHA 토닝 워터 안에 서스펜션 되어 있어 세안 후 첫 단계부터 강력한 세라마이드 장벽 보습 케어가 가능합니다. 또한, 균일하게 떠있는 캡슐이 사용할 때마다 피부에 필요한 만큼 적절하게 토출되어 언제나 유사한 효과를 나타냅니다."
    },
    {
      question: "배리어케어365 크림에 함유된 캡슐과 동일한 캡슐인가요? 캡슐이 있어서 좋은 이유는 무엇인가요?",
      answer:
        "캡슐 토너에 함유된 캡슐은 자사의 특허 성분인 '고밀도 세라마이드 캡슐'로 동일합니다. 캡슐은 실제 피부 장벽 지질과 유사성분/구조로 이루어져 있으며 캡슐 형태이기 때문에 손상된 피부장벽 틈에 오래 잔존하며 장벽을 튼튼하게 강화시켜줍니다."
    },
    {
      question: "여드름성 피부가 사용해도 괜찮은가요?",
      answer: "여드름성 피부 사용적합 테스트인 논코메도제닉 테스트를 완료한 제품입니다."
    },
    {
      question: "영유아나 임산부가 사용해도 되나요?",
      answer:
        "영유아, 어린이 및 임산부가 우려할 만한 성분이 함유되어 있지 않으므로 온 가족 사용이 가능합니다. 다만 우려가 되는 경우 연약한 피부 부위(귀 뒤, 팔 안쪽 등)에 먼저 테스트 후 사용하시고 필요 시, 전문가와 상담 후 사용하시기 바랍니다."
    }
  ],
  reviews: { items: [], keywords: [] },
  htmlSections: [
    {
      title: "제품 소개",
      category: "benefit",
      text: "세안 후 즉각 수분공급 장벽보습 캡슐토너. 세안 후 약해진 피부장벽을 강화하고 피부결을 정돈해 촉촉하고 건강한 피부 바탕을 만들어주는 장벽보습 캡슐 토너.",
      bullets: ["장벽 보습", "피부결 정돈", "즉각 수분 공급"]
    },
    {
      title: "전성분",
      category: "ingredient",
      text: TONER_FULL_INGREDIENTS,
      bullets: ["글루코노락톤", "세라마이드엔피", "스핑고리피드", "콜레스테롤", "소듐하이알루로네이트", "토코페롤"]
    }
  ],
  ocrImageTexts: [
    { imageUrl: TONER_DETAIL_IMAGE, text: TONER_OCR_INTRO },
    { imageUrl: TONER_DETAIL_IMAGE, text: TONER_OCR_INGREDIENT },
    { imageUrl: TONER_DETAIL_IMAGE, text: TONER_OCR_FORMULA },
    { imageUrl: TONER_DETAIL_IMAGE, text: TONER_OCR_CAPSULE },
    { imageUrl: TONER_DETAIL_IMAGE, text: TONER_OCR_METRICS },
    { imageUrl: TONER_DETAIL_IMAGE, text: TONER_OCR_USAGE },
    { imageUrl: TONER_DETAIL_IMAGE, text: TONER_OCR_SAFETY }
  ],
  sentenceInsights: [
    {
      imageUrl: TONER_DETAIL_IMAGE,
      text: "물에 녹지 않는 세라마이드를 캡슐 형태로 워터에 띄워놓은 하이드로겔 플로팅 포뮬러 기술 (특허 출원 번호: KR10-2023-0133775).",
      category: "ingredient",
      keywords: ["고밀도 세라마이드 캡슐", "하이드로겔 플로팅 포뮬러", "특허 출원"]
    },
    {
      imageUrl: TONER_DETAIL_IMAGE,
      text: "사용 직후 수분량 1.3배 증가 (피부 수분량 인덱스 54.6 → 72.8).",
      category: "metric",
      keywords: ["1.3배", "수분량", "사용 직후"]
    },
    {
      imageUrl: TONER_DETAIL_IMAGE,
      text: "세정에 의한 장벽 손상 93% 즉시 회복.",
      category: "metric",
      keywords: ["93%", "장벽 손상", "즉시 회복"]
    },
    {
      imageUrl: TONER_DETAIL_IMAGE,
      text: "PHA 워터가 민감피부에도 자극 없이 각질은 잠재우고 피부결은 정돈합니다.",
      category: "effect",
      keywords: ["PHA", "각질", "피부결 정돈", "민감피부"]
    },
    {
      imageUrl: TONER_DETAIL_IMAGE,
      text: "극민감·민감 피부 자극·피부과·알러지·논코메도제닉 테스트 완료, 독일 더마 테스트 EXCELLENT 등급.",
      category: "metric",
      keywords: ["안전성 테스트", "논코메도제닉", "더마 테스트 EXCELLENT"]
    }
  ],
  keywords: {
    product: ["예시더마 배리어케어365 캡슐 토너", "EXAMPLEDERMA", "캡슐 토너"],
    benefit: ["장벽 보습", "피부결 정돈", "즉각 수분 공급"],
    effect: ["피부장벽 강화", "각질 진정", "촉촉하고 건강한 피부 바탕"],
    ingredient: ["고밀도 세라마이드 캡슐", "PHA", "세라마이드엔피", "하이드로겔 플로팅 포뮬러"],
    usage: ["세안 후 첫 단계", "아침 저녁 사용"],
    faq: ["캡슐 서스펜션", "논코메도제닉", "온 가족 사용"],
    metric: ["수분량 1.3배", "장벽 손상 93% 회복", "각질량 82% 감소", "18시간 잔존", "190% 잔존 효과"],
    trend: ["더마 코스메틱", "민감피부 토너"]
  },
  summary:
    "EXAMPLEDERMA 캡슐 토너 근거: 특허 출원 하이드로겔 플로팅 포뮬러, 수분/장벽/각질 정량 개선 수치, 6종 피부 안전성 테스트가 제품 필드로 분류되었습니다.",
  semanticFacts: {
    ingredients: ["고밀도 세라마이드 캡슐", "PHA(글루코노락톤)", "세라마이드엔피", "스핑고리피드", "콜레스테롤", "소듐하이알루로네이트"],
    benefits: ["장벽 보습", "피부결 정돈", "세안 후 즉각 수분 공급"],
    effects: ["세안 후 약해진 피부장벽 강화", "촉촉하고 건강한 피부 바탕", "각질 진정과 피부결 정돈"],
    skinTypes: ["건조 피부", "민감 피부"],
    usageSteps: [
      "아침, 저녁 세안 후 적당량의 내용물을 덜어줍니다.",
      "캡슐을 부드럽게 녹이듯 골고루 펴 바른 후 가볍게 두드려 흡수시켜줍니다."
    ],
    metricClaims: [
      {
        label: "사용 직후 수분량 증가",
        subject: "피부 수분량",
        value: "1.3",
        unit: "배",
        metric: "피부 수분량 인덱스 (54.6 → 72.8)",
        direction: "증가",
        timing: "사용 직후",
        sentence: "사용 직후 수분량 1.3배 증가 (피부 수분량 인덱스 54.6 → 72.8).",
        sourceText: TONER_OCR_METRICS
      },
      {
        label: "세정에 의한 장벽 손상 즉시 회복",
        subject: "피부 장벽",
        value: "93",
        unit: "%",
        metric: "회복률",
        direction: "회복",
        timing: "사용 직후",
        method: "세정 실험",
        caveat: "TOP 17에 해당하는 이미지로 개인차 있을 수 있음.",
        sentence: "세정에 의한 장벽 손상 93% 즉시 회복.",
        sourceText: TONER_OCR_METRICS
      },
      {
        label: "외부자극에 의한 장벽 손상 회복",
        subject: "피부 장벽",
        value: "60.5",
        unit: "%",
        metric: "회복률",
        direction: "회복",
        timing: "사용 직후 (7일 후 87.3%)",
        method: "Tape Stripping 외부자극 실험",
        sentence: "외부자극에 의한 장벽 손상 즉시 회복: 사용 직후 60.5% 회복, 사용 7일 후 87.3% 회복.",
        sourceText: TONER_OCR_METRICS
      },
      {
        label: "사용 직후 각질량 감소",
        subject: "피부 각질",
        value: "82",
        unit: "%",
        metric: "감소율",
        direction: "감소",
        timing: "사용 직후 (12시간 지속)",
        sentence: "사용 직후 각질량 82% 즉시 감소, 12시간 후까지도 잠재우는 피부 각질.",
        sourceText: TONER_OCR_METRICS
      },
      {
        label: "피부결/투명도 개선",
        subject: "피부결, 투명도",
        value: "7.9",
        unit: "%",
        metric: "개선율 (투명도 6.0%)",
        direction: "개선",
        timing: "사용 7일 후",
        sentence: "사용 7일 후 피부결 7.9%, 투명도 6.0% 개선.",
        sourceText: TONER_OCR_METRICS
      },
      {
        label: "세라마이드 장벽 잔존 시간",
        subject: "세라마이드",
        value: "18",
        unit: "시간",
        metric: "잔존 시간",
        timing: "1회 도포 후",
        method: "ex vivo 테스트",
        caveat: "원료적 특성에 한함.",
        sentence: "1회 도포 후 18시간 장벽에서 잔존하는 세라마이드.",
        sourceText: TONER_OCR_CAPSULE
      },
      {
        label: "캡슐 제형 잔존 효과",
        subject: "세라마이드 캡슐",
        value: "190",
        unit: "%",
        metric: "잔존 효과 (캡슐 vs 비캡슐)",
        method: "in vitro 세정 실험",
        caveat: "원료적 특성에 한함.",
        sentence: "캡슐 제형일 때 190% 높은 잔존 효과.",
        sourceText: TONER_OCR_CAPSULE
      }
    ],
    evidenceSentences: [TONER_OCR_METRICS, TONER_OCR_CAPSULE, TONER_OCR_SAFETY],
    ingredientBenefitLinks: [
      {
        ingredient: "고밀도 세라마이드 캡슐",
        benefit: "장벽 보습",
        effect: "세안 후 약해진 피부장벽 강화",
        sentence: "고밀도 세라마이드 캡슐이 손상된 피부장벽 틈에 오래 잔존하며 장벽을 튼튼하게 강화시켜줍니다.",
        sourceText: TONER_OCR_INGREDIENT
      },
      {
        ingredient: "PHA(글루코노락톤)",
        benefit: "피부결 정돈",
        effect: "각질 진정과 피부결 정돈",
        sentence: "민감피부에도 자극 없는 PHA 워터가 각질은 잠재우고 피부결은 정돈하는 효과.",
        sourceText: TONER_OCR_INGREDIENT
      }
    ]
  },
  reviewSignals: [],
  availability: "InStock",
  tags: ["BARRIERCARE365", "더마 코스메틱", "민감피부"]
});

// ---------------------------------------------------------------------------
// 4) EXAMPLEDERMA — 배리어케어365 크림 미스트 (ko-KR)
// ---------------------------------------------------------------------------

const MIST_URL = "https://example.com/web/product/view.do?prdSeq=1027";
const MIST_DETAIL_IMAGE = "https://example.com/upload/editor/7208197c-dd56-48ca-951d-3f2274c21169.png";

const MIST_OCR_INTRO =
  "배리어케어365 크림미스트. 잠시뿐인 촉촉함은 No! 날아감 없는 든든한 보습 미스트. " +
  "EXAMPLEDERMA BARRIERCARE365 CREAM MIST. Ceramide 10,000 ppm. Moisturizing & strengthening skin's moisture barrier. For dry & weakened skin. 4.05 fl.oz. / 120 mL.";

const MIST_OCR_INGREDIENT =
  "세라마이드: 피부 장벽을 강화하고 피부 내 수분을 유지하는 데 도움을 주는 피부 장벽 성분.";

const MIST_OCR_FORMULA =
  "흔들 필요 없는 특수 에멀징 공법. 작게 쪼개진 세라마이드와 수분이 묶여있어 흔들 필요 없이 사용하는 터치리스 착붙보습. " +
  "10,000ppm 세라마이드로 가득 채운 미세촘촘 안개미스트. 부드럽게 뿌려져 피부 표면에 보습막을 형성. " +
  "효능: 수분 충전과 동시에 보습막을 형성. 주요 성분: 세라마이드 10,000ppm. 추천 피부 타입: 건조 피부 및 모든 피부.";

const MIST_OCR_USAGE =
  "사용법: 1. 연약하고 건조해진 피부 부위에 미세 분사를 합니다. 2. 피부에 건조함이 느껴질 때 수시로 뿌려줍니다.";

const MIST_OCR_SAFETY =
  "철저히 검증한 피부 안전성 테스트. 피부과 테스트: 대학병원 피부과에서 48시간 패치를 활용한 자극여부 확인 (22.12.19-22.12.22, 32명 대상). " +
  "하이포알러제닉 테스트 완료: 여러번 피부에 첩포하여 일어나는 화장품, 성분에 대한 과민 반응(감작성)을 확인 (2018.04.13-2018.06.01, 53명 대상, ㈜더마프로).";

const MIST_FULL_INGREDIENTS =
  "전성분: 정제수, 글리세린, 부틸렌글라이콜, 카프릴릭/카프릭트리글리세라이드, 하이드로제네이티드폴리(C6-14올레핀), 디메치콘, 세틸에칠헥사노에이트, " +
  "하이드록시프로필비스라우라마이드엠이에이, 1,2-헥산디올, 소듐서팩틴, 콜레스테롤, 글리세릴카프릴레이트, 디소듐이디티에이, 에칠헥실글리세린, " +
  "베헤닉애씨드, 토코페롤";

export const exampledermaCreamMistGeoProduct = buildExtractorGeoProduct({
  slug: "examplederma-cream-mist",
  name: "배리어케어365 크림 미스트",
  brand: "EXAMPLEDERMA",
  description: "10,000ppm 함유된 고함량 세라마이드 미세분사로 피부장벽을 보호하는 세라마이드 보습 크림 미스트.",
  images: [
    "https://example.com/upload/product/1027_217_DSPIMG_S.png",
    "https://example.com/upload/product/1027_885_DSPIMG_S.png",
    "https://example.com/upload/product/1027_886_DSPIMG_S.png",
    MIST_DETAIL_IMAGE
  ],
  options: ["120ml"],
  benefits: ["고보습", "피부장벽 보호", "속건조 완화"],
  effects: ["미세분사로 즉각적인 보습", "오래 유지되는 촉촉함", "피부 표면 보습막 형성"],
  ingredients: [
    "세라마이드(10,000ppm 고함량)",
    "콜레스테롤",
    "하이드록시프로필비스라우라마이드엠이에이",
    "토코페롤"
  ],
  usage: [
    "1. 연약하고 건조해진 피부 부위에 미세 분사를 합니다.",
    "2. 피부에 건조함이 느껴질 때 수시로 뿌려줍니다.",
    "세안 직후 속당김이 심한 경우 크림 미스트를 먼저 뿌린 후 하이드로 에센스, 크림 또는 로션 순서로 사용합니다."
  ],
  metrics: [
    "세라마이드 10,000ppm 고함량 함유.",
    "피부과 테스트 완료: 대학병원 피부과 48시간 패치 자극 여부 확인 (22.12.19-22.12.22, 32명 대상).",
    "하이포알러제닉 테스트 완료 (2018.04.13-2018.06.01, 53명 대상, ㈜더마프로)."
  ],
  faq: [
    {
      question: "배리어케어 제품 중 동물유래성분이 들어있는 제품이 있나요?",
      answer:
        "외부 기관을 통한 비건 인증을 받은 것은 아니지만, 동물성 원료는 들어있지 않으며, 동물실험도 하지 않았습니다. 예시회사은 전제품 동물실험을 하지 않고 있습니다."
    },
    {
      question: "건성 피부라 피부가 따가운 상태인데 사용해도 될까요?",
      answer:
        "배리어케어 라인은 민감하고 건조한 피부에 특화된 보습 솔루션을 제공하고 있습니다. 다만 피부가 따가운 상태를 정확히 알기 어려워 국소부위에 제품을 사용해보시고 사용해주시기를 권장 드립니다."
    },
    {
      question: "피부 장벽의 기능이 무엇인가요?",
      answer:
        "피부장벽은 외부의 유해요소를 막고 내부의 수분 손실을 방지하는 '벽' 역할을 합니다. 장벽 지질은 세라마이드, 콜레스테롤, 지방산으로 이루어져 있으며, 배리어케어 라인은 피부 지질과 유사한 구조로 만든 특허 받은 캡슐을 통해 피부장벽을 견고하게 강화시켜 줍니다."
    },
    {
      question: "크림 미스트를 평상시 루틴으로 사용하는 경우 사용 순서는 어떻게 되나요?",
      answer:
        "세안 직후 속당김이 심한 경우 크림 미스트를 욕실에 두고 세안 직후 뿌려준 후 하이드로 에센스, 크림 또는 로션 순서로 사용합니다. 피부가 많이 건조한 편이라면 세안 후 하이드로 에센스, 크림 또는 로션 뒤에 크림 미스트로 마무리하고 건조할 때마다 수시로 사용합니다."
    }
  ],
  reviews: {
    rating: 4.9,
    reviewCount: 1482,
    items: [
      {
        body:
          "예시더마 배리어케어365 크림미스트는 분사력이 고르고 미세해서 얼굴에 고르게 뿌려졌어요. 크림이 들어간 미스트라 그런지 일반 미스트보다 보습감이 오래 유지되는 편이었고, 건조할 때 수시로 사용하기 좋았습니다.",
        rating: 5,
        datePublished: "2026-07-23"
      },
      {
        body:
          "재구매. 건성기준 여름에 단독사용하기에도 좋네요. 가까이서 집중 분사 후에 톡톡톡 손으로 흡수시켜 주면 금방 촉촉해지고 좋습니다. 매끈매끈한 결이 형성되서 좋고 무엇보다 무향에 순하고 무겁지 않아요.",
        rating: 5,
        datePublished: "2026-07-24"
      },
      {
        body: "순해서 좋아요. 딱히 자극도 없고, 트러블도 나지 않아 매일매일 사용하고 있어요. 세안 후 바로 뿌리면 건조하지 않아요.",
        rating: 5,
        datePublished: "2026-07-26"
      },
      {
        body: "미스트 분사력이 조금 아쉬워요. 조금 뭉쳐서 나오는 듯한 느낌이라 이것 때문에 재구매는 망설여져요.",
        rating: 4,
        datePublished: "2026-07-16"
      }
    ],
    keywords: ["촉촉함", "순함", "무향", "미세 분사", "속건조 완화", "세안 후 바로 사용", "재구매"]
  },
  htmlSections: [
    {
      title: "제품 소개",
      category: "benefit",
      text: "세라마이드 보습 크림 미스트. 10,000ppm 함유된 고함량 세라마이드 미세분사로 피부장벽을 보호하는 크림 미스트. #고보습 #만세미스트 #피부장벽미스트 #여행필수품 #크림미스트",
      bullets: ["고보습", "피부장벽 보호", "크림 미스트"]
    },
    {
      title: "전성분",
      category: "ingredient",
      text: MIST_FULL_INGREDIENTS,
      bullets: ["글리세린", "콜레스테롤", "하이드록시프로필비스라우라마이드엠이에이", "토코페롤"]
    }
  ],
  ocrImageTexts: [
    { imageUrl: MIST_DETAIL_IMAGE, text: MIST_OCR_INTRO },
    { imageUrl: MIST_DETAIL_IMAGE, text: MIST_OCR_INGREDIENT },
    { imageUrl: MIST_DETAIL_IMAGE, text: MIST_OCR_FORMULA },
    { imageUrl: MIST_DETAIL_IMAGE, text: MIST_OCR_USAGE },
    { imageUrl: MIST_DETAIL_IMAGE, text: MIST_OCR_SAFETY }
  ],
  sentenceInsights: [
    {
      imageUrl: MIST_DETAIL_IMAGE,
      text: "10,000ppm 세라마이드로 가득 채운 미세촘촘 안개미스트.",
      category: "ingredient",
      keywords: ["세라마이드", "10,000ppm", "안개미스트"]
    },
    {
      imageUrl: MIST_DETAIL_IMAGE,
      text: "작게 쪼개진 세라마이드와 수분이 묶여있어 흔들 필요 없이 사용하는 터치리스 착붙보습.",
      category: "effect",
      keywords: ["특수 에멀징 공법", "터치리스", "보습막"]
    },
    {
      imageUrl: MIST_DETAIL_IMAGE,
      text: "대학병원 피부과에서 48시간 패치를 활용한 자극여부 확인 (32명 대상).",
      category: "metric",
      keywords: ["피부과 테스트", "48시간 패치", "32명"]
    }
  ],
  keywords: {
    product: ["배리어케어365 크림 미스트", "EXAMPLEDERMA", "크림 미스트"],
    benefit: ["고보습", "피부장벽 보호", "속건조 완화"],
    effect: ["미세분사 즉각 보습", "오래 유지되는 촉촉함", "보습막 형성"],
    ingredient: ["세라마이드 10,000ppm", "콜레스테롤", "토코페롤"],
    usage: ["세안 직후 사용", "건조할 때 수시로"],
    faq: ["동물성 원료 무첨가", "사용 순서"],
    review: ["촉촉함", "순함", "무향", "미세 분사"],
    metric: ["세라마이드 10,000ppm", "48시간 패치 테스트", "하이포알러제닉 테스트"],
    trend: ["#만세미스트", "#여행필수품", "#피부장벽미스트"]
  },
  summary:
    "EXAMPLEDERMA 크림 미스트 근거: 세라마이드 10,000ppm 정량 함량, 특수 에멀징 공법, 피부과/하이포알러제닉 테스트, 실사용 리뷰 신호가 제품 필드로 분류되었습니다.",
  semanticFacts: {
    ingredients: ["세라마이드(10,000ppm 고함량)", "콜레스테롤", "하이드록시프로필비스라우라마이드엠이에이", "토코페롤"],
    benefits: ["고보습", "피부장벽 보호", "속건조 완화"],
    effects: ["미세분사로 즉각적인 보습", "오래 유지되는 촉촉함", "피부 표면 보습막 형성"],
    skinTypes: ["건조 피부", "모든 피부"],
    usageSteps: [
      "1. 연약하고 건조해진 피부 부위에 미세 분사를 합니다.",
      "2. 피부에 건조함이 느껴질 때 수시로 뿌려줍니다."
    ],
    metricClaims: [
      {
        label: "세라마이드 함량",
        subject: "세라마이드",
        value: "10000",
        unit: "ppm",
        metric: "함량",
        sentence: "10,000ppm 함유된 고함량 세라마이드 미세분사로 피부장벽을 보호.",
        sourceText: MIST_OCR_FORMULA
      },
      {
        label: "피부과 테스트 패치 적용 시간",
        subject: "피부 자극",
        value: "48",
        unit: "시간",
        metric: "패치 테스트 자극여부 확인",
        sample: "32명",
        period: "22.12.19-22.12.22",
        method: "대학병원 피부과 패치 테스트",
        sentence: "대학병원 피부과에서 48시간 패치를 활용한 자극여부 확인.",
        sourceText: MIST_OCR_SAFETY
      },
      {
        label: "하이포알러제닉 테스트",
        subject: "감작성",
        sample: "53명",
        period: "2018.04.13-2018.06.01",
        method: "㈜더마프로 반복 첩포 테스트",
        sentence: "여러번 피부에 첩포하여 일어나는 화장품, 성분에 대한 과민 반응(감작성)을 확인.",
        sourceText: MIST_OCR_SAFETY
      }
    ],
    evidenceSentences: [MIST_OCR_FORMULA, MIST_OCR_SAFETY],
    ingredientBenefitLinks: [
      {
        ingredient: "세라마이드(10,000ppm 고함량)",
        benefit: "피부장벽 보호",
        effect: "피부 표면 보습막 형성",
        sentence: "세라마이드는 피부 장벽을 강화하고 피부 내 수분을 유지하는 데 도움을 주는 피부 장벽 성분.",
        sourceText: MIST_OCR_INGREDIENT
      }
    ]
  },
  reviewSignals: ["촉촉함", "순함", "무향", "미세 분사", "속건조 완화", "재구매"],
  ratingSummary: "평점 4.9 · 리뷰 1482건",
  availability: "InStock",
  tags: ["#고보습", "#만세미스트", "#피부장벽미스트", "#여행필수품", "#크림미스트"]
});

// ---------------------------------------------------------------------------
// Exports: extractor run 결과 / generator 입력 / agent-api 제출 페이로드
// ---------------------------------------------------------------------------

export const extractorLiveProductKeys = [
  "exampleluxe-renewal-serum",
  "exampleluxe-activating-serum",
  "examplederma-capsule-toner",
  "examplederma-cream-mist"
] as const;

export type ExtractorLiveProductKey = (typeof extractorLiveProductKeys)[number];

interface ExtractorLiveProductMeta {
  url: string;
  locale: PdpGeoLocale;
  market: "US" | "KR";
  brand: string;
  category: string;
  geoGenerationId: string;
  geoProduct: ExtractorGeoProductRawData;
}

const liveProducts: Record<ExtractorLiveProductKey, ExtractorLiveProductMeta> = {
  "exampleluxe-renewal-serum": {
    url: CGR_URL,
    locale: "en-US",
    market: "US",
    brand: "ExampleLuxe",
    category: "Serum",
    geoGenerationId: "3f2c1a9e-6b7d-4e18-9a4f-0c5d2e8b7a01",
    geoProduct: exampleluxeRenewalSerumGeoProduct
  },
  "exampleluxe-activating-serum": {
    url: ACTIVATING_SERUM_URL,
    locale: "en-US",
    market: "US",
    brand: "ExampleLuxe",
    category: "Serum",
    geoGenerationId: "8d4e2b1c-9f3a-4c57-b6e8-1a7f0d9c2e02",
    geoProduct: exampleluxeActivatingSerumGeoProduct
  },
  "examplederma-capsule-toner": {
    url: TONER_URL,
    locale: "ko-KR",
    market: "KR",
    brand: "EXAMPLEDERMA",
    category: "토너",
    geoGenerationId: "b7a90c3d-2e5f-4d16-8c4b-6f1e9a0d3c03",
    geoProduct: exampledermaCapsuleTonerGeoProduct
  },
  "examplederma-cream-mist": {
    url: MIST_URL,
    locale: "ko-KR",
    market: "KR",
    brand: "EXAMPLEDERMA",
    category: "미스트",
    geoGenerationId: "c1d8f4e2-7a6b-4f39-9d2c-8e0b5a1f4d04",
    geoProduct: exampledermaCreamMistGeoProduct
  }
};

function toExtractorRunResult(key: ExtractorLiveProductKey): ExtractorRunResultMock {
  const meta = liveProducts[key];
  return {
    source: meta.url,
    sourceType: "url",
    geoProduct: meta.geoProduct,
    generatedAt: EXTRACTED_AT,
    ragProfile: EXTRACTOR_RAG_PROFILE
  };
}

function toPdpGeoGenerationInput(key: ExtractorLiveProductKey): PdpGeoGenerationInput {
  const meta = liveProducts[key];
  return {
    product: { geoProduct: meta.geoProduct },
    source: { type: "pdp-extractor", url: meta.url },
    hints: {
      locale: meta.locale,
      market: meta.market,
      brand: meta.brand,
      category: meta.category
    }
  };
}

function toAgentApiSubmitPayload(key: ExtractorLiveProductKey): AgentApiSubmitGenerationPayload {
  const meta = liveProducts[key];
  return {
    geoGenerationId: meta.geoGenerationId,
    locale: meta.locale,
    product: {
      canonicalUrl: meta.url,
      offerUrl: meta.url,
      geoProduct: meta.geoProduct
    }
  };
}

/** pdp-extractor-agent `ProductExtractionResult` 형태의 목업 (extractorRun.result 대응). */
export const extractorRunResults: Record<ExtractorLiveProductKey, ExtractorRunResultMock> = {
  "exampleluxe-renewal-serum": toExtractorRunResult("exampleluxe-renewal-serum"),
  "exampleluxe-activating-serum": toExtractorRunResult("exampleluxe-activating-serum"),
  "examplederma-capsule-toner": toExtractorRunResult("examplederma-capsule-toner"),
  "examplederma-cream-mist": toExtractorRunResult("examplederma-cream-mist")
};

/**
 * apps/geo-generator 오케스트레이션 경로와 동일한 generator 직접 호출 입력.
 * (`generatePdpGeo({ product: extractorRun.result.geoProduct, source: { type: "pdp-extractor", url } })`)
 */
export const pdpGeoGenerationInputs: Record<ExtractorLiveProductKey, PdpGeoGenerationInput> = {
  "exampleluxe-renewal-serum": toPdpGeoGenerationInput("exampleluxe-renewal-serum"),
  "exampleluxe-activating-serum": toPdpGeoGenerationInput("exampleluxe-activating-serum"),
  "examplederma-capsule-toner": toPdpGeoGenerationInput("examplederma-capsule-toner"),
  "examplederma-cream-mist": toPdpGeoGenerationInput("examplederma-cream-mist")
};

/**
 * apps/agent-api `POST /internal/v1/geo/generations` SubmitGenerationDto 계약 목업.
 * `product.canonicalUrl`/`offerUrl`은 agent-api `extractSourceUrl()`이 source.url로 사용해
 * JSON-LD `@id`가 urn 대신 실제 URL 앵커가 되도록 한다(commerce contract).
 */
export const agentApiSubmitPayloads: Record<ExtractorLiveProductKey, AgentApiSubmitGenerationPayload> = {
  "exampleluxe-renewal-serum": toAgentApiSubmitPayload("exampleluxe-renewal-serum"),
  "exampleluxe-activating-serum": toAgentApiSubmitPayload("exampleluxe-activating-serum"),
  "examplederma-capsule-toner": toAgentApiSubmitPayload("examplederma-capsule-toner"),
  "examplederma-cream-mist": toAgentApiSubmitPayload("examplederma-cream-mist")
};
