import { describe, expect, it } from "vitest";
import { generatePdpGeo } from "../src";
import { validateAndRepairPdpGeoArtifacts } from "../src/validate";

/**
 * 사용법 — HowTo 단계 자격, 원문 순서·분량 보존, 사용법과 그 밖의 문장 분리.
 *
 * generate-pdp-geo.test.ts에서 주제별로 분리했다(어서션은 그대로).
 */

describe("generatePdpGeo", () => {
  it("recovers Korean HowTo steps from source text blocks when usage is polluted by product copy", async () => {
    const marketingCopy = "피부 장벽 유사 성분을 담은 캡슐 민감 피부 고보습 장벽 토너 바르는 순간 개운한 ‘보습 장벽’ 케어 무너진 피부장벽과 속건조 개선에 도움 피부 장벽 유사 성분을 담은 캡슐 토너 세라마이드 캡슐 세라마이드";
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "예시더마 모이베리어365 캡슐 토너",
          description: "민감하고 건조한 피부를 위한 장벽 보습 캡슐 토너입니다.",
          brand: "EXAMPLEDERMA",
          category: "토너",
          benefits: ["피부 장벽", "속보습 개선"],
          ingredients: ["고밀도 세라마이드 캡슐", "PHA 워터"],
          usage: [marketingCopy],
          sourceTexts: [
            "사용법",
            "손바닥에 적당량을 덜어줍니다.",
            "피부결을 따라 부드럽게 펴 발라준 뒤 가볍게 두드려 흡수시켜 줍니다."
          ]
        }
      },
      source: {
        type: "pdp-extractor",
        url: "https://shop.example.com/web/product/view.do?prdSeq=1149"
      },
      hints: {
        locale: "ko-KR",
        market: "KR"
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const howTo = graph.find((node) => node["@type"] === "HowTo") as Record<string, any>;
    const properties = Object.fromEntries((product.additionalProperty as Array<Record<string, any>>).map((item) => [item.name, item.value]));
    const howToText = JSON.stringify(howTo?.step ?? properties.Usage ?? result.content.sections.howToUse);

    expect(howToText).toContain("손바닥에 적당량");
    expect(howToText).toContain("피부결을 따라");
    expect(howToText).not.toContain("피부 장벽 유사 성분");
    expect(String(properties.Usage)).toContain("손바닥에 적당량");
    expect(String(properties.Usage)).toContain("피부결을 따라");
    expect(String(properties.Usage)).not.toContain("피부 장벽 유사 성분");
  });
  it("filters Korean sensory test copy from HowTo candidates while keeping real usage steps", async () => {
    const sensoryCopy = "끈적임 없이 편안한 마무리감 테스트 수분감이 느껴지는 끈적임 없이 산뜻한 촉촉한 느낌 피부가 진정되는 피부결이 부드러운";
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "예시더마 모이베리어365 캡슐 토너",
          description: "민감하고 건조한 피부를 위한 장벽 보습 캡슐 토너입니다.",
          brand: "EXAMPLEDERMA",
          category: "토너",
          benefits: ["피부 장벽", "속보습 개선"],
          ingredients: ["고밀도 세라마이드 캡슐", "PHA 워터"],
          usage: [
            sensoryCopy,
            "손바닥에 토너를 덜어 피부에 두드리듯 흡수시켜 줍니다.",
            "화장솜에 충분히 적셔 피부결을 따라 닦아줍니다."
          ],
          sourceTexts: [
            "사용법. 1 화장솜에 충분히 적셔 피부결을 따라 닦아줍니다.",
            "2 손바닥에 토너를 덜어 피부에 두드리듯 흡수시켜 줍니다.",
            sensoryCopy
          ]
        }
      },
      source: {
        type: "pdp-extractor",
        url: "https://shop.example.com/web/product/view.do?prdSeq=1149"
      },
      hints: {
        locale: "ko-KR",
        market: "KR"
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const howTo = graph.find((node) => node["@type"] === "HowTo") as Record<string, any>;
    const properties = Object.fromEntries((product.additionalProperty as Array<Record<string, any>>).map((item) => [item.name, item.value]));
    const howToText = JSON.stringify(howTo?.step ?? properties.Usage ?? result.content.sections.howToUse);

    expect(howToText).toContain("손바닥에 토너를 덜어");
    expect(howToText).toContain("화장솜에 충분히 적셔");
    expect(howToText).not.toMatch(/끈적임 없이|마무리감 테스트|피부결이 부드러운/);
    expect(String(properties.Usage)).toContain("손바닥에 토너를 덜어");
    expect(String(properties.Usage)).toContain("화장솜에 충분히 적셔");
    expect(String(properties.Usage)).not.toMatch(/끈적임 없이|마무리감 테스트|피부결이 부드러운/);
  });
  it("keeps concise Korean routine usage even when the product type noun is present", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "예시더마 모이베리어365 캡슐 토너",
          description: "민감하고 건조한 피부를 위한 장벽 보습 캡슐 토너입니다.",
          brand: "EXAMPLEDERMA",
          category: "토너",
          benefits: ["피부 장벽", "속보습 개선"],
          ingredients: ["고밀도 세라마이드 캡슐", "PHA 워터"],
          usage: [
            "세안 후 첫 단계에서 토너를 사용합니다."
          ]
        }
      },
      source: {
        type: "pdp-extractor",
        url: "https://shop.example.com/web/product/view.do?prdSeq=1149"
      },
      hints: {
        locale: "ko-KR",
        market: "KR"
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const howTo = graph.find((node) => node["@type"] === "HowTo") as Record<string, any> | undefined;
    const properties = Object.fromEntries((product.additionalProperty as Array<Record<string, any>>).map((item) => [item.name, item.value]));

    expect(howTo?.step).toHaveLength(1);
    expect(result.content.sections.howToUse).toContain("세안 후 첫 단계에서 토너를 사용합니다");
    expect(String(properties.Usage)).toContain("세안 후 첫 단계에서 토너를 사용합니다");
  });
  it("keeps Korean HowTo steps limited to actionable cleanser directions", async () => {
    const reviewLikeUsage = "약산성 버블폼은 다 괜찮겠지하는 마음으로 타 제품 사용했었는데 시간이 조금 지나고 나면 건조하더라구요";
    const reviewPurchaseNarrative = "초등학생 딸이 선크림을 바르기 시작하면서 필요해서 구매했어요";
    const reviewExpectation = "wlsk7622 2026-06-23. 배송 빠르고 포장도 꼼꼼하게 잘 도착했네요! 아주 저렴한 가격에 득템한 것 같아서 쓰기 전부터 기분이 정말 좋습니다. 아직 본격적으로 사용해 보지는 않았는데 워낙 평이 좋아서 기대가 많이 되네요";
    const safetyTestClaim = "소아와 피부 테스트 완료 민감피부대상 사용성 테스트 완료 민감피부대상 피부자극 테스트 완료 안자극대체 시험 완료 하이포알러지 테스트 완료 논코메도제닉 테스트 완료";

    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "젠틀 포밍클렌저",
          description: "민감 피부를 위한 젠틀 포밍 클렌저입니다.",
          category: "클렌저",
          benefits: ["저자극 세안", "피부 장벽"],
          usage: [
            "적당량을 펌핑하여 젖은 손에 덜어내어 거품내세요",
            reviewLikeUsage,
            reviewPurchaseNarrative,
            reviewExpectation,
            "얼굴 전체에 마사지한 뒤 미온수로 깨끗하게 헹구어 마무리해 주세요",
            safetyTestClaim
          ],
          sourceTexts: [
            reviewLikeUsage,
            reviewPurchaseNarrative,
            reviewExpectation,
            safetyTestClaim
          ]
        }
      },
      hints: {
        locale: "ko-KR",
        market: "KR",
        category: "클렌저"
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const howTo = graph.find((node) => node["@type"] === "HowTo");

    // The source never numbered the directions, so both actionable ones are
    // published as a single step and the review narratives stay out.
    expect(howTo?.step).toHaveLength(1);
    expect(JSON.stringify(howTo?.step)).not.toMatch(/타 제품 사용했었는데|초등학생 딸이 선크림|배송 빠르고 포장/u);
    expect(result.diagnostics.contentPlan?.howTo.ordered).toBe(false);
    expect(result.content.sections.howToUse).toContain("적당량을 펌핑하여 젖은 손에 덜어내어 거품내세요");
    expect(result.content.sections.howToUse).toContain("얼굴 전체에 마사지한 뒤 미온수로 깨끗하게 헹구어 마무리해 주세요");
    expect(result.content.sections.howToUse).not.toContain("타 제품 사용했었는데");
    expect(result.content.sections.howToUse).not.toContain("초등학생 딸이 선크림");
    expect(result.content.sections.howToUse).not.toContain("배송 빠르고 포장");
    expect(result.content.sections.howToUse).not.toContain("워낙 평이 좋아서");
    expect(result.content.sections.howToUse).not.toContain("사용성 테스트 완료");
  });
  it("keeps Korean body lotion HowTo steps limited to actual use directions", async () => {
    const actualUsage = [
      "샤워 후 수분끼가 남아 있을 때 사용해 주세요.",
      "부드럽게 마사지하듯 펴 발라주며 흡수시켜 주세요"
    ];
    const noisyUsage = [
      ...actualUsage,
      "모이베리어® 바디로션 건조로 민감해진 피부장벽 강화에 도움을 주는 고밀착 바디로션 POINT · 부드럽고 빠른 흡수성 · 끈적임 없는 산뜻한 사용감 · 보습·탄력 케어 초미세세라마이드™",
      "발림성이 가볍고 피부에 빠르게 흡수되는 밀크 타입의 바디 로션",
      "눈으로 확인하는 촉촉하고 꽉 찬 수분의 힘 사용 전"
    ];

    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "예시더마 모이베리어365 바디로션",
          description: "건조로 민감해진 피부장벽을 강화하여 하루종일 촉촉함을 유지시켜주는 고보습 바디로션",
          category: "바디로션",
          benefits: ["피부 장벽", "보습", "탄력"],
          ingredients: ["초미세세라마이드™", "글루코사민"],
          usage: noisyUsage,
          sourceTexts: [
            "초미세 세라마이드™ 추천 피부 타입 바디 보습 피부 사용법 1 샤워 후 수분끼가 남아 있을 때 사용해 주세요. 2 부드럽게 마사지하듯 펴 발라주며 흡수시켜 주세요.",
            ...noisyUsage
          ],
          semanticFacts: {
            usageSteps: noisyUsage
          }
        }
      },
      source: {
        type: "pdp-extractor",
        url: "https://shop.example.com/web/product/view.do?prdSeq=1086"
      },
      hints: {
        locale: "ko-KR",
        market: "KR",
        category: "바디로션"
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const howTo = graph.find((node) => node["@type"] === "HowTo") as Record<string, any>;
    const usageContext = (product.additionalProperty as Array<Record<string, any>>)
      .find((item) => item.name === "Usage")?.value as string;
    const howToText = JSON.stringify(howTo?.step ?? result.content.sections.howToUse);
    const normalizedUsage = result.diagnostics.normalizedProduct.usage.join("\n");

    expect(howTo?.step ?? result.content.sections.howToUse.split(/\n+/).filter(Boolean)).toHaveLength(2);
    expect(howToText).toContain("샤워 후 수분끼가 남아 있을 때 사용해 주세요");
    expect(howToText).toContain("부드럽게 마사지하듯 펴 발라주며 흡수시켜 주세요");
    expect(howToText).not.toMatch(/부드럽고 빠른 흡수성|밀크 타입|수분의 힘 사용 전/);
    expect(usageContext).toContain("샤워 후 수분끼가 남아 있을 때 사용해 주세요");
    expect(usageContext).toContain("부드럽게 마사지하듯 펴 발라주며 흡수시켜 주세요");
    expect(usageContext).not.toMatch(/부드럽고 빠른 흡수성|밀크 타입|수분의 힘 사용 전/);
    expect(result.content.sections.howToUse).not.toMatch(/부드럽고 빠른 흡수성|밀크 타입|수분의 힘 사용 전/);
    expect(normalizedUsage).not.toMatch(/부드럽고 빠른 흡수성|밀크 타입|수분의 힘 사용 전/);
  });
  it("deduplicates malformed Korean Usage property step markers", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "예시더마 모이베리어365 바디로션",
          description: "건조 피부를 위한 고보습 바디로션입니다.",
          category: "바디로션",
          benefits: ["보습 케어"],
          ingredients: ["세라마이드"],
          usage: [
            "샤워 후 손바닥에 적당량 덜어주세요",
            ". 1 샤워 후 손바닥에 적당량 덜어주세요"
          ]
        }
      },
      hints: {
        locale: "ko-KR",
        market: "KR",
        category: "바디로션"
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const usageValue = String((product.additionalProperty as Array<Record<string, any>>)
      .find((item) => item.name === "Usage")?.value ?? "");

    expect(usageValue).toBe("샤워 후 손바닥에 적당량 덜어주세요");
    expect(usageValue).not.toMatch(/2단계|\. 1|;\s*/);
  });
  it("keeps HowTo usage scoped to the current product when extractor text includes related ritual products", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "Gentle Cleansing Foam",
          description: "A soft lathering cleanser for clean, hydrated-feeling skin.",
          brand: "ExampleLuxe",
          category: "Cleansing Foam",
          benefits: ["hydration", "removes impurities"],
          ingredients: ["Hydro-cleansing formula"],
          usage: [
            "Step 1 Dispense 2-3 pumps of GENTLE CLEASING OIL onto dry hands and gently massage onto dry face.",
            "Gently massage with a rolling motion and melt makeup away.",
            "Step 2 Dispense a dime-sized amount of GENTLE CLEANSING FOAM onto wet palms and lather with water.",
            "Massage foam onto face and rinse with lukewarm water."
          ],
          reviews: {
            keywords: ["gentle", "clean"],
            items: []
          }
        }
      },
      source: {
        type: "pdp-extractor",
        url: "https://example.com/products/gentle-cleansing-foam"
      },
      hints: {
        locale: "en-US",
        market: "US"
      }
    });

    const serialized = JSON.stringify(result.schemaMarkup.jsonLd);
    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const howTo = graph.find((node) => node["@type"] === "HowTo") as Record<string, any> | undefined;
    const howToText = result.content.sections.howToUse;

    expect(serialized).not.toMatch(/gentle cleas?ing oil/i);
    expect(howTo?.step).toHaveLength(1);
    expect(howToText).toMatch(/gentle cleansing foam|massage foam/i);
    expect(result.content.sections.howToUse).not.toMatch(/gentle cleas?ing oil/i);
    expect(result.content.sections.howToUse).not.toMatch(/melt makeup/i);
    expect(result.diagnostics.normalizedProduct.usage.join("\n")).not.toMatch(/gentle cleas?ing oil/i);
    expect(result.diagnostics.normalizedProduct.usage.join("\n")).not.toMatch(/melt makeup/i);
  });
  it("omits unmarked multiple usage notes after product scoping", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "Hydra Barrier Cream",
          description: "A daily cream for dry skin and moisture barrier support.",
          brand: "Agentic Beauty",
          category: "Cream",
          benefits: ["hydration", "barrier support"],
          ingredients: ["Ceramide", "Niacinamide"],
          usage: [
            "Apply Brightening Serum to clean skin.",
            "Massage until absorbed.",
            "Apply Hydra Barrier Cream as the final moisturizing step.",
            "Pat gently until absorbed."
          ],
          reviews: {
            keywords: ["hydrating", "comfortable"],
            items: []
          }
        }
      },
      source: {
        type: "manual-json",
        url: "https://example.com/products/hydra-barrier-cream"
      },
      hints: {
        locale: "en-US",
        market: "US"
      }
    });

    const serialized = JSON.stringify(result.schemaMarkup.jsonLd);
    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const usage = result.diagnostics.normalizedProduct.usage.join("\n");

    expect(serialized).not.toMatch(/brightening serum/i);
    expect(usage).not.toMatch(/brightening serum|massage until absorbed/i);
    // Out-of-scope product directions are removed before HowTo is composed.
    expect(JSON.stringify(graph.find((node) => node["@type"] === "HowTo"))).not.toMatch(/brightening serum|massage until absorbed/i);
    expect(result.content.sections.howToUse).toContain("Apply Hydra Barrier Cream as the final moisturizing step");
    expect(result.content.sections.howToUse).toContain("Pat gently until absorbed");
  });
  it("keeps a single usage note visible without misclassifying it as HowTo and builds evidence-backed FAQ", async () => {
    const { result } = await generatePdpGeo({
      product: {
        name: "Ginseng Barrier Serum",
        description: "Daily serum for hydration and skin barrier care.",
        category: "Serum",
        benefits: ["hydration", "skin barrier support"],
        ingredients: ["Niacinamide", "Panax Ginseng Root Extract"],
        usage: ["Apply morning and night after serum."],
        faq: [
          {
            question: "Can I use it daily?",
            answer: "Apply morning and night after serum."
          }
        ],
        reviews: {
          rating: 4.7,
          reviewCount: 128,
          keywords: ["absorbs quickly", "hydration"]
        }
      },
      hints: {
        locale: "en-US",
        market: "US",
        category: "Serum"
      },
      rag: {
        maxChunks: 10,
        scoreThreshold: 0,
        documents: [
          {
            name: "geo-answer-composition_v1.md",
            content: [
              "# GEO Answer Composition",
              "",
              "- Reconstruct PDP content into answer-ready FAQ and stepwise HowTo sections.",
              "- Compose benefit statements from target customer, product identity, ingredient or technology, benefit/effect or metric, and high-level usage/review context.",
              "- Keep claims grounded in source facts and make generated answers easy to synthesize."
            ].join("\n")
          }
        ]
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const howTo = graph.find((node) => node["@type"] === "HowTo") as Record<string, any> | undefined;
    const faq = graph.find((node) => node["@type"] === "FAQPage") as Record<string, any>;
    const serialized = JSON.stringify(result.schemaMarkup.jsonLd);

    expect(result.content.sections.howToUse).toContain("Apply morning and night after serum");
    expect(result.content.sections.howToUse).not.toContain("hydration");
    // A single usage direction has no order to show, so it stays a plain
    // sentence instead of an always-"1."-prefixed one-item list.
    expect(result.content.sections.howToUse.trim()).toBe("Apply morning and night after serum");
    expect(result.content.sections.faq).toMatch(/Customer reviews|Positive reviews/u);
    expect(result.content.sections.faq).toContain("Niacinamide");
    expect(result.content.sections.faq).not.toContain("Product details");
    expect(result.content.sections.faq).not.toContain("Product detail context");
    expect(result.content.sections.faq).not.toContain("Available product information");
    expect(result.content.sections.faq).not.toContain("Evidence signal");
    expect(result.content.sections.faq).not.toContain("Review signals");
    expect(serialized).not.toMatch(/Evidence signal|Review signals|technology signals|main benefit signal|benefit terms|ingredient context|use-feel comparison|product discovery context|Product detail context|comparison intent|comparison-led|texture language|use-feel language|benefit language|ingredient terms|ingredient and technology term|product benefit term/i);
    expect(result.content.sections.faq).not.toContain("Can I use it daily?");
    expect(result.content.sections.faq).not.toContain("A. Apply morning and night after serum.");
    expect(howTo?.step).toHaveLength(1);
    const usageFaq = faq.mainEntity.find((item: any) => item.name === "How should Ginseng Barrier Serum be used?");
    expect(usageFaq).toBeTruthy();
    expect(String(usageFaq?.acceptedAnswer?.text ?? "")).toContain("Apply morning and night after serum");
    expect(faq.mainEntity.some((item: any) => item.name === "Can I use it daily?")).toBe(false);
    expect(faq.mainEntity.some((item: any) => /Customer reviews|reviews mention|comfort and finish/iu.test(
      `${String(item.name)} ${String(item.acceptedAnswer?.text ?? "")}`
    ))).toBe(true);
    expect(result.diagnostics.evidence.some((item) => item.field === "rag.geoOptimizationGuidance")).toBe(true);
    expect(result.diagnostics.recommendations.some((item) => item.field === "faq")).toBe(true);
    expect(result.diagnostics.ragUsage.length).toBeGreaterThan(0);
    expect(result.diagnostics.ragUsage.some((item) => item.principle === "answer-ready FAQ" && item.references.some((reference) => reference.fieldTargets.includes("FAQPage.mainEntity")))).toBe(true);
    expect(result.diagnostics.ragUsage.some((item) => item.principle === "stepwise HowTo" && item.references.some((reference) => reference.fieldTargets.includes("HowTo.step")))).toBe(true);
  });
				  it("repairs Korean HowTo steps with leading particles and duplicate surface variants", () => {
			    const repaired = validateAndRepairPdpGeoArtifacts({
	      locale: "ko-KR",
	      fallbackProductName: "예시더마 모이베리어365 캡슐 토너",
	      fallbackDescription: "예시더마 모이베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다.",
	      schemaMarkup: {
	        jsonLd: {
	          "@context": "https://schema.org",
	          "@graph": [
	            {
	              "@type": "Product",
	              name: "예시더마 모이베리어365 캡슐 토너",
	              description: "예시더마 모이베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다."
	            },
	            {
	              "@type": "HowTo",
	              name: "예시더마 모이베리어365 캡슐 토너 사용법",
	              step: [
	                {
	                  "@type": "HowToStep",
	                  position: 1,
	                  name: "1단계",
	                  text: "은 화장솜에 적당량을 덜어 피부결을 따라 부드럽게 닦아내는 방식입니다"
	                },
	                {
	                  "@type": "HowToStep",
	                  position: 2,
	                  name: "2단계",
	                  text: "화장솜에 적당량을 덜어 피부결을 따라 부드럽게 닦아냅니다"
	                },
	                {
	                  "@type": "HowToStep",
	                  position: 3,
	                  name: "손에 덜어 펴 바르기",
	                  text: "은 손바닥에 덜어 피부결을 따라 부드럽게 펴 바른 뒤 톡톡 두드려 흡수시키는 방식입니다"
	                },
	                {
	                  "@type": "HowToStep",
	                  position: 4,
	                  name: "손에 덜어 펴 바르기",
	                  text: "손바닥에 덜어 피부결을 따라 부드럽게 펴 바른 뒤 톡톡 두드려 흡수시켜 줍니다"
	                }
	              ]
	            }
	          ]
	        },
	        scriptTag: ""
	      },
	      content: {
	        sections: {
	          productName: "예시더마 모이베리어365 캡슐 토너",
	          description: "예시더마 모이베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다.",
	          quickFacts: "핵심 정보",
	          benefits: "보습",
	          ingredients: "고밀도 세라마이드 캡슐",
	          howToUse: "화장솜에 적당량을 덜어 피부결을 따라 부드럽게 닦아냅니다",
	          faq: "Q. 어떤 제품인가요?\nA. 민감 피부를 위한 보습 토너입니다."
	        },
	        html: "<div class=\"geo-content-accordion\"></div>"
	      }
	    });

	    const graph = repaired.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
	    const howTo = graph.find((node) => node["@type"] === "HowTo") as Record<string, any>;
	    const steps = howTo.step as Array<Record<string, any>>;
	    const stepText = JSON.stringify(steps);

		    expect(steps).toHaveLength(2);
		    expect(stepText).not.toMatch(/"text":"은\s/);
		    expect(stepText).toContain("화장솜에 적당량을 덜어 피부결을 따라 부드럽게 닦아내는 방식입니다");
		    expect(stepText).toContain("손바닥에 덜어 피부결을 따라 부드럽게 펴 바른 뒤 톡톡 두드려 흡수시키는 방식입니다");
		    expect(repaired.validationRepairs.some((repair) => repair.source === "field-contract-validator" && repair.field === "HowTo.step.text" && /duplicated/.test(repair.issue))).toBe(true);
		  });
		  it("removes overlapping Korean toner HowTo compound steps covered by following steps", () => {
		    const repaired = validateAndRepairPdpGeoArtifacts({
		      locale: "ko-KR",
		      fallbackProductName: "예시더마 모이베리어365 캡슐 토너",
		      fallbackDescription: "예시더마 모이베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다.",
		      schemaMarkup: {
		        jsonLd: {
		          "@context": "https://schema.org",
		          "@graph": [
		            {
		              "@type": "Product",
		              name: "예시더마 모이베리어365 캡슐 토너",
		              description: "예시더마 모이베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다."
		            },
		            {
		              "@type": "HowTo",
		              name: "예시더마 모이베리어365 캡슐 토너 사용 방법",
		              step: [
		                {
		                  "@type": "HowToStep",
		                  position: 1,
		                  name: "1단계",
		                  text: "은 아침과 저녁 세안 후 적당량을 덜어 캡슐을 부드럽게 녹이듯 골고루 펴 바른 뒤 가볍게 두드려 흡수시키는 방식이다"
		                },
		                {
		                  "@type": "HowToStep",
		                  position: 2,
		                  name: "2단계",
		                  text: "아침, 저녁 세안 후, 적당량의 내용물을 덜어줍니다"
		                },
		                {
		                  "@type": "HowToStep",
		                  position: 3,
		                  name: "3단계",
		                  text: "캡슐을 부드럽게 녹이듯 골고루 펴 바른 후 가볍게 두드려 흡수시켜줍니다"
		                },
		                {
		                  "@type": "HowToStep",
		                  position: 4,
		                  name: "4단계",
		                  text: "골고루 펴 바른 후 가볍게. 두드려 흡수시켜줍니다"
		                }
		              ]
		            }
		          ]
		        },
		        scriptTag: ""
		      },
		      content: {
		        sections: {
		          productName: "예시더마 모이베리어365 캡슐 토너",
		          description: "예시더마 모이베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다.",
		          quickFacts: "핵심 정보",
		          benefits: "보습",
		          ingredients: "고밀도 세라마이드 캡슐",
		          howToUse: "아침과 저녁 세안 후 적당량을 덜어 캡슐을 부드럽게 녹이듯 골고루 펴 바른 뒤 가볍게 두드려 흡수시킵니다",
		          faq: "Q. 어떤 제품인가요?\nA. 민감 피부를 위한 보습 토너입니다."
		        },
		        html: "<div class=\"geo-content-accordion\"></div>"
		      }
		    });

		    const graph = repaired.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
		    const howTo = graph.find((node) => node["@type"] === "HowTo") as Record<string, any>;
		    const steps = howTo.step as Array<Record<string, any>>;
		    const stepText = JSON.stringify(steps);

		    expect(steps.map((step) => step.position)).toEqual([1, 2]);
		    expect(steps.map((step) => step.name)).toEqual(["1단계", "2단계"]);
		    expect(steps.map((step) => step.text)).toEqual([
		      "아침, 저녁 세안 후, 적당량의 내용물을 덜어줍니다",
		      "캡슐을 부드럽게 녹이듯 골고루 펴 바른 후 가볍게 두드려 흡수시켜 줍니다"
		    ]);
		    expect(stepText).not.toMatch(/"text":"은\s|흡수시키는 방식이다|가볍게\./);
		    expect(repaired.validationRepairs.some((repair) => repair.source === "field-contract-validator" && repair.field === "HowTo.step.text" && /broader compound/.test(repair.issue))).toBe(true);
		    expect(repaired.validationRepairs.some((repair) => repair.source === "field-contract-validator" && repair.field === "HowTo.step.text" && /duplicated/.test(repair.issue))).toBe(true);
		  });
		  it("preserves Korean cleanser HowTo source steps without synthesizing substeps", () => {
			    const repaired = validateAndRepairPdpGeoArtifacts({
		      locale: "ko-KR",
		      fallbackProductName: "예시더마 모이베리어365 클렌징폼",
		      fallbackDescription: "예시더마 모이베리어365 클렌징폼은 민감 피부를 위한 폼 클렌저입니다.",
		      schemaMarkup: {
		        jsonLd: {
		          "@context": "https://schema.org",
		          "@graph": [
		            {
		              "@type": "Product",
		              name: "예시더마 모이베리어365 클렌징폼",
		              description: "예시더마 모이베리어365 클렌징폼은 민감 피부를 위한 폼 클렌저입니다."
		            },
		            {
		              "@type": "HowTo",
		              name: "예시더마 모이베리어365 클렌징폼 사용법",
		              step: [
		                {
		                  "@type": "HowToStep",
		                  position: 1,
		                  name: "1단계",
		                  text: "적당량을 덜어 물과 함께 거품을 낸 뒤 얼굴에 부드럽게 마사지하고, 미온수로 깨끗이 헹구는 방식이다"
		                },
		                {
		                  "@type": "HowToStep",
		                  position: 2,
		                  name: "2단계",
		                  text: "적당량을 덜어 물과 함께 거품을 낸 다음 얼굴에 부드럽게 마사지합니다 2 미온수로 깨끗이 헹구어 냅니다"
		                },
		                {
		                  "@type": "HowToStep",
		                  position: 3,
		                  name: "3단계",
		                  text: "적당량을 덜어 물과 함께 거품을 낸다"
		                },
		                {
		                  "@type": "HowToStep",
		                  position: 4,
		                  name: "4단계",
		                  text: "얼굴에 부드럽게 마사지한다"
		                }
		              ]
		            }
		          ]
		        },
		        scriptTag: ""
		      },
		      content: {
		        sections: {
		          productName: "예시더마 모이베리어365 클렌징폼",
		          description: "예시더마 모이베리어365 클렌징폼은 민감 피부를 위한 폼 클렌저입니다.",
		          quickFacts: "핵심 정보",
		          benefits: "장벽보호",
		          ingredients: "Barrier Protective Formula",
		          howToUse: "적당량을 덜어 물과 함께 거품을 낸 뒤 얼굴에 부드럽게 마사지하고, 미온수로 깨끗이 헹굽니다.",
		          faq: "Q. 어떤 제품인가요?\nA. 민감 피부를 위한 폼 클렌저입니다."
		        },
		        html: "<div class=\"geo-content-accordion\"></div>"
		      }
		    });

		    const graph = repaired.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
		    const howTo = graph.find((node) => node["@type"] === "HowTo") as Record<string, any>;
		    const steps = howTo.step as Array<Record<string, any>>;
		    const stepText = JSON.stringify(steps);

		    expect(steps.map((step) => step.position)).toEqual([1, 2, 3, 4]);
		    expect(steps.map((step) => step.name)).toEqual(["1단계", "2단계", "3단계", "4단계"]);
		    expect(steps.map((step) => step.text)).toEqual([
		      "적당량을 덜어 물과 함께 거품을 낸 뒤 얼굴에 부드럽게 마사지하고, 미온수로 깨끗이 헹굽니다",
		      "적당량을 덜어 물과 함께 거품을 낸 다음 얼굴에 부드럽게 마사지합니다 미온수로 깨끗이 헹구어 냅니다",
		      "적당량을 덜어 물과 함께 거품을 냅니다",
		      "얼굴에 부드럽게 마사지합니다"
		    ]);
		    expect(stepText).not.toMatch(/방식이다|마사지합니다 2|거품을 낸다|마사지한다/);
		    expect(repaired.validationRepairs.some((repair) => repair.source === "sentence-qa" && repair.field === "HowTo.step.text")).toBe(true);
		    expect(repaired.validationRepairs.some((repair) => repair.field === "HowTo.step.text" && /combined multiple|duplicated/.test(repair.issue))).toBe(false);
		  });
		  it("removes Korean customer review text from HowTo steps", () => {
		    const repaired = validateAndRepairPdpGeoArtifacts({
		      locale: "ko-KR",
		      fallbackProductName: "예시더마 모이베리어365 젠틀 포밍클렌저",
		      fallbackDescription: "예시더마 모이베리어365 젠틀 포밍클렌저는 민감 피부를 위한 폼 클렌저입니다.",
		      schemaMarkup: {
		        jsonLd: {
		          "@context": "https://schema.org",
		          "@graph": [
		            {
		              "@type": "Product",
		              name: "예시더마 모이베리어365 젠틀 포밍클렌저",
		              description: "예시더마 모이베리어365 젠틀 포밍클렌저는 민감 피부를 위한 폼 클렌저입니다."
		            },
		            {
		              "@type": "HowTo",
		              name: "예시더마 모이베리어365 젠틀 포밍클렌저 사용 방법",
		              step: [
		                {
		                  "@type": "HowToStep",
		                  position: 1,
		                  name: "1단계",
		                  text: "아직 본격적으로 사용해 보지는 않았는데 워낙 평이 좋아서 기대가 많이 되네요"
		                },
		                {
		                  "@type": "HowToStep",
		                  position: 2,
		                  name: "2단계",
		                  text: "초등학생 딸이 선크림을 바르기 시작하면서 필요해서 구매했어요"
		                },
		                {
		                  "@type": "HowToStep",
		                  position: 3,
		                  name: "3단계",
		                  text: "sulyeon04130 2026-06-24. 초등학생 딸이 선크림을 바르기 시작하면서 필요해서 구매했어요. 거품이 부드러우면서 쫀쫀한 느낌이네요"
		                },
		                {
		                  "@type": "HowToStep",
		                  position: 4,
		                  name: "4단계",
		                  text: "wlsk7622 2026-06-23. 배송 빠르고 포장도 꼼꼼하게 잘 도착했네요! 아주 저렴한 가격에 득템한 것 같아서 쓰기 전부터 기분이 정말 좋습니다. 아직 본격적으로 사용해 보지는 않았는데 워낙 평이 좋아서 기대가 많이 되네요"
		                },
		                {
		                  "@type": "HowToStep",
		                  position: 5,
		                  name: "5단계",
		                  text: "적당량을 덜어 물과 함께 거품을 낸 뒤 얼굴에 부드럽게 마사지하고 미온수로 깨끗이 헹굽니다."
		                }
		              ]
		            }
		          ]
		        },
		        scriptTag: ""
		      },
		      content: {
		        sections: {
		          productName: "예시더마 모이베리어365 젠틀 포밍클렌저",
		          description: "예시더마 모이베리어365 젠틀 포밍클렌저는 민감 피부를 위한 폼 클렌저입니다.",
		          quickFacts: "핵심 정보",
		          benefits: "장벽보호",
		          ingredients: "Barrier Protective Formula",
		          howToUse: "적당량을 덜어 물과 함께 거품을 낸 뒤 얼굴에 부드럽게 마사지하고 미온수로 깨끗이 헹굽니다.",
		          faq: "Q. 어떤 제품인가요?\nA. 민감 피부를 위한 폼 클렌저입니다."
		        },
		        html: "<div class=\"geo-content-accordion\"></div>"
		      }
		    });

    const graph = repaired.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const howTo = graph.find((node) => node["@type"] === "HowTo") as Record<string, any> | undefined;

    expect(howTo).toBeDefined();
    expect(howTo?.step).toHaveLength(1);
    expect(String((howTo?.step as Array<Record<string, any>>)[0]?.text)).toContain("적당량을 덜어 물과 함께 거품을 낸 뒤 얼굴에 부드럽게 마사지하고 미온수로 깨끗이 헹굽니다");
    expect(repaired.content.sections.howToUse).toContain("적당량을 덜어 물과 함께 거품을 낸 뒤 얼굴에 부드럽게 마사지하고 미온수로 깨끗이 헹굽니다.");
    expect(repaired.content.sections.howToUse).not.toMatch(/아직 본격적으로|초등학생 딸|sulyeon04130|wlsk7622|배송 빠르고|워낙 평이 좋아서|필요해서 구매/);
		    expect(repaired.validationRepairs.some((repair) => repair.source === "field-contract-validator" && repair.field === "HowTo.step.text")).toBe(true);
		  });
		  it("repairs repeated Korean HowTo variants and raw certification fragments", () => {
	    const repaired = validateAndRepairPdpGeoArtifacts({
	      locale: "ko-KR",
	      fallbackProductName: "예시더마 모이베리어365 캡슐 토너",
	      fallbackDescription: "예시더마 모이베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다.",
	      schemaMarkup: {
	        jsonLd: {
	          "@context": "https://schema.org",
	          "@graph": [
	            {
	              "@type": "Product",
	              name: "예시더마 모이베리어365 캡슐 토너",
	              description: "예시더마 모이베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다.",
	              additionalProperty: [
	                {
	                  "@type": "PropertyValue",
	                  name: "Functional certification",
	                  value: "민감 피부도 사용할 수 있는 순한 저자극 토너, 민감성 피부 사용 적합 테스트 완료 건조 민감 피부를 고려한 스킨케어 효와 피부 장벽 강화 피부 보습 피부 진정"
	                }
	              ]
	            },
	            {
	              "@type": "HowTo",
	              name: "예시더마 모이베리어365 캡슐 토너 사용 방법",
	              step: [
	                {
	                  "@type": "HowToStep",
	                  position: 1,
	                  name: "손에 덜어 펴 바르기",
	                  text: "손바닥에 적당량을 덜어 얼굴 전체에 가볍게 펴 바르는 것이다"
	                },
	                {
	                  "@type": "HowToStep",
	                  position: 2,
	                  name: "손에 덜어 펴 바르기",
	                  text: "손바닥에 적당량을 덜어 얼굴 전체에 가볍게 펴 발라줍니다"
	                },
	                {
	                  "@type": "HowToStep",
	                  position: 3,
	                  name: "손에 덜어 펴 바르기",
	                  text: "손바닥에 적당량을 덜어 얼굴 전체에 가볍게 펴 바른다"
	                },
	                {
	                  "@type": "HowToStep",
	                  position: 4,
	                  name: "수분 팩처럼 사용",
	                  text: "피부가 건조할 때는 화장솜에 충분히 적셔 피부에 올려두면 수분 팩처럼 사용할 수 있습니다"
	                }
	              ]
	            }
	          ]
	        },
	        scriptTag: ""
	      },
	      content: {
	        sections: {
	          productName: "예시더마 모이베리어365 캡슐 토너",
	          description: "예시더마 모이베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다.",
	          quickFacts: "핵심 정보",
	          benefits: "보습",
	          ingredients: "고밀도 세라마이드 캡슐",
	          howToUse: "손바닥에 적당량을 덜어 얼굴 전체에 가볍게 펴 바릅니다",
	          faq: "Q. 어떤 제품인가요?\nA. 민감 피부를 위한 보습 토너입니다."
	        },
	        html: "<div class=\"geo-content-accordion\"></div>"
	      }
	    });

	    const graph = repaired.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
	    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
	    const howTo = graph.find((node) => node["@type"] === "HowTo") as Record<string, any>;
	    const certification = product.additionalProperty.find((item: Record<string, any>) => item.name === "Functional certification");
	    const steps = howTo.step as Array<Record<string, any>>;

	    expect(steps).toHaveLength(2);
	    expect(JSON.stringify(steps)).toContain("손바닥에 적당량을 덜어 얼굴 전체에 가볍게 펴 바릅니다");
	    expect(JSON.stringify(steps)).not.toMatch(/펴 발라줍니다|펴 바른다|펴 바르는 것이다/);
	    expect(certification.value).toBe("민감성 피부 사용 적합 테스트 완료");
	  });
	  it("removes concrete usage directions from Product description while keeping metric evidence", () => {
    const repaired = validateAndRepairPdpGeoArtifacts({
      locale: "ko-KR",
      fallbackProductName: "예시더마 모이베리어365 캡슐 토너",
      fallbackDescription: "예시더마 모이베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다.",
      schemaMarkup: {
        jsonLd: {
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "Product",
              name: "예시더마 모이베리어365 캡슐 토너",
              description: "예시더마 모이베리어365 캡슐 토너는 PHA 워터에 띄워진 고밀도 세라마이드 캡슐을 담은 장벽 보습 캡슐 토너입니다. 외부자극인 Tape Stripping에 의한 장벽 손상은 사용 직후 60.5%, 사용 7일 후 87.3% 회복된 결과가 제시되며, 사용 시 화장솜에 적당량을 덜어 피부결을 따라 부드럽게 닦아냅니다."
            },
            {
              "@type": "HowTo",
              step: [
                {
                  "@type": "HowToStep",
                  text: "화장솜에 적당량을 덜어 피부결을 따라 부드럽게 닦아냅니다"
                }
              ]
            }
          ]
        },
        scriptTag: ""
      },
      content: {
        sections: {
          productName: "예시더마 모이베리어365 캡슐 토너",
          description: "예시더마 모이베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다.",
          quickFacts: "핵심 정보",
          benefits: "보습",
          ingredients: "고밀도 세라마이드 캡슐",
          howToUse: "화장솜에 적당량을 덜어 피부결을 따라 부드럽게 닦아냅니다",
          faq: "Q. 어떤 제품인가요?\nA. 민감 피부를 위한 보습 토너입니다."
        },
        html: "<div class=\"geo-content-accordion\"></div>"
      }
    });

    const graph = repaired.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const howTo = graph.find((node) => node["@type"] === "HowTo") as Record<string, any>;
    const description = String(product.description);

    expect(description).toContain("사용 직후 60.5%");
    expect(description).toContain("사용 7일 후 87.3% 회복되었습니다");
    expect(description).not.toMatch(/사용 직후는|사용 7일 후는|제시됩니다|나타났습니다/);
    expect(description).not.toMatch(/사용 시|화장솜에 적당량|피부결을 따라|닦아냅니다/);
    expect(JSON.stringify(howTo?.step ?? repaired.content.sections.howToUse)).toContain("화장솜에 적당량");
    expect(repaired.validationRepairs.some((repair) => repair.source === "field-contract-validator" && repair.field === "Product.description")).toBe(true);
  });
});

describe("generatePdpGeo HowTo step boundaries", () => {
  it("never reads a number inside the product name as the next step marker", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "예시더마 모이베리어365 클렌징폼",
          description: "건조하고 민감한 피부를 위한 약산성 클렌징 폼입니다.",
          brand: "EXAMPLEDERMA",
          category: "클렌징폼",
          benefits: ["피부 장벽"],
          ingredients: ["판테놀"],
          usage: [],
          // 패키지 라벨의 "BARRIERCARE 365"가 단계 사이에 전사된 실제 OCR 블록 형태.
          sourceTexts: [
            "사용법 1 클렌징 단계에서 젖은 손에 적당량을 덜어 충분히 거품을 내주세요. EXAMPLEDERMA BARRIERCARE 365 CLEANSING FOAM 2 얼굴에 부드럽게 롤링하여 노폐물을 녹여낸 후 미온수로 깨끗이 씻어줍니다."
          ]
        }
      },
      source: {
        type: "pdp-extractor",
        url: "https://shop.example.com/web/product/view.do?prdSeq=1145"
      },
      hints: { locale: "ko-KR", market: "KR" }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const howTo = graph.find((node) => node["@type"] === "HowTo") as Record<string, any> | undefined;
    const stepTexts = ((howTo?.step ?? []) as Array<Record<string, any>>).map((step) => String(step.text));

    expect(stepTexts.length).toBeGreaterThanOrEqual(1);
    expect(stepTexts.some((text) => /EXAMPLEDERMA|BARRIERCARE|CLEANSING FOAM/.test(text))).toBe(false);
  });
});

