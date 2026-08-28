import { describe, expect, it, vi } from "vitest";
import { generatePdpGeo } from "../src";
import { validateAndRepairPdpGeoArtifacts } from "../src/validate";

/**
 * 근거 라우팅 — OCR 문장 분류, E-E-A-T 신뢰 게이트, 성분·지표가 제 필드로 가는지.
 *
 * generate-pdp-geo.test.ts에서 주제별로 분리했다(어서션은 그대로).
 */

describe("generatePdpGeo", () => {
  it("keeps product-detail image URLs in diagnostics beyond the first 12 images", async () => {
    const images = Array.from({ length: 20 }, (_, index) => `https://cdn.example.com/pdp/detail-${index + 1}.png`);
    const editorImage = "https://assets.example.com/upload/editor/f4652a02-f514-4936-ac7e-00f5fcab61b4.png";
    images.splice(15, 0, editorImage);

    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "Barrier Hydro Soothing Cream",
          description: "Hydrating cream for skin barrier moisture care.",
          images,
          benefits: ["hydration"],
          ingredients: ["Compressed Hyaluronic Acid"]
        }
      },
      source: {
        type: "pdp-extractor",
        url: "https://example.com/products/barrier-hydro-soothing-cream"
      }
    });

    expect(result.diagnostics.normalizedProduct.images).toContain(editorImage);
  });
  it("generates GEO schema markup without HTML CONTENT from arbitrary REST JSON with field mapping", async () => {
    const { result, process } = await generatePdpGeo({
      product: {
        item: {
          title: "Hydra Barrier Cream",
          body: "Daily cream for dry skin, hydration, and skin barrier support.",
          maker: "Agentic Beauty",
          taxonomy: "Cream",
          amount: "32000",
          currencyCode: "KRW",
          detail: {
            hero: "Niacinamide, Ceramide, and Panax Ginseng Root Extract support moisture barrier care.",
            use: "Apply morning and night after serum.",
            good: "Hydration and skin barrier support for dry skin."
          }
        },
        reviewList: [
          { body: "촉촉하고 흡수감이 좋아요.", rating: 5 }
        ],
        reviewMeta: {
          rating: 4.8,
          count: 418,
          keywords: ["촉촉", "흡수감", "피부결"]
        }
      },
      source: {
        type: "rest-api",
        url: "https://example.com/products/hydra-barrier-cream"
      },
      hints: {
        locale: "ko-KR",
        market: "KR",
        category: "크림"
      },
      fieldMapping: {
        name: "item.title",
        description: "item.body",
        brand: "item.maker",
        category: "item.taxonomy",
        price: "item.amount",
        currency: "item.currencyCode",
        ingredients: "item.detail.hero",
        usage: "item.detail.use",
        benefits: "item.detail.good",
        reviews: "reviewList",
        rating: "reviewMeta.rating",
        reviewCount: "reviewMeta.count"
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const webPage = graph.find((node) => (Array.isArray(node["@type"]) ? node["@type"].includes("WebPage") : node["@type"] === "WebPage")) as Record<string, any>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    expect(Array.isArray(graph)).toBe(true);
    expect(JSON.stringify(result.schemaMarkup.jsonLd)).toContain("\"Product\"");
    expect(JSON.stringify(result.schemaMarkup.jsonLd)).toContain("\"FAQPage\"");
    expect(JSON.stringify(result.schemaMarkup.jsonLd)).not.toContain("\"HowTo\"");
    expect(JSON.stringify(result.schemaMarkup.jsonLd)).toContain("\"BreadcrumbList\"");
    expect(JSON.stringify(result.schemaMarkup.jsonLd)).toContain("\"WebPage\"");
    expect(result.content.sections.productName).toContain("Hydra Barrier Cream");
    expect(result.content.sections.description).toContain("흡수감");
    expect(webPage.description).toContain("Hydra Barrier Cream");
    expect(webPage.description).not.toMatch(/확인 근거|정리합니다|내용이 포함|노출됩니다|로 제시됩니다|요약됩니다/);
    expect(product.description).toBe(result.content.sections.description);
    expect(JSON.stringify(product.additionalProperty)).not.toContain("Apply morning and night after serum");
    expect(webPage.description).not.toBe(product.description);
    expect(result.content.sections.quickFacts).toContain("주요 성분");
    expect(result.content.sections.quickFacts).not.toMatch(/사용 맥락|검색\/비교 맥락|성분\/효능 포인트|Use context|Search context|Ingredient\/effect detail/i);
    expect(result.content.html).toBe("");
    expect(result.diagnostics.recommendations.some((item) => item.field === "description")).toBe(true);
    expect(result.diagnostics.evidence.some((item) => item.source === "fieldMapping")).toBe(true);
    expect(result.diagnostics.ragMode).toBe("local-versioned-rag");
    expect(process.map((step) => step.id)).toEqual(["input", "normalize", "rag-load", "chunk", "embed", "retrieve", "rerank", "generate", "validate", "repair", "quality-gate", "artifact"]);
    expect(process.every((step) => step.status === "done")).toBe(true);
  });
  it("elevates SKU-heavy Korean PDP evidence into BestPractice-style GEO content", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "[예시럭셔리][소용량] 보태니컬 리뉴얼 크림 30ml",
          description: "예시럭셔리[소용량] 보태니컬 리뉴얼 크림 30ml공유10%168,000원151,200원5. 식물 복합체, 진생펩타이드, 비타민C 유도체를 담은 산뜻한 고밀도 텍스처의 안티에이징 크림입니다. 민감 피부 사용 적합 테스트 완료.",
          brand: "예시럭셔리",
          category: "크림",
          price: {
            raw: "270,000원",
            currency: "KRW"
          },
          benefits: ["주름 케어", "탄력", "피부결", "수분감"],
          effects: ["피부 탄력과 주름 케어", "피부결 케어"],
          ingredients: ["식물 복합체", "진생펩타이드", "비타민C 유도체", "인삼 추출물", "｢화장품법｣에 따라 기재ㆍ표시하여야 하는 모든 성분"],
          usage: ["아침과 저녁 스킨케어 마지막 단계에서 얼굴에 부드럽게 펴 발라 흡수시켜 주세요."],
          faq: [
            { question: "보태니컬 리뉴얼 크림은 어떤 피부 고민에 적합한가요?", answer: "예시럭셔리 보태니컬 리뉴얼 크림은 주름, 탄력, 피부결, 수분감을 함께 고민하는 고객에게 적합한 안티에이징 크림입니다." },
            { question: "핵심 성분은 무엇인가요?", answer: "예시럭셔리 보태니컬 리뉴얼 크림에는 식물 복합체, 진생펩타이드, 비타민C 유도체가 포함되어 있으며 탄력과 피부결 케어 맥락을 제공합니다." },
            { question: "어떻게 사용하나요?", answer: "아침과 저녁 스킨케어 마지막 단계에서 얼굴에 부드럽게 펴 바른 뒤 흡수시켜 사용하면 됩니다." },
            { question: "민감 피부도 사용할 수 있나요?", answer: "상품 정보에는 민감 피부 사용 적합 테스트 완료 정보가 포함되어 있어 민감 피부 고객도 선택 기준으로 참고할 수 있습니다." },
            { question: "제형은 어떤가요?", answer: "예시럭셔리 보태니컬 리뉴얼 크림은 산뜻한 고밀도 텍스처를 강조하며, 리뷰에서는 쫀쫀함과 촉촉함, 흡수감이 함께 언급됩니다." },
            { question: "세럼과 함께 사용할 수 있나요?", answer: "보태니컬 리뉴얼 세럼이나 에센스 사용 후 크림 단계에서 함께 사용할 수 있으며, 스킨케어 마지막 단계에서 마무리하는 루틴에 적합합니다." },
            { question: "소용량과 본품은 어떻게 비교하나요?", answer: "소용량 30ml와 본품 50ml는 용량과 가격을 기준으로 비교할 수 있으며, 현재 페이지는 30ml 옵션 정보를 함께 제공합니다." },
            { question: "선물용으로도 적합한가요?", answer: "프리미엄 안티에이징 크림을 찾는 고객에게 선물 구매 맥락으로도 고려할 수 있습니다." },
            { question: "전성분은 어디서 확인하나요?", answer: "｢화장품법｣에 따라 기재ㆍ표시하여야 하는 모든 성분 정보입니다." }
          ],
          reviews: {
            rating: 4.8,
            reviewCount: 1240,
            items: [
              { body: "쫀쫀하고 촉촉한 사용감과 흡수감이 좋아서 피부결이 매끄럽게 느껴져요.", rating: 5 }
            ],
            keywords: ["쫀쫀", "촉촉", "흡수감", "피부결"]
          },
          options: ["[소용량] 보태니컬 리뉴얼 크림 30ml 168,000원", "보태니컬 리뉴얼 크림 50ml 270,000원"],
          sourceTexts: [
            "예시럭셔리[소용량] 보태니컬 리뉴얼 크림 30ml공유10%168,000원151,200원5",
            "식물 복합체와 진생펩타이드, 비타민C 유도체",
            "산뜻한 고밀도 텍스처",
            "민감 피부 사용 적합 테스트 완료",
            "보태니컬 리뉴얼 세럼 사용 후 크림 단계에서 사용"
          ]
        }
      },
      source: {
        type: "pdp-extractor",
        url: "https://example.com/products/botanical-renewal-cream?sku=example-sku"
      },
      hints: {
        locale: "ko-KR",
        market: "KR"
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const webPage = graph.find((node) => (Array.isArray(node["@type"]) ? node["@type"].includes("WebPage") : node["@type"] === "WebPage")) as Record<string, any>;
    const faq = graph.find((node) => node["@type"] === "FAQPage") as Record<string, any>;
    const howTo = graph.find((node) => node["@type"] === "HowTo") as Record<string, any> | undefined;
    const breadcrumb = graph.find((node) => node["@type"] === "BreadcrumbList") as Record<string, any>;
    const propertyNames = (product.additionalProperty as Array<Record<string, any>>).map((item) => item.name);
    const propertyText = JSON.stringify(product.additionalProperty);
    const faqText = JSON.stringify(faq.mainEntity);
    const fullSchemaText = JSON.stringify(result.schemaMarkup.jsonLd);

    expect(result.content.sections.productName).toBe("예시럭셔리 보태니컬 리뉴얼 크림");
    expect(product.name).toBe("예시럭셔리 보태니컬 리뉴얼 크림");
    expect(product.alternateName).toBe("[예시럭셔리][소용량] 보태니컬 리뉴얼 크림 30ml");
    expect(product.url).toBe("https://example.com/products/botanical-renewal-cream?sku=example-sku");
    expect(product.mainEntityOfPage).toEqual({ "@id": webPage["@id"] });
    expect(product.sku).toBe("example-sku");
    expect(product.size).toBe("30ml");
    expect(product.offers.price).toBe(168000);
    expect(product.offers.priceCurrency).toBe("KRW");
    expect(webPage.breadcrumb).toEqual({ "@id": breadcrumb["@id"] });
    expect(faq.about).toEqual({ "@id": product["@id"] });
    expect(faq.isPartOf).toEqual({ "@id": webPage["@id"] });
    expect(howTo?.step).toHaveLength(1);
    expect(JSON.stringify(webPage.hasPart ?? [])).toContain("#how-to-use");
    expect(result.content.sections.howToUse).toContain("아침과 저녁 스킨케어 마지막 단계");
    expect(String(product.description)).not.toContain("[소용량]");
    expect(String(product.description)).toContain("식물 복합체");
    expect(String(webPage.description)).not.toBe(String(product.description));
    expect(String(webPage.description)).toContain("예시럭셔리 보태니컬 리뉴얼 크림 상품 페이지");
    expect(String(webPage.description)).not.toMatch(/크림\s*상품을\s*소개합니다/u);
    expect(String(webPage.description)).toMatch(/예시럭셔리 보태니컬 리뉴얼 크림은[^.]*고객을 위한 제품/u);
    expect(String(webPage.description)).toMatch(/식물 복합체[^.]*주요 성분·기술로 포함하고/u);
    expect(String(webPage.description)).toMatch(/예시럭셔리 보태니컬 리뉴얼 크림은 소용량 보태니컬 리뉴얼 크림 30ml, 보태니컬 리뉴얼 크림 50ml 옵션으로 구성되어 있으며, 270,000원에 판매되고 있습니다.*고객 리뷰에서 고객들은/u);
    expect(String(webPage.description)).not.toMatch(/페이지 본문에서는|페이지에서 확인할 수 있는|페이지에 공개된/u);
    expect(String(webPage.description)).not.toMatch(/핵심 성분\/(?:기술|포뮬러)|성분\/기술(?:을|를|로|으로)?[^.。！？]*(?:중심|설명|소개|제시)/);
    expect(String(webPage.description)).not.toMatch(/상품 정보로\s*(?:주요\s*)?효능,\s*성분\/기술,\s*사용 루틴/);
    expect(String(webPage.description)).not.toMatch(/HowTo|FAQ에서는|FAQ와 사용법/);
    expect(String(webPage.description)).toMatch(/옵션으로 구성되어 있으며,[^.]*판매되고 있습니다/);
    expect(String(product.description)).not.toContain("상품 페이지");
    expect(String(webPage.description)).not.toMatch(/확인 근거|확인 지표|확인됩니다|결과 결과|정리합니다|내용이 포함|노출됩니다|로 제시됩니다|요약됩니다|CARE|저자극 세안/);
    expect(String(product.description)).not.toMatch(/제품로|줍니다입니다|화장품법|확인 근거|정리합니다|내용이 포함|노출됩니다|로 제시됩니다|요약됩니다|CARE|저자극 세안/);
    expect(faq.mainEntity.length).toBeGreaterThanOrEqual(5);
    expect(faq.mainEntity.length).toBeLessThanOrEqual(8);
    expect(faq.mainEntity.some((item: any) => /고민인\s*고객에게|고객에게[^?？]*적합/u.test(String(item.name))
      && /(?:돕습니다|도움을\s*줍니다)/u.test(String(item.acceptedAnswer.text)))).toBe(true);
    expect(String(webPage.description)).toContain("소용량 보태니컬 리뉴얼 크림 30ml");
    expect(faqText).not.toMatch(/화장품법|기재ㆍ표시/);
    expect(propertyNames).toContain("Recommended skin type");
    expect(propertyNames).toContain("Key ingredients and technologies");
    expect(propertyNames).toContain("Functional certification");
    expect(propertyNames).toContain("Texture and finish");
    expect(propertyText).toContain("식물 복합체");
    expect(propertyText).toContain("진생펩타이드");
    expect(propertyText).toContain("비타민C 유도체");
    expect(propertyText).not.toMatch(/CONCENTR|피부결과 피부결|제품로|화장품법|기재ㆍ표시/);
    expect(fullSchemaText).not.toMatch(/화장품법|기재ㆍ표시/);
  });
  it("filters noisy category, review keywords, and usage tokens before schema generation", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "Essential Activating Serum",
          description: "Hydrating serum with Botanical Actives for daily skincare.",
          brand: "ExampleLuxe",
          category: "usage",
          benefits: ["hydration", "firming"],
          ingredients: [
            "BOTANICAL ACTIVES (AKA BOTANICAL COMPLEX ™)- Patented ingredient that amplifies the rare and potent anti-aging compounds found in Ginseng.",
            "NIACINAMIDE"
          ],
          usage: [
            "Use morning and night, after applying toner. Warm three pumps between fingers and apply to your face and neck with upward motions.",
            "apply",
            "morning",
            "night",
            "pump"
          ],
          reviews: {
            keywords: ["rating", "smooth", "Review", "NIACINAMIDE"],
            items: [
              { body: "rating" },
              { body: "The texture feels smooth and absorbs quickly without feeling heavy.", rating: 5 }
            ]
          }
        }
      },
      source: {
        type: "pdp-extractor",
        url: "https://example.com/products/essential-activating-serum"
      },
      hints: {
        locale: "en-US",
        market: "US"
      }
    });

    const serialized = JSON.stringify(result.schemaMarkup.jsonLd);
    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const howTo = graph.find((node) => node["@type"] === "HowTo") as Record<string, any>;

    expect(serialized).not.toContain("GEO-ready PDP name");
    expect(product.name).toBe("Essential Activating Serum");
    expect(product.description).toContain("hydration");
    expect(product.category).not.toBe("usage");
    expect(product.review?.[0]?.reviewBody).toContain("smooth");
    expect(serialized).not.toContain("\"reviewBody\":\"rating\"");
    expect(howTo?.step).toHaveLength(1);
    expect(result.content.sections.howToUse).toContain("Use morning and night");
    expect(result.content.sections.howToUse).toContain("Warm three pumps");
    expect(serialized).not.toContain("\"text\":\"apply\"");
    expect(result.content.sections.howToUse).not.toContain("3. apply");
    expect(result.content.sections.description).not.toContain("PDP name");
  });
  it("applies E-E-A-T trust gates to offer, review, image, and OCR-routed schema fields", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "Essential Activating Serum",
          description: "Hydrating serum with Botanical Actives for daily skin-care routines.",
          brand: "ExampleLuxe",
          category: "Serum",
          price: {
            raw: "8900"
          },
          images: [
            "https://cdn.example.com/products/essential-activating-serum-main.jpg?width=1200&format=webp",
            "http://cdn.example.com/products/essential-activating-serum-main.jpg?width=600",
            "https://cdn.example.com/icons/Hydrating.png?width=48",
            "https://cdn.example.com/products/NewCGRCream_cream_tile.jpg",
            "https://cdn.example.com/products/SWS_Thumbnail_GCF_cleanser.jpg"
          ],
          benefits: ["hydration", "firmness", "ELASTICITY", "elasticity"],
          ingredients: ["Botanical Actives", "Ginseng Peptide"],
          usage: [
            "Use morning and night, after applying toner.",
            "AFTER 6 WEEKS OF USE 100% AGREED SKIN FEELS FIRMER AND MORE ELASTIC."
          ],
          reviews: {
            keywords: ["smooth", "firmness"],
            items: [
              { body: "Essential Activating Serum" }
            ]
          },
          sourceExtraction: {
            ocr: {
              sentenceInsights: [
                {
                  imageUrl: "https://cdn.example.com/products/ritual.jpg",
                  category: "ingredient",
                  text: "COMPLETE YOUR RITUAL STEP 1 ACTIVATING SERUM STEP 2 BALANCE WATER STEP 3 TREATMENT SERUM STEP 4 CREAM",
                  keywords: ["ginseng", "serum", "cream"]
                },
                {
                  imageUrl: "https://cdn.example.com/products/use.jpg",
                  category: "usage",
                  text: "Gently pat 2-3 pumps onto skin morning and night after toner.",
                  keywords: ["use", "morning", "night"]
                }
              ]
            }
          }
        }
      },
      source: {
        type: "pdp-extractor",
        url: "https://example.com/products/essential-activating-serum-vi"
      },
      hints: {
        locale: "en-US",
        market: "US"
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const howTo = graph.find((node) => node["@type"] === "HowTo") as Record<string, any>;
    const images = product.image as string[];
    const serialized = JSON.stringify(result.schemaMarkup.jsonLd);

    expect(product.offers).toMatchObject({
      "@type": "Offer",
      price: 89,
      priceCurrency: "USD",
      url: "https://example.com/products/essential-activating-serum-vi"
    });
    expect(images).toEqual(["https://cdn.example.com/products/essential-activating-serum-main.jpg"]);
    expect(product.review).toBeUndefined();
    expect(serialized).not.toMatch(/COMPLETE YOUR RITUAL|BALANCE WATER|TREATMENT SERUM|NewCGRCream|SWS_Thumbnail_GCF|Hydrating\.png/i);
    expect(howTo?.step).toHaveLength(1);
    expect(result.content.sections.howToUse).toContain("Gently pat 2-3 pumps");
    expect(result.content.sections.howToUse).not.toContain("AFTER 6 WEEKS");
    expect(product.positiveNotes).toBeUndefined();
    expect(/elasticity/i.test(`${serialized} ${result.content.sections.benefits}`)).toBe(true);
    expect(result.diagnostics.ocrSentences.some((item) => item.text.includes("COMPLETE YOUR RITUAL"))).toBe(false);
  });
  it("formats Korean OCR metric evidence without agreement artifacts and keeps timelines out of HowTo", async () => {
    const barrierRecoveryEvidence = "세안 후 첫 단계 민감 건조 피부 급속 수분 충전 외부자극에 의한 장벽 손상 즉시 회복 사용 직후 60.5% 회복 사용 7일 후 87.3% 회복 손상 직후 사용 직후 사용 7일 후";
    const ceramideEvidence = "18시간 1회 도포 후 18시간 장벽에서 잔존하는 세라마이드 ex vivo 테스트 결과 190%";
    const mixedUsage = `사용 전 사용 직후 사용 전 사용 직후 사용 전 사용 직후 배리어케어™ 캡슐토너 사용법 1 손에 적당량을 덜어 얼굴 전체에 펴 발라 흡수시켜 줍니다`;

    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "예시더마 배리어케어365 캡슐 토너",
          description: "민감 건조 피부의 수분과 피부 장벽 케어를 위한 캡슐 토너입니다.",
          category: "토너",
          benefits: ["피부 장벽", "수분감"],
          ingredients: ["세라마이드"],
          usage: [mixedUsage],
          faq: [
            {
              question: "어떤 고객에게 추천할 수 있나요?",
              answer: "민감 건조 피부 고객에게 추천합니다."
            }
          ],
          sourceExtraction: {
            ocr: {
              sentenceInsights: [
                {
                  imageUrl: "https://image.example.com/upload/editor/detail-1.png",
                  category: "usage",
                  text: barrierRecoveryEvidence,
                  keywords: ["장벽", "회복"]
                },
                {
                  imageUrl: "https://image.example.com/upload/editor/detail-2.png",
                  category: "effect",
                  text: ceramideEvidence,
                  keywords: ["세라마이드", "장벽"]
                }
              ]
            }
          }
        }
      },
      source: {
        type: "pdp-extractor",
        url: "https://www.example.com/products/barrier-capsule-toner"
      },
      hints: {
        locale: "ko-KR",
        market: "KR"
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const howTo = graph.find((node) => node["@type"] === "HowTo") as Record<string, any>;
    const faqPage = graph.find((node) => node["@type"] === "FAQPage") as Record<string, any>;
    const reportedDetails = (product.additionalProperty as Array<Record<string, any>>)
      .find((item) => item.name === "Reported details")?.value as string;
    const recommendationAnswer = ((faqPage.mainEntity as Array<Record<string, any>>)
      .find((item) => /어떤\s*고객|고민인\s*고객.*(?:효과|적합)|고객에게[^?？]*적합/u.test(String(item.name)))?.acceptedAnswer as Record<string, any>)?.text as string;
    const normalizedUsage = result.diagnostics.normalizedProduct.usage.join("\n");
    const barrierOcr = result.diagnostics.ocrSentences.find((item) => item.text === barrierRecoveryEvidence);

    expect(reportedDetails).toContain("60.5%");
    expect(reportedDetails).toContain("87.3%");
    expect(reportedDetails).toContain("190%");
    expect(reportedDetails).toMatch(/사용 7일 후|18시간/);
    expect(reportedDetails).not.toMatch(/\bagreed\b|Also|사용 전 사용 직후/i);
    expect(recommendationAnswer).toMatch(/세라마이드|피부 장벽|수분감/);
    expect(recommendationAnswer).not.toMatch(/60\.5%|87\.3%|사용 직후|사용 7일 후/);
    expect(recommendationAnswer).not.toMatch(/특정\s*성분이[^.]*단독|설명됩니다|안내됩니다/u);
    expect(recommendationAnswer).not.toMatch(/효능 맥락을 뒷받침|성분 근거와 효능 맥락/);
    expect(howTo?.step).toHaveLength(1);
    expect(result.content.sections.howToUse).toContain("손에 적당량");
    expect(result.content.sections.howToUse).not.toMatch(/60\.5%|87\.3%|190%|사용 전 사용 직후|사용법/);
    expect(normalizedUsage).toContain("손에 적당량");
    expect(normalizedUsage).not.toMatch(/60\.5%|87\.3%|사용 전 사용 직후|사용법/);
    expect(barrierOcr?.intents).not.toContain("usage");
    expect(barrierOcr?.schemaFields).not.toContain("HowTo.step");
  });
  it("recovers Korean cleanser HowTo steps from mixed OCR source text instead of using product description copy", async () => {
    const productDescriptionAsUsage = "이 클렌저는 극민감 피부도 부담없이 사용할 수 있는 베리어 프로텍티브 포뮬라 세라마이드 거품 클렌저로 제시된다.";
    const mixedOcrSources = [
      "Barrier Protective Formula 세안 중에도 피부를 보호해주는 3종 장벽 보호 성분 함유 판테놀 비타민 B5 유도체로, 피부 장벽을 개선합니다. 베타인 아미노산 유도체로, 피부 장벽을 더욱 견고하게 합니다. 배리어 캡슐 캡슐 속 세라마이드, 지방산, 콜레스테롤로 구성된 피부 장벽 핵심 성분이 건조하고 민감한 피부에 효과적인 보습을 전달합니다.",
      "세안 중 발생하는 장벽 손상을 줄이는 Barrier Protective Formula 조밀한 마이크로 버블 마찰자극 걱정없이, 세정력 극대화 일반 모공 평균 사이즈 250um 미세 모공 평균 사이즈 50um 포밍 클렌저 버블 평균 사이즈 41um 3종 장벽보호 성분 함유 클렌징 와중에도 장벽보호!",
      "효능 1 마찰 자극을 줄여 피부에 닿는 순간까지 고려한 저자극 포뮬라 2 눈에 보이지 않는 모공 속 노폐물까지 깔끔하게 세안 핵심 성분 Barrier Protective Formula (판테놀, 베타인, 배리어 캡슐) 추천 피부 타입 건조 피부 또는 민감 피부",
      "풍성한 터치리스 폼으로 세안 시작부터 끝까지 마찰자극 걱정없는 거품 세안 초미세먼지 98.1% 세정 사용 전 사용 후 모공 속 노폐물 97.9% 세정 세안 전 세안 후 만 20~39세의 성인 여성 30명 대상 / 시험기간 2025.07.21~2025.08.22 / 개인차 있음 피부 각질층 내 세라마이드 함량 분석 사용 전 사용 직후 사용 2주 후 사용 4주 후 63.6% 84.3% 97.1% 자사 알칼리 폼(HB) 배리어케어365 젠틀 포밍 클렌저 *In vitro 시험 결과",
      "배리어케어® 젠틀 포밍 클렌저 사용법 1 적당량을 물과 함께 거품내어 얼굴에 마사지하듯 문지른 후 2 미온수로 깨끗하게 헹구어 마무리해 주세요."
    ];

    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "예시더마 배리어케어365 젠틀 포밍클렌저",
          description: productDescriptionAsUsage,
          category: "클렌저",
          benefits: ["피부 장벽", "보습"],
          ingredients: ["세라마이드", "판테놀", "프로바이오틱스"],
          usage: [productDescriptionAsUsage],
          sourceTexts: mixedOcrSources,
          semanticFacts: {
            ingredients: ["Barrier Protective Formula", "BarrierCapsule", "세라마이드", "판테놀", "베타인"],
            benefits: ["피부 장벽", "수분감", "마이크로 버블", "세정력", "저자극 세안", "모공 속 노폐물 세정"],
            effects: ["초미세먼지 세정", "모공 속 노폐물 세정", "피부 각질층 세라마이드 함량"],
            skinTypes: ["건조 피부 또는 민감 피부"],
            usageSteps: [
              "적당량을 물과 함께 거품내어 얼굴에 마사지하듯 문지른 후",
              "미온수로 깨끗하게 헹구어 마무리해 주세요"
            ],
            metricClaims: [
              {
                label: "초미세먼지 세정",
                value: "98.1%",
                sample: "만 20~39세의 성인 여성 30명",
                period: "2025.07.21~2025.08.22",
                caveat: "개인차 있음",
                sourceText: mixedOcrSources[3]
              },
              {
                label: "모공 속 노폐물 세정",
                value: "97.9%",
                sample: "만 20~39세의 성인 여성 30명",
                period: "2025.07.21~2025.08.22",
                caveat: "개인차 있음",
                sourceText: mixedOcrSources[3]
              },
              {
                label: "피부 각질층 세라마이드 함량 분석",
                value: "사용 직후 63.6%, 사용 2주 후 84.3%, 사용 4주 후 97.1%",
                method: "in vitro 시험",
                sourceText: mixedOcrSources[3]
              }
            ],
            evidenceSentences: mixedOcrSources,
            ingredientBenefitLinks: [
              {
                ingredient: "Barrier Protective Formula",
                benefit: "피부 장벽",
                sentence: mixedOcrSources[0],
                sourceText: mixedOcrSources[0]
              }
            ]
          }
        }
      },
      source: {
        type: "pdp-extractor",
        url: "https://www.example.com/products/gentle-foaming-cleanser"
      },
      hints: {
        locale: "ko-KR",
        market: "KR",
        category: "클렌저"
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const howTo = graph.find((node) => node["@type"] === "HowTo") as Record<string, any>;
    const additionalProperties = product.additionalProperty as Array<Record<string, any>>;
    const targetCustomer = additionalProperties.find((item) => item.name === "Target customer")?.value;
    const keyIngredients = additionalProperties.find((item) => item.name === "Key ingredients")?.value;
    const reportedDetails = additionalProperties.find((item) => item.name === "Reported details")?.value;
    const usageContext = additionalProperties
      .find((item) => item.name === "Usage")?.value;
    const howToText = JSON.stringify(howTo?.step ?? usageContext ?? result.content.sections.howToUse);
    const normalizedUsage = result.diagnostics.normalizedProduct.usage.join("\n");

    expect(String(targetCustomer)).toContain("건조 피부 또는 민감 피부");
    expect(String(keyIngredients)).toMatch(/Barrier Protective Formula|판테놀|베타인|BarrierCapsule/);
    expect(String(reportedDetails)).toMatch(/초미세먼지 98\.1%|모공 속 노폐물 97\.9%|30명 대상|2025\.07\.21~2025\.08\.22|사용 4주 후 97\.1%/);
    expect(result.content.sections.quickFacts).toMatch(/추천 피부 타입은 건조 피부 또는 민감 피부|Barrier Protective Formula|판테놀|베타인|초미세먼지 98\.1%|모공 속 노폐물 97\.9%/);
    expect(result.content.sections.benefits).toMatch(/저자극 세안|초미세먼지 세정|모공 속 노폐물 세정|마이크로 버블|세정력/);
    expect(howTo?.step).toHaveLength(2);
    expect(howToText).toContain("적당량을 물과 함께 거품내어 얼굴에 마사지하듯 문지릅니다");
    expect(howToText).toContain("미온수로 깨끗하게 헹구어 마무리해 주세요");
    expect(howToText).not.toContain("후 2 미온수");
    expect(howToText).not.toContain("극민감 피부도 부담없이 사용할 수 있는");
    expect(String(usageContext)).toContain("거품내어 얼굴에 마사지하듯");
    expect(String(usageContext)).toContain("미온수로 깨끗하게 헹구어 마무리");
    expect(String(usageContext)).not.toContain("극민감 피부도 부담없이 사용할 수 있는");
    expect(normalizedUsage).not.toContain(productDescriptionAsUsage);
  });
  it("renders Korean full ingredient lists from extracted ingredient data", async () => {
    const koreanFullIngredients = [
      "정제수",
      "부틸렌글라이콜",
      "글리세린",
      "프로판다이올",
      "1,2-헥산다이올",
      "식물성스쿠알란",
      "세테아릴알코올",
      "하이드록시프로필스타치포스페이트",
      "잔탄검",
      "글리세릴스테아레이트",
      "하이드로제네이티드레시틴",
      "아크릴레이트/C10-30알킬아크릴레이트크로스폴리머",
      "아세틸글루코사민",
      "스테아릭애씨드",
      "판테놀",
      "글루코노락톤",
      "카보머",
      "콜레스테롤",
      "세라마이드엔피",
      "토코페롤"
    ].join(", ");

    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "예시더마 배리어케어365 바디로션",
          description: "건조로 민감해진 피부장벽을 위한 고보습 바디로션입니다.",
          category: "바디로션",
          benefits: ["피부 장벽", "보습"],
          ingredients: [koreanFullIngredients],
          usage: ["샤워 후 수분끼가 남아 있을 때 사용해 주세요."]
        }
      },
      hints: {
        locale: "ko-KR",
        market: "KR",
        category: "바디로션"
      }
    });

    expect(result.diagnostics.normalizedProduct.ingredients.some((text) => text.includes("세라마이드엔피"))).toBe(true);
    expect(result.content.sections.ingredients).toContain("전성분: 정제수");
    expect(result.content.sections.ingredients).toContain("아크릴레이트/C10-30알킬아크릴레이트크로스폴리머");
    expect(result.content.sections.ingredients).toContain("세라마이드엔피");
  });
  it("prefers semantic OCR facts over product-specific ingredient or metric regexes", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "Example Calm Wash",
          description: "A gentle wash for daily cleansing.",
          category: "Cleanser",
          benefits: [],
          ingredients: [],
          usage: [],
          sourceTexts: [
            "AquaShield Ferment helps comfort cleansing and leaves dry or sensitive skin feeling calm.",
            "Micro-pollution cleansing 92.4% in a 28 participant usage test from 2026.01.05~2026.02.02.",
            "Use one pump on wet hands, massage over face, then rinse with water."
          ],
          semanticFacts: {
            ingredients: ["AquaShield Ferment"],
            benefits: ["comfort cleansing", "micro-pollution cleansing"],
            effects: ["skin feels calm after cleansing"],
            skinTypes: ["dry or sensitive skin"],
            usageSteps: ["Use one pump on wet hands and massage over face", "Rinse with water"],
            metricClaims: [
              {
                label: "micro-pollution cleansing",
                value: "92.4%",
                sample: "28 participants",
                period: "2026.01.05~2026.02.02",
                sourceText: "Micro-pollution cleansing 92.4% in a 28 participant usage test from 2026.01.05~2026.02.02."
              }
            ],
            evidenceSentences: [
              "AquaShield Ferment helps comfort cleansing for dry or sensitive skin.",
              "Micro-pollution cleansing 92.4% in a 28 participant usage test from 2026.01.05~2026.02.02."
            ],
            ingredientBenefitLinks: [
              {
                ingredient: "AquaShield Ferment",
                benefit: "comfort cleansing",
                sentence: "AquaShield Ferment helps comfort cleansing for dry or sensitive skin."
              }
            ]
          }
        }
      },
      source: {
        type: "manual-json",
        url: "https://example.com/products/calm-wash"
      },
      hints: {
        locale: "en-US",
        market: "US",
        category: "Cleanser"
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const howTo = graph.find((node) => node["@type"] === "HowTo") as Record<string, any>;
    const additionalProperties = product.additionalProperty as Array<Record<string, any>>;

    expect(additionalProperties.find((item) => item.name === "Target customer")?.value).toContain("dry or sensitive skin");
    expect(additionalProperties.find((item) => item.name === "Key ingredients")?.value).toContain("AquaShield Ferment");
    expect(additionalProperties.find((item) => item.name === "Reported details")?.value).toContain("92.4%");
    expect(additionalProperties.find((item) => item.name === "Reported details")?.value).toMatch(/28\s+participants?/i);
    expect(product.description).toContain("92.4%");
    expect(product.description).toMatch(/28\s+participants?/i);
    const webPage = graph.find((node) => (Array.isArray(node["@type"]) ? node["@type"].includes("WebPage") : node["@type"] === "WebPage")) as Record<string, any>;
    expect(webPage.description).toContain("Example Calm Wash product page introduces the cleanser");
    expect(webPage.description).toMatch(/identifies customers with dry or sensitive skin.*lists AquaShield Ferment.*highlighted formula components.*documents cleansing power.*product benefits/i);
    expect(webPage.description).toMatch(/Directions place the product in daily care/i);
    expect(webPage.description).not.toMatch(/purchase decisions|official test and measurement results/i);
    expect(webPage.description).not.toMatch(/92\.4%|28\s+participants?/i);
    expect(result.content.sections.quickFacts).toContain("AquaShield Ferment");
    expect(result.content.sections.quickFacts).toContain("92.4%");
    expect(howTo?.step).toHaveLength(1);
    expect(result.content.sections.howToUse).toMatch(/rinse with water/i);
  });
  it("routes field evidence by RAG contract without product-specific cleanup rules", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "Revive Balance Lotion EX",
          description: "A lightweight lotion for hydration, comfort, and smooth-feeling skin.",
          brand: "Example Beauty",
          category: "Lotion",
          benefits: ["hydration", "comfort", "smooth texture"],
          effects: [
            "After toning, Revive Balance Lotion EX delivers 24-hour hydration, helping skin feel soft and balanced. Instrumental test on 33 participants.",
            "96% agreed skin felt moisturized for longer after daily use."
          ],
          ingredients: [
            "Botanical Complex: A formula technology described as supporting comfort and moisture.",
            "Ingredients: WATER / AQUA / EAU, GLYCERIN, BUTYLENE GLYCOL, PANTHENOL, CAMELLIA SINENSIS LEAF EXTRACT"
          ],
          usage: [
            "After toner, apply 2 pumps of Revive Balance Lotion EX to face and neck morning and night.",
            "After toning, Revive Balance Lotion EX delivers 24-hour hydration, helping skin feel soft and balanced. Instrumental test on 33 participants."
          ],
          reviews: {
            keywords: ["smooth", "comfortable", "hydrating"],
            items: []
          }
        }
      },
      source: {
        type: "manual-json",
        url: "https://example.com/products/revive-balance-lotion-ex"
      },
      hints: {
        locale: "en-US",
        market: "US"
      }
    });

    const serialized = JSON.stringify(result.schemaMarkup.jsonLd);
    const normalizedUsage = result.diagnostics.normalizedProduct.usage.join("\n");

    expect(normalizedUsage).toContain("apply 2 pumps");
    expect(normalizedUsage).not.toMatch(/delivers 24-hour hydration|Instrumental test|agreed skin felt/i);
    expect(result.content.sections.howToUse).toContain("apply 2 pumps");
    expect(result.content.sections.howToUse).not.toMatch(/delivers 24-hour hydration|Instrumental test|agreed skin felt/i);
    expect(result.content.sections.ingredients).toMatch(/Botanical Complex|Full ingredients/i);
    expect(result.content.sections.ingredients).not.toMatch(/customer-described|review language|routine fit|usage guidance|delivers 24-hour hydration|Instrumental test/i);
    expect(result.content.sections.benefits).not.toMatch(/Instrumental test|routine fit|review language around/i);
    expect(serialized).not.toMatch(/review language around|Product details add/i);
  });
  it("uses OCR sentence insights to enrich effect, ingredient, full ingredient, and schema notes", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "Botanical Renewal Serum",
          description: "A serum with Botanical Actives.",
          category: "Serum",
          benefits: [],
          effects: [],
          ingredients: [],
          usage: ["Apply morning and night after toner."],
          reviews: {
            keywords: [],
            items: []
          },
          sourceExtraction: {
            ocr: {
              sentenceInsights: [
                {
                  imageUrl: "https://example.com/ginseng-peptide.jpg",
                  category: "ingredient",
                  text: "Ginseng Peptide™ is a 6-peptide blend that combines a potent ginseng-extracted peptide with 5 other peptides.",
                  keywords: ["Ginseng Peptide", "peptide"]
                },
                {
                  imageUrl: "https://example.com/ginseng-peptide.jpg",
                  category: "effect",
                  text: "This advanced formula, working synergistically with Botanical Actives, enhances skin firmness, elasticity, and resilience, helping to diminish visible signs of aging.",
                  keywords: ["Botanical Actives", "firmness", "elasticity", "resilience"]
                },
                {
                  imageUrl: "https://example.com/ginseng-peptide.jpg",
                  category: "ingredient",
                  text: "INGREDIENTS: WATER / AQUA / EAU, GLYCERIN, NIACINAMIDE, PANAX GINSENG ROOT EXTRACT, GINSENG PEPTIDE, RETINOL.",
                  keywords: ["NIACINAMIDE", "PANAX GINSENG ROOT EXTRACT", "RETINOL"]
                }
              ]
            }
          }
        }
      },
      hints: {
        locale: "en-US",
        market: "US",
        category: "Serum"
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const additionalProperties = product.additionalProperty as Array<Record<string, any>>;
    const ocrDiagnostics = result.diagnostics.ocrSentences;

    expect(result.content.sections.description).toMatch(/supports|includes|formula|texture|routine|visible benefits|key actives|comfort/);
    expect(result.content.sections.description).not.toContain("This advanced formula, working synergistically");
    expect(result.content.sections.description).not.toContain("concise ingredient/effect claim for product comparison");
    expect(result.content.sections.ingredients).toContain("Ginseng Peptide");
    expect(result.content.sections.ingredients).toContain("Full ingredients: WATER / AQUA / EAU");
    expect(additionalProperties.some((item) => item.name === "Ingredient/effect detail" && /formula|texture|routine|benefit|comfort/.test(String(item.value)))).toBe(true);
    expect(additionalProperties.some((item) => item.name === "Full ingredients")).toBe(false);
    const benefitSurface = `${JSON.stringify(product)} ${result.content.sections.benefits}`;
    expect(product.positiveNotes).toBeUndefined();
    expect(benefitSurface).toContain("skin resilience");
    expect(benefitSurface).toContain("elasticity");
    expect(benefitSurface).toContain("firmness");
    expect(ocrDiagnostics.find((item) => item.text.includes("6-peptide blend"))?.imageUrls).toEqual(["https://example.com/ginseng-peptide.jpg"]);
    expect(JSON.stringify(result.schemaMarkup.jsonLd)).not.toMatch(/ingredient\/effect claim|Citation highlight|citation highlight|benefit terms|ingredient context|use-feel comparison|product discovery context|Product detail context|comparison intent|comparison-led|texture language|use-feel language|benefit language|ingredient terms|ingredient and technology term|product benefit term/i);
  });
  it("classifies raw OCR image text into varied Korean ingredient and benefit schema content", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "예시더마 배리어케어365 하이드로 수딩크림",
          description: "민감하고 수분이 부족한 지성 피부를 위한 수딩 크림입니다.",
          brand: "EXAMPLEDERMA",
          category: "Cream",
          usage: ["아침과 저녁 스킨케어 마지막 단계에서 얼굴 전체에 부드럽게 펴 바릅니다."],
          reviews: {
            keywords: ["수분감", "산뜻함", "피부결"],
            items: []
          },
          sourceExtraction: {
            ocr: {
              images: [
                {
                  imageUrl: "https://example.com/examplederma-hero.jpg",
                  lines: [
                    "배리어케어365",
                    "하이드로 수딩크림",
                    "민감하고 수분이 부족한 지성 피부의",
                    "유수분 밸런스를 맞추고",
                    "속수분을 채워주는 장벽수분 캡슐크림"
                  ]
                },
                {
                  imageUrl: "https://example.com/examplederma-ingredients.jpg",
                  text: [
                    "압축 히알루론산",
                    "특허 기술로 1/100 사이즈로 압축한",
                    "히알루론산의 흡수 빠른 수분 충전으로",
                    "탁월한 수분 지속 효과",
                    "징크",
                    "피지 조절에 효과적인 징크로",
                    "과잉 유분 컨트롤",
                    "고밀도 세라마이드 캡슐",
                    "길이가 긴 롱체인 세라마이드와",
                    "연결고리를 조여주는 링커 세라마이드로",
                    "민감피부의 짧고 부족한 세라마이드를",
                    "보완해 보다 촘촘하고 견고한 구조의",
                    "캡슐로 장벽 보습"
                  ].join("\n")
                }
              ]
            }
          }
        }
      },
      hints: {
        locale: "ko-KR",
        market: "KR",
        category: "크림"
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const additionalProperties = product.additionalProperty as Array<Record<string, any>>;
    const keyIngredients = additionalProperties.find((item) => item.name === "Key ingredients")?.value;
    const ingredientEffectDetail = additionalProperties.find((item) => item.name === "Ingredient/effect detail")?.value;
    const serialized = JSON.stringify(result.schemaMarkup.jsonLd);
    const ocrDiagnostics = result.diagnostics.ocrSentences;

    expect(product.description).toContain("히알루론산");
    expect(product.description).toMatch(/징크|고밀도 세라마이드 캡슐|피부 장벽|유분 컨트롤|수분감/);
    expect(result.content.sections.quickFacts).toMatch(/히알루론산|징크|세라마이드/);
    expect(result.content.sections.benefits).toMatch(/수분감|유분 컨트롤|피부 장벽/);
    expect(result.content.sections.benefits).toMatch(/1\/100|과잉 유분|롱체인|링커 세라마이드|장벽 보습/);
    expect(result.content.sections.faq).toMatch(/히알루론산|징크|세라마이드/);
    expect(result.content.sections.faq).toMatch(/1\/100|과잉 유분|롱체인|장벽 보습|수분감|유분 컨트롤|피부 장벽/);
    expect(result.content.sections.faq).not.toMatch(/OCR|인용|What does .* explain/);
    expect(result.content.sections.ingredients).toContain("히알루론산");
    expect(result.content.sections.ingredients).toContain("징크");
    expect(result.content.sections.ingredients).toContain("세라마이드");
    expect(String(keyIngredients)).toMatch(/히알루론산|징크|세라마이드/);
    expect(String(ingredientEffectDetail)).toMatch(/수분감|유분 컨트롤|피부 장벽|핵심 포인트|성분 포인트|성분 정보|주요 확인 요소/);
    expect(String(ingredientEffectDetail)).not.toMatch(/성분\/기술은\s*[^.]*맞물려 제품 특징을 구체화합니다/);
    expect(ocrDiagnostics.some((item) => item.text === "압축 히알루론산. 특허 기술로 1/100 사이즈로 압축한 히알루론산의 흡수 빠른 수분 충전으로 탁월한 수분 지속 효과")).toBe(true);
    expect(ocrDiagnostics.some((item) => item.text === "징크. 피지 조절에 효과적인 징크로 과잉 유분 컨트롤")).toBe(true);
    expect(ocrDiagnostics.some((item) => item.text === "고밀도 세라마이드 캡슐. 길이가 긴 롱체인 세라마이드와 연결고리를 조여주는 링커 세라마이드로 민감피부의 짧고 부족한 세라마이드를 보완해 보다 촘촘하고 견고한 구조의 캡슐로 장벽 보습")).toBe(true);
    expect(ocrDiagnostics.some((item) => item.text.includes("압축 히알루론산") && item.intents.includes("ingredient") && item.intents.includes("effect"))).toBe(true);
    expect(ocrDiagnostics.some((item) => item.text.includes("징크") && item.schemaFields.includes("content.sections.benefits"))).toBe(true);
    expect(ocrDiagnostics.some((item) => item.text.includes("고밀도 세라마이드 캡슐") && item.geoUse === "ingredient_effect_evidence")).toBe(true);
    expect(ocrDiagnostics.find((item) => item.text.includes("압축 히알루론산"))?.imageUrls).toEqual(["https://example.com/examplederma-ingredients.jpg"]);
    expect(ocrDiagnostics.every((item) => item.text.length > 0 && item.schemaFields.length > 0 && item.geoUse.length > 0)).toBe(true);
    expect(serialized).not.toMatch(/효능어|성분어|사용감어|성분 구성, 기대 효능, 사용감 차이|함께 보여줍니다|제품 탐색 문맥|탐색 문맥에서/);
  });
  it("reconstructs English OCR heading and body lines as semantic sentences", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "Barrier Hydro Cream",
          description: "A lightweight cream for hydration and skin barrier support.",
          brand: "EXAMPLEDERMA",
          category: "Cream",
          sourceExtraction: {
            ocr: {
              images: [
                {
                  imageUrl: "https://example.com/english-ingredient-panel.jpg",
                  lines: [
                    "Compressed Hyaluronic Acid",
                    "Patented technology compresses hyaluronic acid to 1/100 size",
                    "for fast moisture charging and lasting hydration",
                    "Zinc",
                    "Helps control excess oil and sebum",
                    "High-density Ceramide Capsule",
                    "Long-chain ceramide and linker ceramide help reinforce",
                    "skin barrier moisture for sensitive skin"
                  ]
                }
              ]
            }
          }
        }
      },
      hints: {
        locale: "en-US",
        market: "US",
        category: "Cream"
      }
    });

    const ocrDiagnostics = result.diagnostics.ocrSentences;

    expect(ocrDiagnostics.some((item) => item.text === "Compressed Hyaluronic Acid. Patented technology compresses hyaluronic acid to 1/100 size for fast moisture charging and lasting hydration")).toBe(true);
    expect(ocrDiagnostics.some((item) => item.text === "Zinc. Helps control excess oil and sebum")).toBe(true);
    expect(ocrDiagnostics.some((item) => item.text === "High-density Ceramide Capsule. Long-chain ceramide and linker ceramide help reinforce skin barrier moisture for sensitive skin")).toBe(true);
    expect(ocrDiagnostics.some((item) => item.text.includes("Compressed Hyaluronic Acid") && item.intents.includes("ingredient") && item.intents.includes("benefit"))).toBe(true);
    expect(ocrDiagnostics.find((item) => item.text.includes("Compressed Hyaluronic Acid"))?.imageUrls).toEqual(["https://example.com/english-ingredient-panel.jpg"]);
    expect(ocrDiagnostics.every((item) => !item.text.includes(": Patented technology") && !item.text.includes(": Helps control"))).toBe(true);
    expect(result.content.sections.benefits).toMatch(/Compressed Hyaluronic Acid|Zinc|High-density Ceramide Capsule/);
    expect(result.content.sections.benefits).toMatch(/1\/100|excess oil|Long-chain|barrier moisture/);
    expect(result.content.sections.faq).toMatch(/^Q\..+\nA\..+/s);
    expect(result.content.sections.faq).not.toMatch(/What does .* explain about|OCR|citation/i);
  });
  it("normalizes uppercase self-assessment result fragments before using them in descriptions", async () => {
    const { result } = await generatePdpGeo({
      product: {
        name: "Botanical Renewal Serum",
        description: "A ginseng serum for firmness, elasticity, and fine lines.",
        category: "Serum",
        benefits: ["fine lines and wrinkles", "firmness", "elasticity"],
        effects: [
          "100% AGREED SKIN FEELS FIRMER AND MORE ELASTIC2 100% AGREED SKIN TEXTURE FEELS IMPROVED AND MORE EVEN2 93% AGREED FINE LINES AND WRINKLES FEEL DIMINISHED2 2Self-assessment test conducted 6 weeks after use on 32 women"
        ],
        ingredients: [
          "BOTANICAL ACTIVES (AKA BOTANICAL COMPLEX ™)- Patented ingredient that amplifies the rare and potent anti-aging compounds found in Ginseng",
          "Ginseng Peptide - Helps support the look of skin firmness and elasticity, synergistically enhancing the benefits of Botanical Actives"
        ],
        usage: ["Use morning and night, after applying toner."],
        reviews: {
          keywords: ["smooth", "firmness"]
        }
      },
      source: {
        type: "manual-json",
        url: "https://example.com/products/botanical-renewal-serum"
      },
      hints: {
        locale: "en-US",
        market: "US",
        category: "Serum"
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const webPage = graph.find((node) => (Array.isArray(node["@type"]) ? node["@type"].includes("WebPage") : node["@type"] === "WebPage")) as Record<string, any>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const faq = graph.find((node) => node["@type"] === "FAQPage") as Record<string, any>;
    const serialized = JSON.stringify({ webPage, product, faq });
    const productSerialized = JSON.stringify(product);
    const additionalProperties = new Map(product.additionalProperty.map((item: any) => [item.name, item.value]));
    expect(webPage.description).toContain("Botanical Renewal Serum product page introduces the serum");
    expect(webPage.description).toMatch(/lists Botanical Actives.*Ginseng Peptide.*highlighted formula components.*documents .*product benefits/i);
    expect(webPage.description).not.toMatch(/official test and measurement results/i);
    expect(webPage.description).not.toMatch(/100% of participants|32 women after 6 weeks/i);
    expect(product.description).toContain("Botanical Actives (Botanical Complex)");
    expect(product.description).toContain("Ginseng Peptide");
    expect(product.description).not.toContain("a patented ingredient described as amplifying rare ginseng compounds");
    expect(result.content.sections.howToUse).toContain("Use morning and night, after applying toner");
    expect(product.description).not.toContain("then warm three pumps");
    expect(product.description).not.toContain("Customer reviews mention smooth and firmness");
    expect(product.description).toContain("In a self-assessment of 32 women after 6 weeks of use");
    expect(product.description).toContain("100% of participants agreed that skin felt firmer and more elastic");
    expect(product.description).not.toMatch(/Reported self-assessment|evidence covers|Product details evidence/i);
    expect(product.description).not.toContain("Reported product details include In a");
    expect(product.description).not.toContain("product page");
    expect(product.description).not.toContain("…");
    expect(product.additionalProperty.some((item: any) => item.name === "Quick facts")).toBe(false);
    expect(product.additionalProperty.some((item: any) => /\\n|\n/.test(String(item.value)))).toBe(false);
    expect(additionalProperties.get("Target customer")).toBeUndefined();
    expect(additionalProperties.get("Key benefit")).toBe("fine lines and wrinkles");
    expect(additionalProperties.get("Reported details")).toContain("In a self-assessment of 32 women after 6 weeks of use");
    expect(additionalProperties.get("Reported details")).not.toMatch(/elastic2|even2|diminished2|\(32 women\)/i);
    expect(additionalProperties.get("Key ingredients")).toContain("Botanical Actives (Botanical Complex), Ginseng Peptide");
    expect(product.positiveNotes).toBeUndefined();
    const benefitSurface = `${productSerialized} ${result.content.sections.benefits}`;
    expect(benefitSurface).toContain("fine lines and wrinkles");
    expect(benefitSurface).toContain("firmness");
    expect(benefitSurface).toContain("elasticity");
    expect(productSerialized).not.toContain("AGREED");
    expect(productSerialized).not.toMatch(/Self-assessme…|Strengthen…|GINSENG ACTIVES \(AKA|2Self-assessment|elastic2|even2|diminished2|\(32 women\)/i);
    expect(productSerialized).not.toContain("\\n");
    expect(serialized).not.toContain("AGREED");
    expect(serialized).not.toMatch(/Self-assessme…|Strengthen…|GINSENG ACTIVES \(AKA|2Self-assessment|elastic2|even2|diminished2|\(32 women\)/i);
  });
  it("cleans Korean ExampleDerma-style OCR, review typos, and property chunks before schema generation", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "예시더마 배리어케어365 하이드로 수딩크림",
          description: "민감 피부를 위한 산뜻한 수분 크림입니다.",
          brand: "EXAMPLEDERMA",
          category: "Cream",
          benefits: [
            "hydration",
            "리뉴얼 전 제품에서 고객님들이 만족하셨던 속성 (수분감, smooth texture, 피부결",
            "리뉴얼 전 제품에서 고객님들이 만족하셨던 속성 (수분감, 쿨링, 붉은기 개선, 저자극)은 유지 또는 더 강화되었습니다.여기에 핵심 기능인 수분과 장벽 개선을 위해 압축 히알루론산, 고밀도 세라마이드 캡슐이 더해졌고 민감 피부를 위한 안전성 테스트도 강화하였습니다.",
            "쿨링 효과는 어떤 성분이 해주는 것인가요?",
            "쿨링을 주는 화학적 성분은 자칫 피부에 자극을 줄 수 있기 때문에 수분감을 높인 워터 크림 특화 제형을 통해 피부에 닿음과 동시에 시원하고 산뜻한 쿨링감을 줄 수 있게 설계되었습니다.",
            "각 크림에는 피부타입과 피부고민을 고려한 최적의 함량의 캡슐이 함유되어 있습니다.캡슐은 우리 피부 지질과 유사성분/구조로 이루어져 있으며 캡슐 형태이기 때문에 손상된 피부장벽 빈틈을 오래 잡아주며 장벽을 튼튼하게 강화시켜줍니다."
          ],
          effects: [
            "쿨링을 주는 화학적 성분은 자칫 피부에 자극을 줄 수 있기 때문에 수분감을 높인 워터 크림 특화 제형을 통해 피부에 닿음과 동시에 시원하고 산뜻한 쿨링감을 줄 수 있게 설계되었습니다."
          ],
          ingredients: [
            "쿨링을 주는 화학적 성분은 ... 설계되었습니다.",
            "두 크림에 함유된 캡슐은 자사의 특허 성분인 ‘고밀도 세라마이드 캡슐’로 동일합니다.",
            "배리어케어365 크림에 함유된 캡슐과 동일한 캡슐인가요?",
            "캡슐이 있어서 좋은 이유는 무엇인가요?",
            "각 크림에는 피부타입과 피부고민을 고려한 최적의 함량의 캡슐이 함유되어 있습니다.캡슐은 우리 피부 지질과 유사성분/구조로 이루어져 있으며 캡슐 형태이기 때문에 손상된 피부장벽 빈틈을 오래 잡아주며 장벽을 튼튼하게 …",
            "히알루론산"
          ],
          usage: [
            "아침과 저녁 스킨케어 마지막 단계에서 얼굴 전체에 부드럽게 펴 바릅니다.",
            "여드름성 피부가 사용해도 괜찮은가요?",
            "여드름성 피부 사용적합 테스트인 논코메도제닉 테스트를 완료한 제품입니다.",
            "영유아나 임산부가 사용해도 되나요?",
            "소아과 피부 테스트를 진행한 품목으로 영유아, 어린이가 사용해도 무방하며, 임산부가 우려할 만한 성분도 함유되어 있지 않습니다.다만 우려가 되는 경우 연약한 피부 부위(귀 뒤, 팔 안쪽 등)에 먼저 테스트 후 사용하시고 필요 시, 전문가와 상담 후 사용하시기 바랍니다."
          ],
          metrics: [
            "배리어케어365 크림에 함유된 캡슐과 동일한 캡슐인가요?",
            "https://images.example.com/fileupload/reviews/2026/06/18/JPEG_20260618_223402_review-example.jpg?format=webp"
          ],
          reviews: {
            keywords: ["피부결", "만족합니다", "촉촉하고", "보습력도", "smooth texture"],
            items: [
              {
                body: "예시더마는 그냥 너무 좋아요 많은 말도 필요없고 속단김이나 건조함 잡는데는 정말 좋나요 메이크업 전에 무거운 베이스가 싫은데 예시더마는 아주 가벼우면서도 건조함을 잘 채워줘서 좋어요 모든 베이스 라인을 다 예시더마로 바꿀 정도니까 말할것도 없네요 리뉴널 욘기조 너무 예뻐요 만족합니다",
                rating: 5
              },
              { body: "믿고 쓰는 브랜드 피부에 수분감이 많아서 좋아요", rating: 5 },
              { body: "너무 좋아요, 촉촉하고, 향도 무향이고, 보습력도 정말 좋아요!", rating: 5 }
            ]
          }
        }
      },
      source: {
        type: "pdp-extractor",
        url: "https://example.com/web/product/view.do?prdSeq=1148"
      },
      hints: {
        locale: "ko-KR",
        market: "KR"
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const webPage = graph.find((node) => (Array.isArray(node["@type"]) ? node["@type"].includes("WebPage") : node["@type"] === "WebPage")) as Record<string, any>;
    const additionalProperties = product.additionalProperty as Array<Record<string, any>>;
    const keyIngredients = additionalProperties.find((item) => item.name === "Key ingredients")?.value;
    const reportedDetails = additionalProperties.find((item) => item.name === "Reported details")?.value;
    const usageContext = additionalProperties.find((item) => item.name === "Usage")?.value;
    const reviewUseFeelContext = additionalProperties.find((item) => item.name === "Customer review context")?.value;
    const reviewBodies = product.review.map((review: any) => review.reviewBody).join(" ");
    const serialized = JSON.stringify(result.schemaMarkup.jsonLd);
    const normalized = result.diagnostics.normalizedProduct;

    expect(result.content.sections.productName).toBe("예시더마 배리어케어365 하이드로 수딩크림");
    expect(product.name).toBe("예시더마 배리어케어365 하이드로 수딩크림");
    expect(product.category).toBe("크림");
    expect(webPage.description).toContain("예시더마 배리어케어365 하이드로 수딩크림 상품 페이지는 EXAMPLEDERMA가 선보이는");
    expect(webPage.description).toMatch(/예시더마 배리어케어365 하이드로 수딩크림은[^.]*민감 피부 고객을 위한 제품/u);
    expect(webPage.description).toMatch(/세라마이드[^.]*히알루론산[^.]*주요 성분·기술로 포함하고[^.]*돕습니다/u);
    expect(webPage.description).toMatch(/수분 케어/u);
    expect(webPage.description).toMatch(/피부 장벽 케어/u);
    expect(webPage.description).not.toMatch(/페이지 본문에서는|페이지에서 확인할 수 있는|페이지에 공개된/u);
    expect(product.description).toMatch(/수분감|수분\s*케어/u);
    expect(product.description).toMatch(/세라마이드|히알루론산/);
    expect(product.description).toMatch(/실제 고객 리뷰에서 고객들은[^.]*긍정적으로 평가했습니다/);
    expect(product.description).not.toMatch(/리뷰에서는[^.]*(?:반복|언급됩니다)/u);
    expect(product.description).not.toMatch(/핵심 성분\/기술|사용감 표현/);
    expect(product.description).not.toContain("\", \"");
    expect(product.description).not.toContain("대표 고객 리뷰에서는 \"");
    expect(product.description).not.toMatch(/성분 구성, 기대 효능, 사용감 차이|함께 보여줍니다|효능어|성분어|사용감어|제품 탐색 문맥|탐색 문맥에서|효능과 사용감 차이를 설명하는 기준|연결해 확인할 수 있습니다|확인된 결과\/정보에 따르면|확인된 상품 정보에 따르면|핵심 케어 근거|합니다입니다|습니다입니다|입니다입니다|설명합니다를|근거 설명합니다|찾은 고객|\. 에 초점/);
    expect(result.content.sections.quickFacts).toMatch(/주요 성분|비교할 때|고객 리뷰/);
    expect(result.content.sections.quickFacts).not.toMatch(/사용 맥락|검색\/비교 맥락|성분\/효능 포인트|Use context|Search context|Ingredient\/effect detail/i);
    expect(result.content.sections.benefits).toMatch(/선택 기준|사용감 판단|핵심 효능|루틴|체감 장점|뒷받침/);
    expect(result.content.sections.benefits).toContain("사용감 판단");
    expect(result.content.sections.benefits).not.toMatch(/케어 케어|설명은/);
    expect(result.content.sections.ingredients).toMatch(/고밀도 세라마이드 캡슐|히알루론산|수분감|피부 장벽|리뷰 표현|루틴/);
    // The plain "주요 효능·효과" benefit question merges into the composition
    // question when there is no separate clinical/assessment evidence to
    // anchor a distinct question, so also accept the merged wording here.
    expect(result.content.sections.faq).toMatch(/추천할 수 있는 크림|성분\/기술이 포함되어 있습니다|주요 효능|구성 성분과 효능/);
    expect(result.content.sections.faq).not.toMatch(/상품 상세의|상품 상세 근거/);
    expect(result.content.sections.faq).toMatch(/수분 케어|피부 장벽 관리|유분 컨트롤|피부 고민/);
    expect(result.content.sections.faq).not.toMatch(/성분 설명은|확인 키워드|성분 역할, 수분감, 사용감, 피부 고민 선택 기준|포인트입니다 결과|성분 근거와 효능 맥락|성분 역할과 기대 효능의 비교 기준을 제시합니다|What does|OCR|인용/);
    expect((graph.find((node) => node["@type"] === "FAQPage")?.mainEntity ?? []).length).toBeLessThanOrEqual(8);
    expect(result.content.sections.faq).not.toMatch(/속단김|리뉴널 욘기조|대표 고객 리뷰에서는|약품\s*냄새|아쉬운/);
    expect(keyIngredients).toContain("세라마이드");
    expect(keyIngredients).toContain("히알루론산");
    expect(keyIngredients).not.toContain("쿨링을 주는 화학적 성분");
    expect(additionalProperties.some((item) => item.name === "Search intent context")).toBe(false);
    expect(usageContext).toMatch(/아침과 저녁|스킨케어|펴 바릅니다/);
    expect(reviewUseFeelContext).toContain("사용감");
    expect(String(reportedDetails ?? "")).not.toContain("인가요");
    expect(reviewBodies).toContain("속단김");
    expect(reviewBodies).toContain("좋아요");
    expect(reviewBodies).toContain("리뉴널 욘기조");
    expect(product.positiveNotes).toBeUndefined();
    expect(normalized.benefits.join(" ")).not.toMatch(/쿨링 효과는 어떤 성분|각 크림에는|리뉴얼 전 제품에서 고객님들이 만족/);
    expect(normalized.effects.join(" ")).not.toMatch(/쿨링 효과는 어떤 성분/);
    expect(normalized.ingredients.join(" ")).not.toMatch(/쿨링 효과는 어떤 성분|배리어케어365 크림에 함유된 캡슐과 동일한 캡슐인가요|캡슐이 있어서 좋은 이유는 무엇인가요|^성분$/);
    expect(normalized.usage.join(" ")).not.toMatch(/여드름성 피부가 사용해도 괜찮은가요|영유아나 임산부가 사용해도 되나요|논코메도제닉 테스트를 완료/);
    expect(normalized.usage).toEqual(["아침과 저녁 스킨케어 마지막 단계에서 얼굴 전체에 부드럽게 펴 바릅니다."]);
    expect(normalized.faq.some((item) => item.question === "쿨링 효과는 어떤 성분이 해주는 것인가요?" && item.answer.includes("시원하고 산뜻한 쿨링감"))).toBe(true);
    expect(normalized.faq.some((item) => item.question === "여드름성 피부가 사용해도 괜찮은가요?" && item.answer.includes("논코메도제닉 테스트"))).toBe(true);
    expect(result.diagnostics.ocrSentences.every((item) => !/문장입니다|재구성합니다|활용합니다/.test(item.geoUse))).toBe(true);
    expect(serialized).not.toMatch(/images\.example|fileupload\/reviews|인용 포인트|Citation highlight|성분 구성, 기대 효능, 사용감 차이|함께 보여줍니다|효능어|성분어|사용감어|제품 탐색 문맥|탐색 문맥에서|효능과 사용감 차이를 설명하는 기준|연결해 확인할 수 있습니다|확인된 결과\/정보에 따르면|확인된 상품 정보에 따르면|핵심 케어 근거|성분\/기술은\s*[^.]*맞물려 제품 특징을 구체화합니다|…|\.{3,}|hydration Cream|smooth texture|property value|합니다입니다|설명합니다를|근거 설명합니다|찾은 고객|\. 에 초점/i);
    expect(additionalProperties.every((item) => !String(item.value).endsWith("?"))).toBe(true);
  });
  it("keeps measured Korean results without inventing undisclosed sample metadata", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "예시더마 배리어케어365 캡슐 토너",
          brand: "EXAMPLEDERMA",
          category: "토너",
          description: "민감 피부를 위한 고보습 진정 토너입니다.",
          ingredients: ["고밀도 세라마이드 캡슐", "PHA 워터"],
          benefits: ["피부 장벽 강화", "보습"],
          effects: [
            "Tape Stripping 테스트에서 외부자극에 의한 장벽 손상은 사용 직후 60.5%, 사용 7일 후 87.3% 회복된다고 제시됩니다."
          ],
          usage: ["손바닥에 적당량을 덜어 얼굴 전체에 가볍게 펴 바릅니다"]
        }
      },
      source: {
        type: "rest-api",
        url: "https://example.com/web/product/view.do?prdSeq=1149"
      },
      hints: {
        locale: "ko-KR",
        market: "KR"
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const reportedDetails = product.additionalProperty.find((item: Record<string, any>) => item.name === "Reported details");

    expect(reportedDetails.value).toContain("사용 직후 60.5%");
    expect(reportedDetails.value).toContain("사용 7일 후 87.3%");
    expect(reportedDetails.value).not.toMatch(/시험 대상\/표본 수|확인되지|미공개/);
    expect(reportedDetails.value).not.toMatch(/사용 직후는|사용 7일 후는|제시됩니다|나타났습니다/);
  });
  it("validates field evidence contracts after generation without product-specific blocks", () => {
    const repaired = validateAndRepairPdpGeoArtifacts({
      locale: "en-US",
      fallbackProductName: "Adaptive Barrier Cream",
      fallbackDescription: "Adaptive Barrier Cream supports barrier care and hydration.",
      schemaMarkup: {
        jsonLd: {
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "Product",
              name: "Adaptive Barrier Cream",
              description: "Adaptive Barrier Cream supports barrier care and hydration."
            },
            {
              "@type": "HowTo",
              name: "How to use Adaptive Barrier Cream",
              step: [
                {
                  "@type": "HowToStep",
                  position: 1,
                  text: "Adaptive Barrier Cream improves hydration by 96% in a 33 participant instrumental test."
                },
                {
                  "@type": "HowToStep",
                  position: 2,
                  text: "Apply a thin layer to clean skin morning and night."
                }
              ]
            }
          ]
        },
        scriptTag: ""
      },
      content: {
        sections: {
          productName: "Adaptive Barrier Cream",
          description: "Adaptive Barrier Cream supports barrier care and hydration.",
          quickFacts: "Key benefit: barrier care",
          benefits: [
            "- Barrier support",
            "- 96% of 33 participants agreed skin looked more hydrated after an instrumental test."
          ].join("\n"),
          ingredients: [
            "- Ceramide complex supports the formula story.",
            "- review language around smooth, moisturized skin",
            "- routine fit: Apply after toner."
          ].join("\n"),
          howToUse: [
            "1. Adaptive Barrier Cream improves hydration by 96% in a 33 participant instrumental test.",
            "2. Apply a thin layer to clean skin morning and night."
          ].join("\n"),
          faq: "Q. What does Adaptive Barrier Cream support?\nA. It supports barrier care and hydration."
        },
        html: "<div class=\"geo-content-accordion\"></div>"
      }
    });

    const graph = repaired.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const howTo = graph.find((node) => node["@type"] === "HowTo") as Record<string, any>;
    const howToStepText = JSON.stringify(howTo?.step ?? repaired.content.sections.howToUse);

    expect(howToStepText).toContain("Apply a thin layer to clean skin morning and night.");
    expect(howToStepText).not.toMatch(/instrumental test|96%|33 participant/i);
    expect(repaired.content.sections.howToUse).toContain("Apply a thin layer to clean skin morning and night.");
    expect(repaired.content.sections.howToUse).not.toMatch(/instrumental test|96%|33 participant/i);
    expect(repaired.content.sections.ingredients).toContain("Ceramide complex supports the formula story.");
    expect(repaired.content.sections.ingredients).not.toMatch(/review language around|routine fit|Apply after toner/i);
    expect(repaired.content.sections.benefits).toContain("Barrier support");
    expect(repaired.content.sections.benefits).not.toMatch(/instrumental test|96%|33 participant/i);
    expect(repaired.validationRepairs.some((repair) => repair.source === "field-contract-validator" && repair.field === "HowTo.step.text")).toBe(true);
    expect(repaired.validationRepairs.some((repair) => repair.source === "field-contract-validator" && repair.field === "content.sections.howToUse")).toBe(true);
    expect(repaired.validationRepairs.some((repair) => repair.source === "field-contract-validator" && repair.field === "content.sections.ingredients")).toBe(true);
    expect(repaired.validationRepairs.some((repair) => repair.source === "field-contract-validator" && repair.field === "content.sections.benefits")).toBe(true);
  });
});
