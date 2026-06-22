import { productExtractorRagManifest } from "./rag/manifest";
import type { ProductExtractionResult, ProductExtractionRun, ProductExtractionStep } from "./types";

/** Runs deterministic mock extraction for the UI when no hosted API is configured. */
export async function runMockProductExtraction(sources: readonly string[]): Promise<ProductExtractionRun[]> {
  return sources.map((source, index) => createMockProductExtraction(source, index));
}

/** Creates one realistic PDP extraction payload for demos, tests, and GitHub Pages mode. */
export function createMockProductExtraction(source: string, index = 0): ProductExtractionRun {
  const productName = index % 2 === 0 ? "Hydra Barrier Cream" : "Bright Tone Serum";
  const benefit = index % 2 === 0 ? "hydration" : "brightening";
  const effect = index % 2 === 0 ? "barrier care" : "tone improvement";
  const visualText = `${benefit} ${effect} niacinamide daily use FAQ`;
  const sentenceInsights = [
    {
      imageUrl: `${source.replace(/\/$/, "")}/mock-product-${index + 1}.jpg`,
      text: `${benefit} and ${effect} are emphasized with niacinamide in the mock PDP copy.`,
      category: "benefit" as const,
      keywords: [benefit, effect, "niacinamide"]
    }
  ];
  const generatedAt = new Date().toISOString();
  const result: ProductExtractionResult = {
    source,
    sourceType: "mock",
    geoProduct: {
      name: productName,
      price: {
        raw: index % 2 === 0 ? "32,000원" : "28,000원",
        amount: index % 2 === 0 ? 32000 : 28000,
        currency: "KRW"
      },
      description: `${productName} mock PDP extraction result generated from URL input.`,
      images: [`${source.replace(/\/$/, "")}/mock-product-${index + 1}.jpg`],
      options: ["50ml", "100ml"],
      benefits: [benefit, "soothing", "moisture"],
      effects: [effect, "skin comfort"],
      ingredients: ["niacinamide"],
      usage: ["daily use"],
      metrics: ["50ml", "100ml", "4.7 stars"],
      faq: [
        {
          question: "Can this product be used every day?",
          answer: "Yes. The page copy indicates daily morning and night usage."
        },
        {
          question: "Which customer concern does it address?",
          answer: `The extracted OCR and review keywords emphasize ${benefit}.`
        }
      ],
      reviews: {
        rating: 4.7,
        reviewCount: 1284,
        items: [
          {
            body: "Absorbs quickly and leaves the skin feeling hydrated without heaviness.",
            rating: 5,
            datePublished: "2026-05-10"
          },
          {
            body: "I liked the smooth finish and would repurchase.",
            rating: 4,
            datePublished: "2026-05-21"
          }
        ],
        keywords: ["quick absorption", "repurchase", benefit]
      },
      sourceExtraction: {
        html: {
          description: `${productName} mock PDP extraction result generated from URL input.`,
          sections: [
            {
              title: "Benefits",
              category: "benefit",
              text: `${benefit} and ${effect} are emphasized in the mock PDP copy.`,
              bullets: [benefit, effect]
            },
            {
              title: "Ingredients",
              category: "ingredient",
              text: "niacinamide",
              bullets: ["niacinamide"]
            }
          ],
          faq: [
            {
              question: "Can this product be used every day?",
              answer: "Yes. The page copy indicates daily morning and night usage."
            },
            {
              question: "Which customer concern does it address?",
              answer: `The extracted OCR and review keywords emphasize ${benefit}.`
            }
          ]
        },
        ocr: {
          imageTexts: [
            {
              imageUrl: `${source.replace(/\/$/, "")}/mock-product-${index + 1}.jpg`,
              text: visualText
            }
          ],
          textBlocks: [visualText],
          sentenceInsights
        }
      },
      aiAnalysis: {
        keywords: {
          product: [],
          price: [],
          benefit: [benefit],
          effect: [effect],
          ingredient: ["niacinamide"],
          usage: ["daily use"],
          faq: ["FAQ"],
          review: [],
          metric: [],
          trend: [],
          unknown: []
        },
        categorizedSections: [
          {
            title: "Benefits",
            category: "benefit",
            text: `${benefit} and ${effect} are emphasized in the mock PDP copy.`,
            bullets: [benefit, effect]
          },
          {
            title: "Ingredients",
            category: "ingredient",
            text: "niacinamide",
            bullets: ["niacinamide"]
          }
        ],
        summary: "Mock product evidence was categorized into product fields."
      },
      categorizedProductInfo: {
        benefits: [benefit, "soothing", "moisture"],
        effects: [effect, "skin comfort"],
        ingredients: ["niacinamide"],
        usage: ["daily use"],
        metrics: ["50ml", "100ml", "4.7 stars"],
        faq: [
          {
            question: "Can this product be used every day?",
            answer: "Yes. The page copy indicates daily morning and night usage."
          },
          {
            question: "Which customer concern does it address?",
            answer: `The extracted OCR and review keywords emphasize ${benefit}.`
          }
        ]
      },
      customerReviewAnalysis: {
        rating: 4.7,
        reviewCount: 1284,
        items: [
          {
            body: "Absorbs quickly and leaves the skin feeling hydrated without heaviness.",
            rating: 5,
            datePublished: "2026-05-10"
          },
          {
            body: "I liked the smooth finish and would repurchase.",
            rating: 4,
            datePublished: "2026-05-21"
          }
        ],
        keywords: ["quick absorption", "repurchase", benefit],
        reviewSignals: ["quick absorption", "repurchase", benefit],
        ratingSummary: "Rating 4.7 · 1284 reviews"
      },
      contentAnalysis: {
        sections: [
          {
            title: "Benefits",
            category: "benefit",
            text: `${benefit} and ${effect} are emphasized in the mock PDP copy.`,
            bullets: [benefit, effect]
          },
          {
            title: "Ingredients",
            category: "ingredient",
            text: "niacinamide",
            bullets: ["niacinamide"]
          },
          {
            title: "Customer rating",
            category: "rating",
            text: "Rating 4.7 · 1284 reviews",
            bullets: ["Rating 4.7 · 1284 reviews"]
          }
        ],
        reviewSignals: ["quick absorption", "repurchase", benefit],
        ratingSummary: "Rating 4.7 · 1284 reviews"
      },
      ocr: {
        textBlocks: [visualText],
        keywords: {
          product: [],
          price: [],
          benefit: [benefit],
          effect: [effect],
          ingredient: ["niacinamide"],
          usage: ["daily use"],
          faq: ["FAQ"],
          review: [],
          metric: [],
          trend: [],
          unknown: []
        },
        sentenceInsights
      },
      rag: {
        chunks: [
          {
            id: "product-1",
            kind: "product",
            text: `${productName}\n${benefit}\n${effect}`
          },
          {
            id: "review-1",
            kind: "review",
            text: "Absorbs quickly and leaves the skin feeling hydrated without heaviness."
          },
          {
            id: "ocr-1",
            kind: "ocr",
            text: visualText
          }
        ]
      }
    },
    generatedAt,
    ragProfile: productExtractorRagManifest.profile
  };

  return {
    result,
    diagnostics: {
      source,
      sourceType: result.sourceType,
      process: createMockProcessTrace(source),
      evidence: [
        { field: "product.name", source: "mock", value: productName },
        { field: "product.benefits", source: "mock", value: benefit },
        { field: "ocr.keywords", source: "ocr", value: `${benefit}, ${effect}, niacinamide` }
      ],
      warnings: [
        {
          code: "MOCK_MODE",
          message: "This result was generated in mock mode. Configure a hosted API for live URL crawling."
        }
      ],
      generatedAt,
      ragProfile: result.ragProfile
      }
  };
}