describe("generatePdpGeo HowTo with duplicated step wordings", () => {
  it("keeps the numbered procedure when one step arrives in two wordings", async () => {
    // 1027 실측(2026-09-03)의 정규화된 usage 그대로다. 분류 모델이 다시 쓴 문장과
    // 원문 어투가 각각 번호를 달고 들어와 서수가 1,1,2,2가 된다. 연속성 검사가
    // 실패해 절차가 한 단계로 뭉치고, 그 한 단계에 세 문장이 이어붙었다.
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "모이베리어 365 크림 미스트",
          description: "건조하고 민감한 피부를 위한 크림 미스트입니다.",
          brand: "EXAMPLEDERMA",
          category: "미스트",
          benefits: ["보습"],
          ingredients: ["세라마이드"],
          usage: [
            "1. 연약하고 건조해진 피부 부위에 미세 분사합니다.",
            "2. 피부에 건조함이 느껴질 때 수시로 뿌려줍니다.",
            "1 연약하고 건조해진 피부 부위에 미세 분사를 합니다.",
            "2 피부에 건조함이 느껴질 때 수시로 뿌려줍니다."
          ]
        }
      },
      source: { type: "pdp-extractor", url: "https://shop.example.com/web/product/view.do?prdSeq=1027" },
      hints: { locale: "ko-KR", market: "KR" }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const howTo = graph.find((node) => node["@type"] === "HowTo") as Record<string, any> | undefined;
    const stepTexts = ((howTo?.step ?? []) as Array<Record<string, any>>).map((step) => String(step.text));

    expect(stepTexts).toHaveLength(2);
    expect(stepTexts[0]).toMatch(/^연약하고 건조해진 피부 부위에 미세 분사/);
    expect(stepTexts[1]).toMatch(/^피부에 건조함이 느껴질 때 수시로 뿌려/);
  });

  it("does not invent an order when two different actions share one number", async () => {
    // 같은 번호에 서로 다른 동작이 실려 있으면 원문의 순서를 알 수 없다.
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "모이베리어 365 크림 미스트",
          description: "건조하고 민감한 피부를 위한 크림 미스트입니다.",
          brand: "EXAMPLEDERMA",
          category: "미스트",
          benefits: ["보습"],
          ingredients: ["세라마이드"],
          usage: [
            "1. 연약하고 건조해진 피부 부위에 미세 분사합니다.",
            "1. 화장솜에 충분히 적셔 피부결을 따라 닦아줍니다.",
            "2. 피부에 건조함이 느껴질 때 수시로 뿌려줍니다."
          ]
        }
      },
      source: { type: "pdp-extractor", url: "https://shop.example.com/web/product/view.do?prdSeq=1027" },
      hints: { locale: "ko-KR", market: "KR" }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const howTo = graph.find((node) => node["@type"] === "HowTo") as Record<string, any> | undefined;
    const stepTexts = ((howTo?.step ?? []) as Array<Record<string, any>>).map((step) => String(step.text));

    expect(stepTexts).toHaveLength(1);
  });
});