function createMockProcessTrace(source: string): ProductExtractionStep[] {
  const completedAt = new Date().toISOString();
  const steps: Array<Pick<ProductExtractionStep, "id" | "title" | "description" | "message">> = [
    {
      id: "input",
      title: "입력 정규화",
      description: "상품 URL과 REST API 주소를 표준 실행 입력으로 검증",
      message: `Mock 입력 ${source}를 정규화했습니다.`
    },
    {
      id: "fetch",
      title: "소스 수집",
      description: "페이지 HTML, 메타정보, JSON-LD 또는 API 응답 수집",
      message: "Mock PDP 소스를 수집했습니다."
    },
    {
      id: "extract",
      title: "상품정보 추출",
      description: "상품명, 가격, 설명, 옵션, FAQ 후보 정규화",
      message: "Mock 상품정보를 추출했습니다."
    },
    {
      id: "ocr",
      title: "OCR 문장/키워드 분석",
      description: "이미지/상세 영역의 효능, 효과, 성분 문장과 키워드 분류",
      message: "Mock OCR 문장과 키워드를 분류했습니다."
    },
    {
      id: "review",
      title: "리뷰 신호 추출",
      description: "평점, 리뷰본문, 대표 키워드, 고객 표현 정리",
      message: "Mock 리뷰 키워드를 추출했습니다."
    },
    {
      id: "rag",
      title: "RAG chunk 생성",
      description: "상품/리뷰/FAQ/OCR evidence를 RAG 데이터로 구성",
      message: "Mock RAG chunk를 생성했습니다."
    },
    {
      id: "json",
      title: "JSON 결과 생성",
      description: "복사 가능한 최종 JSON 아티팩트 생성",
      message: "Mock JSON 결과를 생성했습니다."
    }
  ];

  return steps.map((step) => ({
    ...step,
    status: "done",
    completedAt
  }));
}
